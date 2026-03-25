import { photonSearch, type PhotonPlace } from "./photon";

/** Compare user input to a cached label so minor punctuation/spacing differences still count as a match. */
export function addressesMatch(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/\s*,\s*/g, ", ");
  return norm(a) === norm(b);
}

function nominatimBaseUrl(): string {
  return import.meta.env.DEV ? `${window.location.origin}/nominatim` : "https://nominatim.openstreetmap.org";
}

/**
 * OpenStreetMap Nominatim search — often finds house-level addresses when Photon does not.
 * https://nominatim.org/ — use responsibly (low volume; public instances may rate-limit).
 */
async function nominatimSearch(q: string): Promise<PhotonPlace | null> {
  const url = new URL(`${nominatimBaseUrl()}/search`);
  url.searchParams.set("format", "json");
  url.searchParams.set("q", q);
  url.searchParams.set("limit", "1");
  url.searchParams.set("addressdetails", "0");
  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
  const first = data[0];
  if (!first) return null;
  const lat = parseFloat(first.lat);
  const lon = parseFloat(first.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, label: first.display_name };
}

/**
 * Resolve free‑typed text to coordinates: Photon first (fast), then Nominatim fallback.
 * Does not require picking a suggestion — any address string can be used (e.g. tap Route).
 */
export async function geocodeAddress(query: string): Promise<PhotonPlace> {
  const q = query.trim();
  if (q.length < 2) {
    throw new Error("Enter a more complete address.");
  }

  let photonResults: Awaited<ReturnType<typeof photonSearch>> = [];
  try {
    photonResults = await photonSearch(q, 10);
  } catch {
    // Network or API error — try Nominatim
  }
  if (photonResults.length > 0) {
    return photonResults[0]!;
  }

  const nom = await nominatimSearch(q);
  if (nom) return nom;

  throw new Error(
    "No location found for that text. Try adding city, state/province, or postal code.",
  );
}
