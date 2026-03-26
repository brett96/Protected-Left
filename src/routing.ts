/** Modifiers OSRM uses for leftward maneuvers (proxy for “unprotected left” risk). */
const LEFT_MODIFIERS = new Set([
  "slight left",
  "left",
  "sharp left",
  "uturn",
]);

export type OsrmRouteSummary = {
  /** Index in OSRM `routes` array */
  index: number;
  /** Count of left / U-turn maneuvers in instructions */
  leftTurns: number;
  /** Duration in seconds */
  durationSec: number;
  /** Distance in meters */
  distanceM: number;
  /**
   * Sum of per-turn risk weights (arterial / highway context costs more than lanes & courts).
   * Filled when using only-right baseline selection.
   */
  weightedLeftRisk?: number;
  /** Left maneuvers whose risk weight is at or above {@link MAJOR_ROAD_LEFT_RISK_THRESHOLD}. */
  majorRoadLeftTurns?: number;
};

/** Weights at or above this count as a “major road” style left for summaries and tie-breaks. */
export const MAJOR_ROAD_LEFT_RISK_THRESHOLD = 4;

export type RoutableForLeftCount = {
  duration: number;
  distance: number;
  legs?: Array<{
    steps?: Array<{
      name?: string;
      ref?: string;
      distance?: number;
      classes?: string[];
      maneuver?: { modifier?: string; type?: string; location?: [number, number] };
    }>;
  }>;
};

export function countLeftTurnsFromRoute(route: RoutableForLeftCount): number {
  let n = 0;
  for (const leg of route.legs ?? []) {
    for (const step of leg.steps ?? []) {
      const mod = step.maneuver?.modifier;
      if (!mod) continue;
      const m = mod.toLowerCase();
      // Be defensive: OSRM's modifier vocabulary can vary by region/dataset.
      if (LEFT_MODIFIERS.has(mod) || m.includes("uturn") || m.includes("left")) n++;
    }
  }
  return n;
}

export function summarizeRoutes(routes: RoutableForLeftCount[]): OsrmRouteSummary[] {
  return routes.map((route, index) => ({
    index,
    leftTurns: countLeftTurnsFromRoute(route),
    durationSec: route.duration,
    distanceM: route.distance,
  }));
}

/** Pick route with fewest left turns; tie-break: shorter duration, then shorter distance. */
export function pickProtectedLeftRoute(
  summaries: OsrmRouteSummary[],
): OsrmRouteSummary | null {
  if (summaries.length === 0) return null;
  return [...summaries].sort((a, b) => {
    if (a.leftTurns !== b.leftTurns) return a.leftTurns - b.leftTurns;
    if (a.durationSec !== b.durationSec) return a.durationSec - b.durationSec;
    return a.distanceM - b.distanceM;
  })[0];
}

function isBetterCandidate(a: OsrmRouteSummary, b: OsrmRouteSummary): boolean {
  if (a.leftTurns !== b.leftTurns) return a.leftTurns < b.leftTurns;
  if (a.durationSec !== b.durationSec) return a.durationSec < b.durationSec;
  return a.distanceM < b.distanceM;
}

/** One pass: build summaries and pick best (no full-array sort). */
export function summarizeAndPickBest(routes: RoutableForLeftCount[]): {
  summaries: OsrmRouteSummary[];
  best: OsrmRouteSummary | null;
} {
  if (routes.length === 0) return { summaries: [], best: null };
  const summaries: OsrmRouteSummary[] = new Array(routes.length);
  let bestIdx = 0;
  for (let i = 0; i < routes.length; i++) {
    const route = routes[i]!;
    summaries[i] = {
      index: i,
      leftTurns: countLeftTurnsFromRoute(route),
      durationSec: route.duration,
      distanceM: route.distance,
    };
    if (i > 0 && isBetterCandidate(summaries[i]!, summaries[bestIdx]!)) {
      bestIdx = i;
    }
  }
  return { summaries, best: summaries[bestIdx]! };
}

