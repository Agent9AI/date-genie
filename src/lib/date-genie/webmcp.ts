/**
 * WebMCP binding layer.
 *
 * WebMCP is a moving target right now. Depending on which browser build a judge,
 * a user or an agent arrives in, the same capability lives in a different place:
 *
 *   navigator.modelContext          Chrome 149 origin trial (deprecated in 150)
 *   document.modelContext           current spec, tools belong to a document
 *   window.modelContext             some polyfills and extension shims
 *   navigator.modelContextTesting   Chrome's testing/driver surface
 *
 * and registration is either per-tool (`registerTool`) or batched
 * (`provideContext({ tools })`).
 *
 * So this file does not pick a winner. It probes every known surface, binds to
 * the first that works, registers through whichever calling convention exists,
 * and keeps the registered tool set in sync with page state so the agent's
 * toolbox always matches what is genuinely possible right now.
 *
 * Everything is also mirrored on `window.dateGenie` so an extension, an E2E
 * test, or this page's own built-in agent can drive the identical code path.
 * There is exactly one implementation of every tool.
 */
import { allTools, type DateGenieTool, type ModelContextClient, type ToolResult } from "./tools";
import * as store from "./store";

type RegisterFn = (tool: unknown, options?: unknown) => unknown;

type ModelContextLike = {
  registerTool?: RegisterFn;
  unregisterTool?: (name: string) => unknown;
  provideContext?: (init: { tools: unknown[] }) => unknown;
  getTools?: () => Promise<unknown[]> | unknown[];
  executeTool?: (name: unknown, input?: unknown) => Promise<unknown>;
};

type Surface = { name: string; mc: ModelContextLike };

/** Every place the browser might be hiding the model-context object. */
function probeSurfaces(): Surface[] {
  if (typeof window === "undefined") return [];
  const w = window as unknown as Record<string, unknown>;
  const nav = navigator as unknown as Record<string, unknown>;
  const doc = document as unknown as Record<string, unknown>;
  const found: Surface[] = [];
  const push = (name: string, candidate: unknown) => {
    if (!candidate || typeof candidate !== "object") return;
    const mc = candidate as ModelContextLike;
    if (typeof mc.registerTool === "function" || typeof mc.provideContext === "function") found.push({ name, mc });
  };
  push("document.modelContext", doc["modelContext"]);
  push("navigator.modelContext", nav["modelContext"]);
  push("window.modelContext", w["modelContext"]);
  push("navigator.modelContextTesting", nav["modelContextTesting"]);
  return found;
}

/**
 * Wrap a tool so that every invocation (from a real agent, from the page's own
 * demo agent, or from a test) lands in the visible console with timing. The
 * human should never have to wonder what their agent just did.
 */
