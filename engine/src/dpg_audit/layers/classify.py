"""Classify one matched way (OSM tags + Valhalla edge attributes) into the audit's layer values.

These rules are version 0 heuristics, deliberately simple and readable so they can be tuned against field checks.
Every function returns (value, confidence, detail).
"""

import re
from typing import Any

from dpg_audit.models import LayerInfo, LayerValue

Result = tuple[str, str, dict[str, Any]]

CAR_FREE = {"cycleway", "path", "footway", "pedestrian", "bridleway", "steps", "corridor"}
NO_MOTOR = {"no", "private", "agricultural", "forestry", "destination;agricultural", "permit", "delivery"}
ROAD_CLASSES = {
    "motorway",
    "motorway_link",
    "trunk",
    "trunk_link",
    "primary",
    "primary_link",
    "secondary",
    "secondary_link",
    "tertiary",
    "tertiary_link",
    "unclassified",
    "residential",
    "living_street",
    "service",
    "track",
    "road",
}

# Default speed (km/h) when maxspeed is missing, by highway class. Rural values on purpose: most of EV8 is rural,
# and assuming the faster limit errs towards flagging traffic stress rather than hiding it.
DEFAULT_SPEED = {
    "motorway": 120,
    "trunk": 100,
    "primary": 90,
    "secondary": 90,
    "tertiary": 70,
    "unclassified": 60,
    "residential": 50,
    "living_street": 20,
    "service": 30,
    "track": 30,
    "road": 50,
}
URBAN_DENSITY = 8
"""Valhalla edge density (0-15) from which an untagged road is treated as urban."""
URBAN_SPEED = 50
URBAN_DEFAULT_CLASSES = {"primary", "secondary", "tertiary", "unclassified", "residential", "road"}
_ZONE_SPEED = {
    "urban": 50,
    "rural": 90,
    "zone30": 30,
    "zone:30": 30,
    "living_street": 20,
    "walk": 10,
    "trunk": 100,
    "motorway": 120,
}


def _highway(tags: dict[str, str]) -> str:
    return tags.get("highway", "")


def _base_class(hw: str) -> str:
    return hw.removesuffix("_link")


def parse_maxspeed(value: str | None) -> int | None:
    """'50' -> 50, '30 mph' -> 48, 'FR:urban' -> 50, 'none'/'signals' -> None."""
    if not value:
        return None
    v = value.strip().lower()
    m = re.match(r"^(\d+(?:\.\d+)?)\s*(mph)?", v)
    if m:
        speed = float(m.group(1))
        return round(speed * 1.609) if m.group(2) else round(speed)
    if ":" in v:
        return _ZONE_SPEED.get(v.split(":", 1)[1])
    return None


def _cycleway_values(tags: dict[str, str]) -> set[str]:
    return {v for k, v in tags.items() if k in ("cycleway", "cycleway:both", "cycleway:right", "cycleway:left")}


def _motor_allowed(tags: dict[str, str]) -> bool:
    return all(tags.get(key) not in NO_MOTOR for key in ("motor_vehicle", "motorcar", "vehicle", "access"))


def traffic_stress(tags: dict[str, str], edge: dict[str, Any]) -> Result:
    """Level of Traffic Stress, 1 (anyone) .. 4 (strong and fearless only); 'na' for ferries; 'unknown'."""
    hw = _highway(tags)
    if edge.get("use") == "ferry" or tags.get("route") == "ferry":
        return "na", "high", {"reason": "ferry"}
    if not hw:
        return "unknown", "low", {}
    cls = _base_class(hw)
    if hw in CAR_FREE:
        return "1", "high", {"reason": "car-free path"}
    if cls == "track" and not _motor_allowed(tags):
        return "1", "high", {"reason": "track closed to motor traffic"}
    cyc = _cycleway_values(tags)
    if cyc & {"track", "separate"} or edge.get("cycle_lane") == "separated":
        return "1", "medium", {"reason": "separated cycle track"}
    if cls == "living_street" or tags.get("bicycle_road") == "yes" or tags.get("cyclestreet") == "yes":
        return "1", "high", {"reason": "living street / cycle street"}
    tagged = parse_maxspeed(tags.get("maxspeed"))
    # Untagged roads in built-up areas (Valhalla road density) get the urban default instead of the rural one.
    urban = (edge.get("density") or 0) >= URBAN_DENSITY
    default = URBAN_SPEED if urban and cls in URBAN_DEFAULT_CLASSES else DEFAULT_SPEED.get(cls)
    speed = tagged or default
    if speed is None:
        return "unknown", "low", {}
    try:
        lanes = int(tags.get("lanes", "0").split(";")[0]) or None
    except ValueError:
        lanes = None
    painted = bool(cyc & {"lane", "opposite_lane"}) or edge.get("cycle_lane") == "dedicated"
    # A paved shoulder gives riders space on fast rural roads (Valhalla flag, or the OSM shoulder tag).
    shoulder = bool(edge.get("shoulder")) or tags.get("shoulder") in ("yes", "both", "left", "right")
    source = "tagged" if tagged else ("urban default" if urban and default == URBAN_SPEED else "default")
    detail = {"speed": speed, "speed_source": source, "lanes": lanes, "lane": painted, "shoulder": shoulder}
    conf = "medium" if tagged else "low"

    if cls in ("motorway", "trunk") or ((lanes or 0) >= 4 and speed >= 50):
        lts = 4
    elif cls in ("residential", "service", "unclassified", "track", "road"):
        if speed <= 30:
            lts = 1
        elif speed <= 50:
            lts = 2
        elif cls in ("unclassified", "track"):
            lts = 2 if speed <= 60 else 3  # minor rural roads: usually light traffic, but fast
        else:
            lts = 3
    elif cls == "tertiary":
        if speed <= 30:
            lts = 2
        elif speed <= 50:
            lts = 2 if painted else 3
        else:
            lts = 3
    elif cls == "secondary":
        lts = 3 if speed <= 50 or ((painted or shoulder) and speed <= 90) else 4
    elif cls == "primary":
        # Main roads through towns at 50 km/h or less are LTS 3 in mixed traffic (2 with a cycle lane); out of
        # town they are LTS 4 unless a shoulder or lane gives space at moderate speed.
        if speed <= 50:
            lts = 2 if painted and speed <= 30 else 3
        else:
            lts = 3 if (shoulder and speed <= 70) or (painted and speed <= 60) else 4
    else:
        return "unknown", "low", detail
    return str(lts), conf, detail


