# Academic research survey — compression → breakout on ES

Source: research subagent, 2026-10-16. Fetch tool failed on most hosts (SSRN, unisg, repec,
mql5), so figures come from search abstracts/summaries, not full PDFs. Items marked
(unverified) are from memory or secondary sources.

## 1. Opening Range Breakout
- **Crabel (1990), *Day Trading with Short Term Price Patterns and ORB*** — origin of ORB and
  NR4/NR7. Out of print; not peer-reviewed (unverified stats).
- **Holmberg, Lönnbark & Lundström (2013), FRL 10(1):27–33** — ORB on long crude oil futures
  sample: returns significantly above zero, win rate beats a fair game. No cost-adjusted figures
  in abstract. https://www.sciencedirect.com/science/article/abs/pii/S1544612312000438
- **Tsai, Wu et al. (2019), IEEE Access 7:32061** — 1-min DJIA, **S&P 500**, NASDAQ, HSI, TAIEX
  futures 2003–2013. Annual returns >8% in all five (p<3%), best TAIEX 20.28%. Best opening-range
  window was short in US markets. Most ES-relevant academic ORB result; window chosen in-sample.
  https://ieeexplore.ieee.org/document/8641124/
- **Zarattini & Aziz (2023), SSRN 4416622** — 5-min ORB on QQQ 2016–2023, 33% annualized alpha
  net of commissions; TQQQ 1,484% vs 169% B&H QQQ. Commissions only; no spread/slippage, no OOS.
  Independent CFD replication across 5 indices (https://www.mql5.com/en/blogs/post/776235)
  reproduced gross edge on Nasdaq, net ≈ zero everywhere (blog, not paper).
  https://papers.ssrn.com/abstract=4416622
- **Zarattini, Barbon & Aziz (2024), "A Profitable Day Trading Strategy for the U.S. Equity
  Market"** — top-20 "Stocks in Play" 5-min ORB: >1,600% net, Sharpe 2.81, 36% alpha; all stocks
  far weaker; QuantConnect recreation Sharpe 2.4. Edge relies on abnormal volume/news filter —
  dimension ES doesn't have. https://alexandria.unisg.ch/handle/20.500.14171/122125

## 2. Intraday momentum / noise boundaries
- **Gao, Han, Li & Zhou (2018), JFE 129(2):394–414** — SPY 1993–2013: first half-hour return
  (from prior close) predicts last half-hour. Predictive R² ~1.6–2%. Stronger on volatile,
  high-volume, recession and macro-news days. Hossain et al. (2021) found it insignificant over
  COVID (https://dspace5old.zcu.cz/handle/11025/46501).
  https://profiles.wustl.edu/en/publications/market-intraday-momentum/
- **Baltussen, Da, Lammers & Martens (2021), JFE 142(1):377–403** — 60+ futures 1974–2020: rest-
  of-day return predicts last 30 min, reverses over following days. For S&P 500, momentum only
  when dealer gamma is **negative**, stronger as gamma gets more negative. Asset-class Sharpe
  ~0.87–1.73 (Alpha Architect summary). https://www3.nd.edu/~zda/intramom.pdf
- **Zarattini, Aziz & Barbon (2024/25), "Beat the Market", SFI RP 24-97** — noise area = open ±
  14-day avg |move from open to that same minute|. Trade breaks; VWAP/band trailing stops;
  half-hour checks. 2007–early 2024: 1,985% total net, 19.6%/yr, Sharpe 1.33, incl. commission
  and slippage. No independent peer-reviewed replication.
  https://www.alexandria.unisg.ch/handle/20.500.14171/122124

## 3. Volatility compression → expansion
- Academic support is for **clustering/persistence**: Andersen & Bollerslev (1997) J. Empirical
  Finance 4:115–158; Corsi (2009) HAR-RV; range estimators (Parkinson 1980; Alizadeh, Brandt &
  Diebold 2002). Persistence ⇒ low realized range predicts *continued* low range short-term;
  expansion only via slow mean reversion and scheduled events. "Compression predicts expansion"
  is mostly a time-of-day / event-calendar conditioning story.
- **NR4/NR7, Bollinger/Keltner squeeze:** no peer-reviewed test found; practitioners call them
  directionally neutral and bracket them.
- **Direction is a separate claim** — nothing shows breakout direction from compression is
  predictable.
- **Marshall, Cahan & Cahan (2008), J. Empirical Finance 15(2):199–210** — 7,846 intraday rules
  on 5-min SPY incl. channel and S/R breakouts. 163 significant at 5% before data-snooping
  correction; **none after**. https://ideas.repec.org/a/eee/empfin/v15y2008i2p199-210.html

## 4. Breakout vs mean reversion, gamma
- Baltussen et al.: negative gamma → momentum, positive → dampening. Ni, Pearson & Poteshman
  (single stocks): net purchased options lower vol.
  https://ou.edu/dam/price/Finance/CFS/paper/pdf/pearsonPoteshmanWhite.pdf
- Barbon & Buraschi, "Gamma Fragility" (2019/2021) — same thesis (numbers unverified).
- **Dim, Eraker & Vilkov (2024), SSRN 4692190** — 0DTE gamma does *not* amplify index moves;
  "gamma flip" story disputed in 0DTE era.
- Unconditionally, short-horizon index-futures breakouts ≈ coin flip; any edge is conditional on
  regime, time of day, news.

## 5. Time of day
- U-shaped intraday vol (Wood et al. 1985; Harris 1986; Andersen & Bollerslev 1997) is robust.
- Key ES windows: 8:30 ET macro, 9:30 cash open, 10:00 releases (ISM, confidence), 14:00 FOMC,
  close. Momentum concentrates at open and close; lunch lull is deterministic, not a signal.

## Implications
1. Normalize tightness by same-minute range over last N days (as noise area does). Raw ranges
   just pick up lunch and holidays.
2. Test magnitude and direction separately; literature supports magnitude weakly, direction
   hardly at all.
3. Regime conditioner: gamma sign (GEX proxy), relative volume/vol, macro-event days.
4. Realistic costs: ≥1 tick slippage per side + commission.
5. Data-snooping guard: fixed OOS params, walk-forward, White RC / SPA.

## Caveats
- Strong Sharpes (1.3–2.8) are practitioner-affiliated working papers, unreplicated; QQQ ORB
  fails replication after costs.
- Post-publication decay ~35–58% (McLean & Pontiff). Intraday momentum weak in 2020; gamma
  effects may have shifted with 0DTE.
- Robust: U-shape, vol clustering, conditional last-half-hour momentum. Fragile: directional
  breakouts from compression; ORB on one liquid index after costs.
