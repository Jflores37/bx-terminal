// bx-finviz-sync v4 — adds reliable earnings dates from Finviz (col 68), additive.
// v4: cron auth (C1) + run log (C3); a '-' / empty cell never overwrites a stored value with null
// (null fields are omitted and rows are upserted grouped by key set, so PostgREST never sees mixed keys);
// header drift and earnings sub-call failures make the run 'partial' instead of a silent success;
// stored next_earnings_date values that have passed are cleared; the Finviz token comes from edge secret
// FINVIZ_AUTH_TOKEN (app_settings.finviz_auth_token is only a flagged transition fallback).
//
// Earnings-date precedence (shared with bx-earnings-sync):
//   1. Finviz (this function, every run) is PRIMARY: any future date it reports overwrites the stored date
//      and stamps ticker_meta.next_earnings_source = 'finviz'.
//   2. NASDAQ (bx-earnings-sync) only FILLS GAPS: it never overwrites a current 'finviz' date; it writes
//      tickers with no current date (or a current date it wrote itself) and stamps 'nasdaq'.
//   3. Both write only dates >= today in America/New_York, and both clear stored dates < that today
//      (a passed date is never a "next" earnings date; a newer one has already been written by step 1/2).
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { requireCron } from '../_shared/cron_auth.ts';
import { finishRun, startRun } from '../_shared/pipeline_log.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const DQ = String.fromCharCode(34), NL = String.fromCharCode(10), CR = String.fromCharCode(13);
const EXPECTED_HEADERS = ['Market Cap','Price','Avg Volume','Sector','Industry'];
const MAX_NULL_SHARE = 0.2;   // more nulls than this in a field = probable format/header drift

