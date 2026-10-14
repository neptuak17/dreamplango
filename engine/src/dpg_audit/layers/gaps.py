"""Classify the gaps between published sections: ferry, public-transport link, small discontinuity or missing."""

from dataclasses import dataclass

from dpg_audit.lrs.geodesy import distance
from dpg_audit.models import Component, ComponentKind, GapType

DISCONTINUITY_M = 300.0
"""Breaks shorter than this are treated as digitising noise."""
SMALL_GAP_M = 2_000.0
FERRY_REACH_M = 2_500.0
"""A ferry route counts if one terminal lies this close to each end of the gap."""
STATION_REACH_M = 3_000.0


@dataclass
class CuratedGap:
    after_section: int
    type: GapType
    note: str


def _d(a: tuple[float, float], b: tuple[float, float]) -> float:
    return distance(a[0], a[1], b[0], b[1])


def _ferry_connects(coords: list[tuple[float, float]], a: tuple[float, float], b: tuple[float, float]) -> bool:
    """True if the ferry's two terminals sit at the two ends of the gap (in either direction).

    Checking terminals, not just proximity to the line, avoids matching a coastal ferry that merely passes by.
    """
    if len(coords) < 2:
        return False
    s, e = coords[0], coords[-1]
    return (_d(a, s) <= FERRY_REACH_M and _d(b, e) <= FERRY_REACH_M) or (
        _d(a, e) <= FERRY_REACH_M and _d(b, s) <= FERRY_REACH_M
    )


def _nearest_station(lonlat: tuple[float, float], stations: list[dict]) -> tuple[float, dict | None]:
    best, best_s = float("inf"), None
    for s in stations:
        if abs(s["lat"] - lonlat[1]) > 0.1 or abs(s["lon"] - lonlat[0]) > 0.15:
            continue
        d = distance(lonlat[0], lonlat[1], s["lon"], s["lat"])
        if d < best:
            best, best_s = d, s
    return best, best_s


def classify_gaps(
    components: list[Component], ferries: list[dict], stations: list[dict], curated: list[CuratedGap]
) -> list[dict]:
    """Set gap_type/basis/confidence on gap components in place; return a note per gap for the findings."""
    by_after = {c.after_section: c for c in curated}
    notes = []
    for i, comp in enumerate(components):
        if comp.kind != ComponentKind.GAP:
            continue
        before = next((c for c in reversed(components[:i]) if c.kind == ComponentKind.RIDE), None)
        after = next((c for c in components[i + 1 :] if c.kind == ComponentKind.RIDE), None)
        after_section = before.daily_section if before else None
        straight = comp.straight_distance_m or 0.0
        note: dict = {"from_section": after_section, "to_section": after.daily_section if after else None}

        ferry = None
        if straight >= DISCONTINUITY_M:
            ferry = next((f for f in ferries if _ferry_connects(f["coords"], comp.start, comp.end)), None)
        d0, s0 = _nearest_station(comp.start, stations)
        d1, s1 = _nearest_station(comp.end, stations)

        if straight < DISCONTINUITY_M:
            comp.gap_type, comp.gap_basis, comp.gap_confidence = GapType.DISCONTINUITY, "distance", "high"
        elif ferry is not None:
            comp.gap_type, comp.gap_basis, comp.gap_confidence = GapType.FERRY, "osm_ferry_route", "high"
            note["ferry"] = ferry.get("name") or f"OSM way {ferry['id']}"
        elif after_section in by_after:
            cur = by_after[after_section]
            comp.gap_type, comp.gap_basis, comp.gap_confidence = cur.type, "curated", "medium"
            note["curated_note"] = cur.note
        elif d0 <= STATION_REACH_M and d1 <= STATION_REACH_M and straight > SMALL_GAP_M:
            comp.gap_type, comp.gap_basis, comp.gap_confidence = GapType.PUBLIC_TRANSPORT, "rail_stations_nearby", "low"
            note["stations"] = [s0.get("name") if s0 else None, s1.get("name") if s1 else None]
        elif straight <= SMALL_GAP_M:
            comp.gap_type, comp.gap_basis, comp.gap_confidence = GapType.DISCONTINUITY, "distance", "medium"
        else:
            comp.gap_type, comp.gap_basis, comp.gap_confidence = GapType.MISSING, "no_ferry_or_rail_found", "medium"
        note["component"] = comp.id
        notes.append(note)
    return notes
