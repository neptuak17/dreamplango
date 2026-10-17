/**
 * The stage planner (11.6): one stop per night, by dynamic programming over the candidate stops in trip order.
 *
 * A day costs more the further its riding hours are from the rider's usual day (more when over than under), and much
 * more when it breaks a hard limit (beyond the level, ending after sunset). A stop is worth more with known-open beds
 * of the rider's kind, food and a station. Locked nights are fixed points; the rest re-plans around them. Hours are
 * planned on the slow end of their range, so the plan holds if the unknown turns out rough (D37).
 */
import type { RiderLevel, Stop } from "@dpg/contracts";
import type { Stats, TripAxis } from "./axis";
import { stopMinutes } from "./pace";
import { monthOf, sunTimes } from "./sun";
import type { Effort, Sleep, StopStyle } from "./types";

export const ROOM_KINDS = new Set(["hotel", "guest_house", "hostel", "hut", "other"]);
const MIN_DAY_SHARE = 0.25;
const MAX_DAY_SHARE = 2.4;
const HARD_OVER = 1.2;

export interface Candidate {
  stop: Stop;
  t: number;
}

export interface BedCount {
  count: number;
  open: number;
  partly: number;
  closed: number;
  unknown: number;
}

/** Beds of the rider's kind at a stop in a month (D18). */
export function bedsFor(stop: Stop, sleep: Sleep, month: number): BedCount {
  const out: BedCount = { count: 0, open: 0, partly: 0, closed: 0, unknown: 0 };
  for (const b of stop.beds) {
    const camping = b.kind === "campsite";
    if (sleep === "camping" ? !camping : sleep === "rooms" ? !ROOM_KINDS.has(b.kind) : false) continue;
    for (const [code, n] of b.seasons) {
      out.count += n;
      const c = code[month] ?? "?";
      if (c === "o") out.open += n;
      else if (c === "p") out.partly += n;
      else if (c === "c") out.closed += n;
      else out.unknown += n;
    }
  }
  return out;
}

export const usable = (b: BedCount) => b.count - b.closed > 0;

/** 0-1: how good a stop is for the night, from what we know (never from guesses about the unknown, D37). */
export function quality(b: BedCount, stop: Stop): number {
  const known = b.open + b.partly > 0 ? 0.5 : b.unknown > 0 ? 0.2 : 0;
  return (
    known +
    0.2 * Math.min(1, (b.count - b.closed) / 3) +
    0.15 * ((stop.services.food ?? 0) > 0 ? 1 : 0) +
    0.15 * (stop.station ? 1 : 0)
  );
}

export function effortOf(
  stats: { km: number; climbM: number },
  hours: number,
  usualHours: number,
  level: RiderLevel,
): Effort {
  const km = stats.km;
  const climb = stats.climbM;
  const over = Math.max(km / level.km_max, climb / level.climb_max_m, hours / (usualHours * 1.35));
  if (over <= 1) return "within";
  return over <= HARD_OVER ? "harder" : "beyond";
}

export interface DayContext {
  axis: TripAxis;
  candidates: Candidate[];
  level: RiderLevel;
  usualHours: number;
  sleep: Sleep;
  startMinutes: number;
  stopStyle: StopStyle;
  /** Date of riding day k (0-based). */
  dayDate: (k: number) => string;
  /** Where the trip ends, for the last day's sunset. */
  end: { lat: number; lon: number; country: string | null };
  /** Sunset cache: date and place -> minutes. */
  sunsets?: Map<string, number | null>;
}

export interface DayEval {
  /** Full statistics: only for the days of a finished plan (see `withStats`). */
  stats: Stats | null;
  km: number;
  climbM: number;
  fastS: number;
  slowS: number;
  hours: number;
  effort: Effort;
  endMinutes: number;
  sunset: number | null;
  afterSunset: boolean;
  cost: number;
}

function sunsetAt(ctx: DayContext, date: string, endStop: Stop | null): number | null {
  const key = `${date}|${endStop?.id ?? "end"}`;
  ctx.sunsets ??= new Map();
  if (!ctx.sunsets.has(key)) {
    const where = endStop ? { lat: endStop.lat, lon: endStop.lon, country: endStop.country } : ctx.end;
    ctx.sunsets.set(key, sunTimes(date, where.lat, where.lon, where.country).sunset);
  }
  return ctx.sunsets.get(key) ?? null;
}

