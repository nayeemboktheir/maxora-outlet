ALTER TABLE public.products ADD COLUMN IF NOT EXISTS colors text[] DEFAULT '{}'::text[];
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS color text;
ALTER TABLE public.cart_items ADD COLUMN IF NOT EXISTS color text;
ALTER TABLE public.draft_orders ADD COLUMN IF NOT EXISTS notes text;