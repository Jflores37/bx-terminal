// Decommissioned probe. Replaced by bx-scan source=tradestation.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
Deno.serve(() => new Response(JSON.stringify({ status: 'gone', note: 'ts-probe decommissioned' }), { status: 410, headers: { 'content-type': 'application/json' } }));
