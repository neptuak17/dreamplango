"""Geodesic helpers on the WGS84 ellipsoid (pyproj / Karney's algorithms)."""

import math

import numpy as np
from pyproj import Geod

WGS84 = Geod(ellps="WGS84")
_A = 6378137.0
_E2 = 6.69437999014e-3


def segment_lengths(lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """Geodesic length of each consecutive segment, metres (len = n - 1)."""
    lon = np.asarray(lon, dtype=float)
    lat = np.asarray(lat, dtype=float)
    if lon.size < 2:
        return np.zeros(0)
    _, _, dist = WGS84.inv(lon[:-1], lat[:-1], lon[1:], lat[1:])
    return np.asarray(dist, dtype=float)


def distance(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    """Geodesic distance between two points, metres."""
    _, _, dist = WGS84.inv(lon1, lat1, lon2, lat2)
    return float(dist)


def local_scale(lat: float) -> tuple[float, float]:
    """Metres per degree of longitude and latitude at `lat` (ellipsoidal radii of curvature).

    Accurate to well under a metre over a few kilometres, which is all the local-plane maths needs.
    """
    phi = math.radians(lat)
    s2 = math.sin(phi) ** 2
    n = _A / math.sqrt(1 - _E2 * s2)  # prime vertical
    m = _A * (1 - _E2) / (1 - _E2 * s2) ** 1.5  # meridional
    return math.radians(1) * n * math.cos(phi), math.radians(1) * m
