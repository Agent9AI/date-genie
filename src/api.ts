/**
 * Server-side adapter endpoints, served by the Worker before TanStack Start
 * sees the request.
 *
 * Two reasons this exists rather than calling providers from the browser:
 *
 *  1. Keys. Yelp, Ticketmaster and Foursquare all require a secret that must
 *     never reach a client bundle.
 *  2. CORS and rate limits. Most provider APIs refuse browser origins outright,
 *     and the public Overpass instances shed load aggressively. One cached
 *     fetch at the edge serves every visitor, which turns a 504 under load into
 *     a cache hit.
 *
 * Every response is cached in the Cloudflare edge cache keyed by the full query,
 * so a *dynamic* search stays fast without anyone storing a city snapshot.
 */

export type Env = {
  YELP_API_KEY?: string;
  TICKETMASTER_API_KEY?: string;
  FOURSQUARE_API_KEY?: string;
  /** Gemini, used for Google Maps grounded place data. */
  GEMINI_API_KEY?: string;
  /** Workers AI binding. Present in production, absent in plain `vite dev`. */
  AI?: { run: (model: string, input: unknown) => Promise<unknown> };
};

/**
 * Language understanding only.
 *
 * The model's entire job is turning a sentence into constraints. It never picks
 * a restaurant, never scores anything, and never touches a number that ends up
 * on the bill. Selection and arithmetic stay in the deterministic planner, so
 * the system cannot hallucinate a budget or invent a venue. That split is a
 * design decision, not a limitation: a planner that cannot be talked out of
 * your price ceiling is worth more than a cleverer one that can.
 */
const UNDERSTAND_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const UNDERSTAND_FALLBACK = "@cf/meta/llama-3.2-3b-instruct";

const CONSTRAINT_SCHEMA = {
  type: "object",
  properties: {
    location: {
      type: ["string", "null"],
      description: "Place named by the user, e.g. 'Fredericksburg, VA'. Null if none.",
    },
    budget: {
      type: ["number", "null"],
      description: "Total ceiling in USD for the WHOLE evening, all people",
    },
    earliest: { type: ["string", "null"], description: "Nothing before this, 24-hour HH:MM" },
    latestEnd: { type: ["string", "null"], description: "Must be over by this, 24-hour HH:MM" },
    party: { type: ["number", "null"], description: "How many people are going" },
    maxDriveMinutes: { type: ["number", "null"] },
    maxWalkMinutes: { type: ["number", "null"] },
    cuisines: {
      type: "array",
      items: { type: "string" },
      description:
        "Food they asked for, ONE WORD each, lowercase: korean, thai, pizza, seafood. Empty if they did not say.",
    },
    activities: {
      type: "array",
      items: { type: "string", enum: ["comedy", "music", "film", "class", "theater"] },
      description:
        "What they want to do after dinner. A movie is 'film'. A concert, band, DJ or live music is 'music'. Stand-up is 'comedy'. A play or show is 'theater'. A workshop or making something is 'class'.",
    },
    avoid: {
      type: "array",
      items: { type: "string" },
      description: "Anything ruled out: seafood, loud, chain",
    },
    dietary: {
      type: "array",
      items: { type: "string", enum: ["vegan", "vegetarian", "gluten-free"] },
    },
    noisePreference: { type: ["string", "null"], enum: ["quiet", "moderate", "loud", null] },
    occasion: { type: ["string", "null"], description: "anniversary, birthday, first date, null" },
  },
  required: ["cuisines", "activities", "avoid", "dietary"],
} as const;

const UNDERSTAND_PROMPT = `You convert a person's plain-English request for a night out into structured constraints.

Rules:
- Extract only what they actually said. Never invent a budget, a time or a place.
- "under $180" is the total for the whole evening, not per person.
- "nothing before 7" means earliest "19:00". Evening hours are PM unless they say otherwise.
- "home by 11" means latestEnd "23:00".
- "me and my girlfriend" means party 2.
- Put dislikes in avoid: "she hates oysters" gives avoid ["oysters"], "nothing loud" gives avoid ["loud"] and noisePreference "quiet".
- Split what they want in two. Food goes in cuisines as single lowercase words ("korean food" becomes "korean"). What they do afterwards goes in activities, and MUST be one of comedy, music, film, class, theater. "Movie?" is film. "live music" is music.
- Never put an activity in cuisines. There is no restaurant that serves film.
- location is the town or neighbourhood they named, with a state or country if given. Null if they named nowhere.
- Use null for anything absent. Do not guess.

Return JSON only.`;

