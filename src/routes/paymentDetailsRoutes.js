// src/routes/paymentDetailsRoutes.js
//
// How a provider accepts payment (cash / card / bank transfer + bank details).
// LifeKit never moves money: clients pay providers directly. Bank details are
// personal data, so they are only ever returned to (a) their owner and (b) the
// client of a booking the provider has accepted and that isn't settled yet.
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const authenticateToken = require('../middleware/authMiddleware');

/** "ge29 nb00 ..." -> "GE29NB00..." */
const normalizeIban = (v) => String(v || '').replace(/\s+/g, '').toUpperCase();

/** ISO 13616 IBAN check (format + mod-97). Georgian IBANs are 22 characters. */
function isValidIban(iban) {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  if (iban.startsWith('GE') && iban.length !== 22) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const v = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

const methodsOf = (row) => ({
  cash: !!row?.accepts_cash,
  card: !!row?.accepts_card,
  transfer: !!row?.accepts_transfer,
});

const bankOf = (row) =>
  row?.accepts_transfer && row?.iban
    ? { bank_name: row.bank_name || null, account_holder: row.account_holder || null, iban: row.iban }
    : null;

const clean = (v, max) => {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  return s ? s.slice(0, max) : null;
};

// GET /payment-details/me — the signed-in user's own details
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('payment_details').select('*').eq('user_id', req.user.id).maybeSingle();
    res.json({ methods: methodsOf(data), bank: data ? {
      bank_name: data.bank_name, account_holder: data.account_holder, iban: data.iban,
    } : null, updated_at: data?.updated_at || null });
  } catch (e) {
    console.error('Payment details read error:', e.message);
    res.status(500).json({ error: 'Could not load payment details.' });
  }
});

// PUT /payment-details/me — save methods and (optionally) bank details
router.put('/me', authenticateToken, async (req, res) => {
  const { cash, card, transfer, bank_name, account_holder, iban } = req.body || {};
  const row = {
    user_id: req.user.id,
    accepts_cash: !!cash,
    accepts_card: !!card,
    accepts_transfer: !!transfer,
    bank_name: clean(bank_name, 80),
    account_holder: clean(account_holder, 120),
    iban: iban ? normalizeIban(iban) : null,
    updated_at: new Date().toISOString(),
  };
  if (row.iban && !isValidIban(row.iban)) {
    return res.status(400).json({ error: 'That IBAN doesn’t look right. Please check it.', code: 'invalid_iban' });
  }
  if (row.accepts_transfer && (!row.iban || !row.account_holder)) {
    return res.status(400).json({ error: 'For bank transfer, add the account holder and IBAN.', code: 'transfer_details_required' });
  }
  if (!row.accepts_transfer) {
    // Don't keep bank details nobody can use.
    row.bank_name = null; row.account_holder = null; row.iban = null;
  }
  try {
    const { data, error } = await supabaseAdmin
      .from('payment_details').upsert(row).select('*').single();
    if (error) throw error;
    res.json({ message: 'Payment details saved.', methods: methodsOf(data), bank: bankOf(data) });
  } catch (e) {
    console.error('Payment details save error:', e.message);
    res.status(500).json({ error: 'Could not save payment details.' });
  }
});

// DELETE /payment-details/me — remove everything
router.delete('/me', authenticateToken, async (req, res) => {
  try {
    await supabaseAdmin.from('payment_details').delete().eq('user_id', req.user.id);
    res.json({ message: 'Payment details removed.' });
  } catch (e) {
    console.error('Payment details delete error:', e.message);
    res.status(500).json({ error: 'Could not remove payment details.' });
  }
});

// GET /payment-details/methods/:userId — public: which methods only, no bank data
router.get('/methods/:userId', async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('payment_details').select('accepts_cash, accepts_card, accepts_transfer')
      .eq('user_id', req.params.userId).maybeSingle();
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ methods: methodsOf(data) });
  } catch (e) {
    res.json({ methods: methodsOf(null) });
  }
});

// GET /payment-details/booking/:bookingId — how to pay for this booking.
// Bank details only for the client (or provider) of an accepted, direct,
// paid booking that the provider hasn't marked as paid yet.
router.get('/booking/:bookingId', authenticateToken, async (req, res) => {
  try {
    const { data: b } = await supabaseAdmin
      .from('bookings')
      .select('id, client_id, provider_id, status, total_price, payment_method, client_marked_paid_at, provider_confirmed_paid_at')
      .eq('id', req.params.bookingId).maybeSingle();
    if (!b || (b.client_id !== req.user.id && b.provider_id !== req.user.id)) {
      return res.status(404).json({ error: 'Booking not found.' });
    }
    const { data: row } = await supabaseAdmin
      .from('payment_details').select('*').eq('user_id', b.provider_id).maybeSingle();

    const reveal = b.payment_method === 'direct' && Number(b.total_price) > 0 &&
      ['confirmed', 'completed'].includes(b.status) && !b.provider_confirmed_paid_at;

    res.json({
      methods: methodsOf(row),
      bank: reveal ? bankOf(row) : null,
      // Why bank details are hidden, so the app can explain it.
      bank_hidden_reason: reveal ? null
        : b.provider_confirmed_paid_at ? 'paid'
        : b.status === 'pending' ? 'not_accepted' : 'unavailable',
      client_marked_paid_at: b.client_marked_paid_at,
      provider_confirmed_paid_at: b.provider_confirmed_paid_at,
    });
  } catch (e) {
    console.error('Booking payment details error:', e.message);
    res.status(500).json({ error: 'Could not load payment details.' });
  }
});

module.exports = router;
module.exports.isValidIban = isValidIban;
module.exports.normalizeIban = normalizeIban;
