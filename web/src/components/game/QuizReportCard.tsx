import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import type { QuestionType, QuizReportRow } from '../../api';

/** Short type label for the ledger row's eyebrow — mirrors server/src/compare.ts's QUESTION_TYPE_LABELS. */
const TYPE_LABELS: Record<QuestionType, string> = {
  'suit-count': 'Suit length',
  'opponent-length': 'Suit length',
  void: 'Void detection',
  'trump-count': 'Trump count',
  'honor-location': 'Honor location',
  'suit-exhaustion': 'Void detection',
  'running-total': 'Running total',
};

/**
 * The Quiz Report Card — "B, the row-by-row ledger" from the design review:
 * one row per question this board took (trick + type, a short description,
 * a ✓/✗ mark), matching the app's existing ledger convention (perforated
 * panel, dashed-rule stagger). Rendered from the persistent Result screen
 * (never the transient ScoreReceipt), after the score-summary content —
 * present only when the board took at least one quiz.
 */
export function QuizReportCard({ rows, analyzeHref }: { rows: QuizReportRow[]; analyzeHref: string }) {
  const correct = rows.filter((r) => r.correct).length;
  return (
    <div className="qledger">
      <div className="qcard-heading">Card Counting</div>
      {rows.map((r, i) => (
        <div className="qledger-row" key={i} style={{ '--i': i } as CSSProperties}>
          <div className="qledger-main">
            <span className="qledger-type">
              Trick {r.trick} · {TYPE_LABELS[r.questionType]}
            </span>
            {r.description}
          </div>
          <span className={`qledger-mark ${r.correct ? 'yes' : 'no'}`} aria-hidden="true">
            {r.correct ? '✓' : '✗'}
          </span>
          <span className="sr-only">{r.correct ? 'correct' : 'incorrect'}</span>
        </div>
      ))}
      <div className="qledger-foot">
        <Link to={analyzeHref} className="qcard-cta">
          REVIEW IN ANALYZE →
        </Link>
        <span className="score num">
          {correct}/{rows.length}
        </span>
      </div>
    </div>
  );
}
