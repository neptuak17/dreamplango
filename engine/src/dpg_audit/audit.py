"""The audit: match the route to OSM, derive layers, classify gaps, add terrain (M1), services and access (M2) and
Dream data (M3), apply rules."""

import json
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from dpg_audit import __version__
from dpg_audit.build import assemble
from dpg_audit.bundle import PROFILE_STEP_M, write_bundle
from dpg_audit.config import work_dir
from dpg_audit.dream.pipeline import build_dream
from dpg_audit.dream.profile import load_dream
from dpg_audit.layers import classify, elevation
from dpg_audit.layers.events import build_matched_layers
from dpg_audit.layers.gaps import classify_gaps
from dpg_audit.match.matcher import match_lines
from dpg_audit.match.valhalla import Valhalla
from dpg_audit.models import EventsFile, Licence, ProfileFile, ScoresFile, SourceSnapshot
from dpg_audit.networks import eurovelo
from dpg_audit.osmdata import load as load_osm
from dpg_audit.rules.evaluate import evaluate, section_scores, stretch_stats
from dpg_audit.rules.findings import gap_findings, rule_findings, to_findings
from dpg_audit.rules.profile import load_route_config, load_rules
from dpg_audit.services import coverage
from dpg_audit.services.pipeline import build_places, services_file
from dpg_audit.services.profile import load_services
from dpg_audit.sources import dem

PIPELINE = "dpg-audit/m3-dream"


@dataclass
class AuditResult:
    run_id: str
    out: Path
    timings: dict[str, float]


def _log(msg: str) -> None:
    print(msg, flush=True)


