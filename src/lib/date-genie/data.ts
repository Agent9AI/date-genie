/**
 * Date Genie: the world model.
 *
 * Everything here is a stand-in for what would be real inventory APIs
 * (OpenTable, Ticketmaster, SpotHero). The shapes are deliberately the shapes
 * those APIs return, so the planner and the WebMCP tool surface above it would
 * not change if you swapped this file for live data.
 *
 * Walk times are NOT hardcoded pairs. Every venue carries real Arlington, VA
 * coordinates and walking distance is computed. That means the planner can
 * reason about any dinner/event combination, including ones nobody enumerated.
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

/* -------------------------------------------------------- inventory ---- */

const SEED_RESTAURANTS: Restaurant[] = [
  {
    id: "r_seoul_ember",
    name: "Seoul Ember",
    cuisine: "Korean BBQ",
    neighborhood: "Clarendon",
    at: { lat: 38.8865, lng: -77.0949 },
    pricePerPerson: 46,
    rating: 4.7,
    slots: ["18:45", "19:15", "19:30", "20:00", "20:45"],
    vibe: "Loud, smoky, grill-at-your-table",
    noise: "loud",
    tags: ["korean", "bbq", "meat", "groups", "gluten-free-friendly"],
    glyph: "🔥",
  },
  {
    id: "r_little_boat",
    name: "Little Boat Oyster Room",
    cuisine: "Seafood",
    neighborhood: "Rosslyn",
    at: { lat: 38.8963, lng: -77.0721 },
    pricePerPerson: 62,
    rating: 4.6,
    slots: ["19:00", "19:45", "21:00"],
    vibe: "Candlelit, ten stools, no menu on Mondays",
    noise: "quiet",
    tags: ["seafood", "oysters", "shellfish", "romantic", "date-night"],
    glyph: "🦪",
  },
  {
    id: "r_masa_luz",
    name: "Masa & Luz",
    cuisine: "Mexican",
    neighborhood: "Ballston",
    at: { lat: 38.8823, lng: -77.1119 },
    pricePerPerson: 34,
    rating: 4.5,
    slots: ["19:00", "19:30", "20:15", "21:00"],
    vibe: "Neon patio, 40 mezcals, tortillas pressed to order",
    noise: "moderate",
    tags: ["mexican", "vegetarian-friendly", "cocktails", "patio"],
    glyph: "🌵",
  },
  {
    id: "r_thali_house",
    name: "Thali House",
    cuisine: "Indian",
    neighborhood: "Courthouse",
    at: { lat: 38.8905, lng: -77.0857 },
    pricePerPerson: 29,
    rating: 4.4,
    slots: ["18:30", "19:15", "20:00", "20:30"],
    vibe: "Family run, twelve tables, the naan is the point",
    noise: "quiet",
    tags: ["indian", "vegetarian-friendly", "vegan-friendly", "value"],
    glyph: "🍛",
  },
  {
    id: "r_north_forty",
    name: "North Forty Chophouse",
    cuisine: "Steakhouse",
    neighborhood: "Pentagon City",
    at: { lat: 38.8624, lng: -77.0594 },
    pricePerPerson: 88,
    rating: 4.8,
    slots: ["19:30", "20:30"],
    vibe: "Dark wood, big pours, older crowd",
    noise: "quiet",
    tags: ["steak", "meat", "special-occasion", "jacket"],
    glyph: "🥩",
  },
  {
    id: "r_udon_hour",
    name: "Udon Hour",
    cuisine: "Japanese",
    neighborhood: "Clarendon",
    at: { lat: 38.8871, lng: -77.0932 },
    pricePerPerson: 27,
    rating: 4.3,
    slots: ["18:30", "19:00", "19:45", "20:30", "21:15"],
    vibe: "Counter seating, in and out in forty minutes",
    noise: "moderate",
    tags: ["japanese", "noodles", "fast", "value", "vegetarian-friendly"],
    glyph: "🍜",
  },
  {
    id: "r_fig_ash",
    name: "Fig & Ash",
    cuisine: "Mediterranean",
    neighborhood: "Clarendon",
    at: { lat: 38.8858, lng: -77.0975 },
    pricePerPerson: 52,
    rating: 4.6,
    slots: ["18:30", "19:00", "19:45", "20:15"],
    vibe: "Wood fire, low light, natural wine",
    noise: "moderate",
    tags: ["mediterranean", "vegetarian-friendly", "wine", "romantic", "date-night"],
    glyph: "🫒",
  },
  {
    id: "r_pupuseria_ana",
    name: "Pupusería Ana",
    cuisine: "Salvadoran",
    neighborhood: "Columbia Pike",
    at: { lat: 38.8635, lng: -77.0999 },
    pricePerPerson: 18,
    rating: 4.7,
    slots: ["18:00", "18:45", "19:30", "20:15", "21:00"],
    vibe: "Nine tables, cash-preferred, the real thing",
    noise: "moderate",
    tags: ["salvadoran", "value", "vegetarian-friendly", "cheap-eats"],
    glyph: "🫓",
  },
  {
    id: "r_blue_hour",
    name: "Blue Hour Bistro",
    cuisine: "French",
    neighborhood: "Courthouse",
    at: { lat: 38.8917, lng: -77.0871 },
    pricePerPerson: 58,
    rating: 4.5,
    slots: ["19:00", "19:30", "20:00", "21:15"],
    vibe: "Zinc bar, steak frites, someone's always proposing",
    noise: "quiet",
    tags: ["french", "romantic", "date-night", "wine"],
    glyph: "🥖",
  },
  {
    id: "r_green_line",
    name: "Green Line Kitchen",
    cuisine: "Vegan",
    neighborhood: "Ballston",
    at: { lat: 38.8809, lng: -77.1094 },
    pricePerPerson: 31,
    rating: 4.4,
    slots: ["18:30", "19:15", "19:45", "20:30"],
    vibe: "Bright, plant-forward, unreasonably good mushroom dish",
    noise: "moderate",
    tags: ["vegan", "vegan-friendly", "vegetarian-friendly", "gluten-free-friendly", "healthy"],
    glyph: "🌿",
  },
];

