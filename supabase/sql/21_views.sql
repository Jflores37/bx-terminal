-- 21_views.sql -- BX Terminal views consumed by the SPA and the alerter (unit "db").
--
-- Purpose (contract C10 / C4; existing columns keep names, types and order, new columns are appended at the END)
--   1. latest_scans: same rows/columns. The per-timeframe max(scan_date) is now an index probe and the lookback
--      window an index range scan (LATERAL), so cost follows the window size instead of the whole bx_scans table.
--      Every SPA view below builds on it.                                                                  [db-10]
--   2. latest_scans_with_meta: same faster latest-row logic; days_to_earnings is computed against the
--      America/New_York date (CURRENT_DATE is UTC here, so it was off by one every evening) and is NULL once the
--      stored date has passed; appended is_stale, max_scan_date, earnings_stale.              [db-11, db-1, db-10]
--   3. multi_timeframe_view: composite_bx divides by the weights of the PRESENT timeframes only (1/2/3 for
--      daily/weekly/monthly); a missing timeframe no longer counts as bx = 0.                              [db-12]
--   4. bx_movers: only rows at the timeframe's max scan_date (fresh deltas only); appended scan_date.      [fe-a-5]
--   5. public.pipeline_health (C4): anon-readable status rows (check_name, timeframe, status ok|warn|error, detail,
--      as_of). Built on private.pipeline_health_rows() (SECURITY DEFINER, owner postgres, no arguments, returns
--      only counts/dates/statuses -- never error text, params or response bodies) because edge_call_log /
--      pipeline_runs / bx_backtest_baseline stay closed to anon. The view itself is security_invoker like every
--      other view here; anon needs SELECT on the view + EXECUTE on that one function.  [db-2, db-1, db-4, db-9]
--      Checks: scan coverage per timeframe at its max scan_date vs the active tickers that have ANY scan row for
--      that timeframe (warn < 98 %, error < 90 %; reported 'ok ... in progress' while that timeframe's cron window
--      is open). Active tickers never scanned for a timeframe (bx-scan skips < 40 completed bars, i.e. recent
--      listings, mostly monthly/weekly; or a ticker added after the last weekly/monthly run) are left out of the
--      ratio and counted in detail instead, so universe churn and short histories do not hold weekly/monthly at
--      'warn' forever; a ticker that WAS scanned and then went missing still counts against coverage. Only rows
--      dated the way the current bx-scan labels periods count as "scanned" (legacy weekly/monthly rows from the old
--      Yahoo range=max call are not), once a current-format scan of that timeframe exists. Then:
--      scan freshness per timeframe vs the last completed period the schedule should have scanned; backtest last
--      computed_at per timeframe (warn > 8 days, error > 15 days); failed / unanswered edge calls in the last 24 h per function
--      (edge_call_log); last ok/partial pipeline_runs per cron function. Times inside detail are 12-hour ET.
--      The cron windows/times used here mirror 23_cron_schedule.sql -- keep them in sync.
--   6. Index bx_backtest_results (timeframe, computed_at DESC) so the backtest-freshness check is an index probe
--      (anon statement_timeout is 3 s). Created FIRST, before any view is replaced, so the AccessExclusive view
--      locks (held to commit) are not held while the index builds.
--   7. sector_pulse: same columns; only rows at the timeframe's max scan_date (same rule as bx_movers), so sector
--      counts / avg_bx no longer mix in tickers whose last row is from an older scan.        [fe-a-5 class]
--   8. zone_transitions (read by bx-alerter): same columns; only rows at the timeframe's max scan_date, so an old
--      transition from the lookback window is never re-announced (bx-alerter also filters in code).  [fe-a-5 class]
--
-- Findings: db-10, db-11, db-12, fe-a-5, plus the C4 health surface for db-1, db-2, db-4, db-9.
-- Must run after: 20_pipeline_infra.sql (edge_call_log, pipeline_runs, bx_backtest_baseline must exist).
-- Idempotent: CREATE OR REPLACE VIEW / FUNCTION, CREATE INDEX IF NOT EXISTS. No secret values.
--
-- Rollback (run as postgres): re-create the six views (latest_scans, multi_timeframe_view, latest_scans_with_meta,
--   bx_movers, sector_pulse, zone_transitions) from supabase/snapshot/views.sql (CREATE OR REPLACE VIEW ... WITH
--   (security_invoker = true) for the four whose columns did not change). CREATE OR REPLACE cannot
--   drop the appended columns, so for latest_scans_with_meta and bx_movers first
--   DROP VIEW public.latest_scans_with_meta; DROP VIEW public.bx_movers;   (nothing depends on either)
--   then CREATE VIEW ... WITH (security_invoker = true) AS <snapshot body>; and re-grant SELECT to anon, authenticated.
--   DROP VIEW IF EXISTS public.pipeline_health; DROP FUNCTION IF EXISTS private.pipeline_health_rows();
--   DROP INDEX IF EXISTS public.bx_backtest_results_tf_computed_idx;

