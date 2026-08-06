import type { CSSProperties } from 'react';
import { BoardView } from '../../api';
import { Button } from '../ds/Button';
import { PerforatedPanel } from '../ds/PerforatedPanel';
import { signedScore, vulLabel } from '../../format';
import { ContractLabel } from './ContractLabel';
import { GlossaryProse } from './GlossaryProse';
import { ReceiptRow, caption } from './ScoreReceipt';

/**
 * The end of a "Play From Here" rehearsal — deliberately not a toll receipt,
 * since nothing here was ever going to be tolled. Itemizes this line's own
 * score the same way ScoreReceipt does (reusing its ReceiptRow/caption, so a
 * player who has already learned to read a toll receipt reads this one for
 * free), then compares it against `board.originResult` — the real table's
 * real result, sent inline on a finished rehearsal's own boardView (see the
 * doc comment on boardView in server/src/game.ts) so no second fetch is
 * needed. No postmark, no TOLL PAID/REFUSED stamp: this never counted.
 *
 * Two exits, not one: TRY ANOTHER LINE re-launches a fresh rehearsal at the
 * exact same branch point (the literal "try again from this decision"
 * action — Board.tsx wires it straight to api.rehearse, no detour through
 * Analyze), and BACK TO ANALYZE returns to the origin board's overview,
 * where this attempt already shows up in both history surfaces.
 */
export function AdjustedReceipt({
  board,
  onTryAnotherLine,
  onBackToAnalyze,
}: {
  board: BoardView;
  onTryAnotherLine: () => void;
  onBackToAnalyze: () => void;
}) {
  const r = board.result!;
  const bd = r.breakdown;
  const orig = board.originResult;
  const declarerNS = board.declarer !== undefined && board.declarer % 2 === 0;
  const made = (bd?.total ?? 0) > 0;
  const delta = orig ? r.scoreNS - orig.scoreNS : null;

  return (
    <div className="receipt adjusted-receipt">
      <div className="result-hero">
        <div className="result-contract">
          <ContractLabel label={r.contractLabel} />
        </div>
        <div className="result-score num">
          {bd
            ? `${r.tricksDeclarer} of 13 tricks to declarer · ${vulLabel(board.vul)}`
            : `No toll — all four hands passed · ${vulLabel(board.vul)}`}
        </div>
      </div>

      <PerforatedPanel heading="THIS LINE" className="receipt-panel">
        {bd ? (
          <>
            {bd.lines.map((line, i) => (
              <ReceiptRow key={i} index={i} label={line.label} detail={line.detail} caption={caption(line)} amount={line.amount} />
            ))}
            <div className="receipt-rule" style={{ '--i': bd.lines.length } as CSSProperties} />
            <ReceiptRow
              index={bd.lines.length}
              label={made ? 'This line collects' : 'This line goes down'}
              detail={declarerNS ? 'for N–S' : 'for E–W'}
              amount={bd.total}
              total
            />
          </>
        ) : (
          <ReceiptRow index={0} label="Passed out" detail="for N–S" caption="no contract, no toll — every hand passed" amount={0} total />
        )}
      </PerforatedPanel>

      <PerforatedPanel heading="VS YOUR REAL TABLE" className="rehearsal-compare">
        <div className="worth-stubs rehearsal-compare-stubs">
          <div className="worth-stub">
            <span className="worth-stub-label">THIS LINE</span>
            <b className="worth-contract num">
              <ContractLabel label={r.contractLabel} />
            </b>
            <b className="worth-score num">{signedScore(r.scoreNS)}</b>
          </div>
          <div className="worth-stub">
            <span className="worth-stub-label">YOUR REAL TABLE</span>
            {orig ? (
              <>
                <b className="worth-contract num">
                  <ContractLabel label={orig.contractLabel} />
                </b>
                <b className="worth-score num">{signedScore(orig.scoreNS)}</b>
              </>
            ) : (
              <span className="worth-aside">not available</span>
            )}
          </div>
        </div>
        {delta !== null ? (
          <p className="analyze-finding">
            <GlossaryProse
              text={
                delta > 0
                  ? `This line does ${signedScore(delta)} better than your real table.`
                  : delta < 0
                    ? `This line does ${Math.abs(delta)} worse than your real table.`
                    : 'This line comes out exactly the same as your real table.'
              }
            />
          </p>
        ) : null}
      </PerforatedPanel>

      <div className="board-actions">
        <Button onClick={onTryAnotherLine}>TRY ANOTHER LINE →</Button>
        <Button variant="secondary" onClick={onBackToAnalyze}>
          Back to Analyze
        </Button>
      </div>
    </div>
  );
}
