"""Dream data (M3, DESIGN.md 11.4): per daily section and month, from the audit's layers, places and new sources."""

from bisect import bisect_right
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from dpg_audit.build import RouteBuild
from dpg_audit.dream import climate as era5
from dpg_audit.dream import scores, themes
from dpg_audit.dream.crowding import CountryCrowding, CrowdingSource
from dpg_audit.dream.daylight import monthly_day_length
from dpg_audit.dream.profile import DreamProfile, grade
from dpg_audit.layers import elevation
from dpg_audit.lrs.geodesy import local_scale
from dpg_audit.models import (
    CampsiteSeasons,
    ClimateMonths,
    ComponentKind,
    Crowding,
    DreamFile,
    DreamSection,
    Event,
    Finding,
    GapType,
    Place,
    RouteBreak,
    SectionScores,
    ServicesFile,
    SourceSnapshot,
)
from dpg_audit.services.coverage import Coverage
from dpg_audit.services.policy import CountryLookup
from dpg_audit.sources import osm

GRAVEL = {"gravel", "dirt", "compacted"}
PATHS = {"cycleway", "shared_path", "separated_track"}
NOT_KNOWN = {"unmatched", "unknown"}
ACCOMMODATION_KIND = {"campsite": "campsite", "hostel": "hostel", "hut": "hostel"}
GAP_SERVICES = ("water", "food", "accommodation", "bike_shop")


@dataclass
class DreamResult:
    file: DreamFile
    sources: list[SourceSnapshot]


class _Layer:
    def __init__(self, events: list[Event]):
        self.events = sorted(events, key=lambda e: e.from_m)
        self.starts = [e.from_m for e in self.events]

    def value_at(self, m: float) -> str | None:
        i = bisect_right(self.starts, m) - 1
        if i >= 0 and self.events[i].from_m <= m < self.events[i].to_m:
            return self.events[i].value
        return None

    def edges(self, m0: float, m1: float) -> list[float]:
        i = max(bisect_right(self.starts, m0) - 1, 0)
        out = []
        while i < len(self.events) and self.events[i].from_m < m1:
            out.extend((self.events[i].from_m, self.events[i].to_m))
            i += 1
        return out


def surface_shares(infra: _Layer, surface: _Layer, m0: float, m1: float) -> dict[str, float]:
    """Each piece of the section is exactly one of road, cycle path or gravel (D36), or unknown."""
    cuts = sorted({m0, m1, *(c for c in infra.edges(m0, m1) + surface.edges(m0, m1) if m0 < c < m1)})
    lengths: Counter[str] = Counter()
    for a, b in zip(cuts, cuts[1:], strict=False):
        mid = (a + b) / 2
        inf, sur = infra.value_at(mid), surface.value_at(mid)
        if inf == "ferry":
            continue
        if sur in GRAVEL:
            kind = "gravel"
        elif inf in PATHS:
            kind = "cycle_path"
        elif inf is None or inf in NOT_KNOWN:
            kind = "unknown"
        else:
            kind = "road"
        lengths[kind] += b - a
    total = sum(lengths.values()) or 1.0
    return {k: round(lengths.get(k, 0.0) / total, 3) for k in ("road", "cycle_path", "gravel", "unknown")}


def mean_heading(line) -> tuple[float, float]:
    """Length-weighted mean unit direction of travel (east, north); shorter than 1 on winding sections."""
    pts = line.resample(250.0)
    kx, ky = local_scale(float(np.mean(pts.lat)))
    dx = np.diff(pts.lon) * kx
    dy = np.diff(pts.lat) * ky
    lengths = np.hypot(dx, dy)
    total = float(lengths.sum())
    if total <= 0:
        return 0.0, 0.0
    return float(dx.sum() / total), float(dy.sum() / total)


def _month_codes(places: list[Place]) -> tuple[int, list[int], list[int]]:
    published = [p for p in places if p.months != "?" * 12]
    open_ = [sum(p.months[m] == "o" for p in published) for m in range(12)]
    partly = [sum(p.months[m] == "p" for p in published) for m in range(12)]
    return len(published), open_, partly


