// Shared TradeStation token access (contract C7). Single row public.tradestation_tokens id=1.
//   getTsAccessToken() -> cached access token when expires_at > now + 120 s, else refresh.
//   getTsToken()       -> same, plus { expires_at, scope } (for the ts-token broker response).
// Refresh writes with compare-and-swap (RPC ts_cas_tokens: update ... where id=1 and refresh_token=<old>) so two
// concurrent refreshers cannot clobber each other. If the CAS loses, or TradeStation rejects the
// refresh (e.g. invalid_grant because another worker already rotated it), the row is re-read and
// the winner's token is used when still valid. Works for rotating and non-rotating refresh tokens
// (j.refresh_token absent -> keep the old one). Token values are never logged or put in errors.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TS_TOKEN_URL = "https://signin.tradestation.com/oauth/token";
const SAFETY_MS = 120_000;      // treat a token as expired 2 min early
const EXPIRY_PAD_S = 60;        // stored expires_at = issue + expires_in - 60 s (existing convention)
const TIMEOUT_MS = 15_000;

export type TsToken = { access_token: string; expires_at: string; scope: string | null };
type Row = { access_token: string | null; refresh_token: string | null; expires_at: string | null; scope: string | null };

function sbHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", ...extra };
}

async function readRow(): Promise<Row> {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/tradestation_tokens?id=eq.1&select=access_token,refresh_token,expires_at,scope`,
    { headers: sbHeaders(), signal: AbortSignal.timeout(TIMEOUT_MS) },
  );
  if (!r.ok) throw new Error(`tradestation_tokens read HTTP ${r.status}`);
  const rows = await r.json();
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("TradeStation not connected (no tradestation_tokens row); run ts-oauth-start");
  return rows[0] as Row;
}

function usable(row: Row): row is Row & { access_token: string; expires_at: string } {
  if (!row.access_token || !row.expires_at) return false;
  const exp = Date.parse(row.expires_at);
  return Number.isFinite(exp) && exp > Date.now() + SAFETY_MS;
}

function toToken(row: Row & { access_token: string; expires_at: string }): TsToken {
  return { access_token: row.access_token, expires_at: row.expires_at, scope: row.scope ?? null };
}

// CAS write via RPC public.ts_cas_tokens (10_security.sql): UPDATE ... WHERE id=1 AND refresh_token=<old>.
// All token values travel in the POST body, never in the URL (the API gateway logs request URLs).
// Returns true if our row update won, false if refresh_token changed underneath us.
// Throws on a failed DB write (non-2xx) so the caller can decide; retried once first.
async function casWrite(oldRefresh: string, patch: Record<string, unknown>): Promise<boolean> {
  const url = `${SUPABASE_URL}/rest/v1/rpc/ts_cas_tokens`;
  const body = JSON.stringify({
    p_old_refresh: oldRefresh,
    p_access_token: patch.access_token,
    p_refresh_token: patch.refresh_token,
    p_expires_at: patch.expires_at,
    p_scope: patch.scope ?? null,               // null = keep the stored scope
  });
  let lastStatus = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: sbHeaders(),
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (r.ok) {
        return (await r.json().catch(() => false)) === true;
      }
      lastStatus = r.status;
      await r.body?.cancel();
    } catch (_e) {
      lastStatus = -1;
    }
  }
  throw new Error(`tradestation_tokens write failed (HTTP ${lastStatus})`);
}

async function refresh(row: Row): Promise<TsToken> {
  const oldRefresh = row.refresh_token;
  if (!oldRefresh) throw new Error("TradeStation refresh_token missing; re-link via ts-oauth-start");

  let status = 0, errCode = "";
  let j: Record<string, unknown> = {};
  try {
    const r = await fetch(TS_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: Deno.env.get("TRADESTATION_CLIENT_ID") ?? "",
        client_secret: Deno.env.get("TRADESTATION_CLIENT_SECRET") ?? "",
        refresh_token: oldRefresh,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = r.status;
    j = await r.json().catch(() => ({}));
    if (!r.ok) errCode = String(j.error ?? "");
  } catch (e) {
    errCode = e instanceof Error ? e.name : "fetch_error";
  }

  const access = typeof j.access_token === "string" ? j.access_token : "";
  if (!access) {
    // Rejected (invalid_grant etc.) or network failure: another worker may have rotated already.
    const again = await readRow();
    if (usable(again)) return toToken(again);
    throw new Error(`TradeStation refresh failed: HTTP ${status}${errCode ? ` ${errCode}` : ""}`);
  }

  const expiresIn = Number(j.expires_in);
  const expires_at = new Date(Date.now() + ((Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 1200) - EXPIRY_PAD_S) * 1000).toISOString();
  const newRefresh = typeof j.refresh_token === "string" && j.refresh_token ? j.refresh_token : oldRefresh;
  const scope = typeof j.scope === "string" ? j.scope : (row.scope ?? null);
  const patch: Record<string, unknown> = {
    access_token: access,
    refresh_token: newRefresh,
    expires_at,                                 // updated_at is set to now() by the RPC
  };
  if (typeof j.scope === "string") patch.scope = j.scope;

  let won: boolean;
  try {
    won = await casWrite(oldRefresh, patch);
  } catch (e) {
    // The access token is valid; a rotated refresh token could not be persisted. Surface loudly.
    console.error(`ts_auth: ${String(e)}${newRefresh !== oldRefresh ? " -- rotated refresh_token NOT saved; re-link may be needed" : ""}`);
    return { access_token: access, expires_at, scope };
  }
  if (won) return { access_token: access, expires_at, scope };

  // CAS lost: someone else refreshed first. Prefer the stored winner; our own token is still valid otherwise.
  const winner = await readRow();
  if (usable(winner)) return toToken(winner);
  return { access_token: access, expires_at, scope };
}

// Single flight per isolate: concurrent callers in one invocation share one refresh.
let inflight: Promise<TsToken> | null = null;

export async function getTsToken(): Promise<TsToken> {
  const row = await readRow();
  if (usable(row)) return toToken(row);
  if (!inflight) {
    inflight = refresh(row).finally(() => { inflight = null; });
  }
  return await inflight;
}

export async function getTsAccessToken(): Promise<string> {
  return (await getTsToken()).access_token;
}
