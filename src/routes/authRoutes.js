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
/**
 * POST /auth/signup
 * Handles user registration with a pre-signup duplicate email check.
 */
router.post('/signup', async (req, res) => {
  // 1. Deconstruct inputs
  let { email, password, confirm_password, full_name, is_provider_signup, is_web_signup } = req.body;

  // --- SANITIZATION ---
  if (email) {
    email = email.trim().toLowerCase(); // Remove accidental spaces and normalize case
  }

  // --- VALIDATION ---
  
  // A. Check Required Fields
  if (!email || !password || !full_name) {
    return res.status(400).json({ error: 'Email, password, and Full Name are required.' });
  }

  // B. Check Email Format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid email address format.' });
  }

  // C. Check Password Length
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
  }

  // D. Check Password Match
  if (confirm_password !== undefined && password !== confirm_password) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }

  try {
    // --- STEP 1: CHECK DUPLICATE EMAIL (PRE-SIGNUP) ---
    // We use listUsers to search for this email. 
    // Note: listUsers is an Admin function, so we use supabaseAdmin.
    const { data: existingUsers, error: checkError } = await supabaseAdmin.auth.admin.listUsers();
    
    if (checkError) {
      console.error('Error checking existing users:', checkError.message);
      throw checkError;
    }

    // Filter the list to find a match
    const userExists = existingUsers.users.some(u => u.email === email);

    if (userExists) {
        return res.status(409).json({ error: 'Email is already registered. Please login.' });
    }

    // --- STEP 2: SUPABASE AUTH SIGNUP ---
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

    // --- STEP 3: PROFILE CREATION SAFETY NET ---
    // Manually create/update the profile row immediately using Admin privileges.
    // This ensures the row exists in 'public.profiles' with the required full_name.
    if (data.user) {
        // Early-adopter strategy: web provider signups get Pro tier free for 1 year
        const isEarlyAdopterProvider = is_provider_signup === true && is_web_signup === true;

        // All normal app signups get a 90-day Pro trial (3% commission, up to 5 services)
        const trialEndDate = !isEarlyAdopterProvider
            ? new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
            : null;

        const profilePayload = {
            id: data.user.id,
            email: email,
            full_name: full_name,
            is_service_provider: isEarlyAdopterProvider ? true : false,
            subscription_tier: isEarlyAdopterProvider ? 'pro' : 'free',
            is_founding_member: true,
            ...(isEarlyAdopterProvider && {
                subscription_expiry: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
            }),
            ...(trialEndDate && {
                trial_end_date: trialEndDate,
            }),
        };

        const { error: profileError } = await supabaseAdmin
            .from('profiles')
            .upsert(profilePayload);
            
        if (profileError) {
            // Log a warning but don't fail the request (Database Trigger might have already handled it)
            console.warn("Manual profile creation warning:", profileError.message);
        }
    }

    res.status(200).json({
      message: 'Registration successful! Please check your email for confirmation.',
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
 * Accepts optional redirect_to, or source ('web' | 'mobile') to pick the right redirect URL.
 */
router.post('/forgot-password', async (req, res) => {
  const { email, redirect_to, source } = req.body;

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }

  const MOBILE_REDIRECT = 'io.supabase.lifekit://reset-password';
  const WEB_REDIRECT_DEFAULT =
    process.env.PROVIDER_WEB_RESET_URL || 'https://www.lifekithub.com/reset-password';

  const redirectTo =
    redirect_to || (source === 'mobile' ? MOBILE_REDIRECT : WEB_REDIRECT_DEFAULT);

  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
      redirectTo,
    });

    if (error) {
      console.error('Supabase forgot password error:', error.message);
      return res.status(400).json({ error: error.message });
    }

    res.status(200).json({
      message: 'If an account with that email exists, a password reset link has been sent.',
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
  const { new_password, access_token, refresh_token, code } = req.body;

  if (!new_password) {
    return res.status(400).json({ error: 'New password is required.' });
  }

  if (!access_token && !code) {
    return res.status(400).json({ error: 'Reset link is invalid or expired. Please request a new one.' });
  }

  if (new_password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabaseClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      }
    );

    if (code) {
      const { data: exchangeData, error: exchangeError } =
        await supabaseClient.auth.exchangeCodeForSession(code);

      if (exchangeError || !exchangeData.session) {
        console.error('Supabase code exchange error:', exchangeError?.message);
        return res.status(400).json({
          error: exchangeError?.message || 'Reset link is invalid or expired. Please request a new one.',
        });
      }
    } else {
      const { data: sessionData, error: sessionError } = await supabaseClient.auth.setSession({
        access_token,
        refresh_token: refresh_token || '',
      });

      if (sessionError || !sessionData.session) {
        console.error('Supabase setSession error:', sessionError?.message);
        return res.status(400).json({
          error: sessionError?.message || 'Reset link is invalid or expired. Please request a new one.',
        });
      }
    }

    const { data, error } = await supabaseClient.auth.updateUser({ password: new_password });

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

/**
 * 8. POST /auth/refresh-token
 * Uses the long-lived refresh_token to get a new access_token
 */
router.post('/refresh-token', async (req, res) => {
  const { refresh_token } = req.body;

  if (!refresh_token) {
    return res.status(400).json({ error: 'Refresh token is required' });
  }

  try {
    const { data, error } = await supabase.auth.refreshSession({ 
      refresh_token 
    });

    if (error) {
      // If refresh fails (e.g. user revoked, or refresh token expired), return 403
      return res.status(403).json({ error: 'Session expired. Please login again.' });
    }

    // Return the new pair of tokens
    res.status(200).json({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    });

  } catch (error) {
    console.error("Refresh Error:", error);
    res.status(500).json({ error: error.message });
  }
});


/**
 * 10. PUT /auth/update-password
 * SECURE VERSION: Verifies old password before updating to new one.
 */
router.put('/update-password', authenticateToken, async (req, res) => {
  const { current_password, new_password } = req.body;
  const userId = req.user.id;

  if (!current_password || !new_password || new_password.length < 6) {
    return res.status(400).json({ error: 'Current password and a valid new password (min 6 chars) are required.' });
  }

  try {
    // 1. Get user's email from the profiles table
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('email')
      .eq('id', userId)
      .single();

    if (profileError || !profile) return res.status(404).json({ error: "User profile not found." });

    // 2. VERIFY CURRENT PASSWORD
    // We attempt to sign in with the current credentials to prove the user knows the old password
    const { error: verifyError } = await supabase.auth.signInWithPassword({
      email: profile.email,
      password: current_password,
    });

    if (verifyError) {
      return res.status(401).json({ error: 'Current password incorrect. Verification failed.' });
    }

    // 3. PROCEED WITH UPDATE using Admin Client
    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
      userId,
      { password: new_password }
    );

    if (updateError) {
      return res.status(400).json({ error: updateError.message });
    }

    res.status(200).json({ message: 'Password updated successfully!' });

  } catch (error) {
    console.error('Password Update Error:', error.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * POST /auth/ensure-social-profile
 * Called after OAuth sign-in to upsert a profile row for social users.
 * Requires a valid Supabase access token in the Authorization header.
 */
router.post('/ensure-social-profile', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.split(' ')[1];

  // Verify the token with Supabase
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }

  const fullName =
    user.user_metadata?.full_name ||
    user.user_metadata?.name ||
    user.email?.split('@')[0] ||
    'LifeKit User';
  const avatarUrl =
    user.user_metadata?.avatar_url ||
    user.user_metadata?.picture ||
    null;

  // Upsert profile – ignoreDuplicates prevents overwriting existing data
  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .upsert(
      {
        id: user.id,
        full_name: fullName,
        email: user.email,
        profile_picture_url: avatarUrl,
        is_founding_member: true,
        trial_end_date: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      },
      { onConflict: 'id', ignoreDuplicates: true }
    );

  if (profileError) {
    console.error('Social profile upsert error:', profileError.message);
  }

  return res.status(200).json({ success: true, user_id: user.id });
});

module.exports = router;