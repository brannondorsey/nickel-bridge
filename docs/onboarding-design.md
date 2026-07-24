# The First Crossing — new-user onboarding design

**Status: implemented** — see CONTRIBUTING.md "The first crossing" for the shipped
architecture (`web/src/onboarding/`, `web/src/pages/Tour.tsx`, `tools/gen_tour_board.mjs`).
Three deliberate deltas from the spec below, all by product decision during implementation:

1. **The difficulty gate (⑤) was dropped** — the tour ends straight at PLAY THE TOLL and
   the difficulty preference keeps its server default; a settings UI remains future work.
2. **Board №0 is an offline engine capture, not a per-user exhibit tournament** (§5's
   plan): `tools/gen_tour_board.mjs` drives the real engine once — model-argmax human
   calls, DD play, real meanings/grades, the benchmark personas genuinely playing the same
   deal for the field — and the tour replays the captured views through Board.tsx's own
   exported phases. Same honesty guarantees, no server state, no per-signup compute.
3. **The mined line beat the sketched one:** seed `crossing-43` opens 1NT, partner's 2♥ is
   a **Jacoby transfer** — an *artificial* call, a sharper "bids are a code" lesson than
   the sketched limit raise — and South corrects partner's 3NT to 4♠ on the eight-card
   fit, making exactly. The pamphlet reference page (§ "left behind") is not yet built.
4. **Concept A's pamphlet opens the tour** (added on review): the cover ("So you've come
   to cross.") plus panels I · THE BRIDGE and II · THE LEDGER precede the practice-board
   offer, replacing the booth-gate screen — the philosophy copy carried the concept
   exploration and now leads the shipped flow.

The rest of this document is the original spec, kept as the design record. It was
developed from a three-concept exploration (`onboarding-concepts.html` — pamphlet /
practice board / tollkeeper conversation); the direction chosen is the hybrid recommended
there: **a guided practice deal as the spine, narrated by the tollkeeper**.
`onboarding-prototype.html` is the pre-implementation clickable prototype — the shipped
tour supersedes it (it renders real components; the prototype only imitated them).

Everything here follows the design system (`.claude/skills/nickel-bridge-design/readme.md`):
ink on paper, Besley labels, Crimson body, italic asides, toll vocabulary, no emoji. All
copy in this spec is proposed-final and lives in the copy deck at the bottom.

## 1. Goals and principles

The tour must teach three things, hardest first:

1. **Duplicate** — everyone plays the *same four deals*; results are matchpointed against
   everyone who held your cards; luck is dealt out of the game. This is the app's thesis
   and the least familiar idea to a newcomer.
2. **The teaching loop** — bid meanings are shown *before* you commit (two-step commit),
   every call is graded after, and the meanings are always one tap away.
3. **The philosophy** — a small, unhurried club of friends; one crossing at a time;
   judgment over luck; robots of even temper.

Principles:

- **Worth taking means doing, not reading.** The player bids a real bid, sees a real
  meaning, earns a real grade, plays real tricks, and reads a real ledger. Exposition is
  narration over action, never a slideshow about the action.
- **Skippable honestly, in-world, at every step.** "I know the way — let me through" at the
  gate; "Straight to the gate" on the offer. Skipping is never punished and never nagged.
  The one thing even skippers pass through is the single-screen difficulty gate (it has
  functional value and costs one tap).
- **Short.** Under three minutes end to end; the gate promises this out loud.
- **Nothing is at stake.** Board №0 is unscored, unrated, invisible to stats, Elo, and
  friends. The tollkeeper says so ("Never spoken of.").
- **The tour leaves something behind.** A FIRST CROSSING postmark moment, the difficulty
  preference set, and a pamphlet artifact that stays reachable afterward.

## 2. Flow

