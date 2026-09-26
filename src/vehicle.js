// ─── VEHICLE: the Iron Stallion, a sky-iron relic on four fat tyres ──────────
// A 1969 fastback pony car in the Boss style: baby blue, twin black racing stripes, a C-stripe, louvres.
// CT.vehicle (loaded before player.js; the player module drives it through tick):
//   init(core)                  lights + materials; the barn and the car build lazily near Harrowby
//   tick(dt, core) -> bool      called at the top of CT.player.update; true while driving (the car owns the camera)
//   driving, view               bool; 'chase' | 'cockpit'
//   absorb(amount, dir, src)    damage that reaches the driver (the car takes the rest)
//   pushOut(pos, r)             keeps a walker out of the barn walls and the parked car
//   gauge() -> {...}            dash data for ui.js
//   _dbg                        test hooks
(function () {
  'use strict';
  const T = THREE, C = CT.config, bus = CT.bus, PI = Math.PI, TAU = PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, k) => a + (b - a) * k;
  const wrapA = a => { while (a > PI) a -= TAU; while (a < -PI) a += TAU; return a; };
  const has = (m, f) => !!(CT[m] && typeof CT[m][f] === 'function' && !(CT._broken && CT._broken[m]));
  const H = (x, z) => { if (has('world', 'heightAt')) { const h = CT.world.heightAt(x, z); if (typeof h === 'number' && h === h) return h; } return 0; };
  const sfx = (n, o) => { if (has('audio', 'sfx')) CT.audio.sfx(n, o); };
  const emit = (n, d) => { if (bus) bus.emit(n, d); };
  const LS = 'crimsonThrone.car';

  // ── Car frame: +Z forward, +X the driver (left) side, y = 0 on the ground ──
  const WZF = 1.42, WZR = -1.32, WB = WZF - WZR, TRK = 0.765, WRAD = 0.335, ARCH = 0.39, HL = 2.38, HWID = 0.93;
  const WHEELS = [[TRK, WZF], [-TRK, WZF], [TRK, WZR], [-TRK, WZR]];
  const HEAD = new T.Vector3(0.37, 1.16, -0.24);

  // ── Body sections (keyframes along z) ──────────────────────────────────────
  function kf(z, K, lin) {
    if (z <= K[0][0]) return K[0][1];
    for (let i = 1; i < K.length; i++) if (z <= K[i][0]) { const a = K[i - 1], b = K[i], t = (z - a[0]) / (b[0] - a[0]); return a[1] + (b[1] - a[1]) * (lin ? t : t * t * (3 - 2 * t)); }
    return K[K.length - 1][1];
  }
  const K_HW = [[-2.38, 0.80], [-2.25, 0.855], [-2.0, 0.885], [-1.3, 0.905], [0, 0.91], [1.3, 0.905], [1.95, 0.885], [2.25, 0.85], [2.38, 0.815]];
  const K_BELT = [[-2.38, 0.905], [-2.1, 0.935], [-1.5, 0.95], [-0.7, 0.935], [0.3, 0.905], [1.2, 0.87], [2.0, 0.835], [2.38, 0.80]];
  const K_GH = [[-2.38, 0.045], [-1.80, 0.045], [-0.62, 0.35], [-0.2, 0.372], [0.06, 0.375], [0.60, 0.045], [2.38, 0.045]];
  const K_FL = [[-2.38, 0.44], [-2.2, 0.30], [-1.95, 0.25], [1.95, 0.25], [2.2, 0.30], [2.38, 0.40]];
  const ghAt = z => (kf(z - 0.05, K_GH, 1) + 2 * kf(z, K_GH, 1) + kf(z + 0.05, K_GH, 1)) / 4;
  function floorAt(z) {
    let f = kf(z, K_FL);
    for (const zw of [WZF, WZR]) { const d = z - zw; if (Math.abs(d) < ARCH) f = Math.max(f, WRAD + Math.sqrt(ARCH * ARCH - d * d)); }
    return f;
  }
  // 11 profile points of the right half: bottom centre, rocker, flank, crease, shoulder, deck edge, greenhouse base, roof edge, roof, crown
  function secPts(z) {
    const hw = kf(z, K_HW), belt = kf(z, K_BELT), g = ghAt(z), fl = floorAt(z), k = clamp((g - 0.045) / 0.3, 0, 1);
    const y2 = Math.max(fl + 0.03, Math.min(fl + 0.10, 0.40)), y3 = Math.max(belt - 0.26, y2 + 0.01), y4 = Math.max(belt - 0.06, y3 + 0.01), y5 = Math.max(belt - 0.006, y4 + 0.008);
    return [0, fl, hw - 0.10, fl, hw - 0.02, y2, hw, y3, hw - 0.004, y4, hw - 0.045, y5, hw - 0.095, Math.max(belt + 0.013, y5 + 0.004),
      hw - 0.125, belt + 0.02 + 0.008 * k, lerp(hw - 0.30, 0.655, k), belt + g * 0.90 + 0.004, lerp(hw - 0.52, 0.515, k), belt + g * 0.985 + 0.004, 0, belt + g + 0.012];
  }
  const surfPt = (z, s, left) => { const p = secPts(z), j = Math.min(9, Math.floor(s)), t = s - j, x = lerp(p[j * 2], p[j * 2 + 2], t); return new T.Vector3(left ? -x : x, lerp(p[j * 2 + 1], p[j * 2 + 3], t), z); };
  function surfN(z, s, left) {
    const p0 = surfPt(z, s, false), pz = surfPt(z + 0.01, s, false).sub(p0);
    const ps = s < 9.99 ? surfPt(z, s + 0.01, false).sub(p0) : p0.clone().sub(surfPt(z, s - 0.01, false));
    const n = new T.Vector3().crossVectors(ps, pz).normalize();
    if (left) n.x = -n.x;
    return n;
  }

  // ── Geometry accumulator (non-indexed, merged per material) ────────────────
  const acc = () => ({ p: [], n: [], c: [], g: [] });
  const _v = new T.Vector3(), _n = new T.Vector3(), _nm = new T.Matrix3(), _c = new T.Color();
  function put(A, geo, m, col, grp) {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (!g.attributes.normal) g.computeVertexNormals();
    const P = g.attributes.position.array, N = g.attributes.normal.array, flip = m && m.determinant() < 0, GA = g.attributes.aS ? g.attributes.aS.array : null;
    if (m) _nm.getNormalMatrix(m);
    const colOf = typeof col === 'function' ? col : null;
    if (!colOf) _c.set(col == null ? 0xffffff : col);
    for (let i = 0; i < P.length / 3; i += 3) {
      const ord = flip ? [0, 2, 1] : [0, 1, 2];
      for (const o of ord) {
        const k = (i + o) * 3;
        _v.set(P[k], P[k + 1], P[k + 2]); _n.set(N[k], N[k + 1], N[k + 2]);
        if (m) { _v.applyMatrix4(m); _n.applyMatrix3(_nm).normalize(); }
        A.p.push(_v.x, _v.y, _v.z); A.n.push(_n.x, _n.y, _n.z);
        if (colOf) { _c.set(colOf(_v, _n)); }
        A.c.push(_c.r, _c.g, _c.b); A.g.push(GA ? GA[i + o] : grp || 0);
      }
    }
  }
  const BOX = new T.BoxGeometry(1, 1, 1).toNonIndexed();
  function box(A, m4, sx, sy, sz, col, grp) { put(A, BOX, new T.Matrix4().multiplyMatrices(m4, new T.Matrix4().makeScale(sx, sy, sz)), col, grp); }
  const M = (x, y, z, rx, ry, rz) => new T.Matrix4().compose(new T.Vector3(x, y, z), new T.Quaternion().setFromEuler(new T.Euler(rx || 0, ry || 0, rz || 0, 'YXZ')), new T.Vector3(1, 1, 1));
  function finish(A, colors, grp) {
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(A.p, 3));
    g.setAttribute('normal', new T.Float32BufferAttribute(A.n, 3));
    if (colors) g.setAttribute('color', new T.Float32BufferAttribute(A.c, 3));
    if (grp) g.setAttribute('aGrp', new T.Float32BufferAttribute(A.g, 1));
    g.computeBoundingSphere();
    return g;
  }

  // ── The lofted body ────────────────────────────────────────────────────────
  function bodyLoft() {
    const zs = []; for (let z = -HL; z < HL - 0.02; z += 0.04) zs.push(z); zs.push(HL);
    const NR = 20, pos = [], idx = [], ss = [];
    zs.forEach(z => { const p = secPts(z); for (let j = 0; j <= 10; j++) { pos.push(p[j * 2], p[j * 2 + 1], z); ss.push(j); } for (let j = 9; j >= 1; j--) { pos.push(-p[j * 2], p[j * 2 + 1], z); ss.push(j); } });
    for (let k = 0; k < zs.length - 1; k++) for (let j = 0; j < NR; j++) {
      const a = k * NR + j, d = k * NR + (j + 1) % NR, b = (k + 1) * NR + j, c = (k + 1) * NR + (j + 1) % NR;
      idx.push(a, c, b, a, d, c);
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setAttribute('aS', new T.Float32BufferAttribute(ss, 1)); g.setIndex(idx); g.computeVertexNormals();
    const out = g.toNonIndexed();
    // flat caps: the nose and the tail panel
    const cap = (k, front) => {
      const z = zs[k], p = secPts(z), ring = [];
      for (let j = 0; j <= 10; j++) ring.push([p[j * 2], p[j * 2 + 1]]); for (let j = 9; j >= 1; j--) ring.push([-p[j * 2], p[j * 2 + 1]]);
      const cy = (p[1] + p[21]) / 2, P = [], N = [];
      for (let j = 0; j < ring.length; j++) {
        const a = ring[j], b = ring[(j + 1) % ring.length], tri = front ? [[0, cy], b, a] : [[0, cy], a, b];
        tri.forEach(q => { P.push(q[0], q[1], z); N.push(0, 0, front ? 1 : -1); });
      }
      const cg = new T.BufferGeometry(); cg.setAttribute('position', new T.Float32BufferAttribute(P, 3)); cg.setAttribute('normal', new T.Float32BufferAttribute(N, 3));
      return cg;
    };
    return [out, cap(zs.length - 1, true), cap(0, false)];
  }
  // A surface-hugging patch over the body: corners in (z, s) space, bilinear.
  function patch(A, a, b, c, d, nu, nv, off, left, col) {
    const pt = [], nr = [];
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
      const u = i / nu, v = j / nv;
      const z = (1 - u) * (1 - v) * a[0] + u * (1 - v) * b[0] + u * v * c[0] + (1 - u) * v * d[0];
      const s = (1 - u) * (1 - v) * a[1] + u * (1 - v) * b[1] + u * v * c[1] + (1 - u) * v * d[1];
      const n = surfN(z, s, left); pt.push(surfPt(z, s, left).addScaledVector(n, off)); nr.push(n);
    }
    const P = [], N = [], w = nu + 1, e1 = new T.Vector3(), e2 = new T.Vector3(), cr = new T.Vector3();
    const tri = (i0, i1, i2) => {
      e1.subVectors(pt[i1], pt[i0]); e2.subVectors(pt[i2], pt[i0]); cr.crossVectors(e1, e2);
      const avg = new T.Vector3().add(nr[i0]).add(nr[i1]).add(nr[i2]);
      const ids = cr.dot(avg) >= 0 ? [i0, i1, i2] : [i0, i2, i1];
      ids.forEach(q => { P.push(pt[q].x, pt[q].y, pt[q].z); N.push(nr[q].x, nr[q].y, nr[q].z); });
    };
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { const q = j * w + i; tri(q, q + 1, q + w + 1); tri(q, q + w + 1, q + w); }
    const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(P, 3)); g.setAttribute('normal', new T.Float32BufferAttribute(N, 3));
    put(A, g, null, col);
  }
  // a chrome line hugging the body along a polyline in (z, s) space
  function trimLine(A, pts, left, r, off) {
    const V = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1], n = Math.max(2, Math.ceil(Math.hypot(a[0] - b[0], (a[1] - b[1]) * 0.3) / 0.08));
      for (let k = 0; k < n; k++) { const t = k / n, z = lerp(a[0], b[0], t), s = lerp(a[1], b[1], t); V.push(surfPt(z, s, a[2] != null ? a[2] : left).addScaledVector(surfN(z, s, a[2] != null ? a[2] : left), off || 0.008)); }
    }
    const l = pts[pts.length - 1]; V.push(surfPt(l[0], l[1], l[2] != null ? l[2] : left).addScaledVector(surfN(l[0], l[1], l[2] != null ? l[2] : left), off || 0.008));
    put(A, new T.TubeGeometry(new T.CatmullRomCurve3(V), Math.max(4, Math.ceil(V.length / 2)), r || 0.011, 3, false), null, 0xffffff);
  }
  function roundRect(w, h, r) {
    const s = new T.Shape(), x = -w / 2, y = -h / 2;
    s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r); s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r); s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
    return s;
  }
  // surface basis at (z, s): x along z, y along the normal
  function onSurf(z, s, left, lift) {
    const p = surfPt(z, s, left), n = surfN(z, s, left), tz = surfPt(z + 0.01, s, left).sub(p).normalize();
    const ts = new T.Vector3().crossVectors(n, tz).normalize(); tz.crossVectors(ts, n).normalize();
    return new T.Matrix4().makeBasis(ts, n, tz).setPosition(p.addScaledVector(n, lift || 0));
  }

  // ── Materials ──────────────────────────────────────────────────────────────
  let ENV = null, MAT = null;
  function envCube() {
    const S = 64, imgs = [];
    for (let f = 0; f < 6; f++) {
      const cv = document.createElement('canvas'); cv.width = cv.height = S; const g = cv.getContext('2d');
      if (f === 2) { const gr = g.createRadialGradient(S / 2, S / 2, 2, S / 2, S / 2, S * 0.7); gr.addColorStop(0, '#dfe8f0'); gr.addColorStop(1, '#a9bfd3'); g.fillStyle = gr; g.fillRect(0, 0, S, S); }
      else if (f === 3) { g.fillStyle = '#211c17'; g.fillRect(0, 0, S, S); }
      else {
        const gr = g.createLinearGradient(0, 0, 0, S);
        gr.addColorStop(0, '#a3bbd2'); gr.addColorStop(0.38, '#d9dfe2'); gr.addColorStop(0.48, '#f3e3c8'); gr.addColorStop(0.5, '#7d6c55'); gr.addColorStop(0.58, '#3a3228'); gr.addColorStop(1, '#1e1a15');
        g.fillStyle = gr; g.fillRect(0, 0, S, S);
        g.fillStyle = '#2c2a22'; g.beginPath(); g.moveTo(0, S * 0.5);                 // tree line and hills on the horizon
        for (let x = 0; x <= S; x += 4) g.lineTo(x, S * 0.5 - (2 + Math.abs(Math.sin(x * 0.37 + f * 2.1)) * 5 + (Math.sin(x * 0.11 + f) > 0.6 ? 6 : 0)));
        g.lineTo(S, S * 0.5); g.closePath(); g.fill();
        if (f === 0) { const sg = g.createRadialGradient(S * 0.3, S * 0.3, 0, S * 0.3, S * 0.3, 10); sg.addColorStop(0, 'rgba(255,250,235,1)'); sg.addColorStop(1, 'rgba(255,240,210,0)'); g.fillStyle = sg; g.fillRect(0, 0, S, S); }
      }
      imgs.push(cv);
    }
    const t = new T.CubeTexture(imgs); t.colorSpace = T.SRGBColorSpace; t.needsUpdate = true;
    return t;
  }
  function makeMaterials() {
    ENV = envCube();
    const paint = new T.MeshPhysicalMaterial({ color: 0x7cc2ec, roughness: 0.34, metalness: 0.0, clearcoat: 1, clearcoatRoughness: 0.07, envMap: ENV, envMapIntensity: 1 });
    paint.onBeforeCompile = sh => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aGrp; varying vec3 vLP; varying vec3 vLN; varying float vS;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLP = position; vLN = normal; vS = aGrp;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
varying vec3 vLP; varying vec3 vLN; varying float vS; float ctStripe = 0.0;
bool ctIn(vec2 p, vec2 a, vec2 b, vec2 c, vec2 d, float m){ vec2 q[4]; q[0] = a; q[1] = b; q[2] = c; q[3] = d; float ar = 0.0;
  for (int i = 0; i < 4; i++) { vec2 u = q[i], v = q[(i + 1) - 4 * ((i + 1) / 4)]; ar += u.x * v.y - v.x * u.y; }
  for (int i = 0; i < 4; i++) { vec2 u = q[i], v = q[(i + 1) - 4 * ((i + 1) / 4)], e = v - u; vec2 n = normalize(vec2(-e.y, e.x)) * sign(ar); if (dot(p - u, n) < m) return false; }
  return true; }
float ctBand(float v, float a, float b){ float w = fwidth(v) * 0.75 + 1e-4; return smoothstep(a - w, a + w, v) * (1.0 - smoothstep(b - w, b + w, v)); }
float ctSeg(vec2 p, vec2 a, vec2 b, float r){ vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); float d = length(pa - ba * h); float w = fwidth(d) * 0.75 + 1e-4; return 1.0 - smoothstep(r - w, r + w, d); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
{
  if (vS > 6.9) {
    vec2 w = vec2(vLP.z, vS * 0.25); float mg = 0.012;
    if (ctIn(w, vec2(0.575, 8.02 * 0.25), vec2(0.575, 2.5), vec2(0.075, 2.5), vec2(0.075, 8.10 * 0.25), mg) && vS < 9.999) discard;
    if (ctIn(w, vec2(-1.66, 8.30 * 0.25), vec2(-1.66, 2.5), vec2(-0.66, 2.5), vec2(-0.66, 8.25 * 0.25), mg) && vS < 9.999) discard;
    if (ctIn(w, vec2(0.50, 7.10 * 0.25), vec2(-0.42, 7.10 * 0.25), vec2(-0.74, 7.93 * 0.25), vec2(0.10, 7.93 * 0.25), mg)) discard;
  }
  vec3 ln = normalize(vLN); float ax = abs(vLP.x);
  float top = smoothstep(0.30, 0.45, ln.y);
  float racing = top * ctBand(ax, 0.040, 0.290);
  float side = smoothstep(0.55, 0.75, abs(ln.x));
  vec2 q = vec2(vLP.z, vLP.y); float yb = 0.772;
  float c = ctSeg(q, vec2(2.24, yb), vec2(-0.80, yb), 0.033);
  c = max(c, ctSeg(q, vec2(-0.80, yb), vec2(-0.99, yb - 0.10), 0.033));
  c = max(c, ctSeg(q, vec2(-0.99, yb - 0.10), vec2(-0.93, yb - 0.27), 0.033));
  c = max(c, ctSeg(q, vec2(-0.93, yb - 0.27), vec2(-0.66, yb - 0.37), 0.033));
  float m = max(racing, side * c);
  ctStripe = m; diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.004, 0.0045, 0.006), m);
  float gap = side * (ctBand(vLP.z, 0.515, 0.527) + ctBand(vLP.z, -0.507, -0.495)) * step(0.33, vLP.y) * step(vLP.y, 0.9);
  gap += top * (ctBand(vLP.z, 0.642, 0.654) + ctBand(vLP.z, -1.842, -1.83)) * step(ax, 0.79);
  diffuseColor.rgb *= 1.0 - 0.8 * clamp(gap, 0.0, 1.0);
}`)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.55, ctStripe);')
        .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\nmaterial.clearcoat *= 1.0 - 0.6 * ctStripe;');
    };
    paint.customProgramCacheKey = () => 'ct-stallion-paint';
    const lamp = new T.MeshBasicMaterial({ vertexColors: true });
    const LU = { uHead: { value: 0.7 }, uTail: { value: 0.6 } };
    lamp.onBeforeCompile = sh => {
      sh.uniforms.uHead = LU.uHead; sh.uniforms.uTail = LU.uTail;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aGrp; varying float vGrp;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvGrp = aGrp;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uHead; uniform float uTail; varying float vGrp;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= mix(uHead, uTail, vGrp);');
    };
    lamp.customProgramCacheKey = () => 'ct-stallion-lamp';
    MAT = {
      paint, lamp, LU,
      glass: new T.MeshStandardMaterial({ color: 0x0b1117, roughness: 0.05, metalness: 0.3, envMap: ENV, transparent: true, opacity: 0.94, depthWrite: false }),
      chrome: new T.MeshStandardMaterial({ color: 0xe8edf2, roughness: 0.12, metalness: 1.0, envMap: ENV }),
      trim: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0.1, side: T.DoubleSide, envMap: ENV, envMapIntensity: 0.35 }),
      tyre: new T.MeshStandardMaterial({ color: 0x151515, roughness: 0.92, metalness: 0.0 }),
      rim: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.26, metalness: 0.9, envMap: ENV }),
      shadow: null,
    };
    const cv = document.createElement('canvas'); cv.width = 64; cv.height = 128; const g = cv.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 2, 32, 32, 31); gr.addColorStop(0, 'rgba(0,0,0,0.8)'); gr.addColorStop(0.5, 'rgba(0,0,0,0.6)'); gr.addColorStop(0.8, 'rgba(0,0,0,0.22)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.setTransform(1, 0, 0, 2, 0, 0); g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    const st = new T.CanvasTexture(cv);
    MAT.shadow = new T.MeshBasicMaterial({ map: st, transparent: true, depthWrite: false, color: 0x000000, opacity: 0.8, polygonOffset: true, polygonOffsetFactor: -4 });
  }

  // ── Build the car ──────────────────────────────────────────────────────────
  const car = { x: 0, y: 0, z: 0, h: 0, vx: 0, vz: 0, vy: 0, w: 0, pitch: 0, roll: 0, pv: 0, rv: 0, yd: 0, air: 0, steer: 0, spin: 0,
    rpm: 750, gear: 1, shiftT: 0, hp: 100, stall: 0, inBarn: true, found: false, thrS: 0, vfPrev: 0, accL: 0, slip: 0, burn: 0, surf: { top: 30, grip: 0.85, drag: 0.8 } };
  let G = null;                                    // the car group and its parts
  function buildCar(scene) {
    const P = acc(), GL = acc(), CH = acc(), TR = acc(), LA = acc(), SW = acc();
    bodyLoft().forEach(g => put(P, g, null, 0xffffff));
    // the deck spoiler (painted: the stripes run over it) on two short posts
    const deckY = secPts(-2.2)[21];
    const ws = new T.Shape(); ws.moveTo(0, 0); ws.quadraticCurveTo(0.04, 0.04, 0.13, 0.042); ws.lineTo(0.27, 0.06); ws.lineTo(0.278, 0.03); ws.lineTo(0.14, 0.004); ws.quadraticCurveTo(0.05, -0.01, 0, 0);
    const wing = new T.ExtrudeGeometry(ws, { depth: 1.46, bevelEnabled: false, curveSegments: 6 }); wing.rotateY(PI / 2); wing.translate(-0.73, deckY + 0.065, -2.075);
    put(P, wing, null, 0xffffff);
    for (const sx of [-0.6, 0.6]) box(P, M(sx, deckY + 0.035, -2.2), 0.035, 0.07, 0.11, 0xffffff);
    // the hood scoop: painted shell, flat-black mouth and surround
    const hy = secPts(1.3)[21] - 0.012;
    const sc = new T.Shape(); sc.moveTo(0, 0); sc.lineTo(0.64, 0); sc.lineTo(0.64, 0.072); sc.quadraticCurveTo(0.32, 0.066, 0, 0.0);
    const scoop = new T.ExtrudeGeometry(sc, { depth: 0.44, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012, bevelSegments: 2, curveSegments: 6 });
    scoop.rotateY(-PI / 2); scoop.rotateX(0.045); scoop.translate(0.22, hy, 1.0);
    put(P, scoop, null, 0xffffff);
    box(TR, M(0, hy + 0.036, 1.646, 0.045, 0, 0), 0.40, 0.052, 0.03, 0x050505);
    box(TR, M(0, hy + 0.016, 1.30, 0.045, 0, 0), 0.54, 0.008, 0.76, 0x0d0d0e);
    // glass: windshield, rear window, door + quarter glass
    const GC = 0xffffff;
    for (const L of [false, true]) {
      patch(GL, [0.575, 8.02], [0.575, 10], [0.075, 10], [0.075, 8.10], 8, 8, 0.006, L, GC);
      patch(GL, [-1.66, 8.30], [-1.66, 10], [-0.66, 10], [-0.66, 8.25], 8, 10, 0.006, L, GC);
      patch(GL, [0.50, 7.10], [-0.42, 7.10], [-0.74, 7.93], [0.10, 7.93], 12, 5, 0.006, L, GC);
      // chrome: window surrounds, the belt line and the quarter-glass divider
      trimLine(CH, [[0.50, 7.10], [0.10, 7.93], [-0.74, 7.93], [-0.42, 7.10], [0.50, 7.10]], L, 0.011);
      trimLine(CH, [[-0.20, 7.10], [-0.30, 7.93]], L, 0.009);
      trimLine(CH, [[0.575, 8.02], [0.075, 8.10], [0.075, 9.999]], L, 0.012);
      trimLine(CH, [[-1.66, 8.30], [-0.66, 8.25], [-0.66, 9.999]], L, 0.011);
      trimLine(CH, [[0.585, 8.02], [0.585, 9.999]], L, 0.01);
      trimLine(CH, [[-1.67, 8.30], [-1.67, 9.999]], L, 0.01);
      // C-pillar louvres (four gills on the sail panel)
      for (let i = 0; i < 4; i++) {
        const m = onSurf(-1.14 - i * 0.02, 7.32 + i * 0.13, L, 0.012);
        box(TR, m.multiply(new T.Matrix4().makeRotationY(L ? 0.22 : -0.22)), 0.022, 0.018, 0.24 - i * 0.03, 0x0a0a0b);
      }
      const sx = L ? -1 : 1;
      box(CH, M(sx * (kf(-0.35, K_HW) + 0.004), 0.835, -0.35), 0.018, 0.024, 0.13, 0xffffff);              // door handles
    }
    // rear window slats and their frame
    for (let i = 0; i < 10; i++) {
      const z = -1.58 + i * 0.094, m = onSurf(z, 9.999, false, 0.034);
      box(TR, m, 1.04, 0.012, 0.05, 0x0b0b0c);
    }
    for (const sx of [-0.53, 0.53]) {
      const a = surfPt(-1.64, 9.999), b = surfPt(-0.68, 9.999), d = b.clone().sub(a), l = d.length();
      box(TR, new T.Matrix4().lookAt(a, b, new T.Vector3(0, 1, 0)).setPosition(sx, (a.y + b.y) / 2 + 0.02, (a.z + b.z) / 2), 0.03, 0.03, l, 0x0b0b0c);
    }
    // nose: black grille with quad round lamps in chrome bezels, bars, chin spoiler, chrome bumper
    const grille = new T.ExtrudeGeometry(roundRect(1.48, 0.27, 0.07), { depth: 0.04, bevelEnabled: false, curveSegments: 5 }); grille.translate(0, 0.635, 2.36);
    put(TR, grille, null, 0x050506);
    for (let i = 0; i < 3; i++) box(TR, M(0, 0.575 + i * 0.06, 2.403), 1.36, 0.008, 0.008, 0x1c1c1e);
    for (const lx of [-0.62, -0.36, 0.36, 0.62]) {
      put(LA, new T.CircleGeometry(0.074, 20), M(lx, 0.645, 2.412), 0xfff4dc, 0);
      put(LA, new T.CircleGeometry(0.03, 12), M(lx, 0.645, 2.4135), 0xffffff, 0);
      put(CH, new T.TorusGeometry(0.082, 0.012, 6, 22), M(lx, 0.645, 2.41), 0xffffff);
    }
    box(TR, M(0, 0.305, 2.34, -0.18, 0, 0), 1.55, 0.03, 0.17, 0x070707);
    const bump = (zs, y) => {
      const pts = [[-0.87, zs * 2.22], [-0.81, zs * 2.36], [-0.55, zs * 2.43], [0, zs * 2.455], [0.55, zs * 2.43], [0.81, zs * 2.36], [0.87, zs * 2.22]].map(q => new T.Vector3(q[0], 0, q[1]));
      const tg = new T.TubeGeometry(new T.CatmullRomCurve3(pts), 40, 0.045, 8, false); tg.scale(1, 1.45, 1); tg.translate(0, y, 0);
      put(CH, tg, null, 0xffffff);
    };
    bump(1, 0.455); bump(-1, 0.50);
    // tail: black panel, three-bar lamps, a round filler cap, twin exhaust tips
    const tp = new T.ExtrudeGeometry(roundRect(1.48, 0.27, 0.05), { depth: 0.02, bevelEnabled: false, curveSegments: 5 }); tp.rotateY(PI); tp.translate(0, 0.745, -2.385);
    put(TR, tp, null, 0x09090a);
    for (const sx of [-1, 1]) for (let i = 0; i < 3; i++) {
      const pl = new T.PlaneGeometry(0.078, 0.2); pl.rotateY(PI);
      put(LA, pl, M(sx * (0.40 + i * 0.095), 0.745, -2.409), 0xff1208, 1);
      box(CH, M(sx * (0.40 + i * 0.095 + 0.0475), 0.745, -2.408), 0.012, 0.21, 0.006, 0xffffff);
    }
    put(CH, new T.CircleGeometry(0.068, 18).rotateY(PI), M(0, 0.745, -2.41), 0xffffff);
    for (const sx of [-0.5, 0.5]) {
      put(CH, new T.CylinderGeometry(0.046, 0.046, 0.16, 12, 1, true).rotateX(PI / 2), M(sx, 0.29, -2.37), 0xffffff);
      put(TR, new T.CircleGeometry(0.04, 12).rotateY(PI), M(sx, 0.29, -2.435), 0x020202);
    }
    // mirror (driver side)
    box(CH, M(0.86, 0.95, 0.48, 0, 0, -0.4), 0.09, 0.02, 0.03, 0xffffff);
    put(CH, new T.SphereGeometry(0.055, 12, 8), new T.Matrix4().compose(new T.Vector3(0.93, 0.99, 0.47), new T.Quaternion(), new T.Vector3(1.2, 0.8, 1.05)), 0xffffff);
    // chassis tub (fills the wheel arches) and the interior
    box(TR, M(0, 0.47, 1.45), 1.22, 0.5, 1.5, 0x040404); box(TR, M(0, 0.47, -1.93), 1.22, 0.5, 0.42, 0x040404);
    for (const sx of [-1, 1]) { box(TR, M(sx * 0.69, 0.56, -1.32), 0.24, 0.4, 0.86, 0x0c0c0d); box(TR, M(sx * 0.77, 0.7, -1.3), 0.03, 0.5, 0.75, 0x161618); }
    box(TR, M(0, 0.41, -0.45), 1.6, 0.02, 2.2, 0x121212);                                            // floor
    box(TR, M(0, 0.57, 0.74), 1.58, 0.34, 0.03, 0x0e0e10); for (const sx of [-1, 1]) box(TR, M(sx * 0.79, 0.64, 0.68), 0.03, 0.5, 0.2, 0x161618);   // firewall + kick panels
    for (const sx of [-1, 1]) box(TR, M(sx * 0.80, 0.64, -0.08), 0.03, 0.5, 1.35, 0x161618);           // door cards
    box(TR, M(0, 0.80, 0.62), 1.56, 0.18, 0.28, 0x0e0e10);                                            // dash
    box(TR, M(0, 0.9, 0.57, -0.12, 0, 0), 1.56, 0.03, 0.26, 0x08080a);                               // dash pad
    for (const gx of [0.30, 0.44]) put(TR, new T.CylinderGeometry(0.052, 0.052, 0.05, 16).rotateX(PI / 2), M(gx, 0.875, 0.49, 0.25, 0, 0), 0x1d1d20);
    const VIN = 0x2b292a, VIN2 = 0x3a3638;                                                               // black vinyl buckets, the '69 pattern
    for (const sx of [-0.37, 0.37]) {
      box(TR, M(sx, 0.5, -0.45), 0.46, 0.11, 0.5, VIN);
      for (const bx of [-0.21, 0.21]) { box(TR, M(sx + bx, 0.57, -0.45), 0.07, 0.09, 0.46, VIN2); box(TR, M(sx + bx, 0.86, -0.73, -0.22, 0, 0), 0.07, 0.54, 0.12, VIN2); }
      box(TR, M(sx, 0.85, -0.76, -0.22, 0, 0), 0.4, 0.6, 0.09, VIN);
      for (let k = -1; k <= 1; k++) box(TR, M(sx + k * 0.1, 0.86, -0.715, -0.22, 0, 0), 0.012, 0.5, 0.01, 0x121112);
      box(TR, M(sx, 1.19, -0.84, -0.22, 0, 0), 0.26, 0.15, 0.08, VIN);
    }
    box(TR, M(0, 0.5, -1.28), 1.16, 0.13, 0.5, VIN); box(TR, M(0, 0.8, -1.56, -0.4, 0, 0), 1.16, 0.5, 0.1, VIN);
    for (let k = -2; k <= 2; k++) box(TR, M(k * 0.2, 0.81, -1.5, -0.4, 0, 0), 0.012, 0.42, 0.01, 0x121112);
    box(TR, M(0, 1.262, -0.27), 1.24, 0.015, 0.74, 0x6a645a);                                          // headliner
    put(TR, new T.CylinderGeometry(0.025, 0.03, 0.34, 8).rotateX(PI / 2 - 0.35), M(0.37, 0.88, 0.42), 0x111113);   // column
    // steering wheel (its own mesh: it turns)
    put(SW, new T.TorusGeometry(0.175, 0.017, 8, 28), null, 0x1a1512);
    for (let i = 0; i < 3; i++) { const a = -PI / 2 + i * TAU / 3; box(SW, M(Math.cos(a) * 0.09, Math.sin(a) * 0.09, 0, 0, 0, a), 0.17, 0.022, 0.012, 0x9a9ca0); }
    put(SW, new T.CylinderGeometry(0.04, 0.04, 0.03, 12).rotateX(PI / 2), null, 0x2a2a2e);

    // ── wheels: instanced tyres + rims (5-spoke, gunmetal with chrome lip and cap) ──
    const tyre = new T.LatheGeometry([[0.205, -0.12], [0.26, -0.132], [0.31, -0.128], [0.332, -0.104], [0.338, -0.04], [0.338, 0.04], [0.332, 0.104], [0.31, 0.128], [0.26, 0.132], [0.205, 0.12]].map(q => new T.Vector2(q[0], q[1])), 28);
    tyre.rotateZ(PI / 2);
    const R = acc(), face = new T.Shape(); face.absarc(0, 0, 0.195, 0, TAU, false);
    for (let i = 0; i < 5; i++) {
      const a = i * TAU / 5 + TAU / 10, hole = new T.Path(), o = 0.36, q = 0.25;
      hole.moveTo(Math.cos(a - q) * 0.078, Math.sin(a - q) * 0.078); hole.absarc(0, 0, 0.165, a - o, a + o, false); hole.lineTo(Math.cos(a + q) * 0.078, Math.sin(a + q) * 0.078); hole.absarc(0, 0, 0.078, a + q, a - q, true);
      face.holes.push(hole);
    }
    const fg = new T.ExtrudeGeometry(face, { depth: 0.022, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.006, bevelSegments: 1, curveSegments: 5 });
    fg.rotateY(PI / 2); put(R, fg, M(0.045, 0, 0), 0x3a3d42);
    put(R, new T.CylinderGeometry(0.2, 0.2, 0.2, 24, 1, true).rotateZ(PI / 2), null, 0x1c1d20);
    put(R, new T.CylinderGeometry(0.155, 0.155, 0.02, 24).rotateZ(PI / 2), M(-0.04, 0, 0), 0x0c0c0e);
    put(R, new T.TorusGeometry(0.197, 0.013, 6, 30).rotateY(PI / 2), M(0.072, 0, 0), 0xffffff);
    put(R, new T.CylinderGeometry(0.05, 0.058, 0.035, 16).rotateZ(-PI / 2), M(0.08, 0, 0), 0xffffff);
    for (let i = 0; i < 5; i++) { const a = i * TAU / 5; put(R, new T.CylinderGeometry(0.011, 0.011, 0.03, 6).rotateZ(-PI / 2), M(0.078, Math.cos(a) * 0.075, Math.sin(a) * 0.075), 0xd8d8d8); }

    const grp = new T.Group(); grp.rotation.order = 'YXZ';
    const mk = (geo, mat, name) => { const m = new T.Mesh(geo, mat); m.name = name; grp.add(m); return m; };
    const body = mk(finish(P, false, true), MAT.paint, 'body');
    const glass = mk(finish(GL), MAT.glass, 'glass'); glass.renderOrder = 2;
    mk(finish(CH), MAT.chrome, 'chrome');
    mk(finish(TR, true), MAT.trim, 'trim');
    mk(finish(LA, true, true), MAT.lamp, 'lamps');
    const wheel = new T.Mesh(finish(SW, true), MAT.trim); wheel.position.set(0.37, 0.9, 0.3); wheel.rotation.order = 'XYZ'; wheel.rotation.x = -0.36; grp.add(wheel);
    const tyres = new T.InstancedMesh(tyre, MAT.tyre, 4), rims = new T.InstancedMesh(finish(R, true), MAT.rim, 4);
    [tyres, rims].forEach(m => { m.frustumCulled = false; m.instanceMatrix.setUsage(T.DynamicDrawUsage); grp.add(m); });
    grp.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
    scene.add(grp);
    const shadow = new T.Mesh(new T.PlaneGeometry(2.5, 5.6).rotateX(-PI / 2), MAT.shadow); shadow.renderOrder = 1; scene.add(shadow);
    // headlight beams (always in the scene so no shader rebuild when they switch on)
    SPOTS.forEach((s, i) => { grp.add(s); grp.add(s.target); s.position.set(i ? -0.5 : 0.5, 0.66, 2.3); s.target.position.set(i ? -0.9 : 0.9, -0.4, 24); });
    G = { grp, body, glass, wheel, tyres, rims, shadow, spin: [0, 0, 0, 0], susp: [0, 0, 0, 0], tris: 0 };
    grp.traverse(o => { if (o.geometry) G.tris += (o.geometry.attributes.position.count / 3) * (o.isInstancedMesh ? 4 : 1); });
  }

  // ── The barn: stone, timber, straw (one merged mesh) ───────────────────────
  let BARN = null;
  const BW = 4.0, BD = 6.2;                        // wall centre lines: x = +-BW, z = +-BD (door at +z)
  function findBarnSite() {
    const W = CT.world, hb = (C.POIS || []).find(p => p.id === 'harrowby') || { x: 120, z: 980 };
    const roads = (W && W.roads) || [], road = roads.find(r => (r.a === 'harrowby' && r.b === 'camp') || (r.a === 'camp' && r.b === 'harrowby'));
    const spots = []; if (W && W.spots) for (const id in W.spots) (W.spots[id] || []).forEach(s => spots.push(s));
    const cands = [];
    if (road) for (let i = 3; i < road.n - 3; i += 3) {
      const rx = road.X[i], rz = road.Z[i], d = Math.hypot(rx - hb.x, rz - hb.z); if (d < 48 || d > 96) continue;
      const tx = road.X[i + 2] - road.X[i - 2], tz = road.Z[i + 2] - road.Z[i - 2], tl = Math.hypot(tx, tz) || 1, nx = -tz / tl, nz = tx / tl;
      for (const sd of [-1, 1]) for (const off of [13, 15.5, 18]) { const x = rx + nx * off * sd, z = rz + nz * off * sd; if (Math.hypot(x - hb.x, z - hb.z) <= 76) cands.push({ x, z, rx, rz, d }); }
    }
    if (!cands.length) cands.push({ x: hb.x + 60, z: hb.z - 30, rx: hb.x + 50, rz: hb.z - 20, d: 68 });
    let best = null, bs = 1e9;
    const probe = new T.Vector3();
    for (const c of cands) {
      const yaw = Math.atan2(c.rx - c.x, c.rz - c.z), cs = Math.cos(yaw), sn = Math.sin(yaw);
      let lo = 1e9, hi = -1e9, blocked = 0;
      for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) {
        const lx = a * 2.3, lz = b * 3.3, x = c.x + lx * cs + lz * sn, z = c.z - lx * sn + lz * cs, h = H(x, z);
        lo = Math.min(lo, h); hi = Math.max(hi, h);
        if (has('world', 'collide')) { probe.set(x, h + 0.5, z); CT.world.collide(probe, 1.9); if (Math.hypot(probe.x - x, probe.z - z) > 0.05) blocked++; }
        if (has('world', 'waterAt') && CT.world.waterAt(x, z) > 0) blocked += 3;
      }
      let s = (hi - lo) * 4 + blocked * 6 + Math.abs(c.d - 68) * 0.03 + (c.x < hb.x ? 8 : 0);
      for (const sp of spots) { const dd = Math.hypot(sp.x - c.x, sp.z - c.z); if (dd < 26) s += (26 - dd) * 2; }
      for (const r of roads) for (let i = 0; i < r.n; i += 2) { const dd = Math.hypot(r.X[i] - c.x, r.Z[i] - c.z); if (dd < 11) { s += (11 - dd) * 3; break; } }
      if (s < bs) { bs = s; best = Object.assign({ yaw }, c); }
    }
    return best;
  }
  function buildBarn(scene, site) {
    const A = acc(), rnd = CT.rng ? CT.rng(4077) : Math.random, y0 = H(site.x, site.z), cs = Math.cos(site.yaw), sn = Math.sin(site.yaw);
    const toW = (lx, lz) => [site.x + lx * cs + lz * sn, site.z - lx * sn + lz * cs];
    const gy = (lx, lz) => { const w = toW(lx, lz); return H(w[0], w[1]) - y0; };
    const STONE = [0x6f6a60, 0x5f5a51, 0x7b756a, 0x58544c, 0x6a6356, 0x4f4b44, 0x76705f];
    const WOOD = [0x4f3520, 0x5c3f26, 0x43301f, 0x6a5238, 0x5d554a];
    const pick = a => a[(rnd() * a.length) | 0];
    const shade = (hex, k) => { const c = new T.Color(hex); return c.multiplyScalar(k); };
    // a wall of coursed rubble stone from (x0,z0) to (x1,z1); top(t) gives the ruined height along it
    function wall(x0, z0, x1, z1, top, th, from) {
      const len = Math.hypot(x1 - x0, z1 - z0), ang = Math.atan2(x1 - x0, z1 - z0), dx = (x1 - x0) / len, dz = (z1 - z0) / len, RH = 0.42;
      const base = from != null ? from : Math.min(gy(x0, z0), gy(x1, z1), gy((x0 + x1) / 2, (z0 + z1) / 2)) - 0.8;
      // dark mortar core behind the stones, stepped to follow the ruined top
      for (let k = 0; k < 8; k++) {
        const t = (k + 0.5) / 8, tp = Math.min(top(t, () => 0.5), 6) - 0.25; if (tp <= base + 0.1) continue;
        box(A, M(x0 + dx * len * t, (base + tp) / 2, z0 + dz * len * t, 0, ang, 0), th - 0.12, tp - base, len / 8 + 0.02, 0x2b2620);
      }
      for (let row = 0, y = base; y < 6.2; row++) {
        const rh = RH * (0.7 + rnd() * 0.5);
        let u = row % 2 ? -0.35 : -rnd() * 0.3;
        while (u < len) {
          const l = 0.4 + rnd() * 0.8, a = Math.max(0, u), b = Math.min(len, u + l); u += l;
          if (b - a < 0.2) continue;
          const t = (a + b) / 2 / len; if (y + rh * 0.5 > top(t, rnd)) continue;
          const cx = x0 + dx * (a + b) / 2, cz = z0 + dz * (a + b) / 2, k = 0.62 + rnd() * 0.55, moss = y < 0.5 && rnd() < 0.55;
          const col = moss ? shade(pick([0x565c44, 0x60654a]), 0.8 + rnd() * 0.3) : shade(pick(STONE), k);
          const sh = rh - 0.05 - rnd() * 0.05;
          box(A, M(cx, y + rh / 2 + (rnd() - 0.5) * 0.03, cz, (rnd() - 0.5) * 0.08, ang + (rnd() - 0.5) * 0.08, (rnd() - 0.5) * 0.08), th + (rnd() - 0.3) * 0.12, sh, b - a - 0.05 - rnd() * 0.04, col);
        }
        y += rh;
      }
    }
    const jag = (h, amp) => (t, r) => h - r() * amp;
    wall(-BW, -BD, -BW, BD, (t, r) => 3.3 - (t < 0.15 ? r() * 1.2 : r() * 0.4), 0.62);                                  // left
    wall(BW, -BD, BW, BD, (t, r) => (t > 0.1 && t < 0.46 ? 0.9 + r() * 0.5 + Math.sin(t * 20) * 0.2 : 3.3 - r() * 0.5), 0.62); // right, collapsed middle
    wall(-BW - 0.3, -BD, BW + 0.3, -BD, (t, r) => { const x = (t - 0.5) * 2 * (BW + 0.3), g = 3.3 + Math.max(0, 2.0 * (1 - Math.abs(x) / 4.3)); return t > 0.55 ? 3.3 - r() * 0.9 - (t - 0.55) * 2 : g - r() * 0.3; }, 0.62);
    wall(-BW - 0.3, BD, -2.25, BD, jag(3.3, 0.35), 0.62);
    wall(2.25, BD, BW + 0.3, BD, jag(3.1, 0.9), 0.62);
    wall(-2.4, BD, 0.4, BD, (t, r) => 4.3 - t * 0.9 - r() * 0.5, 0.5, 3.34);                                                    // stones over the lintel
    // door jambs are clean dressed blocks; a timber lintel spans the doorway
    box(A, M(0, 3.18, BD), 5.3, 0.3, 0.7, 0x4a3320);
    // wall plates, rafters (some broken), the ridge, planking on the left slope
    const wood = () => shade(pick(WOOD), 0.85 + rnd() * 0.3);
    box(A, M(-BW, 3.42, 0), 0.26, 0.24, 12.8, wood());
    box(A, M(BW, 3.42, 3.6), 0.26, 0.24, 5.4, wood());
    box(A, M(BW, 3.42, -5.6, 0, 0, 0), 0.26, 0.24, 1.2, wood());
    box(A, M(0, 5.52, 1.6, -0.06, 0, 0), 0.24, 0.26, 9.8, wood());
    const RL = Math.hypot(BW + 0.3, 2.1), RA = Math.atan2(2.1, BW + 0.3);
    for (let i = 0; i < 8; i++) {
      const z = 6.0 - i * 1.6;
      if (i < 6 || i === 7) box(A, M(-(BW + 0.3) / 2, 3.45 + 1.05, z, 0, 0, RA), RL, 0.18, 0.14, wood());
      if (i < 3) box(A, M((BW + 0.3) / 2, 3.45 + 1.05, z, 0, 0, -RA), RL, 0.18, 0.14, wood());
      else if (i === 3 || i === 5) box(A, M(BW - 0.9, 3.9, z, 0, 0, -RA - 0.5), RL * 0.45, 0.18, 0.14, wood());
    }
    for (let z = 6.5; z > -1.4; z -= 0.31) {
      if (rnd() < 0.14) continue;
      box(A, M(-(BW + 0.3) / 2 - 0.02, 3.45 + 1.05 + 0.13, z, 0, 0, RA), RL + 0.5, 0.045, 0.27, shade(pick([0x5a4a38, 0x4a3c2e, 0x6a5a48]), 0.8 + rnd() * 0.3));
    }
    for (let z = 6.5; z > 3.8; z -= 0.31) if (rnd() > 0.3) box(A, M((BW + 0.3) / 2 + 0.02, 3.45 + 1.05 + 0.13, z, 0, 0, -RA), RL + 0.5, 0.045, 0.27, shade(0x51422f, 0.8 + rnd() * 0.3));
    box(A, M(1.6, gy(1.6, -3.4) + 0.5, -3.4, 0.2, 0.7, 0.35), 0.2, 0.2, 4.6, wood());                                    // a fallen rafter
    box(A, M(-2.9, gy(-2.9, -5.2) + 0.4, -5.2, 0, 0.1, 0), 1.2, 0.8, 0.9, 0xa8884a);                                     // straw bales
    box(A, M(-2.9, gy(-2.9, -4.2) + 0.4, -4.2, 0, -0.05, 0), 1.2, 0.8, 0.9, 0x9a7c44);
    box(A, M(-2.9, gy(-2.9, -4.7) + 1.2, -4.7, 0, 0.3, 0), 1.2, 0.8, 0.9, 0xb09250);
    for (let i = 0; i < 26; i++) {                                                                                     // rubble from the fallen wall
      const lx = BW + 0.4 + rnd() * 2.2, lz = -4.6 + rnd() * 4.2, s = 0.25 + rnd() * 0.4;
      box(A, M(lx, gy(lx, lz) + s * 0.3, lz, rnd(), rnd() * 3, rnd()), s * 1.4, s, s * 1.1, shade(pick(STONE), 0.8 + rnd() * 0.3));
    }
    // straw and dirt floor, following the ground
    const FX = 14, FZ = 22, fp = [], fn = [], fc = [], VX = [];
    const DIRT = new T.Color(0x3e3122), STRAW = new T.Color(0x9c7c46);
    for (let j = 0; j <= FZ; j++) for (let i = 0; i <= FX; i++) {
      const lx = -3.7 + i * 7.4 / FX, lz = -5.9 + j * 11.8 / FZ;
      const v = clamp(0.45 + 0.22 * Math.sin(lx * 1.7 + lz * 0.6) + 0.18 * Math.sin(lx * 0.5 - lz * 1.3 + 2) + (rnd() - 0.5) * 0.35 - (Math.abs(lx) < 1.2 ? 0.2 : 0), 0, 1);
      VX.push([lx, gy(lx, lz) + 0.03, lz, DIRT.clone().lerp(STRAW, v)]);
    }
    for (let j = 0; j < FZ; j++) for (let i = 0; i < FX; i++) {
      const a = j * (FX + 1) + i, q = [VX[a], VX[a + 1], VX[a + FX + 2], VX[a + FX + 1]];
      [[0, 2, 1], [0, 3, 2]].forEach(tri => tri.forEach(k => { fp.push(q[k][0], q[k][1], q[k][2]); fn.push(0, 1, 0); fc.push(q[k][3].r, q[k][3].g, q[k][3].b); }));
    }
    for (let i = 0; i < fp.length; i++) A.p.push(fp[i]);
    for (let i = 0; i < fn.length; i++) A.n.push(fn[i]);
    for (let i = 0; i < fc.length; i++) A.c.push(fc[i]);
    const mesh = new T.Mesh(finish(A, true), new T.MeshLambertMaterial({ vertexColors: true }));
    mesh.position.set(site.x, y0, site.z); mesh.rotation.y = site.yaw; mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    scene.add(mesh);
    const boxes = [[-BW, 0, 0.36, BD + 0.35, 4], [BW, 0, 0.36, BD + 0.35, 4], [0, -BD, BW + 0.36, 0.36, 5], [-3.28, BD, 1.03, 0.36, 4], [3.28, BD, 1.03, 0.36, 4], [-2.9, -4.7, 0.65, 1.0, 1.6]];
    BARN = { site, y0, mesh, cs, sn, boxes, car: { lx: 0, lz: 0.9 } };
  }
  // circle vs the barn walls (in barn space)
  function barnPush(pos, r) {
    if (!BARN) return false;
    const s = BARN.site, dx = pos.x - s.x, dz = pos.z - s.z;
    if (dx * dx + dz * dz > 200) return false;
    let lx = dx * BARN.cs - dz * BARN.sn, lz = dx * BARN.sn + dz * BARN.cs, hit = false;
    for (const b of BARN.boxes) {
      if (pos.y > BARN.y0 + b[4] + 1) continue;
      const qx = clamp(lx, b[0] - b[2], b[0] + b[2]), qz = clamp(lz, b[1] - b[3], b[1] + b[3]), ex = lx - qx, ez = lz - qz, d = Math.hypot(ex, ez);
      if (d >= r) continue;
      hit = true;
      if (d > 1e-4) { lx = qx + ex / d * r; lz = qz + ez / d * r; }
      else { const px = b[2] - Math.abs(lx - b[0]), pz = b[3] - Math.abs(lz - b[1]); if (px < pz) lx = b[0] + Math.sign(lx - b[0] || 1) * (b[2] + r); else lz = b[1] + Math.sign(lz - b[1] || 1) * (b[3] + r); }
    }
    if (hit) { pos.x = s.x + lx * BARN.cs + lz * BARN.sn; pos.z = s.z - lx * BARN.sn + lz * BARN.cs; }
    return hit;
  }

  // ── Particles: tyre smoke, dust, sparks, backfire flames, engine smoke ─────
  const NPT = 220;
  let PT = null;
  function buildParticles(scene, renderer) {
    const g = new T.BufferGeometry(), pos = new Float32Array(NPT * 3), col = new Float32Array(NPT * 3), size = new Float32Array(NPT), al = new Float32Array(NPT);
    g.setAttribute('position', new T.BufferAttribute(pos, 3).setUsage(T.DynamicDrawUsage)); g.setAttribute('aCol', new T.BufferAttribute(col, 3).setUsage(T.DynamicDrawUsage));
    g.setAttribute('aSize', new T.BufferAttribute(size, 1).setUsage(T.DynamicDrawUsage)); g.setAttribute('aAlpha', new T.BufferAttribute(al, 1).setUsage(T.DynamicDrawUsage));
    const sz = new T.Vector2(); renderer.getDrawingBufferSize(sz);
    const mat = new T.ShaderMaterial({
      uniforms: { uScale: { value: sz.y / 2 / Math.tan(35 * PI / 180) } }, transparent: true, depthWrite: false,
      vertexShader: 'attribute vec3 aCol; attribute float aSize; attribute float aAlpha; uniform float uScale; varying vec3 vC; varying float vA; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = aSize * uScale / max(0.2, -mv.z); vC = aCol; vA = aAlpha; }',
      fragmentShader: 'varying vec3 vC; varying float vA; void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d); if (r > 0.5 || vA < 0.003) discard; gl_FragColor = vec4(vC, vA * smoothstep(0.5, 0.12, r)); }',
    });
    const pts = new T.Points(g, mat); pts.frustumCulled = false; pts.renderOrder = 3; scene.add(pts);
    PT = { pts, pos, col, size, al, vel: new Float32Array(NPT * 3), life: new Float32Array(NPT), max: new Float32Array(NPT), kind: new Uint8Array(NPT), s0: new Float32Array(NPT), a0: new Float32Array(NPT), next: 0 };
  }
  // kind: 0 smoke (grows, rises), 1 spark (falls), 2 flame
  function emitP(kind, x, y, z, vx, vy, vz, life, size, r, g, b, a) {
    if (!PT) return;
    const i = PT.next; PT.next = (PT.next + 1) % NPT;
    PT.pos[i * 3] = x; PT.pos[i * 3 + 1] = y; PT.pos[i * 3 + 2] = z; PT.vel[i * 3] = vx; PT.vel[i * 3 + 1] = vy; PT.vel[i * 3 + 2] = vz;
    PT.life[i] = PT.max[i] = life; PT.kind[i] = kind; PT.s0[i] = size; PT.a0[i] = a; PT.col[i * 3] = r; PT.col[i * 3 + 1] = g; PT.col[i * 3 + 2] = b;
  }
  function updateParticles(dt) {
    if (!PT) return;
    let any = false;
    for (let i = 0; i < NPT; i++) {
      if (PT.life[i] <= 0) { if (PT.al[i] !== 0) { PT.al[i] = 0; PT.size[i] = 0; any = true; } continue; }
      any = true; PT.life[i] -= dt; const f = Math.max(0, PT.life[i] / PT.max[i]), k = PT.kind[i], j = i * 3;
      if (k === 0) { const d = 1 - Math.min(1, dt * 1.6); PT.vel[j] *= d; PT.vel[j + 2] *= d; PT.vel[j + 1] = PT.vel[j + 1] * d + 0.7 * dt; PT.size[i] = PT.s0[i] * (1 + (1 - f) * 2.6); PT.al[i] = PT.a0[i] * f * Math.min(1, (1 - f) * 8); }
      else if (k === 1) { PT.vel[j + 1] -= 9.8 * dt; PT.size[i] = PT.s0[i]; PT.al[i] = f > 0.2 ? 1 : f * 5; }
      else { PT.size[i] = PT.s0[i] * (0.6 + f); PT.al[i] = f; PT.col[j + 1] = 0.4 + f * 1.8; }
      PT.pos[j] += PT.vel[j] * dt; PT.pos[j + 1] += PT.vel[j + 1] * dt; PT.pos[j + 2] += PT.vel[j + 2] * dt;
    }
    if (any) { const a = PT.pts.geometry.attributes; a.position.needsUpdate = a.aCol.needsUpdate = a.aSize.needsUpdate = a.aAlpha.needsUpdate = true; }
  }
  function sparks(x, y, z, nx, nz, n) {
    for (let i = 0; i < n; i++) emitP(1, x, y, z, nx * (2 + Math.random() * 5) + (Math.random() - 0.5) * 6, 1 + Math.random() * 4, nz * (2 + Math.random() * 5) + (Math.random() - 0.5) * 6, 0.3 + Math.random() * 0.4, 0.05, 6, 3.4, 1.2, 1);
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let CORE = null, ready = false, IO = null, time = 0, AUTO = null, lastSave = 0, barkT = -9, enterT = -9, startT = -1, thudT = 0, crankT = 0, lastExitT = -9, bfT = 0;
  let chaseH = 0, chaseY = 0, orbit = 0, orbitP = 0, lookIdle = 0, headYaw = 0, headPitch = 0, hemi = null;
  const hitCD = new Map(), dive = new Map();
  const SPOTS = [];
  const V = CT.vehicle = { driving: false, view: 'chase' };
  const V1 = new T.Vector3(), V2 = new T.Vector3(), V3 = new T.Vector3(), Q1 = new T.Quaternion(), E1 = new T.Euler(0, 0, 0, 'YXZ'), M1 = new T.Matrix4();
  const I0 = { thr: 0, brk: 0, steer: 0, hand: false, boost: false };

  function load() {
    try { const s = JSON.parse(localStorage.getItem(LS) || 'null'); if (s && typeof s.x === 'number') return s; } catch (e) {}
    return null;
  }
  function save() {
    try { localStorage.setItem(LS, JSON.stringify({ x: +car.x.toFixed(2), z: +car.z.toFixed(2), h: +car.h.toFixed(3), hp: Math.round(car.hp), inBarn: car.inBarn, found: car.found, view: V.view })); } catch (e) {}
  }

  // ── Road lookup (surface) ──────────────────────────────────────────────────
  let RG = null;
  function roadGrid() {
    RG = new Map();
    const roads = (CT.world && CT.world.roads) || [];
    roads.forEach(r => { for (let i = 0; i < r.n; i++) { const k = Math.floor(r.X[i] / 20) + ',' + Math.floor(r.Z[i] / 20); let a = RG.get(k); if (!a) RG.set(k, a = []); a.push(r.X[i], r.Z[i]); } });
  }
  function roadDist(x, z) {
    if (!RG) roadGrid();
    const cx = Math.floor(x / 20), cz = Math.floor(z / 20); let bd = 1e9;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const L = RG.get((cx + a) + ',' + (cz + b)); if (L) for (let i = 0; i < L.length; i += 2) { const d = (L[i] - x) * (L[i] - x) + (L[i + 1] - z) * (L[i + 1] - z); if (d < bd) bd = d; } }
    return Math.sqrt(bd);
  }
  let surfT = 0, surfName = 'grass';
  function surface(dt) {
    surfT -= dt;
    if (surfT <= 0) {
      surfT = 0.15;
      const rd = roadDist(car.x, car.z), bio = has('world', 'biomeAt') ? CT.world.biomeAt(car.x, car.z) : 'meadow', wet = has('world', 'waterAt') ? CT.world.waterAt(car.x, car.z) || 0 : 0;
      let top = 30, grip = 0.85, drag = 0.8; surfName = 'grass';
      if (rd < 4.2 || bio === 'citadel') { top = 45; grip = 1.0; drag = 0.4; surfName = 'road'; }
      else if (bio === 'swamp') { top = 11; grip = 0.5; drag = 3.5; surfName = 'mud'; }
      else if (bio === 'snow') { top = 13; grip = 0.45; drag = 2.6; surfName = 'snow'; }
      else if (bio === 'coast') { top = 24; grip = 0.7; drag = 1.4; surfName = 'sand'; }
      else if (bio === 'forest') { top = 26; grip = 0.8; drag = 1.0; }
      if (wet > 0.3) { top = Math.min(top, wet > 1 ? 5 : 9); drag += 4; surfName = 'water'; }
      car.surfT = { top, grip, drag };
    }
    const s = car.surf, t = car.surfT || s, k = Math.min(1, dt * 2.5);
    s.top += (t.top - s.top) * k; s.grip += (t.grip - s.grip) * k; s.drag += (t.drag - s.drag) * k;
  }

  // ── Physics ────────────────────────────────────────────────────────────────
  const GT = [0, 12.5, 21, 31, 60];
  const gnd = new Float32Array(4);
  function physics(dt, I) {
    surface(dt);
    const sp = car.surf, fx = Math.sin(car.h), fz = Math.cos(car.h), rx = -Math.cos(car.h), rz = Math.sin(car.h);
    let vf = car.vx * fx + car.vz * fz, vs = car.vx * rx + car.vz * rz;
    const stalled = car.stall > 0, grounded = car.air < 0.08;
    const thr = stalled ? 0 : I.thr, brk = I.brk, boost = I.boost && !stalled, hand = I.hand;
    car.thrS += (thr - car.thrS) * Math.min(1, dt * 8);
    let accF = 0;
    // steering (softer at speed)
    car.steer += (I.steer - car.steer) * Math.min(1, dt * (I.steer === 0 ? 7 : 4.5));
    if (grounded) {
      const top = sp.top * (boost ? 1.12 : 1);
      car.burn = boost && thr > 0.5 && vf < 10 && vf > -1 ? Math.min(1, car.burn + dt * 3) : Math.max(0, car.burn - dt * 2);
      if (thr > 0) {
        if (vf < -0.5) accF += 14 * thr;
        else accF += 11.5 * (boost ? 1.45 : 1) * thr * Math.max(0, 1 - Math.pow(Math.max(0, vf) / top, 2)) * (car.shiftT > 0 ? 0.35 : 1) * (1 - car.burn * 0.45);
      }
      if (brk > 0) { if (vf > 0.6) accF -= 17 * brk; else if (!stalled) accF -= 7 * brk * Math.max(0, 1 - Math.max(0, -vf) / 11); else accF -= Math.sign(vf) * 6; }
      vf += accF * dt;
      if (thr < 0.05 && brk < 0.05) vf -= Math.sign(vf) * Math.min(Math.abs(vf), (1.2 + sp.drag) * dt);
      if (vf > top) vf += (top - vf) * Math.min(1, dt * 0.9);
      vf -= vf * Math.abs(vf) * 0.0008 * dt;
      if (hand) vf -= Math.sign(vf) * Math.min(Math.abs(vf), 5.5 * dt);
      const maxS = lerp(0.6, 0.15, clamp(Math.abs(vf) / 40, 0, 1)), ang = car.steer * maxS;
      let wT = -vf * Math.tan(ang) / WB;
      const aMax = 11 * sp.grip;
      if (Math.abs(wT * vf) > aMax) wT = Math.sign(wT) * aMax / Math.max(1, Math.abs(vf));
      let resp = 7 * sp.grip, lat = 9 * sp.grip;
      const sliding = Math.abs(vs) > 2.5;
      if (hand && Math.abs(vf) > 4) { wT = wT * 1.8 - car.steer * 1.3 * Math.sign(vf); resp = 3.2; lat = 1.2; }
      else if (sliding && thr > 0.6 && (boost || Math.abs(car.steer) > 0.4)) lat = 2.4;
      if (car.burn > 0.2) { wT += -car.steer * 0.9 + (Math.random() - 0.5) * 0.6 * car.burn; lat = Math.min(lat, 3); }
      car.w += (wT - car.w) * Math.min(1, dt * resp);
      vs *= Math.exp(-lat * dt);
      car.vx = fx * vf + rx * vs; car.vz = fz * vf + rz * vs;
      const n = has('world', 'normalAt') ? CT.world.normalAt(car.x, car.z) : null;
      if (n && n.y < 0.995 && !(Math.hypot(car.vx, car.vz) < 0.6 && thr < 0.05)) { car.vx += n.x * 8.3 * dt; car.vz += n.z * 8.3 * dt; }
      if (Math.hypot(car.vx, car.vz) < 0.35 && thr < 0.05 && (brk < 0.05 || !V.driving)) { car.vx = car.vz = 0; car.w *= 0.5; }
    } else car.w *= 1 - dt * 0.4;
    car.slip = clamp((Math.abs(vs) - 1.6) / 5, 0, 1) + (brk > 0.5 && vf > 9 ? 0.35 : 0) + car.burn * 0.9 + (hand && Math.abs(vf) > 6 ? 0.4 : 0);
    car.slip = grounded ? Math.min(1, car.slip) : 0;
    car.h = wrapA(car.h + car.w * dt);
    car.x += car.vx * dt; car.z += car.vz * dt;
    car.accL += ((vf - car.vfPrev) / dt - car.accL) * Math.min(1, dt * 6); car.vfPrev = vf;
    // gears and revs
    const af = Math.abs(vf);
    if (af < 0.5 && thr < 0.05) car.gear = 1;
    if (vf > 0 && car.gear < 4 && af > GT[car.gear] * 0.95) { car.gear++; car.shiftT = 0.24; if (V.driving) sfx('car_shift'); }
    if (car.gear > 1 && af < GT[car.gear - 1] * 0.6) car.gear--;
    car.shiftT = Math.max(0, car.shiftT - dt);
    let rt = vf < -0.3 ? 900 + af / 11 * 4200 : 800 + af / GT[car.gear] * 5500;
    if ((thr > 0.1 && af < 2) || car.burn > 0.2 || !grounded) rt = Math.max(rt, 850 + thr * (boost ? 5900 : 3900));
    if (car.shiftT > 0) rt *= 0.7;
    rt = stalled ? 0 : clamp(rt, 740, 6600);
    car.rpm += (rt - car.rpm) * Math.min(1, dt * (rt > car.rpm ? 8 : 5));
    if (V.driving && I.thrPrev > 0.6 && thr < 0.15 && car.rpm > 3400 && time - bfT > 0.6) { bfT = time; sfx('car_backfire'); flames(); }
    I.thrPrev = thr;
    return vf;
  }
  function suspension(dt) {
    const ch = Math.cos(car.h), sh = Math.sin(car.h);
    for (let i = 0; i < 4; i++) { const lx = WHEELS[i][0], lz = WHEELS[i][1]; gnd[i] = H(car.x + lx * ch + lz * sh, car.z - lx * sh + lz * ch); }
    const gF = (gnd[0] + gnd[1]) / 2, gR = (gnd[2] + gnd[3]) / 2, gL = (gnd[0] + gnd[2]) / 2, gRt = (gnd[1] + gnd[3]) / 2;
    const yd = (gF + gR) / 2, vyd = car.ydInit ? (yd - car.yd) / dt : 0; car.yd = yd; car.ydInit = true;
    const was = car.air, vy0 = car.vy;
    let a = 110 * (yd - car.y) + 15 * (vyd - car.vy); if (a < -22) a = -22;
    car.vy += a * dt; car.y += car.vy * dt;
    if (car.y < yd - 0.2) { car.y = yd - 0.2; if (car.vy < vyd) car.vy = vyd; }
    car.air = car.y > yd + 0.12 ? car.air + dt : 0;
    if (was > 0.3 && car.air === 0 && V.driving) {
      const imp = Math.max(0, -(vy0 - vyd));
      if (imp > 5) { sfx('car_thud', { heavy: imp > 10, volume: clamp(imp / 14, 0.3, 1) }); if (CORE) CORE.shake(clamp(imp / 16, 0.2, 1), 0.3); if (imp > 11) hurtCar((imp - 10) * 2); }
    }
    let pd = Math.atan2(gF - gR, WB), rd = Math.atan2(gL - gRt, 2 * TRK);
    if (car.air === 0) { pd += clamp(car.accL * 0.0045, -0.05, 0.05); rd += clamp(car.w * car.vfPrev * 0.009, -0.075, 0.075); }
    else pd = car.pitch - 0.05;
    const kp = car.air ? 20 : 130;
    car.pv += (kp * (pd - car.pitch) - 15 * car.pv) * dt; car.pitch += car.pv * dt;
    car.rv += (kp * (rd - car.roll) - 15 * car.rv) * dt; car.roll += car.rv * dt;
  }
  // world obstacles: three circles along the car
  const PROBE = [1.5, 0, -1.5], PR = new T.Vector3();
  function collisions(dt) {
    const fx = Math.sin(car.h), fz = Math.cos(car.h);
    let bx = 0, bz = 0, bl = 0, bp = 0;
    for (let i = 0; i < 3; i++) {
      const px = car.x + fx * PROBE[i], pz = car.z + fz * PROBE[i];
      PR.set(px, car.y + 0.5, pz);
      if (has('world', 'collide')) CT.world.collide(PR, 0.95);
      barnPush(PR, 0.95);
      const dx = PR.x - px, dz = PR.z - pz, l = Math.hypot(dx, dz);
      if (l > bl) { bl = l; bx = dx; bz = dz; bp = PROBE[i]; }
    }
    const lim = C.ISLAND - 22; car.x = clamp(car.x, -lim, lim); car.z = clamp(car.z, -lim, lim);
    if (bl < 1e-4) return;
    car.x += bx; car.z += bz;
    const nx = bx / bl, nz = bz / bl, vn = car.vx * nx + car.vz * nz;
    if (vn >= 0) return;
    const imp = -vn;
    if (imp > 1.5) {
      car.vx -= 1.3 * vn * nx; car.vz -= 1.3 * vn * nz;
      const tq = fz * bp * (nx * imp) - fx * bp * (nz * imp);
      car.w += tq * 0.12;
      if (imp > 5 && time - thudT > 0.25 && V.driving) {
        thudT = time;
        sfx('car_thud', { heavy: imp > 14, volume: clamp(imp / 20, 0.35, 1) });
        if (CORE) { CORE.shake(clamp(imp / 18, 0.25, 1.3), 0.35); if (imp > 14) CORE.hitStop(0.05); }
        sparks(car.x + fx * bp - nx * 0.95, car.y + 0.5, car.z + fz * bp - nz * 0.95, nx, nz, Math.min(40, 8 + imp * 1.5));
        hurtCar((imp - 4) * 1.7); if (imp > 9) ride('crash');
      }
    } else { car.vx -= vn * nx; car.vz -= vn * nz; }
  }
  function hurtCar(n) {
    if (!(n > 0) || car.stall > 0) return;
    car.hp = Math.max(0, car.hp - n);
    if (car.hp <= 0) {
      car.stall = 30; car.rpm = 0;
      emit('notify', { text: 'The Iron Stallion shudders and dies. Its sky-iron heart must cool.', kind: 'story' });
      sfx('car_backfire'); sfx('car_thud', { heavy: true });
    }
  }
  function flames() {
    const fx = Math.sin(car.h), fz = Math.cos(car.h), ch = Math.cos(car.h), sh = Math.sin(car.h);
    for (const lx of [0.5, -0.5]) {
      const x = car.x + lx * ch - 2.47 * sh, z = car.z - lx * sh - 2.47 * ch;
      for (let i = 0; i < 4; i++) emitP(2, x, car.y + 0.29, z, -fx * (2 + Math.random() * 3) + car.vx, Math.random(), -fz * (2 + Math.random() * 3) + car.vz, 0.12 + Math.random() * 0.1, 0.22, 5, 1.6, 0.4, 1);
    }
  }

  // ── Mayhem: monsters under the wheels; villagers dive clear ────────────────
  const HEAVY = { troll: 1, boneKing: 1 };
  const PARTS = ['legL', 'legR', 'head', 'torso', 'armL', 'armR'];
  function mayhem(dt, vf) {
    const sp = Math.hypot(car.vx, car.vz), ch = Math.cos(car.h), sh = Math.sin(car.h);
    const L = (CT.monsters && CT.monsters.list) || [];
    for (let i = 0; i < L.length; i++) {
      const m = L[i]; if (!m || !m.pos || m.gibbed) continue;
      const dx = m.pos.x - car.x, dz = m.pos.z - car.z;
      if (dx * dx + dz * dz > 16 || Math.abs((m.pos.y || 0) - car.y) > 2.5) continue;
      const mr = 0.45 * (m.scale || 1), lx = dx * ch - dz * sh, lz = dx * sh + dz * ch;
      if (Math.abs(lx) > HWID + mr || Math.abs(lz) > HL + 0.08 + mr) continue;
      const d = Math.hypot(dx, dz) || 1, nx = dx / d, nz = dz / d, close = car.vx * nx + car.vz * nz;
      const cd = hitCD.get(m) || 0;
      if (time < cd) continue;
      const dir = new T.Vector3(car.vx, 0, car.vz); if (dir.lengthSq() < 0.01) dir.set(nx, 0, nz); dir.normalize(); dir.y = 0.25;
      const heavy = HEAVY[m.type] || m.isBoss || (m.scale || 1) >= 1.8;
      if (!m.alive) continue;
      if (m.dead) {                                                               // corpses get mangled under the tyres
        if (sp > 6 && has('monsters', 'damage')) { hitCD.set(m, time + 0.7); CT.monsters.damage(m, 60, dir, PARTS[(Math.random() * PARTS.length) | 0], true, { source: 'player' }); sfx('car_squish'); if (CORE) CORE.shake(0.25, 0.15); }
        continue;
      }
      if (close < 2) {                                                            // slow: shove them along
        const push = (HWID + mr - Math.abs(lx)) * 0.5; if (push > 0 && !heavy) { m.pos.x += nx * push; m.pos.z += nz * push; }
        continue;
      }
      hitCD.set(m, time + (heavy ? 1.0 : 0.6));
      if (!has('monsters', 'damage')) continue;
      if (heavy) {                                                                 // a troll or the Bone King stops the car dead
        car.vx -= 1.25 * close * nx; car.vz -= 1.25 * close * nz; car.w += (Math.random() - 0.5) * 2;
        CT.monsters.damage(m, close * 5, dir, 'torso', true, { source: 'player' });
        sfx('car_thud', { heavy: true, volume: 1 }); if (CORE) { CORE.shake(1.4, 0.5); CORE.hitStop(0.1); }
        sparks(car.x + nx * 2, car.y + 0.6, car.z + nz * 2, -nx, -nz, 18);
        hurtCar(close * 1.6);
        continue;
      }
      const part = PARTS[(Math.random() * PARTS.length) | 0], amt = close > 20 ? 2000 : close >= 9 ? (m.hp || 60) * 2.6 + 40 + close * 5 : close * 6;
      const r = CT.monsters.damage(m, amt, dir, part, close > 5, { source: 'player' }) || {};
      if (m.kv) m.kv.addScaledVector(dir, Math.min(14, close * 0.45));
      if (has('gore', 'burst') && close >= 9) CT.gore.burst(V1.set(m.pos.x, (m.pos.y || car.y) + 1.0, m.pos.z), 1.2 + close / 20);
      if (has('gore', 'spray') && close >= 6) CT.gore.spray(V2.set(m.pos.x, (m.pos.y || car.y) + 0.9, m.pos.z), V3.set(dir.x, 0.8, dir.z).normalize(), 1.4);
      sfx('car_squish', { heavy: close > 15 }); if (r.killed) ride('kill');
      if (CORE) { CORE.shake(clamp(0.35 + close / 40, 0.35, 1), 0.3); CORE.hitStop(r.killed ? 0.05 : 0.03); }
      if (V.view === 'cockpit' && has('gore', 'screen')) CT.gore.screen(clamp(0.25 + close / 45, 0.25, 0.9));
      car.vx *= 0.94; car.vz *= 0.94; hurtCar(0.6);
    }
    // villagers and the named folk: never hurt. They dive clear, or get shoved aside.
    const N = (CT.npcs && CT.npcs.list) || [];
    for (let i = 0; i < N.length; i++) {
      const n = N[i]; if (!n || !n.pos || (n.R && n.R.root && !n.R.root.visible)) continue;
      const dx = n.pos.x - car.x, dz = n.pos.z - car.z; if (dx * dx + dz * dz > 400) continue;
      const lx = dx * ch - dz * sh, lz = dx * sh + dz * ch, ahead = vf >= 0 ? lz : -lz, reach = HL + 1 + Math.abs(vf) * 0.7;
      let dv = dive.get(n);
      if (!dv && sp > 4 && ahead > 0 && ahead < reach && Math.abs(lx) < HWID + 1.2) {
        const side = Math.abs(lx) > 0.15 ? Math.sign(lx) : (Math.random() < 0.5 ? -1 : 1);
        dive.set(n, dv = { t: 0, x: ch * side, z: -sh * side });
        if ((n.kind === 'villager' || (n.tags && n.tags.indexOf('villager') >= 0)) && time - barkT > 4) { barkT = time; emit('notify', { text: `${n.name || 'A villager'} dives clear!`, kind: 'bark' }); }
      }
      if (dv) { dv.t += dt; const k = dv.t < 0.35 ? 9 * dt : 0; n.pos.x += dv.x * k; n.pos.z += dv.z * k; if (dv.t > 2) dive.delete(n); }
      const lx2 = (n.pos.x - car.x) * ch - (n.pos.z - car.z) * sh, lz2 = (n.pos.x - car.x) * sh + (n.pos.z - car.z) * ch;
      if (Math.abs(lx2) < HWID + 0.4 && Math.abs(lz2) < HL + 0.4) {                 // still in the way: shove aside and brake
        const s = Math.sign(lx2) || 1, push = HWID + 0.45 - Math.abs(lx2);
        n.pos.x += ch * s * push; n.pos.z += -sh * s * push;
        car.vx *= 1 - Math.min(0.5, dt * 6); car.vz *= 1 - Math.min(0.5, dt * 6);
      }
    }
    // road travellers (life.js): they sidestep off the car's line (their group pulls them back to the road after)
    if (sp > 2 && CT.life && CT.life.debug && typeof CT.life.debug.state === 'function') {
      const S = CT.life.debug.state(), GR = (S && S.GROUPS) || [];
      for (const g of GR) for (const e of (g.members || [])) {
        if (!e || e.dead || typeof e.x !== 'number') continue;
        const dx = e.x - car.x, dz = e.z - car.z; if (dx * dx + dz * dz > 900) continue;
        const lx = dx * ch - dz * sh, lz = dx * sh + dz * ch, ahead = vf >= 0 ? lz : -lz;
        if (ahead < -HL - 0.6 || ahead > HL + 1.5 + Math.abs(vf) * 0.6 || Math.abs(lx) > HWID + 0.8) continue;
        const s = Math.sign(lx) || 1, gap = HWID + 0.8 - Math.abs(lx), inside = Math.abs(ahead) < HL + 0.5;
        const push = inside ? gap : Math.min(gap, (5 + Math.abs(vf) * 0.4) * dt);
        e.x += ch * s * push; e.z -= sh * s * push;
      }
    }
  }

  // ── Enter / exit ───────────────────────────────────────────────────────────
  function enter() {
    const PL = CT.player; if (!PL || !PL.alive || V.driving || !G) return;
    V.driving = true; enterT = time; startT = car.stall > 0 ? -1 : 0.45; car.inBarn = false; PAS.state = 'pending';
    if (IO) IO.disabled = true;
    const cam = CORE.camera; chaseH = car.h; chaseY = cam.position.y; orbit = orbitP = 0; headYaw = headPitch = 0;
    sfx('car_door');
    if (car.stall > 0) emit('notify', { text: `The engine is still cooling: ${Math.ceil(car.stall)} s.`, kind: 'info' });
    if (!car.told) { car.told = true; emit('notify', { text: CORE.isTouch ? 'Left stick: steer and throttle. EXIT to leave.' : 'W/S drive, A/D steer, Space handbrake, Shift floor it, V view, H horn, E exit.', kind: 'info' }); }
    save();
  }
  function exit(forced) {
    const PL = CT.player; if (!V.driving) return;
    V.driving = false; lastExitT = time; passengerOut();
    if (IO) IO.disabled = false;
    if (has('audio', 'car')) CT.audio.car({ on: false });
    const ch = Math.cos(car.h), sh = Math.sin(car.h);
    let best = null;
    for (const c of [[1.65, -0.1], [-1.65, -0.1], [0, 3.3], [0, -3.3], [2.6, 1.5], [-2.6, 1.5]]) {
      const x = car.x + c[0] * ch + c[1] * sh, z = car.z - c[0] * sh + c[1] * ch, y = H(x, z);
      V1.set(x, y + 0.5, z);
      if (has('world', 'collide')) CT.world.collide(V1, 0.5);
      const moved = Math.hypot(V1.x - x, V1.z - z) > 0.15 || barnPush(V1, 0.5) || Math.abs(y - car.y) > 1.6;
      if (!moved || forced) { best = [x, z]; break; }
    }
    if (!best) best = [car.x + 1.65 * ch, car.z - 1.65 * sh];
    if (PL && PL.pos) {
      PL.pos.set(best[0], H(best[0], best[1]) + 0.05, best[1]);
      if (!forced) { PL.yaw = car.h + PI; PL.pitch = 0; }
      if (PL.vel) PL.vel.set(0, 0, 0);
    }
    sfx('car_door'); lamps(false, false, false);
    save();
  }
  function onUse() { if (!V.driving && time - lastExitT > 0.4) enter(); }
  // While driving, E means "leave the car": hush the loot and chest prompts near the car, restore them after.
  const hushed = new Set();
  function hush(on) {
    const L = CT.interactables && CT.interactables.list; if (!L) return;
    if (on) for (const o of L) { if (o === IO || o.disabled || o._carHush) continue; if (Math.hypot(o.x - car.x, o.z - car.z) < 9) { o.disabled = true; o._carHush = true; hushed.add(o); } }
    for (const o of hushed) if (!on || Math.hypot(o.x - car.x, o.z - car.z) > 11) { if (o._carHush) { o.disabled = false; delete o._carHush; } hushed.delete(o); }
  }

  // ── Lamps and beams ────────────────────────────────────────────────────────
  const night = () => { const t = CT.sky && typeof CT.sky.timeOfDay === 'number' ? CT.sky.timeOfDay : 0.5; return t > 0.74 || t < 0.26; };
  function lamps(on, brake, running) {
    if (!MAT) return;
    MAT.LU.uHead.value = on ? 7 : 0.75;
    MAT.LU.uTail.value = brake ? 6 : running ? (on ? 2.4 : 1.2) : 0.6;
    SPOTS.forEach(s => { s.intensity = on ? 700 : 0; });
  }

  // ── Camera ─────────────────────────────────────────────────────────────────
  const tgt = new T.Vector3(), want = new T.Vector3(), RAYD = new T.Vector3();
  function camera(dt, core) {
    const cam = core.camera, I = core.input || {}, lx = +I.lookDX || 0, ly = +I.lookDY || 0, sp = Math.hypot(car.vx, car.vz);
    if (Math.abs(lx) + Math.abs(ly) > 1e-5) lookIdle = 0; else lookIdle += dt;
    G.grp.updateMatrixWorld(true);
    if (V.view === 'cockpit') {
      headYaw = clamp(headYaw - lx, -1.9, 1.9); headPitch = clamp(headPitch - ly, -0.7, 0.6);
      if (PAS.glance > 0) { PAS.glance -= dt; if (lookIdle > 0.4) headYaw += (-1.45 - headYaw) * Math.min(1, dt * 3); }     // a glance at her when she talks
      else if (lookIdle > 1.2 && sp > 2) { const k = Math.exp(-dt * 2.5); headYaw *= k; headPitch *= k; }
      cam.position.copy(V1.copy(HEAD)).applyMatrix4(G.grp.matrixWorld);
      Q1.setFromEuler(E1.set(headPitch - 0.05, PI + headYaw, 0, 'YXZ'));
      cam.quaternion.copy(G.grp.quaternion).multiply(Q1);
      return;
    }
    orbit = wrapA(orbit - lx); orbitP = clamp(orbitP - ly * 0.6, -0.25, 0.7);
    if (lookIdle > 1.5) { const k = Math.exp(-dt * 2); orbit *= k; orbitP *= k; }
    let base = car.h;
    if (sp > 4 && car.vfPrev > 0) base = car.h + wrapA(Math.atan2(car.vx, car.vz) - car.h) * 0.45;
    chaseH = wrapA(chaseH + wrapA(base + orbit - chaseH) * Math.min(1, dt * (Math.abs(lx) > 0 ? 30 : 5)));
    const dist = 6.3 + Math.min(1.6, sp * 0.035), up = 2.1 + orbitP * 4;
    tgt.set(car.x + Math.sin(car.h) * 1.1, car.y + 1.05, car.z + Math.cos(car.h) * 1.1);
    want.set(car.x - Math.sin(chaseH) * dist, 0, car.z - Math.cos(chaseH) * dist);
    let wy = car.y + up;
    chaseY += (wy - chaseY) * Math.min(1, dt * 6); wy = chaseY;
    want.y = Math.max(wy, H(want.x, want.z) + 0.7);
    if (has('world', 'raycast')) {
      RAYD.subVectors(want, tgt); const L = RAYD.length(); RAYD.divideScalar(L || 1);
      const hit = CT.world.raycast(tgt, RAYD, L);
      if (hit && hit.dist < L) { const d = Math.max(1.6, hit.dist - 0.35); want.copy(tgt).addScaledVector(RAYD, d); want.y = Math.max(want.y, H(want.x, want.z) + 0.5); }
    }
    cam.position.copy(want);
    cam.up.set(0, 1, 0); cam.lookAt(tgt);
  }

  // ── Visual update: body transform, wheels, shadow, lamps ───────────────────
  const WM = new T.Matrix4(), WQ = new T.Quaternion(), WS = new T.Vector3(1, 1, 1), WP = new T.Vector3(), FLIP = new T.Matrix4().makeRotationY(PI), SPN = new T.Matrix4(), STR = new T.Matrix4();
  function visuals(dt, vf, core) {
    const g = G.grp;
    g.position.set(car.x, car.y, car.z); g.rotation.set(-car.pitch, car.h, car.roll);
    g.updateMatrixWorld(true);
    const ch = Math.cos(car.h), sh = Math.sin(car.h), inv = M1.copy(g.matrixWorld).invert();
    for (let i = 0; i < 4; i++) {
      const lx = WHEELS[i][0], lz = WHEELS[i][1];
      V1.set(lx, WRAD, lz).applyMatrix4(g.matrixWorld);
      const gw = gnd[i] + WRAD, d = clamp(gw - V1.y, -0.11, 0.1);
      G.susp[i] += (d - G.susp[i]) * Math.min(1, dt * 20);
      G.spin[i] = (G.spin[i] + (car.burn > 0.2 && i > 1 ? 40 : vf / WRAD) * dt) % TAU;
      const st = i < 2 ? car.steer * lerp(0.6, 0.15, clamp(Math.abs(vf) / 40, 0, 1)) * -1 : 0;
      STR.makeRotationY(st); SPN.makeRotationX(G.spin[i]);
      WM.makeTranslation(lx, WRAD + G.susp[i], lz).multiply(STR).multiply(SPN);
      if (lx < 0) WM.multiply(FLIP);
      G.tyres.setMatrixAt(i, WM); G.rims.setMatrixAt(i, WM);
    }
    G.tyres.instanceMatrix.needsUpdate = G.rims.instanceMatrix.needsUpdate = true;
    G.wheel.rotation.z = -car.steer * 2.4;
    // blob shadow on the ground under the car
    const n = has('world', 'normalAt') ? CT.world.normalAt(car.x, car.z) : V2.set(0, 1, 0);
    V2.set(n.x, n.y, n.z).normalize(); V3.set(sh, 0, ch); V3.addScaledVector(V2, -V3.dot(V2)).normalize(); V1.crossVectors(V2, V3);
    M1.makeBasis(V1, V2, V3); G.shadow.quaternion.setFromRotationMatrix(M1);
    G.shadow.position.set(car.x, H(car.x, car.z) + 0.05, car.z);
    G.shadow.material.opacity = clamp(0.8 - (car.y - car.yd) * 1.5, 0.2, 0.8);
    // glass: dark tint outside, nearly clear from the driver's seat
    const cock = V.driving && V.view === 'cockpit';
    MAT.glass.opacity = cock ? 0.14 : 0.52;
    // paint reflections follow the daylight
    if (!hemi && core.scene) core.scene.traverse(o => { if (!hemi && o.isHemisphereLight) hemi = o; });
    const day = hemi ? clamp(hemi.intensity * 0.55, 0.05, 1.1) : 0.8;
    updatePassenger(dt, core);
    MAT.paint.envMapIntensity = day; MAT.chrome.envMapIntensity = day * 1.1; MAT.rim.envMapIntensity = day; MAT.glass.envMapIntensity = day * 1.2;
  }

  // ── Build on approach ──────────────────────────────────────────────────────
  function ensureBuilt(core, PL) {
    if (G) return true;
    const hb = (C.POIS || []).find(p => p.id === 'harrowby') || { x: 120, z: 980 };
    const sv = load();
    const near = Math.hypot(PL.pos.x - hb.x, PL.pos.z - hb.z) < 300 || (sv && !sv.inBarn && Math.hypot(PL.pos.x - sv.x, PL.pos.z - sv.z) < 250);
    if (!near) return false;
    const site = findBarnSite(); if (!site) return false;
    buildBarn(core.scene, site);
    buildCar(core.scene);
    buildParticles(core.scene, core.renderer);
    const cs = BARN.cs, sn = BARN.sn, bl = BARN.car;
    const noSave = (() => { try { return !localStorage.getItem('crimsonThrone.save'); } catch (e) { return true; } })();
    if (sv && !noSave && !sv.inBarn) { car.x = sv.x; car.z = sv.z; car.h = sv.h || 0; car.inBarn = false; }
    else { car.x = site.x + bl.lx * cs + bl.lz * sn; car.z = site.z - bl.lx * sn + bl.lz * cs; car.h = site.yaw; car.inBarn = true; }
    if (sv) { car.hp = clamp(sv.hp == null ? 100 : sv.hp, 0, 100); car.found = !!sv.found && !noSave; if (sv.view === 'cockpit') V.view = 'cockpit'; }
    if (car.hp <= 0) car.hp = 40;
    car.y = car.yd = H(car.x, car.z);
    suspension(0.016); car.y = car.yd; car.pitch = car.roll = 0;
    visuals(0.016, 0, core);
    lamps(false, false, false);
    return true;
  }

  // ── Tick (from CT.player.update) ───────────────────────────────────────────
  function tick(dt, core) {
    CORE = core;
    const PL = CT.player; if (!ready || !PL || !PL.pos || !core || !core.scene) return false;
    time += dt;
    if (!ensureBuilt(core, PL)) return false;
    if (!IO && CT.interactables && typeof CT.interactables.add === 'function') IO = CT.interactables.add({ x: car.x, z: car.z, radius: 3.6, label: 'Drive the Iron Stallion', onUse });
    if (IO) { IO.x = car.x; IO.z = car.z; IO.disabled = V.driving; }
    if (V.driving || hushed.size) hush(V.driving);
    // discovery
    if (!car.found && BARN && Math.hypot(PL.pos.x - BARN.site.x, PL.pos.z - BARN.site.z) < 30) {
      car.found = true; save();
      emit('notify', { text: "DISCOVERED: The Stallion's Barn", kind: 'discover' }); sfx('discover');
      setTimeout(() => emit('notify', { text: 'Under the broken roof waits a beast of sky-iron, blue as a winter sky, striped like night.', kind: 'story' }), 1600);
    }
    // cooling after a stall; slow self-mending while parked
    if (car.stall > 0) {
      car.stall -= dt;
      if (car.stall <= 0) { car.stall = 0; car.hp = 40; emit('notify', { text: 'The sky-iron heart is cool. The Stallion will run again.', kind: 'info' }); if (V.driving) startT = 0; }
    } else if (!V.driving) car.hp = Math.min(100, car.hp + dt * 0.4);
    if (dt <= 0) return V.driving && PL.alive;

    if (V.driving && !PL.alive) exit(true);
    const far = Math.hypot(PL.pos.x - car.x, PL.pos.z - car.z) > 320;
    G.grp.visible = G.shadow.visible = !far || V.driving;
    if (BARN) BARN.mesh.visible = Math.hypot(PL.pos.x - BARN.site.x, PL.pos.z - BARN.site.z) < 520;

    if (!V.driving) {
      if (!far && (Math.hypot(car.vx, car.vz) > 0.01 || car.air > 0 || Math.abs(car.vy) > 0.01)) {
        const I = I0; I.thr = 0; I.brk = 1; I.steer = 0; I.hand = true; I.boost = false;
        const vf = physics(dt, I); suspension(dt); collisions(dt); mayhem(dt, vf); visuals(dt, vf, core);
      } else if (!far) visuals(dt, 0, core);
      updateParticles(dt);
      smokeFx(dt, 0);
      return false;
    }

    // ── driving ──
    const I = core.input || {};
    let inp;
    if (AUTO) inp = { thr: AUTO.thr || 0, brk: AUTO.brk || 0, steer: AUTO.steer || 0, hand: !!AUTO.hand, boost: !!AUTO.boost, thrPrev: I0.thrPrev };
    else {
      const my = +I.moveY || 0;
      inp = { thr: Math.max(0, my, +I.throttle || 0), brk: Math.max(0, -my, +I.brakeAxis || 0), steer: clamp(+I.moveX || 0, -1, 1),
        hand: I.handbrake != null ? !!I.handbrake : !!I.jump, boost: I.boost != null ? !!I.boost : !!I.sprint, thrPrev: I0.thrPrev };
    }
    if (startT >= 0) { startT -= dt; inp.thr = 0; if (startT < 0) { sfx('car_start'); car.rpm = 2400; } }
    if (car.stall > 0 && inp.thr > 0.3 && time - crankT > 1.3) { crankT = time; sfx('car_crank'); emit('notify', { text: `The engine only coughs. Cooling: ${Math.ceil(car.stall)} s.`, kind: 'bark' }); }
    if (I.camToggle) { V.view = V.view === 'chase' ? 'cockpit' : 'chase'; headYaw = headPitch = 0; chaseH = car.h; save(); }
    if (I.horn) sfx('car_horn');
    if (I.vehExit) { exit(false); return false; }

    const vf = physics(dt, inp); I0.thrPrev = inp.thrPrev;
    suspension(dt);
    collisions(dt);
    mayhem(dt, vf);
    visuals(dt, vf, core);
    camera(dt, core);
    const running = car.stall <= 0 && startT < 0;
    lamps(night() && car.stall <= 0, inp.brk > 0.1 && vf > 0.5, running);
    // the driver rides along: the world sees the player at the car
    PL.pos.set(car.x, car.yd, car.z); if (PL.vel) PL.vel.set(car.vx, 0, car.vz);
    PL.yaw = car.h + PI; PL.pitch = 0;
    PL.prompt = time - enterT < 3.5 ? `${core.isTouch ? 'EXIT' : 'E'}  Leave the Iron Stallion` : null;
    if (core.torchLight) core.torchLight.intensity = 0;
    if (has('audio', 'car')) CT.audio.car({ on: running || startT >= 0, rpm: running ? car.rpm : 0, load: car.thrS + (inp.boost ? 0.25 : 0), slip: car.slip, speed: Math.hypot(car.vx, car.vz), boost: inp.boost, surface: surfName });
    smokeFx(dt, vf);
    rideTick(dt, vf);
    updateParticles(dt);
    if (time - lastSave > 3) { lastSave = time; save(); }
    return true;
  }
  function smokeFx(dt, vf) {
    const ch = Math.cos(car.h), sh = Math.sin(car.h), sp = Math.hypot(car.vx, car.vz);
    const wpos = (i) => { const lx = WHEELS[i][0], lz = WHEELS[i][1]; return [car.x + lx * ch + lz * sh, car.z - lx * sh + lz * ch]; };
    if (car.slip > 0.25 && V.driving && surfName !== 'water') {
      const n = car.slip * dt * 60;
      for (let k = 0; k < n; k++) {
        const i = car.burn > 0.2 ? 2 + (k & 1) : (Math.random() * 4) | 0, p = wpos(i);
        const road = surfName === 'road', c = road ? 0.75 : 0.55;
        emitP(0, p[0] + (Math.random() - 0.5) * 0.3, car.y + 0.15, p[1] + (Math.random() - 0.5) * 0.3, car.vx * 0.2 + (Math.random() - 0.5), 0.4 + Math.random(), car.vz * 0.2 + (Math.random() - 0.5), 1.4 + Math.random(), 0.8, c, c * (road ? 1 : 0.9), c * (road ? 1 : 0.75), road ? 0.4 : 0.3);
      }
    } else if (V.driving && sp > 10 && surfName !== 'road' && surfName !== 'water' && Math.random() < dt * sp * 0.25) {
      const p = wpos(2 + ((Math.random() * 2) | 0));
      emitP(0, p[0], car.y + 0.2, p[1], car.vx * 0.3, 0.5, car.vz * 0.3, 1.6, 0.9, 0.55, 0.47, 0.35, 0.22);
    }
    if ((car.hp < 35 || car.stall > 0) && Math.random() < dt * (car.stall > 0 ? 14 : 6)) {
      emitP(0, car.x + 1.5 * sh, car.y + 0.95, car.z + 1.5 * ch, car.vx * 0.5, 1.2, car.vz * 0.5, 1.8, 0.6, 0.12, 0.12, 0.12, 0.55);
    }
  }

  // ── Selene rides shotgun ───────────────────────────────────────────────────
  // npcs.js asks passenger(n) every frame while she follows: {mode: 'walk'} sends her to the passenger door, {mode: 'seat'}
  // hides her 3D/sprite self (this file draws her in the seat), {mode: 'out'} (once) puts her by the passenger door.
  const SEAT = new T.Vector3(-0.37, 0.5, -0.46), PDOOR = [-1.6, -0.25], SEL_H = 1.83 * 0.76;
  const PAS = { state: 'none', t0: 0, lastCall: -9, out: null, root: null, bb: null, mesh: null, mat: null, tex: {}, key: '', mir: 1, sway: 0, swayV: 0, bob: 0, bobV: 0, vy0: 0,
    sipT: -1, sipNext: 7, talkT: 0, glance: 0, barkT: -99, cool: {}, pick: {}, fastT: 0, slideT: 0, ember: null, bottle: null, puffT: 0 };
  const localToW = (lx, lz) => { const ch = Math.cos(car.h), sh = Math.sin(car.h); return [car.x + lx * ch + lz * sh, car.z - lx * sh + lz * ch]; };
  function passenger(n) {
    PAS.lastCall = time;
    if (PAS.state === 'out') { PAS.state = 'none'; return PAS.out; }
    if (!V.driving || !G || !n || !n.pos) return null;
    const dw = localToW(PDOOR[0], PDOOR[1]);
    if (PAS.state === 'pending') {
      if (Math.hypot(n.pos.x - dw[0], n.pos.z - dw[1]) < 15) { PAS.state = 'walk'; PAS.t0 = time; } else seatNow(true);
    }
    if (PAS.state === 'walk') {
      const d = Math.hypot(n.pos.x - dw[0], n.pos.z - dw[1]);
      if (d < 0.7) seatNow(false);
      else if (Math.hypot(car.vx, car.vz) > 2.5 || time - PAS.t0 > 9) seatNow(true);
      else return { mode: 'walk', x: dw[0], z: dw[1] };
    }
    if (PAS.state === 'seat') { V1.copy(SEAT); V1.y += 0.55; if (G) V1.applyMatrix4(G.grp.matrixWorld); return { mode: 'seat', x: V1.x, y: V1.y, z: V1.z, yaw: car.h }; }
    return null;
  }
  function seatNow(puff) {
    PAS.state = 'seat'; PAS.sipNext = 6 + Math.random() * 4;
    const dw = localToW(PDOOR[0] * 0.6, PDOOR[1]), y = H(dw[0], dw[1]);
    if (puff) {
      V1.copy(SEAT).applyMatrix4(G.grp.matrixWorld);
      for (let i = 0; i < 16; i++) { const a = i / 16 * TAU; emitP(0, V1.x + Math.sin(a) * 0.3, V1.y + 0.5 + Math.random() * 0.4, V1.z + Math.cos(a) * 0.3, Math.sin(a) * 1.2, 0.6 + Math.random(), Math.cos(a) * 1.2, 1.1, 0.5, 0.82, 0.86, 1, 0.55); }
      sfx('car_door', { pos: V2.set(dw[0], y + 1, dw[1]) });
    } else {
      sfx('car_shift', { pos: V2.set(dw[0], y + 1, dw[1]) });                                          // the latch
      setTimeout(() => sfx('car_door', { pos: V2.set(dw[0], y + 1, dw[1]) }), 650);
    }
    setTimeout(() => ride('enter', true), 1400);
  }
  function passengerOut() {
    if (PAS.state === 'seat') {
      const dw = localToW(PDOOR[0], PDOOR[1]);
      PAS.out = { mode: 'out', x: dw[0], z: dw[1], yaw: car.h }; PAS.state = 'out';
      const y = H(dw[0], dw[1]);
      sfx('car_shift', { pos: V2.set(dw[0], y + 1, dw[1]) }); setTimeout(() => sfx('car_door', { pos: V2.set(dw[0], y + 1, dw[1]) }), 420);
    } else if (PAS.state !== 'out') PAS.state = 'none';
    if (PAS.root) PAS.root.visible = false;
  }
  const RIDE_LINES = {
    enter: ['Shotgun. Obviously.', 'A horse of sky-iron. It purrs like a devil in a bad mood. I love it.', 'Drive, hero. And mind the beer.'],
    speed: ['Faster! I want to feel my teeth rattle.', 'Sixty-nine years of sky-iron and it still kicks. Like me.', 'Now THIS is how a stallion runs.'],
    kill: ['Ten points!', 'Ha! Twenty points!', 'Right under the wheels. Poetry.', 'You missed a spot. No. No, you did not.', 'Bonus for the head!'],
    drift: ['Sideways! Again!', 'My beer went sideways too. Worth it.'],
    crash: ['Mind the paint, hero. It is older than both of us.', 'You drive like you fight. With your face.'],
  };
  function ride(kind, force) {
    if (PAS.state !== 'seat' || time - PAS.lastCall > 0.5) return false;
    if (!force && (time < PAS.barkT + (kind === 'kill' ? 3 : 12) || time < (PAS.cool[kind] || 0))) return false;
    const L = RIDE_LINES[kind]; if (!L) return false;
    PAS.barkT = time; PAS.cool[kind] = time + (kind === 'kill' ? 4 : 35);
    PAS.pick[kind] = (PAS.pick[kind] == null ? -1 : PAS.pick[kind]) + 1;
    const line = L[PAS.pick[kind] % L.length];
    const cp = CT.npcs && CT.npcs.companion;
    if (cp && typeof cp.speak === 'function') cp.speak(line, false); else emit('notify', { text: 'Selene: ' + line, kind: 'bark' });
    PAS.talkT = 2.2; if (V.view === 'cockpit' && Math.hypot(car.vx, car.vz) < 12) PAS.glance = 1.8;
    return true;
  }
  function rideTick(dt, vf) {
    if (PAS.state !== 'seat') return;
    PAS.fastT = vf > 36 ? PAS.fastT + dt : 0; if (PAS.fastT > 1.5) { PAS.fastT = 0; ride('speed'); }
    PAS.slideT = car.slip > 0.75 ? PAS.slideT + dt : 0; if (PAS.slideT > 0.6) { PAS.slideT = 0; ride('drift'); }
  }
  const SPR_R = { a0: [0, 20], a35: [20, 62], a90: [62, 125], a180: [125, 181] };
  function buildPassenger() {
    const root = new T.Group(), bb = new T.Group(); root.rotation.order = 'YXZ'; root.add(bb); G.grp.add(root);
    for (const k in SEL_SEAT) {
      const img = new Image(), t = new T.Texture(img);
      t.colorSpace = T.SRGBColorSpace; t.minFilter = T.LinearMipmapLinearFilter; t.magFilter = T.LinearFilter; t.generateMipmaps = true; t.anisotropy = 4;
      img.onload = () => { t.needsUpdate = true; }; img.src = SEL_SEAT[k].src; PAS.tex[k] = t;
    }
    const geo = new T.PlaneGeometry(1, 1); geo.translate(0, 0.5, 0);
    const mat = new T.MeshLambertMaterial({ map: PAS.tex.a0, emissive: 0xffffff, emissiveMap: PAS.tex.a0, emissiveIntensity: 0.5, alphaTest: 0.5, side: T.DoubleSide });
    const mesh = new T.Mesh(geo, mat); mesh.frustumCulled = false; bb.add(mesh);
    const ember = new T.Mesh(new T.SphereGeometry(0.011, 6, 4), new T.MeshBasicMaterial({ color: new T.Color().setRGB(6, 1.6, 0.3) })); bb.add(ember);
    const bottle = new T.Mesh(new T.CylinderGeometry(0.022, 0.03, 0.2, 8), new T.MeshStandardMaterial({ color: 0x3a1c06, roughness: 0.15, metalness: 0.2, envMap: ENV })); bottle.visible = false; bb.add(bottle);
    Object.assign(PAS, { root, bb, mesh, mat, ember, bottle });
  }
  const CP = new T.Vector3();
  function updatePassenger(dt, core) {
    const on = V.driving && PAS.state === 'seat' && time - PAS.lastCall < 0.4;
    if (!on) { if (PAS.root) PAS.root.visible = false; return; }
    if (!PAS.root) buildPassenger();
    const cock = V.view === 'cockpit';
    PAS.root.visible = true;
    // she sways with the car: out in corners, forward on the brakes, a bounce on bumps
    const lat = clamp(car.w * car.vfPrev * 0.03, -0.3, 0.3), fwd = clamp(-car.accL * 0.006, -0.12, 0.12);
    PAS.swayV += ((lat - PAS.sway) * 70 - PAS.swayV * 9) * dt; PAS.sway += PAS.swayV * dt;
    const ay = dt > 0 ? (car.vy - PAS.vy0) / dt : 0; PAS.vy0 = car.vy;
    PAS.bobV += (-PAS.bob * 140 - PAS.bobV * 10 - clamp(ay, -60, 60) * 0.35) * dt; PAS.bob = clamp(PAS.bob + PAS.bobV * dt, -0.06, 0.05);
    PAS.root.position.set(SEAT.x, SEAT.y + PAS.bob, SEAT.z);
    PAS.root.rotation.set(fwd, 0, PAS.sway);
    // a billboard turned to the camera about her own up axis; the painted frame follows the view angle (as in npcs.js)
    CP.copy(core.camera.position); PAS.root.updateMatrixWorld(true); PAS.root.worldToLocal(CP);
    const toCam = Math.atan2(CP.x, CP.z), face = cock ? 0.8 : 0;
    let rel = wrapA(toCam - face); const a = Math.abs(rel) * 180 / PI;
    const cur = SPR_R[PAS.key];
    if (!(cur && a >= cur[0] - 6 && a < cur[1] + 6 && (PAS.key === 'a0' || PAS.key === 'a180' || PAS.mir === (rel < 0 ? -1 : 1)))) {
      const key = a < 20 ? 'a0' : a < 62 ? 'a35' : a < 125 ? 'a90' : 'a180';
      PAS.key = key; PAS.mir = (key === 'a35' || key === 'a90') && rel < 0 ? -1 : 1;
      PAS.mat.map = PAS.mat.emissiveMap = PAS.tex[key]; PAS.mat.needsUpdate = true;
    }
    const F = SEL_SEAT[PAS.key], Hc = SEL_H * F.frac, Wc = Hc * F.w / F.h;
    PAS.bb.rotation.y = toCam;
    // idle: a sip of beer now and then, the ember of her cigarette, a nod while she talks
    PAS.sipNext -= dt;
    if (PAS.sipT < 0 && PAS.sipNext <= 0) { PAS.sipT = 0; PAS.sipNext = 8 + Math.random() * 6; }
    let tilt = 0;
    if (PAS.sipT >= 0) { PAS.sipT += dt; const k = Math.sin(Math.min(1, PAS.sipT / 1.6) * PI); tilt = -0.1 * k; PAS.bottle.visible = k > 0.15; if (PAS.sipT > 1.6) { PAS.sipT = -1; PAS.bottle.visible = false; }
      PAS.bottle.position.set(0.07 * PAS.mir, Hc * 0.72 + k * 0.04, 0.07); PAS.bottle.rotation.set(0, 0, 0.3 + k * 0.9); }
    PAS.talkT = Math.max(0, PAS.talkT - dt);
    const talk = PAS.talkT > 0 ? Math.abs(Math.sin(time * 11)) * 0.012 : 0;
    PAS.mesh.rotation.x = tilt;
    PAS.mesh.scale.set(Wc * PAS.mir, Hc * (1 + talk + Math.sin(time * 1.6) * 0.006), 1);
    PAS.mesh.position.set((0.5 - F.ax) * Wc * PAS.mir, 0, 0);
    const glow = 0.55 + 0.45 * Math.max(0, Math.sin(time * 0.9)) ** 6;
    PAS.ember.visible = PAS.sipT < 0; PAS.ember.position.set(-0.15 * PAS.mir, Hc * 0.42, 0.03); PAS.ember.material.color.setRGB(6 * glow, 1.6 * glow, 0.3 * glow);
    PAS.puffT -= dt;
    if (PAS.puffT <= 0 && PAS.ember.visible) { PAS.puffT = 0.35; PAS.ember.getWorldPosition(V1); emitP(0, V1.x, V1.y + 0.03, V1.z, car.vx * 0.9, 0.25, car.vz * 0.9, 1.4, 0.05, 0.7, 0.7, 0.72, 0.3); }
  }

  // ── Damage while driving: the car takes most of it ─────────────────────────
  function absorb(amount, dir, src) {
    if (!V.driving || !(amount > 0)) return amount;
    hurtCar(amount * 0.8);
    if (CORE) CORE.shake(0.3, 0.2);
    sfx('car_thud', { volume: 0.4 });
    return amount * 0.3;
  }
  // walkers: out of the barn walls and the parked car
  function pushOut(pos, r) {
    barnPush(pos, r || 0.45);
    if (!G || V.driving || Math.abs(pos.y - car.y) > 2) return;
    const dx = pos.x - car.x, dz = pos.z - car.z; if (dx * dx + dz * dz > 12) return;
    const ch = Math.cos(car.h), sh = Math.sin(car.h), rr = r || 0.45;
    let lx = dx * ch - dz * sh, lz = dx * sh + dz * ch;
    const ex = HWID + rr - Math.abs(lx), ez = HL + 0.1 + rr - Math.abs(lz);
    if (ex <= 0 || ez <= 0) return;
    if (ex < ez) lx = Math.sign(lx || 1) * (HWID + rr); else lz = Math.sign(lz || 1) * (HL + 0.1 + rr);
    pos.x = car.x + lx * ch + lz * sh; pos.z = car.z - lx * sh + lz * ch;
  }
  function gauge() {
    const vf = car.vx * Math.sin(car.h) + car.vz * Math.cos(car.h);
    return { speed: Math.abs(vf), mph: Math.abs(vf) * 2.237, rpm: car.rpm, gear: car.stall > 0 ? 'N' : vf < -0.3 ? 'R' : String(car.gear), hp: car.hp / 100, stall: car.stall, view: V.view, surface: surfName };
  }
  function init(core) {
    CORE = core;
    for (let i = 0; i < 2; i++) { const s = new T.SpotLight(0xf4f2ff, 0, 95, 0.44, 0.5, 1.25); s.castShadow = false; core.scene.add(s); core.scene.add(s.target); s.position.set(0, -500, 0); SPOTS.push(s); }
    makeMaterials();
    ready = true;
  }

  // ── Public API (each call guarded: a throw disables only the car) ──────────
  function guard(name, fn, dflt) {
    return function () {
      if (CT._broken && CT._broken.vehicle) return dflt;
      try { return fn.apply(null, arguments); }
      catch (e) { console.error('[CT.vehicle.' + name + ']', e); if (CT._broken) CT._broken.vehicle = true; V.driving = false; return dflt; }
    };
  }
  Object.assign(V, {
    init: guard('init', init), tick: guard('tick', tick, false), absorb: guard('absorb', absorb, undefined), pushOut: guard('pushOut', pushOut), gauge: guard('gauge', gauge, null),
    _dbg: {
      build() { const PL = CT.player; return CORE && PL ? ensureBuilt(CORE, PL) : false; },
      place(x, z, h) { car.x = x; car.z = z; car.h = h || 0; car.vx = car.vz = car.w = 0; car.y = car.yd = H(x, z); car.ydInit = false; car.inBarn = false; },
      enter, exit() { exit(false); }, auto(o) { AUTO = o || null; }, view(v) { V.view = v; },
      state() { return { x: car.x, z: car.z, y: car.y, h: car.h, v: Math.hypot(car.vx, car.vz), rpm: Math.round(car.rpm), gear: car.gear, hp: car.hp, stall: car.stall, air: car.air, slip: car.slip, surf: surfName, driving: V.driving, view: V.view, inBarn: car.inBarn, found: car.found }; },
      barn() { return BARN ? { x: BARN.site.x, z: BARN.site.z, yaw: BARN.site.yaw, y: BARN.y0 } : null; },
      info() { if (!G) return null; let calls = 0; const parts = {}; G.grp.traverse(o => { if (o.isMesh && o.visible) { calls++; parts[o.name || o.type] = Math.round(o.geometry.attributes.position.count / 3 * (o.isInstancedMesh ? 4 : 1)); } }); return { calls: calls + 1, tris: Math.round(G.tris), parts }; },
      car, hurt: hurtCar, head(y, p) { headYaw = y; headPitch = p || 0; }, orbit(a, p) { orbit = a; orbitP = p || 0; lookIdle = 0; chaseH = car.h + a; }, pas: () => ({ state: PAS.state, key: PAS.key, mir: PAS.mir, sway: +PAS.sway.toFixed(3), bob: +PAS.bob.toFixed(3), visible: !!(PAS.root && PAS.root.visible) }),
    },
  });
  V.passenger = guard('passenger', passenger, null);

  // Selene's painted frames, cropped head to hips (from art/sprites/selene_*.png by a one-off crop; frac = share of her full height)
  const SEL_SEAT = {"a0":{"w":350,"h":451,"ax":0.4444,"frac":0.5,"src":"data:image/webp;base64,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"},"a35":{"w":337,"h":451,"ax":0.5094,"frac":0.5,"src":"data:image/webp;base64,UklGRsxxAABXRUJQVlA4WAoAAAAQAAAAUAEAwgEAQUxQSKIlAAANP0EmbcPK/Eudg7F7DiIiw9DLcBMOI1mtm8E8BE/W679gK/qkgoj+T4BtP88YmeljDGzvZUqJJyXdokQSeCFJcaVzCgDuHndsQ3WlReCnuyHzisQl8sYIXzXGFbOVgcq6klwQIF2pWsA1VU1auAPiJUzG+0lcsUxMwt2r3veKZXxS7j7km3ttEgV3u05+gH/wmQN9yHpr7ZCaNf8JSDJrLXHC3czSfjggN7PKqAN0t6NQ1RbJQ1YVf5RbvGAZVX+DTK7FDTPFHxVqKfsVAFix94oBhYX3kgHAL/KSAf2Su7U2MzyXbKi155mwP2vYEq21Ftlac/ma+lbQzFpk2jJJphJHtvntQtUaeS7iL3iIlxB/UhEgV9B1ok/IiDWD+oHWP8HghiF9b/ArftcstReT+UbVnrn7sdozs0NQ6Nno/Dw6YMgtyUhSmZk7ZpkbQZJDcnffi1h7JvTpHvQscVo6lbUkUqTeQ5Zc4fycdlpmiqdsh8zM/If3Wl9gIGjbNk34s97/bUcQEROQNqigmmWseFxCDRzAJXIEAZbyjDvqE/6TJcxHeQTc0RdhB26A7gRPfAEHryvBU5KwJRRMolkmD/ueMAnscFcFGELAG0p1BEvuYJLgKJkFTZupwETGB9jAVhbBf/IX/pPw5ha+sBT4KMjjDHALXscUCElA7gkMHBXRXAWwBUkCKubOwZk2Z+m4QQMyCUmwA5lJqW+O8GDDCU3C8SkwkmIvOFbzBzNspI29WjKhHY46EHpuQIOjM4kdC1PQOJshnxBcyIh/XDNNK5u+APiLb0mS7EiybUvEgMzqMR/n///npRJwfajqSQSku1s+RsQEeJJtW5YkSZL2vg9ZwOY/XBP6dzcQCfGzkLBoNyImwLckSZYkSbZFzKJqHjP//62z0s1UhB8iM3tlZ1ZkPUbEBPw3HVQg4l9SoSj6JcLtGQX/G2KiKEnwNuOpk2nW1L8VUiYSSFhKDoMWbxEYN6cHrvG/EhIMCUZWNemc5ADeEUu56VKOWHxfiX4EJDBL4R5VnFKnh1T6XIofRVDPM+dahR4RAWZgRu8EHKDYvaYDY3ym54S91PPlzGc0fOuH7doeugVSKt0J6dsMxJwH/Y2qZ9gOh5PnrGEtixnPwQ8m3eR2lUzVeQTCFZ6He9B2aznttTV3siv30Wtr1Nw9OmdCZr0+1n8kDGfYC2oxI8u1Sj05d9qmWtvTbDMTiX5n1VKSgXUdseasJcR/PNNaRSyZjFSu6hMZsWtmLxGYg0s8b+FKhKEWIvp4rH46+Q/CnF7XAiEzyvKq8zzZr3VI34O99LyPruXnwS8diFMqouA5f+m+n/BDEYGSh9pFos9TbPd9H+/r6psmz8PH4n5Stjq+QBPHKSRezqHPfArYQCIYhSXaiMt0mfcztdGyYQpIcO5Ha0/3wj6wBOKzEN/XJcn3rFV0C5DiaGrEVmky54k/FCTNVoaoiukzWHMoaaCIBOLHCeyIAMrga2+eHknCMNWOuCye+6Y+gsK/BuzQmOK0X4uclnlOhEAgAcpPTIKF77qpqqAzSBIgFJRU6Xl6fQRE/pKh0l/J69qkY69orDkPF39VALlbLobcDytCkEQyEC+x69dfgEBgl+e50f54XdszyriHa+l5ZBDkaXkdPXNUH7sESUZlCPlFniPIc5BNg9gcqarIbS3uZ9Za5NQSkKeF6v28n+h/96uEIJ6CMTTbDCmvM1ahSnvFnMfZy8+Ry2QtkDcms93DYpYEqmUOFEANKCAJJGZVVexNCPM8zWJNaimkisg75rS8lmkLtF6X+kGFeCmAMQk0XTpUWmtGM6e1YFQGoggBPhemmYVgBNK+1jx4IXzx5okISlXRXWUIlCKIEGAJkDcmSCACoHLe7EsRH1eE6dJHe2YCQkKAJX4s7wwI+KQw59us1yD+c0EDXmV6IyibyL/7tzca7wfu9/8dIG4WOITmHhwJwX95cfpdAOrzvkeevUHAQZorOATxPfvOpyQ94NOdQj3GdGc4kIjf4vNM5H5LR3qrzEwg89cRJOkNDPMY6F9BP+oemDmzhN6aOzMiTiA/utnhMbDB1mBxRvkjOjNbbA4IyhrNCh2aKwgBVyBTk6Q3aiXDsEJRq3jua7RmZopr4BIwezH3fQfbIo85ihEWaarsuEPawuhRhVkE6qsKIrbl+TxLVzEVLKuqL1v3cZ6swAg0U8SjDmxK6MZl5x/ge1lMkOwJmYhKIPoJJ2d7OhLYE4AGIX4yU1NtcQYgdgQEhB/r0+ytbYYeAVtCghJwhGXPLRFVlU9+R7UfIQlJR4Bql/3DTOpZyCu8MzxpCOlzYDoWUe2PYuoGQemccH6WDUme8zQ2CFDVNpkYCcz0+9Y//5zS0Txpam2Blc6qj9OZGWSe52k+f330ZDKMP6yJPJNIcGLfpkceoaezWchMoXLO83uEmQeSLPCmq1mqmdSUL8/9/M+VzAzBq8SQtpSlISyXdO4e4NSQVVYmtgWXmGgt5/2wSmYfgxB9LV3iGS3neVIf4uTE9GRVtcW8vOZgOO/4IzL1hGKecdkWyhtW6X9/j8G/Oi9RlJXQVkPT1HbG7b/NWwCrTE9bcLq7VfXxWfOT5xZl0VhNPw35z4ezk+e6H/ZVaouInnR0Fji3Z6mfaG+mK6Y1E0BkhXbwteh0JTBGQrJCmSNX6QlddRlhSfwl05tfv3bRnb8XzBBklfbHdj9P9PcCOGSdrn257zOoM393Mr3je+BV6b+j2fpOn2iqlG6CPyq/s50qT0/IT0s51lsKQKCK7uDPSsEw0DvoE0E4Xao/KV7J/2Ffb6FPZAgcH0f1Js4leFh1VZdvvU6O2AeVrsSfFKdi1HJUa/pIpOfs9VmDlgaEHP68fiyeZi8+Degev04uOxLNYEv54+hrzXOP90dAhC0uaen0ZG1HIU4F10z3Sd2QkgSjaGlyHtaHSGS2/ZYzJzdIFDTYEuYhu8wAcS7fRInTd8RF/mISsfRJJivA0rkBGY2o2BJWWRAgTuUr7lQ+BUhFepoURwSZanwoCD+UIg3bArszGmYuiQw/VGQSsCdYoArESUku9WSIACxzgl1BgOOIGL+HeYq6Lp37Cd+XnBkW9kS0Mf6U7yt0n2tvnfskICADJUhXxfgXVLe7hJUJ3086va7T0FWx0sLvVHVot5vS58zaJX2n+6zX5Rhtgbh6LIsQfYuG0jnHv/eWmfud69oCGE7XulQ01hiqTIP4nkKPM9Jya3IOtfwpnPH6YEYaw8jIOQTit4Ccx+Fabk6DJCESzJZuejt0DUSg+D1gZ4bbI4KQCLNcmXZvXC9SqwDke7auM3MXRAhLCVQ9rfSG6koty/yWDURC/NbYVRzJycxKbyhA5Qji2xqAObCRvwFpF53BGk1zhJ22jIK8XshlHJHfqrXXYBXzkNEaQHAoIP9pQBr2run5JfLanont50jSX42MR2uJnxh6zPYJv1J4bz1QppMy+ZtBhA19sn+eJEu/CMr0jGMZKhnyFwPSMgNB/tNkytwafnHmjCtWlUXf3fqrgetyPE//fPOi+xsr+hXhPOMt0FqVfp4Of7Patp6z9QOouP+vfYpfmj7UFpFK9AQgtgWYSq9vfFers5ri106atSoJIccWqBoj4u7Gq3fPHHlLJ7+G6VnbMJlJo0TX0rZgXl2zykn+2zIHPn9VeDaJEUOYI6deQ9FZ4bpaqwgh4Gsi4jq8nzIAi5DJmdS2TnojG7s8A0heo2iFjPC0lRaf5zx87P3QWxHiChPx5pSBkeeSkhBkQHZOegNOGjQC3+TxmjFu8CEjIxMBrso9NFc001NaKv8wr0hZ4esO+AxCssTMaF3uzt8OwjwHXWsdvFixqsZ1DfEZfPyqmvvpc/KxVoe/4ZkZe62CvCZK6aPuO/dTnl9/vea+n/u+t1/MX9FMIMz5BdC8AtGteU75F2EpfTPBX9fxUbS445krYRJ5Z4ANQb+qSexO9Bop6fFwhlli5R/cRqWieHZ4o116/HEN7RKi2MXwDzVhu8cfu/oXZThTi7V30WnFi8sjks8xCVd6raVfJYZO1etytwpcFkZT3ihAhHT0yyqZ7L3O3aws1OQf6zHMiF+tQqTqHDdLcIPhH0SpGeuXZRWVaalZRITiTRJD+C8cKH037yGXwpDnID2TqpHhi8ar8szgCxqv8lJT6nLOCT+WlRxVvgSJcs0M8acCEov4kueArX8vHE+uO7w4Ba8i+aGY89fB11fA10BwLf9rkeg8GSDvNEDHNqQk/z7MjMchb1dChgn5YZCVMbRelCCELs/JKD8KYq017nvge4yXghQGxs+C13a+hoBvebMQPt/jJyHSEvGP95czEOr6SQgweIjfINLpfrLv5MdAQBJKvmcy59tbH8ijZk8Z+4NAKYI/APq8p14FAkXR9wTRJ0HCJwnA/2WykRYR5J9uQKAWIJVQKxgskQQjqA2gu/tE5v8ug+0qIP/4BFSvy2ewyzDDmqrZ0I30EFDi2SuozMz/Rcoz7CryM5O8Py56cLmYGbjQ9n5O48vDrhsJ4xmmjSDE/0XQagT8EYDWawk7JEGdaKnqqFHx2LouXHI8j3NMKNYE24G764j8XLsMUs7TuNQj6pnMrjVcbWyi4jyOzDlIbSjYC/H6ShH8MQhyyHRGS2to9fNuX6/w7osRHOVlzJkZbQEEO9FMXxcjP77fM4CkVfuon+dbll0Pf48qzrzIRdRhhioo9kFo3Hj2h9hT+yWpoKdqX+jc69FrVhFMXhpkwBwHrmko9NcAsl798C1meIJer2Kec/4C4oTJh0auHqWZdvx1M/CbKPww6Kc9hyfjvct5HzvAkLy0V8nLANE8OS60YSZG4tPMzE8A/iiBRNAsL6r67jwGAQGM74XkpaFjn2B/oQQIyCSwI8+e50x+5mfHa3OpHjjJ1CDIrULyLE0lkYs9FgYGwBnp7IVCyH3fM3+Kb62XffdppRYodg8gybOEsIzdH2HWlBSfjnXNBZREnxP9aaouzf0M2Br5vZJPBWostldUKRYMs8Ag1zZUBNRa/tOgqiKt0BS/CyRhKE+Gr66kwog0CwVLa4wEArmpAicDWZnTkOBDMADL5fO0QV8X+5OTyckAGv2N+qQvHILM1ZC1Tt+pgvBCUWtpnp58XYRqm9CnOyCMctULEAFjZKYGIF1wUkvhpeIq9ekh+qKg2ktz9+EgVTKYAZgqbzuNb6PxeBNeK1TimYMQIl8RynPuVixLAkImb/rGfB2yiugdBgEhOpFlIPPViHI6Q6qMwORde/FvHihCgC8AgYwVEVhV9Ml8IQKZPHe8SkIRr+3VHzGyxH+r8V0taqbq2nnfT/J1oBDTo5JAfDb+y4o+1VpFWIXO080X0rFMVBBAFmteh4CeX8cJHATkCxF0lgACGDbZOe5Ff5usfS1BtAnEdcjfJexxAsOunOfotT+uInwNbdzl/pe9NmLPqNh766sgo3WP7TIAh8hLuGyAuLxkxq472/U6TWyEwBZhA4tjhewZiUFCwUszbsCWngHIln0WQJCUgK5OWALB/bIXBBACGmZx4qH4rz9AGEKgcGk5zq4CbhwIpKdlISsXHJ5Fdj+ZZ/RRsvR0KKWD6ffD9XGwdHEwxAZk7ifr9ZEsLRlKARsw7Y9XBisXB0Okg2K9KiNLS4ZEAffPWovMYOXiYBDpoNYy/QxwXcmQKGAHVJWng+sSB4NIC4XFMMK6kqEoYAdQyjq5iYsSB0OkgSaQS30lrioZSgH376WBQ0pckyog0kIjYDrnacmKbT24CtgBBGLxMpYyspokRZFGiihIC0bGYth0UsAemPY4M53aVefrK1lLKCHSRmE8OtTa5PfXYKmJIyHYBUDOXEYQ3VkMy0gQzTy/rqV+v1nnURIXoloitmJ87M39fub659dBWKieqZBGmogU6fb69ela8pQh6QQJ4tXf/DWPZZ0RziI2PQTERry+ujzjWJVptIyLOlB6aU9AMmBXzmSMNVAi2ItvQ+XJ08d3VmCcSQJgQ77VoAyCLCCZUwnST18lYe7h2qULYPMYCLajVwI5z+y9P2SRliBtNUNEbQ6S+enMldBcqbhyuMdInJw4kGB7Pjw51/01wLkVihDsDHbtOuf+PTI922UOld5qytZ9UYfF3GMvznnQ3bihh/r1cTJ3Za/OcVR3iA5QH+eZyQHVqdLOuIJ4an1638SpqWYlvTUC5OsX1+8bnBk6wi22Bnk6j+r34U+vjiVCbAw+pedM0J8NNQSkuZJJzCTgzEhAaXEu5cyITM2lqrI7BiBruqMwcaUvOY/qDgIhzZxQM3u5WEpsDQiCZCKSeanGUJTmGs/CCuMOTgqQQfrsPOgaQ5m2kVaj1O47qrPK3Ryndgl0xxXOmhYtOUtanCCUEYtpGXAUaZHxLGUGmRUykhE79K11knvMizNmhHRKZQRNMqOZqfuK2idQgkWSzEcqGUK6lCCEczSn+QOrahQiTTZemlz0/IEUAycdb2UJocl8t+h416V12fxxo4ETkm5FpdbiD5zuD84xaHjUspjMpidRY/oFqlVJTyY6wB0HvTYQXKWMc5EH3PQ7BB3byGR6kN/RahYGoBSYmXSci+s4Y7NIEOK5TDILo6REum18rwUjZA7IDpTWW0eNK2GOqvdonqBhFqJLwM6REAXjBKhAjaZz16ijQOK3i4VDkcZHBiSuC/SngRiQ3ieR5rCdHycz0whp3uf0AWfwZyWP4z0A+2Y/GmecH0bOiSCNz+/ACDPys8ORyI+gRtQflk8FfwSm8cxPY3EI0r6Ime48Rn52OJCIzYNoUfjNE8dCfgLlUd1nfi8WhyA/Afr4q7ifzO8FBxKxf3j+WqQPv7PtzASy173jZI4sIL8RG/MYyC71Qt8JzkRGZfE7e+3OjIh75It42+A0wLGL/E6wcUbZ6ghCX4ABJ2CgaCXJbwWi7HETMCgmBJeQZwn8aQjhUgb9ZgjgDr1sH2wIqlUiE0ACf1hw4TAu/yjjP3X79ieDP0OTCSDhT0IqgFX8YMXov1N6RDmSizMSIkwmgIs/JyEiXOjn6Jla26ZFWR4ikTwddlRhQEAW/CECjGJhfu7MY/ha3KbQCpyAMnMmntVhEkBY8H0CVEZe4vdV5iFLW9QEKk2ToAgRqQWcGUgEhIHvCgS5zuja/o2wmUO4Ra8d8xggNqVUGx6EHgwCMv5/5okEeY49c73WzO9juzMj/5lrvzyP4xNEHKTWDRFhQJB+Lt4WJAhAYObr/77Oj+Ibu3FG/zOx19/X+evwfcM0SLvRjjoMz9F39EkI+Y6vEuFzgCZc13XINxflP3EDy145vCvINFEbgPOQlAQcS1IAbHg3wJTPmYi0xxcDvx0CuEFCLnvpWzwhEkjFzDFxZiqeVeb78hzpE0LyPMM0wKx9nRbNluVOARmlNR9C9xM5VWuL/GiDMEKAp4TzpJFVtdbHYa/CwBsAUQ7ChXMZLAHeJQ0g0TZeFubNdD9jl2pTE/n29nt6x9U1xJYOd8swTe1W1utaCE2nUJpgr6+mrsI/ChB4b1PQT/juitFtOe9kcc3iwjbjXSAIdC3sj9ci6n6eiBm5rq/d9rX0aetJVevaaylMpsN3l87U2l3Du4JLE8C8I88+bfvonAnQuftJFw4dlhWyTKyRGa9dnTGSMEH7MXwt3iRAABsQXBlgSYHPfPtwv/5+CjlzgDDy3jvPHcUyiWm5qu9JmKJU85ClewQYDcuWIri2uHY8i+fNgQ0QSQAz7brWpX5uJuGXArqWnjPMUpRnCO+Q5+XEusqFuDi59prz8AUg8lIhq1bS9ip1OpkkenguqRP+nBYc5f64R+y1fChLb0AvJsXbJaqwZIvuACFoAkbhTyoZA+/zivwS5aOyNlDmYJK3gYSkQnT4YUz+hcVi2uiWRCX+HzGxiYuDmRluvqUkYf4Jl+p4LeBnApzz8KXKkHvcLF7IY/ktPot/xDwTITcbYwk7z9NE/3C1nCN762DJ7YGFInRmJBGvqgGr8dga8UyFt9FSOxzNtiVQ4ppAxlC3JmdmV/oNIKrzrlqrIpBZlujE3qjyLN7QAKI8mpzaG4d/+GT+09h6IOVWhVykSNLjXQhlXVackY1NUhBvefZqfYVAD1qWg4BZThNTndGNYXNMAW9atl+sjlFnspYlAnE1TciR+E+rsiFytxSPX18pHkjkAkH+tAJYdicbI3OsELwJuebhBjzC2DAC5B9FXjao0L7ImfG6JO5W4ViBHGsVaAgwV/Js87y7Xru2JZmZAsSbYByGl4oKrPDSXEhCzHnaV7GvxbFG7ldHQXkpBNSTIOsUEKdHpXxhtvSMeB+qTLzbQzEegbiMZ884SpovrLAEgrcBIu8mPeRjEGSZiThVYfJ1EQ/F72yePv2UnaP8SQUYRZXwdc1xdhXwHnnZvEdthhDERSSaALKvgsOzyG8MEd+BVVo3kZUOG4udVSnlN7cdT2+FA24GcQkJWLI1NkKI9yW4F/6SD1OlBWSVAruWbosOtquANwkai2OfDC0jQFxAA9jWcYR99Qy7ivxegUN82saMCDL/JkSKjRXRagT8DQIO8mm4Ox4DxOm9O7Ux4+yuI/JbhXqMfYIFIwgy+ybMwmFbxQf7N4rgEyiRLD4XYjQsUJ4HqTq2JRhnt5GHlQUifSQCqkCcmrwegzqyLWwNckTwCXBZCXdKchwRmXqCAalyX2yvdUYEeVLj0vT4mSgaDHOXl8GSsS8bsqO8ULU8k/wIhNEMlugYnpWwq4lCIPiUJWUY/Eg0Csj0FBI17OviEALysBqMhXxuMNYIUw+RQWBsTDiQiDyeHqosNybzKDIyswZwRoCwrYllgrwwv659PO6B5jCIE2sA4aoMwsYuFoE8lrot85juwRMi824CQuQD3ZhwICI+I8AYGnch85/pjj9O2VrHBHmhohN/8nCenvr83BrRBPIGIBn8g6ln2j7YWHOMIeJDCbacY38uSaHIGPtS45xGkKcFjcU/WbXXrkyoZFfs6ngieexZgUP8uev1Px+a0/fva4zsSRUPAPGh5NlB7ldmp9bHaxFODhbaEUEy8rwQLWfsLglDpoZqXZeIjhqJDQ3n4S74HODFOuc2ucQYZmqMXQ5zdRppQ1icQwC+oBCNe4WXxz3i1EITOnvtPoPHhnR1RuWdkQ53S7XW+LrJ1Eh6ZlLbyju1IbVxDvhcAhysuyItJeK8DAiZANsZQrYDxEDwKaHBCbtJnwmTFyQkEiUfje2QmWkjvNLd5ai3KKOC6OQivh+yk9kRraIH8KmE2K+dvw5354Q4N57ieYZNcSskxVKCPC4w7Vdz+I2pgFMLELBJqMO9cFWRjnheEKUd79HRbUXWKO6IWFthr108/w3y2pR7hfPLaxNwBYHouQDcCPmqIhF66lnaZubcg+NIIus8ntnrAtwGYcumBPhc7vXF4+EtsoiMgEsw7fGw+7oRd+G7tSzE04nmtYzc2rQKIqsc0HPIfQ/cBmUmVRa/XIDHQ3fbbrHwmaUa/nUy7oCbEDJ4nio+k0jxsoebVbZEcB2glLpjfxWgO+eHgjwqQISWuVnmWCHIQgUoZjCbmHRyHvLS6dSquUWP43VJrNN4KVs91NgDMtGDvEHooZa5+TzcAHEZ30uLOfE2IEziG5QK1tykUiN/ZIlue2QPBJLwRlWyk9wSzzPiHynJSMUeSi7GHeMLsB3CnYIVIrggTuP9VfDaytcVfQHKyMX/10RK+QMnJGE5boFx4L5CeFw3eeDeoVqI4GpckamE1AYohb5xD/A5jJyJz209uArIgsVadE/h+jDzUDnklQdd7kxSFFm0VZozugM0vc5DfCwVBPQzNscUcE3Cpe4Urq/TtT8OeVyeReNOhw2RdW/TN5zrm8xc+9dZgs+8DBE/E2coBFdl7KfHKa4Oxooq8mw+xXGuz/I4uxLW7ApFMxGL1ZvFe36P8LQAXowP+khweBaX9BxlyAG4vPXac399JU8lGl8XD/k4HUpZepR/XZxSVfQFPiTPw6afiYMhLsvAmEnYwIAoeToByxw+ToZSwEUhMI/DGMPVKTNQ4EMCAruOfiIOhsjKVR/eF9G1fY6EPJyAbZ0TH4uUAi4MHM2gWLwkEhnwCQGR4kYbIUT+8KIxcXVenk5EnkxAiJmPdLBdBVxbM+MdoitTbJGEZwVEkuHGc9hV5E8vTOUeJUu3lDuQZxIQYu5QKSXgygwYSfR5ZT+URwVEkuHOYEpk9WIgiX/4SXQJfOSlEPOZCRsiuDjAVJaSZF3hzLoqxaOJAiif6uC2yvoNsGpV0p2xLGZmrd0+IoDDwvkIz7CXIrg4EFTtKs65WXcSLYRPAA4a9Imo1QjI6g0EymbGwghC4dEEjrDDhzK0OSJbKCVp2WXAVUEcHhVgIMZPYIZrFcEdeE6fZq+jZF8TzUL9RElSson2RFBZidEnEX0x5HnYGD6PWCK4A6+jBtVWSWABibYiAUv8xIQRRJBdFIzmsPZLQmZpesROCgjsOvqWDm6GspeRJoO3QaqNnmeksREJ2NY58b5n2FsR3AgBspJgV6n6PIPZRwGR4nOdSgnIXrou8T7xcvUzIjLZhgSEmPlAYLVEdlNa25onXtX3ndolx20ARJLhw40mRHAzkGpvJda577C3PJWlmPclIMR8FI6zjWzozLFkOPc3ahc1hIUq8ltFkuHD5AmvzSG4HaBeynPfuZa8JrnJMpwDC93TAELMR3ROrfIfGypOaZ6bl6Vy5nC7jJmZK/KWJkSS4eOiGCX7YQB5Jo+uwkjVGY5VmEP8/vnMupx+M7Id32bSKgs5xofBOnfzHG9pwiwc3pRhYKl4h8G2ABESqTgMySLy+uI8nvKj10sz5w2XqnOMhhJuCwRJgMZBZ3ARQpxBJT9oItyLOX1n14vcRznD69JREPfkJzVS6qgsAlBIEciHglg4vpHa14vnRnPq2hWCqe2w75LvXYYSLIwP5bWj7XcSr+3Ty+MpmQHIxgqmEHARmiS7TvZBghmOxLdBOntJcmZUQNhak5nhGriK+Ax+WZ/I88LMiW8F+jR7CyVH68juIIzDFQ5cg1KhgOaD17ucE98nyjnURlFHdXiTvQFXLnMoi5SX+8TwdoIBzfiGaCBIRJaUMQYb3OIp61irzrsz+M7rcGTfSGStXWSydK1zf13G/XktixRLSTrKx+76mOINNFrXxzWxL805l4cbNJoRcA24gfJ+okRqvKmeSfla8Yk0feYehO01VY57GSKbzlsCeEDYt06YWlYtrck5Nxdhh1V1ZNzgGuZMX4TvJA4OSLw5PO2lCuWqfu5aF2SDAru44xqEkTbAb+T5CBDvJplxxTlLDtLmr+6OJlNSuoQgZHg7AcuZ4W0RJilaLV+2j/xjbxVgkqoqWaHopvOOgMCuo+9lR11pkZFfhYYN1ifKMsYVzJm+AN94aW3nxPs1F1aSOMdy+DK7jnNcGS5AGGkF/CZRKG6sWUZOgc60I7I/ioQ/D67fYQEEQP70rQAOi/OZ87nQ2qu//b97wg4n/mquL0fmr8kg/VTioMWt+n7tq573O18jYEROONMb10U/g/xOno/U3AII8Fo1Z/gyQXs4/Akfu3QOBfjqpcHoPYIIJIXwhZYGdHaCnGGZNxOtzdE7JCkTEIF8jQzMcePf34uBsvSdAE5Xc+JGXUV3wo/doJcz1DaZHTM9ZfETgING3Kr29tz9M3uc6i++rpG5y0AzlsA34Eg799S+CqIvFuCgF2RuyTlsAvI6UYjxHgmH3teGiZWZkKmRcyhEXgsww6be4TJT1GLHt+s8E2YeOJB8qMda7p4m5cT9MgtOk5lRzgR+AjOBt8RRr3LYbAPFRSYJzowzQp84ZNx88dRVFUF2iiQOq5LcZl6AAuJ3iToseEudVr3EyI7bngzVec1QvC9wEJKbB7QQu2UCCIzjOA9mvXgAfENAlqs5eIuUhtRotyBCPc/h4z+/Dp2Uh1li+M3L5nitvw73ugLPN81+CTLPjf/1z8m0k6DHKO+PDrrW4eZxcT/HK9sFhCeiDqYtlCg+zgyvZW/yrH10z2LLiOyvJLMSy8zZ7YN4LDndNBR6hqUtU1n6fTNtb5S7/473lUqrZ7hXzvQ9tcyWS4Xur8zKrJVvh8/FWjPN3UNzqNIXDTvkzqS08XN66ScYibD3KPQgIXDDhGFkUorqPGuLn3wWTLcwkx6B2POYHGCmxPQZbQnB7xKSkey8xaNBKb7oSWd9/Dp0RmKmI4m35XmIxXBrPEMJ8kXrI39+nkzZs6v69CD4XUKYiZa5aY5qeYYveZTk5cGU9dSLeUaAfCsg3XfWWt7D0NiKsmMKNiNzglnSRJ8+f7p9iZtL+Kkh7HjKErdTCmSiEvpESR4sbq7auSclfcmMF33dmRHLIpbFfyylECX3WHsd3tor2jFcpXNdGRO6lmcLgR8ci4Rwr2qTZ8qIHRcb9X0NJtzXOqMI8mE4v7z2Hp06ikM2feZc/3/IhGvzCIJ8mHiI7kGozhI3Tbk6j8P5gJgI8nYDzAhxr9GeVbLvRR0yXfFMG/GxoMqCtyBRhYJ7FmQmlJwzu4CfPKuLdwFSArLfrhAzmBCbB0JurHRM7hdAdj7M2eHm3a/OY+w37L0QGdMxZ6obGuLv+vXLL/43tTFHxmySc9z8SFAfjju01a7hvkYmQ86hEN979pxidGZ5zMhkAg4kHycCKHZFsefjtJhsORP4iQBuw6PoajTj+vWrnMwu5wz0CaDxdXMcbWHOuM4PmWssjCK+l8DQUBsz7TvMVwzkU4GhoGhrNNE1Hz3TRp8IAixqW747bjIXU6DEt+S7Giz6qtjDNcCZMHuBM5Hfyeseq47G4KqM6x6TWeAAyodieobrtDHSXnB9DXEGVlA4IARMAAAwNwGdASpRAcMBPlUmj0UjoiEVieXsOAVEsjd4wI7qkgP0AYAh/VcvX2Y83TgpsvZb+dfzz8T/yA6AD8ANnAo2a1apl/U9a52T03+U/cz2WeM+s31f9t/zX/A/wvvB7U+r/Mr6I/9f+Q/Nv5Zf63/x/6r3Y/o//qf539+foP/Xn9n/8b8Jv+h+5Pva/xP/S9TX9Z/2H/j/yf/a+Gn/u/u776/7L6lP9l/6vXM+jF5vX/p/eb4gv3X/b/2t//rnTf+O9EvlT/D8K/yP61/Vf37/O8m6KD84/Kv9Xz28RfyL+g/8nqKflX9M/4HqFx83Dvvl+L8xWgkoKeS9/x+Zz88/5fsH/z3+7+lV7NfR5RPw+3WL7K1uNvGkxgtVk1KQjdeTZF6k1aNIGW/bkOC519VybiIE9/Vybho37akX5kYme5pNNrJPMd4QB0QHVTv1wAvTSeQJ93lef2RM6JcH0/llGDMJKWJYzb2ne0D39XJuCEK3gi3JqlQ2aD8YZjGZ1UYP+LhkaNgBreG2vS5GaLURfznre2ph6dxAzBb2njWs+s6urj2s9nq0f1ivN7EMSxkm/U8vkKQaDYmx1GtEPRDYd+ggeV9ujD3j6ZPY7rCOX97/o4ljNvaOoMe1n3533R2UpwbRAXnKkm8RkzLTQOzrhc64F5OrVqWZWfutcqyQDio9X0zO6RML7KWeWY9rPvzihxPMYnDBJaHe6N6v8c+zkPLBtU1OH+IIpiObUi9cSJSXpmh//od6y3bk3NLEpSWJD7dQgc8KR+qW2UR/ycgixphpV71JiRJjShIsiluH/jbxoyIbmliWMO7MJ1ppSAJJIceD7uyilvPpSXbYem4l63eqFOTQTzlQKd1iWq2eNaz7+eAvULec1/RcAGAwdfF2XmBndl232PKYOdIgWCrvHK0RT+vEWK+5YYB1U1G8pU5Oxae+ZAYHFoTrP2ic6+hhn+d/i/zqZsBY/SxCnETbgz2zgjHrQd6YpSt/p2RceNV1UfwXlI8IZM4vhQno462E2z3dr/jPw39iPa4eNOmAFcLuO4ZTxUlXM9Xn4Kl3s6+PdULfH11PEUoACVg+nY1ny2l4G2qIZ/EeYzHtyN54cJHPwfnCAVef2S6ThXsnxPJLbSoHmf5RF85R/eBnnQWvaFeCOLHAa1l+Ju8seyT54XvnXCM+KvMZnTg3RIIkC7WLsAkJ2l8QTXwXfE0bY0Mgd395zPMrQQKYKvdhbUy0ORCIu7qHet7bi+lVppI2excCSktsQqnNw40R07ygq1DwoYdxb1guuvLG3x0dAMAkgGvtEIjIvZ3vf2f0u8/QCUwDGKQLUy8bikdTepTu4D8S7k9RCs1NoJ0P7We7jq0CCuxTj3lK9YuTuK4ks/95uJypg8FPETuN/nEFpROxb7T0nvabfJ9KNZkPjPO3PZR93Tg3g5FQPgN9hJJoejeqBj9enWOdHsIhqxxjU2yPhmpqVgJgkIeKV+wYNLWF+BGF8bjfPk+G3aP3ONc0nKB6FZ9nmW2sjjCEzp9buXgm8GzOXmbf3bpIaJSeNdzvMYTW4znFEYSqJbgC1RBaZAasZ+Zg/xQT3Xs+3a9jzvBOXEzrTiCHpRel45B3FAdAfrMbVlbU7c5wMs+/IiBv4zg24uLg3vIFq807+WaDO1z3N+MNlrHpoL0KkH+cLoVupSh1SMSxvNNjagLBfLs9cYpV0yjzpTnu3cHSObRa7Lq3ZnSPX9iHy++RRLxmIiRCcD+79YRKj8fZRtZJki6t3wa31w6U6mG4w20Q6WOA+5SIN+wDdJK9kU9m4+OxU+E9aWwunAkqGMlsFfu+n9h2nfamxoG8m9GRKrYo6vHbBV+PnXsfpiui9z2iCmEU2SmN4/EmgoTdGCkRKMwf4cMFsS3cc/bwzyXY9zHCBnwLdv23fv47GKn8Nha1yV14W2ewDrOjVIMwFbWsjlIQO4urn7S/PoeO7Lx4IWca2yEu7Yr140YlQF2HBo5KPTcnW9IWA1e6321RETQNpijaCOhbDko4s+8qIUOV1gySMNI5qwoQ77nEMhm6hEwKKRHNmVZX/+q9h6W5FptBi6jqWocuXg7AuDD5lEj6ivOZwzJaES9lF1A6FiZv0YaWnqDWbeJ0ziW34cickbbgCyyvaGnAsu1Ykmlqsu/EoHZzSl7B+n1W5FZvpzwngMf8zYQHW/Vkd+EjBMAbdG5pYlibBHydnToUaOjx/WsWRSKBSoJVatj/MXui5eKQa+QXfTBPvdHhfTGvFJrgCdguwGkXia7MrHXo/HZ8J/W4aDH96w1aNzSxLEgdlZf01LshfJsuret9/1SAouxz8u4mT+Kn1Z05KCpVC/bLPuTufDUKb8cj8hRb1+uQIELgNms0AZXzxPg1t/JR6zNwffeKjycUB50kk96szoDkySPkzir9oK2Dyne1VwkVnOfIFRu310bfSuzXFK8j0aX1Umoc4COQXqTsgMsmx/fXsWSnf2I6D2spOeGaPGa92WTgOv4le1Sxc6WcFKp1mt5Y5JG/FDeaagB8TY/L3RlI4d/4b1uVXvVIurhKdmbCBrD2vv9xVjc+HyuFFOUkzgQ6VU/lUgMlL6WaqpwnWmlH+tRvfMfVnN2EDj3fDdRg43j+WTzz303ZXlwrVcKf1Y5U9w+CmYjsYzKZQhR25blyb835oNdGQn4+G+Ean9Dx8V5jNDtz3fuKymNdh9mGDyjcQvyQV+3QtWvEA7nmSu9p4yK7VolpSBzk6Wc8lfTC64fT8Y6uCpRjUtSP6fJ2/+BwLfr3tEEJK3Nycz4Y6+xjsORmsrGhyaHNZt8J8CfD/ZJ1pXDebvg+orUgPnSixpY0S0E3z7sDG5DMeDZ2ihcJ1powua03ZUY2PgwiiAw7HZCPOshEzJM7+HQAWpWqliuKTBBq9cvUQdbN+IDXQP0vVfbeWS9W3iOl6HRTwaFiED5WM8f4k6W4ZH8OG140eGXcOOphrBS/mYqFmdnr/jWsfnvJxk38QghVoUTEIoH+GkWiVGdoPoqSTidX3Wfxueiu3bmZ635X7Y58FZyWgrP4l/rpfbfjk//X6Dn4SK0r9EmI646sVoy/qG1gW5ufn8pzwa8XvezS+nty8gCIfdCNMlDglvl5z5KoUANqWscMbCX5wiA2T+licGjWBowgwrfDMKjybyGbSvwhoBwA+urVL1JP//kwYv/LQDdFAb6bffHGTOJc8UHJ97jOgqK7kh7+MS2qbWrZj9d08iHxpT3kZ7fSh/xkWTElLiZBU1fXao4DBYOyqLOZuWicFu1QUwCdlHP8jSaCfdnWjuMxcwKOhUK7GsmbGDkq/g39XJnsAAD8xdf4o1nz535/zx31l59koADRL+cdojTKuhRQDtkr+G5NQweCvJYQn+8f2OWZhirTzC2QcDTt8/Zyb0o4ieasNVZIt4j5PCTlaheeFiYjqaLdXejwez3+obgHk3516wXMIBW5aQk0n3h/JncU4rjf66rVIdN9NFk6gRC2T0Am+f3LNBwmzB5KaV7Sq5SCvt+TDk6Z7I1z88LofMT+0BDCPlA7yHwdg5mbm+OsV0M2ylHrDLd2lzniF7pl8cSW4G/o9mZ5UeMSMHvbKBipZcmgpMMDbWi9q0+o+PIYAH7cpjBCMDsL+DWro7/DABv9CGyPoNw7ZrRoYno+GRRwWFo9kNfPE3EWwisRJVYBujZ9xdqAzQL2biwvv1uARuyKOCp5mRp8Z1k+6/71rovibJBhCiJJpeWPWioP1XiqjYrBK9kEa7dan0evbfZmVLBKkgQ8+9Phyx/cdpFbLUTj3WFzaVU4qzqAe2ru6DhJbL1bujLNPRESv5gYAb1PV7nAGlSmvOf/M+0shYTTF5w85mbfyo+mw15yxGD76RogdGe4ZVk3nG4LX0QcyNs+ZSO7jh+Ug/RzTVOYoGJxiqvvYC+xbk8UwXn3eLyFmhGNEOI7MACJrj5HAAL64UEAMTxrAq4HtJtZMubtCz9MhsvGJSlA33R70xCQODPsgoDNazrNWeags2oojWa7SE3cRHMpLPcPVFheF+tz484sDEhEO6OpoCb2ycfVXNSWULcNp2kQ6pdGjKzwNu/qgqL7hHjx39jrV4/Rq9FLkoGYoHJ9pa7NZWjdGf1yk3cg3AeoZSNla4f3VoAMhL1QWrS7Vw3vAMlVLzlXKTBNlOOIuJnTXQezghZp5dLrf73ODO/7f5anqltiQJ6FdepI/wc6/wB0pZZOwnEnCMbVrkszWH531JAcUaRFh5PD4ex88lZI811yW+Ydy16Hc4qf+lsQp3lt9r0pHoJG02rEkwMLOq03gA8OIC2GfwGYPCE2B2Mk0CAAAAFb8bV1PPegAZjiAJ4oNNvRTX0nYnrwz0U3noQhZyXq06+A5M1MDdi7eMX9ZplE5lUjUSIyMERdhvf1RBxrGNYQq8iM+lHDS732wQ8CoAdKx/b8Njf4EKo1HkoWBAZDx5FUBx4mKS2gzBTuhbcRrg+/ZHRx/vYp9cTB37EINDEyb9TDttVs7SexteVdP2tbfn61OgOfqF7gHNOmbwmxeunemKnuynTE9M7Ji0Nn5fcTyj/6FhE+uCAZA6i/zpp6Q2xyJnbseJTAKX38jYz77eFjJwosxHBoPhErb/veASJbwS/FORvk6A2ggOuvQdo4s86V1hFs8HRQYNRDrHJ75vj81NcmDCVE3+8JGWHpsU2waQ+diLsFqhpAwQK9Nd7TwUPA2ardHtkka9liNvuLcYcg3b8+ZRJ66mdiXmEqTKY7+5uoaItniXZQ/81iRqcE02eiC/ZeoACaRgDDcdBmsz5axuGufaYthLlBu6T8RXJJwwjtW+j0e7FIfFR0CDHR/1X2e55WuGvK98/N7q8yBsrwEHNS5z37ucJ7bmom4WJIaDT1UMKIlSoXE2YdLSCWipx2DtXz3oTuFUdeXH/9P8j4XdnOFjasyrdgpaLSd0Si6j2+HHjgLQSFyeB8tN0QG5TsSPQEpjtQuGDBaA8+NR54rvS2th0wLPRMVx56Vt+mFQigd4LfZRvGf9ZFW2xefGoQvucZ1OlH32B3vssX2lyUlaofp6h/4A+2XBozRNsKRFcRRBV0UrEu6kJc2R+dNGpBXrYoZ4EcHVq/PXtj/HUBR9jHwUS9Q74ZAodo4xQDwXhhEOgGiba2Lme7I3/9n+IZ3Wc9gAO07sqTfm4cBK5Cs00hdH27mxxNjicY4okJ+32P1KHLl950cuvL/PLC6sYAkAPxHOBN0pw/nOAANo18Qk53g0wmZC4xCfExubccF7/oyIc8YWVdeYqqZkbRL0CFg2Gn0JsJgB9uuTRior6Qjgh5cpRAeJ/LQtbCw3f4rUXQLZpvxTqZHn88MbBoSwKjjFeWo/Rio7XIMetJ6W2+W2GMqdnHs8jre+b4q7vkxrGW3COz41pS+qsumyuA/PTDNax2Ss1ojHBgzzxgueMkaxxRLUTIfueF0CSGZq2p29h4KvtEoSQR7mofH5NuMt8HAxemiX3yaVDX/fbiU7dY63ZnRR5TB0uqiz1vJ0ITbtAQ2LqJfGbDyYrtQZql7rLyGHyrcfBuvZ8Su9DudMwtDFzmBREoDABXg77uPzeKkThgjSzLIyt3zUNtnKgdBoAAC7AQV1Az01hO5LOTyZYmkuxRFjnnb6Mwc7aU2bRlm1pzuol5UCLLxW7Nt47O8Eb5lx4QciyCjEHOMkA/i7uyU9Ij4RyZjfcQtH2+hKWMg5z6N4d6d4/Ov7D390s06bXEy7YNVU6UH8KZPfnt2Lz87RKwrdZ096KW278dZjKL5UCWo6DaMSjWBBfwnG8jweJlJRqHnYsWZPpFaUEXjRYGaUl1p4mRpfl0WaHt1fbIS0A8POxcwf1sZruFOJ0sUXJ/KWSBRtEO5pZTzftBh2XAAAFTOc1euyjSy2p3eztzqJQto4f0J3RU1QLKXl8QjjI1GOSlLK4OmPbTy1E2MYh1smIfx9P2wF98KjelOVxU3KQgQrwF+DvXxFPxr2hL3g6DbnW9Syru9d/nTALOL03yjCF/MWw75V8aIIcxniACW+XQ55Xgr5ECkhartbbeMrtNu9J1VG7kQ+zr2FZW7tUKRIesJOon2raoilWcXbugH2IeuqN3WgZWNKnuTBv+Qqzd4d2F/raqXTU1eJYvDBsP8lQTkNdBZSSYX8s5BupTnAN4KYTHPV4FSJwe17vD7gEavacSAM0vQSxdHk732AAAAP3Lbg83+UtRSGtZkZYYW6FMM0gdNnXLRFa5O+zlKfFVp9ikbTrFYKBoZUWyYbqcu1rtr1QRndqzt3pJ+v574Bkx9EyCGAqmqJOzQ/Qv2JZ2f0fqMWAzvGTEYprsMVrO33r5pxyGD0CxzaXnd8QGRQVqoC1CwxG2YLMo/mFwJ+UmEdQM4VLxTXkT+7CpIiriqSHuETBYfH+6QfTCAA043xVpe/PiStJT5dfT1uqWd/gz0CX4cSWEEliQuEtb+9pXMpbXLVIFQltbrm8oUNxrejrHj4fvJYV2EeRkREMYQ26guUcKGoJKNiXXiSfRTZ+G6WYm/ZD/QP8at/vb7G//xFi6ejDCz11n6lOoOrvejEmrcPMnpRt7Ysiak12FoquSduSZjshCpicf//U2lTUPiltCkxYnT38K8lbpp8I8H9jPkvJOcb3FlpG2HIQleL5hUEAlh7ULYDeduFuuOLFKwzY/CYlYmwoipflS7fk3kcWSLCrbU6tLijodNlDG/qtOirHl4RuraIe9GdPLPRClawV4YJAprOCKInTu8iaTE6LCHW/RaALmMAVaH4Ns7icxwRVt35hUYMAf4x5Uld6ORbJNIeWK43t2AHzS/p5M6UguQIksAym1hZlX1eVMM3tRjiK7jKm+GfRCyrTy5Jj4g+EQd5li3yNwDqpX71sInBNqQyJlR3qNsR3Ai4zai32L16vsKc5ILNEUt8tZ1bS2jChBDFs0yfMxHA7CqeJkiUk7+P2hkbuzWUaBq1ZTEC/8tI/3Mxpk4MHdodu5FR9yAYl3ELJWzjvybAfi9Gqb75S8XMhKSJUuoZVfcpibCJXaA3viUwo1Rq/9rYvAlZw/fovuHt1WQ8uKa1i2JhXVeGXr9bbcZmTDFQFzqNdB44utRFoj2fDvlF68KfaNLo3Bm6MWhwIQhGwH7pI5iSxtbzCgKn4x6J7AgcAgEh5aaxuNalPOs4ev44t6irsgXCrbzQrlTeQBKI1IfPBGunR2Kw/iPhgR/2AROYOYkRPC8zzDzF4ZlPbTK4Xw4ll/fWTcm+/m0iuSh6F0ch19dek8p/DunGcvgQjk1JlTftk7jFM7qEr7tgesVPjhMMD3ry57pzz1GOOYp/F2XPapWvf5Q26Msj4uUmH3xiqxYWcX4G5EZboPNfKtIHPZ2dOhjFXRVeIUiZXhz2lPTsgGqz8VI46MlTM4NMbIk1UPnJMpTc87W4wJYsrA/fLrnhdXiPcRBNmQsD5sDEzH8Y2s9bk2Ue+kQAViD3zB7y5bpX3ddR0t+47gBIm8Lq+6RV8syOSg43EaRJRVIbdsRUAOtvwbaXSZ4SOAQTDqMMIsjwJxBJ6ivPTW7pUQ6qaJ7TS5EBhilhEiPe8Wws6/ZJVbjMzuoxxWYd1nLMBSxLFAcwpyy5/W7XmVdGIhAtqOkQxZDq/cASA1/PKCxwLSAmF9ut1CRhchVv49vkegft+3puRdsfYXHsRFLiHRIAPHZN1RArUe4DHMteihBk/zbCcoh1V7oo8kcmSJEYQvgBPtpYVblSb3lmyNzgZwpYzyMqI0MTp9PG/rqTIF7/q4fiiXSXXT7uGjtkYRE8tgBywI/pCS1WwupkSjqyg9Lw0FCJph4V1mStILwMXAWP7RZS2as9uc2UQYtDfuvG3IOhl9D2kqhx+jpCRmWviI+dhi2QcS7oH1ZhH1DZyW+7k7qHaHmWsf0/e0Z6qKVJZHOpzJiWKAHPNdqIhJi9PDeUZLToIyAdFjXu54vHFkXhqR2u3H13V9umOsXOtCde8dVXdys9ktrKLO5EaZGyTpOxwQgfoH1yO3FVuLmWFz4QHPMz+W6T94eCHtNqaC+QEbhR6W4fIzcVQh0GceliAfc+e1BQdIDGcQaIVhrk5SatkH1U/c+BDJzHQQWRH+eBwFx5h+QIXkRsixP71WTXc2YWjcIRyuZ4/v3AssepXeM/j21FmWdLCn5R08WVHT2FiS+bYjDPX2GJdi3sriHEaz24XAM1sx875/+PmNNO1kb+PjgwOvOFBVRR8OcjjXgmdcft/9qNQ8EPbgzwJUMy+7z/F0bxzoYrqEZhqe2kuWcPF9vGVkzkFR3CJKLR8Vu5ilktJGdRcdfyEWNPZ7LyVa2hcNQWZa1+PgYhtW46qlqcb2D3X7bAQPWrGx1LLMYqpuXoV+90LXQgyHlJJ0RxCqaTmHRwXjahz4zLe4Y14oSwphV8agTixFbl4WhxIE5LuJxrQq9V6bnqEWV5o6iqe+K0ckoiQ/GDwm5tSCffnIaaoVPJ3uly0Kk/QgwS5cWMH1zDezCQqdMsMo0YGNogPMNX7Epq5E6QmDTjQ2zp+OjrGadw+RYJn6Z91f4nh07Y2UdF/PGCfIKMRhUFNpuT6CetY+KdIPRNy2ZfFOj8JG2STxj8dLRn0quSGJ6mm5sFkbDryJofd21w1LXXau0PSFm1lOOEL3elLTSLSNY2u5KrJ5uDZjZrczZSiKlN+3Z01mK2/H8LHi37ZBYuwij2+2fNNyDF12foq0Pptz7Tj94GCRBfNign9KvQxqelVaG/4z91wQWKhOU0RkvZ+yl7JeZinqLCjYA9SAIpBNTQieoAeKi5g+I9r/dJmh704dyV4ifkM7N+QFUVeTqazAeHWGEk8wq4CuzNnQcHIGhTWYDu4bE1+7mtDdVj4lar9VAsnkSjRKxSrNQ9l0KbmrKejZEuDLy9gAkiMvNqjPkFfwY8JxN7lxiYmR63EqZ9X6vkdonoAgi8iOGYcLPl2OsIDRmPyjVdb6qlXx1IWtiPrCFAmCQ5RFrqGHSS+CD7vpa4NRmL34oUeQFqaKXjd5X30bNSky59AVuYmDyySTzITaOeBsZtBjvX+JZM/deRFI8kRGGyqJoPQjsGR+gsTh48qi+M1p9Bec2i4I+Vi8VHxPoroqLDrAUaRYwTJQKJ4lWGK7gqs5mklBteWzdB8f4qXVsqjbl8F1n4SuztSON/wmbDBVnbhrrS5CujEkPFeI0sS1N17FriUwRKzRh7MNEgurxElH/pV+u5LEKR4sXBgxBcH7TtoD4YeoTaKxyLJLSWL0AEwqJ6oe47uGru4rfaq2ezO/erfpJ3SIPmLCbLjHEjGdXSE0wvVSv9r1fbyjgbBv6kwZdaZRXqLdT3EWKHGraLt1mwoUTHLrlPa9U25BYvvNwY3Vhg/pdH+SoDRXLZ9c5vCiB6QJ5nhVWuokjttP4rpwk77ITfT02iqI17xKLBwwCOeqYItcWKse3XKSbkIoYFePlVqj2Rlrp7ZzTVvfeG/bVWSAqaKuIR6lJb8sFMqpUdY884KlV+PSt8HlJiu1pIwXgrhKNIFOBynn55FbW/cc8jjezs2Sr+U/EfiGXeawreBdZxKaDy8CAQF26jBAXzZ0XNs66Y3UF6vcIOAqA+apjcsNl0Lv8b/LBQfTUS32CWQ27zPo+MlKqkQ+HAtgcEAl1IOJP32atRMVw4wQ8YaacCnN33ymi9mCwavgSAmt3Y/k80/+utkSAJbypDLXNs85lh+C5tgL5VAbvjrTPG/nZKuG1GOUH92eHLuomwxAz24+yGc0IkZGhLYPkW4Z9iiINyJ+MF7jzRbe9bpzWujbuJnh/Kb4kFSfEvv+mQYAf0SwUPgoy4nU0bqyIJd1YHG2cb/GXo2nvV652V6KYLAcnMOxSt9CyBbh5WoSQhQ2FIsCrYfMNO0zfpLGyhrz3oiwznLa617xfX6dlULAJUyCumXYUC5m1zAk1H8pjkOjlAiIwRpQxXuq5rsOVybipKhgRDw6zDrqLZY2kPKMEx8KzH3ywEgmu42ugHda3WKJ1fvlDJqukc+h1DAL5S7TRXTkW75QyGN3wG84KHZpKzhJinh2xzR4qpovv61knxwCobs4A6IDNs9Ih9HRVksmJc5ORzLZzGZEIQqkMk+mH9Bp2I/nfboD5mqUF6EDJWUGTYqPqPbmnQ2MLx1KYfxYUyPt1TyB1+4B/xz0KIrxZwdMLik0v7XnmaMW6+FtMTtDClUfv9esR6d+6tJl1Iah1xfDYor3YIqMP1Iwuy5QLvwHePysMt6kcepqQ7XUJeId87Yy39mwb2hzc0zS7Uphr7BhHaxH9oXQOrDIkrQWNdG+v+T6CGQh8jYUHMB1gZ0xl4ITuXNwV3Jgl+IlsfXKPhuVJuat3hbNFE9mrNxA1FU0sjArkVm3320sVPSnSLhtmK1UWfkE3ccu9YXeirekk0IcKtaB9Us5Z+m/wrYlFujFk36e6VOA1FPk1MFdUdcCfZ7hFAJa+hyc+JOM0Dgle05kwKSzq0fDHPu8KMVGlL9bOLTLrOZrv4J09jxRLZfV7aYKU2ok0QKEYQdboLTBA7/dgSYpGzs34bQrPPopvZfXKZ238bXCyFKNrP7+uahRFGdEyG9FcVsRTTOTemW/+ZHV+YvukfZ32d9nJZccdqOQiY2GKdDudmtq77N41nUZGrsU/NCCz8MivbHXKQDAe5M3hF5a5S5RyjLVXv/hsW0tbNh8GK0gX7MKOgPCgrMGPBKZg1ykqXB3kBArn/EmQd1SQ8XAPu0xAheqrTZ8Jh0O3vA6hz/hHw5oNuuISMeAPK2OgzjitMGn/WPTwELmUNeC5B7sOGro7HHumP2auNJXV8dVFAyKeKD44pfhuenx5JRAusbaNBfditVHHgFcYNzDgEXirCZSpKM0OENikYIwyVFggdOW1Z+q8hkJsnBGwMU9GzItgUYljaBopR19G1GpfNzeKbdLyJ4PutgfAuCKwybaSdhY04BaNSEPhgcnR8p6Do03guJdi83x+FWV5G5ilXdNc4DKn4AmIk0HDI6K3g10+BQWlUiZlCaeudK7iqagim/pDEnkzy2/twO3bHf74VD+u7KIwcWMeYq6Y3Wklee0miA0L0GppWFqKVmbgr2+vHXQ+C9nBOKZdbWqUu0imtdaxwwzYvOBJssWozllNkfdkm8r40PNSwS5C4m5zNdCFf+106NyguMRoyI4OH5PL5UxmaDmVDldpLcoQKscKMOVaTEkIzY3sgC8cruodY57vAWI8+c1+cG+zHIQhhIOQ5b1u8JmHTB4jZ+lkZqisQEZT3FtYcAj5M7dFCFKSVa2lEvwngo3X6Jx4NJMhgJQZNixqCtaDdFkq6zuFAINOjrSRM3fE/J/wh8cBd+xGnc97lq2FRNGhKy0WBJgELWmtqkENDD22Fmxl6DwaRhILPBVgFzNlZSoZsQ8jlQRxfnQqV6K9lQMS4VscXpOrNg0kadIeZNiR9c8mTX/HAjivoSGmMTjByqjkpFrS03/2cCL4rGpLeCpJWRu/AhQs7PkiSSmpCYP/08FwQcaLyTuATTwSTgW0lRGEV+Fxe218UuS+U2q9TIcZF1kHwgJxnHHc8TB+lcl4TU3F7vi0SjI9jdG5Wa+1lKGfia1QbwFpvQN14VYpjOjZuzXBX9heqTg8XGZRFRHmATzqK3oj5w7hXn8KLC2pk7UyDVtjG0ni1wY2BbjsOCln2YbodstO7XMNIQ44QREoRYZ2ENYh4D6PJ1b/Q35w3cmJJ9W5Q75PiQHZGzOyCoTZSl0511k5OlEi7/bJwjzqMUd+jt9EXafjuJueWvWSwGA+qOJO2ZwRgWYPhT7CTOQl8BnIR0NnkOn25KsQRfE8LwFmitFMUBBiZnl8iphLF2M5WlCFFFgc0PeXjDS9x45PUswajeIFk4WpkHq9M4LmGZKu1z7HyWsW7zCTecINXUx3lOmUK0cO2uUum/xdiy4Uc3uU4uiP8ptmyqrDTDLzCv6++OH9ZGhlVDM++krpdLyGsrotS8zmn38m7Pv3bjipJ/BiPGA4R8jp2oiaf0Py+niL0CkmOcZOuWAKgFN2gfZF6wxQNuWY0ju5DSzmDi1bA1UpSnUjAb+E+TrnaAFrAU6bUJt8FvjgpjyfHU7HVou+OuB+i50xfPlR9lBhC7dI+g6043OImBcYrahyY25QDuK+up6u/mBcKQK8MGxCm4OLC7m8eaLHm5+tixFMwK5ND6hUg7pdzcuhX1z2WZ15bPbw7hOS737t7iC0cSqmS+FttOJbAeLfmW9HV2o6xctbgXXVLc9ct7iO5wNOiqQ5kqJt34aULOOZ2WTffV1rJVIC8/Q4h/+yWqBnGJMyQeuvyoa1L/mAJDt0prp12Vwr3mjuRhmH9YeRGC5F2Ym0OPdSyP1/Rd7bE9PgO5gTSTQhKC+W7swGFPWx0SRWvA0rsN3IOhcNWOJ0sbtUOkLdUMv3bl9pgEJ2t9qcqAMN1B6kqw/HKDUDXVTIIOepdiwZQE3JaPcuCZRRoMgwsZ6CC8vQ7WHYTemhWicacP61NEGALO2BE+MPUZEfyVyDOdEbwi0ZXL/AlqEKjlYX9uogfCY24RABWdS3GBLcmZjktbXCap77iT8cNsMVrCd3nyR3vzBjXD2XD7a3EzBSbx1us7biJGuH0EdGP5NCFQiD/vUahJarCtcShAkpduJVxSpgAyewUqB+KsyaSXUt+bzNouKm1hmqIE7SpDgdUGT7ZiFzI+MxM+LjwUQenyFGQAehtro4c/sRoN2hSybFotk8CW9CRBN2Tg2A/cfwulvot9TooClz3a9/PMK3lCfasB7+/uxrYZJj7GSfkbGNh7CwdniNmNb2OrpJXa2l5u0kgKRgGAg76unVH4R93YAMBuxaj85a+g8AZNtWRQFat097FOJNcZIAwt+iVJjhjwxqN95X1c/UGnR+H5lkWOp30cVWsiv6yCwiSA2mh6UB1ziw5bUex/vSrVdkbDVXcKHasMVNuOhgIWgKDYFydV3XmVF174F6r4CEWSfYfZHmQ11+tqFuC2va7r6MzBbqaFbvGGx1e3OpZB7OdkqX9R33vOIRTi8+kyxHMhghd0B/uk/vKGMXvM6fzZAOvcMXN5inB5uHXXI3x6fW8wy7cycS2frIiaRf08jCN5dzrCGxkGRyeY9tWjbcYgRaGyz9USIZBI+u6yIb0FuH/n8u4hVT1vW5SKOTDfnZ3m3oHdBzULY/Iclp3YwVB1+0EZfmHHDnRfFsHRilmMPr5frFYpMwM2dUPcT/Hk8bR7t2MuNculNaYXd9d90AdWqrkqATiN+uT0wen6uGgfwQ113sgoxEu9AX3m4ym/LxV77RzQ84NrBVecdtsjyMslw5NCTJsdgqg8YtLhGZVriYkR+yK3h29BAQ2C7srAxNR28g/uPh5ie2hu+t48cokS7wePatywW145ZdvL+M0CMUvoDYhwVqapvYXu9vL3y8G0iqFnfo3s73wRgSjvTXZIJYiaVdGTvjnuEyCfCcfWEJY5Oe0NsJRlGqfwNTht3O5JoH4Ho05XpYjKQFiFcprrn5p4LST1ktrAUNrbgA7pBKldZvH+2jqV0y/P3JWAKhZUB4VwzSVEzt5MOanau4RGGa6FJXjVlRL0TyrPxEpXcrHtU0r4UFMvm1ZNLJjld5exTvguQCetmO3co/IEflWGmmwEckEFaqukZPBijvqLbviE/HGPuZgNs/AEXbDac9gjADPE2pCDpawlbcqAo1yNihiFZSwN0zj/wrN/7dZwEfzy40f9nC8Qwun9tHW23KBbT70mpHC9VCCnsZTmDGsoX8ZAibw8UoWmLWqP7qS88Dhj8G8/T0K3sY/A6aYJciHcZ0fBujiGD2ucXE7gIYccW2NVT5toRJ6tiNSNl9tIspGlGEbajVc/d17FETGVetrV/Ctp6J0f9j2s51V/R40UydRVYSQOU6gMQgnpGt3bWzxn36aEGOXDy63SeGNKiAq/PUzckP1ulVQa6XkGaSE3NBMrU5wMhGL3/QdoMAasnpz/efoXxCp/kG5ITN2EXIHvAQmUkiLU9L46A4BozeWbP2EFuOJ4VkuWn9/fWRAs3jZL+pebbHhvpa34e8n5rTgn4l7xzL3KHO5vqutGjsAb1+70DUjhHm1ve1EOU6nIwRJhcQBxMwRputQwYV5b8r5YzFWqSnoxoxzd+hNe1stc+0nVa0Y+btT2sF95JSwgMdZJjWbFo+VJbQBpgvqKe9vP0uBbt8WmJq0P9xjx8HuBLaHbq9KGEUCQk3Y0MfLYGvFlou1T0MeNB2x4bwXTK2V0hWCJsqE5Px6w0ae4BGUbN0vbJPixP7LT0H30FGJErBhpf6h0ZYNlKFQbE8E7Sm1eLitXUE2MmhNsKVAo6w+n5eJipDyx/C9fpYAdj6/V3x87FXphl60iufJ6Sf4+Vi80CX7Fr4OnNsbXEEbfId3YIPU6SpvmrW+ZsPm+LBsDdzTa8hHQY/y3kO1aOP42byWal2sMOmt0qeHWhzv2DUjQpUp/KtObgiCWG7UwomaqW/yF58KOV903RH1YrIj4Ji04HslAfgAjwShzc3mxY6gU5Cm3MxYKGWp6ZFbN0SSONoIwqNECdJCBx8xeJCW7sXUikzZ+erXAwx/rDNxkRS7aBVFk5jp1ylF7OXS5cwG0jZzXzBR9etdMDf/eRE5Y3T+zCCnLabpyxYLZndzRFS0JGdlnztVfrBygsh5Zd5gQFr2ilxmZem4vI1XLf1WUlOWUvLprHQb5QYovmY5bz2MFuozj2L9FZIwiNRL2MMJ+PXTB7FVvIKNIwr4ex35tZRaY9u0OV8q+FcjIH6LoiMT2YIiDqOFV82JwjtNp5hyNv2v9gE535tSik0dag4yWqaKIlhB1TQiid44yuyoYYkkvZ+r9wba/0IUgftrykxLX7a4YP2N8Qf88Y/ktXzLPIVKfwzZJq0chaO+YHzoQ/2SRRznc6l+3OyI8hqKkYvWi8O0u5CsM5TkgbTkz8c4UqhW53M0TT7CrzhJZff/0uDmKkEiBy7qbJq+P+FChUBgAy+p5JRmB6lqouTjIO4deREFAz5cWlEvln/tNSDywvLzBejbG6BoIhGr5LO7/hXz1VSQiCHiO0ZVJ9AU0AedeoAkSWH1VOLFfdSP4KO2m7igEGAJz4HX9RXfEGwLg0LSFHDjaqM2ssGVpz0rqb8tfylz0mNdmPKKa6JWePw8WCk013HCQvrM0zdjQcf9naj5mCsqvE7Swy1huDU1eLL3XrVlGrefmlli9FHyqSOl4Yd+eYXTMfrlo52TovQ/+Gp9saMPkH2eFKlsy3UXqEjnYzJ8ny8a8f3CFccJ7wyPkKg2CdGlPAbvCzy8hpQDZX0vTSp8y+oHXjVkpzpW4/nmp5QL1LgMJmGcL04CH2VW94LJbmN9/Nid96b4muS97HZZUvrNn5QZIZVerWXco1zr7tdkAs3trCEStQYRoIElafA8CJkGXDEUU0RKHdjIld+DQ0iEl5ciusg64hqb5Y5pFPZPybH+slRYb9uuMbSj5QbYbYngkcdvFERp+DxjJA62fb1HRW9JwmWfkrWNw21Mjt4QoI4WKxOdCHDzg3WRZwUXF84GcI2bhtIIGKeZ3XxkGS4tCRsCpbA0sRmdtBhe/7xDgDSDuYnjy3ARGYL9aLTcf1nkvMNch8IQP66L02sa1AXsOXeEBpJg3lKW4nDIIePa6OJUtxszQAapMekkS/XTrtGvk6uFDe1KKz7hr9K53IVk6TccQxOQTGNuhcPK3cfj2lXBQlgmIGax3T9Bfcxlf1VBEY5UKtsFxp58wqjCQbOPxHjBX/Pwcgle1v5S3O8m/crOR+j0Tx1Gem3+tE9ZIjf0pn6ZT1VWOqns9vHauukcLodTL4hgeXmqqnaDYgUDVI3t0eRBRGlF9j5mSZq3KcUcLjSlQuTF9IhAFJjPCyVlQeXH/uLDCnjAh584BsrxmTfFBbD19y8jZzOZGCsVL7yUcxmEA68EWPb29J8NO2V6gaCkOP68Ztih8zq8kNYJW2ZstAurlxBtpGT5Mn34c54rw0zXfwKbGJ5nOzg3Jm4GDPS2MKZSBjfr9AGn8JrcvzGDLZJvOcEV3T4DPUGc+3EmARDJKXo8kC+dv839CFWCP1jv0Amk+3TfRuJENXehrZSmqJ+s+cv2ehhvBfJw6L2A2vK6CPl3InImom8wm2a3LI9NzSt0Xtgu3ruv5I/RH9WEP4b42FMyczBritu9t0BtGF7MC57s+zJZMCRGwXQk1z/OVTYKD6wCQWJZV7l78WmPgvKtq8QmWqAZW7Fkg9NaahIP2+bgbYprtN6+HE6gM68fRDQb8fn4Yqe9+VZUgNZM0rIsHIXEMSXcarVIPZ2nc+gzi+Y9e1viOc4kqC6o+n/62L0M3zlMZxDQH4RiZtqPUuN3X39PVmPnBMNE/PkThz5KIGWI6CWGWVU8pI95IFlCG1B7jRen/mSNPBpZlHGpjMcFC4QaBtXtutx5WE3/OPXhzPvJLtTshEwIAuuh+u28ZqsFc9ikmHx/bsqQwiLCkfDg2SnvilqiYuBWtow0cKNqZD5oQzJFm3xXZJkQlg3IMmsiylk0afutcJytdj8FFcxDuSHrLiBJT6NhDougPx+6ZSZasaoGGeXVaMyMrkdHqBZNNepovv4yrIr83rfhZOPp6WCqt/eJDt4kzl3BcVQO3PLAtATo9AEDo11K1TgFEa/EoYnOwWRQix8//SNBoG0GQR81SK9ohLrJMgxDUI2b9jipxRrcy4NubVU0KFUP9IzxZOAd0JthgJzumIMJ94m11p/+4xO639M1m2izyW1hknocdXpTiKXQfkC5JVzcV/Wyluds/lrddbO+uR1Qi2V8ljn6V/RklJjVrxIiySDJBdznC6D9qEMenC+9Acz0rlQrExIVCYDo1Lb/HM21m6yqh5F1arCTKTNOiBarUzYkV/Vaa/bSrMolWb/PJycTVt3P+RDmSwLAHA37foADDbrdToOxZh4BC1pWC8ydk5dXIqoCtnNjvLl/QyYQ13azFkEknb7RtcjllaTSgivRzDml3YfjCfGVf+LcxpSWPFJ+J/GQDSOCxz7uIg86xK9/0ZMYCFnjZgO9RAXP+6kosH7c/8i8wFVkyGxWftaRHQ2vJxF6B4LH1JpllhkI6z6Q/8x28qA+B0E2b6nNGfrITSTCdjLnnCa39MM0Ns/pWhZh75phIg7PBJ7W5qWICaRa+oCiu552nFUUqgBB7DabzFa2Yt/qVxjEafn/lIItObjFwT9xp+cy64leri+bU48Yhv6eEHICxO8lInFVTitNH+7mJ5AdzmAYwO/7cRVzKa2ZK8a6Dk5R8RgW6/pGQ2VSkNps3k8q+qr//oMX0LCh2DJYkbCVi2+Y7WtXNwEwjV2MY2tttqr1EskFxZbLVB4DurW9Q2rAwGsMfQjio0o7HgcWB6Fu50gAH6wf0Frz0euC6DHsuFRv+mI4l+9pfefTWaPiwYjnFbNPy7FfPn4gTc5i1K2aUlwpEKQrXop2Dqzw3DnCgAlcXQ0ym5htKM6AF/sa2jSWEitdyAngiQ25yDqIuWa/dF2iXUJPOT32O0//F1DvndZhy9gaQekMn8uuk0cAlFeAPKsDEsjENh55q3kqopHWYSSU4lFPSJ/VkE7gLqz0QSsFG4PfCujcfRGnthucksFaMqfzVV67jiJDz6G4bE4cjqr3nQGY9LKYz2JHL7CBrxQC75uFs1TpaO5XxUIMurkHPjrhWmjeldvxW4evbop7k1G83XUd57dn+/VPIqHmp/MtEkAE8d9d4qvH3oOQggUTN6OtfAeedUbfxe6fgIIyhrFPDFipDswbKgbWdXXX9JjaIzPVPRXa9NlbOq1HAgHBLEYAA6TaKjttVCaZzn/6eFdM7a/7M7ihncM5IxZbVHzrYOU/uD3UYwozeclRM2Q3V2QHMxBslYIYjc2klN6wPhwWwvlOFEoPNoJX2dJXQsUt8+covmg4uZvZUwnMdJ+x5lfbQ7hq/yy9hOHUjKOeqy92ednL8j1pWptQxOXH/O3ExKZuf1upvx4/Sc8DhoIo7bkK3P8RLnH+BaQ/4QwHgZH2VCtveeAVgMK5XMIeoWp9ZEu7CC7f1ke5NbHrvB/M8hx3SFOLjdA5nG3X0SrcsaWIAWof9/82PII3qxbxWuXcB1bdfP7oWUVFon9mtaVSSAu5QWLm4zKSIfed3f2bzHSb5NGKBLFRfmk4N+CZRvc1GhPzbF71YORhnAlQCXpFlIW3svFPQJPQYviRdgDbAzPFX/l7yR0b8XQInMsOYOrgX2PmJ58LzK32uBCS0uqUEogQiF780Zd7Cvdw2oLX85RfUaTLrUaiCPczwYY93rWA7e5ekSFR0dCFQdYNR3EkyNwa07odwwFcLeuDbXYhuMcN2tnAtEutojXFvh/7PomBqs5TpkQmtm7Clw95nR5h2tg0ZlL2d8Fmois2H2vI0Kfe3Z5iJpY+pYrDQ6Mh+Dg1oNnmfS6/I+X0mpSP9xjafVE7PHNMDf7Tvm/NeCNnzKxMimX023sKyi+HUxvO4R6gGVWI/65R052xrSVlmlYLI9w/GggAEJIkMXbD0Z7Q1K7ZA5jnrYaIW+RR/MX3JpRn5HC5bkQz0nZJyWCvxGqziqyP3Pt6ySw608dmzr/aEEoxY4QSa+k5J5MsFsqe2iJQE4ThP0CtFgh4YZfSwcDrB0AdhV2Um0vBX/tlCCJCn7ppapP9HmIB4w+BIlsZHZun0D0tvHy30M5dLjF7uAd9OhnHg1cn8ZSujpTeXjDBNZECwMzD6OVeFKNNxJvgf8Xdv6yOaKqFz3HjFBdkEZjIpgXZVCWu4t35bnZcAEDydPU5918Wa/t4ohcGZScxnFDJc/8Uc/A/BCEcdp2nlIZLemxwGTGNrPd5j411RKsk9dzum9gSzEPsaS1ELnjZB7Omohreu2uwJSr1TdHW/M7KNBzcRCj52lDPBbgc9ke92UdHkGB/8alq6W3yKCqA78WaeOxria04wxnxSyHvD/qtJJW5xt/wcRubP0fNtKSiSGTIiaQwz+KUWX76MiKB4hjgW2KCzn5EOsoEIQgqHh4VOdx/o////YK+d53/VlIg/MnckEfHBJSe4ClrF8SgawsJGFF0GXt2BOaS9WU1W/RohYKppQCeSNcEYpR8tPUl9c/Z6a7d06UrD/dR/BCDRLTqZczlgcSl/N4fthzlLMw/KA4Nuuqh5QJkEK0QTgxy4ujSrUaugNGIfJSloQBXBSg7UaHMsBKMWGZTWzXcGEFh63Gyy6DNtqryRK6o7tAHwYNu63+ObarlJKrMRg6BO8W0LOeLXCmNimP/m3+PgbuIJW0AFd4FjdPD8X9lJCkh5BIidmd5a2S5bUxIQCuAAG0cQB2WPkEuRCrSmIkQPRXiMD14qBjGIVAaOCdD8yq+IkE/GVBaafpj/AWnNQULNdEDlKQDqHdJWQ+EGO1+OvgiU2hk9TWV5iyTgUguTQao8DfPkg/76zPaokDG2fZUM+5nEjeaIjfE6aVroaDmKnmTXwh1EK1E0r0tMKZgcrGyaZYcm6VJL1cEpL9zHj8qezDqWwLvK3IP/DJi9tzMhZHq2KS4bAZqrhOkZ2WkpsNqFED6/W4EZq4QTHpfZs8yQiohfkr4oz1CK7K0dntM2h7ORRDKAUCYyiizC2VLQKdPg1Nb7004I6Xsk4UXV0UsMu8lHzp7sllvZQMflOeydFU3wZeh0yBFVt78RL6j9lNu7l1Dz3tCGsSt14O/uPMl/l6gAICPLuvEezHNwW3O8gtcr5SqEseDcGEctGGONLr/Of/63KtC/9fb52f3E7j9PtMX5gAmWDMMyYkPqLOICnkF1dNd/PRFbClr0VZn3yv+7dJyZPn31xlIAf6xjz0GEjNmKt9ijGP/GDXuC4YFheuabd7Ik/+UEd3UEIJS3euSnn1rqrBbtfg+TLL9mG6KPpDJOQtwrbmPplIe5v9/7j9WMzSZrrKMapx89/QQjb50aeVu8tMkaOuGXUyWBwHiA+JB3KVQhuE9RNx/RKZiViLqX8lpg7D/7HWvtAKUCsRLdUSynIm+hhvV48m7KvFgkj3L0IhRIJgTInpyl+CrJJKQPrD9+tv4ygqRWODtaV7anE8TBaOjDbtUwc+xlv7nyJh8JM8AFpqRru/tLSJya7XIA9PWBUJfj5CXDrniQ8Foh1TCxEwnuFwMzLmGvxbdjX+aAlCyO0FYT4apX7vm43stD6KUjPcLedqp8Vn0GN7qnGJFdDO84NssNfNT+gcKFkZ9U1kljNzAAP2GbRd0ejqMFvBxncEb/e54TFWUJ8uS+9Vu8eRkHk/eP+tZ+h+ZvJgFJgVjC59qKkJ7gyJ47jUJ/BFM5ZsOMZCvedf7Ggcrukbrb02N3dZAqzkq2gTGtuVGQ+fpqxZggxYXdmDuwngZGP30y56tcSQpLsr7bw4/NAjpVGt+QhmiE7egJY+Lkl2fSg9IkgHgjiK8yGQsrWAAAcKWhZvp2cbm1rcWZ0E+dTLDX7sqm4wPuEmqItl9c6HtZLli1fG0Q1Af9MzLmAWaa3HDDa7DKxngL4jBt8mj2Yl6Klyl4x1+6rUb2bwqEZbqipD09Dw2q0kFOoIPLpLn1t7UfEq3vhwTHpieE2YPiZzQvhElFuMfjJvCex8WsUXf/GtIUY6V6m2c2G3j+0IT8o2NwMqp0I1JYS4hu+Bq5Zhr4M1qP5YhkR3Ke9rLOltColQSYKCA64T/AOJhIpPvPFRRs1s8k2NXFVCOK69zbAFc248oQCZmHhWqPZ/OlFbkTwm2F3vcnpSdI3DC6x1WN+EuB+hadloi9MI3VfTjDuLC6h//4PlfYkiQrbIOyaZWDsk2xP/xP7n0JxCRItGNFCxYZQDbcGgogLRJcu9FUXZf42O9JUHqXl7QHcqpRh1irxdY0a9u2F3Tg+mN49MIIjc3wdq0g/yvd6u5I5A/Ng1McTdpwtkk6ayOxnSI5Mu9iHncRBn1YTjBks4S2z/v5c0tpsRe+YISo5SyO48jyXX2HrA7Q8Mt258F+E/a1EBMO5rqke0lGETMq5EkXwDdSD33IFLLRW7QB5yUd+bS3exR+VG8iLb5a81HVXzJPLtQ8v1ZXjH1IoJ4Hf0waHK3KyoRez+a5V6UiFSQZefoYrrLGdNIQs1e9BTfAffnGivcg8ECerayXFSGhd7p2jaRs+87rRD3iVWzmSbCZTrpmIpqGlw7eSLM7hU1jWUdDHd0eIIK+7THY19YLj3t2Yzg9YDVbb58iTzdN+DebOopqO7OJDl7glnqCX7t64J9TCmnapafvpJWBQUGieLnNrgkPtGjf6Ph3Gaj6PPNzP3mdZs7yh81CqQ7KC1g3nKjhI64lSvNqKXTlvaEG4enUfTMh8lIZb/gdeMUEeLP8h/Csv5uunUWh2xnC1GSZ3Wqel+nNGO4hRMi7mUeMQciAgRABaoT0ELDz8Bk4gOP3Fy2Gx6DQnooy3pFPpb+KhHK1JhEe6A7/WSbENHNHz/FJrU3hi+OBqXhLX7FJl/MwNJh3K57oMtoiw/Wwzlks5bDDXls0SetZkPW92kMtRXtnUW7MjdRqLXTZHqlJNHh6GJXYht8CijQaI+WpgFhrJ47Nm+m4Xkz9/0UccM5LR+M32RcomUONcxLvoQVsyp70JEUZijD0wp59Z1M6428K/WpcFTvWG5jSP7NcXWbKs4zmtxVf9eZj57lv7xmNUm6tdVBs5jOQQiiobG/I5QH3lCBVjVbhsHU58dDOxeqAy+Uef3Q+TQhjLsNpyVWNbKrZ3Aidhpcn11P5jvHDEdSuYKoZKwOwjkxuD/IQFoNxXgK60unwRPj/X9AnjbyS5pQ0huTiUcRkfr4ZxMcvAQgeOtQw14DtzukA0ZqDG82ZkzBhme1aRR0pgj7Na7RLTA0ggTevAJuOmj8xvM6kbBaEK06xMTg8kxKzYlc5tEsEawzyhwazQzuW0TUm6o0Z9d8bTKmPzGR9lMWEoMD76ljYDnRNUYH4E789pGIT+8Nu9GcDAOEXD8hjO0+QbMWa0ARbRuDmbEocg0KpmMXsYVhnp+FqAcHMCv7cRNXuXLFeCL/zgkTPkXJFWzow/Pl+HxcHrq6hAy06h2r+rwnu7jRWCs7WC3U0YdFtlS1WL+V5aZOfhK+FXx4zMshH+HEVJTkACORoXnYWkJ3jrAXDGF3/5FIzo2c5rzEf2baKaxMGHLtUp1VedQ/s6Vf4aajRyKbfJL6vBY/MUmpJUOmnqtNtLZJuZTT7X8Kzvg+ve6dKIGzBWcpzCfvBj+daKDkeoxNipYN+vajr/MNukseDZUKY1d2rLr2wo97IfMbGfWLf5mW+ZCkm80TFOnqSITA1UJa38GKn6cvKooF3BmigcCzgH4FeQIbidXyPMaZlbOf8wWSvlvd9UyI/Dc6nlSBHrh/X2zh1SxqMB/oCXAIVsv1RaP6DyURt+d3J1TNmC5ZxlpbvH1TK2Nner+cVklHjKdm6z9jLS/0v3wV/fYh/5GnEW1t9CyKXZRVhw38HsG7aP+7luSzrbt4otFKvC4IDCgkhAvSN3s2tPciZUtcgPvNPYbp9p1zY2Irqmr9+3HECtIu4FZoUUKpg2uw+XkC37ch3l1+0PEBtNPVUzb/XiCqSZ2GO6A8AYgGGSZ0Wzbfd/l/7a/2P7RKuha2kK/5dn1uP4n1E2uYpejfwaKDMyErl8sRvOVoPUa7oxUHeM2zIwlGKbEbiRiUt1CxgP+uzuqsifQMzztWKCKWYu0Ik2L8p6xysJJuLgR2xp5JluRjN/MDvappU+4eKf0wOEJ+vJr34WndRgexECTlwZC5bBNew3ApG7wYsglF7CZo0kyG7bchQT0jvX58h4MqTzM5e28b0fb55ffRMqIjg0EoRzHOisFGkYjZ7ANEum6xiAZB4sSYSEveaLMNeSAcWMCzn218NEkO4vV3MMocT822HrkdlL/tVr/BQuyB2KktbBgDZFO4+h7zUGF28/A9lcyHVBCxHS6u1UBX3giK+Z9DQVSR8dwa9UIc3opu0aBPEqsaCj7BpE5IC1zz33PNWnUhxRDg/0hNOYrIW9YtfshoKdLwU3GTahuInHg8yBvacI/6cc4xfTKSB4UMv5fK08QnCBO+bmrteyDkNQUvPIfez6pXKQzZGMDhRcLLYtl9aHZFCtUSeFkH63dAJJQ1t45IzshkrMCbsynDlPWDDAbHG3phBXF/dxUrx9+3dLnsOgrV/DIuVe6vfySvmARMrlKqVVreMrAiyHTUh37KyaPZ75/qGrrVuG6bontmkT2KepF5mG/f9yMxOtbaeqlpv1IU/L8z/1ywV/m5yFVxd2Zo/koT0e2DoE7H4Q1vkf9oFlwftB3ZE0kS4DDpKRbGzvNevOTZd37RC03CFnLxoYIFFrbs1+G4TW1ZovjsJ4yZrI2AJDVWzyL3u0BKN0rtLUjQlxGLX9p9vlmN0PFf73f07+zcZwMKzf/IAh9ZJS7cmF+VNduTOU/j70tp7aJFJbJnfkP3Qc3cMhv6cvm0cZKk2f2hheQtug5sffiyROIyAJ60R4jYqN8a/JAWIGCeVV/ozBHehjFKefsxaOvfrFqnL/xJfAk7/Fg1M07icWzBplsIEQINw86KJdzJhCNz9Ko9ZgPNmpjn7c3WOto/+Ii/VSHZgbk7srRp6dCJ3zQRdpGsX9W4MShgpTkZcT4PXxtW3639AQSOPH75ctGsZ8LW/RciM61mbq95UEjTY+4paFkKvGYf8MsJwbt1lXQu8tB9PCfftmmb4Vpyxxp+bOrUPMpEVwBAiHVkzKryRPQefHN5Rc3S7i4C4xCoaaiovcqDVESlkaS+JqDiRoR/x4xd4e7lHc+e9YA+Cys9gClitMaW8SQXwn5kiEupm3ldJINxD7vq9Zyd4fMKekLzWJe9vvzZNDw9LzkaYRqA7qlUu8jrlR8SldPi0DMd14u7OLH78SUhiElO3xHyHPe+jJIDczTrj/gRpCyd6k/0yN9qTiyclOV7dFXiuCN2I3Dq7EeiKiKs7NECoraODwAHz7M4LLqBZWlSWgNxNDFzgvu/jYEh1j5mLykKe5tY8+WstV2+p/9Su09qq2aWyBPGzvJt6qeU8aIbY1yYFYfc7jMttuI5m3y+U8T7o//40Laac5O0fy5Xo9bGJtVf+P8qpv/IdtWyjL5etUuxGh4FMNuIw0p8CnHN3dZcy2VQWOUYdoszwAUCT7WvuTY+pb6m9SXpzMD4/MJjbcZzVyMcDDlVU+YdWqALjbaUkkv6uS7veKAo4YBvOEJfnKZauclalw9veEviVK+haHNGB1Ytv0vYh+f2HeXoFlUYlWQt3247bkQBotiQdrzdCtg2dWXtesktDbBfbXEHl4+1WuDdF92ZeIFLe23IxRfPcJjv/9W+jP7HBJe5beqew+TIFux+0yZdJFPRItXJ4vXvT6wPABI9HvmEam8VfuAyjZuUangVgktfAiDChJiJ/S4BWkcB48jIkc7WuWwJXneEgHcvIUTro7th3hZ6Inywh65+PQ2ht04HRRdNRM88D9otffu9+wgBHZBAyTg861562gp0L7NjkjOVbBFafVH8M3PSoLJeXeWg2doL/v5gcVUqpsZnGY+7mjcCOVD4AAAP1NJ7zPccHMD0xBuqg2dIw6656L5C+3Orz4EG8M7qq/dN3IYaf37uwJlLvFeiofbRYQqzVpWFb5H1gzT2PT2IK7K+CtKUfdnfHOX48fSlbJHqhXbKlA+wpJBL3OJ02t9Yyr1OYhUprTFGGOcUDD9ksVR14OLlz1T1rre86LtJLYj22wxrXgbAHtZ3h2EAM1HjoJYEJ3iEZpxOtW8T3jks3NHnRBv1JMJStYop408sgO34aexoWUKkPqnW/VWcG6GCL5OPaQ5Fa3OVA/kjRCVeaV6fActG61G/fTFzB7AdYREw7HCdC3Kv95PG8iZI0iKfuBgOeLFpNkW4Y//kOeuRYkiuyyh6BkXjMOHO3pAEJDA4C9LwIBAAE4W5flxMYkRq/I4eE1ukLZa081+ClJLonxCRgypIUC/UeMMmNZ38zdTbse1MYfRUpQk1ywPkM5SwauOjlf9AoFhqdQdcLH0damm9y9rRvhuDvQUGkZxkPk5PwbdxAGW6dUH6Lkga9B3WychiCWQuLz3g5CYvvV31vlVarBM0QctialvT+I+KN5Fr5n1KRGUPgMtcOemrSW9qhd5q3PFNzmsCXUo+6uNdlUOzBrh3WaeeFgkNDC7EowPDSWc4Tt95lVmPFHUUUD/uM+33MrptAZBpW7gcqP96JWEa9oBgl3FEswF7uyaFCfAXK/t90juupNOWTndRj8Rszd5/DyElejG//51QGncCsBieDiPFPbbLN0LZt7TFkTXZPc37DJ3FRQKCP/oGXXDEirDcBxvdLF8oZhW1/iIVoW6BPrJdzUDgYOA2Z1kxi4ltQtbpLwxcYmDu/1ap+7FbQdqWAoGQvjxGgnD39eBl7YnPlYHpb5kIvYXWPpnAvKnZEZB9VzyWoHFDraX9velkqCNkQl0sjdFZ+J2YJt6k2uAuLEyDuQxfKHNgQEUQfRsGCSsuXVAAMdkXb+rjsBi5y4rnOEXpgxXg48Cj+PESggZeSxRVmPNX+VMfmMOkoIL9fdxUH8bTtFn78G/422pI9wDC3Eo/EOACxIu7b7dZ2OiRDRh/K6XmkXMnwUobvKY+6ooTv7wL6DmzP7+vBzlvLpES1ZJjt5KXc0P6pXDpf/zb8DnMyTuwT8zaBDzGQY3aT8HywH/vJjvd0EEmtTz+3HsoimuD5NEV8zCGf2YWtWAVZi+QwrZ99DMJpVRfeR2j1XTWS50lReuAjnpVRZhPhEyKuNVc4icrW8UmkoG0NGTcttubYzggBo/phoW4gL5yd/AVGLFCHdphlwQT5Dob8ZiSBlZQS2pXR6vAA3aPCDIfY3+72oqUHQAAAAAA=="},"a90":{"w":252,"h":451,"ax":0.5086,"frac":0.5,"src":"data:image/webp;base64,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"},"a180":{"w":357,"h":460,"ax":0.5642,"frac":0.5,"src":"data:image/webp;base64,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"}};
})();
