"""Highlights near the route (11.6): the named OSM features behind M3's themes, with their Wikipedia links.

Read from Dream's filtered theme extract (themes.osm.pbf, 2.5 km either side). A feature is kept when it is named and
within its kind's distance of the route. Its rank (0-1) comes from its kind and tags only: UNESCO sites first, then
features with a Wikipedia or Wikidata link, then by kind. To keep the file small, at most PER_WINDOW features are kept
in each WINDOW_M of route, UNESCO sites always.
"""

from collections import defaultdict
from pathlib import Path

import numpy as np
import osmium

from dpg_audit.dream.themes import HISTORIC, _point_of
from dpg_audit.lrs.index import RouteIndex
from dpg_audit.lrs.path import RoutePath
from dpg_audit.models import Highlight, HighlightsFile

RADIUS_M = {"peak": 2000.0, "pass": 2000.0}
DEFAULT_RADIUS_M = 1000.0
WINDOW_M = 10_000.0
PER_WINDOW = 6
BASE_RANK = {
    "castle": 0.6,
    "palace": 0.6,
    "fort": 0.55,
    "archaeological_site": 0.55,
    "citywalls": 0.55,
    "heritage": 0.5,
    "ruins": 0.45,
    "monument": 0.4,
    "manor": 0.4,
    "city_gate": 0.4,
    "museum": 0.5,
    "attraction": 0.4,
    "gallery": 0.3,
    "viewpoint": 0.5,
    "pass": 0.5,
    "peak": 0.35,
    "beach": 0.35,
}


def kind_of(tags) -> str | None:
    if tags.get("tourism") == "viewpoint":
        return "viewpoint"
    if tags.get("historic") in HISTORIC:
        return tags.get("historic")
    if tags.get("heritage") == "1":
        return "heritage"
    if tags.get("tourism") in ("museum", "attraction", "gallery"):
        return tags.get("tourism")
    if tags.get("natural") == "beach":
        return "beach"
    if tags.get("mountain_pass") == "yes":
        return "pass"
    if tags.get("natural") == "peak":
        return "peak"
    return None


def _ele(value: str | None) -> float | None:
    try:
        return round(float(str(value).replace("m", "").strip()), 0) if value else None
    except ValueError:
        return None


def rank(kind: str, unesco: bool, linked: bool, offset_m: float) -> float:
    if unesco:
        return 1.0
    r = BASE_RANK.get(kind, 0.3) + (0.3 if linked else 0.0) + (0.1 if offset_m < 300 else 0.0)
    return round(min(r, 0.95), 2)


def read_highlights(theme_pbf: Path) -> list[dict]:
    out = []
    for obj in osmium.FileProcessor(str(theme_pbf)).with_locations().with_areas():
        if obj.is_relation() or (obj.is_way() and obj.is_closed()):
            continue  # areas arrive again, assembled
        name = obj.tags.get("name")
        kind = kind_of(obj.tags)
        if not name or not kind:
            continue
        point = _point_of(obj)
        if point is None:
            continue
        if obj.is_area():
            oid = f"osm:{'w' if obj.from_way() else 'r'}{obj.orig_id()}"
        else:
            oid = f"osm:{'n' if obj.is_node() else 'w'}{obj.id}"
        out.append(
            {
                "id": oid,
                "kind": kind,
                "name": name,
                "lon": point[0],
                "lat": point[1],
                "ele": _ele(obj.tags.get("ele")) if kind in ("peak", "pass") else None,
                "wikidata": obj.tags.get("wikidata"),
                "wikipedia": obj.tags.get("wikipedia"),
                "unesco": obj.tags.get("heritage") == "1",
            }
        )
    return out


def select(path: RoutePath, raw: list[dict]) -> list[Highlight]:
    if not raw:
        return []
    index = RouteIndex(path)
    lon = np.array([r["lon"] for r in raw])
    lat = np.array([r["lat"] for r in raw])
    radius = np.array([RADIUS_M.get(r["kind"], DEFAULT_RADIUS_M) for r in raw])
    near = np.flatnonzero(index.within(lon, lat, radius))
    projs = index.project(lon[near], lat[near])
    kept: list[Highlight] = []
    for i, p in zip(near, projs, strict=True):
        r = raw[int(i)]
        if p.offset_m > radius[i]:
            continue
        linked = bool(r["wikidata"] or r["wikipedia"])
        kept.append(
            Highlight(
                id=r["id"],
                kind=r["kind"],
                name=r["name"],
                lon=round(r["lon"], 6),
                lat=round(r["lat"], 6),
                at_m=round(p.m, 1),
                offset_m=round(p.offset_m, 1),
                ele=r["ele"],
                wikidata=r["wikidata"],
                wikipedia=r["wikipedia"],
                unesco=r["unesco"],
                rank=rank(r["kind"], r["unesco"], linked, p.offset_m),
            )
        )
    # The same named feature mapped twice (a node and an area) is kept once, the higher-ranked.
    best: dict[tuple[str, str, int], Highlight] = {}
    for h in kept:
        key = (h.name.casefold(), h.kind, round(h.at_m / 500))
        if key not in best or h.rank > best[key].rank:
            best[key] = h
    windows: dict[int, list[Highlight]] = defaultdict(list)
    for h in best.values():
        windows[int(h.at_m // WINDOW_M)].append(h)
    out = []
    for group in windows.values():
        group.sort(key=lambda h: (-h.rank, h.offset_m))
        out += [h for i, h in enumerate(group) if i < PER_WINDOW or h.unesco]
    out.sort(key=lambda h: (h.at_m, h.id))
    return out


def build_highlights(path: RoutePath, theme_pbf: Path) -> HighlightsFile:
    return HighlightsFile(highlights=select(path, read_highlights(theme_pbf)))
