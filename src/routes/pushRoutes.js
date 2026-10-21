// src/routes/pushRoutes.js
// Push notifications via Firebase Cloud Messaging.
//
// Flow: any INSERT into public.notifications fires a Postgres trigger
// (migrations/20261021_push_notifications.sql) that POSTs the new row to
// /push/dispatch. That covers every code path that creates a notification.
//
// Env:
//   FIREBASE_SERVICE_ACCOUNT_B64 — base64 of the Firebase service-account JSON
//   PUSH_WEBHOOK_SECRET          — shared secret the DB trigger sends
// Without them, every endpoint degrades to a harmless no-op.
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const authenticateToken = require('../middleware/authMiddleware');

let messaging; // undefined = not initialised yet, null = disabled
function getMessaging() {
  if (messaging !== undefined) return messaging;
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) return (messaging = null);
  try {
    const admin = require('firebase-admin');
    const credentials = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    const app = admin.apps.length
      ? admin.app()
      : admin.initializeApp({ credential: admin.credential.cert(credentials) });
    messaging = admin.messaging(app);
  } catch (err) {
    console.error('Push disabled — Firebase init failed:', err.message);
    messaging = null;
  }
  return messaging;
}

// POST /push/register — save this device's FCM token for the signed-in user
router.post('/register', authenticateToken, async (req, res) => {
  const { token, platform } = req.body || {};
  if (!token || typeof token !== 'string' || token.length > 4096) {
    return res.status(400).json({ error: 'token is required' });
  }
  try {
    const { error } = await supabaseAdmin.from('device_tokens').upsert(
      {
        token,
        user_id: req.user.id,
        platform: ['ios', 'android'].includes(platform) ? platform : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'token' },
    );
    if (error) throw error;
    res.json({ message: 'Device registered' });
  } catch (error) {
    console.error('Push register error:', error.message);
    res.status(500).json({ error: 'Failed to register device.' });
  }
});

// POST /push/unregister — forget this one device (on logout); other devices keep push
router.post('/unregister', authenticateToken, async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token is required' });
  try {
    const { error } = await supabaseAdmin
      .from('device_tokens')
      .delete()
      .eq('user_id', req.user.id)
      .eq('token', token);
    if (error) throw error;
    res.json({ message: 'Device removed' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove device.' });
  }
});

// POST /push/dispatch — called by the DB trigger with { record: <notification row> }
router.post('/dispatch', async (req, res) => {
  const secret = process.env.PUSH_WEBHOOK_SECRET;
  if (!secret || req.headers['x-push-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const record = req.body?.record;
  if (!record?.user_id) return res.status(400).json({ error: 'record.user_id required' });

  const fcm = getMessaging();
  if (!fcm) return res.json({ sent: 0, reason: 'push not configured' });

  try {
    const { data: rows, error } = await supabaseAdmin
      .from('device_tokens')
      .select('token')
      .eq('user_id', record.user_id);
    if (error) throw error;
    const tokens = (rows || []).map((r) => r.token);
    if (!tokens.length) return res.json({ sent: 0 });

    const result = await fcm.sendEachForMulticast({
      tokens,
      notification: {
        title: String(record.title || 'LifeKit').slice(0, 120),
        body: String(record.message || '').slice(0, 400),
      },
      data: {
        type: String(record.type || ''),
        reference_id: String(record.reference_id || ''),
        notification_id: String(record.id || ''),
      },
      android: {
        priority: 'high',
        notification: { channelId: 'lifekit_default', sound: 'default' },
      },
      apns: { payload: { aps: { sound: 'default' } } },
    });

    // Drop tokens FCM says are dead (app uninstalled, token rotated, …)
    const dead = [];
    result.responses.forEach((r, i) => {
      const code = r.error?.code || '';
      if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token')) {
        dead.push(tokens[i]);
      }
    });
    if (dead.length) await supabaseAdmin.from('device_tokens').delete().in('token', dead);

    res.json({ sent: result.successCount, failed: result.failureCount, pruned: dead.length });
  } catch (error) {
    console.error('Push dispatch error:', error.message);
    res.status(500).json({ error: 'Failed to send push.' });
  }
});

module.exports = router;
