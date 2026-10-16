/**
 * Dream tab (M3, DESIGN.md 11.4): a trip finder (matchmaker), its results, a best-time heatmap of sections against
 * months, and a reality-check card. Everything comes from the route's dream.json, which is free (D35).
 */
import type { DailySection, DreamFile, DreamSection } from "@dpg/contracts";
import {
  climbOf,
  type DreamQuery,
  findStretches,
  mergeChecks,
  MONTH_NAMES,
  type Pref,
  type StretchResult,
  type SurfaceKind,
} from "@dpg/dream";
import { useMemo, useState } from "react";
import { km } from "./status";

type Metric = "best" | "comfort" | "tmax" | "rain" | "daylight" | "wind" | "tourism" | "school" | "camps";

const METRICS: Record<Metric, string> = {
  best: "Best time",
  comfort: "Comfort",
  tmax: "Daytime high (°C)",
  rain: "Rain days",
  daylight: "Daylight (h)",
  wind: "Wind riding forward",
  tourism: "Tourism (how busy)",
  school: "School holidays",
  camps: "Campsites open (of those publishing)",
};

const SURFACES: { key: SurfaceKind; label: string }[] = [
  { key: "road", label: "Road" },
  { key: "cycle_path", label: "Cycle paths" },
  { key: "gravel", label: "Gravel" },
];

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "–" : `${Math.round(x * 100)}%`);

function cellValue(s: DreamSection, metric: Metric, m: number): number | null {
  const c = s.climate;
  switch (metric) {
    case "best":
      return s.best_time[m] ?? null;
    case "comfort":
      return s.comfort[m] ?? null;
    case "tmax":
      return c?.tmax_c[m] ?? null;
    case "rain":
      return c?.rain_days[m] ?? null;
    case "daylight":
      return s.daylight_h[m] ?? null;
    case "wind":
      return c?.wind_along_ms[m] ?? null;
    case "tourism": {
      const peak = Math.max(...s.crowding.tourism_index.filter((v): v is number => v !== null));
      const v = s.crowding.tourism_index[m];
      return v === null || v === undefined || !Number.isFinite(peak) ? null : v / peak;
    }
    case "school":
      return s.crowding.school_days[m] ?? null;
    case "camps": {
      const pub = s.campsites.published;
      return pub ? ((s.campsites.open[m] ?? 0) + 0.5 * (s.campsites.partly[m] ?? 0)) / pub : null;
    }
  }
}

