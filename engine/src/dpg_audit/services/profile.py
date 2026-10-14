"""Load the services profile (engine/profiles/services-*.yaml): service types and their access limits (D17)."""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from dpg_audit.models import ServiceType
from dpg_audit.rules.profile import PROFILES_DIR

SERVICE_ORDER = (
    "water",
    "food",
    "toilets",
    "accommodation",
    "bike_shop",
    "repair_station",
    "station",
    "pharmacy",
    "atm",
    "hospital",
)


@dataclass
class ServiceCfg:
    id: str
    title: str
    count_m: float
    count_min: float | None
    show_m: float
    costing: str = "bicycle"
    gap_m: float | None = None
    gap_also: list[str] = field(default_factory=list)
    gap_severity: str = "info"
    extra: dict[str, Any] = field(default_factory=dict)

    def info(self) -> ServiceType:
        return ServiceType(
            id=self.id,
            title=self.title,
            count_m=self.count_m,
            count_min=self.count_min,
            show_m=self.show_m,
            costing=self.costing,  # type: ignore[arg-type]
            gap_m=self.gap_m,
            gap_also=self.gap_also,
        )


@dataclass
class ServicesProfile:
    id: str
    title: str
    season_year: int
    flat_speed_kmh: float
    climb_min_per_10m: float
    on_route_m: float
    skip_routing_m: float
    route_sample_m: float
    max_sources: int
    overture_min_confidence: float
    types: dict[str, ServiceCfg]

    def minutes(self, access_m: float, climb_m: float | None) -> float:
        flat = access_m / 1000 / self.flat_speed_kmh * 60
        return flat + (climb_m or 0.0) / 10 * self.climb_min_per_10m


_KNOWN = {"title", "count_m", "count_min", "show_m", "costing", "gap_m", "gap_also", "gap_severity"}


def load_services(name: str = "services-v0", folder: Path = PROFILES_DIR) -> ServicesProfile:
    raw = yaml.safe_load((folder / f"{name}.yaml").read_text(encoding="utf-8"))
    types = {}
    for sid, t in raw["types"].items():
        if sid not in SERVICE_ORDER:
            raise ValueError(f"unknown service type {sid!r} in {name}")
        types[sid] = ServiceCfg(
            id=sid,
            title=t["title"],
            count_m=float(t["count_m"]),
            count_min=None if t.get("count_min") is None else float(t["count_min"]),
            show_m=float(t["show_m"]),
            costing=t.get("costing", "bicycle"),
            gap_m=None if t.get("gap_m") is None else float(t["gap_m"]),
            gap_also=list(t.get("gap_also", [])),
            gap_severity=t.get("gap_severity", "info"),
            extra={k: v for k, v in t.items() if k not in _KNOWN},
        )
    ordered = {sid: types[sid] for sid in SERVICE_ORDER if sid in types}
    return ServicesProfile(
        id=raw["id"],
        title=raw["title"],
        season_year=int(raw["season_year"]),
        flat_speed_kmh=float(raw["flat_speed_kmh"]),
        climb_min_per_10m=float(raw["climb_min_per_10m"]),
        on_route_m=float(raw["on_route_m"]),
        skip_routing_m=float(raw["skip_routing_m"]),
        route_sample_m=float(raw["route_sample_m"]),
        max_sources=int(raw["max_sources"]),
        overture_min_confidence=float(raw["overture_min_confidence"]),
        types=ordered,
    )
