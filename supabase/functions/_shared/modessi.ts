// Modessi sync: Maxora sells Modessi products, Modessi packs, ships and collects COD.
//
// Everything talks to Modessi's `partner-api` edge function. Configure with Supabase secrets:
//   MODESSI_FUNCTIONS_URL  e.g. https://<modessi supabase host>/functions/v1
//   MODESSI_ANON_KEY       Modessi's public anon key (only gets the request past its router)
//   MODESSI_PARTNER_KEY    the secret that Modessi's PARTNER_KEYS lists as `maxora:<secret>`
//
// Used by place-order (send a new order straight away) and modessi-sync (admin buttons + cron).

// Functions here pin different supabase-js versions, whose client types don't match each other.
// deno-lint-ignore no-explicit-any
type SupabaseClient = any;
import { buildCourierUpdate, courierOutcome } from './steadfastStatus.ts';

const TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 5;
const FINAL_STATUSES = ['delivered', 'cancelled', 'returned'];

export class ModessiError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
  }
}

export function modessiConfigured(): boolean {
  return Boolean(
    Deno.env.get('MODESSI_FUNCTIONS_URL') && Deno.env.get('MODESSI_ANON_KEY') && Deno.env.get('MODESSI_PARTNER_KEY'),
  );
}

// deno-lint-ignore no-explicit-any
export async function callModessi(action: string, payload: Record<string, unknown> = {}): Promise<any> {
  if (!modessiConfigured()) throw new ModessiError('Modessi sync is not configured (MODESSI_* secrets missing)');

  const base = Deno.env.get('MODESSI_FUNCTIONS_URL')!.replace(/\/+$/, '');
  const anon = Deno.env.get('MODESSI_ANON_KEY')!;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${base}/partner-api`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${anon}`,
        apikey: anon,
        'x-partner-key': Deno.env.get('MODESSI_PARTNER_KEY')!,
      },
      body: JSON.stringify({ action, ...payload }),
      signal: controller.signal,
    });
    const text = await res.text();
    // deno-lint-ignore no-explicit-any
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* keep text for the error */
    }
    if (!res.ok) throw new ModessiError(data?.error ?? (text.slice(0, 200) || `HTTP ${res.status}`), res.status);
    return data;
  } catch (err) {
    if (err instanceof ModessiError) throw err;
    throw new ModessiError((err as Error)?.name === 'AbortError' ? 'Modessi did not answer in time' : String((err as Error)?.message ?? err));
  } finally {
    clearTimeout(timer);
  }
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const money = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Orders: Maxora -> Modessi
// ---------------------------------------------------------------------------

type OrderItem = {
  product_id: string | null;
  variation_name: string | null;
  color: string | null;
  size_name: string | null;
  product_name: string;
  price: number;
  quantity: number;
};

type Payload =
  | { kind: 'order'; full: boolean; order: Record<string, unknown> }
  | { kind: 'none'; reason: string; cancel: boolean }
  | { kind: 'unlinked'; full: boolean; message: string };

/**
 * What Modessi should have for this Maxora order right now.
 *   order     its Modessi items, customer and money
 *   none      nothing for Modessi (no Modessi items any more, or cancelled); cancel = a cancel
 *             is wanted (false while the order looks half-saved, e.g. items mid-replace)
 *   unlinked  has Modessi items that are not linked to a Modessi product yet
 */