/** Fastest route by duration, then shortest distance (ignores left-turn count). */
export function pickFastestFromSummaries(summaries: OsrmRouteSummary[]): OsrmRouteSummary | null {
  if (summaries.length === 0) return null;
  let bestIdx = 0;
  for (let i = 1; i < summaries.length; i++) {
    const a = summaries[i]!;
    const b = summaries[bestIdx]!;
    if (a.durationSec < b.durationSec) bestIdx = i;
    else if (a.durationSec === b.durationSec && a.distanceM < b.distanceM) bestIdx = i;
  }
  return summaries[bestIdx]!;
}

type OsrmStepForRisk = {
  name?: string;
  ref?: string;
  classes?: string[];
  maneuver?: { modifier?: string; type?: string };
};

function weightFromOsrmClasses(classes: string[] | undefined): number | null {
  if (!classes?.length) return null;
  if (classes.includes("motorway") || classes.includes("motorway_link")) return 14;
  if (classes.includes("trunk")) return 11;
  if (classes.includes("primary")) return 9;
  if (classes.includes("secondary")) return 6;
  if (classes.includes("tertiary")) return 3.5;
  if (classes.includes("residential") || classes.includes("living_street")) return 1;
  if (classes.includes("service")) return 1.3;
  return null;
}

/**
 * Rough road-context weight from name/ref when OSRM does not expose `classes` on steps.
 * Higher ≈ faster / wider roads where an unprotected left is riskier.
 */
export function roadContextWeightFromNameRef(name: string, ref: string): number {
  const n = name.toLowerCase().trim();
  const r = ref.trim();

  if (/\b(i|us|sr|ca|hi|az|tx|fl|ny|nv)\s*-?\s*\d+/i.test(r)) return 12;
  if (/^(sr|sh|cr|tr)\s*-?\s*\d+/i.test(r)) return 7;

  if (/\b(freeway|expressway|fwy|expy)\b/.test(n)) return 10;
  if (/\b(highway|hwy)\b/.test(n)) return 8;
  if (/\b(parkway|pkwy)\b/.test(n)) return 6;
  if (/\b(boulevard|blvd)\b/.test(n)) return 5;
  if (/\b(avenue|ave)\b/.test(n)) return 4;
  if (/\b(street|st)\b/.test(n)) return 3;
  if (/\b(road|rd)\b/.test(n)) return 2.5;
  if (/\b(drive|dr)\b/.test(n)) return 2;
  if (/\b(lane|ln)\b/.test(n)) return 1;
  if (/\b(place|pl)\b/.test(n)) return 1;
  if (/\b(court|ct)\b/.test(n)) return 1;
  if (/\b(circle|cir)\b/.test(n)) return 1;
  if (/\b(way)\b/.test(n)) return 1.5;
  if (/\b(terrace|ter)\b/.test(n)) return 1;
  if (/\b(trail|path)\b/.test(n)) return 1;
  if (!n) return 2;
  return 2.5;
}

export function roadContextWeightFromStep(step?: OsrmStepForRisk): number {
  if (!step) return 2;
  const cw = weightFromOsrmClasses(step.classes);
  if (cw !== null) return cw;
  return roadContextWeightFromNameRef(step.name ?? "", step.ref ?? "");
}

/**
 * Risk weight for one left/U-turn maneuver: max of approach and departure road context,
 * with U-turns always treated as high-friction.
 */
export function leftTurnRiskWeightForSteps(step: OsrmStepForRisk, prevStep?: OsrmStepForRisk): number {
  const wAfter = roadContextWeightFromStep(step);
  const wBefore = roadContextWeightFromStep(prevStep);
  let base = Math.max(wAfter, wBefore);
  const mod = (step.maneuver?.modifier ?? "").toLowerCase();
  if (mod.includes("uturn")) base = Math.max(base, 9);
  return base;
}

