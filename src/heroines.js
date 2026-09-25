// ─── HEROINES: SDF-sculpted Frazetta heroines (Kaela, Nyx, Vesna) ────────────
// Each body is one smooth mesh polygonised (Surface Nets) from a posed signed
// distance field. Clothing is an SDF offset shell + a crisp colour mask.
// CT.heroines.build(id) -> THREE.Group (feet at y=0, facing +Z), userData.update(dt,t).
(function () {
  'use strict';
  const T = THREE, PI = Math.PI;
  const CT = window.CT = window.CT || {};

  // ── small vector / matrix helpers (plain arrays, 3x3 row-major) ───────────
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = a => Math.hypot(a[0], a[1], a[2]);
  const nrm = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  function mv(M, v) { return [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[3] * v[0] + M[4] * v[1] + M[5] * v[2], M[6] * v[0] + M[7] * v[1] + M[8] * v[2]]; }
  function mm(A, B) { const C = new Array(9); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j]; return C; }
  const tr = M => [M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]];
  function rx(a) { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, -s, 0, s, c]; }
  function ry(a) { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 1, 0, -s, 0, c]; }
  function rz(a) { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, s, c, 0, 0, 0, 1]; }
  const eul = (y, p, r) => mm(ry(y || 0), mm(rx(p || 0), rz(r || 0)));
  const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  function basisY(y, zh) { y = nrm(y); let x = cross(y, zh); if (len(x) < 1e-6) x = cross(y, [1, 0, 0]); x = nrm(x); const z = cross(x, y); return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]]; }
  const W = (fr, l) => add(fr.o, mv(fr.R, l));           // frame-local point -> world
  const WD = (fr, l) => mv(fr.R, l);                      // frame-local direction -> world
  function toL(fr, x, y, z) { const R = fr.R, dx = x - fr.o[0], dy = y - fr.o[1], dz = z - fr.o[2]; return [R[0] * dx + R[3] * dy + R[6] * dz, R[1] * dx + R[4] * dy + R[7] * dz, R[2] * dx + R[5] * dy + R[8] * dz]; }
  function ik(a, c, l1, l2, pole) {
    let d = sub(c, a), dl = len(d); const mx = (l1 + l2) * 0.999; if (dl > mx) dl = mx; d = nrm(d);
    const x = (l1 * l1 - l2 * l2 + dl * dl) / (2 * dl), h = Math.sqrt(Math.max(l1 * l1 - x * x, 0));
    const pd = nrm(sub(pole, scl(d, dot(pole, d))));
    return { mid: add(add(a, scl(d, x)), scl(pd, h)), end: add(a, scl(d, dl)) };
  }
  function hx(h) { const c = new T.Color(h); return [c.r, c.g, c.b]; } // sRGB hex -> linear
  const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  function hash3(x, y, z) { let h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return h - Math.floor(h); }

  // ── SDF field: primitives in groups, limb groups blend into the torso ─────
  function smin(a, b, k) { if (k <= 0) return a < b ? a : b; const h = Math.max(k - Math.abs(a - b), 0) / k; return (a < b ? a : b) - h * h * k * 0.25; }
  function Field(ng, limbK) {
    this.ng = ng; this.lk = limbK || []; this.prims = []; this.masks = []; this.joins = [];
    this.gv = new Float64Array(ng); this.jv = new Float64Array(16); this.maxOff = 0;
  }
  Field.prototype.ell = function (g, fr, c, r, k, o) {
    o = o || {}; const R = o.rot ? mm(fr.R, o.rot) : fr.R, cw = W(fr, c), m = tr(R), mr = Math.max(r[0], r[1], r[2]);
    const P = { t: 0, cx: cw[0], cy: cw[1], cz: cw[2], m, rx: r[0], ry: r[1], rz: r[2], k: k || 0, g, j: o.j === undefined ? -1 : o.j, sub: !!o.sub, bb: [cw[0] - mr, cw[1] - mr, cw[2] - mr, cw[0] + mr, cw[1] + mr, cw[2] + mr] };
    this.prims.push(P); return P;
  };
  Field.prototype.cone = function (g, a, b, ra, rb, k, o) { // round cone a(ra) -> b(rb), world points
    o = o || {}; const ax = sub(b, a), h = len(ax), R = basisY(ax, o.zh || [0, 0, 1]), m = tr(R);
    const sx = o.sx || 1, sz = o.sz || 1, bq = (ra - rb) / h, aq = Math.sqrt(Math.max(1 - bq * bq, 1e-4)), mr = Math.max(ra, rb) * Math.max(sx, sz);
    const P = { t: 1, cx: a[0], cy: a[1], cz: a[2], m, r1: ra, r2: rb, h, a: aq, b: bq, sx, sz, sm: Math.min(sx, sz), k: k || 0, g, j: o.j === undefined ? -1 : o.j, sub: !!o.sub,
      bb: [Math.min(a[0], b[0]) - mr, Math.min(a[1], b[1]) - mr, Math.min(a[2], b[2]) - mr, Math.max(a[0], b[0]) + mr, Math.max(a[1], b[1]) + mr, Math.max(a[2], b[2]) + mr] };
    this.prims.push(P); return P;
  };
  Field.prototype.join = function (slot, g, k) { this.joins[slot] = { g, k }; };
  Field.prototype.mask = function (gm, fn, th, o) { // colour + relief mask; fn(x,y,z) > 0 inside
    o = o || {}; const M = { gm, fn, th, rp: o.rp || 0.004, col: o.col, pid: o.pid || 0, gloss: o.gloss || 0, pri: o.pri || 0 };
    this.masks.push(M); this.maxOff = Math.max(this.maxOff, th); return M;
  };
  function primD(P, x, y, z) {
    const dx = x - P.cx, dy = y - P.cy, dz = z - P.cz, m = P.m;
    let lx = m[0] * dx + m[1] * dy + m[2] * dz, ly = m[3] * dx + m[4] * dy + m[5] * dz, lz = m[6] * dx + m[7] * dy + m[8] * dz;
    if (P.t === 0) {
      const ax = lx / P.rx, ay = ly / P.ry, az = lz / P.rz, k0 = Math.sqrt(ax * ax + ay * ay + az * az);
      const bx = ax / P.rx, by = ay / P.ry, bz = az / P.rz, k1 = Math.sqrt(bx * bx + by * by + bz * bz);
      return k1 > 1e-9 ? k0 * (k0 - 1) / k1 : -Math.min(P.rx, P.ry, P.rz);
    }
    lx /= P.sx; lz /= P.sz;
    const qx = Math.sqrt(lx * lx + lz * lz), qy = ly, k = -P.b * qx + P.a * qy;
    let d;
    if (k < 0) d = Math.sqrt(qx * qx + qy * qy) - P.r1;
    else if (k > P.a * P.h) { const ey = qy - P.h; d = Math.sqrt(qx * qx + ey * ey) - P.r2; }
    else d = qx * P.a + qy * P.b - P.r1;
    return d * P.sm;
  }
  function bbDist(bb, x, y, z) {
    const dx = Math.max(bb[0] - x, 0, x - bb[3]), dy = Math.max(bb[1] - y, 0, y - bb[4]), dz = Math.max(bb[2] - z, 0, z - bb[5]);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  Field.prototype.near = function (x, y, z, r) {
    const L = [], S = [], M = [], lim = r + this.maxOff + 0.01;
    for (const P of this.prims) if (bbDist(P.bb, x, y, z) < lim + P.k) (P.sub ? S : L).push(P);
    if (r < 0.5 || this.masks.length < 40) for (const K of this.masks) if (K.fn(x, y, z) > -(r + 0.03)) M.push(K);
    return { L, S, M };
  };
  Field.prototype.all = function () { return { L: this.prims.filter(p => !p.sub), S: this.prims.filter(p => p.sub), M: this.masks }; };
  Field.prototype.eval = function (x, y, z, nl) {
    const g = this.gv, jv = this.jv, ng = this.ng, L = nl.L, S = nl.S;
    for (let i = 0; i < ng; i++) g[i] = 1e9;
    for (let i = 0; i < this.joins.length; i++) jv[i] = 1e9;
    for (let i = 0; i < L.length; i++) {
      const P = L[i], d = primD(P, x, y, z);
      if (P.j >= 0) { if (d < jv[P.j]) jv[P.j] = d; } else g[P.g] = smin(g[P.g], d, P.k);
    }
    for (let i = 0; i < this.joins.length; i++) { const J = this.joins[i]; if (jv[i] < 1e8) g[J.g] = smin(g[J.g], jv[i], J.k); }
    for (let i = 0; i < S.length; i++) { const P = S[i], d = primD(P, x, y, z); g[P.g] = -smin(-g[P.g], d, P.k); }
    const MS = nl.M;
    if (MS.length) for (let gi = 0; gi < ng; gi++) {
      if (g[gi] > 0.03) continue;
      let off = 0; const bit = 1 << gi;
      for (const M of MS) {
        if (!(M.gm & bit)) continue;
        const sd = M.fn(x, y, z), o = M.th * sstep(-M.rp, M.rp, sd);
        if (M.th > 0 ? o > off : o < off && off <= 0) off = o;
      }
      g[gi] -= off;
    }
    const t = g[0]; let res = t;
    for (let i = 1; i < ng; i++) if (g[i] < 1e8) { const v = smin(t, g[i], this.lk[i] || 0); if (v < res) res = v; }
    return res;
  };
  Field.prototype.bounds = function (pad) {
    const b = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9];
    for (const P of this.prims) if (!P.sub) for (let i = 0; i < 3; i++) { b[i] = Math.min(b[i], P.bb[i]); b[i + 3] = Math.max(b[i + 3], P.bb[i + 3]); }
    for (let i = 0; i < 3; i++) { b[i] -= pad; b[i + 3] += pad; }
    return b;
  };
  // Point query with its own culled list (cloth collision, etc.)
  Field.prototype.at = function (x, y, z) {
    const c = this._atC;
    if (!c || Math.abs(x - c[0]) > 0.025 || Math.abs(y - c[1]) > 0.025 || Math.abs(z - c[2]) > 0.025) { this._atC = [x, y, z]; this._atL = this.near(x, y, z, 0.075); }
    return this.eval(x, y, z, this._atL);
  };
  Field.prototype.grad = function (x, y, z, nl, e) {
    e = e || 0.002; nl = nl || this.near(x, y, z, 0.06);
    const a = this.eval(x + e, y - e, z - e, nl), b = this.eval(x - e, y - e, z + e, nl), c = this.eval(x - e, y + e, z - e, nl), d = this.eval(x + e, y + e, z + e, nl);
    return nrm([a - b - c + d, -a - b + c + d, -a + b - c + d]);
  };

  // ── Surface Nets polygoniser with a narrow band, smoothing and projection ─
  const CORN = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const EDGES = []; for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) { const d = (a ^ b); if (d === 1 || d === 2 || d === 4) EDGES.push([a, b]); }
  function polygonize(F, bnd, h, smoothIt) {
    const x0 = bnd[0], y0 = bnd[1], z0 = bnd[2];
    const nx = Math.ceil((bnd[3] - x0) / h) + 1, ny = Math.ceil((bnd[4] - y0) / h) + 1, nz = Math.ceil((bnd[5] - z0) / h) + 1;
    const B = 4, nbx = Math.ceil((nx - 1) / B), nby = Math.ceil((ny - 1) / B), nbz = Math.ceil((nz - 1) / B);
    const val = new Float32Array(nx * ny * nz), nxy = nx * ny;
    const lists = new Array(nbx * nby * nbz), rad = B * h * 0.8660254;
    const near = [];
    for (let bk = 0; bk < nbz; bk++) for (let bj = 0; bj < nby; bj++) for (let bi = 0; bi < nbx; bi++) {
      const cx = x0 + (bi * B + B / 2) * h, cy = y0 + (bj * B + B / 2) * h, cz = z0 + (bk * B + B / 2) * h;
      const nl = F.near(cx, cy, cz, rad + h);
      const d = nl.L.length ? F.eval(cx, cy, cz, nl) : 1;
      const bid = bi + nbx * (bj + nby * bk);
      if (Math.abs(d) > rad * 1.35 + h) {
        const i1 = Math.min(bi * B + B, nx - 1), j1 = Math.min(bj * B + B, ny - 1), k1 = Math.min(bk * B + B, nz - 1);
        for (let k = bk * B; k <= k1; k++) for (let j = bj * B; j <= j1; j++) for (let i = bi * B; i <= i1; i++) val[i + nx * j + nxy * k] = d;
      } else { lists[bid] = nl; near.push(bid); }
    }
    // second level: 2x2x2-cell sub-blocks inside each near block
    const done = new Uint8Array(nx * ny * nz), exact = [], srad = h * 1.7320508 * 1.5 + h * 0.3;
    for (const bid of near) {
      const bi = bid % nbx, bj = Math.floor(bid / nbx) % nby, bk = Math.floor(bid / (nbx * nby)), nl = lists[bid];
      for (let sk = 0; sk < B; sk += 2) for (let sj = 0; sj < B; sj += 2) for (let si = 0; si < B; si += 2) {
        const i0 = bi * B + si, j0 = bj * B + sj, k0 = bk * B + sk; if (i0 >= nx - 1 || j0 >= ny - 1 || k0 >= nz - 1) continue;
        const d = F.eval(x0 + (i0 + 1) * h, y0 + (j0 + 1) * h, z0 + (k0 + 1) * h, nl);
        if (Math.abs(d) > srad) {
          const i1 = Math.min(i0 + 2, nx - 1), j1 = Math.min(j0 + 2, ny - 1), k1 = Math.min(k0 + 2, nz - 1);
          for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const n = i + nx * j + nxy * k; if (!done[n]) val[n] = d; }
        } else exact.push(i0, j0, k0, bid);
      }
    }
    for (let e = 0; e < exact.length; e += 4) {
      const i0 = exact[e], j0 = exact[e + 1], k0 = exact[e + 2], nl = lists[exact[e + 3]];
      const i1 = Math.min(i0 + 2, nx - 1), j1 = Math.min(j0 + 2, ny - 1), k1 = Math.min(k0 + 2, nz - 1);
      for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const n = i + nx * j + nxy * k; if (done[n]) continue; done[n] = 1;
        val[n] = F.eval(x0 + i * h, y0 + j * h, z0 + k * h, nl);
      }
    }
    // vertices
    const cnx = nx - 1, cny = ny - 1, cellV = new Int32Array(cnx * cny * (nz - 1)).fill(-1);
    const P = [], VB = [], cv = new Float64Array(8);
    for (const bid of near) {
      const bi = bid % nbx, bj = Math.floor(bid / nbx) % nby, bk = Math.floor(bid / (nbx * nby));
      const i1 = Math.min(bi * B + B, nx - 1), j1 = Math.min(bj * B + B, ny - 1), k1 = Math.min(bk * B + B, nz - 1);
      for (let k = bk * B; k < k1; k++) for (let j = bj * B; j < j1; j++) for (let i = bi * B; i < i1; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) { const C = CORN[c]; const v = cv[c] = val[(i + C[0]) + nx * (j + C[1]) + nxy * (k + C[2])]; if (v < 0) mask |= 1 << c; }
        if (mask === 0 || mask === 255) continue;
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (const [a, b] of EDGES) {
          const va = cv[a], vb = cv[b]; if ((va < 0) === (vb < 0)) continue;
          const t = va / (va - vb), A = CORN[a], Bc = CORN[b];
          sx += A[0] + (Bc[0] - A[0]) * t; sy += A[1] + (Bc[1] - A[1]) * t; sz += A[2] + (Bc[2] - A[2]) * t; n++;
        }
        cellV[i + cnx * (j + cny * k)] = P.length / 3;
        P.push(x0 + (i + sx / n) * h, y0 + (j + sy / n) * h, z0 + (k + sz / n) * h); VB.push(bid);
      }
    }
    // quads
    const Q = [];
    const cid = (i, j, k) => cellV[i + cnx * (j + cny * k)];
    for (const bid of near) {
      const bi = bid % nbx, bj = Math.floor(bid / nbx) % nby, bk = Math.floor(bid / (nbx * nby));
      const i1 = Math.min(bi * B + B, nx - 1), j1 = Math.min(bj * B + B, ny - 1), k1 = Math.min(bk * B + B, nz - 1);
      for (let k = Math.max(bk * B, 1); k < k1; k++) for (let j = Math.max(bj * B, 1); j < j1; j++) for (let i = Math.max(bi * B, 1); i < i1; i++) {
        const v0 = val[i + nx * j + nxy * k], in0 = v0 < 0;
        if (in0 !== (val[i + 1 + nx * j + nxy * k] < 0)) { const q = [cid(i, j, k), cid(i, j - 1, k), cid(i, j - 1, k - 1), cid(i, j, k - 1)]; if (q.every(v => v >= 0)) Q.push(in0 ? q : q.reverse()); }
        if (in0 !== (val[i + nx * (j + 1) + nxy * k] < 0)) { const q = [cid(i, j, k), cid(i, j, k - 1), cid(i - 1, j, k - 1), cid(i - 1, j, k)]; if (q.every(v => v >= 0)) Q.push(in0 ? q : q.reverse()); }
        if (in0 !== (val[i + nx * j + nxy * (k + 1)] < 0)) { const q = [cid(i, j, k), cid(i - 1, j, k), cid(i - 1, j - 1, k), cid(i, j - 1, k)]; if (q.every(v => v >= 0)) Q.push(in0 ? q : q.reverse()); }
      }
    }
    const nv = P.length / 3, pos = new Float32Array(P);
    // Laplacian smoothing
    const nb = Array.from({ length: nv }, () => []);
    const link = (a, b) => { if (!nb[a].includes(b)) nb[a].push(b); if (!nb[b].includes(a)) nb[b].push(a); };
    for (const q of Q) { link(q[0], q[1]); link(q[1], q[2]); link(q[2], q[3]); link(q[3], q[0]); }
    const tmp = new Float32Array(pos.length);
    for (let it = 0; it < (smoothIt === undefined ? 2 : smoothIt); it++) {
      for (let v = 0; v < nv; v++) {
        const L = nb[v]; if (!L.length) { tmp[v * 3] = pos[v * 3]; tmp[v * 3 + 1] = pos[v * 3 + 1]; tmp[v * 3 + 2] = pos[v * 3 + 2]; continue; }
        let ax = 0, ay = 0, az = 0; for (const u of L) { ax += pos[u * 3]; ay += pos[u * 3 + 1]; az += pos[u * 3 + 2]; }
        const n = L.length;
        tmp[v * 3] = pos[v * 3] * 0.5 + ax / n * 0.5; tmp[v * 3 + 1] = pos[v * 3 + 1] * 0.5 + ay / n * 0.5; tmp[v * 3 + 2] = pos[v * 3 + 2] * 0.5 + az / n * 0.5;
      }
      pos.set(tmp);
    }
    // project back onto the surface, normals from the field gradient
    const nor = new Float32Array(pos.length), e = h * 0.35;
    for (let v = 0; v < nv; v++) {
      const nl = lists[VB[v]]; let x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      const a = F.eval(x + e, y - e, z - e, nl), b = F.eval(x - e, y - e, z + e, nl), c = F.eval(x - e, y + e, z - e, nl), dd = F.eval(x + e, y + e, z + e, nl);
      const g = nrm([a - b - c + dd, -a - b + c + dd, -a + b - c + dd]), d = (a + b + c + dd) * 0.25;
      const s = clamp(d, -h, h); x -= g[0] * s; y -= g[1] * s; z -= g[2] * s;
      pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z; nor[v * 3] = g[0]; nor[v * 3 + 1] = g[1]; nor[v * 3 + 2] = g[2];
    }
    // triangles (shorter diagonal), wound to agree with the field normal
    const idx = new Uint32Array(Q.length * 6); let ti = 0;
    const d2 = (a, b) => { const dx = pos[a * 3] - pos[b * 3], dy = pos[a * 3 + 1] - pos[b * 3 + 1], dz = pos[a * 3 + 2] - pos[b * 3 + 2]; return dx * dx + dy * dy + dz * dz; };
    const emit = (a, b, c) => {
      const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
      const wx = pos[c * 3] - pos[a * 3], wy = pos[c * 3 + 1] - pos[a * 3 + 1], wz = pos[c * 3 + 2] - pos[a * 3 + 2];
      const fx = uy * wz - uz * wy, fy = uz * wx - ux * wz, fz = ux * wy - uy * wx;
      const s = fx * (nor[a * 3] + nor[b * 3] + nor[c * 3]) + fy * (nor[a * 3 + 1] + nor[b * 3 + 1] + nor[c * 3 + 1]) + fz * (nor[a * 3 + 2] + nor[b * 3 + 2] + nor[c * 3 + 2]);
      if (s >= 0) { idx[ti++] = a; idx[ti++] = b; idx[ti++] = c; } else { idx[ti++] = a; idx[ti++] = c; idx[ti++] = b; }
    };
    for (const q of Q) {
      if (d2(q[0], q[2]) < d2(q[1], q[3])) { emit(q[0], q[1], q[2]); emit(q[0], q[2], q[3]); }
      else { emit(q[0], q[1], q[3]); emit(q[1], q[2], q[3]); }
    }
    return { pos, nor, idx, nv, VB, lists };
  }

  // ── Shaders: toon ramp, oiled-skin highlight, rim, idle motion, ink hull ──
  const GRAD = (() => {
    const t = new T.DataTexture(new Uint8Array([46, 46, 120, 120, 200, 200, 255, 255]), 8, 1, T.RedFormat);
    t.minFilter = t.magFilter = T.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true; return t;
  })();
  const U = { uT: { value: 0 }, uRimCol: { value: new T.Color(1.0, 0.42, 0.30) }, uRimK: { value: 0.9 }, uWarm: { value: new T.Vector3(0.035, 0.008, 0.018) } };
  const IDLE = `
    uniform float uT; uniform vec3 uChest; uniform float uPh;
    vec3 ctIdle(vec3 p, float sw){
      float t = uT + uPh;
      float w = smoothstep(0.30, 1.05, p.y);
      p.x += sin(t*0.85) * 0.011 * w;
      p.z += sin(t*0.85 + 1.3) * 0.004 * w;
      float br = 0.5 + 0.5*sin(t*1.6);
      float cw = exp(-pow((p.y - uChest.y)/0.14, 2.0));
      vec2 d = p.xz - uChest.xz;
      p.xz += d * (0.022 * br * cw);
      p.y += 0.004 * br * smoothstep(1.15, 1.5, p.y);
      float s1 = sin(t*1.3 + p.y*2.6), s2 = sin(t*0.9 + p.x*3.0 + p.y*1.7);
      p.x += sw * 0.028 * s1; p.z += sw * 0.022 * s2;
      return p;
    }`;
  const PATTERN = `
    float ctH(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
    float ctN(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
      return mix(mix(ctH(i),ctH(i+vec2(1,0)),f.x), mix(ctH(i+vec2(0,1)),ctH(i+vec2(1,1)),f.x), f.y); }
    vec3 ctPat(vec3 c, float pid, vec3 o, float sd){
      if (pid > 0.5 && pid < 1.5) {            // overlapping bronze scales
        vec2 q = vec2(o.x*52.0, o.y*60.0); q.x += 0.5*floor(q.y);
        vec2 f = fract(q) - vec2(0.5, 0.15); float r = length(f*vec2(1.0,0.9));
        c *= mix(1.25, 0.45, smoothstep(0.34, 0.5, r));
      } else if (pid < 2.5) {                  // leather
        c *= 0.8 + 0.35*ctN(o.xy*70.0 + o.z*40.0);
      } else if (pid < 3.5) {                  // fur
        float n = ctN(vec2((o.x + o.z)*140.0, o.y*28.0)) * 0.7 + ctN(vec2((o.x - o.z)*60.0, o.y*12.0)) * 0.5;
        c *= 0.5 + 0.9*n;
      } else if (pid < 4.5) {                  // polished metal
        c *= 0.9 + 0.2*ctN(o.xy*30.0);
      } else if (pid < 5.5) {                  // cloth with pleats
        c *= 0.8 + 0.22*ctN(vec2(o.x*90.0 + o.z*90.0, o.y*16.0));
        c *= 0.72 + 0.4*smoothstep(-0.4, 0.7, sin(o.x*150.0 + o.z*90.0 + o.y*55.0 + 2.0*ctN(o.xy*40.0)));
      } else if (pid < 6.5) {                  // chain links
        c *= 0.45 + 0.9*step(0.45, fract((o.x + o.y*0.7 + o.z)*95.0));
      } else if (pid < 7.5) {                  // hair strands
        float a = atan(o.x - uHC.x, o.z - uHC.z);
        c *= 0.62 + 0.55*ctN(vec2(a*26.0 + o.y*4.0, o.y*5.0)) ;
      } else if (pid < 8.5) {                  // wood
        c *= 0.75 + 0.4*ctN(vec2(o.x*300.0 + o.z*300.0, o.y*10.0));
      }
      if (pid > 0.5 && pid < 6.5 && sd < 0.0035) c *= 0.5;   // hem / plate edge
      return c;
    }`;
  const ShaderChunk_toon = T.ShaderChunk.lights_toon_pars_fragment.replace(/getGradientIrradiance\(/g, 'ctGrad(');
  function heroMats(opts) {
    const unis = { uChest: { value: new T.Vector3(0, 1.3, 0) }, uPh: { value: opts.phase || 0 }, uHC: { value: new T.Vector3(0, 1.7, 0) }, uSkinGloss: { value: opts.skinGloss || 0.8 } };
    function toon(kind) {
      const m = new T.MeshToonMaterial({ color: 0xffffff, gradientMap: GRAD, vertexColors: true, side: kind === 'soft' ? T.DoubleSide : T.FrontSide });
      if (kind === 'head') m.map = opts.faceTex;
      m.onBeforeCompile = sh => {
        Object.assign(sh.uniforms, U, unis);
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\n' + IDLE + '\nattribute vec3 aCol1; attribute vec4 aCl; varying vec3 vCol1; varying vec4 vCl; varying vec3 vObj;')
          .replace('#include <begin_vertex>', 'vec3 transformed = ctIdle(position, aCl.w); vObj = position; vCol1 = aCol1; vCl = aCl;');
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform vec3 uRimCol; uniform float uRimK; uniform vec3 uWarm; uniform vec3 uHC; uniform float uSkinGloss;\nvarying vec3 vCol1; varying vec4 vCl; varying vec3 vObj;\n' + PATTERN)
          .replace('#include <map_fragment>', '')
          .replace('#include <color_fragment>', `
            vec3 cBase = vColor.rgb; float gloss = uSkinGloss;
            ${kind === 'head' ? 'vec4 fx = texture2D(map, vMapUv); cBase = mix(cBase, fx.rgb, fx.a * vCol1.x); gloss *= 1.0 - fx.a * vCol1.x * 0.6;' : ''}
            if (vCl.x > 0.0) { cBase = ctPat(vCol1, vCl.y, vObj, vCl.x); gloss = vCl.z; }
            diffuseColor.rgb = cBase;`)
          .replace('#include <gradientmap_pars_fragment>', `#include <gradientmap_pars_fragment>
            float ctCap = 0.0;
            vec3 ctGrad(vec3 n, vec3 l) { float d = dot(n, l); vec2 c = vec2(min(d * 0.5 + 0.5, mix(1.0, 0.74, ctCap)), 0.0); return vec3(texture2D(gradientMap, c).r); }`)
          .replace('#include <lights_toon_pars_fragment>', ShaderChunk_toon)
          .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
            if (vCl.x > 0.0 && vCl.y > 0.5 && vCl.y < 5.5 && vObj.y > 1.1) ctCap = 1.0;
            if (${kind === 'body' ? 1 : 0} == 1 && vCl.x > 0.0 && ((vCl.y > 4.5 && vCl.y < 5.5) || (vCl.y > 2.5 && vCl.y < 3.5))) {
              vec3 fn = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
              if (dot(fn, normal) < 0.0) fn = -fn;
              normal = normalize(mix(normal, fn, 0.6));
            }`)
          .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * uWarm;')
          .replace('#include <opaque_fragment>', `
            { vec3 N = normalize(normal); vec3 V = normalize(vViewPosition); if (dot(N, V) < 0.0) N = -N; float ndv = clamp(dot(N, V), 0.0, 1.0);
              #if NUM_DIR_LIGHTS > 0
                vec3 L = directionalLights[0].direction; vec3 H = normalize(L + V); float nh = dot(N, H);
                float sp = smoothstep(0.978, 0.985, nh) * 0.7 * (1.0 - ctCap);
                vec3 spc = directionalLights[0].color * sp * gloss * 0.55;
                if (vCl.x > 0.0 && vCl.y > 0.5 && vCl.y < 5.5 && abs(vCl.y - 4.0) > 0.5) spc *= diffuseColor.rgb * 2.5;  // matte cloth, fur, leather
                outgoingLight += spc;
              #endif
              float fr = smoothstep(0.35, 0.62, pow(1.0 - ndv, 2.2));
              vec3 rl = vec3(0.0);
              #if NUM_DIR_LIGHTS > 0
                for (int i = 0; i < NUM_DIR_LIGHTS; i++) rl += directionalLights[i].color * smoothstep(0.0, 0.3, dot(N, directionalLights[i].direction));
              #endif
              outgoingLight += (rl * 0.55 + uRimCol * 0.12) * fr * uRimK * (0.35 + 0.4 * gloss) * diffuseColor.rgb * 2.2;
            }
            #include <opaque_fragment>`);
      };
      m.customProgramCacheKey = () => 'ctHero_' + kind;
      return m;
    }
    const ink = new T.ShaderMaterial({
      uniforms: Object.assign({ uW: { value: 0.0021 }, uInk: { value: new T.Color(0x140608) } }, U, unis),
      vertexShader: IDLE + `
        attribute vec4 aCl; uniform float uW;
        void main(){ vec3 p = ctIdle(position, aCl.w); vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vec3 n = normalize(normalMatrix * normal); mv.xyz += n * uW * clamp(-mv.z, 0.6, 12.0);
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: 'uniform vec3 uInk; void main(){ gl_FragColor = vec4(uInk, 1.0); }',
      side: T.BackSide,
    });
    return { body: toon('body'), head: toon('head'), soft: toon('soft'), prop: toon('prop'), ink, unis };
  }

  // ── Geometry assembly helpers ──────────────────────────────────────────────
  function geoFrom(pos, nor, idx, col0, col1, cl, uv) {
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3));
    g.setAttribute('normal', new T.BufferAttribute(nor, 3));
    g.setAttribute('color', new T.BufferAttribute(col0, 3));
    g.setAttribute('aCol1', new T.BufferAttribute(col1, 3));
    g.setAttribute('aCl', new T.BufferAttribute(cl, 4));
    if (uv) g.setAttribute('uv', new T.BufferAttribute(uv, 2));
    g.setIndex(new T.BufferAttribute(idx, 1));
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
  // Prop / soft mesh collector: merges three.js primitives with a colour + pattern.
  function Collector() { this.parts = []; }
  Collector.prototype.add = function (geo, mat4, col, pid, gloss, sway) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone(); if (mat4) g.applyMatrix4(mat4);
    if (!g.attributes.normal) g.computeVertexNormals();
    this.parts.push({ g, col: typeof col === 'string' ? hx(col) : col, pid: pid || 0, gloss: gloss || 0, sway: sway || 0 });
  };
  Collector.prototype.addRaw = function (pos, nor, cols, pid, gloss, sways) { this.parts.push({ raw: true, pos, nor, cols, pid, gloss, sways }); };
  Collector.prototype.build = function () {
    let n = 0; for (const p of this.parts) n += p.raw ? p.pos.length / 3 : p.g.attributes.position.count;
    if (!n) return null;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), c0 = new Float32Array(n * 3), c1 = new Float32Array(n * 3), cl = new Float32Array(n * 4);
    let o = 0;
    for (const p of this.parts) {
      if (p.raw) {
        const m = p.pos.length / 3; pos.set(p.pos, o * 3); nor.set(p.nor, o * 3); c0.set(p.cols, o * 3); c1.set(p.cols, o * 3);
        for (let i = 0; i < m; i++) { cl[(o + i) * 4] = 1; cl[(o + i) * 4 + 1] = p.pid; cl[(o + i) * 4 + 2] = p.gloss; cl[(o + i) * 4 + 3] = p.sways ? p.sways[i] : 0; }
        o += m; continue;
      }
      const m = p.g.attributes.position.count; pos.set(p.g.attributes.position.array, o * 3); nor.set(p.g.attributes.normal.array, o * 3);
      for (let i = 0; i < m; i++) { c0.set(p.col, (o + i) * 3); c1.set(p.col, (o + i) * 3); cl[(o + i) * 4] = 1; cl[(o + i) * 4 + 1] = p.pid; cl[(o + i) * 4 + 2] = p.gloss; cl[(o + i) * 4 + 3] = p.sway; }
      o += m; p.g.dispose();
    }
    const idx = new Uint32Array(n); for (let i = 0; i < n; i++) idx[i] = i;
    return geoFrom(pos, nor, idx, c0, c1, cl);
  };
  const M4 = (pos, R, s) => { // R: 3x3 row-major local->world
    const m = new T.Matrix4();
    const S = s ? (Array.isArray(s) ? s : [s, s, s]) : [1, 1, 1];
    const r = R || I3;
    m.set(r[0] * S[0], r[1] * S[1], r[2] * S[2], pos[0], r[3] * S[0], r[4] * S[1], r[5] * S[2], pos[1], r[6] * S[0], r[7] * S[1], r[8] * S[2], pos[2], 0, 0, 0, 1);
    return m;
  };
  const segM = (a, b, rad, zh) => { const d = sub(b, a), l = len(d); return M4(lerp3(a, b, 0.5), basisY(d, zh || [0, 0, 1]), [rad, l, rad]); };

  // Cloth panel: hangs from a top edge, drapes over the field (collision), returns raw arrays.
  function drape(F, top, length, rows, o) {
    o = o || {}; const cols = top.length, seg = length / rows, clr = o.clr || 0.012, grid = [top.map(p => p.slice())];
    const bias = o.bias || [0, 0, 0], taper = o.taper || 1;
    for (let r = 1; r <= rows; r++) {
      const row = [];
      for (let c = 0; c < cols; c++) {
        const prev = grid[r - 1][c], pp = r > 1 ? grid[r - 2][c] : null;
        const bk = Math.pow(o.decay || 1, r - 1); let dir = [bias[0] * bk, -1 + bias[1] * bk, bias[2] * bk];
        if (pp) dir = add(dir, scl(nrm(sub(prev, pp)), o.stiff || 0.6));
        dir = nrm(dir);
        let p = add(prev, scl(dir, seg));
        for (let it = 0; it < 5; it++) {
          const d = F(p); if (d >= clr) break;
          let g = gradOf(F, p);
          if (o.lock) { const lx = WD(o.lock, [1, 0, 0]); g = nrm(sub(g, scl(lx, dot(g, lx)))); }
          p = add(p, scl(g, clr - d));
          p = add(prev, scl(nrm(sub(p, prev)), seg));
        }
        if (o.lock) {
          const q0 = toL(o.lock, ...top[c]), q = toL(o.lock, ...p); q[0] = q0[0] * (1 + (o.spread !== undefined ? o.spread : taper - 1) * r / rows); p = W(o.lock, q);
          const lx = WD(o.lock, [1, 0, 0]);
          for (let it = 0; it < 6; it++) { const d = F(p); if (d >= clr) break; let g = gradOf(F, p); g = nrm(sub(g, scl(lx, dot(g, lx)))); p = add(p, scl(g, clr - d + 0.002)); }
        }
        for (let it = 0; it < 4; it++) { // the segment to the previous row must not cut through a convex bulge
          const m = lerp3(prev, p, 0.5), dm = F(m); if (dm >= clr * 0.7) break;
          let g = gradOf(F, m); if (o.lock) { const lx = WD(o.lock, [1, 0, 0]); g = nrm(sub(g, scl(lx, dot(g, lx)))); }
          p = add(p, scl(g, (clr - dm) * 2));
        }
        row.push(p);
      }
      // keep the panel together (spread toward a tapering width)
      const w0 = len(sub(top[0], top[cols - 1])) / (cols - 1);
      const want = w0 * (1 + (taper - 1) * r / rows);
      for (let it = 0; it < 3; it++) for (let c = 1; c < cols; c++) {
        const a = row[c - 1], b = row[c], d = sub(b, a), l = len(d) || 1e-6, k = (l - want) / l * 0.5 * 0.5;
        row[c - 1] = add(a, scl(d, k)); row[c] = sub(b, scl(d, k));
      }
      grid.push(row);
    }
    if (o.folds) { // vertical folds that deepen toward the hem
      const [amp, freq] = o.folds;
      for (let r = 1; r <= rows; r++) for (let c = 0; c < cols; c++) {
        const g = grid, a = g[r][Math.min(c + 1, cols - 1)], b = g[r][Math.max(c - 1, 0)], up = sub(g[r - 1][c], g[r][c]);
        const n = nrm(cross(sub(a, b), up)), k = amp * Math.pow(r / rows, 0.8) * Math.sin(c / (cols - 1) * freq * PI * 2 + r * 0.05);
        const p = add(g[r][c], scl(n, k));
        g[r][c] = F(p) > clr * 0.6 ? p : g[r][c];
      }
    }
    return grid;
  }
  function gradOf(F, p) { const e = 0.003; return nrm([F([p[0] + e, p[1], p[2]]) - F([p[0] - e, p[1], p[2]]), F([p[0], p[1] + e, p[2]]) - F([p[0], p[1] - e, p[2]]), F([p[0], p[1], p[2] + e]) - F([p[0], p[1], p[2] - e])]); }
  function ragged(grid, cut, seed) { const R = grid.length - 1; for (let c = 0; c < grid[0].length; c++) { const k = R - Math.floor(hash3(c, seed, 5) * cut); for (let r = k + 1; r <= R; r++) grid[r][c] = grid[k][c]; } return grid; }
  // Grid -> triangles (non-indexed), colour fn(u,v)->rgb, sway fn(v)
  function gridMesh(C, grid, colFn, pid, gloss, swayFn) {
    const R = grid.length, Cn = grid[0].length, P = [], N = [], Cc = [], S = [];
    const nAt = (r, c) => { const a = grid[Math.min(r + 1, R - 1)][c], b = grid[Math.max(r - 1, 0)][c], d = grid[r][Math.min(c + 1, Cn - 1)], e = grid[r][Math.max(c - 1, 0)]; return nrm(cross(sub(d, e), sub(a, b))); };
    const push = (r, c) => { const p = grid[r][c], n = nAt(r, c), u = c / (Cn - 1), v = r / (R - 1); P.push(...p); N.push(...n); Cc.push(...colFn(u, v, r, c)); S.push(swayFn ? swayFn(v, u) : v); };
    for (let r = 0; r < R - 1; r++) for (let c = 0; c < Cn - 1; c++) { push(r, c); push(r + 1, c + 1); push(r + 1, c); push(r, c); push(r, c + 1); push(r + 1, c + 1); }
    C.addRaw(new Float32Array(P), new Float32Array(N), new Float32Array(Cc), pid, gloss, S);
  }
  // Tube along a path with a radius function (braids, straps, bow limbs)
  function tube(C, path, radFn, col, pid, gloss, swayFn, seg) {
    seg = seg || 8; const P = [], N = [], Cc = [], S = [], n = path.length;
    const rings = [];
    let prevX = null;
    for (let i = 0; i < n; i++) {
      const t = nrm(sub(path[Math.min(i + 1, n - 1)], path[Math.max(i - 1, 0)]));
      let x = prevX ? nrm(sub(prevX, scl(t, dot(prevX, t)))) : nrm(cross(t, Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
      const y = cross(t, x); prevX = x;
      const r = radFn(i / (n - 1), i), ring = [];
      for (let k = 0; k < seg; k++) { const a = k / seg * PI * 2, d = add(scl(x, Math.cos(a)), scl(y, Math.sin(a))); ring.push([add(path[i], scl(d, r)), d]); }
      rings.push(ring);
    }
    const colv = typeof col === 'string' ? hx(col) : col;
    const push = (i, k) => { const [p, d] = rings[i][k % seg]; P.push(...p); N.push(...d); Cc.push(...(typeof colv === 'function' ? colv(i / (n - 1)) : colv)); S.push(swayFn ? swayFn(i / (n - 1)) : 0); };
    for (let i = 0; i < n - 1; i++) for (let k = 0; k < seg; k++) { push(i, k); push(i + 1, k + 1); push(i + 1, k); push(i, k); push(i, k + 1); push(i + 1, k + 1); }
    C.addRaw(new Float32Array(P), new Float32Array(N), new Float32Array(Cc), pid, gloss, S);
  }

  // ── Rig: FK spine + 2-bone IK legs and arms ────────────────────────────────
  function makeRig(P) {
    const r = {}, L1 = 0.456, L2 = 0.432, hipL = [0.088, -0.004, 0.004];
    r.pel = { o: add(P.pel, [0, 0.028, 0]), R: eul(P.pelYaw, P.pelPitch, P.pelRoll) };
    // solve the pelvis height so the weight leg stands straight with the heel down
    if (P.weight) {
      const ws = P.weight, a = P.ank[ws];
      for (let it = 0; it < 3; it++) {
        const hip = W(r.pel, [ws * hipL[0], hipL[1], hipL[2]]), dx = hip[0] - a[0], dz = hip[2] - a[2], Lw = (L1 + L2) * 0.994;
        r.pel.o = add(r.pel.o, [0, a[1] + Math.sqrt(Math.max(Lw * Lw - dx * dx - dz * dz, 0.01)) - hip[1], 0]);
      }
    }
    // the spine stacks vertically over the pelvis (no forward tip); pitch only shapes the parts
    const yr = (y, rl) => eul(y, 0, rl);
    const wR = mm(r.pel.R, eul(P.wYaw, P.wPitch, P.wRoll));
    r.wst = { o: add(r.pel.o, mv(yr(P.pelYaw, P.pelRoll), [0, 0.175, 0.0])), R: wR };
    const cR = mm(wR, eul(P.cYaw, P.cPitch, P.cRoll));
    r.chs = { o: add(r.wst.o, mv(yr((P.pelYaw || 0) + (P.wYaw || 0), (P.pelRoll || 0) + (P.wRoll || 0)), [0, 0.2, 0.0])), R: cR };
    r.neckB = W(r.chs, [0, 0.172, -0.022]);
    const hR = mm(cR, eul(P.hYaw, P.hPitch, P.hRoll)), nR = mm(cR, eul((P.hYaw || 0) * 0.5, (P.hPitch || 0) * 0.5 + 0.05, (P.hRoll || 0) * 0.5));
    r.head = { o: add(r.neckB, mv(nR, [0, 0.195, 0.03])), R: hR };
    r.leg = {}; r.arm = {};
    for (const s of [-1, 1]) {
      const hip = W(r.pel, [s * hipL[0], hipL[1], hipL[2]]);
      const k = ik(hip, P.ank[s], L1, L2, P.knee[s]);
      const fR = eul(P.fYaw[s], P.fPitch[s], P.fRoll ? P.fRoll[s] : 0);
      r.leg[s] = { hip, knee: k.mid, ank: k.end, foot: { o: k.end, R: fR } };
      const sh = W(r.chs, [s * 0.158, 0.152, -0.014]);
      const a = ik(sh, P.wr[s], 0.29, 0.25, P.elb[s]);
      const fdir = nrm(sub(a.end, a.mid));
      const hd = P.hd && P.hd[s] ? nrm(P.hd[s]) : fdir;
      const hf = P.hf && P.hf[s] ? P.hf[s] : [0, 0, 1];
      r.arm[s] = { sh, elb: a.mid, wr: a.end, hand: { o: a.end, R: basisY(hd, hf) } };
    }
    return r;
  }

  // ── Body field (shared anatomy, per-heroine proportions) ───────────────────
  // groups: 0 torso, 1 leg R, 2 leg L, 3 arm R, 4 arm L
  function bodyField(rig, S) {
    const F = new Field(5, [0, 0.05, 0.05, 0.045, 0.045]);
    const { pel, wst, chs } = rig; const b = S.bust || 1, hp = S.hip || 1;
    F.join(0, 0, 0.04); F.join(1, 0, 0.06); // breasts pair, glutes pair (soft blend into the pelvis)
    // pelvis + hips: one mass; the glutes hang low and flow out of the lower back
    F.ell(0, pel, [0, 0.045, -0.01], [0.148 * hp, 0.12, 0.098], 0);
    F.ell(0, pel, [0, 0.11, -0.045], [0.12, 0.075, 0.07], 0.06);                          // sacrum / lower back fill
    for (const s of [-1, 1]) {
      F.ell(0, pel, [s * 0.128 * hp, -0.035, -0.012], [0.088 * hp, 0.135, 0.094], 0.07);  // hip + saddle
      F.ell(0, pel, [s * 0.066 * hp, -0.028, -0.086], [0.094 * hp, 0.118, 0.1], 0, { j: 1, rot: eul(s * 0.18, -0.08, 0) }); // glute (fullest at hip-joint level)
      F.ell(0, pel, [s * 0.06 * hp, 0.045, -0.068], [0.085 * hp, 0.08, 0.078], 0, { j: 1, rot: eul(s * 0.2, 0.35, 0) });   // upper glute, rises from the back
      F.ell(0, pel, [s * 0.092, 0.105, 0.068], [0.018, 0.02, 0.018], 0.028);               // hip bone
    }
    F.ell(0, pel, [0, 0.075, 0.04], [0.1, 0.072, 0.05], 0.04);                              // lower belly
    F.ell(0, pel, [0, -0.052, 0.042], [0.05, 0.046, 0.04], 0.03);                           // groin
    // waist + abdomen
    F.ell(0, wst, [0, -0.005, 0], [0.114 * (S.waist || 1), 0.13, 0.082], 0.085);
    F.ell(0, wst, [0, 0.02, 0.04], [0.066, 0.1, 0.036], 0.04);
    for (const s of [-1, 1]) F.ell(0, wst, [s * 0.082, -0.105, -0.016], [0.05, 0.09, 0.055], 0.08); // obliques flow into the hip
    // ribcage, back, shoulders
    F.ell(0, chs, [0, 0.0, -0.012], [0.124, 0.16, 0.095], 0.07);
    F.ell(0, chs, [0, -0.1, -0.005], [0.112, 0.07, 0.088], 0.05);
    for (const s of [-1, 1]) {
      F.ell(0, chs, [s * 0.064, 0.045, -0.046], [0.074, 0.115, 0.058], 0.04);           // lats / back
      F.ell(0, chs, [s * 0.058, 0.085, 0.03], [0.07, 0.05, 0.05], 0.035);               // upper chest
      const by0 = S.bustY || 0;
      F.ell(0, chs, [s * 0.074, 0.05 + by0, 0.058], [0.064 * b, 0.08, 0.042 * b], 0.075, { rot: eul(s * 0.32, 0.6, 0) });          // upper pole grows from the pectoral
      F.ell(0, chs, [s * 0.083, -0.026 + by0, 0.088], [0.079 * b, 0.07 * b, 0.07 * b], 0, { j: 0, rot: eul(s * 0.36, -0.22, 0) }); // full lower mass
      F.ell(0, chs, [s * 0.118, 0.02 + by0, 0.03], [0.04, 0.06, 0.05], 0.06);                                                      // armpit / side blend
      F.cone(0, W(chs, [s * 0.022, 0.168, 0.055]), W(chs, [s * 0.148, 0.176, 0.008]), 0.011, 0.012, 0.022); // collarbone
      F.cone(0, W(chs, [s * 0.035, 0.195, -0.03]), W(chs, [s * 0.14, 0.15, -0.018]), 0.028, 0.022, 0.05);    // trapezius
    }
    F.ell(0, chs, [0, 0.112, -0.014], [0.122, 0.062, 0.078], 0.06);                          // shoulder girdle
    F.cone(0, W(chs, [0, 0.14, -0.018]), W(rig.head, [0, -0.062, -0.024]), 0.056, 0.046, 0.045); // neck
    // details: navel, spine groove, cleft
    F.ell(0, wst, [0, -0.028, 0.086], [0.0075, 0.009, 0.012], 0.008, { sub: true });
    F.cone(0, W(wst, [0, -0.07, -0.09]), W(chs, [0, 0.04, -0.113]), 0.011, 0.011, 0.02, { sub: true });
    // legs
    for (const s of [-1, 1]) {
      const g = s < 0 ? 1 : 2, L = rig.leg[s], H = L.hip, K = L.knee, A = L.ank;
      const up = nrm(sub(H, K)), fwd0 = nrm(sub(L.foot ? W(L.foot, [0, 0, 1]) : add(K, [0, 0, 1]), L.foot.o));
      const side = nrm(cross(up, fwd0)), fwd = cross(side, up); // side points to the character's left
      const out = scl(side, s); // outward from body centre
      const th = S.thigh || 1;
      F.cone(g, K, H, 0.055, 0.1 * th, 0);
      F.ell(g, { o: lerp3(K, H, 0.8), R: basisY(up, fwd) }, [s * 0.042, 0, -0.012], [0.064 * th, 0.15, 0.074 * th], 0.04);   // saddle / upper-outer thigh
      F.ell(g, { o: lerp3(K, H, 0.82), R: basisY(up, fwd) }, [0, 0, -0.04], [0.07 * th, 0.12, 0.06], 0.04);                  // under-glute thigh mass
      F.ell(g, { o: lerp3(K, H, 0.55), R: basisY(up, fwd) }, [s * 0.032, 0, 0.004], [0.06 * th, 0.17, 0.062 * th], 0.03);   // outer thigh
      F.ell(g, { o: lerp3(K, H, 0.52), R: basisY(up, fwd) }, [0, 0.0, 0.03], [0.058 * th, 0.165, 0.048 * th], 0.02);       // quads
      F.ell(g, { o: lerp3(K, H, 0.74), R: basisY(up, fwd) }, [-s * 0.024, 0, -0.004], [0.058 * th, 0.12, 0.06 * th], 0.02); // inner thigh
      F.ell(g, { o: lerp3(K, H, 0.58), R: basisY(up, fwd) }, [0, 0, -0.034], [0.06 * th, 0.17, 0.055], 0.03);              // hamstrings
      F.ell(g, { o: K, R: basisY(up, fwd) }, [0, 0.005, 0.004], [0.042, 0.048, 0.04], 0.02);                               // knee
      F.ell(g, { o: K, R: basisY(up, fwd) }, [0, 0.012, 0.036], [0.023, 0.027, 0.014], 0.012);                             // kneecap
      const upS = nrm(sub(K, A)), fwdS = nrm(sub(fwd, scl(upS, dot(fwd, upS)))), frS = { o: A, R: basisY(upS, fwdS) };
      const ls = len(sub(K, A));
      F.cone(g, A, K, 0.026, 0.041, 0.015);
      F.ell(g, frS, [s * 0.008, ls * 0.72, -0.03], [0.042 * (S.calf || 1), 0.1, 0.04], 0.022);   // calf outer
      F.ell(g, frS, [-s * 0.012, ls * 0.66, -0.026], [0.04 * (S.calf || 1), 0.095, 0.042], 0.022); // calf inner
      F.ell(g, frS, [0, ls * 0.35, -0.012], [0.03, 0.12, 0.03], 0.03);
      F.ell(g, frS, [s * 0.024, 0.0, -0.004], [0.011, 0.013, 0.012], 0.01);  // ankle bones
      F.ell(g, frS, [-s * 0.021, 0.006, 0.0], [0.011, 0.013, 0.012], 0.01);
      // foot (foot frame: z forward, y up, origin ankle)
      const f = L.foot, inn = -s;
      F.ell(g, f, [0, -0.036, -0.03], [0.029, 0.037, 0.034], 0.02);          // heel
      F.ell(g, f, [inn * 0.003, -0.044, 0.045], [0.034, 0.026, 0.078], 0.03); // foot body
      F.ell(g, f, [0, -0.02, 0.018], [0.027, 0.027, 0.045], 0.03);           // instep
      F.ell(g, f, [inn * 0.004, -0.056, 0.108], [0.04, 0.017, 0.028], 0.02);  // ball
      F.ell(g, f, [inn * 0.017, -0.058, 0.148], [0.0135, 0.0125, 0.024], 0.008); // big toe
      F.ell(g, f, [-inn * 0.011, -0.061, 0.138], [0.023, 0.0105, 0.022], 0.006); // toes
      F.ell(g, f, [inn * 0.0045, -0.05, 0.15], [0.003, 0.012, 0.02], 0.004, { sub: true }); // toe split
      F.ell(g, f, [inn * 0.03, -0.075, 0.04], [0.012, 0.016, 0.03], 0.02, { sub: true });  // arch
    }
    // arms
    for (const s of [-1, 1]) {
      const g = s < 0 ? 3 : 4, A = rig.arm[s], Sh = A.sh, E = A.elb, Wr = A.wr;
      const upA = nrm(sub(Sh, E)), hint = WD(chs, [0, 0, 1]), frU = { o: E, R: basisY(upA, hint) }, lu = len(sub(Sh, E));
      const outv = WD(chs, [s, 0, 0]);
      F.ell(g, frU, [s * 0.006, lu * 0.8, 0.0], [0.05, 0.09, 0.053], 0.03);                               // deltoid
      F.cone(g, E, Sh, 0.035, 0.043, 0.02);
      F.ell(g, frU, [0, lu * 0.5, 0.014], [0.028, 0.075, 0.028], 0.02);                                    // biceps
      F.ell(g, frU, [0, lu * 0.58, -0.012], [0.03, 0.08, 0.029], 0.02);                                   // triceps
      F.ell(g, { o: E, R: basisY(upA, hint) }, [0, 0, -0.006], [0.03, 0.032, 0.03], 0.015);
      const upF = nrm(sub(E, Wr)), frF = { o: Wr, R: basisY(upF, hint) }, lf = len(sub(E, Wr));
      F.cone(g, Wr, E, 0.022, 0.035, 0.015, { sx: 1.2, sz: 0.85, zh: hint });
      F.ell(g, frF, [0, lf * 0.7, 0.004], [0.039, 0.08, 0.032], 0.025);                                  // forearm muscle
      // hand (y along fingers)
      const H = A.hand, fist = S.fist && S.fist[s];
      if (fist) {
        F.ell(g, H, [0, 0.042, 0.004], [0.032, 0.042, 0.026], 0.02);
        F.ell(g, H, [0, 0.07, 0.018], [0.03, 0.022, 0.02], 0.012);
        F.cone(g, W(H, [s * 0.022, 0.018, 0.012]), W(H, [s * 0.012, 0.06, 0.03]), 0.011, 0.009, 0.012);
      } else {
        F.ell(g, H, [0, 0.042, 0], [0.034, 0.045, 0.015], 0.02);
        F.cone(g, W(H, [0, 0.07, 0]), W(H, [0, 0.12, 0.012]), 0.022, 0.015, 0.012, { sx: 1.35, sz: 0.55 });
        F.cone(g, W(H, [s * 0.024, 0.02, 0.008]), W(H, [s * 0.04, 0.07, 0.02]), 0.011, 0.008, 0.012);
      }
    }
    return F;
  }

  // ── Mask helpers (world-space signed regions, + inside) ────────────────────
  const MK = {
    ell(fr, c, r) { return (x, y, z) => { const q = toL(fr, x, y, z); const a = (q[0] - c[0]) / r[0], b = (q[1] - c[1]) / r[1], d = (q[2] - c[2]) / r[2]; return (1 - Math.sqrt(a * a + b * b + d * d)) * Math.min(r[0], r[1], r[2]); }; },
    cap(a, b, r) { return (x, y, z) => { const ba = sub(b, a), pa = [x - a[0], y - a[1], z - a[2]]; const h = clamp(dot(pa, ba) / dot(ba, ba), 0, 1); return r - len(sub(pa, scl(ba, h))); }; },
    band(fr, fn, hw) { return (x, y, z) => { const q = toL(fr, x, y, z); return hw - Math.abs(fn(q)); }; },
    half(fr, fn) { return (x, y, z) => fn(toL(fr, x, y, z)); },
    and(...f) { return (x, y, z) => { let m = 1e9; for (const g of f) { const v = g(x, y, z); if (v < m) m = v; } return m; }; },
    or(...f) { return (x, y, z) => { let m = -1e9; for (const g of f) { const v = g(x, y, z); if (v > m) m = v; } return m; }; },
  };

  // ── Head field (head-local: origin at eye level, +z face) ─────────────────
  function headField(S) {
    const F = new Field(1, []), O = { o: [0, 0, 0], R: I3 }, jw = S.jaw || 1;
    F.ell(0, O, [0, 0.03, -0.016], [0.071, 0.092, 0.094], 0);                  // cranium
    F.ell(0, O, [0, 0.036, 0.032], [0.064, 0.058, 0.05], 0.03);                // forehead
    F.ell(0, O, [0, -0.03, 0.03], [0.058, 0.058, 0.06], 0.03);                 // mid face
    F.ell(0, O, [0, -0.058, 0.02], [0.049 * jw, 0.032, 0.058], 0.03);          // jaw
    for (const s of [-1, 1]) {
      F.ell(0, O, [s * 0.047 * jw, -0.05, -0.012], [0.016, 0.025, 0.027], 0.03);  // jaw angle
      F.ell(0, O, [s * 0.045, -0.01, 0.05], [0.02, 0.014, 0.021], 0.02);          // cheekbone
      F.ell(0, O, [s * 0.071, -0.006, -0.014], [0.011, 0.026, 0.017], 0.012);     // ear
      F.ell(0, O, [s * 0.011, -0.03, 0.089], [0.0085, 0.007, 0.008], 0.008);      // nostril wing
    }
    F.ell(0, O, [0, -0.084, 0.056], [0.021 * (S.chin || 1), 0.018, 0.019], 0.025); // chin
    F.ell(0, O, [0, 0.023, 0.073], [0.05, 0.011, 0.013], 0.02);                     // brow ridge
    F.cone(0, [0, 0.018, 0.08], [0, -0.021, 0.099], 0.0065, 0.0095, 0.012);         // nose bridge
    F.ell(0, O, [0, -0.025, 0.097], [0.0105, 0.0085, 0.0095], 0.01);               // nose tip
    const lf = S.lips || 1;
    F.ell(0, O, [0, -0.043, 0.082], [0.021, 0.0072 * lf, 0.011], 0.012);           // upper lip
    F.ell(0, O, [0, -0.054, 0.08], [0.018, 0.0085 * lf, 0.0115 * lf], 0.012);      // lower lip
    F.cone(0, [0, -0.045, -0.024], [0, -0.14, -0.03], 0.04, 0.042, 0.03);          // neck
    for (const s of [-1, 1]) F.ell(0, O, [s * 0.031, 0.004, 0.085], [0.017, 0.013, 0.014], 0.01, { sub: true }); // eye sockets
    return F;
  }
  // Face paint: planar front projection, u = 0.5 + x/0.2, v = 0.5 + (y + 0.02)/0.2
  const FU = x => (0.5 + x / 0.2) * 512, FV = y => (1 - (0.5 + (y + 0.02) / 0.2)) * 512;
  function paintFace(S) {
    const cv = document.createElement('canvas'); cv.width = cv.height = 512; const g = cv.getContext('2d');
    const P = (x, y) => [FU(x), FV(y)];
    const blob = (x, y, rx, ry, col, a) => { g.save(); g.globalAlpha = a; g.fillStyle = col; g.beginPath(); g.ellipse(FU(x), FV(y), rx * 2560, ry * 2560, 0, 0, PI * 2); g.fill(); g.restore(); };
    // soft shading: eye sockets, cheek blush, under-lip
    for (const s of [-1, 1]) {
      const grd = g.createRadialGradient(FU(s * 0.031), FV(0.008), 2, FU(s * 0.031), FV(0.008), 60);
      grd.addColorStop(0, S.lid); grd.addColorStop(1, 'rgba(0,0,0,0)'); g.globalAlpha = 0.75; g.fillStyle = grd; g.fillRect(0, 0, 512, 512); g.globalAlpha = 1;
      const bl = g.createRadialGradient(FU(s * 0.045), FV(-0.025), 2, FU(s * 0.045), FV(-0.025), 55);
      bl.addColorStop(0, S.blush); bl.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = bl; g.fillRect(0, 0, 512, 512);
    }
    // eyes
    for (const s of [-1, 1]) {
      const cx = FU(s * 0.031), cy = FV(0.003), w = 38, hgt = 15 * (S.eyeOpen || 1), tilt = (S.eyeTilt || 0.1) * -s;
      g.save(); g.translate(cx, cy); g.rotate(tilt);
      g.fillStyle = '#c4aca4'; g.beginPath(); g.moveTo(-w, 2); g.quadraticCurveTo(-w * 0.2, -hgt * 1.6, w, -hgt * 0.35); g.quadraticCurveTo(w * 0.1, hgt * 1.3, -w, 2); g.fill();
      g.fillStyle = S.iris; g.beginPath(); g.arc(-s * 2, -2, hgt * 1.1, 0, PI * 2); g.fill();
      g.fillStyle = '#080406'; g.beginPath(); g.arc(-s * 2, -1, hgt * 0.45, 0, PI * 2); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.9)'; g.beginPath(); g.arc(-s * 2 + 4, -5, 2.5, 0, PI * 2); g.fill();
      // heavy lid + lashes (winged)
      g.fillStyle = '#0c0506'; g.beginPath(); g.moveTo(-w - 4, 4); g.quadraticCurveTo(-w * 0.2, -hgt * 1.9, w + 3, -hgt * 0.45);
      g.lineTo(w + 20, -hgt * 1.3); g.lineTo(w + 5, 0); g.quadraticCurveTo(-w * 0.2, -hgt * 1.05, -w, 3); g.fill();
      if (S.lidLow) { g.fillStyle = S.lidCol || '#3a2030'; g.beginPath(); g.moveTo(-w - 2, 3); g.quadraticCurveTo(-w * 0.2, -hgt * 1.9, w + 3, -hgt * 0.45); g.quadraticCurveTo(0, -hgt * 1.7 * (1 - S.lidLow), -w - 2, 3); g.fill();
        g.fillStyle = '#0c0506'; g.beginPath(); g.moveTo(-w - 2, 3); g.quadraticCurveTo(0, -hgt * 1.7 * (1 - S.lidLow) - 6, w + 5, -hgt * 0.5); g.lineTo(w + 20, -hgt * 1.25); g.lineTo(w + 4, 0); g.quadraticCurveTo(0, -hgt * 1.7 * (1 - S.lidLow) + 3, -w - 2, 5); g.fill(); }
      g.strokeStyle = '#2a1414'; g.lineWidth = 2.5; g.beginPath(); g.moveTo(-w * 0.7, 4); g.quadraticCurveTo(0, hgt * 1.25, w, -hgt * 0.2); g.stroke();
      g.restore();
      // brows
      const bx = FU(s * 0.032), by = FV(0.026 + (S.browY || 0));
      g.save(); g.translate(bx, by); g.scale(-s, 1);
      g.fillStyle = S.brow; g.beginPath();
      const ang = S.browAng || 0; // >0: angry (inner end low)
      g.moveTo(44, 4 + ang * 16); g.quadraticCurveTo(0, -18 - (S.browArch || 0) * 12, -44, 0); g.lineTo(-40, 12); g.quadraticCurveTo(0, 0 - (S.browArch || 0) * 12, 40, 20 + ang * 16); g.fill();
      g.restore();
    }
    // nose shading
    g.fillStyle = 'rgba(90,30,20,0.35)'; for (const s of [-1, 1]) { g.beginPath(); g.ellipse(FU(s * 0.0085), FV(-0.03), 6, 4, 0, 0, PI * 2); g.fill(); }
    // lips
    const ly = FV(-0.048), lx = FU(0), lw = 60 * (S.mouthW || 1), grin = S.grin || 0;
    g.fillStyle = S.lips; g.beginPath();
    g.moveTo(lx - lw, ly - grin * 10); g.quadraticCurveTo(lx - lw * 0.45, ly - 22, lx - 8, ly - 17); g.quadraticCurveTo(lx, ly - 13, lx + 8, ly - 17);
    g.quadraticCurveTo(lx + lw * 0.45, ly - 22, lx + lw, ly - grin * 10 - (S.smirk || 0) * 10);
    g.quadraticCurveTo(lx + lw * 0.4, ly + 32 - grin * 6, lx, ly + 33 - grin * 4); g.quadraticCurveTo(lx - lw * 0.4, ly + 32 - grin * 6, lx - lw, ly - grin * 10); g.fill();
    g.strokeStyle = S.lipLine || '#3a0608'; g.lineWidth = 3.5; g.beginPath(); g.moveTo(lx - lw * 0.95, ly - grin * 10); g.quadraticCurveTo(lx, ly + 2 + grin * 10, lx + lw * 0.95, ly - grin * 10 - (S.smirk || 0) * 10); g.stroke();
    if (S.teeth) { g.fillStyle = '#efe6dc'; g.beginPath(); g.moveTo(lx - lw * 0.7, ly - grin * 6); g.quadraticCurveTo(lx, ly + 12, lx + lw * 0.7, ly - grin * 6 - (S.smirk || 0) * 6); g.quadraticCurveTo(lx, ly + 2, lx - lw * 0.7, ly - grin * 6); g.fill(); }
    g.fillStyle = 'rgba(255,230,220,0.35)'; g.beginPath(); g.ellipse(lx + 6, ly + 16, 16, 5, 0, 0, PI * 2); g.fill();
    if (S.freckles) { let sd = 7; const rnd = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
      g.fillStyle = 'rgba(120,50,20,0.55)'; for (let i = 0; i < 90; i++) { const a = rnd() * PI * 2, r = Math.sqrt(rnd()); const x = FU(Math.cos(a) * 0.055 * r), y = FV(-0.018 + Math.sin(a) * 0.022 * r); g.beginPath(); g.arc(x, y, 1.5 + rnd() * 1.8, 0, PI * 2); g.fill(); } }
    if (S.paint) { g.fillStyle = S.paint; const s = S.paintSide || -1; for (let i = 0; i < 3; i++) { g.beginPath(); const x0 = FU(s * 0.03), y0 = FV(-0.018 - i * 0.011); g.moveTo(x0, y0); g.lineTo(FU(s * 0.068), y0 - 8); g.lineTo(FU(s * 0.068), y0 + 2); g.lineTo(x0, y0 + 7); g.fill(); } }
    if (S.scar) { g.strokeStyle = 'rgba(120,40,40,0.8)'; g.lineWidth = 3; g.beginPath(); g.moveTo(FU(0.022), FV(0.045)); g.lineTo(FU(0.04), FV(0.016)); g.stroke(); }
    const tex = new T.CanvasTexture(cv); tex.colorSpace = T.SRGBColorSpace; tex.anisotropy = 4; return tex;
  }

  // ── Heroine definitions ────────────────────────────────────────────────────
  const DEF = {};
  DEF.kaela = {
    skin: '#b98e6c', skinGloss: 0.7, hair: '#161012', phase: 0,
    shape: { bust: 1.1, hip: 1.03, thigh: 1.05, calf: 1.05, fist: { '-1': true, '1': true } },
    pose: {
      pel: [-0.07, 0.912, 0.0], pelYaw: 0.1, pelPitch: 0.1, pelRoll: -0.13, weight: -1,
      wYaw: -0.05, wPitch: -0.07, wRoll: 0.09, cYaw: -0.1, cPitch: -0.05, cRoll: 0.09,
      hYaw: 0.12, hPitch: -0.02, hRoll: -0.06,
      ank: { '-1': [-0.1, 0.074, -0.01], '1': [0.15, 0.076, 0.1] }, knee: { '-1': [0, 0, 1], '1': [-0.4, 0, 1] },
      fYaw: { '-1': -0.2, '1': 0.35 }, fPitch: { '-1': 0, '1': 0.04 },
      wr: { '-1': [-0.05, 1.04, 0.31], '1': [0.05, 1.06, 0.3] }, elb: { '-1': [-1, -0.2, -0.3], '1': [1, -0.2, -0.3] },
      hd: { '-1': [0.35, -0.45, 0.8], '1': [-0.35, -0.4, 0.8] }, hf: { '-1': [0, 1, 0], '1': [0, 1, 0] },
    },
    face: { iris: '#5a3212', lid: 'rgba(60,30,20,0.9)', blush: 'rgba(170,70,50,0.35)', brow: '#140a08', browAng: 0.9, browArch: 0.2, lips: '#9a1e1c', eyeTilt: 0.14, eyeOpen: 1.0, scar: true },
    head: { jaw: 1.06, chin: 1.1, lips: 1.1 },
  };
  DEF.nyx = {
    skin: '#e2dde8', skinGloss: 0.6, hair: '#dfe3f0', phase: 2.1,
    shape: { bust: 1.06, hip: 1.02, thigh: 1.0, calf: 0.95, waist: 0.94, fist: { '-1': true, '1': false } },
    pose: {
      pel: [0.08, 0.905, 0.0], pelYaw: -0.25, pelPitch: 0.14, pelRoll: 0.17, weight: 1,
      wYaw: 0.1, wPitch: -0.1, wRoll: -0.1, cYaw: 0.16, cPitch: -0.08, cRoll: -0.15,
      hYaw: -0.1, hPitch: -0.12, hRoll: 0.12,
      ank: { '-1': [-0.17, 0.076, 0.17], '1': [0.085, 0.074, -0.02] }, knee: { '-1': [0.45, 0, 1], '1': [0, 0, 1] },
      fYaw: { '-1': -0.3, '1': 0.2 }, fPitch: { '-1': 0.04, '1': 0 },
      wr: { '-1': [-0.39, 1.78, 0.1], '1': [0.2, 0.99, 0.04] }, elb: { '-1': [-1, -0.4, -0.2], '1': [1, 0.1, -0.7] },
      hd: { '-1': [0.1, 1, 0.05], '1': [-0.2, -0.8, 0.45] }, hf: { '-1': [1, 0, 0], '1': [0.8, 0, 0.3] },
    },
    face: { iris: '#8a4ae8', lid: 'rgba(70,30,80,0.95)', lidCol: '#3a1c40', blush: 'rgba(170,80,110,0.25)', brow: '#6a6070', browAng: -0.1, browArch: 0.9, lips: '#6e0f2e', eyeTilt: 0.2, eyeOpen: 1.0, lidLow: 0.38 },
    head: { jaw: 0.97, chin: 1.0, lips: 1.15 },
  };
  DEF.vesna = {
    skin: '#e3a986', skinGloss: 0.8, hair: '#9c3a18', phase: 4.2,
    shape: { bust: 0.93, hip: 1.02, thigh: 1.02, calf: 1.05, fist: { '-1': true, '1': false } },
    pose: {
      pel: [0.0, 0.915, 0.0], pelYaw: 2.35, pelPitch: 0.1, pelRoll: 0.1, weight: 1,
      wYaw: -0.22, wPitch: -0.07, wRoll: -0.05, cYaw: -0.3, cPitch: -0.05, cRoll: -0.08,
      hYaw: -1.3, hPitch: 0.06, hRoll: 0.1,
      ank: { '-1': [0.17, 0.076, -0.05], '1': [-0.06, 0.074, -0.09] }, knee: { '-1': [0.6, 0, -0.8], '1': [0.7, 0, -0.7] },
      fYaw: { '-1': 2.2, '1': 2.5 }, fPitch: { '-1': 0.04, '1': 0 },
      wr: { '-1': [0.13, 0.93, 0.22], '1': [-0.17, 0.99, 0.02] }, elb: { '-1': [0, -0.5, 1], '1': [-0.6, 0, 0.8] },
      hd: { '-1': [0, -1, 0.1], '1': [0.3, -0.7, -0.5] }, hf: { '-1': [1, 0, 0], '1': [-0.7, 0, -0.7] },
    },
    face: { iris: '#3a6a2a', lid: 'rgba(80,40,20,0.8)', blush: 'rgba(200,80,60,0.35)', brow: '#8a2a10', browAng: -0.2, browArch: 0.5, lips: '#b0302a', eyeTilt: 0.1, eyeOpen: 0.95, grin: 0.9, smirk: 0.8, teeth: true, freckles: true, paint: 'rgba(170,10,16,0.95)', paintSide: -1, mouthW: 1.1 },
    head: { jaw: 1.0, chin: 0.95, lips: 1.05 },
  };

  function surfPt(F, o, dir) { dir = nrm(dir); let p = o; for (let i = 0; i < 80 && F.at(p[0], p[1], p[2]) < 0; i++) p = add(p, scl(dir, 0.004)); return p; }
  // Per-heroine outfit: masks on the body field + skin paint
  function outfit(id, F, rig, D) {
    const { pel, wst, chs } = rig; const TOR = 1, LEGS = 6, ARMS = 24, ALL = 31;
    const by = D.shape.bustY || 0;
    const brief = (topY, wT, wB) => MK.half(pel, q => { const t = clamp((q[1] + 0.12) / (topY + 0.12), 0, 1); return Math.min(wB + (wT - wB) * t * t - Math.abs(q[0]), topY + 0.35 * Math.max(-q[2], 0) - q[1]); });
    const cupMask = (s, rC, neck) => MK.and(
      MK.ell(chs, [s * 0.083, by - 0.022, 0.096], [rC, rC * 1.0, rC * 0.95]),
      MK.half(chs, q => (by + neck) + (s * q[0] - 0.083) * 0.7 - q[1]));
    if (id === 'kaela') {
      const bronze = hx('#b27a2c');
      for (const s of [-1, 1]) {
        F.mask(TOR, cupMask(s, 0.097, 0.06), 0.007, { col: bronze, pid: 1, gloss: 0.7 });
        F.mask(TOR, MK.cap(W(chs, [s * 0.125, 0.075, 0.06]), W(chs, [s * 0.1, 0.19, -0.02]), 0.011), 0.004, { col: hx('#6a4012'), pid: 2, gloss: 0.3 });
      }
      F.mask(TOR, MK.band(chs, q => q[1] + 0.078 - 0.02 * q[2], 0.011), 0.004, { col: hx('#6a4012'), pid: 2, gloss: 0.3 });
      // belt: low slung at front
      F.mask(TOR | LEGS, MK.and(MK.band(pel, q => q[1] - (0.075 - 0.3 * q[2]), 0.026), MK.half(pel, q => 0.3 - Math.abs(q[0]))), 0.01, { col: hx('#3e2212'), pid: 2, gloss: 0.35 });
      F.mask(TOR, MK.ell(pel, [0, 0.045, 0.11], [0.036, 0.03, 0.05]), 0.02, { col: hx('#d19a3c'), pid: 4, gloss: 1.2, pri: 2 });
      // crimson brief under the loincloth (covers groin + cleft)
      F.mask(TOR | LEGS, brief(0.06, 0.085, 0.028), 0.004, { col: hx('#7a1014'), pid: 5, gloss: 0.1 });
      // bronze ankle cuffs + leather bracers
      for (const s of [-1, 1]) {
        const L = rig.leg[s], up = nrm(sub(L.knee, L.ank)), fr = { o: L.ank, R: basisY(up, [0, 0, 1]) };
        F.mask(LEGS, MK.band(fr, q => q[1] - 0.05, 0.022), 0.006, { col: bronze, pid: 4, gloss: 1.2 });
        const A = rig.arm[s], ua = nrm(sub(A.elb, A.wr)), fa = { o: A.wr, R: basisY(ua, [0, 0, 1]) };
        F.mask(ARMS, MK.band(fa, q => q[1] - 0.05, 0.03), 0.004, { col: hx('#4a2a14'), pid: 2, gloss: 0.3 });
      }
      const L = rig.leg[1], out = WD(rig.pel, [0.6, 0, 0.8]);
      F.mask(LEGS, MK.cap(surfPt(F, lerp3(L.knee, L.hip, 0.42), out), surfPt(F, lerp3(L.knee, L.hip, 0.64), add(out, [0.15, 0, -0.1])), 0.0065), 0, { col: hx('#b85a50'), pid: 0, gloss: 0.3, pri: 3 });
    }
    if (id === 'nyx') {
      const indigo = hx('#2c1f62'), silver = hx('#c9d0e4');
      for (const s of [-1, 1]) {
        const panel = MK.or(MK.ell(chs, [s * 0.083, by - 0.02, 0.096], [0.105, 0.105, 0.1]), MK.cap(W(chs, [s * 0.085, 0.03, 0.1]), W(chs, [s * 0.042, 0.17, 0.035]), 0.036));
        F.mask(TOR, MK.and(panel, MK.half(chs, q => s * q[0] - (0.006 + (q[1] + 0.085) * 0.16))), 0.006, { col: indigo, pid: 5, gloss: 0.12 });
        F.mask(TOR, MK.cap(W(chs, [s * 0.042, 0.17, 0.035]), W(chs, [s * 0.02, 0.215, -0.04]), 0.013), 0.005, { col: indigo, pid: 5, gloss: 0.12 });
      }
      F.mask(TOR, MK.band(chs, q => q[1] + 0.085, 0.009), 0.005, { col: silver, pid: 6, gloss: 1.2, pri: 1 });
      // silver chain harness: X across the midriff + waist chain + back chains
      const chainPts = [
        [W(chs, [-0.07, -0.09, 0.085]), W(pel, [0.1, 0.1, 0.075])], [W(chs, [0.07, -0.09, 0.085]), W(pel, [-0.1, 0.1, 0.075])],
        [W(chs, [-0.07, -0.08, -0.09]), W(pel, [0.1, 0.12, -0.08])], [W(chs, [0.07, -0.08, -0.09]), W(pel, [-0.1, 0.12, -0.08])],
      ];
      for (const [a, b] of chainPts) F.mask(TOR, MK.cap(a, b, 0.0055), 0.005, { col: silver, pid: 6, gloss: 1.3, pri: 1 });
      F.mask(TOR, MK.band(wst, q => q[1] + 0.005 + 0.02 * q[2], 0.005), 0.005, { col: silver, pid: 6, gloss: 1.3, pri: 1 });
      // low hip belt (silver) + indigo brief
      F.mask(TOR | LEGS, MK.and(MK.band(pel, q => q[1] - (0.07 - 0.25 * q[2]), 0.014), MK.half(pel, q => 0.3 - Math.abs(q[0]))), 0.007, { col: silver, pid: 4, gloss: 1.3 });
      F.mask(TOR | LEGS, brief(0.06, 0.085, 0.028), 0.004, { col: hx('#1c1440'), pid: 5, gloss: 0.1 });
      for (const s of [-1, 1]) {
        const L = rig.leg[s], up = nrm(sub(L.knee, L.ank)), fr = { o: L.ank, R: basisY(up, [0, 0, 1]) };
        F.mask(LEGS, MK.band(fr, q => q[1] - 0.035, 0.006), 0.005, { col: silver, pid: 6, gloss: 1.3 });
        F.mask(LEGS, MK.band(fr, q => q[1] - 0.055, 0.005), 0.005, { col: silver, pid: 6, gloss: 1.3 });
        F.mask(LEGS, MK.and(MK.ell(L.foot, [-s * 0.017, -0.058, 0.142], [0.02, 0.02, 0.008])), 0.003, { col: silver, pid: 4, gloss: 1.3 });
        const A = rig.arm[s], ua = nrm(sub(A.elb, A.wr)), fa = { o: A.wr, R: basisY(ua, [0, 0, 1]) };
        F.mask(ARMS, MK.band(fa, q => q[1] - 0.03, 0.008), 0.005, { col: silver, pid: 4, gloss: 1.3 });
        F.mask(ARMS, MK.band({ o: A.elb, R: basisY(nrm(sub(A.sh, A.elb)), [0, 0, 1]) }, q => q[1] - 0.2, 0.008), 0.005, { col: silver, pid: 4, gloss: 1.3 });
      }
    }
    if (id === 'vesna') {
      const fur = hx('#3c3a36'), leather = hx('#2a1a10'); // dark wolf-grey fur and near-black leather: must contrast with her skin under firelight
      for (const s of [-1, 1]) {
        F.mask(TOR, cupMask(s, 0.093, 0.062), 0.008, { col: fur, pid: 3, gloss: 0.1 });
        F.mask(TOR, MK.cap(W(chs, [s * 0.125, 0.075, 0.06]), W(chs, [s * 0.08, 0.19, -0.03]), 0.01), 0.004, { col: leather, pid: 2, gloss: 0.3 });
      }
      F.mask(TOR, MK.band(chs, q => q[1] + 0.075 - 0.02 * q[2], 0.01), 0.004, { col: leather, pid: 2, gloss: 0.3 });
      F.mask(TOR | LEGS, MK.and(MK.band(pel, q => q[1] - (0.06 - 0.28 * q[2]), 0.017), MK.half(pel, q => 0.3 - Math.abs(q[0]))), 0.009, { col: leather, pid: 2, gloss: 0.4 });
      F.mask(TOR | LEGS, brief(0.05, 0.085, 0.03), 0.005, { col: hx('#1e140c'), pid: 2, gloss: 0.1 });
      // leather thongs cross-wrapped foot -> knee
      for (const s of [-1, 1]) {
        const L = rig.leg[s], up = nrm(sub(L.knee, L.ank)), fr = { o: L.ank, R: basisY(up, [0, 0, 1]) }, lk = len(sub(L.knee, L.ank));
        F.mask(LEGS, (x, y, z) => {
          const q = toL(fr, x, y, z); if (q[1] < -0.02 || q[1] > lk - 0.05) return -1;
          const a = Math.atan2(q[0], q[2]) / (2 * PI), t = q[1] / 0.075;
          const d1 = Math.abs(((a + t) % 1 + 1.5) % 1 - 0.5), d2 = Math.abs(((a - t) % 1 + 1.5) % 1 - 0.5);
          return (0.07 - Math.min(d1, d2)) * 0.12;
        }, 0.004, { col: leather, pid: 2, gloss: 0.4, rp: 0.002 });
        F.mask(LEGS, MK.band(fr, q => q[1] - (lk - 0.055), 0.01), 0.005, { col: leather, pid: 2, gloss: 0.4 });
        F.mask(LEGS, MK.and(MK.band(L.foot, q => q[2] - 0.05 - q[1] * 0.3, 0.008), MK.half(L.foot, q => q[1] + 0.05)), 0.004, { col: leather, pid: 2, gloss: 0.4 });
        const A = rig.arm[s], ua = nrm(sub(A.elb, A.wr)), fa = { o: A.wr, R: basisY(ua, [0, 0, 1]) };
        F.mask(ARMS, MK.band(fa, q => q[1] - 0.06, 0.035), 0.005, { col: leather, pid: 2, gloss: 0.3 });
      }
      // red war paint on the right thigh (the side toward the viewer)
      const L = rig.leg[-1], da = WD(rig.pel, [-0.9, 0, -0.35]), db = WD(rig.pel, [-0.75, 0, 0.55]);
      for (const t of [0.4, 0.5, 0.6]) F.mask(LEGS, MK.cap(surfPt(F, lerp3(L.knee, L.hip, t), da), surfPt(F, lerp3(L.knee, L.hip, t + 0.05), db), 0.011), 0, { col: hx('#c8141c'), pid: 0, gloss: 0.5, pri: 3 });
    }
  }

  // Props, cloth, hair per heroine
  function extras(id, D, F, HF, rig, cols) {
    const P = new Collector(), Sft = new Collector(); const bodyAt = p => F.at(p[0], p[1], p[2]);
    const hd = rig.head, pel = rig.pel, chs = rig.chs;
    const beltPts = (y0, slope, x0, x1, back, n) => {
      const out = [];
      for (let i = 0; i < n; i++) {
        const x = x0 + (x1 - x0) * i / (n - 1), zs = back ? -1 : 1;
        const pw = W(pel, [x, y0 - slope * 0.12 * zs, 0]), dir = WD(pel, [0, 0, zs]);
        let p = add(pw, scl(dir, 0.3));
        for (let k = 0; k < 80; k++) { const d = bodyAt(p); if (d < 0.013) break; p = add(p, scl(dir, -Math.max(Math.min(d - 0.011, 0.02), 0.001))); }
        out.push(p);
      }
      return out;
    };
    const edgeCol = (base, dark, hem) => (u, v) => (u < 0.08 || u > 0.92 || v > hem) ? mixc(base, dark, 0.55) : base;
    if (id === 'kaela') {
      const crimson = hx('#8c1216'), crD = hx('#3a0406');
      gridMesh(Sft, drape(bodyAt, beltPts(0.045, 0.3, -0.085, 0.085, false, 7), 0.42, 14, { clr: 0.014, taper: 0.8, bias: [0, 0, 0.06], lock: pel, folds: [0.01, 1.5] }), edgeCol(crimson, crD, 0.9), 5, 0.2, v => v * v * 0.8);
      gridMesh(Sft, drape(bodyAt, beltPts(0.1, 0.3, -0.09, 0.09, true, 11), 0.45, 18, { clr: 0.014, taper: 0.85, bias: [0, 0, -0.05], lock: pel, folds: [0.01, 1.5] }), edgeCol(crimson, crD, 0.9), 5, 0.2, v => v * v * 0.8);
      // greatsword planted point-down
      const tip = [0, 0.0, 0.52], top = [0, 1.005, 0.375], ax = nrm(sub(top, tip)), R = basisY(ax, [0, 0, 1]);
      const at = t => add(tip, scl(ax, t));
      const blade = new T.CylinderGeometry(0.5, 0.5, 1, 4, 1); blade.rotateY(PI / 4);
      P.add(blade, M4(at(0.42), R, [0.1, 0.74, 0.022]), '#c8c8d0', 4, 1.4);
      P.add(new T.ConeGeometry(0.5, 1, 4, 1).rotateY(PI / 4).rotateX(PI), M4(at(0.025), R, [0.1, 0.05, 0.022]), '#c8c8d0', 4, 1.4);
      P.add(new T.BoxGeometry(1, 1, 1), M4(at(0.42), R, [0.016, 0.72, 0.026]), '#6a6a78', 4, 0.8);
      P.add(new T.BoxGeometry(1, 1, 1), M4(at(0.785), R, [0.3, 0.035, 0.04]), '#b8862e', 4, 1.3);
      for (const s of [-1, 1]) P.add(new T.SphereGeometry(1, 8, 6), M4(add(at(0.785), mv(R, [s * 0.155, 0.02, 0])), R, 0.025), '#b8862e', 4, 1.3);
      P.add(new T.CylinderGeometry(1, 1, 1, 8), M4(at(0.9), R, [0.019, 0.2, 0.019]), '#3a1e10', 2, 0.3);
      P.add(new T.SphereGeometry(1, 10, 8), M4(at(1.015), R, [0.034, 0.03, 0.034]), '#c8922e', 4, 1.4);
      // spiked bronze pauldron on the right shoulder + fur cape from it
      const A = rig.arm[-1], so = add(A.sh, WD(chs, [-0.02, 0.035, -0.005])), pR = mm(chs.R, eul(0, 0, 0.5));
      for (let i = 0; i < 3; i++) P.add(new T.SphereGeometry(1, 14, 8, 0, PI * 2, 0, PI * 0.5), M4(add(so, mv(pR, [-0.012 * i, -0.028 * i, 0])), pR, [0.1 - i * 0.004, 0.07, 0.11 - i * 0.004]), i ? '#9a6824' : '#b88230', 4, 1.2);
      for (let i = 0; i < 3; i++) P.add(new T.ConeGeometry(0.018, 0.085, 6), M4(add(so, mv(pR, [0.0, 0.07, -0.05 + i * 0.05])), mm(pR, eul(0, 0, 0.35)), 1), '#d8a848', 4, 1.3);
      const capeTop = []; for (let i = 0; i < 10; i++) { const t = i / 9, a = 4.75 - t * 1.75; let p = W(chs, [Math.sin(a) * 0.16, 0.19 - 0.02 * Math.cos(a), Math.cos(a) * 0.12 - 0.01]); const d = WD(chs, [Math.sin(a), 0.2, Math.cos(a)]); for (let k = 0; k < 30 && bodyAt(p) > 0.03; k++) p = sub(p, scl(d, 0.005)); capeTop.push(p); }
      const fur = hx('#6e6050'), furD = hx('#3e342c');
      gridMesh(Sft, ragged(drape(bodyAt, capeTop, 0.95, 22, { clr: 0.025, taper: 1.5, bias: [-0.03, 0, -0.07], stiff: 0.8, folds: [0.04, 3] }), 4, 1), (u, v) => mixc(fur, furD, (hash3(u * 9, v * 30, 1) * 0.5 + (v > 0.93 ? 0.5 : 0))), 3, 0.1, v => v * 0.9);
    }
    if (id === 'nyx') {
      const ind = hx('#2e2066'), indD = hx('#140c30');
      gridMesh(Sft, drape(bodyAt, beltPts(0.085, 0.25, -0.135, 0.135, false, 9), 0.84, 26, { clr: 0.013, taper: 1.2, bias: [0, 0, 0.03], lock: pel, spread: 0.35, folds: [0.012, 2.5] }), edgeCol(ind, indD, 0.95), 5, 0.1, v => v * v);
      gridMesh(Sft, drape(bodyAt, beltPts(0.1, 0.25, -0.14, 0.14, true, 17), 0.9, 34, { clr: 0.022, taper: 1.25, bias: [0, 0, -0.04], lock: pel, spread: 0.3 }), edgeCol(ind, indD, 0.95), 5, 0.4, v => v * v);
      // staff + moon orb
      const bot = [-0.46, 0.0, 0.13], tp = [-0.4, 1.9, 0.1];
      P.add(new T.CylinderGeometry(1, 1, 1, 7), segM(bot, tp, 0.016), '#2a1a14', 8, 0.3);
      const cr = new T.TorusGeometry(0.1, 0.014, 6, 16, PI * 1.35); cr.rotateZ(-PI * 0.18);
      P.add(cr, M4(add(tp, [0, 0.1, 0]), I3), '#c9d0e4', 4, 1.4);
      // moon circlet
      const cR2 = mm(hd.R, rx(-0.25));
      P.add(new T.TorusGeometry(0.083, 0.0045, 5, 28), M4(W(hd, [0, 0.045, -0.012]), mm(cR2, rx(PI / 2)), [1.0, 1.1, 1]), '#d6dcec', 4, 1.4);
      const cc = new T.TorusGeometry(0.02, 0.006, 5, 12, PI * 1.4); cc.rotateZ(PI * 0.8);
      P.add(cc, M4(W(hd, [0, 0.062, 0.082]), hd.R), '#eef2ff', 4, 1.6);
    }
    if (id === 'vesna') {
      const fur = hx('#4a4640'), furD = hx('#1c1a18');
      const furCol = (u, v) => mixc(fur, furD, hash3(u * 13, v * 17, 3) * 0.5 + (v > 0.85 ? 0.35 : 0));
      gridMesh(Sft, ragged(drape(bodyAt, beltPts(0.035, 0.28, -0.085, 0.085, false, 6), 0.26, 9, { clr: 0.016, taper: 0.75, bias: [0, 0, 0.05], lock: pel }), 3, 2), furCol, 3, 0.1, v => v * 0.7);
      gridMesh(Sft, ragged(drape(bodyAt, beltPts(0.09, 0.28, -0.085, 0.085, true, 10), 0.29, 12, { clr: 0.016, taper: 0.8, bias: [0, 0, -0.06], lock: pel }), 3, 3), furCol, 3, 0.1, v => v * 0.7);
      // knife on the hip belt
      const kp = W(pel, [-0.15, 0.03, 0.03]), kR = mm(pel.R, eul(0, 0, -0.25));
      P.add(new T.BoxGeometry(1, 1, 1), M4(add(kp, mv(kR, [0, -0.08, 0])), kR, [0.03, 0.15, 0.022]), '#3a2010', 2, 0.4);
      P.add(new T.CylinderGeometry(1, 1, 1, 6), M4(add(kp, mv(kR, [0, 0.04, 0])), kR, [0.013, 0.08, 0.013]), '#2a1a10', 2, 0.3);
      P.add(new T.SphereGeometry(1, 6, 5), M4(add(kp, mv(kR, [0, 0.085, 0])), kR, 0.017), '#b08040', 4, 1.2);
      // quiver on the back + arrows
      const q0 = W(chs, [-0.02, -0.12, -0.14]), q1 = W(chs, [0.11, 0.2, -0.13]);
      P.add(new T.CylinderGeometry(1, 0.85, 1, 9), segM(q0, q1, 0.045), '#5a3218', 2, 0.4);
      P.add(new T.CylinderGeometry(1, 1, 1, 9), segM(lerp3(q0, q1, 0.9), q1, 0.05), '#8a6030', 4, 0.8);
      const qd = nrm(sub(q1, q0));
      for (let i = 0; i < 5; i++) { const o = WD(chs, [Math.cos(i * 1.3) * 0.025, 0, Math.sin(i * 1.3) * 0.025]), a = add(q1, o), b = add(a, scl(qd, 0.12 + (i % 2) * 0.02));
        P.add(new T.CylinderGeometry(1, 1, 1, 4), segM(a, b, 0.004), '#c8b080', 8, 0.2);
        P.add(new T.ConeGeometry(1, 1, 3), segM(sub(b, scl(qd, 0.02)), add(b, scl(qd, 0.03)), 0.014), '#d8d0c0', 0, 0.2); }
      // longbow held low in the right hand
      const hand = W(rig.arm[-1].hand, [0, 0.045, 0.0]), bAx = nrm([0.12, 1, 0.35]), bSide = nrm(cross(bAx, [1, 0, 0])), pts = [];
      for (let i = 0; i <= 20; i++) { const t = i / 20 * 2 - 1; pts.push(add(add(hand, scl(bAx, t * 0.72)), scl(bSide, (1 - t * t) * 0.12 - 0.02 * Math.pow(Math.abs(t), 4) * 0))); }
      tube(P, pts, t => 0.011 * (1.2 - 0.6 * Math.abs(t * 2 - 1)), '#4a2a14', 8, 0.4, null, 6);
      tube(P, [pts[0], pts[20]], () => 0.0015, '#d8d0b8', 0, 0.1, null, 3);
      P.add(new T.CylinderGeometry(1, 1, 1, 7), segM(add(hand, scl(bAx, -0.06)), add(hand, scl(bAx, 0.06)), 0.017), '#2a1a10', 2, 0.3);
    }
    return { P, Sft };
  }

  // Hair: SDF mass (head-local) + strands/braids in the soft mesh
  function hairField(id) {
    const F = new Field(1, []), O = { o: [0, 0, 0], R: I3 };
    F.ell(0, O, [0, 0.036, -0.02], [0.084, 0.106, 0.106], 0);                 // cap
    F.ell(0, O, [0, 0.09, 0.0], [0.074, 0.056, 0.08], 0.035);                // crown volume
    const lobes = (n, a0, a1, rr, y0, dy, r, k, z0) => { for (let i = 0; i < n; i++) { const t = i / (n - 1), a = a0 + (a1 - a0) * t;
      F.ell(0, O, [Math.sin(a) * rr, y0 - Math.abs(Math.sin(a)) * dy + 0.01 * Math.sin(i * 2.3), Math.cos(a) * rr * 0.8 + (z0 || -0.03)], [r[0], r[1], r[2]], k, { rot: eul(a, 0.25, -Math.sin(a) * 0.3) }); } };
    if (id === 'kaela') {
      lobes(8, 1.7, 4.6, 0.085, 0.04, 0.03, [0.048, 0.08, 0.046], 0.035);
      lobes(6, 2.1, 4.2, 0.08, -0.05, 0.03, [0.045, 0.07, 0.042], 0.03);
      F.ell(0, O, [0, -0.07, -0.1], [0.036, 0.04, 0.035], 0.03);               // nape knot
    }
    if (id === 'nyx') {
      lobes(8, 1.7, 4.6, 0.078, 0.02, 0.03, [0.04, 0.09, 0.036], 0.03);
      for (const s of [-1, 1]) F.cone(0, [s * 0.072, 0.03, -0.01], [s * 0.078, -0.13, -0.035], 0.034, 0.026, 0.04);
    }
    if (id === 'vesna') {
      lobes(9, 1.4, 4.9, 0.1, 0.05, 0.04, [0.055, 0.08, 0.05], 0.03);
      lobes(8, 1.6, 4.7, 0.11, -0.04, 0.03, [0.05, 0.07, 0.05], 0.03);
      lobes(6, 2.0, 4.3, 0.1, -0.12, 0.02, [0.05, 0.07, 0.045], 0.03);
      F.ell(0, O, [0.02, 0.1, 0.03], [0.07, 0.045, 0.06], 0.03, { rot: eul(0.3, 0.3, 0.2) });
    }
    // keep the face clear: carve a face window and a natural hairline
    F.ell(0, O, [0, -0.035, 0.115], [0.066, 0.1, 0.085], 0.02, { sub: true });
    F.ell(0, O, [0, -0.005, 0.105], [0.08, 0.08, 0.07], 0.025, { sub: true });
    return F;
  }
  function hairStrands(id, D, rig, F, HF, HR, Sft) {
    const hd = rig.head, col = hx(D.hair), colD = mixc(col, [0, 0, 0], 0.5), colL = mixc(col, [1, 1, 1], 0.22);
    const both = p => { const q = toL(hd, p[0], p[1], p[2]); return Math.min(F.at(p[0], p[1], p[2]), HF.at(q[0], q[1], q[2]), HR.at(q[0], q[1], q[2])); };
    const braid = (start, lenB, r0, sway, clr, bias) => {
      const path = drape(both, [start], lenB, 26, { clr: clr || r0 * 1.05, bias: bias || [0, 0, -0.05], stiff: 0.8 }).map(r => r[0]);
      const pts = []; const n = path.length;
      for (let i = 0; i < n - 1; i++) for (let k = 0; k < 3; k++) pts.push(lerp3(path[i], path[i + 1], k / 3)); pts.push(path[n - 1]);
      tube(Sft, pts, t => r0 * (1 - 0.45 * t) * (0.72 + 0.28 * Math.abs(Math.sin(t * 60))), t => mixc(col, colD, 0.5 * Math.abs(Math.cos(t * 60))), 7, 0.4, t => t * sway, 7);
      tube(Sft, pts.slice(-4).concat([add(pts[pts.length - 1], scl(nrm(sub(pts[pts.length - 1], pts[pts.length - 2])), 0.06))]), t => r0 * 0.5 * (1 - t * 0.7), colD, 7, 0.3, () => sway, 6);
      return path;
    };
    if (id === 'kaela') braid(W(hd, [0, -0.06, -0.1]), 0.6, 0.043, 0.5, 0.045, [0, 0, -0.02]);
    if (id === 'vesna') braid(W(hd, [0.06, -0.06, -0.09]), 0.55, 0.036, 0.6, 0.038, [0.02, 0, 0.1]);
    const C = {
      kaela: { n: 16, a0: 1.9, a1: 4.4, el: [-0.3, 0.6], len: [0.16, 0.3], w: 0.036, rows: 8, out: 0.04, taper: 0.4 },
      nyx: { n: 34, a0: 1.25, a1: 5.03, el: [-0.2, 1.0], len: [0.48, 0.64], w: 0.042, rows: 22, out: 0.03, taper: 0.5 },
      vesna: { n: 30, a0: 1.15, a1: 5.13, el: [-0.35, 1.0], len: [0.2, 0.38], w: 0.055, rows: 11, out: 0.1, taper: 0.4 },
    }[id];
    const c0 = [0, 0.03, -0.02];
    for (let i = 0; i < C.n; i++) {
      const h1 = hash3(i, 7, 1), h2 = hash3(i, 3, 9), h3 = hash3(i, 5, 2);
      const a = C.a0 + (C.a1 - C.a0) * (i + 0.5 * h1) / C.n, el = C.el[0] + (C.el[1] - C.el[0]) * h2;
      const dir = [Math.sin(a) * Math.cos(el), Math.sin(el), Math.cos(a) * Math.cos(el)];
      let q = add(c0, scl(dir, 0.05));
      for (let k = 0; k < 60 && HR.at(q[0], q[1], q[2]) < 0.003; k++) q = add(q, scl(dir, 0.004));
      const side = nrm([Math.cos(a), 0, -Math.sin(a)]), w = C.w * (0.8 + 0.4 * h3);
      const top = [W(hd, add(q, scl(side, -w / 2))), W(hd, add(q, scl(side, w / 2)))];
      const ow = WD(hd, [Math.sin(a), 0, Math.cos(a)]);
      const bias = [ow[0] * C.out * (0.5 + h3), 0, ow[2] * C.out * (0.5 + h3) - 0.03];
      const g = drape(both, top, C.len[0] + (C.len[1] - C.len[0]) * h1, C.rows, { clr: 0.006, bias, taper: C.taper, stiff: 0.7 });
      const base = mixc(col, h2 > 0.5 ? colL : colD, 0.25 + 0.3 * h3);
      gridMesh(Sft, g, (u, v) => mixc(base, colD, (u < 0.2 || u > 0.8 ? 0.35 : 0) + v * 0.25), 7, 0.4, v => v * 0.8);
    }
    // crown strands: start at the hairline and sweep back over the mass
    const TOPN = { kaela: [11, 0.26, 0.34], nyx: [13, 0.5, 0.64], vesna: [12, 0.3, 0.42] }[id];
    for (let i = 0; i < TOPN[0]; i++) {
      const h1 = hash3(i, 11, 4), h2 = hash3(i, 2, 8);
      const a = -1.0 + 2.0 * (i + 0.5) / TOPN[0], el = 0.55 + 0.35 * h2;
      const dir = [Math.sin(a) * Math.cos(el), Math.sin(el), Math.cos(a) * Math.cos(el)];
      let q = add(c0, scl(dir, 0.05));
      for (let k = 0; k < 60 && HR.at(q[0], q[1], q[2]) < 0.002; k++) q = add(q, scl(dir, 0.004));
      const side = nrm([Math.cos(a), 0, -Math.sin(a)]), w = 0.04 + 0.015 * h1;
      const top = [W(hd, add(q, scl(side, -w / 2))), W(hd, add(q, scl(side, w / 2)))];
      const back = WD(hd, [Math.sin(a) * 0.35, 0.9, -1.0]);
      const g = drape(both, top, TOPN[1] + (TOPN[2] - TOPN[1]) * h1, id === 'nyx' ? 22 : 12, { clr: 0.005, bias: scl(back, 1.2), decay: 0.55, taper: 0.45, stiff: 0.7 });
      const base = mixc(col, h2 > 0.4 ? colL : colD, 0.3);
      gridMesh(Sft, g, (u, v) => mixc(base, colD, (u < 0.2 || u > 0.8 ? 0.3 : 0) + v * 0.2), 7, 0.5, v => v * 0.7);
    }
  }

  // ── Build: bake everything into one cached set of geometries ──────────────
  const cache = {};
  function bakeBody(F, rig, D, h) {
    const bnd = F.bounds(0.035); bnd[1] = Math.max(bnd[1], -0.02);
    const pg = polygonize(F, bnd, h, 2);
    const nv = pg.nv, c0 = new Float32Array(nv * 3), c1 = new Float32Array(nv * 3), cl = new Float32Array(nv * 4);
    const skin = hx(D.skin), knee = mixc(skin, hx('#c05a48'), 0.25);
    const bits = [];
    for (let v = 0; v < nv; v++) {
      const x = pg.pos[v * 3], y = pg.pos[v * 3 + 1], z = pg.pos[v * 3 + 2];
      F.eval(x, y, z, pg.lists[pg.VB[v]]);
      let gi = 0; for (let i = 1; i < F.ng; i++) if (F.gv[i] < F.gv[gi]) gi = i;
      let best = null, bsd = -1e9, bsc = -1e9;
      for (const M of F.masks) {
        if (!(M.gm & (1 << gi))) continue; const sd = M.fn(x, y, z); if (sd < -0.012) continue;
        const sc = sd + (sd > -0.003 ? M.pri * 10 : 0); if (sc > bsc) { bsc = sc; best = M; bsd = sd; }
      }
      let c = skin;
      // warm knees / elbows / feet
      const kd = Math.min(...[-1, 1].map(s => len(sub([x, y, z], rig.leg[s].knee))));
      if (kd < 0.06) c = mixc(knee, c, kd / 0.06);
      if (y < 0.03) c = mixc(knee, c, clamp(y / 0.03, 0, 1));
      if (F.paint) c = F.paint(x, y, z, c);
      c0.set(c, v * 3);
      if (best) { c1.set(best.col, v * 3); cl[v * 4] = bsd; cl[v * 4 + 1] = best.pid; cl[v * 4 + 2] = best.gloss; }
      else { c1.set(c, v * 3); cl[v * 4] = -1; }
    }
    return geoFrom(pg.pos, pg.nor, pg.idx, c0, c1, cl);
  }
  function bakeLocal(F, fr, h, colFn, uvFn, pad) {
    const pg = polygonize(F, F.bounds(pad || 0.02), h, 2);
    const nv = pg.nv, pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), c0 = new Float32Array(nv * 3), c1 = new Float32Array(nv * 3), cl = new Float32Array(nv * 4), uv = uvFn ? new Float32Array(nv * 2) : null;
    for (let v = 0; v < nv; v++) {
      const l = [pg.pos[v * 3], pg.pos[v * 3 + 1], pg.pos[v * 3 + 2]], n = [pg.nor[v * 3], pg.nor[v * 3 + 1], pg.nor[v * 3 + 2]];
      pos.set(W(fr, l), v * 3); nor.set(WD(fr, n), v * 3);
      const r = colFn(l, n); c0.set(r.c0, v * 3); c1.set(r.c1, v * 3); cl.set(r.cl, v * 4);
      if (uv) { const u = uvFn(l); uv[v * 2] = u[0]; uv[v * 2 + 1] = u[1]; }
    }
    return geoFrom(pos, nor, pg.idx, c0, c1, cl, uv);
  }
  function bake(id) {
    if (cache[id]) return cache[id];
    const t0 = performance.now(), D = DEF[id];
    const TM = {}; let tm = performance.now(); const mark = k => { const n = performance.now(); TM[k] = Math.round(n - tm); tm = n; };
    const rig = makeRig(D.pose);
    const F = bodyField(rig, D.shape);
    outfit(id, F, rig, D);
    const body = bakeBody(F, rig, D, 0.0115); mark('body');
    const HFs = headField(D.head), skin = hx(D.skin);
    const head = bakeLocal(HFs, rig.head, 0.0061, (l, n) => ({ c0: skin, c1: [sstep(0.0, 0.3, n[2]) * sstep(-0.13, -0.1, l[1]), 0, 0], cl: [-1, 0, 0, 0] }), l => [0.5 + l[0] / 0.2, 0.5 + (l[1] + 0.02) / 0.2]); mark('head');
    const HR = hairField(id), hc = hx(D.hair);
    const hair = bakeLocal(HR, rig.head, id === 'vesna' ? 0.0115 : 0.0098, (l, n) => ({ c0: hc, c1: hc, cl: [1, 7, 0.45, 0] })); mark('hair');
    const { P, Sft } = extras(id, D, F, HFs, rig); mark('extras');
    hairStrands(id, D, rig, F, HFs, HR, Sft); mark('strands');
    const faceTex = paintFace(D.face); mark('paint');
    const out = { body, head, hair, prop: P.build(), soft: Sft.build(), faceTex, rig, ms: 0, TM, F };
    out.ms = performance.now() - t0;
    const tri = g => g ? g.index.count / 3 : 0;
    out.tris = { body: tri(body), head: tri(head), hair: tri(hair), prop: tri(out.prop), soft: tri(out.soft) };
    out.tris.total = out.tris.body + out.tris.head + out.tris.hair + out.tris.prop + out.tris.soft;
    cache[id] = out; return out;
  }

  function build(id) {
    const B = bake(id), D = DEF[id];
    const mats = heroMats({ faceTex: B.faceTex, skinGloss: D.skinGloss, phase: D.phase });
    mats.unis.uChest.value.set(B.rig.chs.o[0], B.rig.chs.o[1] - 0.01, B.rig.chs.o[2]);
    mats.unis.uHC.value.set(...B.rig.head.o);
    const g = new T.Group(); g.name = 'heroine_' + id;
    const add2 = (geo, m, ink) => { if (!geo) return; const me = new T.Mesh(geo, m); me.castShadow = true; g.add(me); if (ink) { const o = new T.Mesh(geo, mats.ink); o.renderOrder = -1; g.add(o); } };
    add2(B.body, mats.body, true); add2(B.head, mats.head, true); add2(B.hair, mats.prop, true); add2(B.prop, mats.prop, true); add2(B.soft, mats.soft, false);
    if (id === 'nyx') {
      const orb = new T.Mesh(new T.SphereGeometry(0.075, 16, 12), new T.MeshBasicMaterial({ color: new T.Color(0.75, 0.7, 1.6) }));
      orb.position.set(-0.4, 1.99, 0.1); g.add(orb);
      const halo = new T.Mesh(new T.SphereGeometry(0.14, 16, 12), new T.MeshBasicMaterial({ color: new T.Color(0.35, 0.2, 0.9), transparent: true, opacity: 0.35, blending: T.AdditiveBlending, depthWrite: false }));
      halo.position.copy(orb.position); g.add(halo);
      const pl = new T.PointLight(0x9a80ff, 1.6, 3.5, 1.5); pl.position.copy(orb.position); g.add(pl);
      g.userData.orb = orb; g.userData.halo = halo;
    }
    g.userData.id = id; g.userData.stats = { ms: B.ms, tris: B.tris, draws: g.children.filter(c => c.isMesh).length };
    g.userData.update = (dt, t) => {
      U.uT.value = t;
      if (g.userData.halo) { const k = 1 + 0.12 * Math.sin(t * 2.3); g.userData.halo.scale.setScalar(k); }
    };
    return g;
  }

  CT.heroines = { build, bake, IDS: ['kaela', 'nyx', 'vesna'], uniforms: U, DEF, clear() { for (const k in cache) delete cache[k]; } };
})();
