-- Modessi products and per-order Modessi cost.
--
-- modessi_products     which products are bought from Modessi (a row = marked), and the
--                      wholesale (paikari) price of one unit. Managed on Admin → Modessi → Products tab.
--                      price may be NULL right after marking, until it is filled in.
-- order_modessi_costs  an order's Modessi cost: sum of quantity × price over its Modessi items.
--                      Recorded once, then frozen, so a later price change never rewrites old profit.
--
-- Both tables live outside `products` and `orders` on purpose: active products are readable by
-- everyone and customers can read their own orders, but wholesale cost must stay admin-only.
--
-- When the cost is recorded:
--   - when an order gets a Steadfast consignment (it was sent), or its courier status changes;
--   - when a Modessi product's price is set, for sent orders that were waiting on that price.
-- Items that are not Modessi products are ignored. If a Modessi item has no price yet, nothing is
-- recorded and the admin page shows "price missing" until the price is set.

-- 1. Modessi products (admin-only) ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.modessi_products (
  product_id uuid PRIMARY KEY REFERENCES public.products(id) ON DELETE CASCADE,
  price numeric(10,2) CHECK (price >= 0),
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.modessi_products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can manage modessi products" ON public.modessi_products;
CREATE POLICY "Admins can manage modessi products"
  ON public.modessi_products
  TO authenticated
  USING ((SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role)))
  WITH CHECK ((SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role)));

DROP TRIGGER IF EXISTS update_modessi_products_updated_at ON public.modessi_products;
CREATE TRIGGER update_modessi_products_updated_at
  BEFORE UPDATE ON public.modessi_products
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. Recorded order costs (admin read-only, frozen) ---------------------------------------------
CREATE TABLE IF NOT EXISTS public.order_modessi_costs (
  order_id uuid PRIMARY KEY REFERENCES public.orders(id) ON DELETE CASCADE,
  cost numeric(10,2) NOT NULL CHECK (cost >= 0),
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.order_modessi_costs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can view order modessi costs" ON public.order_modessi_costs;
CREATE POLICY "Admins can view order modessi costs"
  ON public.order_modessi_costs
  FOR SELECT
  TO authenticated
  USING ((SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role)));

-- Only the database functions below write here. Rows go away only with their order.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.order_modessi_costs FROM anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.prevent_modessi_cost_changes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'A recorded Modessi cost cannot be changed'
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS order_modessi_costs_block_update ON public.order_modessi_costs;
CREATE TRIGGER order_modessi_costs_block_update
  BEFORE UPDATE ON public.order_modessi_costs
  FOR EACH ROW EXECUTE FUNCTION public.prevent_modessi_cost_changes();

DROP TRIGGER IF EXISTS order_modessi_costs_block_truncate ON public.order_modessi_costs;
CREATE TRIGGER order_modessi_costs_block_truncate
  BEFORE TRUNCATE ON public.order_modessi_costs
  FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_modessi_cost_changes();

-- 3. Cost calculation ----------------------------------------------------------------------------
-- Sum of quantity × price over the order's Modessi items. NULL when the order has no Modessi item
-- or a Modessi item has no price yet. Items whose product link was lost (product_id NULL) are
-- matched by product name instead.
CREATE OR REPLACE FUNCTION public.modessi_order_cost(_order_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN count(mp.product_id) = 0 THEN NULL
    WHEN bool_or(mp.product_id IS NOT NULL AND mp.price IS NULL) THEN NULL
    ELSE sum(CASE WHEN mp.product_id IS NOT NULL THEN oi.quantity * mp.price ELSE 0 END)
  END
  FROM public.order_items oi
  LEFT JOIN public.modessi_products mp
    ON mp.product_id = COALESCE(
      oi.product_id,
      (SELECT p.id FROM public.products p WHERE p.name = oi.product_name ORDER BY p.created_at LIMIT 1)
    )
  WHERE oi.order_id = _order_id;
$$;

-- Not callable through the API: it would reveal wholesale cost.
REVOKE EXECUTE ON FUNCTION public.modessi_order_cost(uuid) FROM PUBLIC, anon, authenticated;

-- 4. Record the cost when an order is sent / its courier status changes -------------------------
CREATE OR REPLACE FUNCTION public.record_order_modessi_cost()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _cost numeric;
BEGIN
  IF NEW.steadfast_consignment_id IS NULL
     OR EXISTS (SELECT 1 FROM public.order_modessi_costs WHERE order_id = NEW.id) THEN
    RETURN NULL;
  END IF;
  _cost := public.modessi_order_cost(NEW.id);
  IF _cost IS NOT NULL THEN
    INSERT INTO public.order_modessi_costs (order_id, cost)
    VALUES (NEW.id, _cost)
    ON CONFLICT (order_id) DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_order_modessi_cost() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS orders_record_modessi_cost ON public.orders;
CREATE TRIGGER orders_record_modessi_cost
  AFTER INSERT OR UPDATE OF steadfast_consignment_id, courier_status ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.record_order_modessi_cost();

-- 5. Fill in waiting orders when a Modessi product's price is set ---------------------------------
CREATE OR REPLACE FUNCTION public.record_modessi_costs_for_product()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _name text;
BEGIN
  IF NEW.price IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT p.name INTO _name FROM public.products p WHERE p.id = NEW.product_id;

  INSERT INTO public.order_modessi_costs (order_id, cost)
  SELECT o.id, c.cost
  FROM public.orders o
  CROSS JOIN LATERAL (SELECT public.modessi_order_cost(o.id) AS cost) c
  WHERE o.steadfast_consignment_id IS NOT NULL
    AND c.cost IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.order_modessi_costs x WHERE x.order_id = o.id)
    AND EXISTS (
      SELECT 1 FROM public.order_items oi
      WHERE oi.order_id = o.id
        AND (oi.product_id = NEW.product_id OR (oi.product_id IS NULL AND oi.product_name = _name))
    )
  ON CONFLICT (order_id) DO NOTHING;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_modessi_costs_for_product() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS modessi_products_record_costs ON public.modessi_products;
CREATE TRIGGER modessi_products_record_costs
  AFTER INSERT OR UPDATE OF price ON public.modessi_products
  FOR EACH ROW EXECUTE FUNCTION public.record_modessi_costs_for_product();
