/**
 * Data for the rider view (11.6). The teaser reads only the free files (D45). With the Trip Pass, the places on the
 * stretch are fetched by 50 km block (D31), so the server learns at most which blocks were looked at.
 */
import type {
  BundleManifest,
  CalendarFile,
  DreamFile,
  EffortFile,
  FindingsFile,
  HighlightsFile,
  Place,
  ScoresFile,
  SectionsFile,
  ServicesFile,
  StopsFile,
} from "@dpg/contracts";
import type { FreeData, FullData, Geometry } from "@dpg/planner";
import type { PathCollection } from "../api";

export const BLOCK_M = 50_000;
/** Beds, water and food that count (D17), and stations within bail-out reach (10 km). */
const COUNTED_SERVICES = ["accommodation", "food", "water"];
const BAIL_OUT_M = 10_000;

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return (await res.json()) as T;
}

export interface RouteFiles {
  manifest: BundleManifest;
  free: FreeData;
  geometry: Geometry;
  sections: SectionsFile;
}

export function geometryOf(path: PathCollection): Geometry {
  const geo: Geometry = { lines: [], gaps: [] };
  for (const f of path.features) {
    const p = f.properties;
    if (p.kind === "ride") geo.lines.push({ coords: f.geometry.coordinates, m: p.m });
    else {
      const [a, b] = f.geometry.coordinates;
      if (a && b) geo.gaps.push({ atM: p.at_m, type: p.gap_type ?? "unclassified", km: p.straight_distance_m / 1000, start: a, end: b });
    }
  }
  geo.lines.sort((x, y) => (x.m[0] ?? 0) - (y.m[0] ?? 0));
  return geo;
}

export async function loadRoute(network: string, ref: string): Promise<RouteFiles> {
  const base = `/v1/routes/${network}/${ref.toLowerCase()}`;
  const manifest = await get<BundleManifest>(base);
  if (!("stops" in manifest.files) || !("effort" in manifest.files) || !("dream" in manifest.files)) {
    throw new Error("This route's audit predates Plan (M4): re-run its audit to plan it.");
  }
  const [dream, stops, effort, calendar, sections, path] = await Promise.all([
    get<DreamFile>(`${base}/dream`),
    get<StopsFile>(`${base}/stops`),
    get<EffortFile>(`${base}/effort`),
    "calendar" in manifest.files ? get<CalendarFile>(`${base}/calendar`) : Promise.resolve(null),
    get<SectionsFile>(`${base}/sections`),
    get<PathCollection>(`${base}/path`),
  ]);
  return {
    manifest,
    sections,
    geometry: geometryOf(path),
    free: {
      route: { network, ref: ref.toLowerCase(), runId: manifest.run_id, name: manifest.route.name },
      dream,
      stops,
      effort,
      calendar,
      daily: sections.daily,
    },
  };
}

export interface FullFiles {
  full: FullData;
  truncated: boolean;
}

/** The Trip Pass detail for a stretch. Places come by whole 50 km blocks around it (D31). */
export async function loadFull(network: string, ref: string, runId: string, fromM: number, toM: number): Promise<FullFiles> {
  const base = `/v1/routes/${network}/${ref.toLowerCase()}`;
  const lo = Math.floor(Math.min(fromM, toM) / BLOCK_M) * BLOCK_M;
  const hi = Math.ceil(Math.max(fromM, toM) / BLOCK_M) * BLOCK_M;
  const query = (extra: Record<string, string>) =>
    new URLSearchParams({ run: runId, from_km: String(lo / 1000), to_km: String(hi / 1000), limit: "20000", ...extra });
  const [findings, highlights, scores, services, counted, stations] = await Promise.all([
    get<FindingsFile>(`${base}/findings?run=${runId}`),
    get<HighlightsFile>(`${base}/highlights?run=${runId}`).catch(() => ({ highlights: [] })),
    get<ScoresFile>(`${base}/scores?run=${runId}`),
    get<ServicesFile>(`${base}/services?run=${runId}`),
    get<{ places: Place[]; truncated: boolean }>(`${base}/places?${query({ service: COUNTED_SERVICES.join(","), counting: "1" })}`),
    get<{ places: Place[]; truncated: boolean }>(`${base}/places?${query({ service: "station", max_detour_m: String(BAIL_OUT_M) })}`),
  ]);
  return {
    truncated: counted.truncated || stations.truncated,
    full: {
      findings: findings.findings,
      places: [...counted.places, ...stations.places],
      highlights: highlights.highlights,
      climbs: scores.climbs,
      serviceTypes: services.types,
    },
  };
}
