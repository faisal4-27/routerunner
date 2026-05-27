"""
Route Runner API — FastAPI entry point.

Run locally from the `backend` folder:

    uvicorn app.main:app --reload --port 8000

The frontend at http://127.0.0.1:3001 calls POST /generate-route.
"""

from __future__ import annotations

import os

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

from app.routers import routes

# Load backend/.env (OSRM URL, Overpass URL, CORS origins, etc.) before
# reading any environment-driven configuration below.
load_dotenv()


def _parse_cors_origins() -> list[str]:
    """
    Read `CORS_ORIGINS` from the environment as a comma-separated list.
    Falls back to the local dev frontend if the variable is missing.
    """
    raw = os.getenv("CORS_ORIGINS", "http://127.0.0.1:3001")
    origins = [origin.strip() for origin in raw.split(",") if origin.strip()]
    return origins or ["http://127.0.0.1:3001"]


app = FastAPI(
    title="Route Runner API",
    description="Generates and ranks pedestrian loop routes for the Route Runner app.",
    version="1.0.0",
)

# Allowed browser origins are configured via env so production domains can be
# added without editing source. `localhost` and `127.0.0.1` are different
# origins for CORS, so include both during local dev.
app.add_middleware(
    CORSMiddleware,
    allow_origins=_parse_cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class NoCacheMiddleware(BaseHTTPMiddleware):
    """
    Stamp every API response with `Cache-Control: no-store` so neither the
    browser nor any intermediate proxy ever caches generated routes.
    """

    async def dispatch(self, request: Request, call_next) -> Response:
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response


app.add_middleware(NoCacheMiddleware)

app.include_router(routes.router)


@app.get("/health")
async def health() -> dict[str, str]:
    """Liveness probe used by deployment platforms (Render, Fly, etc.)."""
    return {"status": "ok"}
