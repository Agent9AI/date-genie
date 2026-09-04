/**
 * Source adapters.
 *
 * The rule this file exists to enforce: nothing about a place is ever stored.
 * There is no city snapshot, no preloaded inventory, no "Arlington data". Each
 * request is a search, parameterised by what the human actually asked for, fanned
 * out across whichever providers are configured, merged and ranked at query time.
 *
 * Adding a provider means implementing this interface and registering it. It
 * does not mean touching the planner, the tools, or the UI.
 */
import type { EventItem, LatLng, ParkingSpot, Restaurant } from "../data";

export type SearchArea = {
  at: LatLng;
  /** Half-width of the search box. Widened by the caller when a town is sparse. */
  radiusKm: number;
};

export type RestaurantQuery = SearchArea & {
  cuisine?: string;
  maxPricePerPerson?: number;
  dietary?: string[];
  earliest?: string;
  avoid?: string[];
  party?: number;
  /**
   * Roughly what a good answer should cost per person. Sources that understand
   * language can use this to return the right KIND of place, rather than
   * returning everything and making the planner discard most of it.
   */
  targetPerPerson?: number;
  /** anniversary, birthday, first date. Shapes what "good" means here. */
  occasion?: string;
  quiet?: boolean;
};

export type EventQuery = SearchArea & {
  category?: string;
  earliest?: string;
  latestEnd?: string;
  maxPricePerTicket?: number;
};

export type ParkingQuery = SearchArea;

/** What a provider is, and whether it can actually be used right now. */
export type SourceKind = "webmcp-native" | "api-adapter" | "not-yet-available";

export type SourceAdapter = {
  id: string;
  label: string;
  kind: SourceKind;
  /** Shown in the UI so nobody has to guess where a result came from. */
  attribution: string;
  provides: ("restaurants" | "events" | "parking")[];
  /** False until a key is configured, or the origin exposes WebMCP tools. */
  available: boolean;
  needsKey?: boolean;
  /** What this provider would have to expose for us to use it. Documentation
   *  for the sources that have not shipped WebMCP yet. */
  wantedContract?: string;
  searchRestaurants?: (q: RestaurantQuery) => Promise<Restaurant[]>;
  searchEvents?: (q: EventQuery) => Promise<EventItem[]>;
  searchParking?: (q: ParkingQuery) => Promise<ParkingSpot[]>;
};

/** Per-search telemetry, surfaced in the UI and to agents via list_sources. */
export type SourceReport = {
  id: string;
  label: string;
  kind: SourceKind;
  available: boolean;
  ms: number;
  counts: { restaurants: number; events: number; parking: number };
  error?: string;
};

export type CandidatePool = {
  restaurants: Restaurant[];
  events: EventItem[];
  parking: ParkingSpot[];
  reports: SourceReport[];
  area: SearchArea;
};
