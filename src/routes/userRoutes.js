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
// 2. UPDATE PROFILE (Fixed: Ensures Email exists for Upsert)
// =============================================================================
router.put('/profile', authenticateToken, async (req, res) => {
  const { full_name, profile_picture_url, username, phone_number, bio, job_title } = req.body;
  const userId = req.user.id;

  try {
    // 1. Prepare Data
    const updateData = { id: userId };
    
    if (full_name !== undefined) updateData.full_name = full_name;
    if (profile_picture_url !== undefined) updateData.profile_picture_url = profile_picture_url;
    if (username !== undefined) updateData.username = username;
    if (phone_number !== undefined) updateData.phone_number = phone_number;
    if (bio !== undefined) updateData.bio = bio;
    if (job_title !== undefined) updateData.job_title = job_title;

    // 2. SAFETY NET: Fetch Email/Name if missing
    // Since we are using upsert, we MUST have an email if a new row is created.
    // We fetch it from the Auth system (supabaseAdmin) just in case.
    const { data: userData, error: userError } = await supabaseAdmin.auth.admin.getUserById(userId);
    
    if (userData && userData.user) {
        // Ensure email is present
        updateData.email = userData.user.email;
        
        // Ensure full_name is present (if not sent in body)
        if (!updateData.full_name) {
            updateData.full_name = userData.user.user_metadata.full_name || "LifeKit User";
        }
    }

    // 3. Perform Upsert
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .upsert(updateData)
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

// =============================================================================
// DELETE PROFILE
// =============================================================================
router.delete('/profile', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    const { error: profileError } = await supabaseAdmin
      .from('profiles')
      .update({
        full_name: 'Deleted User',
        email: `deleted_${userId}@deleted.local`,
        profile_picture_url: null,
        username: null,
        phone_number: null,
        bio: null,
        job_title: null,
        status: 'deleted'
      })
      .eq('id', userId);
    if (profileError) throw profileError;

    const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (authError) throw authError;

    res.status(200).json({ message: 'Account deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// 3. GET NOTIFICATIONS (Merged & Fixed)
// =============================================================================
router.get('/notifications', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const { data: notifications, error } = await supabaseAdmin // FIXED: Use Admin
      .from('notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.status(200).json({ notifications: notifications });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
    const { data, error } = await supabaseAdmin
      .from('provider_schedules')
      .select('*')
      .eq('provider_id', providerId);

    if (error) throw error;

    res.status(200).json({ schedule: data || [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// 6. GET COUNTS (Merged & Fixed)
// =============================================================================
router.get('/counts', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    // 1. Notification Count
    const { count: notifCount, error: notifError } = await supabaseAdmin // FIXED: Use Admin
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('is_read', false);

    if (notifError) throw notifError;

    // 2. Chat Count
    // First, find active bookings I'm involved in
    const { data: myBookings } = await supabaseAdmin // FIXED: Use Admin
        .from('bookings')
        .select('id')
        .or(`client_id.eq.${userId},provider_id.eq.${userId}`)
        .not('status', 'in', '("completed","cancelled")'); 
    
    const bookingIds = myBookings ? myBookings.map(b => b.id) :[];

    let chatCount = 0;
    if (bookingIds.length > 0) {
        const { count, error: chatError } = await supabaseAdmin // FIXED: Use Admin
            .from('messages')
            .select('*', { count: 'exact', head: true })
            .in('booking_id', bookingIds)
            .neq('sender_id', userId)
            .eq('is_read', false);
        
        if (!chatError) chatCount = count;
    }

    const { count: activeBookingsCount, error: activeBookingsError } =
        await supabaseAdmin
          .from('bookings')
          .select('*', { count: 'exact', head: true })
          .or(`client_id.eq.${userId},provider_id.eq.${userId}`)
          .in('status', ['pending', 'confirmed']);

    if (activeBookingsError) throw activeBookingsError;

    // ── Lazy ghosted-escrow auto-release (48-hour rule) ───────────────────
    // Runs fire-and-forget so a failure never blocks the count response.
    (async () => {
      try {
        const now    = new Date();
        const cutoff = new Date(now.getTime() - 48 * 60 * 60 * 1000);

        // Find bookings where the provider confirmed but the client ghosted
        // and the window has elapsed.
        const { data: ghostedBookings } = await supabaseAdmin
          .from('bookings')
          .select('id, client_id, provider_id, total_price, services(title)')
          .or(`client_id.eq.${userId},provider_id.eq.${userId}`)
          .eq('provider_confirmed', true)
          .eq('client_confirmed', false)
          .in('status', ['confirmed', 'pending'])
          .lte('updated_at', cutoff.toISOString());

        if (!ghostedBookings || ghostedBookings.length === 0) return;

        for (const booking of ghostedBookings) {
          try {
            const serviceTitle = booking.services?.title || 'Service';

            // 1. Mark booking as completed
            await supabaseAdmin
              .from('bookings')
              .update({ status: 'completed', updated_at: new Date().toISOString() })
              .eq('id', booking.id);

            // 2. Transfer funds to provider's wallet (only if price > 0)
            if (parseFloat(booking.total_price) > 0) {
              const { data: providerWallet } = await supabaseAdmin
                .from('wallets')
                .select('id, balance')
                .eq('user_id', booking.provider_id)
                .single();

              if (providerWallet) {
                const newBalance =
                  parseFloat(providerWallet.balance) +
                  parseFloat(booking.total_price);
                await supabaseAdmin
                  .from('wallets')
                  .update({ balance: newBalance })
                  .eq('id', providerWallet.id);

                await supabaseAdmin.from('transactions').insert({
                  wallet_id: providerWallet.id,
                  type: 'earning',
                  amount: booking.total_price,
                  status: 'success',
                  description: `Auto-released funds for Booking #${booking.id} (client inactive 48h)`,
                });
              }
            }

            // 3. Notify both parties
            await supabaseAdmin.from('notifications').insert([
              {
                user_id: booking.provider_id,
                title: 'Funds Auto-Released 💰',
                message: `Your funds for "${serviceTitle}" were automatically released. The client did not respond within 48 hours.`,
                type: 'auto_release',
                reference_id: booking.id,
                is_read: false,
              },
              {
                user_id: booking.client_id,
                title: 'Booking Auto-Completed',
                message: `Your booking for "${serviceTitle}" was automatically marked as completed. The provider confirmed 48+ hours ago.`,
                type: 'auto_release',
                reference_id: booking.id,
                is_read: false,
              },
            ]);
          } catch (singleErr) {
            console.error(
              `Auto-release failed for booking ${booking.id}:`,
              singleErr.message
            );
          }
        }
      } catch (escrowErr) {
        console.error('Ghosted escrow check error:', escrowErr.message);
      }
    })();
    // ── End ghosted-escrow auto-release ───────────────────────────────────

    // ── Lazy proactive reminders ───────────────────────────────────────────
    // Run fire-and-forget so reminder failures never block the count response.
    (async () => {
      try {
        const now = new Date();
        const h2  = new Date(now.getTime() + 2  * 60 * 60 * 1000);
        const h24 = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        const h48 = new Date(now.getTime() + 48 * 60 * 60 * 1000);

        // Fetch all confirmed bookings for this user in the 0-48 h window.
        const { data: upcomingBookings } = await supabaseAdmin
          .from('bookings')
          .select('id, scheduled_time, client_id, provider_id, services(title)')
          .or(`client_id.eq.${userId},provider_id.eq.${userId}`)
          .eq('status', 'confirmed')
          .gte('scheduled_time', now.toISOString())
          .lte('scheduled_time', h48.toISOString());

        if (!upcomingBookings || upcomingBookings.length === 0) return;

        // Determine which reminder type each booking needs.
        const candidates = upcomingBookings.map((b) => {
          const t = new Date(b.scheduled_time);
          let type;
          if (t <= h2)        type = 'reminder_2h';
          else if (t <= h24)  type = 'reminder_24h';
          else                type = 'reminder_48h';

          const labels = {
            reminder_2h:  'Service in less than 2 hours!',
            reminder_24h: 'Service reminder: Tomorrow',
            reminder_48h: 'Upcoming service in 2 days',
          };
          return { booking: b, type, message: labels[type] };
        });

        // Check which (booking_id, type) combos already have a notification.
        const bookingIds  = candidates.map(c => c.booking.id);
        const reminderTypes = ['reminder_2h', 'reminder_24h', 'reminder_48h'];

        const { data: existing } = await supabaseAdmin
          .from('notifications')
          .select('reference_id, type')
          .in('reference_id', bookingIds)
          .in('type', reminderTypes)
          .eq('user_id', userId);

        const sentKeys = new Set(
          (existing || []).map(n => `${n.reference_id}:${n.type}`)
        );

        const toInsert = candidates
          .filter(c => !sentKeys.has(`${c.booking.id}:${c.type}`))
          .map(c => ({
            user_id:      userId,
            title:        c.type === 'reminder_2h'
                            ? '⏰ Service Starting Soon!'
                            : c.type === 'reminder_24h'
                              ? '📅 Service Tomorrow'
                              : '🗓️ Upcoming Service',
            message:      `${c.message}: "${c.booking.services?.title || 'Service'}"`,
            type:         c.type,
            reference_id: c.booking.id,
            is_read:      false,
          }));

        if (toInsert.length > 0) {
          await supabaseAdmin.from('notifications').insert(toInsert);
        }
      } catch (reminderErr) {
        console.error('Reminder nudge error:', reminderErr.message);
      }
    })();
    // ── End lazy reminders ─────────────────────────────────────────────────

    res.status(200).json({
      notifications: notifCount || 0,
      chats: chatCount || 0,
      active_bookings: activeBookingsCount || 0,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /users/notifications/read-all - Mark ALL as read
router.put('/notifications/read-all', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const { error } = await supabaseAdmin
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', userId)
      .eq('is_read', false); // Only update unread ones

    if (error) throw error;
    res.status(200).json({ message: 'All marked as read' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /users/notifications/:id - Delete a notification
router.delete('/notifications/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  try {
    const { error } = await supabaseAdmin
      .from('notifications')
      .delete()
      .eq('id', id)
      .eq('user_id', userId); // Security check

    if (error) throw error;
    res.status(200).json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// GET /users/provider-stats - Dashboard Analytics
router.get('/provider-stats', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    // 1. Get All Completed Bookings
    const { data: bookings, error } = await supabase
      .from('bookings')
      .select('total_price, created_at')
      .eq('provider_id', userId)
      .eq('status', 'completed');

    if (error) throw error;

    // 2. Calculate Totals
    let totalEarnings = 0;
    let completedJobs = bookings.length;
    
    // 3. Prepare Chart Data (Last 7 Days)
    const chartData = Array(7).fill(0); // [0, 0, 0, 0, 0, 0, 0]
    const today = new Date();
    
    bookings.forEach(b => {
      totalEarnings += parseFloat(b.total_price);

      // Check if booking was in the last 7 days
      const bookingDate = new Date(b.created_at);
      const diffTime = Math.abs(today - bookingDate);
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 

      if (diffDays <= 7) {
        // Map to array index (7 days ago = index 0, Today = index 6)
        const index = 7 - diffDays; 
        if (index >= 0) chartData[index] += parseFloat(b.total_price);
      }
    });

    // 4. Get Review Stats
    const { data: reviews } = await supabase
      .from('reviews')
      .select('rating')
      .eq('provider_id', userId);
      
    const reviewCount = reviews.length;
    const avgRating = reviewCount > 0 
        ? (reviews.reduce((a, b) => a + b.rating, 0) / reviewCount).toFixed(1) 
        : "0.0";

    // 5. Get Trial Info
    const { data: providerProfile } = await supabase
      .from('profiles')
      .select('trial_end_date')
      .eq('id', userId)
      .single();

    const trialEndDate = providerProfile?.trial_end_date || null;
    const isTrialActive = trialEndDate ? new Date(trialEndDate) > new Date() : false;
    const trialDaysLeft = isTrialActive
      ? Math.ceil((new Date(trialEndDate) - new Date()) / (1000 * 60 * 60 * 24))
      : 0;

    res.json({
      totalEarnings,
      completedJobs,
      avgRating,
      reviewCount,
      chartData, // e.g., [50, 0, 120, 30, 0, 200, 0]
      trialEndDate,
      isTrialActive,
      trialDaysLeft,
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


module.exports = router;
