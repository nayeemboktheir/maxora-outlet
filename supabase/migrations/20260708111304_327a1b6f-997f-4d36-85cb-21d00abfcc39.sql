ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS tracking_url TEXT;
COMMENT ON COLUMN public.orders.tracking_url IS 'Actual courier tracking link captured from the courier API response';