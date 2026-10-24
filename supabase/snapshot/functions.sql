-- DB baseline snapshot: pg_get_functiondef for every function in schemas public and private.
-- Project wefobwdspqzxbesbnzoc, captured 2026-10-24. READ-ONLY REFERENCE, not a migration.
-- Schema private currently contains NO functions (only table private.tradestation_tokens_bak_20261002).
-- No secret literals were present (checked with JWT / sb_secret_ / sb_publishable_ redaction regex).

-- ---------------------------------------------------------------------------
-- public.handle_new_user()  SECURITY DEFINER
-- ACL: postgres=X, service_role=X   (PUBLIC/anon/authenticated EXECUTE revoked)
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end;
$function$;

-- ---------------------------------------------------------------------------
-- public.invoke_edge_function(fn_name text, query_string text DEFAULT ''::text) RETURNS bigint
-- SECURITY DEFINER, search_path ''. ACL: postgres=X, service_role=X  (PUBLIC/anon/authenticated revoked)
-- CURRENT BEHAVIOUR: posts with ONLY a Content-Type header (no x-cron-secret, no Authorization),
--   body '{}', 10-minute pg_net timeout, returns the pg_net request id. Callers: every bx-* cron job.
CREATE OR REPLACE FUNCTION public.invoke_edge_function(fn_name text, query_string text DEFAULT ''::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  request_id bigint;
  base_url text := 'https://wefobwdspqzxbesbnzoc.supabase.co/functions/v1';
  full_url text := base_url || '/' || fn_name || (case when query_string = '' then '' else '?' || query_string end);
begin
  select net.http_post(
    url     := full_url,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 600000  -- 10 min, scans take ~1-2 min
  ) into request_id;
  return request_id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- public.reconcile_universe(window_minutes integer DEFAULT 30, min_count integer DEFAULT 800) RETURNS integer
-- SECURITY DEFINER, search_path ''. ACL: postgres=X, service_role=X
-- Deactivates universe rows whose ticker_meta.updated_at is older than window_minutes,
-- only if >= min_count ticker_meta rows were refreshed in that window (else returns -1).
CREATE OR REPLACE FUNCTION public.reconcile_universe(window_minutes integer DEFAULT 30, min_count integer DEFAULT 800)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare fresh_count int; n int;
begin
  select count(*) into fresh_count from public.ticker_meta
    where updated_at > now() - make_interval(mins => window_minutes);
  if fresh_count < min_count then return -1; end if;       -- partial/no sync: skip
  update public.universe u set active = false
  where u.active and not exists (
    select 1 from public.ticker_meta m
    where m.ticker = u.ticker and m.updated_at > now() - make_interval(mins => window_minutes)
  );
  get diagnostics n = row_count;
  return n;
end $function$;

-- ---------------------------------------------------------------------------
-- public.search_stocks(filter jsonb)  STABLE, SECURITY INVOKER
-- ACL: PUBLIC=X, anon=X, authenticated=X, service_role=X, postgres=X
-- (Legacy "Stock Edge" screener over public.tickers/public.quotes; quotes table currently empty.)
CREATE OR REPLACE FUNCTION public.search_stocks(filter jsonb)
 RETURNS TABLE(symbol text, name text, price numeric, pct_change numeric, intraday_pct_change numeric, rvol numeric, vol_1m numeric, vol_5m numeric, vol_total numeric, capital_total numeric, float_shares numeric, volatility numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with p as (select filter->'price' as v),
       vol as (select filter->'volume' as v),
       f as (select filter->'fundamental' as v)
  select
    t.symbol, t.name,
    q.price, q.pct_change, q.intraday_pct_change, q.rvol,
    q.vol_1m, q.vol_5m, q.vol_total, q.capital_total,
    t.float_shares, q.volatility
  from public.tickers t
  join public.quotes  q on q.symbol = t.symbol
  where
    -- price range checks
    (((select v->'current_price'->>0 from p) is null) or q.price >= ((select v->'current_price'->>0 from p))::numeric) and
    (((select v->'current_price'->>1 from p) is null) or q.price <= ((select v->'current_price'->>1 from p))::numeric) and
    (((select v->'pct_change'->>0 from p) is null) or q.pct_change >= ((select v->'pct_change'->>0 from p))::numeric) and
    (((select v->'pct_change'->>1 from p) is null) or q.pct_change <= ((select v->'pct_change'->>1 from p))::numeric) and
    (((select v->'intraday_pct_change'->>0 from p) is null) or q.intraday_pct_change >= ((select v->'intraday_pct_change'->>0 from p))::numeric) and
    (((select v->'intraday_pct_change'->>1 from p) is null) or q.intraday_pct_change <= ((select v->'intraday_pct_change'->>1 from p))::numeric) and
    (((select v->'pct_from_vwap'->>0 from p) is null) or q.pct_from_vwap >= ((select v->'pct_from_vwap'->>0 from p))::numeric) and
    (((select v->'pct_from_vwap'->>1 from p) is null) or q.pct_from_vwap <= ((select v->'pct_from_vwap'->>1 from p))::numeric) and
    (((select v->'volatility'->>0 from p) is null) or q.volatility >= ((select v->'volatility'->>0 from p))::numeric) and
    (((select v->'volatility'->>1 from p) is null) or q.volatility <= ((select v->'volatility'->>1 from p))::numeric) and
    (((select v->>'gapping' from p) = 'either') or (select v->>'gapping' from p) is null
      or ((select v->>'gapping' from p) = 'up' and q.pct_change >= 1)
      or ((select v->>'gapping' from p) = 'down' and q.pct_change <= -1)) and
    -- volume range checks
    (((select v->'vol_total'->>0 from vol) is null) or q.vol_total >= ((select v->'vol_total'->>0 from vol))::numeric) and
    (((select v->'vol_total'->>1 from vol) is null) or q.vol_total <= ((select v->'vol_total'->>1 from vol))::numeric) and
    (((select v->'capital_total'->>0 from vol) is null) or q.capital_total >= ((select v->'capital_total'->>0 from vol))::numeric) and
    (((select v->'capital_total'->>1 from vol) is null) or q.capital_total <= ((select v->'capital_total'->>1 from vol))::numeric) and
    (((select v->'vol_1m'->>0 from vol) is null) or q.vol_1m >= ((select v->'vol_1m'->>0 from vol))::numeric) and
    (((select v->'vol_1m'->>1 from vol) is null) or q.vol_1m <= ((select v->'vol_1m'->>1 from vol))::numeric) and
    (((select v->'vol_5m'->>0 from vol) is null) or q.vol_5m >= ((select v->'vol_5m'->>0 from vol))::numeric) and
    (((select v->'vol_5m'->>1 from vol) is null) or q.vol_5m <= ((select v->'vol_5m'->>1 from vol))::numeric) and
    (((select v->'rvol'->>0 from vol) is null) or q.rvol >= ((select v->'rvol'->>0 from vol))::numeric) and
    (((select v->'rvol'->>1 from vol) is null) or q.rvol <= ((select v->'rvol'->>1 from vol))::numeric) and
    -- fundamental range checks
    (((select v->'market_cap'->>0 from f) is null) or t.market_cap >= ((select v->'market_cap'->>0 from f))::numeric) and
    (((select v->'market_cap'->>1 from f) is null) or t.market_cap <= ((select v->'market_cap'->>1 from f))::numeric) and
    (((select v->'float_shares'->>0 from f) is null) or t.float_shares >= ((select v->'float_shares'->>0 from f))::numeric) and
    (((select v->'float_shares'->>1 from f) is null) or t.float_shares <= ((select v->'float_shares'->>1 from f))::numeric)
  order by coalesce(q.capital_total, 0) desc
  limit 500;
$function$;

-- ---------------------------------------------------------------------------
-- public.touch_updated_at()  trigger function, SECURITY INVOKER
-- ACL: PUBLIC=X, anon=X, authenticated=X, service_role=X, postgres=X
CREATE OR REPLACE FUNCTION public.touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;
