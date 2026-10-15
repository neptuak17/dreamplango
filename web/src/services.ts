import type { Place, ServiceGap, ServicesFile } from "@dpg/contracts";
import type { Stretch } from "./layers";

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Display order, colour and a short label per service type. */
export const SERVICE_STYLE: Record<string, { color: string; short: string }> = {
  water: { color: "#1c7ed6", short: "water" },
  food: { color: "#e8590c", short: "food" },
  toilets: { color: "#868e96", short: "WC" },
  accommodation: { color: "#7048e8", short: "beds" },
  bike_shop: { color: "#2b8a3e", short: "bike shop" },
  repair_station: { color: "#69db7c", short: "repair stn" },
  station: { color: "#c2255c", short: "station" },
  pharmacy: { color: "#0ca678", short: "pharmacy" },
  atm: { color: "#f59f00", short: "ATM" },
  hospital: { color: "#e03131", short: "hospital" },
};

/** Map filters: a whole service, or a sub-type of food or accommodation (riders rarely want every bar). */
export interface MapFilter {
  key: string;
  service: string;
  title: string;
  kinds?: string[];
}

export const MAP_FILTERS: MapFilter[] = [
  { key: "water", service: "water", title: "water" },
  { key: "food:groceries", service: "food", title: "groceries", kinds: ["supermarket", "convenience", "bakery", "grocery"] },
  { key: "food:eat", service: "food", title: "eat & drink", kinds: ["restaurant", "cafe", "fast_food", "bar"] },
  { key: "accommodation:campsite", service: "accommodation", title: "campsites", kinds: ["campsite"] },
  { key: "accommodation:hostel", service: "accommodation", title: "hostels, huts", kinds: ["hostel", "hut"] },
  { key: "accommodation:hotel", service: "accommodation", title: "hotels, B&Bs", kinds: ["hotel", "guest_house", "other"] },
  { key: "bike_shop", service: "bike_shop", title: "bike shops" },
  { key: "repair_station", service: "repair_station", title: "repair stations" },
  { key: "station", service: "station", title: "stations" },
  { key: "toilets", service: "toilets", title: "toilets" },
  { key: "pharmacy", service: "pharmacy", title: "pharmacies" },
  { key: "atm", service: "atm", title: "ATMs" },
  { key: "hospital", service: "hospital", title: "hospitals" },
];

export const DEFAULT_FILTERS = [
  "water",
  "food:groceries",
  "accommodation:campsite",
  "accommodation:hostel",
  "accommodation:hotel",
  "bike_shop",
  "station",
];

export function filterKey(p: Place): string {
  const own = MAP_FILTERS.filter((f) => f.service === p.service);
  return (own.find((f) => !f.kinds || f.kinds.includes(p.kind)) ?? own[0])?.key ?? p.service;
}

/** How many places to draw: the best one per stretch of route and filter, or all of them. */
export type Density = "auto" | "1km" | "5km" | "all";
export const DENSITY_LABELS: Record<Density, string> = {
  auto: "best per km (by zoom)",
  "1km": "best per km",
  "5km": "best per 5 km",
  all: "all",
};

/** Spacing in metres for thinning, or null for all places. "auto" shows everything once zoomed in to street level. */
export function spacingFor(density: Density, zoom: number): number | null {
  if (density === "all") return null;
  if (density === "1km") return 1000;
  if (density === "5km") return 5000;
  // A daily section fills the map at about zoom 9-11; street level starts around 14.
  return zoom >= 13.5 ? null : zoom >= 9 ? 1000 : 5000;
}

