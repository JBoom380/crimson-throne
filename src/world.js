// ─── WORLD: the cursed isle of Vael ──────────────────────────────────────────
// A cached 4 m heightfield (+ analytic detail), a warped far LOD so the peaks and
// the citadel show from anywhere, a sea to the horizon, a road network, streamed
// 64 m terrain chunks with instanced vegetation, and hand-built points of interest.
window.CT = window.CT || {};
(function () {
  const T = THREE, C = CT.config;
  const U = { time: { value: 0 } };
  const WU = { uNearR: { value: 300 }, uExag: { value: 0.4 }, uKeep: { value: 0 } };
  let core = null, scene = null, mats = null, viewR = 300, fineR = 110, lowQ = false;
  const POIS = C.POIS, P = {};
  POIS.forEach(p => (P[p.id] = p));

  // ── Math + noise ───────────────────────────────────────────────────────────
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const lerp = (a, b, t) => a + (b - a) * t;
  const TAU = Math.PI * 2;
  function hash2(x, z) {
    let h = (Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function vnoise(x, z) {
    const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
    const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
    const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
    return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
  }
  function fbm(x, z, o) {
    let s = 0, a = 0.5, n = 0, f = 1;
    for (let i = 0; i < o; i++) { s += a * vnoise(x * f + i * 31.7, z * f + i * 17.3); n += a; a *= 0.5; f *= 2.03; }
    return s / n;
  }
  function ridged(x, z, o) {
    let s = 0, a = 0.5, n = 0, f = 1, w = 1;
    for (let i = 0; i < o; i++) {
      let v = 1 - Math.abs(vnoise(x * f + i * 13.1, z * f + i * 7.9) * 2 - 1);
      v = v * v * w; w = clamp(v * 2, 0, 1); s += a * v; n += a; a *= 0.5; f *= 2.1;
    }
    return s / n;
  }
  const bell = (x, z, cx, cz, R, A) => { const d2 = ((x - cx) * (x - cx) + (z - cz) * (z - cz)) / (R * R); return d2 < 1 ? A * (1 - d2) * (1 - d2) : 0; };
  const terr = (h, s) => { const k = h / s, f = k - Math.floor(k); return (Math.floor(k) + sstep(0.5, 0.92, f)) * s; };

  // ── Island shape + regions ─────────────────────────────────────────────────
  // coastline radius and cliffiness depend only on the direction: tabulate them
  const CT_N = 4096, COAST_R = new Float32Array(CT_N + 1), COAST_K = new Float32Array(CT_N + 1);
  for (let i = 0; i <= CT_N; i++) {
    const a = i / CT_N * TAU - Math.PI, ux = Math.sin(a), uz = Math.cos(a), x = ux * 1000;
    let R = 1345 + 170 * (fbm(ux * 1.7 + 3.1, uz * 1.7 + 7.7, 3) - 0.5) + 40 * (vnoise(ux * 7 + 1, uz * 7 + 2) - 0.5);
    COAST_R[i] = R;
    COAST_K[i] = clamp(sstep(0.5, 0.64, vnoise(ux * 3 + 11, uz * 3 + 5)) * (1 - sstep(0.35, 0.7, uz)) + sstep(-0.3, -0.62, uz), 0, 1);
  }
  const angIdx = (x, z) => Math.min(CT_N - 0.001, (Math.atan2(x, z) + Math.PI) / TAU * CT_N);
  function coastC(x, z) { // signed inland distance to the coastline (m)
    const r = Math.sqrt(Math.sqrt(x * x * x * x + z * z * z * z));
    const f = angIdx(x, z), i = f | 0, t = f - i, l = Math.hypot(x, z) + 1e-6, uz = z / l;
    let R = COAST_R[i] + (COAST_R[i + 1] - COAST_R[i]) * t;
    R += 80 * Math.exp(-(x / 330) * (x / 330)) * sstep(-0.8, -0.95, uz);   // headland under the citadel
    R -= 62 * Math.exp(-(x / 260) * (x / 260)) * sstep(0.8, 0.95, uz);    // the wreck bay
    return R - r;
  }
  function cliffK(x, z) { const f = angIdx(x, z), i = f | 0, t = f - i; return COAST_K[i] + (COAST_K[i + 1] - COAST_K[i]) * t; }
  const W = { meadow: 0, forest: 0, swamp: 0, hills: 0, snow: 0 };
  function weights(x, z, o) {
    const px = (vnoise(x * 0.0035 + 50, z * 0.0035) - 0.5) * 260, pz = (vnoise(x * 0.0035, z * 0.0035 + 80) - 0.5) * 260;
    const snow = sstep(-500, -760, z + pz * 0.6);
    const forest = sstep(-250, -470, x + px) * (1 - snow);
    const swamp = sstep(430, 590, x + px) * sstep(-440, -340, z + pz * 0.5) * (1 - sstep(470, 570, z + pz)) * (1 - snow);
    const meadow = sstep(430, 640, z + pz) * (1 - forest) * (1 - swamp);
    o.snow = snow; o.forest = forest; o.swamp = swamp; o.meadow = meadow;
    o.hills = Math.max(0, 1 - snow - forest - swamp - meadow);
    return o;
  }
  const cragMask = (x, z) => sstep(0.56, 0.72, vnoise(x * 0.0045 + 91, z * 0.0045 + 17));

  // ── Raw height by biome ────────────────────────────────────────────────────
  const hMeadow = (x, z) => 3 + 18 * (fbm(x * 0.0042 + 11, z * 0.0042 + 3, 4) - 0.25) + 2.5 * vnoise(x * 0.025, z * 0.025);
  const hForest = (x, z) => 10 + 52 * (fbm(x * 0.0038 + 7, z * 0.0038 + 1, 4) - 0.25) + 26 * Math.pow(ridged(x * 0.008, z * 0.008, 2), 2);
  const hHills = (x, z) => 12 + 58 * (fbm(x * 0.0036 + 3, z * 0.0036 + 5, 5) - 0.28) + 50 * Math.pow(ridged(x * 0.0062 + 2, z * 0.0062 + 9, 3), 3);
  const hSwamp = (x, z) => 0.45 + 3.4 * (fbm(x * 0.011 + 5, z * 0.011 + 2, 3) - 0.5);
  function hMount(x, z) {
    const r1 = ridged(x * 0.0027 + 4, z * 0.0027 + 8, 4), r2 = ridged(x * 0.009 + 1, z * 0.009 + 3, 2);
    let h = 60 + 170 * r1 * r1 + 45 * r2 * r1;
    h *= 1 - 0.45 * Math.exp(-(x / 330) * (x / 330));
    // the Frozen Teeth: a jagged wall across the north, notched in the middle
    h += 190 * Math.exp(-((z + 830) / 120) * ((z + 830) / 120)) * (0.55 + 0.7 * ridged(x * 0.011 + 3, z * 0.011, 2)) * (1 - 0.5 * Math.exp(-(x / 170) * (x / 170)));
    h += bell(x, z, -600, -1030, 430, 270) + bell(x, z, 640, -990, 450, 290) + bell(x, z, -1060, -880, 320, 170) + bell(x, z, 1090, -870, 330, 180);
    return h;
  }
  const VALLEY = [[-10, -500, 44], [-40, -640, 66], [-62, -820, 90], [-52, -930, 116], [-30, -1010, 137]];
  let _vd = 0, _vf = 0;
  function valley(x, z) {
    _vd = 1e9;
    for (let i = 0; i < VALLEY.length - 1; i++) {
      const a = VALLEY[i], b = VALLEY[i + 1], ex = b[0] - a[0], ez = b[1] - a[1];
      const t = clamp(((x - a[0]) * ex + (z - a[1]) * ez) / (ex * ex + ez * ez), 0, 1);
      const dx = x - a[0] - ex * t, dz = z - a[1] - ez * t, d = Math.sqrt(dx * dx + dz * dz);
      if (d < _vd) { _vd = d; _vf = lerp(a[2], b[2], t); }
    }
  }
  let _lastC = 0;
  function rawH(x, z) {
    const c0 = coastC(x, z);
    if (c0 < -5) { _lastC = c0; weights(x, z, W); return Math.max(-38, -1.6 + c0 * 0.07); }
    weights(x, z, W);
    let h = 0;
    if (W.meadow > 0.001) h += W.meadow * hMeadow(x, z);
    if (W.forest > 0.001 || W.hills > 0.001) {
      const cm = cragMask(x, z);
      if (W.forest > 0.001) { const f = hForest(x, z); h += W.forest * lerp(f, terr(f, 9), cm * 0.85); }
      if (W.hills > 0.001) { const f = hHills(x, z); h += W.hills * lerp(f, terr(f, 11), cm * 0.9); }
    }
    if (W.swamp > 0.001) h += W.swamp * hSwamp(x, z);
    if (W.snow > 0.001) h += W.snow * hMount(x, z);
    if (z < -420) {
      valley(x, z);
      const vh = _vf + Math.max(0, _vd - 11) * 3.4 + (_vd > 11 ? 0 : (vnoise(x * 0.08, z * 0.08) - 0.5) * 1.2);
      if (_vd < 70 && z < -600 && z > -1000) h = Math.max(h, _vf + 30 + 60 * sstep(12, 45, _vd) * (0.6 + 0.6 * ridged(x * 0.03, z * 0.03, 2)));
      if (vh < h) h = vh;
      const rc = Math.hypot(x, z + 1250);
      if (rc < 380) {
        h = lerp(138 + 10 * (vnoise(x * 0.02, z * 0.02) - 0.5), h, sstep(240, 380, rc));
        const crag = 138 + 94 * (1 - sstep(100, 250, rc)) + 16 * ridged(x * 0.02 + 5, z * 0.02, 2) * sstep(104, 130, rc) * (1 - sstep(190, 250, rc));
        if (crag > h) h = crag;
      }
    }
    const c = _lastC = c0;
    if (c < 0) return Math.max(-38, -1.6 + c * 0.07);
    const L = lerp(240, 26, cliffK(x, z));
    return lerp(-1.6 + c * 0.045, h, sstep(0, L, c));
  }

  // ── Cached heightfield (4 m) ───────────────────────────────────────────────
  const GS = 4, GN = 801, G0 = -1600;
  let HG = null, FL = null, RD = null;
  function samp(A, x, z) {
    let fx = (x - G0) / GS, fz = (z - G0) / GS;
    fx = fx < 0 ? 0 : fx > GN - 1.001 ? GN - 1.001 : fx; fz = fz < 0 ? 0 : fz > GN - 1.001 ? GN - 1.001 : fz;
    const ix = fx | 0, iz = fz | 0, tx = fx - ix, tz = fz - iz, i = iz * GN + ix;
    return (A[i] * (1 - tx) + A[i + 1] * tx) * (1 - tz) + (A[i + GN] * (1 - tx) + A[i + GN + 1] * tx) * tz;
  }
  function heightAt(x, z) {
    return samp(HG, x, z) + (vnoise(x * 0.13 + 3, z * 0.13 + 7) - 0.5) * 1.3 * samp(FL, x, z);
  }
  const _nrm = new T.Vector3();
  function normalAt(x, z) {
    const hl = heightAt(x - 1, z), hr = heightAt(x + 1, z), hd = heightAt(x, z - 1), hu = heightAt(x, z + 1);
    return _nrm.set(hl - hr, 2, hd - hu).normalize();
  }
  const gridNy = (x, z) => { const gx = samp(HG, x + 2, z) - samp(HG, x - 2, z), gz = samp(HG, x, z + 2) - samp(HG, x, z - 2); return 4 / Math.sqrt(gx * gx + gz * gz + 16); };
  const waterAt = (x, z) => Math.max(0, -heightAt(x, z));

  // POI ground shaping: [flat radius, blend, fixed height | null, min height]
  const FLAT = { harrowby: [68, 35], crossing: [56, 30], camp: [46, 26], lodge: [26, 22, null, 2], wolfden: [24, 20, null, 2],
    stones: [24, 20, null, 2], ruins: [44, 26, null, 2.6], citadel: [100, 12, 232] };
  function stampDisc(x0, z0, R, fn) {
    const i0 = Math.max(0, Math.floor((x0 - R - G0) / GS)), i1 = Math.min(GN - 1, Math.ceil((x0 + R - G0) / GS));
    const j0 = Math.max(0, Math.floor((z0 - R - G0) / GS)), j1 = Math.min(GN - 1, Math.ceil((z0 + R - G0) / GS));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = G0 + i * GS, z = G0 + j * GS, d = Math.hypot(x - x0, z - z0);
      if (d <= R) fn(j * GN + i, d);
    }
  }
  function bake() {
    HG = new Float32Array(GN * GN); FL = new Float32Array(GN * GN); RD = new Float32Array(GN * GN).fill(99);
    for (let j = 0, i = 0; j < GN; j++) {
      const z = G0 + j * GS;
      for (let k = 0; k < GN; k++, i++) {
        const x = G0 + k * GS;
        HG[i] = rawH(x, z);
        let r = 0.7 + W.hills * 0.7 + W.snow * 1.5 + W.forest * 0.4 - W.swamp * 0.45;
        if (_lastC < 80) r *= lerp(0.35, 1, sstep(10, 80, _lastC));
        FL[i] = Math.max(0.1, r);
      }
    }
    for (const id in FLAT) {
      const p = P[id], f = FLAT[id], th = f[2] != null ? f[2] : Math.max(f[3] || 1.5, samp(HG, p.x, p.z));
      f.th = th;
      stampDisc(p.x, p.z, f[0] + f[1], (i, d) => { const t = sstep(f[0], f[0] + f[1], d); HG[i] = lerp(th, HG[i], t); FL[i] *= t; });
    }
    buildRoads();
  }

  // ── Roads ──────────────────────────────────────────────────────────────────
  // Control points: POI ids or [x, z]. m = meander amplitude.
  const ROADDEF = [
    { p: ['shore', [30, 1130], 'harrowby'], m: 6 },
    { p: ['harrowby', [210, 780], [270, 570], 'camp'], m: 9 },
    { p: ['camp', [220, 130], [140, -170], 'crossing'], m: 9 },
    { p: ['crossing', [10, -450], [-10, -500], [-40, -640], 'pass'], m: 2 },
    { p: ['pass', [-52, -930], [-30, -1010], [130, -1062], [-122, -1095], [96, -1118], [-40, -1136], [0, -1150], [0, -1158]], m: 0 },
    { p: ['harrowby', [-120, 880], [-420, 700], [-640, 520], 'lodge'], m: 10 },
    { p: ['lodge', [-880, 260], [-960, 140], 'wolfden'], m: 7 },
    { p: ['camp', [100, 250], [-60, 140], 'stones'], m: 7 },
    { p: ['stones', [-150, -120], [-60, -280], 'crossing'], m: 8 },
    { p: ['camp', [480, 330], [660, 230], 'fen'], m: 8 },
    { p: ['fen', [930, 20], [990, -110], 'ruins'], m: 6 },
    { p: ['crossing', [260, -400], [560, -330], [820, -260], 'ruins'], m: 10 },
  ];
  const TRIM = { shore: 20, harrowby: 13, crossing: 13, camp: 13, stones: 21, ruins: 22, wolfden: 14, lodge: 11, fen: 0, pass: 0, citadel: 0 };
  const roads = [];
  function buildRoads() {
    ROADDEF.forEach((def, k) => {
      const cp = def.p.map(q => (typeof q === 'string' ? [P[q].x, P[q].z] : q));
      const dense = [];
      for (let i = 0; i < cp.length - 1; i++) {
        const p0 = cp[Math.max(0, i - 1)], p1 = cp[i], p2 = cp[i + 1], p3 = cp[Math.min(cp.length - 1, i + 2)];
        const n = Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 0.5);
        for (let s = 0; s < n; s++) {
          const t = s / n, t2 = t * t, t3 = t2 * t;
          const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
          dense.push(f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1]));
        }
      }
      const last = cp[cp.length - 1]; dense.push(last[0], last[1]);
      // resample every 2 m, add meander
      const xs = [], zs = [];
      let acc = 0, px = dense[0], pz = dense[1];
      xs.push(px); zs.push(pz);
      for (let i = 2; i < dense.length; i += 2) {
        const d = Math.hypot(dense[i] - px, dense[i + 1] - pz); acc += d; px = dense[i]; pz = dense[i + 1];
        if (acc >= 2) { xs.push(px); zs.push(pz); acc = 0; }
      }
      xs.push(last[0]); zs.push(last[1]);
      const n = xs.length, X = new Float32Array(n), Z = new Float32Array(n), H = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const a = xs[Math.max(0, i - 1)], b = zs[Math.max(0, i - 1)], c = xs[Math.min(n - 1, i + 1)], d = zs[Math.min(n - 1, i + 1)];
        const l = Math.hypot(c - a, d - b) || 1, nx = -(d - b) / l, nz = (c - a) / l;
        const taper = sstep(0, 40, i * 2) * sstep(0, 40, (n - 1 - i) * 2);
        const o = def.m * (vnoise(i * 0.025 + k * 10, k * 3.3) - 0.5) * 2 * taper;
        X[i] = xs[i] + nx * o; Z[i] = zs[i] + nz * o;
        H[i] = samp(HG, X[i], Z[i]);
      }
      // smooth the height profile
      const tmp = new Float32Array(n);
      for (let pass = 0; pass < 4; pass++) {
        for (let i = 0; i < n; i++) { let s = 0, c = 0; for (let j = -8; j <= 8; j++) { const q = clamp(i + j, 0, n - 1); s += H[q]; c++; } tmp[i] = s / c; }
        H.set(tmp);
      }
      for (let i = 0; i < n; i++) H[i] = Math.max(H[i], 0.75);
      const a = def.p[0], b = def.p[def.p.length - 1];
      roads.push({ X, Z, H, n, a: typeof a === 'string' ? a : null, b: typeof b === 'string' ? b : null });
    });
    // stamp into the grid
    const RHt = new Float32Array(GN * GN);
    for (const r of roads) {
      for (let i = 0; i < r.n; i++) {
        if (trimmed(r, i)) continue;
        const x = r.X[i], z = r.Z[i], h = r.H[i];
        stampDisc(x, z, 14, (c, d) => { if (d < RD[c]) { RD[c] = d; RHt[c] = h; } });
      }
    }
    for (let i = 0; i < GN * GN; i++) {
      if (RD[i] < 14) { const t = sstep(3.4, 12, RD[i]); HG[i] = lerp(RHt[i], HG[i], t); FL[i] *= sstep(2, 10, RD[i]); }
    }
  }
  function trimmed(r, i) {
    const x = r.X[i], z = r.Z[i];
    for (const id of [r.a, r.b]) { if (!id) continue; const t = TRIM[id], p = P[id]; if (t && (x - p.x) * (x - p.x) + (z - p.z) * (z - p.z) < t * t) return true; }
    return false;
  }

  // ── Canvas textures ────────────────────────────────────────────────────────
  function cv(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function tex(c, rep, nearest) {
    const t = new T.CanvasTexture(c);
    t.colorSpace = T.SRGBColorSpace; t.magFilter = T.NearestFilter; t.minFilter = nearest ? T.NearestFilter : T.LinearMipmapLinearFilter;
    if (rep) t.wrapS = t.wrapT = T.RepeatWrapping;
    t.anisotropy = 4;
    return t;
  }
  function detailTex() {
    const S = 64, c = cv(S, S), g = c.getContext('2d'), R = CT.rng(4242);
    g.fillStyle = '#d8d8d8'; g.fillRect(0, 0, S, S);
    for (let k = 0; k < 900; k++) { const v = 196 + (R() * 59) | 0; g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect((R() * S) | 0, (R() * S) | 0, 1 + (R() < 0.3), 1); }
    for (let k = 0; k < 60; k++) { const x = (R() * S) | 0, y = (R() * S) | 0; g.fillStyle = '#b0b0b0'; g.fillRect(x, y + 1, 2, 1); g.fillStyle = '#f4f4f4'; g.fillRect(x, y, 2, 1); }
    for (let k = 0; k < 40; k++) { g.fillStyle = '#bcbcbc'; g.fillRect((R() * S) | 0, (R() * S) | 0, 3, 2); }
    return tex(c, true);
  }
  function rutTex() {
    const W = 32, H = 128, c = cv(W, H), g = c.getContext('2d'), R = CT.rng(77);
    for (let y = 0; y < H; y++) {
      const l = 2 + R() * 3, r = W - 2 - R() * 3;
      g.fillStyle = '#6b5236'; g.fillRect(l | 0, y, (r - l) | 0, 1);
      g.fillStyle = '#4e3c28'; g.fillRect(8 + (R() < 0.5), y, 3, 1); g.fillStyle = '#4e3c28'; g.fillRect(W - 11 - (R() < 0.5), y, 3, 1);
    }
    for (let k = 0; k < 160; k++) { g.fillStyle = ['#7c6446', '#5a4530', '#83705a', '#46382a'][k % 4]; g.fillRect((4 + R() * (W - 8)) | 0, (R() * H) | 0, 1 + (R() < 0.4), 1); }
    for (let k = 0; k < 30; k++) { g.fillStyle = '#9a8a70'; g.fillRect((4 + R() * (W - 8)) | 0, (R() * H) | 0, 2, 1); }
    return tex(c, true);
  }
  function glowTex() {
    const S = 64, c = cv(S, S), g = c.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(160,160,160,1)'); gr.addColorStop(0.6, 'rgba(40,40,40,1)'); gr.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
    const t = new T.CanvasTexture(c); return t;
  }
  function fogTex() {
    const S = 64, c = cv(S, S), g = c.getContext('2d'), R = CT.rng(9);
    for (let k = 0; k < 14; k++) {
      const x = 16 + R() * 32, y = 16 + R() * 32, r = 10 + R() * 14, gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(255,255,255,0.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, S, S);
    }
    const t = new T.CanvasTexture(c); return t;
  }
  // banner atlas: [bone king skull on black | black hand on red | village stag on green]
  function bannerTex() {
    const S = 64, c = cv(S * 3, S), g = c.getContext('2d'), R = CT.rng(31);
    const cols = ['#161214', '#6e1410', '#2a3a26'];
    for (let k = 0; k < 3; k++) {
      const o = k * S;
      g.fillStyle = cols[k]; g.fillRect(o, 0, S, S);
      for (let y = 0; y < S; y += 2) { g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(o, y, S, 1); }
      g.fillStyle = k === 2 ? '#b89a4a' : '#8a6a3a'; g.fillRect(o, 0, S, 3); g.fillRect(o, S - 18, S, 2);
      if (k === 0) { // skull
        g.fillStyle = '#d8d0bc'; g.beginPath(); g.arc(o + 32, 24, 11, 0, 7); g.fill(); g.fillRect(o + 25, 30, 14, 9);
        g.fillStyle = '#161214'; g.fillRect(o + 26, 22, 5, 5); g.fillRect(o + 33, 22, 5, 5); g.fillRect(o + 31, 29, 2, 3);
        for (let t = 0; t < 4; t++) g.fillRect(o + 27 + t * 3, 36, 1, 3);
        g.fillStyle = '#9a1a12'; g.fillRect(o + 18, 8, 28, 2); for (let t = 0; t < 5; t++) g.fillRect(o + 20 + t * 6, 4, 2, 5);
      } else if (k === 1) { // black hand
        g.fillStyle = '#0c0808'; g.fillRect(o + 24, 22, 17, 17);
        for (let f = 0; f < 4; f++) g.fillRect(o + 24 + f * 4.4, 9 + (f === 1 || f === 2 ? -2 : 1), 3, 14);
        g.fillRect(o + 40, 24, 8, 3); g.fillRect(o + 45, 19, 3, 7);
        g.fillStyle = '#3a0806'; for (let d = 0; d < 6; d++) g.fillRect(o + 26 + d * 2.5, 39, 1, 3 + R() * 7);
      } else { // stag
        g.fillStyle = '#c8a850'; g.fillRect(o + 26, 26, 12, 8); g.fillRect(o + 30, 20, 4, 7);
        g.fillRect(o + 24, 12, 2, 9); g.fillRect(o + 38, 12, 2, 9); g.fillRect(o + 22, 12, 6, 2); g.fillRect(o + 36, 12, 6, 2);
        g.fillRect(o + 27, 34, 2, 7); g.fillRect(o + 35, 34, 2, 7);
      }
      // tattered bottom
      g.globalCompositeOperation = 'destination-out';
      for (let x = 0; x < S; x += 2) { const d = 3 + R() * (k === 0 ? 20 : 12); g.fillRect(o + x, S - d, 2, d); }
      for (let h = 0; h < 5; h++) g.fillRect(o + (R() * S) | 0, (10 + R() * 40) | 0, 2, 2);
      g.globalCompositeOperation = 'source-over';
    }
    const t = tex(c, false, true); t.generateMipmaps = false; return t;
  }

  // ── Geometry batching ──────────────────────────────────────────────────────
  const _M = new T.Matrix4(), _Q = new T.Quaternion(), _E = new T.Euler(0, 0, 0, 'YXZ'), _P = new T.Vector3(), _S = new T.Vector3();
  const _a = new T.Vector3(), _b = new T.Vector3(), _n = new T.Vector3(), _col = new T.Color(), UP = new T.Vector3(0, 1, 0);
  let rnd = CT.rng(1);
  function M(x, y, z, ry = 0, sx = 1, sy = sx, sz = sx, rx = 0, rz = 0) {
    _E.set(rx, ry, rz); _Q.setFromEuler(_E); _P.set(x, y, z); _S.set(sx, sy, sz);
    return _M.compose(_P, _Q, _S);
  }
  function limbM(ax, ay, az, bx, by, bz) {
    _a.set(bx - ax, by - ay, bz - az).normalize(); _Q.setFromUnitVectors(UP, _a);
    _P.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2); _S.set(1, 1, 1);
    return _M.compose(_P, _Q, _S);
  }
  class Batch {
    constructor(tile, name) { this.p = []; this.c = []; this.uv = []; this.tile = tile || 0; this.name = name || ''; }
    add(g0, m, col, jit, R) {
      const g = g0.index ? g0.toNonIndexed() : g0, src = g.attributes.position.array, e = m ? m.elements : null;
      const p = this.p, o = p.length, cnt = src.length / 3, fn = typeof col === 'function';
      R = R || rnd;
      if (this.tile) { // box-projected UVs in the part's own (scaled) frame, so the texture follows walls and roofs
        const sx = e ? Math.hypot(e[0], e[1], e[2]) : 1, sy = e ? Math.hypot(e[4], e[5], e[6]) : 1, sz = e ? Math.hypot(e[8], e[9], e[10]) : 1;
        const t = 1 / this.tile, ou = R(), ov = R(), U = this.uv;
        for (let f = 0; f < cnt; f += 3) {
          const i = f * 3;
          const ax = (src[i + 3] - src[i]) * sx, ay = (src[i + 4] - src[i + 1]) * sy, az = (src[i + 5] - src[i + 2]) * sz;
          const bx2 = (src[i + 6] - src[i]) * sx, by2 = (src[i + 7] - src[i + 1]) * sy, bz2 = (src[i + 8] - src[i + 2]) * sz;
          const nx = Math.abs(ay * bz2 - az * by2), ny = Math.abs(az * bx2 - ax * bz2), nz = Math.abs(ax * by2 - ay * bx2);
          for (let v = 0; v < 3; v++) {
            const X = src[i + v * 3] * sx, Y = src[i + v * 3 + 1] * sy, Z = src[i + v * 3 + 2] * sz;
            if (ny >= nx && ny >= nz) U.push(X * t + ou, Z * t + ov); else if (nx >= nz) U.push(Z * t + ou, Y * t); else U.push(X * t + ou, Y * t);
          }
        }
      }
      for (let i = 0; i < cnt; i++) {
        const x = src[i * 3], y = src[i * 3 + 1], z = src[i * 3 + 2];
        if (e) p.push(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
        else p.push(x, y, z);
      }
      if (!fn) _col.set(col);
      for (let f = 0; f < cnt; f += 3) {
        if (fn) {
          const i = o + f * 3;
          _a.set(p[i + 3] - p[i], p[i + 4] - p[i + 1], p[i + 5] - p[i + 2]); _b.set(p[i + 6] - p[i], p[i + 7] - p[i + 1], p[i + 8] - p[i + 2]);
          _n.crossVectors(_a, _b).normalize();
          _col.set(col(_n.y, (src[f * 3 + 1] + src[f * 3 + 4] + src[f * 3 + 7]) / 3, R));
        }
        const k = jit ? 1 + (R() - 0.5) * jit : 1;
        for (let v = 0; v < 3; v++) this.c.push(_col.r * k, _col.g * k, _col.b * k);
      }
      return this;
    }
    merge(b, m) {
      const e = m.elements, s = b.p;
      for (let i = 0; i < s.length; i += 3) {
        const x = s[i], y = s[i + 1], z = s[i + 2];
        this.p.push(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
      }
      for (let i = 0; i < b.c.length; i++) this.c.push(b.c[i]);
      if (this.tile) { if (b.tile) for (let i = 0; i < b.uv.length; i++) this.uv.push(b.uv[i]); else for (let i = 0; i < s.length / 3; i++) this.uv.push(0, 0); }
    }
    get empty() { return this.p.length === 0; }
    geo() {
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(new Float32Array(this.p), 3));
      g.setAttribute('color', new T.BufferAttribute(new Float32Array(this.c), 3));
      if (this.tile) g.setAttribute('uv', new T.BufferAttribute(new Float32Array(this.uv), 2));
      g.computeVertexNormals();
      return g;
    }
  }
  const kit = () => ({ f: new Batch(), d: new Batch(), g: new Batch(), t: {} });
  // painted-texture batches (metres per tile); only used when CT.tex (textures.js) is present
  const TSZ = { wall: 3.4, thatch: 2.4, tiles: 2.2, planks: 2.0, bark: 1.6, rock: 4, stone: 5 };
  let TX = false;
  const tb = (K, n) => K.t[n] || (K.t[n] = new Batch(TSZ[n], n));
  const txb = (K, n) => (TX ? tb(K, n) : K.f); // textured batch when painting, else the flat one
  function placeKit(K, k, m) {
    K.f.merge(k.f, m); if (k.d !== k.f) K.d.merge(k.d, m); K.g.merge(k.g, m);
    for (const n in k.t) if (k.t[n] !== k.f && k.t[n] !== k.d) tb(K, n).merge(k.t[n], m);
  }
  function lumpy(g0, amt, seed) {
    const g = g0.index ? g0.toNonIndexed() : g0, p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const a = Math.round(x * 97), b = Math.round(y * 97), c = Math.round(z * 97);
      p.setXYZ(i, x + (hash2(a + c * 1013, b + seed) - 0.5) * amt, y + (hash2(b + a * 733, c + seed * 7) - 0.5) * amt, z + (hash2(c + b * 571, a + seed * 13) - 0.5) * amt);
    }
    return g;
  }
  const BOX = new T.BoxGeometry(1, 1, 1).toNonIndexed();
  const cyl = (rt, rb, h, seg, open) => new T.CylinderGeometry(rt, rb, h, seg || 7, 1, !!open);
  const cone = (r, h, seg) => new T.ConeGeometry(r, h, seg || 6);
  const ico = (r, d) => new T.IcosahedronGeometry(r, d || 0);
  function prism(w, d, h) { // along x, triangle in zy, base y=0, apex y=h
    const a = w / 2, b = d / 2, v = [a, 0, b, a, 0, -b, a, h, 0, -a, 0, -b, -a, 0, b, -a, h, 0,
      a, 0, b, a, h, 0, -a, h, 0, a, 0, b, -a, h, 0, -a, 0, b,
      -a, 0, -b, -a, h, 0, a, h, 0, -a, 0, -b, a, h, 0, a, 0, -b];
    const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(v, 3)); return g;
  }
  function archShape(w, h) { // pointed gothic arch window, faces +z
    const s = new T.Shape(), a = w / 2;
    s.moveTo(-a, 0); s.lineTo(a, 0); s.lineTo(a, h * 0.62); s.quadraticCurveTo(a, h * 0.86, 0, h); s.quadraticCurveTo(-a, h * 0.86, -a, h * 0.62); s.lineTo(-a, 0);
    return new T.ShapeGeometry(s, 3);
  }
  // shorthand box on the batch: centre x,y,z
  const bx = (b, x, y, z, w, h, d, col, ry = 0, rx = 0, rz = 0, jit = 0.1) => b.add(BOX, M(x, y, z, ry, w, h, d, rx, rz), col, jit);

  // ── Palette ────────────────────────────────────────────────────────────────
  const WOOD = 0x3e2a1a, WOOD2 = 0x55392a, DWOOD = 0x21160e, PLASTER = 0x8a7a60, STONE = 0x5f5a54, STONE2 = 0x47433f;
  const THATCH = 0x4a3a20, SLATE = 0x2c2a30, TILE = 0x5a2a1c, IRON = 0x28282c, BONE = 0xd6ccb4, HIDE = 0x6e5238;
  const BLACK = 0x1f1c22, BLACK2 = 0x2b2630, WHITE = 0xbfb8a8, MOSS = 0x4e5a34, CLOTH = 0x5e1a14;

  // ── Materials with wind / fire / warp shaders ─────────────────────────────
  function sway(mat, amp, y0, key) {
    mat.onBeforeCompile = sh => {
      sh.uniforms.uTime = U.time; sh.uniforms.uAmp = { value: amp }; sh.uniforms.uY0 = { value: y0 };
      sh.vertexShader = 'uniform float uTime; uniform float uAmp; uniform float uY0;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        vec3 ip = vec3(0.0);
        #ifdef USE_INSTANCING
          ip = instanceMatrix[3].xyz;
        #endif
        float hh = max(0.0, position.y - uY0);
        float ph = uTime * 1.3 + ip.x * 0.37 + ip.z * 0.23;
        float gust = 0.6 + 0.4 * sin(uTime * 0.37 + ip.x * 0.01);
        transformed.x += (sin(ph) + 0.4 * sin(ph * 2.3)) * uAmp * hh * gust;
        transformed.z += cos(ph * 0.8) * uAmp * 0.6 * hh * gust;`);
    };
    mat.customProgramCacheKey = () => 'ct-sway-' + key;
    return mat;
  }
  function flutter(mat, hang) {
    mat.onBeforeCompile = sh => {
      sh.uniforms.uTime = U.time;
      sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        vec3 ip = vec3(0.0);
        #ifdef USE_INSTANCING
          ip = instanceMatrix[3].xyz;
        #endif
        ${hang ? 'float k = -position.y / 4.0; transformed.z += sin(uTime * 2.2 - position.y * 1.3 + ip.x) * 0.22 * k; transformed.x += sin(uTime * 1.7 + ip.z) * 0.12 * k;'
    : 'float k = position.x / 2.2; transformed.z += sin(uTime * 5.0 - position.x * 3.0 + ip.x + ip.z) * 0.3 * k; transformed.y += sin(uTime * 3.3 - position.x * 2.1 + ip.z) * 0.08 * k;'}`);
    };
    mat.customProgramCacheKey = () => 'ct-flutter' + (hang ? 'h' : 'f');
    return mat;
  }
  const WARP_V = `
    vec4 wp = modelMatrix * vec4(transformed, 1.0);
    float dh = length(wp.xz - cameraPosition.xz);
    wp.y -= uDip * (1.0 - smoothstep(uNearR, uNearR + 120.0, dh));
    vWY = wp.y; vRealD = dh; vWZ = wp.z;
    float ex = smoothstep(700.0, 2400.0, dh);
    wp.y = wp.y * (1.0 + uExag * ex) + max(0.0, wp.y - uBase) * uEx2 * ex;
    vec3 dv = wp.xyz - cameraPosition; float D = length(dv);
    float fD = D < 600.0 ? D : 600.0 + (D - 600.0) * 0.19;
    wp.xyz = cameraPosition + dv * (fD / max(D, 0.001));
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;`;
  const WARP_F = `
    if (uFade > 0.5) { // fade out 450-700 m so the painted horizon layers show; keep the north near the citadel when close
      float fk = max(1.0 - smoothstep(450.0, 700.0, vRealD), uKeep * (1.0 - smoothstep(-950.0, -850.0, vWZ)));
      if (fk < 0.02) discard;
      gl_FragColor.a *= fk;
    }
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
      #else
        float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
      #endif
      fogFactor = min(fogFactor, mix(1.0, uFogMax + (1.0 - uFogMax) * 0.5 * (1.0 - smoothstep(-10.0, 90.0, vWY)), smoothstep(uNearR * uFog0, uNearR * uFog1, vRealD)));
      gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
    #endif`;
  function warpify(mat, o) {
    mat.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, { uNearR: WU.uNearR, uExag: WU.uExag, uDip: { value: o.dip || 0 }, uEx2: { value: o.ex2 || 0 }, uBase: { value: o.base || 1e5 }, uFogMax: { value: o.fogMax || 0.8 }, uFog0: { value: o.fog0 || 0.8 }, uFog1: { value: o.fog1 || 2.0 }, uFade: { value: o.fade ? 1 : 0 }, uKeep: WU.uKeep, uTime: U.time });
      sh.vertexShader = 'uniform float uNearR, uExag, uDip, uEx2, uBase, uTime;\nvarying float vRealD; varying float vWY; varying float vWZ;\n' + sh.vertexShader.replace('#include <project_vertex>', WARP_V);
      sh.fragmentShader = 'uniform float uNearR, uFogMax, uFog0, uFog1, uFade, uKeep, uTime;\nvarying float vRealD; varying float vWY; varying float vWZ;\n' + sh.fragmentShader.replace('#include <fog_fragment>', WARP_F);
      if (o.extra) o.extra(sh);
      mat.userData.sh = sh;
    };
    mat.customProgramCacheKey = () => 'ct-warp-' + o.key;
    return mat;
  }
  // Painterly flame: a camera-facing quad per fire, scrolling fbm inside a teardrop, white core -> orange -> deep red, additive.
  function fireMat() {
    return new T.ShaderMaterial({
      uniforms: { uTime: U.time },
      vertexShader: `varying vec2 vUv; varying vec3 vTint; varying float vSeed;
        void main(){
          vUv = uv; vec3 ip = instanceMatrix[3].xyz;
          float sx = length(instanceMatrix[0].xyz), sy = length(instanceMatrix[1].xyz);
          #ifdef USE_INSTANCING_COLOR
            vTint = instanceColor;
          #else
            vTint = vec3(1.0);
          #endif
          vSeed = fract(sin(dot(ip.xz, vec2(12.9898, 78.233))) * 43758.5453);
          vec4 mv = modelViewMatrix * vec4(ip, 1.0);
          mv.xy += vec2(position.x * sx, position.y * sy);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `uniform float uTime; varying vec2 vUv; varying vec3 vTint; varying float vSeed;
        float h2(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h2(i), h2(i + vec2(1.0, 0.0)), f.x), mix(h2(i + vec2(0.0, 1.0)), h2(i + vec2(1.0, 1.0)), f.x), f.y); }
        float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * vn(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
        void main(){
          float t = uTime + vSeed * 20.0, y = vUv.y, x = (vUv.x - 0.5) * 2.0;
          float n = fbm(vec2(x * 2.2 + vSeed * 9.0, y * 2.6 - t * 2.4));
          float n2 = fbm(vec2(x * 4.5 - 3.0, y * 5.0 - t * 3.6));
          x += (n2 - 0.5) * 0.55 * y;                                         // licking sideways
          float w = mix(0.62, 0.02, pow(y, 0.85)) * (0.7 + 0.6 * n);            // teardrop
          float shape = (1.0 - smoothstep(w * 0.3, w, abs(x))) * smoothstep(0.0, 0.1, y);
          shape *= 1.0 - smoothstep(0.45, 0.95, y + (n - 0.5) * 0.8);
          shape *= smoothstep(0.2, 0.5, n2 + (1.0 - y) * 0.55);                  // tongues and gaps           // ragged tongue tips
          float fl = 0.85 + 0.15 * sin(t * 13.0) * sin(t * 7.7 + 1.3);
          float heat = clamp(shape * (0.55 + 1.0 * n) * fl * (1.3 - y * 0.7), 0.0, 1.25);
          vec3 c = mix(vec3(0.45, 0.02, 0.0), vec3(1.0, 0.32, 0.03), smoothstep(0.05, 0.4, heat));
          c = mix(c, vec3(1.0, 0.78, 0.3), smoothstep(0.4, 0.8, heat));
          c = mix(c, vec3(1.0, 0.97, 0.82), smoothstep(0.85, 1.15, heat));
          gl_FragColor = vec4(c * vTint * heat * 1.7, 1.0);
        }`,
      transparent: true, depthWrite: false, blending: T.AdditiveBlending,
    });
  }
  // Rising embers: one pooled Points cloud, 32 sparks for each of the 8 nearest fires (positions in a uniform array).
  const EMB_N = 8, EMB_PER = 32, embF = [], embC = [];
  function emberMat() {
    for (let i = 0; i < EMB_N; i++) { embF.push(new T.Vector4()); embC.push(new T.Vector3(1, 1, 1)); }
    return new T.ShaderMaterial({
      uniforms: { uTime: U.time, uF: { value: embF }, uC: { value: embC }, uN: { value: 0 }, uH: { value: 720 } },
      vertexShader: `uniform float uTime, uN, uH; uniform vec4 uF[${EMB_N}]; uniform vec3 uC[${EMB_N}];
        attribute float aSlot; attribute vec3 aRnd; varying float vA; varying vec3 vC;
        void main(){
          int si = int(aSlot); vec4 f = uF[si]; float s = f.w;
          float life = fract(uTime * (0.3 + aRnd.x * 0.35) + aRnd.y);
          vec3 p = f.xyz + vec3((aRnd.z - 0.5) * 0.7 * s + sin(uTime * 2.1 + aRnd.y * 20.0) * 0.35 * life * s,
                                life * (2.2 + aRnd.x * 2.0) * s,
                                (fract(aRnd.z * 7.13) - 0.5) * 0.7 * s + cos(uTime * 1.7 + aRnd.x * 15.0) * 0.35 * life * s);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float on = step(aSlot + 0.5, uN);
          vA = on * (1.0 - life) * smoothstep(0.0, 0.08, life); vC = mix(vec3(1.0, 0.75, 0.3), vec3(0.9, 0.18, 0.03), life) * uC[si];
          gl_PointSize = on * max(1.5, uH * projectionMatrix[1][1] * 0.5 * 0.07 * (1.0 - life * 0.5) / max(-mv.z, 0.5));
        }`,
      fragmentShader: `varying float vA; varying vec3 vC;
        void main(){ float a = 1.0 - smoothstep(0.1, 0.5, length(gl_PointCoord - 0.5)); gl_FragColor = vec4(vC * a * vA * 1.6, 1.0); }`,
      transparent: true, depthWrite: false, blending: T.AdditiveBlending,
    });
  }
  function emberGeo() {
    const n = EMB_N * EMB_PER, P = new Float32Array(n * 3), S = new Float32Array(n), Rn = new Float32Array(n * 3), R = CT.rng(777);
    for (let i = 0; i < n; i++) { S[i] = Math.floor(i / EMB_PER); Rn[i * 3] = R(); Rn[i * 3 + 1] = R(); Rn[i * 3 + 2] = R(); }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(P, 3)); g.setAttribute('aSlot', new T.BufferAttribute(S, 1)); g.setAttribute('aRnd', new T.BufferAttribute(Rn, 3));
    return g;
  }
  function haloMat(map) {
    return new T.ShaderMaterial({
      uniforms: { uTime: U.time, map: { value: map } },
      vertexShader: `uniform float uTime; varying vec2 vUv; varying vec3 vCol;
        void main(){ vUv = uv; vec3 ip = instanceMatrix[3].xyz; float s = length(instanceMatrix[0].xyz);
          #ifdef USE_INSTANCING_COLOR
            vCol = instanceColor;
          #else
            vCol = vec3(1.0);
          #endif
          vec4 mv = modelViewMatrix * vec4(ip, 1.0);
          float fl = 0.88 + 0.12 * sin(uTime * 13.0 + ip.x * 2.0) * sin(uTime * 7.3 + ip.z);
          mv.xy += position.xy * s * fl;
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform sampler2D map; varying vec2 vUv; varying vec3 vCol;
        void main(){ float a = texture2D(map, vUv).r; gl_FragColor = vec4(vCol * a * 0.55, 1.0); }`,
      transparent: true, depthWrite: false, blending: T.AdditiveBlending,
    });
  }

  // ── Vegetation + prop prototypes ───────────────────────────────────────────
  function geoPine(snow, far) {
    const b = new Batch(), R = CT.rng(snow ? 77 : 55);
    b.add(cyl(0.16, 0.32, 3.4, far ? 4 : 5, far), M(0, 1.5, 0), 0x3a2a1c);
    const tiers = far ? 2 : 6;
    for (let i = 0; i < tiers; i++) {
      const t = i / (tiers - 1), r = far ? lerp(2.7, 1.5, t) : lerp(2.8, 0.75, t), hh = far ? lerp(5.5, 5.0, t) : lerp(3.0, 2.3, t), y = far ? lerp(2.2, 6.4, t) : lerp(2.2, 9.0, t);
      const g = far ? new T.ConeGeometry(r, hh, 5, 1, true) : lumpy(cone(r, hh, 7), 0.4, i + (snow ? 9 : 0));
      b.add(g, M(0, y + hh / 2, 0, R() * 3, 1, 1, 1, (R() - 0.5) * 0.14, (R() - 0.5) * 0.14),
        (ny, cy, R2) => (snow && ny > 0.2 && R2() < 0.85 ? (R2() < 0.5 ? 0xd8dce4 : 0xb4bccc) : ny < -0.3 ? 0x0e160e : [0x1d2a1c, 0x223020, 0x1a2419, 0x2a3822][(R2() * 4) | 0]));
    }
    if (!far) b.add(cone(0.4, 1.8, 5), M(0, 11.2, 0), snow ? 0xc8ccd4 : 0x22301f);
    return b.geo();
  }
  function geoDead(seed, far) {
    const b = new Batch(), R = CT.rng(seed), v = new T.Vector3();
    const col = (ny, cy, R2) => (R2() < 0.3 ? 0x2a221c : 0x3d332b);
    function limb(x, y, z, dir, len, r, depth) {
      const segs = depth === 0 ? 4 : 3;
      for (let s = 0; s < segs; s++) {
        dir.x += (R() - 0.5) * 0.7; dir.z += (R() - 0.5) * 0.7; dir.y += (R() - 0.5) * 0.3 + (depth ? -0.06 : 0.1); dir.normalize();
        const l = len / segs, nx = x + dir.x * l, ny = y + dir.y * l, nz = z + dir.z * l, r2 = r * 0.72;
        b.add(cyl(r2, r, l * 1.06, far ? 4 : 5, true), limbM(x, y, z, nx, ny, nz), col);
        x = nx; y = ny; z = nz; r = r2;
        if (depth < (far ? 1 : 2) && s >= (depth ? 0 : 1) && R() < (depth ? 0.6 : 0.85)) {
          const d2 = dir.clone(); d2.x += (R() - 0.5) * 1.8; d2.z += (R() - 0.5) * 1.8; d2.y *= 0.5; d2.normalize();
          limb(x, y, z, d2, len * 0.55, r * 0.85, depth + 1);
        }
      }
    }
    limb(0, -0.4, 0, v.set(0.12, 1, 0.05).normalize(), 8.5, 0.45, 0);
    if (!far) for (let k = 0; k < 4; k++) { const a = k * 1.6 + R(); b.add(cyl(0.05, 0.22, 1.8, 4, true), limbM(0, 0.5, 0, Math.sin(a) * 1.4, -0.3, Math.cos(a) * 1.4), col); }
    return b.geo();
  }
  function geoOak(far) {
    const b = new Batch(), R = CT.rng(88);
    const bark = 0x3a2c20, leaf = (ny, cy, R2) => (R2() < 0.08 ? 0x6a4a1c : ny > 0.45 ? (R2() < 0.4 ? 0x4e5424 : 0x444a1e) : ny > -0.2 ? 0x353c18 : 0x1a1e0c);
    b.add(cyl(0.4, 0.7, 4.4, far ? 5 : 7), M(0, 2.0, 0, 0, 1, 1, 1, 0.05, 0.08), bark);
    b.add(cyl(0.2, 0.36, 3.0, 5), limbM(0.2, 3.4, 0, 2.2, 5.6, 0.5), bark);
    b.add(cyl(0.2, 0.36, 3.0, 5), limbM(0, 3.4, 0.1, -2.0, 5.4, -0.9), bark);
    b.add(cyl(0.18, 0.3, 2.6, 5), limbM(0, 3.8, 0, 0.4, 6.0, 2.0), bark);
    const blobs = far ? [[0, 6.6, 0, 3.4], [1.4, 5.8, 1, 2.4]] : [[0, 6.6, 0, 3.0], [2.3, 6.0, 0.8, 2.2], [-2.2, 6.1, -0.9, 2.3], [0.6, 8.0, -0.4, 2.1], [-0.8, 5.8, 2.1, 2.0], [1.0, 5.6, -2.1, 1.9], [-1.9, 7.4, 0.8, 1.7], [1.6, 7.6, 1.2, 1.6]];
    blobs.forEach((q, i) => b.add(lumpy(ico(q[3], far || i > 2 ? 0 : 1), 0.55, i + 3), M(q[0], q[1], q[2], R() * 3, 1, 0.86, 1), leaf));
    return b.geo();
  }
  function geoBush() {
    const b = new Batch(), f = (ny, cy, R2) => (ny > 0.5 ? (R2() < 0.3 ? 0x4a4a22 : 0x3a4020) : ny > -0.2 ? 0x2c3218 : 0x181c0e);
    b.add(lumpy(ico(0.8, 0), 0.25, 5), M(0, 0.45, 0, 0, 1, 0.75, 1), f);
    b.add(lumpy(ico(0.55, 0), 0.2, 6), M(0.6, 0.35, 0.25, 0, 1, 0.8, 1), f);
    b.add(lumpy(ico(0.5, 0), 0.2, 7), M(-0.4, 0.3, -0.45, 0, 1, 0.8, 1), f);
    return b.geo();
  }
  function blades(n, hmin, hmax, lean, lo, his, seed, w) {
    const R = CT.rng(seed), P = [], Cc = [], c0 = new T.Color(lo), c1 = new T.Color();
    for (let k = 0; k < n; k++) {
      const a = k / n * TAU + R() * 0.8, h = hmin + R() * (hmax - hmin), ln = lean * (0.5 + R()), r0 = 0.06 + R() * 0.1;
      const cx = Math.cos(a), sz = Math.sin(a), px = -sz * w, pz = cx * w;
      P.push(cx * r0 - px, 0, sz * r0 - pz, cx * r0 + px, 0, sz * r0 + pz, cx * (r0 + ln), h, sz * (r0 + ln));
      c1.set(his[(R() * his.length) | 0]);
      Cc.push(c0.r, c0.g, c0.b, c0.r, c0.g, c0.b, c1.r, c1.g, c1.b);
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(P, 3)); g.setAttribute('color', new T.Float32BufferAttribute(Cc, 3));
    g.computeVertexNormals();
    const nr = g.attributes.normal; for (let i = 0; i < nr.count; i++) nr.setXYZ(i, 0, 1, 0);
    return g;
  }
  const geoGrass = () => blades(8, 0.35, 0.75, 0.16, 0x33321a, [0x8a7a3a, 0x9a8a46, 0x6c6c30, 0xa89048], 21, 0.05);
  const geoReeds = () => {
    const g = blades(12, 1.1, 2.0, 0.12, 0x2e2e18, [0x6a6434, 0x5a5a2c, 0x7a7040], 23, 0.035);
    const b = new Batch(); b.p = Array.from(g.attributes.position.array); b.c = Array.from(g.attributes.color.array);
    for (let k = 0; k < 3; k++) b.add(BOX, M(Math.sin(k * 2.1) * 0.2, 1.5 + k * 0.15, Math.cos(k * 2.1) * 0.2, 0, 0.08, 0.34, 0.08), 0x3a2414);
    const out = b.geo(); const nr = out.attributes.normal; for (let i = 0; i < nr.count; i++) nr.setXYZ(i, 0, 1, 0); return out;
  };
  function geoFern() {
    const P = [], Cc = [], R = CT.rng(12), c0 = new T.Color(0x22301a), c1 = new T.Color(0x4a5a28), c2 = new T.Color(0x3a4a22);
    for (let k = 0; k < 7; k++) {
      const a = k / 7 * TAU + R() * 0.5, len = 0.9 + R() * 0.5, ca = Math.cos(a), sa = Math.sin(a), w = 0.22;
      const mid = [ca * len * 0.45, 0.5, sa * len * 0.45], tip = [ca * len, 0.15, sa * len];
      const l = [mid[0] - sa * w, mid[1], mid[2] + ca * w], r = [mid[0] + sa * w, mid[1], mid[2] - ca * w];
      P.push(0, 0.05, 0, ...l, ...mid, 0, 0.05, 0, ...mid, ...r, ...l, ...tip, ...mid, ...mid, ...tip, ...r);
      for (const cc of [c0, c1, c2, c0, c2, c1, c1, c2, c2, c2, c2, c1]) Cc.push(cc.r, cc.g, cc.b);
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(P, 3)); g.setAttribute('color', new T.Float32BufferAttribute(Cc, 3));
    g.computeVertexNormals(); return g;
  }
  const rockCol = (ny, cy, R2) => (ny > 0.6 && R2() < 0.5 ? 0x4a5030 : [0x5d544c, 0x4c4540, 0x6a5e52, 0x3e3834][(R2() * 4) | 0]);
  const geoRock = () => new Batch().add(lumpy(new T.DodecahedronGeometry(1, 0), 0.35, 8), M(0, 0.3, 0, 0, 1, 0.7, 1), rockCol).geo();
  const geoBoulder = () => new Batch().add(lumpy(ico(1, 1), 0.3, 18), M(0, 0.35, 0, 0, 1, 0.8, 1), rockCol).geo();
  function geoCrag() {
    const b = new Batch(), R = CT.rng(5), dark = (ny, cy, R2) => (ny > 0.7 ? 0x4a4436 : [0x3f3834, 0x352f2c, 0x4a423c][(R2() * 3) | 0]);
    let y = 0;
    for (let k = 0; k < 4; k++) {
      const w = lerp(5.5, 1.6, k / 3), h = lerp(4, 3.2, k / 3);
      b.add(lumpy(new T.BoxGeometry(w, h, w * 0.8, 1, 2, 1), 0.9, k + 30), M((R() - 0.5) * 0.8, y + h / 2, (R() - 0.5) * 0.8, R() * 3, 1, 1, 1, (R() - 0.5) * 0.2, (R() - 0.5) * 0.2), dark);
      y += h * 0.85;
    }
    b.add(lumpy(cone(1.1, 3.5, 5), 0.5, 40), M(0.2, y + 1.5, 0, 0, 1, 1, 1, 0.15, 0.1), dark);
    return b.geo();
  }
  function geoStump() {
    const g = cyl(0.42, 0.6, 1.2, 7);
    const p = g.attributes.position; for (let i = 0; i < p.count; i++) if (p.getY(i) > 0.5) p.setY(i, 0.6 + hash2(i, 7) * 0.7);
    const b = new Batch(); b.add(g, M(0, 0.5, 0), (ny) => (ny > 0.8 ? 0x5a4a34 : 0x33291f));
    for (let k = 0; k < 3; k++) { const a = k * 2.1; b.add(cyl(0.05, 0.2, 1.2, 4, true), limbM(0, 0.4, 0, Math.sin(a) * 1.0, -0.2, Math.cos(a) * 1.0), 0x2e241a); }
    return b.geo();
  }
  function geoFire() { const g = new T.PlaneGeometry(0.9, 1); g.translate(0, 0.5, 0); return g; }

  function flagGeo(cell, hang) {
    const g = hang ? new T.PlaneGeometry(1.6, 4, 2, 8) : new T.PlaneGeometry(2.2, 1.4, 8, 2);
    g.translate(hang ? 0 : 1.1, hang ? -2 : 0, 0);
    const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setX(i, (cell + uv.getX(i) * 0.98 + 0.01) / 3);
    return g;
  }

  // ── Instance pools (one draw call per kind; chunks keep their own lists) ──
  const pools = {}, poolNames = [];
  const _m = new T.Matrix4(), _p = new T.Vector3(), _q = new T.Quaternion(), _s = new T.Vector3(), _e = new T.Euler(0, 0, 0, 'YXZ');
  function pool(name, geo, mat, per, cap) {
    const m = new T.InstancedMesh(geo, mat, cap);
    m.frustumCulled = false; m.instanceMatrix.setUsage(T.DynamicDrawUsage); m.count = 0; m.visible = false;
    m.instanceColor = new T.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
    scene.add(m);
    pools[name] = { m, per, cap, dirty: false }; poolNames.push(name);
  }
  function put(ch, name, x, y, z, ry, sx, sy, sz, cr, cg, cb, rx, rz) {
    const P2 = pools[name]; let L = ch.inst[name];
    if (!L) L = ch.inst[name] = { m: new Float32Array(P2.per * 16), c: new Float32Array(P2.per * 3), n: 0 };
    if (L.n >= P2.per) return;
    _e.set(rx || 0, ry, rz || 0); _q.setFromEuler(_e); _p.set(x, y, z); _s.set(sx, sy, sz);
    _m.compose(_p, _q, _s); _m.toArray(L.m, L.n * 16);
    L.c[L.n * 3] = cr; L.c[L.n * 3 + 1] = cg; L.c[L.n * 3 + 2] = cb; L.n++;
    P2.dirty = true;
  }
  function pack() {
    for (const name of poolNames) {
      const P2 = pools[name]; if (!P2.dirty) continue;
      P2.dirty = false;
      const im = P2.m.instanceMatrix, ic = P2.m.instanceColor; let n = 0;
      for (const ch of active) {
        const L = ch.inst[name]; if (!L || !L.n) continue;
        const k = Math.min(L.n, P2.cap - n); if (k <= 0) break;
        im.array.set(L.m.subarray(0, k * 16), n * 16); ic.array.set(L.c.subarray(0, k * 3), n * 3); n += k;
      }
      P2.m.count = n; P2.m.visible = n > 0;
      im.clearUpdateRanges(); im.addUpdateRange(0, n * 16); im.needsUpdate = true;
      ic.clearUpdateRanges(); ic.addUpdateRange(0, n * 3); ic.needsUpdate = true;
    }
  }

  // ── Static colliders (POIs) in an 8 m hash ────────────────────────────────
  const SH = new Map(), QM = 2.5, interiors = [];
  const skey = (ix, iz) => (ix + 500) * 2000 + (iz + 500);
  function addStatic(o, ext) {
    const x0 = Math.floor((o.x - ext - QM) / 8), x1 = Math.floor((o.x + ext + QM) / 8), z0 = Math.floor((o.z - ext - QM) / 8), z1 = Math.floor((o.z + ext + QM) / 8);
    for (let j = z0; j <= z1; j++) for (let i = x0; i <= x1; i++) { const k = skey(i, j); let a = SH.get(k); if (!a) SH.set(k, (a = [])); a.push(o); }
  }
  const colCircle = (x, z, r, top) => addStatic({ t: 0, x, z, r, top }, r);
  function colBox(x, z, w, d, rot, top) {
    const o = { t: 1, x, z, hw: w / 2, hd: d / 2, c: Math.cos(rot), s: Math.sin(rot), top };
    addStatic(o, Math.hypot(w, d) / 2);
    return o;
  }
  const inBox = (o, x, z) => { const dx = x - o.x, dz = z - o.z, lx = dx * o.c - dz * o.s, lz = dx * o.s + dz * o.c; return Math.abs(lx) <= o.hw && Math.abs(lz) <= o.hd; };

  // ── Fires (instanced flames + halos + a few real lights) ───────────────────
  const fires = [];
  const FIRE_TINT = [[1, 1, 1], [1.6, 0.42, 0.22], [0.55, 1, 0.8], [0.7, 0.85, 1.2]];
  function fire(x, y, z, s, tint, light) { fires.push({ x, y, z, s, tint: tint || 0, light: !!light }); }
  let lights = [];
  const LCOL = [new T.Color(0xff8a30), new T.Color(0xff3018), new T.Color(0x80ffb0), new T.Color(0x9ab8ff)];

  // ── Common props ───────────────────────────────────────────────────────────
  function skull(b, x, y, z, ry, s = 1) {
    b.add(ico(0.16 * s, 1), M(x, y, z, ry, 1, 0.92, 1.15), BONE);
    bx(b, x + Math.sin(ry) * 0.1 * s, y - 0.12 * s, z + Math.cos(ry) * 0.1 * s, 0.2 * s, 0.08 * s, 0.14 * s, 0xc4b89c, ry, 0, 0, 0);
    const fx = Math.sin(ry), fz = Math.cos(ry), sx = Math.cos(ry), sz = -Math.sin(ry);
    for (const q of [-1, 1]) bx(b, x + fx * 0.15 * s + sx * q * 0.065 * s, y + 0.01, z + fz * 0.15 * s + sz * q * 0.065 * s, 0.07 * s, 0.07 * s, 0.05 * s, 0x080606, ry, 0, 0, 0);
  }
  function skullStake(K, x, z, R) {
    const y = heightAt(x, z), lean = (R() - 0.5) * 0.25, h = 2.2 + R() * 0.8;
    K.f.add(cyl(0.03, 0.07, h, 4), M(x, y + h / 2 - 0.2, z, 0, 1, 1, 1, lean, 0), DWOOD);
    skull(K.f, x, y + h - 0.15 + lean * 0.1, z - lean * h * 0.5, R() * TAU);
    if (R() < 0.4) bx(K.f, x, y + h - 0.7, z - lean * h * 0.35, 0.3, 0.5, 0.02, CLOTH, R() * 3, 0, 0.2);
  }
  function crate(b, x, y, z, s, ry) { bx(b, x, y + s / 2, z, s, s, s, 0x5a4028, ry, 0, 0, 0.15); bx(b, x, y + s / 2, z, s * 1.02, s * 0.14, s * 1.02, DWOOD, ry, 0, 0, 0); }
  function barrel(b, x, y, z, s) {
    b.add(cyl(0.34 * s, 0.3 * s, 0.9 * s, 8), M(x, y + 0.45 * s, z), (ny, cy) => (ny > 0.9 ? 0x6a4a2c : Math.abs(cy) > 0.3 && Math.abs(cy) < 0.4 ? 0x1a1a1a : 0x5a3a22));
  }
  function torchPost(K, x, z, light, tint, h = 2.6) {
    const y = heightAt(x, z);
    K.f.add(cyl(0.07, 0.1, h, 5), M(x, y + h / 2, z), DWOOD);
    K.f.add(cyl(0.18, 0.08, 0.3, 6), M(x, y + h + 0.1, z), IRON);
    fire(x, y + h + 0.2, z, 0.55, tint, light);
  }
  function brazier(K, x, z, tint, light, s = 1) {
    const y = heightAt(x, z);
    for (let k = 0; k < 3; k++) { const a = k * TAU / 3; K.f.add(cyl(0.05 * s, 0.06 * s, 1.5 * s, 4), limbM(x + Math.sin(a) * 0.6 * s, y, z + Math.cos(a) * 0.6 * s, x, y + 1.3 * s, z), IRON); }
    K.f.add(cyl(0.6 * s, 0.3 * s, 0.45 * s, 8), M(x, y + 1.35 * s, z), IRON);
    K.g.add(cyl(0.5 * s, 0.5 * s, 0.05, 8), M(x, y + 1.56 * s, z), tint === 1 ? 0xff3010 : 0xff8a20);
    fire(x, y + 1.5 * s, z, 0.5 * s, tint, light);
  }
  function bonfire(K, x, z, s, tint, light) {
    const y = heightAt(x, z);
    for (let k = 0; k < 10; k++) { const a = k / 10 * TAU; K.f.add(lumpy(ico(0.3 * s, 0), 0.1, k), M(x + Math.sin(a) * 1.5 * s, y + 0.1, z + Math.cos(a) * 1.5 * s, a, 1, 0.7, 1), STONE2); }
    for (let k = 0; k < 7; k++) { const a = k / 7 * TAU; K.f.add(cyl(0.1 * s, 0.14 * s, 2.2 * s, 5), limbM(x + Math.sin(a) * 1.0 * s, y, z + Math.cos(a) * 1.0 * s, x + Math.sin(a) * 0.1, y + 1.7 * s, z + Math.cos(a) * 0.1), k % 2 ? 0x2a1c12 : 0x1a120c); }
    K.g.add(cyl(0.9 * s, 1.0 * s, 0.1, 8), M(x, y + 0.08, z), 0xff5a10);
    fire(x, y + 0.2, z, 2.6 * s, tint, light);
    colCircle(x, z, 1.6 * s, y + 1.5);
  }
  function signpost(K, x, z, targets) {
    const y = heightAt(x, z);
    K.f.add(cyl(0.08, 0.1, 2.8, 5), M(x, y + 1.4, z), WOOD);
    targets.forEach((a, i) => {
      const yy = y + 2.35 - i * 0.38, ca = Math.sin(a), sa = Math.cos(a);
      bx(K.f, x + ca * 0.55, yy, z + sa * 0.55, 0.08, 0.26, 1.1, 0x6a5238, a, 0, 0, 0.1);
      K.f.add(cone(0.18, 0.3, 3), M(x + ca * 1.18, yy, z + sa * 1.18, a, 1, 1, 1, Math.PI / 2, 0), 0x6a5238);
    });
    colCircle(x, z, 0.3, y + 2.8);
  }
  function deadTreeK(K, x, z, s, tint, rx = 0, rz = 0, yOff = -0.2) {
    const k = new Batch(); k.add(protos.dead, null, tint || 0x3a3129, 0.3);
    K.f.merge(k, M(x, heightAt(x, z) + yOff, z, rnd() * TAU, s, s * (0.9 + rnd() * 0.3), s, rx, rz));
    colCircle(x, z, 0.4 * s, heightAt(x, z) + 7 * s);
  }
  function roof(b, w, d, h, y0, col, ov = 0.7, th = 0.22) {
    const hd = d / 2, L = Math.hypot(h, hd) + ov, a = Math.atan2(h, hd), nz = h / Math.hypot(h, hd), ny = hd / Math.hypot(h, hd);
    for (const sg of [1, -1]) {
      const cz = sg * (hd / 2 + nz * th / 2 + hd / Math.hypot(h, hd) * ov / 2 * 1), cy = y0 + h / 2 + ny * th / 2 - h / Math.hypot(h, hd) * ov / 2;
      b.add(BOX, M(0, cy, cz, 0, w + ov * 1.2, th, L, sg * a, 0), col, 0.15);
    }
    b.add(BOX, M(0, y0 + h + 0.12, 0, 0, w + ov * 1.3, 0.22, 0.32), DWOOD, 0.1);
  }
  const flags = []; // {pool, x, y, z, ry, s, r, g, b}
  function flag(pool, x, y, z, ry, s = 1, tint) { flags.push({ pool, x, y, z, ry, s, t: tint || 1 }); }

  // ── Houses ─────────────────────────────────────────────────────────────────
  // Built at the origin: front faces +z, sits on y = 0 (a stone plinth sinks below).
  function house(R, o) {
    const k = kit(), Wd = o.W, D = o.D, H = o.H, RH = o.RH || D * 0.85;
    let wall = o.stone ? [0x5a5652, 0x4e4a46, 0x625c56][(R() * 3) | 0] : [PLASTER, 0x7a6a52, 0x857056, 0x6e6250][(R() * 4) | 0];
    const rc = o.roofCol || [THATCH, SLATE, TILE, 0x3a2e22][(R() * 4) | 0];
    let WB = k.f, RB = k.f, rcol = rc;
    if (TX) { // painted: timber-plaster or rock walls, thatch or clay tiles on the roof (by variety)
      WB = tb(k, o.stone ? 'rock' : 'wall'); wall = o.stone ? [0xd8d0c8, 0xc0b8b0, 0xe0d8d0][(R() * 3) | 0] : [0xffffff, 0xf0e2cc, 0xe4d6c0, 0xd8ccb8][(R() * 4) | 0];
      RB = tb(k, rc === TILE || rc === SLATE ? 'tiles' : 'thatch'); rcol = rc === SLATE ? 0x8a8494 : rc === 0x3a2e22 ? 0xb0a090 : 0xffffff;
    }
    bx(txb(k, 'rock'), 0, 0.2, 0, Wd + 0.3, 1.4, D + 0.3, TX ? 0x9a948c : STONE2, 0, 0, 0, 0.2);
    bx(WB, 0, H / 2, 0, Wd, H, D, wall, 0, 0, 0, 0.12);
    WB.add(prism(Wd, D, RH), M(0, H, 0), wall, 0.1);
    roof(RB, Wd, D, RH, H, rcol);
    if (TX && !o.stone) for (const sx of [-1, 1]) for (const sz of [-1, 1]) bx(k.f, sx * Wd / 2, H / 2, sz * D / 2, 0.3, H, 0.3, DWOOD, 0, 0, 0, 0);
    if (!o.stone && !TX) {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) bx(k.f, sx * Wd / 2, H / 2, sz * D / 2, 0.3, H, 0.3, DWOOD, 0, 0, 0, 0);
      for (const sz of [-1, 1]) { bx(k.f, 0, H - 0.1, sz * (D / 2 + 0.04), Wd, 0.24, 0.12, DWOOD, 0, 0, 0, 0); bx(k.f, 0, H * 0.5, sz * (D / 2 + 0.04), Wd, 0.2, 0.12, DWOOD, 0, 0, 0, 0); }
      for (const sx of [-1, 1]) { bx(k.f, sx * (Wd / 2 + 0.04), H - 0.1, 0, 0.12, 0.24, D, DWOOD, 0, 0, 0, 0); bx(k.f, sx * (Wd / 2 + 0.04), H * 0.5, 0, 0.12, 0.2, D, DWOOD, 0, 0, 0, 0); }
      const nb = Math.max(1, Math.round(Wd / 3.2));
      for (let i = 0; i < nb; i++) { const x = -Wd / 2 + (i + 0.5) * Wd / nb; bx(k.f, x, H * 0.75, D / 2 + 0.05, 0.14, H * 0.55, 0.1, DWOOD, 0, 0, (i % 2 ? 0.6 : -0.6), 0); }
    }
    // door
    bx(k.f, o.doorX || 0, 1.1, D / 2 + 0.06, 1.2, 2.2, 0.12, 0x2a1a10, 0, 0, 0, 0.1);
    bx(k.f, o.doorX || 0, 2.3, D / 2 + 0.1, 1.5, 0.2, 0.18, DWOOD, 0, 0, 0, 0);
    // windows
    const win = (x, y, z, ry) => {
      const lit = R() < 0.7, fx = Math.sin(ry) * 0.02, fz = Math.cos(ry) * 0.02;
      bx(k.f, x, y, z, 0.95, 1.05, 0.08, DWOOD, ry, 0, 0, 0);
      if (lit) k.g.add(new T.PlaneGeometry(0.7, 0.8), M(x + fx * 3, y, z + fz * 3, ry), R() < 0.5 ? 0xffa040 : 0xff8a30);
      else bx(k.f, x + fx * 2, y, z + fz * 2, 0.75, 0.85, 0.06, 0x3a2a1a, ry, 0, 0, 0);
    };
    const nw = Math.max(1, Math.floor(Wd / 3));
    for (let i = 0; i < nw; i++) { const x = -Wd / 2 + (i + 0.5) * Wd / nw; if (Math.abs(x - (o.doorX || 0)) > 1.2) win(x, H * 0.6, D / 2 + 0.06, 0); if (R() < 0.6) win(x, H * 0.6, -D / 2 - 0.06, Math.PI); }
    if (H > 4.2) for (let i = 0; i < nw; i++) win(-Wd / 2 + (i + 0.5) * Wd / nw, H * 0.85 + 0.2, D / 2 + 0.06, 0);
    win(Wd / 2 + 0.06, H * 0.6, 0, Math.PI / 2); win(-Wd / 2 - 0.06, H * 0.6, 0, -Math.PI / 2);
    if (R() < 0.8 || o.chimney) {
      const cxp = (R() < 0.5 ? -1 : 1) * Wd * 0.3;
      bx(txb(k, 'rock'), cxp, H + RH * 0.6, -D * 0.15, 0.8, RH * 1.3 + 1.2, 0.8, TX ? 0xb0a8a0 : STONE, 0, 0, 0, 0.2);
      o.smoke = [cxp, H + RH * 1.3 + 0.6, -D * 0.15];
    }
    return k;
  }
  function placeHouse(K, k, x, z, rot, Wd, D) {
    let y = heightAt(x, z); const c = Math.cos(rot), s = Math.sin(rot);
    for (const q of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { const lx = q[0] * Wd / 2, lz = q[1] * D / 2; y = Math.min(y, heightAt(x + lx * c + lz * s, z - lx * s + lz * c)); }
    placeKit(K, k, M(x, y - 0.05, z, rot));
    colBox(x, z, Wd + 0.3, D + 0.3, rot, y + 12);
    return y;
  }
  const faceTo = (x, z, tx, tz) => Math.atan2(tx - x, tz - z);      // rot so local +z points at the target
  const yawTo = (x, z, tx, tz) => Math.atan2(-(tx - x), -(tz - z));  // camera-style yaw looking at the target
  const L2W = (x, z, rot, lx, lz) => [x + lx * Math.cos(rot) + lz * Math.sin(rot), z - lx * Math.sin(rot) + lz * Math.cos(rot)];

  // palisade ring of sharpened logs with gaps at the given angles
  function palisade(K, cx, cz, rad, gaps, gapW, h, R) {
    const n = Math.round(TAU * rad / 0.6);
    for (let i = 0; i < n; i++) {
      const a = i / n * TAU;
      if (gaps.some(g => Math.abs(Math.atan2(Math.sin(a - g), Math.cos(a - g))) * rad < gapW)) continue;
      const x = cx + Math.sin(a) * rad, z = cz + Math.cos(a) * rad, y = heightAt(x, z), hh = h + R() * 1.4;
      txb(K, 'bark').add(protos.log, M(x, y - 0.6 + hh / 2, z, R() * 6, 1, hh, 1, (R() - 0.5) * 0.08, (R() - 0.5) * 0.08), TX ? (R() < 0.3 ? 0x9a8a7a : 0xd0c0b0) : R() < 0.3 ? 0x3a2818 : 0x4a3422, 0.2);
      txb(K, 'bark').add(protos.logTip, M(x, y - 0.6 + hh + 0.3, z, R() * 6), TX ? 0xe0d0c0 : 0x5a4230, 0.2);
      if (i % 2 === 0) colCircle(x, z, 0.55, y + hh);
      if (i % 3 === 0) bx(K.f, x, y + hh * 0.55, z, 0.7, 0.14, 0.14, DWOOD, a + Math.PI / 2, 0, 0, 0);
    }
    gaps.forEach(g => {
      for (const sd of [-1, 1]) {
        const a = g + sd * (gapW + 0.6) / rad, x = cx + Math.sin(a) * rad, z = cz + Math.cos(a) * rad, y = heightAt(x, z);
        K.f.add(cyl(0.38, 0.42, h + 3, 6), M(x, y + (h + 3) / 2 - 0.5, z), 0x33241a);
        skull(K.f, x, y + h + 2.7, z, g);
      }
    });
  }
  // angles at which roads cross the ring of radius rad around a POI
  function roadAngles(p, rad) {
    const out = [];
    for (const r of roads) for (let i = 1; i < r.n; i++) {
      const d1 = Math.hypot(r.X[i - 1] - p.x, r.Z[i - 1] - p.z) - rad, d2 = Math.hypot(r.X[i] - p.x, r.Z[i] - p.z) - rad;
      if (d1 * d2 <= 0) out.push(Math.atan2(r.X[i] - p.x, r.Z[i] - p.z));
    }
    return out;
  }
  const angFar = (a, list, m) => list.every(g => Math.abs(Math.atan2(Math.sin(a - g), Math.cos(a - g))) > m);

  // ── POI builders ───────────────────────────────────────────────────────────
  const spots = {}, avoid = [];
  const smokes = [];
  function spot(id, x, z, yaw, tag) { (spots[id] = spots[id] || []).push({ x: +x.toFixed(1), z: +z.toFixed(1), yaw: +yaw.toFixed(2), tag }); }

  function buildVillage(p, o) {
    const K = kit(), R = CT.rng(o.seed), PR = o.pr;
    const gates = roadAngles(p, PR);
    bonfire(K, p.x, p.z, 1, 0, true);
    const occ = [[p.x, p.z, 12]];
    const free = (x, z, r) => occ.every(q => (q[0] - x) ** 2 + (q[1] - z) ** 2 > (q[2] + r) ** 2) && samp(RD, x, z) > r + 2.5;
    // well
    for (let t = 0; t < 30; t++) {
      const a = R() * TAU, x = p.x + Math.sin(a) * 9, z = p.z + Math.cos(a) * 9;
      if (!free(x, z, 2)) continue;
      const y = heightAt(x, z);
      K.f.add(cyl(1.1, 1.2, 1.0, 10), M(x, y + 0.45, z), (ny, cy, R2) => (ny > 0.9 ? 0x6a6660 : [0x5a5650, 0x4a4642, 0x66605a][(R2() * 3) | 0]));
      K.f.add(cyl(0.9, 0.9, 0.04, 10), M(x, y + 0.9, z), 0x0a0c0e);
      for (const s of [-1, 1]) bx(K.f, x + s * 1.0, y + 1.5, z, 0.16, 2.2, 0.16, WOOD);
      K.f.add(prism(0.6, 2.4, 0.9), M(x, y + 2.55, z, Math.PI / 2), THATCH, 0.2);
      colCircle(x, z, 1.3, y + 1);
      occ.push([x, z, 2.5]);
      spot(p.id, x + 2.2, z, yawTo(x + 2.2, z, p.x, p.z), 'villager');
      break;
    }
    // gallows (the Crossing)
    if (o.gallows) {
      for (let t = 0; t < 40; t++) {
        const a = R() * TAU, x = p.x + Math.sin(a) * 15, z = p.z + Math.cos(a) * 15, rot = faceTo(x, z, p.x, p.z);
        if (!free(x, z, 4)) continue;
        const g = kit(), y = heightAt(x, z);
        bx(g.f, 0, 0.9, 0, 5, 1.8, 4, WOOD2, 0, 0, 0, 0.2);
        for (let st = 0; st < 4; st++) bx(g.f, 0, 0.22 + st * 0.44, 2.3 + st * 0.35 * -1 + 1.0, 1.4, 0.2, 0.36, WOOD);
        for (const s of [-1, 1]) bx(g.f, s * 1.9, 4.0, -1.2, 0.3, 4.6, 0.3, DWOOD, 0, 0, 0, 0);
        bx(g.f, 0, 6.2, -1.2, 4.4, 0.3, 0.3, DWOOD, 0, 0, 0, 0);
        bx(g.f, 1.2, 5.4, -1.2, 1.3, 0.16, 0.16, DWOOD, 0, 0, 0.6, 0);
        // a noose, and a gibbet cage with a skeleton
        g.f.add(cyl(0.02, 0.02, 1.6, 3), M(-0.6, 5.3, -1.2), 0x8a7a5a);
        g.f.add(new T.TorusGeometry(0.22, 0.03, 3, 8), M(-0.6, 4.35, -1.2, 0, 1, 1, 1, Math.PI / 2, 0), 0x8a7a5a);
        g.f.add(cyl(0.02, 0.02, 1.0, 3), M(0.9, 5.6, -1.2), IRON);
        for (let bI = 0; bI < 8; bI++) { const a2 = bI / 8 * TAU; g.f.add(cyl(0.025, 0.025, 1.9, 3), M(0.9 + Math.sin(a2) * 0.45, 4.1, -1.2 + Math.cos(a2) * 0.45), IRON); }
        for (const yy of [3.15, 5.05]) g.f.add(new T.TorusGeometry(0.45, 0.04, 3, 10), M(0.9, yy, -1.2, 0, 1, 1, 1, Math.PI / 2, 0), IRON);
        skull(g.f, 0.9, 4.6, -1.2, 0.3);
        bx(g.f, 0.9, 4.0, -1.2, 0.3, 0.7, 0.18, BONE, 0, 0, 0.1);
        for (let rb = 0; rb < 4; rb++) bx(g.f, 0.9, 4.2 - rb * 0.13, -1.12, 0.42, 0.04, 0.2, BONE, 0, 0, 0, 0);
        g.f.add(cyl(0.04, 0.04, 0.9, 3), M(0.8, 3.4, -1.2, 0, 1, 1, 1, 0, 0.2), BONE); g.f.add(cyl(0.04, 0.04, 0.9, 3), M(1.0, 3.4, -1.25, 0, 1, 1, 1, 0.15, -0.1), BONE);
        placeKit(K, g, M(x, y, z, rot));
        colBox(x, z, 5.2, 4.2, rot, y + 1.8);
        occ.push([x, z, 5]);
        break;
      }
    }
    // tavern + smithy first, then houses
    const special = [];
    const tryPlace = (w, d, rmin, rmax, cb) => {
      for (let t = 0; t < 400; t++) {
        const a = R() * TAU, r = rmin + R() * (rmax - rmin), x = p.x + Math.sin(a) * r, z = p.z + Math.cos(a) * r;
        const rr = Math.max(w, d) * 0.62;
        if (!angFar(a, gates, (rr + 5) / r) || !free(x, z, rr)) continue;
        occ.push([x, z, rr + 1.2]);
        return cb(x, z, faceTo(x, z, p.x, p.z) + (R() - 0.5) * 0.3);
      }
    };
    tryPlace(12, 8, 20, 30, (x, z, rot) => {
      const o2 = { W: 12, D: 8, H: 5.4, stone: false, chimney: true, roofCol: SLATE };
      const k = house(R, o2);
      // sign on a bracket, lanterns, barrels
      bx(k.f, 3.2, 3.4, 4.9, 0.14, 0.14, 1.9, DWOOD, 0, 0, 0, 0);
      k.f.add(cyl(0.02, 0.02, 0.5, 3), M(3.2, 3.1, 5.6), IRON);
      bx(k.f, 3.2, 2.6, 5.6, 1.4, 0.9, 0.1, 0x5a3a1c, 0, 0, 0, 0.1);
      bx(k.f, 3.2, 2.6, 5.66, 0.5, 0.5, 0.04, 0xa88a3a, 0, 0, 0, 0);
      bx(k.f, 3.2, 2.6, 5.54, 0.5, 0.5, 0.04, 0xa88a3a, 0, 0, 0, 0);
      for (const sx of [-1.6, 1.6]) { k.f.add(cyl(0.12, 0.12, 0.3, 6), M(sx, 2.7, 4.5), IRON); k.g.add(cyl(0.1, 0.1, 0.25, 6), M(sx, 2.5, 4.5), 0xffb050); }
      barrel(k.f, -4.2, 0, 5.0, 1); barrel(k.f, -4.9, 0, 4.6, 0.9); barrel(k.f, -4.5, 0.9, 4.8, 0.85);
      bx(k.f, 5.0, 0.45, 5.4, 2.2, 0.12, 0.8, WOOD2); for (const lx of [4.1, 5.9]) bx(k.f, lx, 0.22, 5.4, 0.12, 0.45, 0.6, WOOD);
      const y = placeHouse(K, k, x, z, rot, 12, 8);
      const [dx, dz] = L2W(x, z, rot, 0, 6.2);
      spot(p.id, dx, dz, yawTo(dx, dz, x, z) + Math.PI, 'tavern');
      const [lx, lz] = L2W(x, z, rot, -1.6, 4.5); lights.length; fire(lx, y + 2.9, lz, 0.001, 0, true);
      if (o2.smoke) { const [sx, sz] = L2W(x, z, rot, o2.smoke[0], o2.smoke[2]); smokes.push([sx, y + o2.smoke[1], sz, R()]); }
      special.push('tavern');
    });
    tryPlace(8, 7, 20, 32, (x, z, rot) => {
      const k = kit(), R2 = R;
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) bx(k.f, sx * 3.6, 1.7, sz * 2.9, 0.3, 3.4, 0.3, DWOOD, 0, 0, 0, 0);
      bx(k.f, 0, 3.3, 0, 8, 0.25, 0.25, DWOOD); bx(k.f, 0, 3.3, 2.9, 8, 0.2, 0.2, DWOOD); bx(k.f, 0, 3.3, -2.9, 8, 0.2, 0.2, DWOOD);
      roof(k.f, 7.6, 6.4, 2.8, 3.4, SLATE, 0.6);
      bx(k.f, 0, 1.6, -3.1, 7.4, 3.2, 0.3, 0x3e3a36, 0, 0, 0, 0.2);  // back wall
      // forge with a hood and glowing coals
      bx(k.f, -2.2, 0.55, -1.6, 2.4, 1.1, 1.8, STONE2, 0, 0, 0, 0.2);
      k.g.add(BOX, M(-2.2, 1.12, -1.6, 0, 1.8, 0.05, 1.3), 0xff5a14);
      k.f.add(cyl(0.5, 1.2, 1.2, 4), M(-2.2, 2.5, -1.6, Math.PI / 4), 0x2e2a28);
      bx(k.f, -2.2, 4.6, -1.8, 0.8, 3.0, 0.8, STONE, 0, 0, 0, 0.2);
      // anvil
      bx(k.f, 0.8, 0.35, 0.2, 0.6, 0.7, 0.5, WOOD2); bx(k.f, 0.8, 0.8, 0.2, 0.9, 0.22, 0.4, IRON, 0, 0, 0, 0);
      k.f.add(cone(0.18, 0.5, 4), M(1.45, 0.8, 0.2, 0, 1, 1, 1, 0, -Math.PI / 2), IRON);
      barrel(k.f, 2.4, 0, -0.8, 1); k.f.add(cyl(0.3, 0.3, 0.03, 8), M(2.4, 0.9, -0.8), 0x14181a);
      // weapon rack
      bx(k.f, 2.5, 1.2, -2.6, 2.2, 0.12, 0.12, WOOD); bx(k.f, 2.5, 0.5, -2.6, 2.2, 0.12, 0.12, WOOD);
      for (let wI = 0; wI < 4; wI++) bx(k.f, 1.7 + wI * 0.5, 1.1, -2.5, 0.06, 1.6, 0.14, 0x8a8a90, 0, 0, (R2() - 0.5) * 0.1, 0);
      const y = heightAt(x, z);
      placeKit(K, k, M(x, y, z, rot));
      const [fx, fz] = L2W(x, z, rot, -2.2, -1.6); fire(fx, y + 1.1, fz, 0.5, 0, true);
      colBox(...L2W(x, z, rot, -2.2, -1.6), 2.4, 1.8, rot, y + 1.1); colBox(...L2W(x, z, rot, 0, -3.1), 7.4, 0.4, rot, y + 3.2);
      colBox(...L2W(x, z, rot, 0.8, 0.2), 0.9, 0.5, rot, y + 0.9);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) colCircle(...L2W(x, z, rot, sx * 3.6, sz * 2.9), 0.25, y + 3.4);
      interiors.push({ x, z, hw: 4, hd: 3.2, c: Math.cos(rot), s: Math.sin(rot) });
      const [sx2, sz2] = L2W(x, z, rot, 1.4, 1.4);
      spot(p.id, sx2, sz2, yawTo(sx2, sz2, x, z) + Math.PI, 'smith');
      special.push('smith');
    });
    let nh = 0;
    for (let t = 0; t < 1200 && nh < o.houses; t++) {
      const a = R() * TAU, r = 16 + R() * (PR - 22), x = p.x + Math.sin(a) * r, z = p.z + Math.cos(a) * r;
      const Wd = 6 + R() * 4, D = 5 + R() * 2, rr = Math.max(Wd, D) * 0.6;
      if (r + rr > PR - 3 || !angFar(a, gates, (rr + 4.5) / r) || !free(x, z, rr)) continue;
      const rot = faceTo(x, z, p.x, p.z) + (R() - 0.5) * 0.4, o2 = { W: Wd, D, H: R() < 0.3 ? 5 : 3.2 + R() * 1, stone: R() < 0.25 };
      const k = house(R, o2), y = placeHouse(K, k, x, z, rot, Wd, D);
      if (o2.smoke) { const [sx, sz] = L2W(x, z, rot, o2.smoke[0], o2.smoke[2]); smokes.push([sx, y + o2.smoke[1], sz, R()]); }
      if (R() < 0.5) { const [bx2, bz2] = L2W(x, z, rot, Wd / 2 + 0.8, D / 2 - 0.5); barrel(K.f, bx2, heightAt(bx2, bz2), bz2, 1); crate(K.f, bx2 + 0.6, heightAt(bx2, bz2), bz2 - 0.6, 0.8, R()); }
      occ.push([x, z, rr + 1.5]); nh++;
      if (nh <= 4) { const [vx, vz] = L2W(x, z, rot, 0, D / 2 + 2); spot(p.id, vx, vz, yawTo(vx, vz, p.x, p.z), 'villager'); }
    }
    // market stalls near the square
    const STALL = [0x6a1a14, 0x7a5a1c, 0x3a2a4a, 0x5a3a18];
    for (let sI = 0, t = 0; sI < 3 && t < 200; t++) {
      const a = R() * TAU, x = p.x + Math.sin(a) * (12 + R() * 5), z = p.z + Math.cos(a) * (12 + R() * 5);
      if (!free(x, z, 2)) continue;
      const rot = faceTo(x, z, p.x, p.z), k = kit(), cl = STALL[sI % 4];
      bx(txb(k, 'planks'), 0, 0.45, 0, 2.6, 0.9, 1.1, TX ? 0xd0c0b0 : WOOD2); bx(txb(k, 'planks'), 0, 0.93, 0, 2.7, 0.08, 1.2, TX ? 0xffffff : 0x6a4a2c);
      for (const q of [[-1.25, 0.55, 2.2], [1.25, 0.55, 2.2], [-1.25, -0.55, 2.6], [1.25, -0.55, 2.6]]) bx(k.f, q[0], q[2] / 2, q[1], 0.1, q[2], 0.1, DWOOD, 0, 0, 0, 0);
      bx(k.d, 0, 2.45, 0, 2.9, 0.05, 1.6, cl, 0, -0.32, 0, 0.1);
      for (let j = 0; j < 7; j++) bx(k.d, -1.2 + j * 0.4, 2.06, 0.78, 0.38, 0.3, 0.03, j % 2 ? cl : 0x8a7a5a, 0, 0, 0, 0);
      const goods = [0x7a1a10, 0x8a6a2a, 0x4a5a2a, 0x6a4a3a, 0x9a8a6a];
      for (let g = 0; g < 8; g++) k.f.add(ico(0.14, 0), M(-1.0 + (g % 4) * 0.62, 1.05, g < 4 ? 0.25 : -0.2), goods[(R() * 5) | 0]);
      const y = heightAt(x, z); placeKit(K, k, M(x, y, z, rot)); colBox(x, z, 2.7, 1.2, rot, y + 1);
      occ.push([x, z, 2.2]); sI++;
      interiors.push({ x, z, hw: 1.4, hd: 0.8, c: Math.cos(rot), s: Math.sin(rot) });
      if (sI === 1) { const [vx, vz] = L2W(x, z, rot, 0, -1.5); spot(p.id, vx, vz, yawTo(vx, vz, p.x, p.z), 'merchant'); }
    }
    // palisade, gates with torches, torches along the roads inside, banners
    palisade(K, p.x, p.z, PR, gates, 6, 4.5, R);
    gates.forEach((g, i) => {
      for (const sd of [-1, 1]) { const a = g + sd * 8.5 / PR; torchPost(K, p.x + Math.sin(a) * (PR - 1.5), p.z + Math.cos(a) * (PR - 1.5), i < 2, 0); }
      const a = g + 11 / PR, x = p.x + Math.sin(a) * (PR - 2.5), z = p.z + Math.cos(a) * (PR - 2.5), y = heightAt(x, z);
      K.f.add(cyl(0.08, 0.1, 7, 5), M(x, y + 3.5, z), WOOD); flag('flagV', x, y + 6.4, z, g + Math.PI / 2, 1);
      const [gx, gz] = [p.x + Math.sin(g) * (PR - 6), p.z + Math.cos(g) * (PR - 6)];
      if (i === 0) spot(p.id, gx, gz, yawTo(gx, gz, p.x + Math.sin(g) * 200, p.z + Math.cos(g) * 200), 'guard');
    });
    for (let k2 = 0; k2 < 6; k2++) {
      const a = k2 / 6 * TAU + 0.4, x = p.x + Math.sin(a) * 20, z = p.z + Math.cos(a) * 20;
      if (free(x, z, 0.8) || samp(RD, x, z) < 6) torchPost(K, x, z, false, 0);
    }
    // the main quest spot: by the bonfire, facing the south gate (the way the player comes in)
    const south = gates.reduce((b, g) => (Math.cos(g) > Math.cos(b) ? g : b), gates[0] || 0);
    const qx = p.x + Math.sin(south) * 5.5, qz = p.z + Math.cos(south) * 5.5;
    spot(p.id, qx, qz, yawTo(qx, qz, p.x + Math.sin(south) * 100, p.z + Math.cos(south) * 100), 'quest');
    spot(p.id, p.x - Math.sin(south) * 4, p.z - Math.cos(south) * 4, yawTo(p.x - Math.sin(south) * 4, p.z - Math.cos(south) * 4, p.x, p.z), 'villager');
    return K;
  }

  function buildShore(p) {
    const K = kit(), R = CT.rng(3);
    // find the waterline south of the POI
    let wz = p.z; while (heightAt(p.x + 20, wz) > -0.2 && wz < p.z + 160) wz += 1;
    const hx = p.x + 24, hz = wz - 9, rot = 0.5;
    const hk = kit();
    bx(hk.f, 0, 0.1, 0, 0.5, 0.5, 18, DWOOD, 0, 0, 0, 0.2);
    for (let i = 0; i < 14; i++) {
      const zz = -8 + i * 1.25, rr = 2.6 * Math.sin(Math.PI * (0.12 + 0.76 * i / 13)) + 0.3, broken = R() < 0.35;
      hk.d.add(new T.TorusGeometry(rr, 0.13, 3, 8, broken ? Math.PI * (0.4 + R() * 0.3) : Math.PI), M(0, rr * 0.9, zz, 0, 1, 1, 1, 0, Math.PI + (broken ? 0 : 0)), 0x3a2a1c, 0.2);
    }
    for (let j = 0; j < 7; j++) {
      const ph = -Math.PI / 2 - 1.1 + j * 0.27, len = 10 + R() * 5, rr = 2.5;
      hk.d.add(BOX, M(Math.cos(ph) * rr, rr * 0.9 + Math.sin(ph) * rr, -2 + (R() - 0.5) * 2, 0, 0.42, 0.08, len, 0, ph + Math.PI / 2), R() < 0.5 ? 0x4a3422 : 0x3a2818, 0.2);
    }
    hk.f.add(cyl(0.24, 0.3, 7, 6), M(0.4, 3.2, 1.5, 0, 1, 1, 1, 0.55, 0.3), WOOD);
    hk.d.add(new T.PlaneGeometry(3, 3.4, 2, 2), M(1.4, 3.6, 3.1, 0.5, 1, 1, 1, 0.6, 0.2), 0x5a4a3a);
    hk.f.add(cyl(0.2, 0.24, 5, 6), M(-4, 0.3, 4, 0.3, 1, 1, 1, Math.PI / 2 - 0.1, 0), WOOD);
    placeKit(K, hk, M(hx, heightAt(hx, hz) - 0.5, hz, rot, 1.7, 1.7, 1.7, 0, 0.38));
    colBox(hx, hz, 9, 30, rot, heightAt(hx, hz) + 7);
    avoid.push([hx, hz, 16]);
    // debris
    for (let i = 0; i < 16; i++) {
      const x = p.x + (R() - 0.3) * 50, z = wz - 5 - R() * 40, y = heightAt(x, z);
      if (y < -0.2) continue;
      const t = R();
      if (t < 0.3) crate(K.f, x, y - 0.1, z, 0.6 + R() * 0.4, R() * 3);
      else if (t < 0.55) { const s = 0.9; K.f.add(cyl(0.34 * s, 0.3 * s, 0.9 * s, 8), M(x, y + 0.3, z, R() * 3, 1, 1, 1, Math.PI / 2, 0), 0x5a3a22); }
      else bx(K.f, x, y + 0.05, z, 0.35, 0.08, 2 + R() * 2, 0x4a3422, R() * 3);
    }
    // campfire where the survivor woke
    const fx = p.x - 7, fz = p.z + 3; bonfire(K, fx, fz, 0.55, 0, true);
    bx(K.f, fx + 2, heightAt(fx + 2, fz) + 0.2, fz - 0.8, 1.8, 0.35, 0.4, DWOOD, 0.6);
    for (let i = 0; i < 5; i++) { const x = p.x - 30 + R() * 60, z = p.z - 30 - R() * 20; if (heightAt(x, z) > 1) deadTreeK(K, x, z, 0.8 + R() * 0.4, 0x4a4038); }
    spot(p.id, fx + 2.5, fz + 1, yawTo(fx + 2.5, fz + 1, fx, fz), 'start');
    return K;
  }

  function buildLodge(p) {
    const K = kit(), R = CT.rng(21), rot = faceTo(p.x, p.z, P.harrowby.x, P.harrowby.z) + 0.3;
    const k = kit(), Wd = 11, D = 7.5, H = 3.3;
    bx(k.f, 0, 0.1, 0, Wd + 0.4, 0.6, D + 0.4, STONE2);
    for (let i = 0; i < 8; i++) {
      const y = 0.25 + i * 0.42, c = i % 2 ? 0x4a3422 : 0x3e2a1a;
      for (const sz of [-1, 1]) txb(k, 'planks').add(cyl(0.22, 0.22, Wd + 0.8, 6), M(0, y, sz * D / 2, 0, 1, 1, 1, 0, Math.PI / 2), TX ? (i % 2 ? 0xe0d0c0 : 0xc0b0a0) : c, 0.1);
      for (const sx of [-1, 1]) k.f.add(cyl(0.22, 0.22, D + 0.8, 6), M(sx * Wd / 2, y + 0.21, 0, 0, 1, 1, 1, Math.PI / 2, 0), c, 0.1);
    }
    k.f.add(prism(Wd, D, 3.6), M(0, H, 0), 0x3a2818);
    roof(k.f, Wd, D, 3.6, H, 0x2e2620, 0.9, 0.3);
    bx(k.f, 0, 1.1, D / 2 + 0.2, 1.3, 2.2, 0.1, 0x1e140c);
    k.g.add(new T.PlaneGeometry(0.8, 0.7), M(-3, 1.8, D / 2 + 0.25), 0xffa040); k.g.add(new T.PlaneGeometry(0.8, 0.7), M(3, 1.8, D / 2 + 0.25), 0xff8a30);
    bx(k.f, 3.8, 4.4, -1.5, 0.9, 4, 0.9, STONE, 0, 0, 0, 0.2);
    // antlers over the door
    const ant = (sx) => { k.f.add(cyl(0.04, 0.06, 1.1, 4), limbM(0, 3.4, D / 2 + 0.35, sx * 0.9, 4.1, D / 2 + 0.5), BONE); for (let t = 0; t < 3; t++) k.f.add(cyl(0.02, 0.04, 0.5, 3), limbM(sx * (0.3 + t * 0.25), 3.6 + t * 0.2, D / 2 + 0.4, sx * (0.25 + t * 0.25), 4.1 + t * 0.2, D / 2 + 0.45), BONE); };
    ant(-1); ant(1); skull(k.f, 0, 3.35, D / 2 + 0.4, 0, 1.3);
    for (const sx of [-2.4, 2.4]) bx(k.f, sx, 1.4, D / 2 + 1.6, 0.2, 2.8, 0.2, DWOOD);
    bx(k.f, 0, 2.85, D / 2 + 1.0, Wd, 0.1, 2.2, 0x2e2620, 0, -0.2);
    const y0 = placeHouse(K, k, p.x, p.z, rot, Wd, D);
    smokes.push([...L2W(p.x, p.z, rot, 3.8, -1.5), y0 + 6.6, R()].slice(0, 2).concat([y0 + 6.6, R()]));
    // fire pit, hide racks, woodpile, hanging deer
    const [fx, fz] = L2W(p.x, p.z, rot, -2, 11); bonfire(K, fx, fz, 0.6, 0, true);
    for (let i = 0; i < 3; i++) {
      const [x, z] = L2W(p.x, p.z, rot, 6 + i * 2.6, 9 + i * 0.8), y = heightAt(x, z), r2 = rot + 0.3, rk = kit();
      for (const s of [-1, 1]) rk.f.add(cyl(0.06, 0.07, 2.4, 4), M(s * 0.95, 1.2, 0), WOOD);
      bx(rk.f, 0, 2.2, 0, 2.1, 0.1, 0.1, WOOD); bx(rk.f, 0, 0.5, 0, 2.1, 0.1, 0.1, WOOD);
      rk.d.add(lumpy(new T.PlaneGeometry(1.6, 1.5, 3, 3), 0.18, i), M(0, 1.35, 0.02), (ny, cy, R2) => (Math.abs(cy) < 0.3 ? 0x8a6a48 : HIDE), 0.2);
      placeKit(K, rk, M(x, y, z, r2)); colBox(x, z, 2.1, 0.3, r2, y + 2.3);
    }
    const [wx, wz] = L2W(p.x, p.z, rot, -Wd / 2 - 1.2, 0), wy = heightAt(wx, wz);
    for (let i = 0; i < 12; i++) K.f.add(cyl(0.18, 0.18, 1.2, 6), M(wx + (i % 4) * 0.02, wy + 0.2 + Math.floor(i / 4) * 0.34, wz - 1.5 + (i % 4) * 0.38 + Math.floor(i / 4) * 0.19, rot, 1, 1, 1, 0, Math.PI / 2), i % 3 ? 0x5a4028 : 0x6a4a2e, 0.1);
    const [tx, tz] = L2W(p.x, p.z, rot, -8, 7), ty = heightAt(tx, tz);
    for (let k2 = 0; k2 < 3; k2++) { const a = k2 * TAU / 3; K.f.add(cyl(0.05, 0.07, 3.4, 4), limbM(tx + Math.sin(a) * 1.2, ty, tz + Math.cos(a) * 1.2, tx, ty + 3.1, tz), WOOD); }
    K.f.add(lumpy(ico(0.5, 1), 0.1, 2), M(tx, ty + 1.9, tz, rot, 0.55, 1.4, 0.7), 0x6a2a1a);
    K.f.add(ico(0.2, 0), M(tx, ty + 0.9, tz + 0.1, 0, 0.7, 1.2, 1.3), 0x5a3a28);
    colCircle(tx, tz, 1.0, ty + 3);
    for (let i = 0; i < 4; i++) { const [x, z] = L2W(p.x, p.z, rot, -12 + R() * 24, -10 - R() * 6); deadTreeK(K, x, z, 0.9 + R() * 0.3); }
    spot(p.id, fx + 2.2, fz + 0.8, yawTo(fx + 2.2, fz + 0.8, fx, fz), 'quest');
    const [vx, vz] = L2W(p.x, p.z, rot, 7, 7); spot(p.id, vx, vz, yawTo(vx, vz, fx, fz), 'villager');
    return K;
  }

  function buildDen(p) {
    const K = kit(), R = CT.rng(44), back = faceTo(p.x, p.z, P.lodge.x, P.lodge.z) + Math.PI; // mound on the far side
    const mx = p.x + Math.sin(back) * 16, mz = p.z + Math.cos(back) * 16;
    const dk = (ny, cy, R2) => (ny > 0.6 && R2() < 0.4 ? 0x3a4028 : [0x3a3430, 0x2e2926, 0x45403a][(R2() * 3) | 0]);
    for (let i = 0; i < 22; i++) {
      const a = back + Math.PI + (i / 21 - 0.5) * 3.8, r = 7 + R() * 9, s = 3 + R() * 5;
      const x = mx + Math.sin(a) * r * (i % 2 ? 0.6 : 1), z = mz + Math.cos(a) * r * (i % 2 ? 0.6 : 1), y = heightAt(x, z);
      K.f.add(lumpy(ico(1, 1), 0.35, i), M(x, y + s * 0.2, z, R() * TAU, s, s * (0.7 + R() * 0.6), s), dk, 0.15);
      colCircle(x, z, s * 0.85, y + s);
    }
    K.f.add(lumpy(ico(1, 1), 0.3, 99), M(mx, heightAt(mx, mz) + 2, mz, 0, 11, 8, 11), dk);
    colCircle(mx, mz, 10, heightAt(mx, mz) + 9);
    // the cave mouth
    const cx = mx - Math.sin(back) * 10, cz = mz - Math.cos(back) * 10, cy = heightAt(cx, cz);
    K.f.add(new T.CircleGeometry(3.2, 10, 0, Math.PI), M(cx, cy - 0.2, cz, back + Math.PI), 0x050404);
    K.f.add(lumpy(new T.TorusGeometry(3.5, 0.9, 4, 8, Math.PI), 0.4, 5), M(cx, cy - 0.3, cz - 0 + 0, back + Math.PI), dk);
    const ox2 = -Math.sin(back) * 0.12, oz2 = -Math.cos(back) * 0.12, lx2 = Math.cos(back), lz2 = -Math.sin(back);
    for (const e of [[-1.2, 0.9], [0.9, 1.4], [0.2, 0.5]]) for (const sd of [-0.16, 0.16]) K.g.add(BOX, M(cx + ox2 + lx2 * (e[0] + sd), cy + e[1], cz + oz2 + lz2 * (e[0] + sd), back, 0.12, 0.07, 0.02), e[1] > 1 ? 0xffc020 : 0xff3010);
    // bones, skulls, a gutted carcass, blood
    for (let i = 0; i < 40; i++) {
      const a = R() * TAU, r = 2 + R() * 14, x = cx + Math.sin(a) * r, z = cz + Math.cos(a) * r, y = heightAt(x, z);
      if (R() < 0.2) skull(K.f, x, y + 0.1, z, R() * TAU, 0.9 + R() * 0.4);
      else K.f.add(cyl(0.035, 0.05, 0.4 + R() * 0.6, 4), M(x, y + 0.05, z, R() * TAU, 1, 1, 1, Math.PI / 2, 0), R() < 0.5 ? BONE : 0xb8ac90);
    }
    const kx = cx - Math.sin(back) * 7, kz = cz - Math.cos(back) * 7, ky = heightAt(kx, kz);
    K.f.add(lumpy(ico(0.6, 1), 0.15, 3), M(kx, ky + 0.35, kz, back, 0.9, 0.6, 1.7), 0x5a1a12);
    for (let i = 0; i < 7; i++) K.f.add(new T.TorusGeometry(0.55, 0.04, 3, 6, Math.PI * 0.9), M(kx, ky + 0.25, kz - 0.7 + i * 0.22, back, 1, 1, 1, 0, 0), BONE);
    K.f.add(new T.CircleGeometry(2.4, 9), M(kx, ky + 0.04, kz, 0, 1, 1, 1, -Math.PI / 2, 0), 0x2a0404);
    for (let i = 0; i < 9; i++) { const a = R() * TAU, r = 20 + R() * 14; deadTreeK(K, p.x + Math.sin(a) * r, p.z + Math.cos(a) * r, 1 + R() * 0.5, 0x2a2420); }
    for (let i = 0; i < 6; i++) { const a = back + Math.PI + (R() - 0.5) * 2.2, r = 22 + R() * 8; skullStake(K, p.x + Math.sin(a) * r, p.z + Math.cos(a) * r, R); }
    spot(p.id, cx - Math.sin(back) * 3, cz - Math.cos(back) * 3, yawTo(cx, cz, p.x, p.z), 'den');
    return K;
  }

  function buildCamp(p) {
    const K = kit(), R = CT.rng(55), PR = 40, gates = roadAngles(p, PR);
    palisade(K, p.x, p.z, PR, gates, 5.5, 5, R);
    bonfire(K, p.x, p.z, 1.4, 0, true);
    const occ = [[p.x, p.z, 7]];
    const free = (x, z, r) => occ.every(q => (q[0] - x) ** 2 + (q[1] - z) ** 2 > (q[2] + r) ** 2) && samp(RD, x, z) > r + 1.5;
    const at = (rmin, rmax, r, cb) => { for (let t = 0; t < 300; t++) { const a = R() * TAU, rr = rmin + R() * (rmax - rmin), x = p.x + Math.sin(a) * rr, z = p.z + Math.cos(a) * rr; if (!angFar(a, gates, (r + 4) / rr) || !free(x, z, r)) continue; occ.push([x, z, r]); cb(x, z, a); return; } };
    // tents
    for (let i = 0; i < 8; i++) at(12, 30, 3, (x, z) => {
      const rot = faceTo(x, z, p.x, p.z), k = kit(), s = 0.9 + R() * 0.5, c = [0x5e4630, 0x4a3a2a, 0x6a5238, 0x3e3024][(R() * 4) | 0];
      k.d.add(prism(4, 3.2, 2.4), M(0, 0, 0, Math.PI / 2), c, 0.2);
      k.f.add(new T.PlaneGeometry(1.2, 1.6), M(0, 0.8, 2.01, 0, 1, 1, 1, 0, 0), 0x120c08);
      for (const sz of [-1, 1]) k.f.add(cyl(0.05, 0.05, 3.2, 4), M(0, 1.4, sz * 2.1), WOOD);
      const y = heightAt(x, z); placeKit(K, k, M(x, y, z, rot, s)); colBox(x, z, 3.4 * s, 4.2 * s, rot, y + 2.4 * s);
    });
    // crates, barrels, cages, weapon racks
    for (let i = 0; i < 10; i++) at(8, 34, 1.3, (x, z) => { const y = heightAt(x, z); if (R() < 0.5) { crate(K.f, x, y, z, 0.9, R()); if (R() < 0.5) crate(K.f, x + 0.1, y + 0.9, z, 0.7, R()); } else { barrel(K.f, x, y, z, 1); barrel(K.f, x + 0.8, y, z + 0.3, 1); } colCircle(x, z, 1, y + 1); });
    for (let i = 0; i < 3; i++) at(14, 32, 2, (x, z) => {
      const y = heightAt(x, z), rot = R() * TAU, k = kit();
      bx(k.f, 0, 0.1, 0, 2.2, 0.2, 2.2, DWOOD); bx(k.f, 0, 2.5, 0, 2.2, 0.2, 2.2, DWOOD);
      for (let bI = 0; bI < 16; bI++) { const s = bI % 4, sd = (bI / 4) | 0, t = -1 + s * 0.66; const q = [[t, -1.05], [1.05, t], [-t, 1.05], [-1.05, -t]][sd]; k.f.add(cyl(0.03, 0.03, 2.4, 3), M(q[0], 1.3, q[1]), IRON); }
      skull(k.f, 0.3, 0.35, 0.2, 1); for (let bb = 0; bb < 5; bb++) k.f.add(cyl(0.03, 0.04, 0.6, 3), M(-0.3 + bb * 0.15, 0.25, -0.2, bb, 1, 1, 1, Math.PI / 2, 0), BONE);
      placeKit(K, k, M(x, y, z, rot)); colBox(x, z, 2.2, 2.2, rot, y + 2.5);
    });
    // the watchtower
    at(28, 33, 3, (x, z, a) => {
      const y = heightAt(x, z), k = kit();
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.f.add(cyl(0.16, 0.2, 9, 6), M(sx * 1.6, 4.5, sz * 1.6, 0, 1, 1, 1, -sz * 0.04, sx * 0.04), WOOD);
      for (const yy of [2.5, 5.5]) for (let s = 0; s < 4; s++) { const q = [[0, 1.6], [1.6, 0], [0, -1.6], [-1.6, 0]][s]; bx(k.f, q[0], yy, q[1], s % 2 ? 0.12 : 3.4, 0.14, s % 2 ? 3.4 : 0.12, DWOOD, 0, 0, s % 2 ? 0 : 0.7, s % 2 ? 0.7 : 0); }
      bx(k.f, 0, 8.2, 0, 4, 0.25, 4, WOOD2);
      for (let s = 0; s < 4; s++) { const q = [[0, 1.9], [1.9, 0], [0, -1.9], [-1.9, 0]][s]; bx(k.f, q[0], 8.9, q[1], s % 2 ? 0.1 : 3.8, 1.1, s % 2 ? 3.8 : 0.1, WOOD, 0, 0, 0, 0.2); }
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) bx(k.f, sx * 1.8, 10, sz * 1.8, 0.12, 2.2, 0.12, DWOOD);
      k.f.add(cone(3.4, 2.4, 4), M(0, 12.3, 0, Math.PI / 4), THATCH);
      for (let r = 0; r < 12; r++) bx(k.f, 0, 0.5 + r * 0.66, 2.3, 0.9, 0.08, 0.1, WOOD, 0, 0, 0, 0);
      for (const sx of [-0.45, 0.45]) bx(k.f, sx, 4.1, 2.3, 0.1, 8.2, 0.1, WOOD, 0, 0, 0, 0);
      const rot = a + Math.PI; placeKit(K, k, M(x, y, z, rot)); colBox(x, z, 3.6, 3.6, rot, y + 12);
      k.f.add(cyl(0.05, 0.05, 3, 4), M(0, 14, 0), WOOD);
      flag('flagHand', x, y + 14.8, z, rot, 1.1);
      spot(p.id, x, z, yawTo(x, z, p.x, p.z) + Math.PI, 'guard');
    });
    // the black hand banner over the fire + stakes outside
    const bxx = p.x + 5, bzz = p.z - 3, by = heightAt(bxx, bzz);
    K.f.add(cyl(0.1, 0.14, 9, 6), M(bxx, by + 4.5, bzz), DWOOD);
    bx(K.f, bxx, by + 8.6, bzz, 2.2, 0.14, 0.14, DWOOD); flag('hangHand', bxx, by + 8.5, bzz, 0.4, 1.2);
    for (let i = 0; i < 14; i++) { const a = R() * TAU; if (!angFar(a, gates, 0.12)) continue; const r = PR + 4 + R() * 12; skullStake(K, p.x + Math.sin(a) * r, p.z + Math.cos(a) * r, R); }
    gates.forEach(g => { for (const sd of [-1, 1]) brazier(K, p.x + Math.sin(g + sd * 7 / PR) * (PR - 2), p.z + Math.cos(g + sd * 7 / PR) * (PR - 2), 0, false, 0.8); });
    for (let i = 0; i < 6; i++) { const a = i / 6 * TAU + 0.3, x = p.x + Math.sin(a) * 9, z = p.z + Math.cos(a) * 9; spot(p.id, x, z, yawTo(x, z, p.x, p.z) + Math.PI, 'guard'); }
    spot(p.id, p.x + 4, p.z + 4, yawTo(p.x + 4, p.z + 4, p.x, p.z) + Math.PI, 'boss');
    return K;
  }

  function buildStones(p) {
    const K = kit(), R = CT.rng(66), y0 = heightAt(p.x, p.z);
    for (let i = 0; i < 9; i++) {
      const a = i / 9 * TAU + 0.2, x = p.x + Math.sin(a) * 15, z = p.z + Math.cos(a) * 15, y = heightAt(x, z), h = 5.5 + R() * 2.5, sk = kit();
      sk.f.add(lumpy(new T.BoxGeometry(1.8, h, 1.0, 1, 3, 1), 0.3, i), M(0, h / 2 - 0.5, 0), (ny, cy, R2) => (ny > 0.7 ? 0x4a5030 : [0x55504a, 0x4a4540, 0x5f5850][(R2() * 3) | 0]), 0.1);
      for (let g = 0; g < 4; g++) {
        const gy = h * 0.3 + g * 0.9;
        for (let s = 0; s < 3; s++) sk.g.add(BOX, M((R() - 0.5) * 0.5, gy + (R() - 0.5) * 0.4, 0.62, 0, 0.07, 0.3 + R() * 0.25, 0.04, 0, (R() - 0.5) * 2.2), 0xff2410);
      }
      placeKit(K, sk, M(x, y, z, faceTo(x, z, p.x, p.z), 1, 1, 1, (R() - 0.5) * 0.12, (R() - 0.5) * 0.12));
      colCircle(x, z, 1.2, y + h);
    }
    // the altar: a slab on two blocks with a dark red stain and candles
    for (const s of [-1, 1]) bx(K.f, p.x + s * 1.1, y0 + 0.5, p.z, 0.8, 1.0, 1.4, 0x4a4540, 0, 0, 0, 0.2);
    bx(K.f, p.x, y0 + 1.15, p.z, 3.2, 0.35, 1.8, 0x55504a, 0, 0, 0, 0.2);
    K.g.add(new T.CircleGeometry(0.6, 7), M(p.x + 0.3, y0 + 1.335, p.z, 0, 1, 1, 1, -Math.PI / 2, 0), 0x6a0404);
    for (let c = 0; c < 5; c++) { const x = p.x - 1.3 + c * 0.65, z = p.z + (c % 2 ? 0.6 : -0.6); K.f.add(cyl(0.05, 0.05, 0.25, 4), M(x, y0 + 1.45, z), 0x9a8a70); fire(x, y0 + 1.58, z, 0.12, 1, c === 2); }
    colBox(p.x, p.z, 3.2, 1.8, 0, y0 + 1.3);
    for (let i = 0; i < 8; i++) { const a = R() * TAU, r = 26 + R() * 10; skullStake(K, p.x + Math.sin(a) * r, p.z + Math.cos(a) * r, R); }
    spot(p.id, p.x, p.z + 3, yawTo(p.x, p.z + 3, p.x, p.z), 'altar');
    return K;
  }

  function buildFen(p) {
    const K = kit(), R = CT.rng(77);
    const hx = p.x + 62, hz = p.z - 48, rot = faceTo(hx, hz, p.x, p.z), hy = 0.3;
    extraClear.push([hx, hz, 16]);
    const k = kit();
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.f.add(cyl(0.16, 0.2, 3.4, 5), M(sx * 2.4, 1.2, sz * 2.0, 0, 1, 1, 1, sz * 0.08, -sx * 0.08), 0x2e241a);
    bx(k.f, 0, 2.7, 0, 6, 0.25, 5, 0x3a2e22);
    bx(k.f, 0, 4.1, 0, 4.4, 2.6, 3.6, 0x3a3226, 0, 0, 0.06, 0.2);
    k.f.add(prism(4.6, 3.8, 3.6), M(0.1, 5.35, 0, 0, 1, 1, 1, 0, 0.1), 0x3a3226);
    roof(k.f, 4.6, 3.8, 3.6, 5.35, 0x2a2618, 0.8, 0.3);
    bx(k.f, 0, 3.8, 1.85, 1.0, 1.9, 0.1, 0x120c08);
    k.g.add(new T.PlaneGeometry(0.6, 0.6), M(-1.4, 4.4, 1.86), 0x80ffb0);
    for (let st = 0; st < 6; st++) bx(k.f, 0, 2.5 - st * 0.42, 3.0 + st * 0.5, 1.2, 0.1, 0.45, 0x3a2e22, 0, 0, 0, 0.2);
    // hanging charms and bones
    for (let c = 0; c < 6; c++) { const x = -2.2 + c * 0.88; k.f.add(cyl(0.01, 0.01, 0.8, 3), M(x, 4.95, 2.1), 0x6a5a40); skull(k.f, x, 4.45, 2.12, 0, 0.6); }
    const y = heightAt(hx, hz);
    placeKit(K, k, M(hx, Math.max(y, 0) - 0.2 + hy, hz, rot));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) colCircle(...L2W(hx, hz, rot, sx * 2.4, sz * 2.0), 0.3, 3);
    // lanterns on poles around the hut and along the walkway
    for (let i = 0; i < 5; i++) {
      const [x, z] = L2W(hx, hz, rot, (i % 2 ? 1 : -1) * (3 + i * 0.3), 4 + i * 4), yy = Math.max(heightAt(x, z), -0.3);
      K.f.add(cyl(0.06, 0.08, 3.2, 4), M(x, yy + 1.4, z, 0, 1, 1, 1, 0.08, 0), 0x2e241a);
      bx(K.f, x + 0.35, yy + 2.95, z, 0.8, 0.07, 0.07, 0x2e241a, 0, 0, 0, 0);
      K.f.add(cyl(0.12, 0.15, 0.3, 5), M(x + 0.7, yy + 2.6, z), IRON);
      fire(x + 0.7, yy + 2.5, z, 0.3, 2, i === 1);
      avoid.push([x, z, 0.3]); colCircle(x, z, 0.2, yy + 3);
    }
    // broken walkways from the road to the hut
    const w0 = L2W(hx, hz, rot, 0, 5.5);
    let sx0 = w0[0], sz0 = w0[1];
    const tx = p.x, tz = p.z, n = Math.floor(Math.hypot(tx - sx0, tz - sz0) / 1.4);
    for (let i = 0; i < n; i++) {
      const t = i / n, x = lerp(sx0, tx, t), z = lerp(sz0, tz, t);
      if (R() < 0.12) continue;
      const yy = Math.max(heightAt(x, z), -0.2) + 0.45, br = R() < 0.12;
      avoid.push([x, z, 1.1]);
      bx(K.f, x, yy - (br ? 0.3 : 0), z, 2.0, 0.1, 1.2, R() < 0.5 ? 0x4a3a28 : 0x3a2e22, rot + Math.PI / 2 + (R() - 0.5) * 0.12, br ? 0.3 : 0, (R() - 0.5) * 0.1);
      if (i % 3 === 0) for (const s of [-1, 1]) { const [px2, pz2] = [x + Math.cos(rot) * s * 1.0, z - Math.sin(rot) * s * 1.0]; K.f.add(cyl(0.07, 0.08, 1.6, 4), M(px2, yy - 0.4, pz2), 0x2e241a); }
    }
    // sunken trees and stumps
    for (let i = 0; i < 16; i++) {
      const a = R() * TAU, r = 20 + R() * 110, x = p.x + Math.sin(a) * r, z = p.z + Math.cos(a) * r;
      if ((x - hx) ** 2 + (z - hz) ** 2 < 180) continue;
      deadTreeK(K, x, z, 0.9 + R() * 0.7, 0x2c2a22, (R() - 0.5) * 0.5, (R() - 0.5) * 0.5, -1.2);
    }
    const [qx, qz] = L2W(hx, hz, rot, -3.8, 9);
    spot(p.id, qx, qz, yawTo(qx, qz, p.x, p.z), 'quest');
    spot(p.id, p.x + 3, p.z + 2, yawTo(p.x + 3, p.z + 2, hx, hz), 'villager');
    return K;
  }

  function buildRuins(p) {
    const K = kit(), R = CT.rng(88), y0 = heightAt(p.x, p.z);
    if (TX) K.f = K.d = tb(K, 'stone'); // painted rock on every ruin surface
    const pale = (ny, cy, R2) => (ny > 0.7 && R2() < 0.35 ? MOSS : [0xbdb6a6, 0xaaa394, 0xc8c2b4, 0x9e988a][(R2() * 4) | 0]);
    // ring of broken columns around the 30 m arena (kept clear)
    for (let i = 0; i < 14; i++) {
      const a = i / 14 * TAU, x = p.x + Math.sin(a) * 19, z = p.z + Math.cos(a) * 19, y = heightAt(x, z), h = R() < 0.35 ? 1 + R() * 2 : 4 + R() * 5;
      K.f.add(cyl(0.65, 0.75, h, 8), M(x, y + h / 2, z), pale, 0.08);
      bx(K.f, x, y + 0.2, z, 1.8, 0.4, 1.8, 0xaaa394);
      if (h > 6) bx(K.f, x, y + h + 0.2, z, 1.7, 0.4, 1.7, 0xc8c2b4);
      colCircle(x, z, 0.85, y + h);
      if (h < 3) { const fa = R() * TAU, fx = x + Math.sin(fa) * 3.5, fz = z + Math.cos(fa) * 3.5; if (Math.hypot(fx - p.x, fz - p.z) > 17) { K.f.add(cyl(0.6, 0.6, 5, 8), M(fx, heightAt(fx, fz) + 0.5, fz, fa, 1, 1, 1, Math.PI / 2, 0), pale); colCircle(fx, fz, 1.5, y + 1.2); } }
    }
    // arena floor slabs (cracked)
    K.f.add(cyl(16, 16.4, 0.5, 24), M(p.x, y0 - 0.18, p.z), (ny, cy, R2) => (ny > 0.5 ? [0x9e988a, 0xa8a292, 0x8e887c][(R2() * 3) | 0] : 0x7a7468), 0.1);
    for (let i = 0; i < 24; i++) { const a = i / 24 * TAU; bx(K.f, p.x + Math.sin(a) * 16.2, y0 + 0.1, p.z + Math.cos(a) * 16.2, 3.8, 0.35, 0.9, 0xbdb6a6, a, 0, 0, 0.12); }
    for (let i = 0; i < 46; i++) { const a = R() * TAU, r = Math.sqrt(R()) * 14.5; bx(K.f, p.x + Math.sin(a) * r, y0 + 0.08, p.z + Math.cos(a) * r, 1.2 + R() * 1.6, 0.04, 1.2 + R() * 1.6, R() < 0.25 ? 0x6e6a5e : 0xb4ae9e, R() * 3, 0, 0, 0.1); }
    K.g.add(new T.RingGeometry(5.8, 6.2, 32), M(p.x, y0 + 0.1, p.z, 0, 1, 1, 1, -Math.PI / 2, 0), 0x9ab8e8);
    // the moon altar at the north edge
    const ax = p.x, az = p.z - 13, ay = heightAt(ax, az);
    for (let s = 0; s < 3; s++) K.f.add(cyl(3.2 - s * 0.8, 3.4 - s * 0.8, 0.45, 12), M(ax, ay + 0.22 + s * 0.45, az), pale);
    K.f.add(cyl(0.7, 0.9, 1.6, 8), M(ax, ay + 2.1, az), 0xc8c2b4);
    K.g.add(new T.TorusGeometry(1.5, 0.28, 4, 14, Math.PI * 1.25), M(ax, ay + 4.3, az, 0, 1, 1, 1, 0, 1.2), 0xcfe0ff);
    K.g.add(ico(0.35, 1), M(ax, ay + 3.25, az), 0xe8f0ff);
    fire(ax, ay + 3.0, az, 0.001, 3, true);
    colCircle(ax, az, 3.2, ay + 3);
    // broken towers with jagged tops
    for (let i = 0; i < 4; i++) {
      const a = i / 4 * TAU + 0.6 + R() * 0.5, r = 38 + R() * 16, x = p.x + Math.sin(a) * r, z = p.z + Math.cos(a) * r, y = heightAt(x, z), rr = 3.5 + R() * 1.5, h = 12 + R() * 16;
      const g = new T.CylinderGeometry(rr, rr * 1.1, h, 12, 5, true), pp = g.attributes.position;
      for (let v = 0; v < pp.count; v++) { const vy = pp.getY(v); if (vy > h * 0.1) { const ang = Math.atan2(pp.getX(v), pp.getZ(v)); pp.setY(v, vy - (0.5 + 0.5 * Math.sin(ang * 3 + i)) * h * 0.35 * ((vy + h / 2) / h)); } }
      K.d.add(g, M(x, y + h / 2 - 1, z), pale, 0.1);
      for (let wI = 0; wI < 4; wI++) { const wa = R() * TAU, wy = y + 3 + R() * h * 0.5; K.f.add(new T.PlaneGeometry(0.9, 1.8), M(x + Math.sin(wa) * (rr + 0.05), wy, z + Math.cos(wa) * (rr + 0.05), wa), 0x0c0a0a); }
      colCircle(x, z, rr + 0.3, y + h);
      for (let rb = 0; rb < 8; rb++) { const ra = R() * TAU, rd = rr + 1 + R() * 5; bx(K.f, x + Math.sin(ra) * rd, heightAt(x + Math.sin(ra) * rd, z + Math.cos(ra) * rd) + 0.3, z + Math.cos(ra) * rd, 0.8 + R(), 0.6 + R() * 0.5, 0.8 + R(), 0xb4ae9e, R() * 3, R() * 0.4, R() * 0.4); }
    }
    // arches, one broken
    for (let i = 0; i < 3; i++) {
      const a = i * 2.1 + 1.1, r = 30 + i * 3, x = p.x + Math.sin(a) * r, z = p.z + Math.cos(a) * r, y = heightAt(x, z), rot = a + Math.PI / 2, ak = kit();
      if (TX) ak.f = ak.d = tb(ak, 'stone');
      for (const s of [-1, 1]) { bx(ak.f, s * 3, 3.5, 0, 1.4, 7, 1.4, 0xbdb6a6, 0, 0, 0, 0.1); }
      const segs = i === 2 ? 5 : 9;
      for (let sI = 0; sI < segs; sI++) { const t = (sI + 0.5) / 9 * Math.PI; bx(ak.f, -Math.cos(t) * 3, 7 + Math.sin(t) * 2.6, 0, 1.2, 0.9, 1.3, 0xc8c2b4, 0, 0, -Math.cos(t) * 0.9, 0.05); }
      placeKit(K, ak, M(x, y, z, rot));
      for (const s of [-1, 1]) colCircle(...L2W(x, z, rot, s * 3, 0), 1.0, y + 7);
    }
    // collapsed temple on the south side: steps + stumps of a colonnade
    const tz = p.z + 34, tyy = heightAt(p.x, tz);
    bx(K.f, p.x, tyy + 0.4, tz, 22, 0.8, 12, 0xaaa394, 0, 0, 0, 0.1); bx(K.f, p.x, tyy + 1.0, tz + 0.5, 18, 0.5, 9, 0xbdb6a6, 0, 0, 0, 0.1);
    for (let c = 0; c < 6; c++) { const x = p.x - 7.5 + c * 3, h = 2 + R() * 7; K.f.add(cyl(0.55, 0.6, h, 8), M(x, tyy + 1.2 + h / 2, tz + 3.5), pale); colCircle(x, tz + 3.5, 0.7, tyy + h); }
    bx(K.f, p.x + 3, tyy + 2.2, tz + 0.5, 9, 1.0, 1.4, 0xc8c2b4, 0.3, 0, 0.35);
    colBox(p.x, tz, 22, 12, 0, tyy + 1.2);
    spot(p.id, p.x - 6, p.z - 12, yawTo(p.x - 6, p.z - 12, p.x, p.z), 'quest');
    spot(p.id, p.x, p.z, yawTo(p.x, p.z, p.x, p.z + 50), 'boss');
    return K;
  }

  function buildPass(p) {
    const K = kit(), R = CT.rng(99), y0 = heightAt(p.x, p.z);
    // Bone King banners on tall poles, lining the road through the pass
    const road = roads[3]; const road2 = roads[4];
    let cnt = 0;
    for (const r of [road, road2]) for (let i = 0; i < r.n; i += 9) {
      const x = r.X[i], z = r.Z[i], d = Math.hypot(x - p.x, z - p.z); if (d > 140 || d < 8) continue;
      const nx = r.Z[Math.min(r.n - 1, i + 1)] - z, nz = -(r.X[Math.min(r.n - 1, i + 1)] - x), l = Math.hypot(nx, nz) || 1, sd = cnt++ % 2 ? 1 : -1;
      const px2 = x + nx / l * 5.5 * sd, pz2 = z + nz / l * 5.5 * sd, y = heightAt(px2, pz2);
      K.f.add(cyl(0.09, 0.12, 8, 5), M(px2, y + 4, pz2), 0x1c1818);
      bx(K.f, px2, y + 7.6, pz2, 1.9, 0.12, 0.12, 0x1c1818, Math.atan2(nx, nz) + Math.PI / 2);
      skull(K.f, px2, y + 8.2, pz2, R() * 3);
      flag('hangSkull', px2, y + 7.5, pz2, Math.atan2(nx, nz) + Math.PI / 2, 1);
    }
    // frozen corpses: stylised fallen warriors crusted in ice
    for (let i = 0; i < 9; i++) {
      const a = R() * TAU, r = 6 + R() * 50, x = p.x + Math.sin(a) * r * 0.5, z = p.z + Math.cos(a) * r, y = heightAt(x, z), ck = kit(), pose = R();
      const ice = 0x9aaabb, dark = 0x3a3e46;
      if (pose < 0.5) { // lying
        ck.f.add(lumpy(ico(0.4, 1), 0.08, i), M(0, 0.28, 0, 0, 0.8, 0.5, 2.0), ice); skull(ck.f, 0, 0.35, 0.95, 0, 1.2);
        bx(ck.f, 0.35, 0.2, -0.6, 0.25, 0.2, 0.9, dark, 0.2); bx(ck.f, -0.35, 0.2, -0.6, 0.25, 0.2, 0.9, dark, -0.1);
      } else { // kneeling, head bowed
        ck.f.add(lumpy(ico(0.4, 1), 0.08, i), M(0, 0.95, 0, 0, 0.9, 1.2, 0.7, 0.35, 0), ice);
        ck.f.add(ico(0.18, 1), M(0, 1.55, 0.35), 0xc8d0da); bx(ck.f, 0, 0.3, -0.1, 0.8, 0.5, 0.9, dark);
        bx(ck.f, 0.4, 0.9, 0.35, 0.2, 0.7, 0.2, ice, 0, 0.8, 0);
      }
      bx(ck.f, 0.7, 0.8, 0.2, 0.06, 1.6, 0.18, 0x8a8e96, 0, 0, 0.35); // sword in the snow
      if (R() < 0.5) ck.f.add(cyl(0.45, 0.45, 0.08, 10), M(-0.8, 0.25, 0.2, 0, 1, 1, 1, 1.2, 0), dark);
      placeKit(K, ck, M(x, y, z, R() * TAU));
    }
    // the broken bridge high over the pass
    valley(p.x, p.z - 40); const vz = p.z - 40, deckY = _vf + 30, span = 13 + 30 / 2.3 + 4;
    const bk = kit(), stone = (ny, cy, R2) => [0x5a5650, 0x4a4642, 0x3e3a36][(R2() * 3) | 0];
    for (let s = -1; s <= 1; s += 2) {
      for (let sI = 0; sI < 9; sI++) {
        const x = s * (span - sI * 2.1);
        if (Math.abs(x) < 4.5 + (s > 0 ? 3 : 0)) continue;
        bx(bk.f, x, deckY, 0, 2.2, 1.2, 5, stone, 0, 0, s * (sI > 6 ? 0.08 : 0), 0.1);
        bx(bk.f, x, deckY + 1.1, 2.2, 2.2, 1.0, 0.5, stone); bx(bk.f, x, deckY + 1.1, -2.2, 2.2, 1.0, 0.5, stone);
        const ay = deckY - 1.2 - Math.sqrt(Math.max(0, 1 - (x / span) ** 2)) * 0 - (1 - Math.abs(x) / span) * -2;
        bx(bk.f, x, ay - 1.5, 0, 2.1, 2.2, 4.4, stone, 0, 0, 0, 0.1);
      }
      bx(bk.f, s * (span + 2), deckY - 8, 0, 4, 16, 6, stone, 0, 0, 0, 0.1);
    }
    for (let d = 0; d < 6; d++) bx(bk.f, 1 + d * 0.7, deckY - 1.5 - d * 1.2, (R() - 0.5) * 2, 0.7, 0.6, 0.8, stone, R(), R(), R());
    placeKit(K, bk, M(p.x + (_vd > 0 ? 0 : 0), 0, vz, 0));
    for (let i = 0; i < 8; i++) { const r = roads[3], j = Math.floor(R() * r.n); if (Math.hypot(r.X[j] - p.x, r.Z[j] - p.z) < 220) skullStake(K, r.X[j] + (R() < 0.5 ? -4 : 4), r.Z[j], R); }
    spot(p.id, p.x, p.z + 20, yawTo(p.x, p.z + 20, p.x, p.z + 120), 'guard');
    spot(p.id, p.x, p.z - 30, yawTo(p.x, p.z - 30, p.x, p.z + 120), 'guard');
    return K;
  }

  // THE CITADEL: a black gothic fortress on the crag, and the Crimson Throne.
  function buildCitadel(p) {
    const K = kit(), R = CT.rng(1250), ox = p.x, oz = p.z, y0 = heightAt(ox, oz);
    const blk = (ny, cy, R2) => (ny > 0.8 ? 0x2e2a30 : [0x1e1b22, 0x25212a, 0x1a171c, 0x2a2530][(R2() * 4) | 0]);
    const spireC = (ny, cy, R2) => (R2() < 0.25 ? 0x2e2230 : 0x17141a);
    const RED = 0xff2a12, RED2 = 0xd8180a;
    const slit = (x, y, z, ry, w = 0.7, h = 2.6) => K.g.add(archShape(w, h), M(x, y, z, ry), R() < 0.8 ? RED : RED2);
    function tower(x, z, r, h, sh, sides = 8, base = y0 - 14) {
      const top = y0 + h;
      K.f.add(cyl(r, r * 1.12, top - base, sides), M(x, (top + base) / 2, z, Math.PI / sides), blk, 0.1);
      K.f.add(cyl(r * 1.2, r * 0.98, 2, sides), M(x, top + 1, z, Math.PI / sides), blk);
      for (let i = 0; i < sides * 2; i += 2) { const a = (i / (sides * 2)) * TAU; bx(K.f, x + Math.sin(a) * r * 1.12, top + 2.6, z + Math.cos(a) * r * 1.12, r * 0.4, 1.4, 0.7, BLACK2, a); }
      K.f.add(cone(r * 0.95, sh, sides), M(x, top + 2 + sh / 2, z, Math.PI / sides), spireC);
      for (let i = 0; i < 4; i++) { const a = i / 4 * TAU + 0.4; K.f.add(cone(r * 0.22, sh * 0.35, 4), M(x + Math.sin(a) * r * 1.05, top + 2 + sh * 0.17, z + Math.cos(a) * r * 1.05), spireC); }
      for (let lv = 0; lv < Math.floor(h / 9); lv++) for (let i = 0; i < 3; i++) { const a = R() * TAU; slit(x + Math.sin(a) * (r + 0.1), y0 + 6 + lv * 9 + R() * 2, z + Math.cos(a) * (r + 0.1), a); }
      colCircle(x, z, r * 1.1, top);
    }
    // curtain wall: an octagon of 95 m with a gatehouse to the south
    const RW = 95, V = [];
    for (let i = 0; i < 8; i++) { const a = i / 8 * TAU + TAU / 16; V.push([ox + Math.sin(a) * RW, oz + Math.cos(a) * RW]); }
    for (let i = 0; i < 8; i++) {
      const a = V[i], b = V[(i + 1) % 8], mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, len = Math.hypot(b[0] - a[0], b[1] - a[1]), rot = Math.atan2(b[0] - a[0], b[1] - a[1]) + Math.PI / 2;
      const isGate = i === 7; // the edge centred on angle 0 (south)
      const pieces = isGate ? [[-len / 4 - 3.5, len / 2 - 7], [len / 4 + 3.5, len / 2 - 7]] : [[0, len]];
      for (const [off, l] of pieces) {
        const [cx2, cz2] = L2W(mx, mz, rot, off, 0);
        bx(K.f, cx2, y0 + 3, cz2, l, 26, 4, blk, rot, 0, 0, 0.1);
        for (let m = -l / 2 + 1; m < l / 2; m += 2.6) { const [mx2, mz2] = L2W(cx2, cz2, rot, m, 1.6); bx(K.f, mx2, y0 + 17, mz2, 1.4, 2, 1, BLACK2, rot); }
        for (let bI = -l / 2 + 6; bI < l / 2 - 3; bI += 9) { const [bx2, bz2] = L2W(cx2, cz2, rot, bI, 2.8); bx(K.f, bx2, y0 + 1, bz2, 1.6, 22, 2.4, blk, rot, 0.1); K.f.add(cone(0.8, 4, 4), M(bx2, y0 + 13, bz2, rot + Math.PI / 4), spireC); }
        colBox(cx2, cz2, l, 4.2, rot, y0 + 16);
        for (let wI = 0; wI < 2; wI++) { const [sx2, sz2] = L2W(cx2, cz2, rot, (R() - 0.5) * l * 0.8, 2.05); slit(sx2, y0 + 9, sz2, rot, 0.6, 1.8); }
      }
    }
    V.forEach(v => tower(v[0], v[1], 6, 26, 18));
    // gatehouse
    const gz = oz + RW * Math.cos(TAU / 16);
    for (const s of [-1, 1]) tower(ox + s * 8.5, gz, 5, 30, 22, 6);
    bx(K.f, ox, y0 + 20, gz, 13, 8, 5, blk); for (let m = -6; m <= 6; m += 2) bx(K.f, ox + m, y0 + 24.8, gz + 2, 1.2, 1.6, 1, BLACK2);
    for (let b = 0; b < 7; b++) bx(K.f, ox - 3 + b, y0 + 14.2, gz + 1.8, 0.18, 3.6, 0.18, IRON, 0, 0, 0, 0);
    K.g.add(archShape(7, 3.5), M(ox, y0 + 16.5, gz + 2.6), 0x3a0804);
    slit(ox, y0 + 19.5, gz + 2.55, 0, 1.4, 3.4);
    flag('hangSkull', ox - 4, y0 + 23.5, gz + 2.7, 0, 1.3); flag('hangSkull', ox + 4, y0 + 23.5, gz + 2.7, 0, 1.3);
    brazier(K, ox - 6, gz + 7, 1, true, 1.3); brazier(K, ox + 6, gz + 7, 1, false, 1.3);
    // the arena: 40 m square, open to the sky, entrance to the south
    const AH = 22, a0 = oz - 20, a1 = oz + 20;
    for (const s of [-1, 1]) { bx(K.f, ox + s * 21.5, y0 + AH / 2 - 2, oz, 3, AH + 4, 43, blk); colBox(ox + s * 21.5, oz, 3, 43, 0, y0 + AH); }
    bx(K.f, ox, y0 + AH / 2 - 2, a0 - 1.5, 43, AH + 4, 3, blk); colBox(ox, a0 - 1.5, 43, 3, 0, y0 + AH);
    for (const s of [-1, 1]) { bx(K.f, ox + s * 13, y0 + AH / 2 - 2, a1 + 1.5, 17, AH + 4, 3, blk); colBox(ox + s * 13, a1 + 1.5, 17, 3, 0, y0 + AH); }
    for (const s of [-1, 1]) tower(ox + s * 6, a1 + 2, 3.2, 34, 16, 6, y0 - 2);
    bx(K.f, ox, y0 + 18, a1 + 1.5, 9, 8, 3, blk); K.g.add(archShape(8.5, 8), M(ox, y0 + 11.9, a1 + 3.05, 0, 1, 1, 1), 0x2a0402);
    // inner pillars + buttresses with red slits, braziers in the corners
    for (let i = 0; i < 5; i++) for (const s of [-1, 1]) {
      const z = oz - 16 + i * 8;
      bx(K.f, ox + s * 19.4, y0 + 10, z, 1.4, 20, 1.4, BLACK2); K.f.add(cone(1.0, 5, 4), M(ox + s * 19.4, y0 + 22.5, z, Math.PI / 4), spireC);
      slit(ox + s * 19.9 * 1.0 - s * 0.72, y0 + 9, z + 4, s > 0 ? -Math.PI / 2 : Math.PI / 2, 1.0, 4.5);
      bx(K.f, ox + s * 24, y0 + 7, z, 3, 20, 1.8, blk, 0, 0, s * -0.08); K.f.add(cone(0.9, 6, 4), M(ox + s * 24.6, y0 + 20, z, Math.PI / 4), spireC);
    }
    for (const q of [[-16, -15], [16, -15], [-16, 15], [16, 15]]) brazier(K, ox + q[0], oz + q[1], 1, q[1] < 0, 1.5);
    // floor flagstones with old blood
    for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++) bx(K.f, ox - 19 + i * 2, y0 + 0.05, oz - 19 + j * 2, 1.92, 0.1, 1.92, R() < 0.06 ? 0x3a0808 : [0x2a2628, 0x322d30, 0x262224][(R() * 3) | 0], 0, 0, 0, 0.08);
    // THE CRIMSON THRONE: bone and red crystal on a stepped dais at the north end
    const tz = oz - 15, ty = y0;
    for (let s = 0; s < 4; s++) bx(K.f, ox, ty + 0.3 + s * 0.6, tz - s * 0.9, 14 - s * 2.6, 0.6, 8 - s * 1.6, s % 2 ? 0x2a2226 : 0x1e1a1e, 0, 0, 0, 0.1);
    const st = ty + 2.4;
    bx(K.f, ox, st + 1.2, tz - 2.2, 5.2, 2.4, 3.2, 0x3a1014, 0, 0, 0, 0.1);            // seat block (dried crimson)
    bx(K.f, ox, st + 6.2, tz - 3.6, 5.6, 10, 1.2, 0x2a0c10, 0, -0.06, 0, 0.1);          // backrest
    for (const s of [-1, 1]) { // armrests of huge femurs capped with skulls
      K.f.add(cyl(0.32, 0.32, 3.4, 6), M(ox + s * 2.9, st + 2.8, tz - 2.0, 0, 1, 1, 1, Math.PI / 2, 0), BONE);
      K.f.add(ico(0.55, 1), M(ox + s * 2.9, st + 2.8, tz - 0.3), BONE); skull(K.f, ox + s * 2.9, st + 3.5, tz - 0.4, 0, 2.4);
    }
    for (let i = 0; i < 9; i++) { // ribs arching around the backrest
      const t = (i / 8 - 0.5) * 2.4;
      K.f.add(new T.TorusGeometry(3.4 + Math.abs(t) * 0.4, 0.14, 3, 10, Math.PI * 0.8), M(ox + t * 1.3, st + 5.5, tz - 3.9, 0, 1, 1, 1, 0, Math.PI * 0.1 + t * 0.2), BONE);
    }
    for (let i = 0; i < 26; i++) { const a = R() * Math.PI - Math.PI / 2, r = 3 + R() * 3; skull(K.f, ox + Math.sin(a) * r, ty + 0.4 + R() * 1.8, tz - 1 + Math.cos(a) * r * 0.6, (R() - 0.5) * 1.5, 1.6 + R() * 1.2); }
    for (let i = 0; i < 13; i++) { // the crimson crown of crystals
      const t = (i / 12 - 0.5), h = 4 + (1 - Math.abs(t) * 2) * 6 + R() * 2;
      K.g.add(new T.OctahedronGeometry(0.7, 0), M(ox + t * 7.5, st + 10 + h * 0.35, tz - 3.8, R(), 0.7, h * 0.55, 0.7, (R() - 0.5) * 0.3, -t * 0.9), i % 3 ? 0xff1a1a : 0xff5040);
    }
    for (let i = 0; i < 10; i++) { const a = R() * TAU; K.g.add(new T.OctahedronGeometry(0.5, 0), M(ox + Math.sin(a) * (4 + R() * 3), ty + 0.8, tz + Math.cos(a) * 2.5, R(), 0.6, 1.5 + R() * 2, 0.6, (R() - 0.5) * 0.8, (R() - 0.5) * 0.8), 0xd81010); }
    fire(ox, st + 6, tz - 2, 0.001, 1, true);
    colBox(ox, tz - 1.5, 14, 8, 0, ty + 2.4);
    // the keep behind the throne with the great spire
    const kz = oz - 44;
    bx(K.f, ox, y0 + 18, kz, 60, 50, 40, blk); roofK(ox, y0 + 43, kz);
    function roofK(x, y, z) { K.f.add(prism(60, 40, 22), M(x, y, z), spireC); }
    for (let i = 0; i < 7; i++) for (let lv = 0; lv < 3; lv++) slit(ox - 24 + i * 8, y0 + 12 + lv * 11, kz + 20.05, 0, 1.6, 5);
    K.g.add(new T.CircleGeometry(4.5, 12), M(ox, y0 + 50, kz + 20.1 + 1), 0xff2010);
    K.f.add(new T.TorusGeometry(4.8, 0.6, 4, 12), M(ox, y0 + 50, kz + 20.2 + 1), BLACK2);
    tower(ox, kz - 6, 9, 70, 55, 8, y0);
    for (const q of [[-28, 18], [28, 18], [-28, -20], [28, -20]]) tower(ox + q[0], kz + q[1], 4.5, 56, 26, 6, y0);
    colBox(ox, kz, 60, 40, 0, y0 + 60);
    // side towers flanking the arena
    for (const s of [-1, 1]) { tower(ox + s * 42, oz, 7, 60, 30, 8, y0 - 4); tower(ox + s * 60, oz + 40, 5, 38, 20, 6, y0 - 8); }
    // braziers up the switchback road, bone stakes along it
    const cr = roads[4];
    for (let i = 20; i < cr.n; i += 38) { const nx = cr.Z[Math.min(cr.n - 1, i + 1)] - cr.Z[i], nz = -(cr.X[Math.min(cr.n - 1, i + 1)] - cr.X[i]), l = Math.hypot(nx, nz) || 1; brazier(K, cr.X[i] + nx / l * 4.2, cr.Z[i] + nz / l * 4.2, 1, false, 1.1); }
    for (let i = 5; i < cr.n; i += 17) { const nx = cr.Z[Math.min(cr.n - 1, i + 1)] - cr.Z[i], nz = -(cr.X[Math.min(cr.n - 1, i + 1)] - cr.X[i]), l = Math.hypot(nx, nz) || 1; skullStake(K, cr.X[i] - nx / l * 4, cr.Z[i] - nz / l * 4, R); }
    spot(p.id, ox, tz - 1, yawTo(ox, tz - 1, ox, oz + 50), 'boss');
    for (const q of [[-10, 40], [10, 40], [-30, 60], [30, 60], [0, 70]]) spot(p.id, ox + q[0], oz + q[1], yawTo(ox + q[0], oz + q[1], ox, gz + 30), 'guard');
    return K;
  }

  // Road furniture: signposts at junctions and skulls on stakes near danger.
  function buildRoadDeco() {
    const K = kit(), R = CT.rng(404);
    const DANGER = ['camp', 'wolfden', 'pass', 'fen', 'ruins', 'stones'];
    for (const r of roads) {
      for (const [id, fromEnd] of [[r.a, false], [r.b, true]]) {
        if (!id || id === 'citadel') continue;
        const p = P[id], want = p.radius * 0.75 + 12;
        for (let t = 0; t < r.n; t++) {
          const i = fromEnd ? r.n - 1 - t : t, d = Math.hypot(r.X[i] - p.x, r.Z[i] - p.z);
          if (d < want) continue;
          const j = fromEnd ? Math.max(0, i - 3) : Math.min(r.n - 1, i + 3), nx = r.Z[j] - r.Z[i], nz = -(r.X[j] - r.X[i]), l = Math.hypot(nx, nz) || 1;
          const other = fromEnd ? r.a : r.b, o = other ? P[other] : { x: r.X[fromEnd ? 0 : r.n - 1], z: r.Z[fromEnd ? 0 : r.n - 1] };
          signpost(K, r.X[i] + nx / l * 3.4, r.Z[i] + nz / l * 3.4, [faceTo(r.X[i], r.Z[i], o.x, o.z), faceTo(r.X[i], r.Z[i], p.x, p.z)]);
          break;
        }
      }
      for (let i = 0; i < r.n; i += 14) {
        const x = r.X[i], z = r.Z[i];
        if (!DANGER.some(id => { const d = Math.hypot(x - P[id].x, z - P[id].z); return d > P[id].radius * 0.8 && d < P[id].radius + 130; })) continue;
        const j = Math.min(r.n - 1, i + 1), nx = r.Z[j] - z, nz = -(r.X[j] - x), l = Math.hypot(nx, nz) || 1, sd = R() < 0.5 ? -1 : 1;
        if (R() < 0.55) skullStake(K, x + nx / l * 4 * sd, z + nz / l * 4 * sd, R);
      }
    }
    return K;
  }

  // Nudge every NPC spot until it has 1.5 m of free ground around it.
  function blocked(x, z, m) {
    const a = SH.get(skey(Math.floor(x / 8), Math.floor(z / 8)));
    if (a) for (const o of a) {
      if (o.t) { const dx = x - o.x, dz = z - o.z, lx = dx * o.c - dz * o.s, lz = dx * o.s + dz * o.c, ex = Math.max(0, Math.abs(lx) - o.hw), ez = Math.max(0, Math.abs(lz) - o.hd); if (ex * ex + ez * ez < m * m) return true; }
      else if ((x - o.x) ** 2 + (z - o.z) ** 2 < (o.r + m) ** 2) return true;
    }
    for (const q of avoid) if ((x - q[0]) ** 2 + (z - q[1]) ** 2 < (q[2] + m) ** 2) return true;
    return heightAt(x, z) < -0.6;
  }
  function clearSpots() {
    for (const id in spots) for (const sp of spots[id]) {
      if (!blocked(sp.x, sp.z, 1.5)) continue;
      search: for (let r = 1; r <= 8; r += 0.5) for (let k = 0; k < 16; k++) {
        const a = k / 16 * TAU, x = sp.x + Math.sin(a) * r, z = sp.z + Math.cos(a) * r;
        if (!blocked(x, z, 1.5)) { sp.x = +x.toFixed(1); sp.z = +z.toFixed(1); break search; }
      }
    }
  }

  // ── Road ribbon (one mesh) ─────────────────────────────────────────────────
  function roadMesh() {
    const P2 = [], UV = [], N = [], I = [];
    let base = 0;
    const across = [-2.4, -1.1, 0, 1.1, 2.4];
    for (const r of roads) {
      let run = false;
      for (let i = 0; i < r.n; i++) {
        const skip = trimmed(r, i);
        if (skip) { run = false; continue; }
        const a = Math.max(0, i - 1), b = Math.min(r.n - 1, i + 1), dx = r.X[b] - r.X[a], dz = r.Z[b] - r.Z[a], l = Math.hypot(dx, dz) || 1, nx = -dz / l, nz = dx / l;
        for (let c = 0; c < 5; c++) {
          const u = across[c], x = r.X[i] + nx * u, z = r.Z[i] + nz * u;
          P2.push(x, heightAt(x, z) + 0.07 + 0.05 * (1 - (u / 2.4) ** 2), z); N.push(0, 1, 0); UV.push((u + 2.4) / 4.8, i * 2 / 5);
        }
        if (run) for (let c = 0; c < 4; c++) { const p0 = base - 5 + c, p1 = base + c; I.push(p0, p0 + 1, p1, p0 + 1, p1 + 1, p1); }
        base += 5; run = true;
      }
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(P2, 3)); g.setAttribute('normal', new T.Float32BufferAttribute(N, 3)); g.setAttribute('uv', new T.Float32BufferAttribute(UV, 2));
    g.setIndex(I); g.computeBoundingSphere();
    const m = new T.Mesh(g, mats.road); m.frustumCulled = false; return m;
  }

  // ── Terrain colour ─────────────────────────────────────────────────────────
  const COL = {};
  function colors() {
    const hex = { grassA: 0x4c5424, grassB: 0x6e6a30, grassD: 0x353c1c, floor: 0x2c2e1a, needles: 0x3e3020, hillA: 0x4e5028, hillB: 0x64563a,
      mud: 0x302e1c, moss: 0x3e4424, snow: 0xd2d6de, snowS: 0xa8b0c0, rock: 0x5d544c, rockD: 0x3a3431, rockW: 0x6e5a48,
      sand: 0xa08a64, wet: 0x6a5e4a, road: 0x6b5236, trample: 0x4e4030, ash: 0x29262a, ashR: 0x2f2426, flag: 0x2a2729, seabed: 0x4a4a3e, canopy: 0x1a2216, umber: 0x5a4430, lush: 0x33421e, ochre: 0x8a7a3a };
    for (const k in hex) COL[k] = new T.Color(hex[k]);
  }
  const _tc = { r: 0, g: 0, b: 0 };
  const mixc = (c, t) => { _tc.r += (c.r - _tc.r) * t; _tc.g += (c.g - _tc.g) * t; _tc.b += (c.b - _tc.b) * t; };
  const setc = (a, b, t) => { _tc.r = a.r + (b.r - a.r) * t; _tc.g = a.g + (b.g - a.g) * t; _tc.b = a.b + (b.b - a.b) * t; };
  function tcol(x, z, h, ny, far) {
    weights(x, z, W);
    const n1 = vnoise(x * 0.05, z * 0.05), n2 = vnoise(x * 0.012 + 5, z * 0.012);
    setc(COL.grassA, COL.grassB, sstep(0.3, 0.7, n2));
    let r = _tc.r * W.meadow, g = _tc.g * W.meadow, b = _tc.b * W.meadow;
    setc(COL.floor, COL.needles, sstep(0.35, 0.65, n1)); r += _tc.r * W.forest; g += _tc.g * W.forest; b += _tc.b * W.forest;
    setc(COL.hillA, COL.hillB, sstep(0.3, 0.75, n2 * 0.6 + n1 * 0.4)); r += _tc.r * W.hills; g += _tc.g * W.hills; b += _tc.b * W.hills;
    setc(COL.mud, COL.moss, sstep(0.4, 0.7, n1)); r += _tc.r * W.swamp; g += _tc.g * W.swamp; b += _tc.b * W.swamp;
    setc(COL.hillA, COL.rockW, 0.5); r += _tc.r * W.snow; g += _tc.g * W.snow; b += _tc.b * W.snow;
    _tc.r = r; _tc.g = g; _tc.b = b;
    const pd = fbm(x * 0.006 + 20, z * 0.006 + 4, 2), open = W.meadow + W.hills;
    if (open > 0.05) { mixc(COL.umber, sstep(0.56, 0.7, pd) * 0.55 * open); mixc(COL.lush, sstep(0.42, 0.3, pd) * 0.5 * open); mixc(COL.ochre, sstep(0.72, 0.85, n1) * 0.35 * W.meadow); }
    // snow on the northern heights (steep faces stay dark rock)
    const sn = W.snow * sstep(55, 95, h + n1 * 30) * sstep(0.62, 0.8, ny);
    if (sn > 0) mixc(sstep(0.4, 0.6, n1) > 0.5 ? COL.snowS : COL.snow, sn);
    // rock on steep ground
    const rk = sstep(0.84, 0.66, ny + (n1 - 0.5) * 0.08);
    if (rk > 0) { setc(COL.rock, COL.rockD, sstep(0.3, 0.7, n2)); const rr = _tc.r, rg = _tc.g, rb = _tc.b; _tc.r = r; _tc.g = g; _tc.b = b; if (sn > 0) mixc(COL.snow, sn); mixc({ r: rr, g: rg, b: rb }, rk); }
    // coast sand
    if (Math.abs(x) > 950 || Math.abs(z) > 950) {
      const c = coastC(x, z), s = sstep(70, 25, c) * (1 - cliffK(x, z) * 0.8) * sstep(7, 2, h);
      if (s > 0) mixc(COL.sand, s);
    }
    if (h < 0.5) mixc(COL.wet, sstep(0.5, -0.3, h) * (1 - W.swamp * 0.6));
    if (h < -0.6) mixc(COL.seabed, sstep(-0.6, -3, h));
    // roads and trampled POI ground
    const rd = samp(RD, x, z);
    if (rd < 7) mixc(COL.road, (1 - sstep(2.5, 6.2, rd + n1 * 1.6)) * 0.85);
    for (const id of ['harrowby', 'crossing', 'camp', 'lodge']) { const p = P[id], d = Math.hypot(x - p.x, z - p.z), fr = FLAT[id][0]; if (d < fr) mixc(COL.trample, (1 - sstep(fr * 0.35, fr, d + n1 * 10)) * 0.75); }
    const rc = Math.hypot(x, z + 1250);
    if (rc < 400) { mixc(n1 > 0.55 ? COL.ashR : COL.ash, sstep(400, 230, rc) * 0.94); if (rc < 97) mixc(COL.flag, 0.9); }
    if (far) { const tr = W.forest * 0.75 + W.snow * 0.25 * sstep(200, 150, h) + W.hills * 0.12; mixc(COL.canopy, tr * sstep(0.7, 0.9, ny)); }
    const v = 0.86 + 0.28 * vnoise(x * 0.31, z * 0.31);
    _tc.r *= v; _tc.g *= v; _tc.b *= v;
    return _tc;
  }

  // ── Terrain chunks ─────────────────────────────────────────────────────────
  const CH = 64, NF = 33, NCs = 17;
  const chunks = new Map(), active = [], spare = [];
  let idxFine = null, idxCoarse = null;
  function gridIndex(n) {
    const I = [];
    for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) { const a = r * n + c, b = a + 1, d = a + n, e = d + 1; I.push(a, d, b, b, d, e); }
    const sk = n * n, edge = [i => i, i => (n - 1) * n + i, i => i * n, i => i * n + n - 1];
    for (let s = 0; s < 4; s++) for (let i = 0; i < n - 1; i++) {
      const a = edge[s](i), b = edge[s](i + 1), a2 = sk + s * n + i, b2 = a2 + 1;
      I.push(a, a2, b, b, a2, b2, a, b, a2, b, b2, a2);
    }
    return new T.BufferAttribute(new Uint16Array(I), 1);
  }
  const ckey = (cx, cz) => (cx + 100) * 1000 + (cz + 100);
  function newChunk() {
    const nv = NF * NF + 4 * NF, g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(new Float32Array(nv * 3), 3));
    g.setAttribute('normal', new T.BufferAttribute(new Float32Array(nv * 3), 3));
    g.setAttribute('color', new T.BufferAttribute(new Float32Array(nv * 3), 3));
    g.setAttribute('uv', new T.BufferAttribute(new Float32Array(nv * 2), 2));
    g.setAttribute('splat', new T.BufferAttribute(new Float32Array(nv * 4), 4));
    g.boundingSphere = new T.Sphere(new T.Vector3(), 50);
    const mesh = new T.Mesh(g, mats.terrain); mesh.matrixAutoUpdate = false; mesh.visible = false; scene.add(mesh);
    const cells = []; for (let i = 0; i < 100; i++) cells.push([]);
    return { mesh, g, cx: 0, cz: 0, key: -1, lod: -1, inst: {}, loot: [], cX:new Float32Array(2000), cZ: new Float32Array(2000), cR: new Float32Array(2000), cT: new Float32Array(2000), nc: 0, cells };
  }
  function addCol(ch, x, z, r, top) {
    if (ch.nc >= 2000) return;
    const i = ch.nc++, x0 = ch.cx * CH - 8, z0 = ch.cz * CH - 8;
    ch.cX[i] = x; ch.cZ[i] = z; ch.cR[i] = r; ch.cT[i] = top;
    const i0 = clamp(Math.floor((x - r - QM - x0) / 8), 0, 9), i1 = clamp(Math.floor((x + r + QM - x0) / 8), 0, 9);
    const j0 = clamp(Math.floor((z - r - QM - z0) / 8), 0, 9), j1 = clamp(Math.floor((z + r + QM - z0) / 8), 0, 9);
    for (let j = j0; j <= j1; j++) for (let k = i0; k <= i1; k++) ch.cells[j * 10 + k].push(i);
  }
  function buildTerrain(ch) {
    const n = ch.lod ? NF : NCs, st = CH / (n - 1), x0 = ch.cx * CH, z0 = ch.cz * CH, g = ch.g;
    const Pp = g.attributes.position.array, Nn = g.attributes.normal.array, Cc = g.attributes.color.array, UVv = g.attributes.uv.array, Sp = g.attributes.splat.array;
    let hmin = 1e9, hmax = -1e9;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      const x = x0 + c * st, z = z0 + r * st, j = r * n + c, h = heightAt(x, z);
      const e = st * 0.5, nx = heightAt(x - e, z) - heightAt(x + e, z), nz = heightAt(x, z - e) - heightAt(x, z + e), ny = 2 * e, l = Math.hypot(nx, ny, nz);
      Pp[j * 3] = x; Pp[j * 3 + 1] = h; Pp[j * 3 + 2] = z;
      Nn[j * 3] = nx / l; Nn[j * 3 + 1] = ny / l; Nn[j * 3 + 2] = nz / l;
      const col = tcol(x, z, h, ny / l, false);
      Cc[j * 3] = col.r * 1.12; Cc[j * 3 + 1] = col.g * 1.12; Cc[j * 3 + 2] = col.b * 1.12;
      UVv[j * 2] = x / 8; UVv[j * 2 + 1] = z / 8;
      splatAt(x, z, h, Sp, j * 4);
      if (h < hmin) hmin = h; if (h > hmax) hmax = h;
    }
    const edge = [i => i, i => (n - 1) * n + i, i => i * n, i => i * n + n - 1], sd = ch.lod ? 3 : 7;
    for (let s = 0; s < 4; s++) for (let i = 0; i < n; i++) {
      const a = edge[s](i), b = n * n + s * n + i;
      Pp[b * 3] = Pp[a * 3]; Pp[b * 3 + 1] = Pp[a * 3 + 1] - sd; Pp[b * 3 + 2] = Pp[a * 3 + 2];
      for (let k = 0; k < 3; k++) { Nn[b * 3 + k] = Nn[a * 3 + k]; Cc[b * 3 + k] = Cc[a * 3 + k]; }
      UVv[b * 2] = UVv[a * 2]; UVv[b * 2 + 1] = UVv[a * 2 + 1];
      for (let k = 0; k < 4; k++) Sp[b * 4 + k] = Sp[a * 4 + k];
    }
    g.setIndex(ch.lod ? idxFine : idxCoarse);
    for (const k of ['position', 'normal', 'color', 'uv', 'splat']) g.attributes[k].needsUpdate = true;
    g.boundingSphere.center.set(x0 + 32, (hmin + hmax) / 2, z0 + 32); g.boundingSphere.radius = Math.hypot(46, (hmax - hmin) / 2 + sd);
    ch.mesh.visible = hmax > -4;
    return hmax;
  }
  // Painted-terrain blend weights per vertex: road, village cobble, natural meadow grass, (spare). W holds this vertex's biome weights (set by tcol).
  function splatAt(x, z, h, S, o) {
    const n = vnoise(x * 0.21 + 3, z * 0.21), rd = samp(RD, x, z);
    S[o] = 1 - sstep(2.3, 4.8, rd + (n - 0.5) * 1.8);
    let cb = 0;
    for (const id of ['harrowby', 'crossing']) { const q = P[id], d = Math.hypot(x - q.x, z - q.z); if (d < 22) cb = Math.max(cb, 1 - sstep(12, 18, d + (n - 0.5) * 5)); }
    S[o + 1] = cb;
    let open = clamp((W.meadow + W.hills * 0.85) * 1.1, 0, 1) * sstep(1.5, 5, h) * sstep(330, 450, Math.hypot(x, z + 1250));
    if (open > 0 && (Math.abs(x) > 950 || Math.abs(z) > 950)) open *= 1 - sstep(80, 30, coastC(x, z)) * (1 - cliffK(x, z) * 0.8); // beaches keep their sand tint
    for (const id of ['harrowby', 'crossing', 'camp']) { const q = P[id], fr = FLAT[id][0], d = Math.hypot(x - q.x, z - q.z); if (d < fr) open *= 0.55 + 0.45 * sstep(fr * 0.3, fr, d); }
    S[o + 2] = open; S[o + 3] = 0;
  }
  const CLEAR = { shore: 16, harrowby: 84, lodge: 32, wolfden: 34, camp: 56, stones: 32, fen: 0, ruins: 64, crossing: 70, pass: 0, citadel: 170 };
  const extraClear = [];
  function cleared(x, z) {
    for (const p of POIS) { const r = CLEAR[p.id]; if (r && (x - p.x) * (x - p.x) + (z - p.z) * (z - p.z) < r * r) return true; }
    for (const q of extraClear) if ((x - q[0]) * (x - q[0]) + (z - q[1]) * (z - q[1]) < q[2] * q[2]) return true;
    return clearedSite(x, z);
  }
  function populate(ch) {
    const x0 = ch.cx * CH, z0 = ch.cz * CH, fine = ch.lod === 1, R = CT.rng((Math.imul(ch.cx + 99, 73856093) ^ Math.imul(ch.cz + 99, 19349663)) >>> 0);
    const sfx = fine ? '' : 'L';
    // trees on a jittered 5 m grid
    for (let gz = 0; gz < 13; gz++) for (let gx = 0; gx < 13; gx++) {
      const x = x0 + (gx + R()) * 4.923, z = z0 + (gz + R()) * 4.923, r1 = R(), r2 = R(), r3 = R(), r4 = R(), r5 = R();
      const h = heightAt(x, z);
      if (h < 0.15 || cleared(x, z) || samp(RD, x, z) < 5.5) continue;
      if (z < -560 && z > -1000) { valley(x, z); if (_vd < 24) continue; }
      weights(x, z, W);
      const ny = gridNy(x, z); if (ny < 0.78) continue;
      const rc = Math.hypot(x, z + 1250);
      let dens = W.forest * 0.6 + W.hills * 0.09 + W.meadow * (FOL ? 0.045 : 0.03) + W.snow * 0.24 * sstep(215, 170, h) + W.swamp * 0.11;
      dens *= 0.35 + 1.3 * sstep(0.3, 0.7, vnoise(x * 0.018 + 3, z * 0.018));
      if (r1 > dens || (lowQ && !fine && r5 < 0.3)) continue;
      let kind, s = 0.8 + r3 * 0.55 + (r3 > 0.93 ? 0.5 : 0), tr = 0.85 + r5 * 0.3, tg = tr, tb = tr;
      if (rc < 420 || W.swamp > 0.5 || (h < 5 && W.meadow > 0.5 && coastC(x, z) < 90)) kind = r2 < 0.85 ? 'dead' : 'stump';
      else if (W.snow > 0.5) kind = r2 < 0.85 ? 'snowpine' : 'dead';
      else if (W.forest > 0.5) kind = r2 < 0.8 ? 'pine' : r2 < 0.9 && h < 45 ? 'oak' : 'dead';
      else if (W.hills > 0.5) kind = r2 < 0.45 ? 'pine' : r2 < 0.75 ? 'dead' : 'oak';
      else kind = r2 < 0.55 ? 'oak' : r2 < 0.85 ? 'dead' : 'pine';
      if (rc < 420) { tr *= 0.45; tg *= 0.4; tb *= 0.42; }
      if (W.swamp > 0.5) { tr *= 0.75; tg *= 0.8; tb *= 0.7; }
      if (kind === 'stump') { put(ch, 'stump', x, h - 0.15, z, r4 * TAU, s, s, s, tr, tg, tb); addCol(ch, x, z, 0.5 * s, h + 1.2 * s); continue; }
      if (FOL && kind === 'oak') { // painted cut-outs (the same billboard at every LOD)
        const bir = W.meadow > 0.4 && r5 < 0.35, sc = s * (0.85 + r2 * 0.3);
        put(ch, bir ? 'fBirch' : 'fOak', x, h - 0.3, z, r4 * TAU, sc, sc * (0.9 + r1 * 0.25), sc, 0.8 + r5 * 0.3, 0.8 + r5 * 0.3, 0.8 + r5 * 0.25);
        addCol(ch, x, z, 0.5 * s, h + 9 * s); continue;
      }
      const pool2 = kind + sfx, tilt = kind === 'dead' && W.swamp > 0.5 ? (r4 - 0.5) * 0.5 : 0;
      put(ch, pool2, x, h - (kind === 'dead' && W.swamp > 0.5 ? 0.9 : 0.25), z, r4 * TAU, s * (0.9 + r5 * 0.2), s * (0.85 + r1 * 0.4), s * (0.9 + r2 * 0.2), tr, tg, tb, tilt, -tilt * 0.6);
      addCol(ch, x, z, (kind === 'oak' ? 0.55 : 0.35) * s, h + 9 * s);
    }
    // bushes, ferns, reeds on a jittered 8 m grid
    for (let gz = 0; gz < 8; gz++) for (let gx = 0; gx < 8; gx++) {
      const x = x0 + (gx + R()) * 8, z = z0 + (gz + R()) * 8, r1 = R(), r2 = R(), r3 = R();
      const h = heightAt(x, z); if (h < -0.4 || samp(RD, x, z) < 4 || cleared(x, z)) continue;
      weights(x, z, W);
      const dens = W.forest * 0.45 + W.hills * 0.3 + W.meadow * 0.28 + W.swamp * 0.4 + W.snow * 0.04;
      if (r1 > dens) continue;
      const s = 0.6 + r2 * 0.7;
      if (W.swamp > 0.5 && h < 0.8) { if (fine) put(ch, 'reed', x, h - 0.1, z, r3 * TAU, s, s * (0.8 + r1 * 0.5), s, 1, 1, 1); }
      else if (W.forest > 0.5 && r3 < 0.5) { if (fine) put(ch, 'fern', x, h - 0.05, z, r3 * TAU * 5, s * 1.3, s, s * 1.3, 0.9 + r1 * 0.3, 0.9 + r1 * 0.3, 0.9); }
      else if (FOL && W.meadow + W.hills > 0.5) { if (fine || r3 < 0.5) put(ch, 'fBush', x, h - 0.2, z, r3 * TAU * 7, s, s * (0.85 + r1 * 0.3), s, 0.8 + r1 * 0.35, 0.8 + r1 * 0.35, 0.75 + r2 * 0.25); }
      else if (fine || r3 < 0.4) put(ch, 'bush', x, h - 0.15, z, r3 * TAU * 7, s * 1.3, s, s * 1.3, 0.8 + r1 * 0.4, 0.8 + r1 * 0.4, 0.8 + r2 * 0.2);
    }
    // rocks, boulders, crags
    for (let gz = 0; gz < 7; gz++) for (let gx = 0; gx < 7; gx++) {
      const x = x0 + (gx + R()) * 9.14, z = z0 + (gz + R()) * 9.14, r1 = R(), r2 = R(), r3 = R(), r4 = R();
      const h = heightAt(x, z); if (samp(RD, x, z) < 4.5 || cleared(x, z)) continue;
      weights(x, z, W);
      const ny = gridNy(x, z), c = h < 8 ? coastC(x, z) : 999;
      const dens = 0.04 + sstep(0.9, 0.65, ny) * 0.5 + W.hills * 0.1 + W.snow * 0.18 + (c < 60 ? 0.15 : 0) - W.swamp * 0.03;
      if (r1 > dens) continue;
      const big = r2 > 0.8 && (W.hills + W.snow + W.forest) > 0.4, s = big ? 1.4 + r3 * 2.2 : 0.4 + r3 * 1.1;
      const snowy = W.snow > 0.5 && h > 60, tr = snowy ? 1.15 : 0.85 + r4 * 0.3;
      put(ch, big ? 'boulder' : 'rock', x, h - 0.25 * s, z, r4 * TAU, s * (0.8 + r2 * 0.4), s * (0.7 + r1 * 0.6), s * (0.8 + r3 * 0.4), tr, tr, snowy ? 1.25 : tr * 0.95, (r1 - 0.5) * 0.3, (r2 - 0.5) * 0.3);
      addCol(ch, x, z, (big ? 1.0 : 0.7) * s, h + s);
    }
    for (let k = 0; k < 4; k++) {
      const x = x0 + R() * CH, z = z0 + R() * CH, r1 = R(), r2 = R(), r3 = R();
      if (samp(RD, x, z) < 16 || cleared(x, z)) continue;
      weights(x, z, W);
      const h = heightAt(x, z), dens = cragMask(x, z) * (W.hills + W.forest * 0.6) * 0.5 + W.snow * 0.2 * sstep(40, 90, h);
      if (r1 > dens || h < 3) continue;
      const s = 0.8 + r2 * 1.2;
      put(ch, 'crag', x, h - 1.5, z, r3 * TAU, s, s * (0.8 + r1), s, 1, 1, 1, (r2 - 0.5) * 0.25, (r3 - 0.5) * 0.25);
      addCol(ch, x, z, 2.6 * s, h + 12 * s);
    }
    // swamp mist sheets
    for (let k = 0; k < 3; k++) {
      const x = x0 + R() * CH, z = z0 + R() * CH, r1 = R(), r2 = R();
      weights(x, z, W); if (W.swamp < 0.6 || r1 < 0.2) continue;
      const s = 18 + r2 * 26; put(ch, 'mist', x, Math.max(heightAt(x, z), 0) + 0.6 + r1 * 0.8, z, r2 * TAU, s, 1, s, 1, 1, 1);
    }
    // grass tufts (near chunks only; separate RNG so trees stay put across LODs)
    if (fine) {
      const G = CT.rng((Math.imul(ch.cx + 7, 83492791) ^ Math.imul(ch.cz + 7, 2654435761)) >>> 0), cap = lowQ ? 14 : 24, cs = CH / cap;
      for (let gz = 0; gz < cap; gz++) for (let gx = 0; gx < cap; gx++) {
        const x = x0 + (gx + G()) * cs, z = z0 + (gz + G()) * cs, r1 = G(), r2 = G(), r3 = G();
        const h = heightAt(x, z); if (h < 0.1 || samp(RD, x, z) < 3.1) continue;
        weights(x, z, W);
        const rc = Math.hypot(x, z + 1250);
        let dens = W.meadow * 0.9 + W.hills * 0.65 + W.forest * 0.22 + W.swamp * 0.4 + W.snow * 0.06 * sstep(90, 50, h);
        if (rc < 120) dens = 0;
        if (r1 > dens * (TX ? 0.35 : 1) || gridNy(x, z) < 0.72) continue;
        const s = 0.6 + r2 * 0.7, dry = sstep(0.3, 0.7, vnoise(x * 0.02, z * 0.02)), L = TX ? 1.9 : 1;
        put(ch, 'grass', x, h - 0.05, z, r3 * TAU, s, s * (0.7 + r1 * 0.7), s, (0.85 + dry * 0.35) * L, (0.85 + dry * 0.2) * L * 1.1, 0.8 * L * 0.8, 0, 0);
      }
    }
  }
  function buildChunk(ch) {
    for (const k in ch.inst) { if (ch.inst[k].n) pools[k].dirty = true; ch.inst[k].n = 0; }
    ch.nc = 0; for (const c of ch.cells) c.length = 0;
    const hmax = buildTerrain(ch);
    if (hmax > -6) populate(ch);
    lootChunk(ch);
  }

  // ── Streaming ──────────────────────────────────────────────────────────────
  function stream(budgetMs) {
    const cam = core.camera.position, ccx = Math.floor(cam.x / CH), ccz = Math.floor(cam.z / CH), nr = Math.ceil((viewR + 45) / CH);
    // unload far chunks
    for (let i = active.length - 1; i >= 0; i--) {
      const ch = active[i], d = Math.hypot(ch.cx * CH + 32 - cam.x, ch.cz * CH + 32 - cam.z);
      if (d > viewR + 110) {
        for (const k in ch.inst) { if (ch.inst[k].n) pools[k].dirty = true; ch.inst[k].n = 0; }
        unregLoot(ch);
        ch.mesh.visible = false; ch.nc = 0; chunks.delete(ch.key); active.splice(i, 1); spare.push(ch);
      }
    }
    const t0 = performance.now();
    let built = 0;
    for (;;) {
      let best = null, bestP = 1e9, bx2 = 0, bz2 = 0, bl = 0;
      for (let dz = -nr; dz <= nr; dz++) for (let dx = -nr; dx <= nr; dx++) {
        const cx = ccx + dx, cz = ccz + dz;
        if (cx * CH < -1600 || cx * CH >= 1600 || cz * CH < -1600 || cz * CH >= 1600) continue;
        const d = Math.hypot(cx * CH + 32 - cam.x, cz * CH + 32 - cam.z);
        if (d > viewR + 45) continue;
        const lod = d < fineR ? 1 : 0, ch = chunks.get(ckey(cx, cz));
        let pri;
        if (!ch) pri = d; else if (ch.lod !== lod) pri = d + (lod ? 40 : 160); else continue;
        if (pri < bestP) { bestP = pri; best = ch || null; bx2 = cx; bz2 = cz; bl = lod; if (!ch) best = 'new'; }
      }
      if (!best) break;
      let ch = best;
      if (best === 'new') { ch = spare.pop() || newChunk(); ch.cx = bx2; ch.cz = bz2; ch.key = ckey(bx2, bz2); chunks.set(ch.key, ch); active.push(ch); }
      ch.lod = bl; buildChunk(ch); built++;
      if (performance.now() - t0 > budgetMs || built >= (budgetMs > 100 ? 1e9 : 3)) break;
    }
    let dirty = built > 0;
    for (let i = 0; i < poolNames.length && !dirty; i++) dirty = pools[poolNames[i]].dirty;
    if (dirty) pack();
    return built;
  }

  // ── Far LOD + sea ──────────────────────────────────────────────────────────
  function farMesh() {
    const n = 161, st = 3200 / (n - 1), P2 = new Float32Array(n * n * 3), Cc = new Float32Array(n * n * 3), N = new Float32Array(n * n * 3);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      const x = -1600 + c * st, z = -1600 + r * st, j = (r * n + c) * 3, h = samp(HG, x, z);
      const nx = samp(HG, x - st, z) - samp(HG, x + st, z), nz = samp(HG, x, z - st) - samp(HG, x, z + st), l = Math.hypot(nx, 2 * st, nz);
      P2[j] = x; P2[j + 1] = h; P2[j + 2] = z; N[j] = nx / l; N[j + 1] = 2 * st / l; N[j + 2] = nz / l;
      const col = tcol(x, z, h, N[j + 1], true); Cc[j] = col.r; Cc[j + 1] = col.g; Cc[j + 2] = col.b;
    }
    const I = [];
    for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) { const a = r * n + c, b = a + 1, d = a + n, e = d + 1; I.push(a, d, b, b, d, e); }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(P2, 3)); g.setAttribute('normal', new T.BufferAttribute(N, 3)); g.setAttribute('color', new T.BufferAttribute(Cc, 3));
    g.setIndex(I);
    const m = new T.Mesh(g, mats.far); m.frustumCulled = false; m.renderOrder = 6; return m;
  }
  let sea = null, seaTex = null;
  function seaMesh() {
    // height texture for shore foam and swamp water
    const D = new Uint16Array(GN * GN * 2), H1 = T.DataUtils.toHalfFloat(1), H0 = T.DataUtils.toHalfFloat(0);
    for (let j = 0; j < GN; j++) for (let i = 0; i < GN; i++) {
      const k = j * GN + i, x = G0 + i * GS, z = G0 + j * GS;
      D[k * 2] = T.DataUtils.toHalfFloat(clamp(HG[k], -40, 40));
      let sw = false;
      if (HG[k] < 3 && Math.abs(x) < 1500 && Math.abs(z) < 1500) { weights(x, z, W); sw = W.swamp > 0.35 && coastC(x, z) > 40; }
      D[k * 2 + 1] = sw ? H1 : H0;
    }
    seaTex = new T.DataTexture(D, GN, GN, T.RGFormat, T.HalfFloatType);
    seaTex.magFilter = seaTex.minFilter = T.LinearFilter; seaTex.generateMipmaps = false; seaTex.needsUpdate = true;
    // radial grid centred on the camera
    const NS = 96, rings = [0]; let r = 1.5; while (r < 3400) { rings.push(r); r *= 1.075; }
    const P2 = [], I = [];
    for (let i = 0; i < rings.length; i++) for (let s = 0; s < NS; s++) { const a = s / NS * TAU; P2.push(Math.sin(a) * rings[i], 0, Math.cos(a) * rings[i]); }
    for (let i = 0; i < rings.length - 1; i++) for (let s = 0; s < NS; s++) { const a = i * NS + s, b = i * NS + (s + 1) % NS, c = a + NS, d = b + NS; I.push(a, c, b, b, c, d); }
    const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(P2, 3)); g.setIndex(I);
    g.setAttribute('normal', new T.Float32BufferAttribute(new Float32Array(P2.length).fill(0).map((v, i) => (i % 3 === 1 ? 1 : 0)), 3));
    const mat = new T.MeshPhongMaterial({ color: 0x14222a, specular: 0x6a5238, shininess: 38 });
    warpify(mat, { key: 'sea', extra: sh => {
      Object.assign(sh.uniforms, { uHT: { value: seaTex }, uDeep: { value: new T.Color(0x0c161e) }, uShal: { value: new T.Color(0x4a5a4a) }, uFoam: { value: new T.Color(0xcfc3a8) }, uMurk: { value: new T.Color(0x3a4230) } });
      const HTC = `vec2 htUv(vec2 p){ return ((p - vec2(${G0.toFixed(1)})) / ${GS.toFixed(1)} + 0.5) / ${GN.toFixed(1)}; }\nuniform sampler2D uHT;\nvarying vec3 vSea;\n`;
      sh.vertexShader = HTC + sh.vertexShader.replace('#include <beginnormal_vertex>', `
        vec3 wp0 = (modelMatrix * vec4(position, 1.0)).xyz;
        vec4 ht = texture2D(uHT, htUv(wp0.xz));
        float terr0 = ht.r;
        float dc = length(wp0.xz - cameraPosition.xz);
        float amp = 0.34 * (1.0 - smoothstep(60.0, 240.0, dc)) * (1.0 - smoothstep(-4.0, -0.3, terr0)) * (1.0 - ht.g);
        float t = uTime;
        float a1 = dot(wp0.xz, vec2(0.11, 0.07)) + t * 1.3, a2 = dot(wp0.xz, vec2(-0.05, 0.13)) + t * 1.7, a3 = dot(wp0.xz, vec2(0.21, -0.17)) + t * 2.3;
        float wy = amp * (sin(a1) + 0.6 * sin(a2) + 0.3 * sin(a3));
        float ddx = amp * (0.11 * cos(a1) - 0.03 * cos(a2) + 0.063 * cos(a3)), ddz = amp * (0.07 * cos(a1) + 0.078 * cos(a2) - 0.051 * cos(a3));
        vec3 objectNormal = normalize(vec3(-ddx, 1.0, -ddz));
        vSea = vec3(wp0.x, wp0.z, wy);`).replace('#include <begin_vertex>', 'vec3 transformed = vec3(position); transformed.y += wy;');
      sh.fragmentShader = HTC + 'uniform vec3 uDeep, uShal, uFoam, uMurk;\n' + sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
        vec4 ht = texture2D(uHT, htUv(vSea.xy));
        float depth = -ht.r;
        diffuseColor.rgb = mix(uShal, uDeep, smoothstep(0.2, 9.0, depth));
        float swash = 0.08 * sin(uTime * 0.7 + vSea.x * 0.02);
        float lace = 0.5 + 0.25 * sin(vSea.x * 1.1 + uTime * 0.9) * sin(vSea.y * 1.4 - uTime * 0.6) + 0.25 * sin(vSea.x * 0.37 - vSea.y * 0.53 + uTime * 0.4);
        float edge = (1.0 - smoothstep(0.0, 0.1, abs(depth - 0.07 - swash) - 0.03)) * (0.35 + 0.65 * step(0.45, lace));
        float band = smoothstep(0.9, 0.97, fract(depth * 0.7 - uTime * 0.16 + sin(vSea.x * 0.03) * 0.2)) * (1.0 - smoothstep(0.3, 3.5, depth));
        float crest = smoothstep(0.22, 0.34, vSea.z) * 0.6;
        float foam = max(max(edge * 0.85, band * 0.6), crest) * (1.0 - ht.g);
        diffuseColor.rgb = mix(diffuseColor.rgb, uFoam, foam);
        diffuseColor.rgb = mix(diffuseColor.rgb, uMurk * (0.85 + 0.3 * sin(vSea.x * 0.21 + uTime * 0.3) * sin(vSea.y * 0.17)), ht.g);
        float scum = step(0.8, fract(sin(dot(floor(vSea.xy * 2.0), vec2(12.9898, 78.233))) * 43758.5453)) * ht.g * smoothstep(0.3, 0.9, sin(vSea.x * 0.09) * sin(vSea.y * 0.07 + 1.0));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.24, 0.12), scum * 0.35);`)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += uFoam * foam * 0.12 + uMurk * ht.g * 0.18;');
    } });
    const m = new T.Mesh(g, mat); m.frustumCulled = false; mats.sea = mat; return m;
  }

  // ── Static POI meshes ──────────────────────────────────────────────────────
  const poiMeshes = []; // {group, x, z, r, always}
  function addPoiMeshes(K, x, z, r, always, warp) {
    const grp = new T.Group();
    if (!K.f.empty) grp.add(new T.Mesh(K.f.geo(), K.f.tile ? mats.tx[K.f.name] : warp ? mats.cflat : mats.flat));
    if (!K.d.empty && K.d !== K.f) grp.add(new T.Mesh(K.d.geo(), mats.flat2));
    for (const n in K.t) if (K.t[n] !== K.f && K.t[n] !== K.d && !K.t[n].empty) grp.add(new T.Mesh(K.t[n].geo(), mats.tx[n]));
    if (!K.g.empty) grp.add(new T.Mesh(K.g.geo(), warp ? mats.cglow : mats.glow));
    if (warp) grp.children.forEach(m => { m.frustumCulled = false; m.renderOrder = 6; });
    grp.children.forEach(m => { m.matrixAutoUpdate = false; });
    if (warp) { grp.renderOrder = 6; late.add(grp); } else scene.add(grp);
    poiMeshes.push({ grp, x, z, r, always });
  }

  // ── Minor landmarks ("sites") and loot ─────────────────────────────────────
  // About 56 small places between the POIs, chosen by a seeded dart throw at init
  // (spacing >= 175 m, off the roads, outside every POI). Each one is built lazily
  // when the player comes near (one merged mesh + one glow mesh per site). Loot
  // containers live in the fine terrain chunks: instanced pools + CT.interactables
  // entries that register and unregister with the chunk streaming.
  const SITES = [], LOOT = [], LOOTB = new Map(), anims = [];
  const LS_SITES = 'crimsonThrone.sites', LS_CHESTS = 'crimsonThrone.chests';
  const lsGet = k => { try { return JSON.parse(localStorage.getItem(k) || '{}') || {}; } catch (e) { return {}; } };
  const lsSet = (k, o) => { try { localStorage.setItem(k, JSON.stringify(o)); } catch (e) {} };
  let siteSt = {}, chestSt = {};
  const CLG = new Map(), cgk = (i, j) => (i + 100) * 1000 + (j + 100);
  function addClear(x, z, r) {
    for (let j = Math.floor((z - r) / 32); j <= Math.floor((z + r) / 32); j++) for (let i = Math.floor((x - r) / 32); i <= Math.floor((x + r) / 32); i++) {
      const k = cgk(i, j); let a = CLG.get(k); if (!a) CLG.set(k, (a = [])); a.push(x, z, r);
    }
  }
  function clearedSite(x, z) {
    const a = CLG.get(cgk(Math.floor(x / 32), Math.floor(z / 32))); if (!a) return false;
    for (let i = 0; i < a.length; i += 3) { const dx = x - a[i], dz = z - a[i + 1]; if (dx * dx + dz * dz < a[i + 2] * a[i + 2]) return true; }
    return false;
  }
  const IDM = new T.Matrix4(), _sv = new T.Vector3();
  function seg(b, ax, ay, az, bx2, by, bz, w, d, col) { const L = Math.hypot(bx2 - ax, by - ay, bz - az); b.add(BOX, limbM(ax, ay, az, bx2, by, bz).scale(_S.set(w, L, d)), col, 0); }

  // colours
  const stoneFn = (ny, cy, R2) => (ny > 0.75 && R2() < 0.4 ? MOSS : [0x5f5a54, 0x4f4a46, 0x6a645c, 0x57524c][(R2() * 4) | 0]);
  const paleFn = (ny, cy, R2) => (ny > 0.7 && R2() < 0.45 ? MOSS : [0x9e988a, 0x8e887c, 0xaaa394, 0x837d72][(R2() * 4) | 0]);
  const barkFn = (ny, cy, R2) => (R2() < 0.3 ? 0x2a221c : 0x3d332b);
  const rockFnD = (ny, cy, R2) => (ny > 0.6 && R2() < 0.4 ? 0x3a4028 : [0x3a3430, 0x2e2926, 0x45403a][(R2() * 3) | 0]);
  const snowy = base => (ny, cy, R2) => (ny > 0.5 && R2() < 0.85 ? (R2() < 0.5 ? 0xd8dce4 : 0xbcc4d0) : typeof base === 'function' ? base(ny, cy, R2) : base);
  const iceFn = (ny, cy, R2) => (ny > 0.55 ? 0xd4dae4 : [0x8a9aac, 0x7a8a9c, 0x9aaabb][(R2() * 3) | 0]);
  const moundFn = (ny, cy, R2) => (ny > 0.35 ? (R2() < 0.3 ? 0x4a4a26 : [0x3e4424, 0x46502a, 0x363c20][(R2() * 3) | 0]) : [0x3a332a, 0x4a4034][(R2() * 2) | 0]);
  const mossyFn = (ny, cy, R2) => (ny > 0.4 && R2() < 0.7 ? [0x4e5a34, 0x3e4a28][(R2() * 2) | 0] : [0x5a5550, 0x4a4540][(R2() * 2) | 0]);

  // the site being built: builders work in site-local metres (+z faces the road or the sea)
  let cs = null, cC = 1, cSn = 0;
  const WX = (lx, lz) => cs.x + lx * cC + lz * cSn, WZ = (lx, lz) => cs.z - lx * cSn + lz * cC;
  const GL = (lx, lz) => heightAt(WX(lx, lz), WZ(lx, lz)) - cs.y;
  const sFire = (lx, ly, lz, s, tint, light) => fire(WX(lx, lz), cs.y + ly, WZ(lx, lz), s, tint, light);
  const sCol = (lx, lz, r, top) => colCircle(WX(lx, lz), WZ(lx, lz), r, cs.y + top);
  const sBox = (lx, lz, w, d, rot, top) => colBox(WX(lx, lz), WZ(lx, lz), w, d, cs.rot + rot, cs.y + top);
  const sFlag = (pool, lx, ly, lz, ry, s) => cs.flags.push(pool, WX(lx, lz), cs.y + ly, WZ(lx, lz), cs.rot + ry, s || 1);
  const sCrow = (lx, ly, lz) => cs.crows.push(WX(lx, lz), cs.y + ly, WZ(lx, lz), cs.rot + lx * 7.3 + lz * 3.1);
  const sSmoke = (lx, ly, lz) => smokes.push([WX(lx, lz), cs.y + ly, WZ(lx, lz), Math.abs(lx * 0.37 + lz * 0.11) % 1]);
  function sCandle(K, lx, ly, lz, light) { K.f.add(cyl(0.045, 0.05, 0.24, 5), M(lx, ly + 0.12, lz), 0xc8b894); sFire(lx, ly + 0.27, lz, 0.11, 0, light); }
  function sDead(K, lx, lz, s, R, tint, tilt) {
    const k = new Batch(); k.add(protos.dead, null, tint || 0x3a3129, 0.3, R);
    K.f.merge(k, M(lx, GL(lx, lz) - 0.25, lz, R() * TAU, s, s * (0.9 + R() * 0.3), s, tilt || 0, -(tilt || 0) * 0.6));
    sCol(lx, lz, 0.4 * s, 7 * s);
  }
  function sStake(K, lx, lz, R) {
    const y = GL(lx, lz), lean = (R() - 0.5) * 0.25, h = 2.2 + R() * 0.8;
    K.f.add(cyl(0.03, 0.07, h, 4), M(lx, y + h / 2 - 0.2, lz, 0, 1, 1, 1, lean, 0), DWOOD);
    skull(K.f, lx, y + h - 0.15, lz + lean * h * 0.5, R() * TAU);
  }
  function sBonfire(K, lx, lz, s, light, tint) {
    const y = GL(lx, lz), f = K.f;
    for (let k = 0; k < 8; k++) { const a = k / 8 * TAU; f.add(lumpy(ico(0.3 * s, 0), 0.1, k), M(lx + Math.sin(a) * 1.4 * s, y + 0.1, lz + Math.cos(a) * 1.4 * s, a, 1, 0.7, 1), STONE2); }
    for (let k = 0; k < 5; k++) { const a = k / 5 * TAU; f.add(cyl(0.09 * s, 0.13 * s, 2 * s, 5), limbM(lx + Math.sin(a) * 0.9 * s, y, lz + Math.cos(a) * 0.9 * s, lx + Math.sin(a) * 0.1, y + 1.4 * s, lz + Math.cos(a) * 0.1), k % 2 ? 0x2a1c12 : 0x1a120c); }
    K.g.add(cyl(0.8 * s, 0.9 * s, 0.1, 8), M(lx, y + 0.08, lz), tint === 2 ? 0x40ff80 : 0xff5a10);
    sFire(lx, y + 0.2, lz, 2.0 * s, tint || 0, light);
    sCol(lx, lz, 1.4 * s, y + 1.2);
    sSmoke(lx, y + 2.2 * s + 0.6, lz);
  }
  function bones(K, lx, lz, r, n, R) {
    for (let i = 0; i < n; i++) {
      const a = R() * TAU, d = R() * r, x = lx + Math.sin(a) * d, z = lz + Math.cos(a) * d, y = GL(x, z);
      if (R() < 0.25) skull(K.f, x, y + 0.1, z, R() * TAU, 0.9 + R() * 0.3);
      else K.f.add(cyl(0.035, 0.05, 0.4 + R() * 0.5, 4), M(x, y + 0.05, z, R() * TAU, 1, 1, 1, Math.PI / 2, 0), R() < 0.5 ? BONE : 0xb8ac90);
    }
  }
  const skelCache = [];
  function skeleton(K, lx, lz, ry, R, s = 1) {
    const v = (R() * 3) | 0;
    if (!skelCache[v]) skelCache[v] = skeletonB(CT.rng(900 + v));
    K.f.merge(skelCache[v], M(lx, GL(lx, lz), lz, ry, s));
  }
  function skeletonB(R) {
    const b = new Batch();
    skull(b, 0.05, 0.12, 0.8, (R() - 0.5) * 1.2, 1);
    b.add(cyl(0.03, 0.03, 0.8, 4), M(0, 0.05, 0.3, 0, 1, 1, 1, Math.PI / 2, 0), BONE);
    for (let i = 0; i < 4; i++) b.add(new T.TorusGeometry(0.16 - i * 0.015, 0.022, 3, 6, Math.PI), M(0, 0.04, 0.5 - i * 0.1), BONE);
    for (const sd of [-1, 1]) {
      b.add(cyl(0.03, 0.025, 0.75, 4), limbM(sd * 0.12, 0.05, -0.15, sd * (0.2 + R() * 0.2), 0.05, -0.85), 0xc8bca0);
      b.add(cyl(0.025, 0.02, 0.6, 4), limbM(sd * 0.2, 0.06, 0.55, sd * (0.45 + R() * 0.3), 0.05, 0.1 + R() * 0.4), 0xc8bca0);
    }
    b.add(BOX, M(0, 0.06, -0.1, 0, 0.3, 0.1, 0.16), 0xc4b89c);
    return b;
  }
  function web(K, lx, ly, lz, r, ry, rx) {
    const b = new Batch(), col = 0xb8b4a8;
    for (let k = 0; k < 8; k++) { const a = k / 8 * TAU; b.add(BOX, M(Math.sin(a) * r / 2, Math.cos(a) * r / 2, 0, 0, 0.02, r, 0.02, 0, -a), col, 0); }
    for (let j = 1; j <= 4; j++) {
      const rr = r * j / 4.4, len = 2 * rr * Math.sin(Math.PI / 8);
      for (let k = 0; k < 8; k++) { const a = (k + 0.5) / 8 * TAU; b.add(BOX, M(Math.sin(a) * rr * 0.96, Math.cos(a) * rr * 0.96, 0, 0, 0.018, len, 0.018, 0, -(a + Math.PI / 2)), col, 0); }
    }
    K.f.merge(b, M(lx, ly, lz, ry, 1, 1, 1, rx || 0, 0));
  }
  // loot + decor prototypes (Batches keep their vertex colours)
  function chestB(blood) {
    const b = new Batch(), wood = blood ? 0x3a1414 : 0x5a3a22, band = blood ? BONE : IRON;
    bx(b, 0, 0.31, 0, 1.1, 0.62, 0.72, wood, 0, 0, 0, 0.12);
    for (const sx of [-0.38, 0.38]) bx(b, sx, 0.31, 0, 0.09, 0.64, 0.75, band, 0, 0, 0, 0);
    bx(b, 0, 0.05, 0, 1.14, 0.1, 0.76, DWOOD, 0, 0, 0, 0);
    bx(b, 0, 0.5, 0.37, 0.18, 0.2, 0.04, blood ? 0x6a1010 : 0x9a7a3a, 0, 0, 0, 0);
    bx(b, 0, 0.625, 0, 1.0, 0.012, 0.6, blood ? 0x1a0404 : 0x140c06, 0, 0, 0, 0);   // the dark hold, seen when the lid is up
    for (let i = 0; i < 9; i++) bx(b, -0.38 + (i % 3) * 0.33 + (i * 0.07) % 0.1, 0.635, -0.2 + ((i / 3) | 0) * 0.2, 0.09, 0.02, 0.09, i % 4 ? 0xc89028 : 0xe8c050, i, 0, 0, 0);
    if (blood) {
      skull(b, 0, 0.3, 0.4, 0, 1.2);
      for (const s of [-1, 1]) b.add(cone(0.07, 0.5, 5), limbM(s * 0.56, 0.4, 0.15, s * 0.9, 0.85, 0.2), BONE);
      for (let i = 0; i < 5; i++) b.add(cyl(0.03, 0.04, 0.45, 4), M(-0.5 + i * 0.25, 0.03, 0.55 + (i % 2) * 0.1, i, 1, 1, 1, Math.PI / 2, 0), BONE);
      skull(b, 0.66, 0.1, 0.45, 0.6, 0.9); skull(b, -0.62, 0.1, 0.5, -0.5, 0.8);
    }
    return b;
  }
  function lidB() {
    const b = new Batch();
    b.add(new T.CylinderGeometry(0.36, 0.36, 1.1, 8, 1, false, 0, Math.PI), M(0, 0, 0.36, 0, 0.7, 1, 1, 0, Math.PI / 2), 0x5a3a22, 0.12);
    for (const sx of [-0.38, 0.38]) b.add(new T.CylinderGeometry(0.375, 0.375, 0.09, 8, 1, false, 0, Math.PI), M(sx, 0, 0.36, 0, 0.7, 1, 1, 0, Math.PI / 2), IRON);
    bx(b, 0, 0.0, 0.73, 0.14, 0.18, 0.03, 0x9a7a3a, 0, 0, 0, 0);
    return b;
  }
  function urnB() {
    const b = new Batch(), pts = [[0.02, 0], [0.17, 0.01], [0.27, 0.12], [0.32, 0.34], [0.27, 0.58], [0.15, 0.7], [0.13, 0.78], [0.19, 0.84], [0.16, 0.86]].map(p => new T.Vector2(p[0], p[1]));
    b.add(new T.LatheGeometry(pts, 8), null, (ny, cy) => (cy > 0.4 && cy < 0.5 ? 0x2a1a10 : cy > 0.14 && cy < 0.2 ? 0x3a2414 : 0x7a4a2c), 0.15);
    b.add(cyl(0.17, 0.17, 0.05, 8), M(0, 0.86, 0), 0x4a2e1c);
    return b;
  }
  function rackB() {
    const b = new Batch();
    for (const s of [-1, 1]) { bx(b, s * 0.85, 0.75, 0, 0.08, 1.6, 0.08, WOOD, 0, 0.25, 0); bx(b, s * 0.85, 0.75, 0, 0.08, 1.6, 0.08, WOOD, 0, -0.25, 0); }
    bx(b, 0, 1.42, 0, 1.9, 0.08, 0.08, WOOD2); bx(b, 0, 0.3, 0.2, 1.8, 0.07, 0.07, WOOD2);
    return b;
  }
  function rackWB() {
    const b = new Batch(), steel = 0x9a9ea6;
    seg(b, -0.55, 0.08, 0.28, -0.5, 1.55, 0.08, 0.07, 0.02, steel); bx(b, -0.52, 0.55, 0.22, 0.3, 0.05, 0.06, 0x5a4a30, 0, 0.13, 0);   // sword
    seg(b, -0.05, 0.05, 0.3, 0.0, 1.6, 0.06, 0.05, 0.05, 0x4a3422); bx(b, 0.08, 1.45, 0.09, 0.3, 0.28, 0.04, steel, 0, 0.15, 0);        // axe
    seg(b, 0.5, 0.05, 0.3, 0.6, 2.2, 0.02, 0.04, 0.04, 0x4a3422); b.add(cone(0.06, 0.35, 4), limbM(0.6, 2.2, 0.02, 0.617, 2.55, -0.02), steel); // spear
    return b;
  }
  function corpseB() {
    const b = new Batch(), cloak = 0x4a2e22;
    b.add(new T.CircleGeometry(0.9, 8), M(0.1, 0.02, 0.1, 0, 1, 1, 1, -Math.PI / 2, 0), 0x3a0606);
    b.add(lumpy(new T.PlaneGeometry(1.1, 1.3, 2, 2), 0.1, 3), M(0.1, 0.05, 0.1, 0.3, 1, 1, 1, -Math.PI / 2, 0), 0x3a1a14);
    bx(b, 0, 0.16, 0.15, 0.5, 0.24, 0.72, cloak);
    b.add(ico(0.14, 1), M(0, 0.16, 0.66), BONE);
    b.add(new T.SphereGeometry(0.17, 6, 3, 0, TAU, 0, Math.PI / 2), M(0, 0.17, 0.72, 0, 1, 1, 1, -1.3, 0), IRON);
    for (const s of [-1, 1]) { bx(b, s * 0.12, 0.1, -0.55, 0.16, 0.16, 0.8, 0x2a2018); bx(b, s * 0.13, 0.12, -1.0, 0.18, 0.2, 0.22, 0x1a140e); }
    bx(b, 0.34, 0.1, 0.2, 0.13, 0.13, 0.6, cloak, 0.3); bx(b, -0.55, 0.08, 0.45, 0.6, 0.12, 0.13, cloak, 0.2);
    bx(b, 0.75, 0.04, -0.1, 0.07, 0.03, 1.0, 0x8a8e96, 0.2); bx(b, 0.7, 0.05, 0.38, 0.28, 0.04, 0.05, 0x5a4a30, 0.2);
    b.add(cyl(0.38, 0.38, 0.05, 10), M(-0.75, 0.05, -0.5, 0, 1, 1, 1, 0.1, 0), 0x5a2a1a); b.add(ico(0.08, 0), M(-0.75, 0.1, -0.5), IRON);
    for (let i = 0; i < 2; i++) { seg(b, -0.1 + i * 0.2, 0.2, 0.2 - i * 0.2, -0.05 + i * 0.25, 0.85, 0.3 - i * 0.2, 0.02, 0.02, 0x3a2a1c); bx(b, -0.05 + i * 0.25, 0.8, 0.3 - i * 0.2, 0.08, 0.14, 0.01, 0xc8c0b0); }
    return b;
  }
  function bagB() {
    const b = new Batch();
    for (const s of [-1, 1]) { b.add(lumpy(new T.BoxGeometry(0.45, 0.4, 0.26, 1, 1, 1), 0.06, s + 3), M(s * 0.3, 0.2, 0, s * 0.2), HIDE); bx(b, s * 0.3, 0.36, 0.1, 0.4, 0.14, 0.08, 0x4a3422, s * 0.2, 0.3); }
    bx(b, 0, 0.36, 0, 0.3, 0.04, 0.12, 0x3a2a1c);
    b.add(cyl(0.14, 0.14, 0.8, 7), M(0, 0.14, -0.42, 0, 1, 1, 1, 0, Math.PI / 2), 0x6a5a40);
    for (const s of [-0.25, 0.25]) bx(b, s, 0.15, -0.42, 0.04, 0.3, 0.3, 0x2a1c12);
    return b;
  }
  function hangedB() {
    const b = new Batch();
    b.add(cyl(0.015, 0.015, 1.1, 3), M(0, -0.55, 0), 0x8a7a5a);
    b.add(ico(0.14, 1), M(0, -1.25, 0.02, 0, 1, 1.15, 1), 0x6a5a4a);
    bx(b, 0, -1.78, 0, 0.42, 0.75, 0.24, 0x3a2e26);
    for (const s of [-1, 1]) { bx(b, s * 0.27, -1.82, 0, 0.1, 0.66, 0.12, 0x3a2e26, 0, 0, s * 0.08); bx(b, s * 0.1, -2.55, 0, 0.13, 0.8, 0.14, 0x2a221c); bx(b, s * 0.1, -3.0, 0.04, 0.12, 0.12, 0.22, 0x1a140e); }
    return b;
  }
  function geoCrow() {
    const b = new Batch(), K2 = 0x141216, K3 = 0x221e26;
    b.add(ico(0.12, 0), M(0, 0.14, 0, 0, 0.9, 0.85, 1.5), K2);
    b.add(ico(0.075, 0), M(0, 0.26, 0.15), K3);
    b.add(cone(0.03, 0.09, 4), M(0, 0.25, 0.25, 0, 1, 1, 1, Math.PI / 2, 0), 0x3a3230);
    b.add(BOX, M(0, 0.15, -0.21, 0, 0.1, 0.02, 0.18, -0.3, 0), K2);
    for (const s of [-1, 1]) { b.add(BOX, M(s * 0.1, 0.17, -0.02, 0, 0.03, 0.1, 0.28, 0, s * 0.3), K3); b.add(BOX, M(s * 0.04, 0.03, 0, 0, 0.015, 0.07, 0.015), 0x3a3020); }
    return b.geo();
  }
  function crowMat() {
    const m = new T.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    m.onBeforeCompile = sh => {
      sh.uniforms.uTime = U.time;
      sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        vec3 ip = instanceMatrix[3].xyz;
        float ph = uTime + ip.x * 1.7 + ip.z * 2.3;
        float head = step(0.1, position.z);
        float peck = smoothstep(0.6, 1.0, sin(ph * 0.9)) * head;
        transformed.y -= peck * (position.z - 0.1) * 0.9;
        transformed.z += peck * 0.03;
        transformed.x += sin(ph * 0.37) * head * step(0.18, position.y) * 0.06;
        float flick = smoothstep(0.93, 1.0, sin(ph * 2.9)) * step(0.06, abs(position.x)) * step(0.1, position.y);
        transformed.y += flick * 0.08; transformed.x += flick * sign(position.x) * 0.06;
        transformed.y += abs(sin(ph * 0.5)) * 0.015;`);
    };
    m.customProgramCacheKey = () => 'ct-crow';
    return m;
  }
  function fallTexture() {
    const W2 = 16, H2 = 64, c = cv(W2, H2), g = c.getContext('2d'), R = CT.rng(606);
    g.fillStyle = '#56707a'; g.fillRect(0, 0, W2, H2);
    for (let x = 0; x < W2; x++) {
      let y = R() * H2; const n = 3 + R() * 4;
      for (let k = 0; k < n; k++) { const len = 4 + R() * 14, v = (150 + R() * 100) | 0; g.fillStyle = `rgb(${v},${v + 6},${v + 10})`; g.fillRect(x, y % H2, 1, len); if (y % H2 + len > H2) g.fillRect(x, 0, 1, y % H2 + len - H2); y += len + R() * 10; }
    }
    return tex(c, true, true);
  }

  // ── Site types ─────────────────────────────────────────────────────────────
  // b: biome, names, loot: [lx, lz, kind, ry, forceBlood], guard, tall/silR (far silhouette), clear (vegetation), noFlat
  const TYPES = {
    tower: { b: 'meadow', tall: 14, silR: 3.2, names: ['The Broken Sentinel', "Warden's Stump", 'Oathwatch Tower', 'Crowcall Tower'], loot: [[2.4, 4.8, 'chest', 0.3], [-2.6, 4.2, 'urn']],
      build(K, R) {
        const f = K.f, rr = 3.2, h = 14 + R() * 3, ph = R() * 6, g = new T.CylinderGeometry(rr, rr * 1.12, h, 12, 6, true), pp = g.attributes.position;
        const cut = a => (0.5 + 0.5 * Math.sin(a * 3 + ph)) * h * 0.32;
        for (let v = 0; v < pp.count; v++) { const vy = pp.getY(v); if (vy > -h * 0.2) pp.setY(v, vy - cut(Math.atan2(pp.getX(v), pp.getZ(v))) * ((vy + h / 2) / h)); }
        f.add(g, M(0, h / 2 - 0.6, 0), stoneFn, 0.1);
        f.add(cyl(rr * 1.1, rr * 1.1, 0.3, 12), M(0, 0.05, 0), STONE2);
        f.add(new T.PlaneGeometry(1.3, 2.3), M(0, 1.15, rr * 1.11 + 0.04), 0x0a0808); bx(f, 0, 2.45, rr * 1.11 + 0.1, 1.9, 0.35, 0.4, STONE2);
        for (let i = 0; i < 5; i++) { const a = R() * TAU, wy = 4 + R() * h * 0.4, rad = rr * 1.12 - rr * 0.12 * ((wy + 0.6) / h) + 0.04; f.add(new T.PlaneGeometry(0.5, 1.2), M(Math.sin(a) * rad, wy, Math.cos(a) * rad, a), 0x0a0808); }
        for (let i = 0; i < 16; i++) { const a = R() * TAU, d = rr + 1 + R() * 6, x = Math.sin(a) * d, z = Math.cos(a) * d; bx(f, x, GL(x, z) + 0.2, z, 0.6 + R() * 0.8, 0.4 + R() * 0.5, 0.6 + R() * 0.8, STONE, R() * 3, R() * 0.4, R() * 0.4); }
        f.add(new T.CylinderGeometry(rr * 0.9, rr * 0.95, 4, 10, 1, true, 0, Math.PI * 1.2), M(-rr - 3.6, 1.3, -2.5, 0.7, 1, 1, 1, Math.PI / 2 - 0.1, 0), stoneFn);
        f.add(cyl(0.07, 0.09, 5, 5), M(rr * 0.75, h * 0.62 + 1.2, 0), DWOOD); sFlag('flagV', rr * 0.75, h * 0.62 + 3.5, 0, R() * TAU, 1);
        for (let i = 0; i < 3; i++) { const a = i * 2.1 + R(); sCrow(Math.sin(a) * rr * 1.0, h - 0.6 - cut(a) + 0.02, Math.cos(a) * rr * 1.0); }
        sCol(0, 0, rr * 1.12, h);
      } },
    farm: { b: 'meadow', names: ['Ashfall Farm', 'The Cinder Steading', "Widow Marren's Farm"], loot: [[-2.0, -0.6, 'urn'], [3.8, 4.6, 'corpse', 2.2]],
      build(K, R) {
        const f = K.f, W2 = 10, D2 = 6.5;
        f.add(new T.CircleGeometry(7.5, 12), M(0, 0.05, 0, 0, 1, 1, 1, -Math.PI / 2, 0), 0x1a1612);
        for (const q of [[-W2 / 2, -D2 / 2, W2 / 2, -D2 / 2], [W2 / 2, -D2 / 2, W2 / 2, D2 / 2], [W2 / 2, D2 / 2, -W2 / 2, D2 / 2], [-W2 / 2, D2 / 2, -W2 / 2, -D2 / 2]]) {
          const n = Math.round(Math.hypot(q[2] - q[0], q[3] - q[1]) / 1.2), vx = q[0] === q[2];
          for (let i = 0; i < n; i++) { if (R() < 0.2) continue; const t = (i + 0.5) / n, x = lerp(q[0], q[2], t), z = lerp(q[1], q[3], t), hh = 0.4 + R() * (R() < 0.3 ? 1.8 : 0.6); bx(f, x, hh / 2, z, vx ? 0.5 : 1.25, hh, vx ? 1.25 : 0.5, STONE, 0, 0, 0, 0.2); }
        }
        bx(f, -3.4, 3.7, -2.1, 1.2, 7.4, 1.1, STONE, 0, 0, 0.02, 0.18); bx(f, -3.4, 7.5, -2.1, 1.4, 0.3, 1.3, STONE2);
        f.add(new T.PlaneGeometry(0.8, 0.9), M(-3.4, 0.7, -1.53), 0x080606); K.g.add(BOX, M(-3.4, 0.25, -1.7, 0, 0.6, 0.12, 0.3), 0xff4010);
        sSmoke(-3.4, 7.8, -2.1); sCol(-3.4, -2.1, 0.8, 7.5);
        for (let i = 0; i < 7; i++) bx(f, (R() - 0.5) * 7, 0.25 + R() * 0.5, (R() - 0.5) * 4.5, 0.25, 0.25, 3 + R() * 3, 0x16120f, R() * 3, (R() - 0.5) * 0.5, (R() - 0.5) * 0.3, 0.2);
        for (const q of [[4.8, 3], [4.8, -3], [-4.8, 3]]) bx(f, q[0], 1 + R(), q[1], 0.3, 2 + R() * 2, 0.3, 0x1a1512, 0, (R() - 0.5) * 0.3, (R() - 0.5) * 0.3, 0);
        for (let i = 0; i < 16; i++) K.g.add(BOX, M((R() - 0.5) * 8, 0.07, (R() - 0.5) * 5, R() * 3, 0.12, 0.05, 0.1), R() < 0.5 ? 0xff4010 : 0xc02008);
        const cx = 6.6, cz = 3.2, cy = GL(cx, cz); bx(f, cx, cy + 0.7, cz, 2.4, 0.15, 1.4, WOOD2, 0.4, 0, 1.1);
        f.add(new T.TorusGeometry(0.55, 0.08, 4, 10), M(cx - 0.3, cy + 0.55, cz + 0.9, 0.4 + Math.PI / 2), DWOOD);
        const wx0 = 5.5, wz0 = -4.6, wy = GL(wx0, wz0); f.add(cyl(0.9, 1.0, 0.9, 9), M(wx0, wy + 0.4, wz0), stoneFn); f.add(cyl(0.72, 0.72, 0.04, 9), M(wx0, wy + 0.83, wz0), 0x0a0c0e); sCol(wx0, wz0, 1.0, wy + 0.9);
        sDead(K, -8.5, 5, 1.0, R); sCrow(-3.4, 7.66, -2.1); sCrow(wx0 + 0.8, wy + 0.86, wz0);
        bones(K, 6.5, -1, 2, 6, R);
      } },
    mill: { b: 'meadow', tall: 12, silR: 2.6, names: ['The Still Mill', 'Grindbone Mill', 'Old Harrow Mill'], loot: [[3.4, 3.8, 'bag', 0.6], [-3.8, 2.2, 'chest', -0.4]],
      build(K, R) {
        const f = K.f;
        f.add(new T.CylinderGeometry(1.9, 2.9, 9.5, 8, 3), M(0, 4.75, 0), (ny, cy, R2) => (R2() < 0.2 ? MOSS : [0x6a6258, 0x5f5a54, 0x746c60][(R2() * 3) | 0]), 0.08);
        f.add(cone(2.5, 3.2, 8), M(0.2, 11, 0, 0, 1, 1, 1, 0.08, 0.14), THATCH, 0.2);
        f.add(new T.PlaneGeometry(1.2, 2.2), M(0, 1.1, 2.86), 0x0a0808);
        for (let i = 0; i < 3; i++) { const a = i * 2.2 + 1, y = 3.5 + i * 1.8, rad = 2.9 - (y / 9.5) + 0.05; f.add(new T.PlaneGeometry(0.5, 0.8), M(Math.sin(a) * rad, y, Math.cos(a) * rad, a), 0x0a0808); }
        f.add(cyl(0.22, 0.22, 1.4, 6), M(0, 8.4, 2.4, 0, 1, 1, 1, Math.PI / 2, 0), DWOOD);
        const a0 = R() * 1.5;
        for (let k = 0; k < 4; k++) {
          const a = a0 + k * Math.PI / 2, len = k === 1 ? 3.2 : k === 3 ? 4.5 : 6.2;
          f.add(BOX, M(Math.sin(a) * len / 2, 8.4 + Math.cos(a) * len / 2, 3.05, 0, 0.22, len, 0.12, 0, -a), DWOOD);
          if (k !== 1) { const px = Math.sin(a) * len * 0.58 + Math.cos(a) * 0.62, py = 8.4 + Math.cos(a) * len * 0.58 - Math.sin(a) * 0.62; K.d.add(new T.PlaneGeometry(1.1, len * 0.72, 2, 4), M(px, py, 3.1, 0, 1, 1, 1, 0, -a), (ny, cy, R2) => (R2() < 0.3 ? 0x2a2018 : 0x6a5a44), 0.2); }
        }
        f.add(cyl(0.8, 0.8, 0.25, 10), M(2.8, 0.75, -1.6, 0.3, 1, 1, 1, 1.2, 0), STONE);
        for (let i = 0; i < 4; i++) f.add(lumpy(ico(0.35, 0), 0.08, i), M(-2.9 + i * 0.5, 0.3, -2.4 + (i % 2) * 0.4, R(), 1, 0.8, 1.2), 0x8a7a5a);
        sCol(0, 0, 2.9, 10); sCrow(0.3, 12.35, 0.1);
      } },
    shrine: { b: 'meadow', names: ['Shrine of the Old Gods', "Crom's Wayshrine", "The Horned Mother's Stone"], loot: [[2.1, 2.0, 'urn'], [-2.1, 2.0, 'urn']],
      build(K, R) {
        const f = K.f;
        bx(f, 0, 0.2, 0, 3.2, 0.4, 3.2, STONE2, 0, 0, 0, 0.15); bx(f, 0, 0.5, -0.3, 2.2, 0.3, 2.2, STONE, 0, 0, 0, 0.15);
        f.add(lumpy(new T.BoxGeometry(0.7, 2.6, 0.55, 1, 3, 1), 0.08, 5), M(0, 1.95, -0.6), stoneFn);
        bx(f, 0, 3.55, -0.6, 0.85, 0.8, 0.7, 0x6a645c, 0, 0, 0, 0.1);
        for (const s of [-1, 1]) { f.add(cyl(0.12, 0.08, 0.8, 5), limbM(s * 0.4, 3.75, -0.6, s * 0.95, 4.1, -0.55), BONE); f.add(cone(0.08, 0.6, 5), limbM(s * 0.95, 4.1, -0.55, s * 1.05, 4.7, -0.5), BONE); K.g.add(BOX, M(s * 0.18, 3.62, -0.24, 0, 0.12, 0.07, 0.04), 0xff3010); }
        f.add(new T.TorusGeometry(0.42, 0.08, 4, 10), M(0, 2.9, -0.6, 0, 1, 1, 1, Math.PI / 2, 0), 0x4a4a22);
        skull(f, -0.6, 0.78, 0.35, 0.3); skull(f, 0.7, 0.78, 0.2, -0.4, 0.9);
        for (const q of [[0, 0.35], [-0.35, 0.6], [0.4, 0.6]]) f.add(cyl(0.16, 0.1, 0.12, 7), M(q[0], 0.71, q[1]), 0x6a4a2c);
        f.add(lumpy(ico(0.13, 0), 0.04, 2), M(0.05, 0.8, 0.35), 0x8a6a3a);
        for (let i = 0; i < 6; i++) K.g.add(BOX, M(-0.3 + R() * 0.6, 0.67, 0.5 + R() * 0.3, R() * 3, 0.06, 0.02, 0.06), 0xd8a030);
        for (let i = 0; i < 7; i++) sCandle(K, -1.35 + i * 0.45, 0.4, 1.3 + (i % 2) * 0.12, i === 3);
        for (const q of [[-0.9, -1.2], [0.9, -1.2]]) sCandle(K, q[0], 0.65, q[1], false);
        for (const s of [-1, 1]) { f.add(cyl(0.06, 0.08, 3, 5), M(s * 2.3, 1.5, -1.2), DWOOD); for (let r = 0; r < 3; r++) K.d.add(new T.PlaneGeometry(0.12, 0.9), M(s * 2.3 + 0.08, 2.4 - r * 0.25, -1.2 + (r - 1) * 0.08, R(), 1, 1, 1, 0, 0.2), r ? CLOTH : 0x8a7a50); skull(f, s * 2.3, 3.1, -1.2, 0); sCol(s * 2.3, -1.2, 0.2, 3); }
        sBox(0, 0, 3.2, 3.2, 0, 4.2);
      } },
    hangoak: { b: 'meadow', names: ['The Hanged Oak', "Traitor's Bough", 'The Rope Tree'], loot: [[2.4, 2.8, 'corpse', 0.5]],
      build(K, R) {
        const f = K.f;
        f.add(lumpy(cyl(0.7, 1.05, 6.5, 8), 0.15, 3), M(0, 3, 0, 0, 1, 1, 1, 0.04, -0.05), barkFn);
        const limbs = [[3.8, 6.4, 0.6], [-3.4, 6.0, -0.8], [0.5, 6.8, -3.4], [-0.6, 7.4, 3.0]];
        for (const q of limbs) { f.add(cyl(0.18, 0.4, Math.hypot(q[0], q[1] - 5.2, q[2]) + 0.4, 6), limbM(0, 5.2, 0, q[0], q[1], q[2]), barkFn); f.add(cyl(0.05, 0.16, 2.2, 5), limbM(q[0], q[1], q[2], q[0] * 1.35, q[1] + 1.4, q[2] * 1.35 + 0.3), barkFn); }
        f.add(cyl(0.2, 0.45, 3, 6), limbM(0, 6, 0, 0.3, 9, 0.4), barkFn);
        for (let k = 0; k < 6; k++) { const a = k * 1.1 + R(); f.add(cyl(0.08, 0.35, 2.4, 5, true), limbM(0, 0.6, 0, Math.sin(a) * 2.1, -0.3, Math.cos(a) * 2.1), barkFn); }
        for (let i = 0; i < 3; i++) { const q = limbs[i], t = 0.8; f.merge(protos.hanged, M(q[0] * t, 5.2 + (q[1] - 5.2) * t - 0.1, q[2] * t, R() * TAU, 1, 1, 1, (R() - 0.5) * 0.08, (R() - 0.5) * 0.08)); }
        for (const q of limbs) sCrow(q[0] * 0.95, q[1] + 0.15, q[2] * 0.95);
        bx(f, 0, 2.2, 1.0, 0.9, 0.5, 0.06, 0x6a5238, 0, 0, 0.1);
        bones(K, 0, 0, 4, 10, R); sCol(0, 0, 1.0, 9);
      } },
    circle: { b: 'meadow', names: ['The Three Sisters', 'The Grey Maidens', 'The Hearthstones'], loot: [[0.9, 1.8, 'urn']],
      build(K, R) {
        const f = K.f;
        for (let i = 0; i < 3; i++) {
          const a = i / 3 * TAU + 0.4, x = Math.sin(a) * 4.8, z = Math.cos(a) * 4.8, h = 4.2 + R() * 1.8;
          f.add(lumpy(new T.BoxGeometry(1.5, h, 0.9, 1, 3, 1), 0.3, i + 20), M(x, h / 2 - 0.4, z, a, 1, 1, 1, (R() - 0.5) * 0.12, (R() - 0.5) * 0.12), stoneFn, 0.1);
          for (let g = 0; g < 3; g++) K.g.add(BOX, M(x - Math.sin(a) * 0.48, h * 0.4 + g * 0.5, z - Math.cos(a) * 0.48, a, 0.28, 0.06, 0.02, 0, (R() - 0.5) * 1.5), 0x9ab8ff);
          sCol(x, z, 0.9, h);
        }
        f.add(lumpy(new T.BoxGeometry(2.4, 0.5, 1.5, 2, 1, 2), 0.12, 7), M(0, 0.2, 0, 0.3), stoneFn); skull(f, 0.2, 0.6, 0.1, 1.2);
        sCandle(K, -0.7, 0.45, 0.3, true); sCandle(K, 0.8, 0.45, -0.4, false);
        for (let i = 0; i < 10; i++) { const a = R() * TAU, d = 6.5 + R() * 2, x = Math.sin(a) * d, z = Math.cos(a) * d; f.add(lumpy(ico(0.3 + R() * 0.3, 0), 0.1, i), M(x, GL(x, z) + 0.1, z), rockCol); }
      } },
    shepherd: { b: 'meadow', names: ["Shepherd's Rest", "Old Brannoc's Hut", 'Ewe Hollow'], loot: [[1.9, 3.1, 'chest', 0.2], [-4.4, 5.0, 'bag', 1]],
      build(K, R) {
        const f = K.f;
        f.add(cyl(2.3, 2.45, 2.3, 10), M(0, 1.15, 0), stoneFn, 0.1);
        f.add(cone(3.1, 2.8, 10), M(0, 3.7, 0), THATCH, 0.15);
        f.add(new T.PlaneGeometry(1.0, 1.8), M(0, 0.9, 2.47), 0x120c08); bx(f, 0, 1.9, 2.5, 1.4, 0.2, 0.2, DWOOD);
        sSmoke(0.3, 5.0, 0); sCol(0, 0, 2.5, 5);
        const px = 6.0, pz = -1.2, pr = 3.4;
        for (let i = 0; i < 16; i++) {
          const a = i / 16 * TAU, x = px + Math.sin(a) * pr, z = pz + Math.cos(a) * pr, y = GL(x, z);
          f.add(cyl(0.05, 0.06, 1.3, 4), M(x, y + 0.55, z), DWOOD); if (i % 2 === 0) sCol(x, z, 0.3, y + 1.2);
          if (i === 12) continue;
          const b2 = a + Math.PI / 16, mx = px + Math.sin(b2) * pr * 0.98, mz = pz + Math.cos(b2) * pr * 0.98;
          bx(f, mx, GL(mx, mz) + 0.5, mz, 2 * pr * Math.sin(Math.PI / 16), 0.75, 0.1, 0x4a3822, b2, 0, 0, 0.2);
        }
        f.add(cyl(0.06, 0.08, 1.7, 4), M(px, GL(px, pz) + 0.8, pz), DWOOD); skull(f, px, GL(px, pz) + 1.75, pz, 0, 1.3);
        sBonfire(K, -3.3, 3.5, 0.45, true);
        f.add(cyl(0.03, 0.03, 1.9, 4), M(-2.3, 0.95, 1.3, 0, 1, 1, 1, 0.2, 0.25), WOOD);
      } },
    seacave: { b: 'coast', names: ["Drowned Men's Grotto", "The Wrecker's Cave", 'Saltmaw Cave'], guard: 'ghoul', guardP: 0.7, loot: [[0.5, 1.2, 'chest'], [5.8, 1.6, 'urn']],
      build(K, R) {
        const f = K.f;
        for (let i = 0; i < 14; i++) { const a = Math.PI + (i / 13 - 0.5) * 3.6, r = 4.5 + R() * 4, s = 2.5 + R() * 3.5, x = Math.sin(a) * r, z = Math.cos(a) * r - 2; f.add(lumpy(ico(1, 1), 0.35, i), M(x, GL(x, z) + s * 0.25, z, R() * TAU, s, s * (0.7 + R() * 0.5), s), rockFnD, 0.15); sCol(x, z, s * 0.8, s); }
        f.add(lumpy(ico(1, 1), 0.3, 40), M(0, 2.2, -7, 0, 8, 6, 7), rockFnD); sCol(0, -7, 6.6, 7);
        f.add(new T.CircleGeometry(2.8, 10, 0, Math.PI), M(0, -0.2, -1.2), 0x040304);
        f.add(lumpy(new T.TorusGeometry(3.2, 0.9, 4, 8, Math.PI), 0.4, 5), M(0, -0.3, -1.3), rockFnD);
        const wx = 6, wz = 5.5, wy = GL(wx, wz) - 0.3, k = new Batch();
        bx(k, 0, 0.1, 0, 0.45, 0.45, 14, DWOOD, 0, 0, 0, 0.2);
        for (let i = 0; i < 10; i++) { const zz = -6 + i * 1.3, rr = 2.2 * Math.sin(Math.PI * (0.12 + 0.76 * i / 9)) + 0.3, br = R() < 0.4; k.add(new T.TorusGeometry(rr, 0.12, 3, 8, br ? Math.PI * (0.35 + R() * 0.3) : Math.PI), M(0, rr * 0.9, zz, 0, 1, 1, 1, 0, Math.PI), 0x3a2a1c, 0.2); }
        k.add(cyl(0.2, 0.25, 7, 6), M(0.5, 2.8, 1, 0, 1, 1, 1, 0.6, 0.35), WOOD);
        k.add(new T.PlaneGeometry(2.4, 2.8, 2, 2), M(1.4, 3.4, 2.4, 0.4, 1, 1, 1, 0.5, 0.2), 0x5a4a3a);
        f.merge(k, M(wx, wy, wz, 0.8, 1, 1, 1, 0, 0.3)); sBox(wx, wz, 5, 14, 0.8, 3);
        for (let i = 0; i < 8; i++) { const x = (R() - 0.5) * 14, z = 3 + R() * 7, y = GL(x, z); if (R() < 0.5) crate(f, x, y - 0.1, z, 0.6 + R() * 0.3, R() * 3); else f.add(cyl(0.3, 0.27, 0.8, 8), M(x, y + 0.3, z, R() * 3, 1, 1, 1, Math.PI / 2, 0), 0x5a3a22); }
        bones(K, 0, 0.8, 3, 10, R); sStake(K, -3.5, 2.5, R); sStake(K, 3.0, 2.8, R);
      } },
    lighthouse: { b: 'coast', tall: 22, silR: 3, names: ['The Dead Lamp', "Gull's Beacon", 'Last Light'], loot: [[4.0, 2.8, 'chest', 0.4], [-3.6, 3.6, 'corpse', -0.6]],
      build(K, R) {
        const f = K.f, H = 18;
        f.add(new T.CylinderGeometry(2.1, 3.0, H, 10, 6), M(0, H / 2, 0), (ny, cy, R2) => ((((cy + 9) / 3) | 0) % 2 ? [0x8a8478, 0x7e786c][(R2() * 2) | 0] : [0x5a3a30, 0x4e332a][(R2() * 2) | 0]), 0.06);
        f.add(cyl(2.7, 2.5, 0.35, 10), M(0, H + 0.1, 0), STONE2);
        for (let i = 0; i < 10; i++) { const a = i / 10 * TAU; f.add(cyl(0.05, 0.05, 1, 3), M(Math.sin(a) * 2.55, H + 0.8, Math.cos(a) * 2.55), IRON); }
        f.add(new T.TorusGeometry(2.55, 0.05, 3, 12), M(0, H + 1.25, 0, 0, 1, 1, 1, Math.PI / 2, 0), IRON);
        for (let i = 0; i < 6; i++) { const a = i / 6 * TAU; if (i === 4) continue; f.add(cyl(0.08, 0.08, 2.6, 4), M(Math.sin(a) * 1.5, H + 1.5, Math.cos(a) * 1.5), IRON); }
        f.add(cone(2.0, 1.8, 6), M(0.4, H + 3.4, 0, 0, 1, 1, 1, 0.2, 0.35), SLATE);
        f.add(cyl(0.9, 0.5, 0.5, 8), M(0, H + 0.5, 0), IRON); K.g.add(cyl(0.8, 0.8, 0.05, 8), M(0, H + 0.76, 0), 0xff7a20);
        sFire(0, H + 0.8, 0, 1.3, 0, true);
        f.add(new T.PlaneGeometry(1.2, 2.2), M(0, 1.1, 3.02), 0x0a0808);
        for (let i = 0; i < 5; i++) { const y = 3 + i * 3, a = i * 1.3, rad = 3.0 - 0.9 * (y / H) + 0.04; f.add(new T.PlaneGeometry(0.5, 1), M(Math.sin(a) * rad, y, Math.cos(a) * rad, a), 0x0a0808); }
        for (const q of [[-5, -1, 0.5, 4], [-7.5, -3, 5, 0.5], [-5, -5, 0.5, 4]]) bx(f, q[0], 0.7, q[1], q[2], 1.2 + R(), q[3], STONE, 0, 0, 0, 0.2);
        for (let i = 0; i < 8; i++) { const a = R() * TAU, d = 5 + R() * 5, x = Math.sin(a) * d, z = Math.cos(a) * d; f.add(lumpy(ico(0.6 + R() * 0.8, 0), 0.2, i), M(x, GL(x, z) + 0.2, z, R() * 3), rockCol); }
        sCrow(2.2, H + 0.3, 1.1); sCrow(-1.8, H + 0.3, -1.6); sCol(0, 0, 3.0, H + 4);
      } },
    hunters: { b: 'forest', names: ["Trapper's Camp", 'Grimwald Camp', "The Skinner's Fire"], loot: [[2.4, 2.9, 'bag', 0.4], [-1.4, -4.4, 'chest', Math.PI]],
      build(K, R) {
        const f = K.f;
        sBonfire(K, 0, 0, 0.55, true);
        const lk = new Batch();
        for (const s of [-1, 1]) lk.add(cyl(0.06, 0.07, 2.4, 4), M(s * 1.4, 1.1, 0.8, 0, 1, 1, 1, 0.1, 0), WOOD);
        lk.add(cyl(0.06, 0.06, 3.2, 4), M(0, 2.2, 0.85, 0, 1, 1, 1, 0, Math.PI / 2), WOOD);
        lk.add(new T.PlaneGeometry(3.2, 2.6, 3, 2), M(0, 1.2, 0, 0, 1, 1, 1, 0.95, 0), (ny, cy, R2) => (R2() < 0.3 ? 0x5a4630 : HIDE), 0.2);
        lk.add(lumpy(new T.PlaneGeometry(2.2, 1.6, 2, 2), 0.1, 3), M(0, 0.05, 0.2, 0, 1, 1, 1, -Math.PI / 2, 0), 0x5a4a38);
        f.merge(lk, M(-3.8, GL(-3.8, -2.2), -2.2, 0.7));
        for (let i = 0; i < 2; i++) {
          const x = 3.3 + i * 0.6, z = -2.2 + i * 2.6, y = GL(x, z), rk = new Batch(), ry = -0.9 + i * 0.5;
          for (const s of [-1, 1]) rk.add(cyl(0.06, 0.07, 2.4, 4), M(s * 0.95, 1.2, 0), WOOD);
          bx(rk, 0, 2.2, 0, 2.1, 0.1, 0.1, WOOD); bx(rk, 0, 0.5, 0, 2.1, 0.1, 0.1, WOOD);
          rk.add(lumpy(new T.PlaneGeometry(1.6, 1.5, 3, 3), 0.18, i), M(0, 1.35, 0.02), (ny, cy, R2) => (Math.abs(cy) < 0.3 ? 0x8a6a48 : HIDE), 0.2);
          f.merge(rk, M(x, y, z, ry)); sBox(x, z, 2.1, 0.3, ry, y + 2.3);
        }
        const tx = -3.4, tz = 2.8, ty = GL(tx, tz);
        for (let k = 0; k < 3; k++) { const a = k * TAU / 3; f.add(cyl(0.05, 0.07, 3.4, 4), limbM(tx + Math.sin(a) * 1.2, ty, tz + Math.cos(a) * 1.2, tx, ty + 3.1, tz), WOOD); }
        f.add(lumpy(ico(0.5, 1), 0.1, 2), M(tx, ty + 1.9, tz, 0, 0.55, 1.4, 0.7), 0x6a2a1a); f.add(ico(0.2, 0), M(tx, ty + 0.9, tz + 0.1, 0, 0.7, 1.2, 1.3), 0x5a3a28);
        sCol(tx, tz, 1, ty + 3);
        for (let k = 0; k < 3; k++) { const a = k * 2.1 + 0.9, x = Math.sin(a) * 2.4, z = Math.cos(a) * 2.4; f.add(cyl(0.25, 0.25, 1.6, 6), M(x, GL(x, z) + 0.2, z, a, 1, 1, 1, 0, Math.PI / 2), 0x4a3422); }
        skull(f, 2.9, GL(2.9, -0.6) + 0.15, -0.6, 0.6, 1.4);
      } },
    fallen: { b: 'forest', clear: 17, names: ['The Fallen Giant', "Old Titan's Bridge", 'Thunderfall Log'], loot: [[2.5, 3.0, 'corpse', 1.2], [-12.0, 3.6, 'chest', 0.3]],
      build(K, R) {
        const f = K.f, y0 = GL(-14, 0) + 1.6, y1 = GL(14, 0) + 1.0;
        f.add(lumpy(new T.CylinderGeometry(1.1, 1.6, 29, 10, 6), 0.25, 9), limbM(-14, y0, 0, 14.5, y1, 0), barkFn, 0.12);
        f.add(new T.CylinderGeometry(1.16, 1.62, 24, 10, 1, true, -Math.PI / 2 - 0.9, 1.8), limbM(-12, y0 + 0.06, 0, 12, lerp(y0, y1, 26 / 28.5) + 0.06, 0), (ny, cy, R2) => (R2() < 0.5 ? 0x4e5a30 : 0x3e4a26), 0.15);
        f.add(lumpy(cyl(3.2, 3.2, 1.0, 10), 0.4, 3), M(-14.5, y0 + 0.5, 0, 0, 1, 1, 1, 0, Math.PI / 2 + 0.1), (ny, cy, R2) => (R2() < 0.5 ? 0x3a2c20 : 0x2a2018), 0.15);
        for (let k = 0; k < 9; k++) { const a = k / 9 * TAU; f.add(cyl(0.08, 0.3, 3, 5, true), limbM(-14.8, y0 + 0.5, 0, -15.8 - R(), y0 + 0.5 + Math.cos(a) * 3.4, Math.sin(a) * 3.4), barkFn); }
        for (let k = 0; k < 6; k++) { const t = 0.3 + k * 0.12, x = lerp(-14, 14, t), y = lerp(y0, y1, t), sd = k % 2 ? 1 : -1; f.add(cyl(0.12, 0.3, 3 + R() * 2, 5), limbM(x, y + 0.6, sd * 0.7, x + 1.5, y + 2.4 + R() * 2, sd * (2.4 + R())), barkFn); }
        for (let k = 0; k < 16; k++) { const x = lerp(-13, 13, R()), y = lerp(y0, y1, (x + 14) / 28.5) - 0.6 + R() * 0.6, z = (R() < 0.5 ? -1 : 1) * (1.25 + R() * 0.3); K.g.add(cyl(0.15 + R() * 0.12, 0.05, 0.06, 6), M(x, y, z), R() < 0.5 ? 0x7ac8a0 : 0xb0d890); }
        sBox(0, 0, 29, 2.8, 0, Math.max(y0, y1) + 1.5); sCrow(4, lerp(y0, y1, 18 / 28.5) + 1.45, 0);
      } },
    witch: { b: 'forest', names: ["Crone's Roost", "Hag Mother's Hut", "The Bone Wife's House"], loot: [[-3.0, 3.2, 'urn'], [3.8, -2.0, 'chest', -1.2]],
      build(K, R) {
        const f = K.f;
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) { f.add(cyl(0.12, 0.16, 2.2, 5), M(sx * 1.7, 0.8, sz * 1.4, 0, 1, 1, 1, sz * 0.1, -sx * 0.1), 0x2e241a); sCol(sx * 1.7, sz * 1.4, 0.3, 2.5); }
        bx(f, 0, 1.8, 0, 4.2, 0.2, 3.6, 0x3a2e22);
        bx(f, 0, 3.1, 0, 3.2, 2.4, 2.8, 0x3a3226, 0, 0, 0.07, 0.2);
        f.add(prism(3.6, 3.1, 2.6), M(0, 4.3, 0), 0x3a3226); roof(f, 3.6, 3.1, 2.6, 4.3, 0x2a2618, 0.8, 0.3);
        bx(f, 0, 2.8, 1.42, 0.9, 1.7, 0.1, 0x120c08); K.g.add(new T.PlaneGeometry(0.5, 0.5), M(-1.0, 3.4, 1.43), 0x80ffb0);
        for (let st = 0; st < 4; st++) bx(f, 0, 1.6 - st * 0.42, 2.2 + st * 0.5, 1.0, 0.1, 0.45, 0x3a2e22);
        for (let c = 0; c < 6; c++) { const x = -1.6 + c * 0.64; f.add(cyl(0.01, 0.01, 0.9, 3), M(x, 4.0, 1.7), 0x6a5a40); if (c % 2) skull(f, x, 3.5, 1.72, 0, 0.55); else f.add(cyl(0.02, 0.03, 0.5, 3), M(x, 3.45, 1.72, 0, 1, 1, 1, 0, 0.5), BONE); }
        const cx = 2.8, cz = 2.8, cy = GL(cx, cz);
        f.add(new T.SphereGeometry(0.7, 8, 4, 0, TAU, Math.PI / 2, Math.PI / 2), M(cx, cy + 1.0, cz), IRON);
        K.g.add(cyl(0.62, 0.62, 0.04, 8), M(cx, cy + 0.95, cz), 0x5aff90);
        for (let k = 0; k < 3; k++) { const a = k * TAU / 3; f.add(cyl(0.04, 0.05, 1.3, 4), limbM(cx + Math.sin(a) * 0.8, cy, cz + Math.cos(a) * 0.8, cx + Math.sin(a) * 0.5, cy + 1.1, cz + Math.cos(a) * 0.5), IRON); }
        sFire(cx, cy + 0.15, cz, 0.7, 2, true); sCol(cx, cz, 0.8, cy + 1.2);
        for (let i = 0; i < 5; i++) { const a = i / 5 * TAU + 0.3, d = 7 + R() * 2; sStake(K, Math.sin(a) * d, Math.cos(a) * d, R); }
        const ty = GL(-3.2, -2.6); f.add(cyl(0.1, 0.14, 3.2, 5), M(-3.2, ty + 1.5, -2.6), DWOOD); skull(f, -3.2, ty + 3.1, -2.6, 0.4, 1.4);
        for (const s of [-1, 1]) f.add(cyl(0.03, 0.05, 1.2, 4), limbM(-3.2, ty + 3.2, -2.6, -3.2 + s * 0.8, ty + 4, -2.5), BONE);
        sCol(-3.2, -2.6, 0.2, ty + 3); bones(K, 0, 4, 3, 8, R);
      } },
    hollow: { b: 'forest', names: ['The Lantern Oak', 'Hollowheart', "Owl-Mother's Tree"], loot: [[0, 3.8, 'chest'], [3.6, 2.6, 'urn']],
      build(K, R) {
        const f = K.f, H = 8, g = new T.CylinderGeometry(2.55, 2.9, H, 12, 4, true), pp = g.attributes.position;
        for (let v = 0; v < pp.count; v++) { const vy = pp.getY(v); if (vy > H / 2 - 0.1) pp.setY(v, vy - hash2(Math.round(Math.atan2(pp.getX(v), pp.getZ(v)) * 10), 3) * 2.2); }
        f.add(lumpy(g, 0.3, 4), M(0, H / 2 - 0.3, 0), barkFn, 0.12);
        f.add(archShape(1.7, 2.6), M(0, 0, 2.92, 0, 1, 1, 1, -0.1, 0), 0x080605);
        for (let k = 0; k < 3; k++) { const a = k * 2.1 + 0.4; f.add(cyl(0.25, 0.6, 5, 6), limbM(Math.sin(a) * 1.5, H - 1.5, Math.cos(a) * 1.5, Math.sin(a) * 4.2, H + 2.5, Math.cos(a) * 4.2), barkFn); f.add(cyl(0.06, 0.25, 3, 5), limbM(Math.sin(a) * 4.2, H + 2.5, Math.cos(a) * 4.2, Math.sin(a + 0.4) * 5.5, H + 4.4, Math.cos(a + 0.4) * 5.5), barkFn); }
        for (let k = 0; k < 8; k++) { const a = k / 8 * TAU + 0.2; f.add(cyl(0.12, 0.5, 3.4, 5, true), limbM(Math.sin(a) * 2.2, 1.2, Math.cos(a) * 2.2, Math.sin(a) * 4.6, -0.4, Math.cos(a) * 4.6), barkFn); }
        const lx = 1.9, ly = 4.6, lz = 3.5;
        f.add(cyl(0.12, 0.25, 2.2, 5), limbM(0.8, 4.2, 2.3, lx + 0.3, ly + 0.9, lz), barkFn);
        f.add(cyl(0.01, 0.01, 0.8, 3), M(lx, ly + 0.45, lz), IRON);
        f.add(cyl(0.14, 0.18, 0.36, 6, true), M(lx, ly - 0.1, lz), IRON); f.add(cone(0.2, 0.16, 6), M(lx, ly + 0.15, lz), IRON);
        sFire(lx, ly - 0.2, lz, 0.2, 0, true);
        for (let k = 0; k < 10; k++) { const a = R() * TAU, y = R() * 3, rad = 2.95 - y * 0.1; K.g.add(cyl(0.12 + R() * 0.1, 0.04, 0.05, 6), M(Math.sin(a) * rad, y + 0.2, Math.cos(a) * rad), R() < 0.5 ? 0x7ac8a0 : 0xd8c070); }
        sCol(0, 0, 2.9, H);
      } },
    spiders: { b: 'forest', names: ['The Webbed Grove', 'Silkrot Hollow', "The Weaver's Den"], loot: [[1.2, 1.4, 'corpse', 2.4], [-2.2, -1.8, 'bag', 0.8]],
      build(K, R) {
        const f = K.f, tr = [];
        for (let i = 0; i < 6; i++) { const a = i / 6 * TAU + R() * 0.4, d = 6 + R() * 2.5, x = Math.sin(a) * d, z = Math.cos(a) * d; tr.push([x, z]); sDead(K, x, z, 0.9 + R() * 0.4, R, 0x2e2a26); }
        for (let i = 0; i < 6; i++) { const A = tr[i], B = tr[(i + 1) % 6], mx = (A[0] + B[0]) / 2, mz = (A[1] + B[1]) / 2, L = Math.hypot(B[0] - A[0], B[1] - A[1]); web(K, mx, GL(mx, mz) + 2.6 + R(), mz, Math.min(2.8, L * 0.42), Math.atan2(-(B[1] - A[1]), B[0] - A[0]), (R() - 0.5) * 0.3); }
        web(K, 0, 5.6, 0, 5, 0.3, -Math.PI / 2 + 0.15);
        for (let i = 0; i < 5; i++) { const a = R() * TAU, d = 1.5 + R() * 3, x = Math.sin(a) * d, z = Math.cos(a) * d, y = 3.0 + R() * 1.5; f.add(cyl(0.01, 0.01, 5.6 - y, 3), M(x, (y + 5.6) / 2, z), 0xb8b4a8); f.add(lumpy(ico(0.35, 1), 0.08, i), M(x, y, z, R() * 3, 0.9, 2.2, 0.9), (ny, cy, R2) => (R2() < 0.3 ? 0xa8a498 : 0xc8c4b8)); }
        for (let i = 0; i < 7; i++) { const a = R() * TAU, d = R(); f.add(ico(0.25 + R() * 0.15, 1), M(-3 + Math.sin(a) * d, GL(-3, 2.4) + 0.2, 2.4 + Math.cos(a) * d), 0xd8d0b8); }
        bones(K, 0, 0, 5, 16, R); skeleton(K, -1.6, 3.0, 1.2, R);
      } },
    dolmen: { b: 'forest', names: ['The Mossy Dolmen', "Giant's Table", 'The Barrowstone'], loot: [[0, 0.3, 'urn'], [2.8, 2.6, 'corpse', 0.9]],
      build(K, R) {
        const f = K.f;
        for (const s of [-1, 1]) { f.add(lumpy(new T.BoxGeometry(0.9, 2.7, 1.5, 1, 2, 1), 0.2, s + 5), M(s * 1.45, 1.1, 0, 0, 1, 1, 1, 0, s * -0.05), mossyFn); sCol(s * 1.45, 0, 0.8, 2.6); }
        f.add(lumpy(new T.BoxGeometry(4.4, 0.75, 2.6, 2, 1, 2), 0.25, 9), M(0.1, 2.75, 0, 0.1, 1, 1, 1, 0.05, 0.08), mossyFn);
        f.add(lumpy(new T.BoxGeometry(2.6, 2.2, 0.7, 2, 2, 1), 0.2, 11), M(0, 0.9, -1.2, 0, 1, 1, 1, -0.1, 0), mossyFn); sCol(0, -1.2, 1.0, 2);
        for (let g = 0; g < 5; g++) K.g.add(BOX, M(-1 + g * 0.5, 1.2 + (g % 2) * 0.3, -0.83, 0, 0.08, 0.35, 0.02, 0, (R() - 0.5)), 0x80ffb0);
        for (let i = 0; i < 12; i++) { const a = i / 12 * TAU, x = Math.sin(a) * 5.5, z = Math.cos(a) * 5.5; f.add(lumpy(ico(0.35, 0), 0.1, i), M(x, GL(x, z) + 0.15, z), mossyFn); }
        skull(f, -0.7, 0.12, 0.6, 0.4); sCandle(K, 0.7, 0, 0.9, true);
      } },
    woodcut: { b: 'forest', names: ["Woodcutter's Clearing", "Axeman's Rest", 'The Stump Field'], loot: [[3.8, 1.8, 'rack', -1.2], [-2.8, 3.0, 'chest', 0.6]],
      build(K, R) {
        const f = K.f, stump = (x, z, s) => f.add(cyl(0.4 * s, 0.55 * s, 0.7 * s, 7), M(x, GL(x, z) + 0.3 * s, z), ny => (ny > 0.8 ? 0x8a6e48 : 0x3a2c20));
        for (let i = 0; i < 12; i++) { const a = R() * TAU, d = 4 + R() * 7; stump(Math.sin(a) * d, Math.cos(a) * d, 0.8 + R() * 0.6); }
        stump(0, 0, 1.4); sCol(0, 0, 0.7, 1);
        f.add(cyl(0.035, 0.04, 0.9, 4), M(0.2, 1.35, 0.05, 0, 1, 1, 1, 0.1, -0.7), 0x6a4a2c); bx(f, -0.05, 1.02, 0.03, 0.3, 0.22, 0.05, 0x9a9ea6, 0, 0, -0.7);
        for (let i = 0; i < 15; i++) { const row = i < 6 ? 0 : i < 11 ? 1 : 2, n = i - [0, 6, 11][row]; f.add(cyl(0.22, 0.22, 3, 7), M(-3.5 + (n - 2.5 + row * 0.5) * 0.45, 0.22 + row * 0.38, -3.4, 0, 1, 1, 1, Math.PI / 2, 0), 0x4a3422, 0.15); }
        sBox(-3.5, -3.4, 3.0, 3.2, 0, 1.2);
        const sx0 = 3.4, sz0 = -3.2;
        for (const s of [-1, 1]) { f.add(cyl(0.05, 0.05, 1.3, 4), M(sx0 + s * 0.9, 0.5, sz0 - 0.3, 0, 1, 1, 1, 0.45, 0), WOOD); f.add(cyl(0.05, 0.05, 1.3, 4), M(sx0 + s * 0.9, 0.5, sz0 + 0.3, 0, 1, 1, 1, -0.45, 0), WOOD); }
        f.add(cyl(0.25, 0.25, 3, 7), M(sx0, 1.05, sz0, 0, 1, 1, 1, 0, Math.PI / 2), 0x4a3422); bx(f, sx0 + 0.3, 1.2, sz0, 0.04, 0.6, 0.9, 0x8a8e96, 0, 0, 0.1);
        sBox(sx0, sz0, 3, 1, 0, 1.3);
        for (const q of [[-5.5, 1], [-5.5, 4], [-7.3, 1], [-7.3, 4]]) { const h = q[0] > -6 ? 2.6 : 1.8; f.add(cyl(0.08, 0.1, h, 5), M(q[0], h / 2, q[1]), WOOD); }
        bx(f, -6.4, 2.25, 2.5, 2.4, 0.12, 3.6, 0x3a2e22, 0, 0, 0.42);
        for (let i = 0; i < 8; i++) bx(f, -6.5 + (i % 2) * 0.1, 0.25 + ((i / 2) | 0) * 0.3, 1.4 + (i % 4) * 0.7, 0.9, 0.28, 0.3, i % 3 ? 0x5a4028 : 0x6a4a2e, 0.1);
        sDead(K, 8.5, -5, 1.1, R);
      } },
    sunken: { b: 'swamp', noFlat: true, names: ['The Drowned Kings', 'The Sinking Gods', 'Mirewatch'], loot: [[1.6, 3.6, 'urn'], [-4.6, 2.4, 'corpse', 0.4]],
      build(K, R) {
        const f = K.f;
        const statue = (x, z, ry, s, tilt) => {
          const b = new Batch();
          bx(b, 0, -1.6, 0, 2.4, 2.6, 1.3, paleFn); bx(b, 0, 0.1, 0, 3.6, 1.1, 1.6, paleFn); bx(b, 0, 0.9, 0.05, 0.6, 0.6, 0.6, paleFn); bx(b, 0, 1.75, 0.05, 1.2, 1.4, 1.25, paleFn);
          bx(b, 0, 1.95, 0.68, 1.1, 0.18, 0.12, 0x837d72); bx(b, 0, 1.6, 0.72, 0.18, 0.4, 0.16, 0x9e988a);
          for (const e of [-0.28, 0.28]) bx(b, e, 1.78, 0.67, 0.22, 0.12, 0.06, 0x141210);
          bx(b, 0, 1.25, 0.66, 0.5, 0.08, 0.06, 0x2a2622);
          for (let c = 0; c < 5; c++) b.add(cone(0.14, 0.55, 4), M(-0.5 + c * 0.25, 2.65, 0.05), 0x8a7a50);
          bx(b, 0, 2.45, 0.05, 1.3, 0.16, 1.35, 0x8a7a50);
          f.merge(b, M(x, GL(x, z) - 0.4 * s, z, ry, s, s, s, tilt, tilt * 0.6));
          sCol(x, z, 1.6 * s, 3 * s);
        };
        statue(0, -2, 0.2, 1.5, 0.18); statue(-6.2, -1, 0.9, 1.2, -0.3); statue(5.8, 0.5, -0.7, 1.0, 0.45);
        const hx = 3.6, hz = 5.4, hy = GL(hx, hz), hb = new Batch();
        bx(hb, 0, 0.6, 0, 0.7, 1.4, 0.8, paleFn); for (let k = 0; k < 4; k++) bx(hb, -0.25 + k * 0.17, 1.45, 0.25, 0.15, 0.5, 0.15, paleFn, 0, 0.6); bx(hb, 0.4, 1.1, 0.2, 0.18, 0.45, 0.18, paleFn, 0, 0.5, 0.5);
        bx(hb, 0, 3.2, 0.3, 0.14, 3.6, 0.05, 0x7a7e86); bx(hb, 0, 1.3, 0.3, 0.9, 0.12, 0.2, 0x5a4a30);
        f.merge(hb, M(hx, hy - 0.3, hz, 0.5, 1.4, 1.4, 1.4, 0.15, 0.1)); sCol(hx, hz, 0.7, 5);
        for (let i = 0; i < 4; i++) sDead(K, -8 + R() * 16, -8 - R() * 3, 0.8 + R() * 0.4, R, 0x2c2a22, (R() - 0.5) * 0.5);
        sCrow(0, GL(0, -2) + 3.6, -1.3);
      } },
    chapel: { b: 'swamp', noFlat: true, tall: 13, silR: 1.6, silZ: -6.1, names: ['The Drowned Chapel', "Saint Ulm's Sinking", 'The Bell of the Mire'], guard: 'ghoul', guardP: 0.9, loot: [[0, 0.8, 'chest', 0, 1], [4.0, 6.2, 'urn']],
      build(K, R) {
        const f = K.f, k = new Batch(), wall = (ny, cy, R2) => (R2() < 0.3 ? [0x4a5230, 0x3e4628][(R2() * 2) | 0] : cy < -0.5 && R2() < 0.6 ? 0x3a3a2c : [0x6e685c, 0x5e5a50, 0x7a7466, 0x55514a][(R2() * 4) | 0]);
        bx(k, -2.6, 2.2, 0, 0.5, 4.4, 9, wall); bx(k, 2.6, 2.2, 0, 0.5, 4.4, 9, wall); bx(k, 0, 2.2, -4.5, 5.7, 4.4, 0.5, wall);
        for (const s of [-1, 1]) bx(k, s * 1.8, 2.2, 4.5, 2.1, 4.4, 0.5, wall);
        bx(k, 0, 3.8, 4.5, 1.5, 1.2, 0.5, wall);
        for (const z of [-4.5, 4.5]) k.add(prism(0.5, 5.7, 2.6), M(0, 4.4, z, Math.PI / 2), wall);
        const rb = new Batch(); roof(rb, 4.6, 5.4, 2.6, 4.4, SLATE, 0.5, 0.25); k.merge(rb, M(0, 0, -2.3, Math.PI / 2));
        for (let i = 0; i < 3; i++) for (const s of [-1, 1]) if (R() < 0.75) bx(k, s * 1.35, 5.7, 0.6 + i * 1.3, 3.1, 0.18, 0.18, DWOOD, 0, 0, -s * 0.74);
        for (const z of [-2.5, 0, 2.5]) for (const s of [-1, 1]) k.add(archShape(0.8, 2.0), M(s * 2.87, 1.6, z, s * Math.PI / 2), 0x0a0808);
        bx(k, 0, 5.5, -6.1, 2.6, 11, 2.6, wall);
        for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) k.add(archShape(1.0, 1.8), M(Math.sin(a) * 1.32, 8.6, -6.1 + Math.cos(a) * 1.32, a), 0x0a0808);
        k.add(cone(2.1, 3.2, 4), M(0, 12.6, -6.1, Math.PI / 4), SLATE);
        k.add(cyl(0.3, 0.55, 0.8, 8), M(0, 9.2, -6.1), 0x6a5020);
        f.merge(k, M(0, -0.9, 0, 0, 1, 1, 1, 0.04, 0.06));
        sBox(-2.6, 0, 0.6, 9, 0, 4); sBox(2.6, 0, 0.6, 9, 0, 4); sBox(0, -4.5, 5.7, 0.6, 0, 4); sBox(-1.8, 4.5, 2.1, 0.6, 0, 4); sBox(1.8, 4.5, 2.1, 0.6, 0, 4); sBox(0, -6.1, 2.8, 2.8, 0, 11);
        for (let i = 0; i < 4; i++) { const x = -1.2 + i * 0.8, z = 5.5 + (i % 2) * 0.2; sCandle(K, x, GL(x, z), z, i === 1); }
        for (let i = 0; i < 9; i++) { const x = (R() < 0.5 ? -1 : 1) * (4.5 + R() * 4), z = -5 + R() * 11, y = GL(x, z); bx(f, x, y + 0.3, z, 0.7, 1.2, 0.2, [0x6e6a5e, 0x5e5a50][i % 2], R() * 0.5 - 0.25, (R() - 0.5) * 0.4, (R() - 0.5) * 0.4, 0.1); }
        sDead(K, -7.5, -6.5, 1.1, R, 0x2c2a22, 0.2);
        sCrow(0, 6.25, 4.5); sFire(0, 1.2, -3.2, 0.001, 2, true);
      } },
    cagetree: { b: 'swamp', noFlat: true, names: ['The Gibbet Tree', 'Crowcage Willow', 'The Hanging Cages'], loot: [[1.9, 3.0, 'corpse', 0.3]],
      build(K, R) {
        const f = K.f;
        f.add(lumpy(cyl(0.55, 0.95, 6, 8), 0.15, 5), M(0, 2.6, 0, 0, 1, 1, 1, -0.06, 0.08), barkFn);
        const limbs = [[3.6, 6.2, 0.4], [-3.0, 6.6, 1.2], [0.3, 7.2, -3.2]];
        for (const q of limbs) { f.add(cyl(0.14, 0.35, Math.hypot(q[0], q[1] - 5, q[2]) + 0.3, 6), limbM(0, 5, 0, q[0], q[1], q[2]), barkFn); f.add(cyl(0.04, 0.12, 2.4, 4), limbM(q[0], q[1], q[2], q[0] * 1.3, q[1] + 1.6, q[2] * 1.3), barkFn); }
        for (let k = 0; k < 6; k++) { const a = k * 1.05 + R(); f.add(cyl(0.08, 0.3, 2.4, 5, true), limbM(0, 0.5, 0, Math.sin(a) * 2, -0.4, Math.cos(a) * 2), barkFn); }
        for (let i = 0; i < 2; i++) {
          const q = limbs[i], x = q[0] * 0.85, y = 5 + (q[1] - 5) * 0.85, z = q[2] * 0.85, b = new Batch();
          b.add(cyl(0.02, 0.02, 1.2, 3), M(0, -0.6, 0), IRON);
          for (let bI = 0; bI < 8; bI++) { const a2 = bI / 8 * TAU; b.add(cyl(0.022, 0.022, 1.9, 3), M(Math.sin(a2) * 0.42, -2.15, Math.cos(a2) * 0.42), IRON); }
          for (const yy of [-3.1, -1.2]) b.add(new T.TorusGeometry(0.42, 0.035, 3, 10), M(0, yy, 0, 0, 1, 1, 1, Math.PI / 2, 0), IRON);
          b.add(cyl(0.44, 0.44, 0.04, 8), M(0, -3.1, 0), IRON);
          skull(b, 0, -1.65, 0, R() * 3); bx(b, 0, -2.25, 0, 0.3, 0.7, 0.18, BONE); for (let rb = 0; rb < 4; rb++) bx(b, 0, -2.05 - rb * 0.13, 0.08, 0.42, 0.04, 0.2, BONE, 0, 0, 0, 0);
          b.add(cyl(0.035, 0.035, 0.8, 3), M(0.08, -2.8, 0.05, 0, 1, 1, 1, 0.3, 0.2), BONE);
          f.merge(b, M(x, y, z, R() * 3));
          sCrow(x, y - 1.15, z);
        }
        sCrow(limbs[2][0] * 0.9, limbs[2][1] + 0.1, limbs[2][2] * 0.9);
        bones(K, 0, 1, 3, 8, R); sCol(0, 0, 0.9, 8);
      } },
    stilts: { b: 'swamp', noFlat: true, names: ['The Stilt House', "Bogman's Stilts", "The Eelwife's House"], loot: [[3.2, 5.4, 'bag', 0.4], [-4.4, 3.4, 'chest', 0.8]],
      build(K, R) {
        const f = K.f, dy = 2.7;
        for (let i = 0; i < 6; i++) { const x = (i % 3 - 1) * 2.8, z = i < 3 ? -2.4 : 2.4; f.add(cyl(0.13, 0.17, 4.2, 5), M(x, dy - 1.6, z, 0, 1, 1, 1, (R() - 0.5) * 0.12, (R() - 0.5) * 0.12), 0x2e241a); sCol(x, z, 0.25, dy); }
        bx(f, 0, dy, 0, 7.2, 0.22, 6, 0x3a2e22, 0, 0, 0, 0.2);
        for (const s of [-1, 1]) bx(f, s * 3.5, dy + 0.5, 0, 0.1, 0.9, 6, DWOOD, 0, 0, 0, 0);
        bx(f, -0.6, dy + 1.4, -0.8, 4.8, 2.6, 3.6, 0x3e3428, 0, 0, 0, 0.2);
        const rb = new Batch(); rb.add(prism(4.8, 3.6, 2.0), null, 0x3e3428); roof(rb, 4.8, 3.6, 2.0, 0, 0x2a2618, 0.7, 0.28); f.merge(rb, M(-0.6, dy + 2.7, -0.8));
        bx(f, -0.6, dy + 1.1, 1.02, 0.9, 1.8, 0.08, 0x120c08); K.g.add(new T.PlaneGeometry(0.6, 0.5), M(1.0, dy + 1.8, 1.03), 0xffa040);
        for (const s of [-0.35, 0.35]) f.add(cyl(0.05, 0.05, 3.4, 4), M(1.8 + s, dy / 2 - 0.1, 3.4, 0, 1, 1, 1, -0.3, 0), WOOD);
        for (let r = 0; r < 6; r++) bx(f, 1.8, 0.2 + r * 0.48, 3.9 - r * 0.15, 0.8, 0.06, 0.08, WOOD, 0, 0, 0, 0);
        f.add(cyl(0.06, 0.08, 3.2, 4), M(3.4, dy + 1.6, 2.8), DWOOD); bx(f, 3.1, dy + 3.1, 2.8, 0.7, 0.06, 0.06, DWOOD); f.add(cyl(0.12, 0.15, 0.3, 5), M(2.8, dy + 2.8, 2.8), IRON);
        sFire(2.8, dy + 2.72, 2.8, 0.28, 0, true);
        for (let n = 0; n < 2; n++) f.add(lumpy(new T.PlaneGeometry(1.8, 1.6, 3, 3), 0.15, n + 7), M(-3.62, dy - 0.2, -1.5 + n * 2.2, Math.PI / 2), (ny, cy, R2) => (R2() < 0.5 ? 0x5a5a48 : 0x4a4a3a), 0.2);
        const bxp = 5.4, bzp = -1.5, byp = Math.max(GL(bxp, bzp), -cs.y + 0.05);
        f.add(new T.CylinderGeometry(0.7, 0.7, 4, 8, 1, true, -Math.PI / 2, Math.PI), M(bxp, byp + 0.55, bzp, 0.3, 1, 1, 1, Math.PI / 2, 0), 0x3a2a1c);
        sCrow(3.1, dy + 3.15, 2.8);
      } },
    bogaltar: { b: 'swamp', noFlat: true, names: ['The Bog Altar', "The Mire Mother's Altar", 'Altar of Sunken Teeth'], loot: [[0, 2.8, 'chest', 0, 1], [-3.0, 1.6, 'urn']],
      build(K, R) {
        const f = K.f;
        for (const s of [-1, 1]) f.add(lumpy(ico(0.8, 0), 0.2, s + 4), M(s * 1.2, 0.3, 0, 0, 1, 0.8, 1), rockFnD);
        bx(f, 0, 0.95, 0, 3.4, 0.35, 1.6, 0x4a4540, 0.05, 0, 0, 0.2);
        f.merge(protos.corpse, M(0, 1.12, 0, Math.PI / 2, 0.95));
        f.add(cyl(0.12, 0.16, 3.8, 6), M(0, 1.8, -1.6), DWOOD); skull(f, 0, 3.8, -1.55, 0, 1.8);
        for (const s of [-1, 1]) { f.add(cyl(0.05, 0.08, 1.6, 4), limbM(0, 4.0, -1.6, s * 1.1, 5.0, -1.5), BONE); for (let t = 0; t < 3; t++) f.add(cyl(0.02, 0.04, 0.6, 3), limbM(s * (0.35 + t * 0.3), 4.2 + t * 0.3, -1.58, s * (0.3 + t * 0.3), 4.8 + t * 0.3, -1.5), BONE); }
        for (let i = 0; i < 11; i++) { const a = (i / 10 - 0.5) * 2.8 + Math.PI, d = 2.3 + (i % 2) * 0.4, x = Math.sin(a) * d, z = Math.cos(a) * d; sCandle(K, x, GL(x, z), z, i === 5); }
        for (let i = 0; i < 6; i++) { const a = i / 6 * TAU + 0.2, d = 5.5 + R(); sStake(K, Math.sin(a) * d, Math.cos(a) * d, R); }
        bones(K, 0, 0, 4, 10, R); sBox(0, 0, 3.4, 1.6, 0, 1.1); sCol(0, -1.6, 0.25, 4);
      } },
    barrow: { b: 'hills', names: ['Barrow of Kings Forgotten', 'The Howe of Hrodgar', 'The Black Barrow'], guard: 'ghoul', guardP: 0.85, loot: [[0.2, 4.6, 'chest'], [3.0, 4.8, 'urn']],
      build(K, R) {
        const f = K.f, ez = 2.3;
        f.add(lumpy(ico(1, 2), 0.12, 21), M(0, -0.6, -5, 0, 8.5, 4.2, 7.5), moundFn, 0.1);
        for (const s of [-1, 1]) f.add(lumpy(new T.BoxGeometry(0.8, 3.0, 0.8, 1, 2, 1), 0.12, s + 30), M(s * 1.3, 1.2, ez), stoneFn);
        f.add(lumpy(new T.BoxGeometry(3.6, 0.7, 1.0, 2, 1, 1), 0.12, 33), M(0, 2.95, ez), stoneFn);
        bx(f, 0, 1.2, ez - 0.2, 1.9, 2.5, 0.35, 0x2a2826, 0, 0, 0, 0.1);
        K.g.add(new T.RingGeometry(0.42, 0.5, 12), M(0, 1.5, ez - 0.01), 0xa02010);
        for (let g = 0; g < 4; g++) K.g.add(BOX, M(Math.sin(g * 1.57) * 0.25, 1.5 + Math.cos(g * 1.57) * 0.25, ez - 0.01, 0, 0.06, 0.18, 0.01, 0, g * 1.57), 0xa02010);
        for (let i = 0; i < 6; i++) f.add(lumpy(ico(0.5 - i * 0.06, 0), 0.1, i), M((R() - 0.5) * 0.4, 3.4 + i * 0.4, -5 + (R() - 0.5) * 0.4), stoneFn);
        for (const s of [-1, 1]) { f.add(lumpy(new T.BoxGeometry(1, 3.8, 0.7, 1, 2, 1), 0.2, s + 40), M(s * 4.2, 1.5, ez + 1.5, s * 0.3, 1, 1, 1, 0, s * 0.08), stoneFn); sCol(s * 4.2, ez + 1.5, 0.7, 3.6); }
        for (let i = 0; i < 4; i++) sStake(K, (i < 2 ? -1 : 1) * (2.6 + (i % 2) * 3.4), ez + 6.5 + (i % 2), R);
        sCol(0, -5, 7.2, 3.5); sBox(0, ez, 3.4, 1.0, 0, 3.2);
        bones(K, 0, ez + 3.5, 2.5, 6, R); sCrow(0, 5.85, -5);
      } },
    mine: { b: 'hills', names: ['The Abandoned Mine', 'Deepdelve Shaft', 'Ironvein Mine'], guard: 'orc', guardP: 0.6, loot: [[-2.8, 2.4, 'chest', 0.3], [3.0, 1.4, 'rack', -1.3]],
      build(K, R) {
        const f = K.f;
        for (let i = 0; i < 10; i++) { const x = -7 + i * 1.6, z = -3.5 - R() * 2, s = 2.5 + R() * 2.5; if (Math.abs(x) < 1.8) { f.add(lumpy(ico(1, 1), 0.3, i), M(x, 4.3 + s * 0.3, z - 1, R() * 3, s, s * 0.7, s), rockFnD); continue; } f.add(lumpy(ico(1, 1), 0.3, i), M(x, s * 0.6, z, R() * 3, s, s * (0.9 + R() * 0.5), s), rockFnD); sCol(x, z, s * 0.85, s * 1.4); }
        f.add(lumpy(ico(1, 1), 0.25, 50), M(0, 3, -8, 0, 9, 6, 5), rockFnD); sCol(0, -8, 6, 8);
        f.add(new T.PlaneGeometry(2.6, 2.9), M(0, 1.45, -2.4), 0x050404);
        for (const s of [-1, 1]) { bx(f, s * 1.45, 1.5, -2.2, 0.3, 3.1, 0.3, WOOD2, 0, 0, s * -0.04); bx(f, s * 1.0, 2.7, -2.1, 0.12, 1.1, 0.12, DWOOD, 0, 0, s * 0.8); sCol(s * 1.45, -2.2, 0.3, 3); }
        bx(f, 0, 3.1, -2.2, 3.6, 0.35, 0.4, WOOD2); bx(f, 0.6, 3.55, -2.0, 1.1, 0.4, 0.06, 0x6a5238, 0, 0, 0.1);
        for (let i = 0; i < 16; i++) { const z = -2.2 + i * 0.6; bx(f, 0, GL(0, z) + 0.06, z, 1.4, 0.1, 0.22, DWOOD, 0, 0, 0, 0.2); }
        for (const s of [-0.5, 0.5]) seg(f, s, GL(s, -2.2) + 0.16, -2.2, s, GL(s, 7) + 0.16, 7, 0.07, 0.09, IRON);
        const cz = 2.4, cy = GL(0, cz); bx(f, 0, cy + 0.75, cz, 1.1, 0.7, 1.4, 0x3a3230, 0, 0, 0, 0.15); bx(f, 0, cy + 1.08, cz, 1.2, 0.08, 1.5, IRON);
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) f.add(cyl(0.22, 0.22, 0.1, 8), M(sx * 0.52, cy + 0.3, cz + sz * 0.45, 0, 1, 1, 1, 0, Math.PI / 2), IRON);
        for (let i = 0; i < 6; i++) { f.add(lumpy(ico(0.2, 0), 0.06, i), M((R() - 0.5) * 0.7, cy + 1.15, cz + (R() - 0.5), R()), 0x2a2622); if (i % 2) K.g.add(BOX, M((R() - 0.5) * 0.6, cy + 1.22, cz + (R() - 0.5) * 0.9, R(), 0.05, 0.05, 0.05), 0xd8a030); }
        sBox(0, cz, 1.2, 1.5, 0, cy + 1.1);
        f.add(cyl(0.07, 0.09, 2.6, 5), M(1.9, 1.3, -1.2), DWOOD); bx(f, 1.7, 2.6, -1.2, 0.5, 0.06, 0.06, DWOOD); f.add(cyl(0.11, 0.14, 0.28, 5), M(1.5, 2.4, -1.2), IRON); sFire(1.5, 2.32, -1.2, 0.26, 0, true);
        for (let i = 0; i < 2; i++) { f.add(cyl(0.03, 0.03, 1.2, 4), M(-1.9 + i * 0.3, 0.6, -1.6, 0, 1, 1, 1, 0.3, 0.2), WOOD); bx(f, -1.78 + i * 0.3, 1.15, -1.45, 0.6, 0.06, 0.06, IRON, 0.3, 0, 0.3); }
        for (let i = 0; i < 12; i++) { const x = 4.8 + R() * 3, z = -1 + R() * 4; f.add(lumpy(ico(0.4 + R() * 0.5, 0), 0.12, i), M(x, GL(x, z) + 0.1, z, R() * 3, 1, 0.6, 1), rockFnD); }
      } },
    giant: { b: 'hills', clear: 16, names: ["The Giant's Grave", "Ymir's Rest", 'The Bones of Thrymm'], loot: [[1.6, 4.4, 'corpse', 2.0], [-5.4, 4.2, 'chest', 0.4]],
      build(K, R) {
        const f = K.f;
        for (let i = 0; i < 9; i++) { const x = -5 + i * 1.3, r = 3.6 - Math.abs(i - 4) * 0.25; f.add(new T.TorusGeometry(r, 0.2, 4, 10, Math.PI * (i === 7 ? 0.5 : 0.9)), M(x, -0.6, 0, Math.PI / 2, 1, 1, 1, 0, 0.15 + (R() - 0.5) * 0.2), BONE); }
        for (let i = 0; i < 12; i++) bx(f, -6 + i * 1.05, 0.2, 0, 0.8, 0.55, 0.6, 0xc4b89c, R() * 0.3, 0, 0, 0.1);
        const sb = new Batch();
        sb.add(lumpy(ico(1.9, 1), 0.2, 3), M(0, 1.3, 0, 0, 1.1, 0.9, 1.0), BONE);
        sb.add(BOX, M(1.3, 0.4, 0, 0, 1.6, 0.8, 1.9), 0xc4b89c);
        for (const s of [-1, 1]) sb.add(ico(0.45, 0), M(1.75, 1.45, s * 0.7), 0x0c0a08);
        sb.add(BOX, M(2.14, 0.9, 0, 0, 0.1, 0.5, 0.35), 0x0c0a08);
        for (let t = 0; t < 7; t++) sb.add(cone(0.1, 0.35, 4), M(2.05, 0.15, -0.8 + t * 0.27, 0, 1, 1, 1, Math.PI, 0), 0xd6ccb4);
        sb.add(BOX, M(1.5, -0.35, 0.2, 0.2, 1.8, 0.4, 1.7), 0xc4b89c);
        f.merge(sb, M(8.8, -0.2, 0.3, -0.25, 1, 1, 1, 0, 0.12));
        sCol(8.8, 0.3, 2.4, 3); sBox(0, 0, 11, 7.2, 0, 2.5);
        const fx = -2.5, fz = 5.6, fy = GL(fx, fz); f.add(cyl(0.35, 0.35, 6, 7), M(fx, fy + 0.3, fz, 0.2, 1, 1, 1, 0, Math.PI / 2), BONE);
        for (const s of [-1, 1]) f.add(ico(0.62, 0), M(fx + s * 3 * Math.cos(0.2), fy + 0.4, fz - s * 3 * Math.sin(0.2)), BONE);
        bx(f, -8.5, 2.8, -2.5, 0.5, 6, 0.12, 0x5a3a2a, 0, 0.1, 0.25); bx(f, -9.2, 5.5, -2.2, 1.8, 0.25, 0.3, 0x3a2a1c, 0, 0.1, 0.25); sCol(-8.5, -2.5, 0.5, 5);
        sCrow(9.0, 2.95, 0.3); bones(K, 0, 4.5, 5, 8, R);
      } },
    lookout: { b: 'hills', tall: 11, silR: 2, names: ['The Bandit Lookout', 'Cutthroat Perch', 'The Blackhand Watch'], guard: 'bandit', guardP: 0.9, loot: [[-3.4, 2.8, 'chest', 0.5], [4.8, -1.4, 'bag', -0.8]],
      build(K, R) {
        const f = K.f, tz = -2.5;
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) f.add(cyl(0.14, 0.18, 6.5, 6), M(sx * 1.3, 3.25, tz + sz * 1.3, 0, 1, 1, 1, -sz * 0.04, sx * 0.04), WOOD);
        for (let s = 0; s < 4; s++) { const q = [[0, 1.3], [1.3, 0], [0, -1.3], [-1.3, 0]][s]; bx(f, q[0], 2.2, tz + q[1], s % 2 ? 0.1 : 2.8, 0.12, s % 2 ? 2.8 : 0.1, DWOOD, 0, s % 2 ? 0.7 : 0, s % 2 ? 0 : 0.7); }
        bx(f, 0, 5.8, tz, 3.4, 0.22, 3.4, WOOD2);
        for (let s = 0; s < 4; s++) { const q = [[0, 1.6], [1.6, 0], [0, -1.6], [-1.6, 0]][s]; bx(f, q[0], 6.4, tz + q[1], s % 2 ? 0.1 : 3.2, 0.9, s % 2 ? 3.2 : 0.1, WOOD, 0, 0, 0, 0.2); }
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) bx(f, sx * 1.5, 7.4, tz + sz * 1.5, 0.12, 2.2, 0.12, DWOOD);
        f.add(cone(2.9, 2, 4), M(0, 9.4, tz, Math.PI / 4), THATCH);
        for (let r = 0; r < 9; r++) bx(f, 0, 0.4 + r * 0.62, tz + 1.95, 0.8, 0.08, 0.1, WOOD, 0, 0, 0, 0);
        for (const sx of [-0.4, 0.4]) bx(f, sx, 2.9, tz + 1.95, 0.08, 5.8, 0.08, WOOD, 0, 0, 0, 0);
        f.add(cyl(0.05, 0.05, 3, 4), M(0.6, 11.4, tz), WOOD); sFlag('flagHand', 0.6, 12.3, tz, R() * 3, 1);
        sBox(0, tz, 2.9, 2.9, 0, 9);
        sBonfire(K, 1.8, 3.4, 0.5, true);
        for (let i = 0; i < 5; i++) { const x = -5.5 + R() * 2.5, z = -3 + i * 1.1, y = GL(x, z); if (i % 2) crate(f, x, y, z, 0.8, R()); else barrel(f, x, y, z, 1); sCol(x, z, 0.6, y + 1); }
        for (let i = 0; i < 5; i++) { const a = i / 5 * TAU + 0.5, d = 8 + R() * 2; sStake(K, Math.sin(a) * d, Math.cos(a) * d, R); }
        for (let i = 0; i < 4; i++) f.add(cyl(0.025, 0.03, 2.6, 4), M(3.2 + i * 0.25, 1.2, -4.5, 0, 1, 1, 1, -0.25, 0), WOOD);
        bx(f, 3.6, 2.1, -4.25, 1.4, 0.08, 0.08, DWOOD); sCrow(-1.6, 6.9, tz + 1.6);
      } },
    battle: { b: 'hills', clear: 22, names: ['The Red Field', 'The Field of Broken Spears', 'Kingsfall Field'], loot: [[4.4, 3.4, 'corpse', 0.8], [-6.8, -4.6, 'corpse', 2.6], [-1.8, 6.4, 'chest', 0.3]],
      build(K, R) {
        const f = K.f, shieldC = [0x6e1410, 0x2a3a26, 0x5a4a2a, 0x3a3a44, 0x1e1a1e];
        for (let i = 0; i < 24; i++) {
          const a = R() * TAU, d = 2 + R() * 17, x = Math.sin(a) * d, z = Math.cos(a) * d, y = GL(x, z), L = 1 + R() * 2.2, dx = (R() - 0.5) * 1.4, dz = (R() - 0.5) * 1.4, ty = y + L;
          if (R() < 0.75) {
            f.add(cyl(0.03, 0.035, Math.hypot(dx, L + 0.2, dz), 4), limbM(x, y - 0.2, z, x + dx, ty, z + dz), 0x4a3422);
            if (R() < 0.55) { const l = Math.hypot(dx, L + 0.2, dz), ux = dx / l, uy = (L + 0.2) / l, uz = dz / l; f.add(cone(0.06, 0.35, 4), limbM(x + dx, ty, z + dz, x + dx + ux * 0.35, ty + uy * 0.35, z + dz + uz * 0.35), 0x8a8e96); }
          } else f.add(cyl(0.035, 0.03, 1.2, 4), M(x, y + 0.04, z, R() * 3, 1, 1, 1, Math.PI / 2, 0), 0x4a3422);
        }
        for (let i = 0; i < 9; i++) { const a = R() * TAU, d = 2 + R() * 16, x = Math.sin(a) * d, z = Math.cos(a) * d, y = GL(x, z); f.add(cyl(0.45, 0.45, 0.06, 10), M(x, y + 0.12, z, R() * 3, 1, 1, 1, 0.2 + R() * 0.3, R() * 0.3), shieldC[i % 5]); f.add(ico(0.1, 0), M(x, y + 0.2, z), IRON); }
        for (let i = 0; i < 9; i++) { const a = R() * TAU, d = 3 + R() * 15; skeleton(K, Math.sin(a) * d, Math.cos(a) * d, R() * TAU, R); }
        for (const q of [[-3, -2, 'hangSkull'], [5, -6, 'flagV'], [7.5, 6, 'hangSkull'], [-9, 4, 'flagV']]) {
          const y = GL(q[0], q[1]), lean = (R() - 0.5) * 0.3, rr = R() * 3, tzz = q[1] + lean * 3;
          f.add(cyl(0.07, 0.09, 6.5, 5), M(q[0], y + 3, q[1], 0, 1, 1, 1, lean, 0), DWOOD);
          if (q[2] === 'hangSkull') { bx(f, q[0], y + 5.9, tzz, 1.8, 0.1, 0.1, DWOOD, rr); sFlag('hangSkull', q[0], y + 5.85, tzz, rr, 0.9); } else sFlag('flagV', q[0], y + 6.0, tzz, rr, 1);
          sCrow(q[0], y + 6.25, q[1] + lean * 3.25); sCol(q[0], q[1], 0.2, y + 6);
        }
        const hx = 2, hz = -9.5, hb = new Batch();
        skull(hb, 0, 0.3, 1.3, 0, 1.6); hb.add(BOX, M(0, 0.25, 1.65, 0, 0.18, 0.14, 0.5), BONE);
        for (let i = 0; i < 8; i++) hb.add(new T.TorusGeometry(0.4 - Math.abs(i - 3) * 0.03, 0.03, 3, 6, Math.PI), M(0, 0.05, 0.6 - i * 0.2), BONE);
        for (const s of [-1, 1]) for (const e of [0.5, -1]) hb.add(cyl(0.04, 0.03, 1.1, 4), limbM(s * 0.2, 0.08, e, s * (0.5 + R() * 0.3), 0.05, e + (R() - 0.5) * 0.8), 0xc8bca0);
        f.merge(hb, M(hx, GL(hx, hz), hz, R() * TAU));
        for (let i = 0; i < 7; i++) f.add(new T.SphereGeometry(0.2, 6, 3, 0, TAU, 0, Math.PI / 2), M(-2 + (i % 3) * 0.3, GL(-2, 1) + 0.05 + ((i / 3) | 0) * 0.18, 1 + (i % 2) * 0.2), IRON);
      } },
    frozen: { b: 'snow', names: ['The Frozen Warrior', 'The Ice-Bound King', 'Hrimgar Unyielding'], loot: [[2.0, 2.6, 'urn'], [-2.6, 3.0, 'corpse', 0.6]],
      build(K, R) {
        const f = K.f, ice = iceFn, b = new Batch();
        bx(f, 0, 0.55, 0, 2.8, 1.1, 2.8, snowy(STONE), 0, 0, 0, 0.1); bx(f, 0, 1.25, 0, 2.2, 0.3, 2.2, snowy(STONE2));
        for (const s of [-1, 1]) bx(b, s * 0.28, 0.9, 0, 0.36, 1.8, 0.42, ice, 0, 0, s * 0.08);
        bx(b, 0, 2.35, 0, 1.0, 1.2, 0.6, ice); bx(b, 0, 1.75, 0, 0.9, 0.35, 0.55, ice);
        for (const s of [-1, 1]) b.add(ico(0.32, 0), M(s * 0.62, 2.85, 0), ice);
        bx(b, 0, 3.2, 0, 0.26, 0.2, 0.26, ice); b.add(ico(0.28, 1), M(0, 3.45, 0), ice);
        for (const s of [-1, 1]) b.add(cone(0.08, 0.7, 5), limbM(s * 0.22, 3.55, 0, s * 0.62, 4.05, 0.05), BONE);
        b.add(lumpy(new T.PlaneGeometry(1.2, 2.4, 2, 3), 0.1, 3), M(0, 2.0, -0.38, 0, 1, 1, 1, 0.1, 0), ice);
        seg(b, 0.62, 2.8, 0, 0.95, 3.9, 0.25, 0.22, 0.24, ice); seg(b, 0.95, 3.9, 0.25, 0.9, 4.6, 0.3, 0.2, 0.22, ice);
        seg(b, 0.9, 4.5, 0.3, 0.9, 7.0, 0.35, 0.12, 0.04, 0xc0d0e0); bx(b, 0.9, 4.6, 0.3, 0.55, 0.1, 0.14, ice);
        seg(b, -0.62, 2.8, 0, -0.85, 2.1, 0.35, 0.22, 0.24, ice); b.add(cyl(0.55, 0.55, 0.1, 10), M(-0.95, 2.2, 0.5, 0, 1, 1, 1, Math.PI / 2 - 0.2, 0), ice);
        for (let i = 0; i < 6; i++) b.add(cone(0.05, 0.3 + R() * 0.3, 4), M(-0.6 + R() * 1.4, 1.95 - R() * 0.3, 0.2 + R() * 0.2, 0, 1, 1, 1, Math.PI, 0), 0xc8dcf0);
        f.merge(b, M(0, 1.4, 0, 0, 1.25));
        K.g.add(ico(0.12, 0), M(0.9 * 1.25, 1.4 + 7.05 * 1.25, 0.35 * 1.25), 0xcfe0ff);
        sCol(0, 0, 1.6, 10);
        for (let i = 0; i < 9; i++) { const a = R() * TAU, d = 3.5 + R() * 5, x = Math.sin(a) * d, z = Math.cos(a) * d; f.add(lumpy(ico(0.8, 1), 0.15, i), M(x, GL(x, z) - 0.2, z, R() * 3, 1.2 + R(), 0.4, 1 + R()), 0xd8dce4); }
      } },
    caravan: { b: 'snow', names: ['The Crushed Caravan', 'Avalanche Road', "The Merchant's Tomb"], loot: [[2.8, 2.6, 'chest', 0.5], [-3.8, 1.8, 'bag', -0.4], [0.8, -3.8, 'corpse', 2.8]],
      build(K, R) {
        const f = K.f, wb = new Batch();
        bx(wb, 0, 0.7, 0, 3.6, 0.2, 1.8, WOOD2); for (const s of [-1, 1]) bx(wb, 0, 1.0, s * 0.88, 3.6, 0.5, 0.08, WOOD);
        for (let i = 0; i < 4; i++) wb.add(new T.TorusGeometry(0.9, 0.05, 3, 8, Math.PI * (i === 2 ? 0.45 : 1)), M(-1.4 + i * 0.95, 1.1, 0, Math.PI / 2), DWOOD);
        wb.add(lumpy(new T.PlaneGeometry(2.6, 2.4, 3, 3), 0.25, 5), M(-0.6, 1.9, 0.3, 0, 1, 1, 1, -1.2, 0.2), 0x7a6a50);
        wb.add(new T.TorusGeometry(0.55, 0.07, 4, 10), M(1.2, 0.5, 0.95), DWOOD);
        for (let k = 0; k < 4; k++) wb.add(BOX, M(1.2, 0.5, 0.95, 0, 0.05, 1.05, 0.05, 0, k * Math.PI / 4), DWOOD);
        f.merge(wb, M(0, -0.1, 0, 0.3, 1, 1, 1, 0.1, -0.35));
        f.add(new T.TorusGeometry(0.55, 0.07, 4, 10), M(-2.8, GL(-2.8, -1.5) + 0.08, -1.5, 0, 1, 1, 1, Math.PI / 2, 0), DWOOD);
        for (const q of [[1.9, 1.4, -0.9, 1.3], [-2.0, 1.9, -1.7, 2.0], [3.2, 1.0, -2.6, 1.3]]) f.add(lumpy(ico(1, 1), 0.3, (q[0] * 10) | 0), M(q[0], q[1], q[2], R() * 3, q[3], q[3] * 0.8, q[3]), snowy(rockCol));
        for (let i = 0; i < 7; i++) { const a = R() * TAU, d = R() * 5, x = Math.sin(a) * d - 1, z = Math.cos(a) * d - 2.5; f.add(lumpy(ico(1, 1), 0.2, i + 60), M(x, GL(x, z) - 0.3, z, R() * 3, 1.5 + R() * 1.5, 0.6 + R() * 0.5, 1.2 + R()), 0xd8dce4); }
        sCol(1.9, -0.9, 1.2, 2.5); sCol(-2.0, -1.7, 1.8, 3.5); sCol(3.2, -2.6, 1.2, 2.3); sBox(0, 0, 3.6, 1.8, 0.3, 1.5);
        for (let i = 0; i < 5; i++) { const x = 1.6 + R() * 3, z = -0.4 + R() * 1.6, y = GL(x, z); if (i % 2) crate(f, x, y - 0.1, z, 0.6, R()); else f.add(cyl(0.3, 0.27, 0.8, 8), M(x, y + 0.28, z, R() * 3, 1, 1, 1, Math.PI / 2, 0), 0x5a3a22); }
        skeleton(K, -4.6, -1.2, 1.2, R, 1.4);
        f.merge(protos.corpse, M(-2.4, GL(-2.4, 4.0) + 0.02, 4.0, 2.2));
      } },
    icecave: { b: 'snow', names: ['The Ice Cave', 'Frostmaw', 'The Blue Throat'], guard: 'troll', guardP: 0.8, loot: [[0.4, 1.0, 'chest'], [3.8, 2.6, 'urn']],
      build(K, R) {
        const f = K.f, rk = snowy(rockFnD);
        for (let i = 0; i < 12; i++) { const a = Math.PI + (i / 11 - 0.5) * 3.4, r = 4.5 + R() * 3.5, s = 2.5 + R() * 3, x = Math.sin(a) * r, z = Math.cos(a) * r - 2; f.add(lumpy(ico(1, 1), 0.35, i), M(x, GL(x, z) + s * 0.25, z, R() * TAU, s, s * (0.7 + R() * 0.5), s), rk, 0.15); sCol(x, z, s * 0.8, s); }
        f.add(lumpy(ico(1, 1), 0.3, 41), M(0, 2.4, -7, 0, 8, 6.5, 7), rk); sCol(0, -7, 6.6, 7);
        K.g.add(new T.CircleGeometry(2.8, 10, 0, Math.PI), M(0, -0.2, -1.2), 0x0c1c2c);
        f.add(lumpy(new T.TorusGeometry(3.2, 0.9, 4, 8, Math.PI), 0.4, 6), M(0, -0.3, -1.3), rk);
        for (let k = 0; k < 13; k++) { const t = (k + 0.5) / 13 * Math.PI, x = Math.cos(t) * 2.55, y = Math.sin(t) * 2.55 - 0.3, L = 0.4 + R() * 1.0; f.add(cone(0.1, L, 4), M(x, y - L / 2, -0.7, 0, 1, 1, 1, Math.PI, 0), 0xb8d8f0); }
        for (let k = 0; k < 7; k++) { const x = (R() - 0.5) * 5, z = -0.8 + R() * 1.5; K.g.add(new T.OctahedronGeometry(0.25, 0), M(x, GL(x, z) + 0.3, z, R(), 0.6, 1.6 + R(), 0.6, (R() - 0.5) * 0.6, (R() - 0.5) * 0.6), 0x9ad0ff); }
        sFire(0, 0.8, -2.2, 0.001, 3, true);
        bones(K, 0, 1.8, 3, 10, R); skeleton(K, 2.4, 0.6, 2.2, R);
      } },
    prayer: { b: 'snow', names: ['The Mountain Shrine', 'Shrine of the Sky-Father', 'The Windprayer Cairn'], loot: [[2.2, 1.8, 'urn'], [-2.6, 2.6, 'bag', 0.4]],
      build(K, R) {
        const f = K.f;
        for (let i = 0; i < 7; i++) f.add(lumpy(ico(1.3 - i * 0.15, 0), 0.15, i), M((R() - 0.5) * 0.3, 0.4 + i * 0.55, (R() - 0.5) * 0.3, R() * 3, 1, 0.7, 1), snowy(stoneFn));
        f.add(lumpy(new T.BoxGeometry(0.5, 1.2, 0.4, 1, 2, 1), 0.06, 3), M(0, 4.4, 0), stoneFn); f.add(ico(0.3, 0), M(0, 5.2, 0), 0x8a8478);
        K.g.add(BOX, M(0, 4.5, 0.21, 0, 0.18, 0.18, 0.02, 0, Math.PI / 4), 0xffc040);
        sCol(0, 0, 1.4, 4.5);
        const FC = [0x8a1a14, 0xc8a040, 0xd8d0c0, 0x2a4a8a, 0x3a6a3a];
        for (const q of [[4.6, -2], [-4.4, -2.6], [0.6, -5.2]]) {
          const y = GL(q[0], q[1]); f.add(cyl(0.06, 0.08, 5, 5), M(q[0], y + 2.4, q[1]), DWOOD); sCol(q[0], q[1], 0.2, y + 5);
          const ax = q[0], ay = y + 4.8, az = q[1], by = 5.0, n = 9, ry = Math.atan2(az, -ax);
          seg(f, ax, ay, az, ax / 2, (ay + by) / 2 - 0.8, az / 2, 0.02, 0.02, 0x8a7a5a); seg(f, ax / 2, (ay + by) / 2 - 0.8, az / 2, 0, by, 0, 0.02, 0.02, 0x8a7a5a);
          for (let i = 1; i < n; i++) { const t = i / n, x = lerp(ax, 0, t), zz = lerp(az, 0, t), yy = lerp(ay, by, t) - (1 - Math.abs(t - 0.5) * 2) * 0.8; K.d.add(new T.PlaneGeometry(0.34, 0.42), M(x, yy - 0.22, zz, ry, 1, 1, 1, 0, (R() - 0.5) * 0.3), FC[i % 5], 0.1); }
          sCrow(q[0], y + 4.95, q[1]);
        }
        for (let i = 0; i < 4; i++) { const a = i / 4 * TAU + 0.4, x = Math.sin(a) * 1.9, z = Math.cos(a) * 1.9; sCandle(K, x, GL(x, z), z, i === 0); }
        skull(f, 1.0, GL(1.0, 1.4) + 0.12, 1.4, 0.3); f.add(cyl(0.16, 0.1, 0.12, 7), M(-0.9, GL(-0.9, 1.5) + 0.06, 1.5), 0x6a4a2c);
      } },
    gskull: { b: 'snow', clear: 15, names: ['The Giant Skull', 'Skull of the Frost Giant', "The Jotun's Skull"], guard: 'troll', guardP: 0.5, loot: [[0, 4.8, 'chest'], [5.0, 2.2, 'corpse', 1.2]],
      build(K, R) {
        const f = K.f, bone = (ny, cy, R2) => (ny > 0.55 && R2() < 0.7 ? 0xd8dce4 : [0xd6ccb4, 0xc4b89c, 0xb8ac90][(R2() * 3) | 0]);
        f.add(lumpy(ico(3.4, 1), 0.3, 7), M(0, 2.4, -1, 0, 1.1, 0.9, 1.2), bone);
        for (const s of [-1, 1]) f.add(ico(1.0, 0), M(s * 1.35, 2.9, 2.75, 0, 1, 1.1, 0.8), 0x080606);
        f.add(ico(0.55, 0), M(0, 1.7, 3.35, 0, 0.8, 1.2, 0.6), 0x080606);
        bx(f, 0, 0.55, 2.2, 4.2, 1.1, 2.4, bone); for (let t = 0; t < 9; t++) f.add(cone(0.18, 0.7, 4), M(-1.8 + t * 0.45, 0.1, 3.35, 0, 1, 1, 1, Math.PI, 0), 0xe0d8c4);
        for (const s of [-1, 1]) { let px = s * 3.0, py = 3.8, pz = -0.5; for (let k = 0; k < 5; k++) { const nx = px + s * 1.1, ny = py + 0.9 - k * 0.15, nz = pz - 0.6 + k * 0.45, r0 = 0.75 - k * 0.14; f.add(cyl(r0 * 0.8, r0, Math.hypot(nx - px, ny - py, nz - pz) + 0.1, 7), limbM(px, py, pz, nx, ny, nz), (n2, cy, R2) => (R2() < 0.3 ? 0x5a4a38 : 0x4a3c2e)); px = nx; py = ny; pz = nz; } }
        sCol(0, -1, 3.6, 5); sBox(0, 2.2, 4.2, 2.4, 0, 1.1);
        bones(K, 0, 5.5, 4, 12, R); sCrow(0.3, 5.5, -0.8);
      } },
    falls: { b: 'falls', names: ['The Weeping Falls', 'The Veil of Tears', 'Mossfang Falls'], loot: [], build: (K, R, s) => buildFalls(K, R, s) },
  };
  const BIOME_TYPES = { meadow: [], coast: [], forest: [], swamp: [], hills: [], snow: [] };
  for (const k in TYPES) if (BIOME_TYPES[TYPES[k].b]) BIOME_TYPES[TYPES[k].b].push(k);

  // ── Waterfalls (scenic sites on the steepest crag steps) ───────────────────
  function buildFalls(K, R, s) {
    const P3 = s.path, n = P3.length / 2, pos = [], uv = [], col = [], idx = [], f = K.f;
    let acc = 0, px = P3[0], pz = P3[1], ph = heightAt(px, pz);
    for (let i = 0; i < n; i++) {
      const x = P3[i * 2], z = P3[i * 2 + 1], j = Math.min(n - 1, i + 1), k = Math.max(0, i - 1);
      const tx = P3[j * 2] - P3[k * 2], tz = P3[j * 2 + 1] - P3[k * 2 + 1], tl = Math.hypot(tx, tz) || 1, nx = -tz / tl, nz = tx / tl;
      const h = heightAt(x, z), fall = i < s.base, w = fall ? 1.9 : lerp(1.5, 0.8, Math.min(1, (i - s.base) / 20)), lift = fall ? 0.45 : 0.14;
      const slope = (heightAt(P3[k * 2], P3[k * 2 + 1]) - heightAt(P3[j * 2], P3[j * 2 + 1])) / (Math.max(1, j - k) * 0.9), wht = clamp(slope / 1.1, 0, 1);
      acc += Math.hypot(x - px, z - pz, h - ph); px = x; pz = z; ph = h;
      for (let c = -1; c <= 1; c++) {
        const ex = x + nx * w * c, ez = z + nz * w * c, v = lerp(0.72, 1.35, wht) * (c ? 0.92 : 1.05);
        pos.push(ex - s.x, Math.max(heightAt(ex, ez), h) + lift + (c ? 0 : 0.08) - s.y, ez - s.z); uv.push((c + 1) / 2, acc / 3); col.push(v, v, v * (1.05 - wht * 0.1));
      }
      if (i) { const b0 = (i - 1) * 3, b1 = i * 3; for (let c = 0; c < 2; c++) idx.push(b0 + c, b1 + c, b0 + c + 1, b0 + c + 1, b1 + c, b1 + c + 1); }
    }
    // the pool at the foot (white churn in the middle, dark water at the rim)
    const bi = Math.min(n - 1, s.base), bxw = P3[bi * 2], bzw = P3[bi * 2 + 1], by = s.poolY, o = pos.length / 3;
    pos.push(bxw - s.x, by - s.y, bzw - s.z); uv.push(0.5, 0.5); col.push(1.3, 1.3, 1.3);
    for (let k = 0; k <= 14; k++) { const a = k / 14 * TAU; pos.push(bxw + Math.sin(a) * 4.2 - s.x, by - s.y, bzw + Math.cos(a) * 4.2 - s.z); uv.push(0.5 + Math.sin(a) * 1.4, 0.5 + Math.cos(a) * 1.4); col.push(0.55, 0.62, 0.66); if (k) idx.push(o, o + k, o + k + 1); }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2)); g.setAttribute('color', new T.Float32BufferAttribute(col, 3)); g.setIndex(idx); g.computeVertexNormals();
    // the spring: a mossy rock lip the water breaks out of
    const ux = P3[0] - P3[2], uz = P3[1] - P3[3], ul = Math.hypot(ux, uz) || 1, sx = ux / ul, sz = uz / ul, h0 = heightAt(P3[0], P3[1]);
    for (let k = 0; k < 7; k++) {
      const a = (k / 6 - 0.5) * 2.6, d = 2.2 + R() * 1.4, dx = sx * Math.cos(a) - sz * Math.sin(a), dz = sz * Math.cos(a) + sx * Math.sin(a), x = P3[0] + dx * d, z = P3[1] + dz * d, s2 = 1.2 + R() * 1.2;
      f.add(lumpy(ico(s2, 1), 0.3, k + 60), M(x - s.x, Math.max(heightAt(x, z), h0) - s.y + s2 * 0.35, z - s.z, R() * 3, 1, 0.8, 1), mossyFn);
    }
    f.add(new T.CircleGeometry(1.1, 8, 0, Math.PI), M(P3[0] + sx * 1.4 - s.x, h0 + 0.1 - s.y, P3[1] + sz * 1.4 - s.z, Math.atan2(-sx, -sz)), 0x080808);
    s.xm = new T.Mesh(g, mats.fall);
    // foam, rocks and a lip of mossy stones
    for (let k = 0; k < 9; k++) { const a = R() * TAU, d = 1 + R() * 2.5, x = bxw + Math.sin(a) * d - s.x, z = bzw + Math.cos(a) * d - s.z; f.add(lumpy(ico(0.5 + R() * 0.4, 0), 0.2, k), M(x, by - s.y + 0.1, z, R() * 3, 1, 0.45, 1), 0xd8dcd8); }
    for (let k = 0; k < 12; k++) { const a = k / 12 * TAU + R() * 0.3, d = 4.4 + R() * 1.2, x = bxw + Math.sin(a) * d - s.x, z = bzw + Math.cos(a) * d - s.z; f.add(lumpy(ico(0.6 + R() * 0.7, 0), 0.25, k + 20), M(x, heightAt(x + s.x, z + s.z) - s.y + 0.1, z, R() * 3, 1, 0.7, 1), mossyFn); }
    for (let k = 0; k < 6; k++) { const x = P3[0] + (R() - 0.5) * 6 - s.x, z = P3[1] + (R() - 0.5) * 6 - s.z; f.add(lumpy(ico(0.6 + R() * 0.6, 0), 0.25, k + 40), M(x, heightAt(x + s.x, z + s.z) - s.y, z, R() * 3, 1, 0.7, 1), mossyFn); }
  }
  function planFalls(R) {
    const cand = [];
    for (let z = -1000; z <= 1000; z += 8) for (let x = -1300; x <= 1300; x += 8) {
      if (coastC(x, z) < 60) continue;
      weights(x, z, W); if (W.forest + W.hills < 0.75 || W.swamp > 0.1) continue;
      const h = samp(HG, x, z); if (h < 12) continue;
      const gx = samp(HG, x + 2, z) - samp(HG, x - 2, z), gz = samp(HG, x, z + 2) - samp(HG, x, z - 2), gl = Math.hypot(gx, gz);
      if (gl < 0.4) continue;
      const dx = -gx / gl, dz = -gz / gl, drop = h - samp(HG, x + dx * 10, z + dz * 10), back = samp(HG, x - dx * 10, z - dz * 10) - h;
      if (drop < 8 || back > 4) continue;
      cand.push([drop - back * 1.5, x, z]);
    }
    cand.sort((a, b) => b[0] - a[0]);
    const out = [];
    for (const c of cand) {
      if (out.length >= 3) break;
      const x = c[1], z = c[2];
      if (!poiFar(x, z, 50) || samp(RD, x, z) < 25) continue;
      if (out.some(o => Math.hypot(o.x - x, o.z - z) < 380) || SITES.some(s => Math.hypot(s.x - x, s.z - z) < 140)) continue;
      // trace downhill from just behind the lip
      const path = []; let px = x, pz = z, base = -1, flat = 0;
      for (let t = 0; t < 4; t++) { const g1 = samp(HG, px + 1.5, pz) - samp(HG, px - 1.5, pz), g2 = samp(HG, px, pz + 1.5) - samp(HG, px, pz - 1.5), l = Math.hypot(g1, g2) || 1; px += g1 / l * 0.8; pz += g2 / l * 0.8; }
      let dxp = 0, dzp = 0;
      for (let i = 0; i < 110; i++) {
        path.push(px, pz);
        const g1 = samp(HG, px + 1.5, pz) - samp(HG, px - 1.5, pz), g2 = samp(HG, px, pz + 1.5) - samp(HG, px, pz - 1.5), l = Math.hypot(g1, g2);
        if (l < 1e-4) break;
        let ddx = -g1 / l, ddz = -g2 / l; if (i) { ddx = ddx * 0.6 + dxp * 0.4; ddz = ddz * 0.6 + dzp * 0.4; const l2 = Math.hypot(ddx, ddz) || 1; ddx /= l2; ddz /= l2; }
        dxp = ddx; dzp = ddz;
        const h0 = samp(HG, px, pz); px += ddx * 0.9; pz += ddz * 0.9;
        const h1 = samp(HG, px, pz); if (h1 < 0.4) break;
        if (base < 0) { if (i > 4 && (h0 - h1) / 0.9 < 0.22) { if (++flat >= 3) base = path.length / 2 - 2; } else flat = 0; }
        else if (path.length / 2 - base > 26) break;
      }
      if (base < 6) continue;
      const bxw = path[base * 2], bzw = path[base * 2 + 1], hb = samp(HG, bxw, bzw);
      stampDisc(bxw, bzw, 8, (i, d) => { const t = sstep(3.8, 8, d); HG[i] = Math.min(HG[i], lerp(hb - 0.6, HG[i], t)); FL[i] *= lerp(0.1, 1, t); });
      addClear(bxw, bzw, 9); for (let i = 0; i < base; i += 3) addClear(path[i * 2], path[i * 2 + 1], 3.5);
      out.push({ x: bxw, z: bzw, path, base, poolY: hb - 0.15 });
    }
    return out;
  }

  // ── Planning (init, after the heightfield bake) ────────────────────────────
  function poiFar(x, z, m) {
    for (const p of POIS) { const r = Math.max(p.radius, CLEAR[p.id] || 0) + m; if ((x - p.x) * (x - p.x) + (z - p.z) * (z - p.z) < r * r) return false; }
    return Math.hypot(x, z + 1250) > 300 + m;
  }
  const _nr = [0, 0];
  function nearestRoad(x, z) {
    let bd = 1e18;
    for (const r of roads) for (let i = 0; i < r.n; i += 3) { const d = (r.X[i] - x) * (r.X[i] - x) + (r.Z[i] - z) * (r.Z[i] - z); if (d < bd) { bd = d; _nr[0] = r.X[i]; _nr[1] = r.Z[i]; } }
    return Math.sqrt(bd);
  }
  function slopeOk(x, z, th, r) {
    if (gridNy(x, z) < th) return false;
    for (let k = 0; k < 6; k++) { const a = k / 6 * TAU; if (gridNy(x + Math.sin(a) * r, z + Math.cos(a) * r) < th - 0.05) return false; }
    return true;
  }
  const guardFor = (b, R) => (b === 'swamp' ? 'ghoul' : b === 'snow' ? (R() < 0.35 ? 'troll' : 'orc') : b === 'hills' ? (R() < 0.5 ? 'orc' : 'bandit') : b === 'forest' ? (R() < 0.6 ? 'bandit' : 'orc') : 'bandit');
  function addLoot(o) {
    o.opened = !!chestSt[o.id]; o.guarded = false; o.ch = null; o.io = null; o.li = o.gi = o.ui = -1; o.y = 0;
    LOOT.push(o);
    const k = ckey(Math.floor(o.x / CH), Math.floor(o.z / CH)); let a = LOOTB.get(k); if (!a) LOOTB.set(k, (a = [])); a.push(o);
    addClear(o.x, o.z, 2.2);
  }
  function planSites() {
    try { if (!localStorage.getItem('crimsonThrone.save') && !localStorage.getItem('crimsonThrone.pois')) { localStorage.removeItem(LS_SITES); localStorage.removeItem(LS_CHESTS); } } catch (e) {}
    siteSt = lsGet(LS_SITES); chestSt = lsGet(LS_CHESTS);
    const R = CT.rng(0x51735), used = {};
    for (let t = 0; t < 60000 && SITES.length < 58; t++) {
      const x = (R() * 2 - 1) * 1380, z = (R() * 2 - 1) * 1380, c0 = coastC(x, z);
      if (c0 < 24 || !poiFar(x, z, 40) || samp(RD, x, z) < 16) continue;
      let near = false; for (const s of SITES) if ((s.x - x) * (s.x - x) + (s.z - z) * (s.z - z) < 175 * 175) { near = true; break; }
      if (near) continue;
      const h = heightAt(x, z), b = biomeAt(x, z);
      if (b === 'citadel') continue;
      const sw = b === 'swamp';
      if (sw ? h < -0.25 : h < 1.2) continue;
      if (!slopeOk(x, z, b === 'snow' ? 0.74 : 0.8, 7)) continue;
      const bk = b === 'coast' ? 'meadow' : b;
      let list = BIOME_TYPES[bk];
      if (c0 < 120 && (b === 'coast' || b === 'meadow' || b === 'hills') && R() < 0.6) list = (cliffK(x, z) > 0.3 || h > 8) ? ['seacave', 'lighthouse'] : ['seacave'];
      let tp = null, bu = 1e9;
      for (const k of list) { const u = (used[k] || 0) + R() * 0.5; if (u < bu) { bu = u; tp = k; } }
      used[tp] = (used[tp] || 0) + 1;
      const T2 = TYPES[tp], coast = T2.b === 'coast';
      let rot;
      if (coast) rot = Math.atan2(x, z);
      else { const d = nearestRoad(x, z); rot = d < 170 ? faceTo(x, z, _nr[0], _nr[1]) : R() * TAU; }
      if (!T2.noFlat) {
        let th = 0; for (let k = 0; k < 9; k++) { const a = k / 8 * TAU, rr = k ? 6 : 0; th += samp(HG, x + Math.sin(a) * rr, z + Math.cos(a) * rr); } th /= 9;
        stampDisc(x, z, 20, (i, d) => { const t2 = sstep(9, 20, d); HG[i] = lerp(th, HG[i], t2); FL[i] *= lerp(0.25, 1, t2); });
      }
      const id = 's' + SITES.length;
      SITES.push({ id, name: T2.names[(used[tp] - 1) % T2.names.length], x: +x.toFixed(1), z: +z.toFixed(1), type: tp, biome: b, found: !!siteSt[id], rot, y: 0, seed: 1000 + SITES.length * 7919, built: false, vis: false, grp: null, fr: null, flags: null, crows: null, xm: null });
      addClear(x, z, T2.clear || 13);
    }
    // waterfalls
    planFalls(R).forEach((w, i) => {
      const id = 'w' + i, T2 = TYPES.falls;
      SITES.push({ id, name: T2.names[i % T2.names.length], x: +w.x.toFixed(1), z: +w.z.toFixed(1), type: 'falls', biome: biomeAt(w.x, w.z), found: !!siteSt[id], rot: 0, y: 0, seed: 77 + i * 131, built: false, vis: false, grp: null, fr: null, flags: null, crows: null, xm: null, path: w.path, base: w.base, poolY: w.poolY });
    });
    for (const s of SITES) s.y = heightAt(s.x, s.z);
    // site loot
    for (const s of SITES) {
      const T2 = TYPES[s.type], c = Math.cos(s.rot), sn = Math.sin(s.rot);
      let first = true;
      const list = s.type === 'falls' ? (() => { const P3 = s.path, i = Math.max(0, s.base - 1), tx = P3[s.base * 2] - P3[i * 2], tz = P3[s.base * 2 + 1] - P3[i * 2 + 1], tl = Math.hypot(tx, tz) || 1; return [[-tz / tl * 6.6, tx / tl * 6.6, 'chest', Math.atan2(tz, -tx)]]; })() : T2.loot;
      list.forEach((q, k) => {
        const lx = q[0], lz = q[1], x = s.type === 'falls' ? s.x + lx : s.x + lx * c + lz * sn, z = s.type === 'falls' ? s.z + lz : s.z - lx * sn + lz * c;
        const kind = q[2], chest = kind === 'chest';
        let guard = null;
        if (chest && first && T2.guard && R() < (T2.guardP || 0.7)) guard = T2.guard;
        if (chest) first = false;
        const blood = chest && (!!q[4] || R() < 0.2);
        addLoot({ id: s.id + 'c' + k, kind, x, z, ry: s.type === 'falls' ? q[3] : s.rot + (q[3] || 0), guard, blood, site: s.id });
      });
    }
    // scattered loot: saddlebags and the fallen along the roads, caches in the wild
    const okAt = (x, z, gap) => {
      if (coastC(x, z) < 12 || !poiFar(x, z, 12)) return false;
      const h = heightAt(x, z); if (h < 0.4 || gridNy(x, z) < 0.8) return false;
      for (const s of SITES) if ((s.x - x) * (s.x - x) + (s.z - z) * (s.z - z) < 35 * 35) return false;
      for (const o of LOOT) if ((o.x - x) * (o.x - x) + (o.z - z) * (o.z - z) < gap * gap) return false;
      return true;
    };
    let ri = 0;
    for (const r of roads) for (let i = 50; i < r.n - 50; i += 85) {
      if (R() > 0.6) continue;
      const j = Math.min(r.n - 1, i + 2), tx = r.X[j] - r.X[i], tz = r.Z[j] - r.Z[i], tl = Math.hypot(tx, tz) || 1, sd = R() < 0.5 ? -1 : 1, off = 5 + R() * 3;
      const x = r.X[i] - tz / tl * off * sd, z = r.Z[i] + tx / tl * off * sd;
      if (samp(RD, x, z) < 4.5 || !okAt(x, z, 60)) continue;
      const kind = R() < 0.55 ? 'bag' : 'corpse';
      addLoot({ id: 'r' + ri++, kind, x, z, ry: faceTo(x, z, r.X[i], r.Z[i]) + (kind === 'corpse' ? R() * 2 - 1 : 0), guard: null, blood: false, site: null });
    }
    let wi = 0;
    for (let t = 0; t < 6000 && wi < 42; t++) {
      const x = (R() * 2 - 1) * 1350, z = (R() * 2 - 1) * 1350;
      if (samp(RD, x, z) < 7 || !okAt(x, z, 90)) continue;
      const b = biomeAt(x, z); if (b === 'citadel') continue;
      const u = R(), kind = u < 0.36 ? 'chest' : u < 0.66 ? 'corpse' : u < 0.86 ? 'urn' : 'rack';
      const guard = kind === 'chest' && z < 880 && R() < 0.4 ? guardFor(b, R) : null;
      addLoot({ id: 'x' + wi++, kind, x, z, ry: R() * TAU, guard, blood: kind === 'chest' && R() < 0.2, site: null });
    }
  }

  // ── Loot in the chunks ─────────────────────────────────────────────────────
  const LABEL = { chest: 'Open Chest', urn: 'Smash Urn', corpse: 'Search the Fallen', rack: 'Take from the Weapon Rack', bag: 'Search the Saddlebags' };
  let pendReg = false;
  function putI(ch, name, x, y, z, ry, sx, sy, sz, cr, cg, cb, rx, rz) {
    const L0 = ch.inst[name], n0 = L0 ? L0.n : 0;
    put(ch, name, x, y, z, ry, sx, sy, sz, cr, cg, cb, rx, rz);
    const L = ch.inst[name]; return L && L.n > n0 ? n0 : -1;
  }
  function setI(ch, name, i, x, y, z, ry, sx, sy, sz, rx, rz) {
    const L = ch.inst[name]; if (!L || i < 0 || i >= L.n) return;
    _e.set(rx || 0, ry, rz || 0); _q.setFromEuler(_e); _p.set(x, y, z); _s.set(sx, sy, sz);
    _m.compose(_p, _q, _s); _m.toArray(L.m, i * 16); pools[name].dirty = true;
  }
  function lidSet(c, ang) {
    const s = c.blood ? 1.2 : 1, sn = Math.sin(c.ry), co = Math.cos(c.ry);
    setI(c.ch, 'lid', c.li, c.x - sn * 0.36 * s, c.y + 0.62 * s, c.z - co * 0.36 * s, c.ry, s, s, s, -ang, 0);
  }
  function lootChunk(ch) {
    unregLoot(ch);
    if (ch.lod !== 1) return;
    const L = LOOTB.get(ch.key); if (!L) return;
    for (const c of L) {
      const y = (c.y = heightAt(c.x, c.z) - 0.02), ry = c.ry;
      c.li = c.gi = c.ui = -1;
      if (c.kind === 'chest') {
        const s = c.blood ? 1.2 : 1, sn = Math.sin(ry), co = Math.cos(ry);
        put(ch, c.blood ? 'bchest' : 'chest', c.x, y, c.z, ry, s, s, s, 1, 1, 1);
        c.li = putI(ch, 'lid', c.x - sn * 0.36 * s, y + 0.62 * s, c.z - co * 0.36 * s, ry, s, s, s, c.blood ? 0.8 : 1, c.blood ? 0.32 : 1, c.blood ? 0.3 : 1, c.opened ? -1.95 : 0, 0);
        addCol(ch, c.x, c.z, 0.5 * s, y + 0.8 * s);
      } else if (c.kind === 'urn') { c.ui = putI(ch, 'urn', c.x, y, c.z, ry, 1, c.opened ? 0.4 : 1, 1, 1, 1, 1, c.opened ? 0.25 : 0, 0); addCol(ch, c.x, c.z, 0.3, y + 0.8); }
      else if (c.kind === 'rack') { put(ch, 'rack', c.x, y, c.z, ry, 1, 1, 1, 1, 1, 1); const k = c.opened ? 0 : 1; c.ui = putI(ch, 'rackw', c.x, y, c.z, ry, k, k, k, 1, 1, 1); addCol(ch, c.x, c.z, 0.45, y + 1.5); }
      else put(ch, c.kind, c.x, y, c.z, ry, 1, 1, 1, 1, 1, 1);
      if (!c.opened) c.gi = putI(ch, 'glint', c.x, y + (c.kind === 'corpse' || c.kind === 'bag' ? 0.4 : c.kind === 'rack' ? 1.0 : 0.8), c.z, 0, 0.9, 0.9, 0.9, 1, c.blood ? 0.2 : 0.72, c.blood ? 0.1 : 0.28);
      c.ch = ch; ch.loot.push(c);
    }
    regLoot(ch);
  }
  const useLoot = o => openC(o.c);
  function regLoot(ch) {
    if (!CT.interactables || typeof CT.interactables.add !== 'function') { if (ch.loot.length) pendReg = true; return; }
    for (const c of ch.loot) if (!c.io) c.io = CT.interactables.add({ x: c.x, z: c.z, radius: 2.2, label: c.blood ? 'Open Blood Chest' : LABEL[c.kind], onUse: useLoot, disabled: c.opened, c });
  }
  function unregLoot(ch) {
    for (const c of ch.loot) { if (c.io && CT.interactables && CT.interactables.remove) CT.interactables.remove(c.io); c.io = null; c.ch = null; }
    ch.loot.length = 0;
  }
  function rollLoot(c) {
    const out = [], RN = Math.random, t = clamp((1250 - c.z) / 2300, 0, 1) + (c.blood ? 0.3 : 0), rr = (a, b) => a + Math.floor(RN() * (b - a + 1)), k = 1 + t * 2.2;
    let gold = 0;
    const has = id => !!(CT.rpg && typeof CT.rpg.has === 'function' && CT.rpg.has(id));
    const gear = weaponOnly => {
      let id;
      if (t > 0.6 && RN() < (c.blood ? 0.14 : weaponOnly ? 0.08 : 0.04)) id = 'greatsword';
      else {
        const L = t < 0.3 ? ['handaxe', 'dagger', 'furs', 'handaxe'] : t < 0.6 ? ['handaxe', 'dagger', 'steelsword', 'furs', 'mail'] : ['steelsword', 'mace', 'mail', 'steelsword', 'mace', 'dagger'];
        const L2 = weaponOnly ? L.filter(q => C.ITEMS[q].kind === 'weapon') : L; id = L2[(RN() * L2.length) | 0];
      }
      if (has(id) || out.indexOf(id) >= 0) gold += Math.max(10, Math.round((C.ITEMS[id].price || 30) * 0.4)); else out.push(id, 1);
    };
    const potion = p => { if (RN() < p) out.push(t > 0.35 && RN() < 0.45 ? 'bigpotion' : 'potion', 1); };
    switch (c.kind) {
      case 'chest': gold += Math.round(rr(8, 22) * k); potion(0.65); if (c.blood || RN() < 0.3) gear(false); if (c.blood) { gold += Math.round(rr(12, 25) * k); out.push('bigpotion', 1); if (RN() < 0.5) gear(false); } break;
      case 'urn': if (RN() < 0.85) gold += Math.round(rr(2, 9) * k); potion(0.3); break;
      case 'corpse': gold += Math.round(rr(3, 12) * k); potion(0.45); if (RN() < 0.2) gear(false); break;
      case 'rack': gear(true); if (RN() < 0.25) gear(true); break;
      case 'bag': gold += Math.round(rr(4, 14) * k); potion(0.5); if (RN() < 0.12 && !has('furs')) out.push('furs', 1); break;
    }
    if (gold > 0) out.unshift('gold', gold);
    return out;
  }
  function grantItem(id, n) {
    const r = CT.rpg; if (!r) return;
    if (typeof r.grant === 'function') r.grant(id, n);
    else if (typeof r.give === 'function' && r.give(id, n)) CT.bus.emit('loot', { item: id, count: n });
  }
  function openC(c) {
    if (!c || c.opened) return;
    c.opened = true; if (c.io) c.io.disabled = true;
    chestSt[c.id] = 1; lsSet(LS_CHESTS, chestSt);
    const ch = c.ch;
    if (ch) {
      if (c.gi >= 0) setI(ch, 'glint', c.gi, c.x, c.y, c.z, 0, 0, 0, 0);
      if (c.kind === 'urn') setI(ch, 'urn', c.ui, c.x, c.y, c.z, c.ry, 1, 0.4, 1, 0.25, 0);
      if (c.kind === 'rack') setI(ch, 'rackw', c.ui, c.x, c.y, c.z, c.ry, 0, 0, 0);
    }
    if (c.kind === 'chest') anims.push({ c, t: 0 });
    _sv.set(c.x, c.y + 0.6, c.z);
    if (CT.audio && typeof CT.audio.sfx === 'function') { if (c.kind === 'urn') CT.audio.sfx('bone', { pos: _sv }); CT.audio.sfx('loot', { pos: _sv }); }
    if (c.blood) CT.bus.emit('notify', { text: 'The Blood Chest yields its hoard', kind: 'loot' });
    const items = rollLoot(c);
    for (let i = 0; i < items.length; i += 2) grantItem(items[i], items[i + 1]);
    if (!items.length) CT.bus.emit('notify', { text: 'Nothing but dust and old bones', kind: 'info' });
    if (CT.rpg && typeof CT.rpg.save === 'function') CT.rpg.save();
  }
  const GUARDS = { bandit: 3, ghoul: 4, orc: 2, troll: 1 };
  const GTXT = { bandit: 'Bandits guard this stash!', ghoul: 'The dead rise to guard their hoard!', orc: 'Orcs guard this stash!', troll: 'A troll guards this hoard!' };
  function spawnGuards(c) {
    c.guarded = true;
    const Mo = CT.monsters; if (!Mo || typeof Mo.spawn !== 'function') return;
    const n = GUARDS[c.guard] || 2, a0 = Math.random() * TAU;
    for (let i = 0; i < n; i++) { const a = a0 + i / n * TAU, r = 4 + Math.random() * 3; Mo.spawn(c.guard, c.x + Math.sin(a) * r, c.z + Math.cos(a) * r, { rise: c.guard === 'ghoul', yaw: a + Math.PI }); }
    CT.bus.emit('notify', { text: GTXT[c.guard] || 'Guardians stir', kind: 'info' });
  }
  function discoverSite(s) {
    s.found = true; siteSt[s.id] = 1; lsSet(LS_SITES, siteSt);
    CT.bus.emit('notify', { text: 'DISCOVERED: ' + s.name, kind: 'discover' });
    if (CT.audio && typeof CT.audio.sfx === 'function') CT.audio.sfx('discover');
    if (CT.rpg && typeof CT.rpg.addXp === 'function') { CT.rpg.addXp(20); CT.bus.emit('notify', { text: '+20 XP', kind: 'xp' }); }
  }
  function resetSites() {
    siteSt = {}; chestSt = {}; lsSet(LS_SITES, siteSt); lsSet(LS_CHESTS, chestSt);
    for (const s of SITES) s.found = false;
    for (const c of LOOT) { c.opened = false; c.guarded = false; }
    anims.length = 0;
    for (const ch of active) if (LOOTB.has(ch.key)) buildChunk(ch);
  }

  // ── Site meshes, lazily built; shared instanced fires, crows and banners ───
  const SF_CAP = 256, CROW_CAP = 96, FLAG_CAP = 48;
  let sfMesh = null, shMesh = null, crowMesh = null, silMesh = null;
  const sflagMesh = {}, FLAGDEF = { flagV: [2, false], flagHand: [1, false], hangSkull: [0, true] }, _fc = { flagV: 0, flagHand: 0, hangSkull: 0 };
  function buildSite(s) {
    s.built = true;
    const K = kit(), R = CT.rng(s.seed), f0 = fires.length, t0 = performance.now();
    cs = s; cC = Math.cos(s.rot); cSn = Math.sin(s.rot); s.flags = []; s.crows = [];
    try { TYPES[s.type].build(K, R, s); } catch (e) { console.error('[CT.world site ' + s.type + ']', e); }
    cs = null;
    s.fr = fires.slice(f0).filter(f => f.s > 0.01);
    K.f.merge(K.d, IDM);
    const grp = new T.Group();
    if (!K.f.empty) grp.add(new T.Mesh(K.f.geo(), mats.flat2));
    if (!K.g.empty) grp.add(new T.Mesh(K.g.geo(), mats.glow));
    for (const n in K.t) if (!K.t[n].empty) grp.add(new T.Mesh(K.t[n].geo(), mats.tx[n]));
    if (s.xm) grp.add(s.xm);
    grp.position.set(s.x, s.y, s.z); grp.rotation.y = s.rot; grp.updateMatrix(); grp.matrixAutoUpdate = false;
    grp.children.forEach(m => { m.matrixAutoUpdate = false; });
    grp.visible = false; s.vis = false; scene.add(grp); s.grp = grp;
    s.ms = +(performance.now() - t0).toFixed(1);
  }
  function refreshSiteInst() {
    let nf = 0, nc = 0;
    for (const k in _fc) _fc[k] = 0;
    for (const s of SITES) {
      if (!s.vis) continue;
      for (const f of s.fr) {
        if (nf >= SF_CAP) break;
        const t = FIRE_TINT[f.tint];
        _e.set(0, nf, 0); _q.setFromEuler(_e); _p.set(f.x, f.y, f.z); _s.set(f.s, f.s * 1.6, f.s); _m.compose(_p, _q, _s); sfMesh.setMatrixAt(nf, _m);
        sfMesh.setColorAt(nf, _col.setRGB(t[0], t[1], t[2]));
        _p.set(f.x, f.y + f.s * 0.5, f.z); _s.setScalar(f.s * 4.2); _q.identity(); _m.compose(_p, _q, _s); shMesh.setMatrixAt(nf, _m);
        shMesh.setColorAt(nf, _col.setRGB(t[0], t[1] * 0.55, t[2] * 0.3));
        nf++;
      }
      const cr = s.crows;
      for (let i = 0; i < cr.length && nc < CROW_CAP; i += 4) { _e.set(0, cr[i + 3], 0); _q.setFromEuler(_e); _p.set(cr[i], cr[i + 1], cr[i + 2]); _s.setScalar(1.35); _m.compose(_p, _q, _s); crowMesh.setMatrixAt(nc++, _m); }
      const fl = s.flags;
      for (let i = 0; i < fl.length; i += 6) {
        const nm = fl[i], m = sflagMesh[nm]; if (!m || _fc[nm] >= FLAG_CAP) continue;
        _e.set(0, fl[i + 4], 0); _q.setFromEuler(_e); _p.set(fl[i + 1], fl[i + 2], fl[i + 3]); _s.setScalar(fl[i + 5]); _m.compose(_p, _q, _s); m.setMatrixAt(_fc[nm]++, _m);
      }
    }
    for (const m of [sfMesh, shMesh]) { m.count = nf; m.visible = nf > 0; m.instanceMatrix.needsUpdate = true; m.instanceColor.needsUpdate = true; }
    crowMesh.count = nc; crowMesh.visible = nc > 0; crowMesh.instanceMatrix.needsUpdate = true;
    for (const k in sflagMesh) { const m = sflagMesh[k]; m.count = _fc[k]; m.visible = _fc[k] > 0; m.instanceMatrix.needsUpdate = true; }
  }
  function initSiteMeshes() {
    const fg = geoFire(), hg = new T.PlaneGeometry(1, 1);
    sfMesh = new T.InstancedMesh(fg, mats.fire, SF_CAP); shMesh = new T.InstancedMesh(hg, mats.halo, SF_CAP);
    for (const m of [sfMesh, shMesh]) { m.instanceColor = new T.InstancedBufferAttribute(new Float32Array(SF_CAP * 3).fill(1), 3); m.count = 0; m.visible = false; m.frustumCulled = false; m.instanceMatrix.setUsage(T.DynamicDrawUsage); fx.add(m); }
    shMesh.renderOrder = 6;
    crowMesh = new T.InstancedMesh(geoCrow(), crowMat(), CROW_CAP); crowMesh.count = 0; crowMesh.visible = false; crowMesh.frustumCulled = false; scene.add(crowMesh);
    for (const k in FLAGDEF) { const d = FLAGDEF[k], m = new T.InstancedMesh(flagGeo(d[0], d[1]), d[1] ? mats.hang : mats.flag, FLAG_CAP); m.count = 0; m.visible = false; m.frustumCulled = false; scene.add(m); sflagMesh[k] = m; }
    // loot pools (one draw call per kind, only while a fine chunk holds one)
    protos.corpse = corpseB(); protos.hanged = hangedB();
    pool('chest', chestB(false).geo(), mats.flat2, 8, 96);
    pool('bchest', chestB(true).geo(), mats.flat2, 4, 32);
    pool('lid', lidB().geo(), mats.flat2, 10, 128);
    pool('urn', urnB().geo(), mats.flat2, 8, 96);
    pool('rack', rackB().geo(), mats.flat2, 4, 48);
    pool('rackw', rackWB().geo(), mats.flat2, 4, 48);
    pool('corpse', protos.corpse.geo(), mats.flat2, 8, 96);
    pool('bag', bagB().geo(), mats.flat2, 8, 96);
    pool('glint', new T.PlaneGeometry(1, 1), mats.glint, 16, 160);
    pools.glint.m.renderOrder = 6;
    // far silhouettes of the tall sites (drawn with the far LOD, sunk out of sight near the camera)
    const sb = new Batch();
    for (const s of SITES) {
      const t = TYPES[s.type]; if (!t.tall) continue;
      const lz = t.silZ || 0, x = s.x + lz * Math.sin(s.rot), z = s.z + lz * Math.cos(s.rot);
      sb.add(cyl(t.silR * 0.8, t.silR, t.tall, 6), M(x, s.y + t.tall / 2 - 0.5, z), 0x1e1a1e);
      if (s.type === 'mill') for (let k = 0; k < 2; k++) sb.add(BOX, M(x + Math.sin(s.rot) * 2.6, s.y + 8.4, z + Math.cos(s.rot) * 2.6, s.rot, 0.4, 11, 0.3, 0, k * Math.PI / 2 + 0.6), 0x1e1a1e);
      if (s.type === 'lookout') sb.add(cone(3, 2.4, 4), M(x, s.y + t.tall, z, s.rot + Math.PI / 4), 0x1e1a1e);
    }
    if (!sb.empty) { silMesh = new T.Mesh(sb.geo(), mats.sil); silMesh.frustumCulled = false; silMesh.renderOrder = 6; late.add(silMesh); }
  }
  let siteT = 0, siteFirst = true, lastNF = -1, precompiled = false;
  // Compile the site programs once (behind the title screen), so the first crow, chest or waterfall does not stall a frame.
  function precompileSites() {
    precompiled = true;
    const r = core && core.renderer; if (!r || typeof r.compile !== 'function') return;
    const probe = new T.Mesh(new T.PlaneGeometry(1, 1), mats.fall); probe.frustumCulled = false; scene.add(probe);
    const objs = [crowMesh, pools.chest.m, pools.glint.m, silMesh, sfMesh, shMesh].filter(Boolean), vis = objs.map(o => o.visible);
    objs.forEach(o => { o.visible = true; });
    try { r.compile(scene, core.camera); } catch (e) {}
    objs.forEach((o, i) => { o.visible = vis[i]; });
    scene.remove(probe); probe.geometry.dispose();
  }
  function updateSites(dt, c, cam, jump) {
    if (!precompiled) precompileSites();
    for (let i = anims.length - 1; i >= 0; i--) {
      const a = anims[i]; a.t += dt;
      const k = Math.min(1, a.t / 0.6), e = 1 - (1 - k) * (1 - k) * (1 - k), ang = 1.95 * e + Math.sin(k * Math.PI) * 0.18;
      if (a.c.ch && a.c.li >= 0) lidSet(a.c, ang);
      if (k >= 1) { anims[i] = anims[anims.length - 1]; anims.pop(); }
    }
    if (pendReg && CT.interactables && typeof CT.interactables.add === 'function') { pendReg = false; for (const ch of active) if (ch.loot.length) regLoot(ch); }
    if (fallTex) { fallTex.offset.y -= dt * 1.3; if (fallTex.offset.y < -1) fallTex.offset.y += 1; }
    siteT -= dt;
    if (siteT > 0 && !jump && !siteFirst) return;
    siteT = 0.2;
    const all = jump || siteFirst; siteFirst = false;
    const br = (viewR + 60) * (viewR + 60);
    let best = null, bd = br;
    for (const s of SITES) {
      if (s.built) continue;
      const d = (s.x - cam.x) * (s.x - cam.x) + (s.z - cam.z) * (s.z - cam.z);
      if (d < bd) { if (all) buildSite(s); else { bd = d; best = s; } }
    }
    if (best) buildSite(best);
    const vr = (Math.min(viewR, 260) + 25) * (Math.min(viewR, 260) + 25);
    let changed = false;
    for (const s of SITES) {
      if (!s.built) continue;
      const v = (s.x - cam.x) * (s.x - cam.x) + (s.z - cam.z) * (s.z - cam.z) < vr;
      if (v !== s.vis) { s.vis = v; s.grp.visible = v; changed = true; }
    }
    if (changed) refreshSiteInst();
    if (c.state !== 'PLAY') return;
    let nf = 0; for (const p of POIS) if (p.found) nf++;
    if (lastNF > 0 && nf === 0) resetSites();
    lastNF = nf;
    for (const s of SITES) if (!s.found && (s.x - cam.x) * (s.x - cam.x) + (s.z - cam.z) * (s.z - cam.z) < 625) discoverSite(s);
    for (const ch of active) for (const cc of ch.loot) {
      if (cc.opened || !cc.guard || cc.guarded) continue;
      if ((cc.x - cam.x) * (cc.x - cam.x) + (cc.z - cam.z) * (cc.z - cam.z) < 900) spawnGuards(cc);
    }
  }
  let fallTex = null;

  // ── Painted textures (CT.tex from textures.js): terrain splat, props, foliage cut-outs ──
  let FOL = false;
  function ptex(name, aniso) {
    const t = new T.TextureLoader().load(CT.tex[name]);
    t.colorSpace = T.SRGBColorSpace; t.wrapS = t.wrapT = T.RepeatWrapping; t.anisotropy = aniso || 4;
    return t;
  }
  function paintTerrain(mat) {
    const tg = ptex('grass'), tk = ptex('rock'), tr = ptex('road'), tc = ptex('cobble');
    mat.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, { tGrass: { value: tg }, tRock: { value: tk }, tRoad: { value: tr }, tCob: { value: tc } });
      sh.vertexShader = 'attribute vec4 splat;\nvarying vec4 vSplat; varying vec3 vWP; varying vec3 vWN;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        vSplat = splat; vWP = (modelMatrix * vec4(position, 1.0)).xyz; vWN = normal;`);
      sh.fragmentShader = 'uniform sampler2D tGrass, tRock, tRoad, tCob;\nvarying vec4 vSplat; varying vec3 vWP; varying vec3 vWN;\n' + sh.fragmentShader.replace('#include <color_fragment>', `
        vec3 tint = vColor.rgb;
        vec2 wp = vWP.xz;
        vec3 g1 = texture2D(tGrass, wp / 8.0).rgb;
        vec3 g2 = texture2D(tGrass, mat2(0.8, -0.6, 0.6, 0.8) * wp / 27.0 + 0.37).rgb;
        vec3 gm = texture2D(tGrass, wp / 190.0 + 0.11).rgb;
        vec3 grass = mix(g1, g2, 0.38);
        float lum = dot(grass, vec3(0.3, 0.59, 0.11));
        float mac = 0.72 + 0.56 * clamp(dot(gm, vec3(0.3, 0.59, 0.11)) * 3.2, 0.0, 1.0);
        // non-meadow biomes keep their colour and take the brushwork of the grass (luminance only)
        vec3 base = mix(tint * clamp(lum * 3.6, 0.45, 1.6), grass * mac * 0.92, vSplat.z);
        vec3 n = normalize(vWN), bw = pow(abs(n), vec3(4.0)); bw /= bw.x + bw.y + bw.z;
        vec3 rk = texture2D(tRock, vWP.zy / 9.0).rgb * bw.x + texture2D(tRock, wp / 9.0).rgb * bw.y + texture2D(tRock, vWP.xy / 9.0).rgb * bw.z;
        float rockW = 1.0 - smoothstep(0.64, 0.84, n.y + (lum - 0.25) * 0.25);
        base = mix(base, rk * mix(vec3(1.0), clamp(tint * 3.0, 0.4, 1.4), 0.45), rockW);
        vec3 rdc = texture2D(tRoad, mat2(0.8, 0.6, -0.6, 0.8) * wp / 4.0).rgb;
        base = mix(base, mix(rdc, vec3(dot(rdc, vec3(0.3, 0.59, 0.11))), 0.3) * 0.8, vSplat.x * (1.0 - rockW * 0.7));
        base = mix(base, texture2D(tCob, wp / 3.0).rgb, vSplat.y);
        diffuseColor.rgb *= base;`);
    };
    mat.customProgramCacheKey = () => 'ct-paint-terrain';
    return mat;
  }
  // crossed-quad cut-out from the foliage atlas (2x2: 0 oak, 1 pine, 2 bush, 3 birch); both windings, normals up
  function geoCutout(q, w, h, planes) {
    const u0 = (q % 2) * 0.5, u1 = u0 + 0.5, v1 = 1 - Math.floor(q / 2) * 0.5, v0 = v1 - 0.5;
    const P2 = [], UV = [], N = [];
    for (let k = 0; k < planes; k++) {
      const a = k / planes * Math.PI, cx = Math.cos(a) * w / 2, cz = Math.sin(a) * w / 2;
      const A = [-cx, 0, -cz, u0, v0], B = [cx, 0, cz, u1, v0], Cq = [cx, h, cz, u1, v1], D = [-cx, h, -cz, u0, v1];
      for (const tri of [[A, B, Cq], [A, Cq, D], [B, A, D], [B, D, Cq]]) for (const v of tri) { P2.push(v[0], v[1], v[2]); UV.push(v[3], v[4]); N.push(0, 1, 0); }
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(P2, 3)); g.setAttribute('uv', new T.Float32BufferAttribute(UV, 2)); g.setAttribute('normal', new T.Float32BufferAttribute(N, 3));
    return g;
  }
  function initPaint() {
    TX = !!(CT.tex && CT.tex.grass && CT.tex.rock); FOL = !!(TX && CT.tex.foliage);
    mats.tx = {};
    if (!TX) return;
    mats.terrain = paintTerrain(new T.MeshLambertMaterial({ vertexColors: true }));
    const TM = { wall: ['wall'], thatch: ['thatch'], tiles: ['tiles'], planks: ['planks'], bark: ['bark'], rock: ['rock'], stone: ['rock', 0xf2ece0, true] };
    for (const k in TM) mats.tx[k] = new T.MeshLambertMaterial({ map: ptex(TM[k][0]), vertexColors: true, color: TM[k][1] || 0xffffff, side: TM[k][2] ? T.DoubleSide : T.FrontSide });
    mats.tx.stone.color.setRGB(1, 1, 1); // pale weathered stone: the rock brushwork, desaturated and lifted
    mats.tx.stone.onBeforeCompile = sh => { sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\n float sl = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11)); diffuseColor.rgb = vec3(1.5, 1.45, 1.35) * clamp(0.5 + sl * 3.0, 0.35, 1.5);'); };
    mats.tx.stone.customProgramCacheKey = () => 'ct-stone';
    if (FOL) mats.foliage = sway(new T.MeshLambertMaterial({ map: ptex('foliage'), alphaTest: 0.45 }), 0.01, 2.5, 'fol');
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  const protos = {};
  let fx = null, emberPts = null, fireMesh = null, haloMesh = null, smokeMesh = null, road = null, far = null, late = null;
  function loadFound() {
    try { const s = JSON.parse(localStorage.getItem('crimsonThrone.pois') || '{}'); POIS.forEach(p => (p.found = !!s[p.id])); } catch (e) { POIS.forEach(p => (p.found = !!p.found)); }
  }
  function saveFound() {
    try { const s = {}; POIS.forEach(p => { if (p.found) s[p.id] = 1; }); localStorage.setItem('crimsonThrone.pois', JSON.stringify(s)); } catch (e) {}
  }
  function init(c) {
    core = c; scene = c.scene; lowQ = c.quality === 'low';
    viewR = lowQ ? 180 : 300; fineR = lowQ ? 76 : 112; WU.uNearR.value = viewR;
    const t0 = performance.now();
    // far LOD + citadel sort after the sky's storm crown (three sorts by group renderOrder first)
    late = new T.Group(); late.renderOrder = 6; scene.add(late);
    fx = new T.Group(); fx.renderOrder = 7; scene.add(fx); // additive fire, glow and embers draw after everything opaque-looking
    colors(); bake();
    const tBake = performance.now() - t0;
    planSites();
    const tPlan = performance.now() - t0 - tBake;
    loadFound();
    const detail = detailTex();
    mats = {
      terrain: new T.MeshLambertMaterial({ vertexColors: true, map: detail }),
      far: warpify(new T.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4 }), { dip: 10, key: "far", fogMax: 0.58, fade: true }),
      road: new T.MeshLambertMaterial({ map: rutTex(), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      flat: new T.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
      flat2: new T.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: T.DoubleSide }),
      glow: new T.MeshBasicMaterial({ vertexColors: true }),
      cflat: warpify(new T.MeshLambertMaterial({ vertexColors: true, flatShading: true }), { key: "cit", fade: true, ex2: 3.2, base: 226, fogMax: 0.12, fog0: 0.15, fog1: 0.9 }),
      cglow: warpify(new T.MeshBasicMaterial({ vertexColors: true }), { key: "citg", fade: true, ex2: 3.2, base: 226, fogMax: 0.1, fog0: 0.15, fog1: 0.9 }),
      tree: sway(new T.MeshLambertMaterial({ vertexColors: true, flatShading: true }), 0.012, 3, 'tree'),
      bush: sway(new T.MeshLambertMaterial({ vertexColors: true, flatShading: true }), 0.05, 0.2, 'bush'),
      grass: sway(new T.MeshLambertMaterial({ vertexColors: true, side: T.DoubleSide }), 0.22, 0, 'grass'),
      rock: new T.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
      fire: fireMat(),
      halo: haloMat(glowTex()),
      mist: new T.MeshBasicMaterial({ map: fogTex(), color: 0x7a806e, transparent: true, opacity: 0.5, depthWrite: false }),
      smoke: new T.MeshLambertMaterial({ color: 0x3a3634, flatShading: true, transparent: true, opacity: 0.55, depthWrite: false }),
      glint: haloMat(glowTex()),
      sil: warpify(new T.MeshLambertMaterial({ vertexColors: true, flatShading: true }), { dip: 45, key: 'sil', fade: true, fogMax: 0.3, fog0: 0.6, fog1: 1.7 }),
    };
    initPaint();
    fallTex = fallTexture();
    mats.fall = new T.MeshLambertMaterial({ map: fallTex, vertexColors: true, color: 0xc8d8e0, emissive: 0x1a2a32, side: T.DoubleSide });
    // far LOD + citadel draw in the transparent pass (opaque look) so they sit in front of the sky's storm crown
    for (const k of ['far', 'cflat', 'cglow', 'sil']) { mats[k].transparent = true; mats[k].opacity = 1; mats[k].depthWrite = true; }
    const btex = bannerTex();
    mats.flag = flutter(new T.MeshLambertMaterial({ map: btex, side: T.DoubleSide, alphaTest: 0.5 }), false);
    mats.hang = flutter(new T.MeshLambertMaterial({ map: btex, side: T.DoubleSide, alphaTest: 0.5 }), true);
    // prototypes + pools
    protos.dead = geoDead(3, false);
    protos.log = cyl(0.3, 0.3, 1, 6); protos.logTip = cone(0.3, 0.6, 6);
    const K = lowQ ? 0.6 : 1;
    pool('pine', geoPine(false, false), mats.tree, 260, 9000 * K);
    pool('pineL', geoPine(false, true), mats.tree, 260, 16000 * K);
    pool('snowpine', geoPine(true, false), mats.tree, 200, 5000 * K);
    pool('snowpineL', geoPine(true, true), mats.tree, 200, 9000 * K);
    pool('dead', protos.dead, mats.tree, 80, 3000);
    pool('deadL', geoDead(3, true), mats.tree, 80, 5000);
    pool('oak', geoOak(false), mats.tree, 60, 2000);
    pool('oakL', geoOak(true), mats.tree, 60, 4000);
    pool('bush', geoBush(), mats.bush, 70, 7000);
    pool('fern', geoFern(), mats.grass, 70, 2500);
    pool('reed', geoReeds(), mats.grass, 70, 2500);
    pool('grass', geoGrass(), mats.grass, 600, lowQ ? 5000 : 14000);
    pool('rock', geoRock(), mats.rock, 50, 5000);
    pool('boulder', geoBoulder(), mats.rock, 20, 1500);
    pool('crag', geoCrag(), mats.rock, 5, 500);
    pool('stump', geoStump(), mats.rock, 30, 1500);
    if (FOL) {
      pool('fOak', geoCutout(0, 10.5, 10.5, 3), mats.foliage, 60, 5000);
      pool('fBirch', geoCutout(3, 9, 10, 3), mats.foliage, 60, 3000);
      pool('fBush', geoCutout(2, 3.2, 3.2, 2), mats.foliage, 70, 7000);
    }
    const mg = new T.PlaneGeometry(1, 1); mg.rotateX(-Math.PI / 2);
    pool('mist', mg, mats.mist, 4, 300);
    pools.mist.m.renderOrder = 5;
    // POIs
    const t1 = performance.now();
    addPoiMeshes(buildVillage(P.harrowby, { seed: 11, pr: 60, houses: 12 }), P.harrowby.x, P.harrowby.z, 100);
    addPoiMeshes(buildVillage(P.crossing, { seed: 12, pr: 50, houses: 9, gallows: true }), P.crossing.x, P.crossing.z, 80);
    addPoiMeshes(buildShore(P.shore), P.shore.x, P.shore.z, 80);
    addPoiMeshes(buildLodge(P.lodge), P.lodge.x, P.lodge.z, 60);
    addPoiMeshes(buildDen(P.wolfden), P.wolfden.x, P.wolfden.z, 70);
    addPoiMeshes(buildCamp(P.camp), P.camp.x, P.camp.z, 70);
    addPoiMeshes(buildStones(P.stones), P.stones.x, P.stones.z, 60);
    addPoiMeshes(buildFen(P.fen), P.fen.x, P.fen.z, 160);
    addPoiMeshes(buildRuins(P.ruins), P.ruins.x, P.ruins.z, 80);
    addPoiMeshes(buildPass(P.pass), P.pass.x, P.pass.z, 160);
    addPoiMeshes(buildCitadel(P.citadel), P.citadel.x, P.citadel.z, 200, true, true);
    addPoiMeshes(buildRoadDeco(), 0, 0, 1e9, true);
    clearSpots();
    const tPoi = performance.now() - t1;
    // banners
    const fl = { flagV: [2, false], flagHand: [1, false], hangHand: [1, true], hangSkull: [0, true] };
    for (const name in fl) {
      const list = flags.filter(f => f.pool === name); if (!list.length) continue;
      const im = new T.InstancedMesh(flagGeo(fl[name][0], fl[name][1]), fl[name][1] ? mats.hang : mats.flag, list.length);
      list.forEach((f, i) => { _e.set(0, f.ry, 0); _q.setFromEuler(_e); _p.set(f.x, f.y, f.z); _s.set(f.s, f.s, f.s); _m.compose(_p, _q, _s); im.setMatrixAt(i, _m); });
      im.frustumCulled = false; scene.add(im);
    }
    // fires + halos
    const fg = geoFire(), hg = new T.PlaneGeometry(1, 1), vis = fires.filter(f => f.s > 0.01);
    fireMesh = new T.InstancedMesh(fg, mats.fire, vis.length); haloMesh = new T.InstancedMesh(hg, mats.halo, vis.length);
    vis.forEach((f, i) => {
      const t = FIRE_TINT[f.tint];
      _e.set(0, i, 0); _q.setFromEuler(_e); _p.set(f.x, f.y, f.z); _s.set(f.s, f.s * 1.6, f.s); _m.compose(_p, _q, _s); fireMesh.setMatrixAt(i, _m);
      fireMesh.setColorAt(i, _col.setRGB(t[0], t[1], t[2]));
      _p.set(f.x, f.y + f.s * 0.5, f.z); _s.setScalar(f.s * 4.2); _q.identity(); _m.compose(_p, _q, _s); haloMesh.setMatrixAt(i, _m);
      haloMesh.setColorAt(i, _col.setRGB(t[0] * 1.0, t[1] * 0.55, t[2] * 0.3));
    });
    fireMesh.frustumCulled = haloMesh.frustumCulled = false; haloMesh.renderOrder = 6; fireMesh.renderOrder = 7;
    emberPts = new T.Points(emberGeo(), emberMat()); emberPts.frustumCulled = false; emberPts.renderOrder = 7; fx.add(emberPts);
    fx.add(fireMesh); fx.add(haloMesh);
    for (let i = 0; i < 4; i++) { const l = new T.PointLight(0xff8a30, 0, 26, 1.6); l.userData.f = null; scene.add(l); lights.push(l); }
    // chimney smoke
    smokeMesh = new T.InstancedMesh(new T.IcosahedronGeometry(0.6, 0), mats.smoke, 120); smokeMesh.count = 0; smokeMesh.frustumCulled = false; smokeMesh.instanceMatrix.setUsage(T.DynamicDrawUsage); scene.add(smokeMesh);
    initSiteMeshes();
    // road, far LOD, sea
    road = roadMesh(); scene.add(road);
    if (TX) road.visible = false; // the painted road is splatted into the terrain
    far = farMesh(); late.add(far);
    sea = seaMesh(); scene.add(sea);
    // chunks
    idxFine = gridIndex(NF); idxCoarse = gridIndex(NCs);
    const t2 = performance.now();
    stream(1e6);
    CT.world.stats = { bake: Math.round(tBake), plan: Math.round(tPlan), poi: Math.round(tPoi), chunks: Math.round(performance.now() - t2), total: Math.round(performance.now() - t0) };
    lastCam.copy(core.camera.position);
  }

  // ── Update ─────────────────────────────────────────────────────────────────
  const lastCam = new T.Vector3();
  let poiT = 0, lightT = 0, sitesBroken = false;
  const near4 = [null, null, null, null], nearD = [0, 0, 0, 0], nearE = [], nearED = [], _v2e = new T.Vector2();
  function update(dt, c) {
    core = c; U.time.value += dt;
    const cam = c.camera.position;
    WU.uKeep.value = sstep(-350, -450, cam.z); // within ~500 m of the citadel region: keep the real mountain + fortress
    const jump = cam.distanceTo(lastCam) > 120; lastCam.copy(cam);
    stream(jump ? 60 : 3.5);
    sea.position.set(cam.x, 0, cam.z); sea.updateMatrixWorld();
    for (const q of poiMeshes) q.grp.visible = q.always || Math.hypot(q.x - cam.x, q.z - cam.z) < viewR + q.r + 60;
    // lights: nearest fires
    lightT -= dt;
    if (lightT <= 0) {
      lightT = 0.25;
      for (let k = 0; k < 4; k++) { near4[k] = null; nearD[k] = 45 * 45; }
      for (const f of fires) {
        if (!f.light) continue;
        const d = (f.x - cam.x) * (f.x - cam.x) + (f.z - cam.z) * (f.z - cam.z);
        for (let k = 0; k < 4; k++) if (d < nearD[k]) { for (let m = 3; m > k; m--) { nearD[m] = nearD[m - 1]; near4[m] = near4[m - 1]; } nearD[k] = d; near4[k] = f; break; }
      }
      // embers follow the nearest big fires in view range
      let ne = 0;
      for (let k = 0; k < EMB_N; k++) { nearE[k] = null; nearED[k] = 80 * 80; }
      for (const f of fires) {
        if (f.s < 0.3) continue;
        const d = (f.x - cam.x) * (f.x - cam.x) + (f.z - cam.z) * (f.z - cam.z);
        for (let k = 0; k < EMB_N; k++) if (d < nearED[k]) { for (let m = EMB_N - 1; m > k; m--) { nearED[m] = nearED[m - 1]; nearE[m] = nearE[m - 1]; } nearED[k] = d; nearE[k] = f; break; }
      }
      for (let k = 0; k < EMB_N; k++) { const f = nearE[k]; if (!f) continue; const t = FIRE_TINT[f.tint]; embF[ne].set(f.x, f.y + f.s * 0.15, f.z, f.s); embC[ne].set(t[0], t[1], t[2]); ne++; }
      if (emberPts) { emberPts.material.uniforms.uN.value = ne; c.renderer.getDrawingBufferSize(_v2e); emberPts.material.uniforms.uH.value = _v2e.y; }
      for (let k = 0; k < 4; k++) { const l = lights[k], f = near4[k]; l.userData.f = f; if (f) { l.position.set(f.x, f.y + 0.9, f.z); l.color.copy(LCOL[f.tint]); } }
    }
    const t = U.time.value;
    for (let k = 0; k < 4; k++) {
      const l = lights[k], f = l.userData.f;
      l.intensity = f ? (f.tint === 3 ? 10 : 26) * (0.8 + 0.12 * Math.sin(t * 13 + k) + 0.08 * Math.sin(t * 29 + k * 2)) : 0;
    }
    // chimney smoke puffs
    let n = 0;
    for (const s of smokes) {
      if (Math.abs(s[0] - cam.x) > 170 || Math.abs(s[2] - cam.z) > 170) continue;
      for (let j = 0; j < 5 && n < 120; j++) {
        const u = (t * 0.18 + s[3] + j * 0.2) % 1, sc = (0.35 + u * 1.3) * (u < 0.7 ? 1 : (1 - u) * 3.3);
        _p.set(s[0] + u * 2.2 + Math.sin(u * 6 + j) * 0.3, s[1] + u * 5, s[2] - u * 1.2); _e.set(u * 2, j, 0); _q.setFromEuler(_e); _s.setScalar(sc);
        _m.compose(_p, _q, _s); smokeMesh.setMatrixAt(n++, _m);
      }
    }
    smokeMesh.count = n; smokeMesh.instanceMatrix.needsUpdate = true;
    if (!sitesBroken) { try { updateSites(dt, c, cam, jump); } catch (e) { sitesBroken = true; console.error('[CT.world.sites]', e); } }
    // discovery
    poiT -= dt;
    if (poiT <= 0 && c.state === 'PLAY') {
      poiT = 0.25;
      for (const p of POIS) {
        if (p.found) continue;
        if ((p.x - cam.x) * (p.x - cam.x) + (p.z - cam.z) * (p.z - cam.z) < p.radius * p.radius) { p.found = true; saveFound(); CT.bus.emit('poi', { id: p.id, name: p.name }); }
      }
    }
  }

  // ── Collision + queries ────────────────────────────────────────────────────
  function pushCircle(pos, rad, x, z, r) {
    const dx = pos.x - x, dz = pos.z - z, d2 = dx * dx + dz * dz, rr = r + rad;
    if (d2 >= rr * rr) return;
    if (d2 < 1e-8) { pos.x += rr; return; }
    const d = Math.sqrt(d2), k = (rr - d) / d; pos.x += dx * k; pos.z += dz * k;
  }
  function pushBox(pos, rad, o) {
    const dx = pos.x - o.x, dz = pos.z - o.z, lx = dx * o.c - dz * o.s, lz = dx * o.s + dz * o.c;
    const qx = clamp(lx, -o.hw, o.hw), qz = clamp(lz, -o.hd, o.hd), ex = lx - qx, ez = lz - qz, d2 = ex * ex + ez * ez;
    if (d2 >= rad * rad) return;
    let nx, nz;
    if (d2 > 1e-8) { const d = Math.sqrt(d2), k = (rad - d) / d; nx = lx + ex * k; nz = lz + ez * k; }
    else if (o.hw - Math.abs(lx) < o.hd - Math.abs(lz)) { nx = (lx < 0 ? -1 : 1) * (o.hw + rad); nz = lz; }
    else { nz = (lz < 0 ? -1 : 1) * (o.hd + rad); nx = lx; }
    pos.x = o.x + nx * o.c + nz * o.s; pos.z = o.z - nx * o.s + nz * o.c;
  }
  function chunkCols(x, z, fn) {
    const cx = Math.floor(x / CH), cz = Math.floor(z / CH), fx = x - cx * CH, fz = z - cz * CH;
    const ax = fx < 8 ? -1 : fx > 56 ? 1 : 0, az = fz < 8 ? -1 : fz > 56 ? 1 : 0;
    for (let a = 0; a < 4; a++) {
      const ox = a & 1 ? ax : 0, oz = a & 2 ? az : 0;
      if ((a & 1 && !ax) || (a & 2 && !az)) continue;
      const ch = chunks.get(ckey(cx + ox, cz + oz)); if (!ch || !ch.nc) continue;
      const i = Math.floor((x - (ch.cx * CH - 8)) / 8), j = Math.floor((z - (ch.cz * CH - 8)) / 8);
      if (i < 0 || i > 9 || j < 0 || j > 9) continue;
      const cell = ch.cells[j * 10 + i];
      for (let k = 0; k < cell.length; k++) if (fn(ch, cell[k])) return true;
    }
    return false;
  }
  let _cp = null, _cr = 0;
  const colFn = (ch, i) => { if (_cp.y < ch.cT[i]) pushCircle(_cp, _cr, ch.cX[i], ch.cZ[i], ch.cR[i]); return false; };
  function collide(pos, radius) {
    const r = radius || 0.4;
    const a = SH.get(skey(Math.floor(pos.x / 8), Math.floor(pos.z / 8)));
    if (a) for (let i = 0; i < a.length; i++) { const o = a[i]; if (pos.y > o.top) continue; if (o.t) pushBox(pos, r, o); else pushCircle(pos, r, o.x, o.z, o.r); }
    _cp = pos; _cr = r; chunkCols(pos.x, pos.z, colFn);
    const k = Math.max(0.15, 10 * ((core && core.dt) || 0.016));
    const n = normalAt(pos.x, pos.z);
    if (n.y < 0.64) { const hl = Math.hypot(n.x, n.z) || 1; pos.x += n.x / hl * k; pos.z += n.z / hl * k; }
    if (heightAt(pos.x, pos.z) < -1.7) { const m = normalAt(pos.x, pos.z), hl = Math.hypot(m.x, m.z) || 1; pos.x -= m.x / hl * k; pos.z -= m.z / hl * k; }
    const B = C.ISLAND - 20;
    pos.x = clamp(pos.x, -B, B); pos.z = clamp(pos.z, -B, B);
    return pos;
  }
  const RC = { point: new T.Vector3(), dist: 0 };
  let _hx = 0, _hy = 0, _hz = 0;
  const hitFn = (ch, i) => { const dx = _hx - ch.cX[i], dz = _hz - ch.cZ[i]; return _hy < ch.cT[i] && dx * dx + dz * dz < ch.cR[i] * ch.cR[i]; };
  function propHit(x, y, z) {
    const a = SH.get(skey(Math.floor(x / 8), Math.floor(z / 8)));
    if (a) for (let i = 0; i < a.length; i++) {
      const o = a[i]; if (y > o.top) continue;
      if (o.t ? inBox(o, x, z) : (x - o.x) * (x - o.x) + (z - o.z) * (z - o.z) < o.r * o.r) return true;
    }
    _hx = x; _hy = y; _hz = z;
    return chunkCols(x, z, hitFn);
  }
  function raycast(o, d, maxDist) {
    let t = 0, pt = 0, step = 0.5;
    const md = maxDist || 100;
    while (t <= md) {
      const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
      if (y < heightAt(x, z)) {
        let a = pt, b = t;
        for (let i = 0; i < 6; i++) { const m = (a + b) / 2; if (o.y + d.y * m < heightAt(o.x + d.x * m, o.z + d.z * m)) b = m; else a = m; }
        RC.dist = b; RC.point.set(o.x + d.x * b, o.y + d.y * b, o.z + d.z * b); return RC;
      }
      if (t > 0 && propHit(x, y, z)) { RC.dist = t; RC.point.set(x, y, z); return RC; }
      pt = t; t += step; step = Math.min(2, 0.5 + t * 0.02);
    }
    return null;
  }
  function biomeAt(x, z) {
    if (Math.hypot(x, z + 1250) < 260) return 'citadel';
    const h = heightAt(x, z);
    if ((Math.abs(x) > 900 || Math.abs(z) > 900) && h < 6 && coastC(x, z) < 80 && cliffK(x, z) < 0.6) return 'coast';
    weights(x, z, W);
    let best = 'hills', bw = W.hills;
    for (const k of ['meadow', 'forest', 'swamp', 'snow']) if (W[k] > bw) { bw = W[k]; best = k; }
    return best;
  }
  function interiorAt(x, z) { for (const o of interiors) if (inBox(o, x, z)) return true; return false; }

  CT.world = {
    init, update, heightAt, normalAt, biomeAt, waterAt, collide, raycast, interiorAt, resetSites,
    pois: POIS, spots, roads,
    sites: SITES,   // [{id, name, x, z, type, biome, found}]: minor landmarks for the map UI (found = discovered)
    loot: LOOT,     // [{id, kind, x, z, opened, guard, blood}]: every loot container on the isle
    siteInfo() {
      const by = {}, kinds = {}; let reg = 0, blood = 0, guarded = 0;
      SITES.forEach(s => { by[s.biome] = (by[s.biome] || 0) + 1; });
      LOOT.forEach(c => { kinds[c.kind] = (kinds[c.kind] || 0) + 1; if (c.io) reg++; if (c.blood) blood++; if (c.guard) guarded++; });
      let calls = 0;
      SITES.forEach(s => { if (s.vis) calls += s.grp.children.length; });
      [sfMesh, shMesh, crowMesh, silMesh, ...Object.values(sflagMesh)].forEach(m => { if (m && m.visible) calls++; });
      ['chest', 'bchest', 'lid', 'urn', 'rack', 'rackw', 'corpse', 'bag', 'glint'].forEach(k => { if (pools[k] && pools[k].m.visible) calls++; });
      return { calls, sites: SITES.length, byBiome: by, built: SITES.filter(s => s.built).length, visible: SITES.filter(s => s.vis).length, found: SITES.filter(s => s.found).length, loot: LOOT.length, kinds, blood, guarded, registered: reg, opened: LOOT.filter(c => c.opened).length };
    },
    _dbg: () => ({ hg: (x, z) => samp(HG, x, z), fl: (x, z) => samp(FL, x, z), seaTex, mats, far, sea, road, fireMesh, haloMesh, smokeMesh, poiMeshes, pools, fires, flags, active, late, silMesh }),
    spotCheck() { const bad = []; for (const id in spots) for (const sp of spots[id]) if (blocked(sp.x, sp.z, 1.5)) bad.push(id + ':' + sp.tag); return bad; },
    info() { return { chunks: active.length, calls: core.renderer.info.render.calls, tris: core.renderer.info.render.triangles, stats: CT.world.stats, pools: poolNames.map(n => n + ':' + pools[n].m.count).join(' ') }; },
  };
})();
