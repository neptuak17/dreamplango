import { useEffect, useRef } from "react";
import type { Stretch } from "./layers";

const ROW_H = 12;
const GAP = 3;
const LABEL_W = 150;

export interface StripRow {
  key: string;
  title: string;
  palette: Record<string, string>;
  stretches: Stretch[];
  /** Optional divider above this row. */
  separated?: boolean;
}

interface Props {
  rows: StripRow[];
  range: [number, number];
  active: string | null;
  onPick: (key: string) => void;
  /** Click on the bands: path measure under the pointer. */
  onPickM?: (m: number) => void;
  /** Path measure to mark with a vertical line (e.g. the "ahead from" position). */
  marker?: number | null;
}

const SEPARATOR = 6;

function rowTop(rows: StripRow[], i: number): number {
  let y = 0;
  for (let j = 0; j <= i; j++) {
    if (rows[j]!.separated) y += SEPARATOR;
    if (j < i) y += ROW_H + GAP;
  }
  return y;
}

/** Straight-line diagram: one coloured band per layer along the km axis, aligned with the elevation profile. */
export function Strip({ rows, range, active, onPick, onPickM, marker }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const height = rows.length ? rowTop(rows, rows.length - 1) + ROW_H : 0;

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const dpr = window.devicePixelRatio || 1;
    const width = el.clientWidth;
    el.width = Math.max(1, Math.round(width * dpr));
    el.height = Math.max(1, Math.round(height * dpr));
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    const [m0, m1] = range;
    const span = Math.max(m1 - m0, 1);
    rows.forEach((row, i) => {
      const y = rowTop(rows, i);
      ctx.fillStyle = "#f1f3f5";
      ctx.fillRect(0, y, width, ROW_H);
      for (const s of row.stretches) {
        if (s.to_m <= m0 || s.from_m >= m1) continue;
        const x0 = ((Math.max(s.from_m, m0) - m0) / span) * width;
        const x1 = ((Math.min(s.to_m, m1) - m0) / span) * width;
        ctx.fillStyle = row.palette[s.value] ?? "#ced4da";
        ctx.fillRect(x0, y, Math.max(x1 - x0, 0.6), ROW_H);
      }
    });
    if (marker != null && marker >= m0 && marker <= m1) {
      const x = ((marker - m0) / span) * width;
      ctx.fillStyle = "#1c7ed6";
      ctx.fillRect(x - 1, 0, 2, height);
    }
  }, [rows, range, height, marker]);

  return (
    <div className="strip">
      <div className="strip-labels" style={{ width: LABEL_W }}>
        {rows.map((r) => (
          <button
            key={r.key}
            className={r.key === active ? "active" : ""}
            style={{ height: ROW_H, marginBottom: GAP, marginTop: r.separated ? SEPARATOR : 0 }}
            onClick={() => onPick(r.key)}
            title={`Show ${r.title} on the map`}
          >
            {r.title}
          </button>
        ))}
      </div>
      <canvas
        ref={canvas}
        style={{ height, cursor: onPickM ? "crosshair" : undefined }}
        onClick={(e) => {
          if (!onPickM) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const t = (e.clientX - rect.left) / Math.max(rect.width, 1);
          onPickM(range[0] + t * (range[1] - range[0]));
        }}
      />
    </div>
  );
}
