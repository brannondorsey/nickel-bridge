# Bridge Bot — visual redesign brief

This is the requirements document for a visual redesign of Bridge Bot. It documents **what**
needs to be designed — every screen, component, state, and constraint — and deliberately does
not say how anything should look. Where the current UI does something a particular way, it's
described as context, not as a mandate; sections marked **requirement** are fixed, everything
else is the designer's call.

Section references like `web/src/pages/Board.tsx` point at the source of truth in this repo,
so claims here can be verified against the running product.

## 1. What the product is

Bridge Bot is a free, self-hostable web app for **learning SAYC bridge bidding** and playing
**four-deal duplicate tournaments with friends — from your phone** ([README](../README.md)).
Each player plays the *same four deals* on their own schedule, seated South with a robot
partner against two robot opponents. Results are matchpointed against friends' results on
identical deals, so the competition is about judgment, not card luck.

**Audience:** bridge learners and small friend groups (a private "club" of people who know
each other). Not a mass-market or commercial product — it's a warm, indie, hobbyist app.

**Product tone:** friendly and learning-first. The app teaches while you play: bid meanings
are shown *before* you commit, every bid you make is graded by an AI, and your high-card
points are always on screen. Competition (matchpoints, Elo rankings) is the motivator, but
the emotional core is "I'm getting better at bridge."

**Reference points:** the current UI is self-described as "NeuralPlay-inspired" (clean green
card table); bid grading is inspired by Tricky Bridge. These are context only — the designer
is free to depart from both.

**Two experiences to design for, one screen:** the Board screen is both live gameplay and,
afterwards, a review artifact players revisit ("My boards → review"). Learning moments
(meanings, grades, recaps) deserve the same care as the game itself.

## 2. Scope and latitude

**Open to the designer:**

