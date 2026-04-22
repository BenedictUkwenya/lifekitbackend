const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const authenticateToken = require('../middleware/authMiddleware');

const SUBSCRIPTION_PRICING = {
  plus: 6.99,
  pro: 17.99,
  business: 44.99
};

// Service Boost: 24h $2.99 | 3d $6.99 | 7d $14.99
// Profile Boost: 3d $3.99 | 7d $9.99 (no 24h option)
const BOOST_PRICING = {
  service: {
    '24h': 2.99,
    '3d': 6.99,
    '7d': 14.99
  },
  profile: {
    '3d': 3.99,
    '7d': 9.99
  }
};

const BOOST_DURATION_MS = {
  '24h': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000
};

const OPPORTUNITY_BOOST_PRICE = 4.99;
const BUNDLE_BOOST_PRICE = 19.99;

// AI Premium Tools — one-time purchase, no subscription required
const AI_TOOL_PRICING = {
  cv_resume_builder: 4.99,
  relocation_plan: 6.99,
  start_earning_city_guide: 9.99
};

const normalizeTier = (tier) => (typeof tier === 'string' ? tier.toLowerCase() : '');

const roundMoney = (amount) => Number(Number(amount).toFixed(2));
const getSubscriptionExpiryIso = () =>
  new Date(Date.now() + (30 * 24 * 60 * 60 * 1000)).toISOString();

const getWalletByUserId = async (userId) => {
  const { data: wallet, error } = await supabaseAdmin
    .from('wallets')
    .select('id, balance')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return wallet;
};

const updateWalletBalance = async (walletId, newBalance) => {
  const { error } = await supabaseAdmin
    .from('wallets')
    .update({ balance: roundMoney(newBalance) })
    .eq('id', walletId);

  if (error) throw error;
};

const deductWallet = async (userId, amount) => {
  const wallet = await getWalletByUserId(userId);

  if (!wallet) {
    return { insufficient: true };
  }

  const currentBalance = Number(wallet.balance || 0);
  const chargeAmount = Number(amount || 0);

  if (currentBalance < chargeAmount) {
    return { insufficient: true };
  }

  const newBalance = roundMoney(currentBalance - chargeAmount);
  await updateWalletBalance(wallet.id, newBalance);

  return {
    insufficient: false,
    walletId: wallet.id,
    newBalance
  };
};

const recordPurchaseTransaction = async (walletId, amount, description) => {
  const { error } = await supabaseAdmin.from('transactions').insert({
    wallet_id: walletId,
    type: 'payment',
    amount: roundMoney(Math.abs(Number(amount || 0))),
    status: 'success',
    description
  });

  if (error) throw error;
};

