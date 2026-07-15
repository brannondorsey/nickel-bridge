# Nickel Bridge Design System

Nickel Bridge is a duplicate-bridge (card game) app — SAYC bidding, small nightly tournaments, an AI field. The brand metaphor: a 1920s toll bridge. Boards are tickets, playing is "paying the toll", results get cancelled with a postmark, rankings are the ledger of crossings. Voice is warm, period-inflected, second person ("Good evening, Margaret", "The bridge is open.").

Sources: this system was distilled from two exploration documents in this project — `Nickel Bridge Brand.dc.html` (marks, splash, intro animation) and `Nickel Bridge Explorations.dc.html` (foundations, toll vocabulary, all app screens). Approved options: 1e type pairing, 1h surface, 1k/1m/1n vocabulary, 3b postmark, 6c splash + 7a intro animation, all turn-4 screens, and board screens 1p/1q/1r.

## CONTENT FUNDAMENTALS
- Second person, warm, unhurried: "Good evening, Margaret", "The bridge is open.", "one crossing at a time".
- Toll vocabulary is used consistently: PLAY THE TOLL, CONTINUE THE CROSSING, TOLLS PAID, PREVIOUS CROSSINGS, AT THE GATE, "54 players crossed this week".
- Labels are tracked caps in Besley: `PREVIOUS CROSSINGS`, `NICKEL RATING`, `THE FIELD — BOARD 2`.
- Buttons are loud tracked caps with a trailing arrow: `CONTINUE THE CROSSING →`, `BID 2♥ →`.
- Bridge (game) terminology is precise and unabbreviated in body copy; scores use tabular figures: `62% · +630`.
- Italic Crimson for asides and hints: "Sealed — deals when board 2 is scored", "Q♠ selected — tap again to play".
- No emoji. Suit glyphs (♠♥♦♣) and typographic marks (· — → ▲ ▼ ★ №) are the only "icons" in text.
- Period flavor is allowed in fictional dates/stamps ("JUL 13 1926", "RICHMOND · 1925") but never in functional copy.

## VISUAL FOUNDATIONS
- **Palette**: ink #141414 on paper #FCFBF8; white panels; warm grays (#F1EFE9 inset surface, #D8D5CE lines, #E4E1D8 hairlines, #B9B4A9 dashed "sealed" borders, #6E6A62 muted text). Only color: the suit signal triad — ♥ #C22F21, ♦ #9E6A00, ♣ #00775A (matched oklch lightness/chroma; all AA on white) — plus verdigris #6F8F68 reserved for the bridge marks. Red doubles as accent/negative, green as positive. Max ink, minimum color.
- **Type**: Poiret One = wordmark ONLY (tracked .14em caps). Crimson Pro = body/titles (runs small: +1px sizes, weight 600 for UI text). Besley = labels (700, tracked caps, 9.5–12px), numerals (800, tabular), buttons, ticket text. Josefin Sans = ink stamps and postmark ONLY. Limelight appears in pre-lock explorations; do not use.
- **Surfaces**: flat, printed-paper feel. No gradients, no texture, almost no shadow. Cards/panels are white with 1px ink structural borders; the inset surface (#F1EFE9 + #D8D5CE border) holds calls-to-action. Live/active ticket gets a hard offset shadow `3px 3px 0 rgba(20,20,20,.12)`. Playing cards get the only soft shadow `0 1px 2px rgba(0,0,0,.14)`.
- **Corners**: Deco stays square. Panels 0; buttons 2px; chips 3px; playing cards 3–4px.
- **Rules**: 1px #D8D5CE quiet · 1px #141414 structural · double 1px+1px ink frame = "the table" · 1.5px dashed ink = perforation · dashed #B9B4A9 = sealed/unavailable.
- **Toll vocabulary (the motif system)**: ticket stubs with dashed perforation + rotated ADMIT ONE (counters, tournament rows); flip-digit numerals (hero numbers only: MP%, rating); perforated panel edge (ledgers, field tables); ink stamps — oval Josefin stamps with rotation + ink-fade mask for statuses (LIVE red, SCORED ink), the circular postmark + wave cancel for results only.
- **Charts**: grayscale ink lines on #EDEBE4 tracks, one accent (#C22F21 dashed reference line). Bars are square-cornered ink fills.
- **Animation**: the intro sequence (bridge rises → splash lifts → Home arrives) uses .55–.9s cubic-bezier(.2,.7,.2,1) rises and ease-in exits. In-app motion is minimal; no bounces, no spinners.
- **Hover/press**: not yet specified in explorations — keep to opacity/underline until defined.
- **Imagery**: no photography. The only illustration is the bridge linework (glyph, footer span, river scene) in verdigris + ink.

## ICONOGRAPHY & MARKS
No icon font, no icon set. Iconography = suit glyphs, typographic marks, and the bridge linework. Never introduce a third-party icon set.
Two marks, both in `assets/`:
- **bridge-glyph.svg** (single verdigris span) — the workhorse mark: app header, inline notes. Sits left of the Poiret One wordmark at ~26×20.
- **bridge-river-scene.svg** + **bridge-footer.svg** — the splash/intro scene (640×240 river vignette) and the multi-span footer used as a screen-bottom colophon. Splash-surface only.
Usage: glyph for chrome; scene/footer for brand moments (splash, intro, empty states). The circular postmark is a component (`Postmark`), not a logo.

## INDEX
- `styles.css` → `tokens/` (colors, typography, spacing)
- `assets/` — bridge-glyph.svg, bridge-footer.svg, bridge-river-scene.svg
- `guidelines/` — foundation specimen cards
- `components/brand/` — TicketStub, FlipDigits, Postmark, InkStamp, PerforatedPanel, BridgeMark
- `components/core/` — Button, Chip, Input, Select, Checkbox, Radio, Switch, Dialog, Toast
- `components/navigation/` — AppHeader, TabBar
- `components/game/` — PlayingCard, StarGrade
- `ui_kits/app/` — Splash/intro, Home, Tourneys, Tournament sheet, Call inspector, Tournament result, Stats, Rankings, Board (bidding / card play / board result)
- `uploads/` — bridge reference photographs from the brand explorations (downsized to 800px). **Inspiration only**: mood, era, linework, and palette reference for designers. The "no photography" rule under Imagery stands — these never appear in the product or in mocks.

## PRODUCTION MAPPING
This skill's JSX is for prototyping only — **never copy skill components into `web/`**; their props differ from production (skill components take `style`/`padding`; production ones don't) and copying forks the design system. For production work the source of truth is `web/src/components/ds/` (plus `web/src/components/game/` for gameplay pieces), styled entirely from `web/src/style.css` — extend those, and port any *new* styles into `style.css`.

