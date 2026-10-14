"""Copernicus DEM GLO-30 (30 m, global) from the AWS Open Data bucket, sampled bilinearly.

Note: GLO-30 is a surface model (DSM): it includes trees and buildings, so profiles must be smoothed, and bridges
and tunnels interpolated rather than sampled.
"""

import json
import math
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path

import httpx
import numpy as np
import rasterio
from scipy.ndimage import map_coordinates

from dpg_audit.models import Licence, SourceSnapshot
from dpg_audit.sources.download import download

BASE = "https://copernicus-dem-30m.s3.amazonaws.com"
SOURCE_ID = "copernicus-dem-glo30"
LICENCE = Licence(
    id="Copernicus-DEM",
    name="Copernicus DEM licence (free, attribution required)",
    url="https://spacedata.copernicus.eu/documents/20123/121286/CSCDA_ESA_Mission-specific+Annex_31_Oct_22.pdf",
)
ATTRIBUTION = (
    "Produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 "
    "provided under COPERNICUS by the European Union and ESA; all rights reserved"
)


def tile_name(lat_floor: int, lon_floor: int) -> str:
    ns = f"{'N' if lat_floor >= 0 else 'S'}{abs(lat_floor):02d}"
    ew = f"{'E' if lon_floor >= 0 else 'W'}{abs(lon_floor):03d}"
    return f"Copernicus_DSM_COG_10_{ns}_00_{ew}_00_DEM"


def dem_dir(data_dir: Path) -> Path:
    return data_dir / "raw" / "dem" / "copernicus-glo30"


def ensure_tiles(keys: set[tuple[int, int]], data_dir: Path, workers: int = 4) -> dict[tuple[int, int], Path | None]:
    """Download missing tiles; returns key -> path, or None for tiles that don't exist (open sea)."""
    folder = dem_dir(data_dir)
    folder.mkdir(parents=True, exist_ok=True)
    absent_file = folder / "absent.json"
    absent = set(json.loads(absent_file.read_text())) if absent_file.exists() else set()

    def one(key: tuple[int, int]) -> tuple[tuple[int, int], Path | None]:
        name = tile_name(*key)
        path = folder / f"{name}.tif"
        if path.exists():
            return key, path
        if name in absent:
            return key, None
        try:
            download(f"{BASE}/{name}/{name}.tif", path, quiet=True)
            return key, path
        except httpx.HTTPStatusError as err:
            if err.response.status_code in (403, 404):
                return key, None
            raise

    with ThreadPoolExecutor(max_workers=workers) as pool:
        result = dict(pool.map(one, sorted(keys)))
    absent |= {tile_name(*k) for k, p in result.items() if p is None}
    absent_file.write_text(json.dumps(sorted(absent)))
    return result


def sample(lon: np.ndarray, lat: np.ndarray, data_dir: Path) -> np.ndarray:
    """Bilinear DEM elevation at each point (NaN over open sea / missing tiles)."""
    keys = np.stack([np.floor(lat).astype(int), np.floor(lon).astype(int)], axis=1)
    groups: dict[tuple[int, int], list[int]] = defaultdict(list)
    for i, (la, lo) in enumerate(keys):
        groups[(int(la), int(lo))].append(i)
    tiles = ensure_tiles(set(groups), data_dir)
    out = np.full(lon.shape, np.nan)
    for key, idx in groups.items():
        path = tiles.get(key)
        if path is None:
            continue
        with rasterio.open(path) as src:
            band = src.read(1).astype("float32")
            inv = ~src.transform
            cols, rows = inv * (lon[idx], lat[idx])
            nodata = src.nodata
        vals = map_coordinates(band, [np.asarray(rows) - 0.5, np.asarray(cols) - 0.5], order=1, mode="nearest")
        if nodata is not None:
            vals = np.where(np.isclose(vals, nodata), np.nan, vals)
        out[idx] = vals
    return out


def snapshot(data_dir: Path, tile_count: int) -> SourceSnapshot:
    return SourceSnapshot(
        id=SOURCE_ID,
        title=f"Copernicus DEM GLO-30 ({tile_count} tiles, AWS Open Data)",
        url=BASE,
        retrieved_at=datetime.now(UTC),
        file=dem_dir(data_dir).relative_to(data_dir).as_posix(),
        sha256="n/a (tile set)",
        bytes=sum(p.stat().st_size for p in dem_dir(data_dir).glob("*.tif")),
        licence=LICENCE,
        attribution=ATTRIBUTION,
    )


def needed_tiles(lon: np.ndarray, lat: np.ndarray) -> set[tuple[int, int]]:
    return {(math.floor(la), math.floor(lo)) for lo, la in zip(lon, lat, strict=True)}
