import type { Event, MinorFile, MinorSection } from "@dpg/contracts";
import type { PathCollection, RideProps } from "./api";

export type LayerKey = "status" | "infrastructure" | "traffic_stress" | "surface" | "cycle_network" | "gradient" | "ecs";

export const LAYER_TITLES: Record<LayerKey, string> = {
  status: "EuroVelo status",
  infrastructure: "Infrastructure",
  traffic_stress: "Traffic stress",
  surface: "Surface",
  cycle_network: "Waymarked network (OSM)",
  gradient: "Gradient",
  ecs: "ECS-style check",
};

const UNMATCHED = "#212529";
const UNKNOWN = "#ced4da";

export const PALETTES: Record<Exclude<LayerKey, "status">, Record<string, string>> = {
  infrastructure: {
    cycleway: "#1a9850", shared_path: "#66bd63", separated_track: "#2171b5", cycle_lane: "#6baed6",
    quiet_road: "#e5c100", road: "#fd8d3c", busy_road: "#d7301f", steps: "#7b3294", ferry: "#3f51b5",
    unmatched: UNMATCHED, unknown: UNKNOWN,
  },
  traffic_stress: { "1": "#1a9850", "2": "#91cf60", "3": "#fd8d3c", "4": "#d7301f", na: "#3f51b5",
    unmatched: UNMATCHED, unknown: UNKNOWN },
  surface: { paved_smooth: "#1f78b4", paved_assumed: "#a6cee3", paved_rough: "#6a3d9a", compacted: "#fdbf6f",
    gravel: "#ff7f00", dirt: "#8c510a", na: "#3f51b5", unmatched: UNMATCHED, unknown: UNKNOWN },
  cycle_network: { eurovelo_route: "#1a9850", international: "#66bd63", national: "#2171b5", regional: "#6baed6",
    local: "#9ecae1", none: "#f46d43", unmatched: UNMATCHED },
  gradient: { flat: "#d9f0d3", gentle: "#a6dba0", moderate: "#fed976", steep: "#fd8d3c", very_steep: "#e31a1c",
    extreme: "#800026", unknown: UNKNOWN },
  ecs: { pass: "#1a9850", important_fail: "#fdae61", essential_fail: "#d7301f", unknown: UNKNOWN },
};

export const ECS_LABELS: Record<string, string> = {
  pass: "Meets all criteria",
  important_fail: "Fails an important criterion",
  essential_fail: "Fails an essential criterion",
  unknown: "Not enough data",
};

/** Combine one kilometre's criterion results into a single ECS-style verdict. */
export function ecsVerdict(section: MinorSection, tiers: Record<string, string>): string {
  const results = Object.entries(section.criteria);
  if (results.some(([id, r]) => tiers[id] === "essential" && r === "fail")) return "essential_fail";
  if (results.some(([id, r]) => tiers[id] === "important" && r === "fail")) return "important_fail";
  if (results.some(([, r]) => r === "unknown")) return "unknown";
  return "pass";
}

interface Ride {
  section: number;
  coords: [number, number][];
  m: number[];
}

/** Cuts the route geometry by path measure, using the engine's per-coordinate measures (exact, no re-measuring). */
export class Slicer {
  private rides: Ride[];

  constructor(path: PathCollection) {
    this.rides = path.features
      .filter((f) => f.properties.kind === "ride")
      .map((f) => ({ section: (f.properties as RideProps).section, coords: f.geometry.coordinates, m: (f.properties as RideProps).m }))
      .filter((r) => r.m && r.m.length === r.coords.length && r.m.length >= 2);
  }

  /** One coordinate run per ride that overlaps [m0, m1]. */
  slice(m0: number, m1: number): { section: number; coords: [number, number][] }[] {
    const out = [];
    for (const r of this.rides) {
      const first = r.m[0]!;
      const last = r.m[r.m.length - 1]!;
      if (last <= m0 || first >= m1) continue;
      const a = Math.max(m0, first);
      const b = Math.min(m1, last);
      out.push({ section: r.section, coords: cut(r, a, b) });
    }
    return out;
  }
}

function locate(r: Ride, m: number): [number, number] {
  let lo = 0;
  let hi = r.m.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (r.m[mid]! <= m) lo = mid;
    else hi = mid;
  }
  const m0 = r.m[lo]!;
  const m1 = r.m[hi]!;
  const t = m1 > m0 ? (m - m0) / (m1 - m0) : 0;
  const p0 = r.coords[lo]!;
  const p1 = r.coords[hi]!;
  return [p0[0] + t * (p1[0] - p0[0]), p0[1] + t * (p1[1] - p0[1])];
}

function cut(r: Ride, a: number, b: number): [number, number][] {
  const coords: [number, number][] = [locate(r, a)];
  for (let i = 0; i < r.m.length; i++) {
    if (r.m[i]! > a && r.m[i]! < b) coords.push(r.coords[i]!);
  }
  coords.push(locate(r, b));
  return coords;
}

export interface Stretch {
  from_m: number;
  to_m: number;
  value: string;
}

/** Stretches to colour for a layer: its events, or ECS verdicts per kilometre. */
export function stretchesFor(layer: LayerKey, events: Event[], minor: MinorFile | null): Stretch[] {
  if (layer === "status") return [];
  if (layer === "ecs") {
    if (!minor) return [];
    const tiers = Object.fromEntries(minor.criteria.map((c) => [c.id, c.tier]));
    return minor.sections.map((s) => ({ from_m: s.from_m, to_m: s.to_m, value: ecsVerdict(s, tiers) }));
  }
  return events.filter((e) => e.layer === layer);
}

export function overlayGeoJSON(layer: LayerKey, stretches: Stretch[], slicer: Slicer) {
  if (layer === "status") return null;
  const palette = PALETTES[layer];
  const features = [];
  for (const s of stretches) {
    for (const piece of slicer.slice(s.from_m, s.to_m)) {
      features.push({
        type: "Feature" as const,
        properties: { value: s.value, color: palette[s.value] ?? UNKNOWN, section: piece.section },
        geometry: { type: "LineString" as const, coordinates: piece.coords },
      });
    }
  }
  return { type: "FeatureCollection" as const, features };
}
