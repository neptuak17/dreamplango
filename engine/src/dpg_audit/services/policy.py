"""Countries of places (Geofabrik country polygons) and the curated bike-carriage policy for stations (D20)."""

import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import shapely
import yaml
from shapely.geometry import shape

from dpg_audit.rules.profile import PROFILES_DIR

CARRIED = {"yes", "reservation", "limited"}
"""Policies under which a station counts as carrying bikes."""


class CountryLookup:
    """Point-in-polygon against Geofabrik country extract boundaries (those carrying an ISO code)."""

    def __init__(self, index: dict):
        geoms, codes = [], []
        for f in index["features"]:
            iso = f["properties"].get("iso3166-1:alpha2")
            if iso and f.get("geometry"):
                geoms.append(shape(f["geometry"]))
                codes.append(iso[0] if isinstance(iso, list) else iso)
        self.geoms = np.array(geoms, dtype=object)
        self.codes = codes
        self.tree = shapely.STRtree(self.geoms)

    def lookup(self, lon: np.ndarray, lat: np.ndarray) -> list[str | None]:
        pts = shapely.points(np.asarray(lon, dtype=float), np.asarray(lat, dtype=float))
        point_idx, geom_idx = self.tree.query(pts, predicate="within")
        out: list[str | None] = [None] * len(pts)
        for p, g in zip(point_idx, geom_idx, strict=True):
            # Geofabrik extracts overlap a little at borders; keep the first (smallest id order is arbitrary).
            if out[p] is None:
                out[p] = self.codes[g]
        missing = [i for i, c in enumerate(out) if c is None]
        if missing:
            near_idx = self.tree.query_nearest(pts[missing], all_matches=False)[1]
            for i, g in zip(missing, near_idx, strict=True):
                out[i] = self.codes[g]
        return out


@dataclass
class PolicyRow:
    bikes: str
    note: str
    source: str | None
    confidence: str
    country: str | None = None
    operator: re.Pattern | None = None
    kind: str | None = None


class BikePolicy:
    def __init__(self, rows: list[PolicyRow], checked: str):
        self.rows = rows
        self.checked = checked

    @classmethod
    def load(cls, path: Path = PROFILES_DIR / "transport" / "bike-carriage.yaml") -> "BikePolicy":
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))

        def bikes(v) -> str:  # YAML reads bare yes/no as booleans
            return "yes" if v is True else "no" if v is False else str(v).lower()

        rows = [
            PolicyRow(
                bikes=bikes(r["bikes"]),
                note=" ".join(str(r.get("note", "")).split()),
                source=r.get("source"),
                confidence=r.get("confidence", "low"),
                country=r.get("country"),
                operator=re.compile(r["operator"], re.IGNORECASE) if r.get("operator") else None,
                kind=r.get("kind"),
            )
            for r in raw["rows"]
        ]
        return cls(rows, str(raw.get("checked", "")))

    def lookup(self, kind: str, country: str | None, tags: dict[str, str]) -> PolicyRow | None:
        text = " ".join(tags.get(k, "") for k in ("operator", "network", "name"))
        for row in self.rows:
            if row.kind is not None:
                if row.kind == kind:
                    return row
                continue
            if kind != "rail" or row.country != country:
                continue
            if row.operator is None or row.operator.search(text):
                return row
        return None
