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
router.post('/', authenticateToken, async (req, res) => {
    // We now expect an array of IDs from the category selection screen
    const { category_ids, currency = 'USD' } = req.body; 
    const providerId = req.user.id; 

    if (!Array.isArray(category_ids) || category_ids.length === 0) {
        return res.status(400).json({ error: 'At least one category_id is required for service creation.' });
    }

    // Create an array of service objects for bulk insert (minimal initial data)
    const servicesToInsert = category_ids.map(catId => ({
        provider_id: providerId,
        category_id: catId, 
        title: `New Service Listing`, // Placeholder title for easy editing
        description: 'Please add a detailed description.',
        price: 0.00, 
        currency: currency,
        image_urls: [], // Initial empty array for images
        service_type: 'Default',
        status: 'pending', // Service starts as DRAFT until price/details are edited
    }));

    try {
        // BULK INSERT: Insert all selected services at once
        const { data, error } = await supabase
            .from('services')
            .insert(servicesToInsert)
            .select(); // Return all newly created services

        if (error) {
            console.error('Supabase bulk create service error:', error.message);
            return res.status(400).json({ error: error.message });
        }

        res.status(201).json({
            message: 'Services created successfully as drafts! Please edit details.',
            services: data, // Note: returns an array of services
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
router.put('/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const providerId = req.user.id;
    
    // Deconstruct all possible update fields, including new ones
    const { 
        title, description, price, currency, 
        image_urls, location_text, latitude, longitude, 
        category_id, status, service_type
    } = req.body;

    const updateData = {};
    if (title !== undefined) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (price !== undefined) updateData.price = price;
    if (currency !== undefined) updateData.currency = currency;
    if (image_urls !== undefined) updateData.image_urls = image_urls; // Now expects an array of URLs
    if (location_text !== undefined) updateData.location_text = location_text;
    if (latitude !== undefined) updateData.latitude = latitude;
    if (longitude !== undefined) updateData.longitude = longitude;
    if (category_id !== undefined) updateData.category_id = category_id;
    if (status !== undefined) updateData.status = status;
    if (service_type !== undefined) updateData.service_type = service_type; // The new field

    if (Object.keys(updateData).length === 0) {
        return res.status(400).json({ message: 'No service data provided for update.' });
    }

    try {
        const { data, error } = await supabase
            .from('services')
            .update(updateData)
            .eq('id', id)
            .eq('provider_id', providerId) // Ensure user can only update their own services
            .select()
            .single();

        if (error) {
            if (error.code === 'PGRST116') { 
                return res.status(404).json({ error: 'Service not found or not owned by user.' });
            }
            console.error('Supabase update service error:', error.message);
            return res.status(400).json({ error: error.message });
        }

        res.status(200).json({
            message: 'Service updated successfully!',
            service: data,
        });

    } catch (error) {
        console.error('Unexpected error updating service:', error.message);
        res.status(500).json({ error: 'Internal server error updating service.' });
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
 * 5. GET /services/category/:categoryId - List providers/services for a Category (Public)
 * Screen: "Hair & Beauty" provider list screen
 */
router.get('/category/:categoryId', async (req, res) => {
    const { categoryId } = req.params;

    try {
        const { data: services, error } = await supabase
            .from('services')
            .select('*, profiles:provider_id(full_name, profile_picture_url), service_categories(name)')
            .eq('category_id', categoryId)
            .eq('status', 'active')
            .order('price', { ascending: true }); 

        if (error) {
            console.error('Supabase fetch by category error:', error.message);
            return res.status(500).json({ error: 'Failed to fetch services for this category.' });
        }

        res.status(200).json({
            message: 'Services fetched by category successfully!',
            services: services, 
        });

    } catch (error) {
        console.error('Unexpected error fetching services by category:', error.message);
        res.status(500).json({ error: 'Internal server error fetching services by category.' });
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