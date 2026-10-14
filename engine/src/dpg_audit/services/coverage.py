"""Coverage of services along the route: gaps per month, ECS services criteria (D21) and findings.

Positions are access points (`access_at_m`): where the rider leaves the route. Gaps are measured along the ridden
path, so a ferry or other gap component adds nothing to them.
"""

from bisect import bisect_left, bisect_right
from collections.abc import Callable, Iterable

from dpg_audit.models import DailySection, MinorFile, Place, SectionServices, ServiceGap, Severity
from dpg_audit.rules.profile import RulesProfile
from dpg_audit.services.policy import CARRIED
from dpg_audit.services.profile import ServicesProfile
from dpg_audit.services.seasons import never_open

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
TOILET_FOOD_KINDS = {"restaurant", "cafe", "bar", "fast_food"}
ALL_UNKNOWN = "?" * 12
Gaps = list[tuple[float, float]]


def _km(m: float) -> str:
    return f"{m / 1000:.0f} km" if m >= 10_000 else f"{m / 1000:.1f} km"


def month_label(months: Iterable[int]) -> str:
    """Compact month ranges, wrapping over the new year: {8, 9, 10} -> 'Sep–Nov', {11, 0, 1} -> 'Dec–Feb'."""
    ms = sorted(set(months))
    if len(ms) == 12:
        return "All year"
    runs: list[list[int]] = []
    for m in ms:
        if runs and m == runs[-1][-1] + 1:
            runs[-1].append(m)
        else:
            runs.append([m])
    if len(runs) > 1 and runs[0][0] == 0 and runs[-1][-1] == 11:
        runs[0] = runs.pop() + runs[0]
    return ", ".join(MONTHS[r[0]] if len(r) == 1 else f"{MONTHS[r[0]]}–{MONTHS[r[-1]]}" for r in runs)


def carried(p: Place) -> bool:
    return p.detail.get("bikes") in CARRIED


def is_open(p: Place, month: int | None) -> bool:
    return not never_open(p.months) if month is None else p.months[month] != "c"


class Coverage:
    def __init__(self, places: list[Place], profile: ServicesProfile, length_m: float):
        self.profile = profile
        self.length = length_m
        self.by_service: dict[str, list[Place]] = {}
        for p in sorted(places, key=lambda p: p.access_at_m):
            self.by_service.setdefault(p.service, []).append(p)

    def own(self, service: str, month: int | None = None) -> list[Place]:
        """Places of exactly this service that count and are not known closed in `month` (None: in any month).
        Stations count only where bikes are carried."""
        return [
            p
            for p in self.by_service.get(service, [])
            if p.counts and is_open(p, month) and (service != "station" or carried(p))
        ]

    def chosen(self, service: str, month: int | None = None) -> list[Place]:
        """Like `own`, plus the services that also fill this one's gaps (e.g. shops for water)."""
        cfg = self.profile.types.get(service)
        out = self.own(service, month)
        for other in cfg.gap_also if cfg else []:
            out += self.own(other, month)
        return out

    def gaps(self, places: list[Place]) -> Gaps:
        pos = sorted({p.access_at_m for p in places})
        edges = [0.0, *pos, self.length]
        return [(a, b) for a, b in zip(edges, edges[1:], strict=False) if b > a]

    @staticmethod
    def longest_in(gaps: Gaps, starts: list[float], m0: float, m1: float) -> float:
        best = 0.0
        for a, b in gaps[max(bisect_right(starts, m0) - 1, 0) :]:
            if a >= m1:
                break
            best = max(best, min(b, m1) - max(a, m0))
        return best

    def section_stats(self, daily: list[DailySection]) -> tuple[list[SectionServices], dict[str, list[float]]]:
        services = list(self.profile.types)
        monthly = {s: [self.gaps(self.chosen(s, month)) for month in range(12)] for s in services}
        starts = {s: [[a for a, _ in g] for g in monthly[s]] for s in services}
        own = {s: self.own(s) for s in services}
        own_pos = {s: [p.access_at_m for p in own[s]] for s in services}
        sections = []
        for d in daily:
            counts, longest, unknown = {}, {}, {}
            for s in services:
                lo, hi = bisect_left(own_pos[s], d.from_m), bisect_right(own_pos[s], d.to_m)
                inside = own[s][lo:hi]
                counts[s] = len(inside)
                longest[s] = [
                    round(self.longest_in(g, st, d.from_m, d.to_m)) for g, st in zip(monthly[s], starts[s], strict=True)
                ]
                unknown[s] = round(sum(p.months == ALL_UNKNOWN for p in inside) / len(inside), 3) if inside else 0.0
            sections.append(
                SectionServices(number=d.number, counts=counts, longest_gap_m=longest, unknown_hours=unknown)
            )
        route = {s: [round(max((b - a for a, b in g), default=0.0)) for g in monthly[s]] for s in services}
        return sections, route

    def bail_out_stations(self) -> list[Place]:
        """Stations that carry bikes within bail-out reach (a longer reach than for counting)."""
        st = self.profile.types.get("station")
        if st is None or "bail_out_m" not in st.extra:
            return []
        reach_m, reach_min = float(st.extra["bail_out_m"]), float(st.extra["bail_out_min"])
        return [p for p in self.by_service.get("station", []) if carried(p) and within(p, reach_m, reach_min)]

    def gap_list(self) -> list[ServiceGap]:
        """Stretches at least half the finding length without a service, per month: for the strip diagram."""
        out = []
        for sid, cfg in self.profile.types.items():
            if cfg.gap_m is None:
                continue
            for month in [None, *range(12)]:
                for a, b in self.gaps(self.chosen(sid, month)):
                    if b - a >= cfg.gap_m / 2:
                        out.append(ServiceGap(service=sid, month=month, from_m=a, to_m=b, threshold_m=cfg.gap_m))
        st = self.profile.types.get("station")
        if st is not None and "bail_out_gap_m" in st.extra:
            limit = float(st.extra["bail_out_gap_m"])
            for a, b in self.gaps(self.bail_out_stations()):
                if b - a >= limit / 2:
                    out.append(ServiceGap(service="bail_out", month=None, from_m=a, to_m=b, threshold_m=limit))
        return out


