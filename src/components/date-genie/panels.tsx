/**
 * The shared surface, rendered as a running order.
 *
 * Every panel here is BOTH a human control and an agent-visible surface: what
 * you drag, the agent reads through `get_date_context`; what the agent changes,
 * you watch move. There is no hidden second copy of the state.
 *
 * The visual idea is the itinerary a good concierge hands you, not a dashboard.
 * The evening is the only loud thing on the page. The console is present and
 * legible and never competes with it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { downloadIcs } from "@/lib/date-genie/ics";
import { buildHandoff } from "@/lib/date-genie/handoff";
import { fmtTime, money, toMinutes, type Plan } from "@/lib/date-genie/engine";
import * as store from "@/lib/date-genie/store";
import { callTool } from "@/lib/date-genie/webmcp";
import { allTools } from "@/lib/date-genie/tools";
import { ACTIVE_ADAPTERS, WANTED_SOURCES } from "@/lib/date-genie/sources/registry";

const serverSnapshot = store.getState();

export function useGenie(): store.State {
  return useSyncExternalStore(store.subscribe, store.getState, () => serverSnapshot);
}

/* ------------------------------------------------------------- shell ---- */

function Panel({
  title,
  hint,
  right,
  children,
  quiet = false,
  className = "",
}: {
  title?: string;
  hint?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  quiet?: boolean;
  className?: string;
}) {
  return (
    <section className={`surface p-5 ${quiet ? "opacity-95" : ""} ${className}`}>
      {title ? (
        <header className="mb-4 flex items-baseline justify-between gap-3">
          <div>
            <h2
              className={`font-display ${quiet ? "text-lg" : "text-xl"} leading-none text-foreground`}
            >
              {title}
            </h2>
            {hint ? (
              <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted-foreground">
                {hint}
              </p>
            ) : null}
          </div>
          {right}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function StatusPill() {
  const { webmcp, pool, searching } = useGenie();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        className="rule-chip"
        title={
          pool
            ? `Live results from ${pool.reports.map((r) => r.label).join(", ")}`
            : "Nothing about any place is stored in this page"
        }
      >
        {searching ? (
          <>
            <span className="dg-live-dot size-1.5 rounded-full bg-primary" aria-hidden />
            searching
          </>
        ) : pool ? (
          <>
            <span className="size-1.5 rounded-full bg-accent" aria-hidden />
            {pool.restaurants.length} places found live
          </>
        ) : (
          <>nothing searched yet</>
        )}
      </span>
      <span
        className="rule-chip"
        title={
          webmcp.bound
            ? `Tools registered on ${webmcp.surface}`
            : "No WebMCP host here. The built-in agent drives the identical tools."
        }
      >
        <span
          className={`size-1.5 rounded-full ${webmcp.bound ? "dg-live-dot bg-accent" : "bg-muted-foreground"}`}
          aria-hidden
        />
        {webmcp.bound ? webmcp.surface : "no WebMCP host"}
      </span>
      <span className="rule-chip">{webmcp.tools.length} tools</span>
      {webmcp.agentSeen ? (
        <span className="rule-chip border-accent/50 text-accent">agent connected</span>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------- command bar ---- */

export function CommandBar({
  onRun,
  samples,
}: {
  onRun: (text: string) => void;
  samples: string[];
}) {
  const { demoRunning, searching } = useGenie();
  const [text, setText] = useState(samples[0] ?? "");
  const busy = demoRunning || searching;

  return (
    <div className="surface glow-ring p-5">
      <div className="flex flex-col gap-3 sm:flex-row">
        <textarea
          id="wish"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onRun(text);
          }}
          rows={2}
          spellCheck={false}
          aria-label="Describe the evening you want"
          className="dg-scroll min-h-[4.5rem] flex-1 resize-none rounded-lg border border-input bg-ink/50 px-4 py-3 font-sans text-base leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/70 focus:ring-2 focus:ring-primary/20"
          placeholder="Friday in Savannah, under $180, nothing before 7, she hates oysters"
        />
        <button
          type="button"
          onClick={() => onRun(text)}
          disabled={busy || !text.trim()}
          className="h-fit shrink-0 self-stretch rounded-lg bg-primary px-7 py-3 font-display text-lg text-primary-foreground transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 sm:self-auto"
        >
          {busy ? "Working" : "Plan it"}
        </button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {samples.slice(1).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setText(s)}
            className="rule-chip max-w-full text-left transition hover:border-primary/60 hover:text-foreground"
          >
            <span className="truncate">{s.split(".")[0]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ----------------------------------------------------- what you asked ---- */

function Dial({
  label,
  value,
  display,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step?: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="block">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="font-display text-base text-foreground">{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 w-full cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
      />
    </label>
  );
}

export function ConstraintDeck() {
  const { constraints: c, vetoes, place, searching, notice } = useGenie();
  const [newVeto, setNewVeto] = useState("");
  const [where, setWhere] = useState("");
  const patch = useCallback((next: Partial<typeof c>) => store.replan({ ...c, ...next }), [c]);

  return (
    <Panel
      title="What you asked for"
      hint="Your agent reads every value here before it asks you a single question."
      quiet
    >
      <p className="mb-4 font-display text-lg leading-snug text-foreground">
        Tonight in {place?.label ?? "somewhere you have not said yet"}, for {c.party}, under{" "}
        {money(c.budget)}, nothing before {fmtTime(c.earliest)}, home by {fmtTime(c.latestEnd)}.
      </p>

      <form
        className="mb-5 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!where.trim()) return;
          void callTool("set_location", { place: where.trim() }, "you");
          setWhere("");
        }}
      >
        <input
          value={where}
          onChange={(e) => setWhere(e.target.value)}
          placeholder="Anywhere on earth"
          aria-label="Change location"
          className="min-w-0 flex-1 rounded-lg border border-input bg-ink/50 px-3 py-2 text-sm outline-none focus:border-primary/70"
        />
        <button
          type="submit"
          disabled={searching}
          className="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground transition hover:border-primary hover:text-foreground disabled:opacity-50"
        >
          Search here
        </button>
      </form>
      <button
        type="button"
        onClick={() => void store.useMyLocation()}
        disabled={searching}
        className="-mt-3 mb-4 block text-xs text-primary underline-offset-4 hover:underline disabled:opacity-50"
      >
        or use my location
      </button>

      {notice ? <p className="mb-4 text-xs leading-relaxed text-rose">{notice}</p> : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
        <Dial
          label="Whole evening"
          value={c.budget}
          display={money(c.budget)}
          min={40}
          max={400}
          step={5}
          onChange={(budget) => patch({ budget })}
        />
        <Dial
          label="Nothing before"
          value={toMinutes(c.earliest)}
          display={fmtTime(c.earliest)}
          min={16 * 60}
          max={21 * 60}
          step={15}
          onChange={(m) =>
            patch({
              earliest: `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`,
            })
          }
        />
        <Dial
          label="Home by"
          value={toMinutes(c.latestEnd)}
          display={fmtTime(c.latestEnd)}
          min={21 * 60}
          max={23 * 60 + 59}
          step={15}
          onChange={(m) =>
            patch({
              latestEnd: `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`,
            })
          }
        />
        <Dial
          label="Drive from home"
          value={c.maxDriveMinutes}
          display={`${c.maxDriveMinutes} min`}
          min={5}
          max={45}
          onChange={(maxDriveMinutes) => patch({ maxDriveMinutes })}
        />
      </div>

      <div className="mt-5 flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Party</span>
        {[2, 3, 4, 6].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => patch({ party: n })}
            className={`size-8 rounded-full border font-display text-base transition ${
              c.party === n
                ? "border-primary bg-primary/15 text-foreground"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {n}
          </button>
        ))}
      </div>

      <div className="mt-5 border-t border-border/60 pt-4">
        <p className="mb-2 text-xs text-muted-foreground">
          Never again. Saved in this browser, and honoured on your next visit.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {vetoes.length === 0 ? (
            <span className="text-xs text-muted-foreground/70">Nothing ruled out yet.</span>
          ) : null}
          {vetoes.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => {
                store.removeVeto(v);
                store.replan();
              }}
              className="rule-chip border-rose/40 text-foreground transition hover:border-rose"
              title={`Stop avoiding ${v}`}
            >
              {v} <span className="text-muted-foreground">×</span>
            </button>
          ))}
        </div>
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newVeto.trim()) return;
            void callTool("remember_preference", { dislike: newVeto.trim() }, "you");
            setNewVeto("");
          }}
        >
          <input
            value={newVeto}
            onChange={(e) => setNewVeto(e.target.value)}
            placeholder="oysters, loud, chains"
            aria-label="Rule something out"
            className="min-w-0 flex-1 rounded-lg border border-input bg-ink/50 px-3 py-1.5 text-xs outline-none focus:border-primary/70"
          />
          <button
            type="submit"
            className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition hover:border-primary hover:text-foreground"
          >
            Rule out
          </button>
        </form>
      </div>
    </Panel>
  );
}

/* ----------------------------------------------------- the evening ---- */

function Leg({ leg, index }: { leg: Plan["legs"][number]; index: number }) {
  return (
    <li
      className="dg-rise grid grid-cols-[4.5rem_1fr_auto] items-baseline gap-x-4 border-t border-border/50 py-4 first:border-t-0"
      style={{ animationDelay: `${index * 80}ms` }}
    >
      <time className="font-display text-2xl leading-none text-foreground tabular-nums">
        {fmtTime(leg.start)}
      </time>
      <div className="min-w-0">
        <h3 className="font-display text-2xl leading-tight text-foreground">{leg.title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{leg.subtitle}</p>
        <p className="mt-0.5 text-xs text-muted-foreground/70">{leg.detail}</p>
      </div>
      <span className="font-display text-xl text-primary tabular-nums">{money(leg.cost)}</span>
    </li>
  );
}

/** Three lines where three lines are about to be. Silence reads as broken. */
function SearchSkeleton() {
  return (
    <ul className="mx-auto mt-8 max-w-md space-y-4 text-left" aria-hidden>
      {[0, 1, 2].map((i) => (
        <li
          key={i}
          className="grid grid-cols-[4rem_1fr] items-center gap-4"
          style={{ opacity: 1 - i * 0.22 }}
        >
          <div className="dg-pulse-bar h-5 rounded bg-secondary" />
          <div className="space-y-2">
            <div
              className="dg-pulse-bar h-5 rounded bg-secondary"
              style={{ width: `${72 - i * 12}%`, animationDelay: `${i * 180}ms` }}
            />
            <div
              className="dg-pulse-bar h-3 rounded bg-secondary/60"
              style={{ width: `${48 - i * 8}%`, animationDelay: `${i * 240}ms` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function ChecksTable({ checks }: { checks: store.State["checks"] }) {
  if (!checks.length) return null;
  return (
    <div className="mt-6 border-t border-border/50 pt-4">
      <p className="mb-3 text-sm text-muted-foreground">
        Every rule you set, checked against what you got.
      </p>
      <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
        {checks.map((c) => (
          <li key={c.label} className="flex items-baseline gap-2 text-sm">
            <span className={c.ok ? "text-accent" : "text-rose"} aria-hidden>
              {c.ok ? "✓" : "✕"}
            </span>
            <span className="text-muted-foreground">{c.label}</span>
            <span className="ml-auto text-foreground tabular-nums">{c.actual}</span>
            <span className="text-muted-foreground/60 tabular-nums">of {c.target}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Stage() {
  const {
    plan,
    alternates,
    checks,
    considered,
    booking,
    searching,
    revision,
    trace,
    relaxations,
    place,
    notice,
    pool,
    shortfall,
  } = useGenie();
  const [showTrace, setShowTrace] = useState(false);

  if (booking) return <Receipt />;

  if (!plan) {
    return (
      <Panel>
        <div className="py-16 text-center">
          <p className="font-display text-3xl text-foreground">
            {searching ? (
              <span className="dg-shimmer">Looking for your evening</span>
            ) : place ? (
              "Say what you want. Once."
            ) : (
              "Tell me where you are."
            )}
          </p>
          <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
            {notice ??
              (trace.length
                ? trace[trace.length - 1]
                : "Dinner, something after, and somewhere to leave the car. Solved together, not one tab at a time.")}
          </p>
          {shortfall?.reason === "budget" && shortfall.breakdown ? (
            <div className="mx-auto mt-6 max-w-xs rounded-lg border border-primary/40 bg-primary/10 p-4 text-left">
              <p className="mb-2 text-sm text-foreground">Here is the arithmetic.</p>
              <ul className="space-y-1 text-sm text-muted-foreground">
                <li className="flex justify-between">
                  <span>dinner</span>
                  <span className="text-foreground tabular-nums">
                    {money(shortfall.breakdown.dinner)}
                  </span>
                </li>
                <li className="flex justify-between">
                  <span>tickets</span>
                  <span className="text-foreground tabular-nums">
                    {money(shortfall.breakdown.tickets)}
                  </span>
                </li>
                <li className="flex justify-between">
                  <span>parking</span>
                  <span className="text-foreground tabular-nums">
                    {money(shortfall.breakdown.parking)}
                  </span>
                </li>
                <li className="mt-1 flex justify-between border-t border-border pt-1 text-primary">
                  <span>cheapest that fits</span>
                  <span className="tabular-nums">{money(shortfall.cheapestTotal ?? 0)}</span>
                </li>
              </ul>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                {shortfall.suggestion}
              </p>
            </div>
          ) : null}
        </div>
      </Panel>
    );
  }

  return (
    <Panel>
      <header className="mb-5 flex items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-3xl leading-none text-foreground">Your evening</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {pool
              ? `${pool.restaurants.length} places and ${pool.events.length} venues came back live, then `
              : ""}
            {considered.toLocaleString()} combinations checked.
          </p>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-display text-4xl leading-none text-primary tabular-nums">
            {money(plan.total)}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            of your {money(plan.constraints.budget)}
          </div>
        </div>
      </header>

      {relaxations.length ? (
        <p className="mb-4 rounded-lg border border-primary/40 bg-primary/10 px-4 py-3 text-sm leading-relaxed text-foreground">
          Not an exact match. Nothing fit your rules exactly, so the genie widened{" "}
          {relaxations.map((r, i) => (
            <span key={r.label}>
              {i > 0 ? " and " : ""}
              {r.label} from {r.from} to {r.to}
            </span>
          ))}
          . Everything else still holds.
        </p>
      ) : null}

      <ol key={revision}>
        {plan.legs.map((leg, i) => (
          <Leg key={`${leg.kind}-${leg.id}-${revision}`} leg={leg} index={i} />
        ))}
      </ol>

      <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
        <span className="text-foreground">Why this one. </span>
        {plan.why.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(". ")}.
      </p>

      <ChecksTable checks={checks} />

      {alternates.length ? (
        <div className="mt-6 border-t border-border/50 pt-4">
          <p className="mb-3 text-sm text-muted-foreground">Or, genuinely different:</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {alternates.map((alt, i) => (
              <button
                key={alt.id}
                type="button"
                onClick={() => void callTool("pick_alternate", { which: i + 1 }, "you")}
                className="rounded-lg border border-border bg-ink/40 p-3 text-left transition hover:border-primary/60"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-display text-lg text-foreground">
                    {alt.dinner.restaurant.name}
                  </span>
                  <span className="shrink-0 text-primary tabular-nums">{money(alt.total)}</span>
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  then {alt.event.event.venue}
                </p>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-border/50 pt-5">
        <button
          type="button"
          onClick={() =>
            void callTool(
              "request_approval",
              { note: "Holds the table, the tickets and the spot." },
              "you",
            )
          }
          className="rounded-lg bg-primary px-6 py-3 font-display text-lg text-primary-foreground transition hover:brightness-110"
        >
          Book the whole night
        </button>
        {(["cheaper", "later", "quieter", "swap_event"] as const).map((op) => (
          <button
            key={op}
            type="button"
            onClick={() => void callTool("refine_plan", { change: op }, "you")}
            className="rule-chip transition hover:border-primary/60 hover:text-foreground"
          >
            {op.replace("_", " ")}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setShowTrace((v) => !v)}
          className="ml-auto text-xs text-muted-foreground underline-offset-4 hover:underline"
        >
          {showTrace ? "hide" : "show"} search trace
        </button>
      </div>

      {showTrace ? (
        <pre className="dg-scroll mt-3 max-h-40 overflow-auto rounded-lg border border-border bg-ink/60 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {trace.join("\n")}
        </pre>
      ) : null}
    </Panel>
  );
}

/* ----------------------------------------------------------- receipt ---- */

function Receipt() {
  const { booking, plan } = useGenie();
  if (!booking || !plan) return null;
  const handoff = buildHandoff(plan);

  return (
    <Panel>
      <header className="mb-5 flex items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-3xl leading-none text-foreground">Held for you</h2>
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted-foreground">
            Three holds, one confirmation, nothing booked without you pressing a button. Date Genie
            cannot complete a real reservation, because no booking site exposes tools for an agent
            to call yet. So here is the last tap for each, in the order you need it.
          </p>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-display text-3xl leading-none text-accent">
            {money(booking.total)}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">{booking.confirmation}</div>
        </div>
      </header>

      <ul className="space-y-2">
        {handoff.map((link, i) => (
          <li
            key={`${link.kind}-${i}`}
            className="dg-rise"
            style={{ animationDelay: `${i * 90}ms` }}
          >
            <a
              href={link.href}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-baseline gap-3 rounded-lg border border-border bg-ink/40 p-4 transition hover:border-primary/60"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-display text-xl text-foreground">{link.label}</div>
                <div className="text-sm text-muted-foreground">{link.detail}</div>
              </div>
              <span className="shrink-0 text-sm text-primary">{link.action}</span>
            </a>
          </li>
        ))}
      </ul>

      <div className="mt-5 flex flex-wrap gap-2 border-t border-border/50 pt-5">
        <button
          type="button"
          onClick={() => downloadIcs(plan, booking)}
          className="rounded-lg bg-accent px-5 py-2.5 font-display text-lg text-accent-foreground transition hover:brightness-110"
        >
          Add all three to your calendar
        </button>
        <button
          type="button"
          onClick={() => store.reset()}
          className="rule-chip transition hover:border-primary/60 hover:text-foreground"
        >
          Plan another night
        </button>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------ approval gate ---- */

export function ApprovalSheet() {
  const { approval } = useGenie();
  const [note, setNote] = useState("");
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (approval.status === "pending") ref.current?.focus();
  }, [approval.status]);

  if (approval.status !== "pending") return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/80 p-3 backdrop-blur-sm sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Confirm booking"
    >
      <div className="dg-rise glow-ring w-full max-w-lg rounded-xl border border-primary/40 bg-card p-6 shadow-2xl">
        <div className="flex items-center gap-2">
          <span className="dg-live-dot size-2 rounded-full bg-primary" aria-hidden />
          <p className="text-sm text-primary">Your agent is waiting on you</p>
        </div>
        <p className="mt-3 font-display text-2xl leading-snug text-foreground">
          {approval.summary}
        </p>
        <p className="mt-2 font-display text-3xl text-primary tabular-nums">
          {money(approval.total)}
        </p>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          The tool call is suspended right now. It has no timeout and no default. It resolves when
          you press one of these, and not before.
        </p>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional: tell it why, and the agent will hear you"
          aria-label="Note to the agent"
          className="mt-4 w-full rounded-lg border border-input bg-ink/50 px-3 py-2 text-sm outline-none focus:border-primary/70"
        />
        <div className="mt-4 flex gap-2">
          <button
            ref={ref}
            type="button"
            onClick={() => store.resolveApproval(true, note.trim() || undefined)}
            className="flex-1 rounded-lg bg-primary px-4 py-3 font-display text-lg text-primary-foreground transition hover:brightness-110"
          >
            Confirm and book it
          </button>
          <button
            type="button"
            onClick={() => store.resolveApproval(false, note.trim() || undefined)}
            className="rounded-lg border border-border px-5 py-3 font-display text-lg text-muted-foreground transition hover:border-rose hover:text-foreground"
          >
            Not this
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ console ---- */

function argPreview(args: unknown): string {
  if (!args || typeof args !== "object" || !Object.keys(args).length) return "";
  const s = JSON.stringify(args);
  return s.length > 54 ? `${s.slice(0, 52)}…` : s;
}
const resultText = (result: unknown) =>
  (result as { content?: { text?: string }[] } | undefined)?.content?.[0]?.text ?? "";

export function ToolConsole() {
  const { calls, narration, webmcp } = useGenie();
  const [open, setOpen] = useState<string | null>(null);

  return (
    <Panel
      className="lg:sticky lg:top-6"
      title="What your agent did"
      hint="Every tool call, as it happens. Nothing here is invisible to you."
      quiet
    >
      {narration.length ? (
        <div className="mb-4 space-y-1.5 border-l-2 border-primary/40 pl-3">
          {narration.slice(-3).map((n, i) => (
            <p
              key={`${n}-${i}`}
              className="dg-rise text-sm leading-relaxed text-foreground/90 italic"
            >
              {n}
            </p>
          ))}
        </div>
      ) : null}

      {calls.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground/70">
          {webmcp.bound
            ? "Registered and idle. Ask your agent to plan something."
            : "Press Plan it and watch."}
        </p>
      ) : (
        <ul className="dg-scroll max-h-[22rem] space-y-1 overflow-y-auto pr-1">
          {calls.map((c) => {
            const isOpen = open === c.id;
            return (
              <li key={c.id} className="dg-rise rounded-md border border-border/60 bg-ink/40">
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : c.id)}
                  className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
                >
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${c.error ? "bg-rose" : c.ms === undefined ? "dg-live-dot bg-primary" : "bg-accent"}`}
                    aria-hidden
                  />
                  <span className="truncate font-mono text-[11px] text-foreground">{c.name}</span>
                  <span className="truncate font-mono text-[10px] text-muted-foreground/60">
                    {argPreview(c.args)}
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                    {c.caller}
                    {c.ms !== undefined ? ` ${c.ms}ms` : ""}
                  </span>
                </button>
                {isOpen ? (
                  <pre className="dg-scroll max-h-56 overflow-auto border-t border-border/60 px-2.5 py-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
                    {resultText(c.result) || c.error || "…"}
                  </pre>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------ sources ---- */

export function SourcesPanel() {
  const { pool, understanding } = useGenie();
  return (
    <Panel
      title="Where this came from"
      hint="Nothing about any place is stored here. Every plan is a fresh search, issued when you asked."
      quiet
    >
      <ul className="space-y-1.5">
        {ACTIVE_ADAPTERS.map((a) => {
          const report = pool?.reports.find((r) => r.id === a.id);
          return (
            <li
              key={a.id}
              className="flex items-baseline gap-2 rounded-md border border-accent/25 bg-ink/40 px-3 py-2 text-sm"
            >
              <span
                className="size-1.5 shrink-0 translate-y-[-2px] rounded-full bg-accent"
                aria-hidden
              />
              <span className="text-foreground">{a.label}</span>
              <span className="truncate text-xs text-muted-foreground">{a.attribution}</span>
              <span className="ml-auto shrink-0 font-mono text-[10px] text-accent">
                {report
                  ? `${report.counts.restaurants}r ${report.counts.events}e ${report.ms}ms`
                  : "idle"}
              </span>
            </li>
          );
        })}
        <li className="flex items-baseline gap-2 rounded-md border border-accent/25 bg-ink/40 px-3 py-2 text-sm">
          <span
            className="size-1.5 shrink-0 translate-y-[-2px] rounded-full bg-accent"
            aria-hidden
          />
          <span className="text-foreground">Cloudflare Workers AI</span>
          <span className="truncate text-xs text-muted-foreground">
            turns your sentence into constraints
          </span>
          <span className="ml-auto shrink-0 font-mono text-[10px] text-accent">
            {understanding
              ? understanding.via === "workers-ai"
                ? "llama 3.3 70b"
                : "rules"
              : "idle"}
          </span>
        </li>
      </ul>

      <p className="mt-5 mb-2 text-sm text-foreground">Not available to any agent, anywhere.</p>
      <p className="mb-3 max-w-prose text-xs leading-relaxed text-muted-foreground">
        No major booking site exposes WebMCP tools yet, so no agent can compose them. Here is
        exactly what we would call the day they do. If you work at one of these, this is the whole
        ask.
      </p>
      <ul className="space-y-1.5">
        {WANTED_SOURCES.map((a) => (
          <li key={a.id} className="rounded-md border border-border/60 bg-ink/40 px-3 py-2">
            <div className="flex items-baseline gap-2 text-sm">
              <span
                className="size-1.5 shrink-0 translate-y-[-2px] rounded-full bg-muted-foreground"
                aria-hidden
              />
              <span className="text-foreground">{a.label}</span>
              <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                {a.provides.join(", ")}
              </span>
            </div>
            <code className="mt-1 block font-mono text-[10px] leading-relaxed text-muted-foreground/80">
              {a.wantedContract}
            </code>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/* -------------------------------------------------------- tool surface ---- */

export function ToolSurface() {
  const { webmcp } = useGenie();
  const signature = webmcp.tools.join("|");
  const tools = useMemo(() => allTools(), [signature]);
  const [open, setOpen] = useState(false);

  return (
    <Panel
      title="What your agent can do here"
      hint="Registered on the live WebMCP surface. The last two appear and disappear with page state: an agent cannot call book_approved_plan before a human has approved anything, because until then the tool does not exist."
      quiet
      right={
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 text-xs text-muted-foreground underline-offset-4 hover:underline"
        >
          {open ? "collapse" : "expand"}
        </button>
      }
    >
      <ul className="grid gap-1.5 sm:grid-cols-2">
        {tools.map((t) => (
          <li key={t.name} className="rounded-md border border-border/60 bg-ink/40 px-3 py-2">
            <div className="flex items-center gap-2">
              <code className="truncate font-mono text-[11px] text-primary">{t.name}</code>
              <span className="ml-auto shrink-0 rounded px-1 py-0.5 text-[9px] text-muted-foreground">
                {t.annotations?.readOnlyHint
                  ? "reads"
                  : t.annotations?.destructiveHint
                    ? "books"
                    : "writes"}
              </span>
            </div>
            {open ? (
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                {t.description}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
