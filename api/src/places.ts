/**
 * Places near a route (D19): the bundle's places file is parsed once and filtered per request, so clients only
 * download the stretch and services they show.
 */
import type { Place, PlacesFile } from "@dpg/contracts";

export interface PlaceQuery {
  services: Set<string> | null;
  fromM: number;
  toM: number;
  /** Max ridden one-way distance from the route; unreachable places are excluded when set. */
  maxDetourM: number | null;
  /** Only places that count under the service type's access limits. */
  counting: boolean;
  /** 0-11: drop places known to be closed in this month (unknown stays in). */
  month: number | null;
  limit: number;
}

export const MAX_LIMIT = 20_000;
const SERVICE = /^[a-z_]{1,32}$/;

/** Parse query parameters; returns an error message for invalid input. */
export function parsePlaceQuery(q: (name: string) => string | undefined): PlaceQuery | string {
  const num = (name: string): number | null | string => {
    const raw = q(name);
    if (raw === undefined || raw === "") return null;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? v : `invalid ${name}`;
  };
  const fromKm = num("from_km");
  const toKm = num("to_km");
  const detour = num("max_detour_m");
  const month = num("month");
  const limit = num("limit");
  for (const v of [fromKm, toKm, detour, month, limit]) if (typeof v === "string") return v;
  if (month !== null && (!Number.isInteger(month) || (month as number) < 1 || (month as number) > 12)) {
    return "invalid month (1-12)";
  }
  const servicesRaw = q("service");
  let services: Set<string> | null = null;
  if (servicesRaw) {
    const list = servicesRaw.split(",").filter(Boolean);
    if (!list.every((s) => SERVICE.test(s))) return "invalid service";
    services = new Set(list);
  }
  return {
    services,
    fromM: ((fromKm as number | null) ?? 0) * 1000,
    toM: toKm === null ? Number.POSITIVE_INFINITY : (toKm as number) * 1000,
    maxDetourM: detour as number | null,
    counting: q("counting") === "1" || q("counting") === "true",
    month: month === null ? null : (month as number) - 1,
    limit: Math.min(Math.max(1, Math.floor((limit as number | null) ?? 2000)), MAX_LIMIT),
  };
}

/** Places sorted by access point (as in the bundle), so a range is a binary search plus a scan. */
function firstAtOrAfter(places: Place[], m: number): number {
  let lo = 0;
  let hi = places.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (places[mid]!.access_at_m < m) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function filterPlaces(file: PlacesFile, query: PlaceQuery) {
  const out: Place[] = [];
  let total = 0;
  for (let i = firstAtOrAfter(file.places, query.fromM); i < file.places.length; i++) {
    const p = file.places[i]!;
    if (p.access_at_m > query.toM) break;
    if (query.services && !query.services.has(p.service)) continue;
    if (query.counting && !p.counts) continue;
    if (query.maxDetourM !== null && (p.access_m === null || p.access_m > query.maxDetourM)) continue;
    if (query.month !== null && p.months[query.month] === "c") continue;
    total++;
    if (out.length < query.limit) out.push(p);
  }
  return { season_year: file.season_year, total, truncated: total > out.length, places: out };
}

/** A tiny cache of parsed places files (they are large); keyed by route and run. */
export class PlacesCache {
  private readonly entries = new Map<string, Promise<PlacesFile | null>>();

  constructor(private readonly capacity = 2) {}

  get(key: string, load: () => Promise<string | null>): Promise<PlacesFile | null> {
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    const pending = load().then((text) => (text === null ? null : (JSON.parse(text) as PlacesFile)));
    pending.catch(() => this.entries.delete(key));
    this.entries.set(key, pending);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
    return pending;
  }
}
