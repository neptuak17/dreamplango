"""Map-match each ride line to OSM via Valhalla, and lay the matched edges onto the route's measure axis.

The official track stays the measure axis (km 0 → km N). Each pair of consecutive track points is assigned to the
edges Valhalla matched between them, split in proportion to the matched lengths. Pieces between points far apart
(sparse or straight-line source geometry) are flagged `approx`, since the matched path there is Valhalla's guess.
"""

import hashlib
import json
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from dpg_audit.lrs import MeasuredLine
from dpg_audit.match.valhalla import Valhalla, ValhallaError

MATCH_VERSION = "3"
"""Bump when matching options or the piece mapping change, to invalidate cached matches."""

EDGE_KEYS = (
    "way_id",
    "road_class",
    "use",
    "surface",
    "cycle_lane",
    "speed_limit",
    "lane_count",
    "bridge",
    "tunnel",
    "unpaved",
    "sac_scale",
    "bicycle_network",
    "traversability",
    "shoulder",
    "density",
)
APPROX_SEGMENT_M = 1000.0
"""Source segments longer than this are matched by Valhalla routing between distant points: flagged approximate."""
MIN_CHUNK_POINTS = 4


@dataclass
class Piece:
    from_m: float
    to_m: float
    edge: dict[str, Any] | None
    """Selected Valhalla edge attributes (incl. OSM way_id); None where the track could not be matched."""
    approx: bool = False


@dataclass
class LineMatch:
    pieces: list[Piece]
    matched_length_m: float
    errors: list[str] = field(default_factory=list)


def _edge_attrs(edge: dict) -> dict[str, Any]:
    return {k: edge[k] for k in EDGE_KEYS if k in edge}


def pieces_from_trace(ms: Sequence[float], response: dict) -> tuple[list[Piece], float]:
    """Turn a trace_attributes response for points at measures `ms` into measure pieces."""
    points = response.get("matched_points", [])
    edges = response.get("edges", [])
    lengths = [float(e.get("length", 0.0)) * 1000.0 for e in edges]
    pieces: list[Piece] = []
    matched = 0.0
    for i in range(len(ms) - 1):
        m0, m1 = float(ms[i]), float(ms[i + 1])
        if m1 <= m0:
            continue
        a, b = points[i] if i < len(points) else {}, points[i + 1] if i + 1 < len(points) else {}
        ea, eb = a.get("edge_index"), b.get("edge_index")
        broken = (
            a.get("type") == "unmatched"
            or b.get("type") == "unmatched"
            or ea is None
            or eb is None
            or ea >= len(edges)
            or eb >= len(edges)
            or eb < ea
            or a.get("end_route_discontinuity")
            or b.get("begin_route_discontinuity")
        )
        if broken:
            pieces.append(Piece(m0, m1, None))
            continue
        fa, fb = float(a.get("distance_along_edge", 0.0)), float(b.get("distance_along_edge", 0.0))
        if ea == eb:
            parts = [(ea, max(fb - fa, 0.0) * lengths[ea])]
        else:
            parts = [(ea, (1.0 - fa) * lengths[ea])]
            parts += [(k, lengths[k]) for k in range(ea + 1, eb)]
            parts.append((eb, fb * lengths[eb]))
        parts = [(k, length) for k, length in parts if length > 0] or [(ea, 1.0)]
        total = sum(length for _, length in parts)
        matched += total if total > 1.0 else 0.0
        approx = (m1 - m0) > APPROX_SEGMENT_M
        cursor = m0
        for k, length in parts:
            step = (m1 - m0) * length / total
            pieces.append(Piece(cursor, cursor + step, _edge_attrs(edges[k]), approx))
            cursor += step
        pieces[-1].to_m = m1  # absorb rounding
    return merge_pieces(pieces), matched


def merge_pieces(pieces: list[Piece]) -> list[Piece]:
    out: list[Piece] = []
    for p in pieces:
        if out and out[-1].edge == p.edge and out[-1].approx == p.approx and abs(out[-1].to_m - p.from_m) < 1e-6:
            out[-1].to_m = p.to_m
        else:
            out.append(Piece(p.from_m, p.to_m, p.edge, p.approx))
    return out


def _match_range(client: Valhalla, pts: list[tuple[float, float]], ms: list[float], errors: list[str]):
    """Match a run of points; on failure split in two (sharing the middle point) until runs are tiny."""
    try:
        return pieces_from_trace(ms, client.trace_attributes(pts))
    except ValhallaError as err:
        if len(pts) <= MIN_CHUNK_POINTS:
            reason = err.body if isinstance(err.body, str) else err.body.get("error", err.body)
            errors.append(f"{ms[0]:.0f}-{ms[-1]:.0f} m: {reason}")
            return [Piece(ms[0], ms[-1], None)], 0.0
        mid = len(pts) // 2
        left, ml = _match_range(client, pts[: mid + 1], ms[: mid + 1], errors)
        right, mr = _match_range(client, pts[mid:], ms[mid:], errors)
        return merge_pieces(left + right), ml + mr


def match_line(client: Valhalla, line: MeasuredLine) -> LineMatch:
    pts = list(zip(line.lon.tolist(), line.lat.tolist(), strict=True))
    errors: list[str] = []
    pieces, matched = _match_range(client, pts, line.cum.tolist(), errors)
    return LineMatch(pieces=pieces, matched_length_m=matched, errors=errors)


def _cache_key(line: MeasuredLine, tileset: str) -> str:
    payload = json.dumps(
        {
            "v": MATCH_VERSION,
            "tiles": tileset,
            "pts": [[round(x, 7), round(y, 7)] for x, y in zip(line.lon, line.lat, strict=True)],
        }
    )
    return hashlib.sha256(payload.encode()).hexdigest()[:24]


def match_lines(
    client: Valhalla, lines: list[MeasuredLine], cache_dir: Path, tileset: str, workers: int = 6
) -> list[LineMatch]:
    """Match every line (local measures from 0), using an on-disk cache keyed by geometry and tileset."""
    cache_dir.mkdir(parents=True, exist_ok=True)

    def one(line: MeasuredLine) -> LineMatch:
        path = cache_dir / f"{_cache_key(line, tileset)}.json"
        if path.exists():
            raw = json.loads(path.read_text(encoding="utf-8"))
            return LineMatch(
                pieces=[Piece(**p) for p in raw["pieces"]],
                matched_length_m=raw["matched_length_m"],
                errors=raw["errors"],
            )
        result = match_line(client, line)
        path.write_text(json.dumps(asdict(result)), encoding="utf-8")
        return result

    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(one, lines))
