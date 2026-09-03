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
};

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

/** Returns null when the path is not ours, so the app handles it instead. */
export async function handleApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return null;

  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "content-type",
      },
    });
  }

  try {
    switch (url.pathname) {
      /** Which adapters are actually usable in this deployment. */
      case "/api/sources":
        return json(
          {
            sources: [
              { id: "osm", label: "OpenStreetMap", kind: "api-adapter", available: true, needsKey: false, provides: ["restaurants", "venues", "parking"] },
              { id: "yelp", label: "Yelp Fusion", kind: "api-adapter", available: Boolean(env.YELP_API_KEY), needsKey: true, provides: ["restaurants", "ratings", "price"] },
              { id: "ticketmaster", label: "Ticketmaster Discovery", kind: "api-adapter", available: Boolean(env.TICKETMASTER_API_KEY), needsKey: true, provides: ["events", "showtimes", "ticket price"] },
              { id: "foursquare", label: "Foursquare Places", kind: "api-adapter", available: Boolean(env.FOURSQUARE_API_KEY), needsKey: true, provides: ["restaurants", "ratings"] },
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
