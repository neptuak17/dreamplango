"""Minimal client for a local Valhalla service (started with scripts/valhalla)."""

from typing import Any

import httpx

DEFAULT_URL = "http://127.0.0.1:8002"

# Bicycle costing used both for matching the official track and for routing around problems.
BICYCLE = {"bicycle_type": "Hybrid", "use_roads": 0.5, "use_hills": 0.5, "use_ferry": 1.0, "avoid_bad_surfaces": 0.0}
# Riding off the route to a place: same bike, but no ferries.
BICYCLE_ACCESS = {**BICYCLE, "use_ferry": 0.0}
MATRIX_PAIRS = 2500
"""Valhalla's default `max_matrix_location_pairs` for bicycle and auto."""


class ValhallaError(RuntimeError):
    def __init__(self, status: int, body: Any):
        super().__init__(f"Valhalla error {status}: {body}")
        self.status = status
        self.body = body


class Valhalla:
    def __init__(self, url: str = DEFAULT_URL, timeout: float = 300.0):
        self.url = url.rstrip("/")
        self._client = httpx.Client(timeout=timeout)

    def close(self) -> None:
        self._client.close()

    def _post(self, action: str, payload: dict) -> dict:
        resp = self._client.post(f"{self.url}/{action}", json=payload)
        if resp.status_code != 200:
            try:
                body = resp.json()
            except ValueError:
                body = resp.text
            raise ValhallaError(resp.status_code, body)
        return resp.json()

    def status(self) -> dict:
        resp = self._client.get(f"{self.url}/status")
        resp.raise_for_status()
        return resp.json()

    def matrix(
        self,
        sources: list[tuple[float, float]],
        targets: list[tuple[float, float]],
        *,
        costing: str = "bicycle",
        target_cutoff_m: float = 1000,
    ) -> list[list[float | None]]:
        """Distances in metres from every source to every target (None where no route exists).

        Targets snap to the network only within `target_cutoff_m`, so a place far from any road is unreachable
        rather than silently moved.
        """
        options = {"bicycle": BICYCLE_ACCESS} if costing == "bicycle" else {}
        body = self._post(
            "sources_to_targets",
            {
                "sources": [{"lon": lon, "lat": lat} for lon, lat in sources],
                "targets": [{"lon": lon, "lat": lat, "search_cutoff": target_cutoff_m} for lon, lat in targets],
                "costing": costing,
                "costing_options": options,
                "units": "kilometers",
                "verbose": False,
            },
        )
        dist = body["sources_to_targets"]["distances"]
        return [[None if d is None else d * 1000 for d in row] for row in dist]

    def trace_attributes(
        self,
        points: list[tuple[float, float]],
        *,
        search_radius: float = 50,
        gps_accuracy: float = 15,
        breakage_distance: float = 40_000,
    ) -> dict:
        """Map-match lon/lat points to the road/path network and return per-edge attributes."""
        return self._post(
            "trace_attributes",
            {
                "shape": [{"lon": lon, "lat": lat} for lon, lat in points],
                "costing": "bicycle",
                "costing_options": {"bicycle": BICYCLE},
                "shape_match": "map_snap",
                "units": "kilometers",
                "trace_options": {
                    "search_radius": search_radius,
                    "gps_accuracy": gps_accuracy,
                    "breakage_distance": breakage_distance,
                    "turn_penalty_factor": 100,
                },
            },
        )