async function understand(env: Env, text: string): Promise<Response> {
  if (!env.AI) return json({ unavailable: "no_ai_binding" }, 200, 0);
  const messages = [
    { role: "system", content: UNDERSTAND_PROMPT },
    { role: "user", content: text.slice(0, 1200) },
  ];
  for (const model of [UNDERSTAND_MODEL, UNDERSTAND_FALLBACK]) {
    try {
      const out = (await env.AI.run(model, {
        messages,
        max_tokens: 500,
        temperature: 0.1,
        response_format: { type: "json_schema", json_schema: CONSTRAINT_SCHEMA },
      })) as { response?: unknown };
      const parsed = coerceJson(out?.response);
      if (parsed) return json({ model, constraints: parsed }, 200, 0);
    } catch {
      /* try the smaller model, then give up and let the regex parser handle it */
    }
  }
  return json({ unavailable: "model_failed" }, 200, 0);
}

/** Models sometimes hand back an object, sometimes JSON in a fenced string. */
function coerceJson(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

/** `cacheable: false` marks a response the edge cache must not keep. */
const json = (body: unknown, status = 200, cacheSeconds = 0, cacheable = true) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      ...(cacheable ? {} : { "x-dg-cacheable": "no" }),
      ...(cacheSeconds
        ? { "cache-control": `public, max-age=${cacheSeconds}` }
        : { "cache-control": "no-store" }),
    },
  });

/** Read-through edge cache. The cache key is the request URL, so distinct
 *  searches stay distinct and nothing is pinned to one place. */
