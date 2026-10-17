"""Pydantic models: the data contract shared with the API and web app (exported as JSON Schema).

All distances are metres. Measures (`from_m`, `to_m`) are positions along a route path, counted only over
ridden components; gap components (ferries, train links, missing track) have zero measured length.
"""

from datetime import datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

BUNDLE_SCHEMA_VERSION = "0.6"

LonLat = tuple[float, float]


class Model(BaseModel):
    # Every field is always written, so the exported (serialization) schema marks them all required.
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)


class Licence(Model):
    id: str = Field(description="SPDX-style identifier, e.g. ODbL-1.0; 'unknown' for a rider's own file (D25)")
    name: str
    url: str | None = None


class SourceSnapshot(Model):
    """One downloaded source file, with the provenance needed for attribution and reproducibility."""

    id: str = Field(description="Source identifier, e.g. eurovelo-gpx")
    title: str
    url: str | None = Field(None, description="Where it was downloaded; none for a rider's own file")
    retrieved_at: datetime
    file: str = Field(description="Path relative to the data directory")
    sha256: str
    bytes: int
    licence: Licence
    attribution: str


class DevelopmentLevel(StrEnum):
    CERTIFIED = "certified"
    DEVELOPED = "developed"
    PARTIALLY_DEVELOPED = "partially_developed"
    UNDEVELOPED_UNKNOWN = "undeveloped_unknown"
    UNRECOGNISED = "unrecognised"
    NOT_RATED = "not_rated"
    """Not a network route (e.g. a rider's own file, D40): no published development status."""


class Signage(StrEnum):
    SIGNED = "signed"
    NOT_SIGNED = "not_signed"
    UNKNOWN = "unknown"


class EuroVeloStatus(Model):
    development: DevelopmentLevel
    signage: Signage
    label: str = Field(description="Status label exactly as published, e.g. 'Developed + Signed'")


class Route(Model):
    id: str = Field(description="Global route id, e.g. eurovelo:ev8")
    network: str
    ref: str = Field(description="Display reference, e.g. EV8")
    name: str
    official_url: str | None = None


class ComponentKind(StrEnum):
    RIDE = "ride"
    GAP = "gap"


class GapType(StrEnum):
    FERRY = "ferry"
    PUBLIC_TRANSPORT = "public_transport"
    DISCONTINUITY = "discontinuity"
    """A small break in the published track, usually digitising noise."""
    MISSING = "missing"
    """No track and no known way across: the route is incomplete here."""
    UNCLASSIFIED = "unclassified"


class Component(Model):
    """A continuous piece of a path. Gaps join two ride components and have zero measured length."""

    id: str
    seq: int
    kind: ComponentKind
    from_m: float
    to_m: float
    length_m: float
    straight_distance_m: float | None = Field(
        default=None, description="For gaps: straight-line distance between the two ride ends"
    )
    daily_section: int | None = Field(default=None, description="Source daily section number (rides)")
    start: LonLat
    end: LonLat
    gap_type: GapType | None = Field(default=None, description="For gaps: how the break is crossed")
    gap_basis: str | None = Field(default=None, description="For gaps: what the classification rests on")
    gap_confidence: Literal["high", "medium", "low"] | None = None


class DailySection(Model):
    id: str
    number: int
    title: str
    start_name: str | None
    end_name: str | None
    from_m: float
    to_m: float
    length_m: float
    status: EuroVeloStatus
    reversed_in_source: bool = Field(description="Track was stored end-to-start in the source GPX")
    point_count: int
    start: LonLat
    end: LonLat


class StatusSection(Model):
    """A run of consecutive daily sections sharing the same published status."""

    id: str
    from_m: float
    to_m: float
    length_m: float
    status: EuroVeloStatus
    daily_sections: list[int]


class Severity(StrEnum):
    INFO = "info"
    CAUTION = "caution"
    WARNING = "warning"
    BLOCKER = "blocker"


class Finding(Model):
    id: str
    rule_id: str
    category: Literal["data_quality", "route"]
    severity: Severity
    from_m: float
    to_m: float
    position: LonLat | None = Field(default=None, description="Representative location for map display")
    title: str
    detail: str
    evidence: dict[str, Any] = Field(default_factory=dict)
    confidence: Literal["high", "medium", "low"]


class StatusShare(Model):
    development: DevelopmentLevel
    signage: Signage
    length_m: float
    share: float = Field(description="Fraction of ridden length, 0-1")


class RouteSummary(Model):
    ride_length_m: float
    daily_section_count: int
    gap_count: int
    gap_straight_distance_m: float
    status_breakdown: list[StatusShare]


