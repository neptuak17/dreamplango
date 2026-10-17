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
  const place = (id: string, service: string, at: number, extra: Record<string, unknown> = {}) => ({
    id,
    service,
    kind: "k",
    name: id,
    lon: 0,
    lat: 0,
    at_m: at,
    offset_m: 10,
    side: "left",
    access_m: 300,
    access_min: 1.2,
    climb_m: 0,
    access_at_m: at,
    counts: true,
    on_route: true,
    months: "oooooooooooo",
    opening_hours: null,
    country: "FR",
    sources: [`osm:${id}`],
    confidence: "medium",
    detail: {},
    ...extra,
  });
  const places = {
    season_year: 2027,
    places: [
      place("a", "water", 500),
      place("b", "accommodation", 1500, { months: "cccooooooccc" }),
      place("c", "accommodation", 2500, { access_m: 7000, counts: false }),
      place("d", "food", 4000),
    ],
  };
  writeFileSync(join(routeDir, RUN, "places.json"), JSON.stringify(places));
  writeFileSync(join(routeDir, RUN, "stops.json"), JSON.stringify({ season_year: 2027, reach_m: 2500, stops: [] }));

  // A rider's own route: stored apart, never listed (D25)
  const own = join(dataDir, "bundles", "private", "user", "u0123456789");
  mkdirSync(join(own, RUN), { recursive: true });
  writeFileSync(join(own, "current.json"), JSON.stringify({ run_id: RUN, updated_at: "2026-10-14T12:00:00Z" }));
  const ownManifest = { ...manifest, visibility: "private", route: { ...manifest.route, id: "user:u0123456789", network: "user", ref: "u0123456789", name: "Pyrenees" } };
  writeFileSync(join(own, RUN, "manifest.json"), JSON.stringify(ownManifest));
  writeFileSync(join(own, RUN, "user_places.json"), JSON.stringify({ places: [] }));
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

  it("never lists a private route, but serves it by id without shared caching", async () => {
    const body = (await (await app().request("/v1/routes")).json()) as { routes: { route: { id: string } }[] };
    expect(body.routes.map((r) => r.route.id)).not.toContain("user:u0123456789");
    const res = await app().request("/v1/routes/user/u0123456789");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { visibility: string }).visibility).toBe("private");
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect((await app().request(`/v1/routes/user/u0123456789/user_places?run=${RUN}`)).headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable",
    );
    expect((await app().request("/v1/routes/eurovelo/ev8")).headers.get("cache-control")).toBe("public, no-cache");
    expect((await app().request("/v1/routes/private/user")).status).toBe(400);
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

  it("serves the Plan files (M4)", async () => {
    const res = await app().request("/v1/routes/eurovelo/ev8/stops");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { stops: unknown[] }).stops).toEqual([]);
    expect((await app().request("/v1/routes/eurovelo/ev8/effort")).status).toBe(404); // not in this bundle
  });

  it("returns 404 for unknown routes and missing files", async () => {
    expect((await app().request("/v1/routes/eurovelo/ev99")).status).toBe(404);
    expect((await app().request("/v1/routes/eurovelo/ev8/findings")).status).toBe(404);
  });

  it("rejects malformed names and run ids", async () => {
    expect((await app().request("/v1/routes/eurovelo/EV8")).status).toBe(400);
    expect((await app().request("/v1/routes/eurovelo/ev8?run=../../etc")).status).toBe(400);
  });

  it("filters places by km range, service, detour, counting and month", async () => {
    type Res = { total: number; truncated: boolean; places: { id: string }[] };
    const get = async (qs: string) => {
      const res = await app().request(`/v1/routes/eurovelo/ev8/places?${qs}`);
      expect(res.status).toBe(200);
      return (await res.json()) as Res;
    };
    const ids = (r: Res) => r.places.map((p) => p.id);
    expect(ids(await get(""))).toEqual(["a", "b", "c", "d"]);
    expect(ids(await get("from_km=1&to_km=3"))).toEqual(["b", "c"]);
    expect(ids(await get("service=accommodation,food"))).toEqual(["b", "c", "d"]);
    expect(ids(await get("max_detour_m=5000"))).toEqual(["a", "b", "d"]);
    expect(ids(await get("counting=1"))).toEqual(["a", "b", "d"]);
    expect(ids(await get("month=1"))).toEqual(["a", "c", "d"]); // b is closed in January
    const limited = await get("limit=2");
    expect(limited.total).toBe(4);
    expect(limited.truncated).toBe(true);
  });

  it("rejects invalid place queries", async () => {
    expect((await app().request("/v1/routes/eurovelo/ev8/places?month=13")).status).toBe(400);
    expect((await app().request("/v1/routes/eurovelo/ev8/places?from_km=-1")).status).toBe(400);
    expect((await app().request("/v1/routes/eurovelo/ev8/places?service=DROP;")).status).toBe(400);
  });

  it("serves a specific run as immutable", async () => {
    const res = await app().request(`/v1/routes/eurovelo/ev8?run=${RUN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
  });
});
