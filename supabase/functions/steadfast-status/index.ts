import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildCourierUpdate } from "../_shared/steadfastStatus.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface StatusRequest {
  tracking_codes?: string[];
  invoices?: string[];
}

interface SteadfastStatus {
  tracking_code: string;
  consignment_id?: string;
  invoice?: string;
  recipient_name?: string;
  recipient_phone?: string;
  recipient_address?: string;
  cod_amount?: number;
  delivery_status?: string;
  current_status?: string;
  rider_name?: string;
  rider_phone?: string;
  updated_at?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getCredentials(supabase: any) {
  const { data: settings } = await supabase
    .from('admin_settings')
    .select('key, value')
    .in('key', ['steadfast_api_key', 'steadfast_secret_key']);

  let apiKey = '';
  let secretKey = '';

  settings?.forEach((setting: { key: string; value: string }) => {
    if (setting.key === 'steadfast_api_key') {
      apiKey = setting.value;
    } else if (setting.key === 'steadfast_secret_key') {
      secretKey = setting.value;
    }
  });

  if (!apiKey) apiKey = Deno.env.get('STEADFAST_API_KEY') || '';
  if (!secretKey) secretKey = Deno.env.get('STEADFAST_SECRET_KEY') || '';

  return { apiKey, secretKey };
}

// Only signed-in admins may call this function.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function isAdminRequest(supabase: any, req: Request): Promise<boolean> {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return false;
  const { data: isAdmin, error: roleError } = await supabase.rpc('has_role', {
    _user_id: user.id,
    _role: 'admin',
  });
  return !roleError && isAdmin === true;
}

// Save fetched statuses on the matching Steadfast orders, with the same rules
// as the webhook (never regress a final status, map final status to orders.status).
async function persistStatuses(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  results: Record<string, SteadfastStatus | { error: string }>,
): Promise<number> {
  const codes = Object.keys(results).filter((code) => {
    const r = results[code];
    return !('error' in r) && Boolean(r.current_status);
  });
  if (codes.length === 0) return 0;

  const { data: orders, error } = await supabase
    .from('orders')
    .select('id, tracking_number, status, courier_status, courier_status_updated_at')
    .in('tracking_number', codes)
    .not('steadfast_consignment_id', 'is', null);
  if (error) {
    console.error('Failed to load orders for status save:', error);
    return 0;
  }

  let saved = 0;
  const now = Date.now();
  for (const order of orders ?? []) {
    const status = (results[order.tracking_number] as SteadfastStatus).current_status;
    const result = buildCourierUpdate(order, { status }, now);
    if (!result.apply) continue;
    const { error: updateError } = await supabase.from('orders').update(result.update).eq('id', order.id);
    if (updateError) console.error(`Failed to save status for ${order.tracking_number}:`, updateError);
    else saved++;
  }
  return saved;
}

async function getStatusByTrackingCode(
  trackingCode: string,
  apiKey: string,
  secretKey: string
): Promise<{ success: boolean; data?: SteadfastStatus; error?: string }> {
  try {
    const response = await fetch(
      `https://portal.packzy.com/api/v1/status_by_trackingcode/${trackingCode}`,
      {
        method: 'GET',
        headers: {
          'Api-Key': apiKey,
          'Secret-Key': secretKey,
          'Content-Type': 'application/json',
        },
      }
    );

    const data = await response.json();
    console.log(`Status for ${trackingCode}:`, JSON.stringify(data));

    if (!response.ok || data.status !== 200) {
      return {
        success: false,
        error: data.message || 'Failed to get status',
      };
    }

    return {
      success: true,
      data: {
        tracking_code: trackingCode,
        consignment_id: data.consignment?.consignment_id,
        invoice: data.consignment?.invoice,
        recipient_name: data.consignment?.recipient_name,
        recipient_phone: data.consignment?.recipient_phone,
        recipient_address: data.consignment?.recipient_address,
        cod_amount: data.consignment?.cod_amount,
        delivery_status: data.consignment?.delivery_status,
        current_status: data.delivery_status || data.consignment?.delivery_status,
        rider_name: data.consignment?.rider_name,
        rider_phone: data.consignment?.rider_phone,
        updated_at: data.consignment?.updated_at,
      },
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Error fetching status for ${trackingCode}:`, errorMessage);
    return { success: false, error: errorMessage };
  }
}

Deno.serve(async (req) => {
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
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    if (!(await isAdminRequest(supabase, req))) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { apiKey, secretKey } = await getCredentials(supabase);

    if (!apiKey || !secretKey) {
      console.error('Steadfast credentials not configured');
      return new Response(
        JSON.stringify({ error: 'Steadfast credentials not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const body: StatusRequest = await req.json();
    const trackingCodes = body.tracking_codes || [];

    if (trackingCodes.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No tracking codes provided' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Fetching status for ${trackingCodes.length} tracking codes`);

    const results: Record<string, SteadfastStatus | { error: string }> = {};

    // Fetch status for each tracking code (with rate limiting)
    for (const trackingCode of trackingCodes) {
      const result = await getStatusByTrackingCode(trackingCode, apiKey, secretKey);
      
      if (result.success && result.data) {
        results[trackingCode] = result.data;
      } else {
        results[trackingCode] = { error: result.error || 'Unknown error' };
      }

      // Small delay to avoid rate limiting
      if (trackingCodes.length > 1) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    const saved = await persistStatuses(supabase, results);
    console.log(`Saved ${saved} status change(s) to orders`);

    return new Response(
      JSON.stringify({
        success: true,
        saved,
        results
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: unknown) {
    console.error('Error in steadfast-status function:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
