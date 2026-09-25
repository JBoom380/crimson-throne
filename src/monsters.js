// ─── MONSTERS: Frazetta beasts, procedural rigs, AI, dismemberment ───────────
(function () {
  const T = THREE, PI = Math.PI, TAU = PI * 2;
  const C = CT.config, bus = CT.bus, CFG = C.MONSTERS;
  const rnd = Math.random;
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, k) => a + (b - a) * k;
  const smooth = x => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
  const eOut = x => { x = clamp(x, 0, 1); return 1 - (1 - x) * (1 - x) * (1 - x); };
  const wrap = a => { while (a > PI) a -= TAU; while (a < -PI) a += TAU; return a; };
  const has = (m, f) => !!(CT[m] && typeof CT[m][f] === 'function' && !(CT._broken && CT._broken[m]));
  const ground = (x, z) => { const y = has('world', 'heightAt') ? CT.world.heightAt(x, z) : 0; return y === y && y != null ? y : 0; };
  const isNight = () => has('sky', 'isNight') && !!CT.sky.isNight();
  const bloodmoon = () => !!(CT.sky && CT.sky.weather === 'bloodmoon');
  function sfx(name, pos) { if (has('audio', 'sfx')) CT.audio.sfx(name, pos ? { pos } : {}); }

  let core = null, scene = null, nextId = 1, playTime = 0;
  const api = CT.monsters = { list: [], inCombat: false, init, update, spawn, hitTest, damage, nearest, bossInfo, stagger };
  const list = api.list;

  // temps (no per-frame allocation)
  const V1 = new T.Vector3(), V2 = new T.Vector3(), V3 = new T.Vector3(), V4 = new T.Vector3(), PP = new T.Vector3();
  const Q1 = new T.Quaternion(), S1 = new T.Vector3(), M4 = new T.Matrix4(), N3 = new T.Matrix3(), E1 = new T.Euler(), COL = new T.Color();

  // ── Player access ──────────────────────────────────────────────────────────
  function playerPos() {
    const p = CT.player;
    if (p && p.pos) PP.copy(p.pos); else if (core) { PP.copy(core.camera.position); PP.y -= C.PLAYER.eye; }
    return PP;
  }
  const playerAlive = () => !CT.player || CT.player.alive !== false;
  const playerYaw = () => (CT.player && CT.player.yaw != null ? CT.player.yaw : core.camera.rotation.y);

  // ── Shared resources ───────────────────────────────────────────────────────
  const GP = {}, MAT = {}, DEFS = {};
  let GRAD = null;
  function shared() {
    if (GRAD) return;
    GRAD = new T.DataTexture(new Uint8Array([52, 110, 175, 255]), 4, 1, T.RedFormat);
    GRAD.minFilter = GRAD.magFilter = T.NearestFilter; GRAD.generateMipmaps = false; GRAD.needsUpdate = true;
    const ni = g => (g.index ? g.toNonIndexed() : g);
    GP.sph = ni(new T.SphereGeometry(1, 8, 6));
    GP.ball = ni(new T.SphereGeometry(1, 6, 4));
    GP.box = ni(new T.BoxGeometry(1, 1, 1));
    GP.cyl = ni(new T.CylinderGeometry(1, 1, 1, 7));
    GP.tapd = ni(new T.CylinderGeometry(1, 0.68, 1, 7));   // wide top, narrow bottom (limbs)
    GP.tapu = ni(new T.CylinderGeometry(0.55, 1, 1, 8));   // narrow top, wide bottom (robes, sleeves)
    GP.cone = ni(new T.ConeGeometry(1, 1, 6));
    GP.ico = ni(new T.IcosahedronGeometry(1, 0));
    GP.tor = ni(new T.TorusGeometry(1, 0.1, 4, 10));
    MAT.glow = new T.MeshBasicMaterial({ vertexColors: true, color: new T.Color(2.4, 2.4, 2.4), fog: false });
    MAT.stump = toonMat(0x400404);
    MAT.shadow = new T.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.42, depthWrite: false });
    GP.disc = new T.CircleGeometry(1, 10).rotateX(-PI / 2);
    GP.stump = buildGeo([['cyl', 0x4a0004, 0, -0.02, 0, 1.02, 0.2, 1.02], ['cyl', 0xb01410, 0, -0.07, 0, 0.82, 0.14, 0.82],
      ['cyl', 0xeadcc0, 0, -0.12, 0, 0.32, 0.34, 0.32], ['ball', 0x7a0808, 0.4, -0.1, 0.2, 0.3, 0.2, 0.3]]);
    GP.meat = buildGeo([['ico', 0x8a1010, 0, 0, 0, 1, 0.8, 0.9], ['ball', 0xc02020, 0.3, 0.3, 0.2, 0.5, 0.4, 0.5], ['cyl', 0xe8dcc0, -0.2, 0, 0, 0.18, 1.4, 0.18, 0, 0, 1.2]]);
    GP.shard = buildGeo([['cone', 0xe0d4b8, 0, 0, 0, 0.35, 1.4, 0.35, 0.2, 0, 0.3]]);
    MAT.meat = toonMat(0x301008);
    MAT.aura = new T.MeshBasicMaterial({ color: new T.Color(0.12, 0.35, 0.8), transparent: true, opacity: 0.35, blending: T.AdditiveBlending, depthWrite: false, side: T.BackSide, fog: false });
    MAT.pool = new T.MeshBasicMaterial({ color: 0x2a0003, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    MAT.wave = new T.MeshBasicMaterial({ color: new T.Color(3, 0.7, 0.15), transparent: true, opacity: 0.9, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide, fog: false });
    GP.wave = new T.RingGeometry(0.93, 1, 56).rotateX(-PI / 2);
  }
  // Toon + flat shading + a hot rim light (the Frazetta back-light).
  function toonMat(rim, opacity) {
    const m = new T.MeshToonMaterial({ color: 0xffffff, vertexColors: true, gradientMap: GRAD });
    if (opacity != null && opacity < 1) { m.transparent = true; m.opacity = opacity; m.depthWrite = true; }
    const u = { value: new T.Color(rim) };
    m.userData.rim = u;
    m.onBeforeCompile = sh => {
      sh.uniforms.uRim = u;
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 uRim;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n{ float rk = 1.0 - abs(dot(normal, normalize(vViewPosition))); totalEmissiveRadiance += uRim * rk * rk * rk; }');
    };
    m.customProgramCacheKey = () => 'ctRimToon';
    return m;
  }
  // Merge primitive parts into one vertex-coloured geometry (one draw call per bone).
  function buildGeo(parts) {
    let n = 0;
    for (const p of parts) n += GP[p[0]].attributes.position.count;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
    let o = 0;
    for (const p of parts) {
      const g = GP[p[0]], pa = g.attributes.position.array, na = g.attributes.normal.array, cnt = g.attributes.position.count;
      M4.compose(V1.set(p[2], p[3], p[4]), Q1.setFromEuler(E1.set(p[8] || 0, p[9] || 0, p[10] || 0)), S1.set(p[5], p[6], p[7]));
      N3.getNormalMatrix(M4); COL.set(p[1]);
      for (let i = 0; i < cnt; i++, o++) {
        V1.set(pa[i * 3], pa[i * 3 + 1], pa[i * 3 + 2]).applyMatrix4(M4);
        pos[o * 3] = V1.x; pos[o * 3 + 1] = V1.y; pos[o * 3 + 2] = V1.z;
        V2.set(na[i * 3], na[i * 3 + 1], na[i * 3 + 2]).applyMatrix3(N3).normalize();
        nor[o * 3] = V2.x; nor[o * 3 + 1] = V2.y; nor[o * 3 + 2] = V2.z;
        const k = 0.8 + 0.2 * na[i * 3 + 1];            // painted top light per part
        col[o * 3] = COL.r * k; col[o * 3 + 1] = COL.g * k; col[o * 3 + 2] = COL.b * k;
      }
    }
    for (let i = 0; i < n * 3; i += 9) {                // flat facet normals: the chunky low-poly look
      const ax = pos[i + 3] - pos[i], ay = pos[i + 4] - pos[i + 1], az = pos[i + 5] - pos[i + 2];
      const bx = pos[i + 6] - pos[i], by = pos[i + 7] - pos[i + 1], bz = pos[i + 8] - pos[i + 2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx; const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      for (let k = 0; k < 9; k += 3) { nor[i + k] = nx; nor[i + k + 1] = ny; nor[i + k + 2] = nz; }
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new T.BufferAttribute(nor, 3));
    geo.setAttribute('color', new T.BufferAttribute(col, 3));
    geo.computeBoundingSphere();
    return geo;
  }

  // ── Design kit ─────────────────────────────────────────────────────────────
  function kit() {
    const d = { bones: [], parts: {}, glows: {}, hits: [], sev: {}, sr: {}, tip: ['wpR', 0, 0, 0.8], lieH: 0.2, hipY: 1, rig: 'biped' };
    d.bone = (n, p, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => d.bones.push([n, p, x, y, z, rx, ry, rz]);
    d.p = (b, g, c, x, y, z, sx, sy, sz, rx = 0, ry = 0, rz = 0) => (d.parts[b] = d.parts[b] || []).push([g, c, x, y, z, sx, sy, sz, rx, ry, rz]);
    d.g = (b, g, c, x, y, z, sx, sy, sz, rx = 0, ry = 0, rz = 0) => (d.glows[b] = d.glows[b] || []).push([g, c, x, y, z, sx, sy, sz, rx, ry, rz]);
    d.m = (b, g, c, x, y, z, sx, sy, sz, rx = 0, ry = 0, rz = 0) => { d.p(b, g, c, x, y, z, sx, sy, sz, rx, ry, rz); d.p(b, g, c, -x, y, z, sx, sy, sz, rx, -ry, -rz); };
    d.mg = (b, g, c, x, y, z, sx, sy, sz, rx = 0, ry = 0, rz = 0) => { d.g(b, g, c, x, y, z, sx, sy, sz, rx, ry, rz); d.g(b, g, c, -x, y, z, sx, sy, sz, rx, -ry, -rz); };
    d.hit = (part, b, x, y, z, r) => d.hits.push([part, b, x, y, z, r]);
    d.sv = (part, b, r) => { d.sev[part] = b; d.sr[part] = r; };
    return d;
  }
  const SIDES = [['L', 1], ['R', -1]];   // models face +Z, so the right hand is at -X

  // Heroic humanoid body: muscle masses or bare bones (o.skel).
  function humanoid(d, o) {
    o = Object.assign({ th: 0.44, sh: 0.44, foot: 0.07, torso: 0.6, neck: 0.07, chestW: 0.2, chestD: 0.15, waistW: 0.15, shW: 0.25,
      ua: 0.3, fa: 0.28, ar: 0.05, lr: 0.07, hipW: 0.1, headR: 0.115, hunch: 0.08, headFwd: 0.02 }, o);
    const c = o.col, hipY = o.th + o.sh + o.foot, t = o.torso;
    d.hipY = hipY; d.lieH = o.chestD * 1.1;
    d.bone('hips', null, 0, hipY, 0);
    d.bone('spine', 'hips', 0, 0.04, 0, o.hunch);
    d.bone('head', 'spine', 0, t + o.neck, o.headFwd, -o.hunch * 0.85);
    SIDES.forEach(([S, s]) => {
      d.bone('sh' + S, 'spine', s * o.shW, t * 0.84, 0, 0.05, 0, s * 0.14);
      d.bone('el' + S, 'sh' + S, 0, -o.ua, 0, -0.3);
      d.bone('hip' + S, 'hips', s * o.hipW, -0.03, 0, 0, 0, s * 0.03);
      d.bone('kn' + S, 'hip' + S, 0, -o.th, 0);
    });
    d.bone('wpR', 'elR', 0, -o.fa - o.ar * 0.9, 0.02);
    if (!o.skel) {
      d.p('hips', 'sph', c.leg, 0, 0, 0, o.waistW * 1.15, 0.12, o.chestD * 0.9);
      d.p('spine', 'sph', c.belly || c.top, 0, t * 0.28, 0.005, o.waistW, t * 0.3, o.chestD * 0.85);
      d.p('spine', 'sph', c.top, 0, t * 0.64, 0, o.chestW, t * 0.36, o.chestD);
      d.m('spine', 'sph', c.chest || c.top, o.chestW * 0.46, t * 0.68, o.chestD * 0.5, o.chestW * 0.55, t * 0.2, o.chestD * 0.55, 0, 0, 0.25);
      d.m('spine', 'sph', c.top, o.chestW * 0.8, t * 0.56, -o.chestD * 0.15, o.chestW * 0.34, t * 0.3, o.chestD * 0.7);   // lats
      d.p('spine', 'sph', c.trap || c.top, 0, t * 0.9, -o.chestD * 0.2, o.shW * 0.82, t * 0.15, o.chestD * 0.7);           // traps
      d.p('spine', 'cyl', c.skin, 0, t + o.neck * 0.3, o.headFwd * 0.5, o.headR * 0.58, o.neck + 0.1, o.headR * 0.58, -o.hunch * 0.5);
      SIDES.forEach(([S]) => {
        const sh = 'sh' + S, el = 'el' + S, hp = 'hip' + S, kn = 'kn' + S;
        d.p(sh, 'sph', c.delt || c.arm, 0, -0.01, 0, o.ar * 2.0, o.ar * 2.0, o.ar * 1.9);
        d.p(sh, 'tapd', c.arm, 0, -o.ua * 0.5, 0, o.ar * 1.3, o.ua, o.ar * 1.3);
        d.p(sh, 'sph', c.arm, 0, -o.ua * 0.48, o.ar * 0.4, o.ar * 1.25, o.ua * 0.34, o.ar * 1.2);
        d.p(el, 'tapd', c.fore || c.arm, 0, -o.fa * 0.5, 0, o.ar * 1.22, o.fa, o.ar * 1.22);
        d.p(el, 'sph', c.fore || c.arm, 0, -o.fa * 0.26, 0, o.ar * 1.38, o.fa * 0.3, o.ar * 1.3);
        d.p(el, 'sph', c.hand || c.skin, 0, -o.fa - o.ar * 0.8, 0.01, o.ar * 1.1, o.ar * 1.4, o.ar * 1.3);
        d.p(hp, 'tapd', c.leg, 0, -o.th * 0.5, 0, o.lr * 1.3, o.th, o.lr * 1.3);
        d.p(hp, 'sph', c.leg, 0, -o.th * 0.42, o.lr * 0.35, o.lr * 1.25, o.th * 0.36, o.lr * 1.1);
        d.p(kn, 'tapd', c.boot || c.leg, 0, -o.sh * 0.5, 0, o.lr * 1.05, o.sh, o.lr * 1.05);
        d.p(kn, 'sph', c.boot || c.leg, 0, -o.sh * 0.3, -o.lr * 0.35, o.lr * 1.1, o.sh * 0.3, o.lr * 1.1);
        d.p(kn, 'box', c.boot || c.leg, 0, -o.sh - o.foot * 0.45, o.lr * 0.8, o.lr * 1.6, o.foot * 1.3, o.lr * 3.2);
      });
    } else {
      const b = c.bone, j = c.joint || c.bone;
      d.p('hips', 'sph', b, 0, 0, 0, o.waistW * 1.4, 0.07, o.chestD * 0.7);
      d.p('spine', 'cyl', j, 0, t * 0.35, -o.chestD * 0.45, 0.028, t * 0.7, 0.028);
      for (let i = 0; i < 5; i++) d.p('spine', 'tor', b, 0, t * (0.4 + i * 0.11), -0.01, o.chestW * (0.86 + (i < 3 ? i * 0.06 : 0.12 - (i - 3) * 0.08)), o.chestD * 0.95, 0.3, PI / 2 - 0.15);
      d.p('spine', 'cyl', j, 0, t + o.neck * 0.3, 0, 0.03, o.neck + 0.1, 0.03);
      d.p('spine', 'box', b, 0, t * 0.86, 0, o.shW * 1.9, 0.03, 0.04);                 // collar bones
      SIDES.forEach(([S]) => {
        const sh = 'sh' + S, el = 'el' + S, hp = 'hip' + S, kn = 'kn' + S;
        d.p(sh, 'sph', j, 0, 0, 0, o.ar * 1.5, o.ar * 1.5, o.ar * 1.5);
        d.p(sh, 'cyl', b, 0, -o.ua * 0.5, 0, o.ar * 0.75, o.ua, o.ar * 0.75);
        d.p(el, 'sph', j, 0, 0, 0, o.ar * 1.2, o.ar * 1.2, o.ar * 1.2);
        d.m(el, 'cyl', b, o.ar * 0.35, -o.fa * 0.5, 0, o.ar * 0.45, o.fa, o.ar * 0.45);
        d.p(el, 'box', b, 0, -o.fa - o.ar * 0.6, 0.01, o.ar * 1.6, o.ar * 2.2, o.ar * 0.8);
        d.p(hp, 'sph', j, 0, 0, 0, o.lr * 1.4, o.lr * 1.4, o.lr * 1.4);
        d.p(hp, 'cyl', b, 0, -o.th * 0.5, 0, o.lr * 0.7, o.th, o.lr * 0.7);
        d.p(kn, 'sph', j, 0, 0, 0.01, o.lr * 1.1, o.lr * 1.1, o.lr * 1.1);
        d.m(kn, 'cyl', b, o.lr * 0.3, -o.sh * 0.5, 0, o.lr * 0.42, o.sh, o.lr * 0.42);
        d.p(kn, 'box', b, 0, -o.sh - o.foot * 0.45, o.lr * 0.9, o.lr * 1.6, o.foot * 0.9, o.lr * 3.2);
      });
    }
    d.hit('head', 'head', 0, o.headR * 1.0, o.headR * 0.2, o.headR * 1.45);
    d.hit('torso', 'spine', 0, t * 0.66, 0, o.chestW * 1.25);
    d.hit('torso', 'spine', 0, t * 0.3, 0, Math.max(o.chestW, o.waistW * 1.3));
    d.hit('torso', 'hips', 0, -0.02, 0, o.waistW * 1.4);
    SIDES.forEach(([S]) => {
      d.hit('arm' + S, 'sh' + S, 0, -o.ua * 0.5, 0, o.ar * 3.2 + 0.03);
      d.hit('arm' + S, 'el' + S, 0, -o.fa * 0.55, 0, o.ar * 3.2 + 0.03);
      d.hit('leg' + S, 'hip' + S, 0, -o.th * 0.5, 0, o.lr * 2.4);
      d.hit('leg' + S, 'kn' + S, 0, -o.sh * 0.5, 0, o.lr * 2.1);
      d.sv('arm' + S, 'sh' + S, o.ar * (o.skel ? 1.2 : 1.6));
      d.sv('leg' + S, 'hip' + S, o.lr * (o.skel ? 1.0 : 1.35));
    });
    d.sv('head', 'head', o.headR * 0.62);
    return o;
  }

  // A proper skull: brow, deep sockets with ember eyes, cheekbones, nasal hole, teeth, a hinged jaw.
  function skull(d, r, bone, eye, y0, z0 = 0) {
    const dk = 0x0a0605, tooth = 0xf2ecd8;
    d.p('head', 'sph', bone, 0, y0 + r, z0 + -r * 0.08, r * 0.95, r * 0.98, r * 1.1);
    d.p('head', 'box', bone, 0, y0 + r * 0.92, z0 + r * 0.76, r * 1.62, r * 0.24, r * 0.36, 0.15);
    d.m('head', 'sph', dk, r * 0.37, y0 + r * 0.66, z0 + r * 0.78, r * 0.31, r * 0.29, r * 0.24);
    d.mg('head', 'box', eye, r * 0.37, y0 + r * 0.66, z0 + r * 0.98, r * 0.22, r * 0.14, r * 0.05, 0, 0, -0.25);
    d.m('head', 'box', bone, r * 0.66, y0 + r * 0.42, z0 + r * 0.52, r * 0.28, r * 0.22, r * 0.46);
    d.p('head', 'box', bone, 0, y0 + r * 0.3, z0 + r * 0.6, r * 0.86, r * 0.36, r * 0.46);
    d.p('head', 'box', dk, 0, y0 + r * 0.46, z0 + r * 0.84, r * 0.2, r * 0.26, r * 0.05);
    for (let i = 0; i < 6; i++) d.p('head', 'box', tooth, (i - 2.5) * r * 0.14, y0 + r * 0.08, z0 + r * 0.8, r * 0.1, r * 0.17, r * 0.07);
    d.bone('jaw', 'head', 0, y0 + r * 0.1, z0 + r * 0.05, 0.05);
    d.p('jaw', 'box', bone, 0, -r * 0.14, r * 0.42, r * 0.8, r * 0.2, r * 0.6);
    d.m('jaw', 'box', bone, r * 0.4, 0, r * 0.12, r * 0.1, r * 0.34, r * 0.2);
    for (let i = 0; i < 6; i++) d.p('jaw', 'box', tooth, (i - 2.5) * r * 0.13, -r * 0.02, r * 0.66, r * 0.09, r * 0.15, r * 0.07);
  }

  // ── Weapons (on wpR, pointing +Z) and shields (on elL, facing +X) ───────────
  const STEEL = 0xa8aeb8, IRON = 0x505258, WOOD = 0x6a4424, LEATHER = 0x3a2416;
  function sword(d, len, w, col, guard) {
    d.p('wpR', 'cyl', LEATHER, 0, 0, -0.02, 0.022, 0.2, 0.022, PI / 2);
    d.p('wpR', 'sph', guard || IRON, 0, 0, -0.13, 0.035, 0.035, 0.035);
    d.p('wpR', 'box', guard || IRON, 0, 0, 0.09, w * 2.6, 0.035, 0.04);
    d.p('wpR', 'box', col || STEEL, 0, 0, 0.1 + len * 0.5, w, 0.02, len);
    d.p('wpR', 'cone', col || STEEL, 0, 0, 0.1 + len + 0.05, w * 0.5, 0.1, 0.012, PI / 2);
    d.tip = ['wpR', 0, 0, 0.1 + len];
  }
  function axe(d, len, head) {
    d.p('wpR', 'cyl', WOOD, 0, 0, len * 0.4, 0.024, len, 0.024, PI / 2);
    d.p('wpR', 'box', IRON, 0, -0.06 * head, len * 0.82, 0.03, 0.24 * head, 0.12 * head);
    d.p('wpR', 'box', STEEL, 0, -0.17 * head, len * 0.82, 0.032, 0.05, 0.2 * head);
    d.p('wpR', 'cone', IRON, 0, 0.05, len * 0.82, 0.03, 0.1, 0.03);
    d.tip = ['wpR', 0, -0.15 * head, len * 0.82];
  }
  function roundShield(d, fa, r, face, paint) {
    d.p('elL', 'cyl', IRON, 0.055, -fa * 0.55, 0.02, r * 1.06, 0.03, r * 1.06, 0, 0, PI / 2);
    d.p('elL', 'cyl', face, 0.07, -fa * 0.55, 0.02, r, 0.035, r, 0, 0, PI / 2);
    d.p('elL', 'box', paint, 0.09, -fa * 0.55, 0.02, 0.01, r * 1.8, 0.07);
    d.p('elL', 'box', paint, 0.09, -fa * 0.55, 0.02, 0.01, 0.07, r * 1.8);
    d.p('elL', 'sph', IRON, 0.1, -fa * 0.55, 0.02, 0.06, 0.06, 0.06);
  }

  // ── The bestiary ───────────────────────────────────────────────────────────
  const DESIGN = {
    wolf(d, v) {
      d.rig = 'quad'; d.lieH = 0.2; d.hipY = 0.7;
      const fur = v.alpha ? 0x34323a : 0x4c4852, dark = v.alpha ? 0x141216 : 0x26232a, belly = v.alpha ? 0x5a5660 : 0x847c88, red = 0x5a0a0a, fang = 0xefe6cc;
      d.bone('body', null, 0, 0.7, 0);
      d.p('body', 'sph', fur, 0, 0.0, -0.3, 0.19, 0.21, 0.3);
      d.p('body', 'sph', fur, 0, 0.02, -0.02, 0.21, 0.24, 0.3);
      d.p('body', 'sph', dark, 0, 0.06, 0.24, 0.26, 0.31, 0.32);          // massive chest
      d.p('body', 'sph', belly, 0, -0.12, 0.02, 0.16, 0.12, 0.36);
      d.p('body', 'sph', dark, 0, 0.14, 0.44, 0.2, 0.25, 0.2, -0.4);        // neck ruff
      for (let i = 0; i < 9; i++) {                                        // hackles
        const z = 0.5 - i * 0.11, s = 1 - i * 0.07;
        d.p('body', 'cone', dark, (i % 2 ? 0.05 : -0.05), 0.27 - i * 0.012, z, 0.07 * s, 0.24 * s, 0.07 * s, -0.9, 0, (i % 2 ? -0.3 : 0.3));
      }
      d.m('body', 'cone', dark, 0.2, -0.02, 0.3, 0.06, 0.2, 0.06, -1.3, 0, 0.6);   // chest shag
      d.bone('head', 'body', 0, 0.2, 0.52, 0.18);
      d.p('head', 'sph', fur, 0, 0.02, 0.0, 0.135, 0.12, 0.15);
      d.p('head', 'box', fur, 0, -0.02, 0.19, 0.1, 0.085, 0.22);
      d.p('head', 'box', dark, 0, 0.05, 0.08, 0.16, 0.04, 0.1, 0.2);       // heavy brow
      d.p('head', 'sph', 0x0a0808, 0, 0.015, 0.3, 0.04, 0.035, 0.035);
      d.p('head', 'box', red, 0, -0.065, 0.17, 0.08, 0.02, 0.17);
      d.m('head', 'cone', dark, 0.08, 0.14, -0.03, 0.045, 0.13, 0.04, -0.35, 0, -0.3);
      d.m('head', 'cone', fang, 0.034, -0.085, 0.27, 0.013, 0.055, 0.013, PI);
      d.m('head', 'cone', fang, 0.04, -0.08, 0.2, 0.01, 0.035, 0.01, PI);
      d.m('head', 'sph', dark, 0.11, -0.02, -0.02, 0.07, 0.09, 0.09);      // cheek ruff
      if (v.alpha) {
        d.g('head', 'box', 0xff1808, 0.062, 0.042, 0.135, 0.04, 0.024, 0.02, 0, 0, -0.35);
        d.p('head', 'box', 0x1a0a0a, -0.062, 0.042, 0.13, 0.04, 0.012, 0.02, 0, 0, 0.35);
        d.p('head', 'box', 0xc09080, -0.05, 0.05, 0.12, 0.018, 0.16, 0.02, 0, 0, 0.5);   // the scar
        d.p('body', 'box', 0xa07868, 0.2, 0.05, 0.12, 0.02, 0.03, 0.3, 0.3, 0.15, 0);
        d.p('body', 'box', 0xa07868, 0.19, 0.12, 0.0, 0.02, 0.03, 0.26, 0.4, 0.15, 0);
      } else d.mg('head', 'box', 0xffb018, 0.062, 0.042, 0.135, 0.036, 0.02, 0.02, 0, 0, -0.35);
      d.bone('jaw', 'head', 0, -0.075, 0.07, 0.08);
      d.p('jaw', 'box', fur, 0, -0.02, 0.1, 0.085, 0.04, 0.2);
      d.p('jaw', 'box', red, 0, 0.005, 0.1, 0.06, 0.012, 0.16);
      d.m('jaw', 'cone', fang, 0.03, 0.02, 0.18, 0.012, 0.045, 0.012);
      [['flL', 0.12, 0.3, 1], ['flR', -0.12, 0.3, 1], ['blL', 0.13, -0.36, 0], ['blR', -0.13, -0.36, 0]].forEach(([n, x, z, front]) => {
        d.bone(n, 'body', x, front ? -0.08 : -0.02, z, front ? 0 : 0.4);
        d.bone(n + '2', n, 0, front ? -0.27 : -0.3, 0, front ? 0 : -0.8);
        if (front) d.p(n, 'sph', dark, 0, -0.03, 0, 0.09, 0.15, 0.12);
        else d.p(n, 'sph', fur, 0, -0.08, 0.02, 0.1, 0.19, 0.15);
        d.p(n, 'tapd', fur, 0, front ? -0.14 : -0.16, 0, 0.068, front ? 0.28 : 0.3, 0.068);
        d.p(n + '2', 'tapd', dark, 0, front ? -0.16 : -0.19, 0, 0.045, front ? 0.32 : 0.38, 0.045);
        d.p(n + '2', 'box', dark, 0, front ? -0.33 : -0.39, 0.03, 0.065, 0.045, 0.1);
        d.m(n + '2', 'cone', fang, 0.025, front ? -0.34 : -0.4, 0.09, 0.008, 0.03, 0.008, PI / 2);
        d.hit(front ? (x > 0 ? 'armL' : 'armR') : (x > 0 ? 'legL' : 'legR'), n, 0, -0.2, 0, 0.14);
      });
      d.bone('tail', 'body', 0, 0.08, -0.56, 0.5);
      d.p('tail', 'sph', fur, 0, 0, -0.1, 0.07, 0.07, 0.13);
      d.p('tail', 'sph', dark, 0, -0.03, -0.26, 0.08, 0.08, 0.14);
      d.p('tail', 'cone', dark, 0, -0.05, -0.42, 0.06, 0.16, 0.06, -PI / 2);
      d.hit('head', 'head', 0, 0, 0.1, 0.19);
      d.hit('torso', 'body', 0, 0.04, 0.2, 0.3);
      d.hit('torso', 'body', 0, 0, -0.22, 0.26);
      d.sv('head', 'head', 0.11); d.sv('armL', 'flL', 0.07); d.sv('armR', 'flR', 0.07); d.sv('legL', 'blL', 0.08); d.sv('legR', 'blR', 0.08);
      d.tip = ['head', 0, -0.05, 0.3];
    },

    ghoul(d) {
      const skin = 0x6c7866, dark = 0x363c32, claw = 0x16120e, bone = 0xcfc8a8;
      const o = humanoid(d, { th: 0.44, sh: 0.46, torso: 0.58, chestW: 0.14, chestD: 0.11, waistW: 0.085, shW: 0.19, ua: 0.37, fa: 0.37,
        ar: 0.033, lr: 0.042, hipW: 0.08, headR: 0.11, hunch: 0.78, headFwd: 0.12, col: { skin, top: skin, arm: skin, leg: skin, belly: dark, trap: skin } });
      for (let i = 0; i < 4; i++) d.p('spine', 'box', 0xa8b09c, 0, o.torso * (0.5 + i * 0.09), o.chestD * 0.82, o.chestW * (1.7 - i * 0.1), 0.018, 0.03);  // ribs
      for (let i = 0; i < 6; i++) d.p('spine', 'sph', 0x9aa290, 0, o.torso * (0.15 + i * 0.15), -o.chestD * 0.95, 0.03, 0.03, 0.035);    // vertebrae
      d.p('hips', 'box', 0x2a2218, 0, -0.08, 0.06, 0.16, 0.22, 0.02, 0.1);                                                            // rag
      d.p('hips', 'box', 0x2a2218, 0.05, -0.1, -0.08, 0.12, 0.2, 0.02, -0.1);
      SIDES.forEach(([S]) => { for (let i = 0; i < 4; i++) d.p('el' + S, 'cone', claw, (i - 1.5) * 0.024, -o.fa - 0.14, 0.04, 0.014, 0.24, 0.014, PI + 0.35); });
      d.p('head', 'sph', skin, 0, 0.12, 0.01, 0.1, 0.12, 0.115);
      d.p('head', 'sph', dark, 0, 0.19, -0.03, 0.09, 0.07, 0.09);
      d.p('head', 'box', skin, 0, 0.14, 0.08, 0.15, 0.03, 0.06, 0.3);
      d.m('head', 'sph', 0x050505, 0.045, 0.1, 0.085, 0.032, 0.028, 0.03);
      d.mg('head', 'box', 0xd0ff80, 0.045, 0.1, 0.108, 0.026, 0.02, 0.01);
      d.p('head', 'box', 0x3a0808, 0, 0.03, 0.07, 0.08, 0.07, 0.05);                  // gaping maw
      for (let i = 0; i < 5; i++) d.p('head', 'cone', bone, (i - 2) * 0.017, 0.045, 0.1, 0.008, 0.04, 0.008, PI);
      d.bone('jaw', 'head', 0, 0.03, 0.02, 0.3);
      d.p('jaw', 'box', skin, 0, -0.03, 0.05, 0.1, 0.03, 0.1, -0.1);
      d.p('jaw', 'box', 0x3a0808, 0, -0.012, 0.05, 0.075, 0.012, 0.08);
      for (let i = 0; i < 5; i++) d.p('jaw', 'cone', bone, (i - 2) * 0.017, -0.005, 0.09, 0.008, 0.035, 0.008);
      d.m('head', 'cone', skin, 0.1, 0.13, -0.01, 0.025, 0.08, 0.02, 0, 0, -1.2);
      d.tip = ['elR', 0, -o.fa - 0.18, 0.03];
    },

    bandit(d, v) {
      const skin = v.chief ? 0x9a6a48 : 0xb07c56, leather = 0x5e3a22, fur = v.chief ? 0x3a2a1c : 0x6e5a44, cloth = 0x3e2a22, boot = 0x241812;
      const o = humanoid(d, { th: 0.45, sh: 0.44, torso: 0.6, chestW: v.chief ? 0.24 : 0.21, chestD: v.chief ? 0.17 : 0.15, waistW: 0.16, shW: v.chief ? 0.28 : 0.25,
        ua: 0.3, fa: 0.28, ar: v.chief ? 0.058 : 0.052, lr: 0.072, hipW: 0.1, headR: 0.115, hunch: 0.1,
        col: { skin, top: leather, chest: 0x6a4428, belly: 0x4a2e1a, arm: skin, fore: LEATHER, delt: fur, trap: fur, leg: cloth, boot, hand: v.chief ? 0x121212 : skin } });
      d.p('hips', 'cyl', 0x1a1008, 0, 0.1, 0, o.waistW * 1.12, 0.06, o.chestD * 0.95);
      d.p('hips', 'box', 0x9a8a50, 0, 0.1, o.chestD * 0.92, 0.05, 0.05, 0.02);
      d.p('hips', 'box', leather, 0, -0.1, o.chestD * 0.7, 0.14, 0.22, 0.03, 0.12);
      for (let i = 0; i < 7; i++) { const a = (i / 6 - 0.5) * 2.6; d.p('spine', 'sph', fur, Math.sin(a) * o.shW * 0.9, o.torso * 0.9, Math.cos(a) * 0.06 - 0.05, 0.1, 0.08, 0.09); }  // fur mantle
      if (v.chief) {
        d.p('spine', 'box', 0x2a1c12, 0, o.torso * 0.45, -o.chestD - 0.02, o.shW * 2.1, o.torso * 1.1, 0.03, 0.08);    // bearskin
        for (let i = 0; i < 3; i++) d.p('hips', 'sph', 0xe0d6b8, -0.12 + i * 0.12, 0.08, o.chestD * 0.95, 0.045, 0.05, 0.04);   // trophy skulls
        d.m('spine', 'box', 0x8a1a10, o.chestW * 0.45, o.torso * 0.7, o.chestD * 1.02, 0.03, 0.14, 0.01, 0, 0, 0.3);           // war paint
      }
      d.p('head', 'sph', skin, 0, 0.12, 0.015, 0.1, 0.12, 0.11);
      d.p('head', 'box', skin, 0, 0.1, 0.11, 0.03, 0.05, 0.04);
      d.m('head', 'box', 0x140a06, 0.04, 0.14, 0.095, 0.028, 0.014, 0.01);
      d.p('head', 'box', 0x2a1a10, 0, 0.16, 0.1, 0.14, 0.022, 0.03, 0.2);            // brow
      d.p('head', 'sph', 0x2a1a0e, 0, 0.03, 0.08, 0.085, 0.08, 0.06);                // beard
      d.p('head', 'cone', 0x2a1a0e, 0, -0.04, 0.1, 0.05, 0.12, 0.04, PI);
      if (v.helm) {
        const hs = v.chief ? 1.5 : 1;
        d.p('head', 'sph', IRON, 0, 0.17, -0.005, 0.12, 0.08, 0.125);
        d.p('head', 'box', IRON, 0, 0.12, 0.12, 0.022, 0.08, 0.02);
        d.p('head', 'cyl', 0x3a3a40, 0, 0.13, 0, 0.122, 0.03, 0.127);
        d.m('head', 'cone', 0xd8c8a0, 0.13, 0.19, 0, 0.035 * hs, 0.16 * hs, 0.035 * hs, 0, 0, -1.1);
        d.m('head', 'cone', 0xd8c8a0, 0.13 + 0.1 * hs, 0.26 + 0.06 * hs, 0, 0.022 * hs, 0.12 * hs, 0.022 * hs, 0, 0, -0.2);
      } else {
        d.p('head', 'sph', 0x5a1612, 0, 0.14, -0.03, 0.13, 0.14, 0.13);
        d.p('head', 'cone', 0x5a1612, 0, 0.16, -0.14, 0.07, 0.18, 0.05, -1.9);
        d.p('spine', 'sph', 0x5a1612, 0, o.torso * 0.95, -0.02, 0.17, 0.08, 0.14);
      }
      if (v.axe) axe(d, v.chief ? 0.8 : 0.62, v.chief ? 1.5 : 1.1); else sword(d, 0.78, 0.075);
      roundShield(d, o.fa, v.chief ? 0.34 : 0.3, WOOD, v.chief ? 0x121212 : 0x7a1a12);
    },

    orc(d) {
      const skin = 0x5d6e44, dark = 0x3e4a2e, tusk = 0xeadcb8, loin = 0x4a3020, paint = 0x9a1a10;
      const o = humanoid(d, { th: 0.4, sh: 0.38, torso: 0.66, chestW: 0.3, chestD: 0.22, waistW: 0.21, shW: 0.34, ua: 0.33, fa: 0.31,
        ar: 0.078, lr: 0.095, hipW: 0.13, headR: 0.12, hunch: 0.35, headFwd: 0.12, neck: 0.02,
        col: { skin, top: skin, arm: skin, fore: skin, leg: dark, boot: 0x2a2018, belly: 0x55643c, trap: dark } });
      d.p('hips', 'cyl', 0x2a1a10, 0, 0.1, 0, o.waistW * 1.15, 0.08, o.chestD);
      d.p('hips', 'box', loin, 0, -0.12, o.chestD * 0.75, 0.2, 0.3, 0.03, 0.12);
      d.p('hips', 'box', loin, 0, -0.12, -o.chestD * 0.75, 0.22, 0.28, 0.03, -0.12);
      d.p('hips', 'sph', 0xe0d4b0, 0.14, 0.1, o.chestD * 0.9, 0.05, 0.055, 0.045);
      d.p('shL', 'sph', IRON, 0, 0.03, 0, 0.19, 0.14, 0.18);
      for (let i = 0; i < 3; i++) d.p('shL', 'cone', 0xb0b0b0, 0.06, 0.13, -0.08 + i * 0.08, 0.03, 0.14, 0.03, 0, 0, -0.5);
      d.p('spine', 'box', 0x2a1a10, 0, o.torso * 0.62, 0, 0.05, o.torso * 0.9, o.chestD * 2.12, 0, 0, 0.75);     // strap
      d.m('spine', 'box', paint, o.chestW * 0.5, o.torso * 0.72, o.chestD * 1.02, 0.035, 0.18, 0.01, 0, 0, 0.5);
      SIDES.forEach(([S]) => d.p('el' + S, 'cyl', 0x2a1a10, 0, -o.fa * 0.6, 0, o.ar * 1.35, o.fa * 0.4, o.ar * 1.35));
      d.p('head', 'sph', skin, 0, 0.1, 0.0, 0.12, 0.12, 0.12);
      d.p('head', 'box', dark, 0, 0.15, 0.09, 0.2, 0.045, 0.07, 0.2);                 // brow shelf
      d.p('head', 'box', skin, 0, 0.02, 0.1, 0.19, 0.09, 0.12);                        // underbite jaw
      d.p('head', 'box', 0x2a0606, 0, 0.055, 0.155, 0.13, 0.02, 0.02);
      d.m('head', 'cone', tusk, 0.07, 0.1, 0.16, 0.022, 0.1, 0.022, 0.2, 0, -0.25);
      d.m('head', 'cone', skin, 0.13, 0.12, -0.02, 0.03, 0.12, 0.022, 0, 0.3, -1.4);
      d.p('head', 'box', skin, 0, 0.11, 0.13, 0.05, 0.04, 0.05);
      d.mg('head', 'box', 0xff4a0c, 0.05, 0.12, 0.12, 0.028, 0.016, 0.01, 0, 0, -0.25);
      d.m('head', 'box', paint, 0.06, 0.08, 0.125, 0.012, 0.06, 0.01);
      d.p('head', 'cone', 0x100c0a, 0, 0.26, -0.03, 0.04, 0.14, 0.04, -0.4);          // topknot
      d.p('wpR', 'cyl', 0x2a1a10, 0, 0, 0.05, 0.028, 0.34, 0.028, PI / 2);
      d.p('wpR', 'box', 0x3a3c40, 0, -0.1, 0.52, 0.035, 0.3, 0.62);                    // cleaver
      d.p('wpR', 'box', 0xa0a4ac, 0, -0.245, 0.52, 0.037, 0.04, 0.62);
      d.p('wpR', 'box', 0x5a0a06, 0, -0.18, 0.62, 0.038, 0.1, 0.2);
      d.tip = ['wpR', 0, -0.2, 0.75];
    },

    troll(d, v) {
      const g = v.guardian, skin = g ? 0x4c5566 : 0x6f6b5e, dark = g ? 0x2c3240 : 0x48453c, moss = g ? 0x3a4a5a : 0x4f6a2a, tusk = 0xd8ccaa, rune = 0xbfe8ff;
      const o = humanoid(d, { th: 0.32, sh: 0.3, foot: 0.06, torso: 0.72, chestW: 0.32, chestD: 0.26, waistW: 0.26, shW: 0.34, ua: 0.36, fa: 0.36,
        ar: 0.085, lr: 0.105, hipW: 0.14, headR: 0.1, hunch: 0.5, headFwd: 0.14, neck: 0.0,
        col: { skin, top: skin, arm: skin, fore: dark, leg: dark, belly: 0x7a7462, trap: moss, delt: skin } });
      const R = CT.rng(g ? 7 : 3);
      for (let i = 0; i < 5; i++) { const a = R() * 2.6 - 1.3, y = o.torso * (0.4 + R() * 0.5); d.p('spine', 'ico', dark, Math.sin(a) * o.chestW, y, -Math.cos(a) * o.chestD * 0.9, 0.09 + R() * 0.07, 0.07 + R() * 0.05, 0.08 + R() * 0.06, R() * 3, R() * 3, 0); }
      for (let i = 0; i < 6; i++) { const a = R() * 3 - 1.5; d.p('spine', 'sph', moss, Math.sin(a) * o.shW * 0.8, o.torso * (0.8 + R() * 0.2), -0.05 - R() * 0.1, 0.11, 0.05, 0.1); }
      SIDES.forEach(([S]) => { d.p('sh' + S, 'ico', dark, 0, 0.05, -0.02, 0.17, 0.13, 0.16, 0.3, 0.5, 0); d.p('sh' + S, 'sph', moss, 0, 0.14, -0.02, 0.13, 0.05, 0.12); });
      d.p('hips', 'box', 0x3a2a1a, 0, -0.1, o.chestD * 0.8, 0.26, 0.26, 0.04, 0.15);
      d.p('head', 'sph', skin, 0, 0.08, 0.0, 0.11, 0.1, 0.12);
      d.p('head', 'box', dark, 0, 0.12, 0.08, 0.2, 0.05, 0.08, 0.3);
      d.p('head', 'box', skin, 0, -0.01, 0.07, 0.2, 0.1, 0.15);
      d.m('head', 'cone', tusk, 0.08, 0.05, 0.14, 0.03, 0.14, 0.03, 0.2, 0, -0.3);
      d.p('head', 'box', 0x200808, 0, 0.035, 0.145, 0.13, 0.025, 0.01);
      d.mg('head', 'box', g ? rune : 0xff8a1a, 0.045, 0.1, 0.12, 0.025, 0.014, 0.01);
      d.p('head', 'ico', moss, 0, 0.17, -0.02, 0.1, 0.05, 0.1);
      if (g) {
        d.g('spine', 'sph', rune, 0, o.torso * 0.66, o.chestD * 0.98, 0.07, 0.07, 0.02);       // moon disc
        d.g('spine', 'box', rune, 0, o.torso * 0.66, o.chestD * 1.0, 0.18, 0.012, 0.01);
        [[0.18, 0.5, 0.4], [-0.18, 0.5, -0.4], [0.12, 0.3, 0.9], [-0.1, 0.85, -0.8]].forEach(([x, y, r]) => d.g('spine', 'box', rune, x, o.torso * y, o.chestD * 0.92, 0.014, 0.1, 0.01, 0, 0, r));
        SIDES.forEach(([S]) => { d.g('sh' + S, 'box', rune, 0, -o.ua * 0.5, o.ar * 1.3, 0.014, 0.12, 0.01); d.g('el' + S, 'box', rune, 0, -o.fa * 0.4, o.ar * 1.25, 0.012, 0.1, 0.01, 0, 0, 0.6); });
        d.g('head', 'box', rune, 0, 0.16, 0.125, 0.012, 0.05, 0.01);
        d.p('wpR', 'box', 0x5a6070, 0, 0, 0.55, 0.16, 0.16, 1.3);                           // rune pillar
        d.p('wpR', 'box', 0x3a404c, 0, 0, 1.2, 0.2, 0.2, 0.12);
        for (let i = 0; i < 4; i++) d.g('wpR', 'box', rune, 0.082, 0, 0.3 + i * 0.26, 0.004, 0.08, 0.1, 0, 0, i * 0.7);
      } else {
        d.p('wpR', 'cyl', 0x4a3420, 0, 0, 0.55, 0.075, 1.25, 0.075, PI / 2);                 // tree-trunk club
        d.p('wpR', 'tapd', 0x5a4028, 0, 0, 0.95, 0.15, 0.6, 0.15, -PI / 2);
        d.p('wpR', 'ico', 0x4a3420, 0, 0, 1.2, 0.17, 0.17, 0.2);
        d.p('wpR', 'cone', 0x3a2a18, 0.12, 0.04, 0.95, 0.03, 0.18, 0.03, 0, 0, -1.2);
        d.p('wpR', 'cone', 0x3a2a18, -0.1, 0.08, 1.1, 0.03, 0.16, 0.03, 0.4, 0, 1.0);
        d.p('wpR', 'sph', moss, 0, 0.1, 1.05, 0.12, 0.05, 0.14);
      }
      d.tip = ['wpR', 0, 0, 1.25];
    },

    wraith(d) {
      d.rig = 'wraith'; d.lieH = 0.2;
      const shroud = 0x10131c, dark = 0x050609, rag = 0x222a3a, rag2 = 0x161b28, bone = 0xd8d4c4, glow = 0x8fd4ff;
      const R = CT.rng(11);
      d.bone('body', null, 0, 1.05, 0, 0.22);
      d.p('body', 'tapu', shroud, 0, -0.05, 0, 0.3, 1.0, 0.26);
      d.p('body', 'sph', shroud, 0, 0.36, -0.02, 0.27, 0.16, 0.2);
      d.m('body', 'cone', rag2, 0.22, 0.46, -0.04, 0.07, 0.24, 0.06, 0, 0, -0.4);            // bony shoulder points under the cloth
      for (let i = 0; i < 14; i++) {                                                           // layered rags from the shoulders
        const a = (i / 14) * TAU, l = 0.6 + R() * 0.5, rr = 0.22 + R() * 0.06;
        d.p('body', 'box', i % 3 ? rag : rag2, Math.sin(a) * rr, 0.35 - l * 0.5, Math.cos(a) * rr * 0.85, 0.12 + R() * 0.06, l, 0.02, (R() - 0.5) * 0.3, a, (R() - 0.5) * 0.3);
      }
      d.g('body', 'sph', 0x2a5a88, 0, 0.26, 0.1, 0.12, 0.12, 0.08);
      d.bone('hem', 'body', 0, -0.55, 0);
      for (let i = 0; i < 13; i++) { const a = i / 13 * TAU, l = 0.35 + R() * 0.45; d.p('hem', 'box', i % 2 ? rag : shroud, Math.sin(a) * 0.3, -l * 0.5, Math.cos(a) * 0.26, 0.1 + R() * 0.06, l, 0.02, (R() - 0.5) * 0.4, a, (R() - 0.5) * 0.3); }
      d.bone('head', 'body', 0, 0.48, 0.1, -0.25);
      d.p('head', 'sph', dark, 0, 0.1, -0.13, 0.2, 0.23, 0.2);                                  // deep cowl
      d.p('head', 'box', dark, 0, 0.23, 0.06, 0.28, 0.05, 0.16, 0.45);
      d.m('head', 'box', dark, 0.13, 0.08, 0.02, 0.04, 0.3, 0.2, 0, 0.2, 0);
      d.p('head', 'cone', dark, 0, 0.28, -0.18, 0.1, 0.3, 0.08, -1.3);
      skull(d, 0.085, bone, 0xd8faff, 0.0, 0.04);
      d.g('head', 'sph', 0x3a8ac0, 0, 0.08, -0.05, 0.13, 0.15, 0.1);
      SIDES.forEach(([S, s]) => {
        d.bone('sh' + S, 'body', s * 0.24, 0.36, 0, 0.1, 0, s * 0.35);
        d.bone('el' + S, 'sh' + S, 0, -0.42, 0, -0.4);
        d.p('sh' + S, 'tapu', shroud, 0, -0.21, 0, 0.07, 0.44, 0.07);
        d.p('sh' + S, 'box', rag, 0, -0.3, -0.06, 0.12, 0.34, 0.02, 0.2);
        d.p('el' + S, 'tapu', rag, 0, -0.16, 0, 0.08, 0.34, 0.08);
        d.p('el' + S, 'box', rag2, 0, -0.32, -0.05, 0.13, 0.22, 0.02, 0.35);
        d.p('el' + S, 'cyl', bone, 0, -0.36, 0.01, 0.018, 0.1, 0.018);
        for (let i = 0; i < 4; i++) d.p('el' + S, 'cone', bone, (i - 1.5) * 0.028, -0.52, 0.03, 0.013, 0.32, 0.013, PI + 0.35);
        d.g('el' + S, 'sph', 0x2a6a9a, 0, -0.36, 0, 0.055, 0.055, 0.055);
        d.hit('arm' + S, 'el' + S, 0, -0.2, 0, 0.12);
      });
      d.hit('head', 'head', 0, 0.08, 0.04, 0.18);
      d.hit('torso', 'body', 0, 0.2, 0, 0.3);
      d.hit('torso', 'body', 0, -0.3, 0, 0.32);
      d.tip = ['elR', 0, -0.6, 0.02];
    },

    boneKnight(d) {
      const bone = 0xd9cfb2, joint = 0x9a8e70, black = 0x19191e, edge = 0x40404a, red = 0xff2a10, tabard = 0x3a0808;
      const o = humanoid(d, { th: 0.44, sh: 0.44, torso: 0.6, chestW: 0.22, chestD: 0.14, waistW: 0.1, shW: 0.27, ua: 0.3, fa: 0.3, ar: 0.044, lr: 0.05,
        hipW: 0.1, headR: 0.11, hunch: 0.08, skel: true, col: { bone, joint } });
      d.p('spine', 'box', black, 0, o.torso * 0.7, 0.01, o.chestW * 2.1, o.torso * 0.44, o.chestD * 2.0);   // breastplate
      d.p('spine', 'box', black, 0, o.torso * 0.78, o.chestD * 0.7, o.chestW * 1.7, o.torso * 0.3, o.chestD * 0.8, -0.15);
      SIDES.forEach(([S]) => { d.p('sh' + S, 'tapd', black, 0, -o.ua * 0.45, 0, 0.065, o.ua * 0.6, 0.065); d.p('hip' + S, 'tapd', black, 0, -o.th * 0.45, 0.01, 0.075, o.th * 0.7, 0.075); });
      d.bone('cape', 'spine', 0, o.torso * 0.92, -0.12, 0.08);
      const RC = CT.rng(9);
      for (let i = 0; i < 6; i++) { const x = (i - 2.5) * 0.08, l = 0.9 + RC() * 0.35; d.p('cape', 'box', i % 2 ? 0x2a0608 : 0x14121a, x, -l * 0.5, -Math.abs(x) * 0.25, 0.09, l, 0.02, 0, x * 0.6, 0); }
      d.p('spine', 'box', edge, 0, o.torso * 0.7, o.chestD * 1.01, 0.03, o.torso * 0.42, 0.01);
      d.p('spine', 'box', black, 0, o.torso * 0.93, -0.01, o.shW * 1.6, 0.06, o.chestD * 1.6);
      SIDES.forEach(([S]) => {
        d.p('sh' + S, 'sph', black, 0, 0.03, 0, 0.15, 0.12, 0.15);
        d.p('sh' + S, 'cyl', edge, 0, -0.02, 0, 0.152, 0.025, 0.152);
        d.p('sh' + S, 'cone', edge, 0, 0.15, -0.03, 0.04, 0.18, 0.04);
        d.p('sh' + S, 'cone', edge, 0, 0.12, 0.06, 0.03, 0.12, 0.03, 0.4);
        d.p('el' + S, 'tapd', black, 0, -o.fa * 0.72, 0, 0.055, o.fa * 0.5, 0.055);
        d.p('kn' + S, 'tapd', black, 0, -o.sh * 0.45, 0.01, 0.06, o.sh * 0.75, 0.06);
        d.p('kn' + S, 'sph', edge, 0, 0, 0.03, 0.055, 0.055, 0.05);
        d.p('hip' + S, 'box', black, 0, -0.08, 0, 0.11, 0.16, 0.13);
      });
      d.p('hips', 'box', tabard, 0, -0.2, o.chestD * 0.7, 0.16, 0.42, 0.015, 0.06);
      d.p('hips', 'box', black, 0, 0.02, 0, 0.26, 0.1, 0.2);
      const r = 0.108; skull(d, r, bone, red, 0.0);
      d.p('head', 'sph', black, 0, r * 1.3, -r * 0.3, r * 1.12, r * 0.82, r * 1.15);   // open-faced helm (crown and nape)
      d.p('head', 'cyl', edge, 0, r * 1.12, -r * 0.3, r * 1.14, r * 0.12, r * 1.17);
      d.m('head', 'box', black, r * 1.0, r * 0.62, -r * 0.05, r * 0.16, r * 0.9, r * 0.9);
      d.p('head', 'box', edge, 0, r * 1.95, -r * 0.35, r * 0.14, r * 0.5, r * 1.8);
      d.m('head', 'cone', black, r * 1.1, r * 1.9, -r * 0.2, r * 0.24, r * 1.6, r * 0.24, -0.3, 0, -0.9);
      d.m('head', 'cone', edge, r * 2.1, r * 2.9, -r * 0.55, r * 0.15, r * 1.1, r * 0.15, -0.5, 0, -0.1);
      sword(d, 1.05, 0.085, 0x2c2c34, 0x19191e);
      d.g('wpR', 'box', 0xff3010, 0, 0, 0.62, 0.012, 0.024, 0.95);
      d.p('elL', 'box', black, 0.075, -o.fa * 0.5, 0.03, 0.03, 0.62, 0.4);             // tower shield
      d.p('elL', 'box', edge, 0.07, -o.fa * 0.5, 0.03, 0.028, 0.66, 0.44);
      d.p('elL', 'box', 0x6a0a08, 0.092, -o.fa * 0.45, 0.03, 0.01, 0.34, 0.06);
      d.p('elL', 'box', 0x6a0a08, 0.092, -o.fa * 0.35, 0.03, 0.01, 0.06, 0.24);
      d.p('elL', 'sph', bone, 0.1, -o.fa * 0.62, 0.03, 0.045, 0.05, 0.04);
    },

    boneKing(d) {
      const bone = 0xcfc4a4, joint = 0x8a7e60, gold = 0xc8962a, black = 0x16141a, crimson = 0x7a0a12, deep = 0x3e0508, red = 0xff3010;
      const o = humanoid(d, { th: 0.44, sh: 0.44, torso: 0.66, chestW: 0.25, chestD: 0.16, waistW: 0.1, shW: 0.34, ua: 0.32, fa: 0.32, ar: 0.05, lr: 0.056,
        hipW: 0.12, headR: 0.14, hunch: 0.14, skel: true, col: { bone, joint } });
      d.p('spine', 'box', black, 0, o.torso * 0.84, 0.0, o.chestW * 2.2, o.torso * 0.26, o.chestD * 2.1);   // upper cuirass, ribs bare below
      d.p('spine', 'box', gold, 0, o.torso * 0.71, o.chestD * 1.03, o.chestW * 2.0, 0.02, 0.01);
      for (let i = 0; i < 9; i++) { const a = (i / 8 - 0.5) * 3.2; d.p('spine', 'sph', 0x241a16, Math.sin(a) * o.shW * 0.95, o.torso * 0.98, Math.cos(a) * 0.08 - 0.07, 0.11, 0.09, 0.11); }  // black fur mantle
      for (let i = 0; i < 5; i++) d.p('spine', 'cone', bone, (i - 2) * 0.12, o.torso * 1.08, -0.1, 0.03, 0.2 + (2 - Math.abs(i - 2)) * 0.05, 0.03, -0.4);
      d.g('spine', 'sph', red, 0, o.torso * 0.6, 0.0, 0.07, 0.08, 0.06);                 // ember heart
      d.p('spine', 'box', black, 0, o.torso * 0.92, 0, o.shW * 1.7, 0.08, o.chestD * 1.8);  // gorget
      d.p('spine', 'cyl', gold, 0, o.torso * 0.97, 0, o.shW * 0.62, 0.03, o.chestD * 1.0);
      SIDES.forEach(([S, s]) => {
        d.p('sh' + S, 'sph', black, 0, 0.04, 0, 0.21, 0.16, 0.2);
        d.p('sh' + S, 'cyl', gold, 0, -0.03, 0, 0.212, 0.035, 0.202);
        for (let i = 0; i < 3; i++) d.p('sh' + S, 'cone', gold, s * 0.06, 0.17, -0.1 + i * 0.1, 0.045, 0.3 - i * 0.05, 0.045, 0, 0, -s * 0.35);
        d.p('el' + S, 'tapd', black, 0, -o.fa * 0.7, 0, 0.075, o.fa * 0.6, 0.075);
        d.p('el' + S, 'cone', gold, s * 0.07, -o.fa * 0.6, 0, 0.022, 0.1, 0.022, 0, 0, -s * 1.3);
        d.p('el' + S, 'cyl', gold, 0, -o.fa * 0.46, 0, 0.062, 0.025, 0.062);
        d.p('kn' + S, 'tapd', black, 0, -o.sh * 0.45, 0.01, 0.07, o.sh * 0.8, 0.07);
        d.p('kn' + S, 'cone', gold, 0, 0.0, 0.06, 0.03, 0.09, 0.03, PI / 2);
        d.p('hip' + S, 'box', black, 0, -0.1, 0.01, 0.13, 0.2, 0.15);
      });
      d.p('hips', 'cyl', gold, 0, 0.05, 0, 0.17, 0.05, 0.13);
      d.p('hips', 'box', crimson, 0, -0.22, 0.1, 0.2, 0.46, 0.015, 0.08);
      d.bone('cape', 'spine', 0, o.torso * 0.95, -0.11, 0.1);
      const R = CT.rng(5);
      for (let i = 0; i < 9; i++) { const x = (i - 4) * 0.075, l = 1.15 + R() * 0.3; d.p('cape', 'box', i % 3 === 1 ? deep : crimson, x, -l * 0.5, -Math.abs(x) * 0.3, 0.085, l, 0.02, 0, x * 0.6, 0); }
      d.p('cape', 'sph', 0x2a1a14, 0, 0.0, 0.03, 0.36, 0.08, 0.16);
      skull(d, 0.14, bone, red, 0.0);
      d.p('head', 'cyl', gold, 0, 0.23, -0.01, 0.14, 0.05, 0.15);                        // spiked crown
      for (let i = 0; i < 9; i++) { const a = i / 9 * TAU, h = i % 2 ? 0.17 : 0.27; d.p('head', 'cone', gold, Math.sin(a) * 0.13, 0.25 + h * 0.5, -0.01 + Math.cos(a) * 0.14, 0.03, h, 0.03, Math.cos(a) * 0.22, 0, -Math.sin(a) * 0.22); }
      d.g('head', 'sph', red, 0, 0.24, 0.145, 0.026, 0.026, 0.015);
      d.p('wpR', 'cyl', LEATHER, 0, 0, -0.04, 0.028, 0.3, 0.028, PI / 2);
      d.p('wpR', 'sph', bone, 0, 0, -0.22, 0.06, 0.06, 0.06);
      d.p('wpR', 'box', gold, 0, 0, 0.12, 0.42, 0.05, 0.06);
      d.m('wpR', 'cone', gold, 0.23, 0, 0.14, 0.03, 0.12, 0.03, 0, 0, -1.2);
      d.p('wpR', 'box', 0x1e1c22, 0, 0, 0.9, 0.15, 0.03, 1.5);
      d.p('wpR', 'cone', 0x1e1c22, 0, 0, 1.72, 0.075, 0.16, 0.015, PI / 2);
      d.mg('wpR', 'box', 0xff2808, 0.078, 0, 0.9, 0.012, 0.035, 1.45);
      d.tip = ['wpR', 0, 0, 1.7];
    },
  };
  DESIGN.boneKing.lie = 0.2;

  const VIS = { wolf: 1.25, wraith: 1.1 };
  // ── Behaviour table ────────────────────────────────────────────────────────
  const BEH = {
    wolf:       { turn: 7, rad: 0.5, circle: 4.2, flee: 0.5, atks: ['bite'], blood: 0x6a0008, gib: 0x7a1010, voice: ['wolf_growl', 'wolf_growl', 'wolf_yelp', 'wolf_yelp'], rim: 0x5a2410 },
    ghoul:      { turn: 4, rad: 0.45, circle: 0, atks: ['grab', 'claw'], blood: 0x2a0806, gib: 0x5a2a1a, voice: ['ghoul_moan', 'ghoul_shriek', 'ghoul_shriek', 'ghoul_moan'], rim: 0x2a4a34 },
    bandit:     { turn: 5, rad: 0.45, circle: 3.2, flee: 0.3, block: 0.4, dodge: 0.25, atks: ['chop', 'sweep'], blood: 0x7a0008, gib: 0x8a1010, voice: ['bandit_shout', 'bandit_shout', null, 'bandit_die'], rim: 0x6a2a10 },
    orc:        { turn: 3.5, rad: 0.65, circle: 0, hyper: 1, atks: ['chop', 'sweep', 'charge'], blood: 0x6a0a04, gib: 0x7a1a0a, voice: ['orc_roar', 'orc_roar', null, 'orc_die'], rim: 0x6a3010 },
    troll:      { turn: 1.8, rad: 1.4, circle: 0, hyper: 2, armor: 0.15, atks: ['tsweep', 'slam', 'stomp'], blood: 0x4a1008, gib: 0x5a3020, voice: ['troll_bellow', 'troll_bellow', null, 'troll_bellow'], rim: 0x5a3a18 },
    wraith:     { turn: 4, rad: 0.5, circle: 3.5, float: 0.55, ghost: true, atks: ['wclaw', 'wlunge'], blood: 0x9fe8ff, gib: 0x9fe8ff, voice: ['wraith_shriek', 'wraith_shriek', null, 'wraith_shriek'], rim: 0x1c4a9a },
    boneKnight: { turn: 3, rad: 0.55, circle: 3.0, hyper: 1, guard: 1, armor: 0.2, bone: true, atks: ['chop', 'thrust'], blood: 0x4a0006, gib: 0xd8ccb0, voice: ['bone_rattle', 'bone_rattle', null, 'bone_rattle'], rim: 0x6a1008 },
    boneKing:   { turn: 1.6, rad: 1.7, circle: 0, hyper: 3, armor: 0.25, bone: true, atks: ['combo', 'kslam', 'stomp'], atks2: ['combo', 'kslam', 'firewave', 'stomp', 'firewave'], blood: 0x6a0404, gib: 0xd8ccb0, voice: ['boss_roar', 'boss_laugh', null, 'boss_roar'], rim: 0x9a1a08 },
  };

  // ── Attack keyframes: [bone, windup xyz, strike xyz] (added to the rest pose) ──
  const K = (b, wx, wy, wz, sx, sy, sz) => [b, wx, wy, wz, sx, sy, sz];
  const ATK = {
    chop: { wind: 0.6, strike: 0.2, rec: 0.5, dmg: 1, reach: 1, arc: 0.9, lunge: 1.2, cd: 1.4, keys: [
      K('spine', -0.25, -0.35, 0, 0.35, 0.25, 0), K('head', 0.15, 0.2, 0, -0.1, -0.1, 0), K('shR', -3.1, 0.2, 0, -0.7, -0.1, 0), K('elR', -1.2, 0, 0, -0.25, 0, 0),
      K('wpR', 0.3, 0, 0, 1.2, 0, 0), K('shL', -0.5, 0, 0.35, 0.2, 0, 0.2), K('hipL', -0.3, 0, 0, -0.75, 0, 0), K('knL', 0.3, 0, 0, 0.55, 0, 0), K('hipR', 0.15, 0, 0, 0.35, 0, 0), K('knR', 0.1, 0, 0, 0.35, 0, 0)] },
    sweep: { wind: 0.55, strike: 0.22, rec: 0.5, dmg: 0.9, reach: 1.05, arc: 1.3, lunge: 0.6, cd: 1.4, keys: [
      K('spine', 0, -0.8, 0, 0.1, 0.8, 0), K('shR', -1.5, -1.0, 0, -1.4, 1.0, 0), K('elR', -0.4, 0, 0, -0.1, 0, 0), K('wpR', 1.3, 0, 0, 1.45, 0, 0),
      K('shL', -0.4, 0, 0.5, -0.2, 0, 0.7), K('hipL', -0.4, 0, 0, -0.5, 0, 0), K('knL', 0.4, 0, 0, 0.45, 0, 0), K('knR', 0.2, 0, 0, 0.3, 0, 0), K('head', 0, 0.4, 0, 0, -0.4, 0)] },
    thrust: { wind: 0.5, strike: 0.18, rec: 0.5, dmg: 1.1, reach: 1.1, arc: 0.5, lunge: 1.4, cd: 1.3, keys: [
      K('spine', -0.1, -0.5, 0, 0.35, 0.3, 0), K('shR', -0.9, -0.4, 0, -1.5, 0.1, 0), K('elR', -1.9, 0, 0, -0.05, 0, 0), K('wpR', 1.35, 0, 0, 1.55, 0, 0),
      K('hipL', -0.3, 0, 0, -0.8, 0, 0), K('knL', 0.3, 0, 0, 0.6, 0, 0), K('hipR', 0.1, 0, 0, 0.4, 0, 0)] },
    claw: { wind: 0.45, strike: 0.18, rec: 0.4, dmg: 0.9, reach: 1, arc: 1.0, lunge: 0.8, cd: 1.0, keys: [
      K('spine', 0, -0.6, 0, 0.35, 0.6, 0), K('jaw', 0.5, 0, 0, 0.7, 0, 0), K('shR', -2.4, -0.7, 0, -0.6, 0.9, 0), K('elR', -1.1, 0, 0, -0.1, 0, 0), K('head', -0.3, 0, 0, 0.2, 0, 0), K('shL', -0.8, 0, 0.3, 0, 0, 0.4)] },
    grab: { wind: 0.65, strike: 0.25, rec: 0.55, dmg: 1.15, reach: 1.1, arc: 0.8, lunge: 1.8, cd: 1.6, keys: [
      K('spine', -0.35, 0, 0, 0.55, 0, 0), K('head', -0.5, 0, 0, -0.3, 0, 0), K('jaw', 0.6, 0, 0, 0.9, 0, 0), K('shL', -2.7, 0, 0.5, -1.6, 0, 0.1), K('shR', -2.7, 0, -0.5, -1.6, 0, -0.1),
      K('elL', -0.9, 0, 0, -0.1, 0, 0), K('elR', -0.9, 0, 0, -0.1, 0, 0), K('hipL', -0.5, 0, 0, -0.9, 0, 0), K('knL', 0.9, 0, 0, 0.5, 0, 0), K('hipR', -0.3, 0, 0, 0.3, 0, 0), K('knR', 0.8, 0, 0, 0.2, 0, 0)] },
    charge: { wind: 0.75, strike: 1.2, rec: 0.7, dmg: 1.3, reach: 0.8, arc: 1.2, lunge: 0, charge: 2.4, cd: 4.5, min: 5, max: 16, keys: [
      K('spine', 0.55, 0.3, 0, 0.7, 0.2, 0), K('head', -0.4, 0, 0, -0.5, 0, 0), K('shL', -0.3, 0, -0.1, -0.6, 0, -0.3), K('elL', -1.4, 0, 0, -1.6, 0, 0),
      K('shR', 0.4, 0, 0, 0.5, 0, 0), K('elR', -0.6, 0, 0, -0.6, 0, 0)] },
    tsweep: { wind: 0.8, strike: 0.3, rec: 0.7, dmg: 1, reach: 1.05, arc: 1.5, lunge: 0.5, cd: 1.6, shake: 0.2, keys: [
      K('spine', 0.1, -1.0, 0, 0.3, 0.9, 0), K('shR', -1.6, -1.2, 0, -1.3, 1.2, 0), K('elR', -0.3, 0, 0, -0.1, 0, 0), K('wpR', 1.2, 0, 0, 1.45, 0, 0),
      K('shL', -0.5, 0, 0.5, 0.2, 0, 0.8), K('hipL', -0.3, 0, 0, -0.5, 0, 0), K('knL', 0.4, 0, 0, 0.5, 0, 0), K('knR', 0.3, 0, 0, 0.4, 0, 0)] },
    slam: { wind: 0.85, strike: 0.2, rec: 0.9, dmg: 1.3, reach: 0.9, arc: 0.8, lunge: 0.3, cd: 3.2, aoe: 2.6, aoeFwd: 1.4, shake: 1.0, keys: [
      K('spine', -0.45, 0, 0, 0.8, 0, 0), K('head', -0.3, 0, 0, 0.3, 0, 0), K('shR', -3.2, 0, 0.25, -0.9, 0, 0), K('shL', -3.2, 0, -0.25, -0.9, 0, 0),
      K('elR', -0.9, 0, 0, -0.1, 0, 0), K('elL', -0.9, 0, 0, -0.1, 0, 0), K('wpR', 0.2, 0, 0, 1.3, 0, 0), K('hipL', -0.2, 0, 0, -0.9, 0, 0), K('knL', 0.2, 0, 0, 1.0, 0, 0), K('hipR', -0.2, 0, 0, -0.6, 0, 0), K('knR', 0.2, 0, 0, 1.1, 0, 0)] },
    stomp: { wind: 0.55, strike: 0.15, rec: 0.6, dmg: 0.8, reach: 0.7, arc: 3.2, lunge: 0, cd: 3.0, aoe: 1.6, aoeFwd: 0.2, shake: 0.6, keys: [
      K('hipR', -1.3, 0, -0.2, 0.1, 0, 0), K('knR', 1.4, 0, 0, 0.1, 0, 0), K('spine', -0.25, 0, 0.15, 0.35, 0, 0), K('shL', -0.3, 0, 0.9, 0, 0, 0.4), K('shR', -0.3, 0, -0.9, 0, 0, -0.4), K('hipL', 0, 0, 0, -0.3, 0, 0), K('knL', 0.2, 0, 0, 0.5, 0, 0)] },
    kslam: { wind: 0.95, strike: 0.22, rec: 1.0, dmg: 1.4, reach: 1, arc: 0.9, lunge: 0.6, cd: 3.5, aoe: 3.2, aoeFwd: 1.3, shake: 1.2, keys: [
      K('spine', -0.5, 0, 0, 0.8, 0, 0), K('head', -0.3, 0, 0, 0.3, 0, 0), K('shR', -3.3, 0, 0.3, -0.9, 0, 0), K('shL', -3.2, 0, -0.5, -0.9, 0, -0.1),
      K('elR', -1.0, 0, 0, -0.1, 0, 0), K('elL', -1.3, 0, 0, -0.3, 0, 0), K('wpR', 0.3, 0, 0, 1.2, 0, 0), K('hipL', -0.2, 0, 0, -0.9, 0, 0), K('knL', 0.2, 0, 0, 1.0, 0, 0), K('knR', 0.2, 0, 0, 0.9, 0, 0)] },
    firewave: { wind: 1.0, strike: 0.3, rec: 0.9, dmg: 0.7, reach: 1, arc: 3.2, lunge: 0, cd: 4.5, wave: true, shake: 0.8, keys: [
      K('spine', -0.45, 0, 0, 0.6, 0, 0), K('head', -0.6, 0, 0, 0.35, 0, 0), K('shL', -2.8, 0, 0.9, -0.5, 0, 1.3), K('shR', -2.8, 0, -0.9, -0.5, 0, -1.3),
      K('elL', -0.5, 0, 0, 0, 0, 0), K('elR', -0.5, 0, 0, 0, 0, 0), K('knL', 0.2, 0, 0, 0.8, 0, 0), K('knR', 0.2, 0, 0, 0.8, 0, 0), K('hipL', 0, 0, 0, -0.6, 0, 0), K('hipR', 0, 0, 0, -0.6, 0, 0)] },
    combo: { seq: ['sweep', 'chop', 'sweep'] },
    roar: { wind: 0.3, strike: 0.9, rec: 0.4, dmg: 0, noHit: true, keys: [
      K('spine', -0.2, 0, 0, -0.45, 0, 0), K('head', -0.3, 0, 0, -0.7, 0, 0), K('shL', -0.3, 0, 0.5, -0.6, 0, 1.1), K('shR', -0.3, 0, -0.5, -0.6, 0, -1.1),
      K('elL', -0.6, 0, 0, -1.0, 0, 0), K('elR', -0.6, 0, 0, -1.0, 0, 0), K('jaw', 0.3, 0, 0, 0.8, 0, 0), K('knL', 0.2, 0, 0, 0.3, 0, 0), K('knR', 0.2, 0, 0, 0.3, 0, 0)] },
    shove: { wind: 0.4, strike: 0.2, rec: 0.4, dmg: 0.45, reach: 0.9, arc: 0.9, lunge: 1.0, cd: 1.2, keys: [K('spine', -0.3, 0.3, 0, 0.5, -0.2, 0), K('head', -0.3, 0, 0, 0.5, 0, 0)] },
    bite: { wind: 0.45, strike: 0.32, rec: 0.45, dmg: 1, reach: 1.1, range: 2.1, arc: 0.8, lunge: 3.2, leap: 0.65, cd: 1.8, keys: [
      K('body', -0.15, 0, 0, 0.15, 0, 0), K('head', 0.35, 0, 0, -0.35, 0, 0), K('jaw', 0.25, 0, 0, 0.75, 0, 0), K('flL', 0.5, 0, 0, -1.2, 0, 0), K('flR', 0.5, 0, 0, -1.1, 0, 0),
      K('flL2', 0.6, 0, 0, 0.1, 0, 0), K('flR2', 0.6, 0, 0, 0.1, 0, 0), K('blL', -0.5, 0, 0, 0.9, 0, 0), K('blR', -0.5, 0, 0, 0.9, 0, 0), K('blL2', 0.4, 0, 0, -0.3, 0, 0), K('blR2', 0.4, 0, 0, -0.3, 0, 0), K('tail', -0.4, 0, 0, -0.8, 0, 0)] },
    wclaw: { wind: 0.5, strike: 0.2, rec: 0.45, dmg: 1, reach: 1, arc: 1.0, lunge: 1.4, cd: 1.3, keys: [
      K('body', -0.3, -0.4, 0, 0.45, 0.4, 0), K('head', -0.3, 0, 0, 0.3, 0, 0), K('shR', -2.6, -0.6, 0, -0.7, 0.9, 0), K('elR', -0.9, 0, 0, 0, 0, 0), K('shL', -0.8, 0, 0.3, 0.2, 0, 0.5)] },
    wlunge: { wind: 0.7, strike: 0.3, rec: 0.6, dmg: 1.2, reach: 1.1, range: 2.1, arc: 0.9, lunge: 3.5, cd: 2.2, keys: [
      K('body', -0.5, 0, 0, 0.6, 0, 0), K('head', -0.6, 0, 0, 0.2, 0, 0), K('jaw', 0.6, 0, 0, 0.9, 0, 0), K('shL', -2.9, 0, 0.6, -1.6, 0, 0.1), K('shR', -2.9, 0, -0.6, -1.6, 0, -0.1), K('elL', -0.4, 0, 0, 0, 0, 0), K('elR', -0.4, 0, 0, 0, 0, 0), K('hem', -0.3, 0, 0, 0.6, 0, 0)] },
  };
  // Block pose for shield bearers.
  const BLOCK = [['shL', -1.25, -0.9, 0.2], ['elL', -1.5, 0, 0], ['spine', 0.1, 0.25, 0], ['head', 0.1, 0, 0]];

  // ── FX: pixel particles (sparks, dust, embers, ectoplasm, fallback blood) ───
  function makePts(max, additive) {
    const geo = new T.BufferGeometry();
    const P = { n: 0, max, pos: new Float32Array(max * 3), col: new Float32Array(max * 3), size: new Float32Array(max), vel: new Float32Array(max * 3),
      life: new Float32Array(max), grav: new Float32Array(max), floor: new Float32Array(max), drag: new Float32Array(max), geo };
    const A = (a, n) => new T.BufferAttribute(a, n).setUsage(T.DynamicDrawUsage);
    geo.setAttribute('position', A(P.pos, 3)); geo.setAttribute('pcol', A(P.col, 3)); geo.setAttribute('size', A(P.size, 1));
    const mat = new T.ShaderMaterial({
      vertexShader: 'attribute float size; attribute vec3 pcol; varying vec3 vC; void main(){ vC = pcol; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = size > 0.0 ? clamp(size * 257.0 / -mv.z, 1.0, 36.0) : 0.0; gl_Position = projectionMatrix * mv; }',
      fragmentShader: 'varying vec3 vC; void main(){ gl_FragColor = vec4(vC, 1.0); }',
      transparent: additive, depthWrite: !additive, blending: additive ? T.AdditiveBlending : T.NormalBlending,
    });
    P.mesh = new T.Points(geo, mat); P.mesh.frustumCulled = false; P.mesh.renderOrder = additive ? 6 : 4;
    return P;
  }
  let FXS = null, FXG = null;
  function emit(P, x, y, z, vx, vy, vz, life, size, hex, grav, drag, floorY) {
    let i = P.n < P.max ? P.n++ : (rnd() * P.max) | 0;
    P.pos[i * 3] = x; P.pos[i * 3 + 1] = y; P.pos[i * 3 + 2] = z;
    P.vel[i * 3] = vx; P.vel[i * 3 + 1] = vy; P.vel[i * 3 + 2] = vz;
    COL.set(hex); P.col[i * 3] = COL.r; P.col[i * 3 + 1] = COL.g; P.col[i * 3 + 2] = COL.b;
    P.life[i] = life; P.size[i] = size; P.grav[i] = grav; P.drag[i] = drag || 0; P.floor[i] = floorY == null ? -1e9 : floorY;
  }
  function updPts(P, dt) {
    for (let i = 0; i < P.n; i++) {
      P.life[i] -= dt;
      if (P.life[i] <= 0) {                      // swap-remove
        const j = --P.n;
        if (i !== j) {
          for (let k = 0; k < 3; k++) { P.pos[i * 3 + k] = P.pos[j * 3 + k]; P.vel[i * 3 + k] = P.vel[j * 3 + k]; P.col[i * 3 + k] = P.col[j * 3 + k]; }
          P.life[i] = P.life[j]; P.size[i] = P.size[j]; P.grav[i] = P.grav[j]; P.drag[i] = P.drag[j]; P.floor[i] = P.floor[j];
        }
        P.size[j] = 0; i--; continue;
      }
      const d = 1 - Math.min(1, P.drag[i] * dt);
      P.vel[i * 3] *= d; P.vel[i * 3 + 2] *= d; P.vel[i * 3 + 1] = P.vel[i * 3 + 1] * d - P.grav[i] * dt;
      P.pos[i * 3] += P.vel[i * 3] * dt; P.pos[i * 3 + 1] += P.vel[i * 3 + 1] * dt; P.pos[i * 3 + 2] += P.vel[i * 3 + 2] * dt;
      if (P.pos[i * 3 + 1] < P.floor[i]) { P.pos[i * 3 + 1] = P.floor[i] + 0.01; P.vel[i * 3] = P.vel[i * 3 + 1] = P.vel[i * 3 + 2] = 0; P.grav[i] = 0; }
    }
    for (let i = P.n; i < Math.min(P.max, P.n + 64); i++) P.size[i] = 0;
    P.geo.attributes.position.needsUpdate = P.geo.attributes.pcol.needsUpdate = P.geo.attributes.size.needsUpdate = true;
    P.geo.setDrawRange(0, P.n);
  }
  const BLOODS = [0x6a0006, 0x8a0a08, 0x3a0003, 0xa81810];
  function fxBlood(p, d, amount, cols) {
    const n = Math.round(8 + amount * 40), fl = ground(p.x, p.z);
    for (let i = 0; i < n; i++) {
      const s = 2 + rnd() * 5 * (0.5 + amount);
      emit(FXS, p.x, p.y, p.z, d.x * s + (rnd() - 0.5) * 2.5, d.y * s + 1 + rnd() * 3, d.z * s + (rnd() - 0.5) * 2.5, 1.5 + rnd() * 2.5, 0.03 + rnd() * 0.05, (cols || BLOODS)[i & 3], 13, 0.4, fl + 0.02);
    }
  }
  function fxBurst(P, p, n, spd, hex, life, size, grav, up) {
    const fl = ground(p.x, p.z);
    for (let i = 0; i < n; i++) {
      const a = rnd() * TAU, e = rnd() * 2 - 1, s = spd * (0.4 + rnd() * 0.6);
      emit(P, p.x, p.y, p.z, Math.cos(a) * s * Math.sqrt(1 - e * e), e * s + (up || 0), Math.sin(a) * s * Math.sqrt(1 - e * e), life * (0.6 + rnd() * 0.6), size * (0.6 + rnd() * 0.8), hex, grav, 1.2, fl + 0.02);
    }
  }
  function fxDustRing(x, z, r, n) {
    const y = ground(x, z) + 0.1;
    for (let i = 0; i < n; i++) {
      const a = rnd() * TAU, s = 3 + rnd() * 4;
      emit(FXS, x + Math.cos(a) * r * 0.4, y, z + Math.sin(a) * r * 0.4, Math.cos(a) * s, 0.5 + rnd() * 1.5, Math.sin(a) * s, 0.7 + rnd() * 0.6, 0.12 + rnd() * 0.12, i & 1 ? 0x6a5a48 : 0x4a3e32, 1.5, 3, y);
    }
  }
  const ECTO = [0x9fe8ff, 0x5ab0ff, 0xd8f8ff, 0x3a70c0], BONES = [0xe0d4b8, 0xc8bc9c, 0xf0e8d0, 0x6a0006];

  // ── Gore bridge (uses CT.gore, falls back to our own pixels and physics) ────
  const GORE = {
    spray(p, d, a) { if (has('gore', 'spray')) CT.gore.spray(p.clone(), d.clone(), a); else fxBlood(p, d, a); },
    pool(x, z, s) { if (has('gore', 'pool')) CT.gore.pool(x, z, s); else fbPool(x, z, s); },
    gib(p, col, n, o) { if (has('gore', 'gib')) CT.gore.gib(p.clone(), col, n, o); else fbGib(p, col, n); },
    pulse(p, d, a, obj, dur) { if (has('gore', 'spray')) { CT.gore.spray(p.clone(), d.clone(), a, { pulses: Math.round(dur * 5), duration: dur, attach: obj }); return true; } return false; },
    chunk(o, p, v, s) { if (has('gore', 'chunk')) CT.gore.chunk(o, p.clone(), v, s); else fbChunk(o, v, s); },
    blade(a) { if (has('gore', 'bladeBlood')) CT.gore.bladeBlood(a); },
    screen(a) { if (has('gore', 'screen')) CT.gore.screen(a); },
  };
  const FB = { chunks: [], pools: [], pi: 0 };
  function fbChunk(o, v, s) {
    if (o.parent !== scene) scene.add(o);
    FB.chunks.push({ o, v: v.clone(), s: s.clone(), t: 60, drip: 0 });
    if (FB.chunks.length > 60) { const c = FB.chunks.shift(); scene.remove(c.o); }
  }
  function fbGib(p, col, n) {
    const bone = col === 0xd8ccb0 || col === 0xe0d4b8;
    for (let i = 0; i < Math.min(n, 12); i++) {
      const m = new T.Mesh(bone ? GP.shard : GP.meat, MAT.meat), s = 0.06 + rnd() * 0.1;
      m.scale.setScalar(s); m.position.copy(p);
      fbChunk(m, V1.set((rnd() - 0.5) * 9, 3 + rnd() * 6, (rnd() - 0.5) * 9), V2.set(rnd() * 12, rnd() * 12, rnd() * 12));
    }
    fxBlood(p, V1.set(0, 1, 0), 1.6);
    if (bone) fxBurst(FXS, p, 30, 7, BONES[0], 2, 0.06, 14, 2);
  }
  function fbPool(x, z, s) {
    let m = FB.pools[FB.pi];
    if (!m) { m = FB.pools[FB.pi] = new T.Mesh(GP.disc, MAT.pool); scene.add(m); }
    FB.pi = (FB.pi + 1) % 24;
    m.position.set(x, ground(x, z) + 0.04, z); m.userData.s = s; m.userData.t = 0; m.scale.setScalar(0.05);
  }
  function updFallback(dt) {
    for (let i = FB.chunks.length - 1; i >= 0; i--) {
      const c = FB.chunks[i], o = c.o;
      c.t -= dt;
      if (c.t <= 0) { scene.remove(o); FB.chunks.splice(i, 1); continue; }
      if (c.rest) continue;
      c.v.y -= 18 * dt;
      o.position.addScaledVector(c.v, dt);
      o.rotation.x += c.s.x * dt; o.rotation.y += c.s.y * dt; o.rotation.z += c.s.z * dt;
      const g = ground(o.position.x, o.position.z) + 0.07;
      if (o.position.y < g) {
        o.position.y = g; c.v.y *= -0.3; c.v.x *= 0.55; c.v.z *= 0.55; c.s.multiplyScalar(0.5);
        if (c.v.lengthSq() < 0.3) { c.rest = true; o.rotation.x = Math.round(o.rotation.x / (PI / 2)) * PI / 2 + 0.2; }
      }
      if ((c.drip -= dt) < 0) { c.drip = 0.04; emit(FXS, o.position.x, o.position.y, o.position.z, 0, -0.5, 0, 3, 0.05, BLOODS[i & 3], 10, 0, g - 0.05); }
    }
    for (const m of FB.pools) if (m && m.userData.t < 4) { m.userData.t += dt; m.scale.setScalar(m.userData.s * eOut(m.userData.t / 4)); }
  }

  // ── Build + instantiate rigs ───────────────────────────────────────────────
  function getDef(type, v) {
    const key = type + JSON.stringify(v);
    if (DEFS[key]) return DEFS[key];
    const d = kit(); DESIGN[type](d, v);
    d.geo = {}; d.glo = {};
    for (const b in d.parts) d.geo[b] = buildGeo(d.parts[b]);
    for (const b in d.glows) d.glo[b] = buildGeo(d.glows[b]);
    d.parts = d.glows = null;
    return (DEFS[key] = d);
  }
  function instantiate(d, mat) {
    const root = new T.Group(), B = {};
    root.rotation.order = 'YXZ';
    for (const [n, p, x, y, z, rx, ry, rz] of d.bones) {
      const o = new T.Group(); o.name = n; o.rotation.order = 'YXZ';
      o.position.set(x, y, z); o.rotation.set(rx, ry, rz);
      o.userData.r = [rx, ry, rz]; o.userData.p = [x, y, z]; o.userData.o = new Float32Array(3); o.userData.l = new Float32Array(3);
      (p ? B[p] : root).add(o); B[n] = o;
      if (d.geo[n]) { const m = new T.Mesh(d.geo[n], mat); m.castShadow = n === 'spine' || n === 'body'; o.add(m); }
      if (d.glo[n]) o.add(new T.Mesh(d.glo[n], MAT.glow));
    }
    return { root, B };
  }

  // ── Humanoid kit (humanoid.js): bandits, Grask, bone knights, ghouls ──────
  // One skinned mesh per monster; the bones keep the names and pose slots used here.
  const KIT = { bandit: 1, boneKnight: 1, ghoul: 1 };
  function kitSpec(type, v, seed) {
    if (type === 'bandit') return v.chief ? { preset: 'grask', height: 1.86, seed: 1 } : { preset: 'bandit', seed: 1 + seed % 3, helm: v.helm ? 'horned' : null, hood: !v.helm, right: v.axe ? 'axe' : 'sword' };
    if (type === 'boneKnight') return { preset: 'boneKnight', height: 1.85, seed: 1 };
    return { preset: 'ghoul', seed: 1 + seed % 3 };
  }
  function kitSpecs() {
    const out = [{ preset: 'grask', height: 1.86, seed: 1 }, { preset: 'boneKnight', height: 1.85, seed: 1 }];
    for (let i = 0; i < 3; i++) { out.push(kitSpec('ghoul', {}, i)); [0, 1].forEach(helm => [0, 1].forEach(axe => out.push(kitSpec('bandit', { helm, axe }, i)))); }
    return out;
  }
  function kitRig(type, v) {
    if (!KIT[type] || !CT.humanoid || typeof CT.humanoid.build !== 'function') return null;
    try {
      const r = CT.humanoid.build(Object.assign(kitSpec(type, v, (rnd() * 3) | 0), { unique: true }));
      r.B.wpR.userData.r[0] = 0;                                                   // WREST below poses the weapon
      if (type === 'ghoul') { r.B.spine.userData.r[0] = 0.55; r.B.head.userData.r[0] = -0.6; r.B.knL.userData.r[0] = r.B.knR.userData.r[0] = 0.25; r.B.hipL.userData.r[0] = r.B.hipR.userData.r[0] = -0.2; }
      return { r, def: { rig: 'biped', hits: r.hits, sev: r.sev, sr: r.sr, tip: r.tip, hipY: r.hipY, lieH: r.lieH, kit: true } };
    } catch (e) { console.warn('[monsters] humanoid kit failed, old rig used', e); KIT[type] = 0; return null; }
  }

  // ── Spawn ──────────────────────────────────────────────────────────────────
  function spawn(type, x, z, opts) {
    if (!core || !CFG[type]) return null;
    opts = opts || {};
    const cfg = CFG[type], beh = BEH[type];
    const v = {};
    if (type === 'wolf' && (opts.isAlpha || opts.alphaLook)) v.alpha = 1;
    if (type === 'bandit') { v.helm = opts.isChief ? 1 : (rnd() < 0.5 ? 1 : 0); v.axe = opts.isChief ? 1 : (rnd() < 0.45 ? 1 : 0); if (opts.isChief) v.chief = 1; }
    if (type === 'troll' && opts.isGuardian) v.guardian = 1;
    const kr = kitRig(type, v);
    const def = kr ? kr.def : getDef(type, v);
    const mat = kr ? kr.r.mat : toonMat(v.guardian ? 0x3a70c0 : beh.rim, type === 'wraith' ? 0.999 : 1);
    const tint = 0.9 + rnd() * 0.16; mat.color.setRGB(tint, tint * (0.96 + rnd() * 0.06), tint * (0.95 + rnd() * 0.05));
    const { root, B } = kr ? { root: kr.r.root, B: kr.r.B } : instantiate(def, mat);
    const vis = VIS[type] || 1;
    let scale = cfg.size * vis * (0.93 + rnd() * 0.14), hpK = 1, dmgK = 1, spdK = 1;
    if (opts.isAlpha || opts.alphaLook) { scale = 1.32 * vis; hpK = 2.6; dmgK = 1.5; spdK = 1.08; }
    if (opts.isChief) { scale = 1.22; hpK = 3; dmgK = 1.4; }
    if (opts.isGuardian) { scale = cfg.size * 1.15; hpK = 1.6; dmgK = 1.2; }
    if (cfg.boss) scale = cfg.size;
    if (bloodmoon() && isNight()) { hpK *= 1.25; dmgK *= 1.2; }
    root.scale.setScalar(scale);
    const y = ground(x, z);
    root.position.set(x, y, z);
    scene.add(root);
    const shadow = new T.Mesh(GP.disc, MAT.shadow); shadow.scale.setScalar(beh.rad * 1.5 * (type === 'wolf' ? 1.2 : 1)); shadow.renderOrder = 1;
    scene.add(shadow);
    const m = {
      id: nextId++, type, cfg, beh, def, root, B, mat, shadow, pos: root.position, yaw: opts.yaw != null ? opts.yaw : rnd() * TAU,
      hp: Math.round(cfg.hp * hpK), maxHp: Math.round(cfg.hp * hpK), state: 'idle', stateT: rnd() * 2, alive: true, dead: false,
      scale, speed: cfg.speed * spdK * (0.92 + rnd() * 0.16), dmgK, rad: beh.rad * scale / (cfg.size * vis), vel: new T.Vector3(), kv: new T.Vector3(),
      home: new T.Vector3(x, y, z), aggro: false, ph: rnd() * TAU, lost: {}, bleeds: [], flash: 0, flinch: 0, stagT: 0, staggered: false,
      atk: null, atkT: 0, atkCd: 1 + rnd(), hitDone: false, combo: null, voiceT: 0, percT: rnd() * 0.3, air: 0, hover: beh.float || 0,
      circleA: rnd() * TAU, circleDir: rnd() < 0.5 ? 1 : -1, avoid: 0, avoidT: 0, blockT: 0, dodgeT: 0, fleeT: 0, crawl: false, disarmed: false,
      hipDrop: 0, lunge: 0, lastHit: null, lastPart: 'torso', pack: opts.pack || 0, spec: opts.spec || null, garrison: opts.garrison || null,
      isChief: !!opts.isChief, isAlpha: !!opts.isAlpha, isGuardian: !!opts.isGuardian, isBoss: !!cfg.boss, name: opts.name || null,
      rise: opts.rise ? 1.2 : 0, phase2: false, engaged: false, corpseT: 90, fall: null, deathT: 0, hum: kr ? kr.r : null,
    };
    if (m.isChief) m.name = 'Grask Blackhand';
    if (m.isBoss) { m.name = 'The Bone King'; m.state = opts.dormant === false ? 'idle' : 'dormant'; }
    if (m.isGuardian) m.name = 'The Moonblade Guardian';
    root.rotation.y = m.yaw;
    root.userData.monster = m;
    if (type === 'wraith') { const au = new T.Mesh(GP.sph, MAT.aura); au.position.set(0, 1.05, 0.05); au.scale.set(0.55, 0.85, 0.5); B.body.add(au); m.aura = au; }
    if (opts.aggro) { m.aggro = true; m.state = 'chase'; }
    if (m.rise) { root.position.y -= 2 * scale; fxDustRing(x, z, 2, 30); }
    list.push(m);
    return m;
  }
  function removeMonster(m) {
    const i = list.indexOf(m); if (i >= 0) list.splice(i, 1);
    scene.remove(m.root); scene.remove(m.shadow);
    if (m.hum && m.hum.skeleton) m.hum.skeleton.dispose();   // free the bone texture of the kit rig
    m.alive = false; m.mat.emissive.setRGB(0, 0, 0);
  }

  // ── Pose helpers ───────────────────────────────────────────────────────────
  function zeroPose(m) { for (const n in m.B) { const o = m.B[n].userData.o; o[0] = o[1] = o[2] = 0; } }
  function add(m, n, x, y, z) { const b = m.B[n]; if (!b) return; const o = b.userData.o; o[0] += x; o[1] += y; o[2] += z; }
  function applyPose(m) {
    for (const n in m.B) {
      const b = m.B[n], r = b.userData.r, o = b.userData.o;
      b.rotation.set(r[0] + o[0], r[1] + o[1], r[2] + o[2]);
    }
    const h = m.B.hips || m.B.body;
    if (h) h.position.y = h.userData.p[1] + m.hipDrop;
  }
  function attackPose(m) {
    const A = m.atk; if (!A || !A.keys) return;
    const t = m.atkT, w = A.wind, s = A.strike, r = A.rec;
    let a, b, k;
    if (t < w) { a = 0; b = 1; k = smooth(t / w); }
    else if (t < w + s) { a = 1; b = 2; k = eOut((t - w) / s); }
    else { a = 2; b = 0; k = smooth((t - w - s) / r); }
    for (const key of A.keys) {
      const x0 = a === 0 ? 0 : a === 1 ? key[1] : key[4], y0 = a === 0 ? 0 : a === 1 ? key[2] : key[5], z0 = a === 0 ? 0 : a === 1 ? key[3] : key[6];
      const x1 = b === 0 ? 0 : b === 1 ? key[1] : key[4], y1 = b === 0 ? 0 : b === 1 ? key[2] : key[5], z1 = b === 0 ? 0 : b === 1 ? key[3] : key[6];
      add(m, key[0], lerp(x0, x1, k), lerp(y0, y1, k), lerp(z0, z1, k));
    }
  }

  // ── Animation ──────────────────────────────────────────────────────────────
  function animBiped(m, dt, t, spd) {
    const s = clamp(spd / Math.max(1, m.speed * 0.5), 0, 1.4), run = clamp(spd / m.speed, 0, 1);
    m.ph += dt * (2.2 + spd * 1.5 / m.scale * (m.type === 'troll' || m.isBoss ? 0.6 : 1));
    const ph = m.ph, A = 0.5 * Math.min(1, s) + 0.2 * run;
    add(m, 'hipL', -Math.sin(ph) * A, 0, 0); add(m, 'hipR', Math.sin(ph) * A, 0, 0);
    add(m, 'knL', Math.max(0, Math.cos(ph)) * 1.1 * Math.min(1, s) + 0.08, 0, 0); add(m, 'knR', Math.max(0, -Math.cos(ph)) * 1.1 * Math.min(1, s) + 0.08, 0, 0);
    add(m, 'shL', Math.sin(ph) * 0.55 * Math.min(1, s), 0, 0); add(m, 'shR', -Math.sin(ph) * 0.35 * Math.min(1, s), 0, 0);
    add(m, 'spine', 0.12 * run, Math.sin(ph) * 0.12 * s, 0); add(m, 'head', -0.1 * run, -Math.sin(ph) * 0.08 * s, 0);
    m.hipDrop = -Math.abs(Math.cos(ph)) * 0.05 * Math.min(1, s) - 0.03 * run;
    add(m, 'cape', 0.55 * run + 0.1 * Math.min(1, s) + Math.sin(t * 1.9 + m.id) * 0.05, 0, Math.sin(t * 1.3 + m.id) * 0.06);
    const br = Math.sin(t * 1.7 + m.id);                                          // breathing
    add(m, 'spine', br * 0.025, 0, 0); add(m, 'shL', 0, 0, br * 0.03); add(m, 'shR', 0, 0, -br * 0.03); add(m, 'head', Math.sin(t * 0.6 + m.id) * 0.05, Math.sin(t * 0.37 + m.id) * 0.15 * (1 - run), 0);
    const wr = WREST[m.type] || WREST.bandit;
    if (!m.aggro) add(m, 'wpR', wr[0], 0, 0);
    if (m.aggro && !m.dead) {                                                     // combat stance
      add(m, 'shR', -0.35, 0, 0); add(m, 'elR', -0.75, 0, 0); add(m, 'wpR', wr[1], 0, 0); add(m, 'shL', -0.2, 0, 0.1); add(m, 'elL', -0.5, 0, 0);
      add(m, 'knL', 0.15, 0, 0); add(m, 'knR', 0.15, 0, 0); add(m, 'hipL', -0.1, 0, 0); add(m, 'hipR', -0.1, 0, 0); m.hipDrop -= 0.03;
      if (m.type === 'ghoul' || m.type === 'troll') { add(m, 'shL', -0.2, 0, 0.3); add(m, 'shR', 0.1, 0, -0.3); }
    }
    if (m.crawl) {                                                                 // dragging itself on its arms
      m.hipDrop = -m.def.hipY * 0.72;
      add(m, 'spine', 1.25, 0, 0); add(m, 'head', -1.1, 0, 0);
      add(m, 'shL', -2.3 + Math.sin(ph) * 0.6, 0, 0.2); add(m, 'shR', -2.3 - Math.sin(ph) * 0.6, 0, -0.2); add(m, 'elL', -0.3, 0, 0); add(m, 'elR', -0.3, 0, 0);
      add(m, 'hipL', 1.2, 0, 0.2); add(m, 'hipR', 1.2, 0, -0.2);
    }
  }
  function animQuad(m, dt, t, spd) {
    const run = clamp(spd / m.speed, 0, 1), s = clamp(spd / 2, 0, 1);
    m.ph += dt * (3 + spd * 1.4);
    const ph = m.ph, A = 0.45 * s + 0.35 * run, off = run * 0.9;
    add(m, 'flL', Math.sin(ph) * A, 0, 0); add(m, 'flR', Math.sin(ph + PI - off) * A, 0, 0);
    add(m, 'blL', Math.sin(ph + PI) * A, 0, 0); add(m, 'blR', Math.sin(ph + off) * A, 0, 0);
    add(m, 'flL2', Math.max(0, Math.sin(ph + 1.3)) * 0.9 * s, 0, 0); add(m, 'flR2', Math.max(0, Math.sin(ph + PI - off + 1.3)) * 0.9 * s, 0, 0);
    add(m, 'blL2', -Math.max(0, Math.sin(ph + PI + 1.3)) * 0.7 * s, 0, 0); add(m, 'blR2', -Math.max(0, Math.sin(ph + off + 1.3)) * 0.7 * s, 0, 0);
    add(m, 'body', Math.sin(ph * 2) * 0.07 * run, 0, 0); add(m, 'head', -Math.sin(ph * 2) * 0.1 * run - 0.1 * run, Math.sin(t * 0.5 + m.id) * 0.3 * (1 - s), 0);
    m.hipDrop = -Math.abs(Math.sin(ph)) * 0.06 * run;
    const br = Math.sin(t * 3 + m.id);
    add(m, 'body', br * 0.015, 0, 0); add(m, 'tail', -0.3 * run + Math.sin(t * 2 + m.id) * 0.1, Math.sin(t * (m.aggro ? 9 : 1.5) + m.id) * 0.3, 0);
    if (m.aggro && !m.dead) {                                                     // hackles up, head low, snarling
      add(m, 'head', 0.25, 0, 0); add(m, 'jaw', 0.25 + Math.sin(t * 11) * 0.08, 0, 0); add(m, 'body', 0.06, 0, 0); m.hipDrop -= 0.04;
    }
    if (m.lost.armL || m.lost.armR) add(m, 'body', 0.18, 0, m.lost.armL ? 0.15 : -0.15);
  }
  function animWraith(m, dt, t, spd) {
    const s = clamp(spd / m.speed, 0, 1);
    add(m, 'body', 0.25 * s + Math.sin(t * 1.3 + m.id) * 0.06, 0, Math.sin(t * 0.9 + m.id) * 0.08);
    add(m, 'hem', -0.35 * s + Math.sin(t * 2.6 + m.id) * 0.15, Math.sin(t * 1.9) * 0.2, Math.sin(t * 2.2 + m.id) * 0.12);
    add(m, 'shL', 0.6 * s + Math.sin(t * 1.5 + m.id) * 0.15, 0, 0.1); add(m, 'shR', 0.6 * s + Math.sin(t * 1.5 + m.id + 1) * 0.15, 0, -0.1);
    add(m, 'elL', -0.3 + Math.sin(t * 2.1) * 0.2, 0, 0); add(m, 'elR', -0.3 + Math.sin(t * 2.3) * 0.2, 0, 0);
    add(m, 'head', Math.sin(t * 0.8 + m.id) * 0.15, Math.sin(t * 0.5 + m.id) * 0.3, Math.sin(t * 3.7) * 0.05);
    if (m.aggro) { add(m, 'shL', -0.9, 0, 0.3); add(m, 'shR', -0.9, 0, -0.3); }
    m.air = Math.sin(t * 1.4 + m.id) * 0.12;
    if ((m.fxT = (m.fxT || 0) - dt) < 0 && m.root.visible) {                      // trailing ectoplasm wisps
      m.fxT = 0.06;
      const a = rnd() * TAU, r = 0.3 * m.scale;
      emit(FXG, m.pos.x + Math.sin(a) * r, m.root.position.y + (0.3 + rnd() * 0.6) * m.scale, m.pos.z + Math.cos(a) * r, (rnd() - 0.5) * 0.4, 0.3 + rnd() * 0.5, (rnd() - 0.5) * 0.4, 1 + rnd(), 0.05 + rnd() * 0.05, ECTO[(rnd() * 4) | 0], -0.2, 0.5);
    }
  }
  const WREST = { bandit: [1.2, -0.5], orc: [1.1, 0.1], troll: [1.35, 1.1], boneKnight: [1.25, -0.45], boneKing: [1.3, 0.2], ghoul: [0, 0] };
  const ANIM = { biped: animBiped, quad: animQuad, wraith: animWraith };

  function animate(m, dt, t, spd) {
    zeroPose(m);
    m.hipDrop = 0;
    if (m.state === 'dormant') { kneel(m, t, 1); applyPose(m); return; }
    if (m.state === 'waking') { kneel(m, t, 1 - smooth(m.stateT / 2.2)); }
    else ANIM[m.def.rig](m, dt, t, spd);
    attackPose(m);
    if (m.blockT > 0) for (const b of BLOCK) add(m, b[0], b[1], b[2], b[3]);
    else if (m.beh.guard && m.aggro && !m.atk && !m.dead) for (const b of BLOCK) add(m, b[0], b[1] * 0.85, b[2] * 0.8, b[3]);
    if (m.flinch > 0) { const f = m.flinch * 3; add(m, 'spine', -0.35 * f, (m.id & 1 ? 0.3 : -0.3) * f, 0); add(m, 'head', -0.4 * f, 0, 0.2 * f); add(m, 'body', -0.2 * f, 0, 0.1 * f); }
    if (m.stagT > 0) {
      const w = Math.sin(t * 9) * 0.2;
      add(m, 'spine', -0.45 + w * 0.5, w, 0); add(m, 'head', -0.5, 0, w); add(m, 'shL', -0.6, 0, 0.9 + w); add(m, 'shR', -0.4, 0, -0.9 - w);
      add(m, 'knL', 0.5, 0, 0); add(m, 'knR', 0.3, 0, 0); m.hipDrop -= 0.06; add(m, 'body', -0.25, 0, w * 0.5); add(m, 'jaw', 0.5, 0, 0);
    }
    if (m.dodgeT > 0) { add(m, 'spine', -0.3, 0, m.circleDir * 0.3); add(m, 'knL', 0.6, 0, 0); add(m, 'knR', 0.6, 0, 0); m.hipDrop -= 0.12; }
    applyPose(m);
  }
  function kneel(m, t, k) {
    m.hipDrop = -0.5 * k;
    add(m, 'hipL', -1.5 * k, 0, 0.1 * k); add(m, 'knL', 1.6 * k, 0, 0); add(m, 'hipR', 0.25 * k, 0, -0.05 * k); add(m, 'knR', 1.75 * k, 0, 0);
    add(m, 'spine', 0.35 * k, 0, 0); add(m, 'head', (0.55 + Math.sin(t * 0.5) * 0.03) * k, 0, 0);
    add(m, 'shR', -0.75 * k, 0.35 * k, 0); add(m, 'elR', -0.5 * k, 0, 0); add(m, 'wpR', 1.95 * k, 0, 0);
    add(m, 'shL', -0.8 * k, -0.4 * k, 0); add(m, 'elL', -0.6 * k, 0, 0);
  }

  // ── Death: a procedural ragdoll-ish collapse ───────────────────────────────
  function startFall(m, dir) {
    const f = V1.set(Math.sin(m.yaw), 0, Math.cos(m.yaw)), r = V2.set(-Math.cos(m.yaw), 0, Math.sin(m.yaw));
    const lz = dir ? dir.x * f.x + dir.z * f.z : -1, lx = dir ? dir.x * r.x + dir.z * r.z : 0;
    const quad = m.def.rig === 'quad';
    m.fall = { ang: 0, av: 0.3 + rnd() * 0.4, axis: quad || Math.abs(lx) > Math.abs(lz) * 1.2 ? 'z' : 'x', sign: 1, landed: false, t: 0 };
    if (m.fall.axis === 'x') m.fall.sign = lz >= 0 ? 1 : -1; else m.fall.sign = quad ? (rnd() < 0.5 ? 1 : -1) : (lx > 0 ? 1 : -1);
    for (const n in m.B) {                                                         // limp targets
      const l = m.B[n].userData.l, R = () => rnd() * 2 - 1;
      l[0] = R() * 0.5; l[1] = R() * 0.3; l[2] = R() * 0.3;
      if (/^sh/.test(n)) { l[0] = -rnd() * 2.2 * (m.fall.sign < 0 ? 1 : 0.4); l[2] = (n === 'shL' ? 1 : -1) * (0.5 + rnd() * 1.1); }
      if (/^el/.test(n)) l[0] = -rnd() * 1.2;
      if (/^kn/.test(n)) l[0] = rnd() * 0.9;
      if (/^hip[LR]/.test(n)) { l[0] = -rnd() * 0.6; l[2] = (n === 'hipL' ? 1 : -1) * rnd() * 0.4; }
      if (n === 'head') { l[0] = R() * 0.7; l[1] = R() * 0.9; }
      if (n === 'jaw') l[0] = 0.7 + rnd() * 0.3;
      if (quad && /^(fl|bl)/.test(n)) l[0] = R() * 0.7;
      if (n === 'wpR') l[0] = R() * 1.5;
    }
  }
  function updateDead(m, dt) {
    m.deathT += dt;
    const F = m.fall;
    if (m.type === 'wraith') {                                                     // wraiths unravel into ectoplasm
      const k = m.deathT / 1.3;
      m.root.scale.setScalar(m.scale * (1 + k * 0.4)); m.mat.opacity = Math.max(0, 1 - k); m.root.position.y += dt * 1.5;
      if ((m.fxT = (m.fxT || 0) - dt) < 0) { m.fxT = 0.05; V1.copy(m.root.position); V1.y += 0.8 * m.scale; fxBurst(FXG, V1, 6, 2.5, ECTO[(rnd() * 4) | 0], 1.2, 0.08, -1); }
      if (m.aura) m.aura.visible = false;
      if (k >= 1) m.root.visible = false;
      if (m.deathT > 3) removeMonster(m);
      return;
    }
    if (m.gibbed) { if (m.deathT > 1) removeMonster(m); return; }
    if (F && !F.landed) {
      F.t += dt;
      const bucl = m.isBoss ? 1.4 : 0.22;                                        // knees buckle first
      if (F.t > bucl) { F.av += (5.5 / Math.sqrt(m.scale)) * Math.sin(Math.max(0.25, F.ang)) * dt; F.ang += F.av * dt; }
      else m.hipDrop = -smooth(F.t / bucl) * m.def.hipY * (m.isBoss ? 0.45 : 0.25);
      if (F.ang >= PI / 2) {
        F.ang = PI / 2; F.av = -F.av * 0.22;
        if (Math.abs(F.av) < 0.25) { F.landed = true; F.av = 0; }
        if (!F.thud) { F.thud = true; sfx(m.beh.bone ? 'bone' : 'flesh', m.pos); if (m.scale > 2 && core.shake) core.shake(Math.min(1, m.scale * 0.25), 0.4); fxDustRing(m.pos.x, m.pos.z, m.scale, Math.round(6 * m.scale)); }
      }
    }
    // limbs go limp toward their targets
    const k = 1 - Math.exp(-5 * dt);
    for (const n in m.B) {
      const o = m.B[n].userData.o, l = m.B[n].userData.l, drop = F && F.t < 0.22 && /^kn/.test(n) ? 1.2 : 0;
      o[0] += (l[0] + drop - o[0]) * k; o[1] += (l[1] - o[1]) * k; o[2] += (l[2] - o[2]) * k;
    }
    if (F && F.t > 0.3) m.hipDrop += (-(m.def.hipY * 0.15) - m.hipDrop) * k;
    applyPose(m);
    const R = m.root;
    R.rotation.y = m.yaw;
    if (F) { if (F.axis === 'x') { R.rotation.x = F.sign * F.ang; R.rotation.z = 0; } else { R.rotation.z = F.sign * F.ang; R.rotation.x = 0; } }
    const g = ground(m.pos.x, m.pos.z), lift = m.def.lieH * m.scale * Math.sin(F ? F.ang : 0);
    let y = g + lift;
    if (m.deathT > m.corpseT) { y -= (m.deathT - m.corpseT) * 0.35 * m.scale; if (m.deathT > m.corpseT + 5) { removeMonster(m); return; } }
    R.position.y = y;
    m.kv.multiplyScalar(Math.exp(-4 * dt));
    m.pos.x += m.kv.x * dt; m.pos.z += m.kv.z * dt;
    m.shadow.visible = false;
    updBleeds(m, dt);
  }

  // ── Sever, gib, bleed ──────────────────────────────────────────────────────
  function stumpMesh(r) { const s = new T.Mesh(GP.stump, MAT.stump); s.scale.setScalar(r); return s; }
  function sever(m, part, dir, point, force) {
    const bn = m.def.sev[part]; if (!bn || m.lost[part]) return false;
    const bone = m.B[bn]; if (!bone || !bone.parent) return false;
    if (m.hum) CT.humanoid.sever(m.hum, part);                                   // bake the limb onto its bone, hide it in the skin
    m.lost[part] = true;
    m.root.updateMatrixWorld(true);
    const parent = bone.parent, r = m.def.sr[part];
    const st = stumpMesh(r); st.position.copy(bone.position); st.quaternion.copy(bone.quaternion); parent.add(st);
    bone.matrixWorld.decompose(V1, Q1, S1);
    parent.remove(bone);
    bone.position.copy(V1); bone.quaternion.copy(Q1); bone.scale.copy(S1);
    const cap = stumpMesh(r); cap.rotation.x = PI; bone.add(cap);
    scene.add(bone);
    const up = part === 'head' ? 5 + rnd() * 3 : 3 + rnd() * 3, f = (force || 1) * (3 + rnd() * 3);
    const vel = new T.Vector3(dir.x * f + (rnd() - 0.5) * 2, up, dir.z * f + (rnd() - 0.5) * 2);
    const spin = new T.Vector3((rnd() - 0.5) * 16, (rnd() - 0.5) * 10, (rnd() - 0.5) * 16);
    GORE.chunk(bone, V1, vel, spin);
    // an arterial fountain pulses from the stump
    const pd = bone === m.B.head ? V2.set(0, 1, 0) : V2.set(0, -1, 0);
    const dirL = pd.clone().applyQuaternion(st.quaternion);
    if (!m.beh.ghost) {
      V3.copy(dirL).transformDirection(parent.matrixWorld); V3.y += 0.5; V3.normalize();
      if (!GORE.pulse(V1, V3, m.beh.bone ? 0.4 : 1.1, parent, 2.2 + rnd())) m.bleeds.push({ b: parent, off: new T.Vector3().copy(st.position), dirL, t: 2.2 + rnd(), next: 0, n: 0 });
    }
    GORE.spray(V1, V3.set(dir.x, 0.6, dir.z).normalize(), 1.4);
    if (m.beh.bone) fxBurst(FXS, V1, 14, 4, BONES[1], 1.5, 0.05, 14, 1);
    sfx('sever', m.pos);
    bus.emit('sever', { monster: m, part, point: (point || V1).clone(), dir: dir.clone() });
    if (part === 'armR') m.disarmed = true;
    if (part === 'legL' || part === 'legR') { if (m.def.rig === 'biped') m.crawl = true; m.speed *= m.def.rig === 'biped' ? 0.28 : 0.6; }
    if (part === 'armL' || part === 'armR') { if (m.def.rig === 'quad') m.speed *= 0.6; }
    return true;
  }
  function gib(m, dir, point) {
    m.gibbed = true;
    const parts = ['head', 'armL', 'armR', 'legL', 'legR'];
    for (const p of parts) if (m.def.sev[p] && !m.lost[p]) sever(m, p, V4.set(dir.x + (rnd() - 0.5) * 1.6, 0, dir.z + (rnd() - 0.5) * 1.6), point, 1.8);
    const c = m.B.spine || m.B.body;
    if (c) {                                                                       // the torso goes too
      if (m.hum) CT.humanoid.sever(m.hum, 'torso');
      m.root.updateMatrixWorld(true);
      c.matrixWorld.decompose(V1, Q1, S1); c.parent.remove(c);
      c.position.copy(V1); c.quaternion.copy(Q1); c.scale.copy(S1); scene.add(c);
      GORE.chunk(c, V1, new T.Vector3(dir.x * 5, 3 + rnd() * 2, dir.z * 5), new T.Vector3((rnd() - 0.5) * 9, (rnd() - 0.5) * 6, (rnd() - 0.5) * 9));
    }
    m.root.visible = false; m.shadow.visible = false;
    V1.copy(point); V1.y = Math.max(V1.y, m.pos.y + 0.8 * m.scale);
    GORE.gib(V1, m.beh.gib, Math.round(14 + 8 * m.scale), { scale: Math.min(3, m.scale), dir: dir.clone() });
    GORE.spray(V1, V2.set(dir.x, 1, dir.z).normalize(), 2.5);
    if (m.beh.bone) { fxBurst(FXS, V1, 40, 8, BONES[0], 2.2, 0.07, 14, 2); fxBurst(FXS, V1, 16, 8, BONES[1], 2.2, 0.1, 14, 3); }
    sfx('gib', m.pos);
  }
  function updBleeds(m, dt) {
    for (let i = m.bleeds.length - 1; i >= 0; i--) {
      const b = m.bleeds[i];
      if (b.t <= 0) { m.bleeds.splice(i, 1); continue; }
      b.t -= dt; b.next -= dt;
      if (b.next > 0 || !b.b.parent) continue;
      b.next = 0.13; b.n++;
      const pulse = 0.55 + 0.45 * Math.sin(b.n * 1.6);
      V1.copy(b.off); b.b.localToWorld(V1);
      V2.copy(b.dirL).transformDirection(b.b.matrixWorld); V2.y += 0.5; V2.normalize();
      GORE.spray(V1, V2, 0.35 + pulse * 0.6 * Math.min(1, b.t));
    }
  }

  // ── hitTest ────────────────────────────────────────────────────────────────
  function hitTest(origin, dir, range, arc) {
    const out = [], corpses = [];
    arc = arc || 1.2;
    const dl = Math.hypot(dir.x, dir.z) || 1, dx = dir.x / dl, dz = dir.z / dl;
    for (const m of list) {
      if (!m.root.visible || m.gibbed) continue;
      const ex = m.pos.x - origin.x, ez = m.pos.z - origin.z;
      if (ex * ex + ez * ez > (range + 3 * m.scale) * (range + 3 * m.scale)) continue;
      if (m.state === 'dormant' && m.isBoss) { /* still hittable: wakes him */ }
      m.root.updateMatrixWorld(true);
      let best = null, bestS = 1e9;
      for (const h of m.def.hits) {
        if (m.lost[h[0]]) continue;
        const b = m.B[h[1]]; if (!b || !b.parent) continue;
        V1.set(h[2], h[3], h[4]); b.localToWorld(V1);
        const r = h[5] * m.scale;
        V2.subVectors(V1, origin);
        const along = V2.dot(dir);
        if (along < -r || along > range + r) continue;
        const hx = V2.x, hz = V2.z, hd = Math.hypot(hx, hz);
        const ang = hd > 0.01 ? Math.acos(clamp((hx * dx + hz * dz) / hd, -1, 1)) : 0;
        if (ang > arc / 2 + Math.atan2(r, Math.max(0.3, hd))) continue;
        V3.copy(dir).multiplyScalar(along).add(origin);
        const perpY = Math.abs(V1.y - V3.y);
        if (perpY > r + 1.1 * Math.max(1, m.scale * 0.6)) continue;
        const score = V3.distanceTo(V1) - r;                                     // closest to the crosshair line wins
        if (score < bestS) { bestS = score; best = { monster: m, part: h[0], point: V1.clone().addScaledVector(V2.normalize(), -r * 0.8), dist: Math.max(0, along - r) }; }
      }
      if (best) { m.lastHit = best.point; m.lastPart = best.part; (m.dead ? corpses : out).push(best); }
    }
    const res = out.length ? out : corpses;
    res.sort((a, b) => a.dist - b.dist);
    return res;
  }

  // ── damage ─────────────────────────────────────────────────────────────────
  const canHurtGhost = () => (has('rpg', 'holy') && !!CT.rpg.holy()) || (has('rpg', 'has') && !!CT.rpg.has('moonblessing')) || (has('rpg', 'weapon') && !!(CT.rpg.weapon() || {}).holy);
  function partPoint(m, part) {
    m.root.updateMatrixWorld(true);
    for (const h of m.def.hits) if (h[0] === part && !m.lost[part] && m.B[h[1]] && m.B[h[1]].parent) { return m.B[h[1]].localToWorld(new T.Vector3(h[2], h[3], h[4])); }
    return new T.Vector3(m.pos.x, m.pos.y + 1 * m.scale, m.pos.z);
  }
  function damage(m, amount, dir, part, heavy, opts) {
    const res = { killed: false, severed: false };
    if (!m || m.gibbed || !m.alive) return res;
    const byNpc = !!(opts && opts.source === 'npc');                              // life.js patrols and guards
    if (!byNpc) m.pHitT = playTime;
    part = part || m.lastPart || 'torso';
    dir = dir ? V4.copy(dir) : V4.set(Math.sin(m.yaw + PI), 0, Math.cos(m.yaw + PI));
    dir.y = 0; if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1); dir.normalize();
    const d = dir.clone();
    const point = m.lastHit && m.lastPart === part ? m.lastHit.clone() : partPoint(m, part);
    m.lastHit = null;
        // corpse mutilation
    if (m.dead) {
      if (m.def.sev[part] && (heavy || rnd() < 0.5) && m.type !== 'wraith') res.severed = sever(m, part, d, point);
      else if (heavy && !m.isBoss && amount > 30 && m.type !== 'wraith') { gib(m, d, point); res.severed = true; }
      GORE.spray(point, V1.set(d.x, 0.4, d.z).normalize(), 0.6); sfx(m.beh.bone ? 'bone' : 'flesh', m.pos);
      m.kv.addScaledVector(d, heavy ? 2 : 0.8);
      bus.emit('hit', { target: m, damage: 0, point, dir: d, part, heavy: !!heavy, kill: false, corpse: true, byNpc });
      return res;
    }
    // wraiths phase unless the blade is holy
    if (m.beh.ghost && !canHurtGhost()) {
      fxBurst(FXG, point, 26, 3, ECTO[0], 0.9, 0.05, -0.5); m.flash = -0.6; m.aggro = true;
      sfx('wraith_shriek', m.pos);
      bus.emit('hit', { target: m, damage: 0, point, dir: d, part, heavy: !!heavy, kill: false, phased: true, byNpc });
      return res;
    }
    if (m.state === 'dormant') wake(m);
    if (m.state === 'rising' || m.rise > 0) {                                     // invulnerable while rising
      fxBurst(FXG, point, 16, 5, 0xffa040, 0.4, 0.05, 6); sfx('clang', m.pos);
      bus.emit('hit', { target: m, damage: 0, point, dir: d, part, heavy: !!heavy, kill: false, blocked: true, byNpc });
      return res;
    }
    // blocks: a raised shield turns light blows; a heavy blow breaks the guard
    const fx = Math.sin(m.yaw), fz = Math.cos(m.yaw), frontal = fx * d.x + fz * d.z < -0.3;
    const guarding = (m.blockT > 0 || (m.beh.guard && m.aggro && !m.atk && m.stagT <= 0)) && !m.lost.armL && frontal;
    let dmg = amount;
    if (guarding) {
      fxBurst(FXG, point, 18, 6, 0xffd080, 0.35, 0.05, 8); sfx('clang', m.pos);
      if (!heavy) {
        dmg *= 0.12; m.kv.addScaledVector(d, 1.2 / m.scale);
        m.hp -= dmg; if (m.hp <= 1) m.hp = 1;
        bus.emit('hit', { target: m, damage: dmg, point, dir: d, part, heavy: false, kill: false, blocked: true, byNpc });
        m.aggro = true; if (m.state === 'idle' || m.state === 'wander') m.state = 'chase';
        return res;
      }
      dmg *= 0.6; m.blockT = 0; stagger(m, 0.9);
    }
    const finisher = !!heavy && m.staggered && m.hp < m.maxHp * 0.35 && !m.isBoss;
    dmg *= part === 'head' ? 1.5 : part === 'torso' ? 1 : 0.85;
    dmg *= 1 - (m.beh.armor || 0);
    if (m.beh.bone && has('rpg', 'weapon')) { const w = CT.rpg.weapon() || {}; if (w.style === 'mace') dmg *= 1.5; if (w.holy) dmg *= 1.25; }
    const hpBefore = m.hp;
    m.hp -= dmg;
    m.flash = 1; m.aggro = true; m.engaged = true;
    if (m.state === 'idle' || m.state === 'wander' || m.state === 'return' || m.state === 'patrol') { m.state = 'chase'; alertPack(m); }
    // knockback, flinch, stagger
    const mass = m.scale * m.scale * (m.isBoss ? 3 : 1);
    m.kv.addScaledVector(d, (heavy ? 4.5 : 1.6) / mass);
    const hyper = m.beh.hyper || 0;
    if (heavy && dmg > m.maxHp * (0.1 + hyper * 0.06) && !m.isBoss) stagger(m, 0.7 + rnd() * 0.4);
    else if (!hyper || (hyper === 1 && heavy)) { m.flinch = 0.25; if (m.atk && m.atkT < m.atk.wind && !hyper) endAttack(m, true); }
    else m.flinch = 0.12;
    // effects
    const sp = clamp(dmg / 30, 0.3, 2.2);
    if (m.beh.ghost) fxBurst(FXG, point, Math.round(20 * sp), 4, ECTO[(rnd() * 3) | 0], 1, 0.07, 0.5);
    else GORE.spray(point, V1.set(d.x, 0.35, d.z).normalize(), m.beh.bone ? sp * 0.3 : sp);
    if (m.beh.bone) fxBurst(FXS, point, Math.round(10 * sp), 5, BONES[(rnd() * 3) | 0], 1.4, 0.045, 14, 1.5);
    if (!m.beh.ghost) GORE.blade(clamp(0.1 + dmg / 150, 0.1, 0.3) * (m.beh.bone ? 0.4 : 1));
    if (heavy && !m.beh.ghost && has('gore', 'splat')) CT.gore.splat(m.pos.x + d.x * 0.8, m.pos.z + d.z * 0.8, 0.5 + sp * 0.4, Math.atan2(d.x, d.z));
    sfx(m.beh.bone ? 'bone' : 'flesh', m.pos);
    if (heavy && !m.beh.bone && !m.beh.ghost && dmg > 25) sfx('bone', m.pos);
    if (rnd() < 0.35) voice(m, 2);
    // dismemberment
    const killed = m.hp <= 0, sevK = m.cfg.sever;
    const limb = part !== 'torso' && m.def.sev[part];
    let gibbed = false;
    if (killed) {
      const over = dmg - hpBefore;
      if (sevK > 0 && heavy && (over > hpBefore * 2 || over > m.maxHp * 0.6 || (finisher && rnd() < 0.5))) { gibbed = true; }
      else if (sevK > 0 && (finisher || (limb && (heavy || over > m.maxHp * 0.3 || rnd() < sevK)))) {
        const p = finisher ? 'head' : part;
        res.severed = sever(m, m.def.sev[p] ? p : part, d, point);
      } else if (sevK > 0 && heavy && part === 'torso' && rnd() < sevK) {   // the blade carries through
        const opts = ['head', 'armL', 'armR'], p = opts[(rnd() * 3) | 0];
        res.severed = sever(m, p, d, point);
      }
    } else if (sevK > 0 && limb && heavy && part !== 'head' && rnd() < Math.min(1, sevK * 1.6 + dmg / m.maxHp)) {
      res.severed = sever(m, part, d, point);
    } else if (sevK > 0 && part === 'head' && heavy && (m.hp < m.maxHp * 0.4 || rnd() < sevK * 0.35)) {
      res.severed = sever(m, 'head', d, point);
    }
    if (m.lost.head && !killed) { m.hp = 0; }
    if (m.lost.legL && m.lost.legR && m.def.rig === 'quad') m.speed *= 0.5;
    const dead = m.hp <= 0;
    bus.emit('hit', { target: m, damage: dmg, point, dir: d, part, heavy: !!heavy, kill: dead, byNpc });
    if (dead) {
      let overkill = Math.max(0, dmg - Math.max(0, hpBefore));
      if (finisher) { overkill = Math.max(overkill, 51 + overkill); if (core.hitStop) core.hitStop(0.12); if (core.shake) core.shake(0.6, 0.3); }
      if (gibbed) { if (!finisher && core.hitStop) core.hitStop(0.08); gib(m, d, point); res.severed = true; }
      die(m, d, point, overkill, finisher);
      res.killed = true;
    }
    return res;
  }
  function stagger(m, sec) {
    if (!m || m.dead) return;
    if (m.isBoss && !m.phase2Pending) sec = Math.min(sec || 0.6, 0.6);
    m.stagT = Math.max(m.stagT, sec || 1.0); m.staggered = true;
    if (m.atk) endAttack(m, true);
    m.blockT = 0;
  }
  function die(m, d, point, overkill, finisher) {
    if (m.dead) return;
    m.dead = true; m.hp = 0; m.state = 'dead'; m.deathT = 0; m.atk = null; m.staggered = false; m.bleedPool = 0;
    if (!m.gibbed) startFall(m, d);
    const g = ground(m.pos.x, m.pos.z);
    if (!m.beh.ghost) GORE.pool(m.pos.x, m.pos.z, (m.beh.bone ? 0.7 : 1.3) * m.scale);
    if (m.beh.ghost) { fxBurst(FXG, V1.set(m.pos.x, g + 1.1 * m.scale, m.pos.z), 70, 5, ECTO[0], 1.6, 0.07, -0.5); fxBurst(FXG, V1, 40, 7, ECTO[2], 1, 0.045, 0); }
    if (m.beh.bone && !m.gibbed) { GORE.gib(V1.set(m.pos.x, g + 0.9 * m.scale, m.pos.z), m.beh.gib, Math.round(6 * m.scale)); }
    voice(m, 3, true);
    if (m.isBoss) {                                                                // the king loses his crowned head
      api._victoryT = 5.5;
      if (!m.lost.head) setTimeout(() => { if (m.alive && m.root.visible) sever(m, 'head', V1.set(Math.sin(m.yaw), 0, Math.cos(m.yaw)), null, 0.5); }, 1600);
      if (core.shake) core.shake(1, 1.2);
      fxBurst(FXG, V1.set(m.pos.x, g + 3, m.pos.z), 120, 9, 0xff4010, 1.8, 0.14, -1);
    }
    const xp = Math.round(m.cfg.xp * (m.isChief || m.isAlpha || m.isGuardian ? 3 : 1));
    const ev = { monster: m, type: m.type, point: point.clone(), dir: d.clone(), overkill, xp, finisher: !!finisher };
    if (m.isChief) ev.chief = true; if (m.isAlpha) ev.alpha = true; if (m.isGuardian) ev.guardian = true; if (m.isBoss) ev.boss = true;
    if (m.name) ev.name = m.name;
    if (!(m.pHitT != null && playTime - m.pHitT < 10)) ev.byNpc = true;         // no player blow in the last 10 s: not the player's kill
    if (m.spec && m.garrison) garrisonDeath(m);
    bus.emit('kill', ev);
  }

  // ── Voices ─────────────────────────────────────────────────────────────────
  function voice(m, kind, force) {
    if (!force && m.voiceT > 0) return;
    const n = m.beh.voice[kind]; if (!n) return;
    m.voiceT = 1.8 + rnd() * 2;
    sfx(n, m.pos);
  }

  // ── AI ─────────────────────────────────────────────────────────────────────
  function notice(m) {
    if (m.aggro) return;
    m.aggro = true; m.state = 'notice'; m.stateT = 0.45 + rnd() * 0.3; m.engaged = true;
    voice(m, 0, true);
    if (m.type === 'orc' || m.type === 'troll') startAttack(m, 'roar');
    alertPack(m);
  }
  function alertPack(m) {
    for (const o of list) {
      if (o === m || o.dead || o.aggro || o.state === 'dormant') continue;
      const same = (m.pack && o.pack === m.pack) || (m.garrison && o.garrison === m.garrison);
      if (!same) continue;
      if (Math.hypot(o.pos.x - m.pos.x, o.pos.z - m.pos.z) < 40) { o.aggro = true; o.state = 'chase'; o.stateT = rnd() * 0.4; }
    }
  }
  function wake(m) {
    if (m.state !== 'dormant') return;
    m.state = 'waking'; m.stateT = 0; m.aggro = true; m.engaged = true;
    voice(m, 0, true); if (core.shake) core.shake(0.5, 1.5);
    alertPack(m);
  }
  function attackers() { let n = 0; for (const o of list) if (o.atk && !o.dead && o.atk !== ATK.roar) n++; return n; }
  function startAttack(m, name) {
    let A = ATK[name];
    if (A.seq) { m.combo = A.seq.slice(1); A = ATK[A.seq[0]]; }
    m.atk = A; m.atkT = 0; m.hitDone = false; m.whoosh = false; m.state = 'attack';
    m.atkSpd = (m.phase2 ? 1.3 : 1) * (m.isBoss ? 0.85 : 1) * (m.type === 'troll' ? 0.9 : 1);
    if (api._log) api._log.push(m.type + ':' + (Object.keys(ATK).find(k => ATK[k] === A)));
    m.glinted = A === ATK.roar;
    if (A !== ATK.roar) voice(m, 1);
  }
  function endAttack(m, interrupted) {
    const A = m.atk; m.atk = null;
    if (!interrupted && m.combo && m.combo.length) { startAttack(m, m.combo.shift()); return; }
    m.combo = null;
    m.atkCd = (A && A.cd ? A.cd : 1) * (0.7 + rnd() * 0.6) * (m.phase2 ? 0.7 : 1);
    if (!m.dead && m.state === 'attack') m.state = 'chase';
  }
  function glint(m) {
    const tp = m.def.tip, b = tp && m.B[tp[0]]; if (!b || !b.parent) return;
    m.root.updateMatrixWorld(true);
    V1.set(tp[1], tp[2], tp[3]); b.localToWorld(V1);
    emit(FXG, V1.x, V1.y, V1.z, 0, 0.3, 0, 0.22, 0.1 * Math.sqrt(m.scale), m.type === 'wraith' ? 0x9fe8ff : m.beh.bone ? 0xff5020 : 0xfff0c0, 0, 0);
  }
  function chooseAttack(m, dist) {
    const opts = (m.phase2 && m.beh.atks2) || m.beh.atks;
    if (m.disarmed && m.def.rig === 'biped') return dist < m.cfg.reach * 0.9 + m.rad ? 'shove' : null;
    for (let tries = 0; tries < 4; tries++) {
      const n = opts[(rnd() * opts.length) | 0], A = ATK[n];
      const reach = m.cfg.reach * (A.range || A.reach || 1) + m.rad * 0.5;
      if (A.min && dist < A.min) continue;
      if (A.max && dist > A.max) continue;
      if (!A.max && !A.wave && dist > reach) continue;
      if (A.wave && (dist > 24 || dist < 4)) continue;
      return n;
    }
    return null;
  }
  function resolveHit(m, A, P, soft) {
    if (A.noHit || !CT.player) { if (A.shake && core.shake) core.shake(A.shake, 0.3); return true; }
    const dmg = m.cfg.dmg * (A.dmg || 1) * m.dmgK;
    const fx = Math.sin(m.yaw), fz = Math.cos(m.yaw);
    if (A.wave) { startWave(m, dmg); return true; }
    if (A.aoe) {
      const cx = m.pos.x + fx * A.aoeFwd * m.scale, cz = m.pos.z + fz * A.aoeFwd * m.scale;
      fxDustRing(cx, cz, A.aoe * m.scale * 0.5, Math.round(18 + 10 * m.scale));
      if (A.shake && core.shake) { const pd = Math.hypot(P.x - cx, P.z - cz); core.shake(A.shake * clamp(1.4 - pd / 20, 0, 1), 0.5); }
      sfx(m.scale > 2 ? 'troll_slam' : 'flesh', V1.set(cx, m.pos.y, cz));
      if (m.isBoss && m.phase2) for (let i = 0; i < 24; i++) { const a = i / 24 * TAU; emit(FXG, cx + Math.cos(a) * 2, ground(cx, cz) + 0.3, cz + Math.sin(a) * 2, Math.cos(a) * 9, 1 + rnd() * 2, Math.sin(a) * 9, 0.6, 0.35, 0xff5010, 0, 1.5); }
      const r = A.aoe * m.scale / (m.cfg.size > 2 ? 1.6 : 1) + 0.6;
      if (Math.hypot(P.x - cx, P.z - cz) < r && P.y - ground(P.x, P.z) < 1.2 && playerAlive()) hurtPlayer(m, dmg, cx, cz);
      return true;
    }
    if (A.shake && core.shake && !soft) core.shake(A.shake, 0.25);
    const dx = P.x - m.pos.x, dz = P.z - m.pos.z, dist = Math.hypot(dx, dz);
    const reach = m.cfg.reach * (A.reach || 1) + 0.45;
    const ang = Math.acos(clamp((dx * fx + dz * fz) / Math.max(0.01, dist), -1, 1));
    if (dist <= reach && ang <= A.arc && Math.abs(P.y - m.pos.y + m.hover) < 2.5 * Math.max(1, m.scale * 0.8) && playerAlive()) { hurtPlayer(m, dmg, m.pos.x, m.pos.z); return true; }
    return !soft;
  }
  function hurtPlayer(m, dmg, fromX, fromZ) {
    const P = playerPos();
    const dir = new T.Vector3(P.x - fromX, 0.2, P.z - fromZ); if (dir.lengthSq() < 1e-4) dir.set(0, 0.2, 1); dir.normalize();
    if (has('player', 'hurt')) CT.player.hurt(Math.round(dmg), dir, m);
  }

  // ── Fire waves (the Bone King, phase 2) ────────────────────────────────────
  const WAVES = [];
  function startWave(m, dmg) {
    let w = WAVES.find(x => !x.on);
    if (!w) { w = { mesh: new T.Mesh(GP.wave, MAT.wave) }; w.mesh.renderOrder = 7; scene.add(w.mesh); WAVES.push(w); }
    w.on = true; w.x = m.pos.x; w.z = m.pos.z; w.r = 1.5; w.hit = false; w.dmg = dmg; w.src = m;
    w.mesh.visible = true;
    if (core.shake) core.shake(0.7, 0.6);
    if (has('sky', 'flash')) CT.sky.flash(0xff3010, 0.3);
    sfx('troll_slam', m.pos);
  }
  function updWaves(dt, P) {
    for (const w of WAVES) {
      if (!w.on) continue;
      w.r += 13 * dt;
      const y = ground(w.x, w.z);
      w.mesh.position.set(w.x, y + 0.25, w.z); w.mesh.scale.set(w.r, 1, w.r);
      MAT.wave.opacity = 0.9;
      for (let i = 0; i < 10; i++) {
        const a = rnd() * TAU, x = w.x + Math.cos(a) * w.r, z = w.z + Math.sin(a) * w.r;
        emit(FXG, x, y + 0.1, z, Math.cos(a) * 2, 2 + rnd() * 4, Math.sin(a) * 2, 0.4 + rnd() * 0.4, 0.2 + rnd() * 0.25, rnd() < 0.5 ? 0xff4010 : 0xffa030, -2, 1);
      }
      const pd = Math.hypot(P.x - w.x, P.z - w.z);
      if (!w.hit && Math.abs(pd - w.r) < 1.1 && P.y - ground(P.x, P.z) < 0.6 && playerAlive()) { w.hit = true; hurtPlayer(w.src, w.dmg, w.x, w.z); }
      if (w.r > 30) { w.on = false; w.mesh.visible = false; }
    }
  }

  // ── Per-monster update ─────────────────────────────────────────────────────
  function turnTo(m, target, rate, dt) { m.yaw += clamp(wrap(target - m.yaw), -rate * dt, rate * dt); }
  function updateMonster(m, dt, t, P, pAlive) {
    const b = m.beh;
    m.voiceT -= dt; m.atkCd -= dt; m.flinch = Math.max(0, m.flinch - dt); m.blockT -= dt; m.dodgeT -= dt;
    if (m.stagT > 0) { m.stagT -= dt; if (m.stagT <= 0) m.staggeredGrace = 0.3; }
    else if (m.staggered && m.stagT <= 0) {
      if (m.staggeredGrace == null) { m.stagT = 1.0; }                            // set from outside (perfect block)
      else if ((m.staggeredGrace -= dt) <= 0) { m.staggered = false; m.staggeredGrace = null; }
    }
    const dx = P.x - m.pos.x, dz = P.z - m.pos.z, dist = Math.hypot(dx, dz), toP = Math.atan2(dx, dz);
    let want = 0, wantYaw = m.yaw, moveYaw = m.yaw;
    const run = m.speed;
    // rising from the ground (summons)
    if (m.rise > 0) {
      m.rise -= dt; const k = 1 - Math.max(0, m.rise) / 1.2;
      m.root.position.y = ground(m.pos.x, m.pos.z) - 2 * m.scale * (1 - eOut(k));
      if ((m.fxT = (m.fxT || 0) - dt) < 0) { m.fxT = 0.1; fxDustRing(m.pos.x, m.pos.z, 1.2, 4); }
      animate(m, dt, t, 0); m.root.rotation.y = m.yaw; return;
    }
    // perception
    if (!m.aggro && pAlive && m.state !== 'dormant' && (m.percT -= dt) < 0) {
      m.percT = 0.25;
      const torch = core.torchLight && core.torchLight.intensity > 0.2;
      const sight = isNight() ? (torch ? 35 : 18) : 30;
      const inp = core.input || {}, sprint = inp.sprint && Math.abs(inp.moveX) + Math.abs(inp.moveY) > 0.1;
      const ang = Math.abs(wrap(toP - m.yaw));
      if ((dist < sight && ang < 0.96) || dist < (sprint ? 20 : 8)) notice(m);
    }
    if (m.state === 'dormant') {
      if (pAlive && dist < 26) wake(m);
      animate(m, dt, t, 0); m.root.rotation.y = m.yaw; placeRoot(m); return;
    }
    if (m.state === 'waking') {
      m.stateT += dt;
      if (m.stateT > 2.2) { m.state = 'chase'; startAttack(m, 'roar'); if (core.shake) core.shake(0.8, 1.2); }
      animate(m, dt, t, 0); m.root.rotation.y = m.yaw; placeRoot(m); return;
    }
    // boss phase 2: rise, fire, summon
    if (m.isBoss && !m.phase2 && m.hp < m.maxHp * 0.5) {
      m.phase2 = true; m.rise = 0; m.state = 'rising'; m.stateT = 0; m.atk = null; m.combo = null; m.stagT = 0;
      voice(m, 0, true); if (core.shake) core.shake(1, 2.5); if (has('sky', 'flash')) CT.sky.flash(0xff2010, 0.6);
    }
    if (m.state === 'rising') {
      m.stateT += dt;
      const k = m.stateT;
      m.air = Math.sin(clamp(k / 2.6, 0, 1) * PI) * 3.5;
      zeroPose(m); m.hipDrop = 0;
      add(m, 'spine', -0.4, 0, 0); add(m, 'head', -0.7, 0, 0); add(m, 'shL', -2.6, 0, 1.0); add(m, 'shR', -2.6, 0, -1.0); add(m, 'knL', 0.6, 0, 0); add(m, 'knR', 0.4, 0, 0); add(m, 'cape', 0.9 + Math.sin(t * 8) * 0.2, 0, 0);
      applyPose(m);
      if ((m.fxT = (m.fxT || 0) - dt) < 0) { m.fxT = 0.03; V1.set(m.pos.x, m.pos.y + m.air + 2.5, m.pos.z); fxBurst(FXG, V1, 8, 6, rnd() < 0.5 ? 0xff3010 : 0xffa030, 0.8, 0.2, -2); }
      if (k > 1.3 && !m.summoned) {
        m.summoned = true;
        for (let i = 0; i < 3; i++) {
          const a = m.yaw + (i - 1) * 1.1 + PI * 0.15, r = 9;
          spawn(i === 1 ? 'ghoul' : 'boneKnight', m.pos.x + Math.sin(a) * r, m.pos.z + Math.cos(a) * r, { aggro: true, rise: true, garrison: m.garrison, yaw: toP });
        }
        startWave(m, m.cfg.dmg * 0.6);
      }
      if (k > 2.6) { m.state = 'chase'; m.air = 0; if (core.shake) core.shake(1, 0.6); fxDustRing(m.pos.x, m.pos.z, 6, 60); sfx('troll_slam', m.pos); }
      m.root.rotation.y = m.yaw; placeRoot(m); return;
    }
    if (!pAlive && m.aggro) { m.aggro = false; m.state = 'return'; m.atk = null; }
    // leash
    const hx = m.home.x - m.pos.x, hz = m.home.z - m.pos.z, homeD = Math.hypot(hx, hz);
    if (m.aggro && (dist > (m.garrison ? 55 : 60) || (m.garrison && homeD > 55 && !m.isBoss)) && m.state !== 'flee') { m.aggro = false; m.state = 'return'; m.atk = null; }
    if (m.isBoss && homeD > 45 && m.aggro && !m.atk) { m.aggro = false; m.state = 'return'; }
    // flee at low hp
    if (b.flee && m.aggro && !m.fled && m.hp < m.maxHp * 0.25 && !m.atk) { m.fled = true; if (rnd() < b.flee) { m.state = 'flee'; m.fleeT = 4 + rnd() * 3; voice(m, 2, true); } }

    if (m.stagT > 0) { want = 0; }
    else if (m.atk) {
      const A = m.atk; m.atkT += dt * m.atkSpd;
      const w = A.wind, s = A.strike;
      if (!m.glinted && m.atkT > w * 0.7) { m.glinted = true; glint(m); }
      if (m.atkT < w) { turnTo(m, toP, b.turn * (A.charge ? 1.2 : 0.8), dt); if (A === ATK.roar) turnTo(m, toP, b.turn, dt); }
      else if (m.atkT < w + s) {
        const k = (m.atkT - w) / s;
        if (A.charge) {
          want = run * A.charge; turnTo(m, toP, 0.9, dt); moveYaw = m.yaw;
          if ((m.fxT = (m.fxT || 0) - dt) < 0) { m.fxT = 0.08; fxDustRing(m.pos.x, m.pos.z, 0.5, 3); }
          if (!m.hitDone && dist < 1.3 + m.rad && pAlive) { m.hitDone = true; hurtPlayer(m, m.cfg.dmg * A.dmg * m.dmgK, m.pos.x, m.pos.z); if (core.shake) core.shake(0.7, 0.3); sfx('flesh', m.pos); m.atkT = w + s; }
        } else {
          if (A.lunge && dist > m.rad + 0.7) { want = A.lunge / (s / m.atkSpd); moveYaw = m.yaw; m.snap = true; }
          if (A.leap) m.air = Math.sin(k * PI) * A.leap;
          if (!m.whoosh && A !== ATK.roar) { m.whoosh = true; sfx(m.scale > 1.8 ? 'swing_heavy' : 'whoosh', m.pos); }
          if (!m.hitDone && k >= 0.42) { if (resolveHit(m, A, P, A.lunge > 1.1 && k < 0.97)) m.hitDone = true; }
        }
      } else { m.air = m.hover ? m.air : 0; if (m.atkT >= w + s + A.rec) endAttack(m); }
      wantYaw = m.yaw;
    } else if (m.dodgeT > 0) {
      want = run * 1.3; moveYaw = m.dodgeYaw; wantYaw = toP;
    } else {
      switch (m.state) {
        case 'idle': case 'wander': case 'patrol': {
          m.stateT -= dt;
          if (m.state === 'idle' && m.stateT < 0) { m.state = 'wander'; m.stateT = 3 + rnd() * 5; const a = rnd() * TAU, r = rnd() * (m.garrison ? 10 : 14); m.wx = m.home.x + Math.sin(a) * r; m.wz = m.home.z + Math.cos(a) * r; }
          else if (m.state !== 'idle') {
            const wx = m.wx - m.pos.x, wz = m.wz - m.pos.z;
            if (Math.hypot(wx, wz) < 1 || m.stateT < 0) { m.state = 'idle'; m.stateT = 2 + rnd() * 4; }
            else { want = run * (m.def.rig === 'wraith' ? 0.3 : 0.28); moveYaw = wantYaw = Math.atan2(wx, wz); }
          }
          break;
        }
        case 'notice': m.stateT -= dt; wantYaw = toP; if (m.stateT < 0) m.state = 'chase'; break;
        case 'return': {
          if (homeD < 2) { m.state = 'idle'; m.stateT = 2; m.hp = Math.min(m.maxHp, m.hp + m.maxHp * 0.5); }
          else { want = run * 0.6; moveYaw = wantYaw = Math.atan2(hx, hz); }
          m.hp = Math.min(m.maxHp, m.hp + m.maxHp * 0.05 * dt);
          break;
        }
        case 'flee': {
          m.fleeT -= dt; want = run * 0.95; moveYaw = wantYaw = toP + PI;
          if (m.fleeT < 0) { if (dist > 30) { m.aggro = false; m.state = 'return'; } else m.state = 'chase'; }
          break;
        }
        case 'circle': {
          m.stateT -= dt;
          const R = b.circle * (m.def.rig === 'quad' ? 1 : 1) + m.rad;
          m.circleA += m.circleDir * dt * (run * 0.35) / R;
          const tx = P.x + Math.sin(m.circleA) * R, tz = P.z + Math.cos(m.circleA) * R, ex = tx - m.pos.x, ez = tz - m.pos.z, ed = Math.hypot(ex, ez);
          want = ed > 0.4 ? Math.min(run * 0.55, ed * 2) : 0; moveYaw = Math.atan2(ex, ez); wantYaw = toP;
          if (m.stateT < 0 && m.atkCd <= 0 && attackers() < (m.type === 'wolf' ? 2 : 2)) { m.state = 'chase'; m.stateT = 3; }
          if (rnd() < dt * 0.3) m.circleDir *= -1;
          break;
        }
        case 'chase': default: {
          m.state = 'chase';
          wantYaw = moveYaw = toP;
          const reach = m.cfg.reach + m.rad * 0.5;
          const busy = attackers() >= (m.type === 'wolf' ? 2 : 3) && !m.isBoss && m.type !== 'troll';
          if (m.atkCd <= 0 && !busy) { const n = chooseAttack(m, dist); if (n) { startAttack(m, n); break; } }
          if (b.circle && dist < b.circle + 2.5 && (busy || m.atkCd > 0.25) && !m.crawl) {
            m.state = 'circle'; m.stateT = 1 + rnd() * 2; m.circleA = Math.atan2(m.pos.x - P.x, m.pos.z - P.z);
            if (m.type === 'wolf') m.circleA += (m.id % 5 - 2) * 0.7;                // pack flanking slots
            break;
          }
          if (dist > reach * 0.75) want = run * (dist > 10 ? 1 : 0.75);
          break;
        }
      }
    }
    // steering: turn, separation, obstacles
    turnTo(m, wantYaw, b.turn * (m.crawl ? 0.4 : 1), dt);
    let vx = Math.sin(moveYaw) * want, vz = Math.cos(moveYaw) * want;
    if (m.avoidT > 0) { m.avoidT -= dt; const a = moveYaw + m.avoid * 1.2; vx = Math.sin(a) * want; vz = Math.cos(a) * want; }
    for (const o of list) {
      if (o === m || o.dead) continue;
      const ox = m.pos.x - o.pos.x, oz = m.pos.z - o.pos.z, d2 = ox * ox + oz * oz, rr = m.rad + o.rad + 0.3;
      if (d2 < rr * rr && d2 > 1e-5) { const d = Math.sqrt(d2), k = (rr - d) / rr * 4; vx += ox / d * k; vz += oz / d * k; }
    }
    const acc = 1 - Math.exp(-8 * dt);
    if (m.snap) { m.vel.x = vx; m.vel.z = vz; m.snap = false; } else { m.vel.x += (vx - m.vel.x) * acc; m.vel.z += (vz - m.vel.z) * acc; }
    m.kv.multiplyScalar(Math.exp(-6 * dt));
    const sx = m.pos.x, sz = m.pos.z;
    m.pos.x += (m.vel.x + m.kv.x) * dt; m.pos.z += (m.vel.z + m.kv.z) * dt;
    if (pAlive && dist < 60) {                                                    // never stand inside the player
      const px = m.pos.x - P.x, pz = m.pos.z - P.z, pd = Math.hypot(px, pz), min = Math.max(m.rad + 0.45, (m.cfg.size || 1) * 0.75 + 0.6); // big bodies keep the camera outside their mesh
      if (pd < min && pd > 1e-4) { m.pos.x = P.x + px / pd * min; m.pos.z = P.z + pz / pd * min; }
    }
    if (has('world', 'collide') && (want > 0.1 || m.kv.lengthSq() > 0.01)) {
      const ix = m.pos.x, iz = m.pos.z;
      const r = CT.world.collide(m.pos, m.rad);
      if (r && r !== m.pos) { m.pos.x = r.x; m.pos.z = r.z; }
      const push = Math.hypot(m.pos.x - ix, m.pos.z - iz);
      if (push > want * dt * 0.5 && want > 0.5 && m.avoidT <= 0) { m.avoid = ((ix - m.pos.x) * Math.cos(moveYaw) - (iz - m.pos.z) * Math.sin(moveYaw)) > 0 ? -1 : 1; m.avoidT = 0.7; }
    }
    const spd = Math.hypot(m.pos.x - sx, m.pos.z - sz) / Math.max(dt, 1e-4);
    animate(m, dt, t, dt > 0 ? spd : 0);
    m.root.rotation.y = m.yaw; m.root.rotation.x = 0; m.root.rotation.z = 0;
    placeRoot(m);
    updBleeds(m, dt);
    // footfalls of the giants
    if (m.scale > 2 && spd > 0.5 && dist < 30) { const f = Math.sin(m.ph); if (m.lastF != null && (m.lastF < 0) !== (f < 0)) { if (core.shake) core.shake(0.18 * m.scale / 2.6 * (1 - dist / 30), 0.15); fxDustRing(m.pos.x, m.pos.z, 0.6, 3); } m.lastF = f; }
  }
  function placeRoot(m) {
    const g = ground(m.pos.x, m.pos.z);
    m.root.position.y = g + m.hover + m.air;
    m.shadow.position.set(m.pos.x, g + 0.05, m.pos.z); m.shadow.visible = true;
    m.mat.emissive.setRGB(m.flash > 0 ? m.flash * 0.9 : -m.flash * 0.2, m.flash > 0 ? m.flash * 0.1 : -m.flash * 0.6, m.flash > 0 ? m.flash * 0.05 : -m.flash * 1.0);
  }

  // ── Population + garrisons ─────────────────────────────────────────────────
  const POI = id => C.POIS.find(p => p.id === id);
  const BIOME = {
    coast:  { d: 3, n: 5, dayT: [['bandit', 3], ['wolf', 1]], nightT: [['ghoul', 3], ['bandit', 1]] },
    meadow: { d: 8, n: 10, dayT: [['bandit', 6], ['wolf', 1.2]], nightT: [['bandit', 3], ['wolf', 2], ['ghoul', 3]] },
    forest: { d: 10, n: 13, dayT: [['wolf', 7], ['bandit', 3]], nightT: [['wolf', 6], ['ghoul', 2], ['bandit', 1]] },
    swamp:  { d: 7, n: 12, dayT: [['ghoul', 3], ['bandit', 1]], nightT: [['ghoul', 6], ['wraith', 4]] },
    hills:  { d: 9, n: 11, dayT: [['orc', 6], ['troll', 1.2], ['bandit', 2]], nightT: [['orc', 5], ['troll', 1.5], ['ghoul', 2]] },
    snow:   { d: 7, n: 10, dayT: [['troll', 3], ['wolf', 2], ['boneKnight', 2]], nightT: [['troll', 3], ['boneKnight', 3], ['wraith', 1]] },
    citadel:{ d: 5, n: 7, dayT: [['boneKnight', 1]], nightT: [['boneKnight', 2], ['wraith', 1]] },
  };
  const GROUP = { wolf: [3, 5], ghoul: [2, 4], bandit: [2, 3], orc: [1, 3], troll: [1, 1], wraith: [1, 2], boneKnight: [2, 3] };
  const GARRISONS = [
    { poi: 'camp', members: [['bandit', 7], ['bandit', 1, { isChief: true }]], r: [6, 26] },
    { poi: 'wolfden', members: [['wolf', 4], ['wolf', 1, { isAlpha: true }]], r: [3, 14] },
    { poi: 'ruins', members: [['troll', 1, { isGuardian: true }]], r: [0, 5] },
    { poi: 'citadel', members: [['boneKnight', 6], ['boneKing', 1, { boss: true }]], r: [8, 20] },
  ];
  const GAR_RESPAWN = 20 * 60;       // seconds of play before a cleared garrison returns
  let packId = 1, popT = 0;
  function initGarrisons() {
    for (const g of GARRISONS) {
      g.p = POI(g.poi); g.active = false; g.left = []; g.alive = []; g.cleared = -1; g.uniques = {};
      for (const [type, n, o] of g.members) for (let i = 0; i < n; i++) g.left.push({ type, o: o || {}, i });
    }
  }
  function refill(g) {
    g.left = [];
    for (const [type, n, o] of g.members) for (let i = 0; i < n; i++) { const key = o && (o.isChief || o.isAlpha || o.isGuardian || o.boss); if (key && g.uniques[type]) continue; g.left.push({ type, o: o || {}, i }); }
  }
  function garrisonDeath(m) {
    const g = m.garrison; if (!g || !g.left) return;
    const i = g.left.indexOf(m.spec); if (i >= 0) g.left.splice(i, 1);
    if (m.isChief || m.isAlpha || m.isGuardian || m.isBoss) g.uniques[m.type] = true;
    if (!g.left.length) g.cleared = playTime;
  }
  function garrisons(P) {
    for (const g of GARRISONS) {
      if (!g.p) continue;
      const d = Math.hypot(P.x - g.p.x, P.z - g.p.z);
      if (!g.active && d < 230) {
        if (!g.left.length && g.cleared >= 0 && playTime - g.cleared > GAR_RESPAWN) { refill(g); g.cleared = -1; }
        g.active = true; g.alive = [];
        // unique foes killed in a saved game stay dead (rpg flags survive reloads)
        const F = (CT.rpg && CT.rpg.flags) || {};
        g.left = g.left.filter(s => !((s.o.isChief && F.graskDead) || (s.o.isAlpha && F.alphaDead) || (s.o.isGuardian && F.guardianDead) || (s.o.boss && F.boneKingDead)));
        const pack = packId++;
        g.left.forEach((s, k) => {
          let x, z, yaw;
          if (g.poi === 'citadel') {
            if (s.type === 'boneKing') { x = g.p.x; z = g.p.z - 9; yaw = 0; }
            else { const row = s.i < 3 ? 0 : 1, col = s.i % 3 - 1; x = g.p.x + col * 7 + (row ? 3.5 : 0); z = g.p.z + 6 + row * 8; yaw = 0; }
          } else {
            const a = k / g.left.length * TAU + rnd() * 0.5, r = s.o.isChief ? 5 : g.r[0] + rnd() * (g.r[1] - g.r[0]);
            x = g.p.x + Math.sin(a) * r; z = g.p.z + Math.cos(a) * r;
          }
          const m = spawn(s.type, x, z, Object.assign({ garrison: g, spec: s, pack, yaw }, s.o));
          if (m) g.alive.push(m);
        });
      } else if (g.active && d > 330) {
        g.active = false;
        for (const m of g.alive) if (!m.dead && list.indexOf(m) >= 0) removeMonster(m);
        g.alive = [];
      }
    }
  }
  function pick(table) {
    let s = 0; for (const e of table) s += e[1];
    let r = rnd() * s; for (const e of table) { if ((r -= e[1]) <= 0) return e[0]; }
    return table.length ? table[0][0] : null;
  }
  function blocked(x, z) {
    for (const p of C.POIS) if ((p.type === 'village' || p.type === 'lodge') && Math.hypot(x - p.x, z - p.z) < p.radius + 25) return true;
    if (playTime < 60 && Math.hypot(x - C.START.x, z - C.START.z) < 60) return true;
    if (Math.abs(x) > C.ISLAND - 60 || Math.abs(z) > C.ISLAND - 60) return true;
    if (has('world', 'waterAt') && CT.world.waterAt(x, z) > 0.3) return true;
    return false;
  }
  function populate(P) {
    for (let i = list.length - 1; i >= 0; i--) { const m = list[i]; if (!m.garrison && !m.dead && Math.hypot(m.pos.x - P.x, m.pos.z - P.z) > 190) removeMonster(m); }
    garrisons(P);
    const cap = core.quality === 'low' ? 16 : 30;
    let alive = 0, roam = 0;
    for (const m of list) if (!m.dead) { alive++; if (!m.garrison) roam++; }
    if (alive >= cap) return;
    if (rnd() < 0.5) return;                                                     // pace the arrivals (one check per 2 s)
    const night = isNight(), bio = has('world', 'biomeAt') ? CT.world.biomeAt(P.x, P.z) : 'meadow';
    const B = BIOME[bio] || BIOME.meadow;
    const target = night ? B.n * (bloodmoon() ? 2 : 1) : B.d;
    if (roam >= target) return;
    const yaw = playerYaw();
    for (let tries = 0; tries < 6; tries++) {
      const ahead = rnd() < 0.55;                                               // over half spawn ahead, in view, far enough to see them coming
      const a = ahead ? yaw + PI + (rnd() - 0.5) * 1.3 : yaw + (rnd() - 0.5) * PI * 1.2, dist = ahead ? 70 + rnd() * 50 : 45 + rnd() * 35;
      const x = P.x + Math.sin(a) * dist, z = P.z + Math.cos(a) * dist;
      if (blocked(x, z)) continue;
      const sb = has('world', 'biomeAt') ? CT.world.biomeAt(x, z) : bio, SB = BIOME[sb] || B;
      let tbl = night ? SB.nightT : SB.dayT;
      if (sb === 'snow') { const pass = POI('pass'); if (pass && Math.hypot(x - pass.x, z - pass.z) > 320) tbl = tbl.filter(e => e[0] !== 'boneKnight'); }
      const type = pick(tbl); if (!type) return;
      const [lo, hi] = GROUP[type];
      const n = Math.min(cap - alive, lo + ((rnd() * (hi - lo + 1)) | 0));
      const pack = packId++;
      for (let i = 0; i < n; i++) {
        const ox = x + (rnd() - 0.5) * 7, oz = z + (rnd() - 0.5) * 7;
        spawn(type, ox, oz, { pack, alphaLook: type === 'wolf' && i === 0 && n >= 4 && rnd() < 0.35 });
      }
      if (type === 'wolf' && night) sfx('wolf_howl', V1.set(x, P.y, z));
      return;
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  function init(c) {
    core = c; scene = c.scene;
    shared();
    if (CT.humanoid && typeof CT.humanoid.prewarm === 'function') { try { CT.humanoid.prewarm(kitSpecs()); } catch (e) { console.warn('[monsters] prewarm', e); } }
    FXS = makePts(core.quality === 'low' ? 500 : 1100, false); FXG = makePts(core.quality === 'low' ? 400 : 900, true);
    scene.add(FXS.mesh); scene.add(FXG.mesh);
    initGarrisons();
    bus.on('victory', () => { api._victoryT = 0; });                             // someone else announced it first
    bus.on('swing', () => {                                                      // bandits read the swing: block or dodge
      if (!CT.player || !CT.player.pos) return;
      const P = playerPos();
      for (const m of list) {
        if (m.dead || m.type !== 'bandit' || m.atk || m.stagT > 0 || m.lost.armL) continue;
        const dx = m.pos.x - P.x, dz = m.pos.z - P.z, d = Math.hypot(dx, dz);
        if (d > 4.5 || !m.aggro) continue;
        const r = rnd();
        if (r < m.beh.block) { m.blockT = 0.75; m.yaw = Math.atan2(-dx, -dz); }
        else if (r < m.beh.block + m.beh.dodge) { m.dodgeT = 0.32; m.dodgeYaw = Math.atan2(dx, dz) + m.circleDir * 0.9; }
      }
    });
  }
  function update(dt, c) {
    if (!core) return;
    const t = core.time;
    if (core.state === 'PLAY') playTime += dt;
    const P = playerPos(), pAlive = playerAlive();
    if ((popT -= dt) < 0) { popT = 2; populate(P); }
    let combat = false;
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m.flash > 0) m.flash = Math.max(0, m.flash - dt * 5); else if (m.flash < 0) m.flash = Math.min(0, m.flash + dt * 2);
      if (m.dead) { updateDead(m, dt); if (m.alive) placeFlash(m); continue; }
      if (m.frozen) { if (m.dead) continue; animate(m, 0, m.frozen, 0); m.root.rotation.y = m.yaw; placeRoot(m); continue; }
      const d = Math.hypot(m.pos.x - P.x, m.pos.z - P.z);
      if (d > 140 && !m.aggro && m.state !== 'dormant') { m.root.visible = d < 200; continue; }  // far: freeze
      m.root.visible = true;
      updateMonster(m, dt, t, P, pAlive);
      if (m.aggro && d < 30 && m.state !== 'return' && m.state !== 'flee') combat = true;
    }
    api.inCombat = combat;
    if (api._victoryT > 0) { api._victoryT -= dt; if (api._victoryT <= 0) bus.emit('victory', {}); }
    updWaves(dt, P);
    updPts(FXS, dt); updPts(FXG, dt);
    updFallback(dt);
  }
  function placeFlash(m) { m.mat.emissive.setRGB(Math.max(0, m.flash) * 0.9, 0, 0); }
  function nearest(pos, maxDist) {
    let best = null, bd = maxDist == null ? 1e9 : maxDist;
    for (const m of list) { if (m.dead) continue; const d = m.pos.distanceTo(pos); if (d < bd) { bd = d; best = m; } }
    return best;
  }
  function bossInfo() {
    const P = playerPos(), cit = POI('citadel');
    for (const m of list) {
      if (!m.isBoss || m.dead) continue;
      const inArena = cit && Math.hypot(P.x - cit.x, P.z - cit.z) < 40;
      if (m.engaged || inArena) return { name: 'The Bone King', hp: Math.max(0, Math.round(m.hp)), maxHp: m.maxHp };
    }
    return null;
  }
  api._debug = { attack: (m, n) => startAttack(m, n), pose: (m, n, t) => { startAttack(m, n); m.atkT = t; m.frozen = 1; m.aggro = true; }, ATK, BEH, DEFS, WAVES, sever: (m, p) => sever(m, p, V4.set(0, 0, -1)), kill: m => damage(m, 9999, null, 'torso', false), stats: () => ({ fxs: FXS.n, fxg: FXG.n, chunks: FB.chunks.length, list: list.length }) };
})();