class PipelineInfo(Model):
    name: str
    version: str


class RouteOverlap(Model):
    route_id: str
    name: str
    network: str
    ref: str
    shared_m: float = Field(description="Length of this route on OSM ways the other route also follows")
    share: float = Field(description="shared_m as a share of this route's length (0-1)")
    sections: list[tuple[int, int]] = Field(description="The other route's daily sections involved, as ranges")


class BundleManifest(Model):
    schema_version: str = BUNDLE_SCHEMA_VERSION
    run_id: str
    created_at: datetime
    pipeline: PipelineInfo
    route: Route
    sources: list[SourceSnapshot]
    attribution: list[str]
    files: dict[str, str] = Field(description="Logical name -> file name within the bundle directory")
    summary: RouteSummary
    finding_counts: dict[str, int] = Field(description="Count per severity")
    visibility: Literal["public", "private"] = Field(
        "public", description="Private: a rider's own route; never listed, never shared (D25)"
    )
    overlap: list[RouteOverlap] = Field(
        default_factory=list, description="Length shared with audited public routes (D40), where there is any"
    )


class WaysFile(Model):
    """The OSM ways a route is matched to, for overlap between routes (D23, D40)."""

    ways: list[tuple[int, int, float]] = Field(description="[way id, daily section number, matched length (m)]")


class UserPlace(Model):
    """A waypoint from the rider's own file (D24): private to that route, shown but never counted (D40)."""

    id: str
    name: str | None
    kind: str = Field(description="From the file's <type> or <sym>; 'waypoint' when it has neither")
    note: str | None = Field(description="The file's comment and description, if any")
    lon: float
    lat: float
    ele: float | None
    at_m: float = Field(description="Measure of the closest route point")
    offset_m: float = Field(description="Straight-line distance from the route")
    section: int | None = Field(description="Daily section at at_m")


class UserPlacesFile(Model):
    places: list[UserPlace]


class SectionsFile(Model):
    daily: list[DailySection]
    status: list[StatusSection]
    components: list[Component]
    blocks: list[tuple[float, float]] = Field(description="Fixed 50 km live-data blocks as [from_m, to_m]")
    minor: list[tuple[float, float]] = Field(description="Fixed 1 km ECS minor sections as [from_m, to_m]")


class FindingsFile(Model):
    findings: list[Finding]


class ProfileFile(Model):
    """Elevation sampled along the path every `step_m`.

    `ele` is the audit's best estimate (smoothed DEM, bridges and tunnels interpolated) when a DEM was used,
    otherwise the source GPX elevation. `gpx_ele` always holds the source GPX elevation for comparison.
    """

    step_m: float
    source: str
    m: list[float]
    ele: list[float | None]
    gpx_ele: list[float | None] = Field(default_factory=list)


Confidence = Literal["high", "medium", "low"]


class LayerValue(Model):
    id: str
    label: str


class LayerInfo(Model):
    """A family of events along the route (e.g. surface), with its allowed categorical values."""

    id: str
    title: str
    description: str
    source: str
    values: list[LayerValue]


class Event(Model):
    """One layer value over a stretch of the route (measures in metres on the path axis)."""

    layer: str
    from_m: float
    to_m: float
    value: str
    confidence: Confidence
    detail: dict[str, Any] = Field(default_factory=dict)


class EventsFile(Model):
    layers: list[LayerInfo]
    events: list[Event]


CriterionResult = Literal["pass", "fail", "unknown"]


class Criterion(Model):
    id: str
    title: str
    tier: Literal["essential", "important"]
    description: str


class MinorSection(Model):
    """One ECS minor section (1 km): dominant layer values and indicative criterion results."""

    index: int
    from_m: float
    to_m: float
    values: dict[str, str] = Field(description="Layer id -> value covering most of this kilometre")
    criteria: dict[str, CriterionResult]


class MinorFile(Model):
    size_m: float
    criteria: list[Criterion]
    sections: list[MinorSection]


class CriterionShare(Model):
    passed: float
    failed: float
    unknown: float


class StretchStats(Model):
    """Summary statistics over a stretch of route: the whole route, or one daily section."""

    from_m: float
    to_m: float
    ascent_m: float | None = Field(
        description="Climbing; a minimum when climb_unknown_m > 0 (unknown terrain is left out, D37)"
    )
    descent_m: float | None
    climb_unknown_m: float = Field(
        description="Length whose terrain is unknown (long straight-line placeholders); 0 when climbing is complete"
    )
    max_grade_500m: float | None = Field(description="Steepest 500 m average gradient (%) in travel direction")
    shares: dict[str, dict[str, float]] = Field(description="Layer id -> value -> share of length (0-1)")
    criteria: dict[str, CriterionShare]
    essential_pass: float = Field(description="Share of length meeting all essential criteria")
    important_pass: float = Field(description="Share of length meeting all important criteria")


