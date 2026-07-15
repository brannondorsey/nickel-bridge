# Redesign screenshots

The shipped toll-bridge ticket redesign, screen by screen — the "after" to
[`../images/`](../images/README.md)'s "before". Captured by
[`scripts/ui-check.mjs`](../../scripts/ui-check.mjs) at the brief's phone-portrait
reference size (390×844) from a live local instance (`DEV_AUTH=1`), not mockups.
Regenerate any time with:

```bash
npm run build
DEV_AUTH=1 DB_PATH=/tmp/uicheck.db PORT=3997 node server/dist/index.js &
node scripts/ui-check.mjs http://localhost:3997 docs/images-redesign
```

| File | Screen (brief §) | State |
| --- | --- | --- |
| `01-login-splash.png` | Login (§5.1) | The splash doubles as login — dev sign-in variant |
| `02-create-handle.png` | Create handle (§5.2) | Fresh, empty input |
| `03-splash-intro.png` | Splash intro | First authenticated visit, mid-animation |
| `04-home-fresh.png` | Home (§5.4) | Fresh account — PLAY THE TOLL, no tolls paid |
| `05-bidding.png` | Board / Bidding (§5.8A) | Auction, meaning placeholder, hand, bid box |
| `06-call-inspector.png` | Board / Bidding (§5.8A) | Past call inspected in the bottom sheet |
| `07-meaning-preview.png` | Board / Bidding (§5.8A) | Bid selected — meaning shown *before* commit |
| `08-grade-toast.png` | Board / Bidding (§5.8A) | Star-stamped grade toast after confirming |
| `09-play.png` | Board / Card play (§5.8B) | Dummy fan, follow-suit line, trick compass |
| `10-card-selected.png` | Board / Card play (§5.8B) | Card raised, tap-again-to-play hint |
| `11-board-result.png` | Board / Result (§5.8C) | Contract hero, field, deal diagram, recap |
| `12-tournament-result.png` | Tournament result (§5.5) | TOLL PAID postmark, board-by-board |
| `13-tournament-sheet.png` | Tournament sheet (§5.5) | All four boards scored, reviewable |
| `14-rankings.png` | Rankings (§5.6) | The field with movement glyphs |
| `15-stats.png` | Stats (§5.7) | Populated: sparklines, grades, tiles (full page) |
| `16-home-tolls-paid.png` | Home (§5.4) | A finished crossing in the TOLLS PAID ledger |
| `17-desktop-home.png` | App shell (§5.3) | Desktop viewport — centered phone column |
