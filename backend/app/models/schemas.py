"""
Pydantic models for API request and response bodies.

These describe the JSON shape the frontend sends and receives.
"""

from __future__ import annotations

from typing import List

from pydantic import BaseModel, Field


class GenerateRouteRequest(BaseModel):
    """Body for POST /generate-route."""

    lat: float = Field(..., description="Start latitude (degrees)")
    lng: float = Field(..., description="Start longitude (degrees)")
    distance_km: float = Field(
        ..., gt=0, le=50, description="Target loop length in kilometers"
    )


class RouteCandidate(BaseModel):
    """
    A single loop route returned to the client.

    `coordinates` is a GeoJSON LineString: list of [longitude, latitude] pairs.
    """

    coordinates: List[List[float]]
    distance_meters: float
    elevation_gain_m: float
    elevation_loss_m: float
    signal_count: int