class SectionScores(StretchStats):
    number: int


class Climb(Model):
    from_m: float
    to_m: float
    length_m: float
    gain_m: float
    avg_grade: float
    max_grade_500m: float
    top_m: float = Field(description="Elevation at the top")
    fiets: float = Field(description="FIETS climb difficulty index")
    direction: Literal["forward", "reverse"]


class ScoresFile(Model):
    rules_profile: str
    criteria: list[Criterion]
    route: StretchStats
    sections: list[SectionScores]
    climbs: list[Climb]


class ServiceType(Model):
    """A kind of service along the route, with the access limits that decide whether a place counts (D17)."""

    id: str
    title: str
    count_m: float = Field(description="Ridden one-way distance within which a place counts")
    count_min: float | None = Field(description="Time cap (flat speed plus climbing) for counting; null = none")
    show_m: float = Field(description="Places up to this ridden distance are kept for display")
    costing: Literal["bicycle", "auto"]
    gap_m: float | None = Field(description="A stretch this long without the service gives a finding")
    gap_also: list[str] = Field(description="Other services that also fill this one's gaps (shops sell water)")


class Place(Model):
    """A service near the route (conflated from OSM and Overture), located on the route's measure axis.

    `months` holds one letter per month of the season year (D18): o = open, p = partly (the season starts or ends
    that month), c = closed, ? = unknown.
    """

    id: str
    service: str
    kind: str = Field(description="Subtype, e.g. campsite, hotel, supermarket, cafe")
    name: str | None
    lon: float
    lat: float
    at_m: float = Field(description="Measure of the closest route point")
    offset_m: float = Field(description="Straight-line distance from the route")
    side: Literal["left", "right", "on"]
    access_m: float | None = Field(description="Ridden one-way distance from the route; null if no route found")
    access_min: float | None = Field(description="Minutes at touring pace including climbing (D17)")
    climb_m: float | None = Field(description="Net climb from the access point to the place")
    access_at_m: float = Field(description="Measure where the rider leaves the route for this place")
    counts: bool = Field(description="Within the service type's counting limits")
    on_route: bool
    months: str = Field(description="12 letters, January first: o open, p partly, c closed, ? unknown")
    opening_hours: str | None
    country: str | None = Field(description="ISO 3166-1 alpha-2")
    sources: list[str] = Field(description="Source record ids, e.g. osm:n123, overture:<id>")
    confidence: Confidence
    detail: dict[str, Any] = Field(default_factory=dict)


class PlacesFile(Model):
    season_year: int
    places: list[Place]


class SectionServices(Model):
    number: int
    counts: dict[str, int] = Field(description="Service id -> places that count on this daily section")
    longest_gap_m: dict[str, list[float]] = Field(
        description="Service id -> longest stretch inside the section without the service, per month (Jan-Dec)"
    )
    unknown_hours: dict[str, float] = Field(description="Service id -> share of counted places with unknown months")


class ServiceGap(Model):
    """A stretch without a service, at least half as long as the stretch that triggers a finding."""

    service: str = Field(description="Service id, or bail_out for stations that carry bikes within bail-out reach")
    month: int | None = Field(description="0-11: counting places not known closed that month; null: any month")
    from_m: float
    to_m: float
    threshold_m: float = Field(description="Gap length that triggers a finding for this service")


class ServicesFile(Model):
    rules_profile: str
    season_year: int
    types: list[ServiceType]
    route_longest_gap_m: dict[str, list[float]] = Field(description="Service id -> longest gap per month")
    sections: list[SectionServices]
    gaps: list[ServiceGap]
    season_known: dict[str, float] = Field(
        description="Service id -> share of counted places whose opening season is published (any month known)"
    )


MonthValues = list[float | None]
"""12 values, January first; None where there is no data (D37)."""


class RiderLevel(Model):
    """D36: what a rider is comfortable riding per day, with luggage."""

    level: int
    name: str
    km_min: float
    km_max: float
    climb_max_m: float


class ThemeInfo(Model):
    id: str
    title: str
    measures: str = Field(description="How the theme is measured, in plain words")


class ThemeScore(Model):
    score: float | None = Field(
        description="0-1: the section's raw value against the route's 90th percentile; null when unknown (D37)"
    )
    note: str = Field(description="Plain-language facts behind the score")