-- ---------------------------------------------------------------------------------------------------------------
-- 6. Index for the backtest-freshness check (also supersedes idx_backtest_tf; dropped in 25_advisors_perf.sql).
--    First statement on purpose: built before the view replacements below take their AccessExclusive locks.
CREATE INDEX IF NOT EXISTS bx_backtest_results_tf_computed_idx
  ON public.bx_backtest_results (timeframe, computed_at DESC);

-- ---------------------------------------------------------------------------------------------------------------
-- 1. latest_scans (same output; faster plan)
CREATE OR REPLACE VIEW public.latest_scans WITH (security_invoker = true) AS
 SELECT DISTINCT ON (s.timeframe, s.ticker) s.id,
    s.ticker,
    s.timeframe,
    s.bx,
    s.prev_bx,
    s.scan_date,
    s.created_at
   FROM ( VALUES ('daily'::text, 14), ('weekly'::text, 45), ('monthly'::text, 100)) w(timeframe, lookback_days)
     CROSS JOIN LATERAL ( SELECT max(b.scan_date) AS max_date
           FROM public.bx_scans b
          WHERE b.timeframe = w.timeframe) mx
     CROSS JOIN LATERAL ( SELECT b.id, b.ticker, b.timeframe, b.bx, b.prev_bx, b.scan_date, b.created_at
           FROM public.bx_scans b
          WHERE b.timeframe = w.timeframe AND b.scan_date >= (mx.max_date - w.lookback_days)) s
  WHERE (EXISTS ( SELECT 1
           FROM public.universe u
          WHERE u.ticker = s.ticker AND u.active))
  ORDER BY s.timeframe, s.ticker, s.scan_date DESC, s.created_at DESC;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. multi_timeframe_view (before latest_scans_with_meta, which reads it)
CREATE OR REPLACE VIEW public.multi_timeframe_view WITH (security_invoker = true) AS
 SELECT t.ticker,
    t.daily_bx,
    t.weekly_bx,
    t.monthly_bx,
    t.alignment_score,
    round((COALESCE(t.daily_bx, 0::numeric) * 1.0 + COALESCE(t.weekly_bx, 0::numeric) * 2.0
           + COALESCE(t.monthly_bx, 0::numeric) * 3.0)
          / NULLIF(CASE WHEN t.daily_bx IS NULL THEN 0 ELSE 1 END
                   + CASE WHEN t.weekly_bx IS NULL THEN 0 ELSE 2 END
                   + CASE WHEN t.monthly_bx IS NULL THEN 0 ELSE 3 END, 0)::numeric, 2) AS composite_bx
   FROM ( SELECT latest_scans.ticker,
            max(
                CASE
                    WHEN latest_scans.timeframe = 'daily'::text THEN latest_scans.bx
                    ELSE NULL::numeric
                END) AS daily_bx,
            max(
                CASE
                    WHEN latest_scans.timeframe = 'weekly'::text THEN latest_scans.bx
                    ELSE NULL::numeric
                END) AS weekly_bx,
            max(
                CASE
                    WHEN latest_scans.timeframe = 'monthly'::text THEN latest_scans.bx
                    ELSE NULL::numeric
                END) AS monthly_bx,
            sum(
                CASE
                    WHEN latest_scans.bx > 2::numeric THEN 1
                    WHEN latest_scans.bx < '-2'::integer::numeric THEN '-1'::integer
                    ELSE 0
                END)::integer AS alignment_score
           FROM public.latest_scans
          GROUP BY latest_scans.ticker) t;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. latest_scans_with_meta
