-- DB baseline snapshot: every view / materialized view in schema public.
-- Project wefobwdspqzxbesbnzoc, captured 2026-10-24 (~12:15 AM ET) via pg_get_viewdef(oid, true).
-- READ-ONLY REFERENCE. Not a migration; do not apply.
-- All plain views have reloptions security_invoker=true (they run with the CALLER's privileges/RLS).
-- bx_backtest_summary is a MATERIALIZED VIEW (no reloptions) with
--   CREATE UNIQUE INDEX bx_backtest_summary_pk ON public.bx_backtest_summary USING btree (timeframe, signal_type)
--   (required by the cron job 'REFRESH MATERIALIZED VIEW CONCURRENTLY public.bx_backtest_summary').
-- Owner of every object: postgres.
-- Grants (identical on every object below):
--   postgres=arwdDxtm  anon=arwdDxtm  authenticated=arwdDxtm  service_role=arwdDxtm
--   (Supabase default "grant all"; for views only SELECT is meaningful, writes fail / are RLS-gated.)

-- ---------------------------------------------------------------------------
-- MATERIALIZED VIEW public.bx_backtest_summary
-- columns: timeframe text, signal_type text, n_signals bigint, n_with_60d bigint,
--          avg_5d numeric, avg_20d numeric, avg_60d numeric, avg_120d numeric,
--          median_60d numeric, win_rate_60d_pct numeric
-- NOTE for C10: the existing average columns are avg_5d, avg_20d, avg_60d, avg_120d
--   -> median columns per contract = med_5d, med_20d, med_60d, med_120d (median_60d already exists; keep it).
--   The only win-rate column is win_rate_60d_pct.
CREATE MATERIALIZED VIEW public.bx_backtest_summary AS
 SELECT timeframe,
    signal_type,
    count(*) AS n_signals,
    count(ret_60d) AS n_with_60d,
    round(avg(ret_5d), 2) AS avg_5d,
    round(avg(ret_20d), 2) AS avg_20d,
    round(avg(ret_60d), 2) AS avg_60d,
    round(avg(ret_120d), 2) AS avg_120d,
    round(percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (ret_60d::double precision))::numeric, 2) AS median_60d,
    round(100.0 * count(*) FILTER (WHERE ret_60d > 0::numeric)::numeric / NULLIF(count(ret_60d), 0)::numeric, 1) AS win_rate_60d_pct
   FROM bx_backtest_results
  GROUP BY timeframe, signal_type;

-- ---------------------------------------------------------------------------
-- VIEW public.bx_backtest_ticker   (security_invoker=true)
-- columns: ticker text, timeframe text, signal_type text, n_signals_12mo bigint, avg_20d numeric,
--          avg_60d numeric, win_rate_60d_pct numeric, last_signal_date date
CREATE VIEW public.bx_backtest_ticker AS
 SELECT ticker,
    timeframe,
    signal_type,
    count(*) AS n_signals_12mo,
    round(avg(ret_20d), 2) AS avg_20d,
    round(avg(ret_60d), 2) AS avg_60d,
    round(100.0 * count(*) FILTER (WHERE ret_60d > 0::numeric)::numeric / NULLIF(count(ret_60d), 0)::numeric, 1) AS win_rate_60d_pct,
    max(signal_date) AS last_signal_date
   FROM bx_backtest_results
  WHERE signal_date >= (CURRENT_DATE - '1 year'::interval)
  GROUP BY ticker, timeframe, signal_type;

