import { APIRequestContext, Page, expect, request, test } from '@playwright/test';

/**
 * Dev sign-in on the splash, claim a handle, skip the first-crossing tour at
 * its gate — lands on Home ("Good …, {name}"). (A fresh account meets the
 * tollkeeper instead of the splash; the tour's own flow is covered by the
 * web unit suite, so the smoke tests take the "skip the tutorial" door.)
 */
async function signInAndOnboard(page: Page, name: string) {
  await page.goto('/');
  await page.fill('input[placeholder*="dev"]', name);
  await page.getByRole('button', { name: /dev sign-in/i }).click();
  await page.fill('input[placeholder="Handle"]', name);
  await page.getByRole('button', { name: /continue/i }).click();
  await page.getByRole('button', { name: /skip the tutorial/i }).click();
  // a returning visitor may still get the splash intro — tap skips it
  const splash = page.getByTestId('splash');
  await splash.waitFor({ timeout: 10_000 }).catch(() => {});
  if (await splash.isVisible().catch(() => false)) await splash.click();
  await expect(page.getByText(new RegExp(`Good (morning|afternoon|evening), ${name.split(' ')[0]}`))).toBeVisible();
}

/**
 * A laydown claim can fire the instant a card is submitted (advanceRobots
 * resolves the rest of the board server-side), popping the modal
 * ClaimOverlay — which then intercepts any click still landing on the table
 * underneath it. Dismiss it (tap anywhere, same as a real user) before every
 * card interaction below, since which deal (and whether it claims early)
 * varies run to run.
 */
async function dismissClaimIfPresent(page: Page) {
  const overlay = page.locator('.claim-overlay');
  if (await overlay.isVisible().catch(() => false)) await overlay.click();
}

/** Fast, UI-free board completion via direct API calls (same shape as scripts/e2e.mjs). */
async function playBoardFast(req: APIRequestContext, tid: number, no: number) {
  for (let i = 0; i < 100; i++) {
    const view = await (await req.get(`/api/tournaments/${tid}/boards/${no}`)).json();
    if (view.state === 'done') return;
    if (view.state === 'bidding' && view.myTurn) {
      await req.post(`/api/tournaments/${tid}/boards/${no}/call`, { data: { call: 0 } });
    } else if (view.state === 'playing' && view.myTurn) {
      await req.post(`/api/tournaments/${tid}/boards/${no}/play`, { data: { card: view.legalCards[0] } });
    } else {
      throw new Error(`playBoardFast stuck: state=${view.state} myTurn=${view.myTurn}`);
    }
  }
  throw new Error(`playBoardFast: tournament ${tid} board ${no} never finished`);
}

/**
 * One asserting end-to-end pass over the real stack at phone viewport:
 * login → handle prompt → JIT placement → bid-meaning preview → grade toast →
 * call inspector → card play → board result. Guards the client↔server wiring
 * that unit suites can't see.
 */
