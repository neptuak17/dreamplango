"""`dpg` command line."""

import json
from pathlib import Path

import numpy as np
import typer

from dpg_audit.build import assemble
from dpg_audit.bundle import write_bundle
from dpg_audit.config import REPO_ROOT, data_dir, work_dir
from dpg_audit.contracts import bundle_schema
from dpg_audit.corridor import corridor, write_geojson
from dpg_audit.ingest.gpx import read_tracks
from dpg_audit.lrs import MeasuredLine
from dpg_audit.lrs.geodesy import distance
from dpg_audit.networks import eurovelo
from dpg_audit.sources import osm

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


def _load_build(network: str, ref: str, snapshot: str | None):
    _check_network(network)
    root = data_dir()
    snap = eurovelo.latest_snapshot(ref, root, snapshot)
    return root, snap, assemble(eurovelo.route_for(ref), eurovelo.load_tracks(root / snap.file))


@app.command("osm-prepare")
def osm_prepare(
    network: str,
    ref: str,
    buffer_km: float = typer.Option(15.0, help="Corridor half-width around the route"),
    snapshot: str = typer.Option(None, help="Route snapshot date; default: latest"),
    dry_run: bool = typer.Option(False, help="Only build the corridor and list the extracts needed"),
) -> None:
    """Build the route corridor, download the OSM country extracts it touches, and cut them to the corridor."""
    root, _, build = _load_build(network, ref, snapshot)
    wd = work_dir(root, network, ref)
    area = corridor(build.lines, buffer_km * 1000)
    corridor_path = wd / "corridor.geojson"
    write_geojson(area, corridor_path, {"route": build.route.id, "buffer_km": buffer_km})
    regions = osm.country_extracts(osm.geofabrik_index(root), corridor(build.lines, 3000))
    typer.echo(f"corridor: {len(area.geoms)} polygon(s), {buffer_km:g} km either side -> {corridor_path}")
    typer.echo("extracts: " + ", ".join(r["id"] for r in regions))
    if dry_run:
        return
    pbfs, snaps = [], []
    for region in regions:
        pbf, snap = osm.ensure_extract(region, root)
        pbfs.append(pbf)
        snaps.append(snap)
    out = osm.extract_corridor(pbfs, corridor_path, wd / "osm" / "corridor.osm.pbf")
    (wd / "osm" / "sources.json").write_text(
        json.dumps([s.model_dump(mode="json") for s in snaps], indent=2), encoding="utf-8"
    )
    typer.echo(f"corridor extract: {out} ({out.stat().st_size / 1e6:,.0f} MB)")


@app.command("dem-prepare")
def dem_prepare(
    network: str,
    ref: str,
    snapshot: str = typer.Option(None, help="Route snapshot date; default: latest"),
) -> None:
    """Download the Copernicus DEM tiles the route crosses (the audit also does this on demand)."""
    from dpg_audit.sources import dem

    root, _, build = _load_build(network, ref, snapshot)
    lines = [p.line.resample(250.0) for p in build.path.parts]
    keys = dem.needed_tiles(np.concatenate([ln.lon for ln in lines]), np.concatenate([ln.lat for ln in lines]))
    typer.echo(f"{len(keys)} DEM tiles needed; downloading missing ones …")
    tiles = dem.ensure_tiles(keys, root)
    present = [p for p in tiles.values() if p is not None]
    size = sum(p.stat().st_size for p in present) / 1e9
    typer.echo(f"{len(present)} tiles on disk ({size:.1f} GB), {len(tiles) - len(present)} absent (open sea)")


@app.command()
def audit(
    network: str,
    ref: str,
    snapshot: str = typer.Option(None, help="Route snapshot date; default: latest"),
    valhalla: str = typer.Option("http://127.0.0.1:8002", help="Valhalla service URL (scripts/valhalla up)"),
    workers: int = typer.Option(6, help="Parallel map-matching requests"),
    rules: str = typer.Option("eurovelo-ecs-v0", help="Rules profile in engine/profiles/"),
    services: str = typer.Option("services-v0", help="Services profile in engine/profiles/"),
    overture_release: str = typer.Option(None, help="Overture release, e.g. 2026-09-23.1; default: latest"),
    dream: str = typer.Option("dream-v0", help="Dream profile in engine/profiles/"),
) -> None:
    """Full audit: map matching, layers, gaps, terrain, services and access, ECS-style rules -> new bundle."""
    _check_network(network)
    from dpg_audit import audit as audit_mod  # heavy imports (osmium, rasterio) only when auditing

    result = audit_mod.run(
        data_dir(),
        network,
        ref,
        snapshot=snapshot,
        valhalla_url=valhalla,
        workers=workers,
        rules_name=rules,
        services_name=services,
        overture_release=overture_release,
        dream_name=dream,
    )
    typer.echo("timings: " + ", ".join(f"{k} {v:.0f}s" for k, v in result.timings.items()))
    typer.echo(f"bundle {result.run_id} -> {result.out}")


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
