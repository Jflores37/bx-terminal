-- 23_cron_schedule.sql -- complete replacement of the BX pg_cron schedule (unit "db").
--
-- Purpose: replace all 29 old jobs (ids 2,4,6,7-15,17-29,33-36 in supabase/snapshot/cron_jobs.sql) with a
-- DST-safe, non-overlapping schedule built for the Free-plan edge limits (150 s wall clock, 2 s CPU) and the new
-- chunk/fill parameters (C5, C6).
--   - bx-scan: 6 chunks (chunk=i&chunks=6 = 0-based slice of the ACTIVE universe, size ceil(N/6), so growth past
--     the old fixed 3 x 410 offsets is covered automatically), 5 min apart so a chunk (<= ~180 tickers, bails
--     before 150 s) never overlaps the next and TradeStation's 5-minute request windows are not stacked; then 3
--     fill passes (mode=fill: up to 200 active tickers still missing the target scan_date each). The old
--     schedule lost whole 410-ticker chunks to 546 WORKER_RESOURCE_LIMIT (3 of 20 days complete).
--                                                                                       [db-1, db-9, db-15, C9]
--   - Daily scan starts 21:20 UTC = 4:20 PM EST / 5:20 PM EDT, i.e. after the 4:00 PM close and the ~4:15 PM
--     settle in BOTH DST regimes (the old 21:05 UTC = 4:05 PM EST). bx-scan derives scan_date from the last
--     completed NY session (C5), so a holiday run re-upserts the previous session instead of inventing a date.
--                                                                                                [db-15, C9]
--   - Weekly scan Sunday 14:00 UTC (the week closed Friday). Monthly scan on the 1st at 11:00 UTC = 6/7 AM ET:
--     the previous month is complete and the new month has not opened (the old 14:00 UTC = 10:00 AM EDT read a
--     30-minute-old October bar; C5 also drops any in-progress period bar).                              [db-3]
--   - bx-backtest-builder: chunks=12 per timeframe (~90 tickers per call; the old single 1000-ticker / full-
--     universe calls died at the 2 s CPU limit, which froze weekly/monthly results since June), Sunday 06:00-08:55
--     UTC, 5 min apart, finishing hours before the monthly (11:00) and weekly (14:00) scans. Then both backtest
--     matviews are refreshed.                                                                          [db-4]
--   - finviz-sync / exchange-backfill / reconcile_universe / alerter / earnings-sync run AFTER the scans and fill
--     passes (prices are post-close in both DST regimes; the universe cannot change between scan chunks). The old
--     order was the reverse; consequence: a newly activated ticker is first scanned at the NEXT session (weekly /
--     monthly: next run) and a deactivated one gets one extra scan. pipeline_health's coverage ratio ignores
--     active tickers with no scan history, so this does not raise a false warn.
--   - bx-earnings-sync runs after bx-finviz-sync on the same day on Wednesday (22:25 -> 22:50); the single Sunday
--     run (15:20) follows Friday's 22:25 finviz-sync, whose finviz-owned dates are still stamped (old Sunday job 13
--     at 15:00 and job 14 at 13:40 collapse into this one job; there is no Sunday finviz-sync any more).
--     Durations: exchange-backfill ~60-90 s (22:30, done before reconcile_universe at 22:40; it does not touch
--     ticker_meta.updated_at), earnings-sync ~10-25 s.
--   - Duplicates removed: the second Sunday earnings sync (old job 14) and the weekly/monthly copies of
--     finviz-sync, exchange-backfill and reconcile_universe (old 8/9, 11/12, 34/35 fired twice at the same
--     minute whenever the 1st was a Sunday; the weekday copies already refresh metadata after every session).
--                                                                                                     [db-16]
--   - pipeline-reconcile-edge-calls every 10 min (C2; also created by 20_pipeline_infra.sql).          [db-2]
--   public.pipeline_health (21_views.sql) mirrors the three scan windows below; keep them in sync.
--
-- Schedule (cron.timezone = GMT; ET shown as EDT (until Nov 1 2026) / EST (after)):
--   Mon-Fri  21:20 21:25 21:30 21:35 21:40 21:45  bx-scan daily chunk 0..5     5:20-5:45 PM EDT / 4:20-4:45 PM EST
--   Mon-Fri  21:55 22:05 22:15                    bx-scan daily fill 1..3      5:55-6:15 PM EDT / 4:55-5:15 PM EST
--   Mon-Fri  22:25 bx-finviz-sync, 22:30 bx-exchange-backfill, 22:40 reconcile_universe(), 22:45 bx-alerter daily
--                                                                              6:25-6:45 PM EDT / 5:25-5:45 PM EST
--   Wed      22:50 bx-earnings-sync                                            6:50 PM EDT / 5:50 PM EST
--   Sun      06:00-06:55 builder daily c0..c11, 07:00-07:55 weekly c0..c11, 08:00-08:55 monthly c0..c11 (5 min apart)
--                                                                              2:00-4:55 AM EDT / 1:00-3:55 AM EST
--   Sun      09:10 refresh bx_backtest_summary, 09:15 refresh bx_backtest_baseline_summary   5:10 AM EDT / 4:10 AM EST
--   Sun      14:00-14:25 bx-scan weekly chunk 0..5, 14:35 14:45 14:55 fill 1..3   10:00-10:55 AM EDT / 9:00-9:55 AM EST
--   Sun      15:10 bx-alerter weekly, 15:20 bx-earnings-sync                   11:10 AM EDT / 10:10 AM EST
--   1st      11:00-11:25 bx-scan monthly chunk 0..5, 11:35 11:45 11:55 fill 1..3  7:00-7:55 AM EDT / 6:00-6:55 AM EST
--   1st      12:10 bx-alerter monthly                                          8:10 AM EDT / 7:10 AM EST
--   every 10 min  private.reconcile_edge_calls()
--   No two edge invocations of the same function overlap: every slot is >= 5 min apart and each call is cut off
--   at 150 s. When the 1st is a Sunday: builder 06:00-08:58, refresh 09:10, monthly scan 11:00-11:58, weekly
--   scan 14:00 -- still disjoint.
--   Capacity: 6 chunks x 200 = 1,200 active tickers per pass + 3 x 200 fill. If the active universe grows past
--   ~1,200, raise chunks (and add slots) here; pipeline_health's scan_coverage turns warn/error first.
--
-- Findings: db-1, db-3, db-4, db-9, db-15, db-16 (schedule side; the function-side halves are C5/C6 in bx-scan
--   and bx-backtest-builder).
-- Must run after: 20_pipeline_infra, 21_views, 22_backtest_summary AND the deploys of bx-scan (C5: chunk/chunks/
--   mode=fill) and bx-backtest-builder (C6: chunk/chunks). The old function code ignores chunk/chunks and would
--   scan the first 450 tickers six times, so never apply this before those deploys.
-- Idempotent: unschedules every job of the old list / old ids / managed name prefixes, then schedules the full
--   set by name. Re-running yields the same jobs (new jobids). No secret values.
--
-- Rollback (run as postgres): unschedule the new jobs and re-create the old ones from
--   supabase/snapshot/cron_jobs.sql, e.g.
--   DO $$ declare r record; begin for r in select jobid from cron.job where jobname like 'bx-%' or jobname like
--     'reconcile-universe-%' or jobname like 'refresh-bx-%' loop perform cron.unschedule(r.jobid); end loop; end $$;
--   select cron.schedule('bx-scan-daily-c1', '5 21 * * 1-5',
--     $c$select invoke_edge_function('bx-scan','timeframe=daily&source=tradestation&offset=0&limit=410')$c$);
--   ... (one cron.schedule per row of the machine-readable list in cron_jobs.sql)

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Remove the old schedule (by id and by name) and any previous version of this file's jobs.
DO $$
declare
  r record;
  old_names text[] := array[
    'bx-alert-daily', 'bx-alert-weekly', 'bx-alert-monthly',
    'bx-finviz-sync-daily', 'bx-finviz-sync-weekly', 'bx-finviz-sync-monthly',
    'bx-exchange-backfill-daily', 'bx-exchange-backfill-weekly', 'bx-exchange-backfill-monthly',
    'bx-earnings-sync-weekly', 'bx-earnings-sync-sunday', 'bx-earnings-sync-wednesday',
    'bx-backtest-weekly-weekly', 'bx-backtest-weekly-monthly', 'bx-backtest-weekly-daily-1', 'bx-backtest-weekly-daily-2',
    'bx-scan-daily-c1', 'bx-scan-daily-c2', 'bx-scan-daily-c3',
    'bx-scan-weekly-c1', 'bx-scan-weekly-c2', 'bx-scan-weekly-c3',
    'bx-scan-monthly-c1', 'bx-scan-monthly-c2', 'bx-scan-monthly-c3',
    'reconcile-universe-daily', 'reconcile-universe-weekly', 'reconcile-universe-monthly',
    'refresh-bx-backtest-summary'];
  old_ids bigint[] := array[2, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
                            33, 34, 35, 36];
