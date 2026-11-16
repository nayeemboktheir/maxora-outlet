import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { AlertTriangle, Loader2, Plus, RefreshCw, Send, Trash2, Truck, Wallet } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { invokeModessiSync } from '@/lib/modessiSync';
import { settleParcel, settlementTotals } from '@/lib/modessiSettlement';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

// Admin → Modessi → Sent to Modessi: every Maxora order whose Modessi items were sent to
// modessi.shop to pack and ship (modessi_order_links), the status Modessi last reported, and
// the running balance: what Modessi owes Maxora for delivered parcels minus what it has paid.
// Statuses, courier money and payments refresh every 15 minutes by cron, or now with "Refresh".

interface LinkRow {
  order_id: string;
  full_order: boolean;
  state: 'pending' | 'sent' | 'failed' | 'cancelled';
  modessi_order_number: string | null;
  cod_amount: number | null;
  wholesale_total: number | null;
  modessi_status: string | null;
  tracking_number: string | null;
  delivery_status: string | null;
  courier_cod_amount: number | null;
  courier_delivery_charge: number | null;
  last_error: string | null;
  update_error: string | null;
  needs_update: boolean;
  sent_at: string | null;
  created_at: string;
  orders: { order_number: string; shipping_name: string; total: number; status: string } | null;
}

interface Payment {
  id: string;
  amount: number;
  paid_at: string;
  note: string | null;
  recorded_by: string;
}

const KEY = ['modessi-shipments'];
const PAYMENTS_KEY = ['modessi-payments'];

const formatTk = (value: number | null | undefined) => {
  if (value == null) return '—';
  const rounded = Math.round(value);
  const abs = Math.abs(rounded).toLocaleString('en-US');
  return rounded < 0 ? `-৳${abs}` : `৳${abs}`;
};

const stateBadge = (row: LinkRow) => {
  if (row.state === 'failed') return <Badge variant="destructive">Not sent</Badge>;
  if (row.state === 'pending') return <Badge variant="outline">Sending…</Badge>;
  if (row.state === 'cancelled') return <Badge variant="outline">Cancelled</Badge>;
  if (row.needs_update) return <Badge variant="outline" className="border-amber-500/60 text-amber-700">Updating…</Badge>;
  return <Badge className="bg-green-600 hover:bg-green-600">Sent</Badge>;
};

