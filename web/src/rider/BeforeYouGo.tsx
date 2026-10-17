/**
 * Step 5 (11.6): the to-do list with its handoffs (D41), the exports (D48) and sharing without accounts (9.4).
 * A plan moves to the phone for Go by its link, shown as a QR code (D49).
 */
import type { PlanItem, PlanResult } from "@dpg/planner";
import qrcode from "qrcode-generator";
import { useMemo, useState } from "react";
import { Links } from "./DayCard";

export type ExportKind = "trip-gpx" | "ics" | "plan-file" | "trip-book";

interface Props {
  plan: PlanResult;
  free: boolean;
  readOnly: boolean;
  isPrivate: boolean;
  done: string[];
  onDone: (id: string) => void;
  onExport: (kind: ExportKind) => void;
  links: { full: string; itinerary: string };
}

const GROUPS: { title: string; test: (i: PlanItem) => boolean }[] = [
  { title: "Book and check beds", test: (i) => i.id.startsWith("bed:") || i.id.startsWith("book:") },
  { title: "Ferries and transport", test: (i) => i.id.startsWith("ferry:") || i.id.startsWith("transport:") },
  { title: "Getting there and back", test: (i) => i.id.startsWith("travel:") },
  { title: "Borders", test: (i) => i.id.startsWith("border:") },
  { title: "Check yourself: data we don't have", test: (i) => i.id.startsWith("data:") },
];

function Qr({ text }: { text: string }) {
  const svg = useMemo(() => {
    try {
      const qr = qrcode(0, "L");
      qr.addData(text);
      qr.make();
      return qr.createSvgTag({ cellSize: 3, margin: 2, scalable: true });
    } catch {
      return null;
    }
  }, [text]);
  if (!svg) return <p className="muted">This plan is too long for a QR code: send yourself the link instead.</p>;
  return <div className="qr" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function Copy({ text, label }: { text: string; label: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setOk(true);
          setTimeout(() => setOk(false), 1500);
        });
      }}
    >
      {ok ? "Copied ✓" : label}
    </button>
  );
}

export function BeforeYouGo({ plan, free, readOnly, isPrivate, done, onDone, onExport, links }: Props) {
  const todos = plan.items.filter((i) => i.kind === "todo");
  const [qr, setQr] = useState(false);
  if (free) {
    return (
      <section className="before locked">
        <h2>Before you go</h2>
        <p>
          {todos.length} {todos.length === 1 ? "thing" : "things"} to sort out. The to-do list with its links, the trip book, GPX and calendar
          files, sharing and sending the plan to your phone come with a Trip Pass.
        </p>
      </section>
    );
  }
  return (
    <section className="before">
      <h2>Before you go</h2>
      {GROUPS.map((g) => {
        const mine = todos.filter(g.test);
        if (!mine.length) return null;
        return (
          <div key={g.title} className="todo-group">
            <div className="label">{g.title}</div>
            <ul>
              {mine.map((i) => (
                <li key={i.id} className={done.includes(i.id) ? "done" : ""}>
                  <input type="checkbox" disabled={readOnly} checked={done.includes(i.id)} onChange={() => onDone(i.id)} aria-label="Done" />
                  <div>
                    <div>{i.title}</div>
                    <div className="muted">{i.why}</div>
                    <Links links={i.handoffs} />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      <div className="exports">
        <div className="label">Take it with you</div>
        <button type="button" onClick={() => onExport("trip-book")}>
          Trip book (print or PDF)
        </button>
        <button type="button" onClick={() => onExport("trip-gpx")}>
          GPX for the whole trip
        </button>
        <button type="button" onClick={() => onExport("ics")}>
          Calendar (.ics)
        </button>
        <button type="button" onClick={() => onExport("plan-file")}>
          Plan file
        </button>
        <p className="muted small">
          The GPX is a starter file: finish the route in your own route tool. Gaps are marked at both ends.
        </p>
      </div>
      <div className="share">
        <div className="label">Share and send to your phone</div>
        {isPrivate ? (
          <p className="muted">
            This plan is on your own route, which stays private: share it as a plan file. Whoever opens it also needs your route file.
          </p>
        ) : (
          <>
            <div className="share-row">
              <span>Whole plan, read-only</span>
              <Copy text={links.full} label="Copy link" />
              <button type="button" onClick={() => setQr(!qr)}>
                {qr ? "Hide QR code" : "Send to my phone"}
              </button>
            </div>
            {qr && (
              <div className="qr-box">
                <Qr text={links.full} />
                <p className="muted small">
                  Scan with your phone's camera. The plan travels in the link itself; nothing is stored on a server. In this prototype the
                  link points to this computer.
                </p>
              </div>
            )}
            <div className="share-row">
              <span>Where I'll be: dates and nightly stops only</span>
              <Copy text={links.itinerary} label="Copy link" />
            </div>
          </>
        )}
      </div>
    </section>
  );
}