-- ---------------------------------------------------------------------------
-- VIEW public.bx_movers   (security_invoker=true)
-- columns: ticker text, timeframe text, bx numeric(6,2), prev_bx numeric(6,2), delta_bx numeric,
--          abs_delta numeric, current_zone text, previous_zone text, sector text, price numeric,
--          market_cap_billions numeric, exchange text
CREATE VIEW public.bx_movers AS
 SELECT s.ticker,
    s.timeframe,
    s.bx,
    s.prev_bx,
    s.bx - s.prev_bx AS delta_bx,
    abs(s.bx - s.prev_bx) AS abs_delta,
        CASE
            WHEN s.bx > 2::numeric THEN 'bullish'::text
            WHEN s.bx < '-2'::integer::numeric THEN 'bearish'::text
            ELSE 'neutral'::text
        END AS current_zone,
        CASE
            WHEN s.prev_bx > 2::numeric THEN 'bullish'::text
            WHEN s.prev_bx < '-2'::integer::numeric THEN 'bearish'::text
            ELSE 'neutral'::text
        END AS previous_zone,
    m.sector,
    m.price,
    m.market_cap_billions,
    m.exchange
   FROM latest_scans s
     LEFT JOIN ticker_meta m USING (ticker)
  WHERE s.prev_bx IS NOT NULL;

-- ---------------------------------------------------------------------------
-- VIEW public.latest_scans   (security_invoker=true)
-- columns: id bigint, ticker text, timeframe text, bx numeric(6,2), prev_bx numeric(6,2),
--          scan_date date, created_at timestamp with time zone
-- NOTE: picks each ticker's newest row within a lookback window (14/45/100 days) of the
--   timeframe's max scan_date, so stale rows (older scan_date) are mixed in with fresh ones.
CREATE VIEW public.latest_scans AS
 SELECT DISTINCT ON (s.timeframe, s.ticker) s.id,
    s.ticker,
    s.timeframe,
    s.bx,
    s.prev_bx,
    s.scan_date,
    s.created_at
   FROM bx_scans s
     JOIN ( SELECT bx_scans.timeframe,
            max(bx_scans.scan_date) AS max_date
           FROM bx_scans
          GROUP BY bx_scans.timeframe) mx ON mx.timeframe = s.timeframe
  WHERE s.scan_date >= (mx.max_date -
        CASE s.timeframe
            WHEN 'daily'::text THEN '14 days'::interval
            WHEN 'weekly'::text THEN '45 days'::interval
            WHEN 'monthly'::text THEN '100 days'::interval
            ELSE '45 days'::interval
        END) AND (EXISTS ( SELECT 1
           FROM universe u
          WHERE u.ticker = s.ticker AND u.active))
  ORDER BY s.timeframe, s.ticker, s.scan_date DESC, s.created_at DESC;

