/**
 * Only-right-turns rewrite: replace each left / risky maneuver with a jug-handle
 * path (straight past the intersection, then three rights), using OSRM bearings,
 * then snap waypoints to the drivable network via OSRM Nearest before routing.
 */

import {
  buildRightDetourWaypoint,
  countLeftTurnsFromRoute,
  flattenRouteStepPointsForDetour,
  leftTurnRiskWeightForSteps,
  type RoutableForLeftCount,
  type RouteStepPoint,
} from "./routing";

export type LatLon = { lat: number; lon: number };

export type LatLngTuple = [number, number];

/** Minimal OSRM route shape for detour planning (matches public OSRM JSON). */
export type DetourRouteInput = RoutableForLeftCount & {
  legs?: Array<{
    steps?: Array<{
      name?: string;
      ref?: string;
      distance?: number;
      classes?: string[];
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
  stepName: string;
  stepRef: string;
  classes?: string[];
  prevStepName?: string;
  prevStepRef?: string;
};

const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

export function bearingBetweenPoints(a: LatLon, b: LatLon): number {
  const phi1 = toRad(a.lat);
  const phi2 = toRad(b.lat);
  const dLambda = toRad(b.lon - a.lon);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Destination point at initial bearing (degrees clockwise from north), distance in meters. */
export function destinationPoint(lat: number, lon: number, bearingDeg: number, distanceM: number): LatLon {
  const R = 6371000;
  const delta = distanceM / R;
  const theta = toRad(bearingDeg);
  const phi1 = toRad(lat);
  const lambda1 = toRad(lon);
  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const sinDelta = Math.sin(delta);
  const cosDelta = Math.cos(delta);
  const sinPhi2 = sinPhi1 * cosDelta + cosPhi1 * sinDelta * Math.cos(theta);
  const phi2 = Math.asin(sinPhi2);
  const y = Math.sin(theta) * sinDelta * cosPhi1;
  const x = cosDelta - sinPhi1 * sinPhi2;
  const lambda2 = lambda1 + Math.atan2(y, x);
  return { lat: toDeg(phi2), lon: toDeg(lambda2) };
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
  let prevLegLastName = "";
  let prevLegLastRef = "";

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

      const prevStepName =
        si > 0 ? (steps[si - 1]!.name ?? "").trim() || undefined : prevLegLastName || undefined;
      const prevStepRef =
        si > 0 ? (steps[si - 1]!.ref ?? "").trim() || undefined : prevLegLastRef || undefined;
      const stepName = (step.name ?? "").trim();
      const stepRef = (step.ref ?? "").trim();

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
        stepName,
        stepRef,
        classes: step.classes,
        prevStepName,
        prevStepRef,
      });
    }
    const last = steps[steps.length - 1];
    if (last) {
      prevLegLastName = (last.name ?? "").trim();
      prevLegLastRef = (last.ref ?? "").trim();
    }
  }
  return out;
}

function flatLeftTurnRisk(turn: FlatDetourStep): number {
  return leftTurnRiskWeightForSteps(
    {
      name: turn.stepName,
      ref: turn.stepRef,
      classes: turn.classes,
      maneuver: { modifier: turn.modifier },
    },
    turn.prevStepName !== undefined || turn.prevStepRef !== undefined
      ? { name: turn.prevStepName, ref: turn.prevStepRef }
      : undefined,
  );
}

function defaultLegMeters(step: FlatDetourStep, isUturn: boolean): number {
  const d = step.stepDistanceM;
  const base = Math.min(200, Math.max(90, Math.min(d * 0.52, 150)));
  return isUturn ? Math.min(240, base * 1.4) : base;
}

/**
 * Jug-handle / "three right" detour: go straight past the intersection first, then
 * three right turns so the router does not loop in place before the left.
 */
