/* Generated from schemas/bundle-v0.schema.json by `npm run contracts`. Do not edit. */

export type DevelopmentLevel =
  "certified" | "developed" | "partially_developed" | "undeveloped_unknown" | "unrecognised";
export type Signage = "signed" | "not_signed" | "unknown";
export type ComponentKind = "ride" | "gap";
export type GapType = "ferry" | "public_transport" | "discontinuity" | "missing" | "unclassified";
export type Severity = "info" | "caution" | "warning" | "blocker";

/**
 * Root type used only to export one JSON Schema containing every bundle file type.
 */
export interface BundleContract {
  manifest: BundleManifest;
  sections: SectionsFile;
  findings: FindingsFile;
  profile: ProfileFile;
  events: EventsFile;
  minor: MinorFile;
  scores: ScoresFile;
  places: PlacesFile;
  services: ServicesFile;
  current: CurrentPointer;
}
export interface BundleManifest {
  schema_version: string;
  run_id: string;
  created_at: string;
  pipeline: PipelineInfo;
  route: Route;
  sources: SourceSnapshot[];
  attribution: string[];
  /**
   * Logical name -> file name within the bundle directory
   */
  files: {
    [k: string]: string;
  };
  summary: RouteSummary;
  /**
   * Count per severity
   */
  finding_counts: {
    [k: string]: number;
  };
}
export interface PipelineInfo {
  name: string;
  version: string;
}
export interface Route {
  /**
   * Global route id, e.g. eurovelo:ev8
   */
  id: string;
  network: string;
  /**
   * Display reference, e.g. EV8
   */
  ref: string;
  name: string;
  official_url: string | null;
}
/**
 * One downloaded source file, with the provenance needed for attribution and reproducibility.
 */
export interface SourceSnapshot {
  /**
   * Source identifier, e.g. eurovelo-gpx
   */
  id: string;
  title: string;
  url: string;
  retrieved_at: string;
  /**
   * Path relative to the data directory
   */
  file: string;
  sha256: string;
  bytes: number;
  licence: Licence;
  attribution: string;
}
export interface Licence {
  /**
   * SPDX-style identifier, e.g. ODbL-1.0
   */
  id: string;
  name: string;
  url: string;
}
export interface RouteSummary {
  ride_length_m: number;
  daily_section_count: number;
  gap_count: number;
  gap_straight_distance_m: number;
  status_breakdown: StatusShare[];
}
export interface StatusShare {
  development: DevelopmentLevel;
  signage: Signage;
  length_m: number;
  /**
   * Fraction of ridden length, 0-1
   */
  share: number;
}
export interface SectionsFile {
  daily: DailySection[];
  status: StatusSection[];
  components: Component[];
  /**
   * Fixed 50 km live-data blocks as [from_m, to_m]
   */
  blocks: [number, number][];
  /**
   * Fixed 1 km ECS minor sections as [from_m, to_m]
   */
  minor: [number, number][];
}
export interface DailySection {
  id: string;
  number: number;
  title: string;
  start_name: string | null;
  end_name: string | null;
  from_m: number;
  to_m: number;
  length_m: number;
  status: EuroVeloStatus;
  /**
   * Track was stored end-to-start in the source GPX
   */
  reversed_in_source: boolean;
  point_count: number;
  /**
   * @minItems 2
   * @maxItems 2
   */
  start: [number, number];
  /**
   * @minItems 2
   * @maxItems 2
   */
  end: [number, number];
}
export interface EuroVeloStatus {
  development: DevelopmentLevel;
  signage: Signage;
  /**
   * Status label exactly as published, e.g. 'Developed + Signed'
   */
  label: string;
}
/**
 * A run of consecutive daily sections sharing the same published status.
 */
export interface StatusSection {
  id: string;
  from_m: number;
  to_m: number;
  length_m: number;
  status: EuroVeloStatus;
  daily_sections: number[];
}
/**
 * A continuous piece of a path. Gaps join two ride components and have zero measured length.
 */
