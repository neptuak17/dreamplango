"""`dpg` command line."""

import json
from pathlib import Path

import numpy as np
import typer

from dpg_audit.build import assemble
from dpg_audit.bundle import write_bundle
from dpg_audit.config import REPO_ROOT, data_dir
from dpg_audit.contracts import bundle_schema
from dpg_audit.ingest.gpx import read_tracks
from dpg_audit.lrs import MeasuredLine
from dpg_audit.lrs.geodesy import distance
from dpg_audit.networks import eurovelo

app = typer.Typer(help="DreamPlanGo Route Audit Engine", no_args_is_help=True)


def _check_network(network: str) -> None:
    if network != eurovelo.NETWORK:
        raise typer.BadParameter(f"unsupported network {network!r} (supported: {eurovelo.NETWORK})")


@app.command()
def fetch(network: str, ref: str) -> None:
    """Download the official route GPX, e.g. `dpg fetch eurovelo EV8`."""
    _check_network(network)
    snap = eurovelo.fetch(ref, data_dir())
    typer.echo(f"saved {snap.file} ({snap.bytes:,} bytes, sha256 {snap.sha256[:12]}…)")


@app.command()
def ingest(
    network: str,
    ref: str,
    snapshot: str = typer.Option(None, help="Snapshot date (YYYY-MM-DD); default: latest"),
) -> None:
    """Build an Audit Bundle (v0) from the latest downloaded snapshot, e.g. `dpg ingest eurovelo EV8`."""
    _check_network(network)
    root = data_dir()
    snap = eurovelo.latest_snapshot(ref, root, snapshot)
    tracks = eurovelo.load_tracks(root / snap.file)
    build = assemble(eurovelo.route_for(ref), tracks)
    run_id, out = write_bundle(build, [snap], root)
    s = build.summary()
    typer.echo(
        f"{build.route.name}: {s.daily_section_count} daily sections, {s.ride_length_m / 1000:,.0f} km, "
        f"{s.gap_count} gaps, {len(build.findings)} findings"
    )
    for share in s.status_breakdown:
        typer.echo(
            f"  {share.development.value:22s} {share.signage.value:11s} "
            f"{share.length_m / 1000:7.0f} km  {share.share:6.1%}"
        )
    typer.echo(f"bundle {run_id} -> {out}")


@app.command()
def inspect(gpx: Path) -> None:
    """Summarise any GPX file: tracks, points, lengths, joins."""
    tracks = read_tracks(gpx)
    prev_end = None
    total = 0.0
    for t in tracks:
        if t.point_count < 2:
            typer.echo(f"{t.index:4d}  (fewer than 2 points) {t.name}")
            continue
        line = MeasuredLine(t.lon, t.lat, t.ele)
        total += line.length
        join = ""
        if prev_end is not None:
            join = f" join {distance(*prev_end, t.lon[0], t.lat[0]) / 1000:7.2f} km"
        prev_end = (t.lon[-1], t.lat[-1])
        typer.echo(
            f"{t.index:4d} pts {t.point_count:6d} len {line.length / 1000:7.1f} km "
            f"max seg {float(np.max(line.seg_len)):7.0f} m{join}  {t.name}"
        )
    typer.echo(f"{len(tracks)} tracks, {total / 1000:,.1f} km")


@app.command()
def schemas(out: Path = typer.Option(REPO_ROOT / "schemas", help="Output directory")) -> None:
    """Export the bundle JSON Schema (the API/web contract)."""
    out.mkdir(parents=True, exist_ok=True)
    schema = bundle_schema()
    target = out / "bundle-v0.schema.json"
    target.write_text(json.dumps(schema, indent=2) + "\n", encoding="utf-8")
    typer.echo(f"wrote {target}")