-- ---------------------------------------------------------------------------
-- VIEW public.latest_scans_with_meta   (security_invoker=true)  -- main SPA table (App.jsx fetchScan)
-- columns (in order): ticker text, timeframe text, bx numeric(6,2), prev_bx numeric(6,2), scan_date date,
--          bias_direction text, bias_oscillator numeric, bias_in_zone boolean, exchange text,
--          market_cap_billions numeric, price numeric, avg_volume_millions numeric, sector text,
--          industry text, next_earnings_date date, days_to_earnings integer, fifty_two_week_high numeric,
--          fifty_two_week_low numeric, pct_of_52w_range numeric, alignment_score integer,
--          composite_bx numeric, daily_bx numeric, weekly_bx numeric, monthly_bx numeric
-- NOTE: days_to_earnings uses CURRENT_DATE (UTC on this server) and goes negative after the date passes.
-- PERF: EXPLAIN ANALYZE (timeframe='daily', as postgres) = 1,365 ms; anon statement_timeout = 3s.
CREATE VIEW public.latest_scans_with_meta AS
 SELECT s.ticker,
    s.timeframe,
    s.bx,
    s.prev_bx,
    s.scan_date,
    s.bias_direction,
    s.bias_oscillator,
    s.bias_in_zone,
    m.exchange,
    m.market_cap_billions,
    m.price,
    m.avg_volume_millions,
    m.sector,
    m.industry,
    m.next_earnings_date,
        CASE
            WHEN m.next_earnings_date IS NULL THEN NULL::integer
            ELSE m.next_earnings_date - CURRENT_DATE
        END AS days_to_earnings,
    m.fifty_two_week_high,
    m.fifty_two_week_low,
        CASE
            WHEN m.fifty_two_week_high > m.fifty_two_week_low AND m.price IS NOT NULL THEN round(100.0 * (m.price - m.fifty_two_week_low) / (m.fifty_two_week_high - m.fifty_two_week_low), 1)
            ELSE NULL::numeric
        END AS pct_of_52w_range,
    mtv.alignment_score,
    mtv.composite_bx,
    mtv.daily_bx,
    mtv.weekly_bx,
    mtv.monthly_bx
   FROM ( SELECT DISTINCT ON (b.timeframe, b.ticker) b.ticker,
            b.timeframe,
            b.bx,
            b.prev_bx,
            b.scan_date,
            b.bias_direction,
            b.bias_oscillator,
            b.bias_in_zone
           FROM bx_scans b
             JOIN ( SELECT bx_scans.timeframe,
                    max(bx_scans.scan_date) AS max_date
                   FROM bx_scans
                  GROUP BY bx_scans.timeframe) mx ON mx.timeframe = b.timeframe
          WHERE b.scan_date >= (mx.max_date -
                CASE b.timeframe
                    WHEN 'daily'::text THEN '14 days'::interval
                    WHEN 'weekly'::text THEN '45 days'::interval
                    WHEN 'monthly'::text THEN '100 days'::interval
                    ELSE '45 days'::interval
                END) AND (EXISTS ( SELECT 1
                   FROM universe u
                  WHERE u.ticker = b.ticker AND u.active))
          ORDER BY b.timeframe, b.ticker, b.scan_date DESC, b.created_at DESC) s
     LEFT JOIN ticker_meta m ON m.ticker = s.ticker
     LEFT JOIN multi_timeframe_view mtv ON mtv.ticker = s.ticker;

-- ---------------------------------------------------------------------------
-- VIEW public.multi_timeframe_view   (security_invoker=true)
-- columns: ticker text, daily_bx numeric, weekly_bx numeric, monthly_bx numeric,
--          alignment_score integer, composite_bx numeric
-- NOTE: composite_bx always divides by 6.0 (1+2+3) even when a timeframe is missing (COALESCE 0).
CREATE VIEW public.multi_timeframe_view AS
 SELECT ticker,
    max(
        CASE
            WHEN timeframe = 'daily'::text THEN bx
            ELSE NULL::numeric
        END) AS daily_bx,
    max(
        CASE
            WHEN timeframe = 'weekly'::text THEN bx
            ELSE NULL::numeric
        END) AS weekly_bx,
    max(
        CASE
            WHEN timeframe = 'monthly'::text THEN bx
            ELSE NULL::numeric
        END) AS monthly_bx,
    sum(
        CASE
            WHEN bx > 2::numeric THEN 1
            WHEN bx < '-2'::integer::numeric THEN '-1'::integer
            ELSE 0
        END)::integer AS alignment_score,
    round((COALESCE(max(
        CASE
            WHEN timeframe = 'daily'::text THEN bx
            ELSE NULL::numeric
        END), 0::numeric) * 1.0 + COALESCE(max(
        CASE
            WHEN timeframe = 'weekly'::text THEN bx
            ELSE NULL::numeric
        END), 0::numeric) * 2.0 + COALESCE(max(
        CASE
            WHEN timeframe = 'monthly'::text THEN bx
            ELSE NULL::numeric
        END), 0::numeric) * 3.0) / 6.0, 2) AS composite_bx
   FROM latest_scans
  GROUP BY ticker;

