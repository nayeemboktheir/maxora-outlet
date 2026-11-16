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

export type ForwardResult =
  | { status: 'sent'; modessiOrderNumber: string | null; full: boolean }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string };

/**
 * Send the Modessi items of one Maxora order to Modessi. Safe to call again: Modessi answers
 * a repeat with the order it already made, and a link already 'sent' is left alone.
 */
export async function forwardOrder(supabase: SupabaseClient, orderId: string): Promise<ForwardResult> {
  const { data: order, error } = await supabase
    .from('orders')
    .select(
      'id, order_number, status, subtotal, shipping_cost, discount, total, payment_method, shipping_name, shipping_phone, shipping_street, steadfast_note, notes, ' +
        'order_items(product_id, variation_name, color, size_name, product_name, price, quantity)',
    )
    .eq('id', orderId)
    .single();
  if (error) throw error;

  // deno-lint-ignore no-explicit-any
  const items = ((order as any).order_items ?? []) as Array<{
    product_id: string | null;
    variation_name: string | null;
    color: string | null;
    size_name: string | null;
    product_name: string;
    price: number;
    quantity: number;
  }>;

  const productIds = Array.from(new Set(items.map((i) => i.product_id).filter((x): x is string => !!x)));
  if (productIds.length === 0) return { status: 'skipped', reason: 'no catalogue items' };

  const { data: marked, error: markedError } = await supabase
    .from('modessi_products')
    .select('product_id, modessi_product_id')
    .in('product_id', productIds);
  if (markedError) throw markedError;

  const link = new Map((marked ?? []).map((m: { product_id: string; modessi_product_id: string | null }) => [m.product_id, m.modessi_product_id]));
  const modessiItems = items.filter((i) => i.product_id && link.has(i.product_id));
  if (modessiItems.length === 0) return { status: 'skipped', reason: 'no Modessi items' };

  const full = modessiItems.length === items.length;

  const { data: existing } = await supabase
    .from('modessi_order_links')
    .select('state, attempts')
    .eq('order_id', orderId)
    .maybeSingle();
  if (existing?.state === 'sent') return { status: 'skipped', reason: 'already sent' };
  if (existing?.state === 'cancelled') return { status: 'skipped', reason: 'cancelled' };
  const attempts = (existing?.attempts ?? 0) + 1;

  const fail = async (message: string): Promise<ForwardResult> => {
    await supabase.from('modessi_order_links').upsert({
      order_id: orderId,
      full_order: full,
      state: 'failed',
      last_error: message.slice(0, 500),
      attempts,
    });
    return { status: 'failed', error: message };
  };

  if (order.status === 'cancelled') return { status: 'skipped', reason: 'order is cancelled' };

  const unlinked = modessiItems.filter((i) => !link.get(i.product_id!));
  if (unlinked.length > 0) {
    return fail(`Not linked to a Modessi product: ${unlinked.map((i) => i.product_name).join(', ')}`);
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

  await supabase
    .from('modessi_order_links')
    .upsert({ order_id: orderId, full_order: full, state: existing?.state ?? 'pending', attempts: existing?.attempts ?? 0 });

  try {
    const result = await callModessi('create_order', {
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
    });

    await supabase.from('modessi_order_links').upsert({
      order_id: orderId,
      full_order: full,
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
    return { status: 'sent', modessiOrderNumber: result.order_number ?? null, full };
  } catch (err) {
    return fail((err as Error)?.message ?? String(err));
  }
}

/** Retry orders that failed to send (up to MAX_ATTEMPTS tries each). */
export async function retryFailed(supabase: SupabaseClient, max = 20) {
  const { data, error } = await supabase
    .from('modessi_order_links')
    .select('order_id')
    .in('state', ['failed', 'pending'])
    .lt('attempts', MAX_ATTEMPTS)
    .order('created_at')
    .limit(max);
  if (error) throw error;

  const results: Array<{ orderId: string } & ForwardResult> = [];
  for (const row of data ?? []) {
    results.push({ orderId: row.order_id, ...(await forwardOrder(supabase, row.order_id)) });
  }
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
// Status: Modessi -> Maxora (and cancellations Maxora -> Modessi)
// ---------------------------------------------------------------------------

export async function syncStatuses(supabase: SupabaseClient) {
  const { data: links, error } = await supabase
    .from('modessi_order_links')
    .select('order_id, full_order, modessi_status, delivery_status, consignment_id, orders(status, tracking_number, steadfast_consignment_id, courier_status, courier_status_updated_at)')
    .eq('state', 'sent')
    .order('sent_at', { ascending: false })
    .limit(300);
  if (error) throw error;

  // deno-lint-ignore no-explicit-any
  // Done once Modessi closed it or the courier reached a final outcome.
  const open = (links ?? []).filter(
    // deno-lint-ignore no-explicit-any
    (l: any) => !FINAL_STATUSES.includes(l.modessi_status ?? '') && courierOutcome(l.delivery_status ?? null) === 'pending',
  ) as any[];

  // Maxora cancelled it: cancel at Modessi too, while it is not yet with the courier.
  let cancelled = 0;
  for (const l of open.filter((x) => x.orders?.status === 'cancelled')) {
    try {
      const r = await callModessi('cancel_order', { partner_order_id: l.order_id });
      if (r?.cancelled) {
        await supabase.from('modessi_order_links').update({ state: 'cancelled', modessi_status: 'cancelled', synced_at: new Date().toISOString() }).eq('order_id', l.order_id);
        cancelled++;
      }
    } catch (err) {
      await supabase.from('modessi_order_links').update({ last_error: `Cancel at Modessi failed: ${(err as Error).message}`.slice(0, 500) }).eq('order_id', l.order_id);
    }
  }

  const ask = open.filter((x) => x.orders?.status !== 'cancelled');
  let updated = 0;
  for (let i = 0; i < ask.length; i += 100) {
    const batch = ask.slice(i, i + 100);
    const res = await callModessi('order_status', { partner_order_ids: batch.map((l) => l.order_id) });
    // deno-lint-ignore no-explicit-any
    const byId = new Map<string, any>((res?.orders ?? []).map((o: any) => [o.partner_order_id, o]));

    for (const l of batch) {
      const m = byId.get(l.order_id);
      if (!m) continue;
      const now = new Date().toISOString();

      await supabase
        .from('modessi_order_links')
        .update({
          modessi_status: m.status,
          tracking_number: m.tracking_number,
          consignment_id: m.consignment_id,
          delivery_status: m.delivery_status ?? undefined,
          cod_amount: m.cod_amount,
          wholesale_total: m.wholesale_total,
          synced_at: now,
          ...(m.status === 'cancelled' ? { state: 'cancelled' } : {}),
        })
        .eq('order_id', l.order_id);

      // Whole order shipped by Modessi: the Maxora order shows Modessi's parcel.
      if (l.full_order && l.orders) {
        const o = l.orders;
        const update: Record<string, unknown> = {};
        if (m.consignment_id && !o.steadfast_consignment_id) {
          update.steadfast_consignment_id = String(m.consignment_id);
          update.tracking_number = m.tracking_number ?? String(m.consignment_id);
          update.steadfast_sent_at = now;
          if (['pending', 'confirmed'].includes(o.status)) update.status = 'processing';
        }
        if (m.status === 'cancelled' && !m.consignment_id && o.status !== 'cancelled') update.status = 'cancelled';
        if (m.delivery_status) {
          const courier = buildCourierUpdate(
            { status: (update.status as string) ?? o.status, courier_status: o.courier_status, courier_status_updated_at: o.courier_status_updated_at },
            { status: m.delivery_status },
            Date.now(),
          );
          if (courier.apply) Object.assign(update, courier.update);
        }
        if (Object.keys(update).length > 0) {
          const { error: updateError } = await supabase.from('orders').update(update).eq('id', l.order_id);
          if (updateError) console.error('modessi status: order update failed', l.order_id, updateError.message);
        }
      }
      updated++;
    }
  }

  return { checked: ask.length, updated, cancelled };
}
