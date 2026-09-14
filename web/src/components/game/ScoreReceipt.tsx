import type { CSSProperties } from 'react';
import { BoardView, ScoreLine } from '../../api';
import { Button } from '../ds/Button';
import { PctBar } from '../ds/PctBar';
import { PerforatedPanel } from '../ds/PerforatedPanel';
import { Postmark } from '../ds/Postmark';
import { postmarkDate, signedScore, tournamentNo, vulLabel } from '../../format';
import { ContractLabel } from './ContractLabel';
import { GlossaryProse } from './GlossaryProse';

/**
 * The toll receipt — an interstitial shown when a board is scored, before the
 * field comparison. Itemizes where the duplicate score came from using the
 * server's ScoreBreakdown (declaring side's ledger): odd tricks, game/slam
 * bonuses, the insult, overtricks or undertrick penalties. Rows print in one
 * per beat (pure CSS, stilled under prefers-reduced-motion), then the
 * postmark cancels the total — TOLL PAID when the human's side collected,
 * TOLL REFUSED when it went down; no postmark when the robots declared.
 *
 * `onLeave` overrides the secondary action's plain <Link to="/">: the
 * first-crossing tour renders in place of the routes, so a link to the lobby
 * changes the URL and nothing else — leaving it has to go through the tour's
 * own exit (which stamps the onboarding gate) instead.
 *
 * `analyzeHref` mirrors the Result screen's own "Analyze play →" door — the
 * toll receipt is reached first, before a player ever taps SEE THE FIELD, so
 * the door belongs here too rather than only one screen later. Omitted
 * entirely (not just hidden) when the caller has nothing to link to —
 * Tour.tsx's captured practice board has no real tournamentId to analyze.
 */
export function ScoreReceipt({
  board,
  onContinue,
  onLeave,
  analyzeHref,
}: {
  board: BoardView;
  onContinue: () => void;
  onLeave?: () => void;
  analyzeHref?: string;
}) {
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
        <div className="result-contract">
          <ContractLabel label={r.contractLabel} />
        </div>
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
              <ReceiptRow
                key={i}
                index={i}
                label={line.label}
                detail={line.detail}
                caption={caption(line)}
                amount={line.amount}
                barPct={lineBarPct(line.amount, bd.lines)}
              />
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
            arcBottom={`TOURNAMENT Nº${tournamentNo(board.tournamentNumber, board.tournamentId)}`}
            line1={stamp === 'TOLL PAID' ? 'TOLL PAID' : 'REFUSED'}
            line2={postmarkDate(Date.now() / 1000)}
          />
        </div>
      ) : null}

      <div className="board-actions">
        <Button onClick={onContinue}>SEE THE FIELD →</Button>
        {analyzeHref ? (
          <Button variant="secondary" to={analyzeHref}>
            Analyze play →
          </Button>
        ) : null}
        {onLeave ? (
          <Button variant="secondary" onClick={onLeave}>
            Back to lobby
          </Button>
        ) : (
          <Button variant="secondary" to="/">
            Back to lobby
          </Button>
        )}
      </div>
    </div>
  );
}

export function ReceiptRow({
  index,
  label,
  detail,
  caption,
  amount,
  barPct,
  total = false,
}: {
  index: number;
  label: string;
  detail?: string;
  caption?: string;
  amount: number;
  /** This line's amount as a percentage of the receipt's largest earner, for
   *  the proportional fill between the label and the score — see
   *  `lineBarPct` below. Undefined on a total row (nothing to be
   *  proportional TO once the lines are summed), on the single passed-out
   *  row, and on a penalty, where `<PctBar>` renders nothing at all. */
  barPct?: number;
  total?: boolean;
}) {
  return (
    <div className={`receipt-row${total ? ' receipt-total' : ''}`} style={{ '--i': index } as CSSProperties}>
      <div className="receipt-row-main">
        <span className="label-caps receipt-label">{label}</span>
        {detail ? <span className="receipt-detail num">{detail}</span> : null}
        {barPct !== undefined ? <PctBar pct={barPct} className="receipt-bar" /> : null}
        <span className={`receipt-amount num${amount < 0 ? ' negative' : ''}`}>
          {total ? (amount === 0 ? '0' : signedScore(amount)) : amount < 0 ? `−${-amount}` : amount}
        </span>
      </div>
      {caption ? (
        <div className="receipt-caption">
          <GlossaryProse text={caption} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * A line's proportional fill against the receipt's own biggest EARNER — the
 * same "proportional bar between label and score" idiom the tournament
 * summary's board-by-board ledger and the field table already use via
 * `PctBar`, just scaled against this receipt's own lines rather than a
 * matchpoint percentage (a toll line has no natural 0-100 scale of its own).
 * Exported for `AdjustedReceipt.tsx`, which itemizes a rehearsal's own score
 * through the same `ReceiptRow`.
 *
 * Two lines get no bar at all, and the first is the one that matters. **A
 * PENALTY IS NOT A SHARE OF ANYTHING.** `scoreBreakdown` returns early on a
 * defeated contract (`packages/core/src/score.ts`), so its whole receipt is
 * a single `amount: -penalty` line — which, scaled against the biggest line
 * on its own receipt, is 100% by construction. Every "Down N" receipt drew a
 * full-width fill, in the same flat `--ink` a made contract's game bonus
 * gets, saying "this is the whole of it" where the bar's job is to say "this
 * is how much of it". Drawing it in `--negative` instead was the other
 * option and is worse: a full-width RED bar is a louder version of the same
 * wrong reading, and the amount beside it already carries that ink. So the
 * bar is reserved for what a line EARNED — the sign test is what states
 * that, and it holds if score.ts ever itemizes a penalty alongside anything
 * else. The second is a receipt with only one line, where there is no other
 * line to be proportional to whatever the signs are.
 *
 * `undefined` rather than 0: `ReceiptRow` renders no `<PctBar>` at all for
 * it, where a 0 would draw an empty track — the "nothing here yet" reading,
 * which is a different claim from "this is not measured that way".
 */
export function lineBarPct(amount: number, lines: ScoreLine[]): number | undefined {
  if (amount <= 0 || lines.length < 2) return undefined;
  const max = Math.max(1, ...lines.map((l) => l.amount));
  return Math.round((amount / max) * 100);
}

/** Teaching aside for a receipt line — warm, precise, one clause. Exported for
 *  AdjustedReceipt.tsx, which itemizes a rehearsal's own score the same way. */
export function caption(line: ScoreLine): string | undefined {
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