-- ---------------------------------------------------------------------------
-- VIEW public.scan_coverage_gaps   (security_invoker=true)
-- columns: ticker text, timeframe text, latest_run_date date, last_scanned date, reason text
CREATE VIEW public.scan_coverage_gaps AS
 SELECT u.ticker,
    tf.timeframe,
    mx.max_date AS latest_run_date,
    ev.last_scanned,
        CASE
            WHEN ev.last_scanned IS NULL THEN 'never_scanned'::text
            ELSE 'stale_or_dropped'::text
        END AS reason
   FROM universe u
     CROSS JOIN ( SELECT DISTINCT bx_scans.timeframe
           FROM bx_scans) tf
     LEFT JOIN ( SELECT bx_scans.timeframe,
            max(bx_scans.scan_date) AS max_date
           FROM bx_scans
          GROUP BY bx_scans.timeframe) mx ON mx.timeframe = tf.timeframe
     LEFT JOIN LATERAL ( SELECT max(b.scan_date) AS last_scanned
           FROM bx_scans b
          WHERE b.ticker = u.ticker AND b.timeframe = tf.timeframe) ev ON true
  WHERE u.active AND NOT (EXISTS ( SELECT 1
           FROM latest_scans ls
          WHERE ls.ticker = u.ticker AND ls.timeframe = tf.timeframe));

-- ---------------------------------------------------------------------------
-- VIEW public.sector_pulse   (security_invoker=true)
-- columns: sector text, timeframe text, ticker_count bigint, avg_bx numeric, bullish_count bigint,
--          bearish_count bigint, neutral_count bigint, pct_bullish numeric, pct_bearish numeric
CREATE VIEW public.sector_pulse AS
 SELECT m.sector,
    s.timeframe,
    count(*) AS ticker_count,
    round(avg(s.bx), 2) AS avg_bx,
    count(*) FILTER (WHERE s.bx > 2::numeric) AS bullish_count,
    count(*) FILTER (WHERE s.bx < '-2'::integer::numeric) AS bearish_count,
    count(*) FILTER (WHERE s.bx >= '-2'::integer::numeric AND s.bx <= 2::numeric) AS neutral_count,
    round(100.0 * count(*) FILTER (WHERE s.bx > 2::numeric)::numeric / NULLIF(count(*), 0)::numeric, 1) AS pct_bullish,
    round(100.0 * count(*) FILTER (WHERE s.bx < '-2'::integer::numeric)::numeric / NULLIF(count(*), 0)::numeric, 1) AS pct_bearish
   FROM latest_scans s
     JOIN ticker_meta m USING (ticker)
  WHERE m.sector IS NOT NULL
  GROUP BY m.sector, s.timeframe;

-- ---------------------------------------------------------------------------
-- VIEW public.zone_transitions   (security_invoker=true)  -- read by bx-alerter
-- columns: ticker text, timeframe text, bx numeric(6,2), prev_bx numeric(6,2), scan_date date,
--          current_zone text, previous_zone text
-- NOTE: bx-alerter reads a column named bx_previous_scan, which does NOT exist here (it is prev_bx).
CREATE VIEW public.zone_transitions AS
 SELECT ticker,
    timeframe,
    bx,
    prev_bx,
    scan_date,
        CASE
            WHEN bx > 2::numeric THEN 'bullish'::text
            WHEN bx < '-2'::integer::numeric THEN 'bearish'::text
            ELSE 'neutral'::text
        END AS current_zone,
        CASE
            WHEN prev_bx > 2::numeric THEN 'bullish'::text
            WHEN prev_bx < '-2'::integer::numeric THEN 'bearish'::text
            ELSE 'neutral'::text
        END AS previous_zone
   FROM latest_scans
  WHERE prev_bx IS NOT NULL AND
        CASE
            WHEN bx > 2::numeric THEN 'bullish'::text
            WHEN bx < '-2'::integer::numeric THEN 'bearish'::text
            ELSE 'neutral'::text
        END <>
        CASE
            WHEN prev_bx > 2::numeric THEN 'bullish'::text
            WHEN prev_bx < '-2'::integer::numeric THEN 'bearish'::text
            ELSE 'neutral'::text
        END;
