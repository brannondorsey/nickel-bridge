# README screenshots

The shots the [top-level README](../../README.md) leads with. Captured by
[`scripts/readme-shots.mjs`](../../scripts/readme-shots.mjs) from a live local instance —
phone portrait at the design brief's reference size (390×844) at 2× for retina, except the
desktop one (1280×800).

The sweep plays an *ordinary* tournament (not a demo exhibit), so the chrome in frame is
what a real player sees; it runs against a `DEMO=1` instance only because the seeded ambient
field gives the standings, rankings and stats screens something real to show. It picks its
featured board by asking the bidding model what it would call, so the meaning panel is
showing a decision worth showing and the grade toast is a genuine ★★★.

Regenerate:

```bash
npm run build
DEMO=1 DEV_AUTH=1 DB_PATH=/tmp/shots.db PORT=3997 node server/dist/index.js &
node scripts/readme-shots.mjs http://localhost:3997 docs/screenshots
```

Placement resumes an unfinished tournament, so each run wants a player with no history:
start from a fresh `DB_PATH`, or pass `SHOT_HANDLE=<new name>`. The sweep waits for the
benchmark AI personas to finish the board before shooting anything that shows THE FIELD —
they play in the background, and a sweep that races them shoots a field of one.

| File | Screen | State |
| --- | --- | --- |
| `01-bidding-meaning.png` | Board / Bidding | A call selected, its SAYC meaning read before committing |
| `02-grade-toast.png` | Board / Bidding | The grade toast stamped over the same auction |
| `03-card-play.png` | Board / Card play | Declaring: dummy tabled, a trick on the felt |
| `04-toll-receipt.png` | Board / Result | The toll receipt, printed off the board's last card |
| `05-board-result.png` | Board / Result | Matchpoints, the field, the deal, your bidding (full page) |
| `06-tournament-result.png` | Tournament result | TOLL PAID postmark, board by board, the final field |
| `07-rankings.png` | Rankings | The all-time Elo ladder |
| `08-stats.png` | Stats | Populated: toll log, sparklines, grades (tall frame) |
| `09-glossary-sheet.png` | Glossary | The ledger with a term sheet open over it |
| `10-night-play.png` | Board / Card play | The same position as `03`, in night mode |
| `11-tour.png` | Tour | The first-crossing tour's cover (`/tour`) |
| `12-desktop-home.png` | Home | Desktop viewport — the centered phone column |

Related sweeps: [`../images-redesign/`](../images-redesign/README.md) is the design-review
walk of *every* screen ([`scripts/ui-check.mjs`](../../scripts/ui-check.mjs));
[`../images/`](../images/README.md) is the pre-redesign "before".
