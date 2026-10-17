"""M3.5: a rider's own GPX file as a private route (D22–D25, D39, D40)."""

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pytest
from typer.testing import CliRunner

from dpg_audit import networks, overlap
from dpg_audit.build import assemble
from dpg_audit.bundle import bundle_dir, write_bundle
from dpg_audit.ingest.gpx import read_gpx
from dpg_audit.models import Component, ComponentKind, DevelopmentLevel, GapType, Signage, WaysFile
from dpg_audit.networks import user
from dpg_audit.rules.findings import gap_findings

KM_PER_DEG_LON_43 = 81.4  # 1° of longitude at 43°N


def line_xml(lon0: float, km: float, step_km: float = 0.1, lat: float = 43.0, tag: str = "trkpt") -> str:
    n = int(km / step_km) + 1
    lons = np.linspace(lon0, lon0 + km / KM_PER_DEG_LON_43, n)
    return "".join(f'<{tag} lat="{lat}" lon="{x:.6f}"><ele>{100 + i % 7}</ele></{tag}>' for i, x in enumerate(lons))


def gpx(body: str, name: str = "Test route") -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="test" '
        f'xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>{name}</name></metadata>{body}</gpx>'
    )


WAYPOINTS = (
    '<wpt lat="43.01" lon="0.5"><name>Col Test</name><cmt>viewpoint</cmt><desc>1570m</desc>'
    "<sym>Dot</sym><type>overlook</type></wpt>"
    '<wpt lat="43.0" lon="2.0"><name>Café</name><sym>Restaurant</sym></wpt>'
)


@pytest.fixture
def one_track(tmp_path) -> Path:
    f = tmp_path / "ride.gpx"
    f.write_text(gpx(WAYPOINTS + f"<trk><name>Ride</name><trkseg>{line_xml(0.0, 250)}</trkseg></trk>"))
    return f


@dataclass
class Town:
    lon: float
    lat: float
    name: str | None
    kind: str


# --- reading ---------------------------------------------------------------------------------------------------


def test_read_gpx_tracks_waypoints_and_name(one_track):
    f = read_gpx(one_track)
    assert f.name == "Test route" and len(f.tracks) == 1 and f.tracks[0].point_count == 2501
    col, cafe = f.waypoints
    assert (col.name, col.kind, col.note) == ("Col Test", "overlook", "viewpoint 1570m")
    assert (cafe.kind, cafe.note) == ("Restaurant", "")  # <sym> when there is no <type>


def test_read_gpx_uses_planned_route_points_when_there_is_no_track(tmp_path):
    f = tmp_path / "planned.gpx"
    f.write_text(gpx(f"<rte><name>Plan</name>{line_xml(0.0, 5, tag='rtept')}</rte>"))
    tracks = read_gpx(f).tracks
    assert len(tracks) == 1 and tracks[0].name == "Plan" and tracks[0].point_count == 51


def test_clean_drops_repeats_and_jitter_but_keeps_the_end():
    from dpg_audit.ingest.gpx import GpxTrack

    lon = np.array([0.0, 0.0, 0.00001, 0.001, 0.001, 0.002, 0.00201])  # 0.00001° ≈ 0.8 m
    lat = np.full(lon.size, 43.0)
    line = user.clean(GpxTrack(0, "", "", lon, lat, None, []))
    assert list(line.lon) == [0.0, 0.001, 0.00201]


# --- sections (D40) --------------------------------------------------------------------------------------------


def test_single_track_becomes_equal_stages_of_about_60_km(one_track):
    towns = [Town(0.0, 43.0, "Aville", "town"), Town(62.5 / KM_PER_DEG_LON_43, 43.01, "Beville", "village")]
    tracks = user.load_tracks(one_track, towns)
    assert len(tracks) == 4  # 250 km -> 4 × 62.5 km
    assert [round(t.line.length / 1000, 1) for t in tracks] == pytest.approx([62.5] * 4, abs=0.2)
    assert tracks[0].title == "Stage 1: Aville – Beville"
    assert tracks[1].title == "Stage 2: Beville – km 125"  # the known end keeps its name
    assert tracks[2].title == "Stage 3: km 125–188"  # no town within 5 km of its ends
    assert all(t.status.development == DevelopmentLevel.NOT_RATED for t in tracks)
    assert all(t.status.signage == Signage.UNKNOWN for t in tracks)


