"""Services and access (M2): places from OSM and Overture, conflated, located on the route, routed and scored."""

import hashlib
import json
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from dpg_audit.build import RouteBuild
from dpg_audit.layers import elevation
from dpg_audit.lrs.index import RouteIndex
from dpg_audit.match.valhalla import Valhalla
from dpg_audit.models import Place, PlacesFile, ServicesFile, SourceSnapshot
from dpg_audit.services import conflate as cf
from dpg_audit.services.access import ACCESS_VERSION, AccessJob, compute_access, job_key
from dpg_audit.services.coverage import Coverage
from dpg_audit.services.osm_places import RawPlace, read_osm_places
from dpg_audit.services.policy import BikePolicy, CountryLookup
from dpg_audit.services.profile import ServicesProfile
from dpg_audit.services.seasons import UNKNOWN, month_codes, season_known
from dpg_audit.sources import dem, osm, overture

BLOCK_M = 50_000.0
DETAIL_TAGS = ("website", "contact:website", "phone", "contact:phone", "stars", "brand", "operator", "fee", "tents")


@dataclass
class ServicesResult:
    places: list[Place]
    file: PlacesFile
    coverage: Coverage
    sources: list[SourceSnapshot]
    counts: dict[str, int]


def _hash(*parts: object) -> str:
    return hashlib.sha256(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()[:12]


def _place_elevation(lon: np.ndarray, lat: np.ndarray, root: Path) -> np.ndarray:
    """Lowest DEM value within ~30 m of each place, so roofs and trees don't count as climbing."""
    dlat = 30 / 111_320
    dlon = dlat / np.maximum(np.cos(np.radians(lat)), 0.2)
    offsets = ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1))
    # One call, so every DEM tile is read once.
    flat = dem.sample(
        np.concatenate([lon + ox * dlon for ox, _ in offsets]),
        np.concatenate([lat + oy * dlat for _, oy in offsets]),
        root,
    )
    stack = flat.reshape(len(offsets), -1)
    with np.errstate(all="ignore"):
        return np.where(np.all(np.isnan(stack), axis=0), np.nan, np.nanmin(stack, axis=0))


def _detail(primary: RawPlace, members: list[RawPlace]) -> dict:
    tags = primary.tags
    out: dict = {k.removeprefix("contact:"): tags[k] for k in DETAIL_TAGS if tags.get(k)}
    datasets = sorted({d for m in members for d in m.datasets})
    if datasets:
        out["datasets"] = datasets
    scores = [m.confidence for m in members if m.confidence is not None]
    if scores:
        out["overture_confidence"] = round(max(scores), 2)
    if any(m.tags.get("overture:status") == "temporarily_closed" for m in members):
        out["temporarily_closed"] = True
    if tags.get("seasonal"):
        out["seasonal"] = tags["seasonal"]
    return out