export function evalDay(
  ctx: DayContext,
  k: number,
  t0: number,
  t1: number,
  endStop: Stop | null,
  last: boolean,
  full = false,
): DayEval {
  const q = ctx.axis.quick(t0, t1);
  const hours = q.slowS / 3600;
  const effort = effortOf(q, hours, ctx.usualHours, ctx.level);
  const sunset = sunsetAt(ctx, ctx.dayDate(k), endStop);
  const riding = q.slowS / 60;
  const endMinutes = ctx.startMinutes + riding + stopMinutes(riding, ctx.stopStyle);
  const afterSunset = sunset !== null && endMinutes > sunset;
  const r = hours / ctx.usualHours;
  let cost = r > 1 ? 3 * (r - 1) ** 2 : (1 - r) ** 2;
  if (effort === "harder") cost += 0.5;
  if (effort === "beyond") cost += 4;
  if (afterSunset) cost += 3;
  const stats = full ? ctx.axis.stats(t0, t1, last) : null;
  return { stats, ...q, hours, effort, endMinutes, sunset, afterSunset, cost };
}

function nightCost(c: Candidate, sleep: Sleep, month: number): number {
  const b = bedsFor(c.stop, sleep, month);
  if (!usable(b)) return Number.POSITIVE_INFINITY;
  return (1 - quality(b, c.stop)) * 0.8;
}

