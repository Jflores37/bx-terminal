-- 40_edge_math.sql -- back up every pre-v5 bx_backtest_results row before the v5 builder's first write (unit "edge-math").
--
-- Purpose: bx-backtest-builder v5 (C6) deletes, per rebuilt ticker+timeframe, every stored row it does not reproduce
--   that is either inside its rebuilt window or pre-v5 (computed_at < V5_EPOCH = 2026-10-24 00:00 UTC) outside it.
--   On the first full rebuild that removes, for active tickers, the Monday-keyed weekly rows (relabeled to the week's
--   last trading day), day-1 monthly rows (relabeled to the month's last trading day), quarterly/weekly-cadence rows
--   stored as monthly, and the daily rows older than v5's window (2024-07..2024-12, outside Yahoo's 2y daily range:
--   neither v5 nor v4 can regenerate them). It also covers a valid-but-truncated Yahoo history moving the window
--   forward. This file copies ALL pre-v5 rows (measured 2026-10-24: 308,920 = every row; daily 147,094 incl. 45,603
--   dated before 2024-12-16, weekly 102,395 incl. 101,659 on Mondays, monthly 59,431) to
--   private.bx_backtest_results_pre_v5_bak, so every delete the rebuild makes is recoverable.
--   Size: heap ~66 MB + PK (no secondary indexes); DB was 163 MB of the free plan's 500 MB.
--   Self-check: raises (and the transaction rolls back) unless every public pre-v5 row is in the backup.
--
-- Findings: em-4/em-5/em-9 data side (C6 stale-key delete); round-2 safety review (backup + rollback for the first
--   full rebuild).
-- Must run after: the step-0 gate (max(computed_at) < 2026-10-24 00:00 UTC). Must run BEFORE the bx-backtest-builder v5
--   deploy (so before any v5 write, any probe, 23_cron_schedule and 24_data_cleanup -- the backup is then a complete
--   pre-rollout snapshot, a superset of 24's em5 backup).
-- Idempotent: CREATE TABLE IF NOT EXISTS + INSERT ... ON CONFLICT (id) DO NOTHING. A re-run after v5 has written copies
--   nothing new (v5 rows have computed_at >= the cut-off; rows v5 upserted onto old keys keep their backed-up version).
-- No secret values. Run as postgres.
--
-- Rollback (run as postgres):
--   (A) Full revert of bx_backtest_results to the exact pre-rollout state (pair with redeploying v4, commit 0834d06;
--       this also undoes 24_data_cleanup's bx_backtest_results deletions):
--         BEGIN;
--         DELETE FROM public.bx_backtest_results WHERE computed_at >= timestamptz '2026-10-24 00:00:00+00';
--         INSERT INTO public.bx_backtest_results SELECT * FROM private.bx_backtest_results_pre_v5_bak ON CONFLICT DO NOTHING;
--         COMMIT;
--         REFRESH MATERIALIZED VIEW public.bx_backtest_summary;
--       (v5 upserts onto an old key keep its id and set computed_at >= the cut-off, so the DELETE removes them and the
--       INSERT restores the original row by id; rows v5 inserted fresh are simply removed.)
--   (B) Keep v5 and restore only keys v5 no longer has (e.g. the unreproducible pre-window daily history):
--         INSERT INTO public.bx_backtest_results SELECT b.* FROM private.bx_backtest_results_pre_v5_bak b
--         WHERE b.timeframe = 'daily' AND b.signal_date < '2024-12-16'   -- narrow as needed; without a filter this also
--           AND NOT EXISTS (SELECT 1 FROM public.bx_backtest_results r  -- restores v4 Monday weekly / day-1 monthly
--                           WHERE r.ticker = b.ticker AND r.timeframe = b.timeframe  -- labels next to v5's relabeled rows
--                             AND r.signal_type = b.signal_type AND r.signal_date = b.signal_date)
--         ON CONFLICT DO NOTHING;
--         REFRESH MATERIALIZED VIEW public.bx_backtest_summary;
--   Drop when satisfied (after the v5 rebuild is verified and the backtest views have been reviewed on v5 data):
--     DROP TABLE private.bx_backtest_results_pre_v5_bak;

CREATE TABLE IF NOT EXISTS private.bx_backtest_results_pre_v5_bak (
  LIKE public.bx_backtest_results,
  PRIMARY KEY (id)
);
COMMENT ON TABLE private.bx_backtest_results_pre_v5_bak IS
  'Pre-v5 snapshot: every public.bx_backtest_results row with computed_at < 2026-10-24 00:00 UTC, taken before the bx-backtest-builder v5 deploy (40_edge_math.sql). Rollback source for the first v5 full rebuild.';
ALTER TABLE private.bx_backtest_results_pre_v5_bak OWNER TO postgres;
REVOKE ALL ON private.bx_backtest_results_pre_v5_bak FROM PUBLIC, anon, authenticated, service_role;

DO $$
declare
  cutoff constant timestamptz := timestamptz '2026-10-24 00:00:00+00';
  n_pre int;
  n_new int;
  n_bak int;
  n_missing int;
  n_post int;
begin
  select count(*) into n_pre from public.bx_backtest_results where computed_at < cutoff;
  select count(*) into n_post from public.bx_backtest_results where computed_at >= cutoff;

  insert into private.bx_backtest_results_pre_v5_bak
  select * from public.bx_backtest_results where computed_at < cutoff
  on conflict (id) do nothing;
  get diagnostics n_new = row_count;

  select count(*) into n_bak from private.bx_backtest_results_pre_v5_bak;
  select count(*) into n_missing
  from public.bx_backtest_results r
  where r.computed_at < cutoff
    and not exists (select 1 from private.bx_backtest_results_pre_v5_bak b where b.id = r.id);

  if n_missing <> 0 then
    raise exception '40_edge_math: % pre-v5 rows are not in the backup', n_missing;
  end if;
  if n_bak < n_pre then
    raise exception '40_edge_math: backup has % rows, fewer than the % pre-v5 rows', n_bak, n_pre;
  end if;

  raise notice '40_edge_math: pre-v5 rows % (copied now %), backup rows %, rows at/after cut-off % (expect 0 on the first run)',
    n_pre, n_new, n_bak, n_post;
  if n_post > 0 then
    raise warning '40_edge_math: % rows have computed_at >= cut-off and are NOT backed up (expected on a re-run after v5 wrote; on the first run, before the v5 deploy, it means the step-0 gate failed -- stop)', n_post;
  end if;
end $$;
