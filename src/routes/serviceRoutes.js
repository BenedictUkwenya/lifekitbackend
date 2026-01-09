// src/routes/serviceRoutes.js
const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const authenticateToken = require('../middleware/authMiddleware');

// --- Service Listing & Management Endpoints ---

// NOTE ON ORDERING: The general parameterized routes (like /:id) must come AFTER 
// the static routes (like /my-services) to prevent Express route conflicts.

/**
 * 1. GET /services/my-services - Get all services by an authenticated provider (Authenticated)
 * Screen: "Service Lists"
 */
router.get('/my-services', authenticateToken, async (req, res) => {
    const providerId = req.user.id;

    try {
        const { data: services, error } = await supabase
            .from('services')
            .select('*, service_categories(name)')
            .eq('provider_id', providerId)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Supabase fetch my services error:', error.message);
            return res.status(500).json({ error: 'Failed to fetch your services.' });
        }

        res.status(200).json({
            message: 'Your services fetched successfully!',
            services: services,
        });

    } catch (error) {
        console.error('Unexpected error fetching my services:', error.message);
        res.status(500).json({ error: 'Internal server error fetching your services.' });
    }
});


/**
 * 2. POST /services - Bulk create new services from category selection (Authenticated)
 * Screen: After "Service Categories" selection
 * Body: { "category_ids": ["uuid1", "uuid2"], "currency": "USD" }
 */
/**
 * 2. POST /services - Bulk create new services from category selection (Authenticated)
 * Screen: After "Service Categories" selection
 * UPDATED: Uses the Category Name as the default Service Title
 */
router.post('/', authenticateToken, async (req, res) => {
    const { category_ids, currency = 'USD' } = req.body; 
    const providerId = req.user.id; 

    if (!Array.isArray(category_ids) || category_ids.length === 0) {
        return res.status(400).json({ error: 'At least one category_id is required.' });
    }

    try {
        // 1. Fetch the names of the selected categories
        const { data: categories, error: catError } = await supabase
            .from('service_categories')
            .select('id, name')
            .in('id', category_ids);

        if (catError) {
            console.error('Error fetching category names:', catError.message);
            return res.status(400).json({ error: 'Invalid categories selected.' });
        }

        // 2. Prepare the services using the actual Category Names
        const servicesToInsert = categories.map(cat => ({
            provider_id: providerId,
            category_id: cat.id, 
            title: cat.name, // <--- USE CATEGORY NAME HERE (e.g., "Box Braids")
            description: `Professional ${cat.name} services.`, // Better default description
            price: 0.00, 
            currency: currency,
            image_urls: [], 
            service_type: 'Default',
            status: 'draft', // Start as draft
        }));

        // 3. Bulk Insert
        const { data, error } = await supabase
            .from('services')
            .insert(servicesToInsert)
            .select(); 

        if (error) {
            console.error('Supabase bulk create service error:', error.message);
            return res.status(400).json({ error: error.message });
        }

        res.status(201).json({
            message: 'Services created successfully!',
            services: data,
        });

    } catch (error) {
        console.error('Unexpected bulk create service error:', error.message);
        res.status(500).json({ error: 'Internal server error during service creation.' });
    }
});
/**
 * 3. PUT /services/:id - Update a Service (Authenticated Provider)
 * Screen: "Edit Service"
 */
/**
 * 3. PUT /services/:id - Update a Service & Availability
 */
router.put('/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const providerId = req.user.id;
    
    // 1. Deconstruct fields
    const { 
        title, description, price, currency, 
        image_urls, location_text, latitude, longitude, 
        category_id, status, service_type, pricing_type,
        availability // <--- WE NEED TO CATCH THIS
    } = req.body;

    const updateData = {};
    if (title !== undefined) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (price !== undefined) updateData.price = price;
    if (currency !== undefined) updateData.currency = currency;
    if (image_urls !== undefined) updateData.image_urls = image_urls;
    if (location_text !== undefined) updateData.location_text = location_text;
    if (latitude !== undefined) updateData.latitude = latitude;
    if (longitude !== undefined) updateData.longitude = longitude;
    if (category_id !== undefined) updateData.category_id = category_id;
    if (status !== undefined) updateData.status = status;
    if (service_type !== undefined) updateData.service_type = service_type;
    if (pricing_type !== undefined) updateData.pricing_type = pricing_type;

    if (status === 'active' || status === 'pending') {
        updateData.status = 'pending'; 
    }

    try {
        // 2. Update the Service Table
        const { data, error } = await supabase
            .from('services')
            .update(updateData)
            .eq('id', id)
            .eq('provider_id', providerId)
            .select()
            .single();

        if (error) throw error;

        // 3. Update Availability (Provider Schedules)
        // If the frontend sent an availability array, we save it to the separate table
        if (availability && Array.isArray(availability)) {
            
            // Loop through the days sent from Flutter
            for (const daySlot of availability) {
                // Check if this day already exists for this provider
                const { data: existingDay } = await supabase
                    .from('provider_schedules')
                    .select('id')
                    .eq('provider_id', providerId)
                    .eq('day_of_week', daySlot.day)
                    .single();

                if (existingDay) {
                    // Update existing row
                    await supabase.from('provider_schedules').update({
                        is_active: daySlot.active,
                        start_time: daySlot.start,
                        end_time: daySlot.end
                    }).eq('id', existingDay.id);
                } else {
                    // Insert new row
                    await supabase.from('provider_schedules').insert({
                        provider_id: providerId,
                        day_of_week: daySlot.day,
                        is_active: daySlot.active,
                        start_time: daySlot.start,
                        end_time: daySlot.end
                    });
                }
            }
        }

        res.status(200).json({
            message: 'Service and schedule updated successfully!',
            service: data,
        });

    } catch (error) {
        console.error('Update error:', error.message);
        res.status(500).json({ error: error.message });
    }
});/**
 * 4. DELETE /services/:id - Delete a Service (Authenticated Provider)
 * Screen: "Edit Service" or "Service Lists" menu
 */
