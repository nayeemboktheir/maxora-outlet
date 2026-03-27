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

async function getAccessToken(baseUrl: string, clientId: string, clientSecret: string, clientContext: string): Promise<string> {
  const authPaths = ['/api/auth/token', '/api/v1/auth/token', '/oauth/token'];
  const payload = {
    client_id: clientId,
    client_secret: clientSecret,
    client_context: clientContext,
    grant_type: 'client_credentials',
  };

  let lastError = 'Failed to get Carrybee access token';

  for (const path of authPaths) {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const rawText = await response.text();
      let data: Record<string, unknown> = {};

      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch {
        data = {};
      }

      const accessToken =
        (typeof data.access_token === 'string' && data.access_token) ||
        (typeof data.token === 'string' && data.token) ||
        '';

      if (response.ok && accessToken) {
        console.log(`Carrybee token success via ${path}`);
        return accessToken;
      }

      const message =
        (typeof data.message === 'string' && data.message) ||
        (typeof data.error === 'string' && data.error) ||
        rawText ||
        `HTTP ${response.status}`;

      lastError = `${path}: ${message.substring(0, 200)}`;

      if (response.ok) {
        continue;
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown auth request error';
      lastError = `${path}: ${errorMessage}`;
    }
  }

  throw new Error(lastError);
}

async function sendToCarrybee(
  order: CarrybeeOrderRequest,
  baseUrl: string,
  accessToken: string,
  storeId: string
): Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }> {
  try {
    const response = await fetch(`${baseUrl}/api/v1/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        store_id: order.store_id || storeId,
        invoice_number: order.invoice,
        recipient_name: order.recipient_name,
        recipient_phone: order.recipient_phone,
        recipient_address: order.recipient_address,
        cod_amount: order.cod_amount,
        note: order.note || '',
      }),
    });

    const rawText = await response.text();
    let data: Record<string, unknown> = {};

    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      data = { raw: rawText };
    }

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

    // Get access token
    let accessToken: string;
    try {
      accessToken = await getAccessToken(baseUrl, clientId, clientSecret, clientContext);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Auth failed';
      return new Response(
        JSON.stringify({ error: `Carrybee authentication failed: ${msg}` }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
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
