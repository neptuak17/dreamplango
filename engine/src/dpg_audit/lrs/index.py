"""Spatial index over a route path, for projecting many points (places) onto it quickly.

Candidate search runs in ETRS89-LAEA metres (EPSG:3035), which is close enough to find the nearest segment; the
reported measures and offsets are then computed exactly (geodesic) on the chosen part.
"""

from dataclasses import dataclass

import numpy as np
import shapely
from pyproj import Transformer
from scipy.spatial import cKDTree

from dpg_audit.lrs.line import Projection
from dpg_audit.lrs.path import RoutePath

_TO_LAEA = Transformer.from_crs("EPSG:4326", "EPSG:3035", always_xy=True)
LAEA_SLACK = 1.12
"""LAEA distances can be a few per cent off far from its centre (e.g. Cyprus); pre-filters widen by this factor."""


def to_laea(lon, lat) -> tuple[np.ndarray, np.ndarray]:
    x, y = _TO_LAEA.transform(np.asarray(lon, dtype=float), np.asarray(lat, dtype=float))
    return np.asarray(x), np.asarray(y)


@dataclass
class RouteSamples:
    """Points every `step_m` along the ridden path (path measures), with a KD-tree in LAEA metres."""

    m: np.ndarray
    lon: np.ndarray
    lat: np.ndarray
    tree: cKDTree

    def near(self, lon: float, lat: float, radius_m: float, limit: int) -> np.ndarray:
        """Indices of samples within `radius_m` of the point, nearest first, at most `limit` (at least 1)."""
        x, y = to_laea(lon, lat)
        dist, idx = self.tree.query([float(x), float(y)], k=limit, distance_upper_bound=radius_m * LAEA_SLACK)
        idx = np.atleast_1d(idx)[np.isfinite(np.atleast_1d(dist))]
        if idx.size == 0:
            _, idx = self.tree.query([float(x), float(y)], k=1)
            idx = np.atleast_1d(idx)
        return idx.astype(int)


class RouteIndex:
    def __init__(self, path: RoutePath):
        self.path = path
        geoms, owners = [], []
        for pi, part in enumerate(path.parts):
            x, y = to_laea(part.line.lon, part.line.lat)
            coords = np.stack([np.stack([x[:-1], y[:-1]], 1), np.stack([x[1:], y[1:]], 1)], 1)
            geoms.append(shapely.linestrings(coords))
            owners.append(np.full(len(coords), pi))
        self.segments = np.concatenate(geoms)
        self.owner = np.concatenate(owners)
        self.tree = shapely.STRtree(self.segments)

    def within(self, lon: np.ndarray, lat: np.ndarray, radius_m: np.ndarray | float) -> np.ndarray:
        """Boolean mask: points within roughly `radius_m` of the route (generous; refine with `project`)."""
        x, y = to_laea(lon, lat)
        pts = shapely.points(x, y)
        radius = np.broadcast_to(np.asarray(radius_m, dtype=float) * LAEA_SLACK, pts.shape)
        hits = self.tree.query(pts, predicate="dwithin", distance=radius)
        mask = np.zeros(pts.shape, dtype=bool)
        mask[hits[0]] = True
        return mask

    def project(self, lon: np.ndarray, lat: np.ndarray) -> list[Projection]:
        """Exact projections (path measures) of each point onto its nearest part."""
        x, y = to_laea(lon, lat)
        pts = shapely.points(x, y)
        point_idx, seg_idx = self.tree.query_nearest(pts, all_matches=False)
        nearest = np.empty(pts.shape, dtype=int)
        nearest[point_idx] = seg_idx
        out: list[Projection] = []
        for i, s in enumerate(nearest):
            part = self.path.parts[int(self.owner[s])]
            p = part.line.project(float(lon[i]), float(lat[i]))
            out.append(Projection(p.m + part.from_m, p.offset_m, p.side, p.lon, p.lat, p.segment))
        return out

    def samples(self, step_m: float) -> RouteSamples:
        ms, lons, lats = [], [], []
        for part in self.path.parts:
            local = np.append(np.arange(0.0, part.line.length, step_m), part.line.length)
            lon, lat = part.line.locate(local)
            ms.append(local + part.from_m)
            lons.append(np.atleast_1d(lon))
            lats.append(np.atleast_1d(lat))
        m, lon, lat = np.concatenate(ms), np.concatenate(lons), np.concatenate(lats)
        x, y = to_laea(lon, lat)
        return RouteSamples(m=m, lon=lon, lat=lat, tree=cKDTree(np.stack([x, y], 1)))
