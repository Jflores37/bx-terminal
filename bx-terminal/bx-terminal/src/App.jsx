import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Star, StickyNote, X, Search, AlertCircle, ArrowRight, Radio,
  SlidersHorizontal, ChevronLeft, ChevronDown, ChevronUp, RefreshCw, TrendingUp, Activity,
  Calendar, Target, Layers, BarChart3, Sparkles, Check, History
} from 'lucide-react';

// ============================================================================
// EDGE v1.0 — LEAPS Intelligence Terminal
// ============================================================================

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

const SCAN_META = {
  daily:   { tvInterval: 'D', label: 'Daily'   },
  weekly:  { tvInterval: 'W', label: 'Weekly'  },
  monthly: { tvInterval: 'M', label: 'Monthly' },
};

const VIEWS = {
  zones:    { label: 'Zones',    icon: Activity   },
  movers:   { label: 'Movers',   icon: TrendingUp },
  sectors:  { label: 'Sectors',  icon: Layers     },
  backtest: { label: 'Backtest', icon: History    },
};

async function sbFetch(path) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY env vars');
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Range: '0-9999' },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.json();
}

async function fetchScan(timeframe) {
  const rows = await sbFetch(`latest_scans_with_meta?timeframe=eq.${timeframe}&select=*&limit=10000`);
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
    return { t: r.ticker, bx: Number(r.bx), prev: r.prev_bx != null ? Number(r.prev_bx) : null };
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

const MC_BUCKETS = [
  { label: 'All',   min: 0,   max: Infinity },
  { label: 'Mega',  min: 200, max: Infinity },
  { label: 'Large', min: 10,  max: 200 },
  { label: 'Mid',   min: 2,   max: 10 },
  { label: 'Small', min: 0,   max: 2 },
];
const EARN_BUCKETS = [
  { label: 'Any',  days: null }, { label: '>7d',  days: 7 },
  { label: '>14d', days: 14 },   { label: '>21d', days: 21 }, { label: '>30d', days: 30 },
];
const PCT52_BUCKETS = [
  { label: 'Any',       min: 0,  max: 100 },
  { label: 'Near Highs',min: 70, max: 100 },
  { label: 'Mid-Range', min: 30, max: 70 },
  { label: 'Near Lows', min: 0,  max: 30 },
];
const BIAS_BUCKETS = [
  { label: 'Any',  v: null }, { label: 'Bull', v: 'bullish' }, { label: 'Bear', v: 'bearish' },
];

function TVChart({ ticker, interval }) {
  const src =
    `https://s.tradingview.com/widgetembed/?frameElementId=tv_${ticker}` +
    `&symbol=${encodeURIComponent(ticker)}&interval=${interval}` +
    `&hidesidetoolbar=0&symboledit=1&saveimage=0` +
    `&toolbarbg=0f1015&theme=dark&style=1&timezone=Etc%2FUTC` +
    `&withdateranges=1&hideideas=1&hideideasbutton=1&locale=en`;
  return (
    <iframe key={`${ticker}-${interval}`} src={src} title={`${ticker} ${interval}`}
      className="w-full h-full border-0" allow="fullscreen"/>
  );
}

function loadLocal(key, fb) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fb; } catch { return fb; } }
function saveLocal(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
function earnLevel(d) { if (d == null || d < 0) return null; if (d < 7) return 'imminent'; if (d <= 14) return 'soon'; return null; }

function EarnBadge({ daysToEarn }) {
  const level = earnLevel(daysToEarn);
  if (!level) return null;
  const imm = level === 'imminent';
  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] font-semibold tabular-nums ${imm ? 'text-[#ff3366]' : 'text-[#ffa940]'}`}>
      {imm ? '⚠' : '🔔'}{daysToEarn}d
    </span>
  );
}

function AlignDots({ score }) {
  if (score == null) return null;
  const abs = Math.abs(score);
  const color = score > 0 ? 'bg-[#00d484] shadow-[0_0_6px_rgba(0,212,132,0.5)]' : score < 0 ? 'bg-[#ff3366] shadow-[0_0_6px_rgba(255,51,102,0.5)]' : 'bg-[#52525b]';
  return (
    <div className="flex items-center gap-[3px]">
      {[0,1,2].map(i => <div key={i} className={`w-[5px] h-[5px] rounded-full ${i < abs ? color : 'bg-[#1a1c22]'}`} />)}
    </div>
  );
}

function BiasBadge({ direction, inZone }) {
  if (!direction) return null;
  const bull = direction === 'bullish';
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold ${bull ? 'text-[#00d484]' : 'text-[#ff3366]'}`}>
      {bull ? '▲' : '▼'}
      {inZone && <span className="px-1 py-px bg-[rgba(180,242,0,0.12)] text-[#b4f200] rounded text-[9px] font-bold tracking-wider">Z</span>}
    </span>
  );
}

