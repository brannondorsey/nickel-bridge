import type { LinkPolicy } from '../glossary/linkify';
import { TERMS } from '../glossary/terms';
import { Splash } from '../components/Splash';
import { BridgeMark } from '../components/ds/BridgeMark';
import { Button } from '../components/ds/Button';
import { InkStamp } from '../components/ds/InkStamp';
import { PerforatedPanel } from '../components/ds/PerforatedPanel';
import { SignInActions } from '../components/ds/SignInActions';
import { StarGrade } from '../components/ds/StarGrade';
import { TicketStub } from '../components/ds/TicketStub';
import { CallText } from '../components/game/CallText';
import { GlossaryProse } from '../components/game/GlossaryProse';
import { SpecimenField } from '../components/game/SpecimenField';
import { makeBid } from '../api';

/**
 * The landing page — what a visitor without an account gets at `/`.
 *
 * It opens on the splash, unchanged: the toll gate is the brand, and the
 * returning-visitor overlay is the same component, so the hero has to stay
 * exactly what it was. What's new is everything under it. The splash alone
 * said thirty deliberately cryptic words and then asked for a Google account,
 * which is a lot to ask of someone who has not been told what duplicate
 * bridge is, let alone whether they'd like it.
 *
 * So the page below the fold is the pitch, and it ends by handing over three
 * things a visitor can do *before* signing anything: read the ledger, walk the
 * practice board, look at the field. Those three routes are public (see
 * App.tsx's isPublicPath) and this page is the only place they're advertised.
 *
 * Copy runs through GlossaryProse under LANDING_LINKS, so the vocabulary a
 * newcomer is meeting for the first time is tappable in the sentence that
 * introduces it — the same treatment the first-crossing tour gets, for the
 * same reason. And the same trap: `force` re-links a handful of words that
 * terms.ts marks `linkify: false` because they'd be a link farm in gameplay
 * prose. Here each appears about once, to someone who has never seen it.
 *
 * This component is also App.tsx's signed-out fallback for any non-public
 * path, so a shared board or tournament link still lands on an invitation
 * rather than a 404. (Voice rules: .claude/skills/nickel-bridge-design.)
 */

const LANDING_LINKS: LinkPolicy = {
  force: ['deal', 'trick', 'trump'],
};

/** The demonstration auction row in III — 1NT graded three stars, as the board really renders it. */
const DEMO_CALL = makeBid(1, 4); // 1NT

