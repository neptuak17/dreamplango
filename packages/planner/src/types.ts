import type {
  CalendarFile,
  Climb,
  DailySection,
  DreamFile,
  EffortFile,
  Finding,
  Highlight,
  Place,
  ServiceType,
  Stop,
  StopsFile,
} from "@dpg/contracts";

export type Direction = "forward" | "reverse";
export type Bike = "road" | "touring" | "gravel" | "ebike";
export type Sleep = "camping" | "rooms" | "mix";
export type StopStyle = "short" | "normal" | "long";

/** What the rider tells Plan (11.6). Dream suggests the stretch, time frame, days and level (D48). */
export interface PlanInputs {
  /** Route measures of the stretch's ends (from < to); `direction` says which way it is ridden. */
  fromM: number;
  toM: number;
  direction: Direction;
  /** The first riding day, YYYY-MM-DD. */
  startDate: string;
  /** Riding days; rest days come on top. */
  days: number;
  /** D36 level 1-5. */
  level: number;
  bike: Bike;
  sleep: Sleep;
  /** Leaving time each morning, minutes after local midnight. */
  startMinutes: number;
  stopStyle: StopStyle;
  /** A rest day follows these riding days (1-based): the rider stays a second night at that stop. */
  restAfter: number[];
  /** From Dream: avoid gravel, avoid busy roads. */
  avoidGravel: boolean;
  avoidBusy: boolean;
}

export interface RouteRef {
  network: string;
  ref: string;
  runId: string;
  name: string;
}

/** The free bundle files (D45): enough to plan days and real stops, never naming a bed, water point or finding. */
export interface FreeData {
  route: RouteRef;
  dream: DreamFile;
  stops: StopsFile;
  effort: EffortFile;
  calendar: CalendarFile | null;
  daily: DailySection[];
}

/** What the Trip Pass adds: the places, findings, highlights and climbs on the stretch. */
export interface FullData {
  findings: Finding[];
  /** Places on the stretch (any service), from the filtered places endpoint. */
  places: Place[];
  highlights: Highlight[];
  climbs: Climb[];
  serviceTypes: ServiceType[];
}

export interface PlanData extends FreeData {
  /** Null in the teaser. */
  full: FullData | null;
}

/** The rider's own choices kept with a plan: stops, locks, beds and the state of its items. */
export interface PlanChoices {
  /** Stop id per night (night i follows riding day i + 1); when given, the plan keeps these nights. */
  nights?: string[];
  /** Nights the rider fixed (booked or chosen): night index -> stop id. */
  locked: Record<number, string>;
  /** Chosen bed per night: night index -> place id. */
  beds: Record<number, string>;
  booked: number[];
  done: string[];
  dismissed: string[];
}

export const NO_CHOICES: PlanChoices = { locked: {}, beds: {}, booked: [], done: [], dismissed: [] };

export type Effort = "within" | "harder" | "beyond";

export interface DayPlan {
  /** 1-based calendar day (rest days included). */
  number: number;
  /** 1-based riding day; null on a rest day. */
  ride: number | null;
  date: string;
  kind: "ride" | "rest";
  /** Trip positions (ridden metres from the start, counting unfilled gaps). */
  fromT: number;
  toT: number;
  /** Route measures in the direction of travel. */
  fromM: number;
  toM: number;
  startName: string;
  /** The night's stop; null on the last day. */
  stop: Stop | null;
  endName: string;
  km: number;
  climbM: number;
  /** Km whose terrain is unknown (placeholders, unfilled gaps): climbing and time are then minimums. */
  unknownKm: number;
  /** Riding hours: planned on the slow end (D37). Equal when nothing is unknown. */
  hoursFast: number;
  hoursSlow: number;
  /** Stops and lunch, minutes. */
  stopsMin: number;
  startMinutes: number;
  endMinutes: number;
  sunrise: number | null;
  sunset: number | null;
  clockApprox: boolean;
  effort: Effort;
  /** Shares of road, cycle path, gravel, unknown (D36). */
  surfaces: { r: number; c: number; g: number; u: number };
  /** Gaps crossed: ferries and published links (not ridden) and unfilled gaps (counted as ridden). */
  gaps: { type: string; km: number; atM: number }[];
  tailwindMs: number | null;
  /** The steepest 500 m on known terrain, in the direction of travel: grade (%) and km of the day. */
  steepest: { grade: number; atKm: number } | null;
  /** Dream sections the day touches. */
  sections: number[];
}

export type ItemKind = "call" | "todo" | "headsup" | "highlight";

export interface Handoff {
  kind: "website" | "phone" | "maps" | "rail" | "wiki" | "ferry";
  label: string;
  url: string;
}

export interface CallOption {
  id: string;
  label: string;
  /** What choosing it changes, in a few words. */
  effect: string;
}

/** A plan item (11.6): facts turned into something for this rider, with the evidence behind it (D38). */
export interface PlanItem {
  id: string;
  kind: ItemKind;
  /** Calendar day number, or null for the whole trip. */
  day: number | null;
  /** Route measure range, when it has one. */
  fromM: number | null;
  toM: number | null;
  title: string;
  /** Why it matters to this rider. */
  why: string;
  /** A name short enough for a bike computer's screen (GPX waypoints). */
  short?: string;
  /** Higher first: 50+ safety, 40+ a bed or water, 30+ effort, 20+ comfort, 10+ interest. */
  rank: number;
  /** Which of the brief's five questions it answers. */
  topic: "able" | "sleep" | "risk" | "prepare" | "like";
  evidence: { findings?: string[]; places?: string[]; highlights?: string[]; source?: string; date?: string };
  handoffs: Handoff[];
  options?: CallOption[];
}

export interface NightPlan {
  index: number;
  date: string;
  /** Riding day (1-based) this night follows. */
  afterRide: number;
  stop: Stop;
  locked: boolean;
  /** Beds of the rider's kind that night: open, partly, closed, unknown (D18). */
  beds: { count: number; open: number; partly: number; unknown: number };
  /** Other stops worth considering, best first. */
  alternatives: { stop: Stop; dayKm: number; nextKm: number | null }[];
  planB: { before: { stop: Stop; km: number } | null; after: { stop: Stop; km: number } | null };
  why: string;
}

export interface BriefLine {
  topic: "able" | "sleep" | "risk" | "prepare" | "like";
  question: string;
  answer: string;
  more: number;
}

export interface Brief {
  title: string;
  dates: string;
  km: number;
  climbM: number;
  direction: Direction;
  effort: { day: number; hours: number; usual: number; effort: Effort }[];
  lines: BriefLine[];
  readiness: string;
  confidence: string[];
}
