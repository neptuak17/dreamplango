"""Minimal client for a local Valhalla service (started with scripts/valhalla)."""

from typing import Any

import httpx

DEFAULT_URL = "http://127.0.0.1:8002"

# Bicycle costing used both for matching the official track and for routing around problems.
BICYCLE = {"bicycle_type": "Hybrid", "use_roads": 0.5, "use_hills": 0.5, "use_ferry": 1.0, "avoid_bad_surfaces": 0.0}


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
