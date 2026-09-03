/**
 * Place name to coordinates, via the Worker's cached /api/geocode proxy.
 *
 * Nominatim asks for a real user agent and a low request rate, both of which a
 * browser cannot promise. Proxying it through the Worker gives us the right
 * headers, a 24 hour edge cache, and one upstream request per unique place
 * rather than one per visitor.
 */
import type { LatLng } from "../data";

export type Place = { label: string; at: LatLng };

export async function geocode(query: string, timeoutMs = 12000): Promise<Place | null> {
  const q = query.trim();
  if (!q) return null;
  try {
    const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      results?: { lat: string; lon: string; display_name: string }[];
    };
    const hit = body.results?.[0];
    if (!hit) return null;
    // Display names run to six clauses. Two is enough to recognise a place.
    return {
      label: hit.display_name.split(",").slice(0, 2).join(",").trim(),
      at: { lat: Number(hit.lat), lng: Number(hit.lon) },
    };
  } catch {
    return null;
  }
}

/** Ask the browser where we are. Silently resolves null when refused. */
export async function locateMe(timeoutMs = 8000): Promise<LatLng | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return null;
  return new Promise((resolve) => {
    const done = (v: LatLng | null) => resolve(v);
    const timer = setTimeout(() => done(null), timeoutMs);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        done({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => {
        clearTimeout(timer);
        done(null);
      },
      { timeout: timeoutMs, maximumAge: 300000 },
    );
  });
}

/** Coordinates back to a place name, so "use my location" can be labelled. */
export async function reverseGeocode(at: LatLng): Promise<Place | null> {
  return geocode(`${at.lat.toFixed(5)},${at.lng.toFixed(5)}`);
}
