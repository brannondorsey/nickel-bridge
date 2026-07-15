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
