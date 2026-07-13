# Nickel Bridge — design moodboard

Companion notes to [`design-brief.md`](design-brief.md), not a second requirements document.
The brief deliberately leaves visual direction to the designer (§2); these are Brannon's own
early creative leads — raw material and starting points to hand over alongside the brief, not
mandates. Anything here can be overridden by the designer's judgment.

## Core aesthetic: black etching on white

- **Light only — no dark mode.** Simplifies the brief's open "dark-surface contrast problem"
  (§8/§9) down to one concrete task: the current dark green felt table needs a light
  equivalent, not a second theme. Whatever replaces it must keep card faces and suit colors
  legible on a light ground.
- **Flat white or plain off-white ground — no texture.** Not aged paper, not sepia, no
  torn/distressed edges, no paper grain. The vintage feeling should come from the *linework
  style and typography*, not from a texture effect layered on top.
- **Etching/engraving-quality black linework** (steel-engraving, banknote-vignette style: fine
  crosshatch and stipple, no flat color fills) for illustration and motif elements — bridge
  vignette, coin medallion, toll imagery, Art Deco geometric flourishes. Reserve the finest
  detail for brand/marketing surfaces (logo, login screen, OG image, empty states); keep
  dense gameplay UI (bid box, auction grid) in bold, clean shapes — fine engraving detail
  turns to mush at small interactive sizes.
- **Suits are the only color anywhere.** Black linework + white ground + the four suit colors
  is the entire palette. This makes suit color the app's whole accent system rather than a
  decorative afterthought, and reinforces the existing accessibility requirement that glyph
  shape (not color) carries suit meaning (§8) — color is a bonus layer on top.
- **Foundational work this implies for the designer:** validate the four suit colors for
  WCAG AA contrast against a *light* ground — they were presumably tuned against the current
  dark table, so this needs redoing, not assuming.

## Bridge and toll imagery — stands on its own

- **Do not build suit pips into truss/trestle members.** Keep architectural depictions (truss
  bridges, toll gates, coins) as their own standalone Art Deco illustrations, separate from
  the card/suit system. The two visual languages (cards vs. bridge/toll iconography) sit side
  by side rather than fused into one symbol.
- **Logo directions to sketch:**
  1. **Coin medallion** — circular badge like a nickel, engraved bridge truss inside, wordmark
     around the rim like coin lettering. Leans into the "nickel" half of the name.
  2. **Wordmark-first, vignette-second** — a clean Art Deco wordmark as the actual logo/favicon
     (reduces safely to 16px), with a full etched bridge vignette reserved for login/OG-image/
     marketing surfaces only. Safest choice given the brief's favicon/app-icon requirement (§4).
  3. **Abstract truss pattern** — the triangular geometry of a truss bridge used as a standalone
     background texture, divider, or card-back pattern — decorative infrastructure motif, not
     merged with suit symbols.
- **Reference note:** the real Boulevard Bridge is a fairly plain riveted steel truss/girder
  bridge, not a dramatic silhouette. Period-accurate steel-truss/arch cousins like Hell Gate
  Bridge (1916) or the early George Washington Bridge (1927–31) are closer visual references
  if the designer wants authentic 1920s bridge engineering imagery rather than the real
  (visually modest) local bridge.

## Toll vocabulary

Tolls give the identity a functional idea, not just imagery — a toll is about *passage*
(pay → gate opens → cross), which maps onto real app flow (bid → play → result, board 1→4,
in-progress → complete). Pick one or two signature moments rather than tollbooths everywhere;
avoid stacking this with the coin-medallion and truss-pattern logo ideas so the identity
doesn't compete with itself.

- **Gate-arm raise as the loading/transition motif** — a small striped tollgate arm lifting in
  place of a generic spinner, for "Robots are thinking…", "Finding a table…", and phase
  transitions on the Board screen. Brief, non-blocking — consistent with the brief's motion
  rule that game state must never be obscured (§3).
- **Ticket stub as the board counter** — "Board 2/4" rendered as a stub (number, maybe a
  stamped date), reused across Lobby progress, the Tournament screen, and the Board header
  (§5.8). Perforation should be a clean vector edge, not a distressed/torn-paper effect.
- **Ink-stamp seal for completion states** — a crisp black stamp-style treatment (not
  weathered or grungy) for the existing continue-vs-live status badge (§5.4) and completed
  boards/tournaments generally.
- **Turnstile/odometer flip-digits for numeric displays** — mechanical turnstile-counter or
  gas-pump digit styling for Elo, HCP, and matchpoint %. Solves a real requirement already
  flagged (tabular numerals matter throughout, §7) while reading as "toll machinery" rather
  than a generic stat font.
- **Perforated-edge panel treatment** — a ticket-stub perforated edge instead of a plain
  rounded rectangle for the base card/panel container (§6). Useful because "card" is already
  an overloaded term in this app (playing cards exist) — this sidesteps that collision. Clean
  vector perforation, not a distressed edge.
- **Handle with care near the entry point:** any coin/toll imagery near login or the Play CTA
  risks implying the app costs money, which fights the fact that it's free. Keep toll cues
  restrained in those spots.
- **Copy-level lead, not just visual:** the toll's own history (dime → nickel in 1957 → 50¢
  today, per the brief's naming story) is good microcopy material — worth passing to whoever
  writes empty-state/onboarding copy, not just the visual designer.

## Typography leads

- Art Deco display face for the wordmark/logo only (1925 is peak Deco).
- A period-flavored workhorse serif/slab (Cheltenham/Century/Clarendon-era feel) for body and
  headers — must stay legible at small mobile sizes and be self-hostable, per the brief's
  "no webfont today, keep it lightweight if adding one" constraint (§3).
- Push for true tabular lining numerals in the body face — Elo, percentages, and scores appear
  in dense tables throughout (§7) and need to align.

## Two-tier density rule

Reiterating because it governs where every idea above is allowed to apply: fine etching
detail, perforated edges, and stamp treatments belong on **brand/marketing surfaces** (login,
logo, OG image, empty states, result-screen flourishes). The **dense gameplay UI** — the
38-target bid box, the auction grid, the meaning panel — should stay bold, high-contrast, and
uncluttered. Applying the etched aesthetic literally to the bid box would fight the brief's
touch-target and legibility requirements (§3, §8).

## Open questions for the designer

- Chart palette (three Recharts trend lines, §5.7) has no defined color story yet — grayscale
  with one accent, or borrowed suit colors (e.g., rating in ♠ black, bidding accuracy in
  ♦ orange, scores in ♥ red)?
- What replaces the dark green felt table under a light-only palette, while keeping the trick
  area, dummy hand, and suit colors legible?
- How much Art Deco geometric ornament (chevrons, sunbursts) is additive vs. clutter once the
  etching + toll vocabulary are both in play — these notes offer more motifs than should
  probably all ship at once.

## Research leads

- Steel/copperplate banknote-engraving technique (literally how nickels and period currency
  were rendered) — the clearest reference for black-on-white etching linework.
- Hell Gate Bridge (1916) / early George Washington Bridge (1927–31) for period-accurate steel
  truss and arch imagery.
- Art Deco geometric ornament and display typography of the mid-1920s.
- [Boulevard Bridge, Wikipedia](https://en.wikipedia.org/wiki/Boulevard_Bridge) — already
  linked from `design-brief.md`, for the real bridge's structure and toll history.
