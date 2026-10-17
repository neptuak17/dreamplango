/**
 * Sunrise, sunset and civil dusk for a date and place (NOAA's general solar position formulae, as the engine uses
 * for Dream's daylight), and local clock times through the IANA time zone of the country.
 */

const RAD = Math.PI / 180;

export interface SunTimes {
  /** Minutes after local midnight; null in polar day or night. */
  sunrise: number | null;
  sunset: number | null;
  /** End of civil twilight (sun 6° below the horizon). */
  dusk: number | null;
  /** True when the time zone is unknown and clock times come from the longitude alone. */
  approximate: boolean;
}

function dayOfYear(iso: string): { year: number; doy: number; days: number } {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const start = Date.UTC(y, 0, 1);
  const doy = Math.round((Date.UTC(y, m - 1, d) - start) / 86_400_000) + 1;
  const days = Math.round((Date.UTC(y + 1, 0, 1) - start) / 86_400_000);
  return { year: y, doy, days };
}

/** UTC minutes of the sun crossing `zenith` degrees, rising and setting; null when it never does that day. */
function crossings(iso: string, lat: number, lon: number, zenith: number): [number, number] | null {
  const { doy, days } = dayOfYear(iso);
  const g = ((2 * Math.PI) / days) * (doy - 1);
  const eqtime =
    229.18 *
    (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) +
    0.00148 * Math.sin(3 * g);
  const cosH = Math.cos(zenith * RAD) / (Math.cos(lat * RAD) * Math.cos(decl)) - Math.tan(lat * RAD) * Math.tan(decl);
  if (cosH < -1 || cosH > 1) return null;
  const h = Math.acos(cosH) / RAD;
  return [720 - 4 * (lon + h) - eqtime, 720 - 4 * (lon - h) - eqtime];
}

/** IANA zones by country (ISO 3166-1), for clock times. Mainland zones only. */
export const TIME_ZONES: Record<string, string> = {
  AD: "Europe/Andorra",
  AL: "Europe/Tirane",
  AT: "Europe/Vienna",
  BA: "Europe/Sarajevo",
  BE: "Europe/Brussels",
  BG: "Europe/Sofia",
  CH: "Europe/Zurich",
  CY: "Asia/Nicosia",
  CZ: "Europe/Prague",
  DE: "Europe/Berlin",
  DK: "Europe/Copenhagen",
  EE: "Europe/Tallinn",
  ES: "Europe/Madrid",
  FI: "Europe/Helsinki",
  FR: "Europe/Paris",
  GB: "Europe/London",
  GR: "Europe/Athens",
  HR: "Europe/Zagreb",
  HU: "Europe/Budapest",
  IE: "Europe/Dublin",
  IT: "Europe/Rome",
  LI: "Europe/Vaduz",
  LT: "Europe/Vilnius",
  LU: "Europe/Luxembourg",
  LV: "Europe/Riga",
  MC: "Europe/Monaco",
  ME: "Europe/Podgorica",
  MK: "Europe/Skopje",
  MT: "Europe/Malta",
  NL: "Europe/Amsterdam",
  NO: "Europe/Oslo",
  PL: "Europe/Warsaw",
  PT: "Europe/Lisbon",
  RO: "Europe/Bucharest",
  RS: "Europe/Belgrade",
  SE: "Europe/Stockholm",
  SI: "Europe/Ljubljana",
  SK: "Europe/Bratislava",
  SM: "Europe/San_Marino",
  TR: "Europe/Istanbul",
  VA: "Europe/Vatican",
  XK: "Europe/Belgrade",
};

/** The zone's offset from UTC (minutes) at a given instant, through Intl (no time-zone data of our own). */
export function zoneOffset(zone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return Math.round((asUtc - utcMs) / 60_000);
}

/** Minutes to add to UTC for local clock time on `iso` (at noon UTC), and whether that is only approximate. */
export function localOffset(iso: string, country: string | null, lon: number): { offset: number; approximate: boolean } {
  const zone = country ? TIME_ZONES[country] : undefined;
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  if (zone) return { offset: zoneOffset(zone, Date.UTC(y, m - 1, d, 12)), approximate: false };
  return { offset: Math.round(lon / 15) * 60, approximate: true };
}

export function sunTimes(iso: string, lat: number, lon: number, country: string | null): SunTimes {
  const { offset, approximate } = localOffset(iso, country, lon);
  const set = crossings(iso, lat, lon, 90.833);
  const civil = crossings(iso, lat, lon, 96);
  const local = (v: number | undefined) => (v === undefined ? null : Math.round(v + offset));
  return { sunrise: local(set?.[0]), sunset: local(set?.[1]), dusk: local(civil?.[1]), approximate };
}

/** "08:05" from minutes after midnight. */
export function clock(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** YYYY-MM-DD plus n days. */
export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** 0 = Monday … 6 = Sunday. */
export function weekday(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

export function monthOf(iso: string): number {
  return Number(iso.slice(5, 7)) - 1;
}

export function dayIndex(iso: string): number {
  return dayOfYear(iso).doy - 1;
}
