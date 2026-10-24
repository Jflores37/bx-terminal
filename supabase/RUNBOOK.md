# BX Terminal fix rollout: RUNBOOK

The production rollout for the 2026-10-24 audit fixes, in order. It merges every unit's rollout steps:
sec, db, edge-math, edge-data, frontend, ts-consumers, research-engine and research-phases.

- Project: `wefobwdspqzxbesbnzoc`. Repo: `C:\Users\jer_2\bx-terminal`. The repo is PUBLIC.
- Baseline (what production runs today) = `0834d06`. Round 1 = `95e59cb`. Round-2 edits are uncommitted in the working tree.
- Deploy command (run from `C:\Users\jer_2\bx-terminal`): `supabase functions deploy <slug> --project-ref wefobwdspqzxbesbnzoc --use-api`.
  verify_jwt comes from `supabase/config.toml`.
- SQL files are applied in this order: Supabase MCP `apply_migration` (name `bx_<file stem>`, query = the whole file), or paste
  the file into Dashboard > SQL editor. Both run as `postgres`.
- `invoke_edge_function(...)` calls go through Supabase MCP `execute_sql` as postgres. Each call commits, so pg_net sends it.
- All times are ET in 12-hour format unless marked UTC. DST ends Sun 11/1/2026.

**Secrets rule.** Secret values never go in this file, in a commit, in a chat transcript, or on a command line.
They live only in `%USERPROFILE%\.bx-secrets\edge.env` (outside every repo), in Supabase secrets/Vault, and in Vercel env.
Every verification below prints status codes, counts or booleans, never a value.

**Marker legend.** `[USER]` = only the user can do it (needs a value or a choice Claude must not see or make).
`[DECISION]` = the user picks before that step runs. `GATE` = stop if it fails.

---

## Phase 0: Timing, gates, local commit (read-only plus one local commit)

### 0.1 Timing window `GATE`
It is Saturday 10/24. No cron jobs fire on Saturday.
- Old schedule: the v4 builder jobs (`bx-backtest-weekly-daily-1`, `-daily-2`, `-weekly`, `-monthly`) fire **Sun 10/25 at
  8:00-8:10 AM EDT** (12:00-12:10 UTC). The old weekly scan fires at 10:00 AM EDT (14:00 UTC).
- New schedule (only after step 5.1 applies 23): the first builder chunk fires **Sun 10/25 at 2:00 AM EDT** (06:00 UTC).
- Phases 1-5 must finish before 2:00 AM EDT Sunday.
- If the rollout cannot reach Phase 5 by 7:30 AM EDT Sunday, first unschedule the 4 old builder jobs (read the job names
  from `supabase/snapshot/cron_jobs.sql`):
  `select cron.unschedule(jobname) from cron.job where jobname like 'bx-backtest-%';`
  Rollback: re-create them from `supabase/snapshot/cron_jobs.sql`.
- Timing for the consumer cutover (Phase 3): avoid 2:45-3:15 AM ET (trading-journal cron) and market hours (InPlayScanner).
  Saturday is ideal.

### 0.2 Builder cut-off gate `GATE` (read-only)
```sql
select max(computed_at) from public.bx_backtest_results;
```
The result must be `< '2026-10-24 00:00:00+00'` (it was 2026-10-18 12:03 PM UTC).
If it fails, STOP. `V5_EPOCH` in `bx-backtest-builder/index.ts` and the cut-offs in `24_data_cleanup.sql` and
`40_edge_math.sql` must then be moved together before going further.

### 0.3 Local checks (no network writes)
```bash
cd /c/Users/jer_2/bx-terminal
supabase --version                                   # 2.90.x
supabase functions list --project-ref wefobwdspqzxbesbnzoc   # 13 functions, matches supabase/snapshot/env.md
npx -y deno@2 test supabase/tests/bx_math.test.ts    # all pass
npm run build                                        # must pass
```

### 0.4 Commit the round-2 tree locally (do NOT push yet; the push in Phase 7 deploys the SPA)
Include only fix files. The untracked `research/notes/04-*.md` and `05-*.md` are not part of this effort and stay out.
```bash
cd /c/Users/jer_2/bx-terminal
git add supabase src vercel.json research/*.py research/tests research/PLAN.md research/reports/ERRATA_2026-10-24.md
git diff --cached --stat
# Secret scan of everything that will become public (must print nothing):
git diff 0834d06 --cached -U0 | grep -nE '^\+.*(eyJ[A-Za-z0-9_-]{20,}|sk_(live|test)_|hooks\.slack\.com/services/|key=[A-Za-z0-9]{16,}|secret[^_A-Za-z].{0,3}[=:]\s*["'"'"'][A-Za-z0-9]{16,})'
git commit -m "Audit fixes round 2 (not deployed)"
```
Note the commit hash as `ROLLOUT_SHA`. Every deploy below comes from this tree.

---

## Phase 1: Secrets

### 1.1 Generate CRON_SECRET and TS_TOKEN_KEY locally (PowerShell; prints nothing)
Use NEW random values. Never reuse the old ts-token key: it is in `function_edge_logs` and in the old TS_TOKEN_URL values.
```powershell
$dir = Join-Path $env:USERPROFILE '.bx-secrets'
New-Item -ItemType Directory -Force $dir | Out-Null
icacls $dir /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
function New-Hex32 { $b = New-Object byte[] 32; $rng.GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') }) }
$f = Join-Path $dir 'edge.env'
if (-not (Test-Path $f)) {
  [IO.File]::WriteAllLines($f, @("CRON_SECRET=$(New-Hex32)", "TS_TOKEN_KEY=$(New-Hex32)", "TS_OWNER_ACCOUNTS=", "FINVIZ_AUTH_TOKEN="))
}
```
Reusable helpers for later PowerShell steps:
```powershell
$f = Join-Path $env:USERPROFILE '.bx-secrets\edge.env'
function Get-Sec($n) { ((Get-Content $f | Where-Object { $_ -like "$n=*" }) -split '=', 2)[1] }
function Set-EnvLine($path, $name, $value) {
  $lines = @(Get-Content $path | Where-Object { $_ -notlike "$name=*" }); $lines += "$name=$value"
  [IO.File]::WriteAllLines($path, $lines)   # UTF-8 without BOM (a BOM breaks the first dotenv key)
}
```

### 1.2 `[USER]` Fill the two values Claude must not see
Run `notepad $env:USERPROFILE\.bx-secrets\edge.env` and fill in:
- `TS_OWNER_ACCOUNTS=`: comma-separated LIVE TradeStation AccountIDs that may re-link OAuth, with no spaces.
  If this is wrong, re-links fail closed: nothing breaks today, but a future re-link is refused.
