# Tables snapshot (schemas public + private)

Project `wefobwdspqzxbesbnzoc`, captured 2026-10-24 (~12:15 AM ET). Read-only reference.
Row counts: exact `count(*)` at capture (pg_class.reltuples in brackets; -1 = never analyzed).

**Grants pattern.** Unless noted, every public table has the Supabase default
`postgres/anon/authenticated/service_role = arwdDxtm` (SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN).
RLS restricts DML through PostgREST, but **TRUNCATE is not covered by RLS** (anon cannot reach it through
PostgREST, but it is a needless privilege). Schema `private` ACL: `postgres=UC` only (no anon/authenticated USAGE).

RLS is ENABLED on every table below and FORCED only on `public.tradestation_tokens_bak`.

Triggers: `auth.users` -> `on_auth_user_created AFTER INSERT ... EXECUTE FUNCTION handle_new_user()`;
`public.saved_filters` -> `saved_filters_touch BEFORE UPDATE ... EXECUTE FUNCTION touch_updated_at()`.

---

## public.bx_scans — 127,212 rows [127,102], 21 MB
| column | type | default | null |
|---|---|---|---|
| id | bigint | nextval('bx_scans_id_seq') | NOT NULL |
| ticker | text | | NOT NULL |
| timeframe | text | | NOT NULL |
| bx | numeric(6,2) | | NOT NULL |
| prev_bx | numeric(6,2) | | null |
| scan_date | date | | NOT NULL |
| created_at | timestamptz | now() | null |
| bias_direction | text | | null |
| bias_oscillator | numeric | | null |
| bias_in_zone | boolean | | null |

