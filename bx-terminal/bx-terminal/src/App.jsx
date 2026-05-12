import React, { useState, useEffect, useMemo } from 'react';
import { Star, StickyNote, X, Search, AlertCircle, ArrowRight, Radio, SlidersHorizontal, ChevronLeft, RefreshCw } from 'lucide-react';

// ============================================================================
// BX TERMINAL — reads live scan data from Supabase
// ============================================================================

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

const SCAN_META = {
  daily:   { tvInterval: 'D', label: 'DAILY'   },
  weekly:  { tvInterval: 'W', label: 'WEEKLY'  },
  monthly: { tvInterval: 'M', label: 'MONTHLY' },
};

async function sbFetch(path) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY env vars');
  }
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      // Bump from default 1000 row cap — our universe is ~1,800 tickers
      Range: '0-9999',
    },
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
      ex: r.exchange || 'NASDAQ',
      mc: r.market_cap_billions ? Number(r.market_cap_billions) : 0,
      px: r.price ? Number(r.price) : 0,
      vol: r.avg_volume_millions ? Number(r.avg_volume_millions) : 0,
      sec: r.sector || '—',
    };
    return { t: r.ticker, bx: Number(r.bx), prev: r.prev_bx != null ? Number(r.prev_bx) : null };
  });
  return { date: rows[0].scan_date, data, meta };
}

function zoneOf(bx){ if(bx<-2) return 'bearish'; if(bx>2) return 'bullish'; return 'neutral'; }
function transitionOf(cur,prev){ if(prev==null) return null; const a=zoneOf(prev),b=zoneOf(cur); return a===b?null:{from:a,to:b}; }

const MC_BUCKETS = [
  { label: 'ALL',   min: 0,   max: Infinity },
  { label: 'MEGA',  min: 200, max: Infinity },
  { label: 'LARGE', min: 10,  max: 200 },
  { label: 'MID',   min: 2,   max: 10 },
  { label: 'SMALL', min: 0,   max: 2 },
];
const MC_BUCKETS_LONG = ['ALL','MEGA >200B','LARGE 10-200B','MID 2-10B','SMALL <2B'];

function TVChart({ ticker, interval, meta }) {
  const sym = meta?.ex ? `${meta.ex}:${ticker}` : ticker;
  const src =
    `https://s.tradingview.com/widgetembed/?frameElementId=tv_${ticker}` +
    `&symbol=${encodeURIComponent(sym)}&interval=${interval}` +
    `&hidesidetoolbar=0&symboledit=1&saveimage=0` +
    `&toolbarbg=0a0a0b&theme=dark&style=1&timezone=Etc%2FUTC` +
    `&withdateranges=1&hideideas=1&hideideasbutton=1&locale=en`;
  return (
    <iframe key={`${ticker}-${interval}`} src={src} title={`${ticker} ${interval}`}
      className="w-full h-full border-0" allow="fullscreen"/>
  );
}

