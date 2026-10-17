import type { DreamSection, EffortFile, Stop } from "@dpg/contracts";
import { describe, expect, it } from "vitest";
import { TripAxis } from "./axis";
import { choicesOf, parseDocument, toDocument } from "./document";
import { calendarFile, dayGpx, type Geometry, tripGpx } from "./exports";
import { dayItems } from "./items";
import { LEVEL_FLAT_KMH, riderFor, speed, usualDay } from "./pace";
import { makePlan } from "./plan";
import { fromUtf8, itineraryOf, readFragment, shareFragment, utf8 } from "./share";
import { bedsFor } from "./stages";
import { clock, sunTimes, weekday } from "./sun";
import { NO_CHOICES, type PlanData, type PlanInputs } from "./types";

const LEVELS = [
  { level: 1, name: "Leisurely", km_min: 20, km_max: 40, climb_max_m: 300 },
  { level: 2, name: "Easy-moderate", km_min: 40, km_max: 60, climb_max_m: 500 },
  { level: 3, name: "Moderate", km_min: 50, km_max: 80, climb_max_m: 850 },
  { level: 4, name: "Challenging", km_min: 70, km_max: 100, climb_max_m: 1200 },
  { level: 5, name: "Tough", km_min: 90, km_max: 130, climb_max_m: 1500 },
];
const twelve = <T>(v: T) => Array.from({ length: 12 }, () => v);
const LAT = 43.5;
const DEG_PER_M = 1 / 80_700; // roughly, at this latitude

function section(n: number, from: number, to: number): DreamSection {
  return {
    number: n,
    from_m: from,
    to_m: to,
    length_m: to - from,
    country: "FR",
    climate: {
      point: [0, LAT],
      distance_m: 0,
      tmax_c: twelve(21),
      tmin_c: twelve(12),
      rain_days: twelve(0.2),
      rain_mm: twelve(1),
      heat_days: twelve(0),
      windy_days: twelve(0.1),
      wind_along_ms: twelve(0),
      headwind_days_fwd: twelve(0),
      headwind_days_rev: twelve(0),
    },
    themes: { coast: { score: 0.9, note: "" } },
    crowding: { country: "FR", school_days: twelve(0), school_year: 2027, public_holidays: twelve(0), public_year: 2027, tourism_index: twelve(1), tourism_years: "x" },
    findings: { warning: 2 },
  } as unknown as DreamSection;
}

function stop(km: number, over: Partial<Stop> = {}): Stop {
  return {
    id: `s${km}`,
    name: `Town ${km}`,
    place_kind: "town",
    at_m: km * 1000,
    lon: km * 1000 * DEG_PER_M,
    lat: LAT,
    country: "FR",
    detour_m: 200,
    beds: [
      { kind: "hotel", count: 2, seasons: [["????????????", 2]] },
      { kind: "campsite", count: 1, seasons: [["oooooooooooo", 1]] },
    ],
    services: { food: 2, water: 1 },
    station: km % 50 === 0 ? `Gare ${km}` : null,
    station_at_m: km % 50 === 0 ? km * 1000 : null,
    ...over,
  };
}

interface Opts {
  lengthKm?: number;
  hill?: number;
  gapAtKm?: number;
  gapType?: string;
  stopsEvery?: number;
  stops?: Stop[];
}

function data({ lengthKm = 300, hill = 0, gapAtKm, gapType = "missing", stopsEvery = 10, stops }: Opts = {}): PlanData {
  const L = lengthKm * 1000;
  const mk = (from: number, to: number) => {
    const n = Math.ceil((to - from) / 100);
    const ele = Array.from({ length: n + 1 }, (_, i) => Math.round(100 + hill * Math.sin((from + i * 100) / 4000)));
    return { from_m: from, to_m: to, ele, surface: "c".repeat(n) };
  };
  const gap = gapAtKm !== undefined ? gapAtKm * 1000 : null;
  const effort: EffortFile = {
    step_m: 100,
    parts: gap === null ? [mk(0, L)] : [mk(0, gap), mk(gap, L)],
    gaps: gap === null ? [] : [{ at_m: gap, after_section: 1, type: gapType, straight_distance_m: 20_000, basis: null, confidence: "medium" }],
  };
  const all = stops ?? Array.from({ length: Math.floor(lengthKm / stopsEvery) - 1 }, (_, i) => stop((i + 1) * stopsEvery));
  return {
    route: { network: "test", ref: "t1", runId: "20270101T000000Z_0000000000", name: "Test route" },
    dream: {
      profile: "dream-v0",
      season_year: 2027,
      climate_source: "test",
      levels: LEVELS,
      themes: [{ id: "coast", title: "Coast & beaches", measures: "" }],
      sections: Array.from({ length: Math.ceil(lengthKm / 50) }, (_, i) => section(i + 1, i * 50_000, Math.min(L, (i + 1) * 50_000))),
      breaks: [],
    },
    stops: { season_year: 2027, reach_m: 2500, stops: all },
    effort,
    calendar: {
      season_year: 2027,
      countries: [{ country: "FR", public_year: 2027, public: [{ date: "2027-11-01", name: "All Saints' Day", nationwide: true, regions: [] }], school_year: 2027, school: [] }],
    },
    daily: [],
    full: null,
  };
}

