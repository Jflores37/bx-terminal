// BX-Trender + Market Bias Scanner v6 -- TradeStation source, chunked + incremental.
// source=yahoo (default) | source=tradestation (Yahoo fallback per ticker, 429-aware shared backoff).
// Ticker selection (first match wins):
//   symbols=CSV                 explicit tickers (each must match SYMBOL_RE, else 400; max 200)
//   mode=fill                   active tickers with NO row at the expected scan_date, at most 200 (C5)
//   chunk=i&chunks=n            0-based slice i of the active universe ordered by ticker, size ceil(N/n), max 200 (C5)
//   offset=&limit=              legacy fixed slice (TS capped at 450); kept so old cron rows keep working
// Other params: timeframe (daily|weekly|monthly), dryrun=1.
// scan_date = last trading day of the last COMPLETED bar in the data (daily: session complete at 4:15 PM ET;
// weekly/monthly: in-progress period dropped, so the stored bar is always a finished week/month) -- em-7, C5.
// Results are upserted in batches of <=50 as they complete, and the run stops taking new tickers before the 150 s
// wall clock / 2 s CPU limits (vendor fetches end by 130 s, upserts by 146 s), so a slow or throttled run writes what
// it has and returns before the kill (em-1, db-1); mode=fill finishes it.
// Indicator math lives in ../_shared/bx_math.ts (shared with bx-backtest-builder).
// em-10: the live board uses TradeStation bars (520/520/420 back) with a per-ticker Yahoo fallback; the backtest uses
// Yahoo only (2y/10y/full monthly via period1/period2). The math is identical; residual differences come from
// vendor price adjustments and, for tickers with short history, from where each vendor's history starts.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireCron } from "../_shared/cron_auth.ts";
import { finishRun, startRun } from "../_shared/pipeline_log.ts";
import { getTsAccessToken } from "../_shared/ts_auth.ts";
import {
  BarIntegrityError, biasAt, type Bars, calendarPeriodEnd, cleanBars, completedBars, computeBX, expectedScanDay,
  isoDay, marketBiasSeries, nyClock, type NyClock, parseSymbols, type Timeframe, YF_INTERVAL, yahooChartUrl,
} from "../_shared/bx_math.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const TS_ENV = Deno.env.get("TRADESTATION_ENV") ?? "sim";
const TS_BASE = TS_ENV === "live" ? "https://api.tradestation.com/v3" : "https://sim-api.tradestation.com/v3";

const TS_UNIT: Record<Timeframe, string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" };
const TS_BB: Record<Timeframe, number> = { daily: 520, weekly: 520, monthly: 420 };
const TS_CHUNK_CAP = 450;        // legacy offset/limit cap
const MAX_PER_CALL = 200;        // chunk / fill cap (C5)
const MIN_BARS = 40;
const BATCH = 50;                // upsert batch size (C5: a killed worker loses at most one batch)
const START_DEADLINE_MS = 105_000;   // stop taking new tickers (wall clock limit is 150 s)
const HARD_DEADLINE_MS = 125_000;    // never start a 429 sleep that ends after this
const FETCH_END_MS = 130_000;        // every vendor fetch is cut off by here (timeouts shrink to fit)
const WRITE_END_MS = 146_000;        // ...and every upsert by here, so the run returns before the 150 s kill
const CPU_BUDGET_MS = 1_400;         // measured synchronous parse+compute time; CPU limit is 2 s
const TS_TIMEOUT_MS = 12_000, YF_TIMEOUT_MS = 10_000, DB_TIMEOUT_MS = 15_000;
const RETRY_AFTER_MAX_S = 30;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sbHeaders = (extra: Record<string, string> = {}) => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, ...extra });

type Ctx = { t0: number; cpuMs: number; pauseUntil: number; rateLimited: number; wrongGranularity: number };
const elapsed = (ctx: Ctx) => Date.now() - ctx.t0;
// Timeout for a request that must finish by `endMs` after t0; 0 = no time left, skip the request.
const budget = (ctx: Ctx, ms: number, endMs: number) => { const left = Math.min(ms, endMs - elapsed(ctx)); return left >= 1000 ? left : 0; };
function timed<T>(ctx: Ctx, f: () => T): T { const s = performance.now(); try { return f(); } finally { ctx.cpuMs += performance.now() - s; } }

