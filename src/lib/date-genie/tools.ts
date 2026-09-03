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
 *     `request_approval` suspends until a thumb hits Confirm; the token it
 *     returns is single-use and dies if the plan changes.
 *  4. Errors are instructions. A failed call tells the agent what to do next.
 */
import {
  DEFAULT_CONSTRAINTS,
  bookPlan,
  checkAvailability,
  findParking,
  findRestaurants,
  fmtTime,
  money,
  parseRequest,
  extractLocation,
  refineConstraints,
  searchEvents,
  toMinutes,
  type Constraints,
  type Plan,
  type RefineOp,
} from "./engine";
import { driveMinutes } from "./data";
import * as store from "./store";

/* ------------------------------------------------------------- types ---- */

export type ToolContent = { type: "text"; text: string };
export type ToolResult = {
  content: ToolContent[];
  structuredContent?: unknown;
  isError?: boolean;
};

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

/* ---------------------------------------------------- shared helpers ---- */

function planSummary(p: Plan): string {
  const lines = p.legs
    .filter((l) => l.kind !== "parking")
    .map((l) => `${fmtTime(l.start)} · ${l.title} (${money(l.cost)})`);
  return `${lines.join("\n")}\nParking: ${p.parking.spot.name}, ${money(p.parking.cost)}\nTotal: ${money(p.total)} for ${p.constraints.party}`;
}

function planPayload(p: Plan) {
  return {
    planId: p.id,
    total: p.total,
    party: p.constraints.party,
    dinner: {
      id: p.dinner.restaurant.id,
      name: p.dinner.restaurant.name,
      cuisine: p.dinner.restaurant.cuisine,
      time: p.dinner.time,
      cost: p.dinner.cost,
    },
    event: {
      id: p.event.event.id,
      name: p.event.event.name,
      category: p.event.event.category,
      start: p.event.event.start,
      cost: p.event.cost,
      walkMinutesFromDinner: p.event.walkMinutes,
    },
    parking: { id: p.parking.spot.id, name: p.parking.spot.name, cost: p.parking.cost },
    legs: p.legs.map((l) => ({ kind: l.kind, title: l.title, start: l.start, end: l.end, cost: l.cost })),
    why: p.why,
  };
}

/* ------------------------------------------------------------- tools ---- */

