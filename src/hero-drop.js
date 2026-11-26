/**
 * Hero entrance: the cut-outs fall in from above the viewport, hit the ground,
 * squash, bounce and jiggle to rest, while their contact shadows grow in underneath.
 *
 * It is a small fixed-step simulation, not a keyframed tween, so every piece reacts
 * to its own impact: soft cuts squash deep and wobble, herbs are springier,
 * peppercorns are hard and bounce twice.
 *
 * Markup contract (index.html, #heroVisual):
 *   .hv[data-drop="name"][data-o="x y"]  a piece; data-o = ground-contact point in % of its box
 *   .hv[data-for="name"]                 a contact shadow belonging to that piece
 *   .hv > .hv__body                      what this module transforms (the outer .hv keeps parallax)
 *
 * Debug: add ?drop-speed=0.25 to the URL (or data-drop-speed on <html>) to watch it at quarter speed.
 */
import gsap from 'gsap';

// Material feel. bounce = rebound height as a fraction of the piece's height.
// squash = peak vertical squash on the first impact. k/zeta = jelly spring (stiffness, damping ratio).
// wob = sideways jiggle (skew, degrees) kicked on impact.
const MATERIAL = {
  meat:  { bounce: 0.06,  air: 0.18, rebound: 0.3,  squash: 0.19,  k: 440,  zeta: 0.19, wob: 3 },
  herb:  { bounce: 0.09,  air: 0.19, rebound: 0.35, squash: 0.08,  k: 820,  zeta: 0.26, wob: 3.2 },
  hard:  { bounce: 0.22,  air: 0.22, rebound: 0.42, squash: 0.035, k: 1400, zeta: 0.35, wob: 0 },
};

// Back-to-front landing order: the big cuts first, garnish last.
const ORDER = [
  ['lamb', 'meat'], ['brisket', 'meat'], ['tenderloin', 'meat'], ['tbone', 'meat'],
  ['ribs', 'meat'], ['lemongrass', 'herb'], ['rosemary', 'herb'], ['pepper', 'hard'],
];

const FALL_TIME = 0.5;   // s, from above the viewport to the ground
const STAGGER = 0.085;   // s between pieces
const START_DELAY = 0.12;
const STEP = 1 / 240;    // fixed physics step
const MAX_RUN = 4;       // s, hard stop

const WAIT_CLASS = 'hero-drop-wait';

/** Hide the pieces as early as possible so they don't flash in place before the drop. */
export function holdHeroPieces() {
  document.documentElement.classList.add(WAIT_CLASS);
}

export function playHeroDrop({ root = document.getElementById('heroVisual'), reduce = false } = {}) {
  const release = () => document.documentElement.classList.remove(WAIT_CLASS);
  if (!root) { release(); return; }

  const bodies = [...root.querySelectorAll('.hv__body')];
  const imgs = [...root.querySelectorAll('img')];
  const decoded = Promise.all(imgs.map((im) => (im.decode ? im.decode().catch(() => {}) : Promise.resolve())));
  const timeout = new Promise((r) => setTimeout(r, 1800));

  Promise.race([decoded, timeout]).then(() => (reduce ? null : waitForCalm())).then(() => {
    const hero = root.closest('.hero');
    const offscreen = hero && hero.getBoundingClientRect().bottom < window.innerHeight * 0.35;

    if (reduce || offscreen) {
      release();
      // Reduced motion: no movement, just a quiet fade so the scene doesn't pop.
      // WAAPI with an implicit end keyframe fades to each element's own CSS opacity (shadows are baked at their own strength).
      if (reduce && !offscreen && bodies[0]?.animate) {
        bodies.forEach((b, i) => b.animate([{ opacity: 0 }, {}], { duration: 400, delay: i * 30, easing: 'ease-out', fill: 'backwards' }));
      }
      return;
    }
    run(root);
    release();
  });
}