router.delete('/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const providerId = req.user.id;

    try {
        const { error } = await supabase
            .from('services')
            .delete()
            .eq('id', id)
            .eq('provider_id', providerId); // Ensure user can only delete their own services

        if (error) {
            if (error.code === 'PGRST116') { 
                return res.status(404).json({ error: 'Service not found or not owned by user.' });
            }
            console.error('Supabase delete service error:', error.message);
            return res.status(400).json({ error: error.message });
        }

        res.status(200).json({
            message: 'Service deleted successfully!',
        });

    } catch (error) {
        console.error('Unexpected error deleting service:', error.message);
        res.status(500).json({ error: 'Internal server error deleting service.' });
    }
});


/**
 * 5. GET /services/category/:categoryId - List providers/services for a Category (Public)
 * Screen: "Hair & Beauty" provider list screen
 */
/**
 * 5. GET /services/category/:categoryId 
 * Updated: Fetches services for a category OR any of its sub-categories.
 */
router.get('/category/:categoryId', async (req, res) => {
    const { categoryId } = req.params;

    try {
        // 1. Get Sub-Categories (Logic from both codes)
        // We fetch any category where the parent is the one requested
        const { data: subCategories, error: subError } = await supabase
            .from('service_categories')
            .select('id')
            .eq('parent_category_id', categoryId);

        if (subError) throw subError;

        // 2. Build a list of IDs (The Parent + All its Children)
        const allCategoryIds = subCategories ? subCategories.map(c => c.id) : [];
        allCategoryIds.push(categoryId); 

        // 3. Get Services (Merged Logic)
        // We use the list of IDs, BUT we also apply the "CRITICAL" fix 
        // to filter out unknown providers.
        const { data: services, error } = await supabase
            .from('services')
            .select(`
                *, 
                profiles!provider_id (
                    full_name, 
                    profile_picture_url
                ), 
                service_categories (name)
            `)
            .in('category_id', allCategoryIds) // Checks both parent and sub-categories
            .eq('status', 'active')
            .not('profiles', 'is', null) // <--- CRITICAL: Filters out "Unknown Providers"
            .order('price', { ascending: true });

        if (error) throw error;

        res.status(200).json({
            message: 'Services fetched successfully!',
            services: services, 
        });

    } catch (error) {
        console.error('Service Fetch Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});
/**
 * 6. GET /services/provider/:providerId - List all services by a single provider (Public)
 * Screen: Provider's services list screen
 */
router.get('/provider/:providerId', async (req, res) => {
    const { providerId } = req.params;

    try {
        const { data: services, error } = await supabase
            .from('services')
            .select('*, service_categories(name)')
            .eq('provider_id', providerId)
            .eq('status', 'active')
            .order('title', { ascending: true });

        if (error) {
            console.error('Supabase fetch by provider error:', error.message);
            return res.status(500).json({ error: 'Failed to fetch services for this provider.' });
        }
        
        // Fetch provider profile separately
        const { data: profile } = await supabase
            .from('profiles')
            .select('full_name, profile_picture_url')
            .eq('id', providerId)
            .single();


        res.status(200).json({
            message: 'Services fetched by provider successfully!',
            provider_profile: profile || null,
            services: services,
        });

    } catch (error) {
        console.error('Unexpected error fetching services by provider:', error.message);
        res.status(500).json({ error: 'Internal server error fetching services by provider.' });
    }
});


/**
 * 7. GET /services/:id - Get a Single Service by ID (Public)
 * Screen: Service Detail / Booking page
 */
router.get('/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const { data: service, error } = await supabase
            .from('services')
            .select('*, profiles(full_name, profile_picture_url), service_categories(name)') // Join provider profile and category name
            .eq('id', id)
            .eq('status', 'active') // Only fetch active services
            .single();

        if (error) {
            if (error.code === 'PGRST116') { 
                return res.status(404).json({ error: 'Service not found or not active.' });
            }
            console.error('Supabase fetch single service error:', error.message);
            return res.status(500).json({ error: 'Failed to fetch service.' });
        }

        res.status(200).json({
            message: 'Service fetched successfully!',
            service: service,
        });

    } catch (error) {
        console.error('Unexpected error fetching single service:', error.message);
        res.status(500).json({ error: 'Internal server error fetching service.' });
    }
});


module.exports = router;