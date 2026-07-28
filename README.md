# Route Runner

A web app that generates running routes based on a selected location and distance, minimizing traffic signals encountered.

## Features
- Search for an address, street, or city to set your starting point
- Or click anywhere on the map to set it manually
- Select your desired distance
- Get a generated loop route
- See elevation data and traffic signal count

## Tech Stack
- HTML / CSS / JavaScript
- Leaflet.js
- OSRM (routing)
- Photon (location search)
- Overpass API (traffic signal lookup)
- Open-Meteo (elevation)
- FastAPI + httpx (Python backend)

## Getting Started

### One command (frontend + backend)

From the project root, install backend dependencies once:

```bash
pip install -r backend/requirements.txt
```

Copy the example env file so the backend can read it:

```bash
cp backend/.env.example backend/.env
```

The defaults point at public OSRM / Overpass / Open-Meteo endpoints and work
out of the box. Edit `backend/.env` to swap in your own endpoints or set the
allowed CORS origins for your deployed frontend.

Then start everything:

```bash
python run.py
```

Open **http://127.0.0.1:3001** in your browser. Press **Ctrl+C** in the terminal to stop both servers.

### Run separately (optional)

**Backend** (from `backend/`):

```bash
cd backend
uvicorn app.main:app --reload --port 8000
```

**Frontend** (from project root, port 3001 matches CORS in the API):

```bash
python -m http.server 3001 --bind 127.0.0.1
```

## Roadmap
- [x] Python backend
- [x] Traffic signal minimization
- [x] Elevation gain + biggest climb
- [ ] React frontend
- [ ] Elevation chart