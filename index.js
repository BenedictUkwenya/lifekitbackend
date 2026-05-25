require('dotenv').config();
const express = require('express');
const cors = require('cors'); // Make sure this is installed

// Import route modules
const authRoutes = require('./src/routes/authRoutes');
const userRoutes = require('./src/routes/userRoutes');
const serviceRoutes = require('./src/routes/serviceRoutes');
const homeRoutes = require('./src/routes/homeRoutes');
const placeRoutes = require('./src/routes/placeRoutes'); 
const storageRoutes = require('./src/routes/storageRoutes');
const bookingRoutes = require('./src/routes/bookingRoutes'); 
const walletRoutes = require('./src/routes/walletRoutes');
const adminRoutes = require('./src/routes/adminRoutes'); // Don't forget this!
const supportRoutes = require('./src/routes/supportRoutes');
const { supabase } = require('./src/config/supabase'); 
const eventRoutes = require('./src/routes/eventRoutes');
const feedRoutes = require('./src/routes/feedRoutes');
const chatRoutes = require('./src/routes/chatRoutes'); 
const upgradeRoutes = require('./src/routes/upgradeRoutes');

const reviewRoutes = require('./src/routes/reviewRoutes');
const aiRoutes = require('./src/routes/aiRoutes');
const swapRoutes = require('./src/routes/swapRoutes');
const cronRoutes = require('./src/routes/cronRoutes');
// ...


const app = express();

// --- IMPORTANT: CORS CONFIGURATION ---
const allowedOrigins = [
  'https://lifekithub.com',
  'https://www.lifekithub.com',
  'https://admin.lifekithub.com',
  'http://localhost:5173',
  'http://localhost:5174'
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like Mobile apps and cURL)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      var msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept-Language']
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
app.use('/places', placeRoutes); 
app.use('/bookings', bookingRoutes);
app.use('/storage', storageRoutes);
app.use('/wallet', walletRoutes);
app.use('/admin', adminRoutes); // <--- Ensure Admin routes are registered
app.use('/support', supportRoutes);
app.use('/events', eventRoutes);
app.use('/feeds', feedRoutes);
app.use('/chats', chatRoutes); 
app.use('/reviews', reviewRoutes);
app.use('/upgrades', upgradeRoutes);
app.use('/ai', aiRoutes);
app.use('/swap-requests', swapRoutes);
app.use('/cron', cronRoutes);


// --- SERVER STARTUP (Modified for Vercel) ---

// Only run in development. Vercel handles startup automatically via the exported 'app'.
// Use http.createServer directly so the server reference is kept in scope and the
// event loop stays alive (Express 5 app.listen() returns a Promise and can exit early).
if (process.env.NODE_ENV !== 'production') {
  const http = require('http');
  const PORT = parseInt(process.env.PORT, 10) || 3000;
  const server = http.createServer(app);
  server.listen(PORT, () => {
    console.log(`Server running locally on port ${PORT}`);
    console.log(`Supabase URL: ${process.env.SUPABASE_URL}`);
  });
  server.on('error', (err) => {
    console.error('Server error:', err.message);
  });
}

// Export the app for Vercel (Serverless function entry point)
module.exports = app;
