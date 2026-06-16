import React from 'react';
import { Layers } from 'lucide-react';
import { SCAN_META } from './shared';

export default function SectorsView({ sectors, timeframe, activeSector, onSelectSector }) {
  const sorted = [...sectors].sort((a, b) => Number(b.avg_bx) - Number(a.avg_bx));
  const maxAbs = Math.max(...sorted.map(s => Math.abs(Number(s.avg_bx))), 1);
  return (
    <div className="flex-1 overflow-y-auto col-scroll bg-zinc-950">
      <div className="max-w-4xl mx-auto px-4 md:px-6 py-4 md:py-6">
        <div className="flex items-baseline gap-3 mb-4 flex-wrap">
          <Layers className="w-4 h-4 text-emerald-400" />
          <h2 className="text-[12px] tracking-[0.3em] font-bold text-emerald-400">SECTOR PULSE · {SCAN_META[timeframe].label}</h2>
          <span className="text-[10px] text-zinc-500">click any sector to drill into its tickers</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {sorted.map(s => {
            const avg = Number.isFinite(Number(s.avg_bx)) ? Number(s.avg_bx) : 0;
            const positive = avg > 0;
            const color = avg > 2 ? 'emerald' : avg < -2 ? 'red' : 'amber';
            const c = color === 'emerald' ? { text: 'text-emerald-400', bg: 'bg-emerald-500', border: 'border-emerald-500/40' }
                    : color === 'red'     ? { text: 'text-red-400',     bg: 'bg-red-500',     border: 'border-red-500/40' }
                    : { text: 'text-amber-400', bg: 'bg-amber-500', border: 'border-amber-500/40' };
            const widthPct = maxAbs > 0 ? (Math.abs(avg) / maxAbs) * 100 : 0;
            const isActive = activeSector === s.sector;
            return (
              <button key={s.sector} onClick={() => onSelectSector && onSelectSector(s.sector)}
                className={`text-left border ${isActive ? 'border-emerald-400 bg-emerald-500/10 shadow-[0_0_0_1px_rgb(52,211,153)]' : `${c.border} bg-zinc-900/30 hover:bg-zinc-900/60 hover:border-zinc-600`} p-3 transition-colors no-tap-highlight`}>
                <div className="flex items-baseline justify-between mb-1.5 gap-2">
                  <div className="flex items-baseline gap-2 min-w-0">
                    <span className="text-[11px] tracking-[0.2em] font-bold text-zinc-100">{s.sector.toUpperCase()}</span>
                    {isActive && <span className="text-[8px] tracking-[0.25em] font-bold text-emerald-400 bg-emerald-500/15 px-1.5 py-0.5">ACTIVE</span>}
                  </div>
                  <span className={`text-[14px] font-bold tabular-nums ${c.text}`}>{positive ? '+' : ''}{avg.toFixed(2)}</span>
                </div>
                <div className="h-1 bg-zinc-800 relative overflow-hidden mb-2">
                  <div className={`absolute top-0 bottom-0 ${c.bg}`}
                    style={positive ? { left: '50%', width: `${widthPct/2}%` } : { right: '50%', width: `${widthPct/2}%` }} />
                  <div className="absolute top-0 bottom-0 left-1/2 w-px bg-zinc-600" />
                </div>
                <div className="flex items-center gap-3 text-[9px] text-zinc-500 tracking-wider">
                  <span>{s.ticker_count} tickers</span>
                  <span className="text-emerald-500">{s.bullish_count} bull</span>
                  <span className="text-amber-500">{s.neutral_count} neu</span>
                  <span className="text-red-500">{s.bearish_count} bear</span>
                  <span className="ml-auto">{s.pct_bullish}% bullish</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