router.post('/subscribe', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const tier = normalizeTier(req.body.tier);
  const price = SUBSCRIPTION_PRICING[tier];

  if (!price) {
    return res.status(400).json({ error: 'Invalid tier. Allowed values: plus, pro, business.' });
  }

  try {
    const { data: existingProfile, error: profileFetchError } = await supabaseAdmin
      .from('profiles')
      .select('subscription_tier, subscription_expiry')
      .eq('id', userId)
      .maybeSingle();

    if (profileFetchError) throw profileFetchError;
    if (!existingProfile) return res.status(404).json({ error: 'Profile not found.' });

    const paymentResult = await deductWallet(userId, price);
    if (paymentResult.insufficient) {
      return res.status(402).json({ error: 'Insufficient wallet balance.' });
    }

    const expiry = getSubscriptionExpiryIso();

    const { error: profileUpdateError } = await supabaseAdmin
      .from('profiles')
      .update({
        subscription_tier: tier,
        subscription_expiry: expiry,
        // Business tier unlocks verified badge
        ...(tier === 'business' ? { is_verified_business: true } : {})
      })
      .eq('id', userId);

    if (profileUpdateError) {
      await updateWalletBalance(paymentResult.walletId, paymentResult.newBalance + price);
      return res.status(500).json({ error: 'Failed to update subscription.' });
    }

    try {
      await recordPurchaseTransaction(
        paymentResult.walletId,
        price,
        `Bought ${tier} subscription`
      );
    } catch (txError) {
      await updateWalletBalance(paymentResult.walletId, paymentResult.newBalance + price);
      await supabaseAdmin
        .from('profiles')
        .update({
          subscription_tier: existingProfile.subscription_tier,
          subscription_expiry: existingProfile.subscription_expiry
        })
        .eq('id', userId);
      throw txError;
    }

    return res.status(200).json({
      message: 'Subscription purchased successfully.',
      subscription_tier: tier,
      subscription_expiry: expiry,
      wallet_balance: paymentResult.newBalance
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/boost', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { target_id, boost_duration } = req.body;

  if (!target_id || !boost_duration || !BOOST_DURATION_MS[boost_duration]) {
    return res.status(400).json({ error: 'target_id and valid boost_duration (24h, 3d, 7d) are required.' });
  }

  // Profile boosts don't have a 24h option
  const profileOnlyDurations = ['3d', '7d'];

  try {
    let targetType = null;
    let serviceId = null;

    const { data: service, error: serviceError } = await supabaseAdmin
      .from('services')
      .select('id')
      .eq('id', target_id)
      .maybeSingle();

    if (serviceError) throw serviceError;

    if (service) {
      targetType = 'service';
      serviceId = service.id;
    } else {
      const { data: profile, error: profileError } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('id', target_id)
        .maybeSingle();

      if (profileError) throw profileError;
      if (!profile) return res.status(404).json({ error: 'Target not found.' });
      targetType = 'profile';
    }

    // Validate duration is supported for this boost type
    if (targetType === 'profile' && !profileOnlyDurations.includes(boost_duration)) {
      return res.status(400).json({ error: 'Profile boosts support 3d and 7d only.' });
    }

    const price = BOOST_PRICING[targetType][boost_duration];
    const paymentResult = await deductWallet(userId, price);

    if (paymentResult.insufficient) {
      return res.status(402).json({ error: 'Insufficient wallet balance.' });
    }

    const expiresAt = new Date(Date.now() + BOOST_DURATION_MS[boost_duration]).toISOString();
    const boostType = `${targetType}_${boost_duration}`;

    const { data: boostRecord, error: boostInsertError } = await supabaseAdmin
      .from('active_boosts')
      .insert({
        user_id: userId,
        service_id: serviceId,
        boost_type: boostType,
        expires_at: expiresAt
      })
      .select('id')
      .single();

    if (boostInsertError) {
      await updateWalletBalance(paymentResult.walletId, paymentResult.newBalance + price);
      return res.status(500).json({ error: 'Failed to activate boost.' });
    }

    try {
      await recordPurchaseTransaction(
        paymentResult.walletId,
        price,
        `Bought ${targetType} boost (${boost_duration})`
      );
    } catch (txError) {
      await updateWalletBalance(paymentResult.walletId, paymentResult.newBalance + price);
      await supabaseAdmin.from('active_boosts').delete().eq('id', boostRecord.id);
      throw txError;
    }

    return res.status(200).json({
      message: 'Boost purchased successfully.',
      boost_type: boostType,
      expires_at: expiresAt,
      wallet_balance: paymentResult.newBalance
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// POST /upgrade/opportunity-boost — $4.99 per boost, no target needed
router.post('/opportunity-boost', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    const paymentResult = await deductWallet(userId, OPPORTUNITY_BOOST_PRICE);
    if (paymentResult.insufficient) {
      return res.status(402).json({ error: 'Insufficient wallet balance.' });
    }

    const expiresAt = new Date(Date.now() + BOOST_DURATION_MS['7d']).toISOString();

    const { data: boostRecord, error: boostInsertError } = await supabaseAdmin
      .from('active_boosts')
      .insert({
        user_id: userId,
        boost_type: 'opportunity',
        expires_at: expiresAt
      })
      .select('id')
      .single();

    if (boostInsertError) {
      await updateWalletBalance(paymentResult.walletId, paymentResult.newBalance + OPPORTUNITY_BOOST_PRICE);
      return res.status(500).json({ error: 'Failed to activate opportunity boost.' });
    }

    try {
      await recordPurchaseTransaction(paymentResult.walletId, OPPORTUNITY_BOOST_PRICE, 'Bought opportunity boost');
    } catch (txError) {
      await updateWalletBalance(paymentResult.walletId, paymentResult.newBalance + OPPORTUNITY_BOOST_PRICE);
      await supabaseAdmin.from('active_boosts').delete().eq('id', boostRecord.id);
      throw txError;
    }

    return res.status(200).json({
      message: 'Opportunity boost activated.',
      expires_at: expiresAt,
      wallet_balance: paymentResult.newBalance
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// POST /upgrade/bundle-boost — $19.99/month: 2x Service + 1x Profile + 2x Opportunity Boosts
router.post('/bundle-boost', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    const paymentResult = await deductWallet(userId, BUNDLE_BOOST_PRICE);
    if (paymentResult.insufficient) {
      return res.status(402).json({ error: 'Insufficient wallet balance.' });
    }

    const expires7d = new Date(Date.now() + BOOST_DURATION_MS['7d']).toISOString();

    // Insert 5 boost records: 2x service_7d, 1x profile_7d, 2x opportunity
    const boostRows = [
      { user_id: userId, boost_type: 'service_7d', expires_at: expires7d },
      { user_id: userId, boost_type: 'service_7d', expires_at: expires7d },
      { user_id: userId, boost_type: 'profile_7d', expires_at: expires7d },
      { user_id: userId, boost_type: 'opportunity', expires_at: expires7d },
      { user_id: userId, boost_type: 'opportunity', expires_at: expires7d }
    ];

    const { error: boostInsertError } = await supabaseAdmin
      .from('active_boosts')
      .insert(boostRows);

    if (boostInsertError) {
      await updateWalletBalance(paymentResult.walletId, paymentResult.newBalance + BUNDLE_BOOST_PRICE);
      return res.status(500).json({ error: 'Failed to activate bundle boosts.' });
    }

    try {
      await recordPurchaseTransaction(paymentResult.walletId, BUNDLE_BOOST_PRICE, 'Bought Bundle Boost Pack');
    } catch (txError) {
      await updateWalletBalance(paymentResult.walletId, paymentResult.newBalance + BUNDLE_BOOST_PRICE);
      throw txError;
    }

    return res.status(200).json({
      message: 'Bundle Boost Pack activated.',
      boosts_added: 5,
      expires_at: expires7d,
      wallet_balance: paymentResult.newBalance
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// POST /upgrade/ai-tool — one-time purchase for premium AI tools
router.post('/ai-tool', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { tool_key } = req.body;

  const price = AI_TOOL_PRICING[tool_key];
  if (!price) {
    return res.status(400).json({
      error: 'Invalid tool_key.',
      valid_keys: Object.keys(AI_TOOL_PRICING)
    });
  }

  try {
    // Check if already purchased (unique constraint enforced in DB)
    const { data: existing } = await supabaseAdmin
      .from('purchased_ai_tools')
      .select('id')
      .eq('user_id', userId)
      .eq('tool_key', tool_key)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({ error: 'You already own this AI tool.' });
    }

    const paymentResult = await deductWallet(userId, price);
    if (paymentResult.insufficient) {
      return res.status(402).json({ error: 'Insufficient wallet balance.' });
    }

    const { error: insertError } = await supabaseAdmin
      .from('purchased_ai_tools')
      .insert({ user_id: userId, tool_key });

    if (insertError) {
      await updateWalletBalance(paymentResult.walletId, paymentResult.newBalance + price);
      return res.status(500).json({ error: 'Failed to unlock AI tool.' });
    }

    try {
      await recordPurchaseTransaction(paymentResult.walletId, price, `Bought AI tool: ${tool_key}`);
    } catch (txError) {
      await updateWalletBalance(paymentResult.walletId, paymentResult.newBalance + price);
      await supabaseAdmin.from('purchased_ai_tools').delete().eq('user_id', userId).eq('tool_key', tool_key);
      throw txError;
    }

    return res.status(200).json({
      message: `AI tool unlocked: ${tool_key}`,
      tool_key,
      wallet_balance: paymentResult.newBalance
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// GET /upgrade/ai-tools — list which premium AI tools the user owns
router.get('/ai-tools', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const { data, error } = await supabaseAdmin
      .from('purchased_ai_tools')
      .select('tool_key, purchased_at')
      .eq('user_id', userId);

    if (error) throw error;

    return res.status(200).json({
      owned_tools: data || [],
      catalog: Object.entries(AI_TOOL_PRICING).map(([key, price]) => ({ key, price }))
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
