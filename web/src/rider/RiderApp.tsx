/**
 * The rider view (M4, DESIGN.md 11.6): Plan for riders, apart from the audit viewer, which is ours (D43, D48).
 * Built for the web first (D49); a plan opened from its link on a phone shows the phone-width view, where Go starts.
 *
 *   /plan?route=<network>/<ref>&first=&last=&way=&days=&month=&level=…   a stretch from Dream (or any range)
 *   /plan?plan=<id>                                                      a plan kept in this browser
 *   /plan#p=…  /plan#i=…                                                 a shared plan or itinerary (read-only)
 */
import type { RouteListing } from "../api";
import { listRoutes, loadManifest, listingOf } from "../api";
import {
  addDays,
  calendarFile,
  choicesOf,
  dayGpx,
  type DayPlan,
  day as dayText,
  hours,
  itineraryOf,
  km,
  makePlan,
  NO_CHOICES,
  newId,
  type PlanChoices,
  type PlanData,
  type PlanDocument,
  type PlanInputs,
  type PlanItem,
  type PlanResult,
  readFragment,
  shareFragment,
  type Itinerary,
  toDocument,
  tripGpx,
} from "@dpg/planner";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BeforeYouGo, type ExportKind } from "./BeforeYouGo";
import { Brief, DayList, EffortChart } from "./Brief";
import { Calls } from "./Calls";
import { loadFull, loadRoute, type FullFiles, type RouteFiles } from "./data";
import { DayCard } from "./DayCard";
import { PlanMap } from "./PlanMap";
import { Profile } from "./Profile";
import { Questions } from "./Questions";
import { deletePlan, download, fileSafe, savedPlans, savePlan } from "./storage";
import "./rider.css";

const PASS_KEY = "dpg.tripPass";
const PRIVATE_KEY = "dpg.privateRoutes";

function readPass(): boolean {
  try {
    return localStorage.getItem(PASS_KEY) !== "0";
  } catch {
    return true;
  }
}

interface Start {
  network: string;
  ref: string;
  inputs: Partial<PlanInputs> & { first?: number; last?: number; month?: number | null };
  doc: PlanDocument | null;
  readOnly: boolean;
}

function readStart(): { start: Start | null; itinerary: Itinerary | null; error: string | null } {
  const shared = readFragment(window.location.hash);
  if (shared && "error" in shared) return { start: null, itinerary: null, error: `This link can't be opened: ${shared.error}.` };
  if (shared && "itinerary" in shared) return { start: null, itinerary: shared.itinerary, error: null };
  if (shared && "plan" in shared) {
    const d = shared.plan;
    return { start: { network: d.route.network, ref: d.route.ref, inputs: d.inputs, doc: d, readOnly: true }, itinerary: null, error: null };
  }
  const q = new URLSearchParams(window.location.search);
  const id = q.get("plan");
  if (id) {
    const d = savedPlans().find((p) => p.id === id);
    if (!d) return { start: null, itinerary: null, error: "That plan isn't kept in this browser any more." };
    return { start: { network: d.route.network, ref: d.route.ref, inputs: d.inputs, doc: d, readOnly: false }, itinerary: null, error: null };
  }
  const route = q.get("route");
  if (!route || !/^[a-z0-9-]+\/[a-z0-9-]+$/i.test(route)) return { start: null, itinerary: null, error: null };
  const [network = "", ref = ""] = route.toLowerCase().split("/");
  const num = (k: string) => (q.get(k) === null || q.get(k) === "" ? undefined : Number(q.get(k)));
  const stay = q.get("stay");
  return {
    start: {
      network,
      ref,
      inputs: {
        first: num("first"),
        last: num("last"),
        direction: q.get("way") === "reverse" ? "reverse" : "forward",
        days: num("days"),
        month: num("month") ?? null,
        level: num("level"),
        avoidGravel: q.get("gravel") === "avoid",
        avoidBusy: q.get("busy") === "1",
        sleep: stay === "camping" ? "camping" : stay === "rooms" ? "rooms" : "mix",
      },
      doc: null,
      readOnly: false,
    },
    itinerary: null,
    error: null,
  };
}

