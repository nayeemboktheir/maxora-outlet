// Receives Steadfast delivery-status webhooks and records them on the order.
//
// Setup (Steadfast merchant panel → Webhook):
//   Callback URL: https://<project>.supabase.co/functions/v1/steadfast-webhook
//   Auth token:   the value saved as `steadfast_webhook_token` in Admin → Courier Settings
//
// Steadfast sends `Authorization: Bearer <token>`. This function must be deployed
// with verify_jwt = false (see supabase/config.toml) because Steadfast does not
// send a Supabase JWT; the bearer token check below replaces it.
//
// Steadfast retries on 5xx / timeout but never on 4xx, so:
//   - bad token / bad payload → 401 / 400
//   - unknown consignment or non-status events → 200 (nothing to retry)
//   - database errors → 500 (worth a retry)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildCourierUpdate, safeEqual } from "../_shared/steadfastStatus.ts";

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getWebhookToken(supabase: any): Promise<string> {
  const { data } = await supabase
    .from('admin_settings')
    .select('value')
    .eq('key', 'steadfast_webhook_token')
    .maybeSingle();
  return (data?.value || Deno.env.get('STEADFAST_WEBHOOK_TOKEN') || '').trim();
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return json(405, { status: 'error', message: 'Method not allowed' });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // 1. Authenticate
  const expected = await getWebhookToken(supabase);
  const provided = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!expected || !provided || !safeEqual(provided, expected)) {
    console.warn('steadfast-webhook: rejected request with missing or wrong token');
    return json(401, { status: 'error', message: 'Unauthorized' });
  }

  // 2. Parse
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return json(400, { status: 'error', message: 'Invalid JSON' });
  }

  const type = String(payload?.notification_type || 'delivery_status').toLowerCase();
  if (type !== 'delivery_status') {
    console.log(`steadfast-webhook: ignoring ${type} event`);
    return json(200, { status: 'success', message: `Ignored ${type}` });
  }

  const consignmentId = payload?.consignment_id != null ? String(payload.consignment_id).trim() : '';
  const invoice = payload?.invoice != null ? String(payload.invoice).trim() : '';
  if (!consignmentId && !invoice) {
    return json(400, { status: 'error', message: 'consignment_id or invoice is required' });
  }

  // 3. Find the order (consignment id first, invoice = order number as fallback)
  const columns = 'id, order_number, status, courier_status, courier_status_updated_at';
  let order = null;
  if (consignmentId) {
    const { data, error } = await supabase
      .from('orders').select(columns).eq('steadfast_consignment_id', consignmentId).limit(1).maybeSingle();
    if (error) {
      console.error('steadfast-webhook: lookup failed', error);
      return json(500, { status: 'error', message: 'Lookup failed' });
    }
    order = data;
  }
  if (!order && invoice) {
    const { data, error } = await supabase
      .from('orders').select(columns).eq('order_number', invoice).limit(1).maybeSingle();
    if (error) {
      console.error('steadfast-webhook: lookup failed', error);
      return json(500, { status: 'error', message: 'Lookup failed' });
    }
    order = data;
  }
  if (!order) {
    console.warn(`steadfast-webhook: no order for consignment ${consignmentId} / invoice ${invoice}`);
    return json(200, { status: 'success', message: 'No matching order' });
  }

  // 4. Apply
  const result = buildCourierUpdate(order, payload, Date.now());
  if (!result.apply) {
    console.log(`steadfast-webhook: ${order.order_number} skipped (${result.reason})`);
    return json(200, { status: 'success', message: `Skipped: ${result.reason}` });
  }

  const { error: updateError } = await supabase.from('orders').update(result.update).eq('id', order.id);
  if (updateError) {
    console.error('steadfast-webhook: update failed', updateError);
    return json(500, { status: 'error', message: 'Update failed' });
  }

  console.log(`steadfast-webhook: ${order.order_number} → ${result.update.courier_status} (${result.outcome})`);
  return json(200, { status: 'success', message: 'Webhook received successfully.' });
});
