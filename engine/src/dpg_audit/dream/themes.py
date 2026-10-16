"""Scenery themes and remoteness per daily section, from OSM (11.4).

A 2.5 km corridor is cut from the route's OSM extract and filtered to the features themes need. The route is
sampled every 100 m; each theme combines "share of samples near X" and "X per 10 km" measures. A theme's score is the
section's raw value against the route's 90th percentile (capped at 1), so "high coast" means coastal compared with
the route's other sections. Remoteness uses villages and larger places from the full 15 km corridor.
"""

import subprocess
from bisect import bisect_right
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import osmium
import shapely
from scipy.spatial import cKDTree
from shapely.geometry import LineString, Polygon

from dpg_audit.corridor import corridor, write_geojson
from dpg_audit.layers import elevation
from dpg_audit.lrs import MeasuredLine
from dpg_audit.lrs.index import to_laea
from dpg_audit.lrs.path import RoutePath
from dpg_audit.models import DailySection, ThemeInfo, ThemeScore

SAMPLE_M = 100.0
THEME_CORRIDOR_M = 2500.0

THEMES = [
    ThemeInfo(id="coast", title="Coast & beaches", measures="Share of the section within 1 km of the sea; beaches"),
    ThemeInfo(id="mountains", title="Mountains", measures="Climbing per km and peaks or passes within 2 km"),
    ThemeInfo(id="water", title="Lakes & rivers", measures="Share of the section within 500 m of a lake or river"),
    ThemeInfo(id="forest", title="Forest & nature", measures="Share near forest, and share inside protected areas"),
    ThemeInfo(id="wine", title="Vineyards & wine", measures="Share within 1 km of vineyards; wineries and wine shops"),
    ThemeInfo(id="heritage", title="Villages & heritage", measures="Castles, ruins, monuments, UNESCO sites; villages"),
    ThemeInfo(id="viewpoints", title="Viewpoints", measures="Viewpoints within 1 km"),
    ThemeInfo(id="culture", title="Towns & culture", measures="Built-up share within 500 m; museums and attractions"),
]

FILTERS = [
    "w/natural=coastline",
    "nwr/natural=beach,water,wood,peak",
    "w/waterway=river",
    "nwr/landuse=forest,vineyard,residential,commercial,retail",
    "nwr/boundary=protected_area,national_park",
    "nwr/leisure=nature_reserve",
    "nwr/craft=winery",
    "nwr/shop=wine",
    "nwr/historic=castle,ruins,monument,archaeological_site,city_gate,fort,manor,palace,citywalls",
    "nwr/heritage=1",
    "nwr/tourism=viewpoint,museum,attraction,gallery",
    "n/mountain_pass=yes",
]
HISTORIC = {"castle", "ruins", "monument", "archaeological_site", "city_gate", "fort", "manor", "palace", "citywalls"}


@dataclass
class Features:
    lines: dict[str, list] = field(default_factory=lambda: {"coast": [], "river": []})
    polys: dict[str, list] = field(
        default_factory=lambda: {"water": [], "forest": [], "vineyard": [], "protected": [], "built": []}
    )
    points: dict[str, list[tuple[float, float]]] = field(
        default_factory=lambda: {k: [] for k in ("beach", "winery", "heritage", "viewpoint", "peak", "culture")}
    )


def _osmium(*args: str) -> None:
    subprocess.run(["osmium", *args], check=True, capture_output=True)


def _laea_line(coords: list[tuple[float, float]]):
    x, y = to_laea([c[0] for c in coords], [c[1] for c in coords])
    return LineString(np.stack([x, y], 1))


def _laea_poly(area) -> list:
    out = []
    for outer in area.outer_rings():
        ring = [(n.lon, n.lat) for n in outer if n.location.valid()]
        if len(ring) < 4:
            continue
        holes = []
        for inner in area.inner_rings(outer):
            h = [(n.lon, n.lat) for n in inner if n.location.valid()]
            if len(h) >= 4:
                x, y = to_laea([c[0] for c in h], [c[1] for c in h])
                holes.append(np.stack([x, y], 1))
        x, y = to_laea([c[0] for c in ring], [c[1] for c in ring])
        poly = Polygon(np.stack([x, y], 1), holes)
        out.append(poly if poly.is_valid else poly.buffer(0))
    return out


