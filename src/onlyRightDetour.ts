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
  weightedLeftRiskFromRoute,
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
  // Suburban grids often require deeper “reach” than 90–200m; otherwise points snap
  // to cul-de-sacs, parking lots, or back onto the arterial.
  const risk = flatLeftTurnRisk(step);
  // High-risk lefts (arterials) need deeper reach to clear into parallel
  // neighborhood streets; low-risk lefts keep the tighter original range.
  const riskCap = risk >= 5 ? 900 : 600;
  const base = Math.min(riskCap, Math.max(150, Math.min(d * 0.75, 500)));
  return isUturn ? Math.min(1000, base * 1.4) : base;
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
  // Make the final point “commit” onto the cross street past the intersection, so OSRM
  // is less likely to dip in then U-turn back to the arterial.
  const p3 = destinationPoint(p2.lat, p2.lon, (B0 + 270) % 360, d);

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
  const list = await snapNearestRoadCandidates(osrmBaseUrl, lat, lon, 1, init, timeoutMs);
  return list[0] ?? null;
}

/**
 * Multiple nearest drivable points (OSRM `number` > 1) to sample different
 * nearby road segments around an intersection.
 */
export async function snapNearestRoadCandidates(
  osrmBaseUrl: string,
  lat: number,
  lon: number,
  number: number,
  init?: RequestInit,
  timeoutMs = 6000,
): Promise<Array<{ lat: number; lon: number; snapM: number }>> {
  const n = Math.min(15, Math.max(1, Math.floor(number)));
  const url = `${osrmBaseUrl}/nearest/v1/driving/${lon},${lat}?number=${n}`;
  const controller = new AbortController();
  const tid = window.setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(tid);
  }
  if (!res.ok) return [];
  const data = (await res.json()) as NearestResponse;
  if (data.code !== "Ok" || !data.waypoints?.length) return [];
  const out: Array<{ lat: number; lon: number; snapM: number }> = [];
  const seen = new Set<string>();
  for (const w of data.waypoints) {
    const loc = w.location;
    if (!loc || loc.length < 2) continue;
    const [lon2, lat2] = loc;
    const snapM = w.distance ?? 0;
    if (!Number.isFinite(lat2) || !Number.isFinite(lon2)) continue;
    const key = `${lat2.toFixed(5)},${lon2.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ lat: lat2, lon: lon2, snapM });
  }
  return out;
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

function jugBearingsForTurn(turn: FlatDetourStep, n: number): Array<{ bearing: number; range: number } | null> {
  const B0 = (((turn.bearingBefore ?? 0) % 360) + 360) % 360;
  const seq = [
    { bearing: B0, range: 35 },
    { bearing: (B0 + 90) % 360, range: 35 },
    { bearing: (B0 + 180) % 360, range: 35 },
    { bearing: (B0 + 270) % 360, range: 35 },
  ];
  return seq.slice(0, n);
}

function chunkFingerprint(pts: LatLon[]): string {
  return pts.map((p) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`).join("|");
}

