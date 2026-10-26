const express = require('express');
const router = express.Router();
const { supabase, supabaseAdmin } = require('../config/supabase');
const authenticateToken = require('../middleware/authMiddleware');
const chatRoutes = require('./chatRoutes');
const { t, getUserLang } = require('../utils/translate');
const { notifyUser, notifyUsers } = require('../services/notificationService');

const isBookingOverdue = (booking, now = new Date()) => {
  const normalizedStatus = String(booking?.status || '').toLowerCase();
  if (normalizedStatus !== 'confirmed' || !booking?.scheduled_time) return false;

  const scheduledAt = new Date(booking.scheduled_time);
  if (Number.isNaN(scheduledAt.getTime())) return false;

  return scheduledAt.getTime() < now.getTime();
};

const appendVirtualOverdueStatus = (bookings = [], now = new Date()) =>
  bookings.map((booking) => ({
    ...booking,
    is_overdue: isBookingOverdue(booking, now)
  }));

const sendOverdueNudgesIfNeeded = async (bookings = []) => {
  const overdueBookings = bookings.filter((booking) => booking.is_overdue);
  if (overdueBookings.length === 0) return;

  const overdueBookingIds = overdueBookings.map((booking) => booking.id);
  const { data: existingNotifications, error: existingNotificationsError } = await supabaseAdmin
    .from('notifications')
    .select('reference_id, user_id')
    .eq('type', 'booking_overdue_nudge')
    .in('reference_id', overdueBookingIds);

  if (existingNotificationsError) {
    throw existingNotificationsError;
  }

  const sentNotificationKeys = new Set(
    (existingNotifications || []).map(
      (notification) => `${notification.reference_id}:${notification.user_id}`
    )
  );

  const userIds = new Set();
  overdueBookings.forEach((booking) => {
    userIds.add(booking.provider_id);
    userIds.add(booking.client_id);
  });

  const { data: profiles } = await supabaseAdmin
    .from('profiles')
    .select('id, language')
    .in('id', [...userIds]);

  const langMap = {};
  (profiles || []).forEach((p) => {
    langMap[p.id] = getUserLang(p);
  });

  for (const booking of overdueBookings) {
    const serviceTitle = booking?.services?.title || 'Service';
    const providerKey = `${booking.id}:${booking.provider_id}`;
    const clientKey = `${booking.id}:${booking.client_id}`;

    if (!sentNotificationKeys.has(providerKey)) {
      const lang = langMap[booking.provider_id] || 'en';
      await notifyUser({
        userId: booking.provider_id,
        title: t('notifications.bookingOverdue.titleProvider', lang),
        message: t('notifications.bookingOverdue.messageProvider', lang, { service: serviceTitle }),
        type: 'booking_overdue_nudge',
        referenceId: booking.id,
      });
    }

    if (!sentNotificationKeys.has(clientKey)) {
      const lang = langMap[booking.client_id] || 'en';
      await notifyUser({
        userId: booking.client_id,
        title: t('notifications.bookingOverdue.titleClient', lang),
        message: t('notifications.bookingOverdue.messageClient', lang, { service: serviceTitle }),
        type: 'booking_overdue_nudge',
        referenceId: booking.id,
      });
    }
  }
};

// Base route: /bookings

/**
 * 1. POST /bookings - Client creates a new booking request
 * Logic: Check Balance -> Deduct Money (Hold) -> Create Booking -> Notify Provider
 */
/**
 * True when `total` is a price the client could legitimately compute for
 * this service: fixed price, hourly price × 1–24h, or the sum of any subset
 * of the service's options — times a cart quantity of 1–20.
 */
