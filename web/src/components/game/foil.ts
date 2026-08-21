/**
 * FOIL TRUMPS — the holographic treatment on the trump suit.
 *
 * A Balatro-style ruled diffraction grating ("the blade"), ported from the
 * concept board at web/public/foil-trumps-b-blade.html with the settings the
 * owner landed on baked in as constants. That board is still the place to
 * change how this LOOKS: it carries every dial as a live slider, a gallery of
 * sweeps and a sensor readout, none of which belong in the app bundle. This
 * file is what the board's chosen row compiles down to.
 *
 * Three things about the design are worth reading before touching it.
 *
 * ONE FIELD, NOT ONE EFFECT PER CARD. At the shipped line count a single rule
 * spans ~440px — wider than the whole hand — so the pattern has to be
 * continuous ACROSS the fan to read as one sheet of foil. That rules out a
 * per-card CSS gradient (which would restart at every card) and is why this is
 * one canvas over the host with a quad per trump card, rather than a
 * background on each `.pcard`.
 *
 * THE BLEND MODE PROTECTS THE INK. On day stock the layer multiplies, which
 * cannot lighten: the card takes the foil colour exactly while the near-black
 * rank and pip come through untouched, so the plate runs edge to edge UNDER
 * the glyphs with nothing to cut around. Night stock is the opposite problem
 * and screens onto a dark card. The clear colour follows the stock for the
 * same reason (white is multiply's no-op, black is screen's) or the gaps
 * between cards would tint.
 *
 * ...WHICH MEANS THE BLEND AND THE SHADER MUST AGREE, AND THAT IS THE ONE
 * THING EASY TO GET WRONG. The concept board shipped a version where CSS
 * decided "night" from `prefers-color-scheme` while the shader decided it from
 * the board's own lever, and on a phone in OS dark mode with the lever on day
 * they disagreed: the day image (built around white) was SCREENED, and since
 * screen cannot darken, the card, the pips and the rank all blew out to
 * near-white together. It presented as the shader being wrong for light and it
 * was one selector. So neither half decides here. `--foil-stock` is a token
 * declared beside every other night override in style.css, and BOTH the blend
 * mode and `u_night` are read from the cascade's answer for it — they cannot
 * disagree, whatever combination of `data-theme` and OS preference produced it.
 */

/* ---------------------------------------------------------------------------
   THE SETTLED READING
   Board B, "the blade": weight 0.90, count 0.15, ambient 0.15, light size 120,
   duotone by day and full spectrum at night, with day carrying more intensity
   than night because multiply spends it differently than screen does.
   `LINE_K`/`LINE_FREQ` are the board's own slider mappings evaluated once —
   the shaping term is k·|cos| − (k−1), whose peak is 1 whatever k is, so k
   widens a rule without changing how much light reaches the card.
--------------------------------------------------------------------------- */
const LINE_K = Math.max(1.6, (16 - 14 * 0.9) * 0.5); // weight 0.90
const LINE_FREQ = 0.0945 * 0.15; // count 0.15
const AMBIENT = 0.15;
const LIGHT_SIZE = 120;
const GAIN_DAY = 1.25;
const GAIN_NIGHT = 0.9;
const PALETTE_DAY = 1; // duotone arc
const PALETTE_NIGHT = 0; // spectrum
/**
 * The pattern's phase, fixed. It used to advance with a clock so a device with
 * no sensors still had something to look at, and on a real phone that read as
 * the foil crawling on its own — a card sitting on the table is not moving, so
 * neither is its shine. The tilt is now the only thing that moves it, and a
 * board with no sensor simply holds still.
 */
const PHASE = 3.2;

/* ---------------------------------------------------------------------------
   HOW FAR, AND HOW FAST, THE TWIST TRAVELS
   The tilt reading is filtered AND rate-limited, and both are needed. A time
   constant bounds lag, not speed: hand the filter a full-sweep target and its
   first frame still moves ~4% of it, which at 60Hz is a shine crossing the
   hand in a fifth of a second. So the smoothed value is additionally capped at
   a fixed distance per second — gentle movement is governed by the filter and
   feels immediate, a flick is governed by the cap and arrives a moment later.
   The cap sits on the SMOOTHED value, never on the raw reading, so it can
   never accumulate a backlog it then has to sprint through.
--------------------------------------------------------------------------- */
const TILT_TAU_MS = 420;
const TILT_MAX_RATE = 0.75;
/** Degrees of rotation that map to the full ±1 of tilt, in each axis. */
const TILT_DEGREES = 45;
/** Radians the grain rotates, and pixels the bright band slides, at full tilt. */
const TILT_ANGLE = 0.28;
const TILT_PHASE = 7.5;
const TILT_SLIDE = 48;

