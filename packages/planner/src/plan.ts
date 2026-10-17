/**
 * Plan (11.6): from a stretch and the rider's inputs to days, nights, plan items and the trip brief.
 *
 * `makePlan` is pure and deterministic, so it doubles as the assistant's "what if" tool (D38): call it with other
 * inputs and nothing is saved.
 */
import type { RiderLevel, Stop } from "@dpg/contracts";
import { TripAxis } from "./axis";
import { makeBrief } from "./brief";
import { planItems } from "./items";
import { type Rider, riderFor, usualDay } from "./pace";
import {
  alternatives,
  bedsFor,
  type Candidate,
  type DayContext,
  fixedStages,
  planB,
  planStages,
  type StagePlan,
  usable,
} from "./stages";
import { addDays, monthOf, sunTimes } from "./sun";
import { km as kmText, MONTHS_LONG, stopName } from "./text";
import {
  type Brief,
  type DayPlan,
  NO_CHOICES,
  type NightPlan,
  type PlanChoices,
  type PlanData,
  type PlanInputs,
  type PlanItem,
  type RouteRef,
} from "./types";

const END_MARGIN_M = 1000;

export interface DaysOffer {
  days: number;
  why: string;
  plan: StagePlan;
}

export interface PlanResult {
  route: RouteRef;
  inputs: PlanInputs;
  choices: PlanChoices;
  mode: "free" | "full";
  level: RiderLevel;
  rider: Rider;
  usual: { km: number; climbM: number; hours: number };
  axis: TripAxis;
  candidates: Candidate[];
  days: DayPlan[];
  nights: NightPlan[];
  items: PlanItem[];
  brief: Brief;
  offers: DaysOffer[];
  endDate: string;
}

function nearestStop(stops: Stop[], m: number): Stop | null {
  let best: Stop | null = null;
  for (const s of stops) if (!best || Math.abs(s.at_m - m) < Math.abs(best.at_m - m)) best = s;
  return best;
}

/** A name for a place on the route: a named stop within 5 km, a daily section's end, else its km. */
export function placeName(data: PlanData, m: number): string {
  let best: Stop | null = null;
  for (const s of data.stops.stops) {
    if (!s.name || Math.abs(s.at_m - m) > 5000) continue;
    if (!best || Math.abs(s.at_m - m) < Math.abs(best.at_m - m)) best = s;
  }
  if (best?.name) return best.name;
  for (const d of data.daily) {
    if (Math.abs(d.from_m - m) < 3000 && d.start_name) return d.start_name;
    if (Math.abs(d.to_m - m) < 3000 && d.end_name) return d.end_name;
  }
  return `km ${Math.round(m / 1000)}`;
}

function pseudoStop(id: string, m: number, near: Stop | null): Stop {
  return {
    id,
    name: null,
    place_kind: null,
    at_m: m,
    lon: near?.lon ?? 0,
    lat: near?.lat ?? 0,
    country: near?.country ?? null,
    detour_m: null,
    beds: [],
    services: {},
    station: null,
    station_at_m: null,
  };
}

