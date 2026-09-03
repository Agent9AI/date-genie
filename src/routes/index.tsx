import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import {
  ApprovalSheet,
  CommandBar,
  ConstraintDeck,
  Stage,
  StatusPill,
  ToolConsole,
  ToolSurface,
  useGenie,
} from "@/components/date-genie/panels";
import { SAMPLE_REQUESTS, runDemoAgent } from "@/lib/date-genie/demo-agent";
import * as store from "@/lib/date-genie/store";
import { bindWebMcp } from "@/lib/date-genie/webmcp";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Date Genie: date night as a single command" },
      {
        name: "description",
        content:
          "A WebMCP site that stops recommending your evening and starts executing it. Your agent plans dinner, a show and parking as one bookable itinerary, and cannot spend a cent until you press confirm in the page.",
      },
      { property: "og:title", content: "Date Genie: date night as a single command" },
      {
        property: "og:description",
        content: "WebMCP tools that plan and book a whole evening. The agent proposes; the human, in the page, decides.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DateGenie,
});

function Wordmark() {
  return (
    <div className="flex items-center gap-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-primary/40 bg-primary/15 text-xl">
        🧞
      </span>
      <div>
        <h1 className="font-display text-xl leading-none font-extrabold tracking-tight text-foreground">Date Genie</h1>
        <p className="mt-1 text-xs text-muted-foreground">Date night as a single command</p>
      </div>
    </div>
  );
}

/** The argument, stated once, for a judge who reads before they click. */
function Thesis() {
  const points = [
    {
      k: "The agent reads your page, not your mind",
      v: "Every dial you touch is state the agent fetches with get_date_context before it asks you anything. Half the questions never get asked.",
    },
    {
      k: "It executes instead of recommending",
      v: "plan_date_night searches every dinner × event × parking combination and returns one bookable evening, with the arithmetic shown.",
    },
    {
      k: "Your thumb is the only thing that spends money",
      v: "request_approval suspends the tool call until you press a button in this page. No timeout, no default. book_approved_plan does not exist until you do.",
    },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {points.map((p) => (
        <div key={p.k} className="surface p-4">
          <h3 className="font-display text-sm font-semibold text-foreground">{p.k}</h3>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{p.v}</p>
        </div>
      ))}
    </div>
  );
}

function DateGenie() {
  const { webmcp, demoRunning } = useGenie();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    store.hydrate();
    const bound = bindWebMcp();
    setReady(true);
    if (typeof console !== "undefined") {
      console.info(
        `[date-genie] WebMCP ${bound.bound ? `bound to ${bound.surface}` : "host not detected; tools still available on window.dateGenie"}; ${bound.toolNames.length} tools: ${bound.toolNames.join(", ")}`,
      );
    }
    return bound.dispose;
  }, []);

  return (
    <main className="mx-auto min-h-screen w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-10">
      <header className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <Wordmark />
        {ready ? <StatusPill /> : null}
      </header>

      <section className="mb-6">
        <h2 className="max-w-3xl font-display text-3xl leading-[1.1] font-extrabold tracking-tight text-balance text-foreground sm:text-4xl">
          AI should stop <span className="text-muted-foreground line-through decoration-destructive/60">recommending</span> your
          life and start <span className="text-primary">executing</span> it.
        </h2>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Ten links is not an answer. Date Genie exposes a whole evening (dinner, a show, and somewhere to put the car)
          as WebMCP tools, so your agent hands back <span className="text-foreground">7:30, then 9:15, $164, reserve it?</span>{" "}
          and you answer with one thumb.
        </p>
      </section>

      <div className="mb-6">
        <CommandBar
          samples={SAMPLE_REQUESTS}
          onRun={(text) => {
            void runDemoAgent(text);
          }}
        />
        {!webmcp.bound && ready ? (
          <p className="mt-2 text-xs text-muted-foreground">
            No WebMCP host in this browser, so that button runs the page's own scripted agent. It calls the identical
            tools over the identical code path, including stopping dead at the approval gate.
          </p>
        ) : null}
        {webmcp.bound && !webmcp.agentSeen && ready ? (
          <p className="mt-2 text-xs text-accent">
            WebMCP detected on <code className="font-mono">{webmcp.surface}</code>. Ask your agent to plan your evening,
            or press the button to watch it happen without one.
          </p>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-12">
        <div className="lg:col-span-3">
          <ConstraintDeck />
        </div>
        <div className="lg:col-span-6">
          <Stage />
        </div>
        <div className="lg:col-span-3">
          <ToolConsole />
        </div>
      </div>

      <div className="mt-4">
        <ToolSurface />
      </div>

      <section className="mt-8">
        <h2 className="mb-3 font-display text-xs font-semibold tracking-widest text-muted-foreground uppercase">
          Why this needs to be WebMCP, and not a server
        </h2>
        <Thesis />
      </section>

      <footer className="mt-10 border-t border-border pt-6 text-xs text-muted-foreground">
        <p>
          Built for the WebMCP Challenge. Restaurants, cinemas, theatres, music venues and parking are fetched live
          from OpenStreetMap around whatever place you name, anywhere in the world, and every walk and drive time is
          computed from those real coordinates. Prices, ratings, showtimes and availability are simulated, because no
          free open dataset carries them. Reservations are simulated; no card is ever charged.
        </p>
        <p className="mt-2">
          Open <code className="font-mono text-foreground">window.dateGenie.listTools()</code> in the console to inspect
          the surface yourself, or call any tool directly with{" "}
          <code className="font-mono text-foreground">window.dateGenie.call(name, args)</code>.
          {demoRunning ? <span className="ml-2 text-primary">agent running…</span> : null}
        </p>
      </footer>

      <ApprovalSheet />
    </main>
  );
}
