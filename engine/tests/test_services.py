import numpy as np
import pytest
from test_rules import day

from dpg_audit.lrs import MeasuredLine, RoutePath
from dpg_audit.lrs.index import RouteIndex
from dpg_audit.models import MinorFile, MinorSection, Place
from dpg_audit.rules.profile import load_rules
from dpg_audit.services import coverage
from dpg_audit.services.access import AccessJob, _batches
from dpg_audit.services.catalog import classify_osm, classify_overture
from dpg_audit.services.conflate import confidence, conflate
from dpg_audit.services.osm_places import RawPlace
from dpg_audit.services.policy import BikePolicy
from dpg_audit.services.profile import load_services
from dpg_audit.services.seasons import evaluate as season
from dpg_audit.services.seasons import month_codes

# --- seasons ---------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("expr", "codes"),
    [
        ("24/7", "oooooooooooo"),
        ("Mo-Fr 09:00-18:00; PH off", "oooooooooooo"),
        ("Apr-Oct: 08:00-20:00", "cccooooooocc"),
        ("Jun 15-Sep 15", "cccccpoopccc"),  # the season starts and ends mid-month
        ("Apr 14-Oct 15", "cccpooooopcc"),
        ("Mo-Su 08:00-18:00; Dec 24-Jan 2 off", "ooooooooooop"),  # 2 closed days in January are no break
        ("off", "cccccccccccc"),
        ("this is not opening hours", "????????????"),
    ],
)
def test_opening_hours_by_month(expr, codes):
    assert season(expr, 2027) == codes


def test_seasonal_tag_without_hours():
    assert month_codes({"seasonal": "no"}, 2027) == "o" * 12
    assert month_codes({"seasonal": "summer"}, 2027) == "?????ooo????"
    assert month_codes({"seasonal": "yes"}, 2027) == "?" * 12
    assert month_codes({}, 2027) == "?" * 12


# --- catalogue -------------------------------------------------------------------------------------------------


def test_classify_osm():
    assert classify_osm({"tourism": "camp_site"}) == ("accommodation", "campsite")
    assert classify_osm({"tourism": "hotel", "amenity": "restaurant"}) == ("accommodation", "hotel")
    assert classify_osm({"tourism": "apartment"}) is None  # holiday rentals rarely take one-night stays
    assert classify_osm({"amenity": "drinking_water"}) == ("water", "tap")
    assert classify_osm({"amenity": "fountain"}) is None
    assert classify_osm({"amenity": "fountain", "drinking_water": "yes"}) == ("water", "tap")
    assert classify_osm({"shop": "bicycle", "service:bicycle:repair": "yes"}) == ("bike_shop", "repair")
    assert classify_osm({"amenity": "bank", "atm": "yes"}) == ("atm", "bank")
    assert classify_osm({"amenity": "bank"}) is None
    assert classify_osm({"railway": "station"}) == ("station", "rail")
    assert classify_osm({"railway": "station", "station": "subway"}) is None
    assert classify_osm({"amenity": "ferry_terminal"}) == ("station", "ferry_terminal")
    assert classify_osm({"amenity": "toilets", "access": "private"}) is None


def test_classify_overture():
    assert classify_overture("lodging", "hostel") == ("accommodation", "hostel")
    assert classify_overture("private_lodging", "holiday_rental_home") is None
    assert classify_overture("restaurant", "spanish_restaurant") == ("food", "restaurant")
    assert classify_overture("food_and_beverage_store", "liquor_store") is None
    assert classify_overture("sporting_goods_store", "bike_store") == ("bike_shop", "shop")


# --- conflation ------------------------------------------------------------------------------------------------


def raw(source, rid, service, name, lon, lat, conf=None):
    return RawPlace(source, rid, service, "k", name, lon, lat, {}, conf)