function run(root) {
  const speed = clamp(Number(document.documentElement.dataset.dropSpeed || new URLSearchParams(location.search).get('drop-speed')) || 1, 0.05, 2);
  const vh = window.innerHeight;
  const pieces = [];

  ORDER.forEach(([name, kind], i) => {
    const el = root.querySelector(`[data-drop="${name}"]`);
    if (!el) return;
    const body = el.querySelector('.hv__body');
    const [ox, oy] = (el.dataset.o || '50 90').split(' ').map(Number);
    body.style.transformOrigin = `${ox}% ${oy}%`;
    // Shadows scale around the same ground point as the piece, mapped into the shadow's own box.
    const pr = el.getBoundingClientRect();
    const gx = pr.left + (pr.width * ox) / 100, gy = pr.top + (pr.height * oy) / 100;
    const shadow = (kind) => {
      const s = root.querySelector(`[data-for="${name}"].sh--${kind} .hv__body`);
      if (!s) return null;
      const r = s.getBoundingClientRect();
      s.style.transformOrigin = `${(gx - r.left).toFixed(1)}px ${(gy - r.top).toFixed(1)}px`;
      return s;
    };
    const soft = shadow('soft'), contact = shadow('contact');
    const shadows = [soft, contact].filter(Boolean);

    const rect = el.getBoundingClientRect();
    const H = rect.height;
    const m = MATERIAL[kind];
    // Start fully above the viewport (but always fall at least ~60% of a screen).
    const drop = Math.max(rect.bottom + 24, vh * 0.6);
    const g = (2 * drop) / (FALL_TIME * FALL_TIME);
    const omega = Math.sqrt(m.k);
    const tilt = (i % 2 ? 1 : -1) * (2 + (i * 37 % 4)); // deterministic, alternating ±2–5°

    pieces.push({
      body, soft, contact, shadows, H, m, drop, g, omega,
      c: 2 * m.zeta * omega,
      t0: START_DELAY + i * STAGGER,
      phase: 'wait',     // wait → fall → air → rest
      y: -drop, vy: 0,   // px, y = 0 is resting on the ground, negative is up
      d: 0, dv: 0,       // squash (+) / stretch (−), unitless
      r: tilt, rv: 0,    // rotation, deg
      w: 0, wv: 0,       // skew wobble, deg
      up: 0,             // rebound speed of the current hop
      hits: 0,
      side: i % 2 ? 1 : -1,
    });
  });

  let t = 0, acc = 0;
  const tick = (_time, deltaMs) => {
    acc += Math.min(deltaMs / 1000, 1 / 20) * speed;
    while (acc >= STEP) { step(pieces, t, STEP); t += STEP; acc -= STEP; }
    pieces.forEach(render);
    if (t > MAX_RUN || pieces.every(settled)) {
      gsap.ticker.remove(tick);
      pieces.forEach((p) => {
        p.body.style.transform = '';
        p.shadows.forEach((s) => { s.style.transform = ''; s.style.opacity = ''; });
      });
    }
  };
  pieces.forEach(render);
  gsap.ticker.add(tick);
}

function step(pieces, t, dt) {
  for (const p of pieces) {
    const { m } = p;
    if (p.phase === 'wait') {
      if (t >= p.t0) p.phase = 'fall';
      else continue;
    }

    if (p.phase === 'fall') {
      p.vy += p.g * dt;
      p.y += p.vy * dt;
      // Lean eases out as it falls; it keeps ~30% of it for the impact to correct.
      p.r += (-p.r * 1.4) * dt;
      if (p.y >= 0) impact(p, 1);
    } else if (p.phase === 'air') {
      p.vy += p.ga * dt;
      p.y += p.vy * dt;
      if (p.y >= 0) {
        const strength = 0.45 * (p.up / p.up0); // a hop lands much softer than the fall
        p.up *= m.rebound;
        if (p.up / p.up0 < 0.12) { p.y = 0; p.vy = 0; p.phase = 'rest'; kick(p, strength * 0.6); }
        else impact(p, strength);
      }
    }

    // Jelly springs run in every phase, so a piece keeps wobbling in the air after a hop.
    p.dv += (-m.k * p.d - p.c * p.dv) * dt;   p.d += p.dv * dt;
    if (p.phase !== 'fall') { p.rv += (-m.k * 0.35 * p.r - p.c * 0.8 * p.rv) * dt; p.r += p.rv * dt; }
    p.wv += (-m.k * 0.6 * p.w - p.c * 0.9 * p.wv) * dt; p.w += p.wv * dt;
  }
}

