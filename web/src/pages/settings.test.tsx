import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    ['Fast forward settled tricks', 'fastForward'],
    ['Name on the ladder', 'ladderListed'],
    ['Bid feedback', 'bidFeedback'],
  ])('writes %s to the account and refreshes the session', async (group, key) => {
    apiMock.setPrefs.mockResolvedValue({ ladderListed: true, fastForward: true, bidFeedback: true });
    const { refresh } = renderSettings();
    expect(segment(group, 'ON')).toHaveClass('active');
    await userEvent.click(segment(group, 'OFF')!);
    expect(apiMock.setPrefs).toHaveBeenCalledWith({ [key]: false });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('reflects an account that is already unlisted and playing tails at table speed', () => {
    renderSettings({ ...meFixture, user: { ...meFixture.user!, ladderListed: false, fastForward: false } });
    expect(segment('Name on the ladder', 'OFF')).toHaveClass('active');
    expect(segment('Fast forward settled tricks', 'OFF')).toHaveClass('active');
  });

  // Table speed is a genuinely continuous slider, not a PrefSwitch, so it
  // needs its own coverage: a drag's `input`/onChange ticks must move the
  // thumb (and the account, once committed) in EITHER direction from the
  // default midpoint — to an arbitrary, off-grid position, not just a fixed
  // set of stops — and a tick alone must never hit the network — only
  // release (mouseup/touchend/keyup) commits, so a mid-drag position is
  // never persisted.
  it('defaults Table speed to the midpoint and only commits a slider move on release, to an off-grid position', async () => {
    const { refresh } = renderSettings();
    const slider = screen.getByRole('slider', { name: 'Table speed' });
    expect(slider).toHaveValue('0');

    apiMock.setPrefs.mockResolvedValue({ ladderListed: true, fastForward: true, tableSpeed: 0.63, bidFeedback: true });
    fireEvent.change(slider, { target: { value: '0.63' } });
    expect(slider).toHaveValue('0.63'); // the thumb tracks the drag immediately...
    expect(apiMock.setPrefs).not.toHaveBeenCalled(); // ...but a tick alone never writes

    fireEvent.mouseUp(slider);
    expect(apiMock.setPrefs).toHaveBeenCalledWith({ tableSpeed: 0.63 });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  // A keyboard step (arrow key) is its own discrete commit-worthy action —
  // no drag to release, so keyup alone must fire the write.
  it('commits a keyboard step on keyup, same as a drag release', async () => {
    renderSettings();
    const slider = screen.getByRole('slider', { name: 'Table speed' });
    apiMock.setPrefs.mockResolvedValue({ ladderListed: true, fastForward: true, tableSpeed: -0.5, bidFeedback: true });
    fireEvent.change(slider, { target: { value: '-0.5' } });
    fireEvent.keyUp(slider);
    expect(apiMock.setPrefs).toHaveBeenCalledWith({ tableSpeed: -0.5 });
  });

  it('reflects an account that already moved Table speed off the midpoint, in either direction', () => {
    const { unmount } = renderSettings({ ...meFixture, user: { ...meFixture.user!, tableSpeed: 1 } });
    expect(screen.getByRole('slider', { name: 'Table speed' })).toHaveValue('1');
    unmount();
    renderSettings({ ...meFixture, user: { ...meFixture.user!, tableSpeed: -1 } });
    expect(screen.getByRole('slider', { name: 'Table speed' })).toHaveValue('-1');
  });

  // The slider's revert target is the last value the ACCOUNT confirmed, not
  // "wherever the thumb was mid-drag" — regression coverage for exactly the
  // bug commitTableSpeed's own doc comment in Settings.tsx warns against.
  it('reverts a failed slider commit to the account default, not the failed drag position', async () => {
    apiMock.setPrefs.mockRejectedValue(new Error('nope'));
    renderSettings();
    const slider = screen.getByRole('slider', { name: 'Table speed' });
    fireEvent.change(slider, { target: { value: '0.8' } });
    fireEvent.mouseUp(slider);
    expect(await screen.findByText(/didn't save/i)).toBeInTheDocument();
    expect(slider).toHaveValue('0');
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
      return Promise.resolve({ ladderListed: true, fastForward: true });
    });
    renderSettings();

    await userEvent.click(segment('Name on the ladder', 'OFF')!);
    await userEvent.click(segment('Fast forward settled tricks', 'OFF')!);
    await vi.waitFor(() => expect(segment('Fast forward settled tricks', 'OFF')).toHaveClass('active'));

    rejectLadder(new Error('nope'));
    expect(await screen.findByText(/didn't save/i)).toBeInTheDocument();
    expect(segment('Name on the ladder', 'ON')).toHaveClass('active');
    expect(segment('Fast forward settled tricks', 'OFF')).toHaveClass('active');
  });

  it('signs out', async () => {
    apiMock.logout.mockResolvedValue({ ok: true });
    const { refresh } = renderSettings();
    await userEvent.click(screen.getByRole('button', { name: /sign out/i }));
    expect(apiMock.logout).toHaveBeenCalled();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});
