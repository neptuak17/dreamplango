import type {
  BundleManifest,
  DevelopmentLevel,
  EventsFile,
  FindingsFile,
  GapType,
  MinorFile,
  ProfileFile,
  Route,
  RouteSummary,
  ScoresFile,
  SectionsFile,
  Signage,
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

export async function loadBundle(network: string, ref: string): Promise<RouteBundle> {
  const base = `/v1/routes/${network}/${ref.toLowerCase()}`;
  const [manifest, path, sections, findings, profile, events, minor, scores] = await Promise.all([
    get<BundleManifest>(base),
    get<PathCollection>(`${base}/path`),
    get<SectionsFile>(`${base}/sections`),
    get<FindingsFile>(`${base}/findings`),
    get<ProfileFile>(`${base}/profile`),
    getOptional<EventsFile>(`${base}/events`),
    getOptional<MinorFile>(`${base}/minor`),
    getOptional<ScoresFile>(`${base}/scores`),
  ]);
  return { manifest, path, sections, findings, profile, events, minor, scores };
}
