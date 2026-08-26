import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { meLoggedOut, meNoHandle } from '../test/fixtures';
import { apiMock, renderWithMe } from '../test/utils';
import CreateHandle from './CreateHandle';
import Login from './Login';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  get api() {
    return apiMock;
  },
}));

/**
 * The other half of auth.ts's signInFailed: a sign-in that did not complete
 * now redirects here with `?signin=`, instead of answering a bare JSON 400
 * that left the visitor nowhere. What matters is that the explanation and a
 * working PLAY THE TOLL are on screen together — the retry is the whole point.
 */
describe('Login — a sign-in that came back without a session', () => {
  it.each([
    ['expired', /gate closed before you came back through/i],
    ['cancelled', /turned back at the gate/i],
    ['failed', /something went wrong at the gate/i],
  ])('explains ?signin=%s and still offers the toll', async (reason, copy) => {
    renderWithMe(<Login />, { me: meLoggedOut, route: `/?signin=${reason}` });
    expect(screen.getByRole('status')).toHaveTextContent(copy);
    expect(screen.getByRole('link', { name: /play the toll/i })).toHaveAttribute('href', '/auth/google');
  });

  it('says nothing on an ordinary visit', () => {
    renderWithMe(<Login />, { me: meLoggedOut });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('says nothing for a value it does not recognise', () => {
    // The param rides in a shareable URL; a stranger opening a pasted link
    // must not be told a sign-in of theirs failed.
    renderWithMe(<Login />, { me: meLoggedOut, route: '/?signin=%3Cwat%3E' });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('Login', () => {
  it('dev sign-in trims the name, calls devLogin and refreshes', async () => {
    apiMock.devLogin.mockResolvedValue({ ok: true });
    const { refresh } = renderWithMe(<Login />, { me: meLoggedOut });
    await userEvent.type(screen.getByPlaceholderText('Name (dev login)'), '  Margaret  ');
    await userEvent.click(screen.getByRole('button', { name: /dev sign-in/i }));
    expect(apiMock.devLogin).toHaveBeenCalledWith('Margaret');
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('ignores an empty name and surfaces a failed sign-in inline', async () => {
    apiMock.devLogin.mockRejectedValue(new Error('nope'));
    renderWithMe(<Login />, { me: meLoggedOut });
    await userEvent.click(screen.getByRole('button', { name: /dev sign-in/i }));
    expect(apiMock.devLogin).not.toHaveBeenCalled();
    await userEvent.type(screen.getByPlaceholderText('Name (dev login)'), 'Margaret');
    await userEvent.click(screen.getByRole('button', { name: /dev sign-in/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('nope');
  });

  it('hides the dev form when devAuth is off', () => {
    renderWithMe(<Login />, { me: { ...meLoggedOut, devAuth: false } });
    expect(screen.queryByPlaceholderText('Name (dev login)')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /play the toll/i })).toBeInTheDocument();
  });
});

describe('CreateHandle', () => {
  it('submits the trimmed handle and refreshes', async () => {
    apiMock.setHandle.mockResolvedValue({ ok: true });
    const { refresh } = renderWithMe(<CreateHandle />, { me: meNoHandle });
    await userEvent.type(screen.getByPlaceholderText('Handle'), '  Peggy  ');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(apiMock.setHandle).toHaveBeenCalledWith('Peggy');
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('disables Continue until something is typed and shows server errors inline', async () => {
    apiMock.setHandle.mockRejectedValue(new Error('handle taken'));
    renderWithMe(<CreateHandle />, { me: meNoHandle });
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText('Handle'), 'Peggy');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('handle taken');
  });

  it('submits on Enter', async () => {
    apiMock.setHandle.mockResolvedValue({ ok: true });
    renderWithMe(<CreateHandle />, { me: meNoHandle });
    await userEvent.type(screen.getByPlaceholderText('Handle'), 'Peggy{Enter}');
    expect(apiMock.setHandle).toHaveBeenCalledWith('Peggy');
  });
});
