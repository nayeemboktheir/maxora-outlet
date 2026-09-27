-- Two-axis product options: colors x sizes.
--
-- `product_variations` already holds the COLOR axis (name, price, image, stock)
-- and is what the storefront renders as the per-option picker. This migration
-- adds the SIZE axis plus per-combination stock, so a given colour can be sold
-- out in one size while still available in another.

-- Size labels for a product (no price of their own).
CREATE TABLE IF NOT EXISTS public.product_sizes (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  name text NOT NULL,
  sort_order integer DEFAULT 0,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  UNIQUE (product_id, name)
);

CREATE INDEX IF NOT EXISTS idx_product_sizes_product
  ON public.product_sizes (product_id, sort_order);

-- Stock for one (colour, size) pair.
CREATE TABLE IF NOT EXISTS public.product_variation_stock (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  variation_id uuid NOT NULL REFERENCES public.product_variations(id) ON DELETE CASCADE,
  size_id uuid NOT NULL REFERENCES public.product_sizes(id) ON DELETE CASCADE,
  stock integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  UNIQUE (variation_id, size_id)
);

CREATE INDEX IF NOT EXISTS idx_variation_stock_variation
  ON public.product_variation_stock (variation_id);
CREATE INDEX IF NOT EXISTS idx_variation_stock_size
  ON public.product_variation_stock (size_id);

ALTER TABLE public.product_sizes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_variation_stock ENABLE ROW LEVEL SECURITY;

-- Mirrors the existing product_variations policies: world-readable, admin-writable.
DROP POLICY IF EXISTS "Anyone can view product sizes" ON public.product_sizes;
CREATE POLICY "Anyone can view product sizes"
  ON public.product_sizes FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Admins can manage product sizes" ON public.product_sizes;
CREATE POLICY "Admins can manage product sizes"
  ON public.product_sizes
  USING ((SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role)))
  WITH CHECK ((SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role)));

DROP POLICY IF EXISTS "Anyone can view variation stock" ON public.product_variation_stock;
CREATE POLICY "Anyone can view variation stock"
  ON public.product_variation_stock FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Admins can manage variation stock" ON public.product_variation_stock;
CREATE POLICY "Admins can manage variation stock"
  ON public.product_variation_stock
  USING ((SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role)))
  WITH CHECK ((SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role)));

-- Record the chosen size alongside the chosen colour on carts and orders.
ALTER TABLE public.cart_items  ADD COLUMN IF NOT EXISTS size_name text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS size_name text;
