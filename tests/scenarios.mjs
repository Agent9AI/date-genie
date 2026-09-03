import { chromium } from "playwright";
const SCENARIOS = [
  "Plan something fun for me and my girlfriend Wednesday night in washington, DC. Keep everything under $50, don't make us drive more than 20 minutes, and nothing before 7. Movie?",
  "Date night in Brooklyn, NY. Korean food then live music, under $200.",
  "Cheap midweek thing in Boise, Idaho. Under $70, home by 10.",
  "Anniversary in Charleston, SC, under $300, nothing loud, no shellfish.",
];
const b = await chromium.launch();
for (const req of SCENARIOS) {
  const p = await b.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto("https://date-genie.agent9.dev/", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(2000);
  const t0 = Date.now();
  const out = await p
    .evaluate(async (req) => {
      const r = await window.dateGenie.call("plan_date_night", { request: req });
      const s = window.dateGenie.getState();
      return {
        pool: s.pool
          ? `${s.pool.restaurants.length}r/${s.pool.events.length}e/${s.pool.parking.length}p`
          : "none",
        place: s.place?.label,
        via: s.understanding?.via,
        interests: s.constraints.interests,
        avoid: s.constraints.avoid,
        budget: s.constraints.budget,
        spendTarget: s.constraints.spendTarget,
        noise: s.constraints.noisePreference,
        priceRange: s.pool && [
          Math.min(...s.pool.restaurants.map((r) => r.pricePerPerson)),
          Math.max(...s.pool.restaurants.map((r) => r.pricePerPerson)),
        ],
        ticketRange: s.pool && [
          Math.min(...s.pool.events.map((e) => e.pricePerTicket)),
          Math.max(...s.pool.events.map((e) => e.pricePerTicket)),
        ],
        plan:
          s.plan &&
          `${s.plan.dinner.restaurant.name} -> ${s.plan.event.event.venue} ($${s.plan.total}, ${s.plan.event.hop.minutes}min ${s.plan.event.hop.mode})`,
        relax: s.relaxations.map((x) => `${x.label} ${x.from}->${x.to}`),
        notice: s.notice,
        err: r.isError ? r.content[0].text.split("\n")[0].slice(0, 140) : null,
      };
    }, req)
    .catch((e) => ({ fail: String(e).slice(0, 140) }));
  console.log(`\n### ${req.slice(0, 64)}...  [${((Date.now() - t0) / 1000).toFixed(1)}s]`);
  console.log(JSON.stringify(out, null, 1));
  if (errs.length) console.log("PAGEERRORS:", errs.slice(0, 2));
  await p.close();
}
await b.close();
