/**
 * Query-time search across every available adapter.
 *
 * Nothing here is cached in the page and nothing is stored per place. Each call
 * issues fresh, parameterised searches and merges the answers. The only cache in
 * the system is the Worker's edge cache, keyed by the exact query string, which
 * is a CDN doing its job rather than an inventory pretending to be current.
 *
 * Speed is a feature, so the strategy is speculative rather than sequential.
 * The precise query and the relaxed query go out at the SAME TIME, and we keep
 * whichever answered usefully. Filters miss often enough (OpenStreetMap diet
 * tagging is superb in one town and absent in the next) that waiting for the
 * precise query to fail before trying again cost more than simply asking twice.
 * Both hit the same edge cache, so the redundant one is usually free.
 */
import {
  milesBetween,
  type EventItem,
  type LatLng,
  type ParkingSpot,
  type Restaurant,
} from "../data";
import { ACTIVE_ADAPTERS } from "./registry";
import type { CandidatePool, EventQuery, RestaurantQuery, SourceReport } from "./types";

export type SearchInput = {
  at: LatLng;
  radiusKm: number;
  restaurants: Omit<RestaurantQuery, "at" | "radiusKm">;
  events: Omit<EventQuery, "at" | "radiusKm">;
};

export type SearchOutcome = CandidatePool & {
  /** Filters that had to be dropped, and why. Shown to the human verbatim. */
  dropped: string[];
};

/** exactOptionalPropertyTypes means dropping a filter is a delete, not undefined. */
function without<T extends object, K extends keyof T>(input: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...input };
  for (const k of keys) delete copy[k];
  return copy;
}

/** Same venue from two providers should appear once. */
function dedupe<T extends { id: string; name: string; at: LatLng }>(items: T[]): T[] {
  const out: T[] = [];
  for (const item of items) {
    if (
      !out.some(
        (o) =>
          o.name.toLowerCase() === item.name.toLowerCase() && milesBetween(o.at, item.at) < 0.12,
      )
    ) {
      out.push(item);
    }
  }
  return out;
}

async function attempt<T>(fn: (() => Promise<T[]>) | undefined): Promise<T[]> {
  if (!fn) return [];
  try {
    return await fn();
  } catch {
    return [];
  }
}

const ENOUGH = 6;

/**
 * One round of fan-out. Every adapter, every category, and the relaxed variant
 * of the restaurant query, all in flight together.
 */
async function round(input: SearchInput): Promise<SearchOutcome> {
  const area = { at: input.at, radiusKm: input.radiusKm };
  const reports: SourceReport[] = [];
  const dropped: string[] = [];
  const restaurants: Restaurant[] = [];
  const events: EventItem[] = [];
  const parking: ParkingSpot[] = [];

  const narrowed = Boolean(input.restaurants.cuisine) || Boolean(input.restaurants.dietary?.length);
  const hasCategory = Boolean(input.events.category);

  await Promise.all(
    ACTIVE_ADAPTERS.filter((a) => a.available).map(async (adapter) => {
      const started = performance.now();
      const searchR = adapter.searchRestaurants;
      const searchE = adapter.searchEvents;

      const [precise, broad, categoryEvents, allEvents, foundParking] = await Promise.all([
        attempt(searchR ? () => searchR({ ...area, ...input.restaurants }) : undefined),
        // The same search without the narrow filters, issued at the same time.
        // Both hit the same edge cache, so asking twice is close to free.
        narrowed
          ? attempt(
              searchR
                ? () => searchR({ ...area, ...without(input.restaurants, "cuisine", "dietary") })
                : undefined,
            )
          : Promise.resolve([] as Restaurant[]),
        attempt(searchE ? () => searchE({ ...area, ...input.events }) : undefined),
        hasCategory
          ? attempt(
              searchE
                ? () => searchE({ ...area, ...without(input.events, "category") })
                : undefined,
            )
          : Promise.resolve([] as EventItem[]),
        attempt(adapter.searchParking ? () => adapter.searchParking!(area) : undefined),
      ]);

      // Keep BOTH. A filter should shape the ranking, not shrink the world:
      // the planner already scores a matching cuisine and a matching activity
      // higher, so handing it everything means it can honour the preference
      // when the preference is affordable and fall back gracefully when it is
      // not, instead of returning nothing and blaming the user.
      restaurants.push(...precise, ...broad);
      const foundEvents = [...categoryEvents, ...allEvents];
      events.push(...foundEvents);
      parking.push(...foundParking);
      reports.push({
        id: adapter.id,
        label: adapter.label,
        kind: adapter.kind,
        available: true,
        ms: Math.round(performance.now() - started),
        counts: {
          restaurants: precise.length + broad.length,
          events: foundEvents.length,
          parking: foundParking.length,
        },
      });
    }),
  );

  return {
    restaurants: dedupe(restaurants),
    events: dedupe(events),
    parking: dedupe(parking),
    reports,
    area,
    dropped,
  };
}

/**
 * Search once, then widen only what was actually thin.
 *
 * Re-running the whole fan-out to fix a shortage of cinemas would also re-fetch
 * two hundred restaurants we already have. The second pass asks only for the
 * category that came up short, which is the difference between a 19 second
 * search and a 6 second one.
 */
export async function searchWithWidening(input: SearchInput): Promise<SearchOutcome> {
  const first = await round(input);
  const needRestaurants = first.restaurants.length < ENOUGH;
  const needEvents = first.events.length < 2;
  if (!needRestaurants && !needEvents) return first;

  const wide = { at: input.at, radiusKm: input.radiusKm * 3 };
  const adapters = ACTIVE_ADAPTERS.filter((a) => a.available);

  const [moreRestaurants, moreEvents, moreParking] = await Promise.all([
    needRestaurants
      ? Promise.all(
          adapters.map((a) =>
            attempt(
              a.searchRestaurants
                ? () =>
                    a.searchRestaurants!({
                      ...wide,
                      ...without(input.restaurants, "cuisine", "dietary"),
                    })
                : undefined,
            ),
          ),
        ).then((xs) => xs.flat())
      : Promise.resolve([] as Restaurant[]),
    needEvents
      ? Promise.all(
          adapters.map((a) =>
            attempt(
              a.searchEvents
                ? () => a.searchEvents!({ ...wide, ...without(input.events, "category") })
                : undefined,
            ),
          ),
        ).then((xs) => xs.flat())
      : Promise.resolve([] as EventItem[]),
    needRestaurants || needEvents
      ? Promise.all(
          adapters.map((a) => attempt(a.searchParking ? () => a.searchParking!(wide) : undefined)),
        ).then((xs) => xs.flat())
      : Promise.resolve([] as ParkingSpot[]),
  ]);

  const dropped = [...first.dropped];
  if (
    needRestaurants &&
    moreRestaurants.length > first.restaurants.length &&
    (input.restaurants.cuisine || input.restaurants.dietary?.length)
  ) {
    dropped.push("your food filters, because too little nearby is tagged with them");
  }
  if (needEvents && moreEvents.length > first.events.length && input.events.category) {
    dropped.push(`the "${input.events.category}" filter, because there is not enough of it nearby`);
  }

  return {
    ...first,
    restaurants:
      moreRestaurants.length > first.restaurants.length
        ? dedupe(moreRestaurants)
        : first.restaurants,
    events: moreEvents.length > first.events.length ? dedupe(moreEvents) : first.events,
    parking: moreParking.length > first.parking.length ? dedupe(moreParking) : first.parking,
    area: moreRestaurants.length || moreEvents.length ? wide : first.area,
    dropped: [...new Set(dropped)],
  };
}

export const searchCandidates = round;