export function makePlan(data: PlanData, inputs: PlanInputs, choices: PlanChoices = NO_CHOICES): PlanResult {
  const levels = data.dream.levels;
  const level = levels.find((l) => l.level === inputs.level) ?? levels[2] ?? levels[0]!;
  const rider = riderFor(level.level, inputs.bike);
  const usual = usualDay(rider, level.km_min, level.km_max, level.climb_max_m);
  const month0 = monthOf(inputs.startDate);
  const axis = new TripAxis(data.effort, inputs.fromM, inputs.toM, inputs.direction, rider, data.dream.sections, (s) =>
    s.climate ? (s.climate.wind_along_ms[month0] ?? null) : null,
  );
  const lo = Math.min(inputs.fromM, inputs.toM) + END_MARGIN_M;
  const hi = Math.max(inputs.fromM, inputs.toM) - END_MARGIN_M;
  const candidates: Candidate[] = data.stops.stops
    .filter((s) => s.at_m > lo && s.at_m < hi)
    .map((stop) => ({ stop, t: axis.tOf(stop.at_m) }))
    .sort((a, b) => a.t - b.t || a.stop.id.localeCompare(b.stop.id));

  const rides = Math.max(1, Math.round(inputs.days));
  const rest = new Set(inputs.restAfter.filter((r) => r >= 1 && r < rides));
  const dayDate = (k: number) => addDays(inputs.startDate, k + [...rest].filter((r) => r <= k).length);
  const endStop = nearestStop(data.stops.stops, axis.endM);
  const ctx: DayContext = {
    axis,
    candidates,
    level,
    usualHours: usual.hours,
    sleep: inputs.sleep,
    startMinutes: inputs.startMinutes,
    stopStyle: inputs.stopStyle,
    dayDate,
    end: { lat: endStop?.lat ?? 0, lon: endStop?.lon ?? 0, country: endStop?.country ?? null },
  };
  const index = new Map(candidates.map((c, i) => [c.stop.id, i]));
  const locked = new Map<number, number>();
  for (const [k, id] of Object.entries(choices.locked)) {
    const i = index.get(id);
    if (i !== undefined && Number(k) < rides - 1) locked.set(Number(k), i);
  }

  let stage: StagePlan | null = null;
  const fixed = choices.nights?.map((id) => index.get(id));
  if (fixed && fixed.length === rides - 1 && fixed.every((i) => i !== undefined)) {
    stage = fixedStages(ctx, fixed as number[]);
  }
  stage ??= planStages(ctx, rides, locked);
  if (!stage) {
    // No stop of the rider's kind within reach: nights go where the days split evenly, with no known bed there.
    for (let k = 0; k < rides - 1; k++) {
      const t = (axis.length * (k + 1)) / rides;
      const m = axis.mOf(t);
      candidates.push({ stop: pseudoStop(`none-${k + 1}`, m, nearestStop(data.stops.stops, m)), t });
    }
    candidates.sort((a, b) => a.t - b.t);
    const ids = candidates.map((c) => c.stop.id);
    stage = fixedStages(
      ctx,
      Array.from({ length: rides - 1 }, (_, k) => ids.indexOf(`none-${k + 1}`)),
    );
  }

  // A day more or fewer, when it makes the plan clearly better (D48: Dream's number by default).
  const offers: DaysOffer[] = [];
  if (!choices.nights) {
    const score = (p: StagePlan) => ({
      beyond: p.days.filter((d) => d.effort === "beyond").length,
      dark: p.days.filter((d) => d.afterSunset).length,
      cost: p.cost,
    });
    const now = score(stage);
    for (const n of [rides + 1, rides - 1]) {
      if (n < 1 || n > rides * 2) continue;
      const alt = planStages(ctx, n, new Map());
      if (!alt) continue;
      const s = score(alt);
      const fewerHard = s.beyond < now.beyond || (s.beyond === now.beyond && s.dark < now.dark);
      if (n > rides && fewerHard) {
        const what = s.beyond < now.beyond ? "no day beyond your level" : "no day ending after sunset";
        offers.push({ days: n, why: `${n} riding days instead of ${rides}: ${what}`, plan: alt });
      } else if (n < rides && s.beyond <= now.beyond && s.dark <= now.dark && s.cost < now.cost * 0.75) {
        offers.push({ days: n, why: `${n} riding days instead of ${rides}: days closer to your usual`, plan: alt });
      }
    }
  }

  // Calendar days, with rest days.
  const days: DayPlan[] = [];
  const nightsOut: NightPlan[] = [];
  let number = 0;
  for (let k = 0; k < rides; k++) {
    const d = stage.days[k]!;
    const stats = d.stats!;
    const t0 = k === 0 ? 0 : candidates[stage.nights[k - 1]!]!.t;
    const t1 = k === rides - 1 ? axis.length : candidates[stage.nights[k]!]!.t;
    const stop = k === rides - 1 ? null : candidates[stage.nights[k]!]!.stop;
    const date = dayDate(k);
    const where = stop ?? endStop;
    const sun = sunTimes(date, where?.lat ?? 0, where?.lon ?? 0, where?.country ?? null);
    const fromM = axis.mOf(t0);
    const toM = axis.mOf(t1);
    number += 1;
    days.push({
      number,
      ride: k + 1,
      date,
      kind: "ride",
      fromT: t0,
      toT: t1,
      fromM: k === 0 ? axis.startM : fromM,
      toM: k === rides - 1 ? axis.endM : toM,
      startName: k === 0 ? placeName(data, axis.startM) : stopName(candidates[stage.nights[k - 1]!]!.stop),
      stop,
      endName: stop ? stopName(stop) : placeName(data, axis.endM),
      km: stats.km,
      climbM: stats.climbM,
      unknownKm: stats.unknownKm,
      hoursFast: stats.fastS / 3600,
      hoursSlow: stats.slowS / 3600,
      stopsMin: d.endMinutes - inputs.startMinutes - stats.slowS / 60,
      startMinutes: inputs.startMinutes,
      endMinutes: d.endMinutes,
      sunrise: sun.sunrise,
      sunset: sun.sunset,
      clockApprox: sun.approximate,
      effort: d.effort,
      surfaces: stats.surfaces,
      gaps: stats.gaps,
      tailwindMs: stats.tailwindMs,
      steepest: (() => {
        const s = axis.steepest(t0, t1);
        return s ? { grade: s.grade, atKm: (s.t - t0) / 1000 } : null;
      })(),
      sections: stats.sections,
    });
    if (stop) {
      const ci = stage.nights[k]!;
      const b = bedsFor(stop, inputs.sleep, monthOf(date));
      const alts = alternatives(ctx, stage, k).map((a) => ({
        stop: candidates[a.c]!.stop,
        dayKm: a.dayKm,
        nextKm: a.nextKm,
      }));
      const pb = planB(ctx, stage, k);
      const shift = (j: number | null) =>
        j === null ? null : { stop: candidates[j]!.stop, km: (candidates[j]!.t - candidates[ci]!.t) / 1000 };
      const known = b.open + b.partly;
      const bedText =
        b.count === 0
          ? "no known place to stay of your kind"
          : `${b.count - b.closed} ${b.count - b.closed === 1 ? "bed" : "beds"} of your kind, ${known} known open in ${MONTHS_LONG[monthOf(date)]}`;
      const extras = [
        (stop.services.food ?? 0) > 0 ? "food" : null,
        stop.station ? "a station" : null,
      ].filter(Boolean);
      nightsOut.push({
        index: k,
        date,
        afterRide: k + 1,
        stop,
        locked: locked.get(k) === ci,
        beds: { count: b.count - b.closed, open: b.open, partly: b.partly, unknown: b.unknown },
        alternatives: alts,
        planB: { before: shift(pb.before), after: shift(pb.after) },
        why: `Stopping ${stop.name ? `at ${stop.name}` : stopName(stop)}: ${bedText}${extras.length ? `; ${extras.join(" and ")}` : ""}; makes a ${kmText(stats.km)} km day.`,
      });
      if (rest.has(k + 1)) {
        number += 1;
        days.push({
          ...days[days.length - 1]!,
          number,
          ride: null,
          date: addDays(date, 1),
          kind: "rest",
          fromT: t1,
          toT: t1,
          fromM: toM,
          toM,
          startName: stopName(stop),
          endName: stopName(stop),
          km: 0,
          climbM: 0,
          unknownKm: 0,
          hoursFast: 0,
          hoursSlow: 0,
          stopsMin: 0,
          endMinutes: inputs.startMinutes,
          effort: "within",
          surfaces: { r: 0, c: 0, g: 0, u: 0 },
          gaps: [],
          tailwindMs: null,
          steepest: null,
        });
      }
    }
  }

  const partial = {
    route: data.route,
    inputs,
    choices,
    mode: data.full ? ("full" as const) : ("free" as const),
    level,
    rider,
    usual,
    axis,
    candidates,
    days,
    nights: nightsOut,
    offers,
    endDate: days[days.length - 1]!.date,
  };
  const items = planItems(data, partial);
  const brief = makeBrief(data, partial, items);
  return { ...partial, items, brief };
}

export type PlanCore = Omit<PlanResult, "items" | "brief">;

export { stopName, usable };
