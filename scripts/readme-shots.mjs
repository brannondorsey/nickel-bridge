/**
 * README screenshots: the marketing sweep.
 *
 * Where `ui-check.mjs` walks *every* screen for design review, this captures the
 * handful of shots the README leads with. It plays an ordinary tournament — not
 * a demo exhibit — so the chrome in frame is what a real player sees, but it
 * runs against a DEMO=1 instance so the seeded ambient field gives the standings,
 * rankings and stats screens something real to show. Boards are driven through
 * the API between shots (same session cookies) so the sweep doesn't hand-play
 * 52 cards, stopping one action short wherever the shot needs a live transition
 * (the grade toast, the printing receipt).
 *
 *   npm run build
 *   DEMO=1 DEV_AUTH=1 DB_PATH=/tmp/shots.db PORT=3997 node server/dist/index.js &
 *   node scripts/readme-shots.mjs http://localhost:3997 docs/screenshots
 *
 * Placement resumes an unfinished tournament, so each run wants a player who
 * hasn't played yet: use a fresh database, or SHOT_HANDLE=<new name>.
 *
 * Shots are phone-portrait (390×844, the design brief's reference size) at 2×
 * for retina, except the desktop one.
 */
import { chromium } from 'playwright';
import { PASS, auctionState } from '../packages/core/dist/index.js';
import { Bidder, loadPolicyModel } from '../packages/ai/dist/index.js';

const base = process.argv[2] ?? 'http://localhost:3997';
const outDir = process.argv[3] ?? 'docs/screenshots';
const handle = process.env.SHOT_HANDLE ?? 'Wren';
/** Extra tournaments played after the featured one, to give stats/rankings a record. */
const EXTRA_TOURNAMENTS = Number(process.env.SHOT_EXTRA_TOURNAMENTS ?? 4);

const bidder = new Bidder(loadPolicyModel(process.env.AI_MODEL ?? 'sl'));

/**
 * The model's own top call from this position — the one the grade toast stamps
 * Excellent (grading scores against the model's raw argmax, see Bidder.evaluate).
 * The observation encoding only reads the acting player's hand (see
 * tools/policy_probe.mjs), so a board view is enough to reproduce the server's
 * judgment: fill the other three seats with the remaining cards in order.
 */
