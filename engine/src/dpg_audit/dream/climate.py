"""ERA5 climate from the Copernicus Climate Data Store (D34).

One request per climate point (every ~100 km of route) to the "ERA5 hourly time-series data on single levels"
dataset, cached as the downloaded zip. Hourly values are reduced to daily ones (UTC days), and each daily section
gets monthly normals from its nearest point. The CDS key lives in ~/.cdsapirc (created by the owner); the dataset
licence (CC-BY) must have been accepted on the CDS website.
"""

import csv
import hashlib
import io
import zipfile
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

from dpg_audit.lrs.geodesy import distance
from dpg_audit.lrs.path import RoutePath
from dpg_audit.models import Licence, SourceSnapshot

DATASET = "reanalysis-era5-single-levels-timeseries"
DATASET_URL = f"https://cds.climate.copernicus.eu/datasets/{DATASET}"
VARIABLES = ["2m_temperature", "total_precipitation", "10m_u_component_of_wind", "10m_v_component_of_wind"]
LICENCE = Licence(id="CC-BY-4.0", name="Creative Commons Attribution 4.0", url=DATASET_URL)
ATTRIBUTION = "Contains modified Copernicus Climate Change Service information ({years}): ERA5 (DOI 10.24381/1cf1ad76)"


@dataclass
class ClimatePoint:
    m: float
    lon: float
    lat: float


@dataclass
class Daily:
    """Daily values at one ERA5 grid point."""

    grid: tuple[float, float]
    month: np.ndarray
    """0-11 for each day"""
    tmax: np.ndarray
    tmin: np.ndarray
    rain_mm: np.ndarray
    u: np.ndarray
    v: np.ndarray
    speed: np.ndarray


def climate_points(path: RoutePath, spacing_m: float) -> list[ClimatePoint]:
    """Points every `spacing_m` along the path, centred in each interval."""
    out = []
    m = spacing_m / 2
    while m < path.length:
        lon, lat = path.locate(m)
        out.append(ClimatePoint(m, lon, lat))
        m += spacing_m
    if not out:
        lon, lat = path.locate(path.length / 2)
        out.append(ClimatePoint(path.length / 2, lon, lat))
    return out


def nearest_point(points: list[ClimatePoint], lon: float, lat: float) -> tuple[int, float]:
    dists = [distance(lon, lat, p.lon, p.lat) for p in points]
    i = int(np.argmin(dists))
    return i, float(dists[i])


def _cache_path(cache: Path, p: ClimatePoint, years: tuple[int, int]) -> Path:
    return cache / f"era5ts_{p.lat:.2f}_{p.lon:.2f}_{years[0]}-{years[1]}.zip"


def fetch_point(p: ClimatePoint, years: tuple[int, int], cache: Path, retries: int = 2) -> Path:
    import cdsapi  # imported lazily: only audits that build Dream data need it

    target = _cache_path(cache, p, years)
    if target.exists() and target.stat().st_size > 0:
        return target
    cache.mkdir(parents=True, exist_ok=True)
    request = {
        "variable": VARIABLES,
        "location": {"longitude": round(p.lon, 2), "latitude": round(p.lat, 2)},
        "date": [f"{years[0]}-01-01/{years[1]}-12-31"],
        "data_format": "csv",
    }
    tmp = target.with_suffix(".part")
    last: Exception | None = None
    for _ in range(retries + 1):
        try:
            cdsapi.Client(quiet=True, progress=False).retrieve(DATASET, request, str(tmp))
            tmp.replace(target)
            return target
        except Exception as err:  # the client raises plain exceptions with the API's message
            last = err
    raise RuntimeError(f"ERA5 request failed at {p.lat:.2f},{p.lon:.2f}: {last}")


