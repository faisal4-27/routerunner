"""
Overpass API client — counts traffic-signal intersections along a route.

The public overpass-api.de instance requires a descriptive User-Agent and
discourages parallel queries from one app. We send one request at a time and
retry while the server is overloaded (429 / 502 / 503 / 504) — under load it
answers "502 ... server is currently at capacity", which must not be mistaken
for "no signals".
"""

from __future__ import annotations

import asyncio
import math
import os
from typing import List, Sequence, Tuple

import httpx

from app.utils.geo import LngLat, sample_line_coords

OVERPASS_URL = os.getenv("OVERPASS_URL", "https://overpass-api.de/api/interpreter")
# Required by overpass-api.de (stock httpx/python User-Agents are rejected with HTTP 406).
OVERPASS_USER_AGENT = os.getenv(
    "OVERPASS_USER_AGENT",
    "RouteRunner/1.0 (local development; pedestrian route planner)",
)

# A signal counts when it is within this distance of the route line.
SIGNAL_SEARCH_RADIUS_M = 35
# Signals within this distance of each other are one intersection. OSM often
# maps a junction as one node per approach (2–4 nodes for one set of lights),
# and a runner only stops once per junction.
INTERSECTION_CLUSTER_M = 30
# The route line sent to Overpass. `around:` measures distance to the whole
# polyline, so thinning only straightens corners slightly; 300 vertices keeps
# the query short while staying within a few metres of the real path.
MAX_LINE_VERTICES = 300
# Small margin so signals just outside the route's bounding box still match.
BBOX_PAD_DEG = 0.0005

RETRY_STATUSES = {429, 502, 503, 504}
MAX_ATTEMPTS = 4

# Only one Overpass call at a time per server process (fair use policy).
_overpass_lock = asyncio.Lock()


class OverpassUnavailable(RuntimeError):
    """Overpass could not answer, so the signal count is unknown (not zero)."""


def build_overpass_signal_query(coords: Sequence[LngLat]) -> str:
    """
    Build one Overpass QL query for signal nodes near the whole route.

    The bounding-box filter runs first and uses Overpass's spatial index, so
    the comparatively expensive distance-to-polyline test only runs on the
    handful of signals inside the route's area.
    """
    lats = [c[1] for c in coords]
    lngs = [c[0] for c in coords]
    bbox = (
        f"{min(lats) - BBOX_PAD_DEG:.6f},{min(lngs) - BBOX_PAD_DEG:.6f},"
        f"{max(lats) + BBOX_PAD_DEG:.6f},{max(lngs) + BBOX_PAD_DEG:.6f}"
    )
    line = ",".join(
        f"{lat:.6f},{lng:.6f}" for lng, lat in sample_line_coords(coords, MAX_LINE_VERTICES)
    )
    return (
        "[out:json][timeout:25];\n"
        f'node["highway"="traffic_signals"]({bbox})->.signals;\n'
        f"node.signals(around:{SIGNAL_SEARCH_RADIUS_M},{line});\n"
        "out skel qt;"
    )


def _distance_m(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    """Equirectangular distance between (lat, lng) points; fine at this scale."""
    mean_lat = math.radians((a[0] + b[0]) / 2)
    dx = math.radians(b[1] - a[1]) * math.cos(mean_lat)
    dy = math.radians(b[0] - a[0])
    return 6371000.0 * math.hypot(dx, dy)


def count_intersections(points: Sequence[Tuple[float, float]]) -> int:
    """Group signal nodes closer than INTERSECTION_CLUSTER_M and count groups."""
    parent = list(range(len(points)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(points)):
        for j in range(i + 1, len(points)):
            if _distance_m(points[i], points[j]) <= INTERSECTION_CLUSTER_M:
                parent[find(i)] = find(j)

    return len({find(i) for i in range(len(points))})


async def count_traffic_signals(
    client: httpx.AsyncClient, coords: Sequence[LngLat]
) -> int:
    """
    Return the number of signal-controlled intersections along the route.

    Raises OverpassUnavailable if Overpass can't answer — callers must not
    report that as zero.
    """
    if len(coords) < 2:
        return 0
    query = build_overpass_signal_query(coords)

    async with _overpass_lock:
        points = await _post_overpass_with_retry(client, query)
    return count_intersections(points)


async def _post_overpass_with_retry(
    client: httpx.AsyncClient, query: str
) -> List[Tuple[float, float]]:
    """POST the query, retrying with backoff while Overpass is overloaded."""
    last_error = "no response"

    for attempt in range(MAX_ATTEMPTS):
        if attempt:
            await asyncio.sleep(min(2 ** attempt, 10))
        try:
            response = await client.post(
                OVERPASS_URL,
                # Standard Overpass POST body (application/x-www-form-urlencoded).
                data={"data": query},
                headers={"User-Agent": OVERPASS_USER_AGENT},
                timeout=45.0,
            )
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            last_error = f"{type(exc).__name__}: {exc}"
            continue

        if response.status_code in RETRY_STATUSES:
            last_error = f"HTTP {response.status_code}"
            if response.status_code == 429:
                retry_after = response.headers.get("Retry-After", "")
                if retry_after.isdigit():
                    await asyncio.sleep(min(int(retry_after), 20))
            continue

        if response.status_code != 200:
            raise OverpassUnavailable(
                f"Overpass HTTP {response.status_code}: {(response.text or '')[:200]}"
            )

        data = response.json()
        # Overpass reports query-side timeouts in a 200 response via `remark`.
        remark = data.get("remark") or ""
        if "runtime error" in remark.lower():
            last_error = remark[:200]
            continue

        return [
            (float(el["lat"]), float(el["lon"]))
            for el in data.get("elements", [])
            if el.get("type") == "node" and "lat" in el and "lon" in el
        ]

    raise OverpassUnavailable(
        f"Overpass unavailable after {MAX_ATTEMPTS} attempts ({last_error})"
    )
