"""Cutting the OSM corridor from several country extracts (osmium-tool must be installed, as for audits)."""

import shutil
import subprocess

import pytest

from dpg_audit.sources import osm

pytestmark = pytest.mark.skipif(not shutil.which("osmium"), reason="osmium-tool not installed")

NODES = "".join(
    f'<node id="{i}" version="1" timestamp="2026-10-01T00:00:00Z" lat="43.0" lon="{0.001 * i}"/>' for i in (1, 2, 3)
)


def extract(path, way_version: int, tag: str) -> None:
    path.write_text(
        '<?xml version="1.0" encoding="UTF-8"?><osm version="0.6" generator="test">'
        f"{NODES}"
        f'<way id="10" version="{way_version}" timestamp="2026-10-0{way_version}T00:00:00Z">'
        f'<nd ref="1"/><nd ref="2"/><nd ref="3"/><tag k="highway" v="{tag}"/></way></osm>'
    )


def test_extracts_from_different_days_keep_only_the_newest_version(tmp_path):
    older, newer = tmp_path / "spain.osm", tmp_path / "andorra.osm"
    extract(older, 1, "track")
    extract(newer, 2, "cycleway")  # the same way, edited between the two downloads
    area = tmp_path / "corridor.geojson"
    area.write_text(
        '{"type": "Feature", "properties": {}, "geometry": {"type": "Polygon", '
        '"coordinates": [[[-0.1, 42.9], [0.1, 42.9], [0.1, 43.1], [-0.1, 43.1], [-0.1, 42.9]]]}}'
    )
    out = osm.extract_corridor([older, newer], area, tmp_path / "osm" / "corridor.osm.pbf")
    info = subprocess.run(
        ["osmium", "fileinfo", "-e", "-g", "data.multiple_versions", str(out)], capture_output=True, text=True
    )
    assert info.stdout.strip() == "no"
    text = subprocess.run(["osmium", "cat", str(out), "-f", "opl"], capture_output=True, text=True).stdout
    assert "w10 v2" in text and "highway=cycleway" in text and "w10 v1" not in text
