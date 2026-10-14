/* Generated from schemas/bundle-v0.schema.json by `npm run contracts`. Do not edit. */

export type DevelopmentLevel =
  "certified" | "developed" | "partially_developed" | "undeveloped_unknown" | "unrecognised";
export type Signage = "signed" | "not_signed" | "unknown";
export type ComponentKind = "ride" | "gap";
export type Severity = "info" | "caution" | "warning" | "blocker";

/**
 * Root type used only to export one JSON Schema containing every bundle file type.
 */
export interface BundleContract {
  manifest: BundleManifest;
  sections: SectionsFile;
  findings: FindingsFile;
  profile: ProfileFile;
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
 * Elevation sampled along the path. Values come from the source GPX and are unverified.
 */
export interface ProfileFile {
  step_m: number;
  source: string;
  m: number[];
  ele: (number | null)[];
}
export interface CurrentPointer {
  run_id: string;
  updated_at: string;
}
