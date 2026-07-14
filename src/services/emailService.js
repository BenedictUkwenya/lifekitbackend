/**
 * emailService.js — Resend email delivery with LifeKit-branded HTML templates.
 */

const { Resend } = require('resend');
const { t } = require('../utils/translate');

const PRIMARY = '#89273B';
const PRIMARY_DARK = '#6b1e2d';
const PRIMARY_DARKER = '#4a1520';
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

const VARIANT_CONFIG = {
  welcome: {
    accentColor: PRIMARY,
    headerBg: `background:linear-gradient(135deg,${PRIMARY} 0%,${PRIMARY_DARK} 60%,${PRIMARY_DARKER} 100%);`,
    bodyTopHtml: `<tr>
      <td style="background:linear-gradient(180deg,#fdf6f7 0%,#ffffff 100%);padding:8px 40px 0;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="height:8px;"></td></tr></table>
      </td>
    </tr>`,
  },
  security: {
    accentColor: PRIMARY,
    headerBg: `background:linear-gradient(135deg,#2d2d3d 0%,#1a1a2e 60%,${PRIMARY_DARKER} 100%);`,
    bodyTopHtml: '',
  },
  swap: {
    accentColor: '#c0475e',
    headerBg: `background:linear-gradient(135deg,${PRIMARY} 0%,#a63350 60%,${PRIMARY_DARK} 100%);`,
    bodyTopHtml: '',
  },
  booking: {
    accentColor: PRIMARY,
    headerBg: `background:linear-gradient(135deg,${PRIMARY} 0%,${PRIMARY_DARK} 60%,${PRIMARY_DARKER} 100%);`,
    bodyTopHtml: '',
  },
  engagement: {
    accentColor: '#c0475e',
    headerBg: `background:linear-gradient(135deg,#a63350 0%,${PRIMARY} 60%,${PRIMARY_DARK} 100%);`,
    bodyTopHtml: '',
  },
  alert: {
    accentColor: '#d97706',
    headerBg: `background:linear-gradient(135deg,#92400e 0%,#b45309 50%,#d97706 100%);`,
    bodyTopHtml: '',
  },
  default: {
    accentColor: PRIMARY,
    headerBg: `background:linear-gradient(135deg,${PRIMARY} 0%,${PRIMARY_DARK} 60%,${PRIMARY_DARKER} 100%);`,
    bodyTopHtml: '',
  },
};