def _point_of(obj) -> tuple[float, float] | None:
    if obj.is_node():
        return (obj.lon, obj.lat) if obj.location.valid() else None
    if obj.is_area():
        rings = [[(n.lon, n.lat) for n in r if n.location.valid()] for r in obj.outer_rings()]
        pts = [p for r in rings for p in r]
    else:
        pts = [(n.lon, n.lat) for n in obj.nodes if n.location.valid()]
    if not pts:
        return None
    return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)


def read_features(theme_pbf: Path) -> Features:
    f = Features()
    for obj in osmium.FileProcessor(str(theme_pbf)).with_locations().with_areas():
        if obj.is_relation():
            continue  # multipolygons arrive again as assembled areas
        t = obj.tags
        if obj.is_way() and not obj.is_area():
            coords = [(n.lon, n.lat) for n in obj.nodes if n.location.valid()]
            if len(coords) >= 2:
                if t.get("natural") == "coastline":
                    f.lines["coast"].append(_laea_line(coords))
                elif t.get("waterway") == "river":
                    f.lines["river"].append(_laea_line(coords))
        if obj.is_area():
            nat, lu = t.get("natural"), t.get("landuse")
            kind = (
                "water"
                if nat == "water"
                else "forest"
                if lu == "forest" or nat == "wood"
                else "vineyard"
                if lu == "vineyard"
                else "protected"
                if t.get("boundary") in ("protected_area", "national_park") or t.get("leisure") == "nature_reserve"
                else "built"
                if lu in ("residential", "commercial", "retail")
                else None
            )
            if kind and nat != "coastline":
                f.polys[kind].extend(_laea_poly(obj))
        if obj.is_way() and obj.is_closed():
            continue  # its area (if any) carries the point features below
        point_kind = (
            "beach"
            if t.get("natural") == "beach"
            else "winery"
            if t.get("craft") == "winery" or t.get("shop") == "wine"
            else "heritage"
            if t.get("historic") in HISTORIC or t.get("heritage") == "1"
            else "viewpoint"
            if t.get("tourism") == "viewpoint"
            else "peak"
            if t.get("natural") == "peak" or t.get("mountain_pass") == "yes"
            else "culture"
            if t.get("tourism") in ("museum", "attraction", "gallery")
            else None
        )
        if point_kind:
            p = _point_of(obj)
            if p:
                f.points[point_kind].append(p)
    return f


def read_places(corridor_pbf: Path, work: Path) -> list[tuple[float, float]]:
    small = work / "places-settlements.osm.pbf"
    _osmium("tags-filter", "--overwrite", str(corridor_pbf), "n/place=city,town,village", "-o", str(small))
    return [(o.lon, o.lat) for o in osmium.FileProcessor(str(small)) if o.is_node() and o.location.valid()]


def prepare(corridor_pbf: Path, lines: list[MeasuredLine], work: Path) -> Path:
    """Cut the theme corridor and filter it (cached until the corridor extract changes)."""
    work.mkdir(parents=True, exist_ok=True)
    out = work / "themes.osm.pbf"
    if out.exists() and out.stat().st_mtime >= corridor_pbf.stat().st_mtime:
        return out
    area = work / "themes-corridor.geojson"
    write_geojson(corridor(lines, THEME_CORRIDOR_M, simplify_m=100), area)
    cut = work / "themes-area.osm.pbf"
    _osmium("extract", "--overwrite", "-s", "smart", "-p", str(area), str(corridor_pbf), "-o", str(cut))
    _osmium("tags-filter", "--overwrite", str(cut), *FILTERS, "-o", str(out))
    cut.unlink()
    return out


