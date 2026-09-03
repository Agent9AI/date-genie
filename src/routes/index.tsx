import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarHeart,
  Car,
  CheckCircle2,
  Clock,
  Footprints,
  Sparkles,
  Ticket,
  UtensilsCrossed,
  Wand2,
} from "lucide-react";
import {
  bookPlan,
  fmtTime,
  money,
  parseRequest,
  planDateNight,
  type Booking,
  type Constraints,
  type Plan,
} from "@/lib/date-genie/engine";
import { registerWebMcp, type ToolCallRecord } from "@/lib/date-genie/webmcp";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Date Genie — Date Night as a Single Command" },
      {
        name: "description",
        content:
          "Date Genie is a WebMCP tool site: one natural-language command books dinner, tickets and parking. Agents stop recommending your life and start executing it.",
      },
      { property: "og:title", content: "Date Genie — Date Night as a Single Command" },
      {
        property: "og:description",
        content:
          "One command, one itinerary, one confirmation. WebMCP tools for events, restaurants, parking and tickets.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DateGenie,
});

const EXAMPLE =
  "Plan something fun for me and my girlfriend Friday night. Keep everything under $180. We're in Arlington, don't make us drive more than 20 minutes, and nothing before 7.";

const TOOL_GROUPS = [
  { icon: CalendarHeart, label: "Events", tools: ["search_events"] },
  { icon: UtensilsCrossed, label: "Restaurants", tools: ["find_restaurants", "check_availability", "reserve_table"] },
  { icon: Car, label: "Parking", tools: ["find_parking", "reserve_spot"] },
  { icon: Ticket, label: "Tickets", tools: ["reserve_tickets"] },
];

