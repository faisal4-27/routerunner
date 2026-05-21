# Route Runner

A web app that generates running routes based on a selected location and distance, minimizing traffic signals encountered.

## Features
- Click anywhere on the map to set your starting point
- Select your desired distance
- Get a generated loop route
- See elevation data and traffic signal count

## Tech Stack
- HTML / CSS / JavaScript
- Leaflet.js
- OSRM API
- Overpass API
- OpenTopoData

## Getting Started

### One command (frontend + backend)

From the project root, install backend dependencies once:

```bash
pip install -r backend/requirements.txt
```

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
- [ ] React frontend
- [x] Python backend
- [x] Traffic signal minimization
- [ ] Elevation chart