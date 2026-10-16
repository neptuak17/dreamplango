# EuroVelo GPX tracks: format and EV8 data quality

Inspected 2026-10-14 from the EV8 download (HTTP `Last-Modified: 2026-10-13`). The licence document says NECCs last revised the tracks in July–November 2025.

## Download

| What | URL | Notes |
|---|---|---|
| Full route | `https://en.eurovelo.com/route/get-gpx/31` | `EuroVelo 8.gpx`, 6.6 MB. `31` is EuroVelo's internal id for EV8. The adapter finds other ids from the `/route/get-gpx/<id>` link on `https://en.eurovelo.com/ev<N>`. |
| Developed parts only | `…/get-gpx/31?developed=1` | A subset of the full file: only the "Developed + Signed" and "Developed + Not Signed" sections (95 of 152). Not needed. |

Licence: ODbL 1.0 (contents: DbCL 1.0). The attribution wording we must show is recorded in [DATA-LICENSES.md](../DATA-LICENSES.md).

## Structure

- GPX 1.1, `creator="geoPHP"`. No `<metadata>`, waypoints, routes or `<extensions>`.
- **One `<trk>` per daily section,** each with exactly one `<trkseg>`. Tracks are in route order.
- `<name>`: `NNN: Start – End (Status)`. The separator is an en dash. Some names have double spaces, and some places carry bilingual names (`Portorož / Portorose`).
- `<desc>`: the status label alone.
- Every `<trkpt>` has `<ele>` (source unknown, unverified).
- **Missing from the file:** country, stage or variant information, public-transport links, and any per-point attributes.

### Status vocabulary (EV8)

The label is *development + signage*, matching the 2026 map legend rather than the five categories in the December 2025 "how to use" PDF.

| Label | Sections | km | Share |
|---|---:|---:|---:|
| Developed + Signed | 56 | 2,802 | 38.1% |
| Developed + Not Signed | 39 | 1,756 | 23.9% |
| Partially Developed + Not Signed | 32 | 1,451 | 19.7% |
| Undeveloped / Unknown | 22 | 1,183 | 16.1% |
| Partially Developed + Signed | 3 | 155 | 2.1% |

EV8 has no "Certified" sections. The parser accepts the word anyway, and flags any label it does not recognise as a finding.

## EV8 geometry quality

| Item | Value |
|---|---|
| Ridden length | **7,347 km** geodesic (EuroVelo states 7,350 km) |
| Points | 85,933 |
| Median point spacing | 30–100 m in most sections; 100–160 m in Türkiye (flagged as "heavily simplified") |
| Straight-line segments ≥ 5 km | Section 53 Manosque–Meyrargues is **2 points / 28.4 km**; section 45 Leucate–Narbonne 9.9 km; 96 Zadar–Pakoštane 5.1 km; 146 Nicosia–Ayia Napa 5.8 km |
| Straight-line segments 2–5 km | 35 more |
| Reversed sections | Section 147 Ayia Napa–Larnaka is stored end-to-start. Flipping it removed two phantom ~44 km gaps. |

### Gaps between consecutive sections (≥ 1 km)

"Initial guess" was written at M0 inspection. "M1 audit" is what the engine concluded from OSM ferry routes (terminals at both ends), rail stations near both ends, and the curated file `engine/profiles/routes/eurovelo-ev8.yaml`.

