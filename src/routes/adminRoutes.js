const express = require('express');
const router = express.Router();
// CRITICAL: Import supabaseAdmin to bypass RLS for Admin views
const { supabaseAdmin } = require('../config/supabase'); 
const authenticateAdmin = require('../middleware/adminMiddleware');
// ADDED: subMonths and format are needed for the charts
const { startOfMonth, startOfWeek, startOfYear, subMonths, format } = require('date-fns');

// Apply Admin Security to all routes
router.use(authenticateAdmin);

const COMMISSION_RATE = 0.20; // 20% commission

/**
 * =========================================================================
 * 1. NEW: GET /admin/analytics (THE HEAVY LIFTER)
 * Fetches all complex data for the Analytics Dashboard in one request.
 * =========================================================================
 */
router.get('/analytics', async (req, res) => {
  try {
    const today = new Date();
    const sixMonthsAgo = subMonths(today, 6).toISOString();

    // 1. FETCH RAW DATA (Parallel requests for speed)
    const [transactionsRes, bookingsRes, profilesRes, servicesRes, withdrawalsRes] = await Promise.all([
      // A. All successful payments (Income)
      supabaseAdmin.from('transactions').select('amount, created_at').eq('type', 'payment').eq('status', 'success'),
      
      // B. All bookings (for counts & chart)
      supabaseAdmin.from('bookings').select('created_at').gte('created_at', sixMonthsAgo),
      
      // C. All profiles (for Demographics/Devices)
      supabaseAdmin.from('profiles').select('country, signup_platform'), 
      
      // D. Services (for Category breakdown)
      supabaseAdmin.from('services').select('price, service_categories(name)'),

      // E. Admin Withdrawals (To calculate available balance)
      supabaseAdmin.from('transactions').select('amount').eq('type', 'admin_withdrawal')
    ]);

    if (transactionsRes.error) throw transactionsRes.error;

    // 2. CALCULATE TOP CARDS
    const totalRevenue = transactionsRes.data.reduce((sum, t) => sum + Number(t.amount), 0);
    const totalWithdrawals = withdrawalsRes.data.reduce((sum, t) => sum + Math.abs(Number(t.amount)), 0);
    
    // Logic: Your profit is 20% of total revenue
    const grossProfit = totalRevenue * COMMISSION_RATE; 
    // Available to withdraw = Profit - What you already took out
    const availableBalance = grossProfit - totalWithdrawals;

    // 3. CALCULATE MAIN CHART DATA (Revenue vs Bookings per Month)
    const chartMap = {};
    
    // Initialize last 6 months in the map
    for (let i = 5; i >= 0; i--) {
        const d = subMonths(new Date(), i);
        const key = format(d, 'MMM');
        chartMap[key] = { name: key, revenue: 0, bookings: 0 };
    }

    // Fill Revenue
    transactionsRes.data.forEach(t => {
        const key = format(new Date(t.created_at), 'MMM');
        if (chartMap[key]) {
            chartMap[key].revenue += (Number(t.amount) * COMMISSION_RATE); 
        }
    });

    // Fill Bookings Count
    bookingsRes.data.forEach(b => {
        const key = format(new Date(b.created_at), 'MMM');
        if (chartMap[key]) chartMap[key].bookings += 1;
    });

    const chartData = Object.values(chartMap);

    // 4. CALCULATE DEMOGRAPHICS (Countries)
    const countryStats = {};
    profilesRes.data.forEach(p => {
        const c = p.country || 'Unknown'; 
        countryStats[c] = (countryStats[c] || 0) + 1;
    });
    
    const countryData = Object.keys(countryStats)
        .map(key => ({ country: key, users: countryStats[key] }))
        .sort((a,b) => b.users - a.users) // Sort highest first
        .slice(0, 5); // Top 5

    // 5. CALCULATE DEVICE STATS
    const deviceStats = { iOS: 0, Android: 0, Web: 0 };
    profilesRes.data.forEach(p => {
        const platform = p.signup_platform || 'Web';
        if (deviceStats[platform] !== undefined) deviceStats[platform]++;
        else deviceStats['Web']++; // Default bucket
    });
    const deviceData = [
        { name: 'iOS App', value: deviceStats.iOS, color: '#89273B' },
        { name: 'Android', value: deviceStats.Android, color: '#D4AF37' },
        { name: 'Web', value: deviceStats.Web, color: '#E5E7EB' },
    ];

    // 6. CALCULATE CATEGORY BREAKDOWN
    const categoryStats = {};
    servicesRes.data.forEach(s => {
        const catName = s.service_categories?.name || 'Other';
        categoryStats[catName] = (categoryStats[catName] || 0) + 1;
    });
    const categoryData = Object.keys(categoryStats).map((key, index) => ({
        name: key,
        value: categoryStats[key],
        color: ['#89273B', '#D4AF37', '#FF8042', '#0088FE', '#00C49F'][index % 5]
    }));

    // FINAL RESPONSE
    res.json({
        cards: {
            total_revenue: totalRevenue,
            net_profit: grossProfit,
            available_balance: availableBalance,
            total_bookings: bookingsRes.data.length,
            total_users: profilesRes.data.length
        },
        chart: chartData,
        demographics: countryData,
        categories: categoryData,
        device_stats: deviceData
    });

  } catch (error) {
    console.error("Analytics Error:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * =========================================================================
 * 2. NEW: POST /admin/withdraw
 * Records a withdrawal of company profits.
 * =========================================================================
 */
router.post('/withdraw', async (req, res) => {
    const { amount, destination } = req.body; 

    try {
        if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });

        // Insert Withdrawal Record
        const { data, error } = await supabaseAdmin
            .from('transactions')
            .insert({
                wallet_id: null, // Null because it's the System/Admin wallet
                type: 'admin_withdrawal',
                amount: -amount, // Negative because money is leaving
                status: 'success',
                description: `Admin Payout to ${destination || 'Bank'}`
            })
            .select()
            .single();

        if (error) throw error;
        res.json({ message: "Withdrawal recorded successfully", transaction: data });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


/**
 * =========================================================================
 * 3. EXISTING UTILITY ROUTES (Maintained for other screens)
 * =========================================================================
 */

// GET /admin/stats (Simplified version used by Dashboard)
router.get('/stats', async (req, res) => {
  try {
    const [revenue, bookings, pendingServices, users] = await Promise.all([
      supabaseAdmin.from('transactions').select('amount').eq('type', 'payment'), 
      supabaseAdmin.from('bookings').select('*', { count: 'exact', head: true }),
      supabaseAdmin.from('services').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabaseAdmin.from('profiles').select('*', { count: 'exact', head: true })
    ]);

    const totalMoney = revenue.data?.reduce((acc, curr) => acc + Math.abs(Number(curr.amount)), 0) || 0;

    res.json({
      total_revenue: totalMoney,
      total_bookings: bookings.count || 0,
      pending_reviews: pendingServices.count || 0,
      total_users: users.count || 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /admin/services-queue
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

// PUT /admin/review-service/:id
router.put('/review-service/:id', async (req, res) => {
  const { id } = req.params;
  const { status, reason } = req.body;

  try {
    const { data: service, error } = await supabaseAdmin
      .from('services')
      .update({ status: status })
      .eq('id', id)
      .select().single();

    if (error) throw error;

    const providerId = service.provider_id; 
    let title = status === 'active' ? 'Service Approved! 🎉' : 'Service Rejected ⚠️';
    let message = status === 'active' 
        ? `Your service "${service.title}" is now live.` 
        : `Your service "${service.title}" was rejected. Reason: ${reason}`;

    if (title && providerId) {
      await supabaseAdmin.from('notifications').insert({
        user_id: providerId, title, message, type: 'service_review', reference_id: service.id
      });
    }

    res.json({ message: `Service marked as ${status}`, service });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /activities/chart (For Activities Page)
router.get('/activities/chart', async (req, res) => {
  const { period } = req.query; // 'monthly', 'weekly', 'yearly'
  try {
    let startDate;
    const now = new Date();
    if (period === 'weekly') startDate = startOfWeek(now);
    else if (period === 'yearly') startDate = startOfYear(now);
    else startDate = startOfMonth(now); 

    const { data: services, error } = await supabaseAdmin
      .from('services')
      .select('category_id, service_categories(name)')
      .gte('created_at', startDate.toISOString());

    if (error) throw error;

    const stats = {};
    services.forEach(item => {
      const catName = item.service_categories?.name || 'Uncategorized';
      stats[catName] = (stats[catName] || 0) + 1;
    });

    const chartData = Object.keys(stats).map(key => ({ name: key, value: stats[key] }));
    res.json(chartData);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /admin/bookings/all
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

// GET /admin/categories
router.get('/categories', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('service_categories')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /admin/categories
router.post('/categories', async (req, res) => {
  const { name, description, image_url, parent_id } = req.body; 
  try {
    if (!name) return res.status(400).json({ error: "Category Name is required" });
    const payload = { 
      name, description: description || '', image_url: image_url || null, parent_category_id: parent_id || null 
    };
    const { data, error } = await supabaseAdmin.from('service_categories').insert(payload).select().single();
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /admin/categories/:id
router.delete('/categories/:id', async (req, res) => {
  try {
    const { error } = await supabaseAdmin.from('service_categories').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /admin/users/admins
router.get('/users/admins', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('profiles').select('*').eq('role', 'admin');
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /admin/users/invite-admin
router.post('/users/invite-admin', async (req, res) => {
  const { email, password, full_name } = req.body;
  try {
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email, password, email_confirm: true
    });
    if (authError) throw authError;

    const { error: profileError } = await supabaseAdmin
      .from('profiles').update({ role: 'admin', full_name }).eq('id', authData.user.id);
    if (profileError) throw profileError;

    res.json({ message: 'Admin created successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /admin/users/admins/:id
router.delete('/users/admins/:id', async (req, res) => {
  try {
    const { error } = await supabaseAdmin.auth.admin.deleteUser(req.params.id);
    if (error) throw error;
    res.json({ message: 'Admin removed' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// THIS MUST BE THE LAST LINE
module.exports = router;