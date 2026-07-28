import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMe } from '../App';
import { api, type ActivityResponse } from '../api';
import { AppHeader } from '../components/ds/AppHeader';
import { BridgeMark } from '../components/ds/BridgeMark';
import { DayStrip } from '../components/ds/DayStrip';
import { Loading } from '../components/ds/Loading';
import { PerforatedPanel } from '../components/ds/PerforatedPanel';
import { clockTime } from '../format';
import { dayDate, dayLabel, groupRuns, runSentence, stripLabel, stripMarks, type Run } from './activityFeed';

/**
 * Rating change over a run — glyph + colour, never colour alone (as on the
 * ladder). null ("nothing here rated") and 0 ("rated, didn't move") collapse
 * to the same em dash on purpose, matching Movement on the Rankings page: the
 * distinction is worth keeping in the data and not worth a second glyph here.
 */
function Delta({ value }: { value: number | null }) {
  if (value === null || value === 0) return <span className="traffic-delta quiet">—</span>;
  if (value > 0) return <span className="traffic-delta positive">▲{value}</span>;
  return <span className="traffic-delta negative">▼{-value}</span>;
}

function TrafficRow({ run, you }: { run: Run; you: boolean }) {
  return (
    <Link to={`/players/${run.userId}`} className={`traffic-row${you ? ' traffic-row-you' : ''}`}>
      <span className="traffic-clock num">{clockTime(run.at)}</span>
      <span className="traffic-body">
        <span className="traffic-top">
          <span className="traffic-name">
            {run.handle}
            {you ? ' — you' : ''}
          </span>
          <span className="traffic-sp" />
          {run.joined && run.boards === 0 ? (
            <span className="traffic-tag">JOINED</span>
          ) : (
            <Delta value={run.eloDelta} />
          )}
        </span>
        <span className="traffic-line num">{runSentence(run)}</span>
      </span>
    </Link>
  );
}

/**
 * TRAFFIC: who else has been on the bridge, over the last seven days.
 *
 * Everything about how the events become days and rows lives in
 * activityFeed.ts — including, importantly, the fact that the grouping is done
 * against the VIEWER's clock. The server has no timezone for anyone, so this
 * screen is the only place that can know where a local midnight falls.
 */
export default function Activity() {
  const { me } = useMe();
  const [data, setData] = useState<ActivityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .activity()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'failed to load the traffic'));
  }, []);

  const now = new Date();
  const days = data ? groupRuns(data, now) : null;
  const travellers = days ? new Set(days.flatMap((d) => d.runs.map((r) => r.userId))).size : 0;
  const anyTraffic = days?.some((d) => d.runs.length) ?? false;

  return (
    <div className="traffic">
      <AppHeader context="TRAFFIC" />
      {error ? <div className="notice-error">{error}</div> : null}
      {days === null ? (
        error ? null : (
          <Loading />
        )
      ) : (
        <>
          <div className="traffic-head">
            <div className="traffic-title">The traffic</div>
            <div className="label-caps num">
              LAST 7 DAYS · {travellers} {travellers === 1 ? 'TRAVELLER' : 'TRAVELLERS'}
            </div>
          </div>

          {!anyTraffic ? (
            <div className="empty-note traffic-cold">
              Nobody has crossed in the last seven days.
              <br />
              Be the first — the gate is open.
            </div>
          ) : (
            days.map((day) => {
              const label = dayLabel(day.dateKey, now);
              // The now rule belongs to today and nowhere else.
              const isToday = label === 'Today';
              return (
                <div key={day.dateKey}>
                  <div className="traffic-dayhead">
                    <h3>{label}</h3>
                    <span>{dayDate(day.dateKey)}</span>
                  </div>
                  {day.runs.length === 0 ? (
                    // Printed, not skipped: a gap in the week is information,
                    // and dropping it would make the bridge look busier than it is.
                    <PerforatedPanel dashed className="traffic-panel">
                      <div className="empty-note">The bridge was empty.</div>
                    </PerforatedPanel>
                  ) : (
                    <PerforatedPanel className="traffic-panel">
                      <DayStrip
                        marks={stripMarks(day)}
                        nowFraction={isToday ? (now.getTime() / 1000 - day.startsAt) / 86400 : undefined}
                        label={stripLabel(day, label)}
                      />
                      {day.runs.map((run) => (
                        <TrafficRow key={`${run.userId}-${run.block}`} run={run} you={run.userId === me?.user?.id} />
                      ))}
                    </PerforatedPanel>
                  )}
                </div>
              );
            })
          )}

          <div className="traffic-foot">
            <BridgeMark width={34} />
            <div className="traffic-foot-text">
              Hours are your own clock.{' '}
              <span className="traffic-foot-quiet">
                Ratings are shown as they stand right now — the ledger is replayed from every crossing ever played, so
                an old tournament finishing today can restate a number you saw yesterday.
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
