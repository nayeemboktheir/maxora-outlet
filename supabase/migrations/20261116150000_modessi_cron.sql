-- Runs modessi-sync { action: 'all' } every 15 minutes: prices and stock, sends orders that are
-- waiting or failed, pushes edits, and pulls statuses and payments from Modessi.
--
-- The job authenticates with a random token generated here and kept in a table only the
-- server can read (RLS on, no policies, no grants to anon/authenticated). modessi-sync reads
-- the same row with the service role and only lets this token run action 'all'.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE TABLE IF NOT EXISTS public.modessi_cron_secret (
  id    integer PRIMARY KEY CHECK (id = 1),
  token text NOT NULL
);
ALTER TABLE public.modessi_cron_secret ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.modessi_cron_secret FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.modessi_cron_secret TO service_role;

INSERT INTO public.modessi_cron_secret (id, token)
VALUES (1, encode(extensions.gen_random_bytes(32), 'hex'))
ON CONFLICT (id) DO NOTHING;

SELECT cron.unschedule('modessi-sync') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'modessi-sync');

SELECT cron.schedule('modessi-sync', '*/15 * * * *', $job$
  SELECT net.http_post(
    url     := 'https://kawthlgchigwitlarrut.supabase.co/functions/v1/modessi-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      -- Public anon key: only gets the request past the gateway; x-cron-token is the real check.
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imthd3RobGdjaGlnd2l0bGFycnV0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAxNDM0NTQsImV4cCI6MjEwNTcxOTQ1NH0.0_mixCUNrobdFuOJ5BKm2NPDXWkDrA70O8NcYuW7tHw',
      'x-cron-token', (SELECT token FROM public.modessi_cron_secret WHERE id = 1)
    ),
    body    := '{"action":"all"}'::jsonb,
    timeout_milliseconds := 60000
  );
$job$);
