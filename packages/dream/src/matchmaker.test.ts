import type { DreamFile, DreamSection } from "@dpg/contracts";
import { describe, expect, it } from "vitest";
import { type DreamQuery, findStretches, gradeFor } from "./matchmaker";

const LEVELS = [
  { level: 1, name: "Leisurely", km_min: 20, km_max: 40, climb_max_m: 300 },
  { level: 2, name: "Easy-moderate", km_min: 40, km_max: 60, climb_max_m: 500 },
  { level: 3, name: "Moderate", km_min: 50, km_max: 80, climb_max_m: 850 },
  { level: 4, name: "Challenging", km_min: 70, km_max: 100, climb_max_m: 1200 },
  { level: 5, name: "Tough", km_min: 90, km_max: 130, climb_max_m: 1500 },
];
const twelve = <T>(v: T) => Array.from({ length: 12 }, () => v);

function section(n: number, over: Partial<DreamSection> = {}): DreamSection {
  return {
    number: n,
    from_m: (n - 1) * 50_000,
    to_m: n * 50_000,
    length_m: 50_000,
    country: "XX",
    ascent_fwd_m: 300,
    ascent_rev_m: 300,
    max_grade_500m: 4,
    grade_fwd: 2,
    grade_rev: 2,
    surfaces: { road: 0.5, cycle_path: 0.5, gravel: 0, unknown: 0 },
    busy_share: 0,
    themes: { coast: { score: n <= 3 ? 0.9 : 0.1, note: "" }, wine: { score: 0.2, note: "" } },
    remote_share: 0,
    longest_remote_m: 0,
    climate: null,
    daylight_h: twelve(12),
    crowding: { country: "XX", school_days: twelve(null), school_year: null, public_holidays: twelve(null), tourism_index: twelve(null), tourism_years: null },
    campsites: { counted: 1, published: 0, open: twelve(0), partly: twelve(0) },
    accommodation: { campsite: 1, hostel: 0, hotel: 2 },
    services: {},
    longest_gap_m: {},
    station_start: `station ${n}a`,
    station_end: `station ${n}b`,
    findings: {},
    comfort: twelve(60),
    best_time: Array.from({ length: 12 }, (_, m) => (m === 9 ? 80 : 50)),
    partial: twelve([]),
    direction: twelve({ advice: "either", wind_along_ms: 0, climb_diff_m: 0 }),
    check: [],
    ...over,
  } as DreamSection;
}

function dream(sections: DreamSection[], breaks: DreamFile["breaks"] = []): DreamFile {
  return {
    profile: "dream-v0",
    season_year: 2027,
    climate_source: "test",
    levels: LEVELS,
    themes: [
      { id: "coast", title: "Coast & beaches", measures: "" },
      { id: "wine", title: "Vineyards & wine", measures: "" },
    ],
    sections,
    breaks,
  };
}

const base: DreamQuery = {
  level: 3,
  days: 4,
  month: 9,
  surfaces: { road: "ok", cycle_path: "prefer", gravel: "avoid" },
  themes: [],
  trainBothEnds: false,
  stay: "any",
  avoidBusy: false,
  direction: "forward",
};

describe("gradeFor", () => {
  it("picks the lowest level covering distance and climbing", () => {
    expect(gradeFor(LEVELS, 55, 200)).toBe(2);
    expect(gradeFor(LEVELS, 55, 700)).toBe(3);
    expect(gradeFor(LEVELS, 140, 100)).toBe(5);
  });
});

describe("findStretches", () => {
  const ten = Array.from({ length: 10 }, (_, i) => section(i + 1));

  it("returns stretches that fit the level and never cross a hard break", () => {
    const d = dream(ten, [{ after_section: 5, type: "missing", straight_distance_m: 30_000, hard: true }]);
    const results = findStretches(d, base);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.kmPerDay).toBeGreaterThanOrEqual(35);
      expect(r.kmPerDay).toBeLessThanOrEqual(88);
      expect(r.first <= 5 && r.last >= 6).toBe(false);
    }
  });

  it("favours the chosen themes", () => {
    const [top] = findStretches(dream(ten), { ...base, themes: ["coast"] });
    expect(top?.first).toBe(1);
    expect(top?.why.some((w) => w.includes("Coast"))).toBe(true);
  });

  it("filters on train at both ends and busy roads", () => {
    const noStation = ten.map((s) => (s.number <= 4 ? section(s.number, { station_start: null, station_end: null }) : s));
    expect(findStretches(dream(noStation), { ...base, trainBothEnds: true }).every((r) => r.first > 4)).toBe(true);
    const busy = ten.map((s) => section(s.number, { busy_share: s.number <= 6 ? 0.5 : 0 }));
    const calm = findStretches(dream(busy), { ...base, avoidBusy: true });
    expect(calm.length).toBeGreaterThan(0);
    expect(calm.every((r) => r.busyShare <= 0.15)).toBe(true);
  });

  it("picks the best month when none is given", () => {
    const [top] = findStretches(dream(ten), { ...base, month: null });
    expect(top?.month).toBe(9);
  });

  it("does not rank down missing data, but lists it to check", () => {
    const gaps = ten.map((s) =>
      section(s.number, { partial: twelve(["school holidays"]), check: ["School holidays: no data."] }),
    );
    const [withGaps] = findStretches(dream(gaps), base);
    const [complete] = findStretches(dream(ten), base);
    expect(withGaps?.score).toBeCloseTo(complete!.score, 6);
    expect(withGaps?.check.some((c) => c.includes("school holidays"))).toBe(true);
    expect(complete?.check).toEqual([]);
  });

  it("skips unknown theme data instead of scoring it as 0, and lists it to check", () => {
    const unknown = ten.map((s) => section(s.number, { themes: { ...s.themes, wine: { score: null, note: "unknown" } } }));
    const [top] = findStretches(dream(unknown), { ...base, themes: ["coast", "wine"] });
    const [coastOnly] = findStretches(dream(ten), { ...base, themes: ["coast"] });
    expect(top?.score).toBeCloseTo(coastOnly!.score, 6);
    expect(top?.check).toContain(`Vineyards & wine: no data for ${top?.km} km of this stretch: judge it yourself.`);
  });

  it("evaluates the reverse direction with the reverse climbing", () => {
    const hilly = ten.map((s) => section(s.number, { ascent_fwd_m: 1500, ascent_rev_m: 200 }));
    expect(findStretches(dream(hilly), { ...base, days: 4, direction: "forward" })).toHaveLength(0);
    expect(findStretches(dream(hilly), { ...base, days: 4, direction: "reverse" }).length).toBeGreaterThan(0);
  });
});

describe("mergeChecks", () => {
  it("sums opening-season gaps across sections and drops duplicates", async () => {
    const { mergeChecks } = await import("./matchmaker");
    expect(
      mergeChecks([
        "3 of 5 places to stay publish no opening season: check dates ahead.",
        "School holidays: no data.",
        "4 of 4 places to stay publish no opening season: check dates ahead.",
        "School holidays: no data.",
      ]),
    ).toEqual(["7 of 9 places to stay publish no opening season: check dates ahead.", "School holidays: no data."]);
  });
});
