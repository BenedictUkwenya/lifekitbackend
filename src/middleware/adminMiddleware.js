// Import supabaseAdmin (The Service Role Key)
const { supabase, supabaseAdmin } = require('../config/supabase');

async function authenticateAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token == null) return res.status(401).json({ error: 'Token required' });

  try {
    console.log("Admin Auth: start");
    let user;
    try {
      const { data, error } = await supabase.auth.getUser(token);
      if (error || !data?.user) {
        console.error("Admin Auth: getUser error", {
          message: error?.message,
          status: error?.status,
          code: error?.code
        });
        return res.status(401).json({ error: 'Invalid or expired token' });
      }
      user = data.user;
      console.log("Admin Auth: token verified", { userId: user.id });
    } catch (err) {
      console.error("Admin Auth: getUser failed", {
        message: err?.message,
        code: err?.code,
        cause: err?.cause
      });
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    console.log("Admin Auth: fetching profile role", { userId: user.id });
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      console.error("Admin Auth: profile lookup failed", {
        userId: user.id,
        message: profileError?.message
      });
      return res.status(403).json({ error: 'Profile not found' });
    }

    if (profile.role !== 'admin') {
      console.warn(`User ${user.email} (Role: ${profile.role}) tried to access admin area.`);
      return res.status(403).json({ error: 'Access Denied: Admins only.' });
    }

    req.user = user;
    next();

  } catch (err) {
    console.error("Admin Middleware Error:", err);
    return res.status(500).json({ error: 'Internal Server Error during Auth' });
  }
}

module.exports = authenticateAdmin;
