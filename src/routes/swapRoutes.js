const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const authenticateToken = require('../middleware/authMiddleware');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const SWAP_FALLBACK_MODELS = [
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-2.5-flash',
];

async function generateSwapAI(systemInstruction, userPrompt) {
  let lastError;
  for (const modelName of SWAP_FALLBACK_MODELS) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName, systemInstruction });
      const result = await model.generateContent(userPrompt);
      return result.response.text();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

function stripFences(text) {
  return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: send a realtime-style notification
// ─────────────────────────────────────────────────────────────────────────────
async function notify(userId, title, message, type, referenceId) {
  try {
    await supabaseAdmin.from('notifications').insert({
      user_id: userId,
      title,
      message,
      type,
      reference_id: referenceId,
      is_read: false,
    });
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /swap-requests
// Propose a swap: I offer my service, targeting another provider's service/category
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', authenticateToken, async (req, res) => {
  const proposerId = req.user.id;
  const {
    proposer_service_id,
    target_user_id,
    target_service_id,       // optional – they may not have picked yet
    target_category_id,
    target_category_name,
    service_type = 'Default',
    notes,
    scheduled_time,
    ai_match_score = 0,
    ai_match_reason = '',
  } = req.body;

  if (!proposer_service_id || !target_user_id) {
    return res.status(400).json({ error: 'proposer_service_id and target_user_id are required.' });
  }
  if (proposerId === target_user_id) {
    return res.status(400).json({ error: 'You cannot swap with yourself.' });
  }

  try {
    // Verify proposer's service belongs to them
    const { data: myService, error: svcErr } = await supabaseAdmin
      .from('services')
      .select('id, title, provider_id')
      .eq('id', proposer_service_id)
      .single();

    if (svcErr || !myService || myService.provider_id !== proposerId) {
      return res.status(403).json({ error: 'You do not own this service.' });
    }

    // Check for duplicate pending proposal
    const { data: existing } = await supabaseAdmin
      .from('swap_requests')
      .select('id')
      .eq('proposer_id', proposerId)
      .eq('proposer_service_id', proposer_service_id)
      .eq('target_user_id', target_user_id)
      .eq('status', 'pending')
      .maybeSingle();

    if (existing) {
      return res.status(409).json({ error: 'You already have a pending proposal for this match.' });
    }

    const { data: swap, error: insertErr } = await supabaseAdmin
      .from('swap_requests')
      .insert({
        proposer_id: proposerId,
        proposer_service_id,
        target_user_id,
        target_service_id: target_service_id || null,
        target_category_id: target_category_id || null,
        target_category_name: target_category_name || null,
        service_type,
        notes: notes || null,
        scheduled_time: scheduled_time || null,
        ai_match_score,
        ai_match_reason,
        status: 'pending',
      })
      .select()
      .single();

    if (insertErr) throw insertErr;

    // Notify target
    await notify(
      target_user_id,
      '🤝 New Skill Swap Proposal!',
      `${req.user.full_name || 'Someone'} wants to swap "${myService.title}" with you.`,
      'swap_proposal',
      swap.id
    );

    return res.status(201).json({ swap });
  } catch (err) {
    console.error('POST /swap-requests error:', err);
    return res.status(500).json({ error: 'Failed to create swap request.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /swap-requests/incoming
// Proposals that other people sent TO me
// ─────────────────────────────────────────────────────────────────────────────
router.get('/incoming', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const { data, error } = await supabaseAdmin
      .from('swap_requests')
      .select(`
        *,
        proposer:profiles!proposer_id ( id, full_name, profile_picture_url ),
        proposer_service:services!proposer_service_id ( id, title, image_urls, price ),
        target_service:services!target_service_id ( id, title, image_urls, price )
      `)
      .eq('target_user_id', userId)
      .in('status', ['pending', 'accepted'])
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json({ swaps: data || [] });
  } catch (err) {
    console.error('GET /swap-requests/incoming error:', err);
    return res.status(500).json({ error: 'Failed to fetch incoming swaps.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /swap-requests/outgoing
// Proposals I sent to others
// ─────────────────────────────────────────────────────────────────────────────
router.get('/outgoing', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const { data, error } = await supabaseAdmin
      .from('swap_requests')
      .select(`
        *,
        target_user:profiles!target_user_id ( id, full_name, profile_picture_url ),
        proposer_service:services!proposer_service_id ( id, title, image_urls, price ),
        target_service:services!target_service_id ( id, title, image_urls, price )
      `)
      .eq('proposer_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json({ swaps: data || [] });
  } catch (err) {
    console.error('GET /swap-requests/outgoing error:', err);
    return res.status(500).json({ error: 'Failed to fetch outgoing swaps.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /swap-requests/board
// Public swap board – recent pending proposals with offer & want info
// Used for the "Swap Board" discovery feed
// ─────────────────────────────────────────────────────────────────────────────
router.get('/board', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { limit = 30, offset = 0 } = req.query;
  try {
    const { data, error } = await supabaseAdmin
      .from('swap_requests')
      .select(`
        id, target_category_name, service_type, notes, ai_match_score, ai_match_reason, created_at,
        proposer:profiles!proposer_id ( id, full_name, profile_picture_url ),
        proposer_service:services!proposer_service_id ( id, title, image_urls, price, description )
      `)
      .eq('status', 'pending')
      .neq('proposer_id', userId)
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (error) throw error;
    return res.json({ board: data || [] });
  } catch (err) {
    console.error('GET /swap-requests/board error:', err);
    return res.status(500).json({ error: 'Failed to load swap board.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /swap-requests/:id/accept
// Target accepts the proposal → creates a $0 booking on the proposer's service
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id/accept', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { id: swapId } = req.params;
  const { target_service_id, scheduled_time } = req.body;

  try {
    const { data: swap, error: fetchErr } = await supabaseAdmin
      .from('swap_requests')
      .select('*')
      .eq('id', swapId)
      .eq('target_user_id', userId)
      .eq('status', 'pending')
      .single();

    if (fetchErr || !swap) {
      return res.status(404).json({ error: 'Swap request not found or already processed.' });
    }

    const finalScheduledTime = scheduled_time || swap.scheduled_time || new Date().toISOString();

    // Create a $0 booking on the proposer's service (client = target, provider = proposer)
    const { data: booking, error: bookingErr } = await supabaseAdmin
      .from('bookings')
      .insert({
        service_id:       swap.proposer_service_id,
        client_id:        userId,
        provider_id:      swap.proposer_id,
        scheduled_time:   finalScheduledTime,
        total_price:      0,
        location_details: `Skill Swap`,
        service_type:     swap.service_type || 'Default',
        status:           'confirmed',
        comments:         swap.notes || 'Skill Swap',
      })
      .select()
      .single();

    if (bookingErr) throw bookingErr;

    // Send a system message into the new booking chat
    await supabaseAdmin.from('messages').insert({
      booking_id: booking.id,
      sender_id: null,
      content: `🤝 Skill Swap accepted! This is a $0 swap booking. Both parties are committed.`,
      type: 'system',
    });

    // Update swap record
    const { data: updatedSwap, error: updateErr } = await supabaseAdmin
      .from('swap_requests')
      .update({
        status:            'accepted',
        target_service_id: target_service_id || swap.target_service_id || null,
        booking_id:        booking.id,
        scheduled_time:    finalScheduledTime,
        updated_at:        new Date().toISOString(),
      })
      .eq('id', swapId)
      .select()
      .single();

    if (updateErr) throw updateErr;

    // Notify proposer
    await notify(
      swap.proposer_id,
      '🎉 Swap Accepted!',
      'Your Skill Swap proposal was accepted! Check your bookings.',
      'swap_accepted',
      swapId
    );

    return res.json({ swap: updatedSwap, booking });
  } catch (err) {
    console.error('PUT /swap-requests/:id/accept error:', err);
    return res.status(500).json({ error: 'Failed to accept swap.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /swap-requests/:id/decline
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id/decline', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { id: swapId } = req.params;
  try {
    const { data: swap } = await supabaseAdmin
      .from('swap_requests')
      .select('*')
      .eq('id', swapId)
      .eq('target_user_id', userId)
      .eq('status', 'pending')
      .single();

    if (!swap) return res.status(404).json({ error: 'Swap not found.' });

    await supabaseAdmin
      .from('swap_requests')
      .update({ status: 'declined', updated_at: new Date().toISOString() })
      .eq('id', swapId);

    await notify(
      swap.proposer_id,
      '😔 Swap Declined',
      'Your Skill Swap proposal was declined. Try another provider!',
      'swap_declined',
      swapId
    );

    return res.json({ message: 'Swap declined.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to decline swap.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /swap-requests/:id/cancel
// Proposer cancels their own pending proposal
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id/cancel', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { id: swapId } = req.params;
  try {
    const { error } = await supabaseAdmin
      .from('swap_requests')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', swapId)
      .eq('proposer_id', userId)
      .in('status', ['pending']);

    if (error) throw error;
    return res.json({ message: 'Swap cancelled.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to cancel swap.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /swap-requests/board/ai-ranked
// Returns the public swap board sorted by AI relevance to the current user's services.
// Adds an `ai_relevance_score` and `ai_relevance_reason` to each board entry.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/board/ai-ranked', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { limit = 40 } = req.query;

  try {
    // 1. Fetch board (pending proposals NOT from me)
    const { data: board, error: boardErr } = await supabaseAdmin
      .from('swap_requests')
      .select(`
        id, target_category_name, service_type, notes, ai_match_score, ai_match_reason, created_at,
        proposer:profiles!proposer_id ( id, full_name, profile_picture_url ),
        proposer_service:services!proposer_service_id ( id, title, image_urls, price, description )
      `)
      .eq('status', 'pending')
      .neq('proposer_id', userId)
      .order('created_at', { ascending: false })
      .limit(Number(limit));

    if (boardErr) throw boardErr;
    if (!board || board.length === 0) return res.json({ board: [] });

    // 2. Fetch my own services for context
    const { data: myServices } = await supabaseAdmin
      .from('services')
      .select('id, title, description')
      .eq('provider_id', userId)
      .eq('status', 'active')
      .limit(5);

    if (!myServices || myServices.length === 0) {
      // No services yet — return board as-is with default score
      return res.json({ board: board.map(b => ({ ...b, ai_relevance_score: 50, ai_relevance_reason: 'Potential match' })) });
    }

    // 3. Ask Gemini to score each board item against my services
    const systemPrompt = `You are a Skill Swap relevance engine for the LifeKit app.
I will give you a list of "swap posts" (people offering a skill and wanting another in return) and the current user's own services.
Score each swap post 0-100 for how relevant/useful it would be for this user to engage with, based on complementarity.
Return ONLY a JSON array (no markdown, no explanation):
[{"id":"...", "score": number, "reason": "1 short sentence"}]`;

    const userPrompt = `MY SERVICES:\n${(myServices || []).map(s => `- "${s.title}": ${s.description || 'N/A'}`).join('\n')}\n\nSWAP BOARD POSTS:\n${board.map(b => `[${b.id}] Offering "${b.proposer_service?.title}" — Wants "${b.target_category_name || 'anything'}"`).join('\n')}`;

    let scores = [];
    try {
      const raw = await generateSwapAI(systemPrompt, userPrompt);
      const parsed = JSON.parse(stripFences(raw));
      if (Array.isArray(parsed)) scores = parsed;
    } catch (_) {
      // Fallback: all 50
    }

    const scoreMap = {};
    scores.forEach(s => { scoreMap[s.id] = s; });

    const ranked = board
      .map(b => ({
        ...b,
        ai_relevance_score: scoreMap[b.id]?.score ?? 50,
        ai_relevance_reason: scoreMap[b.id]?.reason ?? 'Potential match',
      }))
      .sort((a, b) => b.ai_relevance_score - a.ai_relevance_score);

    return res.json({ board: ranked });
  } catch (err) {
    console.error('GET /swap-requests/board/ai-ranked error:', err);
    return res.status(500).json({ error: 'Failed to load AI-ranked swap board.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /swap-requests/:id
// Fetch a single swap request by ID (for deep-link or chat context)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { id: swapId } = req.params;
  try {
    const { data: swap, error } = await supabaseAdmin
      .from('swap_requests')
      .select(`
        *,
        proposer:profiles!proposer_id ( id, full_name, profile_picture_url ),
        target_user:profiles!target_user_id ( id, full_name, profile_picture_url ),
        proposer_service:services!proposer_service_id ( id, title, image_urls, price, description ),
        target_service:services!target_service_id ( id, title, image_urls, price )
      `)
      .eq('id', swapId)
      .or(`proposer_id.eq.${userId},target_user_id.eq.${userId}`)
      .single();

    if (error || !swap) return res.status(404).json({ error: 'Swap request not found.' });
    return res.json({ swap });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch swap request.' });
  }
});

module.exports = router;
