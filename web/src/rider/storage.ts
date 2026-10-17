/** Plans kept in this browser (principle 5: the device knows the rider), and file downloads. */
import { type PlanDocument, parseDocument } from "@dpg/planner";

const PLANS_KEY = "dpg.plans";

export function savedPlans(): PlanDocument[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PLANS_KEY) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.map((r) => parseDocument(r)).filter((d): d is PlanDocument => typeof d !== "string");
  } catch {
    return [];
  }
}

export function savePlan(doc: PlanDocument): void {
  try {
    const rest = savedPlans().filter((d) => d.id !== doc.id);
    localStorage.setItem(PLANS_KEY, JSON.stringify([doc, ...rest].slice(0, 50)));
  } catch {
    /* storage unavailable: export the plan as a file instead */
  }
}

export function deletePlan(id: string): void {
  try {
    localStorage.setItem(PLANS_KEY, JSON.stringify(savedPlans().filter((d) => d.id !== id)));
  } catch {
    /* nothing kept */
  }
}

export function download(name: string, type: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const fileSafe = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, 60) || "plan";