function initialInputs(files: RouteFiles, s: Start["inputs"]): { inputs: PlanInputs; suggested: number | null } {
  const daily = [...files.sections.daily].sort((a, b) => a.from_m - b.from_m);
  const first = daily.find((d) => d.number === s.first) ?? daily[0]!;
  const last = daily.find((d) => d.number === s.last) ?? daily[Math.min(daily.length - 1, 6)]!;
  const year = files.free.dream.season_year;
  const month = s.month ?? null;
  const startDate = s.startDate ?? `${year}-${String((month ?? 8) + 1).padStart(2, "0")}-15`;
  return {
    suggested: s.startDate ? null : month,
    inputs: {
      fromM: s.fromM ?? Math.min(first.from_m, last.from_m),
      toM: s.toM ?? Math.max(first.to_m, last.to_m),
      direction: s.direction ?? "forward",
      startDate,
      days: s.days ?? 7,
      level: s.level ?? 3,
      bike: s.bike ?? "touring",
      sleep: s.sleep ?? "mix",
      startMinutes: s.startMinutes ?? 9 * 60,
      stopStyle: s.stopStyle ?? "normal",
      restAfter: s.restAfter ?? [],
      avoidGravel: s.avoidGravel ?? false,
      avoidBusy: s.avoidBusy ?? false,
    },
  };
}

// --- start page ---------------------------------------------------------------------------------------------

