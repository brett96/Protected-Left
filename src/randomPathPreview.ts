import L from "leaflet";

const COLORS = ["#58a6ff", "#3fb950", "#d29922", "#a371f7", "#f778ba", "#79c0ff"] as const;

function ensurePreviewPane(map: L.Map): string {
  const name = "randomPathPreview";
  if (!map.getPane(name)) {
    map.createPane(name);
    const pane = map.getPane(name);
    if (pane) pane.style.zIndex = "420";
  }
  return name;
}

function jitterMagnitude(start: L.LatLngTuple, end: L.LatLngTuple): number {
  const dlat = end[0] - start[0];
  const dlng = end[1] - start[1];
  const span = Math.hypot(dlat, dlng);
  return Math.min(0.14, Math.max(0.006, span * 0.32));
}

function randomWaypoints(start: L.LatLngTuple, end: L.LatLngTuple): L.LatLngExpression[] {
  const mag = jitterMagnitude(start, end);
  const segments = 2 + Math.floor(Math.random() * 5);
  const pts: L.LatLngTuple[] = [start];
  for (let k = 1; k <= segments; k++) {
    const t = k / (segments + 1);
    const wobble = 0.35 + Math.random() * 0.65;
    const lat =
      start[0] + (end[0] - start[0]) * t + (Math.random() - 0.5) * mag * wobble;
    const lng =
      start[1] + (end[1] - start[1]) * t + (Math.random() - 0.5) * mag * wobble;
    pts.push([lat, lng]);
  }
  pts.push(end);
  return pts;
}

export type RandomPathEndpoints = () => readonly [L.LatLngTuple, L.LatLngTuple] | null;

/**
 * Decorative zig-zag paths between two moving endpoints (reads fresh each frame).
 * Renders on a dedicated pane so it stays visible as a “background” effect under the loading UI.
 */
export function startRandomPathPreview(
  map: L.Map,
  getEndpoints: RandomPathEndpoints,
  opts?: { intervalMs?: number; maxLines?: number },
): () => void {
  const intervalMs = opts?.intervalMs ?? 72;
  const maxLines = opts?.maxLines ?? 12;
  const pane = ensurePreviewPane(map);

  const group = L.layerGroup().addTo(map);
  const lines: L.Polyline[] = [];

  const tick = () => {
    const ends = getEndpoints();
    if (!ends) return;
    const [start, end] = ends;

    const addLine = () => {
      const line = L.polyline(randomWaypoints(start, end), {
        color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
        weight: 2 + Math.floor(Math.random() * 3),
        opacity: 0.42 + Math.random() * 0.38,
        dashArray: Math.random() > 0.4 ? `${6 + Math.floor(Math.random() * 6)} ${8 + Math.floor(Math.random() * 8)}` : undefined,
        lineCap: "round",
        lineJoin: "round",
        pane,
        interactive: false,
      });
      line.addTo(group);
      lines.push(line);
    };

    addLine();
    if (Math.random() > 0.35) addLine();

    while (lines.length > maxLines) {
      lines.shift()?.remove();
    }

    for (let i = 0; i < lines.length - 3; i++) {
      const line = lines[i];
      if (!line) continue;
      const o = line.options.opacity ?? 0.5;
      line.setStyle({ opacity: Math.max(0.12, o * 0.88) });
    }
  };

  tick();
  const id = window.setInterval(tick, intervalMs);

  return () => {
    window.clearInterval(id);
    group.removeFrom(map);
  };
}
