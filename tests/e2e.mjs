import { chromium } from 'playwright';

const URL = process.env.DG_URL || 'https://date-genie.terry-c87.workers.dev/';
const shots = '/tmp/dg-shots';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(900);
await page.screenshot({ path: `${shots}/01-landing.png`, fullPage: false });

// 1. Tool surface present?
const tools = await page.evaluate(() => window.dateGenie?.listTools?.().map(t => t.name) ?? null);
console.log('TOOLS_BEFORE:', JSON.stringify(tools));

// 2. Agent reads live UI state
const ctx = await page.evaluate(async () => (await window.dateGenie.call('get_date_context', {})).content[0].text);
console.log('--- get_date_context ---\n' + ctx);

// 3. Run the whole flow via the button
await page.getByRole('button', { name: /grant the wish/i }).click();
await page.waitForTimeout(3200);
await page.screenshot({ path: `${shots}/02-planned.png` });

// 4. The approval gate must appear and must be blocking
await page.waitForSelector('[role="dialog"]', { timeout: 15000 });
await page.screenshot({ path: `${shots}/03-approval.png` });
const toolsDuringApproval = await page.evaluate(() => window.dateGenie.listTools().map(t => t.name));
console.log('TOOLS_AT_APPROVAL:', JSON.stringify(toolsDuringApproval));

// 5. Prove booking is impossible without the human: call it with a bogus token
const forged = await page.evaluate(async () => {
  try { return (await window.dateGenie.call('book_approved_plan', { approvalToken: 'nonce_forged' })).content[0].text; }
  catch (e) { return 'THREW: ' + e.message; }
});
console.log('FORGED_TOKEN_RESULT:', forged);

// 6. Human confirms
await page.getByRole('button', { name: /confirm and book it/i }).click();
await page.waitForTimeout(2200);
await page.screenshot({ path: `${shots}/04-booked.png` });
const booked = await page.evaluate(() => window.dateGenie.getState().booking?.confirmation ?? null);
console.log('BOOKING:', booked);
const toolsAfter = await page.evaluate(() => window.dateGenie.listTools().map(t => t.name));
console.log('TOOLS_AFTER:', JSON.stringify(toolsAfter));

// 7. Mobile
const m = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await m.goto(URL, { waitUntil: 'networkidle' });
await m.waitForTimeout(700);
await m.screenshot({ path: `${shots}/05-mobile.png`, fullPage: false });

console.log('CONSOLE_ERRORS:', errors.length ? JSON.stringify(errors, null, 1) : 'none');
await browser.close();
