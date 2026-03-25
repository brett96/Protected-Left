/**
 * Photon (Komoot) — OpenStreetMap-based search & reverse geocoding.
 * https://photon.komoot.io/ — free, no API key, CORS-enabled for browsers.
 */

export type PhotonPlace = {
  lat: number;
  lon: number;
  label: string;
};

type PhotonFeature = {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    name?: string;
    street?: string;
    housenumber?: string;
    city?: string;
    state?: string;
    postcode?: string;
    country?: string;
    locality?: string;
    district?: string;
  };
};

function formatFeatureLabel(p: PhotonFeature["properties"]): string {
  if (!p) return "";
  const line1 = [p.housenumber, p.street].filter(Boolean).join(" ").trim();
  const parts = [
    p.name && !line1 ? p.name : null,
    line1 || p.name,
    p.locality || p.city || p.district,
    p.state,
    p.postcode,
    p.country,
  ].filter(Boolean) as string[];
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const part of parts) {
    const t = part.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    deduped.push(t);
  }
  return deduped.join(", ");
}

function featureToPlace(f: PhotonFeature): PhotonPlace | null {
  const coords = f.geometry?.coordinates;
  if (!coords) return null;
  const [lon, lat] = coords;
  const label = formatFeatureLabel(f.properties);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, label: label || `${lat.toFixed(5)}, ${lon.toFixed(5)}` };
}

/** Forward search — autocomplete and single-result geocoding. */
export async function photonSearch(query: string, limit = 8): Promise<PhotonPlace[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", q);
  url.searchParams.set("limit", String(Math.min(Math.max(limit, 1), 15)));
  url.searchParams.set("lang", "en");
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const data = (await res.json()) as { features?: PhotonFeature[] };
  const out: PhotonPlace[] = [];
  for (const f of data.features ?? []) {
    const p = featureToPlace(f);
    if (p) out.push(p);
  }
  return out;
}

/** First match — same as previous geocode() behavior for routing fallback. */
export async function photonGeocodeFirst(query: string): Promise<PhotonPlace> {
  const results = await photonSearch(query, 1);
  const first = results[0];
  if (!first) throw new Error("No place found for that search.");
  return first;
}

/** Reverse geocode coordinates to a display label (e.g. after GPS). */
export async function photonReverse(lon: number, lat: number): Promise<PhotonPlace> {
  const url = new URL("https://photon.komoot.io/reverse");
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lang", "en");
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Reverse geocoding failed (${res.status})`);
  const data = (await res.json()) as { features?: PhotonFeature[] };
  const f = data.features?.[0];
  const p = f ? featureToPlace(f) : null;
  if (p) return p;
  return {
    lat,
    lon,
    label: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
  };
}