function estimateJugPathMeters(pts: LatLon[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += haversineMeters(pts[i - 1]!, pts[i]!);
  return s;
}

/**
 * Build several jug-handle waypoint sets for one left maneuver: anchor offsets,
 * scales, and multiple OSRM nearest snaps on the first leg so different side
 * streets are considered before /route chooses a path.
 */
async function buildDetourChunksForOneTurn(
  osrmBaseUrl: string,
  turn: FlatDetourStep,
  atPolylineIndex: number,
  points: RouteStepPoint[],
  existingAsLatLon: LatLon[],
  opts: WaypointOpts,
): Promise<OnlyRightWaypointChunk[]> {
  const minSep = opts.minSeparationM ?? 36;
  const maxSnap = opts.maxSnapM ?? 180;
  const snapTimeout = opts.nearestTimeoutMs ?? 6000;

  const isUturn = turn.modifier.includes("uturn");
  const useSimpleRoundabout = isRoundaboutLike(turn.maneuverType);

  const nudgeRaw = buildRightDetourWaypoint(points, atPolylineIndex);
  const nudgeFallback: LatLon | null = nudgeRaw ? { lat: nudgeRaw[0], lon: nudgeRaw[1] } : null;

  if (useSimpleRoundabout || turn.bearingBefore === undefined || turn.bearingBefore === null) {
    if (!nudgeFallback) return [];
    if (tooCloseToAny(nudgeFallback, existingAsLatLon, minSep)) return [];
    const snap = await snapLatLonToRoad(osrmBaseUrl, nudgeFallback.lat, nudgeFallback.lon, undefined, snapTimeout);
    const point = snap && snap.snapM <= maxSnap ? { lat: snap.lat, lon: snap.lon } : nudgeFallback;
    return [{ added: [point], usedThreeRight: false, bearings: [null], radiuses: [55] }];
  }

  const B0 = (((turn.bearingBefore % 360) + 360) % 360);
  const legM = defaultLegMeters(turn, isUturn);
  const anchorCombos: Array<{ forwardM: number; lateralM: number; scale: number }> = [
    { forwardM: 0, lateralM: 0, scale: 1 },
    { forwardM: 45, lateralM: 0, scale: 1.75 },
    { forwardM: -30, lateralM: 0, scale: 2.25 },
    { forwardM: 0, lateralM: 55, scale: 2 },
    { forwardM: 40, lateralM: 55, scale: 2.5 },
    { forwardM: 0, lateralM: 0, scale: 2.75 },
    { forwardM: 0, lateralM: 100, scale: 3.0 },
    { forwardM: 60, lateralM: 100, scale: 3.0 },
    { forwardM: 0, lateralM: 150, scale: 3.5 },
    { forwardM: -40, lateralM: 150, scale: 3.5 },
  ];

  type RawJug = { pts: LatLon[]; leg: number };
  const rawJugs: RawJug[] = [];
  for (const { forwardM, lateralM, scale } of anchorCombos) {
    const along = destinationPoint(turn.lat, turn.lon, B0, forwardM);
    const anchor =
      lateralM === 0 ? along : destinationPoint(along.lat, along.lon, (B0 + 90) % 360, lateralM);
    const leg = Math.max(150, Math.min(1100, legM * scale));
    rawJugs.push({ pts: buildThreeRightCorners(anchor.lat, anchor.lon, B0, leg), leg });
  }

  const chunks: OnlyRightWaypointChunk[] = [];
  const seenFp = new Set<string>();
  const maxChunks = 12;
  const maxForwardSnaps = 2;

  for (const { pts: idealFour, leg: legSeg } of rawJugs) {
    if (chunks.length >= maxChunks) break;
    const forwardIdeal = idealFour[0]!;
    if (tooCloseToAny(forwardIdeal, existingAsLatLon, minSep)) continue;

    const forwardChoices = await snapNearestRoadCandidates(
      osrmBaseUrl,
      forwardIdeal.lat,
      forwardIdeal.lon,
      6,
      undefined,
      snapTimeout,
    );
    const forwards = forwardChoices.filter((c) => c.snapM <= maxSnap).slice(0, maxForwardSnaps);
    if (forwards.length === 0) continue;

    for (const f0 of forwards) {
      if (chunks.length >= maxChunks) break;
      if (tooCloseToAny(f0, existingAsLatLon, minSep)) continue;

      const p1 = destinationPoint(f0.lat, f0.lon, (B0 + 90) % 360, legSeg);
      const p2 = destinationPoint(p1.lat, p1.lon, (B0 + 180) % 360, legSeg);
      const p3 = destinationPoint(p2.lat, p2.lon, (B0 + 270) % 360, legSeg);
      const toSnap = [p1, p2, p3];

      const snaps = await Promise.all(
        toSnap.map((p) => snapLatLonToRoad(osrmBaseUrl, p.lat, p.lon, undefined, snapTimeout)),
      );

      const groupPoints: LatLon[] = [f0];
      for (let i = 0; i < snaps.length; i++) {
        const s = snaps[i]!;
        const raw = toSnap[i]!;
        const pt =
          s && s.snapM <= maxSnap ? { lat: s.lat, lon: s.lon } : raw;
        if (tooCloseToAny(pt, [...existingAsLatLon, ...groupPoints], minSep)) {
          groupPoints.length = 0;
          break;
        }
        groupPoints.push(pt);
      }

      if (groupPoints.length !== 4) continue;

      const fp = chunkFingerprint(groupPoints);
      if (seenFp.has(fp)) continue;
      seenFp.add(fp);

      chunks.push({
        added: groupPoints,
        usedThreeRight: true,
        bearings: jugBearingsForTurn(turn, 4),
        radiuses: [45, 45, 45, 45],
      });
    }
  }

  chunks.sort((a, b) => estimateJugPathMeters(a.added) - estimateJugPathMeters(b.added));

  if (nudgeFallback && !tooCloseToAny(nudgeFallback, existingAsLatLon, minSep)) {
    const snap = await snapLatLonToRoad(osrmBaseUrl, nudgeFallback.lat, nudgeFallback.lon, undefined, snapTimeout);
    const point = snap && snap.snapM <= maxSnap ? { lat: snap.lat, lon: snap.lon } : nudgeFallback;
    chunks.push({ added: [point], usedThreeRight: false, bearings: [null], radiuses: [55] });
  }

  return chunks;
}

export type OnlyRightWaypointChunk = {
  added: LatLon[];
  usedThreeRight: boolean;
  bearings?: Array<{ bearing: number; range: number } | null>;
  radiuses?: Array<number | null>;
};

/**
 * Produce up to four road-snapped jug-handle waypoints or a single nudge waypoint
 * for the Nth remaining left-like maneuver (`opts.skipCount`, default 0).
 */
export async function buildDetourChunksForNextLeft(
  route: DetourRouteInput,
  osrmBaseUrl: string,
  existingWaypoints: LatLngTuple[],
  opts?: WaypointOpts,
): Promise<OnlyRightWaypointChunk[]> {
  const { points, turns, atIndices } = alignLeftTurnsWithPolyline(route);
  if (turns.length === 0) return [];

  const targetIdx = opts?.skipCount ?? 0;
  if (targetIdx >= turns.length) return [];

  const existingAsLatLon: LatLon[] = existingWaypoints.map(([lat, lon]) => ({ lat, lon }));
  return buildDetourChunksForOneTurn(
    osrmBaseUrl,
    turns[targetIdx]!,
    atIndices[targetIdx]!,
    points,
    existingAsLatLon,
    opts ?? {},
  );
}

export async function buildNextOnlyRightWaypoints(
  route: DetourRouteInput,
  osrmBaseUrl: string,
  existingWaypoints: LatLngTuple[],
  opts?: WaypointOpts,
): Promise<OnlyRightWaypointChunk | null> {
  const chunks = await buildDetourChunksForNextLeft(route, osrmBaseUrl, existingWaypoints, opts);
  return chunks[0] ?? null;
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
    opts?: {
      timeoutMs?: number;
      /** Optional OSRM bearings param entries for *via points only* (start/end handled by caller). */
      viaBearings?: Array<{ bearing: number; range: number } | null>;
      /** Optional OSRM radiuses param entries for *via points only* (start/end handled by caller). */
      viaRadiuses?: Array<number | null>;
    },
  ) => Promise<DetourRouteInput>;
  /** Number of optimization passes (each targets the next worst remaining left). Default 6. */
  maxIterations?: number;
  maxTotalWaypoints?: number;
  /**
   * Max additional left turns allowed vs the baseline when accepting a
   * risk-improving detour (e.g. trading one arterial left for several
   * neighborhood lefts). Default 4.
   */
  maxLeftCountIncrease?: number;
  /** Minimum time budget for OSRM /route with intermediate waypoints (see main.ts scaling). */
  routeTimeoutMs?: number;
  /** Per /nearest snap call; each snap uses its own timer. */
  nearestTimeoutMs?: number;
  /** Wall-clock budget per pass (trying detour candidates for one left). Default 5000ms. */
  timeBudgetMsPerPass?: number;
  /** Called when pass state changes (start of pass, after a successful conversion). */
  onProgress?: (info: {
    pass: number;
    passMax: number;
    leftTurns: number;
    passElapsedMs: number;
    totalElapsedMs: number;
  }) => void;
};

