"""
Generates a single running loop close to the user's target distance.

How it works:
1. Place the start point on the circumference of a circle whose
   circumference equals the requested distance.
2. Place 4 additional waypoints at 72° intervals around the same circle so
   all 5 points sit on the circumference.
3. Route through all 5 points + back to start in a single OSRM call (foot
   profile, continue_straight=true). Tuning iterations use overview=false
   so OSRM doesn't have to serialize the polyline every time.
4. Compare the total routed distance against the target; if it's outside
   ±8 %, push each waypoint inward or outward, weighted by how off its own
   leg was, and rebuild. Up to 6 distance iterations per layout.
5. Fetch the polyline once for the layout we settle on. If it reuses any
   streets in both directions, rotate the whole circle by a random 15–40°
   and rebuild. Up to 4 layouts in total, keeping the cleanest result we saw.
6. Enrich the chosen route with traffic-signal and elevation data in parallel.
"""

from __future__ import annotations

import asyncio
import math
import random
from typing import List, Sequence, Tuple

import httpx

from app.models.schemas import RouteCandidate
from app.services.elevation import fetch_elevations_along_route
from app.services.osrm import OsrmError, fetch_osrm_route_through_points
from app.services.overpass import count_traffic_signals
from app.utils.geo import (
    LngLat,
    count_double_back_segments,
    count_short_uturns,
    offset_lat_lng,
)

# A "short" street for U-turn purposes — the user explicitly does not want
# any out-and-back on a street shorter than this.
SHORT_STREET_M = 100.0

# 5 evenly-spaced points around the circle (start + 4 others, 72° apart).
NUM_POINTS = 5
ANGLE_STEP_DEG = 360.0 / NUM_POINTS

# How many times to nudge waypoints in/out chasing the target distance.
# In practice routes converge within 2–3 tries; 4 is plenty of headroom and
# noticeably faster than the 6-iteration default when convergence drags.
DISTANCE_ITERATIONS = 4

# How many times to rotate the whole circle when fighting double-backs.
ROTATION_ATTEMPTS = 4

# Accept any route whose total length is within this fraction of the target.
DISTANCE_TOLERANCE_FRAC = 0.08

# Clamp per-waypoint radius scales so a runaway iteration cannot fold the
# circle inside out.
MIN_SCALE = 0.55
MAX_SCALE = 1.75


def _build_waypoints(
    start_lat: float,
    start_lng: float,
    radius_m: float,
    rotation_deg: float,
    scales: Sequence[float],
) -> List[Tuple[float, float]]:
    """
    Return 5 (lat, lng) points placed on a circle that passes through the start.

    The circle's centre sits `radius_m` from the start at compass bearing
    `rotation_deg`; the start itself is the point diametrically opposite the
    centre. The other 4 waypoints are spaced 72° apart around the centre, in
    order, so the polyline walks the circle without crossing itself.

    `scales[i]` lets the iterative refinement push or pull waypoint i along
    its own radial direction from the centre. The start (index 0) is always
    held exactly at the user-supplied coordinate.
    """
    centre_lat, centre_lng = offset_lat_lng(
        start_lat, start_lng, radius_m, rotation_deg
    )
    start_angle = (rotation_deg + 180.0) % 360.0

    points: List[Tuple[float, float]] = [(start_lat, start_lng)]
    for i in range(1, NUM_POINTS):
        angle = (start_angle + ANGLE_STEP_DEG * i) % 360.0
        radius_for_point = radius_m * scales[i]
        wlat, wlng = offset_lat_lng(centre_lat, centre_lng, radius_for_point, angle)
        points.append((wlat, wlng))
    return points


def _closed_loop(points: Sequence[Tuple[float, float]]) -> List[Tuple[float, float]]:
    """Append the first point to the end so OSRM routes back to the start."""
    return list(points) + [points[0]]


def _adjust_scales(
    scales: Sequence[float],
    leg_distances: Sequence[float],
    target_total_m: float,
) -> List[float]:
    """
    Push the per-waypoint radius scales toward the target distance.

    The total error (target − actual) is split across the 5 legs, weighted by
    how far off each individual leg is from its share of the target. Legs that
    are way off get most of the correction; legs that are close are barely
    touched. The start waypoint is fixed, so any correction destined for it is
    redirected to its neighbour.
    """
    target_per_leg = target_total_m / NUM_POINTS
    leg_errors = [target_per_leg - d for d in leg_distances]
    total_error = target_total_m - sum(leg_distances)
    sum_abs_err = sum(abs(e) for e in leg_errors) or 1.0

    # Half-step damping keeps the search stable across 6 iterations.
    deltas = [0.0] * NUM_POINTS
    for i in range(NUM_POINTS):
        share = abs(leg_errors[i]) / sum_abs_err
        leg_correction_m = share * total_error
        # Translate a metres correction into a relative radius change.
        scale_delta = (leg_correction_m / target_per_leg) * 0.5

        a = i
        b = (i + 1) % NUM_POINTS
        if a == 0:
            deltas[b] += scale_delta
        elif b == 0:
            deltas[a] += scale_delta
        else:
            deltas[a] += scale_delta / 2.0
            deltas[b] += scale_delta / 2.0

    new_scales = list(scales)
    for i in range(1, NUM_POINTS):
        new_scales[i] = max(MIN_SCALE, min(MAX_SCALE, new_scales[i] + deltas[i]))
    return new_scales


