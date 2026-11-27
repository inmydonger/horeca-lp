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
 * Flights are GPU point particles in the same WebGL scene, on their OWN clock
 * (scroll only moves, turns and scales the globe): a glittering streak grows
 * out of an origin city, races along a tall arc, lands in Jakarta with a spark
 * burst and its tail crumbles away. Hidden correctly behind the globe.
 * The overlay canvas holds the vector bits: pins, Jakarta pulse, ground shadow.
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
  TextureLoader, Vector3, Matrix4, Color, RepeatWrapping, ClampToEdgeWrapping,
  BufferGeometry, BufferAttribute, Points, DynamicDrawUsage,
  LinearMipmapLinearFilter, LinearFilter, NoColorSpace,
} from 'three';

const ORANGE = '#E54E26';
const BLUE = '#224096';
const JKT = [-6.2, 106.85];
// Trail sources = Indonesia's main bovine-meat import origins (BPS 2024 via Katadata: Australia 62%,
// India 22% (mostly buffalo meat), USA 6%, Brazil 6%, New Zealand 4%), plus Japan (wagyu).
// theHoreca buys from Indonesian importers, so NO origin is named on the page: no pins, no
// country labels, only anonymous trails into Jakarta. ORIGINS feeds the reduced-motion static arcs.
const ORIGINS = [
  { key: 'au', name: 'Australia', p: [-27.47, 153.03] },
  { key: 'perth', name: 'Perth', p: [-31.95, 115.86] },
  { key: 'in', name: 'India', p: [19.08, 72.88] },
  { key: 'jp', name: 'Japan', p: [35.68, 139.69] },
  { key: 'us', name: 'USA', p: [41.26, -95.94] },
  { key: 'br', name: 'Brazil', p: [-20.47, -54.62] },
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

  // ---- routes (spin-local). Arcs are great circles lifted off the surface; longer = taller.
  const R0 = 1.02; // just above the clay slab tops
  const LIFT_MAX = 0.4; // tallest loop (USA/Brazil are almost antipodal to Jakarta)
  const jLocal = ll(JKT[0], JKT[1], R0);
  // The loop leans sideways (out of the great-circle plane) so it reads as a curve even
  // when you look straight down on it; `lean` alternates per city for variety.
  function arc(lat, lon, lean = 0.6) {
    const a = ll(lat, lon, 1).normalize(), b = ll(JKT[0], JKT[1], 1).normalize();
    const ang = a.angleTo(b), s = Math.sin(ang), lift = Math.min(0.1 + 0.95 * (ang / Math.PI), LIFT_MAX);
    const side = new Vector3().crossVectors(a, b).normalize();
    const n = 160, pts = [];
    for (let k = 0; k <= n; k++) {
      const t = k / n, h = lift * Math.sin(Math.PI * t);
      const v = a.clone().multiplyScalar(Math.sin((1 - t) * ang) / s).add(b.clone().multiplyScalar(Math.sin(t * ang) / s));
      pts.push(v.clone().multiplyScalar(R0 + h * Math.cos(lean)).addScaledVector(side, h * Math.sin(lean)));
    }
    return { pts, ang, origin: ll(lat, lon, R0) };
  }
  const routes = ORIGINS.map((o, i) => ({ o, ...arc(o.p[0], o.p[1], i % 2 ? -0.6 : 0.6) }));
  // Flights run on their own clock, never on scroll. Each lane fires a flight from one of its
  // cities into Jakarta, rests, and fires again; lanes are staggered so arcs overlap like a live feed.
  const CITIES = {
    au: [[-27.47, 153.03], [-33.87, 151.21], [-37.81, 144.96], [-31.95, 115.86], [-34.93, 138.6], [-23.38, 150.51], [-19.26, 146.82]],
    jp: [[35.68, 139.69], [34.69, 135.2], [31.6, 130.56]],
    nz: [[-36.85, 174.76], [-43.53, 172.64]],
    in: [[19.08, 72.88], [27.88, 78.08], [17.39, 78.49], [28.67, 77.45]], // Mumbai port, Aligarh, Hyderabad, Ghaziabad (buffalo-meat plants)
    us: [[41.26, -95.94], [37.75, -100.02], [35.22, -101.83], [40.42, -104.71]], // Omaha, Dodge City, Amarillo, Greeley
    br: [[-23.55, -46.63], [-20.47, -54.62], [-16.69, -49.25], [-15.6, -56.1]], // Sao Paulo, Campo Grande, Goiania, Cuiaba
  };
  const FLIGHTS = Object.fromEntries(Object.entries(CITIES).map(([g, list]) => [g, list.map(([la, lo], i) => arc(la, lo, (i % 2 ? -1 : 1) * (0.45 + 0.1 * (i % 3))))]));
  // Lanes are weighted roughly by import share: Australia most, then India, then the rest.
  // D = flight time in seconds (launch to tail landing); long hauls fly a little longer.
  const LANES = [
    { g: 'au', P: 3.1, off: 0.0 }, { g: 'au', P: 3.7, off: 1.4 }, { g: 'au', P: 4.3, off: 2.6 },
    { g: 'in', P: 3.5, off: 0.6 }, { g: 'in', P: 4.6, off: 2.3 },
    { g: 'us', P: 4.4, off: 1.1, D: 3.4 }, { g: 'br', P: 4.8, off: 3.3, D: 3.4 },
    { g: 'jp', P: 4.5, off: 0.8 }, { g: 'jp', P: 5.6, off: 3.6 },
    { g: 'nz', P: 4.9, off: 2.0 }, { g: 'nz', P: 6.1, off: 4.2 },
  ];
  const FLIGHT_T = 2.6;

  // ---- comet particles (one dynamic point cloud for every comet)
  const PMAX = 8000; // peak is ~5,500 grains with all eleven lanes in flight
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
  const cP = new Vector3(), cQ = new Vector3();
  const curveAt = (pts, u, out) => { const n = pts.length - 1, x = clamp(u, 0, 1) * n, k = Math.min(n - 1, x | 0); return spinToWorld(out.copy(pts[k]).lerp(pts[k + 1], x - k), out); };
  const easeIn = (t) => t * t * t;
  // One flight: a bright streak that grows out of the origin, races along the arc and is
  // pulled into Jakarta, its tail crumbling into sparks. Built from densely packed grains,
  // so the line glitters instead of reading as a solid tube.
  function streak(id, f, tau, { a = 1, sk = 1, still = false }) {
    if (!still && (tau <= 0 || tau >= 1)) return;
    const head = still ? 1 : ease(clamp(tau / 0.6, 0, 1));
    const tail = still ? 0 : easeIn(clamp((tau - 0.2) / 0.8, 0, 1));
    const len = head - tail; if (len <= 0.002) return;
    const S = world.scale.x;
    const n = Math.max(12, Math.round(len * (140 + 420 * f.ang)));
    for (let i = 0; i < n; i++) {
      const seed = id * 7919 + i, r1 = rnd(seed, 1), r2 = rnd(seed, 2), r3 = rnd(seed, 3);
      const w = (i + r1) / n;                         // 0 = tail, 1 = head
      curveAt(f.pts, tail + len * w, cP);
      const crumble = Math.pow(1 - w, 4) * 0.02 * S * (still ? 0 : 1);
      cP.x += (rnd(seed, 4) - 0.5) * 2 * crumble * r3; cP.y += (rnd(seed, 5) - 0.5) * 2 * crumble * r3; cP.z += (rnd(seed, 6) - 0.5) * 2 * crumble * r3;
      const tw = still ? 1 : 0.6 + 0.4 * Math.sin(clock * (9 + 12 * r2) + r1 * 60);
      const al = a * (0.25 + 0.75 * Math.pow(w, 1.1)) * tw;
      emit(cP, sk * (3.2 + 3.4 * w * (0.6 + 0.8 * r2)), al, 0.25 + 0.75 * w * w);
      if (i % 3 === 0) emit(cP, sk * (12 + 12 * w), al * 0.12, 0);   // soft bloom along the line
    }
    if (!still && head < 1) {
      curveAt(f.pts, head, cP);
      emit(cP, 40 * sk, 0.28 * a, 0);
      emit(cP, 13 * sk, a, 1);
    }
    // launch flash at the origin
    if (!still && tau < 0.18) { curveAt(f.pts, 0, cP); const k = 1 - tau / 0.18; emit(cP, 16 * sk * k, 0.6 * a * k, 1); }
    // arrival: sparks thrown out from Jakarta as the head lands
    if (!still && tau > 0.58) {
      const bt = clamp((tau - 0.58) / 0.42, 0, 1);
      spinToWorld(jLocal, cQ);
      for (let i = 0; i < 22; i++) {
        const seed = id * 131 + i;
        cP.set(rnd(seed, 7) - 0.5, rnd(seed, 8) - 0.5, rnd(seed, 9) - 0.5).normalize().multiplyScalar(0.05 * S * easeOut(bt) * (0.4 + rnd(seed, 10)));
        cP.add(cQ);
        emit(cP, sk * (2.6 - 1.6 * bt), a * Math.pow(1 - bt, 1.5), 1 - bt);
      }
      if (bt < 0.5) emit(cQ, 22 * sk * (1 - bt), 0.45 * a * (1 - 2 * bt), 1);
    }
  }

  // ---- labels
  const mkLabel = (txt, cls) => { const d = document.createElement('div'); d.className = 'globe-label ' + (cls || ''); d.textContent = txt; labels && labels.appendChild(d); return d; };
  const jLabel = mkLabel('Jakarta', 'left');
  const oLabels = []; // origin countries are intentionally not labelled (see ORIGINS)
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

  // Start orientation (and the reduced-motion view): Asia-Pacific facing the viewer.
  const FACE_LON = 128, FACE_LAT = -9;
  const fv = ll(FACE_LAT, FACE_LON, 1);
  const faceY = Math.atan2(-fv.x, fv.z);

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

  function dot(x, y, r, fill, stroke, sw, alpha = 1) {
    if (alpha <= 0.004) return;
    ctx.globalAlpha = alpha;
    ctx.beginPath(); ctx.arc(x * dpr, y * dpr, r * dpr, 0, Math.PI * 2);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.lineWidth = sw * dpr; ctx.strokeStyle = stroke; ctx.stroke(); }
    ctx.globalAlpha = 1;
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
  const SPIN_SPEED = 0.16; // rad/s, about 40 s per turn
  const TILT = 0.12;        // slight lean so the northern coasts read
  let spinA = faceY - 0.6, last = performance.now(), running = false, raf = 0, clock = 0;
  const NARROW = 760;
  const invSpin = new Matrix4();

  function frame(now) {
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000)); last = now; clock += dt;
    pSm += (progress - pSm) * Math.min(1, dt * 8);
    const p = reduceMotion ? 1 : pSm;
    const narrow = vw <= NARROW || vw / vh < 0.9; // phones and portrait tablets stack copy over globe

    // K1 → K3 placement (world units; unit = full viewport height)
    const unit = visH;
    const k1 = narrow ? { x: 0, y: -0.04 * unit, s: Math.min(0.52 * visW, 0.34 * unit) } : { x: 0, y: -0.03 * unit, s: 0.52 * unit };
    // phones: the copy sits on top, so the globe settles in the lower 60% of the viewport
    const k3 = narrow ? { x: 0, y: -0.2 * unit, s: Math.min(0.44 * visW, 0.24 * unit) } : { x: 0.21 * visW, y: 0, s: 0.4 * unit };
    const m = ease(seg(p, 0.22, 0.6));
    world.position.set(k1.x + (k3.x - k1.x) * m, k1.y + (k3.y - k1.y) * m, 0);
    world.scale.setScalar(k1.s + (k3.s - k1.s) * m);

    // rotation: free spin (K1) → face Asia-Pacific (K2) → gentle idle sway (K3)
    // rotation runs on its own clock and never reads scroll (scroll only moves and scales the globe).
    // Reduced motion: no spin, parked facing Jakarta.
    if (!reduceMotion) spinA += dt * SPIN_SPEED;
    spin.rotation.order = 'XYZ';
    spin.rotation.y = reduceMotion ? faceY : spinA;
    spin.rotation.x = TILT;
    spin.rotation.z = 0;
    scene.updateMatrixWorld(true);
    // key light in globe object space (rotation only)
    invSpin.copy(globe.matrixWorld).invert();
    uniforms.uKeyObj.value.copy(keyDir).transformDirection(invSpin);

    const sk = clamp(world.scale.x / (0.4 * unit), 0.7, 1.3); // sprite scale with globe size
    const live = uniforms.uReady.value;

    // ---------- flights (time-based; scroll only moves the globe) ----------
    pc = 0;
    if (live) {
      if (reduceMotion) {
        // Static arcs only for origins on Jakarta's side; USA/Brazil would cut across the face as long lines.
        routes.forEach((r, i) => { if (r.ang < 2) streak(900 + i, r, 1, { a: r.o.far ? 0.35 : 0.6, sk, still: true }); });
      } else {
        LANES.forEach((L, li) => {
          const T = clock + L.off, k = Math.floor(T / L.P), tau = (T - k * L.P) / (L.D || FLIGHT_T);
          const list = FLIGHTS[L.g], f = list[Math.floor(rnd(li * 31 + k, 11) * list.length)];
          streak(li * 1000 + (k % 997), f, tau, { a: L.g === 'nz' ? 0.8 : 1, sk });
        });
      }
    }
    pGeo.setDrawRange(0, pc);
    for (const k of ['position', 'aSize', 'aAlpha', 'aHeat']) { const at = pGeo.getAttribute(k); at.clearUpdateRanges(); at.addUpdateRange(0, pc * at.itemSize); at.needsUpdate = true; }

    renderer.render(scene, cam);

    // ---------- overlay (vector): ground shadow, Jakarta pin + label ----------
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const [gcx, gcy] = toScreen(world.position);
    const edge = toScreen(tmpO.copy(world.position).add(new Vector3(world.scale.x, 0, 0)));
    groundShadow(gcx, gcy, Math.abs(edge[0] - gcx), uniforms.uReady.value * 0.9);


    // Jakarta pin + pulse
    const jIn = live;
    const J = proj(spinToWorld(jLocal));
    if (jIn > 0 && J.v > 0) {
      if (!reduceMotion) {
        const ph = (clock * 0.55) % 1;
        dot(J.x, J.y, (9 + 20 * easeOut(ph)) * sk, null, BLUE, 1.5, 0.45 * (1 - ph) * J.v);
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
    // testing hook: jump the flight clock (seconds) so stills are reproducible
    _setClock(t, spinOffset) { clock = t; if (spinOffset != null) spinA = faceY + spinOffset; },
    destroy() {
      stop(); window.removeEventListener('resize', resize);
      geo.dispose(); mat.dispose(); tex.dispose(); pGeo.dispose(); pMat.dispose(); renderer.dispose();
      [jLabel, ...oLabels.map((l) => l.el)].forEach((el) => el.remove());
    },
  };
}
