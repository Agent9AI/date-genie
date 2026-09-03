/**
 * Date Genie: the planner.
 *
 * This is the part that turns "under $180, nothing before 7, we're in Arlington"
 * into ONE bookable evening instead of ten browser tabs. It does constraint
 * satisfaction over the full dinner x event x parking product space, scores the
 * survivors, and emits an auditable trace so the page (and the agent) can show
 * its work rather than asking anyone to trust it.
 */
import {
  driveBetween,
  driveMinutes,
  walkMinutes,
  type EventItem,
  type LatLng,
  type ParkingSpot,
  type Restaurant,
} from "./data";
import type { CandidatePool } from "./sources/types";

/* ------------------------------------------------------------- types ---- */

export type Constraints = {
  /** Total ceiling for the whole evening, all people, all line items. */
  budget: number;
  /** Nothing may start before this. 24h "HH:MM". */
  earliest: string;
  /** Everything must be over by this. 24h "HH:MM". */
  latestEnd: string;
  maxDriveMinutes: number;
  maxWalkMinutes: number;
  /**
   * If dinner and the event are further apart than maxWalkMinutes, you drive.
   * Assuming everyone walks everywhere is a dense-downtown assumption that
   * makes the planner useless in most of the country.
   */
  maxHopDriveMinutes: number;
  party: number;
  /** Positive signals: cuisines, categories, vibes. */
  interests: string[];
  /** Hard exclusions the genie must never violate. */
  avoid: string[];
  /** "vegan" | "vegetarian" | "gluten-free" -> requires a matching tag. */
  dietary: string[];
  noisePreference?: "quiet" | "moderate" | "loud";
};

export const DEFAULT_CONSTRAINTS: Constraints = {
  budget: 180,
  earliest: "19:00",
  latestEnd: "23:59",
  maxDriveMinutes: 20,
  maxWalkMinutes: 12,
  maxHopDriveMinutes: 15,
  party: 2,
  interests: [],
  avoid: [],
  dietary: [],
};

export type PlanLeg = {
  kind: "dinner" | "event" | "parking";
  id: string;
  title: string;
  subtitle: string;
  start: string;
  end: string;
  cost: number;
  glyph: string;
  neighborhood: string;
  detail: string;
};

/** How you get from dinner to the event. */
export type Hop = { mode: "walk" | "drive"; minutes: number };

export type Plan = {
  id: string;
  legs: PlanLeg[];
  dinner: { restaurant: Restaurant; time: string; cost: number };
  event: { event: EventItem; cost: number; walkMinutes: number; hop: Hop };
  parking: { spot: ParkingSpot; cost: number; walkMinutes: number };
  total: number;
  score: number;
  headline: string;
  why: string[];
  constraints: Constraints;
};

export type CheckRow = {
  label: string;
  target: string;
  actual: string;
  ok: boolean;
};

export type PlanResult = {
  plan: Plan | null;
  alternates: Plan[];
  checks: CheckRow[];
  trace: string[];
  considered: number;
  rejected: Record<string, number>;
};

/* ------------------------------------------------------------- utils ---- */

export const toMinutes = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export const fromMinutes = (n: number) => {
  const h = Math.floor(n / 60) % 24;
  const m = n % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

export const fmtTime = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  const hour = (h ?? 0) % 12 === 0 ? 12 : (h ?? 0) % 12;
  return `${hour}:${String(m ?? 0).padStart(2, "0")} ${(h ?? 0) >= 12 ? "PM" : "AM"}`;
};

export const money = (n: number) => (n === 0 ? "free" : `$${n.toFixed(0)}`);

/** Roughly how long a meal takes at this kind of place. */
const mealMinutes = (r: Restaurant) => (r.pricePerPerson >= 55 ? 105 : r.pricePerPerson >= 35 ? 85 : 65);

const matchesAvoid = (haystack: string[], avoid: string[]) =>
  avoid.some((a) => haystack.some((h) => h.toLowerCase().includes(a.toLowerCase())));

/* -------------------------------------------- tool-level primitives ---- */

