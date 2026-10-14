# Data licence register

Every source the system actually uses, with the attribution it requires. Planned sources and their licence notes are in [DESIGN.md](DESIGN.md) section 5. Add a row here when a source is first used in code.

| Source | Used by | Licence | Required attribution | Notes |
|---|---|---|---|---|
| **EuroVelo GPX tracks** (ECF / NECCs) | engine (`networks/eurovelo.py`), bundles, web viewer | ODbL 1.0; contents DbCL 1.0 | "Contains information from EuroVelo GPX tracks downloaded from www.EuroVelo.com on [DATE], which is made available here under the Open Database License (ODbL)." | Written per snapshot into `manifest.json → attribution` and shown in the map attribution. Share-alike applies to derived databases (DESIGN 5.10). "EuroVelo®" is an ECF registered trademark, so don't imply endorsement (D5). |
| **OpenFreeMap basemap** (OpenMapTiles schema, OpenStreetMap data) | web viewer basemap | OSM data ODbL; OpenMapTiles schema CC BY 4.0; OpenFreeMap public instance free, no key | "OpenFreeMap © OpenMapTiles Data from OpenStreetMap" | Supplied by the style and shown automatically. For production, consider self-hosted tiles (Protomaps/OpenFreeMap on R2). |

## Attribution in practice

- The engine stores the attribution string with each source snapshot (`raw/<network>/<ref>/<date>/source.json`) and copies it into every bundle manifest.
- Clients must display every `manifest.attribution` entry wherever bundle data is shown. The web viewer passes them to the map's attribution control.
