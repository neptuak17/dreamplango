/**
 * A day card (11.6): one day in the rider's own terms. In the teaser it shows the outline only (D45); with the Trip
 * Pass, water and food, heads-ups, highlights, where to sleep (beds with their links, D48), plan B and bail-out.
 */
import type { Place } from "@dpg/contracts";
import {
  bedsFor,
  clock,
  day as dayText,
  dayItems,
  dayStory,
  hours,
  km,
  MONTHS_LONG,
  monthOf,
  placeLinks,
  type DayPlan,
  type Handoff,
  type PlanData,
  type PlanItem,
  type PlanResult,
  stopName,
} from "@dpg/planner";
import { useState } from "react";

const EFFORT = { within: "within your level", harder: "a harder day", beyond: "beyond your level" } as const;

export function Links({ links }: { links: Handoff[] }) {
  if (!links.length) return null;
  return (
    <span className="links">
      {links.map((l) => (
        <a key={l.url} href={l.url} target="_blank" rel="noreferrer noopener">
          {l.label}
        </a>
      ))}
    </span>
  );
}

function ItemList({ items, more, done, onDone, label }: { items: PlanItem[]; more: number; done?: string[]; onDone?: (id: string) => void; label: string }) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  return (
    <div className="item-list">
      <div className="label">{label}</div>
      <ul>
        {items.map((i) => (
          <li key={i.id} className={done?.includes(i.id) ? "done" : ""}>
            {onDone && <input type="checkbox" checked={done?.includes(i.id) ?? false} onChange={() => onDone(i.id)} aria-label="Done" />}
            <details>
              <summary>{i.title}</summary>
              <p>{i.why}</p>
              {i.evidence.source && <p className="source">Source: {i.evidence.source}</p>}
            </details>
            <Links links={i.handoffs} />
          </li>
        ))}
      </ul>
      {more > 0 && !open && (
        <button type="button" className="more" onClick={() => setOpen(true)}>
          +{more} more
        </button>
      )}
    </div>
  );
}

interface Props {
  plan: PlanResult;
  data: PlanData;
  day: DayPlan;
  free: boolean;
  readOnly: boolean;
  choices: { done: string[]; booked: number[]; beds: Record<number, string> };
  onLockNight: (night: number, stopId: string) => void;
  onToggleBooked: (night: number) => void;
  onChooseBed: (night: number, placeId: string | null) => void;
  onToggleRest: (ride: number) => void;
  onDone: (id: string) => void;
  onGpx: (day: DayPlan) => void;
  onClose?: () => void;
}

function dayPlaces(data: PlanData, d: DayPlan, services: string[], counting = true): Place[] {
  const lo = Math.min(d.fromM, d.toM);
  const hi = Math.max(d.fromM, d.toM);
  return (data.full?.places ?? []).filter((p) => services.includes(p.service) && (!counting || p.counts) && p.access_at_m >= lo && p.access_at_m <= hi);
}

