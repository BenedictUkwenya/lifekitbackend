const express = require('express');
const router = express.Router();
// IMPORT supabaseAdmin HERE
const { supabase, supabaseAdmin } = require('../config/supabase'); 
const authenticateToken = require('../middleware/authMiddleware');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Helper: Get or Create Wallet (Using Admin to bypass RLS for creation)
// Helper: Get or Create Wallet (Using Admin to bypass RLS for BOTH read and write)
async function getOrCreateWallet(userId, email) {
  // 1. Try fetching with ADMIN client to guarantee we see it if it exists
  let { data: wallet, error } = await supabaseAdmin
    .from('wallets')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle(); // Use maybeSingle() instead of single() to avoid errors if empty

  // 2. If wallet exists, return it immediately
  if (wallet) {
    return wallet;
  }

  // 3. IF NOT FOUND: Create a Customer in Stripe
  const customer = await stripe.customers.create({ email: email });
    
  // 4. Create the wallet using ADMIN
  const { data: newWallet, error: insertError } = await supabaseAdmin
    .from('wallets')
    .insert({ 
      user_id: userId, 
      balance: 0.00, 
      stripe_customer_id: customer.id 
    })
    .select()
    .single();
      
  if (insertError) {
    // Edge case: Concurrency handling (if two requests came in at exact same time)
    if (insertError.code === '23505') { 
      // 23505 is the code for unique_violation
      // Fetch one last time
      const { data: existingRetry } = await supabaseAdmin
        .from('wallets')
        .select('*')
        .eq('user_id', userId)
        .single();
      return existingRetry;
    }
    throw insertError;
  }
  
  return newWallet;
}
/**
 * Credit a succeeded wallet-deposit PaymentIntent exactly once.
 * The DB function records the transaction and adds to the balance in one
 * atomic step (unique on stripe_payment_id), so the app's confirm call and
 * the Stripe webhook can both arrive — even simultaneously — safely.
 * @returns {Promise<boolean>} true if credited now, false if already credited
 */
async function creditDeposit(paymentIntent) {
  const walletId = paymentIntent.metadata?.walletId;
  if (!walletId) throw new Error('PaymentIntent has no walletId metadata');
  const { data, error } = await supabaseAdmin.rpc('credit_wallet_deposit', {
    p_payment_id: paymentIntent.id,
    p_wallet_id: walletId,
    p_amount: paymentIntent.amount / 100,
  });
  if (error) throw error;
  return data === true;
}

/**
 * POST /wallet/stripe-webhook — Stripe calls this when a payment succeeds,
 * so a deposit is credited even if the app closed before confirming.
 * Mounted in index.js with express.raw() BEFORE express.json(): the
 * signature check needs the exact raw body.
 */
async function stripeWebhook(req, res) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: 'Webhook not configured' });

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);
  } catch (err) {
    return res.status(400).json({ error: `Invalid signature: ${err.message}` });
  }

  try {
    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object;
      if (pi.metadata?.type === 'wallet_deposit') {
        await creditDeposit(pi);
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Stripe webhook error:', err.message);
    // 500 makes Stripe retry later — crediting is idempotent, so that's safe.
    res.status(500).json({ error: 'Webhook handling failed' });
  }
}

/**
 * 1. GET /wallet - Dashboard
 */
router.get('/', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const email = req.user.email;

  try {
    const wallet = await getOrCreateWallet(userId, email);
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('is_service_provider, stripe_connect_id')
      .eq('id', userId)
      .single();

    // Admin client: the anon client has no user session here, so row security
    // hid every transaction. Scoped to this user's wallet id.
    const { data: transactions } = await supabaseAdmin
      .from('transactions')
      .select('*')
      .eq('wallet_id', wallet.id)
      .order('created_at', { ascending: false })
      .limit(10);

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: weekEarnings } = await supabaseAdmin
      .from('transactions')
      .select('amount')
      .eq('wallet_id', wallet.id)
      .eq('type', 'earning')
      .gte('created_at', weekAgo);
    const weeklyIncome = (weekEarnings || []).reduce((sum, t) => sum + Number(t.amount || 0), 0);

    res.status(200).json({
      balance: wallet.balance,
      currency: wallet.currency,
      is_provider: profile?.is_service_provider || false,
      stripe_connect_id: profile?.stripe_connect_id || null,
      stripe_connected: !!profile?.stripe_connect_id,
      weekly_income: Number(weeklyIncome.toFixed(2)),
      transactions: transactions || []
    });
  } catch (error) {
    console.error('Fetch wallet error:', error.message);
    res.status(500).json({ error: 'Failed to fetch wallet details.' });
  }
});

/**
 * 2. POST /wallet/deposit - Create Payment Intent
 */
router.post('/deposit', authenticateToken, async (req, res) => {
  const { amount } = req.body;
  const userId = req.user.id;
  const email = req.user.email;

  try {
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount < 1 || numericAmount > 10000) {
      return res.status(400).json({ error: 'Deposit must be between $1 and $10,000.' });
    }

    const wallet = await getOrCreateWallet(userId, email);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(numericAmount * 100),
      currency: 'usd',
      customer: wallet.stripe_customer_id,
      // No redirect-based methods (Cash App Pay, Amazon Pay…): they are US-only
      // and need an app return URL that the mobile app doesn't register.
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      metadata: {
        userId: userId,
        walletId: wallet.id,
        type: 'wallet_deposit'
      }
    });

    res.status(200).json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id
    });

  } catch (error) {
    console.error('Stripe error:', error.message);
    res.status(500).json({ error: 'Failed to initialize deposit.' });
  }
});

/**
 * 3. POST /wallet/confirm-deposit - Update Balance
 */
