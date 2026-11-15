-- Store Steadfast's delivery outcome on each order.
--
-- steadfast_sent_at          when the order was sent to Steadfast (set by steadfast-courier).
--                            The Modessi page groups orders into days by this date.
-- courier_status             latest Steadfast status, lower-cased (e.g. pending, delivered,
--                            partial_delivered, cancelled). Written by the steadfast-webhook
--                            receiver and by the manual sync in steadfast-status.
-- courier_cod_amount         cash Steadfast reports as collected (from the webhook).
-- courier_delivery_charge    Steadfast's charge for the parcel (from the webhook).
-- courier_status_updated_at  time of the event that set courier_status.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS steadfast_sent_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS courier_status text,
  ADD COLUMN IF NOT EXISTS courier_cod_amount numeric(10,2),
  ADD COLUMN IF NOT EXISTS courier_delivery_charge numeric(10,2),
  ADD COLUMN IF NOT EXISTS courier_status_updated_at timestamp with time zone;

CREATE INDEX IF NOT EXISTS idx_orders_steadfast_sent_at
  ON public.orders (steadfast_sent_at)
  WHERE steadfast_sent_at IS NOT NULL;

-- Orders sent before this column existed: the real send time is unknown, so use
-- the order's creation time as an approximation.
UPDATE public.orders
SET steadfast_sent_at = created_at
WHERE steadfast_consignment_id IS NOT NULL
  AND steadfast_sent_at IS NULL;