const SEED_EVENTS: EventItem[] = [
  {
    id: "e_dry_humor",
    name: "Dry Humor Live",
    category: "comedy",
    venue: "The Bishop Room",
    neighborhood: "Clarendon",
    at: { lat: 38.8869, lng: -77.0941 },
    start: "21:15",
    durationMinutes: 90,
    pricePerTicket: 24,
    seatsLeft: 11,
    blurb: "Four comics, one microphone, two-drink minimum nobody enforces",
    glyph: "🎤",
  },
  {
    id: "e_vinyl_night",
    name: "All-Vinyl Soul Night",
    category: "music",
    venue: "Basement 44",
    neighborhood: "Courthouse",
    at: { lat: 38.8899, lng: -77.0863 },
    start: "21:30",
    durationMinutes: 150,
    pricePerTicket: 15,
    seatsLeft: 40,
    blurb: "45s only, no laptops, the DJ will tell you the pressing year",
    glyph: "💿",
  },
  {
    id: "e_indie_screening",
    name: "35mm Late Show: Chungking Express",
    category: "film",
    venue: "Arlington Cinema Club",
    neighborhood: "Ballston",
    at: { lat: 38.8817, lng: -77.1131 },
    start: "21:00",
    durationMinutes: 103,
    pricePerTicket: 18,
    seatsLeft: 26,
    blurb: "Real print, real grain, real reel change",
    glyph: "🎞️",
  },
  {
    id: "e_rooftop_jazz",
    name: "Rooftop Jazz Trio",
    category: "music",
    venue: "Highline Terrace",
    neighborhood: "Rosslyn",
    at: { lat: 38.8958, lng: -77.0713 },
    start: "21:45",
    durationMinutes: 120,
    pricePerTicket: 32,
    seatsLeft: 8,
    blurb: "Twelve floors up, skyline behind the bass player",
    glyph: "🎷",
  },
  {
    id: "e_paint_clay",
    name: "Late-Night Clay Studio",
    category: "class",
    venue: "Kiln & Co.",
    neighborhood: "Clarendon",
    at: { lat: 38.8851, lng: -77.0966 },
    start: "20:00",
    durationMinutes: 120,
    pricePerTicket: 40,
    seatsLeft: 6,
    blurb: "Two wheels, one instructor, you will get clay on you",
    glyph: "🏺",
  },
  {
    id: "e_shakespeare",
    name: "Twelfth Night (in a parking garage)",
    category: "theater",
    venue: "Level 3 Theatre Co.",
    neighborhood: "Courthouse",
    at: { lat: 38.8912, lng: -77.0885 },
    start: "20:30",
    durationMinutes: 135,
    pricePerTicket: 28,
    seatsLeft: 19,
    blurb: "Bring a cushion. Genuinely excellent. Genuinely a garage.",
    glyph: "🎭",
  },
  {
    id: "e_trivia_riot",
    name: "Trivia Riot",
    category: "comedy",
    venue: "Whitlow's Back Bar",
    neighborhood: "Clarendon",
    at: { lat: 38.8863, lng: -77.0958 },
    start: "20:00",
    durationMinutes: 105,
    pricePerTicket: 8,
    seatsLeft: 30,
    blurb: "Teams of two welcome, the host is mean in a fun way",
    glyph: "🧠",
  },
  {
    id: "e_night_market",
    name: "Ballston Night Market",
    category: "class",
    venue: "Quarter Plaza",
    neighborhood: "Ballston",
    at: { lat: 38.8825, lng: -77.1113 },
    start: "19:30",
    durationMinutes: 150,
    pricePerTicket: 0,
    seatsLeft: 500,
    blurb: "Free entry, thirty stalls, a man who makes candles shaped like fruit",
    glyph: "🏮",
  },
];