async function buildPayload(supabase: SupabaseClient, orderId: string): Promise<Payload> {
  const { data: order, error } = await supabase
    .from('orders')
    .select(
      'id, order_number, status, subtotal, shipping_cost, discount, total, payment_method, shipping_name, shipping_phone, shipping_street, steadfast_note, ' +
        'order_items(product_id, variation_name, color, size_name, product_name, price, quantity)',
    )
    .eq('id', orderId)
    .single();
  if (error) throw error;

  const items = (order.order_items ?? []) as OrderItem[];
  if (order.status === 'cancelled') return { kind: 'none', reason: 'order is cancelled', cancel: true };
  if (items.length === 0) return { kind: 'none', reason: 'order has no items right now', cancel: false };

  const productIds = Array.from(new Set(items.map((i) => i.product_id).filter((x): x is string => !!x)));
  const { data: marked, error: markedError } = productIds.length
    ? await supabase.from('modessi_products').select('product_id, modessi_product_id').in('product_id', productIds)
    : { data: [], error: null };
  if (markedError) throw markedError;

  const link = new Map<string, string | null>(
    (marked ?? []).map((m: { product_id: string; modessi_product_id: string | null }) => [m.product_id, m.modessi_product_id]),
  );
  const modessiItems = items.filter((i) => i.product_id && link.has(i.product_id));
  if (modessiItems.length === 0) return { kind: 'none', reason: 'no Modessi items', cancel: true };

  const full = modessiItems.length === items.length;
  const unlinked = modessiItems.filter((i) => !link.get(i.product_id!));
  if (unlinked.length > 0) {
    return { kind: 'unlinked', full, message: `Not linked to a Modessi product: ${unlinked.map((i) => i.product_name).join(', ')}` };
  }

  // Money. Whole order: Modessi collects exactly what Maxora would have. Split order: Modessi
  // collects its items' share (discount spread by value); delivery fee stays on Maxora's parcel.
  const subtotal = Number(order.subtotal) || 0;
  const modessiSubtotal = modessiItems.reduce((s, i) => s + Number(i.price) * i.quantity, 0);
  const share = subtotal > 0 ? modessiSubtotal / subtotal : 0;
  const isCod = order.payment_method === 'cod';
  const shippingCost = full ? Number(order.shipping_cost) || 0 : 0;
  const discount = full ? Number(order.discount) || 0 : money((Number(order.discount) || 0) * share);
  const codAmount = !isCod ? 0 : full ? Number(order.total) || 0 : money(modessiSubtotal - discount);

  return {
    kind: 'order',
    full,
    order: {
      partner_order_id: orderId,
      partner_order_number: order.order_number,
      customer: { name: order.shipping_name, phone: order.shipping_phone, address: order.shipping_street },
      items: modessiItems.map((i) => ({
        modessi_product_id: link.get(i.product_id!),
        options: [i.variation_name, i.color, i.size_name].filter((x): x is string => !!x && !!x.trim()),
        description: i.product_name,
        quantity: i.quantity,
        price: Number(i.price),
      })),
      shipping_cost: shippingCost,
      discount,
      cod_amount: codAmount,
      note: [full ? null : 'Split order: only these items', order.steadfast_note].filter(Boolean).join(' | '),
    },
  };
}

export type ForwardResult =
  | { status: 'sent'; modessiOrderNumber: string | null; full: boolean }
  | { status: 'updated'; full: boolean }
  | { status: 'cancelled' }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string };

/**
 * Send the Modessi items of one Maxora order to Modessi. Safe to call again: Modessi answers
 * a repeat with the order it already made. A link already 'sent' goes through pushUpdate.
 */
export async function forwardOrder(supabase: SupabaseClient, orderId: string): Promise<ForwardResult> {
  const { data: existing } = await supabase
    .from('modessi_order_links')
    .select('state, attempts, dirty_at')
    .eq('order_id', orderId)
    .maybeSingle();
  if (existing?.state === 'sent') return pushUpdate(supabase, orderId);
  const dirtyAt: string | null = existing?.dirty_at ?? null;
  if (existing?.state === 'cancelled') return { status: 'skipped', reason: 'cancelled' };
  const attempts = (existing?.attempts ?? 0) + 1;

  // Never ship twice: Maxora already gave this order to a courier itself.
  const { data: courier } = await supabase
    .from('orders')
    .select('steadfast_consignment_id, tracking_number')
    .eq('id', orderId)
    .maybeSingle();
  if (courier?.steadfast_consignment_id || courier?.tracking_number) {
    return { status: 'skipped', reason: 'already sent to a courier' };
  }

  const payload = await buildPayload(supabase, orderId);

  if (payload.kind === 'none') {
    // Nothing ever reached Modessi: drop the waiting link so it is not retried forever.
    if (existing && payload.cancel) await supabase.from('modessi_order_links').delete().eq('order_id', orderId).neq('state', 'sent');
    return { status: 'skipped', reason: payload.reason };
  }

  const fail = async (message: string, full: boolean): Promise<ForwardResult> => {
    await supabase.from('modessi_order_links').upsert({
      order_id: orderId,
      full_order: full,
      state: 'failed',
      last_error: message.slice(0, 500),
      attempts,
    });
    return { status: 'failed', error: message };
  };

  if (payload.kind === 'unlinked') return fail(payload.message, payload.full);

  await supabase
    .from('modessi_order_links')
    .upsert({ order_id: orderId, full_order: payload.full, state: existing?.state ?? 'pending', attempts: existing?.attempts ?? 0 });

  try {
    const result = await callModessi('create_order', { order: payload.order });
    await supabase.from('modessi_order_links').upsert({
      order_id: orderId,
      full_order: payload.full,
      state: 'sent',
      modessi_order_id: result.order_id,
      modessi_order_number: result.order_number,
      cod_amount: result.cod_amount,
      wholesale_total: result.wholesale_total,
      modessi_status: 'pending',
      last_error: null,
      attempts,
      sent_at: new Date().toISOString(),
    });
    // Modessi got the order as read above. Clear the change flag only if no edit landed since;
    // otherwise it stays set and pushPending sends the edit.
    let clear = supabase.from('modessi_order_links').update({ needs_update: false }).eq('order_id', orderId);
    clear = dirtyAt ? clear.eq('dirty_at', dirtyAt) : clear.is('dirty_at', null);
    await clear;
    return { status: 'sent', modessiOrderNumber: result.order_number ?? null, full: payload.full };
  } catch (err) {
    return fail((err as Error)?.message ?? String(err), payload.full);
  }
}

