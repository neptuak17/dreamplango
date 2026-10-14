from hypothesis import given
from hypothesis import strategies as st

from dpg_audit.build import choose_orientations


def chain(flips, jump_after=None):
    """Tracks of ~8 km heading east, end-to-start contiguous, optionally with a 300 km jump; stored ends."""
    ends = []
    lon = 0.0
    for i, flip in enumerate(flips):
        start, end = (lon, 45.0), (lon + 0.1, 45.0)
        ends.append((end, start) if flip else (start, end))
        lon += 0.1
        if jump_after is not None and i == jump_after:
            lon += 4.0
    return ends


@given(st.lists(st.booleans(), min_size=2, max_size=30))
def test_recovers_reversed_tracks(flips):
    assert choose_orientations(chain(flips), reverse_penalty_m=200) == flips


@given(st.lists(st.booleans(), min_size=4, max_size=20), st.data())
def test_recovers_across_a_long_jump(flips, data):
    jump_after = data.draw(st.integers(1, len(flips) - 3))
    assert choose_orientations(chain(flips, jump_after), reverse_penalty_m=200) == flips


def test_single_track_is_never_flipped():
    assert choose_orientations(chain([True]), reverse_penalty_m=200) == [False]
    assert choose_orientations([], reverse_penalty_m=200) == []
