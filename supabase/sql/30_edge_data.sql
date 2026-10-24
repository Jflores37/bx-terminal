-- 30_edge_data.sql -- schema support for the edge-data unit (bx-alerter, bx-finviz-sync, bx-earnings-sync,
-- bx-exchange-backfill).
--
-- Purpose
--   1. public.alert_state: claim-then-post dedup for bx-alerter.                                    [ed-10, ed-3]
--      alert_key stays the PRIMARY KEY (the unique constraint the claim's ON CONFLICT DO NOTHING relies on;
--      asserted below). New columns:
--        status     'claimed' while a run holds the key and is posting; 'posted' after Slack accepted it.
--                   DEFAULT 'posted' so the still-deployed old alerter (plain {alert_key, posted_at} upsert)
--                   keeps writing valid rows until the new code is deployed.
--        claimed_at when the claim was taken (claims older than 15 min are released by the next run).
--        scan_date  the transition's scan date (lets the alerter prune keys older than 200 days).
--   2. public.ticker_meta.next_earnings_source ('finviz' | 'nasdaq'): which sync wrote next_earnings_date.
--      Precedence: Finviz is primary and overwrites; NASDAQ (bx-earnings-sync) never overwrites a current
--      'finviz' date and only fills gaps / refreshes its own dates.                                  [ed-6, ed-7]
--   3. Backup before the functions start clearing passed earnings dates: every ticker_meta row whose
--      next_earnings_date is already before today's America/New_York date is copied to
--      private.ticker_meta_earnings_bak_20261024 (the new bx-finviz-sync / bx-earnings-sync null those out).  [ed-6]
--      No data is changed by this file.
--
-- Findings: ed-3, ed-6, ed-7, ed-10 (ed-1/ed-2/ed-5/ed-8/ed-9/db-6 are code-only, in the four index.ts files).
-- Must run after: 10_security (it revokes anon/authenticated on alert_state), 20_pipeline_infra, 21_views,
--   22_backtest_summary. Must run BEFORE deploying bx-alerter, bx-finviz-sync and bx-earnings-sync (they write
--   the new columns; PostgREST would reject unknown columns with PGRST204).
-- Idempotent: ADD COLUMN IF NOT EXISTS, guarded DO blocks, CREATE TABLE IF NOT EXISTS, ON CONFLICT DO NOTHING.
-- No secret values in this file.
--
-- Rollback (run as postgres, only after reverting the four functions to baseline 0834d06):
--   ALTER TABLE public.alert_state DROP CONSTRAINT IF EXISTS alert_state_status_check;
--   ALTER TABLE public.alert_state DROP COLUMN IF EXISTS status, DROP COLUMN IF EXISTS claimed_at,
--     DROP COLUMN IF EXISTS scan_date;
--   ALTER TABLE public.ticker_meta DROP CONSTRAINT IF EXISTS ticker_meta_next_earnings_source_check;
--   ALTER TABLE public.ticker_meta DROP COLUMN IF EXISTS next_earnings_source;
--   -- restore cleared past earnings dates (only rows the new code nulled and nothing has refilled since):
--   UPDATE public.ticker_meta m SET next_earnings_date = b.next_earnings_date
--     FROM private.ticker_meta_earnings_bak_20261024 b
--    WHERE m.ticker = b.ticker AND m.next_earnings_date IS NULL;
--   -- DROP TABLE private.ticker_meta_earnings_bak_20261024;   -- once no longer needed

-- ---------------------------------------------------------------------------------------------------------------
-- 1. alert_state claim columns.
ALTER TABLE public.alert_state ADD COLUMN IF NOT EXISTS status     text        NOT NULL DEFAULT 'posted';
ALTER TABLE public.alert_state ADD COLUMN IF NOT EXISTS claimed_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.alert_state ADD COLUMN IF NOT EXISTS scan_date  date;

