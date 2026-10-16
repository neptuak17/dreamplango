# DreamPlanGo

Route audits and Dream–Plan–Go trip support for long-distance cycle routes, starting with EuroVelo 8. Design, decisions and roadmap: [docs/DESIGN.md](docs/DESIGN.md).

**Status:** milestone M3 (Dream data). The engine matches the official EV8 track to OpenStreetMap and produces several layers. A local API serves the results, and a web viewer shows them on a map and in a strip diagram.
- Layers (M1): infrastructure, surface, traffic stress, waymarked network, gradient, typed gaps (ferry, rail link, missing), climbs and an indicative ECS-style check.
- Services (M2):
  - places from OSM and Overture (water, food, toilets, accommodation, bike shops, repair stations, stations, pharmacies, ATMs, hospitals), each with its ridden detour from the route and its season by month;
  - stations with a curated bike-carriage policy;
  - services-gap, seasonal-gap and bail-out findings, and the ECS services criteria;
  - in the viewer, a "what's ahead from km X" list.
- Dream (M3):
  - climate by section and month (Copernicus ERA5), daylight, holidays and tourism by month, scenery themes and remoteness;
  - simple comfort, best-time and direction scores, with "no data" shown honestly;
  - in the viewer, a Dream tab: a trip finder for your level, days, surfaces and themes, a best-time heatmap, and a reality-check card.

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
npm run dev            # API on http://127.0.0.1:8787, viewer on http://localhost:5173
```

`npm run ingest:ev8` still builds a quick geometry-only bundle without OSM, Valhalla or the DEM.

## Other tasks

| Command | Does |
|---|---|
| `npm test` | Engine tests (pytest + hypothesis, in Ubuntu), API tests and Dream matchmaker tests (vitest) |
| `npm run typecheck` | TypeScript checks for all workspaces |
| `npm run engine:lint` | ruff |
| `npm run contracts` | Re-export the JSON Schema and regenerate `packages/contracts` after changing engine models |
| `npm run valhalla:status` / `valhalla:down` | Check or stop the routing service |

## Data attribution

Bundles contain information from EuroVelo GPX tracks downloaded from www.EuroVelo.com and from OpenStreetMap (© OpenStreetMap contributors), both under the Open Database License (ODbL). Places also come from Overture Maps Foundation, including Foursquare OS Places (Apache-2.0, © Foursquare Labs, Inc.). Elevation: Copernicus DEM GLO-30. Climate: contains modified Copernicus Climate Change Service information (ERA5). Holidays: OpenHolidays API. Tourism: © European Union, Eurostat. See [docs/DATA-LICENSES.md](docs/DATA-LICENSES.md). EuroVelo® is a registered trademark of the European Cyclists' Federation. This project is not affiliated with or endorsed by ECF.
