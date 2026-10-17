"""The pace model's input (11.6): elevation and surface along the route every 100 m, and the gaps between parts.

Elevation is the audit's own (smoothed DEM, bridges and tunnels interpolated). Where M1 leaves the terrain out of the
climbing figures (long straight-line placeholders, D37), it is null here too, so the planner shows "at least" rather
than timing a road nobody has measured. Surfaces use the same three classes as Dream (D36), plus unknown and ferry.
"""

from bisect import bisect_right

import numpy as np

from dpg_audit.build import RouteBuild
from dpg_audit.dream.pipeline import GRAVEL, NOT_KNOWN, PATHS
from dpg_audit.layers import elevation
from dpg_audit.models import ComponentKind, EffortFile, EffortGap, EffortPart, Event

STEP_M = 100.0


class _Values:
    def __init__(self, events: list[Event]):
        self.events = sorted(events, key=lambda e: e.from_m)
        self.starts = [e.from_m for e in self.events]

    def at(self, m: float) -> str | None:
        i = bisect_right(self.starts, m) - 1
        if i >= 0 and self.events[i].from_m <= m < self.events[i].to_m:
            return self.events[i].value
        return None


def surface_letter(infra: str | None, surface: str | None) -> str:
    """The D36 class of one piece of route, as in Dream's surface shares."""
    if infra == "ferry":
        return "f"
    if surface in GRAVEL:
        return "g"
    if infra in PATHS:
        return "c"
    if infra is None or infra in NOT_KNOWN:
        return "u"
    return "r"


def _inside(ranges: list[tuple[float, float]], m: float) -> bool:
    return any(a <= m <= b for a, b in ranges)


def build_effort(
    build: RouteBuild,
    profs: list[elevation.PartProfile],
    events: list[Event],
    unknown: list[tuple[float, float]],
    step_m: float = STEP_M,
) -> EffortFile:
    """`unknown`: path ranges whose terrain M1 leaves out (elevation.unknown_terrain)."""
    infra = _Values([e for e in events if e.layer == "infrastructure"])
    surface = _Values([e for e in events if e.layer == "surface"])
    parts = []
    for part in build.path.parts:
        ms = np.append(np.arange(part.from_m, part.to_m, step_m), part.to_m)
        ele = elevation.at(profs, ms)
        heights: list[int | None] = [
            None if np.isnan(e) or _inside(unknown, float(m)) else round(float(e)) for m, e in zip(ms, ele, strict=True)
        ]
        letters = []
        for a, b in zip(ms[:-1], ms[1:], strict=True):
            mid = float((a + b) / 2)
            letters.append(surface_letter(infra.at(mid), surface.at(mid)))
        parts.append(
            EffortPart(from_m=round(part.from_m, 1), to_m=round(part.to_m, 1), ele=heights, surface="".join(letters))
        )
    gaps = []
    rides = [c for c in build.components if c.kind == ComponentKind.RIDE]
    for c in build.components:
        if c.kind != ComponentKind.GAP:
            continue
        before = next((r for r in reversed(rides) if r.to_m <= c.from_m + 1e-6), None)
        gaps.append(
            EffortGap(
                at_m=round(c.from_m, 1),
                after_section=before.daily_section if before else None,
                type=c.gap_type.value if c.gap_type else "unclassified",
                straight_distance_m=round(c.straight_distance_m or 0.0),
                basis=c.gap_basis,
                confidence=c.gap_confidence,
            )
        )
    return EffortFile(step_m=step_m, parts=parts, gaps=gaps)
