// src/config/payments.js
//
// LifeKit does not hold customers' money for now: clients pay providers
// directly (cash, card machine or bank transfer). Holding funds in an in-app
// wallet needs a payment licence in Georgia, and Stripe can't pay out to
// Georgian providers. Turn this on (IN_APP_PAYMENTS=true) only once a licensed
// partner (e.g. a bank's split-payment checkout) is integrated.
//
// Bookings created while it was on carry payment_method = 'wallet' and keep
// their refund/payout rules until they settle; new bookings are 'direct'.
const IN_APP_PAYMENTS = process.env.IN_APP_PAYMENTS === 'true';

/** True when this booking's money is held in LifeKit wallets. */
const heldInApp = (booking) =>
  booking?.payment_method === 'wallet' && Number(booking?.total_price) > 0;

const PAYMENTS_DISABLED_ERROR = {
  error: 'Payments in the app are not available yet. Pay the provider directly.',
  code: 'payments_disabled',
};

/** Route guard for anything that takes money (top-ups, plans, boosts, tickets). */
const requireInAppPayments = (req, res, next) =>
  IN_APP_PAYMENTS ? next() : res.status(403).json(PAYMENTS_DISABLED_ERROR);

module.exports = { IN_APP_PAYMENTS, heldInApp, PAYMENTS_DISABLED_ERROR, requireInAppPayments };
