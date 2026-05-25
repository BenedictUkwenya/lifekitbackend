// src/routes/cronRoutes.js
// Vercel Cron Jobs — runs daily via vercel.json schedule.
// Endpoints are protected by a secret header so they cannot be triggered
// by arbitrary HTTP requests in production.
//
// Required env var: CRON_SECRET  (set in Vercel project settings)
//
// Jobs:
//   GET /cron/check-trials     — trial expiry warnings + post-trial notification
//   GET /cron/check-inactivity — nudge inactive providers to post / accept work

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { t, getUserLang } = require('../utils/translate');

// ── Helper: verify Vercel cron secret ───────────────────────────────────────
function verifyCronSecret(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      res.status(403).json({ error: t('errors.cronSecretMissing') });
      return false;
    }
    return true;
  }
  const provided = req.headers['authorization'];
  if (provided !== `Bearer ${secret}`) {
    res.status(401).json({ error: t('errors.unauthorized') });
    return false;
  }
  return true;
}

// ── Helper: insert in-app notification ───────────────────────────────────────
async function insertNotification(userId, title, message, type, referenceId = null) {
  const payload = { user_id: userId, title, message, type };
  if (referenceId) payload.reference_id = referenceId;
  const { error } = await supabaseAdmin.from('notifications').insert(payload);
  if (error) console.error(`[CRON] notification insert error for ${userId}:`, error);
}

// ── Helper: format date in a locale-aware way ────────────────────────────────
function formatDate(date, lang) {
  const localeMap = { en: 'en-US', ka: 'ka-GE', ru: 'ru-RU' };
  const locale = localeMap[lang] || 'en-US';
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── GET /cron/check-trials ────────────────────────────────────────────────────
router.get('/check-trials', async (req, res) => {
  if (!verifyCronSecret(req, res)) return;

  try {
    const now = new Date();

    const { data: profiles, error } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, trial_end_date, language')
      .not('trial_end_date', 'is', null);

    if (error) throw error;

    const results = { warnings: 0, expired: 0, skipped: 0 };

    for (const profile of profiles) {
      const lang = getUserLang(profile);
      const trialEnd = new Date(profile.trial_end_date);
      const msLeft = trialEnd - now;
      const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));

      // ── Warning notifications ─────────────────────────────────────────────
      let warningType = null;
      let warningDays = null;

      if (daysLeft === 7)      { warningType = 'trial_warning_7d'; warningDays = 7; }
      else if (daysLeft === 3) { warningType = 'trial_warning_3d'; warningDays = 3; }
      else if (daysLeft === 1) { warningType = 'trial_warning_1d'; warningDays = 1; }

      if (warningType) {
        const { count } = await supabaseAdmin
          .from('notifications')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', profile.id)
          .eq('type', warningType)
          .gte('created_at', new Date(now.toDateString()).toISOString());

        if (count === 0) {
          await insertNotification(
            profile.id,
            t('notifications.trialWarning.title', lang, {
              days: warningDays,
              plural: warningDays > 1 ? 's' : '',
            }),
            t('notifications.trialWarning.message', lang, {
              date: formatDate(trialEnd, lang),
            }),
            warningType,
          );
          results.warnings++;
        } else {
          results.skipped++;
        }
        continue;
      }

      // ── Post-trial expiry notification ────────────────────────────────────
      if (daysLeft <= 0 && daysLeft > -1) {
        const { count } = await supabaseAdmin
          .from('notifications')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', profile.id)
          .eq('type', 'trial_expired')
          .gte('created_at', new Date(now.toDateString()).toISOString());

        if (count === 0) {
          await insertNotification(
            profile.id,
            t('notifications.trialExpired.title', lang),
            t('notifications.trialExpired.message', lang),
            'trial_expired',
          );
          results.expired++;
        } else {
          results.skipped++;
        }
      }
    }

    console.log('[CRON] check-trials completed:', results);
    return res.json({ ok: true, ...results });
  } catch (err) {
    console.error('[CRON] check-trials error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /cron/check-inactivity ────────────────────────────────────────────────
router.get('/check-inactivity', async (req, res) => {
  if (!verifyCronSecret(req, res)) return;

  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const results = { nudged: 0, skipped: 0 };

    const { data: activeProviders } = await supabaseAdmin
      .from('profiles')
      .select('id, language')
      .eq('is_service_provider', true);

    if (activeProviders) {
      for (const provider of activeProviders) {
        const lang = getUserLang(provider);

        const { count: recentBookings } = await supabaseAdmin
          .from('bookings')
          .select('id', { count: 'exact', head: true })
          .eq('provider_id', provider.id)
          .gte('created_at', sevenDaysAgo);

        const { count: serviceCount } = await supabaseAdmin
          .from('services')
          .select('id', { count: 'exact', head: true })
          .eq('provider_id', provider.id);

        if (serviceCount === 0) {
          const { count: alreadyNotified } = await supabaseAdmin
            .from('notifications')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', provider.id)
            .eq('type', 'ai_nudge_no_services')
            .gte('created_at', sevenDaysAgo);

          if (alreadyNotified === 0) {
            await insertNotification(
              provider.id,
              t('notifications.nudgeNoServices.title', lang),
              t('notifications.nudgeNoServices.message', lang),
              'ai_nudge_no_services',
            );
            results.nudged++;
          } else {
            results.skipped++;
          }
        } else if (recentBookings === 0) {
          const { count: alreadyNotified } = await supabaseAdmin
            .from('notifications')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', provider.id)
            .eq('type', 'ai_nudge_inactive')
            .gte('created_at', sevenDaysAgo);

          if (alreadyNotified === 0) {
            await insertNotification(
              provider.id,
              t('notifications.nudgeInactive.title', lang),
              t('notifications.nudgeInactive.message', lang),
              'ai_nudge_inactive',
            );
            results.nudged++;
          } else {
            results.skipped++;
          }
        }
      }
    }

    console.log('[CRON] check-inactivity completed:', results);
    return res.json({ ok: true, ...results });
  } catch (err) {
    console.error('[CRON] check-inactivity error:', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