def test_several_tracks_are_kept_as_sections(tmp_path):
    f = tmp_path / "days.gpx"
    days = "".join(
        f"<trk><name>{n}</name><trkseg>{line_xml(lon, 40)}</trkseg></trk>"
        for n, lon in (("Day 1", 0.0), ("", 40 / KM_PER_DEG_LON_43))
    )
    f.write_text(gpx(days))
    tracks = user.load_tracks(f)
    assert [t.title for t in tracks] == ["Day 1", "Track 2: km 40–80"]


def test_place_name_prefers_a_town_to_a_closer_village():
    places = [Town(0.001, 43.0, "Hamlet", "village"), Town(0.04, 43.0, "Market Town", "town")]
    assert user.place_name(0.0, 43.0, places) == "Market Town"  # 3.3 km away, within 5 km
    assert user.place_name(0.0, 43.0, places[:1]) == "Hamlet"
    assert user.place_name(1.0, 43.0, places) is None


# --- private route, bundle and forget (D25, D39) ---------------------------------------------------------------


def test_register_is_stable_and_keeps_the_name(one_track, tmp_path):
    data = tmp_path / "data"
    first = user.register(one_track, data, name="Pyrenees")
    ref = user.route_id(one_track.read_bytes())
    again = user.register(one_track, data)
    assert ref.startswith("u") and len(ref) == 11
    assert first.title == again.title == "Pyrenees" and again.url is None and again.licence.id == "unknown"
    assert (data / "raw" / "user" / ref / "route.gpx").read_bytes() == one_track.read_bytes()
    assert networks.get("user").route(ref, data).name == "Pyrenees"


def test_register_refuses_a_file_without_a_track(tmp_path):
    f = tmp_path / "empty.gpx"
    f.write_text(gpx(WAYPOINTS))
    with pytest.raises(ValueError, match="no track or route"):
        user.register(f, tmp_path / "data")


def test_private_bundle_is_stored_apart_and_marked(one_track, tmp_path):
    data = tmp_path / "data"
    snap = user.register(one_track, data)
    ref = user.route_id(one_track.read_bytes())
    src = networks.get("user")
    build = assemble(src.route(ref, data), src.tracks(snap, data))
    run_id, out = write_bundle(build, [snap], data, private=src.private)
    assert out.parent == bundle_dir(data, "user", ref, private=True) == data / "bundles" / "private" / "user" / ref
    manifest = json.loads((out / "manifest.json").read_text())
    assert manifest["visibility"] == "private" and manifest["route"]["id"] == f"user:{ref}"
    assert not any(f["rule_id"].startswith(("eurovelo.", "source.status")) for f in build.findings)


def test_forget_deletes_everything_for_the_route(one_track, tmp_path, monkeypatch):
    from dpg_audit.cli import app

    data = tmp_path / "data"
    monkeypatch.setenv("DPG_DATA_DIR", str(data))
    ref = user.route_id(one_track.read_bytes())
    runner = CliRunner()
    assert runner.invoke(app, ["add-route", str(one_track), "--quiet"]).stdout.strip() == ref
    for d in (
        data / "work" / "user" / ref / "osm",
        data / "valhalla" / f"user-{ref}",
        data / "bundles/private/user" / ref,
    ):
        d.mkdir(parents=True)
    (data / "raw" / "era5").mkdir(parents=True)  # a shared cache: kept
    result = runner.invoke(app, ["forget", "user", ref, "--yes"])
    assert result.exit_code == 0, result.stdout
    assert not any((data / p).exists() for p in (f"raw/user/{ref}", f"work/user/{ref}", f"valhalla/user-{ref}"))
    assert not (data / "bundles/private/user" / ref).exists() and (data / "raw" / "era5").exists()
    assert runner.invoke(app, ["forget", "eurovelo", "ev8", "--yes"]).exit_code != 0  # public routes stay


