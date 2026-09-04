# Date Genie

**Date night as a single command.** A WebMCP site that stops recommending your evening and starts executing it.

**Live:** https://date-genie.agent9.dev · **Mirror:** https://date-genie.terry-c87.workers.dev

Built for [The WebMCP Challenge](https://webmcp.devpost.com/). MIT licensed. Contributions genuinely welcome, see [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## The problem

Ask any assistant to plan a date night and you get ten links and a shrug. The work you actually wanted done, holding a table, holding two tickets, and finding somewhere to leave the car, timed so you are not sprinting between them, is still yours to do across six tabs.

The reason is not that the model is stupid. It is that a restaurant page, a ticketing page and a parking page have nothing to say to a machine except HTML.

## What it does

Say it once, in your own words, naming anywhere on earth:

> "Plan something fun for me and my girlfriend Friday night in Asheville, NC. Keep everything under $180, don't make us drive more than 20 minutes, and nothing before 7."

Get back one evening, not ten options:

```
7:24 PM   Park at Rankin Avenue Garage       $10
7:30 PM   Tupelo Honey, Southern             $68
9:00 PM   Live set at The Orange Peel        $36
                                      Total  $114 of your $180
```

Then one button books all three at once, and the tool call that does it **cannot run** until your thumb hits Confirm.

## Three layers

**1. Search.** Two adapters, queried at the moment you ask, with your filters compiled into the upstream query. OpenStreetMap gives breadth and exact coordinates in about a second. Google Maps, grounded through Gemini, gives real ratings, real review counts and real price bands in about four. Asking for vegan food issues a `diet:vegan` search rather than downloading a city and discarding most of it.

There is no stored inventory anywhere in this repo: no seed dataset, no cached city, no home town. `data.ts` contains types and geometry and nothing else.

**2. Understanding and ranking.** Cloudflare Workers AI (Llama 3.3 70B, no API key, running on the same Worker that serves the page) turns your sentence into constraints. Then a deterministic solver does exhaustive constraint satisfaction over every dinner × event × parking combination, typically three to seven thousand of them.

The split is deliberate: **the model handles language, the solver handles money and time.** The model never picks a venue and never computes a total, and any number it returns is discarded unless those digits actually appear in what you typed. A planner that cannot be talked out of your price ceiling is worth more than a cleverer one that can.

**3. Execution.** WebMCP tools, with a human approval gate that no agent can satisfy on your behalf.

## Why this has to be WebMCP and not a server-side MCP

A server MCP could search restaurants. It could not do any of the following.

### The agent reads the page, not your mind

Every dial on screen is live state that `get_date_context` returns before the agent asks a single question. You already said your budget with your thumb. Being asked again is what makes assistants exhausting.

### The agent writes the page, and you watch it happen

`plan_date_night` does not return an itinerary for the agent to read aloud. It renders it onto the screen you are looking at, and the agent's reply describes what you can already see. One shared surface, two participants.

### Your thumb is the only thing that can spend your money

`request_approval` **suspends the tool call** until you press a button in the page. No timeout. No default. An unanswered request never resolves, which is the correct behaviour for a tool that holds a table. On approval it returns a single-use token, voided the moment the plan changes, so an agent can never get approval for a $114 evening and book a $400 one.

### The toolbox reshapes with the app

`book_approved_plan` is **not registered** until an approval is live. It is not guarded, it does not exist. `get_booking` only appears after something is booked. Prove it in ten seconds:

```js
window.dateGenie.listTools().map((t) => t.name);
await window.dateGenie.call("book_approved_plan", { approvalToken: "forged" });
// TypeError: No such tool: book_approved_plan
```

That is the security model. Not a check that returns false. The capability is absent.

## The tool surface

Sixteen tools. Fourteen always registered, two conditional on page state.

| Tool                  | Kind            | What it does                                                                     |
| --------------------- | --------------- | -------------------------------------------------------------------------------- |
| `get_date_context`    | read            | Live UI state: place, budget, times, party, vetoes, whether a plan is on screen  |
| `list_sources`        | read            | Which providers are live, and the tool contract the missing ones would need      |
| `set_location`        | write           | Geocode anywhere on earth, then search it                                        |
| `find_restaurants`    | read            | Filters compiled into the upstream query                                         |
| `search_events`       | read            | Real cinemas, theatres, music venues, arts centres                               |
| `find_parking`        | read            | Real lots, walk times computed from coordinates                                  |
| `check_availability`  | read            | Open tables and how long a meal there takes                                      |
| `plan_date_night`     | write           | The main tool. One sentence in, one bookable evening out                         |
| `refine_plan`         | write           | cheaper, later, earlier, quieter, shorter_walk, swap_dinner, swap_event, fancier |
| `set_constraint`      | write           | Set a hard number and re-plan                                                    |
| `remember_preference` | write           | Save a standing dislike, permanently                                             |
| `pick_alternate`      | write           | Promote an alternate                                                             |
| `explain_plan`        | read            | Target vs actual for every rule you set                                          |
| `request_approval`    | gate            | Suspends until a human confirms. Returns a single-use token                      |
| `book_approved_plan`  | **conditional** | Only exists while an approval is live                                            |
| `get_booking`         | **conditional** | Only exists after booking                                                        |

Tool text is written for a model to read, with the machine payload alongside in `structuredContent`. Errors are instructions: a failed call tells the agent what to try next.

## Data: what is real and what is not

Stated plainly rather than buried, because it is the first thing a careful person asks.

**Real, from [OpenStreetMap](https://www.openstreetmap.org/) (Overpass and Nominatim, keyless and free):**

- Restaurants, cinemas, theatres, nightclubs, arts centres and parking facilities around any place you name, anywhere in the world
- Names, coordinates, cuisine tags, `diet:vegan` and `diet:vegetarian` tags, brand (so chains can be spotted), and whether a lot charges a fee or is covered
- **Every walk and drive time is computed from those coordinates** by haversine at a city walking pace. Nothing is a hardcoded pair, so the planner reasons about combinations nobody enumerated

**Real, from Google Maps (grounded through Gemini):**

- Star ratings and review counts
- Price bands, as a realistic spend per person
- Addresses, and a read on whether somewhere suits the occasion

**Still simulated, because neither source publishes it:**

- Table availability and showtimes. Derived deterministically from the venue id, so a restaurant looks identical on every reload rather than shuffling between visits
- Reservations. Confirmation codes are generated locally. No card is charged and no restaurant is contacted

Every venue carries a `provenance` field recording which source it came from and whether its pricing is real. When both sources return the same place, the copy with real pricing wins the merge, and the planner scores real numbers above derived ones. Where a number is still derived, the UI and the tool responses say so.

## What it does when it cannot help

Most planners answer "no results" and leave you guessing which of your six constraints was the problem. This one:

- **Widens the one constraint that actually blocked**, then says so in the UI and to the agent. Not an exact match is different from no match, and the difference belongs on screen
- **Prices the shortfall.** If money is the binding constraint, it computes the cheapest evening that satisfies everything else and shows the breakdown: dinner, tickets, parking. "Two film tickets in DC plus dinner is $95, your ceiling is $50" is something a person can act on
- **Treats filters as preferences, not walls.** Precise and broad searches run in parallel, results merge, and the scorer prefers the match. You get korean food when korean food is affordable, and an honest note when it is not

## Running it without a WebMCP browser

Most people opening this link have no agent in their browser. Rather than a dead page and a version requirement, the site ships its own small agent driving the identical tools over the identical instrumented path.

It is **scripted, not a language model**. No API key, no hidden LLM. What you watch it do is exactly what a real WebMCP client does, including stopping dead at the approval gate.

## WebMCP compatibility

The API is a moving target, so `src/lib/date-genie/webmcp.ts` does not pick a winner:

| Surface                         | Where                                      |
| ------------------------------- | ------------------------------------------ |
| `navigator.modelContext`        | Chrome 149 origin trial, deprecated in 150 |
| `document.modelContext`         | Current spec, tools belong to a document   |
| `window.modelContext`           | Polyfills and extension shims              |
| `navigator.modelContextTesting` | Chrome's testing surface                   |

It probes every one, binds to the first that works, registers through `registerTool` or `provideContext` depending on what exists, honours `client.requestUserInteraction` when the host provides it, and keeps the registered set in sync with page state. About 180 lines, no dependency on the rest of the app. Lift it.

## Architecture

```
src/lib/date-genie/
  data.ts            types and geometry. No data, by design
  engine.ts          constraint satisfaction, scoring, relaxation, diagnosis
  understand.ts      Workers AI layer with a validated rules floor
  store.ts           the shared table: one state both human and agent mutate
  tools.ts           the sixteen WebMCP tools
  webmcp.ts          compatibility and registration layer
  demo-agent.ts      the built-in scripted agent
  ics.ts             calendar export
  sources/
    types.ts         the adapter contract
    registry.ts      live adapters, and the ones that have not shipped WebMCP
    osm.ts           OpenStreetMap adapter: breadth, coordinates, diet tags
    gmaps.ts         Google Maps via Gemini: real ratings and prices
    search.ts        fan-out, dedupe by provenance, progressive enrichment
    geocode.ts       place names and browser geolocation
src/api.ts           Worker-side adapter endpoints and edge caching
src/components/date-genie/panels.tsx
src/routes/index.tsx
tests/               Playwright suites that run against production
```

Stack: TanStack Start, React 19, Tailwind 4, deployed as a Cloudflare Worker with Workers AI and Gemini.

**A note on speed.** The fast sources answer first and the page fills in; the slower, richer source lands a moment later and the plan improves in place. That is also a rather good demonstration of what a shared human-and-agent surface looks like: you watch the answer get better. `npm run warm` primes the edge cache for the demo cities so the first visitor is never a judge with a stopwatch.

## Local development

```sh
npm install
npm run dev          # http://localhost:3000
npm run build
npm run deploy       # build, stamp the worker config, deploy to Cloudflare
npm run e2e          # full approval-and-booking flow against production
node tests/scenarios.mjs   # four real cities, with timings
npm run lint
```

Workers AI and the adapter endpoints only exist in the deployed Worker, so `npm run dev` falls back to the rules parser. That path is supported and tested, not an afterthought.

## Limitations, honestly

- Events are real venues with **simulated showtimes**. A keyed Ticketmaster adapter is written and waiting for a key
- Bookings are simulated end to end
- Overpass is a free shared service and it sheds load. Queries are spread across three mirrors, failures are never cached, and Google Maps is awaited as a fallback when OpenStreetMap comes back empty, but a cold search in a new city can still take a few seconds
- Only one person's agent participates. Two partners negotiating one plan through two agents is the obvious next thing and is not built
- OpenStreetMap tagging quality varies. In some towns `amenity=restaurant` includes a popcorn shop

## License

MIT. See [LICENSE](./LICENSE).
