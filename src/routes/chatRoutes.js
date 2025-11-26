const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const authenticateToken = require('../middleware/authMiddleware');

// 1. GET CONVERSATIONS (Grouped by User)
router.get('/', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    // Fetch all bookings involved
    const { data: bookings, error } = await supabaseAdmin
      .from('bookings')
      .select(`
        id, created_at, status, total_price,
        client_id, provider_id,
        services(title),
        client:profiles!client_id(id, full_name, profile_picture_url),
        provider:profiles!provider_id(id, full_name, profile_picture_url)
      `)
      .or(`client_id.eq.${userId},provider_id.eq.${userId}`)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // GROUP BY OTHER USER ID
    const groupedMap = new Map();

    for (const b of bookings) {
      const isClient = b.client_id === userId;
      const otherUser = isClient ? b.provider : b.client;
      
      // Safety check if profile is missing
      if (!otherUser) continue; 

      if (!groupedMap.has(otherUser.id)) {
        groupedMap.set(otherUser.id, {
          other_user: otherUser,
          bookings: [],
          last_message: '',
          last_time: b.created_at
        });
      }

      // Add booking to this user's group
      groupedMap.get(otherUser.id).bookings.push({
        id: b.id,
        service_title: b.services?.title || 'Service',
        price: b.total_price,
        status: b.status,
        date: b.created_at
      });
    }

    // Fetch last message for each group (Simplification: just checking latest booking's msg)
    // In a production app, you'd do a more complex query.
    const conversations = Array.from(groupedMap.values());

    res.json({ conversations });
  } catch (error) {
    console.error('Chat list error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 2. GET MESSAGES (For a specific USER, not just one booking)
// We pass an array of booking IDs in the query
router.post('/history', authenticateToken, async (req, res) => {
  const { booking_ids } = req.body; // Expects [uuid1, uuid2]

  try {
    const { data: messages, error } = await supabaseAdmin
      .from('messages')
      .select('*')
      .in('booking_id', booking_ids)
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.json({ messages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. SEND MESSAGE
router.post('/message', authenticateToken, async (req, res) => {
  const { booking_id, content } = req.body;
  const senderId = req.user.id;

  try {
    const { data, error } = await supabaseAdmin
      .from('messages')
      .insert({
        booking_id,
        sender_id: senderId,
        content
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ message: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;