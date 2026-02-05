// src/routes/authRoutes.js
const express = require('express');
const router = express.Router();
// Import the Supabase client initialized in config/supabase.js
const { supabase, supabaseAdmin } = require('../config/supabase');
const authenticateToken = require('../middleware/authMiddleware');
// --- Authentication Endpoints ---

/**
 * 1. POST /auth/signup
 * Handles user registration with Email and Password.
 * Supabase automatically sends a confirmation email (Magic Link).
 */
/**
 * 1. POST /auth/signup
 * Handles user registration.
 * FIX: Enforces full_name and creates profile row immediately to prevent DB errors.
 */
/**
 * 1. POST /auth/signup
 * Handles user registration.
 * FEATURES:
 * - Sanitizes email (removes spaces, lowercases)
 * - Validates email format via Regex
 * - Checks password length & matching
 * - Creates Profile row immediately to prevent "null value" DB errors
 */
router.post('/signup', async (req, res) => {
  // 1. Deconstruct inputs (Use 'let' for email so we can clean it)
  let { email, password, confirm_password, full_name } = req.body;

  // --- SANITIZATION ---
  if (email) {
    email = email.trim().toLowerCase(); // Remove accidental spaces
  }

  // --- VALIDATION ---
  
  // A. Check Required Fields
  if (!email || !password || !full_name) {
    return res.status(400).json({ error: 'Email, password, and Full Name are required.' });
  }

  // B. Check Email Format (Prevents "invalid format" errors from Supabase)
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid email address format.' });
  }

  // C. Check Password Length
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
  }

  // D. Check Password Match (If frontend sends confirm_password)
  if (confirm_password !== undefined && password !== confirm_password) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }

  try {
    // --- SUPABASE AUTH ---
    const { data, error } = await supabase.auth.signUp({
      email: email,
      password: password,
      options: {
        // Save name in Auth Metadata as a backup
        data: {
          full_name: full_name, 
        },
      }
    });

    if (error) {
      console.error('Supabase signup error:', error.message);
      return res.status(400).json({ error: error.message });
    }

    // --- PROFILE CREATION SAFETY NET ---
    // Manually create the profile row immediately using Admin privileges.
    // This ensures the row exists in 'public.profiles' with the required full_name
    // before any subsequent calls try to update it.
    if (data.user) {
        const { error: profileError } = await supabaseAdmin
            .from('profiles')
            .upsert({
                id: data.user.id,
                email: email,
                full_name: full_name // <--- This satisfies the Not-Null constraint
            });
            
        if (profileError) {
            // We log a warning but don't fail the request, in case a Database Trigger 
            // handled it faster than this code did.
            console.warn("Manual profile creation warning:", profileError.message);
        }
    }

    res.status(200).json({
      message: 'Registration successful! Please check your email.',
      user_id: data.user?.id,
      email: email,
    });

  } catch (error) {
    console.error('Unexpected signup error:', error.message);
    res.status(500).json({ error: 'Internal server error during signup.' });
  }
});/**
 * 2. GET a/auth/confirm-email
 * Target for Supabase's email confirmation link redirect.
 * This is a minimal backend endpoint. Frontend deep-linking would be more robust.
 */
router.get('/confirm-email', async (req, res) => {
  // Supabase has already handled the token exchange via this redirect.
  res.status(200).send('Email confirmed! You can now log in to your app.');
});