export function weightedLeftRiskFromRoute(route: RoutableForLeftCount): {
  totalScore: number;
  majorRoadLeftTurns: number;
} {
  let totalScore = 0;
  let majorRoadLeftTurns = 0;
  let prevLegLastStep: OsrmStepForRisk | undefined;

  for (const leg of route.legs ?? []) {
    const steps = leg.steps ?? [];
    for (let si = 0; si < steps.length; si++) {
      const step = steps[si]!;
      const mod = step.maneuver?.modifier;
      if (!mod) continue;
      const m = mod.toLowerCase();
      const type = (step.maneuver?.type ?? "").toLowerCase();
      if (type === "depart" || type === "arrive") continue;
      if (!(LEFT_MODIFIERS.has(mod) || m.includes("uturn") || m.includes("left"))) continue;

      const prevInLeg = si > 0 ? steps[si - 1] : undefined;
      const prev = prevInLeg ?? prevLegLastStep;
      const w = leftTurnRiskWeightForSteps(step, prev);
      totalScore += w;
      if (w >= MAJOR_ROAD_LEFT_RISK_THRESHOLD) majorRoadLeftTurns++;
    }
    const last = steps[steps.length - 1];
    if (last) prevLegLastStep = last;
  }

  return { totalScore, majorRoadLeftTurns };
}

function isBetterOnlyRightBaseline(a: OsrmRouteSummary, b: OsrmRouteSummary): boolean {
  const ra = a.weightedLeftRisk ?? 0;
  const rb = b.weightedLeftRisk ?? 0;
  if (ra !== rb) return ra < rb;
  const ma = a.majorRoadLeftTurns ?? 0;
  const mb = b.majorRoadLeftTurns ?? 0;
  if (ma !== mb) return ma < mb;
  if (a.leftTurns !== b.leftTurns) return a.leftTurns < b.leftTurns;
  if (a.durationSec !== b.durationSec) return a.durationSec < b.durationSec;
  return a.distanceM < b.distanceM;
}

/**
 * Picks the OSRM alternative that minimizes risky (arterial-style) left turns first,
 * allowing longer neighborhood-heavy options when their weighted score is lower.
 */
export function pickBestOnlyRightBaseline(routes: RoutableForLeftCount[]): {
  summaries: OsrmRouteSummary[];
  best: OsrmRouteSummary | null;
} {
  if (routes.length === 0) return { summaries: [], best: null };
  const summaries: OsrmRouteSummary[] = new Array(routes.length);
  let bestIdx = 0;
  for (let i = 0; i < routes.length; i++) {
    const route = routes[i]!;
    const leftTurns = countLeftTurnsFromRoute(route);
    const { totalScore, majorRoadLeftTurns } = weightedLeftRiskFromRoute(route);
    summaries[i] = {
      index: i,
      leftTurns,
      durationSec: route.duration,
      distanceM: route.distance,
      weightedLeftRisk: totalScore,
      majorRoadLeftTurns,
    };
    if (i > 0 && isBetterOnlyRightBaseline(summaries[i]!, summaries[bestIdx]!)) {
      bestIdx = i;
    }
  }
  return { summaries, best: summaries[bestIdx]! };
}

/** Full per-route summaries including risk-weighted left scores (for only-right UI / refresh). */
export function summarizeRoutesWithRisk(routes: RoutableForLeftCount[]): OsrmRouteSummary[] {
  return routes.map((route, index) => {
    const { totalScore, majorRoadLeftTurns } = weightedLeftRiskFromRoute(route);
    return {
      index,
      leftTurns: countLeftTurnsFromRoute(route),
      durationSec: route.duration,
      distanceM: route.distance,
      weightedLeftRisk: totalScore,
      majorRoadLeftTurns,
    };
  });
}

export type OnlyRightTurnsPick = {
  summaries: OsrmRouteSummary[];
  /** Selected route by the chosen constraints. */
  best: OsrmRouteSummary | null;
  /**
   * True when we found at least one strict candidate (leftTurns === 0),
   * false when we had to fall back to the “best available” route.
   */
  strict: boolean;
  /** Route indices in `summaries` that are allowed in the UI. */
  allowedIndices: number[];
};

/**
 * Picks a route that avoids leftward maneuvers as much as possible.
 *
 * Strict mode means we only consider routes with `leftTurns === 0`
 * (including U-turns).
 */
