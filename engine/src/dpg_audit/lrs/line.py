"""A polyline with cumulative geodesic measures.

Measures are exact geodesic lengths along the vertex sequence. Positions *between* vertices are interpolated
linearly in lon/lat, as GeoJSON renderers draw them. Inside one segment, the measure of an interpolated point can
therefore differ from its true geodesic distance by a fraction of about tan(lat) * dlat (radians) of the segment
length. That is millimetres for typical 30-100 m GPX segments, ~10 cm for a 1 km segment, and metres only on
multi-kilometre straight lines (which are flagged as findings anyway). The antimeridian is not handled.
"""

from dataclasses import dataclass

import numpy as np

from dpg_audit.lrs.geodesy import distance, local_scale, segment_lengths


@dataclass(frozen=True)
class Projection:
    m: float
    """Measure of the closest point on the line, metres from the start."""
    offset_m: float
    """Geodesic distance from the query point to the line."""
    side: int
    """+1 if the point is left of the direction of travel, -1 if right, 0 if on the line."""
    lon: float
    lat: float
    segment: int


class MeasuredLine:
    def __init__(self, lon, lat, ele=None):
        self.lon = np.asarray(lon, dtype=float)
        self.lat = np.asarray(lat, dtype=float)
        if self.lon.shape != self.lat.shape or self.lon.ndim != 1:
            raise ValueError("lon and lat must be 1-D arrays of equal length")
        if self.lon.size < 2:
            raise ValueError("a line needs at least two points")
        self.ele = None if ele is None else np.asarray(ele, dtype=float)
        if self.ele is not None and self.ele.shape != self.lon.shape:
            raise ValueError("ele must match lon/lat")
        self.seg_len = segment_lengths(self.lon, self.lat)
        self.cum = np.concatenate([[0.0], np.cumsum(self.seg_len)])

    def __len__(self) -> int:
        return int(self.lon.size)

    @property
    def length(self) -> float:
        return float(self.cum[-1])

    def _segment_at(self, m: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        idx = np.clip(np.searchsorted(self.cum, m, side="right") - 1, 0, self.lon.size - 2)
        seg = self.seg_len[idx]
        t = np.divide(m - self.cum[idx], seg, out=np.zeros_like(m), where=seg > 0)
        return idx, np.clip(t, 0.0, 1.0)

    def locate(self, m):
        """Coordinates at measure(s) m (clamped to [0, length]). Returns (lon, lat) floats or arrays."""
        scalar = np.isscalar(m)
        mm = np.clip(np.atleast_1d(np.asarray(m, dtype=float)), 0.0, self.length)
        idx, t = self._segment_at(mm)
        lon = self.lon[idx] + t * (self.lon[idx + 1] - self.lon[idx])
        lat = self.lat[idx] + t * (self.lat[idx + 1] - self.lat[idx])
        return (float(lon[0]), float(lat[0])) if scalar else (lon, lat)

    def elevation_at(self, m):
        """Interpolated elevation at measure(s) m, or None if the line has no elevation."""
        if self.ele is None:
            return None
        scalar = np.isscalar(m)
        mm = np.clip(np.atleast_1d(np.asarray(m, dtype=float)), 0.0, self.length)
        idx, t = self._segment_at(mm)
        ele = self.ele[idx] + t * (self.ele[idx + 1] - self.ele[idx])
        return float(ele[0]) if scalar else ele

    def slice(self, m0: float, m1: float) -> "MeasuredLine":
        """Sub-line between two measures (m0 < m1), including interpolated end points."""
        m0, m1 = max(0.0, m0), min(self.length, m1)
        if not m1 > m0:
            raise ValueError("slice needs m0 < m1 within the line")
        inner = np.nonzero((self.cum > m0) & (self.cum < m1))[0]
        ms = np.concatenate([[m0], self.cum[inner], [m1]])
        lon, lat = self.locate(ms)
        lon[1:-1], lat[1:-1] = self.lon[inner], self.lat[inner]
        ele = self.elevation_at(ms)
        if ele is not None:
            ele[1:-1] = self.ele[inner]
        return MeasuredLine(lon, lat, ele)

    def resample(self, step_m: float) -> "MeasuredLine":
        """Points every `step_m` metres from the start, plus the end point."""
        if step_m <= 0:
            raise ValueError("step must be positive")
        ms = np.arange(0.0, self.length, step_m)
        ms = np.append(ms, self.length) if ms.size == 0 or ms[-1] < self.length else ms
        if ms.size < 2:
            ms = np.array([0.0, self.length])
        lon, lat = self.locate(ms)
        return MeasuredLine(lon, lat, self.elevation_at(ms))

    def reversed(self) -> "MeasuredLine":
        return MeasuredLine(self.lon[::-1], self.lat[::-1], None if self.ele is None else self.ele[::-1])

    def project(self, lon: float, lat: float) -> Projection:
        """Closest point on the line to (lon, lat).

        The search runs in a local tangent plane centred on the query point, which is exact enough near the
        answer; the reported offset is then the true geodesic distance to the foot point.
        """
        kx, ky = local_scale(lat)
        ax = (self.lon[:-1] - lon) * kx
        ay = (self.lat[:-1] - lat) * ky
        dx = (self.lon[1:] - lon) * kx - ax
        dy = (self.lat[1:] - lat) * ky - ay
        seg2 = dx * dx + dy * dy
        t = np.divide(-(ax * dx + ay * dy), seg2, out=np.zeros_like(seg2), where=seg2 > 0)
        t = np.clip(t, 0.0, 1.0)
        fx, fy = ax + t * dx, ay + t * dy
        i = int(np.argmin(fx * fx + fy * fy))
        ti = float(t[i])
        foot_lon = float(self.lon[i] + ti * (self.lon[i + 1] - self.lon[i]))
        foot_lat = float(self.lat[i] + ti * (self.lat[i + 1] - self.lat[i]))
        offset = distance(lon, lat, foot_lon, foot_lat)
        cross = dx[i] * (-ay[i]) - dy[i] * (-ax[i])
        side = 0 if offset < 1e-6 else (1 if cross > 0 else -1)
        m = float(self.cum[i] + ti * self.seg_len[i])
        return Projection(m=m, offset_m=offset, side=side, lon=foot_lon, lat=foot_lat, segment=i)
