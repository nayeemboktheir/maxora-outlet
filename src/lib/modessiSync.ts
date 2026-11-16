import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

/** Call the modessi-sync edge function, surfacing its error message on a non-2xx answer. */
export async function invokeModessiSync<T>(body: Record<string, unknown>): Promise<T> {
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

type PushResult = { orderId: string; status: string; error?: string; reason?: string };

/**
 * The admin's "Send to Modessi" button: send these orders' Modessi items to Modessi now (or push
 * changes for ones already sent). Reports what happened to each and returns how many reached it.
 */
export async function sendToModessi(orderIds: string[]): Promise<number> {
  if (orderIds.length === 0) return 0;
  let results: PushResult[];
  try {
    ({ results } = await invokeModessiSync<{ results: PushResult[] }>({ action: 'push_updates', orderIds }));
  } catch (err) {
    toast.error(`Modessi: ${(err as Error).message}`);
    return 0;
  }
  const count = (s: string) => results.filter((r) => r.status === s).length;
  const plural = (n: number) => `${n} order${n === 1 ? '' : 's'}`;
  const sent = count('sent');
  const updated = count('updated');
  if (sent > 0) toast.success(`${plural(sent)} sent to Modessi`);
  if (updated > 0) toast.success(`${plural(updated)} already at Modessi, brought up to date`);

  const skipped = results.filter((r) => r.status === 'skipped');
  const reasons = new Map<string, number>();
  for (const r of skipped) reasons.set(r.reason ?? 'skipped', (reasons.get(r.reason ?? 'skipped') ?? 0) + 1);
  const label: Record<string, string> = {
    'no Modessi items': 'no Modessi products in it',
    'already sent to a courier': 'already sent to Steadfast/Carrybee',
    'order is cancelled': 'cancelled',
    cancelled: 'cancelled at Modessi',
  };
  for (const [reason, n] of reasons) toast.info(`${plural(n)} not sent: ${label[reason] ?? reason}`);

  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length > 0) toast.error(`${plural(failed.length)} failed: ${failed[0].error ?? 'unknown error'}`);
  return sent + updated;
}

/**
 * After an admin edits orders or changes their status: send the change to Modessi now instead
 * of waiting for the 15-minute cron. Orders without Modessi items are skipped by the function.
 * Never throws; a failure is reported and left for the cron to retry.
 */
export async function notifyModessi(orderIds: string[]): Promise<void> {
  if (orderIds.length === 0) return;
  try {
    const { results } = await invokeModessiSync<{ results: PushResult[] }>({ action: 'push_updates', orderIds });
    const failed = results.filter((r) => r.status === 'failed');
    if (results.some((r) => r.status === 'updated')) toast.success('Modessi has the change');
    if (results.some((r) => r.status === 'cancelled')) toast.success('Cancelled on Modessi too');
    if (results.some((r) => r.status === 'sent')) toast.success('Sent to Modessi');
    if (failed.length > 0) toast.error(`Modessi: ${failed[0].error ?? 'update failed'}`);
  } catch (err) {
    const message = (err as Error).message ?? '';
    // Not connected yet: stay quiet, the rest of the admin works as before.
    if (/not connected|not configured|MODESSI_/.test(message)) return;
    console.warn('Modessi push failed (the cron will retry):', message);
  }
}