- `FINVIZ_AUTH_TOKEN=`: the current Finviz Elite token. Copy it from Dashboard > Table editor > `app_settings`, row
  `key = finviz_auth_token`, or from your Finviz account. Do not paste it into chat.

### 1.3 `[DECISION]` TRADESTATION_ENV
The variable is unset today, so bx-scan reads bars from `sim-api.tradestation.com`. The OAuth identity check always uses
the live API.
- Option A: leave it unset (sim). This keeps today's behavior.
- Option B: add the line `TRADESTATION_ENV=live` to `edge.env`. bx-scan only issues GET barcharts (read-only, no order
  endpoints), so live is the authoritative feed with no trading risk.
- **Recommendation: B.** It must be decided before step 1.4, because the bx-scan probes in 4.3 validate whichever feed
  is set. Rollback: `supabase secrets unset --project-ref wefobwdspqzxbesbnzoc TRADESTATION_ENV`.

### 1.4 Set the edge secrets (one command; the values come from the file)
Check the file without printing values:
```powershell
Get-Content $f | ForEach-Object { $k, $v = $_ -split '=', 2; '{0}: set={1} len={2}' -f $k, [bool]$v, "$v".Length }
# expect CRON_SECRET len 64, TS_TOKEN_KEY len 64, TS_OWNER_ACCOUNTS set=True, FINVIZ_AUTH_TOKEN set=True
```
```powershell
cd C:\Users\jer_2\bx-terminal
supabase secrets set --project-ref wefobwdspqzxbesbnzoc --env-file "$env:USERPROFILE\.bx-secrets\edge.env"
supabase secrets list --project-ref wefobwdspqzxbesbnzoc
```
The list shows names and digests only. Expect CRON_SECRET, TS_TOKEN_KEY, TS_OWNER_ACCOUNTS and FINVIZ_AUTH_TOKEN
(plus TRADESTATION_ENV under option B).

Side effect: setting CRON_SECRET makes the OLD deployed bx-scan, bx-alerter and bx-finviz-sync enforce `x-cron-secret`
immediately. Go straight on to 1.5 and Phase 2. Nothing fires on Saturday.
The old ts-token ignores TS_TOKEN_KEY (it has a hard-coded key), so that secret is inert until 3.1.

Rollback: `supabase secrets unset --project-ref wefobwdspqzxbesbnzoc CRON_SECRET` turns off the old gates again.
The new functions fail closed (500) without it.

### 1.5 `[USER]` Vault secret `cron_secret` (same value as CRON_SECRET)
Copy the value to the clipboard without displaying it:
```powershell
Get-Sec CRON_SECRET | Set-Clipboard
```
In Dashboard > Integrations > Vault > Add new secret, set name `cron_secret`, paste the value, and use the description
`x-cron-secret header sent by public.invoke_edge_function`.
Fallback in the Dashboard SQL editor:
`select vault.create_secret('<paste>', 'cron_secret', 'x-cron-secret header sent by public.invoke_edge_function');`
Then clear the clipboard: `Set-Clipboard -Value ' '`.

Verify (read-only, prints no value):
```sql
select count(*) from vault.decrypted_secrets where name = 'cron_secret';   -- 1
select left(encode(extensions.digest(decrypted_secret, 'sha256'), 'hex'), 12) from vault.decrypted_secrets where name = 'cron_secret';
```
Compare that digest prefix with the local value's digest:
```powershell
$s = [Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes((Get-Sec CRON_SECRET)))
(-join ($s | ForEach-Object { $_.ToString('x2') })).Substring(0, 12)
```
The two must match. A mismatch means every cron call returns 401, which would show in `edge_call_log`.

Rollback: `select vault.update_secret((select id from vault.secrets where name='cron_secret'), '<new>')` (rotate), or delete
the secret in the Vault UI.

---

## Phase 2: SQL before any deploy (order is fixed: 10, 20, 21, 22, 30, 40)

### 2.1 `10_security.sql` `GATE`
This file must land before ANY function that bundles `_shared/ts_auth.ts` is deployed (ts-token, bx-scan,
ts-oauth-*), because their refresh writes call RPC `public.ts_cas_tokens`. Its self-check aborts and rolls back the whole
file if a grant invariant fails. Section 3b skips itself if the user already dropped
`private.tradestation_tokens_bak_20261002`.

Gate (read-only):
```sql
select to_regprocedure('public.ts_cas_tokens(text,text,text,timestamptz,text)') is not null a,
       has_function_privilege('service_role','public.ts_cas_tokens(text,text,text,timestamptz,text)','EXECUTE') b,
       has_function_privilege('anon','public.ts_cas_tokens(text,text,text,timestamptz,text)','EXECUTE') c,
       (select count(*) from pg_constraint where conrelid = to_regclass('private.tradestation_tokens_bak_20261002') and contype='p') d;
```
Expect `a=true, b=true, c=false, d=1`. `d=0` also passes if the table was dropped, or if the NOTICE
'...has null/duplicate id; PK not added' appeared.
Always use `to_regclass`, never a `'...'::regclass` literal: the literal errors when the table is absent.

Optional PostgREST schema-cache check (writes nothing):
```bash
curl -s -w '\n%{http_code}\n' -X POST -H "apikey: $ANON" -H "Authorization: Bearer $ANON" -H 'Content-Type: application/json' \
  -d '{"p_old_refresh":"x","p_access_token":"x","p_refresh_token":"x","p_expires_at":"2000-01-01T00:00:00Z","p_scope":null}' \
  https://wefobwdspqzxbesbnzoc.supabase.co/rest/v1/rpc/ts_cas_tokens
```
Expect 401 with code 42501.
- Only a 404 PGRST202 on THIS five-argument body means a stale cache. In that case run `NOTIFY pgrst, 'reload schema';`
  and retry.
- Never probe with `{}`: PostgREST resolves the overload by argument names first, so an empty body always returns 404.
- `$ANON` is the public anon/publishable key that the SPA already ships. Get it from Supabase MCP `get_publishable_keys`
  or the Vercel env `VITE_SUPABASE_ANON_KEY`.

### 2.2 `20_pipeline_infra.sql`
Verify:
```sql
select pg_get_function_identity_arguments(oid), prosecdef, proconfig from pg_proc where proname='invoke_edge_function';
select jobname, schedule from cron.job where jobname='pipeline-reconcile-edge-calls';             -- 1 row, */10
select has_function_privilege('anon','public.invoke_edge_function(text,text)','EXECUTE');         -- false
```

