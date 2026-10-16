# Practitioner / social research — ES consolidation breakouts

Source: research subagent, 2026-10-16. Reddit threads rarely surfaced in search; edgeful.com and
mql5.com fetches failed (DNS), so their figures are from search excerpts.

**Bottom line:** practitioners share heuristics. No credible ES backtest with costs and OOS
found. Best evidence is descriptive (how often levels break). The one careful replication of a
published ORB came out ≈ zero after costs.

## 1. Box definitions
- **Opening range / initial balance** — most common on ES. OR = first 5/15/30 min from 9:30 ET;
  IB = 9:30–10:30 ET. NexusFi calls 15-min OR the "sweet spot" for ES/NQ.
  https://nexusfi.com/a/strategies/opening-range-breakout
- **N-bar range detectors** — e.g., free TradingView "ES Breakout Toolkit" (5-min boxes, teaser
  for paid, no stats).
  https://www.tradingview.com/script/Opw1tJhh-ES-Breakout-Toolkit-Consolidation-Range-Detector-Free/
- **NR7 / inside day + NR4 (Crabel)** — compression screen, no direction; bracket both sides.
  https://www.luxalgo.com/library/concept/nr4-nr7-narrow-range-bars.md ,
  https://quantifiedstrategies.substack.com/p/we-improved-the-nr7-trading-strategy (paywalled)
- **TTM Squeeze** — many TV scripts, no ES stats. EliteTrader user: "extensive intraday
  backtests" "very poor to negative" (anecdote).
  https://www.elitetrader.com/et/threads/ttm-squeeze-indicator-users.118489/
- **Multi-day balance / "coil"** — Adam Mancini: multi-day ranges = "breakout soon"; 2 weeks
  consolidation → 2 weeks trend heuristic.
  https://tradecompanion.substack.com/p/day-3-of-consolidation-breakout-soon
- **Volume-profile value area** — "80% rule"; forum tests reportedly ~60%, definition-dependent
  (promotional source). https://www.eltraderfinanciado.com/en/blog/volume-profile

## 2. Confirmation filters (all anecdotal)
- Volume-led break then pullback to level (Mancini); enter retest, not first break.
- Order flow: break with flat/negative cum delta = trap; new high with lower delta high =
  absorption. Bookmap: breakout buyers "small and late."
  https://bookmap.com/blog/breakout-or-fakeout-the-3-point-checklist-for-confirmation ;
  ATAS: clean retests rare on noisy ES. https://atas.net/blog/break-and-retest-strategy/
- Al Brooks: "80% of breakout attempts fail" without strong follow-through; his slides also say
  50% for first breakout (inconsistent).
  https://www.brookstradingcourse.com/support-forum/12-market-cycle/breakout-fail/
- VWAP side, 9:30–10:30 window, overnight H/L, prior-day levels; TradeZella "no-trade zone"
  between prior-day high and premarket low. Untested.

## 3. Exits
- Stop at opposite side of box; some use midpoint (unverified vendor claim: price returns to IB
  mid 65–75% of days).
- Measured move of box height (Brooks); IB extensions 25/50/75/100%.
  https://www.tradingview.com/script/lR2POs1Y-Initial-Balance-Extensions
- Time stops; Crabel-style day exits; EOD flat.

## 4. Failed breakouts
- Dominant complaint; reverse trade popular. Mancini's "Failed Breakdown" (flush lows, trap
  shorts, go long); claims ~90% of ES selloffs in uptrends are bear traps (unbacked).
  https://tradecompanion.substack.com/p/spx-is-coiled-tightly-trend-leg-incoming
- **Linnsoft ES stats** (older, no P&L):
  - IB break, 1,000 days to 2010: high only 36.6%, low only 29.7%, both 31.6%, none 2.1%.
    2015–2025: ≥1 side broke on 97.8% of days.
  - 63% of first IB breaks within 30 min after IB close.
  - RTH broke both overnight H and L on 279/1,046 days; stayed inside on 44.
  - https://linnsoft.com/comment/1972 , https://linnsoft.com/topic/open-period-breakout-statistics-time-day

## 5. Published backtests (credibility)
- **Zarattini & Aziz 5-min ORB, QQQ** — ~24% hit, +0.13R/trade; commission only, no OOS.
  https://concretumgroup.com/a-profitable-day-trading-strategy-for-the-u-s-equity-market/
- **MQL5 replication, NQ/SPX/Dow/DAX/FTSE CFDs** — gross matched paper; net of spread+slippage
  (~6–12% of risk/trade) ≈ zero, nothing significant. Most credible item, and negative.
  https://www.mql5.com/en/blogs/post/776235
- **Edgeful 5-min ORB ES** — "+108% in 6 months" on $10k; marketing, short window, costs unclear.
  https://www.edgeful.com/blog/posts/5-minute-opening-range-breakout-es-strategy
- **TradeThatSwing ORB (NQ)** — 114 trades, 74.6% wins, PF 2.5, no costs.
  https://tradethatswing.com/opening-range-breakout-strategy-up-400-this-year
- **r/algotrading micro Russell range breakout** — ~300 trades, 49.7% wins, PF 1.46, $4 fees,
  no slippage, not forward-tested.
  https://cal1.lr.ggtyler.dev/r/algotrading/comments/1gchopm/range_breakout_strategy
- **Backtests Not Signals (MNQ ORB)** — claims commissions, margin, OOS; paywalled.
  https://backtestsnotsignals.substack.com/p/opening-range-breakout-real-edge
- **2005 eSignal E-mini thread** — 535 trades, $831 net before costs; wiped out at ~$15 RT.

## Takeaways
- Evidence: RTH almost always breaks IB/overnight range; both IB sides break ~30% of days; ORB
  edges on index products are thin enough for ~1 tick + fees per side to erase.
- Anecdote: all filters, 80/90% failure claims, failed-breakout reversal profitability.
- Test breakout and its failed-breakout reversal as a pair, with ~1 tick slippage/side + fees,
  walk-forward / OOS.