function impact(p, strength) {
  const { m, H } = p;
  if (p.hits === 0) {
    // First contact sets the hop: peak height = bounce·H, airtime = m.air.
    p.ga = (8 * m.bounce * H) / (m.air * m.air);
    p.up0 = p.up = (4 * m.bounce * H) / m.air;
  }
  p.hits++;
  p.y = 0;
  p.vy = -p.up;
  p.phase = 'air';
  kick(p, strength);
}

function kick(p, strength) {
  const { m } = p;
  // Velocity kick that peaks the squash near m.squash on a full-strength hit.
  p.dv += m.squash * p.omega * 1.35 * strength;
  p.rv += -p.r * p.omega * 0.25;                    // impact snaps the lean back
  p.wv += p.side * m.wob * p.omega * 0.9 * strength;
  p.side *= -1;
}

function render(p) {
  // Speed stretch while falling, squash on the ground. Keep area roughly constant.
  const fallStretch = p.phase === 'fall' ? 0.07 * Math.min(1, p.vy / (p.g * FALL_TIME)) ** 2 : 0;
  const sy = (1 - p.d) * (1 + fallStretch);
  const sx = 1 / Math.sqrt(sy);
  p.body.style.transform =
    `translate3d(0, ${p.y.toFixed(2)}px, 0) rotate(${p.r.toFixed(3)}deg) skewX(${p.w.toFixed(3)}deg) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;

  const up = Math.max(0, -p.y); // height above the ground, px
  const squash = Math.max(0, p.d);

  // Soft cast shadow: shows up as the piece approaches, slides out toward its rest spot
  // (light is top-left, so a higher piece throws its shadow further down-right) and sharpens in.
  if (p.soft) {
    const near = clamp(1 - up / (p.H * 0.8), 0, 1) ** 1.5;
    const sc = 0.75 + 0.25 * near;
    p.soft.style.opacity = near.toFixed(3);
    p.soft.style.transform =
      `translate3d(${(up * 0.1).toFixed(2)}px, ${(up * 0.05).toFixed(2)}px, 0) scale(${(sc * (1 + squash * 0.5)).toFixed(4)}, ${sc.toFixed(4)})`;
  }
  // Contact occlusion only exists at touch: gone a few percent off the ground (so it blinks out on
  // each hop) and it spreads under the squash.
  if (p.contact) {
    const touch = clamp(1 - up / (p.H * 0.06), 0, 1) ** 2;
    p.contact.style.opacity = touch.toFixed(3);
    p.contact.style.transform = `scale(${(1 + squash * 0.9).toFixed(4)}, ${(1 + squash * 0.3).toFixed(4)})`;
  }
}

function settled(p) {
  return p.phase === 'rest' && Math.abs(p.d) < 0.002 && Math.abs(p.dv) < 0.05 &&
    Math.abs(p.r) < 0.05 && Math.abs(p.w) < 0.05 && Math.abs(p.wv) < 0.5;
}

/**
 * Page load is busy (fonts, the globe module, layout). A drop that starts during a long frame
 * visibly hitches, so wait until the main thread gives us a few smooth frames (max ~1s).
 */
function waitForCalm(need = 3, budget = 1000) {
  return new Promise((resolve) => {
    const start = performance.now();
    let last = start, smooth = 0;
    const f = (now) => {
      smooth = now - last < 34 ? smooth + 1 : 0;
      last = now;
      if (smooth >= need || now - start > budget) resolve();
      else requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
}

function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
