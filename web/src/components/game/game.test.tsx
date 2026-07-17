import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import {
  allHands,
  bid2H,
  bidEvalsFixture,
  biddingAuction,
  boardBidding,
  boardPlaying,
  boardPlayingFlipped,
  meaning2H,
  southHand,
} from '../../test/fixtures';
import { AuctionGrid } from './AuctionGrid';
import { BidBox } from './BidBox';
import { BoardTicketRow } from './BoardTicketRow';
import { CallInspector } from './CallInspector';
import { DealDiagram } from './DealDiagram';
import { fanMarginLeft } from './fanLayout';
import { GradeToast } from './GradeToast';
import { HandFan } from './HandFan';
import { MeaningPanel } from './MeaningPanel';
import { PlayingCard } from './PlayingCard';
import { TrickArea } from './TrickArea';

describe('PlayingCard', () => {
  it('renders corner index rank + suit glyph with the suit class', () => {
    const { container } = render(<PlayingCard card={12} />); // ♠A
    const el = container.firstChild as HTMLElement;
    expect(el).toHaveClass('pcard', 'suit-s');
    expect(el.textContent).toContain('A');
    expect(el.textContent).toContain('♠');
  });

  it('supports dimmed, selected and placeholder treatments', () => {
    const dimmed = render(<PlayingCard card={20} dimmed />); // ♥9
    expect(dimmed.container.firstChild).toHaveClass('dimmed');
    const selected = render(<PlayingCard card={20} selected />);
    expect(selected.container.firstChild).toHaveClass('selected');
    const ph = render(<PlayingCard placeholder />);
    expect(ph.container.firstChild).toHaveClass('pcard-placeholder');
  });

  it('gives "10" its tightened treatment', () => {
    const { container } = render(<PlayingCard card={8} />); // ♠10
    expect(container.querySelector('.ten')).toBeInTheDocument();
  });
});