class ClimateMonths(Model):
    """Monthly normals at the section's climate point (D34)."""

    point: LonLat = Field(description="ERA5 grid point the values come from")
    distance_m: float = Field(description="From the section midpoint to that point")
    tmax_c: MonthValues
    tmin_c: MonthValues
    rain_days: MonthValues = Field(description="Share of days with at least the rain-day threshold")
    rain_mm: MonthValues = Field(description="Mean rain per day, mm")
    heat_days: MonthValues
    windy_days: MonthValues
    wind_along_ms: MonthValues = Field(description="Mean along-route wind riding forward (+ tailwind, - headwind)")
    headwind_days_fwd: MonthValues
    headwind_days_rev: MonthValues


class Crowding(Model):
    country: str | None
    school_days: MonthValues = Field(
        description="Share of the country's regions on school holiday, per month (June-September: no data, as the "
        "source omits summer breaks)"
    )
    school_year: int | None = Field(description="Calendar year of the school-holiday dates used")
    public_holidays: MonthValues = Field(description="Nationwide public holidays in the month")
    public_year: int | None = Field(description="Calendar year of the public-holiday dates used")
    tourism_index: MonthValues = Field(description="Tourist nights in the month / monthly average (1 = average)")
    tourism_years: str | None


class CampsiteSeasons(Model):
    counted: int = Field(description="Campsites that count on this section (M2)")
    published: int = Field(description="Of those, how many publish an opening season")
    open: list[int] = Field(description="Per month: published campsites open all month")
    partly: list[int] = Field(description="Per month: published campsites open part of the month")


class Direction(Model):
    advice: Literal["forward", "reverse", "either", "unknown"]
    wind_along_ms: float | None
    climb_diff_m: float | None = Field(
        description="Reverse climbing minus forward climbing (positive favours forward); null when unknown"
    )


class DreamSection(Model):
    number: int
    from_m: float
    to_m: float
    length_m: float
    country: str | None
    ascent_fwd_m: float | None = Field(description="Climbing riding forward; null when any of it is unknown")
    ascent_rev_m: float | None
    ascent_known_fwd_m: float | None = Field(
        description="When climbing is partly unknown: climbing on the part with real terrain, so a minimum (D37)"
    )
    ascent_known_rev_m: float | None
    climb_unknown_m: float = Field(description="Length whose climbing is unknown (placeholder track); 0 when complete")
    max_grade_500m: float | None = Field(description="Steepest 500 m, on real terrain only")
    grade_fwd: int | None = Field(
        description="Rider level (D36) needed to ride the section as one day, forward; a minimum when climbing is "
        "partly unknown"
    )
    grade_rev: int | None
    surfaces: dict[str, float] = Field(description="Share of road, cycle_path, gravel and unknown (D36)")
    busy_share: float = Field(description="Share on busy roads (LTS 4)")
    themes: dict[str, ThemeScore]
    remote_share: float = Field(description="Share of km further than the remoteness distance from a village")
    longest_remote_m: float
    climate: ClimateMonths | None
    daylight_h: list[float]
    crowding: Crowding
    campsites: CampsiteSeasons
    accommodation: dict[str, int] = Field(description="Counted places by kind: campsite, hostel, hotel")
    services: dict[str, int] = Field(description="Counted places per service type (M2)")
    longest_gap_m: dict[str, float] = Field(description="Worst-month longest gap inside the section, per service")
    station_start: str | None = Field(description="A bike-carrying station near the section start (name)")
    station_end: str | None
    findings: dict[str, int] = Field(description="Findings overlapping the section, per severity")
    comfort: MonthValues
    best_time: MonthValues
    partial: list[list[str]] = Field(description="Per month: which best-time inputs had no data (D37)")
    direction: list[Direction]
    check: list[str] = Field(description="Data gaps the rider should check themselves (D37)")


class RouteBreak(Model):
    after_section: int
    type: str
    straight_distance_m: float
    hard: bool = Field(description="A stretch may not continue across this break")


class DreamFile(Model):
    profile: str
    season_year: int
    climate_source: str
    levels: list[RiderLevel]
    themes: list[ThemeInfo]
    sections: list[DreamSection]
    breaks: list[RouteBreak]


class StopBeds(Model):
    """The places to stay of one kind at a stop, with their opening by month (D18), grouped by month code."""

    kind: str = Field(description="Place kind: campsite, hotel, guest_house, hostel, hut or other")
    count: int
    seasons: list[tuple[str, int]] = Field(
        description="[12-letter month code, how many of these beds have it]; '?' * 12 when nothing is published"
    )