@pytest.mark.parametrize("bad", ["", "u", "../u4ad6e50f59", "U4AD6E50F59", "u4ad6e50f5", "user"])
def test_forget_refuses_anything_but_a_route_id(one_track, tmp_path, monkeypatch, bad):
    from dpg_audit.cli import app

    data = tmp_path / "data"
    monkeypatch.setenv("DPG_DATA_DIR", str(data))
    user.register(one_track, data)
    (data / "work" / "user" / "other").mkdir(parents=True)
    result = CliRunner().invoke(app, ["forget", "user", bad, "--yes"])
    assert result.exit_code != 0
    assert (data / "raw" / "user").exists() and (data / "work" / "user" / "other").exists()  # nothing deleted


# --- overlap and user places (D24, D40) ------------------------------------------------------------------------


def public_bundle(data: Path, ways: list[tuple[int, int, float]]) -> None:
    route = data / "bundles" / "eurovelo" / "ev8"
    run = route / "r1"
    run.mkdir(parents=True)
    (route / "current.json").write_text(json.dumps({"run_id": "r1", "updated_at": "2026-10-16T00:00:00Z"}))
    (run / "ways.json").write_text(WaysFile(ways=ways).model_dump_json())
    (run / "manifest.json").write_text(
        json.dumps(
            {
                "run_id": "r1",
                "created_at": "2026-10-16T00:00:00Z",
                "pipeline": {"name": "t", "version": "0"},
                "route": {"id": "eurovelo:ev8", "network": "eurovelo", "ref": "EV8", "name": "EuroVelo 8"},
                "sources": [],
                "attribution": [],
                "files": {},
                "summary": {
                    "ride_length_m": 1,
                    "daily_section_count": 1,
                    "gap_count": 0,
                    "gap_straight_distance_m": 0,
                    "status_breakdown": [],
                },
                "finding_counts": {},
            }
        )
    )


def test_overlap_counts_the_shorter_length_on_shared_ways(tmp_path):
    public_bundle(tmp_path, [(1, 41, 3000.0), (2, 42, 500.0), (2, 43, 500.0), (9, 50, 4000.0)])
    own = WaysFile(ways=[(1, 1, 2000.0), (2, 1, 5000.0), (7, 2, 3000.0)])
    [o] = overlap.overlap(own, 10_000.0, tmp_path, exclude="user:u1")
    assert o.route_id == "eurovelo:ev8" and o.shared_m == 3000.0  # min(2000, 3000) + min(5000, 1000)
    assert o.share == 0.3 and o.sections == [(41, 43)]
    assert overlap.overlap(WaysFile(ways=[(1, 1, 900.0)]), 10_000.0, tmp_path) == []  # under 1 km: not a route


def test_gap_advice_off_eurovelo_routes_is_not_eurovelos():
    gap = Component(
        id="c2",
        seq=2,
        kind=ComponentKind.GAP,
        from_m=1000.0,
        to_m=1000.0,
        length_m=0.0,
        gap_type=GapType.PUBLIC_TRANSPORT,
        straight_distance_m=20_000.0,
        start=(0.0, 43.0),
        end=(0.3, 43.0),
    )
    note = {"component": "c2", "from_section": 1, "to_section": 2}
    assert "EuroVelo" in gap_findings([gap], [note])[0]["detail"]
    assert "EuroVelo" not in gap_findings([gap], [note], eurovelo=False)[0]["detail"]


def test_user_places_sit_on_the_route_and_are_never_counted(one_track, tmp_path):
    data = tmp_path / "data"
    snap = user.register(one_track, data)
    src = networks.get("user")
    build = assemble(src.route(user.route_id(one_track.read_bytes()), data), src.tracks(snap, data))
    places = overlap.user_places(build, src.waypoints(snap, data)).places
    col, cafe = places
    assert col.kind == "overlook" and col.offset_m == pytest.approx(1112, abs=5)  # 0.01° north of the line
    assert col.at_m == pytest.approx(0.5 * KM_PER_DEG_LON_43 * 1000, rel=0.01) and col.section == 1
    assert cafe.section == 3 and cafe.offset_m < 1
    assert "counts" not in col.model_dump()  # no counting flag at all: user places never count (D40)
