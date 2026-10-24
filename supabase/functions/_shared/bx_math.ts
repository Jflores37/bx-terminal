// Shared BX Terminal math, used by BOTH bx-scan (live board) and bx-backtest-builder (history) so the two can never
// diverge again. Pure functions only: no I/O, no Deno APIs, no clock reads (callers pass `now`).
//
// INDICATORS -- TradingView Pine v5/v6 built-in semantics (em-13). Checked 2026-10-24 against: the Pine reference
// pine_rma example `sum := na(sum[1]) ? ta.sma(src, length) : alpha * src + (1 - alpha) * nz(sum[1])`; the reference
// remark that na source values are ignored (the window counts non-na values); an independent bit-exact port of
// ta.ema (seed = SMA of the first `len` valid values, on the bar of the len-th valid value); and TradingView's RSI
// study source `down == 0 ? 100 : up == 0 ? 0 : 100 - 100 / (1 + up / down)`.
//   ta.ema(src, len): alpha = 2/(len+1). na until `len` valid values exist; seeded with their SMA; then recursive.
//   ta.rma(src, len): same with alpha = 1/len.
//   ta.rsi(x, len):   u = max(x - x[1], 0), d = max(x[1] - x, 0); 100 - 100/(1 + rma(u)/rma(d)); rma(d)=0 -> 100,
//                     rma(u)=0 -> 0. ONE deliberate deviation: both 0 (a flat series) -> 50, not TradingView's 100, so
//                     a halted stock reads bx 0 (neutral) instead of +50 (bullish).
//   Short-term B-Xtrender (Puppytherapy): ta.rsi(ta.ema(close, 5) - ta.ema(close, 20), 15) - 50.
//     First defined at index 34 (ema20 at 19, first change at 20, rma seed after 15 changes).
//   Market Bias (CEREBR, Professeur_X), period 100 / smoothing 100, verified against the published source:
//     o,c,h,l = ema(open/close/high/low, 100); haclose = (o+h+l+c)/4; xhaopen = (o+c)/2;
//     haopen = na(xhaopen[1]) ? (o+c)/2 : (xhaopen[1] + haclose[1])/2   <- NOT recursive in haopen
//     hahigh = max(h, haopen, haclose); halow = min(l, haopen, haclose); o2,c2,h2,l2 = ema(ha*, 100).
//     direction = c2 >= o2 ? bullish : bearish; oscillator = 100*(c2-o2); in_zone = l2 <= close <= h2.
//     First defined at index 198.
//   Zones: bx > +2 bullish, bx < -2 bearish, else neutral. A signal is a zone change between consecutive bars.
//
// SESSIONS / PERIODS (C5, C6, C9). All "today"/session logic is America/New_York. A bar's calendar date is the UTC
// date of its timestamp: every daily-or-longer stamp seen from our vendors (Yahoo: NY midnight or 09:30 ET; Yahoo live
// bar: last trade time; TradeStation: the session close, 20:00/21:00 UTC) falls on its NY session date in UTC too.
// A daily session counts as complete at 4:15 PM ET. A weekly (Mon-Sun) or monthly period is complete at 4:15 PM ET on
// its last trading day. The NYSE calendar below is rule-based (exact for scheduled holidays 1970+) plus a list of
// unscheduled full-day closures since 1969.

export type Timeframe = "daily" | "weekly" | "monthly";
export type Zone = "bullish" | "bearish" | "neutral";

export const BX_FAST = 5, BX_SLOW = 20, BX_RSI = 15, ZONE_BAND = 2;
export const BIAS_LEN = 100, BIAS_SMOOTH = 100;
export const BX_FIRST_INDEX = 34;          // first index where computeBX is defined
export const BIAS_FIRST_INDEX = 198;       // first index where Market Bias is defined
export const SESSION_DONE_MIN = 16 * 60 + 15;   // 4:15 PM ET

export const r2 = (x: number) => Math.round(x * 100) / 100;
const fin = (x: number) => typeof x === "number" && Number.isFinite(x);

