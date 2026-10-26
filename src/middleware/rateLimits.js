// src/middleware/rateLimits.js
// Request rate limits. On Vercel each serverless instance keeps its own
// counters, so these stop bursts and casual abuse rather than acting as a
// strict global quota.
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const base = {
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down and try again shortly.' },
};

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 24);

// Everything: generous safety net.
const globalLimiter = rateLimit({ ...base, windowMs: 60 * 1000, max: 300 });

// Login / signup / reset: slows down password guessing.
const authLimiter = rateLimit({ ...base, windowMs: 15 * 60 * 1000, max: 20 });

// Endpoints that send an email: per IP + email address.
const emailLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => `${req.ip}|${String(req.body?.email || '').toLowerCase().trim()}`,
  message: { error: 'Too many codes requested. Please wait a few minutes and try again.' },
});

// Paid AI calls: per signed-in user (token), falling back to IP.
const aiLimiter = rateLimit({
  ...base,
  windowMs: 10 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => {
    const auth = req.headers.authorization || '';
    return auth ? `u:${hash(auth)}` : `ip:${req.ip}`;
  },
  message: { error: 'You are sending messages too quickly. Please wait a moment.' },
});

module.exports = { globalLimiter, authLimiter, emailLimiter, aiLimiter };