export function summarizeAndPickOnlyRightTurnsBest(
  routes: RoutableForLeftCount[],
): OnlyRightTurnsPick {
  if (routes.length === 0) {
    return { summaries: [], best: null, strict: false, allowedIndices: [] };
  }

  const summaries: OsrmRouteSummary[] = new Array(routes.length);
  let bestOverallIdx = 0;
  let bestStrictIdx: number | null = null;

  for (let i = 0; i < routes.length; i++) {
    const route = routes[i]!;
    const s: OsrmRouteSummary = {
      index: i,
      leftTurns: countLeftTurnsFromRoute(route),
      durationSec: route.duration,
      distanceM: route.distance,
    };
    summaries[i] = s;

    if (i > 0 && isBetterCandidate(s, summaries[bestOverallIdx]!)) {
      bestOverallIdx = i;
    }

    if (s.leftTurns === 0) {
      if (bestStrictIdx === null) {
        bestStrictIdx = i;
      } else {
        // For strict candidates: tie-break like normal, but only among leftTurns==0 routes.
        const cur = summaries[i]!;
        const prev = summaries[bestStrictIdx]!;
        if (
          cur.leftTurns !== prev.leftTurns ||
          (cur.leftTurns === prev.leftTurns &&
            (cur.durationSec !== prev.durationSec
              ? cur.durationSec < prev.durationSec
              : cur.distanceM < prev.distanceM))
        ) {
          bestStrictIdx = i;
        }
      }
    }
  }

  const strict = bestStrictIdx !== null;
  const allowedIndices = strict
    ? summaries.filter((s) => s.leftTurns === 0).map((s) => s.index)
    : summaries.map((s) => s.index);
  const best = strict ? summaries[bestStrictIdx!] : summaries[bestOverallIdx]!;

  return { summaries, best, strict, allowedIndices };
}

