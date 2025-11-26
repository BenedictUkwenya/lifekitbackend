// index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');

// Import route modules
const authRoutes = require('./src/routes/authRoutes');
const userRoutes = require('./src/routes/userRoutes');
const serviceRoutes = require('./src/routes/serviceRoutes');
const homeRoutes = require('./src/routes/homeRoutes');
const storageRoutes = require('./src/routes/storageRoutes');
const bookingRoutes = require('./src/routes/bookingRoutes'); 
const walletRoutes = require('./src/routes/walletRoutes');
const { supabase } = require('./src/config/supabase'); // For health check
const chatRoutes = require('./src/routes/chatRoutes');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// --- Simple Test & Health Check Routes ---
app.get('/', (req, res) => {
  res.status(200).send('Lifekit Backend server is running!');
});

app.get('/api/supabase-status', async (req, res) => {
  try {
    const { data, error } = await supabase.from('profiles').select('id').limit(1); // Test database connection
    if (error) throw error;
    res.status(200).json({ message: 'Supabase connection successful!', db_test: data.length > 0 ? 'Data read success' : 'DB empty' });
  } catch (error) {
    res.status(500).json({ message: 'Supabase connection failed', error: error.message });
  }
});

// --- Use Route Modules: Define the Base Paths ---
app.use('/auth', authRoutes);     // Handles: /auth/signup, /auth/login, etc.
app.use('/users', userRoutes);    // Handles: /users/profile, /users/notifications, etc.
app.use('/services', serviceRoutes); // Handles: /services (POST), /services/:id, etc.
app.use('/home', homeRoutes);     // Handles: /home/offers, /home/search, /home/categories, etc.
app.use('/bookings', bookingRoutes);
app.use('/storage', storageRoutes);
app.use('/wallet', walletRoutes);
app.use('/chats', chatRoutes);     // Handles: /chat (GET conversations), /chat/:bookingId/messages, etc.
// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Supabase URL: ${process.env.SUPABASE_URL}`);
  console.log('Backend architecture is now fully refactored and modular.');
});