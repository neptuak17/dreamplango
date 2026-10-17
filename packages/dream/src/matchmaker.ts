/**
 * The Dream matchmaker (DESIGN.md 11.4, D35, D36): rank runs of consecutive daily sections on one route for a
 * rider's wishes. It works on `dream.json` summaries alone, so it can run in a browser or, later, on a phone.
 *
 * Missing data never lowers a stretch's rank; it is listed under "check yourself" instead (D37).
 */
import type { DreamFile, DreamSection, RiderLevel } from "@dpg/contracts";

export type Pref = "prefer" | "ok" | "avoid";
export type Way = "forward" | "reverse";
export type SurfaceKind = "road" | "cycle_path" | "gravel";

export interface DreamQuery {
  /** Rider level 1-5 (D36). */
  level: number;
  /** Riding days. */
  days: number;
  /** 0-11, or null to pick each stretch's best month. */
  month: number | null;
  surfaces: Record<SurfaceKind, Pref>;
  /** Theme ids to favour (none: themes don't affect ranking). */
  themes: string[];
  /** A bike-carrying station at both ends. */
  trainBothEnds: boolean;
  stay: "any" | "camping" | "rooms";
  avoidBusy: boolean;
  direction: "either" | Way;
  limit?: number;
}

export interface StretchResult {
  /** Section numbers, inclusive, in route order. */
  first: number;
  last: number;
  way: Way;
  km: number;
  days: number;
  kmPerDay: number;
  /** Climbing per day; null when any of it is unknown. */
  climbPerDay: number | null;
  /** When climbing is partly unknown: the known climbing per day, a minimum (D37). */
  climbMinPerDay: number | null;
  /** Km whose climbing is unknown (placeholder track). */
  climbUnknownKm: number;
  grade: number;
  /** The grade is a minimum, because climbing is partly unknown. */
  gradeAtLeast: boolean;
  month: number | null;
  comfort: number | null;
  bestTime: number | null;
  surfaces: Record<SurfaceKind | "unknown", number>;
  busyShare: number;
  topThemes: { id: string; score: number }[];
  stationStart: string | null;
  stationEnd: string | null;
  crossings: string[];
  score: number;
  why: string[];
  watch: string[];
  check: string[];
}

const TOLERANCE = 0.1;
const PREF_WEIGHT: Record<Pref, number> = { prefer: 1, ok: 0.6, avoid: 0 };
const WEIGHTS = { fit: 0.3, surfaces: 0.2, themes: 0.2, season: 0.2, wind: 0.05, stay: 0.05 };
const SURFACE_LABEL: Record<SurfaceKind, string> = { road: "road", cycle_path: "cycle paths", gravel: "gravel" };
export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const km = (m: number) => Math.round(m / 1000);
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** The lowest level whose daily range covers this much riding (D36). */
export function gradeFor(levels: RiderLevel[], kmPerDay: number, climbPerDay: number | null): number {
  for (const lv of levels) {
    if (kmPerDay <= lv.km_max && (climbPerDay === null || climbPerDay <= lv.climb_max_m)) return lv.level;
  }
  return levels[levels.length - 1]?.level ?? 5;
}

