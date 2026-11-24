-- A swap is two-way: the accepter receives the proposer's service (booking_id)
-- and the proposer receives the accepter's service (reverse_booking_id).
ALTER TABLE public.swap_requests
  ADD COLUMN IF NOT EXISTS reverse_booking_id uuid REFERENCES public.bookings(id) ON DELETE SET NULL;