function renderLayout({ lang, preheader, title, bodyHtml, ctaLabel, ctaUrl, variant = 'default' }) {
  const footer = t('emails.common.footer', lang);
  const config = VARIANT_CONFIG[variant] || VARIANT_CONFIG.default;
  const accent = config.accentColor;
  const year = new Date().getFullYear();

  const ctaBlock =
    ctaLabel && ctaUrl
      ? `<tr>
          <td style="padding:8px 40px 8px;text-align:center;">
            <table role="presentation" cellspacing="0" cellpadding="0" align="center"><tr>
              <td style="background:${accent};border-radius:12px;border-bottom:3px solid ${PRIMARY_DARKER};mso-padding-alt:0;">
                <a href="${escapeHtml(ctaUrl)}" target="_blank" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:16px 36px;border-radius:12px;letter-spacing:0.3px;mso-padding-alt:0;">${escapeHtml(ctaLabel)}</a>
              </td>
            </tr></table>
          </td>
        </tr>
        <tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="height:16px;"></td></tr></table></td></tr>`
      : '';

  return `<!DOCTYPE html>
<html lang="${lang}" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta http-equiv="X-UA-Compatible" content="IE=edge"/>
  <title>${escapeHtml(title)}</title>
  <!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
</head>
<body style="margin:0;padding:0;background:#f0eeef;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;">
  <span style="display:none !important;font-size:0;line-height:0;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader || title)}${'&#847; &zwnj; '.repeat(30)}</span>

  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f0eeef;">
    <tr>
      <td align="center" style="padding:40px 16px;">

        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,0.08),0 1px 3px rgba(0,0,0,0.04);">

          <!-- HEADER -->
          <tr>
            <td style="${config.headerBg}padding:0;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr><td style="height:36px;"></td></tr>
                <tr>
                  <td align="center" style="padding:0 32px;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center">
                      <tr>
                        <td style="font-size:34px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">LifeKit</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr><td style="height:8px;"></td></tr>
                <tr>
                  <td align="center" style="padding:0 32px;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center">
                      <tr>
                        <td style="font-size:13px;color:rgba(255,255,255,0.65);letter-spacing:0.5px;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">Your life, anywhere. Figured out.</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr><td style="height:12px;"></td></tr>
                <tr>
                  <td align="center" style="padding:0 80px;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td style="height:1px;background:rgba(255,255,255,0.15);font-size:1px;line-height:1px;">&nbsp;</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr><td style="height:6px;"></td></tr>
                <tr>
                  <td align="center" style="padding:0 60px;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center">
                      <tr>
                        <td style="font-size:11px;color:rgba(255,255,255,0.35);letter-spacing:4px;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">&#8226; &#8226; &#8226; &#8226; &#8226;</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr><td style="height:28px;"></td></tr>
              </table>
            </td>
          </tr>

          <!-- VARIANT TOP SECTION -->
          ${config.bodyTopHtml}

          <!-- BODY -->
          <tr>
            <td style="padding:36px 40px 8px;">
              <h1 style="margin:0 0 20px;font-size:24px;line-height:1.35;color:#1a1a1a;font-weight:700;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">${title}</h1>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="height:1px;background:linear-gradient(to right,#e5e5e5,#f5f5f5);font-size:1px;line-height:1px;">&nbsp;</td>
                </tr>
              </table>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr><td style="height:20px;"></td></tr>
              </table>
              <div style="font-size:15px;line-height:1.7;color:#444444;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">${bodyHtml}</div>
            </td>
          </tr>

          <!-- CTA -->
          ${ctaBlock}

          <!-- SPACER BEFORE FOOTER -->
          <tr>
            <td style="padding:0 40px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr><td style="height:16px;"></td></tr>
              </table>
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td style="background:#fafafa;padding:0;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="height:1px;background:#eeeeee;font-size:1px;line-height:1px;">&nbsp;</td>
                </tr>
              </table>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding:28px 40px 12px;text-align:center;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center">
                      <tr>
                        <td style="font-size:15px;font-weight:700;color:${PRIMARY};letter-spacing:-0.3px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">LifeKit</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding:0 40px 16px;text-align:center;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center">
                      <tr>
                        <td style="font-size:12px;color:#999999;font-style:italic;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">Your life, anywhere. Figured out.</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding:0 60px 16px;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td style="height:1px;background:#e8e8e8;font-size:1px;line-height:1px;">&nbsp;</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding:0 40px 8px;text-align:center;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center">
                      <tr>
                        <td style="padding:0 8px;">
                          <a href="${APP_WEB_URL}" target="_blank" style="color:#aaaaaa;text-decoration:none;font-size:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">Website</a>
                        </td>
                        <td style="color:#dddddd;font-size:12px;">&#8226;</td>
                        <td style="padding:0 8px;">
                          <a href="${APP_WEB_URL}/support" target="_blank" style="color:#aaaaaa;text-decoration:none;font-size:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">Support</a>
                        </td>
                        <td style="color:#dddddd;font-size:12px;">&#8226;</td>
                        <td style="padding:0 8px;">
                          <a href="${APP_WEB_URL}/privacy" target="_blank" style="color:#aaaaaa;text-decoration:none;font-size:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">Privacy</a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding:8px 40px 28px;text-align:center;font-size:11px;line-height:1.6;color:#bbbbbb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
                    ${escapeHtml(footer)}<br/>
                    &copy; ${year} LifeKit. All rights reserved.
                  </td>
                </tr>
              </table>
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
  const name = fullName || 'there';
  const welcomeTitle = t('emails.signupOtp.title', lang, { name });
  const intro = t('emails.signupOtp.intro', lang);
  const expiry = t('emails.signupOtp.expiry', lang);

  const titleHtml = `Welcome, ${escapeHtml(name)}!`;

  const bodyHtml = `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      <tr>
        <td style="padding:0 0 4px;">
          <p style="margin:0;font-size:17px;line-height:1.6;color:#666666;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">You're one step away from joining LifeKit</p>
        </td>
      </tr>
      <tr><td style="height:8px;"></td></tr>
      <tr>
        <td style="padding:0 0 20px;">
          <p style="margin:0;font-size:15px;line-height:1.7;color:#444444;">${escapeHtml(intro)}</p>
        </td>
      </tr>
      <tr>
        <td style="padding:0;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
            <tr>
              <td style="background:${PRIMARY};border-radius:12px;padding:28px 20px;text-align:center;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center">
                  <tr>
                    <td style="font-size:36px;font-weight:800;letter-spacing:12px;color:#ffffff;font-family:'Courier New',Courier,monospace;text-align:center;">${escapeHtml(otp)}</td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <tr><td style="height:16px;"></td></tr>
      <tr>
        <td style="text-align:center;">
          <p style="margin:0;color:#999999;font-size:13px;line-height:1.5;">${escapeHtml(expiry)}</p>
        </td>
      </tr>
    </table>`;

  const html = renderLayout({
    lang,
    preheader: subject,
    title: titleHtml,
    bodyHtml,
    variant: 'welcome',
  });
  const text = `${welcomeTitle}\n\nYou're one step away from joining LifeKit\n\n${intro}\n\nYour code: ${otp}\n\n${expiry}`;

  return sendEmail({ to: email, subject, html, text });
}