CREATE OR REPLACE VIEW public.latest_scans_with_meta WITH (security_invoker = true) AS
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
            WHEN m.next_earnings_date IS NULL OR m.next_earnings_date < ny.today THEN NULL::integer
            ELSE m.next_earnings_date - ny.today
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
    mtv.monthly_bx,
    s.scan_date < s.max_date AS is_stale,
    s.max_date AS max_scan_date,
    COALESCE(m.next_earnings_date < ny.today, false) AS earnings_stale
   FROM ( SELECT DISTINCT ON (b.timeframe, b.ticker) b.ticker,
            b.timeframe,
            b.bx,
            b.prev_bx,
            b.scan_date,
            b.bias_direction,
            b.bias_oscillator,
            b.bias_in_zone,
            mx.max_date
           FROM ( VALUES ('daily'::text, 14), ('weekly'::text, 45), ('monthly'::text, 100)) w(timeframe, lookback_days)
             CROSS JOIN LATERAL ( SELECT max(x.scan_date) AS max_date
                   FROM public.bx_scans x
                  WHERE x.timeframe = w.timeframe) mx
             CROSS JOIN LATERAL ( SELECT x.ticker, x.timeframe, x.bx, x.prev_bx, x.scan_date, x.bias_direction,
                    x.bias_oscillator, x.bias_in_zone, x.created_at
                   FROM public.bx_scans x
                  WHERE x.timeframe = w.timeframe AND x.scan_date >= (mx.max_date - w.lookback_days)) b
          WHERE (EXISTS ( SELECT 1
                   FROM public.universe u
                  WHERE u.ticker = b.ticker AND u.active))
          ORDER BY b.timeframe, b.ticker, b.scan_date DESC, b.created_at DESC) s
     CROSS JOIN ( SELECT (now() AT TIME ZONE 'America/New_York'::text)::date AS today) ny
     LEFT JOIN public.ticker_meta m ON m.ticker = s.ticker
     LEFT JOIN public.multi_timeframe_view mtv ON mtv.ticker = s.ticker;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. bx_movers: fresh deltas only
CREATE OR REPLACE VIEW public.bx_movers WITH (security_invoker = true) AS
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
    m.exchange,
    s.scan_date
   FROM public.latest_scans s
     LEFT JOIN public.ticker_meta m USING (ticker)
  WHERE s.prev_bx IS NOT NULL
    AND s.scan_date = (( SELECT max(b.scan_date) AS max
           FROM public.bx_scans b
          WHERE b.timeframe = s.timeframe));

-- ---------------------------------------------------------------------------------------------------------------
-- 7. sector_pulse: fresh rows only (same columns)
CREATE OR REPLACE VIEW public.sector_pulse WITH (security_invoker = true) AS
 SELECT m.sector,
    s.timeframe,
    count(*) AS ticker_count,
    round(avg(s.bx), 2) AS avg_bx,
    count(*) FILTER (WHERE s.bx > 2::numeric) AS bullish_count,
    count(*) FILTER (WHERE s.bx < '-2'::integer::numeric) AS bearish_count,
    count(*) FILTER (WHERE s.bx >= '-2'::integer::numeric AND s.bx <= 2::numeric) AS neutral_count,
    round(100.0 * count(*) FILTER (WHERE s.bx > 2::numeric)::numeric / NULLIF(count(*), 0)::numeric, 1) AS pct_bullish,
    round(100.0 * count(*) FILTER (WHERE s.bx < '-2'::integer::numeric)::numeric / NULLIF(count(*), 0)::numeric, 1) AS pct_bearish
   FROM public.latest_scans s
     JOIN public.ticker_meta m USING (ticker)
  WHERE m.sector IS NOT NULL
    AND s.scan_date = (( SELECT max(b.scan_date) AS max
           FROM public.bx_scans b
          WHERE b.timeframe = s.timeframe))
  GROUP BY m.sector, s.timeframe;

