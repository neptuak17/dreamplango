/**
 * Elevation along the trip or one day, in the direction of travel, with the night stops. On a larger screen the
 * stops can be dragged along the profile: on release the stop snaps to the nearest candidate and that night is
 * locked (11.6, "Make it yours").
 */
import type { EffortFile } from "@dpg/contracts";
import type { PlanResult } from "@dpg/planner";
import { useMemo, useRef, useState } from "react";

const W = 1000;
const H = 140;
const PAD = { l: 38, r: 8, t: 10, b: 20 };

/** Elevation at a route measure, from effort.json (null where the terrain is unknown). */
export function eleAt(effort: EffortFile, m: number): number | null {
  const part = effort.parts.find((p) => m >= p.from_m && m <= p.to_m);
  if (!part) return null;
  const i = Math.min(part.ele.length - 2, Math.max(0, Math.floor((m - part.from_m) / effort.step_m)));
  const a = part.ele[i];
  const b = part.ele[i + 1];
  if (a == null || b == null) return null;
  const x0 = part.from_m + i * effort.step_m;
  const x1 = Math.min(part.from_m + (i + 1) * effort.step_m, part.to_m);
  return x1 > x0 ? a + ((b - a) * (m - x0)) / (x1 - x0) : a;
}

interface Props {
  plan: PlanResult;
  effort: EffortFile;
  /** Trip positions shown (metres); the whole trip when null. */
  range: { t0: number; t1: number } | null;
  onMoveStop?: (night: number, stopId: string) => void;
  onPickDay?: (day: number) => void;
}

export function Profile({ plan, effort, range, onMoveStop, onPickDay }: Props) {
  const t0 = range?.t0 ?? 0;
  const t1 = range?.t1 ?? plan.axis.length;
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ night: number; x: number } | null>(null);
  const samples = useMemo(() => {
    const n = 400;
    const out: { t: number; e: number | null }[] = [];
    for (let i = 0; i <= n; i++) {
      const t = t0 + ((t1 - t0) * i) / n;
      out.push({ t, e: eleAt(effort, plan.axis.mOf(t)) });
    }
    return out;
  }, [plan, effort, t0, t1]);
  const known = samples.filter((s) => s.e !== null).map((s) => s.e!);
  const lo = known.length ? Math.min(...known) : 0;
  const hi = known.length ? Math.max(...known, lo + 50) : 100;
  const x = (t: number) => PAD.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.l - PAD.r);
  const y = (e: number) => H - PAD.b - ((e - lo) / Math.max(1, hi - lo)) * (H - PAD.t - PAD.b);
  const tOfX = (px: number) => t0 + ((px - PAD.l) / (W - PAD.l - PAD.r)) * (t1 - t0);

  // The line breaks where the terrain is unknown.
  const paths: string[] = [];
  let cur = "";
  for (const s of samples) {
    if (s.e === null) {
      if (cur) paths.push(cur);
      cur = "";
      continue;
    }
    cur += `${cur ? "L" : "M"}${x(s.t).toFixed(1)},${y(s.e).toFixed(1)}`;
  }
  if (cur) paths.push(cur);

  const nights = plan.nights.map((n) => ({ n, t: plan.candidates.find((c) => c.stop.id === n.stop.id)?.t ?? 0 }));
  const toSvgX = (clientX: number) => {
    const r = svg.current?.getBoundingClientRect();
    return r ? ((clientX - r.left) / r.width) * W : 0;
  };
  const release = () => {
    if (!drag || !onMoveStop) return setDrag(null);
    const t = tOfX(drag.x);
    const prev = drag.night === 0 ? 0 : (nights[drag.night - 1]?.t ?? 0);
    const next = nights[drag.night + 1]?.t ?? plan.axis.length;
    const best = plan.candidates
      .filter((c) => c.t > prev && c.t < next)
      .sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
    if (best) onMoveStop(drag.night, best.stop.id);
    setDrag(null);
  };
  const km = (t: number) => Math.round((t - t0) / 1000);
  const ticks = Array.from({ length: 6 }, (_, i) => t0 + ((t1 - t0) * i) / 5);

  return (
    <svg
      ref={svg}
      className="profile"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      onPointerMove={(e) => drag && setDrag({ ...drag, x: Math.max(PAD.l, Math.min(W - PAD.r, toSvgX(e.clientX))) })}
      onPointerUp={release}
      onPointerLeave={() => drag && release()}
      role="img"
      aria-label="Elevation profile"
    >
      <text x={4} y={PAD.t + 8} className="axis">{Math.round(hi)} m</text>
      <text x={4} y={H - PAD.b} className="axis">{Math.round(lo)} m</text>
      {ticks.map((t) => (
        <text key={t} x={x(t)} y={H - 4} className="axis" textAnchor="middle">
          {km(t)} km
        </text>
      ))}
      {paths.map((d, i) => (
        <path key={i} d={d} className="ele" />
      ))}
      {!range &&
        plan.days
          .filter((d) => d.kind === "ride")
          .map((d) => (
            <rect
              key={d.number}
              x={x(d.fromT)}
              y={PAD.t}
              width={Math.max(0, x(d.toT) - x(d.fromT))}
              height={H - PAD.t - PAD.b}
              className={`day-band ${d.number % 2 ? "odd" : ""}`}
              onClick={() => onPickDay?.(d.number)}
            />
          ))}
      {nights.map(({ n, t }) => {
        if (t < t0 || t > t1) return null;
        const px = drag?.night === n.index ? drag.x : x(t);
        return (
          <g key={n.index} className={`stop-mark ${n.locked ? "locked" : ""}`}>
            <line x1={px} x2={px} y1={PAD.t} y2={H - PAD.b} />
            <circle
              cx={px}
              cy={PAD.t + 8}
              r={8}
              onPointerDown={(e) => {
                if (!onMoveStop) return;
                (e.target as Element).setPointerCapture?.(e.pointerId);
                setDrag({ night: n.index, x: px });
              }}
            >
              <title>{`Night ${n.afterRide}: ${n.stop.name ?? "stop"}${onMoveStop ? " (drag to move)" : ""}`}</title>
            </circle>
            <text x={px} y={PAD.t + 11} textAnchor="middle" className="stop-num">
              {n.afterRide}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