function StartPage() {
  const [routes, setRoutes] = useState<RouteListing[]>([]);
  const [plans, setPlans] = useState(savedPlans);
  useEffect(() => {
    void (async () => {
      const list = await listRoutes().catch((): RouteListing[] => []);
      let remembered: string[] = [];
      try {
        remembered = JSON.parse(localStorage.getItem(PRIVATE_KEY) ?? "[]") as string[];
      } catch {
        /* none */
      }
      for (const key of remembered) {
        const [n = "", r = ""] = key.split("/");
        const m = await loadManifest(n, r).catch(() => null);
        if (m) list.push(listingOf(m));
      }
      setRoutes(list);
    })();
  }, []);
  return (
    <div className="rider start">
      <header className="rider-bar">
        <span className="brand">Kilometrica</span> <span className="muted">Plan</span>
      </header>
      <main className="start-main">
        <h1>Plan a trip</h1>
        <p className="muted">Pick a route, then the stretch, the dates and how you ride. Or plan a stretch you found in Dream.</p>
        <ul className="route-pick">
          {routes.map((r) => (
            <li key={r.route.id}>
              <a href={`/plan?route=${r.route.network}/${r.route.ref.toLowerCase()}`}>{r.route.name}</a>
              <span className="muted"> · {km(r.summary.ride_length_m / 1000)} km{r.route.network === "user" ? " · your own route" : ""}</span>
            </li>
          ))}
        </ul>
        {plans.length > 0 && (
          <>
            <h2>Plans kept in this browser</h2>
            <ul className="saved">
              {plans.map((p) => (
                <li key={p.id}>
                  <a href={`/plan?plan=${p.id}`}>{p.name}</a>
                  <span className="muted">
                    {" "}
                    · {dayText(p.inputs.startDate)} · {p.inputs.days} days · {p.route.name}
                  </span>
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      deletePlan(p.id);
                      setPlans(savedPlans());
                    }}
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
    </div>
  );
}

function ItineraryView({ it }: { it: Itinerary }) {
  return (
    <div className="rider itinerary">
      <header className="rider-bar">
        <span className="brand">Kilometrica</span> <span className="muted">Where I'll be</span>
      </header>
      <main className="start-main">
        <h1>{it.name}</h1>
        <ol className="itin">
          {it.days.map((d) => (
            <li key={d.date}>
              <b>{dayText(d.date)}</b> · {d.kind === "rest" ? `rest day at ${d.to}` : `${d.from} → ${d.to}, ${d.km} km`}
              {d.stop && (
                <a href={`https://www.google.com/maps/search/?api=1&query=${d.stop.lat},${d.stop.lon}`} target="_blank" rel="noreferrer noopener">
                  {" "}
                  map
                </a>
              )}
            </li>
          ))}
        </ol>
        <p className="muted small">Shared from Kilometrica: dates and nightly stops only.</p>
      </main>
    </div>
  );
}

// --- compare ------------------------------------------------------------------------------------------------

interface Pinned {
  label: string;
  inputs: PlanInputs;
  choices: PlanChoices;
}

function metrics(p: PlanResult) {
  const rides = p.days.filter((d) => d.kind === "ride");
  const hardest = [...rides].sort((a, b) => b.hoursSlow - a.hoursSlow)[0]!;
  const busy = p.items
    .filter((i) => i.id.startsWith("finding:") && i.title.includes("busy roads"))
    .reduce((a, i) => a + Math.abs((i.toM ?? 0) - (i.fromM ?? 0)) / 1000, 0);
  return {
    days: `${p.days.length} (${rides.length} riding)`,
    hardest: `day ${hardest.number}: ${km(hardest.km)} km, ${hours(hardest.hoursSlow)}`,
    hours: hours(rides.reduce((a, d) => a + d.hoursSlow, 0)),
    beyond: String(rides.filter((d) => d.effort === "beyond").length),
    nights: String(p.nights.filter((n) => n.beds.open + n.beds.partly === 0).length),
    calls: String(p.items.filter((i) => i.kind === "call").length),
    busy: p.mode === "full" ? `${km(busy)} km` : "with a Trip Pass",
  };
}

function Compare({ data, current, pinned, onUnpin }: { data: PlanData; current: PlanResult; pinned: Pinned[]; onUnpin: (i: number) => void }) {
  const plans = useMemo(() => pinned.map((p) => makePlan(data, p.inputs, p.choices)), [data, pinned]);
  if (!pinned.length) return null;
  const cols = [...plans.map((p, i) => ({ label: pinned[i]!.label, m: metrics(p), i })), { label: "Current", m: metrics(current), i: -1 }];
  const rows: [keyof ReturnType<typeof metrics>, string][] = [
    ["days", "Days"],
    ["hardest", "Hardest day"],
    ["hours", "Total riding"],
    ["beyond", "Days beyond your level"],
    ["nights", "Nights with no known-open bed"],
    ["calls", "Calls to make"],
    ["busy", "Busy roads"],
  ];
  return (
    <section className="compare">
      <h2>Compare plans</h2>
      <div className="compare-table">
        <table>
          <thead>
            <tr>
              <th />
              {cols.map((c) => (
                <th key={c.label}>
                  {c.label}
                  {c.i >= 0 && (
                    <button type="button" className="link" onClick={() => onUnpin(c.i)} aria-label="Remove">
                      ×
                    </button>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([k, title]) => (
              <tr key={k}>
                <th>{title}</th>
                {cols.map((c) => (
                  <td key={c.label}>{c.m[k]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// --- the trip book (print) ----------------------------------------------------------------------------------

function TripBook({ plan, data, onDone }: { plan: PlanResult; data: PlanData; onDone: () => void }) {
  useEffect(() => {
    const after = () => onDone();
    window.addEventListener("afterprint", after);
    const t = setTimeout(() => window.print(), 300);
    return () => {
      clearTimeout(t);
      window.removeEventListener("afterprint", after);
    };
  }, [onDone]);
  const noop = () => {};
  return (
    <div className="trip-book">
      <button type="button" className="no-print" onClick={onDone}>
        ‹ Back to the plan
      </button>
      <Brief plan={plan} onLine={noop} />
      {plan.days.map((d) => (
        <DayCard
          key={d.number}
          plan={plan}
          data={data}
          day={d}
          free={false}
          readOnly
          choices={plan.choices}
          onLockNight={noop}
          onToggleBooked={noop}
          onChooseBed={noop}
          onToggleRest={noop}
          onDone={noop}
          onGpx={noop}
        />
      ))}
      <p className="muted small">Kilometrica trip book · {plan.route.name} · audit {plan.route.runId}</p>
    </div>
  );
}

// --- the plan -----------------------------------------------------------------------------------------------

function PlanPage({ start }: { start: Start }) {
  const [files, setFiles] = useState<RouteFiles | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inputs, setInputs] = useState<PlanInputs | null>(null);
  const [suggested, setSuggested] = useState<number | null>(null);
  const [datesConfirmed, setDatesConfirmed] = useState(Boolean(start.doc));
  const [choices, setChoices] = useState<PlanChoices>(start.doc ? choicesOf(start.doc) : NO_CHOICES);
  const [meta, setMeta] = useState(() => ({ id: start.doc?.id ?? newId(), name: start.doc?.name ?? "", created: start.doc?.created, notes: start.doc?.notes ?? "" }));
  const [readOnly, setReadOnly] = useState(start.readOnly);
  const [pass, setPass] = useState(readPass);
  const [full, setFull] = useState<FullFiles | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [pinned, setPinned] = useState<Pinned[]>([]);
  const [printing, setPrinting] = useState(false);
  const [editing, setEditing] = useState(!start.doc);

  useEffect(() => {
    loadRoute(start.network, start.ref)
      .then((f) => {
        setFiles(f);
        const init = initialInputs(f, start.inputs);
        setInputs(init.inputs);
        setSuggested(init.suggested);
        document.title = `${f.manifest.route.name} · Kilometrica Plan`;
        if (start.doc && start.doc.route.runId !== f.manifest.run_id) {
          setError(null);
        }
      })
      .catch((e: Error) => setError(e.message));
  }, [start]);

  const blockKey = inputs ? `${Math.floor(Math.min(inputs.fromM, inputs.toM) / 50_000)}-${Math.ceil(Math.max(inputs.fromM, inputs.toM) / 50_000)}` : "";
  useEffect(() => {
    if (!files || !inputs || !pass) return;
    let live = true;
    loadFull(start.network, start.ref, files.manifest.run_id, inputs.fromM, inputs.toM)
      .then((f) => live && setFull(f))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
    // Re-fetched only when the stretch crosses into other 50 km blocks (D31).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, blockKey, pass]);

  const data: PlanData | null = useMemo(() => (files ? { ...files.free, full: pass && full ? full.full : null } : null), [files, full, pass]);
  const plan = useMemo(() => (data && inputs ? makePlan(data, inputs, choices) : null), [data, inputs, choices]);
  const doc = useMemo(() => (plan ? toDocument(plan, { ...meta, name: meta.name || plan.brief.title }) : null), [plan, meta]);

  // Plans stay on this device (principle 5); a shared plan is kept only when the rider asks.
  useEffect(() => {
    if (!doc || readOnly) return;
    savePlan(doc);
    if (!new URLSearchParams(window.location.search).has("plan")) window.history.replaceState(null, "", `/plan?plan=${doc.id}`);
  }, [doc, readOnly]);

  const edit = useCallback((next: PlanInputs, confirm?: boolean) => {
    setInputs(next);
    if (confirm) setDatesConfirmed(true);
    // New inputs re-plan the days; nights the rider locked or booked stay.
    setChoices((c) => ({ ...c, nights: undefined }));
  }, []);
  const choose = (f: (c: PlanChoices) => PlanChoices, replan = true) => setChoices((c) => ({ ...f(c), nights: replan ? undefined : c.nights }));

  const onOption = (item: PlanItem, id: string) => {
    if (!inputs) return;
    if (id === "keep") return choose((c) => ({ ...c, dismissed: [...c.dismissed, item.id] }), false);
    if (id === "add-day") return edit({ ...inputs, days: inputs.days + 1 });
    if (id.startsWith("days:")) return edit({ ...inputs, days: Number(id.slice(5)) });
    if (id.startsWith("earlier:")) return edit({ ...inputs, startMinutes: Math.max(5 * 60, inputs.startMinutes - Number(id.slice(8))) });
    if (id.startsWith("rest:")) return edit({ ...inputs, restAfter: [...new Set([...inputs.restAfter, Number(id.slice(5))])] });
    if (id.startsWith("move:")) return setSelected(Number(id.slice(5)));
  };

  if (error) return <div className="rider center error">{error}</div>;
  if (!files || !inputs || !plan || !data || !doc) return <div className="rider center muted">Loading the route…</div>;
  if (printing) return <TripBook plan={plan} data={data} onDone={() => setPrinting(false)} />;

  const free = !data.full;
  const calls = plan.items.filter((i) => i.kind === "call" && !choices.dismissed.includes(i.id));
  const day = plan.days.find((d) => d.number === selected) ?? null;
  const origin = window.location.origin;
  const links = { full: `${origin}/plan#${shareFragment(doc)}`, itinerary: `${origin}/plan#${shareFragment(itineraryOf(plan, doc.name))}` };
  const isPrivate = files.manifest.visibility === "private";
  const stale = start.doc && start.doc.route.runId !== files.manifest.run_id;
  const lockNight = (k: number, id: string) => choose((c) => ({ ...c, locked: { ...c.locked, [k]: id } }));

  const onExport = (k: ExportKind) => {
    const name = fileSafe(doc.name);
    if (k === "trip-book") return setPrinting(true);
    if (k === "trip-gpx") return download(`${name}.gpx`, "application/gpx+xml", tripGpx(plan, files.geometry));
    if (k === "ics") return download(`${name}.ics`, "text/calendar", calendarFile(plan, doc.id));
    download(`${name}.kilometrica.json`, "application/json", JSON.stringify(doc, null, 2));
  };
  const onGpx = (d: DayPlan) => download(`${fileSafe(doc.name)}-day-${d.number}.gpx`, "application/gpx+xml", dayGpx(plan, files.geometry, d));

  return (
    <div className={`rider plan ${selected !== null ? "has-day" : ""}`}>
      <header className="rider-bar">
        <a className="brand" href="/plan">
          Kilometrica
        </a>
        <span className="muted"> Plan · {files.manifest.route.name}</span>
        <span className="spacer" />
        <label className="pass" title="Prototype switch: the teaser shows the outline only (D45)">
          <input
            type="checkbox"
            checked={pass}
            onChange={(e) => {
              setPass(e.target.checked);
              try {
                localStorage.setItem(PASS_KEY, e.target.checked ? "1" : "0");
              } catch {
                /* not remembered */
              }
            }}
          />
          Trip Pass <span className="muted">(prototype)</span>
        </label>
      </header>
      {readOnly && (
        <div className="banner">
          A shared plan, read-only.{" "}
          <button
            type="button"
            onClick={() => {
              setMeta((m) => ({ ...m, id: newId() }));
              setReadOnly(false);
            }}
          >
            Keep a copy on this device
          </button>
        </div>
      )}
      {stale && <div className="banner muted">This plan was made on an earlier audit of the route; it has been re-timed on the current one.</div>}
      {pass && !full && <div className="banner muted">Loading the Trip Pass detail for this stretch…</div>}
      {full?.truncated && <div className="banner">Too many places on this stretch to load them all: some are missing.</div>}

      <div className="plan-grid">
        <aside className="plan-side">
          {editing && !readOnly ? (
            <section className="ask">
              <h2>A few questions</h2>
              <Questions
                inputs={inputs}
                levels={data.dream.levels}
                daily={data.daily}
                suggestedMonth={suggested}
                datesConfirmed={datesConfirmed}
                readOnly={readOnly}
                onChange={edit}
              />
              <button type="button" className="primary" onClick={() => setEditing(false)}>
                Show the plan
              </button>
            </section>
          ) : (
            <div className="answers">
              {dayText(inputs.startDate)} · {inputs.days} riding days · level {inputs.level} · {inputs.sleep} · {inputs.bike}
              {!readOnly && (
                <button type="button" className="link" onClick={() => setEditing(true)}>
                  Change
                </button>
              )}
            </div>
          )}
          <Brief plan={plan} onLine={() => setSelected(null)} />
          <EffortChart plan={plan} selected={selected} onPick={setSelected} />
          <Calls calls={calls} free={free} readOnly={readOnly} onOption={onOption} />
          <section className="days">
            <h2>The days</h2>
            <DayList plan={plan} selected={selected} onPick={setSelected} free={free} />
          </section>
          <BeforeYouGo
            plan={plan}
            free={free}
            readOnly={readOnly}
            isPrivate={isPrivate}
            done={choices.done}
            onDone={(id) => choose((c) => ({ ...c, done: c.done.includes(id) ? c.done.filter((x) => x !== id) : [...c.done, id] }), false)}
            onExport={onExport}
            links={links}
          />
          {!readOnly && (
            <section className="pin">
              <button
                type="button"
                onClick={() => setPinned((p) => [...p.slice(-1), { label: `Plan ${String.fromCharCode(65 + p.length)}: ${inputs.days} days, ${inputs.sleep}`, inputs, choices }])}
              >
                Pin this plan to compare
              </button>
              <span className="muted small"> then change the days, how you sleep or the direction.</span>
            </section>
          )}
          <Compare data={data} current={plan} pinned={pinned} onUnpin={(i) => setPinned((p) => p.filter((_, j) => j !== i))} />
        </aside>
        <section className="plan-main">
          <PlanMap geometry={files.geometry} plan={plan} selectedDay={selected} onSelectDay={setSelected} attribution={files.manifest.attribution} />
          <Profile
            plan={plan}
            effort={files.free.effort}
            range={day && day.kind === "ride" ? { t0: day.fromT, t1: day.toT } : null}
            onMoveStop={readOnly || free || day ? undefined : lockNight}
            onPickDay={setSelected}
          />
          {day ? (
            <div className="day-panel">
              <DayCard
                plan={plan}
                data={data}
                day={day}
                free={free}
                readOnly={readOnly}
                choices={choices}
                onLockNight={lockNight}
                onToggleBooked={(k) =>
                  choose((c) => {
                    const booked = c.booked.includes(k) ? c.booked.filter((x) => x !== k) : [...c.booked, k];
                    const stop = plan.nights[k]?.stop.id;
                    const locked = { ...c.locked };
                    if (booked.includes(k) && stop) locked[k] = stop;
                    return { ...c, booked, locked };
                  })
                }
                onChooseBed={(k, id) =>
                  choose((c) => {
                    const beds = { ...c.beds };
                    if (id) beds[k] = id;
                    else delete beds[k];
                    return { ...c, beds };
                  }, false)
                }
                onToggleRest={(r) =>
                  edit({ ...inputs, restAfter: inputs.restAfter.includes(r) ? inputs.restAfter.filter((x) => x !== r) : [...inputs.restAfter, r] })
                }
                onDone={(id) => choose((c) => ({ ...c, done: c.done.includes(id) ? c.done.filter((x) => x !== id) : [...c.done, id] }), false)}
                onGpx={onGpx}
                onClose={() => setSelected(null)}
              />
            </div>
          ) : (
            <p className="hint muted">
              Pick a day for its card.{!readOnly && !free ? " Drag a stop along the profile to move it; that night is then kept." : ""}
            </p>
          )}
        </section>
      </div>
      <footer className="rider-foot muted small">
        Ends {dayText(addDays(plan.endDate, 0))}. Kilometrica doesn't navigate or book: it hands you to the apps and sites that do.
      </footer>
    </div>
  );
}

export function RiderApp() {
  const [{ start, itinerary, error }] = useState(readStart);
  if (error) return <div className="rider center error">{error}</div>;
  if (itinerary) return <ItineraryView it={itinerary} />;
  if (!start) return <StartPage />;
  return <PlanPage start={start} />;
}