export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${h} h ${mm} min`;
  }
  return `${m} min ${s} s`;
}

const METERS_PER_MILE = 1609.344;
const FEET_PER_METER = 3.28084;

/** Formats OSRM distance in meters for US-style display (miles, feet when very short). */
export function formatDistance(m: number): string {
  if (!Number.isFinite(m) || m < 0) return "—";
  const mi = m / METERS_PER_MILE;
  if (mi >= 10) return `${Math.round(mi)} mi`;
  if (mi >= 0.1) return `${mi.toFixed(1)} mi`;
  const ft = m * FEET_PER_METER;
  return `${Math.round(ft)} ft`;
}

/** OSRM step shape needed to build spoken / UI instructions (no `instruction` field in JSON). */
export type OsrmStepForInstruction = {
  name?: string;
  ref?: string;
  destinations?: string;
  maneuver?: {
    type?: string;
    modifier?: string;
    /** Some deployments include this; public OSRM often does not. */
    instruction?: string;
    exit?: number;
    /** [lon, lat] */
    location?: [number, number];
  };
};

function ontoName(name: string): string {
  const n = name.trim();
  return n ? ` onto ${n}` : "";
}

function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/**
 * Human-readable English instruction for one OSRM step (public OSRM does not return `instruction`).
 */
export function instructionFromOsrmStep(step: OsrmStepForInstruction): string {
  const m = step.maneuver;
  const embedded = (m?.instruction ?? "").trim();
  if (embedded) return embedded;

  const name = (step.name ?? "").trim();
  const type = (m?.type ?? "").toLowerCase();
  const modifier = (m?.modifier ?? "").toLowerCase();
  const exit = m?.exit;

  const modPhrase = modifier ? modifier.replace(/^\w/, (c) => c.toUpperCase()) : "";

  switch (type) {
    case "depart":
      if (name) return modPhrase ? `Head ${modifier}${ontoName(name)}` : `Start on ${name}`;
      return modPhrase ? `Head ${modifier}` : "Start navigation";
    case "arrive":
      return "You have arrived at your destination";
    case "turn":
    case "end of road":
      if (modifier && name) return `Turn ${modifier}${ontoName(name)}`;
      if (modifier) return `Turn ${modifier}`;
      return name ? `Turn${ontoName(name)}` : "Turn";
    case "continue":
      if (name) return `Continue on ${name}`;
      return "Continue";
    case "new name":
      if (name) return `Continue onto ${name}`;
      return "Continue";
    case "merge":
      return modPhrase ? `Merge ${modifier}` : "Merge";
    case "on ramp":
      return name ? `Take the ramp${ontoName(name)}` : "Take the ramp";
    case "off ramp":
      return modPhrase ? `Take the exit on the ${modifier}` : "Take the exit";
    case "fork":
      if (modifier && name) return `At the fork, keep ${modifier}${ontoName(name)}`;
      if (modifier) return `At the fork, keep ${modifier}`;
      return "At the fork, keep straight";
    case "roundabout":
    case "rotary":
      if (typeof exit === "number" && Number.isFinite(exit)) {
        const ex = ordinal(exit);
        return name
          ? `At the roundabout, take the ${ex} exit${ontoName(name)}`
          : `At the roundabout, take the ${ex} exit`;
      }
      return "Enter the roundabout";
    case "exit roundabout":
    case "exit rotary":
      if (typeof exit === "number" && Number.isFinite(exit)) {
        const ex = ordinal(exit);
        return name ? `Leave the roundabout at the ${ex} exit${ontoName(name)}` : `Leave the roundabout at the ${ex} exit`;
      }
      return name ? `Exit the roundabout${ontoName(name)}` : "Exit the roundabout";
    case "roundabout turn":
      if (typeof exit === "number" && Number.isFinite(exit)) {
        return name
          ? `At the roundabout, take the ${ordinal(exit)} exit${ontoName(name)}`
          : `At the roundabout, take the ${ordinal(exit)} exit`;
      }
      return modPhrase ? `At the roundabout, turn ${modifier}` : "At the roundabout";
    case "notification":
      return name || "Continue";
    default:
      if (modifier && name) return `${modPhrase}${ontoName(name)}`;
      if (name) return `Continue on ${name}`;
      if (modifier) return modPhrase;
      return "Continue";
  }
}

/** Step points along the route with left-turn markers (for detour waypoints). */
export type RouteStepPoint = {
  lat: number;
  lon: number;
  isLeft: boolean;
};

export function flattenRouteStepPointsForDetour(route: RoutableForLeftCount): RouteStepPoint[] {
  const out: RouteStepPoint[] = [];
  for (const leg of route.legs ?? []) {
    for (const step of leg.steps ?? []) {
      const loc = step.maneuver?.location;
      if (!loc || loc.length < 2) continue;
      const lon = loc[0]!;
      const lat = loc[1]!;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const mod = (step.maneuver?.modifier ?? "").toLowerCase();
      const isLeft = mod.includes("uturn") || mod.includes("left");
      out.push({ lat, lon, isLeft });
    }
  }
  return out;
}

export function firstLeftTurnStepIndex(points: RouteStepPoint[]): number {
  return points.findIndex((p) => p.isLeft);
}

/**
 * Places a waypoint to the right of a left turn so OSRM may choose a right-turn detour instead.
 * Uses previous / current / next maneuver locations in route order.
 */
export function buildRightDetourWaypoint(
  points: Array<{ lat: number; lon: number }>,
  atIndex: number,
  opts?: { rightOffsetM?: number; forwardOffsetM?: number },
): [number, number] | null {
  const here = points[atIndex];
  const prev = points[atIndex - 1];
  const next = points[atIndex + 1];
  if (!here || !prev || !next) return null;

  const RIGHT_OFFSET_M = opts?.rightOffsetM ?? 55;
  const FORWARD_OFFSET_M = opts?.forwardOffsetM ?? 15;

  const dxLon = next.lon - prev.lon;
  const dyLat = next.lat - prev.lat;
  const len = Math.hypot(dxLon, dyLat);
  if (!len || !Number.isFinite(len)) return null;

  const unitLon = dxLon / len;
  const unitLat = dyLat / len;

  const rightLonUnit = dyLat / len;
  const rightLatUnit = -dxLon / len;

  const latRad = (here.lat * Math.PI) / 180;
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.cos(latRad) || 1;

  const rightLatDeg = (rightLatUnit * RIGHT_OFFSET_M) / metersPerDegLat;
  const rightLonDeg = (rightLonUnit * RIGHT_OFFSET_M) / metersPerDegLon;

  const fwdLatDeg = (unitLat * FORWARD_OFFSET_M) / metersPerDegLat;
  const fwdLonDeg = (unitLon * FORWARD_OFFSET_M) / metersPerDegLon;

  return [here.lat + rightLatDeg + fwdLatDeg, here.lon + rightLonDeg + fwdLonDeg];
}
