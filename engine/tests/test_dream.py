import io
import json
import zipfile
from datetime import date

import numpy as np
import pytest

from dpg_audit.dream import climate, scores
from dpg_audit.dream.crowding import CrowdingSource
from dpg_audit.dream.daylight import day_length_h, monthly_day_length
from dpg_audit.dream.pipeline import _Layer, mean_heading, surface_shares
from dpg_audit.dream.profile import grade, load_dream
from dpg_audit.lrs import MeasuredLine
from dpg_audit.models import Event

PROFILE = load_dream()

# --- daylight --------------------------------------------------------------------------------------------------


def test_day_length_matches_known_values():
    assert day_length_h(0.0, date(2027, 3, 20)) == pytest.approx(12.1, abs=0.1)  # equator, equinox
    assert day_length_h(40.0, date(2027, 6, 21)) == pytest.approx(15.0, abs=0.15)  # ~Madrid, solstice
    assert day_length_h(40.0, date(2027, 12, 21)) == pytest.approx(9.3, abs=0.15)
    assert day_length_h(70.0, date(2027, 6, 21)) == 24.0  # midnight sun


def test_monthly_day_length_peaks_in_june():
    lengths = monthly_day_length(43.0, 2027)
    assert len(lengths) == 12 and lengths.index(max(lengths)) == 5 and lengths.index(min(lengths)) == 11


# --- rider levels (D36) ----------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("km", "climb", "level"), [(35, 200, 1), (55, 200, 2), (55, 700, 3), (75, 800, 3), (95, 1100, 4), (120, 900, 5)]
)
def test_grade(km, climb, level):
    assert grade(PROFILE.levels, km, climb) == level


# --- ERA5 time series ------------------------------------------------------------------------------------------


def fake_era5_zip(path, days: int = 60):
    rows = ["valid_time,u10,v10,t2m,tp,latitude,longitude"]
    for d in range(days):
        day = date(2024, 1, 1).toordinal() + d
        stamp = date.fromordinal(day).isoformat()
        for h in range(24):
            temp = 273.15 + 10 + 5 * np.sin(np.pi * h / 24)  # 10 °C at midnight, 15 °C at noon
            rain = 0.0005 if d % 2 == 0 else 0.0  # 12 mm on even days
            rows.append(f"{stamp} {h:02d}:00:00,3.0,-4.0,{temp:.3f},{rain},39.5,-0.5")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("series.csv", "\n".join(rows))
    path.write_bytes(buf.getvalue())


def test_read_daily_and_monthly_normals(tmp_path):
    zp = tmp_path / "p.zip"
    fake_era5_zip(zp)
    daily = climate.read_daily(zp)
    assert daily.grid == (-0.5, 39.5)
    assert daily.tmax.size == 60 and daily.month[0] == 0 and daily.month[-1] == 1
    assert daily.tmax[0] == pytest.approx(15.0, abs=0.05) and daily.tmin[0] == pytest.approx(10.0, abs=0.05)
    assert daily.rain_mm[0] == pytest.approx(12.0) and daily.rain_mm[1] == 0.0
    assert daily.speed[0] == pytest.approx(5.0)
    # riding due north: the 4 m/s southerly component (v = -4) is a headwind
    mon = climate.monthly(daily, (0.0, 1.0), PROFILE.climate)
    assert mon["rain_days"][0] == pytest.approx(16 / 31, abs=1e-3)
    assert mon["wind_along_ms"][0] == pytest.approx(-4.0)
    assert mon["headwind_days_fwd"][0] == 1.0 and mon["headwind_days_rev"][0] == 0.0
    assert mon["tmax_c"][5] is None  # no June data: unknown, not zero


def test_era5_cache_is_kept_by_grid_cell(tmp_path):
    years = (2016, 2025)
    old = tmp_path / "era5ts_39.47_-0.52_2016-2025.zip"  # named after a route point, before M3.5
    fake_era5_zip(old, days=3)
    near = [climate.ClimatePoint(0.0, -0.52, 39.47), climate.ClimatePoint(1.0, -0.45, 39.55)]  # one 0.25° cell
    daily, files = climate.fetch_all(near, years, tmp_path, workers=2, log=lambda _: None)
    assert not old.exists() and files == [tmp_path / "era5ts_g39.50_-0.50_2016-2025.zip"]
    assert all(d is not None and d.grid == (-0.5, 39.5) for d in daily)  # served from the cache, no request
    assert climate.grid_cell(-0.62, 39.38) == (-0.5, 39.5)


def test_climate_points_spacing():
    from dpg_audit.lrs import RoutePath

    path = RoutePath([MeasuredLine([0.0, 3.0], [45.0, 45.0])])  # ~236 km
    points = climate.climate_points(path, 100_000)
    assert [round(p.m / 1000) for p in points] == [50, 150]


# --- scores ----------------------------------------------------------------------------------------------------