/**
 * Bring Modessi's copy of an already-sent order up to date with Maxora's: new items, amounts or
 * customer, or a cancellation. Modessi refuses (409) once its parcel is with the courier; that is
 * recorded on the link (update_error) for the admin, since only a phone call can fix it then.
 */
export async function pushUpdate(supabase: SupabaseClient, orderId: string): Promise<ForwardResult> {
  const { data: link, error } = await supabase
    .from('modessi_order_links')
    .select('state, dirty_at')
    .eq('order_id', orderId)
    .maybeSingle();
  if (error) throw error;
  if (!link || link.state !== 'sent') return forwardOrder(supabase, orderId);

  const dirtyAt = link.dirty_at;
  // Only clear the flag if no newer edit arrived while this push was running.
  const settle = async (fields: Record<string, unknown>) => {
    let q = supabase.from('modessi_order_links').update({ ...fields, needs_update: false }).eq('order_id', orderId);
    q = dirtyAt ? q.eq('dirty_at', dirtyAt) : q.is('dirty_at', null);
    await q;
  };
  const refused = (err: unknown) => err instanceof ModessiError && (err.status === 409 || err.status === 404);

  const payload = await buildPayload(supabase, orderId);

  if (payload.kind === 'none') {
    if (!payload.cancel) return { status: 'skipped', reason: payload.reason };
    try {
      await callModessi('cancel_order', { partner_order_id: orderId });
      await settle({ state: 'cancelled', modessi_status: 'cancelled', update_error: null, synced_at: new Date().toISOString() });
      return { status: 'cancelled' };
    } catch (err) {
      const message = refused(err)
        ? `Cancelled on Maxora after Modessi gave it to the courier. Ask Modessi to stop it. (${(err as Error).message})`
        : `Cancel at Modessi failed: ${(err as Error).message}`;
      if (refused(err)) await settle({ update_error: message.slice(0, 500) });
      else await supabase.from('modessi_order_links').update({ update_error: message.slice(0, 500) }).eq('order_id', orderId);
      return { status: 'failed', error: message };
    }
  }

  if (payload.kind === 'unlinked') {
    await supabase.from('modessi_order_links').update({ update_error: payload.message }).eq('order_id', orderId);
    return { status: 'failed', error: payload.message };
  }

  try {
    const result = await callModessi('update_order', { order: payload.order });
    await settle({
      full_order: payload.full,
      cod_amount: result.cod_amount,
      wholesale_total: result.wholesale_total,
      update_error: null,
      synced_at: new Date().toISOString(),
    });
    return { status: 'updated', full: payload.full };
  } catch (err) {
    const message = refused(err)
      ? `Changed on Maxora after Modessi gave it to the courier; Modessi still has the old version. (${(err as Error).message})`
      : `Update at Modessi failed: ${(err as Error).message}`;
    if (refused(err)) await settle({ update_error: message.slice(0, 500) });
    else await supabase.from('modessi_order_links').update({ update_error: message.slice(0, 500) }).eq('order_id', orderId);
    return { status: 'failed', error: message };
  }
}