const SEED_PARKING: ParkingSpot[] = [
  { id: "p_clarendon_deck", name: "Clarendon Central Deck", at: { lat: 38.8867, lng: -77.0953 }, priceForEvening: 12, spacesLeft: 48, covered: true },
  { id: "p_courthouse_lot", name: "Courthouse Plaza Lot", at: { lat: 38.8907, lng: -77.0866 }, priceForEvening: 9, spacesLeft: 22, covered: false },
  { id: "p_ballston_quarter", name: "Ballston Quarter Garage", at: { lat: 38.8820, lng: -77.1121 }, priceForEvening: 10, spacesLeft: 130, covered: true },
  { id: "p_rosslyn_tower", name: "Rosslyn Tower Garage", at: { lat: 38.8960, lng: -77.0718 }, priceForEvening: 16, spacesLeft: 61, covered: true },
  { id: "p_pentagon_row", name: "Pentagon Row Garage", at: { lat: 38.8629, lng: -77.0601 }, priceForEvening: 8, spacesLeft: 200, covered: true },
  { id: "p_pike_street", name: "Columbia Pike Street Parking", at: { lat: 38.8639, lng: -77.1004 }, priceForEvening: 0, spacesLeft: 7, covered: false },
];

/**
 * Live inventory swaps in here at runtime.
 *
 * These are exported as mutable arrays rather than reassignable bindings on
 * purpose: every module that has already imported them keeps working when the
 * OpenStreetMap fetch lands, with no re-wiring and no event bus.
 */
export const RESTAURANTS: Restaurant[] = [...SEED_RESTAURANTS];
export const PARKING: ParkingSpot[] = [...SEED_PARKING];
export const EVENTS: EventItem[] = [...SEED_EVENTS];

export const SEED_COUNTS = {
  restaurants: SEED_RESTAURANTS.length,
  parking: SEED_PARKING.length,
  events: SEED_EVENTS.length,
};

export function applyInventory(next: {
  restaurants: Restaurant[];
  parking: ParkingSpot[];
  events: EventItem[];
}): void {
  if (next.restaurants.length) {
    RESTAURANTS.length = 0;
    RESTAURANTS.push(...next.restaurants);
  }
  if (next.parking.length) {
    PARKING.length = 0;
    PARKING.push(...next.parking);
  }
  if (next.events.length) {
    EVENTS.length = 0;
    EVENTS.push(...next.events);
  }
}

export const restaurantById = (id: string) => RESTAURANTS.find((r) => r.id === id);
export const eventById = (id: string) => EVENTS.find((e) => e.id === id);
export const parkingById = (id: string) => PARKING.find((p) => p.id === id);
