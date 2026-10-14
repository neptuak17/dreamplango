"""Ridden access distance from the route to each place (D17), with Valhalla's distance matrix.

For each place, the candidate departure points are route samples (every 250 m) within its display distance,
nearest first. The shortest ridden distance over all of them wins, so a campsite across a river is reached by the
bridge, and that route point becomes the place's access point. Results are cached per tileset and route.
"""

import json
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

from dpg_audit.lrs.index import RouteSamples
from dpg_audit.match.valhalla import MATRIX_PAIRS, Valhalla, ValhallaError

ACCESS_VERSION = "1"


@dataclass
class AccessJob:
    key: str
    lon: float
    lat: float
    costing: str
    sources: list[int]
    """Indices into RouteSamples."""


@dataclass
class Access:
    distance_m: float | None
    at_m: float | None


def job_key(costing: str, lon: float, lat: float) -> str:
    return f"{costing}|{lon:.6f}|{lat:.6f}"


def _batches(jobs: Sequence[AccessJob], max_pairs: int) -> list[list[AccessJob]]:
    """Greedy batches whose (union of sources) x (targets) stays within the matrix limit."""
    out: list[list[AccessJob]] = []
    batch: list[AccessJob] = []
    srcs: set[int] = set()
    for job in jobs:
        merged = srcs | set(job.sources)
        if batch and len(merged) * (len(batch) + 1) > max_pairs:
            out.append(batch)
            batch, merged = [], set(job.sources)
        batch.append(job)
        srcs = merged
    if batch:
        out.append(batch)
    return out


def _solve(client: Valhalla, samples: RouteSamples, batch: list[AccessJob]) -> dict[str, Access]:
    src = sorted({s for j in batch for s in j.sources})
    try:
        dist = client.matrix(
            [(float(samples.lon[s]), float(samples.lat[s])) for s in src],
            [(j.lon, j.lat) for j in batch],
            costing=batch[0].costing,
        )
    except ValhallaError:
        # Usually one location that cannot be snapped: split until the culprit stands alone.
        if len(batch) == 1:
            return {batch[0].key: Access(None, None)}
        half = len(batch) // 2
        return {**_solve(client, samples, batch[:half]), **_solve(client, samples, batch[half:])}
    out = {}
    for t, job in enumerate(batch):
        best, best_src = None, None
        for i, s in enumerate(src):
            d = dist[i][t]
            if d is not None and (best is None or d < best):
                best, best_src = d, s
        out[job.key] = Access(best, None if best_src is None else float(samples.m[best_src]))
    return out


def compute_access(
    jobs: list[AccessJob], samples: RouteSamples, client: Valhalla, cache: Path, workers: int = 6
) -> dict[str, Access]:
    known: dict[str, Access] = {}
    if cache.exists():
        known = {k: Access(*v) for k, v in json.loads(cache.read_text(encoding="utf-8")).items()}
    todo = [j for j in jobs if j.key not in known]
    if todo:
        by_costing: dict[str, list[AccessJob]] = {}
        for j in todo:
            by_costing.setdefault(j.costing, []).append(j)
        batches = [b for js in by_costing.values() for b in _batches(js, MATRIX_PAIRS)]
        print(f"routing {len(todo):,} places in {len(batches):,} matrix requests …", flush=True)
        step = max(len(batches) // 10, 1)
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for done, result in enumerate(pool.map(lambda b: _solve(client, samples, b), batches), start=1):
                known.update(result)
                if done % step == 0 or done == len(batches):
                    _save(cache, known)  # an interrupted run resumes from here
                    print(f"  {done:,}/{len(batches):,} requests", flush=True)
    return {j.key: known[j.key] for j in jobs}


def _save(cache: Path, known: dict[str, Access]) -> None:
    cache.parent.mkdir(parents=True, exist_ok=True)
    tmp = cache.with_suffix(".tmp")
    tmp.write_text(json.dumps({k: [a.distance_m, a.at_m] for k, a in known.items()}), encoding="utf-8")
    tmp.replace(cache)