async function fetchYahoo(ticker: string, tf: Timeframe, ctx: Ctx): Promise<Bars | null> {
  const url = yahooChartUrl(ticker, tf, Date.now());      // monthly uses period1/period2, never range=max (em-5)
  const to = budget(ctx, YF_TIMEOUT_MS, FETCH_END_MS);
  if (!to) return null;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 BXTerminal", Accept: "application/json" }, signal: AbortSignal.timeout(to) });
    if (!r.ok) { await r.body?.cancel(); return null; }
    const text = await r.text();
    return timed(ctx, () => {
      const res = JSON.parse(text)?.chart?.result?.[0];
      const g = res?.meta?.dataGranularity;
      if (g && g !== YF_INTERVAL[tf]) { ctx.wrongGranularity++; return null; }   // wrong interval can never be stored under tf
      const q = res?.indicators?.quote?.[0];
      if (!q || !Array.isArray(res?.timestamp)) return null;
      const b = cleanBars(res.timestamp, q.open ?? [], q.high ?? [], q.low ?? [], q.close ?? []);
      return b.closes.length >= MIN_BARS ? b : null;
    });
  } catch { return null; }
}

// em-15: a 429 sets a SHARED pause (all workers back off together); no sleep after the final attempt; a sleep that
// would cross the deadline is skipped and the ticker goes straight to the Yahoo fallback.
async function fetchTS(symbol: string, tf: Timeframe, token: string, ctx: Ctx): Promise<Bars | null> {
  const url = `${TS_BASE}/marketdata/barcharts/${encodeURIComponent(symbol)}?unit=${TS_UNIT[tf]}&interval=1&barsback=${TS_BB[tf]}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = ctx.pauseUntil - Date.now();
    if (wait > 0) {
      if (elapsed(ctx) + wait > HARD_DEADLINE_MS) return null;
      await sleep(wait);
    }
    const to = budget(ctx, TS_TIMEOUT_MS, FETCH_END_MS);
    if (!to) return null;
    let r: Response;
    try { r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(to) }); } catch { return null; }
    if (r.status === 429) {
      ctx.rateLimited++;
      await r.body?.cancel();
      if (attempt === 2) return null;
      const ra = parseInt(r.headers.get("Retry-After") ?? "20", 10);
      const waitS = Math.min(RETRY_AFTER_MAX_S, Math.max(1, Number.isNaN(ra) ? 20 : ra));
      if (elapsed(ctx) + waitS * 1000 > HARD_DEADLINE_MS) return null;
      ctx.pauseUntil = Math.max(ctx.pauseUntil, Date.now() + waitS * 1000);
      continue;
    }
    if (!r.ok) { await r.body?.cancel(); return null; }
    const text = await r.text().catch(() => "");
    return timed(ctx, () => {
      let j: { Bars?: Array<Record<string, unknown>> } | null = null;
      try { j = JSON.parse(text); } catch { return null; }
      const bars = j?.Bars ?? [];
      const ts = bars.map((x) => Date.parse(String(x.TimeStamp ?? "")) / 1000);
      const b = cleanBars(ts, bars.map((x) => x.Open), bars.map((x) => x.High), bars.map((x) => x.Low), bars.map((x) => x.Close));
      return b.closes.length >= MIN_BARS ? b : null;
    });
  }
  return null;
}

async function fetchUniverse(): Promise<string[]> {
  const PAGE = 1000; const all: string[] = []; let off = 0;
  for (;;) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/universe?select=ticker&active=eq.true&order=ticker.asc&limit=${PAGE}&offset=${off}`, { headers: sbHeaders(), signal: AbortSignal.timeout(DB_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`universe ${r.status}`);
    const page = await r.json() as Array<{ ticker: string }>;
    if (!page.length) break;
    all.push(...page.map((x) => x.ticker));
    if (page.length < PAGE) break; off += PAGE;
  }
  return all;
}
async function fetchScannedAt(tf: Timeframe, scanDate: string): Promise<Set<string>> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/bx_scans?select=ticker&timeframe=eq.${tf}&scan_date=eq.${scanDate}&limit=10000`, { headers: sbHeaders(), signal: AbortSignal.timeout(DB_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`bx_scans read ${r.status}`);
  return new Set((await r.json() as Array<{ ticker: string }>).map((x) => x.ticker));
}
async function upsertScans(rows: Array<Record<string, unknown>>, ctx: Ctx) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/bx_scans?on_conflict=ticker,timeframe,scan_date`, {
    method: "POST",
    headers: sbHeaders({ "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify(rows),
    signal: AbortSignal.timeout(budget(ctx, DB_TIMEOUT_MS, WRITE_END_MS) || 1000),
  });
  if (!r.ok) throw new Error(`write ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

type Sel = { mode: string; chunk?: number; chunks?: number; offset?: number; limit?: number; symbols?: string };

async function scan(tf: Timeframe, source: string, sel: Sel, dryrun: boolean, clock: NyClock, ctx: Ctx) {
  const expected = isoDay(expectedScanDay(tf, clock));
  let tickers: string[], universeTotal: number, truncated = false, nextOffset: number | null = null, hasMore = false;
  if (sel.symbols) {
    const list = parseSymbols(sel.symbols)!;   // validated in the handler
    tickers = list.slice(0, MAX_PER_CALL); truncated = list.length > MAX_PER_CALL;
    universeTotal = list.length;
  } else {
    const all = await fetchUniverse(); universeTotal = all.length;
    if (sel.mode === "fill") {
      const have = await fetchScannedAt(tf, expected);
      const missing = all.filter((t) => !have.has(t));
      tickers = missing.slice(0, MAX_PER_CALL); truncated = missing.length > MAX_PER_CALL; hasMore = truncated;
    } else if (sel.chunks) {
      const size = Math.ceil(all.length / sel.chunks);
      const slice = all.slice(sel.chunk! * size, (sel.chunk! + 1) * size);
      tickers = slice.slice(0, MAX_PER_CALL); truncated = slice.length > MAX_PER_CALL;
    } else {
      const off = sel.offset ?? 0, lim = sel.limit ?? 99999;
      const eff = source === "tradestation" ? Math.min(lim, TS_CHUNK_CAP) : lim;
      tickers = all.slice(off, off + eff);
      nextOffset = off + tickers.length; hasMore = nextOffset < universeTotal;
    }
  }

  let token: string | null = null, tsAuthError: string | null = null;
  if (source === "tradestation" && tickers.length > 0) {   // nothing to scan (e.g. a complete fill pass): no token call
    try { token = await getTsAccessToken(); } catch (e) { tsAuthError = String(e); }   // em-14: fall back to Yahoo, don't 500
  }

  let ok = 0, fail = 0, biasOk = 0, fellBack = 0, integrity = 0, notStarted = 0, rowsWritten = 0, writeErrors = 0;
  let lastWriteError: string | null = null;
  const scanDates = new Map<string, number>();
  const sample: Array<Record<string, unknown>> = [];
  let buf: Array<Record<string, unknown>> = [];
  let chain: Promise<void> = Promise.resolve();
  const flush = () => {
    if (!buf.length) return;
    const rows = buf; buf = [];
    if (dryrun) return;
    chain = chain.then(() => upsertScans(rows, ctx)).then(() => { rowsWritten += rows.length; })
      .catch((e) => { writeErrors += rows.length; lastWriteError = String(e).slice(0, 300); });
  };

  const POOL = source === "tradestation" ? 10 : 16;
  let idx = 0;
  async function worker() {
    while (idx < tickers.length) {
      if (elapsed(ctx) > START_DEADLINE_MS || ctx.cpuMs > CPU_BUDGET_MS) break;
      const t = tickers[idx++];
      let raw: Bars | null = null;
      if (token) { raw = await fetchTS(t, tf, token, ctx); if (!raw) { raw = await fetchYahoo(t, tf, ctx); if (raw) fellBack++; } }
      else raw = await fetchYahoo(t, tf, ctx);
      if (!raw) { fail++; continue; }
      const row = timed(ctx, () => {
        let bars;
        try { bars = completedBars(tf, raw!, clock).bars; } catch (e) { if (e instanceof BarIntegrityError) integrity++; return null; }
        const n = bars.closes.length;
        if (n < MIN_BARS) return null;
        const bx = computeBX(bars.closes);
        const last = bx[n - 1], prev = bx[n - 2];
        if (Number.isNaN(last) || Number.isNaN(prev)) return null;
        const bias = n > 198 ? biasAt(marketBiasSeries(bars.opens, bars.highs, bars.lows, bars.closes), bars.closes, n - 1) : null;
        if (bias) biasOk++;
        const scanDate = isoDay(calendarPeriodEnd(tf, bars.days[n - 1]));
        return { ticker: t, timeframe: tf, bx: Math.round(last * 100) / 100, prev_bx: Math.round(prev * 100) / 100, scan_date: scanDate, bias_direction: bias?.direction ?? null, bias_oscillator: bias?.oscillator ?? null, bias_in_zone: bias?.in_zone ?? null };
      });
      if (!row) { fail++; continue; }
      ok++;
      scanDates.set(row.scan_date, (scanDates.get(row.scan_date) ?? 0) + 1);
      if (sample.length < 10) sample.push(row);
      buf.push(row);
      if (buf.length >= BATCH) flush();
    }
  }
  await Promise.all(Array.from({ length: Math.min(POOL, Math.max(1, tickers.length)) }, () => worker()));
  notStarted = tickers.length - idx;
  flush();
  await chain;

  let topDate = expected, topN = -1;
  for (const [d, k] of scanDates) if (k > topN) { topDate = d; topN = k; }
  return {
    source, timeframe: tf, mode: sel.mode, chunk: sel.chunk ?? null, chunks: sel.chunks ?? null,
    offset: sel.offset ?? null, requested: sel.limit ?? null, processed: idx, selected: tickers.length, universe_total: universeTotal,
    ok, fail, integrity_rejected: integrity, yahoo_wrong_granularity: ctx.wrongGranularity, fell_back: fellBack, bias_ok: biasOk, rate_limited: ctx.rateLimited,
    not_started: notStarted, truncated, dryrun, scan_date: topDate, expected_scan_date: expected,
    scan_dates: Object.fromEntries(scanDates), rows_written: rowsWritten, write_errors: writeErrors, last_write_error: lastWriteError,
    ts_auth_error: tsAuthError, cpu_ms_est: Math.round(ctx.cpuMs),
    next_offset: nextOffset, has_more: hasMore || notStarted > 0, sample,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const intParam = (u: URL, k: string) => { const v = u.searchParams.get(k); if (v == null || v === "") return undefined; const n = parseInt(v, 10); return Number.isFinite(n) ? n : NaN; };

Deno.serve(async (req) => {
  const denied = requireCron(req);
  if (denied) return denied;
  const ctx: Ctx = { t0: Date.now(), cpuMs: 0, pauseUntil: 0, rateLimited: 0, wrongGranularity: 0 };
  const u = new URL(req.url);
  const tf = (u.searchParams.get("timeframe") ?? "weekly").toLowerCase() as Timeframe;
  if (!(tf in YF_INTERVAL)) return json({ error: "invalid timeframe" }, 400);
  const source = (u.searchParams.get("source") ?? "yahoo").toLowerCase();
  const dryrun = u.searchParams.get("dryrun") === "1";
  const symbols = u.searchParams.get("symbols") ?? undefined;
  if (symbols && !parseSymbols(symbols)) return json({ error: "symbols must be a CSV of tickers matching [A-Z0-9.$^/-]{1,20}" }, 400);
  const chunk = intParam(u, "chunk"), chunks = intParam(u, "chunks");
  const sel: Sel = { mode: "offset", symbols };
  if (symbols) sel.mode = "symbols";
  else if (u.searchParams.get("mode") === "fill") sel.mode = "fill";
  else if (chunk !== undefined || chunks !== undefined) {
    if (!Number.isInteger(chunk) || !Number.isInteger(chunks) || chunks! < 1 || chunks! > 100 || chunk! < 0 || chunk! >= chunks!) {
      return json({ error: "chunk/chunks must be integers with 0 <= chunk < chunks <= 100" }, 400);
    }
    Object.assign(sel, { mode: "chunk", chunk, chunks });
  } else {
    sel.offset = Math.max(0, intParam(u, "offset") || 0);
    sel.limit = Math.max(1, intParam(u, "limit") || 99999);
  }
  const runId = await startRun("bx-scan", { timeframe: tf, source, mode: sel.mode, chunk: sel.chunk, chunks: sel.chunks, offset: sel.offset, limit: sel.limit, symbols: symbols ? parseSymbols(symbols)!.length : undefined, dryrun });
  try {
    const s = await scan(tf, source, sel, dryrun, nyClock(Date.now()), ctx);
    const failed = s.fail + s.not_started + s.write_errors;
    // A fill pass selects exactly the tickers the chunk runs could not scan, so after a good day it holds only the
    // unscannable ones (new listings with < MIN_BARS bars, halted/delisted names still active) and every one fails.
    // That is 'partial', not 'error' -- otherwise pipeline_health's last_run:bx-scan sits at 'warn' after every fill.
    // An outage still shows as 'error' on the chunk runs; failed writes are 'error' in every mode.
    const allFailed = s.selected > 0 && s.ok === 0 && sel.mode !== "fill";
    const writesFailed = s.write_errors > 0 && s.rows_written === 0;
    const status = allFailed || writesFailed ? "error" : (failed > 0 || s.truncated || s.ts_auth_error) ? "partial" : "ok";
    await finishRun(runId, {
      status, rows_written: s.rows_written, rows_expected: s.selected,
      error: [s.ts_auth_error, s.last_write_error, s.not_started ? `${s.not_started} not started (time/CPU budget)` : null].filter(Boolean).join("; ") || undefined,
    });
    return json({ ...s, run_status: status, elapsed_ms: elapsed(ctx) });
  } catch (err) {
    await finishRun(runId, { status: "error", error: String(err) });
    return json({ error: String(err) }, 500);
  }
});