-- ---------------------------------------------------------------------------------------------------------------
-- 8. zone_transitions: fresh rows only (same columns; read by bx-alerter)
CREATE OR REPLACE VIEW public.zone_transitions WITH (security_invoker = true) AS
 SELECT s.ticker,
    s.timeframe,
    s.bx,
    s.prev_bx,
    s.scan_date,
        CASE
            WHEN s.bx > 2::numeric THEN 'bullish'::text
            WHEN s.bx < '-2'::integer::numeric THEN 'bearish'::text
            ELSE 'neutral'::text
        END AS current_zone,
        CASE
            WHEN s.prev_bx > 2::numeric THEN 'bullish'::text
            WHEN s.prev_bx < '-2'::integer::numeric THEN 'bearish'::text
            ELSE 'neutral'::text
        END AS previous_zone
   FROM public.latest_scans s
  WHERE s.prev_bx IS NOT NULL
    AND s.scan_date = (( SELECT max(b.scan_date) AS max
           FROM public.bx_scans b
          WHERE b.timeframe = s.timeframe))
    AND
        CASE
            WHEN s.bx > 2::numeric THEN 'bullish'::text
            WHEN s.bx < '-2'::integer::numeric THEN 'bearish'::text
            ELSE 'neutral'::text
        END <>
        CASE
            WHEN s.prev_bx > 2::numeric THEN 'bullish'::text
            WHEN s.prev_bx < '-2'::integer::numeric THEN 'bearish'::text
            ELSE 'neutral'::text
        END;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. pipeline_health (C4)
CREATE OR REPLACE FUNCTION private.pipeline_health_rows()
 RETURNS TABLE(check_name text, timeframe text, status text, detail text, as_of timestamptz)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
