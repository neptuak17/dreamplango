# DreamPlanGo — System Design (V1 proposal)

**Status:** Living design, 2026-10-15. Decisions D1–D30 are recorded below, and milestones M0–M2 are built (section 11).
**Scope:** The Route Audit System (backend), the prototype web app used to exercise it, and the design choices that keep later phases open (iOS app, other route networks, user GPX audits, B2B reports, white-label partner widgets).

---

## 0. Summary of key decisions

1. **Everything is measured along the route (linear referencing).** Every route becomes a measured line from km 0 to km N. Every fact about it becomes an *event* at a km point or over a km range: surface, traffic stress, signage, a campsite, a ferry season, a weather warning, a closure. Each event records its source, date, confidence and licence. Highway asset-management systems work the same way, and it's what lets you "decorate" a route with any data source you can map to a location.
2. **Two runtimes share one data contract.**
   - **Route Audit Engine:** Python, for the heavy batch geospatial work. It runs as a Docker image, which Cloudflare Containers (GA since April 2026) can also run.
   - **Request-time API:** TypeScript on Hono. It runs on Node on your laptop today and on Cloudflare Workers later without a rewrite.
   - **Prototype web app:** React and MapLibre.
3. **Each audit run produces an immutable, versioned Audit Bundle.** The bundle holds SQLite, PMTiles, GPX, an HTML/PDF report and a manifest. The API serves it, the prototype reads it, the iOS app will download it as its offline pack, and B2B reports are rendered from it.
4. **The audit rules follow the EuroVelo European Certification Standard (ECS).** They use the same section units (1 km minor sections, 15–90 km daily sections), the same criteria categories, and the same essential / important / additional tiers. That makes the results credible to ECF and the National EuroVelo Coordination Centres (NECCs). It also means we can calibrate against published ECS certification reports, such as EV15 Rhine (2025).
5. **Open data comes first.** The main sources are:
   - EuroVelo GPX tracks, which have been under ODbL since October 2024.
   - OpenStreetMap.
   - Overture Maps and Foursquare open places.
   - Copernicus: elevation (DEM), ERA5 climate, CAMS air quality and EFFIS fire.
   - MeteoAlarm warnings, NASA FIRMS fire hotspots and GTFS transit feeds.

   Commercial services are used only where open data is weak, or where licences require them for production (mainly weather).
6. **A consumer app with no accounts is feasible** (section 9). The rule is "the server knows routes; the device knows the rider." Purchases go through StoreKit 2 and sync through the user's own iCloud. GPS location never leaves the phone, and live data is requested by route block, not by position.
7. **Work inside WSL2 (Ubuntu, arm64) on the Windows on ARM laptop.** The Python geospatial stack (GDAL, rasterio, pyosmium, DuckDB spatial) works reliably on Linux arm64. On native Windows-on-ARM it is patchy.

### Customers (D26)

| Priority | Who | What DreamPlanGo gives them | Where it lives in this design |
|---|---|---|---|
| **1** | **Individuals**: cyclists now, other adventurers later. Their routes come from networks (EuroVelo, USBRS), from their own GPX files, or from files shared on other platforms and route libraries. | Help finding the adventure that suits their tastes and capabilities, then planning and riding it with local knowledge at their side | Consumer app and prototype (sections 9, 11, 12); user routes (D22–D25, 11.3) |
| **2** (possible) | **Route network organisations**: curators who assemble routes from many partners and lack the resources to check them | Regular audits against *their* standards, showing what fails and what to fix, with little effort on their part | Rules profiles per network (8.5); B2B section of 12 |
| **3** (possible) | **Route publishers**: networks, route libraries (Bikepacking.com, Epic Road Rides), tour companies, tourism sites and associations | A simple, branded widget or hosted page on their own site to present their routes and offer planning tools (D29) | B2B section of 12; privacy in 9.4 |

### Decision log

| # | Date | Decision |
|---|---|---|
| D1 | 2026-10-14 | **Dev machine: 32 GB RAM, 1 TB disk.** Enough to hold the full Europe OSM extract and build Valhalla tiles from whole-country extracts for every EV8 country. Corridor clipping stays, but only to keep audit data small, not because of hardware. |
| D2 | 2026-10-14 | **Stack confirmed:** Python audit engine, TypeScript API and web app. |
| D3 | 2026-10-14 | **First route: EuroVelo 8 (Mediterranean).** Use case: the owner riding it in autumn (Sep–Nov) 2027. Golden routes: EV8 (primary), plus the EV15 certified section for calibration against its 2025 ECS certification report. |
| D4 | 2026-10-14 | **Routing stays in the batch path.** There is no always-on routing service in production. Detours, access distances and bridge suggestions are computed during audits and closure ingestion. See 10.1 for the cost reason. |
| D5 | 2026-10-14 | **Approach ECF later,** once a credible EV8 prototype exists. Until then, use only public EuroVelo data under its ODbL licence and avoid any use of the EuroVelo® mark that implies endorsement. |
| D6 | 2026-10-14 | **The owner already has an Apple Developer membership,** so WeatherKit (500k calls/month included) can be used as a forecast provider during the prototype, alongside Open-Meteo and MET Norway. |
| D7 | 2026-10-14 | **The LLM is provider-neutral and the model is not chosen yet.** An open-source / open-weight model may be used. LLM features stay optional and sit behind a small interface, so the choice (local or hosted) can wait until a feature needs it. |
| D8 | 2026-10-14 | **The early prototype runs locally on the laptop only.** The API binds to 127.0.0.1; Cloudflare comes later (section 10). |
| D9 | 2026-10-14 | **M0 runs natively on Windows on ARM.** It uses uv + Python 3.14 and Node 24, because nothing in M0 needs GDAL or Docker. **WSL2 + Docker Desktop are required from M1** (Valhalla, osmium, GDAL). Root `package.json` scripts replace `just`, and npm workspaces replace pnpm, to avoid extra tools. |
| D10 | 2026-10-14 | **Audit Bundle v0 (M0) is plain JSON/GeoJSON:** manifest, path, sections, findings, profile. `audit.sqlite` and PMTiles join the bundle in M1, when layers and places arrive. |
| D11 | 2026-10-14 | **Bundles stay file-based JSON in M1** (supersedes the M1 timing in D10). The bundle adds `events.json` (layers), `minor.json` (1 km criteria) and `scores.json`, and path coordinates carry their measures so clients slice exactly. SQLite and PMTiles wait until iOS offline packs or D1 need them, or until the volume of places (M2) does. |
| D12 | 2026-10-14 | **The official GPX stays the measure axis.** Matched OSM edges are laid onto it in proportion to matched length. Matched (ridden) length is reported per section, and a finding is raised when it differs from the published length by more than 10%. |
| D13 | 2026-10-14 | **Traffic stress uses an LTS heuristic (v0), and the ECS-style rules (v0) use placeholder thresholds.** Both are labelled indicative everywhere and live in readable code and YAML (`engine/profiles/`) for tuning. |
| D14 | 2026-10-14 | **The engine runs in Ubuntu (WSL).** It is invoked through `scripts/dpg`, with its virtualenv in `~/.venvs/dpg-engine` and its data in `~/dpg-data`. Valhalla runs in Docker there too (`scripts/valhalla`). The Windows API reads bundles through `\\wsl.localhost\…`, configured in `.env`. |
| D15 | 2026-10-14 | **OSM extracts are chosen automatically:** Geofabrik country extracts (regions with an ISO code) within 3 km of the route, cut to a 15 km corridor. For EV8 that is 12 countries (10.6 GB downloaded, a 1 GB corridor). |
| D16 | 2026-10-14 | **Places come from OSM and Overture.** Overture's places theme already merges records from Foursquare OS Places, Meta, AllThePlaces and others. That gives us Foursquare coverage without the account that Foursquare's own downloads now require (a gated Hugging Face dataset, or its Places Portal). A direct Foursquare adapter waits until the owner decides to create that account. Places are conflated as described in 11.2. |
| D17 | 2026-10-14 | **Access limits per service type** (agreed with the owner). The ridden one-way distance and a time cap decide whether a place counts towards coverage and gap rules; see the table in 11.2. The accommodation limit follows ECS (5 km, or 30 minutes in the mountains). The others are placeholders. |
| D18 | 2026-10-14 | **Seasonality is a 12-month code per place.** OSM `opening_hours` (or `seasonal=*`) is evaluated month by month for the reference year 2027, the ride year. Each month is open, partly (the season starts or ends that month, i.e. a closed stretch of a week or more next to open days), closed or unknown. Unknown counts as available, never as closed, and every gap finding says how much of it rests on unknown hours. Overture has no opening hours. |
| D19 | 2026-10-14 | **Bundles stay file-based in M2.** They add `places.json` and `services.json`. The API loads the places file once per bundle and serves it through a filtered endpoint, so the browser never downloads all of it. SQLite still waits for the iOS offline packs. |
| D20 | 2026-10-14 | **Public transport in M2 means stations plus a curated bike-carriage table, without timetables.** Stations (rail, plus ferry terminals) come from OSM. Whether bikes are carried comes from an in-repo table per country and operator, each row with its source and check date. ECS also requires 2 to 4 services a day, which needs GTFS feeds, so that part of the criterion is reported as not checked. |
| D21 | 2026-10-14 | **The services criteria use the wording of the 2026 ECS short manual.** That means accommodation, food and water, and cycle repair on every daily section; toilets every 15 km; and bikes on public transport at least every 150 km (essential) or 75 km (important). "On a daily section" means a place within the D17 limits, located along that section. |
| D22 | 2026-10-15 | **Routes enter through two kinds of adapter.** *Format readers* (GPX first, then FIT; later TCX, KML, GeoJSON) turn a file into one common shape: tracks or segments, waypoints, and file metadata. They must handle both planned routes (GPX `<rte>`, FIT courses) and recorded tracks (GPX `<trk>`, FIT activities). *Route sources* (EuroVelo, OSM route relations, national networks, user upload) add the meaning: how the route splits into sections, status, official links and licence. A source with no sections of its own is split into stages, by its tracks or days when it has them, otherwise into stages of about 60 km. EuroVelo-only rules (status findings, OSM EuroVelo-relation coverage) apply only to EuroVelo. The current EuroVelo adapter combines both roles and gets split when the second source arrives. See 8 (item 1) and 11.3. |
| D23 | 2026-10-15 | **Places are a shared catalogue; their position along a route is computed per route.** Conflated places (OSM plus Overture, D16) are stored once by area (H3 cells), each version tied to its source snapshots. Any route, of any network or uploaded by a user, draws from that catalogue. Only the route-relative parts (position on the route, detour, whether it counts, gaps) are computed per route. Road layers follow the same idea: values derived from matched OSM ways are cached per way, so routes that share roads share results, and overlap with an audited route can be reported ("62% of this route follows EV8"). Later, routing tiles built per country or region, rather than per route corridor, let a new route be audited without a new tile build. See 11.3. |
| D24 | 2026-10-15 | **POIs that come with a user's file stay private to that route.** Waypoints and FIT course points become *user places* (`source: user`), stored only with that route's audit. They are shown on the map and in the Ahead list with their own style, and may be linked to a matching public place to show its details; that link stays private too. They can optionally count towards that route's own gap figures. They never enter the shared catalogue, are never conflated into public places, and are never shown to anyone else. The pattern follows the private business layers in 8.6. |
| D25 | 2026-10-15 | **Every audit is either public or private.** Network routes are public. A user's route and everything derived from it (bundle, user places, findings) is private: never listed by the API, never added to shared data, and in production returned to the device rather than kept (section 9). Shared data fetched for a private route is cached by coarse area (H3 cells), never by that route's corridor, and corridors are not logged, because a stored corridor would reveal the route. A user file's licence is treated as unknown, so it is never redistributed. On the laptop prototype, private bundles live apart from public ones and are marked as such in their manifest. |
| D26 | 2026-10-15 | **Customers, in priority order** (see "Customers" above): 1) individuals finding, planning and riding adventures, cycling first; 2) possibly, route network organisations wanting regular audits against their own standards; 3) possibly, route publishers wanting a white-label widget (D29). Design choices are weighed against all three; individuals come first. |
| D27 | 2026-10-15 | **Third-party route libraries are never harvested without a partnership.** That rules out bulk import from Komoot, Ride with GPS, Bikepacking.com and others; a partnership with Komoot is unlikely given the overlap. Partnerships are more likely with Bikepacking.com, Epic Road Rides, or local tour companies and associations. Partner routes are audited and shown under that partnership's terms. Without one, a library route reaches DreamPlanGo only as a rider's own private upload (D25). |
| D28 | 2026-10-15 | **The next network after EuroVelo is not chosen yet.** The likely factors are how complete the network is and how many active users it has. Adding it means a route-source adapter and a rules profile for its standards (D22, 8.5). |
| D29 | 2026-10-15 | **White-label means a widget or hosted page that a partner embeds on its own site.** Most partners are small, so it has to be simple to adopt. It covers the Dream and Plan phases only, for now. It reads the partner's public route data from our API, and planning runs in the visitor's browser; nothing about the visitor is stored. The partner sees route-level counts at most, never who viewed what or where they are. Partner staff may have business logins to manage their routes and branding (9.4). A later tie-in, to be discussed: plan on the partner's site, then buy the on-the-road companion as a Trip Pass in the DreamPlanGo app. |
| D30 | 2026-10-15 | **No accounts and privacy-first for as long as possible,** for riders in the app and for visitors to partner sites. If a feature appears to need rider accounts, work stops so it can be discussed with the owner before any design. The mechanisms in section 9 come first. |

