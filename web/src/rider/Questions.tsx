/**
 * Step 1 (11.6): a few questions, each with a default, asked only because they change the plan. Dream suggested the
 * stretch, time frame, days and level; the dates are confirmed here (D48). Pace comes from the level and the bike,
 * never from fitness data (D35).
 */
import type { DailySection, RiderLevel } from "@dpg/contracts";
import { clock, MONTHS_LONG, type PlanInputs } from "@dpg/planner";

interface Props {
  inputs: PlanInputs;
  levels: RiderLevel[];
  daily: DailySection[];
  /** The month Dream suggested, until the rider confirms a date. */
  suggestedMonth: number | null;
  datesConfirmed: boolean;
  readOnly: boolean;
  onChange: (next: PlanInputs, confirmDates?: boolean) => void;
}

const SLEEP = [
  ["rooms", "Rooms"],
  ["camping", "Camping"],
  ["mix", "Either"],
] as const;
const BIKES = [
  ["touring", "Touring"],
  ["road", "Road"],
  ["gravel", "Gravel"],
  ["ebike", "E-bike"],
] as const;
const STOPS = [
  ["short", "Short"],
  ["normal", "Normal"],
  ["long", "Long"],
] as const;

function Segmented<T extends string>({ value, options, onPick, disabled }: { value: T; options: readonly (readonly [T, string])[]; onPick: (v: T) => void; disabled: boolean }) {
  return (
    <span className="seg">
      {options.map(([v, label]) => (
        <button key={v} type="button" className={value === v ? "on" : ""} disabled={disabled} onClick={() => onPick(v)}>
          {label}
        </button>
      ))}
    </span>
  );
}

export function Questions({ inputs, levels, daily, suggestedMonth, datesConfirmed, readOnly, onChange }: Props) {
  const set = <K extends keyof PlanInputs>(k: K, v: PlanInputs[K]) => onChange({ ...inputs, [k]: v });
  const sections = [...daily].sort((a, b) => a.from_m - b.from_m);
  const first = sections.find((s) => Math.abs(s.from_m - inputs.fromM) < 1) ?? sections[0];
  const last = sections.find((s) => Math.abs(s.to_m - inputs.toM) < 1) ?? sections[sections.length - 1];
  const setRange = (a: number, b: number) => {
    const sa = sections.find((s) => s.number === a);
    const sb = sections.find((s) => s.number === b);
    if (!sa || !sb) return;
    onChange({ ...inputs, fromM: Math.min(sa.from_m, sb.from_m), toM: Math.max(sa.to_m, sb.to_m) });
  };
  return (
    <div className="questions">
      <label className={`q-date ${datesConfirmed ? "" : "attention"}`}>
        <span>Start date</span>
        <input type="date" value={inputs.startDate} disabled={readOnly} onChange={(e) => e.target.value && onChange({ ...inputs, startDate: e.target.value }, true)} />
        {!datesConfirmed && suggestedMonth !== null && <em>Dream suggested {MONTHS_LONG[suggestedMonth]}: confirm your start date.</em>}
      </label>
      <label>
        <span>Riding days</span>
        <input type="number" min={1} max={60} value={inputs.days} disabled={readOnly} onChange={(e) => set("days", Math.max(1, Math.min(60, Number(e.target.value) || 1)))} />
      </label>
      <label>
        <span>Level</span>
        <select value={inputs.level} disabled={readOnly} onChange={(e) => set("level", Number(e.target.value))}>
          {levels.map((l) => (
            <option key={l.level} value={l.level}>
              {l.level} {l.name} ({l.km_min}–{l.km_max} km, up to {l.climb_max_m} m)
            </option>
          ))}
        </select>
      </label>
      <div className="q-row">
        <span>How you sleep</span>
        <Segmented value={inputs.sleep} options={SLEEP} disabled={readOnly} onPick={(v) => set("sleep", v)} />
      </div>
      <div className="q-row">
        <span>Your bike</span>
        <Segmented value={inputs.bike} options={BIKES} disabled={readOnly} onPick={(v) => set("bike", v)} />
      </div>
      <label>
        <span>Leave at</span>
        <input
          type="time"
          step={900}
          value={clock(inputs.startMinutes)}
          disabled={readOnly}
          onChange={(e) => {
            const [h, m] = e.target.value.split(":").map(Number);
            if (h !== undefined && m !== undefined) set("startMinutes", h * 60 + m);
          }}
        />
      </label>
      <div className="q-row">
        <span>Stops</span>
        <Segmented value={inputs.stopStyle} options={STOPS} disabled={readOnly} onPick={(v) => set("stopStyle", v)} />
      </div>
      <details className="q-more">
        <summary>Stretch and preferences</summary>
        <label>
          <span>From section</span>
          <select value={first?.number} disabled={readOnly} onChange={(e) => setRange(Number(e.target.value), last?.number ?? Number(e.target.value))}>
            {sections.map((s) => (
              <option key={s.number} value={s.number}>
                {s.number}: {s.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>To section</span>
          <select value={last?.number} disabled={readOnly} onChange={(e) => setRange(first?.number ?? Number(e.target.value), Number(e.target.value))}>
            {sections.map((s) => (
              <option key={s.number} value={s.number}>
                {s.number}: {s.title}
              </option>
            ))}
          </select>
        </label>
        <div className="q-row">
          <span>Direction</span>
          <Segmented
            value={inputs.direction}
            options={[
              ["forward", "As the route runs"],
              ["reverse", "The other way"],
            ]}
            disabled={readOnly}
            onPick={(v) => set("direction", v)}
          />
        </div>
        <label className="check">
          <input type="checkbox" checked={inputs.avoidBusy} disabled={readOnly} onChange={(e) => set("avoidBusy", e.target.checked)} />
          Rather avoid busy roads
        </label>
        <label className="check">
          <input type="checkbox" checked={inputs.avoidGravel} disabled={readOnly} onChange={(e) => set("avoidGravel", e.target.checked)} />
          Rather avoid gravel
        </label>
      </details>
    </div>
  );
}
