// Shared run log (contract C3) -> public.pipeline_runs via PostgREST with the service role.
//   const runId = await startRun("bx-scan", { timeframe, chunk, chunks });
//   ... work ...
//   await finishRun(runId, { status: fail ? "partial" : "ok", rows_written, rows_expected });
// Neither function ever throws into the caller: logging must not break the pipeline. If the
// table is missing or the write fails, the error goes to console.error and startRun returns null
// (finishRun(null, ...) is a no-op).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TIMEOUT_MS = 10_000;
const MAX_ERROR_LEN = 2000;

export type RunStatus = "running" | "ok" | "partial" | "error";
export type RunResult = {
  status: Exclude<RunStatus, "running">;
  rows_written?: number;
  rows_expected?: number;
  error?: string;
};

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

export async function startRun(fn: string, params?: unknown): Promise<number | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/pipeline_runs?select=id`, {
      method: "POST",
      headers: headers({ Prefer: "return=representation" }),
      body: JSON.stringify({ fn, params: params ?? null, status: "running" }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) {
      console.error(`pipeline_log startRun ${fn}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
      return null;
    }
    const rows = await r.json();
    const id = Array.isArray(rows) ? rows[0]?.id : rows?.id;
    return typeof id === "number" ? id : (id != null && Number.isFinite(Number(id)) ? Number(id) : null);
  } catch (e) {
    console.error(`pipeline_log startRun ${fn}: ${String(e)}`);
    return null;
  }
}

export async function finishRun(id: number | null, res: RunResult): Promise<void> {
  if (id == null) return;
  try {
    const body: Record<string, unknown> = { status: res.status, finished_at: new Date().toISOString() };
    if (res.rows_written != null) body.rows_written = Math.round(res.rows_written);
    if (res.rows_expected != null) body.rows_expected = Math.round(res.rows_expected);
    if (res.error != null) body.error = String(res.error).slice(0, MAX_ERROR_LEN);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/pipeline_runs?id=eq.${id}`, {
      method: "PATCH",
      headers: headers({ Prefer: "return=minimal" }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) console.error(`pipeline_log finishRun ${id}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  } catch (e) {
    console.error(`pipeline_log finishRun ${id}: ${String(e)}`);
  }
}
