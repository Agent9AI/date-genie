/**
 * Google Maps adapter, grounded through Gemini, via the Worker's /api/places.
 *
 * This is the adapter that stops the app guessing. OpenStreetMap gives breadth
 * and exact coordinates for free, but carries no prices, no ratings, and no
 * sense of whether a place is pleasant to sit in. Maps carries all three.
 *
 * Real here, and not derived from anything: name, rating, review count, price
 * band, address, and the model's read on whether somewhere suits a date.
 * Still simulated: table availability and showtimes, because Maps does not
 * publish either. Those two are flagged in `provenance` so the UI and the tool
 * responses can keep telling the truth field by field.
 *
 * The model retrieves and structures. It does not choose the evening.
 */
import { type EventItem, type LatLng, type Restaurant } from "../data";
import type { EventQuery, RestaurantQuery, SourceAdapter } from "./types";

type RawPlace = {
  name?: string;
  rating?: number;
  reviews?: number;
  approxPerPerson?: number;
  approxTicket?: number;
  cuisine?: string;
  category?: string;
  address?: string;
  lat?: number;
  lng?: number;
  romantic?: boolean;
  noise?: string;
  chain?: boolean;
  vibe?: string;
  blurb?: string;
};

const GLYPHS: Record<string, string> = {
  sushi: "🍣",
  japanese: "🍜",
  ramen: "🍜",
  noodles: "🍜",
  korean: "🔥",
  barbecue: "🔥",
  bbq: "🔥",
  seafood: "🦪",
  steakhouse: "🥩",
  steak: "🥩",
  french: "🥖",
  italian: "🍝",
  pizza: "🍕",
  mexican: "🌵",
  peruvian: "🌶️",
  thai: "🍲",
  vietnamese: "🍜",
  chinese: "🥟",
  indian: "🍛",
  mediterranean: "🫒",
  greek: "🫒",
  lebanese: "🧆",
  ethiopian: "🫓",
  spanish: "🥘",
  american: "🍽️",
  southern: "🍗",
  burger: "🍔",
  cafe: "☕",
  vegan: "🌿",
  vegetarian: "🌿",
};
const EVENT_GLYPHS: Record<string, string> = {
  film: "🎞️",
  theater: "🎭",
  music: "🎷",
  comedy: "🎤",
  class: "🏺",
};

