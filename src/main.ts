import "./vercelAnalytics";
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
  instructionFromOsrmStep,
  pickBestOnlyRightBaseline,
  summarizeAndPickBest,
  summarizeRoutesWithRisk,
  type OsrmRouteSummary,
} from "./routing";
import { addressesMatch, geocodeAddress } from "./geocode";
import { SITE_FOOTER_HTML } from "./footer";
import { optimizeRouteOnlyRightTurns, type DetourRouteInput } from "./onlyRightDetour";
import { discoverNeighborhoodDetourRoutes } from "./routeDiscovery";
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
      name?: string;
      ref?: string;
      distance?: number;
      classes?: string[];
      maneuver?: {
        modifier?: string;
        type?: string;
        instruction?: string;
        exit?: number;
        bearing_before?: number;
        bearing_after?: number;
        /** OSRM provides [lon, lat] */
        location?: [number, number];
      };
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

function isTimeoutAbortError(e: unknown): boolean {
  if (typeof DOMException !== "undefined" && e instanceof DOMException && e.name === "AbortError") {
    return true;
  }
  if (e instanceof Error) {
    if (e.name === "AbortError") return true;
    if (/aborted/i.test(e.message)) return true;
  }
  return false;
}

function parseHttpStatusFromRoutingError(e: unknown): number | null {
  if (!(e instanceof Error)) return null;
  const m = e.message.match(/\((\d+)\)/);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  return Number.isFinite(n) ? n : null;
}

/** Timeouts, 502/503/504 — worth retrying with simpler / longer requests. */
function isRetryableOsrmFailure(e: unknown): boolean {
  if (isTimeoutAbortError(e)) return true;
  const s = parseHttpStatusFromRoutingError(e);
  return s !== null && (s === 502 || s === 503 || s === 504);
}

function formatRoutingFailureMessage(e: unknown): string {
  if (isTimeoutAbortError(e)) {
    return "The routing service took too long to respond. Try again in a moment.";
  }
  if (e instanceof Error) return e.message;
  return "Routing failed.";
}

async function fetchRoutes(
  fromLon: number,
  fromLat: number,
  toLon: number,
  toLat: number,
): Promise<OsrmRoute[]> {
  const coords = `${fromLon},${fromLat};${toLon},${toLat}`;

  async function attempt(alternatives: boolean, timeoutMs: number): Promise<OsrmRoute[]> {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const params = new URLSearchParams({
        // `full` keeps every shape point so the map follows actual roads; `simplified`
        // chops vertices and reads as straight chords across curves.
        overview: "full",
        geometries: "geojson",
        steps: "true",
        alternatives: alternatives ? "true" : "false",
      });
      const url = `${osrmBaseUrl()}/route/v1/driving/${coords}?${params}`;
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`Routing service error (${res.status})`);
      const data = (await res.json()) as OsrmResponse;
      if (data.code !== "Ok" || !data.routes?.length) {
        throw new Error(data.message || "Could not compute a driving route.");
      }
      return data.routes;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  try {
    // Public OSRM can be slow with alternatives=true; generous first attempt, then simplify + extend.
    return await attempt(true, 60000);
  } catch (e) {
    if (!isRetryableOsrmFailure(e)) throw e;
    try {
      return await attempt(false, 50000);
    } catch (e2) {
      if (!isRetryableOsrmFailure(e2)) throw e2;
      return await attempt(false, 90000);
    }
  }
}