```
CreateHandle
    │
    ▼
①  THE GATE ─────────── "I know the way" ──────────┐
    │ "First time"                                  │
    ▼                                               │
②  THE OFFER (Board №0 ticket) ── "Straight to     │
    │ "Take the practice board"      the gate" ────┤
    ▼                                               │
③  BOARD №0 — a practice crossing                  │
    │   a. your opening bid (1♠, meaning, commit)   │
    │   b. grade toast (★★★)                        │
    │   c. partner's reply (tap 3♠, read it)        │
    │   d. your rebid (4♠, meaning, commit, toast)  │
    │   e. opening lead & dummy down                │
    │   f. trick 1 — follow suit, two-step play     │
    │   g. trick 2 — draw trumps                    │
    │   h. claim fast-forward ("the rest play       │
    │      themselves")                             │
    │   i. result + THE LEDGER (house field,        │
    │      duplicate taught in place)               │
    ▼                                               │
④  POSTMARK — "FIRST CROSSING"                     │
    ▼                                               ▼
⑤  THE GATE (difficulty) ◄──────────────────────────┘
    │  Obliging / Fair / Ruthless · PLAY THE TOLL →
    ▼
   Real placement (existing api.play()) → board 1 of first tournament
```

Re-entry (after onboarding, forever): a **HOW TO CROSS** pamphlet page — four condensed
panels (the bridge / the toll / the crossing / the ledger) — reachable from the Glossary
screen, with "Walk the practice crossing again" at its foot (mints a fresh Board №0) and
the difficulty options repeated (same POST as the gate).

## 3. Screens

Reference frames: `onboarding-prototype.html` (interactive) — stage names below match its
jump bar. All screens 390×844-first, token-styled (night mode arrives free), touch targets
≥ 44px, no timed content the player can miss (every auto-advance ≤ 3s and purely
decorative; every lesson waits for a tap).

### ① The gate

The tollkeeper's booth: double-ink "table" frame, `AT THE GATE` label, one line of
dialogue — *"Evening, {handle}. First time across this bridge?"* — over the river scene.
Two actions: `FIRST TIME →` (primary) and `I KNOW THE WAY — LET ME THROUGH` (secondary,
jumps to ⑤). Aside under the buttons: "Either way, you'll be at a table in under three
minutes."

The tollkeeper is a *voice*, not a mascot: no illustration, no avatar — just the labeled
ribbon and quoted Crimson italic. They exist at the gate and on Board №0, and are never
heard from again after onboarding.

### ② The offer

A ticket (TicketStub treatment, `ADMIT ONE` sideways): `PRACTICE CROSSING / BOARD №0 /`
*"Not scored. Not rated. Never spoken of."* Body copy sells the two minutes; quiet link
skips to ⑤.

### ③ Board №0 — the practice crossing

The **real Board screen** plus one net-new component: the **tollkeeper ribbon** — an
inset-surface strip (same treatment as the meaning panel) pinned above the game area,
`THE TOLLKEEPER` label, italic narration that swaps per stage. No coach-marks, no modal
overlays, no dimming: guidance is the ribbon plus a pulsing outline (`@keyframes` on
`outline-offset`) on the one suggested control.

Stage-by-stage (deal and line are illustrative — see §4 for how the real ones get mined):

- **a. Opening bid.** Hand fan + HCP badge as in production. Bid box live; the suggested
  call pulses. *Any* bid is tappable and shows its true meaning in the meaning panel —
  exploring is encouraged ("the meanings are always free") — but only the scripted call
  gets an enabled confirm. Off-script selections get the meaning plus a gentle italic
  redirect: "A fine thought — but tonight, follow the tollkeeper: 1♠." This keeps the
  scripted line deterministic without pretending other bids don't exist.
- **b. Grade toast.** The genuine toast: ★★★ EXCELLENT, "1♠ — the AI's choice too."
  Ribbon: "Marked and filed. Every call you make gets marked like this — kindly, and
  always with the reason."
- **c. Partner's reply.** The auction grid appears; partner's 3♠ is dotted-underlined
  (the production tappable-call affordance) and pulsing. Tapping it opens its meaning
  (limit raise). Lesson: the code runs both ways — you can read every call ever made.
