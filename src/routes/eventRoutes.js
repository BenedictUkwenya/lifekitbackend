// src/routes/eventRoutes.js
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase'); 
const authenticateAdmin = require('../middleware/adminMiddleware'); // For Admin Actions
const authenticateToken = require('../middleware/authMiddleware'); // For User Actions (Buying)

// =============================================================================
// ADMIN ROUTES (Manage Events)
// =============================================================================

/**
 * 1. GET /admin/events
 * Logic: Fetches events and calculates "Active/Inactive" status on the fly
 */
router.get('/', authenticateAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('events')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const now = new Date();
    
    const eventsWithStatus = data.map(event => {
      // Create a Date object from the event date and time
      // Assuming event_date is "YYYY-MM-DD" and event_time is "HH:MM:SS"
      const eventDateTime = new Date(`${event.event_date}T${event.event_time}`);
      
      // Logic: It is active ONLY if manual flag is TRUE AND date is in FUTURE
      const isTimeValid = eventDateTime > now;
      const finalStatus = (event.is_active && isTimeValid) ? 'Active' : 'Inactive';
      
      return {
        ...event,
        status: finalStatus, // 'Active' or 'Inactive'
        raw_datetime: eventDateTime
      };
    });

    res.json(eventsWithStatus);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 2. POST /admin/events
 * Logic: Create a new event
 */
router.post('/', authenticateAdmin, async (req, res) => {
  const { title, description, image_url, event_date, event_time, price, location } = req.body;

  try {
    const { data, error } = await supabaseAdmin
      .from('events')
      .insert({
        title,
        description,
        image_url,
        event_date,
        event_time,
        price,
        location,
        is_active: true // Default to true on creation
      })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 3. PUT /admin/events/:id/status
 * Logic: Toggle Active/Inactive status manually
 */
router.put('/:id/status', authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  const { is_active } = req.body; // true or false

  try {
    const { data, error } = await supabaseAdmin
      .from('events')
      .update({ is_active })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 4. DELETE /admin/events/:id
 * Logic: Delete an event
 */
router.delete('/:id', authenticateAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const { error } = await supabaseAdmin
      .from('events')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ message: "Event deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// USER ROUTES (Buy Tickets)
// =============================================================================

/**
 * 5. POST /admin/events/buy-ticket
 * Logic: Wallet Deduction -> Create Ticket -> Transaction Log
 */
router.post('/buy-ticket', authenticateToken, async (req, res) => {
  const { event_id, quantity, total_price } = req.body;
  const userId = req.user.id; 

  if (!event_id || !quantity || !total_price) {
    return res.status(400).json({ error: 'Missing ticket details' });
  }

  try {
    // 1. Check Wallet Balance
    const { data: wallet } = await supabaseAdmin
      .from('wallets')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (!wallet || parseFloat(wallet.balance) < parseFloat(total_price)) {
      return res.status(402).json({ error: 'Insufficient wallet balance.' });
    }

    // 2. Deduct Funds
    const newBalance = parseFloat(wallet.balance) - parseFloat(total_price);
    const { error: walletError } = await supabaseAdmin
      .from('wallets')
      .update({ balance: newBalance })
      .eq('id', wallet.id);

    if (walletError) throw walletError;

    // 3. Generate Ticket Code (Random alphanumeric)
    const ticketCode = 'TKT-' + Math.random().toString(36).substr(2, 8).toUpperCase();

    // 4. Create Ticket
    const { data: ticket, error: ticketError } = await supabaseAdmin
      .from('event_tickets')
      .insert({
        user_id: userId,
        event_id,
        quantity,
        total_price,
        ticket_code: ticketCode,
        status: 'confirmed'
      })
      .select('*, events(title, location, event_date, event_time)') // Join event details for the receipt
      .single();

    if (ticketError) throw ticketError;

    // 5. Log Transaction
    await supabaseAdmin.from('transactions').insert({
      wallet_id: wallet.id,
      type: 'payment',
      amount: total_price,
      status: 'success',
      description: `Ticket for ${ticket.events.title}`
    });

    // 6. Notify User
    await supabaseAdmin.from('notifications').insert({
      user_id: userId,
      title: 'Ticket Purchased! 🎟️',
      message: `You have successfully bought ${quantity} ticket(s) for ${ticket.events.title}.`,
      type: 'event_ticket',
      reference_id: ticket.id
    });

    res.status(201).json({ 
      message: 'Ticket purchased successfully!', 
      ticket: ticket 
    });

  } catch (error) {
    console.error("Buy Ticket Error:", error.message);
    res.status(500).json({ error: 'Transaction failed.' });
  }
});

module.exports = router;