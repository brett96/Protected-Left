import L from "leaflet";
import "leaflet/dist/leaflet.css";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import "./style.css";
import { attachAddressAutocomplete } from "./addressAutocomplete";
import { startRandomPathPreview } from "./randomPathPreview";
import {
  formatDistance,
  formatDuration,
  summarizeAndPickBest,
  type OsrmRouteSummary,
} from "./routing";
import { addressesMatch, geocodeAddress } from "./geocode";
import { SITE_FOOTER_HTML } from "./footer";
import { type PhotonPlace, photonReverse } from "./photon";

L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

const ROUTE_OPTION_COLORS = ["#58a6ff", "#d29922", "#a371f7", "#f778ba"] as const;

const START_PIN_HTML = `<div class="start-pin-inner" aria-hidden="true">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 36" width="36" height="48">
  <path fill="#58a6ff" d="M12 0C7.6 0 4 3.6 4 8c0 6.5 8 15.2 8 28 0-12.8 8-21.5 8-28 0-4.4-3.6-8-8-8z"/>
  <circle cx="12" cy="9" r="3.2" fill="#fff"/>
</svg>
</div>`;

const DEST_PIN_HTML = `<div class="dest-pin-inner" aria-hidden="true">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 36" width="36" height="48">
  <path fill="#f85149" d="M12 0C7.6 0 4 3.6 4 8c0 6.5 8 15.2 8 28 0-12.8 8-21.5 8-28 0-4.4-3.6-8-8-8z"/>
  <circle cx="12" cy="9" r="3.2" fill="#fff"/>
</svg>
</div>`;

function createStartIcon(): L.DivIcon {
  return L.divIcon({
    className: "start-pin-marker",
    html: START_PIN_HTML,
    iconSize: [36, 48],
    iconAnchor: [18, 48],
    popupAnchor: [0, -44],
  });
}

