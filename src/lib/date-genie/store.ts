/**
 * The shared table.
 *
 * A page-level store that BOTH the human UI and the agent's WebMCP tool calls
 * read and write. This is the whole thesis of WebMCP in one file: the agent is
 * not talking to a backend behind the user's back, it is sitting at the same
 * table, touching the same state, and the human watches it happen.
 *
 * Note what is NOT here: any inventory. `pool` holds the results of the last
 * search and nothing else. Change the location or the constraints and it is
 * replaced by a fresh search. There is no city cached in this page.
 *
 * Deliberately framework-free (a small observable) so the tool layer never
 * imports React and can be lifted into any site.
 */
import type { Shortfall } from "./engine";
import {
  DEFAULT_CONSTRAINTS,
  activityInterests,
  cuisineInterests,
  diagnose,
  planWithRelaxation,
  type Booking,
  type CheckRow,
  type Constraints,
  type Plan,
  type Relaxation,
} from "./engine";
import { setHome } from "./data";
import { geocode, locateMe, reverseGeocode, type Place } from "./sources/geocode";
import { enrich, richSourcesAvailable, searchWithWidening } from "./sources/search";
import type { Understanding } from "./understand";
import type { CandidatePool } from "./sources/types";

export type ToolCall = {
  id: string;
  name: string;
  args: unknown;
  result?: unknown;
  error?: string;
  at: number;
  ms?: number;
  caller: "agent" | "you" | "demo";
};

export type ApprovalState =
  | { status: "idle" }
  | {
      status: "pending";
      id: string;
      summary: string;
      total: number;
      plan: Plan;
      requestedAt: number;
    }
  | { status: "approved"; id: string; nonce: string; note?: string; plan: Plan; at: number }
  | { status: "declined"; id: string; note?: string; at: number };

export type State = {
  constraints: Constraints;
  utterance: string;
  /** How the last request was parsed, and by what. */
  understanding: Understanding | null;
  /** Where we are searching. Null until the human says, or geolocation answers. */
  place: Place | null;
  /** Results of the most recent search. Never persisted, never reused across places. */
  pool: CandidatePool | null;
  plan: Plan | null;
  alternates: Plan[];
  checks: CheckRow[];
  trace: string[];
  considered: number;
  relaxations: Relaxation[];
  /** Why there is no plan, and what would fix it. */
  shortfall: Shortfall | null;
  calls: ToolCall[];
  approval: ApprovalState;
  booking: Booking | null;
  vetoes: string[];
  webmcp: { bound: boolean; surface: string; tools: string[]; agentSeen: boolean };
  searching: boolean;
  /** True while the slower, higher quality sources are still coming in. */
  enriching: boolean;
  /** Set when a search ran and could not produce an evening. Shown verbatim. */
  notice: string | null;
  narration: string[];
  demoRunning: boolean;
  revision: number;
};

const STORAGE_KEY = "date-genie.vetoes.v1";

function loadVetoes(): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function saveVetoes(v: string[]) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch {
    /* private mode, quota, whatever. Vetoes are a nicety, never load-bearing */
  }
}

let state: State = {
  constraints: { ...DEFAULT_CONSTRAINTS },
  utterance: "",
  understanding: null,
  place: null,
  pool: null,
  plan: null,
  alternates: [],
  checks: [],
  trace: [],
  considered: 0,
  relaxations: [],
  shortfall: null,
  calls: [],
  approval: { status: "idle" },
  booking: null,
  vetoes: [],
  webmcp: { bound: false, surface: "none", tools: [], agentSeen: false },
  searching: false,
  enriching: false,
  notice: null,
  narration: [],
  demoRunning: false,
  revision: 0,
};

const listeners = new Set<() => void>();

