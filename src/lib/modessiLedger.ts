// Money rules for the Modessi page, kept free of React and Supabase so they can be tested.
//
// Every Modessi order is in exactly one state:
//   confirmed      Steadfast delivered it (✓) and its Modessi cost is known.
//   cancelled      Steadfast cancelled it (✗). No delivery fee is taken in advance, so the
//                  parcel's delivery charge is a loss. The product comes back, so its purchase
//                  is not counted.
//   on_the_way     not delivered yet (⏳): with Steadfast, or not shipped yet (notShipped).
//   waiting_price  delivered, but a Modessi product in it has no price yet.
//
// "confirmed" money always reconciles:  profit = selling − purchase − delivery
// where delivery includes the charges lost on cancelled parcels. Everything on the way or
// waiting for a price is kept apart as "pending".
import { courierOutcome, type CourierOutcome } from '../../supabase/functions/_shared/steadfastStatus.ts';

export interface LedgerItem {
  quantity: number;
  price: number;
  product_id: string | null;
  product_name: string;
}

export interface LedgerOrderInput {
  id: string;
  order_number: string;
  shipping_name: string;
  total: number;
  shipping_cost: number | null;
  steadfast_sent_at: string | null;
  /** When the order was placed; dates orders that have not shipped yet. */
  created_at?: string;
  status?: string;
  courier_status: string | null;
  courier_cod_amount: number | null;
  courier_delivery_charge: number | null;
  tracking_number: string | null;
  tracking_url?: string | null;
  steadfast_consignment_id: string | null;
  order_items: LedgerItem[];
  // One-to-one embed; PostgREST may return it as an object or a one-element array.
  order_modessi_costs: { cost: number } | { cost: number }[] | null;
  /** The order's Modessi parcel, when its Modessi items were sent to Modessi to ship. */
  modessi_order_links?: ModessiLinkInput | ModessiLinkInput[] | null;
}

export interface ModessiLinkInput {
  full_order: boolean;
  state: string;
  cod_amount: number | null;
  wholesale_total: number | null;
  delivery_status: string | null;
  courier_cod_amount: number | null;
  courier_delivery_charge: number | null;
  shipped_at: string | null;
  tracking_number: string | null;
  consignment_id: string | null;
}

const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);

/** Sent to Modessi as a split order: Modessi's own parcel carries the Modessi items. */
const splitParcel = (o: LedgerOrderInput): ModessiLinkInput | null => {
  const link = one(o.modessi_order_links);
  return link && link.state === 'sent' && !link.full_order ? link : null;
};

/** When the Modessi items left: Modessi's parcel for split orders, else the order's own. */
export const modessiSentAt = (o: LedgerOrderInput): string | null => {
  const split = splitParcel(o);
  return split ? split.shipped_at : o.steadfast_sent_at;
};

export interface PriceBook {
  /** Marked Modessi products → unit price (null until it is set). */
  modessiPrice: Map<string, number | null>;
  /** First product id for each product name, for items whose product link was lost. */
  productIdByName: Map<string, string>;
}

export type OrderState = 'confirmed' | 'cancelled' | 'on_the_way' | 'waiting_price';

export interface LedgerOrder {
  id: string;
  order_number: string;
  shipping_name: string;
  tracking_number: string | null;
  /** Direct Steadfast tracking link, when the courier provided one. */
  tracking_url: string | null;
  /** Steadfast's consignment id, the number printed on Steadfast's own sticker. */
  steadfast_consignment_id: string | null;
  courier_status: string | null;
  outcome: CourierOutcome;
  state: OrderState;
  /** Not handed to a courier yet: 'modessi' when Modessi will ship it, else 'maxora'. */
  notShipped: 'modessi' | 'maxora' | null;
  /** Quantity of Modessi items. */
  products: number;
  /** Collected cash for delivered orders, otherwise the order total. Mixed orders: Modessi items only. */
  amount: number;
  /** Modessi cost; null when a Modessi product has no price yet. */
  cost: number | null;
  missingProducts: string[];
  /** Also contains products that are not from Modessi. */
  mixed: boolean;
  delivery: number;
  deliveryEstimated: boolean;
  /**
   * confirmed: amount − cost − delivery. cancelled: −delivery.
   * on_the_way: the expected profit (not counted yet), or null without a cost. waiting_price: null.
   */
  profit: number | null;
}

