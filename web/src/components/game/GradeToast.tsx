import type { BidEval } from '../../api';
import { StarGrade } from '../ds/StarGrade';
import { Toast } from '../ds/Toast';
import { CallText } from './CallText';
import { GlossaryProse } from './GlossaryProse';

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

/**
 * Post-bid grade toast: tier + stars (✗ for poor) + the robot comparison sentence.
 *
 * `evaluation.saycConsistent` is evaluated against the HUMAN'S OWN submitted call
 * (bidder.ts's saycConsistent(hand, dealer, calls, userCall)), so naming it here is
 * exactly the fact "Hide your side's bid meanings" seals everywhere else — the
 * MeaningPanel/CallInspector/AuctionGrid dot for this same call. `ownMeaningsHidden`
 * suppresses only that one clause; the grade itself, the star count, and the robot's
 * own bid + meaning are unaffected — this is about not narrating the human's call as
 * "textbook SAYC," not about hiding feedback on it.
 */
export function GradeToast({ evaluation, ownMeaningsHidden = false }: { evaluation: BidEval; ownMeaningsHidden?: boolean }) {
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
          {evaluation.saycConsistent && !ownMeaningsHidden ? ', a textbook SAYC bid; the robot chose ' : '; the robot bid '}
          <b>
            <CallText call={evaluation.bestCall} />
          </b>
          {bestTitle ? (
            <>
              {' ('}
              <GlossaryProse text={bestTitle} />)
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
