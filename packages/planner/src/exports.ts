/**
 * Exports (11.6, D48): a starter GPX per day and for the whole trip, and a calendar file. Built on the device.
 *
 * The GPX is a starter file (D47): Kilometrica doesn't build the rider's route. Gaps are marked at both ends, and
 * waypoints show the night's stop, water and food, the day's heads-ups and highlights (within the attention budget)
 * and stations for bailing out, for the rider to finish the route in their own tool.
 */
import { dayItems } from "./items";
import type { PlanResult } from "./plan";
import { addDays } from "./sun";
import { km, stopName } from "./text";
import type { DayPlan } from "./types";

/** The route's ridden lines with the path measure of every coordinate (from path.geojson). */
export interface PathLine {
  coords: [number, number][];
  m: number[];
}

export interface PathGap {
  atM: number;
  type: string;
  km: number;
  start: [number, number];
  end: [number, number];
}

export interface Geometry {
  lines: PathLine[];
  gaps: PathGap[];
}

export interface Waypoint {
  lon: number;
  lat: number;
  name: string;
  desc?: string;
  sym: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const short = (s: string, n = 30) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** The route point at a path measure. */
export function locate(geo: Geometry, m: number): [number, number] | null {
  for (const line of geo.lines) {
    const ms = line.m;
    if (!ms.length || m < ms[0]! - 1e-6 || m > ms[ms.length - 1]! + 1e-6) continue;
    let lo = 0;
    let hi = ms.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ms[mid]! <= m) lo = mid;
      else hi = mid;
    }
    const a = line.coords[lo]!;
    const b = line.coords[hi]!;
    const span = ms[hi]! - ms[lo]!;
    const f = span > 0 ? (m - ms[lo]!) / span : 0;
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  }
  return null;
}

/** The track between two path measures, in the direction of travel, one segment per ridden line. */
export function slice(geo: Geometry, fromM: number, toM: number): [number, number][][] {
  const lo = Math.min(fromM, toM);
  const hi = Math.max(fromM, toM);
  const segs: [number, number][][] = [];
  for (const line of geo.lines) {
    const ms = line.m;
    if (!ms.length || ms[ms.length - 1]! <= lo || ms[0]! >= hi) continue;
    const pts: [number, number][] = [];
    const first = locate({ lines: [line], gaps: [] }, Math.max(lo, ms[0]!));
    if (first) pts.push(first);
    for (let i = 0; i < ms.length; i++) if (ms[i]! > lo && ms[i]! < hi) pts.push(line.coords[i]!);
    const last = locate({ lines: [line], gaps: [] }, Math.min(hi, ms[ms.length - 1]!));
    if (last) pts.push(last);
    if (pts.length < 2) continue;
    // The route's lines meet end to end between its sections, or nearly (digitising breaks under ~300 m, like the
    // audit's): join them, so only a real gap breaks the track.
    const prev = segs[segs.length - 1];
    const end = prev?.[prev.length - 1];
    if (prev && end && Math.abs(end[0] - pts[0]![0]) < 0.0035 && Math.abs(end[1] - pts[0]![1]) < 0.0027) prev.push(...pts);
    else segs.push(pts);
  }
  if (toM < fromM) return segs.reverse().map((s) => s.reverse());
  return segs;
}

function dayWaypoints(plan: PlanResult, geo: Geometry, d: DayPlan): Waypoint[] {
  const out: Waypoint[] = [];
  const at = (m: number) => locate(geo, m);
  const lo = Math.min(d.fromM, d.toM);
  const hi = Math.max(d.fromM, d.toM);
  for (const g of geo.gaps) {
    if (g.atM < lo || g.atM > hi) continue;
    if (g.type === "ferry") {
      out.push({ lon: g.start[0], lat: g.start[1], name: "Ferry: check times", desc: `${km(g.km)} km crossing`, sym: "Anchor" });
    } else if (g.type === "public_transport") {
      out.push({ lon: g.start[0], lat: g.start[1], name: "Transport link", desc: `${km(g.km)} km: check times`, sym: "Ground Transportation" });
    } else if (g.km >= 1) {
      const [a, b] = plan.inputs.direction === "forward" ? [g.start, g.end] : [g.end, g.start];
      out.push({ lon: a[0], lat: a[1], name: `Gap start: ${km(g.km)} km`, desc: "The route isn't defined here: draw your own line.", sym: "Danger Area" });
      out.push({ lon: b[0], lat: b[1], name: "Gap end", desc: "The route continues here.", sym: "Danger Area" });
    }
  }
  if (d.stop) {
    const camping = plan.inputs.sleep === "camping";
    out.push({ lon: d.stop.lon, lat: d.stop.lat, name: short(`Night: ${stopName(d.stop)}`), sym: camping ? "Campground" : "Lodging" });
  }
  const mine = dayItems(plan.items, d.number);
  for (const i of [...mine.headsups.shown, ...mine.highlights.shown]) {
    if (i.fromM === null) continue;
    const p = at(i.fromM);
    if (!p) continue;
    out.push({ lon: p[0], lat: p[1], name: short(i.short ?? i.title), desc: `${i.title}. ${i.why}`, sym: i.kind === "highlight" ? "Scenic Area" : "Danger Area" });
  }
  return out;
}

