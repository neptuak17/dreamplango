"""Elevation profile, gradient events and climbs from a terrain model sampled along the route."""

from collections.abc import Callable
from dataclasses import dataclass

import numpy as np
from scipy.ndimage import grey_opening, median_filter
from scipy.signal import savgol_filter

from dpg_audit.lrs import RoutePath
from dpg_audit.models import Climb, Event

STEP_M = 25.0
GRADE_BIN_M = 100.0
STRUCTURE_PAD_M = 15.0
IMPLAUSIBLE_GRADE = 25.0
"""Grades beyond this over 100 m are terrain-model artefacts on a cycle route, reported as unknown."""
GRADE_CLASSES = [
    (2, "flat"),
    (4, "gentle"),
    (6, "moderate"),
    (8, "steep"),
    (10, "very_steep"),
    (float("inf"), "extreme"),
]

Sampler = Callable[[np.ndarray, np.ndarray], np.ndarray]


@dataclass
class PartProfile:
    m: np.ndarray
    """Path measures of the samples."""
    ele: np.ndarray
    """Smoothed elevation (NaN where nothing usable)."""
    raw: np.ndarray
    trusted: np.ndarray | None = None
    """Per-sample flag; False where the track geometry itself is a placeholder (see mark_untrusted)."""


def mark_untrusted(profs: list[PartProfile], ranges: list[tuple[float, float]]) -> None:
    """Flag samples inside `ranges` (path measures) as untrusted for gradient statistics."""
    for p in profs:
        mask = np.ones(p.m.size, dtype=bool)
        for r0, r1 in ranges:
            mask &= ~((p.m >= r0) & (p.m <= r1))
        p.trusted = mask


def _fill_nans(m: np.ndarray, v: np.ndarray) -> np.ndarray:
    ok = ~np.isnan(v)
    if ok.sum() < 2:
        return v
    return np.interp(m, m[ok], v[ok])


def smooth(v: np.ndarray) -> np.ndarray:
    """Turn surface-model samples along a road into a plausible road profile.

    1. A grey-scale opening (125 m) removes narrow upward spikes: buildings, trees and cliff edges next to the
       road. Roads run below what stands beside them, so the lower envelope is the better estimate.
    2. A 125 m median removes what is left of single-sample noise.
    3. A 225 m Savitzky–Golay filter smooths while keeping real climbs.
    """
    if v.size < 9 or np.isnan(v).all():
        return v
    out = grey_opening(v, size=5, mode="nearest")
    out = median_filter(out, size=5, mode="nearest")
    return savgol_filter(out, window_length=9, polyorder=2, mode="interp")


def profiles(path: RoutePath, sampler: Sampler, structures: list[tuple[float, float]]) -> list[PartProfile]:
    out = []
    for part in path.parts:
        line = part.line.resample(STEP_M)
        m = part.from_m + line.cum
        raw = sampler(line.lon, line.lat)
        masked = raw.copy()
        for s0, s1 in structures:
            if s1 < part.from_m or s0 > part.to_m:
                continue
            masked[(m > s0 - STRUCTURE_PAD_M) & (m < s1 + STRUCTURE_PAD_M)] = np.nan
        out.append(PartProfile(m=m, ele=smooth(_fill_nans(m, masked)), raw=raw))
    return out


def at(profs: list[PartProfile], ms: np.ndarray) -> np.ndarray:
    """Elevation at arbitrary path measures (NaN where no profile)."""
    out = np.full(ms.shape, np.nan)
    for p in profs:
        if p.m.size < 2:
            continue
        sel = (ms >= p.m[0]) & (ms <= p.m[-1])
        out[sel] = np.interp(ms[sel], p.m, p.ele)
    return out


def grade_class(grade_pct: float) -> str:
    g = abs(grade_pct)
    return next(name for limit, name in GRADE_CLASSES if g < limit)


def _inside(a: float, b: float, ranges: list[tuple[float, float]]) -> bool:
    return any(a < r1 and b > r0 for r0, r1 in ranges)


def gradient_events(profs: list[PartProfile], untrusted: list[tuple[float, float]] | None = None) -> list[Event]:
    """Gradient classes per 100 m. Bins overlapping `untrusted` ranges (e.g. straight-line placeholder track,
    where the terrain under the chord says nothing about the real road) are reported as unknown."""
    untrusted = untrusted or []
    events: list[Event] = []
    for p in profs:
        if p.m.size < 2 or np.isnan(p.ele).all():
            if p.m.size >= 2:
                events.append(
                    Event(
                        layer="gradient",
                        from_m=round(p.m[0], 1),
                        to_m=round(p.m[-1], 1),
                        value="unknown",
                        confidence="low",
                    )
                )
            continue
        edges = np.append(np.arange(p.m[0], p.m[-1], GRADE_BIN_M), p.m[-1])
        ele = np.interp(edges, p.m, p.ele)
        for a, b, ea, eb in zip(edges[:-1], edges[1:], ele[:-1], ele[1:], strict=True):
            if b - a < 1:
                continue
            grade = (eb - ea) / (b - a) * 100
            implausible = abs(grade) > IMPLAUSIBLE_GRADE or _inside(a, b, untrusted)
            value = "unknown" if implausible else grade_class(grade)
            last = events[-1] if events else None
            if last and last.value == value and abs(last.to_m - a) < 0.2:
                last.to_m = round(b, 1)
                last.detail["max_grade"] = max(last.detail.get("max_grade", 0.0), round(grade, 1), key=abs)
            else:
                events.append(
                    Event(
                        layer="gradient",
                        from_m=round(a, 1),
                        to_m=round(b, 1),
                        value=value,
                        confidence="low" if value == "unknown" else "medium",
                        detail={"max_grade": round(grade, 1)},
                    )
                )
    return events


