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
import { BID_OFFSET, auctionState, callName } from '../packages/core/dist/index.js';
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
 * Wait out the robots' replies after your card: the staged animation runs, the
 * trick fills in, and the fan comes back live on your turn. Shooting on a fixed
 * timer instead lands on whatever beat it lands on — often "Robots are
 * thinking…" over a half-empty table.
 */
async function settleToYourTurn() {
  await page.waitForSelector('.handfan.interactive .cardbtn:enabled', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(600);
}

/**
 * The benchmark AI personas ("the house") play every ai_field tournament in the
 * background, on demand — so a sweep that races straight to the result screen
 * can arrive before any of them has finished, and shoot THE FIELD as a table of
 * one. Wait them out (they're scheduled human-first, so this is seconds, not
 * minutes) rather than shipping a screenshot that makes the app look empty.
 */
async function waitForField(rowSelector, minRows = 2, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if ((await page.locator(rowSelector).count()) >= minRows) return;
    await page.waitForTimeout(2000);
    await page.reload();
    await page.waitForSelector(rowSelector.split(' ')[0], { timeout: 30000 }).catch(() => {});
  }
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

// The featured board: the first one where the model's own choice is a contract
// bid. Pass makes for a dull meaning panel, and Double/Redouble live in the bid
// box's separate .callrow rather than the grid the shot clicks through — so
// both are reasons to drive that board out of the way and look at the next.
let featured = 0;
let best = 0;
for (let no = 1; no <= 4; no++) {
  const view = await api.get(`/api/tournaments/${tid}/boards/${no}`);
  if (view.state !== 'bidding' || !view.myTurn) continue;
  best = preferredCall(view);
  if (best >= BID_OFFSET) {
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
// The box shows a sliding four-level window from the cheapest legal bid, so a
// button's index in .grid depends on the auction — address it by its label and
// open the fold only when the target sits above the window.
const target = page.locator(`.bidbox button.bid[aria-label="${callName(best)}"]`);
if (!(await target.count())) await page.click('.bidbox-fold');
await target.click();
await page.waitForSelector('.meaning-panel .mtitle');
await page.waitForTimeout(400);
await shot('01-bidding-meaning');

// 02 — the grade toast that stamps the call you just made
await page.click('.confirm-row .btn-primary');
await page.waitForSelector('.grade-toast', { timeout: 30000 });
await page.waitForTimeout(500);
await shot('02-grade-toast');

// 03 — card play: dummy tabled, a trick on the felt. Stop on a turn with a real
// choice: a single legal card auto-plays itself (AUTO_PLAY_DELAY_MS) and the fan
// is gone before the tap lands.
await drive(tid, featured, (v) => v.state === 'playing' && v.myTurn && v.legalCards?.length > 1);
await page.goto(`${base}/t/${tid}/b/${featured}`);
await page.waitForSelector('.handfan.interactive .cardbtn:enabled', { timeout: 30000 });
await playCard(page.locator('.handfan.interactive .cardbtn:enabled').nth(2));
await settleToYourTurn(); // the robots answer, the trick stages in card by card
await shot('03-card-play');

// 10 — the same position in night mode. Shot here, off a board already known to
// be mid-trick on your turn, rather than from a second placement: which seat is
// on lead and whether the playable cards are in your fan or tabled in dummy's
// rail is luck of the deal, and a shot that has to gamble on it is a shot that
// intermittently fails.
await page.evaluate(() => localStorage.setItem('nb:theme', 'night'));
await page.reload();
await page.waitForSelector('.handfan .cardbtn', { timeout: 30000 });
await page.waitForTimeout(800);
await shot('10-night-play');
await page.evaluate(() => localStorage.removeItem('nb:theme'));
await page.reload();
await page.waitForSelector('.handfan .cardbtn', { timeout: 30000 });

// 04 — the toll receipt, printing off the last card of the board
// One card left in hand means one legal card, which is exactly what Board.tsx's
// auto-play effect fires on: it plays itself after AUTO_PLAY_DELAY_MS with no
// tap. Don't race it — a manual click here would cancel the timer if it landed
// first and throw at a vanished button if it didn't. Just watch the transition.
const last = await drive(tid, featured, (v) => v.state === 'playing' && v.myTurn && v.hand.length === 1);
await page.goto(`${base}/t/${tid}/b/${featured}`);
if (last.state !== 'done') {
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
await waitForField('.fieldtable-name');
await page.waitForTimeout(600);
await shot('05-board-result', true);

// 06 — tournament summary: four boards paid in full
for (let no = 1; no <= 4; no++) await drive(tid, no);
await page.goto(`${base}/t/${tid}`);
await page.waitForSelector('.tourney-result-hero', { timeout: 30000 });
await waitForField('.tourney-field-name'); // the final standings want the house in them too
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

// 11 — the first-crossing tour, the actual cold open for a new account. Demo
// mode suppresses the automatic one (App.tsx), but it stays replayable here.
await page.goto(`${base}/tour`);
await page.waitForSelector('.tour-gate, .tour-page');
await page.waitForTimeout(1400); // the cover's scene animates in
await shot('11-tour');

// 12 — the desktop shell, back in daylight
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto(base);
await page.waitForSelector('.home-cta');
await page.waitForTimeout(600);
await shot('12-desktop-home');

await browser.close();
console.log('readme shots complete');
