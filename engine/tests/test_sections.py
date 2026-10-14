import math

import pytest
from hypothesis import given
from hypothesis import strategies as st

from dpg_audit.lrs.sections import fixed_sections, runs


@given(st.floats(0, 8_000_000), st.floats(100, 100_000))
def test_fixed_sections_partition_the_axis(length, size):
    secs = fixed_sections(length, size)
    if length == 0:
        assert secs == []
        return
    assert secs[0][0] == 0
    assert secs[-1][1] == length
    assert all(a[1] == b[0] for a, b in zip(secs, secs[1:], strict=False))
    assert all(0 < b - a <= size * (1 + 1e-6) for a, b in secs)
    n = math.ceil(length / size)
    assert len(secs) in (max(1, n), max(1, n - 1))  # any positive length gets at least one section
    assert all(b - a >= size * (1 - 1e-9) for a, b in secs[:-1])


def test_fixed_sections_rejects_bad_size():
    with pytest.raises(ValueError):
        fixed_sections(10, 0)


def test_runs_groups_consecutive_equal_keys():
    assert runs([1, 1, 2, 2, 2, 1], key=lambda x: x) == [[1, 1], [2, 2, 2], [1]]
    assert runs([], key=lambda x: x) == []