class Stop(Model):
    """A candidate overnight stop for Plan (11.6): the places to stay that count, grouped by the town they belong to.

    Counts only, never a place name, so the file can be free (D45)."""

    id: str
    name: str | None = Field(description="Town or village; null when the beds are grouped by km only")
    place_kind: str | None = Field(description="OSM place=*: city, town or village; null when grouped by km")
    at_m: float = Field(description="Where the rider leaves the route for the stop: its beds' median access point")
    lon: float = Field(description="The town's position, else the route at at_m")
    lat: float
    country: str | None
    detour_m: float | None = Field(description="The shortest ridden distance from the route to one of its beds")
    beds: list[StopBeds]
    services: dict[str, int] = Field(
        description="Other counted places within reach of the stop along the route: food, water, atm, pharmacy, "
        "bike_shop, toilets"
    )
    station: str | None = Field(description="A bike-carrying station within bail-out reach of the stop")
    station_at_m: float | None


class StopsFile(Model):
    season_year: int
    reach_m: float = Field(description="Services count towards a stop within this distance of it along the route")
    stops: list[Stop]


class EffortPart(Model):
    """Elevation and surface along one ridden part of the path, every `step_m` from `from_m`."""

    from_m: float
    to_m: float
    ele: list[int | None] = Field(
        description="Elevation (m) at from_m + i * step_m, the last at to_m; null where the terrain is unknown "
        "(straight-line placeholders, D37)"
    )
    surface: str = Field(
        description="One letter per step: r road, c cycle path, g gravel, u unknown, f ferry (D36 classes)"
    )


class EffortGap(Model):
    """A gap between ridden parts. An unfilled (missing) gap is counted as ridden in a plan (D50)."""

    at_m: float
    after_section: int | None
    type: str = Field(description="ferry, public_transport, discontinuity, missing or unclassified")
    straight_distance_m: float
    basis: str | None
    confidence: Confidence | None


class EffortFile(Model):
    """What the pace model needs (11.6), compact and free so the teaser can time real days (D45)."""

    step_m: float
    parts: list[EffortPart]
    gaps: list[EffortGap]


class Highlight(Model):
    """Something worth seeing near the route (11.6), from the OSM features behind M3's themes."""

    id: str = Field(description="OSM id, e.g. osm:n123")
    kind: str = Field(
        description="viewpoint, castle, ruins, monument, archaeological_site, fort, palace, city_gate, citywalls, "
        "manor, heritage, museum, attraction, gallery, beach, peak or pass"
    )
    name: str
    lon: float
    lat: float
    at_m: float = Field(description="Measure of the closest route point")
    offset_m: float = Field(description="Straight-line distance from the route")
    ele: float | None = Field(description="Elevation tagged in OSM (peaks and passes)")
    wikidata: str | None
    wikipedia: str | None = Field(description="OSM's wikipedia tag, e.g. 'fr:Pont du Gard'")
    unesco: bool = Field(description="Tagged as a UNESCO World Heritage site (heritage=1)")
    rank: float = Field(description="0-1: how notable, from its kind and tags; used to pick a day's top highlights")


class HighlightsFile(Model):
    highlights: list[Highlight]


class Holiday(Model):
    date: str = Field(description="YYYY-MM-DD")
    name: str
    nationwide: bool
    regions: list[str] = Field(description="ISO 3166-2 codes where it applies, when not nationwide")


class SchoolBreak(Model):
    start: str
    end: str
    name: str
    nationwide: bool
    regions: list[str]


class CountryCalendar(Model):
    """Holiday dates for one country (OpenHolidays). Missing years and countries stay missing (D37)."""

    country: str
    public_year: int | None = Field(description="Calendar year of the public-holiday dates; null: no data")
    public: list[Holiday]
    school_year: int | None = Field(description="Calendar year of the school-holiday dates; null: no data")
    school: list[SchoolBreak] = Field(description="Summer breaks are not in the source (11.4)")


class CalendarFile(Model):
    season_year: int
    countries: list[CountryCalendar]


class CurrentPointer(Model):
    run_id: str
    updated_at: datetime


class BundleContract(Model):
    """Root type used only to export one JSON Schema containing every bundle file type."""

    manifest: BundleManifest
    sections: SectionsFile
    findings: FindingsFile
    profile: ProfileFile
    events: EventsFile
    minor: MinorFile
    scores: ScoresFile
    places: PlacesFile
    services: ServicesFile
    dream: DreamFile
    ways: WaysFile
    user_places: UserPlacesFile
    stops: StopsFile
    effort: EffortFile
    highlights: HighlightsFile
    calendar: CalendarFile
    current: CurrentPointer
