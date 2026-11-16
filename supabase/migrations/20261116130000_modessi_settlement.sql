-- Modessi sync, part 2: edits after sending, Modessi's courier money, and the running balance.
--
-- 1. Edits: when a sent order's items, amounts, customer or status change on Maxora, the link
--    is flagged (needs_update) and modessi-sync pushes the change to Modessi: straight away from
--    the admin pages, and every 15 minutes by cron. An order that gains Modessi items while still
--    pending gets a 'pending' link so it is sent too.
-- 2. Courier money: Modessi's Steadfast webhook records what its courier collected and charged;
--    modessi-sync copies it here (courier_cod_amount / courier_delivery_charge, shipped_at).
-- 3. modessi_payments: Maxora's copy of what Modessi has paid (Modessi's partner_payments).
--    Balance owed by Modessi = Σ per-parcel settlement − Σ payments (src/lib/modessiSettlement.ts).

-- 1 + 2. New link columns ------------------------------------------------------------------------
ALTER TABLE public.modessi_order_links
  ADD COLUMN IF NOT EXISTS needs_update boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dirty_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS update_error text,
  ADD COLUMN IF NOT EXISTS shipped_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS courier_cod_amount numeric(10,2),
  ADD COLUMN IF NOT EXISTS courier_delivery_charge numeric(10,2);

CREATE INDEX IF NOT EXISTS modessi_order_links_needs_update_idx
  ON public.modessi_order_links (needs_update) WHERE needs_update;

-- Flag a sent order as changed, or start a link for a still-open order that now has Modessi items.
CREATE OR REPLACE FUNCTION public.flag_modessi_order_change(_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Also flags links still being sent, so an edit that lands mid-send is pushed afterwards.
  UPDATE public.modessi_order_links
  SET needs_update = true, dirty_at = clock_timestamp()
  WHERE order_id = _order_id AND state <> 'cancelled';

  IF NOT FOUND THEN
    INSERT INTO public.modessi_order_links (order_id, state)
    SELECT o.id, 'pending'
    FROM public.orders o
    WHERE o.id = _order_id
      AND o.status IN ('pending', 'confirmed')
      AND o.steadfast_consignment_id IS NULL
      AND EXISTS (
        SELECT 1 FROM public.order_items oi
        JOIN public.modessi_products mp ON mp.product_id = oi.product_id
        WHERE oi.order_id = o.id
      )
    ON CONFLICT (order_id) DO NOTHING;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.flag_modessi_order_change(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.modessi_order_items_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.flag_modessi_order_change(COALESCE(NEW.order_id, OLD.order_id));
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.modessi_order_items_changed() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS order_items_flag_modessi ON public.order_items;
CREATE TRIGGER order_items_flag_modessi
  AFTER INSERT OR UPDATE OR DELETE ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public.modessi_order_items_changed();

-- Only changes Modessi cares about. Status changes made by the sync itself (processing,
-- delivered, returned) are not pushed back; a cancellation is.
CREATE OR REPLACE FUNCTION public.modessi_order_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.shipping_name IS DISTINCT FROM OLD.shipping_name
     OR NEW.shipping_phone IS DISTINCT FROM OLD.shipping_phone
     OR NEW.shipping_street IS DISTINCT FROM OLD.shipping_street
     OR NEW.shipping_cost IS DISTINCT FROM OLD.shipping_cost
     OR NEW.discount IS DISTINCT FROM OLD.discount
     OR NEW.total IS DISTINCT FROM OLD.total
     OR NEW.payment_method IS DISTINCT FROM OLD.payment_method
     OR NEW.steadfast_note IS DISTINCT FROM OLD.steadfast_note
     OR (NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled') THEN
    PERFORM public.flag_modessi_order_change(NEW.id);
  END IF;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.modessi_order_changed() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS orders_flag_modessi ON public.orders;
CREATE TRIGGER orders_flag_modessi
  AFTER UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.modessi_order_changed();

-- 3. Payments from Modessi ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.modessi_payments (
  id          uuid PRIMARY KEY,
  amount      numeric(10,2) NOT NULL CHECK (amount <> 0),
  paid_at     date NOT NULL,
  note        text,
  recorded_by text NOT NULL DEFAULT 'partner',
  created_at  timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.modessi_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can view modessi payments" ON public.modessi_payments;
CREATE POLICY "Admins can view modessi payments"
  ON public.modessi_payments FOR SELECT TO authenticated
  USING ((SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role)));

-- Written only by modessi-sync (service role), so both copies stay the same.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.modessi_payments FROM anon, authenticated;
