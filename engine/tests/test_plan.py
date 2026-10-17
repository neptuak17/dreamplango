"""Plan data (M4, DESIGN.md 11.6): stops, effort, highlights, holiday dates and day-by-day opening."""

import json
from datetime import date

import numpy as np
import pytest
from test_services import place

from dpg_audit.dream.crowding import CrowdingSource
from dpg_audit.dream.themes import Settlement
from dpg_audit.lrs import MeasuredLine, RoutePath
from dpg_audit.plan.effort import surface_letter
from dpg_audit.plan.highlights import kind_of, rank, select
from dpg_audit.plan.stops import build_stops
from dpg_audit.services.coverage import Coverage
from dpg_audit.services.profile import load_services
from dpg_audit.services.seasons import day_codes

# --- day-by-day opening ----------------------------------------------------------------------------------------


def _day(codes: str, d: date) -> str:
    return codes[(d - date(d.year, 1, 1)).days]


def test_day_codes_follow_the_week():
    codes = day_codes("Mo-Fr 08:00-19:00; Sa 08:00-12:00; Su off", 2027)
    assert codes is not None and len(codes) == 365
    assert _day(codes, date(2027, 10, 15)) == "o"  # a Friday
    assert _day(codes, date(2027, 10, 16)) == "o"  # Saturday morning
    assert _day(codes, date(2027, 10, 17)) == "c"  # Sunday


def test_day_codes_judge_the_daytime_and_unknowns():
    assert set(day_codes("Mo-Su 21:00-23:30", 2027) or "") == {"c"}  # evenings only: closed in the daytime
    assert day_codes("not opening hours at all", 2027) is None
    seasonal = day_codes("Apr-Oct: 09:00-18:00", 2027)
    assert seasonal is not None and _day(seasonal, date(2027, 5, 3)) == "o" and _day(seasonal, date(2027, 1, 4)) == "c"


# --- stops -----------------------------------------------------------------------------------------------------

LAT = 43.0


@pytest.fixture
def path() -> RoutePath:
    lon = np.linspace(0.0, 2.5, 251)  # ~203 km due east
    return RoutePath([MeasuredLine(lon, np.full(lon.size, LAT))])


def at(path: RoutePath, lon: float, service: str, **kw):
    p = place(service, round(path.project(lon, LAT).m, 1), **kw)
    return p.model_copy(update={"lon": lon, "lat": LAT + 0.005, "id": f"{service}-{lon}-{kw.get('kind', 'k')}"})


def test_beds_group_by_town_else_along_the_route(path):
    town = Settlement(lon=0.5, lat=LAT + 0.01, name="Ville", kind="town")
    places = [
        at(path, 0.49, "accommodation", kind="hotel", months="?" * 12),
        at(path, 0.51, "accommodation", kind="hotel", months="?" * 12),
        at(path, 0.50, "accommodation", kind="campsite", months="cccoooooooocc"[:12]),
        at(path, 0.50, "food"),
        at(path, 0.52, "food"),
        at(path, 0.505, "station", kind="rail", bikes="yes"),
        # Far from any town: two beds 1 km apart make one stop, a third 25 km on makes another.
        at(path, 1.50, "accommodation", kind="guest_house"),
        at(path, 1.512, "accommodation", kind="guest_house"),
        at(path, 1.80, "accommodation", kind="hostel"),
        at(path, 2.00, "accommodation", kind="hotel", counts=False),  # outside the counting limits: no stop
    ]
    coverage = Coverage(places, load_services("services-v0"), path.length)
    stops = build_stops(path, places, [town], coverage, 2027).stops
    assert [s.name for s in stops] == ["Ville", None, None]
    ville = stops[0]
    assert {b.kind: b.count for b in ville.beds} == {"campsite": 1, "hotel": 2}
    camp = next(b for b in ville.beds if b.kind == "campsite")
    assert camp.seasons == [("cccoooooooocc"[:12], 1)]
    assert ville.services["food"] == 2 and ville.station is not None
    assert (ville.lon, ville.lat) == (0.5, LAT + 0.01)  # the town's own position
    assert {b.kind: b.count for b in stops[1].beds} == {"guest_house": 2}
    assert stops[2].station is None
    assert len({s.id for s in stops}) == 3


# --- effort ----------------------------------------------------------------------------------------------------


def test_surface_letters_use_dreams_three_classes():
    assert surface_letter("ferry", None) == "f"
    assert surface_letter("quiet_road", "gravel") == "g"
    assert surface_letter("cycleway", "asphalt") == "c"
    assert surface_letter("unmatched", None) == "u"
    assert surface_letter(None, None) == "u"
    assert surface_letter("busy_road", "asphalt") == "r"


# --- highlights ------------------------------------------------------------------------------------------------


def test_highlight_kinds_and_ranks():
    assert kind_of({"tourism": "viewpoint"}) == "viewpoint"
    assert kind_of({"historic": "castle"}) == "castle"
    assert kind_of({"heritage": "1"}) == "heritage"
    assert kind_of({"natural": "peak", "mountain_pass": "yes"}) == "pass"
    assert kind_of({"amenity": "bench"}) is None
    assert rank("castle", unesco=True, linked=False, offset_m=900) == 1.0
    assert rank("castle", unesco=False, linked=True, offset_m=900) > rank("castle", False, False, 900)


def test_highlights_kept_near_the_route_once_each(path):
    raw = [
        {"id": "osm:n1", "kind": "viewpoint", "name": "Belvedere", "lon": 0.3, "lat": LAT + 0.005},
        {"id": "osm:w2", "kind": "viewpoint", "name": "Belvedere", "lon": 0.3005, "lat": LAT + 0.005},  # same one
        {"id": "osm:n3", "kind": "castle", "name": "Far castle", "lon": 0.6, "lat": LAT + 0.05},  # ~5.5 km off
        {"id": "osm:n4", "kind": "peak", "name": "Pic", "lon": 0.9, "lat": LAT + 0.015},  # 1.7 km: peaks reach 2 km
    ]
    for r in raw:
        r.update(ele=None, wikidata=None, wikipedia=None, unesco=False)
    kept = select(path, raw)
    assert [h.name for h in kept] == ["Belvedere", "Pic"]


# --- holiday dates ---------------------------------------------------------------------------------------------


def test_calendar_dates_with_their_year(tmp_path):
    oh = tmp_path / "openholidays"
    oh.mkdir()
    (oh / "countries.json").write_text(json.dumps([{"isoCode": "XX"}]))
    (oh / "publicholidays-XX-2027.json").write_text(
        json.dumps(
            [
                {"startDate": "2027-10-12", "endDate": "2027-10-12", "nationwide": True,
                 "name": [{"language": "EN", "text": "National Day"}]},
                {"startDate": "2027-05-01", "endDate": "2027-05-01", "nationwide": False,
                 "subdivisions": [{"code": "XX-A"}], "name": [{"language": "EN", "text": "Local Day"}]},
            ]
        )
    )
    for y in (2027, 2026, 2025):
        (oh / f"schoolholidays-XX-{y}.json").write_text("[]")
    src = CrowdingSource(tmp_path, 2027)
    cal = src.calendar("XX", src.covered())
    missing = src.calendar("YY", src.covered())
    src.close()
    assert cal.public_year == 2027 and [h.date for h in cal.public] == ["2027-05-01", "2027-10-12"]
    assert cal.public[0].regions == ["XX-A"] and cal.public[1].nationwide
    assert cal.school_year is None and cal.school == []  # nothing published: no data, not "no holidays" (D37)
    assert missing.public_year is None and missing.public == []