def _near(geoms: list, xs: np.ndarray, ys: np.ndarray, radius: float) -> np.ndarray:
    mask = np.zeros(xs.shape, dtype=bool)
    if not geoms:
        return mask
    tree = shapely.STRtree(geoms)
    pts = shapely.points(xs, ys)
    hits = tree.query(pts, predicate="dwithin", distance=radius) if radius > 0 else tree.query(pts, "intersects")
    mask[hits[0]] = True
    return mask


def _p90(values: list[float]) -> float:
    return float(np.percentile(values, 90)) if values else 0.0


# Above this share of straight-line placeholder, a section's terrain is unknown (D37), not approximate.
PLACEHOLDER_UNKNOWN_SHARE = 0.25


def _untrusted_share(profs: list[elevation.PartProfile], m0: float, m1: float) -> float:
    """Share of terrain samples in [m0, m1] lying on placeholder geometry (straight-line track)."""
    total = bad = 0
    for p in profs:
        sel = (p.m >= m0) & (p.m <= m1)
        n = int(sel.sum())
        total += n
        if p.trusted is not None and n:
            bad += int((~p.trusted[sel]).sum())
    return bad / total if total else 0.0


@dataclass
class SectionScenery:
    themes: dict[str, ThemeScore]
    remote_share: float
    longest_remote_m: float


