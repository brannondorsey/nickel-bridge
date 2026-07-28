import { PerforatedPanel } from '../ds/PerforatedPanel';
import { PctBar } from '../ds/PctBar';
import { ContractLabel } from './ContractLabel';
import { signedScore } from '../../format';

/**
 * One deal, three fates — duplicate's whole argument in a table.
 *
 * The rows are invented, not a real board: the point is to hold the deal
 * fixed and vary only the judgment, which no genuine field is guaranteed to
 * do this cleanly. It renders through the same `.fieldtable` markup a real
 * board result uses, so a first-timer meets the ledger's shape here and
 * recognises it later.
 *
 * The landing page's II · THE LEDGER section. The first-crossing tour used to
 * render this too, one screen later — which is exactly why the tour's pamphlet
 * panels were cut: they made this same argument, in these same words, to
 * someone who had just read it on the way in. Duplicate is now taught after
 * the practice deal instead, by the genuine house field.
 */
const SPECIMEN = [
  { who: 'You', contract: '4♠ by S =', score: 620, pct: 100, me: true },
  { who: 'Harold', contract: '3♠ by S +1', score: 170, pct: 50, me: false },
  { who: 'Margaret', contract: '4♠ by S −1', score: -100, pct: 0, me: false },
];

export function SpecimenField({ className = '' }: { className?: string }) {
  return (
    <PerforatedPanel heading="THE FIELD — ONE DEAL, THREE CROSSINGS" className={className}>
      <table className="fieldtable num">
        <tbody>
          {SPECIMEN.map((r) => (
            <tr key={r.who} className={r.me ? 'me' : ''}>
              <td className="fieldtable-name">{r.who}</td>
              <td className="fieldtable-contract">
                <ContractLabel label={r.contract} /> · {signedScore(r.score)}
              </td>
              <td className="fieldtable-pct">
                <PctBar pct={r.pct} width={56} /> <b className="fieldtable-pctnum">{r.pct}</b>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </PerforatedPanel>
  );
}
