Rewrite `route_generator.py` and `osrm.py` with the following logic:

**Core idea:**

* The start point sits **on the circumference** of a circle, not at the center  
* Place 4 additional waypoints evenly around the same circle (72° apart) so there are 5 total points all on the circumference including the start  
* The circle radius is calculated as: `radius = (distance_km * 1000) / (2 * π)`

**Route generation loop:**

1. Connect all 5 points in order using OSRM, each leg routed along real roads  
2. Each leg has a target of `total_distance / 5`  
3. After all 5 legs are built, calculate the total actual routed distance  
4. If the total is within 8% of the target distance, accept the route and move on  
5. If not, calculate the error (`target - actual`) and distribute it back across the 5 legs — but weight the correction by how far off each individual leg is from its own target. Legs that are more off get more of the correction, legs that are close get less.  
6. Repeat up to 6 iterations until within 8%

**Avoiding double backs — this is critical:**

* The single most important quality requirement is that the route never travels the same street in both directions  
* When placing waypoints around the circle, ensure they are spread far enough apart that OSRM is never tempted to route back through a previous leg to reach the next waypoint  
* After building the route, use `count_double_back_segments` from `geo.py` to check for double backs  
* If double backs are detected, rotate all waypoints by a random offset angle (e.g. 15-40°) and rebuild — do this up to 4 times before accepting the best result found  
* When calling OSRM, use `continue_straight=true` to discourage U-turns and backtracking

**After a good route is found:**

* Count traffic signals via Overpass  
* Fetch elevation via Open-Meteo  
* Return a single `RouteCandidate`

**Keep:**

* The OSRM `foot` profile  
* All existing imports and file structure  
* `fetch_osrm_route` in `osrm.py` for routing individual legs  
* Everything in `schemas.py`, `geo.py`, `routes.py`, `elevation.py`, `overpass.py` unchanged

I am preparing Route Runner for deployment and production. Address the following:

**Caching — eliminate completely (local and production):**

* Add `PYTHONDONTWRITEBYTECODE=1` to the `.env` file so Python never writes `__pycache__` folders anywhere  
* Set `PYTHONDONTWRITEBYTECODE=1` as an environment variable in `run.py` before uvicorn starts so it takes effect immediately without any manual setup  
* Delete any existing `__pycache__` folders and add `__pycache__/`, `*.pyc`, and `*.pyo` to `.gitignore` if not already there  
* In `app.js`, disable any browser-side caching by adding `cache: "no-store"` to the fetch call that hits the backend — this ensures the browser never caches route responses  
* Add a `Cache-Control: no-store` response header in `main.py` so the backend explicitly tells the browser and any intermediate proxies never to cache API responses

**Location permissions — production ready:**

* In `app.js`, confirm `enableHighAccuracy: false` is set — rough location is enough to centre the map and avoids triggering aggressive permission prompts on mobile  
* Add a clear comment in `app.js` explaining that location is never stored, never sent to our servers, and is only used once to centre the map on first load  
* Location must only be read once on page load — never re-requested silently in the background  
* If the user denies location permission, fall back gracefully to the default map centre with a friendly non-alarming status message like "Showing default map location — click anywhere to set your start point"

**Deployment prep:**

* Add a `CORS_ORIGINS` environment variable to `.env` so allowed origins can be configured without touching code — currently hardcoded to `127.0.0.1:3001`  
* In `main.py`, read `CORS_ORIGINS` from the environment and fall back to `http://127.0.0.1:3001` for local dev  
* Add a `PORT` environment variable to `.env` so the backend port is configurable for Render or any other deployment platform  
* In `run.py`, read `PORT` from the environment and fall back to `8000` for local dev  
* Add a `/health` endpoint to `main.py` that returns `{"status": "ok"}` — deployment platforms use this to verify the server is running

