"""
HTTP routes for route generation.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.models.schemas import GenerateRouteRequest, RouteCandidate
from app.services.osrm import OsrmError
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