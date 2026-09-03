/**
 * Turning a sentence into constraints.
 *
 * Two implementations, in order of preference:
 *
 *   1. Cloudflare Workers AI, at the edge, via /api/understand. Handles the
 *      things regular expressions are bad at: "somewhere we can actually hear
 *      each other", "she's vegetarian but I'm not", "nothing too far after".
 *   2. The regex parser in engine.ts, which always runs first as a floor.
 *
 * The model's output is layered ON TOP of the regex result, and every value is
 * validated before it is accepted. A model that returns budget: 4000 for a
 * request that said $180 gets ignored, because the regex already found 180 and
 * the validator rejects a number that appears nowhere in the text.
 *
 * The model never selects a venue and never computes a total. That stays in the
 * planner, where it can be audited.
 */
import { DEFAULT_CONSTRAINTS, activityInterests, cuisineInterests, extractLocation, parseRequest, type Constraints } from "./engine";

export type Understanding = {
  constraints: Constraints;
  location: string | null;
  occasion: string | null;
  /** Which layer produced the result, surfaced in the UI and to agents. */
  via: "workers-ai" | "rules";
  model?: string;
};

type RawConstraints = {
  location?: string | null;
  budget?: number | null;
  earliest?: string | null;
  latestEnd?: string | null;
  party?: number | null;
  maxDriveMinutes?: number | null;
  maxWalkMinutes?: number | null;
  interests?: unknown;
  cuisines?: unknown;
  activities?: unknown;
  avoid?: unknown;
  dietary?: unknown;
  noisePreference?: string | null;
  occasion?: string | null;
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const isNum = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim().toLowerCase()))] : [];

/**
 * Accept a model's number only if the digits actually appear in what the human
 * wrote. This is the cheapest possible hallucination guard and it catches the
 * failure that matters most: a budget nobody asked for.
 */
const groundedIn = (text: string, value: number) => new RegExp(`\\b${Math.round(value)}\\b`).test(text.replace(/,/g, ""));

function applyRaw(base: Constraints, raw: RawConstraints, text: string): Constraints {
  const next: Constraints = { ...base, interests: [...base.interests], avoid: [...base.avoid], dietary: [...base.dietary] };

  if (isNum(raw.budget, 10, 5000) && groundedIn(text, raw.budget)) next.budget = raw.budget;
  if (isNum(raw.party, 1, 20)) next.party = raw.party;
  if (isNum(raw.maxDriveMinutes, 1, 180) && groundedIn(text, raw.maxDriveMinutes)) next.maxDriveMinutes = raw.maxDriveMinutes;
  if (isNum(raw.maxWalkMinutes, 1, 60) && groundedIn(text, raw.maxWalkMinutes)) next.maxWalkMinutes = raw.maxWalkMinutes;
  if (typeof raw.earliest === "string" && HHMM.test(raw.earliest)) next.earliest = raw.earliest;
  if (typeof raw.latestEnd === "string" && HHMM.test(raw.latestEnd)) next.latestEnd = raw.latestEnd;
  if (raw.noisePreference === "quiet" || raw.noisePreference === "moderate" || raw.noisePreference === "loud")
    next.noisePreference = raw.noisePreference;

  next.interests = [
    ...new Set([...next.interests, ...strings(raw.interests), ...strings(raw.cuisines), ...strings(raw.activities)]),
  ];
  next.avoid = [...new Set([...next.avoid, ...strings(raw.avoid)])];
  next.dietary = [...new Set([...next.dietary, ...strings(raw.dietary)])].filter((d) =>
    ["vegan", "vegetarian", "gluten-free"].includes(d),
  );

  // Whatever they ruled out cannot also be something they want, no matter which
  // layer suggested it.
  next.interests = next.interests.filter((i) => !next.avoid.some((a) => a.includes(i) || i.includes(a)));

  // Collapse everything to the canonical vocabulary the search can actually use,
  // so "korean food" and "Movie?" become "korean" and "film".
  next.interests = [...new Set([...cuisineInterests(next), ...activityInterests(next)])];

  // An occasion does not change the ceiling, it changes where in the range a
  // good answer sits. Nobody sets aside $300 for an anniversary hoping to be
  // handed a $102 evening.
  if (typeof raw.occasion === "string" && /anniversar|birthday|engage|proposal|celebrat/i.test(raw.occasion)) {
    next.spendTarget = 0.85;
  }
  return next;
}

export async function understandRequest(text: string, base?: Constraints, timeoutMs = 9000): Promise<Understanding> {
  // The rules run first and always. Whatever the model says is layered on top.
  const floor = parseRequest(text, base ?? DEFAULT_CONSTRAINTS);
  const fallback: Understanding = { constraints: floor, location: extractLocation(text), occasion: null, via: "rules" };

  try {
    const res = await fetch("/api/understand", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return fallback;
    const body = (await res.json()) as { constraints?: RawConstraints; model?: string; unavailable?: string };
    if (body.unavailable || !body.constraints) return fallback;

    const raw = body.constraints;
    return {
      constraints: applyRaw(floor, raw, text),
      location: (typeof raw.location === "string" && raw.location.trim()) || extractLocation(text),
      occasion: typeof raw.occasion === "string" ? raw.occasion : null,
      via: "workers-ai",
      ...(body.model ? { model: body.model } : {}),
    };
  } catch {
    return fallback;
  }
}