router.post('/confirm-deposit', authenticateToken, async (req, res) => {
  const { paymentIntentId } = req.body;
  
  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.metadata?.userId !== req.user.id || paymentIntent.metadata?.type !== 'wallet_deposit') {
      return res.status(403).json({ error: 'This payment does not belong to you.' });
    }

    if (paymentIntent.status === 'succeeded') {
      const credited = await creditDeposit(paymentIntent);
      res.status(200).json({
        message: credited ? 'Wallet funded successfully!' : 'Transaction already processed',
      });
    } else {
      res.status(400).json({ error: 'Payment not successful yet.' });
    }

  } catch (error) {
    console.error('Confirmation error:', error.message);
    res.status(500).json({ error: 'Failed to confirm deposit.' });
  }
});

/**
 * 4. POST /wallet/onboard-connect
 */
router.post('/onboard-connect', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const email = req.user.email;

  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('stripe_connect_id')
      .eq('id', userId)
      .single();

    let accountId = profile?.stripe_connect_id;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        email: email,
        capabilities: { transfers: { requested: true } }
      });
      accountId = account.id;

      const { error: updateError } = await supabaseAdmin
        .from('profiles')
        .update({ stripe_connect_id: accountId })
        .eq('id', userId);

      if (updateError) {
        return res.status(500).json({ error: 'Failed to save Stripe account.' });
      }
    }

    const refreshUrl = process.env.STRIPE_CONNECT_REFRESH_URL || 'http://localhost:3000/stripe/refresh';
    const returnUrl = process.env.STRIPE_CONNECT_RETURN_URL || 'http://localhost:3000/stripe/return';

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: 'account_onboarding'
    });

    res.status(200).json({ url: accountLink.url });
  } catch (error) {
    console.error('Connect onboarding error:', error.message);
    res.status(500).json({ error: 'Failed to start Stripe onboarding.' });
  }
});

/**
 * 5. POST /wallet/login-link
 */
router.post('/login-link', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('stripe_connect_id')
      .eq('id', userId)
      .single();

    if (!profile?.stripe_connect_id) {
      return res.status(400).json({ error: 'Stripe account not connected.' });
    }

    const loginLink = await stripe.accounts.createLoginLink(profile.stripe_connect_id);
    res.status(200).json({ url: loginLink.url });
  } catch (error) {
    console.error('Login link error:', error.message);
    res.status(500).json({ error: 'Failed to create login link.' });
  }
});

/**
 * 6. POST /wallet/withdraw
 */
router.post('/withdraw', authenticateToken, async (req, res) => {
  const { amount } = req.body;
  const userId = req.user.id;
  const email = req.user.email;

  try {
    const amt = Math.round(Number(amount) * 100) / 100;
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: 'Invalid amount.' });
    }

    const wallet = await getOrCreateWallet(userId, email);

    if (parseFloat(wallet.balance) < amt) {
      return res.status(400).json({ error: 'Insufficient funds' });
    }

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('stripe_connect_id')
      .eq('id', userId)
      .single();

    if (!profile?.stripe_connect_id) {
      return res.status(400).json({ error: 'Stripe account not connected.' });
    }

    // Reserve the money before paying out. The update only applies if the
    // balance is still what we read, so two withdrawals at once can't both
    // spend the same funds.
    const newBalance = Math.round((parseFloat(wallet.balance) - amt) * 100) / 100;
    const { data: reserved } = await supabaseAdmin
      .from('wallets')
      .update({ balance: newBalance })
      .eq('id', wallet.id)
      .eq('balance', wallet.balance)
      .select('id')
      .maybeSingle();
    if (!reserved) {
      return res.status(409).json({ error: 'Your balance just changed. Please try again.' });
    }

    let transfer;
    try {
      transfer = await stripe.transfers.create({
        amount: Math.round(amt * 100),
        currency: 'usd',
        destination: profile.stripe_connect_id,
        metadata: {
          userId: userId,
          walletId: wallet.id
        }
      });
      if (!transfer || !transfer.id) throw new Error('Transfer failed.');
    } catch (transferError) {
      // Payout didn't happen — give the reserved money back.
      const { data: current } = await supabaseAdmin
        .from('wallets').select('balance').eq('id', wallet.id).single();
      await supabaseAdmin
        .from('wallets')
        .update({ balance: Math.round((parseFloat(current.balance) + amt) * 100) / 100 })
        .eq('id', wallet.id);
      throw transferError;
    }

    await supabaseAdmin.from('transactions').insert({
      wallet_id: wallet.id,
      type: 'withdrawal',
      amount: -amt,
      status: 'success',
      description: 'Stripe payout'
    });

    res.status(200).json({
      message: 'Withdrawal completed successfully.',
      new_balance: newBalance
    });
  } catch (error) {
    console.error('Withdraw error:', error.message);
    res.status(500).json({ error: 'Withdrawal failed' });
  }
});
router.post('/test/simulate-payment', authenticateToken, async (req, res) => {
  const { paymentIntentId } = req.body;

  // Dev-only helper: never expose in production.
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }

  try {
    // 1. Tell Stripe to "Pay" this intent using a Test Visa Card
    const paymentIntent = await stripe.paymentIntents.confirm(paymentIntentId, {
      payment_method: 'pm_card_visa', // Magic string for Stripe Test Mode
      return_url: 'http://localhost:3000/payment-complete' // Dummy URL required by Stripe
    });

    res.status(200).json({ 
      message: 'Payment simulated successfully!', 
      status: paymentIntent.status 
    });

  } catch (error) {
    console.error('Simulation error:', error.message);
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
module.exports.stripeWebhook = stripeWebhook;
module.exports.creditDeposit = creditDeposit;
