"""
Small geometry helpers used when building and scoring routes.

Coordinates are always [longitude, latitude] (GeoJSON order), matching OSRM output.
"""

from __future__ import annotations

import math
from typing import List, Sequence, Tuple

# Type alias: one point as [lng, lat]
LngLat = List[float]


def offset_lat_lng(
    lat: float, lng: float, distance_meters: float, bearing_deg: float
) -> Tuple[float, float]:
    """
    Move a point `distance_meters` along a compass bearing (degrees clockwise from north).
    Uses a spherical Earth model — accurate enough for loops of a few kilometers.
    """
    earth_radius_m = 6_371_000
    bearing_rad = math.radians(bearing_deg)
    lat1 = math.radians(lat)
    lon1 = math.radians(lng)
    angular_dist = distance_meters / earth_radius_m

    lat2 = math.asin(
        math.sin(lat1) * math.cos(angular_dist)
        + math.cos(lat1) * math.sin(angular_dist) * math.cos(bearing_rad)
    )
    lon2 = lon1 + math.atan2(
        math.sin(bearing_rad) * math.sin(angular_dist) * math.cos(lat1),
        math.cos(angular_dist) - math.sin(lat1) * math.sin(lat2),
    )
    return math.degrees(lat2), math.degrees(lon2)


def approx_distance_meters(a: Sequence[float], b: Sequence[float]) -> float:
    """Fast flat-earth distance between two [lng, lat] points (meters)."""
    d_lat = (b[1] - a[1]) * 111_320
    avg_lat_rad = math.radians((a[1] + b[1]) / 2)
    d_lng = (b[0] - a[0]) * 111_320 * math.cos(avg_lat_rad)
    return math.hypot(d_lat, d_lng)


def last_coord_lat_lng(coords: Sequence[LngLat]) -> Tuple[float, float]:
    """Return (lat, lng) of the last vertex in a coordinate list."""
    lng, lat = coords[-1]
    return lat, lng


def segment_bearing_deg(from_pt: Sequence[float], to_pt: Sequence[float]) -> float:
    """Compass bearing (0–360°) from one point to the next."""
    from_lng, from_lat = from_pt[0], from_pt[1]
    to_lng, to_lat = to_pt[0], to_pt[1]
    lat_rad = math.radians((from_lat + to_lat) / 2)
    dx = (to_lng - from_lng) * math.cos(lat_rad)
    dy = to_lat - from_lat
    bearing = math.degrees(math.atan2(dx, dy))
    return bearing % 360 if bearing >= 0 else bearing + 360


def route_end_bearing_deg(coords: Sequence[LngLat]) -> float:
    """Bearing of the final segment — used to compute the next 90° right turn."""
    if len(coords) < 2:
        return 0.0
    return segment_bearing_deg(coords[-2], coords[-1])


def append_line_string_coords(base: List[LngLat], extension: Sequence[LngLat]) -> List[LngLat]:
    """
    Concatenate two LineStrings, skipping a duplicate join vertex when endpoints
    are within ~6 m of each other.
    """
    if not extension:
        return list(base)
    if not base:
        return list(extension)

    out = list(base)
    first_ext = extension[0]
    last_base = out[-1]
    start_idx = 1 if approx_distance_meters(last_base, first_ext) < 6 else 0
    for i in range(start_idx, len(extension)):
        out.append(list(extension[i]))
    return out


def sample_line_coords(coords: Sequence[LngLat], max_points: int) -> List[LngLat]:
    """
    Keep every Nth vertex so API requests stay small.
    Always retains the first and last points.
    """
    if len(coords) <= max_points:
        return [list(c) for c in coords]

    step = math.ceil(len(coords) / max_points)
    out: List[LngLat] = []
    for i in range(0, len(coords) - 1, step):
        out.append(list(coords[i]))
    last = list(coords[-1])
    if not out or out[-1][0] != last[0] or out[-1][1] != last[1]:
        out.append(last)
    return out


def count_double_back_segments(
    coords: Sequence[LngLat], min_segment_m: float = 25.0
) -> int:
    """
    Count how many segments reuse the same street in the opposite direction
    (walking down a road and later coming back the other way on it).

    Used for ranking: fewer double-backs usually means a nicer loop.
    """
    seen_direction: dict[str, int] = {}
    double_backs = 0

    for i in range(len(coords) - 1):
        a, b = coords[i], coords[i + 1]
        if approx_distance_meters(a, b) < min_segment_m:
            continue

        ax, ay = f"{a[0]:.6f}", f"{a[1]:.6f}"
        bx, by = f"{b[0]:.6f}", f"{b[1]:.6f}"
        forward = f"{ax},{ay}|{bx},{by}"
        reverse = f"{bx},{by}|{ax},{ay}"
        undirected = forward if forward < reverse else reverse
        direction = 1 if forward < reverse else -1

        prev = seen_direction.get(undirected)
        if prev is None:
            seen_direction[undirected] = direction
            continue
        if prev != direction:
            double_backs += 1

    return double_backs
