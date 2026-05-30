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

  // Resolve the backend URL.
  //
  // Production: set window.ROUTERUNNER_API_BASE_URL in index.html to the full
  // origin of your deployed FastAPI host (e.g. "https://routerunner-api.onrender.com").
  // The backend's CORS_ORIGINS env var must list this site's origin in return.
  //
  // Local dev: when the override isn't set we point at the same hostname the
  // page is served from on port 8000, which matches `python run.py` and any
  // other local-dev setup that uses the default backend port.
  var API_BASE_URL =
    (typeof window !== "undefined" && window.ROUTERUNNER_API_BASE_URL) ||
    window.location.protocol + "//" + window.location.hostname + ":8000";
  var API_GENERATE_ROUTE = API_BASE_URL.replace(/\/$/, "") + "/generate-route";

  // Visual constants
  var OVERLAP_MIN_SEGMENT_M = 25;
  var OVERLAP_OFFSET_METERS = 4;
  var ROUTE_HIGHLIGHT_METERS = 100;

  // ---------------------------------------------------------------------------
  // Map setup
  // ---------------------------------------------------------------------------

  var DEFAULT_CENTER = { lat: 43.4723, lng: -80.5449 }; // University of Waterloo fallback
  var DEFAULT_ZOOM = 12;
  var USER_LOCATION_ZOOM = 14;

  var map = L.map("map").setView([DEFAULT_CENTER.lat, DEFAULT_CENTER.lng], DEFAULT_ZOOM);

  // OpenStreetMap standard tiles — no API key and no domain whitelist, so
  // they work the same on localhost and on every deployed host. If you want
  // nicer cartography later you can swap in Stadia / CARTO / Mapbox here.
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
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
  var statMaxClimb    = document.getElementById("stat-max-climb");
  var statSignals     = document.getElementById("stat-signals");
  var statusMsg       = document.getElementById("status-msg");
  var mapLoading      = document.getElementById("map-loading");
  var mapLoadingText  = document.getElementById("map-loading-text");

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

  function setLoading(active) {
    if (!mapLoading) { return; }
    mapLoading.hidden = !active;
  }

  function setMapLoadingText(text) {
    if (mapLoadingText) { mapLoadingText.textContent = text; }
  }

  // ---------------------------------------------------------------------------
  // "Show the work" generation animation (client-side, near the dropped pin)
  //
  // Speed is the priority, so the actual route comes from the fast parallel
  // POST /generate-route call. While we wait, we play a lightweight animation
  // around the start pin — an orbiting search circle, pulsing waypoints, and a
  // candidate loop — to make the wait feel purposeful. It's illustrative, not a
  // live trace of the server's computation, and it adds zero generation cost.
  // The map is frozen while it runs so the view can't drift.
  // ---------------------------------------------------------------------------

  var genLayer = null;
  var genRaf = null;
  var genMsgTimer = null;

  var GEN_MESSAGES = [
    "Placing waypoints around your start…",
    "Routing through the waypoints…",
    "Tuning the loop toward your distance…",
    "Trying a different orientation…",
    "Checking for U-turns and double-backs…",
    "Scoring candidate loops…",
  ];

  // Destination point `distM` away from (lat,lng) along a compass bearing, on a
  // spherical Earth. Returns [lat, lng].
  function destPoint(lat, lng, distM, bearingDeg) {
    var R = 6371000;
    var br = (bearingDeg * Math.PI) / 180;
    var lat1 = (lat * Math.PI) / 180;
    var lon1 = (lng * Math.PI) / 180;
    var dr = distM / R;
    var lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(dr) +
        Math.cos(lat1) * Math.sin(dr) * Math.cos(br)
    );
    var lon2 =
      lon1 +
      Math.atan2(
        Math.sin(br) * Math.sin(dr) * Math.cos(lat1),
        Math.cos(dr) - Math.sin(lat1) * Math.sin(lat2)
      );
    return [(lat2 * 180) / Math.PI, (lon2 * 180) / Math.PI];
  }

  // Disable/enable all user interaction so the view stays put during the work.
  function freezeMap(freeze) {
    ["dragging", "touchZoom", "doubleClickZoom", "scrollWheelZoom", "boxZoom", "keyboard", "tap"].forEach(
      function (handler) {
        if (map[handler]) {
          if (freeze) { map[handler].disable(); } else { map[handler].enable(); }
        }
      }
    );
    if (map.zoomControl && map.zoomControl._container) {
      map.zoomControl._container.style.pointerEvents = freeze ? "none" : "";
      map.zoomControl._container.style.opacity = freeze ? "0.45" : "";
    }
  }

  function startGenerationViz(start, targetKm) {
    stopGenerationViz();

    // Characteristic loop radius (circumference / 2π) just to size the visuals
    // sensibly around the pin — not used for the real route.
    var radiusM = (targetKm * 1000) / (2 * Math.PI);

    // Frame the work near the pin, then freeze so it can't drift while running.
    try {
      var bounds = L.latLng(start.lat, start.lng).toBounds(radiusM * 4.2);
      map.fitBounds(bounds, { padding: [20, 20], maxZoom: 16, animate: false });
    } catch (e) { /* ignore framing failure */ }
    freezeMap(true);

    genLayer = L.layerGroup().addTo(map);

    var searchCircle = L.circle([start.lat, start.lng], {
      radius: radiusM,
      color: "#fc4c02", weight: 1.5, opacity: 0.5,
      fillColor: "#fc4c02", fillOpacity: 0.05,
      dashArray: "5 6", interactive: false,
    }).addTo(genLayer);

    var candidate = L.polyline([], {
      color: "#fc4c02", weight: 3, opacity: 0.85,
      dashArray: "2 8", interactive: false,
    }).addTo(genLayer);

    // Fixed start marker (the user's chosen point).
    L.circleMarker([start.lat, start.lng], {
      radius: 6, color: "#0d47a1", weight: 2,
      fillColor: "#ffffff", fillOpacity: 1, interactive: false,
    }).addTo(genLayer);

    var NUM = 5;
    var STEP = 360 / NUM;
    var wpMarkers = [];
    for (var i = 1; i < NUM; i++) {
      wpMarkers.push(
        L.circleMarker([start.lat, start.lng], {
          radius: 5, color: "#fc4c02", weight: 2,
          fillColor: "#ffd9c7", fillOpacity: 1, interactive: false,
        }).addTo(genLayer)
      );
    }

    var startTs = null;
    function frame(ts) {
      if (startTs === null) { startTs = ts; }
      var t = (ts - startTs) / 1000;
      var rotation = (t * 70) % 360; // orbit the circle ~70°/sec

      var center = destPoint(start.lat, start.lng, radiusM, rotation);
      searchCircle.setLatLng(center);

      var startAngle = (rotation + 180) % 360;
      var pts = [[start.lat, start.lng]];
      for (var k = 1; k < NUM; k++) {
        // Gently pulse each waypoint's radius so it reads as "tuning".
        var pulse = 1 + 0.06 * Math.sin(t * 3 + k);
        var ang = (startAngle + STEP * k) % 360;
        var p = destPoint(center[0], center[1], radiusM * pulse, ang);
        pts.push(p);
        wpMarkers[k - 1].setLatLng(p);
      }
      pts.push([start.lat, start.lng]);
      candidate.setLatLngs(pts);

      genRaf = requestAnimationFrame(frame);
    }
    genRaf = requestAnimationFrame(frame);

    var idx = 0;
    setMapLoadingText(GEN_MESSAGES[0]);
    genMsgTimer = setInterval(function () {
      idx = (idx + 1) % GEN_MESSAGES.length;
      setMapLoadingText(GEN_MESSAGES[idx]);
    }, 1400);
  }

  function stopGenerationViz() {
    if (genRaf) { cancelAnimationFrame(genRaf); genRaf = null; }
    if (genMsgTimer) { clearInterval(genMsgTimer); genMsgTimer = null; }
    if (genLayer) { map.removeLayer(genLayer); genLayer = null; }
    freezeMap(false);
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

  // Walk inward from one end of the polyline until we're at least `minM`
  // away from the endpoint, so the local route direction is stable even when
  // OSRM packs several tiny vertices right at the start/finish.
  function pointAtLeastMetersFromEnd(coordsLngLat, fromStart, minM) {
    if (fromStart) {
      var base = coordsLngLat[0];
      for (var i = 1; i < coordsLngLat.length; i++) {
        if (approxDistanceMeters(base, coordsLngLat[i]) >= minM) {
          return coordsLngLat[i];
        }
      }
      return coordsLngLat[coordsLngLat.length - 1];
    }
    var last = coordsLngLat[coordsLngLat.length - 1];
    for (var j = coordsLngLat.length - 2; j >= 0; j--) {
      if (approxDistanceMeters(last, coordsLngLat[j]) >= minM) {
        return coordsLngLat[j];
      }
    }
    return coordsLngLat[0];
  }

  /**
   * Drop ONE labelled "START/FINISH" marker on the loop.
   *
   * Every route this app produces is a closed loop, so start and finish are
   * essentially the same coordinate — a single combined label reads better
   * than two flags fighting for the same pixel.
   *
   * To keep the label off the route line, we look at the two directions the
   * route leaves the start point (outbound + inbound) and push the label the
   * opposite way — into the open space on the outside of the loop.
   */
  function drawStartEndHighlights(coordsLngLat) {
    if (!Array.isArray(coordsLngLat) || coordsLngLat.length < 2) { return; }
    routeHighlightLayer = L.layerGroup().addTo(map);

    var start = coordsLngLat[0];

    // Two directions the route emanates from the start: the first outbound
    // segment, and the last inbound segment (taken as start → previous point).
    var outAt  = pointAtLeastMetersFromEnd(coordsLngLat, true, 18);
    var backAt = pointAtLeastMetersFromEnd(coordsLngLat, false, 18);
    var dirOut  = segmentBearingDeg(start, outAt);
    var dirBack = segmentBearingDeg(start, backAt);

    // Unit vectors (east = sin(bearing), north = cos(bearing)). The sum points
    // along the route's average heading; the label goes the opposite way.
    var ox = Math.sin((dirOut * Math.PI) / 180);
    var oy = Math.cos((dirOut * Math.PI) / 180);
    var bx = Math.sin((dirBack * Math.PI) / 180);
    var by = Math.cos((dirBack * Math.PI) / 180);
    var sx = ox + bx;
    var sy = oy + by;
    var mag = Math.sqrt(sx * sx + sy * sy);

    var awayX, awayY;
    if (mag < 0.15) {
      // Outbound and inbound nearly opposite (route passes straight through):
      // there's no clear "outside", so step perpendicular to the route.
      awayX = oy;
      awayY = -ox;
    } else {
      awayX = -sx / mag;
      awayY = -sy / mag;
    }

    var LABEL_OFFSET_M = 38;
    var labelPoint = offsetPointLngLat(start, awayX, awayY, LABEL_OFFSET_M);

    var flagHtml =
      '<div class="route-flag route-flag-startfinish">' +
        '<div class="route-flag-label">START/FINISH</div>' +
      '</div>';

    L.marker([labelPoint[1], labelPoint[0]], {
      interactive: false, keyboard: false, zIndexOffset: 1000,
      icon: L.divIcon({
        className: "startfinish-flag-icon",
        html: flagHtml,
        iconSize:   [150, 34],
        iconAnchor: [75, 17],
      }),
    }).addTo(routeHighlightLayer);
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
      if (approxDistanceMeters(a, b) < OVERLAP_MIN_SEGMENT_M) { continue; }

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

  /**
   * Draw a small, fixed number of directional chevrons evenly spaced along
   * the route — just enough to convey the general travel direction.
   *
   * We don't put an arrow at every turn or every leg (that clutters the map
   * and bunches chevrons around corners). Instead we drop DIRECTION_ARROW_COUNT
   * arrows at evenly spaced interior points of the total path. The (k + 0.5)/N
   * offsets keep all of them clear of the START / FINISH flag at the ends, and
   * each arrow is oriented along the route's heading at that point.
   */
  var DIRECTION_ARROW_COUNT = 4;

  function pointAndBearingAtDistance(segments, dist) {
    var acc = 0;
    for (var s = 0; s < segments.length; s++) {
      var seg = segments[s];
      if (acc + seg.length >= dist) {
        var t = (dist - acc) / seg.length;
        return { pt: interpolateLngLat(seg.from, seg.to, t), bearing: seg.bearing };
      }
      acc += seg.length;
    }
    var last = segments[segments.length - 1];
    return { pt: midpointLngLat(last.from, last.to), bearing: last.bearing };
  }

  function drawDirectionArrows(coordsLngLat) {
    if (!Array.isArray(coordsLngLat) || coordsLngLat.length < 2) { return; }

    // Build segment list (with heading) and total path length.
    var segments = [];
    var totalPathM = 0;
    for (var i = 0; i < coordsLngLat.length - 1; i++) {
      var len = approxDistanceMeters(coordsLngLat[i], coordsLngLat[i + 1]);
      if (len > 0) {
        segments.push({
          from:    coordsLngLat[i],
          to:      coordsLngLat[i + 1],
          length:  len,
          bearing: segmentBearingDeg(coordsLngLat[i], coordsLngLat[i + 1]),
        });
        totalPathM += len;
      }
    }
    if (!segments.length) { return; }

    routeDirectionLayer = L.layerGroup().addTo(map);
    for (var k = 0; k < DIRECTION_ARROW_COUNT; k++) {
      var frac = (k + 0.5) / DIRECTION_ARROW_COUNT;
      var p = pointAndBearingAtDistance(segments, totalPathM * frac);
      L.marker([p.pt[1], p.pt[0]], {
        interactive: false, keyboard: false,
        icon: L.divIcon({
          className: "direction-arrow-icon",
          html: '<svg width="18" height="18" viewBox="0 0 18 18" ' +
                'style="transform:rotate(' + (p.bearing - 90) + 'deg);' +
                'transform-origin:center center;opacity:0.95;">' +
                '<path d="M3 4 L11 9 L3 14" stroke="#111111" stroke-width="3" fill="none" ' +
                'stroke-linecap="round" stroke-linejoin="round"></path></svg>',
          iconSize: [18, 18], iconAnchor: [9, 9],
        }),
      }).addTo(routeDirectionLayer);
    }
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
    statMaxClimb.textContent = formatElevationM(route.max_climb_m);
    statSignals.textContent  = String(route.signal_count);
    routeStatsEl.hidden = false;
  }

  // ---------------------------------------------------------------------------
  // Generate route — fast POST to backend; animation plays while we wait
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

    setStatus("");
    clearRouteVisuals();
    routeStatsEl.hidden = true;
    setLoading(true);
    startGenerationViz(startPoint, targetKm);
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
        stopGenerationViz();
        drawRoute({ type: "LineString", coordinates: route.coordinates });
        showRouteStats(route);
        setStatus("Route ready.");
      })
      .catch(function (err) {
        stopGenerationViz();
        console.error(err);
        setStatus(err.message || "Could not reach the backend. Make sure it is running.", true);
        routeStatsEl.hidden = true;
        clearRouteVisuals();
      })
      .finally(function () {
        setLoading(false);
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