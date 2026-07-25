import { useEffect } from 'react';
import { CLAIM_ANNOUNCE_HOLD_MS, type ClaimAnnouncement } from './playAnim';

/**
 * The claim announcement — a modal ticket over a dimmed board, shown for
 * CLAIM_ANNOUNCE_HOLD_MS (or until dismissed) before Board.tsx starts the
 * sped-up fast-forward. Replaces the old in-flow banner, which popped up
 * alongside cards already in motion and was easy to miss; gating the
 * fast-forward behind an unmissable, dismissible announcement is the whole
 * point, so this owns tap/click/Escape-to-continue rather than leaving the
 * board interactive underneath it.
 */
export function ClaimOverlay({ info, onDismiss }: { info: ClaimAnnouncement; onDismiss: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  const side = info.side === 'NS' ? 'N/S' : 'E/W';
  const trickWord = info.tricks === 1 ? 'TRICK' : 'TRICKS';

  return (
    <div
      className="claim-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`${side} claim, ${info.tricks} remaining ${trickWord.toLowerCase()}`}
      onClick={onDismiss}
    >
      <div className="claim-ticket">
        <div className="claim-eyebrow">· CLAIM ·</div>
        <div className="claim-headline">{side} CLAIM</div>
        <div className="claim-subhead">
          {info.tricks} REMAINING {trickWord}
        </div>
        <div className="claim-aside">Laydown confirmed — the rest plays itself…</div>
        <div className="claim-countdown">
          <span style={{ animationDuration: `${CLAIM_ANNOUNCE_HOLD_MS}ms` }} />
        </div>
        <div className="claim-hint">Tap to continue</div>
      </div>
    </div>
  );
}
