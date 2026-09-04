import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1500, height: 1080 }, deviceScaleFactor: 2 });
await p.goto("https://date-genie.agent9.dev/", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(2000);
await p.evaluate(() =>
  window.dateGenie.call("plan_date_night", {
    request:
      "Something quiet in Savannah, GA where we can actually talk, then live music. Under $200, nothing before 7:30.",
  }),
);
await p.waitForFunction(() => window.dateGenie.getState().plan !== null, { timeout: 120000 });
await p.waitForTimeout(2500);
await p.screenshot({ path: "/tmp/dg-shots/30-redesign.png" });
// and the approval moment, which is the money shot
await p.evaluate(() => {
  void window.dateGenie.call("request_approval", {
    note: "Holds the table, the tickets and the spot.",
  });
});
await p.waitForSelector('[role="dialog"]', { timeout: 20000 });
await p.waitForTimeout(700);
await p.screenshot({ path: "/tmp/dg-shots/31-approval.png" });
console.log("ok");
await b.close();