export interface Climb {
  /** Total climbing; when `unknownM` > 0, only the known part, so a minimum. null when none is known. */
  metres: number | null;
  unknownM: number;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Climbing over consecutive sections in one direction, keeping what is known apart from what isn't (D37).
 * A value that is missing (e.g. a bundle written before a field existed) counts as unknown, never as a number.
 */
export function climbOf(sections: DreamSection[], way: Way): Climb {
  let metres = 0;
  let known = false;
  let unknownM = 0;
  for (const s of sections) {
    const full = way === "forward" ? s.ascent_fwd_m : s.ascent_rev_m;
    if (isNum(full)) {
      metres += full;
      known = true;
      continue;
    }
    unknownM += isNum(s.climb_unknown_m) && s.climb_unknown_m > 0 ? s.climb_unknown_m : s.length_m;
    const part = way === "forward" ? s.ascent_known_fwd_m : s.ascent_known_rev_m;
    if (isNum(part)) {
      metres += part;
      known = true;
    }
  }
  return { metres: known ? metres : null, unknownM };
}

function weighted(sections: DreamSection[], value: (s: DreamSection) => number | null | undefined): number | null {
  let sum = 0;
  let len = 0;
  for (const s of sections) {
    const v = value(s);
    if (v === null || v === undefined) continue;
    sum += v * s.length_m;
    len += s.length_m;
  }
  return len > 0 ? sum / len : null;
}

interface Run {
  sections: DreamSection[];
  crossings: string[];
  /** Unfilled gaps crossed (D50): counted as ridden at their straight-line distance, with the terrain unknown. */
  gapM: number;
}

/** Every run of consecutive sections that doesn't cross a hard break (a long sea crossing). */
function runs(dream: DreamFile, maxKm: number): Run[] {
  const hard = new Set(dream.breaks.filter((b) => b.hard).map((b) => b.after_section));
  const soft = new Map(dream.breaks.filter((b) => !b.hard && b.type !== "discontinuity").map((b) => [b.after_section, b]));
  const ordered = [...dream.sections].sort((a, b) => a.from_m - b.from_m);
  const out: Run[] = [];
  for (let i = 0; i < ordered.length; i++) {
    let length = 0;
    let gapM = 0;
    const crossings: string[] = [];
    for (let j = i; j < ordered.length; j++) {
      const s = ordered[j]!;
      length += s.length_m;
      if (length > maxKm * 1000) break;
      out.push({ sections: ordered.slice(i, j + 1), crossings: [...crossings], gapM });
      if (hard.has(s.number)) break;
      const b = soft.get(s.number);
      if (!b) continue;
      if (b.type === "missing") {
        // Not a navigation app: however the rider bridges an unfilled gap, it is counted as ridden (D50).
        length += b.straight_distance_m;
        gapM += b.straight_distance_m;
        crossings.push(`${km(b.straight_distance_m)} km gap in the route after section ${s.number}, counted as ridden`);
      } else {
        crossings.push(`${b.type.replaceAll("_", " ")} after section ${s.number} (${km(b.straight_distance_m)} km)`);
      }
    }
  }
  return out;
}

function monthOf(sections: DreamSection[], month: number | null): number | null {
  if (month !== null) return month;
  let best: number | null = null;
  let bestScore = -1;
  for (let m = 0; m < 12; m++) {
    const v = weighted(sections, (s) => s.best_time[m] ?? s.comfort[m]);
    if (v !== null && v > bestScore) {
      bestScore = v;
      best = m;
    }
  }
  return best;
}

function evaluate(dream: DreamFile, run: Run, way: Way, q: DreamQuery): StretchResult | null {
  const level = dream.levels.find((l) => l.level === q.level) ?? dream.levels[2];
  if (!level) return null;
  const secs = way === "forward" ? run.sections : [...run.sections].reverse();
  const totalM = secs.reduce((a, s) => a + s.length_m, 0) + run.gapM;
  const kmPerDay = totalM / 1000 / q.days;
  if (kmPerDay > level.km_max * (1 + TOLERANCE) || kmPerDay < level.km_min * (1 - 3 * TOLERANCE)) return null;
  const climb = climbOf(secs, way);
  climb.unknownM += run.gapM; // nothing is known of the terrain across an unfilled gap (D37)
  const partly = climb.unknownM > 0;
  // Known climbing per day: complete, or a minimum when part is unknown. A minimum already over the limit rules the
  // run out as surely as a complete figure.
  const climbKnown = climb.metres === null ? null : climb.metres / q.days;
  if (climbKnown !== null && climbKnown > level.climb_max_m * (1 + 3 * TOLERANCE)) return null;
  const climbPerDay = partly ? null : climbKnown;

  const first = secs[0]!;
  const last = secs[secs.length - 1]!;
  const stationStart = way === "forward" ? first.station_start : first.station_end;
  const stationEnd = way === "forward" ? last.station_end : last.station_start;
  if (q.trainBothEnds && (!stationStart || !stationEnd)) return null;
  const busyShare = weighted(secs, (s) => s.busy_share) ?? 0;
  if (q.avoidBusy && busyShare > 0.15) return null;

  const surfaces = {
    road: weighted(secs, (s) => s.surfaces.road) ?? 0,
    cycle_path: weighted(secs, (s) => s.surfaces.cycle_path) ?? 0,
    gravel: weighted(secs, (s) => s.surfaces.gravel) ?? 0,
    unknown: weighted(secs, (s) => s.surfaces.unknown) ?? 0,
  };
  const why: string[] = [];
  const watch: string[] = [];
  const check = new Set<string>();
  const parts: [number, number][] = [];

  // Fit to the rider's level: best in the middle of the band; climbing above the band costs.
  const mid = (level.km_min + level.km_max) / 2;
  const half = (level.km_max - level.km_min) / 2 || 1;
  let fit = Math.max(0, 1 - Math.abs(kmPerDay - mid) / (half * 2));
  if (climbKnown !== null && climbKnown > level.climb_max_m) fit *= 0.6;
  parts.push([WEIGHTS.fit, fit]);
  const grade = gradeFor(dream.levels, kmPerDay, climbKnown);
  const climbText = climbKnown === null ? "" : ` and ${partly ? "at least " : ""}${Math.round(climbKnown)} m climbing/day`;
  why.push(
    `${Math.round(kmPerDay)} km/day${climbText}: grade ${partly ? "at least " : ""}${grade} (${dream.levels.find((l) => l.level === grade)?.name ?? ""})`,
  );
  if (partly) {
    check.add(
      `Climbing is unknown for ${(climb.unknownM / 1000).toFixed(1)} km of this stretch, so the climbing and grade shown are minimums: check the real road.`,
    );
  }

  // Surfaces (D36).
  let surf = surfaces.unknown * 0.5;
  for (const k of ["road", "cycle_path", "gravel"] as SurfaceKind[]) {
    surf += surfaces[k] * PREF_WEIGHT[q.surfaces[k]];
    if (q.surfaces[k] === "avoid" && surfaces[k] > 0.15) {
      surf *= 0.5;
      watch.push(`${pct(surfaces[k])} ${SURFACE_LABEL[k]}, which you'd rather avoid`);
    }
    if (q.surfaces[k] === "prefer" && surfaces[k] >= 0.4) why.push(`${pct(surfaces[k])} ${SURFACE_LABEL[k]}`);
  }
  parts.push([WEIGHTS.surfaces, Math.min(1, surf)]);

  // Themes: only when the rider picked some. Unknown sections are skipped, never scored as 0 (D37).
  const themeScores = Object.keys(first.themes)
    .map((id) => ({ id, score: weighted(secs, (s) => s.themes[id]?.score) }))
    .filter((t): t is { id: string; score: number } => t.score !== null)
    .sort((a, b) => b.score - a.score);
  if (q.themes.length) {
    const titles = Object.fromEntries(dream.themes.map((t) => [t.id, t.title]));
    const chosen = q.themes.map((id) => ({ id, score: weighted(secs, (s) => s.themes[id]?.score) }));
    const known = chosen.filter((t): t is { id: string; score: number } => t.score !== null);
    if (known.length) parts.push([WEIGHTS.themes, known.reduce((a, t) => a + t.score, 0) / known.length]);
    for (const t of known) if (t.score >= 0.5) why.push(`${titles[t.id] ?? t.id}: strong here`);
    for (const t of chosen) {
      const unknownM = secs.filter((s) => s.themes[t.id]?.score == null).reduce((a, s) => a + s.length_m, 0);
      if (unknownM > 0) check.add(`${titles[t.id] ?? t.id}: no data for ${Math.round(unknownM / 1000)} km of this stretch: judge it yourself.`);
    }
  }

  // Season: the chosen month, or this stretch's best one.
  const month = monthOf(secs, q.month);
  let comfort: number | null = null;
  let bestTime: number | null = null;
  if (month !== null) {
    comfort = weighted(secs, (s) => s.comfort[month]);
    bestTime = weighted(secs, (s) => s.best_time[month]);
    if (bestTime !== null) {
      parts.push([WEIGHTS.season, bestTime / 100]);
      const label = q.month === null ? `best in ${MONTH_NAMES[month]}` : MONTH_NAMES[month];
      why.push(`${label}: comfort ${comfort === null ? "unknown" : Math.round(comfort)}, best-time ${Math.round(bestTime)}`);
    } else {
      check.add(`No climate data for ${MONTH_NAMES[month]} on this stretch.`);
    }
    const missing = new Set(secs.flatMap((s) => s.partial[month] ?? []));
    for (const name of missing) check.add(`${MONTH_NAMES[month]} best-time leaves out ${name}: no data for part of this stretch.`);
    // Wind along the direction of travel.
    const along = weighted(secs, (s) => s.climate?.wind_along_ms[month]);
    if (along !== null) {
      const tail = way === "forward" ? along : -along;
      parts.push([WEIGHTS.wind, Math.min(1, Math.max(0, 0.5 + tail / 3))]);
      if (tail >= 1) why.push(`mostly tailwind this way (${tail.toFixed(1)} m/s on average)`);
      if (tail <= -1) watch.push(`mostly headwind this way (${(-tail).toFixed(1)} m/s on average)`);
    }
  }

  // Where to stay.
  if (q.stay !== "any") {
    const key = q.stay === "camping" ? ["campsite"] : ["hostel", "hotel"];
    const covered = secs.filter((s) => key.some((k) => (s.accommodation[k] ?? 0) > 0)).length / secs.length;
    parts.push([WEIGHTS.stay, covered]);
    if (covered < 1) watch.push(`${q.stay === "camping" ? "campsites" : "rooms"} on only ${pct(covered)} of its sections`);
  }

  // Watch-outs from the audit, and the gaps the rider has to check (D37).
  const busyKm = (busyShare * totalM) / 1000;
  if (busyKm >= 5) watch.push(`${Math.round(busyKm)} km on busy roads`);
  const worstGap = Math.max(...secs.map((s) => s.longest_gap_m.accommodation ?? 0));
  if (worstGap >= 50_000) watch.push(`up to ${km(worstGap)} km between places to stay`);
  const steep = Math.max(...secs.map((s) => s.max_grade_500m ?? 0));
  if (steep >= 8) watch.push(`steepest 500 m at ${steep.toFixed(0)}%`);
  for (const c of run.crossings) watch.push(c);
  if (!stationStart || !stationEnd) watch.push("no bike-carrying station found at one end");
  const findings = secs.reduce((a, s) => a + (s.findings.warning ?? 0), 0);
  if (findings) watch.push(`${findings} audit warning(s): details with a Trip Pass`);
  for (const s of secs) for (const c of s.check) check.add(c);

  const total = parts.reduce((a, [w]) => a + w, 0);
  const score = parts.reduce((a, [w, v]) => a + w * v, 0) / (total || 1);
  return {
    first: run.sections[0]!.number,
    last: run.sections[run.sections.length - 1]!.number,
    way,
    km: Math.round(totalM / 1000),
    days: q.days,
    kmPerDay: Math.round(kmPerDay),
    climbPerDay: climbPerDay === null ? null : Math.round(climbPerDay),
    climbMinPerDay: partly && climbKnown !== null ? Math.round(climbKnown) : null,
    climbUnknownKm: Math.round(climb.unknownM / 100) / 10,
    grade,
    gradeAtLeast: partly,
    month,
    comfort: comfort === null ? null : Math.round(comfort),
    bestTime: bestTime === null ? null : Math.round(bestTime),
    surfaces,
    busyShare,
    topThemes: themeScores.slice(0, 3),
    stationStart,
    stationEnd,
    crossings: run.crossings,
    score: Math.round(score * 1000) / 1000,
    why,
    watch,
    check: mergeChecks(check),
  };
}

const SEASON_GAP = /^(\d+) of (\d+) places to stay publish no opening season/;

/** De-duplicates "check yourself" items across sections, summing the per-section opening-season counts. */
export function mergeChecks(items: Iterable<string>): string[] {
  let unpublished = 0;
  let total = 0;
  const rest = new Set<string>();
  for (const item of items) {
    const m = SEASON_GAP.exec(item);
    if (m) {
      unpublished += Number(m[1]);
      total += Number(m[2]);
    } else {
      rest.add(item);
    }
  }
  const out = [...rest];
  if (total) out.unshift(`${unpublished} of ${total} places to stay publish no opening season: check dates ahead.`);
  return out;
}

function overlap(a: StretchResult, b: StretchResult): number {
  const lo = Math.max(a.first, b.first);
  const hi = Math.min(a.last, b.last);
  if (hi < lo) return 0;
  return (hi - lo + 1) / Math.min(a.last - a.first + 1, b.last - b.first + 1);
}

/** Ranked, non-overlapping stretches for the query (at most `limit`, default 10). */
export function findStretches(dream: DreamFile, q: DreamQuery): StretchResult[] {
  const level = dream.levels.find((l) => l.level === q.level);
  const maxKm = (level?.km_max ?? 130) * (1 + TOLERANCE) * q.days;
  const ways: Way[] = q.direction === "either" ? ["forward", "reverse"] : [q.direction];
  const candidates: StretchResult[] = [];
  for (const run of runs(dream, maxKm)) {
    for (const way of ways) {
      const r = evaluate(dream, run, way, q);
      if (r) candidates.push(r);
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const picked: StretchResult[] = [];
  for (const c of candidates) {
    if (picked.some((p) => overlap(p, c) > 0.5)) continue;
    picked.push(c);
    if (picked.length >= (q.limit ?? 10)) break;
  }
  return picked;
}
