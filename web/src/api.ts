import type {
  BundleManifest,
  DevelopmentLevel,
  DreamFile,
  EventsFile,
  FindingsFile,
  GapType,
  MinorFile,
  Place,
  ProfileFile,
  Route,
  RouteSummary,
  ScoresFile,
  SectionsFile,
  ServicesFile,
  Signage,
  UserPlace,
  UserPlacesFile,
} from "@dpg/contracts";

export interface RouteListing {
  route: Route;
  run_id: string;
  created_at: string;
  summary: RouteSummary;
  finding_counts: Record<string, number>;
}

export interface RideProps {
  kind: "ride";
  component: string;
  section: number;
  title: string;
  from_m: number;
  to_m: number;
  development: DevelopmentLevel;
  signage: Signage;
  status: string;
  /** Path measure (m) of every coordinate. */
  m: number[];
}

export interface GapProps {
  kind: "gap";
  component: string;
  at_m: number;
  straight_distance_m: number;
  gap_type: GapType | null;
}

export interface PathFeature {
  type: "Feature";
  properties: RideProps | GapProps;
  geometry: { type: "LineString"; coordinates: [number, number][] };
}

export interface PathCollection {
  type: "FeatureCollection";
  features: PathFeature[];
}

export interface RouteBundle {
  manifest: BundleManifest;
  path: PathCollection;
  sections: SectionsFile;
  findings: FindingsFile;
  profile: ProfileFile;
  /** Audit layers; absent in geometry-only bundles. */
  events: EventsFile | null;
  minor: MinorFile | null;
  scores: ScoresFile | null;
  /** Services summary (M2); absent in older bundles. */
  services: ServicesFile | null;
  /** Dream data (M3); absent in older bundles. */
  dream: DreamFile | null;
  /** Waypoints from a rider's own file (D24): private, shown, never counted. */
  userPlaces: UserPlace[];
}

export interface PlacesResponse {
  season_year: number;
  total: number;
  truncated: boolean;
  places: Place[];
}

export interface PlaceFilter {
  fromM: number;
  toM: number;
  services: string[];
  /** 0-11, or null for any month. */
  month: number | null;
  /** "counting" keeps only places within the service type's access limits; a number is a max detour in metres. */
  detour: "counting" | number;
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return (await res.json()) as T;
}

async function getOptional<T>(url: string): Promise<T | null> {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return (await res.json()) as T;
}

export const listRoutes = () => get<{ routes: RouteListing[] }>("/v1/routes").then((r) => r.routes);

/** One route's manifest, or null when it doesn't exist (e.g. a private route that was forgotten). */
export const loadManifest = (network: string, ref: string) =>
  getOptional<BundleManifest>(`/v1/routes/${network}/${ref.toLowerCase()}`);

export const listingOf = (m: BundleManifest): RouteListing => ({
  route: m.route,
  run_id: m.run_id,
  created_at: m.created_at,
  summary: m.summary,
  finding_counts: m.finding_counts,
});

export async function loadBundle(network: string, ref: string): Promise<RouteBundle> {
  const base = `/v1/routes/${network}/${ref.toLowerCase()}`;
  const manifest = await get<BundleManifest>(base);
  // Only the files this bundle has: optional ones (newer milestones, user places) are listed in its manifest.
  const optional = <T>(file: string) => (file in manifest.files ? getOptional<T>(`${base}/${file}`) : Promise.resolve(null));
  const [path, sections, findings, profile, events, minor, scores, services, dream, user] = await Promise.all([
    get<PathCollection>(`${base}/path`),
    get<SectionsFile>(`${base}/sections`),
    get<FindingsFile>(`${base}/findings`),
    get<ProfileFile>(`${base}/profile`),
    optional<EventsFile>("events"),
    optional<MinorFile>("minor"),
    optional<ScoresFile>("scores"),
    optional<ServicesFile>("services"),
    optional<DreamFile>("dream"),
    optional<UserPlacesFile>("user_places"),
  ]);
  const userPlaces = user?.places ?? [];
  return { manifest, path, sections, findings, profile, events, minor, scores, services, dream, userPlaces };
}

export async function loadPlaces(
  network: string,
  ref: string,
  runId: string,
  filter: PlaceFilter,
  signal?: AbortSignal,
): Promise<PlacesResponse> {
  const q = new URLSearchParams({
    run: runId,
    from_km: String(Math.max(0, filter.fromM) / 1000),
    to_km: String(filter.toM / 1000),
    service: filter.services.join(","),
    limit: "5000",
  });
  if (filter.month !== null) q.set("month", String(filter.month + 1));
  if (filter.detour === "counting") q.set("counting", "1");
  else q.set("max_detour_m", String(filter.detour));
  const url = `/v1/routes/${network}/${ref.toLowerCase()}/places?${q}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return (await res.json()) as PlacesResponse;
}
