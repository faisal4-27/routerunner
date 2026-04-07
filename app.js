/**
 * Route Runner — core behavior
 *
 * Flow (high level):
 * 1) User clicks the map → we remember lat/lng and show one draggable marker.
 * 2) User clicks "Generate route" → we invent several "goal" points in a ring around the start,
 *    ask OSRM's Trip service for a running loop that visits them and returns to the start,
 *    then draw the path, count nearby traffic lights (Overpass), and estimate elevation (Open-Meteo).
 */

(function () {
  "use strict";

  // --- Public OSRM demo server (no API key). For production you'd host your own OSRM. ---
  var OSRM_BASE = "https://router.project-osrm.org";
  /** `foot` = pedestrian routing; matches a typical running use case. */
  var OSRM_PROFILE = "foot";

  /** Overpass instance (community-run; be polite: one query per route, reasonable timeout). */
  var OVERPASS_URL = "https://overpass-api.de/api/interpreter";

  /**
   * Open-Meteo elevation API (CORS-friendly in the browser).
   * Docs: https://open-meteo.com/en/docs/elevation-api — up to 100 coordinates per request.
   */
  var OPEN_METEO_ELEVATION_URL = "https://api.open-meteo.com/v1/elevation";
  var OPEN_METEO_MAX_POINTS_PER_REQUEST = 100;

  /** How many "spokes" we place around your start (more = rounder loop, heavier OSRM work). */
  var NUM_CANDIDATE_WAYPOINTS = 7;

  /**
   * We shrink the ring radius a bit because real paths are longer than straight lines.
   * If routes are always too short vs the slider, nudge this up (e.g. 0.55).
   */
  var LOOP_RADIUS_FACTOR = 0.48;

  /** Search this many meters from sample points along the route when counting signals. */
  var SIGNAL_SEARCH_RADIUS_M = 35;

  /** Cap route vertices sent for elevation; batches use OPEN_METEO_MAX_POINTS_PER_REQUEST. */
  var ELEVATION_MAX_SAMPLES = 180;

  // --- Map setup (Leaflet creates a global `L`) ---
  var map = L.map("map").setView([48.137, 11.575], 12);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  // --- UI references ---
  var slider = document.getElementById("distance-slider");
  var distanceReadout = document.getElementById("distance-value");
  var generateBtn = document.getElementById("generate-btn");
  var routeStatsEl = document.getElementById("route-stats");
  var statDistance = document.getElementById("stat-distance");
  var statGain = document.getElementById("stat-elevation-gain");
  var statLoss = document.getElementById("stat-elevation-loss");
  var statSignals = document.getElementById("stat-signals");
  var statusMsg = document.getElementById("status-msg");

  // --- Mutable state for the current start point and drawn route ---
  /** @type {L.Marker|null} */
  var startMarker = null;
  /** @type {{ lat: number, lng: number }|null} */
  var startPoint = null;
  /** @type {L.GeoJSON|null} Last polyline layer so we can remove it before drawing a new route. */
  var routeLayer = null;

  // ---------------------------------------------------------------------------
  // Small helpers (formatting, geometry, sampling)
  // ---------------------------------------------------------------------------

  function formatKm(value) {
    var n = parseFloat(value);
    return (Math.round(n * 10) / 10).toString().replace(/\.0$/, "") + " km";
  }

  function syncDistanceLabel() {
    distanceReadout.textContent = formatKm(slider.value);
  }

  function setStatus(text, isError) {
    statusMsg.textContent = text || "";
    statusMsg.classList.toggle("error", Boolean(isError));
  }

  /**
   * Move a lat/lng point `distanceMeters` forward along a compass bearing.
   * Uses a spherical Earth approximation — good enough for a few kilometers.
   */
  function offsetLatLng(lat, lng, distanceMeters, bearingDeg) {
    var R = 6371000;
    var brng = (bearingDeg * Math.PI) / 180;
    var lat1 = (lat * Math.PI) / 180;
    var lon1 = (lng * Math.PI) / 180;
    var angDist = distanceMeters / R;

    var lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(angDist) +
        Math.cos(lat1) * Math.sin(angDist) * Math.cos(brng)
    );
    var lon2 =
      lon1 +
      Math.atan2(
        Math.sin(brng) * Math.sin(angDist) * Math.cos(lat1),
        Math.cos(angDist) - Math.sin(lat1) * Math.sin(lat2)
      );

    return { lat: (lat2 * 180) / Math.PI, lng: (lon2 * 180) / Math.PI };
  }

  /**
   * Evenly space bearings around the compass rose (0°, 51°, …) so waypoints form a ring.
   */
  function buildRingWaypoints(centerLat, centerLng, targetDistanceKm) {
    var targetMeters = targetDistanceKm * 1000;
    // Circumference ≈ 2πr; we want a rough loop length near `targetMeters`.
    var radiusMeters = (targetMeters / (2 * Math.PI)) * LOOP_RADIUS_FACTOR;

    var list = [];
    for (var i = 0; i < NUM_CANDIDATE_WAYPOINTS; i++) {
      var bearing = (360 / NUM_CANDIDATE_WAYPOINTS) * i;
      list.push(offsetLatLng(centerLat, centerLng, radiusMeters, bearing));
    }
    return list;
  }

  /**
   * OSRM wants coordinates in the path as `lon,lat;lon,lat` (note the order vs Leaflet!).
   */
  function toOsrmCoord(lat, lng) {
    return lng + "," + lat;
  }

  /**
   * Take every Nth vertex so Overpass / elevation API requests stay small.
   * Always keep the first and last points so we do not clip the route ends.
   */
  function sampleLineCoords(coordsLngLat, maxPoints) {
    if (coordsLngLat.length <= maxPoints) {
      return coordsLngLat.slice();
    }
    var step = Math.ceil(coordsLngLat.length / maxPoints);
    var out = [];
    var i;
    for (i = 0; i < coordsLngLat.length - 1; i += step) {
      out.push(coordsLngLat[i]);
    }
    var last = coordsLngLat[coordsLngLat.length - 1];
    var prev = out[out.length - 1];
    if (!prev || prev[0] !== last[0] || prev[1] !== last[1]) {
      out.push(last);
    }
    return out;
  }

  function formatDistanceM(meters) {
    if (meters >= 1000) {
      return (meters / 1000).toFixed(2) + " km";
    }
    return Math.round(meters) + " m";
  }

  function formatElevationM(m) {
    return Math.round(m) + " m";
  }

  // ---------------------------------------------------------------------------
  // OSRM Trip: build a loop through the ring waypoints and back to the start
  // ---------------------------------------------------------------------------

  /**
   * Calls OSRM Trip. With default `roundtrip=true`, the route leaves the first coordinate,
   * visits the others in a good order, then returns to the first coordinate.
   */
  function fetchOsrmTrip(startLat, startLng, waypointsLatLng) {
    var parts = [toOsrmCoord(startLat, startLng)];
    for (var i = 0; i < waypointsLatLng.length; i++) {
      var w = waypointsLatLng[i];
      parts.push(toOsrmCoord(w.lat, w.lng));
    }
    var coordPath = parts.join(";");

    var params = new URLSearchParams({
      roundtrip: "true",
      geometries: "geojson",
      overview: "full",
      steps: "false",
    });

    var url = OSRM_BASE + "/trip/v1/" + OSRM_PROFILE + "/" + coordPath + "?" + params.toString();
    return fetch(url).then(function (res) {
      if (!res.ok) {
        throw new Error("OSRM HTTP " + res.status);
      }
      return res.json();
    });
  }

  // ---------------------------------------------------------------------------
  // Overpass: count distinct traffic_signals nodes near the route
  // ---------------------------------------------------------------------------

  /**
   * We build one query that ORs many `around:` clauses — each clause asks for signals
   * near one sample point. Circles overlap, so we dedupe by OSM id afterward.
   */
  function buildOverpassSignalQuery(coordsLngLat) {
    var samples = sampleLineCoords(coordsLngLat, 45);
    var lines = [];
    for (var i = 0; i < samples.length; i++) {
      var lng = samples[i][0];
      var lat = samples[i][1];
      lines.push(
        '  node["highway"="traffic_signals"](around:' +
          SIGNAL_SEARCH_RADIUS_M +
          "," +
          lat +
          "," +
          lng +
          ");"
      );
    }
    return (
      "[out:json][timeout:25];\n" +
      "(\n" +
      lines.join("\n") +
      "\n);\n" +
      "out;"
    );
  }

  function countTrafficSignals(coordsLngLat) {
    var query = buildOverpassSignalQuery(coordsLngLat);
    return fetch(OVERPASS_URL, {
      method: "POST",
      body: query,
    })
      .then(function (res) {
        if (!res.ok) {
          throw new Error("Overpass HTTP " + res.status);
        }
        return res.json();
      })
      .then(function (data) {
        var ids = {};
        var elements = data.elements || [];
        for (var i = 0; i < elements.length; i++) {
          var el = elements[i];
          if (el.type === "node" && el.id != null) {
            ids[el.id] = true;
          }
        }
        var count = 0;
        for (var k in ids) {
          if (Object.prototype.hasOwnProperty.call(ids, k)) {
            count++;
          }
        }
        return count;
      });
  }

  // ---------------------------------------------------------------------------
  // Open-Meteo elevation: sample along the route, then gain / loss
  // ---------------------------------------------------------------------------

  function elevationGainLoss(elevations) {
    var gain = 0;
    var loss = 0;
    for (var i = 1; i < elevations.length; i++) {
      var d = elevations[i] - elevations[i - 1];
      if (d > 0) {
        gain += d;
      } else {
        loss += -d;
      }
    }
    return { gain: gain, loss: loss };
  }

  /**
   * One Open-Meteo request: comma-separated latitude= and longitude= arrays (same length, same order).
   * Example: .../elevation?latitude=52.52,48.85&longitude=13.41,2.35
   */
  function fetchElevationsBatch(coordsLngLat) {
    var lats = [];
    var lngs = [];
    for (var i = 0; i < coordsLngLat.length; i++) {
      lngs.push(coordsLngLat[i][0]);
      lats.push(coordsLngLat[i][1]);
    }
    var params = new URLSearchParams({
      latitude: lats.join(","),
      longitude: lngs.join(","),
    });
    var url = OPEN_METEO_ELEVATION_URL + "?" + params.toString();

    return fetch(url).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok || data.error) {
          throw new Error(
            data.reason || "Open-Meteo elevation HTTP " + res.status
          );
        }
        if (!Array.isArray(data.elevation)) {
          throw new Error("Unexpected Open-Meteo elevation response.");
        }
        return data;
      });
    });
  }

  /**
   * Splits the sampled coordinates into batches, fetches them, concatenates elevations.
   */
  function fetchElevationsAlongRoute(coordsLngLat) {
    var sampled = sampleLineCoords(coordsLngLat, ELEVATION_MAX_SAMPLES);
    var batches = [];
    for (
      var i = 0;
      i < sampled.length;
      i += OPEN_METEO_MAX_POINTS_PER_REQUEST
    ) {
      batches.push(
        sampled.slice(i, i + OPEN_METEO_MAX_POINTS_PER_REQUEST)
      );
    }

    var chain = Promise.resolve([]);
    for (var b = 0; b < batches.length; b++) {
      (function (batch) {
        chain = chain.then(function (acc) {
          return fetchElevationsBatch(batch).then(function (data) {
            var elev = data.elevation || [];
            var nums = [];
            for (var j = 0; j < elev.length; j++) {
              var e = elev[j];
              nums.push(typeof e === "number" && !isNaN(e) ? e : null);
            }
            return acc.concat(nums);
          });
        });
      })(batches[b]);
    }

    return chain.then(function (elevationSeries) {
      var cleaned = [];
      for (var k = 0; k < elevationSeries.length; k++) {
        if (elevationSeries[k] != null) {
          cleaned.push(elevationSeries[k]);
        }
      }
      if (cleaned.length < 2) {
        return { gain: 0, loss: 0, usable: false };
      }
      var gl = elevationGainLoss(cleaned);
      gl.usable = true;
      return gl;
    });
  }

  // ---------------------------------------------------------------------------
  // Drawing + panel updates
  // ---------------------------------------------------------------------------

  function drawRoute(geojsonLineString) {
    if (routeLayer) {
      map.removeLayer(routeLayer);
      routeLayer = null;
    }
    routeLayer = L.geoJSON(
      {
        type: "Feature",
        geometry: geojsonLineString,
        properties: {},
      },
      {
        style: {
          color: "#0d47a1",
          weight: 5,
          opacity: 0.88,
        },
      }
    ).addTo(map);

    try {
      map.fitBounds(routeLayer.getBounds(), { padding: [36, 36], maxZoom: 16 });
    } catch (e) {
      /* ignore fitBounds errors on degenerate geometry */
    }
  }

  function showRouteStats(distanceMeters, gainLoss, signalDisplay) {
    statDistance.textContent = formatDistanceM(distanceMeters);
    if (gainLoss.usable) {
      statGain.textContent = formatElevationM(gainLoss.gain);
      statLoss.textContent = formatElevationM(gainLoss.loss);
    } else {
      statGain.textContent = "—";
      statLoss.textContent = "—";
    }
    statSignals.textContent =
      signalDisplay === null || signalDisplay === undefined
        ? "—"
        : String(signalDisplay);
    routeStatsEl.hidden = false;
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  map.on("click", function (ev) {
    var ll = ev.latlng;
    startPoint = { lat: ll.lat, lng: ll.lng };

    if (!startMarker) {
      // First click: create the marker. `addTo(map)` puts it on the map layer.
      startMarker = L.marker(ll).addTo(map);
    } else {
      // Later clicks: reuse the same marker object so only one exists.
      startMarker.setLatLng(ll);
    }

    setStatus("Start point set. Adjust distance if you like, then generate.");
  });

  slider.addEventListener("input", syncDistanceLabel);
  syncDistanceLabel();

  generateBtn.addEventListener("click", function () {
    if (!startPoint) {
      setStatus("Click the map first to choose your start point.", true);
      return;
    }

    var targetKm = parseFloat(slider.value);
    if (isNaN(targetKm) || targetKm <= 0) {
      setStatus("Pick a positive distance on the slider.", true);
      return;
    }

    setStatus("Building route…");
    generateBtn.disabled = true;

    var ring = buildRingWaypoints(startPoint.lat, startPoint.lng, targetKm);

    fetchOsrmTrip(startPoint.lat, startPoint.lng, ring)
      .then(function (data) {
        if (data.code !== "Ok" || !data.trips || !data.trips.length) {
          throw new Error(
            data.message || "OSRM could not build a trip for these points."
          );
        }
        var trip = data.trips[0];
        if (!trip.geometry || trip.geometry.type !== "LineString") {
          throw new Error("Unexpected geometry from OSRM.");
        }

        drawRoute(trip.geometry);

        var coords = trip.geometry.coordinates;
        var distanceMeters = trip.distance;

        return Promise.all([
          Promise.resolve(distanceMeters),
          countTrafficSignals(coords).catch(function (err) {
            console.warn("Overpass:", err);
            return null;
          }),
          fetchElevationsAlongRoute(coords).catch(function (err) {
            console.warn("Open-Meteo elevation:", err);
            return { gain: 0, loss: 0, usable: false };
          }),
        ]);
      })
      .then(function (results) {
        var distanceMeters = results[0];
        var signalCount = results[1];
        var gainLoss = results[2];

        if (signalCount == null) {
          setStatus(
            "Route ready, but traffic signal lookup failed (network or Overpass busy).",
            false
          );
        } else {
          setStatus("Route ready.");
        }

        showRouteStats(distanceMeters, gainLoss, signalCount);
      })
      .catch(function (err) {
        console.error(err);
        setStatus(err.message || "Something went wrong building the route.", true);
        routeStatsEl.hidden = true;
        if (routeLayer) {
          map.removeLayer(routeLayer);
          routeLayer = null;
        }
      })
      .finally(function () {
        generateBtn.disabled = false;
      });
  });
})();