function DateGenie() {
  const [input, setInput] = useState(EXAMPLE);
  const [constraints, setConstraints] = useState<Constraints | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [booking, setBooking] = useState<Booking | null>(null);
  const [thinking, setThinking] = useState(false);
  const [calls, setCalls] = useState<ToolCallRecord[]>([]);
  const [mcp, setMcp] = useState<{ available: boolean; toolNames: string[] }>({
    available: false,
    toolNames: [],
  });
  const planRef = useRef<Plan | null>(null);
  planRef.current = plan;

  useEffect(() => {
    const reg = registerWebMcp({
      onCall: (r) => setCalls((c) => [r, ...c].slice(0, 12)),
      onPlan: (p) => {
        setPlan(p);
        setBooking(null);
      },
      onBooking: (b) => setBooking(b),
      getPlan: () => planRef.current,
    });
    setMcp({ available: reg.available, toolNames: reg.toolNames });
    return reg.dispose;
  }, []);

  const run = useCallback(() => {
    setThinking(true);
    setBooking(null);
    const c = parseRequest(input);
    setConstraints(c);
    window.setTimeout(() => {
      const { plan: p, log: l } = planDateNight(c);
      setPlan(p);
      setLog(l);
      setThinking(false);
    }, 550);
  }, [input]);

  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirm = () => {
    if (!plan) return;
    setBooking(bookPlan(plan));
  };

  const remaining = useMemo(
    () => (plan && constraints ? constraints.budget - plan.total : 0),
    [plan, constraints],
  );

  return (
    <main className="mx-auto w-full max-w-5xl px-5 pb-24 pt-14 sm:px-8">
      <header className="flex flex-col gap-4">
        <span className="rule-chip w-fit">
          <Sparkles className="size-3.5 text-primary" />
          WebMCP tool site
        </span>
        <h1 className="text-5xl leading-[1.02] sm:text-6xl">
          Date Genie
          <span className="block text-primary">Date night as a single command.</span>
        </h1>
        <p className="max-w-2xl text-base text-muted-foreground">
          Not ten suggestions. One itinerary that fits your budget, your radius and your clock — dinner,
          tickets and parking held together, ready to confirm.
        </p>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rule-chip">
            <span
              className={`size-2 rounded-full ${mcp.available ? "bg-accent" : "bg-muted-foreground"}`}
            />
            {mcp.available ? "navigator.modelContext connected" : "No agent detected — tools staged on window.dateGenie"}
          </span>
          <span className="rule-chip">{mcp.toolNames.length} tools exposed</span>
        </div>
      </header>

      <section className="mt-10 surface glow-ring p-5 sm:p-6">
        <label htmlFor="cmd" className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
          The command
        </label>
        <textarea
          id="cmd"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={3}
          className="mt-3 w-full resize-none rounded-lg border border-input bg-ink/60 p-4 font-mono text-sm leading-relaxed text-foreground outline-none focus:border-primary"
        />
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            {constraints && (
              <>
                <span className="rule-chip">budget {money(constraints.budget)}</span>
                <span className="rule-chip">after {fmtTime(constraints.earliest)}</span>
                <span className="rule-chip">≤ {constraints.maxDriveMinutes} min drive</span>
                <span className="rule-chip">party of {constraints.party}</span>
              </>
            )}
          </div>
          <button
            onClick={run}
            className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition hover:brightness-110"
          >
            <Wand2 className="size-4" />
            {thinking ? "Composing…" : "Plan it"}
          </button>
        </div>
      </section>

      <section className="mt-8 grid gap-6 lg:grid-cols-[1.25fr_1fr]">
        <div className="surface p-5 sm:p-6">
          <h2 className="text-xl">The night</h2>
          {thinking && <p className="mt-6 font-mono text-sm text-muted-foreground">composing itinerary…</p>}

          {!thinking && plan && (
            <div className="mt-5 space-y-3">
              <ItineraryRow
                icon={UtensilsCrossed}
                time={fmtTime(plan.dinner.time)}
                title={plan.dinner.restaurant.name}
                sub={`${plan.dinner.restaurant.cuisine} · ${plan.dinner.restaurant.neighborhood} · ${plan.dinner.restaurant.vibe}`}
                cost={plan.dinner.cost}
              />
              <ItineraryRow
                icon={Ticket}
                time={fmtTime(plan.event.event.start)}
                title={plan.event.event.name}
                sub={`${plan.event.event.venue} · ${plan.event.walkMinutes}-minute walk from dinner`}
                cost={plan.event.cost}
              />
              <ItineraryRow
                icon={Car}
                time="park once"
                title={plan.parking.spot.name}
                sub={`${plan.parking.spot.walkMinutes}-minute walk · covers the whole evening`}
                cost={plan.parking.cost}
              />

              <div className="flex items-center justify-between border-t border-border pt-4">
                <div>
                  <p className="text-2xl font-semibold">Total {money(plan.total)}</p>
                  <p className="text-xs text-muted-foreground">
                    {money(remaining)} under budget · {plan.dinner.restaurant.driveMinutes} min drive
                  </p>
                </div>
                {!booking ? (
                  <button
                    onClick={confirm}
                    className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-accent-foreground transition hover:brightness-110"
                  >
                    Reserve it
                  </button>
                ) : (
                  <span className="inline-flex items-center gap-2 rounded-full border border-accent px-4 py-2 text-sm font-semibold text-accent">
                    <CheckCircle2 className="size-4" /> Booked
                  </span>
                )}
              </div>
            </div>
          )}

          {!thinking && !plan && (
            <p className="mt-5 text-sm text-muted-foreground">
              Nothing clears every constraint. Raise the budget, push the drive radius, or start earlier.
            </p>
          )}

          {booking && (
            <div className="mt-5 rounded-lg border border-accent/40 bg-ink/50 p-4">
              <p className="font-mono text-xs uppercase tracking-widest text-accent">
                Confirmation {booking.confirmation}
              </p>
              <ul className="mt-3 space-y-2 text-sm">
                {booking.lines.map((l) => (
                  <li key={l.label} className="flex justify-between gap-4">
                    <span>
                      <span className="font-medium">{l.label}</span>
                      <span className="block font-mono text-xs text-muted-foreground">{l.detail}</span>
                    </span>
                    <span className="font-mono">{money(l.cost)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="space-y-6">
          <div className="surface p-5">
            <h2 className="text-lg">Tools on this page</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Exposed via <span className="font-mono">navigator.modelContext</span> for any WebMCP agent.
            </p>
            <ul className="mt-4 space-y-3">
              {TOOL_GROUPS.map(({ icon: Icon, label, tools }) => (
                <li key={label} className="flex gap-3">
                  <Icon className="mt-0.5 size-4 shrink-0 text-primary" />
                  <div>
                    <p className="text-sm font-medium">{label}</p>
                    <p className="font-mono text-xs text-muted-foreground">{tools.join("() · ")}()</p>
                  </div>
                </li>
              ))}
              <li className="flex gap-3">
                <Sparkles className="mt-0.5 size-4 shrink-0 text-accent" />
                <div>
                  <p className="text-sm font-medium">One-shot</p>
                  <p className="font-mono text-xs text-muted-foreground">
                    plan_date_night() · book_current_plan()
                  </p>
                </div>
              </li>
            </ul>
          </div>

          <div className="surface p-5">
            <h2 className="text-lg">Execution trace</h2>
            <ul className="mt-3 space-y-1.5 font-mono text-xs text-muted-foreground">
              {log.map((l) => (
                <li key={l} className="flex gap-2">
                  <Clock className="mt-0.5 size-3 shrink-0 text-primary" />
                  {l}
                </li>
              ))}
              {calls.map((c) => (
                <li key={c.id} className="flex gap-2 text-accent">
                  <Footprints className="mt-0.5 size-3 shrink-0" />
                  agent → {c.name}()
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <footer className="mt-14 border-t border-border pt-6 text-sm text-muted-foreground">
        AI stops recommending your life and starts executing it.
      </footer>
    </main>
  );
}

function ItineraryRow({
  icon: Icon,
  time,
  title,
  sub,
  cost,
}: {
  icon: typeof Ticket;
  time: string;
  title: string;
  sub: string;
  cost: number;
}) {
  return (
    <div className="flex items-start gap-4 rounded-lg border border-border bg-ink/40 p-4">
      <Icon className="mt-1 size-5 shrink-0 text-primary" />
      <div className="flex-1">
        <p className="font-mono text-xs uppercase tracking-widest text-primary">{time}</p>
        <p className="text-lg font-semibold">{title}</p>
        <p className="text-xs text-muted-foreground">{sub}</p>
      </div>
      <span className="font-mono text-sm">{money(cost)}</span>
    </div>
  );
}