async function sendPasswordResetEmail({ email, resetLink, lang = 'en' }) {
  const subject = t('emails.passwordReset.subject', lang);
  const rawTitle = t('emails.passwordReset.title', lang);
  const intro = t('emails.passwordReset.intro', lang);
  const ignore = t('emails.passwordReset.ignore', lang);
  const ctaLabel = t('emails.passwordReset.cta', lang);

  const titleHtml = `&#128274; ${escapeHtml(rawTitle)}`;

  const bodyHtml = `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      <tr>
        <td style="padding:0 0 20px;">
          <p style="margin:0;font-size:15px;line-height:1.7;color:#444444;">${escapeHtml(intro)}</p>
        </td>
      </tr>
      <tr>
        <td style="padding:0 0 8px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
            <tr>
              <td style="background:#f8f8fa;border-left:3px solid #2d2d3d;border-radius:0 8px 8px 0;padding:16px 20px;">
                <p style="margin:0;font-size:13px;line-height:1.6;color:#888888;">${escapeHtml(ignore)}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>`;

  const html = renderLayout({
    lang,
    preheader: subject,
    title: titleHtml,
    bodyHtml,
    ctaLabel,
    ctaUrl: resetLink,
    variant: 'security',
  });
  const text = `${rawTitle}\n\n${intro}\n\n${resetLink}\n\n${ignore}`;

  return sendEmail({ to: email, subject, html, text });
}

function resolveNotificationType(type) {
  if (!type) return { variant: 'default', ctaKey: null };

  const map = {
    swap_proposal:    { variant: 'swap',       ctaLabel: 'View Swap' },
    swap_accepted:    { variant: 'swap',       ctaLabel: 'View Swap' },
    swap_declined:    { variant: 'swap',       ctaLabel: 'View Swap' },
    booking_request:  { variant: 'booking',    ctaLabel: 'View Booking' },
    booking_update:   { variant: 'booking',    ctaLabel: 'View Booking' },
    booking_completed:{ variant: 'booking',    ctaLabel: 'View Booking' },
    we_miss_you:      { variant: 'engagement', ctaLabel: 'Come Back' },
    trial_warning:    { variant: 'alert',      ctaLabel: 'Upgrade Now' },
    trial_expired:    { variant: 'alert',      ctaLabel: 'Upgrade Now' },
  };

  for (const [key, config] of Object.entries(map)) {
    if (type === key || type.startsWith(key + '_') || type.startsWith(key)) {
      return config;
    }
  }

  if (type.startsWith('ai_nudge')) {
    return { variant: 'engagement', ctaLabel: 'Open LifeKit' };
  }

  return { variant: 'default', ctaLabel: null };
}

