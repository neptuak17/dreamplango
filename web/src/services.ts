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

export const DEFAULT_SHOWN = ["water", "food", "accommodation", "bike_shop", "station"];

/** Strip rows for service gaps, and their palette (gap length relative to the finding threshold). */
export const GAP_ROWS: { key: string; title: string }[] = [
  { key: "water", title: "Water / food gaps" },
  { key: "food", title: "Food gaps" },
  { key: "accommodation", title: "Accommodation gaps" },
  { key: "bike_shop", title: "Bike shop gaps" },
  { key: "bail_out", title: "Bail-out gaps" },
];
export const GAP_PALETTE: Record<string, string> = { long: "#d7301f", near: "#fdae61" };
export const GAP_LABELS: Record<string, string> = {
  long: "Longer than the finding threshold",
  near: "Over half the threshold",
};

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
