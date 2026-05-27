"""
Overpass API client — counts traffic signals near a route.

The public overpass-api.de instance now requires a descriptive User-Agent and
discourages parallel queries from one app. We send one request at a time and
retry on temporary overload (429 / 504).
"""

from __future__ import annotations

import asyncio
import os
from typing import List, Sequence

import httpx

from app.utils.geo import LngLat, sample_line_coords

OVERPASS_URL = os.getenv("OVERPASS_URL", "https://overpass-api.de/api/interpreter")
# Required by overpass-api.de (stock httpx/python User-Agents are rejected with HTTP 406).
OVERPASS_USER_AGENT = os.getenv(
    "OVERPASS_USER_AGENT",
    "RouteRunner/1.0 (local development; pedestrian route planner)",
)

SIGNAL_SEARCH_RADIUS_M = 35
# Each sample point becomes an `around:` clause in the Overpass QL query;
# 25 points covers a typical loop while keeping the query short enough
# that Overpass responds in well under a second on a normal day.
MAX_SAMPLE_POINTS = 25

# Only one Overpass call at a time per server process (fair use policy).
_overpass_lock = asyncio.Lock()


def build_overpass_signal_query(coords: Sequence[LngLat]) -> str:
    """Build one Overpass QL query with an `around:` clause per sample point."""
    samples = sample_line_coords(coords, MAX_SAMPLE_POINTS)
    lines = []
    for lng, lat in samples:
        lines.append(
            f'  node["highway"="traffic_signals"](around:{SIGNAL_SEARCH_RADIUS_M},{lat},{lng});'
        )
    return "[out:json][timeout:25];\n(\n" + "\n".join(lines) + "\n);\nout;"


async def count_traffic_signals(
    client: httpx.AsyncClient, coords: Sequence[LngLat]
) -> int:
    """Return the number of distinct traffic signal nodes near the route."""
    query = build_overpass_signal_query(coords)

    async with _overpass_lock:
        return await _post_overpass_with_retry(client, query)


async def _post_overpass_with_retry(
    client: httpx.AsyncClient, query: str, max_attempts: int = 3
) -> int:
    """POST the query; retry after 429/504 with a short pause."""
    last_error: Exception | None = None

    for attempt in range(max_attempts):
        try:
            response = await client.post(
                OVERPASS_URL,
                # Standard Overpass POST body (application/x-www-form-urlencoded).
                data={"data": query},
                headers={"User-Agent": OVERPASS_USER_AGENT},
                timeout=60.0,
            )

            if response.status_code == 429:
                wait_s = int(response.headers.get("Retry-After", "5"))
                await asyncio.sleep(min(wait_s, 30))
                continue

            if response.status_code == 504:
                await asyncio.sleep(3 * (attempt + 1))
                continue

            if response.status_code != 200:
                body_preview = (response.text or "")[:200]
                raise RuntimeError(
                    f"Overpass HTTP {response.status_code}: {body_preview}"
                )

            data = response.json()
            seen_ids: set[int] = set()
            for element in data.get("elements", []):
                if element.get("type") == "node" and element.get("id") is not None:
                    seen_ids.add(int(element["id"]))
            return len(seen_ids)

        except (httpx.TimeoutException, httpx.TransportError) as exc:
            last_error = exc
            await asyncio.sleep(2 * (attempt + 1))

    raise RuntimeError(
        f"Overpass request failed after {max_attempts} attempts: {last_error}"
    )
