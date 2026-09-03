/**
 * Live venue inventory from OpenStreetMap.
 *
 * The honest position, stated plainly because it matters:
 *
 *   REAL, fetched live from OSM for whatever place the user names:
 *     restaurant, cinema, theatre, music venue, arts centre and parking names,
 *     their coordinates, cuisine tags, vegan and vegetarian diet tags, whether
 *     a lot charges a fee and whether it is covered. The place itself is
 *     geocoded with Nominatim, so this works in any town, not one hardcoded
 *     city. Every walk and drive time is computed from those real coordinates.
 *
 *   SIMULATED, because no free open dataset carries it:
 *     prices, ratings, table availability, showtimes, seats remaining, and the
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
import { milesBetween, type EventItem, type LatLng, type ParkingSpot, type Restaurant } from "./data";

/**
 * Overpass mirrors, tried in order. The public instances rate-limit and shed
 * load, so a single host is not something a demo can lean on.
 */
const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const CACHE_KEY = "date-genie.osm.v2";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const NOMINATIM = "https://nominatim.openstreetmap.org/search";

/** Half-width of the search box around wherever the user says they are. */
const SEARCH_RADIUS_KM = 5;

/** Real venues that host a night out, by OSM amenity tag. */
const EVENT_AMENITIES = ["cinema", "theatre", "nightclub", "arts_centre"];

/**
 * A bounding box, not an `around:` radius. Overpass resolves bbox filters from
 * its spatial index while `around:` walks candidates, and on the loaded public
 * instances that difference is the difference between 5 seconds and a 504.
 */
function bboxAround(at: LatLng, km = SEARCH_RADIUS_KM): string {
  const dLat = km / 111;
  const dLng = km / (111 * Math.max(0.2, Math.cos((at.lat * Math.PI) / 180)));
  return [at.lat - dLat, at.lng - dLng, at.lat + dLat, at.lng + dLng].map((n) => n.toFixed(4)).join(",");
}

const queryAround = (at: LatLng, km: number) => {
  const bb = bboxAround(at, km);
  const kinds = ["restaurant", "parking", ...EVENT_AMENITIES];
  return `[out:json][timeout:25];
(
${kinds.map((k) => `  nwr["amenity"="${k}"]["name"](${bb});`).join("\n")}
);
out center 300;`;
};

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
  events: EventItem[];
  source: "openstreetmap" | "seed";
  fetchedAt: number;
  place: string;
  at: LatLng;
};

export type Place = { label: string; at: LatLng };

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

/**
 * OSM rarely tags a usable neighbourhood on the venue itself, so describe
 * position relative to where the user said they are. Works in any city.
 */
function areaLabel(at: LatLng, origin: LatLng, originLabel: string): string {
  const miles = milesBetween(origin, at);
  if (miles < 0.4) return originLabel;
  const bearing = (Math.atan2(at.lng - origin.lng, at.lat - origin.lat) * 180) / Math.PI;
  const compass = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(((bearing + 360) % 360) / 45) % 8]!;
  return `${miles.toFixed(1)} mi ${compass} of ${originLabel}`;
}

const coordsOf = (e: OsmElement): LatLng | null => {
  const lat = e.lat ?? e.center?.lat;
  const lng = e.lon ?? e.center?.lon;
  return typeof lat === "number" && typeof lng === "number" ? { lat, lng } : null;
};

