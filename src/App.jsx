import React, { useState, useEffect, useMemo, useRef, Suspense } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Star, StickyNote, X, Search, AlertCircle, ArrowRight, Radio,
  SlidersHorizontal, ChevronLeft, ChevronDown, ChevronUp, RefreshCw, TrendingUp, Activity,
  Calendar, Target, Layers, BarChart3, Sparkles, Check, History
} from 'lucide-react';
import { SCAN_META, Stat } from './shared';

// Non-default views are code-split: their JS only loads when the tab is opened.
const SectorsView = React.lazy(() => import('./SectorsView'));
const BacktestView = React.lazy(() => import('./BacktestView'));

// ============================================================================
// BX TERMINAL v3 — LEAPS Lens with Market Bias, Backtest, AI Brief, Mobile polish
// ============================================================================

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// SCAN_META + Stat are imported from ./shared (also used by the lazy views).

const VIEWS = {
  zones:    { label: 'ZONES',    icon: Activity   },
  movers:   { label: 'MOVERS',   icon: TrendingUp },
  sectors:  { label: 'SECTORS',  icon: Layers     },
  backtest: { label: 'BACKTEST', icon: History    },
};

async function sbFetch(path) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY env vars');
  let r;
  try {
    r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Range: '0-9999' },
    });
  } catch (e) {
    console.error(`Supabase network error on ${path}:`, e);
    throw new Error('Network error — check your connection.');
  }
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    console.error(`Supabase ${r.status} on ${path}: ${detail}`);
    throw new Error(`Data request failed (${r.status}). See console for details.`);
  }
  try {
    return await r.json();
  } catch (e) {
    console.error(`Supabase malformed response on ${path}:`, e);
    throw new Error('Malformed response from server.');
  }
}

async function fetchScan(timeframe) {
  const rows = await sbFetch(`latest_scans_with_meta?timeframe=eq.${timeframe}&select=*&order=scan_date.desc&limit=10000`);
  if (!rows.length) return { date: null, data: [], meta: {} };
  const meta = {};
  const data = rows.map(r => {
    meta[r.ticker] = {
      ex: r.exchange || null,
      mc: r.market_cap_billions ? Number(r.market_cap_billions) : 0,
      px: r.price ? Number(r.price) : 0,
      vol: r.avg_volume_millions ? Number(r.avg_volume_millions) : 0,
      sec: r.sector || '—', ind: r.industry || '—',
      earn: r.next_earnings_date || null,
      daysToEarn: r.days_to_earnings != null ? Number(r.days_to_earnings) : null,
      hi52: r.fifty_two_week_high ? Number(r.fifty_two_week_high) : null,
      lo52: r.fifty_two_week_low ? Number(r.fifty_two_week_low) : null,
      pct52: r.pct_of_52w_range != null ? Number(r.pct_of_52w_range) : null,
      align: r.alignment_score != null ? Number(r.alignment_score) : null,
      composite: r.composite_bx != null ? Number(r.composite_bx) : null,
      daily: r.daily_bx != null ? Number(r.daily_bx) : null,
      weekly: r.weekly_bx != null ? Number(r.weekly_bx) : null,
      monthly: r.monthly_bx != null ? Number(r.monthly_bx) : null,
      biasDir: r.bias_direction || null,
      biasOsc: r.bias_oscillator != null ? Number(r.bias_oscillator) : null,
      inZone: r.bias_in_zone,
    };
    const bxv = Number(r.bx); const prevv = Number(r.prev_bx);
    return { t: r.ticker, bx: Number.isFinite(bxv) ? bxv : 0, prev: r.prev_bx != null && Number.isFinite(prevv) ? prevv : null };
  });
  return { date: rows[0].scan_date, data, meta };
}

async function fetchMovers(timeframe) {
  return sbFetch(`bx_movers?timeframe=eq.${timeframe}&select=*&order=abs_delta.desc&limit=100`);
}

async function fetchSectors(timeframe) {
  return sbFetch(`sector_pulse?timeframe=eq.${timeframe}&select=*&order=avg_bx.desc`);
}

async function fetchBacktestSummary(timeframe) {
  return sbFetch(`bx_backtest_summary?timeframe=eq.${timeframe}&select=*`);
}

async function fetchBacktestForTicker(ticker, timeframe) {
  return sbFetch(`bx_backtest_results?ticker=eq.${ticker}&timeframe=eq.${timeframe}&select=*&order=signal_date.desc&limit=20`);
}

function zoneOf(bx){ if(bx<-2) return 'bearish'; if(bx>2) return 'bullish'; return 'neutral'; }
function transitionOf(cur,prev){ if(prev==null) return null; const a=zoneOf(prev),b=zoneOf(cur); return a===b?null:{from:a,to:b}; }

function splitMovers(movers) {
  return {
    bullishMoves: movers.filter(m => Number(m.delta_bx) > 0).slice(0, 25),
    bearishMoves: movers.filter(m => Number(m.delta_bx) < 0).slice(0, 25),
  };
}

const MC_BUCKETS = [
  { label: 'ALL', min: 0, max: Infinity }, { label: 'MEGA', min: 200, max: Infinity },
  { label: 'LARGE', min: 10, max: 200 }, { label: 'MID', min: 2, max: 10 }, { label: 'SMALL', min: 0, max: 2 },
];
const MC_BUCKETS_LONG = ['ALL','MEGA >200B','LARGE 10-200B','MID 2-10B','SMALL <2B'];

const EARN_BUCKETS = [
  { label: 'ANY', days: null }, { label: '>7d', days: 7 }, { label: '>14d', days: 14 },
  { label: '>21d', days: 21 }, { label: '>30d', days: 30 },
];

const PCT52_BUCKETS = [
  { label: 'ANY', min: 0, max: 100 }, { label: 'NEAR HIGHS', min: 70, max: 100 },
  { label: 'MID-RANGE', min: 30, max: 70 }, { label: 'NEAR LOWS', min: 0, max: 30 },
];

const BIAS_BUCKETS = [
  { label: 'ANY',  v: null },
  { label: 'BULL', v: 'bullish' },
  { label: 'BEAR', v: 'bearish' },
];

function tvExchangePrefix(ex) {
  if (!ex) return '';
  if (ex === 'NASDAQ') return 'NASDAQ:';
  if (ex === 'NYSE' || ex === 'New York Stock Exchange') return 'NYSE:';
  if (ex === 'AMEX' || ex === 'NYSE American' || ex === 'NYSE MKT') return 'AMEX:';
  return '';
}

function TVChart({ ticker, interval, exchange }) {
  const compact = typeof window !== 'undefined' && window.innerWidth < 1024;
  const sym = `${tvExchangePrefix(exchange)}${ticker}`;
  const src =
    `https://s.tradingview.com/widgetembed/?frameElementId=tv_${ticker}` +
    `&symbol=${encodeURIComponent(sym)}&interval=${interval}` +
    `&hidesidetoolbar=${compact ? 1 : 0}&symboledit=1&saveimage=0` +
    `&toolbarbg=0a0a0b&theme=dark&style=1&timezone=Etc%2FUTC` +
    `&withdateranges=1&hideideas=1&hideideasbutton=1&locale=en`;
  return (
    <iframe key={`${sym}-${interval}`} src={src} title={`${ticker} ${interval}`}
      className="w-full h-full border-0" allow="fullscreen"/>
  );
}

function loadLocal(key, fb) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fb; } catch { return fb; } }
function saveLocal(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }

function earnLevel(d) { if (d == null || d < 0) return null; if (d < 7) return 'imminent'; if (d <= 14) return 'soon'; return null; }

function EarnBadge({ daysToEarn, mobile }) {
  const level = earnLevel(daysToEarn);
  if (!level) return null;
  const imm = level === 'imminent';
  return (
    <span className={`inline-flex items-center gap-0.5 ${mobile ? 'text-[9px]' : 'text-[8px]'} font-bold tracking-wider ${imm ? 'text-red-400' : 'text-amber-400'}`}>
      {imm ? '⚠' : '🔔'}{daysToEarn}d
    </span>
  );
}

function AlignDots({ score }) {
  if (score == null) return null;
  const abs = Math.abs(score);
  const color = score > 0 ? 'bg-emerald-400' : score < 0 ? 'bg-red-400' : 'bg-zinc-700';
  return (
    <div className="flex items-center gap-0.5">
      {[0,1,2].map(i => <div key={i} className={`w-1 h-1 rounded-full ${i < abs ? color : 'bg-zinc-800'}`} />)}
    </div>
  );
}

function BiasBadge({ direction, inZone, compact }) {
  if (!direction) return null;
  const bull = direction === 'bullish';
  const c = bull ? 'text-emerald-400' : 'text-red-400';
  const arrow = bull ? '▲' : '▼';
  return (
    <span aria-label={`${direction} bias${inZone ? ', in zone' : ''}`}
      className={`inline-flex items-center gap-0.5 ${compact ? 'text-[8px]' : 'text-[9px]'} font-bold tracking-wider ${c}`}>
      <span aria-hidden="true">{arrow}{inZone ? '·Z' : ''}</span>
    </span>
  );
}