function firstAtLeast(xs: number[], v: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function lastAtMost(xs: number[], v: number): number {
  return firstAtLeast(xs, v + 1e-9) - 1;
}

export interface StagePlan {
  /** Candidate index per night. */
  nights: number[];
  cost: number;
  days: DayEval[];
}

/**
 * Best nights for `rides` riding days. `locked`: night -> candidate index. `relaxed` drops the day-length window,
 * for stretches whose stops are too far apart for it.
 */
export function planStages(ctx: DayContext, rides: number, locked: Map<number, number>, relaxed = false): StagePlan | null {
  const C = ctx.candidates;
  const T = ctx.axis.length;
  const nights = rides - 1;
  if (nights <= 0) {
    const day = evalDay(ctx, 0, 0, T, null, true, true);
    return { nights: [], cost: day.cost, days: [day] };
  }
  const minS = relaxed ? 0 : MIN_DAY_SHARE * ctx.usualHours * 3600;
  const maxS = relaxed ? Number.POSITIVE_INFINITY : MAX_DAY_SHARE * ctx.usualHours * 3600;
  const slowAt = (t: number) => ctx.axis.quick(0, t).slowS;
  const slow = C.map((c) => slowAt(c.t));
  const totalSlow = slowAt(T);
  const month = (k: number) => monthOf(ctx.dayDate(k));
  // A night the rider locked is kept even with no bed of their kind (they chose it): flagged, never dropped.
  const LOCKED_NO_BED = 5;
  const nc: number[][] = Array.from({ length: nights }, (_, k) =>
    C.map((c, j) => {
      const cost = nightCost(c, ctx.sleep, month(k));
      return !Number.isFinite(cost) && locked.get(k) === j ? LOCKED_NO_BED : cost;
    }),
  );
  const cost: number[][] = Array.from({ length: nights }, () => new Array<number>(C.length).fill(Number.POSITIVE_INFINITY));
  const from: number[][] = Array.from({ length: nights }, () => new Array<number>(C.length).fill(-1));
  const dayCache = new Map<string, DayEval>();
  const day = (k: number, i: number, j: number): DayEval => {
    const key = `${k}:${i}:${j}`;
    let d = dayCache.get(key);
    if (!d) {
      const t0 = i < 0 ? 0 : C[i]!.t;
      const t1 = j < 0 ? T : C[j]!.t;
      d = evalDay(ctx, k, t0, t1, j < 0 ? null : C[j]!.stop, j < 0);
      dayCache.set(key, d);
    }
    return d;
  };
  const allowed = (k: number, j: number) => {
    const lock = locked.get(k);
    return lock === undefined || lock === j;
  };
  for (let k = 0; k < nights; k++) {
    for (let j = 0; j < C.length; j++) {
      if (!allowed(k, j) || !Number.isFinite(nc[k]![j]!)) continue;
      if (k === 0) {
        if (slow[j]! < minS || slow[j]! > maxS) continue;
        cost[0]![j] = day(0, -1, j).cost + nc[0]![j]!;
        continue;
      }
      // Candidates are in trip order, so the ones a day's length away form one run: find it by binary search.
      const hiI = Math.min(j - 1, lastAtMost(slow, slow[j]! - minS));
      for (let i = Math.max(0, firstAtLeast(slow, slow[j]! - maxS)); i <= hiI; i++) {
        const prev = cost[k - 1]![i]!;
        if (!Number.isFinite(prev)) continue;
        const c = prev + day(k, i, j).cost + nc[k]![j]!;
        if (c < cost[k]![j]!) {
          cost[k]![j] = c;
          from[k]![j] = i;
        }
      }
    }
  }
  let best = Number.POSITIVE_INFINITY;
  let bestJ = -1;
  for (let j = 0; j < C.length; j++) {
    const prev = cost[nights - 1]![j]!;
    if (!Number.isFinite(prev)) continue;
    const span = totalSlow - slow[j]!;
    if (span < minS || span > maxS) continue;
    const c = prev + day(rides - 1, j, -1).cost;
    if (c < best) {
      best = c;
      bestJ = j;
    }
  }
  if (bestJ < 0) return relaxed ? null : planStages(ctx, rides, locked, true);
  const chosen: number[] = new Array<number>(nights);
  let j = bestJ;
  for (let k = nights - 1; k >= 0; k--) {
    chosen[k] = j;
    j = from[k]![j]!;
  }
  return withStats(ctx, { nights: chosen, cost: best, days: [] });
}

/** Re-evaluates a plan's days with their full statistics. */
export function withStats(ctx: DayContext, plan: StagePlan): StagePlan {
  const C = ctx.candidates;
  const n = plan.nights.length;
  const days: DayEval[] = [];
  for (let k = 0; k <= n; k++) {
    const t0 = k === 0 ? 0 : C[plan.nights[k - 1]!]!.t;
    const t1 = k === n ? ctx.axis.length : C[plan.nights[k]!]!.t;
    days.push(evalDay(ctx, k, t0, t1, k === n ? null : C[plan.nights[k]!]!.stop, k === n, true));
  }
  return { ...plan, days };
}

/** Keeps the given nights as they are (a saved or shared plan), re-timing the days only. */
export function fixedStages(ctx: DayContext, nights: number[]): StagePlan {
  const plan = withStats(ctx, { nights, cost: 0, days: [] });
  return { ...plan, cost: plan.days.reduce((a, d) => a + d.cost, 0) };
}

/** Night alternatives: other usable stops near the chosen one, best by the two days around them. */
export function alternatives(ctx: DayContext, plan: StagePlan, k: number, limit = 4) {
  const C = ctx.candidates;
  const prevT = k === 0 ? 0 : C[plan.nights[k - 1]!]!.t;
  const nextT = k + 1 < plan.nights.length ? C[plan.nights[k + 1]!]!.t : ctx.axis.length;
  const isLastNight = k === plan.nights.length - 1;
  const out: { c: number; cost: number; dayKm: number; nextKm: number }[] = [];
  for (let j = 0; j < C.length; j++) {
    const c = C[j]!;
    if (j === plan.nights[k] || c.t <= prevT || c.t >= nextT) continue;
    const n = nightCost(c, ctx.sleep, monthOf(ctx.dayDate(k)));
    if (!Number.isFinite(n)) continue;
    const a = evalDay(ctx, k, prevT, c.t, c.stop, false);
    const b = evalDay(ctx, k + 1, c.t, nextT, isLastNight ? null : C[plan.nights[k + 1]!]!.stop, isLastNight);
    out.push({ c: j, cost: a.cost + b.cost + n, dayKm: a.km, nextKm: b.km });
  }
  out.sort((x, y) => x.cost - y.cost);
  return out.slice(0, limit);
}

/** The nearest usable stops before and after the chosen one. */
export function planB(ctx: DayContext, plan: StagePlan, k: number) {
  const C = ctx.candidates;
  const chosen = plan.nights[k]!;
  const month = monthOf(ctx.dayDate(k));
  const ok = (j: number) => j !== chosen && usable(bedsFor(C[j]!.stop, ctx.sleep, month));
  let before: number | null = null;
  for (let j = chosen - 1; j >= 0; j--) {
    if (ok(j)) {
      before = j;
      break;
    }
  }
  let after: number | null = null;
  for (let j = chosen + 1; j < C.length; j++) {
    if (ok(j)) {
      after = j;
      break;
    }
  }
  return { before, after };
}