DO $$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.alert_state'::regclass and conname = 'alert_state_status_check') then
    alter table public.alert_state
      add constraint alert_state_status_check check (status in ('claimed', 'posted'));
  end if;
  -- The claim (POST ?on_conflict=alert_key, resolution=ignore-duplicates) needs a unique index on alert_key.
  -- alert_state_pkey (alert_key) provides it today; add a unique constraint only if that ever went missing.
  if not exists (
    select 1 from pg_index i
    where i.indrelid = 'public.alert_state'::regclass and i.indisunique
      and i.indkey::text = (select attnum::text from pg_attribute
                            where attrelid = 'public.alert_state'::regclass and attname = 'alert_key')
  ) then
    alter table public.alert_state add constraint alert_state_alert_key_key unique (alert_key);
  end if;
end
$$;

-- Backfill scan_date for any pre-existing keys ("TICKER|timeframe|YYYY-MM-DD"); 0 rows today.
UPDATE public.alert_state
   SET scan_date = split_part(alert_key, '|', 3)::date
 WHERE scan_date IS NULL AND split_part(alert_key, '|', 3) ~ '^\d{4}-\d{2}-\d{2}$';

COMMENT ON COLUMN public.alert_state.status IS
  'bx-alerter claim-then-post: claimed = a run holds the key and is posting; posted = Slack accepted it.';
COMMENT ON COLUMN public.alert_state.claimed_at IS
  'When the claim was taken. Claims still ''claimed'' after 15 minutes are released by the next bx-alerter run.';
COMMENT ON COLUMN public.alert_state.scan_date IS
  'Scan date of the alerted transition; bx-alerter prunes keys older than 200 days.';

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Earnings-date source.
ALTER TABLE public.ticker_meta ADD COLUMN IF NOT EXISTS next_earnings_source text;
DO $$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.ticker_meta'::regclass and conname = 'ticker_meta_next_earnings_source_check') then
    alter table public.ticker_meta
      add constraint ticker_meta_next_earnings_source_check
      check (next_earnings_source is null or next_earnings_source in ('finviz', 'nasdaq'));
  end if;
end
$$;
COMMENT ON COLUMN public.ticker_meta.next_earnings_source IS
  'Which sync wrote next_earnings_date: finviz (primary, bx-finviz-sync) or nasdaq (gap-fill, bx-earnings-sync). NULL = unknown/legacy.';

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Backup of passed earnings dates (the new functions clear them).
CREATE TABLE IF NOT EXISTS private.ticker_meta_earnings_bak_20261024 (
  ticker             text        PRIMARY KEY,
  next_earnings_date date        NOT NULL,
  backed_up_at       timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE private.ticker_meta_earnings_bak_20261024 IS
  'ticker_meta.next_earnings_date values already in the past (NY date) when 30_edge_data.sql ran, before bx-finviz-sync / bx-earnings-sync v4 began nulling passed dates.';
REVOKE ALL ON private.ticker_meta_earnings_bak_20261024 FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO private.ticker_meta_earnings_bak_20261024 (ticker, next_earnings_date)
SELECT ticker, next_earnings_date
  FROM public.ticker_meta
 WHERE next_earnings_date < (now() AT TIME ZONE 'America/New_York')::date
ON CONFLICT (ticker) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Self-check (raises -> the whole migration rolls back).
DO $$
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'alert_state'
         and column_name in ('alert_key', 'posted_at', 'status', 'claimed_at', 'scan_date')) <> 5 then
    raise exception '30_edge_data self-check: alert_state columns missing';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'ticker_meta' and column_name = 'next_earnings_source') then
    raise exception '30_edge_data self-check: ticker_meta.next_earnings_source missing';
  end if;
  if (select count(*) from public.ticker_meta m
       where m.next_earnings_date < (now() AT TIME ZONE 'America/New_York')::date
         and not exists (select 1 from private.ticker_meta_earnings_bak_20261024 b where b.ticker = m.ticker)) > 0 then
    raise exception '30_edge_data self-check: passed earnings dates not fully backed up';
  end if;
end
$$;
