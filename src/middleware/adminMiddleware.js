// Import supabaseAdmin (The Service Role Key)
const { supabase, supabaseAdmin } = require('../config/supabase');

async function authenticateAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token == null) return res.status(401).json({ error: 'Token required' });

  try {
    // 1. Verify the Token using standard client (Validates the JWT)
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }

    // 2. CHECK DATABASE ROLE using **supabaseAdmin**
    // supabaseAdmin BYPASSES RLS, so it can definitely read the row.
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      console.error("Admin Check Failed: Profile not found for user", user.id);
      return res.status(403).json({ error: 'Profile not found' });
    }

    // 3. Verify the Role
    if (profile.role !== 'admin') {
      console.warn(`User ${user.email} (Role: ${profile.role}) tried to access admin area.`);
      return res.status(403).json({ error: 'Access Denied: Admins only.' });
    }

    // Success!
    req.user = user;
    next();

  } catch (err) {
    console.error("Admin Middleware Error:", err);
    return res.status(500).json({ error: 'Internal Server Error during Auth' });
  }
}

module.exports = authenticateAdmin;