def within(p: Place, reach_m: float, reach_min: float | None) -> bool:
    minutes = p.access_min if p.access_min is not None else 0.0
    return p.access_m is not None and p.access_m <= reach_m and (reach_min is None or minutes <= reach_min)


class GapIndex:
    def __init__(self, gaps: Gaps):
        self.gaps = gaps
        self.starts = [a for a, _ in gaps]

    def length_at(self, m: float) -> float:
        a, b = self.gaps[max(bisect_right(self.starts, m) - 1, 0)]
        return b - a


def _any_between(positions: list[float], m0: float, m1: float) -> bool:
    return bisect_right(positions, m1) > bisect_left(positions, m0)


def apply_criteria(cov: Coverage, minor: MinorFile, daily: list[DailySection], rules: RulesProfile) -> None:
    """Add the services and public-transport criteria (D21) to every 1 km minor section, in place."""
    crit = rules.criteria

    def pos(places: list[Place]) -> list[float]:
        return sorted(p.access_at_m for p in places)

    lodging = cov.own("accommodation")
    groups = {
        "accommodation": pos(lodging),
        "food_water": pos(cov.own("food")),
        "bike_repair": pos(cov.own("bike_shop") + cov.own("repair_station")),
        "accommodation_choice": pos([p for p in lodging if p.kind != "campsite"]),
        "repair_shop": pos(cov.own("bike_shop")),
    }
    per_day = {
        d.number: {
            cid: "pass" if _any_between(positions, d.from_m, d.to_m) else "fail"
            for cid, positions in groups.items()
            if cid in crit
        }
        for d in daily
    }
    toilets = GapIndex(cov.gaps(cov.own("toilets") + [p for p in cov.own("food") if p.kind in TOILET_FOOD_KINDS]))
    stations_known = GapIndex(cov.gaps(cov.own("station")))
    stations_any = GapIndex(
        cov.gaps(
            [
                p
                for p in cov.by_service.get("station", [])
                if p.counts and p.detail.get("bikes") in (*CARRIED, "unknown")
            ]
        )
    )
    day_starts = [d.from_m for d in daily]
    for s in minor.sections:
        mid = (s.from_m + s.to_m) / 2
        day = daily[max(bisect_right(day_starts, mid) - 1, 0)]
        s.criteria.update(per_day[day.number])
        if "toilets" in crit:
            ok = toilets.length_at(mid) <= crit["toilets"]["max_gap_m"]
            s.criteria["toilets"] = "pass" if ok else "fail"
        for cid in ("pt_access", "pt_access_75"):
            if cid not in crit:
                continue
            limit = crit[cid]["max_gap_m"]
            if stations_known.length_at(mid) <= limit:
                s.criteria[cid] = "pass"
            elif stations_any.length_at(mid) <= limit:
                s.criteria[cid] = "unknown"  # only stations with an unknown bike policy fill the gap
            else:
                s.criteria[cid] = "fail"


