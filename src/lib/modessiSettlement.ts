// What Modessi owes Maxora. Modessi ships the Maxora orders sent to it and collects their COD,
// so Maxora's money sits with Modessi until Modessi pays it over. Per Modessi parcel:
//
//   delivered           collected − wholesale − delivery charge
//   partly delivered    same, flagged for checking (some items came back, wholesale may be less)
//   returned/cancelled  − delivery charge (the goods go back to Modessi, so no wholesale)
//   on the way          not counted yet ("pending")
//
// Balance = Σ counted − Σ payments Modessi made. Positive = Modessi owes Maxora.
// Kept free of React and Supabase. Modessi's admin page uses the same rules
// (Modessi repo: src/lib/partnerSettlement.ts).
import { courierOutcome } from '../../supabase/functions/_shared/steadfastStatus.ts';

export interface SettlementParcel {
  state: string;
  cod_amount: number | null;
  wholesale_total: number | null;
  delivery_status: string | null;
  courier_cod_amount: number | null;
  courier_delivery_charge: number | null;
}

export interface ParcelSettlement {
  status: 'delivered' | 'returned' | 'pending' | 'not_shipped';
  /** Counted toward the balance; null while pending or when a figure is missing. */
  owed: number | null;
  /** Expected owed for a parcel still on the way (not counted). */
  expected: number | null;
  /** The delivery charge is the estimate, not Steadfast's figure. */
  estimated: boolean;
  /** Partly delivered, or wholesale unknown: check by hand. */
  review: boolean;
}

/** Delivery charge to assume until Steadfast reports the real one. */
export const DEFAULT_DELIVERY_CHARGE = 130;

export function settleParcel(p: SettlementParcel): ParcelSettlement {
  if (p.state !== 'sent') return { status: 'not_shipped', owed: null, expected: null, estimated: false, review: false };

  const status = p.delivery_status?.toLowerCase() ?? null;
  const outcome = courierOutcome(status);
  const estimated = p.courier_delivery_charge == null;
  const charge = Number(p.courier_delivery_charge ?? DEFAULT_DELIVERY_CHARGE);
  const wholesale = p.wholesale_total == null ? null : Number(p.wholesale_total);

  if (outcome === 'cancelled') {
    return { status: 'returned', owed: -charge, expected: null, estimated, review: false };
  }
  if (outcome === 'delivered') {
    const collected = Number(p.courier_cod_amount ?? p.cod_amount ?? 0);
    const partial = !!status?.startsWith('partial_delivered');
    return {
      status: 'delivered',
      owed: wholesale == null ? null : collected - wholesale - charge,
      expected: null,
      estimated,
      review: partial || wholesale == null,
    };
  }
  return {
    status: 'pending',
    owed: null,
    expected: wholesale == null ? null : Number(p.cod_amount ?? 0) - wholesale - charge,
    estimated: true,
    review: false,
  };
}

export interface SettlementTotals {
  /** Σ owed over finished parcels. */
  earned: number;
  /** Σ payments from Modessi. */
  paid: number;
  /** earned − paid; positive = Modessi owes Maxora. */
  balance: number;
  /** Expected from parcels still on the way (not in the balance). */
  pending: number;
  delivered: number;
  returned: number;
  onTheWay: number;
  /** Finished parcels that need a look (missing wholesale, partly delivered). */
  review: number;
  /** Some counted figure uses the estimated delivery charge. */
  estimated: boolean;
}

export function settlementTotals(parcels: SettlementParcel[], payments: { amount: number }[]): SettlementTotals {
  const t: SettlementTotals = {
    earned: 0,
    paid: payments.reduce((s, p) => s + Number(p.amount), 0),
    balance: 0,
    pending: 0,
    delivered: 0,
    returned: 0,
    onTheWay: 0,
    review: 0,
    estimated: false,
  };
  for (const p of parcels) {
    const s = settleParcel(p);
    if (s.status === 'delivered') t.delivered++;
    if (s.status === 'returned') t.returned++;
    if (s.status === 'pending') {
      t.onTheWay++;
      t.pending += s.expected ?? 0;
    }
    if (s.owed != null) {
      t.earned += s.owed;
      t.estimated ||= s.estimated;
    }
    if (s.review) t.review++;
  }
  t.balance = t.earned - t.paid;
  return t;
}