async def _enrich(
    client: httpx.AsyncClient,
    coords: List[LngLat],
    distance_meters: float,
) -> RouteCandidate:
    """
    Attach signal count and elevation stats to a finished route.

    Overpass (signals) and Open-Meteo (elevation) are independent third-party
    calls, so we fire them in parallel. A flaky Overpass response just yields
    a 0 signal count rather than killing the whole request.
    """

    async def _signals() -> int:
        try:
            return await count_traffic_signals(client, coords)
        except Exception:
            return 0

    signal_count, (gain_m, max_climb_m) = await asyncio.gather(
        _signals(),
        fetch_elevations_along_route(client, coords),
    )

    return RouteCandidate(
        coordinates=coords,
        distance_meters=distance_meters,
        elevation_gain_m=round(gain_m),
        max_climb_m=round(max_climb_m),
        signal_count=signal_count,
    )


async def generate_route(
    lat: float, lng: float, distance_km: float
) -> RouteCandidate:
    """
    Build one loop close to `distance_km` and return it enriched with stats.

    The function tries up to ROTATION_ATTEMPTS different circle orientations.
    Each orientation runs an inner distance-tuning loop. If we ever find an
    in-tolerance, zero-double-back loop we return immediately; otherwise we
    return the loop with the fewest double-backs we saw along the way.
    """
    target_m = distance_km * 1000.0
    base_radius_m = target_m / (2.0 * math.pi)
    tolerance_m = max(150.0, target_m * DISTANCE_TOLERANCE_FRAC)

    # Quality score is (short_uturns, double_backs) — strictly less is
    # better, so any route with a short U-turn loses to one without.
    best_coords: List[LngLat] | None = None
    best_total_m = 0.0
    best_score: Tuple[int, int] = (10**9, 10**9)
    last_error: Exception | None = None
    # Random initial rotation so repeated clicks on the same start point
    # don't keep producing the identical loop (and identical elevation /
    # signal stats). Each retry then adds a chunky 15–40° offset on top.
    rotation_deg = random.uniform(0.0, 360.0)

    async with httpx.AsyncClient() as client:
        for _ in range(ROTATION_ATTEMPTS):
            scales = [1.0] * NUM_POINTS
            chosen_points: List[Tuple[float, float]] | None = None

            # Tuning loop: ask OSRM for distances only (overview=false) — the
            # payload is dramatically smaller than the polyline version, so
            # iteration is much faster. Geometry is fetched once at the end.
            for _ in range(DISTANCE_ITERATIONS):
                points = _build_waypoints(
                    lat, lng, base_radius_m, rotation_deg, scales
                )

                try:
                    result = await fetch_osrm_route_through_points(
                        client, _closed_loop(points), want_geometry=False
                    )
                except OsrmError as exc:
                    # Transient OSRM trouble — widen the circle and try again.
                    last_error = exc
                    base_radius_m *= 1.1
                    continue

                leg_distances = result["leg_distances"]
                total_m = result["total_distance"]
                chosen_points = points

                if abs(target_m - total_m) <= tolerance_m:
                    break

                scales = _adjust_scales(scales, leg_distances, target_m)

            if chosen_points is not None:
                # One geometry fetch for the layout we settled on.
                try:
                    final_result = await fetch_osrm_route_through_points(
                        client, _closed_loop(chosen_points), want_geometry=True
                    )
                except OsrmError as exc:
                    last_error = exc
                    rotation_deg = (
                        rotation_deg + random.uniform(15.0, 40.0)
                    ) % 360.0
                    continue

                coords = final_result["coordinates"] or []
                total_m = final_result["total_distance"]
                short_uturns = count_short_uturns(coords, SHORT_STREET_M)
                double_backs = count_double_back_segments(coords)
                score = (short_uturns, double_backs)

                # Perfect run: in distance, no short U-turn, no double-back.
                if (
                    abs(target_m - total_m) <= tolerance_m
                    and short_uturns == 0
                    and double_backs == 0
                ):
                    return await _enrich(client, coords, total_m)

                if score < best_score:
                    best_coords = coords
                    best_total_m = total_m
                    best_score = score

            # Rotate the whole circle by a chunky random offset and try again.
            rotation_deg = (rotation_deg + random.uniform(15.0, 40.0)) % 360.0

        if best_coords is not None:
            return await _enrich(client, best_coords, best_total_m)

    raise last_error or OsrmError(
        "Could not generate a route close enough to the target distance. "
        "Try a different start point or distance."
    )
