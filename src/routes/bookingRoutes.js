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
  const { service_id, scheduled_time, location_details, total_price } = req.body;
  const clientId = req.user.id;

  if (!service_id || !scheduled_time || !total_price) {
    return res.status(400).json({ error: 'Service ID, scheduled time, and price are required.' });
  }

  try {
    // 1. Verify Service & Get Provider ID
    const { data: service, error: serviceError } = await supabaseAdmin // Use Admin to be safe
      .from('services')
      .select('provider_id, price, title') // Get title for the notification
      .eq('id', service_id)
      .single();

    if (serviceError || !service) {
      return res.status(404).json({ error: 'Service not found or not currently active.' });
    }

    // 2. Check Client Wallet Balance
    const { data: clientWallet } = await supabaseAdmin
      .from('wallets')
      .select('*')
      .eq('user_id', clientId)
      .single();

    if (!clientWallet || parseFloat(clientWallet.balance) < parseFloat(total_price)) {
      return res.status(402).json({ error: 'Insufficient wallet balance. Please add money.' });
    }

    // 3. DEDUCT MONEY (Hold Funds)
    const newBalance = parseFloat(clientWallet.balance) - parseFloat(total_price);
    
    const { error: walletError } = await supabaseAdmin
      .from('wallets')
      .update({ balance: newBalance })
      .eq('id', clientWallet.id);

    if (walletError) return res.status(500).json({ error: 'Payment processing failed.' });

    // 4. Create Booking (Status: pending)
    const { data: booking, error: bookingError } = await supabaseAdmin
      .from('bookings')
      .insert({
        client_id: clientId,
        provider_id: service.provider_id,
        service_id,
        scheduled_time,
        location_details,
        total_price,
        status: 'pending',
        client_confirmed: false, 
        provider_confirmed: false 
      })
      .select()
      .single();

    if (bookingError) {
      // Refund Logic (omitted for brevity, but same as before)
      return res.status(500).json({ error: 'Failed to create booking.' });
    }

    // ======================================================
    // 5. NOTIFY THE PROVIDER (The part you asked about!)
    // ======================================================
    await supabaseAdmin.from('notifications').insert({
      user_id: service.provider_id, // <--- Target: The Provider
      title: 'New Booking Request 📅',
      message: `Someone wants to book "${service.title}" for $${total_price}. Check your requests!`,
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
 * NEW LOGIC: If Cancelled/Rejected -> REFUND THE CLIENT
 */
router.put('/:id/status', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const providerId = req.user.id;

  if (!['confirmed', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }

  try {
    // Fetch booking details first
    const { data: booking } = await supabaseAdmin
      .from('bookings')
      .select('*')
      .eq('id', id)
      .eq('provider_id', providerId)
      .single();

    if (!booking) return res.status(404).json({ error: 'Booking not found or unauthorized.' });

    // Update Status
    const { data: updatedBooking, error } = await supabaseAdmin
      .from('bookings')
      .update({ status: status })
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: 'Failed to update status.' });

    // --- REFUND LOGIC IF CANCELLED ---
    if (status === 'cancelled') {
        // 1. Get Client Wallet
        const { data: clientWallet } = await supabaseAdmin.from('wallets').select('*').eq('user_id', booking.client_id).single();
        
        // 2. Add Money Back
        const refundBalance = parseFloat(clientWallet.balance) + parseFloat(booking.total_price);
        await supabaseAdmin.from('wallets').update({ balance: refundBalance }).eq('id', clientWallet.id);

        // 3. Log Transaction
        await supabaseAdmin.from('transactions').insert({
            wallet_id: clientWallet.id,
            type: 'refund',
            amount: booking.total_price,
            status: 'success',
            description: `Refund for Booking #${booking.id}`
        });

        // 4. Notify Client
        await supabaseAdmin.from('notifications').insert({
            user_id: booking.client_id,
            title: 'Booking Declined',
            message: 'The provider declined. Your funds have been refunded.',
            type: 'booking_update',
            reference_id: id
        });
    } else {
        // Notify Client of Confirmation
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
 * Logic: Waits for BOTH parties to call this endpoint before releasing funds.
 */
router.put('/:id/complete', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  try {
    // 1. Fetch booking
    const { data: booking } = await supabaseAdmin.from('bookings').select('*').eq('id', id).single();
    if (!booking) return res.status(404).json({ error: 'Booking not found.' });

    // 2. Determine who is clicking
    let updateData = {};
    if (userId === booking.client_id) updateData = { client_confirmed: true };
    else if (userId === booking.provider_id) updateData = { provider_confirmed: true };
    else return res.status(403).json({ error: 'Unauthorized action.' });

    // 3. Update the flag
    const { data: updatedBooking } = await supabaseAdmin
      .from('bookings')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    // 4. CHECK: Are BOTH confirmed now?
    if (updatedBooking.client_confirmed && updatedBooking.provider_confirmed) {
        // YES! RELEASE FUNDS TO PROVIDER
        
        // A. Mark Completed
        await supabaseAdmin.from('bookings').update({ status: 'completed' }).eq('id', id);

        // B. Credit Provider
        const { data: providerWallet } = await supabaseAdmin.from('wallets').select('*').eq('user_id', booking.provider_id).single();
        const newBalance = parseFloat(providerWallet.balance) + parseFloat(booking.total_price);
        await supabaseAdmin.from('wallets').update({ balance: newBalance }).eq('id', providerWallet.id);

        // C. Log Transaction
        await supabaseAdmin.from('transactions').insert({
            wallet_id: providerWallet.id,
            type: 'earning',
            amount: booking.total_price,
            status: 'success',
            description: `Earning from Booking #${id}`
        });

        // D. Notify Both
        await supabaseAdmin.from('notifications').insert([
            { user_id: booking.client_id, title: 'Service Completed', message: 'Booking closed.', type: 'booking_completed', reference_id: id },
            { user_id: booking.provider_id, title: 'Payment Received', message: 'Funds released to your wallet.', type: 'booking_completed', reference_id: id }
        ]);

        return res.json({ message: 'Booking fully completed. Funds released to provider.' });
    }

    res.json({ message: 'Confirmation recorded. Waiting for the other party to confirm.' });

  } catch (error) {
    console.error('Completion error:', error.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// --- STANDARD GETTERS ---

router.get('/client', authenticateToken, async (req, res) => {
  const clientId = req.user.id;

  try {
    // FIX: Used 'profiles!provider_id' instead of 'profiles:provider_id'
    const { data: bookings, error } = await supabaseAdmin 
      .from('bookings')
      .select('*, services(title, image_urls), profiles!provider_id(full_name)')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });

    if (error) {
        console.error("Supabase Error (Client):", error);
        return res.status(400).json({ error: error.message });
    }

    res.status(200).json({ bookings });

  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});// ... 
router.get('/provider', authenticateToken, async (req, res) => {
  const providerId = req.user.id;
  
  try {
    // FIX: Used 'profiles!client_id' instead of 'profiles:client_id'
    const { data: requests, error } = await supabaseAdmin 
      .from('bookings')
      .select('*, services(title), profiles!client_id(full_name, profile_picture_url)') 
      .eq('provider_id', providerId)
      .order('created_at', { ascending: false });

    if (error) {
        console.error("Supabase Error (Provider):", error);
        return res.status(400).json({ error: error.message });
    }
    
    res.status(200).json({ requests });

  } catch (e) { 
    console.error(e);
    res.status(500).json({ error: e.message }); 
  }
});
router.get('/availability/:providerId', async (req, res) => {
  // (Keep your existing availability logic here, it was correct)
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
module.exports = router;