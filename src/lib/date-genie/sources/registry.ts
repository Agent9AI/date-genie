/**
 * The source registry.
 *
 * Two jobs. First, hold the adapters that actually work, so a search can fan
 * out across all of them. Second, and just as important for an open standard:
 * name the providers that have NOT shipped WebMCP, and write down the exact
 * tool contract each would need to expose.
 *
 * That second list is not filler. As of now no major booking site (Yelp,
 * OpenTable, Resy, Ticketmaster, SpotHero) exposes WebMCP tools, so an agent
 * cannot compose them. Publishing the contract we would call is the most useful
 * thing this project can do about that, and it makes the gap legible instead of
 * hiding it behind a demo that pretends the ecosystem already exists.
 */
import { osmAdapter } from "./osm";
import type { SourceAdapter } from "./types";

/** Providers we can call today. */
export const ACTIVE_ADAPTERS: SourceAdapter[] = [osmAdapter];

/**
 * Providers we would compose the moment they expose tools, with the contract.
 * If you work at one of these: this is the whole ask.
 */
export const WANTED_SOURCES: SourceAdapter[] = [
  {
    id: "opentable",
    label: "OpenTable",
    kind: "not-yet-available",
    attribution: "No public WebMCP surface as of this build",
    provides: ["restaurants"],
    available: false,
    wantedContract:
      "search_restaurants(near, cuisine, party, earliest, maxPricePerPerson) -> [{id,name,slots}]; check_availability(restaurantId, date, party) -> [slots]; reserve_table(restaurantId, slot, party) behind a human approval gate.",
  },
  {
    id: "resy",
    label: "Resy",
    kind: "not-yet-available",
    attribution: "No public WebMCP surface as of this build",
    provides: ["restaurants"],
    available: false,
    wantedContract: "Same shape as OpenTable. Notify-me on a full night would compose especially well with a planner.",
  },
  {
    id: "yelp",
    label: "Yelp",
    kind: "not-yet-available",
    attribution: "Fusion API exists; no WebMCP surface",
    provides: ["restaurants"],
    available: false,
    wantedContract:
      "search_businesses(near, term, price, open_at) -> [{id,name,rating,price,coordinates}]. Ratings and price bands are the two things open data genuinely lacks.",
  },
  {
    id: "ticketmaster",
    label: "Ticketmaster",
    kind: "not-yet-available",
    attribution: "Discovery API exists; no WebMCP surface",
    provides: ["events"],
    available: false,
    wantedContract:
      "search_events(near, window, classification, maxPrice) -> [{id,name,start,priceRange,seatsLeft}]; reserve_tickets(eventId, quantity) behind a human approval gate.",
  },
  {
    id: "spothero",
    label: "SpotHero",
    kind: "not-yet-available",
    attribution: "No public WebMCP surface as of this build",
    provides: ["parking"],
    available: false,
    wantedContract: "search_parking(near, arriveBy, leaveBy) -> [{id,name,price,walkMinutes}]; reserve_spot(spotId, window).",
  },
];

/**
 * Adapters whose availability depends on server-side keys. The Worker reports
 * which are configured; the client never sees a key either way.
 */
export async function refreshKeyedAvailability(): Promise<Record<string, boolean>> {
  try {
    const res = await fetch("/api/sources", { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return {};
    const body = (await res.json()) as { sources?: { id: string; available: boolean }[] };
    return Object.fromEntries((body.sources ?? []).map((s) => [s.id, s.available]));
  } catch {
    return {};
  }
}

export const allKnownSources = (): SourceAdapter[] => [...ACTIVE_ADAPTERS, ...WANTED_SOURCES];
