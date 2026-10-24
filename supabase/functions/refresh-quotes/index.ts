// Decommissioned (finding ed-4): legacy "Stock Edge" snapshot job with no callers, 0 invocations, an empty quotes
// table and a non-existent TS path. It spliced unvalidated symbols into the TradeStation URL. Now 410 Gone.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
Deno.serve(() => new Response(JSON.stringify({ status: 'gone', note: 'refresh-quotes decommissioned' }), { status: 410, headers: { 'content-type': 'application/json' } }));