---

## 1. Guiding principles

| # | Principle | What it means in practice |
|---|---|---|
| 1 | **Honest beats pretty** | Every value carries a source, an observed date and a confidence. "Unknown" is a valid value: a section where 23% of the surface tags are missing says so. The brand promise depends on this. |
| 2 | **Everything is route-relative** | All data is projected onto route km. "What's ahead in the next 40 km" becomes a range query, not a GIS problem. |
| 3 | **Network-agnostic core** | EuroVelo is one *network adapter*. USBRS, national networks such as France Vélo and the UK NCN, and user-uploaded GPX are other adapters. |
| 4 | **Precompute what's slow, fetch live only what changes** | Infrastructure, services and climate are audited in batch. Forecasts, warnings, smoke and closures are fetched at request time and cached. |
| 5 | **The server knows routes; the device knows the rider** | Personalisation (fitness, dates, stage plan, location) happens on the client. The server only holds non-personal route data. |
| 6 | **Portable by construction** | Storage, cache, queue and scheduler sit behind small interfaces, with laptop implementations now and Cloudflare implementations later. |
| 7 | **Reproducible audits** | Given the same source snapshots and pipeline version, an audit gives the same output. Diffs over time ("+38 km of new greenway since the last audit") are only meaningful under that condition, and they are a key B2B product. |

---

## 2. System overview

```
 ┌──────────────────────────── AUDIT ENGINE  (Python · batch · Docker) ─────────────────────────────┐
 │                                                                                                 │
 │  Source adapters ──► Normalise & ──► Corridor ──► Map-match ──► Decorators ──► Rules & ──► Bundle │
 │  (fetch, snapshot,   measure (LRS)   extract     to OSM        (layers of     scores     writer  │
 │   provenance,        sections        (OSM, DEM,  (Valhalla)    events)        (ECS-       (+diff) │
 │   licence)                           places…)                                 aligned)            │
 └───────────────────────────────────────────────────────────────────────────────────────┬─────────┘
                                                                                         │
                                                            Audit Bundles (versioned, immutable)
                                                            local ./data/bundles  →  later R2
                                                                                         │
 ┌──────────────────────── API  (TypeScript · Hono · Node now → Workers later) ──────────▼─────────┐
 │  Catalogue · audits · layers · findings · places · GPX export · bundle download                 │
 │  Live providers: forecast · warnings · air quality/smoke · fire · closures   (cached by block)  │
 └───────────────┬─────────────────────────────────────────────────────────────┬───────────────────┘
                 │                                                             │
     Prototype web app (V1)                                         iOS app (later phase)
     React + MapLibre: review, tuning,                              offline bundle, on-device
     planner and "Go" simulation                                    planner, StoreKit 2, no account
```

---

## 3. Core domain model

### 3.1 Entities

| Entity | Purpose | Notes |
|---|---|---|
| **Network** | A family of routes with its own metadata and assessment profile | `eurovelo`, later `usbrs`, `fr-velo`, `uk-ncn`, `user` |
| **Route** | A named route within a network | `eurovelo:ev6` (ref, name, official URL, countries) |
| **RouteVersion** | An immutable geometry snapshot | Linked to a source snapshot, e.g. "EuroVelo GPX downloaded 2026-10-10". Has a geometry hash. Routes change over time, so every audit is tied to a version. |
| **Component** | A continuous linear piece of a route version | `kind`: ride, ferry, public-transport link, gap. Carries variants and alternatives, e.g. EV15 left/right bank. |
| **Path** | An ordered sequence of components with its own km measure | The "main line" plus each variant. Users plan along a path. |
| **Section** | A km range on a path with attributes | Kinds: `minor` (1 km, ECS unit), `daily` (EuroVelo daily sections), `country`, `status` (EuroVelo development level), `block` (fixed 50 km tiles for live-data caching) |
| **Layer** | A registered type of decoration | e.g. `surface`, `traffic_stress`, `gradient`, `signage`, `place.accommodation`, `climate.monthly`, `warning`. Has a JSON Schema for its value, a kind (linear / point / areal / temporal) and a version. |
| **Event** | A single decoration on a path | `layer, path_id, from_m, to_m` (or `at_m`), `offset_m, side, access_m, value (typed JSON), source_id, observed_at, valid_from/to, confidence, licence_id` |
| **Source** | A data source snapshot | id, snapshot date/version, licence, attribution string, retrieval method |
| **AuditRun** | One run of a pipeline profile over a route version | Pipeline id and version, decorator versions, source snapshots, parameters, timings, status |
| **Finding** | Something a rider or curator should know | `rule_id, severity (info / caution / warning / blocker), km range, title, detail, evidence (event ids), ecs_criterion, confidence` |
| **Score** | A measured result for a section on one dimension | Pass / fail / unknown per criterion per 1 km minor section, aggregated to % of length (as ECS reports do), plus 0–100 indices for user-facing summaries |

### 3.2 Linear referencing details

- **Measure.** Geodesic metres along the resampled path geometry, in a canonical direction. The reverse direction is handled by transformation (`m' = L − m`, gradients flip, wind is re-evaluated against heading), not by storing the data twice.
- **Point features** such as a campsite or station are projected onto the path with three values:
  - `at_m`: the km position along the route.
  - `offset_m`: straight-line distance off the route.
  - `access_m`: *ridden* detour distance, computed with the routing engine for the nearest candidates.

  The last one matters. "Campsite 400 m away" is useless if it's across the Danube and 12 km by bike.
- **Areal data** (warning areas, protected areas, fire danger cells) is intersected with the path into linear events.
- **Temporal data** (seasonal opening, ferry seasons, monthly climate) uses `valid_from/valid_to` or a month vector in the value.
- **Stable keys.** Events reference `path_id` and the RouteVersion. When a route's geometry changes, the engine re-projects events onto the new version and records which km ranges changed.

---

## 4. The Route Audit pipeline

### 4.1 Stages

