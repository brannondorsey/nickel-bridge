---
name: nickel-bridge-design
description: Use this skill to generate well-branded interfaces and assets for Nickel Bridge (1920s toll-bridge themed duplicate-bridge app), either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping.
user-invocable: true
---

Read the README.md file within this skill, and explore the other available files.
If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets out and create static HTML files for the user to view. If working on production code, you can copy assets and read the rules here to become an expert in designing with this brand.
If the user invokes this skill without any other guidance, ask them what they want to build or design, ask some questions, and act as an expert designer who outputs HTML artifacts _or_ production code, depending on the need.

## Reading map

- **Always**: `readme.md` — the brand rules and the source of truth. Start there.
- **Production UI work**: `tokens/*.css`, the relevant `components/**/*.prompt.md` constraint files, and the "PRODUCTION MAPPING" table in `readme.md` (production components live in `web/src/components/ds/`, not here).
- **Prototypes / mocks**: `styles.css`, `assets/` (SVG marks), `guidelines/*.html` specimens; copy screen structure from `ui_kits/app/screens*.jsx`.
- **Never read**: `_ds_bundle.js`, `support.js`, `ui_kits/app/standalone-bundle.js`, `*.dc.html` — large generated blobs that only power browser previews. Open the preview HTML in a browser instead.
- **`uploads/`**: brand reference photographs — view for mood/era inspiration only; photography never ships in the product or in mocks.
