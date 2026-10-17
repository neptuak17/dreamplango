/**
 * The trip axis: the stretch as ridden, in the direction of travel, every 100 m (effort.json), with its gaps.
 *
 * A trip position `t` is the distance ridden from the start. An unfilled gap (missing link) and a small digitising
 * break count as ridden at their straight-line distance, with the terrain unknown, however the rider bridges them
 * (D50: not a navigation app). A ferry or a published public-transport link is a leg that isn't ridden.
 */
import type { DreamSection, EffortFile } from "@dpg/contracts";
import { type Rider, stepSeconds } from "./pace";
import type { Direction } from "./types";

export const RIDDEN_GAPS = new Set(["missing", "discontinuity", "unclassified"]);

export interface Seg {
  /** Route measures in the direction of travel. */
  m0: number;
  m1: number;
  /** Ridden metres (0 for a ferry or transport leg). */
  len: number;
  gap: null | { type: string; km: number; atM: number };
  surface: string;
  rise: number | null;
  fast: number;
  slow: number;
  section: number | null;
  tailwind: number | null;
}

export interface Stats {
  km: number;
  climbM: number;
  unknownKm: number;
  fastS: number;
  slowS: number;
  surfaces: { r: number; c: number; g: number; u: number };
  gaps: { type: string; km: number; atM: number }[];
  tailwindMs: number | null;
  sections: number[];
}

function sectionAt(sections: DreamSection[], m: number): DreamSection | null {
  let lo = 0;
  let hi = sections.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = sections[mid]!;
    if (m < s.from_m) hi = mid - 1;
    else if (m > s.to_m) lo = mid + 1;
    else return s;
  }
  return null;
}

type Piece =
  | { kind: "step"; m0: number; m1: number; e0: number | null; e1: number | null; surface: string }
  | { kind: "gap"; at: number; type: string; dist: number };

function pieces(effort: EffortFile, lo: number, hi: number): Piece[] {
  const out: { key: number; order: number; piece: Piece }[] = [];
  const step = effort.step_m;
  for (const part of effort.parts) {
    if (part.to_m <= lo || part.from_m >= hi) continue;
    const n = part.surface.length;
    for (let i = 0; i < n; i++) {
      const a = part.from_m + i * step;
      const b = i === n - 1 ? part.to_m : Math.min(part.from_m + (i + 1) * step, part.to_m);
      if (b <= lo || a >= hi) continue;
      const ea = part.ele[i] ?? null;
      const eb = part.ele[i + 1] ?? null;
      const at = (x: number) => (ea === null || eb === null || b === a ? null : ea + ((eb - ea) * (x - a)) / (b - a));
      const m0 = Math.max(a, lo);
      const m1 = Math.min(b, hi);
      out.push({ key: m0, order: 1, piece: { kind: "step", m0, m1, e0: at(m0), e1: at(m1), surface: part.surface[i] ?? "u" } });
    }
  }
  for (const g of effort.gaps) {
    if (g.at_m <= lo || g.at_m >= hi) continue;
    out.push({ key: g.at_m, order: 0, piece: { kind: "gap", at: g.at_m, type: g.type, dist: g.straight_distance_m } });
  }
  out.sort((x, y) => x.key - y.key || x.order - y.order);
  return out.map((x) => x.piece);
}

export class TripAxis {
  readonly segs: Seg[] = [];
  /** Cumulative values at each segment start (length segs + 1). */
  readonly t: number[] = [0];
  private readonly cum: Record<"fast" | "slow" | "up" | "unknown" | "r" | "c" | "g" | "u" | "wind" | "windLen", number[]>;
  private readonly p0: number[] = [];
  readonly sign: 1 | -1;
  readonly startM: number;
  readonly endM: number;

