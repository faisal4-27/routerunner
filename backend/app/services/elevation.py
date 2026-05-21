"""
Open-Meteo elevation API client.

Fetches terrain height at sampled points along the route and computes
total elevation gain and loss.
"""

from __future__ import annotations

import os
from typing import List, Sequence, Tuple

import httpx

from app.utils.geo import LngLat, sample_line_coords

OPEN_METEO_ELEVATION_URL = os.getenv(
    "OPEN_METEO_ELEVATION_URL", "https://api.open-meteo.com/v1/elevation"
)
MAX_POINTS_PER_REQUEST = 100
ELEVATION_MAX_SAMPLES = 180


def elevation_gain_loss(elevations: Sequence[float]) -> Tuple[float, float]:
    """Sum uphill and downhill meters between consecutive samples."""
    gain = 0.0
    loss = 0.0
    for i in range(1, len(elevations)):
        delta = elevations[i] - elevations[i - 1]
        if delta > 0:
            gain += delta
        else:
            loss += -delta
    return gain, loss


async def fetch_elevations_batch(
    client: httpx.AsyncClient, coords: Sequence[LngLat]
) -> List[float]:
    """One Open-Meteo request for a batch of [lng, lat] points."""
    lats = ",".join(str(c[1]) for c in coords)
    lngs = ",".join(str(c[0]) for c in coords)
    response = await client.get(
        OPEN_METEO_ELEVATION_URL,
        params={"latitude": lats, "longitude": lngs},
        timeout=30.0,
    )
    data = response.json()
    if response.status_code != 200 or data.get("error"):
        reason = data.get("reason", f"Open-Meteo HTTP {response.status_code}")
        raise RuntimeError(reason)

    elevation = data.get("elevation")
    if not isinstance(elevation, list):
        raise RuntimeError("Unexpected Open-Meteo elevation response.")

    cleaned: List[float] = []
    for value in elevation:
        if isinstance(value, (int, float)) and value == value:  # skip NaN
            cleaned.append(float(value))
    return cleaned


async def fetch_elevations_along_route(
    client: httpx.AsyncClient, coords: Sequence[LngLat]
) -> Tuple[float, float]:
    """
    Sample the route, fetch elevation in batches of 100, return (gain_m, loss_m).
    Returns (0, 0) if the API returns too few usable points.
    """
    sampled = sample_line_coords(coords, ELEVATION_MAX_SAMPLES)
    all_elev: List[float] = []

    for i in range(0, len(sampled), MAX_POINTS_PER_REQUEST):
        batch = sampled[i : i + MAX_POINTS_PER_REQUEST]
        batch_elev = await fetch_elevations_batch(client, batch)
        all_elev.extend(batch_elev)

    if len(all_elev) < 2:
        return 0.0, 0.0
    return elevation_gain_loss(all_elev)
