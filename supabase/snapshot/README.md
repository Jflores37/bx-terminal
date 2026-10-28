# DB / platform baseline (2026-10-24) -- facts for the fix units

Captured read-only by the prep agent around 12:15 AM ET on Sat 10/24/2026. Files here:
`views.sql`, `functions.sql`, `cron_jobs.sql` (reference only, never apply), `tables.md`, `env.md`, `callers.md`.
No secret values are recorded anywhere in this folder.

## 1. Platform limits (the root cause of most data gaps)
- Org plan **FREE**. Edge Functions: **150 s wall clock**, **2 s CPU**, 256 MB.
- bx-scan dies on **wall clock**, not CPU: 10/23 daily c3 `546 WORKER_RESOURCE_LIMIT`, shutdown reason `WallClockTime`
  at 150.6 s with only 595 ms CPU (time spent waiting; TS 429 `Retry-After` sleeps of 20 s are the likely sink).
  c2 took 147.9 s. CPU cost is ~2.5-2.9 ms per ticker (410 tickers = 1.0-1.2 s CPU), so 200 tickers per call is
  about 0.6 s CPU; keep wall time < ~120 s (cap per-ticker retries/sleeps and bail out before ~130 s).
- bx-backtest-builder dies on **CPU** (`CPU Time exceeded`, 2,000 ms): 10/18 daily offset 0 limit 1000, weekly (all), and monthly (all)
  all failed with 546. The 81-ticker daily-2 call worked with 294 ms CPU (~3.6 ms/ticker for daily, which fetches D+W+M).
  So ~100 tickers per call is about 0.4-0.7 s CPU. That is why weekly/monthly `computed_at` is stuck at 6/14-6/15.
- pg_net purges responses after **6 hours** (`pg_net.ttl`). `cron.job_run_details` says 'succeeded' even when the HTTP call failed.
- anon `statement_timeout` = **3 s**. `latest_scans_with_meta` (daily) runs in 1.37 s today.

## 2. Vault / secrets
- `supabase_vault` 0.3.1 is installed. `vault.decrypted_secrets(id, name, description, secret, decrypted_secret, key_id, nonce, created_at, updated_at)`
  is readable by `postgres`, and `postgres` can run `vault.create_secret(text,text,text,uuid)`.
  **The vault holds 0 secrets** now, so the orchestrator must create `cron_secret`.
- Edge secrets currently set (names only): SUPABASE_* (built-ins), TRADESTATION_CLIENT_ID, TRADESTATION_CLIENT_SECRET, TRADESTATION_REDIRECT_URI.
  **Not set:** CRON_SECRET, TS_TOKEN_KEY, TS_OWNER_ACCOUNTS, SLACK_WEBHOOK_URL, TRADESTATION_ENV. TRADESTATION_ENV defaulting to `sim`
  means every TS call goes to `sim-api.tradestation.com`.
- Because CRON_SECRET is unset, today's `if (CRON_SECRET)` checks are inactive. After C1 ships, the functions **fail closed (500)** until
  CRON_SECRET is set AND invoke_edge_function sends it. Rollout order: set the edge CRON_SECRET and the vault `cron_secret` (same value)
  -> apply 20_pipeline_infra (new invoke_edge_function) -> deploy the functions.

## 3. public.invoke_edge_function -- current signature (keep it)
```
public.invoke_edge_function(fn_name text, query_string text DEFAULT ''::text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''   -- owner postgres
ACL: postgres=X, service_role=X (PUBLIC/anon/authenticated revoked)
body: net.http_post(url := 'https://wefobwdspqzxbesbnzoc.supabase.co/functions/v1/' || fn_name || ('?' || query_string if non-empty),
                    headers := jsonb_build_object('Content-Type','application/json'), body := '{}'::jsonb,
                    timeout_milliseconds := 600000) -> request_id
```
It sends NO auth header today. pg_net signature: `net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer)`.
`net._http_response(id bigint, status_code integer, content_type text, headers jsonb, content text, timed_out boolean, error_msg text, created timestamptz)`.
Every cron job calls it unqualified as `invoke_edge_function(...)`. postgres search_path includes public, so that resolves.