  constructor(
    effort: EffortFile,
    fromM: number,
    toM: number,
    direction: Direction,
    rider: Rider,
    sections: DreamSection[],
    windAt: (s: DreamSection) => number | null,
  ) {
    const lo = Math.min(fromM, toM);
    const hi = Math.max(fromM, toM);
    this.sign = direction === "forward" ? 1 : -1;
    this.startM = direction === "forward" ? lo : hi;
    this.endM = direction === "forward" ? hi : lo;
    const ordered = [...sections].sort((a, b) => a.from_m - b.from_m);
    let list = pieces(effort, lo, hi);
    if (direction === "reverse") list = list.reverse();
    for (const p of list) {
      if (p.kind === "gap") {
        const ridden = RIDDEN_GAPS.has(p.type);
        const len = ridden ? p.dist : 0;
        const time = stepSeconds(rider, len, null, "u", 0);
        const s = sectionAt(ordered, p.at);
        this.segs.push({
          m0: p.at,
          m1: p.at,
          len,
          gap: { type: p.type, km: p.dist / 1000, atM: p.at },
          surface: "u",
          rise: null,
          fast: time.fast,
          slow: time.slow,
          section: s?.number ?? null,
          tailwind: null,
        });
        continue;
      }
      const fwd = direction === "forward";
      const m0 = fwd ? p.m0 : p.m1;
      const m1 = fwd ? p.m1 : p.m0;
      const e0 = fwd ? p.e0 : p.e1;
      const e1 = fwd ? p.e1 : p.e0;
      const len = Math.abs(m1 - m0);
      const rise = e0 === null || e1 === null ? null : e1 - e0;
      const s = sectionAt(ordered, (m0 + m1) / 2);
      const along = s ? windAt(s) : null;
      const tailwind = along === null ? null : this.sign * along;
      if (p.surface === "f") {
        // A ferry mapped along the track: not ridden.
        this.segs.push({ m0, m1, len: 0, gap: { type: "ferry", km: len / 1000, atM: m0 }, surface: "f", rise: null, fast: 0, slow: 0, section: s?.number ?? null, tailwind: null });
        continue;
      }
      const time = stepSeconds(rider, len, rise, p.surface, tailwind ?? 0);
      this.segs.push({ m0, m1, len, gap: null, surface: p.surface, rise, fast: time.fast, slow: time.slow, section: s?.number ?? null, tailwind });
    }
    const keys = ["fast", "slow", "up", "unknown", "r", "c", "g", "u", "wind", "windLen"] as const;
    this.cum = Object.fromEntries(keys.map((k) => [k, [0]])) as unknown as TripAxis["cum"];
    for (const s of this.segs) {
      const last = (k: (typeof keys)[number]) => this.cum[k][this.cum[k].length - 1]!;
      this.t.push(this.t[this.t.length - 1]! + s.len);
      this.cum.fast.push(last("fast") + s.fast);
      this.cum.slow.push(last("slow") + s.slow);
      this.cum.up.push(last("up") + (s.rise !== null && s.rise > 0 ? s.rise : 0));
      this.cum.unknown.push(last("unknown") + (s.rise === null ? s.len : 0));
      for (const c of ["r", "c", "g", "u"] as const) this.cum[c].push(last(c) + (s.surface === c ? s.len : 0));
      this.cum.wind.push(last("wind") + (s.tailwind === null ? 0 : s.tailwind * s.len));
      this.cum.windLen.push(last("windLen") + (s.tailwind === null ? 0 : s.len));
      this.p0.push(this.sign * s.m0);
    }
  }

  get length(): number {
    return this.t[this.t.length - 1]!;
  }

  /** Trip position of a route measure inside the stretch. */
  tOf(m: number): number {
    const p = this.sign * m;
    let lo = 0;
    let hi = this.segs.length - 1;
    let idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.p0[mid]! <= p) {
        idx = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const s = this.segs[idx];
    if (!s) return 0;
    if (s.gap) return this.t[idx]! + (s.m1 === s.m0 ? 0 : 0);
    const span = Math.abs(s.m1 - s.m0);
    const f = span > 0 ? Math.min(1, Math.max(0, (p - this.sign * s.m0) / span)) : 0;
    return this.t[idx]! + f * s.len;
  }

  /** Route measure at a trip position. */
  mOf(t: number): number {
    const i = this.segAt(t);
    const s = this.segs[i];
    if (!s) return this.endM;
    if (s.len <= 0) return s.m1;
    const f = (t - this.t[i]!) / s.len;
    return s.m0 + (s.m1 - s.m0) * Math.min(1, Math.max(0, f));
  }

