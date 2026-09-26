// ─── NPCS: heroines, townsfolk, dialog trees, painted portraits ──────────────
(function () {
  const T = THREE, PI = Math.PI, TAU = PI * 2, bus = CT.bus, C = CT.config;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const poiOf = id => C.POIS.find(p => p.id === id);
  const npcs = CT.npcs = { list: [] };
  let core = null, group = null, localFlags = {}, time = 0, barkNext = 0, placedFromSpots = false, spotCheckT = 0;

  // ── Colour helpers ─────────────────────────────────────────────────────────
  function rgb(h) { h = h.replace('#', ''); const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function hex(r, g, b) { return '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join(''); }
  function mix(a, b, k) { const A = rgb(a), B = rgb(b); return hex(A[0] + (B[0] - A[0]) * k, A[1] + (B[1] - A[1]) * k, A[2] + (B[2] - A[2]) * k); }
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
  function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

  // ══════════════════════════════════════════════════════════════════════════
  // ── 3D: shared resources and toon materials with a rim light ──────────────
  // ══════════════════════════════════════════════════════════════════════════
  const RIM = { value: new T.Color(0xff9a50) }, RIMK = { value: 0.5 };
  let G = null;
  function shared() {
    if (G) return G;
    const grad = new T.DataTexture(new Uint8Array([60, 140, 255]), 3, 1, T.RedFormat);
    grad.minFilter = grad.magFilter = T.NearestFilter; grad.generateMipmaps = false; grad.needsUpdate = true;
    G = { grad, mats: {}, tap: {}, geo: {
      sph: new T.SphereGeometry(1, 10, 8), hemi: new T.SphereGeometry(1, 10, 6, 0, TAU, 0, PI / 2),
      cyl: new T.CylinderGeometry(1, 1, 1, 8), box: new T.BoxGeometry(1, 1, 1), cone: new T.ConeGeometry(1, 1, 8),
      tor: new T.TorusGeometry(1, 0.18, 5, 18), face: new T.SphereGeometry(1.025, 12, 10, PI / 2 - 0.85, 1.7, PI / 2 - 0.62, 1.24),
      disc: new T.CircleGeometry(1, 16),
    } };
    return G;
  }
  function rimify(m) {
    m.onBeforeCompile = sh => {
      sh.uniforms.uRim = RIM; sh.uniforms.uRimK = RIMK;
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 uRim; uniform float uRimK;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n{ float fr = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0); totalEmissiveRadiance += uRim * uRimK * pow(fr, 2.6); }');
    };
    m.customProgramCacheKey = () => 'ctRim';
    return m;
  }
  function mat(col, glow, side) {
    const key = col + '|' + (glow || 0) + '|' + (side ? 1 : 0);
    if (G.mats[key]) return G.mats[key];
    const m = rimify(new T.MeshToonMaterial({ color: col, gradientMap: G.grad }));
    m.emissive.set(col).multiplyScalar(0.05 + (glow || 0));
    if (side) m.side = T.DoubleSide;
    return (G.mats[key] = m);
  }
  function basic(col, op, add) {
    const key = 'b' + col + '|' + (op || 1) + '|' + (add ? 1 : 0);
    if (G.mats[key]) return G.mats[key];
    const m = new T.MeshBasicMaterial({ color: col, fog: true });
    if (op) { m.transparent = true; m.opacity = op; m.depthWrite = false; }
    if (add) m.blending = T.AdditiveBlending;
    return (G.mats[key] = m);
  }
  function taper(r0, r1, seg) { // unit-height cylinder, top radius r0, bottom r1
    const k = r0.toFixed(3) + ',' + r1.toFixed(3) + ',' + (seg || 8);
    return G.tap[k] || (G.tap[k] = new T.CylinderGeometry(r0, r1, 1, seg || 8));
  }
  function grp(parent, p) { const g = new T.Group(); if (p) g.position.set(p[0], p[1], p[2]); parent.add(g); return g; }
  function add(parent, geo, m, p, s, r) {
    const o = new T.Mesh(typeof geo === 'string' ? G.geo[geo] : geo, m);
    if (p) o.position.set(p[0], p[1], p[2]);
    if (s != null) { if (typeof s === 'number') o.scale.setScalar(s); else o.scale.set(s[0], s[1], s[2]); }
    if (r) o.rotation.set(r[0], r[1], r[2]);
    parent.add(o); return o;
  }
  // A segment from a to b (parent space), as a tapered cylinder.
  const _a = new T.Vector3(), _b = new T.Vector3(), UPV = new T.Vector3(0, 1, 0), DOWN = new T.Vector3(0, -1, 0);
  function seg(parent, a, b, r0, r1, m) {
    _a.set(a[0], a[1], a[2]); _b.set(b[0], b[1], b[2]);
    const d = _b.clone().sub(_a), len = d.length();
    const o = new T.Mesh(taper(r1, r0), m);
    o.position.copy(_a).addScaledVector(d, 0.5); o.scale.set(1, len, 1);
    o.quaternion.setFromUnitVectors(UPV, d.normalize()); parent.add(o); return o;
  }

  // ── Face textures (tiny pixel faces on the head) ───────────────────────────
  function faceTex(o) {
    const cv = canvas(32, 32), c = cv.getContext('2d');
    const P = (col, x, y, w, h) => { c.fillStyle = col; c.fillRect(x, y, w || 1, h || 1); };
    if (o.paint) o.paint.forEach(([x, y, w, h]) => P(o.paintCol || '#8a1410', x, y, w, h));
    const shade = mix(o.skin, '#2a1010', 0.35);
    P(shade, 16, 16, 1, 4); P(mix(o.skin, '#2a1010', 0.55), 15, 20, 3, 1);            // nose
    [[9, 1], [19, -1]].forEach(([x, s]) => {
      P(o.lash || '#140808', x, 13, 4, 1);                                           // lid
      P('#e8dccc', x, 14, 4, 1); P(o.eye || '#402010', x + 1, 14, 2, 1);             // eye
      if (o.fem) P(o.lash || '#140808', s > 0 ? x - 1 : x + 4, 12, 1, 1);
      if (o.brow) { P(o.brow, x - (s > 0 ? 1 : 0), 11 + (o.browTilt ? (s > 0 ? 0 : 0) : 0), 5, o.thick ? 2 : 1); if (o.browTilt) P(o.brow, s > 0 ? x + 3 : x, 12, 1, 1); }
    });
    if (o.cocky) { c.clearRect(19, 11, 5, 2); P(o.brow, 19, 10, 5, 1); }
    if (o.beard) { P(o.beard, 7, 20, 18, 12); P(o.beard, 10, 18, 12, 2); P(mix(o.lips || '#7a3028', '#000000', 0.3), 13, 21, 6, 1); }
    else { P(o.lips || '#8a3a2e', 13, 23, 6, 1); P(mix(o.lips || '#8a3a2e', '#ffffff', 0.2), 14, 24, 4, 1); if (o.smirk) P(o.lips, 19, 22, 1, 1); }
    if (o.scar) { P('#e0a090', 8, 16, 1, 1); P('#e0a090', 9, 17, 1, 1); P('#e0a090', 10, 18, 1, 1); }
    if (o.freckles) [[10, 18], [12, 19], [20, 18], [22, 19], [14, 17], [18, 17]].forEach(([x, y]) => P(o.freckles, x, y));
    if (o.wrinkles) { P(shade, 7, 14, 1, 2); P(shade, 25, 14, 1, 2); P(shade, 11, 22, 1, 2); P(shade, 21, 22, 1, 2); }
    const t = new T.CanvasTexture(cv); t.colorSpace = T.SRGBColorSpace; t.magFilter = T.NearestFilter; t.minFilter = T.NearestFilter; t.generateMipmaps = false;
    const m = new T.MeshToonMaterial({ map: t, gradientMap: G.grad, alphaTest: 0.5, transparent: false });
    m.emissive.set(0x202020); m.emissiveMap = t;
    return m;
  }

  // ── Humanoid rig ───────────────────────────────────────────────────────────
  // Faces +Z. The character's right hand is on -X. Units: metres before o.scale.
  function human(o) {
    shared();
    const root = new T.Group(), R = { root, o, hair: [], ik: [], extra: [] };
    const sw = o.shW || 1, hw = o.hipW || 1, th = o.thick || 1;
    const skin = mat(o.skin), legs = mat(o.legs || '#3a2418'), boots = mat(o.boots || '#2a1a10'), top = mat(o.top || '#6a4a2a');
    const body = R.body = grp(root, [0, 0.95, 0]);
    add(body, 'sph', mat(o.belt || o.legs || '#3a2418'), [0, 0.03, 0], [0.155 * hw, 0.11, 0.105 * th]);
    R.legs = [-1, 1].map(s => {
      const hip = grp(body, [s * 0.085 * hw, -0.02, 0]);
      add(hip, taper(0.085 * th, 0.062 * th), legs, [0, -0.225, 0], [1, 0.45, 1]);
      const knee = grp(hip, [0, -0.45, 0]);
      add(knee, taper(0.062 * th, 0.046 * th), legs, [0, -0.2, 0], [1, 0.4, 1]);
      add(knee, taper(0.062 * th, 0.054 * th), boots, [0, -0.33, 0], [1, 0.2, 1]);
      add(knee, 'box', boots, [0, -0.415, 0.04], [0.085 * th, 0.06, 0.2]);
      hip.rotation.z = s * 0.07; knee.rotation.z = -s * 0.07;
      return { hip, knee, s };
    });
    const spine = R.spine = grp(body, [0, 0.1, 0]);
    add(spine, taper(0.16 * sw * th, 0.12 * hw), top, [0, 0.12, 0], [1, 0.26, 0.72 * th]);
    const chest = R.chest = grp(spine, [0, 0.27, 0]);
    add(chest, 'sph', top, [0, 0, 0.005], [0.2 * sw * th, 0.18, 0.12 * th]);
    add(chest, 'sph', mat(o.sleeve || o.top || '#6a4a2a'), [0, 0.1, 0], [0.2 * sw * th, 0.075, 0.1 * th]);
    const neck = R.neck = grp(spine, [0, 0.44, 0]);
    add(neck, 'cyl', skin, [0, 0.04, 0], [0.047 * th, 0.1, 0.047 * th]);
    const head = R.head = grp(neck, [0, 0.14, 0]);
    const skull = R.skull = add(head, 'sph', skin, [0, 0, 0], [0.104 * (o.headW || 1), 0.128, 0.112]);
    if (o.face) add(skull, 'face', faceTex(Object.assign({ skin: o.skin }, o.face)));
    R.arms = [-1, 1].map(s => {
      const sh = grp(spine, [s * 0.2 * sw * th, 0.4, 0]);
      add(sh, 'sph', mat(o.sleeve || o.skin), [0, -0.02, 0], [0.078 * th, 0.082 * th, 0.075 * th]);
      add(sh, taper(0.066 * th, 0.052 * th), mat(o.sleeve || o.skin), [0, -0.145, 0], [1, 0.29, 1]);
      const el = grp(sh, [0, -0.29, 0]);
      add(el, taper(0.054 * th, 0.04 * th), mat(o.fore || o.skin), [0, -0.135, 0], [1, 0.27, 1]);
      const hand = grp(el, [0, -0.29, 0]);
      add(hand, 'sph', mat(o.glove || o.skin), [0, 0, 0], [0.042 * th, 0.055, 0.036 * th]);
      sh.rotation.z = s * 0.1;
      return { sh, el, hand, s, rest: s * 0.1 };
    });
    root.scale.setScalar(o.scale || 1);
    return R;
  }
  // Two-bone arm IK: target and pole in spine space.
  const _d = new T.Vector3(), _n = new T.Vector3(), _u = new T.Vector3(), _f = new T.Vector3(), _q = new T.Quaternion();
  function ik(arm, target, pole) {
    const a = 0.29, b = 0.29;
    _d.copy(target).sub(arm.sh.position);
    const dist = clamp(_d.length(), 0.08, a + b - 0.002), dir = _d.clone().normalize();
    const A = Math.acos(clamp((a * a + dist * dist - b * b) / (2 * a * dist), -1, 1));
    _n.copy(dir).cross(pole).normalize();
    if (_n.lengthSq() < 1e-6) _n.set(1, 0, 0);
    _u.copy(dir).applyAxisAngle(_n, A);
    arm.sh.quaternion.setFromUnitVectors(DOWN, _u);
    _f.copy(dir).multiplyScalar(dist).sub(_u.clone().multiplyScalar(a)).normalize();
    _q.copy(arm.sh.quaternion).invert(); _f.applyQuaternion(_q);
    arm.el.quaternion.setFromUnitVectors(DOWN, _f);
  }
  // Hang a chain of beads (braids, hair) from a parent; each link sways on its own.
  function chain(parent, p, n, len, r0, r1, m, m2) {
    const links = []; let g = grp(parent, p);
    for (let i = 0; i < n; i++) {
      const k = i / Math.max(1, n - 1), r = r0 + (r1 - r0) * k;
      add(g, 'sph', (m2 && i % 2) ? m2 : m, [0, -len / 2, 0], [r, len * 0.62, r * 0.9]);
      links.push(g); g = grp(g, [0, -len, 0]);
    }
    return links;
  }
  function furRing(parent, y, rx, rz, n, cols, size, skipFront) {
    for (let i = 0; i < n; i++) {
      const a = i / n * TAU; if (skipFront && Math.abs(((a + PI) % TAU) - PI) < skipFront) continue;
      const s = size * (0.8 + ((i * 37) % 7) / 14);
      add(parent, 'sph', mat(cols[i % cols.length]), [Math.sin(a) * rx, y + ((i * 13) % 5) * 0.008, Math.cos(a) * rz], [s, s * 0.8, s]);
    }
  }
  function hairCap(R, m, long) {
    add(R.skull, 'sph', m, [0, 0.1, -0.16], [1.13, 1.04, 1.12]);
    if (long) [-1, 1].forEach(s => add(R.skull, 'sph', m, [s * 0.78, -0.35, -0.2], [0.34, 0.75, 0.62]));
  }
  function cloak(parent, p, rTop, rBot, h, col) {
    const pv = grp(parent, p);
    const key = 'cloak' + col; if (!G.mats[key]) { const m = G.mats[key] = new T.MeshToonMaterial({ color: col, gradientMap: G.grad, side: T.DoubleSide }); m.emissive.set(col).multiplyScalar(0.12); }
    add(pv, new T.CylinderGeometry(rTop, rBot, h, 10, 1, true, PI / 2, PI), G.mats[key], [0, -h / 2, 0]);
    return pv;
  }
  // Merge static leaf meshes that share a parent and a material (fewer draw calls).
  function compact(obj) {
    const groups = [];
    obj.traverse(o => { if (o.children && o.children.length) groups.push(o); });
    groups.forEach(par => {
      const by = new Map();
      par.children.slice().forEach(ch => {
        if (!ch.isMesh || ch.children.length || ch.userData.keep || !ch.material.isMeshToonMaterial || ch.material.map) return;
        const k = ch.material.uuid; if (!by.has(k)) by.set(k, []); by.get(k).push(ch);
      });
      by.forEach(list => {
        if (list.length < 2) return;
        const parts = list.map(m => { m.updateMatrix(); const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone(); g.applyMatrix4(m.matrix); return g; });
        let n = 0; parts.forEach(g => { n += g.attributes.position.count; });
        const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3); let off = 0;
        parts.forEach(g => { pos.set(g.attributes.position.array, off * 3); nor.set(g.attributes.normal.array, off * 3); off += g.attributes.position.count; g.dispose(); });
        const geo = new T.BufferGeometry(); geo.setAttribute('position', new T.BufferAttribute(pos, 3)); geo.setAttribute('normal', new T.BufferAttribute(nor, 3));
        geo.computeBoundingSphere();
        list.forEach(m => par.remove(m));
        par.add(new T.Mesh(geo, list[0].material));
      });
    });
  }

  // ── Character builds ───────────────────────────────────────────────────────
  const BUILD = {};
  BUILD.kaela = function () {
    const bronze = mat('#8a5c1c'), bronzeL = mat('#d8a040', 0.15), bronzeD = mat('#4a2a0c'), leather = mat('#2a160c'), fur = ['#6e6258', '#8a7c6c', '#544a42'];
    const R = human({ scale: 1.06, skin: '#c8a07c', top: '#8a5c1c', sleeve: '#c8a07c', legs: '#2a1810', boots: '#24160c', belt: '#2e1a0e', shW: 1.08, hipW: 1.02,
      face: { eye: '#6a3a12', brow: '#120a0a', browTilt: true, lips: '#8a3a2e', scar: true, fem: true } });
    // cuirass, belt, pteruges, greaves, bracers
    add(R.chest, 'sph', bronze, [0, -0.01, 0.02], [0.19, 0.17, 0.12]);
    add(R.chest, 'sph', bronzeD, [0, -0.02, 0.1], [0.045, 0.045, 0.02]);
    add(R.spine, taper(0.15, 0.135), bronze, [0, 0.12, 0], [1, 0.16, 0.76]);
    add(R.spine, taper(0.14, 0.14), leather, [0, 0.02, 0], [1, 0.05, 0.78]);
    for (let i = 0; i < 12; i++) { const a = i / 12 * TAU; add(R.body, 'box', i % 2 ? leather : bronzeD, [Math.sin(a) * 0.15, -0.13, Math.cos(a) * 0.11], [0.065, 0.3, 0.02], [0.12 * Math.cos(a), a, -0.12 * Math.sin(a)]); }
    R.legs.forEach(L => { add(L.knee, taper(0.068, 0.056), bronzeL, [0, -0.17, 0.012], [1, 0.26, 1]); });
    R.arms.forEach(A => { add(A.el, taper(0.06, 0.05), bronzeL, [0, -0.2, 0], [1, 0.13, 1]); });
    add(R.neck, 'tor', bronzeL, [0, 0.0, 0], [0.055, 0.055, 0.1], [PI / 2, 0, 0]);
    add(R.chest, 'box', bronzeL, [0, -0.12, 0.1], [0.3, 0.02, 0.03]); add(R.chest, 'sph', bronzeL, [0, 0.02, 0.118], [0.035, 0.035, 0.012]);
    add(R.spine, 'box', bronzeL, [0, 0.02, 0.13], [0.07, 0.05, 0.02]);
    // wolf-fur mantle with a wolf head on the left shoulder, crimson cloak
    furRing(R.spine, 0.42, 0.23, 0.14, 16, fur, 0.09, 0.5); furRing(R.spine, 0.36, 0.26, 0.15, 12, fur, 0.07, 0.9);
    const wolf = grp(R.spine, [0.2, 0.5, 0.02]);
    add(wolf, 'sph', mat('#6e6258'), [0, 0, 0], [0.075, 0.06, 0.08]);
    add(wolf, 'cone', mat('#544a42'), [0, -0.01, 0.09], [0.035, 0.1, 0.035], [PI / 2, 0, 0]);
    add(wolf, 'cone', mat('#544a42'), [0.035, 0.06, -0.01], [0.02, 0.05, 0.02]); add(wolf, 'cone', mat('#544a42'), [-0.035, 0.06, -0.01], [0.02, 0.05, 0.02]);
    add(wolf, 'sph', basic('#ffcc66'), [0.03, 0.02, 0.06], 0.008); add(wolf, 'sph', basic('#ffcc66'), [-0.03, 0.02, 0.06], 0.008);
    R.cloak = cloak(R.spine, [0, 0.44, -0.07], 0.18, 0.3, 1.3, '#5a0c0a');
    // hair: black cap + one long braid with bronze rings
    const hair = mat('#16100e'), ring = mat('#d09a40', 0.2);
    hairCap(R, hair, true);
    const brd = grp(R.head, [-0.085, -0.04, -0.02]); brd.rotation.set(-0.5, 0, -0.3);
    R.hair.push(...chain(brd, [0, 0, 0], 7, 0.085, 0.036, 0.022, hair, ring));
    // greatsword planted in front; war-helm under the left arm
    const sw = grp(R.root, [-0.06, 0, 0.42]);
    add(sw, 'box', mat('#c8c8d0', 0.1), [0, 0.52, 0], [0.09, 1.04, 0.016]);
    add(sw, 'box', mat('#8a8a98'), [0, 0.52, 0], [0.018, 1.02, 0.018]);
    add(sw, 'box', bronzeL, [0, 1.05, 0], [0.36, 0.05, 0.05]);
    add(sw, 'cyl', leather, [0, 1.16, 0], [0.02, 0.2, 0.02]);
    add(sw, 'sph', bronze, [0, 1.28, 0], 0.035);
    const helm = grp(R.root, [0.3, 1.02, 0.06]); helm.rotation.set(0.2, 0.9, 0.3);
    add(helm, 'sph', bronze, [0, 0, 0], [0.11, 0.12, 0.12]);
    add(helm, 'box', bronzeD, [0, -0.06, 0.1], [0.025, 0.1, 0.02]);
    add(helm, 'box', mat('#b01810'), [0, 0.15, -0.02], [0.035, 0.12, 0.26], [0.2, 0, 0]);
    add(helm, 'box', mat('#a01810'), [0, 0.06, -0.15], [0.03, 0.14, 0.06], [0.6, 0, 0]);
    R.ik.push({ arm: R.arms[0], p: new T.Vector3(-0.06, 1.3, 0.4), pole: new T.Vector3(-1, -0.2, -0.6) });
    R.ik.push({ arm: R.arms[1], p: new T.Vector3(0.24, 1.0, 0.18), pole: new T.Vector3(1, 0.3, -1) });
    R.stance = 1.3;
    return R;
  };
  BUILD.nyx = function () {
    const robe = '#241a52', robeD = '#140e30', silver = mat('#d8d8f0', 0.25);
    const R = human({ scale: 1.03, skin: '#e8d4d0', top: robe, sleeve: robe, fore: robe, legs: robeD, boots: '#120c20', belt: robeD, shW: 0.95, hipW: 1.0,
      face: { eye: '#b070ff', brow: '#a0a0c0', lips: '#6a2a4a', lash: '#1a0a2a', fem: true } });
    R.legs.forEach(L => { L.hip.visible = false; });
    add(R.body, taper(0.15, 0.4, 12), mat(robe), [0, -0.43, 0], [1, 1.0, 0.85]);
    add(R.body, taper(0.4, 0.41, 12), mat(robeD), [0, -0.9, 0], [1, 0.06, 0.86]);
    add(R.spine, 'tor', silver, [0, 0.02, 0], [0.14, 0.14, 0.2], [PI / 2, 0, 0]);
    add(R.spine, taper(0.2, 0.18, 10), mat(robeD), [0, 0.38, 0], [1, 0.1, 0.72]);
    add(R.neck, taper(0.1, 0.07, 10), mat(robeD, 0, true), [0, 0.03, -0.01], [1, 0.12, 1]);
    add(R.chest, 'sph', silver, [0, -0.02, 0.12], [0.022, 0.03, 0.012]);
    R.arms.forEach(A => { add(A.el, taper(0.05, 0.09, 8), mat(robe), [0, -0.19, 0], [1, 0.2, 1]); });
    R.cloak = cloak(R.spine, [0, 0.42, -0.05], 0.18, 0.42, 1.38, '#1a1240');
    // silver hair: cap, a long curtain down the back, two locks over the shoulders
    const hairM = mat('#c8c8e0', 0.12);
    hairCap(R, hairM, true);
    const back = grp(R.head, [0, 0.02, -0.08]); R.hair.push(back);
    add(back, 'box', hairM, [0, -0.3, -0.01], [0.2, 0.62, 0.05]);
    add(back, 'box', hairM, [0, -0.62, -0.02], [0.14, 0.12, 0.04]);
    [-1, 1].forEach(s => { const l = grp(R.head, [s * 0.09, -0.03, 0.04]); l.rotation.z = s * 0.25; R.hair.push(l); add(l, 'box', hairM, [0, -0.2, 0.03], [0.055, 0.42, 0.04]); });
    [-1, 1].forEach(s => { add(R.spine, 'cone', mat(robeD), [s * 0.22, 0.47, 0], [0.07, 0.16, 0.07], [0, 0, -s * 1.1]); add(R.spine, 'cone', silver, [s * 0.3, 0.51, 0], [0.012, 0.05, 0.012], [0, 0, -s * 1.1]); });
    add(R.spine, 'box', silver, [0, 0.2, 0.125], [0.012, 0.3, 0.01]);
    // circlet with a crescent and a gem
    add(R.head, 'tor', silver, [0, 0.055, 0.005], [0.105, 0.11, 0.2], [PI / 2 + 0.12, 0, 0]);
    add(R.head, new T.TorusGeometry(1, 0.25, 4, 10, PI), silver, [0, 0.1, 0.105], [0.03, 0.03, 0.03], [0, 0, PI]);
    add(R.head, 'sph', basic('#9ae0ff'), [0, 0.07, 0.108], 0.011);
    // staff with a floating moon orb
    const st = grp(R.root, [-0.34, 0, 0.14]);
    add(st, 'cyl', mat('#2a1a14'), [0, 1.0, 0], [0.018, 2.0, 0.018]);
    for (let i = 0; i < 3; i++) { const a = i / 3 * TAU; add(st, 'cone', silver, [Math.sin(a) * 0.05, 2.06, Math.cos(a) * 0.05], [0.012, 0.14, 0.012], [Math.cos(a) * 0.5, 0, -Math.sin(a) * 0.5]); }
    const orb = grp(st, [0, 2.17, 0]); R.orb = orb;
    const core1 = add(orb, 'sph', basic('#eaf8ff'), [0, 0, 0], 0.07); core1.userData.keep = true;
    const halo = add(orb, 'sph', basic('#3a78d0', 0.35), [0, 0, 0], 0.13); halo.userData.keep = true;
    R.motes = [0, 1, 2].map(i => { const m = add(orb, 'sph', basic('#bfe8ff'), [0, 0, 0], 0.014); m.userData.keep = true; return m; });
    const palm = add(R.arms[1].hand, 'sph', basic('#8fd0ff', 0.6, true), [0, -0.06, 0.03], 0.03); palm.userData.keep = true; R.palm = palm;
    R.ik.push({ arm: R.arms[0], p: new T.Vector3(-0.34, 1.2, 0.14), pole: new T.Vector3(-1, -0.3, -0.8) });
    R.ik.push({ arm: R.arms[1], p: new T.Vector3(0.2, 1.18, 0.3), pole: new T.Vector3(1, -1, -0.4) });
    R.stance = 0.8;
    return R;
  };
  BUILD.vesna = function () {
    const leath = '#4e5428', leathD = '#35391a', brown = mat('#5a3418'), fur = ['#8a6a44', '#b08c62', '#6a4c2e'];
    const R = human({ scale: 1.02, skin: '#e2a47c', top: leath, sleeve: leath, legs: '#3a2a1a', boots: '#2e1e12', belt: '#5a3418', shW: 1.0, hipW: 1.0, glove: '#5a3418',
      face: { eye: '#3a8a3a', brow: '#8a2a10', lips: '#a04a38', freckles: '#b0603a', fem: true, cocky: true, smirk: true, paint: [[5, 15, 3, 1], [5, 17, 3, 1], [24, 15, 3, 1], [24, 17, 3, 1]], paintCol: '#9a1410' } });
    R.legs.forEach(L => { add(L.knee, taper(0.064, 0.058), mat('#2e1e12'), [0, -0.24, 0], [1, 0.34, 1]); });
    add(R.spine, taper(0.14, 0.13), mat(leathD), [0, 0.05, 0], [1, 0.08, 0.76]);
    add(R.body, 'box', brown, [0.06, -0.03, 0.1], [0.05, 0.06, 0.03]); add(R.body, 'box', brown, [-0.1, -0.02, 0.07], [0.05, 0.07, 0.04]);
    furRing(R.spine, 0.43, 0.2, 0.13, 14, fur, 0.07, 0.35);
    R.arms.forEach(A => { add(A.el, taper(0.05, 0.044), brown, [0, -0.19, 0], [1, 0.14, 1]); });
    add(R.chest, 'box', mat('#3a2210'), [0, 0.0, 0.0], [0.035, 0.46, 0.25], [0, 0, 0.75]); // quiver strap
    // quiver + arrows, longbow across the back
    const qv = grp(R.spine, [0.1, 0.3, -0.14]); qv.rotation.set(0.12, 0, -0.35);
    add(qv, 'cyl', brown, [0, 0, 0], [0.05, 0.46, 0.05]);
    for (let i = 0; i < 5; i++) { const x = (i % 3 - 1) * 0.022, z = (i > 2 ? 0.015 : -0.012); add(qv, 'cyl', mat('#c8b080'), [x, 0.3, z], [0.006, 0.18, 0.006]); add(qv, 'box', mat('#c01c10'), [x, 0.36, z], [0.005, 0.06, 0.028]); }
    const bow = grp(R.spine, [-0.02, 0.2, -0.17]); bow.rotation.set(0, 0, 0.55);
    add(bow, new T.TorusGeometry(0.85, 0.018, 4, 14, 1.6), mat('#4a2a12'), [-0.8, 0, 0], 1, [0, 0, -0.8]);
    seg(bow, [Math.cos(-0.8) * 0.85 - 0.8, Math.sin(-0.8) * 0.85, 0], [Math.cos(0.8) * 0.85 - 0.8, Math.sin(0.8) * 0.85, 0], 0.004, 0.004, mat('#e8dcc0'));
    // red braid over the left shoulder
    const hair = mat('#c0401c', 0.1), tie = mat('#5a3418');
    hairCap(R, hair, true);
    add(R.head, 'box', hair, [-0.03, 0.08, 0.075], [0.14, 0.04, 0.05], [0, 0, 0.25]);
    const br = grp(R.head, [0.08, -0.03, -0.02]); br.rotation.set(-0.45, 0, 0.35);
    R.hair.push(...chain(br, [0, 0, 0], 7, 0.09, 0.042, 0.026, hair, mat('#a8341a')));
    add(R.hair[R.hair.length - 1], 'sph', tie, [0, -0.09, 0], [0.02, 0.02, 0.02]);
    const arrow = grp(R.arms[0].hand, [0, -0.02, 0.02]); arrow.rotation.set(0.4, 0, 0);
    add(arrow, 'cyl', mat('#c8b080'), [0, -0.1, 0], [0.006, 0.7, 0.006]);
    add(arrow, 'box', mat('#c01c10'), [0, 0.2, 0], [0.004, 0.08, 0.03]);
    add(arrow, 'cone', mat('#8a8a98'), [0, -0.47, 0], [0.012, 0.05, 0.012], [PI, 0, 0]);
    R.ik.push({ arm: R.arms[1], p: new T.Vector3(0.19, 1.0, 0.05), pole: new T.Vector3(1, 0.4, -1.2) });
    R.ik.push({ arm: R.arms[0], p: new T.Vector3(-0.3, 0.92, 0.1), pole: new T.Vector3(-0.4, 0, -1) });
    R.stance = 1.5;
    return R;
  };
  BUILD.bram = function () {
    const R = human({ scale: 1.03, skin: '#c07a54', top: '#6a1c14', sleeve: '#6a1c14', legs: '#2e241c', boots: '#1e1610', belt: '#3a2414', shW: 1.2, hipW: 1.2, thick: 1.3, headW: 1.08,
      face: { eye: '#2a1a10', brow: '#1a1210', thick: true, beard: '#1c1410', lips: '#7a3028' } });
    const apron = mat('#5a3a20');
    add(R.chest, 'box', apron, [0, -0.02, 0.15], [0.3, 0.22, 0.02]);
    add(R.body, 'box', apron, [0, -0.2, 0.15], [0.34, 0.6, 0.02], [0.05, 0, 0]);
    add(R.head, 'sph', mat('#1c1410'), [0, -0.08, 0.05], [0.09, 0.08, 0.075]);
    add(R.head, 'cone', mat('#1c1410'), [0, -0.16, 0.07], [0.06, 0.12, 0.05], [PI, 0, 0]);
    const ham = grp(R.arms[0].hand, [0, -0.02, 0]);
    add(ham, 'cyl', mat('#4a3020'), [0, -0.12, 0], [0.016, 0.34, 0.016]);
    add(ham, 'box', mat('#4a4a52', 0.05), [0, -0.3, 0], [0.13, 0.07, 0.07]);
    R.ik.push({ arm: R.arms[1], p: new T.Vector3(0.24, 1.02, 0.05), pole: new T.Vector3(1, 0.4, -1) });
    R.arms[0].sh.rotation.set(-0.15, 0, -0.18);
    R.stance = 1.6;
    return R;
  };
  BUILD.mag = function () {
    const R = human({ scale: 0.95, skin: '#d49a78', top: '#6a2420', sleeve: '#6a2420', legs: '#4a1c18', belt: '#4a1c18', shW: 1.05, hipW: 1.25, thick: 1.2,
      face: { eye: '#3a2a18', brow: '#8a8078', lips: '#8a4038', wrinkles: true, fem: true } });
    R.legs.forEach(L => { L.hip.visible = false; });
    add(R.body, taper(0.18, 0.34, 12), mat('#6a2420'), [0, -0.44, 0], [1, 0.98, 0.9]);
    add(R.body, 'box', mat('#d8ccb0'), [0, -0.42, 0.24], [0.26, 0.8, 0.02], [0.2, 0, 0]);
    furRing(R.spine, 0.4, 0.18, 0.13, 12, ['#2e4a2a', '#3a5a34'], 0.07, 0.4);
    hairCap(R, mat('#9a9088'), false);
    add(R.head, 'sph', mat('#8a8078'), [0, 0.1, -0.1], 0.06);
    const mug = grp(R.arms[0].hand, [0, -0.04, 0.03]);
    add(mug, 'cyl', mat('#6a4a2a'), [0, 0, 0], [0.04, 0.1, 0.04]); add(mug, 'cyl', mat('#e8dcc0'), [0, 0.055, 0], [0.036, 0.015, 0.036]);
    R.ik.push({ arm: R.arms[0], p: new T.Vector3(-0.14, 1.2, 0.22), pole: new T.Vector3(-1, -0.5, -0.5) });
    R.ik.push({ arm: R.arms[1], p: new T.Vector3(0.24, 1.0, 0.06), pole: new T.Vector3(1, 0.4, -1) });
    R.stance = 1.8;
    return R;
  };
  function buildVillager(v) {
    const R = human({ scale: v.scale, skin: v.skin, top: v.top, sleeve: v.top, legs: v.legs, boots: '#2a1c12', belt: '#3a2414', shW: v.fem ? 0.92 : 1.05, hipW: v.fem ? 1.05 : 1, thick: v.thick || 1,
      face: { eye: '#2a1a10', brow: v.hair, beard: v.beard, lips: '#8a4a3a', fem: v.fem, wrinkles: v.old } });
    if (v.fem) { R.legs.forEach(L => { L.hip.visible = false; }); add(R.body, taper(0.16, 0.3, 10), mat(v.skirt || v.top), [0, -0.44, 0], [1, 0.96, 0.9]); }
    if (v.hood) { add(R.skull, 'sph', mat(v.hood), [0, 0.1, -0.24], [1.2, 1.12, 1.16]); add(R.spine, taper(0.12, 0.24, 8), mat(v.hood), [0, 0.38, -0.02], [1, 0.14, 0.8]); }
    else hairCap(R, mat(v.hair), v.fem);
    if (v.beard) add(R.head, 'sph', mat(v.beard), [0, -0.09, 0.05], [0.075, 0.06, 0.06]);
    if (v.apron) add(R.body, 'box', mat('#c8b890'), [0, -0.2, 0.14], [0.26, 0.5, 0.02]);
    const hand = R.arms[0].hand;
    if (v.task === 'hoe' || v.task === 'sweep') {
      const t = grp(hand, [0, 0, 0]); t.rotation.set(0.3, 0, 0);
      add(t, 'cyl', mat('#6a4a2a'), [0, -0.3, 0], [0.013, 1.3, 0.013]);
      if (v.task === 'hoe') add(t, 'box', mat('#5a5a60'), [0, -0.94, 0.05], [0.12, 0.02, 0.1]);
      else add(t, 'cone', mat('#b09050'), [0, -1.0, 0], [0.08, 0.22, 0.05]);
    } else if (v.task === 'spear') {
      const t = grp(R.root, [-0.3, 0, 0.1]);
      add(t, 'cyl', mat('#5a3a20'), [0, 1.0, 0], [0.014, 2.0, 0.014]); add(t, 'cone', mat('#9a9aa8'), [0, 2.08, 0], [0.025, 0.16, 0.025]);
      R.ik.push({ arm: R.arms[0], p: new T.Vector3(-0.3, 1.3, 0.1), pole: new T.Vector3(-1, -0.3, -0.8) });
      add(R.chest, 'sph', mat('#5a5a62'), [0, 0, 0.01], [0.2, 0.19, 0.125]);
    } else if (v.task === 'basket') {
      const t = grp(R.root, [0.28, 0.98, 0.1]); add(t, 'cyl', mat('#a07838'), [0, 0, 0], [0.13, 0.12, 0.13]); add(t, 'sph', mat('#b0302a'), [0, 0.06, 0], [0.1, 0.04, 0.1]);
      R.ik.push({ arm: R.arms[1], p: new T.Vector3(0.28, 1.05, 0.1), pole: new T.Vector3(1, 0.3, -1) });
    } else if (v.task === 'staff') {
      const t = grp(R.root, [-0.28, 0, 0.18]); add(t, 'cyl', mat('#5a3a20'), [0, 0.75, 0], [0.016, 1.5, 0.016]);
      R.ik.push({ arm: R.arms[0], p: new T.Vector3(-0.28, 1.12, 0.18), pole: new T.Vector3(-1, -0.3, -0.8) });
    }
    R.stance = 2 + (v.seed % 5) * 0.2;
    return R;
  }

  // ── Humanoid kit (humanoid.js): Bram, Old Mag and the villagers ───────────
  // The old primitive rigs above stay as the fallback when CT.humanoid is missing.
  const KIT_WORK = { hoe: 'hoe', sweep: 'sweep' };
  const KIT_RIGHT = { hoe: 'hoe', sweep: 'broom', spear: 'spear', staff: 'staff' };
  function kitSpec(id, v) {
    if (id === 'bram') return { preset: 'smith', seed: 3, pal: { top: '#6a1c14', skin: '#c07a54', hair: '#1c1410', legs: '#2e241c', boots: '#1e1610', leather: '#5a3a20' }, hair: 'bald', beard: 'full' };
    if (id === 'mag') return { preset: 'villagerF', seed: 8, height: 1.66, bulk: 1.22, belly: 0.5, age: 0.85, hair: 'bun', helm: 'kerchief', pal: { top: '#6a2420', skin: '#d49a78', hair: '#9a9088', cloth: '#d8ccb0' }, face: { smile: true } };
    const pal = { top: v.top, legs: v.legs, skin: v.skin, hair: v.hair };
    if (v.hood) pal.cloth = v.hood;
    const sp = { preset: v.task === 'spear' ? 'militia' : v.fem ? 'villagerF' : 'villagerM', seed: hash(v.id) % 1000, pal, right: KIT_RIGHT[v.task] || null, left: null };
    if (v.task === 'spear') Object.assign(sp, { right: 'spear', pal: Object.assign(pal, { top: '#8a7a58', accent: '#6e1410' }) });
    if (v.fem) { sp.pal.top = v.top; if (v.skirt) sp.pal.top = v.skirt; }
    if (v.hood) { sp.hood = true; sp.helm = null; }
    if (v.old) sp.age = 0.75;
    if (v.beard) sp.beard = v.old ? 'long' : 'full'; else if (!v.fem) sp.beard = 'stubble';
    if (v.thick) sp.bulk = v.thick * 1.05;
    if (v.apron) sp.extras = ['belt', 'apron'];
    if (v.scale) sp.height = (v.fem ? 1.72 : 1.84) * v.scale;
    return sp;
  }
  function kitRig(id, v) {
    if (!CT.humanoid || typeof CT.humanoid.build !== 'function') return null;
    try {
      const R = CT.humanoid.build(kitSpec(id, v || {}));
      R.kit = true; R.work = id === 'bram' ? 'hammer' : v && KIT_WORK[v.task];
      return R;
    } catch (e) { console.warn('[npcs] humanoid kit failed, old rig used', e); return null; }
  }
  npcs.kitSpecs = () => ['bram', 'mag'].map(id => kitSpec(id)).concat(VILLAGERS.map(v => kitSpec(v.id, v)));

  // ══════════════════════════════════════════════════════════════════════════
  // ── Cast and placement ─────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  const CAST = [
    { id: 'kaela', name: 'Kaela Ironhand', kind: 'heroine', poi: 'harrowby', tags: ['quest', 'kaela'], off: [2, 7], yaw: 0 },
    { id: 'nyx', name: 'Nyx of the Pale Moon', kind: 'heroine', poi: 'fen', tags: ['quest', 'hut', 'witch', 'nyx'], off: [95, -110], yaw: -2.4 },
    { id: 'vesna', name: 'Vesna Red-Arrow', kind: 'heroine', poi: 'lodge', tags: ['quest', 'vesna', 'lodge'], off: [6, 8], yaw: 0.6 },
    { id: 'bram', name: 'Bram the Smith', kind: 'trader', poi: 'harrowby', tags: ['smithy', 'smith', 'forge', 'blacksmith'], off: [-16, -2], yaw: 0.8 },
    { id: 'mag', name: 'Old Mag', kind: 'trader', poi: 'harrowby', tags: ['tavern', 'inn', 'mag'], off: [15, -6], yaw: -0.7 },
  ];
  const VILLAGERS = [
    { id: 'v_aldo', name: 'Goodman Aldo', poi: 'harrowby', off: [-6, 18], task: 'hoe', top: '#7a6038', legs: '#4a3a24', skin: '#c8906a', hair: '#4a3020', beard: '#4a3020',
      lines: ['The dead walked through my barley last night. Did not trample a stalk. That is the eerie part.', 'Harvest is thin. The crows are fat. Draw your own conclusions.'] },
    { id: 'v_hesk', name: 'Widow Hesk', poi: 'harrowby', off: [10, 16], task: 'basket', fem: true, top: '#5a3a4a', skirt: '#4a2a3a', legs: '#3a2a2a', skin: '#d8a888', hair: '#6a5a50', hood: '#3a3a3a', old: true,
      lines: ['Kaela Ironhand is our queen, whatever that bone-thing on the throne says.', 'My husband went north to fight. He came back last winter. Walking. Wrong.'] },
    { id: 'v_tam', name: 'Tam the Cooper', poi: 'harrowby', off: [-20, 8], task: 'idle', top: '#8a4a28', legs: '#3a2a1a', skin: '#b87a50', hair: '#2a1a10', apron: true, thick: 1.15,
      lines: ['Buy a barrel? Nobody buys barrels any more. Everyone buys coffins.', 'Bram makes blades, I make barrels. Guess who eats better.'] },
    { id: 'v_ilsa', name: 'Ilsa the Weaver', poi: 'harrowby', off: [22, 6], task: 'sweep', fem: true, top: '#4a6040', skirt: '#3a4a30', legs: '#2a2a1a', skin: '#e0b090', hair: '#c08040',
      lines: ['Mind the fen road after dark. The lights out there are not lanterns.', 'Nyx? The witch? She bought wool from me once. Paid in silver that was cold as snow.'] },
    { id: 'v_pell', name: 'Old Pell', poi: 'harrowby', off: [-4, -14], task: 'staff', top: '#5a5048', legs: '#3a3228', skin: '#c89878', hair: '#d8d0c8', beard: '#d8d0c8', old: true, scale: 0.94,
      lines: ['I remember when the moon was white every night. Now it bleeds, some nights.', 'The Nine Stones hummed when I was a boy. They hum louder now.'] },
    { id: 'v_dorran', name: 'Guard Dorran', poi: 'harrowby', off: [-2, 24], task: 'spear', top: '#5a4a38', legs: '#3a2a1a', skin: '#b08060', hair: '#3a2a1a', thick: 1.1,
      lines: ['Keep your blade clean in the square. Queen\'s orders.', 'Bandits on the north road again. Grask\'s lot. Blackhands, they call themselves.'] },
    { id: 'v_ulf', name: 'Hangman Ulf', poi: 'crossing', off: [6, 6], task: 'idle', top: '#2a2a2a', legs: '#1a1a1a', skin: '#c89070', hair: '#1a1a1a', hood: '#1e1a1a', thick: 1.15,
      lines: ['The gallows are for bandits now. Busy season.', 'Rope is cheap. Courage is dear. You look like you have some to spare.'] },
    { id: 'v_mira', name: 'Mira the Ferrier', poi: 'crossing', off: [-8, 4], task: 'basket', fem: true, top: '#7a3a2a', skirt: '#5a2a1a', legs: '#2a1a12', skin: '#a87050', hair: '#2a1a12',
      lines: ['North road is closed. Snow, and worse than snow.', 'The Frozen Teeth eat travellers. Bring furs. Bring fire. Bring friends.'] },
    { id: 'v_oss', name: 'Pilgrim Oss', poi: 'crossing', off: [2, -9], task: 'staff', top: '#8a7a5a', legs: '#5a4a3a', skin: '#d0a080', hair: '#5a4030', hood: '#6a5a40', beard: '#5a4030',
      lines: ['I walked to the Nine Stones to pray. They hummed at me. I walked back faster.', 'The citadel lights burn red all night. Someone up there never sleeps.'] },
  ];

  function spotFor(poiId, tags, used) {
    const W = CT.world, P = poiOf(poiId); if (!W || !W.spots || !P) return null;
    // world yaws are camera-style (look along -Z); npc roots face +Z, so add PI
    const S = W.spots, norm = s => (s ? { x: s.x != null ? s.x : s.pos && s.pos.x, z: s.z != null ? s.z : s.pos && s.pos.z, yaw: s.yaw != null ? s.yaw + PI : null } : null);
    const ok = s => s && (s.x != null || s.pos) && !used.has(s);
    const near = s => { const n = norm(s); return n && Math.hypot(n.x - P.x, n.z - P.z) < P.radius * 1.8; };
    const tagOf = s => [s.tag, s.kind, s.type, s.name, s.id].concat(s.tags || []);
    for (const t of tags) {
      let s = null;
      if (typeof S === 'function') s = S.call(W, t, poiId);
      else if (Array.isArray(S)) s = S.find(s => ok(s) && tagOf(s).includes(t) && (s.poi ? s.poi === poiId : near(s)));
      else if (typeof S === 'object') {
        let v = Array.isArray(S[poiId]) ? S[poiId].filter(s => ok(s) && tagOf(s).includes(t)) : (S[poiId] && S[poiId][t]) || S[t];
        if (Array.isArray(v)) v = v.find(s => ok(s) && (s.poi ? s.poi === poiId : near(s) || Array.isArray(S[poiId])));
        s = v && (v.poi ? v.poi === poiId : near(v) || Array.isArray(S[poiId])) ? v : null;
      }
      if (ok(s)) { used.add(s); return norm(s); }
    }
    return null;
  }
  const H = (x, z) => (CT.world && CT.world.heightAt ? CT.world.heightAt(x, z) || 0 : 0);
  function place(n, used) {
    const P = poiOf(n.poi) || { x: 0, z: 0 };
    const s = spotFor(n.poi, n.tags || [], used);
    let x = s ? s.x : P.x + n.off[0], z = s ? s.z : P.z + n.off[1];
    if (!s && CT.world && CT.world.collide) { const v = new T.Vector3(x, 0, z); for (let i = 0; i < 3; i++) { const r = CT.world.collide(v, 0.6); if (r) v.copy(r); } x = v.x; z = v.z; }
    n.pos.set(x, H(x, z), z);
    n.home = s && s.yaw != null ? s.yaw : n.yaw != null ? n.yaw : Math.atan2(P.x - x, P.z - z);
    n.fromSpot = !!s;
  }
  function placeAll() { const used = new Set(); npcs.list.forEach(n => place(n, used)); placeSeleneHome(); npcs.list.forEach(n => { n.R.root.position.copy(n.pos); n.R.root.rotation.y = n.yawNow = n.home; }); if (COMP.n) npcs.companionSync(); }

  // ── Sculpted heroines (heroines.js); the primitive rigs stay as the fallback ──
  function heroRig(id) {
    const H = CT.heroines; if (!H || typeof H.build !== 'function' || !(H.IDS || []).includes(id)) return null;
    let g; try { g = H.build(id); } catch (e) { console.warn('[npcs] heroine build failed, using rig', id, e); return null; }
    if (!g) return null;
    // A PointLight that comes and goes with visibility changes the scene light count and recompiles every shader: drop it, keep the emissive orb.
    g.children.filter(c => c.isLight).forEach(l => g.remove(l));
    // Heroines keep their own colours in the swamp and dusk fog (they hide beyond 150 m anyway).
    g.traverse(o => { const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []; ms.forEach(m => { if (m.fog) { m.fog = false; m.needsUpdate = true; } }); });
    return { root: g, hero: true, hair: [], ik: [], ph: 0 };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Companion: Selene the Moonbound (the Moon Pact, bought from Nyx) ───────
  // ══════════════════════════════════════════════════════════════════════════
  // She follows 3 to 5 m behind and to one side, hangs back in fights (no combat), carries a stash, tosses the player a lit
  // smoke below 50% hp (+30% over 2 s, 20 s cooldown) and revives the player with a beer once per 5 minutes.
  const COMP = { n: null, vel: new T.Vector3(), pSpeed: 0, fpp: null, walkPh: 0, walkAmt: 0, stuckT: 0, side: -1, healLeft: 0, throwT: -1, idleT: 0, fxT: 7, fxStep: 0,
    banterNext: 0, cool: {}, lastHurtT: -99, still: 0, lastPP: new T.Vector3(), bubble: null, bubbleT: 0, fx: [], proj: null, lastBlood: false, sipT: -1 };
  const comp = () => (CT.rpg && CT.rpg.companion) || null;
  const compOwned = () => { const c = comp(); return !!(c && c.owned); };
  const compFollowing = () => { const c = comp(); return !!(c && c.owned && c.following); };
  const hpMaxP = () => (CT.rpg && CT.rpg.stats ? CT.rpg.stats.hpMax : 100);
  const SEL_L = { hand: [0.2, 1.42, 0.2], mouth: [0, 1.6, 0.1], head: [0, 2.08, 0] };   // model-space points (the cigarette hand, lips, bubble)
  function seleneFallback() {   // primitive stand-in when heroines.js is missing
    const R = human({ scale: 1.0, skin: '#e4c296', top: '#7c8698', sleeve: '#e4c296', legs: '#e4c296', boots: '#e4c296', belt: '#7c8698', shW: 0.95,
      face: { eye: '#a8c4ff', brow: '#0c0e18', lips: '#6a1a3a', fem: true, smirk: true } });
    hairCap(R, mat('#121726'), false); chain(R.head, [0, 0.1, -0.08], 6, 0.09, 0.04, 0.025, mat('#121726'));
    return R;
  }
  function placeSeleneHome() {
    const n = COMP.n, nyx = npcs.find('nyx'); if (!n) return;
    if (nyx) {
      const a = nyx.home + 1.3, v = new T.Vector3(nyx.pos.x + Math.sin(a) * 2.6, 0, nyx.pos.z + Math.cos(a) * 2.6);
      if (CT.world && CT.world.collide) { const r = CT.world.collide(v, 0.45); if (r) v.copy(r); }
      n.homePos = new T.Vector3(v.x, H(v.x, v.z), v.z); n.home = nyx.home - 0.4;
    } else n.homePos = n.pos.clone();
    if (!compFollowing()) n.pos.copy(n.homePos);
  }
  // Called by rpg.load/reset: put her home or at the player's side, hide her without a pact.
  npcs.companionSync = function () {
    const n = COMP.n; if (!n) return;
    if (!n.homePos) placeSeleneHome();
    const c = comp();
    if (c && c.owned && c.following) compSummonTo(n, false); else if (n.homePos) n.pos.copy(n.homePos);
    n.R.root.visible = !!(c && c.owned);
    COMP.vel.set(0, 0, 0); COMP.healLeft = 0; COMP.throwT = -1; if (COMP.proj) COMP.proj.visible = false;
  };
  function playerFrame() {
    const P = CT.player, pp = P && P.pos ? P.pos : core.camera.position, yaw = P && P.yaw != null ? P.yaw : core.camera.rotation.y;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    return { pp, fx, fz, rx: -fz, rz: fx };
  }
  function compSummonTo(n, poof) {
    const { pp, fx, fz, rx, rz } = playerFrame();
    const v = new T.Vector3(pp.x - fx * 3.5 + rx * 1.8 * COMP.side, 0, pp.z - fz * 3.5 + rz * 1.8 * COMP.side);
    if (CT.world && CT.world.collide) { const r = CT.world.collide(v, 0.45); if (r) v.copy(r); }
    if (poof) fxPoof(n.pos);
    n.pos.set(v.x, H(v.x, v.z), v.z); n.yawNow = Math.atan2(pp.x - v.x, pp.z - v.z);
    if (poof) fxPoof(n.pos);
    COMP.vel.set(0, 0, 0); COMP.stuckT = 0;
  }
  npcs.companionSummon = function () {
    const c = comp(), n = COMP.n; if (!c || !n) return false;
    c.owned = true; c.following = true; n.R.root.visible = true; compSummonTo(n, true);
    bus.emit('notify', { text: 'Moonlight pools behind you. Selene steps out of it, lighting a cigarette.', kind: 'story' });
    bus.emit('companion', { id: 'selene', following: true });
    if (CT.rpg && CT.rpg.save) CT.rpg.save();
    return true;
  };
  npcs.companionDismiss = function () {
    const c = comp(), n = COMP.n; if (!c || !n || !c.owned) return false;
    c.following = false; if (CT.rpg && CT.rpg.restockCompanion) CT.rpg.restockCompanion();
    fxPoof(n.pos); if (!n.homePos) placeSeleneHome(); n.pos.copy(n.homePos); n.yawNow = n.home; fxPoof(n.pos);
    COMP.vel.set(0, 0, 0); COMP.healLeft = 0;
    bus.emit('companion', { id: 'selene', following: false });
    if (CT.rpg && CT.rpg.save) CT.rpg.save();
    return true;
  };

  // ── Revive: wrap the player's hurt so a killing blow never reaches die() while a beer is ready ──
  function compInit() {
    const P = CT.player;
    if (P && typeof P.hurt === 'function' && !P.hurt._selene) {
      const orig = P.hurt;
      const wrapped = function (amount, dir, source) {
        const c = comp(), n = COMP.n;
        const ready = c && c.owned && c.following && c.beers > 0 && c.reviveCD <= 0 && P.alive !== false && n && n.dist < 45;
        if (!ready) return orig.call(P, amount, dir, source);
        const hp0 = P.hp; P.hp = hp0 + 1e5;
        let r; try { r = orig.call(P, amount, dir, source); } finally {
          const after = P.hp - 1e5;
          if (after <= 0) { P.hp = Math.max(1, hpMaxP() * 0.4); compRevive(); } else P.hp = after;
        }
        return r;
      };
      wrapped._selene = true; P.hurt = wrapped;
    }
    bus.on('playerHurt', () => { COMP.lastHurtT = time; });
    bus.on('poi', d => banterPoi(d));
    bus.on('kill', d => { const m = d.monster || {}; if (d.overkill > 50 || d.chief || d.guardian || d.boss || d.type === 'troll' || m.isBoss) banter('kill'); });
    bus.on('levelUp', () => banter('level'));
    bus.on('notify', d => { if (d && d.text === 'Rush') banter('smoke'); });
  }
  function compRevive() {
    const c = comp(); c.beers = Math.max(0, c.beers - 1); c.reviveCD = 300;
    speak('Here, have a cold one.', true);
    bus.emit('beerRevive', { hp: CT.player ? CT.player.hp : 0, beersLeft: c.beers });
    if (core && core.shake) core.shake(0.4, 0.3);
  }

  // ── Per-frame ──────────────────────────────────────────────────────────────
  const _v = new T.Vector3(), _w = new T.Vector3();
  function compUpdate(n, dt, c, pp, live) {
    const st = comp(), R = n.R;
    const dx0 = pp.x - n.pos.x, dz0 = pp.z - n.pos.z; n.dist = Math.hypot(dx0, dz0);
    if (!st || !st.owned) { R.root.visible = false; return; }
    if (live) { st.reviveCD = Math.max(0, st.reviveCD - dt); st.healCD = Math.max(0, st.healCD - dt); }
    let speed = 0;
    if (st.following) speed = compFollow(n, dt, pp);
    else {   // waiting at Nyx's hut
      if (n.homePos && n.pos.distanceToSquared(n.homePos) > 0.01) n.pos.copy(n.homePos);
      const want = n.dist < 8 ? Math.atan2(dx0, dz0) : n.home; turnTo(n, want, dt, 3);
    }
    n.pos.y = H(n.pos.x, n.pos.z);
    R.root.visible = n.dist < 150;
    R.root.position.copy(n.pos); R.root.rotation.y = n.yawNow;
    // the "sip": a brief tilt back of the whole figure
    if (COMP.sipT >= 0) { COMP.sipT += dt; R.root.rotation.x = -Math.sin(Math.min(1, COMP.sipT / 1.2) * PI) * 0.06; if (COMP.sipT > 1.2) { COMP.sipT = -1; R.root.rotation.x = 0; } }
    COMP.walkAmt += (clamp(speed / 4.5, 0, 1.25) - COMP.walkAmt) * Math.min(1, dt * 8);
    COMP.walkPh += dt * speed * 4.2;
    const ud = R.root.userData;
    if (ud.walk) ud.walk(COMP.walkAmt < 0.03 ? 0 : COMP.walkAmt, COMP.walkPh);
    if (ud.update) ud.update(dt, time);
    if (st.following && live) { compHeal(n, dt, st); compBanterTick(n, dt, pp); }
    compIdleFx(n, dt, speed);
    fxTick(dt); bubbleTick(n, dt);
  }
  function turnTo(n, want, dt, k) { let da = want - n.yawNow; while (da > PI) da -= TAU; while (da < -PI) da += TAU; n.yawNow += da * Math.min(1, dt * k); }
  function compFollow(n, dt, pp) {
    const { fx, fz, rx, rz } = playerFrame();
    const combat = !!(CT.monsters && CT.monsters.inCombat);
    const dxp = n.pos.x - pp.x, dzp = n.pos.z - pp.z, dp = Math.hypot(dxp, dzp);
    // too far or stuck: reappear behind the player
    if (dp > 60 || COMP.stuckT > 2.5) { compSummonTo(n, dp < 150); return 0; }
    const back = combat ? 7.5 : 3.6, side = (combat ? 1.2 : 1.9) * COMP.side;
    let tx = pp.x - fx * back + rx * side, tz = pp.z - fz * back + rz * side;
    // stay out of the player's front arc: if she is ahead and close, swing wide around the side she is on
    const front = (dxp * fx + dzp * fz) / (dp || 1);
    if (dp < 5 && front > 0.2) { const sg = (dxp * rx + dzp * rz) >= 0 ? 1 : -1; tx = pp.x + rx * sg * 3 - fx * 1.5; tz = pp.z + rz * sg * 3 - fz * 1.5; }
    const dx = tx - n.pos.x, dz = tz - n.pos.z, d = Math.hypot(dx, dz);
    // match the player's measured pace, plus a catch-up term for the gap to her slot
    if (COMP.fpp) { const ps = dt > 0 ? Math.hypot(pp.x - COMP.fpp.x, pp.z - COMP.fpp.z) / dt : 0; COMP.pSpeed += (Math.min(ps, 12) - COMP.pSpeed) * Math.min(1, dt * 4); } else COMP.fpp = new T.Vector3();
    COMP.fpp.copy(pp);
    const speed = d < 0.6 ? 0 : clamp(COMP.pSpeed + (d - 0.6) * 2.4, 0, 9.5);
    _v.set(0, 0, 0); if (d > 0.01 && speed > 0) _v.set(dx / d * speed, 0, dz / d * speed);
    COMP.vel.lerp(_v, Math.min(1, dt * 6));
    const ox = n.pos.x, oz = n.pos.z;
    n.pos.x += COMP.vel.x * dt; n.pos.z += COMP.vel.z * dt;
    // personal space around the player (never inside the camera or the sword swing)
    const qx = n.pos.x - pp.x, qz = n.pos.z - pp.z, q = Math.hypot(qx, qz);
    if (q < 1.4 && q > 1e-3) { n.pos.x = pp.x + qx / q * 1.4; n.pos.z = pp.z + qz / q * 1.4; }
    if (CT.world && CT.world.collide) { _w.set(n.pos.x, 0, n.pos.z); const r = CT.world.collide(_w, 0.4); if (r) { n.pos.x = r.x; n.pos.z = r.z; } }
    const moved = dt > 0 ? Math.hypot(n.pos.x - ox, n.pos.z - oz) / dt : 0;
    if (speed > 1.5 && moved < speed * 0.2) COMP.stuckT += dt; else COMP.stuckT = Math.max(0, COMP.stuckT - dt * 2);
    const sp = moved;
    if (sp > 0.5) turnTo(n, Math.atan2(COMP.vel.x, COMP.vel.z), dt, 8);
    else if (dp < 9) turnTo(n, Math.atan2(-dxp, -dzp), dt, 3);
    return sp;
  }
  // ── Heal: toss the player a lit smoke ──────────────────────────────────────
  const HEAL_LINES = ['Here. Breathe.', 'Catch. Lit end away from your face.', 'Smoke break. Doctor\'s orders.', 'Breathe, hero. Slowly. There.', 'You look like hell. Here.'];
  function compHeal(n, dt, st) {
    const P = CT.player; if (!P || P.alive === false) { COMP.healLeft = 0; return; }
    if (COMP.healLeft > 0 && typeof P.heal === 'function') { const k = Math.min(COMP.healLeft, hpMaxP() * 0.15 * dt); P.heal(k); COMP.healLeft -= k; }
    if (COMP.throwT >= 0) { projTick(n, dt); return; }
    const inBattle = (CT.monsters && CT.monsters.inCombat) || time - COMP.lastHurtT < 8;
    if (inBattle && P.hp < hpMaxP() * 0.5 && st.healCD <= 0 && st.smokes > 0 && n.dist < 30) {
      st.healCD = 20; st.smokes--; COMP.throwT = 0;
      speak(HEAL_LINES[(hash('h' + Math.floor(time)) >>> 3) % HEAL_LINES.length], true);
    } else if (inBattle && P.hp < hpMaxP() * 0.5 && st.healCD <= 0 && st.smokes <= 0) { banter('dry'); st.healCD = 20; }
  }
  function projTick(n, dt) {
    if (!COMP.proj) {
      const g = new T.Group(), cig = new T.Mesh(G.geo.cyl, basic('#f0ece4')); cig.scale.set(0.012, 0.09, 0.012); cig.rotation.z = PI / 2; g.add(cig);
      const em = new T.Mesh(G.geo.sph, basic('#ff7a1a')); em.scale.setScalar(0.016); em.position.x = 0.05; g.add(em); group.add(g); COMP.proj = g;
    }
    const g = COMP.proj, k = Math.min(1, COMP.throwT / 0.55);
    const a = n.R.root.localToWorld(_v.set(...SEL_L.hand)), cam = core.camera, b = _w.set(0, -0.28, -0.55).applyMatrix4(cam.matrixWorld);
    g.visible = true; g.position.lerpVectors(a, b, k); g.position.y += Math.sin(k * PI) * 0.9; g.rotation.set(time * 9, time * 7, 0);
    COMP.throwT += dt;
    if (k >= 1) {
      g.visible = false; COMP.throwT = -1; COMP.healLeft = hpMaxP() * 0.3;
      const P = CT.player;
      if (P && typeof P.drag === 'function') P.drag(true);   // hook for the player's cigarette Rush (not in player.js yet)
      bus.emit('companionHeal', { amount: COMP.healLeft, by: 'selene' });
      if (CT.audio && CT.audio.sfx) CT.audio.sfx('drag');
    }
  }
  // ── Idle: the lighter flick, a smoke puff, a sip ───────────────────────────
  function compIdleFx(n, dt, speed) {
    if (!n.R.root.visible || n.dist > 40) return;
    if (speed > 0.4) { COMP.fxT = Math.max(COMP.fxT, 2); return; }
    COMP.fxT -= dt; if (COMP.fxT > 0) return;
    const hand = n.R.root.localToWorld(_v.set(...SEL_L.hand)).clone(), mouth = n.R.root.localToWorld(_w.set(...SEL_L.mouth)).clone();
    const step = COMP.fxStep++ % 3;
    if (step === 0) { fxSpark(hand); COMP.fxT = 1.1; }
    else if (step === 1) { for (let i = 0; i < 4; i++) fxSmoke(mouth, i * 0.12); COMP.fxT = 3; }
    else { COMP.sipT = 0; COMP.fxT = 6 + (hash('s' + Math.floor(time)) % 6); }
  }
  function fxGet() {
    let f = COMP.fx.find(f => f.life <= 0);
    if (!f) { if (COMP.fx.length >= 28) return null; const m = new T.Mesh(G.geo.sph, new T.MeshBasicMaterial({ color: 0xcccccc, transparent: true, depthWrite: false })); m.visible = false; group.add(m); f = { m, life: 0 }; COMP.fx.push(f); }
    return f;
  }
  function fxSmoke(p, delay) { const f = fxGet(); if (!f) return; Object.assign(f, { life: 2.2 + delay, max: 2.2, delay, kind: 'smoke', v: new T.Vector3((Math.random() - 0.5) * 0.12, 0.35, (Math.random() - 0.5) * 0.12), s0: 0.03 }); f.m.position.copy(p); f.m.material.color.set(0xb8b8c0); }
  function fxSpark(p) { const f = fxGet(); if (!f) return; Object.assign(f, { life: 0.35, max: 0.35, delay: 0, kind: 'spark', v: new T.Vector3(0, 0.05, 0), s0: 0.03 }); f.m.position.copy(p); f.m.material.color.set(0xffc060); }
  function fxPoof(p) { for (let i = 0; i < 10; i++) { const f = fxGet(); if (!f) return; const a = i / 10 * TAU; Object.assign(f, { life: 1.2, max: 1.2, delay: 0, kind: 'poof', v: new T.Vector3(Math.sin(a) * 0.8, 0.6 + (i % 3) * 0.3, Math.cos(a) * 0.8), s0: 0.08 }); f.m.position.set(p.x, p.y + 0.9, p.z); f.m.material.color.set(0xcfe0ff); } }
  function fxTick(dt) {
    COMP.fx.forEach(f => {
      if (f.life <= 0) return; f.life -= dt;
      if (f.delay > 0 && f.life > f.max) { f.m.visible = false; return; }
      const k = 1 - Math.max(0, f.life) / f.max;
      f.m.visible = f.life > 0; f.m.position.addScaledVector(f.v, dt);
      f.m.scale.setScalar(f.s0 * (f.kind === 'smoke' ? 1 + k * 5 : f.kind === 'spark' ? 1 - k * 0.5 : 1 + k * 1.5));
      f.m.material.opacity = f.kind === 'smoke' ? 0.45 * (1 - k) : 1 - k;
    });
  }
  // ── Speech bubble over her head (plus the notify line) ─────────────────────
  function speak(text, bubble) {
    const n = COMP.n; if (!n) return;
    say(n, text);
    if (!bubble) return;
    if (!COMP.bubble) {
      const cv = canvas(512, 128), tex = new T.CanvasTexture(cv); tex.colorSpace = T.SRGBColorSpace;
      const sp = new T.Sprite(new T.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
      sp.scale.set(1.9, 0.475, 1); sp.renderOrder = 5; group.add(sp); COMP.bubble = { sp, cv, tex };
    }
    const B = COMP.bubble, g = B.cv.getContext('2d');
    g.clearRect(0, 0, 512, 128); g.font = 'bold 34px Georgia, serif';
    const words = text.split(' '), lines = ['']; words.forEach(w => { const t = (lines[lines.length - 1] + ' ' + w).trim(); if (g.measureText(t).width > 460 && lines[lines.length - 1]) lines.push(w); else lines[lines.length - 1] = t; });
    const h = 22 + lines.length * 40;
    g.fillStyle = 'rgba(12,14,30,0.86)'; g.strokeStyle = '#c8d4f0'; g.lineWidth = 4;
    g.beginPath(); g.roundRect ? g.roundRect(8, 8, 496, h, 18) : g.rect(8, 8, 496, h); g.fill(); g.stroke();
    g.fillStyle = '#eef2ff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    lines.slice(0, 2).forEach((l, i) => g.fillText(l, 256, 8 + 30 + i * 40));
    B.tex.needsUpdate = true; COMP.bubbleT = 3.5;
  }
  function bubbleTick(n, dt) {
    const B = COMP.bubble; if (!B) return;
    COMP.bubbleT -= dt; B.sp.visible = COMP.bubbleT > 0 && n.R.root.visible;
    if (B.sp.visible) { n.R.root.localToWorld(B.sp.position.set(...SEL_L.head)); B.sp.material.opacity = Math.min(1, COMP.bubbleT * 2); }
  }
  // ── Banter (rate-limited barks in her voice) ───────────────────────────────
  const BANTER = {
    fen: ['The fen. Mind the water, it bites.', 'Smells like wet regret out here. My favourite.'],
    ruins: ['Old stones, old gods, old grudges. Watch the shadows.', 'Nice ruins. Somebody\'s empire died here. Let us not join it.'],
    citadel: ['That is his house? Tacky. All that red.', 'Last stop. Finish your beer before you knock.'],
    pass: ['Snow. Wonderful. My lighter hates this place.', 'Cold enough to freeze the smoke in your mouth.'],
    camp: ['Bandits. Mind your purse. And mine.'],
    wolfden: ['Wolves. Big ones. Try to keep your throat.'],
    village: ['Civilisation. Do they sell beer here?', 'Look, people. Try not to scare them.'],
    blood: ['Red moon. Everything out there is hungry tonight. Stay close.', 'Blood moon. I hate this sky. Keep your sword out.'],
    kill: ['Messy. I like it.', 'Remind me never to owe you money.', 'Now that is how you end a conversation.', 'You got some on me. Again.'],
    smoke: ['Get your own. Oh wait, you did.', 'Look at you, smoking like a professional sinner.', 'Share that, or I start charging.'],
    low: ['You are leaking. Stop leaking.', 'Hold still, you idiot. Smokes are coming.'],
    dry: ['I am out of smokes. Nyx\'s hut, or a tavern. Soon.'],
    level: ['Look at you. Growing up.', 'Stronger already. I barely had to carry you.'],
    idle: ['I could be drinking somewhere warm, you know.', 'Are we waiting for the moon to set? I can wait. I have beer.'],
  };
  function banter(kind, force) {
    if (!compFollowing() || !COMP.n || (!force && (time < COMP.banterNext || time < (COMP.cool[kind] || 0)))) return false;
    const L = BANTER[kind]; if (!L) return false;
    COMP.banterNext = time + 18; COMP.cool[kind] = time + (kind === 'kill' ? 60 : 110);
    COMP.bi = (COMP.bi || 0) + 1;
    speak(L[COMP.bi % L.length], true);
    return true;
  }
  function banterPoi(d) {
    const p = poiOf(d && d.id); if (!p) return;
    banter(p.type === 'swamp' ? 'fen' : p.type === 'village' ? 'village' : p.type === 'den' ? 'wolfden' : BANTER[p.id] ? p.id : p.type === 'ruins' ? 'ruins' : 'village');
  }
  function compBanterTick(n, dt, pp) {
    const blood = !!(CT.sky && CT.sky.weather === 'bloodmoon');
    if (blood && !COMP.lastBlood) banter('blood'); COMP.lastBlood = blood;
    const P = CT.player;
    if (P && P.hp < hpMaxP() * 0.3 && P.alive !== false) banter('low');
    if (COMP.lastPP.distanceToSquared(pp) < 0.04) COMP.still += dt; else { COMP.still = 0; COMP.lastPP.copy(pp); }
    if (COMP.still > 45) { COMP.still = 0; banter('idle'); }
  }
  npcs.companion = { banter, speak, get state() { return comp(); }, get npc() { return COMP.n; }, debug: COMP };

  // ── Shadow blob ────────────────────────────────────────────────────────────
  function blob(R) {
    const m = new T.Mesh(G.geo.disc, basic('#000000', 0.38)); m.rotation.x = -PI / 2; m.position.y = 0.03; m.scale.setScalar(0.42);
    m.renderOrder = -1; R.root.add(m);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Lifecycle ──────────────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  npcs.init = function (c) {
    core = c; shared();
    group = new T.Group(); group.name = 'npcs'; c.scene.add(group);
    const mk = (d, R, extra) => {
      blob(R); if (!R.hero && !R.kit) compact(R.root); group.add(R.root);
      R.ph = (hash(d.id) % 1000) / 159;
      return Object.assign({ id: d.id, name: d.name, kind: d.kind || 'villager', poi: d.poi, tags: d.tags, off: d.off, yaw: d.yaw, pos: new T.Vector3(), R, portrait: d.id, dlg: d.id, invulnerable: true, npc: true, barkT: 0 }, extra || {});
    };
    if (CT.humanoid && CT.humanoid.prewarm) { try { CT.humanoid.prewarm(npcs.kitSpecs()); } catch (e) { console.warn('[npcs] prewarm', e); } }
    CAST.forEach(d => npcs.list.push(mk(d, heroRig(d.id) || (d.kind === 'trader' && kitRig(d.id)) || BUILD[d.id]())));
    VILLAGERS.forEach((v, i) => {
      v.seed = hash(v.id); v.scale = v.scale || (v.fem ? 0.93 : 1.0) + (v.seed % 5) * 0.012;
      npcs.list.push(mk(Object.assign({ kind: 'villager', tags: v.task === 'spear' ? ['guard', 'villager'] : ['villager', 'merchant', 'guard'] }, v), kitRig(v.id, v) || buildVillager(v), { dlg: 'villager', lines: v.lines, task: v.task, portrait: v.id }));
    });
    // Selene the Moonbound: built once at init (hidden) so she never streams in with a shader-compile hitch
    const sel = mk({ id: 'selene', name: 'Selene the Moonbound', kind: 'companion', poi: 'fen', tags: [], off: [97, -106], yaw: 0 }, heroRig('selene') || seleneFallback());
    sel.R.root.visible = false; npcs.list.push(sel); COMP.n = sel;
    placeAll();
    placedFromSpots = npcs.list.some(n => n.fromSpot);
    compInit();
  };

  const _pw = new T.Vector3(), _tl = new T.Vector3();
  npcs.update = function (dt, c) {
    if (!group) return;
    dt = dt || 0; time += dt;
    // World spots can appear late: re-place once if they show up.
    if (!placedFromSpots && CT.world && CT.world.spots) { spotCheckT += dt; if (spotCheckT > 0.5) { placeAll(); placedFromSpots = true; } }
    const night = CT.sky && CT.sky.isNight ? CT.sky.isNight() : false;
    RIM.value.set(night ? 0x8fb4ff : 0xffe0b0); RIMK.value = night ? 0.85 : 0.55;
    const pp = CT.player && CT.player.pos ? CT.player.pos : c.camera.position;
    const live = c.state === 'PLAY';
    npcs.list.forEach(n => {
      if (n.kind === 'companion') { compUpdate(n, dt, c, pp, live); return; }
      const R = n.R, dx = pp.x - n.pos.x, dz = pp.z - n.pos.z, d = Math.hypot(dx, dz);
      n.dist = d;
      R.root.visible = d < (R.hero ? 150 : 170);
      if (!R.root.visible) return;
      n.pos.y = H(n.pos.x, n.pos.z); R.root.position.copy(n.pos);
      // face the player within 8 m, else turn back home
      const want = d < 8 ? Math.atan2(dx, dz) : n.home;
      let da = want - n.yawNow; while (da > PI) da -= TAU; while (da < -PI) da += TAU;
      n.yawNow += da * Math.min(1, dt * (d < 8 ? 3 : 1.2)); R.root.rotation.y = n.yawNow;
      if (R.hero) { if (R.root.userData.update) R.root.userData.update(dt, time); }
      else if (R.kit) {
        if (n.talkT > 0) n.talkT -= dt;
        if (d < 90) CT.humanoid.animate(R, dt, time + R.ph, { look: d < 8 ? clamp(Math.atan2(dx, dz) - n.yawNow, -0.9, 0.9) : null, pitch: d < 8 ? 0.08 : 0, talk: n.talkT > 0 || (c.state === 'DIALOG' && d < 4), work: d > 6 ? R.work : null });
      }
      else if (d < 90) animate(n, time + R.ph, dt, d < 8 ? clamp(Math.atan2(dx, dz) - n.yawNow, -0.7, 0.7) : 0, d);
      if (live) barks(n, d);
    });
  };

  // ── Idle animation ─────────────────────────────────────────────────────────
  function animate(n, t, dt, look, d) {
    const R = n.R, st = R.stance || 1.5;
    const br = Math.sin(t * 1.7), sw = Math.sin(t * 0.42), sw2 = Math.sin(t * 0.42 + 1.2);
    R.chest.scale.set(1 + br * 0.012, 1 + br * 0.02, 1 + br * 0.03);
    R.body.position.x = sw * 0.028; R.body.position.y = 0.95 - Math.abs(sw) * 0.008 + br * 0.003;
    R.body.rotation.z = sw * 0.035; R.body.rotation.y = sw2 * 0.04;
    R.spine.rotation.z = -sw * 0.05; R.spine.rotation.x = br * 0.012 - 0.02;
    R.legs.forEach(L => { L.hip.rotation.z = L.s * 0.07 * st * 0.7 - sw * 0.04; L.knee.rotation.z = -L.s * 0.05 + sw * 0.02 * L.s; });
    R.head.rotation.y += ((look || Math.sin(t * 0.23) * 0.18) - R.head.rotation.y) * Math.min(1, dt * 4);
    R.head.rotation.x = Math.sin(t * 0.31) * 0.04 - (look ? 0.05 : 0);
    R.head.rotation.z = sw * 0.03;
    R.hair.forEach((h, i) => { h.rotation.x = 0.05 + Math.sin(t * 1.3 - i * 0.5) * 0.06; h.rotation.z = Math.sin(t * 0.9 - i * 0.4) * 0.05 - sw * 0.05; });
    if (R.cloak) { R.cloak.rotation.x = 0.1 + Math.sin(t * 1.1) * 0.04 + Math.sin(t * 2.7) * 0.015; R.cloak.rotation.z = -sw * 0.04; }
    if (R.orb) {
      R.orb.position.y = 2.17 + Math.sin(t * 1.3) * 0.04; R.orb.rotation.y = t * 0.6;
      R.orb.children[1].scale.setScalar(0.13 * (1 + Math.sin(t * 3.1) * 0.12));
      R.motes.forEach((m, i) => { const a = t * (1.4 + i * 0.3) + i * 2.1; m.position.set(Math.cos(a) * 0.15, Math.sin(a * 1.3) * 0.06, Math.sin(a) * 0.15); });
      if (R.palm) R.palm.scale.setScalar(0.03 * (1 + Math.sin(t * 4) * 0.3));
    }
    // villager tasks
    if (n.task === 'hoe' || n.task === 'sweep') {
      const k = n.task === 'hoe' ? Math.max(0, Math.sin(t * 2.2)) : Math.sin(t * 2.6);
      const A = R.arms[0], B = R.arms[1];
      if (n.task === 'hoe') { A.sh.rotation.set(-0.9 - k * 1.2, 0, -0.1); A.el.rotation.set(-0.3, 0, 0); B.sh.rotation.set(-0.8 - k * 1.0, 0, 0.25); B.el.rotation.set(-0.6, 0, 0); R.spine.rotation.x = 0.1 + k * 0.12; }
      else { A.sh.rotation.set(-0.5, k * 0.3, -0.2); A.el.rotation.set(-0.5, 0, 0); B.sh.rotation.set(-0.6, 0, 0.35 + k * 0.1); B.el.rotation.set(-0.8, 0, 0); R.spine.rotation.x = 0.12; R.spine.rotation.y = k * 0.15; }
    } else if (n.task === 'idle' && n.kind === 'villager') {
      R.arms.forEach(A => { A.sh.rotation.set(Math.sin(t * 0.5 + A.s) * 0.04, 0, A.s * 0.12); A.el.rotation.set(-0.15, 0, 0); });
    }
    if (n.talkT > 0) { n.talkT -= dt; R.head.rotation.x += Math.sin(t * 9) * 0.03; }
    // IK: re-solve hands onto props each frame (the body sways)
    if (R.ik.length && d < 60) {
      R.root.updateMatrixWorld(true);
      R.ik.forEach(k => { _pw.copy(k.p); R.root.localToWorld(_pw); R.spine.worldToLocal(_tl.copy(_pw)); ik(k.arm, _tl, k.pole); });
    }
  }

  // ── Barks ──────────────────────────────────────────────────────────────────
  const HERO_BARK = {
    kaela: () => ms() === 0 ? 'You. Salt-rat with the sword. Here. Now.' : F().graskDead && !F().kaelaBronze ? 'Blackhand\'s butcher! Come and collect what you are owed.' : ms() >= 6 ? 'Champion! The ale is on the crown tonight.' : null,
    vesna: () => !F().vesnaMet ? 'Oi! You with the rusty sword! Come say hello. I only bite wolves.' : has('alphapelt') ? 'Is that the alpha\'s pelt? Bring it here, bring it here!' : null,
    nyx: () => !F().nyxMet ? 'Closer, drowned one. The fen will not eat you while I am watching.' : qs('wraiths') === 1 ? 'The fen is quieter. Come, let me pay you.' : null,
    bram: () => qs('smith') === 1 ? 'Those pelts for me? Bring them here, lad!' : null,
    mag: () => null,
  };
  function barks(n, d) {
    if (time < barkNext) return;
    if (n.kind === 'villager') {
      if (d > 7 || time < n.barkT) return;
      n.barkT = time + 50 + (hash(n.id + time) % 40); barkNext = time + 9;
      say(n, n.lines[(n.barkI = (n.barkI || 0) + 1) % n.lines.length]); n.talkT = 2;
    } else if (d < 14) {
      const f = HERO_BARK[n.id], line = f && f(); if (!line) return;
      const key = 'bark_' + n.id + '_' + line.length; if (F()[key]) return;
      F()[key] = true; barkNext = time + 6; say(n, line); n.talkT = 2.5;
    }
  }
  function say(n, text) { bus.emit('notify', { text: `${n.kind === 'heroine' || n.kind === 'companion' || n.id === 'bram' ? n.name.split(' ')[0] : n.name}: ${text}`, kind: 'bark' }); }

  // ── Interaction ────────────────────────────────────────────────────────────
  npcs.nearestInteractable = function (pos, maxDist) {
    if (!pos) return null;
    let best = null, bd = maxDist || 3.2;
    npcs.list.forEach(n => { if (n.kind === 'companion' && !compOwned()) return; const d = Math.hypot(pos.x - n.pos.x, pos.z - n.pos.z); if (d < bd && Math.abs((pos.y || n.pos.y) - n.pos.y) < 4) { bd = d; best = n; } });
    return best;
  };
  npcs.find = id => npcs.list.find(n => n.id === id) || null;
  npcs.interact = function (n) {
    if (!n) return;
    open(n); n.talkT = 1.5;
    if (CT.audio && CT.audio.sfx) CT.audio.sfx('talk', { pos: n.pos });
    bus.emit('dialog', { npc: n });
  };
  npcs.resetDialog = function () { npcs.list.forEach(n => { n._view = null; n._node = null; }); localFlags = {}; };

  // ══════════════════════════════════════════════════════════════════════════
  // ── Dialog engine ──────────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  const RPG = () => CT.rpg || null;
  const F = () => (CT.rpg && CT.rpg.flags) || localFlags;
  const ms = () => { const q = RPG() && RPG().quest && RPG().quest('throne'); return q ? (q.done ? 6 : q.stage) : 0; };
  const qs = id => { const q = RPG() && RPG().quest && RPG().quest(id); return !q ? -1 : q.done ? 99 : q.stage; };
  const has = (id, n) => !!(RPG() && RPG().has && RPG().has(id, n));
  const cnt = id => (RPG() && RPG().count ? RPG().count(id) : 0);
  const grant = (id, n) => { if (RPG() && RPG().grant) RPG().grant(id, n || 1); };
  const take = (id, n) => !!(RPG() && RPG().take && RPG().take(id, n || 1));
  const gold = () => (RPG() && RPG().stats ? RPG().stats.gold : 0);
  const adv = (id, s) => { if (RPG() && RPG().advanceQuest) RPG().advanceQuest(id, s); };
  const start = id => { if (RPG() && RPG().startQuest) RPG().startQuest(id); };
  const equip = id => { if (RPG() && RPG().equip) RPG().equip(id); };
  const iname = id => (C.ITEMS[id] ? C.ITEMS[id].name : id);
  const ch = (id, text, go, fn) => ({ id, text, go: go === undefined ? null : go, fn });
  const bye = t => ch('bye', t || 'Farewell.', null);
  const node = (lines, choices) => ({ lines, choices });

  function open(n, id) { const D = DLG[n.dlg]; n._g = (n._g || 0) + 1; n._node = id || (D.start ? D.start(n) : 'root'); build(n); }
  function build(n) {
    const D = DLG[n.dlg], f = D.nodes[n._node] || D.nodes.root;
    const r = f(n) || node(['...'], []);
    if (!r.choices || !r.choices.length) r.choices = [bye()];
    if (r.choices.length > 5) r.choices = r.choices.slice(0, 4).concat(r.choices.slice(-1)); // the UI fits five
    n._view = { name: n.name, portrait: npcs.portrait(n.portrait), lines: r.lines, choices: r.choices.map(c => ({ id: c.id, text: c.text })), _c: r.choices };
  }
  npcs.dialog = function (n) {
    if (!n) return null; if (!n._view) open(n);
    return n._view;
  };
  npcs.choose = function (n, id) {
    if (!n) return 'close'; if (!n._view) open(n);
    const c = n._view._c.find(c => c.id === id); if (!c) return 'continue';
    let go = c.go;
    if (c.fn) { const r = c.fn(n); if (typeof r === 'string') go = r; }
    if (go === '@start') go = DLG[n.dlg].start ? DLG[n.dlg].start(n) : 'root';
    if (go == null) { n._view = null; n._node = null; return 'close'; }
    n._node = go; build(n); n.talkT = 1.2;
    return 'continue';
  };

  // Shared lore submenu: topics = {key: [label, lines]}
  function loreNodes(topics, intro) {
    const nodes = {
      lore: () => node(intro, Object.keys(topics).map(k => ch('lore_' + k, topics[k][0], 'lore_' + k)).concat([ch('back', 'Enough stories.', '@start')])),
    };
    Object.keys(topics).forEach(k => { nodes['lore_' + k] = () => node(topics[k][1], [ch('more', 'Ask something else.', 'lore'), ch('back', 'Back to the matter at hand.', '@start'), bye()]); });
    return nodes;
  }
  // Shared shop: stock [[id, price]]; buyback true lists sellable items.
  function shopNodes(stock, lineFn, sellKinds) {
    return {
      buy: () => node([lineFn(), `Your purse: ${gold()} gold.`],
        stock.map(([id, p]) => ch('buy_' + id, `${iname(id)}  (${p} gold)`, 'buy', () => { if (RPG() && RPG().buy) RPG().buy(id, p); })).concat([ch('back', 'Back.', '@start')])),
      sell: () => {
        const R = RPG(), inv = R ? R.inventory.filter(e => { const it = C.ITEMS[e.id]; return it && it.price && sellKinds.includes(it.kind) && !(Object.values(R.equipped).includes(e.id) && e.count <= 1); }) : [];
        return node([inv.length ? 'Show me what you carry. I pay fair. Fairly low, but fair.' : 'You have nothing I want. Come back with more than lint.', `Your purse: ${gold()} gold.`],
          inv.slice().sort((a, b) => R.sellPrice(b.id) * b.count - R.sellPrice(a.id) * a.count).slice(0, 7).map(e => ch('sell_' + e.id, `Sell ${iname(e.id)}${e.count > 1 ? ' x' + e.count : ''}  (+${R.sellPrice(e.id)} gold)`, 'sell', () => R.sell(e.id))).concat([ch('back', 'Back.', '@start')]));
      },
    };
  }

  const DLG = {};
  // ── Kaela Ironhand: proud, grim, commanding, dry ───────────────────────────
  DLG.kaela = {
    start: () => ms() === 0 ? (F().kaelaMet ? 'offer' : 'meet') : F().graskDead && !F().kaelaBronze ? 'reward' : 'root',
    nodes: Object.assign({
      meet: () => node(['So the sea spat out something with a sword. Good. Vael is short on those.',
        'I am Kaela Ironhand. My fathers held the Crimson Throne for nine hundred years. Now a dead man warms it.'],
        [ch('what', 'What do you want of me?', 'offer', () => { F().kaelaMet = true; }),
          ch('lore', 'Tell me of this dead man.', 'lore', () => { F().kaelaMet = true; }),
          ch('grim', 'Are you always this cheerful?', 'grim', () => { F().kaelaMet = true; }), bye('Another time, queen.')]),
      grim: () => node(['I laughed once. Then the dead ate my court.', 'I am saving the next laugh for his funeral. You may attend.'],
        [ch('what', 'What do you want of me?', 'offer'), bye()]),
      offer: () => node(['Grask Blackhand holds the camp north of here, on the old crossroads. He sells my people to the Bone King by the cartload.',
        'Kill him. Break the Blackhand, and I will know you are worth arming.'],
        [ch('accept', 'Grask dies. Consider it done.', 'accepted', () => { F().kaelaMet = true; if (ms() === 0) adv('throne', 1); grant('potion', 2); }),
          ch('pay', 'And what is in it for me?', 'pay'), ch('lore', 'First, tell me of Vael.', 'lore'), bye('Not today.')]),
      pay: () => node(['Bronze. The armour of my own guard, and the gratitude of a queen. The second is rarer.',
        'Also, the Blackhands have gold. Dead men guard it poorly.'],
        [ch('accept', 'Fair. Grask dies.', 'accepted', () => { F().kaelaMet = true; if (ms() === 0) adv('throne', 1); grant('potion', 2); }), bye('I will think on it.')]),
      accepted: () => node(['Good. Follow the old road north. Follow the smoke and the stink of cheap ale.',
        'Take these draughts. Drink them before you need them, not after.'],
        [ch('lore', 'Tell me more of this isle.', 'lore'), bye('I will be back with his hand.')]),
      reward: () => node(['Grask is dead and his camp is ash. The crows of Harrowby sing your name. Badly, but they sing it.',
        'Take the Queen\'s Bronze. It was my brother\'s. He liked fools who live. I think he would have liked you.'],
        [ch('take', 'I will wear it with pride.', 'reward2', () => { F().kaelaBronze = true; grant('bronze', 1); equip('bronze'); }),
          ch('refuse', 'Keep it. I fight for Vael, not for bronze.', 'reward3', () => { F().kaelaBronze = true; grant('bronze', 1); })]),
      reward2: () => node(['It suits you. Try not to put holes in it.', 'Now. The Bone King cannot be cut by any steel forged by men. We need moon-iron.'],
        [ch('next', 'Where do I find moon-iron?', 'root'), bye()]),
      reward3: () => node(['Noble. Stupid, but noble. I have put it in your pack anyway. Queens do not take no for an answer.'],
        [ch('next', 'What now?', 'root'), bye()]),
      root: () => {
        const s = ms(), L = {
          1: ['Grask still breathes. I can smell it on you.', 'The camp lies north on the old road. Follow the smoke.'],
          2: ['Only moon-iron bites the Bone King. Nyx of the Pale Moon knows where the last of it sleeps.', 'She lives east, in the Weeping Fen. Do not eat anything she offers you.'],
          3: ['Nyx sent you for the Moonblade? Then the guardian of Moonfall is still awake. It was built never to sleep.', 'Strike where the stone is cracked. Everything breaks where it broke before.'],
          4: ['You carry moon-iron now. I felt it from across the square. So will he.', 'North, through the Frozen Teeth. The cold there kills more men than the dead do.'],
          5: ['The citadel. My citadel. Break his throne and I will build a better one from the pieces.', 'If you die up there, I will be extremely annoyed.'],
          6: ['The Throne is broken. Vael breathes again. Listen: even the gulls sound less afraid.', 'Stay, and I name you my champion. Leave, and the songs will still get your name wrong.'],
        }[s] || ['Speak.'];
        return node(L, [ch('lore', 'Tell me of Vael and its curse.', 'lore'), ch('grim', 'Do you ever rest, queen?', 'rest'), bye()]);
      },
      rest: () => node([ms() >= 6 ? 'Tonight I will sleep for a week. Tomorrow I rebuild a kingdom.' : 'I will rest when he rots. Properly, this time.',
        'Now stop staring at me and go do something heroic.'], [ch('back', 'As you command.', 'root'), bye()]),
    }, loreNodes({
      king: ['Who is the Bone King?', ['He was Vardec, my father\'s sorcerer. He cut out his own heart and fed it to the throne-stone.', 'Now he does not die and he does not stop. Neither will I.']],
      throne: ['What is the Crimson Throne?', ['A seat hewn from a red star that fell on Vael when my line was young. It gives strength to whoever sits it.', 'It also drinks. Blood first. Then the rest of you.']],
      vael: ['Tell me of Vael.', ['Black rock, cold sea, good steel. My people were horse-lords and reavers.', 'Now they farm behind fences and pray the dead stay hungry somewhere else.']],
      curse: ['What is this curse?', ['The throne-stone feeds on Vardec, and Vardec feeds on us. Every grave on Vael answers to him now.', 'Wolves grow too big. The dead get up. The moon bleeds. Ask Nyx for the long answer. Bring a chair.']],
    }, ['Ask, then. I have time for one story before the dead come calling.'])),
  };

  // ── Nyx of the Pale Moon: cryptic, amused, dangerous ───────────────────────
  DLG.nyx = {
    start: () => !F().nyxMet ? 'meet' : qs('wraiths') === 1 ? 'wraithDone' : 'root',
    nodes: Object.assign({
      meet: () => node(['Ah. The drowned one walks. The frogs said you were coming. Frogs are terrible gossips.',
        ms() >= 2 ? 'Kaela sent you. She sends me all her prettiest knives, eventually.' : 'Nobody sent you. How refreshing. Most of my visitors are sent, or dead.'],
        [ch('blade', 'I need a weapon that can kill the Bone King.', 'blade', () => { F().nyxMet = true; }),
          ch('who', 'Who are you?', 'who', () => { F().nyxMet = true; }), bye('I will leave you to your frogs.')]),
      who: () => node(['Nyx. Of the Pale Moon, of the Fen, and of several things best left unsaid over supper.',
        'I was a priestess when those ruins still had roofs. I have aged rather well, do you not think?'],
        [ch('human', 'Are you... entirely human?', 'human'), ch('blade', 'I need a weapon that can kill the Bone King.', 'blade'), ch('lore', 'Tell me of the curse.', 'lore'), bye()]),
      human: () => node(['Mostly. On holy days, less so.', 'Would you like to guess which parts? No. You would guess wrong, and I would have to turn you into something with fewer opinions.'],
        [ch('back', 'I will not guess.', '@start'), bye()]),
      blade: () => node(['The Moonblade sleeps in Moonfall Ruins, south-east of my fen, held by a guardian of old stone and older spite.',
        'Take it, and the Bone King will finally feel something. Fear, I hope. It has been so long for him.'],
        [ch('take', 'Then I will take it.', 'blade2', () => { F().nyxMet = true; if (ms() === 2) adv('throne', 3); }), ch('lore', 'Why does moon-iron hurt him?', 'lore_moon'), bye()]),
      blade2: () => node(['Brave. Or very poorly informed. The two smell the same to me.',
        'Do not strike the guardian\'s shield. Strike the guardian. It sounds obvious. Most of them still hit the shield.'],
        qs('wraiths') < 0 ? [ch('more', 'Is there anything else?', 'wraithOffer'), bye()] : [bye()]),
      wraithOffer: () => node(['My fen is full of the pale dead. They wail all night and I cannot hear myself curse.',
        'Slay five for me. Steel passes through them, so wear my blessing. It is a little cold. You will get used to it.'],
        [ch('accept', 'Give me your blessing. The wraiths are mine.', 'wraithGo', () => { start('wraiths'); if (!has('moonblessing')) grant('moonblessing', 1); const R = RPG(); if (R && R.equipped && !R.equipped.charm) equip('moonblessing'); }),
          bye('Later. I have enough ghosts.')]),
      wraithGo: () => node(['There. The Pale Moon has kissed your blade. Figuratively. Do not look so hopeful.',
        'Five of them. Come back when the fen is quieter.'], [bye()]),
      wraithDone: () => node(['The fen is quieter. I almost miss them. Almost.',
        'Here. Troll-blood tonic, three flasks, and some coin. Do not ask how one milks a troll.'],
        [ch('claim', 'My thanks, sorceress.', 'root', () => { if (qs('wraiths') === 1) { adv('wraiths', 99); grant('bigpotion', 3); grant('gold', 120); take('wraithdust', cnt('wraithdust')); } })]),
      root: () => {
        const s = ms(), w = qs('wraiths'), q = RPG() && RPG().quest && RPG().quest('wraiths');
        const L = s >= 6 ? ['The moon is white again. How dull. How lovely.', 'You broke the throne. Somewhere, a star is very embarrassed.']
          : s === 5 ? ['When you stand before the Throne, do not look at it too long. It looks back.', 'And bring the blade home. I am fond of it. Less so of you. A little so of you.']
          : s === 4 ? ['The blade remembers the moon. Listen to it hum when he is near.', 'North, now. The Frozen Teeth. Mind the ice; it is thinner than it looks, like most kings.']
          : s === 3 ? ['Still no Moonblade? The guardian must be enjoying your company.', 'Moonfall Ruins. South-east. Strike the guardian, not the shield.']
          : w === 0 ? [`${(q && q.n) || 0} of five wraiths. I stopped counting at the screaming.`, 'Keep my blessing on you, or your sword will pass through them like a bad joke.']
          : ['Back again? The frogs will talk.', 'What do you want, drowned one?'];
        const c = [];
        if (s === 2 || (s < 2 && !F().nyxBlade)) c.push(ch('blade', 'Tell me of the Moonblade.', 'blade', () => { F().nyxBlade = true; }));
        if (w < 0 && s >= 2) c.push(ch('wraiths', 'You spoke of wraiths.', 'wraithOffer'));
        if (w === 0 && !has('moonblessing')) c.push(ch('bless', 'I lost your blessing.', 'root', () => grant('moonblessing', 1)));
        c.push(ch('buy', 'Sell me a tonic.', 'buy'), ch('lore', 'Tell me a secret.', 'lore'), bye());
        return node(L, c);
      },
    }, shopNodes([['bigpotion', 45], ['potion', 15]], () => 'Potions? I have potions. Most will not kill you.', []),
    loreNodes({
      curse: ['What is the curse?', ['The throne-stone is hungry. Vardec fed it his heart, and it fed him the dead.', 'Every corpse on Vael belongs to him a little now. Try not to become one.']],
      moon: ['Why does moon-iron hurt him?', ['The Pale Moon chased the red star across the sky once. Where it fell, she wept silver into the sea.', 'We forged her tears. The star remembers. The star is afraid.']],
      throne: ['What happens to one who sits the Throne?', ['You become a king forever.', 'Forever is a very long time to be a skeleton.']],
      kaela: ['What do you think of Kaela?', ['Proud as a mountain and about as easy to move. I adore her.', 'Never tell her. She would try to knight me, and I would have to curse her a little.']],
      vesna: ['And Vesna Red-Arrow?', ['The redhead with the bow? She shot an arrow through my hat once. On purpose. From two hundred paces.', 'I let her live. She makes me laugh, and that is rarer than moon-iron.']],
    }, ['A secret? I have hundreds. Most are other people\'s.'])),
  };

  // ── Vesna Red-Arrow: cocky, warm, teasing, loyal ───────────────────────────
  DLG.vesna = {
    start: () => !F().vesnaMet ? 'meet' : (qs('wolves') === 1 && has('alphapelt')) ? 'wolfDone' : 'root',
    nodes: Object.assign({
      meet: () => node(['Well, look at you. Salt in your hair and murder in your eyes. I like you already.',
        'Vesna Red-Arrow. Best bow on Vael, and the only one of us still sober.'],
        [ch('work', 'Any work for a sword?', 'wolfOffer', () => { F().vesnaMet = true; }),
          ch('trade', 'What are you selling?', 'buy', () => { F().vesnaMet = true; }),
          ch('flirt', 'Best bow on Vael? Prove it.', 'prove', () => { F().vesnaMet = true; }), bye('Maybe later, archer.')]),
      prove: () => node(['See that crow on the far pine? No? Exactly. It stopped existing about a heartbeat ago.',
        'Next time, bring me a harder question. And a bigger target.'], [ch('work', 'Any work for a sword?', 'wolfOffer'), bye()]),
      wolfOffer: () => qs('wolves') >= 0 ? node(['You already took my hunt. Unless you forgot. Did you hit your head on the way out of the sea?'], [ch('back', 'Right. The alpha.', 'root')])
        : node(['The Gnawing Hollow, west of here. The pack went wrong when the curse came. The alpha is as big as a pony and twice as mean.',
          'Kill it. Bring me its pelt. I pay in silver, steel, and my undying admiration.'],
        [ch('accept', 'Consider the beast skinned.', 'wolfGo', () => start('wolves')), ch('scared', 'Why not hunt it yourself?', 'why'), bye('Not today.')]),
      why: () => node(['I did. Put three arrows in its eye. It ate them. Then it came back.',
        'Arrows need a second opinion. You look like a second opinion.'], [ch('accept', 'Fine. I will get your pelt.', 'wolfGo', () => start('wolves')), bye()]),
      wolfGo: () => node(['Do not die out there. I would have to fetch the pelt myself, and I just washed my hair.',
        'The Hollow is west, past the black pines. Follow the bones.'], [bye('Keep the fire warm.')]),
      wolfDone: () => node(['Is that...? Gods, it is huge. You actually did it.',
        'Here. My charm, my second-best knife, and some coin. Do not tell anyone I am sentimental.'],
        [ch('claim', 'You are sentimental.', 'wolfDone2', () => { if (take('alphapelt', 1)) { adv('wolves', 99); grant('redbow', 1); grant('dagger', 1); grant('gold', 80); const R = RPG(); if (R && R.equipped && !R.equipped.charm) equip('redbow'); } })]),
      wolfDone2: () => node(['And you are bleeding on my floor. We all have our faults.', 'You and me, we would make a fine pack.'], [ch('back', 'What now?', 'root'), bye()]),
      root: () => {
        const s = ms(), w = qs('wolves');
        const L = s >= 6 ? ['The Bone King is dust, and the wolves are only wolves again.', 'Stay for a drink. Stay for a few. Nobody here will mind if you sleep till noon.']
          : s === 5 ? ['The citadel? Then come back alive, or I will track you into the afterlife and drag you home by the ear.', 'I am not joking. I have tracked worse, through worse.']
          : s === 4 ? ['I heard you pulled a sword from a stone monster. Show-off.', 'The Frozen Teeth are north. Wear furs. Wear two.']
          : w === 0 ? ['The alpha is still howling. I can hear it from here. So could you, if you stopped clanking.', 'West, to the Gnawing Hollow. Bring back the pelt, not excuses.']
          : ['Back again? You missed me. Admit it.', 'What will it be, sword-arm?'];
        const c = [];
        if (w < 0) c.push(ch('work', 'Any work for a sword?', 'wolfOffer'));
        c.push(ch('trade', 'Let us trade.', 'buy'), ch('sellpelt', `Sell a wolf pelt (8 gold, you have ${cnt('pelt')})`, 'root', () => { if (take('pelt', 1)) { grant('gold', 8); } }),
          ch('lore', 'Tell me about Vael.', 'lore'), bye());
        return node(L, c);
      },
    }, shopNodes([['furs', 30], ['potion', 15], ['dagger', 60]], () => 'Furs I skinned, draughts I brewed, knives I sharpened. All good. The furs are best.', []),
    loreNodes({
      vael: ['What is Vael like?', ['Good hunting, bad weather, worse neighbours.', 'The dead ones are the worst neighbours. They never bring anything back.']],
      king: ['Have you seen the Bone King?', ['Never seen him. Seen his work. Villages with the doors open and nobody home.', 'I aim to see him once. Down the length of an arrow.']],
      wolves: ['What happened to the wolves?', ['They used to be ordinary. Hungry, clever, beautiful.', 'Now they come back after you kill them. Sometimes. Keep the head off, to be sure.']],
      kaela: ['What do you make of Kaela?', ['The queen? She once drank me under the table and then gave a speech. Standing up. On the table.', 'I would follow her into the citadel. I would complain the whole way, but I would follow.']],
    }, ['Stories cost a smile. You have paid. Go on.'])),
  };

  // ── Bram the smith ─────────────────────────────────────────────────────────
  DLG.bram = {
    start: () => 'root',
    nodes: Object.assign({
      root: () => {
        const s = qs('smith'), c = [ch('buy', 'Show me your steel.', 'buy'), ch('sell', 'I have things to sell.', 'sell')];
        if (s < 0) c.push(ch('job', 'I want better steel than this.', 'job'));
        if (s === 1 || (s === 0 && cnt('pelt') >= 5)) c.push(ch('pelts', 'Five wolf pelts, as promised.', 'done', () => { if (take('pelt', 5)) { adv('smith', 99); grant('steelsword', 1); } }));
        c.push(bye());
        return node([s === 0 ? `How many pelts? ${cnt('pelt')}? I need five, not "some".` : ms() >= 6 ? 'The Bone King is dead and I still have to shoe horses. Heroes get songs. Smiths get calluses.' : 'Steel is hot, talk is cheap. What will it be?'], c);
      },
      job: () => node(['That rusted twig? I would not cut cheese with it.', 'Bring me five wolf pelts: grips for the swords, leather for the bellows. Do that, and I forge you a Harrowby longsword.'],
        [ch('accept', 'Five pelts. Done.', 'root', () => start('smith')), bye('Maybe later.')]),
      done: () => node(['Good pelts. Barely any teeth marks.', 'Here. A Harrowby longsword. Balanced, sharp, and it will outlive you, if you are careless.'],
        [ch('equip', 'Equip it now.', 'root', () => equip('steelsword')), bye()]),
    }, shopNodes([['handaxe', 40], ['mail', 150], ['furs', 30], ['steelsword', 160]], () => 'Axes, mail, furs. Good work, fair price. Fairish.', ['weapon', 'armor', 'loot'])),
  };

  // ── Old Mag, the tavern keeper ─────────────────────────────────────────────
  const RUMOURS = [
    ['They say Grask Blackhand keeps a troll on a chain. They say a lot of things. Half of them are true.'],
    ['The witch in the fen is older than this tavern. Older than the hill it sits on, if you ask me.'],
    ['Vesna Red-Arrow drinks here on feast days. She wins every contest and pays for nothing.'],
    ['Pilgrims say the Nine Stones hum at night. I say pilgrims drink too much.'],
    ['Some fool took a torch to the Frozen Teeth last winter. We found the torch in the spring.'],
  ];
  DLG.mag = {
    start: () => 'root',
    nodes: Object.assign({
      root: () => node([ms() >= 6 ? 'The Bone King is dead! Drinks are free tonight. Well. Half price.' : 'Sit, dearie, before you fall down. You have the look of someone the sea did not want.'],
        [ch('buy', 'I need draughts.', 'buy'), ch('ale', 'An ale. (2 gold)', 'ale', () => {
          if (gold() < 2) return 'broke'; take('gold', 2); const p = CT.player; if (p && p.heal) p.heal(15);
        }), ch('rumour', 'Heard any rumours?', 'rumour', () => { F().magR = ((F().magR || 0) + 1) % RUMOURS.length; }), ch('sell', 'Will you buy anything?', 'sell'), bye()]),
      ale: () => node(['Tastes like wet boots. Heals like a prayer.', 'Drink up. You are paying for the mug too, if you break it.'], [ch('back', 'Another word.', 'root'), bye()]),
      broke: () => node(['No coin, no ale. The Bone King himself would pay. Well. He would try to eat me first.'], [ch('back', 'Fair.', 'root'), bye()]),
      rumour: () => node(RUMOURS[F().magR || 0], [ch('rumour', 'Another rumour.', 'rumour', () => { F().magR = ((F().magR || 0) + 1) % RUMOURS.length; }), ch('back', 'Back.', 'root'), bye()]),
    }, shopNodes([['potion', 15], ['bigpotion', 45]], () => 'Healing draughts, fresh this week. The tonic is troll blood. Do not smell it first.', ['potion', 'loot'])),
  };

  // ── Selene the Moonbound: sultry, dry, loyal, grim jokes, smokes and beer ───
  function stashList(give) {
    const R = RPG(), c = comp(); if (!R || !c) return [];
    const src = give ? R.inventory.filter(e => R.canStash(e.id)) : c.stash;
    return src.slice(0, 4).map(e => ch((give ? 'give_' : 'take_') + e.id, `${give ? 'Give' : 'Take'} ${iname(e.id)}${e.count > 1 ? ' x' + e.count : ''}`, give ? 'give' : 'take', () => { if (give) R.stash(e.id, e.count); else R.unstash(e.id, e.count); }));
  }
  DLG.selene = {
    start: () => !F().seleneMet ? 'meet' : 'root',
    nodes: {
      meet: () => node(['The moon sent me. Your coin keeps me. Do not confuse the two.',
        'Selene. I carry your junk, I patch your holes, and I do not do mornings.'],
        [ch('ok', 'Good to have you, Selene.', 'root', () => { F().seleneMet = true; }), ch('why', 'The moon sent me a bodyguard with a beer?', 'why', () => { F().seleneMet = true; })]),
      why: () => node(['The moon has taste.', 'And I am not a bodyguard. I am the one who drags you home when you forget to duck.'], [ch('back', 'Fair enough.', 'root')]),
      root: () => {
        const c = comp() || {}, f = !!c.following;
        const L = f ? (ms() >= 6 ? ['The Bone King is dust and I am out of excuses to drink. Just kidding. I never needed excuses.']
            : c.beers <= 1 ? ['We are nearly dry. One beer between us and a slow death.', 'Nyx\'s hut, or Old Mag\'s. Soon.']
            : ['Lead on. I will be three steps behind, judging your footwork.', `Smokes: ${c.smokes}. Beers: ${c.beers}. Enough to get us both killed slowly.`])
          : ['Back for me? I knew you would miss the smell of smoke.', 'Say the word and I walk with you.'];
        const cs = f ? [ch('give', 'Carry these for me.', 'give'), ch('take', 'Hand me my things.', 'take'), ch('supply', 'How are we on smokes and beer?', 'supply'), ch('wait', 'Wait for me at Nyx\'s hut.', 'waiting', () => { npcs.companionDismiss(); })]
          : [ch('follow', 'Walk with me.', 'following', () => { const cc = comp(); if (cc) { cc.following = true; bus.emit('companion', { id: 'selene', following: true }); } }), ch('take', 'Hand me my things.', 'take'), ch('supply', 'How are we on smokes and beer?', 'supply')];
        return node(L, cs.concat([bye()]));
      },
      give: () => { const l = stashList(true); return node([l.length ? 'Hand it over. I will try not to sell it.' : 'You have nothing I can carry. Your sword stays with you. Obviously.'], l.concat([ch('back', 'That is all.', 'root')])); },
      take: () => { const l = stashList(false); return node([l.length ? 'Your things. Mostly unharmed.' : 'I am carrying nothing of yours. Just my smokes, and those are mine.'], l.concat([ch('back', 'That is all.', 'root')])); },
      supply: () => { const c = comp() || {}; return node([`Smokes: ${c.smokes}. Beers: ${c.beers}.`, c.beers > 0 ? 'One cold one is always saved for you. For when you die. You will.' : 'No beer left. So please do not die.'], [ch('back', 'Good to know.', 'root'), bye()]); },
      waiting: () => node(['Fine. I will be at the witch\'s hut, drinking her out of house and home.', 'Come find me when you miss me. You will.'], [bye('Stay out of trouble.')]),
      following: () => node(['About time. Try to keep up.'], [bye('Let us go.')]),
    },
  };
  // Nyx sells the Moon Pact once you have met her; she re-summons and restocks Selene for free.
  const PACT_PRICE = 350;
  Object.assign(DLG.nyx.nodes, {
    pact: () => node(['The Moon Pact. There is a woman bound to the Pale Moon: Selene. She serves whoever holds the pact, for as long as the coin holds.',
      `${PACT_PRICE} gold. She will carry your burdens and patch your wounds. She also smokes. I have stopped arguing with her.`],
      [ch('buy_pact', `Seal the pact. (${PACT_PRICE} gold)`, 'pactDone', () => {
        const c = comp(); if (!c || c.owned) return 'root';
        if (gold() < PACT_PRICE) return 'pactBroke';
        take('gold', PACT_PRICE); if (CT.rpg.restockCompanion) CT.rpg.restockCompanion(); npcs.companionSummon();
      }), ch('back', 'Not yet.', 'root')]),
    pactDone: () => node(['Done. The moon listens. Moonlight is gathering behind you.', 'Turn around slowly. She hates being startled, and she hates being stared at even more.'], [bye()]),
    pactBroke: () => node(['Coin first, drowned one. The moon is sentimental. I am not.'], [ch('back', 'Another time.', 'root'), bye()]),
  });
  const nyxRoot = DLG.nyx.nodes.root;
  DLG.nyx.nodes.root = () => {
    const r = nyxRoot(), c = comp();
    if (F().nyxMet && c) {
      const pc = !c.owned ? ch('pact', 'Tell me of the Moon Pact.', 'pact')
        : !c.following ? ch('summon', 'Call Selene to my side.', 'root', () => { npcs.companionSummon(); })
        : ch('restock', 'Restock Selene\'s smokes and beer.', 'root', () => { if (CT.rpg.restockCompanion) CT.rpg.restockCompanion(); bus.emit('notify', { text: 'Selene: Smokes and cold ones. Bless you, witch.', kind: 'bark' }); });
      const i = r.choices.findIndex(x => x.id === 'buy'); r.choices.splice(i < 0 ? r.choices.length - 1 : i, 0, pc);
    }
    return r;
  };
  const magBuy = DLG.mag.nodes.buy;
  DLG.mag.nodes.buy = () => {
    const r = magBuy(), c = comp();
    if (c && c.owned) r.choices.splice(r.choices.length - 1, 0, ch('supply', 'Smokes and a six-pack for Selene. (12 gold)', 'buy', () => {
      if (gold() < 12) { bus.emit('notify', { text: 'Not enough gold.', kind: 'info' }); return; }
      take('gold', 12); if (CT.rpg.restockCompanion) CT.rpg.restockCompanion(); bus.emit('notify', { text: 'Selene is restocked: 12 smokes, 6 beers.', kind: 'loot' });
    }));
    return r;
  };

  // ── Villagers ──────────────────────────────────────────────────────────────
  DLG.villager = {
    start: () => 'root',
    nodes: {
      root: n => node([n.lines[(n._g || 0) % n.lines.length]], [ch('news', 'Any news?', 'news'), bye()]),
      news: n => node([n.lines[((n._g || 0) + 1) % n.lines.length]], [bye('Stay safe.')]),
    },
  };

  // ══════════════════════════════════════════════════════════════════════════
  // ── Portraits: 64x80 procedural paintings, dithered, upscaled x4 ──────────
  // ══════════════════════════════════════════════════════════════════════════
  const PW = 64, PH = 80, CX = 32, PCACHE = {};
  const BAY = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  function fillP(c, col, pts) { c.fillStyle = col; c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); c.fill(); }
  function blobP(c, col, pts) { // smooth closed curve through the midpoints
    c.fillStyle = col; c.beginPath(); const n = pts.length, m = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const s = m(pts[n - 1], pts[0]); c.moveTo(s[0], s[1]);
    for (let i = 0; i < n; i++) { const p = pts[i], q = m(p, pts[(i + 1) % n]); c.quadraticCurveTo(p[0], p[1], q[0], q[1]); }
    c.closePath(); c.fill();
  }
  function ellP(c, col, x, y, rx, ry, rot) { c.fillStyle = col; c.beginPath(); c.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), rot || 0, 0, TAU); c.fill(); }
  function lin(c, x0, y0, x1, y1, stops) { const g = c.createLinearGradient(x0, y0, x1, y1); stops.forEach(([k, col]) => g.addColorStop(k, col)); return g; }
  function rad(c, x, y, r, stops) { const g = c.createRadialGradient(x, y, 0, x, y, r); stops.forEach(([k, col]) => g.addColorStop(k, col)); return g; }
  function strokes(c, rnd, n, cols, x0, y0, x1, y1, len, w, ang, alpha) {
    c.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      const x = x0 + rnd() * (x1 - x0), y = y0 + rnd() * (y1 - y0), a = ang + (rnd() - 0.5) * 0.5, l = len * (0.5 + rnd());
      c.strokeStyle = cols[(rnd() * cols.length) | 0]; c.globalAlpha = alpha * (0.5 + rnd() * 0.5); c.lineWidth = w * (0.5 + rnd());
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); c.stroke();
    }
    c.globalAlpha = 1;
  }
  const px = (c, col, x, y, w, h) => { c.fillStyle = col; c.fillRect(x, y, w || 1, h || 1); };
  function crags(c, rnd, y0, amp, col, step) {
    const pts = [[0, PH]]; for (let x = 0; x <= PW + step; x += step) pts.push([x, y0 - rnd() * amp - (x % (step * 3) === 0 ? amp * 0.6 : 0)]);
    pts.push([PW, PH]); fillP(c, col, pts);
  }
  function pine(c, col, x, y, h) { for (let i = 0; i < 4; i++) { const w = h * (0.34 - i * 0.06), yy = y - i * h * 0.22; fillP(c, col, [[x - w, yy], [x + w, yy], [x, yy - h * 0.34]]); } px(c, col, x - 1, y, 2, h * 0.2); }

  // ── Face (fg layer: shapes; det layer: pixel-exact features) ──────────────
  function paintFace(f, d, o) {
    const E = o.E || 30, hw = o.hw || 9, jw = o.jw || 2.5, S = o.skin, sh = o.side || 1; // sh: shadow side (+1 right)
    // neck (narrow at the jaw, flaring into the shoulders)
    const nw = 4 + (o.neckW || 0);
    fillP(f, S.shade, [[CX - nw, E + 8], [CX + nw, E + 8], [CX + nw + 1, E + 17], [CX + nw + 7, E + 23], [CX - nw - 7, E + 23], [CX - nw - 1, E + 17]]);
    fillP(f, S.base, [[CX - nw * sh, E + 12], [CX - 1 * sh, E + 13], [CX - 2 * sh, E + 23], [CX - (nw + 7) * sh, E + 23], [CX - (nw + 1) * sh, E + 17]]);
    fillP(f, S.deep, [[CX - nw, E + 9], [CX + nw, E + 9], [CX + nw, E + 13], [CX - nw, E + 12]]);
    fillP(f, S.shade, [[CX - 1, E + 17], [CX + 1, E + 17], [CX + 2, E + 22], [CX - 2, E + 22]]);
    const head = [[CX - hw + 1, E - 12], [CX, E - 15], [CX + hw - 1, E - 12], [CX + hw, E - 5], [CX + hw, E + 2], [CX + hw - 1, E + 6], [CX + jw + 3, E + 11], [CX + jw, E + 14], [CX, E + 15], [CX - jw, E + 14], [CX - jw - 3, E + 11], [CX - hw + 1, E + 6], [CX - hw, E + 2], [CX - hw, E - 5]];
    // ears
    ellP(f, S.shade, CX - hw - 0.5, E + 2, 1.6, 3); ellP(f, S.shade, CX + hw + 0.5, E + 2, 1.6, 3);
    blobP(f, S.base, head);
    f.save(); f.beginPath(); head.forEach(([x, y], i) => (i ? f.lineTo(x, y) : f.moveTo(x, y))); f.closePath(); f.clip();
    // shadow side, jaw shadow, sockets, highlights
    const X = v => CX + v * sh;
    fillP(f, S.shade, [[X(2), E - 16], [X(hw + 3), E - 16], [X(hw + 3), E + 17], [X(1), E + 17], [X(3), E + 10], [X(2), E + 5], [X(3), E], [X(4), E - 6], [X(3), E - 12]]);
    fillP(f, S.deep, [[X(hw - 1.5), E - 14], [X(hw + 3), E - 14], [X(hw + 3), E + 16], [X(3), E + 16], [X(hw - 2), E + 8]]);
    ellP(f, S.shade, CX - 4.5, E - 0.8, 3.6, 2.2); ellP(f, S.shade, CX + 4.5, E - 0.8, 3.6, 2.2);
    f.globalAlpha = 0.55; fillP(f, S.shade, [[X(-hw), E + 5], [X(-5), E + 7], [X(-3), E + 10], [X(-hw + 1), E + 8]]); f.globalAlpha = 1;
    fillP(f, S.deep, [[X(hw - 3), E + 4], [X(4), E + 7], [X(3), E + 9], [X(hw - 2), E + 7]]);
    ellP(f, S.light, X(-4.5), E + 4, 2.6, 1.8); ellP(f, S.light, X(-2.5), E - 8, 4.5, 2.4);
    fillP(f, S.shade, [[CX - jw - 4, E + 12], [CX + jw + 4, E + 12], [CX + jw + 2, E + 16], [CX - jw - 2, E + 16]]);
    if (o.blush) { ellP(f, o.blush, CX - 5, E + 5, 2, 1.2); ellP(f, o.blush, CX + 5, E + 5, 2, 1.2); }
    f.restore();
    // details
    const scl = o.sclera || '#e6d6c6', lash = o.lash || '#140a0a', iris = o.iris, pupil = o.pupil || '#0a0406';
    [[CX - 7, -1], [CX + 2, 1]].forEach(([x0, s]) => {
      const shaded = s === sh;
      px(d, lash, x0, E - 1, 5, 1); if (!o.shadow) px(d, S.shade, x0 + 1, E - 2, 3, 1);
      px(d, shaded ? mix(scl, S.shade, 0.5) : scl, x0, E, 5, 1);
      px(d, iris, x0 + 1, E, 3, 1); px(d, pupil, x0 + 2, E, 1, 1);
      px(d, mix(iris, '#ffffff', 0.55), x0 + (s < 0 ? 1 : 1), E, 1, 1);
      px(d, S.shade, x0 + 1, E + 1, 3, 1);
      if (o.fem) px(d, lash, s < 0 ? x0 - 1 : x0 + 5, E - 2, 1, 1);
      if (o.glow) { px(d, o.glow, x0 + 1, E, 1, 1); px(d, o.glow, x0 + 3, E, 1, 1); }
      if (o.shadow) px(d, o.shadow, x0, E - 2, 5, 1);
      // brows
      const b = o.brow, st = o.browStyle || 'flat', inner = s < 0 ? x0 + 4 : x0, outer = s < 0 ? x0 - 1 : x0 + 5, dir = s < 0 ? 1 : -1;
      let ys;
      if (st === 'fierce') ys = [-4, -4, -4, -3, -3, -2];
      else if (st === 'arched') ys = [-2, -3, -4, -4, -4, -3];
      else if (st === 'raised') ys = [-4, -5, -5, -5, -4, -4];
      else ys = [-3, -4, -4, -4, -3, -3];
      if (o.cocky && s > 0) ys = [-4, -5, -6, -6, -5, -5].reverse();
      for (let i = 0; i < 6; i++) { const xx = outer + dir * i; px(d, b, xx, E + (s < 0 ? ys[i] : ys[i]), 1, 1); if (o.thickBrow) px(d, b, xx, E + ys[i] - 1, 1, 1); }
      void inner;
    });
    // nose
    px(d, S.shade, X(1), E + 1, 1, 4); px(d, S.light, X(-1), E + 1, 1, 3); px(d, S.light, CX - 1, E + 4, 1, 1);
    px(d, S.deep, CX - 3, E + 6, 1, 1); px(d, S.deep, CX + 2, E + 6, 1, 1); px(d, S.shade, CX - 2, E + 6, 4, 1);
    px(d, mix(S.shade, S.deep, 0.5), CX - 1, E + 7, 2, 1);
    // mouth
    const M = E + 9, lip = o.lips || '#8a3a30';
    if (!o.hideMouth) {
      px(d, mix(lip, '#1a0808', 0.45), CX - 3, M, 6, 1);
      px(d, lip, CX - 2, M + 1, 4, 1); px(d, mix(lip, '#ffffff', 0.3), CX - 1, M + 1, 1, 1);
      px(d, mix(lip, S.deep, 0.5), CX - 4, M, 1, 1); px(d, mix(lip, S.deep, 0.5), CX + 3, M, 1, 1);
      if (o.smirk) { px(d, mix(lip, '#1a0808', 0.45), CX + 3, M - 1, 1, 1); px(d, S.shade, CX + 4, M - 1, 1, 1); }
      if (o.smile) { px(d, S.shade, CX - 5, M - 1, 1, 1); px(d, S.shade, CX + 4, M - 1, 1, 1); }
      px(d, S.shade, CX - 1, M + 3, 2, 1);
    }
  }
  function braid(f, d, pts, cols, w) {
    pts.forEach(([x, y], i) => { const col = i % 2 ? cols[1] : cols[0]; ellP(f, col, x, y, w, w * 0.75, i % 2 ? 0.5 : -0.5); });
    pts.forEach(([x, y], i) => { px(d, cols[2], Math.round(x - w * 0.4), Math.round(y - 1), 1, 1); });
  }

  // ── Composite: posterise + Bayer dither, rim light, dark outline ───────────
  function finish(bg, fg, det, o) {
    const B = bg.getContext('2d').getImageData(0, 0, PW, PH).data, Fd = fg.getContext('2d').getImageData(0, 0, PW, PH).data, D = det.getContext('2d').getImageData(0, 0, PW, PH).data;
    const small = canvas(PW, PH), sc = small.getContext('2d'), out = sc.createImageData(PW, PH), od = out.data;
    const inF = (x, y) => x >= 0 && y >= 0 && x < PW && y < PH && Fd[(y * PW + x) * 4 + 3] > 110;
    const rim = rgb(o.rim || '#ffb060'), ol = rgb(o.outline || '#120606'), top = rgb(o.top || o.rim || '#ffb060'), rs = o.rimSide || 1;
    const q = (v, L, b) => clamp(Math.round((v / 255) * (L - 1) + b) / (L - 1) * 255, 0, 255);
    for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
      const i = (y * PW + x) * 4, b = BAY[(y & 3) * 4 + (x & 3)] / 16 - 0.47;
      let r, g, bl;
      if (inF(x, y)) {
        r = Fd[i]; g = Fd[i + 1]; bl = Fd[i + 2];
        let k = 0;
        if (!inF(x + rs, y)) k = 0.62; else if (!inF(x + 2 * rs, y)) k = 0.28;
        if (k) { r += (rim[0] - r) * k; g += (rim[1] - g) * k; bl += (rim[2] - bl) * k; }
        if (!inF(x, y - 1)) { r += (top[0] - r) * 0.3; g += (top[1] - g) * 0.3; bl += (top[2] - bl) * 0.3; }
        if (!inF(x - rs, y)) { r *= 0.7; g *= 0.62; bl *= 0.62; }
        r = q(r, 15, b * 0.6); g = q(g, 15, b * 0.6); bl = q(bl, 15, b * 0.6);
      } else {
        r = B[i]; g = B[i + 1]; bl = B[i + 2];
        const nb = inF(x - 1, y) || inF(x + 1, y) || inF(x, y - 1) || inF(x, y + 1);
        if (nb) { const k = inF(x - rs, y) ? 0.2 : 0.72; r += (ol[0] - r) * k; g += (ol[1] - g) * k; bl += (ol[2] - bl) * k; }
        r = q(r, 10, b * 0.8); g = q(g, 10, b * 0.8); bl = q(bl, 10, b * 0.8);
      }
      if (D[i + 3] > 110) { r = D[i]; g = D[i + 1]; bl = D[i + 2]; }
      od[i] = r; od[i + 1] = g; od[i + 2] = bl; od[i + 3] = 255;
    }
    sc.putImageData(out, 0, 0);
    const big = canvas(256, 320), bc = big.getContext('2d');
    bc.imageSmoothingEnabled = false; bc.drawImage(small, 0, 0, 256, 320);
    return big;
  }

  const PAINT = {};
  // Portraits match the sculpted models in heroines.js (outfits, hair, paint). Skin ramps are built from each DEF skin.
  PAINT.kaela = function (b, f, d, rnd) {
    // burning sunset over crags, smoke
    b.fillStyle = lin(b, 0, 0, 0, PH, [[0, '#14040a'], [0.3, '#4a0c0c'], [0.55, '#a8300e'], [0.72, '#e87a24'], [0.8, '#f4b050'], [1, '#6a1a08']]); b.fillRect(0, 0, PW, PH);
    b.fillStyle = rad(b, 16, 58, 26, [[0, 'rgba(255,220,140,0.9)'], [0.4, 'rgba(255,150,60,0.5)'], [1, 'rgba(255,120,40,0)']]); b.fillRect(0, 0, PW, PH);
    strokes(b, rnd, 40, ['#2a0808', '#5a1410', '#8a2a12'], 0, 0, PW, 44, 14, 2.5, -0.25, 0.55);
    strokes(b, rnd, 25, ['#ffb060', '#ff8a3a'], 0, 40, PW, 60, 8, 1, -0.1, 0.4);
    crags(b, rnd, 64, 10, '#2a0a06', 6); crags(b, rnd, 72, 6, '#160404', 4);
    // skin ramp from DEF.kaela.skin #b98e6c: warm olive mid, peach-tan light, warm brown only in the deep creases
    const S = { base: '#da9864', shade: '#b46e46', deep: '#7e4a2e', light: '#f8c890' };
    const hair = ['#140c10', '#241822', '#4a3a4a'];
    // wolf-fur cape behind the shoulders
    blobP(f, '#3e342c', [[2, 58], [12, 50], [CX, 52], [PW - 12, 50], [PW - 2, 58], [PW, 80], [0, 80]]);
    for (let i = 0; i < 16; i++) { const x = 2 + i * 4 + rnd() * 2; fillP(f, i % 2 ? '#6e6050' : '#524638', [[x - 2.5, 52 + rnd() * 3], [x + 2.5, 52 + rnd() * 3], [x + (rnd() - 0.5) * 2, 60 + rnd() * 4]]); }
    // long loose black hair behind
    blobP(f, hair[0], [[CX - 13, 13], [CX, 8], [CX + 13, 13], [CX + 17, 30], [CX + 19, 50], [CX + 14, 58], [CX - 14, 58], [CX - 18, 34]]);
    fillP(f, hair[0], [[CX + 14, 20], [CX + 24, 30], [CX + 29, 27], [CX + 22, 38], [CX + 16, 34]]);
    // bare shoulders and chest, lit from the left
    f.fillStyle = lin(f, CX - 26, 0, CX + 26, 0, [[0, S.light], [0.4, S.base], [1, S.shade]]);
    blobP(f, f.fillStyle, [[CX - 10, 50], [CX + 10, 50], [CX + 24, 57], [CX + 27, 80], [CX - 27, 80], [CX - 24, 57]]);
    // bronze scale top at the bottom edge, leather straps over the shoulders
    const topP = [[CX - 21, 73], [CX - 12, 68], [CX - 3, 71], [CX, 73], [CX + 3, 71], [CX + 12, 68], [CX + 21, 73], [CX + 22, 80], [CX - 22, 80]];
    f.fillStyle = lin(f, CX - 22, 0, CX + 22, 0, [[0, '#e8b050'], [0.45, '#b27a2c'], [1, '#6a4012']]); fillP(f, f.fillStyle, topP);
    for (let y = 71; y < 80; y += 2) for (let x = CX - 20 + (y % 4 ? 1 : 0); x < CX + 21; x += 3) px(d, (x < CX) ? '#f4cc70' : '#8a5a1c', x, y);
    f.strokeStyle = '#4a2a10'; f.lineWidth = 0.9; f.beginPath(); f.moveTo(CX - 12, 68); f.lineTo(CX - 15, 51); f.moveTo(CX + 12, 68); f.lineTo(CX + 15, 51); f.stroke();
    [[CX - 12, 55], [CX - 8, 56], [CX + 8, 56], [CX + 12, 55]].forEach(([x, y]) => px(d, S.shade, x, y, 2, 1));   // collarbones
    // spiked bronze pauldron on her right shoulder (viewer's left)
    f.fillStyle = lin(f, 0, 50, 0, 66, [[0, '#f0c062'], [0.5, '#b8822e'], [1, '#6a4012']]);
    blobP(f, f.fillStyle, [[CX - 29, 65], [CX - 28, 56], [CX - 22, 51], [CX - 14, 52], [CX - 11, 58], [CX - 15, 65]]);
    [[CX - 25, 52], [CX - 20, 50], [CX - 15, 51]].forEach(([x, y]) => fillP(f, '#d8a848', [[x - 1.6, y + 1], [x + 1.6, y + 1], [x - 1, y - 6]]));
    px(d, '#ffe6a0', CX - 24, 55, 3, 1); px(d, '#6a4012', CX - 27, 61, 10, 1);
    paintFace(f, d, { E: 30, hw: 9, jw: 2.5, skin: S, iris: '#5a3212', brow: '#0e0808', browStyle: 'fierce', lips: '#9a1e1c', fem: true, side: 1 });
    // hair front: centre part, sweeps to the temples
    blobP(f, hair[0], [[CX - 10, 24], [CX - 11, 15], [CX - 3, 11], [CX, 14], [CX - 5, 17], [CX - 8, 22]]);
    blobP(f, hair[0], [[CX + 10, 24], [CX + 11, 15], [CX + 3, 11], [CX, 14], [CX + 5, 17], [CX + 8, 22]]);
    fillP(f, hair[0], [[CX - 11, 20], [CX - 9, 22], [CX - 9, 38], [CX - 12, 44]]); fillP(f, hair[0], [[CX + 11, 20], [CX + 9, 22], [CX + 9, 38], [CX + 12, 44]]);
    f.strokeStyle = hair[2]; f.lineWidth = 0.8; f.beginPath(); f.moveTo(CX - 9, 20); f.quadraticCurveTo(CX - 8, 12, CX - 1, 12); f.stroke();
    f.beginPath(); f.moveTo(CX + 2, 12); f.quadraticCurveTo(CX + 8, 12, CX + 10, 19); f.stroke();
    // the long braid falls over her right shoulder, behind the pauldron line
    const bp = []; for (let i = 0; i < 8; i++) bp.push([CX - 11 - i * 0.5, 44 + i * 4.4]);
    braid(f, d, bp, [hair[1], hair[0], '#6a5a6a'], 2.8);
    // scar
    [[CX - 8, 32], [CX - 7, 33], [CX - 6, 34], [CX - 6, 35]].forEach(([x, y]) => px(d, '#e0aa90', x, y));
    return { rim: '#ffb050', rimSide: 1, top: '#ffcf80', outline: '#1a0604', key: -1, keyCol: 'rgba(255,214,160,0.2)', darkCol: 'rgba(40,10,20,0.2)' };
  };
  PAINT.nyx = function (b, f, d, rnd) {
    b.fillStyle = lin(b, 0, 0, 0, PH, [[0, '#04041a'], [0.4, '#141038'], [0.75, '#2a2054'], [1, '#0c0a20']]); b.fillRect(0, 0, PW, PH);
    for (let i = 0; i < 40; i++) px(b, rnd() < 0.3 ? '#d8d8ff' : '#6a6aa8', (rnd() * PW) | 0, (rnd() * 50) | 0);
    b.fillStyle = rad(b, 18, 22, 30, [[0, 'rgba(200,210,255,0.55)'], [1, 'rgba(120,120,220,0)']]); b.fillRect(0, 0, PW, PH);
    ellP(b, '#e8e4f0', 18, 22, 15, 15); ellP(b, '#c4c0d8', 14, 18, 4, 3); ellP(b, '#c4c0d8', 22, 28, 5, 3); ellP(b, '#d0cce0', 12, 27, 2.5, 2);
    strokes(b, rnd, 30, ['#3a3a72', '#4a4a88', '#2a2a5a'], 0, 50, PW, PH, 16, 3, 0.05, 0.5);
    // skin ramp from DEF.nyx.skin #e2dde8 (moon-pale, cool lilac shadows)
    const S = { base: '#e6dce4', shade: '#b0a0bc', deep: '#76648a', light: '#fff6fa' };
    const hair = ['#dfe3f0', '#9a9cc0', '#ffffff', '#5a5a80'];
    blobP(f, hair[1], [[CX - 12, 13], [CX, 8], [CX + 12, 13], [CX + 17, 40], [CX + 19, 80], [CX - 19, 80], [CX - 17, 40]]);
    // bare shoulders; an indigo halter top (straps up to the neck), a silver band under it, a silver chain
    f.fillStyle = lin(f, CX - 26, 0, CX + 26, 0, [[0, S.light], [0.45, S.base], [1, S.shade]]);
    blobP(f, f.fillStyle, [[CX - 10, 50], [CX + 10, 50], [CX + 24, 57], [CX + 27, 80], [CX - 27, 80], [CX - 24, 57]]);
    const topP = [[CX - 21, 73], [CX - 11, 67], [CX - 3, 70], [CX, 73], [CX + 3, 70], [CX + 11, 67], [CX + 21, 73], [CX + 22, 80], [CX - 22, 80]];
    f.fillStyle = lin(f, CX - 22, 0, CX + 22, 0, [[0, '#4a3a98'], [0.45, '#2c1f62'], [1, '#140c30']]); fillP(f, f.fillStyle, topP);
    fillP(f, '#2c1f62', [[CX - 9, 68], [CX - 6, 68], [CX - 2, 50], [CX - 4, 50]]); fillP(f, '#1c1444', [[CX + 9, 68], [CX + 6, 68], [CX + 2, 50], [CX + 4, 50]]);
    px(d, '#d6dcec', CX - 21, 79, 43, 1);
    for (let i = 0; i < 9; i++) { px(d, '#c9d0e4', CX - 20 + i * 2, 73 - Math.round(i * 0.55)); px(d, '#8a90b0', CX + 20 - i * 2, 73 - Math.round(i * 0.55)); }
    [[CX - 12, 55], [CX - 8, 56], [CX + 8, 56], [CX + 12, 55]].forEach(([x, y]) => px(d, S.shade, x, y, 2, 1));
    paintFace(f, d, { E: 30, hw: 8.5, jw: 2, skin: S, iris: '#8a4ae8', glow: '#c8a0ff', brow: '#6a6070', browStyle: 'arched', lips: '#6e0f2e', lash: '#1a0a2a', fem: true, side: 1, shadow: '#6a4a8a', neckW: -0.5 });
    // long silver locks in front of the shoulders
    blobP(f, hair[0], [[CX - 1, 12], [CX - 10, 14], [CX - 12, 26], [CX - 11, 50], [CX - 14, 80], [CX - 19, 80], [CX - 17, 44], [CX - 14, 18]]);
    blobP(f, hair[3], [[CX + 1, 12], [CX + 10, 14], [CX + 12, 26], [CX + 11, 50], [CX + 14, 80], [CX + 19, 80], [CX + 17, 44], [CX + 14, 18]]);
    blobP(f, hair[0], [[CX - 9, 20], [CX - 2, 11], [CX, 13], [CX - 6, 19]]); blobP(f, hair[1], [[CX + 9, 20], [CX + 2, 11], [CX, 13], [CX + 6, 19]]);
    f.lineWidth = 0.7; [[hair[2], -13, 0.9], [hair[1], 14, 0.6]].forEach(([c, x0, a]) => { f.globalAlpha = a; f.strokeStyle = c; f.beginPath(); f.moveTo(CX + x0 * 0.7, 16); f.quadraticCurveTo(CX + x0, 40, CX + x0 * 1.15, 80); f.stroke(); }); f.globalAlpha = 1;
    // moon circlet with a crescent and gem
    px(d, '#d8d8f0', CX - 9, 19, 18, 1); px(d, '#8a8aa8', CX - 9, 20, 18, 1);
    [[CX - 2, 15], [CX - 3, 16], [CX - 3, 17], [CX - 2, 18], [CX + 1, 15], [CX + 2, 16], [CX + 2, 17], [CX + 1, 18]].forEach(([x, y]) => px(d, '#f4f4ff', x, y));
    px(d, '#9ae0ff', CX - 1, 17, 2, 2);
    // the staff's moon orb, lower left
    f.fillStyle = rad(f, 9, 68, 9, [[0, 'rgba(210,200,255,1)'], [0.45, 'rgba(140,120,240,0.9)'], [0.8, 'rgba(80,60,200,0.6)'], [1, 'rgba(60,40,180,0)']]); f.fillRect(0, 58, 20, 20);
    fillP(f, '#2a1a14', [[8, 73], [10, 73], [11, 80], [7, 80]]); ellP(f, '#f0ecff', 9, 68, 3.5, 3.5); px(d, '#ffffff', 8, 66, 2, 1);
    return { rim: '#b8d4ff', rimSide: -1, top: '#e0e8ff', outline: '#04041a', key: -1, keyCol: 'rgba(200,220,255,0.14)', darkCol: 'rgba(10,6,40,0.35)' };
  };
  PAINT.vesna = function (b, f, d, rnd) {
    b.fillStyle = lin(b, 0, 0, 0, PH, [[0, '#0c1008'], [0.35, '#243014'], [0.7, '#8a6a24'], [0.85, '#c49a3a'], [1, '#3a2a10']]); b.fillRect(0, 0, PW, PH);
    b.fillStyle = rad(b, 50, 50, 34, [[0, 'rgba(255,220,120,0.6)'], [1, 'rgba(255,200,90,0)']]); b.fillRect(0, 0, PW, PH);
    strokes(b, rnd, 18, ['#ffd98a', '#e8b050'], 30, 0, PW, 60, 30, 1.2, 2.0, 0.22);
    [[4, 70, 44], [14, 76, 56], [58, 72, 46], [52, 80, 34], [26, 80, 20]].forEach(([x, y, h]) => pine(b, '#0a0e06', x, y, h));
    // skin ramp from DEF.vesna.skin #e3a986
    const S = { base: '#e6aa86', shade: '#b47458', deep: '#7a4432', light: '#fcd2b0' };
    const hair = ['#b0401c', '#7a2610', '#f07a38', '#5a160a'];
    // bow stave and red fletching behind
    f.strokeStyle = '#3a1e0c'; f.lineWidth = 3; f.beginPath(); f.moveTo(6, 80); f.quadraticCurveTo(4, 34, 19, 4); f.stroke();
    f.strokeStyle = '#9a6a32'; f.lineWidth = 1.1; f.beginPath(); f.moveTo(5.2, 78); f.quadraticCurveTo(3.2, 34, 18, 5); f.stroke();
    f.strokeStyle = '#e8dcc0'; f.lineWidth = 0.9; f.beginPath(); f.moveTo(8, 78); f.lineTo(20, 6); f.stroke();
    [[52, 40], [55, 37], [58, 41]].forEach(([x, y], i) => { f.strokeStyle = '#c8b080'; f.lineWidth = 0.9; f.beginPath(); f.moveTo(x - 5, y + 18); f.lineTo(x, y); f.stroke(); fillP(f, i === 1 ? '#d8341c' : '#9a1a10', [[x - 1.5, y + 1], [x + 1, y - 2], [x + 1.2, y + 4], [x - 0.6, y + 5]]); });
    // big red mane behind
    blobP(f, hair[1], [[CX - 14, 14], [CX, 7], [CX + 14, 14], [CX + 18, 34], [CX + 17, 56], [CX - 17, 56], [CX - 18, 34]]);
    // bare shoulders with freckles; a dark wolf-fur top with leather straps
    f.fillStyle = lin(f, CX - 26, 0, CX + 26, 0, [[0, S.shade], [0.55, S.base], [1, S.light]]);
    blobP(f, f.fillStyle, [[CX - 10, 50], [CX + 10, 50], [CX + 24, 57], [CX + 27, 80], [CX - 27, 80], [CX - 24, 57]]);
    for (let i = 0; i < 14; i++) px(d, '#c07a52', (CX - 22 + rnd() * 44) | 0, (53 + rnd() * 12) | 0);
    const topP = [[CX - 21, 73], [CX - 12, 68], [CX - 3, 71], [CX, 73], [CX + 3, 71], [CX + 12, 68], [CX + 21, 73], [CX + 22, 80], [CX - 22, 80]];
    fillP(f, '#3c3a36', topP);
    for (let i = 0; i < 14; i++) { const x = CX - 20 + i * 3, y = 69 + Math.abs(i - 6.5) * 0.35; fillP(f, i % 2 ? '#5a5650' : '#2a2824', [[x - 2, y + 2], [x + 2, y + 2], [x + (rnd() - 0.5), y - 2]]); }
    for (let y = 73; y < 80; y += 2) for (let x = CX - 19; x < CX + 20; x += 4) px(d, '#6a6660', x + (y % 4 ? 2 : 0), y);
    f.strokeStyle = '#2a1a10'; f.lineWidth = 1; f.beginPath(); f.moveTo(CX - 12, 68); f.lineTo(CX - 16, 51); f.moveTo(CX + 12, 68); f.lineTo(CX + 16, 51); f.stroke();
    [[CX - 12, 55], [CX - 8, 56], [CX + 8, 56], [CX + 12, 55]].forEach(([x, y]) => px(d, S.shade, x, y, 2, 1));
    paintFace(f, d, { E: 30, hw: 8.5, jw: 2.3, skin: S, iris: '#3a7a2a', brow: '#8a2a10', browStyle: 'flat', cocky: true, lips: '#b0302a', smirk: true, fem: true, side: -1 });
    // war paint: three red stripes across her left cheek (viewer's right), as on the model; freckles over the nose
    for (let i = 0; i < 3; i++) { const y = 33 + i * 2; px(d, '#b01014', CX + 3, y, 2, 1); px(d, '#b01014', CX + 5, y - 1, 2, 1); px(d, '#b01014', CX + 7, y - 1, 1, 1); }
    [[CX - 2, 32], [CX + 1, 32], [CX - 3, 33], [CX - 5, 34], [CX - 1, 35], [CX - 6, 33]].forEach(([x, y]) => px(d, '#c07044', x, y));
    // side-swept fringe, big loose locks, and the braid down the front over her left shoulder
    blobP(f, hair[0], [[CX + 5, 12], [CX + 11, 15], [CX + 11, 26], [CX + 9, 22], [CX + 4, 18], [CX - 3, 21], [CX - 10, 27], [CX - 11, 17], [CX - 4, 11]]);
    fillP(f, hair[1], [[CX - 12, 18], [CX - 9, 24], [CX - 10, 44], [CX - 15, 52]]); fillP(f, hair[0], [[CX + 12, 18], [CX + 9, 24], [CX + 9, 34], [CX + 14, 40]]);
    [[CX - 6, 14], [CX - 2, 13], [CX + 3, 13], [CX - 8, 18], [CX + 8, 16]].forEach(([x, y]) => px(d, hair[2], x, y, 2, 1));
    const bp = []; for (let i = 0; i < 10; i++) bp.push([CX + 11 + Math.sin(i * 0.4) * 1.5 + i * 0.3, 36 + i * 4.4]);
    braid(f, d, bp, [hair[0], hair[1], hair[2]], 3.1);
    px(d, '#2a1a10', Math.round(bp[8][0] - 2), Math.round(bp[8][1] + 1), 4, 2);
    return { rim: '#ffd070', rimSide: 1, top: '#ffe0a0', outline: '#0a0c04', key: 1, keyCol: 'rgba(255,220,130,0.2)', darkCol: 'rgba(26,4,16,0.3)' };
  };
  PAINT.bram = function (b, f, d, rnd) {
    b.fillStyle = lin(b, 0, 0, 0, PH, [[0, '#0e0604'], [0.6, '#2a1008'], [1, '#6a2008']]); b.fillRect(0, 0, PW, PH);
    b.fillStyle = rad(b, 50, 76, 40, [[0, 'rgba(255,170,60,0.9)'], [0.5, 'rgba(220,80,20,0.35)'], [1, 'rgba(120,20,0,0)']]); b.fillRect(0, 0, PW, PH);
    for (let i = 0; i < 26; i++) px(b, rnd() < 0.5 ? '#ffd060' : '#ff7a20', (40 + rnd() * 24) | 0, (20 + rnd() * 50) | 0);
    fillP(b, '#1a0a06', [[0, 30], [14, 30], [14, 80], [0, 80]]); for (let i = 0; i < 4; i++) px(b, '#3a2014', 0, 36 + i * 10, 14, 1);
    const S = { base: '#c47c56', shade: '#8a4a30', deep: '#4a2418', light: '#eaa878' };
    f.fillStyle = lin(f, 0, 0, PW, 0, [[0, '#8a2a1a'], [0.5, '#5a1810'], [1, '#2a0a06']]);
    blobP(f, f.fillStyle, [[CX - 12, 48], [CX + 12, 48], [CX + 30, 58], [CX + 34, 80], [CX - 34, 80], [CX - 30, 58]]);
    fillP(f, '#5a3a20', [[CX - 14, 58], [CX + 14, 58], [CX + 16, 80], [CX - 16, 80]]);
    fillP(f, '#3a2410', [[CX - 14, 58], [CX - 12, 58], [CX - 16, 48], [CX - 18, 48]]); fillP(f, '#3a2410', [[CX + 14, 58], [CX + 12, 58], [CX + 16, 48], [CX + 18, 48]]);
    paintFace(f, d, { E: 30, hw: 10, jw: 5, skin: S, iris: '#3a2412', brow: '#1a100c', browStyle: 'fierce', thickBrow: true, lips: '#7a3028', hideMouth: true, side: -1, neckW: 3 });
    ellP(f, S.light, CX - 3, 19, 4, 2.2); px(d, S.light, CX - 4, 18, 3, 1);
    // beard + moustache
    blobP(f, '#1e1410', [[CX - 10, 34], [CX - 6, 38], [CX, 37], [CX + 6, 38], [CX + 10, 34], [CX + 11, 44], [CX + 6, 54], [CX, 57], [CX - 6, 54], [CX - 11, 44]]);
    px(d, '#3a2a22', CX - 6, 44, 1, 3); px(d, '#3a2a22', CX + 2, 46, 1, 4); px(d, '#3a2a22', CX - 2, 50, 1, 3);
    px(d, '#7a3028', CX - 2, 40, 4, 1);
    px(d, '#2a2020', CX + 5, 32, 2, 1); px(d, '#2a2020', CX - 8, 20, 3, 1);
    px(d, '#ffd070', CX + 12, 21); px(d, '#ffd070', CX + 11, 22);
    return { rim: '#ffa040', rimSide: 1, top: '#ffb060', outline: '#0e0402', key: 1 };
  };
  PAINT.mag = function (b, f, d, rnd) {
    b.fillStyle = lin(b, 0, 0, 0, PH, [[0, '#1a0e06'], [0.5, '#3a2210'], [1, '#1a0c04']]); b.fillRect(0, 0, PW, PH);
    b.fillStyle = rad(b, 10, 30, 22, [[0, 'rgba(255,200,100,0.8)'], [1, 'rgba(255,160,60,0)']]); b.fillRect(0, 0, PW, PH);
    for (let r = 0; r < 3; r++) { px(b, '#2a1608', 40, 18 + r * 16, 24, 2); for (let i = 0; i < 6; i++) px(b, ['#5a2a1a', '#3a4a2a', '#6a5a3a'][i % 3], 42 + i * 3.5 | 0, 12 + r * 16, 2, 6); }
    px(b, '#ffe0a0', 9, 30, 2, 3); px(b, '#e8dcc0', 9, 33, 2, 6);
    const S = { base: '#d49a78', shade: '#9a6048', deep: '#5a3024', light: '#f0c0a0' };
    blobP(f, '#8a8078', [[CX - 11, 16], [CX, 10], [CX + 11, 16], [CX + 12, 34], [CX - 12, 34]]);
    f.fillStyle = lin(f, 0, 0, PW, 0, [[0, '#4a6a3a'], [0.5, '#2e4a2a'], [1, '#162612']]);
    blobP(f, f.fillStyle, [[CX - 12, 49], [CX + 12, 49], [CX + 27, 58], [CX + 30, 80], [CX - 30, 80], [CX - 27, 58]]);
    fillP(f, '#7a2a22', [[CX - 7, 50], [CX + 7, 50], [CX + 3, 66], [CX - 3, 66]]);
    fillP(f, '#e0d4b8', [[CX - 12, 70], [CX + 12, 70], [CX + 14, 80], [CX - 14, 80]]);
    paintFace(f, d, { E: 31, hw: 9.5, jw: 4, skin: S, iris: '#4a3a20', brow: '#8a8078', browStyle: 'raised', lips: '#9a4a3a', smile: true, fem: true, side: 1, blush: '#d87a64', neckW: 1 });
    blobP(f, '#9a9088', [[CX - 11, 24], [CX - 10, 14], [CX, 11], [CX + 10, 14], [CX + 11, 24], [CX + 6, 18], [CX, 16], [CX - 6, 18]]);
    ellP(f, '#a8a098', CX, 8, 6, 4.5); ellP(f, '#7a7068', CX + 2, 9, 3, 2);
    [[CX - 9, 30], [CX - 9, 32], [CX + 8, 30], [CX + 8, 32], [CX - 6, 38], [CX + 5, 38], [CX - 3, 24], [CX + 2, 24]].forEach(([x, y]) => px(d, S.shade, x, y));
    px(d, '#c8c0b8', CX - 5, 12, 3, 1); px(d, '#c8c0b8', CX - 2, 6, 3, 1);
    return { rim: '#ffc070', rimSide: -1, top: '#ffd090', outline: '#0e0602', key: -1 };
  };
  PAINT.selene = function (b, f, d, rnd) {
    // moonlit fen: deep teal night, a pale moon, low mist; cigarette smoke curling up past her cheek
    b.fillStyle = lin(b, 0, 0, 0, PH, [[0, '#04060f'], [0.45, '#0e1c34'], [0.8, '#183644'], [1, '#081216']]); b.fillRect(0, 0, PW, PH);
    for (let i = 0; i < 30; i++) px(b, rnd() < 0.3 ? '#d8e0ff' : '#5a6a90', (rnd() * PW) | 0, (rnd() * 44) | 0);
    b.fillStyle = rad(b, 50, 16, 20, [[0, 'rgba(210,225,255,0.55)'], [1, 'rgba(120,140,220,0)']]); b.fillRect(0, 0, PW, PH);
    ellP(b, '#e6ecf6', 50, 16, 9, 9); ellP(b, '#c4ccdc', 47, 14, 2.5, 2); ellP(b, '#ccd2e2', 53, 19, 2, 1.5);
    strokes(b, rnd, 26, ['#2a4a58', '#3a5a66', '#1c3440'], 0, 56, PW, PH, 16, 3, 0.03, 0.5);
    b.lineCap = 'round';
    [[0.5, 1.4], [0.3, 1]].forEach(([a, w], k) => { b.globalAlpha = a; b.strokeStyle = '#c8ccd8'; b.lineWidth = w; b.beginPath(); b.moveTo(43, 40); b.bezierCurveTo(47 + k * 3, 32, 40 + k * 4, 26, 46 + k * 2, 16); b.bezierCurveTo(50, 10, 44 + k * 5, 6, 48, 0); b.stroke(); });
    b.globalAlpha = 1;
    const S = { base: '#e2bf92', shade: '#a47a58', deep: '#5e3e2c', light: '#f8dcb4' };
    const hair = ['#131826', '#262f48', '#5e6e90'];
    // high ponytail: rises from the crown, sweeps over and falls behind her left shoulder
    blobP(f, hair[0], [[CX + 1, 12], [CX + 6, 4], [CX + 13, 3], [CX + 19, 10], [CX + 21, 24], [CX + 20, 44], [CX + 16, 56], [CX + 14, 40], [CX + 14, 22], [CX + 10, 12]]);
    // bare shoulders; the silver-scale top only just shows at the bottom edge (straps + upper edge)
    f.fillStyle = lin(f, CX - 26, 0, CX + 26, 0, [[0, S.light], [0.45, S.base], [1, S.shade]]);
    blobP(f, f.fillStyle, [[CX - 10, 50], [CX + 10, 50], [CX + 25, 57], [CX + 29, 80], [CX - 29, 80], [CX - 25, 57]]);
    // the flag crop tee: short sleeves at the shoulders, a scoop neck, faded Stars and Stripes
    const teeP = [[CX - 30, 56], [CX - 22, 53], [CX - 12, 55], [CX - 7, 63], [CX, 69], [CX + 7, 63], [CX + 12, 55], [CX + 22, 53], [CX + 30, 56], [CX + 31, 80], [CX - 31, 80]];
    fillP(f, '#d8d2c4', teeP);
    f.save(); f.beginPath(); teeP.forEach(([x, y], k) => (k ? f.lineTo(x, y) : f.moveTo(x, y))); f.closePath(); f.clip();
    for (let y = 54; y < 80; y += 4) { f.fillStyle = '#a42a2c'; f.fillRect(0, y, PW, 2); }
    f.fillStyle = '#28386c'; f.fillRect(CX - 31, 53, 25, 13);
    f.restore();
    for (let y = 57; y < 66; y += 2) for (let x = CX - 28 + (y % 4 ? 1 : 0); x < CX - 8; x += 3) px(d, '#ece6d6', x, y);
    f.strokeStyle = '#8a2024'; f.lineWidth = 0.8; f.beginPath(); f.moveTo(CX - 12, 55); f.lineTo(CX - 7, 63); f.lineTo(CX, 69); f.lineTo(CX + 7, 63); f.lineTo(CX + 12, 55); f.stroke();
    [[CX - 12, 55], [CX - 8, 56], [CX + 8, 56], [CX + 12, 55]].forEach(([x, y]) => px(d, S.shade, x, y, 2, 1));   // collarbones
    paintFace(f, d, { E: 30, hw: 8.5, jw: 2.2, skin: S, iris: '#9ab8ff', brow: '#0c0e18', browStyle: 'arched', lips: '#6e1a3c', smirk: true, fem: true, side: 1, shadow: '#3a3a6a' });
    // hair: slicked back from the hairline, a sheen, two loose strands at the temples
    blobP(f, hair[0], [[CX - 10, 22], [CX - 10, 14], [CX - 3, 10], [CX + 4, 10], [CX + 10, 14], [CX + 10, 22], [CX + 7, 16], [CX, 14], [CX - 7, 16]]);
    f.strokeStyle = hair[2]; f.lineWidth = 0.8; f.beginPath(); f.moveTo(CX - 7, 15); f.quadraticCurveTo(CX - 1, 11, CX + 6, 13); f.stroke();
    f.strokeStyle = hair[1]; f.beginPath(); f.moveTo(CX + 8, 16); f.quadraticCurveTo(CX + 14, 10, CX + 16, 6); f.stroke();
    px(d, hair[1], CX - 10, 23, 1, 7); px(d, hair[1], CX + 9, 23, 1, 6);
    px(d, '#c8d2ea', CX - 10, 35, 1, 2); px(d, '#c8d2ea', CX + 9, 35, 1, 2);   // small silver earrings
    // the cigarette at the corner of her smirk, ember glowing
    px(d, '#f0ece4', CX + 3, 39, 2, 1); px(d, '#f0ece4', CX + 5, 40, 2, 1); px(d, '#e8e0d0', CX + 7, 40, 1, 1);
    px(d, '#ff6a1a', CX + 8, 40, 1, 1); px(d, '#ffd070', CX + 8, 39, 1, 1);
    return { rim: '#a8d0ff', rimSide: 1, top: '#d0e4ff', outline: '#02040a', key: -1, keyCol: 'rgba(255,214,160,0.16)', darkCol: 'rgba(4,8,30,0.45)' };
  };
  PAINT.villager = function (b, f, d, rnd, id) {
    const h = hash(id), pick = (a, k) => a[(h >>> k) % a.length];
    b.fillStyle = lin(b, 0, 0, 0, PH, [[0, '#1a0c10'], [0.5, '#5a2a1a'], [0.75, '#c06a2a'], [1, '#2a1208']]); b.fillRect(0, 0, PW, PH);
    for (let i = 0; i < 4; i++) { const x = i * 18 - 4 + (h >>> i) % 6, y = 60 + ((h >>> (i + 3)) % 8); fillP(b, '#1a0a06', [[x, y], [x + 8, y - 8], [x + 16, y], [x + 16, 80], [x, 80]]); px(b, '#ffb040', x + 6, y + 4, 2, 2); }
    const v = VILLAGERS.find(v => v.id === id) || {};
    const skins = [['#c8906a', '#8a5a3a', '#4a2a1a', '#e8b890'], ['#e0b090', '#a07050', '#5a3424', '#f8d0b0'], ['#a87050', '#6a4028', '#3a2014', '#c89070']];
    const sk = v.skin ? [v.skin, mix(v.skin, '#2a0a04', 0.35), mix(v.skin, '#1a0402', 0.62), mix(v.skin, '#fff0d0', 0.3)] : pick(skins, 3);
    const S = { base: sk[0], shade: sk[1], deep: sk[2], light: sk[3] };
    const hairC = v.hair || pick(['#2a1a10', '#6a4020', '#a07040', '#3a2a20'], 5), top = v.top || pick(['#6a5030', '#4a5a3a', '#6a3a2a', '#5a5048'], 7);
    const hood = v.hood || (!v.fem && (h & 1) ? pick(['#4a3a2a', '#3a3a30', '#5a4028'], 9) : null);
    blobP(f, top, [[CX - 11, 49], [CX + 11, 49], [CX + 26, 58], [CX + 29, 80], [CX - 29, 80], [CX - 26, 58]]);
    fillP(f, mix(top, '#000000', 0.45), [[CX + 4, 50], [CX + 26, 58], [CX + 29, 80], [CX + 10, 80]]);
    if (!hood) blobP(f, mix(hairC, '#000000', 0.3), [[CX - 11, 16], [CX, 10], [CX + 11, 16], [CX + 12, v.fem ? 50 : 32], [CX - 12, v.fem ? 50 : 32]]);
    else blobP(f, mix(hood, '#000000', 0.3), [[CX - 14, 20], [CX, 9], [CX + 14, 20], [CX + 16, 52], [CX - 16, 52]]);
    paintFace(f, d, { E: 31, hw: 9, jw: v.fem ? 2.5 : 4, skin: S, iris: pick(['#3a2a18', '#3a5a6a', '#4a4a2a'], 11), brow: v.beard || hairC, browStyle: v.old ? 'raised' : 'flat', lips: '#8a4a3a', fem: v.fem, side: 1, hideMouth: !!v.beard });
    if (hood) { blobP(f, hood, [[CX - 13, 30], [CX - 12, 15], [CX, 10], [CX + 12, 15], [CX + 13, 30], [CX + 10, 20], [CX, 17], [CX - 10, 20]]); fillP(f, hood, [[CX - 13, 26], [CX - 10, 24], [CX - 9, 44], [CX - 14, 50]]); fillP(f, mix(hood, '#000000', 0.4), [[CX + 13, 26], [CX + 10, 24], [CX + 9, 44], [CX + 14, 50]]); }
    else blobP(f, hairC, [[CX - 10, 24], [CX - 10, 14], [CX, 11], [CX + 10, 14], [CX + 10, 24], [CX + 5, 17], [CX - 5, 17]]);
    if (v.beard) blobP(f, v.beard, [[CX - 9, 36], [CX, 38], [CX + 9, 36], [CX + 8, 46], [CX, 50], [CX - 8, 46]]);
    if (v.old) [[CX - 9, 31], [CX + 8, 31], [CX - 3, 25], [CX + 2, 25]].forEach(([x, y]) => px(d, S.shade, x, y));
    return { rim: '#ffb060', rimSide: 1, top: '#ffc080', outline: '#120604' };
  };

  npcs.portrait = function (id) {
    id = id || 'villager';
    if (PCACHE[id]) return PCACHE[id];
    const bg = canvas(PW, PH), fg = canvas(PW, PH), det = canvas(PW, PH);
    const b = bg.getContext('2d'), f = fg.getContext('2d'), d = det.getContext('2d');
    const rnd = CT.rng ? CT.rng(hash(id)) : Math.random;
    const P = PAINT[id] || PAINT.villager;
    const o = P(b, f, d, rnd, id) || {};
    // unify the light: warm key side, cool shadow side, the bust sinks into darkness
    const k = o.key || -1, lit = o.keyCol || 'rgba(255,196,120,0.16)', dark = o.darkCol || 'rgba(26,4,16,0.42)';
    f.globalCompositeOperation = 'source-atop';
    f.fillStyle = lin(f, 0, 0, PW, 0, k < 0 ? [[0, lit], [0.45, 'rgba(0,0,0,0)'], [1, dark]] : [[0, dark], [0.55, 'rgba(0,0,0,0)'], [1, lit]]); f.fillRect(0, 0, PW, PH);
    f.fillStyle = lin(f, 0, 56, 0, PH, [[0, 'rgba(0,0,0,0)'], [1, 'rgba(12,2,6,0.5)']]); f.fillRect(0, 0, PW, PH);
    f.globalCompositeOperation = 'source-over';
    return (PCACHE[id] = finish(bg, fg, det, o));
  };
})();
