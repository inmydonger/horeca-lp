/*
 * Clay globe for the Origin section.
 *
 * Land shapes come from world.svg, Map created by Simplemaps.com
 * (MIT License, Copyright (c) 2020 Pareto Softare, LLC DBA Simplemaps.com).
 * tools/bake-globe.mjs turns it into ONE texture, public/globe/land.png:
 *   R = signed distance to the coast (texels), G = terracotta tone mask.
 *
 * The sphere is a custom three.js shader:
 *   - the coastline is cut from the distance field per pixel, so it stays
 *     sharp at any size (no blur, no texture softness);
 *   - land is a RAISED clay slab: rounded shoulder, a crease where it meets
 *     the sea, and a real cast shadow towards the lower right;
 *   - fine clay grain is procedural, so it is crisp at any zoom.
 * Comets (orbiting satellites, route draws, resting pulses) are GPU point
 * particles in the same WebGL scene: a bright head that sheds grains which
 * drift, shrink and fade, hidden correctly behind the globe.
 * The overlay canvas holds the vector bits: faint route lines, pins, ground shadow.
 *
 * API
 *   const g = createGlobe({ canvas, overlay, labels, reduceMotion, base })
 *   g.setProgress(p, { immediate })  // 0..1 scroll progress of the pinned section
 *   g.start() / g.stop()             // run / pause the render loop
 *   g.resize()                       // call if the canvas box changes without a window resize
 *   g.renderOnce()                   // draw one frame now
 *   g.ready                          // Promise, resolves once the texture is on the GPU
 *   g.destroy()                      // free GPU resources and listeners
 */
import {
  WebGLRenderer, Scene, PerspectiveCamera, Group, Mesh, SphereGeometry, ShaderMaterial,
  TextureLoader, Vector3, Matrix4, Euler, Color, RepeatWrapping, ClampToEdgeWrapping,
  BufferGeometry, BufferAttribute, Points, DynamicDrawUsage,
  LinearMipmapLinearFilter, LinearFilter, NoColorSpace,
} from 'three';

const ORANGE = '#E54E26';
const BLUE = '#224096';
const JKT = [-6.2, 106.85];
// Origins. Japan is in the design but still needs confirmation; New Zealand is a
// placeholder for "other trusted origins" (no label, dashed, quieter).
// USA and Brazil were tried: from Jakarta's side they arc in over the horizon as stray lines, so they are left out.
const ORIGINS = [
  { key: 'au', name: 'Australia', p: [-27.47, 153.03], label: true },
  { key: 'perth', name: 'Perth', p: [-31.95, 115.86] },
  { key: 'jp', name: 'Japan', p: [35.68, 139.69], label: true },
  { key: 'nz', name: 'New Zealand', p: [-41.29, 174.78], far: true },
];

// Must match tools/bake-globe.html
const LAND_RANGE = 24;   // distance range stored in R, in texels
const LAND_SIZE = 4096;  // texture width

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const seg = (p, a, b) => clamp((p - a) / (b - a), 0, 1);
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const smooth = (t) => t * t * (3 - 2 * t);

// lat/lon → point on a sphere of radius r (matches three's SphereGeometry UVs)
function ll(lat, lon, r = 1) {
  const la = (lat * Math.PI) / 180, ph = ((lon + 180) * Math.PI) / 180;
  return new Vector3(-Math.cos(ph) * Math.cos(la) * r, Math.sin(la) * r, Math.sin(ph) * Math.cos(la) * r);
}

// ---------------------------------------------------------------- shaders
const VERT = /* glsl */ `
uniform sampler2D uLand;
uniform float uRange, uBevel, uDisp;
varying vec2 vUv;
varying vec3 vObj;
varying vec3 vWorld;
float prof(float sd){ float x = clamp(sd / uBevel, 0.0, 1.0); float k = 1.0 - x; return 1.0 - k*k*k; }
void main(){
  vUv = uv;
  vec3 n = normalize(position);
  vObj = n;
  // silhouette relief: a softened (mip) height so the limb shows the slabs without stair-steps
  float sd = (textureLod(uLand, uv, 3.0).r - 0.5) * 2.0 * uRange;
  vec3 p = n * (1.0 + uDisp * prof(sd));
  vec4 w = modelMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FRAG = /* glsl */ `
