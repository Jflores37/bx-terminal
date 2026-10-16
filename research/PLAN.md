# ES "compression → breakout" research plan

Handoff notes from a cloud Claude Code session (2026-10-16). Full research reports with all
links: `research/notes/01-academic.md`, `02-practitioner.md`, `03-methodology.md`. Goal: test whether the
pattern "ES consolidates tightly for a few minutes, then breaks out and runs" is a real,
tradeable edge, and if so turn it into an indicator.

## Status
- Research phase done (academic, practitioner, methodology — summaries below).
- **Next step:** locate the user's ~10 years of ES historical data on their PC, inspect it,
  convert to compressed parquet in `research/data/` (split by year if any file >100MB),
  then run Phase 1 (event study).
- TradingView MCP only has ~1 week of ES 1m bars (from 2026-10-11) — fine for smoke tests,
  useless for the backtest.

## Core framing (why most of these ideas die)
1. **Hindsight bias** — you remember boxes that ran, not the ten that faked out. Count every box.
2. **Two separate claims:**
   - *Magnitude:* a tight box predicts an above-normal move. Intraday vol is U-shaped, so
     tightness MUST be normalized by time of day (a quiet 9:20 box always precedes a big 9:30).
     Vol clustering says low vol → low vol; expansion mostly comes from clock/event schedule.
   - *Direction:* the first break side predicts the run. Literature barely supports this.
3. **Tight boxes make costs huge** — 3-pt box = 12-tick stop; 2–3 ticks of slippage+commission
   = 17–25% of risk per trade.
4. **"It broke out" is near-certain** — Linnsoft: ES IB breaks ~98% of days; both sides break
   ~1/3 of days. Question is expected payoff after first break, net of costs.

## Key research findings
- **Zarattini, Aziz & Barbon (2024) "Beat the Market" (SPY):** noise area = open ± 14-day avg
  |move from open to that same minute|; trade breaks. Sharpe 1.33 net, 2007–2024. Unreplicated.
  → **Use as benchmark** on ES; also its normalization is the right "tightness" measure.
- **Baltussen, Da, Lammers & Martens (2021, JFE):** S&P intraday momentum appears only when
  dealer gamma is negative. → Gamma regime filter (start with VIX / proxy). Dim, Eraker &
  Vilkov (2024) dispute 0DTE amplification.
- **Gao, Han, Li & Zhou (2018, JFE):** first half-hour predicts last half-hour (R² ~1.6–2%).
- **Tsai, Wu et al. (2019, IEEE Access):** ORB on S&P futures 1m 2003–2013, >8%/yr, but window
  chosen in-sample.
- **Zarattini & Aziz (2023) QQQ ORB:** fails replication after spread+slippage (MQL5 blog).
- **Marshall, Cahan & Cahan (2008):** 7,846 intraday SPY rules; 0 significant after
  data-snooping correction. → Count every variant; correct for multiple testing.
- Practitioners: no credible ES backtest with costs + OOS exists. Filters (volume, delta,
  VWAP, retest, time of day) are all anecdotal. Failed-breakout fade (Mancini, Brooks
  "80% fail") is popular and untested.

## Hypothesis space
- **A. Box definition:** N-min range ÷ normal N-min range at that clock time (last 20 days)
  ← primary; also range/ATR, NR4/NR7, BB-inside-KC squeeze, realized vol vs forecast;
  shape (flat vs coil), edge touches, volume dry-up.
- **B. Location:** stops cluster outside tight ranges at obvious levels — prior day H/L,
  overnight H/L, opening range, VWAP, round numbers. Box at a level ≠ box in no-man's-land.
- **C. Break quality:** break bar size vs box, volume ratio, close outside vs wick, box
  duration, delta (if data has aggressor side).
- **D. Context:** time of day (overnight, 8:30 data, 9:30, lunch, 14:00 FOMC, last hour),
  gap, overnight range vs ATR, event days, VIX, day of week, gamma proxy.
- **E. Trade structures (test side by side):** stop entry 1 tick outside; break-then-retest;
  acceptance (hold outside k bars); fade first break; Crabel two-sided bracket, flip once.
- **F. Exits:** 1R/2R/3R, measured move, time stop, ATR trail, exit on re-entry to box, EOD.
- **G. Meta-labeling:** primary = box break; secondary classifier (GBM, purged CV,
  triple-barrier labels) predicts which breaks run, using A–D. Filters only.

## Phases
0. **Data hygiene:** sessions (RTH 08:30–15:00 CT), rolls (trade actual front contract with
   volume roll; avoid ratio-adjusted for tick-based rules; Panama OK), UTC storage →
   America/Chicago, bar-open vs bar-close labeling, missing minutes, halts, half-days.
1. **Is it real?** Grid over N × tightness. Forward 15/30/60-min range and signed return in
   units of time-of-day-normal range vs baseline of non-compressed boxes at same clock
   time/weekday. Output: lift heatmap. No trading yet.
2. **Direction:** P(first break continues) by time of day and context.
3. **Trading rules with costs:** 1 tick slippage entry + stop, ~$4 RT commission (ES $12.50/tick,
   MES $1.25). Same-bar stop+target → stop first (report both). Edge must survive ~2 ticks RT.
   Box fixed only from closed bars; entry fills on t+1 or later.
4. **Meta-labeling filter (G).**
5. **Validation:** walk-forward (fit 2y / test 6m), purge + embargo, lock last ~18 months as a
   one-touch holdout, deflated Sharpe / Hansen SPA (`arch` package) / CSCV-PBO, t-stat > 3,
   ≥300–500 independent events, random-entry + permutation nulls, regime splits.
6. **Ship:** TradingView Pine indicator + results page in bx-terminal Backtest tab.

## Pre-registered v0 rule
1-min bars, RTH only. Box = last 10 min, range ≤ 0.5 × median 10-min range at that clock time
over prior 20 sessions (and ≥ 1 pt). Entry = stop 1 tick outside box, first break within 15
min. Stop = opposite box edge. Record MFE/MAE, results at 1R/2R/3R and 30-min time exit.
Benchmark = Zarattini noise-area strategy on the same data.

## Tooling
Python + polars/pandas for the event study; vectorbt for sweeps (then confirm event-driven);
NautilusTrader for final tick/1s validation. Code lives in `research/`, separate from the
React app.