export interface Component {
  id: string;
  seq: number;
  kind: ComponentKind;
  from_m: number;
  to_m: number;
  length_m: number;
  /**
   * For gaps: straight-line distance between the two ride ends
   */
  straight_distance_m: number | null;
  /**
   * Source daily section number (rides)
   */
  daily_section: number | null;
  /**
   * @minItems 2
   * @maxItems 2
   */
  start: [number, number];
  /**
   * @minItems 2
   * @maxItems 2
   */
  end: [number, number];
  /**
   * For gaps: how the break is crossed
   */
  gap_type: GapType | null;
  /**
   * For gaps: what the classification rests on
   */
  gap_basis: string | null;
  gap_confidence: ("high" | "medium" | "low") | null;
}
export interface FindingsFile {
  findings: Finding[];
}
export interface Finding {
  id: string;
  rule_id: string;
  category: "data_quality" | "route";
  severity: Severity;
  from_m: number;
  to_m: number;
  /**
   * Representative location for map display
   */
  position: [number, number] | null;
  title: string;
  detail: string;
  evidence: {
    [k: string]: unknown;
  };
  confidence: "high" | "medium" | "low";
}
/**
 * Elevation sampled along the path every `step_m`.
 *
 * `ele` is the audit's best estimate (smoothed DEM, bridges and tunnels interpolated) when a DEM was used,
 * otherwise the source GPX elevation. `gpx_ele` always holds the source GPX elevation for comparison.
 */
export interface ProfileFile {
  step_m: number;
  source: string;
  m: number[];
  ele: (number | null)[];
  gpx_ele: (number | null)[];
}
export interface EventsFile {
  layers: LayerInfo[];
  events: Event[];
}
/**
 * A family of events along the route (e.g. surface), with its allowed categorical values.
 */
export interface LayerInfo {
  id: string;
  title: string;
  description: string;
  source: string;
  values: LayerValue[];
}
export interface LayerValue {
  id: string;
  label: string;
}
/**
 * One layer value over a stretch of the route (measures in metres on the path axis).
 */
export interface Event {
  layer: string;
  from_m: number;
  to_m: number;
  value: string;
  confidence: "high" | "medium" | "low";
  detail: {
    [k: string]: unknown;
  };
}
export interface MinorFile {
  size_m: number;
  criteria: Criterion[];
  sections: MinorSection[];
}
export interface Criterion {
  id: string;
  title: string;
  tier: "essential" | "important";
  description: string;
}
/**
 * One ECS minor section (1 km): dominant layer values and indicative criterion results.
 */
export interface MinorSection {
  index: number;
  from_m: number;
  to_m: number;
  /**
   * Layer id -> value covering most of this kilometre
   */
  values: {
    [k: string]: string;
  };
  criteria: {
    [k: string]: "pass" | "fail" | "unknown";
  };
}
export interface ScoresFile {
  rules_profile: string;
  criteria: Criterion[];
  route: StretchStats;
  sections: SectionScores[];
  climbs: Climb[];
}
/**
 * Summary statistics over a stretch of route: the whole route, or one daily section.
 */
export interface StretchStats {
  from_m: number;
  to_m: number;
  ascent_m: number | null;
  descent_m: number | null;
  /**
   * Steepest 500 m average gradient (%) in travel direction
   */
  max_grade_500m: number | null;
  /**
   * Layer id -> value -> share of length (0-1)
   */
  shares: {
    [k: string]: {
      [k: string]: number;
    };
  };
  criteria: {
    [k: string]: CriterionShare;
  };
  /**
   * Share of length meeting all essential criteria
   */
  essential_pass: number;
  /**
   * Share of length meeting all important criteria
   */
  important_pass: number;
}
export interface CriterionShare {
  passed: number;
  failed: number;
  unknown: number;
}
export interface SectionScores {
  from_m: number;
  to_m: number;
  ascent_m: number | null;
  descent_m: number | null;
  /**
   * Steepest 500 m average gradient (%) in travel direction
   */
  max_grade_500m: number | null;
  /**
   * Layer id -> value -> share of length (0-1)
   */
  shares: {
    [k: string]: {
      [k: string]: number;
    };
  };
  criteria: {
    [k: string]: CriterionShare;
  };
  /**
   * Share of length meeting all essential criteria
   */
  essential_pass: number;
  /**
   * Share of length meeting all important criteria
   */
  important_pass: number;
  number: number;
}
export interface Climb {
  from_m: number;
  to_m: number;
  length_m: number;
  gain_m: number;
  avg_grade: number;
  max_grade_500m: number;
  /**
   * Elevation at the top
   */
  top_m: number;
  /**
   * FIETS climb difficulty index
   */
  fiets: number;
  direction: "forward" | "reverse";
}
export interface PlacesFile {
  season_year: number;
  places: Place[];
}
/**
 * A service near the route (conflated from OSM and Overture), located on the route's measure axis.
 *
 * `months` holds one letter per month of the season year (D18): o = open, p = partly (the season starts or ends
 * that month), c = closed, ? = unknown.
 */