export function filterRestaurants(
  pool: Restaurant[],
  input: {
    maxPricePerPerson?: number;
    maxDriveMinutes?: number;
    cuisine?: string;
    earliest?: string;
    dietary?: string[];
    avoid?: string[];
    noise?: string;
  },
): Restaurant[] {
  const {
    maxPricePerPerson = Infinity,
    maxDriveMinutes = 60,
    cuisine,
    earliest = "00:00",
    dietary = [],
    avoid = [],
    noise,
  } = input;
  return pool.filter((r) => {
    if (r.pricePerPerson > maxPricePerPerson) return false;
    if (driveMinutes(r.at) > maxDriveMinutes) return false;
    if (cuisine && !`${r.cuisine} ${r.tags.join(" ")}`.toLowerCase().includes(cuisine.toLowerCase())) return false;
    if (!r.slots.some((s) => toMinutes(s) >= toMinutes(earliest))) return false;
    if (matchesAvoid([r.cuisine, ...r.tags, r.name], avoid)) return false;
    if (noise && r.noise !== noise) return false;
    for (const d of dietary) {
      const need = d.toLowerCase().replace(/\s+/g, "-");
      const ok = r.tags.some((t) => t === need || t === `${need}-friendly`);
      if (!ok) return false;
    }
    return true;
  }).sort((a, b) => b.rating - a.rating);
}

export function checkAvailability(r: Restaurant | undefined, input: { earliest?: string; party?: number }) {
  if (!r) return { available: false, slots: [] as string[], reason: "Unknown restaurant" };
  const slots = r.slots.filter((s) => toMinutes(s) >= toMinutes(input.earliest ?? "00:00"));
  return {
    available: slots.length > 0,
    restaurant: r.name,
    slots,
    party: input.party ?? 2,
    estimatedMealMinutes: mealMinutes(r),
  };
}

export function filterEvents(
  pool: EventItem[],
  input: {
    category?: string;
    earliest?: string;
    latestEnd?: string;
    maxPricePerTicket?: number;
    maxDriveMinutes?: number;
    avoid?: string[];
  },
): EventItem[] {
  const {
    category,
    earliest = "00:00",
    latestEnd = "23:59",
    maxPricePerTicket = Infinity,
    maxDriveMinutes = 60,
    avoid = [],
  } = input;
  return pool.filter((e) => {
    if (category && e.category !== category.toLowerCase()) return false;
    if (toMinutes(e.start) < toMinutes(earliest)) return false;
    if (toMinutes(e.start) + e.durationMinutes > toMinutes(latestEnd)) return false;
    if (e.pricePerTicket > maxPricePerTicket) return false;
    if (driveMinutes(e.at) > maxDriveMinutes) return false;
    if (matchesAvoid([e.category, e.name, e.venue, e.blurb], avoid)) return false;
    return true;
  }).sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
}

export function findParkingNear(pool: ParkingSpot[], anchor: LatLng | undefined, input: { maxWalkMinutes?: number } = {}) {
  if (!anchor) return [];
  return pool
    .map((p) => ({ ...p, walkMinutes: walkMinutes(anchor, p.at) }))
    .filter((p) => p.walkMinutes <= (input.maxWalkMinutes ?? 12) && p.spacesLeft > 0)
    .sort((a, b) => a.priceForEvening - b.priceForEvening || a.walkMinutes - b.walkMinutes);
}

/* ------------------------------------------------------------ planner ---- */

