/**
 * FOIL TRUMPS — the holographic treatment on the trump suit.
 *
 * A Balatro-style ruled diffraction grating ("the blade"), ported from a
 * design concept board (PR #192 — every dial as a live slider, a gallery of
 * sweeps and a sensor readout, none of which belong in the app bundle) with
 * the settings the owner landed on baked in as constants. This file is what
 * the board's chosen row compiles down to; the board itself was a throwaway
 * design tool and isn't part of the shipped app — see it in git history if
 * the look ever needs revisiting.
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
const GAIN_DAY = 1.45;
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
/**
 * What a DIMMED card's foil is worth on night stock — see u_dim in the shader.
 * Between the glyphs' own 0.4 and full: enough plate left for the card to
 * still read as a trump, little enough that the rank comes back.
 */
const DIM_NIGHT = 0.45;

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
const TILT_MAX_RATE = 0.6;
/**
 * How much of the sensor's reading the pattern actually spends. It is one
 * dial rather than four because "less motion" is a single judgement about the
 * whole effect: scaling the reading scales the grain's rotation, the band's
 * slide and the hue shift together, so their relationship to each other — the
 * thing that was tuned on board B — is unchanged.
 *
 * 0.64 is 0.8 of the 0.8 it shipped at (itself the concept board's tilt gain
 * 0.5 through its own x1.6 sensor scale): a fifth less travel for the same
 * wrist. TILT_MAX_RATE comes down by the same fifth, since a speed cap in
 * normalised units would otherwise cross the now-shorter range faster and
 * hand back some of the calm the smaller range buys.
 */
const TILT_GAIN = 0.64;
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
uniform vec2 u_origin;
uniform vec2 u_clipx;
uniform float u_clipTop;
uniform vec2 u_shift;
uniform float u_scale;
uniform float u_dim;
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
  return hsl2rgb(vec3(0.47 + 0.41 * u, 0.46, 0.72));
}

