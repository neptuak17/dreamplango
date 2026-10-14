"""Read what the audit needs from the corridor OSM extract (pyosmium; osmium-tool for pre-filtering)."""

import subprocess
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

import osmium

WAY_TAG_KEYS = {
    "highway",
    "surface",
    "smoothness",
    "tracktype",
    "bicycle",
    "motor_vehicle",
    "motorcar",
    "access",
    "vehicle",
    "maxspeed",
    "lanes",
    "oneway",
    "segregated",
    "lit",
    "width",
    "bridge",
    "tunnel",
    "name",
    "ref",
    "route",
    "foot",
    "service",
    "junction",
    "sac_scale",
    "mtb:scale",
    "incline",
    "cyclestreet",
    "bicycle_road",
    "shoulder",
}
"""Way tags kept for classification. Any key starting with `cycleway` is kept as well."""


@dataclass
class RouteRelation:
    id: int
    network: str | None
    ref: str | None
    name: str | None
    ways: list[int] = field(default_factory=list)
    children: list[int] = field(default_factory=list)


@dataclass
class OsmData:
    way_tags: dict[int, dict[str, str]]
    way_networks: dict[int, set[tuple[str, str]]]
    """way id -> {(network, ref)} of every bicycle route relation (incl. parents) the way belongs to."""
    ferries: list[dict]
    """route=ferry ways: {id, name, coords:[(lon,lat)...]}"""
    stations: list[dict]
    """rail stations and halts: {id, name, lon, lat}"""


def _keep_tags(tags) -> dict[str, str]:
    return {t.k: t.v for t in tags if t.k in WAY_TAG_KEYS or t.k.startswith("cycleway")}


def read_ways_and_routes(pbf: Path, way_ids: set[int]) -> tuple[dict[int, dict[str, str]], dict[int, RouteRelation]]:
    tags: dict[int, dict[str, str]] = {}
    routes: dict[int, RouteRelation] = {}
    for obj in osmium.FileProcessor(str(pbf), osmium.osm.WAY | osmium.osm.RELATION):
        if obj.is_way():
            if obj.id in way_ids:
                tags[obj.id] = _keep_tags(obj.tags)
        elif obj.tags.get("route") in ("bicycle", "mtb") or obj.tags.get("type") == "superroute":
            if obj.tags.get("route", "bicycle") == "mtb":
                continue
            rel = RouteRelation(obj.id, obj.tags.get("network"), obj.tags.get("ref"), obj.tags.get("name"))
            for m in obj.members:
                if m.type == "w":
                    rel.ways.append(m.ref)
                elif m.type == "r":
                    rel.children.append(m.ref)
            routes[obj.id] = rel
    return tags, routes


def way_networks(routes: dict[int, RouteRelation]) -> dict[int, set[tuple[str, str]]]:
    """Propagate each relation's (network, ref) down to the ways of it and all its member relations."""
    out: dict[int, set[tuple[str, str]]] = defaultdict(set)
    for rel in routes.values():
        label = (rel.network or "", rel.ref or rel.name or "")
        seen: set[int] = set()
        stack = [rel.id]
        while stack:
            rid = stack.pop()
            if rid in seen or rid not in routes:
                continue
            seen.add(rid)
            child = routes[rid]
            for w in child.ways:
                out[w].add(label)
            stack.extend(child.children)
    return out


def read_transport(pbf: Path, work: Path) -> tuple[list[dict], list[dict]]:
    """Ferry routes and rail stations, via a small pre-filtered file read with node locations."""
    small = work / "transport.osm.pbf"
    subprocess.run(
        [
            "osmium",
            "tags-filter",
            "--overwrite",
            str(pbf),
            "w/route=ferry",
            "n/railway=station,halt",
            "n/public_transport=station",
            "-o",
            str(small),
        ],
        check=True,
        capture_output=True,
    )
    ferries, stations = [], []
    for obj in osmium.FileProcessor(str(small)).with_locations():
        if obj.is_way() and obj.tags.get("route") == "ferry":
            coords = [(n.lon, n.lat) for n in obj.nodes if n.location.valid()]
            if len(coords) >= 2:
                ferries.append({"id": obj.id, "name": obj.tags.get("name"), "coords": coords})
        elif obj.is_node() and (obj.tags.get("railway") in ("station", "halt") or obj.tags.get("train") == "yes"):
            stations.append({"id": obj.id, "name": obj.tags.get("name"), "lon": obj.lon, "lat": obj.lat})
    return ferries, stations


def load(pbf: Path, way_ids: set[int], work: Path) -> OsmData:
    tags, routes = read_ways_and_routes(pbf, way_ids)
    ferries, stations = read_transport(pbf, work)
    return OsmData(way_tags=tags, way_networks=way_networks(routes), ferries=ferries, stations=stations)
