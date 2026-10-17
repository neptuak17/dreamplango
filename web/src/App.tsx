import type {
  DailySection,
  Finding,
  Place,
  SectionScores,
  SectionServices,
  ServicesFile,
  Severity,
  StretchStats,
} from "@dpg/contracts";
import { useEffect, useMemo, useState } from "react";
import { listingOf, listRoutes, loadBundle, loadManifest, loadPlaces, type RouteBundle, type RouteListing } from "./api";
import {
  ECS_LABELS,
  LAYER_TITLES,
  type LayerKey,
  overlayGeoJSON,
  PALETTES,
  Slicer,
  type Stretch,
  stretchesFor,
} from "./layers";
import { RouteMap } from "./RouteMap";
import {
  aheadByService,
  DEFAULT_FILTERS,
  type Density,
  DENSITY_LABELS,
  distanceLabel,
  filterKey,
  GAP_LABELS,
  GAP_PALETTE,
  GAP_ROWS,
  gapStretches,
  MAP_FILTERS,
  MONTHS,
  monthState,
  SERVICE_STYLE,
  spacingFor,
  thin,
} from "./services";
import { climbText, DEVELOPMENT, km, SEVERITY, SIGNAGE, unknownNote } from "./status";
import { Track, type StripRow } from "./Track";
import { Dream } from "./Dream";
import type { StretchResult } from "@dpg/dream";

type Tab = "sections" | "findings" | "ahead" | "dream";
type AuditLayer = Exclude<LayerKey, "status">;
type Detour = "counting" | number;
const AUDIT_LAYERS: AuditLayer[] = ["ecs", "infrastructure", "traffic_stress", "surface", "cycle_network", "gradient"];
const DETOURS: Detour[] = ["counting", 500, 1000, 2000, 5000, 10000, 20000];
const WINDOWS_KM = [25, 50, 100, 200];
const GAP_SERVICES = ["water", "food", "accommodation", "bike_shop", "station"];
const COLLAPSE_KEY = "dpg.summaryCollapsed";
const pct = (x: number | undefined) => `${Math.round((x ?? 0) * 100)}%`;

function readHashSection(): number | null {
  const match = /section=(\d+)/.exec(window.location.hash);
  return match ? Number(match[1]) : null;
}

/** `?route=<network>/<ref>`: the route to open, e.g. a private one printed by `npm run audit:file`. */
function readRouteParam(): string | null {
  const v = new URLSearchParams(window.location.search).get("route");
  return v && /^[a-z0-9-]+\/[a-z0-9-]+$/i.test(v) ? v.toLowerCase() : null;
}

const routeKey = (r: { network: string; ref: string }) => `${r.network}/${r.ref.toLowerCase()}`;