void main() {
  vec2 px = u_rect.xy + v_uv * u_rect.zw;
  /* A fanned card is overlapped by the next one, and each quad paints only the
     part of itself that is actually VISIBLE — otherwise an earlier card's foil
     sits on top of a later card's face.
     The visible part is an L, not a column, and getting that wrong is what
     made a selected card look broken. Lifting a card does NOT move it above
     its right-hand neighbour (measured with elementFromPoint: the neighbour
     still wins, since fan stacking is document order); it exposes the strip
     ABOVE the neighbour's top edge. Clipping in x alone foiled the left sliver
     and left that strip bare; dropping the clip for lifted cards painted foil
     straight over the neighbour's face. So both axes: a pixel is hidden only
     when it is past the neighbour's left edge AND below its top. */
  if (px.x > u_clipx.y && px.y > u_clipTop) discard;

  /* THE FOIL IS PRINTED ON THE CARD, so the pattern is sampled where the card
     LIVES, not where it has been moved to: u_shift is however far a transform
     has carried this card from its layout position, and taking it back off
     means a lifted or sliding card keeps the exact patch of sheet it had at
     rest. Without it, selecting a card slid it 14px through a grating whose
     rules are ~440px apart — enough to take the line term from 1 to 0 and drop
     the foil off that one card while its neighbours kept theirs, which reads as
     the sheet tearing rather than as a card being picked up. */
  /* ...and in PAGE coordinates, not this canvas's. Each layer used to sample
     the sheet in its own local space, which quietly made one sheet into three:
     the same card came up gold in the hand and blue on the table, because the
     fan's canvas and the trick's canvas start counting from different places.
     Adding the canvas's own page offset puts every layer — both fans, the
     trick, and the flight layer that carries a card between them — on one
     continuous sheet, so a card's patch depends only on where it is on the
     page. That is what makes the glide from hand to table continuous at both
     ends rather than a cut to a different part of the pattern. */
  /* ...and at the card's own printed size. A card in flight is SCALED (a fan
     card is a quarter wider than a table slot), and a quad sampled at the
     drawn size would enlarge the pattern with it — the foil zooming out over
     the glide while the card shrinks. Dividing the offset within the quad by
     that scale prints the sheet at 1:1 whatever size the card is drawn at.
     u_scale is 1 everywhere else, where this is exactly px again.
     (No backticks in here: this string is a JS template literal.) */
  vec2 pat = u_rect.xy + v_uv * u_rect.zw / u_scale + u_origin - u_shift;

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
  /* A card that cannot legally be played has its rank and pip dropped to 0.4
     opacity (style.css dims the glyphs, never the face). On DAY stock that is
     survivable: multiply cannot lighten, so the ink still darkens the card it
     sits on. On NIGHT stock the foil screens onto the card, so full-strength
     foil under a 40%-opacity light glyph leaves almost nothing to read — the
     card goes bright and its value disappears. u_dim brings the plate down
     with the ink. It is 1 everywhere else, including every dimmed card by
     day. */
  amount *= u_dim;

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
    for (const name of [
      'u_res', 'u_rect', 'u_light', 'u_origin', 'u_clipx', 'u_clipTop', 'u_shift',
      'u_tilt', 'u_gain', 'u_night', 'u_palette', 'u_scale', 'u_dim',
    ]) {
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
    setSheet(gl, this.u, box);
    gl.uniform2f(this.u.u_tilt, tiltX, tiltY);
    gl.uniform1f(this.u.u_gain, night ? GAIN_NIGHT : GAIN_DAY);
    gl.uniform1f(this.u.u_night, night ? 1 : 0);
    gl.uniform1i(this.u.u_palette, night ? PALETTE_NIGHT : PALETTE_DAY);
    // a card in a container is drawn at its printed size; only flights scale
    gl.uniform1f(this.u.u_scale, 1);

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
      // the neighbour that overlaps this card, if any — see the L-shaped clip
      // in the shader for why its TOP matters as much as its left edge
      let clipRight = r.right;
      let clipTop = -1e6;
      const next = faces[i + 1];
      if (next) {
        const nr = next.getBoundingClientRect();
        if (nr.left > r.left && nr.left < r.right) {
          clipRight = nr.left;
          clipTop = nr.top;
        }
      }
      /* Where the card would be with no transform on it — see u_shift in the
         shader. A lift, the Draw's slide and a staged glide are all transforms
         on the button, so this is the difference between the two. */
      const lay = layoutOffset(el, this.host);
      const shiftX = r.left - box.left - (lay.x + hostBox.left - box.left);
      const shiftY = r.top - box.top - (lay.y + hostBox.top - box.top);
      gl.uniform2f(this.u.u_clipx, r.left - box.left, clipRight - box.left);
      gl.uniform1f(this.u.u_clipTop, clipTop - box.top);
      gl.uniform2f(this.u.u_shift, shiftX, shiftY);
      gl.uniform1f(this.u.u_dim, night && el.classList.contains('dimmed') ? DIM_NIGHT : 1);
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
   * The sheet is held STILL on a flying card, anchored to where it is going
   * (`data-foil-at`), and both halves of that are the answer to a real
   * complaint: the holo changed during the glide and changed back on landing.
   *
   * Why not simply let the clone travel through the sheet? Measured: over one
   * glide the patch swept green → cyan → blue. The rules are ~440px apart and
   * a card crosses ~200px, so "smoothly continuous" is still a card visibly
   * changing colour in mid air, which is the thing being complained about.
   *
   * Why the destination rather than where it took off? Because two things
   * cannot both be true: that the hand reads as ONE SHEET (a card's patch
   * depends on where it sits, so neighbours line up) and that a card's patch
   * never changes as it is played (the patch belongs to the card). The hand is
   * the whole look, so the sheet wins — and a card's patch at the table is
   * therefore genuinely not its patch in the hand. Something has to change
   * once; the only question is when. Anchoring to the destination spends it at
   * the moment of the tap, when the card is leaving the fan anyway, and leaves
   * the glide and the landing identical — so nothing changes *during* the
   * animation and nothing snaps at the end of it.
   *
   * None of this would hold without the sheet being in PAGE space (u_origin):
   * while each layer counted from its own corner, the three phases were three
   * unrelated patches, which is what made one card come up gold in the hand
   * and blue on the table.
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
    setSheet(gl, this.u, box);
    gl.uniform2f(this.u.u_tilt, tiltX, tiltY);
    gl.uniform1f(this.u.u_gain, night ? GAIN_NIGHT : GAIN_DAY);
    gl.uniform1f(this.u.u_night, night ? 1 : 0);
    gl.uniform1i(this.u.u_palette, night ? PALETTE_NIGHT : PALETTE_DAY);
    // this layer's own lamp, for a clone anchored somewhere no layer covers
    const own = lampOf(box);
    // a card in flight was legal to play, so it is never the dimmed case
    gl.uniform1f(this.u.u_dim, 1);
    for (const el of clones) {
      const r = el.getBoundingClientRect();
      if (r.width < 1) continue;
      // a clone in flight is over everything, so nothing clips it
      gl.uniform2f(this.u.u_clipx, r.left - box.left, r.right - box.left);
      gl.uniform1f(this.u.u_clipTop, 1e6);
      const at = (el.getAttribute('data-foil-at') ?? '').split(',');
      const anchorX = parseFloat(at[0]);
      const anchorY = parseFloat(at[1]);
      const printed = parseFloat(at[2]);
      const anchored = Number.isFinite(anchorX) && Number.isFinite(anchorY);
      // how far this card is blown up from its printed size right now
      gl.uniform1f(this.u.u_scale, Number.isFinite(printed) && printed > 0 ? r.width / printed : 1);
      gl.uniform2f(
        this.u.u_shift,
        anchored ? r.left - anchorX : 0,
        anchored ? r.top - anchorY : 0,
      );
      /* Lit by the layer that owns where it is anchored, not by this one —
         see lampFor(). Measured from the anchor's CENTRE rather than its
         corner, so a card whose top-left lands a pixel outside the box still
         resolves to the lamp it is plainly under. */
      const lamp = anchored
        ? lampFor(anchorX + window.scrollX + r.width * 0.5, anchorY + window.scrollY + r.height * 0.5)
        : null;
      const lit = lamp ?? own;
      gl.uniform2f(this.u.u_light, lit.x, lit.y);
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

  /** This layer's own box, for the flight lamp lookup — see lampFor(). */
  canvasBox(): DOMRect {
    return this.canvas.getBoundingClientRect();
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

/**
 * Where an element's foil is sampled from, in viewport coordinates: its LAYOUT
 * position inside `host`, with every transform between the two taken back off
 * — the same point render() shifts the sheet to (see u_shift beside it).
 *
 * TrickArea needs this to anchor a flying clone, and the rendered rect is NOT
 * it. The four trick slots are centred with `transform: translate(-50%)`, so a
 * trick card is drawn up to half a slot away from where its own foil comes
 * from; a clone anchored to the rect therefore lands on a different patch of
 * sheet from the card that replaces it, which is exactly the change-at-the-end
 * of the glide the destination anchor exists to remove.
 *
 * (That centring transform also means the four cards of a trick sit on patches
 * pulled apart by up to half a slot — measured 21px in x for N/S and 40px in y
 * for E/W, against rules ~440px apart, so under a tenth of a period. Visible
 * as a slight difference in tint between seats at most, and left alone: the
 * two cases genuinely want opposite treatment, since the fan's lift is a
 * transform on an ancestor too and stripping it is the whole point there.)
 */
export function foilAnchor(el: HTMLElement, host: HTMLElement): { x: number; y: number } {
  const hostBox = host.getBoundingClientRect();
  const lay = layoutOffset(el, host);
  return { x: hostBox.left + lay.x, y: hostBox.top + lay.y };
}

/**
 * Put this layer on the one page-space sheet, and its lamp in the same space.
 *
 * The lamp stays at the CENTRE OF THIS CONTAINER rather than becoming a single
 * light over the whole page: that is the framing every value on board B was
 * chosen against (a lamp over the hand), and a global lamp would leave the fan
 * — which sits at the bottom of the screen — mostly at ambient. Only the
 * PATTERN is shared. So a card keeps its colour and its rules across the glide
 * while each container keeps the brightness it was tuned with.
 */
function setSheet(gl: WebGLRenderingContext, u: Uniforms, box: DOMRect) {
  const origin = sheetOrigin(box);
  const lamp = lampOf(box);
  gl.uniform2f(u.u_origin, origin.x, origin.y);
  gl.uniform2f(u.u_light, lamp.x, lamp.y);
}

/** Where a layer's own corner sits on the shared page-space sheet. */
function sheetOrigin(box: DOMRect): { x: number; y: number } {
  return { x: box.left + window.scrollX, y: box.top + window.scrollY };
}

/** A layer's lamp, in that same space. */
function lampOf(box: DOMRect): { x: number; y: number } {
  const origin = sheetOrigin(box);
  return { x: origin.x + box.width * 0.5, y: origin.y + box.height * 0.45 };
}

/**
 * Which lamp a flying card should be lit by: the one belonging to the layer
 * that owns the place it is anchored to.
 *
 * The pattern is shared but the lamp is per container (see setSheet), so a
 * flight layer lighting its clones from its own viewport-wide centre would
 * hand the last frame of a glide a different BRIGHTNESS from the card that
 * replaces it — the same snap the destination anchor exists to remove, one
 * term further down the shader. Borrowing the destination's lamp closes it:
 * the final frame and the landed card then agree in every term.
 */
function lampFor(px: number, py: number): { x: number; y: number } | null {
  for (const s of surfaces) {
    const box = s.canvasBox();
    if (!box || box.width < 1 || box.height < 1) continue;
    const origin = sheetOrigin(box);
    if (px < origin.x || px > origin.x + box.width) continue;
    if (py < origin.y || py > origin.y + box.height) continue;
    return lampOf(box);
  }
  return null;
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
  tiltTarget.x = clamp(gamma - rest.gamma) * TILT_GAIN;
  tiltTarget.y = clamp(beta - rest.beta) * TILT_GAIN;
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
    // No foiled surface is left to read the sensor for, so stop asking the
    // device for readings too — otherwise the browser keeps sampling motion
    // hardware for the rest of the tab's life the moment tilt is ever
    // attached once, on Settings, the leaderboard, anywhere.
    if (listening) {
      listening = false;
      removeOrientationListeners();
    }
  }
}

/** Both the plain event and the absolute variant fire it — see `SELF_ONLY`
 *  in server/src/security.ts for why both are granted. */
function addOrientationListeners() {
  window.addEventListener('deviceorientation', onOrientation);
  window.addEventListener('deviceorientationabsolute', onOrientation);
}

function removeOrientationListeners() {
  window.removeEventListener('deviceorientation', onOrientation);
  window.removeEventListener('deviceorientationabsolute', onOrientation);
}

/**
 * Attach the orientation listener, if this browser will give it to us without
 * asking. Where `requestPermission` exists (iOS) it must be called from a user
 * gesture, so the ask lives on the settings lever — see `requestFoilTilt`.
 *
 * Two events, not one: `deviceorientation` is the reading everywhere it
 * exists, but some Android builds only ever populate its `absolute` sibling
 * — the magnetometer grant in security.ts exists specifically for that case,
 * and a device that only fires the sibling would otherwise hold the
 * permission and never move the pattern.
 */
function attachTilt() {
  if (listening || typeof window.DeviceOrientationEvent === 'undefined') return;
  const gated = typeof (DeviceOrientationEvent as unknown as { requestPermission?: unknown }).requestPermission ===
    'function';
  if (gated && !tiltWasGranted()) return;
  listening = true;
  addOrientationListeners();
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
    addOrientationListeners();
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
