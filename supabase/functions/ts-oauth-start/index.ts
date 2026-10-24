// Kicks off TradeStation OAuth for the service account.
//
// Open this URL in a browser while logged into the TradeStation account
// whose credentials the app should use for market data + order execution.
//
// Security (findings edge-ts-2 / edge-ts-8): each visit stores a one-time state plus a PKCE verifier
// in public.ts_oauth_states (service role only, 10-minute expiry). ts-oauth-callback consumes the
// state, redeems the code with the verifier, and refuses to save tokens unless the linked login can
// see one of the AccountIDs in env TS_OWNER_ACCOUNTS. No CORS: this is a top-level browser navigation.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const TS_AUTH_BASE = "https://signin.tradestation.com";
const TS_CLIENT_ID = Deno.env.get("TRADESTATION_CLIENT_ID") ?? "";
const TS_REDIRECT_URI = Deno.env.get("TRADESTATION_REDIRECT_URI") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MAX_LIVE_STATES = 20; // caps how many pending logins anonymous visitors can park in the table

const sb = (extra: Record<string, string> = {}) => ({
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
  ...extra,
});

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

// 32 random bytes, base64url without padding (43 chars).
function randomB64url(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}
function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

Deno.serve(async (req) => {
  if (req.method !== "GET") return text("Method not allowed", 405);

  if (!TS_CLIENT_ID || !TS_REDIRECT_URI || !(Deno.env.get("TS_OWNER_ACCOUNTS") ?? "").trim()) {
    return text("Missing TRADESTATION_CLIENT_ID, TRADESTATION_REDIRECT_URI or TS_OWNER_ACCOUNTS secrets.", 500);
  }

  try {
    // Drop expired states, then refuse if too many are still pending (anonymous spam guard).
    const del = await fetch(
      `${SUPABASE_URL}/rest/v1/ts_oauth_states?expires_at=lt.${encodeURIComponent(new Date().toISOString())}`,
      { method: "DELETE", headers: sb(), signal: AbortSignal.timeout(10_000) },
    );
    if (!del.ok) throw new Error(`state cleanup HTTP ${del.status}`);
    await del.body?.cancel();
    const cnt = await fetch(`${SUPABASE_URL}/rest/v1/ts_oauth_states?select=state`, {
      method: "HEAD",
      headers: sb({ Prefer: "count=exact" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!cnt.ok) throw new Error(`state count HTTP ${cnt.status}`);
    const live = Number((cnt.headers.get("content-range") ?? "").split("/")[1]);
    if (!Number.isFinite(live) || live >= MAX_LIVE_STATES) {
      return text("Too many pending TradeStation logins. Try again in 10 minutes.", 429);
    }

    const state = randomB64url();
    const verifier = randomB64url();
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const ins = await fetch(`${SUPABASE_URL}/rest/v1/ts_oauth_states`, {
      method: "POST",
      headers: sb({ Prefer: "return=minimal" }),
      body: JSON.stringify({ state, code_verifier: verifier }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!ins.ok) throw new Error(`state insert HTTP ${ins.status}`);
    await ins.body?.cancel();

    const u = new URL(`${TS_AUTH_BASE}/authorize`);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", TS_CLIENT_ID);
    u.searchParams.set("redirect_uri", TS_REDIRECT_URI);
    u.searchParams.set("audience", "https://api.tradestation.com");
    u.searchParams.set(
      "scope",
      "openid offline_access profile MarketData ReadAccount Trade OptionSpreads Matrix",
    );
    u.searchParams.set("state", state);
    u.searchParams.set("code_challenge", challenge);
    u.searchParams.set("code_challenge_method", "S256");

    return new Response(null, { status: 302, headers: { location: u.toString(), "cache-control": "no-store" } });
  } catch (e) {
    console.error(`ts-oauth-start: ${e instanceof Error ? e.message : "error"}`);
    return text("Could not start the TradeStation login (state store unavailable).", 500);
  }
});