## 4. Exact column lists the SPA and functions depend on (current order)
- **bx_backtest_summary** (MATERIALIZED VIEW; unique index `bx_backtest_summary_pk (timeframe, signal_type)`, needed for
  `REFRESH ... CONCURRENTLY` in cron job 36):
  `timeframe text, signal_type text, n_signals bigint, n_with_60d bigint, avg_5d numeric, avg_20d numeric, avg_60d numeric,
  avg_120d numeric, median_60d numeric, win_rate_60d_pct numeric`
  -> C10 median names: **med_5d, med_20d, med_60d, med_120d** (median_60d already exists; keep it, and med_60d is still appended).
  -> C10 baseline view names: **base_avg_5d, base_avg_20d, base_avg_60d, base_avg_120d, base_win_rate_60d_pct** (the only existing
  win-rate column is 60d; adding base_win_rate_5d_pct/20d/120d_pct would be extra columns, not renames).
  The source table's ret columns are `ret_5d, ret_20d, ret_60d, ret_120d` (BAR offsets). C6 baseline table uses `*_ret_5/20/60/120`.
- **latest_scans_with_meta**: `ticker, timeframe, bx numeric(6,2), prev_bx numeric(6,2), scan_date date, bias_direction text,
  bias_oscillator numeric, bias_in_zone boolean, exchange text, market_cap_billions numeric, price numeric, avg_volume_millions numeric,
  sector text, industry text, next_earnings_date date, days_to_earnings integer, fifty_two_week_high numeric, fifty_two_week_low numeric,
  pct_of_52w_range numeric, alignment_score integer, composite_bx numeric, daily_bx numeric, weekly_bx numeric, monthly_bx numeric`
  (append: is_stale boolean, max_scan_date date, earnings_stale boolean).
- **bx_movers**: `ticker text, timeframe text, bx numeric(6,2), prev_bx numeric(6,2), delta_bx numeric, abs_delta numeric,
  current_zone text, previous_zone text, sector text, price numeric, market_cap_billions numeric, exchange text` (append scan_date date).
- **zone_transitions**: `ticker text, timeframe text, bx numeric(6,2), prev_bx numeric(6,2), scan_date date, current_zone text, previous_zone text`.
  **BUG for the bx-alerter unit:** bx-alerter reads `t.bx_previous_scan`, which does not exist (the column is `prev_bx`), so
  `Number(undefined)` = NaN and the magnitude filter drops every row. Masked today because SLACK_WEBHOOK_URL is unset.
- **multi_timeframe_view**: `ticker text, daily_bx numeric, weekly_bx numeric, monthly_bx numeric, alignment_score integer, composite_bx numeric`
  (composite = (d*1 + w*2 + m*3)/6.0 with COALESCE 0).
- **latest_scans**: `id bigint, ticker text, timeframe text, bx numeric(6,2), prev_bx numeric(6,2), scan_date date, created_at timestamptz`.
- Other views: bx_backtest_ticker, scan_coverage_gaps, sector_pulse (see views.sql).
- **ticker_meta**: `ticker text PK, exchange text, market_cap_billions numeric, price numeric, avg_volume_millions numeric, sector text,
  updated_at timestamptz default now(), industry text, next_earnings_date date, fifty_two_week_high numeric, fifty_two_week_low numeric`.
- **bx_scans** UNIQUE (ticker, timeframe, scan_date), CHECK timeframe in (daily, weekly, monthly), index (timeframe, scan_date DESC).
- **bx_backtest_results** UNIQUE (ticker, timeframe, signal_type, signal_date). No index leads with (ticker, timeframe), so the C6 per-ticker
  delete will use idx_backtest_ticker (ticker), which is fine.
