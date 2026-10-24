// TradeStation OAuth redirect target (env TRADESTATION_REDIRECT_URI).
// Findings edge-ts-2 / edge-ts-5 / edge-ts-7 / edge-ts-8:
//  1. ?state must match an unexpired row in public.ts_oauth_states; it is deleted in the same
//     statement (one-time use) and yields the PKCE code_verifier.
//  2. The code is redeemed with client secret + code_verifier.
//  3. Identity check: GET /v3/brokerage/accounts (live API) with the NEW access token must list at
//     least one AccountID from env TS_OWNER_ACCOUNTS (comma-separated); otherwise nothing is written.
//  4. public.ts_store_linked_tokens() (service_role only, see sql/10_security.sql) copies the current
//     id=1 row into private.tradestation_tokens_history and upserts the new tokens in one transaction.
// Every write result is checked; error pages show only HTTP status / OAuth error codes.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const TS_AUTH_BASE = "https://signin.tradestation.com";
const TS_IDENTITY_API = "https://api.tradestation.com/v3"; // live: the owner's real accounts, regardless of TRADESTATION_ENV
const TS_CLIENT_ID = Deno.env.get("TRADESTATION_CLIENT_ID") ?? "";
const TS_CLIENT_SECRET = Deno.env.get("TRADESTATION_CLIENT_SECRET") ?? "";
const TS_REDIRECT_URI = Deno.env.get("TRADESTATION_REDIRECT_URI") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const STATE_RE = /^[A-Za-z0-9_-]{43}$/; // what ts-oauth-start generates

const sb = (extra: Record<string, string> = {}) => ({
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
  ...extra,
});

function page(title: string, msg: string, ok: boolean, status: number): Response {
  return new Response(
    "<html><body style='font-family:sans-serif;background:#1a1d21;color:#e6e8eb;padding:40px'>" +
      `<h2 style='color:${ok ? "#2ecc71" : "#e74c3c"}'>${title}</h2>` +
      `<p>${msg}</p>` +
      "</body></html>",
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    },
  );
}
const fail = (msg: string, status: number) => page("TradeStation NOT connected", msg, false, status);
// Only short code-like tokens are ever reflected into the page.
const safeCode = (v: unknown) => String(v ?? "").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64);

Deno.serve(async (req) => {
  if (req.method !== "GET") return fail("Method not allowed.", 405);
  const owners = (Deno.env.get("TS_OWNER_ACCOUNTS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!TS_CLIENT_ID || !TS_CLIENT_SECRET || !TS_REDIRECT_URI || owners.length === 0) {
    return fail("Server is missing TradeStation client secrets or TS_OWNER_ACCOUNTS.", 500);
  }

  const url = new URL(req.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");
  if (!STATE_RE.test(state)) return fail("Missing or malformed state. Start again from ts-oauth-start.", 400);

  try {
    // 1. Consume the state (single DELETE ... RETURNING, so only one request can ever win it).
    const del = await fetch(
      `${SUPABASE_URL}/rest/v1/ts_oauth_states?state=eq.${state}` +
        `&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=code_verifier`,
      { method: "DELETE", headers: sb({ Prefer: "return=representation" }), signal: AbortSignal.timeout(10_000) },
    );
    if (!del.ok) {
      await del.body?.cancel();
      return fail(`State store unavailable (HTTP ${del.status}). Nothing saved.`, 500);
    }
    const rows = await del.json().catch(() => []);
    const verifier = Array.isArray(rows) && rows.length === 1 ? String(rows[0]?.code_verifier ?? "") : "";
    if (!verifier) return fail("Unknown, expired or already-used state. Start again from ts-oauth-start.", 400);
    if (err) return fail(`OAuth error: ${safeCode(err)}`, 400);
    if (!code) return fail("Missing ?code.", 400);

    // 2. Redeem the code.
    const r = await fetch(`${TS_AUTH_BASE}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: TS_CLIENT_ID,
        client_secret: TS_CLIENT_SECRET,
        code,
        redirect_uri: TS_REDIRECT_URI,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = await r.json().catch(() => ({} as Record<string, unknown>));
    if (!r.ok || typeof j.access_token !== "string" || !j.access_token) {
      return fail(`Token exchange failed: HTTP ${r.status} ${safeCode(j.error)}`, 502);
    }
    if (typeof j.refresh_token !== "string" || !j.refresh_token) {
      return fail("Token exchange returned no refresh_token (offline_access missing). Nothing saved.", 502);
    }

    // 3. Identity: the new login must see one of the owner's accounts.
    const a = await fetch(`${TS_IDENTITY_API}/brokerage/accounts`, {
      headers: { authorization: `Bearer ${j.access_token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!a.ok) {
      await a.body?.cancel();
      return fail(`Could not verify the account (accounts HTTP ${a.status}). Nothing saved.`, 502);
    }
    const aj = await a.json().catch(() => ({} as Record<string, unknown>));
    const ids: string[] = Array.isArray(aj?.Accounts)
      ? (aj.Accounts as Array<Record<string, unknown>>).map((x) => String(x?.AccountID ?? ""))
      : [];
    if (!ids.some((id) => owners.includes(id))) {
      console.error("ts-oauth-callback: refused link, no owner account on this login");
      return fail("This TradeStation login is not the configured owner. Nothing saved.", 403);
    }

    // 4. Archive the current row and store the new tokens atomically.
    const expiresIn = Number(j.expires_in);
    const expires_at = new Date(
      Date.now() + ((Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 1200) - 60) * 1000,
    ).toISOString();
    const w = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ts_store_linked_tokens`, {
      method: "POST",
      headers: sb(),
      body: JSON.stringify({
        p_access_token: j.access_token,
        p_refresh_token: j.refresh_token,
        p_expires_at: expires_at,
        p_scope: typeof j.scope === "string" ? j.scope : null,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!w.ok) {
      await w.body?.cancel();
      console.error(`ts-oauth-callback: token store failed HTTP ${w.status}`);
      return fail(`Saving the tokens failed (HTTP ${w.status}). The previous link is unchanged.`, 500);
    }
    await w.body?.cancel();

    return page("TradeStation connected ✓", "You can close this tab.", true, 200);
  } catch (e) {
    console.error(`ts-oauth-callback: ${e instanceof Error ? e.name : "error"}`);
    return fail("Unexpected error. Nothing was saved; start again from ts-oauth-start.", 500);
  }
});