def test_conflate_merges_same_place_across_sources():
    a = raw("osm", "n1", "accommodation", "Camping Les Pins", 3.0, 43.0)
    b = raw("overture", "x", "accommodation", "Camping les Pins ***", 3.0010, 43.0, 0.95)  # ~80 m east
    c = raw("overture", "y", "food", "Camping Les Pins", 3.0, 43.0, 0.95)  # same name, other service
    d = raw("overture", "z", "accommodation", "Hotel Miramar", 3.0005, 43.0, 0.95)
    groups = conflate([b, c, d, a])
    by_primary = {g.primary.id: g for g in groups}
    assert set(by_primary) == {"n1", "y", "z"}
    assert by_primary["n1"].sources == ["osm:n1", "overture:x"]
    assert confidence(by_primary["n1"]) == "high"
    assert confidence(by_primary["z"]) == "medium"


def test_unnamed_places_merge_only_when_very_close():
    a = raw("osm", "n1", "water", None, 3.0, 43.0)
    b = raw("osm", "n2", "water", None, 3.0002, 43.0)  # ~16 m
    c = raw("osm", "n3", "water", None, 3.0010, 43.0)  # ~80 m
    assert len(conflate([a, b, c])) == 2


# --- route index -----------------------------------------------------------------------------------------------


def test_route_index_projection_matches_path_projection():
    rng = np.random.default_rng(1)
    lon = np.cumsum(rng.normal(0.002, 0.001, 200)) + 5.0
    lat = np.cumsum(rng.normal(0.0, 0.002, 200)) + 45.0
    path = RoutePath([MeasuredLine(lon[:120], lat[:120]), MeasuredLine(lon[120:], lat[120:])])
    index = RouteIndex(path)
    qlon = rng.uniform(lon.min(), lon.max(), 50)
    qlat = rng.uniform(lat.min(), lat.max(), 50)
    for p, x, y in zip(index.project(qlon, qlat), qlon, qlat, strict=True):
        exact = path.project(float(x), float(y))
        assert p.offset_m == pytest.approx(exact.offset_m, abs=0.5)
    near = index.within(qlon, qlat, 1000.0)
    offsets = np.array([p.offset_m for p in index.project(qlon, qlat)])
    assert near[offsets < 1000].all()


def test_access_batches_respect_matrix_limit():
    jobs = [AccessJob(str(i), 0, 0, "bicycle", list(range(i, i + 40))) for i in range(0, 400, 4)]
    batches = _batches(jobs, 2500)
    assert sum(len(b) for b in batches) == len(jobs)
    for b in batches:
        assert len({s for j in b for s in j.sources}) * len(b) <= 2500


# --- policy ----------------------------------------------------------------------------------------------------


def test_bike_policy_lookup():
    policy = BikePolicy.load()
    assert policy.lookup("rail", "ES", {"operator": "Renfe Viajeros"}).bikes == "yes"
    assert policy.lookup("rail", "ES", {"operator": "Ferrocarrils de la Generalitat"}).bikes == "unknown"
    assert policy.lookup("rail", "BA", {}).bikes == "no"
    assert policy.lookup("rail", "TR", {"operator": "İZBAN"}).bikes == "limited"
    assert policy.lookup("ferry_terminal", "GR", {}).bikes == "yes"
    assert policy.lookup("rail", "XX", {}) is None


# --- coverage --------------------------------------------------------------------------------------------------


def place(service, at, *, kind="k", counts=True, months="o" * 12, bikes=None, access_m=100.0):
    detail = {"bikes": bikes} if bikes else {}
    return Place(
        id=f"{service}{at}",
        service=service,
        kind=kind,
        name=f"{service} at {at}",
        lon=0,
        lat=0,
        at_m=at,
        offset_m=50,
        side="left",
        access_m=access_m,
        access_min=1.0,
        climb_m=0,
        access_at_m=at,
        counts=counts,
        on_route=True,
        months=months,
        opening_hours=None,
        country="FR",
        sources=["osm:n1"],
        confidence="medium",
        detail=detail,
    )


def test_month_label():
    assert coverage.month_label([9, 10, 11]) == "Oct–Dec"
    assert coverage.month_label([10, 11, 0, 1]) == "Nov–Feb"
    assert coverage.month_label([0, 5]) == "Jan, Jun"
    assert coverage.month_label(range(12)) == "All year"


