import type { CSSProperties } from 'react';
import { BoardView, ScoreLine } from '../../api';
import { Button } from '../ds/Button';
import { PerforatedPanel } from '../ds/PerforatedPanel';
import { Postmark } from '../ds/Postmark';
import { postmarkDate, signedScore, tournamentNo, vulLabel } from '../../format';

/**
 * The toll receipt — an interstitial shown when a board is scored, before the
 * field comparison. Itemizes where the duplicate score came from using the
 * server's ScoreBreakdown (declaring side's ledger): odd tricks, game/slam
 * bonuses, the insult, overtricks or undertrick penalties. Rows print in one
 * per beat (pure CSS, stilled under prefers-reduced-motion), then the
 * postmark cancels the total — TOLL PAID when the human's side collected,
 * TOLL REFUSED when it went down; no postmark when the robots declared.
 */
export function ScoreReceipt({ board, onContinue }: { board: BoardView; onContinue: () => void }) {
  const r = board.result!;
  const bd = r.breakdown;
  const declarerNS = board.declarer !== undefined && board.declarer % 2 === 0;
  const side = declarerNS ? 'N–S' : 'E–W';
  const made = (bd?.total ?? 0) > 0;
  const rows = bd ? bd.lines.length + (declarerNS ? 1 : 2) : 1; // + total row (+ N–S row on defence)
  const stamp = bd && declarerNS ? (made ? 'TOLL PAID' : 'TOLL REFUSED') : null;

  return (
    <div className="receipt">
      <div className="result-hero">
        <div className="result-contract">{r.contractLabel}</div>
        <div className="result-score num">
          {bd
            ? `${r.tricksDeclarer} of 13 tricks to declarer · ${vulLabel(board.vul)}`
            : `No toll — all four hands passed · ${vulLabel(board.vul)}`}
        </div>
      </div>

      <PerforatedPanel heading={`THE TOLL — BOARD ${board.boardNo}`} className="receipt-panel">
        {bd ? (
          <>
            {bd.lines.map((line, i) => (
              <ReceiptRow key={i} index={i} label={line.label} detail={line.detail} caption={caption(line)} amount={line.amount} />
            ))}
            <div className="receipt-rule" style={{ '--i': bd.lines.length } as CSSProperties} />
            <ReceiptRow
              index={bd.lines.length}
              label={made ? 'Toll collected' : 'Toll refused'}
              detail={`for ${side}`}
              amount={bd.total}
              total
            />
            {!declarerNS ? (
              <ReceiptRow
                index={bd.lines.length + 1}
                label="Your side"
                detail="N–S, defending"
                caption="the robots declared — their toll is your score, sign reversed"
                amount={-bd.total}
                total
              />
            ) : null}
          </>
        ) : (
          <ReceiptRow index={0} label="Passed out" detail="for N–S" caption="no contract, no toll — every hand passed" amount={0} total />
        )}
      </PerforatedPanel>

      {stamp ? (
        <div className="receipt-postmark" style={{ '--i': rows } as CSSProperties}>
          <Postmark
            size={112}
            arcBottom={`TOURNAMENT Nº${tournamentNo(board.tournamentName, board.tournamentId)}`}
            line1={stamp === 'TOLL PAID' ? 'TOLL PAID' : 'REFUSED'}
            line2={postmarkDate(Date.now() / 1000)}
          />
        </div>
      ) : null}

      <div className="board-actions">
        <Button onClick={onContinue}>SEE THE FIELD →</Button>
        <Button variant="secondary" to="/">
          Back to lobby
        </Button>
      </div>
    </div>
  );
}

function ReceiptRow({
  index,
  label,
  detail,
  caption,
  amount,
  total = false,
}: {
  index: number;
  label: string;
  detail?: string;
  caption?: string;
  amount: number;
  total?: boolean;
}) {
  return (
    <div className={`receipt-row${total ? ' receipt-total' : ''}`} style={{ '--i': index } as CSSProperties}>
      <div className="receipt-row-main">
        <span className="label-caps receipt-label">{label}</span>
        {detail ? <span className="receipt-detail num">{detail}</span> : null}
        <span className={`receipt-amount num${amount < 0 ? ' negative' : ''}`}>
          {total ? (amount === 0 ? '0' : signedScore(amount)) : amount < 0 ? `−${-amount}` : amount}
        </span>
      </div>
      {caption ? <div className="receipt-caption">{caption}</div> : null}
    </div>
  );
}

/** Teaching aside for a receipt line — warm, precise, one clause. */
function caption(line: ScoreLine): string | undefined {
  switch (line.kind) {
    case 'odd-tricks':
      return 'the tricks past book (six) are the ones that pay';
    case 'game-bonus':
      return '100+ trick points books the game bonus';
    case 'partscore-bonus':
      return 'under 100 trick points — a part-score';
    case 'slam-bonus':
      return line.label.startsWith('Grand') ? 'all thirteen tricks, bid and made' : 'twelve tricks, bid and made';
    case 'insult-bonus':
      return line.amount === 100 ? 'one hundred for the insult' : 'fifty for the insult';
    case 'overtricks':
      return 'each trick past the contract pays extra';
    case 'undertricks':
      return 'the defenders collect for every trick short';
  }
}