| Stage | What happens | Key tools |
|---|---|---|
| **1. Acquire & snapshot** | Source adapters download data and store it under `data/raw/<source>/<snapshot>/` with a manifest recording the licence and attribution. Downloads are idempotent and cached. | httpx, hishel (HTTP cache), tenacity |
| **2. Normalise geometry** | Parse GPX (multiple tracks and segments). Remove duplicate points and GPS spikes. Detect discontinuities (jump > threshold → `gap` component). Detect ferry legs by matching to OSM `route=ferry`. Densify and resample to ~10–20 m. Compute cumulative geodesic measures. Build components and paths. | gpxpy, shapely 2, pyproj (Geod) |
| **3. Sectioning** | Create 1 km minor sections, EuroVelo daily sections and development-status sections (from EuroVelo data), country sections and 50 km live-data blocks. | engine LRS module |
| **4. Corridor extraction** | Buffer each path into a narrow corridor (~1 km) for infrastructure and a wide corridor (~10–25 km) for services, transport and detours. Clip OSM, places and DEM to the corridors. This keeps everything laptop-sized. | osmium-tool, QuackOSM (PBF → GeoParquet with geometry filter), DuckDB spatial, rasterio |
| **5. Map-match** | Snap the route onto the OSM network with an HMM-based matcher (Valhalla `trace_attributes`, bicycle costing). Output: per-segment matched OSM `way_id`s with match confidence. Join the way IDs back to *raw* OSM tags (surface, smoothness, tracktype, maxspeed, lanes, cycleway:\*, lit, width, bridge, tunnel). Unmatched or low-confidence stretches become findings: off-network track, GPX error, or a path missing from OSM. | Valhalla (Docker); own fallback matcher in DuckDB/shapely |
| **6. Decorate** | Decorators turn corridor data into layers of events (4.2). They run as a dependency graph, and each declares what it requires and provides. | engine pipeline runner |
| **7. Assess** | A rules profile (YAML plus small Python rule functions) evaluates the layers into findings and scores. The EuroVelo profile follows ECS. Thresholds are parameters, so they can be tuned from the prototype UI and only this stage re-runs. | engine rules module |
| **8. Package** | Write the Audit Bundle (section 7), render the report, build PMTiles and per-section GPX, and diff against the previous run of the same route. | sqlite3, tippecanoe/pmtiles, Jinja2 + WeasyPrint |

**Incremental and cacheable.** Every decorator's output is keyed by a hash of its code version, parameters, input-layer hashes and source snapshot. Changing one rule threshold re-runs only stage 7, in seconds. A new OSM snapshot re-runs only the affected decorators.

**Freshness.** Sources refresh on different cycles:

| Source | Refresh |
|---|---|
| OSM | Monthly full refresh, plus a daily *change monitor* that reads OSM replication diffs, flags edits to ways inside route corridors (new `construction`, `access=no`, a bridge removed, a new cycleway) and marks sections for re-audit |
| Overture places | Monthly (its release cycle) |
| EuroVelo data | Yearly (ECF updates GPX and status annually) |
| Climate normals | Once, then rarely |

### 4.2 Audit dimensions (decorators and rules)

| Dimension | What we compute | Main inputs | ECS link |
|---|---|---|---|
| **Continuity & gaps** | GPX discontinuities; off-network stretches; development-status gaps; official public-transport-link legs; ferries and their seasons | EuroVelo GPX and status, OSM, ferry data | Continuity |
| **Infrastructure type** | Separated track, greenway, cycle lane, cycle street, quiet road, busy road, track or path | OSM highway, cycleway:\*, bicycle=\*, segregated; matched edge use | Infrastructure components |
| **Traffic stress** | Level of Traffic Stress (LTS 1–4) per segment, with rural adaptations (speed, class, shoulders); measured AADT traffic counts where a country publishes them openly | OSM maxspeed/lanes/class; national traffic-count open data (e.g. FR, DE, NL, UK) | Safety (traffic volume and speed) |
| **Surface & width** | Surface class, smoothness, tracktype, width; rolling-resistance estimate; *% unknown*; suitability per bike type (road, touring, gravel, cargo/trailer) | OSM tags (later: imagery classification) | Surface & width |
| **Gradient & effort** | Smoothed elevation profile, gradient histogram, sustained climbs (with categorisation), max 500 m gradient, climbing per km; bridges and tunnels interpolated rather than taken from the DEM | Copernicus DEM GLO-30; national open LiDAR terrain models where available | Gradients |
| **Signage / wayfinding** | EuroVelo "signed" status per daily section; OSM guideposts and route relations; Mapillary sign detections; a confidence level for each | EuroVelo status, OSM, Mapillary/Panoramax | Signposting |
| **Attractiveness** | Landscape mix (land cover), water/coast proximity, protected areas, heritage and viewpoints, *theme density* (wineries, castles, beaches, villages) for the Dream matchmaker | Corine Land Cover, Natura 2000, OSM tourism/historic, Wikidata | Attractiveness |
| **Services** | Accommodation by type (hotel, B&B, hostel, campsite, cyclist-friendly label); food and resupply; water; toilets; bike shops and repair stations; ATM; pharmacy and hospital. Longest gap per service type in each direction; seasonal opening; detour distance. | OSM, Overture, Foursquare OS Places, cyclist-friendly label schemes | Services (accommodation, food & drink, …) |
| **Public transport** | Stations within X km and their access distance; bike-carriage policy; bail-out coverage (max km to a bike-friendly station) | OSM, GTFS/NeTEx feeds, curated operator bike policies | Public transport |
| **Remoteness** | Population density, distance to the nearest town or services, estimated mobile coverage gaps | GHSL population grid, OSM places, open coverage data where available | — (rider value) |
| **Climate & season** | Monthly normals per daily section (temperature max/min, rain days, heat days, wind rose relative to route heading); daylight hours; school-holiday crowding; ferry and campsite seasons | ERA5 / ERA5-Land, astronomical calculation, OSM opening_hours, OpenHolidays API | — |
| **Data quality** | Divergence between the EuroVelo GPX and the OSM EuroVelo relation; tag completeness; stale or contradictory data | EuroVelo GPX, OSM | Feedback to ECF and the OSM community |

### 4.3 Findings, scores and confidence

- **Findings** are the "local buddy" content, e.g. "km 312–318: 6.2 km on a 80 km/h road without shoulder, LTS 4, no EuroVelo signs observed. Bridge option: riverside track on the south bank, +1.8 km, LTS 1, gravel."
- **ECS-style scoring.** Each criterion is pass / fail / unknown per 1 km minor section, aggregated to the % of length meeting essential and important criteria. That mirrors how ECS certification reports summarise a route, so our output can be compared directly with published reports.
- **User-facing indices** are 0–100 or 1–5 per daily section: Physical challenge (climbing, gradients, surface roughness, distance between services), Comfort and safety, Wayfinding, Services, Remoteness and Scenery. Each index shows its confidence.
- **Confidence** comes from data completeness (% of km with the relevant tags), source agreement (EuroVelo status vs. OSM vs. imagery) and data age.

### 4.4 "Gaps to bridge"

The engine classifies each gap:

- Undeveloped or unknown official section
- Official public-transport link
- Broken GPX
- Off-network
- Unsafe (LTS 4)
- Unrideable for the chosen bike type
- Seasonal: ferry not running, pass closed
- Services desert

For each gap it suggests bridging options:

- An alternative routed line (Valhalla or BRouter with a low-stress cycling profile), audited with the same decorators.
- A train or bus hop between two stations that accept bikes.
- A ferry.

Bridges are stored as optional *variant components*. The rider's starter GPX can include them as alternative tracks.

---

## 5. Data sources

Licence notes reflect my current understanding. Anything marked **verify** needs a check of the provider's terms before commercial launch.

### 5.1 Route geometry and route metadata

| Source | Use | Access | Licence / cost |
|---|---|---|---|
| **EuroVelo GPX tracks** (ECF) | Official geometry; development status per daily section (new 7-category legend in 2026; updated yearly) | Download from eurovelo.com / pro.eurovelo.com | **ODbL** since Oct 2024 (licence document updated Dec 2025). Attribution: credit EuroVelo.com, the download date and ODbL. Share-alike on derived databases. "EuroVelo®" is a registered ECF trademark, so don't imply endorsement. |
| **ECS manuals and certification reports** | Rule design; calibration ground truth | PDFs on eurovelo.com | Reference only |
| **EuroVelo Data Hub** (ECF) | Network stats, development-status reports, usage barometer | pro.eurovelo.com | Reports; potential data partnership |
| **OSM route relations** (`route=bicycle`, `network=icn/ncn/rcn`, `ref=EV6`) | Second geometry source; national and regional networks; data-quality comparison | OSM extracts | ODbL |
| **User GPX / FIT** (later) | Any route, with its own waypoints or course points | Upload, read by format readers (D22) | User's own data, licence unknown: kept private and never redistributed (D24, D25; privacy, section 9) |
| **USBRS / other networks** (later) | Other networks via adapters | e.g. AASHTO / Adventure Cycling data, OSM `network=ncn` in the US | Varies, **verify** |

### 5.2 Road and path network, base map, terrain

| Source | Use | Access | Licence / cost |
|---|---|---|---|
| **OpenStreetMap** | Network attributes, POIs, ferries, stations, guideposts | Geofabrik country/Europe extracts (PBF); replication diffs | ODbL, free |
| **Valhalla** (self-hosted) | Map matching, detour/bridge routing, access distances | Docker, tiles built from corridor-clipped OSM | MIT, free |
| **BRouter** (optional) | Cycling-specialist alternative routing for bridges | Self-host (Java) | MIT, free |
| **OpenFreeMap** or **Protomaps** | Basemap vector tiles for the prototype | OpenFreeMap: hosted, no key. Protomaps: PMTiles file self-hosted (later on R2) | OSM-derived (ODbL attribution), free |
| **Copernicus DEM GLO-30** | Elevation everywhere in Europe | Cloud-optimised GeoTIFFs (AWS Open Data) | Free incl. commercial, attribution. Note: it is a *surface* model (includes trees and buildings), so it needs smoothing plus bridge/tunnel handling. |
| **National LiDAR terrain models** | Better gradients where available | e.g. NL AHN, FR IGN RGE ALTI / LiDAR HD, ES CNIG, DE state DGM1, AT, DK | Mostly open licences, **verify** per country |
| **Mapillary** / **Panoramax** | Signage evidence; surface spot-checks | Mapillary API (token); Panoramax API | Mapillary: free API, imagery CC BY-SA, **verify** ToS for derived commercial data. Panoramax: open. |

### 5.3 Services: accommodation, food, water, repair