def scenery(
    path: RoutePath,
    daily: list[DailySection],
    feats: Features,
    places: list[tuple[float, float]],
    profs: list[elevation.PartProfile],
    cfg: dict[str, dict[str, float]],
    remote_cfg: dict[str, float],
) -> list[SectionScenery]:
    ms, lons, lats = [], [], []
    for part in path.parts:
        local = np.arange(0.0, part.line.length, SAMPLE_M)
        lon, lat = part.line.locate(local)
        ms.append(local + part.from_m)
        lons.append(np.atleast_1d(lon))
        lats.append(np.atleast_1d(lat))
    m, lon, lat = np.concatenate(ms), np.concatenate(lons), np.concatenate(lats)
    x, y = to_laea(lon, lat)
    starts = [d.from_m for d in daily]
    sec = np.array([max(bisect_right(starts, v) - 1, 0) for v in m])

    near = {
        "coast": _near(feats.lines["coast"], x, y, cfg["coast"]["line_m"]),
        "water": _near(feats.polys["water"] + feats.lines["river"], x, y, cfg["water"]["near_m"]),
        "forest": _near(feats.polys["forest"], x, y, cfg["forest"]["near_m"]),
        "protected": _near(feats.polys["protected"], x, y, 0),
        "vineyard": _near(feats.polys["vineyard"], x, y, cfg["wine"]["vineyard_m"]),
        "built": _near(feats.polys["built"], x, y, cfg["culture"]["built_m"]),
    }
    radii = {
        "beach": cfg["coast"]["beaches_m"],
        "winery": cfg["wine"]["wineries_m"],
        "heritage": cfg["heritage"]["near_m"],
        "viewpoint": cfg["viewpoints"]["near_m"],
        "peak": cfg["mountains"]["peaks_m"],
        "culture": cfg["culture"]["near_m"],
        "village": cfg["heritage"]["near_m"],
    }
    trees = {}
    for kind, pts in {**feats.points, "village": places}.items():
        if pts:
            px, py = to_laea([p[0] for p in pts], [p[1] for p in pts])
            trees[kind] = cKDTree(np.stack([px, py], 1))
    xy = np.stack([x, y], 1)

    place_dist = (
        trees["village"].query(xy, k=1)[0] if "village" in trees else np.full(x.shape, np.inf)
    )  # nearest village, town or city
    far = place_dist > remote_cfg["far_m"]
    ele = elevation.at(profs, m)

    raw: dict[str, list[float | None]] = {t.id: [] for t in THEMES}
    notes: dict[str, list[str]] = {t.id: [] for t in THEMES}
    remote: list[tuple[float, float]] = []

    def share_of(key: str, sel: np.ndarray) -> float:
        return float(near[key][sel].mean()) if sel.any() else 0.0

    def count_of(kind: str, sel: np.ndarray) -> int:
        if kind not in trees or not sel.any():
            return 0
        found = trees[kind].query_ball_point(xy[sel], r=radii[kind])
        return len({j for hits in found for j in hits})

    for i, d in enumerate(daily):
        sel = sec == i
        n = int(sel.sum())
        per10 = max(d.length_m, 1.0) / 10_000

        def share(key: str, sel: np.ndarray = sel) -> float:
            return share_of(key, sel)

        def count(kind: str, sel: np.ndarray = sel) -> int:
            return count_of(kind, sel)

        coast, beaches = share("coast"), count("beach")
        raw["coast"].append(0.8 * coast + 0.2 * min(1.0, beaches / per10 / 2))
        notes["coast"].append(f"{coast:.0%} within 1 km of the sea; {beaches} beach(es)")

        elev = ele[sel]
        elev = elev[~np.isnan(elev)]
        climb = elevation.ascent_descent(profs, d.from_m, d.to_m)
        per_km = (climb[0] + climb[1]) / 2 / max(d.length_m / 1000, 0.1)
        peaks = count("peak")
        if _untrusted_share(profs, d.from_m, d.to_m) > PLACEHOLDER_UNKNOWN_SHARE:
            # Terrain under a straight-line placeholder says nothing about the real road (D37: unknown, not a guess).
            raw["mountains"].append(None)
            notes["mountains"].append(
                f"terrain unknown: much of the official track here is a straight-line placeholder; "
                f"{peaks} peak(s) or pass(es) nearby"
            )
        else:
            raw["mountains"].append(per_km + 2 * min(1.0, peaks / per10))
            top = f"; up to {elev.max():.0f} m" if elev.size else ""
            notes["mountains"].append(f"{per_km:.0f} m climbing per km{top}; {peaks} peak(s) or pass(es) nearby")

        water = share("water")
        raw["water"].append(water)
        notes["water"].append(f"{water:.0%} within 500 m of a lake or river")

        forest, protected = share("forest"), share("protected")
        raw["forest"].append(0.5 * forest + 0.5 * protected)
        notes["forest"].append(f"{forest:.0%} near forest; {protected:.0%} in protected areas")

        vineyard, wineries = share("vineyard"), count("winery")
        raw["wine"].append(0.7 * vineyard + 0.3 * min(1.0, wineries / per10))
        notes["wine"].append(f"{vineyard:.0%} within 1 km of vineyards; {wineries} winery(ies) or wine shop(s)")

        heritage, villages = count("heritage"), count("village")
        raw["heritage"].append(0.6 * min(1.0, heritage / per10 / 5) + 0.4 * min(1.0, villages / per10 / 3))
        notes["heritage"].append(
            f"{heritage} castle(s), ruin(s), monument(s) or heritage site(s); {villages} village(s)"
        )

        views = count("viewpoint")
        raw["viewpoints"].append(views / per10)
        notes["viewpoints"].append(f"{views} viewpoint(s)")

        built, culture = share("built"), count("culture")
        raw["culture"].append(0.5 * min(1.0, built / 0.5) + 0.5 * min(1.0, culture / per10 / 3))
        notes["culture"].append(f"{built:.0%} built-up; {culture} museum(s) or attraction(s)")

        f = far[sel]
        longest = run = 0
        for v in f:
            run = run + 1 if v else 0
            longest = max(longest, run)
        remote.append((float(f.mean()) if n else 0.0, longest * SAMPLE_M))

    p90 = {k: _p90([x for x in v if x is not None]) for k, v in raw.items()}
    out = []
    for i in range(len(daily)):
        themes = {}
        for k in raw:
            value = raw[k][i]
            # Unknown stays unknown (D37), never a low score.
            score = None if value is None else round(0.0 if p90[k] <= 0 else min(1.0, value / p90[k]), 3)
            themes[k] = ThemeScore(score=score, note=notes[k][i])
        out.append(SectionScenery(themes=themes, remote_share=round(remote[i][0], 3), longest_remote_m=remote[i][1]))
    return out
