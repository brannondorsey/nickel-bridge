import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:3997';
const outDir = process.argv[3] ?? '.';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const shot = (name) => page.screenshot({ path: `${outDir}/${name}.png`, fullPage: false });

// login
await page.goto(base);
await page.fill('input[placeholder*="dev"]', 'Carol');
await page.click('text=Dev sign-in');
await page.waitForSelector('text=Hi, Carol');
await shot('01-lobby');

// play → board
await page.click('button:has-text("Play")');
await page.waitForSelector('.bidbox, .result', { timeout: 30000 });
await shot('02-bidding');

// tap a legal bid to see its meaning before submitting
const firstLegal = page.locator('.bidbox button.bid:enabled').first();
await firstLegal.click();
await page.waitForSelector('.meaning-panel .mtitle');
await shot('03-meaning-preview');

// confirm the bid → grade toast
await page.click('.confirm-row .btn-primary');
await page.waitForSelector('.grade-toast', { timeout: 30000 });
await shot('04-grade-toast');

// keep passing until the auction ends
for (let i = 0; i < 12; i++) {
  const passBtn = page.locator('.bidbox .callrow button.bid:enabled', { hasText: 'Pass' }).first();
  if (!(await passBtn.isVisible().catch(() => false))) break;
  await passBtn.click();
  await page.click('.confirm-row .btn-primary');
  await page.waitForTimeout(700);
  if (await page.locator('.result, .trick').first().isVisible().catch(() => false)) break;
}
await page.waitForSelector('.trick, .result', { timeout: 30000 });
await shot('05-play-or-result');

// if playing: tap a card twice to play it
const cardBtn = page.locator('.handfan .cardbtn:enabled').first();
if (await cardBtn.isVisible().catch(() => false)) {
  // tap the visible left sliver (cards overlap like a real fan)
  await cardBtn.click({ position: { x: 6, y: 30 } });
  await page.waitForTimeout(200);
  await shot('06-card-selected');
  await cardBtn.click({ position: { x: 6, y: 30 } });
  await page.waitForTimeout(1200);
  await shot('07-after-play');
}

// desktop viewport lobby (same session)
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto(base);
await page.waitForSelector('text=Hi, Carol');
await page.screenshot({ path: `${outDir}/08-desktop-lobby.png` });

await browser.close();
console.log('ui-check complete');
