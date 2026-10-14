"""Conflate places from several sources into one record each (D16, DESIGN.md 11.2).

Two records are the same place when they have the same service type and either lie within `near_m` (150 m for
accommodation) with similar names, or within `blind_m` when either has no name. Duplicates inside one source
(e.g. a station mapped both as a node and as an area) are merged the same way.
"""

import re
import unicodedata
from dataclasses import dataclass, field

import numpy as np
from rapidfuzz import fuzz
from scipy.spatial import cKDTree

from dpg_audit.lrs.index import to_laea
from dpg_audit.services.osm_places import RawPlace

NEAR_M = 75.0
NEAR_LARGE_M = 150.0
BLIND_M = 25.0
NAME_SIMILARITY = 70
LARGE = {"accommodation", "station", "hospital"}


@dataclass
class Merged:
    primary: RawPlace
    """The record that supplies position, name and tags (OSM when present)."""
    members: list[RawPlace] = field(default_factory=list)

    @property
    def sources(self) -> list[str]:
        return [f"{r.source}:{r.id}" for r in self.members]

    def has(self, source: str) -> bool:
        return any(r.source == source for r in self.members)


def norm_name(name: str | None) -> str:
    if not name:
        return ""
    text = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9 ]+", " ", text).strip()


def same_place(a: RawPlace, b: RawPlace, dist_m: float, na: str | None = None, nb: str | None = None) -> bool:
    if a.service != b.service:
        return False
    na = norm_name(a.name) if na is None else na
    nb = norm_name(b.name) if nb is None else nb
    if not na or not nb:
        return dist_m <= BLIND_M
    limit = NEAR_LARGE_M if a.service in LARGE else NEAR_M
    return dist_m <= limit and fuzz.token_set_ratio(na, nb) >= NAME_SIMILARITY


def _conflate_service(ordered: list[RawPlace], radius: float) -> list[Merged]:
    x, y = to_laea([p.lon for p in ordered], [p.lat for p in ordered])
    names = [norm_name(p.name) for p in ordered]
    tree = cKDTree(np.stack([x, y], 1))
    owner = list(range(len(ordered)))  # index of the primary each record was merged into

    def root(i: int) -> int:
        while owner[i] != i:
            i = owner[i]
        return i

    pairs = tree.query_pairs(radius, output_type="ndarray")
    if len(pairs):
        pairs = pairs[np.lexsort((pairs[:, 1], pairs[:, 0]))]
    for i, j in pairs:
        dist = float(np.hypot(x[i] - x[j], y[i] - y[j]))
        if not same_place(ordered[i], ordered[j], dist, names[i], names[j]):
            continue
        ri, rj = root(int(i)), root(int(j))
        if ri != rj:
            # The earlier record (OSM before Overture) stays the primary.
            owner[max(ri, rj)] = min(ri, rj)

    groups: dict[int, Merged] = {}
    for i, rec in enumerate(ordered):
        r = root(i)
        groups.setdefault(r, Merged(primary=ordered[r])).members.append(rec)
    return list(groups.values())


def conflate(places: list[RawPlace]) -> list[Merged]:
    """Per service type: OSM records first, so they become the primaries; Overture records join them or stand
    alone."""
    by_service: dict[str, list[RawPlace]] = {}
    for p in places:
        by_service.setdefault(p.service, []).append(p)
    out: list[Merged] = []
    for service, group in sorted(by_service.items()):
        ordered = sorted(group, key=lambda p: (p.source != "osm", p.id))
        out.extend(_conflate_service(ordered, NEAR_LARGE_M if service in LARGE else NEAR_M))
    return out


def confidence(m: Merged) -> str:
    if m.has("osm") and m.has("overture"):
        return "high"
    if m.has("osm"):
        return "medium"
    best = max((r.confidence or 0.0) for r in m.members)
    return "medium" if best >= 0.9 else "low"
