import pytest

from dpg_audit.layers import classify as c


@pytest.mark.parametrize(
    ("raw", "kmh"),
    [("50", 50), ("30 mph", 48), ("FR:urban", 50), ("IT:rural", 90), ("none", None), (None, None), ("70;50", 70)],
)
def test_parse_maxspeed(raw, kmh):
    assert c.parse_maxspeed(raw) == kmh


@pytest.mark.parametrize(
    ("tags", "edge", "lts"),
    [
        ({"highway": "cycleway"}, {}, "1"),
        ({"highway": "track", "motor_vehicle": "agricultural"}, {}, "1"),
        ({"highway": "secondary", "cycleway:right": "track"}, {}, "1"),
        ({"highway": "residential", "maxspeed": "30"}, {}, "1"),
        ({"highway": "residential"}, {}, "2"),
        ({"highway": "unclassified", "maxspeed": "50"}, {}, "2"),
        ({"highway": "unclassified", "maxspeed": "90"}, {}, "3"),
        ({"highway": "tertiary", "maxspeed": "50", "cycleway": "lane"}, {}, "2"),
        ({"highway": "tertiary", "maxspeed": "50"}, {}, "3"),
        ({"highway": "secondary"}, {}, "4"),
        ({"highway": "secondary", "maxspeed": "50"}, {}, "3"),
        ({"highway": "primary", "maxspeed": "50", "cycleway": "lane"}, {}, "3"),
        ({"highway": "primary", "maxspeed": "50"}, {}, "3"),
        ({"highway": "primary", "maxspeed": "30", "cycleway": "lane"}, {}, "2"),
        ({"highway": "primary", "maxspeed": "70"}, {}, "4"),
        ({"highway": "primary"}, {}, "4"),
        ({"highway": "residential", "lanes": "4", "maxspeed": "50"}, {}, "4"),
        ({"route": "ferry"}, {"use": "ferry"}, "na"),
        ({}, {}, "unknown"),
    ],
)
def test_traffic_stress(tags, edge, lts):
    assert c.traffic_stress(tags, edge)[0] == lts


def test_urban_density_uses_urban_default_speed():
    rural = c.traffic_stress({"highway": "secondary"}, {"density": 2})
    urban = c.traffic_stress({"highway": "secondary"}, {"density": 11})
    assert rural[0] == "4" and urban[0] == "3"
    assert urban[2]["speed_source"] == "urban default"
    tagged = c.traffic_stress({"highway": "secondary", "maxspeed": "90"}, {"density": 11})
    assert tagged[0] == "4"  # a tagged limit always wins


def test_shoulder_eases_fast_rural_roads():
    assert c.traffic_stress({"highway": "secondary"}, {"shoulder": True})[0] == "3"
    assert c.traffic_stress({"highway": "primary", "maxspeed": "90"}, {"shoulder": True})[0] == "4"


def test_default_speed_lowers_confidence():
    assert c.traffic_stress({"highway": "secondary"}, {})[1] == "low"
    assert c.traffic_stress({"highway": "secondary", "maxspeed": "90"}, {})[1] == "medium"


@pytest.mark.parametrize(
    ("tags", "lts", "infra"),
    [
        ({"highway": "cycleway"}, "1", "cycleway"),
        ({"highway": "path", "bicycle": "designated"}, "1", "cycleway"),
        ({"highway": "footway", "bicycle": "yes"}, "1", "shared_path"),
        ({"highway": "steps"}, "1", "steps"),
        ({"highway": "secondary", "cycleway:both": "lane"}, "3", "cycle_lane"),
        ({"highway": "residential"}, "2", "quiet_road"),
        ({"highway": "tertiary"}, "3", "road"),
        ({"highway": "primary"}, "4", "busy_road"),
    ],
)
def test_infrastructure(tags, lts, infra):
    assert c.infrastructure(tags, {}, lts)[0] == infra


@pytest.mark.parametrize(
    ("tags", "value", "conf"),
    [
        ({"highway": "residential", "surface": "asphalt"}, "paved_smooth", "high"),
        ({"highway": "residential", "surface": "asphalt", "smoothness": "bad"}, "paved_rough", "high"),
        ({"highway": "track", "surface": "fine_gravel"}, "compacted", "high"),
        ({"highway": "track", "surface": "gravel"}, "gravel", "high"),
        ({"highway": "path", "surface": "dirt"}, "dirt", "high"),
        ({"highway": "track", "tracktype": "grade3"}, "gravel", "medium"),
        ({"highway": "tertiary"}, "paved_assumed", "low"),
        ({"highway": "track"}, "unknown", "low"),
    ],
)
def test_surface(tags, value, conf):
    assert c.surface(tags, {})[:2] == (value, conf)


def test_cycle_network_levels():
    assert c.cycle_network({("icn", "EV8"), ("ncn", "1")}, 8)[0] == "eurovelo_route"
    assert c.cycle_network({("icn", "EV 8")}, 8)[0] == "eurovelo_route"
    assert c.cycle_network({("icn", "EV15")}, 8)[0] == "international"
    assert c.cycle_network({("ncn", "1"), ("lcn", "x")}, 8)[0] == "national"
    assert c.cycle_network(set(), 8)[0] == "none"


@pytest.mark.parametrize(("ref", "n"), [("EV8", 8), ("EV 8", 8), ("EuroVelo 8", 8), ("ev08", 8), ("D8", None)])
def test_eurovelo_number(ref, n):
    assert c.eurovelo_number(ref) == n


def test_layer_values_are_declared():
    declared = {layer.id: {v.id for v in layer.values} for layer in c.LAYERS}
    assert {"infrastructure", "traffic_stress", "surface", "cycle_network", "gradient"} <= set(declared)
    assert "unmatched" in declared["surface"]
