import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:2});
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
await p.goto('https://date-genie.agent9.dev/',{waitUntil:'networkidle'});
await p.waitForTimeout(20000);
console.log('start:', JSON.stringify(await p.evaluate(()=>({place:window.dateGenie.getState().place.label, inv:window.dateGenie.getState().inventory}))));

// The exact thing the user tried: name a different town in the request.
const r = await p.evaluate(async()=> (await window.dateGenie.call('plan_date_night',{
  request: "Plan a date night for me and my wife in Fredericksburg, VA. Under $150, nothing before 7."
})).content[0].text);
console.log('--- plan_date_night with Fredericksburg ---');
console.log(r.split('\n').slice(0,12).join('\n'));
const st = await p.evaluate(()=>{const s=window.dateGenie.getState();return {place:s.place.label, inv:s.inventory, plan:s.plan&&{r:s.plan.dinner.restaurant.name,e:s.plan.event.event.name,total:s.plan.total,walk:s.plan.event.walkMinutes}, considered:s.considered};});
console.log('STATE:', JSON.stringify(st));
await p.screenshot({path:'/tmp/dg-shots/09-fredericksburg.png'});
console.log('ERRORS:', errs.length?errs:'none');
await b.close();
