/**
 * The shared surface, rendered.
 *
 * Every panel here is BOTH a human control and an agent-visible surface:
 * what you drag, the agent reads through `get_date_context`; what the agent
 * changes, you watch move. There is no hidden second copy of the state.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { downloadIcs } from "@/lib/date-genie/ics";
import { fmtTime, money, toMinutes, type Plan } from "@/lib/date-genie/engine";
import * as store from "@/lib/date-genie/store";
import { callTool } from "@/lib/date-genie/webmcp";
import { allTools } from "@/lib/date-genie/tools";

/* --------------------------------------------------------------- hook ---- */

const serverSnapshot = store.getState();

export function useGenie(): store.State {
  return useSyncExternalStore(store.subscribe, store.getState, () => serverSnapshot);
}

/* ------------------------------------------------------------- pieces ---- */

function Panel({
  title,
  hint,
  right,
  children,
  className = "",
}: {
  title: string;
  hint?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`surface p-4 sm:p-5 ${className}`}>
      <header className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-sm font-semibold tracking-wide text-foreground uppercase">{title}</h2>
          {hint ? <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}
        </div>
        {right}
      </header>
      {children}
    </section>
  );
}

export function StatusPill() {
  const { webmcp, inventory } = useGenie();
  const live = webmcp.bound;
  const osm = inventory.source === "openstreetmap";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        className={`rule-chip ${osm ? "border-accent/50 text-accent" : ""}`}
        title={
          osm
            ? "Venue names, coordinates, cuisines and diet tags are fetched live from OpenStreetMap. Prices, ratings and table availability are simulated."
            : "OpenStreetMap was unreachable, so the curated seed inventory is in use."
        }
      >
        {inventory.loading ? (
          <>
            <span className="size-1.5 rounded-full bg-primary dg-live-dot" aria-hidden />
            loading Arlington…
          </>
        ) : osm ? (
          <>
            <span className="size-1.5 rounded-full bg-accent" aria-hidden />
            {inventory.restaurants} venues live from OpenStreetMap
          </>
        ) : (
          <>{inventory.restaurants} seed venues</>
        )}
      </span>
      <span
        className="rule-chip"
        title={live ? `Tools registered on ${webmcp.surface}` : "No WebMCP host detected. The page still works, and the built-in agent drives the identical tools"}
      >
        <span
          className={`size-1.5 rounded-full ${live ? "bg-accent dg-live-dot" : "bg-muted-foreground"}`}
          aria-hidden
        />
        {live ? webmcp.surface : "WebMCP host not detected"}
      </span>
      <span className="rule-chip">{webmcp.tools.length} tools live</span>
      {webmcp.agentSeen ? (
        <span className="rule-chip border-accent/50 text-accent">agent connected</span>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------- command bar ---- */

export function CommandBar({ onRun, samples }: { onRun: (text: string) => void; samples: string[] }) {
  const { demoRunning, thinking } = useGenie();
  const [text, setText] = useState(samples[0] ?? "");
  const busy = demoRunning || thinking;

  return (
    <div className="surface glow-ring p-4 sm:p-5">
      <label htmlFor="wish" className="mb-2 block font-display text-xs font-semibold tracking-widest text-primary uppercase">
        Say it once
      </label>
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
          className="dg-scroll min-h-[4.5rem] flex-1 resize-none rounded-xl border border-input bg-ink/60 px-4 py-3 font-sans text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/70 focus:ring-2 focus:ring-primary/25"
          placeholder="Plan something fun for Friday, under $180, nothing before 7…"
        />
        <button
          type="button"
          onClick={() => onRun(text)}
          disabled={busy || !text.trim()}
          className="dg-pulse h-fit shrink-0 self-stretch rounded-xl bg-primary px-6 py-3 font-display text-sm font-bold tracking-wide text-primary-foreground transition disabled:cursor-not-allowed disabled:opacity-50 sm:self-auto"
        >
          {busy ? "Working…" : "Grant the wish"}
        </button>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {samples.slice(1).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setText(s)}
            className="rule-chip max-w-full text-left transition hover:border-primary/60 hover:text-foreground"
          >
            <span className="truncate">{s.length > 58 ? `${s.slice(0, 56)}…` : s}</span>
          </button>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        In a WebMCP browser, say this to your agent instead. It calls the same tools this button does.
        <kbd className="ml-2 rounded border border-border px-1.5 py-0.5 font-mono text-[10px]">⌘↵</kbd>
      </p>
    </div>
  );
}

/* ----------------------------------------------------- constraint deck ---- */

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
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="font-mono text-xs font-medium text-foreground">{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
      />
    </label>
  );
}

export function ConstraintDeck() {
  const { constraints: c, vetoes, place, inventory } = useGenie();
  const [newVeto, setNewVeto] = useState("");
  const [where, setWhere] = useState("");

  const patch = useCallback((next: Partial<typeof c>) => store.replan({ ...c, ...next }), [c]);

  return (
    <Panel
      title="Your rules"
      hint="Set these with your thumb. Your agent reads every value here before it asks you a single question."
    >
      <form
        className="mb-4 border-b border-border pb-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!where.trim()) return;
          void callTool("set_location", { place: where.trim() }, "you");
          setWhere("");
        }}
      >
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <span className="text-xs text-muted-foreground">Tonight you are in</span>
          {inventory.loading ? <span className="font-mono text-[10px] text-primary dg-live-dot">loading…</span> : null}
        </div>
        <p className="mb-2 truncate font-display text-sm font-semibold text-foreground" title={place.label}>
          {place.label}
        </p>
        <div className="flex gap-2">
          <input
            value={where}
            onChange={(e) => setWhere(e.target.value)}
            placeholder="Fredericksburg, VA"
            className="min-w-0 flex-1 rounded-lg border border-input bg-ink/60 px-3 py-1.5 text-xs outline-none focus:border-primary/70"
          />
          <button
            type="submit"
            disabled={inventory.loading}
            className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition hover:border-primary hover:text-foreground disabled:opacity-50"
          >
            Move
          </button>
        </div>
        {inventory.notice ? (
          <p className="mt-2 text-[11px] leading-relaxed text-destructive">{inventory.notice}</p>
        ) : (
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/70">
            Geocoded with OpenStreetMap, then every venue within about 4 miles is refetched. Anywhere in the world.
          </p>
        )}
      </form>

      <div className="space-y-4">
        <Dial label="Whole evening, all in" value={c.budget} display={money(c.budget)} min={40} max={400} step={5} onChange={(budget) => patch({ budget })} />
        <Dial
          label="Nothing before"
          value={toMinutes(c.earliest)}
          display={fmtTime(c.earliest)}
          min={16 * 60}
          max={21 * 60}
          step={15}
          onChange={(m) => patch({ earliest: `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}` })}
        />
        <Dial
          label="Home by"
          value={toMinutes(c.latestEnd)}
          display={fmtTime(c.latestEnd)}
          min={21 * 60}
          max={23 * 60 + 59}
          step={15}
          onChange={(m) => patch({ latestEnd: `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}` })}
        />
        <Dial label="Drive from home" value={c.maxDriveMinutes} display={`${c.maxDriveMinutes} min`} min={5} max={45} onChange={(maxDriveMinutes) => patch({ maxDriveMinutes })} />
        <Dial label="Walk between stops" value={c.maxWalkMinutes} display={`${c.maxWalkMinutes} min`} min={2} max={25} onChange={(maxWalkMinutes) => patch({ maxWalkMinutes })} />

        <div>
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="text-xs text-muted-foreground">Party</span>
            <span className="font-mono text-xs font-medium text-foreground">{c.party}</span>
          </div>
          <div className="flex gap-1.5">
            {[2, 3, 4, 6].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => patch({ party: n })}
                className={`flex-1 rounded-lg border py-1.5 font-mono text-xs transition ${
                  c.party === n ? "border-primary bg-primary/15 text-foreground" : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-5 border-t border-border pt-4">
        <p className="mb-2 text-xs text-muted-foreground">
          Never again. Saved in this browser, and the genie honours these on your next visit too.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {vetoes.length === 0 ? <span className="text-xs text-muted-foreground/70">Nothing ruled out yet.</span> : null}
          {vetoes.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => {
                store.removeVeto(v);
                store.replan();
              }}
              className="rule-chip border-destructive/40 text-foreground transition hover:border-destructive"
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
            placeholder="oysters, loud, korean…"
            className="min-w-0 flex-1 rounded-lg border border-input bg-ink/60 px-3 py-1.5 text-xs outline-none focus:border-primary/70"
          />
          <button type="submit" className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition hover:border-primary hover:text-foreground">
            Rule out
          </button>
        </form>
      </div>
    </Panel>
  );
}

/* --------------------------------------------------------------- stage ---- */

function Leg({ leg, index }: { leg: Plan["legs"][number]; index: number }) {
  return (
    <li className="dg-rise relative flex gap-4 pb-6 last:pb-0" style={{ animationDelay: `${index * 90}ms` }}>
      <div className="flex w-14 shrink-0 flex-col items-end pt-1">
        <span className="font-mono text-xs font-semibold text-foreground">{fmtTime(leg.start)}</span>
        <span className="font-mono text-[10px] text-muted-foreground">{fmtTime(leg.end)}</span>
      </div>
      <div className="relative flex flex-col items-center">
        <span
          className={`z-10 grid size-9 place-items-center rounded-full border text-base ${
            leg.kind === "parking" ? "border-border bg-secondary" : "border-primary/50 bg-primary/15"
          }`}
        >
          {leg.glyph}
        </span>
        <span className="dg-rail absolute top-9 bottom-0 w-px" aria-hidden />
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="truncate font-display text-base font-semibold text-foreground">{leg.title}</h3>
          <span className="shrink-0 font-mono text-sm text-primary">{money(leg.cost)}</span>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{leg.subtitle}</p>
        <p className="mt-1 text-xs text-muted-foreground/70">{leg.detail}</p>
      </div>
    </li>
  );
}

function ChecksTable({ checks }: { checks: store.State["checks"] }) {
  if (!checks.length) return null;
  return (
    <div className="mt-5 border-t border-border pt-4">
      <p className="mb-2 font-display text-xs font-semibold tracking-widest text-muted-foreground uppercase">
        Every rule you set, checked
      </p>
      <ul className="grid gap-1.5 sm:grid-cols-2">
        {checks.map((c) => (
          <li key={c.label} className="flex items-center gap-2 text-xs">
            <span className={`grid size-4 shrink-0 place-items-center rounded-full text-[9px] font-bold ${c.ok ? "bg-accent/20 text-accent" : "bg-destructive/20 text-destructive"}`}>
              {c.ok ? "✓" : "✕"}
            </span>
            <span className="text-muted-foreground">{c.label}</span>
            <span className="ml-auto font-mono text-foreground">{c.actual}</span>
            <span className="font-mono text-muted-foreground/60">/ {c.target}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Stage() {
  const { plan, alternates, checks, considered, booking, thinking, revision, trace, relaxations } = useGenie();
  const [showTrace, setShowTrace] = useState(false);

  if (booking) return <Receipt />;

  if (!plan) {
    return (
      <Panel title="The evening" hint="Nothing planned yet.">
        <div className="py-12 text-center">
          <p className="font-display text-lg text-muted-foreground">
            {thinking ? <span className="dg-shimmer">Composing…</span> : "Say what you want. Once."}
          </p>
          <p className="mx-auto mt-2 max-w-sm text-xs text-muted-foreground/70">
            {trace.length
              ? trace[trace.length - 1]
              : "Dinner, something after, and somewhere to park, solved together, not one tab at a time."}
          </p>
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title="The evening"
      hint={`One plan, not ten links. ${considered} combinations were evaluated; this is the only kind that survived.`}
      right={
        <div className="text-right">
          <div className="font-display text-2xl font-bold text-primary">{money(plan.total)}</div>
          <div className="text-[10px] tracking-wide text-muted-foreground uppercase">
            {money(plan.constraints.budget - plan.total)} under budget
          </div>
        </div>
      }
    >
      <ol key={revision} className="relative">
        {plan.legs.map((leg, i) => (
          <Leg key={`${leg.kind}-${leg.id}-${revision}`} leg={leg} index={i} />
        ))}
      </ol>

      {relaxations.length ? (
        <p className="mt-1 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-xs leading-relaxed text-foreground">
          <span className="font-semibold">Not an exact match. </span>
          Nothing here fit your exact rules, so the genie widened{" "}
          {relaxations.map((r, i) => (
            <span key={r.label}>
              {i > 0 ? " and " : ""}
              <span className="text-primary">{r.label}</span> from {r.from} to {r.to}
            </span>
          ))}
          . Everything else still holds.
        </p>
      ) : null}

      <p className="mt-1 rounded-lg border border-border bg-ink/40 px-3 py-2 text-xs text-muted-foreground">
        <span className="text-foreground">Why this one: </span>
        {plan.why.join(" · ")}
      </p>

      <ChecksTable checks={checks} />

      {alternates.length ? (
        <div className="mt-5 border-t border-border pt-4">
          <p className="mb-2 font-display text-xs font-semibold tracking-widest text-muted-foreground uppercase">
            Or, genuinely different
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {alternates.map((alt, i) => (
              <button
                key={alt.id}
                type="button"
                onClick={() => void callTool("pick_alternate", { which: i + 1 }, "you")}
                className="rounded-xl border border-border bg-ink/40 p-3 text-left transition hover:border-primary/60"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-display text-sm font-semibold text-foreground">
                    {alt.dinner.restaurant.glyph} {alt.dinner.restaurant.name}
                  </span>
                  <span className="font-mono text-xs text-primary">{money(alt.total)}</span>
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  then {alt.event.event.glyph} {alt.event.event.name}
                </p>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <button
          type="button"
          onClick={() => void callTool("request_approval", { note: "Holds the table, the tickets and the spot." }, "you")}
          className="rounded-xl bg-primary px-5 py-2.5 font-display text-sm font-bold text-primary-foreground transition hover:brightness-110"
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
        <button type="button" onClick={() => setShowTrace((v) => !v)} className="ml-auto text-xs text-muted-foreground underline-offset-4 hover:underline">
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

/* ------------------------------------------------------------- receipt ---- */

function Receipt() {
  const { booking, plan } = useGenie();
  if (!booking) return null;
  return (
    <Panel
      title="Booked"
      hint="Three reservations, one call, one confirmation. Nothing here was booked without you pressing a button."
      right={<div className="font-mono text-xs text-accent">{booking.confirmation}</div>}
    >
      <ul className="space-y-3">
        {booking.lines.map((l, i) => (
          <li key={l.confirmation} className="dg-rise flex items-start gap-3 rounded-xl border border-border bg-ink/40 p-3" style={{ animationDelay: `${i * 110}ms` }}>
            <div className="min-w-0 flex-1">
              <div className="truncate font-display text-sm font-semibold text-foreground">{l.label}</div>
              <div className="text-xs text-muted-foreground">{l.detail}</div>
              <div className="mt-1 font-mono text-[11px] text-accent">{l.confirmation}</div>
            </div>
            <span className="font-mono text-sm text-primary">{money(l.cost)}</span>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex items-center justify-between border-t border-border pt-4">
        <span className="text-xs text-muted-foreground">Total charged on arrival</span>
        <span className="font-display text-xl font-bold text-primary">{money(booking.total)}</span>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => plan && downloadIcs(plan, booking)}
          className="rounded-xl bg-accent px-4 py-2 font-display text-sm font-bold text-accent-foreground transition hover:brightness-110"
        >
          Add all three to calendar
        </button>
        <button type="button" onClick={() => store.reset()} className="rule-chip transition hover:border-primary/60 hover:text-foreground">
          Plan another night
        </button>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------- approval gate ---- */

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
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/70 p-3 backdrop-blur-sm sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Confirm booking"
    >
      <div className="dg-rise glow-ring w-full max-w-lg rounded-2xl border border-primary/40 bg-card p-5 shadow-2xl">
        <div className="flex items-center gap-2">
          <span className="size-2 rounded-full bg-primary dg-live-dot" aria-hidden />
          <p className="font-display text-xs font-semibold tracking-widest text-primary uppercase">
            Your agent is waiting on you
          </p>
        </div>
        <p className="mt-3 font-display text-lg leading-snug font-semibold text-foreground">{approval.summary}</p>
        <p className="mt-1 font-mono text-sm text-primary">{money(approval.total)} total</p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          The tool call is suspended right now. It has no timeout and no default. It resolves when you press one of
          these, and not before.
        </p>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional: tell it why (goes back to the agent)"
          className="mt-3 w-full rounded-lg border border-input bg-ink/60 px-3 py-2 text-xs outline-none focus:border-primary/70"
        />
        <div className="mt-4 flex gap-2">
          <button
            ref={ref}
            type="button"
            onClick={() => store.resolveApproval(true, note.trim() || undefined)}
            className="flex-1 rounded-xl bg-primary px-4 py-3 font-display text-sm font-bold text-primary-foreground transition hover:brightness-110"
          >
            Confirm and book it
          </button>
          <button
            type="button"
            onClick={() => store.resolveApproval(false, note.trim() || undefined)}
            className="rounded-xl border border-border px-4 py-3 font-display text-sm font-semibold text-muted-foreground transition hover:border-destructive hover:text-foreground"
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
  return s.length > 68 ? `${s.slice(0, 66)}…` : s;
}

function resultText(result: unknown): string {
  const r = result as { content?: { text?: string }[] } | undefined;
  return r?.content?.[0]?.text ?? "";
}

export function ToolConsole() {
  const { calls, narration, webmcp } = useGenie();
  const [open, setOpen] = useState<string | null>(null);

  return (
    <Panel
      title="Agent console"
      hint="Every tool call, as it happens. Nothing your agent does here is invisible to you."
      right={<span className="font-mono text-[10px] text-muted-foreground">{calls.length}</span>}
    >
      {narration.length ? (
        <div className="mb-4 space-y-1.5">
          {narration.slice(-3).map((n, i) => (
            <p key={`${n}-${i}`} className="dg-rise text-xs leading-relaxed text-foreground/90 italic">
              {n}
            </p>
          ))}
        </div>
      ) : null}

      {calls.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground/70">
          {webmcp.bound
            ? "Registered and idle. Ask your agent to plan something."
            : "No calls yet. Press Grant the wish and watch."}
        </p>
      ) : (
        <ul className="dg-scroll max-h-[26rem] space-y-1.5 overflow-y-auto pr-1">
          {calls.map((c) => {
            const isOpen = open === c.id;
            return (
              <li key={c.id} className="dg-rise rounded-lg border border-border bg-ink/40">
                <button type="button" onClick={() => setOpen(isOpen ? null : c.id)} className="flex w-full items-center gap-2 px-2.5 py-2 text-left">
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${
                      c.error ? "bg-destructive" : c.ms === undefined ? "bg-primary dg-live-dot" : "bg-accent"
                    }`}
                    aria-hidden
                  />
                  <span className="truncate font-mono text-[11px] text-foreground">{c.name}</span>
                  <span className="truncate font-mono text-[10px] text-muted-foreground/60">{argPreview(c.args)}</span>
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                    {c.caller === "agent" ? "agent" : c.caller === "you" ? "you" : "demo"}
                    {c.ms !== undefined ? ` · ${c.ms}ms` : " · …"}
                  </span>
                </button>
                {isOpen ? (
                  <pre className="dg-scroll max-h-56 overflow-auto border-t border-border px-2.5 py-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
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

/* -------------------------------------------------------- tool surface ---- */

export function ToolSurface() {
  const { webmcp } = useGenie();
  const tools = useMemo(() => allTools(), [webmcp.tools.join("|")]);
  const [open, setOpen] = useState(false);

  return (
    <Panel
      title="What your agent can do here"
      hint="These are registered on the live WebMCP surface. The last two appear and disappear with page state. An agent cannot call book_approved_plan before a human has approved anything, because until then the tool does not exist."
      right={
        <button type="button" onClick={() => setOpen((v) => !v)} className="text-xs text-muted-foreground underline-offset-4 hover:underline">
          {open ? "collapse" : "expand"}
        </button>
      }
    >
      <ul className="grid gap-1.5 sm:grid-cols-2">
        {tools.map((t) => (
          <li key={t.name} className="rounded-lg border border-border bg-ink/40 px-2.5 py-2">
            <div className="flex items-center gap-2">
              <code className="truncate font-mono text-[11px] text-primary">{t.name}</code>
              {t.annotations?.readOnlyHint ? (
                <span className="shrink-0 rounded bg-secondary px-1 py-0.5 text-[9px] text-muted-foreground">read</span>
              ) : t.annotations?.destructiveHint ? (
                <span className="shrink-0 rounded bg-destructive/20 px-1 py-0.5 text-[9px] text-destructive">books</span>
              ) : (
                <span className="shrink-0 rounded bg-primary/15 px-1 py-0.5 text-[9px] text-primary">writes</span>
              )}
            </div>
            {open ? <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{t.description}</p> : null}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