const VERT = `
attribute vec2 a_unit;
uniform vec2 u_res;
uniform vec4 u_rect;
varying vec2 v_uv;
void main() {
  v_uv = a_unit;
  vec2 px = u_rect.xy + a_unit * u_rect.zw;
  gl_Position = vec4(px.x / u_res.x * 2.0 - 1.0, 1.0 - px.y / u_res.y * 2.0, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
varying vec2 v_uv;
uniform vec4 u_rect;
uniform vec2 u_light;
uniform vec2 u_clipx;
uniform vec2 u_shift;
uniform vec2 u_tilt;
uniform float u_gain;
uniform float u_night;
uniform int u_palette;

float hueTerm(float s, float t, float h) {
  float hs = mod(h, 1.0) * 6.0;
  if (hs < 1.0) return (t - s) * hs + s;
  if (hs < 3.0) return t;
  if (hs < 4.0) return (t - s) * (4.0 - hs) + s;
  return s;
}
vec3 hsl2rgb(vec3 c) {
  if (c.y < 0.0001) return vec3(c.z);
  float t = (c.z < 0.5) ? c.y * c.z + c.z : -c.y * c.z + (c.y + c.z);
  float s = 2.0 * c.z - t;
  return vec3(hueTerm(s, t, c.x + 1.0 / 3.0), hueTerm(s, t, c.x), hueTerm(s, t, c.x - 1.0 / 3.0));
}

/* holo.fs's line shaper: peaks at 1 whatever k is, so k is a pure WIDTH
   control and never changes how much light the card receives. */
float rule(float x, float k) {
  return max(0.0, k * abs(cos(x)) - (k - 1.0));
}

/* The card's own outline, in card pixels, so foil runs to the trim with the
   1px hairline still showing. No corner knockout around the rank: the blend
   mode is what protects the ink. */
float cardMask(vec2 uv) {
  vec2 size = u_rect.zw;
  /* named mid, not half: "half" is a reserved word in GLSL ES 1.00 and some
     drivers reject it outright, which presents as a blank layer and no error */
  vec2 mid = size * 0.5;
  vec2 q = abs(uv * size - mid) - (mid - vec2(0.75)) + vec2(2.5);
  float d = min(max(q.x, q.y), 0.0) + length(max(q, vec2(0.0))) - 2.5;
  return 1.0 - smoothstep(-0.75, 0.35, d);
}

vec3 palette(float t) {
  float u = fract(t);
  if (u_palette == 0) return hsl2rgb(vec3(u, 0.55, 0.55));
  return hsl2rgb(vec3(0.47 + 0.41 * u, 0.34, 0.62));
}

void main() {
  vec2 px = u_rect.xy + v_uv * u_rect.zw;
  /* a fanned card is overlapped by the next one; each quad paints only the
     sliver of itself that is actually visible, or an earlier card's foil
     would sit on top of a later card's face */
  if (px.x < u_clipx.x || px.x > u_clipx.y) discard;

  /* THE FOIL IS PRINTED ON THE CARD, so the pattern is sampled where the card
     LIVES, not where it has been moved to: u_shift is however far a transform
     has carried this card from its layout position, and taking it back off
     means a lifted or sliding card keeps the exact patch of sheet it had at
     rest. Without it, selecting a card slid it 14px through a grating whose
     rules are ~440px apart — enough to take the line term from 1 to 0 and drop
     the foil off that one card while its neighbours kept theirs, which reads as
     the sheet tearing rather than as a card being picked up. */
  vec2 pat = px - u_shift;

  /* The grain. Its ANGLE and PHASE are what the device moves — every card
     shares one normal, so tilting cannot light one card more than its
     neighbour, which makes brightness the wrong thing to hand a sensor. */
  float ang = 0.9 + u_tilt.x * ${TILT_ANGLE.toFixed(3)};
  vec2 dir = vec2(cos(ang), sin(ang));
  float d = dot(pat, dir);
  float lines = rule(d * ${LINE_FREQ.toFixed(6)} + u_tilt.y * ${TILT_PHASE.toFixed(2)} + ${(PHASE * 2.2).toFixed(3)}, ${LINE_K.toFixed(3)});

  /* One broad band, its width the lamp's apparent size and its position the
     lamp projected onto the grain's own axis. The floor is what keeps the
     dark side lit rather than bare paper at every angle. */
  float band = exp(-pow((d - dot(u_light, dir) - u_tilt.y * ${TILT_SLIDE.toFixed(1)}) / ${LIGHT_SIZE.toFixed(1)}, 2.0));
  float lit = ${AMBIENT.toFixed(2)} + ${(1 - AMBIENT).toFixed(2)} * band;

  float t = 0.5 + 0.5 * sin(d * 0.012 + ${(PHASE * 0.22).toFixed(3)}) + lines * 0.5 + u_tilt.x * 0.12;
  vec3 tint = palette(t);
  /* Day and night need very different amounts of the same tint. Under
     multiply the tint lands on the card at full strength — no doubling, no
     clamp to soften it — where night screens onto a dark plate that can
     absorb far more before it stops looking like card stock. */
  float amount = clamp((0.30 + 0.95 * lines) * lit * u_gain, 0.0, 1.0) * cardMask(v_uv);
  amount *= mix(0.42, 1.0, u_night);

  /* multiply wants white as its no-op, screen wants black — so the two stocks
     blend from opposite neutrals toward the same tint */
  vec3 day = mix(vec3(1.0), tint, amount);
  vec3 night = mix(vec3(0.0), tint, amount);
  gl_FragColor = vec4(mix(day, night, u_night), 1.0);
}`;

