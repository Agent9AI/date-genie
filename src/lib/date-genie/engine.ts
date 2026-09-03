import { EVENTS, PARKING, RESTAURANTS, type EventItem, type ParkingSpot, type Restaurant } from "./data";

export type Constraints = {
  budget: number;
  earliest: string;
  maxDriveMinutes: number;
  party: number;
  interests: string[];
  neighborhood?: string;
};

export const DEFAULT_CONSTRAINTS: Constraints = {
  budget: 180,
  earliest: "19:00",
  maxDriveMinutes: 20,
  party: 2,
  interests: [],
};

export const toMinutes = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export const fmtTime = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  const hour = (h ?? 0) % 12 === 0 ? 12 : (h ?? 0) % 12;
  return `${hour}:${String(m ?? 0).padStart(2, "0")} ${(h ?? 0) >= 12 ? "PM" : "AM"}`;
};

export const money = (n: number) => `$${n.toFixed(0)}`;

/* ---------- Tool primitives (the WebMCP surface) ---------- */

export function findRestaurants(input: {
  maxPricePerPerson?: number;
  maxDriveMinutes?: number;
  cuisine?: string;
  earliest?: string;
}): Restaurant[] {
  const { maxPricePerPerson = Infinity, maxDriveMinutes = 60, cuisine, earliest = "00:00" } = input;
  return RESTAURANTS.filter(
    (r) =>
      r.pricePerPerson <= maxPricePerPerson &&
      r.driveMinutes <= maxDriveMinutes &&
      (!cuisine || r.cuisine.toLowerCase().includes(cuisine.toLowerCase())) &&
      r.slots.some((s) => toMinutes(s) >= toMinutes(earliest)),
  ).sort((a, b) => b.rating - a.rating);
}

export function checkAvailability(input: { restaurantId: string; earliest?: string; party?: number }) {
  const r = RESTAURANTS.find((x) => x.id === input.restaurantId);
  if (!r) return { available: false, slots: [] as string[], reason: "Unknown restaurant" };
  const slots = r.slots.filter((s) => toMinutes(s) >= toMinutes(input.earliest ?? "00:00"));
  return { available: slots.length > 0, slots, party: input.party ?? 2 };
}

export function searchEvents(input: {
  category?: string;
  earliest?: string;
  maxPricePerTicket?: number;
  maxDriveMinutes?: number;
}): EventItem[] {
  const { category, earliest = "00:00", maxPricePerTicket = Infinity, maxDriveMinutes = 60 } = input;
  return EVENTS.filter(
    (e) =>
      (!category || e.category === category.toLowerCase()) &&
      toMinutes(e.start) >= toMinutes(earliest) &&
      e.pricePerTicket <= maxPricePerTicket &&
      e.driveMinutes <= maxDriveMinutes,
  ).sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
}

export function findParking(input: { neighborhood: string; maxWalkMinutes?: number }): ParkingSpot[] {
  return PARKING.filter(
    (p) =>
      p.neighborhood.toLowerCase() === input.neighborhood.toLowerCase() &&
      p.walkMinutes <= (input.maxWalkMinutes ?? 15),
  );
}

export type Plan = {
  id: string;
  dinner: { restaurant: Restaurant; time: string; cost: number };
  event: { event: EventItem; cost: number; walkMinutes: number };
  parking: { spot: ParkingSpot; cost: number };
  total: number;
  constraints: Constraints;
};

export function planDateNight(c: Constraints): { plan: Plan | null; log: string[] } {
  const log: string[] = [];
  const restaurants = findRestaurants({
    maxDriveMinutes: c.maxDriveMinutes,
    earliest: c.earliest,
    cuisine: c.interests.find((i) => RESTAURANTS.some((r) => r.cuisine.toLowerCase().includes(i))),
  });
  log.push(`findRestaurants() → ${restaurants.length} matches within ${c.maxDriveMinutes} min`);

  const events = searchEvents({ earliest: c.earliest, maxDriveMinutes: c.maxDriveMinutes });
  log.push(`searchEvents() → ${events.length} events after ${fmtTime(c.earliest)}`);

  let best: Plan | null = null;

  for (const r of restaurants) {
    const avail = checkAvailability({ restaurantId: r.id, earliest: c.earliest, party: c.party });
    if (!avail.available) continue;
    for (const time of avail.slots) {
      for (const e of events) {
        const walk = e.walkFrom[r.id];
        if (walk === undefined) continue; // must be walkable from dinner
        const gap = toMinutes(e.start) - toMinutes(time);
        if (gap < 75 || gap > 150) continue; // enough time to eat, not a dead hour
        const spots = findParking({ neighborhood: r.neighborhood, maxWalkMinutes: 8 });
        const spot = spots.sort((a, b) => a.priceForEvening - b.priceForEvening)[0];
        if (!spot) continue;

        const dinnerCost = r.pricePerPerson * c.party;
        const ticketCost = e.pricePerTicket * c.party;
        const total = dinnerCost + ticketCost + spot.priceForEvening;
        if (total > c.budget) continue;

        const interestBoost = c.interests.includes(e.category) ? 1.2 : 0;
        const score = r.rating + interestBoost - walk / 20 - total / c.budget;
        const candidate: Plan = {
          id: `${r.id}_${time}_${e.id}`,
          dinner: { restaurant: r, time, cost: dinnerCost },
          event: { event: e, cost: ticketCost, walkMinutes: walk },
          parking: { spot, cost: spot.priceForEvening },
          total,
          constraints: c,
        };
        const bestScore = best
          ? best.dinner.restaurant.rating +
            (c.interests.includes(best.event.event.category) ? 1.2 : 0) -
            best.event.walkMinutes / 20 -
            best.total / c.budget
          : -Infinity;
        if (score > bestScore) best = candidate;
      }
    }
  }

  if (best) {
    log.push(`findParking() → ${best.parking.spot.name}, ${best.parking.spot.walkMinutes} min walk`);
    log.push(`composed itinerary — total ${money(best.total)} of ${money(c.budget)}`);
  } else {
    log.push("no itinerary satisfies every constraint — loosen budget, time, or drive radius");
  }
  return { plan: best, log };
}