| Skill component | Production component | Root CSS class |
| --- | --- | --- |
| `brand/TicketStub` | `ds/TicketStub.tsx` | `.ticket-stub` |
| `brand/FlipDigits` | `ds/FlipDigits.tsx` | `.flipdigits` / `.flipdigit` |
| `brand/Postmark` | `ds/Postmark.tsx` | `.postmark` |
| `brand/InkStamp` | `ds/InkStamp.tsx` | `.ink-stamp` |
| `brand/PerforatedPanel` | `ds/PerforatedPanel.tsx` | `.perf-panel` |
| `brand/BridgeMark` | `ds/BridgeMark.tsx` | inline SVG (wordmark text: `.wordmark`) |
| `core/Button` | `ds/Button.tsx` | `.ds-btn` (`.ds-btn-secondary`) |
| `core/Chip` | `ds/Chip.tsx` | `.chip` (`.chip-quiet`, `.chip-colored`) |
| `core/Input` | `ds/Input.tsx` | `.ds-input` (label: `.label-caps`) |
| `core/Dialog` | `ds/Dialog.tsx` | `.sheet` (bottom sheet: `.sheet-layer`, `.sheet-scrim`) |
| `core/Toast` | `ds/Toast.tsx` | `.toast` |
| `core/Select` / `Checkbox` / `Radio` / `Switch` | none yet — port styles into `style.css` when first needed | — |
| `navigation/AppHeader` | `ds/AppHeader.tsx` | `.appheader` |
| `navigation/TabBar` | `ds/TabBar.tsx` | `.tabbar` |
| `game/PlayingCard` | `game/PlayingCard.tsx` | `.pcard` |
| `game/StarGrade` | `ds/StarGrade.tsx` | `.stargrade` |

Production also has pieces with no skill counterpart (`HcpBadge`, `PctBar`, `Sparkline`, `Loading`) — they follow the same rules; check `ds/` before assuming something doesn't exist.

## EXTENDING THE SYSTEM
For a screen with precedent, copy the closest `ui_kits/app/` screen and modify — don't invent new layouts. For content with no precedent, pick the motif by content type, then compose from existing pieces:
- **Hero number** (the one number the screen is about: MP%, rating) → FlipDigits, Besley 800 tabular. At most one per screen.
- **Ledger / itemized rows** (standings, money, score breakdowns) → PerforatedPanel; `.label-caps` Besley column heads, tabular numerals right-aligned; a total row separates with a 1px structural ink rule and weight 800. No dot leaders — whitespace and alignment do the work.
- **Status** (live, scored) → InkStamp: LIVE red, SCORED ink. Sealed/unavailable is *not* a stamp — it's the dashed `#B9B4A9` border treatment.
- **Result / completion moment** → Postmark + wave cancel, result screens only.
- **Counter / admission token** (board number, entry) → TicketStub.
- **Aside, hint, or explanation** → italic Crimson Pro in muted `#6E6A62`.
New vocabulary must stay inside the toll metaphor (receipts, ledgers, gates, crossings) and be plausible for a 1926 toll office; introduce new terms sparingly and reuse them consistently once coined.

## Intentional additions
- `core/` fill-ins (Input, Select, Checkbox, Radio, Switch, Dialog, Toast) were not in the explorations; styled to match (square, ink borders, Besley labels) per user request.
- Board screens 1p–1r predate the type lock; their Limelight header was normalized to the locked Poiret One app header. Everything else kept verbatim.

## Caveats
- Fonts are Google-hosted via @import (Poiret One, Crimson Pro, Besley, Josefin Sans) — no local binaries.
- Hover/press states are provisional (see Visual Foundations).