function buildNotificationBody(variant, title, message, greeting) {
  const escapedGreeting = escapeHtml(greeting);
  const escapedTitle = escapeHtml(title);
  const escapedMessage = escapeHtml(message);

  if (variant === 'swap') {
    return `
      <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#444444;">${escapedGreeting}</p>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
        <tr>
          <td style="background:#fdf6f7;border:1px solid #f0dce0;border-radius:12px;padding:24px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
              <tr>
                <td style="padding:0 0 4px;">
                  <p style="margin:0;font-size:11px;font-weight:700;color:${PRIMARY};text-transform:uppercase;letter-spacing:1.5px;">Skill Swap</p>
                </td>
              </tr>
              <tr>
                <td style="padding:4px 0 8px;">
                  <p style="margin:0;font-size:17px;font-weight:700;color:#1a1a1a;line-height:1.4;">${escapedTitle}</p>
                </td>
              </tr>
              <tr>
                <td>
                  <p style="margin:0;font-size:14px;line-height:1.6;color:#666666;">${escapedMessage}</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>`;
  }

  if (variant === 'booking') {
    return `
      <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#444444;">${escapedGreeting}</p>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
        <tr>
          <td style="background:#f8f9fa;border-left:3px solid ${PRIMARY};border-radius:0 8px 8px 0;padding:20px 24px;">
            <p style="margin:0 0 6px;font-size:16px;font-weight:700;color:#222222;line-height:1.4;">${escapedTitle}</p>
            <p style="margin:0;font-size:14px;line-height:1.6;color:#555555;">${escapedMessage}</p>
          </td>
        </tr>
      </table>`;
  }

  if (variant === 'alert') {
    return `
      <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#444444;">${escapedGreeting}</p>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
        <tr>
          <td style="background:#fffbeb;border:1px solid #fde68a;border-radius:12px;padding:20px 24px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
              <tr>
                <td style="width:28px;vertical-align:top;padding-top:2px;">
                  <span style="font-size:18px;">&#9888;&#65039;</span>
                </td>
                <td style="padding-left:8px;">
                  <p style="margin:0 0 6px;font-size:16px;font-weight:700;color:#92400e;line-height:1.4;">${escapedTitle}</p>
                  <p style="margin:0;font-size:14px;line-height:1.6;color:#78350f;">${escapedMessage}</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>`;
  }

  if (variant === 'engagement') {
    return `
      <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#444444;">${escapedGreeting}</p>
      <p style="margin:0 0 6px;font-size:18px;font-weight:700;color:#222222;line-height:1.4;">${escapedTitle}</p>
      <p style="margin:0;font-size:15px;line-height:1.7;color:#555555;">${escapedMessage}</p>`;
  }

  return `
    <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#444444;">${escapedGreeting}</p>
    <p style="margin:0 0 6px;font-size:16px;font-weight:700;color:#222222;line-height:1.4;">${escapedTitle}</p>
    <p style="margin:0;font-size:15px;line-height:1.7;color:#555555;">${escapedMessage}</p>`;
}

async function sendNotificationEmail({
  email,
  fullName,
  title,
  message,
  lang = 'en',
  actionUrl,
  type,
}) {
  const subject = title;
  const greeting = t('emails.notification.greeting', lang, {
    name: fullName || t('emails.notification.defaultName', lang),
  });

  const { variant, ctaLabel: typeCta } = resolveNotificationType(type);
  const fallbackCtaLabel = t('emails.notification.cta', lang);
  const ctaLabel = typeCta || fallbackCtaLabel;

  const bodyHtml = buildNotificationBody(variant, title, message, greeting);

  const html = renderLayout({
    lang,
    preheader: message,
    title: escapeHtml(title),
    bodyHtml,
    ctaLabel: actionUrl ? ctaLabel : null,
    ctaUrl: actionUrl || null,
    variant,
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
