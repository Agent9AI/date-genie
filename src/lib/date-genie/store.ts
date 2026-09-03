/**
 * The shared table.
 *
 * A page-level store that BOTH the human UI and the agent's WebMCP tool calls
 * read and write. This is the whole thesis of WebMCP in one file: the agent is
 * not talking to a backend behind the user's back, it is sitting at the same
 * table, touching the same state, and the human watches it happen.
 *
 * Deliberately framework-free (a 40-line observable) so the tool layer never
 * imports React and can be lifted into any site.
 */
import { SEED_COUNTS, applyInventory, setHome } from "./data";
import { fetchLiveVenues, geocode, type Place } from "./live-venues";
import {
  DEFAULT_CONSTRAINTS,
  planWithRelaxation,
  type Relaxation,
  type Booking,
  type CheckRow,
  type Constraints,
  type Plan,
} from "./engine";

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
  | { status: "pending"; id: string; summary: string; total: number; plan: Plan; requestedAt: number }
  | { status: "approved"; id: string; nonce: string; note?: string; plan: Plan; at: number }
  | { status: "declined"; id: string; note?: string; at: number };

export type State = {
  constraints: Constraints;
  /** The request the human (or agent) last phrased in words. */
  utterance: string;
  plan: Plan | null;
  alternates: Plan[];
  checks: CheckRow[];
  trace: string[];
  considered: number;
  /** Constraints the planner had to widen, shown to the human verbatim. */
  relaxations: Relaxation[];
  calls: ToolCall[];
  approval: ApprovalState;
  booking: Booking | null;
  /** Preferences the genie has learned and will never violate again. */
  vetoes: string[];
  webmcp: { bound: boolean; surface: string; tools: string[]; agentSeen: boolean };
  /** Where the venue inventory came from, so nobody has to guess. */
  inventory: {
    source: "seed" | "openstreetmap";
    restaurants: number;
    parking: number;
    events: number;
    fetchedAt: number | null;
    loading: boolean;
    /** Set when a place was named but nothing usable came back. */
    notice: string | null;
  };
  /** Where the user says they are tonight. Drives every query and drive time. */
  place: Place;
  thinking: boolean;
  /** What the built-in demo agent is currently saying, newest last. */
  narration: string[];
  demoRunning: boolean;
  /** Bumped whenever a tool call changes the plan, to retrigger UI animations. */
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
  plan: null,
  alternates: [],
  checks: [],
  trace: [],
  considered: 0,
  relaxations: [],
  calls: [],
  approval: { status: "idle" },
  booking: null,
  vetoes: [],
  webmcp: { bound: false, surface: "none", tools: [], agentSeen: false },
  inventory: {
    source: "seed",
    restaurants: SEED_COUNTS.restaurants,
    parking: SEED_COUNTS.parking,
    events: SEED_COUNTS.events,
    fetchedAt: null,
    loading: false,
    notice: null,
  },
  place: { label: "Arlington, Virginia", at: { lat: 38.8816, lng: -77.1117 } },
  thinking: false,
  narration: [],
  demoRunning: false,
  revision: 0,
};

const listeners = new Set<() => void>();

