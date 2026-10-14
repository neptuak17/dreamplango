import type { ProfileFile } from "@dpg/contracts";
import { useMemo } from "react";
import { km } from "./status";

const W = 1000;
const H = 140;

interface Props {
  profile: ProfileFile;
  range: [number, number];
  label: string;
  stats?: { ascent: number | null; descent: number | null; maxGrade: number | null } | null;
}

function pathFor(pts: [number, number | null][], from: number, to: number, min: number, span: number): string {
  let d = "";
  let pen = false;
  for (const [m, e] of pts) {
    if (e === null) {
      pen = false;
      continue;
    }
    const x = ((m - from) / (to - from)) * W;
    const y = H - ((e - min) / span) * (H - 10) - 5;
    d += `${pen ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    pen = true;
  }
  return d;
}

export function Profile({ profile, range, label, stats }: Props) {
  // Audited bundles carry a DEM profile in `ele` and the source GPX elevation alongside for comparison.
  const hasGpx = profile.gpx_ele.length === profile.m.length && !profile.source.startsWith("source GPX");
  const view = useMemo(() => {
    const [from, to] = range;
    const main: [number, number | null][] = [];
    const gpx: [number, number | null][] = [];
    profile.m.forEach((m, i) => {
      if (m >= from && m <= to) {
        main.push([m, profile.ele[i] ?? null]);
        if (hasGpx) gpx.push([m, profile.gpx_ele[i] ?? null]);
      }
    });
    const values = main.map((p) => p[1]).filter((v): v is number => v !== null);
    if (values.length < 2 || to <= from) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const v of values) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const span = Math.max(max - min, 20);
    const ticks = Array.from({ length: 6 }, (_, i) => from + ((to - from) * i) / 5);
    return {
      d: pathFor(main, from, to, min, span),
      dGpx: hasGpx ? pathFor(gpx, from, to, min, span) : "",
      min, max, ticks, from, to,
    };
  }, [profile, range, hasGpx]);

  return (
    <div className="profile">
      <div className="profile-head">
        <strong>{label}</strong>
        {view && (
          <span>
            {Math.round(view.min)}–{Math.round(view.max)} m
            {stats?.ascent != null && ` · ↑ ${stats.ascent.toLocaleString("en-GB")} m ↓ ${stats.descent?.toLocaleString("en-GB")} m`}
            {stats?.maxGrade != null && ` · steepest 500 m ${stats.maxGrade}%`}
          </span>
        )}
        <span className="muted">
          {profile.source}
          {view?.dGpx && " · dashed: source GPX elevation"}
        </span>
      </div>
      {view ? (
        <svg viewBox={`0 0 ${W} ${H + 18}`} preserveAspectRatio="none" role="img" aria-label="Elevation profile">
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
          {view.dGpx && <path d={view.dGpx} className="profile-gpx" vectorEffect="non-scaling-stroke" />}
          <path d={view.d} className="profile-line" vectorEffect="non-scaling-stroke" />
        </svg>
      ) : (
        <div className="muted profile-empty">No elevation data for this range.</div>
      )}
    </div>
  );
}
