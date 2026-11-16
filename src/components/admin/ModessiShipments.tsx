import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { AlertTriangle, Loader2, RefreshCw, Send, Truck } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

// Admin → Modessi → Sent to Modessi: every Maxora order whose Modessi items were sent to
// modessi.shop to pack and ship (modessi_order_links), with the status Modessi last reported.
// Statuses refresh every 15 minutes by cron, or now with "Refresh from Modessi".

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
  last_error: string | null;
  attempts: number;
  sent_at: string | null;
  created_at: string;
  orders: { order_number: string; shipping_name: string; total: number; status: string } | null;
}

const KEY = ['modessi-shipments'];

const formatTk = (value: number | null) => (value == null ? '—' : `৳${Math.round(value).toLocaleString('en-US')}`);

async function invokeSync<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('modessi-sync', { body });
  if (error) {
    let message = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx && typeof ctx.json === 'function') message = (await ctx.json())?.error ?? message;
    } catch {
      /* keep the generic message */
    }
    throw new Error(message);
  }
  return data as T;
}

const stateBadge = (row: LinkRow) => {
  if (row.state === 'failed') return <Badge variant="destructive">Not sent</Badge>;
  if (row.state === 'pending') return <Badge variant="outline">Sending…</Badge>;
  if (row.state === 'cancelled') return <Badge variant="outline">Cancelled</Badge>;
  return <Badge className="bg-green-600 hover:bg-green-600">Sent</Badge>;
};

export default function ModessiShipments() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  const query = useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('modessi_order_links' as never)
        .select(
          'order_id, full_order, state, modessi_order_number, cod_amount, wholesale_total, modessi_status, tracking_number, delivery_status, last_error, attempts, sent_at, created_at, orders(order_number, shipping_name, total, status)',
        )
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as LinkRow[];
    },
    retry: 1,
  });

  const rows = query.data ?? [];
  const failed = rows.filter((r) => r.state === 'failed').length;

  const refresh = async () => {
    setBusy('refresh');
    try {
      const r = await invokeSync<{ checked: number; updated: number; cancelled: number }>({ action: 'sync_statuses' });
      toast.success(`Checked ${r.checked} order${r.checked === 1 ? '' : 's'} on Modessi${r.cancelled ? `, cancelled ${r.cancelled}` : ''}`);
      queryClient.invalidateQueries({ queryKey: KEY });
    } catch (err) {
      toast.error((err as Error).message || 'Refresh failed');
    } finally {
      setBusy(null);
    }
  };

  const resend = async (orderId: string) => {
    setBusy(orderId);
    try {
      const r = await invokeSync<{ status: string; error?: string; reason?: string; modessiOrderNumber?: string }>({ action: 'forward', orderId });
      if (r.status === 'sent') toast.success(`Sent to Modessi${r.modessiOrderNumber ? ` as #${r.modessiOrderNumber}` : ''}`);
      else if (r.status === 'failed') toast.error(r.error ?? 'Not sent');
      else toast.info(r.reason ?? 'Nothing to send');
      queryClient.invalidateQueries({ queryKey: KEY });
    } catch (err) {
      toast.error((err as Error).message || 'Resend failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            <Truck className="h-5 w-5" />
            Sent to Modessi
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Orders with Modessi products go to Modessi as soon as they are placed. Modessi packs, ships and collects the
            COD shown here. Split orders: Modessi ships only its items and you ship the rest, with a smaller COD.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={refresh} disabled={busy !== null} className="self-start">
          {busy === 'refresh' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh from Modessi
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {failed > 0 && (
          <div className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
            <p>
              {failed} order{failed > 1 ? 's' : ''} did not reach Modessi. They are retried automatically; fix the reason
              shown (often a product not linked on the Products tab) and press Resend.
            </p>
          </div>
        )}
        {query.error ? (
          <p className="text-sm text-destructive">
            {(query.error as Error).message}. Run supabase/migrations/20261116120000_modessi_sync.sql if you have not yet.
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
                  <TableHead>Modessi status</TableHead>
                  <TableHead>Courier</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.order_id}>
                    <TableCell>
                      <div className="font-medium">#{r.orders?.order_number ?? '—'}</div>
                      <div className="text-xs text-muted-foreground">{r.full_order ? 'Whole order' : 'Split order'}</div>
                    </TableCell>
                    <TableCell>{r.orders?.shipping_name ?? '—'}</TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        {stateBadge(r)}
                        <div className="text-xs text-muted-foreground">
                          {format(new Date(r.sent_at ?? r.created_at), 'dd MMM, HH:mm')}
                        </div>
                        {r.state === 'failed' && r.last_error && (
                          <div className="max-w-56 text-xs text-destructive">{r.last_error}</div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="tabular-nums">{r.modessi_order_number ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatTk(r.cod_amount)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatTk(r.wholesale_total)}</TableCell>
                    <TableCell className="capitalize">{r.modessi_status ?? '—'}</TableCell>
                    <TableCell>
                      <div className="text-sm capitalize">{r.delivery_status?.replace(/_/g, ' ') ?? '—'}</div>
                      {r.tracking_number && <div className="text-xs text-muted-foreground">{r.tracking_number}</div>}
                    </TableCell>
                    <TableCell className="text-right">
                      {r.state !== 'sent' && r.state !== 'cancelled' && (
                        <Button size="sm" variant="outline" onClick={() => resend(r.order_id)} disabled={busy !== null}>
                          {busy === r.order_id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                          Resend
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
