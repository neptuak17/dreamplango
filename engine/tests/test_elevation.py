import numpy as np
import pytest

from dpg_audit.layers import elevation as el
from dpg_audit.lrs import MeasuredLine, RoutePath


def straight_path(km: float = 10.0) -> RoutePath:
    # due east along 45°N; 1° of longitude there is ~78.8 km
    return RoutePath([MeasuredLine([5.0, 5.0 + km / 78.85], [45.0, 45.0])])


def ramp_sampler(lon, lat):
    """Flat for 2 km, then 5% for 2 km (+100 m), then flat."""
    m = (np.asarray(lon) - 5.0) * 78_850
    return np.clip((m - 2000) * 0.05, 0, 100) + 200


def test_extrema_ignore_small_wiggles():
    ele = np.array([0, 2, 1, 3, 20, 18, 40, 10, 12, 0], dtype=float)
    assert el._extrema(ele, 5.0) == [0, 6, 9]


def test_ascent_descent_on_ramp():
    profs = el.profiles(straight_path(), ramp_sampler, [])
    up, down = el.ascent_descent(profs, 0, 10_000)
    assert up == pytest.approx(100, abs=3)
    assert down == pytest.approx(0, abs=3)


def test_ascent_on_real_terrain_only():
    profs = el.profiles(straight_path(), ramp_sampler, [])
    el.mark_untrusted(profs, [(2500.0, 3500.0)])  # the middle of the ramp is placeholder geometry
    up, _ = el.ascent_descent(profs, 0, 10_000, trusted_only=True)
    # the 25 m on each side of the placeholder still counts; the 50 m under it doesn't, nor any step across it
    assert up == pytest.approx(50, abs=5)
    assert el.ascent_descent(profs, 0, 10_000)[0] == pytest.approx(100, abs=3)  # default unchanged


def test_gradient_events_and_classes():
    profs = el.profiles(straight_path(), ramp_sampler, [])
    events = el.gradient_events(profs)
    assert {e.value for e in events} == {"flat", "moderate"}
    moderate = [e for e in events if e.value == "moderate"]
    assert sum(e.to_m - e.from_m for e in moderate) == pytest.approx(2000, abs=250)
    assert moderate[0].detail["max_grade"] == pytest.approx(5.0, abs=0.6)


def test_climb_detected_with_fiets():
    profs = el.profiles(straight_path(), ramp_sampler, [])
    climbs = el.climbs(profs)
    assert len(climbs) == 1
    c = climbs[0]
    assert c.direction == "forward"
    assert c.gain_m == pytest.approx(100, abs=3)
    assert c.avg_grade == pytest.approx(5.0, abs=0.6)
    assert c.fiets == pytest.approx(el.fiets(c.gain_m, c.length_m, c.top_m), abs=0.01)


def test_building_spikes_are_removed():
    def with_buildings(lon, lat):
        m = (np.asarray(lon) - 5.0) * 78_850
        spikes = ((m % 400) < 50) * 25.0  # a 25 m building every 400 m, 50 m wide
        return 100.0 + spikes

    profs = el.profiles(straight_path(), with_buildings, [])
    up, _ = el.ascent_descent(profs, 0, 10_000)
    assert up < 10  # flat road: the roofs are not climbing


def test_implausible_grades_are_unknown():
    def cliff(lon, lat):
        m = (np.asarray(lon) - 5.0) * 78_850
        return np.where(m < 5000, 0.0, 200.0)  # 200 m step: no road does that

    events = el.gradient_events(el.profiles(straight_path(), cliff, []))
    assert any(e.value == "unknown" for e in events)
    assert not el.climbs(el.profiles(straight_path(), cliff, []))


def test_max_grade_ignores_untrusted_and_implausible():
    profs = el.profiles(straight_path(), ramp_sampler, [])
    assert el.max_grade_window(profs, 0, 10_000) == pytest.approx(5.0, abs=0.6)
    el.mark_untrusted(profs, [(1500.0, 4500.0)])  # the whole ramp sits on placeholder geometry
    assert (el.max_grade_window(profs, 0, 10_000) or 0) < 1.0


def test_structures_are_interpolated_not_sampled():
    def bridge_dip(lon, lat):
        m = (np.asarray(lon) - 5.0) * 78_850
        return np.where((m > 4000) & (m < 4400), 100.0, 150.0)  # DEM sees the river 50 m below the bridge

    plain = el.profiles(straight_path(), bridge_dip, [])
    bridged = el.profiles(straight_path(), bridge_dip, [(4000.0, 4400.0)])
    assert el.at(plain, np.array([4200.0]))[0] < 120
    assert el.at(bridged, np.array([4200.0]))[0] == pytest.approx(150, abs=1)


@pytest.mark.parametrize(
    ("g", "cls"), [(0.5, "flat"), (-3, "gentle"), (5, "moderate"), (7.9, "steep"), (9, "very_steep"), (-12, "extreme")]
)
def test_grade_class(g, cls):
    assert el.grade_class(g) == cls