const inputs = (over: Partial<PlanInputs> = {}): PlanInputs => ({
  fromM: 0,
  toM: 300_000,
  direction: "forward",
  startDate: "2027-10-13",
  days: 5,
  level: 3,
  bike: "touring",
  sleep: "rooms",
  startMinutes: 9 * 60,
  stopStyle: "normal",
  restAfter: [],
  avoidGravel: false,
  avoidBusy: false,
  ...over,
});

describe("pace", () => {
  it("rides each level's flat speed on a touring bike, slower uphill, faster down", () => {
    for (const level of [1, 3, 5]) {
      const r = riderFor(level, "touring");
      expect(speed(r, 0, "paved") * 3.6).toBeCloseTo(LEVEL_FLAT_KMH[level]!, 1);
    }
    const r = riderFor(3, "touring");
    expect(speed(r, 0.05, "paved")).toBeLessThan(speed(r, 0, "paved") / 2);
    expect(speed(r, -0.05, "paved")).toBeGreaterThan(speed(r, 0, "paved"));
    expect(speed(r, 0, "gravel")).toBeLessThan(speed(r, 0, "paved"));
    expect(speed(r, 0, "paved", 3)).toBeGreaterThan(speed(r, 0, "paved", 0)); // tailwind
  });

  it("assists an e-bike up to 25 km/h, never beyond on the flat", () => {
    const e = riderFor(3, "ebike");
    expect(speed(e, 0.06, "paved")).toBeGreaterThan(speed(riderFor(3, "touring"), 0.06, "paved") * 1.5);
    expect(speed(e, 0, "paved") * 3.6).toBeLessThanOrEqual(25.01);
  });

  it("makes a Moderate usual day roughly 4-5 hours of riding", () => {
    const m = LEVELS[2]!;
    const u = usualDay(riderFor(3, "touring"), m.km_min, m.km_max, m.climb_max_m);
    expect(u.hours).toBeGreaterThan(3.6);
    expect(u.hours).toBeLessThan(5.2);
  });
});

describe("sun", () => {
  it("gives local sunset times through the country's time zone", () => {
    const s = sunTimes("2027-10-13", 43.6, 3.88, "FR"); // Montpellier
    expect(s.approximate).toBe(false);
    expect(s.sunset!).toBeGreaterThan(18 * 60 + 50);
    expect(s.sunset!).toBeLessThan(19 * 60 + 20);
    expect(s.sunrise!).toBeLessThan(8 * 60 + 15);
    expect(sunTimes("2027-10-13", 43.6, 3.88, null).approximate).toBe(true);
    expect(clock(19 * 60 + 5)).toBe("19:05");
    expect(weekday("2027-10-17")).toBe(6); // a Sunday
  });
});

describe("trip axis", () => {
  const r = riderFor(3, "touring");
  const secs = data().dream.sections;
  it("measures the same distance either way, and counts an unfilled gap as ridden (D50)", () => {
    const d = data({ gapAtKm: 155 });
    const fwd = new TripAxis(d.effort, 0, 300_000, "forward", r, secs, () => 0);
    const rev = new TripAxis(d.effort, 0, 300_000, "reverse", r, secs, () => 0);
    expect(fwd.length).toBeCloseTo(320_000, 0);
    expect(rev.length).toBeCloseTo(320_000, 0);
    expect(fwd.tOf(200_000)).toBeCloseTo(220_000, 0);
    expect(rev.tOf(200_000)).toBeCloseTo(100_000, 0);
    const st = fwd.stats(140_000, 180_000);
    expect(st.gaps).toEqual([{ type: "missing", km: 20, atM: 155_000 }]);
    expect(st.unknownKm).toBeCloseTo(20, 1);
  });

  it("leaves a ferry out of the ridden distance", () => {
    const d = data({ gapAtKm: 155, gapType: "ferry" });
    const axis = new TripAxis(d.effort, 0, 300_000, "forward", r, secs, () => 0);
    expect(axis.length).toBeCloseTo(300_000, 0);
  });
});