| Source | Use | Access | Licence / cost |
|---|---|---|---|
| **OSM POIs** | Hotels, guest houses, hostels, campsites, shelters, water, toilets, shops, cafés, `shop=bicycle`, `amenity=bicycle_repair_station`, pharmacies, ATMs, e-bike charging | Corridor extracts | ODbL |
| **Overture Maps Places** | Extra POI coverage and confidence | Monthly GeoParquet releases, queried with DuckDB | CDLA-Permissive-2.0 (places theme) |
| **Foursquare OS Places** | Extra POI coverage | GeoParquet | Apache 2.0 |
| **Cyclist-friendly labels**: Bett+Bike (DE), Accueil Vélo (FR), Fietsers Welkom! (NL), others | "Cyclist-friendly" flag on accommodation and cafés | France: some via **DATAtourisme** (open). Others by partnership. | Varies. ECF reports 26,000+ labelled businesses network-wide, a partnership opportunity. |
| **Booking.com / Expedia affiliate** (later) | "Book" deep links and revenue | Affiliate programmes (deep links need no data sharing) | Commercial; earns commission |
| **Warmshowers, ACSI campsites** | Link-out only (no open API) | — | — |
| **Google Places** | *Avoid for core data*. Its terms forbid storing anything but place IDs and require display on Google maps, which is incompatible with offline packs. Deep links ("open in Google Maps") are fine. | — | — |

Multiple POI sources are **conflated** into one Place, matched by distance plus name similarity, keeping links to each source.

### 5.4 Public transport

| Source | Use | Access | Licence / cost |
|---|---|---|---|
| **OSM** stations and stops | Station locations along the corridor | Extracts | ODbL |
| **Mobility Database** catalogue + **national access points** (EU rules require member states to publish transit data) | GTFS/NeTEx timetables, `bikes_allowed` where populated | Feed downloads | Mostly open, varies per feed |
| **Transitous** (community MOTIS-based European journey planner) | "Train from A to B" in the prototype | Public API (fair use) | Free; self-host **MOTIS** (MIT) for production |
| **Curated bike-carriage policy** | Per operator / train type: bikes allowed? reservation? seasonal rules? | Our own dataset, a few hundred rows, maintained in-repo | Ours |

### 5.5 Climate (Dream phase)

| Source | Use | Access | Licence / cost |
|---|---|---|---|
| **ERA5 / ERA5-Land** (Copernicus Climate Data Store) | 30-year monthly normals per daily section: temperatures, rain days, heat days, wind roses | CDS API, one-off batch per corridor bbox | Free incl. commercial, attribution |
| **Open-Meteo Historical API** | Fast path while prototyping | Simple REST | Free for non-commercial use only; paid plan for commercial use |
| **Astronomical calculation** | Daylight hours, sunrise and sunset | Library (suncalc) | — |
| **OpenHolidays API** | School and public holidays by country and region (crowding, accommodation pressure) | REST | Open data |
| **Eurostat tourism statistics** | Seasonal tourism intensity by region | Eurostat API | Free (Eurostat reuse policy) |

### 5.6 Live: forecasts, warnings, fire, smoke, water levels, closures (Go phase)

| Source | Use | Access | Licence / cost |
|---|---|---|---|
| **Open-Meteo Forecast** | Prototype forecasts (ECMWF, ICON, Météo-France, … blended) | REST | Free non-commercial; commercial plan or self-host (open source) for production |
| **MET Norway Locationforecast** | Production-grade free forecast | REST, identifying User-Agent, must cache | Free incl. commercial, CC BY 4.0 |
| **Apple WeatherKit** | Forecasts from the backend now (D6) and on iOS later | REST/Swift | 500k calls/month included with the Apple Developer Program (already held); attribution required |
| **MeteoAlarm** (EUMETNET) | Official warnings, ~38 European countries, CAP format | Atom/CAP feeds | Free. **Verify** redistribution terms and national members' terms. Germany's feed differs. Since 2024 the EU high-value-datasets rules also require national met services to publish warnings openly (fallback per country). |
| **CAMS** European air-quality forecast | PM2.5/PM10 forecasts, i.e. wildfire smoke and Saharan dust | Copernicus ADS API, or Open-Meteo Air Quality API | Free, attribution (Open-Meteo same caveat) |
| **EFFIS** (Copernicus fire service) | Fire danger forecast, active fires, burnt areas | WMS/WFS/downloads | Free, attribution |
| **NASA FIRMS** | Near-real-time fire hotspots (VIIRS/MODIS) | REST with free MAP_KEY | Free |
| **National river gauges**: PEGELONLINE (DE), Hub'Eau/Vigicrues (FR), others | Riverside path flooding (Danube, Rhine, Elbe, Loire) using curated per-section flood thresholds | REST | Open |
| **Closures and diversions** | No single source exists, so we build one by layering: (1) curated entries from NECC and EuroVelo news and national route sites, with LLM-assisted extraction from multilingual pages and human approval; (2) DATEX II roadworks from national access points (motor-road heavy); (3) the OSM corridor change monitor; (4) seasonal closures (ferries, alpine passes); (5) later, anonymous rider reports | Mixed | Mixed; curated layer is ours |

### 5.7 Attractiveness and remoteness

| Source | Use | Licence |
|---|---|---|
| **Corine Land Cover** (Copernicus) | Landscape character | Free, attribution |
| **Natura 2000** (EEA) | Protected areas | CC BY 4.0 |
| **Wikidata** | Geotagged heritage, notable places | CC0 |
| **GHSL population grid** (JRC) | Remoteness | CC BY 4.0 |
| **OSM** viewpoints, historic, wineries, beaches | Theme density | ODbL |
| Avoid **WDPA / Protected Planet** | Non-commercial terms | — |

### 5.8 Commercial options worth knowing (not needed for V1)

| Service | When it's worth it |
|---|---|
| TomTom / HERE traffic statistics | Real traffic volumes for B2B reports |
| Open-Meteo commercial plan | Simplest production weather |
| MapTiler (Swiss, EU-friendly) | Hosted basemaps, if self-hosting tiles becomes a chore |
| Affiliate accommodation APIs | Revenue |

Strava Metro is only available to planning organisations. It can't be used by us, but our B2B customers often have it, so the design allows them to bring their own layers (section 8).

### 5.9 Paid services during prototyping

Only one item costs money, and it is optional. Everything else is free or free with registration.

| Item | Needed? | Cost |
|---|---|---|
| **LLM** (closure extraction, narrative summaries) | Optional; the audit works without it. Model not chosen yet (D7). | An open-weight model run locally costs nothing but laptop time; hosted APIs are pay-per-use |
| **Open-Meteo** forecasts and air quality | Free tier. Their pricing page says to use it for evaluation and prototyping. Limit: 10,000 calls a day. | $0 now. A paid plan is needed before launch, because an app with paid passes counts as commercial. |
| **Climate history** | Use ERA5 from Copernicus CDS, not Open-Meteo's historical API, which needs its Professional tier for commercial use | $0 (free account) |
| **Free accounts or keys to register** | Copernicus CDS and ADS, NASA FIRMS, Mapillary | $0 |
| **Cloudflare Workers Paid** | Only if deploying during the prototype. Tunnel + Access are free for sharing from the laptop. | $5/month |
| **Apple Developer Program** | Already held (D6); unlocks WeatherKit now | $0 extra |
| **Commercial traffic volumes** (TomTom/HERE) | Deferred to B2B; first test whether the traffic-stress estimate from OSM tags holds up on EV8's on-road stretches | Sales-led pricing |

### 5.10 Licensing implications (important for monetisation)

- **EuroVelo GPX and OSM are both ODbL, so they combine cleanly.** Our derived audit database, built from them, is an ODbL *derivative database*. If we use it publicly (app users, B2B), we must offer that derived database under ODbL. Maps, screens and PDF reports are *produced works* and only need attribution.
- **Recommended strategy:**
  - Publish the OSM/EuroVelo-derived layers openly. It costs little and builds goodwill with ECF and the OSM community.
  - Keep curated and proprietary layers (closures registry, bike-policy dataset, field validations, customer data) as *separate* layers. Under OSMF guidance this forms a "collective database", where the separate layers aren't pulled into share-alike.
  - Sell the analysis, freshness, change tracking, prioritisation, reports and app experience, not the raw data.
- **This is one reason per-layer provenance is in the core model:** licence compliance becomes a query.
- Get a short legal review before B2B sales.

---

## 6. Technology stack

### 6.1 Why Python and TypeScript

- **Python for the engine.** It has the strongest geospatial ecosystem (shapely, pyproj, rasterio, DuckDB spatial, pyosmium, xarray), which is what heavy audit work needs. None of it runs inside a Worker, since Workers allow 128 MB of memory, have no GDAL and a limited CPU budget. As a Docker image it runs unchanged on the laptop, in Cloudflare Containers, or on any VM.
- **TypeScript for the API and web app.** It is first-class on Cloudflare Workers, and Hono runs identically on Node (laptop) and Workers. The planner logic, written once in TS, runs in the browser now and is small enough to port to Swift later.
- **The contract** between them is JSON Schema, generated from the engine's Pydantic models into TypeScript types. One source of truth.

Alternative considered: all Python (FastAPI) for V1, then rewrite the API for Workers later. It's simpler on day one, but you'd pay for it with a rewrite at migration. Not recommended.

### 6.2 Engine (Python 3.13+)