/** Send what is waiting: failed or not-yet-sent orders (up to MAX_ATTEMPTS each) and edits. */
export async function pushPending(supabase: SupabaseClient, max = 30) {
  const [waiting, changed] = await Promise.all([
    supabase.from('modessi_order_links').select('order_id').in('state', ['failed', 'pending']).lt('attempts', MAX_ATTEMPTS).order('created_at').limit(max),
    supabase.from('modessi_order_links').select('order_id').eq('state', 'sent').eq('needs_update', true).order('dirty_at').limit(max),
  ]);
  if (waiting.error) throw waiting.error;
  if (changed.error) throw changed.error;

  const results: Array<{ orderId: string } & ForwardResult> = [];
  for (const row of waiting.data ?? []) results.push({ orderId: row.order_id, ...(await forwardOrder(supabase, row.order_id)) });
  for (const row of changed.data ?? []) results.push({ orderId: row.order_id, ...(await pushUpdate(supabase, row.order_id)) });
  return results;
}

// ---------------------------------------------------------------------------
// Prices and stock: Modessi -> Maxora
// ---------------------------------------------------------------------------

type CatalogVariation = { id: string; name: string; price: number; stock: number; wholesale_price: number | null };
type CatalogProduct = {
  id: string;
  name: string;
  price: number;
  stock: number;
  image: string | null;
  wholesale_price: number | null;
  variations: CatalogVariation[];
};

export async function fetchCatalog(): Promise<CatalogProduct[]> {
  const data = await callModessi('catalog');
  return (data?.products ?? []) as CatalogProduct[];
}

/** Total units Modessi can ship of a product. */
const totalStock = (p: CatalogProduct) =>
  p.variations.length > 0 ? p.variations.reduce((s, v) => s + v.stock, 0) : p.stock;

/** One wholesale unit price for the product: its own, else the cheapest variation's. */
function productWholesale(p: CatalogProduct): number | null {
  if (p.wholesale_price !== null) return p.wholesale_price;
  const prices = p.variations.map((v) => v.wholesale_price).filter((x): x is number => x !== null);
  return prices.length > 0 ? Math.min(...prices) : null;
}

/**
 * Link Maxora products to Modessi products with the same name (ignoring case and spacing),
 * marking them as Modessi products. Products already linked are left alone.
 */
export async function autoLink(supabase: SupabaseClient, catalog?: CatalogProduct[]) {
  const products = catalog ?? (await fetchCatalog());
  const byName = new Map<string, CatalogProduct[]>();
  for (const p of products) byName.set(norm(p.name), [...(byName.get(norm(p.name)) ?? []), p]);

  const [{ data: ours, error }, { data: marked, error: markedError }] = await Promise.all([
    supabase.from('products').select('id, name'),
    supabase.from('modessi_products').select('product_id, modessi_product_id'),
  ]);
  if (error) throw error;
  if (markedError) throw markedError;
  type MarkedRow = { product_id: string; modessi_product_id: string | null };
  const linked = new Set((marked ?? [] as MarkedRow[]).filter((m: MarkedRow) => m.modessi_product_id).map((m: MarkedRow) => m.product_id));

  const rows: Array<{ product_id: string; modessi_product_id: string; modessi_name: string }> = [];
  const ambiguous: string[] = [];
  for (const p of ours ?? []) {
    if (linked.has(p.id)) continue;
    const matches = byName.get(norm(p.name)) ?? [];
    if (matches.length === 1) rows.push({ product_id: p.id, modessi_product_id: matches[0].id, modessi_name: matches[0].name });
    else if (matches.length > 1) ambiguous.push(p.name);
  }

  if (rows.length > 0) {
    const { error: upsertError } = await supabase.from('modessi_products').upsert(rows, { onConflict: 'product_id' });
    if (upsertError) throw upsertError;
  }
  return { linked: rows.length, ambiguous };
}

