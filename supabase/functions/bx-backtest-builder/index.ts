// bx-backtest-builder v5 -- multi-timeframe alignment, chunked, per-ticker replace + baseline.
//   At each zone-change signal it records the Market Bias direction AND BX of daily/weekly/monthly AS-OF the signal
//   (mtf_*). Fetches all 3 timeframes per ticker from Yahoo (sequential per worker to cap concurrency at POOL).
// Params: timeframe (daily|weekly|monthly), chunk=i&chunks=n (0-based slice of the active universe ordered by ticker,
//   size ceil(N/n), C6), dryrun=1, symbols=CSV. Legacy offset/limit still accepted. Max MAX_TICKERS per call; the run
//   also stops taking new tickers before the 150 s wall clock / 2 s CPU limits (em-2, db-4).
// Correctness (v5):
//   - Only COMPLETED bars are used: the in-progress day/week/month is dropped, so it never produces a signal (em-4).
//   - signal_date = LAST trading day of the signal bar's period (daily = that day); price_at_signal = that bar's close
//     (em-9). Period ends come from the daily bars when the daily history covers the period, else from the NYSE
//     calendar in ../_shared/bx_math.ts (older weekly/monthly periods; exact except for unscheduled closures not in
//     its list, where the label can only be later than the truth, never earlier).
//   - MTF columns use the last higher-timeframe bar whose period ENDED at or before the signal bar's period end:
//     no look-ahead (em-3). mtf_daily for a weekly/monthly signal is the period's last session.
//   - Hard asserts (em-5): Yahoo dataGranularity must equal the requested interval; one bar per period with a cadence
//     that fits the timeframe; every row's signal_date is a weekday inside its own bar's period (monthly: day >= 15);
//     (signal_type, signal_date) unique per ticker. Any violation rejects the whole ticker (nothing written).
//   - A transient Yahoo failure (429/5xx/other non-2xx, timeout, network) on ANY timeframe fails the ticker before
//     anything is written (fetch_failed), so stored MTF columns are never overwritten with NULL; only a 404 / empty
//     result, or a secondary series failing integrity (secondary_rejected, run = partial), counts as missing data.
//   - Writes per ticker: upsert the signal rows, then delete this ticker+timeframe's rows dated inside the rebuilt
//     window whose key is not in the new set (removes phantom / mislabeled rows), then upsert the baseline row (C6:
//     every completed bar, outlier rule v1). Window: monthly = whole history; daily/weekly = from the first
//     signal-capable bar (older v5 rows are kept; older pre-v5 rows, computed_at < V5_EPOCH, are deleted because
//     no v5 run can reproduce or relabel them). A ticker with fewer than MIN_BARS completed bars has no signals: all
//     its rows for the timeframe are deleted (its baseline row still counts its completed bars).
//   - ret_5d/20d/60d/120d (and price_*d) are BAR offsets: weeks/months on weekly/monthly. The column names are
//     historical; labelling them as bars is a frontend fix (em-11).
//   - Source (em-10): Yahoo only (daily 2y, weekly 10y, monthly full history via period1/period2 -- never
//     range=max, which Yahoo downgrades to 3mo/1wk bars). The live board (bx-scan) uses TradeStation with a
//     Yahoo fallback; the math is shared, so differences come only from vendor adjustments / history start.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireCron } from "../_shared/cron_auth.ts";
import { finishRun, startRun } from "../_shared/pipeline_log.ts";
import {
  asOfIndex, BarIntegrityError, type Bars, baselineAggregate, biasAt, type BiasSeries, cleanBars, completedBars,
  computeBX, dayOfMonth, detectSignals, dow, forwardReturn, HORIZONS, isoDay, marketBiasSeries, nyClock, type NyClock,
  parseSymbols, periodEnds, periodStart, r2, type Timeframe, YF_INTERVAL, yahooChartUrl,
} from "../_shared/bx_math.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MIN_BARS = 60;
const MIN_IDX = 35;                    // signals at i > 35 (bx is first defined at index 34)
const MAX_TICKERS = 120;               // per invocation (CPU ~3.6 ms/ticker measured; 2 s limit)
const POOL = 10;
const START_DEADLINE_MS = 90_000;      // stop taking new tickers (wall clock limit 150 s)
const CPU_BUDGET_MS = 1_300;           // measured synchronous parse+compute time; CPU limit 2 s
const YF_TIMEOUT_MS = 8_000, DB_TIMEOUT_MS = 10_000;
const RETRY_BACKOFF_MS = 2_000, RETRY_DEADLINE_MS = 95_000;   // one retry of a 429/5xx, only while time allows