| Purpose | Library / tool |
|---|---|
| Env and packaging | **uv** |
| Models, validation, JSON Schema export | **Pydantic v2** |
| CLI | **Typer** |
| Local job API for re-runs triggered from the prototype | **FastAPI** + uvicorn (a small admin surface only) |
| GPX | **gpxpy** |
| Geometry and projections | **shapely 2**, **pyproj** |
| Columnar and spatial queries | **DuckDB** (+ spatial extension), **pyarrow**, GeoParquet |
| OSM extraction | **osmium-tool** (CLI), **pyosmium** (replication diffs), **QuackOSM** (PBF → GeoParquet with geometry and tag filters) |
| Overture | DuckDB direct queries on the release GeoParquet |
| DEM sampling | **rasterio** (windowed reads of COGs), **numpy**, **scipy** (Savitzky–Golay smoothing) |
| Climate | **xarray**, **netCDF4**/**cfgrib**, **cdsapi** |
| Spatial index | **h3** (H3 hex cells, for "near" lookups that work in SQLite, D1 and on device) |
| POI conflation | **rapidfuzz** |
| Opening hours | OSM `opening_hours` parser (Python binding; JS `opening_hours` on the API side) |
| HTTP | **httpx**, **hishel** (caching), **tenacity** (retries) |
| Reports | **Jinja2** + **WeasyPrint** (HTML → PDF) |
| Vector tiles | **tippecanoe** (CLI) → PMTiles |
| Logging | **structlog** |
| Quality | **pytest**, **hypothesis** (property tests for the measuring maths), **syrupy** (snapshot tests on golden routes), **ruff**, **pyright** |

Docker services:

- **Valhalla** for map matching and routing, run in Docker on Ubuntu (WSL). The official images `ghcr.io/valhalla/valhalla` and `ghcr.io/valhalla/valhalla-scripted` publish `linux/arm64` builds (checked 2026-10-14), so no source build is needed.
- **BRouter**, optional.

### 6.3 API (TypeScript, Node 24 LTS now, Workers later)

| Purpose | Library |
|---|---|
| HTTP framework (Node + Workers) | **Hono** |
| Validation and OpenAPI | **Zod** + **@hono/zod-openapi** |
| SQL over SQLite now, D1 later | **Drizzle ORM** (better-sqlite3 driver locally, D1 driver on Workers) |
| Blob storage abstraction | Own tiny interface: local filesystem ↔ R2 |
| Cache abstraction | In-memory/disk LRU locally ↔ Workers Cache API / KV |
| Geo helpers | **h3-js**, **@turf/** (selected modules), **suncalc**, **opening_hours** |
| Tests | **vitest** |
| Workers tooling (later) | **wrangler** |

### 6.4 Prototype web app

| Purpose | Library |
|---|---|
| Build | **Vite**, **React 19**, TypeScript |
| Map | **MapLibre GL JS**, **pmtiles** protocol, OpenFreeMap basemap; terrain hillshade optional |
| Data fetching | **TanStack Query** |
| Charts (elevation profile, "strip diagram", climate heatmaps) | **uPlot** (fast, small) and/or **Observable Plot** |
| Styling | Plain CSS modules (no UI framework needed for a review tool) |

### 6.5 Monorepo layout

```
dreamplango/
  docs/                    design, ADRs (architecture decision records), data-licence register
  schemas/                 JSON Schemas (generated from engine models): the shared contract
  engine/                  Python package `dpg_audit`
    src/dpg_audit/
      sources/             adapters: eurovelo, osm, overture, fsq, dem, era5, gtfs, …
      lrs/                 measuring, projection, sectioning, path graph
      match/               Valhalla client + fallback matcher
      decorators/          one module per layer family
      rules/               rule functions; profiles/ holds YAML (eurovelo-ecs.yaml, user-gpx.yaml, …)
      pipeline/            dependency-graph runner, content-hash cache, provenance
      outputs/             bundle writer, GPX writer, report renderer, tiles
      jobs/                FastAPI admin/job server (local)
    tests/  golden/        golden routes + expected snapshots
  packages/
    planner/               TS: stage planner + riding-time model (pure, portable)
    contracts/             TS types generated from /schemas
  api/                     Hono app (Node entry + Workers entry)
  web/                     Vite/React prototype
  infra/                   docker-compose (valhalla, engine), Dockerfiles, later wrangler config
  data/                    (git-ignored) raw/ cache/ work/ bundles/
  package.json             npm workspaces + task scripts (`npm run ingest:ev8`, `npm run dev`, …) (D9)
  .claude/launch.json      dev-server definitions (api, web, web-preview)
```

As built in M0, the engine has `config`, `models`, `contracts`, `lrs/`, `ingest/gpx`, `networks/eurovelo`, `build` (path assembly + data-quality findings), `bundle` and `cli`. The `sources/`, `match/`, `decorators/`, `rules/` and `pipeline/` packages arrive with M1.

### 6.6 Running it on the Windows on ARM laptop

- **M0 ran natively on Windows (D9).** From M1 onwards, use WSL2.
- **WSL2 + Ubuntu 24.04 (arm64)** is the development environment from M1. Python geospatial wheels (shapely, pyproj, rasterio, DuckDB, pyarrow, h3, pyosmium) all ship Linux aarch64 builds. VS Code connects with Remote-WSL.
- **Docker Desktop for Windows on Arm** runs the linux/arm64 containers (Valhalla, engine).
- **Keep `data/` on the WSL ext4 filesystem**, not under `/mnt/c`. Cross-filesystem I/O is many times slower.
- **Disk budget:** roughly 100–150 GB for all routes (OSM extracts, corridor GeoParquet, Valhalla tiles, DEM tiles, climate cache). Starting with 2–3 routes needs far less.
- **Sharing the prototype:** a **Cloudflare Tunnel** plus **Cloudflare Access** lets you show it to someone without opening ports, and you already use Cloudflare.

---

## 7. Audit Bundle and API

### 7.1 Audit Bundle (the central artifact)

`bundles/<network>/<route>/<run-id>/`, where `run-id = <timestamp>_<content-hash>`:

| File | Content |
|---|---|
| `manifest.json` | Route version, pipeline profile + versions, source snapshots, **licences and attribution strings**, stats |
| `audit.sqlite` | Paths, components, sections, events (typed columns + JSON value), places, findings, scores, climate. Indexed by `(path_id, from_m)` and by H3 cell, with no spatial extension needed, so the same file works in Node, D1 and on iOS. |
| `tiles.pmtiles` | Route lines styled by layer, findings and places, for fast map rendering |
| `gpx/` | Starter GPX per daily section, annotated with waypoints for findings (shows up on Garmin and in RWGPS/Strava imports) |
| `report.html` / `report.pdf` | Human-readable audit report |
| `diff.json` | Changes vs. the previous run (km improved or degraded, new or resolved findings) |

A pointer file per route marks the "current" bundle. Publishing is an atomic pointer swap, and rollback is trivial.

**Bundle v0 (M0, D10):** `manifest.json`, `path.geojson` (ride components, plus gap connectors between them), `sections.json` (daily, status, components, 50 km blocks, 1 km minor sections), `findings.json` and `profile.json` (elevation every 200 m). The schema is in `schemas/bundle-v0.schema.json`, and the TS types are generated into `packages/contracts`. M1 added `events.json`, `minor.json` and `scores.json` (D11). M2 adds `places.json` and `services.json` (D19), and the API serves places through `GET /v1/routes/{network}/{ref}/places` with filters.

### 7.2 API sketch (v1)

```
GET  /v1/networks                                    list networks
GET  /v1/networks/{net}/routes                       routes with headline indices
GET  /v1/catalogue                                   compact Dream catalogue (all daily sections × month), cacheable
GET  /v1/routes/{route}                              route summary, current audit id, paths/variants
GET  /v1/audits/{audit}/sections?kind=daily
GET  /v1/audits/{audit}/layers/{layer}?path=&from_km=&to_km=
GET  /v1/audits/{audit}/findings?severity=&from_km=&to_km=
GET  /v1/audits/{audit}/places?cat=&from_km=&to_km=&max_detour_m=
GET  /v1/audits/{audit}/climate?month=
GET  /v1/audits/{audit}/gpx?from_km=&to_km=&annotate=true&bridges=true
GET  /v1/audits/{audit}/bundle                       offline pack (sqlite + pmtiles)
GET  /v1/audits/{audit}/report                       HTML/PDF

GET  /v1/live/forecast?route=&block=                 hourly grid at points every ~10 km in a 50 km block, next 72 h
GET  /v1/live/alerts?route=&block=                   warnings, fire, smoke, flood, closures intersected with the block

# prototype-only admin (local)
POST /admin/audits {route, profile, params}          trigger a run via the engine job server
GET  /admin/runs, /admin/runs/{id}/log, /admin/diff?a=&b=
```

Live data is requested by *route block* (a fixed 50 km tile of a route), never by GPS coordinate. The client turns the block's grid into "your weather at your expected position and time". The server learns only that someone looked at a 50 km stretch. Every user asking about the same block shares one cached response, which keeps things private and cheap.

---

## 8. How the flexibility is achieved

1. **Network-agnostic core model.** Network → Route → RouteVersion → Component/Path. EuroVelo-specific knowledge (status legend, daily sections, ECS rules) lives in a *network adapter* and a *rules profile*. Adding USBRS means writing an adapter and a profile, not changing the core. Adapters come in two kinds (D22): *format readers* (GPX, FIT, …) parse files into one common shape, and *route sources* (EuroVelo, OSM relations, user upload, …) give that shape its sections, status and licence.
2. **Linear-referenced event layers** are the universal "decoration" mechanism. Any dataset that can be located (points, lines, areas, time windows) becomes events on route km.
3. **Plug-in registries** for five extension types:

   | Plug-in | What it does |
   |---|---|
   | Source adapters | Fetch and snapshot data, with provenance and licence |
   | Decorators | `requires` → `provides` layers, declared versions and parameters, `applies_to` predicate (region/network) |
   | Rules | Turn layers into findings and scores, grouped into YAML profiles |
   | Live providers | Request-time data |
   | Renderers | Report and GPX formats |

   Python plug-ins register through package entry points, so a new data source is a new module plus one line of config.
4. **Region capability registry.** Each provider declares the area it covers, e.g. warnings: Europe → MeteoAlarm, US → NWS; air quality: Europe → CAMS, US → AirNow; traffic counts: FR → national open data. The pipeline picks providers per section, so mixed or new regions work automatically.
5. **Profiles, not code, define audit types.** `eurovelo-ecs.yaml` (ECS-aligned), `user-gpx.yaml` (lighter, faster), `b2b-tourism.yaml` (services and business-opportunity focus), `usbrs.yaml` later.
6. **Bring-your-own-data layers.** B2B customers can upload private layers (counter data, Strava Metro exports, their own signage surveys). These are stored as separate, access-controlled layers and appear in their reports.
7. **Provenance and licence on every datum.** You can add commercial or restricted sources without contaminating open layers, and attribution is generated automatically.
8. **Versioned, immutable bundles** consumed by every client (API, web, iOS offline, report renderer), so new consumers don't need new pipelines.
9. **Ports and adapters for infrastructure** (blob store, SQL, cache, queue, scheduler), so laptop → Cloudflare is configuration plus thin adapters.
10. **Contract-first API** (OpenAPI generated from Zod, types generated from JSON Schema), versioned under `/v1`.

---

## 9. Privacy, and the "no account" question

### 9.1 Verdict

The no-account path is feasible for the consumer app. Nothing in the Dream–Plan–Go flow needs us to know who the user is. Apple already holds the purchaser's identity, and the user's own iCloud can hold their plans. What remains is a small, well-understood amount of transient processing (IP addresses, signed purchase receipts) that GDPR still covers, but which needs no accounts, consent banners or trackers.

### 9.2 How each need is met

| Need | Mechanism | Personal data we hold |
|---|---|---|
| Buy a Trip Pass | **StoreKit 2** in-app purchase; Apple handles payment and identity | None (Apple is controller for payment data) |
| Restore on a new phone or family devices | StoreKit `currentEntitlements` / restore, Family Sharing | None |
| Server checks the user owns a route (bundle download, live features) | App sends Apple's signed transaction (JWS); server verifies the signature with Apple's public certificates; stateless | None stored. Refund revocations via App Store Server Notifications, keyed by a *hashed* transaction id. |
| Sync plans across devices | **CloudKit private database** / iCloud, which lives in the user's iCloud and that we cannot read | None |
| "What's near me", "what's ahead" | **Offline bundle on device**: all near-me queries run locally (also essential where coverage is patchy) | None. Location never leaves the device. |
| Live weather, warnings, smoke, closures | Requests **by route block**, CDN-cached and shared; the server proxies third-party APIs so the user's IP never reaches them | IP transiently (request processing only; app-level logs exclude IPs) |
| Rider profile, fitness, dates, stage plan | Stored and computed **on device** (planner runs locally) | None |
| Background alerts ("storm warning on tomorrow's stage") | Option A: background refresh + **local notifications** (no server state). Option B: **Live Activity broadcast channels** (iOS 18+), one channel per route block; the server never sees device tokens. Option C (opt-in): APNs token + subscribed blocks + automatic expiry at trip end. | A/B: none. C: pseudonymous token, short-lived. |
| Upload own GPX or FIT for audit (later) | Device trims a privacy zone at start and end (home address); processed in an ephemeral container; result returned; nothing retained (or cached only by content hash for a few hours). The audit is private (D25): the file's own POIs stay with it as user places (D24), and shared data fetched for it is cached by coarse area, never by its corridor | Transient |
| Anonymous issue reports ("path flooded at km 412") | Report carries the issue's location, not the rider's track; abuse control via **App Attest / DeviceCheck** (no identity) | Issue location + coarse time |
| Crash diagnostics | Apple's built-in reports / MetricKit (user opts in at OS level); no third-party SDKs | None from us |

On the App Store, Apple's definition of "collected" excludes data processed only to serve a request in real time and not retained. With the design above, the App Privacy label can plausibly be **"Data Not Collected"**, which is a strong market differentiator.

### 9.3 Obligations that remain

| Area | What remains |
|---|---|
| **GDPR** | IP addresses are personal data, so we still need a privacy notice, a record of processing, and Cloudflare's data processing agreement (available on self-serve plans). A lightweight DPIA is wise because the product involves location, even though location stays on the device. Data-subject requests are trivial when nothing is stored. |
| **ePrivacy (cookies/storage)** | Storing the user's own trips and offline packs on their device is "strictly necessary" for the service they asked for, so no consent prompt is needed, *provided* there are no analytics or ad SDKs. |
| **App Store / EU DSA** | Apple requires EU *trader status*. If you are a trader (you will be, once selling), your address, phone and email are shown on the EU App Store page. Plan for a business address. |
| **Affiliate booking links** | Once a user taps through, Booking.com and others are controllers of their own processing. Disclose this in the privacy notice. |

### 9.4 Where accounts (or something like them) would become necessary

| Situation | No-account alternative |
|---|---|
| **B2B portal** (route curators, tourism boards) | None needed: accounts here are fine, since this is business contact data under contract. Use Cloudflare Access or simple organisation logins. |
| **Selling outside the App Store** (web, Android, gift passes) | Redeemable **Trip Pass codes** (bearer tokens), plus Google Play Billing on Android. Still no account. |
| **White-label partner sites** (D29) | Visitors need no account. The widget reads public route data and plans in the browser; a saved plan stays in the browser or is exported as a file or an encrypted share link. Partner staff use business logins (as for the B2B portal). Any later need for rider accounts is discussed with the owner first (D30). |
| **Sharing a trip with riding partners** | **End-to-end encrypted share links**: plan encrypted on device, key in the URL fragment (never sent to the server), blob stored with expiry. |
| **Paid passes for arbitrary user GPX routes** | A consumable purchase can't be restored by Apple. Store an anonymous entitlement token in iCloud Keychain, with a server-side record keyed by hashed transaction id. Still pseudonymous, still no account. |

---

## 10. Migration path: laptop → Cloudflare

| Concern | V1 (laptop) | Cloudflare |
|---|---|---|
| Audit engine | `npm run ingest:…` (native in M0; Docker in WSL2 from M1) | **Cloudflare Containers** (GA Apr 2026), triggered by **Workflows** / **Queues** / **Cron Triggers** |
| Bundles and raw data | `./data` | **R2** (no egress fees, good for offline-pack downloads) |
| Query store | `audit.sqlite` per bundle | **D1** (import per route; 10 GB per database is plenty) |
| API | Hono on Node | Hono on **Workers** (same code, different entry file) |
| Live-data cache | In-memory/disk LRU | **Cache API** + **KV** |
| Scheduled refresh (warnings polling, OSM change monitor) | cron in WSL | **Cron Triggers** → Workers / Containers |
| Prototype web app | Vite dev server | Workers static assets |
| Valhalla (routing/matching) | Docker | A Container may struggle with large tile sets on ephemeral disk. A small always-on VM is a pragmatic alternative. **Evaluate in V1.** |
| Secrets | `.env` | Workers secrets |

### 10.1 Estimated Cloudflare cost

Rates are Cloudflare's published Containers and R2 pricing, checked 2026-10-14, in USD. Containers require the **Workers Paid plan ($5/month)**.

**Container usage included in the plan each month:**
- 25 GiB-hours of memory
- 375 vCPU-minutes of CPU
- 200 GB-hours of disk

**Rates beyond the included usage:**

| Resource | Rate | Equivalent |
|---|---|---|
| Memory | $0.0000025 per GiB-second | $0.009 per GiB-hour |
| CPU (billed on active use only) | $0.000020 per vCPU-second | $0.072 per vCPU-hour |
| Disk | $0.00000007 per GB-second | ~$0.00025 per GB-hour |

Billing is in 10 ms increments while an instance runs, and stops when it sleeps. The largest instance is `standard-4`: 4 vCPU, 12 GiB memory, 20 GB disk.

**R2 storage:** $0.015 per GB-month after 10 GB free. No egress fees, which matters for offline-pack downloads.

The audit durations below are estimates, to be replaced with measured numbers from the laptop in M1.

| Scenario | Assumption | Containers | Total incl. plan |
|---|---|---|---|
| **EV8 only (V1 / your 2027 trip)** | Full EV8 re-audit monthly on `standard-4`, ~2 h at ~75% CPU (24 GiB-h, ~6 vCPU-h, 40 GB-h) | **$0**, fits inside the included usage | **≈ $5–6/month**, including ~20–40 GB of R2 |
| **All 17 EuroVelo routes** | ~25 h/month of audit runs on `standard-4` | ≈ $7.50 (memory $2.48, CPU $4.95, disk $0.08) | **≈ $15/month**, including 100–200 GB of R2 |
| *Always-on routing (avoided, D4)* | Valhalla on `standard-3` (8 GiB) 24×7, ~5% CPU | ≈ $60/month | — |
| *Same, on `standard-4` (12 GiB)* | 24×7 | ≈ $92/month | — |

**Takeaways**

- **The always-on case is the cost trap.** Memory and disk are billed for the whole time an instance is awake, even when idle. A permanently running routing server costs 10–20× more than all batch audits combined, which is why D4 keeps routing in the batch path.
- **If request-time routing is needed later** (e.g. on-demand audits of user GPX files), there are two options:
  - Wake a container on demand, with routing tiles baked into the image.
  - Run routing on a small ARM VM at an EU host.
- **Request-path costs stay small at app scale.** Workers requests, D1 and R2 reads have large included allowances, and live data is cached per 50 km route block.
- **The bigger future costs aren't Cloudflare's:** a commercial weather plan once you charge money, and the Apple Developer Program ($99/year).

### 10.2 Container constraints that shape the engine

- **Instances are capped at 12 GiB memory and 20 GB disk, and disk is ephemeral.** All persistent state lives in R2. The engine processes one country at a time, streaming the inputs from R2. Whole-Europe OSM work (a ~30 GB extract) is not possible in a single container.
- **Valhalla tiles must fit within instance disk.** For EV8, corridor-clipped tiles for all its countries should fit well under 20 GB. For the whole network, shard by region: one container instance per region, each addressed through its own Durable Object.

---

## 11. What V1 will build

Milestones are ordered so you can see something in the browser early and tune as you go.

| # | Milestone | Deliverables |
|---|---|---|
| **M0** ✅ 2026-10-14 | Foundations | Repo, task scripts, schemas, data-licence register. EuroVelo GPX inspected and ingested (see `docs/notes/eurovelo-gpx.md`). LRS core (measure, locate, project, slice, resample, sections) with property tests. Bundle v0 for EV8, a Hono API, and a React/MapLibre viewer with section list, findings and elevation profile. Natively on Windows; WSL2/Docker moved to M1 (D9). |
| **M1** ✅ 2026-10-14 | Infrastructure audit | Corridor extraction; Valhalla matching; layers: infrastructure type, surface, traffic stress (LTS), elevation and gradient, waymarked network (OSM relations), continuity and typed gaps. ECS-style rules v0, scores, findings. Bundle files per D11. Prototype: map coloured by layer, **strip diagram** under the elevation profile, stats card, findings linked to the map. **Known limits, carried forward:** <ul><li>The DEM is sampled along the published track, not the matched road, so some coastal values may be cliff artefacts.</li><li>No national LiDAR terrain models yet.</li><li>Signage evidence is EuroVelo status plus OSM relations only (no guideposts or imagery).</li><li>LTS is heuristic, with no traffic counts.</li><li>Straight-line placeholders are not routed around.</li><li>Seasonality moved to M2.</li></ul> |
| **M2** ✅ 2026-10-14 | Services & access | Places conflation (OSM + Overture, which includes Foursquare: D16), seasonal opening, detour distances, stations + curated bike policy, services-gap and bail-out rules. Prototype: "what's ahead from km X" panel and services filters. See 11.2 and the M2 results in `docs/notes/eurovelo-gpx.md`. **Known limits, carried forward:** <ul><li>Opening seasons are published for only ~2% of accommodation (OSM; Overture has none), so seasonal gaps are mostly unknown. Candidate fixes: campsite directories, DATAtourisme for France, field reports.</li><li>No timetables yet (GTFS), so ECS service frequency is not checked; buses and taxis are not counted for bail-out.</li><li>Bike policy for Greece and Albania is unknown, and Türkiye's is low-confidence.</li><li>Ferry terminals count as bike-carrying by default (low confidence).</li><li>Climb to a place is net elevation difference, not the climb along the detour.</li><li>No cyclist-friendly labels (Accueil Vélo etc.) yet.</li></ul> |
| **M3** | Dream data | Climate normals per daily section × month, daylight, wind relative to heading, direction advice, school holidays, ferry/campsite seasons, attractiveness and remoteness layers. Prototype: **best-time heatmap** (sections × months) and a section **matchmaker** query. |
| **M4** | Plan | `packages/planner` with stage planner and riding-time model; annotated per-day GPX export; bridge suggestions for gaps. Prototype: plan a trip, compare plans. |
| **M5** | Go simulation | Live providers (forecast grid by block, MeteoAlarm, CAMS, FIRMS/EFFIS, river gauges, closures registry, OSM change monitor). Prototype: **"simulate being at km X on date/time Y"**, showing the briefing a rider would see. |
| **M6** | Reports & calibration | HTML/PDF audit report, run-to-run diff viewer, calibration against a published ECS certification report (e.g. EV15) and against your own field rides. |

### 11.1 EV8 first: what it stresses

EuroVelo lists EV8 at about 7,350 km from Cádiz to Athens, continuing to Cyprus. It is one of the least complete EuroVelo routes:
- France is developed and signed.
- Spain and the western Balkans have long on-road and in-development stretches.

Riding it in autumn exercises exactly the parts of the audit that other apps ignore, so milestone priorities shift slightly.

- **Seasonality moves forward from M3 into M2.** In autumn the season is winding down, so seasonal closures become a core finding rather than a nice-to-have:
  - Coastal campsites and resort accommodation closing from late September or October.
  - Reduced ferry timetables.
  - Shortening daylight.
- **Gaps and public-transport links are a core case, not an edge case.** Example: EuroVelo advises the suburban railway instead of the Athens–Corinth National Road, which has been closed to cyclists since June 2024. M1 must model official public-transport links and closures properly.
- **Autumn weather hazards** for the Dream climate layer and the Go alerts:
  - Late wildfire season (September).
  - Autumn flash floods (Spain's "DANA" storms, Mediterranean cyclones).
  - River and torrent crossings.
- **Data coverage varies by country.**
  - Check which countries MeteoAlarm covers. National fallbacks may be needed in the Balkans.
  - OSM tagging completeness (surface, maxspeed) is thinner in some sections. The audit must report its confidence honestly.
  - Some EV8 countries are outside the Schengen area (Bosnia-Herzegovina, Montenegro, Albania). The border-crossing and Schengen-days features apply.
- **Calibration** uses EV15 (ECS report) for "known good" sections. EV8 France is a second check, since it is developed and signed.

**Prototype extras for review and tuning:**

- **Provenance inspector:** click any km to see every event, its source, date and confidence.
- **Rules tuning panel:** edit thresholds, re-run stage 7 and compare.
- **Run history** and source-health page (which feeds failed, how stale each snapshot is).
- **Golden routes:** 3 calibration routes with snapshot tests, so tuning one route doesn't silently break another. Suggested: EV15 certified section, a rough EV1 Iberian section, and a route you have ridden yourself.

### 11.2 M2 design: services and access

**Service types and access limits (D17).** A place counts towards coverage, gap rules and ECS criteria only if both its ridden one-way distance and its time are within the limits below. Anything within 500 m is labelled "on route". Places up to the display distance are kept, so the prototype's max-detour filter can show them, but they don't count.

| Service | OSM / Overture examples | Counts if within | Time cap | Display up to |
|---|---|---|---|---|
| Drinking water | `amenity=drinking_water`, `water_point`, taps and fountains with `drinking_water=yes` | 500 m | 3 min | 1 km |
| Toilets | `amenity=toilets`; Overture `public_restroom` | 500 m | 3 min | 1 km |
| Repair station | `amenity=bicycle_repair_station`; tube vending machines | 500 m | 3 min | 1 km |
| Food and resupply | supermarket, convenience, bakery, café, restaurant, fast food, bar | 1 km | 6 min | 2 km |
| Pharmacy | `amenity=pharmacy` | 2 km | 12 min | 3 km |
| ATM | `amenity=atm`, banks with `atm=yes` | 2 km | 12 min | 3 km |
| Accommodation | hotel, guest house/B&B, hostel, campsite, alpine hut | **5 km** | **30 min** (ECS) | 8 km |
| Bike shop | `shop=bicycle`; Overture `bike_store`, `bike_repair_maintenance` | 5 km | 30 min | 10 km |
| Station (bikes carried) | `railway=station/halt`, `amenity=ferry_terminal` | 5 km; 10 km for bail-out | 30 min; 60 min for bail-out | 10 km |
| Hospital | `amenity=hospital`; Overture `hospital`, `emergency_department` | 20 km **by road** | not applied (any vehicle) | 20 km |

**Measuring access.**
- **Candidates.** Places come from the OSM corridor extract and from Overture (queried with DuckDB per 50 km block of the route, filtered by category). Each is projected onto the route (`at_m`, `offset_m`, `side`). A place is kept if its straight-line offset is within the display distance; the ridden distance is never shorter than that.
- **Ridden distance.** Valhalla `sources_to_targets` with the same bicycle costing as matching. The sources are route points every 250 m within reach of the place, and the shortest one wins, so a campsite across a river is reached by the bridge. That route point is the place's access point (`access_at_m`). Places within 75 m of the route skip routing. Hospitals use car routing.
- **Time.** 15 km/h on the flat, plus 1 minute per 10 m of net climb from the access point to the place, using the DEM minimum around each point so that roofs don't count. Valhalla's own times ignore hills, because our tiles carry no elevation.
- **Unreachable places.** If routing finds no path (an island, or no road within 500 m of the place), the place is shown but doesn't count, and is marked as such.

**Conflation (D16).**
- A match needs the same service type, and either a distance within 75 m (150 m for accommodation, whose areas are large) with a similar name (rapidfuzz `token_set_ratio` ≥ 70), or a distance within 25 m when either side has no name.
- OSM supplies the position, name and opening hours; Overture adds its id, confidence and sources.
- Overture-only places need confidence ≥ 0.6, and Overture's `permanently_closed` places are dropped. Holiday rentals are excluded, since they rarely take one-night stays (ECS).
- Place confidence: both sources agree, high; OSM only, medium; Overture only, medium if its confidence ≥ 0.9, otherwise low.

**Seasonality (D18).** Months are coded `o` (open), `p` (partly), `c` (closed) or `?` (unknown) for the reference year 2027:
- `opening_hours` is evaluated per month:
  - any open interval means open;
  - open days plus a closed stretch of 7 days or more means partly, e.g. October for "Apr 14 – Oct 15";
  - a fully closed month means closed.
- `seasonal=no` means open all year.
- `seasonal=summer` means open June–August, with the other months unknown.
- `seasonal=yes` without hours means every month is unknown.

Each service gap is computed for each month, counting places whose month code isn't `c`.

**Rules.**
- **ECS services criteria (D21),** per daily section, laid onto the 1 km minor sections:

  | Criterion | Tier | Passes when |
  |---|---|---|
  | `accommodation` | essential | at least one counted accommodation |
  | `food_water` | essential | at least one counted food place |
  | `bike_repair` | essential | a bike shop or a repair station |
  | `pt_access` | essential | a bike-carrying station at least every 150 km |
  | `accommodation_choice` | important | an accommodation that isn't a campsite |
  | `repair_shop` | important | a bike shop |
  | `toilets` | important | toilets at least every 15 km |
  | `pt_access_75` | important | a bike-carrying station at least every 75 km |

  Service frequency is not checked (D20).
- **Services gaps** (placeholders in `engine/profiles/services-v0.yaml`): water 40 km, food 50 km, accommodation 70 km, bike shop 150 km, ATM and pharmacy 100 km. A stretch longer than this without the service gives one finding. A **seasonal gap** finding lists the months in which known closures make the gap exceed the threshold although it doesn't all year.
- **Bail-out:** a stretch more than 50 km from a bike-carrying station in both directions (i.e. a station gap over 100 km, counting the 10 km bail-out access) gives a caution.

**Outputs (D19).**
- `places.json`: one record per place with `service`, `kind`, `name`, position, `at_m`, `offset_m`, `side`, `access_m`, `access_min`, `climb_m`, `access_at_m`, `counts`, the month code, the raw `opening_hours`, sources, confidence, and details such as the bike policy, stars, the cyclist-friendly label or the website.
- `services.json`: the service types with their limits; per daily section, the count of counted places and the longest gap per service for each month.

**API and prototype.**
- `GET /v1/routes/{network}/{ref}/places?service=&from_km=&to_km=&max_detour_m=&month=&counting=` serves filtered places.
- The prototype adds:
  - a **services panel**: service toggles, month, and a max-detour filter that defaults to the counting limits;
  - a **"what's ahead from km X"** list: click the map or the strip to set X; it shows the next place of each type with its distance along the route and its detour;
  - places on the map;
  - services stats per section.

### 11.3 Later: user routes and other networks (D22–D25)

This belongs to the "user GPX audits" and "other networks" phases. It is not a milestone, and M3–M6 are unchanged. It records how those phases slot into what M0–M2 built.

**Flow for a user's file:**

```
file (GPX / FIT / …)
  └─ format reader ──► tracks + waypoints + metadata
       └─ route source "user upload" ──► sections (its tracks or days, else ~60 km stages),
                                          status unknown, licence unknown, visibility: private
            └─ the same audit pipeline (matching, layers, terrain, services, rules)
                 ├─ shared catalogue (public places, cached per-way road values) ──► read only
                 └─ private outputs: route-relative placements, user places, findings ──► returned to the device
```

**What changes in the code when this phase starts:**
- Split the EuroVelo adapter into a GPX format reader and a EuroVelo route source. Add a FIT reader (course points become user places).
- The CLI and audit choose the route source by network, instead of assuming EuroVelo. EuroVelo-only findings are switched off for other sources.
- Places move from per-route fetching to the shared catalogue by H3 cell. A route's placements, detours and gaps stay per route.
- Bundle manifests gain `visibility`. The API lists only public bundles; private ones are stored apart.
- Optional, when audits stop being one route at a time: routing tiles per country or region instead of per corridor.

**Unchanged:** the measure axis, layers, rules profiles, services logic, bundle files and viewer. They already work on any measured route. The bike-carriage table needs rows for each new country.

---

## 12. Additional features worth considering

### Dream

- **Section matchmaker.** "7 days in late May, mostly paved, low traffic, warm but not hot, wine and villages, train access at both ends." The app scans every contiguous run of daily sections across all routes, cheaply using precomputed per-section summaries. The catalogue is small enough (~1,500 daily sections × 12 months) to download and search **on device**, so Dream queries never reach the server.
- **Best-time calendar.** A heatmap of route sections against months, built from a comfort index (temperature, rain, heat, daylight), crowding (holidays, tourism intensity) and service availability (seasonal closures).
- **Direction advisor.** Which way to ride a route in a given month, based on prevailing winds relative to heading and net climbing.
- **Reality-check card.** % certified/developed, longest unsigned stretch, km on busy roads, km unpaved, longest services gap and data confidence, on one screen. This is the "local buddy" truth.
- **Side-by-side route comparison.**

### Plan

- **Physics-based riding-time model.**
  - Inputs: rider + bike + luggage mass, a comfortable sustained power (or a "touring style" preset), tyre/surface rolling resistance, gradient, and climatological wind for the month.
  - Output: realistic hours per section, including stop time. Not km/day guesses.
- **Stage planner.**
  - Candidate overnight stops: clusters of the rider's preferred accommodation type.
  - Optimisation: minimise deviation from target daily effort, honouring rest days, must-have services and a bail-out station within N km.
  - Cost: trivial to compute (dynamic programming over a few hundred candidates), so it runs on device.
- **Annotated starter GPX per day.** Findings as GPX waypoints ("⚠ busy road 3.2 km", "last water for 38 km"), bridges as alternative tracks. Shows up on Garmin and survives RWGPS/Strava imports.
- **Book-ahead flags.** Sparse accommodation + peak season + holiday overlap → "book ahead".
- **Bike and kit advice.**
  - Tyre width from the surface mix.
  - Gearing from sustained gradients.
  - Lights from tunnels and daylight.
  - Packing list from climate and remoteness.
- **Getting there and back.** Rail with bikes to the start and from the finish (Transitous/MOTIS), night trains with bike spaces, bike-box storage.
- **Country practicalities.** Emergency numbers, helmet and hi-vis rules, wild-camping legality (e.g. allemansrätten in the Nordics vs. bans elsewhere), border crossings, entry rules for non-EU riders, and a Schengen-days counter for long trips (on device).
- **Encrypted share link** for riding partners.

### Go

- **Morning briefing for today's stage.** Weather *at your expected position and time*, wind's effect on riding time, warnings, smoke/air quality, heat ("leave by 07:30 to beat the 34 °C afternoon"), and river levels on flood-prone paths.
- **"Will it be open when I get there?"** Uses your ETA plus opening hours for the next food, water, bike shop and accommodation.
- **Bail-out button.** Nearest station with a bike-friendly connection, hospital/pharmacy, 112.
- **Closure detours.** Precomputed or on-request bypass. The request carries the closure segment, not your location.
- **Fully offline** (bundle + vector tiles), with live layers when there's signal.
- **Anonymous rider reports** that feed the next audit.

### B2B (route curators, NECCs, tourism boards, route publishers)

- **Regular audits against the network's own standards** (customer priority 2, D26). Each network gets its own rules profile; ECS is the first. Re-audits run on a schedule, with change tracking (below).
- **White-label route library and planner** (customer priority 3, D29). A simple widget or hosted page, branded for the partner and embedded on its site, covering Dream and Plan. It uses only partner routes we have rights to (D27), and visitors need no account (D30).
- **ECS-aligned pre-assessment reports** with maps and evidence. Indicative only; position as complementary to official certification, ideally in partnership with ECF.
- **Change tracking** between audits ("+38 km developed, 2 gaps closed").
- **Impact-ranked interventions.** "Fixing these 3.1 km would create 140 km of continuous LTS ≤ 2 route", an output curators struggle to get today.
- **Service-coverage reports for tourism boards.** "No cyclist-friendly accommodation between km 220 and 290", a business-development opportunity for the region.
- **Bring-your-own-data layers** (counter data, surveys), exports (GeoJSON, GeoPackage, KML, PDF).
- **Data-quality feedback to OSM and ECF.** Goodwill, and better data for everyone, including us.

### LLM assistance (bounded, grounded)

- Narrative "local buddy" summaries generated from findings. Every sentence must cite events; no free-form facts.
- Extracting closures and diversions from multilingual web pages into structured candidates, with a human approval queue.
- Translating warnings and findings into the rider's language.
- Natural-language Dream queries turned into structured matchmaker filters.
- Model: not chosen yet (D7); possibly an open-source / open-weight model. It sits behind a provider-neutral interface, gets evaluated on a sample of EV8 pages and sections before any choice, and is kept out of the core factual pipeline.

### Operations

- Source-health and freshness dashboard.
- Field-validation mode for your own rides (confirm signage and surface, attach photos, optionally contribute to Mapillary or Panoramax).
- Audit regression tests on golden routes.

---

## 13. Risks and open questions

| Risk / question | Mitigation / next step |
|---|---|
| Real structure of the EuroVelo GPX package and status attributes is not yet known in detail | M0 first task: download and inspect; the adapter isolates the rest of the system from it |
| ECS criteria details (thresholds) live in the 2026 manual | Encode as tunable rules; consider contacting ECF early. They are a likely partner and B2B customer, and they control the EuroVelo® trademark. |
| Traffic volume is mostly a proxy (LTS from tags) | Show confidence; add national open counts per country; commercial data for B2B only |
| Signage is the weakest open-data dimension | Combine status, OSM, imagery and field reports with explicit confidence; never assert "signed" without evidence |
| Closures have no unified source | Layered approach in 5.6; curated registry first |
| DEM is a surface model (trees, bridges) | National terrain models where open; bridge/tunnel interpolation; smoothing; validate on known climbs |
| Licence terms: Open-Meteo (non-commercial), MeteoAlarm redistribution, Mapillary derived data, ODbL share-alike | Licence register in `docs/`; provider interfaces allow swaps; legal review before launch |
| Valhalla on Cloudflare Containers (production only) | Laptop: resolved, since official arm64 images exist. Production: evaluate Containers' disk limits; small VM as a fallback (10.2). |
| Laptop capacity (RAM/disk) | Corridor clipping; start with 2–3 routes |

**Questions for you:**

1. ~~Laptop RAM and free disk?~~ Answered: 32 GB / 1 TB (D1).
2. ~~Two-language split?~~ Confirmed (D2).
3. ~~First golden routes?~~ EV8, plus EV15 for calibration (D3).
4. ~~Approach ECF early?~~ Later, after the prototype (D5).
5. Any budget for paid APIs during the prototype? None should be needed; free non-commercial tiers cover personal testing.

---

## 14. References

- EuroVelo GPX tracks: licence and disclaimer (Dec 2025): <https://pro.eurovelo.com/download/document/EuroVelo%20GPX%20tracks_License%20and%20disclaimer_20251211.pdf>
- EuroVelo GPX tracks go open data (Oct 2024): <https://pro.eurovelo.com/news/2024-10-09_eurovelo-gpx-tracks-go-open-data>
- ECS short manual 2026: <https://eurovelo.com/download/document/ECS-short-manual-2026-final.pdf>
- ECS quality criteria 2021: <https://eurovelo.com/download/document/ECS-quality-criteria-2021.pdf>
- EV15 Rhine certification report 2025: <https://eurovelo.com/download/document/EuroVelo-15-Rhine-Cycle-Route-Certification-Report-2025.pdf>
- New look for EuroVelo maps (7-category legend, May 2026): <https://en.eurovelo.com/news/2026-05-27_new-look-for-eurovelo-maps>
- EuroVelo Data Hub: <https://pro.eurovelo.com/projects/eurovelo-data-hub>
- Cloudflare Containers GA (Apr 2026): <https://developers.cloudflare.com/changelog/2026-04-13-containers-sandbox-ga>
- Cloudflare Containers pricing: <https://developers.cloudflare.com/containers/pricing/>
- Cloudflare Containers limits: <https://developers.cloudflare.com/containers/platform-details/limits/>
- Cloudflare R2 pricing: <https://developers.cloudflare.com/r2/pricing/>
- EuroVelo 8 route page: <https://en.eurovelo.com/ev8>
