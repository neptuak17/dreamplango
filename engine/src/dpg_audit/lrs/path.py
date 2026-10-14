"""A route path: ride lines laid end to end on one measure axis, with zero-length gaps between them."""

from dataclasses import dataclass, replace

from dpg_audit.lrs.line import MeasuredLine, Projection


@dataclass(frozen=True)
class PathPart:
    line: MeasuredLine
    from_m: float

    @property
    def to_m(self) -> float:
        return self.from_m + self.line.length


class RoutePath:
    def __init__(self, lines: list[MeasuredLine]):
        if not lines:
            raise ValueError("a path needs at least one line")
        parts, m = [], 0.0
        for line in lines:
            parts.append(PathPart(line, m))
            m += line.length
        self.parts: list[PathPart] = parts

    @property
    def length(self) -> float:
        return self.parts[-1].to_m

    def part_at(self, m: float) -> PathPart:
        """The part containing measure m. At a boundary the earlier part wins."""
        m = min(max(m, 0.0), self.length)
        for part in self.parts:
            if m <= part.to_m:
                return part
        return self.parts[-1]

    def locate(self, m: float) -> tuple[float, float]:
        part = self.part_at(m)
        return part.line.locate(m - part.from_m)

    def project(self, lon: float, lat: float) -> Projection:
        """Closest point over all parts, with the measure expressed on the path axis."""
        best: Projection | None = None
        best_part: PathPart | None = None
        for part in self.parts:
            p = part.line.project(lon, lat)
            if best is None or p.offset_m < best.offset_m:
                best, best_part = p, part
        assert best is not None and best_part is not None
        return replace(best, m=best.m + best_part.from_m)