function CollapsibleSection({ title, icon: Icon, summary, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="flex-shrink-0 border-b border-zinc-800">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 h-9 hover:bg-zinc-900/50 active:bg-zinc-900 transition-colors group">
        <div className="flex items-center gap-2 min-w-0">
          {Icon && <Icon className="w-3 h-3 text-zinc-500 group-hover:text-zinc-400 flex-shrink-0" />}
          <span className="text-[10px] tracking-[0.3em] text-zinc-500 group-hover:text-zinc-400">{title}</span>
        </div>
        <div className="flex items-center gap-2.5">
          {summary && <span className="text-[10px] tabular-nums">{summary}</span>}
          <ChevronDown className={`w-3.5 h-3.5 text-zinc-500 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
        </div>
      </button>
      {open && <div className="border-t border-zinc-900 bg-zinc-950/40">{children}</div>}
    </div>
  );
}

export default function App() {
  const [timeframe, setTimeframe] = useState('weekly');
  const [view, setView] = useState('zones');
  const [scan, setScan] = useState({ date: null, data: [], meta: {} });
  const [movers, setMovers] = useState([]);
  const [sectors, setSectors] = useState([]);
  const [backtestSummary, setBacktestSummary] = useState([]);
  const [backtestError, setBacktestError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [watchlist, setWatchlist] = useState(() => loadLocal('bx_watchlist', {}));
  const [notes, setNotes] = useState(() => loadLocal('bx_notes', {}));
  const [watchOnly, setWatchOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [mcBucket, setMcBucket] = useState(0);
  const [priceMin, setPriceMin] = useState('');
  const [priceMax, setPriceMax] = useState('');
  const [volMin, setVolMin] = useState('');
  const [earnFilter, setEarnFilter] = useState(0);
  const [pct52Filter, setPct52Filter] = useState(0);
  const [sectorFilter, setSectorFilter] = useState(null);
  const [biasFilter, setBiasFilter] = useState(0);
  const [inZoneOnly, setInZoneOnly] = useState(false);
  const [showAlerts, setShowAlerts] = useState(false);
  const [mobileZone, setMobileZone] = useState('bullish');
  const [mobileMoverTab, setMobileMoverTab] = useState(() => loadLocal('bx_mobile_mover_tab', 'bullish'));
  useEffect(() => { saveLocal('bx_mobile_mover_tab', mobileMoverTab); }, [mobileMoverTab]);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [zoneSort, setZoneSort] = useState(() => loadLocal('bx_zone_sort', {
    bearish: 'asc',   // -10 → -2 at top (most extreme bearish first)
    neutral: 'asc',   // -2 → +2 (negative, zero, positive) per request
    bullish: 'desc',  // +10 → +2 at top (most extreme bullish first)
  }));
  useEffect(() => { saveLocal('bx_zone_sort', zoneSort); }, [zoneSort]);
  const toggleZoneSort = (zone) =>
    setZoneSort(s => ({ ...s, [zone]: s[zone] === 'asc' ? 'desc' : 'asc' }));

  const loadSeq = useRef(0);
  const loadData = (tf) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    return Promise.allSettled([
      fetchScan(tf), fetchMovers(tf), fetchSectors(tf), fetchBacktestSummary(tf),
    ]).then(([s, m, sec, bt]) => {
      if (seq !== loadSeq.current) return; // a newer load (or unmount) superseded this one
      if (s.status === 'fulfilled') {
        setScan(s.value);
        setError(null);
        if (s.value.data.length) setSelected(cur => cur ?? s.value.data[0].t);
      } else {
        setError(s.reason?.message || String(s.reason));
      }
      if (m.status === 'fulfilled')   setMovers(m.value);
      if (sec.status === 'fulfilled') setSectors(sec.value);
      if (bt.status === 'fulfilled') { setBacktestSummary(bt.value); setBacktestError(null); }
      else setBacktestError(bt.reason?.message || 'Failed to load backtest data');
    }).finally(() => {
      if (seq === loadSeq.current) setLoading(false);
    });
  };

  useEffect(() => {
    loadData(timeframe);
    return () => { loadSeq.current++; };
  }, [timeframe]);

  useEffect(() => { saveLocal('bx_watchlist', watchlist); }, [watchlist]);
  useEffect(() => { saveLocal('bx_notes', notes); }, [notes]);

  // Auto-scroll selected row into view
  useEffect(() => {
    if (!selected) return;
    const els = document.querySelectorAll(`[data-ticker="${selected}"]`);
    for (const el of els) { if (el.offsetParent !== null) { el.scrollIntoView({ block: 'nearest' }); break; } }
  }, [selected]);

  const tvInterval = SCAN_META[timeframe].tvInterval;

  const decorated = useMemo(() => scan.data.map(row => {
    const m = scan.meta[row.t] || {};
    return { ...row, ...m, zone: zoneOf(row.bx), transition: transitionOf(row.bx, row.prev) };
  }), [scan]);

  const filtered = useMemo(() => {
    const bucket = MC_BUCKETS[mcBucket];
    const pMin = priceMin === '' ? -Infinity : parseFloat(priceMin);
    const pMax = priceMax === '' ? Infinity : parseFloat(priceMax);
    const vMin = volMin === '' ? 0 : parseFloat(volMin);
    const earnMinDays = EARN_BUCKETS[earnFilter].days;
    const pct52 = PCT52_BUCKETS[pct52Filter];
    const biasReq = BIAS_BUCKETS[biasFilter].v;
    const q = query.trim().toUpperCase();
    return decorated.filter(r => {
      if (watchOnly && !watchlist[r.t]) return false;
      if (q && !r.t.includes(q)) return false;
      if (r.mc < bucket.min || r.mc > bucket.max) return false;
      if ((priceMin !== '' || priceMax !== '') && (!(r.px > 0) || r.px < pMin || r.px > pMax)) return false;
      if (r.vol < vMin) return false;
      if (earnMinDays != null && r.daysToEarn != null && r.daysToEarn >= 0 && r.daysToEarn < earnMinDays) return false;
      if (pct52Filter !== 0 && r.pct52 != null && (r.pct52 < pct52.min || r.pct52 > pct52.max)) return false;
      if (sectorFilter && r.sec !== sectorFilter) return false;
      if (biasReq && r.biasDir !== biasReq) return false;
      if (inZoneOnly && !r.inZone) return false;
      return true;
    });
  }, [decorated, mcBucket, priceMin, priceMax, volMin, watchOnly, watchlist, query, earnFilter, pct52Filter, sectorFilter, biasFilter, inZoneOnly]);

  const sortByBx = (arr, dir) =>
    arr.slice().sort((a, b) => dir === 'asc' ? a.bx - b.bx : b.bx - a.bx);
  const bearish = useMemo(() => sortByBx(filtered.filter(r => r.zone === 'bearish'), zoneSort.bearish), [filtered, zoneSort.bearish]);
  const neutral = useMemo(() => sortByBx(filtered.filter(r => r.zone === 'neutral'), zoneSort.neutral), [filtered, zoneSort.neutral]);
  const bullish = useMemo(() => sortByBx(filtered.filter(r => r.zone === 'bullish'), zoneSort.bullish), [filtered, zoneSort.bullish]);
  const transitions = useMemo(() => filtered.filter(r => r.transition), [filtered]);

  // Keyboard nav: ↑/↓ within column, ←/→ switch columns, works in ZONES + MOVERS
  // CAPTURE phase so we beat Safari's default arrow-key scroll on the column.
  useEffect(() => {
    const handler = (e) => {
      if (mobileFiltersOpen || showAlerts || mobileDetailOpen) return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;

      const isVert = e.key === 'ArrowUp' || e.key === 'ArrowDown';
      const isHoriz = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
      if (!isVert && !isHoriz) return;
      if (view !== 'zones' && view !== 'movers') return;

      // Resolve the target row without side effects first; only swallow the
      // key (which blocks native scroll) if we actually have somewhere to go.
      let next = null;

      if (view === 'zones') {
        const lists = { bearish, neutral, bullish };
        const order = ['bearish', 'neutral', 'bullish'];
        const selRow = scan.data.find(r => r.t === selected);
        let curZone = selRow ? zoneOf(selRow.bx) : 'neutral';
        let list = lists[curZone];
        if (!list || list.length === 0) {
          for (const z of order) { if (lists[z].length) { curZone = z; list = lists[z]; break; } }
        }
        if (list && list.length) {
          const idx = list.findIndex(r => r.t === selected);
          if (isVert) {
            const len = list.length;
            next = idx === -1
              ? list[0].t
              : list[(e.key === 'ArrowDown' ? idx + 1 : idx - 1 + len) % len].t;
          } else {
            const curIdx = order.indexOf(curZone);
            const dir = e.key === 'ArrowRight' ? 1 : -1;
            for (let step = 1; step <= 3; step++) {
              const ni = curIdx + dir * step;
              if (ni < 0 || ni > 2) break;
              const targetList = lists[order[ni]];
              if (targetList.length === 0) continue;
              next = targetList[Math.min(Math.max(idx, 0), targetList.length - 1)].t;
              break;
            }
          }
        }
      } else {
        const visibleMovers = sectorFilter ? movers.filter(m => m.sector === sectorFilter) : movers;
        const { bullishMoves, bearishMoves } = splitMovers(visibleMovers);
        const inBull = bullishMoves.findIndex(r => r.ticker === selected);
        const inBear = bearishMoves.findIndex(r => r.ticker === selected);
        let curList, curIdx;
        if (inBull >= 0)      { curList = bullishMoves; curIdx = inBull; }
        else if (inBear >= 0) { curList = bearishMoves; curIdx = inBear; }
        else                  { curList = bullishMoves.length ? bullishMoves : bearishMoves; curIdx = -1; }
        if (curList && curList.length) {
          if (isVert) {
            const len = curList.length;
            next = curIdx === -1
              ? curList[0].ticker
              : curList[(e.key === 'ArrowDown' ? curIdx + 1 : curIdx - 1 + len) % len].ticker;
          } else {
            const targetList = curList === bullishMoves ? bearishMoves : bullishMoves;
            if (targetList.length) next = targetList[Math.min(Math.max(curIdx, 0), targetList.length - 1)].ticker;
          }
        }
      }

      if (next == null) return;
      e.preventDefault();
      e.stopPropagation();
      setSelected(next);
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [view, selected, scan.data, bullish, bearish, neutral, movers, sectorFilter, mobileFiltersOpen, showAlerts, mobileDetailOpen]);

  // Escape closes the topmost open overlay.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (mobileFiltersOpen) setMobileFiltersOpen(false);
      else if (showAlerts) setShowAlerts(false);
      else if (mobileDetailOpen) setMobileDetailOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileFiltersOpen, showAlerts, mobileDetailOpen]);

  const toggleWatch = (t) => setWatchlist(w => { const n={...w}; if(n[t])delete n[t]; else n[t]=Date.now(); return n; });
  const handleSelect = (t) => { setSelected(t); setMobileDetailOpen(true); };
  const selectSector = (sector) => {
    if (sectorFilter === sector) setSectorFilter(null);
    else { setSectorFilter(sector); setView('zones'); }
  };
  const clearFilters = () => {
    setQuery(''); setPriceMin(''); setPriceMax(''); setVolMin('');
    setMcBucket(0); setEarnFilter(0); setPct52Filter(0);
    setSectorFilter(null); setBiasFilter(0); setInZoneOnly(false); setWatchOnly(false);
  };
  const refresh = () => loadData(timeframe);

  const selectedMeta = scan.meta[selected] || {};
  const selectedRow = decorated.find(r => r.t === selected);
  const mobileRows = mobileZone === 'bearish' ? bearish : mobileZone === 'neutral' ? neutral : bullish;
  const hasActiveFilters = query || priceMin || priceMax || volMin || mcBucket !== 0 || watchOnly ||
    earnFilter !== 0 || pct52Filter !== 0 || sectorFilter || biasFilter !== 0 || inZoneOnly;

  // Mobile swipe between zone tabs
  const touchRef = useRef({ x: 0, y: 0, active: false });
  const onMobileTouchStart = (e) => { const t = e.touches[0]; touchRef.current = { x: t.clientX, y: t.clientY, active: true }; };
  const onMobileTouchEnd = (e) => {
    if (!touchRef.current.active) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchRef.current.x, dy = t.clientY - touchRef.current.y;
    touchRef.current.active = false;
    if (Math.abs(dx) < 60 || Math.abs(dy) > 40) return;
    const order = ['bearish', 'neutral', 'bullish'];
    const cur = order.indexOf(mobileZone);
    if (dx < 0 && cur < 2) setMobileZone(order[cur + 1]);
    if (dx > 0 && cur > 0) setMobileZone(order[cur - 1]);
  };

  if (loading && scan.data.length === 0) {
    return <div className="w-full h-screen bg-zinc-950 text-emerald-400 flex items-center justify-center"><span className="animate-pulse text-xs tracking-[0.3em]">LOADING LEAPS LENS…</span></div>;
  }
  if (error && scan.data.length === 0) {
    return (
      <div className="w-full h-screen bg-zinc-950 text-red-400 flex flex-col items-center justify-center gap-3 px-6 text-center">
        <AlertCircle className="w-6 h-6" />
        <span className="text-xs tracking-[0.3em]">SCAN FETCH FAILED</span>
        <span className="text-[11px] text-zinc-500 max-w-md">{error}</span>
        <button onClick={refresh} className="mt-2 px-4 py-2 border border-zinc-800 text-zinc-300 text-[10px] tracking-wider active:border-emerald-500">RETRY</button>
      </div>
    );
  }

  return (
    <div className="w-full h-screen bg-zinc-950 text-zinc-100 overflow-hidden flex flex-col mx-auto max-w-[1920px]">
      <style>{`
        .scanlines::before { content:''; position:absolute; inset:0; background: repeating-linear-gradient(0deg, rgba(255,255,255,0.015) 0px, rgba(255,255,255,0.015) 1px, transparent 1px, transparent 3px); pointer-events:none; }
        .live-dot { animation: pulse 1.8s ease-in-out infinite; }
        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.3; } }
        input::placeholder { color: #52525b; }
        .col-scroll::-webkit-scrollbar { width: 6px; }
        .col-scroll::-webkit-scrollbar-track { background: #0a0a0b; }
        .col-scroll::-webkit-scrollbar-thumb { background: #27272a; }
        .col-scroll::-webkit-scrollbar-thumb:hover { background: #3f3f46; }
        @keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
        .slide-up { animation: slideUp 0.2s ease-out; }
        @keyframes slideRight { from { transform: translateX(100%); } to { transform: translateX(0); } }
        .slide-right { animation: slideRight 0.2s ease-out; }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        .fade-in { animation: fadeIn 0.15s ease-out; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .spinning { animation: spin 0.8s linear infinite; }
        .no-tap-highlight { -webkit-tap-highlight-color: transparent; }
      `}</style>

      <div className="sr-only" role="status" aria-live="polite">{loading ? 'Loading…' : `${scan.data.length} tickers loaded`}</div>

      <header className="flex-shrink-0 border-b border-zinc-800 bg-zinc-950 relative scanlines pt-[env(safe-area-inset-top)]">
        <div className="flex items-center justify-between px-3 md:px-4 h-11 md:h-12">
          <div className="flex items-center gap-3 md:gap-6 min-w-0">
            <div className="flex items-center gap-2 flex-shrink-0">
              <Radio className="w-3.5 h-3.5 md:w-4 md:h-4 text-emerald-400 live-dot" />
              <h1 className="text-[10px] md:text-[11px] tracking-[0.25em] md:tracking-[0.3em] font-bold text-emerald-400">BX.TERMINAL</h1>
              <span className="hidden md:inline text-[10px] text-zinc-600">v3.0 · LEAPS LENS</span>
            </div>
            <div className="hidden md:block h-4 w-px bg-zinc-800" />
            <div className="hidden md:flex items-center gap-1 text-[10px] text-zinc-500">
              <span>SCAN:</span><span className="text-zinc-300">{scan.date || '—'}</span>
              <span className="ml-3">TICKERS:</span><span className="text-zinc-300">{scan.data.length}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 md:gap-3 text-[10px]">
            <div className="hidden md:flex items-center gap-2">
              <span className="text-zinc-500">BEAR</span><span className="text-red-400 font-bold">{bearish.length}</span>
              <span className="text-zinc-500">NEU</span><span className="text-amber-400 font-bold">{neutral.length}</span>
              <span className="text-zinc-500">BULL</span><span className="text-emerald-400 font-bold">{bullish.length}</span>
            </div>
            <button onClick={refresh} disabled={loading} aria-label="Refresh scan" className="flex items-center gap-1 px-2 py-1 border border-zinc-800 active:border-emerald-500/50 md:hover:border-emerald-500/50 text-[10px] tracking-wider disabled:opacity-50 no-tap-highlight">
              <RefreshCw className={`w-3 h-3 text-emerald-400 ${loading ? 'spinning' : ''}`} />
            </button>
            <button onClick={() => setShowAlerts(true)} aria-label="Open zone-transition alerts" className="flex items-center gap-1.5 px-2 py-1 border border-zinc-800 active:border-amber-500/50 md:hover:border-amber-500/50 text-[10px] tracking-wider no-tap-highlight">
              <AlertCircle className="w-3 h-3 text-amber-400" />
              <span className="hidden md:inline text-zinc-300">ALERTS</span>
              <span className="text-amber-400 font-bold">{transitions.length}</span>
            </button>
          </div>
        </div>

        <div className="flex items-stretch border-t border-zinc-800">
          {Object.keys(SCAN_META).map(tf => {
            const active = tf === timeframe;
            return (
              <button key={tf} onClick={() => setTimeframe(tf)}
                className={`flex-1 md:flex-none md:px-6 h-11 md:h-9 text-[11px] tracking-[0.3em] border-r border-zinc-800 transition-colors no-tap-highlight ${
                  active ? 'bg-zinc-900 text-emerald-400 border-b-2 border-b-emerald-400' : 'text-zinc-500 active:text-zinc-200 md:hover:text-zinc-200 md:hover:bg-zinc-900/50'
                }`}>{SCAN_META[tf].label}</button>
            );
          })}
          <div className="hidden md:flex ml-auto px-4 text-[10px] text-zinc-500 items-center gap-2">
            <span>CHART.INTERVAL:</span><span className="text-zinc-200">{tvInterval}</span>
          </div>
        </div>

        <div className="flex items-stretch border-t border-zinc-800 bg-zinc-950/80 overflow-x-auto">
          {Object.entries(VIEWS).map(([k, v]) => {
            const active = k === view;
            const Icon = v.icon;
            return (
              <button key={k} onClick={() => setView(k)}
                className={`flex-1 md:flex-none md:px-5 h-11 md:h-8 flex items-center justify-center gap-1.5 text-[10px] tracking-[0.25em] border-r border-zinc-800 transition-colors no-tap-highlight ${
                  active ? 'bg-zinc-900 text-emerald-400 border-b-2 border-b-emerald-400' : 'text-zinc-500 active:text-zinc-200 md:hover:text-zinc-200'
                }`}>
                <Icon className="w-3 h-3" />{v.label}
              </button>
            );
          })}
        </div>

        {view === 'zones' && (
          <div className="lg:hidden flex items-stretch border-t border-zinc-800 h-8 text-[10px]">
            <div className="flex-1 flex items-center justify-center gap-1.5 border-r border-zinc-800">
              <span className="text-zinc-500">BEAR</span><span className="text-red-400 font-bold">{bearish.length}</span>
            </div>
            <div className="flex-1 flex items-center justify-center gap-1.5 border-r border-zinc-800">
              <span className="text-zinc-500">NEU</span><span className="text-amber-400 font-bold">{neutral.length}</span>
            </div>
            <div className="flex-1 flex items-center justify-center gap-1.5">
              <span className="text-zinc-500">BULL</span><span className="text-emerald-400 font-bold">{bullish.length}</span>
            </div>
          </div>
        )}

        {view !== 'sectors' && view !== 'backtest' && (
          <div className="hidden lg:flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 border-t border-zinc-800 bg-zinc-950">
            <div className="flex items-center gap-2 flex-shrink-0">
              <Search className="w-3 h-3 text-zinc-600" />
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="SEARCH TICKER…" aria-label="Search ticker"
                className="w-32 bg-transparent border-b border-zinc-800 text-[11px] text-zinc-200 px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 tracking-wider"/>
            </div>
            <div className="flex items-center gap-1 text-[10px] flex-shrink-0">
              <span className="text-zinc-500 mr-1">MCAP</span>
              {MC_BUCKETS.map((b, i) => (
                <button key={b.label} onClick={() => setMcBucket(i)}
                  className={`px-2 py-0.5 border tracking-wider ${mcBucket === i ? 'border-emerald-500 text-emerald-400 bg-emerald-500/5' : 'border-zinc-800 text-zinc-500 hover:text-zinc-300'}`}>
                  {MC_BUCKETS_LONG[i]}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1 text-[10px] flex-shrink-0">
              <span className="text-zinc-500">BIAS</span>
              {BIAS_BUCKETS.map((b, i) => (
                <button key={b.label} onClick={() => setBiasFilter(i)}
                  className={`px-2 py-0.5 border tracking-wider ${biasFilter === i
                    ? (i === 1 ? 'border-emerald-500 text-emerald-400 bg-emerald-500/5' : i === 2 ? 'border-red-500 text-red-400 bg-red-500/5' : 'border-emerald-500 text-emerald-400 bg-emerald-500/5')
                    : 'border-zinc-800 text-zinc-500 hover:text-zinc-300'}`}>
                  {b.label}
                </button>
              ))}
              <button onClick={() => setInZoneOnly(z => !z)}
                className={`px-2 py-0.5 border tracking-wider ${inZoneOnly ? 'border-cyan-500 text-cyan-400 bg-cyan-500/5' : 'border-zinc-800 text-zinc-500 hover:text-zinc-300'}`}>
                IN-ZONE
              </button>
            </div>
            <div className="flex items-center gap-1 text-[10px] flex-shrink-0">
              <span className="text-zinc-500">EARN</span>
              {EARN_BUCKETS.map((b, i) => (
                <button key={b.label} onClick={() => setEarnFilter(i)}
                  className={`px-2 py-0.5 border tracking-wider ${earnFilter === i ? 'border-amber-500 text-amber-400 bg-amber-500/5' : 'border-zinc-800 text-zinc-500 hover:text-zinc-300'}`}>
                  {b.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1 text-[10px] flex-shrink-0">
              <span className="text-zinc-500">52W</span>
              {PCT52_BUCKETS.map((b, i) => (
                <button key={b.label} onClick={() => setPct52Filter(i)}
                  className={`px-2 py-0.5 border tracking-wider ${pct52Filter === i ? 'border-cyan-500 text-cyan-400 bg-cyan-500/5' : 'border-zinc-800 text-zinc-500 hover:text-zinc-300'}`}>
                  {b.label}
                </button>
              ))}
            </div>
            <button onClick={() => setWatchOnly(w => !w)}
              className={`flex items-center gap-1 px-2 py-0.5 border text-[10px] tracking-wider flex-shrink-0 ${watchOnly ? 'border-amber-500 text-amber-400 bg-amber-500/5' : 'border-zinc-800 text-zinc-500 hover:text-zinc-300'}`}>
              <Star className={`w-3 h-3 ${watchOnly ? 'fill-amber-400' : ''}`} />
              WATCH<span className="text-zinc-600">({Object.keys(watchlist).length})</span>
            </button>
            {hasActiveFilters && (
              <button onClick={clearFilters} className="text-[10px] text-zinc-500 hover:text-red-400 tracking-wider flex-shrink-0">CLEAR</button>
            )}
          </div>
        )}

        {view !== 'sectors' && view !== 'backtest' && (
          <div className="lg:hidden flex items-center gap-2 px-3 h-10 border-t border-zinc-800 bg-zinc-950">
            <div className="flex items-center gap-1.5 flex-1 min-w-0">
              <Search className="w-3 h-3 text-zinc-600 flex-shrink-0" />
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="SEARCH…" aria-label="Search ticker"
                className="w-full bg-transparent border-b border-zinc-800 text-[11px] text-zinc-200 px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 tracking-wider"/>
            </div>
            <button onClick={() => setWatchOnly(w => !w)} aria-label="Show watchlist only" aria-pressed={watchOnly}
              className={`flex items-center gap-1 px-2 py-1 border text-[10px] no-tap-highlight ${watchOnly ? 'border-amber-500 text-amber-400' : 'border-zinc-800 text-zinc-500'}`}>
              <Star className={`w-3 h-3 ${watchOnly ? 'fill-amber-400' : ''}`} />
            </button>
            <button onClick={() => setMobileFiltersOpen(true)}
              className={`flex items-center gap-1 px-2 py-1 border text-[10px] tracking-wider no-tap-highlight ${hasActiveFilters ? 'border-emerald-500 text-emerald-400' : 'border-zinc-800 text-zinc-400'}`}>
              <SlidersHorizontal className="w-3 h-3" />FILTERS
              {hasActiveFilters && <span className="w-1 h-1 bg-emerald-400" />}
            </button>
          </div>
        )}
      </header>

      {sectorFilter && (
        <div className="flex-shrink-0 flex items-center gap-2 px-3 md:px-4 h-8 bg-emerald-500/10 border-b border-emerald-500/40">
          <Layers className="w-3 h-3 text-emerald-400 flex-shrink-0" />
          <span className="text-[10px] tracking-[0.3em] font-bold text-emerald-400">SECTOR:</span>
          <span className="text-[11px] tracking-wider text-emerald-300 truncate">{sectorFilter.toUpperCase()}</span>
          <button onClick={() => setSectorFilter(null)} className="ml-auto flex items-center gap-1 px-2 py-0.5 border border-emerald-500/40 text-[10px] tracking-wider text-emerald-400 active:bg-emerald-500/20 hover:bg-emerald-500/20 flex-shrink-0">
            <X className="w-3 h-3" />CLEAR
          </button>
        </div>
      )}

      {view === 'zones' && (
        <>
          <div className="hidden lg:flex flex-1 overflow-hidden">
            <div className="flex-1 grid grid-cols-3 overflow-hidden">
              <ZoneColumn label="BEARISH" range="[−10 · −2)" accent="red" rows={bearish}
                sortDir={zoneSort.bearish} onToggleSort={() => toggleZoneSort('bearish')}
                selected={selected} onSelect={handleSelect} watchlist={watchlist} onToggleWatch={toggleWatch} notes={notes}/>
              <ZoneColumn label="NEUTRAL" range="[−2 · +2]" accent="amber" rows={neutral}
                sortDir={zoneSort.neutral} onToggleSort={() => toggleZoneSort('neutral')}
                selected={selected} onSelect={handleSelect} watchlist={watchlist} onToggleWatch={toggleWatch} notes={notes}/>
              <ZoneColumn label="BULLISH" range="(+2 · +10]" accent="emerald" rows={bullish}
                sortDir={zoneSort.bullish} onToggleSort={() => toggleZoneSort('bullish')}
                selected={selected} onSelect={handleSelect} watchlist={watchlist} onToggleWatch={toggleWatch} notes={notes}/>
            </div>
            <aside className="w-[440px] xl:w-[520px] 2xl:w-[600px] flex-shrink-0 border-l border-zinc-800 flex flex-col bg-zinc-950">
              {selected && <DetailPanel compact ticker={selected} row={selectedRow} meta={selectedMeta} interval={tvInterval} timeframe={timeframe}
                notes={notes} setNotes={setNotes} watchlist={watchlist} onToggleWatch={toggleWatch}/>}
            </aside>
          </div>

          <div className="lg:hidden flex-1 flex flex-col overflow-hidden"
               onTouchStart={onMobileTouchStart} onTouchEnd={onMobileTouchEnd}>
            <div className="flex items-stretch border-b border-zinc-800 bg-zinc-950 flex-shrink-0">
              <MobileZoneTab label="BEARISH" count={bearish.length} active={mobileZone === 'bearish'} accent="red" onClick={() => setMobileZone('bearish')}/>
              <MobileZoneTab label="NEUTRAL" count={neutral.length} active={mobileZone === 'neutral'} accent="amber" onClick={() => setMobileZone('neutral')}/>
              <MobileZoneTab label="BULLISH" count={bullish.length} active={mobileZone === 'bullish'} accent="emerald" onClick={() => setMobileZone('bullish')}/>
            </div>
            <div className="px-3 h-6 flex items-center justify-between text-[8px] text-zinc-700 tracking-wider flex-shrink-0">
              <span>← SWIPE TO SWITCH ZONES →</span>
              <button onClick={() => toggleZoneSort(mobileZone)}
                className="flex items-center gap-1 px-2 py-1.5 border border-zinc-800 text-zinc-400 no-tap-highlight active:border-emerald-500/50">
                {zoneSort[mobileZone] === 'asc' ? <ChevronUp className="w-2.5 h-2.5" /> : <ChevronDown className="w-2.5 h-2.5" />}
                <span className="font-bold">SORT {zoneSort[mobileZone] === 'asc' ? '−→+' : '+→−'}</span>
              </button>
            </div>
            <div className="flex-1 overflow-hidden flex flex-col">
              <div className="flex items-center px-3 h-6 border-b border-zinc-900 bg-zinc-950/50 text-[9px] text-zinc-600 tracking-wider uppercase flex-shrink-0">
                <span className="w-14">Ticker</span>
                <span className="w-12 text-right">BX</span>
                <span className="flex-1 text-right">PX · 52w · Bias</span>
                <span className="w-12 text-right">Earn·Δ</span>
              </div>
              <VirtualRowList key={mobileZone} rows={mobileRows} selected={selected} onSelect={handleSelect}
                watchlist={watchlist} onToggleWatch={toggleWatch} notes={notes} mobile/>
            </div>
          </div>
        </>
      )}

      {view === 'movers' && (
        <MoversView movers={sectorFilter ? movers.filter(m => m.sector === sectorFilter) : movers}
          meta={scan.meta} selected={selected} onSelect={handleSelect}
          watchlist={watchlist} onToggleWatch={toggleWatch} notes={notes}
          tvInterval={tvInterval} setNotes={setNotes} selectedMeta={selectedMeta} selectedRow={selectedRow} timeframe={timeframe}
          mobileMoverTab={mobileMoverTab} setMobileMoverTab={setMobileMoverTab}/>
      )}

      {view === 'sectors' && <Suspense fallback={<div className="flex-1 flex items-center justify-center text-[10px] text-zinc-600 tracking-[0.3em]">LOADING…</div>}><SectorsView sectors={sectors} timeframe={timeframe} activeSector={sectorFilter} onSelectSector={selectSector}/></Suspense>}

      {view === 'backtest' && <Suspense fallback={<div className="flex-1 flex items-center justify-center text-[10px] text-zinc-600 tracking-[0.3em]">LOADING…</div>}><BacktestView summary={backtestSummary} timeframe={timeframe} scan={scan} error={backtestError} onRetry={refresh}/></Suspense>}

      {mobileDetailOpen && selected && (
        <div role="dialog" aria-modal="true" aria-label={`${selected} details`} className="lg:hidden fixed inset-0 z-40 bg-zinc-950 flex flex-col slide-up pt-[env(safe-area-inset-top)]">
          <div className="flex items-center gap-2 px-3 h-10 border-b border-zinc-800 flex-shrink-0 bg-zinc-950">
            <button onClick={() => setMobileDetailOpen(false)} className="flex items-center gap-1 text-zinc-400 -ml-1 px-1 py-1.5 no-tap-highlight">
              <ChevronLeft className="w-4 h-4" />
              <span className="text-[10px] tracking-[0.3em]">BACK</span>
            </button>
            <div className="flex items-center gap-2 ml-auto">
              <Radio className="w-3 h-3 text-emerald-400 live-dot" />
              <span className="text-[10px] tracking-[0.3em] text-emerald-400">{tvInterval}</span>
            </div>
          </div>
          <div className="flex-1 overflow-hidden pb-[env(safe-area-inset-bottom)]">
            <DetailPanel compact ticker={selected} row={selectedRow} meta={selectedMeta} interval={tvInterval} timeframe={timeframe}
              notes={notes} setNotes={setNotes} watchlist={watchlist} onToggleWatch={toggleWatch}/>
          </div>
        </div>
      )}

      {mobileFiltersOpen && (
        <MobileFiltersDrawer
          mcBucket={mcBucket} setMcBucket={setMcBucket}
          priceMin={priceMin} setPriceMin={setPriceMin}
          priceMax={priceMax} setPriceMax={setPriceMax}
          volMin={volMin} setVolMin={setVolMin}
          earnFilter={earnFilter} setEarnFilter={setEarnFilter}
          pct52Filter={pct52Filter} setPct52Filter={setPct52Filter}
          biasFilter={biasFilter} setBiasFilter={setBiasFilter}
          inZoneOnly={inZoneOnly} setInZoneOnly={setInZoneOnly}
          hasActiveFilters={hasActiveFilters} onClear={clearFilters}
          onClose={() => setMobileFiltersOpen(false)}/>
      )}

      {showAlerts && (
        <AlertsDrawer transitions={transitions}
          onClose={() => setShowAlerts(false)}
          onSelect={(t) => { handleSelect(t); setShowAlerts(false); }}/>
      )}
    </div>
  );
}

// ============================================================================
// VIEWS
// ============================================================================

function MoversView({ movers, meta, selected, onSelect, watchlist, onToggleWatch, notes, tvInterval, setNotes, selectedMeta, selectedRow, timeframe, mobileMoverTab, setMobileMoverTab }) {
  const { bullishMoves, bearishMoves } = splitMovers(movers);

  // Mobile swipe to switch between BULLISH ↔ BEARISH movers
  const touchRef = useRef({ x: 0, y: 0, active: false });
  const onMobileTouchStart = (e) => { const t = e.touches[0]; touchRef.current = { x: t.clientX, y: t.clientY, active: true }; };
  const onMobileTouchEnd = (e) => {
    if (!touchRef.current.active) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchRef.current.x, dy = t.clientY - touchRef.current.y;
    touchRef.current.active = false;
    if (Math.abs(dx) < 60 || Math.abs(dy) > 40) return;
    if (dx < 0 && mobileMoverTab === 'bullish') setMobileMoverTab('bearish');
    if (dx > 0 && mobileMoverTab === 'bearish') setMobileMoverTab('bullish');
  };

  const mobileRows = mobileMoverTab === 'bullish' ? bullishMoves : bearishMoves;

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* DESKTOP: side-by-side columns + detail aside */}
      <div className="hidden lg:flex flex-1 overflow-hidden">
        <div className="flex-1 grid grid-cols-2 overflow-hidden">
          <MoverColumn label="↑ BULLISH MOVES" accent="emerald" rows={bullishMoves} meta={meta}
            selected={selected} onSelect={onSelect} watchlist={watchlist} onToggleWatch={onToggleWatch} notes={notes}/>
          <MoverColumn label="↓ BEARISH MOVES" accent="red" rows={bearishMoves} meta={meta}
            selected={selected} onSelect={onSelect} watchlist={watchlist} onToggleWatch={onToggleWatch} notes={notes}/>
        </div>
        <aside className="w-[440px] xl:w-[520px] 2xl:w-[600px] flex-shrink-0 border-l border-zinc-800 flex flex-col bg-zinc-950">
          {selected && <DetailPanel compact ticker={selected} row={selectedRow} meta={selectedMeta} interval={tvInterval} timeframe={timeframe}
            notes={notes} setNotes={setNotes} watchlist={watchlist} onToggleWatch={onToggleWatch}/>}
        </aside>
      </div>

      {/* MOBILE: ZONES-style tabs + single column + swipe */}
      <div className="lg:hidden flex-1 flex flex-col overflow-hidden"
           onTouchStart={onMobileTouchStart} onTouchEnd={onMobileTouchEnd}>
        <div className="flex items-stretch border-b border-zinc-800 bg-zinc-950 flex-shrink-0">
          <MobileZoneTab label="↑ BULLISH" count={bullishMoves.length} active={mobileMoverTab === 'bullish'} accent="emerald" onClick={() => setMobileMoverTab('bullish')}/>
          <MobileZoneTab label="↓ BEARISH" count={bearishMoves.length} active={mobileMoverTab === 'bearish'} accent="red" onClick={() => setMobileMoverTab('bearish')}/>
        </div>
        <div className="px-3 h-6 flex items-center justify-center text-[8px] text-zinc-700 tracking-wider flex-shrink-0">
          ← SWIPE TO SWITCH →
        </div>
        <div className="flex-1 overflow-hidden flex flex-col">
          <div className="flex items-center px-3 h-6 border-b border-zinc-900 bg-zinc-950/50 text-[9px] text-zinc-600 tracking-wider uppercase flex-shrink-0">
            <span className="w-14">Ticker</span>
            <span className="flex-1 text-right">BX prev → now</span>
            <span className="w-14 text-right">Δ delta</span>
            <span className="w-10 text-right">Zone</span>
          </div>
          <div className="flex-1 overflow-y-auto col-scroll fade-in" key={mobileMoverTab}>
            {mobileRows.length === 0 ? (
              <div className="px-3 py-12 text-center text-[10px] text-zinc-700 tracking-wider">— NO MOVES —</div>
            ) : mobileRows.map(r => (
              <MoverRowMobile key={r.ticker} r={r} selected={selected === r.ticker}
                onSelect={() => onSelect(r.ticker)}
                watched={!!watchlist[r.ticker]}
                onToggleWatch={() => onToggleWatch(r.ticker)}
                hasNote={!!notes[r.ticker]}/>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function MoverRowMobile({ r, selected, onSelect, watched, onToggleWatch, hasNote }) {
  const zone = r.current_zone || 'neutral';
  const zoneColor = zone === 'bullish' ? 'text-emerald-400' : zone === 'bearish' ? 'text-red-400' : 'text-amber-400';
  const delta = Number(r.delta_bx);
  const deltaColor = delta > 0 ? 'text-emerald-400' : 'text-red-400';
  const prevBx = Number(r.prev_bx);
  const curBx = Number(r.bx);
  const transitioned = r.current_zone !== r.previous_zone;
  const tArrow = transitioned && r.previous_zone && r.current_zone
    ? `${r.previous_zone[0].toUpperCase()}→${r.current_zone[0].toUpperCase()}` : null;

  return (
    <div onClick={onSelect} data-ticker={r.ticker}
      role="button" tabIndex={0} aria-label={`${r.ticker} details`}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
      className={`flex items-center px-3 h-11 border-b border-zinc-900 cursor-pointer transition-colors no-tap-highlight ${
        selected ? 'bg-zinc-900 border-l-2 border-l-emerald-400' : 'active:bg-zinc-900'
      }`}>
      <div className="w-14 flex items-center gap-1">
        <button onClick={(e) => { e.stopPropagation(); onToggleWatch(); }} aria-label={`${r.ticker} watchlist`} aria-pressed={watched} className="p-2 -m-1 no-tap-highlight">
          <Star className={`w-3 h-3 ${watched ? 'fill-amber-400 text-amber-400' : 'text-zinc-600'}`} />
        </button>
        <span className="text-[11px] font-bold text-zinc-100 tracking-wider">{r.ticker}</span>
      </div>
      <div className="flex-1 min-w-0 text-right text-[10px] tabular-nums pr-2">
        <span className={zoneColor}>
          {r.prev_bx == null ? '—' : `${prevBx >= 0 ? '+' : ''}${prevBx.toFixed(1)}`}→<span className="font-bold">{curBx >= 0 ? '+' : ''}{curBx.toFixed(1)}</span>
        </span>
      </div>
      <div className="w-14 text-right">
        <span className={`text-[12px] font-bold tabular-nums ${deltaColor}`}>
          {delta >= 0 ? '+' : ''}{delta.toFixed(2)}
        </span>
      </div>
      <div className="w-10 flex items-center justify-end gap-1 pl-1">
        {hasNote && <StickyNote className="w-2.5 h-2.5 text-amber-400/60 flex-shrink-0" />}
        <span className="text-[9px] font-bold tracking-wider">
          {tArrow ? <span className={zoneColor}>{tArrow}</span> : <span className={`${zoneColor} opacity-50 uppercase`}>{zone[0]}</span>}
        </span>
      </div>
    </div>
  );
}

function MoverColumn({ label, accent, rows, meta, selected, onSelect, watchlist, onToggleWatch, notes }) {
  const c = accent === 'emerald' ? { text: 'text-emerald-400', border: 'border-emerald-500/30', bg: 'bg-emerald-500/5' }
                                  : { text: 'text-red-400', border: 'border-red-500/30', bg: 'bg-red-500/5' };
  return (
    <div className="flex flex-col overflow-hidden border-r border-zinc-800 last:border-r-0">
      <div className={`flex items-center justify-between px-3 h-10 border-b ${c.border} ${c.bg}`}>
        <span className={`text-[11px] font-bold tracking-[0.3em] ${c.text}`}>{label}</span>
        <span className={`text-[11px] font-bold ${c.text}`}>{rows.length}</span>
      </div>
      <div className="flex items-center px-3 h-6 border-b border-zinc-900 bg-zinc-950/50 text-[9px] text-zinc-600 tracking-wider uppercase">
        <span className="w-14">Ticker</span><span className="w-14 text-right">BX→</span>
        <span className="flex-1 text-right">Δ delta</span><span className="w-16 text-right">Zone</span>
      </div>
      <div className="flex-1 overflow-y-auto col-scroll">
        {rows.length === 0 ? (
          <div className="px-3 py-8 text-center text-[10px] text-zinc-700 tracking-wider">— NO MOVES —</div>
        ) : rows.map(r => {
          const isSelected = selected === r.ticker;
          const tArrow = r.current_zone !== r.previous_zone && r.previous_zone && r.current_zone
            ? `${r.previous_zone[0].toUpperCase()}→${r.current_zone[0].toUpperCase()}` : null;
          return (
            <div key={r.ticker} onClick={() => onSelect(r.ticker)} data-ticker={r.ticker}
              role="button" tabIndex={0} aria-label={`${r.ticker} details`}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(r.ticker); } }}
              className={`group flex items-center px-3 h-9 border-b border-zinc-900 cursor-pointer no-tap-highlight ${
                isSelected ? 'bg-zinc-900 border-l-2 border-l-emerald-400' : 'active:bg-zinc-900 md:hover:bg-zinc-900/50'
              }`}>
              <div className="w-14 flex items-center gap-1">
                <button onClick={(e) => { e.stopPropagation(); onToggleWatch(r.ticker); }}
                  aria-label={`${r.ticker} watchlist`} aria-pressed={!!watchlist[r.ticker]}
                  className={`${watchlist[r.ticker] ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100'} p-2 -m-1`}>
                  <Star className={`w-2.5 h-2.5 ${watchlist[r.ticker] ? 'fill-amber-400 text-amber-400' : 'text-zinc-600'}`} />
                </button>
                <span className="text-[11px] font-bold text-zinc-100 tracking-wider">{r.ticker}</span>
              </div>
              <span className={`w-14 text-right text-[10px] tabular-nums ${c.text}`}>
                {r.prev_bx == null ? '—' : `${Number(r.prev_bx) >= 0 ? '+' : ''}${Number(r.prev_bx).toFixed(1)}`}→<span className="font-bold">{r.bx >= 0 ? '+' : ''}{Number(r.bx).toFixed(1)}</span>
              </span>
              <span className={`flex-1 text-right text-[11px] font-bold tabular-nums ${c.text}`}>
                {Number(r.delta_bx) >= 0 ? '+' : ''}{Number(r.delta_bx).toFixed(2)}
              </span>
              <span className="w-16 text-right text-[9px] tracking-wider">
                {tArrow ? <span className={c.text}>{tArrow}</span> : <span className="text-zinc-600 uppercase">{r.current_zone}</span>}
              </span>
              {notes[r.ticker] && <StickyNote className="w-2.5 h-2.5 text-amber-400/60 ml-1" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// SectorsView moved to ./SectorsView (lazy-loaded).

// BacktestView moved to ./BacktestView (lazy-loaded).

// ============================================================================
// COLUMNS
// ============================================================================

function MobileZoneTab({ label, count, active, accent, onClick }) {
  const colors = {
    red:     { text: active ? 'text-red-400' : 'text-zinc-500',     border: 'border-b-red-400',     dot: 'bg-red-500' },
    amber:   { text: active ? 'text-amber-400' : 'text-zinc-500',   border: 'border-b-amber-400',   dot: 'bg-amber-500' },
    emerald: { text: active ? 'text-emerald-400' : 'text-zinc-500', border: 'border-b-emerald-400', dot: 'bg-emerald-500' },
  };
  const c = colors[accent];
  return (
    <button onClick={onClick} className={`flex-1 flex flex-col items-center justify-center gap-0.5 h-12 border-r border-zinc-800 last:border-r-0 no-tap-highlight ${
      active ? `bg-zinc-900 border-b-2 ${c.border}` : 'active:bg-zinc-900/50'
    }`}>
      <div className="flex items-center gap-1.5">
        <div className={`w-1.5 h-1.5 ${c.dot}`} />
        <span className={`text-[10px] font-bold tracking-[0.25em] ${c.text}`}>{label}</span>
      </div>
      <span className={`text-[11px] font-bold ${c.text}`}>{count}</span>
    </button>
  );
}

function ZoneColumn({ label, range, accent, rows, selected, onSelect, watchlist, onToggleWatch, notes, sortDir, onToggleSort }) {
  const accentMap = {
    red:     { text: 'text-red-400',     bg: 'bg-red-500/5',     border: 'border-red-500/30',     dot: 'bg-red-500',     hoverBorder: 'hover:border-red-500/60',     hoverBg: 'hover:bg-red-500/10' },
    amber:   { text: 'text-amber-400',   bg: 'bg-amber-500/5',   border: 'border-amber-500/30',   dot: 'bg-amber-500',   hoverBorder: 'hover:border-amber-500/60',   hoverBg: 'hover:bg-amber-500/10' },
    emerald: { text: 'text-emerald-400', bg: 'bg-emerald-500/5', border: 'border-emerald-500/30', dot: 'bg-emerald-500', hoverBorder: 'hover:border-emerald-500/60', hoverBg: 'hover:bg-emerald-500/10' },
  };
  const c = accentMap[accent];
  const SortArrow = sortDir === 'asc' ? ChevronUp : ChevronDown;
  return (
    <div className="flex flex-col overflow-hidden border-r border-zinc-800 last:border-r-0">
      <div className={`flex items-center justify-between px-3 h-10 border-b ${c.border} ${c.bg}`}>
        <div className="flex items-center gap-2">
          <div className={`w-1.5 h-1.5 ${c.dot}`} />
          <span className={`text-[11px] font-bold tracking-[0.3em] ${c.text}`}>{label}</span>
          <span className="text-[9px] text-zinc-500 tracking-wider">{range}</span>
        </div>
        <button onClick={onToggleSort}
          title={`Sort by BX ${sortDir === 'asc' ? 'ascending (negative → positive)' : 'descending (positive → negative)'} — click to flip`}
          className={`flex items-center gap-1 px-2 py-0.5 border ${c.border} bg-zinc-950/40 ${c.hoverBg} ${c.hoverBorder} transition-colors no-tap-highlight`}>
          <SortArrow className={`w-3 h-3 ${c.text}`} />
          <span className={`text-[11px] font-bold ${c.text}`}>{rows.length}</span>
        </button>
      </div>
      <div className="flex items-center px-3 h-6 border-b border-zinc-900 bg-zinc-950/50 text-[9px] text-zinc-600 tracking-wider uppercase">
        <span className="w-14">Ticker</span><span className="w-12 text-right">BX</span>
        <span className="flex-1 text-right">PX · 52w · Bias</span><span className="w-14 text-right">Earn·Δ</span>
      </div>
      <VirtualRowList rows={rows} selected={selected} onSelect={onSelect}
        watchlist={watchlist} onToggleWatch={onToggleWatch} notes={notes}/>
    </div>
  );
}

// Virtualized row list — only the visible rows mount (a zone list can be ~600 rows).
// Owns its own scroll, so selection scroll uses scrollToIndex (off-screen rows aren't in the DOM).
function VirtualRowList({ rows, selected, onSelect, watchlist, onToggleWatch, notes, mobile }) {
  const parentRef = useRef(null);
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => (mobile ? 45 : 37),
    overscan: 12,
  });
  useEffect(() => {
    const idx = rows.findIndex(r => r.t === selected);
    if (idx >= 0) virt.scrollToIndex(idx, { align: 'auto' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);
  if (rows.length === 0) {
    return (
      <div ref={parentRef} className="flex-1 overflow-y-auto col-scroll">
        <div className="px-3 py-8 text-center text-[10px] text-zinc-700 tracking-wider">— NO MATCHES —</div>
      </div>
    );
  }
  return (
    <div ref={parentRef} className="flex-1 overflow-y-auto col-scroll">
      <div style={{ height: virt.getTotalSize(), width: '100%', position: 'relative' }}>
        {virt.getVirtualItems().map(vi => {
          const r = rows[vi.index];
          return (
            <div key={r.t} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}>
              <RowItem r={r} zone={r.zone} selected={selected === r.t}
                onSelect={() => onSelect(r.t)} watched={!!watchlist[r.t]}
                onToggleWatch={() => onToggleWatch(r.t)} hasNote={!!notes[r.t]} mobile={mobile}/>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const RowItem = React.memo(function RowItem({ r, zone, selected, onSelect, watched, onToggleWatch, hasNote, mobile }) {
  const c = zone === 'bullish' ? { text: 'text-emerald-400' } : zone === 'bearish' ? { text: 'text-red-400' } : { text: 'text-amber-400' };
  const extreme = Math.abs(r.bx) > 10;
  const tArrow = r.transition ? (r.transition.to === 'bullish' ? '↑' : r.transition.to === 'bearish' ? '↓' : '→') : null;
  return (
    <div onClick={onSelect} data-ticker={r.t}
      role="button" tabIndex={0} aria-label={`${r.t} details`}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
      className={`group flex items-center px-3 ${mobile ? 'h-11' : 'h-9'} border-b border-zinc-900 cursor-pointer transition-colors no-tap-highlight ${
        selected ? 'bg-zinc-900 border-l-2 border-l-emerald-400' : 'active:bg-zinc-900 md:hover:bg-zinc-900/50'
      }`}>
      <div className="w-14 flex items-center gap-1">
        <button onClick={(e) => { e.stopPropagation(); onToggleWatch(); }}
          aria-label={`${r.t} watchlist`} aria-pressed={watched}
          className={`${mobile || watched ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100'} transition-opacity p-2 -m-1`}>
          <Star className={`${mobile ? 'w-3 h-3' : 'w-2.5 h-2.5'} ${watched ? 'fill-amber-400 text-amber-400' : 'text-zinc-600'}`} />
        </button>
        <span className="text-[11px] font-bold text-zinc-100 tracking-wider">{r.t}</span>
      </div>
      <div className="w-12 flex items-center justify-end">
        <span className={`text-[11px] font-bold ${c.text} ${extreme ? 'underline decoration-dotted underline-offset-2' : ''}`}>
          {r.bx >= 0 ? '+' : ''}{r.bx.toFixed(2)}
        </span>
      </div>
      <div className="flex-1 min-w-0 text-right text-[9px] tabular-nums flex items-center justify-end gap-1.5">
        <AlignDots score={r.align} />
        <span className="text-zinc-500">${r.px ? r.px.toFixed(2) : '—'}</span>
        {r.pct52 != null && (
          <span className={`text-[8px] ${r.pct52 > 80 ? 'text-emerald-500' : r.pct52 < 20 ? 'text-red-500' : 'text-zinc-600'}`}>{r.pct52.toFixed(0)}%</span>
        )}
        <BiasBadge direction={r.biasDir} inZone={r.inZone} compact={!mobile}/>
      </div>
      <div className="w-14 flex items-center justify-end gap-1">
        <EarnBadge daysToEarn={r.daysToEarn} mobile={mobile} />
        {hasNote && <StickyNote className="w-2.5 h-2.5 text-amber-400/60" />}
        {r.transition && (
          <span className={`text-[11px] font-bold ${r.transition.to === 'bullish' ? 'text-emerald-400' : r.transition.to === 'bearish' ? 'text-red-400' : 'text-amber-400'}`}>
            {tArrow}
          </span>
        )}
      </div>
    </div>
  );
}, (a, b) => a.r === b.r && a.zone === b.zone && a.selected === b.selected && a.watched === b.watched && a.hasNote === b.hasNote && a.mobile === b.mobile);

// ============================================================================
// DETAIL PANEL
// ============================================================================

function DetailPanel({ ticker, row, meta, interval, timeframe, notes, setNotes, watchlist, onToggleWatch, compact = false }) {
  const noteVal = notes[ticker] || '';
  const setNote = (v) => setNotes(n => ({ ...n, [ticker]: v }));
  const watched = !!watchlist[ticker];
  const [tickerBacktest, setTickerBacktest] = useState([]);
  const [btError, setBtError] = useState(false);
  const [aiCopied, setAiCopied] = useState(false);
  const [aiError,  setAiError]  = useState(false);
  // Debounce the ticker driving the chart + per-ticker backtest so arrow-scrubbing
  // doesn't reload the TradingView iframe / refetch on every keystroke.
  const [debTicker, setDebTicker] = useState(ticker);
  useEffect(() => { const id = setTimeout(() => setDebTicker(ticker), 250); return () => clearTimeout(id); }, [ticker]);

  // Robust clipboard copy: modern API → fallback to hidden textarea → flag error
  const copyToClipboard = async (text) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fall through to fallback */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  };

  useEffect(() => {
    if (!debTicker || !compact) return;
    let ignore = false;
    setBtError(false);
    fetchBacktestForTicker(debTicker, timeframe)
      .then(d => { if (!ignore) setTickerBacktest(d); })
      .catch(() => { if (!ignore) { setTickerBacktest([]); setBtError(true); } });
    return () => { ignore = true; };
  }, [debTicker, timeframe, compact]);

  const bx = row?.bx;
  const prev = row?.prev;
  const zone = row?.zone;
  const zoneColor = zone === 'bullish' ? 'text-emerald-400' : zone === 'bearish' ? 'text-red-400' : 'text-amber-400';
  const align = meta.align;
  const earnLvl = earnLevel(meta.daysToEarn);

  // AI brief prompt builder — copies to clipboard
  const generateAIPrompt = () => {
    const lines = [
      `You are a LEAPS options trading assistant. The trader uses BX-Trender + Market Bias to find setups.`,
      `Give a 3-sentence assessment: (1) is this a clean setup or messy? (2) the main risk to watch (3) the one thing that would invalidate the thesis.`,
      ``,
      `TICKER: ${ticker}`,
      `Exchange: ${meta.ex || '—'} · Sector: ${meta.sec || '—'} · Industry: ${meta.ind || '—'}`,
      `Price: $${meta.px ? meta.px.toFixed(2) : '—'}  ·  Market cap: ${meta.mc ? (meta.mc >= 1000 ? `$${(meta.mc/1000).toFixed(2)}T` : `$${meta.mc.toFixed(1)}B`) : '—'}`,
      ``,
      `BX-TRENDER (current timeframe = ${SCAN_META[timeframe].label}):`,
      `  Current: ${bx != null ? bx.toFixed(2) : '—'} (zone: ${zone || '—'})`,
      `  Previous: ${prev != null ? prev.toFixed(2) : '—'}`,
      row?.transition && `  Just transitioned: ${row.transition.from} → ${row.transition.to}`,
      ``,
      `MULTI-TIMEFRAME CONFLUENCE:`,
      `  Daily BX: ${meta.daily != null ? meta.daily.toFixed(2) : '—'}`,
      `  Weekly BX: ${meta.weekly != null ? meta.weekly.toFixed(2) : '—'}`,
      `  Monthly BX: ${meta.monthly != null ? meta.monthly.toFixed(2) : '—'}`,
      `  Alignment score: ${align != null ? `${align}/3 (${align > 0 ? 'all leaning bullish' : align < 0 ? 'all leaning bearish' : 'mixed'})` : '—'}`,
      `  Composite BX: ${meta.composite != null ? meta.composite.toFixed(2) : '—'}`,
      ``,
      `MARKET BIAS (${SCAN_META[timeframe].label}):`,
      `  Direction: ${meta.biasDir || '—'}`,
      `  In zone (price testing bias): ${meta.inZone ? 'YES — at potential support/resistance' : 'NO — outside the zone'}`,
      ``,
      `52-WEEK RANGE:`,
      `  Position: ${meta.pct52 != null ? `${meta.pct52.toFixed(0)}% of range` : '—'}`,
      `  High: $${meta.hi52 ? meta.hi52.toFixed(2) : '—'}  ·  Low: $${meta.lo52 ? meta.lo52.toFixed(2) : '—'}`,
      ``,
      `EARNINGS: ${meta.earn ? `${meta.earn} (${meta.daysToEarn}d out)` : 'no upcoming earnings in next 90d'}`,
    ].filter(Boolean).join('\n');
    copyToClipboard(lines).then(ok => {
      if (ok) {
        setAiCopied(true);
        setAiError(false);
        setTimeout(() => setAiCopied(false), 2000);
      } else {
        setAiError(true);
        setTimeout(() => setAiError(false), 3000);
      }
    });
  };

  const renderHeader = () => (
    <div className="px-4 h-14 border-b border-zinc-800 flex items-center justify-between flex-shrink-0">
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-xl font-bold tracking-[0.15em] text-zinc-100">{ticker}</span>
        <div className="flex flex-col text-[9px] text-zinc-500 tracking-wider min-w-0">
          <span className="truncate">{meta.ex || '—'} · {meta.sec || '—'}</span>
          <span className="truncate text-zinc-600">{meta.ind || ''}</span>
        </div>
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <button onClick={generateAIPrompt}
          className={`p-1.5 border text-[9px] tracking-wider flex items-center gap-1 ${
            aiError ? 'border-red-500 text-red-400 bg-red-500/10' :
            aiCopied ? 'border-emerald-500 text-emerald-400 bg-emerald-500/10' :
            'border-zinc-800 text-zinc-400 hover:border-purple-500/50 active:border-purple-500/50'
          }`}
          title="Copy AI prompt to clipboard, paste into Claude.ai or ChatGPT">
          {aiError ? <><X className="w-3 h-3" />FAILED</> : aiCopied ? <><Check className="w-3 h-3" />COPIED</> : <><Sparkles className="w-3 h-3" />AI</>}
        </button>
        <button onClick={() => onToggleWatch(ticker)} aria-label={`${ticker} watchlist`} aria-pressed={watched} className="p-1.5 border border-zinc-800 active:border-amber-500/50 md:hover:border-amber-500/50">
          <Star className={`w-3.5 h-3.5 ${watched ? 'fill-amber-400 text-amber-400' : 'text-zinc-500'}`} />
        </button>
      </div>
    </div>
  );

  const renderEarningsBanner = () => earnLvl && (
    <div className={`px-4 py-2 border-b ${earnLvl === 'imminent' ? 'bg-red-500/10 border-red-500/40' : 'bg-amber-500/10 border-amber-500/40'} flex-shrink-0`}>
      <div className="flex items-center gap-2 text-[11px] tracking-wider">
        <Calendar className={`w-3.5 h-3.5 ${earnLvl === 'imminent' ? 'text-red-400' : 'text-amber-400'}`} />
        <span className={earnLvl === 'imminent' ? 'text-red-400 font-bold' : 'text-amber-400 font-bold'}>
          {earnLvl === 'imminent' ? '⚠ EARNINGS IMMINENT' : '🔔 EARNINGS SOON'}
        </span>
        <span className="text-zinc-300">{meta.earn}</span>
        <span className="text-zinc-500">· {meta.daysToEarn}d out</span>
      </div>
    </div>
  );

  const renderStats = () => (
    <div className="grid grid-cols-4 border-b border-zinc-800 text-[10px] flex-shrink-0">
      <Stat label="BX"   value={bx != null ? `${bx >= 0 ? '+' : ''}${bx.toFixed(2)}` : '—'} valueClass={zoneColor} />
      <Stat label="PREV" value={prev != null ? `${prev >= 0 ? '+' : ''}${prev.toFixed(2)}` : '—'} />
      <Stat label="PX"   value={meta.px ? `$${meta.px.toFixed(2)}` : '—'} />
      <Stat label="MCAP" value={meta.mc ? (meta.mc >= 1000 ? `$${(meta.mc/1000).toFixed(2)}T` : `$${meta.mc.toFixed(1)}B`) : '—'} />
    </div>
  );

  const renderConfluenceBody = () => align == null ? (
    <div className="px-4 py-3 text-[10px] text-zinc-600 tracking-wider">No multi-timeframe data yet.</div>
  ) : (
    <div className="px-4 py-2.5">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <AlignDots score={align} />
          <span className={`text-[11px] font-bold tabular-nums ${align > 0 ? 'text-emerald-400' : align < 0 ? 'text-red-400' : 'text-amber-400'}`}>{align >= 0 ? '+' : ''}{align}/3</span>
        </div>
        {meta.composite != null && (
          <span className="text-[10px] text-zinc-500 tabular-nums">
            COMPOSITE: <span className="text-zinc-300">{meta.composite >= 0 ? '+' : ''}{Number(meta.composite).toFixed(2)}</span>
          </span>
        )}
      </div>
      <div className="grid grid-cols-3 gap-1.5 text-[9px]">
        {[{ lbl: 'D', val: meta.daily }, { lbl: 'W', val: meta.weekly }, { lbl: 'M', val: meta.monthly }].map(({ lbl, val }) => {
          const z = val == null ? 'zinc' : val > 2 ? 'emerald' : val < -2 ? 'red' : 'amber';
          const cls = z === 'emerald' ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400'
                    : z === 'red'     ? 'bg-red-500/10 border-red-500/40 text-red-400'
                    : z === 'amber'   ? 'bg-amber-500/10 border-amber-500/40 text-amber-400'
                    : 'bg-zinc-900 border-zinc-800 text-zinc-600';
          return (
            <div key={lbl} className={`border px-2 py-1.5 flex items-center justify-between ${cls}`}>
              <span className="font-bold tracking-wider">{lbl}</span>
              <span className="tabular-nums">{val == null ? '—' : `${val >= 0 ? '+' : ''}${Number(val).toFixed(1)}`}</span>
            </div>
          );
        })}
      </div>
    </div>
  );

  const renderBxRangeBody = () => bx == null ? null : (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between text-[9px] text-zinc-600 tracking-wider mb-1">
        <span className="text-zinc-500">SCALE</span>
        <div className="flex items-center gap-3 text-zinc-700">
          <span>−10</span><span>−2</span><span>0</span><span>+2</span><span>+10</span>
        </div>
      </div>
      <div className="relative h-2 bg-zinc-900 overflow-hidden">
        <div className="absolute inset-y-0 left-0 w-[40%] bg-red-500/20" />
        <div className="absolute inset-y-0 left-[40%] w-[20%] bg-amber-500/20" />
        <div className="absolute inset-y-0 left-[60%] w-[40%] bg-emerald-500/20" />
        {prev != null && <div className="absolute top-0 bottom-0 w-px bg-zinc-600" style={{ left: `${Math.max(0, Math.min(100, ((Math.max(-10, Math.min(10, prev)) + 10) / 20) * 100))}%` }}/>}
        <div className={`absolute top-0 bottom-0 w-0.5 ${zone === 'bullish' ? 'bg-emerald-400' : zone === 'bearish' ? 'bg-red-400' : 'bg-amber-400'}`}
          style={{ left: `${Math.max(0, Math.min(100, ((Math.max(-10, Math.min(10, bx)) + 10) / 20) * 100))}%` }}/>
      </div>
      {row?.transition && (
        <div className="mt-2 flex items-center gap-2 text-[10px]">
          <span className="text-zinc-500 tracking-wider">TRANSITION:</span>
          <span className="text-zinc-400 tracking-wider uppercase">{row.transition.from}</span>
          <ArrowRight className="w-3 h-3 text-zinc-600" />
          <span className={`tracking-wider uppercase font-bold ${zoneColor}`}>{row.transition.to}</span>
        </div>
      )}
    </div>
  );

  const renderMarketBiasBody = () => !meta.biasDir ? (
    <div className="px-4 py-3 text-[10px] text-zinc-600 tracking-wider">No Market Bias data (insufficient history).</div>
  ) : (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] tracking-wider text-zinc-500">DIRECTION:</span>
          <span className={`text-[12px] font-bold tracking-wider ${meta.biasDir === 'bullish' ? 'text-emerald-400' : 'text-red-400'}`}>
            {meta.biasDir === 'bullish' ? '▲ BULLISH' : '▼ BEARISH'}
          </span>
        </div>
        <span className="text-[10px] tabular-nums text-zinc-500">
          OSC: {meta.biasOsc == null ? <span className="text-zinc-600">—</span> : <span className={`${meta.biasOsc >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{meta.biasOsc >= 0 ? '+' : ''}{meta.biasOsc.toFixed(2)}</span>}
        </span>
      </div>
      <div className={`p-2 border ${meta.inZone ? 'border-cyan-500/50 bg-cyan-500/10' : 'border-zinc-800 bg-zinc-900/30'}`}>
        <div className="flex items-center gap-2 text-[11px]">
          {meta.inZone ? (
            <>
              <Target className="w-3.5 h-3.5 text-cyan-400" />
              <span className="text-cyan-400 font-bold tracking-wider">IN THE ZONE</span>
              <span className="text-zinc-400">— price is testing the bias level. {meta.biasDir === 'bullish' ? 'Potential bullish entry zone (buy-the-dip).' : 'Potential bearish entry zone (sell-the-rip).'}</span>
            </>
          ) : (
            <>
              <Target className="w-3.5 h-3.5 text-zinc-600" />
              <span className="text-zinc-500 font-bold tracking-wider">OUT OF ZONE</span>
              <span className="text-zinc-600">— price is extended {meta.biasDir === 'bullish' ? 'above' : 'below'} the bias. Wait for pullback.</span>
            </>
          )}
        </div>
      </div>
    </div>
  );

  const renderRange52wBody = () => (meta.pct52 == null || !meta.hi52 || !meta.lo52) ? null : (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between text-[9px] text-zinc-600 tracking-wider mb-1">
        <span className="text-zinc-500">POSITION</span>
        <span className={`tabular-nums font-bold ${meta.pct52 > 80 ? 'text-emerald-400' : meta.pct52 < 20 ? 'text-red-400' : 'text-zinc-400'}`}>{meta.pct52.toFixed(0)}% of range</span>
      </div>
      <div className="relative h-2 bg-zinc-900 overflow-hidden">
        <div className="absolute inset-y-0 left-0 bg-cyan-500/30" style={{ width: `${meta.pct52}%` }} />
        <div className="absolute top-0 bottom-0 w-0.5 bg-cyan-400" style={{ left: `${Math.max(0, Math.min(100, meta.pct52))}%` }} />
      </div>
      <div className="flex items-center justify-between text-[9px] text-zinc-600 tracking-wider mt-1 tabular-nums">
        <span>L ${Number(meta.lo52).toFixed(2)}</span>
        <span>NOW ${meta.px ? meta.px.toFixed(2) : '—'}</span>
        <span>H ${Number(meta.hi52).toFixed(2)}</span>
      </div>
    </div>
  );

  const renderBacktestBody = () => tickerBacktest.length === 0 ? (
    <div className="px-4 py-3 text-[10px] text-zinc-600 tracking-wider">{btError ? 'Failed to load backtest — refresh to retry.' : `No historical signals for ${ticker} on this timeframe yet.`}</div>
  ) : (
    <div className="px-4 py-3">
      <div className="text-[9px] text-zinc-500 tracking-wider mb-2">Last {Math.min(tickerBacktest.length, 5)} signals · forward return at 60 {timeframe === 'daily' ? 'days' : timeframe === 'weekly' ? 'weeks' : 'months'}</div>
      <div className="space-y-1.5">
        {tickerBacktest.slice(0, 5).map((s) => {
          const ret = s.ret_60d;
          const retColor = ret == null ? 'text-zinc-600' : ret > 0 ? 'text-emerald-400' : 'text-red-400';
          const sigParts = s.signal_type.split('_to_');
          return (
            <div key={s.id} className="flex items-center justify-between text-[10px] py-1 border-b border-zinc-900 last:border-b-0">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-zinc-500 tabular-nums">{s.signal_date}</span>
                <span className="text-zinc-600 tracking-wider uppercase truncate">{sigParts[0]} → {sigParts[1]}</span>
              </div>
              <span className={`font-bold tabular-nums ${retColor}`}>
                {ret == null ? 'pending' : `${ret >= 0 ? '+' : ''}${Number(ret).toFixed(1)}%`}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );

  const renderNotesBody = () => (
    <textarea value={noteVal} onChange={(e) => setNote(e.target.value)}
      placeholder={`LEAPS thesis · strike / expiry / entry trigger…`} aria-label={`Trade notes for ${ticker}`}
      className="w-full h-28 bg-zinc-950 text-zinc-200 text-[11px] px-4 py-2 resize-none focus:outline-none focus:bg-zinc-900/50 block"/>
  );

  // Collapsed summary badges
  const confluenceSummary = align != null ? (
    <span className="flex items-center gap-1.5">
      <AlignDots score={align} />
      <span className={`tabular-nums font-bold ${align > 0 ? 'text-emerald-400' : align < 0 ? 'text-red-400' : 'text-amber-400'}`}>{align >= 0 ? '+' : ''}{align}/3</span>
    </span>
  ) : <span className="text-zinc-600">—</span>;

  const bxSummary = bx != null ? <span className={`tabular-nums font-bold ${zoneColor}`}>{bx >= 0 ? '+' : ''}{bx.toFixed(2)}</span> : <span className="text-zinc-600">—</span>;

  const biasSummary = meta.biasDir ? (
    <span className="flex items-center gap-1">
      <span className={`font-bold ${meta.biasDir === 'bullish' ? 'text-emerald-400' : 'text-red-400'}`}>
        {meta.biasDir === 'bullish' ? '▲ BULL' : '▼ BEAR'}
      </span>
      {meta.inZone && <span className="text-cyan-400 font-bold">·IN-ZONE</span>}
    </span>
  ) : <span className="text-zinc-600">—</span>;

  const range52Summary = meta.pct52 != null ? <span className={`tabular-nums font-bold ${meta.pct52 > 80 ? 'text-emerald-400' : meta.pct52 < 20 ? 'text-red-400' : 'text-zinc-400'}`}>{meta.pct52.toFixed(0)}%</span> : <span className="text-zinc-600">—</span>;

  const backtestSummary = tickerBacktest.length > 0 ? (
    <span className="text-zinc-400">{tickerBacktest.length} signals</span>
  ) : <span className="text-zinc-600">—</span>;

  const notesSummary = noteVal ? <span className="text-zinc-400">{noteVal.length} ch</span> : <span className="text-zinc-600">—</span>;

  // COMPACT — used by both desktop sidebar AND mobile drawer
  return (
    <div className="flex flex-col h-full overflow-y-auto col-scroll">
      <div className="sticky top-0 z-20 bg-zinc-950 flex-shrink-0">
        {renderHeader()}{renderEarningsBanner()}{renderStats()}
      </div>
      <CollapsibleSection title="CONFLUENCE" icon={Target} summary={confluenceSummary}>{renderConfluenceBody()}</CollapsibleSection>
      <CollapsibleSection title="BX RANGE"   icon={Activity} summary={bxSummary}>{renderBxRangeBody()}</CollapsibleSection>
      <CollapsibleSection title="MARKET BIAS" icon={BarChart3} summary={biasSummary}>{renderMarketBiasBody()}</CollapsibleSection>
      <CollapsibleSection title="52-WEEK"    icon={TrendingUp} summary={range52Summary}>{renderRange52wBody()}</CollapsibleSection>
      <CollapsibleSection title="BACKTEST"   icon={History}    summary={backtestSummary}>{renderBacktestBody()}</CollapsibleSection>
      <div className="flex-1 min-h-[60vh] flex-shrink-0 relative border-b border-zinc-800 bg-zinc-950">
        <div className="absolute top-2 left-3 z-10 text-[9px] tracking-[0.3em] text-zinc-600 pointer-events-none">TRADINGVIEW · {interval}</div>
        {debTicker && <TVChart ticker={debTicker} interval={interval} exchange={meta.ex} />}
      </div>
      <CollapsibleSection title="NOTES" icon={StickyNote} summary={notesSummary}>{renderNotesBody()}</CollapsibleSection>
    </div>
  );
}

// Stat is imported from ./shared.

// ============================================================================
// DRAWERS
// ============================================================================

function MobileFiltersDrawer({ mcBucket, setMcBucket, priceMin, setPriceMin, priceMax, setPriceMax, volMin, setVolMin, earnFilter, setEarnFilter, pct52Filter, setPct52Filter, biasFilter, setBiasFilter, inZoneOnly, setInZoneOnly, hasActiveFilters, onClear, onClose }) {
  return (
    <div role="dialog" aria-modal="true" aria-label="Filters" className="lg:hidden fixed inset-0 bg-black/70 flex items-end z-50" onClick={onClose}>
      <div className="w-full bg-zinc-950 border-t border-zinc-800 slide-up max-h-[88vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 h-12 border-b border-zinc-800 sticky top-0 bg-zinc-950">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="w-3.5 h-3.5 text-emerald-400" />
            <span className="text-[11px] tracking-[0.3em] font-bold text-emerald-400">FILTERS</span>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5"><X className="w-4 h-4 text-zinc-500" /></button>
        </div>
        <div className="p-4 space-y-5">
          <div>
            <div className="text-[10px] tracking-[0.3em] text-zinc-500 mb-2">MARKET BIAS</div>
            <div className="grid grid-cols-3 gap-2 mb-2">
              {BIAS_BUCKETS.map((b, i) => (
                <button key={b.label} onClick={() => setBiasFilter(i)}
                  className={`px-3 py-2 border text-[11px] tracking-wider ${
                    biasFilter === i
                      ? (i === 1 ? 'border-emerald-500 text-emerald-400 bg-emerald-500/5' : i === 2 ? 'border-red-500 text-red-400 bg-red-500/5' : 'border-emerald-500 text-emerald-400 bg-emerald-500/5')
                      : 'border-zinc-800 text-zinc-400'
                  }`}>{b.label}</button>
              ))}
            </div>
            <button onClick={() => setInZoneOnly(z => !z)}
              className={`w-full px-3 py-2 border text-[11px] tracking-wider ${inZoneOnly ? 'border-cyan-500 text-cyan-400 bg-cyan-500/5' : 'border-zinc-800 text-zinc-400'}`}>
              {inZoneOnly ? '✓ ONLY SHOW "IN ZONE"' : 'ONLY SHOW "IN ZONE"'}
            </button>
          </div>
          <div>
            <div className="text-[10px] tracking-[0.3em] text-zinc-500 mb-2">MARKET CAP</div>
            <div className="grid grid-cols-2 gap-2">
              {MC_BUCKETS.map((b, i) => (
                <button key={b.label} onClick={() => setMcBucket(i)}
                  className={`px-3 py-2 border text-[11px] tracking-wider ${mcBucket === i ? 'border-emerald-500 text-emerald-400 bg-emerald-500/5' : 'border-zinc-800 text-zinc-400 active:border-zinc-600'}`}>{MC_BUCKETS_LONG[i]}</button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-[10px] tracking-[0.3em] text-zinc-500 mb-2">EARNINGS · skip if within</div>
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5">
              {EARN_BUCKETS.map((b, i) => (
                <button key={b.label} onClick={() => setEarnFilter(i)}
                  className={`px-2 py-2 border text-[10px] tracking-wider ${earnFilter === i ? 'border-amber-500 text-amber-400 bg-amber-500/5' : 'border-zinc-800 text-zinc-400'}`}>{b.label}</button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-[10px] tracking-[0.3em] text-zinc-500 mb-2">52-WEEK POSITION</div>
            <div className="grid grid-cols-2 gap-2">
              {PCT52_BUCKETS.map((b, i) => (
                <button key={b.label} onClick={() => setPct52Filter(i)}
                  className={`px-3 py-2 border text-[11px] tracking-wider ${pct52Filter === i ? 'border-cyan-500 text-cyan-400 bg-cyan-500/5' : 'border-zinc-800 text-zinc-400'}`}>{b.label}</button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-[10px] tracking-[0.3em] text-zinc-500 mb-2">PRICE RANGE ($)</div>
            <div className="flex items-center gap-2">
              <input value={priceMin} onChange={e => setPriceMin(e.target.value)} placeholder="MIN" type="number" inputMode="decimal" aria-label="Minimum price"
                className="flex-1 bg-zinc-900 border border-zinc-800 text-zinc-200 text-[12px] px-3 py-2 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 tracking-wider"/>
              <span className="text-zinc-700">–</span>
              <input value={priceMax} onChange={e => setPriceMax(e.target.value)} placeholder="MAX" type="number" inputMode="decimal" aria-label="Maximum price"
                className="flex-1 bg-zinc-900 border border-zinc-800 text-zinc-200 text-[12px] px-3 py-2 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 tracking-wider"/>
            </div>
          </div>
          <div>
            <div className="text-[10px] tracking-[0.3em] text-zinc-500 mb-2">MIN VOLUME (M)</div>
            <input value={volMin} onChange={e => setVolMin(e.target.value)} placeholder="0" type="number" inputMode="decimal" aria-label="Minimum volume (millions)"
              className="w-full bg-zinc-900 border border-zinc-800 text-zinc-200 text-[12px] px-3 py-2 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 tracking-wider"/>
          </div>
        </div>
        <div className="flex gap-2 p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] border-t border-zinc-800 sticky bottom-0 bg-zinc-950">
          {hasActiveFilters && (
            <button onClick={onClear} className="flex-1 py-3 border border-zinc-800 text-[11px] text-red-400 tracking-[0.2em] active:bg-red-500/5">CLEAR</button>
          )}
          <button onClick={onClose} className="flex-1 py-3 bg-emerald-500/10 border border-emerald-500 text-[11px] text-emerald-400 tracking-[0.2em] active:bg-emerald-500/20">APPLY</button>
        </div>
      </div>
    </div>
  );
}

function AlertsDrawer({ transitions, onClose, onSelect }) {
  return (
    <div role="dialog" aria-modal="true" aria-label="Zone transitions" className="fixed inset-0 bg-black/60 flex items-start justify-end z-50" onClick={onClose}>
      <div className="w-full md:w-[480px] h-full bg-zinc-950 border-l border-zinc-800 flex flex-col slide-right pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 h-12 border-b border-zinc-800 flex-shrink-0">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-amber-400" />
            <span className="text-[11px] tracking-[0.3em] font-bold text-amber-400">ZONE.TRANSITIONS</span>
            <span className="text-[10px] text-zinc-500">({transitions.length})</span>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5"><X className="w-4 h-4 text-zinc-500" /></button>
        </div>
        <div className="flex-1 overflow-y-auto col-scroll">
          {transitions.length === 0 ? (
            <div className="p-8 text-center text-[10px] text-zinc-600 tracking-wider">— NO ZONE TRANSITIONS SINCE LAST SCAN —</div>
          ) : [...transitions].sort((a, b) => Math.abs(b.bx - (b.prev ?? 0)) - Math.abs(a.bx - (a.prev ?? 0))).map(r => {
            const toClass = r.zone === 'bullish' ? 'text-emerald-400' : r.zone === 'bearish' ? 'text-red-400' : 'text-amber-400';
            return (
              <div key={r.t} onClick={() => onSelect(r.t)}
                role="button" tabIndex={0} aria-label={`${r.t} details`}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(r.t); } }}
                className="px-4 py-3 border-b border-zinc-900 active:bg-zinc-900 md:hover:bg-zinc-900 cursor-pointer">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[13px] font-bold tracking-wider text-zinc-100">{r.t}</span>
                  <span className={`text-[12px] font-bold ${toClass}`}>{r.bx >= 0 ? '+' : ''}{r.bx.toFixed(2)}</span>
                </div>
                <div className="flex items-center gap-2 text-[10px] tracking-wider">
                  <span className="text-zinc-500">{r.transition.from.toUpperCase()}</span>
                  <ArrowRight className="w-3 h-3 text-zinc-700" />
                  <span className={`font-bold ${toClass}`}>{r.transition.to.toUpperCase()}</span>
                  {r.prev != null && <span className="ml-auto text-zinc-600">Δ {(r.bx - r.prev).toFixed(2)}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
