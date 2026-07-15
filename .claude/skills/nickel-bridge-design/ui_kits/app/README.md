# Nickel Bridge — mobile app UI kit
Faithful recreations of the approved screens (Explorations turn 4 + board screens 1p–1r + the 7a splash intro), composed from the design-system components.

- screens1.jsx — HomeScreen (gate + tolls-paid ledger, merged with the former Tourneys view), RankingsScreen, StatsScreen (tab-level)
- screens2.jsx — TournamentSheetScreen, CallInspectorScreen, TournamentResultScreen, SplashIntro
- screens3.jsx — BoardBiddingScreen, BoardPlayScreen, BoardResultScreen (board screens; Limelight header normalized to the locked Poiret One wordmark)
- index.html — interactive click-through: intro animation → Home → tab bar / CTAs navigate; screen chips below jump anywhere.

Screens are 390px wide on --paper. Do not invent new layouts here; extend by copying an existing screen's structure.