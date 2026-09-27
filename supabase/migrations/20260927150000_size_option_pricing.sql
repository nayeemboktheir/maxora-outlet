-- Promote the size axis to a full option group.
--
-- `product_sizes` started as labels only ("price comes from the variation").
-- Shops that price by size (three-piece sets priced per size, with their own
-- swatch image) need the same columns the colour axis already has, so a size
-- row can carry its own image, price, old price and stock.
--
-- All four are nullable / default 0 so existing label-only sizes keep working:
-- a NULL price means "inherit from the variation, then the product".

ALTER TABLE public.product_sizes
  ADD COLUMN IF NOT EXISTS price numeric,
  ADD COLUMN IF NOT EXISTS original_price numeric,
  ADD COLUMN IF NOT EXISTS image_url text,
  ADD COLUMN IF NOT EXISTS stock integer DEFAULT 0 NOT NULL;

-- A size row is only ever "free" (inherit) or a real positive price; 0 would be
-- ambiguous against the inherit case, so reject it outright.
ALTER TABLE public.product_sizes
  DROP CONSTRAINT IF EXISTS product_sizes_price_positive;
ALTER TABLE public.product_sizes
  ADD CONSTRAINT product_sizes_price_positive
  CHECK (price IS NULL OR price > 0);

ALTER TABLE public.product_sizes
  DROP CONSTRAINT IF EXISTS product_sizes_original_price_positive;
ALTER TABLE public.product_sizes
  ADD CONSTRAINT product_sizes_original_price_positive
  CHECK (original_price IS NULL OR original_price > 0);

ALTER TABLE public.product_sizes
  DROP CONSTRAINT IF EXISTS product_sizes_stock_non_negative;
ALTER TABLE public.product_sizes
  ADD CONSTRAINT product_sizes_stock_non_negative
  CHECK (stock >= 0);