### 2.3 `21_views.sql`
Builds the index first, then replaces the views. Expect a few seconds of write lock on bx_backtest_results.
```sql
begin; set local role anon; select check_name, timeframe, status, detail from public.pipeline_health; rollback;
-- ~18-20 rows. Truthful errors/warns right now are expected (daily coverage, backtest freshness, last_run:* 'no successful run').
```
If that fails with 'permission denied for schema private', run
`ALTER VIEW public.pipeline_health SET (security_invoker = false);` and re-check.
```sql
select timeframe, sum(ticker_count) from public.sector_pulse group by 1;      -- daily ~820, weekly ~1041, monthly ~1048
select timeframe, count(*) from public.zone_transitions group by 1;           -- daily ~61, weekly ~163, monthly ~138
select column_name from information_schema.columns where table_schema='public' and table_name='latest_scans_with_meta'
 order by ordinal_position;                                                   -- last 3: is_stale, max_scan_date, earnings_stale
begin; set local role anon;
explain analyze select * from public.latest_scans_with_meta where timeframe='daily' order by scan_date desc limit 10000;
explain analyze select * from public.pipeline_health;
rollback;                                                                     -- each well under 1 s
```

### 2.4 `22_backtest_summary.sql` (about 10 s; SPA summary reads wait meanwhile)
```sql
select timeframe, signal_type, n_signals, avg_60d, med_60d, last_computed_at from public.bx_backtest_summary order by 1,2;
-- weekly bullish_to_bearish: avg_60d ~20.38, med_60d ~8.32, n_signals ~5,841 (outlier rule v1 a+b+c)
select * from public.bx_backtest_baseline_summary;   -- 0 rows until the first v5 builder run
```

### 2.5 `30_edge_data.sql` (must precede the edge-data deploys)
```sql
select column_name from information_schema.columns where table_schema='public' and table_name in ('alert_state','ticker_meta')
   and column_name in ('status','claimed_at','scan_date','next_earnings_source');   -- 4 rows
select count(*) from private.ticker_meta_earnings_bak_20261024;                    -- ~508
```

### 2.6 `40_edge_math.sql`: pre-v5 backup `GATE` (must precede the bx-backtest-builder deploy)
This file creates `private.bx_backtest_results_pre_v5_bak` (~66 MB plus its PK; the DB grows from 163 MB to ~240 MB,
under the 500 MB cap). It copies every row with computed_at < 2026-10-24 00:00 UTC and revokes the API roles. It raises
and rolls back if any row is missing.
- Expected NOTICE: `pre-v5 rows 308920 (copied now 308920), backup rows 308920, rows at/after cut-off 0`.
  apply_migration may not show NOTICEs; the count check below is the gate.
- A WARNING about rows at or after the cut-off means STOP: gate 0.2 failed.
```sql
select (select count(*) from private.bx_backtest_results_pre_v5_bak) bak,
       (select count(*) from public.bx_backtest_results where computed_at < '2026-10-24 00:00:00+00') pre;   -- equal: 308,920
```
Do NOT deploy the builder until the two counts are equal.

SQL rollback for Phase 2, in reverse order: 40 -> 30 -> 22 -> 21 -> 20 -> 10, using each file's header Rollback block (see Phase 10).

---

## Phase 3: TradeStation token cutover (sec + ts-consumers)

Since round 1, the consumer working trees already send only the `x-ts-key` header. A trader-backtest-lab process started
from the new `data_layer.py` therefore gets 401 from the OLD ts-token until 3.1 lands, and falls back to local refresh or
yfinance. Keep this phase short and contiguous.

### 3.0 Prepare the consumers (no restarts yet)
Run local tests first:
```powershell
cd C:\Users\jer_2\trading-journal; npx tsc --noEmit; npx vitest run src/lib/tradestation-api.test.ts
cd C:\Users\jer_2\trader-backtest-lab; python -m py_compile src\data_layer.py; python -m pytest src\scan\test_data_layer.py -q
```
Update the env files (prints nothing):
```powershell
# trader-backtest-lab: new key. The URL already has no key= (verify the second line prints False).
Set-EnvLine 'C:\Users\jer_2\trader-backtest-lab\.env' 'TS_TOKEN_BROKER_KEY' (Get-Sec TS_TOKEN_KEY)
[bool](Select-String -Path 'C:\Users\jer_2\trader-backtest-lab\.env' -Pattern '^TS_TOKEN_BROKER_URL=.*key=' -Quiet)
# trading-journal .env.local (used only by collector/src/backfill-equity.ts, which runs by hand):
Set-EnvLine 'C:\Users\jer_2\trading-journal\.env.local' 'TS_TOKEN_KEY' (Get-Sec TS_TOKEN_KEY)
Set-EnvLine 'C:\Users\jer_2\trading-journal\.env.local' 'TS_TOKEN_URL' 'https://wefobwdspqzxbesbnzoc.supabase.co/functions/v1/ts-token'
```
`[USER]` In Vercel project **claude-dashboard** (team jflores37s-projects), Settings > Environment Variables, for
Production (and Preview if used):
- Add `TS_TOKEN_KEY` = the value from `Get-Sec TS_TOKEN_KEY | Set-Clipboard`.
- Edit `TS_TOKEN_URL` to the bare `https://wefobwdspqzxbesbnzoc.supabase.co/functions/v1/ts-token`. The code strips
  key=, but leaving it in keeps the old key stored.

Clear the clipboard afterwards. The dashboard is preferred over `vercel env add` because piping from PowerShell 5.1
appends CRLF to the value. Do not redeploy yet.

### 3.1 Deploy ts-token
```bash
cd /c/Users/jer_2/bx-terminal
supabase functions deploy ts-token --project-ref wefobwdspqzxbesbnzoc --use-api
```
From this moment, callers still sending `?key=` get 400.

