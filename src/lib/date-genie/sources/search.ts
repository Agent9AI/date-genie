/**
 * Query-time search across every available adapter.
 *
 * Nothing here is cached in the page and nothing is stored per place. Each call
 * issues fresh, parameterised searches, in parallel, and merges the answers.
 * The only cache in the system is the Worker's edge cache, keyed by the exact
 * query string, which is a CDN doing its job rather than an inventory sitting
 * in memory pretending to be current.
 */
import { milesBetween, type EventItem, type LatLng, type ParkingSpot, type Restaurant } from "../data";
import { ACTIVE_ADAPTERS } from "./registry";
import type { CandidatePool, EventQuery, RestaurantQuery, SourceReport } from "./types";

export type SearchInput = {
  at: LatLng;
  radiusKm: number;
  restaurants: Omit<RestaurantQuery, "at" | "radiusKm">;
  events: Omit<EventQuery, "at" | "radiusKm">;
};

/** Same venue from two providers should appear once. */
function dedupe<T extends { id: string; name: string; at: LatLng }>(items: T[]): T[] {
  const out: T[] = [];
  for (const item of items) {
    const clash = out.find(
      (o) => o.name.toLowerCase() === item.name.toLowerCase() && milesBetween(o.at, item.at) < 0.12,
    );
    if (!clash) out.push(item);
  }
  return out;
}

async function timed<T>(
  fn: (() => Promise<T[]>) | undefined,
): Promise<{ items: T[]; error?: string }> {
  if (!fn) return { items: [] };
  try {
    return { items: await fn() };
  } catch (err) {
    return { items: [], error: err instanceof Error ? err.message : "adapter failed" };
  }
}

/**
 * Fan out to every adapter. One slow or broken provider degrades the result,
 * it never fails the search.
 */
export async function searchCandidates(input: SearchInput): Promise<CandidatePool> {
  const area = { at: input.at, radiusKm: input.radiusKm };
  const reports: SourceReport[] = [];
  const restaurants: Restaurant[] = [];
  const events: EventItem[] = [];
  const parking: ParkingSpot[] = [];

  await Promise.all(
    ACTIVE_ADAPTERS.filter((a) => a.available).map(async (adapter) => {
      const started = performance.now();
      const [r, e, p] = await Promise.all([
        timed(adapter.searchRestaurants ? () => adapter.searchRestaurants!({ ...area, ...input.restaurants }) : undefined),
        timed(adapter.searchEvents ? () => adapter.searchEvents!({ ...area, ...input.events }) : undefined),
        timed(adapter.searchParking ? () => adapter.searchParking!(area) : undefined),
      ]);
      restaurants.push(...r.items);
      events.push(...e.items);
      parking.push(...p.items);
      reports.push({
        id: adapter.id,
        label: adapter.label,
        kind: adapter.kind,
        available: true,
        ms: Math.round(performance.now() - started),
        counts: { restaurants: r.items.length, events: e.items.length, parking: p.items.length },
        ...(r.error ?? e.error ?? p.error ? { error: r.error ?? e.error ?? p.error! } : {}),
      });
    }),
  );

  return {
    restaurants: dedupe(restaurants),
    events: dedupe(events),
    parking: dedupe(parking),
    reports,
    area,
  };
}

/**
 * Search, and widen once if the area came back too thin to build an evening in.
 * A small town is not an error, it just needs a bigger box.
 */
export async function searchWithWidening(input: SearchInput): Promise<CandidatePool> {
  const first = await searchCandidates(input);
  const thin = first.restaurants.length < 8 || first.events.length < 3;
  if (!thin) return first;
  const wider = await searchCandidates({ ...input, radiusKm: input.radiusKm * 2.5 });
  return wider.restaurants.length + wider.events.length > first.restaurants.length + first.events.length ? wider : first;
}