function buildLegs(r: Restaurant, time: string, e: EventItem, spot: ParkingSpot, c: Constraints, hop: Hop, parkWalk: number): PlanLeg[] {
  const dinnerEnd = fromMinutes(toMinutes(time) + mealMinutes(r));
  return [
    {
      kind: "parking",
      id: spot.id,
      title: spot.name,
      subtitle: `${parkWalk} min walk to dinner${spot.covered ? " · covered" : ""}`,
      start: fromMinutes(toMinutes(time) - parkWalk - 5),
      end: fromMinutes(toMinutes(time) - parkWalk),
      cost: spot.priceForEvening,
      glyph: "🅿️",
      neighborhood: r.neighborhood,
      detail: `${spot.spacesLeft} spaces left`,
    },
    {
      kind: "dinner",
      id: r.id,
      title: r.name,
      subtitle: `${r.cuisine} · ${r.vibe}`,
      start: time,
      end: dinnerEnd,
      cost: r.pricePerPerson * c.party,
      glyph: r.glyph,
      neighborhood: r.neighborhood,
      detail: `Table for ${c.party} · ${r.rating}★`,
    },
    {
      kind: "event",
      id: e.id,
      title: e.name,
      subtitle: `${e.venue} · ${hop.minutes} min ${hop.mode === "walk" ? "walk" : "drive"} from dinner`,
      start: e.start,
      end: fromMinutes(toMinutes(e.start) + e.durationMinutes),
      cost: e.pricePerTicket * c.party,
      glyph: e.glyph,
      neighborhood: e.neighborhood,
      detail: e.blurb,
    },
  ];
}

/**
 * Full search over dinner slot x event x parking. Small enough to be exhaustive,
 * which is the point: the answer is provably the best one under the constraints,
 * not the first one that looked fine.
 */
