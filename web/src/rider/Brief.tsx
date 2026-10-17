/**
 * The trip brief (11.6): one screen saying what the rider is taking on. Five fixed lines, one per question, the
 * effort per day against the rider's usual day, the readiness line, and the day list.
 */
import { dayItems, hours, km, type PlanResult } from "@dpg/planner";

const EFFORT_LABEL = { within: "within your level", harder: "a harder day", beyond: "beyond your level" } as const;

export function EffortChart({ plan, selected, onPick }: { plan: PlanResult; selected: number | null; onPick: (n: number) => void }) {
  const max = Math.max(plan.usual.hours * 1.6, ...plan.brief.effort.map((e) => e.hours));
  const usualY = 100 - (plan.usual.hours / max) * 100;
  return (
    <div className="effort-chart" aria-label="Riding hours per day against your usual day">
      <div className="usual" style={{ top: `${usualY}%` }} title={`Your usual day: about ${hours(plan.usual.hours)} riding`} />
      {plan.brief.effort.map((e) => (
        <button
          key={e.day}
          type="button"
          className={`bar ${e.effort} ${selected === e.day ? "selected" : ""}`}
          style={{ height: `${Math.max(4, (e.hours / max) * 100)}%` }}
          title={`Day ${e.day}: ${hours(e.hours)} riding, ${EFFORT_LABEL[e.effort]}`}
          onClick={() => onPick(e.day)}
        />
      ))}
    </div>
  );
}

export function Brief({ plan, onLine, free = false }: { plan: PlanResult; onLine: (topic: string) => void; free?: boolean }) {
  const b = plan.brief;
  return (
    <section className="brief">
      <h1>{b.title}</h1>
      <div className="brief-sub">
        {plan.days.length} days · {b.dates} · {km(b.km)} km · {Math.round(b.climbM).toLocaleString("en-GB")} m ·{" "}
        {b.direction === "forward" ? "as the route runs" : "the other way"}
      </div>
      <p className={`readiness ${plan.items.some((i) => i.kind === "call") ? "calls" : "ready"}`}>{b.readiness}</p>
      <dl className="lines">
        {b.lines.map((l) => (
          <div key={l.topic} className={`line ${l.topic}`}>
            <dt>{l.question}</dt>
            <dd>
              {l.answer}
              {l.more > 0 && !free && (
                <button type="button" className="more" onClick={() => onLine(l.topic)}>
                  +{l.more} more ›
                </button>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <details className="confidence">
        <summary>How well we know these days ›</summary>
        <p>{b.confidence.map((c) => c.charAt(0).toUpperCase() + c.slice(1)).join(". ")}.</p>
        <p className="muted">
          From the audit of {plan.route.name}: OpenStreetMap, Overture, Copernicus terrain and climate, holidays and our bike-carriage
          table, each with its source and date. Where we have no data we say so, and it becomes a check for you.
        </p>
      </details>
    </section>
  );
}

export function DayList({ plan, selected, onPick, free }: { plan: PlanResult; selected: number | null; onPick: (n: number) => void; free: boolean }) {
  return (
    <ol className="day-list">
      {plan.days.map((d) => {
        const mine = dayItems(plan.items, d.number);
        const count = mine.calls.length + mine.todos.length + mine.headsups.shown.length + mine.headsups.more;
        return (
          <li key={d.number} className={`${selected === d.number ? "selected" : ""} ${d.kind}`}>
            <button type="button" onClick={() => onPick(d.number)}>
              <span className="d-num">Day {d.number}</span>
              <span className="d-date">{d.date.slice(5).replace("-", "/")}</span>
              <span className="d-route">
                {d.kind === "rest" ? `Rest day at ${d.endName}` : `${d.number === 1 ? d.startName : ""}${d.number === 1 ? " → " : "→ "}${d.endName}`}
              </span>
              {d.kind === "ride" && (
                <>
                  <span className="d-km">{km(d.km)} km</span>
                  <span className="d-h">{hours(d.hoursSlow)}</span>
                  <span className={`d-effort ${d.effort}`} title={EFFORT_LABEL[d.effort]} />
                  {!free && count > 0 && <span className="d-count">{count}</span>}
                </>
              )}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
