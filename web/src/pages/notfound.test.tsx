import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { meFixture } from '../test/fixtures';
import { renderWithMe } from '../test/utils';
import NotFound from './NotFound';

describe('NotFound', () => {
  it('shows the refused postmark, the headline, and a way back to the bridge', () => {
    renderWithMe(<NotFound />, { me: meFixture });
    expect(screen.getByText('REFUSED')).toBeInTheDocument();
    expect(screen.getByText('This page does not exist.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to the bridge/i })).toHaveAttribute('href', '/');
  });
});
