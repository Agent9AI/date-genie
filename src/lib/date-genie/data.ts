export type Restaurant = {
  id: string;
  name: string;
  cuisine: string;
  neighborhood: string;
  pricePerPerson: number;
  rating: number;
  driveMinutes: number;
  slots: string[];
  vibe: string;
};

export type EventItem = {
  id: string;
  name: string;
  category: string;
  venue: string;
  neighborhood: string;
  start: string;
  pricePerTicket: number;
  driveMinutes: number;
  walkFrom: Record<string, number>;
};

export type ParkingSpot = {
  id: string;
  name: string;
  neighborhood: string;
  priceForEvening: number;
  walkMinutes: number;
};

export const RESTAURANTS: Restaurant[] = [
  {
    id: "r_seoul_ember",
    name: "Seoul Ember",
    cuisine: "Korean BBQ",
    neighborhood: "Clarendon",
    pricePerPerson: 46,
    rating: 4.7,
    driveMinutes: 11,
    slots: ["18:45", "19:15", "19:30", "20:00", "20:45"],
    vibe: "Loud, smoky, grill-at-your-table",
  },
  {
    id: "r_little_boat",
    name: "Little Boat Oyster Room",
    cuisine: "Seafood",
    neighborhood: "Rosslyn",
    pricePerPerson: 62,
    rating: 4.6,
    driveMinutes: 14,
    slots: ["19:00", "19:45", "21:00"],
    vibe: "Candlelit, tiny, ten stools",
  },
  {
    id: "r_masa_luz",
    name: "Masa & Luz",
    cuisine: "Mexican",
    neighborhood: "Ballston",
    pricePerPerson: 34,
    rating: 4.5,
    driveMinutes: 8,
    slots: ["19:00", "19:30", "20:15", "21:00"],
    vibe: "Neon patio, mezcal list",
  },
  {
    id: "r_thali_house",
    name: "Thali House",
    cuisine: "Indian",
    neighborhood: "Courthouse",
    pricePerPerson: 29,
    rating: 4.4,
    driveMinutes: 9,
    slots: ["18:30", "19:15", "20:00"],
    vibe: "Warm, family run, great naan",
  },
  {
    id: "r_north_forty",
    name: "North Forty Chophouse",
    cuisine: "Steakhouse",
    neighborhood: "Pentagon City",
    pricePerPerson: 88,
    rating: 4.8,
    driveMinutes: 16,
    slots: ["19:30", "20:30"],
    vibe: "Dark wood, big pours",
  },
  {
    id: "r_udon_hour",
    name: "Udon Hour",
    cuisine: "Japanese",
    neighborhood: "Clarendon",
    pricePerPerson: 27,
    rating: 4.3,
    driveMinutes: 12,
    slots: ["18:30", "19:00", "19:45", "20:30"],
    vibe: "Counter seating, fast and cheap",
  },
];

export const EVENTS: EventItem[] = [
  {
    id: "e_dry_humor",
    name: "Dry Humor Live",
    category: "comedy",
    venue: "The Bishop Room",
    neighborhood: "Clarendon",
    start: "21:15",
    pricePerTicket: 24,
    driveMinutes: 11,
    walkFrom: { r_seoul_ember: 4, r_udon_hour: 6, r_masa_luz: 18 },
  },
  {
    id: "e_vinyl_night",
    name: "All-Vinyl Soul Night",
    category: "music",
    venue: "Basement 44",
    neighborhood: "Courthouse",
    start: "21:30",
    pricePerTicket: 15,
    driveMinutes: 9,
    walkFrom: { r_thali_house: 5, r_seoul_ember: 14 },
  },
  {
    id: "e_indie_screening",
    name: "35mm Late Screening: Chungking Express",
    category: "film",
    venue: "Arlington Cinema Club",
    neighborhood: "Ballston",
    start: "21:00",
    pricePerTicket: 18,
    driveMinutes: 8,
    walkFrom: { r_masa_luz: 3, r_udon_hour: 15 },
  },
  {
    id: "e_rooftop_jazz",
    name: "Rooftop Jazz Trio",
    category: "music",
    venue: "Highline Terrace",
    neighborhood: "Rosslyn",
    start: "21:45",
    pricePerTicket: 32,
    driveMinutes: 14,
    walkFrom: { r_little_boat: 2 },
  },
  {
    id: "e_paint_clay",
    name: "Late-Night Clay Studio",
    category: "class",
    venue: "Kiln & Co.",
    neighborhood: "Clarendon",
    start: "20:00",
    pricePerTicket: 40,
    driveMinutes: 12,
    walkFrom: { r_seoul_ember: 7, r_udon_hour: 5 },
  },
];

export const PARKING: ParkingSpot[] = [
  { id: "p_clarendon_deck", name: "Clarendon Central Deck", neighborhood: "Clarendon", priceForEvening: 12, walkMinutes: 3 },
  { id: "p_courthouse_lot", name: "Courthouse Plaza Lot", neighborhood: "Courthouse", priceForEvening: 9, walkMinutes: 4 },
  { id: "p_ballston_quarter", name: "Ballston Quarter Garage", neighborhood: "Ballston", priceForEvening: 10, walkMinutes: 2 },
  { id: "p_rosslyn_tower", name: "Rosslyn Tower Garage", neighborhood: "Rosslyn", priceForEvening: 16, walkMinutes: 5 },
  { id: "p_pentagon_row", name: "Pentagon Row Garage", neighborhood: "Pentagon City", priceForEvening: 8, walkMinutes: 6 },
];
