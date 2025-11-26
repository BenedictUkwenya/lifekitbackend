// src/middleware/authMiddleware.js
const { supabase } = require('../config/supabase');

async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Expects format: Bearer [token]

  if (token == null) {
    return res.status(401).json({ error: 'Authentication token required.' });
  }

  // Use Supabase to verify the JWT token
  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) {
    console.error('Token verification failed:', error ? error.message : 'No user found.');
    return res.status(403).json({ error: 'Invalid or expired token.' });
  }

  req.user = user; // Attach the user object to the request
  next();
}

module.exports = authenticateToken;