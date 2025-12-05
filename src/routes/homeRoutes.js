// src/routes/homeRoutes.js
const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const authenticateToken = require('../middleware/authMiddleware'); 

// 1. Get Active Offers/Banners (Public)
router.get('/offers', async (req, res) => {
  try {
    const { data: offers, error } = await supabase
      .from('offers')
      .select('*')
      .eq('is_active', true)
      .filter('start_date', 'lte', new Date().toISOString())
      .filter('end_date', 'gte', new Date().toISOString())
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.status(200).json({
      message: 'Active offers fetched successfully!',
      offers: offers,
    });
  } catch (error) {
    console.error('Offers Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 2. Get Popular Services (Public)
router.get('/popular-services', async (req, res) => {
  try {
    const { data: services, error } = await supabase
      .from('services')
      .select('*, profiles(full_name, profile_picture_url), service_categories(name)')
      .eq('is_popular', true)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(5);

    if (error) throw error;

    res.status(200).json({
      message: 'Popular services fetched successfully!',
      services: services,
    });
  } catch (error) {
    console.error('Popular Services Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 3. Get ROOT Service Categories (Main Page)
// This only returns categories that DO NOT have a parent.
router.get('/categories', async (req, res) => {
  try {
    const { data: categories, error } = await supabase
      .from('service_categories')
      .select('*')
      .is('parent_category_id', null) // <--- CRITICAL: Only Parents
      .order('name', { ascending: true });

    if (error) throw error;

    res.status(200).json({
      message: 'Root categories fetched successfully!',
      categories: categories,
    });
  } catch (error) {
    console.error('Categories Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 4. Get SUB-Categories (When a Main Category is clicked)
router.get('/categories/:parentId', async (req, res) => {
  const { parentId } = req.params;
  try {
    const { data: categories, error } = await supabase
      .from('service_categories')
      .select('*')
      .eq('parent_category_id', parentId) // <--- CRITICAL: Only Children
      .order('name', { ascending: true });

    if (error) throw error;

    res.status(200).json({
      message: 'Sub-categories fetched successfully!',
      categories: categories,
    });
  } catch (error) {
    console.error('Sub-Categories Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 5. Global Search
router.get('/search', async (req, res) => {
    const { query } = req.query; 
    if (!query || query.trim() === '') return res.status(400).json({ error: 'Query required.' });

    try {
        const { data: services } = await supabase
            .from('services')
            .select('*, profiles(full_name, profile_picture_url), service_categories(name)')
            .eq('status', 'active')
            .or(`title.ilike.%${query}%,description.ilike.%${query}%`); 

        const { data: providers } = await supabase
            .from('profiles')
            .select('id, full_name, profile_picture_url')
            .or(`full_name.ilike.%${query}%`);

        res.status(200).json({
            message: `Search results for "${query}"`,
            services: services || [],
            providers: providers || [],
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 6. Recent Searches (Mock)
router.get('/recent-searches', authenticateToken, async (req, res) => {
    res.status(200).json({
        recent_searches: [
            { id: '1', search_term: 'Hair Plaiting', created_at: new Date().toISOString() },
            { id: '2', search_term: 'Barbing', created_at: new Date().toISOString() },
        ]
    });
});

module.exports = router;