- **d. Your rebid.** Same mechanics as (a) with 4♠ suggested; second toast. Auction
  passes out quickly.
- **e. Lead & dummy.** West leads; dummy comes down as a second (mini) fan labeled
  `DUMMY · NORTH — YOURS TO PLAY`. Ribbon explains dummy in two sentences.
- **f–g. Two tricks.** The production two-step (tap to select/raise, tap again to play),
  legal cards vs dimmed, suggested card pulsing. Trick 1 teaches follow-suit and winning;
  trick 2 teaches leading and drawing trumps. Off-script legal cards can be *selected*
  (the helper line acknowledges: "a fair card — but tap the highlighted one tonight") but
  only the scripted card plays, same rationale as bidding.
- **h. Claim.** The production claim banner and fast-forward, narrated: "the rest play
  themselves… the house claims it and fast-plays the tail." Doubles as an introduction to
  a mechanic that genuinely confuses people the first time it fires in a real board.
- **i. Result + ledger.** Receipt (contract, +score, big matchpoint %), then the field
  table pre-populated by the three house personas with their HOUSE tags. This is where
  duplicate is taught, inside the exact component that embodies it. The spread is honest:
  the player lands **second** (The Shark took an overtrick), so the lesson includes
  matchpoints' real texture — "every trick is a horse race" — not a hollow victory lap.

### ④ Postmark

FIRST CROSSING circular postmark + wave cancel, pressed with a 0.5s scale-settle animation
(the one flourish; `prefers-reduced-motion` gets a plain fade). "That's the whole game."
Note: the postmark component is otherwise reserved for result screens — this is a result
screen in spirit, and the *only* non-board surface allowed to use it.

### ⑤ The gate (difficulty)

One question, three option rows (Radio-style tickets), FAIR preselected:

| Label | Backing tier | Copy |
| --- | --- | --- |
| OBLIGING | `beginner` | "New to the game? They'll play kindly." |
| FAIR | `intermediate` (default) | "They'll make you work for it." |
| RUTHLESS | `expert` | "Near-perfect play. Godspeed." |

Aside: "Change it any time. Every player on a given board faces the same robots — fairness
is the house rule." Primary action `PLAY THE TOLL →` submits the preference
(`POST /api/me/difficulty` — **the backend for this exists today with no web UI**; this
screen is its first) and runs the existing placement (`api.play()`), landing on board 1 —
the tour ends *inside the game*, not on a congratulations screen. Quiet footer line points
at the pamphlet.

Skippers arrive here directly; if they dismiss without choosing, the server default
(`intermediate`) simply stands.

## 4. The practice deal — requirements, not the illustrative one

The prototype's deal (S: ♠KQJ93 ♥A82 ♦K74 ♣A2 opposite ♠A752 ♥64 ♦Q862 ♣K953; 1♠–3♠–4♠;
♥Q lead; 10 tricks) is illustrative. The shipped deal must be **mined, not authored**, so
every scripted moment is genuine:

- Find a (seed, board) via `tools/find_scenarios.mjs` + `tools/policy_probe.mjs` where:
  - South opens with a bread-and-butter bid the model itself makes (so the toast honestly
    reads "the AI's choice too" at ★★★ — grading floors at 'good' for SAYC-consistent
    conventions, but №0 deserves the full-marks line);
  - partner's reply has a clean, teachable SAYC meaning worth tapping;
  - South declares a major-suit game (the human must declare — no flip case, no defense,
    on the very first board; those lessons stay in the real game where the existing
    flip banner handles them);
  - the first two tricks have obvious singles-best plays (win the lead, draw trumps);
  - the hand becomes DD-claimable early, so the fast-forward is genuine `advanceRobots`
    claim behavior, not theater.
