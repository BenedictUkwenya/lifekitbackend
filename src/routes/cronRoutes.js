// src/routes/cronRoutes.js
// Vercel Cron Jobs — runs daily via vercel.json schedule.
// Endpoints are protected by a secret header so they cannot be triggered
// by arbitrary HTTP requests in production.
//
// Required env var: CRON_SECRET  (set in Vercel project settings)
//
// Jobs:
//   GET /cron/check-trials           — trial expiry warnings + post-trial notification
//   GET /cron/check-inactivity       — nudge inactive providers to post / accept work
//   GET /cron/check-user-inactivity  — "we miss you" email for all inactive users

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { t, getUserLang } = require('../utils/translate');
const { notifyUser } = require('../services/notificationService');

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

function formatDate(date, lang) {
  const localeMap = { en: 'en-US', ka: 'ka-GE', ru: 'ru-RU' };
  const locale = localeMap[lang] || 'en-US';
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}

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
          await notifyUser({
            userId: profile.id,
            title: t('notifications.trialWarning.title', lang, {
              days: warningDays,
              plural: warningDays > 1 ? 's' : '',
            }),
            message: t('notifications.trialWarning.message', lang, {
              date: formatDate(trialEnd, lang),
            }),
            type: warningType,
          });
          results.warnings++;
        } else {
          results.skipped++;
        }
        continue;
      }

      if (daysLeft <= 0 && daysLeft > -1) {
        const { count } = await supabaseAdmin
          .from('notifications')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', profile.id)
          .eq('type', 'trial_expired')
          .gte('created_at', new Date(now.toDateString()).toISOString());

        if (count === 0) {
          await notifyUser({
            userId: profile.id,
            title: t('notifications.trialExpired.title', lang),
            message: t('notifications.trialExpired.message', lang),
            type: 'trial_expired',
          });
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
            await notifyUser({
              userId: provider.id,
              title: t('notifications.nudgeNoServices.title', lang),
              message: t('notifications.nudgeNoServices.message', lang),
              type: 'ai_nudge_no_services',
            });
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
            await notifyUser({
              userId: provider.id,
              title: t('notifications.nudgeInactive.title', lang),
              message: t('notifications.nudgeInactive.message', lang),
              type: 'ai_nudge_inactive',
            });
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

router.get('/check-user-inactivity', async (req, res) => {
  if (!verifyCronSecret(req, res)) return;

  try {
    const now = new Date();
    const fourteenDaysAgo = new Date(now - 14 * 24 * 60 * 60 * 1000);
    const fourteenDaysAgoIso = fourteenDaysAgo.toISOString();
    const results = { nudged: 0, skipped: 0 };

    const { data: profiles, error } = await supabaseAdmin
      .from('profiles')
      .select('id, language, last_active_at, email')
      .not('email', 'is', null);

    if (error) throw error;

    const authLastSignIn = {};
    let page = 1;
    while (true) {
      const { data: authData, error: authError } = await supabaseAdmin.auth.admin.listUsers({
        page,
        perPage: 1000,
      });
      if (authError) throw authError;
      authData.users.forEach((u) => {
        authLastSignIn[u.id] = u.last_sign_in_at;
      });
      if (authData.users.length < 1000) break;
      page += 1;
    }

    for (const profile of profiles || []) {
      const lastActive = profile.last_active_at || authLastSignIn[profile.id];
      if (!lastActive) continue;

      const lastActiveDate = new Date(lastActive);
      if (lastActiveDate > fourteenDaysAgo) continue;

      const { count: alreadyNotified } = await supabaseAdmin
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', profile.id)
        .eq('type', 'we_miss_you')
        .gte('created_at', fourteenDaysAgoIso);

      if (alreadyNotified > 0) {
        results.skipped++;
        continue;
      }

      const lang = getUserLang(profile);
      await notifyUser({
        userId: profile.id,
        title: t('notifications.weMissYou.title', lang),
        message: t('notifications.weMissYou.message', lang),
        type: 'we_miss_you',
      });
      results.nudged++;
    }

    console.log('[CRON] check-user-inactivity completed:', results);
    return res.json({ ok: true, ...results });
  } catch (err) {
    console.error('[CRON] check-user-inactivity error:', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
