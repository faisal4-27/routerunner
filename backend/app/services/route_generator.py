"""
Generates a single smooth running loop using circular waypoints and the OSRM trip endpoint.

How it works:
1. Place 4 waypoints evenly around a circle centred on the start point.
   The circle radius is chosen so the circumference ≈ target distance.
2. Feed those waypoints (plus the start/end anchor) into OSRM's `trip` endpoint,
   which finds the best road-following order and returns a single round-trip polyline.
3. Count traffic signals (Overpass) and fetch elevation (Open-Meteo) for the result.

Using a circle + OSRM trip instead of a hand-crafted square avoids the
double-back problem: OSRM never needs to retrace a street to connect legs.
"""

from __future__ import annotations

import math

import httpx

from app.models.schemas import RouteCandidate
from app.services.elevation import fetch_elevations_along_route
from app.services.osrm import OsrmError, fetch_osrm_trip
from app.services.overpass import count_traffic_signals
from app.utils.geo import offset_lat_lng

# Number of waypoints placed around the circle (not counting start/end).
# 4 gives a roughly square footprint; increase for a rounder loop.
NUM_WAYPOINTS = 4


def _circle_waypoints(
    lat: float, lng: float, radius_m: float, count: int
) -> list[tuple[float, float]]:
    """
    Return `count` (lat, lng) points evenly spaced around a circle.

    The first waypoint is placed due north; the rest follow clockwise
    so bearings are 0°, 90°, 180°, 270° for count=4.
    """
    waypoints = []
    for i in range(count):
        bearing = (360 / count) * i          # evenly spaced bearings
        wlat, wlng = offset_lat_lng(lat, lng, radius_m, bearing)
        waypoints.append((wlat, wlng))
    return waypoints


async def generate_route(
    lat: float, lng: float, distance_km: float
) -> RouteCandidate:
    """
    Build one smooth loop and return it enriched with elevation and signal data.

    Steps
    -----
    1. Compute circle radius so circumference ≈ target distance.
    2. Place NUM_WAYPOINTS evenly around that circle.
    3. Call OSRM trip endpoint — it routes through all waypoints in the
       best road-following order and closes the loop back to the start.
    4. If the returned distance is too far off, scale the radius and retry
       (up to 5 times).
    5. Attach signal count and elevation, then return.
    """
    target_meters = distance_km * 1000

    # Radius of the circle: circumference = 2πr, so r = distance / (2π).
    # We scale this up slightly because road routing is always longer than
    # crow-flight, so we start with a modest over-estimate.
    base_radius_m = (target_meters / (2 * math.pi)) * 1.15

    tolerance_m = max(150.0, target_meters * 0.08)   # within 8 % is good enough
    radius_m = base_radius_m
    last_error: Exception | None = None

    async with httpx.AsyncClient() as client:
        for attempt in range(6):
            waypoints = _circle_waypoints(lat, lng, radius_m, NUM_WAYPOINTS)

            try:
                built = await fetch_osrm_trip(
                    client,
                    start_lat=lat,
                    start_lng=lng,
                    waypoints=waypoints,
                )
            except OsrmError as exc:
                last_error = exc
                # Slightly widen the circle and try again on transient failures.
                radius_m *= 1.1
                continue

            distance_meters = built["distance_meters"]
            error_m = target_meters - distance_meters

            if abs(error_m) <= tolerance_m:
                # Good enough — enrich and return.
                coords = built["coordinates"]

                try:
                    signal_count = await count_traffic_signals(client, coords)
                except Exception:
                    # Don't fail the whole request if Overpass is unavailable.
                    signal_count = 0

                gain, loss = await fetch_elevations_along_route(client, coords)

                return RouteCandidate(
                    coordinates=coords,
                    distance_meters=distance_meters,
                    elevation_gain_m=round(gain),
                    elevation_loss_m=round(loss),
                    signal_count=signal_count,
                )

            # Scale the radius proportionally to close the gap.
            # e.g. if we got 4 km but wanted 5 km, grow radius by ~25 %.
            scale = 1.0 + (error_m / target_meters) * 0.55
            scale = max(0.5, min(2.0, scale))     # clamp to avoid wild swings
            radius_m *= scale

    raise last_error or OsrmError(
        "Could not generate a route close enough to the target distance. "
        "Try a different start point or distance."
    )