import type { ProfileFile } from "@dpg/contracts";
import { useMemo } from "react";
import { km } from "./status";

const W = 1000;
const H = 140;

interface Props {
  profile: ProfileFile;
  range: [number, number];
  label: string;
}

export function Profile({ profile, range, label }: Props) {
  const view = useMemo(() => {
    const [from, to] = range;
    const pts: [number, number | null][] = [];
    profile.m.forEach((m, i) => {
      if (m >= from && m <= to) pts.push([m, profile.ele[i] ?? null]);
    });
    const values = pts.map((p) => p[1]).filter((v): v is number => v !== null);
    if (values.length < 2 || to <= from) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(max - min, 20);
    let ascent = 0;
    let d = "";
    let pen = false;
    let prev: number | null = null;
    for (const [m, e] of pts) {
      if (e === null) {
        pen = false;
        prev = null;
        continue;
      }
      if (prev !== null && e > prev) ascent += e - prev;
      prev = e;
      const x = ((m - from) / (to - from)) * W;
      const y = H - ((e - min) / span) * (H - 10) - 5;
      d += `${pen ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
      pen = true;
    }
    const ticks = Array.from({ length: 6 }, (_, i) => from + ((to - from) * i) / 5);
    return { d, min, max, ascent, ticks, from, to };
  }, [profile, range]);

  return (
    <div className="profile">
      <div className="profile-head">
        <strong>{label}</strong>
        {view && (
          <span>
            {Math.round(view.min)}–{Math.round(view.max)} m · ≈{Math.round(view.ascent).toLocaleString("en-GB")} m
            climbing
          </span>
        )}
        <span className="muted">{profile.source}</span>
      </div>
      {view ? (
        <svg viewBox={`0 0 ${W} ${H + 18}`} preserveAspectRatio="none" role="img" aria-label="Elevation profile">
          <path d={`${view.d}`} className="profile-line" vectorEffect="non-scaling-stroke" />
          {view.ticks.map((t) => {
            const x = ((t - view.from) / (view.to - view.from)) * W;
            return (
              <g key={t}>
                <line x1={x} x2={x} y1={0} y2={H} className="profile-grid" vectorEffect="non-scaling-stroke" />
                <text x={Math.min(Math.max(x, 20), W - 20)} y={H + 14} className="profile-tick">
                  km {km(t)}
                </text>
              </g>
            );
          })}
        </svg>
      ) : (
        <div className="muted profile-empty">No elevation data for this range.</div>
      )}
    </div>
  );
}
