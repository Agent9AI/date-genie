/**
 * The WebMCP tool surface.
 *
 * Design rules, applied to every tool below:
 *
 *  1. Tool text is written for a language model to READ, not to parse. Each
 *     result opens with the answer in one sentence. Machine-readable detail
 *     rides along in `structuredContent`.
 *  2. Every tool that changes what the human sees says so, and the page
 *     animates. The agent never mutates state invisibly.
 *  3. Nothing that costs money executes without a human gesture in this page.
 *     `request_approval` suspends until a thumb hits Confirm, and the token it
 *     returns is single-use and dies if the plan changes.
 *  4. Errors are instructions. A failed call tells the agent what to do next.
 *  5. Searches are searches. Every lookup below queries the source adapters at
 *     call time with the caller's filters compiled in. Nothing is served from a
 *     stored city.
 */
import {
  bookPlan,
  checkAvailability,
  filterEvents,
  filterRestaurants,
  findParkingNear,
  fmtTime,
  money,
  extractLocation,
  refineConstraints,
  type Constraints,
  type Plan,
  type RefineOp,
} from "./engine";
import { driveMinutes } from "./data";
import { osmAdapter } from "./sources/osm";
import { ACTIVE_ADAPTERS, WANTED_SOURCES } from "./sources/registry";
import { understandRequest } from "./understand";
import * as store from "./store";

/* ------------------------------------------------------------- types ---- */

export type ToolContent = { type: "text"; text: string };
export type ToolResult = { content: ToolContent[]; structuredContent?: unknown; isError?: boolean };

export type ToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

/** The MCP `client` handle some WebMCP implementations pass as a 2nd argument. */
export type ModelContextClient = {
  requestUserInteraction?: <T>(cb: () => Promise<T> | T) => Promise<T>;
};

export type DateGenieTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
  execute: (input: Record<string, unknown>, client?: ModelContextClient) => Promise<ToolResult>;
};

/* -------------------------------------------------------- schema dsl ---- */

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
const num = (description: string, extra: Record<string, unknown> = {}) => ({ type: "number", description, ...extra });

const ok = (text: string, structuredContent?: unknown): ToolResult => ({
  content: [{ type: "text", text }],
  ...(structuredContent === undefined ? {} : { structuredContent }),
});
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });
const list = (xs: string[]) => xs.map((x) => `  · ${x}`).join("\n");

const NO_PLACE =
  "No location set yet, so there is nothing to search. Call set_location with wherever the human is, for example 'Fredericksburg, VA'. If they have not said, ask them.";

/* ---------------------------------------------------- shared helpers ---- */

function planSummary(p: Plan): string {
  const lines = p.legs.filter((l) => l.kind !== "parking").map((l) => `${fmtTime(l.start)} · ${l.title} (${money(l.cost)})`);
  const parking = p.parking ? `Parking: ${p.parking.spot.name}, ${money(p.parking.cost)}` : "Parking: none nearby, so take transit or a cab";
  return `${lines.join("\n")}\n${parking}\nTotal: ${money(p.total)} for ${p.constraints.party}`;
}

function planPayload(p: Plan) {
  return {
    planId: p.id,
    total: p.total,
    party: p.constraints.party,
    dinner: { id: p.dinner.restaurant.id, name: p.dinner.restaurant.name, cuisine: p.dinner.restaurant.cuisine, time: p.dinner.time, cost: p.dinner.cost },
    event: {
      id: p.event.event.id,
      name: p.event.event.name,
      venue: p.event.event.venue,
      category: p.event.event.category,
      start: p.event.event.start,
      cost: p.event.cost,
      hop: p.event.hop,
    },
    parking: p.parking ? { id: p.parking.spot.id, name: p.parking.spot.name, cost: p.parking.cost } : null,
    legs: p.legs.map((l) => ({ kind: l.kind, title: l.title, start: l.start, end: l.end, cost: l.cost })),
    why: p.why,
  };
}

/** Live adapter search for one category, at the current place. */
async function area(radiusKm = 5) {
  const place = store.getState().place;
  return place ? { at: place.at, radiusKm, label: place.label } : null;
}

/* ------------------------------------------------------------- tools ---- */

