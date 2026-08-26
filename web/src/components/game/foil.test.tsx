import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SUIT_SYMBOLS, cardSuit, foilForDisplay, trumpForDisplay, trumpSuit } from '../../api';
import { boardPlaying, southHand } from '../../test/fixtures';
import { foilAnchor, stepTilt } from './foil';
import { HandFan } from './HandFan';
import { TrickArea } from './TrickArea';

const SPADES = 0;
const HEARTS = 1;

/**
 * The shine itself is WebGL and jsdom has none, so `mountFoil` no-ops here and
 * these tests cover what a broken build would actually break: which cards get
 * marked, whether the layer is mounted at all, and the tilt rule that decides
 * how fast the shine may travel. The look itself was judged on a design
 * concept board (PR #192, not part of the shipped app) rather than here.
 */

describe('which suit is foiled', () => {
  it('reads the trump suit off the contract, in suit rather than bid order', () => {
    // strain counts ♣♦♥♠NT and suits count ♠♥♦♣ — the conversion is 3 - strain
    expect(trumpSuit({ strain: 3 })).toBe(SPADES);
    expect(trumpSuit({ strain: 2 })).toBe(HEARTS);
    expect(trumpSuit({ strain: 0 })).toBe(3); // clubs
    expect(trumpSuit({ strain: 4 })).toBeNull(); // no-trump has no trumps
    expect(trumpSuit(undefined)).toBeNull(); // auction not settled
  });

  it('is off unless the preference is on, and is independent of trump placement', () => {
    const spades = { strain: 3 };
    expect(foilForDisplay(spades, false)).toBeNull();
    expect(foilForDisplay(spades, undefined)).toBeNull();
    expect(foilForDisplay(spades, true)).toBe(SPADES);
    // the two preferences do not imply each other in either direction
    expect(trumpForDisplay(spades, 'suit')).toBeNull();
    expect(foilForDisplay(spades, true)).toBe(SPADES);
    expect(trumpForDisplay(spades, 'left')).toBe(SPADES);
    expect(foilForDisplay(spades, false)).toBeNull();
  });
});

describe('HandFan foiling', () => {
  it('marks every trump face and no other, and mounts one layer', () => {
    const { container } = render(<HandFan cards={southHand} foil={SPADES} />);
    const faces = [...container.querySelectorAll<HTMLElement>('.pcard')];
    const marked = faces.filter((el) => el.hasAttribute('data-foil'));
    expect(marked.length).toBe(southHand.filter((c) => cardSuit(c) === SPADES).length);
    expect(marked.length).toBeGreaterThan(0);
    // every marked card is a spade, by its own printed glyph
    for (const el of marked) expect(el.querySelector('.suit')?.textContent).toBe(SUIT_SYMBOLS[SPADES]);
    expect(container.querySelectorAll('canvas.foil-layer').length).toBe(1);
  });

  it('paints over the cards rather than under them', () => {
    const { container } = render(<HandFan cards={southHand} foil={SPADES} />);
    const fan = container.querySelector('.handfan')!;
    // last child: the layer is a plain sibling of the cards, so document
    // order is the whole of its stacking against them
    expect(fan.lastElementChild?.tagName).toBe('CANVAS');
  });

  it('marks an unplayable trump BOTH foiled and dimmed', () => {
    /* The two attributes foil.ts joins on: it looks up `.pcard[data-foil]`
       and then asks whether that same element `.dimmed`, because on night
       stock a full-strength plate under a 40%-opacity glyph leaves the rank
       unreadable. Rename either class and the foil silently stops easing off
       — the card just goes back to being hard to read. */
    const spades = southHand.filter((c) => cardSuit(c) === SPADES);
    const legal = southHand.filter((c) => cardSuit(c) !== SPADES);
    const { container } = render(<HandFan cards={southHand} foil={SPADES} legal={legal} />);
    const foiled = [...container.querySelectorAll<HTMLElement>('.pcard[data-foil]')];
    expect(foiled.length).toBe(spades.length);
    expect(foiled.every((el) => el.classList.contains('dimmed'))).toBe(true);
    // and a legal card is foiled without being dimmed, or every trump would ease off
    const clubs = southHand.filter((c) => cardSuit(c) === 3);
    const { container: c2 } = render(<HandFan cards={southHand} foil={3} legal={clubs} />);
    const lit = [...c2.querySelectorAll<HTMLElement>('.pcard[data-foil]')];
    expect(lit.length).toBeGreaterThan(0);
    expect(lit.some((el) => el.classList.contains('dimmed'))).toBe(false);
  });

  it('mounts nothing at all when the preference is off', () => {
    const { container } = render(<HandFan cards={southHand} foil={null} />);
    expect(container.querySelector('canvas.foil-layer')).toBeNull();
    expect(container.querySelectorAll('[data-foil]').length).toBe(0);
  });

  it('leaves the fan itself alone — the layer is not a card', () => {
    const plain = render(<HandFan cards={southHand} />).container.querySelectorAll('.cardbtn').length;
    const foiled = render(<HandFan cards={southHand} foil={SPADES} />).container.querySelectorAll('.cardbtn').length;
    expect(foiled).toBe(plain);
    expect(foiled).toBe(southHand.length);
  });
});

