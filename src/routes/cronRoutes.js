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

// ── Helper: verify Vercel cron secret ───────────────────────────────────────
function verifyCronSecret(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // If no secret is configured, only allow in development
    if (process.env.NODE_ENV === 'production') {
      res.status(403).json({ error: 'CRON_SECRET is not configured.' });
      return false;
    }
    return true;
  }
  const provided = req.headers['authorization'];
  if (provided !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'Unauthorized.' });
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

// ── GET /cron/check-trials ────────────────────────────────────────────────────
// Sends warnings 7, 3, and 1 day(s) before trial_end_date, and a post-expiry
// notification on the day after it expires.
// Safe to run multiple times per day — uses a `notified_*` flag approach via
// the notification type string to avoid duplicates (Supabase dedup logic below).
router.get('/check-trials', async (req, res) => {
  if (!verifyCronSecret(req, res)) return;

  try {
    const now = new Date();

    // Fetch all profiles that have a trial_end_date set
    const { data: profiles, error } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, trial_end_date')
      .not('trial_end_date', 'is', null);

    if (error) throw error;

    const results = { warnings: 0, expired: 0, skipped: 0 };

    for (const profile of profiles) {
      const trialEnd = new Date(profile.trial_end_date);
      const msLeft = trialEnd - now;
      const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));

      // ── Warning notifications ─────────────────────────────────────────────
      let warningType = null;
      let warningDays = null;

      if (daysLeft === 7) { warningType = 'trial_warning_7d'; warningDays = 7; }
      else if (daysLeft === 3) { warningType = 'trial_warning_3d'; warningDays = 3; }
      else if (daysLeft === 1) { warningType = 'trial_warning_1d'; warningDays = 1; }

      if (warningType) {
        // Dedup: skip if this exact notification was already sent today
        const { count } = await supabaseAdmin
          .from('notifications')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', profile.id)
          .eq('type', warningType)
          .gte('created_at', new Date(now.toDateString()).toISOString());

        if (count === 0) {
          await insertNotification(
            profile.id,
            `⏳ Your Pro trial ends in ${warningDays} day${warningDays > 1 ? 's' : ''}`,
            `Your free Pro trial expires on ${trialEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}. ` +
            `Upgrade to a paid plan to keep your 5 service slots, Pro AI, and reduced commission.`,
            warningType,
          );
          results.warnings++;
        } else {
          results.skipped++;
        }
        continue;
      }

      // ── Post-trial expiry notification ────────────────────────────────────
      // daysLeft <= 0 means the trial has just expired (within the last 24 h)
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
            '🔔 Your free Pro trial has ended',
            'Your 90-day launch trial is over. You have been moved to the Free plan (1 service, 8% commission). ' +
            'Upgrade to Pro or Business to restore all features.',
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
// Finds providers who:
//   a) have at least 1 service but no bookings in the last 7 days, OR
//   b) have 0 services (never posted)
// and sends a single AI-nudge notification (deduplicated per 7-day window).
router.get('/check-inactivity', async (req, res) => {
  if (!verifyCronSecret(req, res)) return;

  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const results = { nudged: 0, skipped: 0 };

    // ── Case A: providers with services but no recent bookings ───────────────
    const { data: activeProviders } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('is_service_provider', true);

    if (activeProviders) {
      for (const provider of activeProviders) {
        // Check if they have any bookings in the last 7 days
        const { count: recentBookings } = await supabaseAdmin
          .from('bookings')
          .select('id', { count: 'exact', head: true })
          .eq('provider_id', provider.id)
          .gte('created_at', sevenDaysAgo);

        // Check if they have any services at all
        const { count: serviceCount } = await supabaseAdmin
          .from('services')
          .select('id', { count: 'exact', head: true })
          .eq('provider_id', provider.id);

        if (serviceCount === 0) {
          // No services — nudge to create first one
          const { count: alreadyNotified } = await supabaseAdmin
            .from('notifications')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', provider.id)
            .eq('type', 'ai_nudge_no_services')
            .gte('created_at', sevenDaysAgo);

          if (alreadyNotified === 0) {
            await insertNotification(
              provider.id,
              '✨ Ready to start earning?',
              'You haven\'t posted a service yet. Open the app and let AI suggest the best services for your skills and location — it only takes 2 minutes!',
              'ai_nudge_no_services',
            );
            results.nudged++;
          } else {
            results.skipped++;
          }
        } else if (recentBookings === 0) {
          // Has services but no recent bookings — nudge to stay active
          const { count: alreadyNotified } = await supabaseAdmin
            .from('notifications')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', provider.id)
            .eq('type', 'ai_nudge_inactive')
            .gte('created_at', sevenDaysAgo);

          if (alreadyNotified === 0) {
            await insertNotification(
              provider.id,
              '📈 Boost your visibility',
              'You haven\'t received a booking in 7 days. Our AI has found new opportunities in your area — check them out in the AI Radar on your dashboard!',
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
