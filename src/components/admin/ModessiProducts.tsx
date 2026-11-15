import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { PackageCheck, Search, AlertTriangle, Check, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

// Admin → Modessi → Products tab: mark which products are bought from Modessi and keep their
// wholesale (paikari) unit price. Stored in the admin-only `modessi_products` table:
// a row means "marked", and `price` may be empty until it is filled in.
// The Orders tab only counts orders that contain marked products.

type Filter = 'all' | 'modessi' | 'other';

interface ProductRow {
  id: string;
  name: string;
  price: number;
  images: string[] | null;
  is_active: boolean | null;
  categories: { name: string } | null;
}

const PRODUCTS_KEY = ['modessi-admin-products'];
const MARKED_KEY = ['modessi-admin-marked'];

const formatTk = (value: number) => {
  const rounded = Math.round(value);
  const abs = Math.abs(rounded).toLocaleString('en-US');
  return rounded < 0 ? `-৳${abs}` : `৳${abs}`;
};

const missingTableHint = (err: unknown) => {
  const { code, message = '' } = (err ?? {}) as { code?: string; message?: string };
  return code === 'PGRST205' || code === '42P01' || message.includes('modessi_products')
    ? 'Run supabase/migrations/20261115140000_add_modessi_costs.sql in Supabase, then reload this page.'
    : null;
};

export default function ModessiProducts() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const productsQuery = useQuery({
    queryKey: PRODUCTS_KEY,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('products')
        .select('id, name, price, images, is_active, categories:category_id (name)')
        .order('name', { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as ProductRow[];
    },
  });

  const markedQuery = useQuery({
    queryKey: MARKED_KEY,
    queryFn: async () => {
      const { data, error } = await supabase.from('modessi_products').select('product_id, price');
      if (error) throw error;
      return new Map((data ?? []).map((r) => [r.product_id, r.price == null ? null : Number(r.price)]));
    },
    retry: 1,
  });

  const marked = useMemo(() => markedQuery.data ?? new Map<string, number | null>(), [markedQuery.data]);
  const products = useMemo(() => productsQuery.data ?? [], [productsQuery.data]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      if (q && !p.name.toLowerCase().includes(q)) return false;
      if (filter === 'modessi') return marked.has(p.id);
      if (filter === 'other') return !marked.has(p.id);
      return true;
    });
  }, [products, marked, search, filter]);

  const markedCount = marked.size;
  const missingPriceCount = [...marked.values()].filter((v) => v == null).length;

  const refreshMarked = () => {
    queryClient.invalidateQueries({ queryKey: MARKED_KEY });
    // The Orders tab reads the same data.
    queryClient.invalidateQueries({ queryKey: ['modessi-prices'] });
  };

  const markProducts = async (ids: string[]) => {
    const toMark = ids.filter((id) => !marked.has(id));
    if (toMark.length === 0) return;
    const { error } = await supabase
      .from('modessi_products')
      .upsert(toMark.map((product_id) => ({ product_id })), { onConflict: 'product_id', ignoreDuplicates: true });
    if (error) throw error;
    toast.success(`${toMark.length} product${toMark.length > 1 ? 's' : ''} marked as Modessi. Set the price next.`);
  };

  const unmarkProducts = async (ids: string[]) => {
    const toUnmark = ids.filter((id) => marked.has(id));
    if (toUnmark.length === 0) return false;
    const ok = confirm(
      `Remove ${toUnmark.length} product${toUnmark.length > 1 ? 's' : ''} from Modessi?\n\n` +
        'Their Modessi price is removed too, and their orders stop showing on the Orders tab. ' +
        'Costs already recorded for sent orders are kept.',
    );
    if (!ok) return false;
    const { error } = await supabase.from('modessi_products').delete().in('product_id', toUnmark);
    if (error) throw error;
    toast.success(`${toUnmark.length} product${toUnmark.length > 1 ? 's' : ''} removed from Modessi`);
    return true;
  };

  const handleToggle = async (id: string, on: boolean) => {
    try {
      if (on) await markProducts([id]);
      else await unmarkProducts([id]);
      refreshMarked();
    } catch (err) {
      console.error(err);
      toast.error('Could not update the product');
    }
  };

  const handleBulk = async (on: boolean) => {
    const ids = [...selected];
    setBulkBusy(true);
    try {
      const changed = on ? (await markProducts(ids), true) : await unmarkProducts(ids);
      if (changed) {
        setSelected(new Set());
        refreshMarked();
      }
    } catch (err) {
      console.error(err);
      toast.error('Could not update the selected products');
    } finally {
      setBulkBusy(false);
    }
  };

  const savePrice = async (id: string) => {
    const draft = drafts[id];
    if (draft === undefined) return;
    const trimmed = draft.trim();
    const value = trimmed === '' ? null : Number(trimmed);
    if (value !== null && !(Number.isFinite(value) && value >= 0)) {
      toast.error('Price must be a number of 0 or more');
      return;
    }
    if (value === marked.get(id)) {
      setDrafts(({ [id]: _, ...rest }) => rest);
      return;
    }
    setSavingIds((s) => new Set(s).add(id));
    const { error } = await supabase.from('modessi_products').update({ price: value }).eq('product_id', id);
    setSavingIds((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
    if (error) {
      console.error(error);
      toast.error('Price was not saved');
      return;
    }
    setDrafts(({ [id]: _, ...rest }) => rest);
    setSavedIds((s) => new Set(s).add(id));
    setTimeout(
      () =>
        setSavedIds((s) => {
          const next = new Set(s);
          next.delete(id);
          return next;
        }),
      1500,
    );
    refreshMarked();
  };

  const allVisibleSelected = visible.length > 0 && visible.every((p) => selected.has(p.id));
  const toggleAllVisible = (on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of visible) {
        if (on) next.add(p.id);
        else next.delete(p.id);
      }
      return next;
    });
  const toggleOne = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const error = productsQuery.error ?? markedQuery.error;
  const isLoading = productsQuery.isLoading || markedQuery.isLoading;
  const hint = error ? missingTableHint(error) : null;

  const filters: { key: Filter; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: products.length },
    { key: 'modessi', label: 'Modessi', count: markedCount },
    { key: 'other', label: 'Not Modessi', count: products.length - markedCount },
  ];

  return (
    <div className="space-y-6">
      {!isLoading && !error && missingPriceCount > 0 && (
        <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
          <p>
            <span className="font-medium">
              {missingPriceCount} Modessi product{missingPriceCount > 1 ? 's have' : ' has'} no price yet.
            </span>{' '}
            <span className="text-muted-foreground">Their orders are left out of the profit until a price is set.</span>
          </p>
        </div>
      )}

      <Card>
        <CardHeader className="space-y-4">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <PackageCheck className="h-5 w-5" />
              Modessi Products
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Mark the products you buy from Modessi and set their wholesale (paikari) price. Only orders with these
              products count on the Orders tab. A new price applies to orders sent from now on; orders already
              recorded keep their cost.
            </p>
          </div>
          <div className="flex flex-col lg:flex-row lg:items-center gap-3">
            <div className="relative lg:max-w-xs w-full">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search products…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
                aria-label="Search products"
              />
            </div>
            <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1 self-start" role="tablist" aria-label="Filter products">
              {filters.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  role="tab"
                  aria-selected={filter === f.key}
                  onClick={() => setFilter(f.key)}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                    filter === f.key ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {f.label} <span className="tabular-nums text-muted-foreground">({f.count})</span>
                </button>
              ))}
            </div>
            {selected.size > 0 && (
              <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
                <span className="text-sm text-muted-foreground">{selected.size} selected</span>
                <Button size="sm" onClick={() => handleBulk(true)} disabled={bulkBusy}>
                  Mark as Modessi
                </Button>
                <Button size="sm" variant="outline" onClick={() => handleBulk(false)} disabled={bulkBusy}>
                  Remove from Modessi
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} disabled={bulkBusy}>
                  Clear
                </Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {error ? (
            <div className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
              <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
              <div className="space-y-1">
                <p className="font-medium">{hint ? 'The Modessi tables are not in the database yet' : 'Failed to load products'}</p>
                <p className="text-muted-foreground">{hint ?? (error as { message?: string }).message}</p>
              </div>
            </div>
          ) : isLoading ? (
            <div className="space-y-3">
              {[...Array(6)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allVisibleSelected}
                      onCheckedChange={(v) => toggleAllVisible(v === true)}
                      aria-label="Select all shown products"
                    />
                  </TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Selling Price</TableHead>
                  <TableHead>Modessi</TableHead>
                  <TableHead>Modessi Price (৳ per unit)</TableHead>
                  <TableHead className="text-right">Margin / unit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((p) => {
                  const isMarked = marked.has(p.id);
                  const saved = marked.get(p.id) ?? null;
                  const draft = drafts[p.id];
                  const shown = draft ?? (saved == null ? '' : String(saved));
                  const effective = draft !== undefined ? (draft.trim() === '' ? null : Number(draft)) : saved;
                  const margin = effective != null && Number.isFinite(effective) ? Number(p.price) - effective : null;
                  return (
                    <TableRow key={p.id} data-state={selected.has(p.id) ? 'selected' : undefined}>
                      <TableCell>
                        <Checkbox
                          checked={selected.has(p.id)}
                          onCheckedChange={(v) => toggleOne(p.id, v === true)}
                          aria-label={`Select ${p.name}`}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          {p.images?.[0] ? (
                            <img src={p.images[0]} alt="" className="h-10 w-10 shrink-0 rounded object-cover" />
                          ) : (
                            <div className="h-10 w-10 shrink-0 rounded bg-muted" />
                          )}
                          <div className="min-w-0">
                            <div className="font-medium truncate">{p.name}</div>
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              {p.categories?.name && <span>{p.categories.name}</span>}
                              {p.is_active === false && <Badge variant="outline" className="h-5 px-1.5 text-[10px]">Hidden</Badge>}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatTk(Number(p.price))}</TableCell>
                      <TableCell>
                        <Switch
                          checked={isMarked}
                          onCheckedChange={(v) => handleToggle(p.id, v)}
                          aria-label={`${p.name} is from Modessi`}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Input
                            type="number"
                            inputMode="decimal"
                            min="0"
                            step="0.01"
                            className={cn(
                              'h-9 w-32 tabular-nums',
                              isMarked && saved == null && draft === undefined && 'border-amber-500/60',
                            )}
                            placeholder={isMarked ? 'Set price' : '—'}
                            disabled={!isMarked}
                            value={isMarked ? shown : ''}
                            onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                            onBlur={() => savePrice(p.id)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                              if (e.key === 'Escape') {
                                setDrafts(({ [p.id]: _, ...rest }) => rest);
                                (e.target as HTMLInputElement).blur();
                              }
                            }}
                            aria-label={`Modessi price for ${p.name}`}
                          />
                          {savingIds.has(p.id) && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                          {savedIds.has(p.id) && <Check className="h-4 w-4 text-green-600" aria-label="Saved" />}
                        </div>
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-right tabular-nums font-medium',
                          margin == null ? 'text-muted-foreground' : margin >= 0 ? 'text-green-600' : 'text-destructive',
                        )}
                      >
                        {isMarked && margin != null ? formatTk(margin) : '—'}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {visible.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                      {products.length === 0 ? 'No products yet' : 'No products match'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