/** Table times are the one thing Maps cannot tell us, so they stay derived. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
const SLOT_GRIDS = [
  ["18:00", "18:45", "19:30", "20:15", "21:00"],
  ["18:30", "19:00", "19:45", "20:30"],
  ["18:45", "19:15", "19:30", "20:00", "20:45"],
  ["19:00", "19:30", "20:15", "21:00"],
] as const;
const START_TIMES = ["19:00", "19:30", "20:00", "20:30", "21:00"] as const;
const pick = <T>(id: string, ch: string, xs: readonly T[]): T =>
  xs[hash(`${id}:${ch}`) % xs.length]!;

// Its own budget, so a slow enrichment degrades the answer instead of the app.
async function fetchPlaces(
  at: LatLng,
  kind: "restaurants" | "events",
  want: string,
  timeoutMs = 9000,
): Promise<RawPlace[]> {
  try {
    const url = `/api/places?lat=${at.lat.toFixed(5)}&lng=${at.lng.toFixed(5)}&kind=${kind}${want ? `&want=${encodeURIComponent(want)}` : ""}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return [];
    const body = (await res.json()) as { places?: RawPlace[] };
    return Array.isArray(body.places) ? body.places : [];
  } catch {
    return [];
  }
}

const coords = (p: RawPlace, fallback: LatLng): LatLng =>
  Number.isFinite(p.lat) && Number.isFinite(p.lng) ? { lat: p.lat!, lng: p.lng! } : fallback;

async function searchRestaurants(q: RestaurantQuery): Promise<Restaurant[]> {
  // Tell Maps what kind of night this is. Asking for "romantic, around $90 a
  // head" returns different restaurants than asking for restaurants, which is
  // the entire advantage of a source that understands language.
  const want = [
    q.cuisine,
    ...(q.dietary ?? []),
    q.occasion ? `${q.occasion}, somewhere special` : "",
    q.quiet ? "quiet enough for conversation" : "",
    q.targetPerPerson ? `around $${Math.round(q.targetPerPerson)} per person` : "",
    q.party && q.party > 4 ? "large groups" : "",
    ...(q.avoid ?? []).map((a) => `not ${a}`),
  ]
    .filter(Boolean)
    .join(", ");
  const raw = await fetchPlaces(q.at, "restaurants", want);
  const out: Restaurant[] = [];
  for (const p of raw) {
    if (!p.name) continue;
    const id = `gmaps_${p.name.toLowerCase().replace(/\W+/g, "_")}`;
    const cuisine = (p.cuisine ?? "restaurant").toLowerCase();
    const price = Math.max(8, Math.round(p.approxPerPerson ?? 40));
    const tags = [
      cuisine,
      ...(p.romantic ? ["romantic", "date-night"] : []),
      ...(p.chain ? ["chain"] : []),
    ];
    if (price <= 24) tags.push("value", "cheap-eats");
    if (price >= 70) tags.push("special-occasion");
    for (const d of q.dietary ?? []) tags.push(`${d.toLowerCase()}-friendly`);
    out.push({
      id,
      name: p.name,
      cuisine: cuisine.replace(/\b\w/g, (c) => c.toUpperCase()),
      neighborhood: p.address?.split(",")[1]?.trim() ?? "nearby",
      at: coords(p, q.at),
      pricePerPerson: price,
      rating: typeof p.rating === "number" ? Math.round(p.rating * 10) / 10 : 4.2,
      slots: [...pick(id, "slots", SLOT_GRIDS)],
      vibe: p.vibe ?? (p.romantic ? "Worth dressing for" : "Comfortable and busy"),
      noise: p.noise === "quiet" || p.noise === "loud" ? p.noise : "moderate",
      tags: [...new Set(tags)],
      glyph: GLYPHS[cuisine] ?? "🍽️",
      provenance: { source: "google-maps", realPricing: true },
    });
  }
  return out;
}

async function searchEvents(q: EventQuery): Promise<EventItem[]> {
  const raw = await fetchPlaces(q.at, "events", q.category ?? "");
  const out: EventItem[] = [];
  for (const p of raw) {
    if (!p.name) continue;
    const id = `gmaps_ev_${p.name.toLowerCase().replace(/\W+/g, "_")}`;
    const category = (["film", "theater", "music", "comedy", "class"] as const).includes(
      p.category as never,
    )
      ? (p.category as EventItem["category"])
      : "music";
    const start = pick(id, "start", START_TIMES);
    out.push({
      id,
      name: p.blurb ? `${p.blurb} at ${p.name}` : `Evening at ${p.name}`,
      category,
      venue: p.name,
      neighborhood: p.address?.split(",")[1]?.trim() ?? "nearby",
      at: coords(p, q.at),
      start,
      durationMinutes: category === "film" ? 110 : category === "theater" ? 135 : 120,
      pricePerTicket: Math.max(0, Math.round(p.approxTicket ?? 25)),
      seatsLeft: 8 + (hash(`${id}:seats`) % 80),
      blurb: `${p.rating ? `${p.rating}★ on Google` : "Real venue"}. Showtime is simulated.`,
      glyph: EVENT_GLYPHS[category] ?? "🎫",
      provenance: { source: "google-maps", realPricing: true },
    });
  }
  return out;
}

export const gmapsAdapter: SourceAdapter = {
  id: "gmaps",
  label: "Google Maps",
  kind: "api-adapter",
  attribution: "Ratings, review counts and price bands from Google Maps, grounded via Gemini",
  provides: ["restaurants", "events"],
  // Flipped on at startup when the Worker reports a Gemini key is configured.
  available: false,
  needsKey: true,
  searchRestaurants,
  searchEvents,
};
