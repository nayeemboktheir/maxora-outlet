-- Modessi sync: Maxora sells Modessi products; Modessi packs, ships and collects COD.
--
-- modessi_products (extended)  which Modessi product each marked Maxora product is. The price
--                              column is now filled from Modessi's wholesale price by the
--                              modessi-sync function ("Sync from Modessi" / the cron below).
-- modessi_order_links          one row per Maxora order that has Modessi items: what was sent
--                              to Modessi and the latest status Modessi reported. Both sites
--                              keep the full order; this row ties the two copies together.
--
-- full_order = true   every item is a Modessi item, so Modessi ships the whole order. Its
--                     tracking and courier status are copied onto the Maxora order too, and
--                     Maxora's own "Send to Steadfast" refuses it.
-- full_order = false  mixed order, split: Modessi ships only its items (cod_amount); Maxora
--                     ships the rest and its Steadfast COD is reduced by cod_amount.

-- 1. Link Maxora products to Modessi products --------------------------------------------------
ALTER TABLE public.modessi_products
  ADD COLUMN IF NOT EXISTS modessi_product_id uuid,
  ADD COLUMN IF NOT EXISTS modessi_name text,
  ADD COLUMN IF NOT EXISTS modessi_stock integer,
  ADD COLUMN IF NOT EXISTS synced_at timestamp with time zone;

-- 2. Forwarded orders ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.modessi_order_links (
  order_id              uuid PRIMARY KEY REFERENCES public.orders(id) ON DELETE CASCADE,
  full_order            boolean NOT NULL DEFAULT false,
  state                 text NOT NULL DEFAULT 'pending'
                        CHECK (state IN ('pending', 'sent', 'failed', 'cancelled')),
  modessi_order_id      uuid,
  modessi_order_number  text,
  cod_amount            numeric(10,2),
  wholesale_total       numeric(10,2),
  modessi_status        text,
  tracking_number       text,
  consignment_id        text,
  delivery_status       text,
  last_error            text,
  attempts              integer NOT NULL DEFAULT 0,
  sent_at               timestamp with time zone,
  synced_at             timestamp with time zone,
  created_at            timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS modessi_order_links_state_idx ON public.modessi_order_links (state);

ALTER TABLE public.modessi_order_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can view modessi order links" ON public.modessi_order_links;
CREATE POLICY "Admins can view modessi order links"
  ON public.modessi_order_links
  FOR SELECT
  TO authenticated
  USING ((SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role)));

-- Written only by the place-order and modessi-sync functions (service role).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.modessi_order_links FROM anon, authenticated;

-- 3. Automatic sync (optional, run once by hand) ------------------------------------------------
-- Pulls prices/stock and order statuses from Modessi every 15 minutes, and retries orders that
-- failed to send. Needs the pg_cron and pg_net extensions (Database → Extensions) and Maxora's
-- service-role key, which must not be committed, so this part is left for you to run:
--
-- SELECT cron.schedule('modessi-sync', '*/15 * * * *', $$
--   SELECT net.http_post(
--     url     := 'https://qrmatuhynplcqlrzpcri.supabase.co/functions/v1/modessi-sync',
--     headers := jsonb_build_object('Content-Type', 'application/json',
--                                   'Authorization', 'Bearer <MAXORA_SERVICE_ROLE_KEY>'),
--     body    := '{"action":"all"}'::jsonb
--   );
-- $$);