function preferredCall(view) {
  const calls = view.auction.map((a) => a.call);
  const turn = auctionState(view.dealer, calls).turn;
  const rest = [];
  for (let c = 0; c < 52; c++) if (!view.hand.includes(c)) rest.push(c);
  const hands = [[], [], [], []];
  hands[turn] = view.hand;
  let i = 0;
  for (const s of [0, 1, 2, 3]) if (s !== turn) hands[s] = rest.slice(13 * i, 13 * ++i);
  const { probs, mask } = bidder.policyFor({ hands, dealer: view.dealer, vul: view.vul }, calls);
  let best = -1;
  for (let c = 0; c < probs.length; c++) if (mask[c] && (best < 0 || probs[c] > probs[best])) best = c;
  return best;
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const shot = (name, fullPage = false) => page.screenshot({ path: `${outDir}/${name}.png`, fullPage });

const api = {
  get: async (path) => (await page.request.get(`${base}${path}`)).json(),
  post: async (path, data) => (await page.request.post(`${base}${path}`, data ? { data } : {})).json(),
};

/** Tap a card in the fan twice (select, then play) — cards overlap, so aim at the visible sliver. */
async function playCard(locator) {
  await locator.click({ position: { x: 6, y: 30 } });
  await page.waitForTimeout(250);
  const selected = page.locator('.handfan .cardbtn.selected');
  if (await selected.isVisible().catch(() => false)) await selected.click({ position: { x: 6, y: 30 } });
}

/**
 * Drive a board through the API until `stop` says to hand back to the UI —
 * pass to end auctions, play the first legal card otherwise.
 */
async function drive(tid, no, stop = () => false) {
  for (let i = 0; i < 100; i++) {
    const view = await api.get(`/api/tournaments/${tid}/boards/${no}`);
    if (view.state === 'done' || stop(view)) return view;
    if (!view.myTurn) throw new Error(`board ${no} not my turn in state ${view.state}`);
    if (view.state === 'bidding') await api.post(`/api/tournaments/${tid}/boards/${no}/call`, { call: 0 });
    else await api.post(`/api/tournaments/${tid}/boards/${no}/play`, { card: view.legalCards[0] });
  }
  throw new Error(`board ${no} never finished`);
}

// --- sign in and take a seat -------------------------------------------------
await page.goto(base);
await page.waitForSelector('input[placeholder*="dev"]');
await page.fill('input[placeholder*="dev"]', handle);
await page.click('text=DEV SIGN-IN');
await page.waitForSelector('input[placeholder="Handle"], [data-testid="splash"], .home-cta');
if (await page.locator('input[placeholder="Handle"]').isVisible().catch(() => false)) {
  await page.fill('input[placeholder="Handle"]', handle);
  await page.click('text=Continue');
}
await page.waitForSelector('[data-testid="splash"], .home-cta');
if (await page.locator('[data-testid="splash"]').isVisible().catch(() => false)) {
  await page.click('[data-testid="splash"]');
}
await page.waitForSelector('.home-cta');

const { tournamentId: tid } = await api.post('/api/play');

// The featured board: the first one whose auction actually asks something of
// you — a board where the model's own choice is Pass makes for a dull meaning
// panel, so drive that one out of the way and look at the next.
let featured = 0;
let best = PASS;
for (let no = 1; no <= 4; no++) {
  const view = await api.get(`/api/tournaments/${tid}/boards/${no}`);
  if (view.state !== 'bidding' || !view.myTurn) continue;
  best = preferredCall(view);
  if (best !== PASS) {
    featured = no;
    break;
  }
  await drive(tid, no);
}
if (!featured) {
  // Placement resumes an unfinished tournament, so a re-run under the same
  // handle picks up a half-played one with no live auction left.
  throw new Error(`no board with a live bidding decision — re-run with a fresh SHOT_HANDLE (had "${handle}")`);
}

// 01 — bidding: a call selected, its SAYC meaning read before you commit
await page.goto(`${base}/t/${tid}/b/${featured}`);
await page.waitForSelector('.bidbox', { timeout: 30000 });
if (best >= 23) await page.click('.bidbox-fold'); // levels 5–7 sit below the fold
await page.locator('.bidbox .grid button.bid').nth(best - 3).click();
await page.waitForSelector('.meaning-panel .mtitle');
await page.waitForTimeout(400);
await shot('01-bidding-meaning');

// 02 — the grade toast that stamps the call you just made
await page.click('.confirm-row .btn-primary');
await page.waitForSelector('.grade-toast', { timeout: 30000 });
await page.waitForTimeout(500);
await shot('02-grade-toast');

// 03 — card play: dummy tabled, a trick on the felt
await drive(tid, featured, (v) => v.state === 'playing' && v.myTurn);
await page.goto(`${base}/t/${tid}/b/${featured}`);
await page.waitForSelector('.handfan.interactive .cardbtn:enabled', { timeout: 30000 });
await playCard(page.locator('.handfan.interactive .cardbtn:enabled').nth(2));
await page.waitForTimeout(2600); // robots follow; the trick stages in card by card
await shot('03-card-play');

// 04 — the toll receipt, printing off the last card of the board
const last = await drive(tid, featured, (v) => v.state === 'playing' && v.myTurn && v.hand.length === 1);
await page.goto(`${base}/t/${tid}/b/${featured}`);
if (last.state !== 'done') {
  await page.waitForSelector('.handfan.interactive .cardbtn:enabled', { timeout: 30000 });
  await playCard(page.locator('.handfan.interactive .cardbtn:enabled').first());
  // A claim can fire on the way out (the robots proving the rest is theirs) —
  // dismiss the announcement and let the fast-forward run.
  await page.waitForSelector('.claim-overlay, .receipt-panel, .result', { timeout: 60000 });
  if (await page.locator('.claim-overlay').isVisible().catch(() => false)) {
    await page.click('.claim-overlay');
  }
  await page.waitForSelector('.receipt-panel, .result', { timeout: 60000 });
}
// The receipt only prints itself on the live transition; reopen it otherwise.
if (!(await page.locator('.receipt-panel').isVisible().catch(() => false))) {
  await page.waitForSelector('.receipt-link');
  await page.click('.receipt-link');
  await page.waitForSelector('.receipt-panel');
}
await page.waitForTimeout(3200); // rows print on a timer
await shot('04-toll-receipt');

// 05 — the board result behind it: the field, the deal, the auction recap
await page.click('text=SEE THE FIELD');
await page.waitForSelector('.fieldtable');
await page.waitForTimeout(600);
await shot('05-board-result', true);

// 06 — tournament summary: four boards paid in full
for (let no = 1; no <= 4; no++) await drive(tid, no);
await page.goto(`${base}/t/${tid}`);
await page.waitForSelector('.tourney-result-hero', { timeout: 30000 });
await page.waitForTimeout(1200);
await shot('06-tournament-result');

// Rankings and stats only say anything once there's a record behind them, and
// the leaderboard holds you provisional until you've finished four — so pay a
// few more tolls before shooting either.
for (let i = 0; i < EXTRA_TOURNAMENTS; i++) {
  const { tournamentId } = await api.post('/api/play');
  for (let no = 1; no <= 4; no++) await drive(tournamentId, no);
}

// 07 — rankings
await page.goto(`${base}/leaderboard`);
await page.waitForSelector('.rank-row');
await page.waitForTimeout(400);
await shot('07-rankings');

// 08 — stats (a taller frame: the page runs well past one phone screen)
await page.click('.tabbar >> text=STATS');
await page.waitForSelector('.player-hero');
await page.setViewportSize({ width: 390, height: 1400 });
await page.waitForTimeout(1200); // sparklines + flip digits settle
await shot('08-stats');
await page.setViewportSize({ width: 390, height: 844 });

// 09 — the glossary sheet, opened from the ledger
await page.click('.tabbar >> text=GLOSSARY');
await page.waitForSelector('.gloss-row');
await page.locator('.gloss-row', { hasText: /^Finesse/ }).click();
await page.waitForSelector('.sheet');
await page.waitForTimeout(600);
await shot('09-glossary-sheet');
await page.click('[aria-label="Close"]');

// 10 — night mode, mid-play on a second board
const { tournamentId: tid2 } = await api.post('/api/play');
await drive(tid2, 1, (v) => v.state === 'playing' && v.myTurn);
await page.evaluate(() => localStorage.setItem('nb:theme', 'night'));
await page.goto(`${base}/t/${tid2}/b/1`);
await page.waitForSelector('.handfan.interactive .cardbtn:enabled', { timeout: 30000 });
await playCard(page.locator('.handfan.interactive .cardbtn:enabled').nth(2));
await page.waitForTimeout(2600);
await shot('10-night-play');

// 11 — the desktop shell, back in daylight
await page.evaluate(() => localStorage.removeItem('nb:theme'));
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto(base);
await page.waitForSelector('.home-cta');
await page.waitForTimeout(600);
await shot('11-desktop-home');

await browser.close();
console.log('readme shots complete');