  private segAt(t: number): number {
    let lo = 0;
    let hi = this.segs.length - 1;
    let idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.t[mid]! <= t) {
        idx = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    // Skip zero-length legs (ferries) that start exactly at t only when t is past them.
    return idx;
  }

  private at(key: keyof TripAxis["cum"], t: number): number {
    if (t <= 0) return 0;
    if (t >= this.length) return this.cum[key][this.cum[key].length - 1]!;
    const i = this.segAt(t);
    const s = this.segs[i]!;
    const base = this.cum[key][i]!;
    const next = this.cum[key][i + 1]!;
    if (s.len <= 0) return next;
    return base + ((next - base) * (t - this.t[i]!)) / s.len;
  }

  /** Distance, climbing and time between two trip positions, without the lists (fast enough for the planner). */
  quick(t0: number, t1: number): { km: number; climbM: number; fastS: number; slowS: number } {
    return {
      km: (t1 - t0) / 1000,
      climbM: this.at("up", t1) - this.at("up", t0),
      fastS: this.at("fast", t1) - this.at("fast", t0),
      slowS: this.at("slow", t1) - this.at("slow", t0),
    };
  }

  /** The steepest stretch of about `windowM` between two trip positions, in the direction of travel, on known
   * terrain only. Grade in per cent; null when nothing that long is known. */
  steepest(t0: number, t1: number, windowM = 500): { grade: number; t: number } | null {
    let best: { grade: number; t: number } | null = null;
    const win: { len: number; rise: number }[] = [];
    let len = 0;
    let rise = 0;
    for (let i = 0; i < this.segs.length; i++) {
      const s = this.segs[i]!;
      const st = this.t[i]!;
      if (this.t[i + 1]! <= t0) continue;
      if (st >= t1) break;
      if (s.gap || s.rise === null || s.len <= 0) {
        win.length = 0;
        len = 0;
        rise = 0;
        continue;
      }
      win.push({ len: s.len, rise: s.rise });
      len += s.len;
      rise += s.rise;
      while (win.length > 1 && len - win[0]!.len >= windowM) {
        const first = win.shift()!;
        len -= first.len;
        rise -= first.rise;
      }
      if (len >= windowM * 0.95) {
        const grade = (100 * rise) / len;
        if (!best || grade > best.grade) best = { grade, t: st + s.len - len };
      }
    }
    return best;
  }

  /** Totals between two trip positions. Ferries and transport legs belong to the day they start in. */
  stats(t0: number, t1: number, last = false): Stats {
    const d = (k: keyof TripAxis["cum"]) => this.at(k, t1) - this.at(k, t0);
    const len = Math.max(t1 - t0, 1e-9);
    const gaps: Stats["gaps"] = [];
    const sections = new Set<number>();
    for (let i = 0; i < this.segs.length; i++) {
      const s = this.segs[i]!;
      const st = this.t[i]!;
      const en = this.t[i + 1]!;
      if (en < t0 || st > t1) continue;
      if (s.section !== null && en > t0 && st < t1) sections.add(s.section);
      // A gap at a day's boundary belongs to the day that starts there.
      if (s.gap && st >= t0 && (st < t1 || (last && st <= t1))) {
        const prev = gaps[gaps.length - 1];
        if (prev && prev.type === s.gap.type && s.gap.type === "ferry" && Math.abs(prev.atM - s.gap.atM) < 1000 + prev.km * 1000) {
          prev.km += s.gap.km; // a ferry drawn along the track spans many steps
        } else gaps.push({ ...s.gap });
        if (s.section !== null) sections.add(s.section);
      }
    }
    const windLen = d("windLen");
    return {
      km: (t1 - t0) / 1000,
      climbM: d("up"),
      unknownKm: d("unknown") / 1000,
      fastS: d("fast"),
      slowS: d("slow"),
      surfaces: { r: d("r") / len, c: d("c") / len, g: d("g") / len, u: d("u") / len },
      gaps,
      tailwindMs: windLen > 0 ? d("wind") / windLen : null,
      sections: [...sections].sort((a, b) => a - b),
    };
  }
}
