import type { DevelopmentLevel, Severity, Signage } from "@dpg/contracts";

export const DEVELOPMENT: Record<DevelopmentLevel, { label: string; color: string }> = {
  certified: { label: "Certified", color: "#006b3c" },
  developed: { label: "Developed", color: "#2f9e44" },
  partially_developed: { label: "Partially developed", color: "#f08c00" },
  undeveloped_unknown: { label: "Undeveloped / unknown", color: "#868e96" },
  unrecognised: { label: "Unrecognised status", color: "#c2255c" },
  not_rated: { label: "Not rated (own route)", color: "#868e96" },
};

export const SIGNAGE: Record<Signage, string> = {
  signed: "signed",
  not_signed: "not signed",
  unknown: "signage unknown",
};

export const SEVERITY: Record<Severity, { label: string; color: string; rank: number }> = {
  blocker: { label: "Blocker", color: "#c92a2a", rank: 0 },
  warning: { label: "Warning", color: "#e8590c", rank: 1 },
  caution: { label: "Caution", color: "#f5a524", rank: 2 },
  info: { label: "Info", color: "#4c6ef5", rank: 3 },
};

export const km = (m: number, digits = 0) =>
  (m / 1000).toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Climbing for display. Terrain under long straight-line placeholders is unknown, so the figure is then a minimum. */
export function climbText(metres: number | null | undefined, unknownM: number | null | undefined): string {
  if (metres == null) return "unknown";
  return `${unknownM ? "≥ " : ""}${Math.round(metres).toLocaleString("en-GB")} m`;
}

/** "(unknown for N km)" beside a minimum; nothing when the figure is complete or wholly unknown. */
export const unknownNote = (metres: number | null | undefined, unknownM: number | null | undefined) =>
  metres != null && unknownM ? ` (unknown for ${km(unknownM, 1)} km)` : "";