def build_dream(
    root: Path,
    wd: Path,
    build: RouteBuild,
    profs: list[elevation.PartProfile],
    events: list[Event],
    section_scores: list[SectionScores],
    places: list[Place],
    coverage: Coverage,
    services: ServicesFile,
    findings: list[Finding],
    profile: DreamProfile,
    *,
    untrusted: list[tuple[float, float]] | None = None,
    log: Callable[[str], None] = print,
) -> DreamResult:
    """`untrusted`: path ranges where the official track is a straight-line placeholder (M1 findings)."""
    untrusted = untrusted or []
    path, daily = build.path, build.daily
    year = profile.season_year

    # Climate (ERA5, D34)
    points = era5.climate_points(path, float(profile.climate["point_spacing_m"]))
    series, files = era5.fetch_all(
        points, profile.years, root / "raw" / "era5" / "timeseries", int(profile.climate["workers"]), log
    )
    missing_points = sum(s is None for s in series)
    log(f"ERA5: {len(points) - missing_points} of {len(points)} climate points available")

    # Scenery and remoteness (OSM)
    log("scenery themes and remoteness from the OSM corridor …")
    corridor_pbf = wd / "osm" / "corridor.osm.pbf"
    theme_pbf = themes.prepare(corridor_pbf, build.lines, wd / "dream")
    feats = themes.read_features(theme_pbf)
    settlements = themes.read_places(corridor_pbf, wd / "dream")
    scenery = themes.scenery(path, daily, feats, settlements, profs, profile.themes, profile.remoteness)

    # Countries and crowding (OpenHolidays, Eurostat)
    mids = [path.locate((d.from_m + d.to_m) / 2) for d in daily]
    countries = CountryLookup(osm.geofabrik_index(root)).lookup(
        np.array([p[0] for p in mids]), np.array([p[1] for p in mids])
    )
    log("holidays and tourism by month …")
    crowd_src = CrowdingSource(root / "raw" / "crowding", year)
    covered = crowd_src.covered()
    crowding: dict[str | None, CountryCrowding] = {cc: crowd_src.country(cc, covered) for cc in set(countries)}
    crowd_src.close()

    infra = _Layer([e for e in events if e.layer == "infrastructure"])
    surface = _Layer([e for e in events if e.layer == "surface"])
    by_number = {s.number: s for s in section_scores}
    svc_by_number = {s.number: s for s in services.sections}
    accommodation = sorted(
        (p for p in places if p.service == "accommodation" and p.counts), key=lambda p: p.access_at_m
    )
    acc_pos = [p.access_at_m for p in accommodation]
    bail = [p for p in coverage.bail_out_stations() if p.kind == "rail"]  # "train at both ends": not ferries
    near_end = float(profile.stations["near_end_m"])

    def station_near(m: float) -> str | None:
        best = min(
            (p for p in bail if abs(p.access_at_m - m) <= near_end), key=lambda p: abs(p.access_at_m - m), default=None
        )
        return None if best is None else (best.name or "unnamed station")

    sections: list[DreamSection] = []
    for i, d in enumerate(daily):
        sc = by_number[d.number]
        cc = countries[i]
        lon, lat = mids[i]
        cr = crowding[cc]
        checks: list[str] = []

        clim = None
        k, dist = era5.nearest_point(points, lon, lat)
        if series[k] is not None:
            mon = era5.monthly(series[k], mean_heading(build.lines[i]), profile.climate)
            clim = ClimateMonths(point=series[k].grid, distance_m=round(dist), **mon)
        else:
            checks.append("No climate data for this section (the ERA5 request failed): check typical weather yourself.")

        lo, hi = bisect_right(acc_pos, d.from_m - 1e-6), bisect_right(acc_pos, d.to_m)
        here = accommodation[lo:hi]
        camps = [p for p in here if p.kind == "campsite"]
        c_pub, c_open, c_partly = _month_codes(camps)
        a_pub, a_open, a_partly = _month_codes(here)
        kinds = Counter(ACCOMMODATION_KIND.get(p.kind, "hotel") for p in here)
        if here and a_pub < len(here):
            checks.append(
                f"{len(here) - a_pub} of {len(here)} places to stay publish no opening season: check dates ahead."
            )

        country = cc or "this country"
        if cr.school_year is None:
            checks.append(f"School holidays in {country}: no data. Check local school calendars before booking.")
        else:
            if cr.school_year < year:
                checks.append(
                    f"School holidays shown from the {cr.school_year} calendar; {year} dates are not published yet."
                )
            checks.append(
                "Summer school breaks are not in the holiday data, so June to September show no school-holiday "
                "data: check local school calendars."
            )
        if cr.public_year is None:
            checks.append(f"Public holidays in {country}: no data.")
        elif cr.public_year < year:
            checks.append(
                f"Public holidays shown from the {cr.public_year} calendar; {year} dates are not published yet."
            )
        if all(v is None for v in cr.tourism_index):
            checks.append(f"Tourism by month in {country}: no data, so how busy it gets is your call.")
        placeholder = sum(min(b, d.to_m) - max(a, d.from_m) for a, b in untrusted if a < d.to_m and b > d.from_m)
        # M1 leaves out terrain under long placeholders (D37): its climbing is then a minimum, kept apart here so it is
        # never read as the whole. Nothing is recomputed, so Dream and the audit always agree.
        rough = sc.climb_unknown_m > 0
        up, down, known_up, known_down = sc.ascent_m, sc.descent_m, None, None
        unknown_m = sc.climb_unknown_m
        if rough:
            up, down, known_up, known_down = None, None, sc.ascent_m, sc.descent_m
        if placeholder > 0:
            if not rough:
                effect = "its distance and climbing are approximate."
            elif known_up is not None:
                effect = (
                    "its distance is approximate, and its climbing is measured on the rest only, so it is a minimum."
                )
            else:
                effect = "its distance is approximate and its climbing unknown."
            checks.append(
                f"{placeholder / 1000:.1f} km of this section is a straight-line placeholder in the official track: "
                + effect
            )
        steep = sc.max_grade_500m  # measured on real terrain only (M1)

        daylight = monthly_day_length(lat, year)
        peak = max((v for v in cr.tourism_index if v is not None), default=None)
        comfort, best, partial, dirs = [], [], [], []
        for mo in range(12):
            c = None
            if clim is not None:
                c = scores.comfort(
                    clim.tmax_c[mo],
                    clim.rain_days[mo],
                    daylight[mo],
                    clim.windy_days[mo],
                    clim.heat_days[mo],
                    profile.comfort,
                )
            services_open = (a_open[mo] + 0.5 * a_partly[mo]) / a_pub if a_pub else None
            t_idx = cr.tourism_index[mo]
            tourism_rel = t_idx / peak if t_idx is not None and peak else None
            b, missing = scores.best_time(c, services_open, tourism_rel, cr.school_days[mo], profile.best_time)
            comfort.append(c)
            best.append(b)
            partial.append(missing)
            dirs.append(scores.direction(None if clim is None else clim.wind_along_ms[mo], up, down, profile.direction))

        svc = svc_by_number.get(d.number)
        fcount = Counter(f.severity.value for f in findings if f.from_m < d.to_m and f.to_m > d.from_m)
        km = d.length_m / 1000
        sections.append(
            DreamSection(
                number=d.number,
                from_m=d.from_m,
                to_m=d.to_m,
                length_m=d.length_m,
                country=cc,
                ascent_fwd_m=up,
                ascent_rev_m=down,
                ascent_known_fwd_m=known_up,
                ascent_known_rev_m=known_down,
                climb_unknown_m=round(unknown_m, 1),
                max_grade_500m=steep,
                grade_fwd=grade(profile.levels, km, up if up is not None else known_up),
                grade_rev=grade(profile.levels, km, down if down is not None else known_down),
                surfaces=surface_shares(infra, surface, d.from_m, d.to_m),
                busy_share=round(sc.shares.get("traffic_stress", {}).get("4", 0.0), 3),
                themes=scenery[i].themes,
                remote_share=scenery[i].remote_share,
                longest_remote_m=scenery[i].longest_remote_m,
                climate=clim,
                daylight_h=daylight,
                crowding=Crowding(
                    country=cc,
                    school_days=cr.school_days,
                    school_year=cr.school_year,
                    public_holidays=cr.public_holidays,
                    public_year=cr.public_year,
                    tourism_index=cr.tourism_index,
                    tourism_years=cr.tourism_years,
                ),
                campsites=CampsiteSeasons(counted=len(camps), published=c_pub, open=c_open, partly=c_partly),
                accommodation={k: kinds.get(k, 0) for k in ("campsite", "hostel", "hotel")},
                services=dict(svc.counts) if svc else {},
                longest_gap_m={s: float(max(svc.longest_gap_m.get(s, [0]))) for s in GAP_SERVICES} if svc else {},
                station_start=station_near(d.from_m),
                station_end=station_near(d.to_m),
                findings=dict(fcount),
                comfort=comfort,
                best_time=best,
                partial=partial,
                direction=dirs,
                check=checks,
            )
        )

    breaks = []
    rides = [c for c in build.components if c.kind == ComponentKind.RIDE]
    for c in build.components:
        if c.kind != ComponentKind.GAP:
            continue
        before = next((r for r in reversed(rides) if r.to_m <= c.from_m + 1e-6), None)
        dist = c.straight_distance_m or 0.0
        hard = c.gap_type == GapType.MISSING or (
            c.gap_type != GapType.DISCONTINUITY and dist > float(profile.breaks["hard_crossing_m"])
        )
        breaks.append(
            RouteBreak(
                after_section=before.daily_section if before and before.daily_section else 0,
                type=c.gap_type.value if c.gap_type else "unclassified",
                straight_distance_m=round(dist),
                hard=hard,
            )
        )

    spacing_km = profile.climate["point_spacing_m"] / 1000
    source = f"ERA5 hourly time series {profile.years[0]}–{profile.years[1]}, one point per ~{spacing_km:.0f} km"
    file = DreamFile(
        profile=profile.id,
        season_year=year,
        climate_source=source,
        levels=profile.levels,
        themes=themes.THEMES,
        sections=sections,
        breaks=breaks,
    )
    sources = ([era5.snapshot(files, root, profile.years, len(points))] if files else []) + crowd_src.snapshots(root)
    return DreamResult(file=file, sources=sources)