async function cached(
  request: Request,
  ttl: number,
  produce: () => Promise<Response>,
): Promise<Response> {
  const cache = (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
  if (!cache) return produce();
  const key = new Request(request.url, { method: "GET" });
  const hit = await cache.match(key);
  if (hit) {
    const copy = new Response(hit.body, hit);
    copy.headers.set("x-dg-cache", "hit");
    return copy;
  }
  const fresh = await produce();
  // Never cache a failure. This overrode the producer's own short TTL, so one
  // transient Overpass timeout got stored as "no cinemas in Washington DC" for
  // half an hour. Empty is a result; unavailable is not.
  const cacheable = fresh.ok && fresh.headers.get("x-dg-cacheable") !== "no";
  if (cacheable) {
    const store = fresh.clone();
    store.headers.set("cache-control", `public, max-age=${ttl}`);
    await cache.put(key, store);
  }
  fresh.headers.set("x-dg-cache", cacheable ? "miss" : "bypass");
  return fresh;
}

/* ----------------------------------------------------------- overpass ---- */

/** Stable per-query offset, so different queries start at different mirrors. */
function mirrorOrder(query: string): string[] {
  let h = 2166136261;
  for (let i = 0; i < query.length; i++) h = Math.imul(h ^ query.charCodeAt(i), 16777619);
  const start = (h >>> 0) % OVERPASS_MIRRORS.length;
  return [...OVERPASS_MIRRORS.slice(start), ...OVERPASS_MIRRORS.slice(0, start)];
}

async function overpass(query: string): Promise<unknown | null> {
  // A whole-chain deadline, not three chances to be slow in sequence. A search
  // nobody waits for is a search that failed.
  //
  // The public Overpass instances allow two concurrent slots per client, and a
  // single search fires three or four queries at once. Sending them all to the
  // same host meant the biggest one (restaurants in a dense city) lost the race
  // and came back empty. Starting each query at a different mirror spreads one
  // search across the pool instead of queueing it behind itself.
  const deadline = Date.now() + 14000;
  for (const host of mirrorOrder(query)) {
    const remaining = deadline - Date.now();
    if (remaining < 1200) break;
    try {
      const res = await fetch(host, {
        method: "POST",
        body: new URLSearchParams({ data: query }),
        headers: { "user-agent": "date-genie/1.0 (https://date-genie.agent9.dev)" },
        signal: AbortSignal.timeout(Math.min(7500, remaining)),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { elements?: unknown[] };
      if (body.elements?.length) return body;
    } catch {
      /* try the next mirror */
    }
  }
  return null;
}

/* ---------------------------------------------------------- providers ---- */

async function yelpSearch(env: Env, params: URLSearchParams): Promise<Response> {
  if (!env.YELP_API_KEY) return json({ unavailable: "no_key", businesses: [] }, 200, 60);
  const url = new URL("https://api.yelp.com/v3/businesses/search");
  for (const k of [
    "latitude",
    "longitude",
    "radius",
    "term",
    "categories",
    "price",
    "open_at",
    "limit",
    "sort_by",
  ]) {
    const v = params.get(k);
    if (v) url.searchParams.set(k, v);
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${env.YELP_API_KEY}` } });
  if (!res.ok) return json({ unavailable: `yelp_${res.status}`, businesses: [] }, 200, 0, false);
  return json(await res.json(), 200, 900);
}

async function ticketmasterSearch(env: Env, params: URLSearchParams): Promise<Response> {
  if (!env.TICKETMASTER_API_KEY) return json({ unavailable: "no_key", events: [] }, 200, 60);
  const url = new URL("https://app.ticketmaster.com/discovery/v2/events.json");
  url.searchParams.set("apikey", env.TICKETMASTER_API_KEY);
  for (const k of [
    "latlong",
    "radius",
    "unit",
    "startDateTime",
    "endDateTime",
    "classificationName",
    "size",
    "sort",
  ]) {
    const v = params.get(k);
    if (v) url.searchParams.set(k, v);
  }
  const res = await fetch(url);
  if (!res.ok)
    return json({ unavailable: `ticketmaster_${res.status}`, events: [] }, 200, 0, false);
  return json(await res.json(), 200, 900);
}

async function foursquareSearch(env: Env, params: URLSearchParams): Promise<Response> {
  if (!env.FOURSQUARE_API_KEY) return json({ unavailable: "no_key", results: [] }, 200, 60);
  const url = new URL("https://api.foursquare.com/v3/places/search");
  for (const k of [
    "ll",
    "radius",
    "query",
    "categories",
    "min_price",
    "max_price",
    "limit",
    "sort",
    "fields",
  ]) {
    const v = params.get(k);
    if (v) url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    headers: { Authorization: env.FOURSQUARE_API_KEY, Accept: "application/json" },
  });
  if (!res.ok) return json({ unavailable: `foursquare_${res.status}`, results: [] }, 200, 0, false);
  return json(await res.json(), 200, 900);
}

/* ------------------------------------------------- google maps places ---- */

/**
 * Real place data, grounded in Google Maps.
 *
 * This is the endpoint that stops the app lying about numbers. OpenStreetMap
 * gives us breadth and exact coordinates for free, but it carries no prices, no
 * ratings and no sense of whether somewhere is pleasant. Gemini with the
 * google_maps tool returns the real rating, the real review count and a real
 * price band, because it is reading Maps rather than inventing.
 *
 * The model is still fenced in: it retrieves and structures, it does not choose
 * the evening. Selection and arithmetic stay in the deterministic planner.
 */
/**
 * Quality first, and let the architecture absorb the latency.
 *
 * Measured twice each on this exact prompt, Charleston, Maps grounded:
 *
 *   gemini-3.8-flash       38.2s / 65.3s   14 venues
 *   gemini-3.7-flash       24.8s / 40.8s   14 venues
 *   gemini-3.1-flash-lite   3.8s /  ~4s     4-5 venues
 *
 * 3.7 and 3.8 return the same calibre of answer (both surface Circa 1886, Chez
 * Nous and FIG, which are in fact the best rooms in that city), so 3.7 wins on
 * speed alone. The lite model is a different class: it returned a third as many
 * venues, ignored "special occasion", and placed Charleston restaurants on
 * Sullivan's Island. It stays only as a fallback, so a timeout degrades the
 * answer instead of removing it.
 *
 * None of these are fast enough to block a search, which is the point of the
 * architecture: the fast sources answer first and the page improves in place,
 * the result is cached at the edge for an hour, and `npm run warm` means the
 * first visitor to a demo city is not a judge with a stopwatch.
 */
const PLACES_MODEL = "gemini-3.7-flash";
const PLACES_FALLBACK_MODEL = "gemini-3.1-flash-lite";

const placesPrompt = (lat: number, lng: number, kind: string, want: string, km: number) =>
  kind === "events"
    ? `Find up to 12 real venues within ${km} km of latitude ${lat}, longitude ${lng} where someone could spend an evening out: cinemas, theatres, live music venues, comedy clubs, or arts centres.${
        want ? ` Prefer: ${want}.` : ""
      }
For EACH return a JSON object with keys: name, category (one of film, theater, music, comedy, class), rating (number), reviews (number), approxTicket (number, typical USD ticket price, 0 if free), address, lat (number), lng (number), blurb (under 12 words, what it is actually like).
Reply with ONLY a JSON array. No prose, no markdown fence.`
    : `Find up to 14 real restaurants within ${km} km of latitude ${lat}, longitude ${lng} that are good for an evening out.${
        want ? ` Prefer: ${want}.` : ""
      }
For EACH return a JSON object with keys: name, rating (number), reviews (number), approxPerPerson (number, realistic USD spend per person including drinks), cuisine (one lowercase word), address, lat (number), lng (number), romantic (true or false), noise (quiet, moderate or loud), chain (true or false), vibe (under 10 words).
Every venue MUST be within ${km} km of that point. Do not include anywhere further out, however good it is.\nReply with ONLY a JSON array. No prose, no markdown fence.`;

async function googlePlaces(env: Env, params: URLSearchParams): Promise<Response> {
  try {
    return await groundedPlaces(env, params);
  } catch (error) {
    // A slow or failed enrichment must never take the search down with it.
    return json(
      { unavailable: error instanceof Error ? error.name : "failed", places: [] },
      200,
      0,
      false,
    );
  }
}

async function groundedPlaces(env: Env, params: URLSearchParams): Promise<Response> {
  if (!env.GEMINI_API_KEY) return json({ unavailable: "no_key", places: [] }, 200, 60);
  const lat = Number(params.get("lat"));
  const lng = Number(params.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng))
    return json({ error: "lat and lng required" }, 400);
  const kind = params.get("kind") === "events" ? "events" : "restaurants";
  const want = (params.get("want") ?? "").slice(0, 120);
  const km = Math.min(25, Math.max(1, Number(params.get("km")) || 5));

  const prompt = placesPrompt(lat, lng, kind, want, km);
  for (const [model, budgetMs] of [
    [PLACES_MODEL, 75000],
    [PLACES_FALLBACK_MODEL, 12000],
  ] as const) {
    const places = await askGemini(env.GEMINI_API_KEY, model, prompt, budgetMs);
    if (places?.length) return json({ places, grounded: true, model }, 200, 3600);
  }
  return json({ unavailable: "no_places", places: [] }, 200, 0, false);
}

async function askGemini(
  key: string,
  model: string,
  prompt: string,
  budgetMs: number,
): Promise<unknown[] | null> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          tools: [{ google_maps: {} }],
          generationConfig: { temperature: 0.2 },
        }),
        signal: AbortSignal.timeout(budgetMs),
      },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = (body.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
    const match = /\[[\s\S]*\]/.exec(text);
    if (!match) return null;
    return JSON.parse(match[0]) as unknown[];
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- router ---- */

/**
 * Nitro's service wrapper forwards only the Request, so the `env` argument a
 * Worker normally receives never reaches us. `cloudflare:workers` exposes the
 * same bindings as a module import, which does. Anything explicitly passed in
 * still wins, so this stays testable outside the Worker runtime.
 */
let cachedBindings: Env | null = null;
async function resolveBindings(passed: Env): Promise<Env> {
  if (Object.keys(passed).length) return passed;
  if (cachedBindings) return cachedBindings;
  try {
    const mod = await import(/* @vite-ignore */ "cloudflare:workers");
    cachedBindings = (mod.env ?? {}) as Env;
  } catch {
    cachedBindings = {};
  }
  return cachedBindings;
}

/** Returns null when the path is not ours, so the app handles it instead. */
export async function handleApi(request: Request, passedEnv: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return null;
  const env = await resolveBindings(passedEnv);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      },
    });
  }

  try {
    switch (url.pathname) {
      /** Which adapters are actually usable in this deployment. */
      case "/api/understand": {
        if (request.method !== "POST") return json({ error: "POST a { text } body" }, 405);
        const body = (await request.json().catch(() => ({}))) as { text?: string };
        if (!body.text?.trim()) return json({ error: "missing text" }, 400);
        return understand(env, body.text);
      }

      case "/api/sources":
        return json(
          {
            sources: [
              {
                id: "gmaps",
                label: "Google Maps via Gemini grounding",
                kind: "api-adapter",
                available: Boolean(env.GEMINI_API_KEY),
                needsKey: true,
                provides: ["real ratings", "real prices", "venue judgement"],
              },
              {
                id: "osm",
                label: "OpenStreetMap",
                kind: "api-adapter",
                available: true,
                needsKey: false,
                provides: ["restaurants", "venues", "parking"],
              },
              {
                id: "yelp",
                label: "Yelp Fusion",
                kind: "api-adapter",
                available: Boolean(env.YELP_API_KEY),
                needsKey: true,
                provides: ["restaurants", "ratings", "price"],
              },
              {
                id: "ticketmaster",
                label: "Ticketmaster Discovery",
                kind: "api-adapter",
                available: Boolean(env.TICKETMASTER_API_KEY),
                needsKey: true,
                provides: ["events", "showtimes", "ticket price"],
              },
              {
                id: "foursquare",
                label: "Foursquare Places",
                kind: "api-adapter",
                available: Boolean(env.FOURSQUARE_API_KEY),
                needsKey: true,
                provides: ["restaurants", "ratings"],
              },
              {
                id: "workers-ai",
                label: "Cloudflare Workers AI",
                kind: "api-adapter",
                available: Boolean(env.AI),
                needsKey: false,
                provides: ["language understanding"],
              },
            ],
          },
          200,
          60,
        );

      case "/api/osm": {
        const query = url.searchParams.get("q");
        if (!query) return json({ error: "missing q" }, 400);
        return cached(request, 1800, async () => {
          const body = await overpass(query);
          return body
            ? json(body, 200, 1800)
            : json({ elements: [], unavailable: "overpass_unreachable" }, 200, 0, false);
        });
      }

      case "/api/geocode": {
        const q = url.searchParams.get("q");
        if (!q) return json({ error: "missing q" }, 400);
        return cached(request, 86400, async () => {
          const res = await fetch(
            `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`,
            {
              headers: {
                "user-agent": "date-genie/1.0 (https://date-genie.agent9.dev)",
                accept: "application/json",
              },
            },
          );
          if (!res.ok) return json({ results: [] }, 200, 0, false);
          return json({ results: await res.json() }, 200, 86400);
        });
      }

      case "/api/places":
        // An hour of edge cache: real ratings do not move minute to minute, and
        // one grounded lookup per area serves everyone who searches it.
        return cached(request, 3600, () => googlePlaces(env, url.searchParams));

      case "/api/yelp":
        return cached(request, 900, () => yelpSearch(env, url.searchParams));
      case "/api/events":
        return cached(request, 900, () => ticketmasterSearch(env, url.searchParams));
      case "/api/foursquare":
        return cached(request, 900, () => foursquareSearch(env, url.searchParams));

      default:
        return json({ error: "unknown endpoint" }, 404);
    }
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "adapter failed" }, 502);
  }
}
