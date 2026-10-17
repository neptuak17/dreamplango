/**
 * The plan document (11.6, `schemas/plan-v0.schema.json`): what a plan is, kept on the rider's device and carried by
 * share links and files. It holds the route and audit run it was made on, the rider's inputs, the nights and the
 * rider's choices; everything else is recomputed from the bundle.
 */
import type { PlanResult } from "./plan";
import type { PlanChoices, PlanInputs, RouteRef } from "./types";

export const DOCUMENT_KIND = "kilometrica-plan";
export const DOCUMENT_VERSION = 0;

export interface PlanDocument {
  kind: typeof DOCUMENT_KIND;
  version: typeof DOCUMENT_VERSION;
  id: string;
  name: string;
  created: string;
  updated: string;
  /** The route and the audit run the plan was made on (bundles are immutable, principle 7). */
  route: RouteRef;
  inputs: PlanInputs;
  /** Stop id per night, in order. */
  nights: string[];
  choices: Omit<PlanChoices, "nights">;
  notes: string;
}

export function newId(): string {
  let s = "";
  for (let i = 0; i < 10; i++) s += Math.floor(Math.random() * 36).toString(36);
  return s;
}

export function toDocument(plan: PlanResult, meta: { id?: string; name?: string; created?: string; notes?: string } = {}): PlanDocument {
  const now = new Date().toISOString();
  const { nights: _nights, ...choices } = plan.choices;
  return {
    kind: DOCUMENT_KIND,
    version: DOCUMENT_VERSION,
    id: meta.id ?? newId(),
    name: meta.name ?? plan.brief.title,
    created: meta.created ?? now,
    updated: now,
    route: plan.route,
    inputs: plan.inputs,
    nights: plan.nights.map((n) => n.stop.id),
    choices,
    notes: meta.notes ?? "",
  };
}

export function choicesOf(doc: PlanDocument): PlanChoices {
  return { ...doc.choices, nights: doc.nights };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Checks a document read from a link or file; returns it, or what is wrong. */
export function parseDocument(raw: unknown): PlanDocument | string {
  if (!isObj(raw) || raw.kind !== DOCUMENT_KIND) return "not a Kilometrica plan";
  if (raw.version !== DOCUMENT_VERSION) return `unsupported plan version ${String(raw.version)}`;
  const r = raw.route;
  if (!isObj(r) || !isStr(r.network) || !isStr(r.ref) || !isStr(r.runId)) return "the plan has no route";
  const i = raw.inputs;
  if (!isObj(i) || !isNum(i.fromM) || !isNum(i.toM) || !isStr(i.startDate) || !isNum(i.days) || !isNum(i.level)) {
    return "the plan's inputs are incomplete";
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.startDate)) return "the plan's start date is invalid";
  if (!Array.isArray(raw.nights) || !raw.nights.every(isStr)) return "the plan's nights are invalid";
  const c = raw.choices;
  if (!isObj(c)) return "the plan's choices are missing";
  return {
    kind: DOCUMENT_KIND,
    version: DOCUMENT_VERSION,
    id: isStr(raw.id) ? raw.id : newId(),
    name: isStr(raw.name) ? raw.name : "Plan",
    created: isStr(raw.created) ? raw.created : new Date().toISOString(),
    updated: isStr(raw.updated) ? raw.updated : new Date().toISOString(),
    route: { network: r.network, ref: r.ref, runId: r.runId, name: isStr(r.name) ? r.name : r.ref },
    inputs: {
      fromM: i.fromM,
      toM: i.toM,
      direction: i.direction === "reverse" ? "reverse" : "forward",
      startDate: i.startDate,
      days: Math.max(1, Math.round(i.days)),
      level: Math.min(5, Math.max(1, Math.round(i.level))),
      bike: (["road", "touring", "gravel", "ebike"] as const).find((b) => b === i.bike) ?? "touring",
      sleep: (["camping", "rooms", "mix"] as const).find((s) => s === i.sleep) ?? "mix",
      startMinutes: isNum(i.startMinutes) ? i.startMinutes : 9 * 60,
      stopStyle: (["short", "normal", "long"] as const).find((s) => s === i.stopStyle) ?? "normal",
      restAfter: Array.isArray(i.restAfter) ? i.restAfter.filter(isNum) : [],
      avoidGravel: i.avoidGravel === true,
      avoidBusy: i.avoidBusy === true,
    },
    nights: raw.nights,
    choices: {
      locked: isObj(c.locked) ? (Object.fromEntries(Object.entries(c.locked).filter(([, v]) => isStr(v))) as Record<number, string>) : {},
      beds: isObj(c.beds) ? (Object.fromEntries(Object.entries(c.beds).filter(([, v]) => isStr(v))) as Record<number, string>) : {},
      booked: Array.isArray(c.booked) ? c.booked.filter(isNum) : [],
      done: Array.isArray(c.done) ? c.done.filter(isStr) : [],
      dismissed: Array.isArray(c.dismissed) ? c.dismissed.filter(isStr) : [],
    },
    notes: isStr(raw.notes) ? raw.notes : "",
  };
}
