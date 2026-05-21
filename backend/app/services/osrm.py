"""
OSRM routing client.

We use the public `foot` profile so routes prefer pedestrian-friendly ways:
sidewalks, paths, parks, and footways where OpenStreetMap has mapped them.

Two endpoints are used:
- /route   — single leg between two points (kept for any future use)
- /trip    — round-trip through multiple waypoints in the best order (used by route_generator)
"""

from __future__ import annotations

import os
from typing import Any, List, Optional, Sequence, Tuple

import httpx

from app.utils.geo import LngLat, append_line_string_coords

# Defaults match the frontend; override in backend/.env if you host your own OSRM.
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

    Returns (distance_meters, coordinates_or_none).
    Pass want_geometry=False for faster distance-only tuning calls.
    """
    coord_path = f"{from_lng},{from_lat};{to_lng},{to_lat}"
    params: dict[str, str] = {
        "geometries": "geojson",
        "steps": "false",
        "continue_straight": "false",
        "overview": "full" if want_geometry else "false",
    }
    url = f"{OSRM_BASE}/route/v1/{OSRM_PROFILE}/{coord_path}"

    response = await client.get(url, params=params, timeout=30.0)
    if response.status_code != 200:
        raise OsrmError(f"OSRM HTTP {response.status_code}")

    data = response.json()
    if data.get("code") != "Ok" or not data.get("routes"):
        raise OsrmError(data.get("message", "OSRM could not find a path between these points."))

    route = data["routes"][0]
    distance = float(route["distance"])

    coords: Optional[List[LngLat]] = None
    if want_geometry:
        geometry = route.get("geometry") or {}
        if geometry.get("type") != "LineString":
            raise OsrmError("Unexpected geometry type from OSRM.")
        coords = [list(c) for c in geometry["coordinates"]]

    return distance, coords


async def fetch_osrm_trip(
    client: httpx.AsyncClient,
    start_lat: float,
    start_lng: float,
    waypoints: Sequence[tuple[float, float]],
) -> dict[str, Any]:
    """
    Call the OSRM /trip endpoint to build a round-trip loop.

    The trip endpoint finds the optimal visiting order for all waypoints
    and routes back to the start — perfect for smooth running loops that
    don't double back on themselves.

    Parameters
    ----------
    client      : shared httpx client
    start_lat   : loop origin latitude
    start_lng   : loop origin longitude
    waypoints   : list of (lat, lng) intermediate stops around the circle

    Returns
    -------
    dict with keys:
        "coordinates"    — GeoJSON LineString coordinate list [[lng, lat], ...]
        "distance_meters" — total loop length in metres
    """
    # Build the coordinate string: start + all waypoints (OSRM uses lng,lat order).
    all_points = [(start_lat, start_lng)] + list(waypoints)
    coord_str = ";".join(f"{lng},{lat}" for lat, lng in all_points)

    params = {
        "geometries": "geojson",
        "overview": "full",
        "steps": "false",
        # roundtrip=true  → OSRM closes the loop back to the first coordinate.
        # source=first    → the loop always starts at our chosen start point.
        # destination=last is ignored when roundtrip=true, but set for clarity.
        "roundtrip": "true",
        "source": "first",
    }
    url = f"{OSRM_BASE}/trip/v1/{OSRM_PROFILE}/{coord_str}"

    response = await client.get(url, params=params, timeout=45.0)
    if response.status_code != 200:
        raise OsrmError(f"OSRM trip HTTP {response.status_code}")

    data = response.json()
    if data.get("code") != "Ok" or not data.get("trips"):
        raise OsrmError(
            data.get("message", "OSRM trip could not build a round-trip for these waypoints.")
        )

    trip = data["trips"][0]
    distance_meters = float(trip["distance"])

    # The trip geometry is a single LineString covering the whole loop.
    geometry = trip.get("geometry") or {}
    if geometry.get("type") != "LineString":
        raise OsrmError("Unexpected geometry type from OSRM trip.")

    coordinates = [list(c) for c in geometry["coordinates"]]

    return {
        "coordinates": coordinates,
        "distance_meters": distance_meters,
    }