/**
 * 3. POST /auth/login
 * Handles user sign-in with Email and Password.
 *//**
 * 3. POST /auth/login
 * Handles user sign-in with Email and Password.
 */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    // 1. Sign in the user
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email,
      password: password,
    });

    if (error) {
      // Supabase usually returns "Email not confirmed" here if settings are correct
      return res.status(401).json({ error: error.message });
    }

    // 2. EXTRA SECURITY CHECK: Ensure email is verified
    // Sometimes Supabase allows login but marks user as unverified. Let's block that.
    if (!data.user.email_confirmed_at) {
      return res.status(403).json({ 
        error: 'Email not verified. Please verify your email before logging in.',
        isUnverified: true // Flag for frontend
      });
    }

    // 3. Create or Update profile (Existing logic...)
    const { error: profileError } = await supabase
      .from('profiles')
      .upsert(
        { 
          id: data.user.id, 
          email: data.user.email, 
          full_name: data.user.user_metadata.full_name || null 
        },
        { onConflict: 'id' }
      );

    if (profileError && profileError.code !== 'PGRST116') {
      console.error('Error creating/updating profile:', profileError.message);
    }

    // 4. Fetch Profile (Existing logic...)
    const { data: fetchedProfile } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', data.user.id)
      .single();

    return res.status(200).json({
      message: 'Login successful!',
      user: data.user,
      session: data.session,
      profile: fetchedProfile || null,
    });

  } catch (error) {
    console.error('Unexpected login error:', error.message);
    res.status(500).json({ error: 'Internal server error during login.' });
  }
});
/**
 * 4. POST /auth/forgot-password
 * Sends a password reset link to the user's email.
 */
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required.' });
  }

  try {
    // Supabase sends a password reset email
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      // The URL the user is redirected to after clicking the reset link
      redirectTo: 'http://localhost:3000/auth/reset-password' 
    });

    if (error) {
      console.error('Supabase forgot password error:', error.message);
      return res.status(400).json({ error: error.message });
    }

    res.status(200).json({
      message: 'Password reset email sent! Check your inbox for instructions.',
    });

  } catch (error) {
    console.error('Unexpected forgot password error:', error.message);
    res.status(500).json({ error: 'Internal server error during forgot password.' });
  }
});

/**
 * 5. GET /auth/reset-password
 * Target for Supabase's password reset link redirect.
 * Fetches the required access_token from the URL query.
 */
router.get('/reset-password', async (req, res) => {
  const { type, access_token } = req.query; 

  if (type === 'recovery' && access_token) {
    // In a real application, this is where the frontend would capture the access_token 
    // and show a form for the new password.
    res.status(200).send(`You are on the password reset page. Please provide a new password. Access Token: ${access_token}`);
  } else {
    res.status(400).send('Invalid password reset link.');
  }
});

/**
 * 6. POST /auth/reset-password
 * Finalizes the password reset by applying the new password using the access token.
 */
router.post('/reset-password', async (req, res) => {
  const { new_password, access_token } = req.body; 

  if (!new_password || !access_token) {
    return res.status(400).json({ error: 'New password and access token are required.' });
  }

  try {
    // 1. Set the session with the temporary access_token from the reset link
    await supabase.auth.setSession({ access_token: access_token, refresh_token: '' }); 

    // 2. Update the user's password using the active session
    const { data, error } = await supabase.auth.updateUser({ password: new_password });

    if (error) {
      console.error('Supabase update password error:', error.message);
      return res.status(400).json({ error: error.message });
    }

    res.status(200).json({
      message: 'Password successfully updated! You can now log in with your new password.',
      user: data.user,
    });

  } catch (error) {
    console.error('Unexpected password reset error:', error.message);
    res.status(500).json({ error: 'Internal server error during password reset.' });
  }
});

/**
 * 7. POST /auth/verify-otp
 * Verifies the Email OTP code sent by Supabase
 */
router.post('/verify-otp', async (req, res) => {
  const { email, token } = req.body;

  if (!email || !token) {
    return res.status(400).json({ error: 'Email and Token (OTP) are required.' });
  }

  try {
    const { data, error } = await supabase.auth.verifyOtp({
      email,
      token,
      type: 'signup' // or 'email'
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(200).json({
      message: 'Email verified successfully!',
      session: data.session,
      user: data.user
    });

  } catch (error) {
    console.error('OTP Verification Error:', error.message);
    res.status(500).json({ error: 'Internal server error verifying OTP.' });
  }
});


router.post('/logout', authenticateToken, async (req, res) => {
  try {
    const { error } = await supabase.auth.signOut();
    
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.status(200).json({ message: 'Logged out successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;