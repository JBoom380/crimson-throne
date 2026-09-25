// ─── LIFE: wildlife, road travellers, random encounters, searchable corpses ──
// CT.life = { init(core), update(dt, core), hitTest(origin, dir, range, arc), damage(animal, amount, dir), debug: { force(name), stats() } }
// Every creature and traveller is an InstancedMesh instance (one draw call per species or outfit), animated
// in the vertex shader: each vertex carries a rig code (leg, head, arm, weapon arm, wing, wheel, tail) and
// each instance a phase, a stride, a head pose and an action. Hostiles stay monsters.js monsters; staged
// fights steer them through their own states ('return' toward a goal, 'idle' in place) and _debug.attack.
(function () {
  'use strict';
  const T = THREE, PI = Math.PI, TAU = PI * 2, C = CT.config, bus = CT.bus;
  const rnd = Math.random;
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, k) => a + (b - a) * k;
  const R = (a, b) => a + rnd() * (b - a);
  const RI = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const pick = a => a[Math.floor(rnd() * a.length)];
  const wrap = a => { while (a > PI) a -= TAU; while (a < -PI) a += TAU; return a; };
  const turn = (a, b, r) => a + clamp(wrap(b - a), -r, r);
  const pickW = tbl => { let s = 0; for (const e of tbl) s += e[1]; let r = rnd() * s; for (const e of tbl) if ((r -= e[1]) <= 0) return e[0]; return tbl.length ? tbl[0][0] : null; };
  const has = (m, f) => !!(CT[m] && typeof CT[m][f] === 'function' && !(CT._broken && CT._broken[m]));
  const H = (x, z) => { const y = has('world', 'heightAt') ? CT.world.heightAt(x, z) : 0; return y === y && y != null ? y : 0; };
  const WAT = (x, z) => (has('world', 'waterAt') ? CT.world.waterAt(x, z) || 0 : 0);
  const BIO = (x, z) => (has('world', 'biomeAt') ? CT.world.biomeAt(x, z) : 'meadow');
  const isNight = () => has('sky', 'isNight') && !!CT.sky.isNight();
  const tod = () => (CT.sky && typeof CT.sky.timeOfDay === 'number' ? CT.sky.timeOfDay : 0.4);
  const dusk = () => { const t = tod(); return t > 0.7 || t < 0.27; };
  const bloodmoon = () => !!(CT.sky && CT.sky.weather === 'bloodmoon');
  const mons = () => (CT.monsters && CT.monsters.list) || [];
  const sfx = (name, pos) => { if (has('audio', 'sfx')) CT.audio.sfx(name, pos ? { pos } : {}); };
  const say = (text, kind) => bus.emit('notify', { text, kind: kind || 'bark' });
  const V1 = new T.Vector3(), V2 = new T.Vector3(), Q1 = new T.Quaternion(), M1 = new T.Matrix4(), S1 = new T.Vector3(), COL = new T.Color(), N3 = new T.Matrix3();
  const E0 = new T.Euler(), E1 = new T.Euler(0, 0, 0, 'YXZ');
  const P = new T.Vector3(), LP = new T.Vector3();
  let core = null, root = null, time = 0, low = false, BUSY = false;
  let HX = 0, HZ = -1, FX_ = 0, FZ_ = -1, pSpeed = 0, movedT = 0, sprinting = false;
  const api = CT.life = { init, update, hitTest, damage };

  // ── Extra spoils (added to the shared item table at load, before any save loads) ──
  const XITEMS = {
    venison: { name: 'Venison', kind: 'loot', price: 5 },
    hide: { name: 'Deer Hide', kind: 'loot', price: 9 },
    tusk: { name: 'Boar Tusk', kind: 'loot', price: 12 },
    trinket: { name: 'Silver Trinket', kind: 'loot', price: 22 },
  };
  for (const k in XITEMS) if (!C.ITEMS[k]) C.ITEMS[k] = XITEMS[k];
  function grant(id, n) {
    if (!C.ITEMS[id] || !(n > 0)) return;
    if (has('rpg', 'grant')) CT.rpg.grant(id, n);
    else if (has('rpg', 'give')) { CT.rpg.give(id, n); bus.emit('loot', { item: id, count: n }); }
  }
  function xp(n) { if (has('rpg', 'addXp')) { CT.rpg.addXp(n); bus.emit('notify', { text: `+${n} XP`, kind: 'xp' }); } }
  const gold = () => (CT.rpg && CT.rpg.stats ? CT.rpg.stats.gold || 0 : 0);
  const hasItem = id => has('rpg', 'has') && CT.rpg.has(id);
  function take(id, n) { return has('rpg', 'take') ? !!CT.rpg.take(id, n) : false; }

  // ── Toon rig material: one shader animates every creature ─────────────────
  let GRAD = null, MAT = null;
  const RIM = { value: new T.Color(0xff9a50) };
  const VHEAD = `attribute vec4 aPart; attribute float aMask; attribute vec4 aAnim; attribute vec3 aTint; attribute vec3 aTint2; varying float vGlow;
mat3 ctRX(float a){ float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
mat3 ctRY(float a){ float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 ctRZ(float a){ float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }`;
  // codes: 1 leg, 2 head (pitch by aAnim.z), 3 arm, 4 weapon arm (swing - aAnim.w), 5 wing (side in aPart.z), 6 wheel, 7 tail
  const VRIG = `float ctC = aPart.x; vec3 ctP = vec3(0.0, aPart.y, aPart.z); mat3 ctM = mat3(1.0);
float ctS = sin(aAnim.x + aPart.w);
if (ctC > 0.5 && ctC < 1.5) ctM = ctRX(ctS * aAnim.y);
else if (ctC > 1.5 && ctC < 2.5) ctM = ctRX(aAnim.z);
else if (ctC > 2.5 && ctC < 3.5) ctM = ctRX(ctS * aAnim.y * 0.8);
else if (ctC > 3.5 && ctC < 4.5) ctM = ctRX(ctS * aAnim.y * 0.5 - aAnim.w);
else if (ctC > 4.5 && ctC < 5.5) { ctP = vec3(0.0, aPart.y, 0.0); ctM = ctRZ(aPart.z * (sin(aAnim.x) * aAnim.y + aAnim.w)); }
else if (ctC > 5.5 && ctC < 6.5) ctM = ctRX(aAnim.x * aPart.w);
else if (ctC > 6.5) ctM = ctRY(sin(aAnim.x * 1.7 + aPart.w) * (0.25 + aAnim.y * 0.4));
objectNormal = ctM * objectNormal;`;
  const VCOL = `vGlow = step(2.5, aMask);
#ifdef USE_COLOR
vColor.rgb *= mix(vec3(1.0), aTint, step(0.5, aMask) * step(aMask, 1.5));
vColor.rgb *= mix(vec3(1.0), aTint2, step(1.5, aMask) * step(aMask, 2.5));
#endif`;
  function makeMat() {
    GRAD = new T.DataTexture(new Uint8Array([58, 118, 182, 255]), 4, 1, T.RedFormat);
    GRAD.minFilter = GRAD.magFilter = T.NearestFilter; GRAD.generateMipmaps = false; GRAD.needsUpdate = true;
    MAT = new T.MeshToonMaterial({ color: 0xffffff, vertexColors: true, gradientMap: GRAD });
    MAT.onBeforeCompile = sh => {
      sh.uniforms.uRim = RIM;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\n' + VHEAD)
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n' + VRIG)
        .replace('#include <begin_vertex>', 'vec3 transformed = ctM * (position - ctP) + ctP;')
        .replace('#include <color_vertex>', '#include <color_vertex>\n' + VCOL);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uRim; varying float vGlow;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n{ float rk = 1.0 - abs(dot(normal, normalize(vViewPosition))); totalEmissiveRadiance += uRim * rk * rk * rk; }\n#ifdef USE_COLOR\ntotalEmissiveRadiance += vColor.rgb * vGlow * 2.4;\n#endif');
    };
    MAT.customProgramCacheKey = () => 'ctLifeRig';
  }

  // ── Geometry kit: primitive parts merged into one vertex-coloured, rig-tagged geometry ──
  const GP = {};
  function prims() {
    const ni = g => (g.index ? g.toNonIndexed() : g);
    GP.sph = ni(new T.SphereGeometry(1, 8, 6)); GP.ball = ni(new T.SphereGeometry(1, 6, 4)); GP.box = ni(new T.BoxGeometry(1, 1, 1));
    GP.cyl = ni(new T.CylinderGeometry(1, 1, 1, 7)); GP.tapd = ni(new T.CylinderGeometry(1, 0.68, 1, 7)); GP.tapu = ni(new T.CylinderGeometry(0.55, 1, 1, 8));
    GP.cone = ni(new T.ConeGeometry(1, 1, 6)); GP.ico = ni(new T.IcosahedronGeometry(1, 0)); GP.oct = ni(new T.OctahedronGeometry(1, 0));
    GP.arch = ni(new T.CylinderGeometry(1, 1, 1, 8, 1, true, -PI / 2, PI)).rotateX(-PI / 2);   // half tube along z, open side down (cart cover)
    GP.disc = new T.CircleGeometry(1, 10).rotateX(-PI / 2);
  }
  function kit() {
    const k = { parts: [], rig: null, mask: 0 };
    k.p = (g, col, x, y, z, sx, sy, sz, rx, ry, rz) => { k.parts.push([g, col, x, y, z, sx, sy, sz, rx || 0, ry || 0, rz || 0, k.rig, k.mask]); return k; };
    k.m = (g, col, x, y, z, sx, sy, sz, rx, ry, rz) => { k.p(g, col, x, y, z, sx, sy, sz, rx, ry, rz); return k.p(g, col, -x, y, z, sx, sy, sz, rx, -(ry || 0), -(rz || 0)); };
    return k;
  }
  const ZR = [0, 0, 0, 0];
  function build(k) {
    let n = 0; for (const p of k.parts) n += GP[p[0]].attributes.position.count;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3), prt = new Float32Array(n * 4), msk = new Float32Array(n);
    let o = 0;
    for (const p of k.parts) {
      const g = GP[p[0]], pa = g.attributes.position.array, na = g.attributes.normal.array, cnt = g.attributes.position.count, rg = p[11] || ZR, mk = p[12];
      M1.compose(V1.set(p[2], p[3], p[4]), Q1.setFromEuler(E0.set(p[8], p[9], p[10])), S1.set(p[5], p[6], p[7]));
      N3.getNormalMatrix(M1); COL.set(p[1]);
      for (let i = 0; i < cnt; i++, o++) {
        V1.set(pa[i * 3], pa[i * 3 + 1], pa[i * 3 + 2]).applyMatrix4(M1);
        pos[o * 3] = V1.x; pos[o * 3 + 1] = V1.y; pos[o * 3 + 2] = V1.z;
        V2.set(na[i * 3], na[i * 3 + 1], na[i * 3 + 2]).applyMatrix3(N3).normalize();
        const kk = 0.8 + 0.2 * V2.y;
        col[o * 3] = COL.r * kk; col[o * 3 + 1] = COL.g * kk; col[o * 3 + 2] = COL.b * kk;
        prt[o * 4] = rg[0]; prt[o * 4 + 1] = rg[1]; prt[o * 4 + 2] = rg[2]; prt[o * 4 + 3] = rg[3]; msk[o] = mk;
      }
    }
    for (let i = 0; i < n * 3; i += 9) {                 // flat facets: the chunky low-poly look
      const ax = pos[i + 3] - pos[i], ay = pos[i + 4] - pos[i + 1], az = pos[i + 5] - pos[i + 2];
      const bx = pos[i + 6] - pos[i], by = pos[i + 7] - pos[i + 1], bz = pos[i + 8] - pos[i + 2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx; const l = Math.hypot(nx, ny, nz) || 1;
      for (let q = 0; q < 9; q += 3) { nor[i + q] = nx / l; nor[i + q + 1] = ny / l; nor[i + q + 2] = nz / l; }
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(pos, 3)); geo.setAttribute('normal', new T.BufferAttribute(nor, 3));
    geo.setAttribute('color', new T.BufferAttribute(col, 3)); geo.setAttribute('aPart', new T.BufferAttribute(prt, 4)); geo.setAttribute('aMask', new T.BufferAttribute(msk, 1));
    geo.computeBoundingSphere();
    return geo;
  }
  const W = 0xffffff;   // tinted parts are white; the instance tint paints them

  // ── Designs: animals (all face +Z, feet at y = 0) ─────────────────────────
  function quadLegs(k, legs, top, len, r, col, hoofCol, lower) {
    for (const [x, z, ph] of legs) {
      k.rig = [1, top, z, ph];
      k.p('tapd', col, x, top - len * 0.28, z, r, len * 0.56, r * 1.1);
      k.p('tapd', lower || col, x, top - len * 0.72, z + 0.02, r * 0.62, len * 0.48, r * 0.66);
      k.p('box', hoofCol, x, 0.03, z + 0.03, r * 0.85, 0.06, r * 1.2);
    }
    k.rig = null;
  }
  function dDeer(stag) {
    const k = kit(), fur = stag ? 0x5e3c24 : 0x6e4a2e, dark = 0x3a2616, pale = 0xcdb89a, hoof = 0x1a120c;
    quadLegs(k, [[0.12, 0.36, 0], [-0.12, 0.36, PI], [0.12, -0.4, PI], [-0.12, -0.4, 0]], 0.88, 0.86, 0.058, fur, hoof, dark);
    k.p('sph', fur, 0, 0.99, -0.02, 0.21, 0.24, 0.56); k.p('sph', pale, 0, 0.9, 0.02, 0.16, 0.16, 0.46);
    k.p('sph', fur, 0, 1.06, 0.3, 0.2, 0.22, 0.26); k.p('sph', 0xf2eadc, 0, 1.0, -0.52, 0.13, 0.15, 0.07);
    k.rig = [7, 1.06, -0.55, 0]; k.p('cone', 0xf2eadc, 0, 1.1, -0.6, 0.04, 0.13, 0.035, -2.3);
    k.rig = [2, 1.08, 0.42, 0];
    k.p('tapd', fur, 0, 1.3, 0.56, 0.085, 0.52, 0.09, 0.55);
    if (stag) k.p('sph', 0x5a3820, 0, 1.2, 0.54, 0.11, 0.2, 0.11, 0.5);   // rough neck mane
    k.p('sph', fur, 0, 1.53, 0.73, 0.085, 0.09, 0.14, 0.3); k.p('cone', dark, 0, 1.48, 0.86, 0.05, 0.14, 0.05, 1.9);
    k.p('ball', 0x100808, 0, 1.465, 0.925, 0.026, 0.022, 0.02); k.m('ball', 0x080404, 0.06, 1.56, 0.78, 0.016, 0.016, 0.016);
    k.m('cone', fur, 0.075, 1.63, 0.66, 0.035, 0.13, 0.02, -0.3, 0, -0.9);
    if (stag) {
      const A = 0xe0d0a8;
      k.m('cyl', A, 0.07, 1.78, 0.64, 0.014, 0.34, 0.014, -0.35, 0, -0.45);
      k.m('cyl', A, 0.16, 1.97, 0.58, 0.012, 0.3, 0.012, -0.55, 0, -0.2);
      k.m('cyl', A, 0.12, 1.86, 0.72, 0.01, 0.2, 0.01, 0.6, 0, -0.3);
      k.m('cyl', A, 0.21, 2.08, 0.66, 0.01, 0.18, 0.01, 0.4, 0, -0.6);
      k.m('cyl', A, 0.2, 2.1, 0.48, 0.01, 0.2, 0.01, -0.8, 0, -0.1);
    }
    k.rig = null;
    return k;
  }
  function dHare() {
    const k = kit(); k.mask = 1;
    k.rig = [1, 0.18, -0.08, 0]; k.m('sph', W, 0.07, 0.11, -0.08, 0.05, 0.09, 0.11);
    k.rig = [1, 0.2, 0.1, PI]; k.m('cyl', W, 0.04, 0.09, 0.12, 0.018, 0.17, 0.018);
    k.rig = null; k.p('sph', W, 0, 0.2, -0.02, 0.1, 0.11, 0.17);
    k.mask = 0; k.p('sph', 0xf4f0ea, 0, 0.23, -0.19, 0.045, 0.045, 0.04); k.mask = 1;
    k.rig = [2, 0.25, 0.1, 0];
    k.p('sph', W, 0, 0.3, 0.18, 0.06, 0.065, 0.08);
    k.m('box', W, 0.025, 0.44, 0.13, 0.018, 0.17, 0.04, -0.35, 0, -0.18);
    k.mask = 0; k.m('ball', 0x080404, 0.04, 0.32, 0.22, 0.012, 0.012, 0.012); k.p('ball', 0x5a3030, 0, 0.29, 0.255, 0.012, 0.01, 0.01);
    k.rig = null;
    return k;
  }
  function dBoar() {
    const k = kit(), fur = 0x3a2a20, dark = 0x221610, hoof = 0x120c08;
    quadLegs(k, [[0.13, 0.3, 0], [-0.13, 0.3, PI], [0.13, -0.32, PI], [-0.13, -0.32, 0]], 0.46, 0.46, 0.06, dark, hoof);
    k.p('sph', fur, 0, 0.58, 0, 0.26, 0.3, 0.55); k.p('sph', 0x4a3628, 0, 0.5, 0.02, 0.22, 0.2, 0.45);
    k.p('sph', fur, 0, 0.68, 0.26, 0.25, 0.3, 0.3);
    for (let i = 0; i < 7; i++) k.p('cone', 0x1a100a, 0, 0.92 - i * 0.025, 0.36 - i * 0.12, 0.05, 0.18, 0.08, -0.35);
    k.rig = [7, 0.62, -0.52, 0]; k.p('cyl', dark, 0, 0.6, -0.6, 0.015, 0.2, 0.015, -0.9);
    k.rig = [2, 0.62, 0.45, 0];
    k.p('sph', fur, 0, 0.56, 0.64, 0.17, 0.18, 0.22); k.p('cyl', 0x6a4a3a, 0, 0.48, 0.84, 0.075, 0.14, 0.07, PI / 2);
    k.p('cyl', 0x2a1a14, 0, 0.48, 0.915, 0.06, 0.01, 0.055, PI / 2);
    k.m('cone', 0xf0e6cc, 0.08, 0.5, 0.84, 0.022, 0.14, 0.022, 0.2, 0, -0.55);
    k.m('cone', fur, 0.11, 0.73, 0.58, 0.04, 0.1, 0.03, -0.2, 0, -0.7);
    k.m('ball', 0x3a0804, 0.09, 0.62, 0.78, 0.018, 0.014, 0.014);
    k.rig = null;
    return k;
  }
  function dGoat() {
    const k = kit(), fur = 0xd6cebc, dark = 0x8a8270, hoof = 0x2a241e;
    quadLegs(k, [[0.1, 0.3, 0], [-0.1, 0.3, PI], [0.1, -0.3, PI], [-0.1, -0.3, 0]], 0.66, 0.64, 0.05, fur, hoof, dark);
    k.p('sph', fur, 0, 0.76, 0, 0.2, 0.23, 0.42);
    for (let i = 0; i < 5; i++) k.m('cone', 0xc2b8a4, 0.14, 0.58, 0.28 - i * 0.14, 0.05, 0.16, 0.06, PI, 0, 0.3);
    k.rig = [7, 0.8, -0.4, 0]; k.p('cone', fur, 0, 0.86, -0.44, 0.04, 0.1, 0.03, -2.4);
    k.rig = [2, 0.86, 0.34, 0];
    k.p('tapd', fur, 0, 0.94, 0.4, 0.07, 0.28, 0.07, 0.5);
    k.p('sph', fur, 0, 1.06, 0.52, 0.07, 0.085, 0.14, 0.5);
    k.m('cone', 0x3a3026, 0.05, 1.2, 0.44, 0.03, 0.24, 0.03, -1.0, 0, -0.25);
    k.p('cone', 0xb0a898, 0, 0.94, 0.6, 0.03, 0.12, 0.02, PI);
    k.m('ball', 0x201810, 0.05, 1.09, 0.6, 0.014, 0.014, 0.014);
    k.rig = null;
    return k;
  }
  function dOx() {
    const k = kit(), fur = 0x5a3e2a, dark = 0x3a2818, hoof = 0x1a120c;
    quadLegs(k, [[0.22, 0.5, 0], [-0.22, 0.5, PI], [0.22, -0.52, PI], [-0.22, -0.52, 0]], 0.86, 0.86, 0.1, fur, hoof, dark);
    k.p('sph', fur, 0, 1.1, 0, 0.36, 0.42, 0.85); k.p('sph', 0x6a4a32, 0, 1.38, 0.45, 0.26, 0.2, 0.3);
    k.p('box', 0x5a3a1e, 0, 1.38, 0.78, 0.8, 0.08, 0.1);                       // yoke
    k.rig = [7, 1.2, -0.82, 0]; k.p('cyl', dark, 0, 0.9, -0.86, 0.02, 0.6, 0.02, -0.2); k.p('sph', 0x1a120c, 0, 0.6, -0.9, 0.04, 0.08, 0.04);
    k.rig = [2, 1.2, 0.8, 0];
    k.p('sph', fur, 0, 1.08, 1.02, 0.16, 0.2, 0.24); k.p('sph', 0xa08a70, 0, 0.98, 1.2, 0.12, 0.1, 0.1);
    k.m('cone', 0xe6dac0, 0.22, 1.2, 0.98, 0.04, 0.34, 0.04, 0, 0, -1.3); k.m('cone', 0xe6dac0, 0.36, 1.3, 0.98, 0.03, 0.14, 0.03, 0, 0, -0.3);
    k.m('ball', 0x100808, 0.12, 1.12, 1.18, 0.02, 0.02, 0.02);
    k.rig = null;
    return k;
  }
  function dCart() {
    const k = kit(), wood = 0x6a4424, dk = 0x4a2e18, iron = 0x3a3a40;
    k.rig = [6, 0.55, -0.2, 1 / 0.55];
    k.m('cyl', dk, 0.7, 0.55, -0.2, 0.55, 0.07, 0.55, 0, 0, PI / 2);
    k.m('cyl', iron, 0.74, 0.55, -0.2, 0.2, 0.08, 0.2, 0, 0, PI / 2);
    k.m('box', wood, 0.7, 0.55, -0.2, 0.04, 1.02, 0.07); k.m('box', wood, 0.7, 0.55, -0.2, 0.04, 0.07, 1.02);
    k.rig = null;
    k.p('box', wood, 0, 0.95, 0, 1.2, 0.12, 2.0);
    k.m('box', dk, 0.58, 1.17, 0, 0.05, 0.34, 2.0); k.p('box', dk, 0, 1.17, -0.98, 1.2, 0.34, 0.05);
    k.m('box', dk, 0.34, 0.88, 1.6, 0.05, 0.06, 1.5);
    k.mask = 1; k.p('arch', W, 0, 1.2, -0.2, 0.62, 0.72, 1.5); k.mask = 0;
    k.p('arch', dk, 0, 1.2, 0.56, 0.64, 0.74, 0.06); k.p('arch', dk, 0, 1.2, -0.96, 0.64, 0.74, 0.06);
    k.p('cyl', 0x7a5230, -0.3, 1.26, 0.72, 0.16, 0.34, 0.16); k.p('box', 0x8a6a40, 0.25, 1.2, 0.74, 0.34, 0.3, 0.3);
    k.p('sph', 0xb09870, 0.05, 1.22, 0.86, 0.16, 0.14, 0.12);
    return k;
  }
  function dBird(o) {
    const k = kit(), c = o.col, c2 = o.wing;
    k.p('sph', c, 0, 0, 0, o.w * 0.5, o.w * 0.5, o.len); k.p('box', c2, 0, 0, -o.len * 1.1, o.w * 0.45, 0.012, o.len * 0.7);
    k.rig = [2, 0.03, o.len * 0.6, 0];
    k.p('sph', o.head || c, 0, o.w * 0.3, o.len * 1.02, o.w * 0.36, o.w * 0.36, o.w * 0.42);
    k.p('cone', o.beak, 0, o.w * 0.26, o.len * 1.02 + o.w * 0.5, o.w * 0.1, o.w * 0.45, o.w * 0.1, PI / 2);
    k.rig = null;
    for (const s of [1, -1]) {
      k.rig = [5, 0.02, s, 0];
      k.p('box', c2, s * o.span * 0.28, 0.02, 0, o.span * 0.56, 0.014, o.len * 0.8);
      k.p('box', c2, s * o.span * 0.72, 0.02, -o.len * 0.2, o.span * 0.36, 0.01, o.len * 0.62, 0, s * 0.25, 0);
    }
    k.rig = null;
    if (o.legs) k.m('cyl', 0x2a2420, 0.03, -o.w * 0.6, 0, 0.008, o.w * 0.5, 0.008);
    return k;
  }
  function dBat() {
    const k = kit(), c = 0x1a1414;
    k.p('sph', c, 0, 0, 0, 0.045, 0.045, 0.07); k.m('cone', c, 0.02, 0.05, 0.05, 0.012, 0.04, 0.012);
    for (const s of [1, -1]) { k.rig = [5, 0, s, 0]; k.p('box', 0x2a1a1a, s * 0.13, 0, 0, 0.2, 0.008, 0.12); k.p('cone', 0x2a1a1a, s * 0.24, 0, -0.05, 0.05, 0.08, 0.008, PI / 2, 0, s * 0.6); }
    k.rig = null;
    return k;
  }
  function dFish() {
    const k = kit();
    k.p('sph', 0xa8b4bc, 0, 0, 0, 0.06, 0.085, 0.24); k.p('sph', 0x4a5a64, 0, 0.04, 0, 0.045, 0.05, 0.2);
    k.m('ball', 0x080808, 0.04, 0.02, 0.17, 0.012, 0.012, 0.012);
    k.rig = [7, 0, -0.2, 0]; k.p('box', 0x7a8a96, 0, 0, -0.3, 0.012, 0.15, 0.12);
    k.rig = null;
    return k;
  }
  function dDragon() {
    const k = kit(), sc = 0x1a1010, bel = 0x3a1810, horn = 0x8a7a60;
    k.p('sph', sc, 0, 0, 0, 1.3, 1.1, 4.2); k.p('sph', bel, 0, -0.4, 0.3, 1.0, 0.75, 3.4);
    k.p('tapd', sc, 0, 0.7, 4.8, 0.55, 3.4, 0.6, 1.15);
    k.p('box', sc, 0, 1.45, 6.7, 0.75, 0.55, 1.7); k.p('box', bel, 0, 1.05, 6.9, 0.58, 0.25, 1.4);
    k.m('cone', horn, 0.35, 1.95, 5.9, 0.12, 1.2, 0.12, -1.15); k.m('cone', horn, 0.5, 1.4, 6.0, 0.08, 0.6, 0.08, -1.3, 0, -0.5);
    k.mask = 3; k.m('ball', 0xff3a10, 0.34, 1.58, 7.2, 0.1, 0.07, 0.12); k.mask = 0;
    k.p('tapd', sc, 0, -0.1, -5.4, 0.7, 3.0, 0.65, PI / 2); k.p('tapd', sc, 0, -0.25, -8.2, 0.42, 3.0, 0.4, PI / 2);
    k.p('cone', sc, 0, -0.35, -10.4, 0.25, 2.0, 0.25, -PI / 2); k.p('box', sc, 0, -0.35, -11.2, 1.2, 0.08, 0.9);
    for (let i = 0; i < 9; i++) k.p('cone', horn, 0, 1.05 - i * 0.03, 3.0 - i * 1.0, 0.13, 0.6, 0.13, -0.5);
    k.m('tapd', sc, 0.8, -0.9, -1.8, 0.3, 1.4, 0.35, 1.0); k.m('tapd', sc, 0.8, -0.8, 1.6, 0.25, 1.1, 0.3, 1.2);
    for (const s of [1, -1]) {
      k.rig = [5, 0.6, s, 0];
      k.p('box', sc, s * 3.3, 0.7, 0.8, 6.6, 0.26, 0.3);
      k.p('box', 0x2a1414, s * 4.4, 0.6, -1.4, 8.0, 0.06, 4.0);
      k.p('box', 0x241010, s * 8.6, 0.6, -0.8, 1.4, 0.05, 2.6, 0, s * 0.4, 0);
      k.p('box', sc, s * 7.0, 0.66, -1.8, 0.14, 0.14, 4.4, 0, s * 0.35, 0);
      k.p('box', sc, s * 4.5, 0.66, -2.2, 0.14, 0.14, 4.4, 0, s * 0.12, 0);
    }
    k.rig = null;
    return k;
  }

  // ── Designs: people (Frazetta proportions; the right hand is at -X) ───────
  function body(k, o) {
    const th = o.th || 1, skin = o.skin || 0xb88060, boot = o.boot || 0x2a1a10;
    for (const [s, ph] of [[1, 0], [-1, PI]]) {
      k.rig = [1, 0.93, 0, ph]; k.mask = 2;
      k.p('tapd', W, s * 0.1 * th, 0.7, 0, 0.088 * th, 0.46, 0.092 * th);
      k.p('tapd', W, s * 0.1 * th, 0.33, 0.01, 0.068 * th, 0.4, 0.072 * th);
      k.mask = 0;
      k.p('box', boot, s * 0.1 * th, 0.075, 0.045, 0.105 * th, 0.15, 0.22); k.p('cyl', boot, s * 0.1 * th, 0.21, 0.01, 0.075 * th, 0.14, 0.078 * th);
    }
    k.rig = null; k.mask = 1;
    k.p('tapd', W, 0, 1.2, 0, 0.19 * th, 0.52, 0.13 * th);
    k.p('sph', W, 0, 1.38, 0.01, 0.215 * th, 0.15, 0.14 * th);
    k.p('sph', W, 0, 0.98, 0, 0.17 * th, 0.12, 0.12 * th);
    k.mask = 0;
    k.p('cyl', o.belt || 0x3a2414, 0, 0.99, 0, 0.178 * th, 0.06, 0.128 * th); k.p('box', 0xa08850, 0, 0.99, 0.128 * th, 0.045, 0.045, 0.02);
    k.p('cyl', skin, 0, 1.55, 0, 0.05, 0.1, 0.05);
    k.p('sph', skin, 0, 1.68, 0.01, 0.1, 0.12, 0.11); k.p('box', skin, 0, 1.67, 0.11, 0.026, 0.045, 0.03);
    k.m('box', 0x140a06, 0.037, 1.7, 0.1, 0.024, 0.012, 0.012);
    if (o.beard) { k.p('sph', o.beard, 0, 1.6, 0.07, 0.085, 0.075, 0.065); k.p('cone', o.beard, 0, 1.53, 0.09, 0.05, 0.1, 0.04, PI); }
    if (o.hair) k.p('sph', o.hair, 0, 1.73, -0.015, 0.107, 0.1, 0.112);
    for (const [s, ph, code] of [[1, PI, 3], [-1, 0, 4]]) {
      k.rig = [code, 1.46, 0, ph]; k.mask = 1;
      k.p('sph', W, s * 0.235 * th, 1.45, 0, 0.082 * th, 0.082 * th, 0.078 * th);
      k.p('tapd', W, s * 0.255 * th, 1.3, 0, 0.062 * th, 0.3, 0.064 * th);
      k.p('tapd', W, s * 0.268 * th, 1.03, 0.01, 0.052 * th, 0.27, 0.054 * th);
      k.mask = 0;
      k.p('sph', skin, s * 0.272 * th, 0.86, 0.02, 0.046, 0.056, 0.043);
    }
    k.rig = null; k.mask = 0;
  }
  const RARM = [4, 1.46, 0, 0], LARM = [3, 1.46, 0, PI];
  const HUMANS = {
    merchant() {
      const k = kit(); body(k, { th: 1.12, skin: 0xc89070, beard: 0x6a4a30 });
      k.mask = 1; k.p('sph', W, 0, 1.12, 0.06, 0.22, 0.23, 0.18);
      k.mask = 0; k.p('box', 0xc8b890, 0, 1.0, 0.18, 0.28, 0.52, 0.02);
      k.mask = 2; k.p('cyl', W, 0, 1.8, 0, 0.23, 0.02, 0.23); k.p('tapd', W, 0, 1.88, 0, 0.11, 0.15, 0.11);
      k.mask = 0; k.p('sph', 0x6a4a20, 0.16, 0.92, 0.1, 0.05, 0.065, 0.04);
      return k;
    },
    pilgrim() {
      const k = kit(); body(k, { skin: 0xd0a080 });
      k.mask = 1; k.p('tapu', W, 0, 0.64, 0, 0.26, 1.18, 0.21);
      k.mask = 2; k.p('sph', W, 0, 1.71, -0.02, 0.127, 0.142, 0.137); k.p('tapu', W, 0, 1.5, -0.02, 0.2, 0.18, 0.17);
      k.mask = 0; k.p('cyl', 0x8a7a50, 0, 1.0, 0, 0.2, 0.025, 0.16);
      k.rig = LARM; k.p('cyl', 0x5a3a20, 0.28, 1.12, 0.07, 0.018, 1.95, 0.018); k.p('sph', 0x5a3a20, 0.28, 2.1, 0.07, 0.035, 0.04, 0.035);
      k.rig = RARM; k.p('cyl', 0x2a2a2a, -0.272, 0.78, 0.04, 0.008, 0.12, 0.008);
      k.p('box', 0x3a3028, -0.272, 0.7, 0.04, 0.1, 0.02, 0.1); k.p('box', 0x3a3028, -0.272, 0.52, 0.04, 0.1, 0.02, 0.1);
      k.mask = 3; k.p('box', 0xffa040, -0.272, 0.61, 0.04, 0.075, 0.16, 0.075);
      k.rig = null; k.mask = 0;
      return k;
    },
    bard() {
      const k = kit(); body(k, { skin: 0xd8a888, hair: 0x8a4a20 });
      k.mask = 2; k.p('sph', W, 0, 1.77, 0, 0.125, 0.07, 0.13); k.p('box', W, 0, 1.08, -0.16, 0.36, 0.78, 0.025, 0.08);
      k.mask = 0; k.p('box', 0xc02010, 0.08, 1.88, -0.07, 0.015, 0.22, 0.045, -0.6, 0, -0.4);
      k.p('box', 0x4a2a14, 0, 1.62, 0.1, 0.07, 0.015, 0.02);
      k.p('sph', 0x8a5a2a, 0.02, 1.1, 0.19, 0.13, 0.17, 0.06, 0, 0, -0.7); k.p('cyl', 0x2a1408, 0.02, 1.1, 0.25, 0.035, 0.01, 0.035, PI / 2);
      k.p('box', 0x5a3818, 0.18, 1.3, 0.2, 0.035, 0.36, 0.02, 0, 0, -0.7); k.p('box', 0x3a2410, 0.3, 1.43, 0.2, 0.05, 0.08, 0.025, 0, 0, -0.7);
      return k;
    },
    militia() {
      const k = kit(); body(k, { skin: 0xb08060, th: 1.08, beard: 0x3a2a1a });
      k.mask = 1; k.p('tapu', W, 0, 0.9, 0, 0.215, 0.3, 0.17);
      k.mask = 0; k.p('sph', 0x6a6a72, 0, 1.765, 0, 0.118, 0.085, 0.123); k.p('cyl', 0x55555c, 0, 1.75, 0, 0.175, 0.015, 0.175);
      k.p('cyl', 0x707078, 0, 1.52, 0, 0.12, 0.06, 0.1);
      k.rig = LARM; k.mask = 1; k.p('cyl', W, 0.34, 1.08, 0.05, 0.3, 0.035, 0.3, 0, -0.5, PI / 2);
      k.mask = 0; k.p('sph', 0x8a8a90, 0.365, 1.08, 0.09, 0.05, 0.05, 0.05);
      k.rig = RARM; k.p('cyl', 0x5a3a20, -0.272, 1.25, 0.1, 0.018, 2.2, 0.018, 0.25); k.p('cone', 0xb8b8c4, -0.272, 2.36, 0.39, 0.03, 0.22, 0.03, 0.25);
      k.rig = null;
      return k;
    },
    knight() {
      const k = kit(), st = 0x9aa0a8; body(k, { skin: 0xc09070, th: 1.12, boot: 0x3a3a40 });
      k.p('sph', st, 0, 1.36, 0.035, 0.235, 0.17, 0.15); k.m('sph', st, 0.27, 1.48, 0, 0.1, 0.075, 0.1);
      k.p('cyl', st, 0, 1.71, 0.01, 0.12, 0.22, 0.125); k.p('sph', st, 0, 1.82, 0.01, 0.12, 0.05, 0.125); k.p('box', 0x0a0a0a, 0, 1.73, 0.128, 0.16, 0.02, 0.01);
      k.mask = 1; k.p('box', W, 0, 1.06, 0.155, 0.25, 0.64, 0.02);
      k.mask = 2; k.p('cone', W, 0, 1.97, -0.03, 0.05, 0.26, 0.08); k.p('box', W, 0, 1.0, -0.18, 0.42, 0.98, 0.025, 0.1);
      k.mask = 0;
      k.rig = LARM; k.p('box', st, 0.36, 1.05, 0.06, 0.04, 0.5, 0.34, 0, 0.35, 0);
      k.rig = RARM; k.p('cyl', 0x2a1a10, -0.272, 0.86, 0.06, 0.022, 0.18, 0.022, PI / 2); k.p('box', 0x8a7a50, -0.272, 0.86, 0.15, 0.22, 0.03, 0.035);
      k.p('box', 0xd8dce4, -0.272, 0.52, 0.42, 0.05, 0.016, 1.0, 0.785);
      k.rig = null;
      return k;
    },
    woodcutter() {
      const k = kit(); body(k, { skin: 0xb07850, th: 1.1, beard: 0x5a3a20 });
      k.mask = 2; k.p('sph', W, 0, 1.755, -0.01, 0.115, 0.085, 0.12);
      k.mask = 0; k.p('cyl', 0x6a4a2a, -0.2, 1.55, -0.05, 0.022, 0.95, 0.022, -1.2); k.p('box', 0x7a7a80, -0.2, 1.74, -0.47, 0.025, 0.18, 0.13, -1.2);
      for (let i = 0; i < 3; i++) k.p('cyl', 0x6a4a30, (i - 1) * 0.05, 1.3 + (i % 2) * 0.08, -0.22, 0.05, 0.7, 0.05, 0, 0, PI / 2);
      return k;
    },
    hunter() {
      const k = kit(); body(k, { skin: 0xb88058 });
      k.mask = 2; k.p('sph', W, 0, 1.715, -0.02, 0.125, 0.14, 0.135); k.p('box', W, 0, 1.2, -0.15, 0.38, 0.62, 0.025, 0.08);
      k.mask = 0; k.p('cyl', 0x5a3a20, 0.1, 1.38, -0.2, 0.055, 0.45, 0.055, 0, 0, 0.3); k.p('cone', 0xc02010, 0.18, 1.63, -0.2, 0.04, 0.1, 0.04, 0, 0, 0.3);
      k.rig = LARM; k.p('box', 0x5a3a18, 0.3, 1.14, 0.07, 0.022, 0.55, 0.03, 0.25); k.p('box', 0x5a3a18, 0.3, 0.62, 0.07, 0.022, 0.55, 0.03, -0.25);
      k.p('box', 0xd8d0c0, 0.3, 0.88, -0.0, 0.004, 1.02, 0.004);
      k.rig = null;
      return k;
    },
    refugee() {
      const k = kit(); body(k, { skin: 0xc89878, th: 0.95, hair: 0x4a3a2a });
      k.mask = 1; k.p('tapu', W, 0, 1.0, -0.02, 0.24, 0.92, 0.19);
      k.mask = 2; k.p('sph', W, 0, 1.72, -0.03, 0.118, 0.12, 0.125); k.p('tapu', W, 0, 1.52, -0.02, 0.18, 0.14, 0.15);
      k.mask = 0; k.p('sph', 0x8a7a5a, 0, 1.3, -0.26, 0.17, 0.2, 0.13); k.p('box', 0x4a3a28, 0, 1.36, -0.02, 0.3, 0.03, 0.26, 0.3);
      return k;
    },
  };

  // ── Designs: event props (static; cached geometries) ──────────────────────
  const PROPS = {
    crates() {
      const k = kit();
      k.p('box', 0x7a5a34, 1.4, 0.25, 0.4, 0.5, 0.5, 0.5, 0, 0.4); k.p('box', 0x6a4a2a, -1.5, 0.2, -0.6, 0.45, 0.4, 0.45, 0.3, 0.7, 0.2);
      k.p('cyl', 0x6a4424, 0.6, 0.28, -1.8, 0.24, 0.56, 0.24, PI / 2, 0.9); k.p('sph', 0xb09870, -0.4, 0.14, 1.6, 0.25, 0.14, 0.2);
      k.p('box', 0xc8b890, 2.2, 0.03, -0.8, 0.9, 0.04, 0.6, 0, 0.5); k.p('cyl', 0x4a2e18, -2.3, 0.08, 1.1, 0.5, 0.06, 0.5, 0.2, 0, 1.3);
      return k;
    },
    barrier() {
      const k = kit(), wd = 0x5a3a20, dk = 0x3a2412;
      for (const s of [1, -1]) {
        k.p('cyl', dk, s * 3.2, 0.7, 0.25, 0.08, 1.6, 0.08, 0.5, 0, 0); k.p('cyl', dk, s * 3.2, 0.7, -0.25, 0.08, 1.6, 0.08, -0.5, 0, 0);
        k.p('cyl', dk, s * 4.6, 1.2, 0, 0.05, 2.4, 0.05); k.p('sph', 0xe0d4b8, s * 4.6, 2.46, 0, 0.12, 0.14, 0.13); k.p('box', 0x100808, s * 4.6, 2.46, 0.12, 0.09, 0.03, 0.01);
      }
      k.p('cyl', wd, 0, 1.15, 0, 0.12, 7.4, 0.12, 0, 0, PI / 2);
      for (let i = -3; i <= 3; i++) k.p('cone', 0x8a6a40, i * 0.9, 1.15, 0.3, 0.05, 0.7, 0.05, 1.2);
      k.p('box', 0x7a1a12, 0.8, 0.78, 0.13, 0.7, 0.6, 0.02);
      return k;
    },
    campfire() {
      const k = kit();
      for (let i = 0; i < 9; i++) { const a = i / 9 * TAU; k.p('ico', 0x5a5550, Math.sin(a) * 0.62, 0.08, Math.cos(a) * 0.62, 0.16, 0.12, 0.14); }
      for (let i = 0; i < 4; i++) { const a = i / 4 * TAU + 0.3; k.p('cyl', 0x3a2414, Math.sin(a) * 0.18, 0.14, Math.cos(a) * 0.18, 0.05, 0.7, 0.05, PI / 2 - 0.3, a, 0); }
      k.mask = 3; k.p('ico', 0xff5010, 0, 0.12, 0, 0.18, 0.08, 0.18); k.mask = 0;
      k.p('box', 0x5a3a20, 1.6, 0.2, 0.4, 1.2, 0.3, 0.3, 0, 0.6); k.p('box', 0x5a3a20, -1.5, 0.2, -0.3, 1.1, 0.3, 0.3, 0, -0.4);
      return k;
    },
    shrine() {
      const k = kit(), st = 0x5a6070, dk = 0x3a404a;
      k.p('box', st, 0, 1.6, 0, 1.1, 3.4, 0.7, 0.04, 0, 0.05); k.p('ico', st, 0, 3.3, 0, 0.62, 0.3, 0.4);
      k.p('box', dk, 0, 0.25, 1.0, 1.4, 0.5, 0.8); k.p('ico', dk, 1.4, 0.3, -0.6, 0.6, 0.5, 0.5); k.p('ico', dk, -1.3, 0.25, 0.5, 0.5, 0.4, 0.5);
      k.mask = 3;
      for (const f of [1, -1]) {
        for (let i = 0; i < 6; i++) k.p('box', 0x40ffc0, (i % 2 ? 0.18 : -0.18) * (i % 3 === 0 ? 0.5 : 1), 0.8 + i * 0.42, 0.36 * f, 0.24 + (i % 3) * 0.08, 0.06, 0.02);
        k.p('box', 0x40ffc0, 0, 2.2, 0.36 * f, 0.06, 1.8, 0.02); k.p('ico', 0x40ffc0, 0, 3.0, 0.3 * f, 0.12, 0.12, 0.03);
      }
      k.m('box', 0x40ffc0, 0.56, 1.6, 0, 0.02, 1.4, 0.05);
      for (const [x, z] of [[-0.45, 1.2], [0.5, 1.15], [0.1, 1.3]]) { k.mask = 0; k.p('cyl', 0xe8e0c8, x, 0.62, z, 0.04, 0.24, 0.04); k.mask = 3; k.p('cone', 0xffa040, x, 0.8, z, 0.03, 0.1, 0.03); }
      k.mask = 0; k.p('sph', 0xe0d4b8, -0.2, 0.58, 0.9, 0.1, 0.12, 0.11); k.p('cyl', 0xd8c8a0, 0.35, 0.56, 0.95, 0.012, 0.3, 0.012, 0, 0, 1.2);
      return k;
    },
    chest() {
      const k = kit(), wd = 0x6a3a1a, ir = 0x3a3a40;
      k.p('box', wd, 0, 0.3, 0, 0.9, 0.5, 0.56); k.p('arch', wd, 0, 0.55, 0, 0.45, 0.22, 0.56);
      k.m('box', ir, 0.3, 0.3, 0, 0.06, 0.52, 0.58); k.m('arch', ir, 0.3, 0.55, 0, 0.47, 0.24, 0.06);
      k.p('box', 0xc0a040, 0, 0.45, 0.29, 0.1, 0.12, 0.02);
      k.mask = 3; k.p('ico', 0xffc040, 0.55, 0.06, 0.3, 0.12, 0.05, 0.12); k.p('ico', 0xffc040, 0.72, 0.04, 0.05, 0.08, 0.04, 0.08); k.mask = 0;
      return k;
    },
    trollden() {
      const k = kit();
      for (let i = 0; i < 14; i++) { const a = rnd() * TAU, r = R(0.3, 2.2); k.p('cyl', 0xe0d4b8, Math.sin(a) * r, 0.05, Math.cos(a) * r, 0.03, R(0.3, 0.6), 0.03, PI / 2, rnd() * TAU, 0); }
      for (let i = 0; i < 5; i++) { const a = rnd() * TAU, r = R(0.4, 2); k.p('sph', 0xe8dcc0, Math.sin(a) * r, 0.1, Math.cos(a) * r, 0.12, 0.13, 0.14, rnd(), rnd() * 3, 0); }
      k.p('cyl', 0x4a2e18, 3, 1.1, 0, 0.06, 2.2, 0.06); k.p('box', 0x6a4a2a, 3, 1.9, 0.05, 0.9, 0.5, 0.05, 0, 0, 0.1);
      k.p('box', 0x8a1010, 2.8, 1.95, 0.09, 0.14, 0.3, 0.01); k.p('box', 0x8a1010, 3.05, 1.95, 0.09, 0.14, 0.3, 0.01); k.p('box', 0x8a1010, 3.3, 1.95, 0.09, 0.12, 0.3, 0.01);
      return k;
    },
    wheel() {   // a broken cart wheel and splinters (wrecks)
      const k = kit();
      k.p('cyl', 0x4a2e18, 0, 0.06, 0, 0.55, 0.07, 0.55); k.p('box', 0x5a3a20, 0.8, 0.04, 0.6, 1.2, 0.05, 0.12, 0, 0.7); k.p('box', 0x5a3a20, -0.9, 0.04, -0.4, 0.9, 0.05, 0.1, 0, -0.3);
      return k;
    },
    banner() {
      const k = kit();
      k.p('cyl', 0x3a2412, 0, 1.6, 0, 0.03, 3.2, 0.03); k.p('cyl', 0x3a2412, 0, 3.0, 0, 0.022, 0.9, 0.022, 0, 0, PI / 2);
      k.p('box', 0x7a1010, 0, 2.5, 0.02, 0.8, 1.0, 0.02); k.p('box', 0x5a0808, 0, 1.92, 0.02, 0.8, 0.18, 0.02, 0, 0, 0.1);
      k.p('sph', 0xe0d4b8, 0, 2.6, 0.06, 0.16, 0.18, 0.06); k.p('box', 0x100808, 0, 2.6, 0.12, 0.2, 0.05, 0.01);
      k.p('sph', 0xe0d4b8, 0, 3.3, 0, 0.1, 0.12, 0.11);
      return k;
    },
  };
  const PGEO = {};
  function propGeo(name) { return PGEO[name] || (PGEO[name] = build(PROPS[name]())); }
  function gravesGeo(spots) {
    const k = kit();
    for (const [x, z] of spots) {
      k.p('sph', 0x3a2c1e, x, 0.02, z, 0.6, 0.28, 1.1, 0, R(-0.3, 0.3), 0);
      if (rnd() < 0.6) k.p('box', 0x6a6a70, x, 0.45, z - 1.0, 0.45, 0.9, 0.12, R(-0.15, 0.15), R(-0.2, 0.2), R(-0.25, 0.25));
      else { k.p('cyl', 0x3a2818, x, 0.55, z - 1.0, 0.04, 1.1, 0.04, R(-0.2, 0.2), 0, R(-0.3, 0.3)); k.p('box', 0x3a2818, x, 0.8, z - 1.0, 0.45, 0.06, 0.06, 0, 0, R(-0.3, 0.3)); }
    }
    k.p('cyl', 0x2a2018, 3.5, 2.2, -4, 0.14, 4.4, 0.14, 0, 0, 0.1); k.p('cyl', 0x2a2018, 3.1, 3.6, -4, 0.06, 2.0, 0.06, 0, 0, 0.9);
    k.p('cyl', 0x2a2018, 4.1, 3.3, -4, 0.05, 1.6, 0.05, 0, 0, -0.8);
    return build(k);
  }

  // ── Instanced pools ────────────────────────────────────────────────────────
  const POOLS = {};
  let SHP = null, GLP = null;
  const VIEW = { hare: 80, crow: 110, bat: 60, fish: 70, eagle: 400, dragon: 900 };
  function mkPool(name, k, max) {
    const geo = build(k);
    const anim = new Float32Array(max * 4), t1 = new Float32Array(max * 3).fill(1), t2 = new Float32Array(max * 3).fill(1);
    geo.setAttribute('aAnim', new T.InstancedBufferAttribute(anim, 4).setUsage(T.DynamicDrawUsage));
    geo.setAttribute('aTint', new T.InstancedBufferAttribute(t1, 3).setUsage(T.DynamicDrawUsage));
    geo.setAttribute('aTint2', new T.InstancedBufferAttribute(t2, 3).setUsage(T.DynamicDrawUsage));
    const mesh = new T.InstancedMesh(geo, MAT, max);
    mesh.instanceMatrix.setUsage(T.DynamicDrawUsage); mesh.frustumCulled = false; mesh.count = 0; mesh.visible = false; mesh.name = 'life_' + name;
    root.add(mesh);
    POOLS[name] = { mesh, max, n: 0, anim, t1, t2, arr: mesh.instanceMatrix.array, geo, view: VIEW[name] || 210 };
  }
  function simplePool(geo, mat, max) {
    const mesh = new T.InstancedMesh(geo, mat, max);
    mesh.instanceMatrix.setUsage(T.DynamicDrawUsage); mesh.frustumCulled = false; mesh.count = 0; mesh.renderOrder = 1;
    root.add(mesh);
    return { mesh, max, n: 0, arr: mesh.instanceMatrix.array };
  }

  // ── Entities: everything drawn through the pools ──────────────────────────
  const ENTS = [];
  function ent(pool, x, z, o) {
    const e = Object.assign({ pool, x, z, y: H(x, z), yaw: 0, pitch: 0, roll: 0, s: 1, a0: rnd() * TAU, a1: 0, a2: 0, a3: 0, lift: 0, tint: null, tint2: null, sh: 0.45, vis: true, ph: rnd() * TAU }, o || {});
    ENTS.push(e); return e;
  }
  function drop(e) { if (!e || e.gone) return; const i = ENTS.indexOf(e); if (i >= 0) { ENTS[i] = ENTS[ENTS.length - 1]; ENTS.pop(); } e.gone = true; if (e.inter) { uninter(e.inter); e.inter = null; } kitDrop(e); }
  const hexT = h => { COL.set(h); return [COL.r, COL.g, COL.b]; };

  // ── Humanoid kit (humanoid.js): travellers get skinned rigs; the pools stay as the fallback ──
  const KROLE = { merchant: 'merchant', pilgrim: 'pilgrim', militia: 'militia', bard: 'bard', woodcutter: 'woodcutter', hunter: 'hunter', refugee: 'refugee', knight: 'knight' };
  let KIT = null, KDT = 0;
  function kitOn() { if (KIT === null) KIT = !!(CT.humanoid && typeof CT.humanoid.build === 'function'); return KIT; }
  const hexOf = t => (t ? '#' + COL.setRGB(t[0], t[1], t[2]).getHexString() : null);
  function kitSpec(role, seed, t1, t2) {
    const pal = {};
    const put = (k, v) => { if (v) pal[k] = v; };
    if (role === 'militia' || role === 'knight') { put('accent', t1); if (role === 'militia') put('legs', t2); }
    else { put('top', t1); if (role !== 'woodcutter' && role !== 'bard') put('cloth', t2); if (role === 'bard') put('legs', t2); }
    return { preset: KROLE[role], seed: 1 + seed, pal };
  }
  function kitSpecs() { const out = []; for (const r in KROLE) for (let i = 0; i < 3; i++) out.push(kitSpec(r, i)); return out; }
  function kitDraw(e, cam) {
    const dx = e.x - cam.x, dz = e.z - cam.z, d2 = dx * dx + dz * dz;
    if (d2 > 210 * 210) { if (e.rig) e.rig.root.visible = false; return false; }
    if (!e.rig) {
      if (e.kseed == null) e.kseed = (rnd() * 3) | 0;
      try { e.rig = CT.humanoid.build(kitSpec(e.role, e.kseed, hexOf(e.tint), hexOf(e.tint2))); } catch (err) { console.warn('[life] humanoid kit failed, pools used', err); KIT = false; return false; }
      root.add(e.rig.root);
    }
    const r = e.rig, H_ = CT.humanoid; r.root.visible = true;
    if (e.dead) { if (!r.anim.dead) H_.kill(r, e.killDir || null); r.root.position.set(e.x, e.y, e.z); r.root.rotation.set(0, e.yaw, 0); }
    else { r.root.position.set(e.x, e.y + e.lift, e.z); r.root.rotation.set(e.pitch, e.yaw, e.roll); }
    r.root.scale.setScalar(e.s);
    if (d2 < 90 * 90) {
      H_.animate(r, KDT, time + e.ph, { speed: e.mode === 'lie' || e.downT > 0 ? 0 : e.spd, work: e.strum > 0 ? 'strum' : null, aggro: !!(e.fighter && e.foe) });
      if (!e.dead && e.a3 > 0.01 && !(e.strum > 0)) { H_.add(r, 'shR', -e.a3 * 0.9, 0, -0.2 * e.a3); H_.add(r, 'elR', -0.35 * e.a3, 0, 0); H_.add(r, 'spine', 0.08 * e.a3, -0.2 * e.a3, 0); H_.applyPose(r); }
    }
    return true;
  }
  function kitDrop(e) { if (e && e.rig) { CT.humanoid.dispose(e.rig); e.rig = null; } }

  function render() {
    for (const k in POOLS) POOLS[k].n = 0;
    SHP.n = 0; GLP.n = 0;
    const cam = core.camera.position;
    for (let i = 0; i < ENTS.length; i++) {
      const e = ENTS[i]; if (!e.vis) { if (e.rig) e.rig.root.visible = false; continue; }
      const kit = e.human && kitOn() && kitDraw(e, cam);
      const pl = POOLS[e.pool]; if (!kit && (!pl || pl.n >= pl.max)) continue;
      const dx = e.x - cam.x, dz = e.z - cam.z, d2 = dx * dx + dz * dz;
      if (d2 > (kit ? 210 * 210 : pl.view * pl.view)) continue;
      if (!kit) {
      const j = pl.n++;
      E1.set(e.pitch, e.yaw, e.roll); Q1.setFromEuler(E1);
      M1.compose(V1.set(e.x, e.y + e.lift, e.z), Q1, S1.set(e.s, e.s, e.s)); M1.toArray(pl.arr, j * 16);
      pl.anim[j * 4] = e.a0; pl.anim[j * 4 + 1] = e.a1; pl.anim[j * 4 + 2] = e.a2; pl.anim[j * 4 + 3] = e.a3;
      const t1 = e.tint, t2 = e.tint2;
      pl.t1[j * 3] = t1 ? t1[0] : 1; pl.t1[j * 3 + 1] = t1 ? t1[1] : 1; pl.t1[j * 3 + 2] = t1 ? t1[2] : 1;
      pl.t2[j * 3] = t2 ? t2[0] : 1; pl.t2[j * 3 + 1] = t2 ? t2[1] : 1; pl.t2[j * 3 + 2] = t2 ? t2[2] : 1;
      }
      if (e.sh > 0 && (d2 < 3600 || e.bigShadow) && SHP.n < SHP.max) {
        const gy = e.gy != null ? e.gy : e.y, r = e.sh * e.s * (e.bigShadow ? 1 : 1 / (1 + Math.max(0, e.y + e.lift - gy) * 0.3));
        M1.makeScale(r, 1, r * (e.shL || 1)); M1.premultiply(M1b.makeRotationY(e.yaw)); M1.setPosition(e.x, gy + 0.06, e.z);
        M1.toArray(SHP.arr, SHP.n++ * 16);
      }
    }
    for (const k in POOLS) {
      const pl = POOLS[k], m = pl.mesh;
      m.count = pl.n; m.visible = pl.n > 0;
      if (pl.n) { m.instanceMatrix.needsUpdate = true; pl.geo.attributes.aAnim.needsUpdate = true; pl.geo.attributes.aTint.needsUpdate = true; pl.geo.attributes.aTint2.needsUpdate = true; }
    }
    // glints: unsearched corpses and unopened chests
    for (const c of CORPSES) if (!c.searched && c.o) glintAt(c.x, c.y + 0.45, c.z, c.ph, cam);
    for (const g of GLINTS) if (g.on) glintAt(g.x, g.y, g.z, g.ph, cam);
    SHP.mesh.count = SHP.n; SHP.mesh.instanceMatrix.needsUpdate = true; SHP.mesh.visible = SHP.n > 0;
    GLP.mesh.count = GLP.n; GLP.mesh.instanceMatrix.needsUpdate = true; GLP.mesh.visible = GLP.n > 0;
  }
  const M1b = new T.Matrix4();
  function glintAt(x, y, z, ph, cam) {
    if (GLP.n >= GLP.max) return;
    const dx = x - cam.x, dz = z - cam.z; if (dx * dx + dz * dz > 2500) return;
    const k = Math.pow(Math.max(0, Math.sin(time * 2.6 + ph)), 6), s = 0.035 + k * 0.1;
    E1.set(0, time * 2 + ph, 0.785); Q1.setFromEuler(E1); M1.compose(V1.set(x, y + 0.05 * Math.sin(time * 1.3 + ph), z), Q1, S1.set(s, s * 1.8, s)); M1.toArray(GLP.arr, GLP.n++ * 16);
  }

  // ── Particles: smoke columns, flames, dust, splashes, runes ───────────────
  let FXA = null, FXN = null, FF = null;
  function makeFx(max, add) {
    const pos = new Float32Array(max * 3), col = new Float32Array(max * 3), siz = new Float32Array(max);
    const g = new T.BufferGeometry(), A = (a, n) => new T.BufferAttribute(a, n).setUsage(T.DynamicDrawUsage);
    g.setAttribute('position', A(pos, 3)); g.setAttribute('color', A(col, 3)); g.setAttribute('aSize', A(siz, 1)); g.setDrawRange(0, 0);
    const mat = new T.ShaderMaterial({
      uniforms: { uS: { value: C.PIX_H / (2 * Math.tan(35 * PI / 180)) }, uA: { value: add ? 1 : 0.78 } },
      vertexShader: 'attribute float aSize; attribute vec3 color; varying vec3 vC; uniform float uS; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = clamp(aSize * uS / max(0.1, -mv.z), 1.0, 72.0); vC = color; }',
      fragmentShader: 'varying vec3 vC; uniform float uA; void main(){ vec2 d = gl_PointCoord - 0.5; if (dot(d, d) > 0.25) discard; gl_FragColor = vec4(vC, uA); }',
      transparent: true, depthWrite: false, blending: add ? T.AdditiveBlending : T.NormalBlending,
    });
    const pts = new T.Points(g, mat); pts.frustumCulled = false; pts.renderOrder = add ? 3 : 2; root.add(pts);
    return { n: 0, max, add, pos, col, siz, g, pts, vel: new Float32Array(max * 3), age: new Float32Array(max), life: new Float32Array(max), s0: new Float32Array(max), s1: new Float32Array(max), c0: new Float32Array(max * 3), grav: new Float32Array(max), mode: new Uint8Array(max) };
  }
  function fx(F, x, y, z, vx, vy, vz, life, s0, s1, hex, grav, mode) {
    if (!F || F.n >= F.max) return;
    const i = F.n++;
    F.pos[i * 3] = x; F.pos[i * 3 + 1] = y; F.pos[i * 3 + 2] = z; F.vel[i * 3] = vx; F.vel[i * 3 + 1] = vy; F.vel[i * 3 + 2] = vz;
    F.age[i] = 0; F.life[i] = life; F.s0[i] = s0; F.s1[i] = s1; F.grav[i] = grav || 0; F.mode[i] = mode || 0;
    COL.set(hex); F.c0[i * 3] = COL.r; F.c0[i * 3 + 1] = COL.g; F.c0[i * 3 + 2] = COL.b;
  }
  const copy3 = (A, i, j) => { A[i * 3] = A[j * 3]; A[i * 3 + 1] = A[j * 3 + 1]; A[i * 3 + 2] = A[j * 3 + 2]; };
  function updFx(F, dt) {
    for (let i = 0; i < F.n; i++) {
      F.age[i] += dt;
      if (F.age[i] >= F.life[i]) {   // swap with the last
        const j = --F.n; if (i === j) break;
        copy3(F.pos, i, j); copy3(F.vel, i, j); copy3(F.c0, i, j);
        F.age[i] = F.age[j]; F.life[i] = F.life[j]; F.s0[i] = F.s0[j]; F.s1[i] = F.s1[j]; F.grav[i] = F.grav[j]; F.mode[i] = F.mode[j];
        i--; continue;
      }
      const k = F.age[i] / F.life[i], i3 = i * 3;
      F.vel[i3 + 1] -= F.grav[i] * dt;
      const drag = Math.exp(-(F.mode[i] === 1 ? 0.6 : 1.8) * dt); F.vel[i3] *= drag; F.vel[i3 + 2] *= drag;
      F.pos[i3] += F.vel[i3] * dt; F.pos[i3 + 1] += F.vel[i3 + 1] * dt; F.pos[i3 + 2] += F.vel[i3 + 2] * dt;
      F.siz[i] = lerp(F.s0[i], F.s1[i], k);
      const f = F.add ? (F.mode[i] === 2 ? Math.sin(k * PI) : 1 - k) : (1 - k * 0.6);
      F.col[i3] = F.c0[i3] * f; F.col[i3 + 1] = F.c0[i3 + 1] * f; F.col[i3 + 2] = F.c0[i3 + 2] * f;
    }
    F.g.setDrawRange(0, F.n);
    F.g.attributes.position.needsUpdate = true; F.g.attributes.color.needsUpdate = true; F.g.attributes.aSize.needsUpdate = true;
  }
  function smoke(x, z, y0) { fx(FXN, x + R(-0.4, 0.4), (y0 != null ? y0 : H(x, z)) + 0.8, z + R(-0.4, 0.4), R(-0.3, 0.3) + 0.5, R(1.8, 2.6), R(-0.3, 0.3), R(7, 10), 0.8, 4.6, rnd() < 0.5 ? 0x2a2420 : 0x3a322c, -0.05, 1); }
  function flame(x, z, y0) {
    const y = (y0 != null ? y0 : H(x, z)) + 0.15;
    fx(FXA, x + R(-0.18, 0.18), y, z + R(-0.18, 0.18), R(-0.2, 0.2), R(1.2, 2.2), R(-0.2, 0.2), R(0.35, 0.6), R(0.3, 0.45), 0.05, rnd() < 0.5 ? 0xff6010 : 0xffa030, -1);
    if (rnd() < 0.2) fx(FXA, x, y + 0.4, z, R(-0.5, 0.5), R(2, 3.5), R(-0.5, 0.5), R(1, 1.8), 0.06, 0.02, 0xffc060, -0.5);
  }
  function dust(x, z, n, col) { const y = H(x, z); for (let i = 0; i < n; i++) { const a = rnd() * TAU, s = R(0.8, 2.5); fx(FXN, x, y + 0.2, z, Math.cos(a) * s, R(0.6, 2.2), Math.sin(a) * s, R(0.7, 1.4), R(0.25, 0.5), R(0.6, 1.1), col || (rnd() < 0.5 ? 0x4a3a28 : 0x2e241a), 2.5); } }
  function splash(x, z) { for (let i = 0; i < 14; i++) { const a = rnd() * TAU, s = R(0.4, 1.4); fx(FXN, x, 0.05, z, Math.cos(a) * s, R(1.5, 3.2), Math.sin(a) * s, R(0.5, 0.8), R(0.08, 0.14), 0.04, 0xd8e8f0, 9); } }

  // Fireflies: a fixed Points cloud around the player on warm nights (swamp, meadow, forest)
  function makeFireflies(n) {
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), siz = new Float32Array(n).fill(0.17);
    const g = new T.BufferGeometry(), A = (a, c) => new T.BufferAttribute(a, c).setUsage(T.DynamicDrawUsage);
    g.setAttribute('position', A(pos, 3)); g.setAttribute('color', A(col, 3)); g.setAttribute('aSize', A(siz, 1));
    const pts = new T.Points(g, FXA.pts.material); pts.frustumCulled = false; pts.visible = false; pts.renderOrder = 3; root.add(pts);
    const ph = new Float32Array(n); for (let i = 0; i < n; i++) ph[i] = rnd() * 100;
    return { n, pos, col, g, pts, ph, on: 0 };
  }
  function updFireflies(dt) {
    const b = BIO(P.x, P.z), want = (isNight() || dusk()) && (b === 'swamp' || b === 'meadow' || b === 'forest') ? 1 : 0;
    FF.on += (want - FF.on) * Math.min(1, dt * 0.5);
    FF.pts.visible = FF.on > 0.02; if (!FF.pts.visible) return;
    const dens = b === 'swamp' ? 1 : 0.55;
    for (let i = 0; i < FF.n; i++) {
      const i3 = i * 3;
      let dx = FF.pos[i3] - P.x, dz = FF.pos[i3 + 2] - P.z;
      if (dx * dx + dz * dz > 1300 || FF.pos[i3 + 1] === 0) {
        const a = rnd() * TAU, r = R(4, 34); FF.pos[i3] = P.x + Math.sin(a) * r; FF.pos[i3 + 2] = P.z + Math.cos(a) * r;
        FF.pos[i3 + 1] = H(FF.pos[i3], FF.pos[i3 + 2]) + R(0.4, 2.4); if (FF.pos[i3 + 1] < 0.3) FF.pos[i3 + 1] = R(0.3, 1.5);
      }
      const p = FF.ph[i] + time;
      FF.pos[i3] += Math.sin(p * 0.7) * 0.35 * dt; FF.pos[i3 + 2] += Math.cos(p * 0.53) * 0.35 * dt; FF.pos[i3 + 1] += Math.sin(p * 1.1) * 0.15 * dt;
      const k = Math.pow(Math.max(0, Math.sin(p * 1.3)), 3) * FF.on * (i / FF.n < dens ? 1 : 0);
      FF.col[i3] = 2.4 * k; FF.col[i3 + 1] = 3.2 * k; FF.col[i3 + 2] = 0.8 * k;
    }
    FF.g.attributes.position.needsUpdate = true; FF.g.attributes.color.needsUpdate = true;
  }

  // ── Sound: a small synth for what audio.js lacks (horn, drum, lute, caws, croaks, screams, chimes) ──
  let AC = null, OUT = null, NB = null;
  function ac() {
    if (AC) return AC;
    const A = window.AudioContext || window.webkitAudioContext; if (!A) return null;
    try {
      AC = new A(); const comp = AC.createDynamicsCompressor(); comp.threshold.value = -10; comp.ratio.value = 8;
      OUT = AC.createGain(); OUT.gain.value = 0.5; OUT.connect(comp); comp.connect(AC.destination);
      NB = AC.createBuffer(1, AC.sampleRate, AC.sampleRate); const d = NB.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = rnd() * 2 - 1;
    } catch (e) { AC = null; }
    return AC;
  }
  const wake = () => { const a = ac(); if (a && a.state !== 'running' && a.resume) a.resume().catch(() => {}); };
  window.addEventListener('pointerdown', wake, true); window.addEventListener('keydown', wake, true);
  function env(a, g, t, att, dur, lv) { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(lv, t + att); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); }
  function tone(a, dst, type, f0, f1, t, dur, lv, att) {
    const o = a.createOscillator(), g = a.createGain(); o.type = type; o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    env(a, g, t, att || 0.01, dur, lv); o.connect(g); g.connect(dst); o.start(t); o.stop(t + dur + 0.05); return o;
  }
  function hiss(a, dst, t, dur, lv, type, f, q) {
    const s = a.createBufferSource(), b = a.createBiquadFilter(), g = a.createGain(); s.buffer = NB; b.type = type; b.frequency.value = f; b.Q.value = q || 0.8;
    env(a, g, t, 0.01, dur, lv); s.connect(b); b.connect(g); g.connect(dst); s.start(t, rnd() * 0.5); s.stop(t + dur + 0.05);
  }
  const KS = {};
  function pluckBuf(a, midi) {
    if (KS[midi]) return KS[midi];
    const sr = a.sampleRate, f = 440 * Math.pow(2, (midi - 69) / 12), N = Math.round(sr / f), len = Math.floor(sr * 1.4), b = a.createBuffer(1, len, sr), d = b.getChannelData(0);
    for (let i = 0; i < N; i++) d[i] = rnd() * 2 - 1;
    for (let i = N; i < len; i++) d[i] = (d[i - N] + d[i - N + 1 < i ? i - N + 1 : i - N]) * 0.497;
    return (KS[midi] = b);
  }
  function filt(a, dst, type, f, q) { const b = a.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q || 0.7; b.connect(dst); return b; }
  const SYN = {
    horn(a, d, t) { const f = filt(a, d, 'lowpass', 900); for (const [hz, lv] of [[98, 0.5], [147, 0.3], [196, 0.12]]) { const o = tone(a, f, 'sawtooth', hz * 0.94, hz, t, 2.6, lv, 0.45); o.frequency.setValueAtTime(hz * 0.94, t); o.frequency.linearRampToValueAtTime(hz, t + 0.4); } },
    drum(a, d, t) { tone(a, d, 'sine', 95, 38, t, 0.45, 0.9, 0.005); hiss(a, d, t, 0.12, 0.35, 'lowpass', 400); tone(a, d, 'sine', 80, 34, t + 0.28, 0.35, 0.45, 0.005); },
    caw(a, d, t) { const f = filt(a, d, 'bandpass', 1300, 2.5); for (let i = 0, n = RI(2, 3); i < n; i++) { tone(a, f, 'sawtooth', R(560, 620), 380, t + i * 0.3, 0.22, 0.7, 0.01); hiss(a, f, t + i * 0.3, 0.15, 0.3, 'bandpass', 1500, 2); } },
    croak(a, d, t) { const f = filt(a, d, 'lowpass', 700); for (let i = 0; i < 2; i++) tone(a, f, 'square', R(95, 120), 80, t + i * 0.16, 0.13, 0.28, 0.005); },
    scream(a, d, t) {
      const f = filt(a, d, 'bandpass', 1250, 3), o = a.createOscillator(), g = a.createGain(), v = a.createOscillator(), vg = a.createGain();
      o.type = 'sawtooth'; o.frequency.setValueAtTime(620, t); o.frequency.linearRampToValueAtTime(1050, t + 0.25); o.frequency.linearRampToValueAtTime(980, t + 0.7); o.frequency.linearRampToValueAtTime(520, t + 1.2);
      v.frequency.value = 7; vg.gain.value = 30; v.connect(vg); vg.connect(o.frequency);
      env(a, g, t, 0.05, 1.25, 0.7); o.connect(g); g.connect(f); o.start(t); v.start(t); o.stop(t + 1.3); v.stop(t + 1.3);
    },
    chime(a, d, t) { for (const [hz, lv] of [[523, 0.3], [784, 0.22], [1046, 0.16], [1568, 0.1], [2093, 0.06]]) tone(a, d, 'sine', hz, hz, t + rnd() * 0.02, 3, lv, 0.01); },
    screech(a, d, t) { const f = filt(a, d, 'highpass', 900); tone(a, f, 'triangle', 2700, 1500, t, 0.7, 0.35, 0.03); tone(a, f, 'sine', 2900, 1700, t + 0.05, 0.6, 0.2, 0.02); },
    splash(a, d, t) { hiss(a, d, t, 0.35, 0.5, 'highpass', 900); hiss(a, d, t + 0.05, 0.2, 0.3, 'bandpass', 500, 1); },
    flap(a, d, t) { for (let i = 0; i < 7; i++) hiss(a, d, t + i * 0.07, 0.06, 0.35, 'lowpass', 700); },
    squeal(a, d, t) { const f = filt(a, d, 'bandpass', 1400, 2); tone(a, f, 'sawtooth', 700, 1100, t, 0.35, 0.5, 0.01); tone(a, f, 'sawtooth', 1000, 600, t + 0.3, 0.3, 0.4, 0.01); },
    cry(a, d, t) { const f = filt(a, d, 'bandpass', 900, 2); tone(a, f, 'sawtooth', 330, 250, t, 0.9, 0.35, 0.1); },
    lute(a, d, t) {
      const scale = [50, 53, 55, 57, 58, 60, 62, 65], tune = [0, 2, 4, 3, 2, 1, 2, 0, 4, 5, 7, 5, 4, 2, 3, 1];
      tune.forEach((n, i) => { const s = a.createBufferSource(), g = a.createGain(); s.buffer = pluckBuf(a, scale[n] + 12); g.gain.value = 0.5; s.connect(g); g.connect(d); s.start(t + i * 0.3 + (i % 2) * 0.03); if (i % 4 === 0) { const s2 = a.createBufferSource(), g2 = a.createGain(); s2.buffer = pluckBuf(a, scale[n]); g2.gain.value = 0.35; s2.connect(g2); g2.connect(d); s2.start(t + i * 0.3); } });
    },
  };
  const SDUR = { horn: 3, lute: 6, scream: 1.5, chime: 3.2 };
  function snd(name, pos, range) {   // silent until a user gesture has created the context (creating it costs up to ~1 s)
    const a = AC; if (!a || a.state !== 'running' || !SYN[name] || !core) return;
    range = range || 140;
    const cam = core.camera, dx = pos.x - cam.position.x, dz = pos.z - cam.position.z, d = Math.hypot(dx, dz);
    if (d > range) return;
    const lv = Math.pow(1 - d / range, 1.4) / (1 + d / 40);
    const m = cam.matrixWorld.elements, pan = d > 0.5 ? clamp((dx * m[0] + dz * m[2]) / d, -0.85, 0.85) : 0;
    try {
      const t = a.currentTime + 0.02, g = a.createGain(); g.gain.value = lv;
      const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = clamp(9000 - d * 60, 900, 9000); lp.connect(g);
      let p = null; if (a.createStereoPanner) { p = a.createStereoPanner(); p.pan.value = pan; g.connect(p); p.connect(OUT); } else g.connect(OUT);
      SYN[name](a, lp, t);
      setTimeout(() => { try { lp.disconnect(); g.disconnect(); if (p) p.disconnect(); } catch (e) {} }, ((SDUR[name] || 1.5) + 1) * 1000);
    } catch (e) {}
  }
  // sounds from far events: play them from a point toward the event, inside the hearing range of audio.js
  function omenPos(x, z, d) { const dx = x - P.x, dz = z - P.z, l = Math.hypot(dx, dz) || 1, k = Math.min(1, d / l); return V2.set(P.x + dx * k, P.y + 1.5, P.z + dz * k).clone(); }

  // ── Interactables ──────────────────────────────────────────────────────────
  function inter(x, z, label, fn, radius) {
    const o = { x, z, radius: radius || 2.4, label, disabled: false, onUse: () => { try { fn(o); } catch (e) { console.error('[CT.life use]', e); } } };
    if (CT.interactables) CT.interactables.add(o); else PENDING.push(o);
    return o;
  }
  const PENDING = [];
  function uninter(o) { if (!o) return; o.disabled = true; if (CT.interactables) CT.interactables.remove(o); const i = PENDING.indexOf(o); if (i >= 0) PENDING.splice(i, 1); }
  const GLINTS = [];
  function glint(x, y, z) { const g = { x, y, z, on: true, ph: rnd() * TAU }; GLINTS.push(g); return g; }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Wildlife ───────────────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  const SPEC = {
    deer: { pool: 'deer', r: 0.45, hp: 35, run: 9.5, walk: 1.1, fear: 26, scale: 1.2, sh: 0.5, shL: 1.8, gait: 2.4, head: 1.25, loot: [['venison', 2], ['hide', 1]], name: 'Deer', xp: 4 },
    stag: { pool: 'stag', r: 0.5, hp: 55, run: 9, walk: 1.1, fear: 28, scale: 1.3, sh: 0.55, shL: 1.8, gait: 2.4, head: 1.2, loot: [['venison', 3], ['hide', 2]], name: 'Stag', xp: 6 },
    hare: { pool: 'hare', r: 0.2, hp: 8, run: 8, walk: 1.3, fear: 13, scale: 1.5, sh: 0.18, shL: 1.5, gait: 5, head: 0.3, loot: [['venison', 1]], name: 'Hare', xp: 1 },
    boar: { pool: 'boar', r: 0.5, hp: 60, run: 7.2, walk: 0.9, fear: 0, scale: 1.15, sh: 0.45, shL: 1.6, gait: 3.4, head: 0.55, loot: [['venison', 2], ['tusk', 1]], name: 'Boar', xp: 10 },
    goat: { pool: 'goat', r: 0.4, hp: 35, run: 7, walk: 0.9, fear: 20, scale: 1.15, sh: 0.4, shL: 1.6, gait: 3, head: 0.9, loot: [['hide', 1], ['venison', 1]], name: 'Mountain Goat', xp: 4 },
  };
  const LIFE_TBL = {
    meadow: [['deer', 5], ['hare', 4], ['boar', 1.2], ['crows', 2.5]],
    forest: [['deer', 4], ['boar', 3], ['hare', 2], ['crows', 1]],
    hills: [['deer', 3], ['hare', 3], ['goat', 1.5], ['boar', 1.5], ['crows', 1.5]],
    coast: [['hare', 3], ['crows', 3], ['deer', 1.5]],
    swamp: [['crows', 3], ['boar', 1.5], ['hare', 1], ['deer', 0.6]],
    snow: [['goat', 5], ['hare', 2], ['crows', 1]],
    citadel: [['crows', 4]],
  };
  const HERD_N = { deer: [3, 6], hare: [1, 3], boar: [1, 3], goat: [3, 5], crows: [6, 12] };
  const HERDS = [], CARCASS = [];
  let herdT = 0;
  const TINT = { hare: hexT(0x6e5e4a), hareSnow: hexT(0xe8e8ec) };
  function birdCount() { let n = 0; for (const e of ENTS) if (e.pool === 'crow') n++; return n; }
  function spawnHerd(kind, x, z, o) {
    o = o || {};
    const h = { kind, x, z, members: [], chk: rnd() * 0.4, state: 'calm', t: 0, ev: o.ev || null, tx: 0, tz: 0, fleeT: 0, calmT: 0 };
    const nr = HERD_N[kind] || [1, 2], n = o.n || RI(nr[0], nr[1]);
    if (kind === 'crows') {
      const room = (low ? 30 : 60) - birdCount(); if (room < 3) return null;
      for (let i = 0; i < Math.min(n, room); i++) {
        const cx = x + R(-4, 4), cz = z + R(-4, 4), s = R(1.6, 1.9);
        h.members.push(ent('crow', cx, cz, { bird: true, s, sh: 0.12, y: H(cx, cz) + 0.1 * s, a3: -1.35, stT: R(0, 2), hop: 0, vy: 0, alt: 0, herd: h }));
      }
    } else {
      const snow = BIO(x, z) === 'snow';
      for (let i = 0; i < n; i++) {
        const k = kind === 'deer' && i === 0 && rnd() < 0.55 ? 'stag' : kind, S = SPEC[k];
        const ax = x + R(-6, 6), az = z + R(-6, 6);
        const a = ent(S.pool, ax, az, { animal: true, sp: S, kind: k, hp: S.hp, s: S.scale * R(0.9, 1.08), sh: S.sh, shL: S.shL, yaw: rnd() * TAU, herd: h,
          st: 'graze', stT: R(0, 5), look: R(1, 6), vx: 0, vz: 0, side: rnd() < 0.5 ? -1 : 1, stagT: 0, pos: new T.Vector3(ax, 0, az), rad: S.r * S.scale });
        if (kind === 'hare') a.tint = snow ? TINT.hareSnow : TINT.hare;
        if (kind === 'goat' && snow) a.tint = null;
        h.members.push(a);
      }
    }
    HERDS.push(h);
    return h;
  }
  function herdSpot(kind) {
    for (let tries = 0; tries < 8; tries++) {
      const ahead = rnd() < 0.7;
      const base = Math.atan2(FX_, FZ_), a = ahead ? base + R(-0.65, 0.65) : rnd() * TAU;
      const d = kind === 'hare' ? R(22, 60) : kind === 'crows' ? R(28, 80) : ahead ? R(40, 110) : R(50, 120);
      const x = P.x + Math.sin(a) * d, z = P.z + Math.cos(a) * d;
      if (Math.abs(x) > 1400 || Math.abs(z) > 1400 || WAT(x, z) > 0.05 || inVillage(x, z, 8)) continue;
      if (kind === 'goat' && has('world', 'normalAt') && CT.world.normalAt(x, z).y > 0.93 && tries < 6) continue;
      if (kind !== 'goat' && kind !== 'crows' && has('world', 'normalAt') && CT.world.normalAt(x, z).y < 0.75) continue;
      return { x, z };
    }
    return null;
  }
  function updHerdSpawns(dt) {
    if ((herdT -= dt) > 0) return;
    herdT = 1.2;
    let ground = 0, flocks = 0;
    for (const h of HERDS) { if (h.ev || Math.hypot(h.x - P.x, h.z - P.z) > 150) continue; if (h.kind === 'crows') flocks++; else ground++; }
    const cap = low ? 4 : 7;
    if (ground + flocks >= cap) return;
    const b = BIO(P.x, P.z), tbl = (LIFE_TBL[b] || LIFE_TBL.meadow).filter(e => e[0] !== 'crows' || flocks < (low ? 1 : 2));
    const kind = pickW(tbl); if (!kind) return;
    const sp = herdSpot(kind); if (!sp) return;
    if (kind !== 'crows' && LIFE_TBL[BIO(sp.x, sp.z)] && !LIFE_TBL[BIO(sp.x, sp.z)].some(e => e[0] === kind)) return;
    spawnHerd(kind, sp.x, sp.z);
  }
  function nearestMonster(x, z, maxD) {
    let best = null, bd = maxD;
    for (const m of mons()) { if (m.dead || !m.alive) continue; const d = Math.hypot(m.pos.x - x, m.pos.z - z); if (d < bd) { bd = d; best = m; } }
    return best;
  }
  function removeHerd(h) { for (const a of h.members) if (!a.dead) drop(a); h.members.length = 0; const i = HERDS.indexOf(h); if (i >= 0) HERDS.splice(i, 1); }
  function updHerd(h, dt) {
    let cx = 0, cz = 0, n = 0;
    for (const a of h.members) if (!a.dead && !a.gone) { cx += a.x; cz += a.z; n++; }
    if (!n) { removeHerd(h); return; }
    h.x = cx / n; h.z = cz / n;
    const pd = Math.hypot(h.x - P.x, h.z - P.z);
    if (!h.ev && (pd > 230 || (pd > 140 && (h.x - P.x) * FX_ + (h.z - P.z) * FZ_ < 0))) { removeHerd(h); return; }   // far, or left behind
    if (h.kind === 'crows') { updCrowFlock(h, dt, pd); return; }
    h.t += dt;
    if ((h.chk -= dt) < 0) {
      h.chk = 0.35;
      const f0 = h.members[0].sp.fear;
      let tx = null, tz = null;
      if (f0 > 0 && pd < f0 * (sprinting ? 1.25 : 0.18)) { tx = P.x; tz = P.z; }   // a walking hunter can creep close; a sprinting one cannot
      else { const m = nearestMonster(h.x, h.z, h.kind === 'boar' ? 0 : 26); if (m) { tx = m.pos.x; tz = m.pos.z; } }
      if (tx != null) {
        h.tx = tx; h.tz = tz; h.calmT = 0;
        if (h.state !== 'flee') { h.state = 'flee'; for (const a of h.members) if (!a.dead && a.st !== 'charge') { a.st = 'alert'; a.stT = R(0.45, 0.9); } }
      } else if (h.state === 'flee' && (h.calmT += 0.35) > 5) { h.state = 'calm'; for (const a of h.members) if (!a.dead && a.st === 'flee') { a.st = 'graze'; a.stT = R(1, 4); } }
    }
    for (const a of h.members) if (!a.dead && !a.gone) updAnimal(a, h, dt, pd);
  }
  function updAnimal(a, h, dt, pd) {
    const S = a.sp;
    let want = 0, wy = a.yaw, head = 0.1;
    a.stT -= dt;
    if (a.stagT > 0) a.stagT -= dt;
    switch (a.st) {
      case 'graze':
        head = S.head;
        if ((a.look -= dt) < 0) { head = -0.15; if (a.look < -1.6) a.look = R(2.5, 7); }
        if (a.stT < 0) { a.st = 'walk'; a.stT = R(2, 5); const r = R(1, 7), an = rnd() * TAU; a.tx = h.x + Math.sin(an) * r; a.tz = h.z + Math.cos(an) * r; }
        if (a.kind === 'boar' && pd < 6 && !a.calm && rnd() < dt * 0.4) provokeBoar(a);
        break;
      case 'walk': {
        const dx = a.tx - a.x, dz = a.tz - a.z, d = Math.hypot(dx, dz);
        want = S.walk; wy = Math.atan2(dx, dz); head = 0.15;
        if (d < 0.6 || a.stT < 0) { a.st = 'graze'; a.stT = R(3, 9); }
        break;
      }
      case 'alert': head = -0.3; wy = Math.atan2(h.tx - a.x, h.tz - a.z); if (a.stT < 0) { a.st = 'flee'; a.stT = R(5, 8); if (a.kind === 'deer' || a.kind === 'stag') a.bolt = 1; } break;
      case 'flee': {
        const dx = a.x - h.tx, dz = a.z - h.tz;
        wy = Math.atan2(dx, dz) + a.side * 0.35; want = a.wounded ? 3.6 : S.run * (a.hp < S.hp * 0.5 ? 0.55 : 1) * (a.kind === 'hare' ? (Math.sin(time * 5 + a.ph) > 0 ? 1 : 0.55) : 1); head = -0.1;
        if (a.kind === 'hare' && (a.zig = (a.zig || 0) - dt) < 0) { a.zig = R(0.3, 0.7); a.side = -a.side; }
        if (h.state !== 'flee' && a.stT < 0) { a.st = 'graze'; a.stT = R(2, 5); }
        break;
      }
      case 'charge': {   // boars
        const dx = P.x - a.x, dz = P.z - a.z, d = Math.hypot(dx, dz);
        wy = Math.atan2(dx, dz); head = 0.3; want = a.stagT > 0 ? 0 : S.run;
        if (d < 1.4 + a.rad && a.stagT <= 0) {
          a.pos.set(a.x, a.y, a.z);
          if (has('player', 'hurt') && CT.player.alive !== false) CT.player.hurt(R(8, 12), V1.set(dx / (d || 1), 0.2, dz / (d || 1)).clone(), a);
          snd('squeal', a.pos, 60); a.st = 'recover'; a.stT = R(1.2, 2);
        }
        if (d > 38 || (CT.player && CT.player.alive === false)) { a.st = 'graze'; a.stT = 3; a.calm = true; }
        if (a.hp < S.hp * 0.3) { a.st = 'flee'; h.tx = P.x; h.tz = P.z; h.state = 'flee'; a.stT = 6; }
        break;
      }
      case 'recover': { const dx = a.x - P.x, dz = a.z - P.z; wy = Math.atan2(dx, dz); want = 2.5; if (a.stT < 0) a.st = 'charge'; break; }
    }
    if (a.st === 'alert') want = 0;
    const k = 1 - Math.exp(-(want > S.walk * 1.5 ? 4 : 6) * dt);
    a.vx += (Math.sin(wy) * want - a.vx) * k; a.vz += (Math.cos(wy) * want - a.vz) * k;
    const spd = Math.hypot(a.vx, a.vz);
    if (spd > 0.05) {
      let nx = a.x + a.vx * dt, nz = a.z + a.vz * dt;
      if (WAT(nx, nz) > 0.3) { a.vx *= -0.3; a.vz *= -0.3; a.side = -a.side; nx = a.x; nz = a.z; }
      a.x = nx; a.z = nz;
      if (pd < 90 && has('world', 'collide')) { a.pos.set(a.x, a.y, a.z); CT.world.collide(a.pos, a.rad); a.x = a.pos.x; a.z = a.pos.z; }
    }
    if (spd > 0.25) a.yaw = turn(a.yaw, Math.atan2(a.vx, a.vz), dt * (spd > 3 ? 5 : 3)); else if (a.st === 'alert') a.yaw = turn(a.yaw, wy, dt * 4);
    a.y = H(a.x, a.z);
    a.a0 += dt * spd * S.gait;
    a.a1 = spd < 0.08 ? a.a1 * Math.exp(-dt * 8) : Math.min(0.95, 0.28 + spd * 0.075);
    a.a2 += (head - a.a2) * Math.min(1, dt * 4);
    if (a.kind === 'hare') { a.lift = spd > 0.3 ? Math.abs(Math.sin(a.a0 * 0.5)) * (spd > 3 ? 0.35 : 0.12) : 0; a.pitch = 0; }
    else { a.lift = spd > 3 ? Math.abs(Math.sin(a.a0)) * 0.1 * a.s : 0; a.pitch = spd > 3 ? Math.sin(a.a0) * 0.07 : 0; }
  }
  function provokeBoar(a) { if (a.dead) return; a.st = 'charge'; a.calm = false; a.stT = 0; a.pos.set(a.x, a.y, a.z); snd('squeal', a.pos, 70); }

  // Crows: pecking flocks lift off in a burst of black wings
  function updCrowFlock(h, dt, pd) {
    h.t += dt;
    if (h.state === 'calm' && (h.chk -= dt) < 0) {
      h.chk = 0.3;
      let tx = null, tz = null;
      if (pd < (sprinting ? 24 : 16)) { tx = P.x; tz = P.z; }
      else { const m = nearestMonster(h.x, h.z, 11); if (m && !h.carrion) { tx = m.pos.x; tz = m.pos.z; } }
      if (tx != null) {
        h.state = 'fly'; h.tx = tx; h.tz = tz; h.t = 0;
        V1.set(h.x, H(h.x, h.z) + 1, h.z); snd('flap', V1, 60); snd('caw', V1, 110);
        for (const c of h.members) { c.vy = R(3, 5); c.gy = c.y; c.alt = 0.1; c.side = R(-0.7, 0.7); c.spd = R(5, 8); }
      }
    }
    for (const c of h.members) {
      if (c.gone) continue;
      if (h.state === 'calm') {
        c.stT -= dt;
        if (c.stT < 0) { c.stT = R(0.6, 2.6); c.hop = 0.3; c.yaw = h.carrion && rnd() < 0.6 ? Math.atan2(h.x - c.x, h.z - c.z) : rnd() * TAU; }
        if (c.hop > 0) { c.hop -= dt; c.x += Math.sin(c.yaw) * 1.1 * dt; c.z += Math.cos(c.yaw) * 1.1 * dt; c.lift = Math.sin(Math.max(0, c.hop) / 0.3 * PI) * 0.15; c.a1 = 0.5; c.a0 += dt * 30; c.a3 = -0.4; }
        else { c.lift = 0; c.a1 = 0; c.a3 = -1.35; }
        c.a2 = Math.sin(time * 6 + c.ph) > 0.55 ? 0.9 : 0.1;
        c.y = H(c.x, c.z) + 0.1 * c.s; c.pitch = 0; c.roll = 0;
      } else {
        c.vy = lerp(c.vy, 2.2, dt); c.alt += c.vy * dt;
        const a = Math.atan2(c.x - h.tx, c.z - h.tz) + c.side;
        c.x += Math.sin(a) * c.spd * dt; c.z += Math.cos(a) * c.spd * dt; c.yaw = turn(c.yaw, a, dt * 6);
        c.y = c.gy + c.alt; c.gy = lerp(c.gy, H(c.x, c.z), dt); c.lift = 0;
        c.a0 += dt * 19; c.a1 = 0.95; c.a2 = 0; c.a3 = 0.1; c.pitch = -0.25; c.roll = c.side * 0.4;
      }
    }
    if (h.state === 'fly' && h.t > 9) removeHerd(h);
  }

  // Crows wheeling above a battlefield, a corpse or an omen
  const CIRCLES = [];
  function addCircle(x, z, n, h, r, life) {
    for (const c of CIRCLES) if (Math.hypot(c.x - x, c.z - z) < 25) { c.life = Math.max(c.life, c.t + life); return c; }
    const room = (low ? 30 : 60) - birdCount(); n = Math.min(n, room); if (n < 2) return null;
    const c = { x, z, gy: H(x, z), life, t: 0, members: [] };
    for (let i = 0; i < n; i++) c.members.push(ent('crow', x, z, { bird: true, s: R(1.7, 2.0), sh: 0, ang: rnd() * TAU, rr: r * R(0.6, 1.3), hh: h + R(-3, 4), a3: 0.12, flapT: R(0, 3), dirn: 1 }));
    CIRCLES.push(c); return c;
  }
  function updCircles(dt) {
    for (let i = CIRCLES.length - 1; i >= 0; i--) {
      const c = CIRCLES[i]; c.t += dt;
      const far = Math.hypot(c.x - P.x, c.z - P.z) > 260;
      if (c.t > c.life || far) { for (const e of c.members) drop(e); CIRCLES.splice(i, 1); continue; }
      const up = c.t > c.life - 6 ? (c.t - (c.life - 6)) * 4 : 0;
      for (const e of c.members) {
        const w = 6.5 / e.rr; e.ang += w * dt;
        e.x = c.x + Math.cos(e.ang) * e.rr; e.z = c.z + Math.sin(e.ang) * e.rr; e.y = c.gy + e.hh + Math.sin(time * 0.7 + e.ph) * 1.2 + up;
        e.yaw = Math.atan2(-Math.sin(e.ang), Math.cos(e.ang)); e.roll = -0.35; e.pitch = 0;
        if ((e.flapT -= dt) < 0) { e.flapT = R(2.5, 6); e.flapOn = R(0.6, 1.3); }
        const flap = e.flapOn > 0; if (flap) e.flapOn -= dt;
        e.a0 += dt * (flap ? 16 : 2); e.a1 = flap ? 0.8 : 0.12; e.a2 = 0;
      }
      if (rnd() < dt * 0.08 && c.members.length) snd('caw', V1.set(c.x, c.gy + 15, c.z), 120);
    }
  }

  // Eagle high above by day, bats at night, fish leaping, frogs croaking
  let EAGLE = null, BATS = [], FISH = [], fishT = 3, frogT = 2, bird2T = 0;
  function updSkyLife(dt) {
    const b = BIO(P.x, P.z), night = isNight();
    // eagle
    const wantEagle = !night && b !== 'citadel' && b !== 'swamp';
    if (wantEagle && !EAGLE) { const a = rnd() * TAU; EAGLE = ent('eagle', P.x + Math.sin(a) * 80, P.z + Math.cos(a) * 80, { bird: true, s: 2.2, sh: 0, cx: P.x, cz: P.z, ang: a, rr: R(40, 70), alt: R(45, 70), a3: 0.18, flapT: 3, cryT: R(8, 25) }); }
    if (EAGLE) {
      const e = EAGLE;
      if (!wantEagle && (e.alt += dt * 8) > 140) { drop(e); EAGLE = null; }
      else {
        e.cx = lerp(e.cx, P.x + HX * 40, dt * 0.1); e.cz = lerp(e.cz, P.z + HZ * 40, dt * 0.1);
        e.ang += 12 / e.rr * dt; e.x = e.cx + Math.cos(e.ang) * e.rr; e.z = e.cz + Math.sin(e.ang) * e.rr;
        e.y = H(e.cx, e.cz) * 0.5 + Math.max(H(e.x, e.z), 0) * 0.5 + e.alt; e.yaw = Math.atan2(-Math.sin(e.ang), Math.cos(e.ang)); e.roll = -0.3;
        if ((e.flapT -= dt) < 0) { e.flapT = R(4, 9); e.flapOn = 1.2; }
        const fl = e.flapOn > 0; if (fl) e.flapOn -= dt;
        e.a0 += dt * (fl ? 7 : 1); e.a1 = fl ? 0.6 : 0.05;
        if ((e.cryT -= dt) < 0) { e.cryT = R(25, 60); snd('screech', V1.set(e.x, e.y, e.z), 200); }
      }
    }
    // bats
    const wantBats = night ? (low ? 4 : 8) : 0;
    while (BATS.length < wantBats) { const a = rnd() * TAU, r = R(6, 18); BATS.push(ent('bat', P.x + Math.sin(a) * r, P.z + Math.cos(a) * r, { bird: true, s: 1.6, sh: 0, ang: a, rr: r, alt: R(3, 9), w: R(1.5, 3) * (rnd() < 0.5 ? -1 : 1), cx: P.x, cz: P.z })); }
    while (BATS.length > wantBats) drop(BATS.pop());
    for (const e of BATS) {
      e.cx = lerp(e.cx, P.x, dt * 0.5); e.cz = lerp(e.cz, P.z, dt * 0.5);
      e.ang += e.w * dt + Math.sin(time * 3 + e.ph) * dt * 2; e.rr = clamp(e.rr + Math.sin(time * 1.3 + e.ph) * dt * 4, 4, 22);
      e.x = e.cx + Math.cos(e.ang) * e.rr; e.z = e.cz + Math.sin(e.ang) * e.rr; e.y = H(e.x, e.z) + e.alt + Math.sin(time * 4 + e.ph) * 0.8;
      e.yaw = Math.atan2(-Math.sin(e.ang) * Math.sign(e.w), Math.cos(e.ang) * Math.sign(e.w)); e.a0 += dt * 28; e.a1 = 1.0; e.a3 = 0.1;
    }
    // fish
    if ((fishT -= dt) < 0) {
      fishT = R(2.5, 6);
      if (FISH.length < 3) for (let i = 0; i < 10; i++) {
        const a = Math.atan2(FX_, FZ_) + R(-0.9, 0.9), d = R(12, 55), x = P.x + Math.sin(a) * d, z = P.z + Math.cos(a) * d;
        if (WAT(x, z) < 0.7) continue;
        const yaw = rnd() * TAU; FISH.push(ent('fish', x, z, { s: R(1.4, 2.2), sh: 0, y: -0.3, yaw, t: 0, dur: R(0.7, 1.0), x0: x, z0: z }));
        splash(x, z); snd('splash', V1.set(x, 0, z), 70); break;
      }
    }
    for (let i = FISH.length - 1; i >= 0; i--) {
      const e = FISH[i]; e.t += dt; const k = e.t / e.dur;
      if (k >= 1) { splash(e.x, e.z); snd('splash', V1.set(e.x, 0, e.z), 60); drop(e); FISH.splice(i, 1); continue; }
      e.x = e.x0 + Math.sin(e.yaw) * 1.8 * k; e.z = e.z0 + Math.cos(e.yaw) * 1.8 * k; e.y = -0.2 + Math.sin(k * PI) * 1.1; e.pitch = -Math.cos(k * PI) * 0.9; e.a0 += dt * 20; e.a1 = 1;
    }
    // frogs and night birds
    if ((frogT -= dt) < 0) {
      frogT = b === 'swamp' ? R(0.8, 2.8) / (night || dusk() ? 1.6 : 1) : R(3, 8);
      if (b === 'swamp' || (WAT(P.x + 10, P.z) > 0 && rnd() < 0.3)) { const a = rnd() * TAU, r = R(6, 28); snd('croak', V1.set(P.x + Math.sin(a) * r, P.y, P.z + Math.cos(a) * r), 60); }
    }
    if ((bird2T -= dt) < 0) { bird2T = R(12, 30); if (!night && (b === 'meadow' || b === 'forest' || b === 'coast')) { const a = rnd() * TAU; snd('caw', V1.set(P.x + Math.sin(a) * 50, P.y + 10, P.z + Math.cos(a) * 50), 120); } }
  }

  // ── Player melee vs. wildlife ──────────────────────────────────────────────
  const SWINGS = [];
  const DIRV = new T.Vector3();
  function hitTest(origin, dir, range, arc) {
    const out = [];
    arc = arc || 1.4;
    const dl = Math.hypot(dir.x, dir.z) || 1, dx = dir.x / dl, dz = dir.z / dl;
    for (const h of HERDS) for (const a of h.members) {
      if (!a.animal || a.dead || a.gone) continue;
      const ex = a.x - origin.x, ez = a.z - origin.z, d = Math.hypot(ex, ez), r = a.rad + 0.25;
      if (d > range + r) continue;
      const ang = d > 0.01 ? Math.acos(clamp((ex * dx + ez * dz) / d, -1, 1)) : 0;
      if (ang > arc / 2 + Math.atan2(r, Math.max(0.3, d))) continue;
      if (Math.abs(a.y + 0.5 * a.s - origin.y) > 2.4) continue;
      out.push({ animal: a, dist: Math.max(0, d - r), point: new T.Vector3(a.x, a.y + 0.6 * a.s, a.z) });
    }
    out.sort((p, q) => p.dist - q.dist);
    return out;
  }
  function strikeAnimals(s) {
    if (!CT.player || CT.player.alive === false || !core) return;
    const p = CT.player, yaw = p.yaw || 0, pitch = p.pitch || 0, cp = Math.cos(pitch);
    DIRV.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
    const w = s.w || {}, reach = (w.reach || 2.3) * (s.heavy ? 1.12 : 1) + 0.3, arc = (w.arc || 1.5) * (s.heavy ? 1.15 : 1);
    const hits = hitTest(core.camera.position, DIRV, reach, arc);
    let n = 0;
    for (const h of hits) {
      if (n >= (s.heavy ? 3 : 2)) break; n++;
      let dmg = (w.damage || 18) * (s.heavy ? (w.heavyMult || 2.2) : 1);
      if (BUFF.kind === 'wrath') dmg *= 1.4;
      damage(h.animal, dmg, V1.set(DIRV.x, 0, DIRV.z).normalize(), true);
    }
    if (n) { if (core.hitStop) core.hitStop(0.05); if (core.shake) core.shake(0.35, 0.18); if (has('gore', 'bladeBlood')) CT.gore.bladeBlood(0.08); }
  }
  function damage(a, dmg, dir, byPlayer) {
    if (!a || a.dead || !a.animal) return { killed: false };
    a.hp -= dmg;
    const pt = new T.Vector3(a.x, a.y + 0.6 * a.s, a.z), d = new T.Vector3(dir ? dir.x : 0, 0.35, dir ? dir.z : 1).normalize();
    if (has('gore', 'spray')) CT.gore.spray(pt, d, clamp(dmg / 40, 0.3, 1.2));
    sfx('flesh', pt);
    if (a.hp <= 0) { dieAnimal(a, d, byPlayer); return { killed: true }; }
    const h = a.herd;
    if (a.kind === 'boar') { if (byPlayer) provokeBoar(a); }
    else if (h) { h.tx = byPlayer ? P.x : a.x - d.x * 5; h.tz = byPlayer ? P.z : a.z - d.z * 5; h.state = 'flee'; h.calmT = 0; for (const b of h.members) if (!b.dead) { b.st = 'flee'; b.stT = R(5, 8); } }
    if (a.kind === 'hare' || a.kind === 'boar') snd('squeal', pt, 60);
    return { killed: false };
  }
  function dieAnimal(a, d, byPlayer) {
    a.dead = true; a.deadT = 0; a.a1 = 0; a.lift = 0; a.pitch = 0; a.rollTo = (rnd() < 0.5 ? 1 : -1) * PI / 2; a.a2 = 0.4;
    if (has('gore', 'pool')) CT.gore.pool(a.x, a.z, 0.6 * a.s);
    if (has('gore', 'burst')) CT.gore.burst(new T.Vector3(a.x, a.y + 0.5 * a.s, a.z), 0.5);
    sfx('bone', new T.Vector3(a.x, a.y, a.z));
    const h = a.herd; if (h) { const i = h.members.indexOf(a); if (i >= 0) h.members.splice(i, 1); }
    CARCASS.push(a);
    const S = a.sp;
    a.inter = inter(a.x, a.z, `Butcher the ${S.name}`, o => {
      S.loot.forEach(([id, n]) => grant(id, n)); sfx('flesh', new T.Vector3(a.x, a.y, a.z));
      if (has('gore', 'burst')) CT.gore.burst(new T.Vector3(a.x, a.y + 0.3, a.z), 0.4);
      uninter(o); a.inter = null; a.butchered = true; a.deadT = Math.max(a.deadT, 100);
    }, 2.4);
    if (byPlayer && S.xp) xp(S.xp);
  }
  function updCarcass(dt) {
    for (let i = CARCASS.length - 1; i >= 0; i--) {
      const a = CARCASS[i]; a.deadT += dt;
      a.roll = lerp(a.roll, a.rollTo, Math.min(1, dt * 7)); a.y = H(a.x, a.z) + 0.05 * a.s; a.sh = 0;
      if (a.inter) { a.inter.x = a.x; a.inter.z = a.z; }
      if (a.butchered) a.s = Math.max(0.01, a.s - dt * 2);
      if (a.deadT > 120 || Math.hypot(a.x - P.x, a.z - P.z) > 260) { drop(a); CARCASS.splice(i, 1); }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── People ─────────────────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  const PAL = {
    tunic: [0x8a5a34, 0x6a4a2e, 0x5a6a44, 0x7a3a26, 0x4a4a5a, 0x9a8458, 0x5a3a4a].map(hexT),
    trousers: [0x4a3a28, 0x3a3024, 0x5a4a38, 0x2e2a26].map(hexT),
    robe: [0x8a8070, 0x6a5a48, 0xb8b0a0, 0x4a4448].map(hexT),
    harrow: hexT(0x8a1a12), harrowLegs: hexT(0x4a3624), guard: hexT(0x5a4a30),
    rags: [0x5a5040, 0x4a4036, 0x6a5a48].map(hexT),
    green: [0x3a4a2a, 0x4a5a34].map(hexT),
    canvas: [0xe0d8c0, 0xc8b890, 0xa89878, 0xb04a30].map(hexT),
    rich: [0x6a1a3a, 0x2a3a6a, 0x7a5a1a, 0x3a5a3a].map(hexT),
    crest: [0xb01a10, 0x1a3a8a, 0xd0a020].map(hexT),
  };
  const NAMES = {
    merchant: ['Hald the Peddler', 'Osric Saltbeard', 'Mother Brine', 'Jory Tallow', 'Fat Gunnar'],
    bard: ['Lirien the Bard', 'Wat Fiddlefoot', 'Old Cadoc'],
    knight: ['Ser Aldric', 'Ser Hagen of the Marches', 'Dame Rowena', 'Ser Brannoc'],
  };
  const BARKS = {
    merchant: ['Fine wares, stranger! Pelts and hides bought, draughts sold.', 'Keep your hand off your sword and I keep mine off my purse.', 'The roads run red this season. Buy a draught.'],
    pilgrim: ['The Throne calls to the wicked. Do not answer it.', 'We walk to the Nine Stones. Pray with us, or step aside.', 'The Old Gods still listen. Most nights.', 'Blood on your hands, stranger. The gods see it.'],
    bard: ['A song of the Bone King? He has no ears, so it is safe.', 'Fair warrior! Kill something grand and I will sing of it.'],
    militia: ['Harrowby watch. Keep to the road, traveller.', 'Bandits on this road. We hang the ones we catch.', 'Seen any Blackhands? Point, and we do the rest.'],
    woodcutter: ['Trees grow back. Men do not. Mind the wolves.', 'Heavy axe, light purse. That is the trade.'],
    hunter: ['The deer are skittish today. Something big walks the woods.', 'Boar tracks by the stream. A mean one, too.'],
    refugee: ['They came in the night. The dead, walking. Run south!', 'Nothing is left up north. Nothing.', 'Gods keep you, stranger. They did not keep us.'],
  };
  const LABEL = { merchant: 'Merchant', pilgrim: 'Pilgrim', bard: 'Bard', militia: 'Watchman', knight: 'Knight', woodcutter: 'Woodcutter', hunter: 'Hunter', refugee: 'Refugee' };
  function human(v, x, z, o) {
    return ent(v, x, z, Object.assign({ human: true, role: v, hp: 60, maxHp: 60, s: R(0.97, 1.06), sh: 0.38, shL: 1.2, rad: 0.4, mode: 'walk', actT: 0, atkCd: R(0.3, 1), scanT: 0, dmg: 10, fighter: false, pos: new T.Vector3(x, 0, z), spd: 0 }, o || {}));
  }
  function stepHuman(e, tx, tz, speed, dt, faceYaw, col) {
    if (e.downT > 0 || e.mode === 'lie') speed = 0;
    const dx = tx - e.x, dz = tz - e.z, d = Math.hypot(dx, dz);
    let v = 0;
    if (d > 0.08 && speed > 0) {
      v = Math.min(speed, d / Math.max(dt, 1e-3)); const k = v * dt / d;
      e.x += dx * k; e.z += dz * k; e.yaw = turn(e.yaw, Math.atan2(dx, dz), dt * 7);
      if (col && has('world', 'collide')) { e.pos.set(e.x, e.y, e.z); CT.world.collide(e.pos, 0.35); e.x = e.pos.x; e.z = e.pos.z; }
    } else if (faceYaw != null) e.yaw = turn(e.yaw, faceYaw, dt * 5);
    e.y = H(e.x, e.z); e.spd = v;
    e.a0 += dt * v * 3.6;
    e.a1 += ((v > 0.15 ? clamp(0.22 + v * 0.14, 0, 0.95) : 0) - e.a1) * Math.min(1, dt * 8);
  }
  function animHuman(e, dt) {
    if (e.downT > 0) { e.downT -= dt; const k = Math.min(1, (1.8 - e.downT) * 4, e.downT * 2.5); e.pitch = -1.35 * Math.max(0, k); e.lift = 0.1 * k; }
    else if (e.protected && e.mode !== 'lie' && e.pitch) { e.pitch *= Math.exp(-dt * 6); e.lift = 0; }
    if (e.actT > 0) { e.actT -= dt; e.a3 = Math.sin(clamp(1 - e.actT / 0.55, 0, 1) * PI) * 2.3; }
    else if (e.strum > 0) { e.strum -= dt; e.a3 = 0.55 + Math.sin(time * 11) * 0.25; }
    else e.a3 *= Math.exp(-dt * 8);
    if (e.pos) e.pos.set(e.x, e.y, e.z);
  }
  function hurtHuman(e, dmg, dir) {
    if (e.dead) return;
    if (e.rig && dir) { CT.humanoid.hit(e.rig, dir, 1); e.killDir = { x: dir.x, z: dir.z }; }
    if (e.protected) {   // important NPCs (traders, quest givers): knocked down, never killed
      if (!(e.downT > 0) && e.mode !== 'lie' && rnd() < 0.4) e.downT = 1.8;
      if (has('gore', 'spray')) CT.gore.spray(new T.Vector3(e.x, e.y + 1.2, e.z), new T.Vector3(dir.x, 0.3, dir.z).normalize(), 0.25);
      return;
    }
    e.hp -= dmg;
    if (has('gore', 'spray')) CT.gore.spray(new T.Vector3(e.x, e.y + 1.2, e.z), new T.Vector3(dir.x, 0.3, dir.z).normalize(), 0.5);
    if (e.hp <= 0) killHuman(e, true);
  }
  function killHuman(e, loud) {
    if (e.dead) return;
    e.dead = true; e.deadT = 0; e.a1 = 0; e.a3 = 0; e.sh = 0; e.fall = 0;
    DEATHS[e.protected ? 'protected' : loud ? 'npc' : 'scripted']++;
    if (e.inter) { uninter(e.inter); e.inter = null; }
    if (loud) {
      if (has('gore', 'pool')) CT.gore.pool(e.x, e.z, 0.9);
      const d = Math.hypot(e.x - P.x, e.z - P.z);
      sfx('bandit_die', new T.Vector3(e.x, e.y + 1, e.z));
      if (d < 40 && e.role !== 'militia') snd('scream', V1.set(e.x, e.y, e.z), 60);
      if (e.name && d < 30) deathNote(`${e.name} is cut down!`);
    }
    DEADFOLK.push(e);
    e.inter = inter(e.x, e.z, `Search the fallen ${(LABEL[e.role] || 'traveller').toLowerCase()}`, o => {
      uninter(o); e.inter = null;
      const loot = e.loot || [['gold', RI(2, 9)]];
      loot.forEach(([id, n]) => grant(id, n)); sfx('loot');
    }, 2.2);
  }
  let lastDeathBark = -99;
  const DEATHS = { protected: 0, npc: 0, scripted: 0 };
  function deathNote(text) { if (time - lastDeathBark < 60) return; lastDeathBark = time; say(text, 'info'); }
  const DEADFOLK = [];
  function updDeadFolk(dt) {
    for (let i = DEADFOLK.length - 1; i >= 0; i--) {
      const e = DEADFOLK[i]; e.deadT += dt;
      e.fall = Math.min(1, (e.fall || 0) + dt * 2.2); e.pitch = -PI / 2 * (e.fall * e.fall); e.lift = 0.14 * e.fall; e.y = H(e.x, e.z);
      if (e.inter) { e.inter.x = e.x; e.inter.z = e.z; }
      if (e.gone || e.deadT > 150 || Math.hypot(e.x - P.x, e.z - P.z) > 260) { drop(e); DEADFOLK.splice(i, 1); }
    }
  }

  // ── Staged fights: monsters.js monsters attacking travellers and beasts ──
  const STAGED = new Map();
  const ATKN = ['chop', 'bite', 'claw', 'tsweep', 'wclaw', 'sweep', 'thrust'];
  function stage(m, mode, o) { if (!m) return null; const s = Object.assign({ mode, set: null, v: null, cd: R(0.3, 1.2), hitAt: 0, hp: m.hp, hx: m.pos.x, hz: m.pos.z, face: m.yaw }, o || {}); STAGED.set(m, s); return s; }
  function mAttack(m) {
    const D = CT.monsters && CT.monsters._debug; if (!D || typeof D.attack !== 'function' || m.atk) return false;
    const n = ((m.beh && m.beh.atks) || []).find(a => ATKN.includes(a)); if (!n) return false;
    try { D.attack(m, n); } catch (e) { return false; }
    return true;
  }
  function goTo(m, x, z) {   // its own 'return' state walks it there; home sits 3 m past the goal so it never "arrives home" and heals
    const dx = x - m.pos.x, dz = z - m.pos.z, d = Math.hypot(dx, dz) || 1;
    m.home.x = x + dx / d * 3; m.home.z = z + dz / d * 3; m.state = 'return';
  }
  function holdM(m, yaw) { m.state = 'idle'; m.stateT = 2; if (yaw != null && !m.atk) { m.yaw = turn(m.yaw, yaw, 0.2); m.root.rotation.y = m.yaw; } }
  function nearestOf(m, set) {
    let best = null, bd = 1e9;
    if (set) for (const v of set) { if (!v || v.dead || v.gone) continue; const d = Math.hypot(v.x - m.pos.x, v.z - m.pos.z); if (d < bd) { bd = d; best = v; } }
    return best;
  }
  function hurtVictim(v, m) {
    const dmg = (m.cfg.dmg || 10) * (m.dmgK || 1) * (v.human ? (v.tough || 0.4) : 1);
    V1.set(v.x - m.pos.x, 0, v.z - m.pos.z); if (V1.lengthSq() < 1e-4) V1.set(0, 0, 1); V1.normalize();
    if (v.human) hurtHuman(v, dmg, V1); else if (v.animal) damage(v, dmg, V1, false);
  }
  function updStaged(dt) {
    for (const [m, s] of STAGED) {
      if (!m.alive || m.dead) { STAGED.delete(m); continue; }
      if (s.mode === 'free') { STAGED.delete(m); continue; }
      const pd = Math.hypot(m.pos.x - P.x, m.pos.z - P.z);
      if (s.mode === 'toll') { m.aggro = false; m.percT = 5; }
      else if (m.aggro) { if (pd > 38) { m.aggro = false; m.state = 'idle'; } else { s.hp = m.hp; continue; } }
      if (m.hp > s.hp) m.hp = s.hp;   // 'return' regenerates: staged monsters keep their wounds
      s.hp = m.hp;
      if (m.stagT > 0 || m.rise > 0) continue;
      if (pd > 120 && s.mode !== 'march') { if (!m.atk) holdM(m, null); s.hitAt = 0; continue; }   // no background battles
      switch (s.mode) {
        case 'hunt': {
          let v = s.v;
          if (!v || v.dead || v.gone) v = s.v = nearestOf(m, s.set);
          if (!v) { s.mode = 'hold'; s.hx = m.pos.x; s.hz = m.pos.z; break; }
          const dx = v.x - m.pos.x, dz = v.z - m.pos.z, d = Math.hypot(dx, dz), reach = m.cfg.reach * 0.8 + m.rad + (v.rad || 0.4), yaw = Math.atan2(dx, dz);
          if (d > reach) { if (!m.atk) goTo(m, v.x, v.z); }
          else { if (!m.atk) holdM(m, yaw); if ((s.cd -= dt) <= 0 && mAttack(m)) { s.cd = R(1.4, 2.3); s.hitAt = 0.5; } }
          if (m.atk || d <= reach) { m.yaw = yaw; m.root.rotation.y = yaw; }
          if (s.hitAt > 0 && (s.hitAt -= dt) <= 0 && d < reach + 1 && Math.hypot(v.x - P.x, v.z - P.z) < 60) hurtVictim(v, m);
          break;
        }
        case 'hold': case 'toll': {
          const dx = s.hx - m.pos.x, dz = s.hz - m.pos.z, d = Math.hypot(dx, dz);
          if (d > 2.5) goTo(m, s.hx, s.hz); else holdM(m, pd < 30 ? Math.atan2(P.x - m.pos.x, P.z - m.pos.z) : s.face);
          break;
        }
        case 'feed': {
          const dx = s.hx - m.pos.x, dz = s.hz - m.pos.z, d = Math.hypot(dx, dz);
          if (d > 2.4) goTo(m, s.hx, s.hz); else { holdM(m, Math.atan2(dx, dz)); if ((s.cd -= dt) <= 0 && mAttack(m)) s.cd = R(2, 4); if (m.atk) { m.yaw = Math.atan2(dx, dz); m.root.rotation.y = m.yaw; } }
          break;
        }
        case 'march': {
          if (!s.slot) break;
          const dx = s.slot.x - m.pos.x, dz = s.slot.z - m.pos.z, d = Math.hypot(dx, dz);
          if (d > 1.2) goTo(m, s.slot.x, s.slot.z); else holdM(m, s.slot.yaw);
          break;
        }
      }
    }
  }
  // Fighters (watchmen, guards, knights) hit monsters through monsters.damage; the monster turns on them.
  function updFighter(e, dt, range) {
    if (Math.hypot(e.x - P.x, e.z - P.z) > 120) { e.foe = null; return false; }   // far patrols do not fight
    if ((e.scanT -= dt) < 0) { e.scanT = 0.3; if (!e.foe || e.foe.dead || !e.foe.alive) e.foe = nearestMonster(e.x, e.z, range); }
    const m = e.foe;
    if (!m || m.dead || !m.alive) { e.foe = null; return false; }
    const dx = m.pos.x - e.x, dz = m.pos.z - e.z, d = Math.hypot(dx, dz), reach = 1.5 + (m.rad || 0.5);
    if (d > range * 1.4) { e.foe = null; return false; }
    if (d > reach) stepHuman(e, m.pos.x - dx / d * (reach - 0.3), m.pos.z - dz / d * (reach - 0.3), 3.8, dt, null, true);
    else { stepHuman(e, e.x, e.z, 0, dt, Math.atan2(dx, dz)); if ((e.atkCd -= dt) <= 0 && e.actT <= 0) { e.actT = 0.55; e.atkCd = R(1.1, 1.7); e.struck = false; } }
    if (e.actT > 0 && !e.struck && e.actT < 0.16) { e.struck = true; if (d < reach + 0.8 && Math.hypot(e.x - P.x, e.z - P.z) < 60) npcStrike(e, m); }   // far fights are only shown
    const min = (m.rad || 0.5) + 0.75;   // never stand inside the beast
    if (d < min && d > 1e-3) { e.x = m.pos.x - dx / d * min; e.z = m.pos.z - dz / d * min; }
    return true;
  }
  function npcStrike(e, m) {
    V1.set(m.pos.x - e.x, 0, m.pos.z - e.z); if (V1.lengthSq() < 1e-4) V1.set(0, 0, 1); V1.normalize();
    BUSY = true;
    try { if (has('monsters', 'damage')) CT.monsters.damage(m, e.dmg * R(0.8, 1.2), V1, 'torso', false, { source: 'npc' }); } finally { BUSY = false; }
    if (Math.hypot(m.pos.x - P.x, m.pos.z - P.z) > 38) {   // it and its pack turn on the attacker, not on a far-away player
      for (const o of mons()) {
        if (o.dead || !o.aggro || Math.hypot(o.pos.x - m.pos.x, o.pos.z - m.pos.z) > 40 || Math.hypot(o.pos.x - P.x, o.pos.z - P.z) <= 38) continue;
        o.aggro = false; o.state = 'idle';
        const s = STAGED.get(o) || stage(o, 'hunt');
        if (s.mode !== 'toll') { s.mode = 'hunt'; s.set = e.team || [e]; s.v = null; }
      }
    }
  }
  // Roaming monsters that meet travellers attack them (while the player is away from the monster)
  let ambT = 0;
  function updAmbush(dt) {
    if ((ambT -= dt) > 0) return;
    ambT = 0.6;
    const teams = [];
    for (const g of GROUPS) teams.push(g.members);
    for (const ev of EVS) if (ev.people.length) teams.push(ev.people);
    for (const set of teams) {
      const e0 = set.find(e => e.human && !e.dead); if (!e0) continue;
      if (Math.hypot(e0.x - P.x, e0.z - P.z) > 110) continue;
      for (const m of mons()) {
        if (m.dead || !m.alive || STAGED.has(m) || m.aggro || m.garrison || m.isBoss || m.state === 'dormant') continue;
        if (Math.hypot(m.pos.x - P.x, m.pos.z - P.z) < 40) continue;
        let near = false; for (const e of set) if (!e.dead && e.human && Math.hypot(e.x - m.pos.x, e.z - m.pos.z) < 22) { near = true; break; }
        if (near) stage(m, 'hunt', { set: set.filter(e => e.human) });
      }
    }
  }

  // ── Road travellers ────────────────────────────────────────────────────────
  const GROUPS = [];
  const RT = { x: 0, z: 0, tx: 0, tz: 1 };
  function roadAt(r, f, out) {
    f = clamp(f, 0, r.n - 1.001); const i = Math.floor(f), t = f - i;
    out.x = lerp(r.X[i], r.X[i + 1], t); out.z = lerp(r.Z[i], r.Z[i + 1], t);
    const a = Math.max(0, i - 2), b = Math.min(r.n - 1, i + 3), tx = r.X[b] - r.X[a], tz = r.Z[b] - r.Z[a], l = Math.hypot(tx, tz) || 1;
    out.tx = tx / l; out.tz = tz / l; return out;
  }
  const TKINDS = [['merchant', 3], ['pilgrims', 2.4], ['militia', 2.6], ['bard', 1.1], ['woodcutter', 1.3], ['hunter', 1.1], ['refugees', 1.8]];
  let groupT = 6, lastGroupT = -99, groupsSpawned = 0;
  function inVillage(x, z, pad) { for (const p of C.POIS) if ((p.type === 'village' || p.type === 'lodge') && Math.hypot(x - p.x, z - p.z) < p.radius + (pad || 0)) return true; return false; }
  function nearPoi(x, z, pad) { for (const p of C.POIS) if (Math.hypot(x - p.x, z - p.z) < p.radius + (pad || 0)) return true; return false; }
  function spawnGroup(kind, o) {
    o = o || {};
    const roads = CT.world && CT.world.roads; if (!roads || !roads.length) return null;
    let best = null, bs = -1e9;
    const lo = o.near ? 30 : 70, hi = o.near ? 90 : 165;
    for (const r of roads) for (let i = 6; i < r.n - 6; i += 5) {
      const x = r.X[i], z = r.Z[i], dx = x - P.x, dz = z - P.z, d = Math.hypot(dx, dz);
      if (d < lo || d > hi || inVillage(x, z, 12)) continue;
      const sc = (dx * FX_ + dz * FZ_) / d * 2 + rnd() * 1.5;
      if (sc > bs) { bs = sc; best = { r, i }; }
    }
    if (!best) return null;
    const { r, i } = best, dAt = j => { j = clamp(j, 0, r.n - 1); return Math.hypot(r.X[j] - P.x, r.Z[j] - P.z); };
    let dir = dAt(i + 8) < dAt(i - 8) ? 1 : -1;
    if (rnd() < 0.3) dir = -dir;
    if (kind === 'refugees') dir = r.Z[Math.min(r.n - 1, i + 8)] > r.Z[Math.max(0, i - 8)] ? 1 : -1;
    const g = { kind, r, f: i, dir, speed: 1.3, members: [], t: 0, barkT: 0, scanT: 0, threat: null, songT: 0, name: null, trade: null };
    const add = (e, back, lane) => { e.back = back; e.lane = lane; e.group = g; g.members.push(e); return e; };
    roadAt(r, i, RT); const x = RT.x, z = RT.z;
    const night = isNight() || dusk();
    switch (kind) {
      case 'merchant': {
        g.speed = 1.15; g.name = pick(NAMES.merchant);
        add(ent('ox', x, z, { beast: true, s: 1, sh: 0.7, shL: 1.8, rad: 0.9 }), 0, 0);
        add(ent('cart', x, z, { beast: true, cart: true, s: 1, sh: 0.9, shL: 1.6, tint: pick(PAL.canvas) }), 2.6, 0);
        const mc = add(human('merchant', x, z, { name: g.name, tint: pick(PAL.rich), tint2: pick(PAL.tunic), hp: 50, protected: true }), 2.4, 1.5);
        if (rnd() < 0.7) add(human('militia', x, z, { tint: PAL.guard, tint2: PAL.harrowLegs, fighter: true, hp: 80, dmg: 9 }), 5.4, 0);
        g.trade = tradeInter(mc, g.name, 1);
        break;
      }
      case 'pilgrims': { g.speed = 1.0; const n = RI(2, 4); for (let k = 0; k < n; k++) add(human('pilgrim', x, z, { tint: pick(PAL.robe), tint2: pick(PAL.robe), hp: 40 }), k * 1.9, k % 2 ? 0.5 : -0.5); break; }
      case 'militia': { g.speed = 1.45; const n = RI(3, 4); for (let k = 0; k < n; k++) add(human('militia', x, z, { tint: PAL.harrow, tint2: PAL.harrowLegs, fighter: true, hp: 95, dmg: 12 }), Math.floor(k / 2) * 2.2, k % 2 ? 0.7 : -0.7); break; }
      case 'bard': { g.speed = 1.2; g.name = pick(NAMES.bard); const b = add(human('bard', x, z, { name: g.name, tint: pick(PAL.rich), tint2: pick(PAL.crest), hp: 45 }), 0, 0.4); b.inter = inter(x, z, `Ask ${g.name} for a song`, () => { g.songT = 0; say(`${g.name}: A song for the stranger! Of blood and the red moon...`); }, 2.6); break; }
      case 'woodcutter': { g.speed = 1.2; const n = RI(1, 2); for (let k = 0; k < n; k++) add(human('woodcutter', x, z, { tint: pick(PAL.tunic), tint2: pick(PAL.tunic), hp: 70, fighter: true, dmg: 9 }), k * 2, k ? 0.6 : -0.3); break; }
      case 'hunter': { g.speed = 1.35; add(human('hunter', x, z, { tint: pick(PAL.green), tint2: pick(PAL.green), hp: 60, fighter: true, dmg: 10 }), 0, 0.3); break; }
      case 'refugees': { g.speed = 1.1; const n = RI(2, 5); for (let k = 0; k < n; k++) add(human('refugee', x, z, { tint: pick(PAL.rags), tint2: pick(PAL.rags), hp: 35, pitch: 0.1, s: R(0.85, 1.02) }), k * 1.7, k % 2 ? 0.6 : -0.5); break; }
    }
    for (const e of g.members) { e.team = g.members; const s = slotOf(g, e); e.x = s.x; e.z = s.z; e.y = H(e.x, e.z); e.yaw = s.yaw; }
    if (night && kind === 'pilgrims') say('Lanterns bob on the road ahead. Pilgrims, singing low.', 'info');
    GROUPS.push(g); groupsSpawned++; lastGroupT = time;
    return g;
  }
  const SLOT = { x: 0, z: 0, yaw: 0 };
  function slotOf(g, e) {
    roadAt(g.r, g.f - g.dir * e.back / 2, RT);
    const tx = RT.tx * g.dir, tz = RT.tz * g.dir;
    SLOT.x = RT.x + tz * e.lane; SLOT.z = RT.z - tx * e.lane; SLOT.yaw = Math.atan2(tx, tz);
    return SLOT;
  }
  function tradeInter(e, name, disc) {
    const o = inter(e.x, e.z, '', () => trade(o), 2.6);
    o.name = name; o.disc = disc; e.inter = o; relabel(o);
    return o;
  }
  const SPOILS = () => ((CT.rpg && CT.rpg.inventory) || []).filter(it => { const I = C.ITEMS[it.id]; return I && I.kind === 'loot' && I.price > 0 && it.count > 0; });
  function relabel(o) {
    const sp = SPOILS(); let sum = 0;
    for (const it of sp) sum += Math.max(1, Math.floor(C.ITEMS[it.id].price * (o.disc < 1 ? 0.55 : 0.4))) * it.count;
    const price = Math.round(15 * o.disc);
    o.label = sp.length ? `Trade with ${o.name}: sell spoils (+${sum} gold)` : `Trade with ${o.name}: buy a Healing Draught (${price} gold)`;
  }
  function trade(o) {
    const sp = SPOILS();
    if (sp.length) {
      let sum = 0;
      for (const it of sp.slice()) { const each = Math.max(1, Math.floor(C.ITEMS[it.id].price * (o.disc < 1 ? 0.55 : 0.4))), n = it.count; if (take(it.id, n)) sum += each * n; }
      if (sum > 0 && has('rpg', 'give')) { CT.rpg.give('gold', sum); say(`${o.name}: A fair trade. ${sum} gold, counted twice.`); sfx('loot'); }
    } else {
      const price = Math.round(15 * o.disc);
      if (gold() < price) { say(`${o.name}: No coin, no draught. The roads are hard enough.`); return; }
      if (take('gold', price)) { grant('potion', 1); say(`${o.name}: Drink it in good health. Or at least in less bad health.`); }
    }
    relabel(o);
  }
  function despawnGroup(g) {
    for (const e of g.members) { if (e.inter) { uninter(e.inter); e.inter = null; } if (!e.dead) drop(e); }
    const i = GROUPS.indexOf(g); if (i >= 0) GROUPS.splice(i, 1);
  }
  function updGroups(dt) {
    if ((groupT -= dt) < 0) {
      groupT = 8;
      const cap = low ? 2 : 3;
      if (GROUPS.length < cap && time - lastGroupT > (groupsSpawned ? R(30, 55) : 4) && !inVillage(P.x, P.z, 0)) {
        let tbl = TKINDS; if (isNight()) tbl = tbl.map(([k, w]) => [k, k === 'pilgrims' || k === 'militia' || k === 'refugees' ? w * 1.5 : w * 0.5]);
        spawnGroup(pickW(tbl));
      }
    }
    for (let i = GROUPS.length - 1; i >= 0; i--) updGroup(GROUPS[i], dt);
  }
  function updGroup(g, dt) {
    let cx = 0, cz = 0, n = 0;
    for (const e of g.members) if (!e.dead && e.human) { cx += e.x; cz += e.z; n++; }
    if (!n) { cx = g.members[0].x; cz = g.members[0].z; }
    const pd = Math.hypot(cx / Math.max(1, n) - P.x, cz / Math.max(1, n) - P.z) || (n ? 0 : 999);
    if (pd > 250 || (!n && pd > 60)) { despawnGroup(g); return; }
    const gx = n ? cx / n : cx, gz = n ? cz / n : cz;
    const fighters = g.members.some(e => e.fighter && !e.dead);
    if ((g.scanT -= dt) < 0) { g.scanT = 0.35; g.threat = nearestMonster(gx, gz, fighters ? 30 : 22); if (g.threat) g.lastTX = g.threat.pos.x, g.lastTZ = g.threat.pos.z; }
    const moving = !g.threat && n > 0 && !g.halt;
    if (moving) {
      g.f += g.dir * g.speed * dt / 2;
      if (g.f < 3 || g.f > g.r.n - 4) { if (pd > 100) { despawnGroup(g); return; } g.dir = -g.dir; g.f = clamp(g.f, 3, g.r.n - 4); }
    }
    for (const e of g.members) {
      if (e.dead) continue;
      if (e.beast) {
        const s = slotOf(g, e);
        const px = e.x, pz = e.z;
        if (moving) { e.x = lerp(e.x, s.x, Math.min(1, dt * 4)); e.z = lerp(e.z, s.z, Math.min(1, dt * 4)); e.yaw = turn(e.yaw, s.yaw, dt * 2); }
        e.y = H(e.x, e.z);
        const v = Math.hypot(e.x - px, e.z - pz) / Math.max(dt, 1e-3);
        if (e.cart) { e.a0 += v * dt; e.a1 = 0; } else { e.a0 += v * dt * 2.6; e.a1 = v > 0.1 ? 0.35 : e.a1 * 0.9; e.a2 = v > 0.1 ? 0.15 : 0.5; }
        continue;
      }
      animHuman(e, dt);
      if (e.fighter && g.threat && updFighter(e, dt, 30)) continue;
      if (!e.fighter && g.threat) { e.mode = 'flee'; e.fleeT = R(4, 6); }
      if (e.mode === 'flee') {
        const tx = g.threat ? g.threat.pos.x : g.lastTX, tz = g.threat ? g.threat.pos.z : g.lastTZ;
        const a = Math.atan2(e.x - tx, e.z - tz) + (e.lane || 0) * 0.3;
        stepHuman(e, e.x + Math.sin(a) * 5, e.z + Math.cos(a) * 5, 4.2, dt, null, true);
        if ((e.fleeT -= dt) < 0 && !g.threat) e.mode = 'return';
        continue;
      }
      const s = slotOf(g, e), sd = Math.hypot(s.x - e.x, s.z - e.z);
      if (e.mode === 'return' || sd > 3) { stepHuman(e, s.x, s.z, 2.6, dt, null, true); if (sd < 0.8) e.mode = 'walk'; continue; }
      const near = Math.hypot(P.x - e.x, P.z - e.z) < 5;
      stepHuman(e, s.x, s.z, moving ? g.speed * 1.5 : 2, dt, near ? Math.atan2(P.x - e.x, P.z - e.z) : s.yaw);
      if (e.inter) { e.inter.x = e.x; e.inter.z = e.z; if (e.inter.name) relabel(e.inter); }
      if (e.role === 'pilgrim' && pd < 110 && (isNight() || dusk()) && (e.lT = (e.lT || 0) - dt) < 0) {   // lantern halo
        e.lT = 0.07; const c = Math.cos(e.yaw), s = Math.sin(e.yaw), lx = -0.27 * e.s, lz = 0.1 * e.s;
        fx(FXA, e.x + lx * c + lz * s, e.y + 0.62 * e.s, e.z - lx * s + lz * c, 0, 0.05, 0, 0.12, 0.55, 0.45, 0x6a3a10, 0, 0);
      }
    }
    // greetings, songs
    const lead = g.members.find(e => e.human && !e.dead);
    if (lead && pd < 8 && time > g.barkT && !g.threat) {
      g.barkT = time + 45;
      const role = lead.role === 'pilgrim' ? 'pilgrim' : lead.role === 'refugee' ? 'refugee' : lead.role, lines = BARKS[role] || BARKS.pilgrim;
      say(`${lead.name || LABEL[lead.role]}: ${pick(lines)}`);
    }
    if (g.kind === 'bard' && lead && pd < 30 && time > g.songT && !g.threat) { g.songT = time + R(14, 22); snd('lute', V1.set(lead.x, lead.y + 1.2, lead.z), 70); lead.strum = 5; }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Searchable corpses (monster kills) ────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  const CORPSES = [];
  const MLABEL = { bandit: 'Bandit', orc: 'Orc', boneKnight: 'Bone Knight', ghoul: 'Ghoul', troll: 'Troll', wolf: 'Wolf' };
  const axeCache = new Map();
  function carriesAxe(m) {
    if (m.isChief) return true;
    if (!m.def) return rnd() < 0.45;
    if (axeCache.has(m.def)) return axeCache.get(m.def);
    let r = rnd() < 0.45;
    const D = CT.monsters && CT.monsters._debug && CT.monsters._debug.DEFS;
    if (D) for (const key in D) if (D[key] === m.def) { r = /"axe":1/.test(key); break; }
    axeCache.set(m.def, r); return r;
  }
  function corpseLoot(m) {
    const out = [], add = (id, n) => { if (C.ITEMS[id] && n > 0) out.push([id, n]); }, ch = p => rnd() < p;
    switch (m.type) {
      case 'bandit':
        if (m.isChief) { add('banditaxe', 1); add('mail', 1); add('gold', RI(30, 50)); add('trinket', 1); break; }
        if (ch(0.85)) add(carriesAxe(m) ? 'banditaxe' : 'banditblade', 1);
        if (ch(0.6)) add('gold', RI(3, 12)); if (ch(0.2)) add('potion', 1); if (ch(0.15)) add('trinket', 1);
        break;
      case 'orc': if (ch(0.75)) add('orccleaver', 1); if (ch(0.7)) add('gold', RI(5, 20)); if (ch(0.2)) add('trinket', 1); if (ch(0.1)) add('bigpotion', 1); break;
      case 'boneKnight': if (ch(0.5)) add('boneblade', 1); if (ch(0.7)) add('gold', RI(10, 25)); if (ch(0.25)) add('trinket', 1); break;
      case 'ghoul': if (ch(0.5)) add('gold', RI(1, 6)); if (ch(0.1)) add('trinket', 1); break;
      case 'troll': add('gold', RI(20, 50)); if (ch(0.4)) add('bigpotion', 1); if (ch(0.4)) add('trinket', 1); break;
      case 'wolf': if (ch(0.4)) add('pelt', 1); break;
      default: if (ch(0.4)) add('gold', RI(2, 8));
    }
    return out;
  }
  function onKill(d) {
    const m = d && d.monster; if (!m || m.type === 'wraith' || m.isBoss) return;
    const name = m.gibbed ? 'the remains' : (m.name || MLABEL[m.type] || 'the body');
    const c = { m, x: m.pos.x, y: m.pos.y, z: m.pos.z, t: 0, searched: false, ph: rnd() * TAU, crows: false, o: null };
    c.o = inter(c.x, c.z, `Search ${name}`, o => {
      if (c.searched) return;
      c.searched = true; uninter(o); c.o = null;
      const got = corpseLoot(m);
      if (!got.length) say('Nothing of value.', 'info'); else { got.forEach(([id, n]) => grant(id, n)); sfx('loot'); }
    }, 3.0);
    CORPSES.push(c);
  }
  function updCorpses(dt) {
    for (let i = CORPSES.length - 1; i >= 0; i--) {
      const c = CORPSES[i]; c.t += dt;
      const m = c.m;
      if ((c.pT = (c.pT || 0) - dt) < 0 && m.alive && m.root && m.root.visible !== false) {   // follow the torso of the fallen body
        c.pT = 0.5;
        const b = m.B && (m.B.spine || m.B.body || m.B.hips);
        if (b && b.parent && !m.gibbed) { b.getWorldPosition(V1); c.x = V1.x; c.z = V1.z; } else { c.x = m.pos.x; c.z = m.pos.z; }
        c.y = H(c.x, c.z);
        if (c.o) { c.o.x = c.x; c.o.z = c.z; }
      }
      if (!c.crows && c.t > 14 && Math.hypot(c.x - P.x, c.z - P.z) < 150) {
        c.crows = true;
        let near = 0; for (const q of CIRCLES) if (Math.hypot(q.x - c.x, q.z - c.z) < 40) near++;
        if (!near) addCircle(c.x, c.z, RI(3, 6), R(12, 20), R(6, 11), 110);
        if (rnd() < 0.6 && Math.hypot(c.x - P.x, c.z - P.z) > 18) { const h = spawnHerd('crows', c.x + R(-2, 2), c.z + R(-2, 2), { n: RI(3, 5) }); if (h) h.carrion = true; }
      }
      if (!m.alive || c.t > 100 || (c.searched && c.t > 20)) { if (c.o) uninter(c.o); CORPSES.splice(i, 1); }
    }
  }

  // ── Blessings of the Old Gods ─────────────────────────────────────────────
  const BUFF = { kind: null, t: 0 };
  function bless(kind) {
    BUFF.kind = kind; BUFF.t = 180;
    if (CT.player && CT.rpg && CT.rpg.stats) { if (typeof CT.player.heal === 'function') CT.player.heal(CT.rpg.stats.hpMax); }
    say(kind === 'wrath' ? 'WRATH OF THE OLD GODS: your blows strike 40% harder for 3 minutes.' : 'BLOOD OF THE EARTH: your wounds close on their own for 3 minutes.', 'quest');
  }
  function updBuff(dt) {
    if (!BUFF.kind) return;
    BUFF.t -= dt;
    if (BUFF.kind === 'regen' && CT.player && CT.player.alive !== false && typeof CT.player.heal === 'function') CT.player.heal(3 * dt);
    if (BUFF.kind && (BUFF.aT = (BUFF.aT || 0) - dt) < 0 && core) { BUFF.aT = 0.15; const c = core.camera.position; fx(FXA, c.x + R(-1.2, 1.2), c.y - 1.4, c.z + R(-1.2, 1.2), 0, R(0.8, 1.4), 0, 1.2, 0.07, 0.02, BUFF.kind === 'wrath' ? 0xff5020 : 0x40ffa0, 0, 2); }
    if (BUFF.t <= 0) { say('The blessing of the Old Gods fades.', 'info'); BUFF.kind = null; }
  }
  function onHit(d) {   // Wrath: the player's blows bite deeper (monsters.damage already applied the base hit)
    if (BUFF.kind !== 'wrath' || BUSY || !d || d.byNpc || d.corpse || d.blocked || d.phased || d.kill || !(d.damage > 0)) return;
    const m = d.target; if (!m || !m.cfg || m.dead) return;
    m.hp = Math.max(1, m.hp - d.damage * 0.4);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Encounters: the event director ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  const EVS = [];
  let FORCE = {};   // test options for debug.force
  const DIR = { acc: 0, next: 30, started: 0, done: 0, byType: {}, doneBy: {}, last: null, lastDragon: -9999, bloodDone: false, log: [], blocks: {} };
  function roadSpot(minD, maxD, spread, test) {
    const roads = CT.world && CT.world.roads; if (!roads) return null;
    let best = null, bs = -1e9; const cs = Math.cos(Math.max(1.05, spread || 0.9));
    for (const r of roads) for (let i = 4; i < r.n - 4; i += 3) {
      const x = r.X[i], z = r.Z[i], dx = x - P.x, dz = z - P.z, d = Math.hypot(dx, dz);
      if (d < minD || d > maxD) continue;
      const dot = (dx * HX + dz * HZ) / d; if (dot < cs) continue;
      if (inVillage(x, z, 30) || nearPoi(x, z, 15)) continue;
      if (test && !test(r, i)) continue;
      const sc = dot + rnd() * 0.6; if (sc > bs) { bs = sc; best = { r, i, x, z }; }
    }
    if (best) { roadAt(best.r, best.i, RT); best.tx = RT.tx; best.tz = RT.tz; best.yaw = Math.atan2(RT.tx, RT.tz); }
    return best;
  }
  function groundSpot(minD, maxD, spread, test) {
    const base = Math.atan2(HX, HZ);
    for (let i = 0; i < 40; i++) {
      const a = base + R(-spread, spread), d = R(minD, maxD), x = P.x + Math.sin(a) * d, z = P.z + Math.cos(a) * d;
      if (Math.abs(x) > 1380 || Math.abs(z) > 1380) continue;
      if (WAT(x, z) > 0.02 || inVillage(x, z, 25) || nearPoi(x, z, 12)) continue;
      if (has('world', 'normalAt') && CT.world.normalAt(x, z).y < 0.82) continue;
      if (test && !test(x, z)) continue;
      return { x, z };
    }
    return null;
  }
  function newEv(type, x, z, o) {
    const ev = Object.assign({ type, x, z, t: 0, pd: 999, props: [], people: [], beasts: [], mobs: [], inters: [], glints: [], herds: [], resolved: false, over: false, smoke: false, fire: null, life: 420 }, o || {});
    EVS.push(ev); DIR.started++; DIR.byType[type] = (DIR.byType[type] || 0) + 1;
    DIR.log.push({ t: Math.round(time), type, x: Math.round(x), z: Math.round(z) });
    return ev;
  }
  function resolve(ev, text) { if (ev.resolved) return; ev.resolved = true; DIR.done++; DIR.doneBy[ev.type] = (DIR.doneBy[ev.type] || 0) + 1; if (text) say(text, 'quest'); if (has('audio', 'sfx')) sfx('quest'); }
  function mob(ev, type, x, z, o) {
    if (!has('monsters', 'spawn')) return null;
    const m = CT.monsters.spawn(type, x, z, o || {});
    if (m) ev.mobs.push(m);
    return m;
  }
  function prop(ev, geo, x, z, yaw, s, y) {
    const mesh = new T.Mesh(typeof geo === 'string' ? propGeo(geo) : geo, MAT);
    mesh.position.set(x, y != null ? y : H(x, z), z); mesh.rotation.y = yaw || 0; if (s) mesh.scale.setScalar(s);
    mesh.userData.own = typeof geo !== 'string';
    root.add(mesh); ev.props.push(mesh); return mesh;
  }
  function evInter(ev, x, z, label, fn, r) { const o = inter(x, z, label, fn, r); ev.inters.push(o); return o; }
  function chest(ev, x, z, title, loot, xpN, text) {
    const mesh = prop(ev, 'chest', x, z, R(0, TAU));
    const g = glint(x, H(x, z) + 1.0, z); ev.glints.push(g);
    const o = evInter(ev, x, z, `Open ${title}`, () => {
      uninter(o); g.on = false; mesh.scale.set(1, 0.7, 1);
      loot.forEach(([id, n]) => grant(id, n)); if (xpN) xp(xpN); sfx('loot');
      if (text) say(text, 'info');
    }, 2.4);
    return o;
  }
  function randWeapon(tier) { return pickW([['handaxe', 4], ['dagger', 3], ['banditblade', 3], ['steelsword', 1.5 + tier], ['mace', 1 + tier * 0.5], ['greatsword', tier > 2 ? 1.2 : 0.3]].filter(e => C.ITEMS[e[0]])); }
  function lootTier(tier) {
    const out = [['gold', RI(15, 35) * tier]];
    if (rnd() < 0.5 + tier * 0.15) out.push(['potion', RI(1, tier)]);
    if (tier >= 2 && rnd() < 0.5) out.push(['bigpotion', 1]);
    if (rnd() < 0.2 + tier * 0.15) out.push([randWeapon(tier), 1]);
    if (rnd() < 0.4) out.push(['trinket', RI(1, tier)]);
    return out;
  }
  const liveMobs = ev => ev.mobs.filter(m => m.alive && !m.dead);
  const deadAll = ev => ev.mobs.length > 0 && ev.mobs.every(m => m.dead);
  function omen(ev, text, sound, pos) { say(text, 'omen'); if (sound) { const p = omenPos(ev.x, ev.z, 40); if (sound.syn) snd(sound.syn, pos || V1.set(ev.x, H(ev.x, ev.z) + 2, ev.z), 190); else sfx(sound, p); } }
  function endEv(ev) {
    for (const m of ev.props) { root.remove(m); if (m.userData.own) m.geometry.dispose(); }
    for (const o of ev.inters) uninter(o);
    for (const g of ev.glints) { g.on = false; const i = GLINTS.indexOf(g); if (i >= 0) GLINTS.splice(i, 1); }
    for (const e of ev.people) { if (e.inter) { uninter(e.inter); e.inter = null; } if (!e.dead) drop(e); }
    for (const e of ev.beasts) drop(e);
    for (const m of ev.mobs) STAGED.delete(m);
    for (const h of ev.herds) h.ev = null;
    if (ev.cleanup) ev.cleanup(ev);
  }
  // fire and smoke emitters
  function burn(ev, dt) {
    if (ev.fire && ev.pd < 180) { if ((ev.fT = (ev.fT || 0) - dt) < 0) { ev.fT = 0.04; flame(ev.fire.x, ev.fire.z, ev.fire.y); } }
    if (ev.smoke && ev.pd < 260) { if ((ev.sT = (ev.sT || 0) - dt) < 0) { ev.sT = 0.16; const s = ev.smoke; smoke(s.x, s.z, s.y); } }
  }

  const EV = {
    // Bandits hit a merchant caravan; the guards fight. Late arrivals find a looted wreck.
    caravan: {
      w: () => 3,
      start() {
        const sp = roadSpot(70, 135, 0.8); if (!sp) return null;
        const ev = newEv('caravan', sp.x, sp.z);
        const fx_ = sp.tx, fz_ = sp.tz, nx = fz_, nz = -fx_, yaw = sp.yaw, late = FORCE.late != null ? !!FORCE.late : rnd() < 0.3;
        ev.cart = ent('cart', sp.x, sp.z, { yaw, s: 1, sh: 0.9, shL: 1.6, tint: pick(PAL.canvas), roll: late ? 0.5 : 0 }); ev.beasts.push(ev.cart);
        ev.ox = ent('ox', sp.x + fx_ * 2.6, sp.z + fz_ * 2.6, { yaw, s: 1, sh: 0.7, shL: 1.8, rad: 0.9, a2: 0.4 }); ev.beasts.push(ev.ox);
        const name = pick(NAMES.merchant);
        ev.merchant = human('merchant', sp.x + nx * 1.8, sp.z + nz * 1.8, { name, tint: pick(PAL.rich), tint2: pick(PAL.tunic), hp: 55, yaw, tough: 0.3, protected: true, loot: [['gold', RI(10, 25)], ['potion', 1]] });
        const g1 = human('militia', sp.x - nx * 1.8, sp.z - nz * 1.8, { tint: PAL.guard, tint2: PAL.harrowLegs, fighter: true, hp: 90, dmg: 8, yaw });
        const g2 = human('militia', sp.x - fx_ * 3, sp.z - fz_ * 3, { tint: PAL.guard, tint2: PAL.harrowLegs, fighter: true, hp: 90, dmg: 8, yaw: yaw + PI });
        ev.people.push(ev.merchant, g1, g2); for (const e of ev.people) { e.team = ev.people; e.home = { x: e.x, z: e.z }; }
        prop(ev, 'crates', sp.x, sp.z, yaw);
        ev.smoke = { x: sp.x - fx_ * 0.6, z: sp.z - fz_ * 0.6, y: H(sp.x, sp.z) + 1.2 };
        const side = rnd() < 0.5 ? 1 : -1, n = RI(3, 4);
        for (let k = 0; k < n; k++) {
          const a = R(12, 18), b = R(-6, 6), m = mob(ev, 'bandit', sp.x + nx * side * a + fx_ * b, sp.z + nz * side * a + fz_ * b, { pack: 9000 + DIR.started });
          if (m) stage(m, late ? 'hold' : 'hunt', { set: ev.people, hx: sp.x + R(-3, 3), hz: sp.z + R(-3, 3) });
        }
        if (late) {
          for (const e of ev.people) if (e !== ev.merchant) { killHuman(e, false); e.fall = 1; }
          const M = ev.merchant; M.mode = 'lie'; M.pitch = -1.15; M.lift = 0.1;
          prop(ev, 'wheel', sp.x + nx * 2.5, sp.z + nz * 2.5, R(0, TAU));
          ev.state = 'fight'; ev.late = true; lateWreck(ev);
          addCircle(sp.x, sp.z, RI(5, 7), R(14, 22), R(7, 11), 240);
          omen(ev, 'Crows wheel over the road ahead. Smoke rises from a wagon.', { syn: 'caw' });
        } else {
          ev.state = 'fight';
          omen(ev, 'Screams echo from the road ahead...', { syn: 'scream' });
        }
        return ev;
      },
      update(ev, dt) {
        const M = ev.merchant;
        if (ev.state === 'fight') {
          if (!ev.late && (ev.clT = (ev.clT || 0) - dt) < 0 && ev.pd < 150) { ev.clT = R(0.6, 1.4); sfx(rnd() < 0.6 ? 'clang' : 'bandit_shout', omenPos(ev.x, ev.z, 30)); if (rnd() < 0.15 && !M.dead) snd('scream', V1.set(M.x, M.y + 1.5, M.z), 150); }
          for (const e of ev.people) {
            if (e.dead) continue; animHuman(e, dt);
            if (e.fighter && updFighter(e, dt, 26)) continue;
            if (e === M) { if (e.mode !== 'lie') stepHuman(e, e.home.x, e.home.z, 2, dt, Math.atan2(ev.cart.x - e.x, ev.cart.z - e.z)); e.a2 = 0.3; continue; }
            stepHuman(e, e.home.x, e.home.z, 2.5, dt, ev.pd < 10 ? Math.atan2(P.x - e.x, P.z - e.z) : null, true);
          }
          if (M.dead) {
            ev.state = 'lost'; if (ev.pd < 30) deathNote('The merchant is dead. The caravan is lost.');
            for (const m of liveMobs(ev)) { const s = STAGED.get(m); if (s) { s.mode = 'hold'; s.hx = ev.x + R(-3, 3); s.hz = ev.z + R(-3, 3); } }
            lateWreck(ev); addCircle(ev.x, ev.z, RI(4, 6), R(14, 20), R(7, 10), 200);
          } else if (deadAll(ev)) {
            ev.state = 'saved'; resolve(ev, 'Caravan saved'); if (M.mode === 'lie') { M.mode = 'walk'; M.pitch = 0; M.lift = 0; }
            say(`${M.name}: The gods sent you! Take this, and my prices are yours to name.`);
            const bx = M.x + R(-1, 1), bz = M.z + R(-1, 1);
            chest(ev, bx, bz, `${M.name}'s thanks`, [['gold', RI(30, 60)], ['potion', RI(1, 2)]], 40);
            tradeInter(M, M.name, 0.6); ev.inters.push(M.inter);
          }
        } else if (ev.state === 'saved') {
          for (const e of ev.people) { if (e.dead) continue; animHuman(e, dt); stepHuman(e, e.home.x, e.home.z, 2, dt, ev.pd < 12 ? Math.atan2(P.x - e.x, P.z - e.z) : null, true); if (e.inter) { e.inter.x = e.x; e.inter.z = e.z; if (e.inter.name) relabel(e.inter); } }
        } else if (!ev.resolved && ev.mobs.length && deadAll(ev)) {
          resolve(ev, 'The road bandits are dead'); xp(20);
        }
        burn(ev, dt);
      },
    },
    // Wolves run down a wounded stag; the herd scatters
    wolfhunt: {
      w: () => { const b = BIO(P.x, P.z); return b === 'snow' || b === 'citadel' || b === 'swamp' ? 0.5 : isNight() ? 1.5 : 2.6; },
      start() {
        const sp = groundSpot(65, 110, 0.7); if (!sp) return null;
        const ev = newEv('wolfhunt', sp.x, sp.z, { life: 300 });
        const h = spawnHerd('deer', sp.x, sp.z, { n: RI(3, 5), ev }); if (!h) return null;
        ev.herds.push(h);
        const st = h.members[0]; st.wounded = true; st.hp = 30; ev.prey = st;
        const side = Math.atan2(HX, HZ) + (rnd() < 0.5 ? PI / 2 : -PI / 2), n = RI(3, 4);
        for (let k = 0; k < n; k++) {
          const m = mob(ev, 'wolf', sp.x + Math.sin(side) * R(20, 26) + R(-3, 3), sp.z + Math.cos(side) * R(20, 26) + R(-3, 3), { pack: 9500 + DIR.started, alphaLook: k === 0 && rnd() < 0.3 });
          if (m) stage(m, 'hunt', { set: [st].concat(h.members.slice(1)) });
        }
        omen(ev, 'Wolves howl nearby. Something is being hunted.', 'wolf_howl');
        snd('screech', V1.set(sp.x, H(sp.x, sp.z) + 10, sp.z), 1);
        return ev;
      },
      update(ev, dt) {
        if (ev.prey && ev.prey.dead && !ev.fed) {
          ev.fed = true;
          for (const m of liveMobs(ev)) { const s = STAGED.get(m); if (s) { s.mode = 'feed'; s.hx = ev.prey.x + R(-1.5, 1.5); s.hz = ev.prey.z + R(-1.5, 1.5); } }
          addCircle(ev.prey.x, ev.prey.z, RI(3, 5), R(12, 18), R(6, 9), 150);
        }
        if (!ev.resolved && deadAll(ev)) { resolve(ev, 'The hunting pack is broken'); xp(30); }
        if ((ev.hT = (ev.hT || 0) - dt) < 0 && !ev.resolved && ev.pd < 140 && ev.pd > 35) { ev.hT = R(9, 16); sfx('wolf_growl', omenPos(ev.x, ev.z, 35)); }
      },
    },
    // Night: the dead claw out of a burial field
    ghouls: {
      w: () => (isNight() ? 3.5 : 0),
      start() {
        const sp = groundSpot(60, 105, 0.8); if (!sp) return null;
        const ev = newEv('ghouls', sp.x, sp.z, { life: 360 });
        const n = RI(6, 10), graves = [];
        for (let k = 0; k < n + 3; k++) { const a = k / (n + 3) * TAU + R(-0.2, 0.2), r = R(3, 11); graves.push([Math.sin(a) * r, Math.cos(a) * r]); }
        prop(ev, gravesGeo(graves), sp.x, sp.z, 0);
        ev.graves = graves.slice(0, n); ev.n = n; ev.risen = 0; ev.state = 'wait';
        omen(ev, 'The earth stirs in the old burial field...', 'ghoul_moan');
        return ev;
      },
      update(ev, dt) {
        if (ev.state === 'wait' && (ev.pd < 48 || (ev.t > 90 && ev.pd < 110))) { ev.state = 'rise'; ev.rT = 0; sfx('ghoul_shriek', omenPos(ev.x, ev.z, 25)); if (core.shake) core.shake(0.3, 1.2); }
        if (ev.state === 'rise' && (ev.rT -= dt) < 0 && ev.risen < ev.n) {
          ev.rT = R(0.3, 0.8);
          const [gx, gz] = ev.graves[ev.risen++], x = ev.x + gx, z = ev.z + gz;
          mob(ev, 'ghoul', x, z, { rise: true, aggro: ev.pd < 45, yaw: Math.atan2(P.x - x, P.z - z) });
          if (has('gore', 'burst')) CT.gore.burst(new T.Vector3(x, H(x, z) + 0.3, z), 0.7);
          dust(x, z, 18); if (rnd() < 0.5) sfx('ghoul_moan', omenPos(x, z, 30));
          if (ev.risen >= ev.n) ev.state = 'fight';
        }
        if (ev.state === 'fight' && !ev.resolved && deadAll(ev)) {
          resolve(ev, 'The dead lie still again');
          chest(ev, ev.x + R(-2, 2), ev.z + R(-2, 2), 'the grave goods', lootTier(2), 40);
        }
      },
    },
    // An orc war party marches down the road behind a war drum and a skull banner
    orcs: {
      w: () => (BIO(P.x, P.z) === 'hills' ? 3.2 : 2.2),
      start() {
        const sp = roadSpot(95, 140, 0.8); if (!sp) return null;
        const ev = newEv('orcs', sp.x, sp.z, { life: 360 });
        const r = sp.r, d0 = Math.hypot(r.X[Math.min(r.n - 1, sp.i + 8)] - P.x, r.Z[Math.min(r.n - 1, sp.i + 8)] - P.z), d1 = Math.hypot(r.X[Math.max(0, sp.i - 8)] - P.x, r.Z[Math.max(0, sp.i - 8)] - P.z);
        ev.march = { r, f: sp.i, dir: d0 < d1 ? 1 : -1, speed: 2.2 };
        const n = RI(4, 6);
        for (let k = 0; k < n; k++) {
          const m = mob(ev, 'orc', sp.x + R(-2, 2), sp.z + R(-2, 2), { pack: 9800 + DIR.started });
          if (!m) continue;
          const s = stage(m, 'march', { slot: { x: m.pos.x, z: m.pos.z, yaw: 0 }, back: Math.floor(k / 2) * 2.4, lane: k % 2 ? 1.1 : -1.1 });
          ev.march.speed = Math.min(ev.march.speed, m.speed * 0.6 * 0.92);
          if (k === 0) { const b = new T.Mesh(propGeo('banner'), MAT); b.position.set(-0.45, 0, -0.15); b.scale.setScalar(1 / m.scale); m.root.add(b); ev.banner = b; ev.bearer = m; }
          void s;
        }
        omen(ev, 'A war horn sounds. Drums on the road ahead.', { syn: 'horn' });
        return ev;
      },
      update(ev, dt) {
        const M = ev.march, live = liveMobs(ev), fighting = live.some(m => m.aggro);
        if (!fighting && live.length) {
          M.f += M.dir * M.speed * dt / 2; if (M.f < 3 || M.f > M.r.n - 4) { M.dir = -M.dir; M.f = clamp(M.f, 3, M.r.n - 4); }
          for (const m of live) {
            const s = STAGED.get(m); if (!s || s.mode !== 'march') continue;
            roadAt(M.r, M.f - M.dir * s.back / 2, RT);
            const tx = RT.tx * M.dir, tz = RT.tz * M.dir;
            s.slot.x = RT.x + tz * s.lane; s.slot.z = RT.z - tx * s.lane; s.slot.yaw = Math.atan2(tx, tz);
          }
          ev.x = lerp(ev.x, RT.x, 0.1); ev.z = lerp(ev.z, RT.z, 0.1);
          if ((ev.dT = (ev.dT || 0) - dt) < 0 && ev.pd < 150) { ev.dT = 0.62; snd('drum', V1.set(ev.x, H(ev.x, ev.z) + 1, ev.z), 170); }
        } else if (fighting) {
          for (const m of live) { const s = STAGED.get(m); if (s) s.mode = 'free'; if (!m.aggro && Math.hypot(m.pos.x - P.x, m.pos.z - P.z) < 45) { m.aggro = true; m.state = 'chase'; } }
        }
        if (!ev.resolved && deadAll(ev)) {
          resolve(ev, 'The war party is broken');
          const b = ev.bearer; const x = b ? b.pos.x + 1.5 : ev.x, z = b ? b.pos.z + 1.5 : ev.z;
          chest(ev, x, z, 'the orc war chest', lootTier(2).concat([['bigpotion', 1]]), 60);
        }
      },
    },
    // A troll squats at a ford and demands a toll
    troll: {
      w: () => 1.5,
      start() {
        const wet = (r, i) => { for (let j = -6; j <= 6; j += 2) { const q = clamp(i + j, 0, r.n - 1); for (const off of [-5, 5]) if (WAT(r.X[q] + off, r.Z[q]) > 0.2 || WAT(r.X[q], r.Z[q] + off) > 0.2) return true; } return false; };
        const sp = roadSpot(70, 135, 0.8, wet) || roadSpot(70, 135, 0.8); if (!sp) return null;
        const ev = newEv('troll', sp.x, sp.z, { life: 420 });
        const m = mob(ev, 'troll', sp.x, sp.z, { yaw: sp.yaw + PI }); if (!m) return null;
        ev.troll = m; ev.paid = false; ev.bark = false;
        stage(m, 'toll', { hx: sp.x, hz: sp.z, face: Math.atan2(P.x - sp.x, P.z - sp.z) });
        prop(ev, 'trollden', sp.x + sp.tz * 5, sp.z - sp.tx * 5, sp.yaw);
        ev.pay = evInter(ev, sp.x, sp.z, 'Pay the troll\'s toll (25 gold)', o => {
          if (ev.paid || ev.provoked) return;
          if (gold() < 25) { say('Troll: NO GOLD? THEN BONES.'); provoke(ev); return; }
          take('gold', 25); ev.paid = true; uninter(o); sfx('loot');
          say('The troll pockets your gold and shuffles aside, grumbling.', 'info');
          const s = STAGED.get(m); if (s) { s.hx = sp.x + sp.tz * 7; s.hz = sp.z - sp.tx * 7; }
          resolve(ev, null);
        }, 5.5);
        omen(ev, 'Something huge grunts by the ford ahead.', 'troll_bellow');
        return ev;
      },
      update(ev, dt) {
        const m = ev.troll;
        if (ev.pay && m && !m.dead) { ev.pay.x = m.pos.x; ev.pay.z = m.pos.z; }
        if (!ev.bark && ev.pd < 28) { ev.bark = true; say('Troll: HRRNG. Ford is mine. Twenty-five gold, or I crack your bones.'); sfx('troll_bellow', m.pos); }
        if (!ev.paid && !ev.provoked && m && !m.dead && Math.hypot(m.pos.x - P.x, m.pos.z - P.z) < 4.2) { say('Troll: THIEF! MEAT!'); provoke(ev); }
        if (m && m.dead && !ev.hoard) {
          ev.hoard = true; if (!ev.resolved) resolve(ev, 'The toll troll is slain'); else say('The toll troll is slain.', 'quest');
          chest(ev, ev.x + 2, ev.z + 2, 'the troll\'s hoard', [['gold', RI(70, 130)], ['bigpotion', RI(1, 2)], ['trinket', 2], [randWeapon(3), rnd() < 0.6 ? 1 : 0]].filter(e => e[1] > 0), 80);
        }
      },
      hit(ev, m) { if (m === ev.troll && !ev.provoked) provoke(ev); },
    },
    // A lone knight holds off bone knights
    knight: {
      w: () => 1.9,
      start() {
        const sp = roadSpot(70, 120, 0.8) || groundSpot(70, 115, 0.7); if (!sp) return null;
        const ev = newEv('knight', sp.x, sp.z, { life: 360 });
        const name = pick(NAMES.knight);
        ev.kn = human('knight', sp.x, sp.z, { name, protected: true, tint: pick(PAL.crest), tint2: pick(PAL.crest), fighter: true, hp: 260, maxHp: 260, dmg: 12, s: 1.06, tough: 0.3, loot: [['steelsword', rnd() < 0.7 ? 1 : 0], ['gold', RI(15, 30)]].filter(e => e[1] > 0) });
        ev.kn.team = [ev.kn]; ev.people.push(ev.kn); ev.kn.home = { x: sp.x, z: sp.z };
        const n = isNight() ? 3 : 2;
        for (let k = 0; k < n; k++) { const a = k / n * TAU + R(-0.4, 0.4); const m = mob(ev, 'boneKnight', sp.x + Math.sin(a) * 6, sp.z + Math.cos(a) * 6, { pack: 9900 + DIR.started }); if (m) stage(m, 'hunt', { set: [ev.kn] }); }
        addCircle(sp.x, sp.z, RI(3, 5), R(15, 22), R(8, 12), 200);
        omen(ev, 'Steel rings on steel somewhere ahead.', 'clang');
        return ev;
      },
      update(ev, dt) {
        const k = ev.kn;
        if (!k.dead) { animHuman(k, dt); if (!updFighter(k, dt, 25)) stepHuman(k, k.home.x, k.home.z, 2, dt, ev.pd < 12 ? Math.atan2(P.x - k.x, P.z - k.z) : null, true); }
        if (!ev.resolved && (ev.clT = (ev.clT || 0) - dt) < 0 && ev.pd < 150 && !k.dead) { ev.clT = R(0.5, 1.2); sfx(rnd() < 0.7 ? 'clang' : 'bone_rattle', omenPos(k.x, k.z, 30)); }
        if (!ev.resolved && k.dead && !ev.fallen) { ev.fallen = true; if (ev.pd < 30) deathNote(`${k.name} has fallen.`); }
        if (!ev.resolved && deadAll(ev)) {
          if (!k.dead) {
            resolve(ev, 'Knight saved');
            const owned = id => hasItem(id);
            const cur = CT.rpg && CT.rpg.weapon ? (CT.rpg.weapon().damage || 0) : 0;
            const up = ['steelsword', 'mace', 'greatsword'].filter(id => C.ITEMS[id] && !owned(id) && C.ITEMS[id].damage > cur * 0.9);
            say(`${k.name}: I owe you my life, stranger. Take this, and may it serve you better than it served me.`);
            if (up.length && rnd() < 0.7) grant(up[0], 1); else { grant('bigpotion', 2); grant('trinket', 1); }
            grant('gold', RI(20, 40)); xp(60);
          } else { resolve(ev, 'The bone knights are destroyed'); xp(40); }
        }
      },
    },
    // A shrine of the Old Gods: a blessing for the faithful
    shrine: {
      w: () => 1.4,
      start() {
        const sp = groundSpot(45, 90, 0.6); if (!sp) return null;
        const ev = newEv('shrine', sp.x, sp.z, { life: 600 });
        const yaw = Math.atan2(P.x - sp.x, P.z - sp.z);
        prop(ev, 'shrine', sp.x, sp.z, yaw);
        ev.glow = { x: sp.x + Math.sin(yaw) * 0.4, z: sp.z + Math.cos(yaw) * 0.4 };
        evInter(ev, sp.x + Math.sin(yaw) * 1.4, sp.z + Math.cos(yaw) * 1.4, 'Pray at the shrine of the Old Gods', o => {
          uninter(o); bless(rnd() < 0.5 ? 'wrath' : 'regen'); resolve(ev, null); ev.used = true;
          snd('chime', V1.set(sp.x, H(sp.x, sp.z) + 1, sp.z), 60);
          for (let i = 0; i < 40; i++) fx(FXA, sp.x + R(-0.6, 0.6), H(sp.x, sp.z) + R(0.5, 3), sp.z + R(-0.6, 0.6), R(-1, 1), R(1, 3), R(-1, 1), R(1, 2), 0.1, 0.02, 0x60ffc0, -0.5, 2);
        }, 2.6);
        omen(ev, 'A low hum draws you on. An old shrine glows ahead.', { syn: 'chime' });
        return ev;
      },
      update(ev, dt) {
        if (!ev.used && ev.pd < 160 && (ev.gT = (ev.gT || 0) - dt) < 0) { ev.gT = 0.12; const g = ev.glow; fx(FXA, g.x + R(-0.5, 0.5), H(g.x, g.z) + R(0.6, 2.8), g.z + R(-0.5, 0.5), 0, R(0.3, 0.8), 0, R(1.5, 2.5), 0.09, 0.02, 0x50ffc0, -0.2, 2); }
        if (!ev.used && (ev.cT = (ev.cT || 0) - dt) < 0 && ev.pd < 40) { ev.cT = R(6, 10); snd('chime', V1.set(ev.x, H(ev.x, ev.z) + 2, ev.z), 45); }
      },
    },
    // A dying traveller begs for a draught; he pays with a rumour
    dying: {
      w: () => 1.4,
      start() {
        const sp = roadSpot(50, 95, 0.7); if (!sp) return null;
        const ox = sp.x + sp.tz * 2.2, oz = sp.z - sp.tx * 2.2;
        const ev = newEv('dying', ox, oz, { life: 420 });
        const e = human('refugee', ox, oz, { tint: pick(PAL.rags), tint2: pick(PAL.rags), hp: 20, yaw: Math.atan2(sp.x - ox, sp.z - oz) + PI, pitch: -1.15, lift: 0.1, sh: 0, mode: 'lie', protected: true });
        e.a1 = 0; ev.people.push(e); ev.man = e;
        if (has('gore', 'pool')) CT.gore.pool(ox, oz, 1.0);
        ev.ask = evInter(ev, ox, oz, 'Give a Healing Draught to the dying man', o => {
          const id = hasItem('potion') ? 'potion' : hasItem('bigpotion') ? 'bigpotion' : null;
          if (!id) { say('You have no draught to give.', 'info'); return; }
          take(id, 1); uninter(o); ev.saved = true; e.pitch = -0.6; e.lift = 0.05;
          rumour(); resolve(ev, 'A life saved'); xp(25);
        }, 2.6);
        addCircle(ox, oz, RI(3, 4), R(12, 16), R(5, 8), 300);
        omen(ev, 'Someone is calling for help on the road ahead...', { syn: 'cry' });
        return ev;
      },
      update(ev, dt) {
        const e = ev.man;
        if (!ev.bark && ev.pd < 14 && !ev.saved) { ev.bark = true; say('Dying man: Please... a draught... I have seen things... I can tell you where...'); }
        if (!ev.saved && (ev.cT = (ev.cT || 0) - dt) < 0 && ev.pd < 70 && ev.pd > 8) { ev.cT = R(5, 9); snd('cry', V1.set(e.x, e.y + 0.5, e.z), 80); }
      },
    },
    // Bandits bar the road: pay or bleed
    toll: {
      w: () => 2,
      start() {
        const sp = roadSpot(70, 125, 0.8); if (!sp) return null;
        const ev = newEv('toll', sp.x, sp.z, { life: 420 });
        prop(ev, 'barrier', sp.x, sp.z, sp.yaw);
        const fx_ = sp.tx, fz_ = sp.tz, nx = fz_, nz = -fx_, towardP = ((P.x - sp.x) * fx_ + (P.z - sp.z) * fz_) > 0 ? 1 : -1;
        const cx = sp.x + nx * 5.5 - fx_ * towardP * 3, cz = sp.z + nz * 5.5 - fz_ * towardP * 3;
        prop(ev, 'campfire', cx, cz, R(0, TAU)); ev.fire = { x: cx, z: cz, y: H(cx, cz) }; ev.smoke = { x: cx, z: cz, y: H(cx, cz) + 1 };
        const n = RI(3, 4);
        for (let k = 0; k < n; k++) {
          const hx = k === 0 ? sp.x + fx_ * towardP * 2.2 : cx + R(-2.5, 2.5), hz = k === 0 ? sp.z + fz_ * towardP * 2.2 : cz + R(-2.5, 2.5);
          const m = mob(ev, 'bandit', hx, hz, { pack: 9700 + DIR.started }); if (m) stage(m, 'toll', { hx, hz, face: Math.atan2(sp.x - hx, sp.z - hz) });
        }
        ev.gate = { x: sp.x, z: sp.z };
        ev.pay = evInter(ev, sp.x + fx_ * towardP * 3.2, sp.z + fz_ * towardP * 3.2, 'Pay the Blackhand toll (20 gold)', o => {
          if (ev.paid || ev.provoked) return;
          if (gold() < 20) { say('Bandit: No coin? Then we take it out of your hide!'); provoke(ev); return; }
          take('gold', 20); ev.paid = true; uninter(o); sfx('loot');
          say('Bandit: Pleasure doing business. Mind the wolves, friend.'); resolve(ev, null);
          ev.props[0].rotation.z = 1.2;
        }, 3.2);
        omen(ev, 'Rough voices laugh at a barricade on the road ahead.', 'bandit_shout');
        return ev;
      },
      update(ev, dt) {
        burn(ev, dt);
        if (!ev.bark && ev.pd < 26 && !ev.provoked) { ev.bark = true; say('Bandit: Road toll! Twenty gold to pass. Pay, or bleed.'); sfx('bandit_shout', omenPos(ev.x, ev.z, 10)); }
        if (!ev.paid && !ev.provoked && Math.hypot(ev.gate.x - P.x, ev.gate.z - P.z) < 2.2) { say('Bandit: Bleed it is!'); provoke(ev); }
        if (ev.provoked && !ev.box && deadAll(ev)) { ev.box = true; if (!ev.resolved) resolve(ev, 'The toll gate is broken'); chest(ev, ev.fire.x + 1.5, ev.fire.z + 1.2, 'the toll box', lootTier(1).concat([['gold', ev.paid ? 20 : 0]]).filter(e => e[1] > 0), 35); }
      },
      hit(ev, m) { if (!ev.provoked && ev.mobs.includes(m)) provoke(ev); },
    },
    // A wyrm crosses the sky: pure spectacle
    dragon: {
      w: () => (time - DIR.lastDragon > 480 ? 0.7 : 0),
      bg: true,
      start() {
        DIR.lastDragon = time;
        const side = Math.atan2(HX, HZ) + (rnd() < 0.5 ? PI / 2 : -PI / 2) + R(-0.4, 0.4);
        const sx = P.x + Math.sin(side) * 480 + HX * 70, sz = P.z + Math.cos(side) * 480 + HZ * 70;
        const ex = P.x - Math.sin(side) * 480 + HX * 40, ez = P.z - Math.cos(side) * 480 + HZ * 40;
        const ev = newEv('dragon', sx, sz, { bg: true, life: 40 });
        ev.a = { x: sx, z: sz }; ev.b = { x: ex, z: ez }; ev.alt = R(60, 85);
        ev.d = ent('dragon', sx, sz, { s: 2.2, sh: 12, bigShadow: true, shL: 1.8, yaw: Math.atan2(ex - sx, ez - sz), a3: 0.12 }); ev.beasts.push(ev.d);
        omen(ev, 'A vast shadow crosses the sky...', null);
        return ev;
      },
      update(ev, dt) {
        const k = ev.t / 20, d = ev.d;
        if (k >= 1) { ev.over = true; if (!ev.resolved) resolve(ev, null); return; }
        d.x = lerp(ev.a.x, ev.b.x, k); d.z = lerp(ev.a.z, ev.b.z, k); d.gy = H(d.x, d.z); d.y = Math.max(d.gy, 0) + ev.alt - Math.sin(k * PI) * 25;
        d.a0 += dt * 2.6; d.a1 = 0.5; d.a3 = 0.1; d.pitch = 0.05; d.roll = Math.sin(time * 0.7) * 0.08;
        if (!ev.roar && k > 0.42) { ev.roar = true; sfx('boss_roar', omenPos(d.x, d.z, 25)); if (core.shake) core.shake(0.4, 1.4); if (has('sky', 'flash')) CT.sky.flash(0xff4010, 0.25); }
        if (k > 0.8 && !ev.said) { ev.said = true; say('The wyrm flies north, toward the Crimson Throne.', 'info'); }
      },
    },
    // Blood Moon: the hunt comes in waves
    bloodhunt: {
      w: () => 0,
      start() {
        const ev = newEv('bloodhunt', P.x, P.z, { life: 300, wave: 0, wT: 3 });
        omen(ev, 'The Blood Moon calls the hunt! Stand and fight.', { syn: 'horn' });
        return ev;
      },
      update(ev, dt) {
        ev.x = P.x; ev.z = P.z; ev.pd = 0;
        if (ev.wave < 3 && ((ev.wT -= dt) < 0 || (ev.wave > 0 && liveMobs(ev).length === 0 && ev.wT < 30))) {
          ev.wave++; ev.wT = 40;
          const n = RI(4, 6), types = ev.wave === 3 ? ['orc', 'ghoul', 'wolf'] : ['ghoul', 'wolf'];
          for (let k = 0; k < n; k++) { const a = rnd() * TAU, r = R(28, 40); mob(ev, pick(types), P.x + Math.sin(a) * r, P.z + Math.cos(a) * r, { aggro: true, rise: rnd() < 0.5 }); }
          snd('horn', V1.set(P.x + 30, P.y, P.z), 100); say(`Blood Moon hunt: wave ${ev.wave} of 3`, 'info');
        }
        if (ev.wave >= 3 && !ev.resolved && deadAll(ev)) { resolve(ev, 'You survived the Blood Moon hunt'); chest(ev, P.x + HX * 2.5, P.z + HZ * 2.5, 'the blood-moon cache', lootTier(3), 120); }
        if (!bloodmoon() && ev.wave < 3) ev.over = true;
      },
    },
  };
  function provoke(ev) {
    if (ev.provoked) return;
    ev.provoked = true;
    if (ev.pay) uninter(ev.pay);
    for (const m of liveMobs(ev)) { const s = STAGED.get(m); if (s) s.mode = 'free'; m.aggro = true; m.state = 'chase'; m.percT = 0; }
  }
  function lateWreck(ev) {
    if (ev.wreck) return;
    const x = ev.cart.x + R(-1, 1), z = ev.cart.z + R(-1, 1);
    ev.wreck = evInter(ev, x, z, 'Search the plundered wagon', o => {
      uninter(o); grant('potion', RI(1, 2)); grant('gold', RI(8, 25)); if (rnd() < 0.3) grant('trinket', 1); if (rnd() < 0.2) grant(randWeapon(1), 1); sfx('loot');
      say('The bandits missed a few things.', 'info');
    }, 3.2);
  }
  function rumour() {
    const pois = (CT.world && CT.world.pois) || C.POIS;
    const LINES = {
      lodge: 'West, past the pines, the huntress Vesna keeps a lodge. Red-Arrow, they call her.',
      wolfden: 'The wolves den in a hollow far to the west. The Gnawing Hollow. Bones everywhere.',
      camp: 'The Blackhand bandits camp on the hill road north of Harrowby. Their chief is Grask.',
      stones: 'Nine standing stones hum in the hills at the heart of the isle.',
      fen: 'East lies the Weeping Fen. A witch lives there, pale as the moon.',
      ruins: 'Beyond the fen stand the Moonfall Ruins. Something guards a blade there.',
      crossing: 'Gallows Crossing is the last village before the snows. They hang bandits there.',
    };
    const cand = pois.filter(p => LINES[p.id] && !p.found);
    if (!cand.length) { say('Dying man: You know this isle better than I do... take my purse, then.'); grant('gold', RI(20, 35)); grant('trinket', 1); return; }
    const p = pick(cand);
    say(`Dying man: ${LINES[p.id]}`);
    p.found = true; bus.emit('poi', { id: p.id, name: p.name });
  }
  function startEv(type) {
    const E = EV[type]; if (!E) return null;
    let ev = null;
    try { ev = E.start(); } catch (e) { console.error('[CT.life start ' + type + ']', e); ev = null; }
    if (ev) { if (E.bg) ev.bg = true; DIR.last = type; }
    return ev;
  }
  function updDirector(dt) {
    DIR.acc += dt * (movedT > 0 ? 1 : 0.35);
    if (bloodmoon() && isNight()) {
      if (!DIR.bloodDone && !inVillage(P.x, P.z, 20)) { DIR.bloodDone = true; startEv('bloodhunt'); }
    } else DIR.bloodDone = false;
    if (DIR.acc < DIR.next || (DIR.tryT = (DIR.tryT || 0) - dt) > 0) return;
    DIR.tryT = 2;
    const over = DIR.acc - DIR.next;   // seconds overdue: a long chase no longer starves the road of stories
    const busy = EVS.some(e => !e.bg && !e.resolved && e.pd < 120 && ((e.x - P.x) * HX + (e.z - P.z) * HZ) > 0.2 * e.pd);   // only unfinished business ahead
    // "in combat" = a hostile is on you; the raised roaming density keeps monsters.inCombat true most of a journey
    const fr = over > 25 ? 7 : 14;
    let fight = false; for (const m of mons()) if (!m.dead && m.aggro && Math.hypot(m.pos.x - P.x, m.pos.z - P.z) < fr) { fight = true; break; }
    const why = inVillage(P.x, P.z, 30) ? 'village' : fight ? 'fight' : busy ? 'busy' : EVS.filter(e => !e.bg).length >= 3 ? 'cap' : null;
    if (why) { DIR.blocks[why] = (DIR.blocks[why] || 0) + 1; return; }
    const tbl = [];
    for (const k in EV) { if (k === DIR.last) continue; const w = EV[k].w(); if (w > 0) tbl.push([k, w]); }
    for (let tries = 0; tries < 5 && tbl.length; tries++) {
      const k = pickW(tbl);
      if (startEv(k)) { DIR.acc = 0; DIR.next = R(45, 90); return; }
      const i = tbl.findIndex(e => e[0] === k); if (i >= 0) tbl.splice(i, 1);
    }
    DIR.blocks.nospot = (DIR.blocks.nospot || 0) + 1;
  }
  function updEvents(dt) {
    for (let i = EVS.length - 1; i >= 0; i--) {
      const ev = EVS[i]; ev.t += dt;
      ev.pd = Math.hypot(ev.x - P.x, ev.z - P.z);
      try { EV[ev.type].update(ev, dt); } catch (e) { console.error('[CT.life event ' + ev.type + ']', e); ev.over = true; }
      if (ev.type !== 'caravan' && ev.type !== 'toll') burn(ev, dt);
      if (ev.pd > 250 && !ev.bg || ev.t > ev.life || ev.over) { endEv(ev); EVS.splice(i, 1); }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Lifecycle ──────────────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  const MAX = { deer: 30, stag: 10, hare: 20, boar: 12, goat: 16, ox: 5, cart: 5, crow: 64, eagle: 2, bat: 12, fish: 4, dragon: 1,
    merchant: 6, pilgrim: 14, bard: 3, militia: 18, knight: 3, woodcutter: 6, hunter: 4, refugee: 16 };
  const MET = new Map();
  const PERF = { ms: 0, n: 0, max: 0, prof: false, sec: {} };
  let LAP = 0;
  function lap(name) {   // optional per-section timing (debug.profile(true)); lap(null) starts a run
    if (!PERF.prof) return;
    const t = performance.now(), d = t - LAP; LAP = t; if (!name) return;
    const q = PERF.sec[name] || (PERF.sec[name] = { sum: 0, max: 0, n: 0 }); q.sum += d; q.n++; if (d > q.max) q.max = d;
  }
  function init(c) {
    core = c; low = c.quality === 'low';
    root = new T.Group(); root.name = 'life'; c.scene.add(root);
    prims(); makeMat();
    const D = { deer: () => dDeer(false), stag: () => dDeer(true), hare: dHare, boar: dBoar, goat: dGoat, ox: dOx, cart: dCart,
      crow: () => dBird({ col: 0x141214, wing: 0x1a181c, beak: 0x2a2420, w: 0.14, len: 0.15, span: 0.62, legs: true }),
      eagle: () => dBird({ col: 0x4a3020, wing: 0x3a2618, head: 0xe8e0d0, beak: 0xd0a030, w: 0.2, len: 0.32, span: 1.9 }),
      bat: dBat, fish: dFish, dragon: dDragon };
    for (const k in D) mkPool(k, D[k](), Math.max(1, Math.round(MAX[k] * (low ? 0.5 : 1))));
    for (const k in HUMANS) mkPool(k, HUMANS[k](), Math.max(2, Math.round(MAX[k] * (low ? 0.5 : 1))));
    if (kitOn() && CT.humanoid.prewarm) { try { CT.humanoid.prewarm(kitSpecs()); } catch (e) { console.warn('[life] prewarm', e); } }
    SHP = simplePool(GP.disc, new T.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.38, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), low ? 60 : 120);
    GLP = simplePool(GP.oct, new T.MeshBasicMaterial({ color: new T.Color(3.2, 2.5, 1.2), transparent: true, blending: T.AdditiveBlending, depthWrite: false }), 24);
    FXA = makeFx(low ? 400 : 800, true); FXN = makeFx(low ? 400 : 800, false); FF = makeFireflies(low ? 24 : 48);
    bus.on('kill', onKill);
    bus.on('hit', d => { onHit(d); for (const ev of EVS) if (EV[ev.type].hit && d && d.target) EV[ev.type].hit(ev, d.target); });
    bus.on('swing', d => { const w = (d && d.weapon) || (has('rpg', 'weapon') ? CT.rpg.weapon() : {}) || {}; SWINGS.push({ t: (d && d.heavy ? 0.62 * 0.3 : 0.45 * 0.37) / (w.speed || 1), w, heavy: !!(d && d.heavy) }); });
    const p = CT.player && CT.player.pos; if (p) LP.copy(p);
  }
  function readPlayer(dt) {
    const p = CT.player;
    if (p && p.pos) P.copy(p.pos); else { P.copy(core.camera.position); P.y -= 1.7; }
    const yaw = p && p.yaw != null ? p.yaw : core.camera.rotation.y;
    FX_ = -Math.sin(yaw); FZ_ = -Math.cos(yaw);
    const mx = P.x - LP.x, mz = P.z - LP.z, mv = Math.hypot(mx, mz);
    if (mv > 0.02 && mv < 90) {
      const k = mv > 4 ? 1 : Math.min(1, dt * 2);
      HX = lerp(HX, mx / mv, k); HZ = lerp(HZ, mz / mv, k); const l = Math.hypot(HX, HZ) || 1; HX /= l; HZ /= l;
      movedT = 1.5;
    } else if ((movedT -= dt) < -3) { HX = lerp(HX, FX_, Math.min(1, dt)); HZ = lerp(HZ, FZ_, Math.min(1, dt)); }
    pSpeed = dt > 0 && mv < 4 ? lerp(pSpeed, mv / dt, Math.min(1, dt * 3)) : pSpeed;
    const inp = core.input || {};
    sprinting = !!inp.sprint && pSpeed > 5;
    LP.copy(P);
  }
  function update(dt, c) {
    if (!core || !root) return;
    const t0 = performance.now();
    core = c || core; time += dt;
    if (PENDING.length && CT.interactables) { for (const o of PENDING) if (!o.disabled) CT.interactables.add(o); PENDING.length = 0; }
    readPlayer(dt);
    RIM.value.set(isNight() ? 0x1c2a5a : 0x6a3418);
    if (dt > 0) {
      for (let i = SWINGS.length - 1; i >= 0; i--) { const s = SWINGS[i]; if ((s.t -= dt) <= 0) { SWINGS.splice(i, 1); strikeAnimals(s); } }
      lap(null);
      updHerdSpawns(dt); lap('spawn');
      for (let i = HERDS.length - 1; i >= 0; i--) updHerd(HERDS[i], dt); lap('herds');
      updCarcass(dt); updCircles(dt); updSkyLife(dt); lap('birds');
      updGroups(dt); updDeadFolk(dt); lap('groups');
      updStaged(dt); updAmbush(dt); lap('staged');
      updCorpses(dt); updBuff(dt); lap('corpses');
      updDirector(dt); updEvents(dt); lap('events');
      if ((MET.t = (MET.t || 0) - dt) < 0) { MET.t = 0.5; for (const m of mons()) if (!m.dead && Math.hypot(m.pos.x - P.x, m.pos.z - P.z) < 45 && !MET.has(m.id)) MET.set(m.id, time); }
    }
    lap(null);
    updFx(FXA, dt); updFx(FXN, dt); updFireflies(dt); lap('fx');
    KDT = dt; render(); lap('render');
    const ms = performance.now() - t0; PERF.ms += ms; PERF.n++; PERF.max = Math.max(PERF.max, ms);
  }

  // ── Debug hooks for tests ──────────────────────────────────────────────────
  api.debug = {
    force(name, o) { if (!core) return null; readPlayer(0); FORCE = o || {}; const ev = startEv(name); FORCE = {}; return ev ? { type: ev.type, x: Math.round(ev.x), z: Math.round(ev.z) } : null; },
    group(kind, near) { const g = spawnGroup(kind, { near: near !== false }); return g ? { kind, x: Math.round(g.members[0].x), z: Math.round(g.members[0].z) } : null; },
    herd(kind, dist) { const d = dist || 25, x = P.x + FX_ * d, z = P.z + FZ_ * d; const h = spawnHerd(kind, x, z); return h ? h.members.length : 0; },
    stats(reset) {
      const sp = {}, near = {};
      for (const e of ENTS) { sp[e.pool] = (sp[e.pool] || 0) + 1; if (Math.hypot(e.x - P.x, e.z - P.z) < 120 && !e.dead) near[e.pool] = (near[e.pool] || 0) + 1; }
      let calls = 0; for (const k in POOLS) if (POOLS[k].mesh.visible) calls++;
      calls += (SHP.mesh.visible ? 1 : 0) + (GLP.mesh.visible ? 1 : 0) + (FXA.n ? 1 : 0) + (FXN.n ? 1 : 0) + (FF.pts.visible ? 1 : 0);
      for (const ev of EVS) calls += ev.props.length;
      const out = {
        ms: PERF.n ? +(PERF.ms / PERF.n).toFixed(3) : 0, msMax: +PERF.max.toFixed(2), calls, ents: ENTS.length, pools: sp, near,
        herds: HERDS.length, groups: GROUPS.map(g => g.kind), groupsSpawned, circles: CIRCLES.length, corpses: CORPSES.length, carcasses: CARCASS.length,
        events: { active: EVS.map(e => e.type + (e.resolved ? '*' : '') + '@' + Math.round(e.pd)), started: DIR.started, done: DIR.done, byType: DIR.byType, doneBy: DIR.doneBy, next: Math.round(DIR.next - DIR.acc), blocks: DIR.blocks },
        monstersMet: MET.size, deaths: DEATHS, staged: STAGED.size, buff: BUFF.kind, fx: FXA.n + FXN.n,
      };
      if (reset) { PERF.ms = 0; PERF.n = 0; PERF.max = 0; }
      return out;
    },
    state: () => ({ DIR, EVS, GROUPS, HERDS, CORPSES, STAGED, ENTS, POOLS, root }),
    audio: () => (AC ? AC.state : 'none'),
    bless, nextIn(s) { DIR.acc = Math.max(0, DIR.next - (s || 0)); },
    profile(on) { PERF.prof = !!on; const out = {}; for (const k in PERF.sec) { const q = PERF.sec[k]; out[k] = [+(q.sum / Math.max(1, q.n)).toFixed(3), +q.max.toFixed(2)]; } PERF.sec = {}; return out; },
  };
})();
