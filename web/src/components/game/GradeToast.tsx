import type { BidEval } from '../../api';
import { StarGrade } from '../ds/StarGrade';
import { Toast } from '../ds/Toast';
import { CallText } from './CallText';

export const GRADE_TEXT: Record<BidEval['grade'], string> = {
  excellent: 'Excellent',
  good: 'Good',
  fair: 'Questionable',
  poor: 'Poor',
};
export const GRADE_STARS: Record<BidEval['grade'], 0 | 1 | 2 | 3> = {
  excellent: 3,
  good: 2,
  fair: 1,
  poor: 0,
};

/** Post-bid grade toast: tier + stars (✗ for poor) + the AI comparison sentence. */
export function GradeToast({ evaluation }: { evaluation: BidEval }) {
  const differs = evaluation.bestCall !== evaluation.call;
  return (
    <Toast className={`grade-toast ${evaluation.grade}`} stamp={<StarGrade stars={GRADE_STARS[evaluation.grade]} size={14} />}>
      <b>{GRADE_TEXT[evaluation.grade]}</b> — you bid{' '}
      <b>
        <CallText call={evaluation.call} />
      </b>
      {differs ? (
        <>
          ; the AI prefers{' '}
          <b>
            <CallText call={evaluation.bestCall} />
          </b>{' '}
          ({Math.round(evaluation.bestProb * 100)}% vs {Math.round(evaluation.userProb * 100)}%)
        </>
      ) : (
        <> — the AI’s choice too</>
      )}
      .
    </Toast>
  );
}