function loadLocal(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function saveLocal(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

export default function App() {
  const [timeframe, setTimeframe] = useState('weekly');
  const [scan, setScan] = useState({ date: null, data: [], meta: {} });
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
  const [showAlerts, setShowAlerts] = useState(false);
  const [mobileZone, setMobileZone] = useState('bullish');
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    fetchScan(timeframe)
      .then(s => { if (!cancelled) { setScan(s); if (s.data.length && !selected) setSelected(s.data[0].t); } })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [timeframe]);

  useEffect(() => { saveLocal('bx_watchlist', watchlist); }, [watchlist]);
  useEffect(() => { saveLocal('bx_notes', notes); }, [notes]);

  const tvInterval = SCAN_META[timeframe].tvInterval;

  const decorated = useMemo(() => scan.data.map(row => {
    const meta = scan.meta[row.t] || { ex: 'NASDAQ', mc: 0, px: 0, vol: 0, sec: '—' };
    return { ...row, ...meta, zone: zoneOf(row.bx), transition: transitionOf(row.bx, row.prev) };
  }), [scan]);

  const filtered = useMemo(() => {
    const bucket = MC_BUCKETS[mcBucket];
    const pMin = priceMin === '' ? -Infinity : parseFloat(priceMin);
    const pMax = priceMax === '' ? Infinity : parseFloat(priceMax);
    const vMin = volMin === '' ? 0 : parseFloat(volMin);
    const q = query.trim().toUpperCase();
    return decorated.filter(r => {
      if (watchOnly && !watchlist[r.t]) return false;
      if (q && !r.t.includes(q)) return false;
      if (r.mc < bucket.min || r.mc > bucket.max) return false;
      if (r.px > 0 && (r.px < pMin || r.px > pMax)) return false;
      if (r.vol < vMin) return false;
      return true;
    });
  }, [decorated, mcBucket, priceMin, priceMax, volMin, watchOnly, watchlist, query]);

  const bearish = useMemo(() => filtered.filter(r => r.zone === 'bearish').sort((a,b) => a.bx - b.bx), [filtered]);
  const neutral = useMemo(() => filtered.filter(r => r.zone === 'neutral').sort((a,b) => Math.abs(a.bx) - Math.abs(b.bx)), [filtered]);
  const bullish = useMemo(() => filtered.filter(r => r.zone === 'bullish').sort((a,b) => b.bx - a.bx), [filtered]);
  const transitions = useMemo(() => filtered.filter(r => r.transition), [filtered]);

  const toggleWatch = (t) => setWatchlist(w => { const n={...w}; if(n[t])delete n[t]; else n[t]=Date.now(); return n; });
  const handleSelect = (t) => { setSelected(t); setMobileDetailOpen(true); };
  const clearFilters = () => { setQuery(''); setPriceMin(''); setPriceMax(''); setVolMin(''); setMcBucket(0); setWatchOnly(false); };
  const refresh = () => { setLoading(true); fetchScan(timeframe).then(setScan).catch(e => setError(e.message)).finally(() => setLoading(false)); };

  const selectedMeta = scan.meta[selected] || {};
  const selectedRow = decorated.find(r => r.t === selected);
  const mobileRows = mobileZone === 'bearish' ? bearish : mobileZone === 'neutral' ? neutral : bullish;
  const hasActiveFilters = query || priceMin || priceMax || volMin || mcBucket !== 0 || watchOnly;

  if (loading && scan.data.length === 0) {
    return (
      <div className="w-full h-screen bg-zinc-950 text-emerald-400 flex items-center justify-center">
        <span className="animate-pulse text-xs tracking-[0.3em]">LOADING SCAN DATA…</span>
      </div>
    );
  }
  if (error && scan.data.length === 0) {
    return (
      <div className="w-full h-screen bg-zinc-950 text-red-400 flex flex-col items-center justify-center gap-3 px-6 text-center">
        <AlertCircle className="w-6 h-6" />
        <span className="text-xs tracking-[0.3em]">SCAN FETCH FAILED</span>
        <span className="text-[11px] text-zinc-500 max-w-md">{error}</span>
        <button onClick={refresh} className="mt-2 px-4 py-2 border border-zinc-800 text-zinc-300 text-[10px] tracking-wider active:border-emerald-500">
          RETRY
        </button>
      </div>
    );
  }

  return (
    <div className="w-full h-screen bg-zinc-950 text-zinc-100 overflow-hidden flex flex-col">
      <style>{`
        .scanlines::before { content:''; position:absolute; inset:0; background: repeating-linear-gradient(0deg, rgba(255,255,255,0.015) 0px, rgba(255,255,255,0.015) 1px, transparent 1px, transparent 3px); pointer-events:none; }
        .live-dot { animation: pulse 1.8s ease-in-out infinite; }
        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.3; } }
        input::placeholder { color: #52525b; }
        .col-scroll::-webkit-scrollbar { width: 6px; }
        .col-scroll::-webkit-scrollbar-track { background: #0a0a0b; }
        .col-scroll::-webkit-scrollbar-thumb { background: #27272a; }
        @keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
        .slide-up { animation: slideUp 0.2s ease-out; }
        @keyframes slideRight { from { transform: translateX(100%); } to { transform: translateX(0); } }
        .slide-right { animation: slideRight 0.2s ease-out; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .spinning { animation: spin 0.8s linear infinite; }
      `}</style>

      <header className="flex-shrink-0 border-b border-zinc-800 bg-zinc-950 relative scanlines">
        <div className="flex items-center justify-between px-3 md:px-4 h-11 md:h-12">
          <div className="flex items-center gap-3 md:gap-6 min-w-0">
            <div className="flex items-center gap-2 flex-shrink-0">
              <Radio className="w-3.5 h-3.5 md:w-4 md:h-4 text-emerald-400 live-dot" />
              <span className="text-[10px] md:text-[11px] tracking-[0.25em] md:tracking-[0.3em] font-bold text-emerald-400">BX.TERMINAL</span>
              <span className="hidden md:inline text-[10px] text-zinc-600">v1.0</span>
            </div>
            <div className="hidden md:block h-4 w-px bg-zinc-800" />
            <div className="hidden md:flex items-center gap-1 text-[10px] text-zinc-500">
              <span>SCAN:</span><span className="text-zinc-300">{scan.date || '—'}</span>
              <span className="ml-3">TICKERS:</span><span className="text-zinc-300">{scan.data.length}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 md:gap-4 text-[10px]">
            <div className="hidden md:flex items-center gap-2">
              <span className="text-zinc-500">BEAR</span><span className="text-red-400 font-bold">{bearish.length}</span>
              <span className="text-zinc-500">NEU</span><span className="text-amber-400 font-bold">{neutral.length}</span>
              <span className="text-zinc-500">BULL</span><span className="text-emerald-400 font-bold">{bullish.length}</span>
            </div>
            <button onClick={refresh} disabled={loading}
              className="flex items-center gap-1 px-2 py-1 border border-zinc-800 active:border-emerald-500/50 md:hover:border-emerald-500/50 text-[10px] tracking-wider disabled:opacity-50">
              <RefreshCw className={`w-3 h-3 text-emerald-400 ${loading ? 'spinning' : ''}`} />
            </button>
            <button onClick={() => setShowAlerts(true)}
              className="flex items-center gap-1.5 px-2 py-1 border border-zinc-800 active:border-amber-500/50 md:hover:border-amber-500/50 text-[10px] tracking-wider">
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
                className={`flex-1 md:flex-none md:px-6 h-9 text-[11px] tracking-[0.3em] border-r border-zinc-800 transition-colors ${
                  active ? 'bg-zinc-900 text-emerald-400 border-b-2 border-b-emerald-400'
                         : 'text-zinc-500 active:text-zinc-200 md:hover:text-zinc-200 md:hover:bg-zinc-900/50'
                }`}>
                {SCAN_META[tf].label}
              </button>
            );
          })}
          <div className="hidden md:flex ml-auto px-4 text-[10px] text-zinc-500 items-center gap-2">
            <span>CHART.INTERVAL:</span><span className="text-zinc-200">{tvInterval}</span>
          </div>
        </div>

        <div className="md:hidden flex items-stretch border-t border-zinc-800 h-8 text-[10px]">
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

        <div className="hidden md:flex items-center gap-3 px-4 h-10 border-t border-zinc-800 bg-zinc-950">
          <div className="flex items-center gap-2 flex-1 max-w-xs">
            <Search className="w-3 h-3 text-zinc-600" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="SEARCH TICKER…"
              className="flex-1 bg-transparent border-b border-zinc-800 text-[11px] text-zinc-200 px-1 py-0.5 focus:outline-none focus:border-emerald-500 tracking-wider"/>
          </div>
          <div className="flex items-center gap-1 text-[10px]">
            <span className="text-zinc-500 mr-1">MCAP</span>
            {MC_BUCKETS.map((b, i) => (
              <button key={b.label} onClick={() => setMcBucket(i)}
                className={`px-2 py-0.5 border tracking-wider ${mcBucket === i ? 'border-emerald-500 text-emerald-400 bg-emerald-500/5' : 'border-zinc-800 text-zinc-500 hover:text-zinc-300'}`}>
                {MC_BUCKETS_LONG[i]}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 text-[10px]">
            <span className="text-zinc-500">PX</span>
            <input value={priceMin} onChange={e => setPriceMin(e.target.value)} placeholder="min" className="w-14 bg-zinc-900 border border-zinc-800 text-zinc-200 px-1.5 py-0.5 focus:outline-none focus:border-emerald-500"/>
            <span className="text-zinc-700">–</span>
            <input value={priceMax} onChange={e => setPriceMax(e.target.value)} placeholder="max" className="w-14 bg-zinc-900 border border-zinc-800 text-zinc-200 px-1.5 py-0.5 focus:outline-none focus:border-emerald-500"/>
          </div>
          <div className="flex items-center gap-1 text-[10px]">
            <span className="text-zinc-500">VOL&gt;</span>
            <input value={volMin} onChange={e => setVolMin(e.target.value)} placeholder="M" className="w-14 bg-zinc-900 border border-zinc-800 text-zinc-200 px-1.5 py-0.5 focus:outline-none focus:border-emerald-500"/>
          </div>
          <button onClick={() => setWatchOnly(w => !w)}
            className={`flex items-center gap-1 px-2 py-0.5 border text-[10px] tracking-wider ${watchOnly ? 'border-amber-500 text-amber-400 bg-amber-500/5' : 'border-zinc-800 text-zinc-500 hover:text-zinc-300'}`}>
            <Star className={`w-3 h-3 ${watchOnly ? 'fill-amber-400' : ''}`} />
            WATCHLIST<span className="text-zinc-600">({Object.keys(watchlist).length})</span>
          </button>
          {hasActiveFilters && (
            <button onClick={clearFilters} className="text-[10px] text-zinc-500 hover:text-red-400 tracking-wider">CLEAR.FILTERS</button>
          )}
        </div>

        <div className="md:hidden flex items-center gap-2 px-3 h-10 border-t border-zinc-800 bg-zinc-950">
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            <Search className="w-3 h-3 text-zinc-600 flex-shrink-0" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="SEARCH…"
              className="w-full bg-transparent border-b border-zinc-800 text-[11px] text-zinc-200 px-1 py-0.5 focus:outline-none focus:border-emerald-500 tracking-wider"/>
          </div>
          <button onClick={() => setWatchOnly(w => !w)}
            className={`flex items-center gap-1 px-2 py-1 border text-[10px] ${watchOnly ? 'border-amber-500 text-amber-400' : 'border-zinc-800 text-zinc-500'}`}>
            <Star className={`w-3 h-3 ${watchOnly ? 'fill-amber-400' : ''}`} />
          </button>
          <button onClick={() => setMobileFiltersOpen(true)}
            className={`flex items-center gap-1 px-2 py-1 border text-[10px] tracking-wider ${hasActiveFilters ? 'border-emerald-500 text-emerald-400' : 'border-zinc-800 text-zinc-400'}`}>
            <SlidersHorizontal className="w-3 h-3" />FILTERS
            {hasActiveFilters && <span className="w-1 h-1 bg-emerald-400" />}
          </button>
        </div>
      </header>

      <div className="hidden md:flex flex-1 overflow-hidden">
        <div className="flex-1 grid grid-cols-3 overflow-hidden">
          <ZoneColumn label="BEARISH" range="[−10 · −2)" accent="red" rows={bearish}
            selected={selected} onSelect={handleSelect} watchlist={watchlist} onToggleWatch={toggleWatch} notes={notes}/>
          <ZoneColumn label="NEUTRAL" range="[−2 · +2]" accent="amber" rows={neutral}
            selected={selected} onSelect={handleSelect} watchlist={watchlist} onToggleWatch={toggleWatch} notes={notes}/>
          <ZoneColumn label="BULLISH" range="(+2 · +10]" accent="emerald" rows={bullish}
            selected={selected} onSelect={handleSelect} watchlist={watchlist} onToggleWatch={toggleWatch} notes={notes}/>
        </div>
        <aside className="w-[520px] flex-shrink-0 border-l border-zinc-800 flex flex-col bg-zinc-950">
          {selected && <DetailPanel ticker={selected} row={selectedRow} meta={selectedMeta} interval={tvInterval}
            notes={notes} setNotes={setNotes} watchlist={watchlist} onToggleWatch={toggleWatch}/>}
        </aside>
      </div>

      <div className="md:hidden flex-1 flex flex-col overflow-hidden">
        <div className="flex items-stretch border-b border-zinc-800 bg-zinc-950 flex-shrink-0">
          <MobileZoneTab label="BEARISH" count={bearish.length} active={mobileZone === 'bearish'} accent="red" onClick={() => setMobileZone('bearish')}/>
          <MobileZoneTab label="NEUTRAL" count={neutral.length} active={mobileZone === 'neutral'} accent="amber" onClick={() => setMobileZone('neutral')}/>
          <MobileZoneTab label="BULLISH" count={bullish.length} active={mobileZone === 'bullish'} accent="emerald" onClick={() => setMobileZone('bullish')}/>
        </div>
        <div className="px-3 h-6 flex items-center text-[9px] text-zinc-600 tracking-wider border-b border-zinc-900 flex-shrink-0">
          <span>RANGE:</span>
          <span className="ml-2 text-zinc-400">
            {mobileZone === 'bearish' ? '[−10 · −2)' : mobileZone === 'neutral' ? '[−2 · +2]' : '(+2 · +10]'}
          </span>
          <span className="ml-auto">TAP ROW → CHART</span>
        </div>
        <div className="flex-1 overflow-hidden flex flex-col">
          <div className="flex items-center px-3 h-6 border-b border-zinc-900 bg-zinc-950/50 text-[9px] text-zinc-600 tracking-wider uppercase flex-shrink-0">
            <span className="w-16">Ticker</span>
            <span className="w-14 text-right">BX</span>
            <span className="flex-1 text-right">PX · VOL</span>
            <span className="w-10 text-right">Δ</span>
          </div>
          <div className="flex-1 overflow-y-auto col-scroll">
            {mobileRows.length === 0 ? (
              <div className="px-3 py-12 text-center text-[10px] text-zinc-700 tracking-wider">— NO MATCHES —</div>
            ) : mobileRows.map(r => {
              const c = mobileZone === 'bullish' ? { text: 'text-emerald-400' } :
                        mobileZone === 'bearish' ? { text: 'text-red-400' } :
                        { text: 'text-amber-400' };
              return (
                <RowItem key={r.t} r={r} c={c} selected={false}
                  onSelect={() => handleSelect(r.t)}
                  watched={!!watchlist[r.t]} onToggleWatch={() => toggleWatch(r.t)}
                  hasNote={!!notes[r.t]} mobile/>
              );
            })}
          </div>
        </div>
      </div>

      {mobileDetailOpen && selected && (
        <div className="md:hidden fixed inset-0 z-40 bg-zinc-950 flex flex-col slide-up">
          <div className="flex items-center gap-2 px-3 h-11 border-b border-zinc-800 flex-shrink-0">
            <button onClick={() => setMobileDetailOpen(false)} className="flex items-center gap-1 text-zinc-400 -ml-1 px-1 py-2">
              <ChevronLeft className="w-4 h-4" />
              <span className="text-[10px] tracking-[0.3em]">BACK</span>
            </button>
            <div className="flex items-center gap-2 ml-auto">
              <Radio className="w-3 h-3 text-emerald-400 live-dot" />
              <span className="text-[10px] tracking-[0.3em] text-emerald-400">{tvInterval}</span>
            </div>
          </div>
          <div className="flex-1 overflow-hidden">
            <DetailPanel ticker={selected} row={selectedRow} meta={selectedMeta} interval={tvInterval}
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

function MobileZoneTab({ label, count, active, accent, onClick }) {
  const colors = {
    red:     { text: active ? 'text-red-400' : 'text-zinc-500',     border: 'border-b-red-400',     dot: 'bg-red-500' },
    amber:   { text: active ? 'text-amber-400' : 'text-zinc-500',   border: 'border-b-amber-400',   dot: 'bg-amber-500' },
    emerald: { text: active ? 'text-emerald-400' : 'text-zinc-500', border: 'border-b-emerald-400', dot: 'bg-emerald-500' },
  };
  const c = colors[accent];
  return (
    <button onClick={onClick}
      className={`flex-1 flex flex-col items-center justify-center gap-0.5 h-12 border-r border-zinc-800 last:border-r-0 ${
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

function ZoneColumn({ label, range, accent, rows, selected, onSelect, watchlist, onToggleWatch, notes }) {
  const accentMap = {
    red:     { text: 'text-red-400',     bg: 'bg-red-500/5',     border: 'border-red-500/30',     dot: 'bg-red-500' },
    amber:   { text: 'text-amber-400',   bg: 'bg-amber-500/5',   border: 'border-amber-500/30',   dot: 'bg-amber-500' },
    emerald: { text: 'text-emerald-400', bg: 'bg-emerald-500/5', border: 'border-emerald-500/30', dot: 'bg-emerald-500' },
  };
  const c = accentMap[accent];
  return (
    <div className="flex flex-col overflow-hidden border-r border-zinc-800 last:border-r-0">
      <div className={`flex items-center justify-between px-3 h-10 border-b ${c.border} ${c.bg}`}>
        <div className="flex items-center gap-2">
          <div className={`w-1.5 h-1.5 ${c.dot}`} />
          <span className={`text-[11px] font-bold tracking-[0.3em] ${c.text}`}>{label}</span>
          <span className="text-[9px] text-zinc-500 tracking-wider">{range}</span>
        </div>
        <span className={`text-[11px] font-bold ${c.text}`}>{rows.length}</span>
      </div>
      <div className="flex items-center px-3 h-6 border-b border-zinc-900 bg-zinc-950/50 text-[9px] text-zinc-600 tracking-wider uppercase">
        <span className="w-16">Ticker</span>
        <span className="w-14 text-right">BX</span>
        <span className="flex-1 text-right">PX · VOL</span>
        <span className="w-12 text-right">Δ</span>
      </div>
      <div className="flex-1 overflow-y-auto col-scroll">
        {rows.length === 0 ? (
          <div className="px-3 py-8 text-center text-[10px] text-zinc-700 tracking-wider">— NO MATCHES —</div>
        ) : rows.map(r => (
          <RowItem key={r.t} r={r} c={c} selected={selected === r.t}
            onSelect={() => onSelect(r.t)} watched={!!watchlist[r.t]}
            onToggleWatch={() => onToggleWatch(r.t)} hasNote={!!notes[r.t]}/>
        ))}
      </div>
    </div>
  );
}

function RowItem({ r, c, selected, onSelect, watched, onToggleWatch, hasNote, mobile }) {
  const extreme = Math.abs(r.bx) > 10;
  const tArrow = r.transition ? (r.transition.to === 'bullish' ? '↑' : r.transition.to === 'bearish' ? '↓' : '→') : null;
  return (
    <div onClick={onSelect}
      className={`group flex items-center px-3 ${mobile ? 'h-10' : 'h-8'} border-b border-zinc-900 cursor-pointer transition-colors ${
        selected ? 'bg-zinc-900 border-l-2 border-l-emerald-400' : 'active:bg-zinc-900 md:hover:bg-zinc-900/50'
      }`}>
      <div className="w-16 flex items-center gap-1.5">
        <button onClick={(e) => { e.stopPropagation(); onToggleWatch(); }}
          className={`${mobile || watched ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-opacity p-0.5 -ml-0.5`}>
          <Star className={`${mobile ? 'w-3 h-3' : 'w-2.5 h-2.5'} ${watched ? 'fill-amber-400 text-amber-400' : 'text-zinc-600'}`} />
        </button>
        <span className={`${mobile ? 'text-[12px]' : 'text-[11px]'} font-bold text-zinc-100 tracking-wider`}>{r.t}</span>
      </div>
      <span className={`w-14 text-right ${mobile ? 'text-[12px]' : 'text-[11px]'} font-bold ${c.text} ${extreme ? 'underline decoration-dotted underline-offset-2' : ''}`}>
        {r.bx >= 0 ? '+' : ''}{r.bx.toFixed(2)}
      </span>
      <div className="flex-1 text-right text-[9px] text-zinc-500 tabular-nums">
        <span>${r.px ? r.px.toFixed(2) : '—'}</span>
        <span className="ml-2 text-zinc-600">{r.vol ? r.vol.toFixed(1) : '—'}M</span>
      </div>
      <div className={`${mobile ? 'w-10' : 'w-12'} flex items-center justify-end gap-1`}>
        {hasNote && <StickyNote className="w-2.5 h-2.5 text-amber-400/60" />}
        {r.transition && (
          <span className={`text-[11px] font-bold ${r.transition.to === 'bullish' ? 'text-emerald-400' : r.transition.to === 'bearish' ? 'text-red-400' : 'text-amber-400'}`}>
            {tArrow}
          </span>
        )}
      </div>
    </div>
  );
}

function DetailPanel({ ticker, row, meta, interval, notes, setNotes, watchlist, onToggleWatch }) {
  const noteVal = notes[ticker] || '';
  const setNote = (v) => setNotes(n => ({ ...n, [ticker]: v }));
  const watched = !!watchlist[ticker];
  const bx = row?.bx;
  const prev = row?.prev;
  const zone = row?.zone;
  const zoneColor = zone === 'bullish' ? 'text-emerald-400' : zone === 'bearish' ? 'text-red-400' : 'text-amber-400';

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 h-14 border-b border-zinc-800 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-xl font-bold tracking-[0.15em] text-zinc-100">{ticker}</span>
          <div className="flex flex-col text-[9px] text-zinc-500 tracking-wider min-w-0">
            <span className="truncate">{meta.ex || '—'}</span>
            <span className="truncate">{meta.sec || '—'}</span>
          </div>
        </div>
        <button onClick={() => onToggleWatch(ticker)} className="p-1.5 border border-zinc-800 active:border-amber-500/50 md:hover:border-amber-500/50 flex-shrink-0">
          <Star className={`w-3.5 h-3.5 ${watched ? 'fill-amber-400 text-amber-400' : 'text-zinc-500'}`} />
        </button>
      </div>

      <div className="grid grid-cols-4 border-b border-zinc-800 text-[10px] flex-shrink-0">
        <Stat label="BX" value={bx != null ? `${bx >= 0 ? '+' : ''}${bx.toFixed(2)}` : '—'} valueClass={zoneColor} />
        <Stat label="PREV" value={prev != null ? `${prev >= 0 ? '+' : ''}${prev.toFixed(2)}` : '—'} />
        <Stat label="PX" value={meta.px ? `$${meta.px.toFixed(2)}` : '—'} />
        <Stat label="MCAP" value={meta.mc ? (meta.mc >= 1000 ? `$${(meta.mc/1000).toFixed(2)}T` : `$${meta.mc.toFixed(1)}B`) : '—'} />
      </div>

      {bx != null && (
        <div className="px-4 py-3 border-b border-zinc-800 flex-shrink-0">
          <div className="flex items-center justify-between text-[9px] text-zinc-600 tracking-wider mb-1">
            <span>−10</span><span>−2</span><span>0</span><span>+2</span><span>+10</span>
          </div>
          <div className="relative h-2 bg-zinc-900 overflow-hidden">
            <div className="absolute inset-y-0 left-0 w-[40%] bg-red-500/20" />
            <div className="absolute inset-y-0 left-[40%] w-[20%] bg-amber-500/20" />
            <div className="absolute inset-y-0 left-[60%] w-[40%] bg-emerald-500/20" />
            {prev != null && (
              <div className="absolute top-0 bottom-0 w-px bg-zinc-600"
                style={{ left: `${Math.max(0, Math.min(100, ((Math.max(-10, Math.min(10, prev)) + 10) / 20) * 100))}%` }}/>
            )}
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
      )}

      <div className="flex-1 min-h-0 border-b border-zinc-800 relative">
        <div className="absolute top-2 left-3 z-10 text-[9px] tracking-[0.3em] text-zinc-600 pointer-events-none">
          TRADINGVIEW · {interval}
        </div>
        {ticker && <TVChart ticker={ticker} interval={interval} meta={meta} />}
      </div>

      <div className="flex-shrink-0">
        <div className="flex items-center justify-between px-4 h-8 border-b border-zinc-800">
          <span className="text-[10px] tracking-[0.3em] text-zinc-500">NOTES</span>
          {noteVal && <span className="text-[9px] text-zinc-600">{noteVal.length} chars</span>}
        </div>
        <textarea value={noteVal} onChange={(e) => setNote(e.target.value)}
          placeholder={`Log your thesis on ${ticker}…  (LEAPS strike / expiry / entry trigger)`}
          className="w-full h-20 md:h-24 bg-zinc-950 text-zinc-200 text-[11px] px-4 py-2 resize-none focus:outline-none focus:bg-zinc-900/50"/>
      </div>
    </div>
  );
}

function Stat({ label, value, valueClass = 'text-zinc-100' }) {
  return (
    <div className="px-3 py-2 border-r border-zinc-800 last:border-r-0">
      <div className="text-[9px] text-zinc-600 tracking-[0.2em]">{label}</div>
      <div className={`text-[12px] font-bold mt-0.5 ${valueClass}`}>{value}</div>
    </div>
  );
}

function MobileFiltersDrawer({ mcBucket, setMcBucket, priceMin, setPriceMin, priceMax, setPriceMax, volMin, setVolMin, hasActiveFilters, onClear, onClose }) {
  return (
    <div className="md:hidden fixed inset-0 bg-black/70 flex items-end z-50" onClick={onClose}>
      <div className="w-full bg-zinc-950 border-t border-zinc-800 slide-up max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 h-12 border-b border-zinc-800 sticky top-0 bg-zinc-950">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="w-3.5 h-3.5 text-emerald-400" />
            <span className="text-[11px] tracking-[0.3em] font-bold text-emerald-400">FILTERS</span>
          </div>
          <button onClick={onClose} className="p-1.5"><X className="w-4 h-4 text-zinc-500" /></button>
        </div>

        <div className="p-4 space-y-5">
          <div>
            <div className="text-[10px] tracking-[0.3em] text-zinc-500 mb-2">MARKET CAP</div>
            <div className="grid grid-cols-2 gap-2">
              {MC_BUCKETS.map((b, i) => (
                <button key={b.label} onClick={() => setMcBucket(i)}
                  className={`px-3 py-2 border text-[11px] tracking-wider ${
                    mcBucket === i ? 'border-emerald-500 text-emerald-400 bg-emerald-500/5' : 'border-zinc-800 text-zinc-400 active:border-zinc-600'
                  }`}>
                  {MC_BUCKETS_LONG[i]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-[10px] tracking-[0.3em] text-zinc-500 mb-2">PRICE RANGE ($)</div>
            <div className="flex items-center gap-2">
              <input value={priceMin} onChange={e => setPriceMin(e.target.value)} placeholder="MIN" type="number" inputMode="decimal"
                className="flex-1 bg-zinc-900 border border-zinc-800 text-zinc-200 text-[12px] px-3 py-2 focus:outline-none focus:border-emerald-500 tracking-wider"/>
              <span className="text-zinc-700">–</span>
              <input value={priceMax} onChange={e => setPriceMax(e.target.value)} placeholder="MAX" type="number" inputMode="decimal"
                className="flex-1 bg-zinc-900 border border-zinc-800 text-zinc-200 text-[12px] px-3 py-2 focus:outline-none focus:border-emerald-500 tracking-wider"/>
            </div>
          </div>

          <div>
            <div className="text-[10px] tracking-[0.3em] text-zinc-500 mb-2">MIN VOLUME (MILLIONS)</div>
            <input value={volMin} onChange={e => setVolMin(e.target.value)} placeholder="0" type="number" inputMode="decimal"
              className="w-full bg-zinc-900 border border-zinc-800 text-zinc-200 text-[12px] px-3 py-2 focus:outline-none focus:border-emerald-500 tracking-wider"/>
          </div>
        </div>

        <div className="flex gap-2 p-4 border-t border-zinc-800 sticky bottom-0 bg-zinc-950">
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
    <div className="fixed inset-0 bg-black/60 flex items-start justify-end z-50" onClick={onClose}>
      <div className="w-full md:w-[480px] h-full bg-zinc-950 border-l border-zinc-800 flex flex-col slide-right" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 h-12 border-b border-zinc-800 flex-shrink-0">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-amber-400" />
            <span className="text-[11px] tracking-[0.3em] font-bold text-amber-400">ZONE.TRANSITIONS</span>
            <span className="text-[10px] text-zinc-500">({transitions.length})</span>
          </div>
          <button onClick={onClose} className="p-1.5 active:bg-zinc-900 md:hover:bg-zinc-900"><X className="w-4 h-4 text-zinc-500" /></button>
        </div>
        <div className="flex-1 overflow-y-auto col-scroll">
          {transitions.length === 0 ? (
            <div className="p-8 text-center text-[10px] text-zinc-600 tracking-wider">— NO ZONE TRANSITIONS SINCE LAST SCAN —</div>
          ) : transitions.sort((a, b) => Math.abs(b.bx - (b.prev ?? 0)) - Math.abs(a.bx - (a.prev ?? 0))).map(r => {
            const toClass = r.zone === 'bullish' ? 'text-emerald-400' : r.zone === 'bearish' ? 'text-red-400' : 'text-amber-400';
            return (
              <div key={r.t} onClick={() => onSelect(r.t)}
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
