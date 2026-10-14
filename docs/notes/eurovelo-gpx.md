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

## Consequences for the engine

- Treat the GPX as the reference itinerary, but never as precise geometry. M1 map-matches it to OSM, and replaces straight-line segments with the matched or routed line (flagged as such).
- Gaps become typed components (ferry, rail link, missing) once matched against OSM `route=ferry` and rail data. A small curated file of gap classifications will back this up where the data can't decide; it starts with the two sea crossings above.
- Orientation must be inferred, not trusted.
- These defects are useful feedback for ECF (D5).
