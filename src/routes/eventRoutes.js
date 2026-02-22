// src/routes/eventRoutes.js  ── UPDATED to support categories + featured events
const express = require('express');
const router = express.Router();
const { supabaseAdmin, supabase } = require('../config/supabase');
const authenticateAdmin  = require('../middleware/adminMiddleware');
const authenticateToken  = require('../middleware/authMiddleware');

// =============================================================================
// PUBLIC / USER ROUTES
// =============================================================================

/**
 * GET /feeds/events
 * Now returns: category, event_time, is_featured columns
 * Mobile uses this for the Figma-style events tab
 */
router.get('/events', async (req, res) => {
  try {
    const { category } = req.query; // optional ?category=Theatre

    let query = supabase
      .from('events')
      .select('*')
      .eq('is_active', true)
      .order('event_date', { ascending: true });

    if (category && category !== 'All') {
      query = query.ilike('category', category);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /feeds/events/featured
 * Returns only featured events for the hero carousel
 */
router.get('/events/featured', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('events')
      .select('*')
      .eq('is_active', true)
      .eq('is_featured', true)
      .order('event_date', { ascending: true })
      .limit(6);

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /feeds/events/categories
 * Returns distinct category list for the category filter chips
 */
router.get('/events/categories', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('events')
      .select('category')
      .eq('is_active', true)
      .not('category', 'is', null);

    if (error) throw error;

    // Return unique categories
    const unique = [...new Set(data.map(e => e.category).filter(Boolean))];
    res.json(unique);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// ADMIN ROUTES
// =============================================================================

router.get('/', authenticateAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('events')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const now = new Date();
    const eventsWithStatus = data.map(event => {
      const eventDateTime = new Date(`${event.event_date}T${event.event_time || '00:00:00'}`);
      const isTimeValid = eventDateTime > now;
      return {
        ...event,
        status: (event.is_active && isTimeValid) ? 'Active' : 'Inactive',
        raw_datetime: eventDateTime
      };
    });

    res.json(eventsWithStatus);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /admin/events  — now accepts: category, is_featured
 */
router.post('/', authenticateAdmin, async (req, res) => {
  const {
    title, description, image_url,
    event_date, event_time, price,
    location, address,
    category,        // NEW: 'Theatre' | 'Sport' | 'Festival' | 'Tourism' | 'Music' | 'Food'
    is_featured      // NEW: true = show in hero carousel
  } = req.body;

  try {
    const { data, error } = await supabaseAdmin
      .from('events')
      .insert({
        title, description, image_url,
        event_date, event_time, price,
        location, address,
        category:    category    ?? null,
        is_featured: is_featured ?? false,
        is_active:   true
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id/status', authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  const { is_active } = req.body;
  try {
    const { data, error } = await supabaseAdmin
      .from('events').update({ is_active }).eq('id', id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /:id/featured  — Toggle featured status
 */
router.put('/:id/featured', authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  const { is_featured } = req.body;
  try {
    const { data, error } = await supabaseAdmin
      .from('events').update({ is_featured }).eq('id', id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { error } = await supabaseAdmin.from('events').delete().eq('id', id);
    if (error) throw error;
    res.json({ message: "Event deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// BUY TICKET (unchanged logic, kept here)
// =============================================================================
router.post('/buy-ticket', authenticateToken, async (req, res) => {
  const { event_id, quantity, total_price } = req.body;
  const userId = req.user.id;

  if (!event_id || !quantity || !total_price) {
    return res.status(400).json({ error: 'Missing ticket details' });
  }

  try {
    const { data: wallet } = await supabaseAdmin
      .from('wallets').select('*').eq('user_id', userId).single();

    if (!wallet || parseFloat(wallet.balance) < parseFloat(total_price)) {
      return res.status(402).json({ error: 'Insufficient wallet balance.' });
    }

    const newBalance = parseFloat(wallet.balance) - parseFloat(total_price);
    const { error: walletError } = await supabaseAdmin
      .from('wallets').update({ balance: newBalance }).eq('id', wallet.id);
    if (walletError) throw walletError;

    const ticketCode = 'TKT-' + Math.random().toString(36).substr(2, 8).toUpperCase();

    const { data: ticket, error: ticketError } = await supabaseAdmin
      .from('event_tickets')
      .insert({ user_id: userId, event_id, quantity, total_price, ticket_code: ticketCode, status: 'confirmed' })
      .select('*, events(title, location, event_date, event_time)')
      .single();

    if (ticketError) throw ticketError;

    await supabaseAdmin.from('transactions').insert({
      wallet_id: wallet.id, type: 'payment', amount: total_price,
      status: 'success', description: `Ticket for ${ticket.events.title}`
    });

    await supabaseAdmin.from('notifications').insert({
      user_id: userId,
      title: 'Ticket Purchased! 🎟️',
      message: `You bought ${quantity} ticket(s) for ${ticket.events.title}.`,
      type: 'event_ticket', reference_id: ticket.id
    });

    res.status(201).json({ message: 'Ticket purchased successfully!', ticket });
  } catch (error) {
    res.status(500).json({ error: 'Transaction failed.' });
  }
});

module.exports = router;