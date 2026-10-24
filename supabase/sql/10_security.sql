-- 10_security.sql -- BX Terminal security hardening (unit "sec").
--
-- Purpose
--   1. public.ts_oauth_states: one-time OAuth state + PKCE verifier store for ts-oauth-start / ts-oauth-callback
--      (RLS on, no anon/authenticated grants, 10-minute expiry).                         [edge-ts-2, edge-ts-8]
--   2. private.tradestation_tokens_history + public.ts_store_linked_tokens(): the OAuth callback archives the
--      current tradestation_tokens id=1 row and upserts the new tokens in ONE transaction; service_role only.
--                                                                                       [edge-ts-2, edge-ts-5]
--   2b. public.ts_cas_tokens(): compare-and-swap refresh write used by _shared/ts_auth.ts (C7), so the old
--      refresh token travels in a POST body instead of a logged PostgREST query string; service_role only.
--                                                                                       [edge-ts-1 class, edge-ts-4]
--   3. Move public.tradestation_tokens_bak (token material) into schema private, out of PostgREST's reach and
--      away from the service-role key.                                                 [edge-ts-9, db-14]
--   3b. Primary key on private.tradestation_tokens_bak_20261002 (no_primary_key advisor; table kept). [db-14]
--   4. Least privilege for anon/authenticated:                                                        [db-13]
--      - REVOKE ALL on secret/token tables: tradestation_tokens, app_settings, alert_state, ts_oauth_states.
--      - REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES, MAINTAIN on EVERY public table/view/matview.
--        Proof the SPA writes nothing: src/App.jsx only calls sbFetch() = GET /rest/v1/<view>?select=... on
--        latest_scans_with_meta, bx_movers, sector_pulse, bx_backtest_summary, bx_backtest_results; no insert/update/
--        upsert/delete/rpc/POST/PATCH anywhere in src/, and no other repo on this machine references this project
--        except the ts-token consumers (edge function, not PostgREST). profiles/saved_filters (legacy "Stock Edge"
--        per-user rows, 0 rows each) have no client left; profiles is still filled by the SECURITY DEFINER trigger
--        handle_new_user() (owner postgres), which these revokes do not affect.
--      - SELECT is KEPT on everything else, in particular what the SPA reads: latest_scans_with_meta, bx_movers,
--        sector_pulse, bx_backtest_summary, bx_backtest_results, and the base relations those security_invoker views
--        need: latest_scans, multi_timeframe_view, bx_scans, universe, ticker_meta.
--      - Sequences: REVOKE USAGE, UPDATE from anon/authenticated (useless without INSERT).
--      - Default privileges FOR ROLE postgres IN SCHEMA public: future tables/sequences no longer hand write
--        privileges to anon/authenticated (SELECT still granted by default, so e.g. pipeline_health keeps anon read).
--        Safe because every writer in this project is service_role (edge functions) or postgres (cron,
--        SECURITY DEFINER functions); C2/C3/C6 tables are written only by those roles.
--      - Function EXECUTE grants are NOT touched here (no blanket revoke): 21_views' pipeline_health needs
--        anon/authenticated EXECUTE on private.pipeline_health_rows().
--   5. Self-check at the end: aborts (whole migration rolls back) if the SPA lost SELECT or anon kept any write.
--
-- Findings: edge-ts-2, edge-ts-4, edge-ts-5, edge-ts-8, edge-ts-9, db-13, db-14.
-- Must run after: nothing (first file). Must run BEFORE deploying ts-token, bx-scan (both bundle
-- _shared/ts_auth.ts, which calls ts_cas_tokens) and ts-oauth-start / ts-oauth-callback.
--   Gate (read-only): select to_regprocedure('public.ts_cas_tokens(text,text,text,timestamptz,text)') is not null
--   must be true. An HTTP probe of /rest/v1/rpc/ts_cas_tokens must send ALL five p_* names in the body (all are
--   required; PostgREST resolves the overload by argument names before any privilege check, so a '{}' body always
--   gets 404 PGRST202 even with a fresh schema cache). With the full body, anon should get 401 (42501).
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE / guarded DO blocks; revokes are no-ops when repeated.
-- No secret values in this file.
--
-- Rollback (run as postgres):
--   -- grants (restores the Supabase defaults that existed before; NOT recommended):
--   GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;            -- then re-run the secret-table revokes:
--   REVOKE ALL ON public.tradestation_tokens, public.app_settings, public.alert_state FROM anon, authenticated;
--   REVOKE ALL ON public.ts_oauth_states FROM anon, authenticated;              -- skip if it was dropped below
--   GRANT USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT USAGE, UPDATE ON SEQUENCES TO anon, authenticated;
--   -- backup table back to public (only if wanted):
--   ALTER TABLE private.tradestation_tokens_bak SET SCHEMA public;
--   ALTER TABLE private.tradestation_tokens_bak_20261002 DROP CONSTRAINT IF EXISTS tradestation_tokens_bak_20261002_pkey;
--   -- OAuth objects (only after reverting ts-oauth-start/callback to the old code):
--   DROP FUNCTION IF EXISTS public.ts_store_linked_tokens(text, text, timestamptz, text);
--   -- only after NO deployed function bundles the new _shared/ts_auth.ts any more (else refreshes stop persisting):
--   DROP FUNCTION IF EXISTS public.ts_cas_tokens(text, text, text, timestamptz, text);
--   DROP TABLE IF EXISTS public.ts_oauth_states;
--   -- keep private.tradestation_tokens_history (it holds the pre-relink rows needed to restore id=1):
--   --   INSERT INTO public.tradestation_tokens (id, access_token, refresh_token, expires_at, scope, updated_at)
--   --   SELECT 1, access_token, refresh_token, expires_at, scope, now() FROM private.tradestation_tokens_history
--   --   ORDER BY history_id DESC LIMIT 1
--   --   ON CONFLICT (id) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token,
--   --     expires_at = excluded.expires_at, scope = excluded.scope, updated_at = excluded.updated_at;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. OAuth state store (public so the service role can reach it through PostgREST; nobody else can).
CREATE TABLE IF NOT EXISTS public.ts_oauth_states (
  state         text        PRIMARY KEY CHECK (state ~ '^[A-Za-z0-9_-]{43}$'),
  code_verifier text        NOT NULL CHECK (code_verifier ~ '^[A-Za-z0-9_-]{43,128}$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  CONSTRAINT ts_oauth_states_ttl CHECK (expires_at <= created_at + interval '10 minutes')
);
COMMENT ON TABLE public.ts_oauth_states IS
  'One-time OAuth state + PKCE verifier (ts-oauth-start writes, ts-oauth-callback consumes with DELETE..RETURNING). 10-minute expiry. service_role only.';
ALTER TABLE public.ts_oauth_states OWNER TO postgres;
ALTER TABLE public.ts_oauth_states ENABLE ROW LEVEL SECURITY;   -- no policies: deny-all except service_role (BYPASSRLS)
REVOKE ALL ON public.ts_oauth_states FROM PUBLIC, anon, authenticated, service_role;  -- drop the default-ACL ALL first
GRANT SELECT, INSERT, DELETE ON public.ts_oauth_states TO service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Token history (private: not exposed by PostgREST; service_role has no USAGE on schema private).
CREATE TABLE IF NOT EXISTS private.tradestation_tokens_history (
  history_id    bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  archived_at   timestamptz NOT NULL DEFAULT now(),
  reason        text        NOT NULL,
  id            integer,
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,
  scope         text,
  updated_at    timestamptz
);
COMMENT ON TABLE private.tradestation_tokens_history IS
  'Copy of public.tradestation_tokens id=1 taken right before each OAuth re-link overwrites it (public.ts_store_linked_tokens).';
ALTER TABLE private.tradestation_tokens_history OWNER TO postgres;   -- the SECURITY DEFINER writer below runs as postgres
ALTER TABLE private.tradestation_tokens_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.tradestation_tokens_history FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ts_store_linked_tokens(
  p_access_token text, p_refresh_token text, p_expires_at timestamptz, p_scope text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
begin
  if coalesce(p_access_token, '') = '' or coalesce(p_refresh_token, '') = '' or p_expires_at is null then
    raise exception 'ts_store_linked_tokens: access_token, refresh_token and expires_at are required';
  end if;
  insert into private.tradestation_tokens_history (reason, id, access_token, refresh_token, expires_at, scope, updated_at)
    select 'oauth-relink', t.id, t.access_token, t.refresh_token, t.expires_at, t.scope, t.updated_at
    from public.tradestation_tokens t where t.id = 1;
  insert into public.tradestation_tokens as t (id, access_token, refresh_token, expires_at, scope, updated_at)
    values (1, p_access_token, p_refresh_token, p_expires_at, p_scope, now())
  on conflict (id) do update set
    access_token = excluded.access_token, refresh_token = excluded.refresh_token,
    expires_at = excluded.expires_at, scope = coalesce(excluded.scope, t.scope),   -- NULL scope keeps the stored one
    updated_at = excluded.updated_at;
  return true;
end
$function$;
ALTER FUNCTION public.ts_store_linked_tokens(text, text, timestamptz, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ts_store_linked_tokens(text, text, timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ts_store_linked_tokens(text, text, timestamptz, text) TO service_role;
COMMENT ON FUNCTION public.ts_store_linked_tokens(text, text, timestamptz, text) IS
  'ts-oauth-callback only (service_role): archive tradestation_tokens id=1 to private.tradestation_tokens_history, then upsert the new tokens. One transaction.';

-- 2b. Compare-and-swap refresh write for _shared/ts_auth.ts (contract C7). Exists so no token value ever goes
--     into a PostgREST URL: the API gateway (edge_logs) records request query strings, while POST bodies are not
--     logged (and Postgres here has log_statement=ddl, log_parameter_max_length_on_error=0). SECURITY INVOKER:
--     it runs with the caller's own rights (service_role: UPDATE + BYPASSRLS), so EXECUTE alone grants nothing.
--     p_scope NULL keeps the stored scope. Returns true when this caller's update won.
CREATE OR REPLACE FUNCTION public.ts_cas_tokens(
  p_old_refresh text, p_access_token text, p_refresh_token text, p_expires_at timestamptz, p_scope text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
declare
  n integer;
begin
  if coalesce(p_old_refresh, '') = '' or coalesce(p_access_token, '') = '' or coalesce(p_refresh_token, '') = ''
     or p_expires_at is null then
    raise exception 'ts_cas_tokens: old refresh_token, access_token, refresh_token and expires_at are required';
  end if;
  update public.tradestation_tokens t set
    access_token = p_access_token, refresh_token = p_refresh_token, expires_at = p_expires_at,
    scope = coalesce(p_scope, t.scope), updated_at = now()
  where t.id = 1 and t.refresh_token = p_old_refresh;
  get diagnostics n = row_count;
  return n > 0;
end
$function$;
ALTER FUNCTION public.ts_cas_tokens(text, text, text, timestamptz, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ts_cas_tokens(text, text, text, timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ts_cas_tokens(text, text, text, timestamptz, text) TO service_role;
COMMENT ON FUNCTION public.ts_cas_tokens(text, text, text, timestamptz, text) IS
  '_shared/ts_auth.ts refresh (service_role): UPDATE tradestation_tokens id=1 only if refresh_token still equals p_old_refresh. Token values in the body, never the URL.';

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Move public.tradestation_tokens_bak into schema private (handles name collisions there).
DO $$
declare
  target text := 'tradestation_tokens_bak';
  suffix text := to_char(clock_timestamp(), 'YYYYMMDDHH24MISS');
begin
  if to_regclass('public.tradestation_tokens_bak') is null then
    return;                                             -- already moved (re-run) or never existed
  end if;
  if to_regclass('private.tradestation_tokens_bak') is not null then
    target := 'tradestation_tokens_bak_' || suffix;
    execute format('ALTER TABLE public.tradestation_tokens_bak RENAME TO %I', target);
  end if;
  if to_regclass('private.tradestation_tokens_bak_pkey') is not null
     and to_regclass('public.tradestation_tokens_bak_pkey') is not null then
    execute format('ALTER INDEX public.tradestation_tokens_bak_pkey RENAME TO %I', 'tradestation_tokens_bak_pkey_' || suffix);
  end if;
  execute format('ALTER TABLE public.%I SET SCHEMA private', target);
  execute format('REVOKE ALL ON private.%I FROM PUBLIC, anon, authenticated, service_role', target);
end
$$;

-- 3b. private.tradestation_tokens_bak_20261002 (older manual backup, 1 row, no constraints) trips the no_primary_key
--     advisor. Give it a PK on id when id is non-null and unique; otherwise leave it alone. Dropping it (it holds
--     token material) stays a user decision [db-14]. to_regclass() everywhere: a '...'::regclass literal is resolved
--     when the expression is parsed, so it would raise "does not exist" if the user already dropped the table.
DO $$
begin
  if to_regclass('private.tradestation_tokens_bak_20261002') is null then
    return;                                             -- dropped by the user (or never existed): nothing to do
  end if;
  if exists (select 1 from pg_constraint
             where conrelid = to_regclass('private.tradestation_tokens_bak_20261002') and contype = 'p') then
    return;                                             -- PK already there (re-run)
  end if;
  if exists (select 1 from private.tradestation_tokens_bak_20261002 where id is null)
     or exists (select 1 from private.tradestation_tokens_bak_20261002 group by id having count(*) > 1) then
    raise notice '10_security: private.tradestation_tokens_bak_20261002 has null/duplicate id; PK not added';
    return;
  end if;
  alter table private.tradestation_tokens_bak_20261002 alter column id set not null;
  alter table private.tradestation_tokens_bak_20261002
    add constraint tradestation_tokens_bak_20261002_pkey primary key (id);
end
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Least privilege for anon / authenticated.
REVOKE ALL ON public.tradestation_tokens FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.app_settings        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.alert_state         FROM PUBLIC, anon, authenticated;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES, MAINTAIN
  ON ALL TABLES IN SCHEMA public FROM anon, authenticated;     -- tables, views and the matview; SELECT kept
REVOKE USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES, MAINTAIN ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE USAGE, UPDATE ON SEQUENCES FROM anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Self-check (raises -> the whole migration rolls back).
DO $$
declare
  r record;
  spa text[] := array['latest_scans_with_meta','bx_movers','sector_pulse','bx_backtest_summary','bx_backtest_results',
                      'latest_scans','multi_timeframe_view','bx_scans','universe','ticker_meta'];
  secret text[] := array['tradestation_tokens','app_settings','alert_state','ts_oauth_states'];
  t text;
begin
  foreach t in array spa loop
    if not has_table_privilege('anon', format('public.%I', t), 'SELECT') then
      raise exception '10_security self-check: anon lost SELECT on public.%', t;
    end if;
  end loop;
  foreach t in array secret loop
    if has_table_privilege('anon', format('public.%I', t), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
       or has_table_privilege('authenticated', format('public.%I', t), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') then
      raise exception '10_security self-check: anon/authenticated still has access to public.%', t;
    end if;
  end loop;
  for r in
    select c.oid, c.relname from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','f')
  loop
    if has_table_privilege('anon', r.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES,MAINTAIN')
       or has_table_privilege('authenticated', r.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES,MAINTAIN') then
      raise exception '10_security self-check: anon/authenticated still has a write privilege on public.%', r.relname;
    end if;
  end loop;
  if to_regclass('public.tradestation_tokens_bak') is not null then
    raise exception '10_security self-check: public.tradestation_tokens_bak still in public';
  end if;
  if has_function_privilege('anon', 'public.ts_store_linked_tokens(text, text, timestamptz, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.ts_store_linked_tokens(text, text, timestamptz, text)', 'EXECUTE') then
    raise exception '10_security self-check: ts_store_linked_tokens is executable by anon/authenticated';
  end if;
  if has_function_privilege('anon', 'public.ts_cas_tokens(text, text, text, timestamptz, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.ts_cas_tokens(text, text, text, timestamptz, text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.ts_cas_tokens(text, text, text, timestamptz, text)', 'EXECUTE') then
    raise exception '10_security self-check: ts_cas_tokens EXECUTE must be service_role only';
  end if;
end
$$;

-- Make PostgREST pick up the new RPCs right away (the pgrst DDL event trigger also does this; harmless twice).
NOTIFY pgrst, 'reload schema';
