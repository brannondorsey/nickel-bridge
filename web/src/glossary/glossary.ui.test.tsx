import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { GlossaryProse } from '../components/game/GlossaryProse';
import { GlossaryProvider } from './GlossaryContext';
import { TermSheet } from './TermSheet';
import type { ReactNode } from 'react';

/** Stand-in for the browser back button/swipe (MemoryRouter history). */
function HistoryBack() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      history-back
    </button>
  );
}

function renderInProvider(ui: ReactNode) {
  return render(
    <MemoryRouter initialEntries={['/glossary']}>
      <GlossaryProvider>
        {ui}
        <HistoryBack />
      </GlossaryProvider>
    </MemoryRouter>,
  );
}

describe('GlossaryProse + GlossaryProvider', () => {
  it('renders matched terms as buttons with suit glyphs still colored around them', () => {
    const { container } = renderInProvider(<GlossaryProse text="Cash the ♥A, then finesse the ♠Q." />);
    const link = screen.getByRole('button', { name: 'finesse' });
    expect(link).toHaveClass('gloss-link');
    expect(container.querySelector('.suit-h')).toHaveTextContent('♥');
    expect(container.querySelector('.suit-s')).toHaveTextContent('♠');
  });

  it('tapping a term link opens the term sheet; close returns cleanly', async () => {
    renderInProvider(<GlossaryProse text="Try the finesse." />);
    await userEvent.click(screen.getByRole('button', { name: 'finesse' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Finesse');
    expect(dialog).toHaveTextContent(/leading toward it/);
    expect(dialog).toHaveTextContent(/Adapted from Wikipedia/);
    await userEvent.click(within(dialog).getByRole('button', { name: /close/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('back unwinds a recursive related-term chain one sheet at a time', async () => {
    renderInProvider(<GlossaryProse text="Try the finesse." />);
    await userEvent.click(screen.getByRole('button', { name: 'finesse' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Tenace' }));
    expect(screen.getByRole('dialog')).toHaveTextContent(/Two honors with a gap/);

    await userEvent.click(screen.getByRole('button', { name: 'history-back' }));
    expect(screen.getByRole('dialog')).toHaveTextContent(/leading toward it/);
    await userEvent.click(screen.getByRole('button', { name: 'history-back' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('✕ closes the whole chain at once, not one level', async () => {
    renderInProvider(<GlossaryProse text="Try the finesse." />);
    await userEvent.click(screen.getByRole('button', { name: 'finesse' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Tenace' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /close/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // the chain is fully popped: going back now leaves the sheetless page
    // state intact rather than resurrecting a sheet
    await userEvent.click(screen.getByRole('button', { name: 'history-back' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders linklessly (no crash) outside the provider', () => {
    render(<GlossaryProse text="Try the finesse." />);
    expect(screen.getByRole('button', { name: 'finesse' })).toBeInTheDocument();
  });
});

describe('TermSheet', () => {
  it('shows badges, aliases, definition, example, related chips and attribution', () => {
    render(<TermSheet slug="finesse" onOpenTerm={vi.fn()} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('CARD PLAY');
    expect(dialog).toHaveTextContent('also searched as: hook, finessing');
    expect(dialog).toHaveTextContent(/roughly 50-50 shot/);
    expect(dialog).toHaveTextContent(/Lead low toward AQ/);
    expect(within(dialog).getByRole('button', { name: 'Tenace' })).toBeInTheDocument();
    expect(dialog).toHaveTextContent(/CC BY-SA 4.0/);
  });

  it('related chips swap the sheet in place via onOpenTerm', async () => {
    const onOpenTerm = vi.fn();
    render(<TermSheet slug="finesse" onOpenTerm={onOpenTerm} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Tenace' }));
    expect(onOpenTerm).toHaveBeenCalledWith('tenace');
  });

  it('does not link a term to itself in its own definition', () => {
    render(<TermSheet slug="ruff" onOpenTerm={vi.fn()} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    // "trump" is linkify:false and "ruff" is omitted; "follow suit" stays live
    expect(within(dialog).queryByRole('button', { name: /^ruff$/i })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'follow suit' })).toBeInTheDocument();
  });

  it('renders a graceful sheet for an unknown slug', () => {
    render(<TermSheet slug="no-such-term" onOpenTerm={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog')).toHaveTextContent(/Not in the ledger/);
  });
});
