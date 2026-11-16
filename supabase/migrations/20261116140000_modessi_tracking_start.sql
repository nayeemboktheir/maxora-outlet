-- Modessi tracking starts on 16 Nov 2026 (Bangladesh time). Orders placed before then are
-- ignored by the Modessi admin page and are never forwarded to Modessi, even when edited.
-- Change the date in admin_settings.modessi_tracking_start (ISO timestamp); delete it to
-- track every order.

INSERT INTO public.admin_settings (key, value)
SELECT 'modessi_tracking_start', '2026-11-15T18:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM public.admin_settings WHERE key = 'modessi_tracking_start');

CREATE OR REPLACE FUNCTION public.flag_modessi_order_change(_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _start timestamptz;
BEGIN
  -- Also flags links still being sent, so an edit that lands mid-send is pushed afterwards.
  UPDATE public.modessi_order_links
  SET needs_update = true, dirty_at = clock_timestamp()
  WHERE order_id = _order_id AND state <> 'cancelled';

  IF NOT FOUND THEN
    SELECT NULLIF(value, '')::timestamptz INTO _start
    FROM public.admin_settings WHERE key = 'modessi_tracking_start';

    INSERT INTO public.modessi_order_links (order_id, state)
    SELECT o.id, 'pending'
    FROM public.orders o
    WHERE o.id = _order_id
      AND o.status IN ('pending', 'confirmed')
      AND o.steadfast_consignment_id IS NULL
      AND (_start IS NULL OR o.created_at >= _start)
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