function createDestIcon(): L.DivIcon {
  return L.divIcon({
    className: "dest-pin-marker",
    html: DEST_PIN_HTML,
    iconSize: [36, 48],
    iconAnchor: [18, 48],
    popupAnchor: [0, -44],
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type OsrmRoute = {
  duration: number;
  distance: number;
  geometry: GeoJSON.LineString | GeoJSON.MultiLineString;
  legs: Array<{
    steps: Array<{
      maneuver?: { modifier?: string; type?: string };
    }>;
  }>;
};

type OsrmResponse = {
  code: string;
  routes?: OsrmRoute[];
  message?: string;
};

function osrmBaseUrl(): string {
  return import.meta.env.DEV ? `${window.location.origin}/osrm` : "https://router.project-osrm.org";
}

async function fetchRoutes(
  fromLon: number,
  fromLat: number,
  toLon: number,
  toLat: number,
): Promise<OsrmRoute[]> {
  const coords = `${fromLon},${fromLat};${toLon},${toLat}`;
  const params = new URLSearchParams({
    overview: "full",
    geometries: "geojson",
    steps: "true",
    alternatives: "true",
  });
  const url = `${osrmBaseUrl()}/route/v1/driving/${coords}?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Routing service error (${res.status})`);
  const data = (await res.json()) as OsrmResponse;
  if (data.code !== "Ok" || !data.routes?.length) {
    throw new Error(data.message || "Could not compute a driving route.");
  }
  return data.routes;
}

function routeToLatLngs(route: OsrmRoute): L.LatLngExpression[] {
  const g = route.geometry;
  if (g.type === "LineString") {
    return g.coordinates.map(([lon, lat]) => [lat, lon] as L.LatLngTuple);
  }
  if (g.type === "MultiLineString") {
    const out: L.LatLngTuple[] = [];
    for (const line of g.coordinates) {
      for (const [lon, lat] of line) out.push([lat, lon]);
    }
    return out;
  }
  return [];
}

async function resolvePlaceOrGeocode(
  input: HTMLInputElement,
  cached: PhotonPlace | null,
): Promise<PhotonPlace> {
  const t = input.value.trim();
  if (!t) throw new Error("Address is empty.");
  if (cached && addressesMatch(t, cached.label)) return cached;
  return geocodeAddress(t);
}

function buildApp() {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) throw new Error("#app missing");

  root.innerHTML = `
    <header class="app-header">
      <div class="brand">
        <h1>Protected Left</h1>
        <span>GPS · fewer left turns</span>
      </div>
      <div class="controls">
        <div class="controls-fields">
          <div class="field-wrap">
            <label for="start">Starting point</label>
            <div class="input-with-suggestions">
              <input type="text" id="start" placeholder="Type any address (suggestions optional)" autocomplete="off" spellcheck="false" />
              <ul id="start-list" class="autocomplete-list" hidden></ul>
            </div>
          </div>
          <div class="field-wrap">
            <label for="dest">Destination</label>
            <div class="input-with-suggestions">
              <input type="text" id="dest" placeholder="Type any address (suggestions optional)" autocomplete="off" spellcheck="false" />
              <ul id="dest-list" class="autocomplete-list" hidden></ul>
            </div>
          </div>
        </div>
        <div class="controls-actions">
          <button type="button" id="go">Route</button>
          <button type="button" class="secondary" id="here">Use my location</button>
        </div>
      </div>
    </header>
    <div class="map-wrap">
      <div id="map"></div>
      <div id="route-loading-overlay" class="route-loading-overlay" hidden>
        <div class="route-loading-card" role="status" aria-live="polite">
          <div class="route-loading-spinner-lg" aria-hidden="true"></div>
          <p class="route-loading-title" id="overlay-title">Loading…</p>
          <p class="route-loading-sub" id="overlay-sub"></p>
        </div>
      </div>
      <div class="panel" id="panel">
        <p class="muted">
          Type a full street address and tap <strong>Route</strong>.  If an address isn't found, enter a nearby location, and the dropped pin can be dragged and dropped to the correct location. The app compares driving routes from <a href="https://project-osrm.org/" target="_blank" rel="noopener">OSRM</a> and picks the one with the
          <strong>fewest left turns</strong>. This is an approximation, not a guarantee of protected left signals.
        </p>
        <div id="status-row" class="status-row" role="status" aria-live="polite">
          <span class="route-spinner" aria-hidden="true"></span>
          <p id="status" class="status-bar"></p>
        </div>
        <div id="stats" class="stats"></div>
      </div>
    </div>
    ${SITE_FOOTER_HTML}
  `;

  const map = L.map("map", { zoomControl: true, preferCanvas: true }).setView([39.8283, -98.5795], 4);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);

  requestAnimationFrame(() => {
    map.invalidateSize();
  });
  window.addEventListener("resize", () => {
    map.invalidateSize();
  });

  let startResolved: PhotonPlace | null = null;
  let destResolved: PhotonPlace | null = null;
  let startMarker: L.Marker | null = null;
  let destMarker: L.Marker | null = null;
  let finalRouteLayer: L.Polyline | null = null;
  let analysisPolylines: L.Polyline[] = [];

  const overlayEl = root.querySelector<HTMLDivElement>("#route-loading-overlay")!;
  const overlayTitleEl = root.querySelector<HTMLParagraphElement>("#overlay-title")!;
  const overlaySubEl = root.querySelector<HTMLParagraphElement>("#overlay-sub")!;
  const statusRowEl = root.querySelector<HTMLDivElement>("#status-row")!;
  const statusEl = root.querySelector<HTMLParagraphElement>("#status")!;
  const statsEl = root.querySelector<HTMLDivElement>("#stats")!;
  const startInput = root.querySelector<HTMLInputElement>("#start")!;
  const destInput = root.querySelector<HTMLInputElement>("#dest")!;
  const goBtn = root.querySelector<HTMLButtonElement>("#go")!;
  const startListEl = root.querySelector<HTMLUListElement>("#start-list")!;
  const destListEl = root.querySelector<HTMLUListElement>("#dest-list")!;

  const startAc = attachAddressAutocomplete(startInput, startListEl, {
    onSelect: (place) => {
      setStartMarker(place);
      map.setView([place.lat, place.lon], Math.max(map.getZoom(), 13));
    },
    onClear: () => {
      startResolved = null;
      startMarker?.remove();
      startMarker = null;
    },
  });

  const destAc = attachAddressAutocomplete(destInput, destListEl, {
    onSelect: (place) => {
      setDestMarker(place);
      map.setView([place.lat, place.lon], Math.max(map.getZoom(), 13));
    },
    onClear: () => {
      destResolved = null;
      destMarker?.remove();
      destMarker = null;
    },
  });

  function setMarkerDraggingEnabled(enabled: boolean) {
    const method = enabled ? "enable" : "disable";
    if (startMarker?.dragging) startMarker.dragging[method]();
    if (destMarker?.dragging) destMarker.dragging[method]();
  }

  function setStartMarker(place: PhotonPlace) {
    startResolved = place;
    startInput.value = place.label;
    startMarker?.remove();
    const m = L.marker([place.lat, place.lon], {
      icon: createStartIcon(),
      draggable: true,
    })
      .addTo(map)
      .bindPopup(`<strong>Starting point</strong><br/>${place.label}`);
    startMarker = m;
    m.on("dragend", async () => {
      const ll = m.getLatLng();
      try {
        const rev = await photonReverse(ll.lng, ll.lat);
        startResolved = rev;
        startInput.value = rev.label;
        startAc.syncSelectionLabel(rev.label);
        m.setPopupContent(`<strong>Starting point</strong><br/>${rev.label}`);
      } catch {
        const label = `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`;
        startResolved = { lat: ll.lat, lon: ll.lng, label };
        startInput.value = label;
        startAc.syncSelectionLabel(label);
        m.setPopupContent(`<strong>Starting point</strong><br/>${label}`);
      }
    });
    startAc.syncSelectionLabel(place.label);
    setMarkerDraggingEnabled(overlayEl.hidden);
  }

  function setDestMarker(place: PhotonPlace) {
    destResolved = place;
    destInput.value = place.label;
    destMarker?.remove();
    const m = L.marker([place.lat, place.lon], {
      icon: createDestIcon(),
      draggable: true,
    })
      .addTo(map)
      .bindPopup(`<strong>Destination</strong><br/>${place.label}`);
    destMarker = m;
    m.on("dragend", async () => {
      const ll = m.getLatLng();
      try {
        const rev = await photonReverse(ll.lng, ll.lat);
        destResolved = rev;
        destInput.value = rev.label;
        destAc.syncSelectionLabel(rev.label);
        m.setPopupContent(`<strong>Destination</strong><br/>${rev.label}`);
      } catch {
        const label = `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`;
        destResolved = { lat: ll.lat, lon: ll.lng, label };
        destInput.value = label;
        destAc.syncSelectionLabel(label);
        m.setPopupContent(`<strong>Destination</strong><br/>${label}`);
      }
    });
    destAc.syncSelectionLabel(place.label);
    setMarkerDraggingEnabled(overlayEl.hidden);
  }

  function setStatus(text: string, loading = false, routeFetching = false) {
    statusEl.textContent = text;
    statusRowEl.classList.toggle("loading", loading);
    statusRowEl.classList.toggle("route-fetching", routeFetching);
    statusRowEl.setAttribute("aria-busy", loading ? "true" : "false");
  }

  function showRouteOverlay(title: string, sub = "") {
    overlayTitleEl.textContent = title;
    overlaySubEl.textContent = sub;
    overlayEl.hidden = false;
    map.dragging.disable();
    map.scrollWheelZoom.disable();
    map.doubleClickZoom.disable();
    map.boxZoom.disable();
    map.keyboard.disable();
    setMarkerDraggingEnabled(false);
  }

  function setOverlayCopy(title: string, sub = "") {
    overlayTitleEl.textContent = title;
    overlaySubEl.textContent = sub;
  }

  function hideRouteOverlay() {
    overlayEl.hidden = true;
    overlaySubEl.textContent = "";
    map.dragging.enable();
    map.scrollWheelZoom.enable();
    map.doubleClickZoom.enable();
    map.boxZoom.enable();
    map.keyboard.enable();
    setMarkerDraggingEnabled(true);
  }

  function clearAnalysisLayers() {
    for (const p of analysisPolylines) {
      p.remove();
    }
    analysisPolylines = [];
  }

  /** Clears computed route geometry and summary only; keeps start/destination pins. */
  function clearRoutePaths() {
    finalRouteLayer?.remove();
    finalRouteLayer = null;
    clearAnalysisLayers();
    statsEl.innerHTML = "";
  }

  function setRoutingBusy(busy: boolean) {
    goBtn.disabled = busy;
    startInput.disabled = busy;
    destInput.disabled = busy;
  }

  async function animateRouteComparison(
    routes: OsrmRoute[],
    summaries: OsrmRouteSummary[],
    msPerStep = 320,
  ): Promise<void> {
    clearAnalysisLayers();
    const latlngsList = routes.map((r) => routeToLatLngs(r));
    const allPoints = latlngsList.flat() as L.LatLngTuple[];
    if (allPoints.length) {
      map.fitBounds(L.latLngBounds(allPoints), { padding: [88, 88], maxZoom: 14 });
    }

    for (let i = 0; i < routes.length; i++) {
      const c = ROUTE_OPTION_COLORS[i % ROUTE_OPTION_COLORS.length];
      const line = L.polyline(latlngsList[i]!, {
        color: c,
        weight: 5,
        opacity: 0.28,
        lineCap: "round",
        lineJoin: "round",
      }).addTo(map);
      analysisPolylines.push(line);
    }

    if (analysisPolylines.length === 0) return;

    setOverlayCopy("Comparing route options", "");

    if (analysisPolylines.length === 1) {
      const only = analysisPolylines[0]!;
      only.setStyle({ weight: 9, opacity: 0.95 });
      setOverlayCopy("Comparing route options", "Only one driving route returned for this trip.");
      await delay(420);
      return;
    }

    const cycles = 1;
    for (let c = 0; c < cycles; c++) {
      for (let i = 0; i < analysisPolylines.length; i++) {
        const s = summaries[i];
        if (!s) continue;
        setOverlayCopy(
          "Comparing route options",
          `Highlighting option ${i + 1} of ${analysisPolylines.length} · ${s.leftTurns} left turn${s.leftTurns === 1 ? "" : "s"} · ${formatDuration(s.durationSec)}`,
        );
        analysisPolylines.forEach((ly, j) => {
          const isActive = j === i;
          ly.setStyle({
            weight: isActive ? 10 : 5,
            opacity: isActive ? 0.95 : 0.2,
          });
          ly.bringToFront();
        });
        await delay(msPerStep);
      }
    }
  }

  async function routeToDestination() {
    const destQ = destInput.value.trim();
    const startQ = startInput.value.trim();
    if (!startQ) {
      setStatus("Enter a starting point, or use “Use my location”.");
      return;
    }
    if (!destQ) {
      setStatus("Enter a destination.");
      return;
    }

    clearRoutePaths();
    setStatus("", false);
    setRoutingBusy(true);
    try {
      showRouteOverlay("Resolving places…", "Matching addresses on the map (Photon + OSM).");

      const [startRes, destRes] = await Promise.allSettled([
        resolvePlaceOrGeocode(startInput, startResolved),
        resolvePlaceOrGeocode(destInput, destResolved),
      ]);

      if (startRes.status === "rejected") {
        hideRouteOverlay();
        setStatus(
          startRes.reason instanceof Error
            ? startRes.reason.message
            : "Could not find the starting point.",
        );
        return;
      }
      if (destRes.status === "rejected") {
        hideRouteOverlay();
        setStatus(
          destRes.reason instanceof Error
            ? destRes.reason.message
            : "Could not find the destination.",
        );
        return;
      }

      const startPlace = startRes.value;
      const destPlace = destRes.value;
      startResolved = startPlace;
      destResolved = destPlace;
      setStartMarker(startPlace);
      setDestMarker(destPlace);

      const previewBounds = L.latLngBounds(
        [startPlace.lat, startPlace.lon] as L.LatLngTuple,
        [destPlace.lat, destPlace.lon] as L.LatLngTuple,
      );
      map.fitBounds(previewBounds, { padding: [100, 100], maxZoom: 13 });

      setOverlayCopy("Fetching route options…", "");

      let stopRandomPreview: (() => void) | null = null;
      let routes: OsrmRoute[];
      try {
        stopRandomPreview = startRandomPathPreview(
          map,
          () => {
            if (!startMarker || !destMarker) return null;
            const a = startMarker.getLatLng();
            const b = destMarker.getLatLng();
            return [[a.lat, a.lng], [b.lat, b.lng]] as const;
          },
          { intervalMs: 72, maxLines: 12 },
        );
        const s = startMarker!.getLatLng();
        const d = destMarker!.getLatLng();
        routes = await fetchRoutes(s.lng, s.lat, d.lng, d.lat);
      } catch (e) {
        hideRouteOverlay();
        setStatus(e instanceof Error ? e.message : "Routing failed.");
        return;
      } finally {
        stopRandomPreview?.();
      }

      const { summaries, best } = summarizeAndPickBest(routes);
      if (!best) {
        hideRouteOverlay();
        setStatus("No route could be selected.");
        return;
      }

      await animateRouteComparison(routes, summaries);

      clearAnalysisLayers();
      hideRouteOverlay();

      const chosen = routes[best.index]!;
      const latlngs = routeToLatLngs(chosen);
      finalRouteLayer = L.polyline(latlngs, {
        color: "#3fb950",
        weight: 7,
        opacity: 0.95,
        lineCap: "round",
        lineJoin: "round",
      }).addTo(map);

      map.fitBounds(L.latLngBounds(latlngs), { padding: [56, 56], maxZoom: 15 });

      const others = summaries
        .filter((s) => s.index !== best.index)
        .map(
          (s) =>
            `Option ${s.index + 1}: ${s.leftTurns} left turns, ${formatDuration(s.durationSec)}`,
        )
        .join(" · ");

      setStatus("");
      statsEl.innerHTML = `
      <div>
        <strong>Chosen route</strong><br />
        ${best.leftTurns} left turn${best.leftTurns === 1 ? "" : "s"} ·
        ${formatDuration(best.durationSec)} ·
        ${formatDistance(best.distanceM)}
      </div>
      ${
        others
          ? `<div class="muted">Other options: ${others}</div>`
          : '<div class="muted">Only one route was returned for this trip.</div>'
      }
    `;
    } catch (e) {
      hideRouteOverlay();
      clearAnalysisLayers();
      setStatus(e instanceof Error ? e.message : "Routing failed.");
    } finally {
      setRoutingBusy(false);
    }
  }

  root.querySelector("#here")!.addEventListener("click", () => {
    setStatus("Getting your location…", true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        try {
          const place = await photonReverse(longitude, latitude);
          setStartMarker(place);
          map.setView([place.lat, place.lon], 14);
          setStatus("Starting point set from your location. Add a destination.");
        } catch {
          const place: PhotonPlace = {
            lat: latitude,
            lon: longitude,
            label: `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`,
          };
          setStartMarker(place);
          map.setView([latitude, longitude], 14);
          setStatus("Starting point set (coordinates only). Add a destination.");
        }
      },
      () => {
        setStatus(
          "Could not read your location. Allow location access in the browser, or try HTTPS / localhost.",
        );
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  });

  root.querySelector("#go")!.addEventListener("click", () => void routeToDestination());

  destInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") void routeToDestination();
  });
}

buildApp();
