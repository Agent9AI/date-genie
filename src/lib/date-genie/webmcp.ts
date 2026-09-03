/**
 * WebMCP surface for Date Genie.
 *
 * Registers this page's capabilities as tools on `navigator.modelContext`
 * (the WebMCP browser proposal) so an in-browser agent can *execute* a date
 * night instead of recommending one. When the API is absent, the same tools
 * are mirrored on `window.dateGenie` so extensions and tests can call them.
 */
import {
  bookPlan,
  checkAvailability,
  findParking,
  findRestaurants,
  parseRequest,
  planDateNight,
  reserveSpot,
  reserveTable,
  reserveTickets,
  searchEvents,
  type Booking,
  type Plan,
} from "./engine";

export type ToolCallRecord = {
  id: string;
  name: string;
  args: unknown;
  at: number;
};

type ToolDescriptor = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<{ content: { type: "text"; text: string }[] }>;
};

type ModelContext = {
  registerTool?: (tool: ToolDescriptor) => unknown;
  provideContext?: (ctx: { tools: ToolDescriptor[] }) => unknown;
};

const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: props,
  required,
});
const num = (description: string) => ({ type: "number", description });
const str = (description: string) => ({ type: "string", description });

export type WebMcpHandlers = {
  onCall: (record: ToolCallRecord) => void;
  onPlan: (plan: Plan | null) => void;
  onBooking: (booking: Booking) => void;
  getPlan: () => Plan | null;
};

export function buildTools(h: WebMcpHandlers): ToolDescriptor[] {
  const wrap =
    (name: string, fn: (args: Record<string, unknown>) => unknown) =>
    async (args: Record<string, unknown> = {}) => {
      h.onCall({ id: `${name}-${Date.now()}-${Math.random()}`, name, args, at: Date.now() });
      const result = fn(args ?? {});
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    };

  return [
    {
      name: "search_events",
      description: "Search tonight's events (comedy, music, film, class) near Arlington, VA.",
      inputSchema: obj({
        category: str("comedy | music | film | class"),
        earliest: str("Earliest start time, 24h HH:MM"),
        maxPricePerTicket: num("Max ticket price in USD"),
        maxDriveMinutes: num("Max drive time from home"),
      }),
      execute: wrap("search_events", (a) => searchEvents(a as never)),
    },
    {
      name: "find_restaurants",
      description: "Find restaurants matching price, cuisine, drive time and earliest seating.",
      inputSchema: obj({
        cuisine: str("Cuisine keyword"),
        maxPricePerPerson: num("Max spend per person in USD"),
        maxDriveMinutes: num("Max drive time from home"),
        earliest: str("Earliest seating, 24h HH:MM"),
      }),
      execute: wrap("find_restaurants", (a) => findRestaurants(a as never)),
    },
    {
      name: "check_availability",
      description: "Check open reservation slots for a restaurant.",
      inputSchema: obj(
        { restaurantId: str("Restaurant id"), earliest: str("24h HH:MM"), party: num("Party size") },
        ["restaurantId"],
      ),
      execute: wrap("check_availability", (a) => checkAvailability(a as never)),
    },
    {
      name: "find_parking",
      description: "Find parking near a neighborhood with a short walk.",
      inputSchema: obj({ neighborhood: str("Neighborhood name"), maxWalkMinutes: num("Max walk") }, [
        "neighborhood",
      ]),
      execute: wrap("find_parking", (a) => findParking(a as never)),
    },
    {
      name: "plan_date_night",
      description:
        "The one-shot tool: give a natural-language request and get a single composed, bookable itinerary (dinner + event + parking) that satisfies every constraint.",
      inputSchema: obj({ request: str("e.g. 'Friday night under $180, Arlington, nothing before 7'") }, [
        "request",
      ]),
      execute: wrap("plan_date_night", (a) => {
        const constraints = parseRequest(String(a['request'] ?? ""));
        const { plan, log } = planDateNight(constraints);
        h.onPlan(plan);
        return { constraints, plan, log };
      }),
    },
    {
      name: "reserve_table",
      description: "Reserve a restaurant table. Side effect: creates a real booking.",
      inputSchema: obj({ restaurantId: str("id"), time: str("24h HH:MM"), party: num("Party size") }, [
        "restaurantId",
        "time",
      ]),
      execute: wrap("reserve_table", (a) => reserveTable({ party: 2, ...(a as never) })),
    },
    {
      name: "reserve_tickets",
      description: "Reserve event tickets. Side effect: creates a real booking.",
      inputSchema: obj({ eventId: str("id"), quantity: num("Ticket count") }, ["eventId"]),
      execute: wrap("reserve_tickets", (a) => reserveTickets({ quantity: 2, ...(a as never) })),
    },
    {
      name: "reserve_spot",
      description: "Reserve a parking spot for the evening.",
      inputSchema: obj({ parkingId: str("id"), arriveBy: str("24h HH:MM") }, ["parkingId"]),
      execute: wrap("reserve_spot", (a) => reserveSpot({ arriveBy: "19:00", ...(a as never) })),
    },
    {
      name: "book_current_plan",
      description: "Confirm the currently proposed itinerary: books table, tickets and parking in one call.",
      inputSchema: obj({}),
      execute: wrap("book_current_plan", () => {
        const plan = h.getPlan();
        if (!plan) return { ok: false, error: "No plan proposed yet. Call plan_date_night first." };
        const booking = bookPlan(plan);
        h.onBooking(booking);
        return { ok: true, booking };
      }),
    },
  ];
}

export function registerWebMcp(h: WebMcpHandlers): { available: boolean; toolNames: string[]; dispose: () => void } {
  const tools = buildTools(h);
  const nav = navigator as Navigator & { modelContext?: ModelContext };
  let available = false;

  try {
    const mc = nav.modelContext;
    if (mc?.registerTool) {
      tools.forEach((t) => mc.registerTool!(t));
      available = true;
    } else if (mc?.provideContext) {
      mc.provideContext({ tools });
      available = true;
    }
  } catch {
    available = false;
  }

  (window as unknown as Record<string, unknown>)['dateGenie'] = Object.fromEntries(
    tools.map((t) => [t.name, t.execute]),
  );

  return {
    available,
    toolNames: tools.map((t) => t.name),
    dispose: () => {
      delete (window as unknown as Record<string, unknown>)['dateGenie'];
    },
  };
}
