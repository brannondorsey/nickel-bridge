import { SEAT_SHORT, type AuctionEntry, callDisplay } from '../../api';
import { Chip } from '../ds/Chip';
import { Dialog } from '../ds/Dialog';

/** Bottom-sheet inspector for a past auction call. */
export function CallInspector({ entry, onClose }: { entry: AuctionEntry; onClose: () => void }) {
  const m = entry.meaning;
  const title = `${SEAT_SHORT[entry.seat]} bid ${callDisplay(entry.call)}${m ? ` — ${m.title}` : ''}`;
  return (
    <Dialog title={title} onClose={onClose}>
      {m ? (
        <>
          {m.points || m.shapePromise ? (
            <div className="meaning-chips">
              {m.points ? <Chip>{m.points}</Chip> : null}
              {m.shapePromise ? <Chip quiet>{m.shapePromise}</Chip> : null}
            </div>
          ) : null}
          <div className="meaning-body">{m.description}</div>
          {!m.exact ? <div className="meaning-caveat">Beyond the SAYC pamphlet — general guidance only.</div> : null}
        </>
      ) : (
        <div className="meaning-body">No standard SAYC meaning in this sequence — use your judgment.</div>
      )}
    </Dialog>
  );
}
