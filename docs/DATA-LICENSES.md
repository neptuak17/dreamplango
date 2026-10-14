# Data licence register

Every source the system actually uses, with the attribution it requires. Planned sources and their licence notes are in [DESIGN.md](DESIGN.md) section 5. Add a row here when a source is first used in code.

| Source | Used by | Licence | Required attribution | Notes |
|---|---|---|---|---|
| **EuroVelo GPX tracks** (ECF / NECCs) | engine (`networks/eurovelo.py`), bundles, web viewer | ODbL 1.0; contents DbCL 1.0 | "Contains information from EuroVelo GPX tracks downloaded from www.EuroVelo.com on [DATE], which is made available here under the Open Database License (ODbL)." | Written per snapshot into `manifest.json → attribution` and shown in the map attribution. Share-alike applies to derived databases (DESIGN 5.10). "EuroVelo®" is an ECF registered trademark, so don't imply endorsement (D5). |
| **OpenStreetMap** (Geofabrik country extracts) | engine (`sources/osm.py`, `osmdata.py`), Valhalla tiles, audit layers | ODbL 1.0 | "© OpenStreetMap contributors" (manifest adds the extract date) | The audit layers (infrastructure, surface, traffic stress, network, gap types) are derived from OSM, so the bundle's layer data is an ODbL derivative database. Offer it under ODbL when used publicly. |
| **Copernicus DEM GLO-30** (AWS Open Data) | engine (`sources/dem.py`): elevation, gradients, climbs | Copernicus DEM licence: free, incl. commercial use | "Produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved" | It is a surface model, so trees and buildings are smoothed out and bridges and tunnels interpolated. |
| **Valhalla** (software) | map matching (Docker `ghcr.io/valhalla/valhalla-scripted`) | MIT | none required for outputs; credited in the manifest | Software, not data. |
| **OpenFreeMap basemap** (OpenMapTiles schema, OpenStreetMap data) | web viewer basemap | OSM data ODbL; OpenMapTiles schema CC BY 4.0; OpenFreeMap public instance free, no key | "OpenFreeMap © OpenMapTiles Data from OpenStreetMap" | Supplied by the style and shown automatically. For production, consider self-hosted tiles (Protomaps/OpenFreeMap on R2). |

## Attribution in practice

- The engine stores the attribution string with each source snapshot and copies the unique strings into every bundle manifest (`manifest.attribution`).
- Clients must display every `manifest.attribution` entry wherever bundle data is shown. The web viewer passes them to the map's attribution control.
