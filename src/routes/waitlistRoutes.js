// src/routes/waitlistRoutes.js
// POST /waitlist — collects emails on lifekithub.com before the apps launch.
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { emailLimiter } = require('../middleware/rateLimits');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

router.post('/', emailLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const role = req.body?.role === 'provider' ? 'provider' : 'customer';
  const lang = ['en', 'ka', 'ru'].includes(req.body?.lang) ? req.body.lang : 'en';
  const source = String(req.body?.source || 'website').slice(0, 40);

  if (!EMAIL_RE.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  try {
    const { error } = await supabaseAdmin
      .from('waitlist')
      .insert({ email, role, lang, source });
    // 23505 = already on the list — treat as success so we don't reveal who signed up.
    if (error && error.code !== '23505') throw error;
    res.status(201).json({ message: "You're on the list!" });
  } catch (error) {
    console.error('Waitlist error:', error.message);
    res.status(500).json({ error: 'Could not join the waitlist. Please try again.' });
  }
});

module.exports = router;
