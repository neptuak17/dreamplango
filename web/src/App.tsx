import type { DailySection, Finding, Severity } from "@dpg/contracts";
import { useEffect, useMemo, useState } from "react";
import { listRoutes, loadBundle, type RouteBundle, type RouteListing } from "./api";
import { Profile } from "./Profile";
import { RouteMap } from "./RouteMap";
import { DEVELOPMENT, km, SEVERITY, SIGNAGE } from "./status";

type Tab = "sections" | "findings";

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

export function App() {
  const [routes, setRoutes] = useState<RouteListing[] | null>(null);
  const [routeId, setRouteId] = useState<string | null>(null);
  const [bundle, setBundle] = useState<RouteBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("sections");
  const [selectedSection, setSelectedSection] = useState<number | null>(readHashSection);
  const [selectedFinding, setSelectedFinding] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<Severity>>(new Set(["info"]));

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
      .then(setBundle)
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

  if (error) return <div className="center error">Could not load data: {error}</div>;
  if (!routes) return <div className="center muted">Loading routes…</div>;
  if (routes.length === 0)
    return (
      <div className="center">
        No audit bundles yet. Run <code>npm run fetch:ev8</code> then <code>npm run ingest:ev8</code>.
      </div>
    );

  const daily = bundle?.sections.daily ?? [];
  const section = daily.find((d) => d.number === selectedSection) ?? null;
  const summary = bundle?.manifest.summary;
  const totalLength = summary?.ride_length_m ?? 0;
  const profileRange: [number, number] = section ? [section.from_m, section.to_m] : [0, totalLength];

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

  return (
    <div className="app">
      <aside className="sidebar">
        <header>
          <div className="eyebrow">DreamPlanGo · audit viewer (M0)</div>
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
              <ul className="legend">
                {summary.status_breakdown.map((s) => (
                  <li key={`${s.development}-${s.signage}`}>
                    <StatusDot section={{ status: { development: s.development, signage: s.signage, label: "" } }} />
                    {DEVELOPMENT[s.development].label}, {SIGNAGE[s.signage]}
                    <span className="num">
                      {km(s.length_m)} km · {(s.share * 100).toFixed(0)}%
                    </span>
                  </li>
                ))}
              </ul>
              <div className="run muted">
                Bundle {bundle.manifest.run_id} · source tracks downloaded{" "}
                {bundle.manifest.sources[0]?.retrieved_at.slice(0, 10)}
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
        </nav>

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

        <div className="list">
          {!bundle && <div className="muted pad">Loading bundle…</div>}
          {bundle &&
            tab === "sections" &&
            daily.map((d) => {
              const fs = findingsBySection.get(d.number) ?? [];
              return (
                <button
                  key={d.id}
                  className={`row${d.number === selectedSection ? " selected" : ""}`}
                  onClick={() => {
                    setSelectedFinding(null);
                    setSelectedSection(d.number === selectedSection ? null : d.number);
                  }}
                >
                  <span className="row-num">{String(d.number).padStart(3, "0")}</span>
                  <span className="row-main">
                    <span className="row-title">{d.title}</span>
                    <span className="row-sub">
                      <StatusDot section={d} /> {d.status.label} · km {km(d.from_m)}–{km(d.to_m)} · {km(d.length_m, 1)} km
                    </span>
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
        </div>
      </aside>

      <main className="main">
        {bundle ? (
          <>
            <RouteMap
              path={bundle.path}
              findings={visibleFindings}
              attribution={bundle.manifest.attribution}
              selectedSection={selectedSection}
              selectedFinding={selectedFinding}
              onSelectSection={(n) => {
                setSelectedFinding(null);
                setSelectedSection(n);
                if (n !== null) setTab("sections");
              }}
              onSelectFinding={(id) => {
                const f = findings.find((x) => x.id === id);
                if (f) {
                  setTab("findings");
                  selectFinding(f);
                }
              }}
            />
            <Profile
              profile={bundle.profile}
              range={profileRange}
              label={section ? `Section ${section.number}: ${section.title}` : "Whole route"}
            />
          </>
        ) : (
          <div className="center muted">Loading map…</div>
        )}
      </main>
    </div>
  );
}
