/**
 * Shapes and geography. No data.
 *
 * There is deliberately no inventory in this file. Every restaurant, venue and
 * parking facility arrives from a source adapter at query time (see
 * ./sources), because a hardcoded city is a demo, not a product. The types
 * below are the contract an adapter fills in.
 *
 * Distances are computed, never enumerated. Give the planner coordinates and
 * it can reason about pairings nobody wrote down.
 */

export type LatLng = { lat: number; lng: number };

/**
 * Where the user is tonight. Mutable on purpose: set_location geocodes a real
 * place name into this object and every drive-time estimate follows it.
 */
export const HOME: LatLng = { lat: 38.8816, lng: -77.1117 };

export function setHome(at: LatLng): void {
  HOME.lat = at.lat;
  HOME.lng = at.lng;
}

export type Restaurant = {
  id: string;
  name: string;
  cuisine: string;
  neighborhood: string;
  at: LatLng;
  pricePerPerson: number;
  rating: number;
  slots: string[];
  vibe: string;
  noise: "quiet" | "moderate" | "loud";
  tags: string[];
  glyph: string;
};

export type EventItem = {
  id: string;
  name: string;
  category: "comedy" | "music" | "film" | "class" | "theater";
  venue: string;
  neighborhood: string;
  at: LatLng;
  start: string;
  durationMinutes: number;
  pricePerTicket: number;
  seatsLeft: number;
  blurb: string;
  glyph: string;
};

export type ParkingSpot = {
  id: string;
  name: string;
  at: LatLng;
  priceForEvening: number;
  spacesLeft: number;
  covered: boolean;
};

/* ---------------------------------------------------------------- geo ---- */

const R_MI = 3958.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in miles. */
export function milesBetween(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_MI * Math.asin(Math.sqrt(h));
}

/** Walking minutes at a realistic 2.9 mph city pace, plus crossings. */
export function walkMinutes(a: LatLng, b: LatLng): number {
  return Math.max(1, Math.round((milesBetween(a, b) / 2.9) * 60 * 1.25));
}

/** Driving minutes from home, with an urban-arterial penalty. */
export function driveMinutes(to: LatLng): number {
  return driveBetween(HOME, to);
}

/** Driving minutes between any two points, including parking and walk-in time. */
export function driveBetween(a: LatLng, b: LatLng): number {
  return Math.max(3, Math.round((milesBetween(a, b) / 24) * 60 + 4));
}
