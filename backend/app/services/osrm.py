"""
OSRM routing client.

We use the public `foot` profile so routes prefer pedestrian-friendly ways:
sidewalks, paths, parks, and footways where OpenStreetMap has mapped them.

Only `fetch_osrm_route` is exposed — the route generator wires individual
legs together itself so it has full control over waypoint placement and
double-back avoidance.
"""

from __future__ import annotations

import os
from typing import Any, List, Optional, Sequence, Tuple

import httpx

from app.utils.geo import LngLat

# Override in backend/.env if you host your own OSRM server.
OSRM_BASE = os.getenv("OSRM_BASE_URL", "https://router.project-osrm.org")
OSRM_PROFILE = "foot"


class OsrmError(Exception):
    """Raised when OSRM cannot find a route or returns an unexpected response."""


async def fetch_osrm_route(
    client: httpx.AsyncClient,
    from_lat: float,
    from_lng: float,
    to_lat: float,
    to_lng: float,
    *,
    want_geometry: bool = True,
) -> Tuple[float, Optional[List[LngLat]]]:
    """
    Request a single road-following leg between two points.

    `continue_straight=true` discourages U-turns at the start/end snap point,
    which keeps consecutive legs from doubling back on the previous street.

    Returns (distance_meters, coordinates_or_none).
    Pass want_geometry=False for faster distance-only tuning calls.
    """
    coord_path = f"{from_lng},{from_lat};{to_lng},{to_lat}"
    params: dict[str, str] = {
        "geometries": "geojson",
        "steps": "false",
        "continue_straight": "true",
        "overview": "full" if want_geometry else "false",
    }
    url = f"{OSRM_BASE}/route/v1/{OSRM_PROFILE}/{coord_path}"

    response = await client.get(url, params=params, timeout=30.0)
    if response.status_code != 200:
        raise OsrmError(f"OSRM HTTP {response.status_code}")

    data = response.json()
    if data.get("code") != "Ok" or not data.get("routes"):
        raise OsrmError(
            data.get("message", "OSRM could not find a path between these points.")
        )

    route = data["routes"][0]
    distance = float(route["distance"])

    coords: Optional[List[LngLat]] = None
    if want_geometry:
        geometry = route.get("geometry") or {}
        if geometry.get("type") != "LineString":
            raise OsrmError("Unexpected geometry type from OSRM.")
        coords = [list(c) for c in geometry["coordinates"]]

    return distance, coords


async def fetch_osrm_route_through_points(
    client: httpx.AsyncClient,
    points: Sequence[Tuple[float, float]],
    *,
    want_geometry: bool = True,
) -> dict[str, Any]:
    """
    Route through an ordered list of (lat, lng) points in a single OSRM call.

    Returning per-leg distances from one request is much cheaper than firing
    one HTTP call per leg — fewer round-trips, one OSRM routing context, and
    `continue_straight=true` is enforced consistently across every via point.

    Pass `want_geometry=False` for fast distance-only tuning calls; the
    response payload shrinks dramatically when OSRM doesn't have to
    serialize the full polyline.

    Returns a dict with:
        "leg_distances"   — list of per-leg distances in metres (len = len(points)-1)
        "total_distance"  — sum of leg distances in metres
        "coordinates"     — combined [lng, lat] polyline, or None if no geometry requested
    """
    if len(points) < 2:
        raise OsrmError("Need at least two points to build a route.")

    coord_str = ";".join(f"{lng},{lat}" for lat, lng in points)
    params: dict[str, str] = {
        "geometries": "geojson",
        "steps": "false",
        "continue_straight": "true",
        "annotations": "false",
        "overview": "full" if want_geometry else "false",
    }
    url = f"{OSRM_BASE}/route/v1/{OSRM_PROFILE}/{coord_str}"

    response = await client.get(url, params=params, timeout=45.0)
    if response.status_code != 200:
        raise OsrmError(f"OSRM HTTP {response.status_code}")

    data = response.json()
    if data.get("code") != "Ok" or not data.get("routes"):
        raise OsrmError(
            data.get("message", "OSRM could not build a route through these points.")
        )

    route = data["routes"][0]
    leg_distances = [float(leg["distance"]) for leg in route.get("legs", [])]
    total_distance = float(route["distance"])

    coordinates: Optional[List[LngLat]] = None
    if want_geometry:
        geometry = route.get("geometry") or {}
        if geometry.get("type") != "LineString":
            raise OsrmError("Unexpected geometry type from OSRM.")
        coordinates = [list(c) for c in geometry["coordinates"]]

    return {
        "leg_distances": leg_distances,
        "total_distance": total_distance,
        "coordinates": coordinates,
    }
