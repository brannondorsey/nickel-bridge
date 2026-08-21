import { useEffect, useRef } from 'react';
import { mountFoil } from './foil';

/**
 * The foil canvas, mounted as the last child of a card container (a fan, the
 * trick box) and painting over every `[data-foil]` card face inside it.
 *
 * It is a sibling of the cards rather than a child of each one because the
 * pattern is one continuous field across the whole hand — see foil.ts. The
 * host needs `position: relative`; `.handfan` and `.trick` both have it.
 *
 * The layer OVERHANGS its host by `--foil-bleed`, and that is not decoration:
 * a trick card is taller than its grid row and spills past the box, and a
 * layer pinned to `inset: 0` leaves its foot bare. `width`/`height` are set
 * explicitly in CSS rather than by opposing offsets because a `<canvas>` is a
 * replaced element — `inset: -16px` with `width: auto` leaves it at its
 * intrinsic 300×150 and silently paints almost nothing.
 */
export function FoilLayer() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    return mountFoil(canvas, host);
  }, []);

  return <canvas ref={ref} className="foil-layer" aria-hidden="true" />;
}
