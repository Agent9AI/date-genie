import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
const errs = [];
p.on("pageerror", (e) => errs.push(e.message.slice(0, 200)));
const failed = [];
p.on("requestfailed", (r) => failed.push(r.url().slice(0, 90) + " " + r.failure()?.errorText));
console.log("--- first-time visitor, presses the button, waits ---");
const t0 = Date.now();
await p.goto("https://date-genie.agent9.dev/", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(1500);
await p.getByRole("button", { name: /^plan it$/i }).click();
let planned = false;
for (let i = 0; i < 24; i++) {
  await p.waitForTimeout(5000);
  const s = await p.evaluate(() => {
    const s = window.dateGenie.getState();
    return {
      plan: !!s.plan,
      searching: s.searching,
      notice: s.notice,
      calls: s.calls.length,
      narr: s.narration.slice(-1)[0],
      pool: s.pool ? s.pool.restaurants.length : null,
    };
  });
  console.log(
    `  t+${((Date.now() - t0) / 1000).toFixed(0)}s  plan=${s.plan} searching=${s.searching} pool=${s.pool} calls=${s.calls} | ${s.narr ?? ""} ${s.notice ?? ""}`,
  );
  if (s.plan) {
    planned = true;
    break;
  }
}
console.log(
  planned
    ? `RESULT: plan in ${((Date.now() - t0) / 1000).toFixed(1)}s`
    : "RESULT: NO PLAN AFTER 120s",
);
if (errs.length) console.log("PAGE ERRORS:", errs.slice(0, 3));
if (failed.length) console.log("FAILED REQUESTS:", failed.slice(0, 5));
await b.close();
