// Tests for supabase/functions/_shared/bx_math.ts.
// Run: npx -y deno@2 test supabase/tests/bx_math.test.ts
// The reference below is written independently in Pine's bar-by-bar style (history operator x[k], ta.sma over the
// last `len` non-na values, `na(sum[1]) ? ta.sma(src, len) : ...`) rather than the streaming form used in bx_math.
import {
  asOfIndex, BarIntegrityError, baselineAggregate, biasAt, type Bars, BIAS_FIRST_INDEX, BX_FIRST_INDEX, cleanBars,
  completedBars, computeBX, detectSignals, ema, expectedScanDay, forwardReturn, isoDay, isTradingDay, priceIncluded, retIncluded,
  lastTradingDayOfPeriod, marketBiasSeries, nyClock, parseIsoDay, parseSymbols, periodEnds, rma, rsi, yahooChartUrl, zone,
} from "../functions/_shared/bx_math.ts";

function assert(cond: unknown, msg = "assertion failed"): asserts cond { if (!cond) throw new Error(msg); }
function near(a: number, b: number, eps = 1e-9, msg = "") {
  if (Number.isNaN(a) && Number.isNaN(b)) return;
  assert(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${msg} expected ${b}, got ${a}`);
}
function eqArr(a: number[], b: number[], eps = 1e-9, msg = "") {
  assert(a.length === b.length, `${msg} length ${a.length} != ${b.length}`);
  for (let i = 0; i < a.length; i++) near(a[i], b[i], eps, `${msg}[${i}]`);
}
function throwsIntegrity(f: () => unknown) {
  try { f(); } catch (e) { assert(e instanceof BarIntegrityError, `wrong error ${e}`); return; }
  throw new Error("expected BarIntegrityError");
}

// ------------------------------------------------------------------ independent Pine-style reference
const na = (x: number | undefined) => x === undefined || Number.isNaN(x);
function refSma(src: number[], i: number, len: number): number {          // ta.sma ignoring na values
  const vals: number[] = [];
  for (let k = i; k >= 0 && vals.length < len; k--) if (!na(src[k])) vals.push(src[k]);
  return vals.length < len ? NaN : vals.reduce((a, b) => a + b, 0) / len;
}
function refMa(src: number[], len: number, alpha: number): number[] {
  const sum: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const prev = i > 0 ? sum[i - 1] : NaN;
    if (na(src[i])) { sum.push(prev); continue; }                          // na skipped: value carried
    sum.push(na(prev) ? refSma(src, i, len) : alpha * src[i] + (1 - alpha) * prev);
  }
  return sum;
}
const refEma = (s: number[], n: number) => refMa(s, n, 2 / (n + 1));
const refRma = (s: number[], n: number) => refMa(s, n, 1 / n);
function refRsi(x: number[], len: number): number[] {
  const u = x.map((v, i) => (i === 0 || na(v) || na(x[i - 1]) ? NaN : Math.max(v - x[i - 1], 0)));
  const d = x.map((v, i) => (i === 0 || na(v) || na(x[i - 1]) ? NaN : Math.max(x[i - 1] - v, 0)));
  const up = refRma(u, len), dn = refRma(d, len);
  return up.map((a, i) => {
    const b = dn[i];
    if (na(a) || na(b)) return NaN;
    if (a === 0 && b === 0) return 50;
    return b === 0 ? 100 : a === 0 ? 0 : 100 - 100 / (1 + a / b);
  });
}
function refBX(c: number[]): number[] {
  const e5 = refEma(c, 5), e20 = refEma(c, 20);
  return refRsi(c.map((_, i) => e5[i] - e20[i]), 15).map((v) => v - 50);
}
function refBias(o: number[], h: number[], l: number[], c: number[]) {
  const O = refEma(o, 100), C = refEma(c, 100), H = refEma(h, 100), L = refEma(l, 100);
  const haclose = O.map((_, i) => (O[i] + H[i] + L[i] + C[i]) / 4);
  const xhaopen = O.map((_, i) => (O[i] + C[i]) / 2);
  const haopen = O.map((_, i) => (i === 0 || na(xhaopen[i - 1]) ? (O[i] + C[i]) / 2 : (xhaopen[i - 1] + haclose[i - 1]) / 2));
  const hahigh = H.map((v, i) => Math.max(v, Math.max(haopen[i], haclose[i])));
  const halow = L.map((v, i) => Math.min(v, Math.min(haopen[i], haclose[i])));
  return { o2: refEma(haopen, 100), c2: refEma(haclose, 100), h2: refEma(hahigh, 100), l2: refEma(halow, 100) };
}

// deterministic pseudo-random walk
function walk(n: number, seed = 7, start = 100): { o: number[]; h: number[]; l: number[]; c: number[] } {
  let s = seed; const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const o: number[] = [], h: number[] = [], l: number[] = [], c: number[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const op = p, cl = Math.max(1, p * (1 + (rnd() - 0.5) * 0.06));
    o.push(op); c.push(cl); h.push(Math.max(op, cl) * (1 + rnd() * 0.01)); l.push(Math.min(op, cl) * (1 - rnd() * 0.01));
    p = cl;
  }
  return { o, h, l, c };
}

// ------------------------------------------------------------------ EMA / RMA / RSI
Deno.test("ema: hand-computed SMA seed then recursion (Pine ta.ema)", () => {
  // len 3: alpha 0.5; seed at index 2 = (1+2+3)/3 = 2; then 3, 4, 5
  eqArr(ema([1, 2, 3, 4, 5, 6], 3), [NaN, NaN, 2, 3, 4, 5]);
  // len 2: alpha 2/3; seed idx1 = 15; idx2 = 2/3*30 + 1/3*15 = 25
  eqArr(ema([10, 20, 30], 2), [NaN, 15, 25]);
});
Deno.test("rma: hand-computed (Pine ta.rma)", () => {
  // len 4: seed idx3 = 2.5; idx4 = 0.25*10 + 0.75*2.5 = 4.375
  eqArr(rma([1, 2, 3, 4, 10], 4), [NaN, NaN, NaN, 2.5, 4.375]);
});
Deno.test("ema/rma: na values are skipped and the seed counts only valid values", () => {
  const src = [NaN, 1, NaN, 2, 3, NaN, 5];
  eqArr(ema(src, 3), refEma(src, 3));
  eqArr(ema(src, 3), [NaN, NaN, NaN, NaN, 2, 2, 3.5]);
  eqArr(rma(src, 2), refRma(src, 2));
});
Deno.test("ema/rma: short series stays na", () => {
  eqArr(ema([1, 2], 5), [NaN, NaN]);
  eqArr(rma([], 5), []);
});
Deno.test("rsi: hand-computed and guards", () => {
  // x = 1,2,3,2,4 ; len 2. changes: +1,+1,-1,+2. u: 1,1,0,2 d: 0,0,1,0
  // rma(u,2): seed idx2 = 1; idx3 = .5*0+.5*1 = .5; idx4 = .5*2+.5*.5 = 1.25
  // rma(d,2): seed idx2 = 0; idx3 = .5;          idx4 = .25
  // rsi: idx2 d=0 -> 100; idx3 1:1 -> 50; idx4 rs=5 -> 100-100/6
  eqArr(rsi([1, 2, 3, 2, 4], 2), [NaN, NaN, 100, 50, 100 - 100 / 6]);
  eqArr(rsi([5, 4, 3, 2], 2), [NaN, NaN, 0, 0]);                 // only losses -> 0
  eqArr(rsi([3, 3, 3, 3, 3], 2), [NaN, NaN, 50, 50, 50]);        // flat -> 50 (documented deviation)
});
Deno.test("rsi matches the reference on a random walk", () => {
  const { c } = walk(300, 3);
  eqArr(rsi(c, 14), refRsi(c, 14), 1e-9);
});

// ------------------------------------------------------------------ B-Xtrender
Deno.test("computeBX matches the Pine reference and is first defined at index 34", () => {
  const { c } = walk(400, 11);
  const bx = computeBX(c), ref = refBX(c);
  eqArr(bx, ref, 1e-9, "bx");
  assert(Number.isNaN(bx[BX_FIRST_INDEX - 1]) && !Number.isNaN(bx[BX_FIRST_INDEX]), "first index");
});
Deno.test("computeBX edge cases: short, flat, monotonic, NaN closes", () => {
  assert(computeBX(walk(34).c).every(Number.isNaN), "34 bars -> all na");
  const flat = computeBX(new Array(80).fill(42));
  assert(flat.slice(BX_FIRST_INDEX).every((v) => v === 0), "flat series -> bx 0, not +49/+50");
  const up = computeBX(Array.from({ length: 80 }, (_, i) => 10 + i * i * 0.01));
  near(up[79], 50, 1e-9, "accelerating uptrend -> +50");
  const { c } = walk(120, 5);
  const holes = c.map((v, i) => (i % 17 === 5 ? NaN : v));
  eqArr(computeBX(holes), refBX(holes), 1e-9, "na closes");
});

// ------------------------------------------------------------------ Market Bias
Deno.test("marketBiasSeries matches the CEREBR reference; first defined at 198", () => {
  const w = walk(450, 21);
  const mb = marketBiasSeries(w.o, w.h, w.l, w.c), ref = refBias(w.o, w.h, w.l, w.c);
  eqArr(mb.o2, ref.o2, 1e-9, "o2"); eqArr(mb.c2, ref.c2, 1e-9, "c2"); eqArr(mb.h2, ref.h2, 1e-9, "h2"); eqArr(mb.l2, ref.l2, 1e-9, "l2");
  assert(biasAt(mb, w.c, BIAS_FIRST_INDEX - 1) === null, "197 undefined");
  const b = biasAt(mb, w.c, BIAS_FIRST_INDEX);
  assert(b !== null, "198 defined");
  assert(b.direction === (ref.c2[198] >= ref.o2[198] ? "bullish" : "bearish"));
  near(b.oscillator, Math.round((ref.c2[198] - ref.o2[198]) * 100 * 100) / 100, 1e-12);
  assert(biasAt(marketBiasSeries(w.o.slice(0, 150), w.h.slice(0, 150), w.l.slice(0, 150), w.c.slice(0, 150)), w.c, 149) === null, "short");
});

// ------------------------------------------------------------------ zones / signals
Deno.test("zone band and transitions", () => {
  assert(zone(2) === "neutral" && zone(2.01) === "bullish" && zone(-2) === "neutral" && zone(-2.01) === "bearish");
  const bx = [NaN, 0, 3, 3, -3, NaN, 1, 0];
  const s = detectSignals(bx, 0);
  assert(s.length === 2, `got ${s.length}`);
  assert(s[0].signal_type === "neutral_to_bullish" && s[0].index === 2);
  assert(s[1].signal_type === "bullish_to_bearish" && s[1].index === 4);
  assert(detectSignals(bx, 2).length === 1, "minIdx respected");
});

// ------------------------------------------------------------------ calendar
const D = parseIsoDay;
Deno.test("NYSE holidays 2026 and special cases", () => {
  for (const h of ["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"]) {
    assert(!isTradingDay(D(h)), `${h} should be a holiday`);
  }
  assert(isTradingDay(D("2026-10-23")) && !isTradingDay(D("2026-10-24")), "Fri open / Sat closed");
  assert(isTradingDay(D("2021-12-31")), "Sat New Year -> Dec 31 stays open");
  assert(!isTradingDay(D("2022-06-20")), "Juneteenth 2022 observed Monday");
  assert(isTradingDay(D("2021-06-18")), "no Juneteenth before 2022");
  assert(!isTradingDay(D("2025-01-09")) && !isTradingDay(D("2012-10-30")), "special closures");
});
Deno.test("lastTradingDayOfPeriod", () => {
  const ltd = (tf: "weekly" | "monthly", s: string) => isoDay(lastTradingDayOfPeriod(tf, D(s))!);
  assert(ltd("weekly", "2026-10-19") === "2026-10-23");
  assert(ltd("weekly", "2026-03-30") === "2026-04-02", "Good Friday week ends Thursday");
  assert(ltd("weekly", "2001-09-10") === "2001-09-10", "9/11 week");
  assert(ltd("monthly", "2021-05-03") === "2021-05-28", "Memorial Day on May 31");
  assert(ltd("monthly", "2018-03-01") === "2018-03-29", "Good Friday Mar 30");
  assert(ltd("monthly", "2026-10-01") === "2026-10-30", "Oct 31 2026 is a Saturday");
});
Deno.test("nyClock handles DST", () => {
  const a = nyClock(Date.parse("2026-10-23T20:16:00Z"));
  assert(isoDay(a.day) === "2026-10-23" && a.minutes === 16 * 60 + 16, "EDT");
  const b = nyClock(Date.parse("2026-11-02T21:16:00Z"));
  assert(isoDay(b.day) === "2026-11-02" && b.minutes === 16 * 60 + 16, "EST");
  const c = nyClock(Date.parse("2026-10-24T02:00:00Z"));
  assert(isoDay(c.day) === "2026-10-23" && c.minutes === 22 * 60, "late evening stays on the NY date");
});
Deno.test("expectedScanDay", () => {
  const at = (iso: string) => nyClock(Date.parse(iso));
  const sat = at("2026-10-24T16:00:00Z");
  assert(isoDay(expectedScanDay("daily", sat)) === "2026-10-23");
  assert(isoDay(expectedScanDay("weekly", sat)) === "2026-10-23");
  assert(isoDay(expectedScanDay("monthly", sat)) === "2026-09-30");
  const friEarly = at("2026-10-23T19:00:00Z");                              // 3:00 PM EDT
  assert(isoDay(expectedScanDay("daily", friEarly)) === "2026-10-22", "in-progress day not counted");
  assert(isoDay(expectedScanDay("weekly", friEarly)) === "2026-10-16", "in-progress week not counted");
  const friLate = at("2026-10-23T20:20:00Z");                               // 4:20 PM EDT
  assert(isoDay(expectedScanDay("weekly", friLate)) === "2026-10-23");
  const nov1 = at("2026-11-01T14:00:00Z");                                  // Sun 9 AM EST, monthly cron
  assert(isoDay(expectedScanDay("monthly", nov1)) === "2026-10-30");
  const novMon = at("2026-11-02T21:05:00Z");                                // 4:05 PM EST: before the 4:15 cutoff
  assert(isoDay(expectedScanDay("daily", novMon)) === "2026-10-30");
  const sunWeekly = at("2026-10-25T14:00:00Z");                             // weekly cron, Sun 14:00 UTC
  assert(isoDay(expectedScanDay("weekly", sunWeekly)) === "2026-10-23", "Mon-Fri week is complete on Sunday");
  const dec1 = at("2026-12-01T11:00:00Z");                                  // monthly cron on a weekday 1st, 6 AM EST
  assert(isoDay(expectedScanDay("monthly", dec1)) === "2026-11-30");
});

// ------------------------------------------------------------------ bars
const ts = (iso: string) => Date.parse(iso) / 1000;
function mk(stamps: string[], closes?: number[]): Bars {
  const c = closes ?? stamps.map((_, i) => 100 + i);
  return { ts: stamps.map(ts), opens: c.map((x) => x - 1), highs: c.map((x) => x + 2), lows: c.map((x) => x - 2), closes: c.slice() };
}
Deno.test("cleanBars drops null / NaN rows", () => {
  const b = cleanBars([1, 2, 3, 4], [1, null, 1, 1], [2, 2, 2, 2], [0, 0, NaN, 0], [1, 1, 1, "1.5"]);
  assert(b.ts.join() === "1,4" && b.closes.join() === "1,1.5");
});
Deno.test("completedBars drops the in-progress daily bar before 4:15 PM ET only", () => {
  const b = mk(["2026-10-21T20:00:00Z", "2026-10-22T20:00:00Z", "2026-10-23T20:00:00Z"]);
  const early = completedBars("daily", b, nyClock(Date.parse("2026-10-23T19:00:00Z")));
  assert(early.droppedInProgress && early.bars.days.length === 2);
  const late = completedBars("daily", b, nyClock(Date.parse("2026-10-23T20:20:00Z")));
  assert(!late.droppedInProgress && isoDay(late.bars.days[2]) === "2026-10-23");
});
Deno.test("completedBars: weekly live duplicate merged then dropped; monthly in-progress dropped", () => {
  const stamps = ["2026-09-28T04:00:00Z", "2026-10-05T04:00:00Z", "2026-10-12T04:00:00Z", "2026-10-19T04:00:00Z", "2026-10-21T19:59:00Z"];
  const b = mk(stamps);
  const wed = completedBars("weekly", b, nyClock(Date.parse("2026-10-21T20:30:00Z")));
  assert(wed.droppedInProgress && wed.bars.days.length === 3 && isoDay(wed.bars.days[2]) === "2026-10-12");
  const sat = completedBars("weekly", mk(stamps.slice(0, 4).concat(["2026-10-23T20:00:00Z"])), nyClock(Date.parse("2026-10-24T15:00:00Z")));
  assert(!sat.droppedInProgress && sat.bars.days.length === 4, "Sat: merged week is complete");
  assert(sat.bars.opens[3] === 102 && sat.bars.closes[3] === 104, "merge keeps first open, last close");
  const m = mk(["2026-08-01T04:00:00Z", "2026-09-01T04:00:00Z", "2026-10-01T04:00:00Z"]);
  const oct = completedBars("monthly", m, nyClock(Date.parse("2026-10-01T14:00:00Z")));
  assert(oct.droppedInProgress && oct.bars.days.length === 2, "monthly cron on the 1st drops the 30-minute-old month");
  // premarket new-month bar (monthly cron 11:00 UTC on a weekday 1st) is in progress; the month just ended is kept
  const pre = completedBars("monthly", mk(["2026-10-01T04:00:00Z", "2026-11-30T21:00:00Z", "2026-12-01T05:00:00Z"]), nyClock(Date.parse("2026-12-01T11:00:00Z")));
  assert(pre.droppedInProgress && pre.bars.days.length === 2 && isoDay(pre.bars.days[1]) === "2026-11-30", "Dec premarket bar dropped");
  // Sunday weekly cron: the Mon-Fri week (Yahoo live duplicate merged) counts as complete
  const sun = completedBars("weekly", mk(stamps.slice(0, 4).concat(["2026-10-23T20:00:00Z"])), nyClock(Date.parse("2026-10-25T14:00:00Z")));
  assert(!sun.droppedInProgress && sun.bars.days.length === 4, "Sun: last week complete");
});
Deno.test("completedBars rejects weekly data labelled monthly (em-5) and other cadence errors", () => {
  const weekly = Array.from({ length: 30 }, (_, i) => new Date(Date.UTC(2025, 0, 6 + 7 * i, 5)).toISOString());
  throwsIntegrity(() => completedBars("monthly", mk(weekly), nyClock(Date.parse("2026-10-24T15:00:00Z"))));
  const monthly = Array.from({ length: 20 }, (_, i) => new Date(Date.UTC(2024, i, 1, 4)).toISOString());
  throwsIntegrity(() => completedBars("weekly", mk(monthly), nyClock(Date.parse("2026-10-24T15:00:00Z"))));
  throwsIntegrity(() => completedBars("daily", mk(["2026-10-22T20:00:00Z", "2026-10-21T20:00:00Z", "2026-10-23T20:00:00Z"]), nyClock(Date.parse("2026-10-24T15:00:00Z"))));
  const ok = completedBars("weekly", mk(weekly), nyClock(Date.parse("2026-10-24T15:00:00Z")));
  assert(ok.bars.days.length === 30);
  // Yahoo's range=max downgrade: quarter-start 1sts (KO/GE/IBM in prod) must not pass as monthly either
  const quarterly = Array.from({ length: 40 }, (_, i) => new Date(Date.UTC(2016, 3 * i, 1, 4)).toISOString());
  throwsIntegrity(() => completedBars("monthly", mk(quarterly), nyClock(Date.parse("2026-10-24T15:00:00Z"))));
});
Deno.test("parseSymbols: strict symbols=CSV validation", () => {
  assert(parseSymbols(" aapl, BF-B ,brk.b,,^VIX,$SPX.X ")?.join() === "AAPL,BF-B,BRK.B,^VIX,$SPX.X");
  assert(parseSymbols("AAPL,MS FT") === null && parseSymbols("AAPL&limit=1") === null && parseSymbols("A?B") === null);
  assert(parseSymbols("A".repeat(21)) === null && parseSymbols(",,") === null && parseSymbols("AAPL%2F") === null);
});
Deno.test("yahooChartUrl: monthly uses explicit period1/period2, never range=max (em-5)", () => {
  const now = Date.parse("2026-10-24T15:00:00Z");
  const m = yahooChartUrl("BF-B", "monthly", now);
  assert(!m.includes("range="), m);
  assert(m.includes("interval=1mo") && m.includes("period1=0") && m.includes(`period2=${now / 1000}`), m);
  assert(yahooChartUrl("AAPL", "daily", now).endsWith("/AAPL?interval=1d&range=2y"));
  assert(yahooChartUrl("AAPL", "weekly", now).endsWith("/AAPL?interval=1wk&range=10y"));
  assert(yahooChartUrl("BRK.B", "daily", now).includes("/BRK.B?"));
});

// ------------------------------------------------------------------ period ends + MTF alignment
Deno.test("periodEnds: daily-derived when covered, calendar otherwise", () => {
  const weeks = ["2026-03-23", "2026-03-30", "2026-04-06"].map(D);                    // Yahoo Monday stamps
  const daily = ["2026-03-23", "2026-03-24", "2026-03-25", "2026-03-26", "2026-03-27", "2026-03-30", "2026-03-31", "2026-04-01", "2026-04-02",
    "2026-04-06", "2026-04-07", "2026-04-08", "2026-04-09", "2026-04-10", "2026-04-13"].map(D);
  const e = periodEnds("weekly", weeks, daily).map(isoDay);
  assert(e.join() === "2026-03-27,2026-04-02,2026-04-10", e.join());
  const cal = periodEnds("weekly", weeks, null).map(isoDay);
  assert(cal.join() === "2026-03-27,2026-04-02,2026-04-10", "calendar knows Good Friday");
  // daily lags on the newest period (last daily = Thu 4/9 < calendar end Fri 4/10) -> calendar, never earlier
  const lag = periodEnds("weekly", weeks, daily.slice(0, 13)).map(isoDay);
  assert(lag[2] === "2026-04-10", "lagging daily data must not pull the label earlier");
  // monthly: 1st-of-month stamps (incl. a weekend 1st)
  const months = ["2026-08-01", "2026-09-01"].map(D);
  assert(periodEnds("monthly", months, null).map(isoDay).join() === "2026-08-31,2026-09-30");
});
Deno.test("MTF as-of lookup never sees the future (em-3)", () => {
  const weekEnds = periodEnds("weekly", ["2026-10-05", "2026-10-12", "2026-10-19"].map(D), null);   // Fri 10/9, 10/16, 10/23
  const at = (s: string) => asOfIndex(weekEnds, D(s));
  assert(at("2026-10-21") === 1, "Wed 10/21 sees the week ending 10/16, not 10/23");
  assert(at("2026-10-23") === 2, "Fri 10/23 close sees its own completed week");
  assert(at("2026-10-19") === 1 && at("2026-10-08") === -1);
  const monthEnds = periodEnds("monthly", ["2026-08-01", "2026-09-01", "2026-10-01"].map(D), null);
  assert(asOfIndex(monthEnds, D("2026-10-16")) === 1, "mid-October sees September, not October");
  assert(asOfIndex(monthEnds, D("2026-10-30")) === 2);
});

// ------------------------------------------------------------------ returns / baseline / outliers
Deno.test("forward returns are bar offsets; outlier rule; baseline aggregates", () => {
  const closes = [10, 11, 12, 13, 14, 15, 16];
  assert(forwardReturn(closes, 0, 5) === 50 && forwardReturn(closes, 3, 5) === null);
  assert(!priceIncluded(0.994) && priceIncluded(0.995) && priceIncluded(1), "price rule on the 2-decimal close");
  assert(retIncluded(10000) && !retIncluded(10000.01) && retIncluded(-99) && !retIncluded(null), "per-horizon cap");
  const n = 200;
  const c = Array.from({ length: n }, (_, i) => 10 + i * 0.1);
  const bx = computeBX(c);
  assert(bx.length === n);
  const b = baselineAggregate(c);                                             // C6: EVERY completed bar
  assert(b.n_bars === n, `n_bars ${b.n_bars}`);
  assert(b.n_ret_5 === n - 5 && b.wins_5 === b.n_ret_5, "every 5-bar return of a rising series is a win");
  assert(b.n_ret_120 === n - 120);
  let s = 0; for (let i = 0; i + 5 < n; i++) s += Math.round((c[i + 5] / c[i] - 1) * 10000) / 100;
  near(b.sum_ret_5, s, 1e-6, "sum_ret_5");
  const short = baselineAggregate(c.slice(0, 19));                            // short history still counts (CRWV-like)
  assert(short.n_bars === 19 && short.n_ret_5 === 14 && short.n_ret_20 === 0);
  const spike = c.slice(); spike[100] = 3000;                                 // >101x bad print: only that horizon drops
  const bs = baselineAggregate(spike);
  assert(bs.n_bars === b.n_bars, "bars stay counted");
  // exactly one bar per horizon lands on the spike (i = 95 / 80 / 40) with a > +10000 % return; 120 has none (i < 0)
  assert(bs.n_ret_5 === b.n_ret_5 - 1 && bs.n_ret_20 === b.n_ret_20 - 1 && bs.n_ret_60 === b.n_ret_60 - 1 && bs.n_ret_120 === b.n_ret_120,
    `5:${bs.n_ret_5}/${b.n_ret_5} 20:${bs.n_ret_20}/${b.n_ret_20} 60:${bs.n_ret_60}/${b.n_ret_60}`);
  const penny = c.map((x, i) => (i < 60 ? 0.5 : x));                          // sub-$1 closes never counted
  const bp = baselineAggregate(penny);
  assert(bp.n_bars === n - 60 && bp.n_ret_5 === n - 60 - 5, "returns FROM a sub-$1 close are excluded");
  const holes = c.slice(); holes[10] = NaN;                                   // defensive: a non-finite close is skipped
  assert(baselineAggregate(holes).n_bars === n - 1);
});
