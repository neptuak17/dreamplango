from dpg_audit.layers.gaps import CuratedGap, classify_gaps
from dpg_audit.models import (
    Component,
    ComponentKind,
    DailySection,
    DevelopmentLevel,
    EuroVeloStatus,
    Event,
    GapType,
    Signage,
)
from dpg_audit.rules.evaluate import LayerIndex, evaluate
from dpg_audit.rules.findings import runs
from dpg_audit.rules.profile import load_route_config, load_rules


def ev(layer, a, b, value, **detail):
    return Event(layer=layer, from_m=a, to_m=b, value=value, confidence="medium", detail=detail)


def day(number, a, b, signage=Signage.SIGNED):
    status = EuroVeloStatus(development=DevelopmentLevel.DEVELOPED, signage=signage, label="x")
    return DailySection(
        id=f"d{number}",
        number=number,
        title="t",
        start_name=None,
        end_name=None,
        from_m=a,
        to_m=b,
        length_m=b - a,
        status=status,
        reversed_in_source=False,
        point_count=2,
        start=(0, 0),
        end=(0, 0),
    )


def test_layer_index_lengths():
    idx = LayerIndex([ev("s", 0, 600, "a"), ev("s", 600, 1500, "b")])
    assert idx.lengths(500, 1000) == {"a": 100, "b": 400}


def test_evaluate_criteria_per_kilometre():
    profile = load_rules()
    events = [
        # km 0: calm, paved, flat; km 1: 300 m of LTS 4 and gravel; km 2: unmatched
        ev("traffic_stress", 0, 1000, "1"),
        ev("traffic_stress", 1000, 1300, "4"),
        ev("traffic_stress", 1300, 2000, "2"),
        ev("traffic_stress", 2000, 3000, "unmatched"),
        ev("surface", 0, 1000, "paved_smooth"),
        ev("surface", 1000, 2000, "gravel"),
        ev("surface", 2000, 3000, "unmatched"),
        ev("infrastructure", 0, 2000, "quiet_road"),
        ev("infrastructure", 2000, 3000, "unmatched"),
        ev("gradient", 0, 3000, "flat"),
    ]
    minor = evaluate(profile, events, [day(1, 0, 3000)], [], 3000)
    k0, k1, k2 = (s.criteria for s in minor.sections)
    assert all(v == "pass" for v in k0.values())
    assert k1["traffic_safety"] == "fail" and k1["low_traffic"] == "fail" and k1["surface"] == "fail"
    assert k2["continuity"] == "fail" and k2["traffic_safety"] == "unknown"
    assert minor.sections[1].values["surface"] == "gravel"


def test_missing_gap_fails_continuity_and_unsigned_fails_signage():
    profile = load_rules()
    gap = Component(
        id="c2",
        seq=1,
        kind=ComponentKind.GAP,
        from_m=500,
        to_m=500,
        length_m=0,
        start=(0, 0),
        end=(1, 0),
        gap_type=GapType.MISSING,
    )
    events = [ev("infrastructure", 0, 1000, "quiet_road")]
    minor = evaluate(profile, events, [day(1, 0, 1000, Signage.NOT_SIGNED)], [gap], 1000)
    assert minor.sections[0].criteria["continuity"] == "fail"
    assert minor.sections[0].criteria["signage"] == "fail"


def test_runs_bridge_short_interruptions():
    events = [ev("t", 0, 400, "4"), ev("t", 400, 500, "2"), ev("t", 500, 900, "4"), ev("t", 2000, 2100, "4")]
    found = runs(events, {"4"}, merge_gap_m=200)
    assert [(a, b) for a, b, _ in found] == [(0, 900), (2000, 2100)]


def test_gap_classification():
    def ride(i, a, end, section):
        return Component(
            id=f"c{i}",
            seq=i,
            kind=ComponentKind.RIDE,
            from_m=a,
            to_m=a,
            length_m=0,
            start=end,
            end=end,
            daily_section=section,
        )

    def gap(i, a, b):
        return Component(
            id=f"c{i}",
            seq=i,
            kind=ComponentKind.GAP,
            from_m=0,
            to_m=0,
            length_m=0,
            start=a,
            end=b,
            straight_distance_m=10_000,
        )

    comps = [
        ride(0, 0, (0, 45), 1),
        gap(1, (0.0, 45.0), (0.1, 45.0)),
        ride(2, 0, (0.1, 45), 2),
        gap(3, (1.0, 45.0), (1.2, 45.0)),
        ride(4, 0, (1.2, 45), 3),
        gap(5, (2.0, 45.0), (2.2, 45.0)),
        ride(6, 0, (2.2, 45), 4),
        gap(7, (3.0, 45.0), (3.2, 45.0)),
    ]
    ferries = [{"id": 1, "name": "Port A – Port B", "coords": [(0.0, 45.01), (0.1, 45.01)]}]
    # Rail stations sit at both ends of the third gap, but that is no evidence of a link (D50): it stays missing.
    notes = classify_gaps(comps, ferries, [CuratedGap(after_section=2, type=GapType.FERRY, note="sea")])
    types = [c.gap_type for c in comps if c.kind == ComponentKind.GAP]
    assert types == [GapType.FERRY, GapType.FERRY, GapType.MISSING, GapType.MISSING]
    assert [c.gap_basis for c in comps if c.kind == ComponentKind.GAP][:2] == ["osm_ferry_route", "curated"]
    assert notes[0]["ferry"] == "Port A – Port B"


def test_ferry_must_connect_both_ends_not_just_pass_by():
    def comp(i, kind, start, end, section=None):
        return Component(
            id=f"c{i}",
            seq=i,
            kind=kind,
            from_m=0,
            to_m=0,
            length_m=0,
            start=start,
            end=end,
            daily_section=section,
            straight_distance_m=4000 if kind == ComponentKind.GAP else None,
        )

    comps = [
        comp(0, ComponentKind.RIDE, (0, 45), (0, 45), 1),
        comp(1, ComponentKind.GAP, (0.0, 45.0), (0.05, 45.0)),
        comp(2, ComponentKind.RIDE, (0.05, 45), (0.05, 45), 2),
    ]
    coastal = [{"id": 9, "name": "Coastal line", "coords": [(-0.5, 45.01), (0.6, 45.01)]}]  # passes both ends
    classify_gaps(comps, coastal, [])
    assert comps[1].gap_type != GapType.FERRY


def test_ev8_route_config_has_the_sea_crossings():
    cfg = load_route_config("eurovelo", "EV8")
    assert {(g.after_section, g.type) for g in cfg.gaps} == {(137, GapType.FERRY), (145, GapType.FERRY)}
