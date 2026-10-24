import React from 'react';
import { History, AlertCircle } from 'lucide-react';
import { SCAN_META, fmtEt } from './shared';

// Forward-return horizons. ret_5d..ret_120d in the DB are BAR offsets of the timeframe, not days.
const HORIZONS = [5, 20, 60, 120];
const STALE_DAYS = 8;

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const fmtPct = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
const fmtPp = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}pp`);
const signCls = (v) => (v == null ? 'text-zinc-600' : v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-zinc-300');

export default function BacktestView({ summary, baseline, timeframe, scan, error, onRetry }) {
  // Filter to most useful signal types (zone transitions involving entries/exits)
  const PRIORITY = [
    { key: 'neutral_to_bullish',  label: 'NEUTRAL → BULLISH', desc: 'Bullish breakout (long entry)',  color: 'emerald' },
    { key: 'bearish_to_neutral',  label: 'BEARISH → NEUTRAL', desc: 'Selling pressure easing',         color: 'amber' },
    { key: 'neutral_to_bearish',  label: 'NEUTRAL → BEARISH', desc: 'Bearish breakdown (long exit)',  color: 'red' },
    { key: 'bullish_to_neutral',  label: 'BULLISH → NEUTRAL', desc: 'Bullish momentum fading',         color: 'amber' },
    { key: 'bullish_to_bearish',  label: 'BULLISH → BEARISH', desc: 'Sharp reversal down',             color: 'red' },
    { key: 'bearish_to_bullish',  label: 'BEARISH → BULLISH', desc: 'Sharp reversal up',               color: 'emerald' },
  ];
  const rows = PRIORITY.map(p => ({ ...p, data: summary.find(s => s.signal_type === p.key) || null }));
  // Forward-return horizons are measured in BARS of the selected timeframe, not always days.
  const hu = SCAN_META[timeframe].tvInterval; // D / W / M
  const huWord = timeframe === 'daily' ? 'trading days' : timeframe === 'weekly' ? 'weeks' : 'months';

  // Optional columns (C10): medians, last_computed_at, and the all-bars baseline view. Hidden when absent.
  const baseAvg = (h) => (baseline ? num(baseline[`base_avg_${h}d`]) : null);
  const baseWin = baseline ? num(baseline.base_win_rate_60d_pct) : null;
  const hasBase = HORIZONS.some(h => baseAvg(h) != null) || baseWin != null;
  const lastComputed = summary.reduce((m, s) => (s.last_computed_at && (!m || s.last_computed_at > m) ? s.last_computed_at : m), null);
  const computedAgeDays = lastComputed ? (Date.now() - new Date(lastComputed).getTime()) / 86_400_000 : null;
  const computedStale = computedAgeDays != null && computedAgeDays > STALE_DAYS;
  // The C10 summary (med_* columns) applies BX outlier rule v1; the old view did not.
  const ruleV1 = summary.some(s => 'med_5d' in s);

  return (
    <div className="flex-1 overflow-y-auto col-scroll bg-zinc-950">
      <div className="max-w-5xl mx-auto px-4 md:px-6 py-4 md:py-6">
        <div className="flex items-baseline gap-3 mb-2 flex-wrap">
          <History className="w-4 h-4 text-emerald-400" />
          <h2 className="text-[12px] tracking-[0.3em] font-bold text-emerald-400">SIGNAL BACKTEST · {SCAN_META[timeframe].label}</h2>
          <span className="text-[10px] text-zinc-500">historical performance of BX zone-transition signals across all {scan.data.length} tickers</span>
        </div>
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-zinc-500 tracking-wider">
          <span>HORIZONS IN BARS: 5{hu} = 5 {huWord} · 120{hu} = 120 {huWord}</span>
          {lastComputed && (
            <span className={computedStale ? 'text-amber-400 font-bold' : ''}>
              COMPUTED {fmtEt(lastComputed)}{computedStale ? ` · ${Math.floor(computedAgeDays)} DAYS OLD` : ''}
            </span>
          )}
          {baseline && num(baseline.n_bars) != null && (
            <span>BASE = {Number(baseline.n_bars).toLocaleString('en-US')} bars{fmtEt(baseline.computed_at) ? ` · ${fmtEt(baseline.computed_at)}` : ''}</span>
          )}
        </div>

        {error && (
          <div className="mb-3 px-3 py-2 border border-red-500/40 bg-red-500/5 text-[10px] text-red-400 tracking-wider flex items-center gap-2">
            <AlertCircle className="w-3 h-3 flex-shrink-0" />
            <span>Backtest data failed to load.</span>
            <button onClick={onRetry} className="underline active:text-red-300 md:hover:text-red-300">Retry</button>
          </div>
        )}

        <div className="space-y-3">
          {rows.map(({ key, label, desc, color, data }) => {
            const c = color === 'emerald' ? { text: 'text-emerald-400', border: 'border-emerald-500/40', bg: 'bg-emerald-500/5' }
                    : color === 'red'     ? { text: 'text-red-400',     border: 'border-red-500/40',     bg: 'bg-red-500/5' }
                    : { text: 'text-amber-400', border: 'border-amber-500/40', bg: 'bg-amber-500/5' };
            const med = (h) => (data ? num(data[`med_${h}d`] ?? (h === 60 ? data.median_60d : null)) : null);
            const hasMed = HORIZONS.some(h => med(h) != null);
            const win = data ? num(data.win_rate_60d_pct) : null;
            return (
              <div key={key} className={`border ${c.border} ${c.bg} p-3 md:p-4`}>
                <div className="flex items-baseline justify-between gap-3 mb-2 flex-wrap">
                  <div>
                    <div className={`text-[12px] font-bold tracking-[0.2em] ${c.text}`}>{label}</div>
                    <div className="text-[10px] text-zinc-500 mt-0.5">{desc}</div>
                  </div>
                  {data ? (
                    <div className="text-[10px] text-zinc-500 tracking-wider tabular-nums">
                      N={Number(data.n_signals).toLocaleString('en-US')} signals
                      {data.n_with_60d != null && <> · n={Number(data.n_with_60d).toLocaleString('en-US')} with 60{hu} outcome</>}
                    </div>
                  ) : (
                    <div className="text-[10px] text-zinc-700 tracking-wider">no data yet</div>
                  )}
                </div>
                {data && (
                  <table className="w-full text-[10px] tabular-nums">
                    <thead>
                      <tr className="text-[9px] text-zinc-600 tracking-[0.15em]">
                        <th className="text-left font-normal py-1 pr-2">AFTER</th>
                        <th className="text-right font-normal py-1">MEAN</th>
                        {hasMed && <th className="text-right font-normal py-1">MEDIAN</th>}
                        {hasBase && <th className="text-right font-normal py-1">BASE</th>}
                        {hasBase && <th className="text-right font-normal py-1">LIFT</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {HORIZONS.map(h => {
                        const mean = num(data[`avg_${h}d`]);
                        const b = baseAvg(h);
                        const lift = mean != null && b != null ? mean - b : null;
                        return (
                          <tr key={h} className="border-t border-zinc-800/60">
                            <td className="py-1 pr-2 text-zinc-500">{h}{hu}</td>
                            <td className={`py-1 text-right font-bold ${hasBase ? 'text-zinc-200' : signCls(mean)}`}>{fmtPct(mean)}</td>
                            {hasMed && <td className="py-1 text-right text-zinc-300">{fmtPct(med(h))}</td>}
                            {hasBase && <td className="py-1 text-right text-zinc-500">{fmtPct(b)}</td>}
                            {hasBase && <td className={`py-1 text-right font-bold ${signCls(lift)}`}>{fmtPp(lift)}</td>}
                          </tr>
                        );
                      })}
                      <tr className="border-t border-zinc-800/60">
                        <td className="py-1 pr-2 text-zinc-500">WIN 60{hu}</td>
                        <td className="py-1 text-right font-bold text-zinc-200">{win != null ? `${win.toFixed(1)}%` : '—'}</td>
                        {hasMed && <td className="py-1" />}
                        {hasBase && <td className="py-1 text-right text-zinc-500">{baseWin != null ? `${baseWin.toFixed(1)}%` : '—'}</td>}
                        {hasBase && <td className={`py-1 text-right font-bold ${signCls(win != null && baseWin != null ? win - baseWin : null)}`}>{win != null && baseWin != null ? fmtPp(win - baseWin) : '—'}</td>}
                      </tr>
                    </tbody>
                  </table>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-6 px-4 py-3 border border-zinc-800 bg-zinc-900/30 text-[10px] text-zinc-500 leading-relaxed space-y-1.5">
          <p>
            <span className="text-zinc-400">How to read this:</span> MEAN and MEDIAN are the stock's return N bars after the signal fired
            (e.g. 60{hu} = 60 {huWord} later), pooled across every ticker and signal. The mean is pulled around by a few huge moves; the median is the typical outcome.
          </p>
          {hasBase ? (
            <p>
              <span className="text-zinc-400">BASE</span> is the same return measured from every completed bar, signal or not: what just holding
              returned. <span className="text-zinc-400">LIFT</span> = signal mean − base mean. Lift, not a positive mean, is the edge; a bearish signal
              with a positive mean but negative lift still marks underperformance. Compare WIN 60{hu} with the base win rate, not with 50%.
            </p>
          ) : (
            <p>
              No base rate is available yet. Stocks drift up over time, so a positive mean or a win rate above 50% here does not by itself show an edge.
            </p>
          )}
          {ruleV1 && (
            <p>
              <span className="text-zinc-400">Outlier rule v1:</span> signals with an entry price below $1.00 are left out, and any single
              return above +10,000% is dropped for that horizon{hasBase ? '. BASE uses the same rule' : ''}.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
