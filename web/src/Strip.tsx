import { useEffect, useRef } from "react";
import { type LayerKey, LAYER_TITLES, PALETTES, type Stretch } from "./layers";

const ROW_H = 12;
const GAP = 3;
const LABEL_W = 150;

interface Props {
  rows: { layer: Exclude<LayerKey, "status">; stretches: Stretch[] }[];
  range: [number, number];
  active: LayerKey;
  onPick: (layer: LayerKey) => void;
}

/** Straight-line diagram: one coloured band per layer along the km axis, aligned with the elevation profile. */
export function Strip({ rows, range, active, onPick }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const dpr = window.devicePixelRatio || 1;
    const width = el.clientWidth;
    const height = rows.length * (ROW_H + GAP);
    el.width = Math.max(1, Math.round(width * dpr));
    el.height = Math.max(1, Math.round(height * dpr));
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    const [m0, m1] = range;
    const span = Math.max(m1 - m0, 1);
    rows.forEach((row, i) => {
      const y = i * (ROW_H + GAP);
      ctx.fillStyle = "#f1f3f5";
      ctx.fillRect(0, y, width, ROW_H);
      const palette = PALETTES[row.layer];
      for (const s of row.stretches) {
        if (s.to_m <= m0 || s.from_m >= m1) continue;
        const x0 = ((Math.max(s.from_m, m0) - m0) / span) * width;
        const x1 = ((Math.min(s.to_m, m1) - m0) / span) * width;
        ctx.fillStyle = palette[s.value] ?? "#ced4da";
        ctx.fillRect(x0, y, Math.max(x1 - x0, 0.6), ROW_H);
      }
    });
  }, [rows, range]);

  return (
    <div className="strip">
      <div className="strip-labels" style={{ width: LABEL_W }}>
        {rows.map((r) => (
          <button
            key={r.layer}
            className={r.layer === active ? "active" : ""}
            style={{ height: ROW_H, marginBottom: GAP }}
            onClick={() => onPick(r.layer)}
            title={`Show ${LAYER_TITLES[r.layer]} on the map`}
          >
            {LAYER_TITLES[r.layer]}
          </button>
        ))}
      </div>
      <canvas ref={canvas} style={{ height: rows.length * (ROW_H + GAP) }} />
    </div>
  );
}