- **tradestation_tokens**: `id int PK default 1 CHECK (id=1), access_token text, refresh_token text, expires_at timestamptz, scope text,
  updated_at timestamptz NOT NULL default now()`, with grants for postgres and service_role only.
- **All plain views are `security_invoker=true`.** A view the anon SPA reads must have anon SELECT and an RLS policy on every underlying
  table. pipeline_health (C4) reads edge_call_log / pipeline_runs, so either give those tables an anon SELECT policy (no secrets in them)
  or create pipeline_health WITHOUT security_invoker. The second option means accepting the security_definer_view lint.
- Grants: anon/authenticated have the default `arwdDxtm` (including TRUNCATE) on every public table and view except tradestation_tokens(_bak).

## 5. Data state (evidence for the fixes)
- Active universe **1,081** (1,952 rows). Daily scan coverage at max date 2026-10-23 is **820 / 1,081 (75.9%)**. Daily rows per date
  over 6 weeks range from 275 to 1,089.
- Weekly scan_date = **2026-10-18 (Sunday wall-clock)**. Monthly scan_date = **2026-10-01** (wall-clock date, with the bar in progress).
- Backtest: weekly signal_date is the **week-start Monday** (101,659 Mon / 171 Tue / 1 Wed / 564 Fri). Monthly signal_date is the
  **1st of the month** (10,453 on weekends). Extreme returns: weekly max ret_60d 399,900%, monthly 82,373%, daily 2,627%.
  Rows with |ret_5d|>100, |ret_20d|>200, |ret_60d|>300 or |ret_120d|>500: daily 520, weekly 1,725, monthly 6,352.
- 508 ticker_meta rows have next_earnings_date < NY today. days_to_earnings goes negative because it uses CURRENT_DATE, which is UTC.
- bx-exchange-backfill fails with **500 on every run**: PGRST102 "All object keys must match". It pushes rows with differing key sets in one
  bulk upsert, so ticker_meta exchange and 52-week columns never refresh.
- Two Sunday earnings jobs (13 at 3:00 PM UTC, 14 at 1:40 PM UTC) plus Wednesday (15).
- Old backup tables exist and are scheduled for cleanup (see RUNBOOK Phase 9).

## 6. Cron jobs (UTC; see cron_jobs.sql for the EDT/EST table)
| id | name | schedule | command |
|---|---|---|---|
| 2/4/6 | bx-alert-daily/weekly/monthly | 25 21 * * 1-5 / 20 14 * * 0 / 20 14 1 * * | invoke_edge_function('bx-alerter','timeframe=…') |
| 7/8/9 | bx-finviz-sync-daily/weekly/monthly | 30 20 * * 1-5 / 30 13 * * 0 / 30 13 1 * * | invoke_edge_function('bx-finviz-sync') |
| 10/11/12 | bx-exchange-backfill-* | 35 20 * * 1-5 / 35 13 * * 0 / 35 13 1 * * | invoke_edge_function('bx-exchange-backfill') |
| 13/14/15 | bx-earnings-sync-weekly/sunday/wednesday | 0 15 * * 0 / 40 13 * * 0 / 40 20 * * 3 | invoke_edge_function('bx-earnings-sync') |
| 17/18 | bx-backtest-weekly-weekly/monthly | 5 12 * * 0 / 10 12 * * 0 | invoke_edge_function('bx-backtest-builder','timeframe=weekly' / 'monthly') |
| 19/20 | bx-backtest-weekly-daily-1/2 | 0 12 * * 0 / 3 12 * * 0 | …('bx-backtest-builder','timeframe=daily&offset=0&limit=1000' / offset=1000) |
| 21/22/23 | bx-scan-daily-c1/c2/c3 | 5,11,17 21 * * 1-5 | …('bx-scan','timeframe=daily&source=tradestation&offset=0/410/820&limit=410') |
| 24/25/26 | bx-scan-weekly-c1/c2/c3 | 0,6,12 14 * * 0 | same, timeframe=weekly |
| 27/28/29 | bx-scan-monthly-c1/c2/c3 | 0,6,12 14 1 * * | same, timeframe=monthly |
| 33/34/35 | reconcile-universe-daily/weekly/monthly | 36 20 * * 1-5 / 36 13 * * 0 / 36 13 1 * * | select public.reconcile_universe() |
| 36 | refresh-bx-backtest-summary | 30 12 * * 0 | REFRESH MATERIALIZED VIEW CONCURRENTLY public.bx_backtest_summary |

