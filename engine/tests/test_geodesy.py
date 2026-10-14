import pytest

from dpg_audit.lrs.geodesy import distance, local_scale, segment_lengths


def test_one_degree_of_latitude_at_equator():
    assert distance(0, 0, 0, 1) == pytest.approx(110_574.4, abs=1.0)


def test_segment_lengths_match_pairwise_distance():
    lon = [2.0, 2.01, 2.03]
    lat = [48.0, 48.0, 48.02]
    segs = segment_lengths(lon, lat)
    assert segs.shape == (2,)
    assert segs[0] == pytest.approx(distance(2.0, 48.0, 2.01, 48.0))
    assert segs[1] == pytest.approx(distance(2.01, 48.0, 2.03, 48.02))


def test_segment_lengths_of_single_point_is_empty():
    assert segment_lengths([1.0], [1.0]).size == 0


@pytest.mark.parametrize("lat", [0.0, 36.5, 45.0, 60.0])
def test_local_scale_matches_geodesic_for_small_steps(lat):
    kx, ky = local_scale(lat)
    step = 1e-3
    assert kx * step == pytest.approx(distance(10, lat, 10 + step, lat), rel=1e-5)
    assert ky * step == pytest.approx(distance(10, lat, 10, lat + step), rel=1e-5)
