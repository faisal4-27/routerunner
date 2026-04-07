/**
 * Route Runner — starter script
 * Next steps: wire the slider + button to OSRM, Overpass, and OpenTopoData.
 */

(function () {
  "use strict";

  // Default view: roughly central Europe (change to your home area while developing)
  const map = L.map("map").setView([48.137, 11.575], 12);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  const slider = document.getElementById("distance-slider");
  const distanceReadout = document.getElementById("distance-value");

  function formatKm(value) {
    var n = parseFloat(value);
    return (Math.round(n * 10) / 10).toString().replace(/\.0$/, "") + " km";
  }

  function syncDistanceLabel() {
    distanceReadout.textContent = formatKm(slider.value);
  }

  slider.addEventListener("input", syncDistanceLabel);
  syncDistanceLabel();

  document.getElementById("generate-btn").addEventListener("click", function () {
    console.log("Generate route — distance km:", slider.value);
    // OSRM / Overpass / elevation logic will go here
  });
})();