const CONFIDENCE_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** Is a a better representative than b: counts, shorter detour, more confident, season known. */
function better(a: Place, b: Place): boolean {
  if (a.counts !== b.counts) return a.counts;
  const da = a.access_m ?? Number.POSITIVE_INFINITY;
  const db = b.access_m ?? Number.POSITIVE_INFINITY;
  if (Math.abs(da - db) > 50) return da < db;
  const ca = CONFIDENCE_RANK[a.confidence] ?? 3;
  const cb = CONFIDENCE_RANK[b.confidence] ?? 3;
  if (ca !== cb) return ca < cb;
  return a.months !== "????????????" && b.months === "????????????";
}

/** Keep the best place per filter and per `spacing` metres of route (by access point). */
export function thin(places: Place[], spacing: number | null): Place[] {
  if (spacing === null) return places;
  const best = new Map<string, Place>();
  for (const p of places) {
    const key = `${filterKey(p)}|${Math.floor(p.access_at_m / spacing)}`;
    const current = best.get(key);
    if (!current || better(p, current)) best.set(key, p);
  }
  return [...best.values()];
}

/** Strip rows for service gaps, and their palette (gap length relative to the finding threshold). */
export const GAP_ROWS: { key: string; title: string }[] = [
  { key: "water", title: "Water / food gaps" },
  { key: "food", title: "Food gaps" },
  { key: "accommodation", title: "Accommodation gaps" },
  { key: "bike_shop", title: "Bike shop gaps" },
  { key: "bail_out", title: "Bail-out gaps" },
];
export const GAP_PALETTE: Record<string, string> = { long: "#d7301f", near: "#fdae61" };
export const GAP_LABELS = {
  long: "Longer than the finding threshold",
  near: "Over half the threshold",
} as const;

export function gapStretches(services: ServicesFile | null, service: string, month: number | null): Stretch[] {
  if (!services) return [];
  const wanted = service === "bail_out" ? null : month;
  return services.gaps
    .filter((g: ServiceGap) => g.service === service && g.month === wanted)
    .map((g) => ({ from_m: g.from_m, to_m: g.to_m, value: g.to_m - g.from_m >= g.threshold_m ? "long" : "near" }));
}

/** "partly": the season starts or ends during the month. */
export type MonthState = "open" | "partly" | "closed" | "unknown";

export function monthState(p: Place, month: number | null): MonthState {
  if (month === null) {
    if (p.months === "cccccccccccc") return "closed";
    return /[op]/.test(p.months) ? "open" : "unknown";
  }
  const c = p.months[month];
  return c === "o" ? "open" : c === "p" ? "partly" : c === "c" ? "closed" : "unknown";
}

/** "Apr–Oct" style summary of the months a place is open (at least partly); null when nothing is known. */
export function seasonLabel(months: string): string | null {
  if (!/[opc]/.test(months)) return null;
  if (!months.includes("c")) return months.includes("?") ? "open in some months, others unknown" : "open all year";
  const open = [...months].map((c, i) => (c === "o" || c === "p" ? i : -1)).filter((i) => i >= 0);
  if (open.length === 0) return "closed";
  const runs: number[][] = [];
  for (const i of open) {
    const last = runs[runs.length - 1];
    if (last && i === last[last.length - 1]! + 1) last.push(i);
    else runs.push([i]);
  }
  if (runs.length > 1 && runs[0]![0] === 0 && runs[runs.length - 1]!.at(-1) === 11) runs[0] = [...runs.pop()!, ...runs[0]!];
  return runs.map((r) => (r.length === 1 ? MONTHS[r[0]!] : `${MONTHS[r[0]!]}–${MONTHS[r.at(-1)!]}`)).join(", ");
}

export function distanceLabel(m: number | null): string {
  if (m === null) return "no route";
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

/** Next places of each service type ahead of `fromM`, nearest first. */
export function aheadByService(places: Place[], fromM: number, perService: number): Map<string, Place[]> {
  const out = new Map<string, Place[]>();
  for (const p of places) {
    if (p.access_at_m < fromM) continue;
    const list = out.get(p.service) ?? [];
    if (list.length < perService) list.push(p);
    out.set(p.service, list);
  }
  return out;
}
