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
 * One page, one URL (/t/:tid), two states of the same crossing. While the
 * tournament is live it's the scoresheet: four boards as tickets (scored /
 * live / sealed) over the running field. Once my four boards are done the
 * sheet is replaced by the postmarked receipt — hero result, the
 * board-by-board ledger, then the final field — and the ledger lines are
 * themselves the way back into a board. A finished tournament used to split
 * across two routes (/t/:tid and a /t/:tid/review sheet) that showed the
 * same four boards twice with a toggle between them; there is nothing on
 * the review sheet the receipt can't carry, so the second face is gone and
 * /t/:tid/review now just redirects here (old links, bookmarks, and the
 * browser's back-stack all still land somewhere real).
 */
export default function Tournament() {
  const { tid } = useParams();
  const { me } = useMe();
  const navigate = useNavigate();
  const [t, setT] = useState<TournamentInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

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
  // players like anyone else — the tag and muted styling below are the only
  // thing that sets them apart.
  const players = t.standings.length;
  const playersWord = players === 1 ? 'player' : 'players';
  const meRow = t.standings.find((s) => s.userId === me?.user?.id);
  const complete = myDone === TOTAL_BOARDS;

  // The field reads the same live or final — one panel, two headings.
  const field = (
    <PerforatedPanel
      heading={complete ? 'THE FIELD — FINAL' : myDone > 0 ? `THE FIELD — AFTER BOARD ${myDone}` : 'THE FIELD'}
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
  );

  if (complete) {
    const num = tournamentNo(t.name, t.id);
    const when = t.myLastPlayedAt ?? t.createdAt;
    const delta = t.myEloDelta ? t.myEloDelta.after - t.myEloDelta.before : null;
    return (
      <div className="tourney-page">
        <ScreenHeader title={t.name} caption={`Complete · ${players} ${playersWord}`} onBack={() => navigate('/')} />
        <div className="tourney-result-hero">
          <Postmark size={118} arcBottom={`TOURNAMENT Nº${num}`} line1="TOLL PAID" line2={when ? postmarkDate(when) : ''} />
          <div className="tourney-pct">
            <FlipDigits value={meRow?.totalPct ?? '—'} suffix="%" size={54} />
          </div>
          <div className="label-caps tourney-rank num">
            MATCHPOINTS · {meRow?.rank ? `${ordinal(meRow.rank)} OF ` : ''}
            {players} {playersWord.toUpperCase()}
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
        {/* The ledger doubles as the review sheet: every line is the board
            it scores, so revisiting one is a tap on the receipt rather than
            a detour through a second copy of the same four boards. */}
        <PerforatedPanel heading="BOARD BY BOARD" className="tourney-boards num">
          {(t.myBoards ?? []).map((b) => (
            <Link key={b.no} to={`/t/${t.id}/b/${b.no}`} className="tourney-board-line">
              <b className="tourney-board-no">{b.no}</b>
              <ContractLabel label={b.contractLabel ?? 'Passed out'} />
              <span className="tourney-board-score">{b.scoreNS !== null ? signedScore(b.scoreNS) : '—'}</span>
              <span className="tourney-board-pct">
                {b.pct !== null ? (
                  <>
                    <PctBar pct={b.pct} width={68} /> <b>{b.pct}</b>
                  </>
                ) : (
                  '—'
                )}
              </span>
              <span className="tourney-board-open" aria-hidden="true">
                ›
              </span>
            </Link>
          ))}
          <div className="tourney-boards-hint">Tap a board to look back over the play.</div>
        </PerforatedPanel>
        {field}
        <div className="tourney-actions">
          <Button to="/">BACK TO THE BRIDGE →</Button>
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
      <ScreenHeader title={t.name} caption={`${players} ${playersWord} · matchpoints`} onBack={() => navigate('/')} />
      <div className="tourney-sheet">{rows}</div>
      {field}
      <div className="tourney-actions">
        <Button to={`/t/${t.id}/b/${liveNo}`}>
          {myDone === 0 ? 'PLAY BOARD 1 →' : `CONTINUE BOARD ${liveNo} →`}
        </Button>
      </div>
    </div>
  );
}
