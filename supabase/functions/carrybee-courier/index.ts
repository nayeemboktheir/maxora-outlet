import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

interface CarrybeeOrderRequest {
  orderId: string;
  invoice: string;
  recipient_name: string;
  recipient_phone: string;
  recipient_address: string;
  cod_amount: number;
  note?: string;
  store_id?: string;
}

interface BulkOrderRequest {
  orders: CarrybeeOrderRequest[];
}

async function getCredentials(supabase: any) {
  const { data: settings } = await supabase
    .from('admin_settings')
    .select('key, value')
    .in('key', ['carrybee_base_url', 'carrybee_client_id', 'carrybee_client_secret', 'carrybee_client_context', 'carrybee_store_id']);

  const creds: Record<string, string> = {};

  settings?.forEach((s: { key: string; value: string }) => {
    creds[s.key] = s.value;
  });

  return {
    baseUrl: creds.carrybee_base_url || 'https://developers.carrybee.com',
    clientId: creds.carrybee_client_id || '',
    clientSecret: creds.carrybee_client_secret || '',
    clientContext: creds.carrybee_client_context || '',
    storeId: creds.carrybee_store_id || '',
  };
}

async function safeJsonParse(rawText: string): Promise<Record<string, unknown>> {
  try {
    return rawText ? JSON.parse(rawText) : {};
  } catch {
    return { raw: rawText };
  }
}

function buildCarrybeeHeaders(clientId: string, clientSecret: string, clientContext: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Client-ID': clientId,
    'Client-Secret': clientSecret,
    'Client-Context': clientContext,
  };
}

