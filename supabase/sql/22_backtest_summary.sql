-- 22_backtest_summary.sql -- backtest summary matviews (unit "db").
--
-- Purpose
--   1. Re-create public.bx_backtest_summary as a MATERIALIZED VIEW (it must stay one: anon reads it and the base
--      table is 128 MB). Existing columns keep names, types and order; appended (C10): med_5d, med_20d, med_60d,
--      med_120d (the 'avg' token of avg_5d..avg_120d replaced by 'med'; med_60d duplicates the existing
--      median_60d on purpose) and last_computed_at timestamptz.                                   [db-7, fe-b-4]
--   2. Apply ONE documented bad-price/outlier rule to every statistic (averages, medians, win rate, counts):
--
--      BX outlier rule v1
--        a. A signal row is excluded from all statistics when price_at_signal < 1.00 (sub-$1 entry closes are
--           where the corrupt / unadjusted prints live: DFTX 0.01 -> 60 = +399,900 %, CHRD 0.11 -> 90.72,
--           GME 0.70 pre-split).
--        b. A single horizon return ret_Nd > +10000 % (a >101x move) is treated as a bad print and excluded for
--           that horizon only. With rule (a) applied, no current row exceeds it (max is 13,463 % monthly, ENPH
--           2017, a real move); it is a guard against new corrupt rows.
--        c. Only tickers ACTIVE in public.universe at refresh time. bx-backtest-builder (C6) rebuilds only the
--           active universe, so ~121k rows of inactive tickers (measured 2026-10-24: daily 61,935, weekly 32,962,
--           monthly 26,343) keep pre-C6 labels and the contaminated monthly cadence (quarterly/weekly bars under
--           'monthly'), and the baseline (also active-only) has no counterpart for them. The rows stay in the table
--           (per-ticker history in the SPA is unaffected); they just do not feed the summary. Caveat: both sides
--           therefore carry the same survivorship bias (today's listed names), so LIFT is consistent but absolute
--           averages lean optimistic.
--        n_signals = rows passing (a) and (c); n_with_60d = rows with an included 60-bar return.
--        bx-backtest-builder applies the same rule to public.bx_backtest_baseline (C6), so signal vs. baseline
--        lift is apples to apples. ret_* remain BAR offsets (5/20/60/120 bars of the timeframe).
--      Effect today (a+b+c, measured 2026-10-24 before the C6 rebuild): weekly bullish_to_bearish avg_60d
--      77.07 -> 20.38 (median 8.32, n 5,841); daily averages move by < 1 point. Body runs in ~0.8 s.
--   3. New MATERIALIZED VIEW public.bx_backtest_baseline_summary (C10): one row per timeframe with n_bars,
--      base_avg_5d / base_avg_20d / base_avg_60d / base_avg_120d, base_win_rate_60d_pct and computed_at, from
--      public.bx_backtest_baseline (which anon cannot read directly; a matview needs no RLS policy).
--   Both get a unique index (REFRESH ... CONCURRENTLY, used by the cron jobs in 23_cron_schedule.sql) and
--   read-only grants for anon/authenticated.
--
-- Findings: db-7, fe-b-4 (median + base rate surface; the SPA unit renders them).
-- Must run after: 20_pipeline_infra.sql (bx_backtest_baseline), 21_views.sql.
-- Idempotent: DROP MATERIALIZED VIEW IF EXISTS + CREATE (nothing depends on either matview; checked
--   pg_depend 2026-10-24). No secret values.
--
-- Rollback (run as postgres):
--   DROP MATERIALIZED VIEW IF EXISTS public.bx_backtest_baseline_summary;
--   DROP MATERIALIZED VIEW IF EXISTS public.bx_backtest_summary;
--   -- then re-create the old definition from supabase/snapshot/views.sql, plus:
--   CREATE UNIQUE INDEX bx_backtest_summary_pk ON public.bx_backtest_summary (timeframe, signal_type);
--   GRANT SELECT ON public.bx_backtest_summary TO anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 1 + 2. bx_backtest_summary
DROP MATERIALIZED VIEW IF EXISTS public.bx_backtest_summary;
CREATE MATERIALIZED VIEW public.bx_backtest_summary AS
 WITH r AS (
   -- BX outlier rule v1 (see header): (a) entry close >= 1.00, (b) per-horizon return <= +10000 %,
   -- (c) active tickers only.
   SELECT bx_backtest_results.timeframe,
      bx_backtest_results.signal_type,
      bx_backtest_results.computed_at,
      CASE WHEN bx_backtest_results.ret_5d   <= 10000::numeric THEN bx_backtest_results.ret_5d   END AS r5,
      CASE WHEN bx_backtest_results.ret_20d  <= 10000::numeric THEN bx_backtest_results.ret_20d  END AS r20,
      CASE WHEN bx_backtest_results.ret_60d  <= 10000::numeric THEN bx_backtest_results.ret_60d  END AS r60,
      CASE WHEN bx_backtest_results.ret_120d <= 10000::numeric THEN bx_backtest_results.ret_120d END AS r120
     FROM public.bx_backtest_results
    WHERE bx_backtest_results.price_at_signal >= 1.00
      AND (EXISTS ( SELECT 1
               FROM public.universe u
              WHERE u.ticker = bx_backtest_results.ticker AND u.active))
 )
 SELECT timeframe,
    signal_type,
    count(*) AS n_signals,
    count(r60) AS n_with_60d,
    round(avg(r5), 2) AS avg_5d,
    round(avg(r20), 2) AS avg_20d,
    round(avg(r60), 2) AS avg_60d,
    round(avg(r120), 2) AS avg_120d,
    round(percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (r60::double precision))::numeric, 2) AS median_60d,
    round(100.0 * count(*) FILTER (WHERE r60 > 0::numeric)::numeric / NULLIF(count(r60), 0)::numeric, 1) AS win_rate_60d_pct,
    round(percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (r5::double precision))::numeric, 2) AS med_5d,
    round(percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (r20::double precision))::numeric, 2) AS med_20d,
    round(percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (r60::double precision))::numeric, 2) AS med_60d,
    round(percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (r120::double precision))::numeric, 2) AS med_120d,
    max(computed_at) AS last_computed_at
   FROM r
  GROUP BY timeframe, signal_type;