// ---------------------------------------------------------------------------------------------------- indicators
function pineMA(src: ArrayLike<number>, length: number, alpha: number): number[] {
  const n = src.length, out = new Array<number>(n);
  let state = NaN, cnt = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i];
    if (!fin(x)) { out[i] = state; continue; }          // na source value: skipped, state carried
    if (Number.isNaN(state)) {
      sum += x; cnt++;
      if (cnt === length) state = sum / length;           // SMA seed on the len-th valid value
    } else {
      state = alpha * x + (1 - alpha) * state;
    }
    out[i] = state;
  }
  return out;
}
export const ema = (src: ArrayLike<number>, length: number) => pineMA(src, length, 2 / (length + 1));
export const rma = (src: ArrayLike<number>, length: number) => pineMA(src, length, 1 / length);

const FLAT_EPS = 1e-12;
export function rsi(x: ArrayLike<number>, length: number): number[] {
  const n = x.length, u = new Array<number>(n), d = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    if (i > 0 && fin(x[i]) && fin(x[i - 1])) { const ch = x[i] - x[i - 1]; u[i] = ch > 0 ? ch : 0; d[i] = ch < 0 ? -ch : 0; }
    else { u[i] = NaN; d[i] = NaN; }
  }
  const up = rma(u, length), dn = rma(d, length), out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const a = up[i], b = dn[i];
    if (!fin(a) || !fin(b)) out[i] = NaN;
    else if (a + b <= FLAT_EPS) out[i] = 50;
    else if (b === 0) out[i] = 100;
    else if (a === 0) out[i] = 0;
    else out[i] = 100 - 100 / (1 + a / b);
  }
  return out;
}

// Short-term B-Xtrender. NaN where undefined (index < 34, or not enough valid closes).
export function computeBX(closes: ArrayLike<number>): number[] {
  const e1 = ema(closes, BX_FAST), e2 = ema(closes, BX_SLOW);
  const diff = new Array<number>(closes.length);
  for (let i = 0; i < closes.length; i++) diff[i] = e1[i] - e2[i];
  return rsi(diff, BX_RSI).map((v) => (Number.isNaN(v) ? NaN : v - 50));
}

export type BiasSeries = { o2: number[]; c2: number[]; h2: number[]; l2: number[] };
export function marketBiasSeries(
  opens: ArrayLike<number>, highs: ArrayLike<number>, lows: ArrayLike<number>, closes: ArrayLike<number>,
  len = BIAS_LEN, len2 = BIAS_SMOOTH,
): BiasSeries {
  const n = closes.length;
  const o = ema(opens, len), c = ema(closes, len), h = ema(highs, len), l = ema(lows, len);
  const haC = new Array<number>(n), xhaO = new Array<number>(n), haO = new Array<number>(n);
  const haH = new Array<number>(n), haL = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    haC[i] = (o[i] + h[i] + l[i] + c[i]) / 4;
    xhaO[i] = (o[i] + c[i]) / 2;
    haO[i] = i === 0 || Number.isNaN(xhaO[i - 1]) ? (o[i] + c[i]) / 2 : (xhaO[i - 1] + haC[i - 1]) / 2;
    haH[i] = Math.max(h[i], haO[i], haC[i]);   // NaN-propagating like Pine math.max
    haL[i] = Math.min(l[i], haO[i], haC[i]);
  }
  return { o2: ema(haO, len2), c2: ema(haC, len2), h2: ema(haH, len2), l2: ema(haL, len2) };
}

export type BiasPoint = { direction: "bullish" | "bearish"; oscillator: number; in_zone: boolean };
export function biasAt(mb: BiasSeries | null, closes: ArrayLike<number>, i: number): BiasPoint | null {
  if (!mb || i < 0 || i >= closes.length) return null;
  const o2 = mb.o2[i], c2 = mb.c2[i], h2 = mb.h2[i], l2 = mb.l2[i];
  if (!fin(o2) || !fin(c2) || !fin(h2) || !fin(l2)) return null;
  return { direction: c2 >= o2 ? "bullish" : "bearish", oscillator: r2((c2 - o2) * 100), in_zone: closes[i] <= h2 && closes[i] >= l2 };
}

export function zone(bx: number): Zone {
  if (bx > ZONE_BAND) return "bullish";
  if (bx < -ZONE_BAND) return "bearish";
  return "neutral";
}

