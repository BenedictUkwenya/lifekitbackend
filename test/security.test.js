// Run with: npm test
// Exercises the real Express app in-process (no network to Supabase needed
// for these paths): Stripe webhook signature handling and rate limits.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Fake credentials set BEFORE the app loads: dotenv never overrides
// variables that already exist, so tests can't reach real services even
// when a .env file is present.
process.env.NODE_ENV = 'production'; // don't auto-listen on 3000
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_ANON_KEY = 'test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
process.env.SUPABASE_SERVICE_KEY = 'test';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.GEMINI_API_KEY = 'test';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';

const app = require('../index.js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

let server;
let base;
before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (path, body, headers = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

test('webhook rejects a bad signature', async () => {
  const res = await post('/wallet/stripe-webhook', { type: 'x' }, { 'stripe-signature': 't=1,v1=bad' });
  assert.equal(res.status, 400);
});

test('webhook accepts a correctly signed event it does not act on', async () => {
  const payload = JSON.stringify({
    id: 'evt_test',
    object: 'event',
    type: 'customer.created',
    data: { object: { id: 'cus_1' } },
  });
  const header = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: process.env.STRIPE_WEBHOOK_SECRET,
  });
  const res = await post('/wallet/stripe-webhook', payload, { 'stripe-signature': header });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { received: true });
});

test('code-sending endpoints are limited to 5 per window per email', async () => {
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    const res = await post('/auth/resend-otp', { email: 'limit-test@example.com' });
    statuses.push(res.status);
  }
  assert.notEqual(statuses[4], 429, 'first five requests must not be rate limited');
  assert.equal(statuses[5], 429, 'sixth request must be rate limited');
});

test('security headers are set', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('waitlist rejects an invalid email', async () => {
  const res = await post('/waitlist', { email: 'not-an-email' });
  assert.equal(res.status, 400);
});