def infrastructure(tags: dict[str, str], edge: dict[str, Any], lts: str) -> Result:
    hw = _highway(tags)
    if edge.get("use") == "ferry" or tags.get("route") == "ferry":
        return "ferry", "high", {}
    if hw == "steps":
        return "steps", "high", {}
    if hw == "cycleway" or (hw == "path" and tags.get("bicycle") == "designated"):
        return "cycleway", "high", {}
    if hw in CAR_FREE or (_base_class(hw) == "track" and not _motor_allowed(tags)):
        return "shared_path", "high", {"highway": hw}
    if _cycleway_values(tags) & {"track", "separate"} or edge.get("cycle_lane") == "separated":
        return "separated_track", "medium", {"highway": hw}
    if _cycleway_values(tags) & {"lane", "opposite_lane"} or edge.get("cycle_lane") == "dedicated":
        return "cycle_lane", "medium", {"highway": hw}
    if hw in ROAD_CLASSES:
        value = {"1": "quiet_road", "2": "quiet_road", "3": "road", "4": "busy_road"}.get(lts, "road")
        return value, "medium", {"highway": hw}
    return "unknown", "low", {"highway": hw}


_SURFACE = {
    "paved_smooth": {"asphalt", "concrete", "concrete:lanes", "chipseal", "paved", "metal", "tartan"},
    "paved_rough": {
        "paving_stones",
        "sett",
        "cobblestone",
        "unhewn_cobblestone",
        "concrete:plates",
        "bricks",
        "grass_paver",
        "paving_stones:30",
    },
    "compacted": {"compacted", "fine_gravel"},
    "gravel": {"gravel", "pebblestone", "rock", "unpaved", "shells"},
    "dirt": {"dirt", "earth", "ground", "mud", "sand", "grass", "woodchips", "soil"},
}
_SURFACE_OF = {tag: cls for cls, tags in _SURFACE.items() for tag in tags}
_ROUGH_SMOOTHNESS = {"bad", "very_bad", "horrible", "very_horrible", "impassable"}
_TRACKTYPE = {"grade1": "paved_smooth", "grade2": "compacted", "grade3": "gravel", "grade4": "dirt", "grade5": "dirt"}
_LIKELY_PAVED = {
    "motorway",
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "unclassified",
    "residential",
    "living_street",
    "cycleway",
}


def surface(tags: dict[str, str], edge: dict[str, Any]) -> Result:
    if edge.get("use") == "ferry" or tags.get("route") == "ferry":
        return "na", "high", {}
    raw = tags.get("surface", "").split(";")[0].strip()
    smooth = tags.get("smoothness")
    if raw in _SURFACE_OF:
        value = _SURFACE_OF[raw]
        if value == "paved_smooth" and smooth in _ROUGH_SMOOTHNESS:
            value = "paved_rough"
        return value, "high", {"surface": raw, "smoothness": smooth}
    if tags.get("tracktype") in _TRACKTYPE:
        return _TRACKTYPE[tags["tracktype"]], "medium", {"tracktype": tags["tracktype"]}
    if _base_class(_highway(tags)) in _LIKELY_PAVED:
        return "paved_assumed", "low", {"highway": _highway(tags)}
    return "unknown", "low", {"highway": _highway(tags), "surface": raw or None}


_EV_RE = re.compile(r"^(?:ev|eurovelo)\s*0*(\d+)$", re.I)