WITH clk AS (
  SELECT now() AS ts,
         (now() AT TIME ZONE 'UTC') AS utc,
         (now() AT TIME ZONE 'UTC')::date AS d,
         (now() AT TIME ZONE 'UTC')::time AS t,
         extract(isodow FROM (now() AT TIME ZONE 'UTC'))::int AS dow
),
act AS (SELECT count(*)::int AS n FROM public.universe WHERE active),
tf AS (
  SELECT w.timeframe, w.ord, mx.max_date, lb.cur,
         ( SELECT count(*)::int
             FROM public.bx_scans b
             JOIN public.universe u ON u.ticker = b.ticker AND u.active
            WHERE b.timeframe = w.timeframe AND b.scan_date = mx.max_date) AS n_rows,
         -- coverage denominator: active tickers with a row for this timeframe that the current bx-scan can produce
         -- (see header, item 5). Current labels are the period's last trading day: daily Mon-Fri, weekly Wed-Fri,
         -- monthly a weekday on day >= 26. Legacy rows (weekly on Sundays plus one Tuesday 5/12 batch, monthly on
         -- day 1 / 5/12 / Saturday 4/25) never match, so short-history tickers that only the old Yahoo range=max
         -- call could label drop out. Until the first current-format scan of a timeframe exists (lb.cur = false),
         -- any row counts, as before. Known gap: right after that first weekly/monthly scan the denominator is that
         -- scan's own ticker set, so a ticker it missed only counts from the next period on (last_run rows show it).
         ( SELECT count(*)::int
             FROM public.universe u
            WHERE u.active
              AND EXISTS ( SELECT 1 FROM public.bx_scans b
                            WHERE b.ticker = u.ticker AND b.timeframe = w.timeframe
                              AND (NOT lb.cur OR CASE w.timeframe
                                     WHEN 'daily' THEN extract(isodow FROM b.scan_date) BETWEEN 1 AND 5
                                     WHEN 'weekly' THEN extract(isodow FROM b.scan_date) BETWEEN 3 AND 5
                                     ELSE extract(isodow FROM b.scan_date) BETWEEN 1 AND 5 AND extract(day FROM b.scan_date) >= 26
                                   END))) AS n_hist
    FROM ( VALUES ('daily'::text, 1), ('weekly'::text, 2), ('monthly'::text, 3)) w(timeframe, ord)
    CROSS JOIN LATERAL ( SELECT max(b.scan_date) AS max_date FROM public.bx_scans b WHERE b.timeframe = w.timeframe) mx
    CROSS JOIN LATERAL ( SELECT coalesce(CASE w.timeframe
                                  WHEN 'daily' THEN extract(isodow FROM mx.max_date) BETWEEN 1 AND 5
                                  WHEN 'weekly' THEN extract(isodow FROM mx.max_date) BETWEEN 3 AND 5
                                  ELSE extract(isodow FROM mx.max_date) BETWEEN 1 AND 5 AND extract(day FROM mx.max_date) >= 26
                                END, false) AS cur) lb
),
-- Expected latest scan_date per timeframe = the last completed period whose cron window has closed (UTC, see
-- 23_cron_schedule.sql): daily window Mon-Fri 21:20-22:15 UTC (closes 22:20); weekly Sunday 14:00-14:55 (closes
-- 15:00); monthly the 1st 11:00-11:55 (closes 12:00). ok_from = newest acceptable date, warn_from = one period late.
ex AS (
  SELECT tf.*,
         CASE tf.timeframe
           WHEN 'daily' THEN (c.dow BETWEEN 1 AND 5 AND c.t >= time '21:15' AND c.t < time '22:20')
           WHEN 'weekly' THEN (c.dow = 7 AND c.t >= time '13:55' AND c.t < time '15:00')
           ELSE (extract(day FROM c.d) = 1 AND c.t >= time '10:55' AND c.t < time '12:00')
         END AS in_window,
         CASE tf.timeframe
           WHEN 'daily' THEN dly.expected
           WHEN 'weekly' THEN wk.fri - 2        -- Wednesday or later (lenient; covers a Friday holiday)
           ELSE mo.month_end - 3                -- last trading day is at most 3 days before month end
         END AS ok_from,
         CASE tf.timeframe
           WHEN 'daily' THEN dly.expected - CASE extract(isodow FROM dly.expected)::int WHEN 1 THEN 3 ELSE 1 END
           WHEN 'weekly' THEN wk.fri - 9
           ELSE (date_trunc('month', mo.month_end::timestamp)::date - 1) - 3
         END AS warn_from,
         CASE tf.timeframe
           WHEN 'daily' THEN dly.expected
           WHEN 'weekly' THEN wk.fri
           ELSE mo.month_end
         END AS expected
    FROM tf
    CROSS JOIN clk c
    CROSS JOIN LATERAL ( SELECT d0 - CASE extract(isodow FROM d0)::int WHEN 6 THEN 1 WHEN 7 THEN 2 ELSE 0 END AS expected
                           FROM ( SELECT c.d - CASE WHEN c.t < time '22:20' THEN 1 ELSE 0 END AS d0) z) dly
    CROSS JOIN LATERAL ( SELECT (c.d - (c.dow % 7) - CASE WHEN c.dow = 7 AND c.t < time '15:00' THEN 7 ELSE 0 END) - 2 AS fri) wk
    CROSS JOIN LATERAL ( SELECT date_trunc('month', (c.d - CASE WHEN extract(day FROM c.d) = 1 AND c.t < time '12:00'
                                                            THEN 1 ELSE 0 END)::timestamp)::date - 1 AS month_end) mo
),
coverage AS (
  SELECT 'scan_coverage'::text AS check_name, ex.timeframe, ex.ord,
         CASE
           WHEN ex.max_date IS NULL OR a.n = 0 OR ex.n_hist = 0 THEN 'error'
           WHEN ex.n_rows >= 0.98 * ex.n_hist THEN 'ok'
           WHEN ex.in_window AND ex.max_date > ex.expected THEN 'ok'   -- today's chunks/fills still running
           WHEN ex.n_rows >= 0.90 * ex.n_hist THEN 'warn'
           ELSE 'error'
         END AS status,
         CASE WHEN ex.max_date IS NULL THEN format('no %s scans at all', ex.timeframe)
              ELSE format('%s of %s active tickers with %s history scanned for %s (%s%%)%s%s', ex.n_rows, ex.n_hist,
                          ex.timeframe, to_char(ex.max_date, 'FMMM/FMDD/YYYY'),
                          round(100.0 * ex.n_rows / NULLIF(ex.n_hist, 0), 1),
                          CASE WHEN a.n > ex.n_hist
                               THEN format('; %s active never scanned%s (new, or < 40 completed bars)', a.n - ex.n_hist,
                                           CASE WHEN ex.cur THEN ' by the current scanner' ELSE '' END) ELSE '' END,
                          CASE WHEN ex.in_window AND ex.max_date > ex.expected THEN '; scan in progress' ELSE '' END)
         END AS detail,
         (ex.max_date + time '16:00') AT TIME ZONE 'America/New_York' AS as_of
    FROM ex CROSS JOIN act a
),
freshness AS (
  SELECT 'scan_freshness'::text, ex.timeframe, ex.ord,
         CASE
           WHEN ex.max_date IS NULL THEN 'error'
           WHEN ex.max_date >= ex.ok_from THEN 'ok'
           WHEN ex.max_date >= ex.warn_from THEN 'warn'
           ELSE 'error'
         END,
         format('latest %s scan is for %s; expected %s%s', ex.timeframe,
                coalesce(to_char(ex.max_date, 'FMMM/FMDD/YYYY'), 'none'),
                to_char(ex.expected, 'FMMM/FMDD/YYYY'),
                CASE WHEN ex.timeframe = 'daily' AND ex.max_date < ex.ok_from AND ex.max_date >= ex.warn_from
                     THEN ' (1 session behind; market holiday?)' ELSE '' END),
         (ex.max_date + time '16:00') AT TIME ZONE 'America/New_York'
    FROM ex
),
backtest AS (
  SELECT 'backtest_freshness'::text, w.timeframe, w.ord,
         CASE
           WHEN bt.last_at IS NULL THEN 'error'
           WHEN bt.last_at < now() - interval '15 days' THEN 'error'
           WHEN bt.last_at < now() - interval '8 days' THEN 'warn'
           ELSE 'ok'
         END,
         CASE WHEN bt.last_at IS NULL THEN format('no %s backtest results', w.timeframe)
              ELSE format('%s backtest last computed %s ET (%s days ago)', w.timeframe,
                          to_char(bt.last_at AT TIME ZONE 'America/New_York', 'FMMM/FMDD/YYYY FMHH12:MI AM'),
                          floor(extract(epoch FROM now() - bt.last_at) / 86400)::int)
         END,
         bt.last_at
    FROM ( VALUES ('daily'::text, 1), ('weekly'::text, 2), ('monthly'::text, 3)) w(timeframe, ord)
    CROSS JOIN LATERAL (
      SELECT GREATEST(
               ( SELECT max(r.computed_at) FROM public.bx_backtest_results r WHERE r.timeframe = w.timeframe),
               ( SELECT max(bl.computed_at) FROM public.bx_backtest_baseline bl WHERE bl.timeframe = w.timeframe)
             ) AS last_at) bt
),
calls AS (
  SELECT 'edge_calls_24h:' || l.fn, NULL::text, 10,
         CASE
           WHEN count(*) FILTER (WHERE l.ok IS FALSE) = 0
                AND count(*) FILTER (WHERE l.completed_at IS NULL AND l.enqueued_at < now() - interval '30 minutes') = 0
             THEN 'ok'
           WHEN count(*) FILTER (WHERE l.ok) = 0 AND count(*) FILTER (WHERE l.ok IS FALSE) > 0 THEN 'error'
           ELSE 'warn'
         END,
         format('%s: %s of %s calls failed in the last 24 h%s%s', l.fn,
                count(*) FILTER (WHERE l.ok IS FALSE), count(*),
                CASE WHEN count(*) FILTER (WHERE l.ok IS FALSE) > 0
                     THEN format(' (last: %s at %s ET)',
                                 coalesce('HTTP ' || ((array_agg(l.status_code ORDER BY l.enqueued_at DESC)
                                                       FILTER (WHERE l.ok IS FALSE))[1])::text, 'no response'),
                                 to_char(max(l.enqueued_at) FILTER (WHERE l.ok IS FALSE) AT TIME ZONE 'America/New_York',
                                         'FMMM/FMDD FMHH12:MI AM'))
                     ELSE '' END,
                CASE WHEN count(*) FILTER (WHERE l.completed_at IS NULL AND l.enqueued_at < now() - interval '30 minutes') > 0
                     THEN format('; %s with no result after 30 min',
                                 count(*) FILTER (WHERE l.completed_at IS NULL AND l.enqueued_at < now() - interval '30 minutes'))
                     ELSE '' END),
         max(coalesce(l.completed_at, l.enqueued_at))
    FROM public.edge_call_log l
   WHERE l.enqueued_at > now() - interval '24 hours'
   GROUP BY l.fn
),
runs AS (
  SELECT 'last_run:' || f.fn, NULL::text, 20,
         CASE
           WHEN ok.last_ok IS NULL THEN 'warn'
           WHEN ok.last_ok < now() - make_interval(hours => f.error_h) THEN 'error'
           WHEN ok.last_ok < now() - make_interval(hours => f.warn_h) THEN 'warn'
           WHEN lr.status = 'error' THEN 'warn'   -- bx-scan fill passes report 'partial', not 'error', when only
           ELSE 'ok'                              -- unscannable tickers were left (bx-scan/index.ts, run status)
         END,
         format('%s: %s%s', f.fn,
                CASE WHEN ok.last_ok IS NULL THEN 'no successful run recorded yet'
                     ELSE 'last successful run finished ' ||
                          to_char(ok.last_ok AT TIME ZONE 'America/New_York', 'FMMM/FMDD FMHH12:MI AM') || ' ET' END,
                CASE WHEN lr.status IS NULL THEN ''
                     ELSE format('; latest run %s at %s ET%s', lr.status,
                                 to_char(lr.started_at AT TIME ZONE 'America/New_York', 'FMMM/FMDD FMHH12:MI AM'),
                                 CASE WHEN lr.rows_written IS NOT NULL OR lr.rows_expected IS NOT NULL
                                      THEN format(' (%s of %s rows)', coalesce(lr.rows_written::text, '?'),
                                                  coalesce(lr.rows_expected::text, '?'))
                                      ELSE '' END)
                END),
         ok.last_ok
    FROM ( VALUES ('bx-scan'::text, 96, 168), ('bx-alerter'::text, 96, 168), ('bx-finviz-sync'::text, 96, 168),
                  ('bx-exchange-backfill'::text, 96, 168), ('bx-earnings-sync'::text, 120, 360),
                  ('bx-backtest-builder'::text, 192, 360)) f(fn, warn_h, error_h)
    LEFT JOIN LATERAL ( SELECT max(r.finished_at) AS last_ok
                          FROM public.pipeline_runs r
                         WHERE r.fn = f.fn AND r.status IN ('ok', 'partial')) ok ON true
    LEFT JOIN LATERAL ( SELECT r.status, r.started_at, r.rows_written, r.rows_expected
                          FROM public.pipeline_runs r
                         WHERE r.fn = f.fn
                         ORDER BY r.started_at DESC
                         LIMIT 1) lr ON true
),
allrows AS (
  SELECT * FROM coverage
  UNION ALL SELECT * FROM freshness
  UNION ALL SELECT * FROM backtest
  UNION ALL SELECT * FROM calls
  UNION ALL SELECT * FROM runs
)
SELECT a.check_name, a.timeframe, a.status, a.detail, a.as_of
  FROM allrows a
 ORDER BY CASE a.status WHEN 'error' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, a.check_name, a.ord;
