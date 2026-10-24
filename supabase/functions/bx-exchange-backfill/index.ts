// Exchange + 52-week backfill v4 — captures fullExchangeName, fiftyTwoWeekHigh, fiftyTwoWeekLow
// All from a single Yahoo Finance chart endpoint call (chart meta carries the 52-week range for any range).
// v4: cron auth (C1) + run log (C3); ACTIVE universe tickers only; bounded concurrency with polite
// delays and a wall-clock deadline; rows upserted grouped by key set (PostgREST rejects mixed keys
// in one bulk insert with PGRST102, which failed every v3 run); a missing value is omitted, never
// written as null, so a Yahoo gap can't erase a good stored value.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireCron } from "../_shared/cron_auth.ts";
import { finishRun, startRun } from "../_shared/pipeline_log.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const POOL = 4;                 // concurrent Yahoo requests
const DELAY_MS = 100;           // per-worker pause between requests
const DEADLINE_MS = 110_000;    // stop starting fetches here; edge wall clock is 150 s

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toTradingView(yahooEx: string | undefined | null): string | null {
  if (!yahooEx) return null;
  const e = String(yahooEx).toUpperCase().trim();
  if (e.includes('AMERICAN') || e.includes('ARCA') || e === 'PCX' || e === 'PSE' || e === 'AMEX' || e === 'ASE') return 'AMEX';
  if (e.includes('BATS') || e === 'BTS' || e === 'BZX' || e.includes('CBOE')) return 'BATS';
  if (e.includes('NYSE') || e === 'NYQ' || e === 'NYS') return 'NYSE';
  if (e.includes('NASDAQ') || e === 'NMS' || e === 'NGM' || e === 'NCM' || e === 'NSI') return 'NASDAQ';
  if (e.includes('OTC') || e === 'PNK' || e === 'PINK') return 'OTC';
  return null;
}

type YahooMeta = {
  exchange: string | null;
  fifty_two_week_high: number | null;
  fifty_two_week_low:  number | null;
};

async function getYahooMeta(ticker: string): Promise<YahooMeta | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 BXTerminal" }, signal: AbortSignal.timeout(8_000) });
      if (r.status === 429 || r.status >= 500) { await r.body?.cancel(); await sleep(1000 * (attempt + 1)); continue; }
      if (!r.ok) { await r.body?.cancel(); return null; }
      const j = await r.json();
      const m = j?.chart?.result?.[0]?.meta;
      if (!m) return null;
      let hi = typeof m.fiftyTwoWeekHigh === 'number' && Number.isFinite(m.fiftyTwoWeekHigh) && m.fiftyTwoWeekHigh > 0 ? m.fiftyTwoWeekHigh : null;
      let lo = typeof m.fiftyTwoWeekLow  === 'number' && Number.isFinite(m.fiftyTwoWeekLow)  && m.fiftyTwoWeekLow  > 0 ? m.fiftyTwoWeekLow  : null;
      if (hi == null || lo == null || hi < lo) { hi = null; lo = null; }   // write the range only as a sane pair
      return {
        exchange:            toTradingView(m.fullExchangeName ?? m.exchangeName),
        fifty_two_week_high: hi,
        fifty_two_week_low:  lo,
      };
    } catch { await sleep(1000 * (attempt + 1)); }
  }
  return null;
}

async function getActiveTickers(): Promise<string[]> {
  const PAGE = 1000;
  const all: string[] = [];
  let offset = 0;
  for (;;) {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/universe?select=ticker&active=eq.true&limit=${PAGE}&offset=${offset}&order=ticker.asc`,
      { headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` } }
    );
    if (!r.ok) throw new Error(`tickers ${r.status}`);
    const page = await r.json() as Array<{ ticker: string }>;
    if (page.length === 0) break;
    all.push(...page.map(p => p.ticker));
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

// PostgREST requires identical keys across a bulk insert (PGRST102), so upsert each key set separately.
async function bulkUpsert(rows: Array<Record<string, unknown>>) {
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const k = Object.keys(row).sort().join(",");
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(row);
  }
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += 500) {
      const slice = group.slice(i, i + 500);
      const r = await fetch(`${SUPABASE_URL}/rest/v1/ticker_meta?on_conflict=ticker`, {
        method: "POST",
        headers: {
          "apikey":         SERVICE_KEY,
          "Authorization":  `Bearer ${SERVICE_KEY}`,
          "Content-Type":   "application/json",
          "Prefer":         "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(slice),
      });
      if (!r.ok) throw new Error(`upsert ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
  }
}

Deno.serve(async (req: Request) => {
  const denied = requireCron(req);
  if (denied) return denied;
  const runId = await startRun("bx-exchange-backfill", {});
  const start = performance.now();
  try {
    const tickers = await getActiveTickers();
    const updates: Array<Record<string, unknown>> = [];
    let exchangeCount = 0, range52Count = 0, fail = 0, skipped = 0;
    let idx = 0;

    async function worker() {
      while (idx < tickers.length) {
        const t = tickers[idx++];
        if (performance.now() - start > DEADLINE_MS) { skipped++; continue; }
        const meta = await getYahooMeta(t);
        await sleep(DELAY_MS);
        if (!meta) { fail++; continue; }
        // updated_at is deliberately NOT sent: reconcile_universe treats it as "seen by Finviz".
        const row: Record<string, unknown> = { ticker: t };
        if (meta.exchange) { row.exchange = meta.exchange; exchangeCount++; }
        if (meta.fifty_two_week_high != null && meta.fifty_two_week_low != null) {
          row.fifty_two_week_high = meta.fifty_two_week_high;
          row.fifty_two_week_low  = meta.fifty_two_week_low;
          range52Count++;
        }
        // Only push if we have something beyond the ticker
        if (Object.keys(row).length > 1) updates.push(row);
      }
    }
    await Promise.all(Array.from({ length: POOL }, () => worker()));
    if (updates.length > 0) await bulkUpsert(updates);

    const status = fail > 0 || skipped > 0 ? "partial" : "ok";
    await finishRun(runId, {
      status,
      rows_written: updates.length,
      rows_expected: tickers.length,
      error: status === "partial" ? `${fail} Yahoo fetches failed, ${skipped} skipped at the ${DEADLINE_MS / 1000}s deadline` : undefined,
    });
    return new Response(JSON.stringify({
      success: true,
      status,
      total: tickers.length,
      updated: updates.length,
      exchange_filled: exchangeCount,
      range_52w_filled: range52Count,
      failed: fail,
      skipped_deadline: skipped,
      elapsed_ms: Math.round(performance.now() - start),
    }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    await finishRun(runId, { status: "error", error: String(err) });
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
