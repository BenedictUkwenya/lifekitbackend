const express = require('express');
const router = express.Router();
const { supabase, supabaseAdmin } = require('../config/supabase');
const authenticateToken = require('../middleware/authMiddleware');

// Base route: /bookings

/**
 * 1. POST /bookings - Client creates a new booking request
 * Logic: Check Balance -> Deduct Money (Hold) -> Create Booking -> Notify Provider
 */
router.post('/', authenticateToken, async (req, res) => {
  // 1. Added service_type and comments to destructuring
  const { service_id, scheduled_time, location_details, total_price, service_type, comments } = req.body;
  const clientId = req.user.id;

  if (!service_id || !scheduled_time || total_price === undefined) {
    return res.status(400).json({ error: 'Service ID, scheduled time, and price are required.' });
  }

  try {
    // 2. Verify Service & Get Provider ID
    const { data: service, error: serviceError } = await supabaseAdmin 
      .from('services')
      .select('provider_id, price, title') 
      .eq('id', service_id)
      .single();

    if (serviceError || !service) {
      return res.status(404).json({ error: 'Service not found or not currently active.' });
    }

    // 3. Check Client Wallet Balance
    const { data: clientWallet } = await supabaseAdmin
      .from('wallets')
      .select('*')
      .eq('user_id', clientId)
      .single();

    if (!clientWallet || parseFloat(clientWallet.balance) < parseFloat(total_price)) {
      return res.status(402).json({ error: 'Insufficient wallet balance. Please add money.' });
    }

    // 4. DEDUCT MONEY (Hold Funds)
    const newBalance = parseFloat(clientWallet.balance) - parseFloat(total_price);
    
    const { error: walletError } = await supabaseAdmin
      .from('wallets')
      .update({ balance: newBalance })
      .eq('id', clientWallet.id);

    if (walletError) return res.status(500).json({ error: 'Payment processing failed.' });

    // 5. Create Booking (Including the new service_type and comments fields)
    const { data: booking, error: bookingError } = await supabaseAdmin
      .from('bookings')
      .insert({
        client_id: clientId,
        provider_id: service.provider_id,
        service_id,
        scheduled_time,
        location_details,
        total_price,
        service_type, // <--- New field added
        comments,     // <--- New field added
        status: 'pending',
        client_confirmed: false, 
        provider_confirmed: false 
      })
      .select()
      .single();

    if (bookingError) {
      // Refund logic if booking fails
      const refundBalance = parseFloat(clientWallet.balance); // total_price was already deducted
      await supabaseAdmin.from('wallets').update({ balance: refundBalance }).eq('id', clientWallet.id);
      return res.status(500).json({ error: 'Failed to create booking.' });
    }

    // 6. NOTIFY THE PROVIDER
    const isSkillSwap = parseFloat(total_price) === 0;

    await supabaseAdmin.from('notifications').insert({
      user_id: service.provider_id,
      title: isSkillSwap ? 'New Skill Swap Request 🔄' : 'New Booking Request 📅',
      message: isSkillSwap 
        ? `Someone wants to swap skills with you for "${service.title}". Check requests!` 
        : `Someone wants to book "${service.title}" for $${total_price}.`,
      type: 'booking_request', 
      reference_id: booking.id,
      is_read: false
    });

    res.status(201).json({ message: 'Booking request sent and funds held successfully.', booking });

  } catch (error) {
    console.error('Unexpected booking error:', error.message);
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

        await supabaseAdmin.from('notifications').insert({
            user_id: booking.client_id,
            title: 'Booking Declined',
            message: 'The provider declined. Your funds have been refunded.',
            type: 'booking_update',
            reference_id: id
        });
    } else {
        await supabaseAdmin.from('notifications').insert({
            user_id: booking.client_id,
            title: 'Booking Confirmed!',
            message: 'Your provider has accepted the booking.',
            type: 'booking_update',
            reference_id: id
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
    if (userId === booking.client_id) updateData = { client_confirmed: true };
    else if (userId === booking.provider_id) updateData = { provider_confirmed: true };
    else return res.status(403).json({ error: 'Unauthorized action.' });

    const { data: updatedBooking } = await supabaseAdmin
      .from('bookings')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (updatedBooking.client_confirmed && updatedBooking.provider_confirmed) {
        await supabaseAdmin.from('bookings').update({ status: 'completed' }).eq('id', id);

        if (booking.total_price > 0) {
            const { data: providerWallet } = await supabaseAdmin.from('wallets').select('*').eq('user_id', booking.provider_id).single();
            const newBalance = parseFloat(providerWallet.balance) + parseFloat(booking.total_price);
            await supabaseAdmin.from('wallets').update({ balance: newBalance }).eq('id', providerWallet.id);
            
            await supabaseAdmin.from('transactions').insert({
                wallet_id: providerWallet.id,
                type: 'earning',
                amount: booking.total_price,
                status: 'success',
                description: `Earning from Booking #${id}`
            });
        }

        await supabaseAdmin.from('notifications').insert([
            { user_id: booking.client_id, title: 'Service Completed', message: 'Booking closed successfully.', type: 'booking_completed', reference_id: id },
            { user_id: booking.provider_id, title: 'Job Completed', message: 'Funds/Swap recorded successfully.', type: 'booking_completed', reference_id: id }
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
      .select('*, services(title, image_urls), profiles!provider_id(full_name)')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });

    if (error) return res.status(400).json({ error: error.message });
    res.status(200).json({ bookings });
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

router.get('/provider', authenticateToken, async (req, res) => {
  const providerId = req.user.id;
  try {
    const { data: requests, error } = await supabaseAdmin 
      .from('bookings')
      .select('*, services(title), profiles!client_id(full_name, profile_picture_url)') 
      .eq('provider_id', providerId)
      .order('created_at', { ascending: false });

    if (error) return res.status(400).json({ error: error.message });
    res.status(200).json({ requests });
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


module.exports = router;