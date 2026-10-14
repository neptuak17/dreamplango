import math

import numpy as np
import pytest
from hypothesis import assume, given, settings
from hypothesis import strategies as st

from dpg_audit.lrs import MeasuredLine, RoutePath
from dpg_audit.lrs.geodesy import local_scale


@st.composite
def eastward_lines(draw, min_points=2, max_points=40):
    """Lines whose longitude strictly increases, so they never cross or fold back on themselves."""
    n = draw(st.integers(min_points, max_points))
    lon0 = draw(st.floats(-10, 30))
    lat0 = draw(st.floats(35, 55))
    dlon = draw(st.lists(st.floats(1e-4, 1e-2), min_size=n - 1, max_size=n - 1))
    dlat = draw(st.lists(st.floats(-5e-3, 5e-3), min_size=n - 1, max_size=n - 1))
    lon = np.concatenate([[lon0], lon0 + np.cumsum(dlon)])
    lat = np.concatenate([[lat0], lat0 + np.cumsum(dlat)])
    ele = draw(st.lists(st.floats(-50, 3000), min_size=n, max_size=n))
    return MeasuredLine(lon, lat, ele)


@given(eastward_lines())
def test_measures_are_cumulative_segment_lengths(line):
    assert line.cum[0] == 0
    assert np.all(np.diff(line.cum) >= 0)
    assert line.length == pytest.approx(float(np.sum(line.seg_len)))


@given(eastward_lines(), st.floats(0, 1))
def test_locate_then_project_round_trips(line, frac):
    m = frac * line.length
    lon, lat = line.locate(m)
    p = line.project(lon, lat)
    assert p.m == pytest.approx(m, abs=1e-3)
    assert p.offset_m < 1e-3


@given(eastward_lines(), st.floats(0, 1), st.floats(0, 1))
def test_slice_length_equals_measure_span(line, a, b):
    m0, m1 = sorted((a * line.length, b * line.length))
    assume(m1 - m0 > 1.0)
    part = line.slice(m0, m1)
    # The two interpolated end points are linear in lon/lat (see line.py), so each may be off by up to
    # ~tan(lat) * dlat of its segment's length; the generator keeps dlat <= 5e-3 deg and lat <= 55 deg.
    bound = math.tan(math.radians(55)) * math.radians(5e-3) * 2 * float(line.seg_len.max())
    assert part.length == pytest.approx(m1 - m0, abs=bound + 1e-3)
    assert part.locate(0.0) == pytest.approx(line.locate(m0))
    assert part.locate(part.length) == pytest.approx(line.locate(m1))


@given(eastward_lines(), st.floats(0, 1))
def test_reversed_line_mirrors_measures(line, frac):
    rev = line.reversed()
    m = frac * line.length
    assert rev.length == pytest.approx(line.length)
    assert rev.locate(line.length - m) == pytest.approx(line.locate(m), abs=1e-9)


@given(eastward_lines(), st.floats(5, 500))
def test_resample_keeps_ends_and_step(line, step):
    assume(line.length > 0)
    res = line.resample(step)
    assert (res.lon[0], res.lat[0]) == pytest.approx((line.lon[0], line.lat[0]))
    assert (res.lon[-1], res.lat[-1]) == pytest.approx((line.lon[-1], line.lat[-1]))
    assert np.all(res.seg_len <= step * (1 + 1e-4))
    assert res.length <= line.length * (1 + 1e-7)


@settings(max_examples=200)
@given(eastward_lines(), st.data())
def test_project_reports_offset_and_side(line, data):
    i = data.draw(st.integers(0, len(line) - 2))
    assume(line.seg_len[i] > 20)
    m = float(line.cum[i] + 0.5 * line.seg_len[i])
    lon, lat = line.locate(m)
    kx, ky = local_scale(lat)
    dx = (line.lon[i + 1] - line.lon[i]) * kx
    dy = (line.lat[i + 1] - line.lat[i]) * ky
    norm = math.hypot(dx, dy)
    side = data.draw(st.sampled_from([1, -1]))
    d = 1.0
    qlon = lon + side * (-dy / norm) * d / kx
    qlat = lat + side * (dx / norm) * d / ky
    p = line.project(qlon, qlat)
    assert p.offset_m == pytest.approx(d, abs=0.01)
    assert p.side == side
    assert p.m == pytest.approx(m, abs=0.01)


def test_elevation_interpolates():
    line = MeasuredLine([0.0, 0.001], [45.0, 45.0], [100.0, 200.0])
    assert line.elevation_at(line.length / 2) == pytest.approx(150.0)
    assert MeasuredLine([0.0, 0.001], [45.0, 45.0]).elevation_at(1.0) is None


def test_zero_length_segments_are_harmless():
    line = MeasuredLine([1.0, 1.0, 1.001], [45.0, 45.0, 45.0])
    assert line.locate(0.0) == pytest.approx((1.0, 45.0))
    assert line.project(1.0005, 45.0).m == pytest.approx(line.length / 2, rel=1e-6)


def test_rejects_degenerate_input():
    with pytest.raises(ValueError):
        MeasuredLine([1.0], [2.0])
    with pytest.raises(ValueError):
        MeasuredLine([1.0, 2.0], [2.0])


def test_route_path_offsets_measures_across_parts():
    a = MeasuredLine([0.0, 0.01], [45.0, 45.0])
    b = MeasuredLine([0.5, 0.51], [45.0, 45.0])  # disconnected: a gap between the parts
    path = RoutePath([a, b])
    assert path.length == pytest.approx(a.length + b.length)
    p = path.project(0.505, 45.0001)
    assert p.m == pytest.approx(a.length + b.length / 2, abs=0.5)
    assert path.locate(a.length + b.length / 2) == pytest.approx((0.505, 45.0), abs=1e-6)
    assert path.part_at(a.length) is path.parts[0]
