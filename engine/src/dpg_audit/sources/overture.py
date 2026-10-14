"""Overture Maps places (GeoParquet on AWS Open Data), queried in place with DuckDB, one box per route block.

The places theme already merges Foursquare OS Places, Meta, AllThePlaces and other sources (D16). Each record
keeps its upstream licence: CDLA-Permissive-2.0 (Meta, Microsoft, ...), Apache-2.0 (Foursquare), CC0 (AllThePlaces).
"""

import json
import math
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path

import duckdb
import numpy as np

from dpg_audit.models import Licence, SourceSnapshot
from dpg_audit.services.catalog import classify_overture, overture_sql_filter
from dpg_audit.services.osm_places import RawPlace
from dpg_audit.sources.download import fetch_text, file_digest

BUCKET = "https://overturemaps-us-west-2.s3.amazonaws.com"
S3_ROOT = "s3://overturemaps-us-west-2/release"
SOURCE_ID = "overture-places"
LICENCE = Licence(
    id="CDLA-Permissive-2.0",
    name="Community Data License Agreement - Permissive 2.0 (Foursquare records: Apache-2.0; AllThePlaces: CC0)",
    url="https://docs.overturemaps.org/attribution/",
)
ATTRIBUTION = (
    "Places from Overture Maps Foundation ({release}), incl. Foursquare OS Places "
    "(Apache-2.0, © Foursquare Labs, Inc.) and AllThePlaces (CC0)"
)
QUERY_VERSION = "1"


def latest_release() -> str:
    """Newest release folder, e.g. '2026-09-23.1'."""
    xml = fetch_text(f"{BUCKET}/?list-type=2&prefix=release/&delimiter=/")
    releases = re.findall(r"<Prefix>release/([0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+)/</Prefix>", xml)
    if not releases:
        raise RuntimeError("no Overture releases found")
    return max(releases, key=lambda r: (r.split(".")[0], int(r.split(".")[1])))


def boxes_along(lon: np.ndarray, lat: np.ndarray, m: np.ndarray, block_m: float, margin_m: float) -> list[tuple]:
    """Bounding boxes (xmin, ymin, xmax, ymax) of route blocks, widened by `margin_m`."""
    out = []
    for start in np.arange(0.0, float(m[-1]) + 1, block_m):
        sel = (m >= start) & (m <= start + block_m)
        if not sel.any():
            continue
        y0, y1 = float(lat[sel].min()), float(lat[sel].max())
        dlat = margin_m / 111_320
        dlon = margin_m / (111_320 * max(math.cos(math.radians(max(abs(y0), abs(y1)))), 0.2))
        out.append((float(lon[sel].min()) - dlon, y0 - dlat, float(lon[sel].max()) + dlon, y1 + dlat))
    return out


def _query(con: duckdb.DuckDBPyConnection, release: str, box: tuple) -> list[tuple]:
    x0, y0, x1, y1 = box
    src = f"{S3_ROOT}/{release}/theme=places/type=place/*.parquet"
    sql = f"""
        SELECT id, names.primary, basic_category, taxonomy.primary, confidence, operating_status,
               bbox.xmin, bbox.ymin, websites[1], brand.names.primary,
               list_transform(sources, s -> s.dataset)
        FROM read_parquet('{src}')
        WHERE bbox.xmin BETWEEN {x0} AND {x1} AND bbox.ymin BETWEEN {y0} AND {y1}
          AND {overture_sql_filter()}
    """
    return con.cursor().sql(sql).fetchall()


def fetch_places(release: str, boxes: list[tuple], cache: Path, workers: int = 4) -> list[dict]:
    """All service-relevant Overture places in the boxes, cached per release and box set."""
    if cache.exists():
        return json.loads(cache.read_text(encoding="utf-8"))
    con = duckdb.connect()
    con.sql("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
    rows: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for batch in pool.map(lambda b: _query(con, release, b), boxes):
            for r in batch:
                rows[r[0]] = {
                    "id": r[0],
                    "name": r[1],
                    "basic": r[2],
                    "primary": r[3],
                    "confidence": r[4],
                    "status": r[5],
                    "lon": r[6],
                    "lat": r[7],
                    "website": r[8],
                    "brand": r[9],
                    "datasets": sorted({d for d in (r[10] or []) if d and d != "Overture"}),
                }
    con.close()
    out = sorted(rows.values(), key=lambda r: r["id"])
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(out), encoding="utf-8")
    return out


def to_raw(records: list[dict], min_confidence: float) -> list[RawPlace]:
    out = []
    for r in records:
        if r["status"] == "permanently_closed" or (r["confidence"] or 0) < min_confidence:
            continue
        kind = classify_overture(r["basic"], r["primary"])
        if kind is None:
            continue
        tags = {k: v for k, v in (("website", r["website"]), ("brand", r["brand"])) if v}
        if r["status"] == "temporarily_closed":
            tags["overture:status"] = "temporarily_closed"
        out.append(
            RawPlace("overture", r["id"], *kind, r["name"], r["lon"], r["lat"], tags, r["confidence"], r["datasets"])
        )
    return out


def snapshot(release: str, cache: Path, data_dir: Path, count: int) -> SourceSnapshot:
    return SourceSnapshot(
        id=f"{SOURCE_ID}:{release}",
        title=f"Overture Maps places, release {release} ({count:,} service places near the route)",
        url=f"{S3_ROOT}/{release}/theme=places/type=place/",
        retrieved_at=datetime.fromtimestamp(cache.stat().st_mtime, UTC),
        file=cache.relative_to(data_dir).as_posix(),
        sha256=file_digest(cache),
        bytes=cache.stat().st_size,
        licence=LICENCE,
        attribution=ATTRIBUTION.format(release=release),
    )
