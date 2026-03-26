/**
 * Invent driving routes OSRM often omits from `alternatives=true` alone: single-via
 * paths pulled onto side streets by snapping probe points perpendicular to the
 * start–end chord (suburban grid “go around the block” geometry).
 */

import {
  bearingBetweenPoints,
  destinationPoint,
  snapLatLonToRoad,
  type LatLon,
  type LatLngTuple,
} from "./onlyRightDetour";

function haversineMeters(a: LatLon, b: LatLon): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function toLatLon(t: LatLngTuple): LatLon {
  return { lat: t[0], lon: t[1] };
}

function toTuple(p: LatLon): LatLngTuple {
  return [p.lat, p.lon];
}

function relativeClose(a: number, b: number, rel: number): boolean {
  const m = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / m < rel;
}

function isSimilarToAnyRoute<T extends { duration: number; distance: number }>(
  candidate: T,
  pool: T[],
  durationRel = 0.028,
  distanceRel = 0.028,
): boolean {
  for (const o of pool) {
    if (relativeClose(candidate.duration, o.duration, durationRel) && relativeClose(candidate.distance, o.distance, distanceRel)) {
      return true;
    }
  }
  return false;
}

/** Raw probe points: perpendicular offsets from anchor at given distances (m). */
function perpOffsets(anchor: LatLon, bearingAlongChord: number, distancesM: number[]): LatLon[] {
  const out: LatLon[] = [];
  const leftB = (bearingAlongChord + 90) % 360;
  const rightB = (bearingAlongChord + 270) % 360;
  for (const d of distancesM) {
    out.push(destinationPoint(anchor.lat, anchor.lon, leftB, d));
    out.push(destinationPoint(anchor.lat, anchor.lon, rightB, d));
  }
  return out;
}

/**
 * Build ordered probe anchors along A→B so we try “bend early / late / mid” into side streets.
 */
function buildRawProbePoints(a: LatLon, b: LatLon): LatLon[] {
  const dist = haversineMeters(a, b);
  if (dist < 280) return [];

  const bear = bearingBetweenPoints(a, b);
  const out: LatLon[] = [];

  const mid = destinationPoint(a.lat, a.lon, bear, dist * 0.5);
  out.push(...perpOffsets(mid, bear, [400, 260, 130]));

  const nearStart = destinationPoint(a.lat, a.lon, bear, Math.min(dist * 0.2, 900));
  out.push(...perpOffsets(nearStart, bear, [220, 110]));

  const nearEnd = destinationPoint(a.lat, a.lon, bear, Math.max(dist * 0.8, dist - 700));
  out.push(...perpOffsets(nearEnd, bear, [220, 110]));

  const q1 = destinationPoint(a.lat, a.lon, bear, dist * 0.35);
  const q2 = destinationPoint(a.lat, a.lon, bear, dist * 0.65);
  out.push(...perpOffsets(q1, bear, [170]));
  out.push(...perpOffsets(q2, bear, [170]));

  return out;
}

export type DiscoverNeighborhoodRoutesOptions<T extends { duration: number; distance: number }> = {
  start: LatLngTuple;
  end: LatLngTuple;
  osrmBaseUrl: string;
  existingRoutes: T[];
  fetchVia: (start: LatLngTuple, end: LatLngTuple, via: LatLngTuple[]) => Promise<T>;
  /** Max acceptable snap distance from probe to road (m). */
  maxSnapM?: number;
  nearestTimeoutMs?: number;
  /** Cap OSRM /route calls after snapping. */
  /** Max /route calls to try (failed requests count toward this budget). */
  maxRouteAttempts?: number;
  /** Stop after this many new routes are accepted (≤ maxRouteAttempts). */
  maxDiscoveredRoutes?: number;
  /** Reject discovered routes slower than this × fastest existing duration. */
  maxDurationRatioVsFastest?: number;
  /** Minimum extra distance vs fastest existing (m) to count as distinct path. */
  minExtraDistanceM?: number;
};

/**
 * Returns additional routes found via single forced via points. Caller merges into
 * `existingRoutes` before scoring (e.g. pickBestOnlyRightBaseline).
 */
export async function discoverNeighborhoodDetourRoutes<T extends { duration: number; distance: number }>(
  options: DiscoverNeighborhoodRoutesOptions<T>,
): Promise<T[]> {
  const {
    start,
    end,
    osrmBaseUrl,
    existingRoutes,
    fetchVia,
    maxSnapM = 220,
    nearestTimeoutMs = 6000,
    maxRouteAttempts = 14,
    maxDiscoveredRoutes = 8,
    maxDurationRatioVsFastest = 3.15,
    minExtraDistanceM = 70,
  } = options;

  if (existingRoutes.length === 0) return [];

  const a = toLatLon(start);
  const b = toLatLon(end);
  const raw = buildRawProbePoints(a, b);
  if (raw.length === 0) return [];

  const fastestDur = Math.min(...existingRoutes.map((r) => r.duration));
  const fastestDist = Math.min(...existingRoutes.map((r) => r.distance));
  const maxAllowedDuration = fastestDur * maxDurationRatioVsFastest;

  const seenKeys = new Set<string>();
  const snappedVias: LatLngTuple[] = [];

  const snapResults = await Promise.all(
    raw.map((p) => snapLatLonToRoad(osrmBaseUrl, p.lat, p.lon, undefined, nearestTimeoutMs)),
  );

  for (let i = 0; i < raw.length; i++) {
    const snap = snapResults[i];
    if (!snap || snap.snapM > maxSnapM) continue;

    const via = toTuple({ lat: snap.lat, lon: snap.lon });
    if (haversineMeters({ lat: via[0], lon: via[1] }, a) < 45 || haversineMeters({ lat: via[0], lon: via[1] }, b) < 45) {
      continue;
    }

    const key = `${snap.lat.toFixed(4)},${snap.lon.toFixed(4)}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    snappedVias.push(via);
  }

  const discovered: T[] = [];
  const pool: T[] = [...existingRoutes];

  let attempts = 0;
  for (const via of snappedVias) {
    if (attempts >= maxRouteAttempts || discovered.length >= maxDiscoveredRoutes) break;
    attempts++;

    let route: T;
    try {
      route = await fetchVia(start, end, [via]);
    } catch {
      continue;
    }

    if (route.duration > maxAllowedDuration) continue;
    if (route.distance < fastestDist + minExtraDistanceM) continue;
    if (isSimilarToAnyRoute(route, pool)) continue;

    discovered.push(route);
    pool.push(route);
  }

  return discovered;
}
