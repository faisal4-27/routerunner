/**
 * Route Runner — frontend logic
 *
 * Flow:
 * 1) On load, try to get the user's location and drop a marker there.
 * 2) User can click anywhere on the map to move the start marker.
 * 3) User picks a distance on the slider and clicks Generate.
 * 4) One POST to the FastAPI backend → draws the returned loop + stats.
 */

(function () {
  "use strict";

  // Points to the local FastAPI backend. Uses the same hostname as the page
  // so the browser treats it as a same-host cross-port request (valid CORS).
  var API_GENERATE_ROUTE =
    window.location.protocol +
    "//" +
    window.location.hostname +
    ":8000/generate-route";

  // Visual constants
  var DIRECTION_ARROW_MIN_TURN_DEG = 20;
  var DIRECTION_ARROW_MIN_SEGMENT_M = 25;
  var OVERLAP_OFFSET_METERS = 4;
  var ROUTE_HIGHLIGHT_METERS = 100;

  // ---------------------------------------------------------------------------
  // Map setup
  // ---------------------------------------------------------------------------

  var DEFAULT_CENTER = { lat: 43.4723, lng: -80.5449 }; // University of Waterloo fallback
  var DEFAULT_ZOOM = 12;
  var USER_LOCATION_ZOOM = 14;

  var map = L.map("map").setView([DEFAULT_CENTER.lat, DEFAULT_CENTER.lng], DEFAULT_ZOOM);

  L.tileLayer("https://tiles.stadiamaps.com/tiles/outdoors/{z}/{x}/{y}{r}.png", {
    maxZoom: 20,
    attribution: "© Stadia Maps, © OpenStreetMap",
  }).addTo(map);

  // ---------------------------------------------------------------------------
  // UI element references
  // ---------------------------------------------------------------------------

  var slider          = document.getElementById("distance-slider");
  var distanceInput   = document.getElementById("distance-input");
  var distanceReadout = document.getElementById("distance-value");
  var generateBtn     = document.getElementById("generate-btn");

  // Slider bounds are the source of truth for what the backend accepts.
  var DISTANCE_MIN_KM = parseFloat(slider.min);
  var DISTANCE_MAX_KM = parseFloat(slider.max);
  var routeStatsEl    = document.getElementById("route-stats");
  var statDistance    = document.getElementById("stat-distance");
  var statGain        = document.getElementById("stat-elevation-gain");
  var statLoss        = document.getElementById("stat-elevation-loss");
  var statSignals     = document.getElementById("stat-signals");
  var statusMsg       = document.getElementById("status-msg");

  // ---------------------------------------------------------------------------
  // Mutable state
  // ---------------------------------------------------------------------------

  /** @type {L.Marker|null} The draggable start-point marker. */
  var startMarker = null;

  /** @type {{ lat: number, lng: number }|null} Current start coordinates. */
  var startPoint = null;

  // Map layers for the drawn route (cleared before each new draw).
  /** @type {L.GeoJSON|null} */       var routeLayer          = null;
  /** @type {L.LayerGroup|null} */    var routeDirectionLayer = null;
  /** @type {L.LayerGroup|null} */    var routeOverlapLayer   = null;
  /** @type {L.LayerGroup|null} */    var routeHighlightLayer = null;

  // ---------------------------------------------------------------------------
  // Start-point helpers
  // ---------------------------------------------------------------------------

  function setStartPoint(lat, lng, shouldCenterMap) {
    var ll = L.latLng(lat, lng);
    startPoint = { lat: ll.lat, lng: ll.lng };

    if (!startMarker) {
      startMarker = L.marker(ll).addTo(map);
    } else {
      startMarker.setLatLng(ll);
    }

    if (shouldCenterMap) {
      map.setView(ll, USER_LOCATION_ZOOM);
    }
  }

  // ---------------------------------------------------------------------------
  // Location privacy notes (read once, never stored, never transmitted)
  // ---------------------------------------------------------------------------
  // - We call navigator.geolocation.getCurrentPosition() exactly once, on
  //   page load, to centre the map on the user. We never re-request it
  //   silently in the background.
  // - The coordinates are kept in browser memory only. They are NEVER
  //   persisted (no localStorage, no cookies) and NEVER sent to our server
  //   — the only thing the backend ever receives is the start point the
  //   user explicitly picks for a route.
  // - enableHighAccuracy is false on purpose: rough city-block accuracy is
  //   plenty for centring the map and avoids the aggressive permission
  //   prompts (and battery drain) that high-accuracy GPS triggers on mobile.
  function initializeUserLocation() {
    if (!navigator.geolocation) {
      setStatus("Showing default map location — click anywhere to set your start point.");
      return;
    }

    setStatus("Finding your location…");
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        setStartPoint(pos.coords.latitude, pos.coords.longitude, true);
        setStatus("Start point set to your location. Click anywhere to move it.");
      },
      function () {
        // Permission denied or timed out — fall back gracefully without
        // alarming the user about it.
        setStatus("Showing default map location — click anywhere to set your start point.");
      },
      // timeout is generous (20s) because the geolocation timer starts
      // immediately and includes the time the user spends on the
      // permission prompt — too-short timeouts fire the error callback
      // before the user can click "Allow", which is the most common
      // reason "Allow location" appears to do nothing.
      { enableHighAccuracy: false, timeout: 20000, maximumAge: 300000 }
    );
  }

  // ---------------------------------------------------------------------------
  // Formatting helpers
  // ---------------------------------------------------------------------------

  function formatKm(value) {
    var n = parseFloat(value);
    return (Math.round(n * 10) / 10).toString().replace(/\.0$/, "") + " km";
  }

  function formatDistanceM(meters) {
    return meters >= 1000
      ? (meters / 1000).toFixed(2) + " km"
      : Math.round(meters) + " m";
  }

  function formatElevationM(m) {
    return Math.round(m) + " m";
  }

  // Parse the input box. Returns the numeric distance in km, or null if the
  // text isn't a usable positive number inside the allowed range. Treat
  // whitespace-only strings the same as empty.
  function parseDistanceInput() {
    var raw = (distanceInput.value || "").trim();
    if (raw === "") { return null; }
    var n = Number(raw);
    if (!isFinite(n) || n <= 0) { return null; }
    if (n < DISTANCE_MIN_KM || n > DISTANCE_MAX_KM) { return null; }
    return n;
  }

  // Refresh the readable "X km" label and the red-border invalid state.
  // Always uses the input box (the user-typed value) as the source of truth.
  function syncDistanceLabel() {
    var parsed = parseDistanceInput();
    if (parsed === null) {
      distanceReadout.textContent = "— km";
      distanceInput.classList.add("invalid");
    } else {
      distanceReadout.textContent = formatKm(parsed);
      distanceInput.classList.remove("invalid");
    }
  }

  function setStatus(text, isError) {
    statusMsg.textContent = text || "";
    statusMsg.classList.toggle("error", Boolean(isError));
  }

  // ---------------------------------------------------------------------------
  // Geometry helpers (used for drawing arrows and overlap offsets)
  // ---------------------------------------------------------------------------

  function normalizeBearingDeg(b) {
    b = b % 360;
    return b < 0 ? b + 360 : b;
  }

  function segmentBearingDeg(fromLngLat, toLngLat) {
    var latRad = ((fromLngLat[1] + toLngLat[1]) / 2) * (Math.PI / 180);
    var dx = (toLngLat[0] - fromLngLat[0]) * Math.cos(latRad);
    var dy = toLngLat[1] - fromLngLat[1];
    return normalizeBearingDeg((Math.atan2(dx, dy) * 180) / Math.PI);
  }

  function bearingDeltaDeg(a, b) {
    var d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  function approxDistanceMeters(aLngLat, bLngLat) {
    var dLat = (bLngLat[1] - aLngLat[1]) * 111320;
    var avgLatRad = ((aLngLat[1] + bLngLat[1]) / 2) * (Math.PI / 180);
    var dLng = (bLngLat[0] - aLngLat[0]) * 111320 * Math.cos(avgLatRad);
    return Math.sqrt(dLat * dLat + dLng * dLng);
  }

  function midpointLngLat(a, b) {
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  }

  function interpolateLngLat(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  function toLeafletLine(coordsLngLat) {
    return coordsLngLat.map(function (c) { return [c[1], c[0]]; });
  }

  // ---------------------------------------------------------------------------
  // Route visual layers
  // ---------------------------------------------------------------------------

  function clearRouteVisuals() {
    [routeLayer, routeDirectionLayer, routeOverlapLayer, routeHighlightLayer].forEach(function (l) {
      if (l) { map.removeLayer(l); }
    });
    routeLayer = routeDirectionLayer = routeOverlapLayer = routeHighlightLayer = null;
  }

  /** Build the first `distanceMeters` of the route as a coord list. */
  function buildPrefixCoords(coordsLngLat, distanceMeters) {
    var out = [coordsLngLat[0]];
    var rem = Math.max(0, distanceMeters);
    for (var i = 0; i < coordsLngLat.length - 1 && rem > 0; i++) {
      var seg = approxDistanceMeters(coordsLngLat[i], coordsLngLat[i + 1]);
      if (seg <= rem) { out.push(coordsLngLat[i + 1]); rem -= seg; }
      else { out.push(interpolateLngLat(coordsLngLat[i], coordsLngLat[i + 1], rem / seg)); rem = 0; }
    }
    return out;
  }

  /** Build the last `distanceMeters` of the route as a coord list. */
  function buildSuffixCoords(coordsLngLat, distanceMeters) {
    var rev = [coordsLngLat[coordsLngLat.length - 1]];
    var rem = Math.max(0, distanceMeters);
    for (var i = coordsLngLat.length - 1; i > 0 && rem > 0; i--) {
      var seg = approxDistanceMeters(coordsLngLat[i], coordsLngLat[i - 1]);
      if (seg <= rem) { rev.push(coordsLngLat[i - 1]); rem -= seg; }
      else { rev.push(interpolateLngLat(coordsLngLat[i], coordsLngLat[i - 1], rem / seg)); rem = 0; }
    }
    return rev.reverse();
  }

  /** Green start flag + checkered finish flag + coloured end-cap highlights. */
  function drawStartEndHighlights(coordsLngLat) {
    if (!Array.isArray(coordsLngLat) || coordsLngLat.length < 2) { return; }
    routeHighlightLayer = L.layerGroup().addTo(map);

    var start = coordsLngLat[0];
    var end   = coordsLngLat[coordsLngLat.length - 1];
    // Nudge the finish marker slightly if it sits exactly on the start.
    var endForMarker = approxDistanceMeters(start, end) < 3
      ? [end[0] + 0.00012, end[1]]
      : end;

    L.marker([start[1], start[0]], {
      interactive: false, keyboard: false,
      icon: L.divIcon({
        className: "start-flag-icon",
        html: '<div style="display:flex;align-items:flex-end;gap:2px;">' +
              '<div style="width:2px;height:18px;background:#2e2e2e;"></div>' +
              '<div style="width:0;height:0;border-top:6px solid transparent;' +
              'border-bottom:6px solid transparent;border-left:12px solid #1b8f2e;"></div>' +
              '</div>',
        iconSize: [16, 20], iconAnchor: [2, 18],
      }),
    }).addTo(routeHighlightLayer);

    L.marker([endForMarker[1], endForMarker[0]], {
      interactive: false, keyboard: false,
      icon: L.divIcon({
        className: "finish-flag-icon",
        html: '<div style="font-size:18px;line-height:18px;">🏁</div>',
        iconSize: [18, 18], iconAnchor: [9, 16],
      }),
    }).addTo(routeHighlightLayer);

    var first = buildPrefixCoords(coordsLngLat, ROUTE_HIGHLIGHT_METERS);
    if (first.length >= 2) {
      L.polyline(toLeafletLine(first), { color: "#2e7d32", weight: 7, opacity: 0.95, interactive: false })
        .addTo(routeHighlightLayer);
    }

    var last = buildSuffixCoords(coordsLngLat, ROUTE_HIGHLIGHT_METERS);
    if (last.length >= 2) {
      var ll = toLeafletLine(last);
      L.polyline(ll, { color: "#111111", weight: 7, opacity: 0.95, dashArray: "12 12", dashOffset: "0",  interactive: false }).addTo(routeHighlightLayer);
      L.polyline(ll, { color: "#ffffff", weight: 7, opacity: 0.95, dashArray: "12 12", dashOffset: "12", interactive: false }).addTo(routeHighlightLayer);
    }
  }

  /** Offset a [lng, lat] point perpendicular to a direction vector by `meters`. */
  function offsetPointLngLat(lngLat, normalX, normalY, meters) {
    var lat = lngLat[1];
    var mPerDegLat = 111320;
    var mPerDegLng = 111320 * Math.cos((lat * Math.PI) / 180);
    return [
      lngLat[0] + (normalX * meters) / Math.max(mPerDegLng, 1e-6),
      lat        + (normalY * meters) / mPerDegLat,
    ];
  }

  /** Draw a parallel offset line where the route reuses the same street in both directions. */
  function drawOppositeDirectionOffsets(coordsLngLat) {
    if (!Array.isArray(coordsLngLat) || coordsLngLat.length < 2) { return; }
    var seen = {};
    routeOverlapLayer = L.layerGroup().addTo(map);

    for (var i = 0; i < coordsLngLat.length - 1; i++) {
      var a = coordsLngLat[i];
      var b = coordsLngLat[i + 1];
      if (approxDistanceMeters(a, b) < DIRECTION_ARROW_MIN_SEGMENT_M) { continue; }

      var ax = a[0].toFixed(6), ay = a[1].toFixed(6);
      var bx = b[0].toFixed(6), by = b[1].toFixed(6);
      var fwd = ax + "," + ay + "|" + bx + "," + by;
      var rev = bx + "," + by + "|" + ax + "," + ay;
      var undirected = fwd < rev ? fwd : rev;
      var dir = fwd < rev ? 1 : -1;

      var prev = seen[undirected];
      if (prev === undefined) { seen[undirected] = dir; continue; }
      if (prev === dir) { continue; }

      var dx = b[0] - a[0], dy = b[1] - a[1];
      var mag = Math.sqrt(dx * dx + dy * dy);
      if (mag < 1e-12) { continue; }

      var nx = (-dy / mag) * dir, ny = (dx / mag) * dir;
      var ao = offsetPointLngLat(a, nx, ny, OVERLAP_OFFSET_METERS);
      var bo = offsetPointLngLat(b, nx, ny, OVERLAP_OFFSET_METERS);

      L.polyline([[ao[1], ao[0]], [bo[1], bo[0]]], {
        color: "#42a5f5", weight: 3, opacity: 0.95, interactive: false,
      }).addTo(routeOverlapLayer);
    }
  }

  /** Draw small directional chevrons along straight sections of the route. */
  function drawDirectionArrows(coordsLngLat) {
    if (!Array.isArray(coordsLngLat) || coordsLngLat.length < 2) { return; }

    var segments = [];
    for (var i = 0; i < coordsLngLat.length - 1; i++) {
      var len = approxDistanceMeters(coordsLngLat[i], coordsLngLat[i + 1]);
      if (len > 0) {
        segments.push({
          from: coordsLngLat[i], to: coordsLngLat[i + 1],
          length: len,
          bearing: segmentBearingDeg(coordsLngLat[i], coordsLngLat[i + 1]),
        });
      }
    }
    if (!segments.length) { return; }

    // Group consecutive segments with similar bearing into "runs".
    var runs = [];
    var rs = 0, rl = segments[0].length, rb = segments[0].bearing;
    for (var j = 1; j < segments.length; j++) {
      if (bearingDeltaDeg(rb, segments[j].bearing) >= DIRECTION_ARROW_MIN_TURN_DEG) {
        runs.push({ start: rs, end: j - 1, length: rl });
        rs = j; rl = segments[j].length; rb = segments[j].bearing;
      } else {
        rl += segments[j].length; rb = segments[j].bearing;
      }
    }
    runs.push({ start: rs, end: segments.length - 1, length: rl });

    routeDirectionLayer = L.layerGroup().addTo(map);

    runs.forEach(function (run) {
      if (run.length < DIRECTION_ARROW_MIN_SEGMENT_M) { return; }

      // Find the midpoint of the run to place the arrow.
      var target = run.length / 2, acc = 0, arrowPt = null, arrowBearing = 0;
      for (var s = run.start; s <= run.end; s++) {
        var seg = segments[s];
        if (acc + seg.length >= target) {
          var t = (target - acc) / seg.length;
          arrowPt = interpolateLngLat(seg.from, seg.to, t);
          arrowBearing = seg.bearing;
          break;
        }
        acc += seg.length;
      }
      if (!arrowPt) {
        var last = segments[run.end];
        arrowPt = midpointLngLat(last.from, last.to);
        arrowBearing = last.bearing;
      }

      L.marker([arrowPt[1], arrowPt[0]], {
        interactive: false, keyboard: false,
        icon: L.divIcon({
          className: "direction-arrow-icon",
          html: '<svg width="18" height="18" viewBox="0 0 18 18" ' +
                'style="transform:rotate(' + (arrowBearing - 90) + 'deg);' +
                'transform-origin:center center;opacity:0.95;">' +
                '<path d="M3 4 L11 9 L3 14" stroke="#111111" stroke-width="3" fill="none" ' +
                'stroke-linecap="round" stroke-linejoin="round"></path></svg>',
          iconSize: [18, 18], iconAnchor: [9, 9],
        }),
      }).addTo(routeDirectionLayer);
    });
  }

  // ---------------------------------------------------------------------------
  // Draw a complete route on the map
  // ---------------------------------------------------------------------------

  function drawRoute(geojsonLineString) {
    clearRouteVisuals();

    routeLayer = L.geoJSON(
      { type: "Feature", geometry: geojsonLineString, properties: {} },
      { style: { color: "#0d47a1", weight: 5, opacity: 0.88 } }
    ).addTo(map);

    drawStartEndHighlights(geojsonLineString.coordinates);
    drawOppositeDirectionOffsets(geojsonLineString.coordinates);
    drawDirectionArrows(geojsonLineString.coordinates);

    try {
      map.fitBounds(routeLayer.getBounds(), { padding: [36, 36], maxZoom: 16 });
    } catch (e) { /* ignore degenerate geometry */ }
  }

  function showRouteStats(route) {
    statDistance.textContent = formatDistanceM(route.distance_meters);
    statGain.textContent     = formatElevationM(route.elevation_gain_m);
    statLoss.textContent     = formatElevationM(route.elevation_loss_m);
    statSignals.textContent  = String(route.signal_count);
    routeStatsEl.hidden = false;
  }

  // ---------------------------------------------------------------------------
  // Generate route — POST to backend, draw result
  // ---------------------------------------------------------------------------

  function generateRoute() {
    if (!startPoint) {
      setStatus("Click the map first to choose your start point.", true);
      return;
    }

    // Distance always comes from the typed input box — it stays in sync with
    // the slider, but the box is the only field that can hold invalid text.
    var targetKm = parseDistanceInput();
    if (targetKm === null) {
      distanceInput.classList.add("invalid");
      setStatus(
        "Invalid distance. Enter a number between " +
          DISTANCE_MIN_KM + " and " + DISTANCE_MAX_KM + " km.",
        true
      );
      return;
    }

    setStatus("Building route…");
    generateBtn.disabled = true;

    fetch(API_GENERATE_ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Never cache route responses — every Generate click must hit the
      // backend and get a fresh result, even if the body is byte-identical
      // to a previous request.
      cache: "no-store",
      body: JSON.stringify({
        lat: startPoint.lat,
        lng: startPoint.lng,
        distance_km: targetKm,
      }),
    })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) {
            var detail = data.detail;
            if (typeof detail === "string") { throw new Error(detail); }
            if (Array.isArray(detail) && detail.length) { throw new Error(detail[0].msg || "Request failed."); }
            throw new Error("Route API HTTP " + res.status);
          }
          return data;
        });
      })
      .then(function (route) {
        drawRoute({ type: "LineString", coordinates: route.coordinates });
        showRouteStats(route);
        setStatus("Route ready.");
      })
      .catch(function (err) {
        console.error(err);
        setStatus(err.message || "Could not reach the backend. Make sure it is running.", true);
        routeStatsEl.hidden = true;
        clearRouteVisuals();
      })
      .finally(function () {
        generateBtn.disabled = false;
      });
  }

  // ---------------------------------------------------------------------------
  // Event listeners
  // ---------------------------------------------------------------------------

  map.on("click", function (ev) {
    setStartPoint(ev.latlng.lat, ev.latlng.lng, false);
    setStatus("Start point set. Adjust distance, then generate.");
  });

  // Slider → input: any slider movement overwrites the typed value with the
  // slider's well-formed number, which also clears any "invalid" styling.
  slider.addEventListener("input", function () {
    distanceInput.value = slider.value;
    syncDistanceLabel();
  });

  // Input → slider: mirror the typed value back onto the slider knob, but
  // only when the value is valid. While the user is mid-typing ("1." or "")
  // we leave the slider where it was and just refresh the label/invalid mark.
  distanceInput.addEventListener("input", function () {
    var parsed = parseDistanceInput();
    if (parsed !== null) {
      slider.value = String(parsed);
    }
    syncDistanceLabel();
  });

  syncDistanceLabel();

  generateBtn.addEventListener("click", generateRoute);

  slider.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") { ev.preventDefault(); generateRoute(); }
  });

  distanceInput.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") { ev.preventDefault(); generateRoute(); }
  });

  // Try to centre the map on the user's real location on first load.
  setTimeout(initializeUserLocation, 0);
})();