describe("makePlan", () => {
  it("plans days close to the rider's usual day, with a stop each night", () => {
    const p = makePlan(data(), inputs());
    expect(p.days).toHaveLength(5);
    expect(p.nights).toHaveLength(4);
    expect(p.days.every((d) => d.effort === "within")).toBe(true);
    expect(p.days.map((d) => d.date)).toEqual(["2027-10-13", "2027-10-14", "2027-10-15", "2027-10-16", "2027-10-17"]);
    expect(p.days.reduce((a, d) => a + d.km, 0)).toBeCloseTo(300, 0);
    for (const d of p.days) expect(d.km).toBeGreaterThan(45);
    expect(p.brief.lines.map((l) => l.question)).toEqual([
      "Can I do it?",
      "Where will I sleep?",
      "What could go wrong?",
      "What do I sort out before I go?",
      "What will it be like?",
    ]);
    expect(p.mode).toBe("free");
  });

  it("asks for a call when the days are too few, and offers a day more", () => {
    const p = makePlan(data(), inputs({ days: 3 }));
    expect(p.items.some((i) => i.kind === "call" && i.id.startsWith("effort:beyond:"))).toBe(true);
    expect(p.offers.some((o) => o.days === 4)).toBe(true);
    expect(p.brief.lines[0]!.answer).toMatch(/beyond your level/);
  });

  it("inserts rest days and keeps locked nights", () => {
    const base = makePlan(data(), inputs());
    const lockedId = "s120";
    const p = makePlan(data(), inputs({ restAfter: [2] }), { ...NO_CHOICES, locked: { 1: lockedId } });
    expect(p.days).toHaveLength(6);
    expect(p.days[2]!.kind).toBe("rest");
    expect(p.days[3]!.date).toBe("2027-10-16");
    expect(p.nights[1]!.stop.id).toBe(lockedId);
    expect(base.nights.map((n) => n.stop.id)).not.toContain(undefined);
  });

  it("keeps a locked night with no bed of the rider's kind, and plans the rest around it", () => {
    const stops = Array.from({ length: 29 }, (_, i) =>
      stop((i + 1) * 10, (i + 1) * 10 === 120 ? { beds: [{ kind: "hotel", count: 1, seasons: [["????????????", 1]] }] } : {}),
    );
    const p = makePlan(data({ stops }), inputs({ sleep: "camping" }), { ...NO_CHOICES, locked: { 1: "s120" } });
    expect(p.nights[1]!.stop.id).toBe("s120");
    expect(p.nights.every((n) => !n.stop.id.startsWith("none-"))).toBe(true);
    expect(p.items.some((i) => i.id === "bed:none:1")).toBe(true);
  });

  it("checks beds whose season is unknown, and knows when no bed of the rider's kind exists", () => {
    const rooms = makePlan(data(), inputs({ sleep: "rooms" }));
    expect(rooms.items.filter((i) => i.id.startsWith("bed:check:"))).toHaveLength(4); // hotels publish no dates
    const camping = makePlan(data(), inputs({ sleep: "camping" }));
    expect(camping.items.some((i) => i.id.startsWith("bed:check:"))).toBe(false); // campsites publish theirs
    const noCamps = data({ stops: Array.from({ length: 29 }, (_, i) => stop((i + 1) * 10, { beds: [{ kind: "hotel", count: 1, seasons: [["????????????", 1]] }] })) });
    const p = makePlan(noCamps, inputs({ sleep: "camping" }));
    expect(p.items.some((i) => i.id.startsWith("bed:none:"))).toBe(true);
    expect(bedsFor(stop(10), "camping", 9)).toEqual({ count: 1, open: 1, partly: 0, closed: 0, unknown: 0 });
  });

  it("highlights an unfilled gap and counts it as ridden; a ferry becomes a check (D50)", () => {
    const gap = makePlan(data({ gapAtKm: 155 }), inputs({ toM: 300_000 }));
    expect(gap.items.some((i) => i.id === "gap:155000" && i.kind === "headsup")).toBe(true);
    expect(gap.days.reduce((a, d) => a + d.km, 0)).toBeCloseTo(320, 0);
    const ferry = makePlan(data({ gapAtKm: 155, gapType: "ferry" }), inputs());
    expect(ferry.items.some((i) => i.id === "ferry:155000" && i.kind === "todo")).toBe(true);
  });

  it("flags a day that ends after sunset at the rider's pace", () => {
    const p = makePlan(data(), inputs({ days: 4, startMinutes: 14 * 60 }));
    expect(p.items.some((i) => i.id.startsWith("sunset:"))).toBe(true);
  });

  it("plans the reverse direction from the far end", () => {
    const p = makePlan(data(), inputs({ direction: "reverse" }));
    expect(p.days[0]!.fromM).toBe(300_000);
    expect(p.days[p.days.length - 1]!.toM).toBe(0);
    expect(p.nights.map((n) => n.stop.at_m)).toEqual([...p.nights.map((n) => n.stop.at_m)].sort((a, b) => b - a));
  });

  it("keeps a day's heads-ups and highlights within the attention budget", () => {
    const p = makePlan(data(), inputs());
    for (const d of p.days) {
      const mine = dayItems(p.items, d.number);
      expect(mine.headsups.shown.length).toBeLessThanOrEqual(3);
      expect(mine.highlights.shown.length).toBeLessThanOrEqual(3);
    }
  });
});

