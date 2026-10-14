"""Service places from the corridor OSM extract: nodes, ways and multipolygon areas (centroids)."""

import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import osmium
from shapely.geometry import MultiPolygon, Polygon

from dpg_audit.services.catalog import OSM_FILTERS, classify_osm

KEEP_TAGS = (
    "name",
    "name:en",
    "brand",
    "operator",
    "network",
    "opening_hours",
    "seasonal",
    "website",
    "contact:website",
    "phone",
    "contact:phone",
    "stars",
    "capacity",
    "tents",
    "backcountry",
    "fee",
    "drinking_water",
    "service:bicycle:repair",
    "service:bicycle:retail",
    "emergency",
    "atm",
    "train",
    "station",
    "railway",
    "uic_ref",
    "addr:country",
    "check_date",
)


@dataclass
class RawPlace:
    source: str
    """'osm' or 'overture'"""
    id: str
    service: str
    kind: str
    name: str | None
    lon: float
    lat: float
    tags: dict[str, str] = field(default_factory=dict)
    confidence: float | None = None
    """Overture's own confidence score (0-1); None for OSM."""
    datasets: list[str] = field(default_factory=list)
    """For Overture: the upstream datasets (meta, Foursquare, AllThePlaces, ...)."""


def _keep(tags) -> dict[str, str]:
    return {t.k: t.v for t in tags if t.k in KEEP_TAGS}


def _centroid(area) -> tuple[float, float] | None:
    polys = []
    for outer in area.outer_rings():
        ring = [(n.lon, n.lat) for n in outer if n.location.valid()]
        if len(ring) >= 4:
            polys.append(Polygon(ring))
    if not polys:
        return None
    c = (polys[0] if len(polys) == 1 else MultiPolygon(polys)).centroid
    return c.x, c.y


def read_osm_places(pbf: Path, work: Path) -> list[RawPlace]:
    small = work / "places.osm.pbf"
    small.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["osmium", "tags-filter", "--overwrite", str(pbf), *OSM_FILTERS, "-o", str(small)],
        check=True,
        capture_output=True,
    )
    out: list[RawPlace] = []
    for obj in osmium.FileProcessor(str(small)).with_locations().with_areas():
        if obj.is_area():
            kind = classify_osm(dict(obj.tags))
            if kind is None:
                continue
            c = _centroid(obj)
            if c is None:
                continue
            oid = f"{'w' if obj.from_way() else 'r'}{obj.orig_id()}"
            out.append(RawPlace("osm", oid, *kind, obj.tags.get("name"), c[0], c[1], _keep(obj.tags)))
        elif obj.is_node():
            if not obj.tags:
                continue
            kind = classify_osm(dict(obj.tags))
            if kind is not None and obj.location.valid():
                out.append(
                    RawPlace("osm", f"n{obj.id}", *kind, obj.tags.get("name"), obj.lon, obj.lat, _keep(obj.tags))
                )
        elif obj.is_way() and not obj.is_closed():
            kind = classify_osm(dict(obj.tags))
            coords = [(n.lon, n.lat) for n in obj.nodes if n.location.valid()]
            if kind is not None and coords:
                lon = sum(c[0] for c in coords) / len(coords)
                lat = sum(c[1] for c in coords) / len(coords)
                out.append(RawPlace("osm", f"w{obj.id}", *kind, obj.tags.get("name"), lon, lat, _keep(obj.tags)))
    return out
