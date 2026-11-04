"""
HTTP routes for route generation.
"""

from __future__ import annotations

import httpx
from fastapi import APIRouter, HTTPException

from app.models.schemas import (
    GenerateRouteRequest,
    RouteCandidate,
    RouteSignalsRequest,
    RouteSignalsResponse,
)
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