def _merge_by_overlap(items: list[tuple[float, float, int]]) -> list[tuple[float, float, set[int]]]:
    out: list[tuple[float, float, set[int]]] = []
    for a, b, month in sorted(items):
        if out and a < out[-1][1]:
            a0, b0, ms = out[-1]
            out[-1] = (a0, max(b0, b), ms | {month})
        else:
            out.append((a, b, {month}))
    return out


def _between(places: list[Place], a: float, b: float) -> list[Place]:
    return [p for p in places if a <= p.access_at_m <= b]


def findings(cov: Coverage, locate: Callable[[float], tuple[float, float]]) -> list[dict]:
    out: list[dict] = []

    def add(**kw):
        kw["position"] = locate((kw["from_m"] + kw["to_m"]) / 2)
        out.append(kw)

    for sid, cfg in cov.profile.types.items():
        if cfg.gap_m is None:
            continue
        what = cfg.title.lower()
        if cfg.gap_also:
            what += " (taps, " + ", ".join(cov.profile.types[s].title.lower() for s in cfg.gap_also) + ")"
        everything = cov.by_service.get(sid, [])
        all_year = [g for g in cov.gaps(cov.chosen(sid)) if g[1] - g[0] > cfg.gap_m]
        for a, b in all_year:
            beyond = [p for p in _between(everything, a, b) if not p.counts]
            extra = f" {len(beyond)} more lie beyond the access limit." if beyond else ""
            add(
                rule_id="services.gap",
                category="route",
                severity=Severity(cfg.gap_severity),
                from_m=a,
                to_m=b,
                title=f"{_km(b - a)} without {what}",
                detail=f"Nothing within {_km(cfg.count_m)} of the route by bike on this stretch.{extra}",
                evidence={"service": sid, "gap_m": round(b - a), "beyond_limit": len(beyond)},
                confidence="medium",
            )
        seasonal = []
        for month in range(12):
            for a, b in cov.gaps(cov.chosen(sid, month)):
                if b - a > cfg.gap_m and not any(a < y and x < b for x, y in all_year):
                    seasonal.append((a, b, month))
        for a, b, months in _merge_by_overlap(seasonal):
            here = [p for p in _between(everything, a - 1, b + 1) if p.counts and not never_open(p.months)]
            closing = [p for p in here if any(p.months[m] == "c" for m in months)]
            unknown = sum(p.months == ALL_UNKNOWN for p in here)
            names = ", ".join(sorted({p.name for p in closing if p.name})[:3])
            add(
                rule_id="services.seasonal_gap",
                category="route",
                severity=Severity(cfg.gap_severity),
                from_m=a,
                to_m=b,
                title=f"{month_label(months)}: {_km(b - a)} without open {cfg.title.lower()}",
                detail=f"{len(closing)} place(s) here are known to close in these months"
                + (f" ({names})" if names else "")
                + f". {unknown} of {len(here)} place(s) around this stretch publish no season, so check ahead.",
                evidence={"service": sid, "months": sorted(months), "closing": len(closing), "unknown": unknown},
                confidence="medium" if unknown <= len(here) / 2 else "low",
            )

    st = cov.profile.types.get("station")
    if st is not None and "bail_out_gap_m" in st.extra:
        reach_m, reach_min = float(st.extra["bail_out_m"]), float(st.extra["bail_out_min"])
        all_stations = cov.by_service.get("station", [])
        for a, b in cov.gaps(cov.bail_out_stations()):
            if b - a <= st.extra["bail_out_gap_m"]:
                continue
            unknown = [
                p
                for p in _between(all_stations, a, b)
                if p.detail.get("bikes") == "unknown" and within(p, reach_m, reach_min)
            ]
            add(
                rule_id="services.bail_out",
                category="route",
                severity=Severity.CAUTION,
                from_m=a,
                to_m=b,
                title=f"{_km(b - a)} without a bail-out station that carries bikes",
                detail=f"No station within {_km(reach_m)} of the route where bikes are known to be carried, so "
                "abandoning a day here means riding on, or a taxi."
                + (f" {len(unknown)} station(s) here have an unknown bike policy." if unknown else ""),
                evidence={"gap_m": round(b - a), "unknown_policy_stations": len(unknown)},
                confidence="medium" if not unknown else "low",
            )
    return out