CREATE UNIQUE INDEX bx_backtest_summary_pk ON public.bx_backtest_summary USING btree (timeframe, signal_type);
COMMENT ON MATERIALIZED VIEW public.bx_backtest_summary IS
  'Backtest stats per timeframe x signal_type. BX outlier rule v1: rows with price_at_signal < 1.00 excluded; any ret_Nd > 10000 excluded for that horizon; active universe tickers only (same universe as the baseline). ret_* are BAR offsets. Refreshed CONCURRENTLY by cron after the weekly builder run.';
ALTER MATERIALIZED VIEW public.bx_backtest_summary OWNER TO postgres;
REVOKE ALL ON public.bx_backtest_summary FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.bx_backtest_summary TO anon, authenticated;
GRANT SELECT ON public.bx_backtest_summary TO service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. bx_backtest_baseline_summary
DROP MATERIALIZED VIEW IF EXISTS public.bx_backtest_baseline_summary;
CREATE MATERIALIZED VIEW public.bx_backtest_baseline_summary AS
 SELECT timeframe,
    sum(n_bars)::bigint AS n_bars,
    round((sum(sum_ret_5)   / NULLIF(sum(n_ret_5), 0)::double precision)::numeric, 2)   AS base_avg_5d,
    round((sum(sum_ret_20)  / NULLIF(sum(n_ret_20), 0)::double precision)::numeric, 2)  AS base_avg_20d,
    round((sum(sum_ret_60)  / NULLIF(sum(n_ret_60), 0)::double precision)::numeric, 2)  AS base_avg_60d,
    round((sum(sum_ret_120) / NULLIF(sum(n_ret_120), 0)::double precision)::numeric, 2) AS base_avg_120d,
    round(100.0 * sum(wins_60)::numeric / NULLIF(sum(n_ret_60), 0)::numeric, 1)         AS base_win_rate_60d_pct,
    max(computed_at) AS computed_at
   FROM public.bx_backtest_baseline
  WHERE (EXISTS ( SELECT 1
           FROM public.universe u
          WHERE u.ticker = bx_backtest_baseline.ticker AND u.active))   -- same universe as bx_backtest_summary (c)
  GROUP BY timeframe;

CREATE UNIQUE INDEX bx_backtest_baseline_summary_pk ON public.bx_backtest_baseline_summary USING btree (timeframe);
COMMENT ON MATERIALIZED VIEW public.bx_backtest_baseline_summary IS
  'Unconditional forward returns over every completed bar (active universe tickers) per timeframe = the base rate for bx_backtest_summary. Same return definition, outlier rule v1 and universe. Refreshed CONCURRENTLY by cron right after bx_backtest_summary.';
ALTER MATERIALIZED VIEW public.bx_backtest_baseline_summary OWNER TO postgres;
REVOKE ALL ON public.bx_backtest_baseline_summary FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.bx_backtest_baseline_summary TO anon, authenticated;
GRANT SELECT ON public.bx_backtest_baseline_summary TO service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- Self-check (raises -> the whole migration rolls back).
DO $$
declare
  t text;
begin
  foreach t in array array['bx_backtest_summary', 'bx_backtest_baseline_summary'] loop
    if (select relkind from pg_class where oid = format('public.%I', t)::regclass) <> 'm' then
      raise exception '22_backtest_summary self-check: public.% is not a materialized view', t;
    end if;
    if not has_table_privilege('anon', format('public.%I', t), 'SELECT')
       or has_table_privilege('anon', format('public.%I', t), 'INSERT,UPDATE,DELETE,TRUNCATE') then
      raise exception '22_backtest_summary self-check: wrong anon privileges on public.%', t;
    end if;
  end loop;
  if (select string_agg(attname, ',' order by attnum) from pg_attribute
       where attrelid = 'public.bx_backtest_summary'::regclass and attnum > 0 and not attisdropped)
     <> 'timeframe,signal_type,n_signals,n_with_60d,avg_5d,avg_20d,avg_60d,avg_120d,median_60d,win_rate_60d_pct,med_5d,med_20d,med_60d,med_120d,last_computed_at' then
    raise exception '22_backtest_summary self-check: bx_backtest_summary column order changed';
  end if;
  if not exists (select 1 from public.bx_backtest_summary) then
    raise exception '22_backtest_summary self-check: bx_backtest_summary is empty';
  end if;
end
$$;
