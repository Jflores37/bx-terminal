// Decommissioned probe.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
Deno.serve(() => new Response(JSON.stringify({ status: 'gone' }), { status: 410, headers: { 'content-type': 'application/json' } }));