precision highp float;
uniform mat4 modelMatrix;
uniform sampler2D uLand;
uniform float uRange, uBevel, uSlab, uTexel, uReady;
uniform vec3 uKeyDir, uKeyCol, uFillDir, uFillCol, uSky, uGround;
uniform vec3 uKeyObj;              // key light direction in the globe's object space (for the cast shadow)
uniform vec3 uOcean, uOceanDeep, uSand, uClay, uIce, uBg;
varying vec2 vUv;
varying vec3 vObj;
varying vec3 vWorld;

// sampled with a +1 mip bias: rounds coastline corners like pressed clay; the edge itself stays pixel-sharp
float sdAt(vec2 uv){ return (texture(uLand, uv, 1.0).r - 0.5) * 2.0 * uRange; }
float prof(float sd){ float x = clamp(sd / uBevel, 0.0, 1.0); float k = 1.0 - x; return 1.0 - k*k*k; }
float dprof(float sd){ float x = clamp(sd / uBevel, 0.0, 1.0); float k = 1.0 - x; return sd > 0.0 ? 3.0*k*k / uBevel : 0.0; }

// value noise (object space) -------------------------------------------------
float h3(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vn(vec3 x){
  vec3 i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(h3(i), h3(i+vec3(1,0,0)), f.x), mix(h3(i+vec3(0,1,0)), h3(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(h3(i+vec3(0,0,1)), h3(i+vec3(1,0,1)), f.x), mix(h3(i+vec3(0,1,1)), h3(i+vec3(1,1,1)), f.x), f.y), f.z);
}
// tangent-plane gradient of a noise octave, faded out when it would alias
vec2 ngrad(vec3 p, vec3 E, vec3 N, float freq, float fw){
  float a = 1.0 - smoothstep(0.35, 0.9, freq * fw);
  if (a <= 0.0) return vec2(0.0);
  float e = 0.35 / freq;
  float c = vn(p * freq);
  return a * vec2(vn((p + E*e) * freq) - c, vn((p + N*e) * freq) - c) / 0.35;
}

vec3 toSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0/2.4)) - 0.055, step(0.0031308, c)); }

