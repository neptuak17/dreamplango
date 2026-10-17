/**
 * The riding-time model (DESIGN.md 11.6, 12): rider, bike and luggage mass, a sustained power, rolling resistance by
 * surface, gradient and the typical wind along the route, solved per 100 m step.
 *
 * Pace comes from the rider's self-chosen level (D36) and bike, never from fitness data (D35, D48). Each level has a
 * flat cruising speed with luggage on a touring bike; the power that gives it is the rider's power on any bike. The
 * presets are placeholders to tune, like D13.
 */
import type { Bike, StopStyle } from "./types";

const G = 9.81;
const RHO = 1.2;
const DRIVETRAIN = 0.97;
const RIDER_KG = 75;
const LUGGAGE_KG = 12;
const WALK_MS = 1.1;
/** Below this speed the rider walks and pushes. */
const WALK_BELOW_MS = 1.4;
const EBIKE_LIMIT_MS = 25 / 3.6;

/** Flat cruising speed with luggage on a touring bike, per level (km/h). */
export const LEVEL_FLAT_KMH: Record<number, number> = { 1: 13, 2: 15, 3: 17, 4: 19, 5: 21 };

export interface BikeSpec {
  kg: number;
  crrPaved: number;
  crrGravel: number;
  cda: number;
  /** Speed held on descents (km/h), paved and gravel. */
  downPavedKmh: number;
  downGravelKmh: number;
  /** Motor assistance up to 25 km/h (EU pedelecs), watts. */
  assistW: number;
}

export const BIKES: Record<Bike, BikeSpec> = {
  road: { kg: 9, crrPaved: 0.005, crrGravel: 0.016, cda: 0.45, downPavedKmh: 45, downGravelKmh: 22, assistW: 0 },
  touring: { kg: 16, crrPaved: 0.007, crrGravel: 0.012, cda: 0.55, downPavedKmh: 40, downGravelKmh: 25, assistW: 0 },
  gravel: { kg: 11, crrPaved: 0.006, crrGravel: 0.01, cda: 0.5, downPavedKmh: 42, downGravelKmh: 28, assistW: 0 },
  ebike: { kg: 25, crrPaved: 0.008, crrGravel: 0.012, cda: 0.55, downPavedKmh: 40, downGravelKmh: 25, assistW: 250 },
};

export interface Rider {
  level: number;
  bike: Bike;
  spec: BikeSpec;
  massKg: number;
  powerW: number;
}

function resistance(massKg: number, crr: number, cda: number, grade: number, v: number, tailwind: number): number {
  const theta = Math.atan(grade);
  const air = v - tailwind;
  return massKg * G * (crr * Math.cos(theta) + Math.sin(theta)) + 0.5 * RHO * cda * air * Math.abs(air);
}

/** Speed (m/s) at which `power` (at the wheel, after drivetrain losses) balances the resistance. */
function solve(power: number, massKg: number, crr: number, cda: number, grade: number, tailwind: number, vmax: number) {
  const net = (v: number) => power * DRIVETRAIN - resistance(massKg, crr, cda, grade, v, tailwind) * v;
  if (net(vmax) >= 0) return vmax;
  let lo = 0.05;
  let hi = vmax;
  if (net(lo) < 0) return lo;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (net(mid) >= 0) lo = mid;
    else hi = mid;
  }
  return lo;
}

export function riderFor(level: number, bike: Bike): Rider {
  const touring = BIKES.touring;
  const flat = (LEVEL_FLAT_KMH[level] ?? LEVEL_FLAT_KMH[3]!) / 3.6;
  const massTouring = RIDER_KG + touring.kg + LUGGAGE_KG;
  const powerW = (resistance(massTouring, touring.crrPaved, touring.cda, 0, flat, 0) * flat) / DRIVETRAIN;
  const spec = BIKES[bike];
  return { level, bike, spec, massKg: RIDER_KG + spec.kg + LUGGAGE_KG, powerW };
}

/** Speed (m/s) on a gradient (rise/run), surface "paved" or "gravel", with the along-route wind (+ tailwind). */
export function speed(rider: Rider, grade: number, surface: "paved" | "gravel", tailwind = 0): number {
  const { spec, massKg } = rider;
  const crr = surface === "paved" ? spec.crrPaved : spec.crrGravel;
  const vmax = (surface === "paved" ? spec.downPavedKmh : spec.downGravelKmh) / 3.6;
  // Riders push harder uphill: up to 30% more on steep climbs.
  const power = rider.powerW * (1 + Math.min(0.3, Math.max(0, grade) * 4));
  let v: number;
  if (spec.assistW > 0) {
    const assisted = solve(power + Math.min(spec.assistW, 1.5 * power), massKg, crr, spec.cda, grade, tailwind, vmax);
    if (assisted <= EBIKE_LIMIT_MS) v = assisted;
    else v = Math.max(solve(power, massKg, crr, spec.cda, grade, tailwind, vmax), Math.min(EBIKE_LIMIT_MS, vmax));
  } else {
    v = solve(power, massKg, crr, spec.cda, grade, tailwind, vmax);
  }
  return v < WALK_BELOW_MS ? WALK_MS : v;
}

/**
 * Seconds for one step. A known surface gives one time; an unknown one is timed as paved (fast) and as gravel (slow)
 * (D37: a range, never a guess). `rise` null means unknown terrain: timed flat, which is a minimum.
 */
export function stepSeconds(
  rider: Rider,
  lengthM: number,
  rise: number | null,
  surface: string,
  tailwind: number,
): { fast: number; slow: number } {
  if (lengthM <= 0) return { fast: 0, slow: 0 };
  const grade = rise === null ? 0 : rise / lengthM;
  if (surface === "g") {
    const t = lengthM / speed(rider, grade, "gravel", tailwind);
    return { fast: t, slow: t };
  }
  const paved = lengthM / speed(rider, grade, "paved", tailwind);
  if (surface === "u") return { fast: paved, slow: lengthM / speed(rider, grade, "gravel", tailwind) };
  return { fast: paved, slow: paved };
}


const STOP_SHARE: Record<StopStyle, number> = { short: 0.15, normal: 0.25, long: 0.4 };
const LUNCH_MIN = 45;

/** Minutes of stops for a day's riding minutes: a share of riding time, plus lunch on days of 3 hours or more. */
export function stopMinutes(ridingMin: number, style: StopStyle): number {
  return ridingMin * STOP_SHARE[style] + (ridingMin >= 180 ? LUNCH_MIN : 0);
}

/**
 * Hours of riding for the middle of the rider's level band (D36): km in the middle of the band, with 60% of the
 * band's climbing, half of the day up and half down. This is the rider's "usual day", which the planner aims for.
 */
export function usualDay(rider: Rider, kmMin: number, kmMax: number, climbMaxM: number) {
  const km = (kmMin + kmMax) / 2;
  const climb = climbMaxM * 0.6;
  const half = (km * 1000) / 2;
  const grade = climb / half;
  const seconds = half / speed(rider, grade, "paved") + half / speed(rider, -grade, "paved");
  return { km, climbM: climb, hours: seconds / 3600 };
}
