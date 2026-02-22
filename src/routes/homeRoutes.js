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
// 2. Get Popular Services (Public & Dynamic)
router.get('/popular-services', async (req, res) => {
  try {
    // 1. Try to fetch the top 5 highest-rated active services
    let { data: services, error } = await supabase
      .from('services')
      .select('*, profiles(full_name, profile_picture_url), service_categories(name)')
      .eq('status', 'active')
      // Removed the hardcoded .eq('is_popular', true)
      .order('average_rating', { ascending: false, nullsFirst: false })
      .order('total_reviews', { ascending: false })
      .limit(6);

    if (error) throw error;

    // 2. Fallback for new apps: 
    // If no services have ratings yet (or list is empty), just fetch the newest active ones!
    if (!services || services.length === 0 || services[0].average_rating === 0) {
      const { data: newestServices } = await supabase
        .from('services')
        .select('*, profiles(full_name, profile_picture_url), service_categories(name)')
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(6);
        
      services = newestServices || [];
    }

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
router.get('/categories/children/:parentId', async (req, res) => {
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

// 5. Deep Global Search (For Clients)
// Searches: Service titles, Category names, and Standalone JSON options
router.get('/search', async (req, res) => {
    const { query } = req.query; 
    if (!query || query.trim() === '') return res.status(400).json({ error: 'Query required.' });

    try {
        // 1. Find Category IDs that match the search (e.g., "Socket")
        const { data: matchedCats } = await supabase
            .from('service_categories')
            .select('id')
            .ilike('name', `%${query}%`);
        
        const matchedCatIds = matchedCats ? matchedCats.map(c => c.id) : [];

        // 2. Search Services (Title/Desc Match)
        // We look for: Title/Desc matches
        const { data: services, error: svcError } = await supabase
            .from('services')
            .select(`
                *,
                profiles!provider_id (id, full_name, profile_picture_url),
                service_categories (id, name)
            `)
            .eq('status', 'active')
            .or(`title.ilike.%${query}%, description.ilike.%${query}%`);

        if(svcError) console.error("Svc Error", svcError);

        // 3. Search specifically inside Standalone Options (JSONB)
        // This finds "Socket Repair" inside the "service_options" array
        // Note: .contains works if the JSON array has an object exactly matching { name: query }
        // For partial matches inside JSONB arrays, Supabase/Postgres usually requires more complex queries or text search indexes.
        // However, we will try a basic containment check or just rely on text description if JSON searching is limited.
        
        // Attempting a text-cast search on the JSON column is often safer for simple partials in Supabase:
        // .textSearch('service_options', `'${query}'`) <-- This depends on DB config.
        // For now, we stick to the provided logic or fallback to text matching if title/desc covers it.
        
        // Alternative Logic for JSONB Array Partial Match (If supported by your Supabase version):
        // We will skip complex JSON filtering here to avoid 500 errors if indices aren't set, 
        // relying on the provider putting keywords in the description. 
        // BUT, if you want exact match on an option name:
        /*
        const { data: standaloneServices } = await supabase
            .from('services')
            .select(...)
            .eq('status', 'active')
            .contains('service_options', JSON.stringify([{ name: query }])); 
        */

        // 4. Fetch by Category ID matches (Backup)
        let catMatchedServices = [];
        if (matchedCatIds.length > 0) {
            const { data } = await supabase
                .from('services')
                .select(`
                    *,
                    profiles!provider_id (id, full_name, profile_picture_url),
                    service_categories (id, name)
                `)
                .eq('status', 'active') // Ensure active
                .in('category_id', matchedCatIds);
            catMatchedServices = data || [];
        }

        // Combine all results
        const combined = [
            ...(services || []), 
            // ...(standaloneServices || []), // Add back if JSON search is enabled
            ...catMatchedServices
        ];
        
        // Dedup by ID
        const uniqueServices = Array.from(new Map(combined.map(item => [item['id'], item])).values());

        // 5. Search Providers (by name)
        const { data: providers } = await supabase
            .from('profiles')
            .select('id, full_name, profile_picture_url')
            .ilike('full_name', `%${query}%`);
            // .eq('is_service_provider', true); // Uncomment if you have this flag

        res.status(200).json({
            message: `Deep search results for "${query}"`,
            services: uniqueServices,
            providers: providers || [],
        });
    } catch (error) {
        console.error("Deep Search Error", error);
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

// 7. NEW: Category Search (For Providers Creating Services - Dropdown)
// Allows searching "Socket" and finding "Electrical > Socket Repair"
router.get('/categories/search/dropdown', async (req, res) => {
    const { query } = req.query;
    if (!query) return res.status(400).json({ error: "Query required" });

    try {
        // Fetch categories matching query
        const { data, error } = await supabase
            .from('service_categories')
            .select(`
                id, 
                name, 
                is_standalone, 
                parent_category_id
            `) 
            .ilike('name', `%${query}%`)
            .limit(10);

        if (error) throw error;

        res.json({ categories: data });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;