export type Signal = { signal_type: string; index: number; bx: number; prev_bx: number };
// Zone transitions at bars i > minIdx where bx[i] and bx[i-1] are both defined.
export function detectSignals(bx: ArrayLike<number>, minIdx: number): Signal[] {
  const sigs: Signal[] = [];
  for (let i = Math.max(1, minIdx + 1); i < bx.length; i++) {
    if (!fin(bx[i]) || !fin(bx[i - 1])) continue;
    const zPrev = zone(bx[i - 1]), zNow = zone(bx[i]);
    if (zPrev !== zNow) sigs.push({ signal_type: `${zPrev}_to_${zNow}`, index: i, bx: bx[i], prev_bx: bx[i - 1] });
  }
  return sigs;
}

// ---------------------------------------------------------------------------------------------------- calendar
const MS_DAY = 86_400_000;
export const dayOfTs = (tsSec: number) => Math.floor(tsSec / 86_400);              // UTC calendar date, as a day number
export const dayFromYMD = (y: number, m: number, d: number) => Math.round(Date.UTC(y, m - 1, d) / MS_DAY);
export const isoDay = (day: number) => new Date(day * MS_DAY).toISOString().slice(0, 10);
export function parseIsoDay(s: string): number { const [y, m, d] = s.split("-").map(Number); return dayFromYMD(y, m, d); }
export const dow = (day: number) => (((day + 4) % 7) + 7) % 7;                        // 0 = Sunday (1970-01-01 = Thu)
function ymdOf(day: number): [number, number, number] {
  const t = new Date(day * MS_DAY); return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}
export const dayOfMonth = (day: number) => ymdOf(day)[2];

export function periodStart(tf: Timeframe, day: number): number {
  if (tf === "daily") return day;
  if (tf === "weekly") return day - ((dow(day) + 6) % 7);                             // Monday
  const [y, m] = ymdOf(day); return dayFromYMD(y, m, 1);
}
export function periodLastCalendarDay(tf: Timeframe, day: number): number {
  if (tf === "daily") return day;
  if (tf === "weekly") return periodStart("weekly", day) + 6;                         // Sunday
  const [y, m] = ymdOf(day); return dayFromYMD(y, m + 1, 1) - 1;
}

// Unscheduled full-day NYSE closures (weather, funerals, 9/11, Sandy...). Scheduled holidays come from rules below.
const SPECIAL_CLOSURES = [
  "1969-02-10", "1969-03-31", "1969-07-21", "1972-12-28", "1973-01-25", "1977-07-14", "1985-09-27", "1994-04-27",
  "2001-09-11", "2001-09-12", "2001-09-13", "2001-09-14", "2004-06-11", "2007-01-02", "2012-10-29", "2012-10-30",
  "2018-12-05", "2025-01-09",
].map(parseIsoDay);

function nthWeekday(y: number, m: number, weekday: number, nth: number): number {
  const first = dayFromYMD(y, m, 1); return first + ((weekday - dow(first) + 7) % 7) + 7 * (nth - 1);
}
function lastWeekday(y: number, m: number, weekday: number): number {
  const last = dayFromYMD(y, m + 1, 1) - 1; return last - ((dow(last) - weekday + 7) % 7);
}
function observed(day: number): number { const w = dow(day); return w === 6 ? day - 1 : w === 0 ? day + 1 : day; }
function easter(y: number): number {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), dd = ((h + l - 7 * m + 114) % 31) + 1;
  return dayFromYMD(y, month, dd);
}
const holidayCache = new Map<number, Set<number>>();
function holidays(y: number): Set<number> {
  let s = holidayCache.get(y);
  if (s) return s;
  s = new Set<number>();
  const ny = dayFromYMD(y, 1, 1);
  if (dow(ny) === 0) s.add(ny + 1); else if (dow(ny) !== 6) s.add(ny);              // Saturday New Year: no closure
  if (y >= 1998) s.add(nthWeekday(y, 1, 1, 3));                                       // MLK Day
  s.add(y >= 1971 ? nthWeekday(y, 2, 1, 3) : observed(dayFromYMD(y, 2, 22)));          // Washington's Birthday
  s.add(easter(y) - 2);                                                               // Good Friday
  s.add(y >= 1971 ? lastWeekday(y, 5, 1) : observed(dayFromYMD(y, 5, 30)));            // Memorial Day
  if (y >= 2022) s.add(observed(dayFromYMD(y, 6, 19)));                                // Juneteenth
  s.add(observed(dayFromYMD(y, 7, 4)));                                               // Independence Day
  s.add(nthWeekday(y, 9, 1, 1));                                                      // Labor Day
  if (y <= 1968 || y === 1972 || y === 1976 || y === 1980) s.add(nthWeekday(y, 11, 1, 1) + 1); // Election Day
  s.add(nthWeekday(y, 11, 4, 4));                                                     // Thanksgiving
  s.add(observed(dayFromYMD(y, 12, 25)));                                             // Christmas
  for (const d of SPECIAL_CLOSURES) if (ymdOf(d)[0] === y) s.add(d);
  holidayCache.set(y, s);
  return s;
}
export function isTradingDay(day: number): boolean {
  const w = dow(day);
  return w !== 0 && w !== 6 && !holidays(ymdOf(day)[0]).has(day);
}
export function lastTradingDayOfPeriod(tf: Timeframe, day: number): number | null {
  const start = periodStart(tf, day);
  for (let d = periodLastCalendarDay(tf, day); d >= start; d--) if (isTradingDay(d)) return d;
  return null;
}

