// Decommissioned (findings edge-ts-3 / edge-ts-6): legacy WebSocket quote relay with no callers and 0 invocations.
// It spliced unvalidated ?symbols into the TradeStation URL with the service account's token. Now 410 Gone.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
Deno.serve(() => new Response(JSON.stringify({ status: 'gone', note: 'ts-stream decommissioned' }), { status: 410, headers: { 'content-type': 'application/json' } }));