async function fetchDefaultStoreId(
  baseUrl: string,
  clientId: string,
  clientSecret: string,
  clientContext: string,
): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v2/stores`, {
    method: 'GET',
    headers: buildCarrybeeHeaders(clientId, clientSecret, clientContext),
  });

  const rawText = await response.text();
  const data = await safeJsonParse(rawText);

  if (!response.ok) {
    const message =
      (typeof data.message === 'string' && data.message) ||
      (typeof data.error === 'string' && data.error) ||
      (typeof data.raw === 'string' && data.raw) ||
      `HTTP ${response.status}`;
    throw new Error(`Failed to load Carrybee stores: ${message}`);
  }

  const stores = ((data.data as Record<string, unknown> | undefined)?.stores as Record<string, unknown>[] | undefined) || [];
  const preferred =
    stores.find((s) => s.is_default_pickup_store === true && s.is_active === true && s.is_approved === true) ||
    stores.find((s) => s.is_active === true && s.is_approved === true) ||
    stores[0];

  const storeId = typeof preferred?.id === 'string' ? preferred.id : '';
  if (!storeId) {
    throw new Error('No Carrybee store found. Please create/approve a store in Carrybee and set Store ID in Admin Courier Settings.');
  }

  return storeId;
}

async function resolveAddressDetails(
  address: string,
  baseUrl: string,
  clientId: string,
  clientSecret: string,
  clientContext: string,
): Promise<{ city_id: number; zone_id: number; area_id?: number }> {
  const response = await fetch(`${baseUrl}/api/v2/address-details`, {
    method: 'POST',
    headers: buildCarrybeeHeaders(clientId, clientSecret, clientContext),
    body: JSON.stringify({ query: address }),
  });

  const rawText = await response.text();
  const data = await safeJsonParse(rawText);

  if (!response.ok) {
    const message =
      (typeof data.message === 'string' && data.message) ||
      (typeof data.error === 'string' && data.error) ||
      (typeof data.raw === 'string' && data.raw) ||
      `HTTP ${response.status}`;
    throw new Error(`Address lookup failed: ${message}`);
  }

  const details = (data.data as Record<string, unknown> | undefined) || {};
  const city_id = Number(details.city_id);
  const zone_id = Number(details.zone_id);
  const area_id = details.area_id !== undefined && details.area_id !== null ? Number(details.area_id) : undefined;

  if (!Number.isFinite(city_id) || !Number.isFinite(zone_id)) {
    throw new Error('Carrybee address lookup did not return valid city/zone id');
  }

  return { city_id, zone_id, area_id: Number.isFinite(area_id) ? area_id : undefined };
}

async function sendToCarrybee(
  order: CarrybeeOrderRequest,
  baseUrl: string,
  clientId: string,
  clientSecret: string,
  clientContext: string,
  storeId: string,
): Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }> {
  try {
    const recipientAddress = order.recipient_address?.trim() || '';
    if (recipientAddress.length < 10) {
      return { success: false, error: 'Recipient address must be at least 10 characters for Carrybee' };
    }

    const location = await resolveAddressDetails(recipientAddress, baseUrl, clientId, clientSecret, clientContext);

    const finalStoreId = order.store_id || storeId || await fetchDefaultStoreId(baseUrl, clientId, clientSecret, clientContext);

    const payload: Record<string, unknown> = {
      store_id: finalStoreId,
      merchant_order_id: order.invoice,
      delivery_type: 1,
      product_type: 1,
      recipient_phone: order.recipient_phone,
      recipient_name: order.recipient_name,
      recipient_address: recipientAddress,
      city_id: location.city_id,
      zone_id: location.zone_id,
      special_instruction: order.note || null,
      product_description: order.note || null,
      item_weight: 500,
      item_quantity: 1,
      collectable_amount: Math.max(0, Math.round(Number(order.cod_amount || 0))),
      is_closed: false,
    };

    if (location.area_id) {
      payload.area_id = location.area_id;
    }

    const response = await fetch(`${baseUrl}/api/v2/orders`, {
      method: 'POST',
      headers: buildCarrybeeHeaders(clientId, clientSecret, clientContext),
      body: JSON.stringify(payload),
    });

    const rawText = await response.text();
    const data = await safeJsonParse(rawText);

    if (!response.ok) {
      return {
        success: false,
        error:
          (typeof data.message === 'string' && data.message) ||
          (typeof data.error === 'string' && data.error) ||
          (typeof data.raw === 'string' && data.raw) ||
          'Failed to create Carrybee order',
        data,
      };
    }

    return { success: true, data };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage };
  }
}

Deno.serve(async (req) => {
  console.log('Carrybee courier function invoked, method:', req.method);
  
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    console.log('Starting Carrybee order processing...');
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { baseUrl, clientId, clientSecret, clientContext, storeId } = await getCredentials(supabase);

    if (!clientId || !clientSecret || !clientContext) {
      return new Response(
        JSON.stringify({ error: 'Carrybee credentials not configured. Please add them in Admin → Courier Settings → Carrybee tab.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Keep credentials header-based per Carrybee v2 docs
    if (!clientId || !clientSecret || !clientContext) {
      return new Response(
        JSON.stringify({ error: 'Carrybee credentials not configured. Please add Client ID, Client Secret and Client Context in Admin → Courier Settings → Carrybee tab.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const body = await req.json();

    // Bulk request
    if (body.orders && Array.isArray(body.orders)) {
      console.log(`Processing bulk Carrybee order: ${body.orders.length} orders`);

      const results: { orderId: string; success: boolean; tracking_code?: string; error?: string }[] = [];

      for (const order of body.orders as CarrybeeOrderRequest[]) {
        const result = await sendToCarrybee(order, baseUrl, accessToken, storeId);

        if (result.success && result.data) {
          const trackingCode = result.data.tracking_code || result.data.order_id || result.data.id;

          if (order.orderId) {
            await supabase
              .from('orders')
              .update({
                tracking_number: trackingCode,
                status: 'processing',
              })
              .eq('id', order.orderId);
          }

          results.push({ orderId: order.orderId, success: true, tracking_code: trackingCode });
        } else {
          results.push({ orderId: order.orderId, success: false, error: result.error });
        }
      }

      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;

      return new Response(
        JSON.stringify({
          success: failCount === 0,
          message: `Sent ${successCount} orders, ${failCount} failed`,
          results,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Single order
    const order = body as CarrybeeOrderRequest;
    console.log('Creating Carrybee order for:', order.invoice);

    if (!order.invoice || !order.recipient_name || !order.recipient_phone || !order.recipient_address || order.cod_amount === undefined) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const result = await sendToCarrybee(order, baseUrl, accessToken, storeId);

    if (!result.success) {
      return new Response(
        JSON.stringify({ error: result.error, details: result.data }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const trackingCode = result.data?.tracking_code || result.data?.order_id || result.data?.id;

    if (trackingCode && order.orderId) {
      await supabase
        .from('orders')
        .update({
          tracking_number: trackingCode,
          status: 'processing',
        })
        .eq('id', order.orderId);
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Order sent to Carrybee successfully',
        tracking_code: trackingCode,
        data: result.data,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: unknown) {
    console.error('Error in carrybee-courier function:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
