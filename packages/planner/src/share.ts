/**
 * Share links without accounts (9.4, 11.6, D48): the plan travels in the link's fragment (after `#`), which browsers
 * never send to a server. The link is the plan; nothing is stored anywhere, and anyone holding it can read it.
 *
 * Two levels: the full plan (`#p=`), or the itinerary only (`#i=`: dates and nightly stops, for family and friends).
 * Pure TypeScript (no TextEncoder, btoa or compression APIs), so the same code runs in the app later.
 */
import { type PlanDocument, parseDocument } from "./document";
import type { PlanResult } from "./plan";
import { stopName } from "./text";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function utf8(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else {
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
  }
  return out;
}

export function fromUtf8(bytes: number[]): string {
  let s = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]!;
    let c: number;
    if (b < 0x80) {
      c = b;
      i += 1;
    } else if (b < 0xe0) {
      c = ((b & 31) << 6) | (bytes[i + 1]! & 63);
      i += 2;
    } else if (b < 0xf0) {
      c = ((b & 15) << 12) | ((bytes[i + 1]! & 63) << 6) | (bytes[i + 2]! & 63);
      i += 3;
    } else {
      c = ((b & 7) << 18) | ((bytes[i + 1]! & 63) << 12) | ((bytes[i + 2]! & 63) << 6) | (bytes[i + 3]! & 63);
      i += 4;
    }
    s += String.fromCodePoint(c);
  }
  return s;
}

export function toBase64Url(bytes: number[]): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    s += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) s += B64[(n >> 6) & 63]!;
    if (i + 2 < bytes.length) s += B64[n & 63]!;
  }
  return s;
}

export function fromBase64Url(text: string): number[] | null {
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of text) {
    const v = B64.indexOf(ch);
    if (v < 0) return null;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 255);
    }
  }
  return out;
}

const encode = (value: unknown) => toBase64Url(utf8(JSON.stringify(value)));
function decode(text: string): unknown {
  const bytes = fromBase64Url(text);
  if (!bytes) return null;
  try {
    return JSON.parse(fromUtf8(bytes));
  } catch {
    return null;
  }
}

export interface Itinerary {
  kind: "kilometrica-itinerary";
  version: 0;
  name: string;
  days: { date: string; kind: "ride" | "rest"; from: string; to: string; km: number; stop: { name: string; lat: number; lon: number } | null }[];
}

export function itineraryOf(plan: PlanResult, name = plan.brief.title): Itinerary {
  return {
    kind: "kilometrica-itinerary",
    version: 0,
    name,
    days: plan.days.map((d) => ({
      date: d.date,
      kind: d.kind,
      from: d.startName,
      to: d.endName,
      km: Math.round(d.km),
      stop: d.stop ? { name: stopName(d.stop), lat: d.stop.lat, lon: d.stop.lon } : null,
    })),
  };
}

/** The fragment for a share link: `p=` with the plan, or `i=` with the itinerary only. */
export function shareFragment(doc: PlanDocument | Itinerary): string {
  return doc.kind === "kilometrica-plan" ? `p=${encode(doc)}` : `i=${encode(doc)}`;
}

export type Shared = { plan: PlanDocument } | { itinerary: Itinerary } | { error: string } | null;

/** Reads a link's fragment (with or without the leading `#`). Null when it carries nothing. */
export function readFragment(fragment: string): Shared {
  const f = fragment.replace(/^#/, "");
  const m = /^(p|i)=([A-Za-z0-9_-]+)$/.exec(f);
  if (!m) return null;
  const value = decode(m[2]!);
  if (value === null) return { error: "the link is damaged" };
  if (m[1] === "p") {
    const doc = parseDocument(value);
    return typeof doc === "string" ? { error: doc } : { plan: doc };
  }
  const it = value as Itinerary;
  if (it?.kind !== "kilometrica-itinerary" || !Array.isArray(it.days)) return { error: "not a Kilometrica itinerary" };
  return { itinerary: it };
}
