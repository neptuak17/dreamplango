"""Route sources (D22): where a route comes from, and what that means for its audit."""

from collections.abc import Sequence
from pathlib import Path
from typing import Protocol

from dpg_audit.build import TrackInput
from dpg_audit.ingest.gpx import GpxWaypoint
from dpg_audit.models import Route, SourceSnapshot
from dpg_audit.networks import eurovelo, user


class RouteSource(Protocol):
    network: str
    private: bool
    """Audits are private (D25): stored apart, never listed, never shared."""
    eurovelo: bool
    """EuroVelo-only rules apply: status findings, OSM EuroVelo-relation coverage, EuroVelo's own advice."""

    def snapshot(self, ref: str, root: Path, date: str | None = None) -> SourceSnapshot: ...
    def route(self, ref: str, root: Path) -> Route: ...
    def tracks(self, snap: SourceSnapshot, root: Path, settlements: Sequence = ()) -> list[TrackInput]: ...
    def waypoints(self, snap: SourceSnapshot, root: Path) -> list[GpxWaypoint]: ...


class _EuroVelo:
    network = eurovelo.NETWORK
    private = False
    eurovelo = True

    def snapshot(self, ref, root, date=None):
        return eurovelo.latest_snapshot(ref, root, date)

    def route(self, ref, root):
        return eurovelo.route_for(ref)

    def tracks(self, snap, root, settlements=()):
        return eurovelo.load_tracks(root / snap.file)

    def waypoints(self, snap, root):
        return []


class _User:
    network = user.NETWORK
    private = True
    eurovelo = False

    def snapshot(self, ref, root, date=None):
        return user.latest_snapshot(ref, root, date)

    def route(self, ref, root):
        return user.route_for(ref, root)

    def tracks(self, snap, root, settlements=()):
        return user.load_tracks(root / snap.file, settlements)

    def waypoints(self, snap, root):
        return user.load_waypoints(root / snap.file)


SOURCES: dict[str, RouteSource] = {s.network: s for s in (_EuroVelo(), _User())}


def get(network: str) -> RouteSource:
    try:
        return SOURCES[network]
    except KeyError:
        raise ValueError(f"unsupported network {network!r} (supported: {', '.join(SOURCES)})") from None
