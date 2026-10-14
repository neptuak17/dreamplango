"""EuroVelo network adapter: download official GPX tracks and turn them into route section tracks.

Each EuroVelo route GPX holds one <trk> per daily section, named "NNN: Start – End (Status)", where Status is
"<development> + <signage>" (e.g. "Partially Developed + Not Signed") or "Undeveloped / Unknown".
"""

import hashlib
import json
import re
from datetime import UTC, date, datetime
from pathlib import Path

import httpx

from dpg_audit.build import TrackInput
from dpg_audit.config import user_agent
from dpg_audit.ingest.gpx import GpxTrack, read_tracks
from dpg_audit.lrs import MeasuredLine
from dpg_audit.models import DevelopmentLevel, EuroVeloStatus, Licence, Route, Signage, SourceSnapshot

NETWORK = "eurovelo"
BASE_URL = "https://en.eurovelo.com"
SOURCE_ID = "eurovelo-gpx"
ODBL = Licence(id="ODbL-1.0", name="Open Database License 1.0", url="https://opendatacommons.org/licenses/odbl/1-0/")
ATTRIBUTION = (
    "Contains information from EuroVelo GPX tracks downloaded from www.EuroVelo.com on {date}, "
    "which is made available here under the Open Database License (ODbL)."
)

# EuroVelo's internal route ids used by /route/get-gpx/<id>. Unknown ones are discovered from the route page.
KNOWN_GPX_IDS = {"ev8": 31}
ROUTE_NAMES = {"ev8": "Mediterranean Route"}

_NAME_RE = re.compile(r"^\s*(?P<num>\d+)\s*:\s*(?P<title>.*?)\s*(?:\((?P<status>[^()]*)\))?\s*$")
_GPX_LINK_RE = re.compile(r"/route/get-gpx/(\d+)")


def normalise_ref(ref: str) -> str:
    """'EV8', 'ev 8', '8' -> 'ev8'."""
    digits = re.sub(r"\D", "", ref)
    if not digits:
        raise ValueError(f"not a EuroVelo route reference: {ref!r}")
    return f"ev{int(digits)}"


def route_for(ref: str) -> Route:
    key = normalise_ref(ref)
    number = key[2:]
    title = ROUTE_NAMES.get(key)
    return Route(
        id=f"{NETWORK}:{key}",
        network=NETWORK,
        ref=f"EV{number}",
        name=f"EuroVelo {number}" + (f" – {title}" if title else ""),
        official_url=f"{BASE_URL}/{key}",
    )


def parse_status(label: str) -> EuroVeloStatus:
    raw = " ".join(label.split())
    low = raw.lower()
    if "certified" in low:
        dev = DevelopmentLevel.CERTIFIED
    elif "undeveloped" in low or "unknown" in low:
        dev = DevelopmentLevel.UNDEVELOPED_UNKNOWN
    elif "partially developed" in low:
        dev = DevelopmentLevel.PARTIALLY_DEVELOPED
    elif "developed" in low:
        dev = DevelopmentLevel.DEVELOPED
    else:
        dev = DevelopmentLevel.UNRECOGNISED
    if "not signed" in low:
        sig = Signage.NOT_SIGNED
    elif "signed" in low:
        sig = Signage.SIGNED
    else:
        sig = Signage.UNKNOWN
    return EuroVeloStatus(development=dev, signage=sig, label=raw)


def parse_track_name(name: str) -> tuple[int, str, str | None, str | None, str | None]:
    """'001: Cadiz – Conil (Developed + Signed)' -> (1, 'Cadiz – Conil', 'Cadiz', 'Conil', 'Developed + Signed')."""
    match = _NAME_RE.match(name)
    if not match:
        raise ValueError(f"unexpected EuroVelo track name: {name!r}")
    title = " ".join(match["title"].split())
    parts = re.split(r"\s+[–—-]\s+", title, maxsplit=1)
    start, end = (parts[0], parts[1]) if len(parts) == 2 else (None, None)
    return int(match["num"]), title, start, end, match["status"]


def to_track_input(track: GpxTrack) -> TrackInput:
    number, title, start, end, status_in_name = parse_track_name(track.name)
    status = parse_status(track.description or status_in_name or "")
    return TrackInput(
        number=number,
        title=title,
        start_name=start,
        end_name=end,
        status=status,
        line=MeasuredLine(track.lon, track.lat, track.ele),
        source_index=track.index,
    )


def load_tracks(gpx_path: Path) -> list[TrackInput]:
    return [to_track_input(t) for t in read_tracks(gpx_path) if t.point_count >= 2]


# --- download and snapshots -------------------------------------------------------------------------------


def raw_dir(data_dir: Path, ref: str) -> Path:
    return data_dir / "raw" / NETWORK / normalise_ref(ref)


def resolve_gpx_id(ref: str, client: httpx.Client) -> int:
    key = normalise_ref(ref)
    if key in KNOWN_GPX_IDS:
        return KNOWN_GPX_IDS[key]
    page = client.get(f"{BASE_URL}/{key}")
    page.raise_for_status()
    match = _GPX_LINK_RE.search(page.text)
    if not match:
        raise RuntimeError(f"no GPX download link found on {BASE_URL}/{key}")
    return int(match.group(1))


def fetch(ref: str, data_dir: Path, today: date | None = None) -> SourceSnapshot:
    """Download the full-route GPX into raw/eurovelo/<ref>/<date>/ and write its source.json."""
    key = normalise_ref(ref)
    today = today or datetime.now(UTC).date()
    with httpx.Client(headers={"User-Agent": user_agent()}, timeout=120, follow_redirects=True) as client:
        gpx_id = resolve_gpx_id(key, client)
        url = f"{BASE_URL}/route/get-gpx/{gpx_id}"
        resp = client.get(url)
        resp.raise_for_status()
    out_dir = raw_dir(data_dir, key) / today.isoformat()
    out_dir.mkdir(parents=True, exist_ok=True)
    gpx_path = out_dir / f"{key}-full.gpx"
    gpx_path.write_bytes(resp.content)
    snapshot = SourceSnapshot(
        id=SOURCE_ID,
        title=f"EuroVelo GPX tracks – {route_for(key).name} (full route)",
        url=url,
        retrieved_at=datetime.now(UTC),
        file=gpx_path.relative_to(data_dir).as_posix(),
        sha256=hashlib.sha256(resp.content).hexdigest(),
        bytes=len(resp.content),
        licence=ODBL,
        attribution=ATTRIBUTION.format(date=today.isoformat()),
    )
    (out_dir / "source.json").write_text(snapshot.model_dump_json(indent=2), encoding="utf-8")
    return snapshot


def latest_snapshot(ref: str, data_dir: Path, snapshot_date: str | None = None) -> SourceSnapshot:
    base = raw_dir(data_dir, ref)
    candidates = sorted(p for p in base.glob("*/source.json")) if base.exists() else []
    if snapshot_date:
        candidates = [p for p in candidates if p.parent.name == snapshot_date]
    if not candidates:
        raise FileNotFoundError(f"no downloaded snapshot for {ref} under {base}; run `dpg fetch eurovelo {ref}`")
    return SourceSnapshot.model_validate(json.loads(candidates[-1].read_text(encoding="utf-8")))
