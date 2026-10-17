/**
 * Step 3 (11.6): the decisions only the rider can make, one at a time, each with its options worked out and what
 * each option changes. In the teaser they are counted, not shown (D45).
 */
import type { PlanItem } from "@dpg/planner";
import { useState } from "react";

interface Props {
  calls: PlanItem[];
  free: boolean;
  readOnly: boolean;
  onOption: (item: PlanItem, optionId: string) => void;
}

export function Calls({ calls, free, readOnly, onOption }: Props) {
  const [index, setIndex] = useState(0);
  if (!calls.length) return null;
  if (free) {
    return (
      <section className="calls locked">
        <h2>{calls.length === 1 ? "1 thing needs your call" : `${calls.length} things need your call`}</h2>
        <p className="muted">The decisions and their options come with a Trip Pass.</p>
      </section>
    );
  }
  const i = Math.min(index, calls.length - 1);
  const call = calls[i]!;
  return (
    <section className="calls">
      <h2>
        Your call {calls.length > 1 && <span className="muted">{i + 1} of {calls.length}</span>}
      </h2>
      <div className="call">
        <div className="call-title">{call.title}</div>
        <div className="call-why">{call.why}</div>
        {!readOnly && (
          <div className="call-options">
            {(call.options ?? []).map((o) => (
              <button key={o.id} type="button" onClick={() => onOption(call, o.id)} title={o.effect}>
                <b>{o.label}</b>
                <span>{o.effect}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {calls.length > 1 && (
        <div className="call-nav">
          <button type="button" disabled={i === 0} onClick={() => setIndex(i - 1)}>
            ‹ Previous
          </button>
          <button type="button" disabled={i === calls.length - 1} onClick={() => setIndex(i + 1)}>
            Next ›
          </button>
        </div>
      )}
    </section>
  );
}
