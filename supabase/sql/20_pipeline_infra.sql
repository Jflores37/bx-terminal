-- 20_pipeline_infra.sql -- BX Terminal pipeline infrastructure (unit "db").
--
-- Purpose
--   1. public.edge_call_log (C2): one row per cron -> edge-function HTTP call, with the HTTP outcome copied from
--      net._http_response before pg_net purges it (pg_net.ttl = 6 h). cron.job_run_details only records that the
--      SELECT ran, so until now every failed call (546 WORKER_RESOURCE_LIMIT, 500 PGRST102) showed as "succeeded".
--                                                                                                     [db-2]
--   2. public.pipeline_runs (C3): one row per edge-function invocation, written by _shared/pipeline_log.ts
--      (startRun / finishRun, service_role via PostgREST).                                       [db-2, db-1, db-4]
--   3. public.bx_backtest_baseline (C6): per-ticker unconditional forward-return aggregates written by
--      bx-backtest-builder (service_role). Read by the bx_backtest_baseline_summary matview (22_backtest_summary).
--                                                                                                  [fe-b-4, db-7]
--   4. public.invoke_edge_function (C2, same signature): reads the vault secret named 'cron_secret' and sends it as
--      header x-cron-secret, then logs the call to edge_call_log. If the secret is missing the call is still
--      enqueued (the function then answers 500 and that outcome is logged).                          [db-5, db-2]
--   5. private.reconcile_edge_calls() + cron job 'pipeline-reconcile-edge-calls' (every 10 min): copies status
--      from net._http_response into edge_call_log, marks calls with no response after 1 h as lost, and closes
--      pipeline_runs rows left 'running' by a killed worker (WORKER_RESOURCE_LIMIT never runs finishRun).    [db-2]
--   All three new tables: RLS ON (no policies -> deny-all except service_role / postgres) and an explicit
--   REVOKE ALL FROM PUBLIC, anon, authenticated. Anon reads pipeline health ONLY through public.pipeline_health
--   (21_views.sql), which exposes status/counts/timestamps, never error text or response bodies.
--
-- Vault secret (NOT created here; the orchestrator runs this separately, value never written to any file):
--   select vault.create_secret('<same value as the edge secret CRON_SECRET>', 'cron_secret',
--                              'x-cron-secret header sent by public.invoke_edge_function');
--   To rotate later: select vault.update_secret((select id from vault.secrets where name = 'cron_secret'), '<new>');
--   and set the edge secret CRON_SECRET to the same new value.
--
-- Findings: db-2, db-5 (and the detection side of db-1, db-4 via pipeline_runs / edge_call_log).
-- Must run after: 10_security.sql. Must run BEFORE deploying the C1/C3 edge functions (they write pipeline_runs
--   and require x-cron-secret). The edge secret CRON_SECRET and the vault secret 'cron_secret' must hold the
--   same value before the new functions are deployed (else every cron call returns 500, logged here).
-- Idempotent: CREATE ... IF NOT EXISTS, CREATE OR REPLACE, cron.schedule by job name (re-scheduling a name
--   replaces it). No secret values in this file.
--
-- Rollback (run as postgres):
--   WARNING: the old function below sends NO x-cron-secret header. Once the C1 functions (requireCron, fail
--   closed) are deployed, restoring it makes every cron call return 401/500. Roll the function deploys back
--   first, or keep the header: in the old body, add the same vault lookup and
--   'x-cron-secret' header as section 4 of this file (i.e. only drop the edge_call_log insert).
--   select cron.unschedule('pipeline-reconcile-edge-calls');
--   -- restore the old invoke_edge_function (no header, no logging):
--   CREATE OR REPLACE FUNCTION public.invoke_edge_function(fn_name text, query_string text DEFAULT ''::text)
--    RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $f$
--   declare request_id bigint; base_url text := 'https://wefobwdspqzxbesbnzoc.supabase.co/functions/v1';
--     full_url text := base_url || '/' || fn_name || (case when query_string = '' then '' else '?' || query_string end);
--   begin
--     select net.http_post(url := full_url, headers := jsonb_build_object('Content-Type', 'application/json'),
--       body := '{}'::jsonb, timeout_milliseconds := 600000) into request_id;
--     return request_id;
--   end; $f$;
--   DROP FUNCTION IF EXISTS private.reconcile_edge_calls();
--   -- the tables only after 21_views/22_backtest_summary objects that read them are rolled back:
--   DROP TABLE IF EXISTS public.edge_call_log; DROP TABLE IF EXISTS public.pipeline_runs;
--   DROP TABLE IF EXISTS public.bx_backtest_baseline;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. edge_call_log (C2)
CREATE TABLE IF NOT EXISTS public.edge_call_log (
  request_id       bigint      PRIMARY KEY,                 -- pg_net request id (= net._http_response.id)
  fn               text        NOT NULL,
  params           jsonb,                                   -- parsed query string (never contains secrets: C1)
  enqueued_at      timestamptz NOT NULL DEFAULT now(),
  status_code      int,
  ok               boolean,                                 -- NULL = no outcome recorded yet
  error            text,
  response_excerpt text,
  completed_at     timestamptz
);
COMMENT ON TABLE public.edge_call_log IS
  'One row per cron -> edge function call (public.invoke_edge_function). HTTP outcome copied from net._http_response by private.reconcile_edge_calls() every 10 min. postgres/service_role only; anon sees aggregates via public.pipeline_health.';
