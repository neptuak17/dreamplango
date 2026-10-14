/** HTTP API (v1). Runtime-neutral: the same app runs on Node now and on Cloudflare Workers later. */
import { Hono } from "hono";
import type { Context } from "hono";
import { type BundleFile, type BundleStore, readManifest } from "./store";

const NAME = /^[a-z0-9-]{1,32}$/;
const RUN_ID = /^\d{8}T\d{6}Z_[0-9a-f]{10}$/;

const CONTENT_TYPES: Record<BundleFile, string> = {
  manifest: "application/json",
  path: "application/geo+json",
  sections: "application/json",
  findings: "application/json",
  profile: "application/json",
  events: "application/json",
  minor: "application/json",
  scores: "application/json",
};

export function createApp(store: BundleStore) {
  const app = new Hono();

  app.get("/v1/health", (c) => c.json({ ok: true }));

  app.get("/v1/routes", async (c) => {
    const listing = [];
    for (const { network, ref } of await store.routes()) {
      const runId = await store.currentRun(network, ref);
      const manifest = runId ? await readManifest(store, network, ref, runId) : null;
      if (!manifest) continue;
      listing.push({
        route: manifest.route,
        run_id: manifest.run_id,
        created_at: manifest.created_at,
        summary: manifest.summary,
        finding_counts: manifest.finding_counts,
      });
    }
    return c.json({ routes: listing });
  });

  /** Resolve the run to serve: `?run=<id>` if given, else the route's current bundle. */
  async function resolveRun(c: Context): Promise<{ network: string; ref: string; runId: string } | Response> {
    const network = c.req.param("network") ?? "";
    const ref = c.req.param("ref") ?? "";
    if (!NAME.test(network) || !NAME.test(ref)) return c.json({ error: "invalid route" }, 400);
    const requested = c.req.query("run");
    if (requested !== undefined && !RUN_ID.test(requested)) return c.json({ error: "invalid run id" }, 400);
    const runId = requested ?? (await store.currentRun(network, ref));
    if (!runId) return c.json({ error: "route not found" }, 404);
    return { network, ref, runId };
  }

  const serve = (file: BundleFile) => async (c: Context) => {
    const target = await resolveRun(c);
    if (target instanceof Response) return target;
    const body = await store.readFile(target.network, target.ref, target.runId, file);
    if (body === null) return c.json({ error: `${file} not found` }, 404);
    const etag = `"${target.runId}-${file}"`;
    if (c.req.header("if-none-match") === etag) return c.body(null, 304);
    return c.body(body, 200, {
      "content-type": CONTENT_TYPES[file],
      etag,
      // Current bundles change when a new audit is published; a specific ?run= never changes.
      "cache-control": c.req.query("run") ? "public, max-age=31536000, immutable" : "no-cache",
    });
  };

  app.get("/v1/routes/:network/:ref", serve("manifest"));
  for (const file of ["path", "sections", "findings", "profile", "events", "minor", "scores"] as const) {
    app.get(`/v1/routes/:network/:ref/${file}`, serve(file));
  }

  return app;
}
