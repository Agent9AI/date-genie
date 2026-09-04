import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1500, height: 1060 }, deviceScaleFactor: 2 });
await p.goto("https://date-genie.agent9.dev/", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(2000);
await p.evaluate(() =>
  window.dateGenie.call("plan_date_night", {
    request:
      "It's our anniversary, we're in Charleston, SC. Under $300, nothing loud, no shellfish, and a show after.",
  }),
);
await p.waitForTimeout(6000);
await p.screenshot({ path: "/tmp/dg-shots/20-final.png" });
const s = await p.evaluate(() => {
  const s = window.dateGenie.getState();
  return {
    plan: s.plan && s.plan.legs.map((l) => `${l.start} ${l.title} $${l.cost}`),
    total: s.plan?.total,
    src: s.pool?.reports.map((r) => r.label + ":" + r.counts.restaurants),
  };
});
console.log(JSON.stringify(s, null, 1));
await b.close();
