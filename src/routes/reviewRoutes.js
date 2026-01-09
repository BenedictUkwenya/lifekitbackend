const express = require('express');
const router = express.Router();
const { supabase, supabaseAdmin } = require('../config/supabase');
const authenticateToken = require('../middleware/authMiddleware');

/**
 * 1. POST /reviews - Submit a Review
 */
router.post('/', authenticateToken, async (req, res) => {
  const { booking_id, service_id, provider_id, rating, comment } = req.body;
  const reviewer_id = req.user.id;

  try {
    // A. Insert the Review
    const { data: review, error } = await supabase
      .from('reviews')
      .insert({
        booking_id,
        service_id,
        provider_id,
        reviewer_id,
        rating,
        comment
      })
      .select()
      .single();

    if (error) throw error;

    // B. Recalculate Average Rating for the Service
    // 1. Fetch all ratings for this service
    const { data: allReviews } = await supabase
      .from('reviews')
      .select('rating')
      .eq('service_id', service_id);

    // 2. Calculate Math
    const totalReviews = allReviews.length;
    const sumRatings = allReviews.reduce((sum, r) => sum + r.rating, 0);
    const newAverage = (sumRatings / totalReviews).toFixed(1); // e.g. 4.5

    // 3. Update Service Table (So lists are fast)
    await supabaseAdmin
      .from('services')
      .update({ 
        average_rating: newAverage,
        total_reviews: totalReviews 
      })
      .eq('id', service_id);

    res.status(201).json({ message: 'Review submitted!', review });

  } catch (error) {
    console.error('Review Error:', error.message);
    res.status(500).json({ error: error.message }); // Booking_id unique constraint will trigger here if dup
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
      .select('*, profiles:reviewer_id(full_name, profile_picture_url)')
      .eq('service_id', serviceId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.status(200).json({ reviews });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;