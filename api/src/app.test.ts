import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { FsBundleStore } from "./store";

const RUN = "20261014T120000Z_0123456789";
let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), "dpg-api-"));
  const routeDir = join(dataDir, "bundles", "eurovelo", "ev8");
  mkdirSync(join(routeDir, RUN), { recursive: true });
  writeFileSync(join(routeDir, "current.json"), JSON.stringify({ run_id: RUN, updated_at: "2026-10-14T12:00:00Z" }));
  const manifest = {
    run_id: RUN,
    created_at: "2026-10-14T12:00:00Z",
    route: { id: "eurovelo:ev8", network: "eurovelo", ref: "EV8", name: "EuroVelo 8", official_url: null },
    summary: { ride_length_m: 1000, daily_section_count: 1, gap_count: 0, gap_straight_distance_m: 0, status_breakdown: [] },
    finding_counts: {},
  };
  writeFileSync(join(routeDir, RUN, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(routeDir, RUN, "path.geojson"), JSON.stringify({ type: "FeatureCollection", features: [] }));
});

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe("api v1", () => {
  const app = () => createApp(new FsBundleStore(dataDir));

  it("lists routes with a current bundle", async () => {
    const res = await app().request("/v1/routes");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { routes: { route: { id: string }; run_id: string }[] };
    expect(body.routes.map((r) => r.route.id)).toEqual(["eurovelo:ev8"]);
    expect(body.routes[0]?.run_id).toBe(RUN);
  });

  it("serves bundle files with content type and etag", async () => {
    const res = await app().request("/v1/routes/eurovelo/ev8/path");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/geo+json");
    const etag = res.headers.get("etag");
    expect(etag).toContain(RUN);
    const again = await app().request("/v1/routes/eurovelo/ev8/path", { headers: { "if-none-match": etag! } });
    expect(again.status).toBe(304);
  });

  it("returns 404 for unknown routes and missing files", async () => {
    expect((await app().request("/v1/routes/eurovelo/ev99")).status).toBe(404);
    expect((await app().request("/v1/routes/eurovelo/ev8/findings")).status).toBe(404);
  });

  it("rejects malformed names and run ids", async () => {
    expect((await app().request("/v1/routes/eurovelo/EV8")).status).toBe(400);
    expect((await app().request("/v1/routes/eurovelo/ev8?run=../../etc")).status).toBe(400);
  });

  it("serves a specific run as immutable", async () => {
    const res = await app().request(`/v1/routes/eurovelo/ev8?run=${RUN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
  });
});