| After section | Straight-line | Where | Initial guess | M1 audit (basis, confidence) |
|---|---:|---|---|---|
| 40 | 1.2 km | Sant Feliu de Guíxols | digitising gap | discontinuity (distance, medium) |
| 60 | 45.7 km | Ventimiglia → Limone | missing track or rail link over the Col de Tende | **public-transport link** (rail stations at both ends, low) |
| 70 | 1.5 km | Cremona | digitising gap | discontinuity (distance, medium) |
| 75 | 4.7 km | Chioggia → Pellestrina | lagoon ferry | **ferry** (OSM ferry route, high) |
| 76 | 1.2 km | Santa Maria del Mare → Alberoni | lagoon ferry | **ferry** (OSM ferry route, high) |
| 77 | 5.5 km | Lido di Venezia → Jesolo side | lagoon ferry | **ferry** (OSM ferry route, high) |
| 82 | 32.4 km | Monfalcone → Muggia (Trieste) | missing track or ferry | **missing** (no ferry or rail at both ends, medium) |
| 101 | 14.2 km | Ploče → Trpanj | ferry | **ferry** (OSM ferry route, high) |
| 137 | 302 km | Athens → Dikili (Türkiye) | ferry, very likely (owner's assessment): crosses the Aegean. There seems to be no direct sailing, so probably via an island such as Lesvos to Dikili or Ayvalık. | **ferry** (curated, medium). Exact route and season still to confirm. |
| 145 | 621 km | Selçuk → Nicosia (Cyprus) | ferry, very likely (owner's assessment): crosses the sea. Türkiye–Cyprus ferries appear to sail from the south coast (e.g. Taşucu or Mersin to northern Cyprus), so probably a long overland transfer plus a crossing of the line dividing Cyprus. | **ferry** (curated, medium). Still to confirm. |
| 146 | 1.2 km | Cyprus loop | digitising gap | discontinuity (distance, medium) |
| 148 | 4.1 km | Cyprus loop (Limassol → Paphos) | digitising gap or missing link | **missing** (medium). An early matcher version wrongly called this a ferry because a coastal ferry line passed nearby; terminals are now required. |
| 150 | 4.8 km | Cyprus loop (Polis → Kykkos) | digitising gap or missing link | **missing** (medium) |

There are also 15 breaks shorter than 1 km, mostly under 300 m. All are discontinuities (info level).

## M1 audit results (bundle 2026-10-14)

- **Matching:** 98.8% of the 7,347 km is matched to OSM. 89 km is unmatched; 28 km of that is section 53's straight-line placeholder (Manosque–Meyrargues). Another 344 km is matched only approximately, between source points more than 1 km apart.
- **OSM's EuroVelo 8 relations** cover 83% of the official track.
- **Indicative ECS-style check (placeholder thresholds):** 71% of the length meets all essential criteria and 17% all important ones. Important criteria fail mostly on signage (44% of the length is published as not signed) and low traffic.
- **Terrain:** about 63,500 m of climbing over the whole route. The steepest sustained grades are in the mountain sections: Troodos in Cyprus, Velebit in Croatia, Montenegro, and the Albanian coast around Llogara. Some coastal values may still be cliff artefacts, because the DEM is sampled along the published track rather than the matched road.

## M2 services results (bundle 2026-10-14)

Places come from OSM and Overture release 2026-09-23.1. Overture contributes Meta, Foursquare, AllThePlaces and others.

- **Candidates and kept places:**
  - 208,517 OSM and 378,048 Overture candidates in the corridor.
  - After conflation, and within each service's display distance by bike, **158,174 places** were kept.
  - The detours took 3,558 Valhalla matrix requests: about 5 minutes on the first run, cached afterwards.

- **Places by service:**

  | Service | Kept | Count (within the access limits) |
  |---|---:|---:|
  | Food and resupply | 102,354 | 64,181 |
  | Accommodation | 29,007 | 24,773 |
  | Pharmacies | 7,919 | |
  | ATMs | 5,728 | |
  | Hospitals | 4,328 | |
  | Drinking water | 3,588 | |
  | Toilets | 2,149 | |
  | Bike shops | 1,928 | |
  | Stations and ferry terminals | 1,013 | 759 |
  | Repair stations | 160 | |

  The counted stations break down by bike policy as 645 yes, 56 limited and 58 unknown.

- **ECS services criteria:**
  - Accommodation, food and water, and accommodation choice pass on 100% of the length.
  - Cycle repair passes on 87%, toilets every 15 km on 90%.
  - Bikes on public transport pass on 81% at 150 km spacing and 57% at 75 km.
  - With these criteria added, the indicative **essential pass falls from 71% to 55%** and the important pass from 17% to 12%.

- **Longest gaps, whole route:**
  - Water (taps, or shops and cafés): 32 km.
  - Food: 51 km, in Cyprus between Polis and Kykkos (Troodos).
  - Accommodation: 45 km, so no gap finding.
  - Bike shop: 303 km, from Rijeka to Zadar over Velebit.

- **Bail-out:** 14 stretches over 100 km have no station known to carry bikes within 10 km. They are:
  - Spain, from Málaga to Águilas (Almería has few railways).
  - Catalonia, around L'Escala.
  - Provence, from Manosque to Draguignan.
  - Velebit.
  - Albania.
  - Epirus–Aitoloakarnania.
  - Rio–Perama.
  - İzmir–Çeşme.
  - From Selçuk to Cyprus. Cyprus has no railway, and buses are not modelled.

  The Rio–Perama stretch does have stations: the Corinth–Athens suburban line, which EuroVelo recommends. They don't count because no official Hellenic Train bike policy was found. Confirming that policy is the most useful next check for the ride.

- **Seasons are rarely published:**
  - Only 1.8% of accommodation and 11% of food places have opening hours or a season in OSM; Overture has none.
  - 69 of 1,670 counted campsites publish a season. In October, 13 are closed and 6 close mid-month, for example "Apr 14 – Oct 15".
  - So the seasonal-gap rule finds nothing yet. That's a data gap, not evidence that everything is open; the viewer says so.

## M3 Dream results (bundle 2026-10-16)

- **Climate:** 73 ERA5 points (2016–2025), one every 100 km, so every section has climate data. The first fetch took about 20 minutes through the CDS queue. Re-runs read the cache, and the Dream step then takes about a minute. `dream.json` is 0.6 MB.

- **Seasons look plausible** (averages over each country's sections):

  | Country | Sections | July max | July heat days | October max | October rain days | December daylight | October comfort | Best month |
  |---|---:|---:|---:|---:|---:|---:|---:|---|
  | Spain | 42 | 28.5 °C | 13% | 22.5 °C | 23% | 9.5 h | 86 | May |
  | France | 17 | 29.7 °C | 24% | 20.8 °C | 30% | 9.0 h | 81 | Sep |
  | Italy | 23 | 28.8 °C | 18% | 18.7 °C | 32% | 8.8 h | 79 | Oct |
  | Slovenia | 2 | 26.8 °C | 0% | 18.6 °C | 35% | 8.7 h | 76 | Jun |
  | Croatia | 20 | 27.5 °C | 7% | 18.7 °C | 32% | 8.9 h | 77 | Jun |
  | Montenegro | 7 | 28.6 °C | 13% | 19.5 °C | 33% | 9.1 h | 80 | Oct |
  | Albania | 11 | 30.5 °C | 29% | 22.0 °C | 31% | 9.3 h | 82 | Oct |
  | Greece | 15 | 31.0 °C | 37% | 22.2 °C | 26% | 9.5 h | 84 | Apr |
  | Türkiye | 8 | 29.7 °C | 22% | 22.1 °C | 13% | 9.5 h | 88 | May |
  | Cyprus | 7 | 31.2 °C | 34% | 25.9 °C | 12% | 9.8 h | 90 | Apr |


- **Crowding:**
  - August tourist nights are 1.7–3.5 times each country's monthly average (Croatia highest). In October they are below average everywhere except Spain, Türkiye and Cyprus.
  - School holidays: 2027 calendars exist only for France; the other countries use 2026. June–September have no data because OpenHolidays leaves out summer breaks. Montenegro, Greece, Türkiye and Cyprus have no holiday data.

- **Themes and remoteness:**
  - The top sections are sensible: coast on the Costa del Sol (sections 5–9); wine in Catalonia and Languedoc (35, 43–47); mountains from Nice to Ventimiglia, over Velebit and on the Dalmatian coast (59, 89–90, 100, 102).
  - Two sections are more than a quarter straight-line placeholder, so they have no data for mountains, climbing or steepest grade: 53, Manosque–Meyrargues (all 28 km), and 45, Leucate–Narbonne (12.5 of 38 km). Sampling the terrain along the straight line gave section 53 1,295 m of climbing, which says nothing about the real road.
  - The most remote stretches are around Almería and Murcia: up to 44 km more than 5 km from a village (Cabo de Gata – Carboneras).

- **Direction in October:** 108 of 152 sections are "either way"; 20 favour riding with the route and 24 against it.

- **Hard breaks** that matchmaker runs can't cross: the 32 km missing link from Monfalcone to Muggia, the ferries from Athens to Türkiye and from Türkiye to Cyprus, and two short missing links in Cyprus.

- **Acceptance case** ("7 days in October, Moderate, prefers cycle paths, coast and villages, train at both ends"): the top stretch is **Sagunt → Blanes** (sections 30–38). It is 462 km, at 66 km and 418 m of climbing a day, grade 3, with October comfort 82 and best time 84. Its "check yourself" list includes the places to stay that publish no opening season, and the summer school breaks missing from the data.

## Consequences for the engine

- Treat the GPX as the reference itinerary, but never as precise geometry. M1 map-matches it to OSM, and replaces straight-line segments with the matched or routed line (flagged as such).
- Gaps become typed components (ferry, rail link, missing) once matched against OSM `route=ferry` and rail data. A small curated file of gap classifications will back this up where the data can't decide; it starts with the two sea crossings above.
- Orientation must be inferred, not trusted.
- These defects are useful feedback for ECF (D5).
