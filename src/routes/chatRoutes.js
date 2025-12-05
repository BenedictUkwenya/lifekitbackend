const express = require('express');
const router = express.Router();
const { supabase, supabaseAdmin } = require('../config/supabase');
const authenticateToken = require('../middleware/authMiddleware');

// 1. GET Conversations (No change)
router.get('/', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    // Fetch distinct bookings where user is participant
    const { data, error } = await supabase
      .from('bookings')
      .select('*, services(title, image_urls), profiles!client_id(full_name, profile_picture_url), profiles!provider_id(full_name, profile_picture_url)')
      .or(`client_id.eq.${userId},provider_id.eq.${userId}`)
      .order('updated_at', { ascending: false });

    if (error) throw error;
    res.json({ conversations: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. GET Messages (No change)// 1. GET Conversations
router.get('/', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    // Fetch distinct bookings where user is participant
    const { data, error } = await supabase
      .from('bookings')
      .select(`
        *, 
        services(title, image_urls), 
        client:profiles!client_id(full_name, profile_picture_url), 
        provider:profiles!provider_id(full_name, profile_picture_url)
      `)
      .or(`client_id.eq.${userId},provider_id.eq.${userId}`)
      .order('updated_at', { ascending: false });

    if (error) throw error;
    res.json({ conversations: data });
  } catch (error) {
    console.error("Fetch Chats Error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// 3. POST Message (CRITICAL UPDATE: Adds Notification)
router.post('/message', authenticateToken, async (req, res) => {
  const { booking_id, content } = req.body;
  const senderId = req.user.id;

  try {
    // A. Fetch Booking to identify Receiver
    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .select('client_id, provider_id, services(title)')
      .eq('id', booking_id)
      .single();

    if (bookingError || !booking) return res.status(404).json({ error: "Booking not found" });

    // B. Determine Receiver
    // If Sender is Client, Receiver is Provider. Otherwise, Receiver is Client.
    const receiverId = (senderId === booking.client_id) ? booking.provider_id : booking.client_id;

    // C. Insert Message
    const { error: msgError } = await supabase
      .from('messages')
      .insert({
        booking_id,
        sender_id: senderId,
        content,
        is_read: false
      });

    if (msgError) throw msgError;

    // D. TRIGGER NOTIFICATION (The New Part)
    // We use supabaseAdmin to bypass any RLS policies on notifications table
    await supabaseAdmin.from('notifications').insert({
      user_id: receiverId, // Target the other person
      title: 'New Message 💬',
      message: `New message regarding ${booking.services?.title}: "${content.substring(0, 30)}..."`,
      type: 'chat_message',
      reference_id: booking_id, // Clicking notification opens this chat
      is_read: false
    });

    // E. Update Booking 'updated_at' to bump it to top of list
    await supabaseAdmin.from('bookings').update({ updated_at: new Date() }).eq('id', booking_id);

    res.status(201).json({ message: "Sent" });

  } catch (error) {
    console.error("Chat Error:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;