### 3.2 Immediately restart InPlayScanner (trader-backtest-lab)
```powershell
Stop-ScheduledTask -TaskName InPlayScanner; Start-ScheduledTask -TaskName InPlayScanner
(Get-ScheduledTask -TaskName InPlayScanner).State                       # Running
Get-CimInstance Win32_Process -Filter "Name like 'python%'" | Where-Object CommandLine -like '*run_live*' |
  Select-Object ProcessId, CreationDate                                   # CreationDate = just now
curl.exe -s -o NUL -w "%{http_code}`n" http://localhost:8788/            # 200 (or the app's normal code)
```
Do not touch the InPlayTunnel task. TraderLabDaily, SDJGuru and Paper3Books pick up the new code and env on their next run.

`[DECISION]` Optionally commit trader-backtest-lab's 3 files only (branch `master`; the tree has many unrelated changes):
`git add src/data_layer.py src/scan/test_data_layer.py README.md; git commit -m "ts-token: x-ts-key header + expires_at caching"`.

### 3.3 Redeploy trading-journal (commit ONLY the 4 unit files; the tree has unrelated uncommitted changes)
```powershell
cd C:\Users\jer_2\trading-journal
git add src/lib/tradestation-api.ts src/lib/tradestation-api.test.ts src/app/api/cron/tradestation/route.ts collector/src/backfill-equity.ts
git diff --cached --stat        # exactly those 4 files
git commit -m "ts-token: send x-ts-key header, strip key= from TS_TOKEN_URL"
git push origin main            # Vercel auto-deploys with the new env
```
Leave `OPEN JOURNAL.cmd`, `package.json`, `src/app/auth/dev/*` uncommitted.

### 3.4 Deploy the OAuth pair, then the stubs
```bash
supabase functions deploy ts-oauth-start --project-ref wefobwdspqzxbesbnzoc --use-api
supabase functions deploy ts-oauth-callback --project-ref wefobwdspqzxbesbnzoc --use-api
supabase functions deploy ts-stream --project-ref wefobwdspqzxbesbnzoc --use-api       # 410 stub
supabase functions deploy refresh-quotes --project-ref wefobwdspqzxbesbnzoc --use-api  # 410 stub
```
The OAuth pair needs 10_security's table and RPC plus TS_OWNER_ACCOUNTS. ts-probe and finviz-probe are already 410 stubs
in production (baseline = deployed), so they need no deploy.

**Do NOT run a re-link now.** The current token row is healthy. The new PKCE + owner-check flow runs only at the next
deliberate re-link.

### 3.5 Verify (bash; prints no secrets)
```bash
export TS_TOKEN_KEY=$(grep '^TS_TOKEN_KEY=' ~/.bx-secrets/edge.env | cut -d= -f2- | tr -d '\r')
B=https://wefobwdspqzxbesbnzoc.supabase.co/functions/v1; U=$B/ts-token
curl -s -o /dev/null -w '%{http_code}\n' "$U?key=x"                     # 400
curl -s -o /dev/null -w '%{http_code}\n' "$U"                           # 401
curl -s -H "x-ts-key: $TS_TOKEN_KEY" "$U" | python -c "import sys,json;d=json.load(sys.stdin);print(sorted(d), 'Trade' in (d.get('scope') or ''))"
                                                                         # ['access_token', 'expires_at', 'scope'] True
curl -s -D - -o /dev/null -H "x-ts-key: $TS_TOKEN_KEY" "$U" | grep -ci access-control   # 0
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $ANON" $B/ts-stream        # 410
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $ANON" $B/refresh-quotes   # 410
curl -s -o /dev/null -w '%{http_code}\n' "$B/ts-oauth-callback?state=bad"                     # 400
curl -s -o /dev/null -w '%{http_code}\n' $B/ts-oauth-start                                    # 302 (parks one state row, expires in 10 min)
curl -s -o /dev/null -w '%{redirect_url}' $B/ts-oauth-start | grep -c code_challenge_method=S256   # 1
unset TS_TOKEN_KEY
```
Grants and advisors (read-only):
```sql
select has_table_privilege('anon','public.app_settings','SELECT') a, has_table_privilege('anon','public.bx_scans','INSERT') b,
       has_table_privilege('anon','public.latest_scans_with_meta','SELECT') c, to_regclass('public.tradestation_tokens_bak') d,
       to_regclass('private.tradestation_tokens_bak') e,
       has_function_privilege('anon','public.ts_store_linked_tokens(text,text,timestamptz,text)','EXECUTE') f,
       has_function_privilege('anon','public.ts_cas_tokens(text,text,text,timestamptz,text)','EXECUTE') g,
       has_function_privilege('service_role','public.ts_cas_tokens(text,text,text,timestamptz,text)','EXECUTE') h;
-- expect false, false, true, null, non-null, false, false, true
```
- `get_advisors(security)`: expect only INFO rls_enabled_no_policy plus the matview WARN. The no_primary_key lint on
  `tradestation_tokens_bak_20261002` is gone unless that table was dropped or had duplicate ids.
- SPA read smoke test:
  `curl -s -o /dev/null -w '%{http_code}' -H "apikey: $ANON" "https://wefobwdspqzxbesbnzoc.supabase.co/rest/v1/latest_scans_with_meta?timeframe=eq.daily&select=ticker&limit=1"`
  should print 200. Column b already proves anon cannot write, so never POST to bx_scans.

Consumers:
- trading-journal: trigger its cron against the production deployment with
  `curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $JOURNAL_CRON_SECRET" https://<claude-dashboard prod domain>/api/cron/tradestation`.
  Expect 200, not 502 'ts-token HTTP 400/401'. `$JOURNAL_CRON_SECRET` is the journal's OWN Vercel CRON_SECRET, unrelated
  to Supabase's. Get the domain from `vercel ls claude-dashboard`.
- InPlayScanner log: no 'TS token broker failed'. On the next market day, TS data must keep flowing for more than 20 min
  (this proves the token re-mints at expires_at).

After ~20 min of use, check the logs with read-only `query_logs`:
```sql
select countIf(position(event_message,'refresh_token=eq.')>0) rt_in_url, countIf(position(event_message,'rpc/ts_cas_tokens')>0) cas_calls
from logs where source='edge_logs';     -- rt_in_url = 0, cas_calls >= 1
-- If the endpoint rejects ClickHouse syntax: COUNTIF(STRPOS(event_message,'...')>0)
```
Also count `function_edge_logs` ts-token rows whose event_message contains `ts-token?key=` after the deploy time.
Expect 0 once InPlayScanner restarts, with statuses at 200. TS refreshes drop to about 1 per 18 min of use.
```sql
select expires_at > now() ok, updated_at from public.tradestation_tokens where id = 1;   -- ok = true, recent updated_at
```

Rollback for Phase 3:
- ts-token: there is NO usable older version (baseline has a placeholder key). Fix forward via envs.
- OAuth pair: fix forward. If TS rejects the PKCE exchange at a future re-link, remove the two `code_challenge*` lines in
  ts-oauth-start and the `code_verifier` field in the callback, then redeploy.
- Stubs: `git show 0834d06:supabase/functions/<fn>/index.ts`. Not recommended: both originals are vulnerable and unused.
- **Never** roll `_shared/ts_auth.ts` back to a URL-filter CAS. That re-leaks the refresh token into edge_logs.
- trading-journal: `git revert` the commit and push (the old code needs the old TS_TOKEN_URL with key=, which no longer
  works). Fix forward instead.

---

## Phase 4: Pipeline function deploys

### 4.1 Record the deploy time
`select now();`: keep the result as `DEPLOY_TS` for the verification queries.

### 4.2 Deploy bx-scan and bx-backtest-builder (only after 2.6 is verified)
Each bundles `_shared/bx_math.ts`, `cron_auth.ts`, `pipeline_log.ts` and `ts_auth.ts`. verify_jwt = false.
```bash
supabase functions deploy bx-scan --project-ref wefobwdspqzxbesbnzoc --use-api
supabase functions deploy bx-backtest-builder --project-ref wefobwdspqzxbesbnzoc --use-api
```

### 4.3 Dry-run probes `GATE` (write nothing)
Read each result with `select id, status_code, left(content, 600) from net._http_response order by id desc limit 1;`
after about 1-2 min. `edge_call_log` gets the same result at the next 10-min reconcile.
```sql
select public.invoke_edge_function('bx-scan','timeframe=monthly&source=tradestation&symbols=AAPL,MSFT,NVDA&dryrun=1');
-- expect ok 3, scan_date 2026-09-30, fell_back 0 (this also checks that TS weekly/monthly TimeStamps fall inside their period)
select public.invoke_edge_function('bx-scan','timeframe=monthly&source=yahoo&symbols=AAPL,MSFT,NVDA&dryrun=1');
-- expect ok 3, yahoo_wrong_granularity 0, scan_date 2026-09-30, bx within vendor-adjustment noise of the TS probe
select public.invoke_edge_function('bx-backtest-builder','timeframe=monthly&chunk=0&chunks=12&dryrun=1');
select public.invoke_edge_function('bx-backtest-builder','timeframe=daily&chunk=0&chunks=12&dryrun=1');
-- expect each: integrity_rejected, fetch_failed, secondary_rejected each <= 1 of ~91 selected; short_history > 0 only for
-- recent listings; cpu_ms_est < 1000; elapsed_ms < 60000
```
- A 401 or 500 means CRON_SECRET and the vault value differ (redo 1.5).
- Any count above 1: STOP. Do not apply 23. Either redeploy the 0834d06 versions of both functions (the old schedule
  keeps working) or unschedule the old jobs (0.1).
- High CPU or a 546: use chunks=18 for the builder (in 23 and in 6.4).

### 4.4 Deploy the edge-data functions (after 2.5 and 1.4/FINVIZ_AUTH_TOKEN)
```bash
supabase functions deploy bx-exchange-backfill bx-finviz-sync bx-earnings-sync bx-alerter --project-ref wefobwdspqzxbesbnzoc --use-api
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://wefobwdspqzxbesbnzoc.supabase.co/functions/v1/bx-exchange-backfill   # 401
```
A 500 'CRON_SECRET not configured' means the edge secret is missing.

Rollback for Phase 4: `git show 0834d06:supabase/functions/<slug>/index.ts`, put it in place, and redeploy. Pair the
builder rollback with 40's rollback (A) and the edge-data rollback with 30's rollback block (Phase 10).

---

## Phase 5: Schedule, cleanup, perf SQL

### 5.1 `23_cron_schedule.sql`: right after Phase 4 passes
It replaces all 29 old jobs, including the v4 builder jobs, with chunk/fill jobs.
```sql
select count(*) from cron.job;                                   -- 74
select count(*) from cron.job where command ilike '%offset=%';   -- 0
select jobname, schedule from cron.job order by jobname;
```
Optional smoke test: `select public.invoke_edge_function('bx-alerter','timeframe=daily');`. After 10+ min:
`select request_id, fn, status_code, ok, error from public.edge_call_log order by enqueued_at desc limit 5;`
should show 200 / ok=true.

### 5.2 `24_data_cleanup.sql`
NOTICEs print the matched, backed-up and deleted counts for both parts. Any mismatch aborts.
- Part 1: monthly em-5 rows (~22,366). These rows are also in pre_v5_bak because 40 ran first.
- Part 2: 1,096 bx_scans monthly rows dated 2026-10-01, built from an in-progress bar. This is the edge-math "monthly
  board fix", so do not run it separately.
```sql
select count(*) from private.bx_backtest_results_em5_bak;                                 -- ~22,366
select count(*) from public.bx_backtest_results where timeframe='monthly' and extract(day from signal_date)<>1
   and computed_at < timestamptz '2026-10-24 00:00:00+00';                                -- 0
select count(*) from private.bx_scans_monthly_20261001_bak;                               -- 1,096
select count(*) from public.bx_scans where timeframe='monthly' and scan_date=date '2026-10-01';   -- 0
```
Until 6.1 writes monthly 09/30, the monthly board shows the 09/01 rows and pipeline_health monthly scan_freshness = warn.

### 5.3 `25_advisors_perf.sql`
- `get_advisors(performance)`: no auth_rls_initplan.
- `select indexname from pg_indexes where tablename in ('bx_backtest_results','bx_scans') order by 1;`:
  idx_backtest_ticker, idx_backtest_tf and bx_scans_ticker_idx are gone, and bx_backtest_results_tf_computed_idx is present.

---

## Phase 6: Data repair and function verification

### 6.1 Fill-pass scans (about 1 hour)
It is the weekend, so there are no in-progress bars and TradeStation does not throttle.
- Run 18 chunk calls, **3 minutes apart**, for i = 0..5, in this order: daily, then weekly, then monthly.
- Wait between calls with a timer or Monitor. Foreground sleep is blocked.
```sql
select public.invoke_edge_function('bx-scan','timeframe=daily&source=tradestation&chunk=<i>&chunks=6');
select public.invoke_edge_function('bx-scan','timeframe=weekly&source=tradestation&chunk=<i>&chunks=6');
select public.invoke_edge_function('bx-scan','timeframe=monthly&source=tradestation&chunk=<i>&chunks=6');
```
Then run one fill per timeframe: `select public.invoke_edge_function('bx-scan','timeframe=<tf>&source=tradestation&mode=fill');`
Repeat a fill only while that timeframe's coverage is below 98%. Tickers with fewer than 40 completed bars (mostly monthly)
always fail, so monthly sits a bit below 100%.

Verify:
```sql
select timeframe, scan_date, count(*) from bx_scans where scan_date >= '2026-09-29' group by 1,2 order by 1,2;
-- daily 2026-10-23 >= 1,060; weekly 2026-10-23 >= 1,060; monthly 2026-09-30 >= 1,000
select fn, params, status, rows_written, rows_expected, error from pipeline_runs where fn='bx-scan' and started_at >= '<DEPLOY_TS>' order by id;
```

### 6.2 Edge-data verification runs (one safe run each, in this order)
1. **bx-exchange-backfill.** Writes only exchange and 52-week fields for active tickers, and is idempotent.
   - Call `select public.invoke_edge_function('bx-exchange-backfill');`. Expect 200 in 50-90 s with
     `{success:true, status:'ok'|'partial', total:~1081, updated:~1078+, failed:small, skipped_deadline:0}`.
   - Check:
     ```sql
     select count(*) filter (where m.exchange is null) null_ex,
            count(*) filter (where m.price > m.fifty_two_week_high*1.02) above_hi,
            count(*) filter (where m.price < m.fifty_two_week_low*0.98) below_lo
     from public.universe u join public.ticker_meta m using(ticker) where u.active;
     ```
     It was 3 / 37 / 25 before; expect ~0 / ~0 / ~0.
2. **bx-finviz-sync.**
   - Call `select public.invoke_edge_function('bx-finviz-sync');`. Expect 200 with `status:'ok'`, `warnings:[]`,
     finviz_rows ~1081 and earnings_past_cleared ~508 on the first run.
   - A warning 'finviz token read from app_settings...' means FINVIZ_AUTH_TOKEN is not set: fix 1.4 and re-run.
   - Check:
     ```sql
     select count(*) from public.ticker_meta where next_earnings_date < (now() at time zone 'America/New_York')::date;   -- 0
     select count(*) from public.pipeline_runs where fn='bx-finviz-sync' and error ilike '%auth=%';                      -- 0
     select count(*) from public.edge_call_log where fn='bx-finviz-sync' and response_excerpt ilike '%auth=%';          -- 0
     ```
3. **bx-earnings-sync.**
   - Call `select public.invoke_edge_function('bx-earnings-sync');`. Expect 200, `status:'ok'`, `failed_dates:[]`,
     `days_scanned:90`, finished in under 30 s.
   - Then `select next_earnings_source, count(*) from public.ticker_meta where next_earnings_date is not null group by 1;`:
     the finviz count is unchanged from step 2 and a nasdaq row appears.
4. **bx-alerter.** SLACK_WEBHOOK_URL is unset, so nothing posts or claims.
   - Call `select public.invoke_edge_function('bx-alerter','timeframe=daily');`. Expect 200
     `{skipped:'no SLACK_WEBHOOK_URL set', transitions:61, qualifying:48, stale_skipped:27, max_scan_date:{daily:'2026-10-23'}}`
     (values from today's data; they move after 6.1).
   - Cross-check:
     ```sql
     with mx as (select max(scan_date) md from public.bx_scans where timeframe='daily')
     select count(*) filter (where z.scan_date=mx.md) at_max, count(*) filter (where z.scan_date=mx.md and abs(z.bx-z.prev_bx)>=3) qual
     from public.zone_transitions z, mx where z.timeframe='daily';
     ```
     It must match transitions/qualifying in the response.
   - Repeat for weekly and monthly. Then `select count(*) from public.alert_state;` should be 0, and pipeline_runs
     fn='bx-alerter' shows ok.

### 6.3 `[DECISION]` Move the Finviz token out of app_settings (db-13)
Do this only after 6.2 step 2 returns `status:'ok'` with no app_settings warning.
The baseline bx-finviz-sync reads this row, so a rollback of that function needs it restored from the backup.
**Recommendation: do it now.** The backup keeps rollback possible.
```sql
create table if not exists private.app_settings_finviz_bak_20261024 as select * from public.app_settings where key='finviz_auth_token';
revoke all on private.app_settings_finviz_bak_20261024 from public, anon, authenticated;
select count(*) from private.app_settings_finviz_bak_20261024;          -- 1 (STOP if 0)
delete from public.app_settings where key='finviz_auth_token';
```
- Re-run `select public.invoke_edge_function('bx-finviz-sync');` and expect `status:'ok'`.
- Then `select count(*) from public.app_settings where key='finviz_auth_token';` should be 0.
- Rollback: `insert into public.app_settings select * from private.app_settings_finviz_bak_20261024 on conflict do nothing;`

### 6.4 `[DECISION]` Full backtest rebuild (36 calls, about 1 h 50 min)
- **Recommendation:** run it manually now, while someone is watching. The Sun 2:00-4:55 AM EDT cron would rerun it
  idempotently anyway.
- Alternative: skip this step and let that cron do it, then run the 6.5 checks Sunday morning.
- PRECONDITION: `select count(*) from private.bx_backtest_results_pre_v5_bak;` = 308,920.
- Sizing: 1,081 active tickers / 12 = ~91 per call, ~270 Yahoo requests, 15-60 s each.
- Call `select public.invoke_edge_function('bx-backtest-builder','timeframe=<tf>&chunk=<i>&chunks=12');` for i = 0..11,
  **3 minutes apart**: daily at T+0..33 min, weekly at T+36..69, monthly at T+72..105.
- After EACH call, run
  `select params, status, rows_written, rows_expected, error from pipeline_runs where fn='bx-backtest-builder' order by id desc limit 1;`
  If the error shows more than a few 'N fetch failed' (Yahoo throttling), wait 10 min and re-run that same chunk.
  Re-runs are idempotent.

Expected first-run churn, all recoverable from pre_v5_bak:
- Weekly Monday-keyed rows are relabeled to the week's last trading day.
- Monthly day-1 rows are relabeled to the month's last trading day, and quarterly/weekly-cadence rows are deleted.
- Short-history tickers' rows are deleted.
- Daily pre-v5 rows older than v5's window (2024-07..~2024-12) are deleted. They cannot be regenerated; restore them with
  40's rollback (B) if wanted.

Afterwards (as postgres, outside a transaction):
```sql
VACUUM (ANALYZE) public.bx_backtest_results;
REFRESH MATERIALIZED VIEW CONCURRENTLY public.bx_backtest_summary;
REFRESH MATERIALIZED VIEW CONCURRENTLY public.bx_backtest_baseline_summary;
```

### 6.5 Verify the rebuild
```sql
-- runs: mostly 'ok'; a 'partial' only with small not-started / fetch-failed counts (re-run those chunks)
select params->>'timeframe' tf, params->>'chunk' c, status, rows_written, rows_expected, error
  from pipeline_runs where fn='bx-backtest-builder' and started_at >= '<DEPLOY_TS>' order by id;
-- monthly cadence gone: all three = 0 (compare (3) with its pre-rebuild value)
select count(*) from bx_backtest_results r join universe u using (ticker) where u.active and r.timeframe='monthly' and extract(day from r.signal_date) < 15;
select count(*) from bx_backtest_results where signal_date > (now() at time zone 'America/New_York')::date;
select count(*) from (select ticker, percentile_cont(0.5) within group (order by gap) med from (select ticker, signal_date - lag(signal_date) over (partition by ticker order by signal_date) gap from bx_backtest_results where timeframe='monthly') x where gap is not null group by 1) y join universe u using (ticker) where u.active and med < 26;
-- labels: weekly mostly Friday (5), some Thursday (4); no 6/7 anywhere
select timeframe, extract(isodow from signal_date) dow, count(*) from bx_backtest_results where computed_at >= '<DEPLOY_TS>' group by 1,2;
-- freshness: ~1,000+ tickers per timeframe
select timeframe, max(computed_at), count(distinct ticker) filter (where computed_at >= '<DEPLOY_TS>') from bx_backtest_results group by 1;
-- baseline: ~1,060+ rows per timeframe; summary view has 3 rows
select timeframe, count(*), sum(n_bars) from bx_backtest_baseline group by 1;
select * from public.bx_backtest_baseline_summary;
-- backup intact
select count(*) from private.bx_backtest_results_pre_v5_bak;   -- 308,920
-- health
select * from public.pipeline_health where status <> 'ok';
```

### 6.6 `[DECISION]` Before ever setting SLACK_WEBHOOK_URL
The first webhook run posts only each timeframe's newest scan_date (today about 48 daily, 132 weekly and ~94 monthly
transitions). To start silent, pre-seed alert_state:
```sql
insert into public.alert_state(alert_key, scan_date, status, posted_at)
select ticker||'|'||timeframe||'|'||scan_date, scan_date, 'posted', now() from public.zone_transitions on conflict (alert_key) do nothing;
```

---

## Phase 7: SPA push (frontend)

The order relative to the DB does not matter (the SPA degrades gracefully), but pushing after Phase 2 means BASE/LIFT,
medians and health show up at once.
```bash
cd /c/Users/jer_2/bx-terminal
git log --oneline -1          # ROLLOUT_SHA (+ any fix-forward commits)
git push origin main          # Vercel auto-deploys bx-terminal
curl -sI https://bx-terminal.vercel.app/ | grep -ci content-security-policy                     # 1
curl -s -o /dev/null -w '%{http_code}\n' https://bx-terminal.vercel.app/assets/nope.js          # 404
```
The push publishes all `supabase/` code and SQL. The 0.4 secret scan covers it.

**QA desktop (1440x900)**
1. No CSP violations in the console; the font and the TradingView chart load.
2. DAILY header reads 'SCAN: <date> · N STALE'; stale rows are dimmed and tagged.
3. The ALERTS count leaves out stale rows.
4. Arrow keys move the selection with no dialog, one iframe, and one bx_backtest_results request per settled ticker.
5. BRK-B shows NYSE:BRK.B.
6. MOVERS fills 25/25, and a sector filter gives that sector's own movers.
7. EARN >30d shows no E? rows, and NEAR HIGHS includes 100%.
8. MONTHLY with BIAS BULL shows 'N NO-BIAS HIDDEN'.
9. The BACKTEST horizon line is in bars, and 'COMPUTED <date h:mm AM/PM ET>' appears.
10. Going from WEEKLY to DAILY never shows weekly rows under DAILY; the chart reloads once and keeps the exchange prefix.
11. Go offline, then click MONTHLY: the red FAILED banner appears with RETRY.
12. With the daily scan request blocked in DevTools (`latest_scans_with_meta*daily*`), open MOVERS and click a mover.
    The chart and BACKTEST switch within ~250 ms, with no stuck 'Loading…'.

**QA mobile (390x844)**
- The header shows 'MM/DD N STALE' without wrapping.
- Tapping a row opens the sheet with one iframe; resizing past 1024 px closes the sheet.
- The PIPELINE strip and the error banner each fit on one line.
- The FILTERS drawer labels are correct.
- BACKTEST cards fit with no horizontal scroll.

Optional stale-chunk check: keep a tab open across the deploy, then tap SECTORS or BACKTEST. The page auto-reloads once.

Rollback: Vercel dashboard > Deployments > promote the previous deployment (Vercel MCP `request_rollback`), or `git revert`
the frontend files and push.

---

## Phase 8: Post-rollout watch (ET)
- **Sun 10/25, 2:00-4:55 AM EDT:** builder chunks run. At 5:10 and 5:15 AM the matviews refresh. Then
  `bx_backtest_baseline_summary` has 3 rows and backtest_freshness is ok.
- **Sun 10:00-10:55 AM EDT:** weekly scan plus fills. Weekly scan_date stays 10/23 and weekly coverage is at least 98%.
- **Mon 10/26, 5:20-6:15 PM EDT:** daily chunks plus fills. After 6:20 PM, run
  `select * from public.pipeline_health where status <> 'ok';` and check that bx-finviz-sync, bx-exchange-backfill and
  bx-alerter ran ok at 6:25-6:45 PM.
- **Mon market hours:** InPlayScanner keeps TS data for more than 20 min; the trading-journal cron at ~3:00 AM returns 200.
- **Sun 11/1 (DST ends):** the monthly scan at 6:00 AM EST writes scan_date 10/30, and the schedule shifts by 1 h in ET
  by design.
- Watch for is_stale true on nearly every row. That means a max_scan_date mismatch, and the whole board dims.

---

## Phase 9: Later cleanup `[DECISION]`, one at a time, once each is no longer needed
- `DROP TABLE private.bx_backtest_results_pre_v5_bak;` frees ~75 MB.
  Only after the v5 rebuild is verified, the backtest views have been reviewed on v5 data, and nobody wants the
  pre-window daily history restored.
- `DROP TABLE private.bx_backtest_results_em5_bak, private.bx_scans_monthly_20261001_bak;`
- `DROP TABLE private.ticker_meta_earnings_bak_20261024;` once the earnings dates look right.
- `DROP TABLE private.app_settings_finviz_bak_20261024;` once rolling back bx-finviz-sync to baseline is off the table.
- Token material (closes edge-ts-9 / db-14), once the live token chain is confirmed healthy. Pick one:
  - (a) back up, then drop or NULL the token columns of `private.tradestation_tokens_bak` and
    `private.tradestation_tokens_bak_20261002`;
  - (b) revoke those old refresh tokens at TradeStation.
- Old ts-token key in historical `function_edge_logs`: it stops working at 3.1, and the logs roll off with retention.
  Optionally ask Supabase support to purge them.

---

## Phase 10: Consolidated rollback (reverse order; use only the parts needed)
1. **SPA:** promote the previous Vercel deployment.
2. **Data:**
   - 40 rollback (A) gives a full revert of bx_backtest_results to the pre-rollout state. It also undoes 24 part 1.
     Pair it with redeploying bx-backtest-builder from 0834d06.
   - 40 rollback (B) restores only the keys v5 dropped.
   - 24 part 2: `INSERT INTO public.bx_scans SELECT * FROM private.bx_scans_monthly_20261001_bak ON CONFLICT DO NOTHING;`
   - 6.3: re-insert from `private.app_settings_finviz_bak_20261024`.
3. **25:** run its header block (restore the 3 indexes and the policies).
4. **24:** run its header block.
5. **23:** unschedule the new jobs and re-create the old ones from `supabase/snapshot/cron_jobs.sql`. Only do this together
   with reverting bx-scan and bx-backtest-builder to 0834d06. Old jobs send offset/limit, and the new bx-scan ignores them.
6. **Functions:**
   - bx-scan, bx-backtest-builder and the edge-data four: redeploy from `git show 0834d06:...`.
   - ts-token and the OAuth pair: fix forward (Phase 3 rollback).
   - Keep `_shared/ts_auth.ts` on the RPC CAS.
7. **SQL 40 -> 30 -> 22 -> 21 -> 20 -> 10:** each file's header Rollback block.
   - 30 only after the edge-data four are on baseline.
   - 21: re-create the six views from `supabase/snapshot/views.sql`.
   - 20: do NOT restore the header-less invoke_edge_function while any C1 function is deployed.
   - 10: drop `ts_cas_tokens` only after no deployed function bundles the new ts_auth.ts. Its grant rollback is NOT
     recommended; if used, also re-run `REVOKE ALL` on app_settings, alert_state and ts_oauth_states.
8. **Secrets:** `supabase secrets unset --project-ref wefobwdspqzxbesbnzoc CRON_SECRET` (and the others as needed).
   Delete the Vault secret.

---

## Research re-run plan (separate; local only; no deploy, no network)
All commands run from `C:\Users\jer_2\bx-terminal`. `research/data` is gitignored, so step R0's copy is the only way to
reproduce the old numbers.

- **R0. Backup (MANDATORY).** The current reports are already committed: `git status research/reports` should show only
  ERRATA. Then:
  `copy research\data\es_1m_continuous.parquet research\data\es_1m_continuous_pre1024.parquet`
  Rollback: restore that copy, then
  `git checkout 0834d06 -- research/phase0_build.py research/bt_engine.py research/of_build.py research/phase1_event_study.py research/phase2_reversal.py research/phase1_runs.py`
  and `git checkout -- research/reports/phase0`.
- **R1. Rebuild the parquet (70-90 s):** `python research/phase0_build.py`. Expected output:
  - 'sealed window: 47,403'
  - 'duplicate bars dropped: 0  nonexistent (spring-forward) dropped: 0'
  - 'rolls: 82'
  - '41 rolls cut across the daily halt: median |jump| 0.50 pt, max 20.25 pt'
  - 'stitched bars: 6,912,106'
  - data ends 2026-08-31 4:59 PM ET
  - 'thin roll-week days: 232'

  roll_adj changes on ~6.83M rows (up to 79 pt), because the newest contract is now 0 (ra-1). Adjusted differences are
  comparable. Absolute adjusted levels shift by a constant per contract, which is not a regression.
- **R2. Tests:** `pip install pytest` then `python -m pytest research/tests -q`. Expect 34 passed. On the old parquet,
  31 pass and 3 test_real_* fail by design.
- **R3. Order flow:** no of_1m rebuild. Do NOT delete `research/data/of_days`.
- **R4. Phase 1 (~30-40 s):** `python research/phase1_event_study.py`. Expect 'dev days used: 4491' and 75 trials.
  - Scratch result: primary n=16,701; gross 1R/2R/3R/time -0.090/-0.110/-0.111/-0.116 vs matched -0.053/-0.069/-0.073/-0.077;
    net -0.39 to -0.42 R; MFE median 0.67 R, MAE median 1.00 R.
  - Then `python research/phase1_runs.py`: P(run|tight) 1.1% vs 9.8%, and the last line says 9 views.
  - Compare using CIs, not exact values.
- **R5. Phase 2 (~4-5 min):** `python research/phase2_reversal.py`. `reports/phase2/trials.txt` must contain
  `dev_sessions=4491` and `prior=75`.
  - Compare: best real t 0.80, placebo p 0.24, 4 of 43,956 net-positive cells, walk-forward t_late -3.4/-3.2.
  - t is now day-clustered, so |t_late| should shrink; the sign likely holds.
  - Let S = phase 2 total - 95,360. Phases 3-7 and 10 print 'WARNING: reports/phase2/trials.txt predates...' if R5 is
    stale. If you see that, re-run R4-R5.
- **R6. Phase 3 (5-10 min):** `python research/phase3_orderflow.py`. primary.csv, the flow-placebo p and the
  grid/walk-forward/top cells should be unchanged. The absorption CI narrows (rb-5); the Spearman and terciles move (rb-7).
  Prior = the new phase 2 total.
- **R7. Phase 4 (3-8 min):** `python research/phase4_gamma.py --labels`, then `python research/phase4_gamma.py`.
  - Expect persistence 0.614 and '343 snapshots repeat'.
  - trials.txt: phase4_total=132, prior = 118,360 + S, posthoc_1024_counted_at_chain_end=2.
  - Optional `--power`: power_prereg.csv should not move.
- **R8. Phase 5 (~1 min):** `python research/phase5_known.py`. The summary.csv null_p floor is 1/201, and ORB null_p gets +1.
  The noise and Gao A/C n drop by 2 export-hole days. Prior = 118,490 + S.
- **R9. Phase 6 (~80 s):** `python research/phase6_levels.py`. Still 0 of 32 with net > 0 and t > 0.3. Prior = 118,528 + S.
- **R10. Phase 7 (~10 s):** `python research/phase7_calendar.py`. It prints '118 holiday sessions left out...'.
  - Compare ME_A/B (227 months), REV_* (3:59 PM decision), FOMC_EVEN*, MAC_*, ON_W_* and PRE_FOMC against ERRATA section 3.
  - Prior = 118,528 + S.
- **R11. Phase 8 (~5 s):** `python research/phase8_confirm.py`. The 'no ## Frozen code section' notice is by design;
  do NOT add one to the spent PREREG. Commit `reports/phase8/provenance.json`.
- **R12. Phase 9 (~3 s):** `python research/phase9_stops.py`. DEV n ~850 (was 847).
- **R13. Phase 10 (10-20 min):** `python research/phase10_tradecity.py`, then
  `python research/phase10_tradecity.py --posthoc`. null_p gets +1, and the running total = 118,606 + S.
- **R14. Phase 11:** `python research/phase11_research.py`, then `python research/phase11_confirm.py`.
  - daily.csv has 4,783 DEV days.
  - Re-apply the pre-declared pass rule to RSI2_LS. Pre-fix values: +123 pt/yr, alpha t 2.31, halves 2.14 / 1.64.
  - 11b: compare confirm.csv, robustness.csv and the reconciliation line.
  - Commit `reports/phase11/provenance.json`.
- **R15. Docs:**
  - Fill ERRATA_2026-10-24.md section 3 (old -> new; bold any verdict change).
  - Make the README wording fixes listed in ERRATA section 4. phase1/phase2 READMEs: 4,633 -> 4,491 sessions, 75 trials,
    primary v0 table, day-clustered t.
  - PLAN.md: every phase total shifts by S; chain total = 118,627 + 2 + S.
  - Commit the outputs, provenance files, ERRATA and PLAN together.
- **Future one-shot test (9/1-10/15/2026 only):**
  `python research/phase0_build.py --end none --out <separate dir> --rep <separate dir>`. The script refuses `--end none`
  with the default directories.
