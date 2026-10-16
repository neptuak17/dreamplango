"""Day length from the sun's position (NOAA solar declination and the standard sunrise elevation of -0.833°)."""

import math
from datetime import date


def declination(day_of_year: int) -> float:
    """Solar declination in radians (NOAA fractional-year series)."""
    g = 2 * math.pi / 365 * (day_of_year - 1)
    return (
        0.006918
        - 0.399912 * math.cos(g)
        + 0.070257 * math.sin(g)
        - 0.006758 * math.cos(2 * g)
        + 0.000907 * math.sin(2 * g)
        - 0.002697 * math.cos(3 * g)
        + 0.00148 * math.sin(3 * g)
    )


def day_length_h(lat: float, day: date, sun_elevation_deg: float = -0.833) -> float:
    """Hours the sun is above `sun_elevation_deg` (sunrise to sunset by default)."""
    phi = math.radians(lat)
    delta = declination(day.timetuple().tm_yday)
    h0 = math.radians(sun_elevation_deg)
    cos_w = (math.sin(h0) - math.sin(phi) * math.sin(delta)) / (math.cos(phi) * math.cos(delta))
    if cos_w <= -1:
        return 24.0  # midnight sun
    if cos_w >= 1:
        return 0.0  # polar night
    return 2 * math.degrees(math.acos(cos_w)) / 15.0


def monthly_day_length(lat: float, year: int) -> list[float]:
    """Day length on the 15th of each month."""
    return [round(day_length_h(lat, date(year, m, 15)), 2) for m in range(1, 13)]
