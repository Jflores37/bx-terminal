import React from 'react';
import { History, AlertCircle } from 'lucide-react';
import { SCAN_META, Stat } from './shared';

export default function BacktestView({ summary, timeframe, scan, error, onRetry }) {
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
  const huWord = timeframe === 'daily' ? 'days' : timeframe === 'weekly' ? 'weeks' : 'months';
  return (
    <div className="flex-1 overflow-y-auto col-scroll bg-zinc-950">
      <div className="max-w-5xl mx-auto px-4 md:px-6 py-4 md:py-6">
        <div className="flex items-baseline gap-3 mb-4 flex-wrap">
          <History className="w-4 h-4 text-emerald-400" />
          <h2 className="text-[12px] tracking-[0.3em] font-bold text-emerald-400">SIGNAL BACKTEST · {SCAN_META[timeframe].label}</h2>
          <span className="text-[10px] text-zinc-500">historical performance of BX zone-transition signals across all {scan.data.length} tickers</span>
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
            return (
              <div key={key} className={`border ${c.border} ${c.bg} p-4`}>
                <div className="flex items-baseline justify-between gap-3 mb-3 flex-wrap">
                  <div>
                    <div className={`text-[12px] font-bold tracking-[0.2em] ${c.text}`}>{label}</div>
                    <div className="text-[10px] text-zinc-500 mt-0.5">{desc}</div>
                  </div>
                  {data ? (
                    <div className="text-[10px] text-zinc-500 tracking-wider">N={data.n_signals} historical signals</div>
                  ) : (
                    <div className="text-[10px] text-zinc-700 tracking-wider">no data yet</div>
                  )}
                </div>
                {data && (
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-[10px]">
                    <Stat label={`AVG 5${hu}`}      value={data.avg_5d  != null ? `${Number(data.avg_5d) >= 0 ? '+' : ''}${Number(data.avg_5d).toFixed(2)}%`   : '—'} valueClass={data.avg_5d == null ? 'text-zinc-600' : Number(data.avg_5d) > 0 ? 'text-emerald-400' : 'text-red-400'}/>
                    <Stat label={`AVG 20${hu}`}     value={data.avg_20d != null ? `${Number(data.avg_20d) >= 0 ? '+' : ''}${Number(data.avg_20d).toFixed(2)}%` : '—'} valueClass={data.avg_20d == null ? 'text-zinc-600' : Number(data.avg_20d) > 0 ? 'text-emerald-400' : 'text-red-400'}/>
                    <Stat label={`AVG 60${hu}`}     value={data.avg_60d != null ? `${Number(data.avg_60d) >= 0 ? '+' : ''}${Number(data.avg_60d).toFixed(2)}%` : '—'} valueClass={data.avg_60d == null ? 'text-zinc-600' : Number(data.avg_60d) > 0 ? 'text-emerald-400' : 'text-red-400'}/>
                    <Stat label={`AVG 120${hu}`}    value={data.avg_120d != null ? `${Number(data.avg_120d) >= 0 ? '+' : ''}${Number(data.avg_120d).toFixed(2)}%` : '—'} valueClass={data.avg_120d == null ? 'text-zinc-600' : Number(data.avg_120d) > 0 ? 'text-emerald-400' : 'text-red-400'}/>
                    <Stat label={`WIN 60${hu}`}     value={data.win_rate_60d_pct != null ? `${data.win_rate_60d_pct}%` : '—'} valueClass={data.win_rate_60d_pct == null ? 'text-zinc-600' : Number(data.win_rate_60d_pct) > 55 ? 'text-emerald-400' : Number(data.win_rate_60d_pct) < 45 ? 'text-red-400' : 'text-amber-400'}/>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-6 px-4 py-3 border border-zinc-800 bg-zinc-900/30 text-[10px] text-zinc-500 leading-relaxed">
          <span className="text-zinc-400">How to read this:</span> Each row shows what happened on average AFTER that signal type fired historically.
          For example, "NEUTRAL → BULLISH" returns ~X% on average after 60 {huWord} means: when BX crossed above +2 across all tickers, the median stock gained X% over the next 60 {huWord}.
          <span className="text-zinc-400"> Win rate 60{hu}</span> = % of those signals that ended in profit at 60 {huWord}.
          Use this to gauge the edge: a 65% win rate beats 50% (random).
        </div>
      </div>
    </div>
  );
}
