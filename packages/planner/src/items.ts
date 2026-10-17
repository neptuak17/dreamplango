/**
 * Plan rules (11.6): facts on the rider's days become a few plan items, each with why it matters to this rider and
 * the evidence behind it (D38). Thresholds live here, in one place to tune (D13).
 *
 * The teaser (D45) has only the free files, so it gets the rules that need nothing else: effort, sunset, days, beds by
 * count, gaps, getting there, borders and missing data. The Trip Pass adds findings, water and food, opening on the
 * date, climbs and highlights.
 */
import type { Finding, Highlight, Place, Stop } from "@dpg/contracts";
import type { PlanCore } from "./plan";
import { bedsFor } from "./stages";
import { clock, dayIndex, monthOf, weekday } from "./sun";
import { country, day as dayText, hours, km, MONTHS_LONG, plural, stopName, WEEKDAYS_LONG } from "./text";
import type { DayPlan, Handoff, PlanData, PlanItem } from "./types";

export const CAPS = { headsup: 3, highlight: 3, brief: 5 };

/** Schengen members (2025); crossing out of or into the area needs documents checked. Source: European Commission. */
export const SCHENGEN = new Set([
  "AT", "BE", "BG", "CH", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU", "IS", "IT", "LI", "LT", "LU",
  "LV", "MT", "NL", "NO", "PL", "PT", "RO", "SE", "SI", "SK",
]);
// Microstates with open borders to Schengen neighbours count as inside for this purpose.
const OPEN_BORDER = new Set(["MC", "SM", "VA", "AD"]);
const inSchengen = (cc: string | null) => !!cc && (SCHENGEN.has(cc) || OPEN_BORDER.has(cc));

/** National rail operators' sites, for the getting-there handoff (D41). */
export const RAIL: Record<string, { name: string; url: string }> = {
  ES: { name: "Renfe", url: "https://www.renfe.com" },
  FR: { name: "SNCF Connect", url: "https://www.sncf-connect.com" },
  MC: { name: "SNCF Connect", url: "https://www.sncf-connect.com" },
  IT: { name: "Trenitalia", url: "https://www.trenitalia.com" },
  SI: { name: "Slovenske železnice", url: "https://potniski.sz.si" },
  HR: { name: "HŽPP", url: "https://www.hzpp.hr" },
  GR: { name: "Hellenic Train", url: "https://www.hellenictrain.gr" },
  PT: { name: "CP", url: "https://www.cp.pt" },
  DE: { name: "Deutsche Bahn", url: "https://www.bahn.de" },
  CH: { name: "SBB", url: "https://www.sbb.ch" },
  AT: { name: "ÖBB", url: "https://www.oebb.at" },
};