export function buildThreeRightCorners(lat: number, lon: number, bearingBeforeDeg: number, legM: number): LatLon[] {
  const B0 = ((bearingBeforeDeg % 360) + 360) % 360;
  const d = legM;

  const forwardPt = destinationPoint(lat, lon, B0, d);
  const p1 = destinationPoint(forwardPt.lat, forwardPt.lon, (B0 + 90) % 360, d);
  const p2 = destinationPoint(p1.lat, p1.lon, (B0 + 180) % 360, d);
  const p3 = destinationPoint(p2.lat, p2.lon, (B0 + 270) % 360, d * 0.6);

  return [forwardPt, p1, p2, p3];
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
  timeoutMs = 6000,
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
 * Align left maneuvers from flattened detour steps with indices into the polyline step list
 * so nudge fallbacks target the correct intersection (not always the first left).
 */
function alignLeftTurnsWithPolyline(route: DetourRouteInput): {
  points: RouteStepPoint[];
  turns: FlatDetourStep[];
  atIndices: number[];
} {
  const points = flattenRouteStepPointsForDetour(route);
  const flat = flattenDetourSteps(route);
  const turns = flat.filter(
    (s) =>
      isLeftLikeModifier(s.modifier) &&
      s.maneuverType !== "depart" &&
      s.maneuverType !== "arrive",
  );
  const leftIndices: number[] = [];
  for (let i = 0; i < points.length; i++) {
    if (points[i]!.isLeft) leftIndices.push(i);
  }

  const atIndices: number[] = [];
  if (turns.length === leftIndices.length) {
    for (let i = 0; i < turns.length; i++) atIndices.push(leftIndices[i]!);
  } else {
    for (const turn of turns) {
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < points.length; i++) {
        if (!points[i]!.isLeft) continue;
        const d = haversineMeters({ lat: turn.lat, lon: turn.lon }, points[i]!);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      atIndices.push(best >= 0 ? best : leftIndices[atIndices.length] ?? 0);
    }
  }

  const paired = turns.map((t, i) => ({ t, ai: atIndices[i]!, risk: flatLeftTurnRisk(t) }));
  paired.sort((a, b) => b.risk - a.risk);
  return {
    points,
    turns: paired.map((p) => p.t),
    atIndices: paired.map((p) => p.ai),
  };
}

type WaypointOpts = {
  minSeparationM?: number;
  maxSnapM?: number;
  nearestTimeoutMs?: number;
  skipCount?: number;
};

/**
 * Detour waypoints for one left maneuver (three-right pattern or nudge fallback).
 *
 * Generates candidate jug-handle corners at multiple scales (1x, 1.5x, 2x leg)
 * plus a nudge fallback, then snaps ALL candidates to roads in one parallel batch.
 */
async function waypointsForOneTurn(
  osrmBaseUrl: string,
  turn: FlatDetourStep,
  atPolylineIndex: number,
  points: RouteStepPoint[],
  existingAsLatLon: LatLon[],
  opts: WaypointOpts,
): Promise<{ added: LatLon[]; usedThreeRight: boolean } | null> {
  const minSep = opts.minSeparationM ?? 36;
  const maxSnap = opts.maxSnapM ?? 180;
  const snapTimeout = opts.nearestTimeoutMs ?? 6000;

  const isUturn = turn.modifier.includes("uturn");
  const useSimpleRoundabout = isRoundaboutLike(turn.maneuverType);

  const nudgeRaw = buildRightDetourWaypoint(points, atPolylineIndex);
  const nudgeFallback: LatLon | null = nudgeRaw ? { lat: nudgeRaw[0], lon: nudgeRaw[1] } : null;

  if (useSimpleRoundabout || turn.bearingBefore === undefined || turn.bearingBefore === null) {
    if (!nudgeFallback) return null;
    if (tooCloseToAny(nudgeFallback, existingAsLatLon, minSep)) return null;
    const snap = await snapLatLonToRoad(osrmBaseUrl, nudgeFallback.lat, nudgeFallback.lon, undefined, snapTimeout);
    const point = snap && snap.snapM <= maxSnap ? { lat: snap.lat, lon: snap.lon } : nudgeFallback;
    return { added: [point], usedThreeRight: false };
  }

  const GROUP_NUDGE = -1;
  const legM = defaultLegMeters(turn, isUturn);
  /** Expand leg length on later groups (wider suburban / grid blocks), never shrink. */
  const scaleFactors = [1.0, 1.5, 2.0];

  type Candidate = { groupIdx: number; point: LatLon };
  const candidates: Candidate[] = [];

  for (let gi = 0; gi < scaleFactors.length; gi++) {
    const leg = Math.max(90, Math.min(300, legM * scaleFactors[gi]!));
    const corners = buildThreeRightCorners(turn.lat, turn.lon, turn.bearingBefore, leg);
    for (const c of corners) {
      if (!tooCloseToAny(c, existingAsLatLon, minSep)) {
        candidates.push({ groupIdx: gi, point: c });
      }
    }
  }

  if (nudgeFallback && !tooCloseToAny(nudgeFallback, existingAsLatLon, minSep)) {
    candidates.push({ groupIdx: GROUP_NUDGE, point: nudgeFallback });
  }

  if (candidates.length === 0) return null;

  const snapResults = await Promise.allSettled(
    candidates.map((c) => snapLatLonToRoad(osrmBaseUrl, c.point.lat, c.point.lon, undefined, snapTimeout)),
  );

  const resolved = candidates.map((c, i) => {
    const r = snapResults[i]!;
    if (r.status === "fulfilled" && r.value && r.value.snapM <= maxSnap) {
      return { groupIdx: c.groupIdx, point: { lat: r.value.lat, lon: r.value.lon } };
    }
    return { groupIdx: c.groupIdx, point: c.point };
  });

  for (let gi = 0; gi < scaleFactors.length; gi++) {
    const groupPoints = resolved.filter((r) => r.groupIdx === gi).map((r) => r.point);
    if (groupPoints.length >= 3) {
      return { added: groupPoints, usedThreeRight: true };
    }
  }

  const nudgeResolved = resolved.find((r) => r.groupIdx === GROUP_NUDGE);
  if (nudgeResolved) {
    return { added: [nudgeResolved.point], usedThreeRight: false };
  }

  return null;
}

/**
 * Produce up to four road-snapped jug-handle waypoints or a single nudge waypoint
 * for the Nth remaining left-like maneuver (`opts.skipCount`, default 0).
 */
export async function buildNextOnlyRightWaypoints(
  route: DetourRouteInput,
  osrmBaseUrl: string,
  existingWaypoints: LatLngTuple[],
  opts?: WaypointOpts,
): Promise<{ added: LatLon[]; usedThreeRight: boolean } | null> {
  const { points, turns, atIndices } = alignLeftTurnsWithPolyline(route);
  if (turns.length === 0) return null;

  const targetIdx = opts?.skipCount ?? 0;
  if (targetIdx >= turns.length) return null;

  const existingAsLatLon: LatLon[] = existingWaypoints.map(([lat, lon]) => ({ lat, lon }));
  return waypointsForOneTurn(osrmBaseUrl, turns[targetIdx]!, atIndices[targetIdx]!, points, existingAsLatLon, opts ?? {});
}

export type OptimizeOnlyRightOptions = {
  osrmBaseUrl: string;
  start: LatLngTuple;
  end: LatLngTuple;
  /** Baseline route to rewrite (fastest duration among OSRM alternatives). */
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
  /** Hard wall-clock budget for the entire optimization pass. */
  timeBudgetMs?: number;
  /** Called after each iteration so the UI can show progress. */
  onProgress?: (info: { iteration: number; leftTurns: number; elapsedMs: number }) => void;
};

/**
 * Iteratively adds detour waypoints to eliminate left turns one at a time.
 *
 * When a particular left turn can't be eliminated (waypoints don't reduce the
 * total left-turn count), the optimizer skips it and tries the next remaining
 * left turn instead of giving up entirely.  A wall-clock time budget prevents
 * the process from hanging indefinitely.
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
    maxIterations = 12,
    maxTotalWaypoints = 22,
    routeTimeoutMs = 24000,
    nearestTimeoutMs = 6000,
    timeBudgetMs = 45000,
    onProgress,
  } = options;

  const baselineLeft = countLeftTurnsFromRoute(baseRoute);
  if (baselineLeft === 0) {
    return { route: baseRoute, waypoints: [], strict: true };
  }

  let workingRoute: DetourRouteInput = baseRoute;
  let waypoints: LatLngTuple[] = [];
  let prevLeft = baselineLeft;
  let skipCount = 0;
  const t0 = Date.now();

  for (let iter = 0; iter < maxIterations; iter++) {
    const elapsedMs = Date.now() - t0;
    if (elapsedMs > timeBudgetMs) break;

    const currentLeft = countLeftTurnsFromRoute(workingRoute);
    onProgress?.({ iteration: iter, leftTurns: currentLeft, elapsedMs });
    if (currentLeft === 0) {
      return { route: workingRoute, waypoints, strict: true };
    }

    if (skipCount >= currentLeft) break;

    let chunk: Awaited<ReturnType<typeof buildNextOnlyRightWaypoints>>;
    try {
      chunk = await buildNextOnlyRightWaypoints(workingRoute, osrmBaseUrl, waypoints, {
        nearestTimeoutMs,
        skipCount,
      });
    } catch {
      skipCount++;
      continue;
    }
    if (!chunk || chunk.added.length === 0) {
      skipCount++;
      continue;
    }

    const candidateWps: LatLngTuple[] = [
      ...waypoints,
      ...chunk.added.map((p): LatLngTuple => [p.lat, p.lon]),
    ];
    if (candidateWps.length > maxTotalWaypoints) {
      skipCount++;
      continue;
    }

    try {
      const modified = await fetchRouteViaWaypoints(start, end, candidateWps, {
        timeoutMs: routeTimeoutMs,
      });
      const newLeft = countLeftTurnsFromRoute(modified);
      if (newLeft < prevLeft) {
        prevLeft = newLeft;
        workingRoute = modified;
        waypoints = candidateWps;
        skipCount = 0;
      } else {
        skipCount++;
      }
    } catch {
      skipCount++;
    }
  }

  const finalLeft = countLeftTurnsFromRoute(workingRoute);
  if (finalLeft > baselineLeft) {
    return { route: baseRoute, waypoints: [], strict: false };
  }

  return {
    route: workingRoute,
    waypoints,
    strict: finalLeft === 0,
  };
}