DST: after Sun Nov 1 2026 (EST = UTC-5), these jobs fire before the 4:00 PM ET close or before the ~4:15 PM settle:
finviz 20:30 = 3:30 PM, backfill 20:35 = 3:35 PM, reconcile 20:36 = 3:36 PM, scan c1 21:05 = 4:05 PM, scan c2 21:11 = 4:11 PM.
reconcile_universe(30 min, 800) requires finviz to have refreshed >= 800 ticker_meta rows within 30 min.

## 7. Callers (details in callers.md)
- SPA: PostgREST only (latest_scans_with_meta, bx_movers, sector_pulse, bx_backtest_summary, bx_backtest_results). It calls no function.
- bx-scan, bx-backtest-builder, bx-alerter, bx-finviz-sync, bx-earnings-sync, bx-exchange-backfill: pg_cron only.
- ts-token: <consumer A> (python; ~100 calls/day, every ~16 min, all `?key=` from the running old process, so it must be
  restarted after the header code is deployed) and <consumer B> (Vercel cron 7:00 AM UTC daily plus a collector script; no traffic seen;
  `.env.local` lacks TS_TOKEN_KEY). The working trees of both consumers already send `x-ts-key` (uncommitted).
  Legacy `?key=` auth has since been removed (header-only).
- refresh-quotes, ts-stream, ts-probe, finviz-probe, ts-oauth-start, ts-oauth-callback: no automated callers and 0 invocations.
- Note: ts-token query-param key auth was removed (2026-10-24); the endpoint accepts the `x-ts-key` header only.

## 8. Shared helpers written by prep (supabase/functions/_shared)
- `cron_auth.ts`: `requireCron(req): Response | null` and `timingSafeEqualStr(a, b): boolean` (exported for the ts-token x-ts-key check).
  Reads env CRON_SECRET at call time.
- `pipeline_log.ts`: `startRun(fn, params?) -> Promise<number|null>`, `finishRun(id|null, {status, rows_written?, rows_expected?, error?}) -> Promise<void>`.
  Raw PostgREST fetch with SUPABASE_URL plus SUPABASE_SERVICE_ROLE_KEY, a 10 s timeout, never throws, and error is truncated to 2,000 chars.
  It needs `public.pipeline_runs` from 20_pipeline_infra. The insert sends `{fn, params, status:'running'}`, so `started_at` takes its default.
- `ts_auth.ts`: `getTsAccessToken(): Promise<string>` and `getTsToken(): Promise<{access_token, expires_at, scope}>` (use this one in ts-token).
  Cached when expires_at > now + 120 s. Stored expires_at = now + expires_in - 60 s (the existing convention). The CAS PATCH filters on
  `id=eq.1&refresh_token=eq.<urlencoded old>`. invalid_grant, a network failure, or a lost CAS all trigger a re-read, then use the winner.
  Single-flight per isolate. It reads env TRADESTATION_CLIENT_ID / TRADESTATION_CLIENT_SECRET at call time. Errors carry only the HTTP
  status and the OAuth error code. It does NOT pick the API base: callers keep `TRADESTATION_ENV` and their own TS_BASE logic.
- All three type-check under `deno check` (Deno 2), and 8 mocked unit tests pass (scratchpad, not committed).
