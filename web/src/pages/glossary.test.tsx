import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { GlossaryProvider } from '../glossary/GlossaryContext';
import { meFixture } from '../test/fixtures';
import { renderWithMe } from '../test/utils';
import Glossary from './Glossary';

// Deterministic deep reference: the real chunk is generated content.
vi.mock('../glossary/deep', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../glossary/deep')>()),
  loadDeep: () =>
    Promise.resolve([
      { term: 'Mini-splinter', def: 'A single-jump version of the splinter.', anchor: 'B' },
      { term: 'Splinter bid', def: 'A double-jump response showing a fit and shortness.', anchor: 'splinter' },
    ]),
}));

function renderGlossary(route = '/glossary') {
  return renderWithMe(
    <GlossaryProvider>
      <Routes>
        <Route path="/glossary" element={<Glossary />} />
        <Route path="/glossary/:slug" element={<Glossary />} />
      </Routes>
    </GlossaryProvider>,
    { me: meFixture, route },
  );
}

describe('Glossary page', () => {
  it('renders the A–Z core ledger with letter heads and theme badges', () => {
    renderGlossary();
    expect(screen.getByText('The Glossary')).toBeInTheDocument();
    expect(screen.getByText('124 CORE TERMS')).toBeInTheDocument();
    // the digit bucket leads, then letters
    const letters = screen.getAllByText(/^[#A-Z]$/, { selector: '.gloss-letter' }).map((el) => el.textContent);
    expect(letters[0]).toBe('#');
    expect(letters).toContain('F');
    const finesse = screen.getByRole('button', { name: /Finesse.*CARD PLAY/s });
    expect(finesse).toHaveTextContent(/leading toward it/);
  });

  it('theme chips filter the core list', async () => {
    renderGlossary();
    await userEvent.click(screen.getByRole('button', { name: 'CONVENTIONS' }));
    expect(screen.getByRole('button', { name: /Stayman/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Finesse/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'ALL' }));
    expect(screen.getByRole('button', { name: /Finesse/ })).toBeInTheDocument();
  });

  it('search matches names, definitions, and aliases live', async () => {
    renderGlossary();
    await userEvent.type(screen.getByRole('searchbox'), 'hook');
    expect(screen.getByRole('button', { name: /Finesse/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Stayman/ })).not.toBeInTheDocument();
  });

  it('falls through to the deep reference when the core ledger has nothing', async () => {
    renderGlossary();
    await userEvent.type(screen.getByRole('searchbox'), 'splinter');
    expect(await screen.findByText(/Nothing in the core ledger — but the deep reference holds 2\./)).toBeInTheDocument();
    expect(screen.getAllByText('DEEP CUT')).toHaveLength(2);
    const link = screen.getAllByRole('link', { name: /Read on Wikipedia/ })[1];
    expect(link).toHaveAttribute('href', 'https://en.wikipedia.org/wiki/Glossary_of_contract_bridge_terms#splinter');
  });

  it('the deep-reference toggle expands the full ledger inline', async () => {
    renderGlossary();
    await userEvent.click(screen.getByRole('button', { name: /SHOW DEEP REFERENCE/ }));
    expect(await screen.findByText(/Splinter bid/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /HIDE DEEP REFERENCE/ })).toBeInTheDocument();
  });

  it('the letter scrubber disables letters absent from the current filter', async () => {
    renderGlossary();
    const scrub = document.querySelector('.gloss-scrub') as HTMLElement;
    expect(within(scrub).getByRole('button', { name: 'F' })).toBeEnabled();
    // no core term starts with X
    expect(within(scrub).getByRole('button', { name: 'X' })).toBeDisabled();
    await userEvent.type(screen.getByRole('searchbox'), 'stayman');
    expect(within(scrub).getByRole('button', { name: 'F' })).toBeDisabled();
    expect(within(scrub).getByRole('button', { name: 'S' })).toBeEnabled();
  });

  it('tapping a row opens the term sheet; /glossary/:slug opens it on arrival', async () => {
    renderGlossary();
    await userEvent.click(screen.getByRole('button', { name: /Finesse/ }));
    expect(await screen.findByRole('dialog')).toHaveTextContent(/also searched as: hook/);

    renderGlossary('/glossary/stayman');
    const dialogs = await screen.findAllByRole('dialog');
    expect(dialogs.at(-1)).toHaveTextContent(/2♣ response to 1NT/);
  });

  it('carries the CC BY-SA attribution in the footer', () => {
    renderGlossary();
    expect(screen.getByText(/Adapted from Wikipedia’s/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /CC BY-SA 4.0/ })).toHaveAttribute(
      'href',
      'https://creativecommons.org/licenses/by-sa/4.0/',
    );
  });
});
