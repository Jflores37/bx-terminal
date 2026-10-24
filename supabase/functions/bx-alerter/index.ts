// BX Slack Alerter Edge Function
// Reads from `zone_transitions` view and posts new ones to Slack via webhook. Only transitions at each
// timeframe's newest bx_scans scan_date are considered (older lookback rows are stale, not news).
// Dedup is claim-then-post on `alert_state` (PK alert_key, see supabase/sql/30_edge_data.sql):
//   1. insert one 'claimed' row per qualifying transition with ON CONFLICT DO NOTHING; only the rows
//      this invocation actually inserted are posted, so concurrent runs never double-post;
//   2. each Slack message that succeeds flips its rows to 'posted';
//   3. a failed Slack post deletes its unposted claims so the next run retries them;
//   4. a claim left 'claimed' for > CLAIM_TTL_MIN (worker killed mid-run) is released by the next run.
// Slack limits: <= 3,000 chars per section text and <= 50 blocks per message, so rows are chunked
// into sections and sections are packed into as many messages as needed.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireCron } from "../_shared/cron_auth.ts";
import { finishRun, startRun } from "../_shared/pipeline_log.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SLACK_WEBHOOK = Deno.env.get("SLACK_WEBHOOK_URL") ?? "";
const MIN_MAGNITUDE = parseFloat(Deno.env.get("MIN_TRANSITION_MAGNITUDE") ?? "3.0");

const TIMEFRAMES = ["daily", "weekly", "monthly"];
const SECTION_MAX_CHARS = 2900;   // Slack section text limit is 3,000
const MSG_MAX_BLOCKS = 50;        // Slack blocks-per-message limit
const MSG_MAX_CHARS = 12000;      // keep each message a readable size
const CLAIM_TTL_MIN = 15;
const PRUNE_DAYS = 200;           // latest_scans looks back at most 100 days, so older keys can't recur
const KEY_CHUNK = 100;            // keys per in.(...) filter, keeps URLs short

const ZONE_EMOJI: Record<string, string> = { bullish: "🟢", bearish: "🔴", neutral: "🟡" };
const TF_EMOJI: Record<string, string>   = { daily: "📅", weekly: "📆", monthly: "🗓️" };

