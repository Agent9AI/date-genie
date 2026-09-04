/**
 * OpenStreetMap adapter, via the Worker's cached /api/osm proxy.
 *
 * The filters the human gave us are compiled INTO the Overpass query rather
 * than applied after the fact. Asking for vegan food issues a query for
 * `diet:vegan`, not a query for every restaurant in town followed by a filter.
 * That is what makes this a search rather than a download.
 *
 * Real from OSM: names, coordinates, cuisine, diet tags, brand (so chains can
 * be spotted), fee and covered status for parking.
 * Simulated: price, rating, table slots, showtimes, seats. Labelled everywhere.
 */
import {
  milesBetween,
  type EventItem,
  type LatLng,
  type ParkingSpot,
  type Restaurant,
} from "../data";
import type { EventQuery, ParkingQuery, RestaurantQuery, SearchArea, SourceAdapter } from "./types";

/* ------------------------------------------------------ query building ---- */

function bbox(at: LatLng, km: number): string {
  const dLat = km / 111;
  const dLng = km / (111 * Math.max(0.2, Math.cos((at.lat * Math.PI) / 180)));
  return [at.lat - dLat, at.lng - dLng, at.lat + dLat, at.lng + dLng]
    .map((n) => n.toFixed(4))
    .join(",");
}

