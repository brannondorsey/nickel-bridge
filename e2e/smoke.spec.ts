import { Page, expect, test } from '@playwright/test';

/**
 * Dev sign-in on the splash, claim a handle, tap through the first-visit
 * splash intro — lands on Home ("Good …, {name}").
 */
async function signInAndOnboard(page: Page, name: string) {
  await page.goto('/');
  await page.fill('input[placeholder*="dev"]', name);
  await page.getByRole('button', { name: /dev sign-in/i }).click();
  await page.fill('input[placeholder="Handle"]', name);
  await page.getByRole('button', { name: /continue/i }).click();
  // the first authenticated visit plays the splash intro — tap skips it
  const splash = page.getByTestId('splash');
  await splash.waitFor({ timeout: 10_000 }).catch(() => {});
  if (await splash.isVisible().catch(() => false)) await splash.click();
  await expect(page.getByText(new RegExp(`Good (morning|afternoon|evening), ${name.split(' ')[0]}`))).toBeVisible();
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

  // levels 5–7 hide behind the fold until asked for
  await expect(page.locator('.bidbox button.bid[aria-label="7NT"]')).toHaveCount(0);
  await page.click('.bidbox-fold');
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
    // tap once to select (visible left sliver), then tap the raised card to play
    await clickedFan().locator('.cardbtn:enabled').first().click({ position: { x: 6, y: 30 } });
    const selected = page.locator('.handfan .cardbtn.selected');
    await expect(selected).toBeVisible();
    await selected.click({ position: { x: 6, y: 30 } });
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

/** Stats page wiring: bottom tab → own page, rankings row → other pages. */
test('player stats page is reachable for self and others', async ({ page, context }) => {
  const name = `Stats ${Date.now()}`;

  await signInAndOnboard(page, name);

  // own stats via the bottom tab; fresh account → rating hero + empty state
  await page.click('.tabbar >> text=STATS');
  const { user } = await (await context.request.get('/api/me')).json();
  await expect(page).toHaveURL(`/players/${user.id}`);
  await expect(page.getByText('NICKEL RATING')).toBeVisible();
  await expect(page.getByText(/No boards played yet/)).toBeVisible();
  await expect(page.getByRole('link', { name: /play your first board/i })).toBeVisible();

  // any rankings row links to that player's stats page
  await page.click('.tabbar >> text=RANKINGS');
  await expect(page.locator('.rank-row').first()).toBeVisible();
  await page.locator('.rank-row').first().click();
  await expect(page).toHaveURL(/\/players\/\d+/);
  await expect(page.locator('.player-hero')).toBeVisible();
});
