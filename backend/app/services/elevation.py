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


# Smoothing for Open-Meteo profiles, tuned against USGS lidar ground truth.
# Summing every raw uphill step over-counted badly (e.g. 344 m vs a real
# 24 m in Midtown Manhattan); a 5-point median plus a 3 m dead band was the
# best fit. Must match ELEVATION_SMOOTHING.openMeteo in app.js.
SMOOTH_MEDIAN_WINDOW = 5
GAIN_THRESHOLD_M = 3.0


def _median_filter(values: Sequence[float], k: int) -> List[float]:
    half = k // 2
    out: List[float] = []
    for i in range(len(values)):
        window = sorted(values[max(0, i - half) : i + half + 1])
        mid = len(window) // 2
        out.append(window[mid] if len(window) % 2 else (window[mid - 1] + window[mid]) / 2)
    return out


def elevation_stats(elevations: Sequence[float]) -> Tuple[float, float]:
    """
    Return (total_gain_m, max_climb_m) for a series of elevation samples.

    The profile is median-smoothed first, then gain is counted with a dead
    band, like a GPS watch: a climb only counts once it rises
    GAIN_THRESHOLD_M above the last turning point, so terrain-model noise
    doesn't add up into fake climbing.

    `max_climb_m` is the largest sustained low-to-high difference anywhere
    on the (smoothed) route, found with a running minimum — a more useful
    stat than elevation loss, which for a closed loop is just gain repeated.
    """
    if not elevations:
        return 0.0, 0.0
    smooth = _median_filter(elevations, SMOOTH_MEDIAN_WINDOW)

    gain = 0.0
    anchor = smooth[0]
    max_climb = 0.0
    min_so_far = smooth[0]
    for curr in smooth[1:]:
        if curr - anchor >= GAIN_THRESHOLD_M:
            gain += curr - anchor
            anchor = curr
        elif anchor - curr >= GAIN_THRESHOLD_M:
            anchor = curr
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
) -> Tuple[float, float, List[float]]:
    """
    Sample the route and return (total_gain_m, max_climb_m, profile).

    `profile` is the sampled elevation series in route order, used by the
    frontend's elevation chart.

    Batches are fired concurrently — Open-Meteo handles independent requests
    in parallel, and with the 96-sample cap a typical loop now needs only
    one batch (single round-trip).

    Returns (0, 0, []) if the API returns too few usable points.
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
        return 0.0, 0.0, []
    gain, max_climb = elevation_stats(all_elev)
    return gain, max_climb, all_elev
