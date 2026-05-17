/**
 * Route Runner — core behavior
 *
 * Flow (high level):
 * 1) User clicks the map → we remember lat/lng and show one draggable marker.
 * 2) User clicks "Generate route" → OSRM (`foot`) builds three road legs of roughly ¼ target each:
 *    random initial heading, then ~90° right twice; a fourth leg routes back to the start. We
 *    scale the first three leg targets so the full loop length is close to the slider distance,
 *    then draw the path, count traffic lights (Overpass), and estimate elevation (Open-Meteo).
 */

(function () {
  "use strict";

  // --- Public OSRM demo server (no API key). For production you'd host your own OSRM. ---
  var OSRM_BASE = "https://router.project-osrm.org";
  /** `foot` = pedestrian routing (roads, paths, sidewalks where mapped). */
  var OSRM_PROFILE = "foot";

  /** Overpass instance (community-run; be polite: one query per route, reasonable timeout). */
  var OVERPASS_URL = "https://overpass-api.de/api/interpreter";

  /**
   * Open-Meteo elevation API (CORS-friendly in the browser).
   * Docs: https://open-meteo.com/en/docs/elevation-api — up to 100 coordinates per request.
   */
  var OPEN_METEO_ELEVATION_URL = "https://api.open-meteo.com/v1/elevation";
  var OPEN_METEO_MAX_POINTS_PER_REQUEST = 100;

  /** Search this many meters from sample points along the route when counting signals. */
  var SIGNAL_SEARCH_RADIUS_M = 35;

  /** Cap route vertices sent for elevation; batches use OPEN_METEO_MAX_POINTS_PER_REQUEST. */
  var ELEVATION_MAX_SAMPLES = 180;
  var DIRECTION_ARROW_MIN_TURN_DEG = 20;
  var DIRECTION_ARROW_MIN_SEGMENT_M = 25;
  var OVERLAP_OFFSET_METERS = 4;
  var ROUTE_HIGHLIGHT_METERS = 100;

  /** Total loop length tolerance vs slider (meters or fraction of target). */
  var LOOP_DISTANCE_TOL_M = 90;
  var LOOP_DISTANCE_TOL_FRAC = 0.065;

  // --- Map setup (Leaflet creates a global `L`) ---
  var DEFAULT_CENTER = { lat: 43.4723, lng: -80.5449 }; // University of Waterloo fallback
  var DEFAULT_ZOOM = 12;
  var USER_LOCATION_ZOOM = 14;
  var map = L.map("map").setView([DEFAULT_CENTER.lat, DEFAULT_CENTER.lng], DEFAULT_ZOOM);

  L.tileLayer("https://tiles.stadiamaps.com/tiles/outdoors/{z}/{x}/{y}{r}.png", {
    maxZoom: 20,
    attribution: '© Stadia Maps, © OpenStreetMap'
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
  /** @type {L.LayerGroup|null} Turn-direction arrow markers drawn on the route. */
  var routeDirectionLayer = null;
  /** @type {L.LayerGroup|null} Offset segments for opposite-direction overlaps. */
  var routeOverlapLayer = null;
  /** @type {L.LayerGroup|null} Start/end flags and highlighted route sections. */
  var routeHighlightLayer = null;

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

  function initializeUserLocation() {
    if (!navigator.geolocation) {
      setStatus("Geolocation is unavailable. Map starts at the University of Waterloo.");
      return;
    }

    setStatus("Trying to find your location...");
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        setStartPoint(pos.coords.latitude, pos.coords.longitude, true);
        setStatus("Start point set to your current location. You can still click to move it.");
      },
      function () {
        setStatus("Could not access your location. Map starts at the University of Waterloo.");
      },
      {
        enableHighAccuracy: false,
        timeout: 4000,
        maximumAge: 300000,
      }
    );
  }

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

  function toOsrmCoord(lat, lng) {
    return lng + "," + lat;
  }

  /**
   * OSRM Route between two points. With `wantGeometry === false`, omits coordinates (smaller,
   * faster) — use while tuning leg length; then call again with true for the final polyline.
   */
  function fetchOsrmRouteParsed(fromLat, fromLng, toLat, toLng, wantGeometry) {
    if (wantGeometry === undefined) {
      wantGeometry = true;
    }
    var coordPath = toOsrmCoord(fromLat, fromLng) + ";" + toOsrmCoord(toLat, toLng);
    var params = new URLSearchParams({
      geometries: "geojson",
      steps: "false",
      continue_straight: "false",
    });
    params.set("overview", wantGeometry ? "full" : "false");
    var url =
      OSRM_BASE + "/route/v1/" + OSRM_PROFILE + "/" + coordPath + "?" + params.toString();
    return fetch(url).then(function (res) {
      if (!res.ok) {
        throw new Error("OSRM HTTP " + res.status);
      }
      return res.json();
    }).then(function (data) {
      if (data.code !== "Ok" || !data.routes || !data.routes.length) {
        throw new Error(data.message || "OSRM could not find a path between these points.");
      }
      var route = data.routes[0];
      var coords = null;
      if (wantGeometry) {
        if (!route.geometry || route.geometry.type !== "LineString") {
          throw new Error("Unexpected geometry from OSRM.");
        }
        coords = route.geometry.coordinates;
      }
      return {
        distanceMeters: route.distance,
        coordinates: coords,
      };
    });
  }

  function lastCoordLatLng(coordsLngLat) {
    var p = coordsLngLat[coordsLngLat.length - 1];
    return { lat: p[1], lng: p[0] };
  }

  function routeEndBearingDeg(coordsLngLat) {
    if (!coordsLngLat || coordsLngLat.length < 2) {
      return 0;
    }
    var n = coordsLngLat.length;
    return segmentBearingDeg(coordsLngLat[n - 2], coordsLngLat[n - 1]);
  }

  function appendLineStringCoords(baseLngLat, extLngLat) {
    if (!extLngLat || !extLngLat.length) {
      return baseLngLat.slice();
    }
    if (!baseLngLat || !baseLngLat.length) {
      return extLngLat.slice();
    }
    var out = baseLngLat.slice();
    var firstExt = extLngLat[0];
    var lastBase = out[out.length - 1];
    var startIdx =
      approxDistanceMeters(lastBase, firstExt) < 6 ? 1 : 0;
    for (var i = startIdx; i < extLngLat.length; i++) {
      out.push(extLngLat[i]);
    }
    return out;
  }

  /**
   * Finds a road route from `start` toward `bearingDeg` whose *routed* length is near
   * `targetMeters`, by binary-searching the crow-flight hint distance. Tuning uses distance-only
   * OSRM calls (`overview=false`); one final call returns full geometry for that hint.
   */
  function findRoadLegAlongBearing(startLat, startLng, bearingDeg, targetMeters) {
    var legTol = Math.max(65, targetMeters * 0.14);
    var maxCrow = Math.min(32000, Math.max(1800, targetMeters * 5.5));

    function routeDistanceAtCrow(crowMeters) {
      var e = offsetLatLng(startLat, startLng, crowMeters, bearingDeg);
      return fetchOsrmRouteParsed(startLat, startLng, e.lat, e.lng, false).then(function (parsed) {
        return {
          crowMeters: crowMeters,
          distanceMeters: parsed.distanceMeters,
        };
      });
    }

    function finalizeLeg(crowMeters) {
      var e = offsetLatLng(startLat, startLng, crowMeters, bearingDeg);
      return fetchOsrmRouteParsed(startLat, startLng, e.lat, e.lng, true).then(function (parsed) {
        return {
          distanceMeters: parsed.distanceMeters,
          coordinates: parsed.coordinates,
        };
      });
    }

    var hiCrow = Math.max(120, targetMeters * 0.28);
    var expandCount = 0;

    function expandHi() {
      return routeDistanceAtCrow(hiCrow).then(function (rec) {
        if (rec.distanceMeters >= targetMeters - legTol * 0.45) {
          return hiCrow;
        }
        expandCount++;
        if (expandCount > 18 || hiCrow >= maxCrow * 0.998) {
          throw new Error(
            "Could not extend far enough along roads in this direction. Try another start or distance."
          );
        }
        hiCrow = Math.min(maxCrow, hiCrow * 1.45);
        return expandHi();
      });
    }

    return expandHi().then(function (hiBracketCrow) {
      var loR = 28;
      var hiR = hiBracketCrow;
      var best = null;
      var bisectCount = 0;

      function oneBisect() {
        if (bisectCount++ > 14) {
          if (best) {
            return Promise.resolve(best.crowMeters);
          }
          throw new Error("OSRM could not tune leg distance.");
        }
        var mid = (loR + hiR) / 2;
        return routeDistanceAtCrow(mid).then(function (rec) {
          var d = rec.distanceMeters;
          if (
            !best ||
            Math.abs(d - targetMeters) < Math.abs(best.distanceMeters - targetMeters)
          ) {
            best = rec;
          }
          if (Math.abs(d - targetMeters) <= legTol) {
            return Promise.resolve(rec.crowMeters);
          }
          if (d > targetMeters) {
            hiR = mid;
          } else {
            loR = mid;
          }
          return oneBisect();
        });
      }

      return routeDistanceAtCrow(loR).then(function (loRec) {
        if (loRec.distanceMeters >= targetMeters + legTol) {
          loR = 10;
        }
        return oneBisect();
      });
    }).then(function (chosenCrowMeters) {
      return finalizeLeg(chosenCrowMeters);
    });
  }

  /**
   * Three road legs (~¼ target each, scaled), two right turns, then OSRM return to start.
   * Adjusts leg scale so d1+d2+d3+d4 ≈ target (leg 4 length follows geometry).
   */
  function buildRoadFollowingRightTurnLoop(startLat, startLng, targetDistanceKm) {
    var targetMeters = targetDistanceKm * 1000;
    var tolTotal = Math.max(LOOP_DISTANCE_TOL_M, targetMeters * LOOP_DISTANCE_TOL_FRAC);
    var bearing0 = Math.random() * 360;
    var legScale = 1;
    var outerMax = 7;

    function oneLoop(outerIdx) {
      var legTarget = (targetMeters / 4) * legScale;

      return findRoadLegAlongBearing(startLat, startLng, bearing0, legTarget)
        .then(function (leg1) {
          var end1 = lastCoordLatLng(leg1.coordinates);
          var b2 = routeEndBearingDeg(leg1.coordinates) + 90;
          return findRoadLegAlongBearing(end1.lat, end1.lng, b2, legTarget).then(function (leg2) {
            var end2 = lastCoordLatLng(leg2.coordinates);
            var b3 = routeEndBearingDeg(leg2.coordinates) + 90;
            return findRoadLegAlongBearing(end2.lat, end2.lng, b3, legTarget).then(function (leg3) {
              var end3 = lastCoordLatLng(leg3.coordinates);
              return fetchOsrmRouteParsed(
                end3.lat,
                end3.lng,
                startLat,
                startLng
              ).then(function (leg4) {
                var total =
                  leg1.distanceMeters +
                  leg2.distanceMeters +
                  leg3.distanceMeters +
                  leg4.distanceMeters;
                var err = targetMeters - total;

                if (Math.abs(err) <= tolTotal || outerIdx + 1 >= outerMax) {
                  var coords = appendLineStringCoords(
                    leg1.coordinates,
                    appendLineStringCoords(
                      leg2.coordinates,
                      appendLineStringCoords(leg3.coordinates, leg4.coordinates)
                    )
                  );
                  return {
                    geometry: { type: "LineString", coordinates: coords },
                    distanceMeters: total,
                  };
                }

                legScale *= 1 + (err / targetMeters) * 0.52;
                if (legScale < 0.32) {
                  legScale = 0.32;
                } else if (legScale > 2.35) {
                  legScale = 2.35;
                }
                return oneLoop(outerIdx + 1);
              });
            });
          });
        });
    }

    return oneLoop(0);
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

  function normalizeBearingDeg(bearing) {
    var b = bearing % 360;
    return b < 0 ? b + 360 : b;
  }

  function segmentBearingDeg(fromLngLat, toLngLat) {
    var fromLng = fromLngLat[0];
    var fromLat = fromLngLat[1];
    var toLng = toLngLat[0];
    var toLat = toLngLat[1];
    var latRad = ((fromLat + toLat) / 2) * (Math.PI / 180);
    var dx = (toLng - fromLng) * Math.cos(latRad);
    var dy = toLat - fromLat;
    var bearing = (Math.atan2(dx, dy) * 180) / Math.PI;
    return normalizeBearingDeg(bearing);
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

  function clearRouteVisuals() {
    if (routeLayer) {
      map.removeLayer(routeLayer);
      routeLayer = null;
    }
    if (routeDirectionLayer) {
      map.removeLayer(routeDirectionLayer);
      routeDirectionLayer = null;
    }
    if (routeOverlapLayer) {
      map.removeLayer(routeOverlapLayer);
      routeOverlapLayer = null;
    }
    if (routeHighlightLayer) {
      map.removeLayer(routeHighlightLayer);
      routeHighlightLayer = null;
    }
  }

  function midpointLngLat(aLngLat, bLngLat) {
    return [(aLngLat[0] + bLngLat[0]) / 2, (aLngLat[1] + bLngLat[1]) / 2];
  }

  function interpolateLngLat(aLngLat, bLngLat, t) {
    return [
      aLngLat[0] + (bLngLat[0] - aLngLat[0]) * t,
      aLngLat[1] + (bLngLat[1] - aLngLat[1]) * t,
    ];
  }

  function toLeafletLine(coordsLngLat) {
    var out = [];
    for (var i = 0; i < coordsLngLat.length; i++) {
      out.push([coordsLngLat[i][1], coordsLngLat[i][0]]);
    }
    return out;
  }

  function buildPrefixCoordsByDistance(coordsLngLat, distanceMeters) {
    if (!Array.isArray(coordsLngLat) || !coordsLngLat.length) {
      return [];
    }
    var out = [coordsLngLat[0]];
    var remaining = Math.max(0, distanceMeters);

    for (var i = 0; i < coordsLngLat.length - 1 && remaining > 0; i++) {
      var a = coordsLngLat[i];
      var b = coordsLngLat[i + 1];
      var segLen = approxDistanceMeters(a, b);
      if (segLen <= 0) {
        continue;
      }
      if (segLen <= remaining) {
        out.push(b);
        remaining -= segLen;
      } else {
        out.push(interpolateLngLat(a, b, remaining / segLen));
        remaining = 0;
      }
    }
    return out;
  }

  function buildSuffixCoordsByDistance(coordsLngLat, distanceMeters) {
    if (!Array.isArray(coordsLngLat) || !coordsLngLat.length) {
      return [];
    }
    var outReversed = [coordsLngLat[coordsLngLat.length - 1]];
    var remaining = Math.max(0, distanceMeters);

    for (var i = coordsLngLat.length - 1; i > 0 && remaining > 0; i--) {
      var a = coordsLngLat[i];
      var b = coordsLngLat[i - 1];
      var segLen = approxDistanceMeters(a, b);
      if (segLen <= 0) {
        continue;
      }
      if (segLen <= remaining) {
        outReversed.push(b);
        remaining -= segLen;
      } else {
        outReversed.push(interpolateLngLat(a, b, remaining / segLen));
        remaining = 0;
      }
    }
    return outReversed.reverse();
  }

  function drawStartEndHighlights(coordsLngLat) {
    if (!Array.isArray(coordsLngLat) || coordsLngLat.length < 2) {
      return;
    }
    routeHighlightLayer = L.layerGroup().addTo(map);

    var start = coordsLngLat[0];
    var end = coordsLngLat[coordsLngLat.length - 1];
    var endForMarker = end;
    if (approxDistanceMeters(start, end) < 3) {
      endForMarker = [end[0] + 0.00012, end[1]];
    }

    L.marker([start[1], start[0]], {
      interactive: false,
      keyboard: false,
      icon: L.divIcon({
        className: "start-flag-icon",
        html:
          '<div style="display:flex; align-items:flex-end; gap:2px;">' +
          '<div style="width:2px; height:18px; background:#2e2e2e;"></div>' +
          '<div style="width:0; height:0; border-top:6px solid transparent; border-bottom:6px solid transparent; border-left:12px solid #1b8f2e;"></div>' +
          "</div>",
        iconSize: [16, 20],
        iconAnchor: [2, 18],
      }),
    }).addTo(routeHighlightLayer);

    L.marker([endForMarker[1], endForMarker[0]], {
      interactive: false,
      keyboard: false,
      icon: L.divIcon({
        className: "finish-flag-icon",
        html: '<div style="font-size:18px; line-height:18px;">🏁</div>',
        iconSize: [18, 18],
        iconAnchor: [9, 16],
      }),
    }).addTo(routeHighlightLayer);

    var firstChunk = buildPrefixCoordsByDistance(coordsLngLat, ROUTE_HIGHLIGHT_METERS);
    if (firstChunk.length >= 2) {
      L.polyline(toLeafletLine(firstChunk), {
        color: "#2e7d32",
        weight: 7,
        opacity: 0.95,
        interactive: false,
      }).addTo(routeHighlightLayer);
    }

    var lastChunk = buildSuffixCoordsByDistance(coordsLngLat, ROUTE_HIGHLIGHT_METERS);
    if (lastChunk.length >= 2) {
      var lastLeaflet = toLeafletLine(lastChunk);
      L.polyline(lastLeaflet, {
        color: "#111111",
        weight: 7,
        opacity: 0.95,
        dashArray: "12 12",
        dashOffset: "0",
        interactive: false,
      }).addTo(routeHighlightLayer);
      L.polyline(lastLeaflet, {
        color: "#ffffff",
        weight: 7,
        opacity: 0.95,
        dashArray: "12 12",
        dashOffset: "12",
        interactive: false,
      }).addTo(routeHighlightLayer);
    }
  }

  function offsetPointLngLat(lngLat, normalX, normalY, meters) {
    var lat = lngLat[1];
    var metersPerDegLat = 111320;
    var metersPerDegLng = 111320 * Math.cos((lat * Math.PI) / 180);
    var dLng = (normalX * meters) / Math.max(metersPerDegLng, 1e-6);
    var dLat = (normalY * meters) / metersPerDegLat;
    return [lngLat[0] + dLng, lat + dLat];
  }

  function buildSegmentKey(aLngLat, bLngLat) {
    var ax = aLngLat[0].toFixed(6);
    var ay = aLngLat[1].toFixed(6);
    var bx = bLngLat[0].toFixed(6);
    var by = bLngLat[1].toFixed(6);
    var forward = ax + "," + ay + "|" + bx + "," + by;
    var reverse = bx + "," + by + "|" + ax + "," + ay;
    return forward < reverse
      ? { undirected: forward, direction: 1 }
      : { undirected: reverse, direction: -1 };
  }

  function drawOppositeDirectionOffsets(coordsLngLat) {
    if (!Array.isArray(coordsLngLat) || coordsLngLat.length < 2) {
      return;
    }
    var seenDirectionsByKey = {};
    routeOverlapLayer = L.layerGroup().addTo(map);

    for (var i = 0; i < coordsLngLat.length - 1; i++) {
      var a = coordsLngLat[i];
      var b = coordsLngLat[i + 1];
      var len = approxDistanceMeters(a, b);
      if (len < DIRECTION_ARROW_MIN_SEGMENT_M) {
        continue;
      }

      var keyInfo = buildSegmentKey(a, b);
      var seen = seenDirectionsByKey[keyInfo.undirected];
      if (!seen) {
        seenDirectionsByKey[keyInfo.undirected] = keyInfo.direction;
        continue;
      }
      if (seen === keyInfo.direction) {
        continue;
      }

      var dx = b[0] - a[0];
      var dy = b[1] - a[1];
      var mag = Math.sqrt(dx * dx + dy * dy);
      if (mag < 1e-12) {
        continue;
      }
      var normalX = (-dy / mag) * keyInfo.direction;
      var normalY = (dx / mag) * keyInfo.direction;
      var aOffset = offsetPointLngLat(a, normalX, normalY, OVERLAP_OFFSET_METERS);
      var bOffset = offsetPointLngLat(b, normalX, normalY, OVERLAP_OFFSET_METERS);

      L.polyline(
        [
          [aOffset[1], aOffset[0]],
          [bOffset[1], bOffset[0]],
        ],
        {
          color: "#42a5f5",
          weight: 3,
          opacity: 0.95,
          interactive: false,
        }
      ).addTo(routeOverlapLayer);
    }
  }

  function drawDirectionArrows(coordsLngLat) {
    if (!Array.isArray(coordsLngLat) || coordsLngLat.length < 2) {
      return;
    }

    var segments = [];
    for (var i = 0; i < coordsLngLat.length - 1; i++) {
      var from = coordsLngLat[i];
      var to = coordsLngLat[i + 1];
      var segLen = approxDistanceMeters(from, to);
      if (segLen <= 0) {
        continue;
      }
      segments.push({
        from: from,
        to: to,
        length: segLen,
        bearing: segmentBearingDeg(from, to),
      });
    }
    if (!segments.length) {
      return;
    }

    function pointAtDistanceOnRun(startSegIdx, endSegIdx, targetDistanceM) {
      var acc = 0;
      for (var s = startSegIdx; s <= endSegIdx; s++) {
        var seg = segments[s];
        if (acc + seg.length >= targetDistanceM) {
          var localT = (targetDistanceM - acc) / seg.length;
          return {
            point: interpolateLngLat(seg.from, seg.to, localT),
            bearing: seg.bearing,
          };
        }
        acc += seg.length;
      }
      var lastSeg = segments[endSegIdx];
      return {
        point: midpointLngLat(lastSeg.from, lastSeg.to),
        bearing: lastSeg.bearing,
      };
    }

    var runs = [];
    var runStart = 0;
    var runLength = segments[0].length;
    var runBearing = segments[0].bearing;

    for (var j = 1; j < segments.length; j++) {
      var segJ = segments[j];
      var isTurn = bearingDeltaDeg(runBearing, segJ.bearing) >= DIRECTION_ARROW_MIN_TURN_DEG;
      if (isTurn) {
        runs.push({
          startIdx: runStart,
          endIdx: j - 1,
          length: runLength,
        });
        runStart = j;
        runLength = segJ.length;
        runBearing = segJ.bearing;
      } else {
        runLength += segJ.length;
        runBearing = segJ.bearing;
      }
    }
    runs.push({
      startIdx: runStart,
      endIdx: segments.length - 1,
      length: runLength,
    });

    routeDirectionLayer = L.layerGroup().addTo(map);

    for (var r = 0; r < runs.length; r++) {
      var run = runs[r];
      if (run.length < DIRECTION_ARROW_MIN_SEGMENT_M) {
        continue;
      }
      var arrowAt = pointAtDistanceOnRun(run.startIdx, run.endIdx, run.length / 2);
      var rotationDeg = arrowAt.bearing - 90;

      L.marker([arrowAt.point[1], arrowAt.point[0]], {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
          className: "direction-arrow-icon",
          html:
            '<svg width="18" height="18" viewBox="0 0 18 18" ' +
            'style="transform: rotate(' +
            rotationDeg +
            'deg); transform-origin: center center; opacity: 0.95;">' +
            '<path d="M3 4 L11 9 L3 14" stroke="#111111" stroke-width="3" fill="none" ' +
            'stroke-linecap="round" stroke-linejoin="round"></path></svg>',
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        }),
      }).addTo(routeDirectionLayer);
    }
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
    clearRouteVisuals();
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
    drawStartEndHighlights(geojsonLineString.coordinates);
    drawOppositeDirectionOffsets(geojsonLineString.coordinates);
    drawDirectionArrows(geojsonLineString.coordinates);

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
    setStartPoint(ll.lat, ll.lng, false);
    setStatus("Start point set. Adjust distance if you like, then generate.");
  });

  slider.addEventListener("input", syncDistanceLabel);
  syncDistanceLabel();

  function generateRoute() {
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

    function buildWithBearingRetries() {
      var tries = 0;
      function attempt() {
        return buildRoadFollowingRightTurnLoop(
          startPoint.lat,
          startPoint.lng,
          targetKm
        ).catch(function (err) {
          tries++;
          if (tries < 4) {
            return attempt();
          }
          throw err;
        });
      }
      return attempt();
    }

    buildWithBearingRetries()
      .then(function (built) {
        drawRoute(built.geometry);

        var coords = built.geometry.coordinates;
        var distanceMeters = built.distanceMeters;

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
        clearRouteVisuals();
      })
      .finally(function () {
        generateBtn.disabled = false;
      });
  }

  generateBtn.addEventListener("click", generateRoute);

  slider.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") {
      ev.preventDefault();
      generateRoute();
    }
  });

  setTimeout(function () {
    initializeUserLocation();
  }, 0);
})();
