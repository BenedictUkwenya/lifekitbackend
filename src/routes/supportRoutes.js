const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const authenticateToken = require('../middleware/authMiddleware');

router.post('/', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { subject, message } = req.body;

  try {
    if (!subject || !message) {
      return res.status(400).json({ error: 'Subject and message are required' });
    }

    const { data, error } = await supabaseAdmin
      .from('support_tickets')
      .insert({
        user_id: userId,
        subject,
        message,
        status: 'open'
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ ticket: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/my-tickets', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    const { data, error } = await supabaseAdmin
      .from('support_tickets')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ tickets: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/report', authenticateToken, async (req, res) => {
  const reporterId = req.user.id;
  const { reported_user_id, reason, details } = req.body;

  try {
    if (!reported_user_id || !reason) {
      return res.status(400).json({ error: 'reported_user_id and reason are required' });
    }

    const { data, error } = await supabaseAdmin
      .from('user_reports')
      .insert({
        reporter_id: reporterId,
        reported_user_id,
        reason,
        details: details || null,
        status: 'pending'
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ report: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
