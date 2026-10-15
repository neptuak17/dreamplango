import type { ProfileFile } from "@dpg/contracts";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Stretch } from "./layers";
import { km } from "./status";

/** Width of the label column shared by the profile's height axis and the strip rows, so both plot on one km axis. */
export const LABEL_W = 150;
const PROFILE_H = 130;
const AXIS_H = 18;
const ROW_H = 12;
const ROW_GAP = 3;
const SEPARATOR = 6;

export interface StripRow {
  key: string;
  title: string;
  palette: Record<string, string>;
  stretches: Stretch[];
  /** Readout text for the stretch under the cursor (defaults to its value). */
  describe?: (s: Stretch) => string;
  /** Tooltip for the row label (defaults to "Show <title> on the map"). */
  hint?: string;
  /** Divider above this row. */
  separated?: boolean;
}

interface Props {
  profile: ProfileFile;
  range: [number, number];
  label: string;
  stats?: { ascent: number | null; descent: number | null; maxGrade: number | null } | null;
  rows: StripRow[];
  active: string | null;
  onPick: (key: string) => void;
  /** Click on the plot: the path measure under the pointer. */
  onPickM?: (m: number) => void;
  /** Path measure to mark with a vertical line (the "ahead" position). */
  marker?: number | null;
}

function rowTop(rows: StripRow[], i: number): number {
  let y = 0;
  for (let j = 0; j <= i; j++) {
    if (rows[j]!.separated) y += SEPARATOR;
    if (j < i) y += ROW_H + ROW_GAP;
  }
  return y;
}

/** Tick spacing giving about six labelled ticks over the span, in round kilometres. */
function tickStep(spanM: number): number {
  const steps = [100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 50_000, 100_000, 200_000, 500_000, 1_000_000];
  return steps.find((s) => spanM / s <= 7) ?? 1_000_000;
}

function lastAtOrBefore(values: number[], m: number): number {
  let lo = 0;
  let hi = values.length - 1;
  if (hi < 0 || values[0]! > m) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (values[mid]! <= m) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function stretchAt(sorted: Stretch[], starts: number[], m: number): Stretch | null {
  const i = lastAtOrBefore(starts, m);
  const s = i >= 0 ? sorted[i] : undefined;
  return s && m < s.to_m ? s : null;
}

function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const obs = new ResizeObserver(() => setWidth(el.clientWidth));
    obs.observe(el);
    return () => obs.disconnect();
  }, [ref]);
  return width;
}

