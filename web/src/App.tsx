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
import { listRoutes, loadBundle, loadPlaces, type RouteBundle, type RouteListing } from "./api";
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
import { Profile } from "./Profile";
import { RouteMap } from "./RouteMap";
import {
  aheadByService,
  DEFAULT_SHOWN,
  distanceLabel,
  GAP_LABELS,
  GAP_PALETTE,
  GAP_ROWS,
  gapStretches,
  MONTHS,
  monthState,
  SERVICE_STYLE,
} from "./services";
import { DEVELOPMENT, km, SEVERITY, SIGNAGE } from "./status";
import { Strip, type StripRow } from "./Strip";

type Tab = "sections" | "findings" | "ahead";
type AuditLayer = Exclude<LayerKey, "status">;
type Detour = "counting" | number;
const AUDIT_LAYERS: AuditLayer[] = ["ecs", "infrastructure", "traffic_stress", "surface", "cycle_network", "gradient"];
const DETOURS: Detour[] = ["counting", 500, 1000, 2000, 5000, 10000, 20000];
const WINDOWS_KM = [25, 50, 100, 200];
const pct = (x: number | undefined) => `${Math.round((x ?? 0) * 100)}%`;

function readHashSection(): number | null {
  const match = /section=(\d+)/.exec(window.location.hash);
  return match ? Number(match[1]) : null;
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

function StatsCard({ stats, title }: { stats: StretchStats; title: string }) {
  const lts = stats.shares.traffic_stress ?? {};
  const surf = stats.shares.surface ?? {};
  const infra = stats.shares.infrastructure ?? {};
  const carFree = (infra.cycleway ?? 0) + (infra.shared_path ?? 0) + (infra.separated_track ?? 0);
  const unpaved = (surf.gravel ?? 0) + (surf.dirt ?? 0);
  return (
    <div className="card">
      <div className="card-title">{title}</div>
      <div className="kpis">
        <div title="Share of length meeting all essential criteria (indicative)">
          <b>{pct(stats.essential_pass)}</b>
          <span>essential ✓</span>
        </div>
        <div title="Share of length meeting all important criteria">
          <b>{pct(stats.important_pass)}</b>
          <span>important ✓</span>
        </div>
        <div title="Car-free paths and separated tracks">
          <b>{pct(carFree)}</b>
          <span>car-free</span>
        </div>
        <div title="Busy roads (LTS 4)">
          <b>{pct(lts["4"])}</b>
          <span>busy roads</span>
        </div>
        <div title="Loose gravel, dirt or sand">
          <b>{pct(unpaved)}</b>
          <span>unpaved</span>
        </div>
        <div title="Total climbing, smoothed terrain model">
          <b>{stats.ascent_m != null ? `${stats.ascent_m.toLocaleString("en-GB")} m` : "–"}</b>
          <span>climbing</span>
        </div>
      </div>
    </div>
  );
}

const GAP_SERVICES = ["water", "food", "accommodation", "bike_shop", "station"];

/** Longest stretch without each service: for one month, or the worst month when no month is chosen. */
function ServicesCard({
  services,
  section,
  month,
}: {
  services: ServicesFile;
  section: SectionServices | null;
  month: number | null;
}) {
  const gaps = section ? section.longest_gap_m : services.route_longest_gap_m;
  const pick = (v: number[] | undefined) => (v ? (month === null ? Math.max(...v) : (v[month] ?? 0)) : 0);
  const titles = Object.fromEntries(services.types.map((t) => [t.id, t]));
  return (
    <div className="card">
      <div className="card-title">
        Longest stretch without … {month === null ? "(worst month)" : `(${MONTHS[month]})`}
      </div>
      <div className="kpis">
        {GAP_SERVICES.map((s) => {
          const t = titles[s];
          const value = pick(gaps[s]);
          const over = t?.gap_m != null && value > t.gap_m;
          return (
            <div key={s} title={t ? `${t.title}: counts within ${distanceLabel(t.count_m)} by bike` : s}>
              <b className={over ? "over" : ""}>{km(value)} km</b>
              <span>
                <Dot service={s} /> {SERVICE_STYLE[s]?.short ?? s}
                {s === "water" ? " / shop" : ""}
              </span>
            </div>
          );
        })}
        {section && (
          <div title="Counted accommodation on this daily section">
            <b>{section.counts.accommodation ?? 0}</b>
            <span>beds on section</span>
          </div>
        )}
      </div>
      <div className="muted card-note">
        Published opening season: {pct(services.season_known.accommodation)} of accommodation,{" "}
        {pct(services.season_known.food)} of food places. Unknown seasons count as open, so autumn gaps may be longer.
      </div>
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
  // Services (M2)
  const [month, setMonth] = useState<number | null>(null);
  const [shown, setShown] = useState<Set<string>>(new Set(DEFAULT_SHOWN));
  const [detour, setDetour] = useState<Detour>("counting");
  const [aheadM, setAheadM] = useState<number | null>(null);
  const [windowKm, setWindowKm] = useState(50);
  const [places, setPlaces] = useState<Place[]>([]);
  const [placesInfo, setPlacesInfo] = useState<{ total: number; truncated: boolean } | null>(null);
  const [selectedPlace, setSelectedPlace] = useState<string | null>(null);

  useEffect(() => {
    listRoutes()
      .then((r) => {
        setRoutes(r);
        setRouteId((id) => id ?? r[0]?.route.id ?? null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const listing = routes?.find((r) => r.route.id === routeId) ?? null;

  useEffect(() => {
    if (!listing) return;
    setBundle(null);
    loadBundle(listing.route.network, listing.route.ref)
      .then((b) => {
        setBundle(b);
        if (!b.events) setLayer("status");
      })
      .catch((e: Error) => setError(e.message));
  }, [listing]);

  useEffect(() => {
    const hash = selectedSection === null ? "" : `#section=${selectedSection}`;
    window.history.replaceState(null, "", `${window.location.pathname}${hash}`);
  }, [selectedSection]);

  useEffect(() => {
    document.querySelector(".list .row.selected")?.scrollIntoView({ block: "nearest" });
  }, [selectedSection, selectedFinding, tab, bundle]);

  useEffect(() => {
    const onHash = () => setSelectedSection(readHashSection());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

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

  const mapPlaces = useMemo(() => places.filter((p) => shown.has(p.service)), [places, shown]);
  const ahead = useMemo(() => (aheadM === null ? new Map<string, Place[]>() : aheadByService(places, aheadM, 3)), [places, aheadM]);
  const marker = useMemo(() => (slicer && aheadM !== null && tab === "ahead" ? slicer.pointAt(aheadM) : null), [slicer, aheadM, tab]);

  const gapRows = useMemo<StripRow[]>(
    () =>
      bundle?.services
        ? GAP_ROWS.map((r, i) => ({
            key: `gap:${r.key}`,
            title: r.title + (r.key !== "bail_out" && month !== null ? ` (${MONTHS[month]})` : ""),
            palette: GAP_PALETTE,
            stretches: gapStretches(bundle.services, r.key, month),
            separated: i === 0,
          }))
        : [],
    [bundle, month],
  );

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
  const range: [number, number] = section ? [section.from_m, section.to_m] : [0, totalLength];
  const audited = Boolean(bundle?.events);
  const stats: StretchStats | null = section ? (scoresBySection.get(section.number) ?? null) : (bundle?.scores?.route ?? null);
  const legendShares = layer !== "status" ? shareOf(stretches[layer], range[0], range[1]) : {};
  const services = bundle?.services ?? null;

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

  const toggleService = (s: string) =>
    setShown((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const setAhead = (m: number) => {
    setAheadM(Math.max(0, Math.min(m, totalLength)));
    setSelectedPlace(null);
    setTab("ahead");
  };

  const stripRows: StripRow[] = [
    ...AUDIT_LAYERS.map((l) => ({ key: l, title: LAYER_TITLES[l], palette: PALETTES[l], stretches: stretches[l] })),
    ...gapRows,
  ];

  return (
    <div className="app">
      <aside className="sidebar">
        <header>
          <div className="eyebrow">DreamPlanGo · audit viewer (M2)</div>
          {routes.length > 1 ? (
            <select value={routeId ?? ""} onChange={(e) => setRouteId(e.target.value)}>
              {routes.map((r) => (
                <option key={r.route.id} value={r.route.id}>
                  {r.route.name}
                </option>
              ))}
            </select>
          ) : (
            <h1>{listing?.route.name}</h1>
          )}
          {bundle && summary && (
            <>
              <div className="stats">
                <div>
                  <b>{km(summary.ride_length_m)}</b> km ridden
                </div>
                <div>
                  <b>{summary.daily_section_count}</b> daily sections
                </div>
                <div title="Places where the published track stops and restarts elsewhere">
                  <b>{summary.gap_count}</b> gaps ({km(summary.gap_straight_distance_m)} km straight-line)
                </div>
              </div>
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
              {stats && (
                <StatsCard
                  stats={stats}
                  title={section ? `Section ${section.number} · ${km(section.length_m, 1)} km` : "Whole route"}
                />
              )}
              {services && (
                <ServicesCard
                  services={services}
                  section={section ? (servicesBySection.get(section.number) ?? null) : null}
                  month={month}
                />
              )}
              <div className="run muted">
                Bundle {bundle.manifest.run_id} · {bundle.manifest.pipeline.name}
                {bundle.scores && <> · rules: {bundle.scores.rules_profile}</>}
                {services && <> · services: {services.rules_profile}, season {services.season_year}</>}
              </div>
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
        </nav>

        {tab !== "ahead" && (
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
              return (
                <button
                  key={d.id}
                  className={`row${d.number === selectedSection ? " selected" : ""}`}
                  onClick={() => {
                    setSelectedFinding(null);
                    setSelectedPlace(null);
                    setSelectedSection(d.number === selectedSection ? null : d.number);
                  }}
                >
                  <span className="row-num">{String(d.number).padStart(3, "0")}</span>
                  <span className="row-main">
                    <span className="row-title">{d.title}</span>
                    <span className="row-sub">
                      <StatusDot section={d} /> {d.status.label} · km {km(d.from_m)}–{km(d.to_m)} · {km(d.length_m, 1)} km
                    </span>
                    {sc && (
                      <span className="row-sub">
                        ↑ {sc.ascent_m ?? "–"} m · busy {pct(sc.shares.traffic_stress?.["4"])} · unpaved{" "}
                        {pct((sc.shares.surface?.gravel ?? 0) + (sc.shares.surface?.dirt ?? 0))} · essential ✓{" "}
                        {pct(sc.essential_pass)}
                      </span>
                    )}
                    {sv && (
                      <span className="row-sub">
                        {["accommodation", "food", "water", "bike_shop", "station"].map((s) => (
                          <span key={s} className="svc-count" title={`${s.replaceAll("_", " ")} that count on this section`}>
                            <Dot service={s} />
                            {sv.counts[s] ?? 0} {SERVICE_STYLE[s]?.short}
                          </span>
                        ))}
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
          {bundle && tab === "ahead" && aheadM === null && (
            <div className="muted pad">
              Click the route on the map, or a band in the strip under the profile, to set your position. The list
              shows the next places of each kind, with the distance along the route and the detour to reach them.
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
                          setShown((prev) => new Set(prev).add(p.service));
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
                selectedFinding={selectedFinding}
                selectedPlace={selectedPlace}
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
              />
              <div className="layer-panel">
                <select value={layer} onChange={(e) => setLayer(e.target.value as LayerKey)} aria-label="Map layer">
                  <option value="status">{LAYER_TITLES.status}</option>
                  {audited && AUDIT_LAYERS.map((l) => <option key={l} value={l}>{LAYER_TITLES[l]}</option>)}
                </select>
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

                {services && (
                  <div className="panel-section">
                    <div className="panel-title">Places</div>
                    <div className="svc-toggles">
                      {services.types.map((t) => (
                        <label key={t.id} title={`${t.title}: counts within ${distanceLabel(t.count_m)}${t.count_min ? ` / ${t.count_min} min` : " by road"}`}>
                          <input type="checkbox" checked={shown.has(t.id)} onChange={() => toggleService(t.id)} />
                          <Dot service={t.id} />
                          {SERVICE_STYLE[t.id]?.short ?? t.id}
                        </label>
                      ))}
                    </div>
                    <div className="panel-row">
                      <label>
                        Month{" "}
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
                        Detour{" "}
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
                    </div>
                    <div className="muted legend-note">
                      {placesRange
                        ? `${mapPlaces.length.toLocaleString("en-GB")} shown of ${placesInfo?.total.toLocaleString("en-GB") ?? "…"} in ${
                            tab === "ahead" && aheadM !== null ? `the next ${windowKm} km` : `section ${section?.number ?? ""}`
                          }${placesInfo?.truncated ? " (first 5,000)" : ""}. Faded: beyond the counting limit. Month hides places known to be closed.`
                        : "Select a section, or set a position in Ahead, to show places."}
                    </div>
                    <ul className="legend">
                      {Object.entries(GAP_PALETTE).map(([v, color]) => (
                        <li key={v}>
                          <Swatch color={color} />
                          {GAP_LABELS[v]} (strip)
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
            <div className="bottom">
              <Profile
                profile={bundle.profile}
                range={range}
                label={section ? `Section ${section.number}: ${section.title}` : "Whole route"}
                stats={stats ? { ascent: stats.ascent_m, descent: stats.descent_m, maxGrade: stats.max_grade_500m } : null}
              />
              {audited && (
                <Strip
                  rows={stripRows}
                  range={range}
                  active={layer}
                  marker={tab === "ahead" ? aheadM : null}
                  onPick={(key) => {
                    if (key.startsWith("gap:")) {
                      const s = key.slice(4);
                      if (s !== "bail_out") setShown((prev) => new Set(prev).add(s));
                    } else setLayer(key as LayerKey);
                  }}
                  onPickM={services ? setAhead : undefined}
                />
              )}
            </div>
          </>
        ) : (
          <div className="center muted">Loading map…</div>
        )}
      </main>
    </div>
  );
}