function isValidServiceTotal(service, total) {
  const base = Number(service.price) || 0;
  const options = (Array.isArray(service.service_options) ? service.service_options : [])
    .map((o) => Number(o?.price) || 0)
    .slice(0, 12); // bounds the subset enumeration (4096 sums max)

  const units = new Set();
  if (options.length > 0) {
    for (let mask = 1; mask < (1 << options.length); mask++) {
      let sum = 0;
      options.forEach((p, i) => { if (mask & (1 << i)) sum += p; });
      units.add(Math.round(sum * 100));
    }
  } else if (service.pricing_type === 'hourly') {
    for (let h = 1; h <= 24; h++) units.add(Math.round(base * h * 100));
  } else {
    units.add(Math.round(base * 100));
  }

  const cents = Math.round(total * 100);
  for (const unit of units) {
    if (unit === 0 ? cents === 0 : cents % unit === 0 && cents / unit >= 1 && cents / unit <= 20) {
      return true;
    }
  }
  return false;
}

router.post('/', authenticateToken, async (req, res) => {
  const { service_id, scheduled_time, location_details, service_type, comments } = req.body;
  // Re-assigned below to the server-validated amount (also used by the rollback)
  let { total_price } = req.body;
  const clientId = req.user.id;

  if (!service_id || !scheduled_time || total_price === undefined) {
    return res.status(400).json({ error: 'Service ID, scheduled time, and price are required.' });
  }

  let walletId = null;
  let deducted = false;

  try {
    const { data: service, error: serviceError } = await supabaseAdmin 
      .from('services')
      .select('provider_id, price, title, pricing_type, service_options')
      .eq('id', service_id)
      .single();

    if (serviceError || !service) {
      return res.status(404).json({ error: 'Service not found.' });
    }

    // Never trust the client's amount — negative or free-form values would
    // let a client credit their own wallet. It must match a price this
    // service can actually produce (see CartProvider.calculateServiceTotal).
    const claimed = Number(total_price);
    if (!Number.isFinite(claimed) || claimed < 0 || !isValidServiceTotal(service, claimed)) {
      return res.status(400).json({ error: 'Price does not match the service. Please refresh and try again.' });
    }
    const price = Math.round(claimed * 100) / 100;
    total_price = price;

    const { data: clientWallet, error: walletFetchError } = await supabaseAdmin
      .from('wallets')
      .select('id, balance')
      .eq('user_id', clientId)
      .single();

    if (walletFetchError || !clientWallet || parseFloat(clientWallet.balance) < price) {
      return res.status(402).json({ error: 'Insufficient wallet balance.' });
    }

    walletId = clientWallet.id;
    const newBalance = parseFloat(clientWallet.balance) - price;
    
    const { error: walletUpdateError } = await supabaseAdmin
      .from('wallets')
      .update({ balance: newBalance })
      .eq('id', walletId);

    if (walletUpdateError) throw new Error('Failed to deduct funds.');
    deducted = true;

    await supabaseAdmin.from('transactions').insert({
      wallet_id: walletId,
      type: 'hold',
      amount: total_price,
      status: 'success',
      description: `Funds held for booking service: ${service.title}`
    });

    const { data: booking, error: bookingError } = await supabaseAdmin
      .from('bookings')
      .insert({
        client_id: clientId,
        provider_id: service.provider_id,
        service_id,
        scheduled_time,
        location_details,
        total_price,
        service_type,
        comments,
        status: 'pending',
        client_confirmed: false, 
        provider_confirmed: false 
      })
      .select()
      .single();

    if (bookingError) {
      console.error('Booking insert failed:', bookingError);
      throw new Error('Failed to create booking record.');
    }

    const { data: providerProfile } = await supabaseAdmin
      .from('profiles')
      .select('language')
      .eq('id', service.provider_id)
      .maybeSingle();
    const providerLang = getUserLang(providerProfile);
    const isSwap = parseFloat(total_price) === 0;

    await notifyUser({
      userId: service.provider_id,
      title: isSwap
        ? t('notifications.bookingRequest.titleSwap', providerLang)
        : t('notifications.bookingRequest.title', providerLang),
      message: t('notifications.bookingRequest.message', providerLang, { service: service.title }),
      type: 'booking_request',
      referenceId: booking.id,
    });

    res.status(201).json({ message: 'Booking request sent.', booking });

  } catch (error) {
    console.error('Booking flow error:', error.message);
    
    if (deducted && walletId) {
      try {
        const { data: w } = await supabaseAdmin.from('wallets').select('balance').eq('id', walletId).single();
        await supabaseAdmin.from('wallets').update({ balance: parseFloat(w.balance) + parseFloat(total_price) }).eq('id', walletId);
        await supabaseAdmin.from('transactions').insert({
          wallet_id: walletId,
          type: 'refund',
          amount: total_price,
          status: 'success',
          description: 'Automatic rollback refund'
        });
      } catch (rollbackError) {
        console.error('Critical: Rollback failed', rollbackError);
      }
    }
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * 1.5 POST /bookings/:id/dispute - Open a dispute
 */
router.post('/:id/dispute', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  const userId = req.user.id;

  if (!reason) {
    return res.status(400).json({ error: 'Reason is required.' });
  }

  try {
    const { data: booking, error: bookingError } = await supabaseAdmin
      .from('bookings')
      .select('*')
      .eq('id', id)
      .single();

    if (bookingError || !booking) {
      return res.status(404).json({ error: 'Booking not found.' });
    }

    if (booking.client_id !== userId && booking.provider_id !== userId) {
      return res.status(403).json({ error: 'Unauthorized action.' });
    }

    const { data: existingDisputes } = await supabaseAdmin
      .from('disputes')
      .select('id')
      .eq('booking_id', id)
      .eq('status', 'open')
      .limit(1);

    if (existingDisputes && existingDisputes.length > 0) {
      return res.status(400).json({ error: 'An open dispute already exists.' });
    }

    const { error: updateError } = await supabaseAdmin
      .from('bookings')
      .update({ status: 'disputed' })
      .eq('id', id);

    if (updateError) {
      return res.status(500).json({ error: 'Failed to update booking status.' });
    }

    await chatRoutes.insertSystemStatusMessage(id, 'disputed');

    const { data: dispute, error: disputeError } = await supabaseAdmin
      .from('disputes')
      .insert({
        booking_id: id,
        initiator_id: userId,
        reason,
        status: 'open'
      })
      .select()
      .single();

    if (disputeError) {
      return res.status(500).json({ error: 'Failed to create dispute.' });
    }

    const otherUserId =
      booking.client_id === userId ? booking.provider_id : booking.client_id;

    const { data: otherProfile } = await supabaseAdmin
      .from('profiles')
      .select('language')
      .eq('id', otherUserId)
      .maybeSingle();
    const otherLang = getUserLang(otherProfile);

    await notifyUser({
      userId: otherUserId,
      title: t('notifications.bookingDispute.title', otherLang),
      message: t('notifications.bookingDispute.message', otherLang),
      type: 'booking_dispute',
      referenceId: id,
    });

    res.status(201).json({ message: 'Dispute opened.', dispute });
  } catch (error) {
    console.error('Dispute error:', error.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * 2. PUT /bookings/:id/status - Provider Accepts or Rejects
 * Logic: If Cancelled/Rejected -> REFUND THE CLIENT
 */
router.put('/:id/status', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const providerId = req.user.id;

  if (!['confirmed', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }

  try {
    const { data: booking } = await supabaseAdmin
      .from('bookings')
      .select('*')
      .eq('id', id)
      .eq('provider_id', providerId)
      .single();

    if (!booking) return res.status(404).json({ error: 'Booking not found or unauthorized.' });

    const { data: updatedBooking, error } = await supabaseAdmin
      .from('bookings')
      .update({ status: status })
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: 'Failed to update status.' });

    await chatRoutes.insertSystemStatusMessage(id, status);

    const { data: clientProfile } = await supabaseAdmin
      .from('profiles')
      .select('language')
      .eq('id', booking.client_id)
      .maybeSingle();
    const clientLang = getUserLang(clientProfile);

    if (status === 'cancelled') {
        const { data: clientWallet } = await supabaseAdmin.from('wallets').select('*').eq('user_id', booking.client_id).single();
        const refundBalance = parseFloat(clientWallet.balance) + parseFloat(booking.total_price);
        await supabaseAdmin.from('wallets').update({ balance: refundBalance }).eq('id', clientWallet.id);

        await supabaseAdmin.from('transactions').insert({
            wallet_id: clientWallet.id,
            type: 'refund',
            amount: booking.total_price,
            status: 'success',
            description: `Refund for Booking #${booking.id}`
        });

        await notifyUser({
            userId: booking.client_id,
            title: t('notifications.bookingUpdateDeclined.title', clientLang),
            message: t('notifications.bookingUpdateDeclined.message', clientLang),
            type: 'booking_update',
            referenceId: id,
        });
    } else {
        await notifyUser({
            userId: booking.client_id,
            title: t('notifications.bookingUpdateConfirmed.title', clientLang),
            message: t('notifications.bookingUpdateConfirmed.message', clientLang),
            type: 'booking_update',
            referenceId: id,
        });
    }

    res.status(200).json({ message: `Booking ${status}`, booking: updatedBooking });

  } catch (error) {
    console.error('Status update error:', error.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * 3. PUT /bookings/:id/complete - DUAL CONFIRMATION
 */
router.put('/:id/complete', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  try {
    const { data: booking } = await supabaseAdmin.from('bookings').select('*').eq('id', id).single();
    if (!booking) return res.status(404).json({ error: 'Booking not found.' });

    let updateData = {};
    // updated_at is stamped here so the 48-hour ghosted-escrow timer starts
    // the moment a party confirms (not when the booking was originally created).
    if (userId === booking.client_id) {
      updateData = { client_confirmed: true, updated_at: new Date().toISOString() };
    } else if (userId === booking.provider_id) {
      updateData = { provider_confirmed: true, updated_at: new Date().toISOString() };
    } else {
      return res.status(403).json({ error: 'Unauthorized action.' });
    }

    const { data: updatedBooking } = await supabaseAdmin
      .from('bookings')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (updatedBooking.client_confirmed && updatedBooking.provider_confirmed) {
        await supabaseAdmin.from('bookings').update({ status: 'completed' }).eq('id', id);
        await chatRoutes.insertSystemStatusMessage(id, 'completed');

        if (booking.total_price > 0) {
            // Fetch provider's trial status to determine commission rate
            const { data: providerProfile } = await supabaseAdmin
                .from('profiles')
                .select('trial_end_date')
                .eq('id', booking.provider_id)
                .single();

            const isTrialActive = providerProfile?.trial_end_date &&
                new Date(providerProfile.trial_end_date) > new Date();
            const commissionRate = isTrialActive ? 0.03 : 0.08;
            const earnings = parseFloat((parseFloat(booking.total_price) * (1 - commissionRate)).toFixed(2));

            const { data: providerWallet } = await supabaseAdmin.from('wallets').select('*').eq('user_id', booking.provider_id).single();
            const newBalance = parseFloat(providerWallet.balance) + earnings;
            await supabaseAdmin.from('wallets').update({ balance: newBalance }).eq('id', providerWallet.id);
            
            await supabaseAdmin.from('transactions').insert({
                wallet_id: providerWallet.id,
                type: 'earning',
                amount: earnings,
                status: 'success',
                description: `Earning from Booking #${id} (Commission: ${commissionRate * 100}%)`
            });
        }

        const { data: partyProfiles } = await supabaseAdmin
          .from('profiles')
          .select('id, language')
          .in('id', [booking.client_id, booking.provider_id]);

        const langMap = {};
        (partyProfiles || []).forEach((p) => {
          langMap[p.id] = getUserLang(p);
        });

        await notifyUsers([
            {
              userId: booking.client_id,
              title: t('notifications.bookingCompleted.titleClient', langMap[booking.client_id] || 'en'),
              message: t('notifications.bookingCompleted.messageClient', langMap[booking.client_id] || 'en'),
              type: 'booking_completed',
              referenceId: id,
            },
            {
              userId: booking.provider_id,
              title: t('notifications.bookingCompleted.titleProvider', langMap[booking.provider_id] || 'en'),
              message: t('notifications.bookingCompleted.messageProvider', langMap[booking.provider_id] || 'en'),
              type: 'booking_completed',
              referenceId: id,
            },
        ]);

        return res.json({ message: 'Booking fully completed. Funds released.', status: 'completed' });
    }

    res.json({ message: 'Confirmation recorded. Waiting for the other party.', status: 'waiting_other' });

  } catch (error) {
    console.error('Completion error:', error.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * Standard Getters
 */

router.get('/client', authenticateToken, async (req, res) => {
  const clientId = req.user.id;
  try {
    const { data: bookings, error } = await supabaseAdmin 
      .from('bookings')
      .select('*, services(title, image_urls), profiles!provider_id(id, full_name, profile_picture_url)')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });

    if (error) return res.status(400).json({ error: error.message });

    const now = new Date();
    const bookingsWithOverdueStatus = appendVirtualOverdueStatus(bookings || [], now);

    try {
      await sendOverdueNudgesIfNeeded(bookingsWithOverdueStatus);
    } catch (nudgeError) {
      console.error('Overdue nudge error:', nudgeError.message);
    }

    res.status(200).json({ bookings: bookingsWithOverdueStatus });
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

router.get('/provider', authenticateToken, async (req, res) => {
  const providerId = req.user.id;
  try {
    const { data: requests, error } = await supabaseAdmin 
      .from('bookings')
      .select('*, services(title, image_urls), profiles!client_id(id, full_name, profile_picture_url)')
      .eq('provider_id', providerId)
      .order('created_at', { ascending: false });

    if (error) return res.status(400).json({ error: error.message });

    const now = new Date();
    const requestsWithOverdueStatus = appendVirtualOverdueStatus(requests || [], now);

    try {
      await sendOverdueNudgesIfNeeded(requestsWithOverdueStatus);
    } catch (nudgeError) {
      console.error('Overdue nudge error:', nudgeError.message);
    }

    res.status(200).json({ requests: requestsWithOverdueStatus });
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

router.get('/availability/:providerId', async (req, res) => {
  res.json({ message: "Availability endpoint placeholder" }); 
});

router.get('/bookings/all', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('bookings')
      .select(`
        *,
        profiles!client_id(full_name, id, profile_picture_url),
        services(
            title, 
            price, 
            currency,
            service_categories(name), 
            profiles:provider_id(full_name, profile_picture_url)
        )
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /bookings/provider-schedule/:providerId
router.get('/provider-schedule/:providerId', async (req, res) => {
  const { providerId } = req.params;
  try {
    const { data: bookings, error } = await supabaseAdmin
      .from('bookings')
      .select('scheduled_time, status, duration_hours, pricing_type')
      .eq('provider_id', providerId)
      .in('status', ['confirmed', 'pending']); 

    if (error) throw error;

    const blockedSlots = bookings.map(b => {
      const start = new Date(b.scheduled_time);

      if (b.pricing_type === 'hourly') {
        // Block only the booked hours
        const end = new Date(start);
        end.setHours(end.getHours() + (b.duration_hours || 1));
        return {
          day: start.toISOString().split('T')[0],
          start_time: start.toTimeString().slice(0, 5),
          end_time: end.toTimeString().slice(0, 5),
          blocked: false
        };
      } else {
        // Fixed-price → block the entire day
        return {
          day: start.toISOString().split('T')[0],
          blocked: true
        };
      }
    });

    res.status(200).json({ schedule: blockedSlots });
  } catch (error) {
    console.error('Provider schedule error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /bookings/:id - Get a single booking by ID (must be client or provider)
 * NOTE: Must be defined AFTER all specific named routes to avoid shadowing /client, /provider etc.
 */
router.get('/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  try {
    const { data: booking, error } = await supabaseAdmin
      .from('bookings')
      .select('*, services(title, image_urls), profiles!provider_id(id, full_name, profile_picture_url)')
      .eq('id', id)
      .or(`client_id.eq.${userId},provider_id.eq.${userId}`)
      .single();
    if (error || !booking) return res.status(404).json({ error: 'Booking not found.' });
    return res.json({ booking });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch booking.' });
  }
});

module.exports = router;
module.exports.isValidServiceTotal = isValidServiceTotal;
