# Date Genie

**Date night as a single command.** A WebMCP site that stops recommending your evening and starts executing it.

**Live:** https://date-genie.agent9.dev (mirror: https://date-genie.terry-c87.workers.dev)

Built for [The WebMCP Challenge](https://webmcp.devpost.com/). MIT licensed.

---

## The problem

Ask any assistant to plan a date night and you get ten links and a shrug. The
work you actually wanted done, holding a table, holding two tickets, and finding
somewhere to leave the car, all of it timed so you are not sprinting between
them, is still yours to do across six tabs.

The reason is not that the model is stupid. It is that a restaurant page, a
ticketing page and a parking page have nothing to say to a machine except HTML.

## What this does

Say it once:

> "Plan something fun for me and my girlfriend Friday night. Keep everything
> under $180. We're in Arlington, don't make us drive more than 20 minutes, and
> nothing before 7."

and get back one evening, not ten options:

```
7:24 PM   Park at Ballston Quarter Garage      $10
7:30 PM   Masa & Luz, Mexican, 4.5 stars       $68
9:00 PM   35mm Late Show: Chungking Express    $36
                                        Total  $114 of your $180
```

Then one button books all three at once and drops them in your calendar.

## Why this has to be WebMCP and not a server-side MCP

A server MCP could search restaurants. It could not do any of the following,
and these are the whole point of the project.

### 1. The agent reads the page, not your mind

Every dial on the left of the screen is live state that `get_date_context`
returns before the agent asks you a single question. You already said your
budget with your thumb. Being asked again is the thing that makes assistants
exhausting.

### 2. The agent writes the page, and you watch it happen

`plan_date_night` does not return an itinerary for the agent to read out. It
renders the itinerary onto the screen you are looking at, animated, and the
agent's reply describes what you can already see. One shared surface, two
participants.

### 3. Your thumb is the only thing that can spend your money

`request_approval` **suspends the tool call** until a human presses a button in
the page. No timeout. No default. An unanswered request never resolves, which
is the correct behaviour for a tool that holds a table.

On approval it returns a single-use token. `book_approved_plan` refuses without
it, and the token is voided the moment the plan changes, so an agent can never
get approval for a $114 evening and book a $400 one.

### 4. The toolbox reshapes with the app

`book_approved_plan` is **not registered** until an approval is live. It is not
guarded, it does not exist. `get_booking` only appears after something is
booked. The agent's available tools are a live reflection of what is genuinely
possible right now.

You can prove this in the console in ten seconds. See "Verify the claims" below.

### 5. Preferences persist in the page

`remember_preference("oysters")` writes a standing veto that survives reload,
appears as a chip you can remove, and is honoured by every future plan.

## The tool surface

Fourteen tools. Twelve always registered, two conditional.

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_date_context` | read | Live UI state: budget, times, party, vetoes, whether a plan is on screen |
| `find_restaurants` | read | Price, cuisine, drive time, dietary, noise. Returns real open slots |
| `search_events` | read | Comedy, music, film, theater, workshops with start times and seats left |
| `check_availability` | read | Open tables at one restaurant, plus how long a meal there takes |
| `find_parking` | read | Lots near a venue, priced for the evening, walk time from coordinates |
| `plan_date_night` | write | The main tool. Natural language in, one bookable evening out |
| `refine_plan` | write | cheaper, later, earlier, quieter, shorter_walk, swap_dinner, swap_event, fancier |
| `set_constraint` | write | Set a hard number and re-plan |
| `remember_preference` | write | Save a standing dislike, permanently |
| `pick_alternate` | write | Promote an alternate to the main plan |
| `explain_plan` | read | The constraint receipt: target vs actual for every rule you set |
| `request_approval` | gate | Suspends until a human confirms in the page. Returns a single-use token |
| `book_approved_plan` | **conditional** | Only exists while an approval is live. Books all three at once |
| `get_booking` | **conditional** | Only exists after booking |

Tool responses are written as prose for a model to read, with the machine
payload alongside in `structuredContent`. Errors are instructions: a failed call
tells the agent what to try next rather than just saying no.

## Verify the claims

Open the live site and paste these into the browser console.

```js
// The full registered surface, straight from the page
window.dateGenie.listTools().map(t => t.name)

// The agent reading your on-page state
(await window.dateGenie.call('get_date_context', {})).content[0].text

// Plan an evening the way an agent would
(await window.dateGenie.call('plan_date_night', {
  request: "under $150, vegetarian, nothing before 7:30, home by 11"
})).content[0].text

// Now try to book it without asking the human.
// This throws: the tool does not exist yet.
await window.dateGenie.call('book_approved_plan', { approvalToken: 'forged' })
```

That last line is the security model. Not a check that returns false. The
capability is absent.

The automated version of exactly this lives in `tests/e2e.mjs` and runs against
production with `npm run e2e`.

## Data: what is real and what is not

This matters, so it is stated plainly rather than buried.

**Real, fetched live from the [OpenStreetMap Overpass API](https://overpass-api.de/)
on every page load** (no API key, no cost):

- ~140 actual Arlington, Virginia restaurants: names, coordinates, cuisine tags,
  and `diet:vegan` / `diet:vegetarian` tags
- ~20 actual parking facilities: names, coordinates, whether they charge a fee,
  whether they are covered
- **Every walk and drive time in the app is computed from those real
  coordinates** with a haversine distance and a city walking pace. Nothing is a
  hardcoded pair, so the planner reasons about combinations nobody enumerated.

**Simulated, because no free open dataset carries it:**

- Prices, ratings and table availability. These are derived deterministically
  from each venue's OSM id, so a restaurant looks identical on every reload
  instead of shuffling between visits.
- The events list is curated rather than fetched. Every keyless events API worth
  using needs a key.
- Reservations. Confirmation codes are generated locally. No card is charged and
  no restaurant is contacted.

If Overpass is slow or unreachable, the app falls back to a curated seed
inventory and **says so** in the status badge and in `get_date_context`, so an
agent is never misled about how fresh its data is.

Swapping the inventory for OpenTable, Ticketmaster and SpotHero would not change
a single tool contract or a line of the planner.

## How the planner works

`planDateNight` runs exhaustive constraint satisfaction over the full
dinner-slot x event x parking product space, roughly 3,500 candidate evenings
against live OSM data.

Hard constraints eliminate: budget ceiling, earliest start, latest end, drive
radius, walk radius between stops, dietary requirements, standing vetoes, seats
remaining, and pacing (enough time to finish dinner, and no dead hour afterwards).

Survivors are scored on rating, interest match, budget headroom, pacing quality
and walk distance. The winner ships with a plain-language reason and a
constraint receipt showing target versus actual for every rule, so "are you sure
this is under budget" is answered with evidence rather than reassurance.

## WebMCP compatibility

WebMCP is a moving target. The same capability lives in different places
depending on the browser build:

| Surface | Where |
| --- | --- |
| `navigator.modelContext` | Chrome 149 origin trial, deprecated in 150 |
| `document.modelContext` | Current spec, tools belong to a document |
| `window.modelContext` | Polyfills and extension shims |
| `navigator.modelContextTesting` | Chrome's testing surface |

and registration is either per-tool (`registerTool`) or batched
(`provideContext({ tools })`).

`src/lib/date-genie/webmcp.ts` does not pick a winner. It probes every known
surface, binds to the first that works, registers through whichever calling
convention exists, supports `client.requestUserInteraction` when the host
provides it, and keeps the registered set in sync with page state. It is about
180 lines and has no dependency on the rest of this app. Lift it.

## Running it without a WebMCP browser

Most people opening this link have no agent in their browser. Rather than show
them a dead page and a version requirement, the site ships its own small agent
that drives the identical tools over the identical instrumented code path.

It is **scripted, not a language model**. No API key, no network, no hidden LLM.
What you watch it do is exactly what a real WebMCP client does, including
stopping dead at the approval gate and being unable to continue until a human
presses a button.

## Local development

```sh
npm install
npm run dev          # http://localhost:3000
npm run build        # production build
npm run deploy       # build, stamp the worker config, deploy to Cloudflare
npm run e2e          # Playwright run against production
npm run lint
```

## Architecture

```
src/lib/date-genie/
  data.ts          world model, seed inventory, haversine geo, mutable registry
  live-venues.ts   OpenStreetMap Overpass fetch, normalisation, caching
  engine.ts        constraint satisfaction, scoring, refinement, reservations
  store.ts         the shared table: one state both human and agent mutate
  tools.ts         the fourteen WebMCP tools
  webmcp.ts        the compatibility and registration layer
  demo-agent.ts    the built-in scripted agent
  ics.ts           calendar export
src/components/date-genie/panels.tsx    every panel, human control and agent surface
src/routes/index.tsx                     the page
tests/e2e.mjs                            end-to-end proof, runs against production
```

Stack: TanStack Start, React 19, Tailwind 4, deployed as a Cloudflare Worker.

## Limitations, honestly

- Arlington, Virginia only. The bounding box is one constant in `live-venues.ts`.
- Events are curated, not live.
- Prices, ratings and availability are simulated. See the data section.
- Bookings are simulated end to end.
- Only one person's agent participates. Two partners negotiating a shared plan
  through two agents is the obvious next thing and is not built.

## License

MIT. See [LICENSE](./LICENSE).