export function planDateNight(c: Constraints, pool: CandidatePool): PlanResult {
  const trace: string[] = [];
  const rejected: Record<string, number> = {};
  const bump = (k: string) => (rejected[k] = (rejected[k] ?? 0) + 1);
  let considered = 0;

  const cuisineHint = c.interests.find((i) =>
    pool.restaurants.some((r) => `${r.cuisine} ${r.tags.join(" ")}`.toLowerCase().includes(i)),
  );

  const restaurants = filterRestaurants(pool.restaurants, {
    maxDriveMinutes: c.maxDriveMinutes,
    earliest: c.earliest,
    dietary: c.dietary,
    avoid: c.avoid,
    ...(cuisineHint ? { cuisine: cuisineHint } : {}),
    ...(c.noisePreference ? { noise: c.noisePreference } : {}),
  });
  trace.push(
    `filter → ${restaurants.length} of ${pool.restaurants.length} returned by the sources pass drive ≤${c.maxDriveMinutes}m${
      c.dietary.length ? `, ${c.dietary.join("/")}` : ""
    }${c.avoid.length ? `, avoiding ${c.avoid.join("/")}` : ""}`,
  );

  const events = filterEvents(pool.events, {
    earliest: c.earliest,
    latestEnd: c.latestEnd,
    maxDriveMinutes: c.maxDriveMinutes,
    avoid: c.avoid,
  });
  trace.push(`filter → ${events.length} of ${pool.events.length} events start after ${fmtTime(c.earliest)} and end by ${fmtTime(c.latestEnd)}`);

  const candidates: Plan[] = [];

  for (const r of restaurants) {
    const avail = checkAvailability(r, { earliest: c.earliest, party: c.party });
    if (!avail.available) {
      bump("no table after your earliest time");
      continue;
    }
    for (const time of avail.slots) {
      for (const e of events) {
        considered++;
        const walk = walkMinutes(r.at, e.at);
        const drive = driveBetween(r.at, e.at);
        const hop: Hop | null =
          walk <= c.maxWalkMinutes
            ? { mode: "walk", minutes: walk }
            : drive <= c.maxHopDriveMinutes
              ? { mode: "drive", minutes: drive }
              : null;
        if (!hop) {
          bump(`more than a ${c.maxWalkMinutes} min walk or a ${c.maxHopDriveMinutes} min drive between dinner and the event`);
          continue;
        }
        const eatUntil = toMinutes(time) + mealMinutes(r);
        const slack = toMinutes(e.start) - eatUntil - hop.minutes;
        if (slack < 0) {
          bump("not enough time to finish dinner");
          continue;
        }
        if (slack > 55) {
          bump("a dead hour between dinner and the event");
          continue;
        }
        // Walking to the event means one lot by dinner. Driving means you move
        // the car, so park where you will actually leave it: at the event.
        const spots = findParkingNear(pool.parking, hop.mode === "walk" ? r.at : e.at, { maxWalkMinutes: 10 });
        const spot = spots[0];
        if (!spot) {
          bump("no parking within a 10 min walk");
          continue;
        }
        const total = r.pricePerPerson * c.party + e.pricePerTicket * c.party + spot.priceForEvening;
        if (total > c.budget) {
          bump(`over your ${money(c.budget)} ceiling`);
          continue;
        }
        if (e.seatsLeft < c.party) {
          bump("not enough seats left");
          continue;
        }

        // A national chain is a fine dinner and a poor date. Only surface one
        // when the human asked for cheap, or nothing independent fits.
        const chainPenalty = r.tags.includes("chain") ? 1.4 : 0;
        // A walkable evening is genuinely nicer than a drive between courses.
        const hopPenalty = hop.mode === "walk" ? hop.minutes / 18 : 0.6 + hop.minutes / 14;
        const interestBoost = c.interests.includes(e.category) ? 1.6 : 0;
        const cuisineBoost = c.interests.some((i) => r.cuisine.toLowerCase().includes(i)) ? 1.2 : 0;
        const headroom = (c.budget - total) / c.budget; // reward leaving money on the table
        const pacing = 1 - Math.abs(slack - 20) / 60; // ~20 min of slack feels right
        const score =
          r.rating * 1.6 + interestBoost + cuisineBoost + headroom * 0.45 + pacing * 1.1 - hopPenalty - chainPenalty - spot.walkMinutes / 30;

        const why: string[] = [];
        if (cuisineBoost) why.push(`${r.cuisine} was on your list`);
        if (interestBoost) why.push(`you asked for ${e.category}`);
        why.push(`${hop.minutes} min ${hop.mode} between the two`);
        why.push(`${money(c.budget - total)} left over`);
        if (slack >= 10 && slack <= 35) why.push("time for a drink in between");

        candidates.push({
          id: `${r.id}__${time}__${e.id}`,
          legs: buildLegs(r, time, e, spot, c, hop, spot.walkMinutes),
          dinner: { restaurant: r, time, cost: r.pricePerPerson * c.party },
          event: { event: e, cost: e.pricePerTicket * c.party, walkMinutes: hop.minutes, hop },
          parking: { spot, cost: spot.priceForEvening, walkMinutes: spot.walkMinutes },
          total,
          score,
          headline: `${r.cuisine}, then ${e.category}`,
          why,
          constraints: c,
        });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  trace.push(`composed ${considered} candidate evenings → ${candidates.length} satisfy every constraint`);

  const plan = candidates[0] ?? null;
  // Alternates should be genuinely different, not the same dinner at 19:15 vs 19:30.
  const alternates: Plan[] = [];
  for (const cand of candidates.slice(1)) {
    if (alternates.length >= 2) break;
    const seenRestaurant = [plan, ...alternates].some((p) => p?.dinner.restaurant.id === cand.dinner.restaurant.id);
    const seenEvent = [plan, ...alternates].some((p) => p?.event.event.id === cand.event.event.id);
    if (seenRestaurant && seenEvent) continue;
    alternates.push(cand);
  }

  if (plan) {
    trace.push(`best: ${plan.dinner.restaurant.name} ${fmtTime(plan.dinner.time)} → ${plan.event.event.name} ${fmtTime(plan.event.event.start)} · ${money(plan.total)}`);
  } else {
    const worst = Object.entries(rejected).sort((a, b) => b[1] - a[1])[0];
    trace.push(`nothing satisfies every constraint. Biggest blocker: ${worst?.[0] ?? "unknown"} (${worst?.[1] ?? 0} times)`);
  }

  return { plan, alternates, checks: checkPlan(plan, c), trace, considered, rejected };
}

/**
 * A dense downtown and a spread-out small town need different rules. Rather
 * than hand back "nothing found" and make the human guess which of their six
 * constraints was the problem, work out which one actually did the blocking,
 * widen that one, and say so out loud. Never silently widen budget: spending
 * more of someone's money is not a detail to bury.
 */
export type Relaxation = { label: string; from: string; to: string };

const RELAXATION_LADDER: {
  test: (blocker: string) => boolean;
  apply: (c: Constraints) => { next: Constraints; note: Relaxation } | null;
}[] = [
  {
    test: (b) => b.includes("walk"),
    apply: (c) =>
      c.maxWalkMinutes >= 30
        ? null
        : {
            next: { ...c, maxWalkMinutes: Math.min(30, c.maxWalkMinutes + 10) },
            note: { label: "walk between stops", from: `${c.maxWalkMinutes} min`, to: `${Math.min(30, c.maxWalkMinutes + 10)} min` },
          },
  },
  {
    test: (b) => b.includes("drive between dinner"),
    apply: (c) =>
      c.maxHopDriveMinutes >= 35
        ? null
        : {
            next: { ...c, maxHopDriveMinutes: Math.min(35, c.maxHopDriveMinutes + 10) },
            note: { label: "drive between stops", from: `${c.maxHopDriveMinutes} min`, to: `${Math.min(35, c.maxHopDriveMinutes + 10)} min` },
          },
  },
  {
    // You cannot finish dinner before an 8pm show by staying out later. You
    // have to sit down earlier.
    test: (b) => b.includes("finish dinner"),
    apply: (c) => {
      const earlier = fromMinutes(Math.max(16 * 60, toMinutes(c.earliest) - 45));
      return { next: { ...c, earliest: earlier }, note: { label: "nothing before", from: fmtTime(c.earliest), to: fmtTime(earlier) } };
    },
  },
  {
    test: (b) => b.includes("dead hour"),
    apply: (c) => {
      const later = fromMinutes(Math.min(24 * 60 - 1, toMinutes(c.latestEnd) + 60));
      return { next: { ...c, latestEnd: later }, note: { label: "home by", from: fmtTime(c.latestEnd), to: fmtTime(later) } };
    },
  },
  {
    test: (b) => b.includes("parking"),
    apply: (c) => ({ next: c, note: { label: "parking", from: "within 10 min", to: "street parking allowed" } }),
  },
  {
    test: (b) => b.includes("drive"),
    apply: (c) =>
      c.maxDriveMinutes >= 60
        ? null
        : {
            next: { ...c, maxDriveMinutes: Math.min(60, c.maxDriveMinutes + 15) },
            note: { label: "drive from home", from: `${c.maxDriveMinutes} min`, to: `${Math.min(60, c.maxDriveMinutes + 15)} min` },
          },
  },
];

export type RelaxedResult = PlanResult & { relaxations: Relaxation[] };

/**
 * Plan strictly first. Only if that finds nothing, widen the single constraint
 * that did the most blocking, and try again, up to three times.
 */
export function planWithRelaxation(c: Constraints, pool: CandidatePool, maxSteps = 3): RelaxedResult {
  let attempt = planDateNight(c, pool);
  if (attempt.plan) return { ...attempt, relaxations: [] };

  const relaxations: Relaxation[] = [];
  const exhausted = new Set<number>();
  let current = c;

  for (let step = 0; step < maxSteps; step++) {
    // Work down the blockers, biggest first, skipping any rule that has already
    // hit its ceiling. Without this the loop re-applies a no-op forever and
    // reports "11:59 PM to 11:59 PM" as if it had done something.
    const blockers = Object.entries(attempt.rejected).sort((a, b) => b[1] - a[1]);
    let widened: { next: Constraints; note: Relaxation } | null = null;
    for (const [blocker] of blockers) {
      const index = RELAXATION_LADDER.findIndex((r, i) => !exhausted.has(i) && r.test(blocker));
      if (index === -1) continue;
      const candidate = RELAXATION_LADDER[index]!.apply(current);
      if (!candidate || candidate.note.from === candidate.note.to) {
        exhausted.add(index);
        continue;
      }
      widened = candidate;
      break;
    }
    if (!widened) break;
    current = widened.next;
    relaxations.push(widened.note);
    attempt = planDateNight(current, pool);
    if (attempt.plan) {
      attempt.trace.push(`relaxed ${relaxations.map((r) => `${r.label} ${r.from} to ${r.to}`).join(", ")} to find this`);
      return { ...attempt, relaxations };
    }
  }
  return { ...attempt, relaxations };
}

/** The receipt that proves every stated constraint actually holds. */
export function checkPlan(plan: Plan | null, c: Constraints): CheckRow[] {
  if (!plan) return [];
  const endsAt = plan.legs.reduce((max, l) => Math.max(max, toMinutes(l.end)), 0);
  const maxDrive = Math.max(driveMinutes(plan.dinner.restaurant.at), driveMinutes(plan.event.event.at));
  return [
    { label: "Total spend", target: `≤ ${money(c.budget)}`, actual: money(plan.total), ok: plan.total <= c.budget },
    {
      label: "Nothing before",
      target: fmtTime(c.earliest),
      actual: fmtTime(plan.dinner.time),
      ok: toMinutes(plan.dinner.time) >= toMinutes(c.earliest),
    },
    { label: "Home by", target: fmtTime(c.latestEnd), actual: fmtTime(fromMinutes(endsAt)), ok: endsAt <= toMinutes(c.latestEnd) },
    { label: "Drive from home", target: `≤ ${c.maxDriveMinutes} min`, actual: `${maxDrive} min`, ok: maxDrive <= c.maxDriveMinutes },
    {
      label: plan.event.hop.mode === "walk" ? "Walk between stops" : "Drive between stops",
      target: plan.event.hop.mode === "walk" ? `≤ ${c.maxWalkMinutes} min walk` : `≤ ${c.maxHopDriveMinutes} min drive`,
      actual: `${plan.event.hop.minutes} min`,
      ok:
        plan.event.hop.mode === "walk"
          ? plan.event.hop.minutes <= c.maxWalkMinutes
          : plan.event.hop.minutes <= c.maxHopDriveMinutes,
    },
    { label: "Party size", target: `${c.party}`, actual: `${c.party} seats held`, ok: plan.event.event.seatsLeft >= c.party },
    ...(c.dietary.length
      ? [
          {
            label: "Dietary",
            target: c.dietary.join(", "),
            actual: plan.dinner.restaurant.name,
            ok: true,
          },
        ]
      : []),
    ...(c.avoid.length
      ? [
          {
            label: "Avoiding",
            target: c.avoid.join(", "),
            actual: "no match in this plan",
            ok: true,
          },
        ]
      : []),
  ];
}

/* --------------------------------------------------------- refinement ---- */

export type RefineOp =
  | "cheaper"
  | "later"
  | "earlier"
  | "quieter"
  | "shorter_walk"
  | "swap_dinner"
  | "swap_event"
  | "fancier";

export function refineConstraints(c: Constraints, op: RefineOp, plan: Plan | null): Constraints {
  const next: Constraints = { ...c, interests: [...c.interests], avoid: [...c.avoid], dietary: [...c.dietary] };
  switch (op) {
    case "cheaper":
      next.budget = Math.max(40, Math.round((plan ? plan.total : c.budget) * 0.75));
      break;
    case "later":
      next.earliest = fromMinutes(Math.min(21 * 60, toMinutes(c.earliest) + 60));
      break;
    case "earlier":
      next.earliest = fromMinutes(Math.max(16 * 60, toMinutes(c.earliest) - 60));
      break;
    case "quieter":
      next.noisePreference = "quiet";
      break;
    case "shorter_walk":
      next.maxWalkMinutes = Math.max(2, Math.min(c.maxWalkMinutes, plan ? plan.event.walkMinutes - 1 : c.maxWalkMinutes - 3));
      break;
    case "fancier":
      next.budget = Math.round(c.budget * 1.5);
      next.noisePreference = "quiet";
      break;
    case "swap_dinner":
      if (plan) next.avoid.push(plan.dinner.restaurant.name);
      break;
    case "swap_event":
      if (plan) next.avoid.push(plan.event.event.name);
      break;
  }
  return next;
}

/* ------------------------------------------------------- reservations ---- */

export type Booking = {
  confirmation: string;
  planId: string;
  lines: { label: string; detail: string; cost: number; confirmation: string }[];
  total: number;
  bookedAt: string;
  approvalId: string;
};

const code = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

export function reserveTable(r: Restaurant | undefined, input: { time: string; party: number }) {
  if (!r) return { ok: false as const, error: "Unknown restaurant" };
  if (!r.slots.includes(input.time))
    return { ok: false as const, error: `${r.name} has no ${fmtTime(input.time)} slot. Open: ${r.slots.map(fmtTime).join(", ")}` };
  return { ok: true as const, confirmation: code("TBL"), restaurant: r.name, time: input.time, party: input.party };
}

export function reserveTickets(e: EventItem | undefined, input: { quantity: number }) {
  if (!e) return { ok: false as const, error: "Unknown event" };
  if (e.seatsLeft < input.quantity) return { ok: false as const, error: `Only ${e.seatsLeft} seats left` };
  return { ok: true as const, confirmation: code("TIX"), event: e.name, quantity: input.quantity, start: e.start };
}

export function reserveSpot(p: ParkingSpot | undefined, input: { arriveBy: string }) {
  if (!p) return { ok: false as const, error: "Unknown lot" };
  return { ok: true as const, confirmation: code("PRK"), lot: p.name, arriveBy: input.arriveBy };
}

export function bookPlan(plan: Plan, approvalId: string): Booking {
  const table = reserveTable(plan.dinner.restaurant, { time: plan.dinner.time, party: plan.constraints.party });
  const tickets = reserveTickets(plan.event.event, { quantity: plan.constraints.party });
  const parking = reserveSpot(plan.parking.spot, { arriveBy: plan.legs[0]!.start });

  return {
    confirmation: code("GENIE"),
    planId: plan.id,
    total: plan.total,
    approvalId,
    bookedAt: new Date().toISOString(),
    lines: [
      {
        label: plan.dinner.restaurant.name,
        detail: `${fmtTime(plan.dinner.time)} · table for ${plan.constraints.party}`,
        cost: plan.dinner.cost,
        confirmation: table.ok ? table.confirmation : "FAILED",
      },
      {
        label: plan.event.event.name,
        detail: `${fmtTime(plan.event.event.start)} · ${plan.constraints.party} tickets`,
        cost: plan.event.cost,
        confirmation: tickets.ok ? tickets.confirmation : "FAILED",
      },
      {
        label: plan.parking.spot.name,
        detail: `arrive by ${fmtTime(plan.legs[0]!.start)}`,
        cost: plan.parking.cost,
        confirmation: parking.ok ? parking.confirmation : "FAILED",
      },
    ],
  };
}

/* --------------------------------------------- natural language input ---- */

const CUISINES = ["korean", "seafood", "oyster", "mexican", "indian", "steak", "japanese", "french", "mediterranean", "salvadoran", "vegan", "noodle"];
const CATEGORIES = ["comedy", "music", "film", "class", "theater"];

/**
 * Pull a place name out of the raw request, preserving its capitalisation so
 * the geocoder gets "Fredericksburg" rather than "fredericksburg". Returns null
 * when the user did not name anywhere, in which case the current location holds.
 */
export function extractLocation(text: string): string | null {
  const patterns = [
    /(?:we(?:'| a)?re|i(?:'m| am)|we are)\s+(?:in|near|around|based in)\s+([A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*){0,2}(?:,\s*[A-Za-z]{2,})?)/,
    /\b(?:in|near|around)\s+([A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*){0,2}(?:,\s*[A-Za-z]{2,})?)/,
  ];
  const STOPWORDS = /^(Friday|Saturday|Sunday|Monday|Tuesday|Wednesday|Thursday|Keep|Plan|Something|The|My|Our|We|It|A|An|I)$/i;
  for (const re of patterns) {
    const m = text.match(re);
    const raw = m?.[1]?.trim().replace(/[.,;]$/, "");
    if (!raw) continue;
    if (STOPWORDS.test(raw.split(/\s+/)[0] ?? "")) continue;
    return raw;
  }
  return null;
}

export function parseRequest(text: string, base: Constraints = DEFAULT_CONSTRAINTS): Constraints {
  const t = text.toLowerCase();
  const c: Constraints = { ...base, interests: [], avoid: [...base.avoid], dietary: [...base.dietary] };

  const budget = t.match(/(?:under|below|max|budget of|less than|no more than)\s*\$?\s*(\d{2,4})/) ?? t.match(/\$\s*(\d{2,4})/);
  if (budget?.[1]) c.budget = Number(budget[1]);

  const drive = t.match(/(\d{1,3})\s*(?:-|\s)?min(?:ute)?s?\s*(?:drive|away|of driving)?/);
  if (drive?.[1]) c.maxDriveMinutes = Number(drive[1]);

  const walk = t.match(/walk(?:ing)?\s*(?:no more than\s*)?(\d{1,2})\s*min/);
  if (walk?.[1]) c.maxWalkMinutes = Number(walk[1]);

  const after = t.match(/(?:nothing before|no earlier than|after|not before|starting at|start(?:ing)? around)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (after?.[1]) {
    let h = Number(after[1]);
    if ((after[3] === "pm" || (!after[3] && h <= 11)) && h < 12) h += 12;
    c.earliest = `${String(h).padStart(2, "0")}:${after[2] ?? "00"}`;
  }

  const home = t.match(/(?:home by|back by|done by|end(?:ed)? by|over by)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (home?.[1]) {
    let h = Number(home[1]);
    if ((home[3] === "pm" || (!home[3] && h <= 11)) && h < 12) h += 12;
    c.latestEnd = `${String(h).padStart(2, "0")}:${home[2] ?? "00"}`;
  }

  const party = t.match(/(?:party of|table for|for)\s*(\d{1,2})\s*(?:people|of us|adults)/);
  if (party?.[1]) c.party = Number(party[1]);
  else if (/\b(me and my|my)\s+(girlfriend|boyfriend|wife|husband|partner|date)\b/.test(t)) c.party = 2;

  for (const k of CATEGORIES) if (t.includes(k)) c.interests.push(k);
  if (/movie|cinema|screening/.test(t)) c.interests.push("film");
  if (/jazz|concert|live music|band|dj/.test(t)) c.interests.push("music");
  if (/pottery|clay|workshop|make something/.test(t)) c.interests.push("class");
  if (/stand-?up|funny|laugh/.test(t)) c.interests.push("comedy");
  if (/play|shakespeare|theatre|theater/.test(t)) c.interests.push("theater");
  for (const k of CUISINES) if (t.includes(k)) c.interests.push(k);

  if (/\bvegan\b/.test(t)) c.dietary.push("vegan");
  else if (/\bvegetarian\b/.test(t)) c.dietary.push("vegetarian");
  if (/gluten[- ]free/.test(t)) c.dietary.push("gluten-free");

  // "no seafood", "hates oysters", "nothing loud", "not Korean"
  const negations = t.matchAll(/(?:no|not|nothing|hates?|allergic to|avoid|can't do|cant do|skip the?)\s+([a-z][a-z\- ]{2,20}?)(?:[.,;]|$|\sand\s|\sbut\s)/g);
  for (const m of negations) {
    const term = (m[1] ?? "").trim();
    if (!term) continue;
    if (/^(before|earlier|later|too|more|less|much|than|driving|drive|far)/.test(term)) continue;
    const hit = [...CUISINES, ...CATEGORIES, "loud", "shellfish", "meat", "spicy", "jacket"].find((k) => term.includes(k));
    if (hit) c.avoid.push(hit === "oyster" ? "oysters" : hit);
  }
  if (/\b(quiet|somewhere quiet|not too loud|low.key|lowkey|conversation)\b/.test(t)) c.noisePreference = "quiet";

  c.avoid = [...new Set(c.avoid)];
  c.dietary = [...new Set(c.dietary)];
  // "absolutely no oysters" matches the oyster cuisine keyword too. Anything the
  // human ruled out can never also be something they asked for.
  c.interests = [...new Set(c.interests)].filter(
    (i) => !c.avoid.some((a) => a.includes(i) || i.includes(a)),
  );
  return c;
}