export const getState = (): State => state;

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function set(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const next = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

/** Vetoes are the only thing that persists, because they are about the human,
 *  not about a place. */
export function hydrate() {
  const vetoes = loadVetoes();
  set({
    vetoes,
    constraints: {
      ...state.constraints,
      avoid: [...new Set([...state.constraints.avoid, ...vetoes])],
    },
  });
}

export function addVeto(term: string) {
  const t = term.trim().toLowerCase();
  if (!t || state.vetoes.includes(t)) return state.vetoes;
  const vetoes = [...state.vetoes, t];
  saveVetoes(vetoes);
  set({
    vetoes,
    constraints: { ...state.constraints, avoid: [...new Set([...state.constraints.avoid, t])] },
  });
  return vetoes;
}

export function removeVeto(term: string) {
  const t = term.trim().toLowerCase();
  const vetoes = state.vetoes.filter((v) => v !== t);
  saveVetoes(vetoes);
  set({
    vetoes,
    constraints: { ...state.constraints, avoid: state.constraints.avoid.filter((a) => a !== t) },
  });
  return vetoes;
}

export function narrate(line: string) {
  set((s) => ({ narration: [...s.narration, line].slice(-8) }));
}

export function logCall(call: ToolCall) {
  set((s) => ({ calls: [call, ...s.calls].slice(0, 60) }));
}

export function patchCall(id: string, patch: Partial<ToolCall>) {
  set((s) => ({ calls: s.calls.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
}

/* ----------------------------------------------------------- location ---- */

export async function setPlace(
  query: string,
  opts: { runSearch?: boolean } = {},
): Promise<{ ok: boolean; place?: Place; error?: string }> {
  const { runSearch = true } = opts;
  set({ searching: true, notice: null });
  const place = await geocode(query);
  if (!place) {
    set({ searching: false, notice: `Could not find "${query}" on the map.` });
    return {
      ok: false,
      error: `Could not find "${query}". Try adding a state or country, e.g. "Fredericksburg, VA".`,
    };
  }
  setHome(place.at);
  set({ place, pool: null, ...(runSearch ? {} : { searching: false }) });
  if (runSearch) await search();
  return { ok: true, place };
}

/** Offer to start where the human actually is, rather than picking a city for them. */
export async function useMyLocation(): Promise<Place | null> {
  set({ searching: true, notice: null });
  const at = await locateMe();
  if (!at) {
    set({ searching: false, notice: "Location permission was declined. Type a place instead." });
    return null;
  }
  const place = (await reverseGeocode(at)) ?? { label: "your location", at };
  setHome(place.at);
  set({ place, pool: null });
  await search();
  return place;
}

/* ------------------------------------------------------------- search ---- */

/**
 * One search, one plan. Every call goes to the adapters fresh with the current
 * constraints compiled into the query. Nothing is reused from a previous place.
 */
export async function search(c: Constraints = state.constraints): Promise<void> {
  const place = state.place;
  if (!place) {
    set({ notice: "Tell me where you are first." });
    return;
  }
  const merged: Constraints = { ...c, avoid: [...new Set([...c.avoid, ...state.vetoes])] };
  set({ searching: true, constraints: merged, notice: null });

  // A cuisine filter and an activity filter are different queries against
  // different amenities. Mixing them asks for restaurants that serve cinema.
  const cuisine = cuisineInterests(merged)[0];
  const activity = activityInterests(merged)[0];

  let pool = await searchWithWidening({
    at: place.at,
    radiusKm: 4,
    restaurants: {
      ...(cuisine ? { cuisine } : {}),
      dietary: merged.dietary,
      avoid: merged.avoid,
      earliest: merged.earliest,
      party: merged.party,
    },
    events: {
      ...(activity ? { category: activity } : {}),
      earliest: merged.earliest,
      latestEnd: merged.latestEnd,
    },
  });

  if (pool.dropped.length) {
    set({ notice: `To find anything at all I had to drop ${pool.dropped.join("; and ")}.` });
  }

  // Overpass is a free shared service and it sheds load. When it comes back
  // empty, Google Maps is not a nice-to-have any more, it is the answer, so
  // wait for it before telling anyone there is nothing here.
  if (pool.restaurants.length < 8 && richSourcesAvailable()) {
    const rescued = await enrich(pool, {
      at: place.at,
      radiusKm: 4,
      restaurants: {
        ...(cuisine ? { cuisine } : {}),
        dietary: merged.dietary,
        avoid: merged.avoid,
        earliest: merged.earliest,
        party: merged.party,
        targetPerPerson: Math.max(
          12,
          Math.round((merged.budget * merged.spendTarget * 0.62) / Math.max(1, merged.party)),
        ),
        ...(merged.spendTarget >= 0.8 ? { occasion: "special occasion" } : {}),
        ...(merged.noisePreference === "quiet" ? { quiet: true } : {}),
      },
      events: {
        ...(activity ? { category: activity } : {}),
        earliest: merged.earliest,
        latestEnd: merged.latestEnd,
      },
    });
    if (rescued.restaurants.length > pool.restaurants.length) pool = rescued;
  }

  if (!pool.restaurants.length) {
    set({
      searching: false,
      pool,
      plan: null,
      alternates: [],
      checks: [],
      notice: `No restaurants came back for ${place.label}. Every source came up empty, which usually means the free OpenStreetMap service is shedding load. Try again in a moment.`,
      revision: state.revision + 1,
    });
    return;
  }

  applyPlan(merged, pool);

  // The page now has an answer. Go and get the real ratings and prices, then
  // improve it in place rather than making anyone wait for perfection.
  enrichmentInFlight = enrichCurrent(merged, { at: place.at, radiusKm: 4, cuisine, activity });

  // Still nothing bookable, and we were filtering on what they asked for? The
  // filters are the likeliest culprit, so try once without them and be honest
  // that the result is a compromise rather than a match.
  const priorShortfall = getState().shortfall;
  if (!getState().plan && (cuisine || activity)) {
    const openPool = await searchWithWidening({
      at: place.at,
      radiusKm: 6,
      restaurants: {
        dietary: merged.dietary,
        avoid: merged.avoid,
        earliest: merged.earliest,
        party: merged.party,
      },
      events: { earliest: merged.earliest, latestEnd: merged.latestEnd },
    });
    if (openPool.restaurants.length) {
      applyPlan(merged, openPool);
      // getState() rather than the narrowed module binding: applyPlan just wrote to it.
      const chosen = getState().plan;
      if (chosen) {
        // Only apologise for ignoring a preference we actually ignored. The
        // unfiltered search often lands on the thing they asked for anyway.
        const missed = [
          cuisine &&
          !`${chosen.dinner.restaurant.cuisine} ${chosen.dinner.restaurant.tags.join(" ")}`
            .toLowerCase()
            .includes(cuisine)
            ? cuisine
            : null,
          activity && chosen.event.event.category !== activity ? activity : null,
        ].filter(Boolean);
        if (missed.length) {
          // If money was the reason, say the number. "Could not fit your
          // preference" is useless; "two film tickets plus dinner is $95, your
          // ceiling is $50" is something a person can act on.
          const why =
            priorShortfall?.reason === "budget" && priorShortfall.cheapestTotal
              ? ` Doing it with ${missed.join(" and ")} costs about ${priorShortfall.cheapestTotal} for ${merged.party}, over your ceiling of ${merged.budget}.`
              : "";
          set({
            notice: `Nothing matching ${missed.join(" and ")} fit in ${place.label}, so this ignores that.${why} Everything else you asked for still holds.`,
          });
        }
      }
    }
  }
}

let enrichmentInFlight: Promise<void> | null = null;

/**
 * Wait for the richer sources, but not forever. A person watching the page gets
 * the improvement whenever it lands; an agent that asked a question needs an
 * answer now, so it waits a beat and then reports what it has.
 */
export async function awaitEnrichment(maxMs = 6000): Promise<void> {
  if (!enrichmentInFlight) return;
  await Promise.race([enrichmentInFlight, new Promise((r) => setTimeout(r, maxMs))]);
}

/**
 * Second pass. Runs after a plan is already on screen, and only replaces it if
 * the richer sources actually returned something.
 */
async function enrichCurrent(
  c: Constraints,
  ctx: {
    at: { lat: number; lng: number };
    radiusKm: number;
    cuisine?: string | undefined;
    activity?: string | undefined;
  },
): Promise<void> {
  const basePool = getState().pool;
  if (!basePool) return;
  set({ enriching: true });
  try {
    const better = await enrich(basePool as never, {
      at: ctx.at,
      radiusKm: ctx.radiusKm,
      restaurants: {
        ...(ctx.cuisine ? { cuisine: ctx.cuisine } : {}),
        dietary: c.dietary,
        avoid: c.avoid,
        earliest: c.earliest,
        party: c.party,
        // What a good answer should cost per head, so the rich source returns
        // the right kind of place instead of the cheapest thing nearby.
        targetPerPerson: Math.max(
          12,
          Math.round((c.budget * c.spendTarget * 0.62) / Math.max(1, c.party)),
        ),
        ...(c.spendTarget >= 0.8 ? { occasion: "special occasion" } : {}),
        ...(c.noisePreference === "quiet" ? { quiet: true } : {}),
      },
      events: {
        ...(ctx.activity ? { category: ctx.activity } : {}),
        earliest: c.earliest,
        latestEnd: c.latestEnd,
      },
    });
    // Only disturb the screen if the enrichment genuinely added something, and
    // never once a human has approved or booked.
    const s = getState();
    if (s.approval.status !== "idle" || s.booking) return;
    if (
      better.restaurants.length > (basePool.restaurants.length ?? 0) ||
      better.events.length > (basePool.events.length ?? 0)
    ) {
      applyPlan(getState().constraints, better as never);
    }
  } finally {
    set({ enriching: false });
  }
}

/** Re-plan against the results already in hand. Used when a constraint changes
 *  in a way that does not need a new search (budget, party, times). */
export function replan(c: Constraints = state.constraints): void {
  const merged: Constraints = { ...c, avoid: [...new Set([...c.avoid, ...state.vetoes])] };
  if (!state.pool) {
    set({ constraints: merged });
    void search(merged);
    return;
  }
  applyPlan(merged, state.pool);
}

function applyPlan(c: Constraints, pool: CandidatePool) {
  const result = planWithRelaxation(c, pool);
  const shortfall = result.plan ? null : diagnose(c, pool, result.rejected);
  set((s) => ({
    constraints: c,
    pool,
    searching: false,
    plan: result.plan,
    alternates: result.alternates,
    checks: result.checks,
    trace: result.trace,
    considered: result.considered,
    relaxations: result.relaxations,
    shortfall,
    notice: result.plan
      ? null
      : shortfall
        ? `${shortfall.message} ${shortfall.suggestion}`
        : s.notice,
    // Any change to the plan invalidates a standing approval. Never let an
    // agent get approval for one evening and book a different one.
    approval:
      s.approval.status === "approved" || s.approval.status === "pending"
        ? { status: "idle" }
        : s.approval,
    revision: s.revision + 1,
  }));
}

/* ------------------------------------------------------ approval gate ---- */

type Deferred = { resolve: (v: { approved: boolean; note?: string; nonce?: string }) => void };
let pending: Deferred | null = null;

/**
 * Ask the human, in the page, with their thumb. Returns a promise the tool call
 * awaits. There is no timeout and no default. An unanswered request simply
 * never resolves, which is the correct behaviour for spending someone's money.
 */
export function requestApproval(
  plan: Plan,
  summary: string,
): Promise<{ approved: boolean; note?: string; nonce?: string }> {
  const id = `apr_${Math.random().toString(36).slice(2, 10)}`;
  set({
    approval: { status: "pending", id, summary, total: plan.total, plan, requestedAt: Date.now() },
  });
  return new Promise((resolve) => {
    pending = { resolve };
  });
}

export function resolveApproval(approved: boolean, note?: string) {
  const a = state.approval;
  if (a.status !== "pending") return;
  const nonce = approved ? `nonce_${Math.random().toString(36).slice(2, 12)}` : undefined;
  set({
    approval: approved
      ? {
          status: "approved",
          id: a.id,
          nonce: nonce!,
          plan: a.plan,
          at: Date.now(),
          ...(note ? { note } : {}),
        }
      : { status: "declined", id: a.id, at: Date.now(), ...(note ? { note } : {}) },
  });
  pending?.resolve({ approved, ...(note ? { note } : {}), ...(nonce ? { nonce } : {}) });
  pending = null;
}

/** A one-time token: consumed by book_approved_plan, never reusable. */
export function consumeApproval(
  nonce: string,
): { ok: true; plan: Plan; id: string } | { ok: false; error: string } {
  const a = state.approval;
  if (a.status !== "approved")
    return {
      ok: false,
      error:
        "No approved plan. Call request_approval first and wait for the human to confirm in the page.",
    };
  if (a.nonce !== nonce)
    return { ok: false, error: "Approval token does not match the approved plan." };
  set({ approval: { status: "idle" } });
  return { ok: true, plan: a.plan, id: a.id };
}

export function reset() {
  set({
    plan: null,
    alternates: [],
    checks: [],
    trace: [],
    booking: null,
    approval: { status: "idle" },
    calls: [],
    utterance: "",
    narration: [],
    notice: null,
    revision: state.revision + 1,
  });
}
