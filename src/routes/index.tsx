import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import {
  ApprovalSheet,
  CommandBar,
  ConstraintDeck,
  SourcesPanel,
  Stage,
  StatusPill,
  ToolConsole,
  ToolSurface,
  useGenie,
} from "@/components/date-genie/panels";
import { SAMPLE_REQUESTS, runDemoAgent } from "@/lib/date-genie/demo-agent";
import * as store from "@/lib/date-genie/store";
import { refreshKeyedAvailability } from "@/lib/date-genie/sources/registry";
import { bindWebMcp } from "@/lib/date-genie/webmcp";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Date Genie" },
      {
        name: "description",
        content:
          "Say it once and get one bookable evening: dinner, something after, and somewhere to leave the car. Exposed to your agent as WebMCP tools that cannot spend a penny until you press confirm.",
      },
      { property: "og:title", content: "Date Genie" },
      {
        property: "og:description",
        content: "Date night as a single command. The agent proposes; you decide, in the page.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DateGenie,
});

function Wordmark() {
  return (
    <div className="flex items-baseline gap-3">
      <h1 className="font-display text-2xl leading-none text-foreground">Date Genie</h1>
      <p className="text-sm text-muted-foreground">date night as a single command</p>
    </div>
  );
}

function Thesis() {
  const points = [
    {
      k: "It reads your page, not your mind",
      v: "Every dial you touch is state the agent fetches before it asks you anything. Half the questions never get asked.",
    },
    {
      k: "It executes instead of recommending",
      v: "Thousands of dinner, event and parking combinations are checked against your rules, and one evening comes back with the arithmetic shown.",
    },
    {
      k: "Your thumb is the only thing that spends money",
      v: "The approval call suspends until you press a button here. No timeout, no default. The booking tool does not exist until you do.",
    },
  ];
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {points.map((p) => (
        <div key={p.k}>
          <h3 className="font-display text-xl leading-tight text-foreground">{p.k}</h3>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{p.v}</p>
        </div>
      ))}
    </div>
  );
}

function DateGenie() {
  const { webmcp } = useGenie();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    store.hydrate();
    void refreshKeyedAvailability();
    // Pull the opening city into the edge cache so the first click is instant.
    void store.prefetch("Arlington, VA");
    const bound = bindWebMcp();
    setReady(true);
    console.info(
      `[date-genie] WebMCP ${bound.bound ? `bound to ${bound.surface}` : "host not detected; tools still available on window.dateGenie"}; ${bound.toolNames.length} tools: ${bound.toolNames.join(", ")}`,
    );
    return bound.dispose;
  }, []);

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-5 py-8 sm:px-8 sm:py-12">
      <header className="mb-12 flex flex-col gap-4 sm:flex-row sm:items-baseline sm:justify-between">
        <Wordmark />
        {ready ? <StatusPill /> : null}
      </header>

      <section className="mb-8 max-w-2xl">
        <p className="font-display text-4xl leading-[1.15] text-balance text-foreground sm:text-5xl">
          Ten links is not an answer.
        </p>
        <p className="mt-4 text-base leading-relaxed text-muted-foreground">
          Date Genie plans the whole evening, dinner, something after, and somewhere to leave the
          car, then hands it to your agent as tools. It searches wherever you say, anywhere on
          earth, and it cannot spend a penny until your thumb says so.
        </p>
      </section>

      <div className="mb-4">
        <CommandBar
          samples={SAMPLE_REQUESTS}
          onRun={(text) => {
            void runDemoAgent(text);
          }}
        />
        {ready && !webmcp.bound ? (
          <p className="mt-3 max-w-2xl text-xs leading-relaxed text-muted-foreground">
            No WebMCP host in this browser, so that button runs the page's own scripted agent. It
            calls the identical tools over the identical code path, including stopping dead at the
            approval gate.
          </p>
        ) : null}
        {ready && webmcp.bound && !webmcp.agentSeen ? (
          <p className="mt-3 text-xs text-accent">
            WebMCP detected on <code className="font-mono">{webmcp.surface}</code>. Ask your agent
            to plan your evening, or press the button to watch it happen without one.
          </p>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-12">
        <div className="lg:col-span-8">
          <Stage />
        </div>
        <div className="lg:col-span-4">
          <ToolConsole />
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-12">
        <div className="lg:col-span-4">
          <ConstraintDeck />
        </div>
        <div className="lg:col-span-4">
          <ToolSurface />
        </div>
        <div className="lg:col-span-4">
          <SourcesPanel />
        </div>
      </div>

      <section className="mt-14 border-t border-border/50 pt-8">
        <Thesis />
      </section>

      <footer className="mt-12 border-t border-border/50 pt-6 text-xs leading-relaxed text-muted-foreground">
        <p className="max-w-3xl">
          Built for the WebMCP Challenge. Venues are fetched live around whatever place you name:
          names, locations and diet tags from OpenStreetMap, star ratings and price bands from
          Google Maps, and every walk and drive time computed from real coordinates. Table times and
          showtimes are simulated, because neither source publishes them. Nothing is charged, and
          the booking step hands you the real link rather than pretending.
        </p>
        <p className="mt-3">
          Inspect the surface yourself:{" "}
          <code className="font-mono text-foreground">window.dateGenie.listTools()</code>, or call
          any tool with{" "}
          <code className="font-mono text-foreground">window.dateGenie.call(name, args)</code>.
        </p>
      </footer>

      <ApprovalSheet />
    </main>
  );
}