function mix(a: [number, number, number], b: [number, number, number], t: number): string {
  const c = a.map((x, i) => Math.round(x + (b[i]! - x) * Math.min(1, Math.max(0, t))));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

const RED: [number, number, number] = [215, 48, 31];
const YELLOW: [number, number, number] = [254, 224, 139];
const GREEN: [number, number, number] = [26, 152, 80];
const WHITE: [number, number, number] = [247, 247, 247];
const BLUE: [number, number, number] = [33, 113, 181];
const ORANGE: [number, number, number] = [230, 85, 13];
const PURPLE: [number, number, number] = [118, 42, 131];

function colour(metric: Metric, v: number): string {
  switch (metric) {
    case "best":
    case "comfort":
      return v < 50 ? mix(RED, YELLOW, v / 50) : mix(YELLOW, GREEN, (v - 50) / 50);
    case "tmax":
      return v < 18 ? mix(BLUE, WHITE, (v - 5) / 13) : v <= 26 ? mix(WHITE, GREEN, 0.5) : mix(YELLOW, RED, (v - 26) / 10);
    case "rain":
      return mix(WHITE, BLUE, v / 0.5);
    case "daylight":
      return mix([60, 60, 90], YELLOW, (v - 8) / 7);
    case "wind":
      return v < 0 ? mix(WHITE, PURPLE, -v / 3) : mix(WHITE, GREEN, v / 3);
    case "tourism":
    case "school":
      return mix(WHITE, ORANGE, v);
    case "camps":
      return mix(RED, GREEN, v);
  }
}

function format(metric: Metric, v: number | null): string {
  if (v === null) return "no data";
  switch (metric) {
    case "best":
    case "comfort":
      return String(Math.round(v));
    case "tmax":
      return `${v.toFixed(0)} °C`;
    case "daylight":
      return `${v.toFixed(1)} h`;
    case "wind":
      return `${v >= 0 ? "tailwind" : "headwind"} ${Math.abs(v).toFixed(1)} m/s`;
    default:
      return pct(v);
  }
}

function stretchName(daily: Map<number, DailySection>, first: number, last: number, way: "forward" | "reverse") {
  const a = daily.get(first);
  const b = daily.get(last);
  const from = way === "forward" ? a?.start_name : b?.end_name;
  const to = way === "forward" ? b?.end_name : a?.start_name;
  return `${from ?? `section ${first}`} → ${to ?? `section ${last}`}`;
}

/** Facts for one section or a stretch; ends with what the rider should check themselves (D37). */
function RealityCard({
  dream,
  daily,
  sections,
  way,
  month,
  result,
}: {
  dream: DreamFile;
  daily: Map<number, DailySection>;
  sections: DreamSection[];
  way: "forward" | "reverse";
  month: number | null;
  result: StretchResult | null;
}) {
  if (!sections.length) return null;
  const first = sections[0]!;
  const last = sections[sections.length - 1]!;
  const lengthM = sections.reduce((a, s) => a + s.length_m, 0);
  const w = (f: (s: DreamSection) => number | null | undefined) => {
    let sum = 0;
    let len = 0;
    for (const s of sections) {
      const v = f(s);
      if (v === null || v === undefined) continue;
      sum += v * s.length_m;
      len += s.length_m;
    }
    return len ? sum / len : null;
  };
  const m = month ?? result?.month ?? null;
  // Climbing that is partly unknown (placeholder track) is shown as a minimum, never as the whole (D37).
  const climb = climbOf(sections, way);
  const partly = climb.unknownM > 0;
  const steeps = sections.flatMap((s) => (s.max_grade_500m === null ? [] : [s.max_grade_500m]));
  const steep = steeps.length ? Math.max(...steeps) : null;
  const surf = { road: w((s) => s.surfaces.road), cycle_path: w((s) => s.surfaces.cycle_path), gravel: w((s) => s.surfaces.gravel), unknown: w((s) => s.surfaces.unknown) };
  const titles = Object.fromEntries(dream.themes.map((t) => [t.id, t.title]));
  const themes = Object.keys(first.themes)
    .map((id) => ({ id, score: w((s) => s.themes[id]?.score) }))
    .filter((t): t is { id: string; score: number } => t.score !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const sum = (f: (s: DreamSection) => number) => sections.reduce((a, s) => a + f(s), 0);
  const findings = sum((s) => Object.values(s.findings).reduce((a, n) => a + n, 0));
  const warnings = sum((s) => (s.findings.warning ?? 0) + (s.findings.blocker ?? 0));
  const checks = mergeChecks(sections.flatMap((s) => s.check).concat((result?.check ?? []).filter((c) => !c.includes("publish no opening season"))));
  const stationA = way === "forward" ? first.station_start : last.station_end;
  const stationB = way === "forward" ? last.station_end : first.station_start;
  const single = sections.length === 1 ? first : null;
  const dir = single && m !== null ? single.direction[m] : null;
  const c = single?.climate;

  return (
    <div className="reality">
      <div className="reality-title">
        {single ? `Section ${single.number}: ${daily.get(single.number)?.title ?? ""}` : `Sections ${first.number}–${last.number}: ${stretchName(daily, first.number, last.number, way)}`}
      </div>
      <div className="reality-grid">
        <span>Distance</span>
        <b>{km(lengthM, 1)} km{result ? ` · ${result.days} days · ${result.kmPerDay} km/day` : ""}</b>
        <span>Climbing</span>
        <b>
          {climb.metres === null ? "unknown" : `${partly ? "at least " : ""}${Math.round(climb.metres).toLocaleString("en-GB")} m`}
          {partly && climb.metres !== null ? ` (unknown for ${km(climb.unknownM, 1)} km)` : ""}
          {result?.climbPerDay != null ? ` · ${result.climbPerDay} m/day` : result?.climbMinPerDay != null ? ` · at least ${result.climbMinPerDay} m/day` : ""}
          {" · steepest 500 m "}
          {steep === null ? "unknown" : `${steep.toFixed(0)}%${partly ? " where the terrain is known" : ""}`}
        </b>
        <span>Grade</span>
        <b>
          {result
            ? `${result.gradeAtLeast ? "at least " : ""}${result.grade} ${dream.levels.find((l) => l.level === result.grade)?.name ?? ""}`
            : single
              ? `${partly ? "at least " : ""}${single.grade_fwd ?? "–"} forward / ${single.grade_rev ?? "–"} reverse (as one day)`
              : "–"}
          {partly ? (climb.metres === null ? " · from distance only: climbing unknown" : " · climbing partly unknown") : ""}
        </b>
        <span>Surfaces</span>
        <b>
          road {pct(surf.road)} · cycle paths {pct(surf.cycle_path)} · gravel {pct(surf.gravel)}
          {(surf.unknown ?? 0) > 0.02 ? ` · unknown ${pct(surf.unknown)}` : ""}
        </b>
        <span>Busy roads</span>
        <b>{km((w((s) => s.busy_share) ?? 0) * lengthM, 0)} km</b>
        <span>Scenery</span>
        <b>{themes.map((t) => `${titles[t.id] ?? t.id} ${Math.round(t.score * 100)}`).join(" · ")}</b>
        {m !== null && (
          <>
            <span>{MONTH_NAMES[m]}</span>
            <b>
              comfort {format("comfort", w((s) => s.comfort[m]))} · best time {format("best", w((s) => s.best_time[m]))}
              {c ? ` · ${c.tmax_c[m]?.toFixed(0) ?? "–"}/${c.tmin_c[m]?.toFixed(0) ?? "–"} °C · rain days ${pct(c.rain_days[m])}` : ""}
              {single ? ` · daylight ${single.daylight_h[m]?.toFixed(1)} h` : ""}
            </b>
          </>
        )}
        {dir && (
          <>
            <span>Direction</span>
            <b>
              {dir.advice === "either" ? "either way" : dir.advice === "unknown" ? "unknown" : `ride ${dir.advice === "forward" ? "with" : "against"} the route`}
              {dir.wind_along_ms !== null ? ` · wind ${format("wind", dir.wind_along_ms)}` : ""}{dir.climb_diff_m !== null ? ` · climbing difference ${dir.climb_diff_m} m` : " · climbing difference unknown"}
            </b>
          </>
        )}
        <span>Places to stay</span>
        <b>
          {sum((s) => s.accommodation.campsite ?? 0)} campsites · {sum((s) => s.accommodation.hostel ?? 0)} hostels · {sum((s) => s.accommodation.hotel ?? 0)} hotels/B&Bs
        </b>
        <span>Stations</span>
        <b>
          start: {stationA ?? "none found"} · end: {stationB ?? "none found"}
        </b>
      </div>
      {single && (
        <div className="reality-notes">
          {Object.entries(single.themes)
            .filter(([, t]) => t.score === null || t.score >= 0.3)
            .map(([id, t]) => (
              <div key={id}>
                {titles[id]}: {t.note}
              </div>
            ))}
        </div>
      )}
      {checks.length > 0 && (
        <div className="reality-check">
          <div className="reality-sub">Check yourself</div>
          <ul>
            {checks.slice(0, 8).map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="teaser">
        {findings} audit findings here{warnings ? ` (${warnings} warnings)` : ""}, plus places, the Ahead list and GPX: the full detail comes with a Trip Pass.
      </div>
    </div>
  );
}

export function Dream({
  dream,
  daily,
  month,
  onMonth,
  selectedSection,
  onSelectSection,
  result,
  onResult,
}: {
  dream: DreamFile;
  daily: DailySection[];
  month: number | null;
  onMonth: (m: number | null) => void;
  selectedSection: number | null;
  onSelectSection: (n: number | null) => void;
  result: StretchResult | null;
  onResult: (r: StretchResult | null) => void;
}) {
  const [query, setQuery] = useState<Omit<DreamQuery, "month">>({
    level: 3,
    days: 7,
    surfaces: { road: "ok", cycle_path: "prefer", gravel: "ok" },
    themes: [],
    trainBothEnds: false,
    stay: "any",
    avoidBusy: false,
    direction: "either",
  });
  const [metric, setMetric] = useState<Metric>("best");
  const byNumber = useMemo(() => new Map(daily.map((d) => [d.number, d])), [daily]);
  const sections = useMemo(() => [...dream.sections].sort((a, b) => a.from_m - b.from_m), [dream]);
  const results = useMemo(() => findStretches(dream, { ...query, month }), [dream, query, month]);
  const set = <K extends keyof typeof query>(k: K, v: (typeof query)[K]) => setQuery((q) => ({ ...q, [k]: v }));
  const level = dream.levels.find((l) => l.level === query.level);

  const shown = result
    ? sections.filter((s) => s.number >= result.first && s.number <= result.last)
    : sections.filter((s) => s.number === selectedSection);

  return (
    <div className="dream">
      {shown.length > 0 && (
        <RealityCard dream={dream} daily={byNumber} sections={shown} way={result?.way ?? "forward"} month={month} result={result} />
      )}

      <details className="dream-block" open>
        <summary>Find a trip</summary>
        <div className="dream-form">
          <label>
            Level
            <select value={query.level} onChange={(e) => set("level", Number(e.target.value))}>
              {dream.levels.map((l) => (
                <option key={l.level} value={l.level}>
                  {l.level} {l.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Days
            <input type="number" min={1} max={40} value={query.days} onChange={(e) => set("days", Math.max(1, Number(e.target.value) || 1))} />
          </label>
          <label>
            Month
            <select value={month ?? ""} onChange={(e) => onMonth(e.target.value === "" ? null : Number(e.target.value))}>
              <option value="">best for each</option>
              {MONTH_NAMES.map((n, i) => (
                <option key={n} value={i}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label>
            Direction
            <select value={query.direction} onChange={(e) => set("direction", e.target.value as DreamQuery["direction"])}>
              <option value="either">either</option>
              <option value="forward">with the route</option>
              <option value="reverse">against it</option>
            </select>
          </label>
        </div>
        {level && (
          <div className="muted dream-hint">
            {level.name}: {level.km_min}–{level.km_max} km a day with luggage, up to ~{level.climb_max_m} m climbing.
          </div>
        )}
        <div className="dream-surfaces">
          {SURFACES.map(({ key, label }) => (
            <div key={key} className="seg">
              <span>{label}</span>
              {(["prefer", "ok", "avoid"] as Pref[]).map((p) => (
                <button
                  key={p}
                  className={query.surfaces[key] === p ? "on" : ""}
                  onClick={() => set("surfaces", { ...query.surfaces, [key]: p })}
                >
                  {p === "ok" ? "OK" : p}
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="dream-themes">
          {dream.themes.map((t) => (
            <button
              key={t.id}
              title={t.measures}
              className={query.themes.includes(t.id) ? "on" : ""}
              onClick={() => set("themes", query.themes.includes(t.id) ? query.themes.filter((x) => x !== t.id) : [...query.themes, t.id])}
            >
              {t.title}
            </button>
          ))}
        </div>
        <div className="dream-needs">
          <label>
            <input type="checkbox" checked={query.trainBothEnds} onChange={(e) => set("trainBothEnds", e.target.checked)} />
            train at both ends
          </label>
          <label>
            <input type="checkbox" checked={query.avoidBusy} onChange={(e) => set("avoidBusy", e.target.checked)} />
            avoid busy roads
          </label>
          <label>
            stay
            <select value={query.stay} onChange={(e) => set("stay", e.target.value as DreamQuery["stay"])}>
              <option value="any">anywhere</option>
              <option value="camping">camping</option>
              <option value="rooms">rooms</option>
            </select>
          </label>
        </div>
      </details>

      <details className="dream-block" open>
        <summary>
          Stretches that fit <span className="count">{results.length}</span>
        </summary>
        {results.length === 0 && <div className="muted pad">Nothing fits: try more days, another level or fewer needs.</div>}
        {results.map((r) => {
          const on = result?.first === r.first && result?.last === r.last && result?.way === r.way;
          return (
            <button key={`${r.first}-${r.last}-${r.way}`} className={`stretch${on ? " selected" : ""}`} onClick={() => onResult(on ? null : r)}>
              <span className="stretch-title">{stretchName(byNumber, r.first, r.last, r.way)}</span>
              <span className="stretch-sub">
                sections {r.first}–{r.last} · {r.km} km · {r.kmPerDay} km/day
                {r.climbPerDay !== null ? ` · ↑ ${r.climbPerDay} m/day` : r.climbMinPerDay !== null ? ` · ↑ ≥ ${r.climbMinPerDay} m/day` : ""} · grade{" "}
                {r.gradeAtLeast ? "≥ " : ""}
                {r.grade}
                {r.month !== null ? ` · ${MONTH_NAMES[r.month]} ${r.bestTime ?? "–"}` : ""}
              </span>
              {on && (
                <span className="stretch-detail">
                  {r.why.map((w) => (
                    <span key={w} className="why">
                      ✓ {w}
                    </span>
                  ))}
                  {r.watch.map((w) => (
                    <span key={w} className="watch">
                      ⚠ {w}
                    </span>
                  ))}
                  {r.check.length > 0 && <span className="check">? {r.check.length} thing(s) to check yourself (see the card above)</span>}
                </span>
              )}
            </button>
          );
        })}
      </details>

      <details className="dream-block" open>
        <summary>Best time</summary>
        <select className="dream-metric" value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
          {(Object.keys(METRICS) as Metric[]).map((k) => (
            <option key={k} value={k}>
              {METRICS[k]}
            </option>
          ))}
        </select>
        <div className="heatmap" role="grid" aria-label={`${METRICS[metric]} by section and month`}>
          <div className="hm-row hm-head">
            <span />
            {MONTH_NAMES.map((n, i) => (
              <span key={n} className={month === i ? "on" : ""} onClick={() => onMonth(month === i ? null : i)}>
                {n[0]}
              </span>
            ))}
          </div>
          {sections.map((s) => {
            const inStretch = result && s.number >= result.first && s.number <= result.last;
            return (
              <div key={s.number} className={`hm-row${s.number === selectedSection || inStretch ? " on" : ""}`}>
                <span className="hm-label" title={byNumber.get(s.number)?.title} onClick={() => onSelectSection(s.number)}>
                  {s.number}
                </span>
                {MONTH_NAMES.map((n, m) => {
                  const v = cellValue(s, metric, m);
                  const partial = (metric === "best" && (s.partial[m]?.length ?? 0) > 0) || (metric !== "best" && v === null);
                  return (
                    <span
                      key={n}
                      className={`hm-cell${v === null ? " none" : ""}${partial && v !== null ? " partial" : ""}${month === m ? " col" : ""}`}
                      style={v === null ? undefined : { background: colour(metric, v) }}
                      title={`Section ${s.number}, ${n}: ${format(metric, v)}${metric === "best" && s.partial[m]?.length ? ` (partial: no data for ${s.partial[m]!.join(", ")})` : ""}`}
                      onClick={() => {
                        onResult(null);
                        onSelectSection(s.number);
                        onMonth(m);
                      }}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="muted legend-note">
          {dream.climate_source}. Grey: no data. Dotted: the best-time score leaves out an input with no data (hover to see which).
        </div>
      </details>
    </div>
  );
}