export function getState(): State {
  return state;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function set(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const next = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

/** Vetoes live in localStorage so the genie still knows on your next visit. */
export function hydrate() {
  const vetoes = loadVetoes();
  set({ vetoes, constraints: { ...state.constraints, avoid: [...new Set([...state.constraints.avoid, ...vetoes])] } });
}

export function addVeto(term: string) {
  const t = term.trim().toLowerCase();
  if (!t || state.vetoes.includes(t)) return state.vetoes;
  const vetoes = [...state.vetoes, t];
  saveVetoes(vetoes);
  set({ vetoes, constraints: { ...state.constraints, avoid: [...new Set([...state.constraints.avoid, t])] } });
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

/** Re-run the planner against whatever the constraints currently are. */
export function replan(c: Constraints = state.constraints): void {
  const merged: Constraints = { ...c, avoid: [...new Set([...c.avoid, ...state.vetoes])] };
  const result = planWithRelaxation(merged);
  set((s) => ({
    constraints: merged,
    plan: result.plan,
    alternates: result.alternates,
    checks: result.checks,
    trace: result.trace,
    considered: result.considered,
    relaxations: result.relaxations,
    // Any change to the plan invalidates a standing approval. Never let an
    // agent get approval for a $164 night and then book a $400 one.
    approval: s.approval.status === "approved" || s.approval.status === "pending" ? { status: "idle" } : s.approval,
    revision: s.revision + 1,
  }));
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

/**
 * Pull the real Arlington venue list from OpenStreetMap and swap it in.
 * Silent no-op on failure: the curated seed inventory stays, and the badge
 * keeps saying "seed" rather than claiming a freshness the app does not have.
 */
export async function loadLiveInventory(place: Place = state.place): Promise<boolean> {
  set((s) => ({ inventory: { ...s.inventory, loading: true, notice: null } }));
  const live = await fetchLiveVenues(place);
  if (!live) {
    set((s) => ({
      inventory: {
        ...s.inventory,
        loading: false,
        notice: `Could not build an evening around ${place.label}. Showing the curated Arlington set instead.`,
      },
    }));
    return false;
  }
  applyInventory(live);
  setHome(place.at);
  set({
    place,
    inventory: {
      source: live.source,
      restaurants: live.restaurants.length,
      parking: live.parking.length,
      events: live.events.length,
      fetchedAt: live.fetchedAt,
      loading: false,
      notice: null,
    },
  });
  if (state.plan) replan(state.constraints);
  return true;
}

/**
 * Geocode a place name and reload every venue around it. This is what makes
 * the app work in Fredericksburg, or Lisbon, rather than one hardcoded city.
 */
export async function setLocation(query: string): Promise<{ ok: boolean; place?: Place; error?: string }> {
  set((s) => ({ inventory: { ...s.inventory, loading: true, notice: null } }));
  const place = await geocode(query);
  if (!place) {
    set((s) => ({ inventory: { ...s.inventory, loading: false, notice: `Could not find "${query}" on the map.` } }));
    return { ok: false, error: `Could not find "${query}". Try adding a state or country, e.g. "Fredericksburg, VA".` };
  }
  const ok = await loadLiveInventory(place);
  if (!ok) return { ok: false, place, error: `Found ${place.label}, but OpenStreetMap had too few venues nearby to compose an evening.` };
  return { ok: true, place };
}

/* ------------------------------------------------------ approval gate ---- */

type Deferred = { resolve: (v: { approved: boolean; note?: string; nonce?: string }) => void };
let pending: Deferred | null = null;

/**
 * Ask the human, in the page, with their thumb. Returns a promise the tool call
 * awaits. There is no timeout and no default. An unanswered request simply
 * never resolves, which is the correct behaviour for spending someone's money.
 */
export function requestApproval(plan: Plan, summary: string): Promise<{ approved: boolean; note?: string; nonce?: string }> {
  const id = `apr_${Math.random().toString(36).slice(2, 10)}`;
  set({ approval: { status: "pending", id, summary, total: plan.total, plan, requestedAt: Date.now() } });
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
      ? { status: "approved", id: a.id, nonce: nonce!, plan: a.plan, at: Date.now(), ...(note ? { note } : {}) }
      : { status: "declined", id: a.id, at: Date.now(), ...(note ? { note } : {}) },
  });
  pending?.resolve({ approved, ...(note ? { note } : {}), ...(nonce ? { nonce } : {}) });
  pending = null;
}

/** A one-time token: consumed by book_approved_plan, never reusable. */
export function consumeApproval(nonce: string): { ok: true; plan: Plan; id: string } | { ok: false; error: string } {
  const a = state.approval;
  if (a.status !== "approved") return { ok: false, error: "No approved plan. Call request_approval first and wait for the human to confirm in the page." };
  if (a.nonce !== nonce) return { ok: false, error: "Approval token does not match the approved plan." };
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
    revision: state.revision + 1,
  });
}
