"""Turn matched pieces plus OSM tags into merged layer events on the route's measure axis."""

from collections import Counter
from dataclasses import dataclass, field

from dpg_audit.layers import classify
from dpg_audit.lrs import RoutePath
from dpg_audit.match.matcher import LineMatch
from dpg_audit.models import Event
from dpg_audit.osmdata import OsmData

MATCHED_LAYERS = ("infrastructure", "traffic_stress", "surface", "cycle_network")
_CONF_RANK = {"low": 0, "medium": 1, "high": 2}
_STRUCTURE = {
    "bridge": {"yes", "viaduct", "boardwalk", "aqueduct", "cantilever", "movable", "suspension"},
    "tunnel": {"yes", "building_passage", "culvert", "avalanche_protector"},
}


@dataclass
class _Run:
    from_m: float
    to_m: float
    value: str
    confidence: str
    ways: Counter = field(default_factory=Counter)
    approx_m: float = 0.0
    detail: dict = field(default_factory=dict)


@dataclass
class MatchedLayers:
    events: list[Event]
    structures: list[tuple[float, float]]
    """Bridges and tunnels as (from_m, to_m): the DEM is not trusted there."""
    unmatched_m: float
    approx_m: float


def build_matched_layers(
    path: RoutePath, matches: list[LineMatch], osm: OsmData, ev_number: int | None
) -> MatchedLayers:
    runs: dict[str, list[_Run]] = {layer: [] for layer in MATCHED_LAYERS}
    structures: list[tuple[float, float]] = []
    unmatched = approx = 0.0

    def push(layer: str, m0: float, m1: float, value: str, conf: str, way: int | None, is_approx: bool, detail):
        seq = runs[layer]
        last = seq[-1] if seq else None
        if last and last.value == value and abs(last.to_m - m0) < 1e-6:
            last.to_m = m1
            last.confidence = min(last.confidence, conf, key=_CONF_RANK.__getitem__)
        else:
            last = _Run(m0, m1, value, conf, detail=dict(detail))
            seq.append(last)
        if way is not None:
            last.ways[way] += m1 - m0
        if is_approx:
            last.approx_m += m1 - m0

    for part, match in zip(path.parts, matches, strict=True):
        for piece in match.pieces:
            m0, m1 = part.from_m + piece.from_m, part.from_m + piece.to_m
            if m1 - m0 <= 0:
                continue
            if piece.edge is None:
                unmatched += m1 - m0
                for layer in MATCHED_LAYERS:
                    push(layer, m0, m1, "unmatched", "high", None, False, {})
                continue
            way = piece.edge.get("way_id")
            tags = osm.way_tags.get(way, {})
            if piece.approx:
                approx += m1 - m0
            lts, lts_conf, lts_detail = classify.traffic_stress(tags, piece.edge)
            values = {
                "traffic_stress": (lts, lts_conf, {}),
                "infrastructure": classify.infrastructure(tags, piece.edge, lts),
                "surface": classify.surface(tags, piece.edge),
                "cycle_network": classify.cycle_network(osm.way_networks.get(way, set()), ev_number),
            }
            for layer, (value, conf, _) in values.items():
                if piece.approx:
                    conf = "low"
                push(layer, m0, m1, value, conf, way, piece.approx, {})
            if (
                tags.get("bridge") in _STRUCTURE["bridge"]
                or tags.get("tunnel") in _STRUCTURE["tunnel"]
                or (piece.edge.get("bridge") or piece.edge.get("tunnel"))
            ):
                if structures and abs(structures[-1][1] - m0) < 1e-6:
                    structures[-1] = (structures[-1][0], m1)
                else:
                    structures.append((m0, m1))

    events: list[Event] = []
    for layer, seq in runs.items():
        for r in seq:
            detail = {}
            if r.ways:
                top = [w for w, _ in r.ways.most_common(5)]
                detail["ways"] = top
                names = []
                for w in top:
                    tags = osm.way_tags.get(w, {})
                    label = tags.get("ref") or tags.get("name")
                    if label and label not in names:
                        names.append(label)
                if names:
                    detail["names"] = names[:3]
            if r.approx_m:
                detail["approx_share"] = round(r.approx_m / (r.to_m - r.from_m), 2)
            events.append(
                Event(
                    layer=layer,
                    from_m=round(r.from_m, 1),
                    to_m=round(r.to_m, 1),
                    value=r.value,
                    confidence=r.confidence,
                    detail=detail,
                )
            )
    return MatchedLayers(events=events, structures=structures, unmatched_m=unmatched, approx_m=approx)
