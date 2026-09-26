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
    const P = g.attributes.position.array, N = g.attributes.normal.array, flip = m && m.determinant() < 0;
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
        A.c.push(_c.r, _c.g, _c.b); A.g.push(grp || 0);
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
    const NR = 20, pos = [], idx = [];
    zs.forEach(z => { const p = secPts(z); for (let j = 0; j <= 10; j++) pos.push(p[j * 2], p[j * 2 + 1], z); for (let j = 9; j >= 1; j--) pos.push(-p[j * 2], p[j * 2 + 1], z); });
    for (let k = 0; k < zs.length - 1; k++) for (let j = 0; j < NR; j++) {
      const a = k * NR + j, d = k * NR + (j + 1) % NR, b = (k + 1) * NR + j, c = (k + 1) * NR + (j + 1) % NR;
      idx.push(a, c, b, a, d, c);
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
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
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vLP; varying vec3 vLN;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLP = position; vLN = normal;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
varying vec3 vLP; varying vec3 vLN; float ctStripe = 0.0;
float ctBand(float v, float a, float b){ float w = fwidth(v) * 0.75 + 1e-4; return smoothstep(a - w, a + w, v) * (1.0 - smoothstep(b - w, b + w, v)); }
float ctSeg(vec2 p, vec2 a, vec2 b, float r){ vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); float d = length(pa - ba * h); float w = fwidth(d) * 0.75 + 1e-4; return 1.0 - smoothstep(r - w, r + w, d); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
{
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
    box(TR, M(0, 0.47, 1.45), 1.22, 0.5, 1.5, 0x040404); box(TR, M(0, 0.47, -1.51), 1.22, 0.5, 1.22, 0x040404);
    box(TR, M(0, 0.41, -0.45), 1.6, 0.02, 2.2, 0x121212);                                            // floor
    for (const sx of [-1, 1]) box(TR, M(sx * 0.80, 0.64, -0.08), 0.03, 0.5, 1.35, 0x161618);           // door cards
    box(TR, M(0, 0.80, 0.62), 1.56, 0.18, 0.28, 0x0e0e10);                                            // dash
    box(TR, M(0, 0.9, 0.57, -0.12, 0, 0), 1.56, 0.03, 0.26, 0x08080a);                               // dash pad
    for (const gx of [0.30, 0.44]) put(TR, new T.CylinderGeometry(0.052, 0.052, 0.05, 16).rotateX(PI / 2), M(gx, 0.875, 0.49, 0.25, 0, 0), 0x1d1d20);
    for (const sx of [-0.37, 0.37]) {
      box(TR, M(sx, 0.53, -0.45), 0.5, 0.12, 0.52, 0x19191b);
      box(TR, M(sx, 0.86, -0.72, -0.2, 0, 0), 0.5, 0.62, 0.11, 0x1b1b1d);
    }
    box(TR, M(0, 0.53, -1.25), 1.4, 0.14, 0.5, 0x19191b); box(TR, M(0, 0.78, -1.5, -0.35, 0, 0), 1.4, 0.45, 0.1, 0x19191b);
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
    const body = mk(finish(P), MAT.paint, 'body');
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
        hurtCar((imp - 4) * 1.7);
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
      sfx('car_squish', { heavy: close > 15 });
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
    V.driving = true; enterT = time; startT = car.stall > 0 ? -1 : 0.45; car.inBarn = false;
    if (IO) IO.disabled = true;
    const cam = CORE.camera; chaseH = car.h; chaseY = cam.position.y; orbit = orbitP = 0; headYaw = headPitch = 0;
    sfx('car_door');
    if (car.stall > 0) emit('notify', { text: `The engine is still cooling: ${Math.ceil(car.stall)} s.`, kind: 'info' });
    if (!car.told) { car.told = true; emit('notify', { text: CORE.isTouch ? 'Left stick: steer and throttle. EXIT to leave.' : 'W/S drive, A/D steer, Space handbrake, Shift floor it, V view, H horn, E exit.', kind: 'info' }); }
    save();
  }
  function exit(forced) {
    const PL = CT.player; if (!V.driving) return;
    V.driving = false; lastExitT = time;
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
      if (lookIdle > 1.2 && sp > 2) { const k = Math.exp(-dt * 2.5); headYaw *= k; headPitch *= k; }
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
    MAT.glass.opacity = cock ? 0.14 : 0.94;
    // paint reflections follow the daylight
    if (!hemi && core.scene) core.scene.traverse(o => { if (!hemi && o.isHemisphereLight) hemi = o; });
    const day = hemi ? clamp(hemi.intensity * 0.55, 0.05, 1.1) : 0.8;
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
      car, hurt: hurtCar,
    },
  });
})();