- The recipe (seed + board + scripted human actions) is checked in like any scenario
  recipe and drift-guarded the same way (`server/test/scenarios.test.ts` pattern) — a
  deliberate robot change breaks it loudly and it gets re-mined (invariant 1 applies).

## 5. Data, persistence, and plumbing

- **Board №0 is an exhibit-kind tournament** minted per user on demand (`kind:
  'exhibit'`, one board), exactly the mechanism demo scenarios use: excluded from
  placement, the lobby, Elo replay, stats, and leaderboard sweeps by the existing filters
  — production-inert today, and this reuses it in production deliberately. Difficulty
  resolves to the schema-default `'perfect'` tier; irrelevant to the player (the line is
  scripted) and maximally deterministic.
- **The house field rows are genuine.** After minting, pre-play the three personas through
  board №0 via `bot-play.ts`'s strategy-injected loop (the `completesTournament` pattern
  from demo scenarios) under their persona seeds. Deterministic per (seed, tier), so every
  new user sees the same honest ledger; cost is ~3 bot boards once per signup, and the
  boards can be played during stages a–h so the ledger is ready by (i).
- **Onboarding state is server-side:** `users.onboarded_at` (NULL = show the tour),
  stamped by `POST /api/me/onboarded` on completing ⑤ *or* skipping into it. Server-side
  because a client flag re-runs the tour on every new device, which is exactly when a
  user least wants it. `GET /api/me` exposes it; `App.tsx` routes
  `authed && handle && !onboarded → Tour` (the same gate position `CreateHandle`
  occupies today).
- **Demo mode:** add a `/scenarios` gallery entry that runs the tour for the Inspector
  persona (house rule: new hard-to-reach UI ⇒ new exhibit). Demo mode otherwise
  suppresses the tour for the shared Inspector the way it suppresses the splash.
- **The pamphlet** is a static client page like the Glossary (no server, no API): four
  condensed panels of the tour's copy, the Attribution-style footer bridge, links to
  re-run №0 and re-set difficulty.

## 6. Motion notes

- Ribbon text swaps: 0.25s fade-through; no sliding walls of text.
- Suggested-control pulse: outline-offset breathing at 1.4s ease-in-out — calm, not neon.
- Toast: the production rise (0.4s `cubic-bezier(.2,.7,.2,1)`); auto-dismisses after
  ~2.5s *and* advances the stage — the toast never blocks input (existing rule).
- Claim fast-forward: reuse `stageClaimSteps`' glide/collect machinery untouched; the
  prototype's counter tick is a placeholder for it.
- Postmark press: scale 1.6→0.97→1 over 0.5s. Under `prefers-reduced-motion`: fades only,
  everywhere.

## 7. Accessibility

- Every lesson is text on screen (the ribbon), never audio, never a timed balloon.
- Auto-advances only follow *completed* player actions and only bridge ≤ 3s of dead time;
  every teaching moment waits indefinitely for its tap.
- The pulse affordance is redundant with the ribbon's words ("tap 1♠") — color/motion is
  never the only signal (existing suit-glyph rule generalized).
- Skip controls are real buttons, screen-reader labeled, first in DOM order on ① and ②.
- Difficulty options are a radiogroup; the whole tour is operable with taps only.

## 8. Build plan

Phase 1 — the frame (small): `users.onboarded_at` + `/api/me` field + `POST
/api/me/onboarded`; Tour route + gate ① / offer ② / gate ⑤ screens; difficulty POST
wiring; pamphlet page; `App.tsx` gating; tests (server: flag + difficulty round-trip; web:
gating renders tour before lobby for a fresh user, never for an onboarded one).

Phase 2 — Board №0 (the real work): mine the deal (§4); mint-on-demand exhibit + persona
pre-play endpoint; the tollkeeper ribbon component; scripted-stage driver on the Board
page (a thin state machine keyed to `boardView` — the server stays a plain
request/response API, per the existing auto-play/claim precedent); recipe drift-guard
test; demo exhibit entry.

