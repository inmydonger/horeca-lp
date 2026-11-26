/*
 * Clay globe for the Origin section.
 * Land shapes come from world.svg — Map created by Simplemaps.com
 * (MIT License, Copyright (c) 2020 Pareto Softare, LLC DBA Simplemaps.com).
 * Textures are baked offline by tools/bake-globe.mjs into public/globe/.
 *
 * The sphere is three.js. Orbits, routes and pins are drawn as 2D vector
 * strokes on an overlay canvas (projected from 3D every frame) so they stay
 * thin and crisp, with fading comet trails instead of solid rings.
 */
import {
  WebGLRenderer, Scene, PerspectiveCamera, HemisphereLight, DirectionalLight,
  Group, Mesh, SphereGeometry, MeshStandardMaterial, TextureLoader,
  SRGBColorSpace, Vector3, Vector2, Matrix4, Euler, RepeatWrapping, LinearMipmapLinearFilter,
} from 'three';

const ORANGE = '#E54E26';
const BLUE = '#224096';
const JKT = [-6.2, 106.85];
// Origins. Japan is shown in the design but still needs confirmation; NZ, USA and Brazil are placeholders for "other trusted origins".
const ORIGINS = [
  { key: 'au', name: 'Australia', p: [-27.47, 153.03], label: true },
  { key: 'perth', name: 'Perth', p: [-31.95, 115.86] },
  { key: 'jp', name: 'Japan', p: [35.68, 139.69], label: true },
  { key: 'nz', name: 'New Zealand', p: [-41.29, 174.78], far: true },
];

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const seg = (p, a, b) => clamp((p - a) / (b - a), 0, 1);
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

// lat/lon → point on a sphere of radius r (matches three's SphereGeometry UVs)
function ll(lat, lon, r = 1) {
  const la = (lat * Math.PI) / 180, ph = ((lon + 180) * Math.PI) / 180;
  return new Vector3(-Math.cos(ph) * Math.cos(la) * r, Math.sin(la) * r, Math.sin(ph) * Math.cos(la) * r);
}