CREATE INDEX IF NOT EXISTS edge_call_log_enqueued_idx ON public.edge_call_log (enqueued_at DESC);
CREATE INDEX IF NOT EXISTS edge_call_log_pending_idx ON public.edge_call_log (enqueued_at) WHERE completed_at IS NULL;
ALTER TABLE public.edge_call_log OWNER TO postgres;
ALTER TABLE public.edge_call_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.edge_call_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.edge_call_log TO service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. pipeline_runs (C3)
CREATE TABLE IF NOT EXISTS public.pipeline_runs (
  id            bigserial   PRIMARY KEY,
  fn            text        NOT NULL,
  params        jsonb,
  started_at    timestamptz DEFAULT now(),
  finished_at   timestamptz,
  status        text        CHECK (status IN ('running', 'ok', 'partial', 'error')),
  rows_written  int,
  rows_expected int,
  error         text
);
COMMENT ON TABLE public.pipeline_runs IS
  'One row per edge function invocation (_shared/pipeline_log.ts startRun/finishRun). Rows left ''running'' for 15+ min are closed as error by private.reconcile_edge_calls(). service_role/postgres only.';
CREATE INDEX IF NOT EXISTS pipeline_runs_fn_started_idx ON public.pipeline_runs (fn, started_at DESC);
CREATE INDEX IF NOT EXISTS pipeline_runs_running_idx ON public.pipeline_runs (started_at) WHERE status = 'running';
ALTER TABLE public.pipeline_runs OWNER TO postgres;
ALTER TABLE public.pipeline_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pipeline_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.pipeline_runs_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.pipeline_runs TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.pipeline_runs_id_seq TO service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. bx_backtest_baseline (C6). Same return definition (BAR offsets) and the same outlier rule as the signal rows
--    (see "BX outlier rule v1" in 22_backtest_summary.sql): a bar counts for horizon h only if its close >= 1.00
--    and its h-bar forward return is <= +10000 %.
CREATE TABLE IF NOT EXISTS public.bx_backtest_baseline (
  ticker      text             NOT NULL,
  timeframe   text             NOT NULL CHECK (timeframe IN ('daily', 'weekly', 'monthly')),
  n_bars      int,
  sum_ret_5   double precision,
  n_ret_5     int,
  wins_5      int,
  sum_ret_20  double precision,
  n_ret_20    int,
  wins_20     int,
  sum_ret_60  double precision,
  n_ret_60    int,
  wins_60     int,
  sum_ret_120 double precision,
  n_ret_120   int,
  wins_120    int,
  computed_at timestamptz      DEFAULT now(),
  PRIMARY KEY (ticker, timeframe)
);
COMMENT ON TABLE public.bx_backtest_baseline IS
  'Per-ticker unconditional forward-return aggregates over EVERY completed bar (bx-backtest-builder, C6). ret = bar-offset % return; outlier rule v1 (close >= 1.00, ret <= 10000). Read via the bx_backtest_baseline_summary matview.';
