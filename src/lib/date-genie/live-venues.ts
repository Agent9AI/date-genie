/**
 * Live venue inventory from OpenStreetMap.
 *
 * The honest position, stated plainly because it matters:
 *
 *   REAL, fetched live from the Overpass API at page load:
 *     restaurant and parking names, coordinates, cuisine tags, vegan and
 *     vegetarian diet tags, whether a lot charges a fee, whether it is covered.
 *     Every walk and drive time in this app is computed from those real
 *     coordinates.
 *
 *   SIMULATED, because no free open dataset carries it:
 *     prices, ratings, table availability, seats remaining, and the
 *     reservations themselves. These are derived deterministically from the
 *     OSM id, so a given restaurant always looks the same on every reload
 *     rather than shuffling between visits.
 *
 * Overpass queues requests under load, so the client budget here is generous.
 * If it is slow, rate-limited, or blocked, this resolves to null and the
 * app falls back to its curated seed inventory. The page says which one it is
 * using, and so does the `get_date_context` tool, so an agent is never misled
 * about how real its data is.
 */
import { HOME, milesBetween, type LatLng, type ParkingSpot, type Restaurant } from "./data";

const OVERPASS = "https://overpass-api.de/api/interpreter";
const CACHE_KEY = "date-genie.osm.v1";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Arlington, VA: Rosslyn and Pentagon City in the east to Ballston in the west. */
const BBOX = "38.855,-77.130,38.905,-77.055";

const QUERY = `[out:json][timeout:20];
(
  node["amenity"="restaurant"]["name"](${BBOX});
  way["amenity"="restaurant"]["name"](${BBOX});
  node["amenity"="parking"]["name"](${BBOX});
  way["amenity"="parking"]["name"](${BBOX});
);
out center 220;`;