def build_places(
    root: Path,
    wd: Path,
    build: RouteBuild,
    profs: list[elevation.PartProfile],
    client: Valhalla,
    tileset: str,
    route_sha: str,
    profile: ServicesProfile,
    *,
    workers: int = 6,
    overture_release: str | None = None,
    log: Callable[[str], None] = print,
) -> ServicesResult:
    index = RouteIndex(build.path)
    places_dir = wd / "places"
    max_show = max(t.show_m for t in profile.types.values())

    log("reading service places from the OSM corridor …")
    raw = read_osm_places(wd / "osm" / "corridor.osm.pbf", places_dir)
    n_osm = len(raw)

    release = overture_release or overture.latest_release()
    pts = [p.line.resample(1000.0) for p in build.path.parts]
    boxes = overture.boxes_along(
        np.concatenate([ln.lon for ln in pts]),
        np.concatenate([ln.lat for ln in pts]),
        np.concatenate([ln.cum + part.from_m for ln, part in zip(pts, build.path.parts, strict=True)]),
        BLOCK_M,
        max_show,
    )
    cache = places_dir / f"overture-{release}-{_hash(boxes, overture.QUERY_VERSION)}.json"
    log(f"Overture places {release}: {len(boxes)} boxes{' (cached)' if cache.exists() else ''} …")
    records = overture.fetch_places(release, boxes, cache)
    raw += overture.to_raw(records, profile.overture_min_confidence)
    n_overture = len(raw) - n_osm

    show = np.array([profile.types[r.service].show_m for r in raw])
    near = index.within(np.array([r.lon for r in raw]), np.array([r.lat for r in raw]), show)
    raw = [r for r, keep in zip(raw, near, strict=True) if keep]
    log(f"{n_osm:,} OSM + {n_overture:,} Overture places; {len(raw):,} near the route; conflating …")
    merged = cf.conflate(raw)

    lon = np.array([m.primary.lon for m in merged])
    lat = np.array([m.primary.lat for m in merged])
    projs = index.project(lon, lat)
    keep = [
        i
        for i, (m, p) in enumerate(zip(merged, projs, strict=True))
        if p.offset_m <= profile.types[m.primary.service].show_m
    ]
    merged, projs = [merged[i] for i in keep], [projs[i] for i in keep]
    lon, lat = lon[keep], lat[keep]
    countries = CountryLookup(osm.geofabrik_index(root)).lookup(lon, lat)
    policy = BikePolicy.load()

    samples = index.samples(profile.route_sample_m)
    jobs: list[tuple[float, AccessJob]] = []
    for m, p in zip(merged, projs, strict=True):
        cfg = profile.types[m.primary.service]
        if p.offset_m <= profile.skip_routing_m:
            continue
        src = samples.near(m.primary.lon, m.primary.lat, cfg.show_m, profile.max_sources)
        key = job_key(cfg.costing, m.primary.lon, m.primary.lat)
        jobs.append((p.m, AccessJob(key, m.primary.lon, m.primary.lat, cfg.costing, [int(s) for s in src])))
    jobs.sort(key=lambda j: j[0])
    access_cache = places_dir / (
        f"access-{_hash(tileset, route_sha, ACCESS_VERSION, profile.route_sample_m, profile.max_sources)}.json"
    )
    access = compute_access([j for _, j in jobs], samples, client, access_cache, workers)

    access_at = np.array(
        [
            p.m
            if p.offset_m <= profile.skip_routing_m
            else (access[job_key(profile.types[m.primary.service].costing, m.primary.lon, m.primary.lat)].at_m or p.m)
            for m, p in zip(merged, projs, strict=True)
        ]
    )
    log("terrain at places …")
    place_ele = _place_elevation(lon, lat, root)
    route_ele = elevation.at(profs, access_at)

    places: list[Place] = []
    for i, (m, p) in enumerate(zip(merged, projs, strict=True)):
        prim = m.primary
        cfg = profile.types[prim.service]
        if p.offset_m <= profile.skip_routing_m:
            dist: float | None = p.offset_m
        else:
            dist = access[job_key(cfg.costing, prim.lon, prim.lat)].distance_m
        if dist is not None and dist > cfg.show_m:
            continue
        climb = None
        if not (np.isnan(place_ele[i]) or np.isnan(route_ele[i])):
            climb = round(max(0.0, float(place_ele[i] - route_ele[i])), 0)
        minutes = None
        if dist is not None and cfg.costing == "bicycle":
            minutes = round(profile.minutes(dist, climb), 1)
        counts = dist is not None and dist <= cfg.count_m and (cfg.count_min is None or (minutes or 0) <= cfg.count_min)
        osm_rec = next((r for r in m.members if r.source == "osm"), None)
        months = month_codes(osm_rec.tags, profile.season_year) if osm_rec else UNKNOWN
        detail = _detail(prim, m.members)
        if dist is None:
            detail["unreachable"] = True
        if prim.service == "station":
            row = policy.lookup(prim.kind, countries[i], prim.tags)
            detail.update(
                bikes=row.bikes if row else "unknown",
                bike_note=row.note if row else "No policy recorded for this country.",
                bike_source=row.source if row else None,
                bike_confidence=row.confidence if row else "low",
            )
        name = prim.name or next((r.name for r in m.members if r.name), None)
        places.append(
            Place(
                id=m.sources[0],
                service=prim.service,
                kind=prim.kind,
                name=name,
                lon=round(prim.lon, 6),
                lat=round(prim.lat, 6),
                at_m=round(p.m, 1),
                offset_m=round(p.offset_m, 1),
                side="on" if p.side == 0 else ("left" if p.side > 0 else "right"),
                access_m=None if dist is None else round(dist),
                access_min=minutes,
                climb_m=climb,
                access_at_m=round(float(access_at[i]), 1),
                counts=counts,
                on_route=dist is not None and dist <= profile.on_route_m,
                months=months,
                opening_hours=osm_rec.tags.get("opening_hours") if osm_rec else None,
                country=countries[i],
                sources=m.sources,
                confidence=cf.confidence(m),  # type: ignore[arg-type]
                detail=detail,
            )
        )
    places.sort(key=lambda p: (p.access_at_m, p.service, p.id))
    counts: dict[str, int] = {}
    for p in places:
        counts[p.service] = counts.get(p.service, 0) + 1
    sources = [overture.snapshot(release, cache, root, len(records))]
    return ServicesResult(
        places=places,
        file=PlacesFile(season_year=profile.season_year, places=places),
        coverage=Coverage(places, profile, build.path.length),
        sources=sources,
        counts=counts,
    )


def services_file(result: ServicesResult, build: RouteBuild, profile: ServicesProfile) -> ServicesFile:
    sections, route = result.coverage.section_stats(build.daily)
    return ServicesFile(
        rules_profile=profile.id,
        season_year=profile.season_year,
        types=[t.info() for t in profile.types.values()],
        route_longest_gap_m=route,
        sections=sections,
        gaps=result.coverage.gap_list(),
        season_known={
            s: round(sum(season_known(p.months) for p in ps) / len(ps), 4)
            for s in profile.types
            if (ps := [p for p in result.places if p.service == s and p.counts])
        },
    )