def run(
    root: Path,
    network: str,
    ref: str,
    *,
    snapshot: str | None,
    valhalla_url: str,
    workers: int,
    rules_name: str = "eurovelo-ecs-v0",
    services_name: str = "services-v0",
    overture_release: str | None = None,
    dream_name: str = "dream-v0",
) -> AuditResult:
    t: dict[str, float] = {}
    t0 = time.perf_counter()
    snap = eurovelo.latest_snapshot(ref, root, snapshot)
    build = assemble(eurovelo.route_for(ref), eurovelo.load_tracks(root / snap.file))
    rules = load_rules(rules_name)
    route_cfg = load_route_config(network, ref)
    wd = work_dir(root, network, ref)
    pbf = wd / "osm" / "corridor.osm.pbf"
    if not pbf.exists():
        raise FileNotFoundError(f"{pbf} missing: run `dpg osm-prepare {network} {ref}` first")
    osm_sources = [SourceSnapshot.model_validate(s) for s in json.loads((wd / "osm" / "sources.json").read_text())]

    client = Valhalla(valhalla_url)
    status = client.status()
    tileset = str(status.get("tileset_last_modified", "unknown"))
    _log(f"matching {len(build.lines)} sections with Valhalla {status.get('version')} …")
    matches = match_lines(client, build.lines, wd / "match", tileset, workers)
    t["match"] = time.perf_counter() - t0

    way_ids = {p.edge["way_id"] for m in matches for p in m.pieces if p.edge and "way_id" in p.edge}
    _log(f"reading OSM tags for {len(way_ids):,} matched ways …")
    osm = load_osm(pbf, way_ids, wd / "osm")
    ev_number = classify.eurovelo_number(build.route.ref)
    matched = build_matched_layers(build.path, matches, osm, ev_number)
    notes = classify_gaps(build.components, osm.ferries, osm.stations, route_cfg.gaps)
    t["layers"] = time.perf_counter() - t0 - sum(t.values())

    _log("sampling terrain (Copernicus DEM GLO-30) …")
    profs = elevation.profiles(build.path, lambda lon, lat: dem.sample(lon, lat, root), matched.structures)
    # The terrain under a straight-line placeholder says nothing about the real road.
    untrusted = [(f.from_m, f.to_m) for f in build.findings if f.rule_id == "source.straight_segment"]
    elevation.mark_untrusted(profs, untrusted)
    unknown = elevation.unknown_terrain([(d.from_m, d.to_m) for d in build.daily], untrusted)
    grad = elevation.gradient_events(profs, untrusted)
    climbs = elevation.climbs(profs, untrusted=untrusted)
    t["terrain"] = time.perf_counter() - t0 - sum(t.values())

    svc_profile = load_services(services_name)
    services = build_places(
        root,
        wd,
        build,
        profs,
        client,
        tileset,
        snap.sha256,
        svc_profile,
        workers=workers,
        overture_release=overture_release,
        log=_log,
    )
    client.close()
    _log("places kept: " + ", ".join(f"{k} {v:,}" for k, v in services.counts.items()))
    t["services"] = time.perf_counter() - t0 - sum(t.values())

    events = sorted(matched.events + grad, key=lambda e: (e.layer, e.from_m))
    minor = evaluate(rules, events, build.daily, build.components, build.path.length)
    coverage.apply_criteria(services.coverage, minor, build.daily, rules)
    scores = ScoresFile(
        rules_profile=rules.id,
        criteria=rules.criterion_info(),
        route=stretch_stats(0.0, build.path.length, events, minor, rules, profs, unknown),
        sections=section_scores(build.daily, events, minor, rules, profs, unknown),
        climbs=climbs,
    )
    kept = [f.model_dump() for f in build.findings if f.rule_id != "source.gap_between_sections"]
    findings = to_findings(
        kept
        + gap_findings(build.components, notes)
        + rule_findings(rules, build.path, events, climbs, build.daily, scores.sections, matches)
        + coverage.findings(services.coverage, build.path.locate)
    )
    svc_file = services_file(services, build, svc_profile)

    dream = build_dream(
        root,
        wd,
        build,
        profs,
        events,
        scores.sections,
        services.places,
        services.coverage,
        svc_file,
        findings,
        load_dream(dream_name),
        untrusted=untrusted,
        log=_log,
    )
    t["dream"] = time.perf_counter() - t0 - sum(t.values())

    ms = np.concatenate([np.append(np.arange(p.from_m, p.to_m, PROFILE_STEP_M), p.to_m) for p in build.path.parts])
    dem_ele = elevation.at(profs, ms)
    gpx = []
    for m in ms:
        part = build.path.part_at(float(m))
        e = part.line.elevation_at(float(m) - part.from_m)
        gpx.append(None if e is None or np.isnan(e) else round(float(e), 1))
    profile = ProfileFile(
        step_m=PROFILE_STEP_M,
        source="Copernicus DEM GLO-30, smoothed; bridges and tunnels interpolated",
        m=[round(float(m), 1) for m in ms],
        ele=[None if np.isnan(e) else round(float(e), 1) for e in dem_ele],
        gpx_ele=gpx,
    )
    tiles = dem.needed_tiles(
        np.concatenate([p.line.lon for p in build.path.parts]), np.concatenate([p.line.lat for p in build.path.parts])
    )
    valhalla_source = SourceSnapshot(
        id="valhalla",
        title=f"Valhalla {status.get('version')} map matching and access routing (tiles {tileset})",
        url=valhalla_url,
        retrieved_at=snap.retrieved_at,
        file="-",
        sha256="n/a",
        bytes=0,
        licence=Licence(id="MIT", name="MIT License", url="https://github.com/valhalla/valhalla/blob/master/COPYING"),
        attribution="Map matching and routing by Valhalla (MIT)",
    )
    sources = [snap, *osm_sources, *services.sources, dem.snapshot(root, len(tiles)), *dream.sources, valhalla_source]
    run_id, out = write_bundle(
        build,
        sources,
        root,
        pipeline=PIPELINE,
        findings=findings,
        profile=profile,
        events=EventsFile(layers=classify.LAYERS, events=events),
        minor=minor,
        scores=scores,
        places=services.file,
        services=svc_file,
        dream=dream.file,
    )
    t["rules+write"] = time.perf_counter() - t0 - sum(t.values())
    _log(
        f"engine {__version__}: unmatched {matched.unmatched_m / 1000:.1f} km, "
        f"approximate {matched.approx_m / 1000:.1f} km"
    )
    return AuditResult(run_id=run_id, out=out, timings=t)