ALTER TABLE public.bx_backtest_baseline OWNER TO postgres;
ALTER TABLE public.bx_backtest_baseline ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bx_backtest_baseline FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bx_backtest_baseline TO service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. invoke_edge_function: same signature/owner/ACL, now sends x-cron-secret and logs the call.
CREATE OR REPLACE FUNCTION public.invoke_edge_function(fn_name text, query_string text DEFAULT ''::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  request_id bigint;
  base_url text := 'https://wefobwdspqzxbesbnzoc.supabase.co/functions/v1';
  full_url text := base_url || '/' || fn_name
                   || (case when coalesce(query_string, '') = '' then '' else '?' || query_string end);
  v_secret text;
  v_headers jsonb := jsonb_build_object('Content-Type', 'application/json');
  v_params jsonb;
begin
  -- C2: the shared cron secret lives in Vault (name 'cron_secret'); never logged, never in the URL.
  begin
    select ds.decrypted_secret into v_secret
      from vault.decrypted_secrets ds
     where ds.name = 'cron_secret'
     order by ds.updated_at desc nulls last
     limit 1;
  exception when others then
    v_secret := null;
  end;
  if coalesce(v_secret, '') <> '' then
    v_headers := v_headers || jsonb_build_object('x-cron-secret', v_secret);
  else
    raise warning 'invoke_edge_function: vault secret cron_secret is missing; % will reject this call (500)', fn_name;
  end if;

  select net.http_post(
    url     := full_url,
    headers := v_headers,
    body    := '{}'::jsonb,
    timeout_milliseconds := 600000  -- edge wall clock is 150 s on this plan; the gateway answers long before this
  ) into request_id;

  -- Log the call. A logging failure must never cancel the request (same transaction), so it is trapped.
  begin
    select coalesce(jsonb_object_agg(split_part(kv, '=', 1), nullif(substr(kv, length(split_part(kv, '=', 1)) + 2), '')),
                    '{}'::jsonb)
      into v_params
      from unnest(string_to_array(coalesce(query_string, ''), '&')) as kv
     where kv <> '';
    insert into public.edge_call_log (request_id, fn, params)
    values (request_id, fn_name, v_params)
    on conflict (request_id) do nothing;
  exception when others then
    raise warning 'invoke_edge_function: could not log request % for %: %', request_id, fn_name, sqlerrm;
  end;

  return request_id;
end;
$function$;
ALTER FUNCTION public.invoke_edge_function(text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.invoke_edge_function(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_edge_function(text, text) TO service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Reconcile: copy HTTP outcomes out of net._http_response (purged after ~6 h) and close dead runs.
CREATE OR REPLACE FUNCTION private.reconcile_edge_calls()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  n_done int := 0;
  n_lost int := 0;
  n_dead int := 0;
begin
  update public.edge_call_log l
     set status_code      = r.status_code,
         ok               = (not coalesce(r.timed_out, false) and r.error_msg is null
                             and coalesce(r.status_code between 200 and 299, false)),
         error            = case
                              when r.error_msg is not null then r.error_msg
                              when coalesce(r.timed_out, false) then 'timed out'
                              when r.status_code is null then 'no HTTP status'
                              when r.status_code not between 200 and 299 then 'HTTP ' || r.status_code
                            end,
         response_excerpt = left(r.content, 500),
         completed_at     = now()   -- when the outcome was recorded (net._http_response.created is the request time)
    from net._http_response r
   where r.id = l.request_id
     and l.completed_at is null;
  get diagnostics n_done = row_count;

  -- pg_net always writes a response row (status, timeout or error) well within 15 min of the 600 s timeout;
  -- none after 1 h means the worker lost it or the row was purged before we saw it.
  update public.edge_call_log
     set ok = false, error = 'no pg_net response within 1 h (lost or purged)', completed_at = now()
   where completed_at is null
     and enqueued_at < now() - interval '1 hour';
  get diagnostics n_lost = row_count;

  -- A worker killed by the platform (546 WORKER_RESOURCE_LIMIT, 150 s wall clock) never calls finishRun.
  update public.pipeline_runs
     set status = 'error', finished_at = now(),
         error = coalesce(error, 'no finish recorded within 15 min (worker killed?)')
   where status = 'running'
     and started_at < now() - interval '15 minutes';
  get diagnostics n_dead = row_count;

  return n_done + n_lost + n_dead;
end;
$function$;
ALTER FUNCTION private.reconcile_edge_calls() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.reconcile_edge_calls() FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION private.reconcile_edge_calls() IS
  'pg_cron every 10 min (job pipeline-reconcile-edge-calls): edge_call_log <- net._http_response; lost calls; dead pipeline_runs.';

-- Scheduled here so outcomes are captured from the moment the new invoke_edge_function is live.
-- 23_cron_schedule.sql re-creates the same job (same name) as part of the full schedule.
SELECT cron.schedule('pipeline-reconcile-edge-calls', '*/10 * * * *', $cmd$select private.reconcile_edge_calls()$cmd$);

-- ---------------------------------------------------------------------------------------------------------------
-- 6. Self-check (raises -> the whole migration rolls back).
DO $$
declare
  t text;
begin
  foreach t in array array['edge_call_log', 'pipeline_runs', 'bx_backtest_baseline'] loop
    if not (select relrowsecurity from pg_class where oid = format('public.%I', t)::regclass) then
      raise exception '20_pipeline_infra self-check: RLS is off on public.%', t;
    end if;
    if has_table_privilege('anon', format('public.%I', t), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
       or has_table_privilege('authenticated', format('public.%I', t), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') then
      raise exception '20_pipeline_infra self-check: anon/authenticated can access public.%', t;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.invoke_edge_function(text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.invoke_edge_function(text, text)', 'EXECUTE') then
    raise exception '20_pipeline_infra self-check: invoke_edge_function is executable by anon/authenticated';
  end if;
  if not exists (select 1 from cron.job where jobname = 'pipeline-reconcile-edge-calls') then
    raise exception '20_pipeline_infra self-check: reconcile job missing';
  end if;
end
$$;