describe('TrickArea foiling', () => {
  // boardPlaying is 4♠ by South with three spades already on the table
  it('marks the trumps in the trick and mounts one layer', () => {
    const { container } = render(<TrickArea board={boardPlaying} foil={SPADES} />);
    const marked = container.querySelectorAll('.pcard[data-foil]');
    expect(marked.length).toBe(boardPlaying.currentTrick!.filter((t) => cardSuit(t.card) === SPADES).length);
    expect(container.querySelectorAll('canvas.foil-layer').length).toBe(1);
  });

  it('marks nothing when the trumps are a suit no one has played', () => {
    const { container } = render(<TrickArea board={boardPlaying} foil={HEARTS} />);
    expect(container.querySelectorAll('.pcard[data-foil]').length).toBe(0);
    // the layer still mounts: a heart could be led into this very trick
    expect(container.querySelectorAll('canvas.foil-layer').length).toBe(1);
  });

  it('mounts nothing at all when the preference is off', () => {
    const { container } = render(<TrickArea board={boardPlaying} />);
    expect(container.querySelector('canvas.foil-layer')).toBeNull();
  });
});

describe('the flight layer', () => {
  it('is not mounted until a foiled board is', () => {
    // It lives on document.body, outside every card container, because that
    // is where TrickArea's position:fixed clones live — so an unfoiled board
    // must not leave a viewport-wide blending canvas behind.
    expect(document.querySelector('.foil-layer-flight')).toBeNull();
    render(<TrickArea board={boardPlaying} />);
    expect(document.querySelector('.foil-layer-flight')).toBeNull();
  });
});

describe('where a flying card takes its patch from', () => {
  /**
   * A trick slot is centred with `transform: translate(-50%)`, so a trick card
   * is DRAWN up to half a slot from where its own foil is sampled. The clone
   * TrickArea flies has to be anchored at the sampled point, not the drawn
   * one, or the last frame of the glide and the card that replaces it sit on
   * different patches of sheet — which reads as the holo snapping on landing.
   */
  function stub(el: HTMLElement, rect: { left: number; top: number }, lay: { x: number; y: number }, parent: HTMLElement) {
    el.getBoundingClientRect = () => new DOMRect(rect.left, rect.top, 43, 61);
    Object.defineProperty(el, 'offsetLeft', { value: lay.x, configurable: true });
    Object.defineProperty(el, 'offsetTop', { value: lay.y, configurable: true });
    Object.defineProperty(el, 'offsetParent', { value: parent, configurable: true });
  }

  it('reports the layout position, not the rect a transform moved the card to', () => {
    const host = document.createElement('div');
    const seat = document.createElement('div');
    const card = document.createElement('div');
    host.append(seat);
    seat.append(card);
    host.getBoundingClientRect = () => new DOMRect(100, 200, 326, 265);
    // the seat sits at (30, 40) in the host and is pulled 21px left by its
    // own centring transform; the card fills the seat
    stub(seat, { left: 100 + 30 - 21, top: 200 + 40 }, { x: 30, y: 40 }, host);
    stub(card, { left: 100 + 30 - 21, top: 200 + 40 }, { x: 0, y: 0 }, seat);

    expect(foilAnchor(card, host)).toEqual({ x: 130, y: 240 });
    // ...which is deliberately NOT where it is drawn
    expect(card.getBoundingClientRect().left).toBe(109);
  });
});

describe('how fast the shine may travel', () => {
  const FRAME = 16;

  it('lets a small movement through on the filter alone', () => {
    // well inside the per-frame cap (0.6/s ≈ 0.0096 per 16ms frame), so this
    // is the exponential filter's own step and nothing else
    const step = stepTilt(0, 0.05, FRAME);
    expect(step).toBeGreaterThan(0);
    expect(step).toBeLessThan(0.05);
  });

  it('caps a flick, whatever the filter would have done with it', () => {
    // the bug this exists for: a time constant bounds LAG, not SPEED, so the
    // first frame of a full-sweep target still moved ~4% of it — a shine
    // crossing the hand in a fifth of a second
    const capped = stepTilt(0, 1.6, FRAME);
    expect(capped).toBeCloseTo((0.6 * FRAME) / 1000, 6);
    expect(capped).toBeLessThan(1.6 * (1 - Math.exp(-FRAME / 420)));
  });

  it('caps in both directions, and never overshoots the target', () => {
    expect(stepTilt(0, -1.6, FRAME)).toBeCloseTo((-0.6 * FRAME) / 1000, 6);
    // approaching from either side converges rather than oscillating
    let v = 0;
    for (let i = 0; i < 600; i++) v = stepTilt(v, 0.4, FRAME);
    expect(v).toBeCloseTo(0.4, 3);
    for (let i = 0; i < 600; i++) v = stepTilt(v, -0.4, FRAME);
    expect(v).toBeCloseTo(-0.4, 3);
  });

  it('is frame-rate independent — the same wall time travels the same distance', () => {
    let at60 = 0;
    for (let i = 0; i < 120; i++) at60 = stepTilt(at60, 0.3, 1000 / 60);
    let at120 = 0;
    for (let i = 0; i < 240; i++) at120 = stepTilt(at120, 0.3, 1000 / 120);
    expect(at120).toBeCloseTo(at60, 3);
  });
});