export interface Money {
  selling: number;
  purchase: number;
  delivery: number;
}

export interface LedgerTotals {
  orderCount: number;
  products: number;
  delivered: number;
  cancelled: number;
  onTheWay: number;
  waitingPrice: number;
  /** Counted money. profit = selling − purchase − delivery. */
  confirmed: Money & { profit: number };
  /** Orders on the way or waiting for a price; not counted yet. */
  pending: Money;
  /** Delivery charges lost on cancelled parcels (already inside confirmed.delivery). */
  cancelledLoss: number;
  /** Some delivery figure is still the order's own fee, not Steadfast's charge. */
  deliveryEstimated: boolean;
}

export interface LedgerDay extends LedgerTotals {
  date: string;
  orders: LedgerOrder[];
  /** Nothing on the way and nothing waiting for a price. */
  complete: boolean;
}

const emptyTotals = (): LedgerTotals => ({
  orderCount: 0,
  products: 0,
  delivered: 0,
  cancelled: 0,
  onTheWay: 0,
  waitingPrice: 0,
  confirmed: { selling: 0, purchase: 0, delivery: 0, profit: 0 },
  pending: { selling: 0, purchase: 0, delivery: 0 },
  cancelledLoss: 0,
  deliveryEstimated: false,
});

const productIdOf = (item: LedgerItem, book: PriceBook) =>
  item.product_id ?? book.productIdByName.get(item.product_name) ?? '';

/** The order as a Modessi order, or null when none of its items is a Modessi product. */
export function toLedgerOrder(o: LedgerOrderInput, book: PriceBook): LedgerOrder | null {
  const modessiItems = o.order_items.filter((item) => book.modessiPrice.has(productIdOf(item, book)));
  if (modessiItems.length === 0) return null;
  const mixed = modessiItems.length < o.order_items.length;
  const link = one(o.modessi_order_links);
  // Split order sent to Modessi: its Modessi items travel in Modessi's own parcel, so that
  // parcel's outcome, cash and delivery charge apply, not those of Maxora's parcel.
  const split = splitParcel(o);

  const outcome = courierOutcome((split ? split.delivery_status : o.courier_status)?.toLowerCase() ?? null);
  const products = modessiItems.reduce((s, i) => s + Number(i.quantity), 0);
  const amount = split
    ? outcome === 'delivered' && split.courier_cod_amount != null
      ? Number(split.courier_cod_amount)
      : Number(split.cod_amount ?? modessiItems.reduce((s, i) => s + Number(i.price) * Number(i.quantity), 0))
    : mixed
      ? modessiItems.reduce((s, i) => s + Number(i.price) * Number(i.quantity), 0)
      : outcome === 'delivered' && o.courier_cod_amount != null
        ? Number(o.courier_cod_amount)
        : Number(o.total);

  // Modessi's own wholesale total for an order sent to Modessi (what it charges) wins; then the
  // cost the database recorded (frozen); otherwise current prices.
  const recorded = one(o.order_modessi_costs);
  const missingProducts: string[] = [];
  let cost: number | null =
    link && link.state === 'sent' && link.wholesale_total != null
      ? Number(link.wholesale_total)
      : recorded
        ? Number(recorded.cost)
        : null;
  if (cost == null) {
    let sum = 0;
    for (const item of modessiItems) {
      const price = book.modessiPrice.get(productIdOf(item, book));
      if (price == null) missingProducts.push(item.product_name);
      else sum += price * Number(item.quantity);
    }
    cost = missingProducts.length === 0 ? sum : null;
  }

  const charge = split ? split.courier_delivery_charge : o.courier_delivery_charge;
  const deliveryEstimated = charge == null;
  const delivery = Number(charge ?? o.shipping_cost ?? 0);

  const shipped = !!modessiSentAt(o);
  const notShipped = shipped ? null : link && link.state !== 'cancelled' ? 'modessi' : 'maxora';

  const state: OrderState =
    outcome === 'cancelled'
      ? 'cancelled'
      : outcome === 'delivered'
        ? cost == null
          ? 'waiting_price'
          : 'confirmed'
        : 'on_the_way';

  const profit =
    state === 'cancelled' ? -delivery : cost == null ? null : amount - cost - delivery;

  return {
    id: o.id,
    order_number: o.order_number,
    shipping_name: o.shipping_name,
    tracking_number: split ? split.tracking_number : o.tracking_number,
    tracking_url: split ? null : o.tracking_url ?? null,
    steadfast_consignment_id: split ? split.consignment_id : o.steadfast_consignment_id,
    courier_status: split ? split.delivery_status : o.courier_status,
    outcome,
    state,
    notShipped,
    products,
    amount,
    cost,
    missingProducts,
    mixed,
    delivery,
    deliveryEstimated,
    profit,
  };
}

