/** Wording helpers: numbers in the rider's own terms (11.6). */
import type { Stop } from "@dpg/contracts";

/** A stop by its town, else by its km. */
export const stopName = (s: Stop) => s.name ?? `near km ${Math.round(s.at_m / 1000)}`;

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const WEEKDAYS_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function km(v: number): string {
  return v >= 10 ? `${Math.round(v)}` : v >= 1 ? v.toFixed(1).replace(/\.0$/, "") : v.toFixed(1);
}

/** "5 h 20" or "45 min". */
export function hours(h: number): string {
  const total = Math.round(h * 60);
  if (total < 60) return `${total} min`;
  const m = total % 60;
  return `${Math.floor(total / 60)} h${m ? ` ${String(m).padStart(2, "0")}` : ""}`;
}

/** "Wed 13 Oct". */
export function day(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const wd = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return `${WEEKDAYS[wd]} ${d} ${MONTHS[m - 1]}`;
}

/** "Wed 13 – Mon 18 Oct 2027" (or across months/years). */
export function range(a: string, b: string): string {
  const [ya, ma] = a.split("-").map(Number) as [number, number];
  const [yb, mb] = b.split("-").map(Number) as [number, number];
  if (a === b) return `${day(a)} ${ya}`;
  if (ya === yb && ma === mb) return `${day(a).replace(/ \w+$/, "")} – ${day(b)} ${yb}`;
  if (ya === yb) return `${day(a)} – ${day(b)} ${yb}`;
  return `${day(a)} ${ya} – ${day(b)} ${yb}`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "1 in 5" for a share of days. */
export function oneIn(share: number): string {
  if (share <= 0.03) return "rarely";
  const n = Math.round(1 / share);
  return n <= 1 ? "most days" : `1 day in ${n}`;
}

export const COUNTRY_NAMES: Record<string, string> = {
  AD: "Andorra",
  AL: "Albania",
  AT: "Austria",
  BA: "Bosnia and Herzegovina",
  BE: "Belgium",
  BG: "Bulgaria",
  CH: "Switzerland",
  CY: "Cyprus",
  CZ: "Czechia",
  DE: "Germany",
  DK: "Denmark",
  ES: "Spain",
  FR: "France",
  GB: "the United Kingdom",
  GR: "Greece",
  HR: "Croatia",
  HU: "Hungary",
  IE: "Ireland",
  IT: "Italy",
  MC: "Monaco",
  ME: "Montenegro",
  MK: "North Macedonia",
  NL: "the Netherlands",
  NO: "Norway",
  PL: "Poland",
  PT: "Portugal",
  RO: "Romania",
  RS: "Serbia",
  SE: "Sweden",
  SI: "Slovenia",
  SK: "Slovakia",
  TR: "Türkiye",
};

export const country = (cc: string | null | undefined) => (cc ? (COUNTRY_NAMES[cc] ?? cc) : "this country");
