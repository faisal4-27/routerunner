"""
Route Runner API — FastAPI entry point.

Run locally from the `backend` folder:

    uvicorn app.main:app --reload --port 8000

The frontend at http://127.0.0.1:3001 calls POST /generate-route.
"""

from __future__ import annotations

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import routes

# Load backend/.env (OSRM URL, Overpass URL, etc.)
load_dotenv()

app = FastAPI(
    title="Route Runner API",
    description="Generates and ranks pedestrian loop routes for the Route Runner app.",
    version="1.0.0",
)

# Allow the static frontend dev server to call this API from the browser.
# Include both hostname forms — `localhost` and `127.0.0.1` are different origins.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:3001",
        "http://localhost:3001",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(routes.router)


@app.get("/health")
async def health() -> dict[str, str]:
    """Simple check that the server is up."""
    return {"status": "ok"}