function addOrder(t: LedgerTotals, o: LedgerOrder) {
  t.orderCount += 1;
  t.products += o.products;
  t.deliveryEstimated ||= o.deliveryEstimated;
  switch (o.state) {
    case 'confirmed':
      t.delivered += 1;
      t.confirmed.selling += o.amount;
      t.confirmed.purchase += o.cost ?? 0;
      t.confirmed.delivery += o.delivery;
      t.confirmed.profit += o.amount - (o.cost ?? 0) - o.delivery;
      break;
    case 'cancelled':
      t.cancelled += 1;
      t.cancelledLoss += o.delivery;
      t.confirmed.delivery += o.delivery;
      t.confirmed.profit -= o.delivery;
      break;
    case 'waiting_price':
      t.delivered += 1;
      t.waitingPrice += 1;
      t.pending.selling += o.amount;
      t.pending.delivery += o.delivery;
      break;
    case 'on_the_way':
      t.onTheWay += 1;
      t.pending.selling += o.amount;
      t.pending.purchase += o.cost ?? 0;
      t.pending.delivery += o.delivery;
      break;
  }
}

function addTotals(into: LedgerTotals, t: LedgerTotals) {
  into.orderCount += t.orderCount;
  into.products += t.products;
  into.delivered += t.delivered;
  into.cancelled += t.cancelled;
  into.onTheWay += t.onTheWay;
  into.waitingPrice += t.waitingPrice;
  into.cancelledLoss += t.cancelledLoss;
  into.deliveryEstimated ||= t.deliveryEstimated;
  for (const k of ['selling', 'purchase', 'delivery', 'profit'] as const) into.confirmed[k] += t.confirmed[k];
  for (const k of ['selling', 'purchase', 'delivery'] as const) into.pending[k] += t.pending[k];
}

export interface LedgerOptions {
  /** Turns an ISO timestamp into the local yyyy-MM-dd day it belongs to. */
  dayOf: (iso: string) => string;
  from?: string;
  to?: string;
}

/** Group Modessi orders into days (newest first) and total them. */
export function buildLedger(
  orders: LedgerOrderInput[],
  book: PriceBook,
  { dayOf, from, to }: LedgerOptions,
): { days: LedgerDay[]; totals: LedgerTotals } {
  const byDate = new Map<string, LedgerDay>();
  for (const raw of orders) {
    // Not shipped yet: shown on the day it was placed, unless it was cancelled before shipping.
    const shippedAt = modessiSentAt(raw);
    if (!shippedAt && raw.status === 'cancelled') continue;
    const sentAt = shippedAt ?? raw.created_at;
    if (!sentAt) continue;
    const date = dayOf(sentAt);
    if ((from && date < from) || (to && date > to)) continue;
    const order = toLedgerOrder(raw, book);
    if (!order) continue;
    let day = byDate.get(date);
    if (!day) {
      day = { ...emptyTotals(), date, orders: [], complete: false };
      byDate.set(date, day);
    }
    day.orders.push(order);
    addOrder(day, order);
  }

  const days = [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
  const totals = emptyTotals();
  for (const day of days) {
    day.complete = day.onTheWay === 0 && day.waitingPrice === 0;
    addTotals(totals, day);
  }
  return { days, totals };
}
