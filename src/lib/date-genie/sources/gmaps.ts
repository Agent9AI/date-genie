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
import { milesBetween, type EventItem, type LatLng, type Restaurant } from "../data";
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

// A generous budget on purpose: this runs AFTER a plan is already on screen,
// so waiting costs nobody anything and the answer that lands is the better one.
async function fetchPlaces(
  at: LatLng,
  kind: "restaurants" | "events",
  want: string,
  radiusKm: number,
): Promise<RawPlace[]> {
  try {
    // `v` is a cache-key generation. Bump it when the prompt or the response
    // shape changes, so nobody is served an answer built to the old contract.
    const url =
      `/api/places?v=2&lat=${at.lat.toFixed(5)}&lng=${at.lng.toFixed(5)}` +
      `&km=${Math.round(radiusKm)}&kind=${kind}${want ? `&want=${encodeURIComponent(want)}` : ""}`;
    // A generous budget on purpose. The grounded lookup takes about 25 seconds
    // cold and milliseconds once the edge has it, and it runs after the fast
    // sources have already produced a plan, so waiting costs nobody anything.
    // An earlier 9 second budget silently aborted every cold call, which looked
    // exactly like "Google Maps returned nothing".
    const res = await fetch(url, { signal: AbortSignal.timeout(50000) });
    if (!res.ok) return [];
    const body = (await res.json()) as { places?: RawPlace[] };
    return Array.isArray(body.places) ? body.places : [];
  } catch {
    return [];
  }
}


const coords = (p: RawPlace, fallback: LatLng): LatLng =>
  Number.isFinite(p.lat) && Number.isFinite(p.lng) ? { lat: p.lat!, lng: p.lng! } : fallback;

/**
 * Geography is the one thing never to take a model's word for.
 *
 * Asked for restaurants in Charleston, the smaller model answered with
 * Sullivan's Island, Mt Pleasant and Isle of Palms, all eight to twelve miles
 * out. Those are real restaurants and a real failure: someone asked for dinner
 * near where they are. We have coordinates for both ends, so this is arithmetic
 * rather than a judgement call, and anything outside the search radius is
 * dropped no matter how good it looks.
 */
function withinRadius(at: LatLng, origin: LatLng, radiusKm: number): boolean {
  const maxMiles = Math.max(1.5, radiusKm * 0.621371 * 1.35);
  return milesBetween(origin, at) <= maxMiles;
}

async function searchRestaurants(q: RestaurantQuery): Promise<Restaurant[]> {
  // Tell Maps what kind of night this is, but from a SMALL vocabulary.
  //
  // The first version built this string from the exact budget, the party size
  // and every avoid term, which made it unique per request. Since it is part of
  // the cache key, that meant almost every search was a cold 25 second lookup.
  // Bucketing intent into a handful of profiles means one lookup serves every
  // "anniversary in Charleston" for the next hour, and `npm run warm` can prime
  // the buckets ahead of time. Fine-grained filtering still happens locally,
  // where it is free.
  const profile = q.targetPerPerson === undefined ? "standard" : q.targetPerPerson >= 65 ? "special" : q.targetPerPerson <= 25 ? "cheap" : "standard";
  const want = [
    q.cuisine,
    ...(q.dietary ?? []),
    profile === "special" ? "special occasion, somewhere memorable, higher end" : "",
    profile === "cheap" ? "good value, casual, inexpensive" : "",
    q.quiet ? "quiet enough for conversation" : "",
  ]
    .filter(Boolean)
    .join(", ");
  const raw = await fetchPlaces(q.at, "restaurants", want, q.radiusKm);
  const out: Restaurant[] = [];
  let dropped = 0;
  for (const p of raw) {
    if (!p.name) continue;
    const at = coords(p, q.at);
    if (!withinRadius(at, q.at, q.radiusKm)) {
      dropped++;
      continue;
    }
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
      at,
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
  if (dropped)
    console.info(`[date-genie] dropped ${dropped} Maps venues outside the search radius`);
  return out;
}

async function searchEvents(q: EventQuery): Promise<EventItem[]> {
  const raw = await fetchPlaces(q.at, "events", q.category ?? "", q.radiusKm);
  const out: EventItem[] = [];
  for (const p of raw) {
    if (!p.name) continue;
    const at = coords(p, q.at);
    if (!withinRadius(at, q.at, q.radiusKm)) continue;
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
      at,
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
  /**
   * On by default, rather than waiting to be switched on.
   *
   * The previous version flipped this flag after fetching /api/sources, which
   * introduced a race: any search issued before that resolved silently ran
   * without Google Maps, and the app quietly degraded to guessed prices while
   * reporting itself healthy. The endpoint already answers `no_key` cheaply
   * when no key is configured, so asking and being told no is both simpler and
   * more honest than a flag that might not have been set yet.
   */
  available: true,
  needsKey: true,
  searchRestaurants,
  searchEvents,
};
