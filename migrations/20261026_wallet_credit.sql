-- Atomic, idempotent wallet deposits.
--
-- Both the app (/wallet/confirm-deposit) and the Stripe webhook
-- (/wallet/stripe-webhook) credit deposits through credit_wallet_deposit().
-- The unique index guarantees a Stripe payment is recorded at most once, and
-- the function adds to the balance in the same transaction, so two
-- simultaneous calls can never double-credit.
--
-- If the CREATE UNIQUE INDEX fails with "could not create unique index",
-- some payment was already recorded twice. Do NOT delete rows blindly —
-- send the error to the developer so the duplicates can be reviewed first.

create unique index if not exists transactions_stripe_payment_id_key
  on public.transactions (stripe_payment_id)
  where stripe_payment_id is not null;

create or replace function public.credit_wallet_deposit(
  p_payment_id text,
  p_wallet_id uuid,
  p_amount numeric,
  p_description text default 'Deposit via Card'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted int;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Deposit amount must be positive';
  end if;

  insert into public.transactions (wallet_id, type, amount, stripe_payment_id, status, description)
  values (p_wallet_id, 'deposit', p_amount, p_payment_id, 'success', p_description)
  on conflict (stripe_payment_id) where stripe_payment_id is not null do nothing
  returning 1 into inserted;

  if inserted is null then
    return false; -- already credited
  end if;

  update public.wallets
     set balance = coalesce(balance, 0) + p_amount
   where id = p_wallet_id;

  if not found then
    raise exception 'Wallet % not found', p_wallet_id;
  end if;

  return true;
end;
$$;

-- Only the backend (service role) may call it.
revoke all on function public.credit_wallet_deposit(text, uuid, numeric, text) from public, anon, authenticated;
