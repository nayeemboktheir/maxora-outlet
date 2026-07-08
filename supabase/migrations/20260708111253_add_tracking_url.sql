-- Store the actual tracking link returned by the courier API (Steadfast/Carrybee).
-- This changes whenever an order is re-sent to a different courier.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS tracking_url TEXT;
COMMENT ON COLUMN public.orders.tracking_url IS 'Actual courier tracking link captured from the courier API response';
