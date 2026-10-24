-- 24_data_cleanup.sql -- remove mislabeled rows from bx_backtest_results (unit "db").
--
-- Purpose: delete the weekly/daily-cadence rows stored as timeframe = 'monthly' by an earlier builder version
--   (computed 2026-05-12/13 and a few later runs). The old builder stamped every real monthly signal with the 1st
--   of the month (Yahoo monthly bar timestamp); rows on any other day of the month are weekly bars (16.6k on
--   Mondays from 2017 on, the weekly 10y range), daily bars (Tue-Fri, 2024-08 on, the daily 2y range) or
--   in-progress last bars. They mix 60-WEEK horizons into 60-MONTH averages in bx_backtest_summary.      [em-5]
--   Rule: timeframe = 'monthly' AND day-of-month <> 1 AND computed_at < 2026-10-24 00:00 UTC.
--   The computed_at cut-off protects rows written by the C6 builder (deployed after that instant), whose monthly
--   signal_date is the LAST trading day of the month. Measured 2026-10-24: 22,366 of 59,431 monthly rows match.
--   Caveat: if the C6 builder upserts onto an old key without updating computed_at, that rebuilt row would match;
--   the next weekly builder run re-inserts it (C6 rebuild is idempotent), and the builder unit was asked to send
--   computed_at on every upsert.
--   Every affected row is first copied to private.bx_backtest_results_em5_bak (same columns, PK id). Both
--   matviews are refreshed afterwards.
--   Known residual (not deletable by date alone): weekly-cadence rows whose Monday fell on the 1st (~500 rows
--   measured; Monday-1st dates hold ~185 rows vs ~152 on other weekdays). For ACTIVE tickers the C6 builder's
--   stale-key delete removes them on its first monthly run (C6 monthly signal_date is the month's last trading
--   day, so no old day-1 key survives); for INACTIVE tickers they stay in the table but no longer feed
--   bx_backtest_summary, which is active-universe only (22_backtest_summary.sql rule (c)).
--
--   Part 2 -- bx_scans monthly rows dated 2026-10-01 (1,096 rows, 1,048 active tickers). The old schedule ran the
--   monthly scan on Oct 1 at 14:00 UTC (10:00 AM EDT), so every row was computed from a 30-minute-old, in-progress
--   October bar, and because 10/01 is the max monthly scan_date these rows hide the correct 09/30 rows that the
--   C5 bx-scan writes (monthly scan_date = last trading day of the month; C5 can never write a monthly 10/01).
--   Rule: timeframe = 'monthly' AND scan_date = 2026-10-01 AND created_at < 2026-10-24 00:00 UTC. Backed up to
--   private.bx_scans_monthly_20261001_bak first. Until the monthly scan writes 09/30 (edge-math rollout runs it
--   right after this file; otherwise the Nov 1 cron), the monthly board falls back to the 09/01 rows and
--   pipeline_health shows monthly scan_freshness = warn.                                [em C5 follow-up]
--
-- Findings: em-5 (data side; the builder fix is C6 in bx-backtest-builder); edge-math's 2026-10-01 monthly
--   bx_scans cleanup.
-- Must run after: 22_backtest_summary.sql, the bx-backtest-builder deploy and 23_cron_schedule.sql.
-- Idempotent: backups use ON CONFLICT (id) DO NOTHING; a re-run deletes 0 rows. Prints counts via NOTICE.
-- No secret values.
--
-- Rollback (run as postgres):
--   INSERT INTO public.bx_backtest_results SELECT * FROM private.bx_backtest_results_em5_bak
--   ON CONFLICT DO NOTHING;
--   REFRESH MATERIALIZED VIEW public.bx_backtest_summary;
--   INSERT INTO public.bx_scans SELECT * FROM private.bx_scans_monthly_20261001_bak ON CONFLICT DO NOTHING;
--   -- DROP TABLE private.bx_backtest_results_em5_bak, private.bx_scans_monthly_20261001_bak;   -- once not needed

CREATE TABLE IF NOT EXISTS private.bx_backtest_results_em5_bak (
  LIKE public.bx_backtest_results,
  PRIMARY KEY (id)
);
COMMENT ON TABLE private.bx_backtest_results_em5_bak IS
  'em-5 backup: timeframe=monthly rows of public.bx_backtest_results whose signal_date was not the 1st (weekly/daily-cadence rows mislabeled monthly), deleted by 24_data_cleanup.sql.';
