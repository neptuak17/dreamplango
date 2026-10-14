import pytest

from dpg_audit.match.matcher import Piece, merge_pieces, pieces_from_trace


def response(points, edges):
    return {"matched_points": points, "edges": edges}


def test_points_on_one_edge_map_to_that_edge():
    resp = response(
        [
            {"type": "matched", "edge_index": 0, "distance_along_edge": 0.1},
            {"type": "matched", "edge_index": 0, "distance_along_edge": 0.9},
        ],
        [{"way_id": 11, "length": 1.0, "use": "road"}],
    )
    pieces, matched = pieces_from_trace([0.0, 800.0], resp)
    assert len(pieces) == 1
    assert (pieces[0].from_m, pieces[0].to_m, pieces[0].edge["way_id"]) == (0.0, 800.0, 11)
    assert matched == pytest.approx(800.0)


def test_interval_spanning_edges_is_split_by_matched_length():
    # point 0 at 50% of a 200 m edge, point 1 at 50% of the next 600 m edge: 100 m + 300 m matched
    resp = response(
        [
            {"type": "matched", "edge_index": 0, "distance_along_edge": 0.5},
            {"type": "matched", "edge_index": 1, "distance_along_edge": 0.5},
        ],
        [{"way_id": 1, "length": 0.2}, {"way_id": 2, "length": 0.6}],
    )
    pieces, _ = pieces_from_trace([1000.0, 1400.0], resp)
    assert [(round(p.from_m), round(p.to_m), p.edge["way_id"]) for p in pieces] == [(1000, 1100, 1), (1100, 1400, 2)]
    assert not any(p.approx for p in pieces)


def test_unmatched_points_and_long_segments():
    resp = response(
        [
            {"type": "matched", "edge_index": 0, "distance_along_edge": 0.0},
            {"type": "unmatched"},
            {"type": "matched", "edge_index": 0, "distance_along_edge": 0.2},
            {"type": "matched", "edge_index": 1, "distance_along_edge": 1.0},
        ],
        [{"way_id": 5, "length": 0.1}, {"way_id": 6, "length": 3.0}],
    )
    pieces, _ = pieces_from_trace([0.0, 50.0, 100.0, 3100.0], resp)
    assert pieces[0].edge is None and pieces[0].to_m == 100.0  # both intervals touching the unmatched point
    assert all(p.approx for p in pieces[1:])  # 3 km between points: Valhalla's routed guess
    assert pieces[-1].to_m == 3100.0


def test_backwards_edge_index_is_treated_as_unmatched():
    resp = response(
        [
            {"type": "matched", "edge_index": 1, "distance_along_edge": 0.5},
            {"type": "matched", "edge_index": 0, "distance_along_edge": 0.5},
        ],
        [{"way_id": 1, "length": 0.1}, {"way_id": 2, "length": 0.1}],
    )
    assert pieces_from_trace([0.0, 10.0], resp)[0][0].edge is None


def test_merge_pieces_joins_identical_neighbours():
    a, b, c = Piece(0, 10, {"way_id": 1}), Piece(10, 20, {"way_id": 1}), Piece(20, 30, {"way_id": 2})
    merged = merge_pieces([a, b, c])
    assert [(p.from_m, p.to_m) for p in merged] == [(0, 20), (20, 30)]
