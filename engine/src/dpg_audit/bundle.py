"""Write an Audit Bundle (format v0: JSON/GeoJSON files) and move the route's `current` pointer to it.

Layout: <data>/bundles/<network>/<ref>/<run_id>/{manifest,path,sections,findings,profile}.json
        <data>/bundles/<network>/<ref>/current.json
SQLite and PMTiles join the bundle in M1.
"""

import hashlib
import json
import os
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

from dpg_audit import PIPELINE_NAME, __version__
from dpg_audit.build import RouteBuild
from dpg_audit.lrs.sections import fixed_sections
from dpg_audit.models import (
    BundleManifest,
    ComponentKind,
    CurrentPointer,
    FindingsFile,
    PipelineInfo,
    ProfileFile,
    SectionsFile,
    SourceSnapshot,
)

FILES = {
    "manifest": "manifest.json",
    "path": "path.geojson",
    "sections": "sections.json",
    "findings": "findings.json",
    "profile": "profile.json",
}
BLOCK_SIZE_M = 50_000.0
MINOR_SIZE_M = 1_000.0
PROFILE_STEP_M = 200.0


def _round_coords(lon: np.ndarray, lat: np.ndarray) -> list[list[float]]:
    return [[round(float(x), 6), round(float(y), 6)] for x, y in zip(lon, lat, strict=True)]


def path_geojson(build: RouteBuild) -> dict:
    by_number = {d.number: d for d in build.daily}
    features = []
    ride_lines = iter(build.lines)
    for comp in build.components:
        if comp.kind == ComponentKind.RIDE:
            line = next(ride_lines)
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
            }
            coords = _round_coords(line.lon, line.lat)
        else:
            props = {
                "kind": "gap",
                "component": comp.id,
                "at_m": comp.from_m,
                "straight_distance_m": comp.straight_distance_m,
            }
            coords = [[round(c, 6) for c in comp.start], [round(c, 6) for c in comp.end]]
        features.append(
            {"type": "Feature", "properties": props, "geometry": {"type": "LineString", "coordinates": coords}}
        )
    return {"type": "FeatureCollection", "features": features}


def profile(build: RouteBuild, step_m: float = PROFILE_STEP_M) -> ProfileFile:
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
    return ProfileFile(step_m=step_m, source="source GPX elevation (unverified)", m=ms, ele=eles)


def _write_json(path: Path, payload) -> None:
    text = payload.model_dump_json() if hasattr(payload, "model_dump_json") else json.dumps(payload)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def write_bundle(build: RouteBuild, sources: list[SourceSnapshot], data_dir: Path) -> tuple[str, Path]:
    created = datetime.now(UTC)
    digest = hashlib.sha256("|".join([__version__, *sorted(s.sha256 for s in sources)]).encode()).hexdigest()[:10]
    run_id = f"{created:%Y%m%dT%H%M%SZ}_{digest}"
    route_dir = data_dir / "bundles" / build.route.network / build.route.ref.lower()
    out = route_dir / run_id
    out.mkdir(parents=True, exist_ok=False)

    length = build.path.length
    sections = SectionsFile(
        daily=build.daily,
        status=build.status_sections,
        components=build.components,
        blocks=[(round(a, 1), round(b, 1)) for a, b in fixed_sections(length, BLOCK_SIZE_M)],
        minor=[(round(a, 1), round(b, 1)) for a, b in fixed_sections(length, MINOR_SIZE_M)],
    )
    counts = Counter(f.severity.value for f in build.findings)
    manifest = BundleManifest(
        run_id=run_id,
        created_at=created,
        pipeline=PipelineInfo(name=PIPELINE_NAME, version=__version__),
        route=build.route,
        sources=sources,
        attribution=[s.attribution for s in sources],
        files=FILES,
        summary=build.summary(),
        finding_counts=dict(counts),
    )
    _write_json(out / FILES["path"], path_geojson(build))
    _write_json(out / FILES["sections"], sections)
    _write_json(out / FILES["findings"], FindingsFile(findings=build.findings))
    _write_json(out / FILES["profile"], profile(build))
    _write_json(out / FILES["manifest"], manifest)
    _write_json(route_dir / "current.json", CurrentPointer(run_id=run_id, updated_at=created))
    return run_id, out
