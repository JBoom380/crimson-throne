// ─── HUMANOID KIT: heroic NPC bodies, faces, outfits, procedural animation ────
// One SkinnedMesh + one ink hull per character (2 draw calls). Geometry is cached per
// template (body + outfit shape), materials per palette + face, so a cached build costs
// well under 1 ms. The rig faces +Z; the character's right hand is on -X (npcs.js and
// monsters.js use the same frame). Bone names follow monsters.js (hips, spine, head, jaw,
// shL/R, elL/R, hipL/R, knL/R, wpR, cape) plus haL/R (hands), wpL (left grip) and ftL/R
// (feet). Every bone carries the monsters.js pose slots userData.r/p/o/l, so its pose
// helpers (zeroPose/add/applyPose/startFall) can drive a kit rig without changes.
(function () {
  'use strict';
  const T = THREE, PI = Math.PI, TAU = PI * 2;
  const CT = window.CT = window.CT || {};
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v), lerp = (a, b, k) => a + (b - a) * k;
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const gauss = (d, s) => Math.exp(-(d * d) / (s * s));
  const sgn = v => (v < 0 ? -1 : 1);

  // ── Palette slots: one material, colours looked up per vertex slot ──────────
  const SLOT = { skin: 0, hair: 1, top: 2, trim: 3, legs: 4, boots: 5, leather: 6, metal: 7, iron: 8, wood: 9, cloth: 10, bone: 11, fur: 12, dark: 13, glow: 14, accent: 15 };
  const SLOT_NAMES = Object.keys(SLOT);
  const DEF_PAL = { skin: '#c8906a', hair: '#3a2416', top: '#7a5a34', trim: '#a08850', legs: '#4a3a28', boots: '#2a1c12', leather: '#4a2e1a', metal: '#9aa0a8',
    iron: '#4a4c52', wood: '#6a4424', cloth: '#c8b898', bone: '#d8ceb0', fur: '#5e4a36', dark: '#140a08', glow: '#ffb050', accent: '#8a1a12' };

  function rng(seed) {
    let s = (seed >>> 0) || 1;
    return function () { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619); return h >>> 0; }

  // ── Shared materials: 3-step toon, rim light, palette lookup, ink hull ──────
  const RIM = { value: new T.Color(0xffb070) }, RIMK = { value: 0.55 }, INKW = { value: 0.0026 };
  let GRAD = null, INK = null, BLANK = null;
  const MATS = new Map(), FACES = new Map(), TPL = new Map();
  function shared() {
    if (GRAD) return;
    GRAD = new T.DataTexture(new Uint8Array([72, 150, 255]), 3, 1, T.RedFormat);
    GRAD.minFilter = GRAD.magFilter = T.NearestFilter; GRAD.generateMipmaps = false; GRAD.needsUpdate = true;
    INK = new T.MeshBasicMaterial({ color: 0x140608, side: T.BackSide });
    INK.onBeforeCompile = sh => {
      sh.uniforms.uW = INKW;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uW;')
        .replace('#include <project_vertex>', `#include <project_vertex>
          {
            #ifdef USE_SKINNING
              vec3 ctN = objectNormal;
            #else
              vec3 ctN = normal;
            #endif
            ctN = normalize(normalMatrix * ctN);
            mvPosition.xyz += ctN * uW * clamp(-mvPosition.z, 0.6, 14.0);
            gl_Position = projectionMatrix * mvPosition;
          }`);
    };
    INK.customProgramCacheKey = () => 'ctHumInk';
    BLANK = faceTexture(null);
  }
  function material(pal, face, unique) {
    const key = pal.join(',') + '|' + face.key;
    if (!unique && MATS.has(key)) return MATS.get(key);
    const m = new T.MeshToonMaterial({ color: 0xffffff, gradientMap: GRAD, vertexColors: true, map: face.tex });
    const uPal = { value: pal.map(h => new T.Color(h)) };
    m.userData.pal = uPal; m.userData.rim = RIM;
    m.onBeforeCompile = sh => {
      sh.uniforms.uPal = uPal; sh.uniforms.uRim = RIM; sh.uniforms.uRimK = RIMK;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aSlot; flat varying float vSlot;')
        .replace('#include <color_vertex>', '#include <color_vertex>\nvSlot = aSlot;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 uPal[16]; uniform vec3 uRim; uniform float uRimK; flat varying float vSlot;')
        .replace('#include <map_fragment>', `{
            int ctS = int(vSlot + 0.5);
            diffuseColor.rgb *= uPal[ctS];
            vec4 ctF = texture2D(map, vMapUv);
            diffuseColor.rgb = mix(diffuseColor.rgb, ctF.rgb, ctF.a);
          }`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          { float fr = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
            totalEmissiveRadiance += uRim * uRimK * pow(fr, 2.6) * (0.35 + diffuseColor.rgb);
            if (vSlot > 13.5 && vSlot < 14.5) totalEmissiveRadiance += diffuseColor.rgb * 2.2; }`);
    };
    m.customProgramCacheKey = () => 'ctHum';
    if (!unique) MATS.set(key, m);
    return m;
  }

  // ── Faces: painted on a 64 px canvas, alpha over the skin ───────────────────
  // Canvas px = 32 + xn * 45.7, py = 32 - yn * 32 (xn, yn in head half-heights).
  function faceTexture(F) {
    const key = F ? JSON.stringify(F) : 'blank';
    if (FACES.has(key)) return FACES.get(key);
    const cv = document.createElement('canvas'); cv.width = cv.height = 64;
    const c = cv.getContext('2d');
    if (F) paintFace(c, F);
    const t = new T.CanvasTexture(cv); t.colorSpace = T.SRGBColorSpace; t.magFilter = T.NearestFilter; t.minFilter = T.NearestFilter; t.generateMipmaps = false;
    const out = { key: 'f' + hash(key), tex: t };
    FACES.set(key, out);
    return out;
  }
  function shade(hex, k, to) {
    const a = new T.Color(hex), b = new T.Color(to || '#000000');
    a.lerp(b, k); return '#' + a.getHexString();
  }
  function paintFace(c, F) {
    const X = xn => 32 + xn * 45.7, Y = yn => 32 - yn * 32;
    const R = (col, x, y, w, h, a) => { c.globalAlpha = a == null ? 1 : a; c.fillStyle = col; c.fillRect(Math.round(x), Math.round(y), w, h); c.globalAlpha = 1; };
    const E = (col, x, y, rx, ry, a) => { c.globalAlpha = a == null ? 1 : a; c.fillStyle = col; c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, TAU); c.fill(); c.globalAlpha = 1; };
    const skin = F.skin, dk = shade(skin, 0.45, '#200808'), mid = shade(skin, 0.22, '#301010'), hi = shade(skin, 0.18, '#fff0d8');
    const ey = Y(0.07), fem = F.fem;
    // eye sockets and cheek planes
    [-1, 1].forEach(s => E(mid, X(s * 0.3), ey - 0.5, 7, 3.6, fem ? 0.35 : 0.55));
    if (F.age > 0.4) [-1, 1].forEach(s => { R(dk, X(s * 0.3) - 3, ey + 4, 6, 1, 0.5); R(dk, X(s * 0.52) - 1, ey - 1, 1, 3, 0.5); });
    // eyes: white, iris, heavy upper lid
    [-1, 1].forEach(s => {
      const x = X(s * 0.3);
      R('#e6dccb', x - 3, ey - 1, 6, 3);
      R(F.eye || '#2a1a10', x - 1 + (F.look || 0), ey - 1, 2, 3);
      R('#0c0606', x - 1 + (F.look || 0), ey, 1, 1);
      R('#140806', x - 4, ey - 2, 8, 1);
      if (fem) { R('#140806', x + s * 4 - (s > 0 ? 0 : 1), ey - 3, 1, 1); R(shade(skin, 0.2, '#6a2030'), x - 3, ey - 4, 6, 1, 0.5); }
    });
    // brows
    const bc = F.brow || '#2a1a10', by = Y(0.23), tilt = F.stern ? 1 : 0;
    [-1, 1].forEach(s => {
      const x = X(s * 0.3);
      if (fem) { R(bc, x - 3, by, 7, 1); }
      else {
        R(bc, x - 4, by - (s > 0 ? 0 : 0), 8, F.thick ? 3 : 2);
        if (tilt) { R(bc, s > 0 ? x - 4 : x + 2, by + 1, 2, 2); c.clearRect(s > 0 ? Math.round(x + 2) : Math.round(x - 4), Math.round(by), 2, 1); }
      }
    });
    // nose: bridge light, tip shadow, nostrils
    R(hi, 31, Y(0.02), 2, 8, 0.5);
    R(dk, 29, Y(-0.36), 6, 1, 0.8); R('#1a0808', 29, Y(-0.33), 1, 1, 0.6); R('#1a0808', 34, Y(-0.33), 1, 1, 0.6);
    // mouth
    const lip = F.lips || shade(skin, 0.35, '#6a1810'), my = Y(-0.6);
    R('#240a08', 26, my, 12, 1);
    R(lip, 27, my + 1, 10, 2, 0.8);
    if (!fem) R(dk, 28, my + 3, 8, 1, 0.35);
    if (F.smile) { R('#240a08', 25, my - 1, 1, 1); R('#240a08', 38, my - 1, 1, 1); }
    else if (F.stern) { R('#240a08', 25, my + 1, 1, 1); R('#240a08', 38, my + 1, 1, 1); }
    // nasolabial folds and age lines
    if (!fem || F.age > 0.3) [-1, 1].forEach(s => { R(dk, X(s * 0.17) - (s > 0 ? 0 : 1), Y(-0.38), 1, 5, 0.35 + F.age * 0.4); });
    if (F.age > 0.3) { R(dk, 24, Y(0.42), 16, 1, 0.4); R(dk, 26, Y(0.34), 12, 1, 0.3); }
    if (fem) [-1, 1].forEach(s => E(shade(skin, 0.25, '#c04040'), X(s * 0.36), Y(-0.28), 4, 2, 0.28));
    // stubble / beard shadow on the jaw
    if (F.stubble) {
      const r = rng(7);
      for (let i = 0; i < 260; i++) {
        const x = 12 + r() * 40, y = Y(-0.35) + r() * 26;
        const xn = (x - 32) / 45.7, yn = (32 - y) / 32;
        if (Math.abs(xn) > 0.5 - (yn + 1) * 0.0 || (yn > -0.52 && Math.abs(xn) < 0.14 && yn < -0.3)) continue;
        if (yn > -0.4 && Math.abs(xn) < 0.32) continue;
        R(F.stubble, x, y, 1, 1, 0.55);
      }
    }
    if (F.scar) { c.globalAlpha = 0.9; c.strokeStyle = '#e8b0a0'; c.lineWidth = 1; c.beginPath(); c.moveTo(X(0.12), Y(0.36)); c.lineTo(X(0.46), Y(-0.28)); c.stroke(); c.globalAlpha = 1; }
    if (F.paint === 'war') {
      R('#7a0c08', X(-0.55), ey - 2, 44, 3, 0.85);
      [-1, 1].forEach(s => { R('#7a0c08', X(s * 0.3) - 1, ey + 2, 2, 12, 0.85); });
      R('#0a0606', 30, Y(0.5), 4, 9, 0.8);
    } else if (F.paint === 'ghoul') {
      [-1, 1].forEach(s => { E('#0a0404', X(s * 0.3), ey, 7, 5, 0.95); R('#d8ff70', X(s * 0.3) - 1, ey - 1, 3, 2); });
      E('#1a0404', 32, Y(-0.62), 7, 5, 0.95); for (let i = 0; i < 5; i++) R('#e0d8b0', 27 + i * 2.4, Y(-0.5), 1, 3);
      [-1, 1].forEach(s => R(shade(skin, 0.5, '#101810'), X(s * 0.42) - 2, Y(-0.3), 4, 9, 0.6));
    } else if (F.paint === 'mask') {
      E('#100606', X(-0.3), ey, 6, 4, 0.7); E('#100606', X(0.3), ey, 6, 4, 0.7);
    }
  }

  // ── Geometry primitives (model space, bind pose) ────────────────────────────
  function part(o) { return { pos: [], idx: [], s: [], sh: [], uv: null, w: (o && (o.w || o.bone)) || 'spine', smooth: !(o && o.flat) }; }
  function pv(g, x, y, z, s, sh) { g.pos.push(x, y, z); g.s.push(s); g.sh.push(sh == null ? 1 : sh); return g.pos.length / 3 - 1; }
  function vget(g, i) { return [g.pos[i * 3], g.pos[i * 3 + 1], g.pos[i * 3 + 2]]; }
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  function triN(g, a, b, c) { return cross(sub(vget(g, b), vget(g, a)), sub(vget(g, c), vget(g, a))); }
  function triO(g, a, b, c, dir) { if (dot(triN(g, a, b, c), dir) >= 0) g.idx.push(a, b, c); else g.idx.push(a, c, b); }

  // Loft: horizontal rings (axis 'y') or rings across z (axis 'z'). Ring: {y|z, x, z|y, rx, f, b, n, s, sh}.
  // f is the +z (or +y) radius, b the -z (or -y) radius; a = 0 is the front. o.a0/o.a1 give an open arc.
  function loft(P, rings, o) {
    o = o || {};
    const g = part(o), seg = o.seg || 12, open = o.a1 != null, a0 = open ? o.a0 : 0, a1 = open ? o.a1 : TAU;
    const nA = open ? seg + 1 : seg, ax = o.axis || 'y', base = o.s != null ? o.s : 0, st = [], cen = [];
    for (let i = 0; i < rings.length; i++) {
      const r = rings[i], sOut = r.s != null ? r.s : base, sIn = i ? (rings[i - 1].s != null ? rings[i - 1].s : base) : sOut;
      const c = ax === 'y' ? [r.x || 0, r.y, r.z || 0] : [r.x || 0, r.y || 0, r.z]; cen.push(c);
      const emit = s => {
        const s0 = g.pos.length / 3, e = 2 / (r.n || o.n || 2);
        for (let j = 0; j < nA; j++) {
          const a = a0 + (a1 - a0) * j / seg, sa = Math.sin(a), ca = Math.cos(a);
          const u = r.rx * sgn(sa) * Math.pow(Math.abs(sa), e);
          const fr = ca >= 0 ? (r.f != null ? r.f : r.rx) : (r.b != null ? r.b : (r.f != null ? r.f : r.rx));
          const v = fr * sgn(ca) * Math.pow(Math.abs(ca), e);
          let p = ax === 'y' ? [c[0] + u, c[1], c[2] + v] : [c[0] + u, c[1] + v, c[2]];
          if (o.fx) p = o.fx(p, a, i, j, r) || p;
          pv(g, p[0], p[1], p[2], s, o.shv ? o.shv(a, i, j) : r.sh != null ? r.sh : o.sh);
        }
        return s0;
      };
      const out = emit(sOut);
      st.push([sIn !== sOut ? emit(sIn) : out, out]);
      if (!open) { let cx = 0, cy = 0, cz = 0; for (let j = 0; j < nA; j++) { cx += g.pos[(out + j) * 3]; cy += g.pos[(out + j) * 3 + 1]; cz += g.pos[(out + j) * 3 + 2]; } cen[i] = [cx / nA, cy / nA, cz / nA]; }
    }
    let big = 0, bi = 0; rings.forEach((r, i) => { if (i < rings.length - 1 && r.rx > big) { big = r.rx; bi = i; } });
    let flip = false;
    {
      const A = st[bi][1], C = st[bi + 1][0], j = Math.floor(seg / 4);
      const n = triN(g, A + j, A + j + 1, C + j + 1), rad = sub(vget(g, A + j), cen[bi]);
      flip = dot(n, rad) < 0;
    }
    for (let i = 0; i < rings.length - 1; i++) {
      const A = st[i][1], C = st[i + 1][0];
      for (let j = 0; j < seg; j++) {
        const j1 = open ? j + 1 : (j + 1) % seg;
        if (flip) g.idx.push(A + j, C + j1, A + j1, A + j, C + j, C + j1);
        else g.idx.push(A + j, A + j1, C + j1, A + j, C + j1, C + j);
      }
    }
    if (!open) {
      [[0, o.cap0], [rings.length - 1, o.cap1]].forEach(([i, cap]) => {
        if (cap === false || (cap == null && o.caps === false)) return;
        const s0 = st[i][i === 0 ? 1 : 0], nb = cen[i === 0 ? 1 : i - 1], c = cen[i], d = norm(sub(c, nb)), dome = typeof cap === 'number' ? cap : 0;
        const ci = pv(g, c[0] + d[0] * dome, c[1] + d[1] * dome, c[2] + d[2] * dome, g.s[s0], g.sh[s0]);
        for (let j = 0; j < seg; j++) triO(g, ci, s0 + j, s0 + (j + 1) % seg, d);
      });
    }
    P.list.push(g);
    return g;
  }
  // Tube along a path; rad is a number, an array per point or fn(k).
  function tube(P, pts, rad, o) {
    o = o || {};
    const g = part(o), seg = o.seg || 7, n = pts.length, st = [];
    const tg = pts.map((p, i) => norm(sub(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)])));
    let up = o.up || [0, 1, 0]; if (Math.abs(dot(up, tg[0])) > 0.95) up = [1, 0, 0];
    let nr = norm(cross(tg[0], up));
    for (let i = 0; i < n; i++) {
      if (i) nr = norm(sub(nr, mul(tg[i], dot(nr, tg[i]))));
      const bn = cross(tg[i], nr), k = i / (n - 1);
      const r = typeof rad === 'function' ? rad(k) : Array.isArray(rad) ? rad[i] : rad, rv = r * (o.flat || 1);
      st.push(g.pos.length / 3);
      for (let j = 0; j < seg; j++) {
        const a = j / seg * TAU + (o.rot || 0), cu = Math.cos(a) * r, su = Math.sin(a) * rv;
        pv(g, pts[i][0] + nr[0] * cu + bn[0] * su, pts[i][1] + nr[1] * cu + bn[1] * su, pts[i][2] + nr[2] * cu + bn[2] * su, o.s || 0, o.sh);
      }
    }
    let flip = false;
    { const i = Math.floor((n - 1) / 2), A = st[i], C = st[i + 1]; flip = dot(triN(g, A, A + 1, C + 1), sub(vget(g, A), pts[i])) < 0; }
    for (let i = 0; i < n - 1; i++) {
      const A = st[i], C = st[i + 1];
      for (let j = 0; j < seg; j++) {
        const j1 = (j + 1) % seg;
        if (flip) g.idx.push(A + j, C + j1, A + j1, A + j, C + j, C + j1); else g.idx.push(A + j, A + j1, C + j1, A + j, C + j1, C + j);
      }
    }
    if (o.caps !== false) [[0, -1], [n - 1, 1]].forEach(([i, s]) => {
      const d = mul(tg[i], s), ci = pv(g, pts[i][0] + d[0] * (o.dome || 0), pts[i][1] + d[1] * (o.dome || 0), pts[i][2] + d[2] * (o.dome || 0), o.s || 0, o.sh);
      for (let j = 0; j < seg; j++) triO(g, ci, st[i] + j, st[i] + (j + 1) % seg, d);
    });
    P.list.push(g);
    return g;
  }
  function xform(g, p, r, from) {
    const m = new T.Matrix4().makeRotationFromEuler(new T.Euler(r ? r[0] : 0, r ? r[1] : 0, r ? r[2] : 0, 'YXZ'));
    const v = new T.Vector3();
    for (let i = from || 0; i < g.pos.length; i += 3) {
      v.set(g.pos[i], g.pos[i + 1], g.pos[i + 2]).applyMatrix4(m);
      g.pos[i] = v.x + p[0]; g.pos[i + 1] = v.y + p[1]; g.pos[i + 2] = v.z + p[2];
    }
    return g;
  }
  function ell(P, c, r, o) {
    o = o || {};
    const rows = o.rows || 6, rings = [];
    for (let k = 0; k <= rows; k++) { const ph = -PI / 2 + PI * k / rows, cr = Math.cos(ph); rings.push({ y: Math.sin(ph) * r[1], rx: Math.max(1e-5, cr * r[0]), f: Math.max(1e-5, cr * r[2]) }); }
    const g = loft(P, rings, Object.assign({}, o, { seg: o.seg || 10, caps: false }));
    return xform(g, c, o.r);
  }
  function box(P, c, s, o) {
    o = o || {};
    const g = part(Object.assign({}, o, { flat: true })), hx = s[0] / 2, hy = s[1] / 2, hz = s[2] / 2;
    const F = [[[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 1, 0], [0, 0, -1]], [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [0, 0, -1], [1, 0, 0]], [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]]];
    F.forEach(([n, u, v]) => {
      const q = [];
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([a, b]) => {
        const p = [n[0] * hx + (u[0] * a + v[0] * b) * hx, n[1] * hy + (u[1] * a + v[1] * b) * hy, n[2] * hz + (u[2] * a + v[2] * b) * hz];
        q.push(pv(g, p[0], p[1], p[2], o.s || 0, o.sh));
      });
      triO(g, q[0], q[1], q[2], n); triO(g, q[0], q[2], q[3], n);
    });
    P.list.push(g);
    return xform(g, c, o.r);
  }
  // Thick parametric sheet: fn(u, v) -> point. Closed (front, back, rim).
  function sheet(P, fn, nu, nv, th, o) {
    o = o || {};
    const g = part(o), F = [], N = [];
    for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) F.push(fn(i / nu, j / nv));
    const at = (i, j) => F[i * (nv + 1) + j];
    for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) {
      const du = sub(at(Math.min(nu, i + 1), j), at(Math.max(0, i - 1), j)), dv = sub(at(i, Math.min(nv, j + 1)), at(i, Math.max(0, j - 1)));
      let n = norm(cross(du, dv)); if (o.flipN) n = mul(n, -1); N.push(n);
    }
    const sl = (i, j) => (o.slotFn ? o.slotFn(i / nu, j / nv) : (o.s || 0));
    const front = [], back = [];
    for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) {
      const k = i * (nv + 1) + j, p = F[k], n = N[k], t = (typeof th === 'function' ? th(i / nu, j / nv) : th) / 2;
      front.push(pv(g, p[0] + n[0] * t, p[1] + n[1] * t, p[2] + n[2] * t, sl(i, j), o.sh));
      back.push(pv(g, p[0] - n[0] * t, p[1] - n[1] * t, p[2] - n[2] * t, sl(i, j), (o.sh || 1) * 0.8));
    }
    const id = (i, j) => i * (nv + 1) + j;
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      const a = id(i, j), b = id(i + 1, j), c = id(i + 1, j + 1), d = id(i, j + 1), n = N[a];
      triO(g, front[a], front[b], front[c], n); triO(g, front[a], front[c], front[d], n);
      const m = mul(n, -1); triO(g, back[a], back[b], back[c], m); triO(g, back[a], back[c], back[d], m);
    }
    const rim = (i0, j0, i1, j1, ii, jj) => {
      const a = id(i0, j0), b = id(i1, j1), out = sub(F[a], F[id(ii, jj)]);
      triO(g, front[a], front[b], back[b], out); triO(g, front[a], back[b], back[a], out);
    };
    for (let i = 0; i < nu; i++) { rim(i, 0, i + 1, 0, i, Math.min(1, nv)); rim(i, nv, i + 1, nv, i, Math.max(0, nv - 1)); }
    for (let j = 0; j < nv; j++) { rim(0, j, 0, j + 1, Math.min(1, nu), j); rim(nu, j, nu, j + 1, Math.max(0, nu - 1), j); }
    P.list.push(g);
    return g;
  }

  // ── Weights ────────────────────────────────────────────────────────────────
  // Chain: [[bone0], [bone1, from, to], ...]: moving along axis (y default) from `from` to `to`
  // hands the vertex from the previous bone to the next one.
  function wChain(list, axis) {
    const A = axis == null ? 1 : axis;
    return (x, y, z) => {
      const p = [x, y, z][A];
      let cur = list[0][0];
      for (let i = 1; i < list.length; i++) {
        const k = sstep(list[i][1], list[i][2], p);
        if (k <= 0) break;
        if (k >= 1) { cur = list[i][0]; continue; }
        return [[cur, 1 - k], [list[i][0], k]];
      }
      return [[cur, 1]];
    };
  }

  // ── Body proportions (fractions of height; about 7.5 heads) ─────────────────
  const TORSO_M = [[0.482, 0.050, 0.040, 0.045], [0.500, 0.078, 0.056, 0.064], [0.530, 0.092, 0.062, 0.074], [0.565, 0.093, 0.061, 0.070], [0.600, 0.092, 0.060, 0.060],
    [0.635, 0.099, 0.062, 0.060], [0.675, 0.112, 0.064, 0.063], [0.715, 0.121, 0.066, 0.065], [0.752, 0.124, 0.065, 0.065], [0.785, 0.122, 0.060, 0.062],
    [0.806, 0.100, 0.050, 0.056], [0.822, 0.060, 0.038, 0.044], [0.836, 0.036, 0.030, 0.032]];
  const TORSO_F = [[0.482, 0.052, 0.040, 0.048], [0.500, 0.088, 0.056, 0.070], [0.530, 0.106, 0.064, 0.086], [0.565, 0.100, 0.060, 0.078], [0.605, 0.074, 0.052, 0.054],
    [0.640, 0.078, 0.055, 0.053], [0.678, 0.090, 0.068, 0.055], [0.710, 0.096, 0.090, 0.057], [0.738, 0.100, 0.082, 0.057], [0.770, 0.098, 0.058, 0.055],
    [0.798, 0.080, 0.044, 0.050], [0.822, 0.046, 0.032, 0.036], [0.834, 0.032, 0.028, 0.030]];
  const ARM = [[0.016, 0.016, 0.016, 0.016], [0.008, 0.034, 0.032, 0.032], [-0.010, 0.044, 0.040, 0.040], [-0.036, 0.044, 0.040, 0.037], [-0.068, 0.037, 0.041, 0.034],
    [-0.110, 0.035, 0.040, 0.032], [-0.150, 0.030, 0.032, 0.030], [-0.184, 0.026, 0.026, 0.028], [-0.214, 0.031, 0.030, 0.030], [-0.258, 0.029, 0.026, 0.026],
    [-0.302, 0.022, 0.020, 0.020], [-0.334, 0.019, 0.016, 0.017], [-0.342, 0.012, 0.010, 0.010]];
  const HAND = [[0.004, 0.015, 0.017, 0.017], [-0.012, 0.015, 0.022, 0.021], [-0.035, 0.014, 0.024, 0.022], [-0.055, 0.012, 0.023, 0.020], [-0.075, 0.011, 0.020, 0.017],
    [-0.090, 0.009, 0.015, 0.012], [-0.098, 0.004, 0.006, 0.005]];
  const LEG = [[0.040, 0.050, 0.050, 0.055], [0.015, 0.074, 0.066, 0.072], [-0.030, 0.076, 0.070, 0.068], [-0.090, 0.068, 0.066, 0.060], [-0.160, 0.056, 0.056, 0.050],
    [-0.205, 0.046, 0.048, 0.044], [-0.224, 0.043, 0.046, 0.044], [-0.255, 0.045, 0.040, 0.054], [-0.300, 0.046, 0.036, 0.058], [-0.360, 0.036, 0.032, 0.040],
    [-0.420, 0.027, 0.026, 0.028], [-0.462, 0.025, 0.026, 0.028], [-0.470, 0.018, 0.018, 0.020]];
  const FOOT = [[-0.036, 0.028, 0.020, 0.016, 0.026], [-0.026, 0.028, 0.027, 0.026, 0.028], [0.000, 0.026, 0.030, 0.034, 0.026], [0.030, 0.022, 0.033, 0.026, 0.022],
    [0.060, 0.017, 0.034, 0.018, 0.017], [0.085, 0.013, 0.030, 0.012, 0.013], [0.102, 0.011, 0.020, 0.008, 0.011]];
  // head rings in head half-heights: yn, rx, zf, zb
  const HEAD = [[-1.00, 0.06, 0.22, 0.10], [-0.94, 0.22, 0.42, 0.18], [-0.82, 0.36, 0.52, 0.30], [-0.66, 0.46, 0.58, 0.42], [-0.48, 0.54, 0.62, 0.56], [-0.30, 0.60, 0.64, 0.70],
    [-0.12, 0.64, 0.64, 0.80], [0.06, 0.66, 0.62, 0.86], [0.24, 0.67, 0.60, 0.90], [0.42, 0.65, 0.56, 0.90], [0.60, 0.59, 0.49, 0.84], [0.76, 0.49, 0.40, 0.70],
    [0.89, 0.34, 0.28, 0.50], [0.97, 0.17, 0.14, 0.26], [1.00, 0.02, 0.02, 0.04]];
  const SKULL = [[-0.52, 0.30, 0.40, 0.20], [-0.40, 0.44, 0.48, 0.44], [-0.22, 0.60, 0.54, 0.66], [-0.04, 0.66, 0.56, 0.82], [0.18, 0.69, 0.56, 0.90], [0.40, 0.68, 0.52, 0.92],
    [0.60, 0.61, 0.45, 0.86], [0.78, 0.50, 0.36, 0.70], [0.91, 0.32, 0.22, 0.46], [0.98, 0.14, 0.10, 0.20], [1.00, 0.02, 0.02, 0.03]];
  function interp(tab, n) {   // Catmull-Rom resample of a ring table
    const out = [];
    for (let k = 0; k < n; k++) {
      const u = k / (n - 1) * (tab.length - 1), i = Math.min(tab.length - 2, Math.floor(u)), t = u - i;
      const p0 = tab[Math.max(0, i - 1)], p1 = tab[i], p2 = tab[i + 1], p3 = tab[Math.min(tab.length - 1, i + 2)];
      out.push(p1.map((_, c) => 0.5 * ((2 * p1[c]) + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t * t + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t * t * t)));
    }
    return out;
  }
  const HEAD_I = interp(HEAD, 21), SKULL_I = interp(SKULL, 15);

  function joints(S) {
    const h = S.height, f = S.fem, W = S.bulk, M = S.muscle;
    const shX = h * (f ? 0.092 : 0.106) * (0.86 + 0.14 * W) * (1 + 0.05 * M), hipX = h * (f ? 0.056 : 0.05) * (0.92 + 0.08 * W);
    const J = { hips: [0, 0.53 * h, 0], spine: [0, 0.6 * h, 0], head: [0, 0.852 * h, 0.004 * h], cape: [0, 0.8 * h, -0.075 * h] };
    const hy = h / 15; J.hc = [0, h - hy, 0.016 * h]; J.hy = hy; J.jaw = [0, J.hc[1] - 0.42 * hy, J.hc[2] - 0.05 * hy];
    [['L', 1], ['R', -1]].forEach(([n, s]) => {
      J['sh' + n] = [s * shX, 0.806 * h, -0.004 * h]; J['el' + n] = [s * (shX + 0.004 * h), 0.622 * h, -0.006 * h];
      J['ha' + n] = [s * (shX + 0.006 * h), 0.468 * h, 0]; J['wp' + n] = [s * (shX + 0.004 * h), 0.43 * h, 0.012 * h];
      J['hip' + n] = [s * hipX, 0.51 * h, 0]; J['kn' + n] = [s * hipX * 0.92, 0.286 * h, 0.006 * h]; J['ft' + n] = [s * hipX * 0.9, 0.048 * h, -0.004 * h];
    });
    return J;
  }
  const BONES = [['hips', null], ['spine', 'hips'], ['head', 'spine'], ['jaw', 'head'], ['cape', 'spine'],
    ['shL', 'spine'], ['elL', 'shL'], ['haL', 'elL'], ['wpL', 'haL'], ['shR', 'spine'], ['elR', 'shR'], ['haR', 'elR'], ['wpR', 'haR'],
    ['hipL', 'hips'], ['knL', 'hipL'], ['ftL', 'knL'], ['hipR', 'hips'], ['knR', 'hipR'], ['ftR', 'knR']];

  // Torso envelope at height y (absolute), from the built torso rings.
  function env(S, y) {
    const R = S._torso;
    if (y <= R[0].y) return R[0];
    for (let i = 0; i < R.length - 1; i++) if (y <= R[i + 1].y) { const k = (y - R[i].y) / (R[i + 1].y - R[i].y); return { y, rx: lerp(R[i].rx, R[i + 1].rx, k), f: lerp(R[i].f, R[i + 1].f, k), b: lerp(R[i].b, R[i + 1].b, k), n: lerp(R[i].n, R[i + 1].n, k) }; }
    return R[R.length - 1];
  }
  const wTorso = h => wChain([['hips'], ['spine', 0.585 * h, 0.625 * h]]);

  // ── Body: head, neck, torso, arms, hands, legs, feet ────────────────────────
  function body(P, S, J) {
    const h = S.height, f = S.fem, M = S.muscle, W = S.bulk, Bl = S.belly, Z = S.z;
    const Wd = 0.92 + 0.08 * W;
    S._torso = (f ? TORSO_F : TORSO_M).map(([y, rx, zf, zb]) => {
      let RX = rx * h * W, F = zf * h * Wd, B = zb * h * Wd;
      const ch = gauss(y - 0.72, 0.06);
      if (f) { RX *= 1 + 0.08 * M * ch; F *= 1 + 0.12 * M * ch; }
      else { RX *= 1 + 0.09 * M * ch; F *= 1 + 0.04 * M * sstep(0.62, 0.7, y) * sstep(0.83, 0.76, y); B *= 1 + 0.06 * M * ch; }
      const bel = gauss(y - 0.605, 0.045); F += Bl * 0.078 * h * bel; RX += Bl * 0.022 * h * gauss(y - 0.6, 0.06); B += Bl * 0.012 * h * bel;
      return { y: y * h, rx: RX, f: F, b: B, n: !f && y > 0.64 && y < 0.8 ? 2.9 : 2.3, s: y < 0.598 ? Z.pelvis : y > 0.824 ? SLOT.skin : Z.torso };
    });
    if (S.skeleton) { skeleton(P, S, J); return; }
    loft(P, S._torso, { seg: 14, w: wTorso(h) });
    const nk = (f ? 0.86 : 1) * (1 + 0.18 * M);
    loft(P, [{ y: 0.80 * h, rx: 0.040 * h * nk, f: 0.036 * h * nk, b: 0.040 * h * nk, z: -0.004 * h }, { y: 0.84 * h, rx: 0.034 * h * nk, f: 0.031 * h * nk, b: 0.034 * h * nk },
      { y: 0.878 * h, rx: 0.031 * h * nk, f: 0.028 * h * nk, b: 0.030 * h * nk, z: 0.004 * h }], { seg: 10, s: Z.neck, caps: false, w: wChain([['spine'], ['head', 0.842 * h, 0.866 * h]]) });
    [['L', 1], ['R', -1]].forEach(([n, s]) => {
      const sh = J['sh' + n], el = J['el' + n], ha = J['ha' + n], mk = (f ? 0.8 : 1) * Math.sqrt(W), mu = 0.8 + 0.4 * M;
      loft(P, ARM.map(([dy, r, zf, zb]) => {
        const y = sh[1] + dy * h, t = clamp((sh[1] - y) / (sh[1] - ha[1]), 0, 1), m = (dy < 0.01 && dy > -0.3 ? mu : 1) * mk;
        return { y, x: lerp(sh[0], ha[0], t), z: lerp(sh[2], ha[2], t), rx: r * h * m, f: zf * h * m, b: zb * h * m, s: Z.arm(dy) };
      }), { seg: 10, w: wChain([['sh' + n], ['el' + n, el[1] + 0.014 * h, el[1] - 0.014 * h]]) });
      const hk = f ? 0.88 : 1;
      loft(P, HAND.map(([dy, rx, zf, zb]) => ({ y: ha[1] + dy * h * hk, x: ha[0] - s * 0.012 * h * sstep(-0.05, -0.1, dy), z: ha[2] + 0.004 * h * sstep(-0.04, -0.1, dy), rx: rx * h * hk, f: zf * h * hk, b: zb * h * hk })),
        { seg: 8, s: Z.hand, w: 'ha' + n });
      tube(P, [[ha[0] - s * 0.008 * h, ha[1] - 0.012 * h, ha[2] + 0.016 * h], [ha[0] - s * 0.012 * h, ha[1] - 0.034 * h, ha[2] + 0.026 * h], [ha[0] - s * 0.016 * h, ha[1] - 0.052 * h, ha[2] + 0.03 * h]],
        [0.009 * h * hk, 0.008 * h * hk, 0.006 * h * hk], { seg: 6, s: Z.hand, w: 'ha' + n, dome: 0.004 * h });
      const hip = J['hip' + n], kn = J['kn' + n], ft = J['ft' + n], lk = (0.9 + 0.1 * W) * (1 + 0.1 * M);
      loft(P, LEG.map(([dy, rx, zf, zb]) => {
        const y = hip[1] + dy * h, x = y > kn[1] ? lerp(kn[0], hip[0] * 1.04, (y - kn[1]) / (hip[1] + 0.04 * h - kn[1])) : lerp(ft[0], kn[0], (y - ft[1]) / (kn[1] - ft[1]));
        const fw = f && dy > -0.2 ? 1.08 : 1;
        return { y, x, z: 0, rx: rx * h * lk * fw, f: zf * h * lk, b: zb * h * lk * fw, s: Z.leg(dy) };
      }), { seg: 10, w: wChain([['hips'], ['hip' + n, hip[1] + 0.035 * h, hip[1] - 0.02 * h], ['kn' + n, kn[1] + 0.014 * h, kn[1] - 0.014 * h]]) });
      foot(P, S, J, n, s);
    });
    head(P, S, J);
  }
  function foot(P, S, J, n, s) {
    const h = S.height, ft = J['ft' + n], k = S.fem ? 0.9 : 1, Z = S.z, big = Z.foot === SLOT.boots || Z.foot === SLOT.metal ? 1.12 : 1;
    loft(P, FOOT.map(([z, y, rx, up, dn]) => ({ z: ft[2] + z * h * k * big, x: ft[0] + s * 0.004 * h * (z > 0.05 ? 1 : 0), y: y * h * big, rx: rx * h * k * big, f: up * h * big, b: Math.min(dn * h * big, y * h * big) })),
      { axis: 'z', seg: 10, s: Z.foot, w: 'ft' + n });
    if (Z.shaft) {
      const kn = J['kn' + n], top = Z.shaft * h;
      loft(P, [{ y: 0.03 * h, rx: 0.036 * h, f: 0.04 * h, b: 0.036 * h }, { y: 0.07 * h, rx: 0.034 * h, f: 0.034 * h, b: 0.036 * h }, { y: top - 0.03 * h, rx: 0.045 * h, f: 0.041 * h, b: 0.056 * h },
        { y: top, rx: 0.05 * h, f: 0.046 * h, b: 0.06 * h, s: Z.cuff != null ? Z.cuff : Z.foot }, { y: top + 0.012 * h, rx: 0.05 * h, f: 0.046 * h, b: 0.06 * h }].map(r => Object.assign(r, { x: lerp(ft[0], kn[0], (r.y - ft[1]) / (kn[1] - ft[1])) })),
      { seg: 10, s: Z.foot, cap0: false, w: wChain([['ft' + n], ['kn' + n, ft[1] + 0.03 * h, ft[1] + 0.05 * h]]) });
    }
  }

  // ── Head: sculpted rings + face UVs, ears, hair, beard, headgear ────────────
  function headPoint(S, J, yn, a, grow, tab) {
    const hy = J.hy, t = tab || HEAD_I, f = S.fem;
    let i = 0; while (i < t.length - 2 && t[i + 1][0] < yn) i++;
    const r0 = t[i], r1 = t[i + 1], k = clamp((yn - r0[0]) / (r1[0] - r0[0]), 0, 1);
    let rx = lerp(r0[1], r1[1], k), zf = lerp(r0[2], r1[2], k), zb = lerp(r0[3], r1[3], k);
    if (yn < -0.35) { rx *= f ? 0.9 : 1.05; zf *= f ? 0.95 : 1.02; }
    const sa = Math.sin(a), ca = Math.cos(a);
    let x = rx * sa, z = (ca >= 0 ? zf : zb) * ca;
    x *= 1 + grow; z *= 1 + grow; z += sgn(ca) * grow * 0.25;
    return [x * hy, (yn * (1 + grow * 0.6)) * hy, z * hy];
  }
  function head(P, S, J) {
    const hy = J.hy, hc = J.hc, f = S.fem, Z = S.z;
    if (S.skeleton) { skullHead(P, S, J); return; }
    const nose = f ? 0.14 : 0.2 + S.rnd() * 0.05, brow = f ? 0.02 : 0.06 + 0.03 * S.muscle, chin = f ? 0.02 : 0.05;
    const g = loft(P, HEAD_I.map(([yn]) => ({ y: yn, rx: 1 })), {
      seg: 22, s: SLOT.skin, w: 'head', caps: false,
      fx: (p, a, i) => {
        const yn = HEAD_I[i][0]; const q = headPoint(S, J, yn, a, 0);
        const xn = q[0] / hy; let dz = 0, dx = 0;
        const fw = sstep(0.15, 0.7, Math.cos(a));
        dz += fw * nose * gauss(xn, 0.09 + 0.05 * gauss(yn + 0.32, 0.06)) * (gauss(yn + 0.27, 0.12) + 0.4 * gauss(yn + 0.02, 0.14)) * (yn > -0.42 ? 1 : 0.3);
        dz += fw * brow * gauss(yn - 0.23, 0.07);
        dz -= fw * 0.08 * gauss(Math.abs(xn) - 0.3, 0.12) * gauss(yn - 0.07, 0.09);
        dz += fw * 0.04 * gauss(xn, 0.2) * gauss(yn + 0.6, 0.07);
        dz += fw * chin * gauss(xn, 0.22) * gauss(yn + 0.88, 0.08);
        dx += sgn(xn) * (f ? 0.015 : 0.03) * gauss(yn + 0.08, 0.12) * sstep(0.2, 0.6, Math.abs(xn));
        return [hc[0] + q[0] + dx * hy, hc[1] + q[1], hc[2] + q[2] + dz * hy];
      },
    });
    const n = g.pos.length / 3; g.uv = [];
    for (let i = 0; i < n; i++) {
      const x = g.pos[i * 3], y = g.pos[i * 3 + 1], z = g.pos[i * 3 + 2];
      const front = z - hc[2] > 0.1 * hy, u = front ? 0.5 + x / (1.4 * hy) : (x < 0 ? 0 : 1);
      g.uv.push(clamp(u, 0, 1), clamp(0.5 + (y - hc[1]) / (2 * hy), 0, 1));
    }
    // ears
    [1, -1].forEach(s => ell(P, [hc[0] + s * 0.62 * hy, hc[1] - 0.04 * hy, hc[2] - 0.08 * hy], [0.07 * hy, 0.2 * hy, 0.13 * hy], { s: SLOT.skin, w: 'head', r: [0, s * 0.35, s * 0.15], rows: 5, seg: 8 }));
    hair(P, S, J);
    beard(P, S, J);
    headgear(P, S, J);
  }
  // A shell over the head; hide(yn, a) pushes a vertex inside the skull (a clean hairline).
  function headShell(P, S, J, y0, y1, grow, hide, o) {
    const hy = J.hy, hc = J.hc, rows = o.rows || 14, rings = [];
    for (let k = 0; k <= rows; k++) rings.push({ y: lerp(y0, y1, k / rows), rx: 1 });
    return loft(P, rings, Object.assign({ seg: 20, caps: false, w: 'head' }, o, {
      fx: (p, a, i) => {
        const yn = rings[i].y, hid = hide && hide(yn, a);
        const q = headPoint(S, J, yn, a, hid ? -0.12 : grow, o.tab);
        let extra = o.shape ? o.shape(yn, a) : [0, 0, 0];
        if (hid) extra = [0, 0, 0];
        return [hc[0] + q[0] + extra[0] * hy, hc[1] + q[1] + extra[1] * hy, hc[2] + q[2] + extra[2] * hy];
      },
    }));
  }
  function hairLine(front, side, back) {
    return (yn, a) => { const c = Math.cos(a); const lim = c > 0 ? lerp(side, front, sstep(0.25, 0.85, c)) : lerp(side, back, sstep(0, -0.8, c)); return yn < lim; };
  }
  function hair(P, S, J) {
    const st = S.hair, hy = J.hy, hc = J.hc, hs = SLOT.hair, fem = S.fem;
    if (st === 'bald' || st === 'none' || S.hood || S.helm === 'greathelm') return;
    if (st === 'fringe') { headShell(P, S, J, -0.35, 0.3, 0.07, (yn, a) => Math.cos(a) > -0.1 || yn > 0.25 - 0.3 * Math.abs(Math.cos(a)), { s: hs, rows: 5 }); return; }
    const low = st === 'short' || st === 'kerchief' ? -0.55 : -0.8;
    headShell(P, S, J, low, 1.0, 0.06, hairLine(fem ? 0.52 : 0.58, fem ? -0.25 : 0.08, low + 0.02), { s: hs });
    if (st === 'long') {
      const top = J.hc[1] - 0.4 * hy, bot = fem ? 0.7 * S.height : 0.76 * S.height;
      sheet(P, (u, v) => { const a = PI + lerp(-1.25, 1.25, u), y = lerp(top, bot, v), r = lerp(0.72, 0.95, v) * hy * (fem ? 1 : 1.1);
        return [Math.sin(a) * r * (fem ? 1.25 : 1.35), y, hc[2] + Math.cos(a) * r * 0.9 - 0.12 * hy - v * 0.35 * hy]; }, 6, 5, 0.05 * hy,
      { s: hs, w: wChain([['head'], ['spine', J.head[1] + 0.01 * S.height, J.head[1] - 0.03 * S.height]]) });
    } else if (st === 'braid') {
      const pts = []; for (let i = 0; i <= 10; i++) { const k = i / 10; pts.push([Math.sin(k * 2) * 0.05 * hy, hc[1] - 0.2 * hy - k * 0.2 * S.height, hc[2] - 0.92 * hy - k * 0.03 * S.height]); }
      tube(P, pts, k => (0.13 + 0.05 * Math.abs(Math.sin(k * 40))) * hy * (1 - k * 0.45), { s: hs, seg: 6, w: wChain([['head'], ['spine', J.head[1] + 0.01 * S.height, J.head[1] - 0.03 * S.height]]) });
      ell(P, [0, hc[1] - 0.2 * hy - 0.2 * S.height - 0.02 * hy, hc[2] - 0.92 * hy - 0.03 * S.height], [0.1 * hy, 0.14 * hy, 0.1 * hy], { s: SLOT.accent, w: 'spine', rows: 4, seg: 6 });
    } else if (st === 'bun') {
      ell(P, [0, hc[1] + 0.3 * hy, hc[2] - 0.95 * hy], [0.3 * hy, 0.28 * hy, 0.28 * hy], { s: hs, w: 'head', rows: 5, seg: 8 });
    } else if (st === 'topknot') {
      tube(P, [[0, hc[1] + 0.85 * hy, hc[2] - 0.4 * hy], [0, hc[1] + 1.25 * hy, hc[2] - 0.7 * hy], [0, hc[1] + 1.1 * hy, hc[2] - 1.2 * hy], [0, hc[1] + 0.6 * hy, hc[2] - 1.4 * hy]], k => (0.2 - k * 0.12) * hy, { s: hs, w: 'head' });
    }
  }
  function beard(P, S, J) {
    const st = S.beard, hy = J.hy, hc = J.hc, bs = S.z.beard != null ? S.z.beard : SLOT.hair;
    if (!st || st === 'none' || st === 'stubble' || S.fem) return;
    const moustache = () => {
      const zf = headPoint(S, J, -0.5, 0, 0)[2] / hy;
      tube(P, [[-0.34, -0.66, zf - 0.12], [-0.2, -0.52, zf + 0.04], [0, -0.47, zf + 0.08], [0.2, -0.52, zf + 0.04], [0.34, -0.66, zf - 0.12]].map(p => [hc[0] + p[0] * hy, hc[1] + p[1] * hy, hc[2] + p[2] * hy]),
        k => (0.05 + 0.03 * Math.sin(k * PI)) * hy, { s: bs, w: 'head', seg: 6 });
    };
    if (st === 'moustache') { moustache(); return; }
    const thick = st === 'short' ? 0.05 : st === 'goatee' ? 0.07 : 0.1, len = st === 'long' ? 0.55 : st === 'full' ? 0.25 : st === 'goatee' ? 0.18 : 0.06;
    const vis = st === 'goatee' ? (yn, a) => Math.cos(a) > 0.72 && yn < -0.62 : (yn, a) => Math.cos(a) > -0.2 && yn < lerp(-0.12, -0.52, sstep(0.3, 0.9, Math.cos(a))) && !(Math.abs(Math.sin(a)) < 0.2 && yn > -0.7 && yn < -0.56 && st !== 'long');
    headShell(P, S, J, -1.0, -0.1, thick, (yn, a) => !vis(yn, a), {
      s: bs, rows: 10,
      shape: (yn, a) => { const k = sstep(-0.6, -1.0, yn) * sstep(0.2, 0.9, Math.cos(a)); return [0, -len * k, len * 0.35 * k]; },
    });
    if (st !== 'goatee') moustache();
  }
  function headgear(P, S, J) {
    const hy = J.hy, hc = J.hc, h = S.height, g = S.helm, hood = S.hood;
    if (hood) {
      const hs = S.z.hood;
      const open = (yn, a) => Math.cos(a) > 0.32 && yn < 0.5 && yn > -1.05;
      headShell(P, S, J, -1.0, 1.0, 0.34, open, {
        s: hs, rows: 12,
        shv: (a, i) => { const yn = lerp(-1.0, 1.0, i / 12); return open(yn, a) ? 0.2 : Math.cos(a) > 0.1 && yn < 0.62 && yn > -1.1 ? 0.7 : 1; },
        shape: (yn, a) => { const back = sstep(0.1, -0.9, Math.cos(a)); return [0, 0.16 * sstep(0.4, 1, yn), -0.45 * back * sstep(0.2, 1, yn) - 0.1 * back]; },
      });
      loft(P, [{ y: 0.765 * h, rx: J.shL[0] + 0.035 * h, f: 0.085 * h, b: 0.095 * h }, { y: 0.8 * h, rx: J.shL[0] + 0.01 * h, f: 0.08 * h, b: 0.09 * h },
        { y: 0.835 * h, rx: 0.075 * h, f: 0.068 * h, b: 0.08 * h, z: -0.004 * h }, { y: 0.865 * h, rx: 0.058 * h, f: 0.05 * h, b: 0.07 * h, z: -0.01 * h }],
      { seg: 14, s: hs, caps: false, w: wChain([['spine'], ['head', 0.84 * h, 0.87 * h]]) });
    }
    if (g === 'kettle' || g === 'horned' || g === 'bonehelm') {
      const sl = g === 'bonehelm' ? SLOT.iron : SLOT.iron;
      headShell(P, S, J, 0.2, 1.0, 0.13, null, { s: sl, rows: 7, tab: S.skeleton ? SKULL_I : null, shape: () => [0, 0.06, 0] });
      loft(P, [{ y: hc[1] + 0.22 * hy, rx: 0.8 * hy, f: 0.78 * hy, b: 1.02 * hy, z: hc[2] - 0.12 * hy }, { y: hc[1] + 0.28 * hy, rx: 0.8 * hy, f: 0.78 * hy, b: 1.02 * hy, z: hc[2] - 0.12 * hy }],
        { seg: 16, s: SLOT.metal, caps: false, w: 'head' });
      if (g === 'kettle') {
        sheet(P, (u, v) => { const a = u * TAU, r = lerp(0.82, 1.32, v); return [hc[0] + Math.sin(a) * r * hy, hc[1] + (0.26 - 0.2 * v * v) * hy, hc[2] - 0.1 * hy + Math.cos(a) * r * hy * 1.08]; }, 16, 2, 0.04 * hy, { s: SLOT.iron, w: 'head' });
      } else {
        const hk = S.hornScale || 1;
        if (g === 'horned') box(P, [hc[0], hc[1] + 0.05 * hy, hc[2] + 0.72 * hy], [0.1 * hy, 0.55 * hy, 0.08 * hy], { s: SLOT.iron, w: 'head' });
        [1, -1].forEach(s => {
          if (g === 'horned') tube(P, [[0.62, 0.5, 0], [0.95, 0.62, 0.05], [1.2 + 0.25 * (hk - 1), 0.95 + 0.2 * (hk - 1), 0.12], [1.28 + 0.4 * (hk - 1), 1.45 + 0.5 * (hk - 1), 0.02]].map(p => [hc[0] + s * p[0] * hy, hc[1] + p[1] * hy, hc[2] + p[2] * hy]),
            k => (0.17 * Math.sqrt(hk) - k * 0.15 * Math.sqrt(hk) + 0.008) * hy, { s: SLOT.bone, w: 'head', seg: 7 });
          else tube(P, [[0.55, 0.55, -0.1], [0.9, 1.0, -0.25], [1.05, 1.6, -0.45]].map(p => [hc[0] + s * p[0] * hy, hc[1] + p[1] * hy, hc[2] + p[2] * hy]), k => (0.14 - k * 0.13) * hy, { s: SLOT.metal, w: 'head', seg: 6 });
        });
        if (g === 'bonehelm') sheet(P, (u, v) => { const a = lerp(-0.9, 2.6, u); return [hc[0], hc[1] + (0.7 + Math.cos(a) * 0.35 + v * 0.55) * hy, hc[2] + (Math.sin(a) * -0.75 + 0.2) * hy]; }, 8, 1, 0.06 * hy, { s: SLOT.accent, w: 'head' });
      }
    } else if (g === 'greathelm') {
      const rings = [];
      [[-1.08, 0.64, 0.66, 0.78], [-0.6, 0.72, 0.8, 0.86], [0.1, 0.76, 0.84, 0.94], [0.7, 0.76, 0.8, 0.94], [1.06, 0.72, 0.74, 0.88], [1.1, 0.4, 0.4, 0.5]].forEach(([yn, rx, zf, zb]) => rings.push({ y: hc[1] + yn * hy, rx: rx * hy, f: zf * hy, b: zb * hy, z: hc[2] - 0.05 * hy, n: 2.6, s: SLOT.metal }));
      loft(P, rings, { seg: 16, w: 'head', cap0: false });
      box(P, [hc[0], hc[1] + 0.08 * hy, hc[2] + 0.8 * hy], [1.2 * hy, 0.09 * hy, 0.12 * hy], { s: SLOT.dark, w: 'head' });
      box(P, [hc[0], hc[1] - 0.25 * hy, hc[2] + 0.84 * hy], [0.08 * hy, 0.9 * hy, 0.06 * hy], { s: SLOT.trim, w: 'head' });
      box(P, [hc[0], hc[1] + 0.3 * hy, hc[2] + 0.83 * hy], [0.9 * hy, 0.07 * hy, 0.06 * hy], { s: SLOT.trim, w: 'head' });
      for (let i = 0; i < 3; i++) [1, -1].forEach(s => box(P, [hc[0] + s * 0.3 * hy, hc[1] - (0.3 + i * 0.16) * hy, hc[2] + 0.84 * hy], [0.12 * hy, 0.05 * hy, 0.06 * hy], { s: SLOT.dark, w: 'head' }));
    } else if (g === 'hat') {
      sheet(P, (u, v) => { const a = u * TAU, r = lerp(0.8, 1.6, v); return [hc[0] + Math.sin(a) * r * hy, hc[1] + (0.42 + 0.14 * v * v * (1 + Math.cos(a))) * hy, hc[2] - 0.1 * hy + Math.cos(a) * r * hy]; }, 18, 2, 0.05 * hy, { s: SLOT.cloth, w: 'head' });
      ell(P, [hc[0], hc[1] + 0.72 * hy, hc[2] - 0.12 * hy], [0.78 * hy, 0.52 * hy, 0.86 * hy], { s: SLOT.cloth, w: 'head', rows: 6, seg: 14 });
      loft(P, [{ y: hc[1] + 0.44 * hy, rx: 0.8 * hy, f: 0.82 * hy, b: 0.88 * hy, z: hc[2] - 0.12 * hy }, { y: hc[1] + 0.6 * hy, rx: 0.8 * hy, f: 0.82 * hy, b: 0.88 * hy, z: hc[2] - 0.12 * hy }], { seg: 14, s: SLOT.accent, caps: false, w: 'head' });
      tube(P, [[0.5, 0.6, -0.5], [0.9, 1.0, -0.9], [1.1, 1.6, -1.2]].map(p => [hc[0] + p[0] * hy, hc[1] + p[1] * hy, hc[2] + p[2] * hy]), k => (0.08 - 0.07 * k) * hy, { s: SLOT.trim, w: 'head', flat: 0.3, seg: 5 });
    } else if (g === 'beret') {
      ell(P, [hc[0] + 0.12 * hy, hc[1] + 0.72 * hy, hc[2] - 0.05 * hy], [0.92 * hy, 0.3 * hy, 0.92 * hy], { s: SLOT.cloth, w: 'head', rows: 5, seg: 14, r: [0, 0, -0.25] });
      tube(P, [[-0.5, 0.75, 0.1], [-0.9, 1.1, -0.3], [-1.1, 1.5, -0.9], [-1.0, 1.7, -1.4]].map(p => [hc[0] + p[0] * hy, hc[1] + p[1] * hy, hc[2] + p[2] * hy]), k => (0.1 - 0.08 * k) * hy, { s: SLOT.accent, w: 'head', flat: 0.25, seg: 5 });
    } else if (g === 'kerchief') {
      headShell(P, S, J, -0.62, 1.0, 0.1, hairLine(0.62, -0.3, -0.6), { s: SLOT.cloth });
      ell(P, [hc[0], hc[1] - 0.45 * hy, hc[2] - 0.9 * hy], [0.2 * hy, 0.16 * hy, 0.14 * hy], { s: SLOT.cloth, w: 'head', rows: 4, seg: 6 });
    }
  }
  function skullHead(P, S, J) {
    const hy = J.hy, hc = J.hc, jw = J.jaw;
    const g = loft(P, SKULL_I.map(([yn]) => ({ y: yn, rx: 1 })), {
      seg: 20, s: SLOT.bone, w: 'head', caps: false,
      fx: (p, a, i) => {
        const yn = SKULL_I[i][0], q = headPoint(S, J, yn, a, 0, SKULL_I), xn = q[0] / hy, fw = sstep(0.15, 0.7, Math.cos(a));
        let dz = fw * 0.07 * gauss(yn - 0.25, 0.07) - fw * 0.12 * gauss(Math.abs(xn) - 0.28, 0.12) * gauss(yn - 0.02, 0.12);
        dz -= 0.08 * gauss(yn + 0.3, 0.1) * sstep(0.3, 0.55, Math.abs(xn));
        return [hc[0] + q[0], hc[1] + q[1], hc[2] + q[2] + dz * hy];
      },
    });
    g.uv = null;
    const zf = headPoint(S, J, 0.02, 0, 0, SKULL_I)[2];
    [1, -1].forEach(s => {
      ell(P, [hc[0] + s * 0.28 * hy, hc[1] + 0.02 * hy, hc[2] + zf - 0.14 * hy], [0.21 * hy, 0.18 * hy, 0.12 * hy], { s: SLOT.dark, w: 'head', rows: 4, seg: 8 });
      ell(P, [hc[0] + s * 0.27 * hy, hc[1] + 0.02 * hy, hc[2] + zf - 0.06 * hy], [0.08 * hy, 0.05 * hy, 0.04 * hy], { s: SLOT.glow, w: 'head', rows: 3, seg: 6 });
    });
    ell(P, [hc[0], hc[1] - 0.26 * hy, hc[2] + zf - 0.06 * hy], [0.08 * hy, 0.12 * hy, 0.06 * hy], { s: SLOT.dark, w: 'head', rows: 3, seg: 6 });
    const tz = headPoint(S, J, -0.5, 0, 0, SKULL_I)[2];
    for (let i = 0; i < 7; i++) { const a = (i - 3) * 0.22; box(P, [hc[0] + Math.sin(a) * 0.36 * hy, hc[1] - 0.57 * hy, hc[2] + Math.cos(a) * tz * 0.98], [0.1 * hy, 0.16 * hy, 0.07 * hy], { s: SLOT.bone, sh: 1.15, w: 'head', r: [0, a, 0] }); }
    const J2 = p => [jw[0] + p[0] * hy, jw[1] + p[1] * hy, jw[2] + p[2] * hy];
    tube(P, [[0.56, 0.3, -0.35], [0.52, -0.2, -0.1], [0.4, -0.45, 0.3], [0.18, -0.55, 0.55], [0, -0.58, 0.6], [-0.18, -0.55, 0.55], [-0.4, -0.45, 0.3], [-0.52, -0.2, -0.1], [-0.56, 0.3, -0.35]].map(J2),
      0.1 * hy, { s: SLOT.bone, w: 'jaw', flat: 0.7, seg: 6 });
    for (let i = 0; i < 6; i++) { const a = (i - 2.5) * 0.24; box(P, J2([Math.sin(a) * 0.4, -0.3, 0.5 * Math.cos(a) + 0.02]), [0.1 * hy, 0.15 * hy, 0.07 * hy], { s: SLOT.bone, sh: 1.15, w: 'jaw', r: [0, a, 0] }); }
    headgear(P, S, J);
  }

  // ── Undead: a skeleton body under the armour ────────────────────────────────
  function skeleton(P, S, J) {
    const h = S.height, B = SLOT.bone, t = 0.011 * h;
    ell(P, [0, 0.525 * h, -0.005 * h], [0.1 * h, 0.05 * h, 0.06 * h], { s: B, w: 'hips', rows: 5, seg: 10 });
    const col = []; for (let i = 0; i <= 8; i++) col.push([0, lerp(0.53, 0.84, i / 8) * h, -0.045 * h + Math.sin(i / 8 * PI) * 0.012 * h]);
    tube(P, col, 0.013 * h, { s: SLOT.bone, sh: 0.85, w: wTorso(h) });
    for (let i = 0; i < 9; i++) ell(P, col[i], [0.02 * h, 0.012 * h, 0.018 * h], { s: B, w: wTorso(h), rows: 3, seg: 6 });
    for (let i = 0; i < 6; i++) {
      const y = (0.785 - i * 0.03) * h, rx = (0.085 + Math.sin((i + 1) / 7 * PI) * 0.03) * h, pts = [];
      for (let k = 0; k <= 12; k++) { const a = lerp(0.35, TAU - 0.35, k / 12); pts.push([Math.sin(a) * rx, y - Math.cos(a) * 0.012 * h - 0.01 * h, -Math.cos(a) * 0.065 * h + 0.012 * h]); }
      tube(P, pts, 0.0075 * h, { s: B, w: 'spine', seg: 5, flat: 0.6 });
    }
    box(P, [0, 0.74 * h, 0.075 * h], [0.022 * h, 0.1 * h, 0.012 * h], { s: B, w: 'spine' });
    [['L', 1], ['R', -1]].forEach(([n, s]) => {
      tube(P, [[0, 0.8 * h, 0.05 * h], J['sh' + n]], 0.009 * h, { s: B, w: 'spine', seg: 5 });
      const sh = J['sh' + n], el = J['el' + n], ha = J['ha' + n], hip = J['hip' + n], kn = J['kn' + n], ft = J['ft' + n];
      tube(P, [sh, el], t * 1.1, { s: B, w: 'sh' + n, seg: 6 }); ell(P, sh, [0.024 * h, 0.024 * h, 0.024 * h], { s: B, w: 'sh' + n, rows: 4, seg: 7 });
      ell(P, el, [0.018 * h, 0.018 * h, 0.018 * h], { s: B, w: 'el' + n, rows: 3, seg: 6 });
      tube(P, [add3(el, [s * 0.006 * h, 0, 0]), add3(ha, [s * 0.006 * h, 0, 0])], t * 0.6, { s: B, w: 'el' + n, seg: 5 });
      tube(P, [add3(el, [-s * 0.006 * h, 0, 0]), add3(ha, [-s * 0.004 * h, 0, 0])], t * 0.55, { s: B, w: 'el' + n, seg: 5 });
      box(P, add3(ha, [0, -0.025 * h, 0]), [0.012 * h, 0.04 * h, 0.04 * h], { s: B, w: 'ha' + n });
      for (let k = 0; k < 4; k++) { const z = (k - 1.5) * 0.011 * h; tube(P, [add3(ha, [0, -0.045 * h, z]), add3(ha, [-s * 0.006 * h, -0.08 * h, z + 0.004 * h]), add3(ha, [-s * 0.014 * h, -0.095 * h, z + 0.01 * h])], 0.0045 * h, { s: B, w: 'ha' + n, seg: 4 }); }
      tube(P, [hip, kn], t * 1.3, { s: B, w: 'hip' + n, seg: 6 }); ell(P, hip, [0.028 * h, 0.028 * h, 0.028 * h], { s: B, w: 'hip' + n, rows: 4, seg: 7 });
      ell(P, add3(kn, [0, 0, 0.016 * h]), [0.022 * h, 0.024 * h, 0.018 * h], { s: B, w: 'kn' + n, rows: 4, seg: 7 });
      tube(P, [kn, ft], t * 1.05, { s: B, w: 'kn' + n, seg: 6 });
      tube(P, [add3(kn, [s * 0.012 * h, -0.02 * h, -0.005 * h]), add3(ft, [s * 0.012 * h, 0.01 * h, -0.004 * h])], t * 0.5, { s: B, w: 'kn' + n, seg: 4 });
    });
    [['L', 1], ['R', -1]].forEach(([n, s]) => foot(P, S, J, n, s));
    head(P, S, J);
  }

  // ── Outfit layers ──────────────────────────────────────────────────────────
  function shell(P, S, y0, y1, off, o) {
    o = o || {};
    const h = S.height, R = S._torso.filter(r => r.y > y0 && r.y < y1).map(r => r.y);
    const ys = [y0].concat(R, [y1]), rings = [];
    if (o.step) { rings.length = 0; for (let y = y0; y < y1 - 1e-6; y += o.step) rings.push(y); rings.push(y1); }
    (o.step ? rings.splice(0) : ys).forEach((y, i) => {
      const e = env(S, y), k = o.offFn ? o.offFn(y) : off;
      rings.push({ y, rx: e.rx + k, f: e.f + k * (o.fk || 1), b: e.b + k, n: o.n || e.n || 2.3, s: o.slotFn ? o.slotFn(y, i) : o.s, sh: o.shFn ? o.shFn(y, i) : o.sh });
    });
    return loft(P, rings, Object.assign({ seg: 14, caps: false, w: wTorso(h) }, o, { s: o.s }));
  }
  // Skirt / robe from y0 down to hem. Lower vertices lean part-way to the legs so it walks.
  function skirt(P, S, J, y0, hem, flare, o) {
    o = o || {};
    const h = S.height, rings = [], n = o.rows || 7, legR = J.hipL[0] + 0.078 * h * S.bulk;
    for (let i = 0; i <= n; i++) {
      const k = i / n, y = lerp(y0, hem, k), e = env(S, Math.max(y, 0.535 * h)), fl = flare * h * Math.pow(k, 1.3), off = (o.off || 0.008) * h;
      const rx = Math.max(e.rx + off, y < 0.53 * h ? legR : 0) + fl;
      rings.push({ y, rx, f: Math.max(e.f + off, y < 0.53 * h ? 0.075 * h : 0) + fl * 0.75, b: Math.max(e.b + off, y < 0.53 * h ? 0.08 * h : 0) + fl * 0.85, n: 2.2,
        s: o.hemSlot != null && i === n - 1 ? o.hemSlot : o.s, sh: 1 - k * 0.12 });
    }
    const top = y0, lw = o.follow != null ? o.follow : 0.5;
    const w = (x, y, z) => {
      if (y > 0.6 * h) return wTorso(h)(x, y, z);
      const k = sstep(0.52 * h, hem, y) * lw * sstep(0.01 * h, 0.07 * h, Math.abs(x));
      return [['hips', 1 - k], [x > 0 ? 'hipL' : 'hipR', k]];
    };
    return loft(P, rings, Object.assign({ seg: 16, caps: false, w, fx: o.fx }, o.a1 != null ? { a0: o.a0, a1: o.a1 } : {}, { s: o.s }));
  }
  function cape(P, S, J, top, hem, o) {
    o = o || {};
    const h = S.height, sw = J.shL[0] + 0.04 * h, span = o.span || 1.25, r = rng(S.seed + 5);
    const jag = []; for (let i = 0; i <= 10; i++) jag.push(o.jagged ? r() * o.jagged * h : 0);
    return sheet(P, (u, v) => {
      const a = PI + lerp(-span, span, u), y = lerp(top, hem, v) + (v > 0.95 ? jag[Math.round(u * 10)] : 0) * v, dr = 1 + v * (o.drape || 0.25);
      return [Math.sin(a) * sw * dr, y, -0.02 * h + Math.cos(a) * (0.085 * h * dr) - v * 0.03 * h];
    }, 10, 6, 0.008 * h, { s: o.s != null ? o.s : SLOT.cloth, w: wChain([['spine'], ['cape', top - 0.01 * h, top - 0.06 * h]]), slotFn: o.slotFn });
  }
  function belt(P, S, y, s, o) {
    o = o || {};
    const h = S.height;
    shell(P, S, y - 0.012 * h, y + 0.012 * h, (o.off || 0.012) * h, { s, seg: 14 });
    const e = env(S, y);
    if (o.buckle !== false) box(P, [0, y, e.f + (o.off || 0.012) * h + 0.004 * h], [0.03 * h, 0.022 * h, 0.008 * h], { s: SLOT.trim, w: wTorso(h) });
  }
  function strap(P, S, J, s, slot) {   // across the chest, shoulder to hip
    const h = S.height, pts = [];
    for (let i = 0; i <= 8; i++) {
      const k = i / 8, y = lerp(0.81 * h, 0.56 * h, k), x = lerp(s * 0.075 * h, -s * 0.09 * h, k), e = env(S, y);
      const zf = e.f * Math.sqrt(Math.max(0, 1 - Math.pow(x / (e.rx * 1.02), 2))) + 0.008 * h;
      pts.push([x, y, zf]);
    }
    tube(P, pts, 0.008 * h, { s: slot, w: wTorso(h), flat: 0.35, seg: 5 });
  }

  // ── Props: modelled in grip space, pointing +Z (monsters.js convention) ──────
  const PROPS = {
    hammer(P, w, at) { tube(P, [[0, 0, -0.06], [0, 0, 0.36]].map(at), 0.017, { s: SLOT.wood, w }); box(P, at([0, 0.02, 0.38]), [0.06, 0.16, 0.065], { s: SLOT.iron, w }); return 0.4; },
    spear(P, w, at) { tube(P, [[0, 0, -0.95], [0, 0, 1.28]].map(at), 0.017, { s: SLOT.wood, w }); tube(P, [[0, 0, 1.22], [0, 0, 1.32], [0, 0, 1.46], [0, 0, 1.62]].map(at), [0.022, 0.045, 0.035, 0.002], { s: SLOT.metal, w, flat: 0.28 }); tube(P, [[0, 0, 1.17], [0, 0, 1.25]].map(at), 0.024, { s: SLOT.iron, w }); return 1.6; },
    staff(P, w, at) { tube(P, [[0, 0, -0.92], [0.02, 0, 0.3], [0, 0, 0.95]].map(at), 0.019, { s: SLOT.wood, w }); ell(P, at([0, 0, 0.98]), [0.04, 0.04, 0.05], { s: SLOT.wood, w, rows: 4, seg: 7 }); return 0.95; },
    broom(P, w, at) { tube(P, [[0, 0, -0.25], [0, 0, 1.1]].map(at), 0.015, { s: SLOT.wood, w }); tube(P, [[0, 0, 1.05], [0, 0, 1.2], [0, 0, 1.42]].map(at), [0.035, 0.07, 0.1], { s: SLOT.trim, w, flat: 0.45, dome: 0.02 }); return 1.4; },
    hoe(P, w, at) { tube(P, [[0, 0, -0.25], [0, 0, 1.1]].map(at), 0.016, { s: SLOT.wood, w }); box(P, at([0, -0.08, 1.1]), [0.14, 0.18, 0.025], { s: SLOT.iron, w }); return 1.1; },
    sword(P, w, at) {
      tube(P, [[0, 0, -0.1], [0, 0, 0.08]].map(at), 0.018, { s: SLOT.leather, w }); ell(P, at([0, 0, -0.12]), [0.03, 0.03, 0.03], { s: SLOT.iron, w, rows: 4, seg: 6 });
      box(P, at([0, 0, 0.095]), [0.2, 0.026, 0.035], { s: SLOT.iron, w });
      tube(P, [[0, 0, 0.1], [0, 0, 0.5], [0, 0, 0.82], [0, 0, 0.9]].map(at), [0.028, 0.026, 0.02, 0.002], { s: SLOT.metal, w, flat: 0.2, rot: PI / 2 }); return 0.9;
    },
    greatsword(P, w, at) {
      tube(P, [[0, 0, -0.26], [0, 0, 0.08]].map(at), 0.02, { s: SLOT.leather, w }); ell(P, at([0, 0, -0.28]), [0.035, 0.035, 0.035], { s: SLOT.bone, w, rows: 4, seg: 6 });
      box(P, at([0, 0, 0.1]), [0.3, 0.035, 0.045], { s: SLOT.iron, w });
      tube(P, [[0, 0, 0.1], [0, 0, 0.7], [0, 0, 1.2], [0, 0, 1.32]].map(at), [0.042, 0.04, 0.03, 0.003], { s: SLOT.iron, w, flat: 0.2, rot: PI / 2 });
      box(P, at([0, 0, 0.7]), [0.012, 0.03, 1.05], { s: SLOT.glow, w }); return 1.3;
    },
    axe(P, w, at, big) {
      const L = big ? 0.95 : 0.66, k = big ? 1.55 : 1;
      tube(P, [[0, 0, -0.12], [0, 0, L]].map(at), 0.021 * Math.sqrt(k), { s: SLOT.wood, w });
      sheet(P, (u, v) => { const z = L - 0.06 * k + lerp(-0.07, 0.07, u) * k * (1 + v * 0.9), y = -lerp(0.02, 0.2, v) * k; return at([0, y, z]); }, 3, 3, 0.03 * k, { s: SLOT.iron, w, slotFn: (u, v) => (v > 0.8 ? SLOT.metal : SLOT.iron) });
      if (big) sheet(P, (u, v) => { const z = L - 0.06 * k + lerp(-0.06, 0.06, u) * k * (1 + v * 0.7), y = lerp(0.02, 0.15, v) * k; return at([0, y, z]); }, 3, 3, 0.03 * k, { s: SLOT.iron, w, slotFn: (u, v) => (v > 0.8 ? SLOT.metal : SLOT.iron) });
      return L;
    },
    bigaxe(P, w, at) { return PROPS.axe(P, w, at, true); },
    lantern(P, w, at) {
      tube(P, [[0, 0, 0], [0, -0.06, 0.03], [0, -0.12, 0]].map(at), 0.005, { s: SLOT.iron, w, seg: 4 });
      box(P, at([0, -0.14, 0]), [0.1, 0.02, 0.1], { s: SLOT.iron, w }); box(P, at([0, -0.32, 0]), [0.11, 0.025, 0.11], { s: SLOT.iron, w });
      ell(P, at([0, -0.23, 0]), [0.042, 0.075, 0.042], { s: SLOT.glow, w, rows: 4, seg: 6 });
      [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(([a, b]) => box(P, at([a * 0.045, -0.23, b * 0.045]), [0.012, 0.17, 0.012], { s: SLOT.iron, w }));
      tube(P, [[0, -0.13, 0], [0, -0.1, 0]].map(at), [0.05, 0.01], { s: SLOT.iron, w, seg: 6 }); return 0;
    },
    bow(P, w, at) {
      const pts = []; for (let i = 0; i <= 10; i++) { const y = lerp(-0.72, 0.72, i / 10); pts.push(at([0, y, 0.11 * (1 - Math.pow(y / 0.72, 2)) - 0.02])); }
      tube(P, pts, k => 0.016 - 0.01 * Math.abs(k - 0.5), { s: SLOT.wood, w, seg: 5 });
      tube(P, [at([0, -0.71, -0.02]), at([0, 0.71, -0.02])], 0.003, { s: SLOT.cloth, w, seg: 3 }); return 0;
    },
  };
  function props(P, S, J) {
    const h = S.height;
    [['R', S.right], ['L', S.left]].forEach(([n, id]) => {
      if (!id) return;
      const wp = J['wp' + n], w = 'wp' + n, at = p => [wp[0] + p[0], wp[1] + p[1], wp[2] + p[2]];
      if (PROPS[id]) { const L = PROPS[id](P, w, at); if (n === 'R') S._tip = L; return; }
      const el = J['el' + n], ha = J['ha' + n], s = n === 'L' ? 1 : -1, fx = el[0] + s * 0.045 * h, fy = lerp(el[1], ha[1], 0.5);
      if (id === 'shield') {
        const R = S.shieldR || 0.3;
        sheet(P, (u, v) => { const a = u * TAU, r = v * R; return [fx + s * (0.012 + 0.05 * (1 - v * v) * 1.0) * (1 + 0 * a), fy + Math.cos(a) * r, Math.sin(a) * r]; }, 18, 3, 0.02,
          { s: SLOT.wood, w: 'el' + n, slotFn: (u, v) => (v > 0.9 ? SLOT.iron : (Math.abs(Math.sin(u * TAU)) < 0.18 || Math.abs(Math.cos(u * TAU)) < 0.18) && v > 0.15 ? SLOT.accent : SLOT.wood) });
        ell(P, [fx + s * 0.06, fy, 0], [0.04, 0.055, 0.055], { s: SLOT.iron, w: 'el' + n, rows: 4, seg: 8 });
      } else if (id === 'kite') {
        sheet(P, (u, v) => { const y = lerp(0.3, -0.52, v), wd = 0.24 * (v < 0.3 ? 1 : Math.pow(1 - (v - 0.3) / 0.7, 0.8)) + 0.004; return [fx + s * (0.02 + 0.06 * Math.cos(lerp(-1.2, 1.2, u))), fy + y - 0.05, lerp(-wd, wd, u)]; }, 6, 8, 0.02,
          { s: SLOT.accent, w: 'el' + n, slotFn: (u, v) => (u < 0.1 || u > 0.9 || v < 0.06 ? SLOT.trim : Math.abs(u - 0.5) < 0.08 ? SLOT.trim : SLOT.accent) });
      } else if (id === 'tower') {
        sheet(P, (u, v) => [fx + s * (0.03 + 0.05 * Math.cos(lerp(-1.1, 1.1, u))), fy + lerp(0.36, -0.46, v), lerp(-0.23, 0.23, u)], 5, 6, 0.03,
          { s: SLOT.iron, w: 'el' + n, slotFn: (u, v) => (u < 0.12 || u > 0.88 || v < 0.08 || v > 0.92 ? SLOT.metal : Math.abs(u - 0.5) < 0.08 || Math.abs(v - 0.35) < 0.06 ? SLOT.accent : SLOT.iron) });
      } else if (id === 'lute') {
        const c = [0.02 * h, 0.64 * h, 0.13 * h];
        ell(P, c, [0.13, 0.17, 0.06], { s: SLOT.wood, w: 'spine', rows: 6, seg: 12, r: [0, 0, 0.9] });
        ell(P, [c[0] - 0.01, c[1] - 0.005, c[2] + 0.055], [0.035, 0.035, 0.01], { s: SLOT.dark, w: 'spine', rows: 3, seg: 8 });
        tube(P, [[c[0] - 0.07, c[1] + 0.07, c[2] + 0.02], [c[0] - 0.34, c[1] + 0.3, c[2] + 0.02]], 0.02, { s: SLOT.leather, w: 'spine', flat: 0.5, seg: 5 });
        box(P, [c[0] - 0.37, c[1] + 0.33, c[2] + 0.02], [0.08, 0.05, 0.03], { s: SLOT.wood, w: 'spine', r: [0, 0, 0.9] });
      }
    });
  }

  // ── Outfits ─────────────────────────────────────────────────────────────────
  function zones(S) {
    const Sl = SLOT, top = S.top;
    const torso = top === 'bare' ? Sl.skin : top === 'jerkin' ? Sl.leather : top === 'plate' ? Sl.cloth : top === 'rags' ? Sl.top : Sl.top;
    const sleeve = top === 'plate' ? Sl.metal : top === 'bare' || S.sleeves === 'none' ? Sl.skin : Sl.top;
    const sleeveEnd = S.sleeves === 'short' ? -0.1 : S.sleeves === 'none' ? 1 : -0.325;
    const legs = S.legs === 'bare' ? Sl.skin : top === 'plate' ? Sl.metal : Sl.legs;
    const foot = S.feet === 'bare' ? Sl.skin : S.feet === 'wraps' ? Sl.cloth : top === 'plate' ? Sl.metal : Sl.boots;
    const bracer = S.bracers ? Sl.leather : null;
    const Z = {
      torso, pelvis: top === 'bare' ? Sl.legs : legs === Sl.skin ? Sl.cloth : legs, neck: Sl.skin, hand: top === 'plate' ? Sl.metal : S.gloves ? Sl.leather : Sl.skin,
      arm: dy => (top === 'plate' ? Sl.metal : dy < -0.214 && dy > -0.33 && bracer != null ? bracer : dy > sleeveEnd && dy < 0.03 ? sleeve : Sl.skin),
      leg: dy => (S.feet === 'boots' && dy < -0.3 ? Sl.boots : legs),
      foot, shaft: S.feet === 'boots' ? (S.bootTop || 0.19) : 0, cuff: S.feet === 'boots' ? Sl.leather : null, hood: Sl.cloth,
    };
    if (top === 'plate') { Z.shaft = 0.16; Z.cuff = Sl.iron; Z.leg = dy => (Math.abs(dy + 0.224) < 0.02 ? Sl.iron : Sl.metal); }
    return Z;
  }
  function outfit(P, S, J) {
    const h = S.height, top = S.top, X = S.extras;
    if (top === 'tunic') { shell(P, S, 0.6 * h, 0.815 * h, 0.005 * h, { s: SLOT.top }); skirt(P, S, J, 0.6 * h, (S.hem || 0.4) * h, 0.03, { s: SLOT.top, hemSlot: SLOT.trim }); }
    else if (top === 'dress') { skirt(P, S, J, 0.6 * h, (S.hem || 0.07) * h, 0.11, { s: SLOT.top, rows: 8, follow: 0.5 }); }
    else if (top === 'robe') { shell(P, S, 0.58 * h, 0.82 * h, 0.009 * h, { s: SLOT.top }); skirt(P, S, J, 0.6 * h, (S.hem || 0.05) * h, 0.075, { s: SLOT.top, rows: 8, follow: 0.4, hemSlot: SLOT.trim }); }
    else if (top === 'rags') {
      const r = rng(S.seed + 11);
      shell(P, S, 0.58 * h, 0.815 * h, 0.006 * h, { s: SLOT.top });
      skirt(P, S, J, 0.6 * h, (S.hem || 0.3) * h, 0.04, { s: SLOT.top, rows: 6, fx: (p, a, i) => (i === 6 ? [p[0], p[1] + (r() * 0.06 - 0.01) * h, p[2]] : p) });
    } else if (top === 'jerkin') {
      shell(P, S, 0.56 * h, 0.8 * h, 0.009 * h, { s: SLOT.leather, shFn: (y, i) => (i % 3 === 1 ? 0.85 : 1) });
      skirt(P, S, J, 0.58 * h, 0.44 * h, 0.03, { s: SLOT.leather, rows: 3 });
    } else if (top === 'doublet') {
      shell(P, S, 0.56 * h, 0.815 * h, 0.009 * h, { s: SLOT.top, step: 0.022 * h, shFn: (y, i) => (i % 2 ? 0.8 : 1.04), slotFn: (y, i) => (i === 1 ? SLOT.trim : SLOT.top) });
      skirt(P, S, J, 0.575 * h, 0.5 * h, 0.03, { s: SLOT.top, rows: 2 });
      [1, -1].forEach(s => ell(P, add3(J['sh' + (s > 0 ? 'L' : 'R')], [s * 0.012 * h, -0.02 * h, 0]), [0.052 * h, 0.05 * h, 0.05 * h], { s: SLOT.top, w: 'sh' + (s > 0 ? 'L' : 'R'), rows: 5, seg: 8 }));
    } else if (top === 'gambeson') {
      shell(P, S, 0.56 * h, 0.815 * h, 0.014 * h, { s: SLOT.top, step: 0.02 * h, shFn: (y, i) => (i % 2 ? 0.78 : 1.02) });
      skirt(P, S, J, 0.58 * h, 0.38 * h, 0.04, { s: SLOT.top, rows: 5, off: 0.016, fx: null });
    } else if (top === 'plate') {
      shell(P, S, 0.585 * h, 0.8 * h, 0.018 * h, { s: SLOT.metal });
      tube(P, [[0, 0.6 * h, env(S, 0.6 * h).f + 0.02 * h], [0, 0.7 * h, env(S, 0.7 * h).f + 0.032 * h], [0, 0.78 * h, env(S, 0.78 * h).f + 0.018 * h]], 0.006 * h, { s: SLOT.metal, w: wTorso(h), seg: 5 });
      skirt(P, S, J, 0.6 * h, 0.47 * h, 0.035, { s: SLOT.metal, rows: 4, off: 0.022, follow: 0.2 });
      [['L', 1], ['R', -1]].forEach(([n, s]) => {
        const sh = J['sh' + n];
        ell(P, add3(sh, [s * 0.016 * h, 0.012 * h, 0]), [0.065 * h, 0.05 * h, 0.064 * h], { s: SLOT.metal, w: 'sh' + n, rows: 5, seg: 10, r: [0, 0, -s * 0.25] });
        ell(P, add3(sh, [s * 0.022 * h, -0.02 * h, 0]), [0.062 * h, 0.03 * h, 0.06 * h], { s: SLOT.iron, w: 'sh' + n, rows: 4, seg: 10, r: [0, 0, -s * 0.35] });
        ell(P, add3(J['el' + n], [0, 0, -0.01 * h]), [0.034 * h, 0.03 * h, 0.034 * h], { s: SLOT.iron, w: 'el' + n, rows: 4, seg: 8 });
        ell(P, add3(J['kn' + n], [0, 0.004 * h, 0.03 * h]), [0.04 * h, 0.036 * h, 0.03 * h], { s: SLOT.iron, w: 'kn' + n, rows: 4, seg: 8 });
      });
      shell(P, S, 0.795 * h, 0.83 * h, 0.012 * h, { s: SLOT.iron });
    }
    const has = k => X.indexOf(k) >= 0;
    if (has('belt')) belt(P, S, 0.6 * h, SLOT.leather);
    if (has('rope')) {
      const pts = []; const e = env(S, 0.6 * h);
      for (let i = 0; i <= 16; i++) { const a = i / 16 * TAU; pts.push([Math.sin(a) * (e.rx + 0.02 * h), 0.6 * h + Math.cos(a * 2) * 0.004 * h, Math.cos(a) * ((Math.cos(a) > 0 ? e.f : e.b) + 0.022 * h)]); }
      tube(P, pts, 0.007 * h, { s: SLOT.trim, w: wTorso(h), seg: 5, caps: false });
      tube(P, [[0.03 * h, 0.6 * h, e.f + 0.024 * h], [0.04 * h, 0.52 * h, e.f + 0.03 * h], [0.035 * h, 0.44 * h, e.f + 0.03 * h]], 0.006 * h, { s: SLOT.trim, w: 'hips', seg: 5 });
    }
    if (has('sash')) {
      belt(P, S, 0.6 * h, SLOT.accent, { off: 0.016, buckle: false });
      const e = env(S, 0.6 * h);
      sheet(P, (u, v) => [lerp(0.04, 0.085, u) * h + v * 0.01 * h, lerp(0.595, 0.43, v) * h, e.f + 0.02 * h], 1, 4, 0.006 * h, { s: SLOT.accent, w: 'hips' });
    }
    if (has('pouch')) ell(P, [-0.1 * h * S.bulk, 0.565 * h, 0.05 * h], [0.03 * h, 0.036 * h, 0.022 * h], { s: SLOT.leather, w: 'hips', rows: 4, seg: 8 });
    if (has('apron')) skirt(P, S, J, 0.61 * h, (S.hem || 0.07) * h + 0.1 * h, 0.03, { s: SLOT.cloth, rows: 5, a0: -1.15, a1: 1.15, off: S.top === 'dress' ? 0.02 : 0.014, follow: 0.3 });
    if (has('leatherApron')) {
      skirt(P, S, J, 0.6 * h, 0.2 * h, 0.03, { s: SLOT.leather, rows: 5, a0: -1.2, a1: 1.2, off: 0.016, follow: 0.15 });
      shell(P, S, 0.6 * h, 0.77 * h, 0.012 * h, { s: SLOT.leather, a0: -0.95, a1: 0.95, seg: 10 });
      [1, -1].forEach(s => tube(P, [[s * 0.07 * h, 0.77 * h, env(S, 0.77 * h).f], [s * 0.075 * h, 0.83 * h, 0.01 * h], [s * 0.07 * h, 0.8 * h, -env(S, 0.8 * h).b - 0.004 * h], [s * 0.02 * h, 0.64 * h, -env(S, 0.64 * h).b - 0.008 * h]], 0.006 * h, { s: SLOT.leather, w: 'spine', seg: 5, flat: 0.4 }));
    }
    if (has('tabard') || has('surcoat')) {
      const lo = has('surcoat') ? 0.33 : 0.4, sl = has('surcoat') ? SLOT.accent : SLOT.accent;
      (has('surcoat') ? [[-0.62, 0.62], [PI - 0.7, PI + 0.7]] : [[-0.48, 0.48], [PI - 0.55, PI + 0.55]]).forEach(([a0, a1]) => {
        shell(P, S, 0.6 * h, 0.8 * h, (top === 'plate' ? 0.032 : top === 'gambeson' ? 0.022 : 0.012) * h, { s: sl, a0, a1, seg: 8, n: 2 });
        skirt(P, S, J, 0.605 * h, lo * h, 0.02, { s: sl, rows: 4, a0, a1, off: top === 'plate' ? 0.035 : 0.026, follow: 0.25, hemSlot: SLOT.trim });
      });
      if (has('surcoat')) ell(P, [0, 0.72 * h, env(S, 0.72 * h).f + 0.04 * h], [0.035 * h, 0.04 * h, 0.006 * h], { s: SLOT.trim, w: 'spine', rows: 4, seg: 8 });
    }
    if (has('mantle') || has('bigmantle')) {
      const big = has('bigmantle') ? 1.25 : 1, r = rng(S.seed + 3), shX = J.shL[0];
      loft(P, [{ y: 0.735 * h, rx: shX + 0.035 * h * big, f: 0.08 * h * big, b: 0.095 * h * big }, { y: 0.785 * h, rx: shX + 0.058 * h * big, f: 0.088 * h * big, b: 0.104 * h * big },
        { y: 0.83 * h, rx: 0.085 * h * big, f: 0.068 * h, b: 0.085 * h * big }, { y: 0.852 * h, rx: 0.05 * h, f: 0.045 * h, b: 0.055 * h }],
      { seg: 18, s: SLOT.fur, caps: false, w: 'spine', sh: 0.8, fx: (p, a, i) => { const k = (r() - 0.35) * 0.02 * h * big * (i === 3 ? 0.3 : 1); const fr = Math.max(0, Math.cos(a)); return [p[0] + Math.sin(a) * k, p[1] + (i === 0 ? -r() * 0.03 * h * (1 - fr) + fr * fr * 0.035 * h : 0), p[2] + Math.cos(a) * k * (1 - fr * 0.7)]; } });
      for (let i = 0; i < 20; i++) {
        const a = (i + r() * 0.5) / 20 * TAU, q = r(), ring = i % 2 ? 1 : 0.8;
        if (Math.cos(a) > 0.4) continue;                                          // no clumps on the chest: shoulders and back only
        ell(P, [Math.sin(a) * (shX * 0.95 + 0.03 * h) * big * ring, (0.775 + 0.03 * (1 - ring) + q * 0.012) * h, Math.cos(a) * (0.08 * h * big * ring) - 0.012 * h],
          [0.042 * h * big * (0.8 + q * 0.5), 0.03 * h * big * (0.8 + q * 0.4), 0.036 * h * big], { s: SLOT.fur, sh: 0.7 + q * 0.45, w: 'spine', rows: 3, seg: 6, r: [q - 0.5, a, (q - 0.5) * 0.6] });
      }
    }
    if (has('cape')) cape(P, S, J, 0.8 * h, 0.1 * h, { s: SLOT.cloth, jagged: 0.06, drape: 0.35, slotFn: (u, v) => (v < 0.08 ? SLOT.accent : SLOT.cloth) });
    if (has('halfcape')) cape(P, S, J, 0.8 * h, 0.52 * h, { s: SLOT.cloth, span: 1.4, drape: 0.2, slotFn: (u, v) => (v > 0.85 ? SLOT.trim : SLOT.cloth) });
    if (has('bearskin')) cape(P, S, J, 0.81 * h, 0.2 * h, { s: SLOT.fur, span: 1.5, jagged: 0.07, drape: 0.4 });
    if (has('cloak')) cape(P, S, J, 0.8 * h, 0.12 * h, { s: SLOT.cloth, span: 1.55, drape: 0.3 });
    if (has('breastplate')) shell(P, S, 0.68 * h, 0.8 * h, (S.skeleton ? -0.012 : 0.02) * h, { s: SLOT.iron });
    if (has('fauld')) skirt(P, S, J, 0.62 * h, 0.44 * h, 0.03, { s: SLOT.iron, rows: 3, off: 0.03, follow: 0.2, hemSlot: SLOT.metal });
    if (has('pauldrons')) [['L', 1], ['R', -1]].forEach(([n, s]) => {
      const sh = J['sh' + n];
      ell(P, add3(sh, [s * 0.016 * h, 0.008 * h, 0]), [0.056 * h, 0.042 * h, 0.056 * h], { s: SLOT.iron, w: 'sh' + n, rows: 5, seg: 10, r: [0, 0, -s * 0.3] });
      tube(P, [add3(sh, [s * 0.03 * h, 0.05 * h, -0.01 * h]), add3(sh, [s * 0.05 * h, 0.13 * h, -0.02 * h])], [0.016 * h, 0.001 * h], { s: SLOT.metal, w: 'sh' + n, seg: 5 });
      tube(P, [add3(sh, [s * 0.055 * h, 0.035 * h, 0.03 * h]), add3(sh, [s * 0.1 * h, 0.08 * h, 0.03 * h])], [0.012 * h, 0.001 * h], { s: SLOT.metal, w: 'sh' + n, seg: 5 });
    });
    if (has('greaves')) [['L', 1], ['R', -1]].forEach(([n]) => {
      const kn = J['kn' + n], ft = J['ft' + n];
      loft(P, [{ y: ft[1] + 0.02 * h, rx: 0.036 * h, f: 0.04 * h, b: 0.036 * h }, { y: kn[1] - 0.06 * h, rx: 0.042 * h, f: 0.046 * h, b: 0.05 * h }, { y: kn[1] + 0.01 * h, rx: 0.042 * h, f: 0.052 * h, b: 0.036 * h }].map(r => Object.assign(r, { x: lerp(ft[0], kn[0], (r.y - ft[1]) / (kn[1] - ft[1])) })),
        { seg: 10, s: SLOT.iron, caps: false, w: 'kn' + n });
      loft(P, [{ y: J['el' + n][1] - 0.03 * h, rx: 0.03 * h, f: 0.032 * h }, { y: J['ha' + n][1] + 0.01 * h, rx: 0.026 * h, f: 0.027 * h }].map(r => Object.assign(r, { x: J['el' + n][0] })), { seg: 8, s: SLOT.iron, caps: false, w: 'el' + n });
    });
    if (has('bundle')) {
      ell(P, [0, 0.7 * h, -0.14 * h], [0.11 * h, 0.13 * h, 0.08 * h], { s: SLOT.cloth, w: 'spine', rows: 5, seg: 10, sh: 0.9 });
      [1, -1].forEach(s => tube(P, [[s * 0.07 * h, 0.8 * h, -0.02 * h], [s * 0.08 * h, 0.81 * h, 0.05 * h], [s * 0.085 * h, 0.72 * h, env(S, 0.72 * h).f], [s * 0.08 * h, 0.64 * h, -0.1 * h]], 0.006 * h, { s: SLOT.leather, w: 'spine', seg: 4 }));
    }
    if (has('quiver')) {
      tube(P, [[0.06 * h, 0.58 * h, -0.12 * h], [-0.05 * h, 0.8 * h, -0.13 * h]], 0.035 * h, { s: SLOT.leather, w: 'spine', seg: 7 });
      for (let i = 0; i < 4; i++) box(P, [-0.05 * h + (i % 2) * 0.012 * h, 0.83 * h, -0.13 * h + (i - 1.5) * 0.01 * h], [0.006 * h, 0.04 * h, 0.012 * h], { s: SLOT.accent, w: 'spine', r: [0, 0, 0.45] });
      strap(P, S, J, 1, SLOT.leather);
    }
    if (has('skulls')) for (let i = 0; i < 3; i++) { const a = (i - 1) * 0.5, e = env(S, 0.58 * h); ell(P, [Math.sin(a) * (e.rx + 0.02 * h), 0.57 * h, Math.cos(a) * (e.f + 0.025 * h)], [0.028 * h, 0.03 * h, 0.028 * h], { s: SLOT.bone, w: 'hips', rows: 4, seg: 7 }); }
    if (has('kilt')) skirt(P, S, J, 0.6 * h, 0.4 * h, 0.035, { s: SLOT.leather, rows: 4, off: 0.018, fx: (p, a, i) => (i > 1 ? [p[0], p[1] + (Math.abs(Math.sin(a * 4)) < 0.25 ? 0.03 * S.height : 0) * (i === 4 ? 1 : 0), p[2]] : p) });
    if (has('strap')) strap(P, S, J, -1, SLOT.leather);
    if (has('claws')) [['L', 1], ['R', -1]].forEach(([n, s]) => { const ha = J['ha' + n]; for (let k = 0; k < 4; k++) { const z = (k - 1.5) * 0.012 * h; tube(P, [add3(ha, [-s * 0.004 * h, -0.08 * h, z]), add3(ha, [-s * 0.016 * h, -0.13 * h, z + 0.012 * h]), add3(ha, [-s * 0.03 * h, -0.155 * h, z + 0.03 * h])], k2 => (0.006 - 0.005 * k2) * h, { s: SLOT.dark, w: 'ha' + n, seg: 4 }); } });
    if (has('loincloth')) { [[-0.55, 0.55], [PI - 0.6, PI + 0.6]].forEach(([a0, a1]) => skirt(P, S, J, 0.56 * h, 0.4 * h, 0.01, { s: SLOT.cloth, rows: 3, a0, a1, off: 0.01, follow: 0.3, fx: (p, a, i) => (i === 3 ? [p[0], p[1] + Math.abs(Math.sin(a * 7)) * 0.04 * h, p[2]] : p) })); }
  }

  // ── Presets and spec resolution ─────────────────────────────────────────────
  const SKINS = ['#e0b294', '#d6a27e', '#c8906a', '#b87c58', '#a86c48', '#8e5a3c'];
  const HAIRS = ['#1a120e', '#2c1c12', '#4a2e1c', '#6a4026', '#8a5430', '#7a2e16', '#a88048'];
  const GREYS = ['#8a8078', '#b0a89c', '#d0c8bc'];
  const EARTH = ['#8a6a38', '#6e4c2c', '#7c3c24', '#5c5a34', '#4c4a50', '#8a7a58', '#5a3a4a', '#6a2a1c'];
  const TROUSER = ['#4a3a28', '#3a3024', '#5a4a38', '#2e2a26', '#4a4030'];
  const PRESETS = {
    villagerM: { sex: 'm', height: [1.8, 1.9], bulk: [0.95, 1.12], muscle: [0.3, 0.6], belly: [0, 0.45], age: [0, 0.35], hair: ['short', 'short', 'long', 'fringe', 'bald'], beard: ['full', 'short', 'moustache', 'stubble', 'goatee'],
      top: 'tunic', hem: [0.38, 0.44], sleeves: ['long', 'long', 'short'], legs: 'trousers', feet: 'boots', extras: ['belt'], face: {},
      pal: { top: EARTH, legs: TROUSER, boots: '#2a1c12', leather: '#3a2414', trim: '#a08850' } },
    villagerF: { sex: 'f', height: [1.7, 1.78], bulk: [0.9, 1.05], muscle: [0.1, 0.3], age: [0, 0.3], hair: ['braid', 'bun', 'long', 'kerchief'], beard: 'none', top: 'dress', hem: 0.06, sleeves: 'long', feet: 'shoes', extras: ['apron'],
      pal: { top: ['#5a3a4a', '#4a6040', '#7a3a2a', '#6a5a3a', '#3a4a5a', '#7a1a14'], cloth: ['#c8b898', '#b8a888', '#d0c4a8'], legs: '#3a2a22', boots: '#2a1a12', hair: HAIRS.concat(['#a86030']), accent: '#8a1a12' } },
    smith: { sex: 'm', height: 1.92, bulk: 1.28, muscle: 1, belly: 0.3, age: 0.2, hair: ['bald', 'short'], beard: ['full', 'long'], top: 'shirt', sleeves: 'none', legs: 'trousers', feet: 'boots', extras: ['leatherApron', 'belt'], right: 'hammer', gloves: false,
      face: { stern: true, thick: true }, pal: { top: '#4a3a30', leather: '#5a3418', skin: ['#b87c58', '#a86c48', '#c8906a'], legs: '#3a2e24', hair: HAIRS } },
    merchant: { sex: 'm', height: 1.8, bulk: 1.12, belly: 0.95, muscle: 0.2, age: [0.2, 0.5], hair: 'short', beard: ['full', 'short', 'moustache'], top: 'robe', hem: 0.05, sleeves: 'long', feet: 'shoes', extras: ['sash', 'pouch'], helm: 'hat',
      face: { smile: true }, pal: { top: ['#6a1a2a', '#2a3a6a', '#6a4a1a', '#3a5a3a'], trim: '#c8a040', accent: '#a02818', cloth: ['#3a2418', '#5a1a14', '#2a2a3a'] } },
    pilgrim: { sex: 'm', height: 1.8, bulk: 0.92, muscle: 0.2, age: [0.35, 0.6], hair: 'short', beard: ['full', 'long'], top: 'robe', hem: 0.05, sleeves: 'long', feet: 'shoes', hood: true, extras: ['rope'], right: 'staff', left: 'lantern',
      pal: { top: ['#8a8070', '#b0a48c', '#6a5e4c'], cloth: ['#8a8070', '#b0a48c', '#6a5e4c'], trim: '#b09860', glow: '#ffb050' } },
    bard: { sex: 'm', height: 1.83, bulk: 0.96, muscle: 0.4, hair: ['long', 'short'], beard: ['moustache', 'goatee', 'none'], top: 'doublet', sleeves: 'long', legs: 'trousers', feet: 'boots', bootTop: 0.12, helm: 'beret', extras: ['halfcape', 'belt'], left: 'lute',
      face: { smile: true }, pal: { top: ['#7a1418', '#2a3a6a', '#5a1a4a'], trim: '#d0a030', legs: ['#3a2a4a', '#6a5a20', '#2a2a2a'], accent: '#e8d8b0', cloth: ['#3a1a10', '#1a2a3a'], boots: '#3a2416' } },
    militia: { sex: 'm', height: 1.86, bulk: 1.05, muscle: 0.5, hair: 'short', beard: ['full', 'short', 'moustache', 'stubble'], top: 'gambeson', sleeves: 'long', legs: 'trousers', feet: 'boots', helm: 'kettle', extras: ['belt', 'tabard'], right: 'spear',
      face: { stern: true }, pal: { top: '#9a8a64', accent: '#6e1410', trim: '#5a0e0a', iron: '#5c5c64', metal: '#9a9aa4', legs: '#4a3624' } },
    bandit: { sex: 'm', height: [1.82, 1.9], bulk: 1.1, muscle: 0.75, hair: ['short', 'long'], beard: ['full', 'short', 'stubble'], top: 'jerkin', sleeves: 'none', bracers: true, legs: 'trousers', feet: 'boots', hood: [true, false], helm: [null, 'horned'],
      extras: ['mantle', 'belt', 'strap'], right: ['sword', 'axe'], left: 'shield', face: { stern: true, scar: [true, false] },
      pal: { leather: '#5e3a22', top: '#5e3a22', fur: ['#8a7a64', '#6a6258', '#9a8466'], cloth: '#5a1612', legs: '#3e2a22', accent: '#7a1a12', boots: '#241812', skin: ['#b07c56', '#c8906a', '#a06a48'] } },
    grask: { sex: 'm', height: 2.02, bulk: 1.32, muscle: 1, belly: 0.15, age: 0.3, hair: 'long', beard: 'full', top: 'bare', sleeves: 'none', bracers: true, legs: 'trousers', feet: 'boots', helm: 'horned', hornScale: 1.5,
      extras: ['bigmantle', 'bearskin', 'belt', 'kilt', 'skulls', 'strap'], right: 'bigaxe', left: 'shield', shieldR: 0.36, face: { stern: true, thick: true, scar: true, paint: 'war' },
      pal: { skin: '#9a6a48', hair: '#1a120e', fur: '#3a2a1c', leather: '#3a2416', legs: '#2a1c14', accent: '#121010', boots: '#1a120c', bone: '#ddd2b4' } },
    boneKnight: { sex: 'm', skeleton: true, height: 1.96, bulk: 0.9, top: 'bone', feet: 'boots', bootTop: 0.1, helm: 'bonehelm', extras: ['breastplate', 'pauldrons', 'greaves', 'fauld', 'cape'], right: 'greatsword', left: 'tower',
      pal: { bone: '#d9cfb2', iron: '#1c1c22', metal: '#50505a', accent: '#4a0a0a', glow: '#ff3010', cloth: '#1e1216', trim: '#6a0a08', skin: '#d9cfb2', dark: '#050303', leather: '#2a1a12', boots: '#1c1c22' } },
    knight: { sex: 'm', height: 1.9, bulk: 1.15, muscle: 0.7, hair: 'short', beard: 'none', top: 'plate', legs: 'trousers', feet: 'boots', helm: 'greathelm', extras: ['surcoat', 'belt'], right: 'sword', left: 'kite',
      pal: { metal: '#5c626c', iron: '#383c46', accent: ['#7a1410', '#1a3070', '#8a6a14'], trim: '#c8a038', leather: '#3a2416', cloth: '#3a3a40', boots: '#383c46' } },
    refugee: { sex: ['m', 'f'], height: [1.66, 1.78], bulk: [0.82, 0.9], muscle: 0.1, age: [0.4, 0.8], hair: ['short', 'long'], beard: ['stubble', 'full', 'none'], top: 'rags', hem: 0.28, sleeves: 'long', legs: 'trousers', feet: ['wraps', 'bare'],
      hood: true, extras: ['bundle', 'rope'], face: {}, pal: { top: ['#5a5040', '#4a4036', '#6a5a48'], cloth: ['#4a4036', '#3a342c', '#6a5e4c'], legs: '#3a3228', trim: '#8a7a58' } },
    hunter: { sex: 'm', height: 1.84, bulk: 1, muscle: 0.6, hair: ['short', 'long'], beard: ['short', 'stubble', 'full'], top: 'jerkin', sleeves: 'long', legs: 'trousers', feet: 'boots', bootTop: 0.24, hood: true, extras: ['belt', 'quiver'], left: 'bow',
      pal: { leather: '#5a3a1e', top: '#3a4a2a', cloth: ['#3a4a2a', '#4a5a34'], legs: '#3a3024', accent: '#b02010' } },
    ghoul: { sex: 'm', height: 1.84, bulk: 0.7, muscle: 0, age: 0.3, hair: 'fringe', beard: 'none', top: 'bare', sleeves: 'none', legs: 'bare', feet: 'bare', extras: ['claws', 'loincloth'],
      face: { paint: 'ghoul' }, pal: { skin: ['#6c7866', '#5e6a5a', '#74786a'], hair: '#2a2c26', legs: '#363c32', cloth: '#2a2218', dark: '#16120e' } },
    woodcutter: { sex: 'm', height: 1.88, bulk: 1.2, muscle: 0.8, belly: 0.2, hair: ['short', 'bald'], beard: ['full', 'long'], top: 'tunic', hem: 0.45, sleeves: 'short', legs: 'trousers', feet: 'boots', extras: ['belt'], right: 'axe',
      pal: { top: ['#7a3a24', '#5c5a34', '#6e4c2c'], legs: TROUSER } },
  };
  // A default for any missing slot: palette entries tie to the outfit.
  function pick(v, r) { return Array.isArray(v) ? v[Math.floor(r() * v.length) % v.length] : v; }
  function range(v, r) { return Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' ? lerp(v[0], v[1], r()) : v; }
  function resolve(spec) {
    spec = spec || {};
    const base = PRESETS[spec.preset] || PRESETS.villagerM, seed = spec.seed != null ? spec.seed : hash(JSON.stringify(spec)), r = rng(seed);
    const S = { preset: spec.preset || 'villagerM', seed };
    const get = k => (spec[k] !== undefined ? spec[k] : base[k]);
    S.sex = pick(get('sex') || 'm', r); S.fem = S.sex === 'f';
    S.height = range(get('height') || (S.fem ? 1.72 : 1.84), r); S.bulk = range(get('bulk') == null ? 1 : get('bulk'), r); S.muscle = range(get('muscle') == null ? 0.4 : get('muscle'), r);
    S.belly = range(get('belly') || 0, r); S.age = range(get('age') || 0, r);
    ['hair', 'beard', 'top', 'sleeves', 'legs', 'feet', 'helm', 'hood', 'right', 'left'].forEach(k => { S[k] = pick(get(k), r); });
    if (S.fem) { S.beard = 'none'; if (S.hair === 'fringe' || S.hair === 'bald') S.hair = 'bun'; }
    if (S.hair === 'kerchief') { S.helm = S.helm || 'kerchief'; S.hair = 'short'; }
    if (S.hood && S.helm) S.hood = false;
    S.hem = range(get('hem'), r); S.bootTop = get('bootTop'); S.bracers = !!get('bracers'); S.gloves = !!get('gloves'); S.shieldR = get('shieldR'); S.hornScale = get('hornScale');
    S.skeleton = !!get('skeleton'); S.extras = (get('extras') || []).slice();
    if (S.preset === 'refugee' && S.fem) { S.beard = 'none'; S.hair = 'long'; }
    // palette
    const P0 = Object.assign({}, DEF_PAL), bp = base.pal || {}, sp = spec.pal || {};
    P0.skin = pick(SKINS, r); P0.hair = S.age > 0.55 && r() < 0.8 ? pick(GREYS, r) : pick(HAIRS, r); P0.top = pick(EARTH, r); P0.legs = pick(TROUSER, r);
    Object.keys(bp).forEach(k => { P0[k] = pick(bp[k], r); });
    if (S.age > 0.55 && !sp.hair && r() < 0.7) P0.hair = pick(GREYS, r);
    Object.keys(sp).forEach(k => { P0[k] = sp[k]; });
    S.pal = SLOT_NAMES.map(k => P0[k]);
    const f = Object.assign({}, base.face || {}, spec.face || {});
    Object.keys(f).forEach(k => { f[k] = pick(f[k], r); });
    S.face = S.skeleton ? null : { skin: P0.skin, fem: S.fem, age: +S.age.toFixed(2), brow: S.age > 0.55 ? shade(P0.hair, 0.2) : shade(P0.hair, 0.25), eye: pick(['#2a1a10', '#3a2a18', '#2a3a40', '#3a4a2a'], r),
      stubble: S.beard === 'stubble' || (!S.fem && S.beard !== 'none' && r() < 0.5) ? shade(P0.hair, 0.3, P0.skin) : null, stern: !!f.stern, smile: !!f.smile, thick: !!f.thick, scar: !!f.scar, paint: f.paint || null, look: 0 };
    if (S.face && S.beard && S.beard !== 'none' && S.beard !== 'stubble') S.face.stubble = shade(P0.hair, 0.35, P0.skin);
    S.scale = spec.scale || 1; S.unique = !!spec.unique;
    S.rnd = rng(seed + 99);
    return S;
  }
  function tplKey(S) {
    const o = {}; ['sex', 'hair', 'beard', 'top', 'sleeves', 'legs', 'feet', 'helm', 'hood', 'right', 'left', 'skeleton', 'bracers', 'gloves', 'shieldR', 'hornScale', 'bootTop'].forEach(k => { o[k] = S[k]; });
    ['height', 'bulk', 'muscle', 'belly', 'hem'].forEach(k => { o[k] = S[k] == null ? null : Math.round(S[k] * 50) / 50; });
    o.x = S.extras.join(','); o.seed = S.top === 'rags' || S.extras.indexOf('mantle') >= 0 || S.extras.indexOf('cape') >= 0 ? S.seed % 4 : 0;
    return JSON.stringify(o);
  }

  // ── Template: merged skinned geometry + joint table ─────────────────────────
  function template(S) {
    const key = tplKey(S);
    if (TPL.has(key)) return TPL.get(key);
    ['height', 'bulk', 'muscle', 'belly', 'hem'].forEach(k => { if (S[k] != null) S[k] = Math.round(S[k] * 50) / 50; });
    const J = joints(S), P = { list: [] };
    S.z = zones(S);
    if (S.fem && S.beard === 'none') S.z.beard = SLOT.hair;
    body(P, S, J);
    if (!S.skeleton || true) outfit(P, S, J);
    props(P, S, J);
    const bi = {}; BONES.forEach(([n], i) => { bi[n] = i; });
    let nv = 0, ni = 0; P.list.forEach(g => { nv += g.pos.length / 3; ni += g.idx.length; });
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Float32Array(nv * 3), slot = new Float32Array(nv), uv = new Float32Array(nv * 2);
    const si = new Uint16Array(nv * 4), sw = new Float32Array(nv * 4), idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni), dom = new Uint8Array(nv);
    let vo = 0, io = 0;
    P.list.forEach(g => {
      const n = g.pos.length / 3, N = normals(g);
      for (let i = 0; i < n; i++) {
        const o = vo + i, x = g.pos[i * 3], y = g.pos[i * 3 + 1], z = g.pos[i * 3 + 2];
        pos[o * 3] = x; pos[o * 3 + 1] = y; pos[o * 3 + 2] = z;
        nor[o * 3] = N[i * 3]; nor[o * 3 + 1] = N[i * 3 + 1]; nor[o * 3 + 2] = N[i * 3 + 2];
        const k = g.sh[i] == null ? 1 : g.sh[i], ao = 0.86 + 0.14 * clamp(N[i * 3 + 1] * 0.5 + 0.5, 0, 1);
        col[o * 3] = k * ao; col[o * 3 + 1] = k * ao; col[o * 3 + 2] = k * ao;
        slot[o] = g.s[i];
        if (g.uv) { uv[o * 2] = g.uv[i * 2]; uv[o * 2 + 1] = g.uv[i * 2 + 1]; }
        const w = typeof g.w === 'string' ? [[g.w, 1]] : g.w(x, y, z);
        let tw = 0; w.forEach(e => { tw += e[1]; });
        let best = -1;
        w.slice(0, 4).forEach((e, q) => { si[o * 4 + q] = bi[e[0]]; sw[o * 4 + q] = e[1] / tw; if (best < 0 || e[1] > w[best][1]) best = q; });
        dom[o] = bi[w[best][0]];
      }
      for (let i = 0; i < g.idx.length; i++) idx[io + i] = g.idx[i] + vo;
      vo += n; io += g.idx.length;
    });
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(pos, 3)); geo.setAttribute('normal', new T.BufferAttribute(nor, 3));
    geo.setAttribute('color', new T.BufferAttribute(col, 3)); geo.setAttribute('aSlot', new T.BufferAttribute(slot, 1)); geo.setAttribute('uv', new T.BufferAttribute(uv, 2));
    geo.setAttribute('skinIndex', new T.BufferAttribute(si, 4)); geo.setAttribute('skinWeight', new T.BufferAttribute(sw, 4));
    geo.setIndex(new T.BufferAttribute(idx, 1));
    geo.boundingSphere = new T.Sphere(new T.Vector3(0, S.height * 0.5, 0), S.height * 0.85);
    const h = S.height;
    const tpl = { key, geo, J, dom, verts: nv, tris: ni / 3, h, tip: S._tip || 0.8,
      hips: J.hips[1], torsoD: env(S, 0.72 * h).f };
    TPL.set(key, tpl);
    return tpl;
  }
  function normals(g) {
    const n = g.pos.length / 3, N = new Float32Array(n * 3);
    for (let i = 0; i < g.idx.length; i += 3) {
      const a = g.idx[i], b = g.idx[i + 1], c = g.idx[i + 2], fn = triN(g, a, b, c);
      [a, b, c].forEach(v => { N[v * 3] += fn[0]; N[v * 3 + 1] += fn[1]; N[v * 3 + 2] += fn[2]; });
    }
    if (g.smooth) {
      const map = new Map();
      for (let i = 0; i < n; i++) {
        const k = Math.round(g.pos[i * 3] * 2e4) + ',' + Math.round(g.pos[i * 3 + 1] * 2e4) + ',' + Math.round(g.pos[i * 3 + 2] * 2e4);
        let e = map.get(k); if (!e) { e = [0, 0, 0, []]; map.set(k, e); }
        e[0] += N[i * 3]; e[1] += N[i * 3 + 1]; e[2] += N[i * 3 + 2]; e[3].push(i);
      }
      map.forEach(e => e[3].forEach(i => { N[i * 3] = e[0]; N[i * 3 + 1] = e[1]; N[i * 3 + 2] = e[2]; }));
    }
    for (let i = 0; i < n; i++) { const l = Math.hypot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]) || 1; N[i * 3] /= l; N[i * 3 + 1] /= l; N[i * 3 + 2] /= l; }
    return N;
  }

  // ── Rig ────────────────────────────────────────────────────────────────────
  const REST_W = { sword: 1.2, axe: 1.2, bigaxe: 1.2, greatsword: 1.25, hammer: 1.3, spear: 0, staff: 0, broom: 0.9, hoe: 0.9 };
  function build(spec) {
    const t0 = performance.now();
    shared();
    const S = resolve(spec), tpl = template(S), J = tpl.J, h = tpl.h;
    const face = S.face ? faceTexture(S.face) : BLANK;
    const mat = material(S.pal, face, S.unique);
    const root = new T.Group(), pivot = new T.Group(); root.add(pivot); root.name = 'humanoid_' + S.preset; root.rotation.order = 'YXZ'; pivot.rotation.order = 'YXZ';
    const B = {}, list = [];
    BONES.forEach(([n, p]) => {
      const b = new T.Bone(); b.name = n; b.rotation.order = 'YXZ';
      const jp = J[n] || J.hips, pp = p ? (J[p] || J.hips) : [0, 0, 0];
      b.position.set(jp[0] - pp[0], jp[1] - pp[1], jp[2] - pp[2]);
      b.userData.r = [0, 0, 0]; b.userData.p = [b.position.x, b.position.y, b.position.z]; b.userData.o = new Float32Array(3); b.userData.l = new Float32Array(3);
      (p ? B[p] : pivot).add(b); B[n] = b; list.push(b);
    });
    root.updateMatrixWorld(true);
    const skeleton = new T.Skeleton(list);
    const mesh = new T.SkinnedMesh(tpl.geo, mat), ink = new T.SkinnedMesh(tpl.geo, INK);
    [mesh, ink].forEach(m => { m.bind(skeleton, new T.Matrix4()); m.boundingSphere = tpl.geo.boundingSphere.clone(); root.add(m); });
    mesh.castShadow = true;
    const rig = {
      root, pivot, B, mesh, ink, mat, skeleton, spec: S, tpl, height: h, scale: S.scale, hipY: J.hips[1], lieH: tpl.torsoD * 1.1, rig: 'biped',
      anim: { ph: 0, spd: 0, look: 0, lookP: 0, glance: 0, glanceT: 2, hitT: 0, hitX: 0, hitZ: 0, stagT: 0, dead: null, talk: 0, work: 0, t: 0, fid: S.seed % 97 },
      right: S.right, left: S.left, lost: {},
      // monsters.js-style tables (bone-local offsets)
      hits: hitTable(J, h), sev: { head: 'head', armL: 'shL', armR: 'shR', legL: 'hipL', legR: 'hipR' },
      sr: { head: J.hy * 0.62, armL: 0.045 * h, armR: 0.045 * h, legL: 0.06 * h, legR: 0.06 * h }, tip: ['wpR', 0, 0, tpl.tip],
      stats: { verts: tpl.verts, tris: tpl.tris, draws: 2, ms: 0 },
    };
    // npcs.js-style aliases
    rig.body = B.hips; rig.spine = B.spine; rig.chest = B.spine; rig.neck = B.spine; rig.head = B.head; rig.skull = B.head;
    rig.arms = [{ sh: B.shR, el: B.elR, hand: B.haR, s: -1, rest: -0.1 }, { sh: B.shL, el: B.elL, hand: B.haL, s: 1, rest: 0.1 }];
    rig.legs = [{ hip: B.hipR, knee: B.knR, foot: B.ftR, s: -1 }, { hip: B.hipL, knee: B.knL, foot: B.ftL, s: 1 }];
    rig.hair = []; rig.ik = []; rig.extra = []; rig.dims = { ua: J.shL[1] - J.elL[1], fa: J.elL[1] - J.haL[1] };
    restPose(rig);
    root.scale.setScalar(S.scale);
    root.userData.humanoid = rig;
    rig.stats.ms = performance.now() - t0;
    API.stats.builds++; API.stats.ms += rig.stats.ms;
    return rig;
  }
  function hitTable(J, h) {
    const H = [['head', 'head', 0, J.hc[1] - J.head[1], J.hc[2] - J.head[2], J.hy * 1.2], ['torso', 'spine', 0, 0.12 * h, 0, 0.14 * h], ['torso', 'spine', 0, 0.02 * h, 0, 0.12 * h], ['torso', 'hips', 0, -0.01 * h, 0, 0.11 * h]];
    ['L', 'R'].forEach(n => {
      H.push(['arm' + n, 'sh' + n, 0, -0.09 * h, 0, 0.06 * h], ['arm' + n, 'el' + n, 0, -0.08 * h, 0, 0.055 * h]);
      H.push(['leg' + n, 'hip' + n, 0, -0.11 * h, 0, 0.08 * h], ['leg' + n, 'kn' + n, 0, -0.12 * h, 0, 0.065 * h]);
    });
    return H;
  }
  function restPose(rig) {
    const S = rig.spec, B = rig.B, age = S.age, R = (n, x, y, z) => { const r = B[n].userData.r; r[0] = x; r[1] = y; r[2] = z; };
    R('spine', 0.04 + 0.22 * age * age, 0, 0); R('head', -0.03 - 0.18 * age * age, 0, 0);
    R('shL', 0.03, 0, 0.1 + 0.04 * S.bulk); R('shR', 0.03, 0, -0.1 - 0.04 * S.bulk);
    R('elL', -0.18, 0, 0); R('elR', -0.18, 0, 0); R('haL', 0, 0, -0.08); R('haR', 0, 0, 0.08);
    R('hipL', 0, 0, 0.03); R('hipR', 0, 0, -0.03); R('knL', 0.04 + 0.1 * age, 0, 0); R('knR', 0.04 + 0.1 * age, 0, 0); R('hipL', -0.02 - 0.05 * age, 0, 0.03); R('hipR', -0.02 - 0.05 * age, 0, -0.03);
    R('cape', 0.06, 0, 0);
    const wr = S.right;
    if (wr === 'spear' || wr === 'staff') { R('shR', -0.12, 0, -0.18); R('elR', -1.2, 0, 0); R('haR', 0, 0, 0); R('wpR', 0.08, 0, 0); }
    else if (wr) R('wpR', REST_W[wr] != null ? REST_W[wr] : 1.2, 0, 0);
    if (S.left === 'lantern') { R('shL', -0.3, 0, 0.16); R('elL', -0.5, 0, 0); }
    if (S.left === 'shield' || S.left === 'kite' || S.left === 'tower') { R('shL', 0.04, 0, 0.24); R('elL', -0.32, 0, 0); }
    if (S.left === 'bow') { R('wpL', -1.57, 0, 0); }
    if (S.left === 'lute') { R('shL', -0.55, -0.3, 0.05); R('elL', -1.45, -0.2, 0); R('shR', -0.35, 0.3, -0.25); R('elR', -1.2, 0.3, 0); }
    zeroPose(rig); applyPose(rig);
  }
  function zeroPose(rig) { for (const n in rig.B) { const o = rig.B[n].userData.o; o[0] = o[1] = o[2] = 0; } rig.hipDrop = 0; rig.hipX = 0; }
  function add(rig, n, x, y, z) { const b = rig.B[n]; if (!b) return; const o = b.userData.o; o[0] += x; o[1] += y; o[2] += z; }
  function applyPose(rig) {
    for (const n in rig.B) { const b = rig.B[n], r = b.userData.r, o = b.userData.o; b.rotation.set(r[0] + o[0], r[1] + o[1], r[2] + o[2]); }
    const h = rig.B.hips; h.position.y = h.userData.p[1] + (rig.hipDrop || 0); h.position.x = h.userData.p[0] + (rig.hipX || 0);
  }

  // ── Procedural animation ────────────────────────────────────────────────────
  // state: { speed (world m/s), talk, work ('hammer'|'sweep'|'hoe'|'strum'), aggro, look (yaw rad, local)
  //          or lookAt (world Vector3), pitch }. Call CT.humanoid.hit / stagger / kill for reactions.
  const _v = new T.Vector3(), _m = new T.Matrix4();
  function animate(rig, dt, t, st) {
    st = st || {};
    const A = rig.anim, S = rig.spec, h = rig.height, B = rig.B;
    A.t += dt;
    if (A.dead) { deadUpdate(rig, dt); return; }
    zeroPose(rig);
    const spd = (st.speed || 0) / (rig.root.scale.x || 1);
    A.spd += (spd - A.spd) * Math.min(1, dt * 6);
    const v = A.spd, walk = clamp(v / 1.0, 0, 1), run = clamp((v - 2.4) / 2.2, 0, 1);
    const stride = h * (0.36 + 0.16 * run);
    A.ph += dt * PI * v / stride;
    const ph = A.ph, sp = Math.sin(ph), cp = Math.cos(ph);
    const fem = S.fem ? 1 : 0, age = S.age, heavy = clamp((S.bulk - 1) * 2, 0, 1);
    // locomotion
    if (walk > 0.001) {
      const W = walk, aL = (0.4 + 0.3 * run) * W, kneeK = (0.78 + 0.8 * run) * W;
      ['L', 'R'].forEach((n, i) => {
        const p = ph + (i ? PI : 0), s = Math.sin(p), c = Math.cos(p);
        const hip = -s * aL, kn = Math.max(0, c) * kneeK + (0.06 + 0.1 * run) * W * Math.max(0, -c) * 0.6 + 0.05 * W;
        add(rig, 'hip' + n, hip, 0, 0); add(rig, 'kn' + n, kn, 0, 0);
        // heel-toe: world foot pitch target
        const stance = c < 0, u = ((p % TAU) + TAU) % TAU;
        let fp;
        if (stance) fp = u < PI ? lerp(-0.25, 0, sstep(PI / 2, PI * 0.8, u)) : lerp(0, 0.55 + 0.3 * run, sstep(PI * 1.2, PI * 1.5, u));
        else fp = u > PI ? lerp(0.55, 0.1, sstep(PI * 1.5, PI * 1.85, u)) : lerp(0.1, -0.3, sstep(0, PI / 2, u));
        add(rig, 'ft' + n, (fp * W - hip - kn), 0, 0);
      });
      rig.hipDrop += (Math.cos(2 * ph) - 1) * 0.5 * (0.022 + 0.03 * run) * h * W - 0.02 * run * h;
      rig.hipX += -cp * (0.012 + 0.012 * fem) * h * W * (1 - run * 0.6);
      add(rig, 'hips', 0.02 * run, -sp * (0.1 + 0.05 * fem) * W, cp * (0.05 + 0.05 * fem) * W);
      add(rig, 'spine', (0.05 + 0.2 * run) * W, sp * (0.2 + 0.05 * fem) * W, -cp * 0.04 * W);
      add(rig, 'head', -(0.03 + 0.14 * run) * W, -sp * 0.1 * W, cp * 0.02 * W);
      const arm = (0.38 + 0.4 * run) * W * (1 - 0.3 * heavy);
      ['L', 'R'].forEach((n, i) => {
        const s = Math.sin(ph + (i ? PI : 0)), fw = -s;   // arm forward when the same-side leg is back
        add(rig, 'sh' + n, s * arm, 0, (i ? -1 : 1) * 0.05 * run);
        add(rig, 'el' + n, -(0.12 + 0.35 * Math.max(0, fw) + 1.1 * run) * W, 0, 0);
      });
      add(rig, 'cape', 0.15 * W + 0.5 * run + Math.sin(ph * 2) * 0.05 * W, 0, 0);
    }
    // idle: breathing, weight shift, glances
    const idle = 1 - walk, br = Math.sin(t * 1.7 + A.fid), ws = Math.sin(t * 0.33 + A.fid * 0.7);
    add(rig, 'spine', br * 0.018, 0, 0); add(rig, 'shL', 0, 0, br * 0.02); add(rig, 'shR', 0, 0, -br * 0.02); add(rig, 'head', -br * 0.01, 0, 0);
    if (idle > 0.01) {
      rig.hipX += ws * 0.018 * h * idle;
      add(rig, 'hips', 0, ws * 0.05 * idle, -ws * 0.045 * idle); add(rig, 'spine', 0, -ws * 0.04 * idle, ws * 0.06 * idle);
      const lk = ws > 0 ? 'R' : 'L', k = Math.abs(ws) * idle;          // the unweighted leg relaxes
      add(rig, 'hip' + lk, -0.06 * k, 0, 0); add(rig, 'kn' + lk, 0.16 * k, 0, 0); add(rig, 'ft' + lk, -0.08 * k, 0, 0);
      add(rig, 'hipL', 0, 0, -ws * 0.045 * idle); add(rig, 'hipR', 0, 0, -ws * 0.045 * idle);
      add(rig, 'cape', Math.sin(t * 1.1 + A.fid) * 0.04 * idle, 0, Math.sin(t * 0.8) * 0.03 * idle);
      A.glanceT -= dt; if (A.glanceT < 0) { A.glanceT = 2 + ((A.fid * 13 + t * 7) % 5); A.glance = (((A.fid * 31 + Math.floor(t)) % 11) / 11 - 0.5) * 1.1; }
    } else A.glance = 0;
    // look
    let ly = st.look != null ? st.look : A.glance * idle, lp = st.pitch || 0;
    if (st.lookAt) {
      rig.root.updateMatrixWorld(true); _v.copy(st.lookAt); rig.root.worldToLocal(_v);
      const dx = _v.x, dz = _v.z, dy = _v.y - (rig.spec.height * 0.93);
      ly = Math.atan2(dx, dz); lp = -Math.atan2(dy, Math.hypot(dx, dz));
    }
    ly = clamp(ly, -1.15, 1.15); lp = clamp(lp, -0.5, 0.5);
    A.look += (ly - A.look) * Math.min(1, dt * 4); A.lookP += (lp - A.lookP) * Math.min(1, dt * 4);
    add(rig, 'head', A.lookP * 0.8, A.look * 0.72, 0); add(rig, 'spine', A.lookP * 0.15, A.look * 0.25, 0);
    // talk gestures
    A.talk += ((st.talk ? 1 : 0) - A.talk) * Math.min(1, dt * 3);
    if (A.talk > 0.01) {
      const k = A.talk * (1 - walk * 0.7), cyc = t * 0.4 + A.fid, sideR = Math.sin(cyc * PI) > 0;
      const g = (0.5 + 0.5 * Math.sin(t * 3.1)) * k, g2 = Math.sin(t * 5.3) * k;
      const n = sideR ? 'R' : 'L', s = sideR ? -1 : 1;
      if (!(n === 'R' && S.right) && !(n === 'L' && S.left)) {
        add(rig, 'sh' + n, -0.35 * k - 0.15 * g, s * 0.2 * k, -s * 0.05 * k); add(rig, 'el' + n, -0.9 * k - 0.35 * g, 0, 0); add(rig, 'ha' + n, 0, s * 0.5 * k + g2 * 0.3, -s * 0.2 * k);
      }
      add(rig, 'head', Math.sin(t * 6.3) * 0.05 * k + 0.03 * g2, 0, Math.sin(t * 2.1) * 0.04 * k);
      add(rig, 'spine', -0.02 * k, 0, 0);
    }
    // work loops
    const wk = st.work || null;
    A.work += ((wk ? 1 : 0) - A.work) * Math.min(1, dt * 3);
    if (wk) A.task = wk;
    if (A.work > 0.01 && A.task) work(rig, A.task, t + A.fid, A.work * (1 - walk));
    // tools held while walking
    if (S.left === 'lantern') {
      const b = rig.B;   // keep the lantern hanging plumb
      add(rig, 'wpL', -(b.shL.userData.r[0] + b.shL.userData.o[0] + b.elL.userData.r[0] + b.elL.userData.o[0] + b.spine.userData.o[0]) + Math.sin(t * 2.3) * 0.08, 0, 0);
    }
    // combat stance
    if (st.aggro) {
      add(rig, 'shR', -0.35, 0, 0); add(rig, 'elR', -0.75, 0, 0); add(rig, 'wpR', -0.8, 0, 0); add(rig, 'shL', -0.2, 0, 0.1); add(rig, 'elL', -0.5, 0, 0);
      add(rig, 'knL', 0.18, 0, 0); add(rig, 'knR', 0.18, 0, 0); add(rig, 'hipL', -0.12, 0, 0); add(rig, 'hipR', -0.12, 0, 0); rig.hipDrop -= 0.025 * h; add(rig, 'spine', 0.1, 0, 0);
    }
    // reactions
    if (A.hitT > 0) {
      A.hitT -= dt; const f = Math.max(0, A.hitT / 0.35), e = f * f * (3 - 2 * f);
      add(rig, 'spine', -0.35 * e * A.hitZ, 0.3 * e * A.hitX, -0.25 * e * A.hitX); add(rig, 'head', -0.45 * e * A.hitZ, 0, 0.3 * e * A.hitX);
      add(rig, 'shL', -0.5 * e, 0, 0.3 * e); add(rig, 'shR', -0.5 * e, 0, -0.3 * e); add(rig, 'elL', -0.6 * e, 0, 0); add(rig, 'elR', -0.6 * e, 0, 0);
      add(rig, 'knL', 0.2 * e, 0, 0); add(rig, 'knR', 0.2 * e, 0, 0); rig.hipDrop -= 0.02 * h * e;
    }
    if (A.stagT > 0) {
      A.stagT -= dt; const k = Math.min(1, A.stagT * 2), w = Math.sin(t * 9) * 0.2;
      add(rig, 'spine', (-0.45 + w * 0.5) * k, w * k, 0); add(rig, 'head', -0.5 * k, 0, w * k); add(rig, 'shL', -0.6 * k, 0, (0.9 + w) * k); add(rig, 'shR', -0.4 * k, 0, (-0.9 - w) * k);
      add(rig, 'knL', 0.5 * k, 0, 0); add(rig, 'knR', 0.3 * k, 0, 0); rig.hipDrop -= 0.035 * h * k; add(rig, 'hips', -0.2 * k, 0, w * 0.5 * k);
    }
    applyPose(rig);
  }
  function work(rig, task, t, k) {
    const h = rig.height;
    if (task === 'hammer' || task === 'hoe') {
      const T0 = task === 'hammer' ? 1.15 : 1.5, u = ((t % T0) + T0) % T0 / T0;
      let e;   // 0 = down (struck), 1 = raised
      if (u < 0.62) e = sstep(0, 0.62, u); else if (u < 0.72) e = 1 - sstep(0.62, 0.72, u) * 1.08; else e = lerp(-0.08, 0, sstep(0.72, 1, u));
      rig.impact = u >= 0.7 && u < 0.72 + 0.02;
      add(rig, 'shR', (-0.5 - 1.9 * e) * k, 0.1 * k, -0.1 * k); add(rig, 'elR', (-0.9 - 0.9 * e) * k, 0, 0); add(rig, 'wpR', (-1.2 + 0.6 * (1 - e)) * k, 0, 0);
      add(rig, 'spine', (0.2 - 0.1 * e) * k, -0.18 * k, 0); add(rig, 'head', 0.15 * k, 0.15 * k, 0);
      if (task === 'hoe') { add(rig, 'shL', (-0.6 - 1.6 * e) * k, -0.2 * k, 0.1 * k); add(rig, 'elL', (-0.7 - 0.7 * e) * k, 0, 0); }
      else { add(rig, 'shL', -0.55 * k, 0, 0.05 * k); add(rig, 'elL', -1.0 * k, 0, 0); }
      add(rig, 'knL', 0.12 * k, 0, 0); add(rig, 'knR', 0.12 * k, 0, 0); add(rig, 'hipL', -0.15 * k, 0, 0); rig.hipDrop -= 0.012 * h * k;
    } else if (task === 'sweep') {
      const s = Math.sin(t * 2.6);
      add(rig, 'shR', -0.45 * k, 0.15 * k, -0.1 * k); add(rig, 'elR', -0.5 * k, 0, 0); add(rig, 'wpR', 0.1 * k, 0, 0);
      add(rig, 'shL', -0.9 * k, -0.35 * k, -0.25 * k); add(rig, 'elL', -0.7 * k, 0, 0);
      add(rig, 'spine', 0.25 * k, s * 0.3 * k, 0); add(rig, 'hips', 0, -s * 0.1 * k, 0); add(rig, 'head', 0.2 * k, -s * 0.2 * k, 0);
    } else if (task === 'strum') {
      add(rig, 'elR', Math.sin(t * 11) * 0.1 * k, 0, 0); add(rig, 'haR', Math.sin(t * 11) * 0.2 * k, 0, 0); add(rig, 'head', 0.1 * k, 0.2 * k, 0.1 * k * Math.sin(t * 1.5));
    } else if (task === 'pray') {
      add(rig, 'shL', -0.55 * k, 0, -0.35 * k); add(rig, 'shR', -0.55 * k, 0, 0.35 * k); add(rig, 'elL', -1.6 * k, 0.5 * k, 0); add(rig, 'elR', -1.6 * k, -0.5 * k, 0); add(rig, 'head', 0.4 * k, 0, 0);
    }
  }
  // Death: knees buckle, then the body topples about the feet and the limbs go limp.
  function deadUpdate(rig, dt) {
    const D = rig.anim.dead, h = rig.height;
    D.t += dt;
    const bucl = 0.24;
    if (D.t > bucl && !D.landed) {
      D.av += 6.5 * Math.sin(Math.max(0.25, D.ang)) * dt; D.ang += D.av * dt;
      if (D.ang >= PI / 2) { D.ang = PI / 2; D.av = -D.av * 0.22; if (Math.abs(D.av) < 0.3) { D.landed = true; D.av = 0; } }
    }
    const k = 1 - Math.exp(-6 * dt);
    for (const n in rig.B) {
      const o = rig.B[n].userData.o, l = rig.B[n].userData.l, drop = D.t < bucl && /^kn/.test(n) ? 1.2 : 0;
      o[0] += (l[0] + drop - o[0]) * k; o[1] += (l[1] - o[1]) * k; o[2] += (l[2] - o[2]) * k;
    }
    const tgt = D.t < bucl ? -sstep(0, bucl, D.t) * 0.2 * rig.hipY : -0.12 * rig.hipY;
    rig.hipDrop += (tgt - rig.hipDrop) * Math.min(1, dt * 10); rig.hipX *= 0.9;
    applyPose(rig);
    const P = rig.pivot;
    if (D.axis === 'x') { P.rotation.x = D.sign * D.ang; P.rotation.z = 0; } else { P.rotation.z = D.sign * D.ang; P.rotation.x = 0; }
    P.position.y = rig.lieH * Math.sin(D.ang);
  }
  function kill(rig, dir) {
    if (rig.anim.dead) return;
    const yaw = rig.root.rotation.y, fx = Math.sin(yaw), fz = Math.cos(yaw);
    const lz = dir ? dir.x * fx + dir.z * fz : -1, lx = dir ? dir.x * -fz + dir.z * fx : 0;   // hit direction in local space
    const D = rig.anim.dead = { t: 0, ang: 0, av: 0.3, landed: false, axis: Math.abs(lx) > Math.abs(lz) * 1.2 ? 'z' : 'x', sign: 1 };
    D.sign = D.axis === 'x' ? (lz >= 0 ? 1 : -1) : (lx > 0 ? -1 : 1);
    const r = rng((rig.spec.seed + (Date.now() & 0xffff)) >>> 0);
    for (const n in rig.B) {
      const l = rig.B[n].userData.l, R = () => r() * 2 - 1;
      l[0] = R() * 0.3; l[1] = R() * 0.2; l[2] = R() * 0.2;
      if (/^sh/.test(n)) { l[0] = -r() * 1.6 * (D.sign < 0 ? 1 : 0.5); l[2] = (n === 'shL' ? 1 : -1) * (0.4 + r() * 1.0); }
      if (/^el/.test(n)) l[0] = -r() * 1.1;
      if (/^kn/.test(n)) l[0] = r() * 0.8;
      if (/^hip[LR]/.test(n)) { l[0] = -r() * 0.5; l[2] = (n === 'hipL' ? 1 : -1) * r() * 0.35; }
      if (n === 'head') { l[0] = R() * 0.6; l[1] = R() * 0.8; }
      if (/^wp/.test(n)) l[0] = R() * 1.2;
    }
  }
  function revive(rig) { rig.anim.dead = null; rig.pivot.rotation.set(0, 0, 0); rig.pivot.position.set(0, 0, 0); zeroPose(rig); applyPose(rig); }
  function hit(rig, dir, k) {
    const A = rig.anim, yaw = rig.root.rotation.y, fx = Math.sin(yaw), fz = Math.cos(yaw);
    const lz = dir ? dir.x * fx + dir.z * fz : -1, lx = dir ? dir.x * -fz + dir.z * fx : 0;
    A.hitT = 0.35 * (k || 1); A.hitZ = lz <= 0 ? 1 : -1; A.hitX = clamp(lx, -1, 1);
  }
  function stagger(rig, sec) { rig.anim.stagT = Math.max(rig.anim.stagT, sec || 0.8); }

  // ── Sever: bake the limb into a rigid mesh on its bone, hide it in the skin ──
  // Returns the limb's root bone; the caller may reparent it into the scene and fling it
  // (monsters.js sever() does exactly that with its own bones).
  const SUB = { head: ['head', 'jaw'], armL: ['shL', 'elL', 'haL', 'wpL'], armR: ['shR', 'elR', 'haR', 'wpR'], legL: ['hipL', 'knL', 'ftL'], legR: ['hipR', 'knR', 'ftR'], torso: ['spine', 'hips', 'cape'] };
  function sever(rig, part) {
    const names = SUB[part]; if (!names || rig.lost[part]) return null;
    rig.lost[part] = true;
    const tpl = rig.tpl, geo = tpl.geo, sk = rig.skeleton, root = rig.B[names[0]];
    const ids = new Set(names.map(n => BONES.findIndex(b => b[0] === n)));
    rig.root.updateMatrixWorld(true); sk.update();
    const pos = geo.attributes.position, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight, idx = geo.index.array;
    const inv = new T.Matrix4().copy(root.matrixWorld).invert(), bm = sk.boneMatrices, map = new Map(), P = [], C = [], Sl = [], U = [], I = [];
    const tmp = new T.Vector3(), acc = new T.Vector3(), M = new T.Matrix4();
    const vert = v => {
      if (map.has(v)) return map.get(v);
      acc.set(0, 0, 0);
      for (let q = 0; q < 4; q++) { const w = sw.getComponent(v, q); if (!w) continue; M.fromArray(bm, si.getComponent(v, q) * 16); tmp.fromBufferAttribute(pos, v).applyMatrix4(M).multiplyScalar(w); acc.add(tmp); }
      acc.applyMatrix4(inv);
      const n = P.length / 3; P.push(acc.x, acc.y, acc.z);
      C.push(geo.attributes.color.getX(v), geo.attributes.color.getY(v), geo.attributes.color.getZ(v)); Sl.push(geo.attributes.aSlot.getX(v)); U.push(geo.attributes.uv.getX(v), geo.attributes.uv.getY(v));
      map.set(v, n); return n;
    };
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i], b = idx[i + 1], c = idx[i + 2];
      if (ids.has(tpl.dom[a]) && ids.has(tpl.dom[b]) && ids.has(tpl.dom[c])) I.push(vert(a), vert(b), vert(c));
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(P, 3)); g.setAttribute('color', new T.Float32BufferAttribute(C, 3));
    g.setAttribute('aSlot', new T.Float32BufferAttribute(Sl, 1)); g.setAttribute('uv', new T.Float32BufferAttribute(U, 2)); g.setIndex(I); g.computeVertexNormals();
    const chunk = new T.Mesh(g, rig.mat), cink = new T.Mesh(g, INK);
    const s = rig.root.scale.x; chunk.scale.setScalar(1); root.add(chunk); root.add(cink);
    // hide the limb in the skinned body: its bones now point at a collapsed stand-in
    const par = root.parent;
    names.forEach(n => {
      const i = BONES.findIndex(b => b[0] === n), nb = new T.Bone(); nb.position.copy(root.position); nb.scale.setScalar(1e-4); par.add(nb);
      sk.bones[i] = nb;
    });
    rig.chunks = (rig.chunks || []).concat([chunk, cink]);
    return root;
  }
  function dispose(rig) { rig.root.parent && rig.root.parent.remove(rig.root); if (rig.skeleton) rig.skeleton.dispose(); (rig.chunks || []).forEach(c => c.geometry.dispose()); if (rig.spec.unique) rig.mat.dispose(); }
  function setRim(color, k) { RIM.value.set(color); if (k != null) RIMK.value = k; }
  function prewarm(specs) { shared(); const t0 = performance.now(); (specs || []).forEach(sp => { const S = resolve(sp); template(S); if (S.face) faceTexture(S.face); }); return performance.now() - t0; }

  const API = CT.humanoid = {
    build, animate, hit, stagger, kill, revive, sever, dispose, setRim, prewarm, zeroPose, add, applyPose,
    PRESETS, SLOT, BONES: BONES.map(b => b[0]), resolve,
    stats: { builds: 0, ms: 0, templates: () => TPL.size, materials: () => MATS.size },
    ink: INKW,
  };
})();
