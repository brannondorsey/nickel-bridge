# Analyze — design record

**Status: implemented (2026-08-03).** The Analyze feature (the post-board review at
`/t/:tid/b/:no/analyze`) shipped from a two-stage design process; this file is the record of
how the direction was chosen. The product spec — the two-engine verdict model (double-dummy
cost, sampled-DD findability), the matchpoint arithmetic, the constants, and the copy deck —
was written first and is summarized in CONTRIBUTING.md's "Analyze" section; the verdict
reasoning lives as doc comments in `server/src/analyze.ts`.

## The exploration

[analyze-concepts.html](analyze-concepts.html) is the concept-exploration board (the same
format as [onboarding-concepts.html](onboarding-concepts.html)): three directions differing on
how the reading arrives, each mocked at 390×844 in real design-system components over one
worked board —

- **Concept A — The Auditor's Ledger** (*read it*): one printed, scrolling audit; moments
  ledger, deepened auction, and the play as a static trick-by-trick table. Cheapest; no
  motion.
- **Concept B — The Second Crossing** (*walk it*): the moments ledger as a hub, each row
  opening a full replay of the play over the real board UI (TrickArea/HandFan, all hands
  open) under an unvoiced "audit ribbon", with a step dock. The only form where a beginner
  *watches* the hand again.
- **Concept C — Where It Turned, In Place** (*jump to it*): no new route — the moments panel
  on the Result itself, each moment a bottom sheet with the frozen position and the two
  cards side by side.

The board's closing recommendation was a staged composite (A as the spine wearing C's moment
treatment, B deferred); **the owner chose Concept B outright**, with two sub-decisions drawn
in the mocks:

- costly-but-unfindable moments carry an **EXCUSED ink stamp** (a stamp rules *for* you where
  a grade rates you); charged moments keep the StarGrade vocabulary — this settles the spec's
  open question about the verdict mark;
- **NEXT BOARD keeps the Result's primary slot**; `ANALYZE PLAY →` is the secondary action
  (the CTA copy was revised from the spec's "WALK IT BACK" at review);
- **MP figures render only inside the Analyze screen** — the Result, the Tournament ledger
  and the live board carry the entry action and nothing else.

## What shipped

Concept B as drawn, with A's static trick list as the play lens's reduced-motion rendering
(the two concepts were always the same lens at different motion settings — the mockups' own
argument for the composite). The replay driver was extracted from the first-crossing tour
(`web/src/replay/useReplay.ts`), which had already proven the shape; `Board.tsx`'s `Result`
gained an actions slot, dissolving the tour's class-for-class `TourResult` copy on the way.
The demo gallery's `analyze-play` exhibit (`server/src/scenarios.ts`) is the click-test path.

## The Cards Were Worth (round-four redesign)

Click-testing found the overview's par panel unreadable — DDS's raw `3D*-EW-1` notation, an
unexplained score sign, field contracts without results, no YOU anchor. A second concept
board, [analyze-cards-worth.html](analyze-cards-worth.html), explored four treatments: a
plain-words ledger (A), the field on a score rail with par as a dashed gate (B), par and
your table as paired receipts (C), and their composite (D, "The Receipt and the Rail") —
C's receipts over B's rail, each shedding the half the other does better. The owner chose
**D**, hoisted above the moments ledger so "was this board winnable" frames the verdicts.
The rail's geometry (`web/src/pages/analyzeRail.ts`) is linear with a minimum-gap
relaxation rather than the considered symlog axis: measured on a game-cluster field
({−1100, 620, 650}), symlog *halved* the readable 620–650 gap, compressing exactly the
differences the rail exists to show, while helping only fields that cluster near zero.