type Uniforms = Record<string, WebGLUniformLocation | null>;

/**
 * One host's canvas: its own GL context, sized to the host, painting a quad
 * per `[data-foil]` card face found inside it.
 *
 * A context per host is affordable here in a way it was not on the concept
 * board — that page has ~130 hosts and had to render offscreen and blit,
 * against a browser limit of roughly 16 live contexts. A board carries at most
 * three (your hand, dummy's, the trick), so each can simply own one.
 */
class FoilSurface {
  private gl: WebGLRenderingContext | null = null;
  private u: Uniforms = {};
  private w = 0;
  private h = 0;
  private stockChecked = 0;
  private night = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly host: HTMLElement,
  ) {
    /* Feature-detect before asking. `getContext('webgl')` on an environment
       without it is not a quiet null everywhere: jsdom reports it as an error
       on the virtual console, so a unit test that renders a foiled hand would
       print a stack per canvas for something that is working as designed. */
    if (typeof WebGLRenderingContext === 'undefined') return;
    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
    }) as WebGLRenderingContext | null;
    if (!gl) return;
    const program = link(gl);
    if (!program) return;
    gl.useProgram(program);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'a_unit');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const name of ['u_res', 'u_rect', 'u_light', 'u_clipx', 'u_shift', 'u_tilt', 'u_gain', 'u_night', 'u_palette']) {
      this.u[name] = gl.getUniformLocation(program, name);
    }
    this.gl = gl;
  }

  get ok() {
    return this.gl !== null;
  }

  /**
   * Which stock is on screen, straight out of the cascade — see this file's
   * header for why neither the shader nor the CSS may decide it alone.
   *
   * Re-read on a timer rather than subscribed to, because there are four ways
   * it can change (the settings lever, the adaptive-schedule tick in App.tsx,
   * an OS appearance change, and a `system` preference meeting either of the
   * last two) and a periodic read is correct for all of them plus any fifth
   * nobody has thought of yet. Two reads a second of one custom property is
   * not a cost worth engineering around.
   */
  private stock(now: number): boolean {
    if (now - this.stockChecked < 500) return this.night;
    this.stockChecked = now;
    const raw = getComputedStyle(this.host).getPropertyValue('--foil-stock').trim();
    this.night = raw === '1';
    this.canvas.style.mixBlendMode = this.night ? 'screen' : 'multiply';
    return this.night;
  }

  render(now: number, tiltX: number, tiltY: number) {
    const gl = this.gl;
    if (!gl) return;
    /* The CANVAS's box, never the host's, and this is the one measurement in
       here that is easy to get wrong: the layer OVERHANGS its host by
       --foil-bleed, so the two boxes differ by 32px in each axis. Using the
       host's size for u_res while rasterising into the larger canvas shifts
       every quad up and left by the bleed and stretches it by the ratio of
       the two widths — the foil lands beside its cards rather than on them. */
    const box = this.canvas.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return;

    const night = this.stock(now);
    this.resize(gl, box);
    // the clear colour follows the stock, or the gaps between cards would tint
    gl.clearColor(night ? 0 : 1, night ? 0 : 1, night ? 0 : 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.uniform2f(this.u.u_res, box.width, box.height);
    gl.uniform2f(this.u.u_light, box.width * 0.5, box.height * 0.45);
    gl.uniform2f(this.u.u_tilt, tiltX, tiltY);
    gl.uniform1f(this.u.u_gain, night ? GAIN_NIGHT : GAIN_DAY);
    gl.uniform1f(this.u.u_night, night ? 1 : 0);
    gl.uniform1i(this.u.u_palette, night ? PALETTE_NIGHT : PALETTE_DAY);

    /* Every card face in the host, in document order, so a foiled card can be
       clipped against whichever card overlaps it next — foiled or not. The
       fan's cards overlap by design; the trick's do not, where this is inert. */
    const hostBox = this.host.getBoundingClientRect();
    const faces = this.host.querySelectorAll<HTMLElement>('.pcard');
    for (let i = 0; i < faces.length; i++) {
      const el = faces[i];
      if (!el.hasAttribute('data-foil')) continue;
      /* A card mid-glide is hidden in place while a clone flies to it from
         the fan (TrickArea's glideIn), and the clone is painted by the flight
         layer instead. Painting its slot anyway would leave a foil rectangle
         hanging in an empty seat until the card landed. */
      if (el.style.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1) continue;
      let clipRight = r.right;
      const next = faces[i + 1];
      if (next) {
        const nr = next.getBoundingClientRect();
        if (nr.left > r.left) clipRight = Math.min(clipRight, nr.left);
      }
      /* Where the card would be with no transform on it — see u_shift in the
         shader. A lift, the Draw's slide and a staged glide are all transforms
         on the button, so this is the difference between the two. */
      const lay = layoutOffset(el, this.host);
      const shiftX = r.left - box.left - (lay.x + hostBox.left - box.left);
      const shiftY = r.top - box.top - (lay.y + hostBox.top - box.top);
      gl.uniform2f(this.u.u_clipx, r.left - box.left, clipRight - box.left);
      gl.uniform2f(this.u.u_shift, shiftX, shiftY);
      gl.uniform4f(this.u.u_rect, r.left - box.left, r.top - box.top, r.width, r.height);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  }

  /**
   * The flight variant: a fixed, viewport-wide layer painting the `position:
   * fixed` clones TrickArea animates between the fan and the table. They live
   * on document.body, outside every card container, so no ordinary layer can
   * reach them — and without this a trump simply lost its foil for the length
   * of the glide, which is exactly when it is most looked at.
   *
   * `u_shift` is zero here on purpose. A clone has no layout position to carry
   * a patch of sheet from, and a card genuinely travelling across the table
   * SHOULD pass through the light rather than hold one frozen highlight — the
   * opposite of the lifted card above, which is not moving at all.
   */
  renderFlights(now: number, tiltX: number, tiltY: number): boolean {
    const gl = this.gl;
    if (!gl) return false;
    const clones = document.querySelectorAll<HTMLElement>('.pcard-flight[data-foil]');
    if (clones.length === 0) return false;
    const box = this.canvas.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    const night = this.stock(now);
    this.resize(gl, box);
    gl.clearColor(night ? 0 : 1, night ? 0 : 1, night ? 0 : 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(this.u.u_res, box.width, box.height);
    gl.uniform2f(this.u.u_light, box.width * 0.5, box.height * 0.45);
    gl.uniform2f(this.u.u_tilt, tiltX, tiltY);
    gl.uniform2f(this.u.u_shift, 0, 0);
    gl.uniform1f(this.u.u_gain, night ? GAIN_NIGHT : GAIN_DAY);
    gl.uniform1f(this.u.u_night, night ? 1 : 0);
    gl.uniform1i(this.u.u_palette, night ? PALETTE_NIGHT : PALETTE_DAY);
    for (const el of clones) {
      const r = el.getBoundingClientRect();
      if (r.width < 1) continue;
      gl.uniform2f(this.u.u_clipx, r.left - box.left, r.right - box.left);
      gl.uniform4f(this.u.u_rect, r.left - box.left, r.top - box.top, r.width, r.height);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    return true;
  }

  private resize(gl: WebGLRenderingContext, box: DOMRect) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(box.width * dpr);
    const h = Math.round(box.height * dpr);
    if (w !== this.w || h !== this.h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.w = w;
      this.h = h;
    }
    gl.viewport(0, 0, w, h);
  }

  setVisible(on: boolean) {
    this.canvas.style.visibility = on ? 'visible' : 'hidden';
  }

  /** Only the flight layer owns its own element; a FoilLayer's is React's. */
  remove() {
    this.canvas.remove();
  }

  dispose() {
    const lose = this.gl?.getExtension('WEBGL_lose_context');
    lose?.loseContext();
    this.gl = null;
  }
}

/**
 * Where an element sits with every transform on it and its ancestors taken
 * back off, relative to `host` — which is an offset parent, since both card
 * containers are `position: relative`.
 *
 * `offsetLeft`/`offsetTop` are layout values and ignore transforms, which is
 * the whole point: subtracting this from the measured rect leaves exactly how
 * far a transform has carried the card, and that is what the shader takes back
 * off before it samples the sheet.
 */
function layoutOffset(el: HTMLElement, host: HTMLElement): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let n: HTMLElement | null = el;
  while (n && n !== host) {
    x += n.offsetLeft;
    y += n.offsetTop;
    n = n.offsetParent as HTMLElement | null;
  }
  return { x, y };
}

function link(gl: WebGLRenderingContext): WebGLProgram | null {
  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? sh : null;
  };
  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null;
}