describe('HandFan', () => {
  it('renders a button per card with ARIA labels, only legal cards enabled', () => {
    const legal = [12, 10, 8];
    const onSelect = vi.fn();
    render(<HandFan cards={southHand} legal={legal} onSelect={onSelect} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(13);
    expect(screen.getByRole('button', { name: 'A of ♠' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'K of ♥' })).toBeDisabled();
  });

  it('marks the fan interactive and fires onSelect for enabled cards only', async () => {
    const onSelect = vi.fn();
    const { container } = render(<HandFan cards={southHand} legal={[12]} onSelect={onSelect} />);
    expect(container.firstChild).toHaveClass('interactive');
    await userEvent.click(screen.getByRole('button', { name: 'A of ♠' }));
    expect(onSelect).toHaveBeenCalledWith(12);
    await userEvent.click(screen.getByRole('button', { name: 'Q of ♣' })).catch(() => {});
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('raises the selected card and adds suit gaps at suit boundaries', () => {
    const { container } = render(<HandFan cards={southHand} legal={southHand} selected={12} onSelect={() => {}} />);
    expect(container.querySelector('.cardbtn.selected')).toBeInTheDocument();
    expect(container.querySelectorAll('.cardbtn.suitgap').length).toBe(3); // ♠→♥, ♥→♦, ♦→♣
  });

  it('dims illegal cards in an active fan, but dims nothing when legal is omitted (bidding\'s read-only display)', () => {
    const { container: active } = render(<HandFan cards={southHand} legal={[12]} onSelect={() => {}} />);
    expect(active.querySelectorAll('.pcard.dimmed').length).toBe(12);

    const { container: readOnly } = render(<HandFan cards={southHand} />);
    expect(readOnly.querySelectorAll('.pcard.dimmed').length).toBe(0);
  });

  it('spaces cards optically: an inline token-scaled margin on every card but the first', () => {
    const { container } = render(<HandFan cards={southHand} />);
    const buttons = [...container.querySelectorAll<HTMLElement>('.cardbtn')];
    expect(buttons[0].getAttribute('style')).toBeNull();
    for (const btn of buttons.slice(1)) {
      expect(btn.getAttribute('style')).toContain('var(--card-h)');
    }
    // the fan's margins come straight from fanLayout for the preceding card
    expect(buttons[3].getAttribute('style')).toContain(fanMarginLeft(southHand[2]));
  });
});

describe('fanLayout', () => {
  // southHand[2] = ♠10 (widest value), southHand[7] = ♥3 (narrow)
  const coeff = (margin: string) => Number(margin.match(/\* (-?[\d.]+) \+/)![1]);

  it('emits a token-scaled negative overlap plus the fixed value gap', () => {
    const m = fanMarginLeft(southHand[7]);
    expect(m).toMatch(/^calc\(var\(--card-h\) \* -0\.\d+ \+ 6px\)$/);
  });

  it('yields a wide "10" more room than a narrow rank (less negative overlap)', () => {
    expect(coeff(fanMarginLeft(southHand[2]))).toBeGreaterThan(coeff(fanMarginLeft(southHand[7])));
  });

  it('scales card body and value by 0.8 in the small variant', () => {
    // full: (−46 + 5 + v)/66 vs small: (−36.8 + 5 + 0.8v)/66 — small overlaps less
    expect(coeff(fanMarginLeft(southHand[7], true))).toBeGreaterThan(coeff(fanMarginLeft(southHand[7])));
    expect(fanMarginLeft(southHand[7], true)).not.toBe(fanMarginLeft(southHand[7]));
  });
});

describe('AuctionGrid', () => {
  it('offsets the first row by the dealer seat', () => {
    // dealer = W (3) → three leading empty cells before the first call
    const { container } = render(
      <AuctionGrid auction={biddingAuction.slice(0, 2)} dealer={3} myTurn={false} onInspect={() => {}} />,
    );
    const firstRowCells = container.querySelectorAll('tbody tr:first-child td');
    expect(firstRowCells).toHaveLength(4);
    expect(firstRowCells[0].textContent).toBe('');
    expect(firstRowCells[1].textContent).toBe('');
    expect(firstRowCells[2].textContent).toBe('');
    expect(firstRowCells[3].querySelector('button')).toBeInTheDocument();
  });

  it('marks calls with meanings, fires onInspect, and shows the pending "?" on my turn', async () => {
    const onInspect = vi.fn();
    const { container } = render(<AuctionGrid auction={biddingAuction} dealer={0} myTurn onInspect={onInspect} />);
    expect(container.querySelectorAll('.has-meaning').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: /1♥/ }));
    expect(onInspect).toHaveBeenCalledWith(biddingAuction[2]);
    expect(screen.getByText('?')).toBeInTheDocument();
    expect(screen.getByText(/tap any call to inspect/i)).toBeInTheDocument();
  });
});

describe('MeaningPanel', () => {
  it('renders a full meaning with chips', () => {
    render(<MeaningPanel meaning={meaning2H} call={bid2H} prefix="Your" />);
    expect(screen.getByText(/Rebid, invitational/)).toBeInTheDocument();
    expect(screen.getByText('10–12 HCP')).toBeInTheDocument();
    expect(screen.getByText('6+ hearts')).toBeInTheDocument();
    expect(screen.getByText(/long heart suit/)).toBeInTheDocument();
  });

  it('shows the beyond-SAYC caveat for inexact meanings', () => {
    render(<MeaningPanel meaning={{ ...meaning2H, exact: false }} call={bid2H} prefix="Your" />);
    expect(screen.getByText(/general guidance only/i)).toBeInTheDocument();
  });

  it('renders the placeholder and the no-meaning fallback', () => {
    const ph = render(<MeaningPanel placeholder />);
    expect(ph.getByText(/tap a bid/i)).toBeInTheDocument();
    const none = render(<MeaningPanel call={8} prefix="Your" />);
    expect(none.getByText(/no standard SAYC meaning/i)).toBeInTheDocument();
  });
});

describe('CallInspector', () => {
  it('opens a dialog for a past call and closes', async () => {
    const onClose = vi.fn();
    render(<CallInspector entry={biddingAuction[2]} onClose={onClose} />);
    // the accessible-name algorithm inserts a space between the level and the colored strain glyph
    expect(screen.getByRole('dialog', { name: /S bid 1\s*♥/ })).toBeInTheDocument();
    expect(screen.getByText(/13–21 HCP/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('BidBox', () => {
  const legal = boardBidding.legalCalls!;

  it('renders levels 1–4 plus Pass/X/XX, with levels 5–7 behind the fold', () => {
    render(<BidBox legalCalls={legal} selected={null} onSelect={() => {}} onConfirm={() => {}} busy={false} />);
    // 20 leveled bids visible + 3 calls = 23 buttons + fold toggle + confirm
    expect(screen.getByRole('button', { name: '1♣' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '2♥' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: '5♣' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pass' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'X' })).toBeDisabled();
  });

  it('expands the fold to reveal all 38 targets', async () => {
    const { container } = render(
      <BidBox legalCalls={legal} selected={null} onSelect={() => {}} onConfirm={() => {}} busy={false} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /levels 5–7/i }));
    expect(screen.getByRole('button', { name: '7NT' })).toBeInTheDocument();
    expect(container.querySelectorAll('button.bid')).toHaveLength(38);
  });

  it('auto-expands when every legal bid lives above level 4', () => {
    // pathological auction already at 5♦: legal bids are 5♥+ only
    const highOnly = [0, ...Array.from({ length: 11 }, (_, i) => i + 27)];
    render(<BidBox legalCalls={highOnly} selected={null} onSelect={() => {}} onConfirm={() => {}} busy={false} />);
    expect(screen.getByRole('button', { name: '7NT' })).toBeInTheDocument();
  });

  it('two-step commit: select shows the confirm CTA; confirm disabled without a selection', async () => {
    const onSelect = vi.fn();
    const onConfirm = vi.fn();
    const { rerender } = render(
      <BidBox legalCalls={legal} selected={null} onSelect={onSelect} onConfirm={onConfirm} busy={false} />,
    );
    const confirm = screen.getByRole('button', { name: /select a bid/i });
    expect(confirm).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '2♥' }));
    expect(onSelect).toHaveBeenCalledWith(bid2H);
    rerender(<BidBox legalCalls={legal} selected={bid2H} onSelect={onSelect} onConfirm={onConfirm} busy={false} />);
    await userEvent.click(screen.getByRole('button', { name: /bid 2♥/i }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('locks every button while a call is in flight', () => {
    render(<BidBox legalCalls={legal} selected={bid2H} onSelect={() => {}} onConfirm={() => {}} busy />);
    // a stray click mid-submit must not toggle the selection off
    expect(screen.getByRole('button', { name: '2♥' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Pass' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /bid 2♥/i })).toBeDisabled();
  });
});

describe('GradeToast', () => {
  it('names the robot bid and its convention when the calls differ', () => {
    render(<GradeToast evaluation={bidEvalsFixture[1]} />); // good, saycConsistent, best 3♥
    expect(screen.getByRole('status')).toHaveTextContent(/Good/);
    expect(screen.getByLabelText('2 of 3 stars')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/a textbook SAYC bid; the robot chose 3♥ \(Limit raise\)/);
    expect(screen.getByRole('status')).not.toHaveTextContent(/%/);
  });

  it('shows the ✗ treatment for poor and the agreement sentence when the robot agrees', () => {
    render(<GradeToast evaluation={bidEvalsFixture[3]} />); // poor, no meaning attached
    expect(screen.getByLabelText('0 of 3 stars')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/the robot bid 4NT/);
    const agree = render(<GradeToast evaluation={bidEvalsFixture[0]} />); // excellent, same call
    expect(agree.getAllByRole('status').at(-1)).toHaveTextContent(/the robot.s choice too/);
  });
});

describe('TrickArea', () => {
  it('places played cards at compass seats with declarer/dummy tags and the trick meter', () => {
    const { container } = render(<TrickArea board={boardPlaying} />);
    expect(container.firstChild).toHaveClass('trick');
    // W led ♠3, N (dummy) played ♠4, E played ♠2; S (me, declarer) is the placeholder
    expect(container.querySelector('.seatpos.s .pcard-placeholder')).toBeInTheDocument();
    expect(within(container.querySelector('.seatpos.n')! as HTMLElement).getByText(/dummy/i)).toBeInTheDocument();
    // boardPlaying: declarerTricks 3, defenderTricks 1
    expect(document.querySelector('.trick-meter-num')!.textContent).toBe('3–1');
  });

  it('rotates the compass when the board is flipped (human plays North at the bottom)', () => {
    const { container } = render(<TrickArea board={boardPlayingFlipped} />);
    // flipped: seat 0 (N) renders in the bottom (s) position with the declarer tag
    expect(within(container.querySelector('.seatpos.s')! as HTMLElement).getByText(/N.*decl/i)).toBeInTheDocument();
  });
});

describe('DealDiagram', () => {
  it('renders all four hands as suit rows and highlights the hand the human played', () => {
    const { container } = render(<DealDiagram hands={allHands} vul={{ ns: true, ew: false }} dealer={0} playedSeat={2} />);
    expect(container.querySelectorAll('.deal-hand')).toHaveLength(4);
    const south = container.querySelector('.deal-hand.deal-mine') as HTMLElement;
    expect(south.textContent).toContain('SOUTH');
    expect(south.textContent).toContain('YOU');
    // south spades row: A Q 10
    expect(south.textContent).toContain('A Q 10');
    expect(screen.getByText(/Dealer N · NS vul/)).toBeInTheDocument();
  });

  it('labels North as the played hand on flipped boards', () => {
    const { container } = render(<DealDiagram hands={allHands} vul={{ ns: false, ew: false }} dealer={1} playedSeat={0} />);
    const mine = container.querySelector('.deal-hand.deal-mine') as HTMLElement;
    expect(mine.textContent).toContain('NORTH');
  });
});

describe('BoardTicketRow', () => {
  it('renders scored, live and sealed states', () => {
    const { container } = render(
      <MemoryRouter>
        <BoardTicketRow no={1} state="scored" main="4♠ by S · +620" sub="58% matchpoints" to="/t/12/b/1" />
        <BoardTicketRow no={2} state="live" main="Bidding — your call" sub="Dealer N · NS vul" to="/t/12/b/2" />
        <BoardTicketRow no={3} state="sealed" main="Sealed — deals when board 2 is scored" />
      </MemoryRouter>,
    );
    expect(container.querySelectorAll('.board-row')).toHaveLength(3);
    expect(container.querySelector('.board-row-sealed')).toBeInTheDocument();
    expect(screen.getByText('SCORED')).toBeInTheDocument();
    expect(screen.getByText('LIVE')).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(2); // sealed rows don't link
  });
});
