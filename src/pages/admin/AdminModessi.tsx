import { Fragment, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { format } from 'date-fns';
import { toast } from 'sonner';
import {
  Store,
  ShoppingBag,
  Truck,
  Wallet,
  TrendingUp,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  ChevronRight,
  RefreshCw,
  PackageCheck,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { buildLedger, type LedgerOrder, type LedgerOrderInput, type PriceBook } from '@/lib/modessiLedger';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import ModessiProducts from '@/components/admin/ModessiProducts';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

// How it works (nothing is typed in by hand):
// - Products bought from Modessi are marked, with their unit price, on the Products tab
//   (/admin/modessi?tab=products).
// - Only orders containing a marked product are shown. Each belongs to the day it was sent to
//   Steadfast (orders.steadfast_sent_at).
// - Purchase = Modessi price × quantity over the order's Modessi items, recorded once per order
//   by the database (order_modessi_costs) and never changed afterwards.
// - Delivery = Steadfast's charge for the parcel (from the webhook); until Steadfast reports it,
//   the order's own delivery fee is shown as an estimate (~).
// - The money rules live in src/lib/modessiLedger.ts. Counted ("confirmed") figures always
//   reconcile: Net Profit = Selling − Purchase − Delivery, where Delivery includes the charges
//   lost on cancelled parcels. Orders on the way or waiting for a price are shown as pending.

const ORDER_COLUMNS =
  'id, order_number, shipping_name, total, shipping_cost, steadfast_sent_at, courier_status, courier_cod_amount, courier_delivery_charge, tracking_number, order_items(quantity, price, product_id, product_name), order_modessi_costs(cost)';

const ORDERS_KEY = 'modessi-orders';
const PRICES_KEY = 'modessi-prices';

const parseDate = (d: string) => new Date(`${d}T00:00:00`);
const localDate = (iso: string) => format(new Date(iso), 'yyyy-MM-dd');

// Whole taka.
const formatTk = (value: number) => {
  const rounded = Math.round(value);
  const abs = Math.abs(rounded).toLocaleString('en-US');
  return rounded < 0 ? `-৳${abs}` : `৳${abs}`;
};

const profitClass = (value: number) =>
  value > 0 ? 'text-green-600' : value < 0 ? 'text-destructive' : 'text-muted-foreground';

// Columns of the per-order breakdown inside an expanded day.
const ORDER_GRID =
  'grid grid-cols-[20px_150px_minmax(120px,1fr)_50px_90px_100px_80px_90px_150px] items-center gap-x-3 px-10';

const schemaErrorHint = (err: unknown): string | null => {
  if (typeof err !== 'object' || err === null) return null;
  const { code, message = '' } = err as { code?: string; message?: string };
  if (code === 'PGRST205' || code === '42P01' || code === '42703' || code === 'PGRST200' || /modessi|steadfast_sent_at|courier_/.test(message)) {
    return 'Run supabase/migrations/20261115130000_add_steadfast_courier_tracking.sql and 20261115140000_add_modessi_costs.sql in Supabase, then reload this page.';
  }
  return null;
};

async function fetchSteadfastOrders(): Promise<LedgerOrderInput[]> {
  const pageSize = 1000;
  const all: LedgerOrderInput[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('orders')
      .select(ORDER_COLUMNS)
      .not('steadfast_sent_at', 'is', null)
      .order('steadfast_sent_at', { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    all.push(...((data ?? []) as unknown as LedgerOrderInput[]));
    if (!data || data.length < pageSize) break;
  }
  return all;
}

async function fetchPriceBook(): Promise<PriceBook> {
  const [marked, products] = await Promise.all([
    supabase.from('modessi_products').select('product_id, price'),
    supabase.from('products').select('id, name, created_at').order('created_at', { ascending: true }),
  ]);
  if (marked.error) throw marked.error;
  if (products.error) throw products.error;
  const productIdByName = new Map<string, string>();
  for (const p of products.data ?? []) if (!productIdByName.has(p.name)) productIdByName.set(p.name, p.id);
  return {
    modessiPrice: new Map((marked.data ?? []).map((p) => [p.product_id, p.price == null ? null : Number(p.price)])),
    productIdByName,
  };
}

function OutcomeIcon({ outcome, className }: { outcome: LedgerOrder['outcome']; className?: string }) {
  if (outcome === 'delivered') return <CheckCircle2 className={cn('h-4 w-4 text-green-600', className)} />;
  if (outcome === 'cancelled') return <XCircle className={cn('h-4 w-4 text-destructive', className)} />;
  return <Clock className={cn('h-4 w-4 text-amber-500', className)} />;
}

/** A counted amount with the not-yet-counted part underneath. */
function MoneyCell({ value, pending, className }: { value: number; pending: number; className?: string }) {
  return (
    <>
      <div className={className}>{formatTk(value)}</div>
      {pending > 0 && <div className="text-xs font-normal text-muted-foreground">+{formatTk(pending)} pending</div>}
    </>
  );
}

function OrderProfit({ o }: { o: LedgerOrder }) {
  if (o.state === 'cancelled') {
    return (
      <span className="font-semibold text-destructive" title="Cancelled: the delivery charge is lost">
        {formatTk(o.profit ?? 0)}
      </span>
    );
  }
  if (o.state === 'waiting_price' || o.profit == null) {
    return (
      <span className="text-muted-foreground" title="Counted once the Modessi price is set">
        —
      </span>
    );
  }
  if (o.state === 'on_the_way') {
    return (
      <span className="font-semibold text-muted-foreground" title="Counted once Steadfast confirms delivery">
        {formatTk(o.profit)}
      </span>
    );
  }
  return <span className={cn('font-semibold', profitClass(o.profit))}>{formatTk(o.profit)}</span>;
}

type ModessiTab = 'orders' | 'products';

export default function AdminModessi() {
  const queryClient = useQueryClient();
  // The tab lives in the URL so /admin/modessi?tab=products can be linked to directly.
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: ModessiTab = searchParams.get('tab') === 'products' ? 'products' : 'orders';
  const setTab = (next: ModessiTab) =>
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        if (next === 'products') params.set('tab', 'products');
        else params.delete('tab');
        return params;
      },
      { replace: true },
    );
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);

  const ordersQuery = useQuery({ queryKey: [ORDERS_KEY], queryFn: fetchSteadfastOrders, retry: 1 });
  const pricesQuery = useQuery({ queryKey: [PRICES_KEY], queryFn: fetchPriceBook, retry: 1 });

  const { days, totals } = useMemo(
    () =>
      buildLedger(
        ordersQuery.data ?? [],
        pricesQuery.data ?? { modessiPrice: new Map(), productIdByName: new Map() },
        { dayOf: localDate, from: fromDate || undefined, to: toDate || undefined },
      ),
    [ordersQuery.data, pricesQuery.data, fromDate, toDate],
  );

  const missingPriceProducts = useMemo(
    () => [...new Set(days.flatMap((d) => d.orders.flatMap((o) => o.missingProducts)))].sort(),
    [days],
  );

  // Marked products still without a price, shown on the Products tab.
  const unpricedCount = useMemo(
    () => [...(pricesQuery.data?.modessiPrice.values() ?? [])].filter((price) => price == null).length,
    [pricesQuery.data],
  );

  const toggleDay = (date: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });

  // Fallback for missed webhooks: re-check orders that are still on the way.
  const handleSync = async () => {
    const codes = [
      ...new Set(
        days.flatMap((d) =>
          d.orders.filter((o) => o.state === 'on_the_way' && o.tracking_number).map((o) => o.tracking_number!),
        ),
      ),
    ];
    if (codes.length === 0) {
      toast.info('No orders on the way to check');
      return;
    }
    setSyncing(true);
    try {
      let saved = 0;
      for (let i = 0; i < codes.length; i += 50) {
        const { data, error } = await supabase.functions.invoke('steadfast-status', {
          body: { tracking_codes: codes.slice(i, i + 50) },
        });
        if (error) throw error;
        saved += Number(data?.saved ?? 0);
      }
      await queryClient.invalidateQueries({ queryKey: [ORDERS_KEY] });
      toast.success(`Checked ${codes.length} order(s), ${saved} updated`);
    } catch (err) {
      console.error('Steadfast sync failed:', err);
      toast.error('Could not sync from Steadfast');
    } finally {
      setSyncing(false);
    }
  };

  const error = ordersQuery.error ?? pricesQuery.error;
  const isLoading = ordersQuery.isLoading || pricesQuery.isLoading;
  const ready = !isLoading && !error;
  const hasFilters = Boolean(fromDate || toDate);
  const hint = error ? schemaErrorHint(error) : null;
  const confirmedOrders = totals.delivered - totals.waitingPrice;

  // Read left to right: Selling − Purchase − Delivery = Net Profit.
  const summaryCards = [
    {
      op: '',
      label: 'Confirmed Selling',
      value: formatTk(totals.confirmed.selling),
      sub: `${confirmedOrders} delivered order${confirmedOrders === 1 ? '' : 's'}`,
      icon: Wallet,
    },
    {
      op: '−',
      label: 'Purchase (Modessi)',
      value: formatTk(totals.confirmed.purchase),
      sub: 'Modessi cost of those orders',
      icon: ShoppingBag,
    },
    {
      op: '−',
      label: 'Delivery',
      value: formatTk(totals.confirmed.delivery),
      sub:
        totals.cancelledLoss > 0
          ? `Incl. ${formatTk(totals.cancelledLoss)} lost on ${totals.cancelled} cancelled`
          : 'Steadfast charges',
      icon: Truck,
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-display font-bold">Modessi</h1>
        <p className="text-muted-foreground">
          Your Modessi products and their orders, Modessi cost and confirmed profit
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as ModessiTab)} className="space-y-6">
        <TabsList>
          <TabsTrigger value="orders" className="gap-2">
            <Store className="h-4 w-4" />
            Orders
          </TabsTrigger>
          <TabsTrigger value="products" className="gap-2">
            <PackageCheck className="h-4 w-4" />
            Products
            {unpricedCount > 0 && (
              <span
                className="rounded-full bg-amber-500/15 px-1.5 text-xs font-semibold tabular-nums text-amber-600"
                title={`${unpricedCount} Modessi product${unpricedCount > 1 ? 's' : ''} without a price`}
              >
                {unpricedCount}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="products" className="mt-0">
          <ModessiProducts />
        </TabsContent>

        <TabsContent value="orders" className="mt-0 space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {summaryCards.map((card) => (
              <Card key={card.label}>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">
                    {card.op && <span className="mr-1 text-muted-foreground">{card.op}</span>}
                    {card.label}
                  </CardTitle>
                  <card.icon className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold tabular-nums">{ready ? card.value : '—'}</div>
                  {ready && <p className="text-xs text-muted-foreground mt-1">{card.sub}</p>}
                </CardContent>
              </Card>
            ))}
            <Card className="border-primary/40">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">
                  <span className="mr-1 text-muted-foreground">=</span>
                  Net Profit
                </CardTitle>
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className={cn('text-2xl font-bold tabular-nums', ready && profitClass(totals.confirmed.profit))}>
                  {ready ? formatTk(totals.confirmed.profit) : '—'}
                </div>
                {ready && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Selling − Purchase − Delivery{hasFilters ? ' (filtered)' : ''}
                  </p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Unconfirmed</CardTitle>
                <Clock className="h-4 w-4 text-amber-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold tabular-nums">{ready ? formatTk(totals.pending.selling) : '—'}</div>
                {ready && (
                  <p className="text-xs text-muted-foreground mt-1">
                    {totals.onTheWay} on the way
                    {totals.waitingPrice > 0 ? ` · ${totals.waitingPrice} waiting for a price` : ''} · not counted yet
                  </p>
                )}
              </CardContent>
            </Card>
          </div>

          {ready && missingPriceProducts.length > 0 && (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
                <div>
                  <p className="font-medium">These Modessi products have no price yet</p>
                  <p className="text-muted-foreground">
                    {missingPriceProducts.join(', ')}. Their orders are left out of the profit until a price is set.
                  </p>
                </div>
              </div>
              <Button variant="outline" size="sm" className="self-start sm:self-center" onClick={() => setTab('products')}>
                Set prices
              </Button>
            </div>
          )}

          <Card>
            <CardHeader className="space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2">
                  <Store className="h-5 w-5" />
                  Daily Orders
                </CardTitle>
                <Button variant="outline" size="sm" className="gap-2 self-start" onClick={handleSync} disabled={!ready || syncing}>
                  <RefreshCw className={cn('h-4 w-4', syncing && 'animate-spin')} />
                  {syncing ? 'Syncing…' : 'Sync from Steadfast'}
                </Button>
              </div>
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="flex items-center gap-2">
                  <Label htmlFor="from" className="text-sm text-muted-foreground whitespace-nowrap">From</Label>
                  <Input id="from" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
                </div>
                <div className="flex items-center gap-2">
                  <Label htmlFor="to" className="text-sm text-muted-foreground whitespace-nowrap">To</Label>
                  <Input id="to" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
                </div>
                {hasFilters && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setFromDate('');
                      setToDate('');
                    }}
                  >
                    Clear
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {error ? (
                <div className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
                  <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
                  <div className="space-y-1">
                    <p className="font-medium">
                      {hint ? 'The database is missing the Modessi / Steadfast changes' : 'Failed to load Modessi data'}
                    </p>
                    <p className="text-muted-foreground">{hint ?? (error as { message?: string }).message}</p>
                  </div>
                </div>
              ) : isLoading ? (
                <div className="space-y-3">
                  {[...Array(5)].map((_, i) => (
                    <Skeleton key={i} className="h-12 w-full" />
                  ))}
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Orders</TableHead>
                      <TableHead className="text-right">Products</TableHead>
                      <TableHead className="text-right">Selling</TableHead>
                      <TableHead className="text-right">Purchase</TableHead>
                      <TableHead className="text-right">Delivery</TableHead>
                      <TableHead className="text-right">Net Profit</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {days.map((day) => {
                      const date = parseDate(day.date);
                      const isOpen = expanded.has(day.date);
                      const missingCost = day.orders.filter((o) => o.cost == null).length;
                      return (
                        <Fragment key={day.date}>
                          <TableRow className="cursor-pointer" onClick={() => toggleDay(day.date)} aria-expanded={isOpen}>
                            <TableCell className="whitespace-nowrap">
                              <div className="flex items-start gap-2">
                                <ChevronRight
                                  className={cn('h-4 w-4 mt-0.5 shrink-0 transition-transform', isOpen && 'rotate-90')}
                                />
                                <div>
                                  <div className="font-medium">{format(date, 'dd MMM yyyy')}</div>
                                  <div className="text-xs text-muted-foreground">{format(date, 'EEEE')}</div>
                                </div>
                              </div>
                            </TableCell>
                            <TableCell className="whitespace-nowrap">
                              <div className="flex items-center gap-2.5 text-sm tabular-nums">
                                <span className="flex items-center gap-1" title="Delivered">
                                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                                  {day.delivered}
                                </span>
                                {day.cancelled > 0 && (
                                  <span className="flex items-center gap-1" title="Cancelled">
                                    <XCircle className="h-4 w-4 text-destructive" />
                                    {day.cancelled}
                                  </span>
                                )}
                                {day.onTheWay > 0 && (
                                  <span className="flex items-center gap-1" title="On the way">
                                    <Clock className="h-4 w-4 text-amber-500" />
                                    {day.onTheWay}
                                  </span>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{day.products}</TableCell>
                            <TableCell className="text-right tabular-nums">
                              <MoneyCell value={day.confirmed.selling} pending={day.pending.selling} />
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              <MoneyCell value={day.confirmed.purchase} pending={day.pending.purchase} />
                              {missingCost > 0 && <div className="text-xs text-amber-700">{missingCost} price missing</div>}
                            </TableCell>
                            <TableCell
                              className="text-right tabular-nums"
                              title={day.deliveryEstimated ? 'Includes estimates until Steadfast reports the real charge' : undefined}
                            >
                              <MoneyCell value={day.confirmed.delivery} pending={day.pending.delivery} />
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              <div className={cn('font-semibold', profitClass(day.confirmed.profit))}>
                                {formatTk(day.confirmed.profit)}
                              </div>
                              {!day.complete && <div className="text-xs text-muted-foreground">so far</div>}
                            </TableCell>
                            <TableCell className="whitespace-nowrap">
                              {day.onTheWay > 0 ? (
                                <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700">
                                  <Clock className="h-3.5 w-3.5" />
                                  {day.delivered}/{day.orderCount} delivered
                                </span>
                              ) : day.waitingPrice > 0 ? (
                                <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700">
                                  <AlertTriangle className="h-3.5 w-3.5" />
                                  Price missing
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 rounded-full bg-green-600/10 px-2 py-0.5 text-xs font-medium text-green-700">
                                  <CheckCircle2 className="h-3.5 w-3.5" />
                                  Confirmed
                                </span>
                              )}
                            </TableCell>
                          </TableRow>
                          {isOpen && (
                            <TableRow className="hover:bg-transparent">
                              <TableCell colSpan={8} className="bg-muted/30 p-0">
                                <div className="min-w-[920px]">
                                  <div className={cn(ORDER_GRID, 'py-2 text-xs font-medium text-muted-foreground border-b')}>
                                    <span />
                                    <span>Order</span>
                                    <span>Customer</span>
                                    <span className="text-right">Items</span>
                                    <span className="text-right">Selling</span>
                                    <span className="text-right">Purchase</span>
                                    <span className="text-right">Delivery</span>
                                    <span className="text-right">Profit</span>
                                    <span>Steadfast</span>
                                  </div>
                                  <ul className="divide-y">
                                    {day.orders.map((o) => (
                                      <li key={o.id} className={cn(ORDER_GRID, 'py-2 text-sm tabular-nums')}>
                                        <OutcomeIcon outcome={o.outcome} />
                                        <span className="font-medium">
                                          {o.order_number}
                                          {o.mixed && (
                                            <span
                                              className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[10px] font-normal text-muted-foreground"
                                              title="Also has products that are not from Modessi; only the Modessi items are counted"
                                            >
                                              mixed
                                            </span>
                                          )}
                                        </span>
                                        <span className="truncate text-muted-foreground">{o.shipping_name}</span>
                                        <span className="text-right text-muted-foreground">{o.products}</span>
                                        <span
                                          className={cn(
                                            'text-right',
                                            o.state === 'cancelled' && 'line-through text-muted-foreground',
                                          )}
                                          title={o.state === 'cancelled' ? 'Not counted: the order was cancelled' : undefined}
                                        >
                                          {formatTk(o.amount)}
                                        </span>
                                        <span className="text-right">
                                          {o.cost == null ? (
                                            <span
                                              className="text-xs text-amber-700"
                                              title={`No Modessi price: ${o.missingProducts.join(', ')}`}
                                            >
                                              price missing
                                            </span>
                                          ) : (
                                            <span
                                              className={cn(o.state === 'cancelled' && 'line-through text-muted-foreground')}
                                              title={o.state === 'cancelled' ? 'Not counted: the product comes back' : undefined}
                                            >
                                              {formatTk(o.cost)}
                                            </span>
                                          )}
                                        </span>
                                        <span
                                          className={cn('text-right', o.deliveryEstimated && 'text-muted-foreground')}
                                          title={
                                            o.deliveryEstimated
                                              ? "Estimate from the order's delivery fee until Steadfast reports the real charge"
                                              : 'Charged by Steadfast'
                                          }
                                        >
                                          {o.deliveryEstimated ? '~' : ''}
                                          {formatTk(o.delivery)}
                                        </span>
                                        <span className="text-right">
                                          <OrderProfit o={o} />
                                        </span>
                                        <span
                                          className={cn(
                                            'text-xs',
                                            o.outcome === 'delivered' && 'text-green-700',
                                            o.outcome === 'cancelled' && 'text-destructive',
                                            o.outcome === 'pending' && 'text-amber-700',
                                          )}
                                        >
                                          {o.courier_status ? o.courier_status.replace(/_/g, ' ') : 'waiting for Steadfast'}
                                        </span>
                                      </li>
                                    ))}
                                  </ul>
                                  <p className="px-10 py-2 text-xs text-muted-foreground border-t">
                                    Purchase = Modessi price × quantity, fixed when the order is sent. Delivery = Steadfast's
                                    charge (~ is an estimate until Steadfast reports it). Net profit = ✓ orders' profit minus
                                    the delivery charge of ✗ cancelled ones; ⏳ orders count once delivered.
                                  </p>
                                </div>
                              </TableCell>
                            </TableRow>
                          )}
                        </Fragment>
                      );
                    })}
                    {days.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                          {hasFilters ? (
                            'No Modessi orders were sent to Steadfast in this date range'
                          ) : (
                            <>
                              No Modessi orders yet. Mark your Modessi products on the{' '}
                              <button
                                type="button"
                                onClick={() => setTab('products')}
                                className="text-primary underline underline-offset-2"
                              >
                                Products
                              </button>{' '}
                              tab; their orders show up here once sent to Steadfast.
                            </>
                          )}
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                  {days.length > 0 && (
                    <TableFooter>
                      <TableRow>
                        <TableCell className="font-semibold">Total</TableCell>
                        <TableCell className="whitespace-nowrap text-sm tabular-nums">
                          <span className="inline-flex items-center gap-1 mr-2.5">
                            <CheckCircle2 className="h-4 w-4 text-green-600" />
                            {totals.delivered}
                          </span>
                          <span className="inline-flex items-center gap-1 mr-2.5">
                            <XCircle className="h-4 w-4 text-destructive" />
                            {totals.cancelled}
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <Clock className="h-4 w-4 text-amber-500" />
                            {totals.onTheWay}
                          </span>
                        </TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">{totals.products.toLocaleString('en-US')}</TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">{formatTk(totals.confirmed.selling)}</TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">{formatTk(totals.confirmed.purchase)}</TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">{formatTk(totals.confirmed.delivery)}</TableCell>
                        <TableCell className={cn('text-right font-bold tabular-nums', profitClass(totals.confirmed.profit))}>
                          {formatTk(totals.confirmed.profit)}
                        </TableCell>
                        <TableCell />
                      </TableRow>
                    </TableFooter>
                  )}
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