def test_comfort_prefers_mild_dry_long_days():
    cfg = PROFILE.comfort
    good = scores.comfort(22, 0.1, 13, 0.05, 0.0, cfg)
    hot = scores.comfort(36, 0.05, 14, 0.05, 0.6, cfg)
    wet_dark = scores.comfort(10, 0.5, 9, 0.2, 0.0, cfg)
    assert good > 80 > hot and good > wet_dark
    assert scores.comfort(None, None, 12, None, None, cfg) is None
    assert scores.comfort_label(good, cfg["labels"]) == "excellent"


def test_best_time_names_missing_inputs_and_rescales():
    cfg = PROFILE.best_time
    full, missing = scores.best_time(80, 1.0, 0.2, 0.0, cfg)
    assert missing == [] and full == pytest.approx(70 * 0.8 + 20 + 10 * 0.9, abs=0.1)
    partial, missing = scores.best_time(80, None, None, None, cfg)
    assert set(missing) == {"tourism", "school holidays", "opening seasons"}
    assert partial == pytest.approx(80.0)  # comfort alone, rescaled: not dragged down by unknowns
    assert scores.best_time(None, 1.0, 0.1, 0.1, cfg)[0] is None


def test_direction_advice():
    cfg = PROFILE.direction
    assert scores.direction(2.0, 500, 500, cfg).advice == "forward"
    assert scores.direction(-0.2, 900, 300, cfg).advice == "reverse"  # forward climbs 600 m more
    assert scores.direction(0.1, 400, 420, cfg).advice == "either"
    assert scores.direction(None, None, None, cfg).advice == "unknown"
    by_wind = scores.direction(1.0, None, 300, cfg)  # climbing unknown (placeholder): wind alone, difference unknown
    assert by_wind.advice == "forward" and by_wind.climb_diff_m is None


# --- surfaces (D36) --------------------------------------------------------------------------------------------


def ev(layer, a, b, value):
    return Event(layer=layer, from_m=a, to_m=b, value=value, confidence="medium")


def test_surface_shares_partition_each_km():
    infra = _Layer([ev("infrastructure", 0, 400, "cycleway"), ev("infrastructure", 400, 1000, "quiet_road")])
    surf = _Layer(
        [
            ev("surface", 0, 200, "paved_smooth"),
            ev("surface", 200, 500, "gravel"),
            ev("surface", 500, 1000, "paved_assumed"),
        ]
    )
    shares = surface_shares(infra, surf, 0, 1000)
    assert shares == {"road": 0.5, "cycle_path": 0.2, "gravel": 0.3, "unknown": 0.0}


def test_mean_heading_east_and_winding():
    east = MeasuredLine(np.linspace(5, 5.5, 20), np.full(20, 45.0))
    hx, hy = mean_heading(east)
    assert hx == pytest.approx(1.0, abs=1e-3) and hy == pytest.approx(0.0, abs=1e-3)
    there_and_back = MeasuredLine([5.0, 5.2, 5.0], [45.0, 45.0, 45.0])
    assert abs(mean_heading(there_and_back)[0]) < 0.05


# --- crowding (cached responses, no network) -------------------------------------------------------------------


def test_school_share_and_missing_years(tmp_path):
    oh = tmp_path / "openholidays"
    oh.mkdir()
    (oh / "schoolholidays-XX-2027.json").write_text("[]")
    (oh / "schoolholidays-XX-2026.json").write_text(
        json.dumps(
            [
                {"startDate": "2026-07-01", "endDate": "2026-07-31", "nationwide": True},
                {
                    "startDate": "2026-02-02",
                    "endDate": "2026-02-02",
                    "nationwide": True,
                    "name": [{"language": "EN", "text": "End of lessons"}],
                },
                {
                    "startDate": "2026-10-01",
                    "endDate": "2026-10-31",
                    "nationwide": False,
                    "subdivisions": [{"code": "XX-A"}],
                },
            ]
        )
    )
    (oh / "subdivisions-XX.json").write_text(json.dumps([{"code": "XX-A"}, {"code": "XX-B"}]))
    src = CrowdingSource(tmp_path, 2027)
    shares, year = src.school("XX")
    src.close()
    assert year == 2026  # 2027 not published: the year used is reported, not hidden
    assert shares[9] == 0.5 and shares[0] == 0.0
    assert shares[6] is None  # the source omits summer breaks: no data, never "no holidays" (D37)
    assert shares[1] == 0.0  # an "End of lessons" marker is not a holiday


def test_tourism_index_from_cached_eurostat(tmp_path):
    es = tmp_path / "eurostat"
    es.mkdir()
    months = [f"2023-{m:02d}" for m in range(1, 13)]
    nights = [50, 50, 60, 80, 100, 150, 200, 200, 120, 80, 50, 60]
    payload = {
        "id": ["freq", "unit", "geo", "time"],
        "size": [1, 1, 1, 12],
        "dimension": {"time": {"category": {"index": {p: i for i, p in enumerate(months)}}}},
        "value": {str(i): v for i, v in enumerate(nights)},
    }
    (es / "tour_occ_nim-ZZ-2022.json").write_text(json.dumps(payload))
    src = CrowdingSource(tmp_path, 2027)
    index, years = src.tourism("ZZ")
    src.close()
    assert years == "2023–2023"
    assert index[6] == pytest.approx(200 / (sum(nights) / 12), abs=1e-3)
