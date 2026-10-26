// Run with: npm test
// Unit tests for money and AI-safety logic. No network: the Supabase client
// is stubbed where needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');

// Fake credentials before any module reads them (dotenv won't override).
process.env.NODE_ENV = 'production';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_ANON_KEY = 'test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
process.env.SUPABASE_SERVICE_KEY = 'test';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.GEMINI_API_KEY = 'test';

const { isValidServiceTotal } = require('../src/routes/bookingRoutes');
const { validateItems } = require('../src/routes/aiRoutes');
const { creditDeposit } = require('../src/routes/walletRoutes');
const { supabaseAdmin } = require('../src/config/supabase');

// ── Booking price validation ────────────────────────────────────────────────
test('fixed price: accepts 1–20 units, rejects anything else', () => {
  const svc = { price: 25 };
  assert.equal(isValidServiceTotal(svc, 25), true);
  assert.equal(isValidServiceTotal(svc, 75), true); // quantity 3
  assert.equal(isValidServiceTotal(svc, 500), true); // quantity 20
  assert.equal(isValidServiceTotal(svc, 525), false); // quantity 21
  assert.equal(isValidServiceTotal(svc, 10), false);
  assert.equal(isValidServiceTotal(svc, -25), false);
});

test('hourly price: accepts whole hours only', () => {
  const svc = { price: 20, pricing_type: 'hourly' };
  assert.equal(isValidServiceTotal(svc, 60), true);
  assert.equal(isValidServiceTotal(svc, 30), false);
});

test('options: total must be a sum of selected option prices', () => {
  const svc = { price: 0, service_options: [{ price: 10 }, { price: 15 }] };
  assert.equal(isValidServiceTotal(svc, 25), true);
  assert.equal(isValidServiceTotal(svc, 10), true);
  assert.equal(isValidServiceTotal(svc, 12), false);
});

// ── AI id validation ────────────────────────────────────────────────────────
test('AI items: invented ids, duplicates and wrong types are dropped', () => {
  const lookup = {
    service: new Map([['s1', { id: 's1', title: 'Real title' }]]),
    community: new Map([['g1', { id: 'g1', name: 'Group' }]]),
  };
  const out = validateItems(
    [
      { type: 'service', id: 's1', title: 'AI-invented title' },
      { type: 'service', id: 'made-up' },
      { type: 'community', id: 'g1' },
      { type: 'service', id: 's1' },
      { type: 'event', id: 's1' },
    ],
    lookup,
    (type, row) => ({ type, id: row.id, title: row.title ?? row.name }),
  );
  assert.deepEqual(out, [
    { type: 'service', id: 's1', title: 'Real title' },
    { type: 'community', id: 'g1', title: 'Group' },
  ]);
});

test('AI items: non-array input is safe', () => {
  assert.deepEqual(validateItems(undefined, {}, () => ({})), []);
});

// ── Deposit crediting ───────────────────────────────────────────────────────
test('deposit: credits through the atomic DB function with dollars', async () => {
  const calls = [];
  const original = supabaseAdmin.rpc;
  supabaseAdmin.rpc = async (fn, args) => {
    calls.push({ fn, args });
    return { data: true, error: null };
  };
  try {
    const credited = await creditDeposit({ id: 'pi_1', amount: 1250, metadata: { walletId: 'w1' } });
    assert.equal(credited, true);
    assert.deepEqual(calls, [
      { fn: 'credit_wallet_deposit', args: { p_payment_id: 'pi_1', p_wallet_id: 'w1', p_amount: 12.5 } },
    ]);
  } finally {
    supabaseAdmin.rpc = original;
  }
});

test('deposit: a payment already credited reports false (no double credit)', async () => {
  const original = supabaseAdmin.rpc;
  supabaseAdmin.rpc = async () => ({ data: false, error: null });
  try {
    assert.equal(await creditDeposit({ id: 'pi_1', amount: 500, metadata: { walletId: 'w1' } }), false);
  } finally {
    supabaseAdmin.rpc = original;
  }
});

test('deposit: refuses a payment without wallet metadata', async () => {
  await assert.rejects(() => creditDeposit({ id: 'pi_2', amount: 500, metadata: {} }));
});
