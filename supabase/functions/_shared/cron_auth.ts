// Shared cron gate (contract C1). Every cron-invoked function calls requireCron(req) first:
//   null          -> header x-cron-secret matches env CRON_SECRET (constant-time over bytes)
//   401 Response  -> header missing or wrong
//   500 Response  -> CRON_SECRET not configured (fail closed)
// No ?secret= query fallback: query strings land in edge logs.

const enc = new TextEncoder();

// Constant-time string compare over UTF-8 bytes. A length mismatch rejects (length is not secret).
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = enc.encode(a), bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export function requireCron(req: Request): Response | null {
  const secret = Deno.env.get("CRON_SECRET") ?? "";
  if (!secret) return json({ error: "CRON_SECRET not configured" }, 500);
  const got = req.headers.get("x-cron-secret") ?? "";
  if (!timingSafeEqualStr(got, secret)) return json({ error: "unauthorized" }, 401);
  return null;
}