function wikiLink(h: Highlight): Handoff | null {
  if (h.wikipedia) {
    const [lang, ...rest] = h.wikipedia.split(":");
    const title = rest.join(":");
    if (lang && title) {
      return { kind: "wiki", label: "Wikipedia", url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}` };
    }
  }
  if (h.wikidata) return { kind: "wiki", label: "Wikidata", url: `https://www.wikidata.org/wiki/${encodeURIComponent(h.wikidata)}` };
  return null;
}

/** Call, website and maps links for a place (D41, D48): its own site where we have one, else the maps listing. */
export function placeLinks(p: { name: string | null; lat: number; lon: number; detail: Record<string, unknown> }): Handoff[] {
  const out: Handoff[] = [];
  const site = (p.detail.website ?? p.detail["contact:website"]) as string | undefined;
  const phone = (p.detail.phone ?? p.detail["contact:phone"]) as string | undefined;
  if (site) out.push({ kind: "website", label: "Website", url: site.startsWith("http") ? site : `https://${site}` });
  if (phone) out.push({ kind: "phone", label: phone, url: `tel:${phone.replace(/[^\d+]/g, "")}` });
  const q = p.name ? encodeURIComponent(p.name) : `${p.lat},${p.lon}`;
  out.push({ kind: "maps", label: "See it in Google Maps", url: `https://www.google.com/maps/search/?api=1&query=${q}` });
  return out;
}

const dayKm = (core: PlanCore, d: DayPlan, m: number) => Math.max(0, (core.axis.tOf(m) - d.fromT) / 1000);

function inDay(core: PlanCore, d: DayPlan, m0: number, m1: number): boolean {
  const lo = Math.min(d.fromM, d.toM);
  const hi = Math.max(d.fromM, d.toM);
  const a = Math.min(m0, m1);
  const b = Math.max(m0, m1);
  return b >= lo && a <= hi && core.axis.length > 0;
}

function holidayOn(data: PlanData, cc: string | null, iso: string) {
  const cal = data.calendar?.countries.find((c) => c.country === cc);
  if (!cal || cal.public_year !== Number(iso.slice(0, 4))) return null;
  return cal.public.find((h) => h.date === iso && h.nationwide) ?? null;
}

function schoolOn(data: PlanData, cc: string | null, iso: string) {
  const cal = data.calendar?.countries.find((c) => c.country === cc);
  if (!cal || cal.school_year !== Number(iso.slice(0, 4))) return null;
  return cal.school.find((s) => s.start <= iso && iso <= s.end) ?? null;
}

function bedPlaces(full: NonNullable<PlanData["full"]>, stop: Stop, sleep: string): Place[] {
  return full.places
    .filter(
      (p) =>
        p.service === "accommodation" &&
        p.counts &&
        Math.abs(p.access_at_m - stop.at_m) <= 5000 &&
        (sleep === "mix" || (sleep === "camping") === (p.kind === "campsite")),
    )
    .sort((a, b) => Math.abs(a.access_at_m - stop.at_m) - Math.abs(b.access_at_m - stop.at_m));
}

export function planItems(data: PlanData, core: PlanCore): PlanItem[] {
  const items: PlanItem[] = [];
  const { inputs, level, usual, days, nights } = core;
  const rides = days.filter((d) => d.kind === "ride");
  const add = (i: PlanItem) => items.push(i);

  // --- effort and daylight ---------------------------------------------------------------------------------
  for (const d of rides) {
    if (d.effort === "beyond") {
      add({
        id: `effort:beyond:${d.number}`,
        kind: "call",
        day: d.number,
        fromM: d.fromM,
        toM: d.toM,
        title: `Day ${d.number} is beyond ${level.name}: ${km(d.km)} km, ${Math.round(d.climbM)} m`,
        why: `About ${hours(d.hoursSlow)} riding, against your usual ${hours(usual.hours)}.`,
        rank: 36,
        topic: "able",
        evidence: { source: "pace model (level presets, D36)" },
        handoffs: [],
        options: [
          { id: "add-day", label: "Add a day", effect: "one more riding day; the others re-plan around it" },
          { id: `move:${d.number}`, label: "Move this stop", effect: "pick another night's stop on the day" },
          { id: "keep", label: "Keep it", effect: "a long day, ridden as it is" },
        ],
      });
    }
    if (d.sunset !== null && d.endMinutes > d.sunset) {
      const early = Math.ceil((d.endMinutes - d.sunset + 15) / 15) * 15;
      add({
        id: `sunset:${d.number}`,
        kind: "call",
        day: d.number,
        fromM: d.fromM,
        toM: d.toM,
        title: `Day ${d.number} ends after sunset at your pace`,
        why: `In at about ${clock(d.endMinutes)}; sunset ${clock(d.sunset)}${d.clockApprox ? " (approximate clock)" : ""}.`,
        rank: 45,
        topic: "risk",
        evidence: { source: "pace model; NOAA sunset" },
        handoffs: [],
        options: [
          { id: `earlier:${early}`, label: `Leave at ${clock(inputs.startMinutes - early)}`, effect: `start ${early} min earlier` },
          { id: `move:${d.number}`, label: "Stop earlier", effect: "end the day at an earlier stop" },
          { id: "keep", label: "Keep it", effect: "ride the last part in the dusk" },
        ],
      });
    }
  }
  for (let i = 0; i + 2 < rides.length; i++) {
    const run = rides.slice(i, i + 3);
    if (run.every((d) => d.effort !== "within") && !items.some((x) => x.id.startsWith("effort:run:"))) {
      add({
        id: `effort:run:${run[0]!.number}`,
        kind: "call",
        day: run[1]!.number,
        fromM: run[0]!.fromM,
        toM: run[2]!.toM,
        title: `Days ${run[0]!.number}–${run[2]!.number} are all harder than your usual`,
        why: "Three long days in a row add up.",
        rank: 32,
        topic: "able",
        evidence: { source: "pace model" },
        handoffs: [],
        options: [
          { id: `rest:${run[1]!.ride}`, label: `Rest after day ${run[1]!.number}`, effect: "one more day on the calendar" },
          { id: "keep", label: "Keep it", effect: "no rest day" },
        ],
      });
    }
  }
  for (const o of core.offers) {
    add({
      id: `days:${o.days}`,
      kind: "call",
      day: null,
      fromM: null,
      toM: null,
      title: o.why,
      why: `You chose ${plural(inputs.days, "riding day")}; this is the planner's suggestion, not a change.`,
      rank: 34,
      topic: "able",
      evidence: { source: "stage planner" },
      handoffs: [],
      options: [
        { id: `days:${o.days}`, label: `${o.days} days`, effect: o.days > inputs.days ? "one more riding day" : "one riding day fewer" },
        { id: "keep", label: `Keep ${inputs.days}`, effect: "as you chose" },
      ],
    });
  }
  // The steepest 500 m of each day, from the effort profile: a heads-up when it is steep for the rider's level.
  const steepFor: Record<number, number> = { 1: 6, 2: 8, 3: 10, 4: 12, 5: 14 };
  for (const d of rides) {
    const limit = steepFor[level.level] ?? 10;
    if (d.steepest && d.steepest.grade >= limit) {
      add({
        id: `steep:${d.number}`,
        kind: "headsup",
        day: d.number,
        fromM: core.axis.mOf(d.fromT + d.steepest.atKm * 1000),
        toM: core.axis.mOf(d.fromT + d.steepest.atKm * 1000 + 500),
        title: `km ${Math.round(d.steepest.atKm)}: 500 m at ${Math.round(d.steepest.grade)}%`,
        why: `The steepest part of the day, steep for ${level.name} riders; from a 30 m terrain model, so short ramps can be steeper.`,
        rank: 35,
        topic: "able",
        evidence: { source: "Copernicus DEM GLO-30 (effort.json)" },
        handoffs: [],
      });
    }
  }
  for (const d of rides) {
    if (d.unknownKm >= 1) {
      add({
        id: `terrain:${d.number}`,
        kind: "headsup",
        day: d.number,
        fromM: d.fromM,
        toM: d.toM,
        title: `Terrain unknown for ${km(d.unknownKm)} km: climbing and time are minimums`,
        why: "The official track is a straight line or a gap there, so nobody has measured the real road (D37).",
        rank: 29,
        topic: "risk",
        evidence: { source: "effort.json" },
        handoffs: [],
      });
    }
  }

  // --- gaps (D47, D50) -------------------------------------------------------------------------------------
  for (const d of rides) {
    for (const g of d.gaps) {
      const at = Math.round(dayKm(core, d, g.atM));
      if (g.type === "ferry") {
        add({
          id: `ferry:${Math.round(g.atM)}`,
          kind: "todo",
          day: d.number,
          fromM: g.atM,
          toM: g.atM,
          title: `Ferry on day ${d.number}: check its season and times`,
          why: `A ${km(g.km)} km crossing at km ${at} of the day; we have no timetables, so it isn't timed.`,
          rank: 38,
          topic: "prepare",
          evidence: { source: "OSM ferry route (effort.json gaps)" },
          handoffs: [],
        });
      } else if (g.type === "public_transport") {
        add({
          id: `transport:${Math.round(g.atM)}`,
          kind: "todo",
          day: d.number,
          fromM: g.atM,
          toM: g.atM,
          title: `Public-transport link on day ${d.number}: check times and bike rules`,
          why: `The network advises public transport across ${km(g.km)} km at km ${at} of the day.`,
          rank: 38,
          topic: "prepare",
          evidence: { source: "network's published advice" },
          handoffs: [],
        });
      } else if (g.type === "missing" || g.type === "unclassified") {
        add({
          id: `gap:${Math.round(g.atM)}`,
          kind: "headsup",
          day: d.number,
          fromM: g.atM,
          toM: g.atM,
          title: `The route has a ${km(g.km)} km gap here, counted as ridden`,
          why: `At km ${at} of the day the official track stops: no track, ferry or published link. Draw your own line across it in your route tool.`,
          rank: 52,
          topic: "risk",
          evidence: { source: "effort.json gaps (D50)" },
          handoffs: [],
        });
      }
    }
  }

  // --- nights (D18) ----------------------------------------------------------------------------------------
  for (const n of nights) {
    const d = days.find((x) => x.ride === n.afterRide)!;
    const name = stopName(n.stop);
    const handoffs: Handoff[] = [];
    if (data.full) {
      for (const p of bedPlaces(data.full, n.stop, inputs.sleep).slice(0, 3)) {
        const links = placeLinks(p).filter((l) => l.kind !== "maps");
        if (links.length) handoffs.push(...links.map((l) => ({ ...l, label: `${p.name ?? "Unnamed"}: ${l.label}` })));
      }
    }
    if (n.stop.beds.length === 0 || n.beds.count === 0) {
      add({
        id: `bed:none:${n.index}`,
        kind: "todo",
        day: d.number,
        fromM: n.stop.at_m,
        toM: n.stop.at_m,
        title: `No known place to stay of your kind at the end of day ${d.number}`,
        why: "None counts within 5 km of the route here: check yourself, or change how you sleep.",
        rank: 48,
        topic: "sleep",
        evidence: { source: "stops.json" },
        handoffs,
      });
      continue;
    }
    if (n.beds.open + n.beds.partly === 0) {
      add({
        id: `bed:check:${n.index}`,
        kind: "todo",
        day: d.number,
        fromM: n.stop.at_m,
        toM: n.stop.at_m,
        title: `Check a bed at ${name} for ${dayText(n.date)}`,
        why: `${plural(n.beds.count, "place")} of your kind there; none publishes ${MONTHS_LONG[monthOf(n.date)]} dates.`,
        rank: 42,
        topic: "sleep",
        evidence: { source: "stops.json (D18)" },
        handoffs,
      });
    } else if (n.beds.count === 1) {
      const b = n.planB.after ?? n.planB.before;
      add({
        id: `bed:single:${n.index}`,
        kind: "todo",
        day: d.number,
        fromM: n.stop.at_m,
        toM: n.stop.at_m,
        title: `Only one place of your kind at ${name}`,
        why: b ? `Plan B: ${stopName(b.stop)}, ${km(Math.abs(b.km))} km ${b.km > 0 ? "on" : "back"}.` : "No other stop nearby.",
        rank: 41,
        topic: "sleep",
        evidence: { source: "stops.json" },
        handoffs,
      });
    }
    const hol = holidayOn(data, n.stop.country, n.date);
    const school = schoolOn(data, n.stop.country, n.date);
    const sec = data.dream.sections.find((s) => s.from_m <= n.stop.at_m && n.stop.at_m <= s.to_m);
    const busy = sec?.crowding.tourism_index[monthOf(n.date)];
    const why = hol ? `a public holiday (${hol.name})` : school ? `school holidays (${school.name})` : busy && busy >= 1.3 ? `a busy month for tourism there` : null;
    if (why && n.beds.count <= 3) {
      add({
        id: `book:${n.index}`,
        kind: "todo",
        day: d.number,
        fromM: n.stop.at_m,
        toM: n.stop.at_m,
        title: `Book ahead at ${name} for ${dayText(n.date)}`,
        why: `${plural(n.beds.count, "place")} of your kind, on ${why}.`,
        rank: 40,
        topic: "sleep",
        evidence: { source: "stops.json; OpenHolidays; Eurostat" },
        handoffs,
      });
    }
  }

  // --- getting there and back, borders ---------------------------------------------------------------------
  const ends = [
    { id: "start", m: core.axis.startM, d: rides[0]!, word: "to the start" },
    { id: "end", m: core.axis.endM, d: rides[rides.length - 1]!, word: "home from the end" },
  ];
  for (const e of ends) {
    const near = data.stops.stops
      .filter((s) => s.station && s.station_at_m !== null && Math.abs(s.station_at_m - e.m) <= 10_000)
      .sort((a, b) => Math.abs(a.station_at_m! - e.m) - Math.abs(b.station_at_m! - e.m))[0];
    const rail = near?.country ? RAIL[near.country] : undefined;
    add({
      id: `travel:${e.id}`,
      kind: "todo",
      day: e.d.number,
      fromM: e.m,
      toM: e.m,
      title: near ? `Train ${e.word}: ${near.station}` : `Getting ${e.word}: no bike-carrying station found nearby`,
      why: near
        ? `${near.station} carries bikes (our bike-carriage table) and is ${km(Math.abs(near.station_at_m! - e.m) / 1000)} km from the ${e.id}.`
        : "Plan how you get there and back; we found no station within 10 km.",
      rank: 25,
      topic: "prepare",
      evidence: { source: "M2 stations, bike-carriage table (D20)" },
      handoffs: rail ? [{ kind: "rail", label: rail.name, url: rail.url }] : [],
    });
  }
  let prev: string | null = null;
  for (const d of rides) {
    const cc = d.stop?.country ?? null;
    if (prev && cc && cc !== prev && (!inSchengen(prev) || !inSchengen(cc))) {
      add({
        id: `border:${prev}-${cc}`,
        kind: "todo",
        day: d.number,
        fromM: d.fromM,
        toM: d.toM,
        title: `Border into ${country(cc)} on day ${d.number}: check entry rules`,
        why: `${country(prev)} and ${country(cc)} are not both in the Schengen area.`,
        rank: 26,
        topic: "prepare",
        evidence: { source: "Schengen members (European Commission)" },
        handoffs: [],
      });
    }
    if (cc) prev = cc;
  }

  // --- missing data (D37) ----------------------------------------------------------------------------------
  const countries = [...new Set(nights.map((n) => n.stop.country).filter((c): c is string => !!c))];
  const year = Number(inputs.startDate.slice(0, 4));
  for (const cc of countries) {
    const cal = data.calendar?.countries.find((c) => c.country === cc);
    if (!cal || cal.public_year === null) {
      add({ id: `data:holidays:${cc}`, kind: "todo", day: null, fromM: null, toM: null, title: `Public holidays in ${country(cc)}: no data`, why: "Shops and some places close on public holidays: check the local calendar.", rank: 15, topic: "prepare", evidence: { source: "OpenHolidays" }, handoffs: [] });
    } else if (cal.public_year !== year) {
      add({ id: `data:holidays:${cc}`, kind: "todo", day: null, fromM: null, toM: null, title: `Public holidays in ${country(cc)} for ${year} aren't published yet`, why: "Check the local calendar before you go.", rank: 15, topic: "prepare", evidence: { source: "OpenHolidays" }, handoffs: [] });
    }
  }
  const unknownSurface = rides.reduce((a, d) => a + d.surfaces.u * d.km, 0);
  const total = rides.reduce((a, d) => a + d.km, 0);
  if (total > 0 && unknownSurface / total > 0.1) {
    add({
      id: "data:surface",
      kind: "todo",
      day: null,
      fromM: null,
      toM: null,
      title: `Surface unknown for ${km(unknownSurface)} km of the way`,
      why: "Times there are ranges; look at the line in your route tool or street-level imagery.",
      rank: 14,
      topic: "prepare",
      evidence: { source: "OSM surface tags (M1)" },
      handoffs: [],
    });
  }

  if (data.full) fullRules(data, core, add);

  return items.sort((a, b) => b.rank - a.rank || (a.day ?? 0) - (b.day ?? 0));
}

interface FindingRule {
  rank: number;
  title: (f: Finding, len: number) => string;
  why: string;
  relevant?: (core: PlanCore, f: Finding, len: number) => boolean;
}

/** Audit findings that become heads-ups, in the rider's words (the audit's own wording is for us, D43). */
const FINDING_RULES: Record<string, FindingRule> = {
  "audit.busy_road": {
    rank: 55,
    title: (f, len) => {
      const roads = f.title.split(" on ").slice(2).join(" on ");
      return `${km(len)} km on busy roads${roads ? ` (${roads})` : ""}`;
    },
    why: "Fast or heavy traffic and no cycle lane, estimated from the road's class and speed limit.",
    relevant: (core, _f, len) => len >= 1 || core.inputs.avoidBusy,
  },
  "audit.steps": { rank: 36, title: () => "steps", why: "You'll need to carry or push the bike." },
  "audit.unpaved": {
    rank: 34,
    title: (_f, len) => `${km(len)} km unpaved`,
    why: "Loose gravel, dirt or sand: slow with a loaded bike, and harder when wet.",
    relevant: (core) => core.inputs.avoidGravel || core.inputs.bike === "road",
  },
  "services.bail_out": {
    rank: 46,
    title: (_f, len) => `${km(len)} km without a station that carries bikes`,
    why: "No station within 10 km of the route where bikes are known to be carried.",
  },
  "eurovelo.undeveloped": {
    rank: 30,
    title: () => "the route is undeveloped here",
    why: "EuroVelo has no reliable information here, or it isn't developed for cycling: expect no signs, and possibly busy roads.",
  },
  "eurovelo.partially_developed": {
    rank: 20,
    title: () => "the route is partially developed here",
    why: "EuroVelo rates it partially developed: expect parts without cycle infrastructure or signs.",
  },
  "audit.unmatched": {
    rank: 31,
    title: (_f, len) => `${km(len)} km where the official track follows no mapped way`,
    why: "Check the line in your route tool.",
    relevant: (_core, _f, len) => len >= 1,
  },
};

function fullRules(data: PlanData, core: PlanCore, add: (i: PlanItem) => void) {
  const full = data.full!;
  const rides = core.days.filter((d) => d.kind === "ride");
  const water = full.serviceTypes.find((t) => t.id === "water");
  const food = full.serviceTypes.find((t) => t.id === "food");
  for (const d of rides) {
    // Findings on the day.
    for (const f of full.findings) {
      const rule = FINDING_RULES[f.rule_id];
      if (!rule || !inDay(core, d, f.from_m, f.to_m)) continue;
      // Only the part of the finding on this day counts, and its km are the day's own.
      const lo = Math.max(Math.min(f.from_m, f.to_m), Math.min(d.fromM, d.toM));
      const hi = Math.min(Math.max(f.from_m, f.to_m), Math.max(d.fromM, d.toM));
      const len = Math.max(0, hi - lo) / 1000;
      if (rule.relevant && !rule.relevant(core, f, len)) continue;
      const clip = (m: number) => Math.min(Math.round(d.km), Math.round(dayKm(core, d, m)));
      const [a, b] = [clip(lo), clip(hi)].sort((x, y) => x - y) as [number, number];
      add({
        id: `finding:${f.id}:${d.number}`,
        kind: "headsup",
        day: d.number,
        fromM: lo,
        toM: hi,
        title: `${a === b ? `km ${a}` : `km ${a}–${b}`}: ${rule.title(f, len)}`,
        why: rule.why,
        rank: rule.rank + Math.min(4, len / 5),
        topic: rule.rank >= 45 ? "risk" : "like",
        evidence: { findings: [f.id], source: "audit findings" },
        handoffs: [],
      });
    }
    // Water and food: where they are, and the longest stretch without (riders judge what to carry, D48).
    const lo = Math.min(d.fromM, d.toM);
    const hi = Math.max(d.fromM, d.toM);
    const on = (svc: string[]) =>
      full.places
        .filter((p) => svc.includes(p.service) && p.counts && p.access_at_m >= lo && p.access_at_m <= hi)
        .map((p) => dayKm(core, d, p.access_at_m))
        .sort((x, y) => x - y);
    for (const [svc, cfg, label] of [
      [["water", "food"], water, "water"],
      [["food"], food, "food"],
    ] as const) {
      if (!cfg?.gap_m) continue;
      const pts = [0, ...on([...svc]), d.km];
      let worst = 0;
      let at = 0;
      for (let i = 1; i < pts.length; i++) {
        if (pts[i]! - pts[i - 1]! > worst) {
          worst = pts[i]! - pts[i - 1]!;
          at = pts[i - 1]!;
        }
      }
      if (worst * 1000 > cfg.gap_m) {
        add({
          id: `${label}:gap:${d.number}`,
          kind: "headsup",
          day: d.number,
          fromM: d.fromM,
          toM: d.toM,
          title: `No ${label} for ${Math.round(worst)} km from km ${Math.round(at)}`,
          why: `The longest stretch on the day without ${label === "water" ? "water or a shop" : "food"}; you judge what to carry.`,
          rank: 47,
          topic: "risk",
          evidence: { source: "M2 places" },
          handoffs: [],
        });
      }
    }
    // Food places open on the date, where their hours are known (D37: the known part only).
    const iso = d.date;
    const di = dayIndex(iso);
    const hol = holidayOn(data, d.stop?.country ?? null, iso);
    const known = full.places.filter(
      (p) => p.service === "food" && p.counts && p.access_at_m >= lo && p.access_at_m <= hi && typeof p.detail.days === "string",
    );
    if (known.length >= 3) {
      const open = known.filter((p) => {
        if (hol && /\bPH\b/.test(p.opening_hours ?? "")) return false;
        return (p.detail.days as string)[di] === "o";
      }).length;
      if (open / known.length <= 0.5) {
        const what = hol ? `a public holiday (${hol.name})` : `a ${WEEKDAYS_LONG[weekday(iso)]}`;
        add({
          id: `open:${d.number}`,
          kind: "headsup",
          day: d.number,
          fromM: d.fromM,
          toM: d.toM,
          title: `Day ${d.number} is ${what}: ${open} of the ${known.length} food places with known hours are open`,
          why: "Most places publish no hours; check the ones you count on.",
          rank: 44,
          topic: "risk",
          evidence: { places: known.map((p) => p.id), source: "OSM opening_hours" },
          handoffs: [],
        });
      }
    }
    // The day's biggest climb.
    const climbs = full.climbs.filter((c) => c.direction === core.inputs.direction && inDay(core, d, c.from_m, c.to_m));
    const big = climbs.sort((a, b) => b.fiets - a.fiets)[0];
    if (big && big.gain_m >= 150) {
      const at = Math.round(dayKm(core, d, core.inputs.direction === "forward" ? big.from_m : big.to_m));
      const tough = core.level.level <= 2 && (big.avg_grade >= 5 || big.length_m >= 5000);
      add({
        id: `climb:${d.number}`,
        kind: tough ? "headsup" : "highlight",
        day: d.number,
        fromM: big.from_m,
        toM: big.to_m,
        title: `The day's big climb: ${km(big.length_m / 1000)} km at ${big.avg_grade.toFixed(1)}% from km ${at}, to ${Math.round(big.top_m)} m`,
        why: `${Math.round(big.gain_m)} m up; steepest 500 m ${big.max_grade_500m.toFixed(0)}%.`,
        rank: tough ? 33 : 18,
        topic: tough ? "able" : "like",
        evidence: { source: "M1 climbs (FIETS)" },
        handoffs: [],
      });
    }
    // Highlights.
    for (const h of full.highlights) {
      if (!inDay(core, d, h.at_m, h.at_m)) continue;
      const link = wikiLink(h);
      add({
        id: `highlight:${h.id}`,
        kind: "highlight",
        day: d.number,
        fromM: h.at_m,
        toM: h.at_m,
        title: h.name,
        why: `${h.kind.replaceAll("_", " ")}${h.unesco ? ", UNESCO World Heritage" : ""}${h.offset_m >= 300 ? `, ${km(h.offset_m / 1000)} km off the route` : ""} at km ${Math.round(dayKm(core, d, h.at_m))}`,
        rank: 10 + 8 * h.rank,
        topic: "like",
        evidence: { highlights: [h.id], source: "OpenStreetMap" },
        handoffs: link ? [link] : [],
      });
    }
  }
}

/** A day's items within the attention budget (11.6): calls and to-dos all, heads-ups and highlights capped. */
export function dayItems(items: PlanItem[], dayNumber: number) {
  const mine = items.filter((i) => i.day === dayNumber);
  const pick = (kind: PlanItem["kind"], cap: number) => {
    const all = mine.filter((i) => i.kind === kind);
    return { shown: all.slice(0, cap), more: Math.max(0, all.length - cap) };
  };
  return {
    calls: mine.filter((i) => i.kind === "call"),
    todos: mine.filter((i) => i.kind === "todo"),
    headsups: pick("headsup", CAPS.headsup),
    highlights: pick("highlight", CAPS.highlight),
  };
}

export const openItems = (items: PlanItem[], done: string[], dismissed: string[]) =>
  items.filter((i) => !done.includes(i.id) && !dismissed.includes(i.id));

export { bedsFor };