async function getSetting(key){
  const r = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.${key}&select=value`, { headers:{ apikey:SERVICE_KEY, Authorization:`Bearer ${SERVICE_KEY}` } });
  if(!r.ok) throw new Error(`settings ${r.status}`);
  const rows = await r.json();
  if(!rows.length) throw new Error(`setting ${key} not found`);
  return rows[0].value;
}
function parseMarketCap(s){ if(!s||s==='-')return null; s=s.replace(/,/g,'').trim(); if(!s)return null; const last=s.slice(-1).toUpperCase(); const num=parseFloat(s); if(isNaN(num))return null; if(last==='B')return num; if(last==='M')return num/1000; if(last==='K')return num/1000000; return num/1000; }
function parseVolume(s){ if(!s||s==='-')return null; s=s.replace(/,/g,'').trim(); if(!s)return null; const last=s.slice(-1).toUpperCase(); const num=parseFloat(s); if(isNaN(num))return null; if(last==='B')return num*1000; if(last==='M')return num; if(last==='K')return num/1000; return num/1000000; }
function parsePrice(s){ if(!s||s==='-')return null; const n=parseFloat(s.replace(/,/g,'')); return isNaN(n)?null:n; }
function parseText(s){ return (!s||s==='-') ? null : s; }
function parseEarnings(s){ if(!s||s==='-')return null; const dp=s.trim().split(' ')[0]; const p=dp.split('/'); if(p.length!==3)return null; const yy=p[2]; if(yy.length!==4)return null; return `${yy}-${p[0].padStart(2,'0')}-${p[1].padStart(2,'0')}`; }
function parseCSV(text){ const rows=[]; let cur='',row=[],q=false; for(let i=0;i<text.length;i++){ const ch=text[i]; if(q){ if(ch===DQ&&text[i+1]===DQ){cur+=DQ;i++;} else if(ch===DQ){q=false;} else {cur+=ch;} } else { if(ch===DQ){q=true;} else if(ch===','){row.push(cur);cur='';} else if(ch===NL||ch===CR){ if(cur||row.length){row.push(cur);rows.push(row);} cur='';row=[]; if(ch===CR&&text[i+1]===NL)i++; } else {cur+=ch;} } } if(cur||row.length){row.push(cur);rows.push(row);} return rows; }
// Today's date in America/New_York as YYYY-MM-DD (C9).
function nyToday(){ return new Intl.DateTimeFormat('en-CA', { timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date()); }
// Belt and braces: strip the Finviz token (raw and URL-encoded) from anything logged or returned.
function redact(s, token){ s = String(s); if(token){ s = s.replaceAll(token, '[redacted]').replaceAll(encodeURIComponent(token), '[redacted]'); } return s; }
async function fetchFinviz(token, filter, cols){
  const c = cols ? `&c=${cols}` : '';
  const url = `https://elite.finviz.com/export.ashx?v=152&f=${filter}${c}&auth=${token}`;
  // A network-level fetch error's message contains the full URL (and so the auth token): never pass it on.
  let r;
  try{ r = await fetch(url, { headers:{ 'User-Agent':'Mozilla/5.0 BX-Terminal' }, signal: AbortSignal.timeout(45_000) }); }
  catch(e){ throw new Error(`finviz fetch failed: ${e?.name ?? 'error'}${e?.name === 'TimeoutError' ? '' : ' (network)'}`); }
  if(!r.ok) throw new Error(`finviz ${r.status}`);
  const csv = await r.text();
  // A login/error page is HTML; sniff only the start of the body so a company name containing 'login'
  // can't abort the sync. Anything else that isn't the CSV fails the Ticker-header check below.
  const head = csv.trimStart().slice(0, 200).toLowerCase();
  if(head.startsWith('<') || head.includes('<html')) throw new Error('finviz html/login');
  const rows = parseCSV(csv);
  if(rows.length<2) throw new Error(`finviz rows ${rows.length}`);
  const headers = rows[0].map((h)=>h.trim());
  if(!headers.includes('Ticker')) throw new Error(`finviz header drift: no Ticker column (got ${headers.slice(0,12).join('|')})`);
  return rows.slice(1).map((row)=>{ const o={}; headers.forEach((h,i)=>{ o[h]=(row[i]??'').trim(); }); return o; });
}
async function upsertMeta(rows){
  // PostgREST bulk inserts need identical keys per request (PGRST102), so group rows by key set.
  const groups = new Map();
  for(const row of rows){ const k=Object.keys(row).sort().join(','); if(!groups.has(k)) groups.set(k, []); groups.get(k).push(row); }
  for(const group of groups.values()){
    for(let i=0;i<group.length;i+=500){
      const slice = group.slice(i,i+500);
      const r = await fetch(`${SUPABASE_URL}/rest/v1/ticker_meta?on_conflict=ticker`, { method:'POST', headers:{ apikey:SERVICE_KEY, Authorization:`Bearer ${SERVICE_KEY}`, 'Content-Type':'application/json', Prefer:'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(slice) });
      if(!r.ok) throw new Error(`meta upsert ${r.status}: ${(await r.text()).slice(0,200)}`);
    }
  }
}
// Null out stored next_earnings_date values that have passed. Returns the number cleared.
async function clearPastEarnings(todayIso){
  const r = await fetch(`${SUPABASE_URL}/rest/v1/ticker_meta?next_earnings_date=lt.${todayIso}&select=ticker`, { method:'PATCH', headers:{ apikey:SERVICE_KEY, Authorization:`Bearer ${SERVICE_KEY}`, 'Content-Type':'application/json', Prefer:'return=representation' }, body: JSON.stringify({ next_earnings_date:null, next_earnings_source:null }) });
  if(!r.ok) throw new Error(`clear past earnings ${r.status}: ${(await r.text()).slice(0,200)}`);
  return (await r.json()).length;
}
async function syncUniverse(tickers){
  const rows = tickers.map((t)=>({ ticker:t, active:true }));
  for(let i=0;i<rows.length;i+=500){
    const slice = rows.slice(i,i+500);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/universe?on_conflict=ticker`, { method:'POST', headers:{ apikey:SERVICE_KEY, Authorization:`Bearer ${SERVICE_KEY}`, 'Content-Type':'application/json', Prefer:'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(slice) });
    if(!r.ok) throw new Error(`universe upsert ${r.status}`);
  }
  return { activated: tickers.length };
}
Deno.serve(async (req)=>{
  const denied = requireCron(req);
  if(denied) return denied;
  const runId = await startRun('bx-finviz-sync', {});
  const start=Date.now();
  let token = '';
  try{
    const warnings = [];
    // The Finviz token is an edge secret (FINVIZ_AUTH_TOKEN). The legacy app_settings row is read only as a
    // transition fallback (flagged, so the run is 'partial' until the secret is set and the row is removed).
    token = Deno.env.get('FINVIZ_AUTH_TOKEN') ?? '';
    if(!token){
      try{ token = await getSetting('finviz_auth_token'); }
      catch(e){ throw new Error(`FINVIZ_AUTH_TOKEN not configured (app_settings fallback: ${e?.message ?? e})`); }
      warnings.push('finviz token read from app_settings; set edge secret FINVIZ_AUTH_TOKEN and delete the app_settings row');
    }
    const filter = await getSetting('finviz_filter');
    const rows = await fetchFinviz(token, filter, null);
    const present = new Set(Object.keys(rows[0] ?? {}));
    const missing = EXPECTED_HEADERS.filter((h)=>!present.has(h) && !(h==='Avg Volume' && present.has('Volume')));
    if(missing.length) warnings.push(`finviz header drift: missing ${missing.join(', ')}`);
    const now = new Date().toISOString();
    const parsed = rows.map((r)=>({
      ticker: r['Ticker'],
      market_cap_billions: parseMarketCap(r['Market Cap'] ?? ''),
      price: parsePrice(r['Price'] ?? ''),
      avg_volume_millions: parseVolume(r['Avg Volume'] ?? r['Volume'] ?? ''),
      sector: parseText(r['Sector']),
      industry: parseText(r['Industry']),
    })).filter((r)=>r.ticker);
    for(const f of ['market_cap_billions','price','avg_volume_millions','sector','industry']){
      const nulls = parsed.filter((r)=>r[f]==null).length;
      if(parsed.length && nulls/parsed.length > MAX_NULL_SHARE) warnings.push(`${f}: ${nulls}/${parsed.length} empty (kept stored values)`);
    }
    // Omit null fields: merge-duplicates then leaves the stored value untouched. updated_at is always
    // sent (reconcile_universe counts rows refreshed in the last 30 min).
    const meta = parsed.map((r)=>{ const o={ ticker:r.ticker, updated_at:now }; for(const [k,v] of Object.entries(r)) if(k!=='ticker' && v!=null) o[k]=v; return o; });
    const tickers = meta.map((m)=>m.ticker);
    await upsertMeta(meta);
    const universeResult = await syncUniverse(tickers);
    // Earnings: separate focused call (Ticker + Earnings Date), future-only (see precedence above).
    const todayIso = nyToday();
    let earnRows = [];
    let earningsError = null;
    try{
      const erows = await fetchFinviz(token, filter, '1,68');
      if(erows.length && !('Earnings Date' in erows[0])) throw new Error('finviz header drift: no Earnings Date column');
      for(const e of erows){ const t=e['Ticker']; const iso=parseEarnings(e['Earnings Date']); if(t && iso && iso >= todayIso) earnRows.push({ ticker:t, next_earnings_date:iso, next_earnings_source:'finviz' }); }
      if(earnRows.length) await upsertMeta(earnRows);
    }catch(e){ earnRows = []; earningsError = redact(e, token); warnings.push(`earnings: ${earningsError}`); }
    let earningsCleared = null;
    try{ earningsCleared = await clearPastEarnings(todayIso); }
    catch(e){ warnings.push(redact(e, token)); }
    const status = warnings.length ? 'partial' : 'ok';
    await finishRun(runId, { status, rows_written: meta.length, rows_expected: rows.length, error: warnings.length ? warnings.join('; ') : undefined });
    return new Response(JSON.stringify({ success:true, status, finviz_rows:rows.length, universe_size:universeResult.activated, earnings_future_set:earnRows.length, earnings_error:earningsError, earnings_past_cleared:earningsCleared, warnings, sample:meta.slice(0,3), elapsed_ms:Date.now()-start }), { headers:{ 'Content-Type':'application/json' } });
  }catch(err){
    const msg = redact(err, token);
    await finishRun(runId, { status:'error', error:msg });
    return new Response(JSON.stringify({ error:msg }), { status:500, headers:{ 'Content-Type':'application/json' } });
  }
});
