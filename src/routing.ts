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

export function formatDistance(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m)} m`;
}
