require('dotenv').config();
const express = require('express');
const cors = require('cors'); // Make sure this is installed

// Import route modules
const authRoutes = require('./src/routes/authRoutes');
const userRoutes = require('./src/routes/userRoutes');
const serviceRoutes = require('./src/routes/serviceRoutes');
const homeRoutes = require('./src/routes/homeRoutes');
const storageRoutes = require('./src/routes/storageRoutes');
const bookingRoutes = require('./src/routes/bookingRoutes'); 
const walletRoutes = require('./src/routes/walletRoutes');
const adminRoutes = require('./src/routes/adminRoutes'); // Don't forget this!
const { supabase } = require('./src/config/supabase'); 
const eventRoutes = require('./src/routes/eventRoutes');
const feedRoutes = require('./src/routes/feedRoutes');
const chatRoutes = require('./src/routes/chatRoutes'); 

const reviewRoutes = require('./src/routes/reviewRoutes');
// ...


const app = express();

// --- IMPORTANT: CORS CONFIGURATION ---
// This allows your React App (on port 5173) to talk to this Backend
app.use(cors({
  origin: '*', // Allow ALL origins (Easiest for development)
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Middleware for JSON
app.use(express.json());

// --- Simple Test & Health Check Routes ---
app.get('/', (req, res) => {
  res.status(200).send('Lifekit Backend server is running!');
});

// --- Use Route Modules ---
app.use('/auth', authRoutes);
app.use('/users', userRoutes);
app.use('/services', serviceRoutes);
app.use('/home', homeRoutes);
app.use('/bookings', bookingRoutes);
app.use('/storage', storageRoutes);
app.use('/wallet', walletRoutes);
app.use('/admin', adminRoutes); // <--- Ensure Admin routes are registered
app.use('/events', eventRoutes);
app.use('/feeds', feedRoutes);
app.use('/chats', chatRoutes); 
app.use('/reviews', reviewRoutes);


// --- SERVER STARTUP (Modified for Vercel) ---

// Only run app.listen if we are NOT in production (i.e. running locally)
// Vercel handles the server start automatically via the exported 'app'
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running locally on port ${PORT}`);
    console.log(`Supabase URL: ${process.env.SUPABASE_URL}`);
  });
}

// Export the app for Vercel (Serverless function entry point)
module.exports = app;