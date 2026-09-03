import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:2});
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
await p.goto('https://date-genie.agent9.dev/',{waitUntil:'domcontentloaded'});
await p.waitForTimeout(2500);
const out = await p.evaluate(async()=>{
  const r = await window.dateGenie.call('plan_date_night',{request:"its our anniversary, we are in Portland Maine. somewhere we can actually hear each other, my wife is vegetarian, absolutely no oysters, keep it under 240 and I want to be home by 11:30"});
  const s = window.dateGenie.getState();
  return { text: r.content[0].text.slice(0,700), via: s.understanding?.via, model: s.understanding?.model,
           constraints: s.constraints, plan: s.plan && `${s.plan.dinner.restaurant.name} -> ${s.plan.event.event.venue} $${s.plan.total}`,
           tags: s.plan?.dinner.restaurant.tags };
});
console.log(JSON.stringify(out,null,1));
console.log('ERRORS:', errs.length?errs:'none');
await b.close();
