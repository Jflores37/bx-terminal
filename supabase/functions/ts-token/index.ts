// ts-token: TradeStation access-token broker for the owner's other services (server-to-server only).
// Key from env TS_TOKEN_KEY, accepted ONLY in header x-ts-key (constant-time compare). A request that
// carries a ?key= query param is rejected with 400: query strings land in edge/proxy logs.
// Returns the cached token from tradestation_tokens id=1 while it has > 2 min left; otherwise
// _shared/ts_auth.ts refreshes it with a compare-and-swap write (contract C7/C8).
// Consumers: trading-journal (TS_TOKEN_URL + TS_TOKEN_KEY), trader-backtest-lab (TS_TOKEN_BROKER_URL + TS_TOKEN_BROKER_KEY).
// No CORS headers on purpose (no browser caller). Never log the request URL, query or headers.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { timingSafeEqualStr } from "../_shared/cron_auth.ts";
import { getTsToken } from "../_shared/ts_auth.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  if (new URL(req.url).searchParams.has("key")) {
    return json({ error: "send the key in the x-ts-key header, not the query string" }, 400);
  }
  const expected = Deno.env.get("TS_TOKEN_KEY") ?? "";
  if (!expected) return json({ error: "TS_TOKEN_KEY not configured" }, 500);
  if (!timingSafeEqualStr(req.headers.get("x-ts-key") ?? "", expected)) {
    return json({ error: "unauthorized" }, 401);
  }
  try {
    const t = await getTsToken();
    return json({ access_token: t.access_token, expires_at: t.expires_at, scope: t.scope });
  } catch (e) {
    // ts_auth errors carry only HTTP status / OAuth error code, never token values.
    const msg = e instanceof Error ? e.message : "token unavailable";
    console.error(`ts-token: ${msg}`);
    return json({ error: "token_unavailable", detail: msg }, 502);
  }
});
