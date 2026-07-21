import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMe } from '../App';
import { SEAT_SHORT, TournamentInfo, api, boardConditions } from '../api';
import { ScreenHeader } from '../components/ds/AppHeader';
import { Button } from '../components/ds/Button';
import { FlipDigits } from '../components/ds/FlipDigits';
import { Loading } from '../components/ds/Loading';
import { PctBar } from '../components/ds/PctBar';
import { PerforatedPanel } from '../components/ds/PerforatedPanel';
import { Postmark } from '../components/ds/Postmark';
import { BoardTicketRow } from '../components/game/BoardTicketRow';
import { ContractLabel } from '../components/game/ContractLabel';
import { ordinal, postmarkDate, signedScore, tournamentNo, vulLabel } from '../format';

const TOTAL_BOARDS = 4;

/**
 * One page, two faces. The scoresheet lists all four boards as tickets
 * (scored / live / sealed — deals stay sealed until the previous board is
 * scored) over the live field. Once my four boards are done it flips to the
 * postmarked result; "Review the boards" toggles back without a new route.
 */
export default function Tournament() {
  const { tid } = useParams();
  const { me } = useMe();
  const navigate = useNavigate();
  const [t, setT] = useState<TournamentInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);

  useEffect(() => {
    api
      .tournament(Number(tid))
      .then(setT)
      .catch((e) => setError(e instanceof Error ? e.message : 'failed to load tournament'));
  }, [tid]);

  if (error) {
    return (
      <div className="tourney-page">
        <ScreenHeader title="Tournament" onBack={() => navigate('/')} />
        <div className="notice-error">{error}</div>
      </div>
    );
  }
  if (!t) {
    return (
      <div className="tourney-page">
        <Loading />
      </div>
    );
  }

  const myDone = t.myDone ?? 0;
  // House (benchmark AI) rows are full field members: they rank and count as
  // pairs like anyone else — the tag and muted styling below are the only
  // thing that sets them apart.
  const pairs = t.standings.length;
  const pairsWord = pairs === 1 ? 'pair' : 'pairs';
  const meRow = t.standings.find((s) => s.userId === me?.user?.id);
  const complete = myDone === TOTAL_BOARDS;

  if (complete && !reviewing) {
    const num = tournamentNo(t.name, t.id);
    const when = t.myLastPlayedAt ?? t.createdAt;
    const delta = t.myEloDelta ? t.myEloDelta.after - t.myEloDelta.before : null;
    return (
      <div className="tourney-page">
        <ScreenHeader title={t.name} caption={`Complete · ${pairs} ${pairsWord}`} onBack={() => navigate('/')} />
        <div className="tourney-result-hero">
          <Postmark size={118} arcBottom={`TOURNAMENT Nº${num}`} line1="TOLL PAID" line2={when ? postmarkDate(when) : ''} />
          <div className="tourney-pct">
            <FlipDigits value={meRow?.totalPct ?? '—'} suffix="%" size={54} />
          </div>
          <div className="label-caps tourney-rank num">
            MATCHPOINTS · {meRow?.rank ? `${ordinal(meRow.rank)} OF ` : ''}
            {pairs} {pairsWord.toUpperCase()}
          </div>
          {t.myEloDelta ? (
            <div className="tourney-rating num">
              <span className="label-caps">NICKEL RATING</span>
              <b>{t.myEloDelta.after}</b>
              {delta !== null && delta !== 0 ? (
                <span className={`tourney-rating-delta ${delta > 0 ? 'positive' : 'negative'}`}>
                  {delta > 0 ? '+' : '−'}
                  {Math.abs(delta)}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        <PerforatedPanel heading="BOARD BY BOARD" className="tourney-boards num">
          {(t.myBoards ?? []).map((b) => (
            <div key={b.no} className="tourney-board-line">
              <b className="tourney-board-no">{b.no}</b>
              <ContractLabel label={b.contractLabel ?? 'Passed out'} />
              <span className="tourney-board-score">{b.scoreNS !== null ? signedScore(b.scoreNS) : '—'}</span>
              <span className="tourney-board-pct">
                {b.pct !== null ? (
                  <>
                    <PctBar pct={b.pct} /> <b>{b.pct}</b>
                  </>
                ) : (
                  '—'
                )}
              </span>
            </div>
          ))}
        </PerforatedPanel>
        <div className="tourney-actions">
          <Button to="/">BACK TO THE BRIDGE →</Button>
          <Button variant="secondary" onClick={() => setReviewing(true)}>
            Review the boards
          </Button>
        </div>
      </div>
    );
  }

  const liveNo = myDone + 1;
  const rows = Array.from({ length: TOTAL_BOARDS }, (_, i) => {
    const no = i + 1;
    const summary = t.myBoards?.find((b) => b.no === no);
    if (summary?.state === 'done') {
      return (
        <BoardTicketRow
          key={no}
          no={no}
          state="scored"
          to={`/t/${t.id}/b/${no}`}
          main={
            <>
              <ContractLabel label={summary.contractLabel ?? 'Passed out'} />
              {summary.scoreNS !== null ? ` · ${signedScore(summary.scoreNS)}` : ''}
            </>
          }
          sub={summary.pct !== null ? `${summary.pct}% matchpoints` : 'waiting on the field'}
        />
      );
    }
    if (no === liveNo || summary) {
      const { dealer, vul } = boardConditions(no);
      return (
        <BoardTicketRow
          key={no}
          no={no}
          state="live"
          to={`/t/${t.id}/b/${no}`}
          main={summary?.state === 'playing' ? 'Card play — your turn' : 'Bidding — your call'}
          sub={`Dealer ${SEAT_SHORT[dealer]} · ${vulLabel(vul)}`}
        />
      );
    }
    return (
      <BoardTicketRow
        key={no}
        no={no}
        state="sealed"
        main={no === liveNo + 1 ? `Sealed — deals when board ${liveNo} is scored` : 'Sealed'}
      />
    );
  });

  return (
    <div className="tourney-page">
      <ScreenHeader title={t.name} caption={`${pairs} ${pairsWord} · matchpoints`} onBack={() => navigate('/')} />
      <div className="tourney-sheet">{rows}</div>
      <PerforatedPanel
        heading={myDone > 0 ? `THE FIELD — AFTER BOARD ${myDone}` : 'THE FIELD'}
        className="tourney-field num"
      >
        {t.standings.length === 0 ? (
          <div className="empty-note">No one has played a board yet.</div>
        ) : (
          t.standings.map((s, i) => {
            const you = s.userId === me?.user?.id;
            const house = s.kind === 'ai';
            // rank is set once a row is complete; until then fall back to the
            // row's current position in the pct-sorted field
            const rankLabel = s.rank ?? i + 1;
            return (
              <div
                key={s.userId}
                className={`tourney-field-row ${you ? 'tourney-field-you' : ''}${house ? ' tourney-field-house' : ''}`}
              >
                <b className="tourney-field-rank">{rankLabel}</b>
                <span className="tourney-field-name">
                  <Link to={`/players/${s.userId}`}>{you ? 'You' : s.handle}</Link>
                  {house ? <span className="house-tag">HOUSE</span> : null}
                  {!s.complete ? <span className="tourney-field-progress"> · {s.boardsDone}/4</span> : null}
                </span>
                <b>{s.totalPct !== null ? `${s.totalPct}%` : '—'}</b>
              </div>
            );
          })
        )}
      </PerforatedPanel>
      <div className="tourney-actions">
        {complete ? (
          <Button variant="secondary" onClick={() => setReviewing(false)}>
            Back to the summary
          </Button>
        ) : (
          <Button to={`/t/${t.id}/b/${liveNo}`}>
            {myDone === 0 ? 'PLAY BOARD 1 →' : `CONTINUE BOARD ${liveNo} →`}
          </Button>
        )}
      </div>
    </div>
  );
}
