const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase'); // Using Admin to bypass RLS
const authenticateToken = require('../middleware/authMiddleware');

const STATUS_EVENT_MESSAGES = {
  confirmed: 'Booking confirmed',
  completed: 'Service marked as completed',
  cancelled: 'Booking cancelled',
  disputed: 'Booking moved to dispute review'
};

const insertSystemStatusMessage = async (bookingId, status) => {
  const normalizedStatus = String(status || '').toLowerCase();
  const content = STATUS_EVENT_MESSAGES[normalizedStatus];
  if (!content || !bookingId) return;

  const { error } = await supabaseAdmin
    .from('messages')
    .insert({
      booking_id: bookingId,
      sender_id: 'SYSTEM',
      content,
      is_read: false
    });

  if (error) {
    throw error;
  }
};

// =============================================================================
// 1. GET /chats - Get List of Conversations (Grouped by User)
// =============================================================================
router.get('/', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    const { data: bookings, error } = await supabaseAdmin
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

    const bookingIds = (bookings || []).map((b) => b.id);
    let messages = [];

    if (bookingIds.length > 0) {
      const { data: messageRows, error: messagesError } = await supabaseAdmin
        .from('messages')
        .select('booking_id, sender_id, content, is_read, created_at')
        .in('booking_id', bookingIds)
        .order('created_at', { ascending: false });

      if (messagesError) throw messagesError;
      messages = messageRows || [];
    }

    const messagesByBooking = new Map();
    messages.forEach((message) => {
      if (!messagesByBooking.has(message.booking_id)) {
        messagesByBooking.set(message.booking_id, []);
      }
      messagesByBooking.get(message.booking_id).push(message);
    });

    const conversationsMap = new Map();
    const activeStatuses = new Set(['pending', 'confirmed', 'disputed']);

    bookings.forEach(booking => {
      let otherUser;
      if (booking.client_id === userId) {
        otherUser = booking.provider;
      } else {
        otherUser = booking.client;
      }

      if (!otherUser) return;

      const otherUserId = otherUser.id;
      const bookingMessages = messagesByBooking.get(booking.id) || [];
      const unreadForBooking = bookingMessages.filter(
        (msg) => msg.sender_id !== userId && msg.is_read === false
      ).length;
      const newestMessage = bookingMessages.length > 0 ? bookingMessages[0] : null;
      const status = String(booking.status || '').toLowerCase();

      if (!conversationsMap.has(otherUserId)) {
        conversationsMap.set(otherUserId, {
          other_user: otherUser,
          bookings: [],
          unread_count: 0,
          last_message: null,
          last_message_time: null,
          is_active: false
        });
      }

      const conversation = conversationsMap.get(otherUserId);
      conversation.bookings.push(booking);
      conversation.unread_count += unreadForBooking;
      if (activeStatuses.has(status)) {
        conversation.is_active = true;
      }

      if (newestMessage) {
        const currentLastTime = conversation.last_message_time
          ? new Date(conversation.last_message_time).getTime()
          : 0;
        const newestTime = newestMessage.created_at
          ? new Date(newestMessage.created_at).getTime()
          : 0;

        if (!conversation.last_message_time || newestTime > currentLastTime) {
          conversation.last_message = newestMessage.content || '';
          conversation.last_message_time = newestMessage.created_at;
        }
      }
    });

    const conversations = Array.from(conversationsMap.values());

    res.status(200).json({ conversations });

  } catch (error) {
    console.error('Chat list error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// 2. PUT /chats/:bookingId/read - Mark conversation messages as read
// =============================================================================
router.put('/:bookingId/read', authenticateToken, async (req, res) => {
  const { bookingId } = req.params;
  const userId = req.user.id;

  try {
    const { data: booking, error: bookingError } = await supabaseAdmin
      .from('bookings')
      .select('id, client_id, provider_id')
      .eq('id', bookingId)
      .maybeSingle();

    if (bookingError) throw bookingError;
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    if (booking.client_id !== userId && booking.provider_id !== userId) {
      return res.status(403).json({ error: 'Unauthorized access to this conversation' });
    }

    const { error: updateError } = await supabaseAdmin
      .from('messages')
      .update({ is_read: true })
      .eq('booking_id', bookingId)
      .neq('sender_id', userId)
      .eq('is_read', false);

    if (updateError) throw updateError;

    res.status(200).json({ message: 'Messages marked as read' });
  } catch (error) {
    console.error('Mark chat as read error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// 3. GET /chats/:bookingId - Get Messages for a specific Booking
// =============================================================================
router.get('/:bookingId', authenticateToken, async (req, res) => {
  const { bookingId } = req.params;

  try {
    const { data: messages, error } = await supabaseAdmin
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
// 4. POST /chats/message - Send Message & Notify (With Status Check)
// =============================================================================
router.post('/message', authenticateToken, async (req, res) => {
  const { booking_id, content } = req.body;
  const senderId = req.user.id;

  try {
    // 1. Fetch Booking Status & Details
    const { data: booking, error: bookingError } = await supabaseAdmin
      .from('bookings')
      .select('status, client_id, provider_id, services(title)')
      .eq('id', booking_id)
      .single();

    if (bookingError || !booking) return res.status(404).json({ error: "Booking not found" });

    // 2. SECURITY CHECK: Is the booking active?
    // Prevent messaging if the service is already finished or cancelled
    if (booking.status === 'completed' || booking.status === 'cancelled') {
      return res.status(403).json({ error: "This conversation is closed because the service is finished." });
    }

    // 3. Determine Receiver
    const receiverId = (senderId === booking.client_id) ? booking.provider_id : booking.client_id;

    // 4. Insert Message
    const { error: msgError } = await supabaseAdmin
      .from('messages')
      .insert({
        booking_id,
        sender_id: senderId,
        content,
        is_read: false
      });

    if (msgError) throw msgError;

    // 5. Notify Receiver
    await supabaseAdmin.from('notifications').insert({
      user_id: receiverId,
      title: 'New Message 💬',
      message: `Regarding ${booking.services?.title || 'Service'}: "${content.substring(0, 30)}..."`,
      type: 'chat_message',
      reference_id: booking_id,
      is_read: false
    });

    // 6. Update Booking Timestamp (to bubble conversation to top)
    await supabaseAdmin.from('bookings').update({ updated_at: new Date() }).eq('id', booking_id);

    res.status(201).json({ message: "Sent" });

  } catch (error) {
    console.error("Chat Error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.insertSystemStatusMessage = insertSystemStatusMessage;
module.exports = router;