type OsmElement = {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

export type Inventory = {
  restaurants: Restaurant[];
  parking: ParkingSpot[];
  source: "openstreetmap" | "seed";
  fetchedAt: number;
};

/* ------------------------------------------------- deterministic noise ---- */

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
/** Stable 0..1 for a given (id, channel). Same venue, same numbers, always. */
const noise = (id: string, channel: string) => (hash(`${id}:${channel}`) % 10000) / 10000;
const pick = <T,>(id: string, channel: string, xs: T[]): T => xs[Math.floor(noise(id, channel) * xs.length)]!;

/* --------------------------------------------------------- normalising ---- */

/** Rough price band per person, keyed off the cuisine OSM actually reports. */
const PRICE_BANDS: Record<string, [number, number]> = {
  steak_house: [70, 95], steak: [70, 95], sushi: [48, 75], japanese: [30, 60], french: [50, 78],
  italian: [34, 58], seafood: [48, 76], american: [28, 52], burger: [16, 26], pizza: [18, 30],
  mexican: [22, 38], salvadoran: [15, 24], peruvian: [28, 46], thai: [22, 36], vietnamese: [16, 28],
  chinese: [20, 36], korean: [32, 52], indian: [24, 40], mediterranean: [30, 50], greek: [28, 46],
  middle_eastern: [22, 38], lebanese: [26, 42], ethiopian: [22, 36], spanish: [36, 58], tapas: [36, 58],
  ramen: [18, 28], noodle: [16, 26], sandwich: [12, 20], cafe: [14, 24], barbecue: [28, 46],
  balkan: [30, 48], german: [28, 44], turkish: [22, 38], caribbean: [24, 40],
};

const SLOT_GRIDS: string[][] = [
  ["18:00", "18:45", "19:30", "20:15", "21:00"],
  ["18:30", "19:00", "19:45", "20:30"],
  ["18:45", "19:15", "19:30", "20:00", "20:45"],
  ["19:00", "19:30", "20:15", "21:00"],
  ["18:30", "19:15", "20:00", "20:30", "21:15"],
];

const GLYPHS: Record<string, string> = {
  sushi: "🍣", japanese: "🍜", ramen: "🍜", noodle: "🍜", korean: "🔥", barbecue: "🔥",
  seafood: "🦪", steak: "🥩", steak_house: "🥩", french: "🥖", italian: "🍝", pizza: "🍕",
  mexican: "🌵", salvadoran: "🫓", peruvian: "🌶️", thai: "🍲", vietnamese: "🍜", chinese: "🥟",
  indian: "🍛", mediterranean: "🫒", greek: "🫒", middle_eastern: "🧆", lebanese: "🧆",
  ethiopian: "🫓", spanish: "🥘", tapas: "🥘", american: "🍽️", burger: "🍔", sandwich: "🥪",
  cafe: "☕", vegan: "🌿", vegetarian: "🌿", balkan: "🍖", turkish: "🥙", german: "🥨", caribbean: "🍹",
};

const VIBES = [
  "Small room, worth the wait",
  "Counter seating, quick and good",
  "Low light, long menu",
  "Neighbourhood regulars, no fuss",
  "Busy, bright, always full",
  "Quiet enough to hear each other",
];

const NEIGHBOURHOODS: { name: string; at: LatLng }[] = [
  { name: "Rosslyn", at: { lat: 38.8963, lng: -77.0721 } },
  { name: "Courthouse", at: { lat: 38.8905, lng: -77.0857 } },
  { name: "Clarendon", at: { lat: 38.8865, lng: -77.0949 } },
  { name: "Virginia Square", at: { lat: 38.8834, lng: -77.1043 } },
  { name: "Ballston", at: { lat: 38.8823, lng: -77.1119 } },
  { name: "Pentagon City", at: { lat: 38.8624, lng: -77.0594 } },
  { name: "Columbia Pike", at: { lat: 38.8635, lng: -77.0999 } },
];

const nearestNeighbourhood = (at: LatLng) =>
  NEIGHBOURHOODS.reduce((best, n) => (milesBetween(at, n.at) < milesBetween(at, best.at) ? n : best)).name;

const coordsOf = (e: OsmElement): LatLng | null => {
  const lat = e.lat ?? e.center?.lat;
  const lng = e.lon ?? e.center?.lon;
  return typeof lat === "number" && typeof lng === "number" ? { lat, lng } : null;
};

function toRestaurant(e: OsmElement): Restaurant | null {
  const at = coordsOf(e);
  const tags = e.tags ?? {};
  const name = tags["name"];
  if (!at || !name) return null;

  const id = `osm_${e.type}_${e.id}`;
  const rawCuisine = (tags["cuisine"] ?? "").split(";")[0]!.trim().toLowerCase();
  const cuisineKey = rawCuisine || "american";
  const band = PRICE_BANDS[cuisineKey] ?? [24, 46];
  const pricePerPerson = Math.round(band[0] + noise(id, "price") * (band[1] - band[0]));

  const label = cuisineKey.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const vegan = tags["diet:vegan"] === "yes" || tags["diet:vegan"] === "only" || cuisineKey === "vegan";
  const vegetarian = vegan || tags["diet:vegetarian"] === "yes" || tags["diet:vegetarian"] === "only" || cuisineKey === "vegetarian";
  const glutenFree = tags["diet:gluten_free"] === "yes";

  const tagList = [cuisineKey, ...(tags["cuisine"] ?? "").split(";").map((c) => c.trim().toLowerCase())].filter(Boolean);
  if (vegan) tagList.push("vegan", "vegan-friendly", "vegetarian-friendly");
  else if (vegetarian) tagList.push("vegetarian-friendly");
  if (glutenFree) tagList.push("gluten-free-friendly");
  if (pricePerPerson <= 24) tagList.push("value", "cheap-eats");
  if (pricePerPerson >= 60) tagList.push("special-occasion");

  return {
    id,
    name,
    cuisine: label,
    neighborhood: nearestNeighbourhood(at),
    at,
    pricePerPerson,
    rating: Math.round((3.8 + noise(id, "rating") * 1.1) * 10) / 10,
    slots: pick(id, "slots", SLOT_GRIDS),
    vibe: pick(id, "vibe", VIBES),
    noise: pick(id, "noise", ["quiet", "moderate", "moderate", "loud"] as const),
    tags: [...new Set(tagList)],
    glyph: GLYPHS[cuisineKey] ?? "🍽️",
  };
}

function toParking(e: OsmElement): ParkingSpot | null {
  const at = coordsOf(e);
  const tags = e.tags ?? {};
  const name = tags["name"];
  if (!at || !name) return null;
  const id = `osm_${e.type}_${e.id}`;
  const free = tags["fee"] === "no";
  const covered = tags["parking"] === "underground" || tags["parking"] === "multi-storey" || tags["covered"] === "yes";
  return {
    id,
    name,
    at,
    priceForEvening: free ? 0 : Math.round(6 + noise(id, "park") * 14),
    spacesLeft: Number(tags["capacity"] ?? 0) || Math.round(8 + noise(id, "spaces") * 180),
    covered,
  };
}

/* ------------------------------------------------------------- fetching ---- */

function readCache(): Inventory | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Inventory;
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null;
    return parsed.restaurants?.length ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(inv: Inventory) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(inv));
  } catch {
    /* over quota: the network path still works, it is just slower next time */
  }
}

/**
 * Returns live inventory, or null if OSM could not be reached in time.
 * Never throws: a date-night planner should degrade, not explode.
 */
export async function fetchLiveVenues(timeoutMs = 20000): Promise<Inventory | null> {
  const cached = readCache();
  if (cached) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(OVERPASS, {
      method: "POST",
      body: new URLSearchParams({ data: QUERY }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { elements?: OsmElement[] };
    const elements = json.elements ?? [];

    const restaurants: Restaurant[] = [];
    const parking: ParkingSpot[] = [];
    for (const e of elements) {
      if (e.tags?.["amenity"] === "restaurant") {
        const r = toRestaurant(e);
        if (r) restaurants.push(r);
      } else if (e.tags?.["amenity"] === "parking") {
        const p = toParking(e);
        if (p) parking.push(p);
      }
    }

    // Too thin to plan against: fall back rather than ship a broken evening.
    if (restaurants.length < 12 || parking.length < 3) return null;

    // Closest first keeps the planner's inner loop over the plausible venues.
    restaurants.sort((a, b) => milesBetween(HOME, a.at) - milesBetween(HOME, b.at));

    const inv: Inventory = {
      restaurants: restaurants.slice(0, 140),
      parking: parking.slice(0, 60),
      source: "openstreetmap",
      fetchedAt: Date.now(),
    };
    writeCache(inv);
    return inv;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
