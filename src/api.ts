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
    location: { type: ["string", "null"], description: "Place named by the user, e.g. 'Fredericksburg, VA'. Null if none." },
    budget: { type: ["number", "null"], description: "Total ceiling in USD for the WHOLE evening, all people" },
    earliest: { type: ["string", "null"], description: "Nothing before this, 24-hour HH:MM" },
    latestEnd: { type: ["string", "null"], description: "Must be over by this, 24-hour HH:MM" },
    party: { type: ["number", "null"], description: "How many people are going" },
    maxDriveMinutes: { type: ["number", "null"] },
    maxWalkMinutes: { type: ["number", "null"] },
    interests: { type: "array", items: { type: "string" }, description: "Cuisines and activities they want: korean, comedy, live music, film, theater" },
    avoid: { type: "array", items: { type: "string" }, description: "Anything ruled out: seafood, loud, chain" },
    dietary: { type: "array", items: { type: "string", enum: ["vegan", "vegetarian", "gluten-free"] } },
    noisePreference: { type: ["string", "null"], enum: ["quiet", "moderate", "loud", null] },
    occasion: { type: ["string", "null"], description: "anniversary, birthday, first date, null" },
  },
  required: ["interests", "avoid", "dietary"],
} as const;

const UNDERSTAND_PROMPT = `You convert a person's plain-English request for a night out into structured constraints.

Rules:
- Extract only what they actually said. Never invent a budget, a time or a place.
- "under $180" is the total for the whole evening, not per person.
- "nothing before 7" means earliest "19:00". Evening hours are PM unless they say otherwise.
- "home by 11" means latestEnd "23:00".
- "me and my girlfriend" means party 2.
- Put dislikes in avoid: "she hates oysters" gives avoid ["oysters"], "nothing loud" gives avoid ["loud"] and noisePreference "quiet".
- Put wants in interests: cuisines and activity types.
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
  const cleaned = value.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
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

const json = (body: unknown, status = 200, cacheSeconds = 0) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      ...(cacheSeconds ? { "cache-control": `public, max-age=${cacheSeconds}` } : { "cache-control": "no-store" }),
    },
  });

/** Read-through edge cache. The cache key is the request URL, so distinct
 *  searches stay distinct and nothing is pinned to one place. */
async function cached(request: Request, ttl: number, produce: () => Promise<Response>): Promise<Response> {
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
  if (fresh.ok) {
    const store = fresh.clone();
    store.headers.set("cache-control", `public, max-age=${ttl}`);
    await cache.put(key, store);
  }
  fresh.headers.set("x-dg-cache", "miss");
  return fresh;
}

/* ----------------------------------------------------------- overpass ---- */

async function overpass(query: string): Promise<unknown | null> {
  for (const host of OVERPASS_MIRRORS) {
    try {
      const res = await fetch(host, {
        method: "POST",
        body: new URLSearchParams({ data: query }),
        headers: { "user-agent": "date-genie/1.0 (https://date-genie.agent9.dev)" },
        signal: AbortSignal.timeout(25000),
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
  for (const k of ["latitude", "longitude", "radius", "term", "categories", "price", "open_at", "limit", "sort_by"]) {
    const v = params.get(k);
    if (v) url.searchParams.set(k, v);
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${env.YELP_API_KEY}` } });
  if (!res.ok) return json({ unavailable: `yelp_${res.status}`, businesses: [] }, 200, 30);
  return json(await res.json(), 200, 900);
}

async function ticketmasterSearch(env: Env, params: URLSearchParams): Promise<Response> {
  if (!env.TICKETMASTER_API_KEY) return json({ unavailable: "no_key", events: [] }, 200, 60);
  const url = new URL("https://app.ticketmaster.com/discovery/v2/events.json");
  url.searchParams.set("apikey", env.TICKETMASTER_API_KEY);
  for (const k of ["latlong", "radius", "unit", "startDateTime", "endDateTime", "classificationName", "size", "sort"]) {
    const v = params.get(k);
    if (v) url.searchParams.set(k, v);
  }
  const res = await fetch(url);
  if (!res.ok) return json({ unavailable: `ticketmaster_${res.status}`, events: [] }, 200, 30);
  return json(await res.json(), 200, 900);
}

async function foursquareSearch(env: Env, params: URLSearchParams): Promise<Response> {
  if (!env.FOURSQUARE_API_KEY) return json({ unavailable: "no_key", results: [] }, 200, 60);
  const url = new URL("https://api.foursquare.com/v3/places/search");
  for (const k of ["ll", "radius", "query", "categories", "min_price", "max_price", "limit", "sort", "fields"]) {
    const v = params.get(k);
    if (v) url.searchParams.set(k, v);
  }
  const res = await fetch(url, { headers: { Authorization: env.FOURSQUARE_API_KEY, Accept: "application/json" } });
  if (!res.ok) return json({ unavailable: `foursquare_${res.status}`, results: [] }, 200, 30);
  return json(await res.json(), 200, 900);
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
              { id: "osm", label: "OpenStreetMap", kind: "api-adapter", available: true, needsKey: false, provides: ["restaurants", "venues", "parking"] },
              { id: "yelp", label: "Yelp Fusion", kind: "api-adapter", available: Boolean(env.YELP_API_KEY), needsKey: true, provides: ["restaurants", "ratings", "price"] },
              { id: "ticketmaster", label: "Ticketmaster Discovery", kind: "api-adapter", available: Boolean(env.TICKETMASTER_API_KEY), needsKey: true, provides: ["events", "showtimes", "ticket price"] },
              { id: "foursquare", label: "Foursquare Places", kind: "api-adapter", available: Boolean(env.FOURSQUARE_API_KEY), needsKey: true, provides: ["restaurants", "ratings"] },
              { id: "workers-ai", label: "Cloudflare Workers AI", kind: "api-adapter", available: Boolean(env.AI), needsKey: false, provides: ["language understanding"] },
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
          return body ? json(body, 200, 1800) : json({ elements: [], unavailable: "overpass_unreachable" }, 200, 30);
        });
      }

      case "/api/geocode": {
        const q = url.searchParams.get("q");
        if (!q) return json({ error: "missing q" }, 400);
        return cached(request, 86400, async () => {
          const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`, {
            headers: { "user-agent": "date-genie/1.0 (https://date-genie.agent9.dev)", accept: "application/json" },
          });
          if (!res.ok) return json({ results: [] }, 200, 60);
          return json({ results: await res.json() }, 200, 86400);
        });
      }

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