- Full visual identity: color, typography, iconography, card faces, illustration, motion.
  The green felt / cream / gold identity and the four-color deck are *not* protected (but see
  §7 on the four-color deck's learning function before discarding it).
- Layout, navigation, and screen composition. Screens may be reorganized, combined, or split;
  navigation may be rethought.
- Net-new brand assets (§4) — there are currently none.

**Fixed requirements:**

- The name **"Bridge Bot"** stays.
- All current **flows and features stay as-is**: the screens in §5, the information each one
  presents, and the interactions each one supports are requirements. Presentation of that
  information is open; the information itself is not.
- Platform posture (§3) and accessibility baseline (§8).

**Out of scope:** new features, changes to game flow or rules, changes to server-driven
content (bid explanations, grades, scores are computed by the backend and arrive as text/data).

## 3. Platform and technical constraints

- **Mobile-first, phone portrait is the primary target.** Design reference: 390×844
  (iPhone-12 class). The automated smoke test runs the entire play loop at this viewport
  (`e2e/smoke.spec.ts`). **Requirement.**
- **Desktop must look reasonable** but needs no separate layout. Today the app is a centered
  single column capped at 560–640px (`web/src/style.css`); the designer may keep that or
  propose wider desktop use — a distinct desktop experience is welcome but not required.
- **Touch targets ≥ 44px** for interactive game elements (current bid buttons enforce this).
  The app currently disables pinch-zoom (`web/index.html` viewport meta), which raises the
  stakes on legibility at small sizes. **Requirement.**
- **No dark mode exists.** Proposing one is a welcome nice-to-have, not required. Note the
  current UI already mixes a dark surface (the green table) with a light page, so any theme
  must handle text/suits on both.
- **Implementation reality** (constrains handoff, not creativity): React SPA with one
  hand-written CSS file — no component library, no design tokens pipeline beyond CSS custom
  properties. Playing cards and suit symbols are **Unicode glyphs styled with CSS**, not
  images (`web/src/components/Cards.tsx`, `web/src/api.ts`). Custom card faces, icons, or
  illustrations are fine to propose; they become new assets to produce (SVG preferred).
  There are currently **no web fonts** (system stack); adding one is acceptable if it's
  self-hostable and lightweight.
- **Charts** are rendered with Recharts (three line charts on the stats page, §5.7) and are
  themeable via CSS variables: line/grid/reference-line colors, tooltip styling.
- **Motion:** currently sparse — a board-flip animation, a loading spinner, a card-raise on
  selection. Motion design is welcome anywhere, with one requirement: game state (whose turn,
  what was played, what the contract is) must never be obscured or delayed by animation.

## 4. Brand assets — all net-new

The app has **zero visual assets today**: no logo (the wordmark is styled text "Bridge**Bot**"),
no favicon, no app icons, no social/OG image, no illustrations, no manifest. The login screen's
only decoration is a row of Unicode suit glyphs ♠♥♣♦. Player avatars are Google profile photos
with a colored-initial fallback.

Assets the redesign should produce:

| Asset | Notes |
| --- | --- |
| Logo / wordmark | "Bridge Bot"; used in the app header and login screen |
| Favicon + app icons | Standard web set (favicon, apple-touch-icon, PWA-ready sizes) |
| Social / OG image | For links shared in group chats — the app spreads friend-to-friend |
| Empty-state / login art | Optional; anywhere the designer wants illustration |
| Card face design | Only if departing from styled-text cards (§6) |

## 5. Screen inventory

Seven screens plus the app shell. For each: purpose, required content, states, and
interactions. "Required content" means the information must be present; its arrangement,
grouping, and emphasis are the designer's.

### 5.1 Login (`web/src/pages/Login.tsx`)

First impression for every invited friend. Unauthenticated users see this on any URL.

- **Content:** app name, one-line pitch (learn SAYC, four-deal duplicate with friends, robot
  partner/opponents, real rankings), primary **Sign in with Google** action.
- **Variant:** in dev/self-hosted-testing mode a name-only input + "Dev sign-in" button also
  appears (either auth option can be independently absent). The design should not fall apart
  when only one is present.
- No navigation chrome on this screen.

### 5.2 Create handle (`web/src/pages/CreateHandle.tsx`)

One-time interstitial after first sign-in, before entering the app.

- **Content:** prompt to choose a handle, explanation ("the name your friends will see
  everywhere — leaderboard, standings, and stats"), text input (up to 24 characters),
  Continue button with busy state ("Saving…"), inline error message state (e.g. handle taken).

### 5.3 App shell / header (`web/src/App.tsx`)

Wraps every authenticated screen.

- **Content:** wordmark (links home), nav to **My stats** and **Rankings**, **Sign out**.
- **States:** a full-page loading state exists before auth resolves (currently a bare spinner).
- Navigation structure is open — the designer may propose e.g. a tab bar instead of a top bar,
  as long as Lobby (home), own stats, rankings, and sign-out remain reachable.

### 5.4 Lobby (`web/src/pages/Lobby.tsx`)

Home screen; its job is to get the player into a game in one tap.

- **Content:**
  - Greeting ("Hi, {handle}") + one-line explanation of the format.
  - **Primary Play CTA** — the single most important button in the app. It places the player
    into a tournament automatically (they never choose one). Busy state: "Finding a table…".
  - **My tournaments** list: each row shows tournament name, progress ("{n}/4 boards"), the
    player's current total percentage, rank within the field ("#2 of 5"), and a status badge —
    **continue** (boards left to play) vs **live** (finished, standings still evolving because
    tournaments never close). Rows link to the tournament screen.
  - Link to overall rankings.
- **States:** loading; empty ("Nothing yet — hit Play to start your first tournament.").

### 5.5 Tournament (`web/src/pages/Tournament.tsx`)

One tournament's live standings and the player's re-entry point.

- **Content:**
  - Tournament name + note that standings keep evolving as friends play the same deals.
  - **Continue CTA:** "Play board 1" / "Continue — board {n} of 4"; hidden once the player has
    finished all four boards.
  - **Standings table:** rank, player (links to their stats; self shown as "You" and visually
    highlighted), boards done ("3/4"), total matchpoint % with an inline percentage bar.
    Players mid-tournament show no rank and an "(in progress)" tag.
  - **My boards:** links to review each completed board (opens the Board screen in its result
    state, §5.8).
  - Link back to Lobby.
- **States:** loading; error; empty standings ("No completed boards yet.").

### 5.6 Rankings / leaderboard (`web/src/pages/Leaderboard.tsx`)

The club's long-term ladder.

- **Content:** title + one-line Elo explainer ("everyone starts at 1200, re-ranked live");
  ranked rows: position, handle (self as "You"), meta line ("{n} tournaments · {m} rated"),
  Elo number, affordance that the row opens that player's stats.
- **States:** loading. (An empty leaderboard is possible in a brand-new install.)
- **Note:** player avatar URLs are available in the data but currently unused on this screen —
  the designer may incorporate avatars here.

### 5.7 Player stats (`web/src/pages/Player.tsx`)

Progress dashboard; viewable for yourself ("Your stats") and any other player. This is the
"am I getting better?" payoff screen.

- **Content:**
  - Header: avatar (Google photo, or initial-letter fallback), name, "Learning since
    {month year}".
  - **Six stat tiles:** Elo (with peak), Tournaments played (with completed count), Boards
    (with passed-out count), Avg score % ("50% = field average"), Bid accuracy % (with a
    +/- improvement delta "since you started" when enough history exists), Rated tournaments.
  - **Versus the field:** up to three percentile bars — Elo, Score, Bidding — each captioned
    "better than {p}% of {n} players".
  - **Three trend line charts** (Recharts, currently 170px tall):
    1. *Rating* — Elo after each rated tournament, reference line at the 1200 start.
    2. *Bidding accuracy* — % per tournament, 0–100 axis, plus a dashed running-trend overlay.
    3. *Tournament scores* — matchpoint % per tournament, 0–100 axis, reference line at 50
       ("field avg").
    Each chart has a title, a one-line caption, a hover/tap tooltip (value, tournament name,
    date), and a no-data fallback ("Play more tournaments to see a trend here.").
  - **Bid grades distribution:** four labeled bars (Excellent / Good / Fair / Poor) with counts.
  - **Card play record:** one summary line ("Made X of Y contracts declaring · beat A of B
    defending").
- **States:** loading; error ("Player not found."); **empty** (no completed boards — shows a
  "Play your first board" CTA when viewing yourself).

### 5.8 Board — the gameplay screen (`web/src/pages/Board.tsx`)

**The flagship screen; most of the design effort belongs here.** One screen hosts three
sequential phases — bidding, card play, result — plus a persistent header. It is also the
review view for finished boards (players land directly in the result phase from "My boards").

**Persistent board header — requirement in all phases:** tournament name, "Board {n}/4",
dealer seat, **vulnerability** chip (None / NS / EW / All — a bridge-critical fact that
affects scoring decisions), and, during card play, the contract label (e.g. "4♠ by N") with
a running declarer trick count.

**States common to the screen:** loading; error (with a way back to the lobby).

#### Phase A — Bidding

Required elements:

- **Auction history:** a four-column N/E/S/W grid filling in as calls are made, offset so the
  dealer's call sits in the dealer's column. The human's seat (South) is marked. Auctions can
  run long — a dozen-plus rows is possible; the design must handle growth. **Every past call
  is tappable** and opens the meaning panel explaining that bid ("W bid 1♠ — …"); calls with
  a known SAYC meaning are visually distinguished from calls without one.
- **The player's hand:** 13 cards, grouped by suit (spades–hearts–diamonds–clubs, descending
  ranks), with an always-visible **HCP badge** ("12 HCP"). Not interactive during bidding.
- **Bid box** (only on the player's turn): all 35 bids — levels 1–7 × five strains
  (♣ ♦ ♥ ♠ NT) — plus **Pass / X (double) / XX (redouble)**. Illegal calls are visibly
  disabled. **Two-step commit is a requirement** (it's a core learning mechanic): tapping a
  bid *selects* it and shows its meaning; a separate confirm action ("Bid 2♥") submits it.
  Currently a 5-column grid on a ~390px screen — layout is open, but all 38 calls must be
  reachable without scrolling away from the auction context, with ≥44px targets.
- **Bid meaning panel** — the teaching surface. Shows for the selected bid (before
  committing) and for any inspected past bid. Content: call + SAYC title ("Strong 2♣"),
  optional point range ("15–17 HCP"), optional shape promise ("5+ hearts"), a description of
  up to ~200 characters / 2–3 sentences, and sometimes a caveat line ("Beyond the SAYC
  pamphlet — general guidance only."). Two additional states: a placeholder when nothing is
  selected ("Tap a bid to see what it means *before* you make it.") and a no-meaning fallback
  ("No standard SAYC meaning in this sequence — use your judgment.").
- **Grade toast** — feedback after each of the player's bids. Four tiers with star ratings:
  Excellent ★★★ / Good ★★ / Questionable ★ / Poor ✗, plus a comparison sentence: "you bid 2♥;
  the AI prefers 3♥ (72% vs 8%)" or "— the AI's choice too." This is the app's signature
  learning moment; it should feel rewarding, not punitive, and must not block the next action.
- **Waiting state** between turns: "Robots are thinking…" (robot replies are near-instant;
  this appears briefly).

#### Phase B — Card play

Required elements:

- **The trick area:** four seats in compass positions (N/E/S/W) around a center, each showing
  the card that seat played to the current trick; between tricks the last completed trick
  remains visible (labeled as such). Declarer and dummy seats are tagged. A running count is
  always visible: "Declarer {x} · Defense {y}" and the trick number (of 13).
- **Dummy's hand:** revealed after the opening lead, displayed as a second card fan with its
  own HCP badge and a label identifying whose hand it is.
- **The player's hand:** interactive on their turn. **Legal cards must be clearly
  distinguished from illegal ones** (follow-suit rules), and play uses **tap-to-select, tap
  again to play** — same deliberate two-step as bidding, with helper text ("your turn",
  "tap again to play"). The fan shrinks as cards are played (13 → 1).
- **Playing from dummy:** when the human declares, they also play dummy's cards on dummy's
  turn — the *other* fan becomes the interactive one ("your turn — playing from dummy").
  The design must make it obvious which hand is live.
- **The flip case — subtle and important:** the human always bids as South, but when their
  robot partner (North) wins the auction, the human plays the *North* hand and South becomes
  dummy. Currently: the compass rotates 180°, an explanatory banner appears ("Partner won the
  auction — board flipped. You're declaring from North; your South hand is dummy."), and a
  one-time flip animation plays. The mechanism is open, but the design **must make this
  reorientation comprehensible to a learner** — it is the most confusing moment in the app.

#### Phase C — Result

Both the live end-of-board payoff and the later review view.

- **Score summary:** contract + result (e.g. "4♠= by N"), the raw score ("+620 for N-S"), and
  the headline **matchpoint percentage** — the number that matters in duplicate. Below-40%
  results currently get a negative treatment; some differentiation of good vs bad outcomes is
  required. Sub-line: field size ("matchpoints vs 3 other players so far") and the board's
  bidding accuracy %.
- **The field table:** every player who has played this board — name (self highlighted),
  their contract, score, and matchpoint % with an inline bar. This is the duplicate-bridge
  moment ("Alice made 4♠, you went down") — give it weight.
- **Bidding recap:** each of the player's calls with its grade and, where the AI disagreed,
  the AI's preferred call.
- **Actions:** primary "Next board ({n}/4)" (or "Tournament summary" after board 4) and a
  secondary link to the Lobby.
- **Known gap, designer may address:** the backend already sends **all four hands** for
  completed boards (`allHands` in the API), and the README promises a full-deal review, but
  the current UI never displays them. A four-hand deal diagram in the result view is in scope
  if the designer wants it; rendering it would be a small frontend addition.

## 6. Component inventory

Recurring pieces that need a designed treatment (current implementations in
`web/src/components/Cards.tsx` and `web/src/style.css`):

- **Playing card face** — rank + suit, sized ~44–62px wide (fluid). Must handle the two-
  character "10" rank. A **small variant** is used in the trick area.
- **Hand fan** — up to 13 overlapping cards with extra separation between suits; states:
  selected (currently raised), legal vs illegal (currently dimmed), interactive vs static.
  Overlap must leave enough of each card visible to identify and tap it.
- **Buttons** — primary CTA, secondary, busy/disabled states.
- **Card/panel container** — the basic content box used on every screen.
- **Tables and ranked lists** — standings, field results, leaderboard rows; self-row
  highlight; numeric columns (tabular figures matter).
- **Inline percentage bar** — used in four places (standings, field table, percentiles,
  grade distribution).
- **Badges and chips** — vulnerability chip, HCP badge, continue/live status, point-range and
  shape chips inside the meaning panel.
- **Toast / feedback** — the grade toast (four tiers + stars).
- **Notice / banner** — errors, "Robots are thinking…", the board-flip explanation.
- **Loading** — spinner or replacement (skeletons welcome).
- **Empty states** — lobby, standings, stats, charts.
- **Chart style** — line, grid, reference lines (dashed, labeled), trend overlay, tooltip.
- **Avatar** — image + single-initial fallback.
- **Form input** — text field with inline error (login dev field, handle field).

## 7. Content and data constraints

Real content the design must accommodate:

- **The bid box is the densest element in the app:** 38 targets (35 bids + Pass/X/XX) on a
  ~390px-wide screen with ≥44px touch targets, coexisting with the auction and the player's
  hand.
- **Suit symbols appear everywhere at small sizes** — auction cells, bid buttons, meaning
  panel, recap lines, contract labels — and must stay legible and distinguishable.
- **Two suit-color systems exist today** and should be unified deliberately: a four-color
  deck (♠ black, ♥ red, ♦ orange, ♣ green — a learning aid that makes suits instantly
  distinguishable) used in gameplay, and a traditional red/black used in a few decorative
  spots. Keeping or dropping the four-color deck is the designer's call, but it should be a
  conscious decision — color is currently the primary suit differentiator (see §8).
- **Text lengths:** SAYC descriptions up to ~200 characters (2–3 sentences); handles up to
  24 characters (appear in tight table cells); tournament names ("Tournament #12"-style);
  grade-toast sentences ~100 characters.
- **Numbers:** Elo around 1200 (3–4 digits), percentages 0–100, scores from roughly −7600 to
  +7600 (typically 2–4 digits, signed). Tabular numerals in tables and stats.
- **Auction length:** commonly 4–8 calls but can exceed 20; the auction grid grows downward.
- **Field sizes:** clubs are small — standings/leaderboards of 2–15 players are typical.
  Single-player fields happen (you're the first to play a board: "matchpoints vs 0 other
  players").
- **Contract notation** must render: level + strain + result ("4♠= by N", "3NT−2", "6♥x+1"),
  Pass, X, XX, "passed out".

## 8. Accessibility and usability requirements

- **Contrast:** meet WCAG AA for text on all surfaces — including whatever replaces the
  current dark table surface, where suit colors currently need brightened variants.
- **Don't rely on color alone to distinguish suits:** the glyphs (♠♥♦♣) must carry the
  distinction for color-blind players; the four-color deck (if kept) is an enhancement on
  top, not the only signal.
- **Touch targets ≥44px** for all game actions (bids, cards, confirm).
- **Zoom is disabled**, so minimum text sizes must be genuinely readable on a small phone —
  especially auction cells, meaning-panel body text, and table rows.
- Cards already carry screen-reader labels ("ace of spades"); the redesign shouldn't
  introduce components that are image-only with no text equivalent.
- **State clarity is a usability requirement of the game itself:** whose turn it is, which
  hand is live, what the contract is, and vulnerability must be discoverable at a glance at
  every moment of play.

## 9. Deliverables and handoff

Requested from the designer:

1. **Screen designs** for all screens in §5 at phone-portrait size (390×844 reference),
   including every listed state (loading, empty, error, busy) — not just happy paths. The
   Board screen needs all three phases plus the flip case and the waiting state.
2. **A desktop treatment** — at minimum, how the phone layout behaves on a wide window;
   a fuller desktop layout is optional.
3. **Component sheet** covering §6 with all interactive states (default / selected / disabled
   / busy / error).
4. **Foundations:** color palette (with the dark-surface problem solved), type scale, spacing,
   radii — expressible as CSS custom properties.
5. **Brand assets** per §4.
6. **Motion notes** where relevant (card play, grade toast, board flip) — descriptions or
   references are fine; no need for full prototypes.
7. **Format:** Figma (or similar) with exportable assets (SVG preferred for icons/cards).

**Open questions the designer is invited to answer** (proposals welcome, none required):
dark mode; a real desktop layout; using avatars on the leaderboard/standings; custom card-face
art vs styled text; a four-hand deal diagram in the board result (§5.8, data already
available); replacing the text wordmark with a drawn logo.