test('learn-and-play loop works end to end on mobile', async ({ page, context }) => {
  const name = `Smoke ${Date.now()}`;

  await signInAndOnboard(page, name);

  // Play the toll → placed into a tournament, bidding view with HCP badge
  await page.click('.home-cta');
  await expect(page.locator('.bidbox')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.hcp-badge').first()).toBeVisible();
  const boardUrl = new URL(page.url());
  const [, , tid, , no] = boardUrl.pathname.split('/'); // /t/:tid/b/:no

  // levels 5–7 live behind the fold, and the high bids must be reachable.
  // WHICH of BidBox's two states this deal lands in is luck, not wiring:
  // tournament seeds are random (randomBytes in tournaments.ts), so the robots
  // sometimes bid past 4NT before our first turn and the box auto-expands
  // rather than show a fold over zero enabled bids. Asserting the fold
  // unconditionally made this a coin-flip across CI runs. The conditional
  // itself is covered deterministically by the unit suite — see
  // game.test.tsx's 'auto-expands when every legal bid lives above level 4' —
  // so all this needs to prove is that 7NT is reachable either way.
  const fold = page.locator('.bidbox-fold');
  if (await fold.count()) await fold.click();
  await expect(page.locator('.bidbox button.bid[aria-label="7NT"]')).toBeVisible();

  // tapping a past call in the auction opens the inspector bottom sheet
  // (board 1 deals from North, so robot calls precede ours)
  await page.locator('.auction tbody button').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: /close/i }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // the meaning panel appears BEFORE the bid is submitted
  await expect(page.locator('.grade-toast')).toHaveCount(0);
  await page.locator('.bidbox button.bid:enabled').first().click();
  const meaning = page.locator('.meaning-panel');
  await expect(meaning).toBeVisible();
  await expect(meaning.locator('.mtitle')).not.toHaveText('');
  await expect(page.locator('.grade-toast')).toHaveCount(0);

  // confirm → the bid is graded with the star stamp
  await page.click('.confirm-row .btn-primary');
  await expect(page.locator('.grade-toast')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.grade-toast .stargrade')).toBeVisible();

  // finish the auction by passing (robot annotations may appear in between)
  for (let i = 0; i < 12; i++) {
    if (await page.locator('.trick, .result').first().isVisible().catch(() => false)) break;
    const pass = page.locator('.bidbox .callrow button.bid:enabled', { hasText: 'Pass' }).first();
    if (!(await pass.isVisible().catch(() => false))) {
      await page.waitForTimeout(400);
      continue;
    }
    await pass.click();
    await page.click('.confirm-row .btn-primary');
    await page.waitForTimeout(400);
  }
  // Generous: the transition into play runs the robots' first card burst, and
  // double-dummy solves have a documented heavy tail on rare deals (seconds,
  // occasionally tens of seconds on slow CI hardware).
  await expect(page.locator('.trick, .result').first()).toBeVisible({ timeout: 60_000 });

  // if we're defending/declaring, tap-tap plays a card and the hand shrinks
  if (await page.locator('.trick').isVisible().catch(() => false)) {
    const interactive = page.locator('.handfan.interactive');
    await expect(interactive.first()).toBeVisible({ timeout: 15_000 });
    // Playing a card must shrink the fan it was played from. Track that fan
    // by position (first/last), because the dummy fan can APPEAR after the
    // opening lead and shift total counts upward.
    const clickedIsLast = await page
      .locator('.handfan')
      .last()
      .evaluate((el) => el.classList.contains('interactive'));
    const clickedFan = () => (clickedIsLast ? page.locator('.handfan').last() : page.locator('.handfan').first());
    const before = await clickedFan().locator('.cardbtn').count();
    // Tap once to select (visible left sliver), then tap the raised card to
    // play. A laydown claim can fire mid-sequence on this deal and take over
    // remaining decisions automatically (including this one, or the auto-play
    // timer for a forced single-legal-card turn can race ahead of the manual
    // tap) — dismiss any overlay before each step and tolerate the card
    // having already been played out from under us either way; the poll
    // below is the real assertion regardless of which path shrank the fan.
    await dismissClaimIfPresent(page);
    await clickedFan()
      .locator('.cardbtn:enabled')
      .first()
      .click({ position: { x: 6, y: 30 } })
      .catch(() => {});
    await dismissClaimIfPresent(page);
    await page
      .locator('.handfan .cardbtn.selected')
      .click({ position: { x: 6, y: 30 } })
      .catch(() => {});
    await dismissClaimIfPresent(page);
    await expect
      .poll(async () => clickedFan().locator('.cardbtn').count(), { timeout: 15_000 })
      .toBeLessThan(before);

    // drive the rest of the board through the API (same session cookies)
    for (let i = 0; i < 60; i++) {
      const view = await (await context.request.get(`/api/tournaments/${tid}/boards/${no}`)).json();
      if (view.state === 'done') break;
      if (view.state === 'bidding' && view.myTurn) {
        await context.request.post(`/api/tournaments/${tid}/boards/${no}/call`, { data: { call: 0 } });
      } else if (view.state === 'playing' && view.myTurn) {
        await context.request.post(`/api/tournaments/${tid}/boards/${no}/play`, { data: { card: view.legalCards[0] } });
      } else {
        throw new Error(`stuck: ${view.state}`);
      }
    }
    await page.reload();
  }

  // board result: score hero, matchpoint %, field table, the revealed deal
  await expect(page.locator('.result')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.pct-big')).toContainText('%');
  await expect(page.locator('.fieldtable')).toBeVisible();
  await expect(page.locator('.deal-diagram')).toBeVisible();
  await expect(page.locator('.board-actions .ds-btn').first()).toContainText(/NEXT BOARD|TOURNAMENT/);

  // toll receipt: reopens from the result, itemizes the score, returns to the field
  await page.click('.receipt-link');
  await expect(page.locator('.receipt-panel')).toBeVisible();
  await expect(page.locator('.receipt-total').first()).toContainText(/Toll (collected|refused)|Passed out/);
  await page.click('text=SEE THE FIELD');
  await expect(page.locator('.fieldtable')).toBeVisible();
});

/** Glossary wiring: bottom tab → ledger, search, term sheet with attribution. */
test('glossary is reachable, searchable, and opens term sheets', async ({ page }) => {
  const name = `Gloss ${Date.now()}`;

  await signInAndOnboard(page, name);

  await page.click('.tabbar >> text=GLOSSARY');
  await expect(page).toHaveURL('/glossary');
  await expect(page.locator('.gloss-row').first()).toBeVisible();

  // search narrows to the aliased term, and its sheet carries the credit
  await page.fill('.gloss-search', 'hook');
  // ^-anchored: other rows can mention "finesse" mid-definition
  await expect(page.locator('.gloss-row', { hasText: /^Finesse/ })).toBeVisible();
  await page.locator('.gloss-row', { hasText: /^Finesse/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Finesse');
  await expect(dialog).toContainText('CC BY-SA 4.0');
  await expect(page).toHaveURL(/term=finesse/);

  // the sheet lives in the URL: browser back closes it (and unwinds nested
  // related-term taps one level at a time)
  await dialog.getByRole('button', { name: 'Tenace' }).click();
  await expect(page).toHaveURL(/term=tenace/);
  await page.goBack();
  await expect(dialog).toContainText('Finesse');
  await page.goBack();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // ✕ pops a whole chain at once
  await page.locator('.gloss-row', { hasText: /^Finesse/ }).click();
  await dialog.getByRole('button', { name: 'Tenace' }).click();
  await page.getByRole('button', { name: /close/i }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).not.toHaveURL(/term=/);
});

/** Stats page wiring: bottom tab → own page, rankings row → other pages. */
test('player stats page is reachable for self and others', async ({ page, context }) => {
  test.setTimeout(240_000); // seeds real rated history below — see comment there
  const name = `Stats ${Date.now()}`;

  await signInAndOnboard(page, name);

  // own stats via the bottom tab; fresh account → rating hero + empty state
  await page.click('.tabbar >> text=STATS');
  const { user } = await (await context.request.get('/api/me')).json();
  await expect(page).toHaveURL(`/players/${user.id}`);
  await expect(page.getByText('NICKEL RATING')).toBeVisible();
  await expect(page.getByText(/No boards played yet/)).toBeVisible();
  await expect(page.getByRole('link', { name: /play your first board/i })).toBeVisible();

  // The leaderboard only surfaces players past its provisional quota
  // (PROVISIONAL_MIN_TOURNAMENTS in server/src/tournaments.ts, currently 4
  // — this suite runs under DEV_AUTH, not DEMO, so no override applies), and
  // a fresh account like the one above never qualifies. Drive two throwaway
  // accounts through that many jointly-completed tournaments via direct API
  // calls (fast, no UI) so a genuine row exists to click — exercising the
  // real production gate instead of faking around it. B joins each of A's
  // tournaments directly by id (any authenticated handle-holder can play any
  // non-exhibit tournament this way — no placement/grace-window dependency),
  // so this doesn't rely on JIT placement routing two accounts together.
  const origin = new URL(page.url()).origin;
  const a = await request.newContext({ baseURL: origin });
  const b = await request.newContext({ baseURL: origin });
  const aName = `Rank A ${Date.now()}`;
  const bName = `Rank B ${Date.now()}`;
  await a.post('/auth/dev', { data: { name: aName } });
  await a.post('/api/handle', { data: { handle: aName } });
  await b.post('/auth/dev', { data: { name: bName } });
  await b.post('/api/handle', { data: { handle: bName } });
  for (let t = 0; t < 4; t++) {
    const placement = await (await a.post('/api/play')).json();
    for (let no = 1; no <= 4; no++) {
      await playBoardFast(a, placement.tournamentId, no);
      await playBoardFast(b, placement.tournamentId, no);
    }
  }
  await a.dispose();
  await b.dispose();

  // any rankings row links to that player's stats page
  await page.click('.tabbar >> text=RANKINGS');
  await expect(page.locator('.rank-row').first()).toBeVisible();
  await page.locator('.rank-row').first().click();
  await expect(page).toHaveURL(/\/players\/\d+/);
  await expect(page.locator('.player-hero')).toBeVisible();
});

/**
 * The settings gate. Night mode is the one preference with a second
 * implementation to keep honest — the blocking inline script in
 * web/index.html re-applies the stored choice before first paint, and it is
 * hand-kept in sync with theme.ts — so this walks the real switch and then
 * reloads, which is the only place that duplicate can be caught.
 */
test('settings apply a night-mode choice that survives a reload', async ({ page }) => {
  await signInAndOnboard(page, `Settings ${Date.now()}`);

  await page.click('.tabbar >> text=SETTINGS');
  await expect(page).toHaveURL('/settings');
  await page.getByRole('group', { name: 'Appearance' }).getByRole('button', { name: 'NIGHT' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');

  // Suit colors is the other device-local row (see suitPalette.ts) — same
  // pre-paint-script pattern as Appearance, so it gets the same reload check.
  await page.getByRole('group', { name: 'Suit colors' }).getByRole('button', { name: 'COLORBLIND' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-suit-palette', 'colorblind');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');
  await expect(page.locator('html')).toHaveAttribute('data-suit-palette', 'colorblind');

  // the other rows are account state, so they round-trip through the server
  await page.getByRole('group', { name: 'Name on the ladder' }).getByRole('button', { name: 'OFF' }).click();
  await page.getByRole('group', { name: 'Fast forward settled tricks' }).getByRole('button', { name: 'OFF' }).click();
  await page.getByRole('group', { name: 'Bid feedback' }).getByRole('button', { name: 'OFF' }).click();
  await expect
    .poll(async () => {
      const { user } = await (await page.request.get('/api/me')).json();
      return [user.ladderListed, user.fastForward, user.bidFeedback];
    })
    .toEqual([false, false, false]);
});

/**
 * The colorblind suit palette's night variant is only reachable through a CSS
 * cascade tie: the new `@media (prefers-color-scheme: dark)` colorblind mirror
 * and the pre-existing standard one are both equal-specificity overrides of
 * :root, so which wins depends on which is textually LATER in style.css, not on
 * specificity (see the block comment above both in style.css). An
 * attribute-presence assertion can't catch a regression of that ordering — only
 * a computed-style check under emulated dark OS + Appearance left at SYSTEM
 * (i.e. no explicit data-theme) can.
 */
test('a colorblind palette under system-dark OS repaints hearts, not the standard night red', async ({
  browser,
}) => {
  const context = await browser.newContext({ colorScheme: 'dark' });
  const page = await context.newPage();
  await signInAndOnboard(page, `Colorblind ${Date.now()}`);

  await page.click('.tabbar >> text=SETTINGS');
  await expect(page).toHaveURL('/settings');
  // Appearance stays at SYSTEM (its default) — data-theme is never set, so the
  // dark palette can only come from the @media mirror, not an explicit override.
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);

  await page.getByRole('group', { name: 'Suit colors' }).getByRole('button', { name: 'COLORBLIND' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-suit-palette', 'colorblind');

  const hearts = page.locator('.suit-preview .suit-h');
  await expect(hearts).toHaveCSS('color', 'rgb(111, 179, 224)'); // night colorblind --suit-h: #6fb3e0
});

/**
 * The unauthenticated pass: what someone who has never signed in can reach.
 *
 * The point of the landing page and the public tour is that a visitor gets a
 * real look at the game before the toll is asked, so the thing to guard here
 * is that none of it quietly depends on a session — a 401 in the middle of the
 * practice board is invisible to the unit suites, which mock the API away.
 * Runs in its own context so no cookie from the tests above leaks in.
 */
test('a visitor with no account can read the pitch and walk the practice deal', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();

  await page.goto('/');
  // the splash is still the hero, and the pitch is under it
  await expect(page.getByTestId('splash')).toBeVisible();
  await expect(page.getByText('Everyone plays the same deals.')).toBeVisible();

  // the three doors that need no account
  await page.getByRole('link', { name: /the field/i }).click();
  await expect(page).toHaveURL(/\/leaderboard$/);
  await expect(page.locator('.rank-head')).toBeVisible();
  await expect(page.locator('.signinbar')).toBeVisible();

  // …and the one profile a visitor can open: a house persona. Real players'
  // records need an account, which is why the ladder's own rows don't link
  // here and this panel does.
  await page.locator('.rank-house .rank-row-house').first().click();
  await expect(page).toHaveURL(/\/players\/\d+$/);
  await expect(page.locator('.player-hero')).toBeVisible();
  await expect(page.locator('.house-tag').first()).toBeVisible();
  // owner-only controls stay off someone else's profile, signed out most of all
  await expect(page.getByRole('button', { name: /sign out/i })).toHaveCount(0);

  await page.goto('/');
  await page.getByRole('link', { name: /walk a practice deal/i }).click();
  await expect(page).toHaveURL(/\/tour$/);

  // straight onto the real board UI — bid box, hand, HCP badge, all of it
  // rendered from the captured deal with no server board behind it
  await expect(page.locator('.bidbox')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.hcp-badge').first()).toBeVisible();
  await expect(page.locator('.tour-narr')).toBeVisible();

  // and play is still the toll: a shared board link invites, it doesn't open.
  // Asserted on the landing page itself rather than on a named sign-in button —
  // WHICH door exists depends on the deployment's credentials (this harness has
  // DEV_AUTH and no Google), which is exactly what SignInActions resolves.
  await page.goto('/t/1/b/1');
  await expect(page.getByText('Everyone plays the same deals.')).toBeVisible();
  await expect(page.locator('.bidbox')).toHaveCount(0);
});
