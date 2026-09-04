# Contributing

The most useful thing you can add is a **source adapter**, and it does not require understanding the rest of the app.

## Add a data source in one file

Everything the planner knows arrives through the adapter contract in `src/lib/date-genie/sources/types.ts`. Implement as much of it as your provider supports and register it. You do not touch the planner, the tools, or the UI.

```ts
import type { SourceAdapter } from "./types";

export const myAdapter: SourceAdapter = {
  id: "my-source",
  label: "My Source",
  kind: "api-adapter",
  attribution: "Data © My Source",
  provides: ["restaurants"],
  available: true,

  async searchRestaurants(q) {
    // q gives you: at {lat,lng}, radiusKm, and the caller's filters:
    // cuisine, maxPricePerPerson, dietary, earliest, avoid, party.
    //
    // Push the filters INTO your upstream query wherever the API supports it.
    // Fetching everything and filtering here is the thing this project is
    // deliberately not doing.
    const res = await fetch(`/api/my-source?lat=${q.at.lat}&lng=${q.at.lng}`);
    const rows = await res.json();
    return rows.map(toRestaurant); // shape defined in ../data.ts
  },
};
```

Then add it to `ACTIVE_ADAPTERS` in `sources/registry.ts`. That is the whole integration. `search.ts` will fan out to it in parallel, dedupe its results against the other sources, and report its latency in the UI and through the `list_sources` tool.

`sources/gmaps.ts` is the worked example of a keyed adapter: it calls `/api/places`, marks itself `available: false` until the Worker confirms a key exists, sets `provenance.realPricing` on what it returns, and gives itself a short timeout so a slow enrichment degrades the answer instead of the app.

**If your provider needs a key**, add an endpoint in `src/api.ts` and call it from the adapter. Keys live in the Worker and must never reach the client bundle. `/api/yelp`, `/api/events` and `/api/foursquare` are already written as working examples; they report themselves unavailable until a key is configured, which is exactly the behaviour a new keyed adapter should have.

## Adapters we would especially like

`sources/registry.ts` carries a `WANTED_SOURCES` list: providers with no WebMCP surface, each with the exact tool contract we would call. Ticketmaster and Yelp are the two that would most improve results today, because showtimes and price bands are the two things open data genuinely lacks.

## Ground rules

**Never store a place.** No seed datasets, no per-city caches in the page, no default home town. Every search is issued fresh with the caller's filters. The only cache is the Worker's edge cache, keyed by the exact query string. This is the constraint the whole design hangs off; a PR that reintroduces a bundled city will be sent back.

**Be honest about what is real.** Set `provenance` on everything you return. If your adapter synthesizes a value the provider does not supply, say so in the code comment, in the tool text that returns it, and in the UI. Look at how `sources/osm.ts` labels simulated prices and how `sources/gmaps.ts` marks real ones. Users and agents both deserve to know how much to trust a number.

**Keep the model out of the arithmetic.** Language understanding can use an LLM. Selection, scoring and anything that ends up on the bill stays deterministic and auditable.

**Nothing spends money without a human gesture.** Any tool with a side effect goes behind `request_approval` and the single-use token, and is registered only while that approval is live.

## Testing

```sh
npm run e2e                 # approval gate and booking flow, against production
node tests/scenarios.mjs    # four real cities, prints timings and plans
node tests/cities.mjs "Lisbon, Portugal" "Boise, ID"   # try anywhere
```

`tests/scenarios.mjs` is the one to run after touching search or scoring. It caught every bug that mattered: a cuisine filter asking for restaurants that serve film, a 73 second plan, and an anniversary that spent a third of its budget.

## Style

Match the file you are in. Comments explain _why_, especially where a decision looks odd. Several of the stranger-looking choices in this codebase (bbox instead of `around:`, speculative parallel queries, a small weight on the star rating) are load-bearing and commented as such.
