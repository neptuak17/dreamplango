"""Pydantic models: the data contract shared with the API and web app (exported as JSON Schema).

All distances are metres. Measures (`from_m`, `to_m`) are positions along a route path, counted only over
ridden components; gap components (ferries, train links, missing track) have zero measured length.
"""

from datetime import datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

BUNDLE_SCHEMA_VERSION = "0.3"

LonLat = tuple[float, float]


class Model(BaseModel):
    # Every field is always written, so the exported (serialization) schema marks them all required.
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)


class Licence(Model):
    id: str = Field(description="SPDX-style identifier, e.g. ODbL-1.0")
    name: str
    url: str


class SourceSnapshot(Model):
    """One downloaded source file, with the provenance needed for attribution and reproducibility."""

    id: str = Field(description="Source identifier, e.g. eurovelo-gpx")
    title: str
    url: str
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
    ascent_m: float | None
    descent_m: float | None
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
    current: CurrentPointer
