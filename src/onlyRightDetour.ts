/**
 * Only-right-turns rewrite: replace each left / risky maneuver with a three-right
 * “around the block” path, using OSRM bearings (or geometry), then snap waypoints
 * to the drivable network via OSRM Nearest before routing.
 */

import {
  buildRightDetourWaypoint,
  countLeftTurnsFromRoute,
  firstLeftTurnStepIndex,
  flattenRouteStepPointsForDetour,
  type RoutableForLeftCount,
} from "./routing";

export type LatLon = { lat: number; lon: number };

export type LatLngTuple = [number, number];

/** Minimal OSRM route shape for detour planning (matches public OSRM JSON). */
export type DetourRouteInput = RoutableForLeftCount & {
  legs?: Array<{
    steps?: Array<{
      distance?: number;
      maneuver?: {
        type?: string;
        modifier?: string;
        location?: [number, number];
        bearing_before?: number;
        bearing_after?: number;
      };
    }>;
  }>;
};

export type FlatDetourStep = {
  lat: number;
  lon: number;
  modifier: string;
  maneuverType: string;
  stepDistanceM: number;
  bearingBefore?: number;
  bearingAfter?: number;
  prev?: LatLon;
  next?: LatLon;
};

const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

export function bearingBetweenPoints(a: LatLon, b: LatLon): number {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Destination point at initial bearing (degrees clockwise from north), distance in meters. */
export function destinationPoint(lat: number, lon: number, bearingDeg: number, distanceM: number): LatLon {
  const R = 6371000;
  const δ = distanceM / R;
  const θ = toRad(bearingDeg);
  const φ1 = toRad(lat);
  const λ1 = toRad(lon);
  const sinφ1 = Math.sin(φ1);
  const cosφ1 = Math.cos(φ1);
  const sinδ = Math.sin(δ);
  const cosδ = Math.cos(δ);
  const sinφ2 = sinφ1 * cosδ + cosφ1 * sinδ * Math.cos(θ);
  const φ2 = Math.asin(sinφ2);
  const y = Math.sin(θ) * sinδ * cosφ1;
  const x = cosδ - sinφ1 * sinφ2;
  const λ2 = λ1 + Math.atan2(y, x);
  return { lat: toDeg(φ2), lon: toDeg(λ2) };
}

function isLeftLikeModifier(mod: string): boolean {
  const m = mod.toLowerCase();
  return m.includes("uturn") || m.includes("left");
}

function isRoundaboutLike(t: string): boolean {
  const s = t.toLowerCase();
  return s.includes("roundabout") || s.includes("rotary");
}

/** Flatten legs into one list with prev/next maneuver locations for bearing fallbacks. */
export function flattenDetourSteps(route: DetourRouteInput): FlatDetourStep[] {
  const legs = route.legs ?? [];
  const out: FlatDetourStep[] = [];

  for (let li = 0; li < legs.length; li++) {
    const steps = legs[li]!.steps ?? [];
    for (let si = 0; si < steps.length; si++) {
      const step = steps[si]!;
      const m = step.maneuver;
      const loc = m?.location;
      if (!loc || loc.length < 2) continue;
      const lon = loc[0]!;
      const lat = loc[1]!;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      let prev: LatLon | undefined;
      if (si > 0) {
        const pl = steps[si - 1]!.maneuver?.location;
        if (pl) prev = { lat: pl[1]!, lon: pl[0]! };
      } else if (out.length > 0) {
        const p = out[out.length - 1]!;
        prev = { lat: p.lat, lon: p.lon };
      }

      let next: LatLon | undefined;
      if (si + 1 < steps.length) {
        const nl = steps[si + 1]!.maneuver?.location;
        if (nl) next = { lat: nl[1]!, lon: nl[0]! };
      } else {
        const nextLeg = legs[li + 1];
        const ns = nextLeg?.steps?.[0]?.maneuver?.location;
        if (ns) next = { lat: ns[1]!, lon: ns[0]! };
      }

      const modifier = (m?.modifier ?? "").toLowerCase();
      const maneuverType = (m?.type ?? "").toLowerCase();
      let bearingBefore = m?.bearing_before;
      let bearingAfter = m?.bearing_after;
      if (prev && (bearingBefore === undefined || bearingBefore === null)) {
        bearingBefore = bearingBetweenPoints(prev, { lat, lon });
      }
      if (next && (bearingAfter === undefined || bearingAfter === null)) {
        bearingAfter = bearingBetweenPoints({ lat, lon }, next);
      }

      out.push({
        lat,
        lon,
        modifier,
        maneuverType,
        stepDistanceM: typeof step.distance === "number" && Number.isFinite(step.distance) ? step.distance : 80,
        bearingBefore: bearingBefore ?? undefined,
        bearingAfter: bearingAfter ?? undefined,
        prev,
        next,
      });
    }
  }
  return out;
}

function defaultLegMeters(step: FlatDetourStep, isUturn: boolean): number {
  const d = step.stepDistanceM;
  const base = Math.min(200, Math.max(38, Math.min(d * 0.52, 150)));
  return isUturn ? Math.min(240, base * 1.4) : base;
}

/**
 * Three sequential right turns at the intersection: bearings B0+90, B0+180, B0+270.
 * Replaces one left turn with a rectangular detour of side length `legM`.
 */
export function buildThreeRightCorners(lat: number, lon: number, bearingBeforeDeg: number, legM: number): LatLon[] {
  const B0 = ((bearingBeforeDeg % 360) + 360) % 360;
  const d = legM;
  const p1 = destinationPoint(lat, lon, (B0 + 90) % 360, d);
  const p2 = destinationPoint(p1.lat, p1.lon, (B0 + 180) % 360, d);
  const p3 = destinationPoint(p2.lat, p2.lon, (B0 + 270) % 360, d);
  return [p1, p2, p3];
}

type NearestResponse = {
  code?: string;
  waypoints?: Array<{ location?: [number, number]; distance?: number }>;
};

/** Snap a point to the nearest point on the OSRM driving network. */
export async function snapLatLonToRoad(
  osrmBaseUrl: string,
  lat: number,
  lon: number,
  init?: RequestInit,
  /** Per-request budget; each snap is independent (do not share one AbortSignal across many snaps). */
  timeoutMs = 22000,
): Promise<{ lat: number; lon: number; snapM: number } | null> {
  const url = `${osrmBaseUrl}/nearest/v1/driving/${lon},${lat}?number=1`;
  const controller = new AbortController();
  const tid = window.setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(tid);
  }
  if (!res.ok) return null;
  const data = (await res.json()) as NearestResponse;
  if (data.code !== "Ok" || !data.waypoints?.[0]?.location) return null;
  const [lon2, lat2] = data.waypoints[0].location;
  const snapM = data.waypoints[0].distance ?? 0;
  if (!Number.isFinite(lat2) || !Number.isFinite(lon2)) return null;
  return { lat: lat2, lon: lon2, snapM };
}

