/**
 * The social share card: web/public/og-image.png (1200×630).
 *
 * This is the image every link unfurl shows — Slack, Discord, iMessage, X,
 * Reddit, Bluesky. It's the one brand surface that renders where a visitor
 * has NOT yet loaded the app, so it composes from the same pieces the splash
 * does (BridgeMark glyph, Poiret One wordmark, Besley tracked caps, the river
 * scene) rather than inventing a layout — see .claude/skills/nickel-bridge-design.
 *
 * Rendered offline with Playwright and checked in, the same shape as the other
 * generated assets in this repo: nothing at build or request time depends on
 * this script, so a normal `npm run build` never needs a browser. Re-run it
 * only when the card's copy or the brand marks change:
 *
 *   node scripts/og-image.mjs                    # → web/public/og-image.png
 *   node scripts/og-image.mjs out.png            # somewhere else
 *
 * Fonts are inlined as base64 woff2 straight from the @fontsource packages the
 * web bundle already self-hosts, so the card can't drift onto a Google-hosted
 * or system substitute face.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = process.argv[2] ?? resolve(root, 'web/public/og-image.png');

/** Inline a woff2 from node_modules as a data: URI — no network, no substitution. */
function font(rel) {
  const buf = readFileSync(resolve(root, 'node_modules', rel));
  return `data:font/woff2;base64,${buf.toString('base64')}`;
}

const POIRET = font('@fontsource/poiret-one/files/poiret-one-latin-400-normal.woff2');
const BESLEY = font('@fontsource-variable/besley/files/besley-latin-wght-normal.woff2');
const CRIMSON = font('@fontsource/crimson-pro/files/crimson-pro-latin-400-normal.woff2');

/**
 * The bottom edge is the footer mark, not the splash's river scene. The river
 * scene is a 640×240 vignette that includes the bank and rocks below the
 * waterline, so it only reads at its natural 2.67:1 — squeezed into a wide,
 * short strip its `slice` crops straight to the mud. The footer span is the
 * design system's actual "screen-bottom colophon" (BridgeMark variant="footer",
 * 320×46 ≈ 7:1), pure verdigris linework with no fills, so it floats on paper
 * with no hard edges. Kept in sync with web/src/components/ds/BridgeMark.tsx.
 */
const FOOTER_MARK = `
  <svg viewBox="0 0 320 46">
    <g stroke="#6F8F68" fill="none">
      <line x1="0" y1="5" x2="320" y2="5" stroke-width="5" />
      <path d="M12 40 Q60 16 108 40 Q156 16 204 40 Q252 16 300 40" stroke-width="3.5" />
      <line x1="12" y1="5" x2="12" y2="40" stroke-width="3.5" />
      <line x1="108" y1="5" x2="108" y2="40" stroke-width="3.5" />
      <line x1="204" y1="5" x2="204" y2="40" stroke-width="3.5" />
      <line x1="300" y1="5" x2="300" y2="40" stroke-width="3.5" />
      <line x1="60" y1="5" x2="60" y2="28" stroke-width="2" />
      <line x1="156" y1="5" x2="156" y2="28" stroke-width="2" />
      <line x1="252" y1="5" x2="252" y2="28" stroke-width="2" />
    </g>
  </svg>`;

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  @font-face { font-family: 'Poiret One'; src: url('${POIRET}') format('woff2'); font-weight: 400; }
  @font-face { font-family: 'Besley'; src: url('${BESLEY}') format('woff2'); font-weight: 100 900; }
  @font-face { font-family: 'Crimson Pro'; src: url('${CRIMSON}') format('woff2'); font-weight: 400; }

  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1200px; height: 630px; }
  body {
    background: #FCFBF8;
    color: #141414;
    display: flex; align-items: center; justify-content: center;
    -webkit-font-smoothing: antialiased;
  }

  /* The double 1px ink frame — the brand's "table" rule. */
  .frame {
    position: absolute; inset: 26px;
    border: 1px solid #141414;
    overflow: hidden;
  }
  .frame::after {
    content: ''; position: absolute; inset: 6px;
    border: 1px solid #141414; pointer-events: none;
  }

  .stack {
    position: relative; z-index: 2;
    display: flex; flex-direction: column; align-items: center;
    /* Lifted off centre so the footer colophon has room to read at the foot.
       Sized to centre the type in the band above the span, not on the page. */
    margin-bottom: 150px;
  }
  .wordmark {
    font-family: 'Poiret One'; font-size: 96px; line-height: 1;
    letter-spacing: .14em; text-indent: .14em; /* balance the trailing track */
    white-space: nowrap;
  }
  .rule { width: 132px; height: 1px; background: #141414; margin: 30px 0 22px; }
  .sub {
    font-family: 'Besley'; font-weight: 700; font-size: 20px;
    letter-spacing: .28em; text-indent: .28em; color: #6E6A62;
  }
  .pitch {
    font-family: 'Crimson Pro'; font-size: 30px; color: #141414;
    margin-top: 26px; white-space: nowrap;
  }
  .suits { margin-top: 30px; font-size: 30px; letter-spacing: .34em; text-indent: .34em; }
  .s-spade { color: #141414; } .s-heart { color: #C22F21; }
  .s-diamond { color: #9E6A00; } .s-club { color: #00775A; }

  /* Bottom-edge colophon: natural aspect, centred, clear of the frame rule. */
  .colophon {
    position: absolute; left: 50%; transform: translateX(-50%);
    bottom: 48px; width: 720px; z-index: 1;
  }
  .colophon svg { width: 100%; height: auto; display: block; }
</style>
<div class="frame">
  <div class="colophon">${FOOTER_MARK}</div>
</div>
<div class="stack">
  <div class="wordmark">NICKEL BRIDGE</div>
  <div class="rule"></div>
  <div class="sub">DUPLICATE · SAYC</div>
  <div class="pitch">Learn &amp; play duplicate bridge.</div>
  <div class="suits"><span class="s-spade">♠</span><span class="s-heart">♥</span><span
    class="s-diamond">♦</span><span class="s-club">♣</span></div>
</div>
`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
const png = await page.screenshot({ type: 'png' });
await browser.close();

writeFileSync(out, png);
console.log(`wrote ${out} (${(png.length / 1024).toFixed(1)} KB)`);