/* ---------- Reservation side effects ---------- */

export type Booking = {
  confirmation: string;
  planId: string;
  lines: { label: string; detail: string; cost: number }[];
  total: number;
  bookedAt: string;
};

const code = (prefix: string) =>
  `${prefix}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

export function reserveTable(input: { restaurantId: string; time: string; party: number }) {
  const r = RESTAURANTS.find((x) => x.id === input.restaurantId);
  if (!r) return { ok: false as const, error: "Unknown restaurant" };
  return { ok: true as const, confirmation: code("TBL"), restaurant: r.name, time: input.time, party: input.party };
}

export function reserveTickets(input: { eventId: string; quantity: number }) {
  const e = EVENTS.find((x) => x.id === input.eventId);
  if (!e) return { ok: false as const, error: "Unknown event" };
  return { ok: true as const, confirmation: code("TIX"), event: e.name, quantity: input.quantity, start: e.start };
}

export function reserveSpot(input: { parkingId: string; arriveBy: string }) {
  const p = PARKING.find((x) => x.id === input.parkingId);
  if (!p) return { ok: false as const, error: "Unknown lot" };
  return { ok: true as const, confirmation: code("PRK"), lot: p.name, arriveBy: input.arriveBy };
}

export function bookPlan(plan: Plan): Booking {
  const table = reserveTable({
    restaurantId: plan.dinner.restaurant.id,
    time: plan.dinner.time,
    party: plan.constraints.party,
  });
  const tickets = reserveTickets({ eventId: plan.event.event.id, quantity: plan.constraints.party });
  const parking = reserveSpot({ parkingId: plan.parking.spot.id, arriveBy: plan.dinner.time });

  return {
    confirmation: code("DG"),
    planId: plan.id,
    total: plan.total,
    bookedAt: new Date().toISOString(),
    lines: [
      {
        label: plan.dinner.restaurant.name,
        detail: `${fmtTime(plan.dinner.time)} · table for ${plan.constraints.party} · ${table.ok ? table.confirmation : "failed"}`,
        cost: plan.dinner.cost,
      },
      {
        label: plan.event.event.name,
        detail: `${fmtTime(plan.event.event.start)} · ${plan.constraints.party} tickets · ${tickets.ok ? tickets.confirmation : "failed"}`,
        cost: plan.event.cost,
      },
      {
        label: plan.parking.spot.name,
        detail: `arrive by ${fmtTime(plan.dinner.time)} · ${parking.ok ? parking.confirmation : "failed"}`,
        cost: plan.parking.cost,
      },
    ],
  };
}

/* ---------- Natural language constraint parsing ---------- */

export function parseRequest(text: string): Constraints {
  const t = text.toLowerCase();
  const c: Constraints = { ...DEFAULT_CONSTRAINTS, interests: [] };

  const budget = t.match(/(?:under|below|max|budget of|less than)\s*\$?\s*(\d{2,4})/) ?? t.match(/\$\s*(\d{2,4})/);
  if (budget?.[1]) c.budget = Number(budget[1]);

  const drive = t.match(/(\d{1,3})\s*(?:-|\s)?minute|(\d{1,3})\s*min/);
  if (drive) c.maxDriveMinutes = Number(drive[1] ?? drive[2]);

  const after = t.match(/(?:nothing before|after|not before|starting at)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (after?.[1]) {
    let h = Number(after[1]);
    const isPm = after[3] === "pm" || (!after[3] && h <= 11);
    if (isPm && h < 12) h += 12;
    c.earliest = `${String(h).padStart(2, "0")}:${after[2] ?? "00"}`;
  }

  const party = t.match(/(?:party of|table for|for)\s*(\d{1,2})\s*(?:people|of us)/);
  if (party?.[1]) c.party = Number(party[1]);

  for (const k of ["comedy", "music", "film", "class"]) if (t.includes(k)) c.interests.push(k);
  if (t.includes("movie") || t.includes("cinema")) c.interests.push("film");
  if (t.includes("jazz") || t.includes("concert") || t.includes("live music")) c.interests.push("music");
  if (t.includes("pottery") || t.includes("clay")) c.interests.push("class");
  for (const cuisine of ["korean", "seafood", "mexican", "indian", "steak", "japanese"])
    if (t.includes(cuisine)) c.interests.push(cuisine);

  return c;
}