// ---------------------------------------------------------------------------------------------------- NY clock
export type NyClock = { day: number; minutes: number };
let nyFmt: Intl.DateTimeFormat | null = null;
export function nyClock(nowMs: number): NyClock {
  nyFmt ??= new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const p: Record<string, string> = {};
  for (const x of nyFmt.formatToParts(new Date(nowMs))) p[x.type] = x.value;
  return { day: dayFromYMD(+p.year, +p.month, +p.day), minutes: (+p.hour % 24) * 60 + +p.minute };
}
export const isSessionComplete = (day: number, clock: NyClock) =>
  clock.day > day || (clock.day === day && clock.minutes >= SESSION_DONE_MIN);

// End (last trading day) of the period that contains `day`, by calendar.
export function calendarPeriodEnd(tf: Timeframe, day: number): number {
  return tf === "daily" ? day : (lastTradingDayOfPeriod(tf, day) ?? periodLastCalendarDay(tf, day));
}
export const isPeriodComplete = (tf: Timeframe, day: number, clock: NyClock) => isSessionComplete(calendarPeriodEnd(tf, day), clock);

export function lastCompletedSessionDay(clock: NyClock): number {
  for (let d = clock.day, k = 0; k < 40; d--, k++) if (isTradingDay(d) && isSessionComplete(d, clock)) return d;
  throw new Error("no completed session in 40 days");
}
// The scan_date a complete scan of `tf` produces right now: last trading day of the last COMPLETED period.
export function expectedScanDay(tf: Timeframe, clock: NyClock): number {
  const d = lastCompletedSessionDay(clock);
  if (tf === "daily" || lastTradingDayOfPeriod(tf, d) === d) return d;
  let p = periodStart(tf, d) - 1;
  for (let k = 0; k < 12; k++) {
    const e = lastTradingDayOfPeriod(tf, p);
    if (e != null) return e;
    p = periodStart(tf, p) - 1;
  }
  throw new Error("no trading day in 12 periods");
}

// ---------------------------------------------------------------------------------------------------- bars
export type Bars = { ts: number[]; opens: number[]; highs: number[]; lows: number[]; closes: number[] };
export type DayBars = Bars & { days: number[] };

