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


def count_short_uturns(
    coords: Sequence[LngLat],
    max_street_m: float = 100.0,
    return_radius_m: float = 12.0,
) -> int:
    """
    Count up-and-back U-turns on streets shorter than `max_street_m`.

    These are the worst kind of double-back from a runner's point of view:
    the route goes a short distance up a street (often a cul-de-sac OSRM
    used to pad the distance) and immediately comes back the same way.

    For every vertex i we walk forward along the polyline until the
    accumulated path length passes `2 × max_street_m`. If, before that
    happens, we land within `return_radius_m` of the starting vertex, we
    count one U-turn and skip past it so a single zig-zag isn't double-
    counted.

    Designed to be cheap: the inner walk is bounded by path length, not
    polyline length, so it's effectively O(n) on real route data.
    """
    n = len(coords)
    if n < 3:
        return 0

    walk_budget_m = 2.0 * max_street_m
    count = 0
    i = 0

    while i < n - 2:
        path_len = 0.0
        hit_index = -1

        for j in range(i + 1, n):
            path_len += approx_distance_meters(coords[j - 1], coords[j])
            if path_len > walk_budget_m:
                break
            # Need at least one real step out before "returning" counts —
            # otherwise tiny zig-zags within OSRM's geometry trigger false
            # positives.
            if path_len < return_radius_m * 2:
                continue
            if approx_distance_meters(coords[i], coords[j]) < return_radius_m:
                hit_index = j
                break

        if hit_index == -1:
            i += 1
        else:
            count += 1
            i = hit_index + 1

    return count


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