/* ---------------------------------------------------------------------------
   THE DRIVER
   One rAF loop and one tilt reading shared by every surface on screen, so two
   fans and a trick box are lit by the same lamp from the same angle rather
   than each running its own clock.
--------------------------------------------------------------------------- */

const surfaces = new Set<FoilSurface>();
const tilt = { x: 0, y: 0 };
const tiltTarget = { x: 0, y: 0 };
/** The first reading is the rest pose: however the device is being held is centre. */
let rest: { beta: number; gamma: number } | null = null;
let listening = false;
let frameId = 0;
let lastFrame = 0;
/** The lazily-made viewport layer that paints TrickArea's flight clones. */
let flightSurface: FoilSurface | null = null;
let flightVisible = false;

/** Exported for the unit test: one step of the filter-then-cap tilt rule. */
export function stepTilt(current: number, target: number, dtMs: number): number {
  const alpha = 1 - Math.exp(-dtMs / TILT_TAU_MS);
  const cap = (TILT_MAX_RATE * dtMs) / 1000;
  const step = (target - current) * alpha;
  return current + (step > cap ? cap : step < -cap ? -cap : step);
}

/** Prefers-reduced-motion, read live — a media query can change mid-session. */
function motionAllowed(): boolean {
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function onOrientation(e: DeviceOrientationEvent) {
  const gamma = e.gamma ?? 0;
  const beta = e.beta ?? 0;
  if (!rest) rest = { beta, gamma };
  const clamp = (v: number) => Math.max(-TILT_DEGREES, Math.min(TILT_DEGREES, v)) / TILT_DEGREES;
  // ×0.8: the concept board's tilt gain 0.5 through its own ×1.6 sensor scale
  tiltTarget.x = clamp(gamma - rest.gamma) * 0.8;
  tiltTarget.y = clamp(beta - rest.beta) * 0.8;
}

function frame(now: number) {
  frameId = requestAnimationFrame(frame);
  const dt = lastFrame ? Math.min(now - lastFrame, 100) : 16;
  lastFrame = now;
  if (document.hidden) return;

  /* Reduced motion freezes the tilt but keeps drawing: the foil is a texture,
     and asking for less movement is not asking for a plain card. The quads
     still have to follow their cards as the hand is played. */
  const moving = motionAllowed();
  if (moving) {
    tilt.x = stepTilt(tilt.x, tiltTarget.x, dt);
    tilt.y = stepTilt(tilt.y, tiltTarget.y, dt);
  }
  const tx = moving ? tilt.x : 0;
  const ty = moving ? tilt.y : 0;
  for (const s of surfaces) s.render(now, tx, ty);

  /* The flight layer is viewport-wide and blends, so it is kept unpainted
     except during the glide it exists for — and the hiding is `visibility`,
     never `display`. A display:none canvas has NO BOX, so its own
     getBoundingClientRect comes back all zeros, renderFlights bails on the
     zero-size check and it can never make itself visible again: hidden
     forever, in silence. The style is written only when the answer changes. */
  const painted = flightSurface?.renderFlights(now, tx, ty) ?? false;
  if (flightSurface && painted !== flightVisible) {
    flightVisible = painted;
    flightSurface.setVisible(painted);
  }
}

function addSurface(s: FoilSurface) {
  surfaces.add(s);
  if (!frameId) {
    lastFrame = 0;
    frameId = requestAnimationFrame(frame);
  }
  ensureFlightSurface();
  attachTilt();
}

/**
 * The one layer that is not a child of a card container: TrickArea animates a
 * `position: fixed` clone on document.body between the fan and the table, and
 * nothing scoped to a host can reach it. Made once, on the first foiled board,
 * and left hidden until a foiled clone actually exists.
 *
 * Being fixed, it cannot desync from what it paints the way a fixed blend
 * layer over SCROLLING content does — the clones are fixed too, so the two
 * move together by construction.
 */
function ensureFlightSurface() {
  if (flightSurface || typeof document === 'undefined') return;
  const canvas = document.createElement('canvas');
  canvas.className = 'foil-layer foil-layer-flight';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.visibility = 'hidden';
  document.body.appendChild(canvas);
  const surface = new FoilSurface(canvas, document.body);
  if (!surface.ok) {
    canvas.remove();
    return;
  }
  flightSurface = surface;
  flightVisible = false;
}

function removeSurface(s: FoilSurface) {
  surfaces.delete(s);
  s.dispose();
  if (surfaces.size === 0 && frameId) {
    cancelAnimationFrame(frameId);
    frameId = 0;
    flightSurface?.dispose();
    flightSurface?.remove();
    flightSurface = null;
    flightVisible = false;
    // the next board re-centres on however the device is held then
    rest = null;
    tilt.x = tilt.y = tiltTarget.x = tiltTarget.y = 0;
  }
}

/**
 * Attach the orientation listener, if this browser will give it to us without
 * asking. Where `requestPermission` exists (iOS) it must be called from a user
 * gesture, so the ask lives on the settings lever — see `requestFoilTilt`.
 */
function attachTilt() {
  if (listening || typeof window.DeviceOrientationEvent === 'undefined') return;
  const gated = typeof (DeviceOrientationEvent as unknown as { requestPermission?: unknown }).requestPermission ===
    'function';
  if (gated && !tiltWasGranted()) return;
  listening = true;
  window.addEventListener('deviceorientation', onOrientation);
  if (gated) armGestureRequest();
}

const GRANT_KEY = 'nb:foilTilt';

function tiltWasGranted(): boolean {
  try {
    return localStorage.getItem(GRANT_KEY) === 'granted';
  } catch {
    return false;
  }
}

/**
 * iOS does not persist the orientation grant across page loads — the API has
 * to be asked again, from a gesture, every time. So a player who has already
 * said yes once (the flag below, written by the settings lever) gets the ask
 * re-made silently on their first tap of the session, which on a board is the
 * first card they touch. Someone who never opted in is never asked, and the
 * foil simply drifts on its own clock instead: tilt is the enhancement, not
 * the feature.
 */
function armGestureRequest() {
  const once = () => {
    document.removeEventListener('pointerdown', once);
    void requestFoilTilt();
  };
  document.addEventListener('pointerdown', once, { once: true });
}

/**
 * Ask for the motion sensors, from a real user gesture. Called by the settings
 * lever when Foil trumps is switched on, which is the one moment in the app
 * where a permission dialog is both expected and explained.
 *
 * Resolves true when readings can flow, false otherwise; a refusal is not an
 * error and is never surfaced — see `armGestureRequest`.
 */
export async function requestFoilTilt(): Promise<boolean> {
  if (typeof window.DeviceOrientationEvent === 'undefined') return false;
  const api = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
  if (typeof api.requestPermission !== 'function') {
    attachTilt();
    return listening;
  }
  try {
    if ((await api.requestPermission()) !== 'granted') return false;
  } catch {
    return false;
  }
  try {
    localStorage.setItem(GRANT_KEY, 'granted');
  } catch {
    /* private mode: the grant just doesn't survive this page load */
  }
  if (!listening) {
    listening = true;
    window.addEventListener('deviceorientation', onOrientation);
  }
  return true;
}

/**
 * Mount a foil layer over `host`, painting every `[data-foil]` card inside it.
 * Returns a teardown. A browser with no WebGL gets a no-op and an unstyled
 * board rather than an error.
 */
export function mountFoil(canvas: HTMLCanvasElement, host: HTMLElement): () => void {
  const surface = new FoilSurface(canvas, host);
  if (!surface.ok) return () => surface.dispose();
  addSurface(surface);
  return () => removeSurface(surface);
}
