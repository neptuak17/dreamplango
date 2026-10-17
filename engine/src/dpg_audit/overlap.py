"""Which OSM ways a route follows, and how much of a route runs on the same ways as an audited public route (D40).

Every bundle carries its matched ways (ways.json). A private route compares its own with each public route's: the
shared length counts, per way, the shorter of the two routes' lengths on it, so a long way that both only touch is
not over-counted. The private route's ways stay in its own (private) bundle.
"""

import json
from collections import defaultdict
from pathlib import Path

from dpg_audit.build import RouteBuild
from dpg_audit.match.matcher import LineMatch
from dpg_audit.models import BundleManifest, RouteOverlap, UserPlace, UserPlacesFile, WaysFile

MIN_SHARED_M = 1_000.0
"""Less than this is crossings and shared junctions, not a shared route."""


def ways_file(build: RouteBuild, matches: list[LineMatch]) -> WaysFile:
    lengths: dict[tuple[int, int], float] = defaultdict(float)
    for d, match in zip(build.daily, matches, strict=True):
        for p in match.pieces:
            if p.edge and "way_id" in p.edge and p.to_m > p.from_m:
                lengths[(int(p.edge["way_id"]), d.number)] += p.to_m - p.from_m
    return WaysFile(ways=[(w, s, round(m, 1)) for (w, s), m in sorted(lengths.items())])


def _ranges(numbers: set[int]) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for n in sorted(numbers):
        if out and n == out[-1][1] + 1:
            out[-1] = (out[-1][0], n)
        else:
            out.append((n, n))
    return out


def public_routes(data_dir: Path):
    """(manifest, ways) of every public route's current bundle that has a way list."""
    root = data_dir / "bundles"
    if not root.exists():
        return
    for current in sorted(root.glob("*/*/current.json")):
        if current.parts[-3] == "private":
            continue
        run = json.loads(current.read_text(encoding="utf-8"))["run_id"]
        ways = current.parent / run / "ways.json"
        if ways.exists():
            manifest = BundleManifest.model_validate_json((current.parent / run / "manifest.json").read_text())
            yield manifest, WaysFile.model_validate_json(ways.read_text(encoding="utf-8"))


def overlap(own: WaysFile, route_length_m: float, data_dir: Path, exclude: str | None = None) -> list[RouteOverlap]:
    mine: dict[int, float] = defaultdict(float)
    for w, _, m in own.ways:
        mine[w] += m
    out = []
    for manifest, ways in public_routes(data_dir):
        if manifest.route.id == exclude:
            continue
        theirs: dict[int, float] = defaultdict(float)
        sections: dict[int, set[int]] = defaultdict(set)
        for w, s, m in ways.ways:
            theirs[w] += m
            sections[w].add(s)
        common = mine.keys() & theirs.keys()
        shared = sum(min(mine[w], theirs[w]) for w in common)
        if shared < MIN_SHARED_M:
            continue
        out.append(
            RouteOverlap(
                route_id=manifest.route.id,
                name=manifest.route.name,
                network=manifest.route.network,
                ref=manifest.route.ref,
                shared_m=round(shared, 1),
                share=round(shared / route_length_m, 4) if route_length_m else 0.0,
                sections=_ranges(set().union(*(sections[w] for w in common))),
            )
        )
    return sorted(out, key=lambda o: -o.shared_m)


def user_places(build: RouteBuild, waypoints) -> UserPlacesFile:
    """The file's waypoints on the route's measure axis (D24). Shown, never counted (D40)."""
    out = []
    for k, w in enumerate(waypoints, start=1):
        p = build.path.project(w.lon, w.lat)
        section = next((d.number for d in build.daily if d.from_m <= p.m <= d.to_m), None)
        out.append(
            UserPlace(
                id=f"w{k}",
                name=w.name or None,
                kind=w.kind or "waypoint",
                note=w.note or None,
                lon=round(w.lon, 6),
                lat=round(w.lat, 6),
                ele=None if w.ele is None else round(w.ele, 1),
                at_m=round(p.m, 1),
                offset_m=round(p.offset_m, 1),
                section=section,
            )
        )
    return UserPlacesFile(places=out)
