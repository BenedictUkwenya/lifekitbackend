// src/routes/userRoutes.js
const express = require('express');
const router = express.Router();
// CHANGE 1: Import supabaseAdmin to bypass RLS for updates
const { supabase, supabaseAdmin } = require('../config/supabase');
const authenticateToken = require('../middleware/authMiddleware');

// =============================================================================
// 1. GET PROFILE
// =============================================================================
router.get('/profile', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') { 
        return res.status(404).json({ error: 'User profile not found.' });
      }
      console.error('Supabase fetch profile error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch user profile.' });
    }

    res.status(200).json({
      message: 'User profile fetched successfully!',
      profile: profile,
    });

  } catch (error) {
    console.error('Unexpected error fetching user profile:', error.message);
    res.status(500).json({ error: 'Internal server error fetching user profile.' });
  }
});

// =============================================================================
// 2. UPDATE PROFILE
// Fix: Uses supabaseAdmin to bypass RLS and handles all fields including job_title
// =============================================================================
// =============================================================================
// 2. UPDATE PROFILE (Fixed: Uses upsert to prevent "Cannot coerce" error)
// =============================================================================
router.put('/profile', authenticateToken, async (req, res) => {
  const { full_name, profile_picture_url, username, phone_number, bio, job_title } = req.body;
  const userId = req.user.id;

  try {
    const updateData = { id: userId };

    if (full_name !== undefined) updateData.full_name = full_name;
    if (profile_picture_url !== undefined) updateData.profile_picture_url = profile_picture_url;
    if (username !== undefined) updateData.username = username;
    if (phone_number !== undefined) updateData.phone_number = phone_number;
    if (bio !== undefined) updateData.bio = bio;
    if (job_title !== undefined) updateData.job_title = job_title;

    // --- THE FIX IS HERE ---
    // If we are about to Insert (because profile might be missing), 
    // and full_name is missing from this request, we MUST provide a fallback
    // or fetch it from auth.users metadata.
    
    // 1. Check if we have the name in the request
    if (!updateData.full_name) {
        // 2. If not, fetch the user's email/metadata to fill the gap
        const { data: userData } = await supabaseAdmin.auth.admin.getUserById(userId);
        if (userData && userData.user) {
            // Use metadata name, or email username, or just "User"
            updateData.full_name = userData.user.user_metadata.full_name || "LifeKit User";
        }
    }
    // -----------------------

    const { data, error } = await supabaseAdmin
      .from('profiles')
      .upsert(updateData)
      .select()
      .single();

    if (error) {
      console.error('Profile update error:', error.message);
      return res.status(400).json({ error: error.message });
    }

    res.status(200).json({ message: 'Success', profile: data });

  } catch (error) {
    console.error('Server error:', error.message);
    res.status(500).json({ error: error.message });
  }
});// =============================================================================
// 3. GET NOTIFICATIONS
// =============================================================================
router.get('/notifications', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    const { data: notifications, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Supabase fetch notifications error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch notifications.' });
    }

    res.status(200).json({
      message: 'Notifications fetched successfully!',
      notifications: notifications,
    });

  } catch (error) {
    console.error('Unexpected error fetching notifications:', error.message);
    res.status(500).json({ error: 'Internal server error fetching notifications.' });
  }
});

// =============================================================================
// 4. MARK NOTIFICATION AS READ
// =============================================================================
router.put('/notifications/:notificationId/read', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { notificationId } = req.params;

  try {
    const { data, error } = await supabaseAdmin // Changed to Admin to be safe
      .from('notifications')
      .update({ is_read: true })
      .eq('id', notificationId)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Notification not found.' });
      }
      return res.status(500).json({ error: error.message });
    }

    res.status(200).json({
      message: 'Notification marked as read successfully!',
      notification: data,
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// 5. ONBOARD PROVIDER
// =============================================================================
router.put('/onboard-provider', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    // Use supabaseAdmin to ensure we can write to the protected role/status fields
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .update({ is_service_provider: true })
      .eq('id', userId)
      .select()
      .single();

    if (error) {
      console.error('Supabase onboarding error:', error.message);
      return res.status(500).json({ error: 'Failed to update provider status.' });
    }

    res.status(200).json({
      message: 'Account successfully upgraded to Service Provider!',
      profile: data,
    });

  } catch (error) {
    console.error('Unexpected onboarding error:', error.message);
    res.status(500).json({ error: 'Internal server error during provider onboarding.' });
  }
});


// GET /users/schedule/:providerId
// Fetch the weekly schedule for a specific provider
router.get('/schedule/:providerId', async (req, res) => {
  const { providerId } = req.params;

  try {
    const { data, error } = await supabase
      .from('provider_schedules')
      .select('*')
      .eq('provider_id', providerId)
      .eq('is_active', true);

    if (error) throw error;

    res.status(200).json({ schedule: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /users/counts - Get unread counts for Badges
router.get('/counts', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    // 1. Count Unread Notifications
    const { count: notifCount, error: notifError } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true }) // head: true means don't return data, just count
      .eq('user_id', userId)
      .eq('is_read', false);

    if (notifError) throw notifError;

    // 2. Count Unread Chat Messages
    // (Messages where I am the receiver and is_read is false)
    // We need to join with bookings to find where I am the receiver, 
    // OR simpler: assume messages sent by others to my bookings are for me.
    // The most robust way with your current schema:
    
    // Find bookings where I am involved
    const { data: myBookings } = await supabase
        .from('bookings')
        .select('id')
        .or(`client_id.eq.${userId},provider_id.eq.${userId}`);
    
    const bookingIds = myBookings.map(b => b.id);

    let chatCount = 0;
    if (bookingIds.length > 0) {
        const { count, error: chatError } = await supabase
            .from('messages')
            .select('*', { count: 'exact', head: true })
            .in('booking_id', bookingIds)
            .neq('sender_id', userId) // Messages NOT sent by me
            .eq('is_read', false);
        
        if (!chatError) chatCount = count;
    }

    res.status(200).json({
      notifications: notifCount || 0,
      chats: chatCount || 0
    });

  } catch (error) {
    console.error('Counts Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});


module.exports = router;