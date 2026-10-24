// bx-earnings-sync v4 — NASDAQ calendar, rate-limit-hardened (low concurrency + retry/backoff).
// v4: cron auth (C1) + run log (C3). A failed date fetch is no longer counted as "no earnings that day":
// failed dates are retried in a slower second pass, and anything still failing makes the run 'partial'
// (or 'error' with no writes when more than half the window failed, i.e. we are probably blocked).
//
// Earnings-date precedence (see bx-finviz-sync for the full note): Finviz is PRIMARY and runs every
// weekday; this NASDAQ sync only FILLS GAPS, i.e. it never overwrites a current date whose
// next_earnings_source is 'finviz', so the two sources never flip-flop the same ticker. Dates it wrote
// itself ('nasdaq') are refreshed on every run.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { requireCron } from '../_shared/cron_auth.ts';
import { finishRun, startRun } from '../_shared/pipeline_log.ts';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEADLINE_MS = 115_000;      // edge wall clock is 150 s; leave room for the writes
const MAX_FAIL_SHARE = 0.5;

// Returns the day's rows ([] = genuinely no earnings that day, incl. NASDAQ's 1002 "No record found") or null when the fetch failed.
// No new attempt starts after deadlineAt, and each attempt times out after 10 s (bounded wall clock).
async function fetchEarningsForDate(dateIso, deadlineAt){
  const url = `https://api.nasdaq.com/api/calendar/earnings?date=${dateIso}`;
  for (let attempt = 0; attempt < 4 && Date.now() < deadlineAt; attempt++){
    try {
      const r = await fetch(url, { headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.nasdaq.com/',
      }, signal: AbortSignal.timeout(10_000) });
      if (r.status === 429 || r.status === 403 || r.status >= 500) { await r.body?.cancel(); await sleep(1200 * (attempt + 1)); continue; }
      if (!r.ok) { await r.body?.cancel(); return null; }
      const j = await r.json();
      // Empty day = rCode 200 with data.rows null/[] (e.g. weekends), or rCode 200 with data null and
      // bCodeMessage code 1002 "No record found" (days with no earnings, incl. everything past NASDAQ's
      // ~8-week horizon). Anything else (non-200 rCode, unrecognized body) is retried, then a failure.
      if (j?.status?.rCode === 200 && j?.data == null && (j.status.bCodeMessage ?? []).some((m) => m?.code === 1002)) return [];
      if (j?.status?.rCode !== 200 || !j?.data) { await sleep(1200 * (attempt + 1)); continue; }
      const rows = j.data.rows;
      return Array.isArray(rows) ? rows : [];
    } catch { await sleep(1200 * (attempt + 1)); }
  }
  return null;
}
async function getActiveTickers(){
  const PAGE = 1000; const all = []; let off = 0;
  for (;;){
    const r = await fetch(`${SUPABASE_URL}/rest/v1/universe?select=ticker&active=eq.true&order=ticker.asc&limit=${PAGE}&offset=${off}`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
    if (!r.ok) throw new Error(`tickers ${r.status}`);
    const page = await r.json();
    if (!page.length) break;
    all.push(...page.map((p) => p.ticker));
    if (page.length < PAGE) break; off += PAGE;
  }
  return new Set(all);
}
// Tickers holding a current (>= today) date that came from Finviz: Finviz owns those, so we skip them.
async function getTickersWithCurrentDate(todayIso){
  const PAGE = 1000; const all = []; let off = 0;
  for (;;){
    const r = await fetch(`${SUPABASE_URL}/rest/v1/ticker_meta?select=ticker&next_earnings_date=gte.${todayIso}&next_earnings_source=eq.finviz&order=ticker.asc&limit=${PAGE}&offset=${off}`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
    if (!r.ok) throw new Error(`current dates ${r.status}`);
    const page = await r.json();
    if (!page.length) break;
    all.push(...page.map((p) => p.ticker));
    if (page.length < PAGE) break; off += PAGE;
  }
  return new Set(all);
}
async function clearPastEarnings(todayIso){
  const r = await fetch(`${SUPABASE_URL}/rest/v1/ticker_meta?next_earnings_date=lt.${todayIso}&select=ticker`, { method: 'PATCH', headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ next_earnings_date: null, next_earnings_source: null }) });
  if (!r.ok) throw new Error(`clear past earnings ${r.status}: ${(await r.text()).slice(0,200)}`);
  return (await r.json()).length;
}
async function bulkUpsert(rows){
  for (let i = 0; i < rows.length; i += 500){
    const slice = rows.slice(i, i + 500);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/ticker_meta?on_conflict=ticker`, { method: 'POST', headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(slice) });
    if (!r.ok) throw new Error(`upsert ${r.status}: ${(await r.text()).slice(0,200)}`);
  }
}
function addDays(d, n){ const r = new Date(d); r.setUTCDate(r.getUTCDate() + n); return r; }
function toIso(d){ return d.toISOString().slice(0, 10); }
// Today's date in America/New_York as YYYY-MM-DD (C9).
function nyToday(){ return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }

Deno.serve(async (req) => {
  const denied = requireCron(req);
  if (denied) return denied;
  const runId = await startRun('bx-earnings-sync', {});
  const start = Date.now();
  try {
    const tickers = await getActiveTickers();
    const todayIso = nyToday();
    const today = new Date(`${todayIso}T00:00:00Z`);
    const dates = [];
    for (let i = 0; i < 90; i++) dates.push(toIso(addDays(today, i)));

    const earliest = {};
    let totalRowsSeen = 0, emptyDates = 0;
    const failed = new Set();
    const timeLeft = () => Date.now() - start < DEADLINE_MS;
    const record = (d, rows) => {
      if (rows.length === 0) emptyDates++;
      totalRowsSeen += rows.length;
      for (const row of rows){
        const sym = row.symbol?.toUpperCase().trim();
        if (!sym || !tickers.has(sym)) continue;
        if (!(sym in earliest) || d < earliest[sym]) earliest[sym] = d;
      }
    };
    const POOL = 2;
    let idx = 0;
    async function worker(){
      while (idx < dates.length){
        const d = dates[idx++];
        if (!timeLeft()) { failed.add(d); continue; }
        const rows = await fetchEarningsForDate(d, start + DEADLINE_MS);
        if (rows === null) failed.add(d); else record(d, rows);
        await sleep(220);
      }
    }
    await Promise.all(Array.from({ length: POOL }, () => worker()));

    // Second pass: retry failed dates one at a time with a longer gap, while time allows
    // (give up after 5 straight failures: we are blocked, not unlucky).
    let streak = 0;
    for (const d of [...failed].sort()){
      if (!timeLeft() || streak >= 5) break;
      await sleep(1500);
      const rows = await fetchEarningsForDate(d, start + DEADLINE_MS);
      if (rows !== null){ failed.delete(d); record(d, rows); streak = 0; } else streak++;
    }
    const failedDates = [...failed].sort();
    const failShare = failedDates.length / dates.length;

    if (failShare > MAX_FAIL_SHARE){
      const error = `${failedDates.length}/${dates.length} NASDAQ dates failed (probably rate-limited/blocked); nothing written`;
      await finishRun(runId, { status: 'error', rows_written: 0, error });
      return new Response(JSON.stringify({ error, failed_dates: failedDates, elapsed_ms: Date.now() - start }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    const pastCleared = await clearPastEarnings(todayIso);
    const owned = await getTickersWithCurrentDate(todayIso);
    const updates = Object.entries(earliest)
      .filter(([ticker]) => !owned.has(ticker))
      .map(([ticker, next_earnings_date]) => ({ ticker, next_earnings_date, next_earnings_source: 'nasdaq' }));
    if (updates.length > 0) await bulkUpsert(updates);

    const status = failedDates.length ? 'partial' : 'ok';
    await finishRun(runId, {
      status, rows_written: updates.length,
      error: failedDates.length ? `${failedDates.length} NASDAQ dates failed after retry: ${failedDates.join(',')}` : undefined,
    });
    return new Response(JSON.stringify({
      success: true, status, universe_size: tickers.size, days_scanned: dates.length - failedDates.length,
      nasdaq_rows_seen: totalRowsSeen, empty_dates: emptyDates, failed_dates: failedDates,
      tickers_with_earnings: Object.keys(earliest).length, skipped_finviz_owned: Object.keys(earliest).length - updates.length,
      gap_filled: updates.length, past_cleared: pastCleared, elapsed_ms: Date.now() - start,
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    await finishRun(runId, { status: 'error', error: String(err) });
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});
