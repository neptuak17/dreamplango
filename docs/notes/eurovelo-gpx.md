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

The "likely" column is a guess to check in M1 against OSM ferry routes and rail. It has not been verified.

| After section | Straight-line | Where | Likely |
|---|---:|---|---|
| 40 | 1.2 km | Sant Feliu de Guíxols | digitising gap |
| 60 | 45.7 km | Ventimiglia → Limone | missing track or rail link over the Col de Tende |
| 70 | 1.5 km | Cremona | digitising gap |
| 75 | 4.7 km | Chioggia → Pellestrina | lagoon ferry |
| 76 | 1.2 km | Santa Maria del Mare → Alberoni | lagoon ferry |
| 77 | 5.5 km | Lido di Venezia → Jesolo side | lagoon ferry |
| 82 | 32.4 km | Monfalcone → Muggia (Trieste) | missing track or ferry |
| 101 | 14.2 km | Ploče → Trpanj | ferry |
| 137 | 302 km | Athens → Dikili (Türkiye) | **ferry**, very likely (owner's assessment): the gap crosses the Aegean. There seems to be no direct sailing, so probably via an island such as Lesvos to Dikili or Ayvalık. Exact route and season to confirm in M1. |
| 145 | 621 km | Selçuk → Nicosia (Cyprus) | **ferry**, very likely (owner's assessment): the gap crosses the sea. Türkiye–Cyprus ferries appear to sail from the south coast (e.g. Taşucu or Mersin to northern Cyprus), so this probably also involves a long overland transfer, plus a crossing of the line dividing Cyprus to reach Nicosia. To confirm in M1. |
| 146, 148, 150 | 1.2, 4.1, 4.8 km | Cyprus loop | digitising gaps or missing links |

There are also 15 breaks shorter than 1 km, mostly under 300 m (info level).

## Consequences for the engine

- Treat the GPX as the reference itinerary, but never as precise geometry. M1 map-matches it to OSM, and replaces straight-line segments with the matched or routed line (flagged as such).
- Gaps become typed components (ferry, rail link, missing) once matched against OSM `route=ferry` and rail data. A small curated file of gap classifications will back this up where the data can't decide; it starts with the two sea crossings above.
- Orientation must be inferred, not trusted.
- These defects are useful feedback for ECF (D5).