/** Copy wholesale price and stock from Modessi onto every linked Maxora product. */
export async function syncPrices(supabase: SupabaseClient, catalog?: CatalogProduct[]) {
  const products = catalog ?? (await fetchCatalog());
  const byId = new Map(products.map((p) => [p.id, p]));

  const { data: rows, error } = await supabase
    .from('modessi_products')
    .select('product_id, modessi_product_id, price')
    .not('modessi_product_id', 'is', null);
  if (error) throw error;

  const now = new Date().toISOString();
  let updated = 0;
  const missing: string[] = [];
  const unpriced: string[] = [];

  for (const row of rows ?? []) {
    const p = byId.get(row.modessi_product_id!);
    if (!p) {
      missing.push(row.product_id);
      continue;
    }
    const wholesale = productWholesale(p);
    if (wholesale === null) unpriced.push(p.name);
    const stock = totalStock(p);

    const { error: updateError } = await supabase
      .from('modessi_products')
      .update({
        modessi_name: p.name,
        modessi_stock: stock,
        synced_at: now,
        // Never wipe a price Maxora already has just because Modessi has none yet.
        ...(wholesale !== null && Number(row.price) !== wholesale ? { price: wholesale } : {}),
      })
      .eq('product_id', row.product_id);
    if (updateError) throw updateError;

    // Maxora's stock follows Modessi's: the product total, and each colour/size option whose
    // name matches a Modessi variation.
    await supabase.from('products').update({ stock }).eq('id', row.product_id);
    if (p.variations.length > 0) {
      const stockByName = new Map(p.variations.map((v) => [norm(v.name), v.stock]));
      for (const table of ['product_variations', 'product_sizes'] as const) {
        const { data: options } = await supabase.from(table).select('id, name, stock').eq('product_id', row.product_id);
        for (const o of options ?? []) {
          const s = stockByName.get(norm(o.name));
          if (s !== undefined && s !== o.stock) await supabase.from(table).update({ stock: s }).eq('id', o.id);
        }
      }
    }
    updated++;
  }

  return { updated, missing: missing.length, unpriced };
}

// ---------------------------------------------------------------------------
// Status and courier money: Modessi -> Maxora
// ---------------------------------------------------------------------------

// Keep asking about a finished parcel this long, for Steadfast's delivery charge to arrive.
const CHARGE_WAIT_DAYS = 30;

/** Modessi order statuses that a whole order sent to Modessi copies onto the Maxora order. */
const FOLLOWED_STATUSES = ['confirmed', 'processing', 'shipped', 'delivered', 'returned'];

