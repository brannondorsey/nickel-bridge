import { expect, test } from '@playwright/test';

/**
 * One asserting end-to-end pass over the real stack at phone viewport:
 * login → JIT placement → bid-meaning preview → grade toast → card play →
 * board result. Guards the client↔server wiring that unit suites can't see.
 */
test('learn-and-play loop works end to end on mobile', async ({ page, context }) => {
  const name = `Smoke ${Date.now()}`;

  // login (dev auth) → lobby
  await page.goto('/');
  await page.fill('input[placeholder*="dev"]', name);
  await page.click('text=Dev sign-in');
  await expect(page.getByText(`Hi, ${name.split(' ')[0]}`)).toBeVisible();

  // Play → placed into a tournament, bidding view with HCP badge
  await page.click('button:has-text("Play")');
  await expect(page.locator('.bidbox')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.hcp-badge')).toBeVisible();
  const boardUrl = new URL(page.url());
  const [, , tid, , no] = boardUrl.pathname.split('/'); // /t/:tid/b/:no

  // the meaning panel appears BEFORE the bid is submitted
  await expect(page.locator('.grade-toast')).toHaveCount(0);
  await page.locator('.bidbox button.bid:enabled').first().click();
  const meaning = page.locator('.meaning-panel');
  await expect(meaning).toBeVisible();
  await expect(meaning.locator('.mtitle')).not.toHaveText('');
  await expect(page.locator('.grade-toast')).toHaveCount(0);

  // confirm → the bid is graded with stars
  await page.click('.confirm-row .btn-primary');
  await expect(page.locator('.grade-toast')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.grade-toast .stars')).toBeVisible();

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
  await expect(page.locator('.trick, .result').first()).toBeVisible({ timeout: 30_000 });

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

  // board result: score hero, matchpoint %, field table
  await expect(page.locator('.result')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.pct-big')).toContainText('%');
  await expect(page.locator('.fieldtable')).toBeVisible();
  await expect(page.locator('.result .btn-primary')).toContainText(/Next board|Tournament/);
});
