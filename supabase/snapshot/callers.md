# Who calls each edge function

Captured 2026-10-24. Sources: `cron.job` commands, `<repo-root>\src`, a grep of 13 sibling repos
(<consumer B>, <consumer A>, gex-dashboard, gex_live, market-data, orderflow-delta, market-metrics-dashboard,
Market-dashboard, dodgy-ifvg-bot, trading-alerts-bot, research, paper-futures, viraledge; node_modules/.git/data/dist/venv
excluded), and edge logs (`function_edge_logs` / `function_logs`, windows 10/18 7 AM-7 PM ET, 10/21-10/24).

**The SPA (`bx-terminal/src`) calls NO edge function.** It reads PostgREST only, with the anon key
(`App.jsx sbFetch`): `latest_scans_with_meta?timeframe=eq.X&select=*&order=scan_date.desc&limit=10000`,
`bx_movers?timeframe=eq.X&select=*&order=abs_delta.desc&limit=100`, `sector_pulse?timeframe=eq.X&select=*&order=avg_bx.desc`,
`bx_backtest_summary?timeframe=eq.X&select=*`, `bx_backtest_results?ticker=eq.T&timeframe=eq.X&select=*&order=signal_date.desc&limit=20`.

No sibling repo calls any bx-* function, refresh-quotes, ts-stream, ts-probe, finviz-probe or the OAuth pair.
(`<consumer A>/tools/setup_catalog/data2.py` and `results/setup_catalog*` only MENTION bx-scan /
bx-backtest-builder in descriptive text.) `market-metrics-dashboard` hits `functions/v1/...` of its OWN project
(fetch-finviz-scanners, fetch-fred, fetch-cnbc-premarket, compute-should-i-trade, fetch-intraday-quotes-movers), not this one.

| function | verify_jwt | callers | observed traffic |
|---|---|---|---|
| bx-scan | false | cron 21-23 (daily c1-c3, Mon-Fri 9:05/9:11/9:17 PM UTC), 24-26 (weekly, Sun 2:00/2:06/2:12 PM UTC), 27-29 (monthly, 1st 2:00/2:06/2:12 PM UTC); all `source=tradestation&offset=0/410/820&limit=410` | daily 3/day. 10/23: c1 200 (~13 s, 1.1 s CPU), c2 200 (147.9 s, 0.97 s CPU), c3 **546 WallClockTime** at 150.6 s (0.6 s CPU). 10/22: 3x200 (1,077 rows). 10/21: only 2 edge-log lines (820 rows). Weekly 10/18: 3x200 in 8-15 s (1.1 s CPU per 410 tickers). |
| bx-backtest-builder | false | cron 19 (`timeframe=daily&offset=0&limit=1000`), 20 (`daily&offset=1000&limit=1000`), 17 (`weekly`), 18 (`monthly`), Sun 12:00-12:10 PM UTC | 10/18: daily-1 **546 CPU Time exceeded** (2,000 ms CPU, 15 s), daily-2 200 (81 tickers, 294 ms CPU, 6.5 s), weekly **546 CPU** (24 s), monthly **546 CPU** (15 s). Explains weekly/monthly computed_at stuck at 6/14-6/15 and daily rows only partially refreshed. |
| bx-alerter | false | cron 2 (daily Mon-Fri 9:25 PM UTC), 4 (weekly Sun 2:20 PM UTC), 6 (monthly 1st 2:20 PM UTC) | 1/day, 200 `{"skipped":"no SLACK_WEBHOOK_URL set"}` (~0.5 s). Reads view zone_transitions (expects nonexistent column bx_previous_scan). |
| bx-finviz-sync | false | cron 7 (Mon-Fri 8:30 PM UTC), 8 (Sun 1:30 PM UTC), 9 (1st 1:30 PM UTC) | 1/day, 200 in 3-6 s, 1,081 rows; reads app_settings finviz_auth_token/finviz_filter; upserts ticker_meta + universe(active=true). |
| bx-exchange-backfill | false | cron 10 (Mon-Fri 8:35 PM UTC), 11 (Sun 1:35 PM UTC), 12 (1st 1:35 PM UTC) | **500 every run** (10/18, 10/21, 10/22, 10/23): `upsert 400 PGRST102 "All object keys must match"` (rows built with different key sets). ~14 s, 1.3 s CPU. |
| bx-earnings-sync | false | cron 13 (Sun 3:00 PM UTC), 14 (Sun 1:40 PM UTC), 15 (Wed 8:40 PM UTC) -- note two Sunday jobs | 200 (16-34 s). Calls api.nasdaq.com 90 dates. |
| refresh-quotes | true | none found (no cron, no SPA, no repo) | 0 invocations in logs. Legacy "Stock Edge" (writes public.quotes, empty). |
| ts-stream | true | none found | 0 invocations. Legacy websocket proxy. |
| ts-probe | true | none (decommissioned, returns 410) | 0 |
| finviz-probe | true | none (decommissioned, returns 410) | 0 |
| ts-token | false | **<consumer A>** (`src/data_layer.py` `_ts_refresh_http`, env `TS_TOKEN_BROKER_URL` + `TS_TOKEN_BROKER_KEY`; working-tree copy already sends header `x-ts-key` and strips `key=`; file is MODIFIED/uncommitted, last commit 15c2030 10/21). **<consumer B>** (`src/lib/tradestation-api.ts fetchTsAccessToken`, `src/app/api/cron/tradestation/route.ts` Vercel cron `0 7 * * *` UTC, `collector/src/backfill-equity.ts`; env `TS_TOKEN_URL` + `TS_TOKEN_KEY`; working tree already uses header + strips key=, files MODIFIED/uncommitted). | ~100/day, every ~16 min around the clock, ALL `python-requests/2.32.3` = <consumer A> running process, ALL `GET ...?key=<value>` (old code in memory), all 200, 1.3-5 s each. Legacy query-param auth was subsequently removed (header-only). No <consumer B> (node) traffic in the sampled windows. |
| ts-oauth-start | false | manual browser only (comment: "open this URL in a browser") | 0 |
| ts-oauth-callback | false | TradeStation redirect (env TRADESTATION_REDIRECT_URI) | 0 |

## Consumer config facts (values not copied)
- `<consumer A>/.env`: has `TS_TOKEN_BROKER_URL` (no `key=` in it) and `TS_TOKEN_BROKER_KEY`. The live process
  must be **restarted** to pick up the header-sending code before the header-only cutover.
- `<consumer B>/.env.local`: `TS_TOKEN_URL` still CONTAINS `key=` and there is **no TS_TOKEN_KEY** line; the new
  code strips key= and throws "TS_TOKEN_KEY missing". Vercel project env for <consumer B> needs `TS_TOKEN_KEY` (unverified).
- ts-token today refreshes the TradeStation token on EVERY call (no cache), ~100 refreshes/day, racing with bx-scan's own refresh.