export async function syncStatuses(supabase: SupabaseClient) {
  const { data: links, error } = await supabase
    .from('modessi_order_links')
    .select(
      'order_id, full_order, modessi_status, delivery_status, courier_delivery_charge, consignment_id, shipped_at, ' +
        'orders(status, tracking_number, steadfast_consignment_id, courier_status, courier_status_updated_at)',
    )
    .eq('state', 'sent')
    .order('sent_at', { ascending: false })
    .limit(500);
  if (error) throw error;

  const cutoff = Date.now() - CHARGE_WAIT_DAYS * 86_400_000;
  // deno-lint-ignore no-explicit-any
  const open = ((links ?? []) as any[]).filter((l) => {
    if (l.orders?.status === 'cancelled') return false; // handled by pushUpdate
    const parcelDone = courierOutcome(l.delivery_status ?? null) !== 'pending';
    if (parcelDone) return l.courier_delivery_charge == null && (!l.shipped_at || Date.parse(l.shipped_at) > cutoff);
    return !(['cancelled', 'delivered', 'returned'].includes(l.modessi_status ?? '') && !l.consignment_id);
  });

  let updated = 0;
  for (let i = 0; i < open.length; i += 100) {
    const batch = open.slice(i, i + 100);
    const res = await callModessi('order_status', { partner_order_ids: batch.map((l) => l.order_id) });
    // deno-lint-ignore no-explicit-any
    const byId = new Map<string, any>((res?.orders ?? []).map((o: any) => [o.partner_order_id, o]));

    for (const l of batch) {
      const m = byId.get(l.order_id);
      if (!m) continue;
      const now = new Date().toISOString();
      const shippedAt = l.shipped_at ?? (m.consignment_id ? m.sent_at ?? now : null);

      await supabase
        .from('modessi_order_links')
        .update({
          modessi_status: m.status,
          tracking_number: m.tracking_number,
          consignment_id: m.consignment_id,
          ...(m.delivery_status ? { delivery_status: m.delivery_status } : {}),
          ...(m.courier_cod_amount != null ? { courier_cod_amount: m.courier_cod_amount } : {}),
          ...(m.courier_delivery_charge != null ? { courier_delivery_charge: m.courier_delivery_charge } : {}),
          cod_amount: m.cod_amount,
          wholesale_total: m.wholesale_total,
          shipped_at: shippedAt,
          synced_at: now,
          // Modessi cancelled it before shipping (e.g. out of stock).
          ...(m.status === 'cancelled' && !m.consignment_id ? { state: 'cancelled' } : {}),
        })
        .eq('order_id', l.order_id);

      // Whole order shipped by Modessi: the Maxora order shows Modessi's parcel, including the
      // cash collected and Steadfast's real charge, so the profit page needs no estimate.
      if (l.full_order && l.orders) {
        const o = l.orders;
        const update: Record<string, unknown> = {};
        if (m.consignment_id && !o.steadfast_consignment_id) {
          update.steadfast_consignment_id = String(m.consignment_id);
          update.tracking_number = m.tracking_number ?? String(m.consignment_id);
          update.steadfast_sent_at = shippedAt;
          if (['pending', 'confirmed'].includes(o.status)) update.status = 'processing';
        }
        if (m.status === 'cancelled' && !m.consignment_id && o.status !== 'cancelled') update.status = 'cancelled';
        // Modessi packs and ships it, so its order status (processing, shipped, delivered...) is
        // the truth. A cancelled Maxora order is left alone: pushUpdate cancels it at Modessi.
        const current = (update.status as string) ?? o.status;
        if (current !== 'cancelled' && FOLLOWED_STATUSES.includes(m.status) && m.status !== current) update.status = m.status;
        if (m.delivery_status) {
          const courier = buildCourierUpdate(
            { status: (update.status as string) ?? o.status, courier_status: o.courier_status, courier_status_updated_at: o.courier_status_updated_at },
            { status: m.delivery_status, cod_amount: m.courier_cod_amount, delivery_charge: m.courier_delivery_charge },
            Date.now(),
          );
          if (courier.apply) Object.assign(update, courier.update);
          else {
            // Same status, but the money may have arrived since.
            if (m.courier_cod_amount != null) update.courier_cod_amount = m.courier_cod_amount;
            if (m.courier_delivery_charge != null) update.courier_delivery_charge = m.courier_delivery_charge;
          }
        }
        if (Object.keys(update).length > 0) {
          const { error: updateError } = await supabase.from('orders').update(update).eq('id', l.order_id);
          if (updateError) console.error('modessi status: order update failed', l.order_id, updateError.message);
        }
      }
      updated++;
    }
  }

  return { checked: open.length, updated };
}

// ---------------------------------------------------------------------------
// Payments from Modessi (both sites keep a copy; Modessi's is the master)
// ---------------------------------------------------------------------------

export async function syncPayments(supabase: SupabaseClient) {
  const res = await callModessi('payments');
  // deno-lint-ignore no-explicit-any
  const payments = (res?.payments ?? []) as any[];
  const ids = payments.map((p) => p.id);

  if (payments.length > 0) {
    const { error } = await supabase.from('modessi_payments').upsert(
      payments.map((p) => ({ id: p.id, amount: p.amount, paid_at: p.paid_at, note: p.note, recorded_by: p.recorded_by, created_at: p.created_at })),
      { onConflict: 'id' },
    );
    if (error) throw error;
  }
  // Deleted on Modessi: delete here too.
  let del = supabase.from('modessi_payments').delete();
  del = ids.length > 0 ? del.not('id', 'in', `(${ids.join(',')})`) : del.not('id', 'is', null);
  const { error: delError } = await del;
  if (delError) throw delError;

  return { payments: payments.length };
}

export async function recordPayment(
  supabase: SupabaseClient,
  payment: { amount: number; paid_at: string; note?: string | null },
) {
  const id = crypto.randomUUID();
  await callModessi('record_payment', { payment: { id, ...payment } });
  return syncPayments(supabase);
}

export async function deletePayment(supabase: SupabaseClient, paymentId: string) {
  await callModessi('delete_payment', { payment_id: paymentId });
  return syncPayments(supabase);
}