export default function ModessiShipments() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [paidAt, setPaidAt] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  const [note, setNote] = useState('');

  const query = useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('modessi_order_links' as never)
        .select(
          'order_id, full_order, state, modessi_order_number, cod_amount, wholesale_total, modessi_status, tracking_number, delivery_status, courier_cod_amount, courier_delivery_charge, last_error, update_error, needs_update, sent_at, created_at, orders(order_number, shipping_name, total, status)',
        )
        .order('created_at', { ascending: false })
        .limit(1000);
      if (error) throw error;
      return (data ?? []) as unknown as LinkRow[];
    },
    retry: 1,
  });

  const paymentsQuery = useQuery({
    queryKey: PAYMENTS_KEY,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('modessi_payments' as never)
        .select('id, amount, paid_at, note, recorded_by')
        .order('paid_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Payment[];
    },
    retry: 1,
  });

  const rows = useMemo(() => query.data ?? [], [query.data]);
  const payments = useMemo(() => paymentsQuery.data ?? [], [paymentsQuery.data]);
  const totals = useMemo(() => settlementTotals(rows, payments), [rows, payments]);
  const failed = rows.filter((r) => r.state === 'failed').length;
  const conflicts = rows.filter((r) => r.state === 'sent' && r.update_error).length;

  const reload = () => {
    queryClient.invalidateQueries({ queryKey: KEY });
    queryClient.invalidateQueries({ queryKey: PAYMENTS_KEY });
    queryClient.invalidateQueries({ queryKey: ['modessi-orders'] });
  };

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
      reload();
    } catch (err) {
      toast.error((err as Error).message || 'Modessi request failed');
    } finally {
      setBusy(null);
    }
  };

  const refresh = () =>
    run('refresh', async () => {
      const r = await invokeModessiSync<{ pushed: unknown; statuses: { checked?: number; error?: string }; payments: { error?: string } }>({
        action: 'all',
      });
      if (r.statuses?.error) throw new Error(r.statuses.error);
      toast.success(`Checked ${r.statuses?.checked ?? 0} parcel${r.statuses?.checked === 1 ? '' : 's'} on Modessi`);
    });

  const resend = (orderId: string) =>
    run(orderId, async () => {
      const r = await invokeModessiSync<{ status: string; error?: string; reason?: string; modessiOrderNumber?: string }>({
        action: 'forward',
        orderId,
      });
      if (r.status === 'sent') toast.success(`Sent to Modessi${r.modessiOrderNumber ? ` as #${r.modessiOrderNumber}` : ''}`);
      else if (r.status === 'updated') toast.success('Modessi has the latest version');
      else if (r.status === 'cancelled') toast.success('Cancelled on Modessi');
      else if (r.status === 'failed') toast.error(r.error ?? 'Not sent');
      else toast.info(r.reason ?? 'Nothing to send');
    });

  const addPayment = () =>
    run('payment', async () => {
      const value = Number(amount);
      if (!Number.isFinite(value) || value === 0) throw new Error('Enter the amount Modessi paid');
      await invokeModessiSync({ action: 'record_payment', amount: value, paidAt, note: note.trim() || null });
      toast.success(`Payment of ${formatTk(value)} recorded on both sites`);
      setAmount('');
      setNote('');
    });

  const removePayment = (p: Payment) => {
    if (!confirm(`Delete the ${formatTk(p.amount)} payment of ${p.paid_at}? It is removed on Modessi too.`)) return;
    return run(`del-${p.id}`, async () => {
      await invokeModessiSync({ action: 'delete_payment', paymentId: p.id });
      toast.success('Payment deleted');
    });
  };

  const balanceTone = totals.balance > 0 ? 'text-green-600' : totals.balance < 0 ? 'text-destructive' : '';

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <Wallet className="h-5 w-5" />
            Balance with Modessi
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Modessi collects the cash for the parcels it ships. Per delivered parcel it owes you what it collected minus
            wholesale and delivery; a returned parcel costs you its delivery charge.
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          {query.isLoading || paymentsQuery.isLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg border p-4">
                <div className="text-sm text-muted-foreground">{totals.balance >= 0 ? 'Modessi owes you' : 'You owe Modessi'}</div>
                <div className={cn('text-2xl font-semibold tabular-nums', balanceTone)}>{formatTk(Math.abs(totals.balance))}</div>
              </div>
              <div className="rounded-lg border p-4">
                <div className="text-sm text-muted-foreground">Earned on finished parcels</div>
                <div className="text-2xl font-semibold tabular-nums">
                  {totals.estimated && '~'}
                  {formatTk(totals.earned)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {totals.delivered} delivered, {totals.returned} returned
                </div>
              </div>
              <div className="rounded-lg border p-4">
                <div className="text-sm text-muted-foreground">Paid by Modessi</div>
                <div className="text-2xl font-semibold tabular-nums">{formatTk(totals.paid)}</div>
                <div className="text-xs text-muted-foreground">{payments.length} payment{payments.length === 1 ? '' : 's'}</div>
              </div>
              <div className="rounded-lg border p-4">
                <div className="text-sm text-muted-foreground">Still on the way</div>
                <div className="text-2xl font-semibold tabular-nums text-muted-foreground">~{formatTk(totals.pending)}</div>
                <div className="text-xs text-muted-foreground">{totals.onTheWay} parcels, not counted yet</div>
              </div>
            </div>
          )}
          {(totals.estimated || totals.review > 0) && (
            <p className="text-xs text-muted-foreground">
              {totals.estimated && '~ Some parcels use an estimated ৳130 delivery charge until Steadfast reports the real one. '}
              {totals.review > 0 &&
                `${totals.review} parcel${totals.review === 1 ? ' needs' : 's need'} a check (partly delivered or no wholesale price).`}
            </p>
          )}

          <div className="space-y-3">
            <div className="text-sm font-medium">Payments from Modessi</div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="space-y-1.5">
                <Label htmlFor="modessi-pay-amount">Amount (৳)</Label>
                <Input
                  id="modessi-pay-amount"
                  type="number"
                  inputMode="decimal"
                  className="w-full sm:w-36"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="5000"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="modessi-pay-date">Date</Label>
                <Input id="modessi-pay-date" type="date" className="w-full sm:w-40" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
              </div>
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="modessi-pay-note">Note</Label>
                <Input id="modessi-pay-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="bKash, bank transfer…" />
              </div>
              <Button onClick={addPayment} disabled={busy !== null || !amount}>
                {busy === 'payment' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Record payment
              </Button>
            </div>
            {payments.length > 0 && (
              <div className="divide-y rounded-md border text-sm">
                {payments.map((p) => (
                  <div key={p.id} className="flex items-center gap-3 px-3 py-2">
                    <span className="w-24 tabular-nums text-muted-foreground">{p.paid_at}</span>
                    <span className="w-24 font-medium tabular-nums">{formatTk(p.amount)}</span>
                    <span className="flex-1 truncate text-muted-foreground">{p.note}</span>
                    <span className="text-xs text-muted-foreground">{p.recorded_by === 'modessi' ? 'by Modessi' : 'by you'}</span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      onClick={() => removePayment(p)}
                      disabled={busy !== null}
                      aria-label="Delete payment"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <Truck className="h-5 w-5" />
              Sent to Modessi
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Orders with Modessi products go to Modessi as soon as they are placed, and edits or cancellations follow
              until Modessi hands the parcel to the courier. Split orders: Modessi ships only its items and you ship the
              rest, with a smaller COD.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={refresh} disabled={busy !== null} className="self-start">
            {busy === 'refresh' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh from Modessi
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {(failed > 0 || conflicts > 0) && (
            <div className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
              <p>
                {failed > 0 &&
                  `${failed} order${failed > 1 ? 's' : ''} did not reach Modessi. They are retried automatically; fix the reason shown (often a product not linked on the Products tab) and press Resend. `}
                {conflicts > 0 &&
                  `${conflicts} order${conflicts > 1 ? 's were' : ' was'} changed or cancelled after Modessi gave the parcel to the courier: tell Modessi directly.`}
              </p>
            </div>
          )}
          {query.error ? (
            <p className="text-sm text-destructive">
              {(query.error as Error).message}. Run supabase/migrations/20261116120000_modessi_sync.sql and
              20261116130000_modessi_settlement.sql if you have not yet.
            </p>
          ) : query.isLoading ? (
            <div className="space-y-3">
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No orders sent to Modessi yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Sent</TableHead>
                    <TableHead>Modessi #</TableHead>
                    <TableHead className="text-right">Modessi collects</TableHead>
                    <TableHead className="text-right">Wholesale</TableHead>
                    <TableHead className="text-right">Delivery</TableHead>
                    <TableHead>Courier</TableHead>
                    <TableHead className="text-right">Owed to you</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => {
                    const s = settleParcel(r);
                    const error = r.state === 'failed' ? r.last_error : r.update_error;
                    return (
                      <TableRow key={r.order_id}>
                        <TableCell>
                          <div className="font-medium">#{r.orders?.order_number ?? '—'}</div>
                          <div className="text-xs text-muted-foreground">{r.full_order ? 'Whole order' : 'Split order'}</div>
                        </TableCell>
                        <TableCell>{r.orders?.shipping_name ?? '—'}</TableCell>
                        <TableCell>
                          <div className="space-y-1">
                            {stateBadge(r)}
                            <div className="text-xs text-muted-foreground">{format(new Date(r.sent_at ?? r.created_at), 'dd MMM, HH:mm')}</div>
                            {error && <div className="max-w-60 text-xs text-destructive">{error}</div>}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="tabular-nums">{r.modessi_order_number ?? '—'}</div>
                          {r.modessi_status && <div className="text-xs capitalize text-muted-foreground">{r.modessi_status}</div>}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatTk(r.courier_cod_amount ?? r.cod_amount)}
                          {r.courier_cod_amount != null && <div className="text-xs text-muted-foreground">collected</div>}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatTk(r.wholesale_total)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {r.courier_delivery_charge != null ? formatTk(r.courier_delivery_charge) : <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell>
                          <div className="text-sm capitalize">{r.delivery_status?.replace(/_/g, ' ') ?? '—'}</div>
                          {r.tracking_number && <div className="text-xs text-muted-foreground">{r.tracking_number}</div>}
                        </TableCell>
                        <TableCell
                          className={cn(
                            'text-right tabular-nums font-medium',
                            s.owed == null ? 'text-muted-foreground' : s.owed >= 0 ? 'text-green-600' : 'text-destructive',
                          )}
                        >
                          {s.owed != null ? `${s.estimated ? '~' : ''}${formatTk(s.owed)}` : s.expected != null ? `(~${formatTk(s.expected)})` : '—'}
                          {s.review && <div className="text-xs font-normal text-amber-600">check</div>}
                        </TableCell>
                        <TableCell className="text-right">
                          {(r.state === 'failed' || r.state === 'pending' || (r.state === 'sent' && (r.needs_update || r.update_error))) && (
                            <Button size="sm" variant="outline" onClick={() => resend(r.order_id)} disabled={busy !== null}>
                              {busy === r.order_id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                              Resend
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
