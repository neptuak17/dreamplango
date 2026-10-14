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


def read_tracks(path: Path) -> list[GpxTrack]:
    with open(path, encoding="utf-8") as f:
        gpx = gpxpy.parse(f)
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
