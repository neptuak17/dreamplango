"""Evaluate a rules profile per 1 km minor section, and summarise layers and criteria per stretch."""

from bisect import bisect_right
from collections import defaultdict

from dpg_audit.layers import elevation
from dpg_audit.lrs.sections import fixed_sections
from dpg_audit.models import (
    Component,
    ComponentKind,
    CriterionResult,
    CriterionShare,
    DailySection,
    Event,
    GapType,
    MinorFile,
    MinorSection,
    SectionScores,
    Signage,
    StretchStats,
)
from dpg_audit.rules.profile import RulesProfile

NOT_KNOWN = {"unknown", "unmatched", "na"}


class LayerIndex:
    """Fast 'how much of each value lies between m0 and m1' queries over non-overlapping events of one layer."""

    def __init__(self, events: list[Event]):
        self.events = sorted(events, key=lambda e: e.from_m)
        self.starts = [e.from_m for e in self.events]

    def lengths(self, m0: float, m1: float) -> dict[str, float]:
        out: dict[str, float] = defaultdict(float)
        i = max(bisect_right(self.starts, m0) - 1, 0)
        while i < len(self.events) and self.events[i].from_m < m1:
            e = self.events[i]
            overlap = min(e.to_m, m1) - max(e.from_m, m0)
            if overlap > 0:
                out[e.value] += overlap
            i += 1
        return out


def _share(lengths: dict[str, float], values: set[str] | None = None, known_only: bool = True) -> tuple[float, float]:
    """(share of `values` among known length, known share of total)."""
    total = sum(lengths.values())
    known = sum(v for k, v in lengths.items() if not (known_only and k in NOT_KNOWN))
    if total <= 0:
        return 0.0, 0.0
    hit = sum(v for k, v in lengths.items() if values is None or k in values)
    return (hit / known if known > 0 else 0.0), known / total


def evaluate(
    profile: RulesProfile,
    events: list[Event],
    daily: list[DailySection],
    components: list[Component],
    length_m: float,
) -> MinorFile:
    layers = {layer: LayerIndex([e for e in events if e.layer == layer]) for layer in {e.layer for e in events}}
    missing_gaps = [c.from_m for c in components if c.kind == ComponentKind.GAP and c.gap_type == GapType.MISSING]
    day_starts = [d.from_m for d in daily]
    crit = profile.criteria
    sections: list[MinorSection] = []
    for index, (m0, m1) in enumerate(fixed_sections(length_m, profile.minor_section_m)):
        lens = {layer: idx.lengths(m0, m1) for layer, idx in layers.items()}
        values = {layer: max(v, key=v.get) for layer, v in lens.items() if v}
        results: dict[str, CriterionResult] = {}

        infra = lens.get("infrastructure", {})
        unmatched_share = infra.get("unmatched", 0.0) / max(m1 - m0, 1e-9)
        gap_here = any(m0 <= g < m1 or (g == m1 == length_m) for g in missing_gaps)
        results["continuity"] = (
            "fail" if gap_here or unmatched_share > crit["continuity"]["max_unmatched_share"] else "pass"
        )

        lts = lens.get("traffic_stress", {})
        _, known = _share(lts)
        if known < 0.5:
            results["traffic_safety"] = results["low_traffic"] = "unknown"
        else:
            results["traffic_safety"] = "fail" if lts.get("4", 0.0) > crit["traffic_safety"]["max_lts4_m"] else "pass"
            low, _ = _share(lts, {"1", "2"})
            results["low_traffic"] = "pass" if low >= crit["low_traffic"]["min_share"] else "fail"

        surf = lens.get("surface", {})
        good, known = _share(surf, set(crit["surface"]["good"]))
        results["surface"] = "unknown" if known < 0.5 else ("pass" if good >= crit["surface"]["min_share"] else "fail")

        grad = lens.get("gradient", {})
        if sum(v for k, v in grad.items() if k != "unknown") < 0.5 * (m1 - m0):
            results["gradient"] = "unknown"
        else:
            steep = any(grad.get(c, 0) > 0 for c in crit["gradient"]["fail_classes"])
            results["gradient"] = "fail" if steep else "pass"

        day = daily[max(bisect_right(day_starts, (m0 + m1) / 2) - 1, 0)]
        sig = day.status.signage
        results["signage"] = "pass" if sig == Signage.SIGNED else ("fail" if sig == Signage.NOT_SIGNED else "unknown")

        sections.append(
            MinorSection(index=index, from_m=round(m0, 1), to_m=round(m1, 1), values=values, criteria=results)
        )
    return MinorFile(size_m=profile.minor_section_m, criteria=profile.criterion_info(), sections=sections)


def stretch_stats(
    m0: float,
    m1: float,
    events: list[Event],
    minor: MinorFile,
    profile: RulesProfile,
    profs: list[elevation.PartProfile] | None,
) -> StretchStats:
    total = max(m1 - m0, 1e-9)
    shares: dict[str, dict[str, float]] = {}
    for layer in sorted({e.layer for e in events}):
        lens = LayerIndex([e for e in events if e.layer == layer]).lengths(m0, m1)
        shares[layer] = {k: round(v / total, 4) for k, v in sorted(lens.items(), key=lambda kv: -kv[1])}
    tiers = {cid: c["tier"] for cid, c in profile.criteria.items()}
    sums: dict[str, dict[str, float]] = {cid: {"pass": 0.0, "fail": 0.0, "unknown": 0.0} for cid in tiers}
    essential = important = 0.0
    for s in minor.sections:
        overlap = min(s.to_m, m1) - max(s.from_m, m0)
        if overlap <= 0:
            continue
        for cid, res in s.criteria.items():
            sums[cid][res] += overlap
        if all(s.criteria[c] == "pass" for c, t in tiers.items() if t == "essential"):
            essential += overlap
        if all(s.criteria[c] == "pass" for c, t in tiers.items() if t == "important"):
            important += overlap
    criteria = {
        cid: CriterionShare(
            passed=round(v["pass"] / total, 4),
            failed=round(v["fail"] / total, 4),
            unknown=round(v["unknown"] / total, 4),
        )
        for cid, v in sums.items()
    }
    ascent = descent = max_grade = None
    if profs:
        up, down = elevation.ascent_descent(profs, m0, m1)
        ascent, descent = round(up), round(down)
        max_grade = elevation.max_grade_window(profs, m0, m1)
    return StretchStats(
        from_m=round(m0, 1),
        to_m=round(m1, 1),
        ascent_m=ascent,
        descent_m=descent,
        max_grade_500m=max_grade,
        shares=shares,
        criteria=criteria,
        essential_pass=round(essential / total, 4),
        important_pass=round(important / total, 4),
    )


def section_scores(daily, events, minor, profile, profs) -> list[SectionScores]:
    return [
        SectionScores(number=d.number, **stretch_stats(d.from_m, d.to_m, events, minor, profile, profs).model_dump())
        for d in daily
    ]