def _extrema(ele: np.ndarray, threshold: float) -> list[int]:
    """Turning points of a zig-zag (hysteresis) filter: wiggles smaller than `threshold` metres are ignored.

    Always starts at 0 and ends at the last index.
    """
    n = ele.size
    if n < 2:
        return list(range(n))
    pivots = [0]
    trend, cand = 0, 0
    for i in range(1, n):
        if trend == 0:
            if ele[i] - ele[0] >= threshold:
                trend, cand = 1, i
            elif ele[0] - ele[i] >= threshold:
                trend, cand = -1, i
        elif trend == 1:
            if ele[i] > ele[cand]:
                cand = i
            elif ele[cand] - ele[i] >= threshold:
                pivots.append(cand)
                trend, cand = -1, i
        elif ele[i] < ele[cand]:
            cand = i
        elif ele[i] - ele[cand] >= threshold:
            pivots.append(cand)
            trend, cand = 1, i
    if trend != 0 and cand != pivots[-1]:
        pivots.append(cand)
    if pivots[-1] != n - 1:
        pivots.append(n - 1)
    return pivots


def ascent_descent(profs: list[PartProfile], m0: float, m1: float, threshold: float = 3.0) -> tuple[float, float]:
    up = down = 0.0
    for p in profs:
        sel = (p.m >= m0) & (p.m <= m1) & ~np.isnan(p.ele)
        e = p.ele[sel]
        if e.size < 2:
            continue
        ext = _extrema(e, threshold)
        d = np.diff(e[ext])
        up += float(d[d > 0].sum())
        down += float(-d[d < 0].sum())
    return up, down


def max_grade_window(profs: list[PartProfile], m0: float, m1: float, window_m: float = 500.0) -> float | None:
    """Steepest average gradient (%) over `window_m` within [m0, m1], in the direction of travel.

    Windows touching untrusted samples, or with an implausible grade (terrain-model artefacts), are ignored.
    """
    best = None
    n = int(window_m / STEP_M)
    for p in profs:
        sel = (p.m >= m0) & (p.m <= m1)
        e, m = p.ele[sel], p.m[sel]
        if e.size <= n or np.isnan(e).any():
            continue
        g = (e[n:] - e[:-n]) / (m[n:] - m[:-n]) * 100
        ok = np.abs(g) <= IMPLAUSIBLE_GRADE
        if p.trusted is not None:
            t = p.trusted[sel]
            ok &= t[n:] & t[:-n]
        if not ok.any():
            continue
        top = float(g[ok].max())
        best = top if best is None else max(best, top)
    return None if best is None else round(best, 1)


def fiets(gain: float, length: float, top: float) -> float:
    return gain**2 / (length * 10) + max(0.0, (top - 1000) / 1000)


def climbs(
    profs: list[PartProfile],
    min_gain: float = 40.0,
    min_grade: float = 2.5,
    untrusted: list[tuple[float, float]] | None = None,
) -> list[Climb]:
    """Climbs in both directions of travel, from hysteresis legs of the smoothed profile (none on `untrusted`)."""
    untrusted = untrusted or []
    out: list[Climb] = []
    n500 = int(500 / STEP_M)
    for p in profs:
        e = p.ele
        if e.size < 3 or np.isnan(e).any():
            continue
        ext = _extrema(e, 15.0)
        for a, b in zip(ext[:-1], ext[1:], strict=True):
            # Trim flat run-ins and run-outs: the climb starts where the road leaves its low point and ends
            # where it reaches its high point (within 1 m).
            lo, hi = (a, b) if e[b] > e[a] else (b, a)
            low_band = np.nonzero(e[a : b + 1] <= e[lo] + 1.0)[0] + a
            high_band = np.nonzero(e[a : b + 1] >= e[hi] - 1.0)[0] + a
            if e[b] > e[a]:
                a, b = int(low_band.max()), int(high_band.min())
            else:
                a, b = int(high_band.max()), int(low_band.min())
            if b <= a:
                continue
            gain = float(e[b] - e[a])
            length = float(p.m[b] - p.m[a])
            if length <= 0 or abs(gain) < min_gain or abs(gain) / length * 100 < min_grade:
                continue
            if abs(gain) / length * 100 > IMPLAUSIBLE_GRADE * 0.8:
                continue  # a "climb" steeper than 20% on average is a terrain-model artefact, not a road
            if _inside(float(p.m[a]), float(p.m[b]), untrusted):
                continue
            seg = e[a : b + 1] if gain > 0 else e[a : b + 1][::-1]
            ms = p.m[a : b + 1]
            if seg.size > n500:
                mg = float(((seg[n500:] - seg[:-n500]) / (n500 * STEP_M) * 100).max())
            else:
                mg = abs(gain) / length * 100
            top = float(max(e[a], e[b]))
            out.append(
                Climb(
                    from_m=round(float(ms[0]), 1),
                    to_m=round(float(ms[-1]), 1),
                    length_m=round(length, 1),
                    gain_m=round(abs(gain), 1),
                    avg_grade=round(abs(gain) / length * 100, 1),
                    max_grade_500m=round(mg, 1),
                    top_m=round(top, 1),
                    fiets=round(fiets(abs(gain), length, top), 2),
                    direction="forward" if gain > 0 else "reverse",
                )
            )
    return out
