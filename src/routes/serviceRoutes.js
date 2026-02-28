// src/routes/serviceRoutes.js
const express = require('express');
const router = express.Router();
const { supabase, supabaseAdmin } = require('../config/supabase');
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
 * 2. POST /services - Create new service(s)
 * LOGIC UPDATE: If Standalone (e.g. Plumbing), create ONE service with options.
 * If Standard (e.g. Cleaning), create MULTIPLE services.
 */
router.post('/', authenticateToken, async (req, res) => {
    const { category_ids, currency = 'USD' } = req.body; 
    const providerId = req.user.id; 

    if (!Array.isArray(category_ids) || category_ids.length === 0) {
        return res.status(400).json({ error: 'At least one category_id is required.' });
    }

    try {
        // 1. Fetch details of selected categories
        const { data: selectedCats, error: catError } = await supabase
            .from('service_categories')
            .select('id, name, is_standalone, parent_category_id')
            .in('id', category_ids);

        if (catError) return res.status(400).json({ error: 'Invalid categories.' });

        if (!selectedCats || selectedCats.length === 0) {
             return res.status(400).json({ error: 'No valid categories found.' });
        }

        // 2. Check if these are sub-categories of a Standalone Parent
        // We assume all selected IDs belong to the same parent flow for now
        const firstCat = selectedCats[0];
        
        // Fetch Parent to check 'is_standalone' status
        let parentCat = null;
        if (firstCat.parent_category_id) {
            const { data: parent } = await supabase
                .from('service_categories')
                .select('*')
                .eq('id', firstCat.parent_category_id)
                .single();
            parentCat = parent;
        }

        // --- BRANCH A: STANDALONE SERVICE (e.g. Plumbing) ---
        // If the parent is standalone, we create ONE service and put selected items in 'service_options'
        if (parentCat && parentCat.is_standalone) {
            
            // Prepare options array: [{ name: 'Leak Repair', price: 0 }, ...]
            const options = selectedCats.map(c => ({
                id: c.id,
                name: c.name,
                price: 0 // Default price, provider edits this later
            }));

            const { data, error } = await supabase
                .from('services')
                .insert({
                    provider_id: providerId,
                    category_id: parentCat.id, // Link to Parent (Plumbing)
                    title: `${parentCat.name} Services`,
                    description: `Professional ${parentCat.name} services including ${options.map(o => o.name).join(', ')}.`,
                    price: 0, // Base price 0, calculated from options later
                    currency: currency,
                    image_urls: [],
                    service_type: 'Home Service (HS)', // Default for standalone
                    status: 'draft',
                    service_options: options // <--- SAVE OPTIONS HERE
                })
                .select();

            if (error) throw error;
            return res.status(201).json({ message: 'Standalone Service created!', services: data });
        }

        // --- BRANCH B: STANDARD SERVICES (e.g. Relocation) ---
        // Old logic: Create one service per selected category
        const servicesToInsert = selectedCats.map(cat => ({
            provider_id: providerId,
            category_id: cat.id, 
            title: cat.name,
            description: `Professional ${cat.name} services.`,
            price: 0.00, 
            currency: currency,
            image_urls: [], 
            service_type: 'Default',
            status: 'draft'
        }));

        const { data, error } = await supabase.from('services').insert(servicesToInsert).select(); 
        if (error) throw error;

        res.status(201).json({ message: 'Services created successfully!', services: data });

    } catch (error) {
        console.error('Create service error:', error.message);
        res.status(500).json({ error: 'Internal server error during service creation.' });
    }
});


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
        service_options, // <--- Added for Standalone
        availability 
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
    
    // Map service_options to updateData
    if (service_options !== undefined) updateData.service_options = service_options; 

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
});

/**
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
 * 5. GET /services/category/:categoryId 
 * SMART UPDATE: Looks Upwards (Parent) and Downwards (Children) to find matches.
 * Fixes "No providers found" when searching for a specific sub-skill (e.g. Leak Repair)
 * that is contained inside a main service (e.g. Plumbing).
 */
router.get('/category/:categoryId', async (req, res) => {
    const { categoryId } = req.params;

    try {
        // 1. Get details of the requested category (Check if it has a parent)
        const { data: currentCat, error: catError } = await supabase
            .from('service_categories')
            .select('id, parent_category_id')
            .eq('id', categoryId)
            .single();

        if (catError) throw catError;

        // 2. Get all Sub-Category IDs (Downwards)
        const { data: subCategories } = await supabase
            .from('service_categories')
            .select('id')
            .eq('parent_category_id', categoryId);

        // 3. Build the Master List of IDs to search
        const allCategoryIds = [categoryId]; // Start with requested ID

        // Add Children (if any)
        if (subCategories && subCategories.length > 0) {
            subCategories.forEach(sub => allCategoryIds.push(sub.id));
        }

        // Add Parent (if any) - This is the Critical Fix!
        // If I search "Leak Repair", I also want to find "Plumbing" services.
        if (currentCat.parent_category_id) {
            allCategoryIds.push(currentCat.parent_category_id);
        }

        // 4. Fetch Services
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
            .in('category_id', allCategoryIds) // Checks Child, Self, AND Parent
            .eq('status', 'active')
            .not('profiles', 'is', null)
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
            .select('*, profiles(full_name, profile_picture_url), service_categories(name)') 
            .eq('id', id)
            .eq('status', 'active') 
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

// POST /services/request-category - Let providers request a new category
router.post('/request-category', authenticateToken, async (req, res) => {
    const { category_name, description } = req.body;
    const userId = req.user.id;

    if (!category_name) {
        return res.status(400).json({ error: "Category name is required." });
    }

    try {
        const { error } = await supabaseAdmin.from('requested_categories').insert({
            user_id: userId,
            category_name,
            description
        });

        if (error) throw error;

        // Optional: Notify the Admin (if you have a specific Admin ID, or just store it in DB for the panel)
        
        res.status(201).json({ message: "Category request submitted successfully!" });
    } catch (error) {
        console.error("Request Category Error:", error.message);
        res.status(500).json({ error: "Failed to submit request." });
    }
});


module.exports = router;