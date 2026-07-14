/**
 * notificationService.js — Central in-app notification + email delivery.
 */

const { supabaseAdmin } = require('../config/supabase');
const { getUserLang } = require('../utils/translate');
const emailService = require('./emailService');

const APP_WEB_URL = process.env.APP_WEB_URL || 'https://www.lifekithub.com';

const EMAIL_ENABLED_TYPES = new Set([
  'swap_proposal',
  'swap_accepted',
  'swap_declined',
  'booking_request',
  'booking_update',
  'booking_completed',
  'booking_dispute',
  'booking_overdue_nudge',
  'we_miss_you',
  'trial_warning_7d',
  'trial_warning_3d',
  'trial_warning_1d',
  'trial_expired',
  'ai_nudge_no_services',
  'ai_nudge_inactive',
]);

function matchesEmailType(type) {
  if (EMAIL_ENABLED_TYPES.has(type)) return true;
  if (type && type.startsWith('trial_warning_')) return true;
  return false;
}

function defaultActionUrl(type, referenceId) {
  if (!referenceId) return APP_WEB_URL;
  switch (type) {
    case 'swap_proposal':
    case 'swap_accepted':
    case 'swap_declined':
      return `${APP_WEB_URL}/dashboard/swaps`;
    case 'booking_request':
    case 'booking_update':
    case 'booking_completed':
    case 'booking_dispute':
    case 'booking_overdue_nudge':
      return `${APP_WEB_URL}/dashboard/bookings`;
    default:
      return APP_WEB_URL;
  }
}

async function loadProfile(userId) {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('email, full_name, language, email_notifications_enabled')
    .eq('id', userId)
    .single();

  if (error || !data) return null;
  return data;
}

/**
 * Insert in-app notification and optionally send email via Resend.
 */
async function notifyUser({
  userId,
  title,
  message,
  type,
  referenceId = null,
  actionUrl = null,
  skipEmail = false,
}) {
  const payload = {
    user_id: userId,
    title,
    message,
    type,
    is_read: false,
  };
  if (referenceId) payload.reference_id = referenceId;

  try {
    const { error } = await supabaseAdmin.from('notifications').insert(payload);
    if (error) {
      console.error(`[notificationService] DB insert error for ${userId}:`, error.message);
    }
  } catch (err) {
    console.error(`[notificationService] DB insert failed for ${userId}:`, err.message);
  }

  if (skipEmail || !matchesEmailType(type)) return;

  try {
    const profile = await loadProfile(userId);
    if (!profile?.email) return;
    if (profile.email_notifications_enabled === false) return;

    const lang = getUserLang(profile);
    const url = actionUrl || defaultActionUrl(type, referenceId);

    emailService.sendNotificationEmail({
      email: profile.email,
      fullName: profile.full_name,
      title,
      message,
      lang,
      actionUrl: url,
      type,
    }).catch((err) => {
      console.error(`[notificationService] Email failed for ${userId}:`, err.message);
    });
  } catch (err) {
    console.error(`[notificationService] Email lookup failed for ${userId}:`, err.message);
  }
}

/**
 * Notify multiple users (e.g. booking completed for both parties).
 */
async function notifyUsers(notifications) {
  await Promise.all(notifications.map((n) => notifyUser(n)));
}

module.exports = {
  notifyUser,
  notifyUsers,
  matchesEmailType,
};