void main(){
  vec3 n = normalize(vObj);
  float cl = max(length(n.xz), 0.02);                  // cos(latitude)
  vec3 E = vec3(n.z, 0.0, -n.x) / cl;                  // east
  vec3 N = cross(n, E);                                // north
  float fwObj = length(fwidth(vObj));                  // pixel footprint on the unit sphere

  vec4 tx = texture(uLand, vUv, 1.0);
  float sd = (tx.r - 0.5) * 2.0 * uRange;              // texels, + on land
  float px = max(fwidth(sd), 1e-3);
  float land = smoothstep(-0.6 * px, 0.6 * px, sd);    // pixel-sharp coastline

  // --- raised slab: shoulder normal from the distance-field gradient (units: texels on the sphere)
  float du = uTexel, dv = 2.0 * uTexel;
  vec2 g = vec2((sdAt(vUv + vec2(du, 0.0)) - sdAt(vUv - vec2(du, 0.0))) / (2.0 * cl),
                (sdAt(vUv + vec2(0.0, dv)) - sdAt(vUv - vec2(0.0, dv))) * 0.5);
  float slope = uSlab * dprof(sd);
  vec2 tilt = -slope * g;                              // normal leans downhill, towards the sea

  // --- clay grain: soft thumb dents on land, felt grain everywhere
  vec2 gr = ngrad(n, E, N, 26.0, fwObj) * mix(0.04, 0.09, land)
          + ngrad(n, E, N, 170.0, fwObj) * mix(0.07, 0.05, land)
          + ngrad(n, E, N, 480.0, fwObj) * 0.03;
  tilt -= gr;

  vec3 nObj = normalize(n + E * tilt.x + N * tilt.y);
  vec3 nW = normalize(mat3(modelMatrix) * nObj);
  vec3 nGeo = normalize(mat3(modelMatrix) * n);

  // --- cast shadow of the slab onto the sea (and onto lower land), marched towards the key light
  vec3 L = normalize(uKeyObj);
  float sinEl = dot(L, n);
  vec2 Lt = vec2(dot(L, E), dot(L, N));
  float lt = length(Lt);
  float shadow = 0.0;
  if (sinEl > 0.02 && lt > 1e-3) {
    vec2 dir = Lt / lt;
    float tanEl = sinEl / lt;
    float h0 = uSlab * prof(sd);
    for (int i = 1; i <= 8; i++) {
      float t = float(i) * 1.9;
      vec2 o = vec2(dir.x * t * du / cl, dir.y * t * dv);
      float diff = uSlab * prof(sdAt(vUv + o)) - (h0 + t * tanEl);
      shadow = max(shadow, smoothstep(-0.5, 3.5, diff) * (1.0 - float(i) / 10.0));
    }
  }
  // contact crease where clay meets the sea
  float crease = (1.0 - land) * exp(-max(-sd, 0.0) / 3.2);

  // --- albedo
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float mott = vn(n * 7.0) - 0.5;
  vec3 sea = mix(uOcean, uOceanDeep, clamp(0.5 - mott * 1.2, 0.0, 1.0) * 0.55);
  float tone = smoothstep(0.35, 0.65, tx.g);
  vec3 ground = mix(uSand, uClay, tone);
  ground = mix(ground, uIce, smoothstep(-1.04, -1.09, lat));
  ground *= 1.0 + (vn(n * 22.0) - 0.5) * 0.05;
  vec3 alb = mix(sea, ground, land);

  // --- light (clay: soft wrap diffuse, low broad sheen)
  float wrap = 0.45;
  float kd = max(0.0, (dot(nW, uKeyDir) + wrap) / (1.0 + wrap));
  kd *= 1.0 - 0.6 * shadow;
  float fd = max(0.0, dot(nW, uFillDir));
  vec3 amb = mix(uGround, uSky, nW.y * 0.5 + 0.5);
  float ao = 1.0 - 0.4 * crease;
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 Hh = normalize(uKeyDir + V);
  float spec = pow(max(dot(nW, Hh), 0.0), mix(9.0, 12.0, land)) * mix(0.03, 0.06, land) * (1.0 - shadow);
  vec3 col = alb * (uKeyCol * kd + uFillCol * fd + amb * ao) * mix(1.0, ao, 0.6) + uKeyCol * spec;

  // soft edge falloff so the ball sits in the cream page (no hard dark rim)
  float fres = pow(1.0 - max(dot(nGeo, V), 0.0), 3.0);
  col = mix(col, uBg, fres * 0.18);

  gl_FragColor = vec4(toSRGB(col), uReady);
}`;


// Comet particles: soft GPU point sprites, depth-tested against the globe.
const PVERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute float aHeat;
uniform float uPx;
varying float vA;
varying float vH;
void main(){
  vA = aAlpha; vH = aHeat;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uPx;
}`;
const PFRAG = /* glsl */ `
precision highp float;
uniform vec3 uCol, uHot;
varying float vA;
varying float vH;
void main(){
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = dot(c, c);
  if (d > 1.0) discard;
  float soft = exp(-d * 2.2) * (1.0 - d * d);   // gaussian grain, zero at the sprite edge
  float core = exp(-d * 9.0);
  gl_FragColor = vec4(mix(uCol, uHot, core * vH), vA * soft);
}`;

