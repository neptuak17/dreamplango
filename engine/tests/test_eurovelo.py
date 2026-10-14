import json
from datetime import UTC, datetime

import pytest

from dpg_audit.build import assemble
from dpg_audit.bundle import FILES, write_bundle
from dpg_audit.models import BundleManifest, ComponentKind, DevelopmentLevel, Signage, SourceSnapshot
from dpg_audit.networks import eurovelo


@pytest.mark.parametrize(
    ("label", "dev", "sig"),
    [
        ("Developed + Signed", DevelopmentLevel.DEVELOPED, Signage.SIGNED),
        ("Developed + Not Signed", DevelopmentLevel.DEVELOPED, Signage.NOT_SIGNED),
        ("Partially Developed + Signed", DevelopmentLevel.PARTIALLY_DEVELOPED, Signage.SIGNED),
        ("Partially Developed + Not Signed", DevelopmentLevel.PARTIALLY_DEVELOPED, Signage.NOT_SIGNED),
        ("Undeveloped / Unknown", DevelopmentLevel.UNDEVELOPED_UNKNOWN, Signage.UNKNOWN),
        ("EuroVelo Certified", DevelopmentLevel.CERTIFIED, Signage.UNKNOWN),
        ("Something new", DevelopmentLevel.UNRECOGNISED, Signage.UNKNOWN),
    ],
)
def test_parse_status(label, dev, sig):
    status = eurovelo.parse_status(label)
    assert (status.development, status.signage, status.label) == (dev, sig, label)


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        (
            "001: Cadiz – Conil de la Frontera (Developed + Signed)",
            (1, "Cadiz – Conil de la Frontera", "Cadiz", "Conil de la Frontera", "Developed + Signed"),
        ),
        (
            "080: Caorle – Lignano Sabbiadoro  (Partially Developed + Not Signed)",
            (80, "Caorle – Lignano Sabbiadoro", "Caorle", "Lignano Sabbiadoro", "Partially Developed + Not Signed"),
        ),
        (
            "084: Portorož / Portorose – Secovlje/Plovanija border pass (Developed + Signed)",
            (
                84,
                "Portorož / Portorose – Secovlje/Plovanija border pass",
                "Portorož / Portorose",
                "Secovlje/Plovanija border pass",
                "Developed + Signed",
            ),
        ),
        ("7: Somewhere", (7, "Somewhere", None, None, None)),
    ],
)
def test_parse_track_name(name, expected):
    assert eurovelo.parse_track_name(name) == expected


def test_parse_track_name_rejects_unnumbered():
    with pytest.raises(ValueError):
        eurovelo.parse_track_name("Cadiz – Conil")


@pytest.mark.parametrize(("ref", "key"), [("EV8", "ev8"), ("ev 8", "ev8"), ("8", "ev8"), ("EV15", "ev15")])
def test_normalise_ref(ref, key):
    assert eurovelo.normalise_ref(ref) == key


def trk(name, points):
    pts = "".join(f'<trkpt lat="{lat}" lon="{lon}"><ele>{ele}</ele></trkpt>' for lon, lat, ele in points)
    status = name[name.rfind("(") + 1 : -1]
    return f"<trk><name>{name}</name><desc>{status}</desc><trkseg>{pts}</trkseg></trk>"


@pytest.fixture
def sample_gpx(tmp_path):
    # 1: normal; 2: stored end-to-start; then a ~40 km jump; 3: has a 5.5 km straight segment.
    t1 = trk("001: A – B (Developed + Signed)", [(0.00, 45.0, 10), (0.01, 45.0, 12), (0.02, 45.0, 15)])
    t2 = trk("002: B – C (Partially Developed + Not Signed)", [(0.04, 45.0, 20), (0.03, 45.0, 18), (0.02, 45.0, 15)])
    t3 = trk("003: D – E (Undeveloped / Unknown)", [(0.55, 45.0, 30), (0.62, 45.0, 40), (0.63, 45.0, 41)])
    body = "".join([t1, t2, t3])
    path = tmp_path / "raw" / "eurovelo" / "ev8" / "2026-10-14" / "ev8-full.gpx"
    path.parent.mkdir(parents=True)
    path.write_text(
        f'<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="test" '
        f'xmlns="http://www.topografix.com/GPX/1/1">{body}</gpx>',
        encoding="utf-8",
    )
    return path


def test_assemble_sample_route(sample_gpx):
    tracks = eurovelo.load_tracks(sample_gpx)
    build = assemble(eurovelo.route_for("EV8"), tracks)

    assert [d.number for d in build.daily] == [1, 2, 3]
    assert [d.reversed_in_source for d in build.daily] == [False, True, False]
    kinds = [c.kind for c in build.components]
    assert kinds == [ComponentKind.RIDE, ComponentKind.RIDE, ComponentKind.GAP, ComponentKind.RIDE]
    gap = build.components[2]
    assert gap.length_m == 0 and gap.straight_distance_m == pytest.approx(40_000, rel=0.03)

    # measures run continuously over ridden components only
    assert build.daily[1].from_m == pytest.approx(build.daily[0].to_m, abs=0.2)
    assert build.daily[2].from_m == pytest.approx(build.daily[1].to_m, abs=0.2)
    assert build.path.length == pytest.approx(sum(d.length_m for d in build.daily), abs=0.5)

    rules = {f.rule_id for f in build.findings}
    assert {
        "source.section_reversed",
        "source.gap_between_sections",
        "source.straight_segment",
        "eurovelo.partially_developed",
        "eurovelo.undeveloped",
    } <= rules
    assert [f.from_m for f in build.findings] == sorted(f.from_m for f in build.findings)

    shares = build.summary().status_breakdown
    assert sum(s.share for s in shares) == pytest.approx(1.0)


def test_write_bundle(sample_gpx, tmp_path):
    build = assemble(eurovelo.route_for("EV8"), eurovelo.load_tracks(sample_gpx))
    snap = SourceSnapshot(
        id=eurovelo.SOURCE_ID,
        title="t",
        url="https://example.invalid",
        retrieved_at=datetime.now(UTC),
        file="raw/eurovelo/ev8/2026-10-14/ev8-full.gpx",
        sha256="0" * 64,
        bytes=1,
        licence=eurovelo.ODBL,
        attribution=eurovelo.ATTRIBUTION.format(date="2026-10-14"),
    )
    run_id, out = write_bundle(build, [snap], tmp_path)
    for name in FILES.values():
        assert (out / name).exists()
    manifest = BundleManifest.model_validate_json((out / "manifest.json").read_text(encoding="utf-8"))
    assert manifest.run_id == run_id
    assert "2026-10-14" in manifest.attribution[0]
    current = json.loads((tmp_path / "bundles" / "eurovelo" / "ev8" / "current.json").read_text())
    assert current["run_id"] == run_id
    geo = json.loads((out / "path.geojson").read_text())
    assert [f["properties"]["kind"] for f in geo["features"]] == ["ride", "ride", "gap", "ride"]