export interface DayPlaces {
  water: { lon: number; lat: number; name: string | null; at: number }[];
  food: { lon: number; lat: number; name: string | null; at: number }[];
  stations: { lon: number; lat: number; name: string | null; at: number }[];
}

function placeWaypoints(day: DayPlaces | undefined): Waypoint[] {
  if (!day) return [];
  const thin = <T extends { at: number }>(xs: T[], everyKm: number) => {
    const out: T[] = [];
    for (const x of [...xs].sort((a, b) => a.at - b.at)) if (!out.length || x.at - out[out.length - 1]!.at >= everyKm) out.push(x);
    return out;
  };
  return [
    ...thin(day.water, 3).map((p) => ({ lon: p.lon, lat: p.lat, name: short(p.name ?? "Water"), sym: "Drinking Water" })),
    ...thin(day.food, 8).map((p) => ({ lon: p.lon, lat: p.lat, name: short(p.name ?? "Food"), sym: "Restaurant" })),
    ...day.stations.map((p) => ({ lon: p.lon, lat: p.lat, name: short(p.name ?? "Station"), sym: "Ground Transportation" })),
  ];
}

function gpxDoc(name: string, tracks: { name: string; segs: [number, number][][] }[], wpts: Waypoint[]): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Kilometrica" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata><name>${esc(name)}</name><desc>Starter file from Kilometrica: finish the route in your own route tool. Gaps are marked at both ends.</desc></metadata>`,
  ];
  for (const w of wpts) {
    lines.push(
      `  <wpt lat="${w.lat.toFixed(6)}" lon="${w.lon.toFixed(6)}"><name>${esc(w.name)}</name>${w.desc ? `<desc>${esc(w.desc)}</desc>` : ""}<sym>${esc(w.sym)}</sym></wpt>`,
    );
  }
  for (const t of tracks) {
    lines.push(`  <trk><name>${esc(t.name)}</name>`);
    for (const seg of t.segs) {
      lines.push("    <trkseg>");
      for (const [lon, lat] of seg) lines.push(`      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"/>`);
      lines.push("    </trkseg>");
    }
    lines.push("  </trk>");
  }
  lines.push("</gpx>", "");
  return lines.join("\n");
}

const dayTitle = (d: DayPlan) => `Day ${d.number}: ${d.startName} → ${d.endName}`;

export function dayGpx(plan: PlanResult, geo: Geometry, d: DayPlan, places?: DayPlaces): string {
  return gpxDoc(dayTitle(d), [{ name: dayTitle(d), segs: slice(geo, d.fromM, d.toM) }], [
    ...dayWaypoints(plan, geo, d),
    ...placeWaypoints(places),
  ]);
}

export function tripGpx(plan: PlanResult, geo: Geometry, places?: Map<number, DayPlaces>): string {
  const rides = plan.days.filter((d) => d.kind === "ride");
  return gpxDoc(
    plan.brief.title,
    rides.map((d) => ({ name: dayTitle(d), segs: slice(geo, d.fromM, d.toM) })),
    rides.flatMap((d) => [...dayWaypoints(plan, geo, d), ...placeWaypoints(places?.get(d.number))]),
  );
}

function icsText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

const octets = (ch: string) => {
  const c = ch.codePointAt(0)!;
  return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
};

/** Lines of at most 75 octets, continued with a space (RFC 5545 3.1), never splitting a character. */
function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  let size = 0;
  for (const ch of line) {
    const n = octets(ch);
    if (size + n > 75) {
      out.push(cur);
      cur = " ";
      size = 1;
    }
    cur += ch;
    size += n;
  }
  out.push(cur);
  return out.join("\r\n");
}

/** One all-day event per calendar day, the night's stop as its location (RFC 5545). */
export function calendarFile(plan: PlanResult, id: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const date = (iso: string) => iso.replaceAll("-", "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Kilometrica//Plan//EN", "CALSCALE:GREGORIAN"];
  for (const d of plan.days) {
    const summary =
      d.kind === "rest" ? `Day ${d.number}: rest day at ${d.endName}` : `Day ${d.number}: ${d.startName} → ${d.endName}, ${km(d.km)} km`;
    const desc =
      d.kind === "rest"
        ? "Rest day."
        : `${km(d.km)} km, ${Math.round(d.climbM)} m climbing. Planned with Kilometrica: check the plan for the day's details.`;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${id}-${d.number}@kilometrica.com`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${date(d.date)}`,
      `DTEND;VALUE=DATE:${date(addDays(d.date, 1))}`,
      fold(`SUMMARY:${icsText(summary)}`),
      fold(`DESCRIPTION:${icsText(desc)}`),
    );
    if (d.stop) lines.push(fold(`LOCATION:${icsText(stopName(d.stop))}`), `GEO:${d.stop.lat.toFixed(5)};${d.stop.lon.toFixed(5)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR", "");
  return lines.join("\r\n");
}
