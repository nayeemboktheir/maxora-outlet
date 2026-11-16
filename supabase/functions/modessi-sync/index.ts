// modessi-sync: admin buttons and the 15-minute cron for the Modessi connection.
//
//   { action: 'catalog' }        Modessi's catalogue, for linking products by hand
//   { action: 'link', productId, modessiProductId | null }   link / unlink one product
//   { action: 'auto_link' }      link products whose names match a Modessi product
//   { action: 'sync_prices' }    wholesale price + stock from Modessi onto linked products
//   { action: 'forward', orderId }   (re)send one order to Modessi
//   { action: 'push_updates', orderIds }  push edits / cancellations of these orders now
//   { action: 'sync_statuses' }  status, tracking and courier money from Modessi
//   { action: 'sync_payments' | 'record_payment' | 'delete_payment' }  payments from Modessi
//   { action: 'all' }            prices + pending sends/edits + statuses + payments (cron)
//
// Callers: an admin (their session JWT) or the cron (service-role key).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeEqual } from '../_shared/steadfastStatus.ts';
import {
  autoLink,
  fetchCatalog,
  forwardOrder,
  modessiConfigured,
  pushPending,
  pushUpdate,
  syncPayments,
  recordPayment,
  deletePayment,
  syncPrices,
  syncStatuses,
} from '../_shared/modessi.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // Service role (cron) or a signed-in admin.
  const token = (req.headers.get('authorization') ?? '').replace(/^bearer\s+/i, '').trim();
  if (!token) return json({ error: 'Unauthorized' }, 401);
  if (!safeEqual(token, serviceKey)) {
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return json({ error: 'Unauthorized' }, 401);
    const { data: role } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .eq('role', 'admin')
      .maybeSingle();
    if (!role) return json({ error: 'Admin access required' }, 403);
  }

  if (!modessiConfigured()) {
    return json({ error: 'Modessi is not connected yet: set MODESSI_FUNCTIONS_URL, MODESSI_ANON_KEY and MODESSI_PARTNER_KEY in Supabase secrets.' }, 400);
  }

  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* empty body = {} */
  }

  try {
    switch (body.action) {
      case 'catalog':
        return json({ products: await fetchCatalog() });

      case 'link': {
        const productId = String(body.productId ?? '');
        const modessiProductId = body.modessiProductId === null ? null : String(body.modessiProductId ?? '');
        if (!UUID_RE.test(productId) || (modessiProductId !== null && !UUID_RE.test(modessiProductId))) {
          return json({ error: 'productId and modessiProductId must be ids' }, 400);
        }
        const { error } = await supabase
          .from('modessi_products')
          .upsert({ product_id: productId, modessi_product_id: modessiProductId, modessi_name: body.modessiName ?? null }, { onConflict: 'product_id' });
        if (error) throw error;
        return json({ ok: true });
      }

      case 'auto_link': {
        const catalog = await fetchCatalog();
        const linked = await autoLink(supabase, catalog);
        const prices = await syncPrices(supabase, catalog);
        return json({ ...linked, prices });
      }

      case 'sync_prices':
        return json(await syncPrices(supabase));

      case 'forward': {
        const orderId = String(body.orderId ?? '');
        if (!UUID_RE.test(orderId)) return json({ error: 'orderId required' }, 400);
        return json(await forwardOrder(supabase, orderId));
      }

      case 'push_updates': {
        // Called by the admin pages right after an order is edited or its status changed.
        const ids: string[] = Array.isArray(body.orderIds) ? body.orderIds.map(String).filter((x: string) => UUID_RE.test(x)).slice(0, 100) : [];
        const results = [];
        for (const id of ids) results.push({ orderId: id, ...(await pushUpdate(supabase, id)) });
        return json({ results });
      }

      case 'sync_statuses':
        return json(await syncStatuses(supabase));

      case 'sync_payments':
        return json(await syncPayments(supabase));

      case 'record_payment': {
        const amount = Number(body.amount);
        const paidAt = String(body.paidAt ?? '');
        if (!Number.isFinite(amount) || amount === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(paidAt)) {
          return json({ error: 'amount (not 0) and paidAt (yyyy-mm-dd) are required' }, 400);
        }
        const note = typeof body.note === 'string' ? body.note.trim().slice(0, 300) : null;
        return json(await recordPayment(supabase, { amount, paid_at: paidAt, note }));
      }

      case 'delete_payment': {
        const id = String(body.paymentId ?? '');
        if (!UUID_RE.test(id)) return json({ error: 'paymentId required' }, 400);
        return json(await deletePayment(supabase, id));
      }

      case 'all': {
        const safe = <T,>(p: Promise<T>) => p.catch((e) => ({ error: (e as Error).message }));
        const prices = await safe(syncPrices(supabase));
        const pushed = await safe(pushPending(supabase));
        const statuses = await safe(syncStatuses(supabase));
        const payments = await safe(syncPayments(supabase));
        return json({ prices, pushed, statuses, payments });
      }

      default:
        return json({ error: 'Unknown action' }, 400);
    }
  } catch (err) {
    console.error(`modessi-sync ${body.action} failed:`, err);
    return json({ error: (err as Error)?.message ?? 'Failed' }, 500);
  }
});