function instrument(tool: DateGenieTool, caller: store.ToolCall["caller"]) {
  return async (rawInput: unknown, client?: ModelContextClient): Promise<ToolResult> => {
    const input = (rawInput ?? {}) as Record<string, unknown>;
    const id = `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const started = performance.now();
    store.logCall({ id, name: tool.name, args: input, at: Date.now(), caller });
    if (caller === "agent" && !store.getState().webmcp.agentSeen) {
      store.set((s) => ({ webmcp: { ...s.webmcp, agentSeen: true } }));
    }
    try {
      const result = await tool.execute(input, client);
      store.patchCall(id, {
        result,
        ms: Math.round(performance.now() - started),
        ...(result.isError ? { error: result.content[0]?.text ?? "error" } : {}),
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.patchCall(id, { error: message, ms: Math.round(performance.now() - started) });
      return { content: [{ type: "text", text: `Tool threw: ${message}` }], isError: true };
    }
  };
}

/** Shape a tool the way the host expects, keeping annotations when supported. */
function toDescriptor(tool: DateGenieTool, caller: store.ToolCall["caller"]) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
    execute: instrument(tool, caller),
  };
}

let bound: Surface | null = null;
let registered = new Map<string, unknown>();
let unsubscribe: (() => void) | null = null;

function registerAll(tools: DateGenieTool[]) {
  if (!bound) return;
  const { mc } = bound;
  const descriptors = tools.map((t) => toDescriptor(t, "agent"));

  // Batch convention: hand over the whole set, replacing whatever was there.
  if (typeof mc.provideContext === "function" && typeof mc.registerTool !== "function") {
    mc.provideContext({ tools: descriptors });
    registered = new Map(tools.map((t) => [t.name, true]));
    return;
  }

  // Per-tool convention: add what is new, drop what no longer applies.
  const want = new Set(tools.map((t) => t.name));
  for (const name of [...registered.keys()]) {
    if (want.has(name)) continue;
    try {
      mc.unregisterTool?.(name);
    } catch {
      /* host may not support removal; a stale tool still guards itself */
    }
    registered.delete(name);
  }
  for (const d of descriptors) {
    if (registered.has(d.name)) continue;
    try {
      mc.registerTool?.(d);
      registered.set(d.name, true);
    } catch (err) {
      // InvalidStateError means a same-named tool is already there. Fine.
      if (!(err instanceof Error) || !/already/i.test(err.message)) console.warn("[date-genie] registerTool failed", d.name, err);
      registered.set(d.name, true);
    }
  }
}

export type BindResult = {
  bound: boolean;
  surface: string;
  toolNames: string[];
  dispose: () => void;
};

export function bindWebMcp(): BindResult {
  const surfaces = probeSurfaces();
  bound = surfaces[0] ?? null;

  const sync = () => {
    const tools = allTools();
    registerAll(tools);
    const names = tools.map((t) => t.name);
    const prev = store.getState().webmcp;
    if (prev.tools.join("|") !== names.join("|") || prev.bound !== !!bound) {
      store.set({ webmcp: { ...prev, bound: !!bound, surface: bound?.name ?? "none", tools: names } });
    }
  };

  sync();

  // Conditional tools appear and disappear with page state, so re-sync on every
  // store change. This is what makes `book_approved_plan` literally
  // non-existent until a human has approved something.
  let lastSignature = "";
  unsubscribe = store.subscribe(() => {
    const s = store.getState();
    const signature = `${s.approval.status}|${s.booking ? "booked" : "open"}`;
    if (signature === lastSignature) return;
    lastSignature = signature;
    sync();
  });

  // Always expose the same implementations locally: the built-in demo agent,
  // Playwright, a browser extension and a real WebMCP client all execute the
  // identical functions, so nothing in the demo is a special case.
  const local = Object.fromEntries(allTools().map((t) => [t.name, instrument(t, "demo")]));
  (window as unknown as Record<string, unknown>)["dateGenie"] = {
    ...local,
    listTools: () => allTools().map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })),
    call: async (name: string, input: Record<string, unknown> = {}, caller: store.ToolCall["caller"] = "demo") => {
      const tool = allTools().find((t) => t.name === name);
      if (!tool) throw new Error(`No such tool: ${name}`);
      return instrument(tool, caller)(input);
    },
    getState: store.getState,
  };

  return {
    bound: !!bound,
    surface: bound?.name ?? "none",
    toolNames: allTools().map((t) => t.name),
    dispose: () => {
      unsubscribe?.();
      unsubscribe = null;
      if (bound?.mc.unregisterTool) for (const name of registered.keys()) try { bound.mc.unregisterTool(name); } catch { /* ignore */ }
      registered.clear();
      delete (window as unknown as Record<string, unknown>)["dateGenie"];
      bound = null;
    },
  };
}

/** Call a tool through the same instrumented path the agent uses. */
export async function callTool(name: string, input: Record<string, unknown> = {}, caller: store.ToolCall["caller"] = "demo"): Promise<ToolResult> {
  const tool = allTools().find((t) => t.name === name);
  if (!tool) throw new Error(`No such tool: ${name}`);
  return instrument(tool, caller)(input);
}