begin
  for r in
    select jobid, jobname from cron.job
     where jobid = any (old_ids)
        or jobname = any (old_names)
        or jobname like 'bx-scan-%' or jobname like 'bx-backtest-%' or jobname like 'bx-alert-%'
        or jobname like 'bx-finviz-sync-%' or jobname like 'bx-exchange-backfill-%' or jobname like 'bx-earnings-sync-%'
        or jobname like 'reconcile-universe-%' or jobname like 'refresh-bx-%'
        or jobname = 'pipeline-reconcile-edge-calls'
  loop
    perform cron.unschedule(r.jobid);
    raise notice 'unscheduled job % (%)', r.jobid, r.jobname;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. New schedule.
DO $$
declare
  i int;
  tf text;
  base_hour int;
  fill_min int[];
begin
  -- Daily scan: 6 chunks Mon-Fri 21:20..21:45 UTC, then 3 fill passes 21:55 / 22:05 / 22:15.
  for i in 0..5 loop
    perform cron.schedule(format('bx-scan-daily-chunk-%s', i), format('%s 21 * * 1-5', 20 + 5 * i),
      format($c$select public.invoke_edge_function('bx-scan', 'timeframe=daily&source=tradestation&chunk=%s&chunks=6')$c$, i));
  end loop;
  perform cron.schedule('bx-scan-daily-fill-1', '55 21 * * 1-5',
    $c$select public.invoke_edge_function('bx-scan', 'timeframe=daily&source=tradestation&mode=fill')$c$);
  perform cron.schedule('bx-scan-daily-fill-2', '5 22 * * 1-5',
    $c$select public.invoke_edge_function('bx-scan', 'timeframe=daily&source=tradestation&mode=fill')$c$);
  perform cron.schedule('bx-scan-daily-fill-3', '15 22 * * 1-5',
    $c$select public.invoke_edge_function('bx-scan', 'timeframe=daily&source=tradestation&mode=fill')$c$);

  -- Weekly scan: Sunday 14:00..14:25 UTC, fills 14:35 / 14:45 / 14:55.
  for i in 0..5 loop
    perform cron.schedule(format('bx-scan-weekly-chunk-%s', i), format('%s 14 * * 0', 5 * i),
      format($c$select public.invoke_edge_function('bx-scan', 'timeframe=weekly&source=tradestation&chunk=%s&chunks=6')$c$, i));
  end loop;
  fill_min := array[35, 45, 55];
  for i in 1..3 loop
    perform cron.schedule(format('bx-scan-weekly-fill-%s', i), format('%s 14 * * 0', fill_min[i]),
      $c$select public.invoke_edge_function('bx-scan', 'timeframe=weekly&source=tradestation&mode=fill')$c$);
  end loop;

  -- Monthly scan: the 1st 11:00..11:25 UTC, fills 11:35 / 11:45 / 11:55.
  for i in 0..5 loop
    perform cron.schedule(format('bx-scan-monthly-chunk-%s', i), format('%s 11 1 * *', 5 * i),
      format($c$select public.invoke_edge_function('bx-scan', 'timeframe=monthly&source=tradestation&chunk=%s&chunks=6')$c$, i));
  end loop;
  for i in 1..3 loop
    perform cron.schedule(format('bx-scan-monthly-fill-%s', i), format('%s 11 1 * *', fill_min[i]),
      $c$select public.invoke_edge_function('bx-scan', 'timeframe=monthly&source=tradestation&mode=fill')$c$);
  end loop;

  -- Backtest builder: Sunday, 12 chunks per timeframe, 5 min apart: daily 06:xx, weekly 07:xx, monthly 08:xx UTC.
  base_hour := 6;
  foreach tf in array array['daily', 'weekly', 'monthly'] loop
    for i in 0..11 loop
      perform cron.schedule(format('bx-backtest-%s-chunk-%s', tf, i), format('%s %s * * 0', 5 * i, base_hour),
        format($c$select public.invoke_edge_function('bx-backtest-builder', 'timeframe=%s&chunk=%s&chunks=12')$c$, tf, i));
    end loop;
    base_hour := base_hour + 1;
  end loop;

  -- Matview refresh after the last builder chunk (08:55 + <= 150 s).
  perform cron.schedule('refresh-bx-backtest-summary', '10 9 * * 0',
    $c$REFRESH MATERIALIZED VIEW CONCURRENTLY public.bx_backtest_summary$c$);
  perform cron.schedule('refresh-bx-backtest-baseline-summary', '15 9 * * 0',
    $c$REFRESH MATERIALIZED VIEW CONCURRENTLY public.bx_backtest_baseline_summary$c$);

  -- Metadata, universe, alerts, earnings: after the scans and fill passes.
  perform cron.schedule('bx-finviz-sync-daily', '25 22 * * 1-5',
    $c$select public.invoke_edge_function('bx-finviz-sync')$c$);
  perform cron.schedule('bx-exchange-backfill-daily', '30 22 * * 1-5',
    $c$select public.invoke_edge_function('bx-exchange-backfill')$c$);
  perform cron.schedule('reconcile-universe-daily', '40 22 * * 1-5',
    $c$select public.reconcile_universe()$c$);        -- needs >= 800 ticker_meta rows refreshed in the last 30 min
  perform cron.schedule('bx-alert-daily', '45 22 * * 1-5',
    $c$select public.invoke_edge_function('bx-alerter', 'timeframe=daily')$c$);
  perform cron.schedule('bx-alert-weekly', '10 15 * * 0',
    $c$select public.invoke_edge_function('bx-alerter', 'timeframe=weekly')$c$);
  perform cron.schedule('bx-alert-monthly', '10 12 1 * *',
    $c$select public.invoke_edge_function('bx-alerter', 'timeframe=monthly')$c$);
  perform cron.schedule('bx-earnings-sync-sunday', '20 15 * * 0',
    $c$select public.invoke_edge_function('bx-earnings-sync')$c$);
  perform cron.schedule('bx-earnings-sync-wednesday', '50 22 * * 3',
    $c$select public.invoke_edge_function('bx-earnings-sync')$c$);

  -- C2 outcome capture.
  perform cron.schedule('pipeline-reconcile-edge-calls', '*/10 * * * *',
    $c$select private.reconcile_edge_calls()$c$);
