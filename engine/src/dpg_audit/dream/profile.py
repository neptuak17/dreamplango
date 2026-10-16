"""Load the Dream profile (engine/profiles/dream-*.yaml): climate settings, score weights, rider levels (D36)."""

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from dpg_audit.models import RiderLevel
from dpg_audit.rules.profile import PROFILES_DIR


@dataclass
class DreamProfile:
    id: str
    title: str
    season_year: int
    climate: dict[str, Any]
    comfort: dict[str, Any]
    best_time: dict[str, Any]
    direction: dict[str, Any]
    themes: dict[str, dict[str, float]]
    remoteness: dict[str, float]
    stations: dict[str, float]
    levels: list[RiderLevel]
    breaks: dict[str, float]

    @property
    def years(self) -> tuple[int, int]:
        first, last = self.climate["years"]
        return int(first), int(last)


def load_dream(name: str = "dream-v0", folder: Path = PROFILES_DIR) -> DreamProfile:
    raw = yaml.safe_load((folder / f"{name}.yaml").read_text(encoding="utf-8"))
    return DreamProfile(
        id=raw["id"],
        title=raw["title"],
        season_year=int(raw["season_year"]),
        climate=raw["climate"],
        comfort=raw["comfort"],
        best_time=raw["best_time"],
        direction=raw["direction"],
        themes=raw["themes"],
        remoteness=raw["remoteness"],
        stations=raw["stations"],
        levels=[RiderLevel(**lv) for lv in raw["levels"]],
        breaks=raw["breaks"],
    )


def grade(levels: list[RiderLevel], km: float, climb_m: float | None) -> int:
    """The lowest rider level (D36) whose daily range covers this distance and climbing in one day."""
    for lv in levels:
        if km <= lv.km_max and (climb_m is None or climb_m <= lv.climb_max_m):
            return lv.level
    return levels[-1].level