export interface Place {
  id: string;
  service: string;
  /**
   * Subtype, e.g. campsite, hotel, supermarket, cafe
   */
  kind: string;
  name: string | null;
  lon: number;
  lat: number;
  /**
   * Measure of the closest route point
   */
  at_m: number;
  /**
   * Straight-line distance from the route
   */
  offset_m: number;
  side: "left" | "right" | "on";
  /**
   * Ridden one-way distance from the route; null if no route found
   */
  access_m: number | null;
  /**
   * Minutes at touring pace including climbing (D17)
   */
  access_min: number | null;
  /**
   * Net climb from the access point to the place
   */
  climb_m: number | null;
  /**
   * Measure where the rider leaves the route for this place
   */
  access_at_m: number;
  /**
   * Within the service type's counting limits
   */
  counts: boolean;
  on_route: boolean;
  /**
   * 12 letters, January first: o open, p partly, c closed, ? unknown
   */
  months: string;
  opening_hours: string | null;
  /**
   * ISO 3166-1 alpha-2
   */
  country: string | null;
  /**
   * Source record ids, e.g. osm:n123, overture:<id>
   */
  sources: string[];
  confidence: "high" | "medium" | "low";
  detail: {
    [k: string]: unknown;
  };
}
export interface ServicesFile {
  rules_profile: string;
  season_year: number;
  types: ServiceType[];
  /**
   * Service id -> longest gap per month
   */
  route_longest_gap_m: {
    [k: string]: number[];
  };
  sections: SectionServices[];
  gaps: ServiceGap[];
  /**
   * Service id -> share of counted places whose opening season is published (any month known)
   */
  season_known: {
    [k: string]: number;
  };
}
/**
 * A kind of service along the route, with the access limits that decide whether a place counts (D17).
 */
export interface ServiceType {
  id: string;
  title: string;
  /**
   * Ridden one-way distance within which a place counts
   */
  count_m: number;
  /**
   * Time cap (flat speed plus climbing) for counting; null = none
   */
  count_min: number | null;
  /**
   * Places up to this ridden distance are kept for display
   */
  show_m: number;
  costing: "bicycle" | "auto";
  /**
   * A stretch this long without the service gives a finding
   */
  gap_m: number | null;
  /**
   * Other services that also fill this one's gaps (shops sell water)
   */
  gap_also: string[];
}
export interface SectionServices {
  number: number;
  /**
   * Service id -> places that count on this daily section
   */
  counts: {
    [k: string]: number;
  };
  /**
   * Service id -> longest stretch inside the section without the service, per month (Jan-Dec)
   */
  longest_gap_m: {
    [k: string]: number[];
  };
  /**
   * Service id -> share of counted places with unknown months
   */
  unknown_hours: {
    [k: string]: number;
  };
}
/**
 * A stretch without a service, at least half as long as the stretch that triggers a finding.
 */
export interface ServiceGap {
  /**
   * Service id, or bail_out for stations that carry bikes within bail-out reach
   */
  service: string;
  /**
   * 0-11: counting places not known closed that month; null: any month
   */
  month: number | null;
  from_m: number;
  to_m: number;
  /**
   * Gap length that triggers a finding for this service
   */
  threshold_m: number;
}
export interface CurrentPointer {
  run_id: string;
  updated_at: string;
}
