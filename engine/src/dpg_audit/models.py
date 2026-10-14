"""Pydantic models: the data contract shared with the API and web app (exported as JSON Schema).

All distances are metres. Measures (`from_m`, `to_m`) are positions along a route path, counted only over
ridden components; gap components (ferries, train links, missing track) have zero measured length.
"""

from datetime import datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

BUNDLE_SCHEMA_VERSION = "0.1"

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
    """Elevation sampled along the path. Values come from the source GPX and are unverified."""

    step_m: float
    source: str
    m: list[float]
    ele: list[float | None]


class CurrentPointer(Model):
    run_id: str
    updated_at: datetime


class BundleContract(Model):
    """Root type used only to export one JSON Schema containing every bundle file type."""

    manifest: BundleManifest
    sections: SectionsFile
    findings: FindingsFile
    profile: ProfileFile
    current: CurrentPointer
