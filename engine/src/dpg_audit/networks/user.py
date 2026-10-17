"""Route source for a rider's own file (D22–D25, D39, D40): a private route, split into stages of about 60 km.

The file is copied into raw/user/<id>/route.gpx, where the id comes from its contents, so the same file always
maps to the same route. Its status and licence are unknown: it is never listed, shared or redistributed.
"""

import hashlib
import json
import re
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol

import numpy as np

from dpg_audit.build import TrackInput
from dpg_audit.ingest.gpx import GpxTrack, GpxWaypoint, read_gpx
from dpg_audit.lrs import MeasuredLine
from dpg_audit.lrs.geodesy import local_scale
from dpg_audit.models import DevelopmentLevel, EuroVeloStatus, Licence, Route, Signage, SourceSnapshot

NETWORK = "user"
SOURCE_ID = "user-file"
STAGE_M = 60_000.0
"""Single-track files are cut into equal stages of about this length (D40)."""
MIN_STEP_M = 5.0
"""Points closer than this to the last one kept are repeats or GPS jitter at a stop."""
NAME_RADIUS_M = 5_000.0
UNKNOWN_LICENCE = Licence(id="unknown", name="Unknown: the rider's own file, never redistributed (D25)")
ATTRIBUTION = "Route from the rider's own file (private)."
NOT_RATED = EuroVeloStatus(
    development=DevelopmentLevel.NOT_RATED, signage=Signage.UNKNOWN, label="Not rated (own route)"
)


class Named(Protocol):
    lon: float
    lat: float
    name: str | None
    kind: str


ROUTE_ID = re.compile(r"^u[0-9a-f]{10}$")
"""What every user route id looks like; anything else is refused before a path is built from it."""


def route_id(data: bytes) -> str:
    return "u" + hashlib.sha256(data).hexdigest()[:10]


def check_id(ref: str) -> str:
    if not ROUTE_ID.match(ref):
        raise ValueError(f"not a private route id: {ref!r} (expected u + 10 hex characters, e.g. u4ad6e50f59)")
    return ref


def raw_dir(data_dir: Path, ref: str) -> Path:
    return data_dir / "raw" / NETWORK / check_id(ref.lower())


def register(file: Path, data_dir: Path, name: str | None = None) -> SourceSnapshot:
    """Copy the rider's file into the data folder and record it. Re-registering keeps an earlier name unless a new
    one is given."""
    data = file.read_bytes()
    gpx = read_gpx(file)
    if not any(t.point_count >= 2 for t in gpx.tracks):
        raise ValueError(f"{file.name}: no track or route with at least two points")
    ref = route_id(data)
    out = raw_dir(data_dir, ref)
    out.mkdir(parents=True, exist_ok=True)
    meta = out / "source.json"
    previous = json.loads(meta.read_text(encoding="utf-8"))["title"] if meta.exists() else None
    target = out / "route.gpx"
    target.write_bytes(data)
    snap = SourceSnapshot(
        id=SOURCE_ID,
        title=name or previous or gpx.name or file.stem,
        url=None,
        retrieved_at=datetime.now(UTC),
        file=target.relative_to(data_dir).as_posix(),
        sha256=hashlib.sha256(data).hexdigest(),
        bytes=len(data),
        licence=UNKNOWN_LICENCE,
        attribution=ATTRIBUTION,
    )
    meta.write_text(snap.model_dump_json(indent=2), encoding="utf-8")
    return snap


def latest_snapshot(ref: str, data_dir: Path, snapshot_date: str | None = None) -> SourceSnapshot:
    meta = raw_dir(data_dir, ref) / "source.json"
    if not meta.exists():
        raise FileNotFoundError(f"no route {ref} under {meta.parent}; run `npm run audit:file -- <file.gpx>`")
    return SourceSnapshot.model_validate(json.loads(meta.read_text(encoding="utf-8")))


def route_for(ref: str, data_dir: Path) -> Route:
    return Route(
        id=f"{NETWORK}:{ref.lower()}",
        network=NETWORK,
        ref=ref.lower(),
        name=latest_snapshot(ref, data_dir).title,
        official_url=None,
    )


def clean(track: GpxTrack) -> MeasuredLine:
    """The track without repeated points or jitter at stops (anything within MIN_STEP_M of the last point kept)."""
    keep = [0]
    kx, ky = local_scale(float(np.nanmean(track.lat)))
    for i in range(1, track.point_count):
        j = keep[-1]
        if np.hypot((track.lon[i] - track.lon[j]) * kx, (track.lat[i] - track.lat[j]) * ky) >= MIN_STEP_M:
            keep.append(i)
    if keep[-1] != track.point_count - 1 and track.point_count > 1:
        keep[-1] = track.point_count - 1  # always end where the file ends
    idx = np.asarray(keep)
    ele = None if track.ele is None else track.ele[idx]
    return MeasuredLine(track.lon[idx], track.lat[idx], ele)


def place_name(lon: float, lat: float, places: Sequence[Named], radius_m: float = NAME_RADIUS_M) -> str | None:
    """The nearest city or town within the radius, else the nearest village."""
    if not places:
        return None
    kx, ky = local_scale(lat)
    best: dict[bool, tuple[float, str]] = {}
    for p in places:
        if not p.name:
            continue
        d = float(np.hypot((p.lon - lon) * kx, (p.lat - lat) * ky))
        big = p.kind in ("city", "town")
        if d <= radius_m and (big not in best or d < best[big][0]):
            best[big] = (d, p.name)
    hit = best.get(True) or best.get(False)
    return hit[1] if hit else None


def _title(prefix: str, a: str | None, b: str | None, m0: float, m1: float) -> str:
    """ "Stage 4: Foix – Ax-les-Thermes"; an end with no town within reach is given by its km instead."""
    if not a and not b:
        return f"{prefix}: km {m0 / 1000:.0f}–{m1 / 1000:.0f}"
    if a == b:
        return f"{prefix}: around {a}"
    return f"{prefix}: {a or f'km {m0 / 1000:.0f}'} – {b or f'km {m1 / 1000:.0f}'}"


def load_tracks(gpx_path: Path, settlements: Sequence[Named] = ()) -> list[TrackInput]:
    """Sections (D40): the file's own tracks if it has several, otherwise equal stages of about 60 km, named after
    the nearest town or village at each end when `settlements` (from the OSM corridor) are given."""
    tracks = [t for t in read_gpx(gpx_path).tracks if t.point_count >= 2]
    lines = [clean(t) for t in tracks]
    out: list[TrackInput] = []
    if len(lines) >= 2:
        offset = 0.0
        for k, (track, line) in enumerate(zip(tracks, lines, strict=True), start=1):
            a = place_name(*line.locate(0.0), settlements)
            b = place_name(*line.locate(line.length), settlements)
            title = track.name or _title(f"Track {k}", a, b, offset, offset + line.length)
            out.append(TrackInput(k, title, a, b, NOT_RATED, line, track.index))
            offset += line.length
        return out
    line = lines[0]
    n = max(1, round(line.length / STAGE_M))
    edges = np.linspace(0.0, line.length, n + 1)
    names = [place_name(*line.locate(float(m)), settlements) for m in edges]
    for k in range(n):
        m0, m1 = float(edges[k]), float(edges[k + 1])
        title = _title(f"Stage {k + 1}", names[k], names[k + 1], m0, m1)
        out.append(TrackInput(k + 1, title, names[k], names[k + 1], NOT_RATED, line.slice(m0, m1), tracks[0].index))
    return out


def load_waypoints(gpx_path: Path) -> list[GpxWaypoint]:
    return read_gpx(gpx_path).waypoints
