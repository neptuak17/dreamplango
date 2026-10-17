"""OpenStreetMap data: pick Geofabrik country extracts that a corridor touches, download them, and cut the corridor.

Heavy lifting is done by `osmium-tool` (apt package `osmium-tool`), which is far faster than Python for this.
"""

import json
import shutil
import subprocess
from datetime import UTC, datetime
from pathlib import Path

from shapely import MultiPolygon
from shapely.geometry import shape

from dpg_audit.models import Licence, SourceSnapshot
from dpg_audit.sources.download import download, fetch_text, file_digest

GEOFABRIK_INDEX = "https://download.geofabrik.de/index-v1.json"
SOURCE_ID = "osm-geofabrik"
ODBL = Licence(id="ODbL-1.0", name="Open Database License 1.0", url="https://opendatacommons.org/licenses/odbl/1-0/")
ATTRIBUTION = "© OpenStreetMap contributors (data via Geofabrik, extract of {date})"


def osm_dir(data_dir: Path) -> Path:
    return data_dir / "raw" / "osm" / "geofabrik"


def geofabrik_index(data_dir: Path, refresh: bool = False) -> dict:
    path = osm_dir(data_dir) / "index-v1.json"
    if refresh or not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(fetch_text(GEOFABRIK_INDEX), encoding="utf-8")
    return json.loads(path.read_text(encoding="utf-8"))


def country_extracts(index: dict, area: MultiPolygon) -> list[dict]:
    """Country extracts (children of a continent that carry an ISO country code) intersecting `area`.

    Composite regions such as `alps` or `dach` have no ISO code and would duplicate their countries, so they are
    skipped. Pass a narrow area around the route itself, not the whole corridor, to avoid picking up countries that
    are merely across the water (e.g. Morocco from Tarifa).
    """
    features = index["features"]
    top_level = {f["properties"]["id"] for f in features if not f["properties"].get("parent")}
    hits = []
    for f in features:
        props = f["properties"]
        is_country = props.get("parent") in top_level and props.get("iso3166-1:alpha2")
        has_data = f.get("geometry") and "pbf" in props.get("urls", {})
        if is_country and has_data and shape(f["geometry"]).intersects(area):
            hits.append(props)
    return sorted(hits, key=lambda p: p["id"])


def _osmium(*args: str) -> str:
    if not shutil.which("osmium"):
        raise RuntimeError("osmium-tool is not installed (sudo apt install osmium-tool)")
    return subprocess.run(["osmium", *args], check=True, capture_output=True, text=True).stdout


def replication_timestamp(pbf: Path) -> str | None:
    out = _osmium("fileinfo", "-g", "header.option.osmosis_replication_timestamp", str(pbf)).strip()
    return out or None


def ensure_extract(region: dict, data_dir: Path, max_age_days: int = 30) -> tuple[Path, SourceSnapshot]:
    """Download a Geofabrik extract unless a copy younger than `max_age_days` is already present."""
    url = region["urls"]["pbf"]
    target = osm_dir(data_dir) / f"{region['id']}-latest.osm.pbf"
    meta_path = target.with_suffix(".json")
    if target.exists() and meta_path.exists():
        snap = SourceSnapshot.model_validate_json(meta_path.read_text(encoding="utf-8"))
        if (datetime.now(UTC) - snap.retrieved_at).days < max_age_days:
            return target, snap
    md5 = fetch_text(url + ".md5").split()[0]
    print(f"downloading {url}", flush=True)
    download(url, target, expected_md5=md5)
    stamp = replication_timestamp(target) or datetime.now(UTC).isoformat()
    snap = SourceSnapshot(
        id=f"{SOURCE_ID}:{region['id']}",
        title=f"OpenStreetMap extract: {region['name']} (Geofabrik)",
        url=url,
        retrieved_at=datetime.now(UTC),
        file=target.relative_to(data_dir).as_posix(),
        sha256=file_digest(target),
        bytes=target.stat().st_size,
        licence=ODBL,
        attribution=ATTRIBUTION.format(date=stamp[:10]),
    )
    meta_path.write_text(snap.model_dump_json(indent=2), encoding="utf-8")
    return target, snap


def extract_corridor(extracts: list[Path], corridor_geojson: Path, out: Path) -> Path:
    """Cut every extract to the corridor and merge the pieces into one PBF."""
    out.parent.mkdir(parents=True, exist_ok=True)
    pieces = []
    for pbf in extracts:
        piece = out.parent / f"part-{pbf.name}"
        print(f"cutting {pbf.name} to corridor", flush=True)
        _osmium("extract", "--overwrite", "-s", "smart", "-p", str(corridor_geojson), str(pbf), "-o", str(piece))
        pieces.append(piece)
    print("merging corridor pieces", flush=True)
    merged = out.with_name(f"merged-{out.name}")
    _osmium("merge", "--overwrite", *map(str, pieces), "-o", str(merged))
    for piece in pieces:
        piece.unlink()
    # Neighbouring extracts overlap at borders. Downloaded on different days, they can hold two versions of the same
    # object, which later osmium steps refuse ("ID twice in input"): keep only the newest version of each.
    if _osmium("fileinfo", "-e", "-g", "data.multiple_versions", str(merged)).strip() == "yes":
        print("keeping the newest version of objects that differ between extracts", flush=True)
        _osmium("time-filter", "--overwrite", str(merged), "-o", str(out))
        merged.unlink()
    else:
        merged.replace(out)
    return out
