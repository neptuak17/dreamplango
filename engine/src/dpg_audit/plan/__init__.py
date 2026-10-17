"""Plan data (M4, DESIGN.md 11.6): what the rider-side planner needs from the audit, written as bundle files.

- `stops.json`: candidate overnight stops, counts only (free, D45);
- `effort.json`: elevation and surface along the route, and its gaps (free, D45);
- `highlights.json`: things worth seeing near the route;
- `calendar.json` (built with Dream's holiday sources): public and school holiday dates per country.
"""

from dpg_audit.plan.effort import build_effort
from dpg_audit.plan.highlights import build_highlights
from dpg_audit.plan.stops import build_stops

__all__ = ["build_effort", "build_highlights", "build_stops"]