Phase 3 — polish: postmark moment, motion pass, night-mode check (tokens should cover it),
copy QA against the design-skill voice specimens, Playwright smoke addition (the tour is
now the first thing a fresh user meets, so `e2e/smoke.spec.ts` must either walk it or
start from an onboarded fixture user).

Also required by house rules when implementing: CLAUDE.md updates (new env-free routes,
repo-map entries, the demo exhibit), and the pamphlet/glossary link.

## 9. Copy deck

All player-facing strings, in order of appearance. Voice: warm, second person,
period-inflected; toll vocabulary; italic = Crimson italic asides.

| Where | Copy |
| --- | --- |
| ① label | `AT THE GATE` |
| ① dialogue | "Evening, {handle}. First time across this bridge?" |
| ① primary / secondary | `FIRST TIME →` / `I KNOW THE WAY — LET ME THROUGH` |
| ① aside | *Either way, you'll be at a table in under three minutes.* |
| ② ticket | `PRACTICE CROSSING` / `BOARD №0` / *Not scored. Not rated. Never spoken of.* |
| ② body | Before your first real crossing, walk one deal with the tollkeeper. You'll bid a hand, play a card or two, and learn to read the ledger. |
| ② aside | *Two minutes, and you'll know the whole shape of the game.* |
| ② primary / skip | `TAKE THE PRACTICE BOARD →` / `Straight to the gate — I've played before` |
| ③a ribbon | Your hand, counted: {n} points — more than enough to open. Tap {bid} and see what it promises. Nothing is final until you confirm. |
| ③a off-script aside | *A fine thought — but tonight, follow the tollkeeper: {bid}.* |
| ③b toast | ★★★ EXCELLENT — {bid} — the AI's choice too. |
| ③b ribbon | Marked and filed. Every call you make gets marked like this — kindly, and always with the reason. |
| ③c ribbon | Now — your partner speaks the same code. That {bid} is underlined; tap it and see what it tells you. |
| ③d ribbon | An invitation, then. With {n} you accept — tap {bid}. (Tap anything else first, if you're curious. The meanings are always free.) |
| ③e ribbon | Three passes — the contract is yours: ten tricks, {suit} trump. West leads, and your partner lays their hand on the table. That's dummy. Tonight, you play both hands. |
| ③f ribbon | Follow suit if you can — {suit} are led, and your ace is good *now*. Tap it once to select, again to play. Deliberate, always. |
| ③f helper | your turn · tap again to play · *a fair card — but tap the highlighted one tonight* |
| ③g ribbon | Yours — one trick down, nine to go. Now pull their trumps before they steal a ruff: dummy's ace can wait, the king brings them down all the same. |
| ③h ribbon | And there it is — the rest play themselves. When a hand is decided beyond doubt, the house claims it and fast-plays the tail. Watch. |
| ③h banner | `CLAIM` — Declarer takes the rest |
| ③i ribbon | You didn't cross alone. Three of the house played this very deal before you — same cards, different choices. Your friends will land in this ledger the same way, whenever they play. |
| ③i aside | *Same deal, four results — the cards were never the difference. The Shark stole an overtrick somewhere; that's matchpoints. Every trick is a horse race.* |
| ④ postmark | `FIRST CROSSING · NICKEL BRIDGE · №0` |
| ④ title/body | That's the whole game. — Bid with meaning. Play with care. Read the ledger. Everything else is practice — which is to say, everything else is the fun part. |
| ④ aside | *The tollkeeper keeps no record of practice boards.* |
| ⑤ title | How do you like your opposition? |
| ⑤ options | `OBLIGING` *New to the game? They'll play kindly.* / `FAIR` *They'll make you work for it.* / `RUTHLESS` *Near-perfect play. Godspeed.* |
| ⑤ aside | *Change it any time. Every player on a given board faces the same robots — fairness is the house rule.* |
| ⑤ primary | `PLAY THE TOLL →` |
| ⑤ footer | `The pamphlet stays at the gate, whenever you want it` |
