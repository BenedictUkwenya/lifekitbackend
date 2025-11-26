// src/config/supabase.js
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY; // For admin tasks

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('Error: Supabase URL or Anon Key is missing in .env file.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);
// Use the service key for admin actions that must bypass RLS (e.g., cron jobs, admin dashboard logic)
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey); 

module.exports = { supabase, supabaseAdmin };