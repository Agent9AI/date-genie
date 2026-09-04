/**
 * The last tap.
 *
 * Date Genie can plan an evening completely and cannot book it, because no
 * restaurant, ticketing or parking site exposes WebMCP tools for an agent to
 * call. Pretending otherwise with a fake confirmation code is the least useful
 * thing this app could do at the exact moment it has been most useful.
 *
 * So instead of a dead end, every leg gets a real link to the real place where
 * a human finishes the job: the restaurant's own reservation page when we know
 * it, its Google Maps entry when we do not, the venue's ticket search, the
 * parking lot on a map. One tap each, in the order you need them.
 *
 * When the providers in sources/registry.ts ship WebMCP tools, these links are
 * exactly what gets replaced by real calls. Until then this is the honest
 * version of "booked".
 */
import { fmtTime, type Plan } from "./engine";

export type HandoffLink = {
  kind: "dinner" | "event" | "parking" | "calendar";
  label: string;
  detail: string;
  href: string;
  /** What a human is actually expected to do on the other end. */
  action: string;
};

const q = (s: string) => encodeURIComponent(s);

/** Google Maps place search. Works for anywhere on earth with a name. */
const mapsSearch = (name: string, at: { lat: number; lng: number }) =>
  `https://www.google.com/maps/search/?api=1&query=${q(name)}&query_place_id=&center=${at.lat},${at.lng}`;

/**
 * OpenTable's public search accepts a term and a datetime, which is enough to
 * land someone on the right restaurant with the right party size preselected.
 * If it is not on OpenTable they get a search page rather than a broken link,
 * which is still better than a fabricated confirmation number.
 */
function reservationLink(name: string, time: string, party: number): string {
  return `https://www.opentable.com/s?term=${q(name)}&covers=${party}&dateTime=${q(`${new Date().toISOString().slice(0, 10)}T${time}`)}`;
}

/** Ticket search for a named venue. */
const ticketLink = (venue: string) =>
  `https://www.google.com/search?q=${q(`${venue} tickets tonight`)}`;

export function buildHandoff(plan: Plan): HandoffLink[] {
  const party = plan.constraints.party;
  const links: HandoffLink[] = [];

  if (plan.parking) {
    links.push({
      kind: "parking",
      label: plan.parking.spot.name,
      detail: `Arrive by ${fmtTime(plan.legs[0]!.start)}, ${plan.parking.walkMinutes} min walk`,
      href: mapsSearch(plan.parking.spot.name, plan.parking.spot.at),
      action: "Open in Maps",
    });
  }

  links.push({
    kind: "dinner",
    label: plan.dinner.restaurant.name,
    detail: `${fmtTime(plan.dinner.time)}, table for ${party}`,
    href: reservationLink(plan.dinner.restaurant.name, plan.dinner.time, party),
    action: "Reserve on OpenTable",
  });

  links.push({
    kind: "dinner",
    label: `${plan.dinner.restaurant.name} on Maps`,
    detail: "Phone number, hours, and directions",
    href: mapsSearch(plan.dinner.restaurant.name, plan.dinner.restaurant.at),
    action: "Open in Maps",
  });

  links.push({
    kind: "event",
    label: plan.event.event.venue,
    detail: `${fmtTime(plan.event.event.start)}, ${party} tickets`,
    href: ticketLink(plan.event.event.venue),
    action: "Find tickets",
  });

  return links;
}

/** A single line an agent can read out, or a human can paste into a message. */
export function handoffSummary(plan: Plan): string {
  const parts = [
    plan.parking ? `park at ${plan.parking.spot.name} by ${fmtTime(plan.legs[0]!.start)}` : null,
    `${plan.dinner.restaurant.name} at ${fmtTime(plan.dinner.time)}`,
    `${plan.event.event.venue} at ${fmtTime(plan.event.event.start)}`,
  ].filter(Boolean);
  return parts.join(", then ");
}
