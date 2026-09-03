import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1500, height: 1100 }, deviceScaleFactor: 2 });
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));
await p.goto("https://date-genie.agent9.dev/", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(2000);
await p.evaluate(() =>
  window.dateGenie.call("plan_date_night", {
    request: "Anniversary in Charleston, SC, under $300, nothing loud, no shellfish.",
  }),
);
await p.waitForTimeout(3500);
await p.screenshot({ path: "/tmp/dg-shots/10-plan.png" });
await p.evaluate(() => window.scrollTo(0, 1400));
await p.waitForTimeout(500);
await p.screenshot({ path: "/tmp/dg-shots/11-sources.png" });
console.log("errors:", errs.length ? errs : "none");
await b.close();
