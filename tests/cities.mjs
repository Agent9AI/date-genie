import { chromium } from "playwright";
const cities = process.argv.slice(2);
const b = await chromium.launch();
for (const city of cities) {
  const p = await b.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto("https://date-genie.agent9.dev/", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(2500);
  const out = await p
    .evaluate(async (city) => {
      const r = await window.dateGenie.call("plan_date_night", {
        request: `Date night for two in ${city}. Under $180, nothing before 7.`,
      });
      const s = window.dateGenie.getState();
      return {
        place: s.place?.label ?? null,
        inv: s.pool
          ? `${s.pool.restaurants.length}r/${s.pool.events.length}e/${s.pool.parking.length}p from ${s.pool.reports.map((x) => x.label + " " + x.ms + "ms").join("+")}`
          : "no search",
        considered: s.considered,
        relax: s.relaxations.map((x) => `${x.label} ${x.from}->${x.to}`),
        plan:
          s.plan &&
          `${s.plan.dinner.restaurant.name} (${s.plan.dinner.restaurant.cuisine}) -> ${s.plan.event.event.venue} | $${s.plan.total} | ${s.plan.event.hop.minutes}min ${s.plan.event.hop.mode}`,
        notice: s.notice,
        err: r.isError ? r.content[0].text.split("\n")[0] : null,
      };
    }, city)
    .catch((e) => ({ fail: String(e) }));
  console.log(`\n### ${city}`);
  console.log(JSON.stringify(out, null, 1));
  if (errs.length) console.log("PAGEERRORS:", errs);
  await p.close();
}
await b.close();