/** Elevation profile and layer strips on one shared kilometre axis, with a hover cursor and readout. */
export function Track({ profile, range, label, stats, rows, active, onPick, onPickM, marker }: Props) {
  const plot = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const width = useWidth(plot);
  const [hoverM, setHoverM] = useState<number | null>(null);
  const [from, to] = range;
  const span = Math.max(to - from, 1);
  const stripH = rows.length ? rowTop(rows, rows.length - 1) + ROW_H : 0;
  const xOf = (m: number) => ((m - from) / span) * width;

  const hasGpx = profile.gpx_ele.length === profile.m.length && !profile.source.startsWith("source GPX");
  const view = useMemo(() => {
    const main: [number, number | null][] = [];
    const gpx: [number, number | null][] = [];
    profile.m.forEach((m, i) => {
      if (m >= from && m <= to) {
        main.push([m, profile.ele[i] ?? null]);
        if (hasGpx) gpx.push([m, profile.gpx_ele[i] ?? null]);
      }
    });
    const values = main.map((p) => p[1]).filter((v): v is number => v !== null);
    if (values.length < 2) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    return { main, gpx, min, max, range: Math.max(max - min, 20) };
  }, [profile, from, to, hasGpx]);

  const yOf = (e: number) => (view ? PROFILE_H - ((e - view.min) / view.range) * (PROFILE_H - 10) - 5 : 0);
  const pathFor = (pts: [number, number | null][]) => {
    let d = "";
    let pen = false;
    for (const [m, e] of pts) {
      if (e === null) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${xOf(m).toFixed(1)},${yOf(e).toFixed(1)}`;
      pen = true;
    }
    return d;
  };

  const step = tickStep(span);
  const ticks: number[] = [];
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) ticks.push(t);

  const sortedRows = useMemo(
    () =>
      rows.map((r) => {
        const sorted = [...r.stretches].sort((a, b) => a.from_m - b.from_m);
        return { row: r, sorted, starts: sorted.map((s) => s.from_m) };
      }),
    [rows],
  );

  useEffect(() => {
    const el = canvas.current;
    if (!el || width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.max(1, Math.round(width * dpr));
    el.height = Math.max(1, Math.round(stripH * dpr));
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, stripH);
    rows.forEach((row, i) => {
      const y = rowTop(rows, i);
      ctx.fillStyle = "#f1f3f5";
      ctx.fillRect(0, y, width, ROW_H);
      for (const s of row.stretches) {
        if (s.to_m <= from || s.from_m >= to) continue;
        const x0 = ((Math.max(s.from_m, from) - from) / span) * width;
        const x1 = ((Math.min(s.to_m, to) - from) / span) * width;
        ctx.fillStyle = row.palette[s.value] ?? "#ced4da";
        ctx.fillRect(x0, y, Math.max(x1 - x0, 0.6), ROW_H);
      }
    });
  }, [rows, from, to, span, width, stripH]);

  const mAt = (clientX: number) => {
    const rect = plot.current!.getBoundingClientRect();
    const t = Math.min(Math.max((clientX - rect.left) / Math.max(rect.width, 1), 0), 1);
    return from + t * span;
  };

  let readout: React.ReactNode = (
    <span className="muted">Hover for details at a point{onPickM ? "; click to set the “Ahead” position" : ""}.</span>
  );
  if (hoverM !== null) {
    const i = lastAtOrBefore(profile.m, hoverM);
    const ele = i >= 0 ? profile.ele[i] : null;
    const parts = sortedRows.flatMap(({ row, sorted, starts }) => {
      const s = stretchAt(sorted, starts, hoverM);
      if (!s) return [];
      return [
        <span key={row.key} className="readout-item">
          <span className="swatch" style={{ "--c": row.palette[s.value] ?? "#ced4da" } as React.CSSProperties} />
          {row.describe ? row.describe(s) : s.value}
        </span>,
      ];
    });
    readout = (
      <>
        <b>
          km {km(hoverM, 1)}
          {ele != null ? ` · ${Math.round(ele)} m` : ""}
        </b>
        {parts}
      </>
    );
  }

  return (
    <div className="track">
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
          {hasGpx && " · dashed: source GPX elevation"}
        </span>
      </div>
      <div className="track-readout">{readout}</div>
      <div className="track-body" style={{ gridTemplateColumns: `${LABEL_W}px minmax(0, 1fr)` }}>
        <div className="track-labels">
          <div className="track-axis" style={{ height: PROFILE_H }}>
            {view && (
              <>
                <span>{Math.round(view.max)} m</span>
                <span>{Math.round(view.min)} m</span>
              </>
            )}
          </div>
          <div style={{ height: AXIS_H }} />
          {rows.map((r) => (
            <button
              key={r.key}
              className={r.key === active ? "active" : ""}
              style={{ height: ROW_H, marginBottom: ROW_GAP, marginTop: r.separated ? SEPARATOR : 0 }}
              onClick={() => onPick(r.key)}
              title={r.hint ?? `Show ${r.title} on the map`}
            >
              {r.title}
            </button>
          ))}
        </div>
        <div
          className="track-plot"
          ref={plot}
          style={{ cursor: onPickM ? "crosshair" : "default" }}
          onMouseMove={(e) => setHoverM(mAt(e.clientX))}
          onMouseLeave={() => setHoverM(null)}
          onClick={(e) => onPickM?.(mAt(e.clientX))}
        >
          <svg width={width} height={PROFILE_H + AXIS_H} role="img" aria-label="Elevation profile">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={xOf(t)} x2={xOf(t)} y1={0} y2={PROFILE_H} className="profile-grid" />
                <text x={Math.min(Math.max(xOf(t), 24), width - 24)} y={PROFILE_H + 13} className="profile-tick">
                  km {km(t, step < 1000 ? 1 : 0)}
                </text>
              </g>
            ))}
            {view && hasGpx && <path d={pathFor(view.gpx)} className="profile-gpx" />}
            {view && <path d={pathFor(view.main)} className="profile-line" />}
            {!view && (
              <text x={width / 2} y={PROFILE_H / 2} className="profile-tick">
                No elevation data for this range.
              </text>
            )}
          </svg>
          <canvas ref={canvas} style={{ width, height: stripH }} />
          {marker != null && marker >= from && marker <= to && (
            <div className="track-line marker" style={{ left: xOf(marker) }} />
          )}
          {hoverM !== null && <div className="track-line hover" style={{ left: xOf(hoverM) }} />}
        </div>
      </div>
    </div>
  );
}
