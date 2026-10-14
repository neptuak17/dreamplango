"""Findings derived from audit layers: the 'local buddy' notes a rider or curator should know about."""

from dpg_audit.lrs import RoutePath
from dpg_audit.match.matcher import LineMatch
from dpg_audit.models import Climb, Component, DailySection, Event, Finding, GapType, SectionScores, Severity
from dpg_audit.rules.profile import RulesProfile


def _km(m: float) -> str:
    return f"{m / 1000:.1f} km"


def runs(events: list[Event], values: set[str], merge_gap_m: float) -> list[tuple[float, float, list[Event]]]:
    """Stretches where `values` dominate, bridging interruptions shorter than `merge_gap_m`."""
    out: list[tuple[float, float, list[Event]]] = []
    for e in sorted((e for e in events if e.value in values), key=lambda e: e.from_m):
        if out and e.from_m - out[-1][1] <= merge_gap_m:
            start, _, evs = out[-1]
            out[-1] = (start, e.to_m, [*evs, e])
        else:
            out.append((e.from_m, e.to_m, [e]))
    return out


def _covered(evs: list[Event]) -> float:
    return sum(e.to_m - e.from_m for e in evs)


def _ways(evs: list[Event]) -> list[int]:
    seen: list[int] = []
    for e in evs:
        for w in e.detail.get("ways", []):
            if w not in seen:
                seen.append(w)
    return seen[:8]


def _names(evs: list[Event]) -> str:
    """' on N-340, A-7' from the road refs/names recorded on events (empty if none)."""
    seen: list[str] = []
    for e in sorted(evs, key=lambda e: e.from_m - e.to_m):  # longest first
        for n in e.detail.get("names", []):
            if n not in seen:
                seen.append(n)
    return f" on {', '.join(seen[:3])}" if seen else ""


def rule_findings(
    profile: RulesProfile,
    path: RoutePath,
    events: list[Event],
    climbs: list[Climb],
    daily: list[DailySection],
    scores: list[SectionScores],
    matches: list[LineMatch],
) -> list[dict]:
    cfg = profile.findings
    gap = cfg["merge_gap_m"]
    by_layer = {layer: [e for e in events if e.layer == layer] for layer in {e.layer for e in events}}
    out: list[dict] = []

    def add(**kw):
        kw.setdefault("evidence", {})
        kw["position"] = path.locate((kw["from_m"] + kw["to_m"]) / 2)
        out.append(kw)

    for m0, m1, evs in runs(by_layer.get("traffic_stress", []), {"4"}, cfg.get("busy_road_merge_m", gap)):
        if _covered(evs) >= cfg["busy_road_min_m"]:
            add(
                rule_id="audit.busy_road",
                category="route",
                severity=Severity.WARNING,
                from_m=m0,
                to_m=m1,
                title=f"{_km(_covered(evs))} on busy roads (LTS 4){_names(evs)}",
                detail="Fast or heavy motor traffic without cycle facilities, estimated from road class and speed "
                "limit (often a default). Consider an alternative or public transport.",
                evidence={"ways": _ways(evs)},
                confidence="medium",
            )

    for m0, m1, evs in runs(by_layer.get("surface", []), {"gravel", "dirt"}, gap):
        if _covered(evs) >= cfg["unpaved_min_m"]:
            add(
                rule_id="audit.unpaved",
                category="route",
                severity=Severity.CAUTION,
                from_m=m0,
                to_m=m1,
                title=f"{_km(_covered(evs))} unpaved (loose gravel, dirt or sand)",
                detail="Fine on wider tyres; slow and tiring with a loaded touring bike or in wet weather.",
                evidence={"ways": _ways(evs)},
                confidence="medium",
            )

    for m0, m1, evs in runs(by_layer.get("infrastructure", []), {"steps"}, 0):
        add(
            rule_id="audit.steps",
            category="route",
            severity=Severity.CAUTION,
            from_m=m0,
            to_m=m1,
            title="Steps on the route",
            detail="You will need to carry or push the bike here.",
            evidence={"ways": _ways(evs)},
            confidence="medium",
        )

    for m0, m1, evs in runs(by_layer.get("infrastructure", []), {"unmatched"}, gap):
        if _covered(evs) >= cfg["unmatched_min_m"]:
            add(
                rule_id="audit.unmatched",
                category="data_quality",
                severity=Severity.WARNING,
                from_m=m0,
                to_m=m1,
                title=f"{_km(_covered(evs))} could not be matched to the map",
                detail="The published track does not follow any way in OpenStreetMap here (or only one closed to "
                "bicycles). The track may be wrong, or the path may be missing from OSM.",
                confidence="high",
            )

    # Steep stretches: one finding per daily section that has enough of them, rather than one per ramp.
    steep_by_day: dict[int, list[Event]] = {}
    for m0, _m1, evs in runs(by_layer.get("gradient", []), {"very_steep", "extreme"}, 100):
        day = next((d for d in daily if d.from_m <= m0 < d.to_m), daily[-1])
        steep_by_day.setdefault(day.number, []).extend(evs)
    for number, evs in steep_by_day.items():
        if _covered(evs) < cfg["steep_min_m"]:
            continue
        up = sum(e.to_m - e.from_m for e in evs if e.detail.get("max_grade", 0) > 0)
        down = _covered(evs) - up
        worst = max((e.detail.get("max_grade", 0) for e in evs), key=abs)
        add(
            rule_id="audit.steep",
            category="route",
            severity=Severity.CAUTION,
            from_m=min(e.from_m for e in evs),
            to_m=max(e.to_m for e in evs),
            title=f"Section {number}: {_km(_covered(evs))} steeper than 8% (up to {abs(worst):.0f}%)",
            detail=f"{_km(up)} climbing and {_km(down)} descending in the direction of travel, over "
            f"{len(evs)} stretch(es). Gradients come from a 30 m terrain model and are smoothed; short ramps can "
            "be steeper.",
            evidence={"max_grade": worst, "stretches": len(evs)},
            confidence="medium",
        )

    for c in climbs:
        if c.fiets >= cfg["climb_min_fiets"]:
            way = "" if c.direction == "forward" else " (when riding the route in reverse)"
            add(
                rule_id="audit.climb",
                category="route",
                severity=Severity.INFO,
                from_m=c.from_m,
                to_m=c.to_m,
                title=f"Climb{way}: {_km(c.length_m)} at {c.avg_grade:.1f}% (+{c.gain_m:.0f} m)",
                detail=f"Steepest 500 m averages {c.max_grade_500m:.1f}%; top at {c.top_m:.0f} m. "
                f"FIETS difficulty index {c.fiets:.1f}.",
                evidence=c.model_dump(),
                confidence="medium",
            )

    for d, s, match in zip(daily, scores, matches, strict=True):
        ev_share = s.shares.get("cycle_network", {}).get("eurovelo_route", 0.0)
        if ev_share < cfg["osm_route_min_share"]:
            add(
                rule_id="audit.osm_route_coverage",
                category="data_quality",
                severity=Severity.INFO,
                from_m=d.from_m,
                to_m=d.to_m,
                title=f"OSM's EuroVelo route covers {ev_share:.0%} of section {d.number}",
                detail="Most of the official track here is not part of the EuroVelo route relation in "
                "OpenStreetMap, so apps that use OSM may show a different line.",
                evidence={"share": ev_share},
                confidence="medium",
            )
        if match.matched_length_m > 0 and d.length_m > 0:
            ratio = match.matched_length_m / d.length_m
            if abs(ratio - 1) > cfg["length_mismatch"]:
                add(
                    rule_id="audit.length_mismatch",
                    category="data_quality",
                    severity=Severity.INFO,
                    from_m=d.from_m,
                    to_m=d.to_m,
                    title=f"Ridden distance differs from the published track by {ratio - 1:+.0%} (section {d.number})",
                    detail=f"Matched to the map, the section measures {_km(match.matched_length_m)} against "
                    f"{_km(d.length_m)} for the published track, which is simplified or cuts corners.",
                    evidence={"matched_m": round(match.matched_length_m), "published_m": round(d.length_m)},
                    confidence="medium",
                )
    return out