type Ctx = { t0: number; cpuMs: number };
function timed<T>(ctx: Ctx, f: () => T): T { const s = performance.now(); try { return f(); } finally { ctx.cpuMs += performance.now() - s; } }
const sbHeaders = (extra: Record<string, string> = {}) => ({ "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}`, ...extra });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Transient fetch failure (429, other non-2xx except 404, timeout, network error, unparseable body). On ANY timeframe
// it fails the ticker before anything is written, so a throttled secondary series can never overwrite stored MTF
// columns with NULL. null is returned only for genuinely absent data (404 / empty result / no timestamps).
class FetchError extends Error {}

async function fetchHistory(ticker: string, tf: Timeframe, ctx: Ctx): Promise<Bars | null> {
  const url = yahooChartUrl(ticker, tf, Date.now());      // monthly uses period1/period2, never range=max (em-5)
  for (let attempt = 0; ; attempt++) {
    let r: Response;
    try {
      r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 BXTerminal" }, signal: AbortSignal.timeout(YF_TIMEOUT_MS) });
    } catch (e) { throw new FetchError(`${tf} fetch: ${String(e).slice(0, 80)}`); }
    if (r.status === 404) { await r.body?.cancel(); return null; }   // unknown / delisted symbol: no history
    if (!r.ok) {
      await r.body?.cancel();
      if ((r.status === 429 || r.status >= 500) && attempt === 0 && Date.now() - ctx.t0 < RETRY_DEADLINE_MS) {
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      throw new FetchError(`${tf} yahoo ${r.status}`);
    }
    let text: string;
    try { text = await r.text(); } catch (e) { throw new FetchError(`${tf} body: ${String(e).slice(0, 80)}`); }
    return timed(ctx, () => {
      // deno-lint-ignore no-explicit-any
      let j: any;
      try { j = JSON.parse(text); } catch { throw new FetchError(`${tf} unparseable body`); }
      const result = j?.chart?.result?.[0];
      const g = result?.meta?.dataGranularity;
      if (g && g !== YF_INTERVAL[tf]) throw new BarIntegrityError(`yahoo granularity ${g} != ${YF_INTERVAL[tf]}`);
      const q = result?.indicators?.quote?.[0] ?? {};
      if (!Array.isArray(result?.timestamp)) return null;
      const b = cleanBars(result.timestamp, q.open ?? [], q.high ?? [], q.low ?? [], q.close ?? []);
      return b.closes.length ? b : null;
    });
  }
}

type Series = { tf: Timeframe; days: number[]; ends: number[]; closes: number[]; bx: number[]; mb: BiasSeries | null; dropped: boolean };
function computeOne(tf: Timeframe, raw: Bars, clock: NyClock, dailyDays: number[] | null): Series {
  const { bars, droppedInProgress } = completedBars(tf, raw, clock);   // throws BarIntegrityError on bad cadence
  const bx = computeBX(bars.closes);
  const mb = bars.closes.length > 198 ? marketBiasSeries(bars.opens, bars.highs, bars.lows, bars.closes) : null;
  return { tf, days: bars.days, ends: periodEnds(tf, bars.days, dailyDays), closes: bars.closes, bx, mb, dropped: droppedInProgress };
}
function mtfAt(s: Series | null, endDay: number): { dir: string | null; bx: number | null } {
  if (!s) return { dir: null, bx: null };
  const j = asOfIndex(s.ends, endDay);
  if (j < 0) return { dir: null, bx: null };
  return { dir: biasAt(s.mb, s.closes, j)?.direction ?? null, bx: Number.isNaN(s.bx[j]) ? null : r2(s.bx[j]) };
}

// em-5 hard assert: a row's label must sit inside its own bar's period with the right shape for the timeframe.
function assertLabel(tf: Timeframe, barDay: number, signalDay: number) {
  const w = dow(signalDay);
  const bad = w === 0 || w === 6 ||
    (tf === "daily" ? signalDay !== barDay : periodStart(tf, signalDay) !== periodStart(tf, barDay)) ||
    (tf === "monthly" && dayOfMonth(signalDay) < 15);
  if (bad) throw new BarIntegrityError(`${tf} label ${isoDay(signalDay)} invalid for bar ${isoDay(barDay)}`);
}

async function fetchUniverse(): Promise<string[]> {
  const PAGE = 1000;
  const all: string[] = [];
  let off = 0;
  for (;;) {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/universe?select=ticker&active=eq.true&order=ticker.asc&limit=${PAGE}&offset=${off}`,
      { headers: sbHeaders(), signal: AbortSignal.timeout(DB_TIMEOUT_MS) },
    );
    if (!r.ok) throw new Error(`universe ${r.status}`);
    const page = (await r.json()) as Array<{ ticker: string }>;
    if (page.length === 0) break;
    all.push(...page.map(x => x.ticker));
    if (page.length < PAGE) break;
    off += PAGE;
  }
  return all;
}

async function sb(path: string, init: RequestInit & { prefer?: string }, what: string): Promise<Response> {
  const headers: Record<string, string> = sbHeaders({ "Content-Type": "application/json" });
  if (init.prefer) headers["Prefer"] = init.prefer;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers, signal: AbortSignal.timeout(DB_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`${what} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r;
}

// Rows written before v5 was deployed (v4: Monday weekly labels, first-value EMA seeding, look-ahead MTF). v4 never
// sent computed_at (column default now()); v5 always sends it, so computed_at < V5_EPOCH identifies v4 rows. Must be
// before v5's first write and after v4's last (rollout gate checks max(computed_at) < V5_EPOCH before deploy). Every
// pre-v5 row is copied to private.bx_backtest_results_pre_v5_bak by supabase/sql/40_edge_math.sql BEFORE this
// version is deployed, so these deletes are recoverable (rollback SQL in that file's header).
const V5_EPOCH = "2026-10-24T00:00:00Z";

// Per-ticker write (C6). Returns rows deleted. Stale = this ticker+timeframe's rows not in the new key set that are
// either inside the rebuilt window or v4-built outside it (older than the v5 window, so never reproduced or relabeled).
// v5 rows that later age out of a sliding daily/weekly window are kept.
async function replaceTicker(ticker: string, tf: Timeframe, windowStart: string, rows: Array<Record<string, unknown>>): Promise<number> {
  if (rows.length) {
    await sb("bx_backtest_results?on_conflict=ticker,timeframe,signal_type,signal_date",
      { method: "POST", body: JSON.stringify(rows), prefer: "resolution=merge-duplicates,return=minimal" }, "insert");
  }
  const keep = new Set(rows.map(r => `${r.signal_type}|${r.signal_date}`));
  const t = encodeURIComponent(ticker);
  const scope = encodeURIComponent(`(signal_date.gte.${windowStart},computed_at.lt."${V5_EPOCH}")`);
  const existing = await (await sb(
    `bx_backtest_results?select=id,signal_type,signal_date&ticker=eq.${t}&timeframe=eq.${tf}&or=${scope}&limit=10000`,
    { method: "GET" }, "select")).json() as Array<{ id: number; signal_type: string; signal_date: string }>;
  const stale = existing.filter(r => !keep.has(`${r.signal_type}|${r.signal_date}`)).map(r => r.id);
  for (let i = 0; i < stale.length; i += 200) {
    await sb(`bx_backtest_results?id=in.(${stale.slice(i, i + 200).join(",")})`, { method: "DELETE", prefer: "return=minimal" }, "delete");
  }
  return stale.length;
}

Deno.serve(async (req: Request) => {
  const denied = requireCron(req);
  if (denied) return denied;
  const start = performance.now();
  const ctx: Ctx = { t0: Date.now(), cpuMs: 0 };
  const u = new URL(req.url);
  const tf = (u.searchParams.get("timeframe") ?? "weekly").toLowerCase() as Timeframe;
  const dryrun = u.searchParams.get("dryrun") === "1";
  const symbolsCsv = u.searchParams.get("symbols");
  if (!(tf in YF_INTERVAL)) {
    return new Response(JSON.stringify({ error: "invalid timeframe" }), { status: 400 });
  }
  const chunkS = u.searchParams.get("chunk"), chunksS = u.searchParams.get("chunks");
  const chunk = chunkS == null ? null : Number(chunkS), chunks = chunksS == null ? null : Number(chunksS);
  if ((chunk != null || chunks != null) &&
      !(Number.isInteger(chunk) && Number.isInteger(chunks) && chunks! >= 1 && chunks! <= 100 && chunk! >= 0 && chunk! < chunks!)) {
    return new Response(JSON.stringify({ error: "chunk/chunks must be integers with 0 <= chunk < chunks <= 100" }), { status: 400 });
  }
  const symbolList = symbolsCsv ? parseSymbols(symbolsCsv) : null;
  if (symbolsCsv && !symbolList) {
    return new Response(JSON.stringify({ error: "symbols must be a CSV of tickers matching [A-Z0-9.$^/-]{1,20}" }), { status: 400 });
  }
  const offset = Math.max(0, parseInt(u.searchParams.get("offset") ?? "0", 10) || 0);
  const limit  = Math.max(1, parseInt(u.searchParams.get("limit")  ?? "99999", 10) || 99999);
  const runId = await startRun("bx-backtest-builder", { timeframe: tf, chunk, chunks, offset: chunks ? undefined : offset, limit: chunks ? undefined : limit, symbols: symbolList ? symbolList.length : undefined, dryrun });
  try {
    const clock = nyClock(Date.now());
    let allTickers: string[];
    if (symbolList) allTickers = symbolList;
    else allTickers = await fetchUniverse();
    let selected: string[];
    if (symbolList) selected = allTickers;
    else if (chunks != null) { const size = Math.ceil(allTickers.length / chunks); selected = allTickers.slice(chunk! * size, (chunk! + 1) * size); }
    else selected = allTickers.slice(offset, offset + limit);
    const truncated = selected.length > MAX_TICKERS;
    const tickers = selected.slice(0, MAX_TICKERS);

    let okTickers = 0, failTickers = 0, integrityFail = 0, writeFail = 0, totalSignals = 0, rowsWritten = 0, rowsDeleted = 0;
    let biasOk = 0, mtfFull = 0, baselineRows = 0, baselineFail = 0, droppedInProgress = 0;
    let fetchFail = 0, secondaryRejected = 0, shortHistory = 0;
    const errors: string[] = [];
    const sample: Array<Record<string, unknown>> = [];
    let idx = 0;

    async function worker() {
      while (idx < tickers.length) {
        if (Date.now() - ctx.t0 > START_DEADLINE_MS || ctx.cpuMs > CPU_BUDGET_MS) break;
        const t = tickers[idx++];
        let built: { rows: Array<Record<string, unknown>>; baseline: Record<string, unknown>; windowStart: string; dropped: boolean; short: boolean } | null;
        try {
          // Integrity errors reject the ticker only for the primary timeframe; a bad secondary series (used for MTF
          // columns / period ends) is treated as missing and counted (secondary_rejected). A FetchError on ANY
          // timeframe is not caught here: it fails the whole ticker before anything is written.
          const secondary = <T>(k: Timeframe, f: () => T): T | null => {
            try { return f(); } catch (e) {
              if (k === tf || !(e instanceof BarIntegrityError)) throw e;
              secondaryRejected++;
              if (errors.length < 10) errors.push(`${t}: secondary ${k}: ${e.message}`);
              return null;
            }
          };
          const dD = await fetchHistory(t, "daily", ctx).catch((e) => secondary("daily", () => { throw e; }));
          const dW = await fetchHistory(t, "weekly", ctx).catch((e) => secondary("weekly", () => { throw e; }));
          const dM = await fetchHistory(t, "monthly", ctx).catch((e) => secondary("monthly", () => { throw e; }));
          built = timed(ctx, () => {
            const sD = dD ? secondary("daily", () => computeOne("daily", dD, clock, null)) : null;
            const dailyDays = sD ? sD.days : null;
            const sW = dW ? secondary("weekly", () => computeOne("weekly", dW, clock, dailyDays)) : null;
            const sM = dM ? secondary("monthly", () => computeOne("monthly", dM, clock, dailyDays)) : null;
            const sP = tf === "daily" ? sD : tf === "weekly" ? sW : sM;
            if (!sP) return null;
            const computedAt = new Date().toISOString();
            if (sP.closes.length < MIN_BARS) {
              // Valid but too short to build (incl. 0 completed bars): the result is "no signals". Its whole history
              // is visible (shorter than any fetch range), so every stored row for it is stale -- e.g. weekly bars
              // once stored as monthly for recent listings (em-5). Delete them all. The baseline still covers every
              // completed bar (C6).
              const windowStart = "1900-01-01";
              const baseline = { ticker: t, timeframe: tf, ...baselineAggregate(sP.closes), computed_at: computedAt };
              return { rows: [], baseline, windowStart, dropped: sP.dropped, short: true };
            }
            const sigs = detectSignals(sP.bx, MIN_IDX);
            const rows: Array<Record<string, unknown>> = [];
            const keys = new Set<string>();
            for (const s of sigs) {
              const i = s.index;
              const endDay = sP.ends[i];
              assertLabel(tf, sP.days[i], endDay);
              const date = isoDay(endDay);
              const key = `${s.signal_type}|${date}`;
              if (keys.has(key)) throw new BarIntegrityError(`duplicate key ${key}`);
              keys.add(key);
              const priceAt = sP.closes[i];
              const px = HORIZONS.map(h => sP.closes[i + h] ?? null);
              const rets = HORIZONS.map(h => forwardReturn(sP.closes, i, h));
              const bias = biasAt(sP.mb, sP.closes, i);
              if (bias) biasOk++;
              const aD = mtfAt(sD, endDay), aW = mtfAt(sW, endDay), aM = mtfAt(sM, endDay);
              if (aD.dir && aW.dir && aM.dir) mtfFull++;
              rows.push({
                ticker: t, timeframe: tf,
                signal_type: s.signal_type,
                signal_date: date,
                bx_at_signal:    r2(s.bx),
                prev_bx:         r2(s.prev_bx),
                price_at_signal: r2(priceAt),
                price_5d:   px[0] != null ? r2(px[0]) : null,
                price_20d:  px[1] != null ? r2(px[1]) : null,
                price_60d:  px[2] != null ? r2(px[2]) : null,
                price_120d: px[3] != null ? r2(px[3]) : null,
                ret_5d:   rets[0],
                ret_20d:  rets[1],
                ret_60d:  rets[2],
                ret_120d: rets[3],
                bias_direction:  bias?.direction ?? null,
                bias_oscillator: bias?.oscillator ?? null,
                bias_in_zone:    bias?.in_zone ?? null,
                mtf_daily_bias:   aD.dir,
                mtf_weekly_bias:  aW.dir,
                mtf_monthly_bias: aM.dir,
                mtf_daily_bx:     aD.bx,
                mtf_weekly_bx:    aW.bx,
                mtf_monthly_bx:   aM.bx,
                computed_at: computedAt,
              });
            }
            // Delete window. monthly (period1=0) sees the whole available history (1970 or the listing date), so the
            // window is unbounded: any older-run row this rebuild cannot reproduce (e.g. weekly or quarterly bars once
            // stored as monthly, em-5) is removed. daily/weekly histories slide (2y/10y), so they start at the first
            // period this run could signal in; v5 rows older than that are kept rather than trimmed to a rolling window
            // (pre-v5 rows there are deleted in replaceTicker).
            const windowStart = tf === "monthly" ? "1900-01-01"
              : isoDay(periodStart(tf, sP.days[Math.min(MIN_IDX + 1, sP.days.length - 1)]));
            const baseline = { ticker: t, timeframe: tf, ...baselineAggregate(sP.closes), computed_at: computedAt };
            return { rows, baseline, windowStart, dropped: sP.dropped, short: false };
          });
        } catch (e) {
          if (e instanceof BarIntegrityError) { integrityFail++; if (errors.length < 10) errors.push(`${t}: ${e.message}`); }
          else if (e instanceof FetchError) { fetchFail++; if (errors.length < 10) errors.push(`${t}: fetch failed: ${e.message}`); }
          else if (errors.length < 10) errors.push(`${t}: ${String(e).slice(0, 160)}`);
          failTickers++;
          continue;
        }
        if (!built) { failTickers++; if (errors.length < 10) errors.push(`${t}: no ${tf} history`); continue; }
        if (built.short) shortHistory++;
        if (built.dropped) droppedInProgress++;
        totalSignals += built.rows.length;
        for (const r of built.rows.slice(-2)) if (sample.length < 6) sample.push(r);
        if (!dryrun) {
          try {
            rowsDeleted += await replaceTicker(t, tf, built.windowStart, built.rows);
            rowsWritten += built.rows.length;
          } catch (e) {
            writeFail++; failTickers++;
            if (errors.length < 10) errors.push(`${t}: ${String(e).slice(0, 200)}`);
            continue;
          }
          try {
            await sb("bx_backtest_baseline?on_conflict=ticker,timeframe",
              { method: "POST", body: JSON.stringify(built.baseline), prefer: "resolution=merge-duplicates,return=minimal" }, "baseline");
            baselineRows++;
          } catch (e) {
            baselineFail++;
            if (errors.length < 10) errors.push(`${t}: ${String(e).slice(0, 200)}`);
          }
        }
        okTickers++;
      }
    }
    await Promise.all(Array.from({ length: POOL }, () => worker()));
    const notStarted = tickers.length - idx;

    const status = tickers.length > 0 && okTickers === 0 ? "error"
      : (failTickers > 0 || baselineFail > 0 || secondaryRejected > 0 || notStarted > 0 || truncated) ? "partial" : "ok";
    await finishRun(runId, {
      status, rows_written: okTickers, rows_expected: tickers.length,
      error: [notStarted ? `${notStarted} not started (time/CPU budget)` : null, truncated ? `truncated to ${MAX_TICKERS}` : null,
        fetchFail ? `${fetchFail} fetch failed` : null, integrityFail ? `${integrityFail} integrity rejected` : null,
        secondaryRejected ? `${secondaryRejected} secondary series rejected (MTF null)` : null, ...errors.slice(0, 3)]
        .filter(Boolean).join("; ") || undefined,
    });
    return new Response(JSON.stringify({
      success: true,
      version: 5,
      timeframe: tf,
      dryrun,
      chunk, chunks,
      offset: chunks != null ? null : offset, limit: chunks != null ? null : limit,
      universe_total: allTickers.length,
      selected: selected.length,
      truncated,
      processed: idx,
      not_started: notStarted,
      tickers_ok: okTickers,
      tickers_failed: failTickers,
      integrity_rejected: integrityFail,
      fetch_failed: fetchFail,
      secondary_rejected: secondaryRejected,
      short_history: shortHistory,
      write_failed: writeFail,
      in_progress_bars_dropped: droppedInProgress,
      total_signals: totalSignals,
      signals_with_bias: biasOk,
      signals_mtf_complete: mtfFull,
      rows_inserted: dryrun ? 0 : rowsWritten,
      rows_deleted: rowsDeleted,
      baseline_rows: baselineRows,
      baseline_failed: baselineFail,
      run_status: status,
      errors,
      sample,
      cpu_ms_est: Math.round(ctx.cpuMs),
      elapsed_ms: Math.round(performance.now() - start),
    }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    await finishRun(runId, { status: "error", error: String(err) });
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