def test_gaps_and_seasonal_findings():
    profile = load_services()
    summer = "cccooooooccc"  # Apr-Sep only
    places = [
        place("accommodation", 10_000),
        place("accommodation", 60_000, months=summer),
        place("accommodation", 110_000),
        place("accommodation", 300_000),  # 190 km gap before this one: an all-year gap
    ]
    cov = coverage.Coverage(places, profile, 320_000)
    found = coverage.findings(cov, lambda m: (0.0, 0.0))
    gaps = [f for f in found if f["rule_id"] == "services.gap" and f["evidence"]["service"] == "accommodation"]
    assert [(f["from_m"], f["to_m"]) for f in gaps] == [(110_000, 300_000)]
    seasonal = [f for f in found if f["rule_id"] == "services.seasonal_gap"]
    assert len(seasonal) == 1
    assert (seasonal[0]["from_m"], seasonal[0]["to_m"]) == (10_000, 110_000)
    assert seasonal[0]["title"].startswith("Oct–Mar: 100 km without open accommodation")
    assert seasonal[0]["evidence"]["closing"] == 1


def test_water_gap_is_filled_by_shops():
    profile = load_services()
    places = [place("water", 0), place("food", 30_000), place("water", 60_000)]
    cov = coverage.Coverage(places, profile, 60_000)
    found = coverage.findings(cov, lambda m: (0.0, 0.0))
    assert not [f for f in found if f["evidence"].get("service") == "water"]


def test_services_criteria_per_minor_section():
    rules = load_rules()
    daily = [day(1, 0, 3000), day(2, 3000, 6000)]
    minor = MinorFile(
        size_m=1000,
        criteria=rules.criterion_info(),
        sections=[
            MinorSection(index=i, from_m=i * 1000, to_m=(i + 1) * 1000, values={}, criteria={}) for i in range(6)
        ],
    )
    places = [
        place("accommodation", 500, kind="campsite"),
        place("food", 1500),
        place("bike_shop", 4000),
        place("station", 2000, bikes="yes"),
        place("toilets", 2500),
    ]
    cov = coverage.Coverage(places, load_services(), 6000)
    coverage.apply_criteria(cov, minor, daily, rules)
    first, last = minor.sections[0].criteria, minor.sections[5].criteria
    assert first["accommodation"] == "pass" and first["accommodation_choice"] == "fail"
    assert first["food_water"] == "pass" and first["bike_repair"] == "fail"
    assert last["accommodation"] == "fail" and last["bike_repair"] == "pass" and last["repair_shop"] == "pass"
    assert first["pt_access"] == "pass" and first["toilets"] == "pass"


def test_unknown_bike_policy_makes_pt_unknown_not_fail():
    rules = load_rules()
    minor = MinorFile(
        size_m=1000,
        criteria=rules.criterion_info(),
        sections=[MinorSection(index=0, from_m=100_000, to_m=101_000, values={}, criteria={})],
    )
    places = [
        place("station", 0, bikes="yes"),
        place("station", 120_000, bikes="unknown"),
        place("station", 250_000, bikes="yes"),
    ]
    cov = coverage.Coverage(places, load_services(), 250_000)
    coverage.apply_criteria(cov, minor, [day(1, 0, 250_000)], rules)
    assert minor.sections[0].criteria["pt_access"] == "unknown"  # 250 km known gap, 120/130 km with the unknown one


def test_gap_list_per_month_for_the_strip():
    profile = load_services()
    places = [
        place("accommodation", 10_000),
        place("accommodation", 60_000, months="cccooooooccc"),
        place("accommodation", 110_000),
    ]
    cov = coverage.Coverage(places, profile, 110_000)
    acc = [(g.month, g.from_m, g.to_m) for g in cov.gap_list() if g.service == "accommodation"]
    assert (None, 10_000, 60_000) in acc  # 50 km >= half the 70 km threshold
    assert (0, 10_000, 110_000) in acc  # January: the summer-only place is closed
    assert (6, 10_000, 110_000) not in acc
    assert any(g.service == "bail_out" for g in cov.gap_list())  # no stations at all