GAP_TEXT = {
    GapType.FERRY: ("route", Severity.INFO, "Ferry crossing", "Check timetables and seasonal operation."),
    GapType.PUBLIC_TRANSPORT: (
        "route",
        Severity.CAUTION,
        "Probable public-transport link",
        "Rail stations lie near both ends of the gap, so EuroVelo's advice to use public "
        "transport probably applies. Check bike carriage rules.",
    ),
    GapType.MISSING: (
        "route",
        Severity.WARNING,
        "Missing link",
        "No track, ferry or rail link was found across this gap. Plan your own way across.",
    ),
    GapType.DISCONTINUITY: (
        "data_quality",
        Severity.INFO,
        "Small break in the published track",
        "The section ends do not quite meet; usually harmless digitising noise.",
    ),
}


def gap_findings(components: list[Component], notes: list[dict]) -> list[dict]:
    by_id = {c.id: c for c in components}
    out = []
    for note in notes:
        comp = by_id[note["component"]]
        category, severity, label, advice = GAP_TEXT.get(comp.gap_type, GAP_TEXT[GapType.MISSING])
        dist = comp.straight_distance_m or 0.0
        what = f"{_km(dist)}" if dist >= 1000 else f"{dist:.0f} m"
        extra = []
        if note.get("ferry"):
            extra.append(f"Ferry route in OSM: {note['ferry']}.")
        if note.get("stations"):
            extra.append("Nearest stations: " + " / ".join(s or "unnamed" for s in note["stations"]) + ".")
        if note.get("curated_note"):
            extra.append(note["curated_note"])
        out.append(
            {
                "rule_id": f"gap.{comp.gap_type.value}",
                "category": category,
                "severity": severity,
                "from_m": comp.from_m,
                "to_m": comp.from_m,
                "position": comp.start,
                "title": f"{label}: {what} between sections {note['from_section']} and {note['to_section']}",
                "detail": " ".join([advice, *extra]),
                "evidence": {"straight_distance_m": comp.straight_distance_m, "basis": comp.gap_basis},
                "confidence": comp.gap_confidence or "medium",
            }
        )
    return out


def to_findings(raw: list[dict]) -> list[Finding]:
    raw = sorted(raw, key=lambda f: (f["from_m"], f["to_m"]))
    out = []
    for i, f in enumerate(raw):
        f = dict(f)
        f.pop("id", None)  # findings are renumbered in measure order
        f["from_m"], f["to_m"] = round(f["from_m"], 1), round(f["to_m"], 1)
        out.append(Finding(id=f"f{i + 1:04d}", **f))
    return out
