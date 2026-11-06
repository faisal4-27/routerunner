"""
Pydantic models for API request and response bodies.

These describe the JSON shape the frontend sends and receives.
"""

from __future__ import annotations

from typing import List, Optional

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

    `max_climb_m` is the largest contiguous low-to-high elevation change
    anywhere along the loop — i.e. the toughest single climb the runner
    will face. It replaces an "elevation loss" field that, for any closed
    loop, mathematically had to equal the gain.

    Elevation is NOT looked up by /generate-route: the browser fetches it
    from Open-Meteo itself (each user's own IP quota, instead of the shared
    Render IP), using `elevation_samples`, and falls back to POST
    /route-elevation. The elevation fields here stay None / empty.
    """

    coordinates: List[List[float]]
    distance_meters: float
    elevation_gain_m: Optional[float] = None
    max_climb_m: Optional[float] = None
    # Filled in by POST /route-signals, not by /generate-route, so this is
    # None here. Kept for response-shape compatibility.
    signal_count: Optional[int] = None
    # Elevation samples (metres) evenly spaced along the loop, in route order.
    # Empty when elevation lookup failed; drives the frontend's chart.
    elevation_profile: List[float] = Field(default_factory=list)
    # Evenly spaced [lng, lat] points along the loop (≤ 96) for the client's
    # elevation lookup — one Open-Meteo request's worth.
    elevation_samples: List[List[float]] = Field(default_factory=list)


class RouteElevationRequest(BaseModel):
    """Body for POST /route-elevation: sampled [lng, lat] points in route order."""

    coordinates: List[List[float]] = Field(..., min_length=2, max_length=100)


class RouteElevationResponse(BaseModel):
    """Elevation stats for a route; same meaning as on RouteCandidate."""

    elevation_gain_m: float
    max_climb_m: float
    elevation_profile: List[float]


class RouteSignalsRequest(BaseModel):
    """Body for POST /route-signals: the route line from /generate-route."""

    coordinates: List[List[float]] = Field(
        ..., min_length=2, max_length=20000,
        description="GeoJSON LineString coordinates: [longitude, latitude] pairs",
    )


class RouteSignalsResponse(BaseModel):
    """Signal-controlled intersections (nearby signal nodes grouped) along the route."""

    signal_count: int