def read_daily(zip_path: Path) -> Daily:
    """Hourly CSV (valid_time,u10,v10,t2m,tp,latitude,longitude) -> daily values."""
    with zipfile.ZipFile(zip_path) as z:
        name = next(n for n in z.namelist() if n.endswith(".csv"))
        text = z.read(name).decode("utf-8")
    reader = csv.DictReader(io.StringIO(text))
    days, u, v, t, tp = [], [], [], [], []
    grid = (0.0, 0.0)
    for row in reader:
        days.append(row["valid_time"][:10])
        u.append(float(row["u10"]))
        v.append(float(row["v10"]))
        t.append(float(row["t2m"]))
        tp.append(float(row["tp"]))
        grid = (float(row["longitude"]), float(row["latitude"]))
    keys = np.array(days)
    starts = np.concatenate([[0], np.nonzero(keys[1:] != keys[:-1])[0] + 1])
    ua, va, ta, pa = (np.array(x, dtype=float) for x in (u, v, t, tp))
    speed = np.hypot(ua, va)
    counts = np.diff(np.append(starts, len(keys)))
    month = np.array([int(k[5:7]) - 1 for k in keys[starts]])
    return Daily(
        grid=grid,
        month=month,
        tmax=np.maximum.reduceat(ta, starts) - 273.15,
        tmin=np.minimum.reduceat(ta, starts) - 273.15,
        rain_mm=np.add.reduceat(pa, starts) * 1000.0,
        u=np.add.reduceat(ua, starts) / counts,
        v=np.add.reduceat(va, starts) / counts,
        speed=np.add.reduceat(speed, starts) / counts,
    )


def fetch_all(
    points: list[ClimatePoint],
    years: tuple[int, int],
    cache: Path,
    workers: int,
    log: Callable[[str], None] = print,
) -> tuple[list[Daily | None], list[Path]]:
    """Daily series per point (None where the request failed), and the cached files used."""
    todo = sum(not _cache_path(cache, p, years).exists() for p in points)
    if todo:
        log(f"ERA5: requesting {todo} of {len(points)} climate points from the CDS ({workers} at a time) …")

    def one(p: ClimatePoint) -> tuple[Daily | None, Path | None]:
        try:
            path = fetch_point(p, years, cache)
            return read_daily(path), path
        except Exception as err:  # keep going: a missing point becomes "no data" for its sections (D37)
            log(f"  {err}")
            return None, None

    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        results = list(pool.map(one, points))
    return [d for d, _ in results], [p for _, p in results if p is not None]


def _per_month(values: np.ndarray, month: np.ndarray) -> list[float | None]:
    out: list[float | None] = []
    for mo in range(12):
        sel = values[month == mo]
        out.append(round(float(sel.mean()), 3) if sel.size else None)
    return out


def monthly(daily: Daily, heading: tuple[float, float], cfg: dict) -> dict[str, list[float | None]]:
    """Monthly normals; `heading` is the section's mean unit direction of travel (east, north)."""
    hx, hy = heading
    along = daily.u * hx + daily.v * hy
    head = float(cfg["headwind_ms"])
    return {
        "tmax_c": _per_month(daily.tmax, daily.month),
        "tmin_c": _per_month(daily.tmin, daily.month),
        "rain_days": _per_month((daily.rain_mm >= float(cfg["rain_day_mm"])).astype(float), daily.month),
        "rain_mm": _per_month(daily.rain_mm, daily.month),
        "heat_days": _per_month((daily.tmax >= float(cfg["heat_day_c"])).astype(float), daily.month),
        "windy_days": _per_month((daily.speed >= float(cfg["windy_day_ms"])).astype(float), daily.month),
        "wind_along_ms": _per_month(along, daily.month),
        "headwind_days_fwd": _per_month((along <= -head).astype(float), daily.month),
        "headwind_days_rev": _per_month((along >= head).astype(float), daily.month),
    }


def snapshot(files: list[Path], data_dir: Path, years: tuple[int, int], points: int) -> SourceSnapshot:
    digest = hashlib.sha256()
    for f in sorted(files):
        digest.update(f.name.encode())
        digest.update(str(f.stat().st_size).encode())
    folder = files[0].parent if files else data_dir
    return SourceSnapshot(
        id="era5-timeseries",
        title=f"ERA5 hourly time series, {years[0]}–{years[1]}, {points} climate points (Copernicus CDS)",
        url=DATASET_URL,
        retrieved_at=datetime.fromtimestamp(max((f.stat().st_mtime for f in files), default=0), UTC),
        file=folder.relative_to(data_dir).as_posix() if folder.is_relative_to(data_dir) else str(folder),
        sha256=digest.hexdigest(),
        bytes=sum(f.stat().st_size for f in files),
        licence=LICENCE,
        attribution=ATTRIBUTION.format(years=f"{years[0]}–{years[1]}"),
    )
