# Kilometrica

*Formerly DreamPlanGo (renamed 2026-10-17, D42 in the design). "dpg" remains the internal name of the audit process: the `dpg` command, the `dpg_audit` engine package and the `~/dpg-data` folder.*

Route audits and Dream–Plan–Go trip support for long-distance cycle routes, starting with EuroVelo 8. Design, decisions and roadmap: [docs/DESIGN.md](docs/DESIGN.md).

**Status:** milestone M4 (Plan). The engine matches the official EV8 track, or a route file of your own, to OpenStreetMap and produces several layers. A local API serves the results; the audit viewer shows them on a map and in a strip diagram, and a separate rider view turns a stretch into a plan.
- Layers (M1): infrastructure, surface, traffic stress, waymarked network, gradient, typed gaps (ferry, published transport link, missing), climbs and an indicative ECS-style check.
- Services (M2):
  - places from OSM and Overture (water, food, toilets, accommodation, bike shops, repair stations, stations, pharmacies, ATMs, hospitals), each with its ridden detour from the route and its season by month;
  - stations with a curated bike-carriage policy;
  - services-gap, seasonal-gap and bail-out findings, and the ECS services criteria;
  - in the viewer, a "what's ahead from km X" list.
- Dream (M3):
  - climate by section and month (Copernicus ERA5), daylight, holidays and tourism by month, scenery themes and remoteness;
  - simple comfort, best-time and direction scores, with "no data" shown honestly;
  - in the viewer, a Dream tab: a trip finder for your level, days, surfaces and themes, a best-time heatmap, and a reality-check card.
- Your own routes (M3.5): the same audit on a GPX file you supply, as a private route. It is split into stages of about 60 km; its waypoints are shown but never counted, and any length it shares with EV8 is reported.
- Plan (M4), the rider view at `http://localhost:5173/plan` (or "Plan this stretch" in the Dream tab):
  - days timed in hours from your level and bike, a stop each night in a town, and the few things that need your call;
  - a trip brief in five lines, day cards with water and food, heads-ups, highlights, beds with their own links and a plan B;
  - a to-do list, starter GPX per day (gaps marked; Kilometrica doesn't build your final route), a calendar file, a printable trip book, share links and a QR code for your phone, with no accounts;
  - a prototype switch between the free teaser and the Trip Pass view.

## Layout

| Path | What |
|---|---|
| `engine/` | Python Route Audit Engine (`dpg` CLI). **Runs in Ubuntu (WSL)** via `scripts/dpg` |
| `engine/profiles/` | Rules profiles (`eurovelo-ecs-v0.yaml`, `services-v0.yaml`, `dream-v0.yaml`), route-specific knowledge (`routes/*.yaml`) and the bike-carriage table (`transport/bike-carriage.yaml`) |
| `infra/valhalla/` | Docker Compose for the local Valhalla map-matching service (`scripts/valhalla`) |
| `api/` | TypeScript HTTP API (Hono). Runs on Windows Node now, Cloudflare Workers later |
| `web/` | Prototype viewer (Vite + React + MapLibre) |
| `packages/contracts/` | TypeScript types generated from `schemas/` |
| `packages/dream/` | The Dream matchmaker (TypeScript), shared by the viewer and later the app |
| `packages/planner/` | Plan (TypeScript, pure): pace model, stage planner, plan items, plan document, share links, exports |
| `schemas/` | JSON Schema of the bundle format (generated from the engine's models) |
| `docs/` | Design, data-licence register, setup guides, notes |

Data (raw downloads, work files, Valhalla tiles, bundles) lives on the Linux filesystem in `~/dpg-data` (override with `DPG_DATA_DIR`).

## Prerequisites

- **Windows:** Node.js 24+ (npm 11+).
- **Ubuntu (WSL2) with Docker Engine:** see [docs/setup/wsl-and-docker.md](docs/setup/wsl-and-docker.md).
- **Inside Ubuntu:** `build-essential`, `osmium-tool`, `tippecanoe` (apt) and [uv](https://docs.astral.sh/uv/).
- Copy `.env.example` to `.env`, so the API reads bundles from Ubuntu.

## Running an audit (EV8)

All of these run from the repo root in PowerShell; the engine steps run inside Ubuntu automatically.

```bash
npm install
npm run engine:sync    # create the engine's Linux virtualenv
npm run fetch:ev8      # official EV8 GPX
npm run osm:ev8        # download OSM country extracts (~10.6 GB) and cut the 15 km corridor
npm run valhalla:up    # start Valhalla; the first start builds routing tiles from the corridor
npm run audit:ev8      # match, layers, terrain, services, Dream data (ERA5 needs ~/.cdsapirc), rules -> bundle
npm run dev            # API on http://127.0.0.1:8787, viewer on http://localhost:5173, rider view on /plan
```

`npm run ingest:ev8` still builds a quick geometry-only bundle without OSM, Valhalla or the DEM.

## Auditing your own route file (M3.5)

```bash
npm run audit:file -- path/to/route.gpx --name "My route"
```

One command registers the file as a private route (`user/<id>`; the id comes from the file's contents) and cuts its corridor from the OSM extracts. It runs Valhalla on that corridor's tiles, or on EV8's when they already cover it, then runs the full audit and puts back the Valhalla that was running before. It ends by printing the viewer link (`http://localhost:5173/?route=user/<id>`).

- Private routes are stored apart under `~/dpg-data/bundles/private/`. The API never lists them; the viewer remembers the ones you have opened in that browser.
- `npm run forget -- <id>` deletes the route and everything kept for it: its file, bundles, corridor, caches and routing tiles. Shared caches kept by area stay.
- Route files are ignored by git (`*.gpx`, `*.fit`), so a route of your own is never committed.

## Other tasks

| Command | Does |
|---|---|
| `npm test` | Engine tests (pytest + hypothesis, in Ubuntu), API tests and Dream matchmaker tests (vitest) |
| `npm run typecheck` | TypeScript checks for all workspaces |
| `npm run engine:lint` | ruff |
| `npm run contracts` | Re-export the JSON Schema and regenerate `packages/contracts` after changing engine models |
| `npm run valhalla:status` / `valhalla:down` | Check or stop the routing service |
| `npm run audit:file -- <file.gpx>` / `npm run forget -- <id>` | Audit a route file of your own as a private route / delete it |

## Data attribution

Bundles contain information from EuroVelo GPX tracks downloaded from www.EuroVelo.com and from OpenStreetMap (© OpenStreetMap contributors), both under the Open Database License (ODbL). Places also come from Overture Maps Foundation, including Foursquare OS Places (Apache-2.0, © Foursquare Labs, Inc.). Elevation: Copernicus DEM GLO-30. Climate: contains modified Copernicus Climate Change Service information (ERA5). Holidays: OpenHolidays API. Tourism: © European Union, Eurostat. See [docs/DATA-LICENSES.md](docs/DATA-LICENSES.md). EuroVelo® is a registered trademark of the European Cyclists' Federation. This project is not affiliated with or endorsed by ECF.
