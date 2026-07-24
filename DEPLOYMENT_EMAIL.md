# Resend Email Deployment Checklist

Complete these steps before production email sending works.

## 1. Resend dashboard

1. Add your domain (e.g. `lifekithub.com`) and complete DNS verification.
2. Create an API key with **Send** permission.
3. Note your verified sender address (e.g. `hello@lifekithub.com` — avoid `noreply@`, it hurts inbox placement).

## 2. Vercel environment variables (`lifekitbackend`)

| Variable | Required | Example |
|----------|----------|---------|
| `RESEND_API_KEY` | Yes | `re_...` |
| `RESEND_FROM_EMAIL` | Yes | `LifeKit <hello@lifekithub.com>` |
| `RESEND_REPLY_TO` | No | `support@lifekithub.com` |
| `APP_WEB_URL` | Yes | `https://www.lifekithub.com` |
| `PROVIDER_WEB_RESET_URL` | No | `https://www.lifekithub.com/reset-password` |
| `CRON_SECRET` | Yes (for crons) | random secret string |

## 3. Supabase

1. Run migration: `migrations/add_email_and_activity_fields.sql`
2. **Authentication → Email**: disable automatic auth emails (backend sends via Resend using `generateLink`).
3. Keep **Confirm email** enabled so unverified users cannot log in.

## 4. Deploy backend

Push and deploy `my-mobile-app-backend` to Vercel.

## 5. Manual test matrix

```bash
# Signup (returns 200; check inbox for OTP)
curl -X POST https://lifekitbackend.vercel.app/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"secret123","full_name":"Test User","language":"en"}'

# Forgot password
curl -X POST https://lifekitbackend.vercel.app/auth/forgot-password \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","source":"web","language":"en"}'

# We-miss-you cron (requires CRON_SECRET)
curl https://lifekitbackend.vercel.app/cron/check-user-inactivity \
  -H "Authorization: Bearer YOUR_CRON_SECRET"
```

Also verify in-app:
- Provider-web registration OTP flow
- Flutter registration OTP flow
- Booking request → provider receives email
- Swap accept → proposer receives email
- Booking completion → both parties receive email

## 6. Local development

Copy `.env.example` to `.env` and add your `RESEND_API_KEY`. Without a key, emails are skipped with a console warning — the API still works.
