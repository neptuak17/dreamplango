"""Cutting a measure axis into sections."""

import math
from collections.abc import Callable, Hashable, Sequence


def fixed_sections(length_m: float, size_m: float) -> list[tuple[float, float]]:
    """Consecutive [from, to) intervals of `size_m` covering [0, length_m]; the last may be shorter."""
    if size_m <= 0:
        raise ValueError("size must be positive")
    if length_m <= 0:
        return []
    # Boundaries are i * size (not accumulated) so rounding never drifts; an end sliver shorter than a
    # millionth of a section is folded into the previous section.
    n = max(1, math.ceil(length_m / size_m - 1e-6))
    bounds = [i * size_m for i in range(n)] + [length_m]
    return list(zip(bounds[:-1], bounds[1:], strict=True))


def runs[T](items: Sequence[T], key: Callable[[T], Hashable]) -> list[list[T]]:
    """Group consecutive items that share the same key."""
    groups: list[list[T]] = []
    for item in items:
        if groups and key(groups[-1][-1]) == key(item):
            groups[-1].append(item)
        else:
            groups.append([item])
    return groups
