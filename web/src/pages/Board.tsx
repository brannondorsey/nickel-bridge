import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AuctionEntry,
  BidEval,
  BidMeaning,
  BoardView,
  SEAT_SHORT,
  api,
  callDisplay,
  displaySort,
  strainClass,
} from '../api';
import { HandFan, PlayingCard } from '../components/Cards';

const GRADE_TEXT: Record<string, string> = {
  excellent: 'Excellent',
  good: 'Good',
  fair: 'Questionable',
  poor: 'Poor',
};
const GRADE_STARS: Record<string, number> = { excellent: 3, good: 2, fair: 1, poor: 0 };

export default function Board() {
  const { tid, no } = useParams();
  const navigate = useNavigate();
  const tournamentId = Number(tid);
  const boardNo = Number(no);

  const [board, setBoard] = useState<BoardView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedCall, setSelectedCall] = useState<number | null>(null);
  const [selectedCard, setSelectedCard] = useState<number | null>(null);
  const [lastEval, setLastEval] = useState<BidEval | null>(null);
  const [inspect, setInspect] = useState<AuctionEntry | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setBoard(null);
    setSelectedCall(null);
    setSelectedCard(null);
    setLastEval(null);
    setInspect(null);
    setError(null);
    api
      .board(tournamentId, boardNo)
      .then(setBoard)
      .catch((e) => setError(e.message));
  }, [tournamentId, boardNo]);
  useEffect(load, [load]);

  const submitCall = async (call: number) => {
    if (busy) return;
    setBusy(true);
    try {
      const { evaluation, board: next } = await api.call(tournamentId, boardNo, call);
      setLastEval(evaluation);
      setSelectedCall(null);
      setInspect(null);
      setBoard(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitCard = async (card: number) => {
    if (busy) return;
    setBusy(true);
    try {
      const { board: next } = await api.playCard(tournamentId, boardNo, card);
      setSelectedCard(null);
      setBoard(next);
      setLastEval(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div className="notice">
        {error}
        <p>
          <Link to="/">Back to lobby</Link>
        </p>
      </div>
    );
  }
  if (!board) return <div className="spin" />;

  const vulText = board.vul.ns && board.vul.ew ? 'All vul' : board.vul.ns ? 'NS vul' : board.vul.ew ? 'EW vul' : 'None vul';

  return (
    <div>
      <div className="board-head">
        <span>
          <b>{board.tournamentName}</b> · Board {board.boardNo}/{board.totalBoards}
        </span>
        <span>
          Dealer {SEAT_SHORT[board.dealer]} · <span className={`vulchip${board.vul.ns ? ' vul' : ''}`}>{vulText}</span>
        </span>
        {board.contractLabel && board.state !== 'done' ? (
          <span>
            <b>{board.contractLabel}</b> · {board.declarerTricks ?? 0} tricks
          </span>
        ) : null}
      </div>

      {board.state === 'done' ? (
        <Result board={board} onNext={() => (boardNo < board.totalBoards ? navigate(`/t/${tournamentId}/b/${boardNo + 1}`) : navigate(`/t/${tournamentId}`))} />
      ) : (
        <>
          <div className={`table-area${board.flipped && board.state === 'playing' ? ' flipping' : ''}`}>
            <Auction board={board} onInspect={(e) => setInspect(e === inspect ? null : e)} />
            {board.flipped && board.state === 'playing' ? (
              <div className="flip-note">
                Partner won the auction — board flipped. You're declaring from <b>North</b>; your South hand is dummy.
              </div>
            ) : null}
            {board.state === 'playing' ? <Table board={board} /> : null}
            {board.state === 'playing' ? (
              <>
                <MyHand board={board} selected={selectedCard} onSelect={(c) => (selectedCard === c ? submitCard(c) : setSelectedCard(c))} />
                {selectedCard !== null ? (
                  <div className="hand-label">tap again to play</div>
                ) : board.myTurn ? (
                  <div className="hand-label">
                    your turn{board.handToPlay === board.dummy ? ' — playing from dummy' : ''}
                  </div>
                ) : null}
              </>
            ) : null}
            {board.state === 'bidding' ? <MyHand board={board} /> : null}
          </div>

          {lastEval ? <GradeToast evaluation={lastEval} board={board} /> : null}
          {inspect?.meaning ? <MeaningPanel meaning={inspect.meaning} call={inspect.call} prefix={`${SEAT_SHORT[inspect.seat]} bid`} /> : null}

          {board.state === 'bidding' && board.myTurn ? (
            <BidBox
              board={board}
              selected={selectedCall}
              onSelect={(c) => setSelectedCall(selectedCall === c ? null : c)}
              onConfirm={() => selectedCall !== null && submitCall(selectedCall)}
              busy={busy}
            />
          ) : null}
          {board.state === 'bidding' && !board.myTurn ? <div className="notice">Robots are thinking…</div> : null}
        </>
      )}
    </div>
  );
}

function Auction({ board, onInspect }: { board: BoardView; onInspect: (e: AuctionEntry) => void }) {
  const rows: (AuctionEntry | null)[][] = [];
  let row: (AuctionEntry | null)[] = new Array(board.dealer).fill(null);
  for (const entry of board.auction) {
    row.push(entry);
    if (row.length === 4) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push([...row, ...new Array(4 - row.length).fill(null)]);
  if (!rows.length) rows.push([null, null, null, null]);

  return (
    <div className="auction">
      <table>
        <thead>
          <tr>
            {['N', 'E', 'S ★', 'W'].map((s) => (
              <th key={s}>{s}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((entry, j) => (
                <td key={j}>
                  {entry ? (
                    <button
                      className={`${entry.meaning ? 'hasMeaning' : ''}`}
                      onClick={() => onInspect(entry)}
                      title="what does this bid mean?"
                    >
                      <CallText call={entry.call} />
                    </button>
                  ) : null}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CallText({ call }: { call: number }) {
  const text = callDisplay(call);
  if (call < 3) return <span>{text}</span>;
  return <span className={strainClass((call - 3) % 5)}>{text}</span>;
}

function MyHand({
  board,
  selected,
  onSelect,
}: {
  board: BoardView;
  selected?: number | null;
  onSelect?: (card: number) => void;
}) {
  // Bottom fan = the hand the human plays from (South, or North when the
  // board is flipped). Top fan = dummy. Either can be the hand to play.
  const playingSeat = board.playingSeat ?? 2;
  const canPlayFrom = (seat: number | undefined) =>
    board.state === 'playing' && board.myTurn && board.handToPlay === seat;

  const dummyLabel =
    board.dummy === 2
      ? 'South — your hand as dummy'
      : `${['North', 'East', 'South', 'West'][board.dummy ?? 0]} (dummy${board.dummy === 0 && board.declarer === 2 ? ' — yours' : ''})`;
  const bottomLabel = playingSeat === 0 ? 'North (you, for partner)' : 'South (you)';

  return (
    <>
      {board.state === 'playing' && board.dummyHand ? (
        <>
          <div className="hand-label">
            {dummyLabel}
            {typeof board.dummyHcp === 'number' ? <span className="hcp-badge">{board.dummyHcp} HCP</span> : null}
          </div>
          <HandFan
            cards={displaySort(board.dummyHand)}
            legal={canPlayFrom(board.dummy) ? board.legalCards : []}
            selected={selected}
            onSelect={canPlayFrom(board.dummy) ? onSelect : undefined}
          />
        </>
      ) : null}
      <HandFan
        cards={displaySort(board.hand)}
        legal={board.state === 'playing' ? (canPlayFrom(playingSeat) ? board.legalCards : []) : undefined}
        selected={selected}
        onSelect={canPlayFrom(playingSeat) ? onSelect : undefined}
      />
      <div className="hand-label">
        {bottomLabel} <span className="hcp-badge">{board.hcp} HCP</span>
      </div>
    </>
  );
}

function Table({ board }: { board: BoardView }) {
  // rotate the compass 180° when the board is flipped (human declaring from N)
  const seats: { pos: string; seat: number }[] = board.flipped
    ? [
        { pos: 's', seat: 0 },
        { pos: 'w', seat: 1 },
        { pos: 'n', seat: 2 },
        { pos: 'e', seat: 3 },
      ]
    : [
        { pos: 'n', seat: 0 },
        { pos: 'e', seat: 1 },
        { pos: 's', seat: 2 },
        { pos: 'w', seat: 3 },
      ];
  const trick = board.currentTrick ?? [];
  const showTrick = trick.length ? trick : (board.lastTrick ?? []);
  return (
    <div className="trick">
      {seats.map(({ pos, seat }) => {
        const played = showTrick.find((t) => t.seat === seat);
        return (
          <div key={pos} className={`seatpos ${pos}`}>
            <span className="label">
              {SEAT_SHORT[seat]}
              {seat === board.declarer ? '·decl' : seat === board.dummy ? '·dummy' : ''}
            </span>
            {played ? <PlayingCard card={played.card} small /> : <div style={{ height: 'calc(var(--card-h) * 0.72)' }} />}
          </div>
        );
      })}
      <div className="tricks-count">
        <div>
          Declarer {board.declarerTricks ?? 0} · Defense {board.defenderTricks ?? 0}
        </div>
        <div style={{ opacity: 0.7 }}>{trick.length === 0 && (board.lastTrick?.length ?? 0) > 0 ? 'last trick' : `trick ${(board.completedTricks ?? 0) + 1}`}</div>
      </div>
    </div>
  );
}

function BidBox({
  board,
  selected,
  onSelect,
  onConfirm,
  busy,
}: {
  board: BoardView;
  selected: number | null;
  onSelect: (call: number) => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  const legal = useMemo(() => new Set(board.legalCalls ?? []), [board.legalCalls]);
  const meanings = (board as unknown as { legalCallMeanings?: Record<number, BidMeaning | null> }).legalCallMeanings ?? {};
  const meaning = selected !== null ? meanings[selected] : null;

  return (
    <>
      {selected !== null ? (
        meaning ? (
          <MeaningPanel meaning={meaning} call={selected} prefix="Your" />
        ) : (
          <div className="meaning-panel">
            <div className="mtitle">
              <CallText call={selected} />
            </div>
            No standard SAYC meaning in this sequence — use your judgment.
          </div>
        )
      ) : (
        <div className="meaning-panel" style={{ borderLeftColor: 'var(--line)' }}>
          Tap a bid to see what it means <em>before</em> you make it.
        </div>
      )}
      <div className="bidbox">
        <div className="grid">
          {Array.from({ length: 35 }, (_, i) => i + 3).map((call) => (
            <button
              key={call}
              className={`bid${selected === call ? ' selected' : ''}`}
              disabled={!legal.has(call)}
              onClick={() => onSelect(call)}
            >
              <CallText call={call} />
            </button>
          ))}
        </div>
        <div className="callrow">
          {[0, 1, 2].map((call) => (
            <button
              key={call}
              className={`bid${selected === call ? ' selected' : ''}`}
              disabled={!legal.has(call)}
              onClick={() => onSelect(call)}
            >
              {callDisplay(call)}
            </button>
          ))}
        </div>
      </div>
      <div className="confirm-row">
        <button className="btn btn-primary" disabled={selected === null || busy} onClick={onConfirm}>
          {busy ? '…' : selected !== null ? `Bid ${callDisplay(selected)}` : 'Select a bid'}
        </button>
      </div>
    </>
  );
}

function MeaningPanel({ meaning, call, prefix }: { meaning: BidMeaning; call: number; prefix: string }) {
  return (
    <div className="meaning-panel">
      <div className="mtitle">
        {prefix} <CallText call={call} /> — {meaning.title}
        {meaning.points ? <span className="mpts">{meaning.points}</span> : null}
        {meaning.shapePromise ? <span className="mshape">{meaning.shapePromise}</span> : null}
      </div>
      {meaning.description}
      {!meaning.exact ? <div className="approx">Beyond the SAYC pamphlet — general guidance only.</div> : null}
    </div>
  );
}

function GradeToast({ evaluation, board }: { evaluation: BidEval; board: BoardView }) {
  const stars = GRADE_STARS[evaluation.grade];
  const differs = evaluation.bestCall !== evaluation.call;
  return (
    <div className={`grade-toast ${evaluation.grade}`}>
      <b>
        {GRADE_TEXT[evaluation.grade]}{' '}
        <span className="stars">
          {[0, 1, 2].map((i) => (
            <span key={i} className={i < stars ? 'on' : 'off'}>
              ★
            </span>
          ))}
        </span>
      </b>{' '}
      — you bid <b>{callDisplay(evaluation.call)}</b>
      {differs ? (
        <>
          ; the AI prefers <b>{callDisplay(evaluation.bestCall)}</b> ({Math.round(evaluation.bestProb * 100)}% vs{' '}
          {Math.round(evaluation.userProb * 100)}%)
        </>
      ) : (
        <> — the AI’s choice too</>
      )}
      .
    </div>
  );
}

function Result({ board, onNext }: { board: BoardView; onNext: () => void }) {
  const r = board.result!;
  const low = r.pct < 40;
  return (
    <div className="result">
      <div className="score-hero">
        <div className="contract">{r.contractLabel}</div>
        <div className="points">
          {r.scoreNS > 0 ? '+' : ''}
          {r.scoreNS} for N-S
        </div>
        <div className={`pct-big${low ? ' low' : ''}`}>{r.pct}%</div>
        <div className="pct-sub">
          matchpoints vs {Math.max(0, r.field.length - 1)} other {r.field.length === 2 ? 'player' : 'players'} so far
          {r.bidAccuracy != null ? ` · bidding accuracy ${r.bidAccuracy}%` : ''}
        </div>
      </div>

      <div className="card-box">
        <h2>The field — board {board.boardNo}</h2>
        <table className="fieldtable">
          <thead>
            <tr>
              <th>Player</th>
              <th>Contract</th>
              <th className="num">Score</th>
              <th className="num">MP%</th>
            </tr>
          </thead>
          <tbody>
            {r.field.map((f) => (
              <tr key={f.userId} className={f.isMe ? 'me' : ''}>
                <td>{f.isMe ? 'You' : f.name}</td>
                <td>{f.contract}</td>
                <td className="num">{f.scoreNS}</td>
                <td className="num">
                  {f.pct}
                  <div className="pctbar">
                    <i style={{ width: `${f.pct}%` }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {board.bidEvals.length ? (
        <div className="card-box">
          <h2>Your bidding</h2>
          <div className="bid-recap">
            {board.bidEvals.map((e, i) => (
              <div className="item" key={i}>
                <span className="callname">
                  <CallText call={e.call} />
                </span>
                <span>
                  {GRADE_TEXT[e.grade]}
                  {e.bestCall !== e.call ? (
                    <>
                      {' '}
                      — AI preferred <CallText call={e.bestCall} />
                    </>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <button className="btn btn-primary" onClick={onNext}>
        {board.boardNo < board.totalBoards ? `Next board (${board.boardNo + 1}/${board.totalBoards})` : 'Tournament summary'}
      </button>
      <Link to="/" className="btn btn-secondary">
        Lobby
      </Link>
    </div>
  );
}