end
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Self-check (raises -> the whole migration rolls back) and a listing in the migration output.
DO $$
declare
  n int;
  r record;
begin
  select count(*) into n from cron.job
   where jobname like 'bx-%' or jobname like 'reconcile-universe-%' or jobname like 'refresh-bx-%'
      or jobname = 'pipeline-reconcile-edge-calls';
  -- 9 daily scan + 9 weekly scan + 9 monthly scan + 36 builder + 2 refresh + 8 other + 1 reconcile = 74
  if n <> 74 then
    raise exception '23_cron_schedule self-check: expected 74 managed jobs, found %', n;
  end if;
  if exists (select 1 from cron.job where jobid = any (array[2, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21,
                                                              22, 23, 24, 25, 26, 27, 28, 29, 33, 34, 35, 36]::bigint[])) then
    raise exception '23_cron_schedule self-check: an old job id is still scheduled';
  end if;
  -- No two edge-function jobs share a cron slot (a shared slot = concurrent invocations).
  if exists (select schedule from cron.job
              where command like '%invoke_edge_function%'
              group by schedule having count(*) > 1) then
    raise exception '23_cron_schedule self-check: two edge-function jobs share a schedule';
  end if;
  if exists (select 1 from cron.job where command ilike '%offset=%' or command ilike '%limit=%') then
    raise exception '23_cron_schedule self-check: a job still uses the old offset/limit chunking';
  end if;
  for r in select jobid, jobname, schedule from cron.job order by jobname loop
    raise notice '% | % | %', r.jobid, r.jobname, r.schedule;
  end loop;
end
$$;