/** Escape a user-supplied term before it lands inside an Overpass regex. */
const rx = (s: string) => s.replace(/[.*+?^${}()|[\]\\"]/g, "");

// Overpass answers a bbox query in three to five seconds or it is failing.
// Waiting sixteen just delays the fallback that was always going to be needed.
async function overpass(query: string, timeoutMs = 9000): Promise<OsmElement[]> {
  try {
    const res = await fetch(`/api/osm?v=2&q=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { elements?: OsmElement[] };
    return body.elements ?? [];
  } catch {
    return [];
  }
}

type OsmElement = {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

const coordsOf = (e: OsmElement): LatLng | null => {
  const lat = e.lat ?? e.center?.lat;
  const lng = e.lon ?? e.center?.lon;
  return typeof lat === "number" && typeof lng === "number" ? { lat, lng } : null;
};

/* --------------------------------------------- deterministic synthesis ---- */

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
const noise = (id: string, channel: string) => (hash(`${id}:${channel}`) % 10000) / 10000;
const pick = <T>(id: string, channel: string, xs: readonly T[]): T =>
  xs[Math.floor(noise(id, channel) * xs.length)]!;

const PRICE_BANDS: Record<string, [number, number]> = {
  steak_house: [70, 95],
  steak: [70, 95],
  sushi: [48, 75],
  japanese: [30, 60],
  french: [50, 78],
  italian: [34, 58],
  seafood: [48, 76],
  american: [28, 52],
  burger: [16, 26],
  pizza: [18, 30],
  mexican: [22, 38],
  salvadoran: [15, 24],
  peruvian: [28, 46],
  thai: [22, 36],
  vietnamese: [16, 28],
  chinese: [20, 36],
  korean: [32, 52],
  indian: [24, 40],
  mediterranean: [30, 50],
  greek: [28, 46],
  middle_eastern: [22, 38],
  lebanese: [26, 42],
  ethiopian: [22, 36],
  spanish: [36, 58],
  tapas: [36, 58],
  ramen: [18, 28],
  noodle: [16, 26],
  sandwich: [12, 20],
  cafe: [14, 24],
  barbecue: [28, 46],
  balkan: [30, 48],
  german: [28, 44],
  turkish: [22, 38],
  caribbean: [24, 40],
};

const SLOT_GRIDS = [
  ["18:00", "18:45", "19:30", "20:15", "21:00"],
  ["18:30", "19:00", "19:45", "20:30"],
  ["18:45", "19:15", "19:30", "20:00", "20:45"],
  ["19:00", "19:30", "20:15", "21:00"],
  ["18:30", "19:15", "20:00", "20:30", "21:15"],
] as const;

const GLYPHS: Record<string, string> = {
  sushi: "🍣",
  japanese: "🍜",
  ramen: "🍜",
  noodle: "🍜",
  korean: "🔥",
  barbecue: "🔥",
  seafood: "🦪",
  steak: "🥩",
  steak_house: "🥩",
  french: "🥖",
  italian: "🍝",
  pizza: "🍕",
  mexican: "🌵",
  salvadoran: "🫓",
  peruvian: "🌶️",
  thai: "🍲",
  vietnamese: "🍜",
  chinese: "🥟",
  indian: "🍛",
  mediterranean: "🫒",
  greek: "🫒",
  middle_eastern: "🧆",
  lebanese: "🧆",
  ethiopian: "🫓",
  spanish: "🥘",
  tapas: "🥘",
  american: "🍽️",
  burger: "🍔",
  sandwich: "🥪",
  cafe: "☕",
  vegan: "🌿",
  vegetarian: "🌿",
  balkan: "🍖",
  turkish: "🥙",
  german: "🥨",
  caribbean: "🍹",
};

const VIBES = [
  "Small room, worth the wait",
  "Counter seating, quick and good",
  "Low light, long menu",
  "Neighbourhood regulars, no fuss",
  "Busy, bright, always full",
  "Quiet enough to hear each other",
] as const;

/** Describe position relative to the search centre. Works in any city. */
function areaLabel(at: LatLng, origin: LatLng): string {
  const miles = milesBetween(origin, at);
  if (miles < 0.4) return "town centre";
  const bearing = (Math.atan2(at.lng - origin.lng, at.lat - origin.lat) * 180) / Math.PI;
  const compass = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][
    Math.round(((bearing + 360) % 360) / 45) % 8
  ]!;
  return `${miles.toFixed(1)} mi ${compass}`;
}

/* ------------------------------------------------------- restaurants ---- */

function toRestaurant(e: OsmElement, origin: LatLng): Restaurant | null {
  const at = coordsOf(e);
  const tags = e.tags ?? {};
  const name = tags["name"];
  if (!at || !name) return null;

  const id = `osm_${e.type}_${e.id}`;
  const cuisineKey = (tags["cuisine"] ?? "").split(";")[0]!.trim().toLowerCase() || "american";
  const band = PRICE_BANDS[cuisineKey] ?? [24, 46];
  const isChain = Boolean(tags["brand"] ?? tags["brand:wikidata"] ?? tags["operator:wikidata"]);

  const vegan =
    tags["diet:vegan"] === "yes" || tags["diet:vegan"] === "only" || cuisineKey === "vegan";
  const vegetarian =
    vegan || tags["diet:vegetarian"] === "yes" || tags["diet:vegetarian"] === "only";
  const tagList = [
    cuisineKey,
    ...(tags["cuisine"] ?? "").split(";").map((c) => c.trim().toLowerCase()),
  ].filter(Boolean);
  if (vegan) tagList.push("vegan", "vegan-friendly", "vegetarian-friendly");
  if (vegetarian) tagList.push("vegetarian-friendly");
  if (tags["diet:gluten_free"] === "yes") tagList.push("gluten-free-friendly");
  if (isChain) tagList.push("chain");

  const pricePerPerson = Math.round(band[0] + noise(id, "price") * (band[1] - band[0]));
  if (pricePerPerson <= 24) tagList.push("value", "cheap-eats");
  if (pricePerPerson >= 60) tagList.push("special-occasion");

  return {
    id,
    name,
    cuisine: cuisineKey.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    neighborhood: areaLabel(at, origin),
    at,
    pricePerPerson,
    rating: Math.round((3.8 + noise(id, "rating") * 1.1 - (isChain ? 0.5 : 0)) * 10) / 10,
    slots: [...pick(id, "slots", SLOT_GRIDS)],
    vibe: pick(id, "vibe", VIBES),
    noise: pick(id, "noise", ["quiet", "moderate", "moderate", "loud"] as const),
    tags: [...new Set(tagList)],
    glyph: GLYPHS[cuisineKey] ?? "🍽️",
  };
}

async function searchRestaurants(q: RestaurantQuery): Promise<Restaurant[]> {
  const bb = bbox(q.at, q.radiusKm);
  const filters: string[] = ['["amenity"="restaurant"]', '["name"]'];
  if (q.cuisine) filters.push(`["cuisine"~"${rx(q.cuisine)}",i]`);
  // Dietary needs go into the query. Asking OSM for vegan places is a different
  // search from asking for every place and discarding most of the answer.
  for (const d of q.dietary ?? []) {
    const key = d.toLowerCase().replace(/\s+/g, "_").replace("gluten-free", "gluten_free");
    filters.push(`["diet:${key}"~"yes|only"]`);
  }
  const query = `[out:json][timeout:12];\nnwr${filters.join("")}(${bb});\nout center 200;`;
  const elements = await overpass(query);
  const out: Restaurant[] = [];
  for (const e of elements) {
    const r = toRestaurant(e, q.at);
    if (!r) continue;
    if (q.maxPricePerPerson && r.pricePerPerson > q.maxPricePerPerson) continue;
    if (
      q.avoid?.some((a) =>
        `${r.cuisine} ${r.tags.join(" ")} ${r.name}`.toLowerCase().includes(a.toLowerCase()),
      )
    )
      continue;
    out.push(r);
  }
  return out.sort((a, b) => milesBetween(q.at, a.at) - milesBetween(q.at, b.at)).slice(0, 120);
}

/* ------------------------------------------------------------ events ---- */

const EVENT_KINDS = {
  cinema: {
    category: "film",
    glyph: "🎞️",
    price: [12, 22],
    starts: ["19:00", "19:45", "20:30", "21:15"],
    mins: 110,
    what: ["Late screening", "Director's cut, one night only", "35mm print", "Second feature"],
  },
  theatre: {
    category: "theater",
    glyph: "🎭",
    price: [22, 48],
    starts: ["19:30", "20:00", "20:30"],
    mins: 135,
    what: ["Evening performance", "Preview night", "Closing weekend", "Late show"],
  },
  nightclub: {
    category: "music",
    glyph: "🎷",
    price: [10, 34],
    starts: ["20:30", "21:00", "21:30", "22:00"],
    mins: 150,
    what: ["Live set", "All-vinyl night", "Local bands, three sets", "DJ, no laptops"],
  },
  arts_centre: {
    category: "class",
    glyph: "🏺",
    price: [0, 40],
    starts: ["18:30", "19:00", "19:30", "20:00"],
    mins: 120,
    what: ["Late studio session", "Drop-in workshop", "Open studio", "Making night"],
  },
} as const;

const CATEGORY_TO_AMENITY: Record<string, (keyof typeof EVENT_KINDS)[]> = {
  film: ["cinema"],
  theater: ["theatre"],
  music: ["nightclub"],
  class: ["arts_centre"],
  comedy: ["theatre", "nightclub"],
};

function toEvent(e: OsmElement, origin: LatLng): EventItem | null {
  const at = coordsOf(e);
  const tags = e.tags ?? {};
  const name = tags["name"];
  const kind = EVENT_KINDS[(tags["amenity"] ?? "") as keyof typeof EVENT_KINDS];
  if (!at || !name || !kind) return null;
  const id = `osm_${e.type}_${e.id}`;
  return {
    id,
    name: `${pick(id, "what", kind.what)} at ${name}`,
    category: kind.category,
    venue: name,
    neighborhood: areaLabel(at, origin),
    at,
    start: pick(id, "start", kind.starts),
    durationMinutes: kind.mins,
    pricePerTicket: Math.round(kind.price[0] + noise(id, "tix") * (kind.price[1] - kind.price[0])),
    seatsLeft: Math.round(6 + noise(id, "seats") * 90),
    blurb: `Real ${tags["amenity"]!.replace("_", " ")} from OpenStreetMap. Showtime is simulated.`,
    glyph: kind.glyph,
  };
}

async function searchEvents(q: EventQuery): Promise<EventItem[]> {
  const bb = bbox(q.at, q.radiusKm);
  const amenities = q.category
    ? (CATEGORY_TO_AMENITY[q.category] ??
      (Object.keys(EVENT_KINDS) as (keyof typeof EVENT_KINDS)[]))
    : (Object.keys(EVENT_KINDS) as (keyof typeof EVENT_KINDS)[]);
  const query = `[out:json][timeout:12];\n(\n${amenities
    .map((a) => `  nwr["amenity"="${a}"]["name"](${bb});`)
    .join("\n")}\n);\nout center 120;`;
  const elements = await overpass(query);
  const out: EventItem[] = [];
  for (const e of elements) {
    const ev = toEvent(e, q.at);
    if (!ev) continue;
    if (q.maxPricePerTicket !== undefined && ev.pricePerTicket > q.maxPricePerTicket) continue;
    out.push(ev);
  }
  return out.sort((a, b) => milesBetween(q.at, a.at) - milesBetween(q.at, b.at)).slice(0, 60);
}

/* ----------------------------------------------------------- parking ---- */

async function searchParking(q: ParkingQuery): Promise<ParkingSpot[]> {
  const bb = bbox(q.at, q.radiusKm);
  // Not requiring a name here: plenty of real garages are untagged, and a
  // nameless lot you can actually park in beats a named one two miles away.
  const query = `[out:json][timeout:12];\nnwr["amenity"="parking"]["access"!="private"](${bb});\nout center 150;`;
  const elements = await overpass(query);
  const out: ParkingSpot[] = [];
  for (const e of elements) {
    const at = coordsOf(e);
    const tags = e.tags ?? {};
    if (!at) continue;
    const id = `osm_${e.type}_${e.id}`;
    const name =
      tags["name"] ??
      (tags["parking"] === "street_side" || tags["parking"] === "lane"
        ? "Street parking"
        : "Public parking");
    // Staff-only lots are not somewhere you can leave a car on a date.
    if (/employee|staff|resident|permit/i.test(name)) continue;
    out.push({
      id,
      name,
      at,
      priceForEvening: tags["fee"] === "no" ? 0 : Math.round(6 + noise(id, "park") * 14),
      spacesLeft: Number(tags["capacity"] ?? 0) || Math.round(8 + noise(id, "spaces") * 180),
      covered:
        tags["parking"] === "underground" ||
        tags["parking"] === "multi-storey" ||
        tags["covered"] === "yes",
    });
  }
  return out.slice(0, 80);
}

export const osmAdapter: SourceAdapter = {
  id: "osm",
  label: "OpenStreetMap",
  kind: "api-adapter",
  attribution: "© OpenStreetMap contributors, via Overpass",
  provides: ["restaurants", "events", "parking"],
  available: true,
  searchRestaurants,
  searchEvents,
  searchParking,
};

export const osmSearchArea = (at: LatLng, radiusKm: number): SearchArea => ({ at, radiusKm });
