"""Generic GPX reading: tracks (and their segments) as coordinate arrays."""

from dataclasses import dataclass
from pathlib import Path

import gpxpy
import numpy as np


@dataclass
class GpxTrack:
    index: int
    """Position of the track in the file (0-based)."""
    name: str
    description: str
    lon: np.ndarray
    lat: np.ndarray
    ele: np.ndarray | None
    segment_breaks: list[int]
    """Indices where a new <trkseg> starts (excluding 0). Segments are concatenated in file order."""

    @property
    def point_count(self) -> int:
        return int(self.lon.size)


@dataclass
class GpxWaypoint:
    lon: float
    lat: float
    ele: float | None
    name: str
    kind: str
    """The waypoint's <type>, else its <sym>; empty when it has neither."""
    note: str
    """Its <cmt> and <desc>, joined."""


@dataclass
class GpxFile:
    name: str
    description: str
    tracks: list[GpxTrack]
    """The file's tracks; when it has none, its planned routes (<rte>) in their place."""
    waypoints: list[GpxWaypoint]


def _parse(path: Path) -> gpxpy.gpx.GPX:
    with open(path, encoding="utf-8") as f:
        return gpxpy.parse(f)


def read_tracks(path: Path) -> list[GpxTrack]:
    return _tracks(_parse(path))


def read_gpx(path: Path) -> GpxFile:
    """Everything a rider's file holds (D22): tracks or planned routes, waypoints and the file's own name."""
    gpx = _parse(path)
    tracks = _tracks(gpx) or _routes(gpx)
    first = next((t.name for t in tracks if t.name), "")
    waypoints = [
        GpxWaypoint(
            lon=w.longitude,
            lat=w.latitude,
            ele=w.elevation,
            name=(w.name or "").strip(),
            kind=(w.type or w.symbol or "").strip(),
            note=" ".join(x.strip() for x in (w.comment, w.description) if x and x.strip()),
        )
        for w in gpx.waypoints
    ]
    return GpxFile(
        name=(gpx.name or first or "").strip(),
        description=(gpx.description or "").strip(),
        tracks=tracks,
        waypoints=waypoints,
    )


def _routes(gpx: gpxpy.gpx.GPX) -> list[GpxTrack]:
    out = []
    for i, rte in enumerate(gpx.routes):
        ele = np.asarray([np.nan if p.elevation is None else p.elevation for p in rte.points], dtype=float)
        out.append(
            GpxTrack(
                index=i,
                name=(rte.name or "").strip(),
                description=(rte.description or "").strip(),
                lon=np.asarray([p.longitude for p in rte.points], dtype=float),
                lat=np.asarray([p.latitude for p in rte.points], dtype=float),
                ele=None if ele.size == 0 or np.all(np.isnan(ele)) else ele,
                segment_breaks=[],
            )
        )
    return out


def _tracks(gpx: gpxpy.gpx.GPX) -> list[GpxTrack]:
    tracks: list[GpxTrack] = []
    for i, trk in enumerate(gpx.tracks):
        lon: list[float] = []
        lat: list[float] = []
        ele: list[float] = []
        breaks: list[int] = []
        for seg in trk.segments:
            if lon and seg.points:
                breaks.append(len(lon))
            for p in seg.points:
                lon.append(p.longitude)
                lat.append(p.latitude)
                ele.append(np.nan if p.elevation is None else p.elevation)
        ele_arr = np.asarray(ele, dtype=float)
        tracks.append(
            GpxTrack(
                index=i,
                name=(trk.name or "").strip(),
                description=(trk.description or "").strip(),
                lon=np.asarray(lon, dtype=float),
                lat=np.asarray(lat, dtype=float),
                ele=None if ele_arr.size == 0 or np.all(np.isnan(ele_arr)) else ele_arr,
                segment_breaks=breaks,
            )
        )
    return tracks