function CollapsibleSection({ title, icon: Icon, summary, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="flex-shrink-0 border-b border-[rgba(255,255,255,0.06)]">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-5 h-11 hover:bg-[#0f1015] active:bg-[#15171c] transition-colors group">
        <div className="flex items-center gap-2.5 min-w-0">
          {Icon && <Icon className="w-[14px] h-[14px] text-[#52525b] group-hover:text-[#a1a1aa] flex-shrink-0" strokeWidth={2} />}
          <span className="text-[12px] font-medium text-[#a1a1aa] group-hover:text-[#fafafa]">{title}</span>
        </div>
        <div className="flex items-center gap-3">
          {summary && <span className="text-[12px] tabular-nums">{summary}</span>}
          <ChevronDown className={`w-[14px] h-[14px] text-[#52525b] transition-transform duration-200 ${open ? 'rotate-180' : ''}`} strokeWidth={2} />
        </div>
      </button>
      {open && <div className="border-t border-[rgba(255,255,255,0.04)] bg-[#0a0b0e]/40">{children}</div>}
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
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [mobileMoverTab, setMobileMoverTab] = useState(() => loadLocal('bx_mobile_mover_tab', 'bullish'));
  useEffect(() => { saveLocal('bx_mobile_mover_tab', mobileMoverTab); }, [mobileMoverTab]);
  const [zoneSort, setZoneSort] = useState(() => loadLocal('bx_zone_sort', { bearish: 'asc', neutral: 'asc', bullish: 'desc' }));
  useEffect(() => { saveLocal('bx_zone_sort', zoneSort); }, [zoneSort]);
  const toggleZoneSort = (zone) => setZoneSort(s => ({ ...s, [zone]: s[zone] === 'asc' ? 'desc' : 'asc' }));

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    Promise.all([fetchScan(timeframe), fetchMovers(timeframe), fetchSectors(timeframe), fetchBacktestSummary(timeframe)])
      .then(([s, m, sec, bt]) => {
        if (cancelled) return;
        setScan(s); setMovers(m); setSectors(sec); setBacktestSummary(bt);
        if (s.data.length && !selected) setSelected(s.data[0].t);
      })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [timeframe]);

  useEffect(() => { saveLocal('bx_watchlist', watchlist); }, [watchlist]);
  useEffect(() => { saveLocal('bx_notes', notes); }, [notes]);

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
      if (r.px > 0 && (r.px < pMin || r.px > pMax)) return false;
      if (r.vol < vMin) return false;
      if (earnMinDays != null && r.daysToEarn != null && r.daysToEarn >= 0 && r.daysToEarn < earnMinDays) return false;
      if (pct52Filter !== 0 && r.pct52 != null && (r.pct52 < pct52.min || r.pct52 > pct52.max)) return false;
      if (sectorFilter && r.sec !== sectorFilter) return false;
      if (biasReq && r.biasDir !== biasReq) return false;
      if (inZoneOnly && !r.inZone) return false;
      return true;
    });
  }, [decorated, mcBucket, priceMin, priceMax, volMin, watchOnly, watchlist, query, earnFilter, pct52Filter, sectorFilter, biasFilter, inZoneOnly]);

  const sortByBx = (arr, dir) => arr.slice().sort((a, b) => dir === 'asc' ? a.bx - b.bx : b.bx - a.bx);
  const bearish = useMemo(() => sortByBx(filtered.filter(r => r.zone === 'bearish'), zoneSort.bearish), [filtered, zoneSort.bearish]);
  const neutral = useMemo(() => sortByBx(filtered.filter(r => r.zone === 'neutral'), zoneSort.neutral), [filtered, zoneSort.neutral]);
  const bullish = useMemo(() => sortByBx(filtered.filter(r => r.zone === 'bullish'), zoneSort.bullish), [filtered, zoneSort.bullish]);
  const transitions = useMemo(() => filtered.filter(r => r.transition), [filtered]);

  useEffect(() => {
    const handler = (e) => {
      if (mobileFiltersOpen || showAlerts || mobileDetailOpen) return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
      const isVert = e.key === 'ArrowUp' || e.key === 'ArrowDown';
      const isHoriz = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
      if (!isVert && !isHoriz) return;
      if (view !== 'zones' && view !== 'movers') return;
      e.preventDefault(); e.stopPropagation();
      if (view === 'zones') {
        const lists = { bearish, neutral, bullish };
        const order = ['bearish', 'neutral', 'bullish'];
        const selRow = scan.data.find(r => r.t === selected);
        let curZone = selRow ? zoneOf(selRow.bx) : 'neutral';
        let list = lists[curZone];
        if (!list || list.length === 0) {
          for (const z of order) { if (lists[z].length) { curZone = z; list = lists[z]; break; } }
          if (!list || list.length === 0) return;
        }
        const idx = list.findIndex(r => r.t === selected);
        if (isVert) {
          const len = list.length;
          if (idx === -1) { setSelected(list[0].t); return; }
          const next = e.key === 'ArrowDown' ? (idx + 1) % len : (idx - 1 + len) % len;
          setSelected(list[next].t);
        } else {
          const curIdx = order.indexOf(curZone);
          const dir = e.key === 'ArrowRight' ? 1 : -1;
          for (let step = 1; step <= 3; step++) {
            const ni = curIdx + dir * step;
            if (ni < 0 || ni > 2) break;
            const targetList = lists[order[ni]];
            if (targetList.length === 0) continue;
            const targetIdx = Math.min(Math.max(idx, 0), targetList.length - 1);
            setSelected(targetList[targetIdx].t);
            return;
          }
        }
      } else if (view === 'movers') {
        const bullishMoves = movers.filter(m => Number(m.delta_bx) > 0).slice(0, 25);
        const bearishMoves = movers.filter(m => Number(m.delta_bx) < 0).slice(0, 25);
        const inBull = bullishMoves.findIndex(r => r.ticker === selected);
        const inBear = bearishMoves.findIndex(r => r.ticker === selected);
        let curList, curIdx;
        if (inBull >= 0) { curList = bullishMoves; curIdx = inBull; }
        else if (inBear >= 0) { curList = bearishMoves; curIdx = inBear; }
        else { curList = bullishMoves.length ? bullishMoves : bearishMoves; curIdx = -1; }
        if (!curList || curList.length === 0) return;
        if (isVert) {
          const len = curList.length;
          if (curIdx === -1) { setSelected(curList[0].ticker); return; }
          const next = e.key === 'ArrowDown' ? (curIdx + 1) % len : (curIdx - 1 + len) % len;
          setSelected(curList[next].ticker);
        } else {
          const targetList = curList === bullishMoves ? bearishMoves : bullishMoves;
          if (!targetList.length) return;
          const targetIdx = Math.min(Math.max(curIdx, 0), targetList.length - 1);
          setSelected(targetList[targetIdx].ticker);
        }
      }
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [view, selected, scan.data, bullish, bearish, neutral, movers, mobileFiltersOpen, showAlerts, mobileDetailOpen]);

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
  const refresh = () => {
    setLoading(true);
    Promise.all([fetchScan(timeframe), fetchMovers(timeframe), fetchSectors(timeframe), fetchBacktestSummary(timeframe)])
      .then(([s, m, sec, bt]) => { setScan(s); setMovers(m); setSectors(sec); setBacktestSummary(bt); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  };

  const selectedMeta = scan.meta[selected] || {};
  const selectedRow = decorated.find(r => r.t === selected);
  const mobileRows = mobileZone === 'bearish' ? bearish : mobileZone === 'neutral' ? neutral : bullish;
  const hasActiveFilters = query || priceMin || priceMax || volMin || mcBucket !== 0 || watchOnly ||
    earnFilter !== 0 || pct52Filter !== 0 || sectorFilter || biasFilter !== 0 || inZoneOnly;

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
    return (
      <div className="w-full h-screen bg-[#08090b] flex items-center justify-center">
        <GlobalStyles />
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 rounded-md bg-[#b4f200] shadow-[0_0_24px_rgba(180,242,0,0.4)] animate-pulse"></div>
          <span className="text-[12px] text-[#71717a] tracking-wider font-medium">loading edge…</span>
        </div>
      </div>
    );
  }
  if (error && scan.data.length === 0) {
    return (
      <div className="w-full h-screen bg-[#08090b] text-[#ff3366] flex flex-col items-center justify-center gap-3 px-6 text-center">
        <GlobalStyles />
        <AlertCircle className="w-6 h-6" />
        <span className="text-[12px] tracking-wider">data unavailable</span>
        <span className="text-[11px] text-[#71717a] max-w-md">{error}</span>
        <button onClick={refresh} className="mt-2 px-4 py-2 border border-[rgba(255,255,255,0.08)] hover:border-[#b4f200]/40 text-[#fafafa] text-[11px] rounded-md transition-colors">Retry</button>
      </div>
    );
  }

  return (
    <div className="w-full h-screen bg-[#08090b] text-[#fafafa] overflow-hidden flex flex-col font-edge relative">
      <GlobalStyles />

      {/* Ambient background */}
      <div className="absolute inset-0 pointer-events-none z-0">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_0%_0%,rgba(180,242,0,0.04)_0%,transparent_40%),radial-gradient(circle_at_100%_0%,rgba(0,212,132,0.02)_0%,transparent_30%)]"></div>
        <div className="absolute inset-0 bg-dot-grid opacity-40"></div>
      </div>

      <div className="relative z-10 flex flex-col h-full">

        {/* HEADER */}
        <header className="flex-shrink-0 backdrop-blur-xl bg-[rgba(8,9,11,0.7)] border-b border-[rgba(255,255,255,0.06)]">
          <div className="flex items-center justify-between px-4 lg:px-5 h-14">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-3">
                <div className="brand-logo"></div>
                <div className="flex flex-col leading-tight">
                  <span className="text-[16px] font-semibold tracking-tight">edge</span>
                  <span className="hidden lg:block text-[10px] text-[#52525b] tracking-wider font-mono uppercase">leaps · intelligence</span>
                </div>
              </div>
              <div className="hidden md:flex items-center gap-2 px-3 py-1.5 bg-[#0f1015] border border-[rgba(255,255,255,0.06)] rounded-full text-[11px]">
                <span className="w-1.5 h-1.5 bg-[#b4f200] rounded-full shadow-[0_0_8px_rgba(180,242,0,0.6)] animate-pulse-slow"></span>
                <span className="text-[#a1a1aa] font-mono">LIVE</span>
                <span className="text-[#52525b]">·</span>
                <span className="text-[#71717a] font-mono">{scan.date || '—'}</span>
                <span className="text-[#52525b]">·</span>
                <span className="text-[#71717a] font-mono">{scan.data.length} tickers</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="hidden md:flex items-center gap-3 mr-2 text-[11px]">
                <span className="flex items-center gap-1.5"><span className="text-[#52525b]">Bear</span><span className="text-[#ff3366] font-semibold tabular-nums">{bearish.length}</span></span>
                <span className="flex items-center gap-1.5"><span className="text-[#52525b]">Neu</span><span className="text-[#a1a1aa] font-semibold tabular-nums">{neutral.length}</span></span>
                <span className="flex items-center gap-1.5"><span className="text-[#52525b]">Bull</span><span className="text-[#00d484] font-semibold tabular-nums">{bullish.length}</span></span>
              </div>
              <button onClick={refresh} disabled={loading} className="btn-icon-edge" title="Refresh">
                <RefreshCw className={`w-[14px] h-[14px] ${loading ? 'animate-spin' : ''}`} strokeWidth={2} />
              </button>
              <button onClick={() => setShowAlerts(true)} className="btn-edge" title="Alerts">
                <AlertCircle className="w-[14px] h-[14px]" strokeWidth={2} />
                <span className="hidden md:inline ml-1.5">Alerts</span>
                <span className="ml-1 text-[#b4f200] font-mono font-semibold">{transitions.length}</span>
              </button>
            </div>
          </div>

          {/* Timeframe tabs */}
          <div className="flex items-center px-4 lg:px-5 gap-1 border-t border-[rgba(255,255,255,0.06)] h-11">
            {Object.keys(SCAN_META).map(tf => {
              const active = tf === timeframe;
              return (
                <button key={tf} onClick={() => setTimeframe(tf)}
                  className={`tab-edge ${active ? 'tab-edge-active' : ''}`}>{SCAN_META[tf].label}</button>
              );
            })}
            <div className="flex-1"></div>
            <span className="hidden md:flex items-center gap-1.5 text-[10px] text-[#52525b] font-mono tracking-wider">
              <span>CHART</span><span className="text-[#a1a1aa]">{tvInterval}</span>
            </span>
          </div>

          {/* View tabs */}
          <div className="flex items-center px-4 lg:px-5 gap-0.5 border-t border-[rgba(255,255,255,0.06)] h-10 overflow-x-auto">
            {Object.entries(VIEWS).map(([k, v]) => {
              const active = k === view;
              const Icon = v.icon;
              return (
                <button key={k} onClick={() => setView(k)}
                  className={`tab-pill-edge ${active ? 'tab-pill-edge-active' : ''}`}>
                  <Icon className="w-[12px] h-[12px]" strokeWidth={2.5} />
                  {v.label}
                </button>
              );
            })}
          </div>

          {view === 'zones' && (
            <div className="lg:hidden flex items-stretch border-t border-[rgba(255,255,255,0.06)] h-9 text-[11px]">
              <div className="flex-1 flex items-center justify-center gap-1.5"><span className="text-[#52525b]">Bear</span><span className="text-[#ff3366] font-semibold tabular-nums">{bearish.length}</span></div>
              <div className="flex-1 flex items-center justify-center gap-1.5 border-l border-r border-[rgba(255,255,255,0.06)]"><span className="text-[#52525b]">Neu</span><span className="text-[#a1a1aa] font-semibold tabular-nums">{neutral.length}</span></div>
              <div className="flex-1 flex items-center justify-center gap-1.5"><span className="text-[#52525b]">Bull</span><span className="text-[#00d484] font-semibold tabular-nums">{bullish.length}</span></div>
            </div>
          )}

          {/* Filters (desktop) */}
          {view !== 'sectors' && view !== 'backtest' && (
            <div className="hidden md:flex items-center gap-3 px-4 lg:px-5 h-12 border-t border-[rgba(255,255,255,0.06)] overflow-x-auto">
              <div className="flex items-center gap-2 flex-shrink-0">
                <Search className="w-[13px] h-[13px] text-[#52525b]" strokeWidth={2} />
                <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search ticker…" className="search-edge w-36" />
              </div>
              <div className="filter-group-edge">
                <span className="filter-label-edge">Cap</span>
                {MC_BUCKETS.map((b, i) => <button key={b.label} onClick={() => setMcBucket(i)} className={`chip-edge ${mcBucket === i ? 'chip-edge-active' : ''}`}>{b.label}</button>)}
              </div>
              <div className="filter-group-edge">
                <span className="filter-label-edge">Bias</span>
                {BIAS_BUCKETS.map((b, i) => <button key={b.label} onClick={() => setBiasFilter(i)} className={`chip-edge ${biasFilter === i ? 'chip-edge-active' : ''}`}>{b.label}</button>)}
                <button onClick={() => setInZoneOnly(z => !z)} className={`chip-edge ${inZoneOnly ? 'chip-edge-active' : ''}`}>In-Zone</button>
              </div>
              <div className="filter-group-edge">
                <span className="filter-label-edge">Earn</span>
                {EARN_BUCKETS.map((b, i) => <button key={b.label} onClick={() => setEarnFilter(i)} className={`chip-edge ${earnFilter === i ? 'chip-edge-active' : ''}`}>{b.label}</button>)}
              </div>
              <div className="filter-group-edge">
                <span className="filter-label-edge">52W</span>
                {PCT52_BUCKETS.map((b, i) => <button key={b.label} onClick={() => setPct52Filter(i)} className={`chip-edge ${pct52Filter === i ? 'chip-edge-active' : ''}`}>{b.label}</button>)}
              </div>
              <button onClick={() => setWatchOnly(w => !w)} className={`chip-edge inline-flex items-center gap-1.5 ${watchOnly ? 'chip-edge-active' : ''}`}>
                <Star className={`w-[11px] h-[11px] ${watchOnly ? 'fill-current' : ''}`} strokeWidth={2} />
                Watchlist <span className="text-[#52525b]">({Object.keys(watchlist).length})</span>
              </button>
              {hasActiveFilters && <button onClick={clearFilters} className="text-[11px] text-[#52525b] hover:text-[#ff3366] flex-shrink-0">Clear</button>}
            </div>
          )}

          {/* Filters (mobile) */}
          {view !== 'sectors' && view !== 'backtest' && (
            <div className="md:hidden flex items-center gap-2 px-3 h-11 border-t border-[rgba(255,255,255,0.06)]">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <Search className="w-[13px] h-[13px] text-[#52525b] flex-shrink-0" strokeWidth={2} />
                <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search…" className="search-edge w-full" />
              </div>
              <button onClick={() => setWatchOnly(w => !w)} className={`btn-edge !px-2 ${watchOnly ? '!text-[#b4f200] !border-[#b4f200]/40' : ''}`}>
                <Star className={`w-[13px] h-[13px] ${watchOnly ? 'fill-current' : ''}`} strokeWidth={2} />
              </button>
              <button onClick={() => setMobileFiltersOpen(true)} className={`btn-edge !px-2 ${hasActiveFilters ? '!text-[#b4f200] !border-[#b4f200]/40' : ''}`}>
                <SlidersHorizontal className="w-[13px] h-[13px]" strokeWidth={2} />
                <span className="ml-1">Filters</span>
                {hasActiveFilters && <span className="ml-1 w-1.5 h-1.5 bg-[#b4f200] rounded-full"></span>}
              </button>
            </div>
          )}
        </header>

        {/* Active sector chip */}
        {sectorFilter && (
          <div className="flex-shrink-0 flex items-center gap-2 px-4 lg:px-5 h-9 bg-[rgba(180,242,0,0.06)] border-b border-[rgba(180,242,0,0.2)]">
            <Layers className="w-[12px] h-[12px] text-[#b4f200] flex-shrink-0" strokeWidth={2} />
            <span className="text-[10px] text-[#b4f200] font-semibold tracking-wider uppercase">Sector</span>
            <span className="text-[12px] text-[#fafafa] truncate">{sectorFilter}</span>
            <button onClick={() => setSectorFilter(null)} className="ml-auto flex items-center gap-1 px-2 py-1 border border-[rgba(180,242,0,0.3)] text-[10px] text-[#b4f200] rounded hover:bg-[rgba(180,242,0,0.1)]">
              <X className="w-[10px] h-[10px]" strokeWidth={2.5} />Clear
            </button>
          </div>
        )}

        {/* MAIN */}
        {view === 'zones' && (
          <>
            <div className="hidden lg:flex flex-1 overflow-hidden">
              <div className="flex-1 grid grid-cols-3 overflow-hidden">
                <ZoneColumn label="Bearish" range="−10 · −2" accent="bear" rows={bearish}
                  sortDir={zoneSort.bearish} onToggleSort={() => toggleZoneSort('bearish')}
                  selected={selected} onSelect={handleSelect} watchlist={watchlist} onToggleWatch={toggleWatch} notes={notes}/>
                <ZoneColumn label="Neutral" range="−2 · +2" accent="neu" rows={neutral}
                  sortDir={zoneSort.neutral} onToggleSort={() => toggleZoneSort('neutral')}
                  selected={selected} onSelect={handleSelect} watchlist={watchlist} onToggleWatch={toggleWatch} notes={notes}/>
                <ZoneColumn label="Bullish" range="+2 · +10" accent="bull" rows={bullish}
                  sortDir={zoneSort.bullish} onToggleSort={() => toggleZoneSort('bullish')}
                  selected={selected} onSelect={handleSelect} watchlist={watchlist} onToggleWatch={toggleWatch} notes={notes}/>
              </div>
              <aside className="w-[500px] flex-shrink-0 border-l border-[rgba(255,255,255,0.06)] flex flex-col bg-[#08090b]">
                {selected && <DetailPanel ticker={selected} row={selectedRow} meta={selectedMeta} interval={tvInterval} timeframe={timeframe}
                  notes={notes} setNotes={setNotes} watchlist={watchlist} onToggleWatch={toggleWatch}/>}
              </aside>
            </div>

            <div className="lg:hidden flex-1 flex flex-col overflow-hidden" onTouchStart={onMobileTouchStart} onTouchEnd={onMobileTouchEnd}>
              <div className="flex items-stretch border-b border-[rgba(255,255,255,0.06)] flex-shrink-0">
                <MobileZoneTab label="Bearish" count={bearish.length} active={mobileZone === 'bearish'} accent="bear" onClick={() => setMobileZone('bearish')}/>
                <MobileZoneTab label="Neutral" count={neutral.length} active={mobileZone === 'neutral'} accent="neu" onClick={() => setMobileZone('neutral')}/>
                <MobileZoneTab label="Bullish" count={bullish.length} active={mobileZone === 'bullish'} accent="bull" onClick={() => setMobileZone('bullish')}/>
              </div>
              <div className="px-3 h-7 flex items-center justify-between flex-shrink-0 text-[10px] text-[#52525b]">
                <span>← swipe to switch →</span>
                <button onClick={() => toggleZoneSort(mobileZone)} className="flex items-center gap-1 px-2 py-0.5 border border-[rgba(255,255,255,0.06)] rounded-md text-[#a1a1aa]">
                  {zoneSort[mobileZone] === 'asc' ? <ChevronUp className="w-[11px] h-[11px]"/> : <ChevronDown className="w-[11px] h-[11px]"/>}
                  <span className="font-mono">{zoneSort[mobileZone] === 'asc' ? '−→+' : '+→−'}</span>
                </button>
              </div>
              <div className="flex-1 overflow-hidden flex flex-col">
                <div className="row-header-edge">
                  <span className="w-16">Ticker</span><span className="w-14 text-right">BX</span>
                  <span className="flex-1 text-right">Px · 52w · Bias</span><span className="w-14 text-right">Sig</span>
                </div>
                <div className="flex-1 overflow-y-auto scrollbar-edge fade-in" key={mobileZone}>
                  {mobileRows.length === 0 ? <EmptyState message="No matches" /> : mobileRows.map(r => (
                    <RowItem key={r.t} r={r} zone={mobileZone} selected={false}
                      onSelect={() => handleSelect(r.t)} watched={!!watchlist[r.t]}
                      onToggleWatch={() => toggleWatch(r.t)} hasNote={!!notes[r.t]} mobile/>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}

        {view === 'movers' && <MoversView movers={sectorFilter ? movers.filter(m => m.sector === sectorFilter) : movers}
          meta={scan.meta} selected={selected} onSelect={handleSelect}
          watchlist={watchlist} onToggleWatch={toggleWatch} notes={notes}
          tvInterval={tvInterval} setNotes={setNotes} selectedMeta={selectedMeta} selectedRow={selectedRow} timeframe={timeframe}
          mobileMoverTab={mobileMoverTab} setMobileMoverTab={setMobileMoverTab}/>}

        {view === 'sectors' && <SectorsView sectors={sectors} timeframe={timeframe} activeSector={sectorFilter} onSelectSector={selectSector}/>}

        {view === 'backtest' && <BacktestView summary={backtestSummary} timeframe={timeframe} scan={scan}/>}
      </div>

      {/* Mobile detail drawer */}
      {mobileDetailOpen && selected && (
        <div className="lg:hidden fixed inset-0 z-40 bg-[#08090b] flex flex-col slide-up">
          <div className="flex items-center gap-2 px-3 h-11 border-b border-[rgba(255,255,255,0.06)] flex-shrink-0 backdrop-blur-xl bg-[rgba(8,9,11,0.8)]">
            <button onClick={() => setMobileDetailOpen(false)} className="flex items-center gap-1 text-[#a1a1aa] -ml-1 px-2 py-2 rounded hover:bg-[#0f1015]">
              <ChevronLeft className="w-[16px] h-[16px]" strokeWidth={2} />
              <span className="text-[12px]">Back</span>
            </button>
            <div className="flex items-center gap-2 ml-auto">
              <span className="w-1.5 h-1.5 bg-[#b4f200] rounded-full shadow-[0_0_6px_rgba(180,242,0,0.6)] animate-pulse-slow"></span>
              <span className="text-[10px] tracking-wider text-[#b4f200] font-mono">{tvInterval}</span>
            </div>
          </div>
          <div className="flex-1 overflow-hidden">
            <DetailPanel ticker={selected} row={selectedRow} meta={selectedMeta} interval={tvInterval} timeframe={timeframe}
              notes={notes} setNotes={setNotes} watchlist={watchlist} onToggleWatch={toggleWatch}/>
          </div>
        </div>
      )}

      {mobileFiltersOpen && <MobileFiltersDrawer
          mcBucket={mcBucket} setMcBucket={setMcBucket}
          priceMin={priceMin} setPriceMin={setPriceMin}
          priceMax={priceMax} setPriceMax={setPriceMax}
          volMin={volMin} setVolMin={setVolMin}
          earnFilter={earnFilter} setEarnFilter={setEarnFilter}
          pct52Filter={pct52Filter} setPct52Filter={setPct52Filter}
          biasFilter={biasFilter} setBiasFilter={setBiasFilter}
          inZoneOnly={inZoneOnly} setInZoneOnly={setInZoneOnly}
          hasActiveFilters={hasActiveFilters} onClear={clearFilters}
          onClose={() => setMobileFiltersOpen(false)}/>}
      {showAlerts && <AlertsDrawer transitions={transitions}
          onClose={() => setShowAlerts(false)}
          onSelect={(t) => { handleSelect(t); setShowAlerts(false); }}/>}
    </div>
  );
}

// ============================================================================
// GLOBAL STYLES — design tokens + custom utility classes
// ============================================================================
function GlobalStyles() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;600&family=Geist:wght@400;500;600;700&display=swap');
      .font-edge { font-family: 'Geist', -apple-system, BlinkMacSystemFont, sans-serif; -webkit-font-smoothing: antialiased; }
      .font-edge .tabular-nums, .font-edge .font-mono { font-family: 'Geist Mono', 'SF Mono', Monaco, monospace; font-variant-numeric: tabular-nums; }

      .bg-dot-grid {
        background-image: radial-gradient(circle, rgba(255,255,255,0.018) 1px, transparent 1px);
        background-size: 24px 24px;
      }

      .brand-logo {
        width: 28px; height: 28px;
        background: #b4f200;
        border-radius: 6px;
        box-shadow: 0 0 24px rgba(180, 242, 0, 0.25);
        position: relative;
        flex-shrink: 0;
      }
      .brand-logo::after {
        content: '';
        position: absolute; inset: 7px;
        background: #08090b;
        clip-path: polygon(0 100%, 30% 100%, 50% 40%, 70% 60%, 100% 0, 100% 100%, 0 100%);
      }

      @keyframes pulse-slow { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(0.85); } }
      .animate-pulse-slow { animation: pulse-slow 2s ease-in-out infinite; }

      @keyframes slide-up { from { transform: translateY(100%); } to { transform: translateY(0); } }
      .slide-up { animation: slide-up 0.22s cubic-bezier(0.16, 1, 0.3, 1); }
      @keyframes slide-right { from { transform: translateX(100%); } to { transform: translateX(0); } }
      .slide-right { animation: slide-right 0.22s cubic-bezier(0.16, 1, 0.3, 1); }
      @keyframes fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
      .fade-in { animation: fade-in 0.16s ease-out; }

      .btn-edge {
        display: inline-flex; align-items: center; gap: 0; padding: 7px 12px;
        background: #0f1015; border: 1px solid rgba(255,255,255,0.06); border-radius: 6px;
        color: #a1a1aa; font-size: 12px; font-weight: 500; cursor: pointer;
        transition: all 0.15s ease; font-family: inherit;
      }
      .btn-edge:hover { border-color: rgba(255,255,255,0.12); color: #fafafa; background: #15171c; }
      .btn-edge:disabled { opacity: 0.5; cursor: not-allowed; }
      .btn-icon-edge {
        display: inline-flex; align-items: center; justify-content: center;
        width: 32px; height: 32px;
        background: #0f1015; border: 1px solid rgba(255,255,255,0.06); border-radius: 6px;
        color: #a1a1aa; cursor: pointer; transition: all 0.15s ease;
      }
      .btn-icon-edge:hover { border-color: rgba(255,255,255,0.12); color: #b4f200; }
      .btn-icon-edge:disabled { opacity: 0.5; cursor: not-allowed; }

      .tab-edge {
        padding: 7px 14px; border: none; background: transparent;
        color: #71717a; font-size: 12px; font-weight: 500; cursor: pointer;
        border-radius: 6px; transition: all 0.15s ease; font-family: inherit;
        position: relative;
      }
      .tab-edge:hover { color: #a1a1aa; background: #0f1015; }
      .tab-edge-active { color: #fafafa; background: #0f1015; }
      .tab-edge-active::after {
        content: ''; position: absolute; bottom: -1px; left: 12px; right: 12px;
        height: 2px; background: #b4f200; border-radius: 2px 2px 0 0;
        box-shadow: 0 0 12px rgba(180,242,0,0.5);
      }

      .tab-pill-edge {
        padding: 6px 12px; border: none; background: transparent;
        color: #71717a; font-size: 11px; font-weight: 500; cursor: pointer;
        border-radius: 6px; transition: all 0.15s ease; font-family: inherit;
        display: inline-flex; align-items: center; gap: 6px;
      }
      .tab-pill-edge:hover { color: #a1a1aa; background: #0f1015; }
      .tab-pill-edge-active { color: #b4f200; background: rgba(180,242,0,0.08); }

      .chip-edge {
        padding: 4px 10px; border-radius: 999px; font-size: 11px; font-weight: 500;
        background: #0f1015; border: 1px solid rgba(255,255,255,0.06);
        color: #a1a1aa; cursor: pointer; transition: all 0.15s ease;
        font-family: inherit; line-height: 1.4;
      }
      .chip-edge:hover { border-color: rgba(255,255,255,0.12); color: #fafafa; }
      .chip-edge-active { color: #b4f200; border-color: #b4f200; background: rgba(180,242,0,0.08); }

      .filter-group-edge { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
      .filter-label-edge { font-size: 10px; color: #52525b; font-weight: 600; margin-right: 4px; text-transform: uppercase; letter-spacing: 0.04em; }

      .search-edge {
        background: #0f1015; border: 1px solid rgba(255,255,255,0.06); border-radius: 6px;
        padding: 6px 10px; color: #fafafa; font-size: 12px;
        font-family: inherit; outline: none; transition: all 0.15s ease;
      }
      .search-edge::placeholder { color: #52525b; }
      .search-edge:focus { border-color: #b4f200; box-shadow: 0 0 0 3px rgba(180,242,0,0.1); }

      .row-header-edge {
        display: flex; align-items: center; padding: 8px 16px; flex-shrink: 0;
        font-size: 10px; color: #52525b; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600;
        border-bottom: 1px solid rgba(255,255,255,0.06); background: rgba(8,9,11,0.6); backdrop-filter: blur(8px);
      }

      .scrollbar-edge::-webkit-scrollbar { width: 6px; }
      .scrollbar-edge::-webkit-scrollbar-track { background: transparent; }
      .scrollbar-edge::-webkit-scrollbar-thumb { background: #15171c; border-radius: 3px; }
      .scrollbar-edge::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.12); }

      .row-selected {
        background: #15171c !important;
        box-shadow: inset 3px 0 0 #b4f200, 0 0 32px rgba(180,242,0,0.06);
      }
      .row-selected::before {
        content: ''; position: absolute; left: 0; top: 0; bottom: 0;
        width: 3px; background: #b4f200; box-shadow: 0 0 12px rgba(180,242,0,0.5);
      }

      input::placeholder { color: #52525b; }
      .no-tap-highlight { -webkit-tap-highlight-color: transparent; }
    `}</style>
  );
}

function EmptyState({ message }) {
  return <div className="px-3 py-12 text-center text-[11px] text-[#52525b]">— {message} —</div>;
}

// ============================================================================
// COMPONENTS
// ============================================================================

function MobileZoneTab({ label, count, active, accent, onClick }) {
  const accentColors = {
    bear: { text: 'text-[#ff3366]', under: 'bg-[#ff3366]', dot: 'bg-[#ff3366] shadow-[0_0_6px_rgba(255,51,102,0.5)]' },
    neu:  { text: 'text-[#a1a1aa]', under: 'bg-[#a1a1aa]', dot: 'bg-[#a1a1aa]' },
    bull: { text: 'text-[#00d484]', under: 'bg-[#00d484]', dot: 'bg-[#00d484] shadow-[0_0_6px_rgba(0,212,132,0.5)]' },
  };
  const c = accentColors[accent];
  return (
    <button onClick={onClick} className={`flex-1 flex flex-col items-center justify-center gap-1 h-13 py-2.5 border-r border-[rgba(255,255,255,0.06)] last:border-r-0 no-tap-highlight relative ${active ? 'bg-[#0f1015]' : 'active:bg-[#0f1015]/50'}`}>
      <div className="flex items-center gap-2">
        <div className={`w-1.5 h-1.5 rounded-full ${c.dot}`}></div>
        <span className={`text-[12px] font-semibold ${active ? c.text : 'text-[#71717a]'}`}>{label}</span>
      </div>
      <span className={`text-[13px] font-semibold tabular-nums ${active ? c.text : 'text-[#71717a]'}`}>{count}</span>
      {active && <div className={`absolute bottom-0 left-3 right-3 h-0.5 rounded-t ${c.under}`}></div>}
    </button>
  );
}

function ZoneColumn({ label, range, accent, rows, selected, onSelect, watchlist, onToggleWatch, notes, sortDir, onToggleSort }) {
  const accentColors = {
    bear: { dot: 'bg-[#ff3366] shadow-[0_0_8px_rgba(255,51,102,0.4)]', count: 'text-[#ff3366]' },
    neu:  { dot: 'bg-[#a1a1aa]', count: 'text-[#a1a1aa]' },
    bull: { dot: 'bg-[#00d484] shadow-[0_0_8px_rgba(0,212,132,0.4)]', count: 'text-[#00d484]' },
  };
  const c = accentColors[accent];
  const SortArrow = sortDir === 'asc' ? ChevronUp : ChevronDown;
  return (
    <div className="flex flex-col overflow-hidden border-r border-[rgba(255,255,255,0.06)] last:border-r-0">
      <div className="flex items-center justify-between px-4 h-12 border-b border-[rgba(255,255,255,0.06)] bg-[#0f1015]">
        <div className="flex items-center gap-2.5">
          <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`}></span>
          <span className="text-[13px] font-semibold tracking-tight">{label}</span>
          <span className="text-[10px] text-[#52525b] font-mono">{range}</span>
        </div>
        <button onClick={onToggleSort} title={`Sort ${sortDir === 'asc' ? 'asc' : 'desc'}`}
          className="flex items-center gap-1 px-2 py-1 bg-[#08090b] border border-[rgba(255,255,255,0.06)] rounded-md hover:border-[rgba(255,255,255,0.12)] transition-colors">
          <SortArrow className="w-[11px] h-[11px]" strokeWidth={2.5} />
          <span className={`text-[12px] font-semibold tabular-nums ${c.count}`}>{rows.length}</span>
        </button>
      </div>
      <div className="row-header-edge">
        <span className="w-16">Ticker</span><span className="w-14 text-right">BX</span>
        <span className="flex-1 text-right">52W · Bias</span><span className="w-14 text-right">Sig</span>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-edge">
        {rows.length === 0 ? <EmptyState message="no matches" /> : rows.map(r => (
          <RowItem key={r.t} r={r} zone={r.zone} selected={selected === r.t}
            onSelect={() => onSelect(r.t)} watched={!!watchlist[r.t]}
            onToggleWatch={() => onToggleWatch(r.t)} hasNote={!!notes[r.t]}/>
        ))}
      </div>
    </div>
  );
}

function RowItem({ r, zone, selected, onSelect, watched, onToggleWatch, hasNote, mobile }) {
  const bxColor = zone === 'bullish' ? 'text-[#00d484]' : zone === 'bearish' ? 'text-[#ff3366]' : 'text-[#a1a1aa]';
  const transition = r.transition;
  const tArrow = transition ? (transition.to === 'bullish' ? '↑' : transition.to === 'bearish' ? '↓' : '→') : null;
  const tColor = transition ? (transition.to === 'bullish' ? 'text-[#00d484] drop-shadow-[0_0_4px_rgba(0,212,132,0.6)]' : transition.to === 'bearish' ? 'text-[#ff3366] drop-shadow-[0_0_4px_rgba(255,51,102,0.6)]' : 'text-[#a1a1aa]') : '';

  return (
    <div onClick={onSelect} data-ticker={r.t}
      className={`group flex items-center px-4 ${mobile ? 'h-12' : 'h-10'} border-b border-[rgba(255,255,255,0.03)] cursor-pointer transition-colors no-tap-highlight relative ${
        selected ? 'row-selected' : 'hover:bg-[#0f1015] active:bg-[#15171c]'
      }`}>
      <div className="w-16 flex items-center gap-1.5">
        <button onClick={(e) => { e.stopPropagation(); onToggleWatch(); }}
          className={`${mobile || watched ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-opacity p-0.5 -ml-0.5 no-tap-highlight`}>
          <Star className={`${mobile ? 'w-[13px] h-[13px]' : 'w-[11px] h-[11px]'} ${watched ? 'fill-[#ffa940] text-[#ffa940]' : 'text-[#52525b]'}`} strokeWidth={2} />
        </button>
        <span className="text-[13px] font-semibold tracking-tight">{r.t}</span>
      </div>
      <div className="w-14 text-right">
        <span className={`text-[13px] font-semibold tabular-nums ${bxColor}`}>{r.bx >= 0 ? '+' : ''}{r.bx.toFixed(2)}</span>
      </div>
      <div className="flex-1 text-right text-[10px] flex items-center justify-end gap-2 tabular-nums">
        <AlignDots score={r.align} />
        {r.pct52 != null && (
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${r.pct52 > 80 ? 'text-[#00d484] bg-[rgba(0,212,132,0.08)]' : r.pct52 < 20 ? 'text-[#ff3366] bg-[rgba(255,51,102,0.08)]' : 'text-[#71717a] bg-[#0f1015]'}`}>{r.pct52.toFixed(0)}%</span>
        )}
        <BiasBadge direction={r.biasDir} inZone={r.inZone}/>
      </div>
      <div className="w-14 flex items-center justify-end gap-1.5">
        <EarnBadge daysToEarn={r.daysToEarn} />
        {hasNote && <StickyNote className="w-[11px] h-[11px] text-[#ffa940]/60" strokeWidth={2} />}
        {transition && <span className={`text-[14px] font-bold ${tColor}`}>{tArrow}</span>}
      </div>
    </div>
  );
}

function MoversView({ movers, meta, selected, onSelect, watchlist, onToggleWatch, notes, tvInterval, setNotes, selectedMeta, selectedRow, timeframe, mobileMoverTab, setMobileMoverTab }) {
  const bullishMoves = movers.filter(m => Number(m.delta_bx) > 0).slice(0, 25);
  const bearishMoves = movers.filter(m => Number(m.delta_bx) < 0).slice(0, 25);
  const touchRef = useRef({ x: 0, y: 0, active: false });
  const onStart = (e) => { const t = e.touches[0]; touchRef.current = { x: t.clientX, y: t.clientY, active: true }; };
  const onEnd = (e) => {
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
      <div className="hidden lg:flex flex-1 overflow-hidden">
        <div className="flex-1 grid grid-cols-2 overflow-hidden">
          <MoverColumn label="Bullish Moves" accent="bull" rows={bullishMoves} selected={selected} onSelect={onSelect} watchlist={watchlist} onToggleWatch={onToggleWatch} notes={notes}/>
          <MoverColumn label="Bearish Moves" accent="bear" rows={bearishMoves} selected={selected} onSelect={onSelect} watchlist={watchlist} onToggleWatch={onToggleWatch} notes={notes}/>
        </div>
        <aside className="w-[500px] flex-shrink-0 border-l border-[rgba(255,255,255,0.06)] flex flex-col bg-[#08090b]">
          {selected && <DetailPanel ticker={selected} row={selectedRow} meta={selectedMeta} interval={tvInterval} timeframe={timeframe}
            notes={notes} setNotes={setNotes} watchlist={watchlist} onToggleWatch={onToggleWatch}/>}
        </aside>
      </div>
      <div className="lg:hidden flex-1 flex flex-col overflow-hidden" onTouchStart={onStart} onTouchEnd={onEnd}>
        <div className="flex items-stretch border-b border-[rgba(255,255,255,0.06)] flex-shrink-0">
          <MobileZoneTab label="Bullish Moves" count={bullishMoves.length} active={mobileMoverTab === 'bullish'} accent="bull" onClick={() => setMobileMoverTab('bullish')}/>
          <MobileZoneTab label="Bearish Moves" count={bearishMoves.length} active={mobileMoverTab === 'bearish'} accent="bear" onClick={() => setMobileMoverTab('bearish')}/>
        </div>
        <div className="px-3 h-6 flex items-center justify-center text-[10px] text-[#52525b] flex-shrink-0">← swipe to switch →</div>
        <div className="flex-1 overflow-hidden flex flex-col">
          <div className="row-header-edge">
            <span className="w-16">Ticker</span><span className="flex-1 text-right">BX prev → now</span>
            <span className="w-14 text-right">Δ</span><span className="w-10 text-right">Zone</span>
          </div>
          <div className="flex-1 overflow-y-auto scrollbar-edge fade-in" key={mobileMoverTab}>
            {mobileRows.length === 0 ? <EmptyState message="no moves"/> : mobileRows.map(r => (
              <MoverRowMobile key={r.ticker} r={r} selected={selected === r.ticker}
                onSelect={() => onSelect(r.ticker)} watched={!!watchlist[r.ticker]}
                onToggleWatch={() => onToggleWatch(r.ticker)} hasNote={!!notes[r.ticker]}/>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function MoverColumn({ label, accent, rows, selected, onSelect, watchlist, onToggleWatch, notes }) {
  const accentColors = {
    bull: { text: 'text-[#00d484]', dot: 'bg-[#00d484] shadow-[0_0_8px_rgba(0,212,132,0.4)]' },
    bear: { text: 'text-[#ff3366]', dot: 'bg-[#ff3366] shadow-[0_0_8px_rgba(255,51,102,0.4)]' },
  };
  const c = accentColors[accent];
  return (
    <div className="flex flex-col overflow-hidden border-r border-[rgba(255,255,255,0.06)] last:border-r-0">
      <div className="flex items-center justify-between px-4 h-12 border-b border-[rgba(255,255,255,0.06)] bg-[#0f1015]">
        <div className="flex items-center gap-2.5">
          <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`}></span>
          <span className="text-[13px] font-semibold tracking-tight">{label}</span>
        </div>
        <span className={`text-[12px] font-semibold tabular-nums ${c.text}`}>{rows.length}</span>
      </div>
      <div className="row-header-edge">
        <span className="w-16">Ticker</span><span className="w-20 text-right">BX→</span>
        <span className="flex-1 text-right">Δ delta</span><span className="w-16 text-right">Zone</span>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-edge">
        {rows.length === 0 ? <EmptyState message="no moves"/> : rows.map(r => {
          const isSelected = selected === r.ticker;
          const tArrow = r.current_zone !== r.previous_zone ? `${r.previous_zone[0].toUpperCase()}→${r.current_zone[0].toUpperCase()}` : null;
          return (
            <div key={r.ticker} onClick={() => onSelect(r.ticker)} data-ticker={r.ticker}
              className={`group flex items-center px-4 h-10 border-b border-[rgba(255,255,255,0.03)] cursor-pointer transition-colors no-tap-highlight relative ${
                isSelected ? 'row-selected' : 'hover:bg-[#0f1015]'
              }`}>
              <div className="w-16 flex items-center gap-1.5">
                <button onClick={(e) => { e.stopPropagation(); onToggleWatch(r.ticker); }}
                  className={`${watchlist[r.ticker] ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-opacity p-0.5`}>
                  <Star className={`w-[11px] h-[11px] ${watchlist[r.ticker] ? 'fill-[#ffa940] text-[#ffa940]' : 'text-[#52525b]'}`} strokeWidth={2} />
                </button>
                <span className="text-[13px] font-semibold tracking-tight">{r.ticker}</span>
              </div>
              <span className={`w-20 text-right text-[11px] tabular-nums ${c.text}`}>
                {r.prev_bx >= 0 ? '+' : ''}{Number(r.prev_bx).toFixed(1)}→<span className="font-semibold">{r.bx >= 0 ? '+' : ''}{Number(r.bx).toFixed(1)}</span>
              </span>
              <span className={`flex-1 text-right text-[13px] font-semibold tabular-nums ${c.text}`}>{Number(r.delta_bx) >= 0 ? '+' : ''}{Number(r.delta_bx).toFixed(2)}</span>
              <span className="w-16 text-right text-[10px] font-medium">
                {tArrow ? <span className={c.text}>{tArrow}</span> : <span className="text-[#52525b] uppercase">{r.current_zone}</span>}
              </span>
              {notes[r.ticker] && <StickyNote className="w-[10px] h-[10px] text-[#ffa940]/60 ml-1" strokeWidth={2} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MoverRowMobile({ r, selected, onSelect, watched, onToggleWatch, hasNote }) {
  const zone = r.current_zone;
  const zoneColor = zone === 'bullish' ? 'text-[#00d484]' : zone === 'bearish' ? 'text-[#ff3366]' : 'text-[#a1a1aa]';
  const delta = Number(r.delta_bx);
  const deltaColor = delta > 0 ? 'text-[#00d484]' : 'text-[#ff3366]';
  const transitioned = r.current_zone !== r.previous_zone;
  const tArrow = transitioned ? `${r.previous_zone[0].toUpperCase()}→${r.current_zone[0].toUpperCase()}` : null;
  return (
    <div onClick={onSelect} data-ticker={r.ticker}
      className={`flex items-center px-4 h-12 border-b border-[rgba(255,255,255,0.03)] cursor-pointer transition-colors no-tap-highlight relative ${
        selected ? 'row-selected' : 'active:bg-[#0f1015]'
      }`}>
      <div className="w-16 flex items-center gap-1.5">
        <button onClick={(e) => { e.stopPropagation(); onToggleWatch(); }} className="p-0.5">
          <Star className={`w-[13px] h-[13px] ${watched ? 'fill-[#ffa940] text-[#ffa940]' : 'text-[#52525b]'}`} strokeWidth={2} />
        </button>
        <span className="text-[13px] font-semibold tracking-tight">{r.ticker}</span>
      </div>
      <div className="flex-1 text-right text-[11px] tabular-nums pr-2"><span className={zoneColor}>{Number(r.prev_bx) >= 0 ? '+' : ''}{Number(r.prev_bx).toFixed(1)}→<span className="font-semibold">{Number(r.bx) >= 0 ? '+' : ''}{Number(r.bx).toFixed(1)}</span></span></div>
      <div className="w-14 text-right"><span className={`text-[13px] font-semibold tabular-nums ${deltaColor}`}>{delta >= 0 ? '+' : ''}{delta.toFixed(2)}</span></div>
      <div className="w-10 flex items-center justify-end gap-1 pl-1">
        {hasNote && <StickyNote className="w-[10px] h-[10px] text-[#ffa940]/60" strokeWidth={2} />}
        <span className="text-[10px] font-medium">{tArrow ? <span className={zoneColor}>{tArrow}</span> : <span className={`${zoneColor} opacity-50 uppercase`}>{zone[0]}</span>}</span>
      </div>
    </div>
  );
}

function SectorsView({ sectors, timeframe, activeSector, onSelectSector }) {
  const sorted = [...sectors].sort((a, b) => Number(b.avg_bx) - Number(a.avg_bx));
  const maxAbs = Math.max(...sorted.map(s => Math.abs(Number(s.avg_bx))), 1);
  return (
    <div className="flex-1 overflow-y-auto scrollbar-edge">
      <div className="max-w-5xl mx-auto px-5 py-6">
        <div className="flex items-baseline gap-3 mb-5 flex-wrap">
          <Layers className="w-[16px] h-[16px] text-[#b4f200]" strokeWidth={2} />
          <h2 className="text-[15px] font-semibold tracking-tight">Sector Pulse · {SCAN_META[timeframe].label}</h2>
          <span className="text-[11px] text-[#52525b]">click any sector to filter tickers</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {sorted.map(s => {
            const avg = Number(s.avg_bx);
            const isActive = activeSector === s.sector;
            const accent = avg > 2 ? '#00d484' : avg < -2 ? '#ff3366' : '#a1a1aa';
            const widthPct = (Math.abs(avg) / maxAbs) * 100;
            return (
              <button key={s.sector} onClick={() => onSelectSector && onSelectSector(s.sector)}
                className={`text-left rounded-md p-4 transition-all no-tap-highlight ${isActive ? 'bg-[rgba(180,242,0,0.06)] border border-[#b4f200] shadow-[0_0_24px_rgba(180,242,0,0.15)]' : 'bg-[#0f1015] border border-[rgba(255,255,255,0.06)] hover:border-[rgba(255,255,255,0.16)]'}`}>
                <div className="flex items-baseline justify-between mb-2 gap-2">
                  <div className="flex items-baseline gap-2 min-w-0">
                    <span className="text-[13px] font-semibold tracking-tight truncate">{s.sector}</span>
                    {isActive && <span className="text-[9px] font-bold tracking-wider text-[#b4f200] uppercase">Active</span>}
                  </div>
                  <span className="text-[18px] font-semibold tabular-nums" style={{ color: accent }}>{avg >= 0 ? '+' : ''}{avg.toFixed(2)}</span>
                </div>
                <div className="h-1 bg-[#15171c] rounded-full relative overflow-hidden mb-2.5">
                  <div className="absolute top-0 bottom-0 rounded-full" style={{ background: accent, ...(avg >= 0 ? { left: '50%', width: `${widthPct/2}%` } : { right: '50%', width: `${widthPct/2}%` }) }} />
                  <div className="absolute top-0 bottom-0 left-1/2 w-px bg-[rgba(255,255,255,0.08)]" />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-[#52525b]">
                  <span>{s.ticker_count} tickers</span>
                  <span className="text-[#00d484]">{s.bullish_count} bull</span>
                  <span className="text-[#a1a1aa]">{s.neutral_count} neu</span>
                  <span className="text-[#ff3366]">{s.bearish_count} bear</span>
                  <span className="ml-auto">{s.pct_bullish}% bull</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function BacktestView({ summary, timeframe, scan }) {
  const PRIORITY = [
    { key: 'neutral_to_bullish',  label: 'Neutral → Bullish',  desc: 'Bullish breakout (long entry)',   accent: 'bull' },
    { key: 'bearish_to_neutral',  label: 'Bearish → Neutral',  desc: 'Selling pressure easing',         accent: 'neu' },
    { key: 'neutral_to_bearish',  label: 'Neutral → Bearish',  desc: 'Bearish breakdown (long exit)',   accent: 'bear' },
    { key: 'bullish_to_neutral',  label: 'Bullish → Neutral',  desc: 'Bullish momentum fading',         accent: 'neu' },
    { key: 'bullish_to_bearish',  label: 'Bullish → Bearish',  desc: 'Sharp reversal down',             accent: 'bear' },
    { key: 'bearish_to_bullish',  label: 'Bearish → Bullish',  desc: 'Sharp reversal up',               accent: 'bull' },
  ];
  const rows = PRIORITY.map(p => ({ ...p, data: summary.find(s => s.signal_type === p.key) || null }));
  const accentMap = {
    bull: { text: 'text-[#00d484]', border: 'border-[rgba(0,212,132,0.25)]', bg: 'bg-[rgba(0,212,132,0.04)]' },
    bear: { text: 'text-[#ff3366]', border: 'border-[rgba(255,51,102,0.25)]', bg: 'bg-[rgba(255,51,102,0.04)]' },
    neu:  { text: 'text-[#a1a1aa]', border: 'border-[rgba(161,161,170,0.15)]', bg: 'bg-[#0f1015]' },
  };
  return (
    <div className="flex-1 overflow-y-auto scrollbar-edge">
      <div className="max-w-5xl mx-auto px-5 py-6">
        <div className="flex items-baseline gap-3 mb-5 flex-wrap">
          <History className="w-[16px] h-[16px] text-[#b4f200]" strokeWidth={2} />
          <h2 className="text-[15px] font-semibold tracking-tight">Signal Backtest · {SCAN_META[timeframe].label}</h2>
          <span className="text-[11px] text-[#52525b]">historical performance across {scan.data.length} tickers</span>
        </div>
        <div className="space-y-3">
          {rows.map(({ key, label, desc, accent, data }) => {
            const c = accentMap[accent];
            return (
              <div key={key} className={`border ${c.border} ${c.bg} rounded-md p-4`}>
                <div className="flex items-baseline justify-between gap-3 mb-3 flex-wrap">
                  <div>
                    <div className={`text-[14px] font-semibold tracking-tight ${c.text}`}>{label}</div>
                    <div className="text-[11px] text-[#52525b] mt-0.5">{desc}</div>
                  </div>
                  {data ? <div className="text-[11px] text-[#52525b]">N={data.n_signals} signals</div> : <div className="text-[11px] text-[#52525b]">no data</div>}
                </div>
                {data && (
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                    <BTStat label="Avg 5d" val={data.avg_5d}/>
                    <BTStat label="Avg 20d" val={data.avg_20d}/>
                    <BTStat label="Avg 60d" val={data.avg_60d}/>
                    <BTStat label="Avg 120d" val={data.avg_120d}/>
                    <BTStat label="Win 60d" val={data.win_rate_60d_pct} isPct/>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-6 px-4 py-3 border border-[rgba(255,255,255,0.06)] bg-[#0f1015] rounded-md text-[11px] text-[#71717a] leading-relaxed">
          <span className="text-[#a1a1aa] font-medium">How to read this:</span> Each row shows what happened on average AFTER that signal type fired historically. Win rate 60d = % of those signals that ended in profit at 60 days. A 65% win rate beats 50% (random) by a meaningful margin.
        </div>
      </div>
    </div>
  );
}

function BTStat({ label, val, isPct }) {
  const num = Number(val);
  const color = isPct ? (num > 55 ? 'text-[#00d484]' : num < 45 ? 'text-[#ff3366]' : 'text-[#a1a1aa]') : (num > 0 ? 'text-[#00d484]' : num < 0 ? 'text-[#ff3366]' : 'text-[#71717a]');
  return (
    <div className="p-2 bg-[#08090b] rounded">
      <div className="text-[9px] text-[#52525b] uppercase tracking-wider font-semibold">{label}</div>
      <div className={`text-[13px] font-semibold tabular-nums mt-0.5 ${color}`}>{val == null ? '—' : `${num >= 0 && !isPct ? '+' : ''}${num.toFixed(2)}${isPct ? '%' : '%'}`}</div>
    </div>
  );
}

function Stat({ label, value, valueClass = 'text-[#fafafa]' }) {
  return (
    <div className="px-4 py-3 border-r border-[rgba(255,255,255,0.06)] last:border-r-0">
      <div className="text-[10px] text-[#52525b] uppercase tracking-wider font-semibold">{label}</div>
      <div className={`text-[15px] font-semibold tabular-nums mt-1 tracking-tight ${valueClass}`}>{value}</div>
    </div>
  );
}

function DetailPanel({ ticker, row, meta, interval, timeframe, notes, setNotes, watchlist, onToggleWatch }) {
  const noteVal = notes[ticker] || '';
  const setNote = (v) => setNotes(n => ({ ...n, [ticker]: v }));
  const watched = !!watchlist[ticker];
  const [tickerBacktest, setTickerBacktest] = useState([]);
  const [aiCopied, setAiCopied] = useState(false);
  const [aiError,  setAiError]  = useState(false);

  useEffect(() => {
    if (!ticker) return;
    fetchBacktestForTicker(ticker, timeframe).then(setTickerBacktest).catch(() => setTickerBacktest([]));
  }, [ticker, timeframe]);

  const copyToClipboard = async (text) => {
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch (e) {}
    try {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position='fixed'; ta.style.opacity='0'; ta.style.left='-9999px';
      document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); document.body.removeChild(ta); return ok;
    } catch (e) { return false; }
  };

  const bx = row?.bx; const prev = row?.prev; const zone = row?.zone;
  const zoneColor = zone === 'bullish' ? 'text-[#00d484]' : zone === 'bearish' ? 'text-[#ff3366]' : 'text-[#a1a1aa]';
  const align = meta.align;
  const earnLvl = earnLevel(meta.daysToEarn);

  const generateAIPrompt = () => {
    const lines = [
      `You are a LEAPS options trading assistant. The trader uses BX-Trender + Market Bias to find setups.`,
      `Give a 3-sentence assessment: (1) is this a clean setup or messy? (2) the main risk to watch (3) the one thing that would invalidate the thesis.`,
      ``,
      `TICKER: ${ticker}`,
      `Exchange: ${meta.ex || '—'} · Sector: ${meta.sec || '—'} · Industry: ${meta.ind || '—'}`,
      `Price: $${meta.px ? meta.px.toFixed(2) : '—'}  ·  Market cap: ${meta.mc ? (meta.mc >= 1000 ? `$${(meta.mc/1000).toFixed(2)}T` : `$${meta.mc.toFixed(1)}B`) : '—'}`,
      ``,
      `BX-TRENDER (${SCAN_META[timeframe].label}):`,
      `  Current: ${bx != null ? bx.toFixed(2) : '—'} (zone: ${zone || '—'})`,
      `  Previous: ${prev != null ? prev.toFixed(2) : '—'}`,
      row?.transition && `  Just transitioned: ${row.transition.from} → ${row.transition.to}`,
      ``,
      `MULTI-TIMEFRAME CONFLUENCE:`,
      `  Daily BX: ${meta.daily != null ? meta.daily.toFixed(2) : '—'}`,
      `  Weekly BX: ${meta.weekly != null ? meta.weekly.toFixed(2) : '—'}`,
      `  Monthly BX: ${meta.monthly != null ? meta.monthly.toFixed(2) : '—'}`,
      `  Alignment score: ${align != null ? `${align}/3` : '—'}`,
      `  Composite BX: ${meta.composite != null ? meta.composite.toFixed(2) : '—'}`,
      ``,
      `MARKET BIAS (${SCAN_META[timeframe].label}):`,
      `  Direction: ${meta.biasDir || '—'}`,
      `  In zone (price testing bias): ${meta.inZone ? 'YES — at potential support/resistance' : 'NO — outside the zone'}`,
      ``,
      `52-WEEK: ${meta.pct52 != null ? `${meta.pct52.toFixed(0)}% of range` : '—'} (H $${meta.hi52?.toFixed(2) || '—'}, L $${meta.lo52?.toFixed(2) || '—'})`,
      `EARNINGS: ${meta.earn ? `${meta.earn} (${meta.daysToEarn}d out)` : 'none in next 90d'}`,
    ].filter(Boolean).join('\n');
    copyToClipboard(lines).then(ok => {
      if (ok) { setAiCopied(true); setAiError(false); setTimeout(() => setAiCopied(false), 2000); }
      else { setAiError(true); setTimeout(() => setAiError(false), 3000); }
    });
  };

  const confluenceSummary = align != null ? (
    <span className="flex items-center gap-2"><AlignDots score={align} /><span className={`tabular-nums font-semibold ${align > 0 ? 'text-[#00d484]' : align < 0 ? 'text-[#ff3366]' : 'text-[#a1a1aa]'}`}>{align >= 0 ? '+' : ''}{align}/3</span></span>
  ) : <span className="text-[#52525b]">—</span>;
  const bxSummary = bx != null ? <span className={`tabular-nums font-semibold ${zoneColor}`}>{bx >= 0 ? '+' : ''}{bx.toFixed(2)}</span> : <span className="text-[#52525b]">—</span>;
  const biasSummary = meta.biasDir ? (
    <span className="flex items-center gap-1.5">
      <span className={`font-semibold ${meta.biasDir === 'bullish' ? 'text-[#00d484]' : 'text-[#ff3366]'}`}>{meta.biasDir === 'bullish' ? '▲ Bull' : '▼ Bear'}</span>
      {meta.inZone && <span className="px-1.5 py-0.5 bg-[rgba(180,242,0,0.1)] text-[#b4f200] rounded text-[9px] font-bold tracking-wider uppercase">In-Zone</span>}
    </span>
  ) : <span className="text-[#52525b]">—</span>;
  const range52Summary = meta.pct52 != null ? <span className={`tabular-nums font-semibold ${meta.pct52 > 80 ? 'text-[#00d484]' : meta.pct52 < 20 ? 'text-[#ff3366]' : 'text-[#a1a1aa]'}`}>{meta.pct52.toFixed(0)}%</span> : <span className="text-[#52525b]">—</span>;
  const backtestSummary = tickerBacktest.length > 0 ? <span className="text-[#a1a1aa]">{tickerBacktest.length} signals</span> : <span className="text-[#52525b]">—</span>;
  const notesSummary = noteVal ? <span className="text-[#a1a1aa]">{noteVal.length} ch</span> : <span className="text-[#52525b]">—</span>;

  return (
    <div className="flex flex-col h-full overflow-y-auto scrollbar-edge">
      <div className="sticky top-0 z-20 backdrop-blur-xl bg-[rgba(8,9,11,0.85)] flex-shrink-0">
        <div className="px-5 h-[68px] border-b border-[rgba(255,255,255,0.06)] flex items-center justify-between">
          <div className="flex items-baseline gap-3 min-w-0">
            <span className="text-[24px] font-bold tracking-tight">{ticker}</span>
            <div className="flex flex-col text-[11px] min-w-0 leading-tight">
              <span className="text-[#a1a1aa] truncate">{meta.ex || '—'} · {meta.sec || '—'}</span>
              <span className="text-[#52525b] truncate">{meta.ind || ''}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button onClick={generateAIPrompt}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium transition-all ${
                aiError ? 'bg-[rgba(255,51,102,0.1)] border border-[#ff3366] text-[#ff3366]' :
                aiCopied ? 'bg-[rgba(0,212,132,0.1)] border border-[#00d484] text-[#00d484]' :
                'bg-[rgba(180,242,0,0.08)] border border-[#b4f200]/40 text-[#b4f200] hover:bg-[#b4f200] hover:text-[#08090b]'
              }`}>
              {aiError ? <><X className="w-[12px] h-[12px]" strokeWidth={2.5}/>Failed</> :
               aiCopied ? <><Check className="w-[12px] h-[12px]" strokeWidth={2.5}/>Copied</> :
               <><Sparkles className="w-[12px] h-[12px]" strokeWidth={2.5}/>AI Brief</>}
            </button>
            <button onClick={() => onToggleWatch(ticker)} className="btn-icon-edge !w-8 !h-8">
              <Star className={`w-[14px] h-[14px] ${watched ? 'fill-[#ffa940] text-[#ffa940]' : 'text-[#71717a]'}`} strokeWidth={2} />
            </button>
          </div>
        </div>
        {earnLvl && (
          <div className={`px-5 py-2 border-b ${earnLvl === 'imminent' ? 'bg-[rgba(255,51,102,0.06)] border-[rgba(255,51,102,0.25)]' : 'bg-[rgba(255,169,64,0.06)] border-[rgba(255,169,64,0.25)]'}`}>
            <div className="flex items-center gap-2 text-[11px]">
              <Calendar className={`w-[13px] h-[13px] ${earnLvl === 'imminent' ? 'text-[#ff3366]' : 'text-[#ffa940]'}`} strokeWidth={2} />
              <span className={`font-semibold ${earnLvl === 'imminent' ? 'text-[#ff3366]' : 'text-[#ffa940]'}`}>{earnLvl === 'imminent' ? '⚠ Earnings imminent' : '🔔 Earnings soon'}</span>
              <span className="text-[#a1a1aa]">{meta.earn}</span>
              <span className="text-[#52525b]">· {meta.daysToEarn}d out</span>
            </div>
          </div>
        )}
        <div className="grid grid-cols-4 border-b border-[rgba(255,255,255,0.06)]">
          <Stat label="BX"   value={bx != null ? `${bx >= 0 ? '+' : ''}${bx.toFixed(2)}` : '—'} valueClass={zoneColor} />
          <Stat label="Prev" value={prev != null ? `${prev >= 0 ? '+' : ''}${prev.toFixed(2)}` : '—'} valueClass="text-[#a1a1aa]" />
          <Stat label="Price" value={meta.px ? `$${meta.px.toFixed(2)}` : '—'} />
          <Stat label="Cap"  value={meta.mc ? (meta.mc >= 1000 ? `$${(meta.mc/1000).toFixed(2)}T` : `$${meta.mc.toFixed(1)}B`) : '—'} />
        </div>
      </div>

      <CollapsibleSection title="Confluence" icon={Target} summary={confluenceSummary}>
        {align == null ? <div className="px-5 py-3 text-[11px] text-[#52525b]">No multi-timeframe data yet.</div> : (
          <div className="px-5 py-3">
            <div className="flex items-center justify-between mb-2.5">
              <div className="flex items-center gap-2"><AlignDots score={align} /><span className={`text-[12px] font-semibold tabular-nums ${align > 0 ? 'text-[#00d484]' : align < 0 ? 'text-[#ff3366]' : 'text-[#a1a1aa]'}`}>{align >= 0 ? '+' : ''}{align}/3</span></div>
              {meta.composite != null && <span className="text-[11px] text-[#71717a] tabular-nums">Composite <span className="text-[#fafafa] font-medium">{meta.composite >= 0 ? '+' : ''}{Number(meta.composite).toFixed(2)}</span></span>}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {[{ lbl: 'D', val: meta.daily }, { lbl: 'W', val: meta.weekly }, { lbl: 'M', val: meta.monthly }].map(({ lbl, val }) => {
                const tone = val == null ? 'mute' : val > 2 ? 'bull' : val < -2 ? 'bear' : 'neu';
                const cls = tone === 'bull' ? 'bg-[rgba(0,212,132,0.05)] border-[rgba(0,212,132,0.25)] text-[#00d484]' :
                            tone === 'bear' ? 'bg-[rgba(255,51,102,0.05)] border-[rgba(255,51,102,0.25)] text-[#ff3366]' :
                            tone === 'neu'  ? 'bg-[#0f1015] border-[rgba(255,255,255,0.06)] text-[#a1a1aa]' :
                                              'bg-[#0f1015] border-[rgba(255,255,255,0.06)] text-[#52525b]';
                return (
                  <div key={lbl} className={`border rounded-md px-3 py-2 flex items-center justify-between ${cls}`}>
                    <span className="text-[11px] font-semibold">{lbl}</span>
                    <span className="text-[12px] font-semibold tabular-nums">{val == null ? '—' : `${val >= 0 ? '+' : ''}${Number(val).toFixed(1)}`}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CollapsibleSection>

      <CollapsibleSection title="BX Range" icon={Activity} summary={bxSummary}>
        {bx == null ? null : (
          <div className="px-5 py-3">
            <div className="flex items-center justify-between text-[10px] text-[#52525b] mb-1.5 font-mono">
              <span>SCALE</span>
              <div className="flex items-center gap-4 text-[#52525b]"><span>−10</span><span>−2</span><span>0</span><span>+2</span><span>+10</span></div>
            </div>
            <div className="relative h-2 bg-[#0f1015] rounded-full overflow-hidden">
              <div className="absolute inset-y-0 left-0 w-[40%] bg-[rgba(255,51,102,0.15)]" />
              <div className="absolute inset-y-0 left-[40%] w-[20%] bg-[rgba(161,161,170,0.1)]" />
              <div className="absolute inset-y-0 left-[60%] w-[40%] bg-[rgba(0,212,132,0.15)]" />
              {prev != null && <div className="absolute top-0 bottom-0 w-px bg-[rgba(255,255,255,0.3)]" style={{ left: `${Math.max(0, Math.min(100, ((Math.max(-10, Math.min(10, prev)) + 10) / 20) * 100))}%` }}/>}
              <div className={`absolute top-0 bottom-0 w-1 rounded-full ${zone === 'bullish' ? 'bg-[#00d484] shadow-[0_0_8px_rgba(0,212,132,0.6)]' : zone === 'bearish' ? 'bg-[#ff3366] shadow-[0_0_8px_rgba(255,51,102,0.6)]' : 'bg-[#a1a1aa]'}`}
                style={{ left: `${Math.max(0, Math.min(100, ((Math.max(-10, Math.min(10, bx)) + 10) / 20) * 100))}%` }}/>
            </div>
            {row?.transition && (
              <div className="mt-3 flex items-center gap-2 text-[11px]">
                <span className="text-[#52525b]">Transition</span>
                <span className="text-[#a1a1aa] capitalize">{row.transition.from}</span>
                <ArrowRight className="w-[12px] h-[12px] text-[#52525b]" strokeWidth={2} />
                <span className={`font-semibold capitalize ${zoneColor}`}>{row.transition.to}</span>
              </div>
            )}
          </div>
        )}
      </CollapsibleSection>

      <CollapsibleSection title="Market Bias" icon={BarChart3} summary={biasSummary}>
        {!meta.biasDir ? <div className="px-5 py-3 text-[11px] text-[#52525b]">No Market Bias data.</div> : (
          <div className="px-5 py-3">
            <div className="flex items-center justify-between mb-2.5">
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-[#71717a]">Direction</span>
                <span className={`text-[13px] font-semibold ${meta.biasDir === 'bullish' ? 'text-[#00d484]' : 'text-[#ff3366]'}`}>{meta.biasDir === 'bullish' ? '▲ Bullish' : '▼ Bearish'}</span>
              </div>
              <span className="text-[11px] tabular-nums">Osc <span className={meta.biasOsc >= 0 ? 'text-[#00d484]' : 'text-[#ff3366]'}>{meta.biasOsc >= 0 ? '+' : ''}{meta.biasOsc?.toFixed(2)}</span></span>
            </div>
            <div className={`p-3 rounded-md border ${meta.inZone ? 'border-[#b4f200] bg-[rgba(180,242,0,0.06)]' : 'border-[rgba(255,255,255,0.06)] bg-[#0f1015]'}`}>
              <div className="flex items-start gap-2 text-[11px]">
                <Target className={`w-[14px] h-[14px] mt-0.5 flex-shrink-0 ${meta.inZone ? 'text-[#b4f200]' : 'text-[#52525b]'}`} strokeWidth={2} />
                <div>
                  <div className={`font-semibold ${meta.inZone ? 'text-[#b4f200]' : 'text-[#71717a]'}`}>{meta.inZone ? 'In the zone' : 'Out of zone'}</div>
                  <div className="text-[#a1a1aa] mt-0.5">{meta.inZone ? `Price testing bias level. ${meta.biasDir === 'bullish' ? 'Potential bullish entry (buy-the-dip).' : 'Potential bearish entry (sell-the-rip).'}` : `Price extended ${meta.biasDir === 'bullish' ? 'above' : 'below'} the bias. Wait for pullback.`}</div>
                </div>
              </div>
            </div>
          </div>
        )}
      </CollapsibleSection>

      <CollapsibleSection title="52-Week" icon={TrendingUp} summary={range52Summary}>
        {meta.pct52 == null || !meta.hi52 || !meta.lo52 ? null : (
          <div className="px-5 py-3">
            <div className="flex items-center justify-between text-[10px] mb-1.5">
              <span className="text-[#52525b] font-mono uppercase tracking-wider">Position</span>
              <span className={`tabular-nums font-semibold text-[11px] ${meta.pct52 > 80 ? 'text-[#00d484]' : meta.pct52 < 20 ? 'text-[#ff3366]' : 'text-[#a1a1aa]'}`}>{meta.pct52.toFixed(0)}% of range</span>
            </div>
            <div className="relative h-2 bg-[#0f1015] rounded-full overflow-hidden">
              <div className="absolute inset-y-0 left-0 bg-[rgba(180,242,0,0.3)]" style={{ width: `${meta.pct52}%` }} />
              <div className="absolute top-0 bottom-0 w-1 bg-[#b4f200] rounded-full shadow-[0_0_8px_rgba(180,242,0,0.6)]" style={{ left: `${Math.max(0, Math.min(100, meta.pct52))}%` }} />
            </div>
            <div className="flex items-center justify-between text-[10px] text-[#71717a] mt-1.5 tabular-nums">
              <span>L ${Number(meta.lo52).toFixed(2)}</span>
              <span>Now ${meta.px ? meta.px.toFixed(2) : '—'}</span>
              <span>H ${Number(meta.hi52).toFixed(2)}</span>
            </div>
          </div>
        )}
      </CollapsibleSection>

      <CollapsibleSection title="Backtest" icon={History} summary={backtestSummary}>
        {tickerBacktest.length === 0 ? <div className="px-5 py-3 text-[11px] text-[#52525b]">No historical signals yet.</div> : (
          <div className="px-5 py-3">
            <div className="text-[10px] text-[#52525b] mb-2 uppercase tracking-wider font-semibold">Last {Math.min(tickerBacktest.length, 5)} signals · 60d return</div>
            <div className="space-y-1.5">
              {tickerBacktest.slice(0, 5).map((s) => {
                const ret = s.ret_60d;
                const retColor = ret == null ? 'text-[#52525b]' : ret > 0 ? 'text-[#00d484]' : 'text-[#ff3366]';
                const sigParts = s.signal_type.split('_to_');
                return (
                  <div key={s.id} className="flex items-center justify-between text-[11px] py-1.5 border-b border-[rgba(255,255,255,0.04)] last:border-b-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[#71717a] tabular-nums font-mono">{s.signal_date}</span>
                      <span className="text-[#52525b] capitalize truncate">{sigParts[0]} → {sigParts[1]}</span>
                    </div>
                    <span className={`font-semibold tabular-nums ${retColor}`}>{ret == null ? 'pending' : `${ret >= 0 ? '+' : ''}${Number(ret).toFixed(1)}%`}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CollapsibleSection>

      <div className="flex-1 min-h-[55vh] flex-shrink-0 relative border-b border-[rgba(255,255,255,0.06)] bg-[#0f1015]">
        <div className="absolute top-3 left-4 z-10 text-[10px] tracking-wider text-[#52525b] pointer-events-none font-mono uppercase font-semibold">TradingView · {interval}</div>
        {ticker && <TVChart ticker={ticker} interval={interval} />}
      </div>

      <CollapsibleSection title="Notes" icon={StickyNote} summary={notesSummary}>
        <textarea value={noteVal} onChange={(e) => setNote(e.target.value)}
          placeholder="LEAPS thesis · strike / expiry / entry trigger…"
          className="w-full h-28 bg-[#08090b] text-[#fafafa] text-[12px] px-5 py-3 resize-none focus:outline-none focus:bg-[#0f1015] block placeholder-[#52525b]"/>
      </CollapsibleSection>
    </div>
  );
}

function MobileFiltersDrawer({ mcBucket, setMcBucket, priceMin, setPriceMin, priceMax, setPriceMax, volMin, setVolMin, earnFilter, setEarnFilter, pct52Filter, setPct52Filter, biasFilter, setBiasFilter, inZoneOnly, setInZoneOnly, hasActiveFilters, onClear, onClose }) {
  return (
    <div className="lg:hidden fixed inset-0 bg-black/70 backdrop-blur-sm flex items-end z-50" onClick={onClose}>
      <div className="w-full bg-[#08090b] border-t border-[rgba(255,255,255,0.06)] slide-up max-h-[88vh] overflow-y-auto rounded-t-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 h-12 border-b border-[rgba(255,255,255,0.06)] sticky top-0 backdrop-blur-xl bg-[rgba(8,9,11,0.85)]">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="w-[14px] h-[14px] text-[#b4f200]" strokeWidth={2} />
            <span className="text-[13px] font-semibold">Filters</span>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-[#0f1015]"><X className="w-[16px] h-[16px] text-[#71717a]"/></button>
        </div>
        <div className="p-5 space-y-5">
          <FilterBlock title="Market Bias">
            <div className="grid grid-cols-3 gap-2 mb-2">
              {BIAS_BUCKETS.map((b, i) => <button key={b.label} onClick={() => setBiasFilter(i)} className={`px-3 py-2 rounded-md text-[12px] font-medium ${biasFilter === i ? 'bg-[rgba(180,242,0,0.08)] border border-[#b4f200] text-[#b4f200]' : 'bg-[#0f1015] border border-[rgba(255,255,255,0.06)] text-[#a1a1aa]'}`}>{b.label}</button>)}
            </div>
            <button onClick={() => setInZoneOnly(z => !z)} className={`w-full px-3 py-2 rounded-md text-[12px] font-medium ${inZoneOnly ? 'bg-[rgba(180,242,0,0.08)] border border-[#b4f200] text-[#b4f200]' : 'bg-[#0f1015] border border-[rgba(255,255,255,0.06)] text-[#a1a1aa]'}`}>{inZoneOnly ? '✓ Only show "In Zone"' : 'Only show "In Zone"'}</button>
          </FilterBlock>
          <FilterBlock title="Market Cap">
            <div className="grid grid-cols-2 gap-2">
              {MC_BUCKETS.map((b, i) => <button key={b.label} onClick={() => setMcBucket(i)} className={`px-3 py-2 rounded-md text-[12px] font-medium ${mcBucket === i ? 'bg-[rgba(180,242,0,0.08)] border border-[#b4f200] text-[#b4f200]' : 'bg-[#0f1015] border border-[rgba(255,255,255,0.06)] text-[#a1a1aa]'}`}>{b.label}</button>)}
            </div>
          </FilterBlock>
          <FilterBlock title="Earnings · skip if within">
            <div className="grid grid-cols-5 gap-1.5">
              {EARN_BUCKETS.map((b, i) => <button key={b.label} onClick={() => setEarnFilter(i)} className={`px-2 py-2 rounded-md text-[11px] font-medium ${earnFilter === i ? 'bg-[rgba(255,169,64,0.1)] border border-[#ffa940] text-[#ffa940]' : 'bg-[#0f1015] border border-[rgba(255,255,255,0.06)] text-[#a1a1aa]'}`}>{b.label}</button>)}
            </div>
          </FilterBlock>
          <FilterBlock title="52-Week Position">
            <div className="grid grid-cols-2 gap-2">
              {PCT52_BUCKETS.map((b, i) => <button key={b.label} onClick={() => setPct52Filter(i)} className={`px-3 py-2 rounded-md text-[12px] font-medium ${pct52Filter === i ? 'bg-[rgba(180,242,0,0.08)] border border-[#b4f200] text-[#b4f200]' : 'bg-[#0f1015] border border-[rgba(255,255,255,0.06)] text-[#a1a1aa]'}`}>{b.label}</button>)}
            </div>
          </FilterBlock>
          <FilterBlock title="Price Range ($)">
            <div className="flex items-center gap-2">
              <input value={priceMin} onChange={e => setPriceMin(e.target.value)} placeholder="Min" type="number" inputMode="decimal" className="search-edge flex-1"/>
              <span className="text-[#52525b]">–</span>
              <input value={priceMax} onChange={e => setPriceMax(e.target.value)} placeholder="Max" type="number" inputMode="decimal" className="search-edge flex-1"/>
            </div>
          </FilterBlock>
          <FilterBlock title="Min Volume (M)">
            <input value={volMin} onChange={e => setVolMin(e.target.value)} placeholder="0" type="number" inputMode="decimal" className="search-edge w-full"/>
          </FilterBlock>
        </div>
        <div className="flex gap-2 p-4 border-t border-[rgba(255,255,255,0.06)] sticky bottom-0 backdrop-blur-xl bg-[rgba(8,9,11,0.85)]">
          {hasActiveFilters && <button onClick={onClear} className="flex-1 py-3 rounded-md border border-[rgba(255,51,102,0.3)] bg-[rgba(255,51,102,0.05)] text-[12px] text-[#ff3366] font-medium">Clear all</button>}
          <button onClick={onClose} className="flex-1 py-3 rounded-md bg-[#b4f200] text-[#08090b] text-[12px] font-semibold">Apply</button>
        </div>
      </div>
    </div>
  );
}

function FilterBlock({ title, children }) {
  return (
    <div>
      <div className="text-[10px] text-[#52525b] uppercase tracking-wider font-semibold mb-2">{title}</div>
      {children}
    </div>
  );
}

function AlertsDrawer({ transitions, onClose, onSelect }) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-start justify-end z-50" onClick={onClose}>
      <div className="w-full md:w-[440px] h-full bg-[#08090b] border-l border-[rgba(255,255,255,0.06)] flex flex-col slide-right" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 h-12 border-b border-[rgba(255,255,255,0.06)] flex-shrink-0 backdrop-blur-xl bg-[rgba(8,9,11,0.85)]">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-[14px] h-[14px] text-[#ffa940]" strokeWidth={2} />
            <span className="text-[13px] font-semibold">Zone Transitions</span>
            <span className="text-[11px] text-[#52525b] tabular-nums">({transitions.length})</span>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-[#0f1015]"><X className="w-[16px] h-[16px] text-[#71717a]"/></button>
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-edge">
          {transitions.length === 0 ? <div className="p-8 text-center text-[11px] text-[#52525b]">— No zone transitions since last scan —</div> : transitions.sort((a, b) => Math.abs(b.bx - (b.prev ?? 0)) - Math.abs(a.bx - (a.prev ?? 0))).map(r => {
            const toClass = r.zone === 'bullish' ? 'text-[#00d484]' : r.zone === 'bearish' ? 'text-[#ff3366]' : 'text-[#a1a1aa]';
            return (
              <div key={r.t} onClick={() => onSelect(r.t)}
                className="px-5 py-3 border-b border-[rgba(255,255,255,0.04)] hover:bg-[#0f1015] cursor-pointer">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[14px] font-semibold tracking-tight">{r.t}</span>
                  <span className={`text-[14px] font-semibold tabular-nums ${toClass}`}>{r.bx >= 0 ? '+' : ''}{r.bx.toFixed(2)}</span>
                </div>
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="text-[#71717a] capitalize">{r.transition.from}</span>
                  <ArrowRight className="w-[12px] h-[12px] text-[#52525b]" strokeWidth={2} />
                  <span className={`font-semibold capitalize ${toClass}`}>{r.transition.to}</span>
                  {r.prev != null && <span className="ml-auto text-[#52525b] tabular-nums">Δ {(r.bx - r.prev).toFixed(2)}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
