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
};

export type RoutableForLeftCount = {
  duration: number;
  distance: number;
  legs?: Array<{
    steps?: Array<{ maneuver?: { modifier?: string } }>;
  }>;
};

export function countLeftTurnsFromRoute(route: RoutableForLeftCount): number {
  let n = 0;
  for (const leg of route.legs ?? []) {
    for (const step of leg.steps ?? []) {
      const mod = step.maneuver?.modifier;
      if (mod && LEFT_MODIFIERS.has(mod)) n++;
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

export function formatDistance(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m)} m`;
}
