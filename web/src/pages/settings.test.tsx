import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LAST_VISIT_KEY, stampVisit } from '../splash';
import { meFixture } from '../test/fixtures';
import { apiMock, renderWithMe } from '../test/utils';
import { SUIT_PALETTE_KEY } from '../suitPalette';
import { THEME_KEY } from '../theme';
import Settings from './Settings';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  get api() {
    return apiMock;
  },
}));

const renderSettings = (me = meFixture) => renderWithMe(<Settings />, { me, route: '/settings' });

/** A lever's segment, scoped to its row so OFF/ON don't collide across rows. */
const segment = (group: string, label: string) =>
  Array.from(screen.getByRole('group', { name: group }).querySelectorAll('button')).find(
    (b) => b.textContent === label,
  )!;

describe('Settings', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-suit-palette');
  });

  it('applies and persists a night-mode choice', async () => {
    renderSettings();
    await userEvent.click(segment('Appearance', 'NIGHT')!);
    expect(localStorage.getItem(THEME_KEY)).toBe('night');
    expect(document.documentElement.getAttribute('data-theme')).toBe('night');
  });

  it('applies and persists a colorblind suit-palette choice, device-local like appearance', async () => {
    renderSettings();
    await userEvent.click(segment('Suit colors', 'COLORBLIND')!);
    expect(localStorage.getItem(SUIT_PALETTE_KEY)).toBe('colorblind');
    expect(document.documentElement.getAttribute('data-suit-palette')).toBe('colorblind');
    // Not sent to the server — no setPrefs call for this row.
    expect(apiMock.setPrefs).not.toHaveBeenCalled();
  });

  // The account switches send a PARTIAL patch: sending the whole object
  // would let a stale render clobber another setting.
  it.each([
    ['Name on the ladder', 'ladderListed'],
    ['Bid feedback', 'bidFeedback'],
    ['Beta features', 'betaFeatures'],
  ])('writes %s to the account and refreshes the session', async (group, key) => {
    apiMock.setPrefs.mockResolvedValue({ ladderListed: true, autoClaim: true, bidFeedback: true, betaFeatures: true });
    const { refresh } = renderSettings();
    expect(segment(group, 'ON')).toHaveClass('active');
    await userEvent.click(segment(group, 'OFF')!);
    expect(apiMock.setPrefs).toHaveBeenCalledWith({ [key]: false });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('reflects an account that is already unlisted and plays its own settled tails', () => {
    renderSettings({ ...meFixture, user: { ...meFixture.user!, ladderListed: false, autoClaim: false } });
    expect(segment('Name on the ladder', 'OFF')).toHaveClass('active');
    expect(segment('Settled tricks', 'PLAY THEM OUT')).toHaveClass('active');
  });

  // "Settled tricks" names both ends rather than OFF/ON (neither is an
  // absence), so it can't join the it.each above.
  it('writes "Settled tricks" to the account, defaulting to fast forward', async () => {
    apiMock.setPrefs.mockResolvedValue({ ladderListed: true, autoClaim: false, bidFeedback: true, betaFeatures: true });
    const { refresh } = renderSettings();
    expect(segment('Settled tricks', 'FAST FORWARD')).toHaveClass('active');
    await userEvent.click(segment('Settled tricks', 'PLAY THEM OUT')!);
    expect(apiMock.setPrefs).toHaveBeenCalledWith({ autoClaim: false });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('reflects an account that has not opted into beta features', () => {
    renderSettings({ ...meFixture, user: { ...meFixture.user!, betaFeatures: false } });
    expect(segment('Beta features', 'OFF')).toHaveClass('active');
  });

  // Unlike the three switches in the it.each above, "Double-tap to bid" defaults
  // OFF — so it gets its own test rather than joining that block, which assumes ON.
  it('defaults "Double-tap to bid" off, and writes it to the account like the other switches', async () => {
    apiMock.setPrefs.mockResolvedValue({ ladderListed: true, autoClaim: true, bidFeedback: true, doubleTapBid: true });
    const { refresh } = renderSettings();
    expect(segment('Double-tap to bid', 'OFF')).toHaveClass('active');
    await userEvent.click(segment('Double-tap to bid', 'ON')!);
    expect(apiMock.setPrefs).toHaveBeenCalledWith({ doubleTapBid: true });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  // Named ends rather than OFF/ON, like "Settled tricks" — and defaulting to
  // LEFT SIDE, the placement players asked for.
  it('writes "Trump placement" to the account, defaulting to left side', async () => {
    apiMock.setPrefs.mockResolvedValue({ ladderListed: true, autoClaim: true, trumpPlacement: 'suit' });
    const { refresh } = renderSettings();
    expect(
      [...screen.getByRole('group', { name: 'Trump placement' }).querySelectorAll('button')].map((b) => b.textContent),
    ).toEqual(['LEFT SIDE', 'SUIT ORDER']);
    expect(segment('Trump placement', 'LEFT SIDE')).toHaveClass('active');
    await userEvent.click(segment('Trump placement', 'SUIT ORDER')!);
    expect(apiMock.setPrefs).toHaveBeenCalledWith({ trumpPlacement: 'suit' });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('reflects an account that has opted back into suit order', () => {
    renderSettings({ ...meFixture, user: { ...meFixture.user!, trumpPlacement: 'suit' } });
    expect(segment('Trump placement', 'SUIT ORDER')).toHaveClass('active');
  });

  // The switch moves under the finger, so a rejected write has to move it
  // back — otherwise the screen quietly claims a state the server never
  // accepted.
  it('reverts the switch and explains when the write fails', async () => {
    apiMock.setPrefs.mockRejectedValue(new Error('nope'));
    renderSettings();
    await userEvent.click(segment('Name on the ladder', 'OFF')!);
    expect(await screen.findByText(/didn't save/i)).toBeInTheDocument();
    expect(segment('Name on the ladder', 'ON')).toHaveClass('active');
  });

  // A failed write must only revert the field it touched. Regression for a bug
  // where the whole `prefs` object was snapshotted per call: a later-resolving
  // failure on one field could stomp a different field's already-succeeded write.
  it('reverts only the field that failed, not a concurrently-succeeded one', async () => {
    let rejectLadder!: (e: unknown) => void;
    apiMock.setPrefs.mockImplementation((patch: Record<string, unknown>) => {
      if ('ladderListed' in patch) return new Promise((_, reject) => (rejectLadder = reject));
      return Promise.resolve({ ladderListed: true, autoClaim: true });
    });
    renderSettings();

    await userEvent.click(segment('Name on the ladder', 'OFF')!);
    await userEvent.click(segment('Settled tricks', 'PLAY THEM OUT')!);
    await vi.waitFor(() => expect(segment('Settled tricks', 'PLAY THEM OUT')).toHaveClass('active'));

    rejectLadder(new Error('nope'));
    expect(await screen.findByText(/didn't save/i)).toBeInTheDocument();
    expect(segment('Name on the ladder', 'ON')).toHaveClass('active');
    expect(segment('Settled tricks', 'PLAY THEM OUT')).toHaveClass('active');
  });

  it('signs out and drops the returning-player stamp', async () => {
    apiMock.logout.mockResolvedValue({ ok: true });
    stampVisit();
    expect(localStorage.getItem(LAST_VISIT_KEY)).not.toBeNull();
    const { refresh } = renderSettings();
    await userEvent.click(screen.getByRole('button', { name: /sign out/i }));
    expect(apiMock.logout).toHaveBeenCalled();
    expect(localStorage.getItem(LAST_VISIT_KEY)).toBeNull();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});
