import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';
import { dict } from './i18n.js';

gsap.registerPlugin(ScrollTrigger);

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
document.documentElement.classList.add('js');

/* ---------------- i18n ---------------- */
let lang = 'en';
function applyLang(next) {
  lang = dict[next] ? next : 'en';
  const t = dict[lang];
  document.documentElement.lang = lang;
  $$('[data-i18n]').forEach((el) => { const v = t[el.dataset.i18n]; if (v != null) el.textContent = v; });
  $$('[data-i18n-ph]').forEach((el) => { const v = t[el.dataset.i18nPh]; if (v != null) el.placeholder = v; });
  $$('[data-i18n-alt]').forEach((el) => { const v = t[el.dataset.i18nAlt]; if (v != null) el.alt = v; });
  $$('[data-i18n-aria]').forEach((el) => { const v = t[el.dataset.i18nAria]; if (v != null) el.setAttribute('aria-label', v); });
  document.title = t['meta.title'];
  $('meta[name="description"]')?.setAttribute('content', t['meta.desc']);
  $$('.lang button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
  store.set('lang', lang);
  proofText = t['proof.num'];
  ScrollTrigger.refresh();
}
let proofText = dict.en['proof.num'];
const urlLang = new URLSearchParams(location.search).get('lang');
applyLang(urlLang || store.get('lang') || 'en');
$$('.lang button').forEach((b) => b.addEventListener('click', () => applyLang(b.dataset.lang)));

/* ---------------- smooth scroll ---------------- */
let lenis = null;
if (!reduce) {
  lenis = new Lenis({ duration: 1.1, easing: (t) => 1 - Math.pow(1 - t, 4), smoothWheel: true });
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add((time) => lenis.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);
}
$$('a[href^="#"]').forEach((a) => a.addEventListener('click', (e) => {
  const id = a.getAttribute('href');
  const target = id === '#top' ? 0 : $(id);
  if (target == null) return;
  e.preventDefault();
  if (lenis) lenis.scrollTo(target, { offset: id === '#apply' ? 0 : -8 });
  else if (target === 0) window.scrollTo(0, 0);
  else target.scrollIntoView();
  if (id !== '#top') history.replaceState(null, '', id);
}));

/* ---------------- nav ---------------- */
const nav = $('#nav');
const setPill = () => nav.classList.toggle('is-pill', window.scrollY > 40);
setPill();
window.addEventListener('scroll', setPill, { passive: true });
$$('.nav__links a').forEach((a) => {
  const sec = $(a.getAttribute('href'));
  if (!sec) return;
  ScrollTrigger.create({ trigger: sec, start: 'top 50%', end: 'bottom 50%', onToggle: (s) => a.setAttribute('aria-current', String(s.isActive)) });
});

/* ---------------- hero ---------------- */
const pieces = $$('#heroVisual .hv');
if (!reduce) {
  const tl = gsap.timeline({ defaults: { ease: 'expo.out' } });
  tl.from('.hero__title .line', { yPercent: 40, opacity: 0, duration: 1.1, stagger: 0.08 })
    .from('.hero__lead', { y: 16, opacity: 0, duration: 1 }, 0.25)
    .from('.hero__ctas > *', { y: 16, opacity: 0, duration: 0.9, stagger: 0.06 }, 0.35)
    .from(pieces, {
      y: (i, el) => 60 + 40 * Number(el.dataset.depth || 0.5), opacity: 0, scale: 0.94,
      duration: 1.4, stagger: { each: 0.04, from: 'start' }, ease: 'expo.out',
    }, 0.1);

  // scroll parallax: deeper pieces travel further
  pieces.forEach((el) => {
    const d = Number(el.dataset.depth || 0.5);
    gsap.to(el, { yPercent: -28 * d, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });
  });

  // pointer parallax on desktop
  if (finePointer) {
    const movers = pieces.map((el) => ({ d: Number(el.dataset.depth || 0.5), x: gsap.quickTo(el, 'x', { duration: 1.2, ease: 'power3.out' }), y: gsap.quickTo(el, 'y', { duration: 1.2, ease: 'power3.out' }) }));
    $('.hero').addEventListener('pointermove', (e) => {
      const nx = e.clientX / innerWidth - 0.5, ny = e.clientY / innerHeight - 0.5;
      movers.forEach((m) => { m.x(nx * -26 * m.d); m.y(ny * -18 * m.d); });
    });
  }
}

/* ---------------- origin globe ---------------- */
// The globe module is owned by a separate design thread; it plugs in through createGlobe().
(async () => {
  const canvas = $('#globeGl');
  let globe = null;
  try {
    const { createGlobe } = await import('./globe.js');
    globe = createGlobe({ canvas, overlay: $('#globeOv'), labels: $('#globeLabels'), reduceMotion: reduce, base: import.meta.env.BASE_URL });
  } catch (err) {
    console.warn('[globe] not available', err);
  }
  if (globe?.ready) {
    canvas.style.opacity = 0;
    globe.ready.then(() => gsap.to(canvas, { opacity: 1, duration: reduce ? 0 : 0.8, ease: 'power2.out' }));
  }
  const copy = $('#originCopy');
  const setCopy = (p) => {
    const t = gsap.utils.clamp(0, 1, (p - 0.3) / 0.25);
    const e = 1 - Math.pow(1 - t, 3);
    copy.style.opacity = e;
    copy.style.translate = `${(1 - e) * -24}px 0`;
  };
  setCopy(reduce ? 1 : 0);
  ScrollTrigger.create({
    trigger: '#originTrack', start: 'top top', end: 'bottom bottom',
    onUpdate: (s) => { globe?.setProgress(reduce ? 1 : s.progress); if (!reduce) setCopy(s.progress); },
  });
  ScrollTrigger.create({
    trigger: '#originTrack', start: 'top bottom', end: 'bottom top',
    onToggle: (s) => { if (!globe) return; if (s.isActive && !reduce) globe.start(); else { globe.stop(); globe.renderOnce(); } },
  });
  if (reduce) { globe?.setProgress(1); globe?.renderOnce(); }
})();

/* ---------------- range ---------------- */
// Mouse: hover/focus reveals the title (meat lifts, title slides down from behind it).
// Touch: the card nearest the middle of the screen reveals as you scroll; tap toggles too.
const cuts = $$('.cut');
const setCut = (c, on) => { c.classList.toggle('is-on', on); c.setAttribute('aria-pressed', String(on)); };
cuts.forEach((c, i) => {
  setCut(c, false);
  if (finePointer) {
    c.addEventListener('pointerenter', () => setCut(c, true));
    c.addEventListener('pointerleave', () => { if (document.activeElement !== c) setCut(c, false); });
    c.addEventListener('focus', () => setCut(c, true));
    c.addEventListener('blur', () => setCut(c, false));
  } else {
    c.addEventListener('click', () => { const on = !c.classList.contains('is-on'); cuts.forEach((o) => setCut(o, false)); setCut(c, on); });
    ScrollTrigger.create({ trigger: c, start: 'top 65%', end: 'bottom 35%', onToggle: (s) => setCut(c, s.isActive) });
  }
  if (!reduce) {
    gsap.from(c, { y: 60, opacity: 0, duration: 1.2, ease: 'expo.out', delay: i * 0.08, scrollTrigger: { trigger: '.cards', start: 'top 85%' } });
    // Levitation keeps running during hover; the hover lift is on `translate`, so the two add up.
    gsap.to($('.cut__meat', c), { y: -10, duration: 2.6 + i * 0.3, ease: 'sine.inOut', yoyo: true, repeat: -1, delay: i * 0.5 });
    gsap.to($('.cut__shadow', c), { scaleX: 0.9, duration: 2.6 + i * 0.3, ease: 'sine.inOut', yoyo: true, repeat: -1, delay: i * 0.5 });
  }
});

/* ---------------- cold chain ---------------- */
const steps = $$('#coldSteps .step');
const visuals = $$('.cold__visual .cv');
const stepList = $('#coldSteps');
let coldIdx = -1;
function setCold(i) {
  if (i === coldIdx) return;
  coldIdx = i;
  steps.forEach((s, k) => s.classList.toggle('is-active', k === i));
  visuals.forEach((v, k) => { v.classList.toggle('is-active', k === i); v.classList.toggle('is-past', k < i); });
  requestAnimationFrame(() => {
    const s = steps[i];
    stepList.style.setProperty('--bar-y', `${s.offsetTop}px`);
    stepList.style.setProperty('--bar-h', `${s.offsetHeight}px`);
  });
}
setCold(0);
ScrollTrigger.create({
  trigger: '#coldTrack', start: 'top top', end: 'bottom bottom',
  onUpdate: (s) => setCold(Math.min(steps.length - 1, Math.floor(s.progress * steps.length * 0.999))),
});
window.addEventListener('resize', () => { const i = coldIdx; coldIdx = -1; setCold(i); });

/* ---------------- ordering stage ---------------- */
// Real screens: the seller sees live products, the kitchen taps "Place Order" in the app,
// the order lands at the top of the seller's order list and the kitchen gets notifications.
const press = (el, t = 160) => { el.classList.add('is-press'); setTimeout(() => el.classList.toggle('is-press', false), t); };
const show = (el, on) => el && el.classList.toggle('is-on', on);
if (!reduce) {
  const st = $('#orderStage');
  const phone = $('#orderPhone');
  const btn = $('#placeOrder');
  const shotP = $('#shotProducts'), shotO = $('#shotOrders');
  const newRow = $('#newRow');
  const toasts = $$('.toast', st);
  gsap.from($('.browser', st), { y: 60, opacity: 0, duration: 1.2, ease: 'expo.out', scrollTrigger: { trigger: st, start: 'top 85%' } });
  gsap.from(phone, { y: 100, opacity: 0, duration: 1.3, ease: 'expo.out', delay: 0.12, scrollTrigger: { trigger: st, start: 'top 85%' } });
  gsap.to(phone, { yPercent: -8, ease: 'none', scrollTrigger: { trigger: st, start: 'top bottom', end: 'bottom top', scrub: true } });

  const loop = gsap.timeline({ paused: true, repeat: -1, repeatDelay: 1.2, defaults: { ease: 'expo.out' } });
  loop.set(toasts, { opacity: 0, y: 16, scale: 0.97 })
    .set(newRow, { opacity: 0 })
    .call(() => { show(shotP, true); show(shotO, false); }, null, 0)
    .call(() => press(btn, 220), null, 1.2)
    .call(() => { show(shotO, true); show(shotP, false); }, null, 1.6)
    .to(newRow, { opacity: 1, duration: 0.5 }, 2.1)
    .to(toasts[1], { opacity: 1, y: 0, scale: 1, duration: 0.7 }, 2.4)
    .to(toasts[0], { opacity: 1, y: 0, scale: 1, duration: 0.7 }, 3.4)
    .to(newRow, { opacity: 0, duration: 1.2, ease: 'power1.out' }, 4.6)
    .to(toasts, { opacity: 0, y: -8, duration: 0.5, stagger: 0.08, ease: 'power2.in' }, 6.6)
    .to({}, { duration: 0.3 });
  ScrollTrigger.create({ trigger: st, start: 'top 75%', end: 'bottom top', onToggle: (s) => (s.isActive ? loop.play() : loop.pause()) });
}

/* ---------------- paperwork stage ---------------- */
// Seller clicks "PDF Invoice"; the invoice opens in the kitchen's app, where they download the PDF.
if (!reduce) {
  const st = $('#paperStage');
  const browser = $('.browser', st);
  const cursor = $('#paperCursor');
  const pdf = $('#pdfBtn');
  const inv = $('#shotAppInvoice');
  const dl = $('#dlBtn');
  gsap.from($$('.device', st), { y: 60, opacity: 0, duration: 1.2, ease: 'expo.out', stagger: 0.12, scrollTrigger: { trigger: st, start: 'top 85%' } });
  let loop;
  const build = () => {
    const wasActive = loop && loop.isActive();
    loop?.kill();
    const b = browser.getBoundingClientRect(), p = pdf.getBoundingClientRect();
    const tx = p.left - b.left + p.width * 0.55, ty = p.top - b.top + p.height * 0.45;
    loop = gsap.timeline({ paused: true, repeat: -1, repeatDelay: 1.2 });
    loop.set(cursor, { x: b.width * 0.45, y: b.height * 0.75, opacity: 0 })
      .call(() => show(inv, false), null, 0)
      .to(cursor, { opacity: 1, duration: 0.3 }, 0.2)
      .to(cursor, { x: tx, y: ty, duration: 1.1, ease: 'power3.inOut' }, 0.3)
      .call(() => press(pdf, 180), null, 1.45)
      .to(cursor, { opacity: 0, duration: 0.4 }, 2.1)
      .call(() => show(inv, true), null, 1.9)
      .call(() => press(dl, 200), null, 3.5)
      .to({}, { duration: 2.2 });
    if (wasActive) loop.play();
  };
  build();
  ScrollTrigger.addEventListener('refreshInit', () => loop.pause());
  ScrollTrigger.addEventListener('refresh', build);
  ScrollTrigger.create({ trigger: st, start: 'top 75%', end: 'bottom top', onToggle: (s) => (s.isActive ? loop.play() : loop.pause()) });

  gsap.set('.bc', { opacity: 0 });
  ScrollTrigger.batch('.bc', {
    start: 'top 90%', once: true,
    onEnter: (els) => gsap.fromTo(els, { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: 1, ease: 'expo.out', stagger: 0.08 }),
  });
} else {
  show($('#shotAppInvoice'), true);
}

/* ---------------- proof pyramid ---------------- */
// 24 rows, 1 + 2 + … + 24 = 300 ribeyes, all from ONE image.
const pyr = $('#pyramid');
const ROWS = 24, UNIT = 'img/ribeye-unit.webp';
const units = [];
{
  const frag = document.createDocumentFragment();
  // geometry in "design units" where the pyramid is 1000 wide and 470 tall
  const W = 1000, H = 470, stepX = 39, unitW = 56, stepY = 19, top = 8;
  for (let r = 0; r < ROWS; r++) {
    const n = r + 1;
    const rowW = (n - 1) * stepX + unitW;
    for (let k = 0; k < n; k++) {
      const img = new Image();
      img.className = 'u'; img.alt = ''; img.decoding = 'async';
      img.src = import.meta.env.BASE_URL + UNIT;
      img.style.left = `${((W - rowW) / 2 + k * stepX) / W * 100}%`;
      img.style.top = `${(top + r * stepY) / H * 100}%`;
      img.style.width = `${unitW / W * 100}%`;
      img.dataset.row = r;
      frag.appendChild(img);
      units.push(img);
    }
  }
  pyr.appendChild(frag);
}
const proofEl = $('#proofNum');
function fmtProof(v) {
  const n = Math.round(v);
  return proofText.replace(/300/, String(n));
}
if (!reduce) {
  const byRow = (r) => units.filter((u) => +u.dataset.row === r);
  const tl = gsap.timeline({ scrollTrigger: { trigger: pyr, start: 'top 85%', end: 'bottom 60%', scrub: 0.6 } });
  for (let r = ROWS - 1; r >= 0; r--) {
    tl.from(byRow(r), { y: -60, opacity: 0, duration: 1, ease: 'power3.out', stagger: { each: 0.03, from: 'random' } }, (ROWS - 1 - r) * 0.25);
  }
  const counter = { v: 0 };
  tl.to(counter, { v: 300, duration: tl.duration(), ease: 'power1.inOut', onUpdate: () => { proofEl.textContent = fmtProof(counter.v); } }, 0);
  gsap.from('.proof__head', { y: 30, opacity: 0, duration: 1.2, ease: 'expo.out', scrollTrigger: { trigger: '.proof', start: 'top 80%' } });
}

/* ---------------- section reveals ---------------- */
if (!reduce) {
  const els = $$('.range .head > *, .ordering .head > *, .paperwork .head > *, .cold__copy > *:not(.steps), .join__how > *, .form, .footer__col');
  els.forEach((el) => el.setAttribute('data-reveal', ''));
  ScrollTrigger.batch(els, {
    start: 'top 88%', once: true,
    onEnter: (b) => gsap.to(b, { opacity: 1, y: 0, duration: 1.1, ease: 'expo.out', stagger: 0.08 }),
  });
}

/* ---------------- form ---------------- */
const form = $('#applyForm');
const checks = {
  business: (v) => v.trim().length >= 2,
  type: (v) => !!v,
  contact: (v) => v.trim().length >= 2,
  whatsapp: (v) => { const d = v.replace(/\D/g, ''); return /^[+\d][\d\s-]*$/.test(v.trim()) && d.length >= 9 && d.length <= 15; },
  area: (v) => !!v,
  volume: (v) => !!v,
};
let submitted = false;
function validate(field) {
  const ok = checks[field.name]?.(field.value) ?? true;
  const wrap = field.closest('.field');
  wrap.classList.toggle('is-invalid', !ok);
  field.setAttribute('aria-invalid', String(!ok));
  const err = $('.field__err', wrap);
  if (err) { err.id = err.id || `${field.id}-err`; field.setAttribute('aria-describedby', err.id); }
  return ok;
}
$$('input, select', form).forEach((f) => {
  f.addEventListener('input', () => { if (submitted || f.closest('.field').classList.contains('is-invalid')) validate(f); });
  f.addEventListener('change', () => { if (submitted) validate(f); });
});
form.addEventListener('submit', (e) => {
  e.preventDefault();
  submitted = true;
  const fields = $$('input, select', form);
  const bad = fields.filter((f) => !validate(f));
  if (bad.length) { bad[0].focus(); return; }
  const btn = $('button[type="submit"]', form);
  btn.disabled = true;
  btn.textContent = dict[lang]['form.sending'];
  // No backend yet: the endpoint is still to be decided with the team.
  setTimeout(() => {
    const done = $('.form__done', form);
    done.hidden = false;
    if (!reduce) gsap.from(done, { opacity: 0, scale: 0.98, duration: 0.6, ease: 'expo.out' });
    done.setAttribute('tabindex', '-1');
    done.focus({ preventScroll: true });
  }, 700);
});

/* fonts and images change layout: refresh once everything has loaded */
window.addEventListener('load', () => ScrollTrigger.refresh());
document.fonts?.ready.then(() => ScrollTrigger.refresh());