describe("plan document and share links", () => {
  it("round-trips a plan through its link, and the nights stay put", () => {
    const d = data();
    const p = makePlan(d, inputs());
    const doc = toDocument(p, { name: "Lagoons → Arles" });
    const frag = shareFragment(doc);
    expect(frag.startsWith("p=")).toBe(true);
    const read = readFragment(`#${frag}`);
    expect(read && "plan" in read).toBe(true);
    const back = (read as { plan: typeof doc }).plan;
    expect(back.name).toBe("Lagoons → Arles");
    const again = makePlan(d, back.inputs, choicesOf(back));
    expect(again.nights.map((n) => n.stop.id)).toEqual(p.nights.map((n) => n.stop.id));
    expect(frag.length).toBeLessThan(2500); // small enough for a QR code
  });

  it("shares an itinerary with dates and stops only", () => {
    const p = makePlan(data(), inputs());
    const read = readFragment(shareFragment(itineraryOf(p)));
    expect(read && "itinerary" in read && read.itinerary.days).toHaveLength(5);
    expect(JSON.stringify(read)).not.toContain("level");
  });

  it("rejects damaged links and foreign documents", () => {
    expect(readFragment("#p=!!!")).toBeNull();
    expect(readFragment("#p=e30")).toEqual({ error: "not a Kilometrica plan" }); // "{}"
    expect(parseDocument({ kind: "kilometrica-plan", version: 9 })).toMatch(/version/);
    expect(fromUtf8(utf8("Étang → Aigues-Mortes 🚲"))).toBe("Étang → Aigues-Mortes 🚲");
  });
});

describe("exports", () => {
  const d = data({ gapAtKm: 155 });
  const geo: Geometry = {
    lines: [
      { coords: Array.from({ length: 156 }, (_, i) => [i * 1000 * DEG_PER_M, LAT] as [number, number]), m: Array.from({ length: 156 }, (_, i) => i * 1000) },
      { coords: Array.from({ length: 146 }, (_, i) => [(155 + 20 + i) * 1000 * DEG_PER_M, LAT] as [number, number]), m: Array.from({ length: 146 }, (_, i) => 155_000 + i * 1000) },
    ],
    gaps: [{ atM: 155_000, type: "missing", km: 20, start: [155_000 * DEG_PER_M, LAT], end: [175_000 * DEG_PER_M, LAT] }],
  };
  it("writes a starter GPX per day with the gap marked at both ends (D47)", () => {
    const p = makePlan(d, inputs());
    const withGap = p.days.find((x) => x.gaps.length)!;
    const gpx = dayGpx(p, geo, withGap);
    expect(gpx).toContain("<trkpt");
    expect(gpx).toContain("Gap start: 20 km");
    expect(gpx).toContain("Gap end");
    expect((gpx.match(/<trkseg>/g) ?? []).length).toBe(2);
    expect(tripGpx(p, geo)).toContain(`<name>Day ${p.days.length}:`);
  });

  it("writes one calendar event per day", () => {
    const p = makePlan(d, inputs({ restAfter: [2] }));
    const ics = calendarFile(p, "abc", new Date("2027-01-01T00:00:00Z"));
    expect((ics.match(/BEGIN:VEVENT/g) ?? []).length).toBe(6);
    expect(ics).toContain("DTSTART;VALUE=DATE:20271013");
    expect(ics).toContain("rest day");
    const bytes = (l: string) => [...l].reduce((a, ch) => a + (ch.codePointAt(0)! < 0x80 ? 1 : ch.codePointAt(0)! < 0x800 ? 2 : 3), 0);
    expect(ics.split("\r\n").every((l) => bytes(l) <= 75)).toBe(true);
  });
});