def eurovelo_number(ref: str) -> int | None:
    """'EV8', 'EV 8', 'EuroVelo 8' -> 8."""
    m = _EV_RE.match(ref.strip())
    return int(m.group(1)) if m else None


def cycle_network(networks: set[tuple[str, str]], ev_number: int | None) -> Result:
    """Which waymarked cycle network (per OSM route relations) the way belongs to; the highest level wins."""
    if ev_number is not None and any(eurovelo_number(ref) == ev_number for _, ref in networks):
        return "eurovelo_route", "medium", {}
    levels = {net for net, _ in networks}
    for net, value in (("icn", "international"), ("ncn", "national"), ("rcn", "regional"), ("lcn", "local")):
        if net in levels:
            return value, "medium", {"refs": sorted(ref for n, ref in networks if n == net)[:3]}
    return "none", "medium", {}


LAYERS = [
    LayerInfo(
        id="infrastructure",
        title="Infrastructure",
        description="What you ride on: car-free paths, cycle facilities, or roads shared with traffic.",
        source="OpenStreetMap via Valhalla map matching",
        values=[
            LayerValue(id="cycleway", label="Cycle path"),
            LayerValue(id="shared_path", label="Car-free path (shared)"),
            LayerValue(id="separated_track", label="Separated cycle track"),
            LayerValue(id="cycle_lane", label="Painted cycle lane"),
            LayerValue(id="quiet_road", label="Quiet road"),
            LayerValue(id="road", label="Road with traffic"),
            LayerValue(id="busy_road", label="Busy road"),
            LayerValue(id="steps", label="Steps"),
            LayerValue(id="ferry", label="Ferry"),
            LayerValue(id="unmatched", label="Not matched to the map"),
            LayerValue(id="unknown", label="Unknown"),
        ],
    ),
    LayerInfo(
        id="traffic_stress",
        title="Traffic stress",
        description="Level of Traffic Stress (LTS) estimated from road class, speed limit, lanes and cycle "
        "facilities. 1 = comfortable for anyone, 4 = only for confident riders. Speeds are often defaults.",
        source="OpenStreetMap tags (heuristic v0)",
        values=[
            LayerValue(id="1", label="LTS 1 – car-free or very calm"),
            LayerValue(id="2", label="LTS 2 – calm"),
            LayerValue(id="3", label="LTS 3 – moderate traffic"),
            LayerValue(id="4", label="LTS 4 – heavy or fast traffic"),
            LayerValue(id="na", label="Not applicable (ferry)"),
            LayerValue(id="unmatched", label="Not matched to the map"),
            LayerValue(id="unknown", label="Unknown"),
        ],
    ),
    LayerInfo(
        id="surface",
        title="Surface",
        description="Riding surface from OSM surface/smoothness/tracktype tags. 'Paved (assumed)' means the "
        "road is untagged but of a class that is almost always paved.",
        source="OpenStreetMap tags",
        values=[
            LayerValue(id="paved_smooth", label="Paved, smooth"),
            LayerValue(id="paved_assumed", label="Paved (assumed)"),
            LayerValue(id="paved_rough", label="Paved, rough (cobbles, setts)"),
            LayerValue(id="compacted", label="Compacted gravel"),
            LayerValue(id="gravel", label="Loose gravel / unpaved"),
            LayerValue(id="dirt", label="Dirt, sand or grass"),
            LayerValue(id="na", label="Not applicable (ferry)"),
            LayerValue(id="unmatched", label="Not matched to the map"),
            LayerValue(id="unknown", label="Unknown"),
        ],
    ),
    LayerInfo(
        id="cycle_network",
        title="Waymarked network (OSM)",
        description="Whether the track runs on a waymarked cycle route mapped in OSM: a proxy for signage on the "
        "ground. 'EuroVelo route' means a relation for this EuroVelo route itself.",
        source="OpenStreetMap route relations",
        values=[
            LayerValue(id="eurovelo_route", label="On this EuroVelo route (OSM)"),
            LayerValue(id="international", label="Other international route"),
            LayerValue(id="national", label="National route"),
            LayerValue(id="regional", label="Regional route"),
            LayerValue(id="local", label="Local route"),
            LayerValue(id="none", label="Not on a mapped cycle route"),
            LayerValue(id="unmatched", label="Not matched to the map"),
        ],
    ),
    LayerInfo(
        id="gradient",
        title="Gradient",
        description="Average gradient over 100 m in the direction of travel, from the smoothed terrain model.",
        source="Copernicus DEM GLO-30",
        values=[
            LayerValue(id="flat", label="Flat (< 2%)"),
            LayerValue(id="gentle", label="Gentle (2–4%)"),
            LayerValue(id="moderate", label="Moderate (4–6%)"),
            LayerValue(id="steep", label="Steep (6–8%)"),
            LayerValue(id="very_steep", label="Very steep (8–10%)"),
            LayerValue(id="extreme", label="Extreme (≥ 10%)"),
            LayerValue(id="unknown", label="Unknown"),
        ],
    ),
]
