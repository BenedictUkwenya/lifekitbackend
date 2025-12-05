const express = require('express');
const router = express.Router();
// CRITICAL: Import supabaseAdmin to bypass RLS for Admin views
const { supabaseAdmin } = require('../config/supabase'); 
const authenticateAdmin = require('../middleware/adminMiddleware');
const { startOfMonth, startOfWeek, startOfYear } = require('date-fns');
// Apply Admin Security to all routes
router.use(authenticateAdmin);

/**
 * 1. GET /admin/stats
 * Calculates totals for the top cards.
 */
router.get('/stats', async (req, res) => {
  try {
    const [revenue, bookings, pendingServices, users] = await Promise.all([
      // 1. Total Revenue: Sum of all payments made by clients (Incoming Money)
      supabaseAdmin.from('transactions').select('amount').eq('type', 'payment'), 
      
      // 2. Total Bookings count
      supabaseAdmin.from('bookings').select('*', { count: 'exact', head: true }),
      
      // 3. Pending Reviews (Services waiting for approval)
      supabaseAdmin.from('services').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      
      // 4. Total Users count
      supabaseAdmin.from('profiles').select('*', { count: 'exact', head: true })
    ]);

    // Calculate absolute sum of revenue (since payments might be stored as negative numbers in DB)
    const totalMoney = revenue.data?.reduce((acc, curr) => acc + Math.abs(Number(curr.amount)), 0) || 0;

    res.json({
      total_revenue: totalMoney,
      total_bookings: bookings.count || 0,
      pending_reviews: pendingServices.count || 0,
      total_users: users.count || 0
    });
  } catch (error) {
    console.error("Stats Error:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 2. GET /admin/services-queue
 * Populates the table with services needing review.
 */
router.get('/services-queue', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('services')
      .select('*, profiles:provider_id(full_name, email, profile_picture_url), service_categories(name)')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 3. PUT /admin/review-service/:id
 * Accepts or Rejects a service and sends a Notification to the Provider.
 */

router.put('/review-service/:id', authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  const { status, reason } = req.body; // 'active' or 'rejected'

  try {
    // 1. Update the Service Status & Return Data
    const { data: service, error } = await supabaseAdmin
      .from('services')
      .update({ status: status })
      .eq('id', id)
      .select() // Select all columns, including provider_id
      .single();

    if (error) throw error;

    // 2. Prepare Notification Data
    // FIX: Access provider_id directly from the service row (No complex joins needed)
    const providerId = service.provider_id; 
    
    let title = '';
    let message = '';

    if (status === 'active') {
      title = 'Service Approved! 🎉';
      message = `Your service "${service.title}" has been approved and is now live for clients.`;
    } else if (status === 'rejected') {
      title = 'Service Rejected ⚠️';
      message = `Your service "${service.title}" was rejected. Reason: ${reason || 'Does not meet guidelines.'}`;
    }

    // 3. Send Notification
    if (title && providerId) {
      const { error: notifError } = await supabaseAdmin.from('notifications').insert({
        user_id: providerId,
        title: title,
        message: message,
        type: 'service_review', // This triggers the purple badge icon in your app
        reference_id: service.id,
        is_read: false
      });

      if (notifError) {
        console.error("Failed to send notification:", notifError.message);
      }
    }

    res.json({ message: `Service marked as ${status}`, service: service });

  } catch (error) {
    console.error("Review Error:", error);
    res.status(500).json({ error: error.message });
  }
});
router.get('/activities/chart', async (req, res) => {
  const { period } = req.query; // 'monthly', 'weekly', 'yearly'

  try {
    let startDate;
    const now = new Date();

    // 1. Determine Date Filter
    if (period === 'weekly') startDate = startOfWeek(now);
    else if (period === 'yearly') startDate = startOfYear(now);
    else startDate = startOfMonth(now); // Default Monthly

    // 2. Fetch Services created after start date
    const { data: services, error } = await supabaseAdmin
      .from('services')
      .select('category_id, service_categories(name)')
      .gte('created_at', startDate.toISOString());

    if (error) throw error;

    // 3. Aggregate Data in JS (Easier than complex SQL grouping)
    const stats = {};
    services.forEach(item => {
      const catName = item.service_categories?.name || 'Uncategorized';
      stats[catName] = (stats[catName] || 0) + 1;
    });

    // 4. Format for Frontend Chart
    const chartData = Object.keys(stats).map(key => ({
      name: key,
      value: stats[key]
    }));

    res.json(chartData);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 5. GET /admin/bookings/all
 * Logic: Fetch all bookings for the "Recent Orders" table
 */
router.get('/bookings/all', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('bookings')
      .select(`
        *,
        profiles!client_id(full_name, id),
        services(title, service_categories(name), profiles:provider_id(full_name))
      `)
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ... existing imports ...

// --- CATEGORY MANAGEMENT ---

// GET All Categories
router.get('/categories', async (req, res) => {
  try {
    // Fetch all categories (no complex join needed, frontend can filter)
    const { data, error } = await supabaseAdmin
      .from('service_categories')
      .select('*') // Just get everything
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST Create Category (Fixed field name)
router.post('/categories', async (req, res) => {
  const { name, description, image_url, parent_id } = req.body; 
  
  try {
    if (!name) return res.status(400).json({ error: "Category Name is required" });

    const payload = { 
      name, 
      description: description || '', 
      image_url: image_url || null,
      // CRITICAL FIX: Use 'parent_category_id' to match your database column
      parent_category_id: parent_id || null 
    };

    const { data, error } = await supabaseAdmin
      .from('service_categories')
      .insert(payload)
      .select()
      .single();

    if (error) throw error;
    res.json(data);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// DELETE Category
router.delete('/categories/:id', async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from('service_categories')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// --- ADMIN MANAGEMENT ---

// GET Other Admins
router.get('/users/admins', async (req, res) => {
  try {
    // Fetch profiles where role is admin, excluding current user is handled in frontend usually
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('role', 'admin');
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST Create New Admin (Super Admin Action)
router.post('/users/invite-admin', async (req, res) => {
  const { email, password, full_name } = req.body;
  
  try {
    // 1. Create Auth User
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true
    });

    if (authError) throw authError;

    // 2. Update Profile to be Admin
    const { error: profileError } = await supabaseAdmin
      .from('profiles')
      .update({ role: 'admin', full_name: full_name })
      .eq('id', authData.user.id);

    if (profileError) throw profileError;

    res.json({ message: 'Admin created successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE Remove Admin
router.delete('/users/admins/:id', async (req, res) => {
  // logic to delete user or downgrade role
  try {
    const { error } = await supabaseAdmin.auth.admin.deleteUser(req.params.id);
    if (error) throw error;
    res.json({ message: 'Admin removed' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});



module.exports = router;