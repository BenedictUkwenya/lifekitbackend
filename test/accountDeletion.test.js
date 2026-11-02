// Run with: npm test
// Unit tests for account deletion rules. No network: the Supabase client is stubbed.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Fake credentials before any module reads them (dotenv won't override).
process.env.NODE_ENV = 'production';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_ANON_KEY = 'test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
process.env.SUPABASE_SERVICE_KEY = 'test';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.GEMINI_API_KEY = 'test';

const { supabaseAdmin } = require('../src/config/supabase');
const { getDeletionBlocker, deleteAccount } = require('../src/services/accountDeletionService');

const USER = '11111111-1111-1111-1111-111111111111';

let original;
let calls;
let results; // table -> response for that table

// Chainable stand-in for a Supabase query: records writes, resolves to `results`.
function fakeQuery(table) {
  const query = {
    then: (resolve) => {
      const failure = results.failOn === table ? { error: { message: `${table} failed` } } : {};
      resolve({ data: [], count: 0, error: null, ...results[table], ...failure });
    },
  };
  for (const method of ['select', 'eq', 'neq', 'or', 'not', 'order', 'limit', 'maybeSingle']) {
    query[method] = () => query;
  }
  query.update = (values) => {
    calls.push(['update', table, values]);
    return query;
  };
  query.delete = () => {
    calls.push(['delete', table]);
    return query;
  };
  return query;
}

beforeEach(() => {
  calls = [];
  results = {};
  original = { from: supabaseAdmin.from, deleteUser: supabaseAdmin.auth.admin.deleteUser, storage: supabaseAdmin.storage };
  supabaseAdmin.from = fakeQuery;
  supabaseAdmin.auth.admin.deleteUser = async (...args) => {
    calls.push(['deleteUser', ...args]);
    return { data: {}, error: null };
  };
  Object.defineProperty(supabaseAdmin, 'storage', {
    configurable: true,
    value: { from: () => ({ list: async () => ({ data: [], error: null }), remove: async () => ({ data: [], error: null }) }) },
  });
});

afterEach(() => {
  supabaseAdmin.from = original.from;
  supabaseAdmin.auth.admin.deleteUser = original.deleteUser;
  Object.defineProperty(supabaseAdmin, 'storage', { configurable: true, value: original.storage });
});

test('blocker: wallet money stops deletion, an empty wallet does not', async () => {
  results.wallets = { data: [{ balance: '5.50' }] };
  assert.equal(await getDeletionBlocker(USER), 'wallet_balance');

  results.wallets = { data: [{ balance: '0.00' }] };
  assert.equal(await getDeletionBlocker(USER), null);
});

test('blocker: open bookings and disputes stop deletion', async () => {
  results.bookings = { count: 1 };
  assert.equal(await getDeletionBlocker(USER), 'open_booking');

  results.bookings = { count: 0 };
  results.disputes = { count: 2 };
  assert.equal(await getDeletionBlocker(USER), 'open_dispute');
});

test('delete: anonymises the profile, then soft-deletes the login last', async () => {
  await deleteAccount(USER);

  assert.deepEqual(calls.at(-1), ['deleteUser', USER, true]);
  const profile = calls.find(([op, table]) => op === 'update' && table === 'profiles');
  assert.equal(profile[2].full_name, 'Deleted User');
  assert.equal(profile[2].status, 'deleted');
  assert.equal(profile[2].phone_number, null);
});

test('delete: keeps financial records and services that bookings point at', async () => {
  await deleteAccount(USER);

  const deleted = calls.filter(([op]) => op === 'delete').map(([, table]) => table);
  for (const kept of ['wallets', 'transactions', 'bookings', 'disputes', 'services', 'messages', 'reviews']) {
    assert.equal(deleted.includes(kept), false, `${kept} must not be deleted`);
  }
  const service = calls.find(([op, table]) => op === 'update' && table === 'services');
  assert.equal(service[2].status, 'cancelled');
});

test('delete: a failed step keeps the login so the user can retry', async () => {
  results.failOn = 'posts';
  await assert.rejects(deleteAccount(USER), /posts failed/);
  assert.equal(calls.some(([op]) => op === 'deleteUser'), false);
});

test('groups: other members inherit the group, empty groups are deleted', async () => {
  results.groups = { data: [{ id: 'g1' }] };
  results.group_members = { data: [{ user_id: 'heir' }] };
  await deleteAccount(USER);
  assert.deepEqual(
    calls.find(([op, table]) => op === 'update' && table === 'groups'),
    ['update', 'groups', { creator_id: 'heir' }],
  );

  calls = [];
  results.group_members = { data: [] };
  await deleteAccount(USER);
  assert.ok(calls.some(([op, table]) => op === 'delete' && table === 'groups'));
});
