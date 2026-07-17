# Design handoff screenshots

Real, rendered UI states from the **pre-redesign** app — the "before" to
[`../images-redesign/`](../images-redesign/README.md)'s "after" — a companion to
[`design-brief.md`](../design-brief.md) and [`design-moodboard.md`](../design-moodboard.md).
Captured at the brief's phone-portrait reference size (390×844, @2x) plus a few desktop
(1440×900) shots; all show live data from a seeded local instance (`DEV_AUTH=1`), not mockups.

| File | Screen (brief §) | State |
| --- | --- | --- |
| `01-login.png` | Login (§5.1) | Google + dev sign-in both present |
| `02-create-handle-empty.png` | Create handle (§5.2) | Fresh, empty input |
| `03-create-handle-error.png` | Create handle (§5.2) | Inline error — handle already taken |
| `04-lobby-empty.png` | Lobby (§5.4) | Empty — before the player's first tournament |
| `05-player-stats-empty.png` | Player stats (§5.7) | Empty — no completed boards, viewing self |
| `06-board-bidding-initial.png` | Board / Bidding (§5.8A) | Auction + hand + bid box, nothing selected |
| `07-board-flip-banner.png` | Board / Card play (§5.8B) | **The flip case** — partner (North) won the auction |
| `08-board-flip-playing.png` | Board / Card play (§5.8B) | Flip case — playing from North, South is dummy |
| `09-board-result-flip.png` | Board / Result (§5.8C) | Result of the flipped board (partner declared) |
| `10-board-bidding-initial-2.png` | Board / Bidding (§5.8A) | Auction with prior calls already in the grid |
| `11-board-bidding-meaning-panel.png` | Board / Bidding (§5.8A) | Bid selected — meaning panel shown *before* commit |
| `12-board-bidding-grade-toast.png` | Board / Bidding (§5.8A) | Grade toast after confirming a bid |
| `13-board-auction-past-call-meaning.png` | Board / Bidding (§5.8A) | Tapped a past auction call to inspect its meaning |
| `14-board-play-trick-area.png` | Board / Card play (§5.8B) | Trick area + dummy hand revealed |
| `15-board-play-card-selected.png` | Board / Card play (§5.8B) | Legal card selected (raised), tap-again-to-play |
| `16-board-result.png` | Board / Result (§5.8C) | Score summary, field table, bidding recap |
| `17-board-play-defending.png` | Board / Card play (§5.8B) | Defending (not declaring) — normal, non-flipped orientation |
| `18-board-result-2.png` | Board / Result (§5.8C) | Result of the defended board |
| `19-tournament-standings.png` | Tournament (§5.5) | Full standings (4 players), "My boards" review links |
| `20-lobby-populated-one.png` | Lobby (§5.4) | One tournament, `live` status badge |
| `21-lobby-populated-two.png` | Lobby (§5.4) | Two tournaments — `live` + `continue` badges together |
| `22-tournament-fresh.png` | Tournament (§5.5) | Unplayed tournament — "Play board 1" CTA, no completed boards |
| `23-leaderboard.png` | Rankings (§5.6) | Populated leaderboard, 4 ranked players |
| `24-player-stats-populated.png` | Player stats (§5.7) | Full stats: tiles, percentiles, trend charts, grade distribution |
| `25-player-stats-other.png` | Player stats (§5.7) | Viewing another player's stats (not self) |
| `26-board-error.png` | Board — error state (§5.8) | Invalid board id, with a way back to the lobby |
| `27-desktop-lobby.png` | Lobby, desktop (§9.2) | 1440×900 — centered-column behavior on a wide window |
| `28-desktop-board-result.png` | Board / Result, desktop (§9.2) | 1440×900 |
| `29-desktop-player-stats.png` | Player stats, desktop (§9.2) | 1440×900 |
| `30-loading-spinner.png` | App shell (§5.3) | Full-page loading state before auth resolves |

## Notes for the designer

- The bidding-demo board (`10`–`15`) and the flip-case board (`07`–`09`) are different boards —
  the flip case only happens when the human's robot partner wins the contract, so it's shown on
  its own board where that occurred naturally.
- "You" (`Designer Demo`) intentionally plays worse than the field (`Riley Chen`, `Sam Okafor`,
  `Scout Rolling`) in this seed data, on purpose — it exercises the low-percentage/negative
  treatment on the result screen (`16`, `18`) and the "Poor" grade tier (`12`).
- Not captured: the "Robots are thinking…" waiting state (robot replies are near-instant, per
  the brief) and a passed-out board. Both exist in the code (`web/src/pages/Board.tsx`) if you
  need a reference beyond these screenshots.