/**
 * Iteratively adds detour waypoints to eliminate left turns one at a time.
 *
 * Accepts a candidate when it either reduces the raw left-turn count *or*
 * reduces the risk-weighted left score (allowing safe neighborhood lefts to
 * replace dangerous arterial lefts). A hard cap on additional left count
 * prevents runaway detours.
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
    maxIterations = 6,
    maxTotalWaypoints = 30,
    maxLeftCountIncrease = 4,
    routeTimeoutMs = 6000,
    nearestTimeoutMs = 3500,
    timeBudgetMsPerPass = 8000,
    onProgress,
  } = options;

  const baselineLeft = countLeftTurnsFromRoute(baseRoute);
  if (baselineLeft === 0) {
    return { route: baseRoute, waypoints: [], strict: true };
  }

  const baselineRisk = weightedLeftRiskFromRoute(baseRoute).totalScore;

  let workingRoute: DetourRouteInput = baseRoute;
  let waypoints: LatLngTuple[] = [];
  let prevLeft = baselineLeft;
  let prevRisk = baselineRisk;
  let skipCount = 0;
  const t0 = Date.now();
  const passMax = maxIterations;

  const emitProgress = (pass: number, passStart: number) => {
    const now = Date.now();
    onProgress?.({
      pass,
      passMax,
      leftTurns: countLeftTurnsFromRoute(workingRoute),
      passElapsedMs: now - passStart,
      totalElapsedMs: now - t0,
    });
  };

  for (let iter = 0; iter < maxIterations; iter++) {
    const passStart = Date.now();
    const currentLeft = countLeftTurnsFromRoute(workingRoute);
    emitProgress(iter + 1, passStart);

    if (currentLeft === 0) {
      return { route: workingRoute, waypoints, strict: true };
    }

    if (skipCount >= currentLeft) break;

    let chunks: OnlyRightWaypointChunk[];
    try {
      chunks = await buildDetourChunksForNextLeft(workingRoute, osrmBaseUrl, waypoints, {
        nearestTimeoutMs,
        skipCount,
      });
    } catch {
      skipCount++;
      continue;
    }
    if (chunks.length === 0) {
      skipCount++;
      continue;
    }

    let accepted = false;
    for (const chunk of chunks) {
      if (Date.now() - passStart > timeBudgetMsPerPass) break;

      const candidateWps: LatLngTuple[] = [
        ...waypoints,
        ...chunk.added.map((p): LatLngTuple => [p.lat, p.lon]),
      ];
      if (candidateWps.length > maxTotalWaypoints) continue;

      try {
        const modified = await fetchRouteViaWaypoints(start, end, candidateWps, {
          timeoutMs: routeTimeoutMs,
          viaBearings: chunk.bearings,
          viaRadiuses: chunk.radiuses,
        });
        const newLeft = countLeftTurnsFromRoute(modified);
        const { totalScore: newRisk } = weightedLeftRiskFromRoute(modified);

        const countImproved = newLeft < prevLeft;
        const riskImproved = newRisk < prevRisk;
        const notRunaway = newLeft <= baselineLeft + maxLeftCountIncrease;

        if ((countImproved || riskImproved) && notRunaway) {
          prevLeft = newLeft;
          prevRisk = newRisk;
          workingRoute = modified;
          waypoints = candidateWps;
          skipCount = 0;
          accepted = true;
          emitProgress(iter + 1, passStart);
          break;
        }
      } catch {
        /* try next chunk */
      }
    }

    if (!accepted) skipCount++;
  }

  const finalLeft = countLeftTurnsFromRoute(workingRoute);
  const finalRisk = weightedLeftRiskFromRoute(workingRoute).totalScore;
  if (finalLeft > baselineLeft && finalRisk >= baselineRisk) {
    return { route: baseRoute, waypoints: [], strict: false };
  }

  return {
    route: workingRoute,
    waypoints,
    strict: finalLeft === 0,
  };
}
