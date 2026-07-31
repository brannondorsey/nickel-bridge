import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMe } from '../App';
import { CompareMeasure, CompareView, ComparePanel, PairRecord, api } from '../api';
import { BeamBar } from '../components/ds/BeamBar';
import { Button } from '../components/ds/Button';
import { Loading } from '../components/ds/Loading';
import { PerforatedPanel } from '../components/ds/PerforatedPanel';
import { ScreenHeader } from '../components/ds/AppHeader';
import { GlossaryProse } from '../components/game/GlossaryProse';

/**
 * Compare — your record beside another player's.
 *
 * The screen's argument is that a difference is not automatically a lead. Every
 * judged row arrives from the server with a `gate` (the margin below which the
 * difference is inside its own measurement error) and a verdict already
 * decided; this file only draws them. It deliberately re-derives no statistics,
 * because the error model differs per measure and two implementations would
 * drift apart — see server/src/compare.ts.
 *
 * Reading order, which is also confidence order: head-to-head (the only fact
 * about these two specifically), the headline measures, the verdict tally, then
 * the long ledger — bidding by type first, because those are the largest
 * samples in the app and the most actionable thing here, then conventions and
 * contract tiers where the samples thin out and most rows are set aside. The
 * context panel is last and is never judged at all.
 */

const PANEL_ORDER: { panel: ComparePanel; heading: string; tag?: string }[] = [
  { panel: 'bidType', heading: 'BIDDING BY TYPE', tag: '★★ OR BETTER' },
  { panel: 'convention', heading: 'BIDDING BY CONVENTION', tag: 'BOTH HAVE CALLED' },
  { panel: 'contract', heading: 'CONTRACTS MADE', tag: 'AS DECLARER' },
];

/** Figures print in their own units; a null figure is an em dash, never a zero. */
function fig(v: number | null, unit: string): string {
  if (v === null) return '—';
  if (unit === 'pct') return `${Math.round(v)}%`;
  if (unit === 'pct1') return `${v}%`;
  if (unit === 'delta') return `${v >= 0 ? '+' : '−'}${Math.abs(v)}`;
  return String(v);
}

/** "5", "3.6" — the margin, in the row's own units, for the label inside the fill. */
const marginLabel = (m: number) => String(Math.abs(Math.round(m * 10) / 10));

/**
 * The whole row as a sentence, for assistive tech.
 *
 * The bar itself is aria-hidden, so this is the only thing announced — which
 * means it has to carry the verdict AND the reason, not just the two figures.
 * Same split Sparkline makes between its aria-valuetext and its visual detail.
 */
function reading(m: CompareMeasure, them: string): string {
  const mine = fig(m.a, m.unit);
  const theirs = fig(m.b, m.unit);
  const head = `${m.label.toLowerCase()} — you ${mine}, ${them} ${theirs}`;
  if (m.verdict === 'aside') {
    if (m.reason === 'provisional') return `${head}. Not compared: a rating needs more rated crossings first.`;
    if (m.reason === 'no-data') return `${head}. Not compared: one of you has no record for this yet.`;
    return `${head}. Not compared: too few boards between you for any difference to mean anything.`;
  }
  const by = `by ${marginLabel(m.margin)}`;
  if (m.verdict === 'level') return `${head}. Too close to call — the ${marginLabel(m.margin)} point gap is inside the ${m.gate} point threshold.`;
  return `${head}. ${m.verdict === 'you' ? 'You lead' : `${them} leads`} ${by}, past the ${m.gate} point threshold.`;
}

function MeasureRow({ m, them }: { m: CompareMeasure; them: string }) {
  return (
    <li className="cmp-row">
      <span className="sr-only">{reading(m, them)}</span>
      <div className="cmp-row-top" aria-hidden="true">
        <span className="cmp-fig num">{fig(m.a, m.unit)}</span>
        <span className="cmp-name">{m.label}</span>
        <span className="cmp-fig cmp-fig-them num">{fig(m.b, m.unit)}</span>
      </div>
      <BeamBar
        margin={m.margin}
        gate={m.gate}
        fullTilt={m.fullTilt}
        verdict={m.verdict}
        label={marginLabel(m.margin)}
      />
      <div className="cmp-row-sub num" aria-hidden="true">
        <span>{m.samples[0]}</span>
        <span>{m.samples[1]}</span>
      </div>
    </li>
  );
}

/** The tally strip: one mark per shared crossing, oldest at left. */
function Tally({ record }: { record: PairRecord }) {
  return (
    <div className="cmp-tally" aria-hidden="true">
      {record.sequence.map((s, i) => (
        <span key={i} className={`cmp-tick cmp-tick-${s}`} />
      ))}
    </div>
  );
}