export function buildTools(): DateGenieTool[] {
  return [
    /* ---------------------------------------------------------- read ---- */
    {
      name: "get_date_context",
      description:
        "Read what the human has already set up on this page right now: where they are, budget, earliest start, party size, drive and walk limits, saved dislikes, and whether a plan is on screen. ALWAYS call this first. The human has usually already answered half your questions with the on-page controls, and asking them again is annoying.",
      inputSchema: obj({}),
      annotations: { title: "Read the page", readOnlyHint: true },
      execute: async () => {
        const s = store.getState();
        const c = s.constraints;
        const bits = [
          s.place ? `Location: ${s.place.label}. Change it with set_location.` : "Location: not set yet. Call set_location before searching.",
          s.pool
            ? `Last search returned ${s.pool.restaurants.length} restaurants, ${s.pool.events.length} event venues and ${s.pool.parking.length} parking facilities from ${s.pool.reports.map((r) => r.label).join(", ")}.`
            : "No search has run yet.",
          `Budget ceiling ${money(c.budget)} for a party of ${c.party}.`,
          `Nothing before ${fmtTime(c.earliest)}, home by ${fmtTime(c.latestEnd)}.`,
          `Drive at most ${c.maxDriveMinutes} min from home; walk at most ${c.maxWalkMinutes} min between stops, or drive up to ${c.maxHopDriveMinutes} min if they are further apart.`,
          c.interests.length ? `Interested in: ${c.interests.join(", ")}.` : "No stated interests yet.",
          s.vetoes.length ? `Standing dislikes the human saved: ${s.vetoes.join(", ")}. Never propose these.` : "No saved dislikes.",
          c.dietary.length ? `Dietary: ${c.dietary.join(", ")}.` : "",
          s.plan ? `A plan is on screen: ${s.plan.dinner.restaurant.name} then ${s.plan.event.event.venue}, ${money(s.plan.total)}.` : "No plan on screen yet.",
          s.booking ? `Already booked, confirmation ${s.booking.confirmation}.` : "",
          s.approval.status === "approved" ? "The human approved the current plan; you may call book_approved_plan." : "",
          s.notice ? `Notice on screen: ${s.notice}` : "",
        ].filter(Boolean);
        return ok(bits.join("\n"), {
          place: s.place,
          constraints: c,
          vetoes: s.vetoes,
          hasPlan: !!s.plan,
          booked: !!s.booking,
          approval: s.approval.status,
          lastSearch: s.pool ? { counts: { restaurants: s.pool.restaurants.length, events: s.pool.events.length, parking: s.pool.parking.length }, sources: s.pool.reports } : null,
        });
      },
    },

    {
      name: "list_sources",
      description:
        "List every data source this site can compose, which are live right now, and, for the ones that have not shipped WebMCP, the exact tool contract they would need to expose. Use this to answer 'where is this data from' honestly, and to explain what an agent could do if the booking industry adopted WebMCP.",
      inputSchema: obj({}),
      annotations: { title: "List sources", readOnlyHint: true },
      execute: async () => {
        const s = store.getState();
        const live = ACTIVE_ADAPTERS.map((a) => `${a.label} (${a.kind}, live) provides ${a.provides.join(", ")}. ${a.attribution}`);
        const wanted = WANTED_SOURCES.map((a) => `${a.label}: no WebMCP surface. Would need: ${a.wantedContract}`);
        const reports = s.pool?.reports.map((r) => `${r.label}: ${r.counts.restaurants} restaurants, ${r.counts.events} venues, ${r.counts.parking} lots in ${r.ms}ms`) ?? [];
        return ok(
          `Live sources:\n${list(live)}\n\nNot yet available (no major booking site exposes WebMCP as of this build):\n${list(wanted)}${
            reports.length ? `\n\nLast search:\n${list(reports)}` : ""
          }`,
          { active: ACTIVE_ADAPTERS.map(({ id, label, kind, provides, attribution }) => ({ id, label, kind, provides, attribution })), wanted: WANTED_SOURCES.map(({ id, label, provides, wantedContract }) => ({ id, label, provides, wantedContract })), lastSearch: s.pool?.reports ?? [] },
        );
      },
    },

    {
      name: "set_location",
      description:
        "Set where the evening happens. Geocodes any place name in the world with OpenStreetMap, then searches restaurants, event venues and parking around it and re-plans. Call this the moment the human names anywhere, including at the start of a conversation.",
      inputSchema: obj({ place: str("Any place name, e.g. 'Fredericksburg, VA', 'Shoreditch, London'") }, ["place"]),
      annotations: { title: "Set location", readOnlyHint: false },
      execute: async (a) => {
        const query = String(a["place"] ?? "").trim();
        if (!query) return fail("Pass a place name, e.g. 'Fredericksburg, VA'.");
        const res = await store.setPlace(query);
        if (!res.ok) return fail(res.error ?? `Could not move to ${query}.`);
        const s = store.getState();
        const counts = s.pool ? `${s.pool.restaurants.length} restaurants, ${s.pool.events.length} event venues and ${s.pool.parking.length} parking facilities` : "no results";
        return ok(
          `Now searching around ${res.place!.label}. Found ${counts}.${s.plan ? `\n\nPlanned:\n${planSummary(s.plan)}` : s.notice ? `\n\n${s.notice}` : "\n\nNo plan yet. Call plan_date_night."}`,
          { place: res.place, sources: s.pool?.reports ?? [], plan: s.plan ? planPayload(s.plan) : null },
        );
      },
    },

    {
      name: "find_restaurants",
      description:
        "Search restaurants near the current location. Filters are compiled into the upstream query, so asking for vegan food issues a vegan search rather than fetching everything and discarding most of it. Returns live results, never a cached city.",
      inputSchema: obj({
        cuisine: str("Cuisine or tag, e.g. 'korean', 'thai', 'pizza'"),
        maxPricePerPerson: num("Ceiling per person in USD"),
        dietary: { type: "array", items: { type: "string", enum: ["vegan", "vegetarian", "gluten-free"] }, description: "Hard dietary requirements" },
        earliest: str("Earliest seating, 24-hour HH:MM"),
        radiusKm: num("How far to search, default 5"),
      }),
      annotations: { title: "Find restaurants", readOnlyHint: true, openWorldHint: true },
      execute: async (a) => {
        const where = await area(Number(a["radiusKm"]) || 5);
        if (!where) return fail(NO_PLACE);
        const results = await osmAdapter.searchRestaurants!({
          at: where.at,
          radiusKm: where.radiusKm,
          ...(a["cuisine"] ? { cuisine: String(a["cuisine"]) } : {}),
          ...(a["maxPricePerPerson"] ? { maxPricePerPerson: Number(a["maxPricePerPerson"]) } : {}),
          ...(Array.isArray(a["dietary"]) ? { dietary: a["dietary"] as string[] } : {}),
          ...(a["earliest"] ? { earliest: String(a["earliest"]) } : {}),
          avoid: store.getState().vetoes,
        });
        if (!results.length)
          return ok(`Nothing matched near ${where.label}. Widen radiusKm, raise maxPricePerPerson, or drop the cuisine filter.`, { restaurants: [] });
        return ok(
          `${results.length} near ${where.label}:\n` +
            list(
              results
                .slice(0, 25)
                .map((r) => `${r.name} · ${r.cuisine}, ${money(r.pricePerPerson)}/person, ${r.rating}★, ${driveMinutes(r.at)} min drive. Open: ${r.slots.map(fmtTime).join(", ")}. id=${r.id}`),
            ) +
            `\n\nPrices, ratings and table times are simulated. Names, locations, cuisines and diet tags are real OpenStreetMap data.`,
          { restaurants: results.slice(0, 40) },
        );
      },
    },

    {
      name: "search_events",
      description:
        "Search real cinemas, theatres, music venues and arts centres near the current location. Venue names and locations are real; showtimes and ticket prices are simulated, because no keyless open dataset carries them.",
      inputSchema: obj({
        category: str("Kind of night out", { enum: ["comedy", "music", "film", "class", "theater"] }),
        maxPricePerTicket: num("Ceiling per ticket in USD"),
        radiusKm: num("How far to search, default 5"),
      }),
      annotations: { title: "Search events", readOnlyHint: true, openWorldHint: true },
      execute: async (a) => {
        const where = await area(Number(a["radiusKm"]) || 5);
        if (!where) return fail(NO_PLACE);
        const results = await osmAdapter.searchEvents!({
          at: where.at,
          radiusKm: where.radiusKm,
          ...(a["category"] ? { category: String(a["category"]) } : {}),
          ...(a["maxPricePerTicket"] !== undefined ? { maxPricePerTicket: Number(a["maxPricePerTicket"]) } : {}),
        });
        if (!results.length) return ok(`No venues of that kind near ${where.label}. Try a wider radiusKm or drop the category.`, { events: [] });
        return ok(
          `${results.length} near ${where.label}:\n` +
            list(results.slice(0, 25).map((e) => `${e.name} · ${e.category} at ${e.venue}, ${fmtTime(e.start)}, ${money(e.pricePerTicket)}/ticket, ${e.seatsLeft} seats. id=${e.id}`)),
          { events: results.slice(0, 40) },
        );
      },
    },

    {
      name: "find_parking",
      description: "Search real parking facilities near the current location, with walk times computed from coordinates.",
      inputSchema: obj({ radiusKm: num("How far to search, default 3") }),
      annotations: { title: "Find parking", readOnlyHint: true },
      execute: async (a) => {
        const where = await area(Number(a["radiusKm"]) || 3);
        if (!where) return fail(NO_PLACE);
        const results = await osmAdapter.searchParking!({ at: where.at, radiusKm: where.radiusKm });
        if (!results.length) return ok(`No named parking near ${where.label}. Street parking may be the answer there.`, { parking: [] });
        const withWalk = findParkingNear(results, where.at, { maxWalkMinutes: 30 });
        return ok(
          `${withWalk.length} near ${where.label}:\n` + list(withWalk.slice(0, 20).map((p) => `${p.name} · ${money(p.priceForEvening)} for the evening, ${p.walkMinutes} min walk. id=${p.id}`)),
          { parking: withWalk.slice(0, 30) },
        );
      },
    },

    {
      name: "check_availability",
      description: "Check which table times a restaurant from the last search still has open, and how long a meal there usually takes.",
      inputSchema: obj({ restaurantId: str("Restaurant id from find_restaurants"), earliest: str("24-hour HH:MM"), party: num("Party size") }, ["restaurantId"]),
      annotations: { title: "Check tables", readOnlyHint: true },
      execute: async (a) => {
        const pool = store.getState().pool;
        const r = pool?.restaurants.find((x) => x.id === String(a["restaurantId"]));
        if (!r) return fail(`No restaurant with id "${a["restaurantId"]}" in the last search. Call find_restaurants first.`);
        const res = checkAvailability(r, {
          ...(a["earliest"] ? { earliest: String(a["earliest"]) } : {}),
          ...(a["party"] ? { party: Number(a["party"]) } : {}),
        });
        if (!res.available) return fail(`No tables at ${r.name} after that time. Call find_restaurants for alternatives.`);
        return ok(`${r.name} has ${res.slots.length} slots: ${res.slots.map(fmtTime).join(", ")}. Budget about ${res.estimatedMealMinutes} minutes for the meal.`, res);
      },
    },

    /* ---------------------------------------------------- plan / edit ---- */
    {
      name: "plan_date_night",
      description:
        "THE MAIN TOOL. Give one natural-language request and get one composed, bookable evening (dinner, something after, and parking) that provably satisfies every constraint, rendered live onto the page. It geocodes any place named in the request, searches every source, then runs exhaustive constraint satisfaction across the results. Prefer this over driving the search tools yourself.",
      inputSchema: obj(
        { request: str("The human's request in their own words, e.g. 'Friday in Fredericksburg VA, under $150, nothing before 7, she hates seafood'") },
        ["request"],
      ),
      annotations: { title: "Plan the evening", readOnlyHint: false, idempotentHint: true },
      execute: async (a) => {
        const request = String(a["request"] ?? "").trim();
        if (!request) return fail("Pass the human's request as `request`. Their exact words are better than your summary.");
        store.set({ utterance: request });

        // Language understanding first: Workers AI at the edge if it is
        // available, the rules parser underneath it either way.
        const understood = await understandRequest(request, { ...store.getState().constraints, avoid: store.getState().vetoes });

        let moved = "";
        const named = understood.location ?? extractLocation(request);
        const current = store.getState().place;
        if (named && (!current || !current.label.toLowerCase().startsWith(named.split(",")[0]!.toLowerCase()))) {
          const res = await store.setPlace(named);
          moved = res.ok ? `Moved to ${res.place!.label} and searched it fresh.\n\n` : `${res.error}\n\n`;
        } else if (!current) {
          return fail(`${NO_PLACE} The request did not name anywhere either.`);
        }

        const parsed = understood.constraints;
        store.set({ understanding: understood });
        await store.search(parsed);

        const s = store.getState();
        if (!s.plan) {
          return fail(
            `${moved}Nothing bookable came out of that. ${s.notice ?? s.trace[s.trace.length - 1] ?? ""}\nTell the human which constraint to loosen, or call set_constraint. Parsed: ${JSON.stringify(parsed)}`,
          );
        }
        const widened = s.relaxations.length
          ? `Heads up: nothing fit their exact constraints, so I widened ${s.relaxations.map((r) => `${r.label} from ${r.from} to ${r.to}`).join(" and ")}. Say this plainly rather than presenting it as an exact match.\n\n`
          : "";
        const alt = s.alternates.map((p, i) => `Alternate ${i + 1}: ${p.dinner.restaurant.name} + ${p.event.event.venue}, ${money(p.total)}`);
        return ok(
          `${moved}${widened}Booked-shaped and on screen now. The human can see this.\n\n${planSummary(s.plan)}\n\nWhy: ${s.plan.why.join("; ")}.\nSearched ${s.pool?.restaurants.length ?? 0} restaurants and ${s.pool?.events.length ?? 0} venues, then checked ${s.considered} combinations.\n${alt.length ? "\n" + alt.join("\n") : ""}\n\nNext: call request_approval to ask the human to confirm. Do NOT book without it.`,
          {
            plan: planPayload(s.plan),
            alternates: s.alternates.map(planPayload),
            checks: s.checks,
            constraints: s.constraints,
            considered: s.considered,
            sources: s.pool?.reports ?? [],
            understanding: { via: understood.via, model: understood.model ?? null, occasion: understood.occasion },
          },
        );
      },
    },

    {
      name: "refine_plan",
      description:
        "Change the evening on screen without starting over. Use when the human reacts to what they see: 'cheaper', 'a bit later', 'somewhere quieter', 'not that restaurant'. Any prior approval is voided.",
      inputSchema: obj({ change: str("What to change", { enum: ["cheaper", "later", "earlier", "quieter", "shorter_walk", "swap_dinner", "swap_event", "fancier"] }) }, ["change"]),
      annotations: { title: "Refine the plan", readOnlyHint: false },
      execute: async (a) => {
        const s = store.getState();
        if (!s.plan) return fail("Nothing on screen to refine. Call plan_date_night first.");
        const op = String(a["change"]) as RefineOp;
        const before = s.plan;
        store.replan(refineConstraints(s.constraints, op, s.plan));
        const after = store.getState().plan;
        if (!after) {
          store.replan(s.constraints);
          return fail(`"${op}" leaves nothing bookable, so I restored the previous plan. Try a different change, or set_constraint to widen something first.`);
        }
        return ok(
          `Updated on screen: "${op}".\nWas: ${before.dinner.restaurant.name} + ${before.event.event.venue}, ${money(before.total)}\nNow: ${after.dinner.restaurant.name} + ${after.event.event.venue}, ${money(after.total)}\n\n${planSummary(after)}\n\nAny previous approval was voided; call request_approval again before booking.`,
          { plan: planPayload(after), previousTotal: before.total },
        );
      },
    },

    {
      name: "set_constraint",
      description: "Set one hard constraint directly and re-plan. Use when the human states a number rather than a feeling.",
      inputSchema: obj({
        budget: num("Total ceiling for the whole evening in USD"),
        earliest: str("Nothing before, 24-hour HH:MM"),
        latestEnd: str("Home by, 24-hour HH:MM"),
        party: num("How many people"),
        maxDriveMinutes: num("Max drive from home"),
        maxWalkMinutes: num("Max walk between stops"),
        maxHopDriveMinutes: num("Max drive between dinner and the event when too far to walk"),
      }),
      annotations: { title: "Set a constraint", readOnlyHint: false, idempotentHint: true },
      execute: async (a) => {
        const s = store.getState();
        const next: Constraints = { ...s.constraints };
        const changed: string[] = [];
        const setNum = (k: keyof Constraints, label: (v: number) => string) => {
          if (a[k] === undefined) return;
          (next[k] as number) = Number(a[k]);
          changed.push(label(Number(a[k])));
        };
        setNum("budget", (v) => `budget ${money(v)}`);
        setNum("party", (v) => `party of ${v}`);
        setNum("maxDriveMinutes", (v) => `drive ≤ ${v} min`);
        setNum("maxWalkMinutes", (v) => `walk ≤ ${v} min`);
        setNum("maxHopDriveMinutes", (v) => `drive between stops ≤ ${v} min`);
        if (a["earliest"]) { next.earliest = String(a["earliest"]); changed.push(`nothing before ${fmtTime(next.earliest)}`); }
        if (a["latestEnd"]) { next.latestEnd = String(a["latestEnd"]); changed.push(`home by ${fmtTime(next.latestEnd)}`); }
        if (!changed.length) return fail("Pass at least one constraint to change.");
        store.replan(next);
        const after = store.getState().plan;
        return ok(`Set ${changed.join(", ")}. ${after ? `Re-planned:\n\n${planSummary(after)}` : "Nothing satisfies the constraints now; the page is showing why."}`, {
          constraints: next,
          plan: after ? planPayload(after) : null,
        });
      },
    },

    {
      name: "remember_preference",
      description:
        "Save a standing dislike so it is never proposed again, on this visit or the next. Use the moment the human rules something out. It persists in the page and appears as a removable chip they can see and undo.",
      inputSchema: obj({ dislike: str("Short term to avoid forever, e.g. 'oysters', 'loud', 'korean'") }, ["dislike"]),
      annotations: { title: "Remember a dislike", readOnlyHint: false },
      execute: async (a) => {
        const term = String(a["dislike"] ?? "").trim();
        if (!term) return fail("Pass a short term, e.g. 'oysters'.");
        const vetoes = store.addVeto(term);
        if (store.getState().plan) store.replan();
        const after = store.getState().plan;
        return ok(
          `Saved. The genie will never propose "${term}" again; it is now a chip on the page the human can remove. Standing dislikes: ${vetoes.join(", ")}.${after ? `\n\nRe-planned around it:\n${planSummary(after)}` : ""}`,
          { vetoes, plan: after ? planPayload(after) : null },
        );
      },
    },

    {
      name: "pick_alternate",
      description: "Promote one of the alternates returned by plan_date_night to be the plan on screen.",
      inputSchema: obj({ which: num("1 or 2") }, ["which"]),
      annotations: { title: "Pick an alternate", readOnlyHint: false },
      execute: async (a) => {
        const s = store.getState();
        const idx = Number(a["which"]) - 1;
        const chosen = s.alternates[idx];
        if (!chosen) return fail(`No alternate ${a["which"]}. There ${s.alternates.length === 1 ? "is 1" : `are ${s.alternates.length}`}.`);
        const rest = s.alternates.filter((_, i) => i !== idx);
        store.set((prev) => ({
          plan: chosen,
          alternates: [...(prev.plan ? [prev.plan] : []), ...rest].slice(0, 2),
          approval: { status: "idle" },
          revision: prev.revision + 1,
        }));
        return ok(`Swapped to alternate ${a["which"]}, now on screen.\n\n${planSummary(chosen)}`, { plan: planPayload(chosen) });
      },
    },

    {
      name: "explain_plan",
      description:
        "Get the receipt for the plan on screen: every constraint the human stated, the target, the actual value, and whether it holds. Use this to answer 'are you sure this is under budget' with evidence instead of reassurance.",
      inputSchema: obj({}),
      annotations: { title: "Explain the plan", readOnlyHint: true },
      execute: async () => {
        const s = store.getState();
        if (!s.plan) return fail("No plan on screen. Call plan_date_night first.");
        const rows = s.checks.map((c) => `${c.ok ? "PASS" : "FAIL"} · ${c.label}: wanted ${c.target}, got ${c.actual}`);
        return ok(`Constraint receipt:\n${list(rows)}\n\nSearch: ${s.considered} combinations evaluated.\n${s.trace.join("\n")}`, {
          checks: s.checks,
          trace: s.trace,
          considered: s.considered,
          relaxations: s.relaxations,
          plan: planPayload(s.plan),
        });
      },
    },

    /* -------------------------------------------------- human gateway ---- */
    {
      name: "request_approval",
      description:
        "Ask the human to confirm the plan on screen with their own hand. This call SUSPENDS until they press Confirm or Decline in the page. It does not time out and has no default. On approval it returns a single-use token required by book_approved_plan. This is the only way to spend the human's money, and it is deliberately impossible to do it for them.",
      inputSchema: obj({ note: str("One short line shown to the human above the buttons") }),
      annotations: { title: "Ask the human", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      execute: async (a, client) => {
        const s = store.getState();
        if (!s.plan) return fail("No plan on screen to approve. Call plan_date_night first.");
        if (s.booking) return fail(`Already booked as ${s.booking.confirmation}. Nothing further to approve.`);
        const summary = String(a["note"] ?? "").trim() || `Book this evening for ${money(s.plan.total)}?`;

        // If the host gives us a user-interaction escape hatch, use it: it tells
        // the browser this pause is a deliberate human turn, not a hung tool.
        const askHuman = () => store.requestApproval(s.plan!, summary);
        const outcome = client?.requestUserInteraction ? await client.requestUserInteraction(askHuman) : await askHuman();

        if (!outcome.approved)
          return ok(`The human declined${outcome.note ? `: "${outcome.note}"` : ""}. Do not book. Ask what to change, then call refine_plan or set_constraint.`, {
            approved: false,
            note: outcome.note ?? null,
          });
        return ok(
          `Approved by the human at ${new Date().toLocaleTimeString()}${outcome.note ? ` with a note: "${outcome.note}"` : ""}. Call book_approved_plan with approvalToken "${outcome.nonce}". Single-use, and voided if the plan changes.`,
          { approved: true, approvalToken: outcome.nonce, note: outcome.note ?? null, total: s.plan.total },
        );
      },
    },
  ];
}

/**
 * Tools that only exist in certain page states. Registering and unregistering
 * these as the app changes is the point: the agent's toolbox is a live
 * reflection of what is actually possible right now, so it cannot be tricked
 * into calling `book_approved_plan` before anyone approved anything.
 */
export function buildConditionalTools(): DateGenieTool[] {
  const s = store.getState();
  const out: DateGenieTool[] = [];

  if (s.approval.status === "approved" && !s.booking) {
    out.push({
      name: "book_approved_plan",
      description:
        "Commit the approved evening: holds the table, the tickets and the parking spot in one call and returns confirmation codes. Requires the single-use token from request_approval. This tool only exists while an approval is live.",
      inputSchema: obj({ approvalToken: str("The token returned by request_approval") }, ["approvalToken"]),
      annotations: { title: "Book it", readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      execute: async (a) => {
        const claim = store.consumeApproval(String(a["approvalToken"] ?? ""));
        if (!claim.ok) return fail(`${claim.error} Nothing was booked and no money moved.`);
        const booking = bookPlan(claim.plan, claim.id);
        store.set((prev) => ({ booking, revision: prev.revision + 1 }));
        return ok(
          `Done. Confirmation ${booking.confirmation}, ${money(booking.total)} total.\n${list(booking.lines.map((l) => `${l.label} · ${l.detail} · ${l.confirmation}`))}\n\nThe receipt is on screen with an "Add to calendar" button.`,
          { booking },
        );
      },
    });
  }

  if (s.booking) {
    out.push({
      name: "get_booking",
      description: "Retrieve the confirmed evening: confirmation codes, times, and a calendar file. Only exists once something is booked.",
      inputSchema: obj({}),
      annotations: { title: "Get the booking", readOnlyHint: true },
      execute: async () => {
        const b = store.getState().booking!;
        return ok(
          `Confirmation ${b.confirmation}, ${money(b.total)}, booked ${new Date(b.bookedAt).toLocaleString()}.\n${list(b.lines.map((l) => `${l.label} · ${l.detail} · ${l.confirmation}`))}`,
          { booking: b },
        );
      },
    });
  }

  return out;
}

export const allTools = (): DateGenieTool[] => [...buildTools(), ...buildConditionalTools()];
export { filterEvents, filterRestaurants };
