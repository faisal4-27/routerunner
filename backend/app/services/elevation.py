"""
Open-Meteo elevation API client.

Fetches terrain height at sampled points along the route and computes
total elevation gain and loss.
"""

from __future__ import annotations

import asyncio
import os
from typing import List, Sequence, Tuple

import httpx

from app.utils.geo import LngLat, sample_line_coords

OPEN_METEO_ELEVATION_URL = os.getenv(
    "OPEN_METEO_ELEVATION_URL", "https://api.open-meteo.com/v1/elevation"
)
MAX_POINTS_PER_REQUEST = 100
# 96 samples fits in one Open-Meteo batch, keeping the elevation step to
# one HTTP round-trip even before parallel batching kicks in. For a 5 km
# loop that's a sample every ~50 m, which is well below Open-Meteo's
# underlying DEM resolution anyway.
ELEVATION_MAX_SAMPLES = 96


def elevation_stats(elevations: Sequence[float]) -> Tuple[float, float]:
    """
    Return (total_gain_m, max_climb_m) for a series of elevation samples.

    `total_gain_m` is the sum of every uphill step — exactly the figure a
    runner sees on a GPS watch as "elevation gain".

    `max_climb_m` is the largest sustained low-to-high difference anywhere
    on the route, found with Kadane's running-minimum trick. It tells you
    how big the worst single climb on the loop is — a more useful stat than
    elevation loss, which for a closed loop is just gain repeated.
    """
    gain = 0.0
    max_climb = 0.0
    min_so_far = elevations[0] if elevations else 0.0

    for i in range(1, len(elevations)):
        prev = elevations[i - 1]
        curr = elevations[i]
        if curr > prev:
            gain += curr - prev
        if curr < min_so_far:
            min_so_far = curr
        elif curr - min_so_far > max_climb:
            max_climb = curr - min_so_far

    return gain, max_climb


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
    Sample the route and return (total_gain_m, max_climb_m).

    Batches are fired concurrently — Open-Meteo handles independent requests
    in parallel, and with the 96-sample cap a typical loop now needs only
    one batch (single round-trip).

    Returns (0, 0) if the API returns too few usable points.
    """
    sampled = sample_line_coords(coords, ELEVATION_MAX_SAMPLES)

    batches = [
        sampled[i : i + MAX_POINTS_PER_REQUEST]
        for i in range(0, len(sampled), MAX_POINTS_PER_REQUEST)
    ]
    results = await asyncio.gather(
        *(fetch_elevations_batch(client, batch) for batch in batches)
    )

    all_elev: List[float] = []
    for batch_elev in results:
        all_elev.extend(batch_elev)

    if len(all_elev) < 2:
        return 0.0, 0.0
    return elevation_stats(all_elev)