export function buildTools(): DateGenieTool[] {
  const tools: DateGenieTool[] = [
    /* ---------------------------------------------------------- read ---- */
    {
      name: "get_date_context",
      description:
        "Read what the human has already set up on this page right now: budget, earliest start, party size, drive and walk limits, saved dislikes, and whether a plan is currently on screen. ALWAYS call this first. The human has usually already answered half your questions with the on-page controls, and asking them again is annoying.",
      inputSchema: obj({}),
      annotations: { title: "Read the page", readOnlyHint: true },
      execute: async () => {
        const s = store.getState();
        const c = s.constraints;
        const inv = s.inventory;
        const bits = [
          `Location: ${s.place.label}. Change it with set_location if the human names anywhere else.`,
          inv.source === "openstreetmap"
            ? `Inventory: ${inv.restaurants} restaurants, ${inv.events} event venues and ${inv.parking} parking facilities within about 4 miles, fetched live from OpenStreetMap. Names, locations, cuisines and diet tags are real; prices, ratings, showtimes and availability are simulated.`
            : `Inventory: ${inv.restaurants} curated Arlington seed venues (live lookup unavailable${inv.notice ? `: ${inv.notice}` : ""}).`,
          `Budget ceiling ${money(c.budget)} for a party of ${c.party}.`,
          `Nothing before ${fmtTime(c.earliest)}, home by ${fmtTime(c.latestEnd)}.`,
          `Drive at most ${c.maxDriveMinutes} min from home, walk at most ${c.maxWalkMinutes} min between stops.`,
          c.interests.length ? `Interested in: ${c.interests.join(", ")}.` : "No stated interests yet.",
          s.vetoes.length ? `Standing dislikes the human has saved: ${s.vetoes.join(", ")}. Never propose these.` : "No saved dislikes.",
          c.dietary.length ? `Dietary: ${c.dietary.join(", ")}.` : "",
          s.plan
            ? `A plan is currently on screen: ${s.plan.dinner.restaurant.name} then ${s.plan.event.event.name}, ${money(s.plan.total)}.`
            : "No plan on screen yet.",
          s.booking ? `Already booked, confirmation ${s.booking.confirmation}.` : "",
          s.approval.status === "approved" ? "The human has approved the current plan; you may call book_approved_plan." : "",
        ].filter(Boolean);
        return ok(bits.join("\n"), {
          constraints: c,
          vetoes: s.vetoes,
          hasPlan: !!s.plan,
          booked: !!s.booking,
          approval: s.approval.status,
          inventory: s.inventory,
          place: s.place,
        });
      },
    },

    {
      name: "find_restaurants",
      description:
        "Search restaurants by price, cuisine, drive time, earliest seating, dietary needs and noise level. Returns real open table slots, not just listings.",
      inputSchema: obj({
        cuisine: str("Cuisine or tag, e.g. 'korean', 'vegan', 'noodles'"),
        maxPricePerPerson: num("Ceiling per person in USD"),
        maxDriveMinutes: num("Max drive from the human's home"),
        earliest: str("Earliest seating, 24-hour HH:MM", { pattern: "^[0-2][0-9]:[0-5][0-9]$" }),
        dietary: { type: "array", items: { type: "string", enum: ["vegan", "vegetarian", "gluten-free"] }, description: "Hard dietary requirements" },
        noise: str("Room volume", { enum: ["quiet", "moderate", "loud"] }),
      }),
      annotations: { title: "Find restaurants", readOnlyHint: true, openWorldHint: true },
      execute: async (a) => {
        const rs = findRestaurants({
          ...(a["cuisine"] ? { cuisine: String(a["cuisine"]) } : {}),
          ...(a["maxPricePerPerson"] ? { maxPricePerPerson: Number(a["maxPricePerPerson"]) } : {}),
          ...(a["maxDriveMinutes"] ? { maxDriveMinutes: Number(a["maxDriveMinutes"]) } : {}),
          ...(a["earliest"] ? { earliest: String(a["earliest"]) } : {}),
          ...(Array.isArray(a["dietary"]) ? { dietary: a["dietary"] as string[] } : {}),
          ...(a["noise"] ? { noise: String(a["noise"]) } : {}),
          avoid: store.getState().vetoes,
        });
        if (!rs.length) return ok("No restaurants match those constraints. Try raising maxPricePerPerson, widening maxDriveMinutes, or dropping the cuisine filter.", { restaurants: [] });
        return ok(
          `${rs.length} match:\n` +
            list(
              rs.map(
                (r) =>
                  `${r.name} · ${r.cuisine}, ${r.neighborhood}, ${money(r.pricePerPerson)}/person, ${r.rating}★, ${driveMinutes(r.at)} min drive. Open: ${r.slots.map(fmtTime).join(", ")}. ${r.vibe}. id=${r.id}`,
              ),
            ),
          { restaurants: rs.map((r) => ({ id: r.id, name: r.name, cuisine: r.cuisine, pricePerPerson: r.pricePerPerson, rating: r.rating, slots: r.slots, driveMinutes: driveMinutes(r.at), tags: r.tags })) },
        );
      },
    },

    {
      name: "search_events",
      description: "Search tonight's comedy, music, film, theater and workshop events near the human, with real start times and remaining seats.",
      inputSchema: obj({
        category: str("Kind of event", { enum: ["comedy", "music", "film", "class", "theater"] }),
        earliest: str("Earliest start, 24-hour HH:MM"),
        latestEnd: str("Must be over by, 24-hour HH:MM"),
        maxPricePerTicket: num("Ceiling per ticket in USD"),
        maxDriveMinutes: num("Max drive from the human's home"),
      }),
      annotations: { title: "Search events", readOnlyHint: true, openWorldHint: true },
      execute: async (a) => {
        const es = searchEvents({
          ...(a["category"] ? { category: String(a["category"]) } : {}),
          ...(a["earliest"] ? { earliest: String(a["earliest"]) } : {}),
          ...(a["latestEnd"] ? { latestEnd: String(a["latestEnd"]) } : {}),
          ...(a["maxPricePerTicket"] !== undefined ? { maxPricePerTicket: Number(a["maxPricePerTicket"]) } : {}),
          ...(a["maxDriveMinutes"] ? { maxDriveMinutes: Number(a["maxDriveMinutes"]) } : {}),
          avoid: store.getState().vetoes,
        });
        if (!es.length) return ok("No events match. Try dropping the category filter or moving latestEnd later.", { events: [] });
        return ok(
          `${es.length} tonight:\n` +
            list(es.map((e) => `${e.name} · ${e.category} at ${e.venue}, ${fmtTime(e.start)}, ${money(e.pricePerTicket)}/ticket, ${e.seatsLeft} seats left. ${e.blurb}. id=${e.id}`)),
          { events: es.map((e) => ({ id: e.id, name: e.name, category: e.category, start: e.start, pricePerTicket: e.pricePerTicket, seatsLeft: e.seatsLeft, venue: e.venue })) },
        );
      },
    },

    {
      name: "check_availability",
      description: "Check which table times a specific restaurant still has open, and how long a meal there usually takes.",
      inputSchema: obj({ restaurantId: str("Restaurant id from find_restaurants"), earliest: str("24-hour HH:MM"), party: num("Party size") }, ["restaurantId"]),
      annotations: { title: "Check tables", readOnlyHint: true },
      execute: async (a) => {
        const r = checkAvailability({
          restaurantId: String(a["restaurantId"]),
          ...(a["earliest"] ? { earliest: String(a["earliest"]) } : {}),
          ...(a["party"] ? { party: Number(a["party"]) } : {}),
        });
        if (!r.available) return fail(`No tables. ${r.reason ?? "Nothing open after that time."} Call find_restaurants for alternatives.`);
        return ok(`${r.restaurant} has ${r.slots.length} slots: ${r.slots.map(fmtTime).join(", ")}. Budget about ${r.estimatedMealMinutes} minutes for the meal.`, r);
      },
    },

    {
      name: "find_parking",
      description: "Find parking near a restaurant or venue, priced for the evening, with the real walk time computed from coordinates.",
      inputSchema: obj({ nearRestaurantId: str("Restaurant id"), nearEventId: str("Event id"), maxWalkMinutes: num("Longest acceptable walk") }),
      annotations: { title: "Find parking", readOnlyHint: true },
      execute: async (a) => {
        const ps = findParking({
          ...(a["nearRestaurantId"] ? { nearRestaurantId: String(a["nearRestaurantId"]) } : {}),
          ...(a["nearEventId"] ? { nearEventId: String(a["nearEventId"]) } : {}),
          ...(a["maxWalkMinutes"] ? { maxWalkMinutes: Number(a["maxWalkMinutes"]) } : {}),
        });
        if (!ps.length) return ok("No parking within that walk. Widen maxWalkMinutes.", { parking: [] });
        return ok(`${ps.length} lots:\n` + list(ps.map((p) => `${p.name} · ${money(p.priceForEvening)} for the evening, ${p.walkMinutes} min walk, ${p.spacesLeft} spaces. id=${p.id}`)), { parking: ps });
      },
    },

    /* ---------------------------------------------------- plan / edit ---- */
    {
      name: "plan_date_night",
      description:
        "THE MAIN TOOL. Give one natural-language request and get one composed, bookable evening (dinner, event and parking) that provably satisfies every constraint, rendered live onto the page for the human to see. Prefer this over calling the search tools yourself: it does exhaustive constraint satisfaction across every dinner-slot x event x parking combination and returns the best, plus two genuinely different alternates.",
      inputSchema: obj(
        {
          request: str("The human's request in their own words, e.g. 'Friday night for me and my girlfriend, under $180, we're in Arlington, nothing before 7, she hates seafood'"),
        },
        ["request"],
      ),
      annotations: { title: "Plan the evening", readOnlyHint: false, idempotentHint: true },
      execute: async (a) => {
        const request = String(a["request"] ?? "").trim();
        if (!request) return fail("Pass the human's request as `request`. Their exact words are better than your summary.");
        store.set({ utterance: request, thinking: true });

        // If they named a town, move there before planning. Nothing in this app
        // is pinned to one city, so "we're in Fredericksburg" actually works.
        const named = extractLocation(request);
        let moved = "";
        if (named && !store.getState().place.label.toLowerCase().startsWith(named.split(",")[0]!.toLowerCase())) {
          const res = await store.setLocation(named);
          if (res.ok && res.place) moved = `Moved to ${res.place.label} and reloaded every venue from OpenStreetMap.\n\n`;
          else moved = `${res.error ?? `Could not move to ${named}.`} Planning with the current location instead.\n\n`;
        }
        const parsed = parseRequest(request, { ...DEFAULT_CONSTRAINTS, avoid: store.getState().vetoes });
        store.replan(parsed);
        store.set({ thinking: false });

        const s = store.getState();
        if (!s.plan) {
          const blockers = Object.entries(s.trace).length ? s.trace[s.trace.length - 1] : "";
          return fail(
            `Nothing satisfies all of it. ${blockers}\nTell the human which constraint to loosen, or call refine_plan with "cheaper" or "later", or set_constraint to raise the budget. Parsed constraints: ${JSON.stringify(parsed)}`,
          );
        }
        const alt = s.alternates.map((p, i) => `Alternate ${i + 1}: ${p.dinner.restaurant.name} + ${p.event.event.name}, ${money(p.total)} (planId ${p.id})`);
        const widened = s.relaxations.length
          ? `Heads up: nothing fit their exact constraints here, so I widened ${s.relaxations
              .map((r) => `${r.label} from ${r.from} to ${r.to}`)
              .join(" and ")}. Tell the human this plainly rather than presenting it as an exact match.\n\n`
          : "";
        return ok(
          `${moved}${widened}Booked-shaped and on screen now. The human can see this.\n\n${planSummary(s.plan)}\n\nWhy: ${s.plan.why.join("; ")}.\nChecked ${s.considered} combinations; every constraint holds.\n${alt.length ? "\n" + alt.join("\n") : ""}\n\nNext: call request_approval to ask the human to confirm. Do NOT book without it.`,
          { plan: planPayload(s.plan), alternates: s.alternates.map(planPayload), checks: s.checks, constraints: s.constraints, considered: s.considered },
        );
      },
    },

    {
      name: "set_location",
      description:
        "Move the whole app to a different town or neighbourhood. Geocodes the place with OpenStreetMap and reloads every restaurant, event venue and parking facility around it, then re-plans. Use this the moment the human names somewhere other than where the page currently is. Works anywhere in the world.",
      inputSchema: obj({ place: str("Any place name, e.g. 'Fredericksburg, VA', 'Shoreditch, London'") }, ["place"]),
      annotations: { title: "Change location", readOnlyHint: false },
      execute: async (a) => {
        const query = String(a["place"] ?? "").trim();
        if (!query) return fail("Pass a place name, e.g. 'Fredericksburg, VA'.");
        const res = await store.setLocation(query);
        if (!res.ok) return fail(res.error ?? `Could not move to ${query}.`);
        const inv = store.getState().inventory;
        const after = store.getState().plan;
        return ok(
          `Now in ${res.place!.label}. Loaded ${inv.restaurants} restaurants, ${inv.events} event venues and ${inv.parking} parking facilities from OpenStreetMap, all within about 4 miles.${after ? `\n\nRe-planned:\n${planSummary(after)}` : "\n\nNo plan on screen yet. Call plan_date_night."}`,
          { place: res.place, inventory: inv },
        );
      },
    },

    {
      name: "refine_plan",
      description:
        "Change the evening that is on screen without starting over. Use when the human reacts to what they see: 'cheaper', 'a bit later', 'somewhere quieter', 'not that restaurant'. The page re-renders and any prior approval is voided.",
      inputSchema: obj(
        {
          change: str("What to change", { enum: ["cheaper", "later", "earlier", "quieter", "shorter_walk", "swap_dinner", "swap_event", "fancier"] }),
        },
        ["change"],
      ),
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
          `Updated on screen: "${op}".\nWas: ${before.dinner.restaurant.name} + ${before.event.event.name}, ${money(before.total)}\nNow: ${after.dinner.restaurant.name} + ${after.event.event.name}, ${money(after.total)}\n\n${planSummary(after)}\n\nAny previous approval was voided by this change; call request_approval again before booking.`,
          { plan: planPayload(after), previousTotal: before.total },
        );
      },
    },

    {
      name: "set_constraint",
      description:
        "Set one hard constraint directly and re-plan. Use when the human states a number rather than a feeling: a new budget, a later start, a bigger party, a longer drive.",
      inputSchema: obj({
        budget: num("Total ceiling for the whole evening in USD"),
        earliest: str("Nothing before, 24-hour HH:MM"),
        latestEnd: str("Home by, 24-hour HH:MM"),
        party: num("How many people"),
        maxDriveMinutes: num("Max drive from home"),
        maxWalkMinutes: num("Max walk between stops"),
        maxHopDriveMinutes: num("Max drive between dinner and the event, when they are too far to walk"),
      }),
      annotations: { title: "Set a constraint", readOnlyHint: false, idempotentHint: true },
      execute: async (a) => {
        const s = store.getState();
        const next: Constraints = { ...s.constraints };
        const changed: string[] = [];
        if (a["budget"] !== undefined) { next.budget = Number(a["budget"]); changed.push(`budget ${money(next.budget)}`); }
        if (a["earliest"]) { next.earliest = String(a["earliest"]); changed.push(`nothing before ${fmtTime(next.earliest)}`); }
        if (a["latestEnd"]) { next.latestEnd = String(a["latestEnd"]); changed.push(`home by ${fmtTime(next.latestEnd)}`); }
        if (a["party"] !== undefined) { next.party = Number(a["party"]); changed.push(`party of ${next.party}`); }
        if (a["maxDriveMinutes"] !== undefined) { next.maxDriveMinutes = Number(a["maxDriveMinutes"]); changed.push(`drive ≤ ${next.maxDriveMinutes} min`); }
        if (a["maxWalkMinutes"] !== undefined) { next.maxWalkMinutes = Number(a["maxWalkMinutes"]); changed.push(`walk ≤ ${next.maxWalkMinutes} min`); }
        if (a["maxHopDriveMinutes"] !== undefined) { next.maxHopDriveMinutes = Number(a["maxHopDriveMinutes"]); changed.push(`drive between stops ≤ ${next.maxHopDriveMinutes} min`); }
        if (!changed.length) return fail("Pass at least one constraint to change.");
        store.replan(next);
        const after = store.getState().plan;
        return ok(
          `Set ${changed.join(", ")}. ${after ? `Re-planned:\n\n${planSummary(after)}` : "Nothing satisfies the constraints now. The page is showing why."}`,
          { constraints: next, plan: after ? planPayload(after) : null },
        );
      },
    },

    {
      name: "remember_preference",
      description:
        "Save a standing dislike so it is never proposed again, on this visit or the next. Use the moment the human rules something out: 'she hates oysters', 'no loud rooms'. It persists in the page and appears as a removable chip they can see and undo.",
      inputSchema: obj({ dislike: str("Short term to avoid forever, e.g. 'oysters', 'loud', 'korean'") }, ["dislike"]),
      annotations: { title: "Remember a dislike", readOnlyHint: false },
      execute: async (a) => {
        const term = String(a["dislike"] ?? "").trim();
        if (!term) return fail("Pass a short term, e.g. 'oysters'.");
        const vetoes = store.addVeto(term);
        const s = store.getState();
        if (s.plan) store.replan(s.constraints);
        const after = store.getState().plan;
        return ok(
          `Saved. The genie will never propose "${term}" again. It is now a chip on the page the human can remove. Standing dislikes: ${vetoes.join(", ")}.${after ? `\n\nRe-planned around it:\n${planSummary(after)}` : ""}`,
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
        if (!chosen) return fail(`No alternate ${a["which"]}. There ${s.alternates.length === 1 ? "is 1 alternate" : `are ${s.alternates.length} alternates`}.`);
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
        "Get the receipt for the plan on screen: every constraint the human stated, the target, the actual value, and whether it holds. Use this to answer 'are you sure this is under budget?' with evidence instead of reassurance.",
      inputSchema: obj({}),
      annotations: { title: "Explain the plan", readOnlyHint: true },
      execute: async () => {
        const s = store.getState();
        if (!s.plan) return fail("No plan on screen. Call plan_date_night first.");
        const rows = s.checks.map((c) => `${c.ok ? "PASS" : "FAIL"} · ${c.label}: wanted ${c.target}, got ${c.actual}`);
        return ok(
          `Constraint receipt for ${s.plan.dinner.restaurant.name} + ${s.plan.event.event.name}:\n${list(rows)}\n\nSearch: ${s.considered} combinations evaluated.\n${s.trace.join("\n")}`,
          { checks: s.checks, trace: s.trace, considered: s.considered, plan: planPayload(s.plan) },
        );
      },
    },

    /* -------------------------------------------------- human gateway ---- */
    {
      name: "request_approval",
      description:
        "Ask the human to confirm the plan on screen with their own hand. This call SUSPENDS until they press Confirm or Decline in the page. It does not time out and has no default. On approval it returns a single-use token required by book_approved_plan. This is the only way to spend the human's money, and it is deliberately impossible to do it for them.",
      inputSchema: obj({
        note: str("One short line shown to the human above the buttons, e.g. 'Holds 2 seats, cancel free until 6pm'"),
      }),
      annotations: { title: "Ask the human", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      execute: async (a, client) => {
        const s = store.getState();
        if (!s.plan) return fail("No plan on screen to approve. Call plan_date_night first.");
        if (s.booking) return fail(`Already booked as ${s.booking.confirmation}. Nothing further to approve.`);
        const summary = String(a["note"] ?? "").trim() || `Book this evening for ${money(s.plan.total)}?`;

        // If the host implementation gives us a user-interaction escape hatch,
        // use it: it tells the browser this pause is a deliberate human turn,
        // not a hung tool.
        const askHuman = () => store.requestApproval(s.plan!, summary);
        const outcome = client?.requestUserInteraction ? await client.requestUserInteraction(askHuman) : await askHuman();

        if (!outcome.approved) {
          return ok(
            `The human declined${outcome.note ? `: "${outcome.note}"` : ""}. Do not book. Ask what to change, then call refine_plan or set_constraint.`,
            { approved: false, note: outcome.note ?? null },
          );
        }
        return ok(
          `Approved by the human at ${new Date().toLocaleTimeString()}${outcome.note ? ` with a note: "${outcome.note}"` : ""}. Call book_approved_plan with approvalToken "${outcome.nonce}". The token is single-use and is voided if the plan changes.`,
          { approved: true, approvalToken: outcome.nonce, note: outcome.note ?? null, total: s.plan.total },
        );
      },
    },
  ];

  return tools;
}

/**
 * Tools that only exist in certain page states. Registering and unregistering
 * these as the app changes is the point: the agent's toolbox is a live
 * reflection of what is actually possible right now, so it cannot be tricked
 * into calling `book_approved_plan` before anyone approved anything, or
 * `cancel_booking` when there is no booking.
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
          `Done. Confirmation ${booking.confirmation}, ${money(booking.total)} total.\n${list(booking.lines.map((l) => `${l.label} · ${l.detail} · ${l.confirmation}`))}\n\nThe receipt is on screen with an "Add to calendar" button. Tell the human the times and let them go.`,
          { booking },
        );
      },
    });
  }

  if (s.booking) {
    out.push({
      name: "get_booking",
      description: "Retrieve the confirmed evening: confirmation codes, times, and a calendar file the human can save. Only exists once something is booked.",
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

export function allTools(): DateGenieTool[] {
  return [...buildTools(), ...buildConditionalTools()];
}

export const toolTimeSort = (a: { at: number }, b: { at: number }) => b.at - a.at;
export { toMinutes };
