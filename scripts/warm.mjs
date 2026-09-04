/**
 * Warm the edge cache for the cities the demo uses.
 *
 * The first visitor to a city pays for the upstream lookups; everyone after
 * them gets a cache hit in about 20ms. Running this after a deploy means the
 * first visitor is never a judge with a stopwatch.
 */
const BASE = process.env.DG_BASE ?? "https://date-genie.agent9.dev";
const CITIES = [
  ["Arlington, VA", 38.8816, -77.1117],
  ["Asheville, NC", 35.5951, -82.5515],
  ["Savannah, GA", 32.0809, -81.0912],
  ["Burlington, VT", 44.4759, -73.2121],
  ["Washington, DC", 38.8951, -77.0364],
  ["Brooklyn, NY", 40.6501, -73.9496],
  ["Charleston, SC", 32.7765, -79.9311],
];

const bbox = (lat, lng, km) => {
  const dLat = km / 111;
  const dLng = km / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return [lat - dLat, lng - dLng, lat + dLat, lng + dLng].map((n) => n.toFixed(4)).join(",");
};

const queries = (lat, lng) => {
  const bb = bbox(lat, lng, 4);
  return [
    `[out:json][timeout:12];\nnwr["amenity"="restaurant"]["name"](${bb});\nout center 200;`,
    `[out:json][timeout:12];\n(\n  nwr["amenity"="cinema"]["name"](${bb});\n  nwr["amenity"="theatre"]["name"](${bb});\n  nwr["amenity"="nightclub"]["name"](${bb});\n  nwr["amenity"="arts_centre"]["name"](${bb});\n);\nout center 120;`,
    `[out:json][timeout:12];\nnwr["amenity"="parking"]["access"!="private"](${bb});\nout center 150;`,
  ];
};

for (const [name, lat, lng] of CITIES) {
  const started = Date.now();
  // Serial on purpose. Warming is not the place to hammer a shared public API.
  const results = [];
  for (const q of queries(lat, lng)) {
    results.push(
      await fetch(`${BASE}/api/osm?v=2&q=${encodeURIComponent(q)}`)
        .then((r) => r.json())
        .then((b) => (b.elements ?? []).length)
        .catch(() => "fail"),
    );
  }
  results.push(
    await fetch(`${BASE}/api/places?lat=${lat.toFixed(5)}&lng=${lng.toFixed(5)}&kind=restaurants`)
      .then((r) => r.json())
      .then((b) => (b.places ?? []).length)
      .catch(() => "fail"),
  );
  console.log(`${name.padEnd(20)} osm=[${results.slice(0, 3).join(", ")}] maps=${results[3]}  ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
