-- 25_advisors_perf.sql -- performance advisor fixes and index cleanup (unit "db").
--
-- Purpose
--   1. auth_rls_initplan (WARN x4): wrap auth.uid() as (select auth.uid()) in the profiles / saved_filters
--      policies so it is evaluated once per statement instead of once per row. Same semantics.
--   2. Redundant indexes on the two big tables (every upsert by bx-scan / bx-backtest-builder maintains them):
--      - idx_backtest_ticker (ticker): exact leading-column duplicate of the unique index
--        (ticker, timeframe, signal_type, signal_date), which also serves the C6 per-ticker delete
--        (ticker, timeframe) and the SPA's ticker+timeframe query.
--      - idx_backtest_tf (timeframe): 3 distinct values; superseded by bx_backtest_results_tf_computed_idx
--        (timeframe, computed_at DESC) from 21_views.sql.
--      - bx_scans_ticker_idx (ticker): leading-column duplicate of the unique index (ticker, timeframe, scan_date).
--      Kept: idx_backtest_signal (used by the summary matview refresh plan), idx_backtest_date (bx_backtest_ticker's
--      1-year filter), bx_scans_tf_date_idx (every latest-scan view; see 21_views.sql).
--   3. ANALYZE the tables whose contents/indexes changed in 20-24 so the planner sees the new state.
--   Performance evidence (EXPLAIN ANALYZE as role anon, statement_timeout 3 s, 2026-10-24, read-only):
--     latest_scans_with_meta?timeframe=eq.daily&order=scan_date.desc&limit=10000: 1,440 ms -> 156 ms
--     (per-timeframe max is an index probe; the lookback window an index range scan). pipeline_health and the
--     two matviews are index probes / precomputed.
--   Not changed, on purpose:
--     - unused_index (INFO) on tickers/quotes (legacy "Stock Edge" tables, 279 and 0 rows) and
--       saved_filters_user_id_idx (covers the saved_filters.user_id foreign key; dropping it would raise
--       unindexed_foreign_keys). No measurable benefit from dropping them.
--     - no_primary_key (INFO) on private.tradestation_tokens_bak_20261002: token-material backup owned by the
--       security unit (finding db-14 recommends dropping it); routed as a cross-unit request.
--
-- Findings: db-10 (perf), advisor lints auth_rls_initplan.
-- Must run after: 21_views.sql (bx_backtest_results_tf_computed_idx must exist before idx_backtest_tf goes) and
--   24_data_cleanup.sql (last file in the order).
-- Idempotent: guarded ALTER POLICY, DROP INDEX IF EXISTS. No secret values.
--
-- Rollback (run as postgres):
--   ALTER POLICY profiles_select_self ON public.profiles USING (auth.uid() = id);
--   ALTER POLICY profiles_insert_self ON public.profiles WITH CHECK (auth.uid() = id);
--   ALTER POLICY profiles_update_self ON public.profiles USING (auth.uid() = id);
--   ALTER POLICY saved_filters_all_own ON public.saved_filters USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
--   CREATE INDEX idx_backtest_ticker ON public.bx_backtest_results USING btree (ticker);
--   CREATE INDEX idx_backtest_tf ON public.bx_backtest_results USING btree (timeframe);
--   CREATE INDEX bx_scans_ticker_idx ON public.bx_scans USING btree (ticker);

-- ---------------------------------------------------------------------------------------------------------------
-- 1. auth_rls_initplan
DO $$
begin
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles_select_self') then
    alter policy profiles_select_self on public.profiles using ((select auth.uid()) = id);
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles_insert_self') then
    alter policy profiles_insert_self on public.profiles with check ((select auth.uid()) = id);
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles_update_self') then
    alter policy profiles_update_self on public.profiles using ((select auth.uid()) = id);
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'saved_filters' and policyname = 'saved_filters_all_own') then
    alter policy saved_filters_all_own on public.saved_filters
      using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Redundant indexes (each drop guarded by the presence of the index that replaces it).
DO $$
begin
  if exists (select 1 from pg_indexes where schemaname = 'public'
               and indexname = 'bx_backtest_results_ticker_timeframe_signal_type_signal_dat_key') then
    drop index if exists public.idx_backtest_ticker;
  end if;
  if to_regclass('public.bx_backtest_results_tf_computed_idx') is not null then
    drop index if exists public.idx_backtest_tf;
  end if;
  if exists (select 1 from pg_indexes where schemaname = 'public'
               and indexname = 'bx_scans_ticker_timeframe_scan_date_key') then
    drop index if exists public.bx_scans_ticker_idx;
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Fresh planner statistics.
ANALYZE public.bx_backtest_results;
ANALYZE public.bx_scans;
ANALYZE public.edge_call_log;
ANALYZE public.pipeline_runs;
ANALYZE public.bx_backtest_baseline;
