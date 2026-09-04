# Devpost submission copy

Paste-ready. Live URL: https://date-genie.agent9.dev · Repo: https://github.com/Agent9AI/date-genie

---

## Tagline

Date night as a single command. Your agent plans the whole evening and cannot spend a cent until your thumb says so.

---

## The required description: fit, experience, implementation

**Why this use case fits WebMCP.** Planning a night out is the most ordinary task that is genuinely hard to finish. Dinner, something afterwards, and somewhere to leave the car are three separate businesses whose answers depend on each other, and every one of them can only talk to a machine in HTML. So the assistant hands back ten links and you do the actual work in six tabs. This is not a task that needs a better recommendation. It needs execution, and execution across sites is exactly the gap WebMCP exists to close.

**How the experience improves.** You say it once, in your own words, naming any town on earth. Date Genie geocodes it, searches live for restaurants, cinemas, theatres, music venues and parking, then does exhaustive constraint satisfaction over every dinner by event by parking combination, typically three to seven thousand of them, and puts one bookable evening on screen with the arithmetic shown. Not ten options. One evening, with a receipt proving every rule you set actually holds: under $180 means $146, nothing before 7 means 7:30, twenty minute drive means eleven.

Then the part that matters. The agent asks for permission, and the tool call **suspends** until you press a button in the page. No timeout, no default. The token it gets back is single use and dies the moment the plan changes, so an agent cannot get approval for a $146 evening and book a $400 one.

**How WebMCP is implemented.** Sixteen tools on the live model context surface. Fourteen are always registered. Two are conditional, and that is the interesting part: `book_approved_plan` is not registered until an approval is live. It is not guarded and it does not return false. It does not exist. Open the console on the live site and try it:

```js
await window.dateGenie.call("book_approved_plan", { approvalToken: "forged" });
// TypeError: No such tool: book_approved_plan
```

Approve the plan with your thumb and the tool appears. Book it and it disappears again, replaced by `get_booking`. The agent's toolbox is a live reflection of what is genuinely possible right now.

The binding layer handles the fact that WebMCP is a moving target: it probes `document.modelContext`, `navigator.modelContext` (Chrome 149 origin trial, deprecated in 150), `window.modelContext` and `navigator.modelContextTesting`, registers through `registerTool` or `provideContext` depending on which exists, and honours `client.requestUserInteraction` when the host offers it. It is one file with no dependency on the rest of the app, and it is meant to be lifted.

---

## Inspiration

"Here are ten things you might like" is not an answer. It is the assistant handing the work back. The thing we wanted was for AI to stop recommending your life and start executing it, and the only reason that is hard is that the sites holding the inventory have nothing to say to a machine.

## What it does

One sentence in, one bookable evening out, anywhere in the world. Dinner, something afterwards, and parking, solved together rather than one tab at a time, with a human approval gate on anything that costs money.

## How we built it

Three layers.

**Search.** A source adapter contract, queried at the moment you ask, with your filters compiled into the upstream query. OpenStreetMap gives breadth and exact coordinates in about a second; Google Maps, grounded through Gemini, gives real ratings and real price bands in about four. The fast source answers first and the page fills in, then the rich one lands and the plan improves in place. There is no stored inventory anywhere in the repo: no seed dataset, no cached city, no home town.

**Understanding and ranking.** Cloudflare Workers AI (Llama 3.3 70B, no API key, on the same Worker that serves the page) turns the sentence into constraints. A deterministic solver then does the constraint satisfaction. The split is the whole design: the model handles language, the solver handles money and time. The model never picks a venue, never computes a total, and any number it returns is discarded unless those digits appear in what the user actually typed.

**Execution.** WebMCP tools with the approval gate described above.

Deployed as a Cloudflare Worker. Every venue carries provenance recording which source it came from and whether its numbers are real, and when both sources return the same place the one with real pricing wins the merge.

## Challenges we ran into

A tester ran four scenarios and got slow, empty and silly answers. Every one was a real bug and fixing them made the product.

A request ending in "Movie?" returned nothing in Washington DC, because activities and cuisines shared one list and "film" went upstream as a _cuisine_ filter. We asked OpenStreetMap for restaurants that serve cinema.

A plan took **73 seconds**. The fallback chain ran four sequential rounds, each retrying three mirrors at 25 seconds. Now the precise and relaxed queries go out in parallel, the widening pass re-queries only the category that was thin, and the mirror chain has a whole-chain deadline. The same scenarios run in under three seconds.

DC produced no plan at all, because the planner required a parking spot. That is a car-centric assumption that breaks exactly the cities with the best nights out.

An anniversary with a $300 budget returned a $102 evening at a place called Toasted Crust, because a ceiling was being treated as a target to undercut, and because the _simulated_ star rating was outvoting everything the human actually said. Ratings are now a tiebreaker, and spending aims at a fraction of the budget that depends on the occasion.

## Accomplishments we're proud of

Booking is impossible without a human gesture, and not because we checked. The capability is absent from the agent's toolbox until a person presses a button.

When it cannot help, it says what would. If money is the binding constraint it computes the cheapest evening that satisfies everything else and shows the breakdown, rather than answering "no results" and leaving you to guess which of six constraints was the problem.

It works in any town on earth, and it ships with an honest account of which numbers are real and which are simulated, in the UI and in the tool responses.

## What we learned

Filters should be preferences, not walls. Hard-filtering on sparse open data empties a town and looks like a broken product. Running the precise and broad queries together and letting the ranker prefer the match gives full recall and a graceful fallback.

And the useful place for an LLM in this system is narrow. Language understanding, yes. Selection and arithmetic, no. A planner that cannot be talked out of your price ceiling is worth more than a cleverer one that can.

## What's next

Two partners, two agents, one shared plan, negotiated in the page. The approval gate already generalises to it.

And the list in `sources/registry.ts` of providers with no WebMCP surface, each with the exact tool contract we would call. OpenTable, Resy, Yelp, Ticketmaster, SpotHero. That list is the ask. The day any of them ships tools, this composes them.

## Built with

TanStack Start, React 19, Tailwind 4, Cloudflare Workers, Cloudflare Workers AI (Llama 3.3 70B), Google Gemini with Maps grounding, OpenStreetMap Overpass, Nominatim, Playwright, TypeScript, WebMCP.
