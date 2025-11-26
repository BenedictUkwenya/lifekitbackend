// src/routes/homeRoutes.js
const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const authenticateToken = require('../middleware/temp_auth'); 

// Get Active Offers/Banners (Public)
router.get('/offers', async (req, res) => {
  try {
    const { data: offers, error } = await supabase
      .from('offers')
      .select('*')
      .eq('is_active', true)
      .filter('start_date', 'lte', new Date().toISOString())
      .filter('end_date', 'gte', new Date().toISOString())
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Supabase fetch offers error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch offers.' });
    }

    res.status(200).json({
      message: 'Active offers fetched successfully!',
      offers: offers,
    });

  } catch (error) {
    console.error('Unexpected error fetching offers:', error.message);
    res.status(500).json({ error: 'Internal server error fetching offers.' });
  }
});

// Get Popular Services (Public)
router.get('/popular-services', async (req, res) => {
  // Logic for "popular" can be complex (e.g., number of bookings, views, ratings)
  // For now, we'll fetch services explicitly marked as 'is_popular' and 'active'.
  try {
        const { data: services, error } = await supabase
          .from('services')
          .select('*, profiles(full_name, profile_picture_url), service_categories(name)') // <--- The join is here
          .eq('is_popular', true)
      .eq('status', 'active')
      .order('created_at', { ascending: false }) // Or order by some popularity metric
      .limit(5); // Show top 5 as per your description

    if (error) {
      console.error('Supabase fetch popular services error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch popular services.' });
    }

    res.status(200).json({
      message: 'Popular services fetched successfully!',
      services: services,
    });

  } catch (error) {
    console.error('Unexpected error fetching popular services:', error.message);
    res.status(500).json({ error: 'Internal server error fetching popular services.' });
  }
});

// Get All Service Categories (Public)
router.get('/categories', async (req, res) => {
  try {
    const { data: categories, error } = await supabase
      .from('service_categories')
      .select('*')
      .order('name', { ascending: true });

    if (error) {
      console.error('Supabase fetch categories error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch service categories.' });
    }

    res.status(200).json({
      message: 'Service categories fetched successfully!',
      categories: categories,
    });

  } catch (error) {
    console.error('Unexpected error fetching categories:', error.message);
    res.status(500).json({ error: 'Internal server error fetching categories.' });
  }
});

// Global Search Endpoint (Services and potentially Profiles)
// This is a basic example. Full-text search and more complex queries are possible.
router.get('/search', async (req, res) => {
    const { query } = req.query; // e.g., ?query=haircut

    if (!query || query.trim() === '') {
        return res.status(400).json({ error: 'Search query is required.' });
    }

    try {
        // Search for active services
        const { data: services, error: serviceError } = await supabase
            .from('services')
            .select('*, profiles(full_name, profile_picture_url), service_categories(name)')
            .eq('status', 'active')
            .or(`title.ilike.%${query}%,description.ilike.%${query}%`); // Case-insensitive LIKE search on title/description

        if (serviceError) {
            console.error('Supabase search services error:', serviceError.message);
            // Continue to search profiles even if services fail
        }

        // Search for profiles (service providers)
        const { data: providers, error: providerError } = await supabase
            .from('profiles')
            .select('id, full_name, profile_picture_url')
            .or(`full_name.ilike.%${query}%`); // Case-insensitive LIKE search on full_name

        if (providerError) {
            console.error('Supabase search providers error:', providerError.message);
        }

        res.status(200).json({
            message: `Search results for "${query}"`,
            services: services || [],
            providers: providers || [],
        });

    } catch (error) {
        console.error('Unexpected error during global search:', error.message);
        res.status(500).json({ error: 'Internal server error during search.' });
    }
});


// Recent Searches (User-specific, requires authentication)
// This implies another table 'user_recent_searches'
// For now, we'll return a mock or placeholder.
// To implement fully: create a `user_recent_searches` table with `user_id`, `search_term`, `created_at`
router.get('/recent-searches', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    // In a real scenario, fetch from a 'user_recent_searches' table
    // For now, return mock data
    res.status(200).json({
        message: 'Recent searches for authenticated user (mock data)',
        recent_searches: [
            { id: 'mock1', search_term: 'Hair Plaiting', created_at: new Date().toISOString() },
            { id: 'mock2', search_term: 'Barbing', created_at: new Date(Date.now() - 3600000).toISOString() }, // 1 hour ago
        ]
    });
});

// src/routes/homeRoutes.js (Add this new route)

/**
 * 6. GET /home/categories/:parentId - List sub-categories (for service creation flow)
 * Requires: parentId (the UUID of the main category, e.g., Hair & Beauty's ID)
 */
router.get('/categories/:parentId', async (req, res) => {
  const { parentId } = req.params;

  try {
    const { data: categories, error } = await supabase
      .from('service_categories')
      .select('*')
      .eq('parent_category_id', parentId)
      .order('name', { ascending: true });

    if (error) {
      console.error('Supabase fetch sub-categories error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch sub-categories.' });
    }

    res.status(200).json({
      message: 'Sub-categories fetched successfully!',
      categories: categories,
    });

  } catch (error) {
    console.error('Unexpected error fetching sub-categories:', error.message);
    res.status(500).json({ error: 'Internal server error fetching sub-categories.' });
  }
});


module.exports = router;