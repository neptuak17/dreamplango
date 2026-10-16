"""Comfort, best-time and direction scores per section and month (11.4). Simple by design (D34); a missing input
is left out, the remaining weights are rescaled, and the gap is named (D37)."""

from dpg_audit.models import Direction


def _ramp(x: float, zero: float, full: float) -> float:
    """0 at `zero`, 1 at `full`, linear between (either order)."""
    if zero == full:
        return 1.0 if x >= full else 0.0
    t = (x - zero) / (full - zero)
    return min(1.0, max(0.0, t))


def temperature_part(tmax: float, cfg: dict) -> float:
    if cfg["ideal_min_c"] <= tmax <= cfg["ideal_max_c"]:
        return 1.0
    if tmax < cfg["ideal_min_c"]:
        return _ramp(tmax, cfg["zero_low_c"], cfg["ideal_min_c"])
    return _ramp(tmax, cfg["zero_high_c"], cfg["ideal_max_c"])


def comfort(
    tmax: float | None,
    rain_days: float | None,
    daylight_h: float | None,
    windy_days: float | None,
    heat_days: float | None,
    cfg: dict,
) -> float | None:
    """0-100, or None when there is no climate data at all."""
    w = cfg["weights"]
    parts: list[tuple[float, float]] = []
    if tmax is not None:
        parts.append((w["temperature"], temperature_part(tmax, cfg["temperature"])))
    if rain_days is not None:
        parts.append((w["rain"], 1 - min(rain_days / cfg["rain_zero_share"], 1.0)))
    if daylight_h is not None:
        parts.append((w["daylight"], _ramp(daylight_h, cfg["daylight"]["zero_h"], cfg["daylight"]["full_h"])))
    if windy_days is not None:
        parts.append((w["wind"], 1 - min(windy_days / cfg["windy_zero_share"], 1.0)))
    if tmax is None and rain_days is None:
        return None  # daylight alone says too little to call it comfort
    total = sum(wt for wt, _ in parts)
    score = 100 * sum(wt * v for wt, v in parts) / total
    if heat_days is not None:
        score -= cfg["heat_penalty"] * heat_days
    return round(max(0.0, score), 1)


def comfort_label(score: float | None, labels: list) -> str | None:
    if score is None:
        return None
    return next(name for limit, name in labels if score >= limit)


def best_time(
    comfort_score: float | None,
    services_open: float | None,
    tourism_rel: float | None,
    school_share: float | None,
    cfg: dict,
) -> tuple[float | None, list[str]]:
    """Weighted mix of comfort, services open and quietness; returns (score, missing input names)."""
    w = cfg["weights"]
    q = cfg["quietness"]
    missing: list[str] = []
    quiet_parts = []
    if tourism_rel is not None:
        quiet_parts.append((q["tourism"], 1 - min(max(tourism_rel, 0.0), 1.0)))
    else:
        missing.append("tourism")
    if school_share is not None:
        quiet_parts.append((q["school"], 1 - min(max(school_share, 0.0), 1.0)))
    else:
        missing.append("school holidays")
    quiet = sum(a * b for a, b in quiet_parts) / sum(a for a, _ in quiet_parts) if quiet_parts else None

    parts = []
    if comfort_score is not None:
        parts.append((w["comfort"], comfort_score / 100))
    else:
        missing.append("climate")
    if services_open is not None:
        parts.append((w["services"], services_open))
    else:
        missing.append("opening seasons")
    if quiet is not None:
        parts.append((w["quietness"], quiet))
    if comfort_score is None or not parts:
        return None, missing  # without climate the "best time" would mean little
    total = sum(a for a, _ in parts)
    return round(100 * sum(a * b for a, b in parts) / total, 1), missing


def direction(wind_along_fwd: float | None, ascent_fwd: float | None, ascent_rev: float | None, cfg: dict) -> Direction:
    """Forward or reverse from mean along-route wind and the difference in climbing."""
    climb_diff = None if ascent_fwd is None or ascent_rev is None else ascent_rev - ascent_fwd
    if wind_along_fwd is None and climb_diff is None:
        return Direction(advice="unknown", wind_along_ms=None, climb_diff_m=None)
    score = (wind_along_fwd or 0.0) / cfg["wind_scale_ms"] + (climb_diff or 0.0) / cfg["climb_scale_m"]
    advice = "either" if abs(score) < cfg["either_below"] else ("forward" if score > 0 else "reverse")
    return Direction(
        advice=advice,  # type: ignore[arg-type]
        wind_along_ms=None if wind_along_fwd is None else round(wind_along_fwd, 2),
        climb_diff_m=None if climb_diff is None else round(climb_diff),
    )
