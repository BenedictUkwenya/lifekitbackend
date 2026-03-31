require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { supabaseAdmin } = require('../src/config/supabase');

const ARCHIVE_EMAIL = 'archive@lifekit.local';
const ARCHIVE_PASSWORD = 'password123';
const ARCHIVE_NAME = 'LifeKit Archive';

const TABLES_TO_CLEAR = [
  'bookings',
  'messages',
  'transactions',
  'wallets',
  'notifications',
  'support_tickets',
  'user_reports',
  'disputes',
  'event_tickets',
  'group_posts',
  'group_members'
];

async function listAllUsers() {
  const users = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (error) {
      throw new Error(`Failed to list users on page ${page}: ${error.message}`);
    }

    const batch = data?.users || [];
    users.push(...batch);

    if (batch.length < perPage) {
      break;
    }

    page += 1;
  }

  return users;
}

async function getOrCreateArchiveUser() {
  console.log('Step 1/5: Creating or locating ghost provider user...');
  const users = await listAllUsers();
  const existing = users.find((user) => (user.email || '').toLowerCase() === ARCHIVE_EMAIL.toLowerCase());

  if (existing) {
    console.log(`Ghost provider already exists with id: ${existing.id}`);
    return existing;
  }

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email: ARCHIVE_EMAIL,
    password: ARCHIVE_PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: ARCHIVE_NAME }
  });

  if (error || !data?.user) {
    throw new Error(`Failed to create ghost provider user: ${error?.message || 'Unknown error'}`);
  }

  console.log(`Ghost provider created with id: ${data.user.id}`);
  return data.user;
}

async function ensureArchiveProfile(archiveUserId) {
  console.log('Updating ghost provider profile...');
  const { error } = await supabaseAdmin
    .from('profiles')
    .upsert(
      {
        id: archiveUserId,
        email: ARCHIVE_EMAIL,
        full_name: ARCHIVE_NAME,
        is_service_provider: true
      },
      { onConflict: 'id' }
    );

  if (error) {
    throw new Error(`Failed to upsert ghost profile: ${error.message}`);
  }

  console.log('Ghost provider profile is ready.');
}

async function transferAllServices(archiveUserId) {
  console.log('Step 2/5: Transferring all services to LifeKit Archive...');
  const { data, error } = await supabaseAdmin
    .from('services')
    .update({ provider_id: archiveUserId })
    .neq('id', '00000000-0000-0000-0000-000000000000')
    .select('id');

  if (error) {
    throw new Error(`Failed to transfer services: ${error.message}`);
  }

  console.log(`Transferred ${data?.length || 0} services to ${archiveUserId}.`);
}

async function wipeTransactionalData() {
  console.log('Step 3/5: Wiping transactional data tables...');

  for (const tableName of TABLES_TO_CLEAR) {
    console.log(`Clearing table: ${tableName}...`);
    const { data, error } = await supabaseAdmin
      .from(tableName)
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000')
      .select('id');

    if (error) {
      throw new Error(`Failed to clear ${tableName}: ${error.message}`);
    }

    console.log(`Cleared ${data?.length || 0} rows from ${tableName}.`);
  }
}

async function deleteAllOtherUsers(archiveUserId) {
  console.log('Step 4/5: Deleting all users except LifeKit Archive...');
  const users = await listAllUsers();
  let deletedCount = 0;

  for (const user of users) {
    if (user.id === archiveUserId) {
      continue;
    }

    const { error } = await supabaseAdmin.auth.admin.deleteUser(user.id);
    if (error) {
      throw new Error(`Failed to delete user ${user.id} (${user.email || 'no-email'}): ${error.message}`);
    }

    deletedCount += 1;
    console.log(`Deleted user ${deletedCount}: ${user.email || user.id}`);
  }

  console.log(`Deleted ${deletedCount} users. LifeKit Archive preserved.`);
}

async function main() {
  console.log('Starting LifeKit clean slate database reset...');

  const archiveUser = await getOrCreateArchiveUser();
  await ensureArchiveProfile(archiveUser.id);
  await transferAllServices(archiveUser.id);
  await wipeTransactionalData();
  await deleteAllOtherUsers(archiveUser.id);
  console.log('Step 5/5: Preserving service_categories by taking no action on that table.');

  console.log('Database reset complete.');
  console.log('service_categories and services are preserved; all services now belong to LifeKit Archive.');
}

main().catch((error) => {
  console.error('Reset failed:', error.message);
  process.exit(1);
});