// ---------------------------------------------------------------- globe
export function createGlobe({ canvas, overlay, labels, reduceMotion = false, base = '' }) {
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);

  const scene = new Scene();
  const cam = new PerspectiveCamera(30, 1, 0.1, 100);
  cam.position.set(0, 0, 7.5);

  const world = new Group(); // position + scale
  const spin = new Group();  // tilt + rotation
  world.add(spin);
  scene.add(world);

  // ---- land texture
  const tex = new TextureLoader().load(`${base}globe/land.png`, () => { uniforms.uReady.value = 1; resolveReady(); },
    undefined, (e) => { console.warn('[globe] could not load land.png', e); resolveReady(); });
  tex.colorSpace = NoColorSpace;
  tex.wrapS = RepeatWrapping; tex.wrapT = ClampToEdgeWrapping;
  tex.minFilter = LinearMipmapLinearFilter; tex.magFilter = LinearFilter;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  let resolveReady; const ready = new Promise((r) => (resolveReady = r));

  const lin = (hex) => new Color(hex); // three converts sRGB hex to linear
  const keyDir = new Vector3(-3.5, 4.2, 5).normalize();
  const uniforms = {
    uLand: { value: tex },
    uRange: { value: LAND_RANGE },
    uTexel: { value: 1 / LAND_SIZE },
    uBevel: { value: 16.0 },        // shoulder width, texels
    uSlab: { value: 9.0 },         // slab height, texels (drives shoulder slope + shadow length)
    uDisp: { value: 9.0 * (2 * Math.PI / LAND_SIZE) },
    uReady: { value: 0 },
    uKeyDir: { value: keyDir },
    uKeyObj: { value: new Vector3() },
    uKeyCol: { value: lin(0xfff1df).multiplyScalar(0.98) },
    uFillDir: { value: new Vector3(4, -1.5, 3).normalize() },
    uFillCol: { value: lin(0xd8e4ff).multiplyScalar(0.12) },
    uSky: { value: lin(0xf7efe2).multiplyScalar(0.42) },
    uGround: { value: lin(0xb9a487).multiplyScalar(0.34) },
    uOcean: { value: lin(0x5682ba) },
    uOceanDeep: { value: lin(0x4870aa) },
    uSand: { value: lin(0xeac898) },
    uClay: { value: lin(0xd98a62) },
    uIce: { value: lin(0xf1dcb8) },
    uBg: { value: lin(0xfaf6ea) },
  };
  const mat = new ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true });
  const geo = new SphereGeometry(1, 512, 256);
  const globe = new Mesh(geo, mat);
  globe.renderOrder = 1;
  spin.add(globe);

  // ---- routes (spin-local)
  const R0 = 1.02; // just above the clay slab tops
  const jLocal = ll(JKT[0], JKT[1], R0);
  const routes = ORIGINS.map((o, i) => {
    const a = ll(o.p[0], o.p[1], 1).normalize();
    const b = ll(JKT[0], JKT[1], 1).normalize();
    const ang = a.angleTo(b);
    const lift = 0.05 + 0.5 * (ang / Math.PI);
    const n = 120, pts = [];
    for (let k = 0; k <= n; k++) {
      const t = k / n, s = Math.sin(ang);
      const v = a.clone().multiplyScalar(Math.sin((1 - t) * ang) / s).add(b.clone().multiplyScalar(Math.sin(t * ang) / s));
      pts.push(v.multiplyScalar(R0 + lift * Math.sin(Math.PI * t)));
    }
    return { o, pts, origin: ll(o.p[0], o.p[1], R0), delay: i * 0.016, phase: (i * 0.37) % 1, w: new Array(n + 1) };
  });

  // ---- satellites on tilted orbits (world-local: they don't spin with the globe)
  const orbits = [
    { r: 1.3, rot: new Euler(1.2, 0, 0.36), speed: 0.5 },
    { r: 1.44, rot: new Euler(-1.02, 0, -0.55), speed: 0.38 },
    { r: 1.22, rot: new Euler(0.8, 0.4, 1.05), speed: 0.6 },
  ].map((d) => ({ ...d, m: new Matrix4().makeRotationFromEuler(d.rot) }));
  // two satellites per orbit; the first ones drop onto the route origins, the rest fade out
  const sats = Array.from({ length: 6 }, (_, i) => ({ orbit: orbits[i % 3], phase: (i / 3 | 0) * Math.PI + i * 0.9, route: i < ORIGINS.length ? i : -1 }));


  // ---- comet particles (one dynamic point cloud for every comet)
  const PMAX = 2400;
  const pPos = new Float32Array(PMAX * 3), pSize = new Float32Array(PMAX), pAlpha = new Float32Array(PMAX), pHeat = new Float32Array(PMAX);
  const pGeo = new BufferGeometry();
  const attr = (a, n) => new BufferAttribute(a, n).setUsage(DynamicDrawUsage);
  pGeo.setAttribute('position', attr(pPos, 3));
  pGeo.setAttribute('aSize', attr(pSize, 1));
  pGeo.setAttribute('aAlpha', attr(pAlpha, 1));
  pGeo.setAttribute('aHeat', attr(pHeat, 1));
  const pMat = new ShaderMaterial({
    uniforms: { uPx: { value: 1 }, uCol: { value: new Vector3(0.898, 0.306, 0.149) }, uHot: { value: new Vector3(1.0, 0.86, 0.72) } },
    vertexShader: PVERT, fragmentShader: PFRAG, transparent: true, depthWrite: false, depthTest: true,
  });
  const points = new Points(pGeo, pMat);
  points.frustumCulled = false;
  points.renderOrder = 2;
  scene.add(points);
  let pc = 0;
  const rnd = (a, b) => { const x = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return x - Math.floor(x); };
  function emit(P, size, alpha, heat) {
    if (pc >= PMAX || alpha <= 0.003) return;
    pPos[pc * 3] = P.x; pPos[pc * 3 + 1] = P.y; pPos[pc * 3 + 2] = P.z;
    pSize[pc] = size; pAlpha[pc] = Math.min(1, alpha); pHeat[pc] = heat; pc++;
  }
  const cP = new Vector3();
  // A comet: a bright head plus grains it sheds. Each grain is born at the head, stays roughly
  // where it was shed, drifts a little sideways, shrinks and fades. Stateless (seeded), so it
  // looks the same whether you scroll forwards or back.
  function comet(id, pathAt, h, L, { n = 70, a = 1, size = 1, spread = 0.03, life = 0.9, uMin = -Infinity, sk = 1 }) {
    if (a <= 0.003) return;
    const S = world.scale.x;
    for (let i = 0; i < n; i++) {
      const seed = id * 977 + i;
      const r1 = rnd(seed, 1), r2 = rnd(seed, 2), r3 = rnd(seed, 3);
      const b = (r1 + clock / (life * (0.75 + 0.5 * r2))) % 1; // age, 0 = just shed
      const u = h - b * L * (0.85 + 0.3 * r3);
      if (u < uMin) continue;
      pathAt(u, cP);
      const j = spread * S * Math.pow(b, 1.2) * (0.35 + r3);
      cP.x += (rnd(seed, 4) - 0.5) * 2 * j; cP.y += (rnd(seed, 5) - 0.5) * 2 * j; cP.z += (rnd(seed, 6) - 0.5) * 2 * j;
      const tw = 0.7 + 0.3 * Math.sin(clock * (6 + 6 * r2) + r1 * 40);
      emit(cP, sk * size * (1.6 + 4.6 * (1 - b) * (0.4 + 0.8 * r2)), a * Math.pow(1 - b, 1.35) * tw, (1 - b) * (r3 > 0.7 ? 0.9 : 0.3));
    }
    pathAt(h, cP);
    emit(cP, 34 * sk * size, 0.2 * a, 0.0);    // halo
    emit(cP, 15 * sk * size, a, 1);            // head
  }
  // route i as a function of u ∈ [0, 1] (origin → Jakarta), in world space
  function routeAt(r) {
    const n = r.pts.length - 1;
    return (u, out) => { const x = clamp(u, 0, 1) * n, k = Math.min(n - 1, x | 0), f = x - k; return spinToWorld(out.copy(r.pts[k]).lerp(r.pts[k + 1], f), out); };
  }

  // ---- labels
  const mkLabel = (txt, cls) => { const d = document.createElement('div'); d.className = 'globe-label ' + (cls || ''); d.textContent = txt; labels && labels.appendChild(d); return d; };
  const jLabel = mkLabel('Jakarta', 'left');
  const oLabels = routes.filter((r) => r.o.label).map((r) => ({ r, el: mkLabel(r.o.name) }));
  [jLabel, ...oLabels.map((l) => l.el)].forEach((el) => { el.style.position = 'absolute'; el.style.left = '0'; el.style.top = '0'; el.style.willChange = 'transform,opacity'; el.style.opacity = '0'; });

  // ---- layout
  const ctx = overlay.getContext('2d');
  let vw = 1, vh = 1, dpr = 1, visH = 1, visW = 1;
  function resize() {
    const r = canvas.getBoundingClientRect();
    vw = Math.max(1, r.width); vh = Math.max(1, r.height);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    pMat.uniforms.uPx.value = dpr;
    renderer.setSize(vw, vh, false);
    overlay.width = Math.round(vw * dpr); overlay.height = Math.round(vh * dpr);
    cam.aspect = vw / vh; cam.updateProjectionMatrix();
    visH = 2 * cam.position.z * Math.tan((cam.fov * Math.PI) / 360);
    visW = visH * cam.aspect;
  }
  resize();

  // Resting orientation: Jakarta left of centre, Japan up-right, Australia down-right.
  const FACE_LON = 128, FACE_LAT = -9;
  const fv = ll(FACE_LAT, FACE_LON, 1);
  const faceY = Math.atan2(-fv.x, fv.z);
  const faceX = (FACE_LAT * Math.PI) / 180;

  // ---- projection helpers
  const tmp = new Vector3(), tmpO = new Vector3();
  const toScreen = (v) => { tmp.copy(v).project(cam); return [(tmp.x * 0.5 + 0.5) * vw, (-tmp.y * 0.5 + 0.5) * vh]; };
  // 0 = hidden behind the globe, 1 = visible; soft over a thin band at the limb
  function visibility(P) {
    const C = cam.position, O = world.position, R = world.scale.x * 1.0;
    const d = tmp.copy(P).sub(C); const L = d.length(); d.divideScalar(L);
    tmpO.copy(O).sub(C);
    const tc = tmpO.dot(d);                       // closest approach along the ray
    if (tc >= L) return 1;                         // point is in front of the closest approach
    const dmin = Math.sqrt(Math.max(0, tmpO.lengthSq() - tc * tc));
    return smooth(clamp((dmin - R * 0.985) / (R * 0.03), 0, 1));
  }
  const spinToWorld = (v, out = new Vector3()) => out.copy(v).applyMatrix4(spin.matrixWorld);
  const proj = (worldV) => { const [x, y] = toScreen(worldV); return { x, y, v: visibility(worldV) }; };

  // Thin vector line with an alpha/width ramp from tail (0) to head (1); butt caps so segments never bead.
  function line(pts, { a0 = 0, a1 = 1, w0 = 0.6, w1 = 1.4, dash = 0, gamma = 0.8 }) {
    const n = pts.length; if (n < 2) return;
    ctx.lineCap = 'butt'; ctx.strokeStyle = ORANGE;
    for (let i = 1; i < n; i++) {
      const p0 = pts[i - 1], p1 = pts[i];
      const vis = Math.min(p0.v, p1.v); if (vis <= 0.01) continue;
      if (dash && Math.floor(i / dash) % 2) continue;
      const t = Math.pow(i / (n - 1), gamma);
      const a = (a0 + (a1 - a0) * t) * vis; if (a <= 0.004) continue;
      ctx.globalAlpha = a; ctx.lineWidth = (w0 + (w1 - w0) * t) * dpr;
      ctx.beginPath(); ctx.moveTo(p0.x * dpr, p0.y * dpr); ctx.lineTo(p1.x * dpr, p1.y * dpr); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  function dot(x, y, r, fill, stroke, sw, alpha = 1) {
    if (alpha <= 0.004) return;
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
  // soft contact shadow under the ball, clipped so it never darkens the globe itself
  function groundShadow(cx, cy, R, a) {
    if (a <= 0.004) return;
    const y = cy + R * 1.03, rx = R * 0.78, ry = R * 0.075;
    if ((y - ry * 2) * 1 > vh) return;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, overlay.width, overlay.height); ctx.arc(cx * dpr, cy * dpr, R * dpr, 0, Math.PI * 2, true); ctx.clip('evenodd');
    ctx.translate(cx * dpr, y * dpr); ctx.scale(rx * dpr, ry * dpr);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, 'rgba(70,52,30,0.20)'); g.addColorStop(0.55, 'rgba(70,52,30,0.08)'); g.addColorStop(1, 'rgba(70,52,30,0)');
    ctx.globalAlpha = a; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
    ctx.restore(); ctx.globalAlpha = 1;
  }

  // ---- state
  let progress = reduceMotion ? 1 : 0, pSm = progress;
  let spinA = -1.4, last = performance.now(), running = false, raf = 0, clock = 0;
  const NARROW = 760;
  const invSpin = new Matrix4();

  function frame(now) {
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000)); last = now; clock += dt;
    pSm += (progress - pSm) * Math.min(1, dt * 8);
    const p = reduceMotion ? 1 : pSm;
    const narrow = vw <= NARROW;

    // K1 → K3 placement (world units; unit = full viewport height)
    const unit = visH;
    const k1 = narrow ? { x: 0, y: -0.04 * unit, s: Math.min(0.52 * visW, 0.34 * unit) } : { x: 0, y: -0.03 * unit, s: 0.52 * unit };
    // phones: the copy sits on top, so the globe settles in the lower 60% of the viewport
    const k3 = narrow ? { x: 0, y: -0.2 * unit, s: Math.min(0.44 * visW, 0.24 * unit) } : { x: 0.21 * visW, y: 0, s: 0.4 * unit };
    const m = ease(seg(p, 0.22, 0.6));
    world.position.set(k1.x + (k3.x - k1.x) * m, k1.y + (k3.y - k1.y) * m, 0);
    world.scale.setScalar(k1.s + (k3.s - k1.s) * m);

    // rotation: free spin (K1) → face Asia-Pacific (K2) → gentle idle sway (K3)
    if (!reduceMotion) spinA += dt * 0.26;
    const rest = seg(p, 0.9, 1);
    const sway = reduceMotion ? 0 : Math.sin(clock * 0.3) * 0.18 * rest;
    const target = faceY + sway;
    const off = ((((spinA - target) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    spin.rotation.order = 'XYZ';
    spin.rotation.y = target + off * (1 - m);
    spin.rotation.x = faceX * m + 0.3 * (1 - m);
    spin.rotation.z = -0.06 * (1 - m);
    scene.updateMatrixWorld(true);
    // key light in globe object space (rotation only)
    invSpin.copy(globe.matrixWorld).invert();
    uniforms.uKeyObj.value.copy(keyDir).transformDirection(invSpin);

    const satOn = seg(p, 0.3, 0.44);
    const drop = ease(seg(p, 0.6, 0.68));
    const sk = clamp(world.scale.x / (0.4 * unit), 0.7, 1.3); // sprite scale with globe size
    const originVis = seg(p, 0.62, 0.7);

    // ---------- particle comets ----------
    pc = 0;
    // satellites on tilted orbits; at the drop they fall onto the route origins
    if (satOn > 0 && drop < 1) {
      sats.forEach((s, i) => {
        const o = s.orbit, head = clock * o.speed + s.phase;
        const rt = s.route >= 0 ? routes[s.route] : null;
        const to = drop > 0 && rt ? spinToWorld(rt.origin) : null;
        const path = (u, out) => { orbitPoint(o, u, out); if (to) out.lerp(to, drop); return out; };
        const a = satOn * (rt ? 1 - drop * 0.3 : 1 - drop) * (rt && rt.o.far ? 0.7 : 1);
        comet(10 + i, path, head, 1.5, { n: 130, a, sk, spread: 0.035, life: 1.0 });
      });
    }
    routes.forEach((r, i) => {
      const path = routeAt(r), far = r.o.far;
      // drawing: the comet flies origin → Jakarta as you scroll
      const t = easeOut(seg(p, 0.66 + r.delay, 0.86 + r.delay));
      if (t > 0 && t < 1) comet(30 + i, path, t, 0.34, { n: 150, a: far ? 0.7 : 1, sk, uMin: 0, spread: 0.034, life: 0.8 });
      // resting: a comet keeps running each route into Jakarta
      if (rest > 0 && !reduceMotion) {
        const cyc = (clock * (far ? 0.11 : 0.15) + r.phase) % 1;
        const fade = rest * Math.min(1, cyc * 6) * Math.min(1, (1 - cyc) * 12) * (far ? 0.6 : 1);
        comet(50 + i, path, easeOut(cyc), 0.26, { n: 100, a: fade, size: 0.85, sk, uMin: 0, spread: 0.022, life: 0.7 });
      }
    });
    pGeo.setDrawRange(0, pc);
    for (const k of ['position', 'aSize', 'aAlpha', 'aHeat']) { const at = pGeo.getAttribute(k); at.clearUpdateRanges(); at.addUpdateRange(0, pc * at.itemSize); at.needsUpdate = true; }

    renderer.render(scene, cam);

    // ---------- overlay (vector): ground shadow, faint route lines, pins, labels ----------
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const [gcx, gcy] = toScreen(world.position);
    const edge = toScreen(tmpO.copy(world.position).add(new Vector3(world.scale.x, 0, 0)));
    groundShadow(gcx, gcy, Math.abs(edge[0] - gcx), uniforms.uReady.value * 0.9);

    routes.forEach((r) => {
      const far = r.o.far;
      const t = easeOut(seg(p, 0.66 + r.delay, 0.86 + r.delay));
      if (t > 0) {
        const pts = r.pts.map((v) => proj(spinToWorld(v)));
        const n = Math.max(2, Math.round(t * (pts.length - 1)) + 1);
        // the line the comet leaves behind: fades in from the origin, never a solid band
        line(pts.slice(0, n), { a0: 0, a1: far ? 0.4 : 0.7, w0: 0.6, w1: (far ? 1.0 : 1.4) * sk, dash: far ? 3 : 0 });
      }
      const o = proj(spinToWorld(r.origin)); r.screen = o;
      if (originVis > 0) dot(o.x, o.y, (far ? 3.2 : 5) * sk, '#fff', ORANGE, far ? 1.5 : 2, originVis * o.v);
    });

    // Jakarta pin + pulse
    const jIn = seg(p, 0.55, 0.7);
    const J = proj(spinToWorld(jLocal));
    if (jIn > 0 && J.v > 0) {
      const pr = seg(p, 0.86, 0.96);
      if (pr > 0) {
        const ph = reduceMotion ? 0.5 : (clock * 0.55) % 1;
        dot(J.x, J.y, (9 + 20 * easeOut(ph)) * sk, null, BLUE, 1.5, 0.5 * (1 - ph) * pr * J.v);
      }
      dot(J.x, J.y, 13 * sk, 'rgba(34,64,150,0.16)', null, 0, jIn * J.v);
      dot(J.x, J.y, 6.5 * sk, BLUE, '#fff', 2.5, jIn * J.v);
    }

    // labels
    const labelOn = seg(p, 0.7, 0.82);
    jLabel.style.transform = `translate(${J.x - 18 * sk}px, ${J.y}px) translate(-100%, -50%)`;
    jLabel.style.opacity = String(labelOn * J.v);
    oLabels.forEach(({ r, el }) => {
      const s = r.screen || { x: -999, y: -999, v: 0 };
      el.style.transform = `translate(${s.x + 12 * sk}px, ${s.y}px) translate(0, -50%)`;
      el.style.opacity = String(labelOn * smooth(s.v));
    });

    if (running) raf = requestAnimationFrame(frame);
  }

  function start() { if (running) return; running = true; last = performance.now(); raf = requestAnimationFrame(frame); }
  function stop() { running = false; cancelAnimationFrame(raf); }
  window.addEventListener('resize', resize);

  return {
    ready,
    setProgress(p, opts) { progress = clamp(p, 0, 1); if (opts && opts.immediate) pSm = progress; },
    start, stop, resize,
    renderOnce() { frame(performance.now()); },
    destroy() {
      stop(); window.removeEventListener('resize', resize);
      geo.dispose(); mat.dispose(); tex.dispose(); pGeo.dispose(); pMat.dispose(); renderer.dispose();
      [jLabel, ...oLabels.map((l) => l.el)].forEach((el) => el.remove());
    },
  };
}