function toRestaurant(e: OsmElement, origin: LatLng, originLabel: string): Restaurant | null {
  const at = coordsOf(e);
  const tags = e.tags ?? {};
  const name = tags["name"];
  if (!at || !name) return null;

  const id = `osm_${e.type}_${e.id}`;
  const area = areaLabel(at, origin, originLabel);
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
  // OSM tags chains with `brand`. Pizza Hut is a fine dinner and a bad date,
  // so mark them and let the planner weigh that.
  const isChain = Boolean(tags["brand"] ?? tags["brand:wikidata"] ?? tags["operator:wikidata"]);
  if (isChain) tagList.push("chain");

  return {
    id,
    name,
    cuisine: label,
    neighborhood: area,
    at,
    pricePerPerson,
    rating: Math.round((3.8 + noise(id, "rating") * 1.1 - (isChain ? 0.5 : 0)) * 10) / 10,
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

/* ---------------------------------------------------- event normalising ---- */

const EVENT_KINDS: Record<string, { category: EventItem["category"]; glyph: string; price: [number, number]; starts: string[]; mins: number; what: string[] }> = {
  cinema: { category: "film", glyph: "🎞️", price: [12, 22], starts: ["19:00", "19:45", "20:30", "21:15"], mins: 110,
    what: ["Late screening", "Director's cut, one night only", "35mm print", "Double feature, second film"] },
  theatre: { category: "theater", glyph: "🎭", price: [22, 48], starts: ["19:30", "20:00", "20:30"], mins: 135,
    what: ["Evening performance", "Preview night", "Closing weekend", "Late show"] },
  nightclub: { category: "music", glyph: "🎷", price: [10, 34], starts: ["20:30", "21:00", "21:30", "22:00"], mins: 150,
    what: ["Live set", "All-vinyl night", "Local bands, three sets", "DJ, no laptops"] },
  arts_centre: { category: "class", glyph: "🏺", price: [0, 40], starts: ["18:30", "19:00", "19:30", "20:00"], mins: 120,
    what: ["Late studio session", "Drop-in workshop", "Open studio", "Making night"] },
};

function toEvent(e: OsmElement, origin: LatLng, originLabel: string): EventItem | null {
  const at = coordsOf(e);
  const tags = e.tags ?? {};
  const name = tags["name"];
  const kind = EVENT_KINDS[tags["amenity"] ?? ""];
  if (!at || !name || !kind) return null;
  const id = `osm_${e.type}_${e.id}`;
  const price = Math.round(kind.price[0] + noise(id, "tix") * (kind.price[1] - kind.price[0]));
  return {
    id,
    name: `${pick(id, "what", kind.what)} at ${name}`,
    category: kind.category,
    venue: name,
    neighborhood: areaLabel(at, origin, originLabel),
    at,
    start: pick(id, "start", kind.starts),
    durationMinutes: kind.mins,
    pricePerTicket: price,
    seatsLeft: Math.round(6 + noise(id, "seats") * 90),
    blurb: `${tags["amenity"]!.replace("_", " ")}, real venue from OpenStreetMap. Showtime is simulated.`,
    glyph: kind.glyph,
  };
}

/* ---------------------------------------------------------- geocoding ---- */

/**
 * Turn "Fredericksburg VA" into coordinates using OSM's Nominatim geocoder.
 * Free, keyless, and it works anywhere in the world, which is the point:
 * nothing in this app is pinned to one city.
 */
export async function geocode(query: string, timeoutMs = 12000): Promise<Place | null> {
  const q = query.trim();
  if (!q) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${NOMINATIM}?format=json&limit=1&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const rows = (await res.json()) as { lat: string; lon: string; display_name: string }[];
    const hit = rows[0];
    if (!hit) return null;
    // Nominatim display names are long. Keep the first two parts: "Fredericksburg, Virginia".
    const label = hit.display_name.split(",").slice(0, 2).join(",").trim();
    return { label, at: { lat: Number(hit.lat), lng: Number(hit.lon) } };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}


/* ------------------------------------------------------------- fetching ---- */

const cacheKeyFor = (at: LatLng) => `${CACHE_KEY}:${at.lat.toFixed(3)},${at.lng.toFixed(3)}`;

function readCache(at: LatLng): Inventory | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(cacheKeyFor(at));
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
    localStorage.setItem(cacheKeyFor(inv.at), JSON.stringify(inv));
  } catch {
    /* over quota: the network path still works, it is just slower next time */
  }
}

/**
 * Returns live inventory around a place, or null if OSM could not be reached
 * in time or the area is too thin to plan an evening in.
 * Never throws: a date-night planner should degrade, not explode.
 */
export async function fetchLiveVenues(place: Place, timeoutMs = 20000): Promise<Inventory | null> {
  const cached = readCache(place.at);
  if (cached) return cached;

  // A dense downtown is covered in 5km. A small town is not, so widen once
  // rather than telling someone there is nothing to do in their city.
  let elements = await queryMirrors(queryAround(place.at, SEARCH_RADIUS_KM), timeoutMs);
  const eventCount = (els: OsmElement[]) =>
    els.filter((e) => EVENT_AMENITIES.includes(e.tags?.["amenity"] ?? "")).length;
  if (!elements || eventCount(elements) < 4) {
    const wider = await queryMirrors(queryAround(place.at, SEARCH_RADIUS_KM * 2.5), timeoutMs);
    if (wider && (!elements || eventCount(wider) > eventCount(elements))) elements = wider;
  }
  if (!elements) return null;
  try {

    const restaurants: Restaurant[] = [];
    const parking: ParkingSpot[] = [];
    const events: EventItem[] = [];
    for (const e of elements) {
      const amenity = e.tags?.["amenity"];
      if (amenity === "restaurant") {
        const r = toRestaurant(e, place.at, place.label);
        if (r) restaurants.push(r);
      } else if (amenity === "parking") {
        const p = toParking(e);
        if (p) parking.push(p);
      } else if (amenity) {
        const ev = toEvent(e, place.at, place.label);
        if (ev) events.push(ev);
      }
    }

    // Too thin to plan a whole evening against: fall back rather than ship a
    // broken itinerary. A town with no venues is a real answer, not a bug.
    if (restaurants.length < 4 || events.length < 1) return null;

    // Closest first keeps the planner's inner loop over the plausible venues.
    const byDistance = (a: { at: LatLng }, b: { at: LatLng }) =>
      milesBetween(place.at, a.at) - milesBetween(place.at, b.at);
    restaurants.sort(byDistance);
    events.sort(byDistance);
    parking.sort(byDistance);

    const inv: Inventory = {
      restaurants: restaurants.slice(0, 120),
      parking: parking.slice(0, 60),
      events: events.slice(0, 40),
      source: "openstreetmap",
      fetchedAt: Date.now(),
      place: place.label,
      at: place.at,
    };
    writeCache(inv);
    return inv;
  } catch {
    return null;
  }
}

/**
 * Try each mirror in turn. A 504 from an overloaded instance is normal, not
 * exceptional, so this is a retry loop rather than an error path.
 */
async function queryMirrors(body: string, timeoutMs: number): Promise<OsmElement[] | null> {
  for (const host of OVERPASS_MIRRORS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(host, {
        method: "POST",
        body: new URLSearchParams({ data: body }),
        signal: controller.signal,
      });
      if (!res.ok) continue;
      const json = (await res.json()) as { elements?: OsmElement[] };
      const elements = json.elements ?? [];
      if (elements.length) return elements;
    } catch {
      /* next mirror */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}
