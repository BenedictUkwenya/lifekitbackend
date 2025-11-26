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
 * 1. GET /wallet - Dashboard
 */
router.get('/', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const email = req.user.email;

  try {
    const wallet = await getOrCreateWallet(userId, email);

    const { data: transactions } = await supabase
      .from('transactions')
      .select('*')
      .eq('wallet_id', wallet.id)
      .order('created_at', { ascending: false })
      .limit(10);

    res.status(200).json({
      balance: wallet.balance,
      currency: wallet.currency,
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
    const wallet = await getOrCreateWallet(userId, email);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: 'usd',
      customer: wallet.stripe_customer_id,
      automatic_payment_methods: { enabled: true },
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

    if (paymentIntent.status === 'succeeded') {
      const amountUSD = paymentIntent.amount / 100;
      const walletId = paymentIntent.metadata.walletId;

      const { data: existingTx } = await supabase
        .from('transactions')
        .select('*')
        .eq('stripe_payment_id', paymentIntentId)
        .single();

      if (existingTx) {
        return res.status(200).json({ message: 'Transaction already processed' });
      }

      // USE ADMIN: Only Admin should insert transactions directly
      await supabaseAdmin.from('transactions').insert({
        wallet_id: walletId,
        type: 'deposit',
        amount: amountUSD,
        stripe_payment_id: paymentIntentId,
        status: 'success',
        description: 'Deposit via Card'
      });

      // USE ADMIN: Only Admin should update balances
      const { data: wallet } = await supabaseAdmin
        .from('wallets')
        .select('balance')
        .eq('id', walletId)
        .single();

      await supabaseAdmin
        .from('wallets')
        .update({ balance: wallet.balance + amountUSD })
        .eq('id', walletId);

      res.status(200).json({ message: 'Wallet funded successfully!' });
    } else {
      res.status(400).json({ error: 'Payment not successful yet.' });
    }

  } catch (error) {
    console.error('Confirmation error:', error.message);
    res.status(500).json({ error: 'Failed to confirm deposit.' });
  }
});

/**
 * 4. POST /wallet/withdraw
 */
router.post('/withdraw', authenticateToken, async (req, res) => {
  const { amount } = req.body;
  const userId = req.user.id;
  const email = req.user.email;

  try {
    const wallet = await getOrCreateWallet(userId, email);

    if (wallet.balance < amount) {
      return res.status(400).json({ error: 'Insufficient funds' });
    }

    // USE ADMIN for balance deduction
    const newBalance = parseFloat(wallet.balance) - parseFloat(amount);
    
    await supabaseAdmin
      .from('wallets')
      .update({ balance: newBalance })
      .eq('id', wallet.id);

    await supabaseAdmin.from('transactions').insert({
      wallet_id: wallet.id,
      type: 'withdrawal',
      amount: -amount,
      status: 'success',
      description: 'Withdrawal Request'
    });

    res.status(200).json({ 
      message: 'Withdrawal initiated successfully.',
      new_balance: newBalance 
    });

  } catch (error) {
    console.error('Withdraw error:', error.message);
    res.status(500).json({ error: 'Withdrawal failed' });
  }
});
router.post('/test/simulate-payment', authenticateToken, async (req, res) => {
  const { paymentIntentId } = req.body;
  
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