# Kilometrica — System Design (V1 proposal)

Formerly DreamPlanGo; renamed on 2026-10-17 (D42). Dream, Plan and Go remain the product's phases, and "dpg" remains the internal name of the audit process.

**Status:** Living design, 2026-10-17. Decisions D1–D50 are recorded below. Milestones M0–M3.5 are built (section 11), and M4's design is agreed (11.6).
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

| Priority | Who | What Kilometrica gives them | Where it lives in this design |
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
| D4 | 2026-10-14 | **Routing stays in the batch path.** There is no always-on routing service in production. Detours and access distances are computed during audits and closure ingestion. See 10.1 for the cost reason. (Bridge suggestions were dropped: D47.) |
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
| D27 | 2026-10-15 | **Third-party route libraries are never harvested without a partnership.** That rules out bulk import from Komoot, Ride with GPS, Bikepacking.com and others; a partnership with Komoot is unlikely given the overlap. Partnerships are more likely with Bikepacking.com, Epic Road Rides, or local tour companies and associations. Partner routes are audited and shown under that partnership's terms. Without one, a library route reaches Kilometrica only as a rider's own private upload (D25). |
| D28 | 2026-10-15 | **The next network after EuroVelo is not chosen yet.** The likely factors are how complete the network is and how many active users it has. Adding it means a route-source adapter and a rules profile for its standards (D22, 8.5). |
| D29 | 2026-10-15 | **White-label means a widget or hosted page that a partner embeds on its own site.** Most partners are small, so it has to be simple to adopt. It covers the Dream and Plan phases only, for now. It reads the partner's public route data from our API, and planning runs in the visitor's browser; nothing about the visitor is stored. The partner sees route-level counts at most, never who viewed what or where they are. Partner staff may have business logins to manage their routes and branding (9.4). A later tie-in, to be discussed: plan on the partner's site, then buy the on-the-road companion as a Trip Pass in the Kilometrica app. |
| D30 | 2026-10-15 | **No accounts and privacy-first for as long as possible,** for riders in the app and for visitors to partner sites. If a feature appears to need rider accounts, work stops so it can be discussed with the owner before any design. The mechanisms in section 9 come first. |
| D31 | 2026-10-16 | **Hosting stays host-neutral and starts on free tiers** (supersedes the all-Cloudflare plan in section 10; options compared in 10.3).<ul><li>**Serving:** Cloudflare's free tier, i.e. static hosting for the viewer and the white-label widget, a Workers API, and R2 storage (10 GB free, no egress fees).</li><li>**Audits:** on the laptop, or in GitHub Actions (free arm64 runners for this public repository) if the runner disk proves big enough. Bundles are uploaded to R2.</li><li>**Places in production:** served as static files, one per 50 km route block, instead of one large file read by the API, because serverless functions have tight memory and CPU limits per request. This matches how live data is already requested (by block).</li><li>**Later, scheduled cloud audits:** the Cloudflare Workers Paid plan ($5/month) with Containers, or Azure Container Apps jobs within their free monthly allowance. The owner has no Microsoft subscription benefits, so Azure credits don't apply.</li><li>**Later, on-demand routing for user routes:** a small always-on Arm VM at an EU host (e.g. Hetzner, about €8–16/month in 2026), paid for by personal Trip Passes (D32). Always-on Containers are avoided (D4).</li></ul>V1 hosting cost: about $0/month. |
| D32 | 2026-10-16 | **Trip Passes come in tiers.** A *network route pass* (e.g. a EuroVelo route such as EV8) unlocks the precomputed audit and the on-the-road features for that route, at about $20–25. That is the owner's starting point and is to be tested with riders. A *personal route pass* audits one route the rider uploads (D22–D25), including the on-demand routing it needs, for a small price per route, about $2–5. Per-transaction payment fees weigh heavily at that price, so the price, or packs of several personal routes, are set with those fees in mind. |
| D33 | 2026-10-16 | **Payments go through the store or a merchant of record; Kilometrica never handles payment details or buyer identity.**<ul><li>**In the app:** StoreKit in-app purchases (Apple's small-business rate is 15%), and later Google Play Billing on Android.</li><li>**On the web:** a merchant of record's hosted checkout (Paddle or Lemon Squeezy; choose at build time). It is the legal seller, collects payment, handles VAT, GST and sales tax worldwide, and sends the receipt.</li><li>**Delivery without accounts:** the checkout's webhook makes our server issue a random **Trip Pass code**, shown on the success page and included in the merchant's receipt email. We never see the email address, and a lost code is recovered from that receipt. The server stores only a hash of the code and what it unlocks; refund webhooks switch it off, as App Store Server Notifications do for in-app purchases.</li><li>**Codes work everywhere:** codes from either channel unlock the pass on the web and in the app. The app also sells every pass as an in-app purchase, which Apple's multiplatform rule requires before content bought elsewhere may be unlocked in the app. Linking out from the app to web checkout is optional and per storefront: allowed without commission in the US since May 2025, and with fees in the EU.</li><li>**Fees:** about 5% + $0.50 per web sale, i.e. about 22% of a $3 pass. Personal passes are therefore sold as packs or credits, or nearer $4–5 (D32). Paddle may price items under $10 individually; check before choosing.</li><li>**Before building:** re-check Apple's current App Review Guidelines (3.1.1, 3.1.3) and the merchant's terms, since both have been changing.</li></ul> |
| D34 | 2026-10-16 (revised the same day) | **M3 climate uses ERA5 directly from Copernicus from the start, beginning small.** The climate download is then built once, with commercial rights from day one, instead of starting on Open-Meteo's free (non-commercial) API and migrating before payments.<ul><li>**Defaults:** 10 years (2016–2025); one climate point every ~100 km of route, with each daily section using its nearest point; daily summaries only (temperature max/min, precipitation, wind speed and prevailing direction).</li><li>**Access:** the CDS API (`cdsapi`), with the owner's free Copernicus account, the ERA5 dataset licences accepted, and the key in `~/.cdsapirc` in Ubuntu. Requests queue on Copernicus's side and run unattended, resumable and cached.</li><li>**Point time series first:** the "ERA5 hourly time-series data on single levels" dataset (March 2025) is built for long single-point series. ECMWF labels it experimental, and API errors have been reported.</li><li>**Fallback:** gridded ERA5 or ERA5-Land downloads over the route's area, with our points extracted locally (a few GB, more processing). Not needed in M3: the time series served all of EV8's points.</li><li>**Settings, not code:** the years, point spacing and source are configured behind an adapter. Moving to 30-year normals, or adding Open-Meteo or another source, is a configuration change.</li><li>**Scope:** the comfort score and best-time heatmap are only one input to deciding when to go, so they stay simple.</li></ul>Attribution: Copernicus Climate Change Service (C3S), ERA5. |
| D35 | 2026-10-16 | **The Dream phase (agreed with the owner).** Dream answers *which stretch suits me, when, and which way*, before a rider commits. It ends with a choice (route stretch, time window, direction) that Plan turns into days.<ul><li>**Start:** EV8's daily sections. Evaluating a rider's own route (D22–D25) is the likely next step.</li><li>**What a result is:** consecutive daily sections on one route. A search across all routes that match the rider's wishes is a future feature.</li><li>**Rider inputs:** a self-chosen fitness level (D36), surface preferences, scenery themes, month and number of days, and a few practical needs. No fitness data.</li><li>**Free, as a teaser for the Trip Pass:** Dream shows summaries, scores and counts. The detail behind them (places, the findings list, the Ahead list, GPX, Plan and Go) is unlocked by the pass (D32).</li><li>**Scenery themes are included.** Photos and descriptions are out of scope for now; they could come later, from partners or licensed sources (D27).</li><li>Search runs on the rider's device in the app (D30).</li></ul> |
| D36 | 2026-10-16 | **Rider fitness uses five self-chosen levels, and route stretches are graded on the same scale.** The levels use the language of cycling-holiday grades (Exodus, Skedaddle, KE Adventure, Headwater, Much Better Adventures). Each is defined by what the rider is comfortable riding **per day with luggage**:<ul><li>1 Leisurely: 20–40 km, up to ~300 m of climbing</li><li>2 Easy–moderate: 40–60 km, up to ~500 m</li><li>3 Moderate: 50–80 km, up to ~850 m</li><li>4 Challenging: 70–100 km, up to ~1,200 m</li><li>5 Tough: 90–130 km, 1,500 m and more</li></ul>The bands are a blend of those operators' published figures, not any one company's, and are starting points to tune. **Surfaces:** the rider marks each of *road*, *cycle paths* and *gravel* as prefer, OK or avoid. Every kilometre falls into exactly one of the three, from the infrastructure and surface layers (11.4). |
| D37 | 2026-10-16 | **Missing data is shown as unknown and becomes the rider's call** (principle 1, applied to Dream and onwards). Where we have no data (school holidays or tourism figures for some countries, opening seasons, anything else), we say so. The gap becomes a "check yourself" item for the rider to judge or follow up.<ul><li>**No gap-filling:** no curated guesses, no estimates extrapolated from other places, no assumed typical values.</li><li>**Scores:** a score whose input is missing leaves that part out and shows that it is missing; it never assumes a neutral value.</li><li>**Facts are reported for the known part only,** e.g. "4 of 37 campsites here publish a season; 3 are open in October".</li><li>**Sourced facts are fine:** curated tables that cite a source (e.g. bike carriage, D20) are allowed. Invented or "typical" values are not.</li></ul> |
| D38 | 2026-10-16 | **A conversational assistant for each phase is a future capability: grounded, tool-based and on the device first** (extends D7 and the LLM list in 12). No milestone changes.<ul><li>**Grounding:** the model never answers from its own general knowledge. It may only call tools over our data (section summary, climate by month, places ahead, findings in a range, a matchmaker run; later the rider's plan and live data by block). It phrases the result with km, source and date. Missing data gets D37 wording and a "check yourself" item.</li><li>**Honesty checks:** a test set of real questions per phase, with the expected tool calls, and an automatic check that every number in an answer comes from a tool result; otherwise the assistant declines.</li><li>**By phase:** Dream first (plain-language questions turned into matchmaker filters, "why this stretch?", comparisons), then Plan, then Go.</li><li>**Go offline:** on the phone, over the offline pack. Short answers; it shows how old the data is; it is never the only path to safety information (the bail-out button, alerts and the Ahead list stay as plain screens).</li><li>**Where it runs:** on the device, either Apple's built-in on-device model (Foundation Models, iOS 26+, Apple Intelligence devices, small context) or a bundled open-weight model (about 1–4B parameters, an optional 0.7–2.5 GB download), behind D7's abstraction. The choice is made by testing both on the question set. Apache or MIT licences are preferred. On the web, only as an optional local download. **Server-side inference would send riders' questions off the device, so it needs the owner's agreement first (D30).**</li><li>**Languages:** tested in at least English, French, German, Spanish and Italian. Route and closure answers say "check locally"; no medical advice.</li><li>**First step, after M3:** a Dream prototype in the web viewer, using a local model on the laptop (Ollama or llama.cpp in Ubuntu) plus the question test set.</li></ul> |
| D39 | 2026-10-16 | **User GPX audits come before M4, as milestone M3.5** (extends D22–D25). The owner supplies a GPX file through a laptop command (`npm run audit:file`), and the full audit built so far (M1–M3) runs on it as a private audit (D25). A private audit stays until it is explicitly deleted (`npm run forget`). Upload from the viewer, the on-demand server and personal Trip Passes come later (D31, D32). Design in 11.5. |
| D40 | 2026-10-16 | **How a user's route is audited, for now** (the owner's choices).<ul><li>**Sections:** the file's own tracks if it has several, otherwise equal stages of about 60 km. This may change later.</li><li>**Rules:** the ECS-style check runs as on EuroVelo routes, with signage unknown. A Kilometrica profile of our own may follow.</li><li>**Waypoints:** shown as private user places (D24), and never counted in services, gaps or findings.</li><li>**Overlap:** when the route shares roads with an audited public route, the shared length is reported.</li></ul> |
| D41 | 2026-10-17 | **Kilometrica never navigates; it hands the rider off** (principle 8). In Go, every place ahead gets links that open another app or site ready to use; the full list of handoffs, to be evaluated when designing M5, is in 12 (Go). The owner's choices:<ul><li>**iPhone first.** Android follows later.</li><li>**All the handoffs listed in 12**, including Ride with GPS.</li><li>**Travel mode:** cycling by default; walking as an option, useful on walking networks such as the Caminos.</li><li>**"There and back to the route":** included.</li><li>**Call and website links** for now; monetised affiliate links may come later.</li><li>**Emergency handoffs** (112, sharing one's position) later: a lot to think through.</li></ul> |
| D42 | 2026-10-17 | **The product is named Kilometrica** (formerly DreamPlanGo). The DreamPlanGo domains are taken: the .com has been held since 2012 by the owner of a former travel site of that name.<ul><li>**Domains:** the owner secured kilometrica.com on 2026-10-17. kilometrica.app, unregistered that day, is still to register.</li><li>**Trademark, preliminary searches only** (2026-10-17): no Kilometrica marks in TMview (EU office, EU national offices, UK, Switzerland), the USPTO or CIPO (Canada).</li><li>**Caveats:** Paper Mate's Kilométrica and Kilométrico pens are well-known marks in Latin America (stationery, class 16). "Kilométrica" is also an ordinary Spanish word, which the EU office may find descriptive, so a trademark attorney's clearance comes before filing (classes 9, 39 and 42), possibly as a figurative mark.</li><li>**Unchanged:** Dream, Plan and Go remain the product's phases. Internally, "dpg" stays the name of the process: the engine package, the CLI, the data folder and settings.</li><li>**Folder:** the project folder is renamed to kilometrica, in place.</li></ul> |
| D43 | 2026-10-17 | **The audit screens are for us and for route network organisations; riders never see them.** The audit viewer (layers, findings, the strip, scores, provenance) is for testing and validating audits, and later for network owners and associations (customer priority 2, D26). Riders meet the audit only through Dream, Plan and Go, as plain-language items that say where each fact comes from, how recent it is and how sure we are. |
| D44 | 2026-10-17 (revised the same day; refined by D49) | **Plan works on the web and on the phone.** Many riders will plan on a website, on a bigger screen, and take the plan to their phone for Go. Plan therefore has a wide layout for the web (also used in partner widgets, D29) and a phone layout for the app. A plan made on the web moves to the phone without an account (11.6). Over the offline pack, the app needs no network. |
| D45 | 2026-10-17 | **Plan has a free teaser, to encourage buying the Trip Pass** (refines D35). The pass unlocks the full plan and the Go features. What the teaser shows is proposed in 11.6. |
| D46 | 2026-10-17 | **M4 plans for cyclists only; other ways of travelling come later.** The planner's pace model, levels, thresholds and handoff travel mode sit behind interfaces that don't assume a bike, so walking and other modes can be added without reworking Plan. Each mode will also need its own parts of the audit: networks, map matching, levels, and service and access limits. |
| D47 | 2026-10-17 | **Kilometrica doesn't build the rider's route, and never assumes how a gap is crossed** (from the owner's original brief).<ul><li>**No routing around gaps or bad stretches:** no alternative lines, no suggested train hops. This supersedes the bridge suggestions in D4 and 4.4. Routing stays for detours to places (D17) and map matching.</li><li>**The daily GPX is a starter file,** with the gaps and issues marked, for the rider to finish in their own route tool (Ride with GPS, Strava, Komoot…).</li><li>**A gap is a ferry crossing or a public-transport link only when the evidence says so:** an OSM ferry route with terminals at both ends, or the network's own published advice, recorded with its source. Otherwise it is a gap the route hasn't filled yet, and how to cross it is the rider's call.</li></ul> |
| D48 | 2026-10-17 | **Plan, as agreed with the owner** (answers to the M4 draft's questions, 11.6).<ul><li>**Where it starts:** from a Dream result, or from any range the rider picks on a route, public or private.</li><li>**Days and dates:** Dream suggests the number of days and the time frame. In Plan the rider can change the days, and confirms the dates.</li><li>**Pace:** from the rider's self-chosen level (D36) and their bike, with no fitness data (D35). An e-bike is a cycling preset with assistance up to 25 km/h; battery range and charging come later.</li><li>**Wild camping is never suggested;** it is too risky. Sleeping outside our stops is the rider's own call.</li><li>**No kit advice.** Plan shows where water, food and other services are; riders judge what they need to carry.</li><li>**Attention limits** start at the brief's five key lines, and 3 heads-ups and 3 highlights per day, and are tuned on the prototypes.</li><li>**Highlights** may link out to Wikipedia or Wikimedia Commons, as a handoff; we host no images.</li><li>**Beds** link to the place's own website (and phone) where we have them. Affiliate links come later (D41).</li><li>**Sharing:** read-only links at two levels, the full plan or the itinerary only; riding partners import their own copy. Someone without a Trip Pass sees the plan as shared, but needs their own pass to change it.</li><li>**Exports in M4:** GPX, a calendar file, `plan.json` and the trip book. FIT courses and Ride with GPS upload come with M5's handoffs.</li><li>**Prototype:** Plan is a separate rider view, not a tab of the audit viewer (D43). Dream's matchmaker moves there once Plan works.</li><li>**The planner in the iOS app:** decided later, probably the same TypeScript.</li></ul> |
| D49 | 2026-10-17 | **Dream and Plan start on the web; Go is always on a mobile device** (refines D44).<ul><li>**Web first:** Dream and Plan are likely better done on a bigger screen, so they are built for the website first (kilometrica.com, and partner widgets, D29).</li><li>**To the phone for Go:** a plan moves by its link, shown as a QR code or sent by the rider to themselves, and opens in the app (in the phone's browser until the app exists). A plan on a private route moves as a file for now.</li><li>**The phone's copy is the one that rides.** Changes made on the road stay on the phone; with no accounts there is no sync. The rider can send the plan back the same way.</li></ul> |
| D50 | 2026-10-17 | **Gaps in Plan, and the teaser** (the owner's answers to 11.6's last questions).<ul><li>**A gap is a public-transport link only when the network says so.** The engine's rule that called a gap a "probable public-transport link" because rail stations lie near both ends is dropped; such gaps (e.g. EV8's Ventimiglia → Limone) become unfilled gaps.</li><li>**An unfilled gap on a network route is highlighted and counted as ridden,** however the rider chooses to bridge it: at least its straight-line distance, with the terrain unknown (D37). Kilometrica is not a navigation app, so Plan doesn't ask how the rider will cross it. Gaps are unlikely in a rider's own GPX; if one occurs, the same rule applies.</li><li>**The teaser shows what 11.6 lists,** for now; it is reviewed once built.</li></ul> |

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
| 8 | **Hand off what isn't ours** | When something is outside Kilometrica's core purpose, such as turn-by-turn navigation, booking, timetables or a phone call, the rider is handed to the app, website or number that does it, with the details already filled in (D41). Riders should be enjoying the adventure, not tinkering with apps and sites. |

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

- **Findings** are the "local buddy" content, e.g. "km 312–318: 6.2 km on a 80 km/h road without shoulder, LTS 4, no EuroVelo signs observed."
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

**Kilometrica doesn't route around gaps (D47).** The first design suggested routed alternatives, train or bus hops, and ferries as "bridges". Instead, each gap is described with the evidence for its type and what lies at its ends (stations, a ferry terminal, a town). The rider's starter GPX marks it, so the rider can fill it in their own route tool. Plan's handling of gaps is in 11.6.

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
| **Valhalla** (self-hosted) | Map matching, detours to places, access distances | Docker, tiles built from corridor-clipped OSM | MIT, free |
| **BRouter** (optional) | Cycling-specialist routing; not needed while we don't route alternatives (D47) | Self-host (Java) | MIT, free |
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
| **ERA5 / ERA5-Land** (Copernicus Climate Data Store) | The climate source from M3 (D34): monthly normals per daily section (temperatures, rain days, heat days, wind relative to heading). Starts with 10 years, one point per ~100 km, daily summaries; 30-year normals later by configuration | CDS API (free account): point time series first, gridded downloads over the route area as fallback | Free incl. commercial, attribution |
| **Open-Meteo Historical API** | Not used for M3 (D34). Remains an option behind the same adapter | Simple REST, no account; requests over 2 weeks count as several calls | Free for non-commercial use only (CC BY 4.0); paid plan for commercial use |
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
| **Climate history** | ERA5 from Copernicus CDS from the start, kept small at first and widened by configuration (D34). Commercial use is included, so nothing changes at launch | $0 (free Copernicus account, created by the owner) |
| **Free accounts or keys to register** | Copernicus CDS and ADS, NASA FIRMS, Mapillary | $0 |
| **Cloudflare Workers Paid** | Not needed for V1: serving runs on the free tier and audits run on the laptop or in GitHub Actions (D31). Needed only once scheduled audits move into Containers. Tunnel + Access are free for sharing from the laptop. | $0 now; $5/month later |
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
kilometrica/
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
GET  /v1/audits/{audit}/gpx?from_km=&to_km=&annotate=true
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
| Buy a Trip Pass on the web (D33) | **Merchant of record** hosted checkout (Paddle or Lemon Squeezy) → a **Trip Pass code**, shown on the success page and in the merchant's receipt; redeemable on the web and in the app | Only a hash of the code and what it unlocks (the merchant is controller for payment and email) |
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

## 10. Migration path: laptop → hosted

Hosting is host-neutral and starts on free tiers (D31). The API is Hono, which runs unchanged on Node, Workers and most serverless hosts. The engine is a Docker image, and bundles are plain files.

| Concern | V1 (laptop) | Hosted (D31) |
|---|---|---|
| Audit engine | `npm run audit:…` in WSL2 (Docker for Valhalla) | Laptop, or **GitHub Actions** (free arm64 runners, public repo), uploading bundles to R2. Later, scheduled in the cloud: **Cloudflare Containers** (Workers Paid, $5/month) or **Azure Container Apps jobs** (free monthly allowance) |
| Bundles and raw data | `~/dpg-data` | **R2** (10 GB free, no egress fees, good for offline-pack downloads) |
| Places and other large per-route data | `places.json`, read once by the API | **Static files per 50 km route block** in R2, served from the CDN. D1/SQLite only if a query really needs it |
| API | Hono on Node | Hono on **Workers** (same code, different entry file); free tier |
| Live-data cache | In-memory/disk LRU | **Cache API** + **KV** |
| Scheduled refresh (warnings polling, OSM change monitor) | cron in WSL | **Cron Triggers** → Workers, or a scheduled GitHub Actions workflow |
| Prototype web app and white-label widget | Vite dev server | Static assets on Workers or Pages, free |
| Valhalla (routing/matching) | Docker | Batch: wherever the audit runs. On-demand user routes (later): a **small always-on Arm VM at an EU host** (e.g. Hetzner), paid for by personal Trip Passes (D32) |
| Secrets | `.env` | Workers secrets / GitHub Actions secrets |

### 10.1 Estimated Cloudflare cost

With D31, V1 runs on free tiers, so about $0/month. The figures below apply once scheduled audits move into Cloudflare Containers. M2 timings on the laptop show audits are lighter than first estimated. An EV8 re-audit with cached matching and places takes about 2.5 minutes, and the first run with services about 12 minutes (matching already cached). A fresh monthly run is estimated at 15–25 minutes (not measured), and up to about an hour on a 4-vCPU instance.

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

### 10.3 Hosting options compared (checked 2026-10-16)

Prices and free tiers change often; re-check before committing.

| Option | What it offers | Use in Kilometrica | Cost |
|---|---|---|---|
| **Cloudflare free plan** | Workers, static assets, R2 10 GB free with no egress fees | Serving: viewer, widget, API, bundles (D31) | $0 |
| **Cloudflare Workers Paid + Containers** | Batch containers with included monthly usage | Scheduled cloud audits, later | $5/month plus usage (10.1) |
| **GitHub Actions** | Free arm64 runners with 4 vCPUs for public repositories, 6-hour job limit | Monthly audits, if the runner disk fits OSM downloads plus Valhalla tiles (to verify). Logs are public, which is fine: no personal data | $0 |
| **Azure Container Apps** | 180,000 vCPU-s and 360,000 GiB-s free each month | Alternative for scheduled audits: a monthly EV8 audit fits | $0 within the allowance |
| **Azure free account / Visual Studio credits** | ~$200 credit for 30 days plus 12 months of selected free services; monthly credits for Visual Studio subscribers | The owner has no qualifying subscription, so the credits don't apply | — |
| **Oracle Cloud Always Free** | Free Arm VMs, reportedly cut to 2 OCPU / 12 GB in June 2026; idle instances can be reclaimed | Hobby use only; not dependable for production | $0 |
| **Hetzner Cloud** (EU) | Arm VMs, e.g. 4 vCPU / 8 GB at about €8/month after two 2026 price rises; low-cost lines have been reported out of stock | On-demand routing for user routes, later (D31) | ~€8–16/month |

---

## 11. What V1 will build

Milestones are ordered so you can see something in the browser early and tune as you go.

| # | Milestone | Deliverables |
|---|---|---|
| **M0** ✅ 2026-10-14 | Foundations | Repo, task scripts, schemas, data-licence register. EuroVelo GPX inspected and ingested (see `docs/notes/eurovelo-gpx.md`). LRS core (measure, locate, project, slice, resample, sections) with property tests. Bundle v0 for EV8, a Hono API, and a React/MapLibre viewer with section list, findings and elevation profile. Natively on Windows; WSL2/Docker moved to M1 (D9). |
| **M1** ✅ 2026-10-14 | Infrastructure audit | Corridor extraction; Valhalla matching; layers: infrastructure type, surface, traffic stress (LTS), elevation and gradient, waymarked network (OSM relations), continuity and typed gaps. ECS-style rules v0, scores, findings. Bundle files per D11. Prototype: map coloured by layer, **strip diagram** under the elevation profile, stats card, findings linked to the map. **Known limits, carried forward:** <ul><li>The DEM is sampled along the published track, not the matched road, so some coastal values may be cliff artefacts.</li><li>No national LiDAR terrain models yet.</li><li>Signage evidence is EuroVelo status plus OSM relations only (no guideposts or imagery).</li><li>LTS is heuristic, with no traffic counts.</li><li>Straight-line placeholders are not routed around. Where they make up more than a quarter of a daily section (EV8 sections 45 and 53, 41 km), the terrain under them is left out of the climbing figures. Only the net change across them counts, so the figures are minimums, shown as "≥" with the unknown km (D37, fixed 2026-10-16).</li><li>Seasonality moved to M2.</li></ul> |
| **M2** ✅ 2026-10-14 | Services & access | Places conflation (OSM + Overture, which includes Foursquare: D16), seasonal opening, detour distances, stations + curated bike policy, services-gap and bail-out rules. Prototype: "what's ahead from km X" panel and services filters. See 11.2 and the M2 results in `docs/notes/eurovelo-gpx.md`. **Known limits, carried forward:** <ul><li>Opening seasons are published for only ~2% of accommodation (OSM; Overture has none), so seasonal gaps are mostly unknown. Candidate fixes: campsite directories, DATAtourisme for France, field reports.</li><li>No timetables yet (GTFS), so ECS service frequency is not checked; buses and taxis are not counted for bail-out.</li><li>Bike policy for Greece and Albania is unknown, and Türkiye's is low-confidence.</li><li>Ferry terminals count as bike-carrying by default (low confidence).</li><li>Climb to a place is net elevation difference, not the climb along the detour.</li><li>No cyclist-friendly labels (Accueil Vélo etc.) yet.</li></ul> |
| **M3** ✅ 2026-10-16 | Dream data | Per daily section × month: ERA5 climate normals, daylight, wind along the route and direction advice, school and public holidays, tourism intensity, campsite seasons. Per section: eight scenery themes, remoteness, D36 grades and surface shares. Comfort and best-time scores; `dream.json`; the `@dpg/dream` matchmaker. Prototype: a Dream tab with the **best-time heatmap**, the **matchmaker** and a reality-check card, with the stretch highlighted on the map. Concept D35, rider levels D36, design in 11.4, results in `docs/notes/eurovelo-gpx.md`. **Known limits, carried forward:** <ul><li>The ERA5 grid fallback wasn't built: the point time series served all 73 EV8 points (about 20 minutes through the CDS queue on the first run, cached afterwards).</li><li>OpenHolidays leaves out summer school breaks, so June–September show no school-holiday data anywhere. 2027 school calendars are published only for France; the others use 2026, and the card says which year. Montenegro, Greece, Türkiye and Cyprus have no holiday data at all.</li><li>Crowding is national. Eurostat tourism intensity (2022–2025) covers all ten EV8 countries.</li><li>Campsite seasons are known for only about 4% of campsites; the rest is a "check yourself" item.</li><li>"Train at both ends" counts railway stations only. Ferry terminals don't count, unlike M2's bail-out rule.</li><li>Remoteness is the longest stretch, and the share of km, more than 5 km from a village or larger (11.4 first said 10 km for the longest stretch).</li><li>Where more than a quarter of a section is a straight-line placeholder (EV8 sections 45 and 53), terrain under the placeholder is unknown. The rest of the section is still measured: its climbing and grade are shown as minimums ("at least"), with the unknown km, and stretches sum them the same way. A minimum already over the rider's level still rules a stretch out. Section 53 is placeholder throughout, so its climbing is unknown and its grade uses distance alone. The mountains theme is "no data" for both. Shorter placeholders are flagged as approximate. M1's climbing figures follow the same rule, and Dream reuses them rather than measuring again.</li><li>Not built: ferry-crossing seasons, and the optional comfort strip row under the profile.</li><li>All weights and thresholds are untuned placeholders (D13).</li></ul> |
| **M3.5** ✅ 2026-10-17 | User GPX audits | The full audit (M1–M3) on a route file the owner supplies, run from the laptop as a private audit (`npm run audit:file`): a general GPX reader and a "user" route source, stages of about 60 km, user places from waypoints (never counted), the overlap with public routes, private bundles kept until deleted (`npm run forget`), and a route switcher in the viewer. Bundle schema 0.5 (`ways.json`, `user_places.json`, manifest `visibility` and `overlap`). Decisions D39–D40, design in 11.5. Accepted on the owner's planned France–Spain route over the Pyrenees, whose results stay private (D25). **Known limits, carried forward:** <ul><li>Everything listed in 11.5, plus the following.</li><li>Stage ends with no town or village within 5 km are named by their km.</li><li>Overlap counts shared OSM ways, and less than 1 km is not reported: crossings and shared junctions are not a shared route.</li><li>Reusing a public route's routing tiles when they already cover the corridor is built, but not yet exercised: the acceptance route lies outside EV8's corridor.</li><li>Country extracts downloaded on different days are merged keeping each object's newest version (needed for the first route touching a newly downloaded country).</li></ul> |
| **M4** | Plan | `packages/planner` with stage planner and riding-time model; annotated per-day GPX export, with gaps marked for the rider's own route tool (D47). Prototype: plan a trip, compare plans. **Design agreed in 11.6 (D43–D50).** |
| **M5** | Go simulation | Live providers (forecast grid by block, MeteoAlarm, CAMS, FIRMS/EFFIS, river gauges, closures registry, OSM change monitor). Prototype: **"simulate being at km X on date/time Y"**, showing the briefing a rider would see. Handoffs to other apps and sites (D41, list in 12). |
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

This records how user routes and other networks slot into what M0–M2 built. The user-GPX part is now milestone M3.5 (D39, design in 11.5); other networks remain a later phase.

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

### 11.4 M3 design: Dream data

Concept D35, rider levels D36, climate source D34. Everything is computed in the batch audit and summarised **per daily section** (and per section × month). The matchmaker then works on those summaries alone, so it can later run on the rider's device.

**Built 2026-10-16.** Where the build differs from this design, the M3 row in 11 says so.

#### What M3 computes

| # | Dimension | Per section (× month where marked) | Source | Notes |
|---|---|---|---|---|
| 1 | **Climate** × month | Mean daily max and min temperature; rain days (≥ 1 mm) and mean rain; heat days (max ≥ 32 °C); windy days (daily mean ≥ 8 m/s) | ERA5 via the CDS API (D34): 10 years (2016–2025), one point every ~100 km, hourly series reduced to daily values locally | Each section uses its nearest point. Point time series (the gridded ERA5 or ERA5-Land fallback wasn't needed for EV8). A small test request at the start checks the key and licences. |
| 2 | **Wind along the route** × month | Mean along-route wind component in each direction of travel, and the share of days with a headwind above 3 m/s | ERA5 daily mean wind (u, v) projected onto the route's heading, km by km | This feeds direction advice. |
| 3 | **Daylight** × month | Day length and civil twilight on the 15th of the month at the section's midpoint | Astronomical calculation (NOAA formulae, in code) | Clock times wait for Plan and Go. |
| 4 | **Holidays and crowding** × month | Share of days in school holidays; number of public holidays; relative tourism intensity (the month's tourist nights against the national monthly average) | OpenHolidays API (ES, FR, MC, IT, SI, HR, AL). Eurostat monthly nights at tourist accommodation (`tour_occ_nim`), where Eurostat publishes it | National level for now. **Countries without data (BA, ME, GR, TR and CY for holidays; any country Eurostat doesn't cover) show "no data", and the rider is told to check (D37).** Regional detail would need NUTS boundaries, whose licence for commercial use must be checked first. |
| 5 | **Seasons** × month | Campsites: how many publish a season, and how many of those are open (or partly open) that month; ferry-crossing operation where published | OSM `opening_hours`/`seasonal` (M2) for campsites and ferries; notes in the route file only where they cite a source | **The known part only (D37):** "4 of 37 campsites publish a season; 3 are open in October; check the rest ahead". Nothing is assumed about the others. |
| 6 | **Scenery themes** | A 0–1 score and a plain description per theme (below) | OSM (corridor extract) and the terrain profile | Scores are ranked within the network, so "high coast" means coastal compared with EV8's other sections. |
| 7 | **Remoteness** | Longest stretch, and share of km, more than 5 km from a village or larger | OSM `place=*` (corridor extract) | Combined with M2's services gaps on the reality-check card. Population grids (GHSL) and mobile coverage come later. |
| 8 | **Grade** (D36) | Level 1–5 for riding the section as one day, in each direction (km and climbing); steepest 500 m | Section length, M1 ascent and descent | The same grades are computed for whole stretches in the matchmaker. |
| 9 | **Surfaces** (D36) | Shares of *road*, *cycle path* and *gravel* | M1 layers. Each km piece goes to gravel if its surface is gravel, dirt or compacted; else to cycle path if it is a cycleway, shared path or separated track; else to road | Busy-road share (LTS 4) is kept separately. |

**Scenery themes** (all from OSM, so coverage varies by country and is shown):

| Theme | Measured as |
|---|---|
| Coast & beaches | Share of the section within 1 km of the coastline; beaches within 1 km |
| Mountains | Relief and climbing per km from the profile; passes and peaks within 2 km |
| Lakes & rivers | Share of the section within 500 m of a lake or river |
| Forest & nature | Share within 500 m of forest, or inside a protected area or national park |
| Vineyards & wine | Vineyard area within 1 km; wineries and wine shops |
| Villages & heritage | Castles, ruins, monuments, old towns and UNESCO sites (`heritage=1`) within 1 km; village density |
| Viewpoints | `tourism=viewpoint` within 1 km |
| Towns & culture | Built-up share; museums and attractions within 1 km |

#### Scores (simple by design, D34)

**Comfort**, per section × month, 0–100: a weighted average of
- temperature: ideal daily max 18–26 °C, falling to 0 at 8 °C or 34 °C (40%);
- rain: share of rain days, 0% gives 1 and 50% or more gives 0 (30%);
- daylight: 11 h or more gives 1, 8 h or less gives 0 (15%);
- wind: share of windy days (15%);

minus a penalty for heat days. Labelled *excellent*, *good*, *fair* or *poor*.

**Best time**, per section × month: 70% comfort, 20% services open (published seasons only), 10% quietness (inverse tourism intensity and school holidays). Each part can also be shown on its own.

**Missing inputs (D37):** when a part has no data, it is left out and the remaining weights are rescaled. The score carries a "partial" marker naming what's missing, e.g. "no holiday data for Greece". Heatmap cells with partial scores are marked, and an all-unknown component shows as "no data", never as an average.

**Direction advice**, per section or stretch × month: the along-route wind in each direction, plus the difference in climbing between directions. If both are small, the advice is "either way"; otherwise "ride westbound (tailwind ~2 m/s, 400 m less climbing)".

All weights and thresholds live in a YAML profile (`engine/profiles/dream-v0.yaml`) and are placeholders to tune, like D13.

#### Matchmaker

**Inputs:**
- fitness level (D36);
- number of days (or a range) and a month, or "best month";
- surface preferences for road, cycle paths and gravel;
- scenery themes to favour;
- practical needs: a railway station near both ends (M2's stations; ferry terminals don't count), camping or rooms, avoid busy roads.

**Search:** every run of consecutive daily sections on the route, in both directions. A run may cross ferry crossings and small breaks, but not "missing" links or sea crossings over 50 km. That's about 4,600 runs × 2 directions for EV8, which is trivial in the browser. A run qualifies when its km/day and climbing/day for the chosen days fit the rider's level, with some tolerance. It is then scored on:
- grade fit;
- surfaces;
- themes;
- best-time score for the month;
- direction;
- practical needs;
- data confidence.

**Results:** the top 10, each showing:
- start and end, km, days, km/day, climbing/day, grade and best direction;
- comfort for the month;
- surface mix and theme highlights;
- *why it matches* and *watch out for*: busy-road km, unpaved km, longest services and bail-out gaps;
- *check yourself* (D37): every gap behind the result, e.g. "school holidays in Montenegro: no data, check before booking" or "33 of 37 campsites publish no season, check opening dates". Runs aren't ranked down for missing data; the rider judges it.

#### Outputs and access

- **Bundle file `dream.json`:** the per-section summaries above, plus 12 monthly values for each measure: 0.6 MB for EV8. This is the "catalogue" from 7.2 for one route, and it is small enough to download and search on the device.
- **API:** `GET /v1/routes/{network}/{ref}/dream`, served as a static file and cached.
- **Free and paid (D35):** `dream.json` holds only summaries and counts. It is public and free. Everything else in the bundle is what a Trip Pass unlocks. The prototype shows everything, as now.
- **Manifest:** ERA5 (C3S), OpenHolidays and Eurostat are added as sources, with their attributions.

#### Prototype viewer

- **A "Dream" tab** in the sidebar holds:
  - the **best-time heatmap**: one row per daily section, aligned with the section list, and 12 month columns, coloured by best time, comfort, temperature, rain, daylight, wind, crowding or campsites open;
  - the **matchmaker** form and results above it.

  Clicking a heatmap cell selects that section and month, and the month carries through to the places filters.
- **A reality-check card** for the selected section or matchmaker result: the M1 and M2 figures plus grade, comfort, direction, themes and data confidence. It ends with a **"check yourself"** list of every data gap behind it (D37).
- **The map** highlights the selected stretch. An optional strip row shows comfort for the chosen month.

#### Build order and checks

1. Check the Copernicus key with a small ERA5 request. Write the climate adapter (time series, then the grid fallback), fetch EV8's ~75 points, and compute the monthly normals. Unit tests use small synthetic series.
2. Daylight, holidays (OpenHolidays; "no data" elsewhere), and Eurostat monthly tourism.
3. Scenery themes and remoteness from the OSM corridor; grades and surface shares from M1.
4. Comfort, best-time and direction scores; write `dream.json`; regenerate the contracts.
5. Viewer: the Dream tab, heatmap, matchmaker and reality-check card.
6. **Acceptance:**
   - the heatmap shows plausible seasons, e.g. heat in July for southern Spain and Greece, and short days in December;
   - your case gives sensible stretches: "7 days in October, Moderate, prefers cycle paths, coast and villages, train at both ends";
   - all tests and lint pass.

#### Known limits, accepted for M3

- 10 years of data at ~100 km spacing on ERA5's ~28 km grid, which smooths coastal and mountain contrasts. ERA5-Land or more points fix this later by configuration.
- Daily values only, and a heuristic comfort score.
- Crowding at country level only.
- Campsite seasons are known only where they are published (often a small minority); the rest is a "check yourself" item (D37).
- Holidays and tourism intensity are missing for some countries (BA, ME, GR, TR and CY for holidays), so they show "no data" (D37).
- Scenery depends on how well OSM is mapped locally.
- No photos or descriptions (D35).

### 11.5 M3.5 design: user GPX audits

**Built 2026-10-17.** Where the build differs from this design, the M3.5 row in 11 says so.

D22–D25, D39, D40. The whole audit built so far (M1 road layers and terrain, M2 services, M3 Dream) runs on a route file the owner supplies, as a private audit on the laptop. EV8 is unchanged.

#### Running it

```
npm run audit:file -- path/to/route.gpx [--name "Pyrenees crossing"]
```

The command does everything, in order:
1. Reads the file and registers the route as `user/<id>`. The id comes from the file's contents, so the same file always gets the same id, and re-runs add new bundles to it.
2. Builds the 15 km corridor, downloads any OSM country extracts it needs, and cuts them to the corridor.
3. Builds Valhalla tiles for the corridor, or reuses EV8's when the corridor lies inside EV8's. EV8's Valhalla is stopped meanwhile.
4. Runs the audit as for EV8 and writes a private bundle.
5. Restarts EV8's Valhalla and prints the viewer link for the new route.

`npm run forget -- <id>` deletes the route.

The file can live anywhere outside the repository. The command copies it into the data folder, so a private route is never committed.

#### What changes

| Part | Design |
|---|---|
| **GPX reader** (D22) | One reader for any GPX: tracks and their segments (`<trk>`), planned routes (`<rte>`), waypoints (`<wpt>`), and the file's name and description. A file with tracks uses them; a file with only route points uses those. Repeated points and GPS jitter at stops are dropped. FIT comes later. |
| **User route source** | Network `user`; id `u` plus the first 10 hex characters of the file's SHA-256. The name comes from `--name`, else the file's metadata or first track, else the file name. Status and licence are unknown (D25), visibility is private, and the file's direction of travel is "forward". |
| **Sections** (D40) | A file with several tracks gets one section per track, in file order, with orientation inferred as for EV8. Otherwise the route is cut into equal stages, as many as make them closest to 60 km. Each stage is named after the nearest town or village (within 5 km) at its ends, e.g. "Stage 4: Foix – Ax-les-Thermes", otherwise by km. |
| **Gaps** | Gaps between tracks are classified from OSM ferry and rail data, as for EV8. There is no hand-curated route file. Straight-line stretches are flagged and handled as on EV8, including the climbing rule. |
| **Rules** (D40) | The ECS-style check runs as on EV8. Signage is unknown, so that criterion is "unknown" everywhere and the essential and important pass rates come out lower. The OSM waymarked-route layer shows where the route follows signed routes. EuroVelo-only findings are off: status findings, OSM EuroVelo-relation coverage, and EuroVelo's public-transport advice. |
| **User places** (D24, D40) | Waypoints become private places (`source: user`) on the route's measure axis. Their type comes from the GPX `<type>` or `<sym>` where present, otherwise "waypoint". They are shown on the map and in the Ahead list in their own style, and are **never counted** in services, gaps or findings. They live only in that route's bundle (`user_places.json`). |
| **Overlap** (D40) | Public bundles gain a list of the OSM ways they are matched to. A user route reports the length it shares with each public route, when there is any, e.g. "38 km (12%) follows EuroVelo 8, sections 41–43". The user route's own ways stay in its private bundle. |
| **Private storage** (D25, D39) | Private bundles live under `bundles/private/user/<id>/`, marked `visibility: private` in the manifest. The API never lists them and serves one only by its id. The viewer remembers the private routes opened in this browser, for its route switcher. They are kept until deleted. |
| **Forget** (D39) | Deletes everything specific to the route: the file copy, its bundles, corridor extract, match cache, Overture places fetched along it, Dream extracts and routing tiles. Shared caches stay, because they are kept by area, not by route (D25): OSM country extracts, elevation tiles, ERA5 grid points, and holidays and tourism by country. |
| **Climate** | Climate points snap to ERA5's own 0.25° grid, so a point fetched for one route serves any route nearby. EV8's 73 downloads are re-indexed by grid cell, so nothing is fetched again. |
| **Viewer** | A route switcher lists the public routes from the API, plus the private routes opened in this browser, marked "Private". Status shows as unknown, and the EuroVelo status layer is hidden for user routes. User places get their own map style and Ahead rows. The summary shows the overlap. Dream works unchanged. |

#### Build order and checks

1. GPX reader and user route source, with stage splitting and naming. Unit tests use small synthetic files: tracks, route points only, waypoints, several tracks.
2. Route sources chosen by network in the CLI and audit; EuroVelo-only findings switched off.
3. Private bundles, the API, and `forget`.
4. The `audit:file` command: corridor, Valhalla tiles and restart; ERA5 grid snapping.
5. User places and the overlap.
6. Viewer: route switcher, private label, user places, overlap.
7. **Acceptance:**
   - the owner's planned France–Spain route over the Pyrenees audits with one command and opens in the viewer as a private route, with every layer, its Pyrenean climbs, services, the ECS-style check and Dream;
   - its waypoints show but change no count;
   - the overlap with EV8 is reported if the routes share roads;
   - `forget` leaves nothing route-specific behind;
   - EV8's audit is unchanged apart from the new way list, and all tests and lint pass.

#### Known limits, accepted for M3.5

- GPX only; FIT, TCX and the others come later (D22).
- Files come in through a laptop command. There is no upload in the viewer, and no on-demand server or personal Trip Pass yet (D31, D32).
- Places are still fetched per route; the shared catalogue by area comes later (D23).
- Routing tiles are built per route corridor.
- Signage is unknown on user routes.
- A file with only sparse route points (turn points) is approximate, and its long straight stretches are flagged.
- Countries missing from the bike-carriage table show "unknown" bike policy (for example Andorra, if the route crosses it).
- The first audit in a new area takes longer: downloads, tile building and the Copernicus queue. The France and Spain extracts are already on disk.

### 11.6 M4 design: Plan

**Agreed 2026-10-17, after three rounds of the owner's answers (D43–D50).** Nothing is built yet. The owner reviews in chat, not in this document: questions are put there, and the answers are recorded here as decisions before any code.

It builds on D35 (Dream ends with a choice), D36 (rider levels), D37 (unknowns), D41 (handoffs), D43 (riders never see the audit screens), D44 and D49 (Dream and Plan on the web first, Go on the phone), D45 (a free teaser), D46 (cyclists first), D47 (no routing; gaps by evidence), D48 (the owner's choices for Plan), D50 (gaps counted as ridden; the teaser), principle 5 (the device knows the rider) and the Plan ideas in 12.

#### What Plan is for

Dream ends with a choice: a stretch of route, a time frame and a direction, with a suggested number of days (D35). Plan can also start from any range a rider picks on a route, public or private (D48). Plan turns that choice into days the rider can actually ride: where each day ends, where to sleep, eat and find water, how hard each day is, and what to sort out before leaving.

The rider should come out of Plan **excited and confident**: a solid plan, grounded in local knowledge, and a clear picture of what they are taking on. A plan is *ready* when it answers five questions:

| The rider asks | Plan answers with |
|---|---|
| Can I do this? | Every day measured against the rider's level, in hours as well as km and climbing; the hard days named, and why |
| Where do I sleep each night? | A stop for every night, the beds we know of there, what's known about their season, and a plan B |
| What could go wrong? | The few real risks on these days, said plainly, with what's at hand: the beds before and after, the stations along the day |
| What do I sort out before I go? | A short to-do list: book, call, check, getting there and back |
| What will it be like? | The character of each day, its highlights, and the typical weather for the time of year |

**What "local knowledge" means today.** It is the audit: OSM, Overture, the terrain, the ECS-style checks, climate, holidays and the bike-carriage table, each with its source and date. Rider reports (Go, 12) and partners' own notes (D29) may add to it later. We have no prices, reviews or photos, so Plan never ranks a bed by quality.

**What Plan doesn't do.** It doesn't build the rider's route (D47): the day GPX is a starter file, with gaps and issues marked, for the rider to finish in their own route tool. It isn't a navigation app: a gap in the route is highlighted and counted as ridden, however the rider bridges it (D50). It gives no kit advice (D48): it shows where water, food and services are, and riders judge what to carry. It never suggests wild camping (D48).

M4 plans for cyclists, including e-bikes (D48). Other ways of travelling come later, and the interfaces leave room for them (D46).

#### Not a wall of facts

For a 7-day stretch of EV8 the audit holds about 40 findings and some 9,000 places, 1,400 of them places to stay, plus layers for every km and 12 months of climate. Shown as they are, they would bury the few things that matter. So Plan never shows the audit as it is: it **turns facts into plan items**, ranks them, and shows a few at a time.

1. **Start from a draft, not a form.** After a few questions (below), the planner builds a complete plan by itself. The rider adjusts by exception: move a stop, add a rest day, lock a booked night. Nothing has to be configured to get a useful answer.
2. **Each relevant fact becomes one of four kinds of plan item:**

   | Kind | Means | Example |
   |---|---|---|
   | **Your call** | A decision only the rider can make, with the options worked out | "Day 3 is 104 km, beyond Moderate: split it (+1 day), stop 16 km earlier and make day 4 longer, or keep it." |
   | **Before you go** | Something to do at home, with a handoff where there is one (D41) | "The campsite at the end of day 4 publishes no October dates: call to check." |
   | **Heads-up** | Something to know on the day, at a km | "km 412–418: 6 km on a busy road with no shoulder." |
   | **Highlight** | Something to look forward to | "A viewpoint 1 km off the route at km 233." |

   Unknowns (D37) become "before you go" checks, grouped and placed where they matter, not repeated on every day.
3. **Only what matters to this rider.** An item surfaces only if it falls on the rider's days (stretch, direction, dates) and crosses *their* thresholds (level, surfaces to avoid, how they sleep, their bike). An 8% climb is a heads-up for a Leisurely rider, not for a Tough one. Two km at LTS 3 matter to a rider who said "avoid busy roads".
4. **A budget of attention, at three depths:** the trip (its brief), the day (its card) and an item's *why*. The brief always has the same five key lines, one per question above. A day card shows at most 3 heads-ups and 3 highlights, ranked: safety, then a bed and water, then effort, then comfort, then interest. The rest sit behind "7 more" on the same card. These limits are a starting point, tuned on the prototypes (D48). **Nothing leads to the audit screens**, which are for us and network organisations (D43). The deepest a rider goes is an item's *why*: what we know, where it comes from, how recent it is, how sure we are, and where it is on the map.
5. **Numbers in the rider's own terms.** Not "1,240 m of climbing" but "1,240 m: your biggest day, about twice your usual". Hours and clock times sit beside km: "about 5 h riding, 6 h 30 with stops; in by 15:30, sunset 18:52".
6. **A story before the data.** Each day gets one line of character, written from templates over the data: "Flat, mostly cycle path, lagoons all day; one busy stretch into town." Every phrase traces to data, and tapping it shows its why. Later, D38's assistant may write these lines, under the same rule.
7. **Every automatic choice says why,** in a line: "Stopping here: 2 hotels and a campsite, 1 known open in October; a station; makes a 62 km day."
8. **End on the adventure, not the admin.** The brief opens with the trip's shape and highlights; the to-do list comes last.

**Findings and plan items stay apart.** Findings belong to the route and are the same for everyone. Plan items belong to one rider's plan, are computed on the device, and never leave it.

#### How the rider is guided

```
 Dream result ─► 1 A few      ─► 2 The draft  ─► 3 Your calls   ─► 4 Make it yours ─► 5 Before you go
 (stretch,        questions       trip brief      the 2–5            optional: move     to-do list,
  time frame,     (only what      and day         decisions only     stops, rest days,  exports,
  way, days,      Dream didn't    cards           the rider can      lock booked        sharing,
  level)          settle)                         make               nights             send to phone
```

1. **A few questions**, each with a default, asked only because they change the plan:
   - the dates, within the time frame Dream suggested (D48);
   - the number of days, as Dream suggested, which the rider can change (D48);
   - how you sleep: camping, rooms or a mix;
   - your day: start time, and how long you like to stop;
   - the bike: road, touring, gravel or e-bike (surfaces to avoid carry over from Dream).

   Pace comes from the rider's level (D36) and the bike; there is no question about speed or fitness (D35, D48). Rest days are added in step 4.
2. **The draft**: the trip brief and the day cards (below). A readiness line sums it up: "Ready to go: a bed every night, every day within your level, 3 checks before you leave", or "2 things need your call".
3. **Your calls**, one at a time. Each comes with its options worked out by the planner, and with what each option changes: days, the hardest day, nights without a known-open bed.
4. **Make it yours**: drag a stop along the profile, pick another stop from that night's alternatives, add a rest day, lock a night once it's booked. The planner re-plans the unlocked days around it at once.
5. **Before you go**: the to-do list with its handoffs, the exports, sharing, and sending the plan to the phone.

#### The plan, as the rider sees it

Layout sketches only: the places and figures are made up, not audit results. `›` marks something to tap for more, or for its why. They are drawn at phone width, which is how a plan looks once it reaches the phone for Go; on the web the same blocks sit side by side (below).

**Trip brief**: one screen saying what the rider is taking on.

```
 Agde → Arles
 6 days · Wed 13 – Mon 18 Oct 2027
 352 km · 1,100 m · eastbound
 Effort ▃ ▅ ▃ ▇ ▂ ▄  (── your usual day)

 Can I do it?
   Yes, at Moderate. Day 4 is the
   hardest: 74 km, about 5 h 20 riding.
 Where will I sleep?
   A stop every night. 4 of 5 rely on
   places with no October dates.  ›
 What could go wrong?
   Day 4 ends after sunset at your
   pace: your call.  +2 more ›
 What do I sort out before I go?
   1 call, 6 checks, trains both ends ›
 What will it be like?
   Typically 21 °C, rain 1 day in 5,
   light tailwind. Lagoons, flamingos,
   the walls of Aigues-Mortes.

 Day 1  Agde → Palavas    52 km  3 h 10
 Day 2  → Aigues-Mortes   38 km  2 h 20
 …
 How well we know these days  ›
```

**The five key lines** are always the same five, one per question in "What Plan is for". Each shows the most important item for its question, plus how many more there are:

| Line | Shows | Chosen from |
|---|---|---|
| Can I do it? | The level, how many days are harder than it or beyond it, and the hardest day in km, climbing and hours | Pace model, D36 |
| Where will I sleep? | Whether every night has a stop, and the weakest night: no known-open bed, a single bed, or book ahead | Stops, sleep rules |
| What could go wrong? | The top-ranked risk: a busy road, a gap in the route, a long stretch without water or a station, a day ending after dark | Plan rules, by rank |
| What do I sort out before I go? | Counts: calls to make, checks, bookings, getting there and back | The to-do list |
| What will it be like? | The typical weather on these days, and the trip's top highlights | M3 climate, highlights |

"How well we know these days" opens the data confidence in plain words, e.g. "surfaces known for 92% of the way; opening dates for 6% of the beds; opening hours for 11% of the food places".

**Day card**: one per day, opened from the day list, with the day's map and profile above it.

```
 Day 1 · Wed 13 Oct
 Agde → Palavas-les-Flots
 52 km · 60 m · an easy start
 3 h 00–3 h 35 riding  ›
 4 h 15 with stops · in by 13:15
 Sunset 19:05
 "Cycle paths between the sea and the
  Étang de Thau, through Sète, then
  lagoons to Palavas."
 Water, food  km 4 · 18 · 27 · 41
              longest gap 14 km
 Heads-up     km 19–21: busy road
              through Sète  ›
 Highlights   The Sète lido
              Mont Saint-Clair, 1 km off
 Sleep        Palavas: 9 beds, 2 known
              open in October  ›
              Plan B: Frontignan, 14 km back
 Bail-out     Sète, Frontignan, Vic-Mireval
```

A rest day gets a card too: the town, what our places show there (food, bike shop, pharmacy, ATM) and its highlights.

#### The web first, then the phone for Go (D44, D49)

Dream and Plan are likely better done on a bigger screen, so they are built for the web first. Go is always on a mobile device. The planner and the plan document are the same in both places.

- **On the web** (kilometrica.com, and partner widgets, D29): the brief above, then the map, the profile and the day list side by side. Stops are dragged along the profile, and plans compared side by side.
- **To the phone for Go, without an account.** The plan document travels in its link (below). "Send to my phone" shows the link as a QR code to scan, or the rider sends it to themselves. kilometrica.com (D42) can host universal links, so the link opens the app when it is installed, otherwise the phone's browser. The Trip Pass moves with its code (D33). A plan on a private route also needs the route, so for now it moves as a file (route plus plan).
- **On the phone in M4,** a plan opened from its link shows the brief, the day list and the day cards at phone width, as sketched above. That view is where Go (M5) starts. Planning on the phone itself can come later, with the app.
- **The phone's copy is the one that rides** (D49). Changes made on the road stay on the phone; with no accounts there is no sync. The rider can send the plan back the same way.
- **Exports and sharing** go through the browser's downloads on the web and the share sheet on the phone: GPX to Garmin Connect, Ride with GPS or Files; the calendar file; the trip book as a PDF.
- **One planner everywhere.** The planner is pure TypeScript, with no browser or Node APIs. The iOS app will probably run the same code (decided later, D48), which keeps the plan identical on the web, in a widget and in the app.

#### Riding time and effort

Plan measures a day in **hours**, as well as km and climbing, because hours are how a rider lives a day: a flat 60 km and a mountain 40 km can make the same day.

- **The model** (12): rider, bike and luggage mass; a sustained power; rolling resistance by surface; gradient; and the typical wind along the route for the time of year (M3). It is solved per 100 m of the profile, with a cap on descending speed (lower on gravel) and walking pace where a climb is too steep for the rider's level.
- **Pace comes from the level, never from fitness data** (D35, D48). Each level (D36) has a preset, tuned so that the middle of its band (e.g. Moderate, about 65 km and 600 m) takes roughly 4–5 h of riding. The bike adjusts it: rolling resistance by bike type, and for an e-bike, assistance up to 25 km/h (D48). Presets are placeholders, like D13. A rider whose hours look wrong picks another level.
- **Stops:** a share of riding time plus a lunch stop, by level and adjustable, always shown apart: "5 h riding, 6 h 30 with stops".
- **Unknowns give a range, never a guess (D37).** Where the surface is unknown, the day is timed both as paved and as gravel, and shown as a range with its reason ("surface unknown on 7 km"). Where the terrain is unknown (straight-line placeholders and unfilled gaps), the time is "at least". The planner plans on the slow end, so the plan still holds if the unknown turns out rough.
- **Daylight for the actual dates:** sunrise, sunset and civil twilight (`suncalc`, 6.3). A day that would end after sunset becomes a "your call".
- **Effort against the level:** each day is *within your level*, *a harder day* (up to about 20% over the D36 band in km, climbing or hours) or *beyond your level*. Three harder days in a row bring a suggestion: a rest day, or a shorter day.
- **Room for other ways of travelling** (D46): the model sits behind one interface (`pace(segment, rider) → seconds`), so a walking model (Tobler's or Naismith's rule) can join it later.

#### Stops and the stage planner

- **Candidate stops.** Places to stay that count (D17: within 5 km or 30 min of the route) are grouped into stops: by the town or village they belong to, otherwise by their access point on the route. A stop keeps its number of beds by kind, how many of them are open, partly open, closed or unknown in each month (D18), and what else is there: food, ATM, pharmacy, bike shop, station. None of this depends on the rider, so the **engine computes the stops** and writes them to `stops.json`, with counts only and no place names. The planner then filters them by how the rider sleeps and by the dates. Places closed that month (`c`) don't count. A stop where nothing is known to be open is still a stop, flagged; it is never assumed open or closed. Because `stops.json` names no bed, it can be free, and it lets the teaser plan real stops (D45, "Free and paid" below).
- **The planner** chooses one stop per night by dynamic programming over the candidates in route order (12). A day costs more the further its hours are from the rider's usual day (more when over than under), and much more when it breaks a hard limit (beyond the level, ending after sunset). A stop is worth more with more known-open beds of the rider's kind, food and a station. Rest days go at stops with services. Locked nights are fixed points, and the rest re-plans around them. A week's stretch has a few hundred candidates, so this takes milliseconds on the device.
- **Number of days:** Dream's suggestion, which the rider can change (D48). When one day more or fewer makes the plan clearly better (no day beyond the level, fewer nights with nothing known open), the planner offers it as a "your call".
- **The planner picks the stop; the rider picks the bed.** Each stop lists its beds, known-open first, then by detour, with what we know: kind, season, stars where tagged, and a link to the place's own website and phone where we have them (D48). Never ranked by quality. The rider may mark one as chosen or booked. Only about 15% of EV8's places to stay have a phone number in our data, and 58% a website, so for the rest the link is "see it in Google or Apple Maps" (D41). Affiliate links come later.
- **A plan B for every night:** the nearest other stop before and after, with what the change costs ("the next stop, 9 km on: day 3 becomes 61 km").
- **No wild camping** is ever suggested (D48). A rider who sleeps elsewhere can end a day where they like; Plan then shows no bed there and suggests nothing.

#### Gaps and bad stretches

Plan never routes around anything and never assumes how a rider crosses a gap (D47). It says what we know, and the rider decides; their own route tool is where they change the line.

**Gaps in the route line** are where the official track stops and starts again. The engine already types them by evidence (M1, `layers/gaps.py`); on EV8:

| Type | Evidence | EV8 examples | In the plan |
|---|---|---|---|
| **Ferry crossing** | An OSM ferry route with a terminal at each end of the gap (high confidence), or a curated note with its source | Venice lagoon (3 crossings), Ploče → Trpanj; Athens → Türkiye and Türkiye → Cyprus from the owner's assessment (medium, sailings to confirm) | A ferry leg in the day, not ridden. Before you go: check the season and timetable, with the operator's site where known (D41) |
| **Public-transport link** | The network's own published advice, curated with its source (D47). The EuroVelo GPX publishes none, so EV8 has none yet | (Athens–Corinth, if EuroVelo's advice is recorded) | A transport leg in the day, not ridden. Before you go: check times, with the operator's planner (D41) |
| **Unfilled gap** | No ferry and no published advice | Monfalcone → Muggia, 32 km; Ventimiglia → Limone, 45.7 km; Cyprus, 4–5 km | Highlighted on the day and in the starter GPX, and counted as ridden however the rider bridges it (D50): at least the straight-line distance, with the terrain unknown. Plan doesn't ask how the rider will cross it |
| **Digitising break** | Shorter than 2 km | 1–1.5 km breaks | Ridden as part of the day; no item |

**One engine rule goes (D50).** Today a gap longer than 2 km with rail stations within 3 km of both ends is labelled a "probable public-transport link" (low confidence), e.g. Ventimiglia → Limone, 45.7 km over the Col de Tende. That is an assumption, so the rule is dropped and such gaps become unfilled gaps. Gaps are unlikely in a rider's own GPX; if one occurs, the same rules apply.

**Bad stretches on the line** (busy roads, unpaved where the rider avoids gravel, steps, steep 500 m, undeveloped sections) are heads-ups with plain facts: "6 km at 80 km/h with no shoulder". They are marked in the starter GPX, so a rider who wants another line can draw it in their route tool. On EV8 these are many: 242 busy-road stretches, 1,664 km in all, the longest 68 km of Greek national road between Igoumenitsa and Preveza. The attention budget keeps them to the ones that matter most on each day.

#### Plan rules: where the items come from

Plan items come from a small, readable set of plan rules in `packages/planner`, with their thresholds in one file to tune, like D13. Each rule reads the plan and the bundle, and emits items with a kind, a day, a km or range, a short title, why it matters to this rider, a severity, the evidence (finding, place and event ids) and an optional handoff. The first rules:

| Rule | Emits | From |
|---|---|---|
| A day over the level; ending after sunset; three harder days in a row | Your call | Pace model, daylight |
| No known-open bed at a stop; only one bed | Before you go (check or book); plan B | Places and seasons (D18) |
| Book ahead: few beds, on a night of peak crowding or school holidays | Before you go | Places; M3 crowding and holidays |
| Where water and food are on the day, and the longest stretch without them | Shown on the day card; a heads-up when the stretch is longer than the services profile's gap (M2) | M2 places |
| Food places on the day closed on that date (weekday, public holiday) | Heads-up about the known part only (D37): just 11% of EV8's food places publish hours | OSM `opening_hours` (JS library, 6.3), holiday dates |
| A busy road, a surface the rider avoids, steps, a steep 500 m, an undeveloped section | Heads-up | M1 findings and layers |
| A ferry crossing or published transport link | Before you go: check the season and times | Gap types |
| An unfilled gap | Heads-up, highlighted on the day: "the route has a 32 km gap here, counted as ridden" | Gap types |
| A long stretch without a bike-carrying station | Heads-up | M2 bail-out |
| A border crossing | Before you go: check the documents | Countries |
| The day's biggest climb; the trip's high point | Highlight (and a heads-up at lower levels) | M1 climbs (FIETS) |
| Viewpoints, heritage, beaches, passes | Highlight, with a Wikipedia or Wikimedia Commons link where OSM has one (D48) | The OSM features behind M3's themes |
| Getting to the start and home again | Before you go: the rail operator's planner from the end stations, with the bike note | M2 stations, D20, D41 |
| Missing data on these days | Before you go: check yourself (D37), grouped | Every gap behind the plan |

Ranking and the caps come after the rules. The rider can tick a to-do as done, or dismiss a heads-up ("I know"), and it stays that way. The same items feed the exports and the GPX waypoints, and later the D38 assistant and the Go briefing (M5).

#### Presenting the plan to others

| Who | What they get | How |
|---|---|---|
| **The rider, on the road** (until Go, M5) | A **trip book**: the brief, then a page per day (map, profile, water and food, heads-ups, sleep and plan B, bail-out) | A PDF, from the browser's print view or the share sheet in the app; needs no signal |
| **The rider's route tool and bike computer** | **Starter GPX per day and for the whole trip** (D47): the track, with gaps marked at both ends, and waypoints for the night's stop, water and food, heads-ups, highlights and bail-out stations, within the same attention budget | Download on the web, the share sheet on the phone; later Ride with GPS upload (12, D41) |
| | Later, **FIT courses**, whose course points Garmin shows as alerts ahead | A FIT writer (D22 lists only the reader) |
| **Riding partners** | The whole plan, read-only, or an imported copy to adjust on their own device | A share link (below) |
| **Family and friends at home** | "Where I'll be": dates and nightly stops only | A share link at itinerary level; a calendar file |
| **Calendars** | One all-day event per day, e.g. "Day 1: Agde → Palavas, 52 km", with the stop as its location | An `.ics` file, built on the device |
| **Other Kilometrica clients** | The plan document itself: from the website to the app, or from a partner's site to the app (D29) | `plan.json` (below) |

**The plan document** is a small JSON file with its own schema (`schemas/plan-v0.schema.json`, generated like the bundle's). It holds the route and the audit run it was made on, the direction, the dates, the days (ride or rest, from and to km, the stop, a chosen bed), locked nights, the calls made, item states and the rider's notes. The rider's inputs are kept with it, so it re-plans the same way. Computed values are not stored, because they are recomputed from the bundle. Exports meant for apps without the bundle (GPX, `.ics`, the trip book) carry them.

**Pinned to an audit run.** Bundles are immutable (principle 7), so a plan names the run it was made on. When a newer audit is published, the planner can say "since you made this plan: a campsite on night 4 has closed; a new finding on day 2". That diff can wait for M5, but the pin goes in now.

**Sharing without accounts (9.4, D48).** On a public route, the plan document is a few kilobytes. Compressed, it fits in the link's fragment (after `#`), which browsers never send to a server: the link *is* the plan, and nothing is stored anywhere. Anyone holding the link can read it. A link has one of two levels: the full plan, or the itinerary only. Someone without a Trip Pass sees the plan as shared, but needs their own pass to change it. The same link is how a rider moves a plan from the web to their phone. A plan on a private route (D25) can't travel that way, because the recipient would also need the route. For now it is shared as a file (route plus plan), and later as an end-to-end encrypted blob (9.4).

#### Ready for the assistant (D38)

Each phase will later get a small, local, open-weight assistant, grounded only in our data and the rider's plan (D38). M4 builds Plan so it can be added without rework:
- **The planner's functions are the assistant's tools.** They are pure and typed, so each can be exposed as a tool as it is: summarise the plan, a day's details, the items on a day or a km range, why a stop was chosen, a night's alternatives, and "what if" re-plans (a day more, rooms instead of camping, other dates) that return the changed plan without saving it.
- **Every item carries its evidence** (finding, place and event ids, source and date), so an answer can cite it, and D38's honesty check (every number must come from a tool result) can be run against it.
- **Text comes from templates over the data,** never from free generation. The assistant may rephrase it later, under the same rule.
- **Everything stays on the device:** the plan, the inputs, and any question asked about them (D38, principle 5).
- **Nothing depends on the assistant.** It is never the only way to see or change anything.

#### Where it runs, and privacy

- **`packages/planner`** (TypeScript, pure, 6.5) holds the pace model, the stage planner, the plan rules, the plan document, share links and exports. It has no network access: it takes bundle data and the rider's inputs, and returns a plan. It runs in the browser (website, prototype, partner widget) and, probably, in the iOS app (D48).
- **The rider's inputs and plans stay on the device** (principle 5): in browser storage on the web, on the phone (and the rider's iCloud) in the app. A file export is the backup.
- **What is fetched gives nothing away.** The teaser's files cover the whole route, so fetching them says nothing about the stretch. With the Trip Pass, the app's offline pack holds everything. Where the full data is fetched online (the website, a partner widget), it comes by 50 km block (D31), so the server learns at most which blocks were looked at, as with live data (7.2).

#### Free and paid (D45, D50)

The teaser is the draft itself, at outline depth. The rider answers the questions and sees that the trip works for them. Seeing how it works, and taking it on the road, needs the Trip Pass.

| Free (the teaser) | With the Trip Pass |
|---|---|
| The questions | Day cards in full: water and food, heads-ups, highlights, bail-out |
| The day list: start and end towns, km, climbing, hours, effort against the level | Each stop's beds, with their links, and the plan B for every night |
| The effort chart | The plan items and their why |
| The brief's five lines, with counts in place of detail: "4 of 5 nights rely on places with no October dates", "2 risks need your call", "1 call to make, 6 checks" | Your calls with their options; moving and locking stops; rest days |
| Changing the dates, days, sleep style or bike, and seeing the outline re-plan | The trip book, exports, sharing and sending to the phone |
| | Go (M5) |

**The teaser plans from free files only:** `dream.json` (already free), `stops.json` (counts, no names) and `effort.json` (elevation and surface along the route). No free file names a bed, a water point or a finding, so the paid detail never reaches a device without the pass. The prototype has a free/full switch, and the teaser is reviewed once built (D50).

#### Engine and bundle changes

| Change | Why |
|---|---|
| `stops.json`: candidate stops (town or village, `at_m`, beds by kind with counts per month code, the other services there, a station), counts only and no place names | The stage planner; free, so the teaser can plan real stops (D45). M3.5 already names stages after towns this way |
| `effort.json`: elevation and surface class along the route, in a compact form | The pace model's input, free for the teaser |
| `highlights.json`: the OSM features behind M3's themes (viewpoints, heritage, peaks and passes, beaches), with `at_m` and any `wikidata` or `wikipedia` tag | Highlights, and their Wikipedia or Commons link (D48) |
| `calendar.json`: public holiday dates and school holiday periods per country, where known | Heads-ups by date; M3 keeps only monthly counts |
| Gap types by evidence only (D47, D50): the "stations near both ends" rule is dropped | Gaps in the plan and the starter GPX |
| Bundle schema 0.6, contracts regenerated | |

#### Prototype: a rider view

- **A separate rider view** in the web app, not a tab of the audit viewer, which stays our tool (D43, D48). It is built for the laptop first (D49); a plan opened from its link on a phone shows the phone-width view. It opens from a Dream result ("Plan this stretch") or from a range picked on any route, public or private (M3.5). The audit viewer can open the same plan, so we can check a plan against the evidence. Dream's matchmaker moves into the rider view once Plan works.
- The questions; then the trip brief, your calls, the day list and the day cards, as sketched above. A day opens with its map and profile, and its stop and plan items drawn on them.
- Moving stops (dragging, or from the night's list), rest days, locked nights.
- **Compare plans** (M4's deliverable): two or three plans, e.g. 6 or 7 days, camping or rooms, either direction. What differs is shown side by side: days, the hardest day, total hours, nights without a known-open bed, open calls, busy km.
- Before you go: the to-do list, the exports (GPX, `.ics`, `plan.json`, the trip book), the share link and "send to my phone" (opening the plan in the phone's browser, until the app exists).
- The free/full switch (D45).
- Plans are saved in the browser, and export and import as files.

#### Build order and checks

1. The pace model, with unit tests on synthetic profiles: the presets give the intended hours for each level's middle day, an e-bike preset, and ranges where the surface is unknown.
2. Engine: `stops.json`, `effort.json`, the highlights and calendar files; gap types by evidence only (D50); schema 0.6; contracts.
3. The stage planner over `stops.json`, tested on synthetic routes and an EV8 stretch, including an unfilled gap (counted as ridden) and a ferry.
4. Plan rules, ranking and caps, with a golden plan for the owner's case.
5. The rider view on the laptop: the questions, trip brief, day cards, your calls, moving and locking stops, compare, the free/full switch; then the plan's phone-width view.
6. Exports and sharing: starter GPX with gaps marked, `.ics`, `plan.json`, the trip book, share links, send to phone.
7. **Acceptance:**
   - the owner's Dream case ("7 days in October, Moderate, prefers cycle paths, coast and villages, train at both ends") opens in Plan with a sensible draft: no day beyond the level, a stop every night, and a handful of calls and checks, not dozens;
   - someone new to the trip can say what it asks of them from the trip brief alone;
   - a plan made on the laptop opens on a phone from its link (QR code), unchanged, at phone width;
   - the free view shows no bed, water point or finding;
   - the owner's Pyrenees route (private) plans the same way;
   - the day GPX files load in Garmin Connect and Ride with GPS with readable waypoints and the gaps marked (checked by the owner on a device);
   - a share link opens read-only in another browser, and the itinerary level shows only dates and stops;
   - all tests and lint pass.

#### Not in M4

- Routing around gaps or bad stretches; building the rider's final route (D47).
- Booking, prices and reviews: handed off (principle 8). Affiliate links later (D41).
- Timetables (D20): ferry and transport legs say "check times" and hand off.
- Forecasts: Plan uses climate normals; forecasts belong to Go (M5).
- Kit advice and wild camping (D48).
- E-bike battery range and charging points (D48).
- Ways of travelling other than cycling (D46).
- Several routes in one trip; editing one plan together.
- The iOS app itself, planning on the phone, and the D38 assistant for Plan.

#### Questions for the owner

All answered (D43–D50). The design is ready to build when the owner says go.

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
- **Annotated starter GPX per day.** Findings as GPX waypoints ("⚠ busy road 3.2 km", "last water for 38 km"), and gaps marked at both ends for the rider to fill in their own route tool (D47). Shows up on Garmin and survives RWGPS/Strava imports.
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
- **Handoffs to other apps and sites** (principle 8, D41; to evaluate when designing M5). Links are built on the device and carry only the place's coordinates or name, so the rider's position reaches another service only when the rider opens it. No tracking parameters, no link shorteners, nothing goes through our servers (D30).
  - **Google Maps:** free Maps URLs, no API key (checked 2026-10-17): `https://www.google.com/maps/dir/?api=1&destination=<lat>,<lng>&travelmode=bicycling`, or `walking`. Without an origin it routes from the rider's current location. `dir_action=navigate` starts turn-by-turn at once. Up to 3 stops in between on mobile browsers, 9 elsewhere; bike routes use bike paths "where available". It opens the app if installed, else the web. Google's paid Maps Platform services (Directions, Places) are not needed: they cost per request, carry display rules, and would send riders' positions through us.
  - **Apple Maps:** unified Maps URLs (iOS 18.4+): `https://maps.apple.com/directions?destination=<lat>,<lng>&mode=cycling` (or `walking`). They route from the current location without a `source`, and allow repeated `waypoint` stops. Inside the iPhone app, MapKit opens Maps directly in cycling mode.
  - **Offline OSM apps:** Organic Maps and OsmAnd are free and route bikes offline, which matters on remote stretches; as far as known, Google's offline areas give driving directions only (to confirm). Their link formats are still to be checked.
  - **Ride with GPS:** no documented link opens its planner at a place. Its public API (v1, checked 2026-10-17) lets a rider connect their own Ride with GPS account through OAuth; we can then upload the day's GPX from M4 into their library (a file upload processed as a background task), and Ride with GPS syncs it to their Garmin, Wahoo or Hammerhead. Creating points of interest through the API is limited to organisation accounts. To check: the API terms, a Kilometrica API client, and whether OAuth works from the app without a server of ours (D30: the account is the rider's, and its token stays on the device). When a rider's file came from Ride with GPS (its GPX links to the route page), we can also link back to that page.
  - **Komoot** and other route apps: link formats to check.
  - **Android, later:** the `geo:` link lets the rider choose any installed map app; Google's `google.navigation:` link opens Google Maps in bike mode.
  - **Two buttons per place:** *Directions*, exact by coordinates; and *See it in Google or Apple Maps*, a search by name that shows their opening hours, reviews and photos. That listing is theirs and may occasionally be the wrong place, so it is labelled as theirs.
  - **There and back to the route:** we know where the rider leaves the route for each place, so one link routes from here, via the place, to where they rejoin at km X.
  - **Travel mode:** cycling by default, walking as an option.
  - **The rider's preferred app** is remembered on the device (Apple Maps by default on iPhone), or "ask each time". No account.
  - **Bike computers:** they can't be handed a destination by link, but M4's daily GPX already carries the places as waypoints, so "navigate to waypoint" works on the device, offline too.
  - **Call and website** links from OSM's phone and website tags, e.g. to check a campsite is open before a 6 km detour.
  - **Stations:** the rail operator's journey planner (SNCF, Renfe, Trenitalia…), with our bike-carriage note beside it. **Ferries:** the operator's page. **Weather:** open a forecast site at the position, until M5's own live data.
  - **Our estimate beside theirs:** e.g. "1.2 km, ~6 min, our estimate". The map app's route will differ, and saying whose figure is whose is honest (D37).
  - **Later:** monetised affiliate links for booking, once impartiality and disclosure are settled; emergency handoffs (112, "share my position" with coordinates, km on route and a maps link).

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
- **A conversational assistant in each phase (D38):** plain-language questions and guidance for Dream, then Plan, then Go. It answers only through tools over our data, runs on the device (offline in Go), and is never the only path to safety information.
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