- PK `bx_scans_pkey (id)`; UNIQUE `bx_scans_ticker_timeframe_scan_date_key (ticker, timeframe, scan_date)`
- CHECK `bx_scans_timeframe_check`: timeframe in ('daily','weekly','monthly')
- Indexes: `bx_scans_tf_date_idx (timeframe, scan_date DESC)`, `bx_scans_ticker_idx (ticker)`
- Policies: `public_read_scans` [SELECT] to public using (true)
- Data facts: daily max scan_date 2026-10-23 with 820 rows (active universe 1,081 -> 75.9%); per-day daily row counts
  over the last 6 weeks swing 275..1,089 (chunk failures). Weekly max 2026-10-18 (a SUNDAY = wall-clock run date), 1,055 rows.
  Monthly max 2026-10-01 (wall-clock run date; that month's bar was in progress), 1,096 rows. Earliest scan_date 2026-04-25.

## public.bx_backtest_results — 308,920 rows [308,469], 128 MB
| column | type | default | null |
|---|---|---|---|
| id | bigint | nextval('bx_backtest_results_id_seq') | NOT NULL |
| ticker | text | | NOT NULL |
| timeframe | text | | NOT NULL |
| signal_type | text | | NOT NULL |
| signal_date | date | | NOT NULL |
| bx_at_signal | numeric | | null |
| prev_bx | numeric | | null |
| price_at_signal | numeric | | NOT NULL |
| price_5d | numeric | | null |
| price_20d | numeric | | null |
| price_60d | numeric | | null |
| price_120d | numeric | | null |
| ret_5d | numeric | | null |
| ret_20d | numeric | | null |
| ret_60d | numeric | | null |
| ret_120d | numeric | | null |
| bias_at_signal | text | | null |
| computed_at | timestamptz | now() | NOT NULL |
| bias_direction | text | | null |
| bias_oscillator | numeric | | null |
| bias_in_zone | boolean | | null |
| mtf_daily_bias | text | | null |
| mtf_weekly_bias | text | | null |
| mtf_monthly_bias | text | | null |
| mtf_daily_bx | numeric | | null |
| mtf_weekly_bx | numeric | | null |
| mtf_monthly_bx | numeric | | null |

- PK `bx_backtest_results_pkey (id)`; UNIQUE `bx_backtest_results_ticker_timeframe_signal_type_signal_dat_key (ticker, timeframe, signal_type, signal_date)`
- Indexes: `idx_backtest_ticker (ticker)`, `idx_backtest_signal (signal_type)`, `idx_backtest_date (signal_date)`, `idx_backtest_tf (timeframe)`
- Policies: `public_read_backtest` [SELECT] to public using (true)
- Signal types (all 3 timeframes): bearish_to_bullish, bearish_to_neutral, bullish_to_bearish, bullish_to_neutral, neutral_to_bearish, neutral_to_bullish
- Data facts:
  - daily: 147,094 rows, 1,901 tickers, signal_date 2024-07-05..2026-10-16, computed_at max 2026-10-18 12:03 UTC
  - weekly: 102,395 rows, 1,811 tickers, signal_date 2017-02-20..2026-06-12, computed_at max **2026-06-15** (stale 4 months)
  - monthly: 59,431 rows, 1,874 tickers, signal_date 1971-01-01..2026-06-12, computed_at max **2026-06-14** (stale)
  - weekly signal_date day-of-week: Mon 101,659 / Tue 171 / Wed 1 / Fri 564 -> dates are the week START (Yahoo bar timestamp), not the last trading day.
  - monthly signal_date: Mon 24,627, other days ~5-6k each incl. 10,453 Sat/Sun -> 1st calendar day of the month.
  - Outliers: max ret_60d daily 2,627%, weekly 399,900%, monthly 82,373%; rows with |ret_5d|>100 or |ret_20d|>200 or
    |ret_60d|>300 or |ret_120d|>500: daily 520, weekly 1,725, monthly 6,352. price_at_signal < 1: daily 238, weekly 196, monthly 448.

## public.ticker_meta — 1,905 rows [1,905], 664 kB
| column | type | default | null |
|---|---|---|---|
| ticker | text | | NOT NULL |
| exchange | text | | null |
| market_cap_billions | numeric | | null |
| price | numeric | | null |
| avg_volume_millions | numeric | | null |
| sector | text | | null |
| updated_at | timestamptz | now() | null |
| industry | text | | null |
| next_earnings_date | date | | null |
| fifty_two_week_high | numeric | | null |
| fifty_two_week_low | numeric | | null |

- PK `ticker_meta_pkey (ticker)`; Policies: `public_read_meta` [SELECT] to public using (true)
- Data facts: updated_at max 2026-10-23 20:30 UTC (finviz sync); 508 rows have next_earnings_date < NY today (stale, never cleared).

## public.universe — 1,952 rows (1,081 active) [1,952], 312 kB
| column | type | default | null |
|---|---|---|---|
| ticker | text | | NOT NULL |
| active | boolean | true | null |
| added_at | timestamptz | now() | null |

- PK `universe_pkey (ticker)`; Policies: `public_read_universe` [SELECT] to public using (true)

## public.alert_state — 0 rows [-1], 16 kB
| column | type | default | null |
|---|---|---|---|
| alert_key | text | | NOT NULL |
| posted_at | timestamptz | now() | null |

- PK `alert_state_pkey (alert_key)`; Policies: none (RLS on, service_role only in practice)

## public.app_settings — 2 rows [-1], 32 kB
| column | type | default | null |
|---|---|---|---|
| key | text | | NOT NULL |
| value | text | | NOT NULL |
| updated_at | timestamptz | now() | null |

- PK `app_settings_pkey (key)`; Policies: none (anon/authenticated cannot read rows)
- Keys present (values not copied): see bx-finviz-sync. Last updated 2026-05-12.

## public.tradestation_tokens — 1 row [1], 432 kB
| column | type | default | null |
|---|---|---|---|
| id | integer | 1 | NOT NULL |
| access_token | text | | null |
| refresh_token | text | | null |
| expires_at | timestamptz | | null |
| scope | text | | null |
| updated_at | timestamptz | now() | NOT NULL |

- PK `tradestation_tokens_pkey (id)`; CHECK `tradestation_tokens_id_check (id = 1)`
- Grants: **postgres + service_role only** (anon/authenticated revoked). Policies: none.
- 432 kB for 1 row = heavy update churn (ts-token refreshes on every call, ~100/day).

## public.tradestation_tokens_bak — 1 row [-1], 32 kB
Same columns as tradestation_tokens. PK `tradestation_tokens_bak_pkey (id)`, CHECK `tradestation_tokens_id_check (id = 1)`.
RLS enabled AND FORCED, no policies. Grants: postgres + service_role only. (Leftover backup holding token material.)

## public.profiles — 0 rows [-1], 16 kB
| column | type | default | null |
|---|---|---|---|
| id | uuid | | NOT NULL |
| display_name | text | | null |
| created_at | timestamptz | now() | NOT NULL |

- PK `profiles_pkey (id)`; FK `profiles_id_fkey (id) -> auth.users(id) ON DELETE CASCADE`
- Policies: `profiles_select_self` [SELECT] using (auth.uid() = id); `profiles_insert_self` [INSERT] check (auth.uid() = id);
  `profiles_update_self` [UPDATE] using (auth.uid() = id)  (advisor: auth_rls_initplan -> wrap as (select auth.uid()))

## public.saved_filters — 0 rows [-1], 24 kB
| column | type | default | null |
|---|---|---|---|
| id | uuid | gen_random_uuid() | NOT NULL |
| user_id | uuid | | NOT NULL |
| name | text | | NOT NULL |
| config | jsonb | | NOT NULL |
| is_default | boolean | false | NOT NULL |
| created_at | timestamptz | now() | NOT NULL |
| updated_at | timestamptz | now() | NOT NULL |

- PK `saved_filters_pkey (id)`; FK `saved_filters_user_id_fkey (user_id) -> auth.users(id) ON DELETE CASCADE`
- Index `saved_filters_user_id_idx (user_id)` (unused)
- Policies: `saved_filters_all_own` [ALL] using (auth.uid() = user_id) check (auth.uid() = user_id) (advisor: auth_rls_initplan)

## public.quotes — 0 rows [-1], 56 kB  (written only by refresh-quotes; currently empty)
| column | type | default | null |
|---|---|---|---|
| symbol | text | | NOT NULL |
| price | numeric | | null |
| pct_change | numeric | | null |
| intraday_pct_change | numeric | | null |
| rvol | numeric | | null |
| vol_1m | numeric | | null |
| vol_5m | numeric | | null |
| vol_total | numeric | | null |
| capital_total | numeric | | null |
| volatility | numeric | | null |
| atr | numeric | | null |
| vwap | numeric | | null |
| high_of_day | numeric | | null |
| low_of_day | numeric | | null |
| pct_from_vwap | numeric | CASE WHEN vwap > 0 AND price IS NOT NULL THEN (price - vwap) / vwap * 100 ELSE NULL END | null |
| updated_at | timestamptz | now() | NOT NULL |

- PK `quotes_pkey (symbol)`; FK `quotes_symbol_fkey (symbol) -> tickers(symbol) ON DELETE CASCADE`
- Indexes (all unused): quotes_pct_change_idx, quotes_intraday_idx, quotes_rvol_idx, quotes_vol_total_idx, quotes_price_idx
- Policies: `quotes_read_authenticated` [SELECT] to authenticated using (true)
- Note: pct_from_vwap is a column DEFAULT, not a generated column (computed only at INSERT time from the inserted values).

## public.tickers — 279 rows [279], 104 kB  (legacy "Stock Edge" list used by refresh-quotes)
| column | type | default | null |
|---|---|---|---|
| symbol | text | | NOT NULL |
| name | text | | null |
| exchange | text | | null |
| sector | text | | null |
| market_cap | numeric | | null |
| float_shares | numeric | | null |
| updated_at | timestamptz | now() | NOT NULL |

- PK `tickers_pkey (symbol)`; Indexes (unused): tickers_market_cap_idx, tickers_float_idx
- Policies: `tickers_read_authenticated` [SELECT] to authenticated using (true)

## private.tradestation_tokens_bak_20261002 — 1 row [-1], 16 kB
Columns: id integer, access_token text, refresh_token text, expires_at timestamptz, scope text, updated_at timestamptz (all nullable, no defaults).
No PK, no indexes, RLS enabled (not forced), no policies. Grants: postgres only. (Backup holding token material.)

---

### Tables that do NOT exist yet (created by other units per contract)
`public.edge_call_log` (C2), `public.pipeline_runs` (C3), `public.bx_backtest_baseline` (C6). Vault has no secrets yet (C11 `cron_secret`).
