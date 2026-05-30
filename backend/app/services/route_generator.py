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
   leg was, and rebuild. Up to a few distance iterations per layout.
5. Run several circle orientations *in parallel* (each its own asyncio task)
   instead of one-after-another, so the wall-clock cost is roughly a single
   layout's latency rather than the sum of all of them. Each layout fetches
   its polyline once. We then rank every finished layout with a weighted
   score — distance accuracy counts for 50 %, short U-turns 25 %, and
   double-backs 25 % — and keep the best. A perfectly in-tolerance, clean
   loop still wins outright and is returned as soon as the layouts resolve.
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

# How many circle orientations to try. They run concurrently and the best
# (or first flawless) layout wins, so this trades a few parallel OSRM calls
# for better odds of a clean, on-distance loop without adding wall-clock time.
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


# Soft caps used to normalise the raw penalties onto a comparable 0–1 scale
# before they're combined. A route 50 %+ off target, or with 4+ short U-turns
# / double-backs, already pegs its component at the maximum penalty.
DIST_ERROR_CAP_FRAC = 0.5
UTURN_CAP = 4.0
DOUBLE_BACK_CAP = 4.0

# Part-B ranking weights. Distance accuracy dominates (50 %), with the two
# geometry-quality penalties splitting the rest evenly (25 % each).
WEIGHT_DISTANCE = 0.5
WEIGHT_UTURN = 0.25
WEIGHT_DOUBLE_BACK = 0.25


def _candidate_score(
    total_m: float,
    target_m: float,
    short_uturns: int,
    double_backs: int,
) -> float:
    """
    Weighted quality score for a finished layout — lower is better.

    Each of the three raw penalties is normalised to roughly 0–1 so the
    weights mean what they say:

    * distance accuracy — relative error vs. target, capped at 50 % off (50 %)
    * short U-turns — count, capped at 4 (25 %)
    * double-backs — count, capped at 4 (25 %)
    """
    rel_error = abs(target_m - total_m) / target_m if target_m else 1.0
    dist_penalty = min(1.0, rel_error / DIST_ERROR_CAP_FRAC)
    uturn_penalty = min(1.0, short_uturns / UTURN_CAP)
    double_back_penalty = min(1.0, double_backs / DOUBLE_BACK_CAP)

    return (
        WEIGHT_DISTANCE * dist_penalty
        + WEIGHT_UTURN * uturn_penalty
        + WEIGHT_DOUBLE_BACK * double_back_penalty
    )


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


class _Candidate(dict):
    """A finished layout: coords, total_m, geometry penalties, and score."""


async def _run_attempt(
    client: httpx.AsyncClient,
    lat: float,
    lng: float,
    base_radius_m: float,
    rotation_deg: float,
    target_m: float,
    tolerance_m: float,
) -> Tuple[_Candidate | None, Exception | None]:
    """
    Tune one circle orientation to the target distance and score the result.

    Runs the inner distance-tuning loop (cheap overview=false calls), fetches
    the polyline once for the layout it settles on, then computes the weighted
    quality score. Returns (candidate, None) on success or (None, error) if
    OSRM never produced a usable layout — the caller decides what to do with a
    batch of these results.

    `base_radius_m` is taken by value, so each parallel attempt owns its radius
    and a transient OSRM failure in one orientation can't bloat the others.
    """
    scales = [1.0] * NUM_POINTS
    radius_m = base_radius_m
    chosen_points: List[Tuple[float, float]] | None = None
    last_error: Exception | None = None

    # Tuning loop: ask OSRM for distances only (overview=false) — the payload
    # is dramatically smaller than the polyline version, so iteration is much
    # faster. Geometry is fetched once at the end.
    for _ in range(DISTANCE_ITERATIONS):
        points = _build_waypoints(lat, lng, radius_m, rotation_deg, scales)

        try:
            result = await fetch_osrm_route_through_points(
                client, _closed_loop(points), want_geometry=False
            )
        except OsrmError as exc:
            # Transient OSRM trouble — widen the circle and try again.
            last_error = exc
            radius_m *= 1.1
            continue

        leg_distances = result["leg_distances"]
        total_m = result["total_distance"]
        chosen_points = points

        if abs(target_m - total_m) <= tolerance_m:
            break

        scales = _adjust_scales(scales, leg_distances, target_m)

    if chosen_points is None:
        return None, last_error

    # One geometry fetch for the layout we settled on.
    try:
        final_result = await fetch_osrm_route_through_points(
            client, _closed_loop(chosen_points), want_geometry=True
        )
    except OsrmError as exc:
        return None, exc

    coords = final_result["coordinates"] or []
    total_m = final_result["total_distance"]
    short_uturns = count_short_uturns(coords, SHORT_STREET_M)
    double_backs = count_double_back_segments(coords)

    candidate = _Candidate(
        coords=coords,
        total_m=total_m,
        short_uturns=short_uturns,
        double_backs=double_backs,
        in_tolerance=abs(target_m - total_m) <= tolerance_m,
        score=_candidate_score(total_m, target_m, short_uturns, double_backs),
    )
    return candidate, None


async def generate_route(
    lat: float, lng: float, distance_km: float
) -> RouteCandidate:
    """
    Build one loop close to `distance_km` and return it enriched with stats.

    All ROTATION_ATTEMPTS circle orientations run concurrently, so the
    wall-clock cost is roughly one layout's latency instead of the sum of
    them. A flawless loop (in tolerance, no short U-turn, no double-back)
    wins outright; otherwise the layouts are ranked by a weighted score that
    is 50 % distance accuracy, 25 % short U-turns, and 25 % double-backs, and
    the best one is returned.
    """
    target_m = distance_km * 1000.0
    base_radius_m = target_m / (2.0 * math.pi)
    tolerance_m = max(150.0, target_m * DISTANCE_TOLERANCE_FRAC)

    # Spread the orientations evenly around the circle with a random phase, so
    # repeated clicks on the same start don't reproduce an identical loop and
    # the parallel attempts explore genuinely different layouts.
    phase = random.uniform(0.0, 360.0)
    step = 360.0 / ROTATION_ATTEMPTS
    rotations = [
        (phase + i * step + random.uniform(-10.0, 10.0)) % 360.0
        for i in range(ROTATION_ATTEMPTS)
    ]

    async with httpx.AsyncClient() as client:
        results = await asyncio.gather(
            *(
                _run_attempt(
                    client, lat, lng, base_radius_m, rot, target_m, tolerance_m
                )
                for rot in rotations
            )
        )

        candidates = [c for c, _ in results if c is not None]
        last_error = next((e for _, e in results if e is not None), None)

        if not candidates:
            raise last_error or OsrmError(
                "Could not generate a route close enough to the target "
                "distance. Try a different start point or distance."
            )

        # A flawless loop wins regardless of score; among several, take the
        # one with the best (lowest) weighted score.
        flawless = [
            c
            for c in candidates
            if c["in_tolerance"]
            and c["short_uturns"] == 0
            and c["double_backs"] == 0
        ]
        pool = flawless or candidates
        best = min(pool, key=lambda c: c["score"])

        return await _enrich(client, best["coords"], best["total_m"])
