import type { BidEval } from '../../api';
import { StarGrade } from '../ds/StarGrade';
import { Toast } from '../ds/Toast';
import { CallText } from './CallText';
import { SuitText } from './SuitText';

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

/** Post-bid grade toast: tier + stars (✗ for poor) + the robot comparison sentence. */
export function GradeToast({ evaluation }: { evaluation: BidEval }) {
  const differs = evaluation.bestCall !== evaluation.call;
  // Name the robot's bid when it's a recognized convention, so the comparison teaches.
  const bestTitle = evaluation.bestMeaning?.exact ? evaluation.bestMeaning.title : null;
  return (
    <Toast className={`grade-toast ${evaluation.grade}`} stamp={<StarGrade stars={GRADE_STARS[evaluation.grade]} size={14} />}>
      <b>{GRADE_TEXT[evaluation.grade]}</b> — you bid{' '}
      <b>
        <CallText call={evaluation.call} />
      </b>
      {differs ? (
        <>
          {evaluation.saycConsistent ? ', a textbook SAYC bid; the robot chose ' : '; the robot bid '}
          <b>
            <CallText call={evaluation.bestCall} />
          </b>
          {bestTitle ? (
            <>
              {' ('}
              <SuitText text={bestTitle} />)
            </>
          ) : null}
        </>
      ) : (
        <> — the robot’s choice too</>
      )}
      .
    </Toast>
  );
}
