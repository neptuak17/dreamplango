"""Write an Audit Bundle (JSON/GeoJSON files) and move the route's `current` pointer to it.

Layout: <data>/bundles/<network>/<ref>/<run_id>/<files>
        <data>/bundles/<network>/<ref>/current.json
Private audits (a rider's own route, D25) live apart, under <data>/bundles/private/<network>/<ref>/.

A geometry-only bundle (`dpg ingest`) has manifest, path, sections, findings and profile. A full audit (`dpg audit`)
adds events (layers), minor (1 km criteria), scores, places, services and dream (M3).
"""

import hashlib
import json
import os
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
from pydantic import BaseModel

from dpg_audit import __version__
from dpg_audit.build import RouteBuild
from dpg_audit.lrs.sections import fixed_sections
from dpg_audit.models import (
    BundleManifest,
    ComponentKind,
    CurrentPointer,
    DreamFile,
    EventsFile,
    Finding,
    FindingsFile,
    MinorFile,
    PipelineInfo,
    PlacesFile,
    ProfileFile,
    RouteOverlap,
    ScoresFile,
    SectionsFile,
    ServicesFile,
    SourceSnapshot,
    UserPlacesFile,
    WaysFile,
)

FILE_NAMES = {
    "manifest": "manifest.json",
    "path": "path.geojson",
    "sections": "sections.json",
    "findings": "findings.json",
    "profile": "profile.json",
    "events": "events.json",
    "minor": "minor.json",
    "scores": "scores.json",
    "places": "places.json",
    "services": "services.json",
    "dream": "dream.json",
    "ways": "ways.json",
    "user_places": "user_places.json",
}
BLOCK_SIZE_M = 50_000.0
MINOR_SIZE_M = 1_000.0
PROFILE_STEP_M = 100.0


def _round_coords(lon: np.ndarray, lat: np.ndarray) -> list[list[float]]:
    return [[round(float(x), 6), round(float(y), 6)] for x, y in zip(lon, lat, strict=True)]


def path_geojson(build: RouteBuild) -> dict:
    """Ride components (with the path measure of every coordinate, for exact client-side slicing) and gaps."""
    by_number = {d.number: d for d in build.daily}
    features = []
    parts = iter(build.path.parts)
    for comp in build.components:
        if comp.kind == ComponentKind.RIDE:
            part = next(parts)
            d = by_number[comp.daily_section]
            props = {
                "kind": "ride",
                "component": comp.id,
                "section": d.number,
                "title": d.title,
                "from_m": comp.from_m,
                "to_m": comp.to_m,
                "development": d.status.development.value,
                "signage": d.status.signage.value,
                "status": d.status.label,
                "m": [round(float(part.from_m + m), 1) for m in part.line.cum],
            }
            coords = _round_coords(part.line.lon, part.line.lat)
        else:
            props = {
                "kind": "gap",
                "component": comp.id,
                "at_m": comp.from_m,
                "straight_distance_m": comp.straight_distance_m,
                "gap_type": comp.gap_type.value if comp.gap_type else None,
            }
            coords = [[round(c, 6) for c in comp.start], [round(c, 6) for c in comp.end]]
        features.append(
            {"type": "Feature", "properties": props, "geometry": {"type": "LineString", "coordinates": coords}}
        )
    return {"type": "FeatureCollection", "features": features}


def gpx_profile(build: RouteBuild, step_m: float = PROFILE_STEP_M) -> ProfileFile:
    ms: list[float] = []
    eles: list[float | None] = []
    for part in build.path.parts:
        line = part.line
        local = np.append(np.arange(0.0, line.length, step_m), line.length)
        ele = line.elevation_at(local)
        ms.extend(round(float(part.from_m + m), 1) for m in local)
        if ele is None:
            eles.extend([None] * local.size)
        else:
            eles.extend(None if np.isnan(e) else round(float(e), 1) for e in ele)
    return ProfileFile(step_m=step_m, source="source GPX elevation (unverified)", m=ms, ele=eles, gpx_ele=eles)


def _write_json(path: Path, payload) -> None:
    text = payload.model_dump_json() if isinstance(payload, BaseModel) else json.dumps(payload)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def bundle_dir(data_dir: Path, network: str, ref: str, private: bool = False) -> Path:
    base = data_dir / "bundles" / ("private" if private else "")
    return base / network / ref.lower()


def write_bundle(
    build: RouteBuild,
    sources: list[SourceSnapshot],
    data_dir: Path,
    *,
    pipeline: str = "dpg-audit/ingest",
    findings: list[Finding] | None = None,
    profile: ProfileFile | None = None,
    events: EventsFile | None = None,
    minor: MinorFile | None = None,
    scores: ScoresFile | None = None,
    places: PlacesFile | None = None,
    services: ServicesFile | None = None,
    dream: DreamFile | None = None,
    ways: WaysFile | None = None,
    user_places: UserPlacesFile | None = None,
    overlap: list[RouteOverlap] | None = None,
    private: bool = False,
) -> tuple[str, Path]:
    created = datetime.now(UTC)
    digest = hashlib.sha256("|".join([__version__, pipeline, *sorted(s.sha256 for s in sources)]).encode()).hexdigest()[
        :10
    ]
    run_id = f"{created:%Y%m%dT%H%M%SZ}_{digest}"
    route_dir = bundle_dir(data_dir, build.route.network, build.route.ref, private)
    out = route_dir / run_id
    out.mkdir(parents=True, exist_ok=False)

    length = build.path.length
    findings = build.findings if findings is None else findings
    payloads: dict[str, object] = {
        "path": path_geojson(build),
        "sections": SectionsFile(
            daily=build.daily,
            status=build.status_sections,
            components=build.components,
            blocks=[(round(a, 1), round(b, 1)) for a, b in fixed_sections(length, BLOCK_SIZE_M)],
            minor=[(round(a, 1), round(b, 1)) for a, b in fixed_sections(length, MINOR_SIZE_M)],
        ),
        "findings": FindingsFile(findings=findings),
        "profile": profile or gpx_profile(build),
        "events": events,
        "minor": minor,
        "scores": scores,
        "places": places,
        "services": services,
        "dream": dream,
        "ways": ways,
        "user_places": user_places,
    }
    files = {"manifest": FILE_NAMES["manifest"]}
    for name, payload in payloads.items():
        if payload is not None:
            _write_json(out / FILE_NAMES[name], payload)
            files[name] = FILE_NAMES[name]
    manifest = BundleManifest(
        run_id=run_id,
        created_at=created,
        pipeline=PipelineInfo(name=pipeline, version=__version__),
        route=build.route,
        sources=sources,
        attribution=list(dict.fromkeys(s.attribution for s in sources)),
        files=files,
        summary=build.summary(),
        finding_counts=dict(Counter(f.severity.value for f in findings)),
        visibility="private" if private else "public",
        overlap=overlap or [],
    )
    _write_json(out / FILE_NAMES["manifest"], manifest)
    _write_json(route_dir / "current.json", CurrentPointer(run_id=run_id, updated_at=created))
    return run_id, out
