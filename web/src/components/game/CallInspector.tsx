import { SEAT_SHORT, type AuctionEntry } from '../../api';
import { Chip } from '../ds/Chip';
import { Dialog } from '../ds/Dialog';
import { CallText } from './CallText';
import { ForcingChip } from './MeaningPanel';
import { SuitText } from './SuitText';

/** Bottom-sheet inspector for a past auction call. */
export function CallInspector({ entry, onClose }: { entry: AuctionEntry; onClose: () => void }) {
  const m = entry.meaning;
  const title = (
    <>
      {SEAT_SHORT[entry.seat]} bid <CallText call={entry.call} />
      {m ? (
        <>
          {' — '}
          <SuitText text={m.title} />
        </>
      ) : null}
    </>
  );
  return (
    <Dialog title={title} onClose={onClose}>
      {m ? (
        <>
          {m.points || m.shapePromise || m.forcing ? (
            <div className="meaning-chips">
              {m.points ? <Chip>{m.points}</Chip> : null}
              {m.shapePromise ? (
                <Chip quiet>
                  <SuitText text={m.shapePromise} />
                </Chip>
              ) : null}
              <ForcingChip forcing={m.forcing} />
            </div>
          ) : null}
          <div className="meaning-body">
            <SuitText text={m.description} />
          </div>
          {!m.exact ? <div className="meaning-caveat">Beyond the SAYC pamphlet — general guidance only.</div> : null}
        </>
      ) : (
        <div className="meaning-body">No standard SAYC meaning in this sequence — use your judgment.</div>
      )}
    </Dialog>
  );
}
