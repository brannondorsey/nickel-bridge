/**
 * Visual sweep for the redesign: signs a fresh user in, walks every screen
 * the prototype defines and screenshots each one at the design viewport
 * (390×844). Needs a running server with DEV_AUTH=1:
 *
 *   node scripts/ui-check.mjs http://localhost:3000 ./shots
 *
 * Boards 2–4 are driven through the API (same cookies) so the sweep ends on
 * the tournament result + populated Home/Stats without hand-playing 52 cards.
 */
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:3997';
const outDir = process.argv[3] ?? '.';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const shot = (name, fullPage = false) => page.screenshot({ path: `${outDir}/${name}.png`, fullPage });
const name = `Carol ${Date.now() % 100000}`;

// 01 — the logged-out splash (doubles as login)
await page.goto(base);
await page.waitForSelector('input[placeholder*="dev"]');
await page.waitForTimeout(1600); // entrance animations settle
await shot('01-login-splash');

// 02 — create handle
await page.fill('input[placeholder*="dev"]', name);
await page.click('text=DEV SIGN-IN');
await page.waitForSelector('input[placeholder="Handle"]');
await shot('02-create-handle');

// 03 — first-visit splash intro, then Home
await page.fill('input[placeholder="Handle"]', name);
await page.click('text=Continue');
await page.waitForSelector('[data-testid="splash"]');
await page.waitForTimeout(900);
await shot('03-splash-intro');
await page.click('[data-testid="splash"]');

// 04 — fresh Home (PLAY THE TOLL, no tolls paid)
await page.waitForSelector('.home-cta');
await shot('04-home-fresh');

// 05 — bidding
await page.click('.home-cta');
await page.waitForSelector('.bidbox, .result', { timeout: 30000 });
await shot('05-bidding');
const [, , tid] = new URL(page.url()).pathname.split('/'); // /t/:tid/b/:no

// 06 — call inspector (a past robot call; board 1 deals from North)
const pastCall = page.locator('.auction tbody button').first();
if (await pastCall.isVisible().catch(() => false)) {
  await pastCall.click();
  await page.waitForSelector('[role="dialog"]');
  await shot('06-call-inspector');
  await page.click('[aria-label="Close"]');
}

// 07 — tap a legal bid to see its meaning before submitting
await page.locator('.bidbox button.bid:enabled').first().click();
await page.waitForSelector('.meaning-panel .mtitle');
await shot('07-meaning-preview');

// 08 — confirm the bid → grade toast
await page.click('.confirm-row .btn-primary');
await page.waitForSelector('.grade-toast', { timeout: 30000 });
await shot('08-grade-toast');

// keep passing until the auction ends
for (let i = 0; i < 12; i++) {
  if (await page.locator('.result, .trick').first().isVisible().catch(() => false)) break;
  const passBtn = page.locator('.bidbox .callrow button.bid:enabled', { hasText: 'Pass' }).first();
  if (!(await passBtn.isVisible().catch(() => false))) {
    await page.waitForTimeout(500);
    continue;
  }
  await passBtn.click();
  await page.click('.confirm-row .btn-primary');
  await page.waitForTimeout(700);
}
await page.waitForSelector('.trick, .result', { timeout: 30000 });

// 09/10 — card play: tap-select (raised card), tap again to play
await shot('09-play');
const cardBtn = page.locator('.handfan.interactive .cardbtn:enabled').first();
if (await cardBtn.isVisible().catch(() => false)) {
  // tap the visible left sliver (cards overlap like a real fan)
  await cardBtn.click({ position: { x: 6, y: 30 } });
  await page.waitForTimeout(250);
  await shot('10-card-selected');
  const selected = page.locator('.handfan .cardbtn.selected');
  if (await selected.isVisible().catch(() => false)) await selected.click({ position: { x: 6, y: 30 } });
  await page.waitForTimeout(1200);
}

// drive every remaining move/board through the API (same session cookies)
async function finishBoard(no) {
  for (let i = 0; i < 80; i++) {
    const view = await (await page.request.get(`${base}/api/tournaments/${tid}/boards/${no}`)).json();
    if (view.state === 'done') return;
    if (view.state === 'bidding' && view.myTurn) {
      await page.request.post(`${base}/api/tournaments/${tid}/boards/${no}/call`, { data: { call: 0 } });
    } else if (view.state === 'playing' && view.myTurn) {
      await page.request.post(`${base}/api/tournaments/${tid}/boards/${no}/play`, { data: { card: view.legalCards[0] } });
    } else {
      throw new Error(`stuck on board ${no}: ${view.state}`);
    }
  }
}
for (let no = 1; no <= 4; no++) await finishBoard(no);

// 11 — board result (full page: hero, field, deal diagram, bidding recap)
await page.goto(`${base}/t/${tid}/b/1`);
await page.waitForSelector('.result');
await shot('11-board-result', true);

// 11b — the toll receipt (reopened from the result; rows print in on a timer)
await page.click('.receipt-link');
await page.waitForSelector('.receipt-panel');
await page.waitForTimeout(2600);
await shot('11b-toll-receipt', true);
await page.click('text=SEE THE FIELD');
await page.waitForSelector('.fieldtable');

// 12/13 — tournament result + reviewable sheet
await page.goto(`${base}/t/${tid}`);
await page.waitForSelector('.tourney-result-hero');
await shot('12-tournament-result');
await page.click('text=Review the boards');
await page.waitForSelector('.tourney-sheet');
await shot('13-tournament-sheet');

// 14 — rankings
await page.goto(base);
await page.click('.tabbar >> text=RANKINGS');
await page.waitForSelector('.rank-row');
await shot('14-rankings');

// 15 — stats, now with a played tournament behind them
await page.click('.tabbar >> text=STATS');
await page.waitForSelector('.player-hero');
await shot('15-stats', true);

// 16 — Home with a paid toll
await page.click('.tabbar >> text=CROSSINGS');
await page.waitForSelector('.home-cta');
await shot('16-home-tolls-paid');

// 16b/16c — glossary ledger + a term sheet
await page.click('.tabbar >> text=GLOSSARY');
await page.waitForSelector('.gloss-row');
await shot('16b-glossary');
await page.locator('.gloss-row', { hasText: /^Finesse/ }).click();
await page.waitForSelector('.sheet');
await shot('16c-glossary-term-sheet');
await page.click('[aria-label="Close"]');

// 17 — desktop viewport (same session)
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto(base);
await page.waitForSelector('.home-cta');
await shot('17-desktop-home');

await browser.close();
console.log('ui-check complete');