// Yahoo v8 chart URL, shared by bx-scan and bx-backtest-builder. Monthly MUST use explicit period1/period2: with
// `interval=1mo&range=max` Yahoo silently downgrades long histories to 3mo bars and short ones to 1wk/1d (live check
// 2026-10-24: KO/GE/AAPL -> 3mo, ALKT/SOFI -> 1wk), which is how weekly bars once landed under timeframe=monthly
// (em-5). `period1=0&period2=<now>` returns true 1mo bars (from 1970 or the listing date). Daily 2y / weekly 10y
// return the requested granularity. `nowMs` is passed in (no clock reads in this module).
export const YF_INTERVAL: Record<Timeframe, string> = { daily: "1d", weekly: "1wk", monthly: "1mo" };
export function yahooChartUrl(ticker: string, tf: Timeframe, nowMs: number): string {
  const span = tf === "monthly" ? `period1=0&period2=${Math.floor(nowMs / 1000)}` : `range=${tf === "daily" ? "2y" : "10y"}`;
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${YF_INTERVAL[tf]}&${span}`;
}

// symbols=CSV param (both functions): trimmed, uppercased, every symbol must match SYMBOL_RE; null if any does not
// (caller returns 400). Symbols are also encodeURIComponent'd wherever they go into a URL.
export const SYMBOL_RE = /^[A-Z0-9.$^\/-]{1,20}$/;
export function parseSymbols(csv: string): string[] | null {
  const out = csv.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  return out.length && out.every((s) => SYMBOL_RE.test(s)) ? out : null;
}

// Keep only bars whose timestamp and OHLC are all finite numbers (vendor nulls dropped, as TradingView has no bar).
export function cleanBars(ts: ArrayLike<unknown>, o: ArrayLike<unknown>, h: ArrayLike<unknown>, l: ArrayLike<unknown>, c: ArrayLike<unknown>): Bars {
  const out: Bars = { ts: [], opens: [], highs: [], lows: [], closes: [] };
  const n = Math.min(ts.length, o.length, h.length, l.length, c.length);
  for (let i = 0; i < n; i++) {
    const T = Number(ts[i]), O = Number(o[i]), H = Number(h[i]), L = Number(l[i]), C = Number(c[i]);
    if (ts[i] == null || o[i] == null || h[i] == null || l[i] == null || c[i] == null) continue;
    if (!fin(T) || !fin(O) || !fin(H) || !fin(L) || !fin(C)) continue;
    out.ts.push(T); out.opens.push(O); out.highs.push(H); out.lows.push(L); out.closes.push(C);
  }
  return out;
}

export class BarIntegrityError extends Error {}
const MEDIAN_GAP: Record<Timeframe, [number, number]> = { daily: [1, 4], weekly: [5, 9], monthly: [26, 33] };

// Validates cadence and returns only COMPLETED bars (em-4, em-5, em-7, C5, C6):
//  - timestamps must ascend; one bar per period. The ONLY duplicate allowed is the final pair (Yahoo sends the live
//    bar separately); it is merged (first open, max high, min low, last close). Any other duplicate period, or a
//    median bar spacing that does not fit `tf`, throws BarIntegrityError: weekly data can never be stored as monthly.
//  - the last bar is dropped when its period is not complete at `clock` (in-progress day/week/month).
export function completedBars(tf: Timeframe, b: Bars, clock: NyClock): { bars: DayBars; droppedInProgress: boolean } {
  const ts = b.ts.slice(), o = b.opens.slice(), h = b.highs.slice(), l = b.lows.slice(), c = b.closes.slice();
  const days = ts.map(dayOfTs);
  for (let i = 1; i < days.length; i++) if (ts[i] < ts[i - 1]) throw new BarIntegrityError("timestamps not ascending");
  let n = days.length;
  if (n >= 2 && periodStart(tf, days[n - 1]) === periodStart(tf, days[n - 2])) {
    const j = n - 2;
    o[n - 1] = o[j]; h[n - 1] = Math.max(h[j], h[n - 1]); l[n - 1] = Math.min(l[j], l[n - 1]);
    for (const a of [ts, o, h, l, c, days]) a.splice(j, 1);
    n--;
  }
  for (let i = 1; i < n; i++) {
    if (periodStart(tf, days[i]) <= periodStart(tf, days[i - 1])) throw new BarIntegrityError(`duplicate ${tf} period at ${isoDay(days[i])}`);
  }
  if (n >= 12) {
    const gaps: number[] = [];
    for (let i = 1; i < n; i++) gaps.push(days[i] - days[i - 1]);
    gaps.sort((a, z) => a - z);
    const med = gaps[gaps.length >> 1], [lo, hi] = MEDIAN_GAP[tf];
    if (med < lo || med > hi) throw new BarIntegrityError(`median bar gap ${med}d does not fit ${tf}`);
  }
  let dropped = false;
  if (n > 0 && !isPeriodComplete(tf, days[n - 1], clock)) {
    for (const a of [ts, o, h, l, c, days]) a.pop();
    dropped = true;
  }
  return { bars: { ts, opens: o, highs: h, lows: l, closes: c, days }, droppedInProgress: dropped };
}

// Exact last trading day of each bar's period (C6 signal_date). daily: the bar date. weekly/monthly: the last daily
// bar inside the period when the daily series reaches the calendar end of that period (exact, including unlisted
// closures); otherwise the NYSE calendar (older periods outside the daily history, or the newest period when daily
// data lags). Errors in the fallback can only make a label LATER than the truth, never earlier, so MTF lookups that
// use these ends cannot see the future.
export function periodEnds(tf: Timeframe, days: number[], dailyDays: number[] | null): number[] {
  if (tf === "daily") return days.slice();
  const maxIn = new Map<number, number>();
  if (dailyDays) for (const d of dailyDays) { const k = periodStart(tf, d); const v = maxIn.get(k); if (v == null || d > v) maxIn.set(k, d); }
  const lastDaily = dailyDays && dailyDays.length ? dailyDays[dailyDays.length - 1] : -Infinity;
  return days.map((d) => {
    const cal = calendarPeriodEnd(tf, d);
    const fromDaily = maxIn.get(periodStart(tf, d));
    return fromDaily != null && lastDaily >= cal ? fromDaily : cal;
  });
}

// Last index j with ends[j] <= day (ends ascending), or -1. Used for no-look-ahead MTF alignment (em-3): the
// higher-timeframe bar is used only once its period has closed at or before the signal bar's own period end.
export function asOfIndex(ends: ArrayLike<number>, day: number): number {
  let lo = 0, hi = ends.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (ends[m] <= day) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}

// ---------------------------------------------------------------------------------------------------- returns
// Forward returns are BAR offsets (5/20/60/120 bars = weeks/months on weekly/monthly; the ret_*d column names are
// historical -- em-11 is a frontend label fix). Percent, rounded to 2 decimals.
export const HORIZONS = [5, 20, 60, 120] as const;
export function forwardReturn(closes: ArrayLike<number>, i: number, off: number): number | null {
  const p = closes[i + off];
  return p == null || !fin(p) || !(closes[i] > 0) ? null : r2((p / closes[i] - 1) * 100);
}
// "BX outlier rule v1" -- the ONE bad-price rule, identical to bx_backtest_summary (supabase/sql/22_backtest_summary.sql):
//   a. a row/bar is excluded from all statistics when its entry close (price_at_signal, 2 decimals) is < 1.00;
//   b. a single horizon return > +10000 % is a bad print and is excluded for that horizon only.
export const OUTLIER_MIN_PRICE = 1;
export const OUTLIER_MAX_RET_PCT = 10_000;
export const priceIncluded = (price: number) => r2(price) >= OUTLIER_MIN_PRICE;
export const retIncluded = (ret: number | null): ret is number => ret != null && ret <= OUTLIER_MAX_RET_PCT;

export type Baseline = {
  n_bars: number;
  sum_ret_5: number; n_ret_5: number; wins_5: number;
  sum_ret_20: number; n_ret_20: number; wins_20: number;
  sum_ret_60: number; n_ret_60: number; wins_60: number;
  sum_ret_120: number; n_ret_120: number; wins_120: number;
};
// Unconditional base rate (C6): EVERY completed bar, same return definition, same outlier rule v1 (n_bars = completed
// bars with close >= 1.00; a horizon counts only when bar i+h exists and the return is <= +10000 %).
export function baselineAggregate(closes: ArrayLike<number>): Baseline {
  const b: Baseline = {
    n_bars: 0, sum_ret_5: 0, n_ret_5: 0, wins_5: 0, sum_ret_20: 0, n_ret_20: 0, wins_20: 0,
    sum_ret_60: 0, n_ret_60: 0, wins_60: 0, sum_ret_120: 0, n_ret_120: 0, wins_120: 0,
  };
  const acc = b as unknown as Record<string, number>;
  for (let i = 0; i < closes.length; i++) {
    if (!fin(closes[i]) || !priceIncluded(closes[i])) continue;
    b.n_bars++;
    for (const hz of HORIZONS) {
      const r = forwardReturn(closes, i, hz);
      if (!retIncluded(r)) continue;
      acc[`sum_ret_${hz}`] += r; acc[`n_ret_${hz}`]++; if (r > 0) acc[`wins_${hz}`]++;
    }
  }
  for (const hz of HORIZONS) acc[`sum_ret_${hz}`] = Math.round(acc[`sum_ret_${hz}`] * 1e6) / 1e6;
  return b;
}