export function createGlobe({ canvas, overlay, labels, reduceMotion = false, base = '' }) {
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = SRGBColorSpace;

  const scene = new Scene();
  const cam = new PerspectiveCamera(30, 1, 0.1, 100);
  cam.position.set(0, 0, 7.5);

  scene.add(new HemisphereLight(0xfff6e8, 0xc2ae92, 1.55));
  const key = new DirectionalLight(0xfff1de, 2.4);
  key.position.set(-3.5, 4, 5);
  scene.add(key);
  const fill = new DirectionalLight(0xe2eaff, 0.55);
  fill.position.set(4, -1.5, 3);
  scene.add(fill);

  const world = new Group(); // position + scale
  const spin = new Group();  // tilt + rotation
  world.add(spin);
  scene.add(world);

  const loader = new TextureLoader();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const tex = (url, srgb) => {
    const t = loader.load(url);
    t.wrapS = RepeatWrapping;
    t.anisotropy = Math.min(8, maxAniso);
    t.minFilter = LinearMipmapLinearFilter;
    if (srgb) t.colorSpace = SRGBColorSpace;
    return t;
  };
  const mat = new MeshStandardMaterial({
    map: tex(`${base}globe/color.webp`, true),
    normalMap: tex(`${base}globe/normal.webp`),
    normalScale: new Vector2(1.15, 1.15), // positive Y: land is raised (embossed), not pressed in
    displacementMap: tex(`${base}globe/height.png`),
    displacementScale: 0.014,
    roughness: 0.92,
    metalness: 0,
  });
  const globe = new Mesh(new SphereGeometry(1, 256, 128), mat);
  spin.add(globe);

  // ---------- routes (in spin-local space) ----------
  const jLocal = ll(JKT[0], JKT[1], 1.012);
  const routes = ORIGINS.map((o, i) => {
    const a = ll(o.p[0], o.p[1], 1).normalize();
    const b = ll(JKT[0], JKT[1], 1).normalize();
    const ang = a.angleTo(b);
    const lift = 0.05 + 0.24 * (ang / Math.PI);
    const pts = [];
    const n = 96;
    for (let k = 0; k <= n; k++) {
      const t = k / n, s = Math.sin(ang);
      const v = a.clone().multiplyScalar(Math.sin((1 - t) * ang) / s).add(b.clone().multiplyScalar(Math.sin(t * ang) / s));
      pts.push(v.multiplyScalar(1.012 + lift * Math.sin(Math.PI * t)));
    }
    return { o, pts, origin: ll(o.p[0], o.p[1], 1.012), delay: i * 0.018, phase: i * 0.37 };
  });

  // ---------- satellites on tilted orbits (in world-local space, i.e. they don't spin with the globe) ----------
  const orbits = [
    { r: 1.26, rot: new Euler(1.12, 0, 0.38), speed: 0.55 },
    { r: 1.36, rot: new Euler(-0.92, 0, -0.52), speed: 0.42 },
    { r: 1.2, rot: new Euler(0.28, 0, 1.22), speed: 0.66 },
  ].map((d) => ({ ...d, m: new Matrix4().makeRotationFromEuler(d.rot) }));
  const sats = ORIGINS.map((o, i) => ({ orbit: orbits[i % 3], phase: (i / 3 | 0) * Math.PI + i * 0.9 }));

  // ---------- labels ----------
  const mkLabel = (txt, cls) => { const d = document.createElement('div'); d.className = 'globe-label ' + (cls || ''); d.textContent = txt; labels.appendChild(d); return d; };
  const jLabel = mkLabel('Jakarta', 'left');
  const oLabels = routes.filter((r) => r.o.label).map((r) => ({ r, el: mkLabel(r.o.name) }));

  // ---------- layout ----------
  const ctx = overlay.getContext('2d');
  let vw = 1, vh = 1, dpr = 1, visH = 1, visW = 1;
  function resize() {
    const r = canvas.getBoundingClientRect();
    vw = Math.max(1, r.width); vh = Math.max(1, r.height);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setSize(vw, vh, false);
    overlay.width = Math.round(vw * dpr); overlay.height = Math.round(vh * dpr);
    cam.aspect = vw / vh; cam.updateProjectionMatrix();
    visH = 2 * cam.position.z * Math.tan((cam.fov * Math.PI) / 360);
    visW = visH * cam.aspect;
  }
  resize();

  // Orientation that shows Jakarta left of centre with Japan up-right and Australia down-right.
  const FACE_LON = 120, FACE_LAT = 0;
  const fv = ll(FACE_LAT, FACE_LON, 1);
  const faceY = Math.atan2(-fv.x, fv.z);
  const faceX = (FACE_LAT * Math.PI) / 180;

  // ---------- projection helpers ----------
  const tmp = new Vector3(), tmp2 = new Vector3();
  const toScreen = (v) => { tmp2.copy(v).project(cam); return [(tmp2.x * 0.5 + 0.5) * vw, (-tmp2.y * 0.5 + 0.5) * vh]; };
  // Is a world-space point hidden behind the globe?
  function occluded(P) {
    const C = cam.position, O = world.position, R = world.scale.x * 0.995;
    const d = tmp.copy(P).sub(C); const L = d.length(); d.divideScalar(L);
    const oc = new Vector3().copy(C).sub(O);
    const b = oc.dot(d), c = oc.lengthSq() - R * R, disc = b * b - c;
    if (disc < 0) return false;
    const t = -b - Math.sqrt(disc);
    return t > 0 && t < L - 1e-3;
  }
  const spinToWorld = (v, out = new Vector3()) => out.copy(v).applyMatrix4(spin.matrixWorld);

  // Draw a polyline with a fading trail: alpha ramps from a0 (tail) to a1 (head).
  function trail(points, a0, a1, width, color, dash) {
    ctx.lineCap = 'round';
    ctx.strokeStyle = color;
    ctx.lineWidth = width * dpr;
    if (dash) ctx.setLineDash(dash.map((x) => x * dpr)); else ctx.setLineDash([]);
    const n = points.length;
    for (let i = 1; i < n; i++) {
      const p0 = points[i - 1], p1 = points[i];
      if (p0.hidden || p1.hidden) continue;
      const t = i / (n - 1);
      ctx.globalAlpha = a0 + (a1 - a0) * Math.pow(t, 1.6);
      if (ctx.globalAlpha <= 0.004) continue;
      ctx.beginPath(); ctx.moveTo(p0.x * dpr, p0.y * dpr); ctx.lineTo(p1.x * dpr, p1.y * dpr); ctx.stroke();
    }
    ctx.globalAlpha = 1; ctx.setLineDash([]);
  }
  const proj = (worldV) => { const [x, y] = toScreen(worldV); return { x, y, hidden: occluded(worldV) }; };
  function dot(x, y, r, fill, stroke, sw, alpha = 1) {
    ctx.globalAlpha = alpha;
    ctx.beginPath(); ctx.arc(x * dpr, y * dpr, r * dpr, 0, Math.PI * 2);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.lineWidth = sw * dpr; ctx.strokeStyle = stroke; ctx.stroke(); }
    ctx.globalAlpha = 1;
  }
  function orbitPoint(orbit, ang, out = new Vector3()) {
    out.set(Math.cos(ang) * orbit.r, 0, Math.sin(ang) * orbit.r).applyMatrix4(orbit.m);
    return out.multiplyScalar(world.scale.x).add(world.position);
  }

  // ---------- state ----------
  let progress = reduceMotion ? 1 : 0, pSm = progress;
  let spinA = -1.4, last = performance.now(), running = false, raf = 0, clock = 0;
  const narrow = () => vw < 820;

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now; clock += dt;
    pSm += (progress - pSm) * Math.min(1, dt * 8);
    const p = reduceMotion ? 1 : pSm;

    // K1 → K3 placement (world units)
    const unit = visH; // 1 = full viewport height
    const k1 = narrow() ? { x: 0, y: -0.02 * unit, s: Math.min(0.5 * visW, 0.36 * unit) } : { x: 0, y: -0.03 * unit, s: 0.52 * unit };
    const k3 = narrow() ? { x: 0, y: -0.2 * unit, s: Math.min(0.46 * visW, 0.27 * unit) } : { x: 0.21 * visW, y: 0, s: 0.4 * unit };
    const m = ease(seg(p, 0.22, 0.6));
    world.position.set(k1.x + (k3.x - k1.x) * m, k1.y + (k3.y - k1.y) * m, 0);
    world.scale.setScalar(k1.s + (k3.s - k1.s) * m);

    // rotation: free spin (K1) → face Asia-Pacific (K2) → gentle idle sway (K3)
    if (!reduceMotion) spinA += dt * 0.28;
    const rest = seg(p, 0.9, 1);
    const sway = reduceMotion ? 0 : Math.sin(clock * 0.3) * 0.22 * rest;
    const target = faceY + sway;
    const off = ((((spinA - target) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    spin.rotation.order = 'XYZ';
    spin.rotation.y = target + off * (1 - m);
    spin.rotation.x = faceX * m + 0.28 * (1 - m);
    spin.rotation.z = -0.06 * (1 - m);
    scene.updateMatrixWorld(true);
    renderer.render(scene, cam);

    // ---------- overlay ----------
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const satOn = seg(p, 0.3, 0.44);
    const drop = ease(seg(p, 0.6, 0.68));
    const scaleK = world.scale.x / (0.4 * unit); // keeps stroke sizes proportional

    // satellites with comet trails
    if (satOn > 0 && drop < 1) {
      sats.forEach((s, i) => {
        const o = s.orbit;
        const head = clock * o.speed + s.phase;
        const tl = [];
        const N = 42, span = 1.25; // trail length in radians
        for (let k = 0; k <= N; k++) {
          const a = head - span + (k / N) * span;
          const P = orbitPoint(o, a);
          if (drop > 0) P.lerp(spinToWorld(routes[i].origin), drop);
          tl.push(proj(P));
        }
        trail(tl, 0, satOn * (1 - drop * 0.5), 1.7, ORANGE);
        const h = tl[tl.length - 1];
        if (!h.hidden) dot(h.x, h.y, 3.2 * Math.max(0.7, scaleK), ORANGE, null, 0, satOn);
      });
    }

    // routes: drawn origin → Jakarta with a comet head; afterwards a faint base line with travelling pulses
    const originVis = seg(p, 0.64, 0.7);
    routes.forEach((r, i) => {
      const t = easeOut(seg(p, 0.68 + r.delay, 0.86 + r.delay));
      const pts = r.pts.map((v) => proj(spinToWorld(v)));
      if (t > 0) {
        const n = Math.max(2, Math.round(t * (pts.length - 1)) + 1);
        const drawn = pts.slice(0, n);
        const done = t >= 1;
        // base line fades from origin to Jakarta, never a solid band
        trail(drawn, done ? 0.16 : 0, done ? 0.8 : 1, r.o.far ? 1.3 : 1.7, ORANGE, r.o.far ? [3, 5] : null);
        if (!done) { const h = drawn[drawn.length - 1]; if (!h.hidden) dot(h.x, h.y, 3, ORANGE); }
      }
      // resting pulses (shipments) with fade trails
      if (rest > 0 && !reduceMotion) {
        const cyc = (clock * 0.18 + r.phase) % 1;
        const headI = Math.round(cyc * (pts.length - 1));
        const tailI = Math.max(0, headI - 22);
        const seg2 = pts.slice(tailI, headI + 1);
        if (seg2.length > 1) {
          trail(seg2, 0, rest, 2.2, ORANGE);
          const h = seg2[seg2.length - 1]; if (!h.hidden) dot(h.x, h.y, 2.6, ORANGE, null, 0, rest);
        }
      }
      // origin pin
      if (originVis > 0) {
        const o = proj(spinToWorld(r.origin));
        if (!o.hidden) dot(o.x, o.y, (r.o.far ? 3.5 : 5.5) * Math.max(0.75, scaleK), '#fff', ORANGE, 2, originVis);
        r.screen = o;
      }
    });

    // Jakarta pin + pulse
    const jIn = seg(p, 0.55, 0.7);
    const jw = spinToWorld(jLocal);
    const J = proj(jw);
    if (jIn > 0 && !J.hidden) {
      const pr = seg(p, 0.86, 0.96);
      if (pr > 0) {
        const ph = reduceMotion ? 0.5 : (clock * 0.6) % 1;
        dot(J.x, J.y, 10 + 18 * ph, BLUE, null, 0, 0.22 * (1 - ph) * pr);
      }
      dot(J.x, J.y, 14 * Math.max(0.75, scaleK), BLUE, null, 0, 0.16 * jIn);
      dot(J.x, J.y, 7 * Math.max(0.75, scaleK), BLUE, '#fff', 2.5, jIn);
    }

    // labels
    const labelOn = seg(p, 0.7, 0.82);
    jLabel.style.transform = `translate(${J.x - 16}px, ${J.y}px) translate(-100%, -50%)`;
    jLabel.style.opacity = J.hidden ? 0 : labelOn;
    oLabels.forEach(({ r, el }) => {
      const s = r.screen || { x: -999, y: -999, hidden: true };
      el.style.transform = `translate(${s.x + 14}px, ${s.y}px) translate(0, -50%)`;
      el.style.opacity = s.hidden ? 0 : labelOn;
    });

    if (running) raf = requestAnimationFrame(frame);
  }

  function start() { if (running) return; running = true; last = performance.now(); raf = requestAnimationFrame(frame); }
  function stop() { running = false; cancelAnimationFrame(raf); }
  window.addEventListener('resize', resize);

  return {
    setProgress(p) { progress = clamp(p, 0, 1); },
    start, stop, resize,
    renderOnce() { last = performance.now(); frame(last); },
  };
}
