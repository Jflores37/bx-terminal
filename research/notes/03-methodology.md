# Backtest methodology checklist — ES intraday compression breakout

Source: research subagent, 2026-10-16. Vendor/TradingView details confirmed via search; prices
not confirmed are marked "verify". TradingView help page fetch failed (DNS).

## 1. Data
- **Databento** (https://databento.com/pricing, https://databento.com/futures) — CME MDP3 15+
  years: tick, MBP-1, MBO, 1s and 1m OHLCV. Pay-per-GB from ~$0.50/GB, $125 free credit. ES 1m
  for 10+ yrs is cheap; check tick/MBP-1 cost with the estimator first. UTC ns timestamps. Best
  value for 1s/tick to resolve fills.
- **FirstRate Data** (https://firstratedata.com/i/futures/ES) — 1m ES from 2008, continuous and
  per-contract; unadjusted / absolute / ratio adjusted. Updates $99.95/yr; one-time price: verify.
- **Kibot** — cheap long history; reports of zero-volume ticks and odd jumps
  (https://futures.io/brokers/44223-bad-tick-data.html). Validate first.
- Portara (institutional), IQFeed (subscription, limited tick depth), CME DataMine
  (institutional), TradingView (plan-limited, awkward export — charts only).
- **Rolls:** for a flat-by-EOD strategy, skip back-adjustment; trade actual front contract with a
  volume roll (~8 days before 3rd Friday of Mar/Jun/Sep/Dec). If continuous is required: Panama
  (additive) keeps point ranges and $ P&L; ratio keeps % but moves ranges off the 0.25 grid —
  don't use ratio for tick/point rules.
- **Sessions (CT):** RTH 08:30–15:00; ETH 17:00–16:00 with 16:00–17:00 halt. Test RTH and
  overnight separately.

## 2. Costs
- ES tick 0.25 = $12.50; MES $1.25.
- Commission all-in ~$3–5 RT ES, ~$1–1.50 MES (check broker).
- Slippage on stop entries: base 1 tick/side; stress 2–3 ticks on entry; more around 08:30 CT
  data, 09:30 ET, FOMC. Report edge per trade in ticks; must survive ~2 ticks RT.

## 3. Bar-data pitfalls
- Stop and target in same bar: assume stop first, or resolve with 1s/tick. Report both; a big
  gap means the ambiguity is the edge.
- Look-ahead: box fixed only from bars closed by t; entry stop at box high + 1 tick fills on t+1
  or later. Never define box with a bar then enter on that bar's high.
- Pre-register the compression rule (N min, ≤ k ticks / ≤ q×ATR / ≤ time-of-day percentile).
  Every change to N/k/q is another trial.
- Count every triggered breakout, not just runners; both directions or explicit side rule.
- Store UTC, convert with `America/Chicago`; watch US/EU DST mismatch weeks; check bar-open vs
  bar-close labeling per vendor.
- Drop/flag halt and holiday half-days; check bad ticks, missing minutes.

## 4. Statistical rigor
- **Event study:** condition on compression; forward returns at H = 5/15/30/60 min + MFE/MAE in
  ticks; baseline = non-compression minutes matched on time of day and weekday.
- **Nulls:** random entry with same time-of-day mix/stops/targets/holds (1,000+ reps);
  permutation (shuffle event dates; block-bootstrap within day). Key: does compression shift
  forward range/direction beyond vol clustering?
- **Multiple testing:** Deflated Sharpe (https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2460551),
  White's RC (https://doi.org/10.1111/1468-0262.00152), Hansen SPA
  (https://doi.org/10.1198/073500105000000063) — `arch` package; PBO/CSCV
  (https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2326253).
- **Validation:** anchored/rolling walk-forward (fit 2y → test 6m); purge + embargo (López de
  Prado, AFML); lock final holdout (e.g., 2025–2026), touch once.
- **Sample size:** ≥300–500 independent events (one per box); bootstrap CIs on mean ticks/trade;
  t-stat ≈ 3 not 2 (Harvey, Liu & Zhu, https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2249314).
- **Regime splits** (must hold or be pre-stated filters): VIX terciles; trend vs range days
  (classified from prior day/open only); FOMC/CPI/NFP vs normal; pre/post-2020; roll week.

## 5. Tooling
- Python + pandas/polars for the event study (vectorized, strict past-only windows).
- vectorbt (https://vectorbt.dev) — fast sweeps, easy to fool yourself; confirm event-driven.
- backtesting.py — simple, bar-only (same-bar fill problem).
- NautilusTrader (https://nautilustrader.io) — event-driven, native Databento adapter
  (https://nautilustrader.io/docs/latest/tutorials/databento_overview); best final validation.
- TradingView Pine — without Bar Magnifier assumes fixed intrabar path; Bar Magnifier
  (https://www.tradingview.com/blog/en/accurate-backtesting-with-bar-magnifier-31746) uses lower
  TF, premium, plan-limited. Watch repainting (`calc_on_every_tick`, `request.security`). Visual
  check, weak proof.
- NinjaTrader / Sierra Chart replay — tick-level forward test of execution after stats hold.

**Bottom line:** first show compression shifts forward MFE/MAE vs time-of-day-matched baseline;
then edge must survive ~2 ticks cost, tick-resolved fills, DSR/SPA, untouched holdout. Only then
tune box params.
