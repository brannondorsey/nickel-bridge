/**
 * Responsive sweep: walks the app once and shoots every screen at each of the
 * ladder's steps, so a change to the breakpoints can be reviewed as a
 * side-by-side rather than as a claim.
 *
 *   node scripts/responsive-check.mjs http://localhost:3000 ./shots
 *
 * Needs a running server with DEV_AUTH=1. Sibling to scripts/ui-check.mjs,
 * which shoots the same walk at the phone viewport only and in more detail;
 * this one trades depth for width. Output is `<name>@<width>.png`.
 *
 * The viewports are the three the ladder actually steps at (see "the
 * responsive ladder" in web/src/style.css), plus the phone the whole design
 * was drawn for:
 *   390  — the design viewport; nothing here may change
 *   834  — tablet portrait, above the 720px step
 *   1194 — tablet landscape / small laptop, above the 1024px step
 *   1440 — desktop, where the measure stops growing
 *
 * One session, one walk: the viewport is resized between shots rather than
 * the walk repeated per width, because several of these states (a selected
 * bid, a live trick) cost real robot time to reach and are not worth reaching
 * four times.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:3997';
const outDir = process.argv[3] ?? './shots';
const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;

const VIEWPORTS = [
  { w: 390, h: 844 },
  { w: 834, h: 1112 },
  { w: 1194, h: 834 },
  { w: 1440, h: 900 },
];

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

/** Shoot one state at every viewport, restoring the phone width afterwards so
 *  the walk continues from the geometry it started in. */
async function sweep(name, { fullPage = false, settle = 350 } = {}) {
  if (only && !only.has(name)) return;
  for (const v of VIEWPORTS) {
    await page.setViewportSize({ width: v.w, height: v.h });
    await page.waitForTimeout(settle);
    await page.screenshot({ path: `${outDir}/${name}@${v.w}.png`, fullPage });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(120);
  console.log(`  ${name}`);
}

const name = `Dana ${Date.now() % 100000}`;

// ---- signed out: the landing page ----
await page.goto(base);
await page.waitForSelector('input[placeholder*="dev"]');
await page.waitForTimeout(1800); // entrance animations settle
await sweep('01-landing-hero');
await sweep('01b-landing-full', { fullPage: true, settle: 500 });

// ---- sign in ----
await page.fill('input[placeholder*="dev"]', name);
await page.click('text=DEV SIGN-IN');
await page.waitForSelector('input[placeholder="Handle"]');
await sweep('02-create-handle');
await page.fill('input[placeholder="Handle"]', name);
await page.click('text=Continue');

// A brand-new account meets the first-crossing tour; skip it to reach the app.
await page.waitForSelector('.tour-narr-skip, .home-cta, [data-testid="splash"]', { timeout: 30000 });
const skip = page.locator('.tour-narr-skip');
if (await skip.isVisible().catch(() => false)) {
  await sweep('03-tour');
  await skip.click();
}
await page.waitForSelector('.home-cta', { timeout: 30000 });
await sweep('04-home-fresh');

// ---- bidding ----
await page.click('.home-cta');
await page.waitForSelector('.bidbox, .result', { timeout: 60000 });
await page.waitForSelector('.bidbox button.bid:enabled, .result', { timeout: 60000 }).catch(() => {});
await sweep('05-bidding');
const [, , tid] = new URL(page.url()).pathname.split('/'); // /t/:tid/b/:no

const firstBid = page.locator('.bidbox button.bid:enabled').first();
if (await firstBid.isVisible().catch(() => false)) {
  await firstBid.click();
  await page.waitForSelector('.meaning-panel .mtitle');
  await sweep('06-bidding-meaning');
  await page.click('.confirm-row .btn-primary');
  await page.waitForTimeout(1200);
}

// pass out the rest of the auction
for (let i = 0; i < 14; i++) {
  if (await page.locator('.result, .trick').first().isVisible().catch(() => false)) break;
  const pass = page.locator('.bidbox .callrow button.bid:enabled', { hasText: 'Pass' }).first();
  if (!(await pass.isVisible().catch(() => false))) {
    await page.waitForTimeout(600);
    continue;
  }
  await pass.click();
  await page.click('.confirm-row .btn-primary');
  await page.waitForTimeout(900);
}

// ---- card play ----
await page.waitForSelector('.trick, .result', { timeout: 60000 });
await page.waitForTimeout(1500);
await sweep('07-play');
const card = page.locator('.handfan.interactive .cardbtn:enabled').first();
if (await card.isVisible().catch(() => false)) {
  await card.click({ position: { x: 6, y: 30 } });
  await page.waitForTimeout(300);
  await sweep('08-play-selected');
}

// ---- drive the rest through the API, then the finished surfaces ----
async function finishBoard(no) {
  for (let i = 0; i < 120; i++) {
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

await page.goto(`${base}/t/${tid}/b/1`);
await page.waitForSelector('.result');
await sweep('09-board-result', { fullPage: true, settle: 600 });

await page.goto(`${base}/t/${tid}`);
await page.waitForSelector('.tourney-result-hero, .tourney-sheet');
await sweep('10-tournament', { fullPage: true, settle: 600 });

await page.goto(base);
await page.waitForSelector('.home-cta');
await sweep('11-home-played');

await page.goto(`${base}/leaderboard`);
await page.waitForSelector('.rank-row, .empty-note');
await sweep('12-rankings');

await page.goto(base);
await page.waitForSelector('.tabbar');
await page.click('.tabbar >> text=STATS');
await page.waitForSelector('.player-hero');
await sweep('13-stats', { fullPage: true, settle: 700 });

await page.goto(`${base}/activity`);
await page.waitForSelector('.traffic, .empty-note');
await sweep('14-traffic');

await page.goto(`${base}/glossary`);
await page.waitForSelector('.gloss-row');
await sweep('15-glossary');

await page.goto(`${base}/settings`);
await page.waitForSelector('.settings-panel');
await sweep('16-settings', { fullPage: true, settle: 400 });

await browser.close();
console.log('responsive-check complete →', outDir);