export function DayCard({ plan, data, day: d, free, readOnly, choices, onLockNight, onToggleBooked, onChooseBed, onToggleRest, onDone, onGpx, onClose }: Props) {
  const mine = dayItems(plan.items, d.number);
  const night = plan.nights.find((n) => n.afterRide === d.ride && d.kind === "ride");
  const kmOf = (m: number) => Math.max(0, (plan.axis.tOf(m) - d.fromT) / 1000);
  const range = d.hoursFast !== d.hoursSlow && Math.abs(d.hoursSlow - d.hoursFast) > 0.05;
  const ride = d.kind === "ride";
  const isLastRide = d.ride === plan.inputs.days;

  const waterFood = free ? [] : dayPlaces(data, d, ["water", "food"]).map((p) => ({ p, at: kmOf(p.access_at_m) })).sort((a, b) => a.at - b.at);
  const thinned: { p: Place; at: number }[] = [];
  for (const w of waterFood) if (!thinned.length || w.at - thinned[thinned.length - 1]!.at >= 5) thinned.push(w);
  let longest = 0;
  const pts = [0, ...waterFood.map((w) => w.at), d.km];
  for (let i = 1; i < pts.length; i++) longest = Math.max(longest, pts[i]! - pts[i - 1]!);
  const stations = free
    ? []
    : dayPlaces(data, d, ["station"], false)
        .filter((p) => ["yes", "reservation", "limited"].includes(String(p.detail.bikes)) && (p.access_m ?? 1e9) <= 10_000)
        .map((p) => ({ p, at: kmOf(p.access_at_m) }))
        .sort((a, b) => a.at - b.at);
  const beds =
    !free && night
      ? (data.full?.places ?? [])
          .filter(
            (p) =>
              p.service === "accommodation" &&
              p.counts &&
              Math.abs(p.access_at_m - night.stop.at_m) <= 5000 &&
              (plan.inputs.sleep === "mix" || (plan.inputs.sleep === "camping") === (p.kind === "campsite")) &&
              p.months[monthOf(night.date)] !== "c",
          )
          .sort((a, b) => {
            const known = (p: Place) => (["o", "p"].includes(p.months[monthOf(night.date)] ?? "?") ? 0 : 1);
            return known(a) - known(b) || (a.access_m ?? 0) - (b.access_m ?? 0);
          })
      : [];
  const chosen = night ? choices.beds[night.index] : undefined;
  const month = night ? MONTHS_LONG[monthOf(night.date)] : "";

  return (
    <article className={`day-card ${d.kind}`}>
      <header>
        {onClose && (
          <button type="button" className="close" onClick={onClose} aria-label="Back to the trip">
            ‹ Trip
          </button>
        )}
        <div className="eyebrow">
          Day {d.number} · {dayText(d.date)}
        </div>
        <h2>{ride ? `${d.startName} → ${d.endName}` : `Rest day at ${d.endName}`}</h2>
        {ride && (
          <div className="numbers">
            <b>{km(d.km)} km</b> · {Math.round(d.climbM)} m{d.unknownKm >= 1 ? ` (at least: terrain unknown for ${km(d.unknownKm)} km)` : ""} ·{" "}
            <span className={`effort ${d.effort}`}>{EFFORT[d.effort]}</span>
          </div>
        )}
      </header>
      {ride && (
        <div className="times">
          <div>
            {range ? `${hours(d.hoursFast)}–${hours(d.hoursSlow)}` : hours(d.hoursSlow)} riding
            {range && <span className="muted"> (surface unknown on part of the day)</span>}
          </div>
          <div>
            {hours(d.hoursSlow + d.stopsMin / 60)} with stops · leave {clock(d.startMinutes)}, in by {clock(d.endMinutes)}
            {d.sunset !== null && ` · sunset ${clock(d.sunset)}${d.clockApprox ? " (approx.)" : ""}`}
          </div>
          {d.steepest && <div className="muted">Steepest 500 m: {Math.round(d.steepest.grade)}% at km {Math.round(d.steepest.atKm)}</div>}
        </div>
      )}
      <p className="story">“{dayStory(data, d, plan.items)}”</p>

      {free ? (
        <div className="locked">
          Water and food, heads-ups, highlights, where to sleep and the plan B for this day come with a Trip Pass.
        </div>
      ) : (
        <>
          {ride && (
            <div className="water">
              <div className="label">Water and food</div>
              {waterFood.length ? (
                <div>
                  km {thinned.map((w) => Math.round(w.at)).join(" · ")} · longest gap {Math.round(longest)} km
                </div>
              ) : (
                <div>None that counts along this day: you judge what to carry.</div>
              )}
            </div>
          )}
          <ItemList label="Your calls" items={mine.calls} more={0} />
          <ItemList label="Heads-up" items={mine.headsups.shown} more={mine.headsups.more} />
          <ItemList label="Highlights" items={mine.highlights.shown} more={mine.highlights.more} />
          <ItemList label="Before you go" items={mine.todos} more={0} done={choices.done} onDone={readOnly ? undefined : onDone} />
          {night && (
            <div className="sleep">
              <div className="label">Sleep</div>
              <div>
                <b>{stopName(night.stop)}</b>: {night.beds.count ? `${night.beds.count} ${night.beds.count === 1 ? "place" : "places"} of your kind, ${night.beds.open + night.beds.partly} known open in ${month}` : "no known place of your kind"}
                {night.stop.station ? ` · station: ${night.stop.station}` : ""}
              </div>
              <div className="muted">{night.why}</div>
              {beds.length > 0 && (
                <ul className="beds">
                  {beds.slice(0, 6).map((p) => {
                    const code = p.months[monthOf(night.date)];
                    return (
                      <li key={p.id} className={chosen === p.id ? "chosen" : ""}>
                        <span>
                          {p.name ?? "Unnamed"} <span className="muted">· {p.kind.replace("_", " ")}{p.detail.stars ? ` ${String(p.detail.stars)}★` : ""} · {code === "o" ? "open" : code === "p" ? "partly open" : "season unknown"} · {km((p.access_m ?? 0) / 1000)} km off</span>
                        </span>
                        <Links links={placeLinks(p)} />
                        {!readOnly && (
                          <button type="button" onClick={() => onChooseBed(night.index, chosen === p.id ? null : p.id)}>
                            {chosen === p.id ? "Chosen ✓" : "Choose"}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="muted small">Listed by what we know (open first, then by detour), never by quality: we have no prices or reviews.</p>
              <div className="planb">
                Plan B:{" "}
                {[night.planB.before && `${stopName(night.planB.before.stop)}, ${km(Math.abs(night.planB.before.km))} km back`, night.planB.after && `${stopName(night.planB.after.stop)}, ${km(night.planB.after.km)} km on`]
                  .filter(Boolean)
                  .join(" · ") || "no other stop of your kind nearby"}
              </div>
              {!readOnly && (
                <>
                  <div className="night-actions">
                    <label className="check">
                      <input type="checkbox" checked={choices.booked.includes(night.index)} onChange={() => onToggleBooked(night.index)} />
                      Booked (keeps this night when the plan changes)
                    </label>
                  </div>
                  {night.alternatives.length > 0 && (
                    <details className="alts">
                      <summary>Stay somewhere else this night</summary>
                      <ul>
                        {night.alternatives.map((a) => {
                          const b = bedsFor(a.stop, plan.inputs.sleep, monthOf(night.date));
                          return (
                            <li key={a.stop.id}>
                              <button type="button" onClick={() => onLockNight(night.index, a.stop.id)}>
                                {stopName(a.stop)}
                              </button>
                              <span className="muted">
                                {" "}
                                day {km(a.dayKm)} km, next day {a.nextKm === null ? "–" : `${km(a.nextKm)} km`} · {b.count - b.closed} places, {b.open + b.partly} known open
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </details>
                  )}
                </>
              )}
            </div>
          )}
          {ride && stations.length > 0 && (
            <div className="bail">
              <div className="label">Bail-out</div>
              <div>
                {stations
                  .slice(0, 6)
                  .map((s) => `${s.p.name ?? "Station"} (km ${Math.round(s.at)})`)
                  .join(" · ")}
              </div>
            </div>
          )}
        </>
      )}
      {ride && !readOnly && (
        <div className="day-actions">
          {!isLastRide && !free && (
            <label className="check">
              <input type="checkbox" checked={plan.inputs.restAfter.includes(d.ride!)} onChange={() => onToggleRest(d.ride!)} />
              Rest day after this day
            </label>
          )}
          {!free && (
            <button type="button" onClick={() => onGpx(d)}>
              Day GPX
            </button>
          )}
        </div>
      )}
    </article>
  );
}
