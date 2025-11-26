// src/routes/userRoutes.js
const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const authenticateToken = require('../middleware/authMiddleware');

// Get User Profile (Authenticated)
router.put('/profile', authenticateToken, async (req, res) => {
  // Add username, phone_number, bio to the destructuring
  const { full_name, profile_picture_url, username, phone_number, bio } = req.body;
  const userId = req.user.id;

  try {
    const updateData = {};
    if (full_name !== undefined) updateData.full_name = full_name;
    if (profile_picture_url !== undefined) updateData.profile_picture_url = profile_picture_url;
    // New Fields
    if (username !== undefined) updateData.username = username;
    if (phone_number !== undefined) updateData.phone_number = phone_number;
    if (bio !== undefined) updateData.bio = bio;

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ message: 'No profile data provided for update.' });
    }

    const { data, error } = await supabase
      .from('profiles')
      .update(updateData)
      .eq('id', userId)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(200).json({
      message: 'Profile updated successfully!',
      profile: data,
    });

  } catch (error) {
    console.error('Unexpected profile update error:', error.message);
    res.status(500).json({ error: 'Internal server error during profile update.' });
  }
});
// Update User Profile (Authenticated)
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
// 2. UPDATE PROFILE (Includes new fields: username, phone, bio)
// =============================================================================
router.put('/profile', authenticateToken, async (req, res) => {
  const { full_name, profile_picture_url, username, phone_number, bio } = req.body;
  const userId = req.user.id;

  if (!userId) {
    return res.status(401).json({ error: 'User not authenticated.' });
  }

  try {
    const updateData = {};
    if (full_name !== undefined) updateData.full_name = full_name;
    if (profile_picture_url !== undefined) updateData.profile_picture_url = profile_picture_url;
    if (username !== undefined) updateData.username = username;
    if (phone_number !== undefined) updateData.phone_number = phone_number;
    if (bio !== undefined) updateData.bio = bio;

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ message: 'No profile data provided for update.' });
    }

    const { data, error } = await supabase
      .from('profiles')
      .update(updateData)
      .eq('id', userId)
      .select()
      .single();

    if (error) {
      console.error('Supabase profile update error:', error.message);
      return res.status(400).json({ error: error.message });
    }

    res.status(200).json({
      message: 'Profile updated successfully!',
      profile: data,
    });

  } catch (error) {
    console.error('Unexpected profile update error:', error.message);
    res.status(500).json({ error: 'Internal server error during profile update.' });
  }
});
// Get User Notifications (Authenticated)
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

// Mark Notification as Read (Authenticated)
router.put('/notifications/:notificationId/read', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { notificationId } = req.params;

  try {
    const { data, error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('id', notificationId)
      .eq('user_id', userId) // Ensure user can only mark their own notifications as read
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') { // No rows found or not owned by user
        return res.status(404).json({ error: 'Notification not found or not owned by user.' });
      }
      console.error('Supabase mark notification read error:', error.message);
      return res.status(500).json({ error: 'Failed to mark notification as read.' });
    }

    res.status(200).json({
      message: 'Notification marked as read successfully!',
      notification: data,
    });

  } catch (error) {
    console.error('Unexpected error marking notification as read:', error.message);
    res.status(500).json({ error: 'Internal server error marking notification as read.' });
  }
});

// src/routes/userRoutes.js (Add this new route)

/**
 * 3. PUT /users/onboard-provider - Mark user as a Service Provider
 * Screen: "Change account setup"
 */
router.put('/onboard-provider', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    // 1. Update the is_service_provider flag in the profiles table
    const { data, error } = await supabase
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

module.exports = router;