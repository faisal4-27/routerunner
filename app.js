/**
 * Route Runner — frontend logic
 *
 * Flow:
 * 1) On load, try to get the user's location and drop a marker there.
 * 2) User can search for an address/place, or click anywhere on the map, to
 *    move the start marker — geolocation is often denied or unavailable.
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
  // Traffic signals are fetched separately after the route is drawn: the
  // public Overpass server can take 30 s+ under load and shouldn't hold the
  // route back.
  var API_ROUTE_SIGNALS = API_BASE_URL.replace(/\/$/, "") + "/route-signals";

  // Elevation is fetched from Open-Meteo straight from the browser, for the
  // same per-IP reason as geocoding below: Open-Meteo's free quota is per IP,
  // and our Render backend shares its outbound IP with other customers, which
  // kept exhausting the daily limit. The backend endpoint is only a fallback.
  var OPEN_METEO_ELEVATION_URL = "https://api.open-meteo.com/v1/elevation";
  var API_ROUTE_ELEVATION = API_BASE_URL.replace(/\/$/, "") + "/route-elevation";
  var ELEVATION_MAX_SAMPLES = 96; // one Open-Meteo request (limit is 100)
  var ELEVATION_TIMEOUT_MS = 15000;

  // Location search (geocoding) is called straight from the browser rather
  // than proxied through our backend. The provider rate-limits per IP, so
  // going direct gives every visitor their own budget instead of sharing the
  // server's, and search keeps working while a sleeping backend wakes up.
  //
  // Photon rather than Nominatim: suggestions update as the user types, and
  // Nominatim's usage policy explicitly rules out per-keystroke autocomplete
  // traffic. Photon is built for it and runs on the same OSM data.
  var PHOTON_SEARCH_URL = "https://photon.komoot.io/api/";
  var GEOCODE_RESULT_LIMIT = 5;
  // Below 3 characters almost everything matches, so it's noise for the user
  // and needless traffic for a free service.
  var GEOCODE_MIN_QUERY_LEN = 3;
  // Wait out a burst of typing before firing a request.
  var GEOCODE_DEBOUNCE_MS = 250;

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

  // Pixel-art markers. crispEdges keeps the blocks sharp at any zoom.
  var START_PIN_ICON = L.divIcon({
    className: "rr-marker rr-start",
    html:
      '<svg width="30" height="36" viewBox="0 0 10 12" shape-rendering="crispEdges" aria-hidden="true">' +
        '<path d="M3 0h4v1h1v1h1v4h-1v2h-1v2h-1v2h-2v-2h-1v-2h-1v-2h-1v-4h1v-1h1z" fill="#04111a"/>' +
        '<path d="M3 1h4v1h1v4h-1v2h-1v2h-2v-2h-1v-2h-1v-4h1z" fill="#ff5c35"/>' +
        '<path d="M4 3h2v2h-2z" fill="#f4ead2"/>' +
      "</svg>",
    iconSize: [30, 36],
    iconAnchor: [15, 36],
  });

  // Combined START/FINISH marker for a generated loop: a chequered lime flag
  // whose pole stands in a square target. The anchor is the centre of that
  // target, so it sits exactly on the route's first point at every zoom.
  var START_FINISH_ICON = L.divIcon({
    className: "rr-marker rr-startfinish",
    html:
      // Drawn on a 34×46 grid and shown at 1.3× so it reads at a glance.
      '<svg width="44" height="60" viewBox="0 0 34 46" shape-rendering="crispEdges" aria-hidden="true">' +
        // pole
        '<rect x="15" y="2" width="4" height="36" fill="#04111a"/>' +
        '<rect x="16" y="3" width="2" height="34" fill="#f4ead2"/>' +
        // flag with chequers
        '<rect x="18" y="2" width="16" height="14" fill="#04111a"/>' +
        '<rect x="18" y="3" width="15" height="12" fill="#b7f34a"/>' +
        '<path d="M22 3h3v3h-3z M28 3h3v3h-3z M25 6h3v3h-3z M31 6h2v3h-2z' +
        ' M22 9h3v3h-3z M28 9h3v3h-3z M25 12h3v3h-3z M31 12h2v3h-2z" fill="#04111a"/>' +
        // target square on the route point
        '<rect x="11" y="35" width="12" height="12" fill="#04111a"/>' +
        '<rect x="13" y="37" width="8" height="8" fill="#b7f34a"/>' +
        '<rect x="15" y="39" width="4" height="4" fill="#04111a"/>' +
      "</svg>",
    iconSize: [44, 60],
    iconAnchor: [22, 53], // centre of the target square (17, 41) × 1.3
  });

  // ---------------------------------------------------------------------------
  // UI element references
  // ---------------------------------------------------------------------------

  var slider          = document.getElementById("distance-slider");
  var distanceInput   = document.getElementById("distance-input");
  var generateBtn     = document.getElementById("generate-btn");
  var generateLabel   = document.getElementById("generate-label");

  // Slider bounds are the source of truth for what the backend accepts.
  var DISTANCE_MIN_KM = parseFloat(slider.min);
  var DISTANCE_MAX_KM = parseFloat(slider.max);
  var statDistance    = document.getElementById("stat-distance");
  var statMaxClimb    = document.getElementById("stat-max-climb");
  var statSignals     = document.getElementById("stat-signals");
  var signalsUnit     = document.getElementById("signals-unit");
  var statusMsg       = document.getElementById("status-msg");
  var mapLoading      = document.getElementById("map-loading");
  var mapLoadingText  = document.getElementById("map-loading-text");
  var searchField     = document.getElementById("location-search-field");
  var searchInput     = document.getElementById("location-search");
  var locateBtn       = document.getElementById("locate-btn");
  var searchResults   = document.getElementById("location-results");

  // Dashboard chrome
  var gpsStatus       = document.getElementById("gps-status");
  var gpsStatusText   = document.getElementById("gps-status-text");
  var mapPlace        = document.getElementById("map-place");
  var routeIdEl       = document.getElementById("route-id");
  var routeBadge      = document.getElementById("route-badge");
  var routeBadgeText  = document.getElementById("route-badge-text");
  var coordLat        = document.getElementById("coord-lat");
  var coordLng        = document.getElementById("coord-lng");
  var liveBadge       = document.getElementById("live-badge");
  var dataLight       = document.getElementById("data-light");
  var elevChart       = document.getElementById("elev-chart");
  var elevGain        = document.getElementById("elev-gain");
  var elevMin         = document.getElementById("elev-min");
  var elevMax         = document.getElementById("elev-max");
  var saveBtn         = document.getElementById("save-btn");
  var saveLabel       = document.getElementById("save-label");

  document.getElementById("range-min-label").textContent = formatKm(DISTANCE_MIN_KM);
  document.getElementById("range-max-label").textContent = formatKm(DISTANCE_MAX_KM);

  // Palette shared with style.css (Leaflet paths take colours, not classes).
  var COLOR_ORANGE = "#ff5c35";
  var COLOR_CREAM  = "#f4ead2";
  var COLOR_LIME   = "#b7f34a";
  var COLOR_CYAN   = "#4fb3d9";
  var COLOR_DEEP   = "#04111a";

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

  /** @type {Object|null} Last successful /generate-route response (for saving). */
  var currentRoute = null;
  /** Counts routes generated this session, shown as ROUTE_01, ROUTE_02… */
  var routeCounter = 0;
  /** Human label for the start point, shown in the map header. */
  var startLabel = "";

  // ---------------------------------------------------------------------------
  // Start-point helpers
  // ---------------------------------------------------------------------------

  /**
   * Move the start marker to (lat, lng) and remember it as the route origin.
   *
   * `view` is optional and controls whether the map moves too:
   *   - { bounds: L.LatLngBounds } frames an area — used for search matches,
   *     so "Toronto" fits the city while a street address still lands close
   *     in (fitBounds caps the zoom at USER_LOCATION_ZOOM).
   *   - { zoom: n } jumps to the point at a fixed zoom.
   *   - omitted leaves the current view exactly where it is.
   *
   * `label` names the point in the map header ("Waterloo, Ontario").
   */
  function setStartPoint(lat, lng, view, label) {
    var ll = L.latLng(lat, lng);
    startPoint = { lat: ll.lat, lng: ll.lng };

    if (!startMarker) {
      startMarker = L.marker(ll, {
        icon: START_PIN_ICON,
        keyboard: false,
        zIndexOffset: 1200,
        title: "Start point",
      }).addTo(map);
    } else {
      startMarker.setLatLng(ll);
      // A new start point is being chosen, so show the pin again even if the
      // previous route's START/FINISH marker is still on the map.
      startMarker.setOpacity(1);
    }

    startLabel = label || "Custom start point";
    mapPlace.textContent = startLabel;
    coordLat.textContent = formatCoord(ll.lat, "N", "S");
    coordLng.textContent = formatCoord(ll.lng, "E", "W");

    if (view && view.bounds) {
      map.fitBounds(view.bounds, { padding: [24, 24], maxZoom: USER_LOCATION_ZOOM });
    } else if (view && view.zoom) {
      map.setView(ll, view.zoom);
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
  // - Caveat for location search: each search sends the typed text and the
  //   current map centre to Photon (komoot.io). If the map is centred on the
  //   user, that centre implies their rough area — so searching does reveal an
  //   approximate location to that third party, though never to us. Because
  //   suggestions update while typing, this happens once per burst of
  //   keystrokes rather than only on submit.
  // - The "use my location" button repeats the same one-shot request, but
  //   only when the user presses it.
  function setGpsState(state, text) {
    gpsStatus.dataset.state = state;
    gpsStatusText.textContent = text;
  }

  /**
   * Ask the browser for the user's position once.
   *
   * `explicit` is true when the user pressed the locate button: their fresh
   * position then always wins, and failures are reported as errors. On page
   * load it stays quiet and never overrides a start point the user already
   * chose while the permission prompt was open.
   */
  function locateUser(explicit) {
    if (!navigator.geolocation) {
      setGpsState("error", "GPS unavailable");
      locateBtn.disabled = true;
      setStatus("Search for a location, or click the map, to set your start point.");
      return;
    }

    setGpsState("busy", "GPS searching");
    locateBtn.disabled = true;
    locateBtn.classList.add("is-busy");
    setStatus("Finding your location…");

    function done() {
      locateBtn.disabled = false;
      locateBtn.classList.remove("is-busy");
    }

    navigator.geolocation.getCurrentPosition(
      function (pos) {
        done();
        setGpsState("active", "GPS active");
        // The permission prompt can sit open for a while. If the user already
        // searched or clicked a start point in the meantime, leave it alone.
        if (startPoint && !explicit) { return; }
        clearSearchResults();
        searchInput.value = "";
        setStartPoint(
          pos.coords.latitude, pos.coords.longitude,
          { zoom: USER_LOCATION_ZOOM }, "Your location"
        );
        setStatus("Start point set to your location. Click anywhere to move it.");
      },
      function () {
        done();
        setGpsState("idle", "GPS offline");
        // Permission denied or timed out — fall back gracefully without
        // alarming the user about it. Search is the way out of this state.
        if (explicit) {
          setStatus("Couldn't get your location. Check location permissions, or search for a place.", true);
          return;
        }
        if (startPoint) { return; }
        setStatus("Couldn't get your location — search for a place, or click the map.");
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
  // Location search (Photon geocoding)
  //
  // Suggestions appear under the box while the user types. Requests are
  // debounced and the previous one is aborted, so a burst of keystrokes costs
  // one request and a slow early reply can never overwrite a newer one.
  // Nothing moves the map until a suggestion is actually chosen.
  // ---------------------------------------------------------------------------

  /** @type {AbortController|null} In-flight search, so a stale reply can't win. */
  var geocodeAbort = null;
  /** @type {number|null} Pending debounce timer. */
  var geocodeTimer = null;
  /** @type {Array<Object>} Matches currently listed under the search box. */
  var searchMatches = [];
  /** Index of the keyboard-highlighted row, or -1 when none is. */
  var activeMatchIndex = -1;

  function buildGeocodeUrl(query) {
    var center = map.getCenter();
    // lat/lon bias ranks nearby places first without hiding distant ones, so
    // "main street" prefers the one near the map the user is looking at.
    return (
      PHOTON_SEARCH_URL +
      "?limit=" + GEOCODE_RESULT_LIMIT +
      "&lat=" + center.lat.toFixed(5) +
      "&lon=" + center.lng.toFixed(5) +
      "&q=" + encodeURIComponent(query)
    );
  }

  /** Photon returns extent as [west, north, east, south]. */
  function parseExtent(extent) {
    if (!Array.isArray(extent) || extent.length < 4) { return null; }
    var west  = parseFloat(extent[0]);
    var north = parseFloat(extent[1]);
    var east  = parseFloat(extent[2]);
    var south = parseFloat(extent[3]);
    if (![west, north, east, south].every(isFinite)) { return null; }
    return L.latLngBounds([south, west], [north, east]);
  }

  /**
   * Turn Photon's address fields into a headline plus a context line.
   *
   * Photon has no preformatted label (unlike Nominatim's display_name), so we
   * assemble one: the place or street name on top, then enough administrative
   * detail below to tell two same-named streets apart.
   */
  function formatPlaceParts(props) {
    var street = props.street || "";
    if (props.housenumber && street) { street = props.housenumber + " " + street; }

    var primary =
      props.name || street || props.city || props.state || props.country || "Unnamed place";

    var context = [];
    [street, props.city || props.locality || props.county, props.state, props.country]
      .forEach(function (part) {
        if (part && part !== primary && context.indexOf(part) === -1) { context.push(part); }
      });

    return { primary: primary, secondary: context.join(", ") };
  }

  function parseGeocodeResults(data) {
    var features = data && Array.isArray(data.features) ? data.features : [];
    var results = [];
    var seenLabels = {};

    features.forEach(function (feature) {
      var coords = feature && feature.geometry && feature.geometry.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) { return; }
      var lng = parseFloat(coords[0]);
      var lat = parseFloat(coords[1]);
      if (!isFinite(lat) || !isFinite(lng)) { return; }

      var props = feature.properties || {};
      var parts = formatPlaceParts(props);
      var label = parts.secondary ? parts.primary + ", " + parts.secondary : parts.primary;

      // A long street is many OSM ways, so one search can return several
      // features that describe it identically. Rows the user can't tell apart
      // are just noise — any segment works as a start point, so keep the first.
      if (seenLabels[label]) { return; }
      seenLabels[label] = true;

      results.push({
        primary:   parts.primary,
        secondary: parts.secondary,
        label:     label,
        lat:       lat,
        lng:       lng,
        bounds:    parseExtent(props.extent),
      });
    });

    return results;
  }

  // Dismiss the list and cancel anything still on its way, so a reply that
  // lands after the user has moved on can't pop the suggestions back open.
  function clearSearchResults() {
    if (geocodeTimer) { clearTimeout(geocodeTimer); geocodeTimer = null; }
    if (geocodeAbort) { geocodeAbort.abort(); geocodeAbort = null; }
    searchMatches = [];
    activeMatchIndex = -1;
    searchResults.innerHTML = "";
    searchResults.hidden = true;
  }

  function renderSearchResults(results) {
    searchMatches = results;
    activeMatchIndex = -1;
    searchResults.innerHTML = "";

    results.forEach(function (result) {
      var item = document.createElement("li");
      var button = document.createElement("button");
      button.type = "button";
      button.className = "search-result-btn";

      // textContent, not innerHTML: these are third-party strings.
      var primary = document.createElement("span");
      primary.className = "search-result-primary";
      primary.textContent = result.primary;
      button.appendChild(primary);

      if (result.secondary) {
        var secondary = document.createElement("span");
        secondary.className = "search-result-secondary";
        secondary.textContent = result.secondary;
        button.appendChild(secondary);
      }

      button.addEventListener("click", function () { chooseSearchResult(result); });
      item.appendChild(button);
      searchResults.appendChild(item);
    });

    searchResults.hidden = false;
  }

  // Shown in place of matches so the dead end is visible where the user is
  // looking, instead of in the status line below the panel.
  function renderNoMatches(query) {
    searchMatches = [];
    activeMatchIndex = -1;
    searchResults.innerHTML = "";

    var item = document.createElement("li");
    item.className = "search-empty";
    item.textContent = "No matches for “" + query + "”";
    searchResults.appendChild(item);
    searchResults.hidden = false;
  }

  function setActiveMatch(index) {
    var buttons = searchResults.querySelectorAll(".search-result-btn");
    if (!buttons.length) { return; }

    activeMatchIndex = ((index % buttons.length) + buttons.length) % buttons.length;
    for (var i = 0; i < buttons.length; i++) {
      var isActive = i === activeMatchIndex;
      buttons[i].classList.toggle("is-active", isActive);
      if (isActive) { buttons[i].scrollIntoView({ block: "nearest" }); }
    }
  }

  function chooseSearchResult(result) {
    clearSearchResults();
    // Programmatic assignment doesn't fire `input`, so this can't re-trigger
    // a search and reopen the list we just closed.
    searchInput.value = result.label;
    setStartPoint(
      result.lat,
      result.lng,
      result.bounds ? { bounds: result.bounds } : { zoom: USER_LOCATION_ZOOM },
      result.label
    );
    setStatus("Start point set to " + result.primary + ". Click the map to fine-tune it.");
  }

  function queueLocationSearch() {
    if (geocodeTimer) { clearTimeout(geocodeTimer); }
    geocodeTimer = setTimeout(function () {
      geocodeTimer = null;
      runLocationSearch(false);
    }, GEOCODE_DEBOUNCE_MS);
  }

  // `explicit` marks a deliberate Enter/button search, which is allowed to
  // complain about a too-short query. Typing stays quiet.
  function runLocationSearch(explicit) {
    var query = (searchInput.value || "").trim();
    if (query.length < GEOCODE_MIN_QUERY_LEN) {
      clearSearchResults();
      if (explicit) {
        setStatus("Type at least " + GEOCODE_MIN_QUERY_LEN + " characters to search.", true);
      }
      return;
    }

    if (geocodeAbort) { geocodeAbort.abort(); }
    var controller = new AbortController();
    geocodeAbort = controller;

    fetch(buildGeocodeUrl(query), { signal: controller.signal })
      .then(function (res) {
        if (!res.ok) { throw new Error("Location search failed (HTTP " + res.status + ")."); }
        return res.json();
      })
      .then(function (data) {
        var results = parseGeocodeResults(data);
        if (!results.length) { renderNoMatches(query); return; }
        renderSearchResults(results);
      })
      .catch(function (err) {
        if (err && err.name === "AbortError") { return; }
        console.error(err);
        clearSearchResults();
        setStatus("Couldn't search for that location. Check your connection and try again.", true);
      })
      .finally(function () {
        // A newer search already owns the UI, so only the latest one clears.
        if (geocodeAbort === controller) { geocodeAbort = null; }
      });
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

  function formatCoord(value, positive, negative) {
    return Math.abs(value).toFixed(4) + "° " + (value >= 0 ? positive : negative);
  }

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
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

  // Refresh the slider's orange progress fill and the red invalid state.
  // Always uses the input box (the user-typed value) as the source of truth.
  function syncDistanceLabel() {
    var parsed = parseDistanceInput();
    distanceInput.classList.toggle("invalid", parsed === null);
    distanceInput.setAttribute("aria-invalid", parsed === null ? "true" : "false");

    var v = parseFloat(slider.value);
    var pct = ((v - DISTANCE_MIN_KM) / (DISTANCE_MAX_KM - DISTANCE_MIN_KM)) * 100;
    slider.style.setProperty("--fill", pct + "%");
  }

  // When the user leaves the box, snap any out-of-range number to the nearest
  // supported distance. Non-numbers are left alone so the invalid state (and
  // the error on Generate) can tell the user what's wrong.
  function clampDistanceInput() {
    var n = Number((distanceInput.value || "").trim());
    if ((distanceInput.value || "").trim() === "" || !isFinite(n)) { return; }
    var clamped = Math.min(DISTANCE_MAX_KM, Math.max(DISTANCE_MIN_KM, n));
    if (clamped !== n) {
      distanceInput.value = String(clamped);
      setStatus("Distance adjusted to " + formatKm(clamped) + " (supported range " +
        formatKm(DISTANCE_MIN_KM) + "–" + formatKm(DISTANCE_MAX_KM) + ").");
    }
    slider.value = String(clamped);
    syncDistanceLabel();
  }

  function setStatus(text, isError) {
    statusMsg.textContent = text || "";
    statusMsg.classList.toggle("error", Boolean(isError));
  }

  function setRouteBadge(state, text) {
    routeBadge.dataset.state = state;
    routeBadgeText.textContent = text;
  }

  function setLoading(active) {
    if (mapLoading) { mapLoading.hidden = !active; }
    generateBtn.disabled = active;
    generateBtn.classList.toggle("is-loading", active);
    generateBtn.setAttribute("aria-busy", active ? "true" : "false");
    generateLabel.textContent = active ? "Plotting..." : "Generate route";
    if (active) {
      setRouteBadge("busy", "Plotting route");
      liveBadge.dataset.state = "busy";
      liveBadge.textContent = "Calc";
    }
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
      color: COLOR_CYAN, weight: 1.5, opacity: 0.6,
      fillColor: COLOR_CYAN, fillOpacity: 0.05,
      dashArray: "4 6", lineCap: "butt", interactive: false,
    }).addTo(genLayer);

    var candidate = L.polyline([], {
      color: COLOR_ORANGE, weight: 3, opacity: 0.9,
      dashArray: "6 6", lineCap: "butt", interactive: false,
    }).addTo(genLayer);

    var NUM = 5;
    var STEP = 360 / NUM;
    var wpMarkers = [];
    for (var i = 1; i < NUM; i++) {
      wpMarkers.push(
        L.circleMarker([start.lat, start.lng], {
          radius: 5, color: COLOR_DEEP, weight: 2,
          fillColor: COLOR_LIME, fillOpacity: 1, interactive: false,
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
    if (startMarker) { startMarker.setOpacity(1); }
  }

  /**
   * Drop ONE "START/FINISH" marker exactly on the loop's first point.
   *
   * Every route this app produces is a closed loop, so start and finish are
   * the same coordinate. We use the route's own first point rather than the
   * clicked start: OSRM snaps the start onto the nearest path, so the clicked
   * point can sit off the line. The marker is a fixed pixel size anchored on
   * the point, so it stays on the route at every zoom level.
   *
   * The user's start pin is hidden while the route is shown so there is only
   * one marker to read; it reappears when a new start point is chosen.
   */
  function drawStartEndHighlights(coordsLngLat) {
    if (!Array.isArray(coordsLngLat) || coordsLngLat.length < 2) { return; }
    routeHighlightLayer = L.layerGroup().addTo(map);

    var start = coordsLngLat[0];
    L.marker([start[1], start[0]], {
      interactive: false, keyboard: false, zIndexOffset: 1500,
      icon: START_FINISH_ICON,
      title: "Start / finish",
    }).addTo(routeHighlightLayer);

    if (startMarker) { startMarker.setOpacity(0); }
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
        color: COLOR_CYAN, weight: 3, opacity: 0.95, interactive: false,
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
                '<path d="M4 4 L11 9 L4 14" stroke="' + COLOR_DEEP + '" stroke-width="5" fill="none" ' +
                'stroke-linecap="square" stroke-linejoin="miter"></path>' +
                '<path d="M4 4 L11 9 L4 14" stroke="' + COLOR_CREAM + '" stroke-width="2.2" fill="none" ' +
                'stroke-linecap="square" stroke-linejoin="miter"></path></svg>',
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

    // Three stacked strokes: a soft orange glow, the solid route, and a thin
    // cream dash down the middle for the "plotted track" look.
    var latLngs = toLeafletLine(geojsonLineString.coordinates);
    routeLayer = L.featureGroup([
      L.polyline(latLngs, { color: COLOR_ORANGE, weight: 16, opacity: 0.16, interactive: false }),
      L.polyline(latLngs, { color: COLOR_DEEP,   weight: 8,  opacity: 0.85, interactive: false }),
      L.polyline(latLngs, { color: COLOR_ORANGE, weight: 5,  opacity: 1,    interactive: false }),
      L.polyline(latLngs, {
        color: COLOR_CREAM, weight: 1.5, opacity: 0.9,
        dashArray: "3 9", lineCap: "butt", interactive: false,
      }),
    ]).addTo(map);

    drawStartEndHighlights(geojsonLineString.coordinates);
    drawOppositeDirectionOffsets(geojsonLineString.coordinates);
    drawDirectionArrows(geojsonLineString.coordinates);

    try {
      map.fitBounds(routeLayer.getBounds(), { padding: [36, 36], maxZoom: 16 });
    } catch (e) { /* ignore degenerate geometry */ }
  }

  // ---------------------------------------------------------------------------
  // Route data sidebar
  // ---------------------------------------------------------------------------

  var SVG_NS = "http://www.w3.org/2000/svg";
  var CHART_W = 120;
  var CHART_H = 40;
  var CHART_COLUMNS = 40; // chunky bars read as "pixel" at any panel width

  function svgEl(name, attrs) {
    var el = document.createElementNS(SVG_NS, name);
    Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    return el;
  }

  /**
   * Draw the elevation profile as a stepped (pixel) area chart.
   *
   * The samples are bucketed into CHART_COLUMNS columns and drawn as a
   * staircase, so the chart keeps the blocky look regardless of how many
   * samples the backend returned. With no samples it shows a flat baseline.
   */
  /**
   * `emptyState` only matters when there are no samples: "loading" while the
   * lookup is in flight, "unavailable" when it failed, otherwise "no route".
   */
  function renderElevationChart(profile, gainM, emptyState) {
    while (elevChart.firstChild) { elevChart.removeChild(elevChart.firstChild); }

    var samples = Array.isArray(profile) ? profile.filter(isFinite) : [];
    if (samples.length < 2) {
      elevChart.appendChild(svgEl("rect", {
        class: "elev-empty", x: 0, y: CHART_H - 2, width: CHART_W, height: 2,
      }));
      if (emptyState === "loading") {
        elevChart.setAttribute("aria-label", "Loading elevation profile");
        elevMin.textContent = "Loading elevation...";
        elevMax.textContent = "";
      } else if (emptyState === "unavailable") {
        // A route exists but the elevation lookup failed — say so plainly
        // rather than leaving an empty chart that looks like a bug.
        elevChart.setAttribute("aria-label", "Elevation data unavailable for this route");
        elevMin.textContent = "Elevation unavailable";
        elevMax.textContent = "";
      } else {
        elevChart.setAttribute("aria-label", "Elevation profile: no route yet");
        elevMin.textContent = "-- m";
        elevMax.textContent = "-- m";
      }
      return;
    }

    var lo = Math.min.apply(null, samples);
    var hi = Math.max.apply(null, samples);
    // Keep at least 10 m of vertical range so a flat route looks flat
    // instead of magnifying a 1 m wobble into mountains.
    var span = Math.max(hi - lo, 10);
    var cols = Math.min(CHART_COLUMNS, samples.length);
    var colW = CHART_W / cols;
    var top = 4; // headroom so the peak isn't glued to the border

    var line = "";
    for (var c = 0; c < cols; c++) {
      var from = Math.floor((c * samples.length) / cols);
      var to = Math.max(from + 1, Math.floor(((c + 1) * samples.length) / cols));
      var sum = 0;
      for (var i = from; i < to; i++) { sum += samples[i]; }
      var avg = sum / (to - from);
      var y = top + (CHART_H - top - 2) * (1 - (avg - lo) / span);
      var x0 = c * colW;
      var x1 = x0 + colW;
      line += (c === 0 ? "M" : "L") + x0.toFixed(2) + " " + y.toFixed(2) +
              "L" + x1.toFixed(2) + " " + y.toFixed(2);
    }

    elevChart.appendChild(svgEl("path", {
      class: "elev-area", d: line + "L" + CHART_W + " " + CHART_H + "L0 " + CHART_H + "Z",
    }));
    elevChart.appendChild(svgEl("path", { class: "elev-line", d: line }));
    elevChart.setAttribute(
      "aria-label",
      "Elevation profile from " + Math.round(lo) + " to " + Math.round(hi) +
        " metres, " + Math.round(gainM) + " metres total gain"
    );
    elevMin.textContent = "Low " + Math.round(lo) + " m";
    elevMax.textContent = "High " + Math.round(hi) + " m";
  }

  function setLive(isLive) {
    liveBadge.dataset.state = isLive ? "live" : "idle";
    liveBadge.textContent = isLive ? "Live" : "Idle";
    dataLight.classList.toggle("is-live", isLive);
  }

  function setSaved(saved) {
    saveBtn.classList.toggle("is-saved", saved);
    saveLabel.textContent = saved ? "Route saved" : "Save route";
    saveBtn.setAttribute(
      "aria-label",
      saved ? "Route saved as GPX. Press to download again." : "Save route as a GPX file"
    );
  }

  /** Put the sidebar back to its empty "no route" state. */
  function resetRouteStats() {
    currentRoute = null;
    cancelSignalCount();
    cancelElevation();
    statDistance.textContent = "--";
    statMaxClimb.textContent = "--";
    setSignals("--", "junctions");
    elevGain.textContent     = "+0 m";
    renderElevationChart([], 0);
    setLive(false);
    setSaved(false);
    saveBtn.disabled = true;
  }

  function showRouteStats(route) {
    currentRoute = route;
    var km = route.distance_meters / 1000;

    statDistance.textContent = km.toFixed(km >= 10 ? 1 : 2);

    setLive(true);
    setSaved(false);
    saveBtn.disabled = false;
    loadSignalCount(route);
    loadElevation(route);
  }

  // ---------------------------------------------------------------------------
  // Elevation — fetched after the route is shown, browser → Open-Meteo first,
  // backend /route-elevation as the fallback (see OPEN_METEO_ELEVATION_URL)
  // ---------------------------------------------------------------------------

  /** @type {AbortController|null} In-flight elevation lookup, cancelled by a new route. */
  var elevationAbort = null;

  function cancelElevation() {
    if (elevationAbort) { elevationAbort.abort(); elevationAbort = null; }
  }

  /** Keep every Nth vertex (first and last always kept) — mirrors the backend. */
  function sampleCoords(coords, maxPoints) {
    if (coords.length <= maxPoints) { return coords.slice(); }
    var step = Math.ceil(coords.length / maxPoints);
    var out = [];
    for (var i = 0; i < coords.length - 1; i += step) { out.push(coords[i]); }
    var last = coords[coords.length - 1];
    var tail = out[out.length - 1];
    if (!tail || tail[0] !== last[0] || tail[1] !== last[1]) { out.push(last); }
    return out;
  }

  /**
   * Total gain (sum of every uphill step) and the biggest single climb
   * (largest low-to-high rise, via a running minimum). Same maths as the
   * backend's elevation_stats().
   */
  function elevationStats(profile) {
    var gain = 0;
    var maxClimb = 0;
    var minSoFar = profile[0];
    for (var i = 1; i < profile.length; i++) {
      var curr = profile[i];
      if (curr > profile[i - 1]) { gain += curr - profile[i - 1]; }
      if (curr < minSoFar) { minSoFar = curr; }
      else if (curr - minSoFar > maxClimb) { maxClimb = curr - minSoFar; }
    }
    return { gain: gain, maxClimb: maxClimb };
  }

  /** Abort `controller` after ms, unless it settles first. Returns a cancel fn. */
  function abortAfter(controller, ms) {
    var t = setTimeout(function () { controller.abort(); }, ms);
    return function () { clearTimeout(t); };
  }

  /** Browser → Open-Meteo. Resolves to the elevation profile (metres). */
  function fetchElevationDirect(samples, signal) {
    var url = OPEN_METEO_ELEVATION_URL +
      "?latitude=" + samples.map(function (c) { return c[1].toFixed(5); }).join(",") +
      "&longitude=" + samples.map(function (c) { return c[0].toFixed(5); }).join(",");
    return fetch(url, { signal: signal, cache: "no-store" })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok || data.error) {
            throw new Error("Open-Meteo: " + (data.reason || "HTTP " + res.status));
          }
          var profile = (data.elevation || []).filter(function (v) {
            return typeof v === "number" && isFinite(v);
          });
          if (profile.length < 2) { throw new Error("Open-Meteo: no usable samples"); }
          return profile;
        });
      });
  }

  /** Browser → our backend → Open-Meteo. Fallback only (shared server IP). */
  function fetchElevationViaBackend(samples, signal) {
    return fetch(API_ROUTE_ELEVATION, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ coordinates: samples }),
      signal: signal,
    }).then(function (res) {
      if (!res.ok) { throw new Error("Elevation fallback HTTP " + res.status); }
      return res.json();
    }).then(function (data) { return data.elevation_profile; });
  }

  function showElevation(profile) {
    var s = elevationStats(profile);
    statMaxClimb.textContent = String(Math.round(s.maxClimb));
    elevGain.textContent     = "+" + formatElevationM(s.gain);
    renderElevationChart(profile, s.gain);
  }

  function loadElevation(route) {
    cancelElevation();
    var controller = new AbortController();
    elevationAbort = controller;

    statMaxClimb.textContent = "...";
    elevGain.textContent     = "...";
    renderElevationChart([], 0, "loading");

    var samples = (route.elevation_samples && route.elevation_samples.length >= 2)
      ? route.elevation_samples
      : sampleCoords(route.coordinates || [], ELEVATION_MAX_SAMPLES);
    if (samples.length < 2) {
      elevationAbort = null;
      statMaxClimb.textContent = "--";
      elevGain.textContent     = "Unavailable";
      renderElevationChart([], 0, "unavailable");
      return;
    }

    // Each attempt gets its own timeout; aborting `controller` (a new route)
    // cancels whichever attempt is running.
    function attempt(fn) {
      var inner = new AbortController();
      var onOuterAbort = function () { inner.abort(); };
      controller.signal.addEventListener("abort", onOuterAbort);
      var clear = abortAfter(inner, ELEVATION_TIMEOUT_MS);
      return fn(samples, inner.signal).finally(function () {
        clear();
        controller.signal.removeEventListener("abort", onOuterAbort);
      });
    }

    attempt(fetchElevationDirect)
      .catch(function (err) {
        if (controller.signal.aborted) { throw err; }
        console.warn("Direct elevation lookup failed, trying backend:", err);
        return attempt(fetchElevationViaBackend);
      })
      .then(function (profile) {
        if (elevationAbort !== controller) { return; }
        showElevation(profile);
      })
      .catch(function (err) {
        if (elevationAbort !== controller) { return; }
        console.error(err);
        statMaxClimb.textContent = "--";
        elevGain.textContent     = "Unavailable";
        renderElevationChart([], 0, "unavailable");
      })
      .finally(function () {
        if (elevationAbort === controller) { elevationAbort = null; }
      });
  }

  // ---------------------------------------------------------------------------
  // Traffic signals — fetched after the route is shown (see API_ROUTE_SIGNALS)
  // ---------------------------------------------------------------------------

  /** @type {AbortController|null} In-flight signal lookup, cancelled by a new route. */
  var signalsAbort = null;

  function setSignals(text, unit) {
    statSignals.textContent = text;
    signalsUnit.textContent = unit;
  }

  function cancelSignalCount() {
    if (signalsAbort) { signalsAbort.abort(); signalsAbort = null; }
  }

  function loadSignalCount(route) {
    cancelSignalCount();
    var controller = new AbortController();
    signalsAbort = controller;
    setSignals("...", "counting");

    fetch(API_ROUTE_SIGNALS, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ coordinates: route.coordinates }),
      signal: controller.signal,
    })
      .then(function (res) {
        if (!res.ok) { throw new Error("Signal lookup HTTP " + res.status); }
        return res.json();
      })
      .then(function (data) {
        if (signalsAbort !== controller) { return; }
        var n = data.signal_count;
        setSignals(String(n), n === 1 ? "junction" : "junctions");
      })
      .catch(function (err) {
        if (err && err.name === "AbortError") { return; }
        if (signalsAbort !== controller) { return; }
        console.error(err);
        // Unknown is not zero: say so instead of showing a misleading 0.
        setSignals("--", "unavailable");
        setStatus("Route ready. Traffic-signal data is unavailable right now (the OpenStreetMap service is busy). Try generating again later.");
      })
      .finally(function () {
        if (signalsAbort === controller) { signalsAbort = null; }
      });
  }

  // ---------------------------------------------------------------------------
  // Save route — downloads the loop as GPX, which Strava, Garmin Connect,
  // Komoot and most watches can import. Nothing is stored or uploaded.
  // ---------------------------------------------------------------------------

  function escapeXml(s) {
    return String(s).replace(/[<>&'"]/g, function (ch) {
      return { "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[ch];
    });
  }

  function buildGpx(route, name) {
    var pts = route.coordinates.map(function (c) {
      return '      <trkpt lat="' + c[1].toFixed(6) + '" lon="' + c[0].toFixed(6) + '"></trkpt>';
    });
    return (
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<gpx version="1.1" creator="Route Runner" xmlns="http://www.topografix.com/GPX/1/1">\n' +
      "  <metadata><name>" + escapeXml(name) + "</name></metadata>\n" +
      "  <trk>\n    <name>" + escapeXml(name) + "</name>\n    <type>running</type>\n    <trkseg>\n" +
      pts.join("\n") +
      "\n    </trkseg>\n  </trk>\n</gpx>\n"
    );
  }

  function saveRoute() {
    if (!currentRoute) { return; }
    var km = (currentRoute.distance_meters / 1000).toFixed(1);
    var name = "Route Runner " + km + " km loop";
    var blob = new Blob([buildGpx(currentRoute, name)], { type: "application/gpx+xml" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "routerunner-" + km.replace(".", "_") + "km-" + pad2(routeCounter) + ".gpx";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);

    setSaved(true);
    setStatus("Route saved as " + a.download + ".");
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
    resetRouteStats();
    setLoading(true);
    startGenerationViz(startPoint, targetKm);

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
        routeCounter += 1;
        routeIdEl.textContent = "Route_" + pad2(routeCounter);
        showRouteStats(route);
        setLoading(false);
        setRouteBadge("active", "Route online");
        setStatus("Route ready.");
      })
      .catch(function (err) {
        stopGenerationViz();
        console.error(err);
        setLoading(false);
        resetRouteStats();
        setRouteBadge("error", "Route failed");
        setStatus(err.message || "Could not reach the backend. Make sure it is running.", true);
        clearRouteVisuals();
      });
  }

  // ---------------------------------------------------------------------------
  // Event listeners
  // ---------------------------------------------------------------------------

  map.on("click", function (ev) {
    clearSearchResults();
    setStartPoint(ev.latlng.lat, ev.latlng.lng);
    setStatus("Start point set. Adjust distance, then generate.");
  });

  // Typing drives the suggestions; Enter forces an immediate search (handy
  // for retrying after a network hiccup).
  searchInput.addEventListener("input", queueLocationSearch);
  locateBtn.addEventListener("click", function () { locateUser(true); });
  saveBtn.addEventListener("click", saveRoute);

  searchInput.addEventListener("keydown", function (ev) {
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      if (searchMatches.length) { setActiveMatch(activeMatchIndex + 1); }
      return;
    }

    if (ev.key === "ArrowUp") {
      ev.preventDefault();
      // From "nothing highlighted", Up should wrap to the bottom of the list.
      if (searchMatches.length) {
        setActiveMatch(activeMatchIndex <= 0 ? searchMatches.length - 1 : activeMatchIndex - 1);
      }
      return;
    }

    if (ev.key === "Enter") {
      ev.preventDefault();
      if (searchMatches.length) {
        // Enter with nothing highlighted takes the top match.
        chooseSearchResult(searchMatches[activeMatchIndex >= 0 ? activeMatchIndex : 0]);
      } else {
        // Typed and hit Enter before suggestions arrived — search right away.
        runLocationSearch(true);
      }
      return;
    }

    if (ev.key === "Escape") { clearSearchResults(); }
  });

  // Clicking anywhere outside the search field dismisses the match list.
  document.addEventListener("click", function (ev) {
    if (!searchField.contains(ev.target)) { clearSearchResults(); }
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

  distanceInput.addEventListener("change", clampDistanceInput);

  syncDistanceLabel();
  resetRouteStats();

  generateBtn.addEventListener("click", generateRoute);

  slider.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") { ev.preventDefault(); generateRoute(); }
  });

  distanceInput.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") { ev.preventDefault(); generateRoute(); }
  });

  // Try to centre the map on the user's real location on first load.
  setTimeout(function () { locateUser(false); }, 0);
})();