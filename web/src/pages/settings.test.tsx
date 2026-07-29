import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { meFixture } from '../test/fixtures';
import { apiMock, renderWithMe } from '../test/utils';
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
  });

  it('applies and persists a night-mode choice', async () => {
    renderSettings();
    await userEvent.click(segment('Appearance', 'NIGHT')!);
    expect(localStorage.getItem(THEME_KEY)).toBe('night');
    expect(document.documentElement.getAttribute('data-theme')).toBe('night');
  });

  // Both account switches send a PARTIAL patch: sending the whole object
  // would let a stale render clobber the other setting.
  it.each([
    ['Fast forward settled tricks', 'fastForward'],
    ['Name on the ladder', 'ladderListed'],
  ])('writes %s to the account and refreshes the session', async (group, key) => {
    apiMock.setPrefs.mockResolvedValue({ ladderListed: true, fastForward: true });
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

  it('signs out', async () => {
    apiMock.logout.mockResolvedValue({ ok: true });
    const { refresh } = renderSettings();
    await userEvent.click(screen.getByRole('button', { name: /sign out/i }));
    expect(apiMock.logout).toHaveBeenCalled();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});