async function fetchRouteViaWaypoints(
  start: L.LatLngTuple,
  end: L.LatLngTuple,
  via: L.LatLngTuple[],
  opts?: {
    timeoutMs?: number;
    viaBearings?: Array<{ bearing: number; range: number } | null>;
    viaRadiuses?: Array<number | null>;
  },
): Promise<OsrmRoute> {
  const viaCount = via.length;
  const defaultBudget = Math.min(12000, 5000 + viaCount * 900);
  const budgetMs = opts?.timeoutMs !== undefined ? opts.timeoutMs : defaultBudget;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), budgetMs);

  const coords = [[start, ...via, end]]
    .flat()
    .map((ll) => `${ll[1]},${ll[0]}`)
    .join(";");

  const params = new URLSearchParams({
    overview: "full",
    geometries: "geojson",
    steps: "true",
    alternatives: "false",
  });

  const vb = opts?.viaBearings;
  if (vb && vb.length === viaCount) {
    const bearingParts: string[] = ["0,180"];
    for (let i = 0; i < viaCount; i++) {
      const b = vb[i];
      bearingParts.push(b ? `${Math.round(b.bearing)},${Math.round(b.range)}` : "0,180");
    }
    bearingParts.push("0,180");
    params.set("bearings", bearingParts.join(";"));
  }

  const vr = opts?.viaRadiuses;
  if (vr && vr.length === viaCount) {
    const radiusParts: string[] = ["unlimited"];
    for (let i = 0; i < viaCount; i++) {
      const r = vr[i];
      radiusParts.push(r != null && Number.isFinite(r) ? String(Math.round(r)) : "unlimited");
    }
    radiusParts.push("unlimited");
    params.set("radiuses", radiusParts.join(";"));
  }

  const url = `${osrmBaseUrl()}/route/v1/driving/${coords}?${params}`;
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Routing service error (${res.status})`);
    const data = (await res.json()) as OsrmResponse;
    if (data.code !== "Ok" || !data.routes?.length) {
      throw new Error(data.message || "Could not compute a driving route.");
    }
    return data.routes[0]!;
  } finally {
    window.clearTimeout(timeoutId);
  }
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
              <input type="text" id="start" placeholder="Type any address (suggestions optional)" autocomplete="off" spellcheck="false" enterkeyhint="search" inputmode="text" />
              <ul id="start-list" class="autocomplete-list" hidden></ul>
            </div>
          </div>
          <div class="field-wrap">
            <label for="dest">Destination</label>
            <div class="input-with-suggestions">
              <input type="text" id="dest" placeholder="Type any address (suggestions optional)" autocomplete="off" spellcheck="false" enterkeyhint="go" inputmode="text" />
              <ul id="dest-list" class="autocomplete-list" hidden></ul>
            </div>
          </div>
        </div>
        <div class="controls-actions">
          <label class="toggle-option" title="Picks the OSRM alternative with the lowest risk-weighted left-turn score (arterials count more than residential streets), then tries jug-handle detours on the worst lefts first.">
            <input type="checkbox" id="only-right" />
            Only Right Turns
          </label>
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
        <button type="button" class="panel-collapse-btn" id="panel-collapse-btn" aria-expanded="true" aria-controls="panel-inner" aria-label="Minimize route info">−</button>
        <div class="panel-collapsed-only" id="panel-collapsed-only">Navigation Info</div>
        <div class="panel-inner" id="panel-inner">
          <p class="muted">
            Type a full street address and tap <strong>Route</strong>.  If an address isn't found, enter a nearby location, and the dropped pin can be dragged and dropped to the correct location. The app compares driving routes from <a href="https://project-osrm.org/" target="_blank" rel="noopener">OSRM</a> and picks the one with the
            <strong>fewest left turns</strong>. With <strong>Only Right Turns</strong>, it also tries extra side-street paths OSRM may not list, then scores options by how risky each left is (arterials vs neighborhoods). This is an approximation, not a guarantee of protected left signals.
          </p>
          <div id="status-row" class="status-row" role="status" aria-live="polite">
            <span class="route-spinner" aria-hidden="true"></span>
            <p id="status" class="status-bar"></p>
          </div>
          <div id="stats" class="stats"></div>
        </div>
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

  type RouteAlternativesSession = {
    routes: OsrmRoute[];
    summaries: OsrmRouteSummary[];
    activeIndex: number;
    /** Index OSRM chose for fewest left turns (for “suggested” note). */
    bestIndex: number;
    onlyRightMode: boolean;
    strictOnlyRight: boolean;
    allowedIndices: number[];
  };
  let routeAlternativesSession: RouteAlternativesSession | null = null;

  type NavStep = {
    index: number;
    latlng: L.LatLngTuple;
    instruction: string;
  };

  type NavigationSession = {
    watchId: number;
    activeStepIndex: number;
    spokenUpcoming: Set<number>;
    lastRealtimeSpokenStepIndex: number | null;
    steps: NavStep[];
  };

  let navigationSession: NavigationSession | null = null;
  let navSpeakUpcoming = true;
  let navSpeakRealtime = true;

  let userDot: L.CircleMarker | null = null;
  let userAccuracyCircle: L.Circle | null = null;
  let pendingNavUpdateTimer: number | null = null;

  function haversineMeters(a: L.LatLngTuple, b: L.LatLngTuple): number {
    const R = 6371000; // meters
    const toRad = (x: number) => (x * Math.PI) / 180;
    const dLat = toRad(b[0] - a[0]);
    const dLon = toRad(b[1] - a[1]);
    const lat1 = toRad(a[0]);
    const lat2 = toRad(b[0]);
    const sinDLat = Math.sin(dLat / 2);
    const sinDLon = Math.sin(dLon / 2);
    const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function getNavSteps(route: OsrmRoute): NavStep[] {
    const legs = route.legs ?? [];
    const out: NavStep[] = [];
    for (let li = 0; li < legs.length; li++) {
      const leg = legs[li]!;
      const isLastLeg = li === legs.length - 1;
      for (const step of leg.steps ?? []) {
        const m = step.maneuver;
        const type = (m?.type ?? "").toLowerCase();
        // Intermediate via points use maneuver type "arrive" like the real destination — skip those.
        if (type === "arrive" && !isLastLeg) continue;
        const loc = m?.location;
        if (!loc || loc.length < 2) continue;
        const lon = loc[0]!;
        const lat = loc[1]!;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const instruction = instructionFromOsrmStep(step).trim();
        if (!instruction) continue;
        out.push({ index: out.length, latlng: [lat, lon], instruction });
      }
    }
    return out;
  }

  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function updateNavStepHighlight(activeIdx: number | null) {
    const root = document.getElementById("nav-steps-list");
    if (!root) return;
    root.querySelectorAll("[data-nav-step]").forEach((el, i) => {
      el.classList.toggle("nav-step--active", activeIdx !== null && i === activeIdx);
    });
  }

  function speak(text: string) {
    if (!text) return;
    if (!("speechSynthesis" in window)) return;
    // Ensures voices load in Chromium (otherwise speak can be silent).
    void window.speechSynthesis.getVoices();
    if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
      window.speechSynthesis.cancel();
    }
    const ut = new SpeechSynthesisUtterance(text);
    ut.rate = 1.0;
    ut.pitch = 1.0;
    ut.volume = 1.0;
    window.speechSynthesis.speak(ut);
  }

  function setNavLiveText(upcoming: string, current: string) {
    const upcomingEl = document.getElementById("nav-upcoming");
    const currentEl = document.getElementById("nav-current");
    if (upcomingEl) upcomingEl.textContent = upcoming || "";
    if (currentEl) currentEl.textContent = current || "";
  }

  function stopNavigation() {
    if (navigationSession) {
      try {
        navigator.geolocation.clearWatch(navigationSession.watchId);
      } catch {
        // ignore
      }
    }
    navigationSession = null;

    if (pendingNavUpdateTimer) {
      window.clearTimeout(pendingNavUpdateTimer);
      pendingNavUpdateTimer = null;
    }

    userDot?.remove();
    userDot = null;
    userAccuracyCircle?.remove();
    userAccuracyCircle = null;
    setNavLiveText("", "");
    updateNavStepHighlight(null);
  }

  function startNavigationForActiveRoute() {
    if (!routeAlternativesSession) return;
    const route = routeAlternativesSession.routes[routeAlternativesSession.activeIndex]!;
    const steps = getNavSteps(route);
    if (steps.length === 0) {
      stopNavigation();
      setStatus("No turn-by-turn steps available for speech/navigation.", true);
      renderRouteAlternativesPanel();
      return;
    }

    stopNavigation();

    // Blue dot + optional accuracy ring
    userDot = L.circleMarker([0, 0], {
      radius: 7,
      color: "#1f6feb",
      weight: 2,
      fillColor: "#1f6feb",
      fillOpacity: 0.85,
      interactive: false,
    }).addTo(map);

    const opts: PositionOptions = {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 15000,
    };

    const spokenUpcoming = new Set<number>();
    navigationSession = {
      watchId: -1,
      activeStepIndex: 0,
      spokenUpcoming,
      lastRealtimeSpokenStepIndex: 0,
      steps,
    };

    setPanelCollapsed(false);
    setStatus("Navigation started…", false);
    speak(steps[0]!.instruction);
    updateNavStepHighlight(0);

    const realtimeThresholdM = 85;
    const upcomingThresholdM = 240;

    navigationSession.watchId = navigator.geolocation.watchPosition(
      async (pos) => {
        const ll: L.LatLngTuple = [pos.coords.latitude, pos.coords.longitude];

        // Throttle map/model updates so we don't do heavy work on every watch tick.
        if (pendingNavUpdateTimer) window.clearTimeout(pendingNavUpdateTimer);
        pendingNavUpdateTimer = window.setTimeout(() => {
          if (!navigationSession) return;
          userDot?.setLatLng(ll);
          if (pos.coords.accuracy && Number.isFinite(pos.coords.accuracy) && pos.coords.accuracy > 10) {
            const acc = Math.max(18, pos.coords.accuracy);
            if (!userAccuracyCircle) {
              userAccuracyCircle = L.circle(ll, {
                radius: acc,
                color: "#1f6feb",
                weight: 1,
                fillColor: "#1f6feb",
                fillOpacity: 0.12,
                interactive: false,
              }).addTo(map);
            } else {
              userAccuracyCircle.setLatLng(ll);
              userAccuracyCircle.setRadius(acc);
            }
          }

          // Find the best step index in a small forward window, anchored on last step.
          const steps = navigationSession.steps;
          const last = navigationSession.activeStepIndex;
          const start = Math.max(0, last - 1);
          const end = Math.min(steps.length - 1, last + 7);

          let bestIdx = last;
          let bestDist = Infinity;
          for (let i = start; i <= end; i++) {
            const d = haversineMeters(ll, steps[i]!.latlng);
            if (d < bestDist) {
              bestDist = d;
              bestIdx = i;
            }
          }

          // Only move forward (prevents jitter backwards).
          if (bestIdx > navigationSession.activeStepIndex && bestDist < 600) {
            navigationSession.activeStepIndex = bestIdx;
          }

          const currentStep = steps[navigationSession.activeStepIndex]!;
          const nextStepIndex = Math.min(steps.length - 1, navigationSession.activeStepIndex + 1);
          const nextStep = steps[nextStepIndex]!;

          // Realtime speech (current step)
          const distToCurrent = haversineMeters(ll, currentStep.latlng);
          if (navSpeakRealtime && navigationSession.activeStepIndex !== navigationSession.lastRealtimeSpokenStepIndex) {
            if (distToCurrent <= realtimeThresholdM) {
              speak(currentStep.instruction);
              navigationSession.lastRealtimeSpokenStepIndex = navigationSession.activeStepIndex;
            }
          }

          // Upcoming speech (next step)
          if (navSpeakUpcoming && nextStepIndex !== navigationSession.lastRealtimeSpokenStepIndex) {
            const distToNext = haversineMeters(ll, nextStep.latlng);
            if (distToNext <= upcomingThresholdM && !navigationSession.spokenUpcoming.has(nextStepIndex)) {
              speak(nextStep.instruction);
              navigationSession.spokenUpcoming.add(nextStepIndex);
            }
          }

          setNavLiveText(nextStep.instruction, currentStep.instruction);
          updateNavStepHighlight(navigationSession.activeStepIndex);

          // Follow the user lightly so the blue dot remains visible.
          map.panTo(ll, { animate: true, duration: 0.25 });
        }, 420);
      },
      (err) => {
        stopNavigation();
        setStatus(
          err.code === err.PERMISSION_DENIED
            ? "Navigation needs location permission."
            : "Could not start navigation (location unavailable).",
        );
        renderRouteAlternativesPanel();
      },
      opts,
    );

    renderRouteAlternativesPanel();
  }

  const overlayEl = root.querySelector<HTMLDivElement>("#route-loading-overlay")!;
  const overlayTitleEl = root.querySelector<HTMLParagraphElement>("#overlay-title")!;
  const overlaySubEl = root.querySelector<HTMLParagraphElement>("#overlay-sub")!;
  const statusRowEl = root.querySelector<HTMLDivElement>("#status-row")!;
  const statusEl = root.querySelector<HTMLParagraphElement>("#status")!;
  const statsEl = root.querySelector<HTMLDivElement>("#stats")!;
  const panelEl = root.querySelector<HTMLDivElement>("#panel")!;
  const panelCollapseBtn = root.querySelector<HTMLButtonElement>("#panel-collapse-btn")!;
  const startInput = root.querySelector<HTMLInputElement>("#start")!;
  const destInput = root.querySelector<HTMLInputElement>("#dest")!;
  const goBtn = root.querySelector<HTMLButtonElement>("#go")!;
  const onlyRightToggle = root.querySelector<HTMLInputElement>("#only-right")!;
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

  function setPanelCollapsed(collapsed: boolean) {
    panelEl.classList.toggle("panel--collapsed", collapsed);
    panelCollapseBtn.textContent = collapsed ? "+" : "−";
    panelCollapseBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    panelCollapseBtn.setAttribute("aria-label", collapsed ? "Show route info" : "Minimize route info");
  }

  /** Clears computed route geometry and summary only; keeps start/destination pins. */
  function clearRoutePaths() {
    routeAlternativesSession = null;
    stopNavigation();
    finalRouteLayer?.remove();
    finalRouteLayer = null;
    clearAnalysisLayers();
    statsEl.innerHTML = "";
    setPanelCollapsed(false);
  }

  function renderRouteAlternativesPanel() {
    const sess = routeAlternativesSession;
    if (!sess) {
      statsEl.innerHTML = "";
      return;
    }
    const { summaries, activeIndex, bestIndex } = sess;
    const current = summaries.find((s) => s.index === activeIndex);
    if (!current) return;

    const allowedSet = new Set(sess.allowedIndices);
    const strictRightNote = sess.onlyRightMode
      ? sess.strictOnlyRight
        ? `<div class="route-picked-note">Strict mode: this route uses zero left/uturn maneuvers (best-effort).</div>`
        : `<div class="route-picked-note">Strict mode could not find a zero-left/uturn route; showing the best available option (${current.leftTurns} left turn${current.leftTurns === 1 ? "" : "s"}).</div>`
      : "";

    const suggestedNote =
      activeIndex === bestIndex
        ? sess.onlyRightMode
          ? `<div class="route-picked-note">Baseline: lowest risk-weighted left score among OSRM options (neighborhood lefts count less than arterials). Jug-handle tweaks target the heaviest lefts first.</div>`
          : `<div class="route-picked-note">Suggested: fewest left turns among these options</div>`
        : "";

    const others = summaries.filter((s) => s.index !== activeIndex && allowedSet.has(s.index));

    const routeForSteps = sess.routes[sess.activeIndex];
    const navSteps = routeForSteps ? getNavSteps(routeForSteps) : [];
    const stepsBlock =
      navSteps.length > 0
        ? `<div class="nav-steps-wrap">
        <div class="nav-steps-head muted">Turn-by-turn</div>
        <ol class="nav-steps-list" id="nav-steps-list" start="1">
          ${navSteps
            .map(
              (_st, i) =>
                `<li data-nav-step="${i}" class="nav-step">${escapeHtml(_st.instruction)}</li>`,
            )
            .join("")}
        </ol>
      </div>`
        : `<div class="muted">Turn-by-turn steps could not be built from this route.</div>`;

    const altMeta = (s: OsrmRouteSummary) =>
      sess.onlyRightMode && s.weightedLeftRisk !== undefined
        ? `${s.leftTurns} left · ${s.majorRoadLeftTurns ?? 0} heavy-road · score ${s.weightedLeftRisk.toFixed(1)} · ${formatDuration(s.durationSec)} · ${formatDistance(s.distanceM)}`
        : `${s.leftTurns} left turn${s.leftTurns === 1 ? "" : "s"} · ${formatDuration(s.durationSec)} · ${formatDistance(s.distanceM)}`;

    const othersBlock =
      others.length > 0
        ? `<div class="route-alternatives">
            <span class="route-alternatives-label muted">Other options — tap to show on map</span>
            <ul class="route-alt-list" role="list">
              ${others
                .map(
                  (s) => `<li>
                <button type="button" class="route-alt-btn" data-route-index="${s.index}">
                  <span class="route-alt-title">Option ${s.index + 1}</span>
                  <span class="route-alt-meta">${altMeta(s)}</span>
                </button>
              </li>`,
                )
                .join("")}
            </ul>
          </div>`
        : `<div class="muted">Only one route was returned for this trip.</div>`;

    const navActive = navigationSession !== null;
    statsEl.innerHTML = `
      <div class="route-displayed">
        <div class="route-displayed-top">
          <strong>Route on map</strong> · Option ${activeIndex + 1}
          ${suggestedNote}
          ${strictRightNote}
        </div>
        <div class="route-displayed-stats">
          ${
            sess.onlyRightMode && current.weightedLeftRisk !== undefined
              ? `${current.leftTurns} left · ${current.majorRoadLeftTurns ?? 0} on heavier roads · risk score ${current.weightedLeftRisk.toFixed(1)} · ${formatDuration(current.durationSec)} · ${formatDistance(current.distanceM)}`
              : `${current.leftTurns} left turn${current.leftTurns === 1 ? "" : "s"} · ${formatDuration(current.durationSec)} · ${formatDistance(current.distanceM)}`
          }
        </div>

        ${stepsBlock}

        <div class="nav-actions">
          <button type="button" class="nav-toggle-btn${navActive ? " nav-toggle-btn--navigating" : ""}" id="nav-toggle-btn" aria-pressed="${navActive ? "true" : "false"}" aria-label="${navActive ? "End navigation" : "Start navigation"}">
            ${navActive ? "End Navigation" : "Navigate"}
          </button>
          <label class="nav-option">
            <input type="checkbox" data-nav-opt="upcoming" ${navSpeakUpcoming ? "checked" : ""} />
            Speak upcoming
          </label>
          <label class="nav-option">
            <input type="checkbox" data-nav-opt="realtime" ${navSpeakRealtime ? "checked" : ""} />
            Speak realtime
          </label>
        </div>

        <div class="nav-live" aria-live="polite">
          <div class="nav-live-label">Next:</div>
          <div class="nav-live-text" id="nav-upcoming"></div>
          <div class="nav-live-label" style="margin-top: 0.25rem;">Now:</div>
          <div class="nav-live-text" id="nav-current"></div>
        </div>
      </div>
      ${othersBlock}
    `;
  }

  function switchActiveRoute(newIndex: number) {
    const sess = routeAlternativesSession;
    if (!sess || newIndex === sess.activeIndex) return;
    if (newIndex < 0 || newIndex >= sess.routes.length) return;
    if (sess.onlyRightMode && !sess.allowedIndices.includes(newIndex)) return;

    sess.activeIndex = newIndex;
    finalRouteLayer?.remove();
    const chosen = sess.routes[newIndex]!;
    const latlngs = routeToLatLngs(chosen);
    finalRouteLayer = L.polyline(latlngs, {
      color: "#58a6ff",
      weight: 7,
      opacity: 0.95,
      lineCap: "round",
      lineJoin: "round",
    }).addTo(map);

    map.fitBounds(L.latLngBounds(latlngs), { padding: [56, 56], maxZoom: 15 });
    renderRouteAlternativesPanel();

    // If navigation is running, restart it against the newly active route so steps match.
    if (navigationSession) startNavigationForActiveRoute();
  }

  panelCollapseBtn.addEventListener("click", () => {
    setPanelCollapsed(!panelEl.classList.contains("panel--collapsed"));
  });

  statsEl.addEventListener("click", (e) => {
    const routeBtn = (e.target as HTMLElement).closest("button.route-alt-btn");
    if (routeBtn) {
      const idx = parseInt(routeBtn.getAttribute("data-route-index") ?? "", 10);
      if (!Number.isNaN(idx)) switchActiveRoute(idx);
      return;
    }

    const navBtn = (e.target as HTMLElement).closest("button.nav-toggle-btn");
    if (!navBtn) return;
    const navActive = navigationSession !== null;
    if (navActive) {
      stopNavigation();
      renderRouteAlternativesPanel();
    } else startNavigationForActiveRoute();
  });

  statsEl.addEventListener("change", (e) => {
    const input = (e.target as HTMLElement).closest('input[type="checkbox"][data-nav-opt]') as
      | HTMLInputElement
      | null;
    if (!input) return;
    const opt = input.getAttribute("data-nav-opt");
    if (opt === "upcoming") navSpeakUpcoming = input.checked;
    if (opt === "realtime") navSpeakRealtime = input.checked;
    // If navigation is active, update immediately.
    if (navigationSession) {
      startNavigationForActiveRoute();
    }
  });

  function setRoutingBusy(busy: boolean) {
    goBtn.disabled = busy;
    startInput.disabled = busy;
    destInput.disabled = busy;
    onlyRightToggle.disabled = busy;
  }

  async function animateRouteComparison(
    routes: OsrmRoute[],
    summaries: OsrmRouteSummary[],
    msPerStep = 320,
    routeLatlngs?: L.LatLngExpression[][],
  ): Promise<void> {
    clearAnalysisLayers();
    const latlngsList = routeLatlngs ?? routes.map((r) => routeToLatLngs(r));
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
      let routes: OsrmRoute[] = [];
      try {
        // Keep lightweight decorative linking paths while we fetch + decide.
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

        const onlyRightMode = onlyRightToggle.checked;
        let strictOnlyRight = false;
        let allowedIndices: number[] = [];

        let summaries: OsrmRouteSummary[];
        let best: OsrmRouteSummary | null;

        if (onlyRightMode) {
          setOverlayCopy(
            "Searching side-street paths\u2026",
            "Probing snapped waypoints OSRM often omits from alternatives (neighborhood detours).",
          );
          try {
            const extra = await discoverNeighborhoodDetourRoutes({
              start: [s.lat, s.lng],
              end: [d.lat, d.lng],
              osrmBaseUrl: osrmBaseUrl(),
              existingRoutes: routes,
              fetchVia: (st, en, via) => fetchRouteViaWaypoints(st, en, via, { timeoutMs: 24000 }),
              maxRouteAttempts: 20,
              maxDiscoveredRoutes: 12,
              maxDurationRatioVsFastest: 4.0,
            });
            if (extra.length > 0) routes = [...routes, ...extra];
          } catch {
            // Keep OSRM alternatives only if discovery fails.
          }

          const onlyRightPick = pickBestOnlyRightBaseline(routes);
          summaries = onlyRightPick.summaries;
          best = onlyRightPick.best;

          if (!best) {
            hideRouteOverlay();
            setStatus("No route could be selected.");
            return;
          }

          if (best.leftTurns > 0) {
            const uiPass = {
              pass: 1,
              passMax: 6,
              leftTurns: best.leftTurns,
              t0: Date.now(),
            };
            const tickOptimizeOverlay = () => {
              const elapsedSec = Math.floor((Date.now() - uiPass.t0) / 1000);
              setOverlayCopy(
                "Optimizing for right turns only\u2026",
                `Pass ${uiPass.pass}/${uiPass.passMax} · ${uiPass.leftTurns} left turn${uiPass.leftTurns === 1 ? "" : "s"} · ${elapsedSec}s elapsed`,
              );
            };
            tickOptimizeOverlay();
            const optimizeTick = window.setInterval(tickOptimizeOverlay, 1000);
            try {
              const optimized = await optimizeRouteOnlyRightTurns({
                osrmBaseUrl: osrmBaseUrl(),
                start: [startPlace.lat, startPlace.lon],
                end: [destPlace.lat, destPlace.lon],
                baseRoute: routes[best.index]! as DetourRouteInput,
                fetchRouteViaWaypoints: (s, e, via, o) => fetchRouteViaWaypoints(s, e, via, o),
                maxIterations: 6,
                maxTotalWaypoints: 30,
                routeTimeoutMs: 6000,
                nearestTimeoutMs: 3500,
                timeBudgetMsPerPass: 8000,
                onProgress: (info) => {
                  uiPass.pass = info.pass;
                  uiPass.passMax = info.passMax;
                  uiPass.leftTurns = info.leftTurns;
                },
              });
              routes[best.index] = optimized.route as OsrmRoute;
              summaries = summarizeRoutesWithRisk(routes);
              strictOnlyRight = optimized.strict;
              allowedIndices = strictOnlyRight
                ? summaries.filter((s) => s.leftTurns === 0).map((s) => s.index)
                : summaries.map((s) => s.index);
              if (strictOnlyRight && allowedIndices.length === 0) allowedIndices = [best.index];
            } catch {
              summaries = summarizeRoutesWithRisk(routes);
              strictOnlyRight = false;
              allowedIndices = summaries.map((s) => s.index);
            } finally {
              window.clearInterval(optimizeTick);
            }
          } else {
            strictOnlyRight = true;
            allowedIndices = summaries.map((s) => s.index);
          }
        } else {
          const normalPick = summarizeAndPickBest(routes);
          summaries = normalPick.summaries;
          best = normalPick.best;
          strictOnlyRight = false;
          allowedIndices = summaries.map((s) => s.index);
        }

        if (!best) {
          hideRouteOverlay();
          setStatus("No route could be selected.");
          return;
        }

        // Stop decorative preview just before we render heavy polylines.
        stopRandomPreview?.();
        stopRandomPreview = null;

        const routeLatlngsList = routes.map((r) => routeToLatLngs(r));
        await animateRouteComparison(routes, summaries, 320, routeLatlngsList);

        clearAnalysisLayers();
        hideRouteOverlay();

        routeAlternativesSession = {
          routes,
          summaries,
          activeIndex: best.index,
          bestIndex: best.index,
          onlyRightMode: onlyRightToggle.checked,
          strictOnlyRight,
          allowedIndices,
        };

        const latlngs = routeLatlngsList[best.index]!;

        finalRouteLayer = L.polyline(latlngs, {
          color: "#58a6ff",
          weight: 7,
          opacity: 0.95,
          lineCap: "round",
          lineJoin: "round",
        }).addTo(map);

        map.fitBounds(L.latLngBounds(latlngs), { padding: [56, 56], maxZoom: 15 });

        setStatus("");
        renderRouteAlternativesPanel();
        return;
      } catch (e) {
        hideRouteOverlay();
        setStatus(formatRoutingFailureMessage(e));
        return;
      } finally {
        stopRandomPreview?.();
      }
    } catch (e) {
      hideRouteOverlay();
      clearAnalysisLayers();
      setStatus(formatRoutingFailureMessage(e));
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
