const express = require('express');
const router = express.Router();
const { supabase, supabaseAdmin } = require('../config/supabase'); // Ensure supabaseAdmin is imported
const authenticateToken = require('../middleware/authMiddleware');

// =============================================================================
// 1. GET /chats - Get List of Conversations (Grouped by User)
// =============================================================================
router.get('/', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    // 1. Fetch all bookings involving the user
    // We use explicit aliases (client:profiles!client_id) to avoid the "table specified more than once" error
    const { data: bookings, error } = await supabase
      .from('bookings')
      .select(`
        *,
        services (id, title, image_urls),
        client:profiles!client_id (id, full_name, profile_picture_url),
        provider:profiles!provider_id (id, full_name, profile_picture_url)
      `)
      .or(`client_id.eq.${userId},provider_id.eq.${userId}`)
      .order('updated_at', { ascending: false }); // Ensure recently active chats come first

    if (error) throw error;

    // 2. GROUPING LOGIC (This was missing!)
    // We group bookings by the "Other User" to create a conversation list.
    const conversationsMap = new Map();

    bookings.forEach(booking => {
      // Determine who the "Other User" is
      let otherUser;
      if (booking.client_id === userId) {
        otherUser = booking.provider; // I am client -> chat is with provider
      } else {
        otherUser = booking.client;   // I am provider -> chat is with client
      }

      if (!otherUser) return; // Skip if profile missing

      const otherUserId = otherUser.id;

      // Initialize conversation entry if not exists
      if (!conversationsMap.has(otherUserId)) {
        conversationsMap.set(otherUserId, {
          other_user: otherUser,
          bookings: []
        });
      }

      // Add this booking to the specific user's conversation list
      conversationsMap.get(otherUserId).bookings.push(booking);
    });

    // Convert Map to Array
    const conversations = Array.from(conversationsMap.values());

    res.status(200).json({ conversations });

  } catch (error) {
    console.error('Chat list error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// 2. GET /chats/:bookingId - Get Messages for a specific Booking
// =============================================================================
router.get('/:bookingId', authenticateToken, async (req, res) => {
  const { bookingId } = req.params;

  try {
    const { data: messages, error } = await supabase
      .from('messages')
      .select('*')
      .eq('booking_id', bookingId)
      .order('created_at', { ascending: true });

    if (error) throw error;

    res.status(200).json({ messages });

  } catch (error) {
    console.error('Fetch messages error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// 3. POST /chats/message - Send Message & Notify
// =============================================================================
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

    // D. TRIGGER NOTIFICATION
    await supabaseAdmin.from('notifications').insert({
      user_id: receiverId,
      title: 'New Message 💬',
      message: `Regarding ${booking.services?.title || 'Service'}: "${content.substring(0, 30)}..."`,
      type: 'chat_message',
      reference_id: booking_id,
      is_read: false
    });

    // E. Update Booking timestamp to bump to top
    await supabaseAdmin.from('bookings').update({ updated_at: new Date() }).eq('id', booking_id);

    res.status(201).json({ message: "Sent" });

  } catch (error) {
    console.error("Chat Error:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;