$function$;
ALTER FUNCTION private.pipeline_health_rows() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.pipeline_health_rows() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.pipeline_health_rows() TO anon, authenticated, service_role;
COMMENT ON FUNCTION private.pipeline_health_rows() IS
  'Backs public.pipeline_health (C4). SECURITY DEFINER on purpose: anon may read these aggregates but not edge_call_log / pipeline_runs / bx_backtest_baseline. No arguments; returns no error text, params or response bodies.';

CREATE OR REPLACE VIEW public.pipeline_health WITH (security_invoker = true) AS
 SELECT h.check_name,
    h.timeframe,
    h.status,
    h.detail,
    h.as_of
   FROM private.pipeline_health_rows() h(check_name, timeframe, status, detail, as_of);
COMMENT ON VIEW public.pipeline_health IS
  'C4 pipeline health for the SPA banner: one row per check, status ok|warn|error. No secrets.';
REVOKE ALL ON public.pipeline_health FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.pipeline_health TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- Grants on the replaced views are preserved by CREATE OR REPLACE; re-assert read-only access for the SPA roles.
GRANT SELECT ON public.latest_scans, public.multi_timeframe_view, public.latest_scans_with_meta, public.bx_movers,
  public.sector_pulse TO anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- Self-check (raises -> the whole migration rolls back).
DO $$
declare
  t text;
begin
  foreach t in array array['latest_scans', 'multi_timeframe_view', 'latest_scans_with_meta', 'bx_movers', 'sector_pulse',
                           'pipeline_health'] loop
    if not has_table_privilege('anon', format('public.%I', t), 'SELECT') then
      raise exception '21_views self-check: anon cannot SELECT public.%', t;
    end if;
    if not coalesce((select 'security_invoker=true' = any(reloptions) from pg_class where oid = format('public.%I', t)::regclass), false) then
      raise exception '21_views self-check: public.% is not security_invoker', t;
    end if;
  end loop;
  if has_table_privilege('anon', 'public.pipeline_health', 'INSERT,UPDATE,DELETE,TRUNCATE') then
    raise exception '21_views self-check: anon has write privileges on pipeline_health';
  end if;
  perform 1 from public.pipeline_health limit 1;   -- function body executes without error
end
$$;