function haversineMeters(a: LatLon, b: LatLon): number {
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function tooCloseToAny(p: LatLon, list: LatLon[], minM: number): boolean {
  return list.some((q) => haversineMeters(p, q) < minM);
}

/**
 * For the first remaining left-like maneuver on this route, produce up to three
 * road-snapped waypoints (three-right pattern) or a single legacy nudge waypoint.
 */
export async function buildNextOnlyRightWaypoints(
  route: DetourRouteInput,
  osrmBaseUrl: string,
  existingWaypoints: LatLngTuple[],
  opts?: {
    minSeparationM?: number;
    maxSnapM?: number;
    /** Timeout for each OSRM /nearest request (sequential snaps each get their own timer). */
    nearestTimeoutMs?: number;
  },
): Promise<{ added: LatLon[]; usedThreeRight: boolean } | null> {
  const minSep = opts?.minSeparationM ?? 36;
  const maxSnap = opts?.maxSnapM ?? 180;
  const snapTimeout = opts?.nearestTimeoutMs ?? 22000;

  const flat = flattenDetourSteps(route);
  const leftIdx = flat.findIndex(
    (s) =>
      isLeftLikeModifier(s.modifier) &&
      s.maneuverType !== "depart" &&
      s.maneuverType !== "arrive",
  );
  if (leftIdx < 0) return null;

  const turn = flat[leftIdx]!;
  const isUturn = turn.modifier.includes("uturn");
  const useSimpleRoundabout = isRoundaboutLike(turn.maneuverType);

  const existingAsLatLon: LatLon[] = existingWaypoints.map(([lat, lon]) => ({ lat, lon }));

  /** Single-offset fallback using polyline context (same as before). */
  const fallbackSingleNudge = (): LatLon[] | null => {
    const pts = flattenRouteStepPointsForDetour(route);
    const i = firstLeftTurnStepIndex(pts);
    if (i < 0) return null;
    const w = buildRightDetourWaypoint(pts, i);
    if (!w) return null;
    return [{ lat: w[0], lon: w[1] }];
  };

  if (useSimpleRoundabout || turn.bearingBefore === undefined || turn.bearingBefore === null) {
    const raw = fallbackSingleNudge();
    if (!raw) return null;
    const added: LatLon[] = [];
    for (const p of raw) {
      if (tooCloseToAny(p, existingAsLatLon, minSep)) continue;
      const snap = await snapLatLonToRoad(osrmBaseUrl, p.lat, p.lon, undefined, snapTimeout);
      if (!snap || snap.snapM > maxSnap) {
        added.push(p);
      } else {
        added.push({ lat: snap.lat, lon: snap.lon });
      }
    }
    return added.length ? { added, usedThreeRight: false } : null;
  }

  const legM = defaultLegMeters(turn, isUturn);
  let corners = buildThreeRightCorners(turn.lat, turn.lon, turn.bearingBefore, legM);

  let added: LatLon[] = [];
  for (const c of corners) {
    if (tooCloseToAny(c, existingAsLatLon, minSep)) {
      continue;
    }
    const snap = await snapLatLonToRoad(osrmBaseUrl, c.lat, c.lon, undefined, snapTimeout);
    if (!snap || snap.snapM > maxSnap) {
      added.push(c);
    } else {
      added.push({ lat: snap.lat, lon: snap.lon });
    }
    existingAsLatLon.push(added[added.length - 1]!);
  }

  if (added.length >= 2) {
    return { added, usedThreeRight: true };
  }

  /** Retry with shorter legs if snaps collapsed to duplicates. */
  const leg2 = Math.max(38, legM * 0.72);
  corners = buildThreeRightCorners(turn.lat, turn.lon, turn.bearingBefore, leg2);
  const retry: LatLon[] = [];
  const seen = new Set(existingWaypoints.map(([a, b]) => `${a.toFixed(5)},${b.toFixed(5)}`));
  for (const c of corners) {
    const key = `${c.lat.toFixed(5)},${c.lon.toFixed(5)}`;
    if (seen.has(key)) continue;
    if (tooCloseToAny(c, existingAsLatLon, minSep * 0.85)) continue;
    const snap = await snapLatLonToRoad(osrmBaseUrl, c.lat, c.lon, undefined, snapTimeout);
    const p =
      snap && snap.snapM <= maxSnap ? { lat: snap.lat, lon: snap.lon } : { ...c };
    retry.push(p);
    existingAsLatLon.push(p);
    seen.add(`${p.lat.toFixed(5)},${p.lon.toFixed(5)}`);
  }
  if (retry.length >= 2) {
    return { added: retry, usedThreeRight: true };
  }

  const raw = fallbackSingleNudge();
  if (!raw) return null;
  const single: LatLon[] = [];
  for (const p of raw) {
    if (tooCloseToAny(p, existingAsLatLon, minSep)) continue;
    const snap = await snapLatLonToRoad(osrmBaseUrl, p.lat, p.lon, undefined, snapTimeout);
    single.push(snap && snap.snapM <= maxSnap ? { lat: snap.lat, lon: snap.lon } : p);
  }
  return single.length ? { added: single, usedThreeRight: false } : null;
}

export type OptimizeOnlyRightOptions = {
  osrmBaseUrl: string;
  start: LatLngTuple;
  end: LatLngTuple;
  /** Best OSRM candidate (e.g. fewest left turns) to rewrite. */
  baseRoute: DetourRouteInput;
  fetchRouteViaWaypoints: (
    start: LatLngTuple,
    end: LatLngTuple,
    via: LatLngTuple[],
    opts?: { timeoutMs?: number },
  ) => Promise<DetourRouteInput>;
  maxIterations?: number;
  maxTotalWaypoints?: number;
  /** Minimum time budget for OSRM /route with intermediate waypoints (see main.ts scaling). */
  routeTimeoutMs?: number;
  /** Per /nearest snap call; each snap uses its own timer. */
  nearestTimeoutMs?: number;
};

/**
 * Iteratively inserts three-right (and snapped) waypoints for each remaining left
 * until no left maneuvers remain or progress stops.
 */
export async function optimizeRouteOnlyRightTurns(
  options: OptimizeOnlyRightOptions,
): Promise<{ route: DetourRouteInput; waypoints: LatLngTuple[]; strict: boolean }> {
  const {
    osrmBaseUrl,
    start,
    end,
    baseRoute,
    fetchRouteViaWaypoints,
    maxIterations = 14,
    maxTotalWaypoints = 22,
    routeTimeoutMs = 24000,
    nearestTimeoutMs = 22000,
  } = options;

  let workingRoute: DetourRouteInput = baseRoute;
  let waypoints: LatLngTuple[] = [];
  let prevLeft = countLeftTurnsFromRoute(workingRoute);

  for (let iter = 0; iter < maxIterations; iter++) {
    if (countLeftTurnsFromRoute(workingRoute) === 0) {
      return { route: workingRoute, waypoints, strict: true };
    }

    let chunk: Awaited<ReturnType<typeof buildNextOnlyRightWaypoints>>;
    try {
      chunk = await buildNextOnlyRightWaypoints(workingRoute, osrmBaseUrl, waypoints, {
        nearestTimeoutMs,
      });
    } catch {
      break;
    }
    if (!chunk || chunk.added.length === 0) break;

    const candidateWps: LatLngTuple[] = [
      ...waypoints,
      ...chunk.added.map((p): LatLngTuple => [p.lat, p.lon]),
    ];
    if (candidateWps.length > maxTotalWaypoints) break;

    try {
      const modified = await fetchRouteViaWaypoints(start, end, candidateWps, {
        timeoutMs: routeTimeoutMs,
      });
      const newLeft = countLeftTurnsFromRoute(modified);
      if (newLeft >= prevLeft) {
        break;
      }
      prevLeft = newLeft;
      workingRoute = modified;
      waypoints = candidateWps;
    } catch {
      break;
    }
  }

  return {
    route: workingRoute,
    waypoints,
    strict: countLeftTurnsFromRoute(workingRoute) === 0,
  };
}