// Private routes opened in this browser, for the route switcher. The API never lists them (D25); this list stays on
// this device and is only a convenience, so a missing or blocked storage simply means an empty list.
const PRIVATE_KEY = "dpg.privateRoutes";
function readPrivate(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(PRIVATE_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function writePrivate(keys: string[]) {
  try {
    localStorage.setItem(PRIVATE_KEY, JSON.stringify([...new Set(keys)]));
  } catch {
    /* storage unavailable: the switcher just won't remember */
  }
}

async function loadRoutes(): Promise<{ routes: RouteListing[]; wanted: string | null }> {
  const wanted = readRouteParam();
  const routes = await listRoutes();
  const remembered = readPrivate();
  const keep: string[] = [];
  for (const key of new Set([...remembered, ...(wanted ? [wanted] : [])])) {
    if (routes.some((r) => routeKey(r.route) === key)) continue;
    const [network = "", ref = ""] = key.split("/");
    const manifest = await loadManifest(network, ref).catch(() => null);
    if (!manifest) continue; // forgotten (npm run forget) or never existed
    if (manifest.visibility === "private") keep.push(key);
    routes.push(listingOf(manifest));
  }
  writePrivate(keep);
  return { routes, wanted };
}

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Range findings belong to every section they overlap; point findings to the section starting at or before them. */
function inSection(f: Finding, d: DailySection, isLast: boolean): boolean {
  if (f.to_m > f.from_m) return f.from_m < d.to_m && f.to_m > d.from_m;
  return f.from_m >= d.from_m && (f.from_m < d.to_m || (isLast && f.from_m <= d.to_m));
}

function worst(findings: Finding[]): Severity {
  return findings.reduce<Severity>(
    (acc, f) => (SEVERITY[f.severity].rank < SEVERITY[acc].rank ? f.severity : acc),
    "info",
  );
}

function shareOf(stretches: Stretch[], m0: number, m1: number): Record<string, number> {
  const out: Record<string, number> = {};
  const total = Math.max(m1 - m0, 1);
  for (const s of stretches) {
    const overlap = Math.min(s.to_m, m1) - Math.max(s.from_m, m0);
    if (overlap > 0) out[s.value] = (out[s.value] ?? 0) + overlap / total;
  }
  return out;
}

function StatusDot({ section }: { section: Pick<DailySection, "status"> }) {
  const dev = DEVELOPMENT[section.status.development];
  const signed = section.status.signage === "signed";
  return (
    <span
      className={`status-dot${signed ? "" : " unsigned"}`}
      style={{ "--c": dev.color } as React.CSSProperties}
      title={section.status.label}
    />
  );
}

function Swatch({ color }: { color: string }) {
  return <span className="swatch" style={{ "--c": color } as React.CSSProperties} />;
}

function Dot({ service }: { service: string }) {
  return <span className="svc-dot" style={{ "--c": SERVICE_STYLE[service]?.color ?? "#495057" } as React.CSSProperties} />;
}

function Kpi({ value, label, title, over }: { value: React.ReactNode; label: React.ReactNode; title: string; over?: boolean }) {
  return (
    <div className="kpi" title={title}>
      <b className={over ? "over" : ""}>{value}</b>
      <span>{label}</span>
    </div>
  );
}

/**
 * The selection's figures in two tight rows: infrastructure, then the longest stretch without each service.
 * Explanations live in the tooltips.
 */
function KpiBand({
  title,
  stats,
  services,
  sectionServices,
  month,
}: {
  title: string;
  stats: StretchStats | null;
  services: ServicesFile | null;
  sectionServices: SectionServices | null;
  month: number | null;
}) {
  const lts = stats?.shares.traffic_stress ?? {};
  const surf = stats?.shares.surface ?? {};
  const infra = stats?.shares.infrastructure ?? {};
  const carFree = (infra.cycleway ?? 0) + (infra.shared_path ?? 0) + (infra.separated_track ?? 0);
  const gaps = sectionServices ? sectionServices.longest_gap_m : services?.route_longest_gap_m;
  const types = Object.fromEntries((services?.types ?? []).map((t) => [t.id, t]));
  const pick = (v: number[] | undefined) => (v ? (month === null ? Math.max(...v) : (v[month] ?? 0)) : 0);
  return (
    <div className="kpi-band">
      <div className="kpi-title">{title}</div>
      {stats && (
        <div className="kpi-row">
          <Kpi value={pct(stats.essential_pass)} label="essential" title="Share of length meeting all essential criteria (indicative ECS-style check)" />
          <Kpi value={pct(stats.important_pass)} label="important" title="Share of length meeting all important criteria" />
          <Kpi value={pct(carFree)} label="car-free" title="Cycle paths, shared paths and separated tracks" />
          <Kpi value={pct(lts["4"])} label="busy roads" title="Busy roads: traffic stress (LTS) 4" />
          <Kpi value={pct((surf.gravel ?? 0) + (surf.dirt ?? 0))} label="unpaved" title="Loose gravel, dirt or sand" />
          <Kpi
            value={climbText(stats.ascent_m, stats.climb_unknown_m)}
            label="climbing"
            title={
              stats.climb_unknown_m
                ? `Total climbing from the smoothed terrain model: a minimum, because the terrain under ${(stats.climb_unknown_m / 1000).toFixed(1)} km of straight-line placeholder is unknown`
                : "Total climbing from the smoothed terrain model"
            }
          />
        </div>
      )}
      {services && gaps && (
        <>
          <div className="kpi-subtitle">
            Longest stretch without {month === null ? "(worst month)" : `(${MONTHS[month]})`}
          </div>
          <div className="kpi-row">
            {GAP_SERVICES.map((s) => {
              const t = types[s];
              const value = pick(gaps[s]);
              const how = t ? `counts within ${distanceLabel(t.count_m)}${t.count_min ? ` / ${t.count_min} min` : ""} by bike` : "";
              return (
                <Kpi
                  key={s}
                  value={`${km(value)} km`}
                  label={
                    <>
                      <Dot service={s} /> {s === "water" ? "water" : s === "bike_shop" ? "bikes" : SERVICE_STYLE[s]?.short}
                    </>
                  }
                  title={`${t?.title ?? s}: ${how}${t?.gap_m ? `; finding above ${km(t.gap_m)} km` : ""}${s === "water" ? ". Shops and cafés count too." : ""}`}
                  over={t?.gap_m != null && value > t.gap_m}
                />
              );
            })}
            {sectionServices && (
              <Kpi value={sectionServices.counts.accommodation ?? 0} label="beds here" title="Accommodation that counts on this daily section" />
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function App() {
  const [routes, setRoutes] = useState<RouteListing[] | null>(null);
  const [routeId, setRouteId] = useState<string | null>(null);
  const [bundle, setBundle] = useState<RouteBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("sections");
  const [selectedSection, setSelectedSection] = useState<number | null>(readHashSection);
  const [selectedFinding, setSelectedFinding] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<Severity>>(new Set(["info"]));
  const [layer, setLayer] = useState<LayerKey>("infrastructure");
  const [collapsed, setCollapsed] = useState(readCollapsed);
  // Services (M2)
  const [month, setMonth] = useState<number | null>(null);
  const [shown, setShown] = useState<Set<string>>(new Set(DEFAULT_FILTERS));
  const [detour, setDetour] = useState<Detour>("counting");
  const [density, setDensity] = useState<Density>("auto");
  const [lowConfidence, setLowConfidence] = useState(false);
  const [zoom, setZoom] = useState(8);
  const [aheadM, setAheadM] = useState<number | null>(null);
  const [windowKm, setWindowKm] = useState(50);
  const [places, setPlaces] = useState<Place[]>([]);
  const [placesInfo, setPlacesInfo] = useState<{ total: number; truncated: boolean } | null>(null);
  const [selectedPlace, setSelectedPlace] = useState<string | null>(null);
  // Dream (M3)
  const [dreamResult, setDreamResult] = useState<StretchResult | null>(null);

  useEffect(() => {
    loadRoutes()
      .then(({ routes: r, wanted }) => {
        setRoutes(r);
        const pick = r.find((x) => routeKey(x.route) === wanted) ?? r[0];
        setRouteId((id) => id ?? pick?.route.id ?? null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const listing = routes?.find((r) => r.route.id === routeId) ?? null;
  // EuroVelo status (development and signage) exists only on EuroVelo routes; a rider's own route is not rated (D40).
  const isEuroVelo = listing?.route.network === "eurovelo";

  useEffect(() => {
    if (!listing) return;
    setBundle(null);
    loadBundle(listing.route.network, listing.route.ref)
      .then((b) => {
        setBundle(b);
        if (!b.events && b.manifest.route.network === "eurovelo") setLayer("status");
      })
      .catch((e: Error) => setError(e.message));
  }, [listing]);

  useEffect(() => {
    const hash = selectedSection === null ? "" : `#section=${selectedSection}`;
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${hash}`);
  }, [selectedSection]);

  useEffect(() => {
    document.querySelector(".list .row.selected")?.scrollIntoView({ block: "nearest" });
  }, [selectedSection, selectedFinding, tab, bundle]);

  useEffect(() => {
    const onHash = () => setSelectedSection(readHashSection());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    } catch {
      // storage unavailable (private window): the choice just isn't remembered
    }
  }, [collapsed]);

  const findings = bundle?.findings.findings ?? [];
  const visibleFindings = useMemo(() => findings.filter((f) => !hidden.has(f.severity)), [findings, hidden]);

  const findingsBySection = useMemo(() => {
    const out = new Map<number, Finding[]>();
    const days = bundle?.sections.daily ?? [];
    days.forEach((d, i) => {
      out.set(
        d.number,
        visibleFindings.filter((f) => inSection(f, d, i === days.length - 1)),
      );
    });
    return out;
  }, [bundle, visibleFindings]);

  const slicer = useMemo(() => (bundle ? new Slicer(bundle.path) : null), [bundle]);
  const stretches = useMemo(() => {
    const out = {} as Record<AuditLayer, Stretch[]>;
    for (const l of AUDIT_LAYERS) out[l] = stretchesFor(l, bundle?.events?.events ?? [], bundle?.minor ?? null);
    return out;
  }, [bundle]);
  const overlay = useMemo(
    () => (slicer && layer !== "status" ? overlayGeoJSON(layer, stretches[layer], slicer) : null),
    [layer, slicer, stretches],
  );
  const valueLabels = useMemo(() => {
    const out: Record<string, Record<string, string>> = { ecs: ECS_LABELS };
    for (const info of bundle?.events?.layers ?? []) out[info.id] = Object.fromEntries(info.values.map((v) => [v.id, v.label]));
    return out;
  }, [bundle]);
  const scoresBySection = useMemo(
    () => new Map<number, SectionScores>((bundle?.scores?.sections ?? []).map((s) => [s.number, s])),
    [bundle],
  );
  const servicesBySection = useMemo(
    () => new Map<number, SectionServices>((bundle?.services?.sections ?? []).map((s) => [s.number, s])),
    [bundle],
  );

  // Which stretch to load places for: the "ahead" window, else the selected section.
  const sectionRange = useMemo(() => {
    const d = bundle?.sections.daily.find((x) => x.number === selectedSection);
    return d ? ([d.from_m, d.to_m] as [number, number]) : null;
  }, [bundle, selectedSection]);
  const aheadActive = tab === "ahead" && aheadM !== null;
  const placesRange: [number, number] | null =
    tab === "ahead" && aheadM !== null ? [aheadM, aheadM + windowKm * 1000] : sectionRange;
  const serviceIds = useMemo(() => bundle?.services?.types.map((t) => t.id) ?? [], [bundle]);

  useEffect(() => {
    if (!bundle?.services || !listing || !placesRange) {
      setPlaces([]);
      setPlacesInfo(null);
      return;
    }
    const ctrl = new AbortController();
    loadPlaces(
      listing.route.network,
      listing.route.ref,
      bundle.manifest.run_id,
      { fromM: placesRange[0], toM: placesRange[1], services: serviceIds, month, detour },
      ctrl.signal,
    )
      .then((r) => {
        setPlaces(r.places);
        setPlacesInfo({ total: r.total, truncated: r.truncated });
      })
      .catch((e: Error) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => ctrl.abort();
    // placesRange is derived; its two numbers are the real dependencies.
  }, [bundle, listing, serviceIds, placesRange?.[0], placesRange?.[1], month, detour]);

  // The map shows a filtered, thinned view; the Ahead list and gap figures use every place.
  const filteredPlaces = useMemo(
    () => places.filter((p) => shown.has(filterKey(p)) && (lowConfidence || p.confidence !== "low")),
    [places, shown, lowConfidence],
  );
  const spacing = spacingFor(density, zoom);
  const mapPlaces = useMemo(() => {
    const out = thin(filteredPlaces, spacing);
    const picked = places.find((p) => p.id === selectedPlace);
    return picked && !out.includes(picked) ? [...out, picked] : out;
  }, [filteredPlaces, spacing, places, selectedPlace]);
  const ahead = useMemo(() => (aheadM === null ? new Map<string, Place[]>() : aheadByService(places, aheadM, 3)), [places, aheadM]);
  const aheadUser = useMemo(
    () =>
      aheadM === null || !bundle
        ? []
        : bundle.userPlaces
            .filter((p) => p.at_m >= aheadM && p.at_m <= aheadM + windowKm * 1000)
            .sort((a, b) => a.at_m - b.at_m),
    [bundle, aheadM, windowKm],
  );
  const marker = useMemo(
    () => (slicer && aheadActive && aheadM !== null ? slicer.pointAt(aheadM) : null),
    [slicer, aheadActive, aheadM],
  );

  const stripRows = useMemo<StripRow[]>(() => {
    if (!bundle?.events) return [];
    const layerRows = AUDIT_LAYERS.map((l) => ({
      key: l,
      title: LAYER_TITLES[l],
      palette: PALETTES[l],
      stretches: stretches[l],
      describe: (s: Stretch) => valueLabels[l]?.[s.value] ?? s.value,
    }));
    const gapRows = bundle.services
      ? GAP_ROWS.map((r, i) => ({
          key: `gap:${r.key}`,
          title: r.title + (r.key !== "bail_out" && month !== null ? ` (${MONTHS[month]})` : ""),
          palette: GAP_PALETTE,
          stretches: gapStretches(bundle.services, r.key, month),
          describe: (s: Stretch) => `${r.title.replace(" gaps", "")} gap ${km(s.to_m - s.from_m)} km`,
          hint: `${r.title}: red = ${GAP_LABELS.long.toLowerCase()}, amber = ${GAP_LABELS.near.toLowerCase()}`,
          separated: i === 0,
        }))
      : [];
    return [...layerRows, ...gapRows];
  }, [bundle, stretches, valueLabels, month]);

  if (error) return <div className="center error">Could not load data: {error}</div>;
  if (!routes) return <div className="center muted">Loading routes…</div>;
  if (routes.length === 0)
    return (
      <div className="center">
        No audit bundles yet. Run <code>npm run fetch:ev8</code> then <code>npm run audit:ev8</code>.
      </div>
    );

  const daily = bundle?.sections.daily ?? [];
  const section = daily.find((d) => d.number === selectedSection) ?? null;
  const summary = bundle?.manifest.summary;
  const totalLength = summary?.ride_length_m ?? 0;
  const dreamStretch =
    tab === "dream" && dreamResult
      ? daily.filter((d) => d.number >= dreamResult.first && d.number <= dreamResult.last)
      : null;
  const range: [number, number] = dreamStretch?.length
    ? [dreamStretch[0]!.from_m, dreamStretch[dreamStretch.length - 1]!.to_m]
    : section
      ? [section.from_m, section.to_m]
      : [0, totalLength];
  const stats: StretchStats | null = section ? (scoresBySection.get(section.number) ?? null) : (bundle?.scores?.route ?? null);
  // The profile header follows the Dream stretch when one is chosen: summed from its sections, unknowns kept apart.
  const trackStats = (() => {
    if (!dreamStretch?.length) {
      return stats
        ? { ascent: stats.ascent_m, descent: stats.descent_m, unknownM: stats.climb_unknown_m, maxGrade: stats.max_grade_500m }
        : null;
    }
    const scs = dreamStretch.flatMap((d) => scoresBySection.get(d.number) ?? []);
    const known = scs.filter((s) => s.ascent_m !== null);
    const grades = scs.flatMap((s) => (s.max_grade_500m === null ? [] : [s.max_grade_500m]));
    return {
      ascent: known.length ? known.reduce((a, s) => a + (s.ascent_m ?? 0), 0) : null,
      descent: known.length ? known.reduce((a, s) => a + (s.descent_m ?? 0), 0) : null,
      unknownM: scs.reduce((a, s) => a + s.climb_unknown_m, 0),
      maxGrade: grades.length ? Math.max(...grades) : null,
    };
  })();
  const legendShares = layer !== "status" ? shareOf(stretches[layer], range[0], range[1]) : {};
  const services = bundle?.services ?? null;
  const audited = Boolean(bundle?.events);

  const selectFinding = (f: Finding) => {
    setSelectedFinding(f.id);
    const point = { ...f, to_m: f.from_m };
    const owner = daily.find((d, i) => inSection(point, d, i === daily.length - 1)) ?? null;
    if (owner) setSelectedSection(owner.number);
  };

  const toggleSeverity = (s: Severity) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const toggleFilter = (key: string) =>
    setShown((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const setAhead = (m: number) => {
    setAheadM(Math.max(0, Math.min(m, totalLength)));
    setSelectedPlace(null);
    setTab("ahead");
  };

  const densityNote = spacing === null ? "all" : `best per ${km(spacing)} km`;

  return (
    <div className="app">
      <aside className="sidebar">
        <header>
          <div className="header-top">
            <div className="eyebrow">Kilometrica · audit viewer (M3.5)</div>
            <button
              className="collapse"
              onClick={() => setCollapsed((c) => !c)}
              aria-expanded={!collapsed}
              title={collapsed ? "Show the summary" : "Hide the summary to make room for the list"}
            >
              {collapsed ? "Show summary ▾" : "Hide summary ▴"}
            </button>
          </div>
          {routes.length > 1 ? (
            <select
              className="route-switch"
              value={routeId ?? ""}
              aria-label="Route"
              onChange={(e) => {
                // A fresh page per route: every selection, filter and Dream result starts clean.
                const r = routes.find((x) => x.route.id === e.target.value);
                if (r) window.location.assign(`${window.location.pathname}?route=${routeKey(r.route)}`);
              }}
            >
              {routes.map((r) => (
                <option key={r.route.id} value={r.route.id}>
                  {r.route.name}
                  {r.route.network === "user" ? " · private" : ""}
                </option>
              ))}
            </select>
          ) : (
            <h1>{listing?.route.name}</h1>
          )}
          {bundle?.manifest.visibility === "private" && (
            <div className="private-note" title="Your own route: never listed or shared (D25). Delete it with npm run forget.">
              🔒 Private route · from your own file
            </div>
          )}
          {bundle?.manifest.overlap?.map((o) => (
            <div key={o.route_id} className="overlap-note">
              Shares {km(o.shared_m, 1)} km ({pct(o.share)}) with {o.name}, sections{" "}
              {o.sections.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(", ")}
            </div>
          ))}
          {bundle && summary && (
            <>
              <div className="stats">
                <span>
                  <b>{km(summary.ride_length_m)}</b> km
                </span>
                <span>
                  <b>{summary.daily_section_count}</b> sections
                </span>
                <span title="Places where the published track stops and restarts elsewhere">
                  <b>{summary.gap_count}</b> gaps ({km(summary.gap_straight_distance_m)} km)
                </span>
              </div>
              {isEuroVelo && (
              <div className="bar" aria-label="Share of route by EuroVelo development status">
                {summary.status_breakdown.map((s) => (
                  <span
                    key={`${s.development}-${s.signage}`}
                    className={s.signage === "signed" ? "" : "unsigned"}
                    style={{ width: `${s.share * 100}%`, "--c": DEVELOPMENT[s.development].color } as React.CSSProperties}
                    title={`${DEVELOPMENT[s.development].label}, ${SIGNAGE[s.signage]}: ${km(s.length_m)} km (${(s.share * 100).toFixed(1)}%)`}
                  />
                ))}
              </div>
              )}
              {!collapsed && (
                <>
                  <KpiBand
                    title={section ? `Section ${section.number} · ${km(section.length_m, 1)} km` : "Whole route"}
                    stats={stats}
                    services={services}
                    sectionServices={section ? (servicesBySection.get(section.number) ?? null) : null}
                    month={month}
                  />
                  <details className="about">
                    <summary>ⓘ About this audit</summary>
                    <div>
                      Bundle {bundle.manifest.run_id} · {bundle.manifest.pipeline.name}
                      {bundle.scores && <> · rules: {bundle.scores.rules_profile}</>}
                      {services && <> · services: {services.rules_profile}, season {services.season_year}</>}
                    </div>
                    {services && (
                      <div>
                        Published opening season: {pct(services.season_known.accommodation)} of accommodation,{" "}
                        {pct(services.season_known.food)} of food places. Unknown seasons count as open, so autumn gaps
                        may be longer.
                      </div>
                    )}
                    <div>ECS-style figures are indicative; infrastructure thresholds are placeholders (D13).</div>
                  </details>
                </>
              )}
            </>
          )}
        </header>

        <nav className="tabs">
          <button className={tab === "sections" ? "active" : ""} onClick={() => setTab("sections")}>
            Sections {daily.length > 0 && <span className="count">{daily.length}</span>}
          </button>
          <button className={tab === "findings" ? "active" : ""} onClick={() => setTab("findings")}>
            Findings <span className="count">{visibleFindings.length}</span>
          </button>
          {services && (
            <button className={tab === "ahead" ? "active" : ""} onClick={() => setTab("ahead")}>
              Ahead
            </button>
          )}
          {bundle?.dream && (
            <button className={tab === "dream" ? "active" : ""} onClick={() => setTab("dream")}>
              Dream
            </button>
          )}
        </nav>

        {tab !== "ahead" && tab !== "dream" && (
          <div className="filters">
            {(Object.keys(SEVERITY) as Severity[])
              .filter((s) => findings.some((f) => f.severity === s))
              .map((s) => (
                <label key={s} className="chip" style={{ "--c": SEVERITY[s].color } as React.CSSProperties}>
                  <input type="checkbox" checked={!hidden.has(s)} onChange={() => toggleSeverity(s)} />
                  {SEVERITY[s].label} ({findings.filter((f) => f.severity === s).length})
                </label>
              ))}
          </div>
        )}

        {tab === "ahead" && (
          <div className="ahead-head">
            <label>
              From km{" "}
              <input
                type="number"
                min={0}
                max={Math.ceil(totalLength / 1000)}
                step={1}
                value={aheadM === null ? "" : Math.round(aheadM / 100) / 10}
                placeholder="click route"
                onChange={(e) => e.target.value !== "" && setAhead(Number(e.target.value) * 1000)}
              />
            </label>
            <label>
              next{" "}
              <select value={windowKm} onChange={(e) => setWindowKm(Number(e.target.value))}>
                {WINDOWS_KM.map((w) => (
                  <option key={w} value={w}>
                    {w} km
                  </option>
                ))}
              </select>
            </label>
            {aheadM !== null && (
              <span className="ahead-step">
                <button onClick={() => setAhead(aheadM - 10_000)}>−10</button>
                <button onClick={() => setAhead(aheadM + 10_000)}>+10</button>
              </span>
            )}
          </div>
        )}

        <div className="list">
          {!bundle && <div className="muted pad">Loading bundle…</div>}
          {bundle &&
            tab === "sections" &&
            daily.map((d) => {
              const fs = findingsBySection.get(d.number) ?? [];
              const sc = scoresBySection.get(d.number);
              const sv = servicesBySection.get(d.number);
              const isSelected = d.number === selectedSection;
              return (
                <button
                  key={d.id}
                  className={`row compact${isSelected ? " selected" : ""}`}
                  onClick={() => {
                    setSelectedFinding(null);
                    setSelectedPlace(null);
                    setSelectedSection(isSelected ? null : d.number);
                  }}
                >
                  <span className="row-num">{String(d.number).padStart(3, "0")}</span>
                  <span className="row-main">
                    <span className="row-title">{d.title}</span>
                    <span className="row-sub">
                      <StatusDot section={d} /> km {km(d.from_m)}–{km(d.to_m)} · {km(d.length_m, 1)} km
                      {sc && <> · ✓ {pct(sc.essential_pass)}</>}
                      {sv && (
                        <>
                          {" · "}
                          <span className="svc-count" title="Accommodation that counts on this section">
                            <Dot service="accommodation" />
                            {sv.counts.accommodation ?? 0}
                          </span>
                          <span className="svc-count" title="Food places that count on this section">
                            <Dot service="food" />
                            {sv.counts.food ?? 0}
                          </span>
                        </>
                      )}
                    </span>
                    {isSelected && (
                      <span className="row-more">
                        <span>{d.status.label}</span>
                        {sc && (
                          <span>
                            ↑ {climbText(sc.ascent_m, sc.climb_unknown_m)}
                            {unknownNote(sc.ascent_m, sc.climb_unknown_m)} · busy {pct(sc.shares.traffic_stress?.["4"])} · unpaved{" "}
                            {pct((sc.shares.surface?.gravel ?? 0) + (sc.shares.surface?.dirt ?? 0))} · important ✓{" "}
                            {pct(sc.important_pass)}
                          </span>
                        )}
                        {sv && (
                          <span>
                            {["accommodation", "food", "water", "bike_shop", "station"].map((s) => (
                              <span key={s} className="svc-count" title={`${s.replaceAll("_", " ")} that count on this section`}>
                                <Dot service={s} />
                                {sv.counts[s] ?? 0} {SERVICE_STYLE[s]?.short}
                              </span>
                            ))}
                          </span>
                        )}
                      </span>
                    )}
                  </span>
                  {fs.length > 0 && (
                    <span
                      className="badge"
                      style={{ "--c": SEVERITY[worst(fs)].color } as React.CSSProperties}
                      title={fs.map((f) => f.title).join("\n")}
                    >
                      {fs.length}
                    </span>
                  )}
                </button>
              );
            })}
          {bundle &&
            tab === "findings" &&
            visibleFindings.map((f) => (
              <button
                key={f.id}
                className={`row${f.id === selectedFinding ? " selected" : ""}`}
                onClick={() => selectFinding(f)}
              >
                <span className="sev" style={{ "--c": SEVERITY[f.severity].color } as React.CSSProperties} />
                <span className="row-main">
                  <span className="row-title">{f.title}</span>
                  <span className="row-sub">
                    km {km(f.from_m, 1)}
                    {f.to_m > f.from_m ? `–${km(f.to_m, 1)}` : ""} · {f.rule_id} · {f.confidence} confidence
                  </span>
                  {f.id === selectedFinding && <span className="row-detail">{f.detail}</span>}
                </span>
              </button>
            ))}
          {bundle?.dream && tab === "dream" && (
            <Dream
              dream={bundle.dream}
              daily={daily}
              month={month}
              onMonth={setMonth}
              selectedSection={selectedSection}
              onSelectSection={(n) => {
                setDreamResult(null);
                setSelectedSection(n);
              }}
              result={dreamResult}
              onResult={setDreamResult}
            />
          )}
          {bundle && tab === "ahead" && aheadM === null && (
            <div className="muted pad">
              Click the route on the map, or the profile or strip under it, to set your position. The list shows the
              next places of each kind, with the distance along the route and the detour to reach them.
            </div>
          )}
          {bundle && tab === "ahead" && aheadM !== null && bundle.userPlaces.length > 0 && (
            <div className="ahead-group">
              <div className="ahead-title">
                <span className="user-dot" /> Your waypoints
                {aheadUser.length === 0 && <span className="muted"> · none in the next {windowKm} km</span>}
              </div>
              {aheadUser.map((p) => (
                <div key={p.id} className="ahead-row user" title="From your own file: shown, never counted (D40)">
                  <span className="ahead-km">+{km(p.at_m - aheadM, 1)} km</span>
                  <span className="ahead-name">{p.name ?? p.kind}</span>
                  <span className="ahead-meta">
                    {p.kind}
                    {p.offset_m >= 100 ? ` · ${distanceLabel(p.offset_m)} from the route` : ""}
                    {p.note ? ` · ${p.note}` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
          {bundle &&
            tab === "ahead" &&
            aheadM !== null &&
            serviceIds.map((s) => {
              const list = ahead.get(s) ?? [];
              const type = services?.types.find((t) => t.id === s);
              return (
                <div key={s} className="ahead-group">
                  <div className="ahead-title">
                    <Dot service={s} /> {type?.title ?? s}
                    {list.length === 0 && <span className="muted"> · none in the next {windowKm} km</span>}
                  </div>
                  {list.map((p) => {
                    const state = monthState(p, month);
                    return (
                      <button
                        key={p.id}
                        className={`ahead-row${p.id === selectedPlace ? " selected" : ""}${p.counts ? "" : " beyond"}`}
                        onClick={() => {
                          setSelectedPlace(p.id);
                          setShown((prev) => new Set(prev).add(filterKey(p)));
                        }}
                      >
                        <span className="ahead-km">+{km(p.access_at_m - aheadM, 1)} km</span>
                        <span className="ahead-name">{p.name ?? p.kind.replaceAll("_", " ")}</span>
                        <span className="ahead-meta">
                          {distanceLabel(p.access_m)}
                          {p.access_min !== null && p.access_m !== null && p.access_m >= 1000
                            ? ` · ${Math.round(p.access_min)} min`
                            : ""}
                          {month !== null && state !== "open" && (
                            <span className={`month-${state}`}>
                              {" "}
                              · {state === "unknown" ? "season unknown" : state === "partly" ? "season ends/starts" : state}
                            </span>
                          )}
                          {p.service === "station" && ` · bikes ${String((p.detail as Record<string, unknown>).bikes)}`}
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
        </div>
      </aside>

      <main className="main">
        {bundle ? (
          <>
            <div className="map-wrap">
              <RouteMap
                path={bundle.path}
                overlay={overlay}
                findings={visibleFindings}
                places={mapPlaces}
                month={month}
                marker={marker}
                attribution={bundle.manifest.attribution}
                selectedSection={selectedSection}
                highlight={dreamStretch?.length ? dreamStretch.map((d) => d.number) : null}
                selectedFinding={selectedFinding}
                selectedPlace={selectedPlace}
                onZoom={setZoom}
                onClickRoute={(n, [lon, lat]) => {
                  if (tab === "ahead") {
                    const m = slicer?.nearestM(n, lon, lat);
                    if (m != null) setAhead(m);
                    return;
                  }
                  setSelectedFinding(null);
                  setSelectedPlace(null);
                  setSelectedSection(n);
                  setTab("sections");
                }}
                onClickEmpty={() => {
                  setSelectedPlace(null);
                  if (tab !== "ahead") setSelectedSection(null);
                }}
                onSelectFinding={(id) => {
                  const f = findings.find((x) => x.id === id);
                  if (f) {
                    setTab("findings");
                    selectFinding(f);
                  }
                }}
                onSelectPlace={setSelectedPlace}
                userPlaces={bundle.userPlaces}
              />
              <div className="layer-panel">
                <select value={layer} onChange={(e) => setLayer(e.target.value as LayerKey)} aria-label="Map layer">
                  {isEuroVelo && <option value="status">{LAYER_TITLES.status}</option>}
                  {audited && AUDIT_LAYERS.map((l) => <option key={l} value={l}>{LAYER_TITLES[l]}</option>)}
                </select>
                <details className="panel-section" open>
                  <summary className="panel-title">Legend</summary>
                  {layer === "status" ? (
                    <ul className="legend">
                      {summary?.status_breakdown.map((s) => (
                        <li key={`${s.development}-${s.signage}`}>
                          <StatusDot section={{ status: { development: s.development, signage: s.signage, label: "" } }} />
                          {DEVELOPMENT[s.development].label}, {SIGNAGE[s.signage]}
                          <span className="num">{(s.share * 100).toFixed(0)}%</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <ul className="legend">
                      {Object.entries(PALETTES[layer])
                        .filter(([v]) => (legendShares[v] ?? 0) > 0)
                        .sort(([a], [b]) => (legendShares[b] ?? 0) - (legendShares[a] ?? 0))
                        .map(([v, color]) => (
                          <li key={v}>
                            <Swatch color={color} />
                            {valueLabels[layer]?.[v] ?? v}
                            <span className="num">{pct(legendShares[v])}</span>
                          </li>
                        ))}
                    </ul>
                  )}
                  <div className="muted legend-note">{section ? `Shares for section ${section.number}` : "Shares for the whole route"}</div>
                </details>

                {services && (
                  <details className="panel-section" open>
                    <summary className="panel-title">Places</summary>
                    <div className="svc-toggles">
                      {MAP_FILTERS.filter((f) => serviceIds.includes(f.service)).map((f) => {
                        const t = services.types.find((x) => x.id === f.service);
                        return (
                          <label
                            key={f.key}
                            title={t ? `${t.title}: counts within ${distanceLabel(t.count_m)}${t.count_min ? ` / ${t.count_min} min` : " by road"}` : f.title}
                          >
                            <input type="checkbox" checked={shown.has(f.key)} onChange={() => toggleFilter(f.key)} />
                            <Dot service={f.service} />
                            {f.title}
                          </label>
                        );
                      })}
                    </div>
                    <div className="panel-grid">
                      <label>
                        Month
                        <select value={month ?? ""} onChange={(e) => setMonth(e.target.value === "" ? null : Number(e.target.value))}>
                          <option value="">any</option>
                          {MONTHS.map((name, i) => (
                            <option key={name} value={i}>
                              {name} {services.season_year}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Detour
                        <select
                          value={String(detour)}
                          onChange={(e) => setDetour(e.target.value === "counting" ? "counting" : Number(e.target.value))}
                        >
                          {DETOURS.map((d) => (
                            <option key={String(d)} value={String(d)}>
                              {d === "counting" ? "counting limits" : `≤ ${distanceLabel(d)}`}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Show
                        <select value={density} onChange={(e) => setDensity(e.target.value as Density)}>
                          {(Object.keys(DENSITY_LABELS) as Density[]).map((d) => (
                            <option key={d} value={d}>
                              {DENSITY_LABELS[d]}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="check" title="Places known only to Overture, with a weak confidence score">
                        <input type="checkbox" checked={lowConfidence} onChange={(e) => setLowConfidence(e.target.checked)} />
                        low-confidence
                      </label>
                    </div>
                    <div
                      className="muted legend-note"
                      title="Faded dots are beyond the counting limit. The Ahead list and the gap figures use every place."
                    >
                      {placesRange
                        ? `${mapPlaces.length.toLocaleString("en-GB")} shown (${densityNote}) of ${placesInfo?.total.toLocaleString("en-GB") ?? "…"} in ${
                            aheadActive ? `the next ${windowKm} km` : `section ${section?.number ?? ""}`
                          }${placesInfo?.truncated ? " (first 5,000)" : ""}`
                        : "Select a section, or set a position in Ahead, to show places."}
                    </div>
                  </details>
                )}
              </div>
            </div>
            <div className="bottom">
              <Track
                profile={bundle.profile}
                range={range}
                label={
                  dreamStretch?.length
                    ? `Sections ${dreamStretch[0]!.number}–${dreamStretch[dreamStretch.length - 1]!.number}`
                    : section
                      ? `Section ${section.number}: ${section.title}`
                      : "Whole route"
                }
                stats={trackStats}
                rows={stripRows}
                active={layer}
                marker={aheadActive ? aheadM : null}
                onPick={(key) => {
                  if (key.startsWith("gap:")) {
                    const s = key.slice(4);
                    for (const f of MAP_FILTERS) if (f.service === s) setShown((prev) => new Set(prev).add(f.key));
                  } else setLayer(key as LayerKey);
                }}
                onPickM={services ? setAhead : undefined}
              />
            </div>
          </>
        ) : (
          <div className="center muted">Loading map…</div>
        )}
      </main>
    </div>
  );
}