async function sb<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers ?? {}),
    },
  });
  if (!r.ok) throw new Error(`${path.split("?")[0]} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  if (r.status === 204) return undefined as unknown as T;
  const txt = await r.text();
  return (txt ? JSON.parse(txt) : undefined) as T;
}

// Belt and braces: strip the webhook URL (it is the credential) from anything logged or returned.
function redact(v: unknown): string {
  let s = String(v);
  if (SLACK_WEBHOOK) s = s.replaceAll(SLACK_WEBHOOK, "[webhook]").replaceAll(encodeURI(SLACK_WEBHOOK), "[webhook]");
  return s;
}

function key(t: { ticker: string; timeframe: string; scan_date: string }) {
  return `${t.ticker}|${t.timeframe}|${t.scan_date}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Row = {
  ticker: string; timeframe: string; bx: number; bx_previous_scan: number;
  scan_date: string; current_zone: string; previous_zone: string; _key: string;
};
type Section = { text: string; keys: string[] };
type Message = { payload: unknown; keys: string[] };

// Validates one zone_transitions row. Throws on schema drift (missing/renamed column, non-numeric bx)
// instead of letting NaN silently filter every row out.
function parseTransition(t: Record<string, unknown>): Row {
  const bx = t.bx == null ? NaN : Number(t.bx);
  const prev = t.prev_bx == null ? NaN : Number(t.prev_bx);
  if (!Number.isFinite(bx) || !Number.isFinite(prev)) {
    throw new Error(`zone_transitions schema drift: bx=${JSON.stringify(t.bx)} prev_bx=${JSON.stringify(t.prev_bx)} for ${String(t.ticker)} (columns: ${Object.keys(t).join(",")})`);
  }
  for (const c of ["ticker", "timeframe", "scan_date", "current_zone", "previous_zone"]) {
    if (typeof t[c] !== "string" || !t[c]) throw new Error(`zone_transitions schema drift: column ${c} missing or not text (columns: ${Object.keys(t).join(",")})`);
  }
  const r = {
    ticker: t.ticker as string,
    timeframe: t.timeframe as string,
    bx,
    bx_previous_scan: prev,
    scan_date: t.scan_date as string,
    current_zone: t.current_zone as string,
    previous_zone: t.previous_zone as string,
  };
  return { ...r, _key: key(r) };
}

function formatLine(r: Row, meta: Record<string, { exchange?: string; price?: number }>) {
  const zone = r.current_zone;
  const m = meta[r.ticker] ?? {};
  const px = m.price ? `$${Number(m.price).toFixed(2)}` : "";
  const tvUrl = `https://www.tradingview.com/chart/?symbol=${m.exchange ?? "NASDAQ"}:${r.ticker}`;
  const delta = r.bx - r.bx_previous_scan;
  return `${ZONE_EMOJI[zone] ?? ""} *<${tvUrl}|${r.ticker}>* \`${r.bx >= 0 ? "+" : ""}${r.bx.toFixed(2)}\` (was \`${r.bx_previous_scan >= 0 ? "+" : ""}${r.bx_previous_scan.toFixed(2)}\`, Δ \`${delta >= 0 ? "+" : ""}${delta.toFixed(2)}\`)  ${r.previous_zone.toUpperCase()} → *${zone.toUpperCase()}*  ${px}`;
}

// Builds the ordered content blocks (timeframe titles, zone sections chunked to <= SECTION_MAX_CHARS,
// dividers), each tagged with the alert keys it carries.
function buildSections(
  groups: Record<string, Record<string, Row[]>>,
  meta: Record<string, { exchange?: string; price?: number }>,
): Array<{ block: unknown; text: string; keys: string[] }> {
  const out: Array<{ block: unknown; text: string; keys: string[] }> = [];
  const section = (s: Section) => ({ block: { type: "section", text: { type: "mrkdwn", text: s.text } }, text: s.text, keys: s.keys });
  for (const tf of ["monthly", "weekly", "daily"]) {
    if (!groups[tf]) continue;
    out.push(section({ text: `${TF_EMOJI[tf]} *${tf.toUpperCase()}*`, keys: [] }));
    for (const zone of ["bullish", "bearish", "neutral"]) {
      const rows = groups[tf][zone];
      if (!rows || rows.length === 0) continue;
      rows.sort((a, b) => Math.abs(b.bx - b.bx_previous_scan) - Math.abs(a.bx - a.bx_previous_scan));
      let cur: Section = { text: "", keys: [] };
      for (const r of rows) {
        const line = formatLine(r, meta);
        if (cur.text && cur.text.length + 1 + line.length > SECTION_MAX_CHARS) {
          out.push(section(cur));
          cur = { text: "", keys: [] };
        }
        cur.text = cur.text ? `${cur.text}\n${line}` : line;
        cur.keys.push(r._key);
      }
      if (cur.text) out.push(section(cur));
    }
    out.push({ block: { type: "divider" }, text: "", keys: [] });
  }
  return out;
}

// Packs content blocks into Slack messages of <= MSG_MAX_BLOCKS blocks (3 used by the header).
function packMessages(
  content: Array<{ block: unknown; text: string; keys: string[] }>,
  total: number,
  scanLabel: string,
): Message[] {
  const perMsg = MSG_MAX_BLOCKS - 3;
  const parts: Array<typeof content> = [];
  let cur: typeof content = [];
  let chars = 0;
  for (const c of content) {
    if (cur.length && (cur.length >= perMsg || chars + c.text.length > MSG_MAX_CHARS)) {
      parts.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(c);
    chars += c.text.length;
  }
  if (cur.length) parts.push(cur);
  return parts.map((p, i) => {
    const partLabel = parts.length > 1 ? ` (${i + 1}/${parts.length})` : "";
    const blocks: unknown[] = [
      { type: "header", text: { type: "plain_text", text: `🚨 BX Zone Transitions — ${total} new${partLabel}` } },
      { type: "context", elements: [{ type: "mrkdwn", text: `*Scan*: ${scanLabel}  ·  *Source*: BX Terminal` }] },
      { type: "divider" },
      ...p.map((c) => c.block),
    ];
    return { payload: { text: `${total} new BX zone transitions${partLabel}`, blocks }, keys: p.flatMap((c) => c.keys) };
  });
}

function inList(keys: string[]) {
  return `in.(${keys.map((k) => `"${k}"`).join(",")})`;
}

async function forChunks(keys: string[], fn: (chunk: string[]) => Promise<unknown>) {
  for (let i = 0; i < keys.length; i += KEY_CHUNK) await fn(keys.slice(i, i + KEY_CHUNK));
}

async function releaseClaims(keys: string[]) {
  await forChunks(keys, (c) =>
    sb(`alert_state?status=eq.claimed&alert_key=${encodeURIComponent(inList(c))}`, { method: "DELETE", headers: { "Prefer": "return=minimal" } }));
}

async function markPosted(keys: string[]) {
  await forChunks(keys, (c) =>
    sb(`alert_state?alert_key=${encodeURIComponent(inList(c))}`, {
      method: "PATCH",
      headers: { "Prefer": "return=minimal" },
      body: JSON.stringify({ status: "posted", posted_at: new Date().toISOString() }),
    }));
}

type RunOut = { status: "ok" | "partial" | "error"; body: Record<string, unknown>; written: number; expected: number };

async function run(timeframe?: string): Promise<RunOut> {
  const tfFilter = timeframe ? `&timeframe=eq.${timeframe}` : "";
  const raw = await sb<Array<Record<string, unknown>>>(`zone_transitions?select=*${tfFilter}`);
  // Parse every row (not just qualifying ones) so a schema drift always surfaces as an error.
  const parsed = raw.map(parseTransition);
  // zone_transitions reads latest_scans, which keeps a ticker's last row from the lookback window even when
  // that ticker missed the newest scan. Only the timeframe's newest scan_date is news; older rows are stale.
  const maxDate: Record<string, string> = {};
  for (const tf of timeframe ? [timeframe] : TIMEFRAMES) {
    const top = await sb<Array<{ scan_date: string }>>(`bx_scans?select=scan_date&timeframe=eq.${tf}&order=scan_date.desc&limit=1`);
    if (top?.[0]?.scan_date) maxDate[tf] = top[0].scan_date;
  }
  const transitions = parsed.filter((t) => t.scan_date === maxDate[t.timeframe]);
  const staleSkipped = parsed.length - transitions.length;
  const qualifying = transitions.filter((t) => Math.abs(t.bx - t.bx_previous_scan) >= MIN_MAGNITUDE);

  if (!SLACK_WEBHOOK) {
    return { status: "ok", body: { skipped: "no SLACK_WEBHOOK_URL set", transitions: transitions.length, qualifying: qualifying.length, stale_skipped: staleSkipped, max_scan_date: maxDate }, written: 0, expected: 0 };
  }
  if (qualifying.length === 0) return { status: "ok", body: { posted: 0, reason: "no transitions above threshold" }, written: 0, expected: 0 };

  // Release claims orphaned by a killed worker, then claim. Only rows inserted by THIS call come back.
  const staleBefore = new Date(Date.now() - CLAIM_TTL_MIN * 60_000).toISOString();
  await sb(`alert_state?status=eq.claimed&claimed_at=lt.${encodeURIComponent(staleBefore)}`, { method: "DELETE", headers: { "Prefer": "return=minimal" } });
  const claimed = await sb<Array<{ alert_key: string }>>(`alert_state?on_conflict=alert_key&select=alert_key`, {
    method: "POST",
    headers: { "Prefer": "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify(qualifying.map((t) => ({ alert_key: t._key, scan_date: t.scan_date, status: "claimed", posted_at: null }))),
  }) ?? [];
  const claimedSet = new Set(claimed.map((c) => c.alert_key));
  const fresh = qualifying.filter((t) => claimedSet.has(t._key));

  if (fresh.length === 0) return { status: "ok", body: { posted: 0, reason: "all already alerted (or claimed by a concurrent run)" }, written: 0, expected: 0 };

  let posted = 0;
  let pending = fresh.map((t) => t._key);
  try {
    // pull metadata for tickers in fresh
    const tickerList = [...new Set(fresh.map(t => t.ticker))];
    const inExpr = tickerList.map(t => `"${t}"`).join(",");
    const metaRows = await sb<Array<{ ticker: string; exchange?: string; price?: number }>>(`ticker_meta?ticker=in.(${inExpr})&select=ticker,exchange,price`);
    const meta: Record<string, { exchange?: string; price?: number }> = {};
    for (const m of metaRows) meta[m.ticker] = m;

    // group: timeframe -> current_zone -> rows
    const groups: Record<string, Record<string, Row[]>> = {};
    for (const t of fresh) {
      groups[t.timeframe] ??= {};
      groups[t.timeframe][t.current_zone] ??= [];
      groups[t.timeframe][t.current_zone].push(t);
    }

    const dates = fresh.map((t) => t.scan_date).sort();
    const scanLabel = dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} to ${dates[dates.length - 1]}`;
    const messages = packMessages(buildSections(groups, meta), fresh.length, scanLabel);

    for (let i = 0; i < messages.length; i++) {
      if (i > 0) await sleep(1100);   // Slack webhooks allow ~1 message/second
      const msg = messages[i];
      // The webhook URL is the credential, and a network-level fetch error's message contains it: never pass it on.
      let slackResp: Response;
      try {
        slackResp = await fetch(SLACK_WEBHOOK, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(msg.payload),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (e) {
        throw new Error(`slack fetch failed on message ${i + 1}/${messages.length}: ${(e as Error)?.name ?? "error"}`);
      }
      if (!slackResp.ok) throw new Error(`slack ${slackResp.status} on message ${i + 1}/${messages.length}: ${(await slackResp.text()).slice(0, 200)}`);
      const sent = new Set(msg.keys);
      pending = pending.filter((k) => !sent.has(k));
      posted += msg.keys.length;
      try {
        await markPosted(msg.keys);
      } catch (e) {
        // Rows stay 'claimed' (still deduped). Only a later stale-claim release could repost them.
        console.error(`bx-alerter markPosted failed: ${String(e)}`);
      }
    }
  } catch (err) {
    // Hand unposted claims back so the next run retries them.
    try { await releaseClaims(pending); } catch (e) { console.error(`bx-alerter releaseClaims failed: ${String(e)}`); }
    return { status: posted > 0 ? "partial" : "error", body: { error: redact(err), posted, unposted: pending.length }, written: posted, expected: fresh.length };
  }

  // Keep alert_state bounded. Non-fatal.
  try {
    const cutoff = new Date(Date.now() - PRUNE_DAYS * 86_400_000).toISOString().slice(0, 10);
    await sb(`alert_state?scan_date=lt.${cutoff}`, { method: "DELETE", headers: { "Prefer": "return=minimal" } });
  } catch (e) { console.error(`bx-alerter prune failed: ${String(e)}`); }

  return { status: "ok", body: { posted }, written: posted, expected: fresh.length };
}

Deno.serve(async (req: Request) => {
  const denied = requireCron(req);
  if (denied) return denied;
  const tf = new URL(req.url).searchParams.get("timeframe") ?? undefined;
  if (tf && !TIMEFRAMES.includes(tf)) {
    return new Response(JSON.stringify({ error: "timeframe must be daily, weekly or monthly" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  const runId = await startRun("bx-alerter", { timeframe: tf ?? null });
  try {
    const out = await run(tf);
    await finishRun(runId, {
      status: out.status,
      rows_written: out.written,
      rows_expected: out.expected,
      error: out.body.error != null ? redact(out.body.error) : undefined,
    });
    return new Response(JSON.stringify(out.body), { status: out.status === "error" ? 500 : 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    const msg = redact(err);
    await finishRun(runId, { status: "error", error: msg });
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