export default function Compare() {
  const { id } = useParams();
  const { me } = useMe();
  const navigate = useNavigate();
  const [view, setView] = useState<CompareView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setView(null);
    setError(null);
    api
      .compare(Number(id))
      .then(setView)
      .catch((e) => setError(e instanceof Error ? e.message : 'failed to load comparison'));
  }, [id]);

  if (error) {
    return (
      <div className="cmp-page">
        <ScreenHeader title="Compare" onBack={() => navigate(-1)} />
        <div className="notice-error">{error}</div>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="cmp-page">
        <ScreenHeader title="Compare" onBack={() => navigate(-1)} />
        <Loading />
      </div>
    );
  }

  const them = view.them.handle;
  const initial = (h: string) => (h ? [...h][0].toUpperCase() : '');

  const who = (
    <div className="cmp-who">
      <div className="cmp-side">
        <div className="cmp-av cmp-av-you">{initial(me?.user?.handle ?? '')}</div>
        <div className="cmp-name-block">
          <div className="cmp-handle">You</div>
          <div className="cmp-sub">{view.you.boards} boards</div>
        </div>
      </div>
      <span className="cmp-vs">VS</span>
      <div className="cmp-side cmp-side-them">
        <div className="cmp-name-block cmp-name-block-them">
          <div className="cmp-handle">
            {them}
            {view.them.kind === 'ai' ? <span className="house-tag">HOUSE</span> : null}
          </div>
          <div className="cmp-sub">{view.them.boards} boards</div>
        </div>
        {view.them.picture ? (
          <img className="cmp-av" src={view.them.picture} alt="" referrerPolicy="no-referrer" />
        ) : (
          <div className="cmp-av">{initial(them)}</div>
        )}
      </div>
    </div>
  );

  // Too thin to compare. Deliberately not an error and not an empty page: the
  // entry points hide themselves below the floor, so anyone landing here
  // followed a direct link and deserves to be told what is actually missing.
  if (!view.eligible) {
    const short = view.you.boards < view.minBoards ? 'you' : 'them';
    return (
      <div className="cmp-page">
        <ScreenHeader title="Compare" onBack={() => navigate(-1)} />
        {who}
        <div className="cmp-thin">
          <p className="cmp-thin-lead">
            <GlossaryProse
              text={
                short === 'you'
                  ? `The ledger needs ${view.minBoards} boards from each of you before it will compare records. You have ${view.you.boards}.`
                  : `${them} has ${view.them.boards} boards. The ledger needs ${view.minBoards} from each of you before it will compare records.`
              }
            />
          </p>
          <p className="cmp-thin-note">
            <GlossaryProse text="Below that, almost every difference between two players is the shuffle rather than the play — so there is nothing here worth printing yet." />
          </p>
          <Button variant="secondary" to={`/players/${view.them.id}`}>
            Read {them}'s record →
          </Button>
        </div>
      </div>
    );
  }

  const headline = view.measures.filter((m) => m.panel === 'headline');
  const aside = view.tally.aside;

  return (
    <div className="cmp-page">
      <ScreenHeader title="Compare" onBack={() => navigate(-1)} />
      {who}

      {view.headToHead ? (
        <div className="cmp-slip">
          <div className="label-caps cmp-slip-eyebrow">HEAD TO HEAD</div>
          <div className="cmp-slip-fig num">
            {view.headToHead.ahead}
            <span className="cmp-slip-sep">–</span>
            {view.headToHead.behind}
            {view.headToHead.tied ? (
              <>
                <span className="cmp-slip-sep">–</span>
                {view.headToHead.tied}
              </>
            ) : null}
          </div>
          <div className="cmp-slip-sub">
            <GlossaryProse
              text={`${view.headToHead.shared} crossing${view.headToHead.shared === 1 ? '' : 's'} shared. ${
                view.headToHead.ahead > view.headToHead.behind
                  ? 'You lead.'
                  : view.headToHead.ahead < view.headToHead.behind
                    ? `${them} leads.`
                    : 'Dead even.'
              }`}
            />
          </div>
          <Tally record={view.headToHead} />
          <div className="cmp-tally-key">Oldest at left</div>
        </div>
      ) : (
        // No head-to-head. The panel renders EITHER WAY: common ground is the
        // good case, but "you have never crossed" is itself the answer to the
        // first question this screen invites, and dropping the panel when there
        // is no shared opponent would leave that question silently unanswered.
        // Not hypothetical — the house personas only play a tournament once
        // someone lands in it, so a pair can easily share no opponent at all.
        <PerforatedPanel heading="COMMON GROUND" className="cmp-common">
          <p className="cmp-common-lead">
            <GlossaryProse
              text={
                view.commonGround && view.commonGround.length > 0
                  ? `You have never crossed with ${them}. You have both played the house, though — and the house plays the same every night.`
                  : `You have never crossed with ${them}, and you have no opponent in common yet either. The beam below is the only reading available.`
              }
            />
          </p>
          {view.commonGround?.map((c) => (
            <div key={c.userId} className="cmp-common-row">
              <span className="cmp-common-name">{c.handle}</span>
              <span className="cmp-common-fig num">
                {c.you.ahead} of {c.you.shared}
              </span>
              <span className="cmp-common-fig cmp-common-fig-them num">
                {c.them.ahead} of {c.them.shared}
              </span>
            </div>
          ))}
          {view.commonGround && view.commonGround.length > 0 ? (
            <div className="cmp-common-note">
              <GlossaryProse text="Crossings each of you finished ahead of that house player. Shown without a verdict — it is a weaker reading than the beam, and should not look as confident." />
            </div>
          ) : (
            <div className="cmp-common-note">
              <GlossaryProse text="Once you have both faced the same house player, their record against each of you appears here — the nearest thing to a shared table." />
            </div>
          )}
        </PerforatedPanel>
      )}

      <PerforatedPanel heading="WHERE THE BEAM TIPS" className="cmp-beam-panel">
        <div className="cmp-legend" aria-hidden="true">
          <span>◀ YOUR SIDE</span>
          <b>┊ GATE ┊</b>
          <span>THEIR SIDE ▶</span>
        </div>
        <ul className="cmp-rows">
          {headline.map((m) => (
            <MeasureRow key={m.key} m={m} them={them} />
          ))}
        </ul>
        {/* Three states, three sentences — a reader meeting a page of hatching
            needs to be told what hatching means, not just what grey means. */}
        <div className="cmp-foot">
          <span>Bars show the margin, not the score.</span>
          <span>Grey has not cleared its gate; hatched is too thin to call at all.</span>
        </div>
        <div className="cmp-caveat">
          <GlossaryProse text="Matchpoints are scored against each crossing's own field, so that row compares two players against different opposition. The head-to-head does not." />
        </div>
      </PerforatedPanel>

      <div className="cmp-verdict">
        <div className="cmp-chips">
          <span className="cmp-chip cmp-chip-you">{view.tally.you} yours</span>
          <span className="cmp-chip cmp-chip-them">{view.tally.them} theirs</span>
          <span className="cmp-chip cmp-chip-level">{view.tally.level} level</span>
        </div>
        <div className="cmp-verdict-txt">
          <GlossaryProse
            text={
              view.tally.you + view.tally.them === 0
                ? 'Nothing between you that the ledger will certify yet — every difference so far is inside its own margin of error.'
                : `${view.tally.you} measure${view.tally.you === 1 ? '' : 's'} to you, ${view.tally.them} to ${them}, ${view.tally.level} too close to call.`
            }
          />
          {aside > 0 ? (
            <GlossaryProse text={` A further ${aside} ${aside === 1 ? 'is' : 'are'} set aside for want of boards.`} />
          ) : null}
        </div>
      </div>

      <div className="cmp-cut">
        <span>THE LONG LEDGER</span>
      </div>

      {PANEL_ORDER.map(({ panel, heading, tag }) => {
        const rows = view.measures.filter((m) => m.panel === panel);
        if (rows.length === 0) return null;
        const setAside = rows.filter((m) => m.verdict === 'aside');
        const drawn = rows.filter((m) => m.verdict !== 'aside');
        return (
          <PerforatedPanel key={panel} heading={heading} className="cmp-beam-panel">
            {tag ? <div className="cmp-panel-tag">{tag}</div> : null}
            {drawn.length > 0 ? (
              <ul className="cmp-rows">
                {drawn.map((m) => (
                  <MeasureRow key={m.key} m={m} them={them} />
                ))}
              </ul>
            ) : null}
            {setAside.length > 0 ? (
              <div className="cmp-aside-note">
                <GlossaryProse
                  text={`Set aside — ${setAside
                    .map((m) => m.label.toLowerCase())
                    .join(', ')}: too few between you for a difference to mean anything.`}
                />
              </div>
            ) : null}
          </PerforatedPanel>
        );
      })}

      <PerforatedPanel heading="FOR CONTEXT" className="cmp-context">
        <div className="cmp-panel-tag">NEVER JUDGED</div>
        {view.context.map((c) => (
          <div key={c.key} className="cmp-common-row">
            <span className="cmp-common-name">{c.label}</span>
            <span className="cmp-common-fig num">{fig(c.a, c.unit)}</span>
            <span className="cmp-common-fig cmp-common-fig-them num">{fig(c.b, c.unit)}</span>
          </div>
        ))}
        <div className="cmp-common-note">
          <GlossaryProse text="Volume is not skill, and a best score is one night rather than a habit. These sit here so you can weigh everything above them." />
        </div>
      </PerforatedPanel>

      <div className="cmp-footer">
        <Button variant="secondary" to={`/players/${view.them.id}`}>
          Read {them}'s record →
        </Button>
      </div>
    </div>
  );
}