ALTER TABLE private.bx_backtest_results_em5_bak OWNER TO postgres;
REVOKE ALL ON private.bx_backtest_results_em5_bak FROM PUBLIC, anon, authenticated, service_role;

DO $$
declare
  cutoff constant timestamptz := timestamptz '2026-10-24 00:00:00+00';
  n_match int;
  n_backed int;
  n_deleted int;
  n_monthly_after int;
begin
  select count(*) into n_match
    from public.bx_backtest_results
   where timeframe = 'monthly' and extract(day from signal_date) <> 1 and computed_at < cutoff;

  insert into private.bx_backtest_results_em5_bak
  select r.*
    from public.bx_backtest_results r
   where r.timeframe = 'monthly' and extract(day from r.signal_date) <> 1 and r.computed_at < cutoff
  on conflict (id) do nothing;
  get diagnostics n_backed = row_count;

  -- Delete only rows that are safely in the backup.
  delete from public.bx_backtest_results r
   where r.timeframe = 'monthly' and extract(day from r.signal_date) <> 1 and r.computed_at < cutoff
     and exists (select 1 from private.bx_backtest_results_em5_bak b where b.id = r.id);
  get diagnostics n_deleted = row_count;

  select count(*) into n_monthly_after from public.bx_backtest_results where timeframe = 'monthly';

  raise notice 'em-5 cleanup: % matching rows, % newly backed up (% total in backup), % deleted, % monthly rows remain',
    n_match, n_backed, (select count(*) from private.bx_backtest_results_em5_bak), n_deleted, n_monthly_after;

  if n_deleted <> n_match then
    raise exception 'em-5 cleanup: deleted % rows but % matched (backup incomplete?)', n_deleted, n_match;
  end if;
  if exists (select 1 from public.bx_backtest_results
              where timeframe = 'monthly' and extract(day from signal_date) <> 1 and computed_at < cutoff) then
    raise exception 'em-5 cleanup: mislabeled monthly rows remain';
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Part 2: bx_scans monthly rows dated 2026-10-01 (in-progress October bar).
CREATE TABLE IF NOT EXISTS private.bx_scans_monthly_20261001_bak (
  LIKE public.bx_scans,
  PRIMARY KEY (id)
);
COMMENT ON TABLE private.bx_scans_monthly_20261001_bak IS
  'Backup of public.bx_scans timeframe=monthly scan_date=2026-10-01 rows (computed from an in-progress October bar), deleted by 24_data_cleanup.sql.';
ALTER TABLE private.bx_scans_monthly_20261001_bak OWNER TO postgres;
REVOKE ALL ON private.bx_scans_monthly_20261001_bak FROM PUBLIC, anon, authenticated, service_role;

DO $$
declare
  cutoff constant timestamptz := timestamptz '2026-10-24 00:00:00+00';
  n_match int;
  n_backed int;
  n_deleted int;
begin
  select count(*) into n_match
    from public.bx_scans
   where timeframe = 'monthly' and scan_date = date '2026-10-01' and created_at < cutoff;

  insert into private.bx_scans_monthly_20261001_bak
  select s.*
    from public.bx_scans s
   where s.timeframe = 'monthly' and s.scan_date = date '2026-10-01' and s.created_at < cutoff
  on conflict (id) do nothing;
  get diagnostics n_backed = row_count;

  delete from public.bx_scans s
   where s.timeframe = 'monthly' and s.scan_date = date '2026-10-01' and s.created_at < cutoff
     and exists (select 1 from private.bx_scans_monthly_20261001_bak b where b.id = s.id);
  get diagnostics n_deleted = row_count;

  raise notice 'monthly 2026-10-01 bx_scans cleanup: % matching rows, % newly backed up (% total in backup), % deleted',
    n_match, n_backed, (select count(*) from private.bx_scans_monthly_20261001_bak), n_deleted;

  if n_deleted <> n_match then
    raise exception 'bx_scans cleanup: deleted % rows but % matched (backup incomplete?)', n_deleted, n_match;
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Plain (non-concurrent) refresh: allowed inside the migration transaction; readers wait ~5 s.
REFRESH MATERIALIZED VIEW public.bx_backtest_summary;
REFRESH MATERIALIZED VIEW public.bx_backtest_baseline_summary;
