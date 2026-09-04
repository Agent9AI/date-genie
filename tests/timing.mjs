import { chromium } from "playwright";
const CASES = [
  ["default sample (warmed on load)", null],
  [
    "Providence, RI (never touched)",
    "Date night in Providence, Rhode Island. Under $150, nothing before 7.",
  ],
  [
    "Providence again (now cached)",
    "Date night in Providence, Rhode Island. Under $150, nothing before 7.",
  ],
];
const b = await chromium.launch();
for (const [label, req] of CASES) {
  const p = await b.newPage();
  await p.goto("https://date-genie.agent9.dev/", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1200);
  const t0 = Date.now();
  if (req)
    await p.evaluate((r) => {
      void window.dateGenie.call("plan_date_night", { request: r });
    }, req);
  else await p.getByRole("button", { name: /^plan it$/i }).click();
  let sawSkeleton = false,
    sawProgress = "";
  const poll = setInterval(async () => {}, 50);
  try {
    // watch that the UI is saying something while it works
    for (let i = 0; i < 6; i++) {
      await p.waitForTimeout(400);
      const st = await p.evaluate(() => ({
        s: window.dateGenie.getState().searching,
        pr: window.dateGenie.getState().progress,
      }));
      if (st.s && st.pr) {
        sawProgress = st.pr;
      }
      if ((await p.locator("[aria-hidden] .dg-pulse-bar").count()) > 0) sawSkeleton = true;
    }
    await p.waitForFunction(() => window.dateGenie.getState().plan !== null, null, {
      timeout: 150000,
    });
    const ms = Date.now() - t0;
    const plan = await p.evaluate(() => {
      const s = window.dateGenie.getState();
      return (
        s.plan.dinner.restaurant.name + " -> " + s.plan.event.event.venue + " $" + s.plan.total
      );
    });
    console.log(
      `${label.padEnd(34)} ${(ms / 1000).toFixed(1)}s  skeleton=${sawSkeleton}  "${sawProgress}"`,
    );
    console.log(`   ${plan}`);
  } catch (e) {
    console.log(`${label}: FAILED ${String(e).slice(0, 90)}`);
  }
  clearInterval(poll);
  await p.close();
}
await b.close();
