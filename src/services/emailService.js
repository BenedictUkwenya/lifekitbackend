/**
 * emailService.js — Resend email delivery with LifeKit-branded HTML templates.
 */

const { Resend } = require('resend');
const { t } = require('../utils/translate');

const PRIMARY = '#89273B';
const APP_WEB_URL = process.env.APP_WEB_URL || 'https://www.lifekithub.com';

let resendClient = null;

function getResendClient() {
  if (!process.env.RESEND_API_KEY) return null;
  if (!resendClient) {
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}

function getFromAddress() {
  return process.env.RESEND_FROM_EMAIL || 'LifeKit <noreply@lifekithub.com>';
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderLayout({ lang, preheader, title, bodyHtml, ctaLabel, ctaUrl }) {
  const footer = t('emails.common.footer', lang);
  const ctaBlock =
    ctaLabel && ctaUrl
      ? `<tr>
          <td style="padding:24px 32px 8px;text-align:center;">
            <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:${PRIMARY};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 28px;border-radius:999px;">${escapeHtml(ctaLabel)}</a>
          </td>
        </tr>`
      : '';

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <span style="display:none;max-height:0;overflow:hidden;">${escapeHtml(preheader || title)}</span>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f5f5;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.06);">
          <tr>
            <td style="background:linear-gradient(135deg,${PRIMARY},#6b1e2d);padding:28px 32px;text-align:center;">
              <div style="color:#ffffff;font-size:24px;font-weight:700;letter-spacing:-0.5px;">LifeKit</div>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 32px 8px;">
              <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#111111;">${escapeHtml(title)}</h1>
              <div style="font-size:15px;line-height:1.6;color:#444444;">${bodyHtml}</div>
            </td>
          </tr>
          ${ctaBlock}
          <tr>
            <td style="padding:24px 32px 32px;font-size:12px;line-height:1.5;color:#888888;text-align:center;">
              ${escapeHtml(footer)}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

async function sendEmail({ to, subject, html, text }) {
  const client = getResendClient();
  if (!client) {
    console.warn('[emailService] RESEND_API_KEY not set — skipping email to', to);
    return { skipped: true };
  }

  try {
    const payload = {
      from: getFromAddress(),
      to: [to],
      subject,
      html,
    };
    if (text) payload.text = text;
    if (process.env.RESEND_REPLY_TO) {
      payload.reply_to = process.env.RESEND_REPLY_TO;
    }

    const { data, error } = await client.emails.send(payload);
    if (error) {
      console.error('[emailService] Resend error:', error);
      return { error };
    }
    return { data };
  } catch (err) {
    console.error('[emailService] Send failed:', err.message);
    return { error: err };
  }
}

function sendEmailAsync(params) {
  sendEmail(params).catch((err) => {
    console.error('[emailService] Async send error:', err.message);
  });
}

async function sendSignupOtpEmail({ email, fullName, otp, lang = 'en' }) {
  const subject = t('emails.signupOtp.subject', lang);
  const title = t('emails.signupOtp.title', lang, { name: fullName || 'there' });
  const intro = t('emails.signupOtp.intro', lang);
  const expiry = t('emails.signupOtp.expiry', lang);

  const bodyHtml = `
    <p style="margin:0 0 16px;">${escapeHtml(intro)}</p>
    <div style="margin:24px 0;padding:20px;background:#f9f4f5;border-radius:12px;text-align:center;">
      <div style="font-size:32px;font-weight:700;letter-spacing:8px;color:${PRIMARY};">${escapeHtml(otp)}</div>
    </div>
    <p style="margin:0;color:#666666;font-size:13px;">${escapeHtml(expiry)}</p>`;

  const html = renderLayout({ lang, preheader: subject, title, bodyHtml });
  const text = `${title}\n\n${intro}\n\n${otp}\n\n${expiry}`;

  return sendEmail({ to: email, subject, html, text });
}

async function sendPasswordResetEmail({ email, resetLink, lang = 'en' }) {
  const subject = t('emails.passwordReset.subject', lang);
  const title = t('emails.passwordReset.title', lang);
  const intro = t('emails.passwordReset.intro', lang);
  const ignore = t('emails.passwordReset.ignore', lang);
  const ctaLabel = t('emails.passwordReset.cta', lang);

  const bodyHtml = `
    <p style="margin:0 0 16px;">${escapeHtml(intro)}</p>
    <p style="margin:0;color:#666666;font-size:13px;">${escapeHtml(ignore)}</p>`;

  const html = renderLayout({
    lang,
    preheader: subject,
    title,
    bodyHtml,
    ctaLabel,
    ctaUrl: resetLink,
  });
  const text = `${title}\n\n${intro}\n\n${resetLink}\n\n${ignore}`;

  return sendEmail({ to: email, subject, html, text });
}

async function sendNotificationEmail({
  email,
  fullName,
  title,
  message,
  lang = 'en',
  actionUrl,
}) {
  const subject = title;
  const greeting = t('emails.notification.greeting', lang, {
    name: fullName || t('emails.notification.defaultName', lang),
  });
  const ctaLabel = t('emails.notification.cta', lang);

  const bodyHtml = `
    <p style="margin:0 0 16px;">${escapeHtml(greeting)}</p>
    <p style="margin:0 0 8px;font-weight:600;color:#222222;">${escapeHtml(title)}</p>
    <p style="margin:0;">${escapeHtml(message)}</p>`;

  const html = renderLayout({
    lang,
    preheader: message,
    title,
    bodyHtml,
    ctaLabel: actionUrl ? ctaLabel : null,
    ctaUrl: actionUrl || null,
  });
  const text = `${greeting}\n\n${title}\n${message}${actionUrl ? `\n\n${ctaLabel}: ${actionUrl}` : ''}`;

  return sendEmail({ to: email, subject, html, text });
}

module.exports = {
  sendEmail,
  sendEmailAsync,
  sendSignupOtpEmail,
  sendPasswordResetEmail,
  sendNotificationEmail,
};
