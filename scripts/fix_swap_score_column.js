require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const https = require('https');

// Use Supabase REST API with service key to run SQL via pg_net or direct approach
// Since exec_sql RPC isn't available, we use the Supabase Management API or
// fall back to running it manually via the dashboard.

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !serviceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}

// Extract project ref from URL: https://<ref>.supabase.co
const match = supabaseUrl.match(/https:\/\/([^.]+)\.supabase\.co/);
if (!match) {
  console.error('Could not parse project ref from SUPABASE_URL:', supabaseUrl);
  process.exit(1);
}
const projectRef = match[1];

const sql = `ALTER TABLE swap_requests ALTER COLUMN ai_match_score TYPE NUMERIC(5,2);`;

console.log('Running SQL:', sql);
console.log('Project:', projectRef);

const body = JSON.stringify({ query: sql });

const options = {
  hostname: `${projectRef}.supabase.co`,
  path: '/rest/v1/rpc/exec_sql',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Length': Buffer.byteLength(body),
  },
};

// Try via the pg REST endpoint
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(supabaseUrl, serviceKey);

// Supabase JS v2 doesn't expose raw SQL. Print instructions instead.
console.log('\n============================================================');
console.log('MANUAL STEP REQUIRED');
console.log('============================================================');
console.log('Run this SQL in your Supabase SQL Editor:');
console.log('');
console.log('  ALTER TABLE swap_requests');
console.log('  ALTER COLUMN ai_match_score TYPE NUMERIC(5,2);');
console.log('');
console.log('URL: https://app.supabase.com/project/' + projectRef + '/sql/new');
console.log('============================================================\n');
