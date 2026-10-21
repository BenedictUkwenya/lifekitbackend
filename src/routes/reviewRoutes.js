const express = require('express');
const router = express.Router();
const { supabase, supabaseAdmin } = require('../config/supabase');
const authenticateToken = require('../middleware/authMiddleware');

/**
 * 1. POST /reviews - Submit a Review (bidirectional: client rates provider, provider rates client)
 */
router.post('/', authenticateToken, async (req, res) => {
  const { booking_id, service_id, reviewee_id, reviewer_role, rating, comment } = req.body;
  const reviewer_id = req.user.id;

  if (!booking_id || !reviewee_id || !reviewer_role || !rating) {
    return res.status(400).json({ error: 'booking_id, reviewee_id, reviewer_role, and rating are required.' });
  }

  const numericRating = Number(rating);
  if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
    return res.status(400).json({ error: 'Rating must be a whole number from 1 to 5.' });
  }
  if (!['client', 'provider'].includes(reviewer_role)) {
    return res.status(400).json({ error: 'Invalid reviewer_role.' });
  }

  try {
    // Only participants of a completed booking may review, and only the
    // other party — otherwise anyone could inflate/deflate any rating.
    const { data: booking } = await supabaseAdmin
      .from('bookings')
      .select('client_id, provider_id, service_id, status, client_confirmed, provider_confirmed')
      .eq('id', booking_id)
      .maybeSingle();
    if (!booking) return res.status(404).json({ error: 'Booking not found.' });
    const expectedReviewer = reviewer_role === 'client' ? booking.client_id : booking.provider_id;
    const expectedReviewee = reviewer_role === 'client' ? booking.provider_id : booking.client_id;
    if (expectedReviewer !== reviewer_id || expectedReviewee !== reviewee_id) {
      return res.status(403).json({ error: 'You can only review the other party of your own booking.' });
    }
    const iConfirmed = reviewer_role === 'client' ? booking.client_confirmed : booking.provider_confirmed;
    if (booking.status !== 'completed' && !iConfirmed) {
      return res.status(400).json({ error: 'You can review once the booking is completed.' });
    }
    const { data: existing } = await supabaseAdmin
      .from('reviews')
      .select('id')
      .eq('booking_id', booking_id)
      .eq('reviewer_id', reviewer_id)
      .maybeSingle();
    if (existing) return res.status(409).json({ error: 'You already reviewed this booking.' });
    if (service_id && booking.service_id && service_id !== booking.service_id) {
      return res.status(400).json({ error: 'Service does not match the booking.' });
    }

    // A. Insert the Review
    const { data: review, error } = await supabaseAdmin
      .from('reviews')
      .insert({
        booking_id,
        service_id: service_id || null,
        // Keep provider_id populated for client reviews (backwards compat)
        provider_id: reviewer_role === 'client' ? reviewee_id : null,
        reviewee_id,
        reviewer_role,
        reviewer_id,
        rating: numericRating,
        comment
      })
      .select()
      .single();

    if (error) throw error;

    // B. Only update service average rating when a client rates the provider
    if (reviewer_role === 'client' && service_id) {
      const { data: allReviews } = await supabaseAdmin
        .from('reviews')
        .select('rating')
        .eq('service_id', service_id)
        .eq('reviewer_role', 'client');

      const totalReviews = allReviews.length;
      const sumRatings = allReviews.reduce((sum, r) => sum + r.rating, 0);
      const newAverage = (sumRatings / totalReviews).toFixed(1);

      await supabaseAdmin
        .from('services')
        .update({ 
          average_rating: newAverage,
          total_reviews: totalReviews 
        })
        .eq('id', service_id);
    }

    res.status(201).json({ message: 'Review submitted!', review });

  } catch (error) {
    console.error('Review Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 2. GET /reviews/:serviceId - Get Reviews for a Service
 */
router.get('/:serviceId', async (req, res) => {
  const { serviceId } = req.params;

  try {
    const { data: reviews, error } = await supabase
      .from('reviews')
      .select('*, profiles:reviewer_id(full_name, profile_picture_url), bookings:booking_id(status)')
      .eq('service_id', serviceId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const ratingsBreakdown = {
      5: 0,
      4: 0,
      3: 0,
      2: 0,
      1: 0
    };

    const mappedReviews = (reviews || []).map((review) => {
      const ratingValue = Number(review.rating);
      if (ratingsBreakdown[ratingValue] !== undefined) {
        ratingsBreakdown[ratingValue] += 1;
      }

      return {
        ...review,
        verified: review.bookings?.status === 'completed',
        bookings: undefined
      };
    });

    res.status(200).json({
      reviews: mappedReviews,
      ratings_breakdown: ratingsBreakdown
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
