# Environment snapshot

Project `wefobwdspqzxbesbnzoc` ("Bx-trender"), org `ravgqvnwygvamvdqpyfi` (JeremyFTrades), region us-east-2.
Captured 2026-10-24. No secret VALUES appear anywhere in this file.

## Plan and limits
- **Org plan: FREE** (`tier_free`, from get_organization).
- Postgres 17.6 (aarch64), `max_connections` 60, `shared_buffers` 28672 x 8 kB (224 MB), DB size 163 MB (free tier cap 500 MB).
- Edge Functions on Free (Supabase docs): **150 s wall clock per invocation**, **2 s CPU time** per request (async I/O
  excluded), 256 MB memory, 500K invocations/month. Evidence the wall-clock limit is what kills bx-scan: on 10/23
  bx-scan-daily-c3 booted at 9:17:00 PM UTC and shut down at 9:19:30.9 PM UTC = 150.6 s, response
  `546 {"code":"WORKER_RESOURCE_LIMIT","message":"Function failed due to not having enough compute resources"}`.
  bx-scan c2 the same day took 147.9 s (2 s under the limit) for 410 tickers.
- Role settings (pg_db_role_setting):
  - `anon`: statement_timeout=3s, pgrst.db_max_rows=10000
  - `authenticated`: statement_timeout=8s, pgrst.db_max_rows=10000
  - `authenticator`: statement_timeout=8s, lock_timeout=8s, session_preload_libraries=safeupdate, pgrst.db_max_rows=10000
  - `service_role`: pgrst.db_max_rows=10000 (no statement_timeout override -> server default 120 s)
  - `postgres`: search_path="$user", public, extensions
  - all roles: app.settings.jwt_exp=3600
- Server `statement_timeout` = 120000 ms.
- `latest_scans_with_meta?timeframe=eq.daily` = 1,365 ms execution (EXPLAIN ANALYZE as postgres) vs anon's 3 s timeout.

## Extensions installed
| extension | schema | version |
|---|---|---|
| plpgsql | pg_catalog | 1.0 |
| pg_cron | pg_catalog | 1.6.4 |
| pg_net | extensions | 0.20.0 |
| supabase_vault | vault | 0.3.1 |
| pgcrypto | extensions | 1.3 |
| uuid-ossp | extensions | 1.1 |
| pg_stat_statements | extensions | 1.11 |
| http | extensions | 1.6 |

Not installed (available): pgsodium, pg_graphql, pgmq, pg_jsonschema, etc.

### supabase_vault
- **Available and usable**: `vault.decrypted_secrets` exists with columns
  `id, name, description, secret, decrypted_secret, key_id, nonce, created_at, updated_at`.
- `postgres` can SELECT `vault.decrypted_secrets` and EXECUTE `vault.create_secret(text,text,text,uuid)`.
  `public.invoke_edge_function` is owned by postgres and SECURITY DEFINER, so it can read the vault.
- **Vault currently holds 0 secrets** -> the `cron_secret` secret (C11) must be created by the orchestrator.

### pg_net
- Functions: `net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer)`,
  `net.http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer)` (regprocedure signatures:
  `http_post(text,jsonb,jsonb,jsonb,integer)`, `http_get(text,jsonb,jsonb,integer)`).
- `net._http_response` columns: `id bigint, status_code integer, content_type text, headers jsonb, content text,
  timed_out boolean, error_msg text, created timestamptz` (id = the request_id returned by http_post).
- `net.http_request_queue` columns: `id bigint, method text, url text, headers jsonb, body bytea, timeout_milliseconds integer`.
- Settings: `pg_net.ttl = 6 hours` (responses purged after ~6 h), `pg_net.batch_size = 200`,
  `pg_net.username = postgres`, `pg_net.database_name = postgres`.
- At capture `net._http_response` held 6 rows (ids 1064..1069, all from 10/23 8:30-9:25 PM UTC).

### pg_cron
- `cron.timezone = GMT` (all schedules UTC), `cron.max_running_jobs = 32`, `cron.use_background_workers = off`,
  `cron.log_run = on`, `cron.database_name = postgres`. 29 jobs, see cron_jobs.sql.

## Vault secret names
None (0 rows in vault.secrets).

## Edge function secrets (names only, from `supabase secrets list`)
SUPABASE_ANON_KEY, SUPABASE_DB_URL, SUPABASE_JWKS, SUPABASE_PUBLISHABLE_KEYS, SUPABASE_SECRET_KEYS,
SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL, TRADESTATION_CLIENT_ID, TRADESTATION_CLIENT_SECRET, TRADESTATION_REDIRECT_URI.

**NOT set** (referenced by code): `CRON_SECRET` (so today's `if (CRON_SECRET)` gates in bx-scan/bx-alerter/bx-finviz-sync
are OFF -- consistent with cron calls succeeding without any header), `SLACK_WEBHOOK_URL` (bx-alerter returns
`{"skipped":"no SLACK_WEBHOOK_URL set"}` every run), `MIN_TRANSITION_MAGNITUDE` (defaults 3.0),
`TRADESTATION_ENV` (defaults to `sim` -> bx-scan/refresh-quotes/ts-stream use `https://sim-api.tradestation.com/v3`),
`TS_TOKEN_KEY`, `TS_OWNER_ACCOUNTS`.

## Edge functions (13)
| slug | version | verify_jwt | last deployed (UTC) |
|---|---|---|---|
| ts-oauth-start | 10 | false | 2026-10-02 4:05 PM |
| ts-oauth-callback | 8 | false | 2026-04-21 5:08 PM |
| refresh-quotes | 8 | true | 2026-04-21 5:08 PM |
| ts-stream | 8 | true | 2026-04-21 5:12 PM |
| bx-scan | 12 | false | 2026-06-03 3:56 PM |
| bx-alerter | 8 | false | 2026-04-25 2:39 PM |
| bx-finviz-sync | 10 | false | 2026-06-04 2:57 AM |
| bx-exchange-backfill | 11 | false | 2026-05-12 5:28 AM |
| bx-earnings-sync | 11 | false | 2026-06-04 3:07 AM |
| bx-backtest-builder | 11 | false | 2026-06-15 4:02 AM |
| ts-probe | 2 | true | 2026-06-03 4:28 PM |
| finviz-probe | 2 | true | 2026-06-04 2:59 AM |
| ts-token | 1 | false | 2026-06-22 3:17 PM |

All `import_map: false`. supabase/config.toml now pins the same verify_jwt values.
Local CLI: supabase 2.90.0 (2.122.0 available); `supabase functions list --project-ref wefobwdspqzxbesbnzoc`
succeeds with the new config.toml present.

## Advisors at capture
- Security: `rls_enabled_no_policy` (INFO) on private.tradestation_tokens_bak_20261002, public.alert_state, public.app_settings,
  public.tradestation_tokens, public.tradestation_tokens_bak; `materialized_view_in_api` (WARN) on public.bx_backtest_summary.
- Performance: `auth_rls_initplan` (WARN) x4 on profiles (3 policies) + saved_filters; `no_primary_key` on
  private.tradestation_tokens_bak_20261002; `unused_index` x8 (saved_filters_user_id_idx, tickers_market_cap_idx,
  tickers_float_idx, quotes_pct_change_idx, quotes_intraday_idx, quotes_rvol_idx, quotes_vol_total_idx, quotes_price_idx).
- All public views are `security_invoker=true` (so the security_definer_view lint does not fire).
