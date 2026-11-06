"""
HTTP routes for route generation.
"""

from __future__ import annotations

import httpx
from fastapi import APIRouter, HTTPException

from app.models.schemas import (
    GenerateRouteRequest,
    RouteCandidate,
    RouteElevationRequest,
    RouteElevationResponse,
    RouteSignalsRequest,
    RouteSignalsResponse,
)
from app.services.elevation import fetch_elevations_along_route
from app.services.osrm import OsrmError
from app.services.overpass import OverpassUnavailable, count_traffic_signals
from app.services.route_generator import generate_route as generate_route_service

router = APIRouter(tags=["routes"])


@router.post("/generate-route", response_model=RouteCandidate)
async def generate_route_endpoint(body: GenerateRouteRequest) -> RouteCandidate:
    """
    Build a single smooth loop route from the start point and return it.
    """
    try:
        return await generate_route_service(body.lat, body.lng, body.distance_km)
    except OsrmError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Route generation failed: {exc}",
        ) from exc


@router.post("/route-elevation", response_model=RouteElevationResponse)
async def route_elevation_endpoint(body: RouteElevationRequest) -> RouteElevationResponse:
    """
    Elevation stats for a route's sample points — the client's FALLBACK.

    The browser normally calls Open-Meteo itself (its own per-IP quota); it
    only lands here if that fails. Server-side calls share Render's outbound
    IP quota with other customers, so this can fail too: 503 then, and the
    client shows "unavailable".
    """
    for point in body.coordinates:
        if len(point) < 2:
            raise HTTPException(status_code=422, detail="Each coordinate needs [lng, lat].")
    try:
        async with httpx.AsyncClient() as client:
            gain_m, max_climb_m, profile_m = await fetch_elevations_along_route(
                client, body.coordinates
            )
    except Exception as exc:  # noqa: BLE001 — quota, timeout, bad response
        raise HTTPException(status_code=503, detail=f"Elevation unavailable: {exc}") from exc
    if len(profile_m) < 2:
        raise HTTPException(status_code=503, detail="Elevation unavailable: no usable samples.")
    return RouteElevationResponse(
        elevation_gain_m=round(gain_m),
        max_climb_m=round(max_climb_m),
        elevation_profile=[round(e, 1) for e in profile_m],
    )


@router.post("/route-signals", response_model=RouteSignalsResponse)
async def route_signals_endpoint(body: RouteSignalsRequest) -> RouteSignalsResponse:
    """
    Count signal-controlled intersections along a route.

    Separate from /generate-route because the public Overpass server can be
    slow; the route is shown first and this fills in afterwards. Returns 503
    when Overpass can't answer, so the client can show "unavailable" rather
    than a misleading zero.
    """
    for point in body.coordinates:
        if len(point) < 2:
            raise HTTPException(status_code=422, detail="Each coordinate needs [lng, lat].")
    try:
        async with httpx.AsyncClient() as client:
            count = await count_traffic_signals(client, body.coordinates)
    except OverpassUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return RouteSignalsResponse(signal_count=count)