export default function Login() {
  return (
    <div className="landing">
      <Splash
        pitch="A century-old bridge by another name. It wasn't a nickel then and it isn't now. This bridge is not a bridge."
        cta={<SignInActions />}
        // The hero is a full 100dvh and, above the fold, is the identical
        // dead-end splash it has always been. Without something saying so,
        // most visitors never learn there's a page under it — which would
        // leave the whole pitch unread.
        cue={
          <a className="label-caps landing-cue" href="#landing-pitch">
            WHAT IS THIS? <span aria-hidden="true">▼</span>
          </a>
        }
      />

      <section className="landing-panel" id="landing-pitch">
        <span className="label-caps landing-no">I · THE BRIDGE</span>
        <h2 className="landing-title">A small club, completely free.</h2>
        <p className="landing-copy">
          <GlossaryProse
            text="Nickel Bridge is a club for learning bridge by playing it. You sit South, always. Your partner is a robot of even temper; your opponents, two more."
            {...LANDING_LINKS}
          />
        </p>
        <p className="landing-copy">
          <GlossaryProse
            text="The people you’re truly playing came before you, and will come after — each one meeting your same cards at their own pace."
            {...LANDING_LINKS}
          />
        </p>
        <p className="landing-aside">
          Named for the 1925 toll bridge over the James River: a dime to cross, then a nickel, now fifty cents.
        </p>
      </section>

      <section className="landing-panel">
        <span className="label-caps landing-no">II · THE LEDGER</span>
        <h2 className="landing-title">Everyone plays the same deals.</h2>
        <SpecimenField className="landing-specimen" />
        <p className="landing-copy">
          <GlossaryProse
            text="Bad cards are no excuse here — Margaret holds the same ones as you, whenever she gets around to them. You’re scored on what you did with the deal, against everyone who held it."
            {...LANDING_LINKS}
          />
        </p>
        <p className="landing-copy">
          {/* "the game" is bridge itself here, not the scoring term */}
          <GlossaryProse
            text="That’s duplicate: the luck is dealt out of the game, and judgment is what’s left."
            {...LANDING_LINKS}
            skip={['game']}
          />
        </p>
      </section>

      <section className="landing-panel">
        <span className="label-caps landing-no">III · THE TOLLKEEPER</span>
        <h2 className="landing-title">Read the bid before you make it.</h2>
        <p className="landing-copy">
          <GlossaryProse
            text="Tap any call and the house tells you what it promises — the point range, the shape, whether it’s conventional — before you commit to anything. The robots’ calls explain themselves the same way. And once you do commit, your bid is graded against the one the house would have chosen."
            {...LANDING_LINKS}
          />
        </p>
        <PerforatedPanel heading="YOUR BIDDING — BOARD Nº1" className="landing-grade">
          <div className="landing-grade-row">
            <b className="landing-grade-call">
              <CallText call={DEMO_CALL} />
            </b>
            <StarGrade stars={3} />
            <span>Excellent — the robot’s choice too</span>
          </div>
          <p className="landing-grade-meaning">
            <GlossaryProse text="15–17 HCP, balanced. No five-card major." {...LANDING_LINKS} />
          </p>
        </PerforatedPanel>
      </section>

      <section className="landing-panel">
        <span className="label-caps landing-no">IV · THE RECORD</span>
        <h2 className="landing-title">Boards are tickets. Playing is paying the toll.</h2>
        <div className="landing-motifs">
          {/* 200, matching the tour's own stub: the stub's height scales with
              its width, and "ADMIT ONE" runs out of rotated edge below that */}
          <TicketStub label="BOARD" value="Nº2" edgeText="ADMIT ONE" width={200} />
          <InkStamp rotate={-6}>SCORED</InkStamp>
        </div>
        <p className="landing-copy">
          <GlossaryProse
            text="Every board prints a receipt — the score itemized line by line, overtricks and insult and all — and then shows you what the rest of the field did with the same cards. Results are cancelled with a postmark, wins and losses alike, and the ledger of crossings keeps your running rating."
            {...LANDING_LINKS}
          />
        </p>
      </section>

      <section className="landing-panel landing-doors">
        <span className="label-caps landing-no">V · BEFORE YOU SIGN ANYTHING</span>
        <h2 className="landing-title">The ledger is open to anyone.</h2>
        <p className="landing-copy">
          <GlossaryProse
            text="So is the practice board. Walk one deal with the tollkeeper — bid it, play it, read the receipt. No account needed, and the tollkeeper keeps no record of practice boards."
            {...LANDING_LINKS}
          />
        </p>
        <div className="landing-door-actions">
          <Button to="/tour">WALK A PRACTICE DEAL →</Button>
          <Button variant="secondary" to="/glossary">
            THE GLOSSARY — {TERMS.length} TERMS
          </Button>
          <Button variant="secondary" to="/leaderboard">
            THE FIELD — WHO’S CROSSED
          </Button>
        </div>
      </section>

      <footer className="landing-foot">
        <BridgeMark variant="footer" width={180} />
        <p className="landing-aside">When you’re ready, the gate is here.</p>
        {/* A distinct label, not just for variety: two buttons reading
            "PLAY THE TOLL →" on one page are two things a screen reader (and
            every test that reaches for one by name) cannot tell apart. */}
        <div className="landing-foot-cta">
          <SignInActions label="CROSS THE BRIDGE →" withDevForm={false} />
        </div>
      </footer>
    </div>
  );
}
