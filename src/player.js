// ─── PLAYER: movement, camera, combat and the first-person hands ─────────────
(function () {
  const C = CT.config, P = C.PLAYER, DEG = Math.PI / 180, W = 640, H = 360;
  const PL = CT.player = {
    pos: new THREE.Vector3(C.START.x, 0, C.START.z), vel: new THREE.Vector3(), yaw: 0, pitch: 0, roll: 0,
    hp: P.hp, stamina: P.stamina, alive: true, blocking: false, dodging: false, prompt: null, god: false,
    torchLit: true, drawMs: 0,
  };

  // ── Helpers ────────────────────────────────────────────────────────────────
  const has = (m, f) => !!(CT[m] && typeof CT[m][f] === 'function' && !(CT._broken && CT._broken[m]));
  const sfx = (n, o) => { if (has('audio', 'sfx')) CT.audio.sfx(n, o); };
  const emit = (n, d) => { if (CT.bus) CT.bus.emit(n, d); };
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const mod = (a, n) => ((a % n) + n) % n;
  const ease = k => k * k * (3 - 2 * k);
  const easeOut = k => 1 - (1 - k) * (1 - k);
  function hAt(x, z) { if (has('world', 'heightAt')) { const h = CT.world.heightAt(x, z); if (typeof h === 'number' && h === h) return h; } return 0; }
  function wAt(x, z) { if (has('world', 'waterAt')) { const d = CT.world.waterAt(x, z); if (d > 0) return d; } return 0; }
  const hpMax = () => (CT.rpg && CT.rpg.stats && CT.rpg.stats.hpMax) || P.hp;
  const stMax = () => (CT.rpg && CT.rpg.stats && CT.rpg.stats.staminaMax) || P.stamina;
  function equipped(slot) { const e = CT.rpg && CT.rpg.equipped, id = e && e[slot]; return id ? C.ITEMS[id] || null : null; }
  let wCache = null, wId = null, wStr = null, wAge = 0;
  function weapon() {                                          // cached: rpg.weapon() builds a new object per call
    const r = CT.rpg, id = r && r.equipped ? r.equipped.weapon : null, str = r && r.stats ? r.stats.str : null;
    if (!wCache || id !== wId || str !== wStr || ++wAge > 120) {
      wId = id; wStr = str; wAge = 0;
      const w = has('rpg', 'weapon') ? CT.rpg.weapon() : null;
      wCache = w && typeof w.damage === 'number' ? w : C.ITEMS.rustsword;
    }
    return wCache;
  }
  function kindOf(w) {
    const id = CT.rpg && CT.rpg.equipped && CT.rpg.equipped.weapon, I = C.ITEMS;
    if (id === 'moonblade' || w.id === 'moonblade' || w === I.moonblade || w.name === I.moonblade.name) return 'moon';
    if (id === 'rustsword' || w.id === 'rustsword' || w === I.rustsword || w.name === I.rustsword.name) return 'rust';
    return KINDS[w.style] ? w.style : 'sword';
  }

  // ── Pixel painter (from ref/hands.js): colour ramps, dither, layered outlines ──
  const hex = h => { const n = parseInt(h.slice(1), 16); return ((255 << 24) | ((n & 255) << 16) | (n & 0xff00) | (n >>> 16)) >>> 0; };
  const ramp = a => a.map(hex);
  const B4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const bay = (x, y) => (B4[(x & 3) + ((y & 3) << 2)] + 0.5) / 16;
  const norm3 = (x, y, z) => { const l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; };
  const lit = (nx, ny, nz, L) => Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
  const hsh = (x, y) => { let h = (x * 374761393 + y * 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  function vnoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = hsh(xi, yi), b = hsh(xi + 1, yi), c = hsh(xi, yi + 1), d = hsh(xi + 1, yi + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  }
  function tone(r, l, x, y) {
    const f = clamp(l, 0, 1) * (r.length - 1); let i = f | 0;
    if (((f - i) - 0.5) * 9 + 0.5 > bay(x, y)) i++;
    return r[Math.min(i, r.length - 1)];
  }
  const toneH = (r, l) => r[Math.round(clamp(l, 0, 1) * (r.length - 1))];

  const SKIN = ramp(['#3a160c', '#6a2e18', '#9c4f2a', '#c87846', '#e8a468', '#ffd49a']);
  const LEATH = ramp(['#2a1408', '#4a2610', '#6e3c1a', '#935828', '#b87a40']);
  const STRAP = ramp(['#1e0e06', '#3a1c0c', '#5a3016', '#7c4a24']);
  const BRONZE = ramp(['#3a1c06', '#6a3a0e', '#a0621c', '#d0922e', '#f2c25a', '#fff0b0']);
  const TAN = ramp(['#4a2a12', '#7e5028', '#b0804a', '#d8ac6c', '#f0d096']);
  const WOOD = ramp(['#2e160a', '#502a14', '#76421e', '#9a5e30']);
  const IRON = ramp(['#1c1e26', '#3e434f', '#676e7e', '#9aa2b2', '#d0d6e2']);
  const CHAR = ramp(['#1a100a', '#2e1f16', '#4a3222', '#654630']);
  const EMBR = ramp(['#5a1406', '#a02c0a', '#e05a16', '#ff9a28', '#ffd060']);
  const GRIP = ramp(['#2a1308', '#4a2812', '#744020', '#a0643a']);
  const REDL = ramp(['#2a0606', '#5a0e0c', '#8a1c14', '#b83a24']);
  const ST = ramp(['#1a1e2a', '#3e4656', '#6c7688', '#a2acbc', '#d6dce8', '#ffffff']);
  const RUSTR = ramp(['#2a140a', '#5a2c12', '#8a4a1e', '#a8643a', '#c08a64']);
  const MOONR = ramp(['#2e3a5a', '#6a7aa0', '#a4b4d4', '#d0dcf2', '#ecf2ff', '#ffffff']);
  const BLK = ramp(['#050304', '#110809', '#1e1014', '#2e1a20', '#46282e', '#643a44']);
  const RED = ramp(['#3a0204', '#760610', '#b8121a', '#f0301e', '#ff7a4a', '#ffd2a8']);
  const GEMR = ramp(['#300406', '#7a0a12', '#d02428', '#ff9a8a']);
  const GEMM = ramp(['#1a3a6a', '#4a8ad0', '#a8e0ff', '#ffffff']);
  const O_SKIN = hex('#2a0e08'), O_LEATH = hex('#1a0c06'), O_STEEL = hex('#0c0e16'), O_BRONZE = hex('#241002'), O_WOOD = hex('#1a0c06'), O_CHAR = hex('#0e0806'), O_BLK = hex('#000000');

  // Layers of shapes painted into a pixel buffer; each layer gets a 1 px outline.
  // T maps a pixel centre to layer coords: u = T0*x + T1*y + T2, v = T3*x + T4*y + T5.
  function paint(w, h, T, layers, vmax) {
    const n = w * h, d = new Uint32Array(n), m = new Uint8Array(n), U = new Float64Array(n), V = new Float64Array(n), ok = new Uint8Array(n);
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
      const px = x + 0.5, py = y + 0.5, v = T[3] * px + T[4] * py + T[5];
      U[i] = T[0] * px + T[1] * py + T[2]; V[i] = v; ok[i] = v > -vmax && v < vmax ? 1 : 0;
    }
    const out = [];
    layers.forEach((L, li) => {
      const id = li + 1, f = L[0];
      for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) { if (!ok[i]) continue; const c = f(U[i], V[i], x, y); if (c) { d[i] = c; m[i] = id; } }
      if (!L[1]) return;
      out.length = 0;
      for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
        if (m[i] === id) continue;
        if ((x > 0 && m[i - 1] === id) || (x < w - 1 && m[i + 1] === id) || (y > 0 && m[i - w] === id) || (y < h - 1 && m[i + w] === id)) out.push(i);
      }
      for (const i of out) { d[i] = L[1]; m[i] = id; }
    });
    return { d, w, h };
  }
  function toCanvas(p) {
    const cv = document.createElement('canvas'); cv.width = p.w; cv.height = p.h;
    cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(p.d.buffer), p.w, p.h), 0, 0);
    return cv;
  }
  // Capsule with a muscle bulge: sets the normal (CNX..CNZ), the length along (CA) and the cross fraction (CS).
  let CA = 0, CS = 0, CNX = 0, CNY = 0, CNZ = 1;
  function cyl(x, y, ax, ay, bx, by, r0, r1, bg) {
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len;
    const px = x - ax, py = y - ay, a = px * ux + py * uy, t = clamp(a / len, 0, 1);
    const r = r0 + (r1 - r0) * t + (bg || 0) * Math.sin(Math.PI * clamp(t * 1.4 - 0.15, 0, 1)), cx = ax + ux * len * t, cy = ay + uy * len * t;
    const ex = x - cx, ey = y - cy, dd = ex * ex + ey * ey;
    if (dd > r * r) return false;
    CA = a; CS = (px * -uy + py * ux) / r;
    CNX = ex / r; CNY = ey / r; CNZ = Math.sqrt(Math.max(0, 1 - CNX * CNX - CNY * CNY));
    return true;
  }

  // ── Arms: heroic tanned forearms (local origin = centre of the fist) ───────
  const LA = norm3(-0.5, -0.62, 0.6);
  function forearm(xm, Y, x, y, type) {
    if (!cyl(xm, Y, 13, 4, 115, 140, 11.5, 25, 3.5)) return 0;
    const a = CA; let l = 0.1 + 0.9 * lit(CNX, CNY, CNZ, LA);
    if (a < 11) return toneH(SKIN, l);
    const bare = type === 'R' ? 66 : 70;
    if (a > bare) {                                                          // bare forearm: veins, muscle ridge, an old scar
      const v1 = Math.abs(CS - 0.18 - 0.2 * Math.sin(a * 0.07)), v2 = Math.abs(CS + 0.32 + 0.12 * Math.sin(a * 0.1 + 1));
      if (v1 < 0.05 || v2 < 0.04) l += 0.12; else if (v1 < 0.09 || v2 < 0.07) l -= 0.07;
      l += 0.08 * Math.cos(CS * 2.4 - 0.5) - 0.04;
      if (a > 96 && a < 118 && Math.abs(CS - (a - 107) * 0.045) < 0.055) return SKIN[4];
      return toneH(SKIN, l);
    }
    if (type === 'R') {
      if (a < 24) {                                                          // leather wrist wraps
        const s = mod(a * 0.9 + CS * 5, 4.5);
        if (s < 0.9) return tone(STRAP, l * 0.6, x, y);
        return tone(LEATH, l + (s < 1.7 ? 0.12 : 0), x, y);
      }
      if (a < 61) {                                                          // bronze bracer, embossed ridges and rivets
        if (a < 26.5 || a > 58.5) return tone(BRONZE, l + 0.2, x, y);
        if (a < 27.6 || a > 57.4) return tone(BRONZE, l - 0.35, x, y);
        if ((Math.abs(a - 32) < 1.5 || Math.abs(a - 53) < 1.5) && Math.abs(Math.abs(CS) - 0.66) < 0.08) return BRONZE[5];
        for (let c = -0.42; c < 0.5; c += 0.42) { const d = CS - c; if (Math.abs(d) < 0.07) l += 0.24; else if (d > 0.07 && d < 0.15) l -= 0.22; }
        if (hsh(x, y) < 0.03) l -= 0.25;
        return tone(BRONZE, l, x, y);
      }
      return tone(STRAP, l, x, y);
    }
    const lace = mod(a + CS * 7, 9), lace2 = mod(a - CS * 7, 9);                // off-hand: laced leather bracer
    if (CS > -0.45 && CS < 0.45 && (lace < 1.6 || lace2 < 1.6)) return tone(BRONZE, l * 0.7 + 0.15, x, y);
    if (Math.abs(CS) > 0.45 && Math.abs(CS) < 0.58) l -= 0.25;
    if (a < 13 || a > bare - 3) l += 0.14;
    return tone(LEATH, l, x, y);
  }
  const BCX = 13 + 0.6 * 50, BCY = 4 + 0.8 * 50, BR = 31;
  function buckler(xm, Y, x, y) {                                            // round bronze buckler strapped to the off-hand
    const dx = xm - BCX, dy = (Y - BCY) * 1.08, d = Math.hypot(dx, dy) / BR;
    if (d >= 1) return 0;
    const nx = dx / BR, ny = dy / BR;
    let l = 0.12 + 0.88 * lit(nx * 0.55, ny * 0.55, Math.sqrt(1 - d * d * 0.3), LA);
    if (d > 0.88) return tone(BRONZE, l + (d > 0.95 ? -0.25 : 0.22), x, y);
    if (d > 0.84) return BRONZE[1];
    if (d < 0.26) { const q = d / 0.26; return tone(IRON, 0.15 + 0.85 * lit(nx / 0.26, ny / 0.26, Math.sqrt(Math.max(0, 1 - q * q)), LA) + (q < 0.3 ? 0.2 : 0), x, y); }
    if (d < 0.3) return IRON[0];
    const ang = Math.atan2(dy, dx);
    if (Math.abs(d - 0.72) < 0.05 && mod(ang / (Math.PI / 6), 1) < 0.2) return BRONZE[5];
    if (mod(d * 9, 1) < 0.12) l -= 0.12;
    l += (vnoise(xm * 0.35, Y * 0.35) - 0.5) * 0.3;
    if (Math.abs(dx + dy * 0.6 - 8) < 0.6 && d > 0.35 && d < 0.8) l -= 0.35;   // a gash from an old fight
    return tone(BRONZE, l, x, y);
  }
  function backOfHand(xm, Y) {
    if (xm < -9 || xm > 19 || Y < -12 || Y > 14) return 0;
    const nx = (xm - 5) / 12.5, ny = (Y - 1) / 11.5, q = nx * nx + ny * ny;
    if (q > 1) return 0;
    let l = 0.12 + 0.88 * lit(nx, ny, Math.sqrt(1 - q), LA);
    if (Math.abs(xm - 1) < 0.9 && Y > -7 && Y < 9 && ((Y + 40) % 5 < 1.2)) l -= 0.2;
    return toneH(SKIN, l);
  }
  function finger(k) {
    const yk = -7.2 + k * 4.9;
    return (xm, Y) => {
      if (xm < -16 || xm > 9 || Y < yk - 5 || Y > yk + 6) return 0;
      if (!cyl(xm, Y, -10.5 + k * 0.6, yk, 4, yk + 0.6, 3.8, 4)) return 0;
      let l = 0.14 + 0.86 * lit(CNX, CNY, CNZ, LA);
      if (CA < 1.4) l += 0.08;
      if (CA > 9 && CA < 10.2) l -= 0.18;
      return toneH(SKIN, l);
    };
  }
  function thumb(xm, Y) {
    if (xm < -12 || xm > 16 || Y < -17 || Y > -2) return 0;
    if (!cyl(xm, Y, 11, -7.5, -7, -11.2, 4.5, 3.8)) return 0;
    const l = 0.2 + 0.8 * lit(CNX, CNY, CNZ, LA);
    if (CA > 15 && CNY < -0.2) return toneH(SKIN, 0.95);
    return toneH(SKIN, l);
  }

  // ── Torch (left arm sprite coordinates, leaning 16 degrees toward the centre) ──
  const TA = 16 * DEG, TD = [Math.sin(TA), -Math.cos(TA)], TN = [Math.cos(TA), Math.sin(TA)];
  const LT = norm3(0.3, -0.55, 0.78), T_TOP = 86;
  function shaftFn(X, Y, x, y) {
    const u = X * TD[0] + Y * TD[1], v = X * TN[0] + Y * TN[1];
    if (u < -38 || u > 58) return 0;
    const band = (u > 22 && u < 26.5) || (u > 50.5 && u < 56);
    let r = 4.8 - 0.8 * (u + 38) / 96; if (band) r += 1;
    if (v < -r || v > r) return 0;
    const cs = v / r, nz = Math.sqrt(1 - cs * cs), l = 0.12 + 0.88 * lit(cs * TN[0], cs * TN[1], nz, LT);
    if (band) return tone(IRON, l, x, y);
    const p1 = mod(u + cs * 7, 11), p2 = mod(u - cs * 7 + 5.5, 11);
    if (u < 49 && (p1 < 2.3 || p2 < 2.3)) return (p1 < 0.75 || p2 < 0.75) ? tone(STRAP, l * 0.5, x, y) : tone(TAN, l * 0.95 + 0.05, x, y);
    return tone(WOOD, l + (hsh(Math.round(u / 4), Math.round(cs * 2)) - 0.5) * 0.2, x, y);
  }
  function headFn(X, Y, x, y) {
    const u = X * TD[0] + Y * TD[1], v = X * TN[0] + Y * TN[1];
    if (u < 54 || u > T_TOP + 1) return 0;
    let r = 5.6 + 4.4 * Math.pow(clamp((u - 54) / 28, 0, 1), 0.55);
    if (u > 83) r *= Math.sqrt(Math.max(0, 1 - ((u - 83) / 4) ** 2)) * 0.25 + 0.75;
    if (v < -r || v > r) return 0;
    const cs = v / r, nz = Math.sqrt(1 - cs * cs);
    let l = 0.1 + 0.8 * lit(cs * TN[0], cs * TN[1], nz, LT);
    if (mod(u - 54 - cs * 3, 5) < 1.3) l -= 0.3;
    const hot = (u - 74) / 12;
    if (hot > 0 && hot + (bay(x, y) - 0.5) * 0.45 > 0.28) return tone(EMBR, clamp(hot * 1.1 + l * 0.35 - Math.abs(cs) * 0.3, 0, 1), x, y);
    if (u > 60 && hsh(x, y) < 0.035) return hsh(y, x) < 0.5 ? hex('#ff8a20') : hex('#ffc848');
    return tone(CHAR, l, x, y);
  }

  // Arm sprites: R = sword arm, T = torch arm, B = buckler arm, F = bare off-hand fist (potion, greatsword grip).
  const HS = 2.2, TS = 1.75, ARMS = {};
  function buildArm(type) {
    const mir = type === 'R' ? 1 : -1, torch = type === 'T';
    const x0 = mir > 0 ? -60 : -250, x1 = mir > 0 ? 250 : 60;
    const y0 = torch ? -Math.ceil((T_TOP + 3) * TS) : -50, y1 = 300;
    const layers = [], sc = f => (X, Y, x, y) => f(X * mir / HS, Y / HS, x, y);
    if (torch) layers.push([(X, Y, x, y) => shaftFn(X / TS, Y / TS, x, y), O_WOOD], [(X, Y, x, y) => headFn(X / TS, Y / TS, x, y), O_CHAR]);
    layers.push([sc((xm, Y, x, y) => forearm(xm, Y, x, y, type)), O_LEATH]);
    if (type === 'B') layers.push([sc(buckler), O_BRONZE]);
    layers.push([sc(backOfHand), O_SKIN]);
    for (let k = 3; k >= 0; k--) layers.push([sc(finger(k)), O_SKIN]);
    layers.push([sc(thumb), O_SKIN]);
    const p = paint(x1 - x0, y1 - y0, [1, 0, x0, 0, 1, y0], layers, 1e9);
    return (ARMS[type] = { cv: toCanvas(p), ox: -x0, oy: -y0, p, blood: [] });
  }
  const arm = t => ARMS[t] || buildArm(t);
  // Blood that soaks the hands: overlays baked per level (8 steps), darkest nearest the fist.
  const BLR = ramp(['#2a0204', '#4e0508', '#7a0a10', '#a8141a', '#d0302c']), BLD = ramp(['#1e0604', '#3a0c08', '#58160e', '#6e2214']), BL_H = hex('#f06a58');
  function armBlood(A, q) {
    if (A.blood[q]) return A.blood[q];
    const wet = q > 8, { d, w, h } = A.p, o = new Uint32Array(w * h), lvl = (q % 9) / 8 * 0.88;
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
      const c = d[i]; if (!c) continue;
      const dd = Math.hypot(x - A.ox, (y - A.oy) * 0.9) / 170;
      let th = 0.08 + dd * 1.4 + (vnoise(x / 26 + 3, y / 26) - 0.5) * 0.9 + (vnoise(x / 6, y / 6) - 0.5) * 0.12;
      if (y > A.oy && hsh(x >> 1, 91) < 0.09) th -= 0.3 * vnoise(x / 3, y / 45);   // runs down the forearm
      const e = lvl - th;
      if (e < 0) continue;
      const lum = ((c & 255) * 0.3 + ((c >> 8) & 255) * 0.59 + ((c >> 16) & 255) * 0.11) / 255;   // keep the form readable under the blood
      o[i] = wet && hsh(x, y) < 0.045 && lum > 0.4 ? BL_H : tone(wet ? BLR : BLD, clamp(lum * (wet ? 1.2 : 0.95) + (e < 0.06 ? 0.2 : 0) - (e > 0.3 ? 0.12 : 0), 0, 1), x, y);
    }
    return (A.blood[q] = toCanvas({ d: o, w, h }));
  }

  // ── Weapons (local u = along the blade from the fist, v = across) ─────────
  const LS = norm3(-0.55, 0.55, 0.63);
  function mkGrip(o) {
    return (u, v, x, y) => {
      if (u < o.pu - o.pr - 1 || u > o.g1) return 0;
      const pd = Math.hypot(u - o.pu, v);
      if (pd < o.pr) return tone(o.pRamp, 0.1 + 0.9 * lit(v / o.pr, (u - o.pu) / o.pr, Math.sqrt(Math.max(0, 1 - pd * pd / (o.pr * o.pr))), LS) + (pd < o.pr * 0.3 ? 0.25 : 0), x, y);
      if (u < o.g0 || Math.abs(v) > o.r) return 0;
      const cs = v / o.r; let l = 0.15 + 0.85 * lit(cs, 0, Math.sqrt(1 - cs * cs), LS);
      if (mod(u + v * 0.9, 3.6) < 1.2) l -= 0.34;
      return tone(o.ramp, l, x, y);
    };
  }
  function mkBlade(o) {
    const R = o.ramp, n = R.length - 1;
    const hw = u => {
      if (u < o.ut) { let h = o.w + (o.wt - o.w) * (u - o.u0) / (o.ut - o.u0); if (o.wave) h += Math.sin((u - o.u0) * 0.19) * o.wave; return h; }
      return o.wt * (o.utip - u) / (o.utip - o.ut);
    };
    const f = (u, v, x, y) => {
      if (u < o.u0 - 1 || u > o.utip) return 0;
      let h = hw(Math.max(u, o.u0));
      if (o.nicks && v > 0 && hsh(u | 0, 3) < 0.07) h -= 1.2;
      if (v < -h || v > h) return 0;
      const edgeL = v < -h + 1.3, edgeR = v > h - 1.3;
      if (o.edge && (edgeL || edgeR)) return o.edge[edgeL ? 1 : 0];
      let i;
      if (edgeL) i = n; else if (edgeR) i = 1;
      else if (u > o.ut - 2) i = v < 0 ? n - 1 : 2;
      else {
        const s = u - o.u0, streak = Math.abs(s - 78 + v * 1.8) < 5 || Math.abs(s - 24 + v * 1.8) < 2.4;
        i = v < 0 ? (streak ? n - 1 : n - 2) : (streak ? n - 2 : 2);
        if (o.fuller && s > 4 && s < (o.ut - o.u0) * 0.78) {
          if (Math.abs(v - 0.45) < 0.8) {
            if (o.runes) { const cu = mod(s, 7); if (cu < 4.6 && hsh(((s / 7) | 0) * 13 + ((cu * 1.2) | 0), ((v + 2) * 1.3) | 0) < 0.55) return o.runes; }
            i = streak ? 3 : 2;
          } else if (v < -0.3 && v > -1.4) i = n;
        }
      }
      if (o.rust) {
        const r = vnoise(u * 0.16, v * 0.45 + 7) + (hsh(x, y) - 0.5) * 0.12;
        if (r > 0.56) return tone(RUSTR, (r - 0.56) * 2.2 + i / n * 0.45, x, y);
      }
      return R[i];
    };
    f.hw = hw;
    return f;
  }
  const GS = 9;
  function swordGuard(u, v, x, y) {                          // bronze cross with scrolled ends and a garnet
    u = 13 + (u - GS - 13) / 1.2; v /= 1.2;
    if (u < 4 || u > 24) return 0;
    const av = Math.abs(v), sg = v < 0 ? -1 : 1;
    const cu = u - 18, cv = av - 21.2, cd = Math.hypot(cu, cv);
    if (cd < 4.7 && cd > 2 && !(cu > 0.5 && cv < 0)) return tone(BRONZE, 0.5 + 0.35 * (cu / cd) - 0.12 * (cv / cd) * sg - 0.15 * sg, x, y);
    if (cd <= 2 && cd > 0) return tone(BRONZE, 0.2, x, y);
    const e = av / 21.2, lug = Math.abs(u - 13.3) / 8.2 + av / 6.4 < 1;
    if (lug || (av < 21.2 && u > 10.6 + e * 0.9 && u < 15.9 - e * 0.9)) {
      const gd = (u - 13.6) * (u - 13.6) + v * v;
      if (gd < 7.5) return tone(GEMR, clamp(0.9 - (u < 13.6 ? 0.35 : 0) - (v > 0 ? 0.25 : 0) + (gd < 1.2 && v < 0 ? 0.4 : 0), 0, 1), x, y);
      if (gd < 11) return tone(BRONZE, 0.15, x, y);
      return tone(BRONZE, clamp(0.25 + 0.6 * (u - 10.6) / 5.4 - 0.2 * v / 21, 0, 1), x, y);
    }
    return 0;
  }
  function barGuard(u, v, x, y) {                            // plain pitted iron bar
    const av = Math.abs(v);
    if (u < 19 || u > 26 || av > 17 - Math.max(0, Math.abs(u - 22.5) - 2.2) * 2) return 0;
    return tone(IRON, 0.25 + (26 - u) * 0.06 - v * 0.012 + (hsh(x, y) < 0.15 ? -0.2 : 0), x, y);
  }
  function moonGuard(u, v, x, y) {                           // silver crescent with a pale moonstone
    const av = Math.abs(v), d = Math.hypot(u - 11, v * 0.9);
    if (Math.hypot(u - 22, v) < 3.4) return tone(GEMM, 0.9 - (u < 22 ? 0.3 : 0) - (v > 0 ? 0.3 : 0), x, y);
    if (d > 12 && d < 18.5 && u > 16 && av < 22) return tone(MOONR, 0.35 + (19 - d) * 0.08 - v * 0.012, x, y);
    return 0;
  }
  function crimsonGuard(u, v, x, y) {                        // black iron horns and a burning heart-stone
    const av = Math.abs(v);
    if (Math.hypot(u - 18, v) < 3.6) return tone(RED, 0.95 - (u < 18 ? 0.25 : 0) - (v > 0 ? 0.3 : 0), x, y);
    if (u > 14 && u < 22 && av < 16) return tone(BLK, 0.5 + (22 - u) * 0.05 - v * 0.02, x, y);
    if (av >= 13 && av < 25) {
      const t = (av - 13) / 12, c = 20 + t * t * 18, hw = 3.2 * (1 - t) + 0.6;
      if (Math.abs(u - c) < hw) return Math.abs(u - c) > hw - 0.9 && u > c ? RED[2] : tone(BLK, 0.55 - t * 0.2, x, y);
    }
    return 0;
  }
  function gsGuard(u, v, x, y) {                             // greatsword: long bar, drooping quillons, leather ricasso
    const av = Math.abs(v);
    if (u > 38 && u < 58 && av < 6.5) { const s = mod(u * 0.9 + v * 0.6, 4); return s < 1 ? tone(STRAP, 0.3, x, y) : tone(LEATH, 0.45 - v * 0.05, x, y); }
    if (Math.hypot(u - 22, av - 31) < 3.8) return tone(IRON, 0.7 - (u - 22) * 0.08 - v * 0.02, x, y);
    if (u > 30 && u < 38 && av < 31) return tone(IRON, 0.25 + (38 - u) * 0.07 - v * 0.01, x, y);
    if (av > 26 && av < 33 && u > 22 && u <= 30) return tone(IRON, 0.35 - (av - 26) * 0.03, x, y);
    return 0;
  }
  function daggerGuard(u, v, x, y) {
    const av = Math.abs(v);
    if (Math.hypot(u - 13.5, av - 10) < 2.6) return tone(BRONZE, 0.75 - v * 0.05, x, y);
    if (u > 11.5 && u < 15.5 && av < 10) return tone(BRONZE, 0.35 + (15.5 - u) * 0.1 - v * 0.02, x, y);
    return 0;
  }
  function axeHaft(u, v, x, y) {
    if (u < -38 || u > 168) return 0;
    const r = u < -29 ? 4.8 : 3.5; if (Math.abs(v) > r) return 0;
    const cs = v / r, l = 0.15 + 0.85 * lit(cs, 0, Math.sqrt(1 - cs * cs), LS);
    if (u < -29) return tone(IRON, l, x, y);
    if (u > -24 && u < 16) return mod(u + v * 0.9, 4) < 1.3 ? tone(STRAP, l * 0.6, x, y) : tone(GRIP, l, x, y);
    return tone(WOOD, l + (hsh(Math.round(u / 5), Math.round(cs * 2)) - 0.5) * 0.25 + (mod(u * 0.3 + cs, 3) < 0.3 ? -0.15 : 0), x, y);
  }
  function axeHead(u, v, x, y) {
    const av = Math.abs(v);
    if (u > 134 && u < 166 && av < 5.8) return tone(IRON, 0.35 - v * 0.05 + (u < 137 || u > 163 ? 0.25 : 0), x, y);
    if (v > 5 && v < 16 && Math.abs(u - 150) < 5 * (1 - (v - 5) / 11) + 0.6) return tone(IRON, 0.6 - (v - 5) * 0.03, x, y);
    if (v > -5 || v < -52) return 0;
    const t = (-v - 5) / 47, top = 160 + 13 * Math.pow(t, 1.5), bot = 140 - 64 * Math.pow(t, 2.2);
    if (u > top || u < bot) return 0;
    const ed = 1 - t;
    if (ed < 0.05) return ST[5];
    if (ed < 0.1) return ST[4];
    if (Math.hypot(u - 151, v + 11) < 2.2) return BRONZE[4];
    let l = 0.3 + 0.22 * (u - bot) / (top - bot + 0.01) + (ed < 0.28 ? 0.25 : 0) + (hsh(x >> 1, y >> 1) < 0.07 ? -0.2 : 0);
    if (Math.abs(ed - 0.28) < 0.02) l -= 0.25;
    return tone(ST, l, x, y);
  }
  function maceHaft(u, v, x, y) {
    if (u < -36 || u > 128) return 0;
    const knob = Math.hypot(u + 31, v);
    if (knob < 5.5) return tone(BRONZE, 0.2 + 0.8 * lit(v / 5.5, (u + 31) / 5.5, Math.sqrt(Math.max(0, 1 - knob * knob / 30.25)), LS), x, y);
    if (u < -26 || Math.abs(v) > 3.4) return 0;
    const cs = v / 3.4, l = 0.15 + 0.85 * lit(cs, 0, Math.sqrt(1 - cs * cs), LS);
    if (u > -24 && u < 16) return mod(u + v * 0.9, 4) < 1.3 ? tone(STRAP, l * 0.6, x, y) : tone(GRIP, l, x, y);
    if (Math.abs(u - 50) < 2 || Math.abs(u - 90) < 2) return tone(BRONZE, l + 0.1, x, y);
    return tone(IRON, l * 0.8, x, y);
  }
  function maceHead(u, v, x, y) {                            // flanged head: side flanges with notched rims, a front flange, crown spike
    const av = Math.abs(v);
    if (u > 166 && u < 188 && av < 4.8 * (188 - u) / 22) return tone(IRON, 0.62 - v * 0.08, x, y);
    if (u > 120 && u < 128 && av < 6.6) return tone(BRONZE, 0.62 - v * 0.06 + (u > 126 ? 0.2 : 0), x, y);
    if (u < 126 || u > 168) return 0;
    const s = (u - 126) / 42, fin = 8 + 15 * Math.pow(Math.sin(Math.PI * clamp(s * 1.04, 0, 1)), 0.55);
    if (av > fin) return 0;
    if (av > fin - 4.5 && mod(u - 126, 8) < 1.6) return 0;
    if (av > 8.5) {
      if (av > fin - 1.3) return v < 0 ? IRON[4] : IRON[1];
      const f = (av - 8.5) / (fin - 8.5 + 0.01);
      return tone(IRON, (v < 0 ? 0.72 - f * 0.25 : 0.3 - f * 0.1) + (hsh(x >> 1, y >> 1) < 0.06 ? -0.2 : 0), x, y);
    }
    if (av > 7.5) return IRON[0];
    if (Math.abs(v + 1) < 1.7) return tone(IRON, 0.95, x, y);
    if (Math.abs(v - 1.6) < 0.9) return IRON[1];
    return tone(IRON, v < 0 ? 0.5 : 0.28, x, y);
  }

  // Kind table: layers, bounds, pose tweaks and effect colours.
  const KINDS = {};
  function buildKinds() {
    const grip = (pr, ramp) => mkGrip({ pu: -27, g0: -22, g1: 12, r: 3.4, ramp: GRIP, pr, pRamp: ramp });
    const sword = mkBlade({ u0: 26, ut: 171, utip: 199, w: 7, wt: 5, ramp: ST, fuller: true });
    const rust = mkBlade({ u0: 26, ut: 168, utip: 194, w: 7, wt: 5, ramp: ST, fuller: true, rust: true, nicks: true });
    const moon = mkBlade({ u0: 26, ut: 176, utip: 206, w: 7, wt: 5, ramp: MOONR, fuller: true, runes: GEMM[2] });
    const crim = mkBlade({ u0: 26, ut: 188, utip: 216, w: 9, wt: 6.5, wave: 1.4, ramp: BLK, fuller: true, runes: RED[3], edge: [RED[2], RED[4]] });
    const gs = mkBlade({ u0: 44, ut: 234, utip: 264, w: 11, wt: 8, ramp: ST, fuller: true });
    const dag = mkBlade({ u0: 15, ut: 92, utip: 118, w: 6, wt: 4.5, ramp: ST, fuller: true });
    const base = { umin: -36, vmax: 31, px: 0, py: 0, angOff: 0, glint: true, glow: null, twoHand: false, smear: ['#4c90d0', '#c4e4ff', '#ffffff'] };
    const add = (id, o) => { KINDS[id] = Object.assign({ id }, base, o); };
    add('sword', { layers: [[grip(6, BRONZE), O_LEATH], [sword, O_STEEL], [swordGuard, O_BRONZE]], umax: 202, len: 199, blade: sword, bl: [30, 199, 7] });
    add('rust', { layers: [[grip(5.5, IRON), O_LEATH], [rust, O_STEEL], [barGuard, O_STEEL]], umax: 197, len: 194, blade: rust, bl: [30, 194, 7], smear: ['#806c5c', '#d8ccc0', '#ffffff'] });
    add('moon', { layers: [[grip(6, MOONR), O_LEATH], [moon, O_STEEL], [moonGuard, O_STEEL]], umax: 209, len: 206, blade: moon, bl: [30, 206, 7], glow: 'moon', smear: ['#6aa8ff', '#d8f0ff', '#ffffff'] });
    add('crimson', { layers: [[grip(6, BLK), O_BLK], [crim, O_BLK], [crimsonGuard, O_BLK]], umax: 219, len: 216, blade: crim, bl: [30, 216, 10], glow: 'red', glint: false, smear: ['#600008', '#e02010', '#ffb080'] });
    add('greatsword', { layers: [[mkGrip({ pu: -52, g0: -46, g1: 30, r: 4.2, ramp: GRIP, pr: 7, pRamp: IRON }), O_LEATH], [gs, O_STEEL], [gsGuard, O_STEEL]], umin: -61, umax: 267, vmax: 36, len: 264, blade: gs, bl: [58, 264, 11], twoHand: true, px: -34, py: -26 });
    add('dagger', { layers: [[mkGrip({ pu: -18, g0: -13, g1: 12, r: 3.2, ramp: REDL, pr: 4.5, pRamp: BRONZE }), O_LEATH], [dag, O_STEEL], [daggerGuard, O_BRONZE]], umin: -24, umax: 121, vmax: 14, len: 118, blade: dag, bl: [18, 118, 6], angOff: -100, px: -38, py: -40 });
    add('axe', { layers: [[axeHaft, O_WOOD], [axeHead, O_STEEL]], umin: -40, umax: 178, vmax: 54, len: 172, blade: axeHead, bl: [80, 178, 52], glint: false });
    add('mace', { layers: [[maceHaft, O_STEEL], [maceHead, O_STEEL]], umin: -38, umax: 190, vmax: 25, len: 180, blade: maceHead, bl: [120, 186, 24], glint: false, smear: ['#8a8070', '#e0d8c8', '#ffffff'] });
  }

  // ── Weapon rotation frames: 2 degree steps, baked lazily, background queue for the held weapon ──
  const WSC = 1.4, NFR = 180;
  let K = null, FR = null, bakeList = [], bakeTimer = 0;
  function bakeFrame(i) {
    const a = i * 2 * DEG, dx = Math.sin(a), dy = -Math.cos(a), nx = Math.cos(a), ny = Math.sin(a);
    let mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9;
    for (const cu of [K.umin - 3, K.umax + 3]) for (const cv of [-K.vmax - 2, K.vmax + 2]) {
      const px = (cu * dx + cv * nx) * WSC, py = (cu * dy + cv * ny) * WSC;
      if (px < mnx) mnx = px; if (px > mxx) mxx = px; if (py < mny) mny = py; if (py > mxy) mxy = py;
    }
    const ox = Math.ceil(-mnx) + 2, oy = Math.ceil(-mny) + 2, w = Math.ceil(mxx) + ox + 2, h = Math.ceil(mxy) + oy + 2, s = 1 / WSC;
    const p = paint(w, h, [dx * s, dy * s, -(ox * dx + oy * dy) * s, nx * s, ny * s, -(ox * nx + oy * ny) * s], K.layers, K.vmax + 1);
    return (FR[i] = { cv: toCanvas(p), ox, oy });
  }
  function frame(i) {
    if (FR[i]) return FR[i];
    bakeList.unshift(i); if (!bakeTimer) bakeTimer = setTimeout(bakeSome, 16);   // bake it next; meanwhile show the nearest ready angle
    for (let d = 1; d < NFR / 2; d++) { const a = FR[(i + d) % NFR], b = FR[(i - d + NFR) % NFR]; if (a) return a; if (b) return b; }
    return bakeFrame(i);
  }
  function bakeSome() {
    bakeTimer = 0;
    const t0 = performance.now(), kk = K;
    while (bakeList.length && performance.now() - t0 < 8) { const i = bakeList.shift(); if (!FR[i]) bakeFrame(i); }
    if (bakeList.length && kk === K) bakeTimer = setTimeout(bakeSome, 16);
  }
  const angIdx = a => mod(Math.round(a / 2), NFR);
  function setKind(id) {
    K = KINDS[id] || KINDS.sword; K.frames = K.frames || new Array(NFR); FR = K.frames;
    Object.keys(KINDS).forEach(k => { if (KINDS[k] !== K) KINDS[k].frames = null; });   // free the old weapon's frames
    const idle = -18 + K.angOff; bakeList = [];
    for (let i = 0; i < NFR; i++) if (!FR[i]) bakeList.push(i);
    bakeList.sort((p, q) => Math.abs(mod(p * 2 - idle + 180, 360) - 180) - Math.abs(mod(q * 2 - idle + 180, 360) - 180));
    for (let k = 0; k < 2 && bakeList.length; k++) bakeFrame(bakeList.shift());
    if (bakeTimer) clearTimeout(bakeTimer);
    bakeTimer = setTimeout(bakeSome, 30);
    if (!K.spots) buildSpots(K);
  }
  // Blood spots and drips in blade space; revealed as CT.gore.blade rises (lowest thresholds first).
  function buildSpots(k) {
    const R = CT.rng(k.id.length * 977 + 13), sp = [];
    let tries = 0;
    const gauss = () => (R() + R() + R() - 1.5) * 1.4;
    while (sp.length < 520 && tries++ < 4000) {                // clusters: each splash grows outward as the level rises
      const cu = k.bl[0] + R() * (k.bl[1] - k.bl[0]), cv = (R() * 2 - 1) * k.bl[2];
      if (!k.blade(cu, cv, 0, 0)) continue;
      const along = (cu - k.bl[0]) / (k.bl[1] - k.bl[0]);
      const th0 = clamp(R() * 0.7 + Math.abs(along - 0.6) * 0.4, 0.01, 0.95), n = 6 + (R() * 10 | 0), su = 3 + R() * 7;
      for (let j = 0; j < n; j++) {
        const u = cu + gauss() * su * (1 + j * 0.08), v = cv + gauss() * 2.2 * (1 + j * 0.06);
        if (!k.blade(u, v, 0, 0)) continue;
        sp.push({ u, v, th: Math.min(0.99, th0 + j * 0.018), c: R() < 0.12 ? 2 : j < 3 ? 0 : R() < 0.55 ? 1 : 0, drip: false, seed: R() });
      }
    }
    sp.sort((a, b) => a.th - b.th);
    for (let i = 0; i < sp.length; i += 29) sp[i].drip = true;
    k.spots = sp;
    if (k.glow === 'red') {                                    // pulsing rune pixels for the Crimson Edge
      const rs = [];
      for (let u = 30; u < 160; u += 1) for (let v = -0.4; v <= 1.3; v += 0.85) { const c = k.blade(u, v, 0, 0); if (c === RED[3]) rs.push(u, v); }
      k.runes = new Float32Array(rs);
    }
  }

  // ── Glow sprites and the flask ─────────────────────────────────────────────
  function buildGlow(R, cols) {
    const S = R * 2, cv = document.createElement('canvas'); cv.width = cv.height = S;
    const g = cv.getContext('2d');
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const d = Math.hypot(x + 0.5 - R, (y + 0.5 - R) * 1.15) / R; if (d >= 1) continue;
      const k = (1 - d) * (1 - d);
      if (k * 1.3 > bay(x, y)) { g.fillStyle = d < 0.35 ? cols[0] : d < 0.65 ? cols[1] : cols[2]; g.fillRect(x, y, 1, 1); }
    }
    return cv;
  }
  let GLOW_T, GLOW_R, GLOW_M, GLOW_F;
  const FLASK = [];
  function buildFlask(tilt) {
    const a = tilt * DEG, k = 1 / HS, ca = Math.cos(a) * k, sa = Math.sin(a) * k, S = 130, h = S / 2;
    const LIQ = ramp(['#3a0408', '#8a0c14', '#d02030', '#ff6a5a']), GL = ramp(['#1a2a2a', '#3e5a58', '#7aa09a', '#d8f0e8']), CK = ramp(['#3a220e', '#6a4424', '#9a6a3a']);
    const p = paint(S, S, [ca, sa, -h * ca - h * sa, -sa, ca, h * sa - h * ca], [[(u, v, x, y) => {
      const ub = u, vb = v + 6;                               // u across, v up (negative = top)
      if (vb > -24 && vb < -16 && Math.abs(ub) < 3.2) return tone(CK, 0.6 - ub * 0.1, x, y);
      if (vb > -17 && vb < -6 && Math.abs(ub) < 3.6 + (vb > -9 ? (vb + 9) * 0.8 : 0)) return tone(GL, 0.4 - ub * 0.1 + (ub < -1.5 ? 0.3 : 0), x, y);
      const d = Math.hypot(ub, (vb - 4) * 1.05);
      if (d < 11) { const nx = ub / 11, ny = (vb - 4) / 11, l = 0.15 + 0.85 * lit(nx, ny, Math.sqrt(Math.max(0, 1 - d * d / 121)), LA);
        if (d > 9.6) return tone(GL, l, x, y);
        if (nx < -0.35 && ny < -0.2 && ny > -0.6) return GL[3];
        return vb - 4 > -3 ? tone(LIQ, l, x, y) : tone(GL, l * 0.4, x, y); }
      return 0;
    }, hex('#0a0606')]], 1e9);
    return { cv: toCanvas(p), o: h };
  }

  // ── Fire: smoothed cellular fire with a scrolling cooling map ──────────────
  const FW = 40, FH = 74, F = new Float32Array(FW * (FH + 2)), CH = 128, COOL = new Float32Array(FW * CH), FPAL = new Uint32Array(40);
  let fireCv = null, fireCtx = null, fireImg = null, firePix = null, fireAcc = 0, fireSum = 0, fireAvg = 1, coolOff = 0, flick = 0.8;
  let seed = 0x9e3779b9 | 0;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  function buildFire() {
    const stops = [[0, 0], [3, '#5a1008'], [6, '#a81e0c'], [10, '#dc3c18'], [15, '#f8661c'], [21, '#ff9a26'], [27, '#ffc63c'], [32, '#ffe878'], [36, '#fffbe0']];
    for (let i = 0; i < 40; i++) { let c = 0; for (const s of stops) if (i >= s[0]) c = s[1]; FPAL[i] = c ? hex(c) : 0; }
    for (let i = 0; i < COOL.length; i++) COOL[i] = rnd();
    const tmp = new Float32Array(COOL.length);
    for (let pass = 0; pass < 3; pass++) {
      for (let y = 0; y < CH; y++) for (let x = 0; x < FW; x++) {
        const xl = (x + FW - 1) % FW, xr = (x + 1) % FW, yu = (y + CH - 1) % CH, yd = (y + 1) % CH;
        tmp[y * FW + x] = (COOL[y * FW + x] * 2 + COOL[y * FW + xl] + COOL[y * FW + xr] + COOL[yu * FW + x] + COOL[yd * FW + x]) / 6;
      }
      COOL.set(tmp);
    }
    let mn = 1, mx = 0; for (const v of COOL) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
    for (let i = 0; i < COOL.length; i++) COOL[i] = Math.pow((COOL[i] - mn) / (mx - mn), 1.5);
    fireCv = document.createElement('canvas'); fireCv.width = FW; fireCv.height = FH;
    fireCtx = fireCv.getContext('2d'); fireImg = fireCtx.createImageData(FW, FH); firePix = new Uint32Array(fireImg.data.buffer);
  }
  function fireStep(boost, wind) {
    const cx = (FW - 1) / 2, hw = 11.5 + boost * 3;
    for (let r = FH; r < FH + 2; r++) for (let x = 0; x < FW; x++) { const d = Math.abs(x - cx) / hw; F[r * FW + x] = d < 1 ? (1 - d * d * 0.45) * (1.05 + rnd() * 0.4) : 0; }
    coolOff = (coolOff + 1) % CH;
    const cs = 0.048 - boost * 0.02; let sum = 0;
    for (let y = 0; y < FH; y++) {
      const row = y * FW, below = row + FW, cr = ((y + coolOff) % CH) * FW, wx = Math.round(Math.sin(y * 0.28 - coolOff * 0.45) * 0.62 + (rnd() < wind ? 0.6 : 0));
      for (let x = 0; x < FW; x++) {
        const xs = clamp(x + wx, 0, FW - 1), xl = xs > 0 ? xs - 1 : 0, xr = xs < FW - 1 ? xs + 1 : xs, e = Math.abs(x - cx) / cx;
        let v = (F[below + xl] + F[below + xs] * 2 + F[below + xr] + F[below + FW + xs]) * 0.2;
        v -= COOL[cr + x] * cs + e * e * 0.05; if (v < 0) v = 0;
        F[row + x] = v; sum += v;
      }
    }
    fireSum = sum;
  }
  function fireRender() { for (let i = 0, n = FW * FH; i < n; i++) { const k = (F[i] * 38) | 0; firePix[i] = FPAL[k > 39 ? 39 : k]; } fireCtx.putImageData(fireImg, 0, 0); }

  // ── Screen particles (preallocated): 0 spark, 1 blood, 2 ember, 3 water, 4 moon mote ──
  const NP = 320, qx = new Float32Array(NP), qy = new Float32Array(NP), qvx = new Float32Array(NP), qvy = new Float32Array(NP), ql = new Float32Array(NP), qm = new Float32Array(NP), qt = new Uint8Array(NP);
  let qNext = 0;
  function sp(x, y, vx, vy, life, type) { const i = qNext; qNext = (qNext + 1) % NP; qx[i] = x; qy[i] = y; qvx[i] = vx; qvy[i] = vy; ql[i] = qm[i] = life; qt[i] = type; }
  const FLASHES = [];                                          // impact stars: {x, y, t, big, col}
  for (let i = 0; i < 6; i++) FLASHES.push({ x: 0, y: 0, t: 0, big: 0, red: false });
  let flNext = 0;
  function flash(x, y, big, red) { const f = FLASHES[flNext]; flNext = (flNext + 1) % FLASHES.length; f.x = x; f.y = y; f.t = 0.16 + big * 0.06; f.big = big; f.red = red; }
  function star(ctx, x, y, r, col) {
    x |= 0; y |= 0; ctx.fillStyle = col;
    ctx.fillRect(x - r, y, r * 2 + 1, 1); ctx.fillRect(x, y - r, 1, r * 2 + 1);
    const q = r >> 1; ctx.fillRect(x - q, y - 1, q * 2 + 1, 3); ctx.fillRect(x - 1, y - q, 3, q * 2 + 1);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(x - 1, y, 3, 1); ctx.fillRect(x, y - 1, 1, 3);
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let CORE = null, ready = false, curW = null, kindName = '';
  const I = { moveX: 0, moveY: 0, lookDX: 0, lookDY: 0, sprint: false, jump: false, attack: false, heavy: 0, heavyRelease: false, block: false, dodge: false, torch: false, usePotion: false };
  let fakeHeavy = 0;
  let atk = 0, atkK = 0, atkDur = 1, comboIdx = 0, comboTimer = 0, hitDone = false, buffered = false, whooshed = false, swingId = 0, heavyCharge = 0;
  let charging = false, charge = 0, fullFx = false, blockT = 0, guardBreakT = 0, blockKick = 0, parryT = 0, parryBurst = false;
  let dodgeT = -1, dodgeX = 0, dodgeZ = 0, dodgeSide = 0, drinkT = -1, drinkId = null, drinkDone = false;
  let hurtT = 0, grounded = true, sprinting = false, exhausted = false, stIdle = 9, hspeed = 0, inWater = 0, wasWater = false;
  let bobPh = 0, bobAmp = 0, dip = 0, kbx = 0, kbz = 0, lean = 0, deathT = 0, deathSide = 1, lastSave = null, poiT = 0;
  let ownBlade = 0, ownHands = 0, splashT = 0;
  const FWD = new THREE.Vector3(), RGT = new THREE.Vector3(), TMP = new THREE.Vector3();

  // Light combo keyframes: [windX, windY, windA, midX, midY, endX, endY, endA, side]; side = the sweep direction (+1 to the right).
  const LK = [
    [578, 246, 24, 430, 186, 248, 318, -126, -1],               // right to left
    [240, 244, -114, 400, 190, 590, 300, 104, 1],              // backhand, left to right
    [560, 100, 30, 470, 168, 326, 338, -74, 0],                // overhead chop
  ];
  const HK = [505, 252, 20, 400, 150, 196, 336, -152, -1];     // heavy: from the charge pose to a huge low finish
  const LW = 0.22, LSE = 0.5, HW = 0.1, HSE = 0.42;            // wind end, strike end (normalised swing time)

  // ── Input ──────────────────────────────────────────────────────────────────
  function readInput(core, dt) {
    const c = CT.controls, test = !!(c && typeof c.update !== 'function');
    const s = (test && c.state) || core.input || {};
    I.moveX = +s.moveX || 0; I.moveY = +s.moveY || 0; I.lookDX = +s.lookDX || 0; I.lookDY = +s.lookDY || 0;
    I.sprint = !!s.sprint; I.jump = !!s.jump; I.attack = !!s.attack; I.heavy = +s.heavy || 0; I.heavyRelease = !!s.heavyRelease;
    I.block = !!s.block; I.dodge = !!s.dodge; I.torch = !!s.torch; I.usePotion = !!s.usePotion;
    if (test) {                                                // controls absent: honour the debug flags, pressed flags last one frame
      if (c._forceAttack) { c._forceAttack = false; I.attack = true; }
      if (c._forceHeavy) { c._forceHeavy = false; fakeHeavy = 0.001; }
      if (c.state && c.state !== core.input) { const q = c.state; q.attack = q.jump = q.dodge = q.torch = q.usePotion = q.heavyRelease = q.interact = false; q.lookDX = q.lookDY = 0; }
    }
    if (fakeHeavy > 0) { fakeHeavy += dt; I.heavy = fakeHeavy; if (fakeHeavy >= 1.1) { I.heavy = 0; I.heavyRelease = true; fakeHeavy = 0; } }
  }

  // ── Stamina ────────────────────────────────────────────────────────────────
  function useStamina(c) { PL.stamina = Math.max(0, PL.stamina - c); stIdle = 0; if (PL.stamina <= 0) exhausted = true; }

  // ── Combat ─────────────────────────────────────────────────────────────────
  function camVectors() {
    const cp = Math.cos(PL.pitch);
    FWD.set(-Math.sin(PL.yaw) * cp, Math.sin(PL.pitch), -Math.cos(PL.yaw) * cp);
    RGT.set(Math.cos(PL.yaw), 0, -Math.sin(PL.yaw));
  }
  function startLight() {
    const idx = (atk === 1 || comboTimer > 0) ? (comboIdx + 1) % 3 : 0;
    atk = 1; comboIdx = idx; atkK = 0; hitDone = false; buffered = false; whooshed = false; comboTimer = 0; swingId++;
    atkDur = 0.45 / (curW.speed || 1) * (idx === 2 ? 1.2 : 1);
    useStamina(P.lightCost);
    emit('swing', { weapon: curW, heavy: false });
  }
  function startHeavy(c) {
    atk = 2; atkK = 0; heavyCharge = c; hitDone = false; buffered = false; whooshed = false; swingId++; comboTimer = 0;
    atkDur = 0.62 / (curW.speed || 1);
    useStamina(P.heavyCost);
    emit('swing', { weapon: curW, heavy: true });
    sfx('grunt', { heavy: true });
  }
  function critChance() { if (has('rpg', 'crit')) return 0.08 + (CT.rpg.crit() || 0); const ch = equipped('charm'); return 0.08 + (ch && ch.crit ? ch.crit : 0); }
  function strike() {
    const w = curW, heavy = atk === 2, idx = comboIdx, chop = !heavy && idx === 2;
    const side = heavy ? -1 : LK[idx][8];
    const arc = (w.arc || 1.5) * (heavy ? 1.15 : chop ? 0.6 : 1), reach = (w.reach || 2.3) * (heavy ? 1.12 : chop ? 1.08 : 1);
    let maxT = w.arc >= 1.6 ? 3 : w.arc >= 1.3 ? 2 : 1;
    if (heavy) maxT++; if (chop) maxT = w.arc >= 1.6 ? 2 : 1;
    if (!has('monsters', 'hitTest')) return;
    camVectors();
    const hits = CT.monsters.hitTest(CORE.camera.position, FWD, reach, arc);
    if (!hits || !hits.length) return;
    let n = 0, killed = false, big = false, crits = false;
    for (let i = 0; i < hits.length && n < maxT; i++) {
      const h = hits[i], m = h && h.monster;
      if (!m || m.hp <= 0 || m.dead || m.state === 'dead') continue;
      n++;
      let dmg = (w.damage || 18) * (heavy ? (w.heavyMult || 2.2) * (0.6 + 0.4 * heavyCharge) : chop ? 1.25 : 1);
      const crit = Math.random() < critChance(); if (crit) { dmg *= 1.5; crits = true; }
      dmg = Math.round(dmg);
      const dir = new THREE.Vector3(FWD.x * 0.8 + RGT.x * side * 0.6, chop ? -0.5 : 0.08, FWD.z * 0.8 + RGT.z * side * 0.6).normalize();
      const r = (has('monsters', 'damage') && CT.monsters.damage(m, dmg, dir, h.part, heavy)) || {};
      if (r.killed) killed = true; if (r.severed) big = true;
      impactFx(h.point || m.pos, side, heavy || crit, r.killed || r.severed);
      const pos = h.point || m.pos;
      sfx('flesh', { pos, heavy });
      if (heavy || crit || r.severed || r.killed) sfx('bone', { pos });
    }
    if (!n) return;
    CORE.hitStop((heavy ? 0.09 : 0.05) + (crits ? 0.02 : 0) + (killed ? 0.02 : 0));
    CORE.shake(killed ? 1.0 : heavy ? 0.8 : 0.4 + n * 0.05, heavy || killed ? 0.32 : 0.2);
    const amt = (heavy ? 0.16 : 0.07) * (1 + (w.bleed || 0)) * Math.min(2, n);
    if (has('gore', 'bladeBlood')) CT.gore.bladeBlood(amt);
    ownBlade = Math.min(1, ownBlade + amt); ownHands = Math.min(1, ownHands + amt * 0.45);
  }
  function impactFx(point, side, big, gory) {
    if (!point || !CORE) return;
    TMP.copy(point).project(CORE.camera);
    if (TMP.z > 1 || TMP.z < -1) return;
    const x = (TMP.x + 1) * W / 2, y = (1 - TMP.y) * H / 2, nb = 16 + (big ? 16 : 0) + (gory ? 22 : 0);
    for (let i = 0; i < nb; i++) {
      const a = rnd() * 6.283, v = 40 + rnd() * (big ? 260 : 170);
      sp(x, y, Math.cos(a) * v * 0.7 + side * (80 + rnd() * 160), Math.sin(a) * v * 0.6 - 60 - rnd() * 90, 0.5 + rnd() * 0.7, 1);
    }
    for (let i = 0; i < (big ? 12 : 6); i++) { const a = rnd() * 6.283, v = 120 + rnd() * 220; sp(x, y, Math.cos(a) * v, Math.sin(a) * v - 40, 0.15 + rnd() * 0.25, 0); }
    flash(x, y, big ? 1 : 0, gory);
  }
  function fromFront(dir, src) {
    let sx, sz;
    if (src && src.pos) { sx = src.pos.x - PL.pos.x; sz = src.pos.z - PL.pos.z; }
    else if (dir) { sx = -dir.x; sz = -dir.z; } else return true;
    const l = Math.hypot(sx, sz); if (l < 1e-4) return true;
    return (sx * -Math.sin(PL.yaw) + sz * -Math.cos(PL.yaw)) / l > 0.15;
  }
  function die() {
    PL.alive = false; PL.hp = 0; PL.blocking = false; PL.dodging = false; charging = false; atk = 0; drinkT = -1; deathT = 0;
    deathSide = Math.random() < 0.5 ? -1 : 1;
    sfx('death'); emit('playerDeath', {});
  }

  PL.hurt = function (amount, dir, source) {
    if (!PL.alive || !(amount > 0)) return 0;
    if (dodgeT >= 0 && dodgeT < 0.35) { sfx('dodge', { evade: true }); return 0; }
    let amt = amount;
    if (PL.blocking && guardBreakT <= 0 && fromFront(dir, source)) {
      if (blockT < 0.2) {                                         // perfect block: parry and stagger the attacker
        parryT = 0.3; parryBurst = true;
        sfx('parry', source && source.pos ? { pos: source.pos } : undefined);
        if (CORE) { CORE.hitStop(0.1); CORE.shake(0.55, 0.25); }
        if (source) { if (has('monsters', 'stagger')) CT.monsters.stagger(source); else source.staggered = 1.2; }
        PL.stamina = Math.min(stMax(), PL.stamina + 8);
        emit('parry', { source });
        return 0;
      }
      const guard = PL.torchLit && !K.twoHand ? 0.3 : 0.2, cost = P.blockCost * (PL.torchLit ? 1 : 0.7) * clamp(amount / 20, 0.6, 2);
      if (PL.stamina >= cost) { useStamina(cost); amt *= guard; sfx('block', source && source.pos ? { pos: source.pos } : undefined); blockKick = 1; if (CORE) CORE.shake(0.3, 0.18); }
      else { useStamina(PL.stamina); guardBreakT = 0.9; amt *= 0.6; blockKick = 1.6; sfx('block', { broken: true }); if (CORE) CORE.shake(0.7, 0.3); }
    }
    if (PL.god) return 0;
    const ar = has('rpg', 'armor') ? CT.rpg.armor() || 0 : ((equipped('armor') || {}).armor || 0); if (ar > 0) amt *= 1 - clamp(ar, 0, 0.8);
    amt = Math.round(amt * 10) / 10;
    if (amt <= 0) return 0;
    PL.hp = Math.max(0, PL.hp - amt);
    if (CORE) { CORE.hurtFlash = 1; CORE.shake(clamp(0.3 + amt / 35, 0.3, 1), 0.3); }
    if (has('gore', 'screen') && amt >= 3) CT.gore.screen(clamp(amt / 45, 0.08, 0.7));
    sfx(amt > 15 ? 'hurt' : 'grunt', { hurt: true });
    let kx = 0, kz = 0;
    if (dir) { kx = dir.x; kz = dir.z; } else if (source && source.pos) { kx = PL.pos.x - source.pos.x; kz = PL.pos.z - source.pos.z; }
    const kl = Math.hypot(kx, kz);
    if (kl > 1e-4) { const f = Math.min(7, 1.5 + amt * 0.12) / kl; kbx += kx * f; kbz += kz * f; }
    hurtT = 1; charging = false;
    emit('playerHurt', { amount: amt, dir, from: source });
    if (PL.hp <= 0) die();
    return amt;
  };
  PL.heal = function (amount) {
    if (!(amount > 0)) return 0;
    const before = PL.hp; PL.hp = Math.min(hpMax(), PL.hp + amount);
    return PL.hp - before;
  };
  PL.respawn = function () {
    let x = C.START.x, z = C.START.z;
    if (!lastSave) { try { const id = localStorage.getItem('crimsonThrone.rest'); lastSave = CT.config.POIS.find(o => o.id === id) || null; } catch (e) {} }
    if (lastSave) { x = lastSave.x; z = lastSave.z + 4; }
    PL.pos.set(x, hAt(x, z) + 0.05, z);
    if (has('world', 'collide')) { const r = CT.world.collide(PL.pos, P.radius); if (r && r !== PL.pos && typeof r.x === 'number') { PL.pos.x = r.x; PL.pos.z = r.z; } PL.pos.y = hAt(PL.pos.x, PL.pos.z) + 0.05; }
    PL.vel.set(0, 0, 0); PL.hp = hpMax(); PL.stamina = stMax(); PL.alive = true; PL.pitch = 0; PL.roll = 0;
    atk = 0; charging = false; dodgeT = -1; drinkT = -1; hurtT = 0; exhausted = false; guardBreakT = 0; deathT = 0; kbx = kbz = 0; dip = 0;
    PL.blocking = false; PL.dodging = false; ownBlade = ownHands = 0;
    if (has('gore', 'clear')) CT.gore.clear();
  };

  // ── Init ───────────────────────────────────────────────────────────────────
  PL.init = function (core) {
    CORE = core;
    buildFire(); for (let i = 0; i < 50; i++) fireStep(0, 0); fireAvg = fireSum || 1; fireRender();
    buildKinds();
    arm('R'); arm('T');
    GLOW_T = buildGlow(66, ['rgba(255,190,90,0.55)', 'rgba(255,140,50,0.42)', 'rgba(240,90,30,0.30)']);
    GLOW_R = buildGlow(30, ['rgba(255,60,30,0.6)', 'rgba(220,20,20,0.45)', 'rgba(140,0,10,0.35)']);
    GLOW_M = buildGlow(30, ['rgba(220,240,255,0.55)', 'rgba(150,200,255,0.4)', 'rgba(90,130,220,0.28)']);
    GLOW_F = buildGlow(30, ['rgba(255,230,150,0.65)', 'rgba(255,150,50,0.5)', 'rgba(230,70,20,0.35)']);
    curW = weapon(); kindName = kindOf(curW); setKind(kindName);
    setTimeout(() => { try { arm('B'); arm('F'); for (let a = 0; a <= 120; a += 30) FLASK.push(buildFlask(a)); } catch (e) { console.error('[CT.player bake]', e); } }, 300);
    PL.pos.set(C.START.x, hAt(C.START.x, C.START.z) + 0.05, C.START.z);
    PL.hp = hpMax(); PL.stamina = stMax();
    if (CT.bus) CT.bus.on('kill', d => {
      if (!d || !d.point || !PL.alive || !CORE) return;
      if (Math.hypot(d.point.x - PL.pos.x, d.point.z - PL.pos.z) > 7) return;
      if (d.overkill > 50) { CORE.hitStop(0.12); CORE.shake(1, 0.45); ownHands = Math.min(1, ownHands + 0.2); }
      else if (d.overkill > 0) CORE.shake(0.9, 0.35);
    });
    ready = true;
  };

  // ── Update: input, combat, movement, camera ────────────────────────────────
  PL.update = function (dt, core) {
    if (!ready || PL.freeze) return;
    CORE = core;
    const cam = core.camera;
    readInput(core, dt);
    curW = weapon();
    const kn = kindOf(curW); if (kn !== kindName) { kindName = kn; setKind(kn); }
    PL.prompt = null;
    const sm = stMax();
    hurtT = Math.max(0, hurtT - dt * 4); parryT = Math.max(0, parryT - dt); blockKick = Math.max(0, blockKick - dt * 6); guardBreakT = Math.max(0, guardBreakT - dt);
    if (!PL.alive) { deathUpdate(dt, cam); return; }

    // look
    PL.yaw -= I.lookDX; PL.pitch = clamp(PL.pitch - I.lookDY, -1.4, 1.4);
    const fx = -Math.sin(PL.yaw), fz = -Math.cos(PL.yaw), rx = Math.cos(PL.yaw), rz = -Math.sin(PL.yaw);

    // torch + potion
    if (I.torch) { PL.torchLit = !PL.torchLit; sfx('torch', { on: PL.torchLit }); }
    if (I.usePotion && drinkT < 0 && !atk && !charging) {
      const r = CT.rpg, miss = hpMax() - PL.hp; let id = 'potion';
      if (r && typeof r.has === 'function') id = r.has('bigpotion') && (miss > 80 || !r.has('potion')) ? 'bigpotion' : r.has('potion') ? 'potion' : null;
      if (PL.hp >= hpMax()) emit('notify', { text: 'You are already hale.', kind: 'info' });
      else if (id) { drinkT = 0; drinkId = id; drinkDone = false; PL.blocking = false; sfx('uncork'); }
      else emit('notify', { text: 'No healing draughts left.', kind: 'info' });
    }
    if (drinkT >= 0) {
      drinkT += dt;
      if (!drinkDone && drinkT >= 0.5) {
        drinkDone = true; const before = PL.hp;
        if (has('rpg', 'usePotion')) CT.rpg.usePotion();
        else if (has('rpg', 'use')) { const r = CT.rpg.use(drinkId); if (PL.hp === before && r !== false) PL.heal((C.ITEMS[drinkId] || {}).heal || 50); }
        else { PL.heal(50); sfx('drink'); }
      }
      if (drinkT >= 0.8) drinkT = -1;
    }

    // block
    const wantBlock = I.block && drinkT < 0 && guardBreakT <= 0 && dodgeT < 0 && !(atk && atkK < 0.55);
    if (wantBlock && !PL.blocking) { blockT = 0; charging = false; atk = 0; sfx('guard'); }
    PL.blocking = wantBlock; if (PL.blocking) blockT += dt;

    // attacks
    const canAct = drinkT < 0 && dodgeT < 0 && !PL.blocking;
    if (I.attack && canAct && !charging) { if (!atk) startLight(); else if (atk === 1 && atkK > 0.12) buffered = true; }
    const held = I.heavy;
    if (held > 0.15 && !atk && canAct && !exhausted) {
      if (!charging) { charging = true; fullFx = false; sfx('charge'); }
      charge = clamp((held - 0.15) / 0.85, 0, 1);
      if (charge >= 1 && !fullFx) { fullFx = true; sfx('chargeFull'); core.shake(0.15, 0.2); }
    }
    if (charging && (I.heavyRelease || held <= 0)) { charging = false; startHeavy(charge); }
    if (charging && (!canAct || exhausted)) charging = false;
    if (atk) {
      atkK += dt / atkDur;
      const kw = atk === 2 ? HW : LW;
      if (!whooshed && atkK >= kw) { whooshed = true; sfx('swing', { heavy: atk === 2, weapon: curW.style }); }
      if (!hitDone && atkK >= (atk === 2 ? 0.3 : comboIdx === 2 ? 0.4 : 0.36)) { hitDone = true; strike(); }
      if (atk === 1 && buffered && atkK >= 0.68) startLight();
      else if (atkK >= 1) { atk = 0; comboTimer = 0.45; }
    } else if (comboTimer > 0) comboTimer -= dt;

    // movement input
    let mx = I.moveX, my = I.moveY; const ml = Math.hypot(mx, my); if (ml > 1) { mx /= ml; my /= ml; }
    const wx = fx * my + rx * mx, wz = fz * my + rz * mx, wl = Math.hypot(wx, wz);

    // dodge
    if (I.dodge && dodgeT < 0 && !exhausted && PL.stamina > 0 && grounded && drinkT < 0) {
      if (wl > 0.2) { dodgeX = wx / wl; dodgeZ = wz / wl; } else { dodgeX = -fx; dodgeZ = -fz; }
      dodgeSide = Math.sign(dodgeX * rx + dodgeZ * rz); dodgeT = 0; charging = false;
      if (atk && atkK > 0.5) atk = 0;
      useStamina(P.dodgeCost); sfx('dodge');
    }
    if (dodgeT >= 0) { dodgeT += dt; if (dodgeT >= 0.42) dodgeT = -1; }
    PL.dodging = dodgeT >= 0 && dodgeT < 0.35;

    // speed
    sprinting = I.sprint && my > 0.2 && !exhausted && PL.stamina > 0 && grounded && !PL.blocking && !charging && drinkT < 0;
    let speed = sprinting ? P.sprint : P.walk;
    if (PL.blocking) speed *= 0.45; if (charging) speed *= 0.55; if (atk) speed *= atk === 2 ? 0.5 : 0.72; if (drinkT >= 0) speed *= 0.5;
    if (wl > 0.1) {                                            // slope: uphill is slow, steep is slower
      const dx = wx / wl, dz = wz / wl, g0 = hAt(PL.pos.x, PL.pos.z), s = (hAt(PL.pos.x + dx * 0.6, PL.pos.z + dz * 0.6) - g0) / 0.6;
      if (s > 0.35) speed *= clamp(1 - (s - 0.35) * 1.3, 0.25, 1);
    }
    inWater = wAt(PL.pos.x, PL.pos.z);
    if (inWater > 0.3) speed *= inWater > 1 ? 0.45 : 0.65;
    if (inWater > 0.3 && !wasWater) { sfx('step', { surface: 'water', splash: true }); splashT = 0.4; }
    wasWater = inWater > 0.3;
    if (inWater > 0.5) { ownBlade = Math.max(0, ownBlade - dt * 0.08); ownHands = Math.max(0, ownHands - dt * 0.1); }

    // horizontal velocity
    const v = PL.vel;
    if (dodgeT >= 0) { const k = 1 - dodgeT / 0.42, s = 12 * k * k + 2; v.x = dodgeX * s; v.z = dodgeZ * s; }
    else {
      const acc = grounded ? (wl > 0.1 ? 9 : 11) : 1.6, k = 1 - Math.exp(-acc * dt);
      v.x += (wx * speed - v.x) * k; v.z += (wz * speed - v.z) * k;
    }
    if (sprinting && wl > 0.1) { PL.stamina = Math.max(0, PL.stamina - P.sprintCost * dt); stIdle = 0; if (PL.stamina <= 0) exhausted = true; }

    // jump + gravity
    if (I.jump && grounded && drinkT < 0 && !PL.blocking) { v.y = P.jump; grounded = false; useStamina(6); sfx('jump'); }
    v.y -= 20 * dt;
    const oy = PL.pos.y;
    PL.pos.x += (v.x + kbx) * dt; PL.pos.z += (v.z + kbz) * dt; PL.pos.y += v.y * dt;
    const kd = Math.exp(-7 * dt); kbx *= kd; kbz *= kd;
    if (has('world', 'collide')) { const r = CT.world.collide(PL.pos, P.radius); if (r && r !== PL.pos && typeof r.x === 'number') { PL.pos.x = r.x; PL.pos.z = r.z; } PL.pos.y = oy + v.y * dt; }
    const lim = C.ISLAND - 5; PL.pos.x = clamp(PL.pos.x, -lim, lim); PL.pos.z = clamp(PL.pos.z, -lim, lim);
    let ground = hAt(PL.pos.x, PL.pos.z);
    const wd = wAt(PL.pos.x, PL.pos.z); if (wd > 1.35) ground = Math.max(ground, ground + wd - 1.35);   // wade/swim: keep the head above water
    if (PL.pos.y <= ground) {
      if (!grounded && v.y < -3) { dip = Math.max(dip, Math.min(0.35, -v.y * 0.035)); step(true); if (v.y < -9) core.shake(0.4, 0.2); }
      PL.pos.y = ground; v.y = 0; grounded = true;
    } else if (grounded && v.y <= 0 && PL.pos.y - ground < 0.45) { PL.pos.y = ground; v.y = 0; }
    else grounded = false;

    // stamina regen
    stIdle += dt;
    if (stIdle > 0.8) PL.stamina = Math.min(sm, PL.stamina + P.staminaRegen * dt * (PL.blocking ? 0.4 : 1));
    if (exhausted && PL.stamina >= sm * 0.2) exhausted = false;

    // bob, steps, camera
    hspeed = Math.hypot(v.x, v.z);
    bobAmp += ((grounded ? Math.min(1.3, hspeed / 4.5) : 0) - bobAmp) * Math.min(1, dt * 8);
    const prevStep = Math.floor(bobPh / Math.PI);
    if (grounded) bobPh += dt * hspeed * 1.3;
    if (grounded && hspeed > 0.8 && Math.floor(bobPh / Math.PI) !== prevStep) step(false);
    dip -= dip * Math.min(1, dt * 6);
    let leanT = 0;
    if (atk) { const kw = atk === 2 ? HW : LW, ke = atk === 2 ? HSE : LSE; if (atkK > kw && atkK < ke) leanT = (atk === 2 ? -1 : LK[comboIdx][8]) * (atk === 2 ? 0.06 : 0.035) * Math.sin(Math.PI * (atkK - kw) / (ke - kw)); }
    if (dodgeT >= 0) leanT += dodgeSide * 0.07 * Math.sin(Math.PI * dodgeT / 0.42);
    lean += (leanT - lean) * Math.min(1, dt * 14);
    PL.roll = Math.sin(bobPh) * 0.008 * bobAmp + lean;
    cam.position.set(PL.pos.x, PL.pos.y + P.eye + (Math.abs(Math.sin(bobPh)) - 0.5) * 0.07 * bobAmp - dip - (charging ? charge * 0.05 : 0), PL.pos.z);
    cam.rotation.set(PL.pitch + hurtT * 0.05, PL.yaw, PL.roll);
    torch(dt, core);

    // save point tracking
    poiT -= dt;
    if (poiT <= 0) {
      poiT = 0.5;
      const pois = (CT.world && CT.world.pois) || C.POIS;
      for (let i = 0; i < pois.length; i++) { const o = pois[i]; if (o.save && Math.hypot(o.x - PL.pos.x, o.z - PL.pos.z) < o.radius && lastSave !== o) { lastSave = o; try { localStorage.setItem('crimsonThrone.rest', o.id); } catch (e) {} } }
    }
  };
  function step(land) {
    const surf = inWater > 0.3 ? 'water' : has('world', 'biomeAt') ? CT.world.biomeAt(PL.pos.x, PL.pos.z) : 'meadow';
    sfx('step', { surface: surf, land, sprint: sprinting });
    if (inWater > 0.3) for (let i = 0; i < 10; i++) sp(160 + rnd() * 320, 362, (rnd() - 0.5) * 160, -120 - rnd() * 160, 0.5 + rnd() * 0.3, 3);
  }
  function torch(dt, core) {
    const tl = core.torchLight; if (!tl) return;
    const target = PL.alive && PL.torchLit ? (3 + 2 * flick) * (K && K.twoHand ? 0.7 : 1) : 0;
    tl.intensity += (target - tl.intensity) * Math.min(1, dt * 14 || 0);
    tl.distance = 22;
  }
  function deathUpdate(dt, cam) {
    deathT += dt;
    const k = Math.min(1, deathT / 1.1), e = k * k, bounce = k >= 1 ? Math.max(0, Math.sin((deathT - 1.1) * 14) * 0.03 * Math.exp(-(deathT - 1.1) * 5)) : 0;
    PL.roll = deathSide * 1.3 * ease(k);
    cam.position.set(PL.pos.x, PL.pos.y + P.eye - (P.eye - 0.28) * e + bounce, PL.pos.z);
    cam.rotation.set(PL.pitch * (1 - k) + 0.18 * k, PL.yaw + deathSide * 0.25 * ease(k), PL.roll);
    torch(dt, CORE);
  }

  // ── Swing poses ────────────────────────────────────────────────────────────
  let PX = 0, PY = 0, PA = 0;
  function poseSwing(k, KF, kw, ks, sx, sy, sa, bx, by, ba) {
    if (k < kw) { const e = easeOut(k / kw); PX = sx + (KF[0] - sx) * e; PY = sy + (KF[1] - sy) * e; PA = sa + (KF[2] - sa) * e; }
    else if (k < ks) {
      const e = ease((k - kw) / (ks - kw)), i = 1 - e;
      PX = i * i * KF[0] + 2 * i * e * KF[3] + e * e * KF[5];
      PY = i * i * KF[1] + 2 * i * e * KF[4] + e * e * KF[6];
      PA = KF[2] + (KF[7] - KF[2]) * e;
    } else { const e = ease(Math.min(1, (k - ks) / (1 - ks))); PX = KF[5] + (bx - KF[5]) * e; PY = KF[6] + (by - KF[6]) * e; PA = KF[7] + (ba - KF[7]) * e; }
  }

  // ── Draw ───────────────────────────────────────────────────────────────────
  let lastT = -1, clock = 0, bRx = 520, bRy = 318, bRa = -18, bLx = 82, bLy = 292, curRx = 520, curRy = 318, curRa = -18;
  let seenSwing = 0, sBx = 0, sBy = 0, sBa = 0, leftShown = 'T', swapK = 0, glintT = 1.5, eAcc = 0;
  const SMN = 16, SMP = new Float64Array((SMN + 1) * 4), SMA = new Float64Array(SMN + 1), QX = new Float64Array(4), QY = new Float64Array(4);
  function quad(ctx) {
    let y0 = Math.min(QY[0], QY[1], QY[2], QY[3]), y1 = Math.max(QY[0], QY[1], QY[2], QY[3]);
    y0 = Math.max(0, Math.floor(y0)); y1 = Math.min(H, Math.ceil(y1));
    for (let y = y0; y < y1; y++) {
      const yc = y + 0.5; let mn = 1e9, mx = -1e9;
      for (let e = 0; e < 4; e++) {
        const ax = QX[e], ay = QY[e], bx = QX[(e + 1) & 3], by = QY[(e + 1) & 3];
        if ((yc - ay) * (yc - by) > 0 || ay === by) continue;
        const xx = ax + (yc - ay) * (bx - ax) / (by - ay);
        if (xx < mn) mn = xx; if (xx > mx) mx = xx;
      }
      if (mx > mn) { const a = Math.round(mn), b = Math.round(mx); if (b > a) ctx.fillRect(a, y, b - a, 1); }
    }
  }
  function drawSmear(ctx, KF, kw, ks, heavy, bloody) {
    const span = heavy ? 0.16 : 0.12, k1 = Math.min(atkK, ks), k0 = Math.max(kw, atkK - span);
    if (k1 <= k0 + 0.002) return;
    for (let i = 0; i <= SMN; i++) {
      const kk = k0 + (k1 - k0) * i / SMN; poseSwing(kk, KF, kw, ks, 0, 0, 0, 0, 0, 0);
      const a = (PA + K.angOff) * DEG, o = i * 4;
      SMP[o] = PX; SMP[o + 1] = PY; SMP[o + 2] = Math.sin(a); SMP[o + 3] = -Math.cos(a);
      SMA[i] = clamp((atkK - kk) / span, 0, 1);
    }
    const L = K.len * WSC, cols = heavy ? ['#d0300c', '#ff9a30', '#fff0c0'] : K.smear;
    for (let b = 0; b < 3; b++) {
      const lo = b === 0 ? 0 : b === 1 ? 0.4 : 0.8, hi = b === 0 ? 1 : b === 1 ? 0.97 : 0.985, al = (b === 0 ? 0.3 : b === 1 ? 0.55 : 0.95) * (heavy ? 1.25 : 1);
      ctx.fillStyle = b === 0 && bloody ? '#8a0a10' : cols[b];
      for (let i = 0; i < SMN; i++) {
        const age = (SMA[i] + SMA[i + 1]) * 0.5, a = al * (1 - age * (b === 2 ? 2.2 : b === 1 ? 1.3 : 1));
        if (a <= 0.03) continue;
        ctx.globalAlpha = Math.min(1, a);
        for (let j = 0; j < 2; j++) {
          const o = (i + j) * 4, ag = SMA[i + j], rin = L * (0.5 + ag * 0.4), rout = L + 4;
          const r0 = rin + (rout - rin) * lo, r1 = rin + (rout - rin) * hi, q0 = j === 0 ? 0 : 1, q1 = j === 0 ? 3 : 2;
          QX[q0] = SMP[o] + SMP[o + 2] * r0; QY[q0] = SMP[o + 1] + SMP[o + 3] * r0;
          QX[q1] = SMP[o] + SMP[o + 2] * r1; QY[q1] = SMP[o + 1] + SMP[o + 3] * r1;
        }
        quad(ctx);
      }
    }
    ctx.globalAlpha = 1;
  }
  function drawGlint(ctx, gu, px, py, dx, dy, nx, ny) {
    const hw = K.blade.hw; if (!hw) return;
    ctx.fillStyle = '#ffffff';
    for (let k = 0; k < 9; k++) {
      ctx.globalAlpha = k < 4 ? 1 : 0.85 - (k - 4) * 0.17;
      for (let v = -8; v <= 8; v++) {
        const u = gu - k + v * 0.7; if (u < K.bl[0] + 2 || u > K.len - 3) continue;
        const h = hw(u) - 1.2; if (v < -h || v > h) continue;
        ctx.fillRect(Math.floor(px + (u * dx + v * nx) * WSC), Math.floor(py + (u * dy + v * ny) * WSC), 2, 1);
      }
    }
    ctx.globalAlpha = 1;
  }
  let bloodOv = -1, handsOv = -1;
  function bladeLevel() { if (bloodOv >= 0) return bloodOv; const g = CT.gore; return g && typeof g.blade === 'number' ? clamp(g.blade, 0, 1) : ownBlade; }
  function wetness(k) { const g = CT.gore, w = g && g[k]; return typeof w === 'number' ? clamp(w, 0, 1) : 0.6; }
  function handLevel() { if (handsOv >= 0) return handsOv; const g = CT.gore; return g && typeof g.hands === 'number' ? clamp(g.hands, 0, 1) : ownHands; }

  PL.drawHands = function (ctx, t) {
    if (!ready || !K) return;
    const t0 = performance.now();
    let dt = lastT < 0 ? 0.016 : t - lastT; lastT = t;
    if (!(dt > 0)) dt = 0; else if (dt > 0.1) dt = 0.1;
    clock += dt;
    ctx.imageSmoothingEnabled = false;
    const wk = clamp(hspeed / 4.5, 0, 1.3), idle = 1 - Math.min(1, wk), two = K.twoHand;

    // right hand base pose, smoothed
    let tx = 512 + K.px, ty = 300 + K.py, ta = -18;
    if (sprinting) { tx = 572; ty = 350; ta = 8; }
    if (PL.blocking) { if (leftShown === 'B') { tx = 540; ty = 300; ta = K.angOff ? -20 : -36; } else { tx = 440; ty = 258; ta = K.angOff ? 10 : -84; } }
    if (charging) { tx = HK[0] - 6; ty = HK[1] + 8; ta = HK[2] - 8; }
    if (drinkT >= 0) { tx = 590; ty = 392; ta = 6; }
    const kf = 1 - Math.exp(-dt * (PL.blocking || charging ? 16 : 9));
    bRx += (tx - bRx) * kf; bRy += (ty - bRy) * kf; bRa += (ta - bRa) * kf;
    let rx = bRx + Math.sin(bobPh) * 5 * wk + Math.sin(clock * 0.9) * 0.8 * idle;
    let ry = bRy + Math.cos(2 * bobPh) * 4 * wk + Math.sin(clock * 1.7) * 1.8 * idle;
    let ra = bRa + Math.sin(clock * 0.7) * 0.8 * idle;
    if (sprinting) { ry += Math.sin(bobPh) * 9; ra += Math.sin(bobPh) * 6; }
    if (charging) { const tr = charge * (charge >= 1 ? 3.2 : 2); rx += (rnd() - 0.5) * tr * 2; ry += (rnd() - 0.5) * tr * 2; ra += (rnd() - 0.5) * tr; }

    // swing overrides the base pose
    let smear = false, KF = null, kw = LW, ks = LSE;
    if (atk) {
      KF = atk === 2 ? HK : LK[comboIdx]; kw = atk === 2 ? HW : LW; ks = atk === 2 ? HSE : LSE;
      if (swingId !== seenSwing) { seenSwing = swingId; sBx = curRx; sBy = curRy; sBa = curRa; }
      poseSwing(atkK, KF, kw, ks, sBx, sBy, sBa, rx, ry, ra);
      rx = PX; ry = PY; ra = PA;
      smear = atkK >= kw && atkK < ks + (atk === 2 ? 0.16 : 0.12);
    }
    if (hurtT > 0) { rx += 14 * hurtT; ry += 22 * hurtT; ra += 10 * hurtT; }
    if (blockKick > 0) { rx += 10 * blockKick; ry += 12 * blockKick; ra += 6 * blockKick; }
    if (dodgeT >= 0) { const k = Math.sin(Math.PI * Math.min(1, dodgeT / 0.42)); rx -= dodgeSide * 34 * k; ry += 18 * k; ra -= dodgeSide * 8 * k; }
    if (!PL.alive) { const k = Math.min(1, deathT / 0.9); ry += 420 * k * k; rx += 60 * k; ra += 40 * k; }
    curRx = rx; curRy = ry; curRa = ra;

    // left hand: torch, buckler, flask fist or (greatsword) the second hand on the grip
    const want = two ? 'G' : drinkT >= 0 ? 'F' : PL.torchLit ? 'T' : 'B';
    if (leftShown !== want) { swapK += dt * (want === 'F' ? 9 : 6); if (swapK >= 1) { swapK = 1; leftShown = want; if ((want === 'B' || want === 'F') && !ARMS[want]) arm(want); } }
    else swapK = Math.max(0, swapK - dt * (want === 'F' ? 9 : 5));
    let ltx = 84, lty = 280;
    if (leftShown === 'B') { ltx = 226; lty = 238; }
    if (leftShown === 'F') { const k = drinkT >= 0 ? ease(clamp(drinkT / 0.3, 0, 1)) : 0; ltx = 230 + 70 * k; lty = 340 - 60 * k; }
    if (PL.blocking) { if (leftShown === 'T') { ltx = 176; lty = 262; } else if (leftShown === 'B') { ltx = 300; lty = 168; } }
    const kl = 1 - Math.exp(-dt * (PL.blocking ? 16 : 9));
    bLx += (ltx - bLx) * kl; bLy += (lty - bLy) * kl;
    let lx = bLx + Math.cos(bobPh) * 5 * wk + Math.sin(clock * 0.8 + 1) * 0.8 * idle;
    let ly = bLy - Math.cos(2 * bobPh) * 4 * wk + Math.sin(clock * 1.7 + 0.6) * 1.8 * idle + swapK * swapK * 240;
    if (sprinting) ly -= Math.sin(bobPh) * 9;
    if (atk) { const s = Math.sin(Math.PI * Math.min(1, atkK)); ly += s * 14; lx -= s * 6; }
    if (charging) { lx -= 10 * charge; ly += 12 * charge; }
    if (hurtT > 0) { lx -= 8 * hurtT; ly += 18 * hurtT; }
    if (dodgeT >= 0) { const k = Math.sin(Math.PI * Math.min(1, dodgeT / 0.42)); lx -= dodgeSide * 34 * k; ly += 18 * k; }
    if (!PL.alive) { const k = Math.min(1, deathT / 0.9); ly += 420 * k * k; lx -= 40 * k; }

    // fire simulation (fixed 45 Hz)
    const torchOn = leftShown === 'T';
    if (torchOn) {
      fireAcc += dt; let stepped = false, n = 0;
      while (fireAcc > 0.022 && n < 3) { fireAcc -= 0.022; n++; fireStep(charging ? charge * 0.5 : 0, 0.08 + wk * 0.3 + (atk ? 0.4 : 0)); stepped = true; }
      if (fireAcc > 0.1) fireAcc = 0;
      if (stepped) { fireRender(); fireAvg += (fireSum - fireAvg) * 0.02; flick += (clamp(0.6 + (fireSum / fireAvg - 1) * 3, 0, 1) - flick) * 0.25; }
    }

    const Rx = Math.round(rx), Ry = Math.round(ry), Lx = Math.round(lx), Ly = Math.round(ly);
    const A = ra + K.angOff, ai = angIdx(A), aq = ai * 2 * DEG, dx = Math.sin(aq), dy = -Math.cos(aq), nx = Math.cos(aq), ny = Math.sin(aq);
    const fbx = Lx + Math.round(T_TOP * TS * TD[0]), fby = Ly + Math.round(T_TOP * TS * TD[1]) + 2;
    const L = K.len * WSC, bmx = Rx + dx * L * 0.55, bmy = Ry + dy * L * 0.55;
    const pulse = 0.5 + 0.5 * Math.sin(clock * 3.2);

    // 1. torch halo
    if (torchOn) { ctx.globalAlpha = 0.45 + flick * 0.4; ctx.drawImage(GLOW_T, fbx - 66, fby - 84); ctx.globalAlpha = 1; }
    // 2. weapon aura (Crimson Edge, Moonblade) and heavy-charge glow
    const aura = K.glow === 'red' ? GLOW_R : K.glow === 'moon' ? GLOW_M : null;
    if (aura || charging) {
      ctx.globalCompositeOperation = 'lighter';
      const g = charging ? (aura || GLOW_F) : aura, al = charging ? 0.25 + charge * 0.75 * (charge >= 1 ? 0.8 + 0.2 * Math.sin(clock * 30) : 1) : K.glow === 'red' ? 0.45 + 0.35 * pulse : 0.4 + 0.25 * pulse;
      ctx.globalAlpha = clamp(al, 0, 1);
      for (let f = 0.3; f < 1.01; f += 0.23) ctx.drawImage(g, Math.round(Rx + dx * L * f - 30), Math.round(Ry + dy * L * f - 30));
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    }
    // 3. motion smear
    const blood = bladeLevel(), bw = wetness('bladeWet');
    if (smear) drawSmear(ctx, KF, kw, ks, atk === 2, blood > 0.45);
    // 4. weapon frame, blood, runes, glint
    const fr = frame(ai);
    ctx.drawImage(fr.cv, Rx - fr.ox, Ry - fr.oy);
    if (charging && charge > 0.05) {                           // the blade heats up as the heavy charge builds
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = charge * (charge >= 1 ? 0.55 + 0.25 * Math.sin(clock * 28) : 0.45);
      ctx.drawImage(fr.cv, Rx - fr.ox, Ry - fr.oy);
      ctx.globalAlpha = Math.min(1, charge * 0.9); ctx.drawImage(GLOW_T, Math.round(Rx + dx * L * 0.45 - 66), Math.round(Ry + dy * L * 0.45 - 66)); ctx.drawImage(GLOW_T, Math.round(Rx + dx * L * 0.85 - 66), Math.round(Ry + dy * L * 0.85 - 66));
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      if (charge >= 1 && mod(clock, 0.3) < dt) flash(Rx + dx * L, Ry + dy * L, 0, false);
    }
    const S = WSC;
    if (K.runes) {
      ctx.fillStyle = pulse > 0.55 ? '#ff9a6a' : '#ff4a2a';
      const R = K.runes;
      for (let i = 0; i < R.length; i += 2) if (((i >> 1) + (clock * 6 | 0)) % 5 < 3 || pulse > 0.8) ctx.fillRect(Math.floor(Rx + (R[i] * dx + R[i + 1] * nx) * S), Math.floor(Ry + (R[i] * dy + R[i + 1] * ny) * S), 2, 2);
    }
    if (blood > 0.01 && K.spots) {
      const sps = K.spots;
      for (let c = 0; c < 3; c++) {
        ctx.fillStyle = bw > 0.4 ? (c === 0 ? '#5a0408' : c === 1 ? '#a0101a' : '#ff5a48') : (c === 0 ? '#2e0806' : c === 1 ? '#541410' : '#7a2418');
        for (let i = 0; i < sps.length; i++) {
          const s = sps[i]; if (s.th > blood) break; if (s.c !== c) continue;
          const sz = c === 2 ? 1 : 2 + (blood - s.th > 0.35 ? 1 : 0);
          ctx.fillRect(Math.floor(Rx + (s.u * dx + s.v * nx) * S), Math.floor(Ry + (s.u * dy + s.v * ny) * S), sz, sz);
        }
      }
      ctx.fillStyle = bw > 0.4 ? '#8a0810' : '#3e0c08';
      for (let i = 0; i < sps.length; i++) {
        const s = sps[i]; if (s.th > blood) break; if (!s.drip) continue;
        const x = Math.floor(Rx + (s.u * dx + s.v * nx) * S), y = Math.floor(Ry + (s.u * dy + s.v * ny) * S), len = Math.min(10, (blood - s.th) * 30) | 0;
        ctx.fillRect(x, y, 1, len + 1);
        if (blood - s.th > 0.2 && bw > 0.15) { const ph = mod(clock * 0.8 + s.seed, 1); ctx.fillRect(x, y + len + Math.round(ph * ph * 70), 1, 2); }
      }
      if (blood > 0.35 && rnd() < dt * blood * 3 * bw) { const s = sps[(rnd() * sps.length) | 0]; if (s.th < blood) sp(Rx + (s.u * dx + s.v * nx) * S, Ry + (s.u * dy + s.v * ny) * S, 0, 20, 1.2, 1); }
    }
    if (K.glint && !atk && !charging) {
      glintT += dt; if (glintT > 3.4) glintT = 0;
      if (glintT < 0.55) drawGlint(ctx, K.bl[0] + (glintT / 0.55) * (K.len - K.bl[0] + 10), Rx, Ry, dx, dy, nx, ny);
    }
    // 5. arms (+ soaked blood)
    const hq = Math.round(handLevel() * 8) + (wetness('handsWet') > 0.45 ? 9 : 0);
    const RA = ARMS.R;
    ctx.drawImage(RA.cv, Rx - RA.ox, Ry - RA.oy);
    if (hq > 0) ctx.drawImage(armBlood(RA, hq), Rx - RA.ox, Ry - RA.oy);
    if (leftShown === 'G') {                                   // greatsword: second fist on the grip, below the right one
      const G = ARMS.F; if (G) { const gx = Math.round(Rx - dx * 25 * WSC), gy = Math.round(Ry - dy * 25 * WSC) + Math.round(swapK * swapK * 240);
        ctx.drawImage(G.cv, gx - G.ox, gy - G.oy); if (hq > 0) ctx.drawImage(armBlood(G, hq), gx - G.ox, gy - G.oy); }
      else arm('F');
    } else {
      const LAr = ARMS[leftShown];
      if (LAr) {
        if (leftShown === 'F' && FLASK.length && drinkT >= 0) { const f = FLASK[clamp(Math.round((drinkT - 0.12) / 0.35 * 4), 0, 4)]; ctx.drawImage(f.cv, Lx - f.o + 10, Ly - f.o - 40); }
        ctx.drawImage(LAr.cv, Lx - LAr.ox, Ly - LAr.oy);
        if (hq > 0) ctx.drawImage(armBlood(LAr, hq), Lx - LAr.ox, Ly - LAr.oy);
      }
    }
    // 6. live flame + embers
    if (torchOn) {
      ctx.drawImage(fireCv, fbx - (FW >> 1), fby - FH + 4);
      eAcc += dt * (8 + wk * 3 + (atk ? 12 : 0)); while (eAcc > 1) { eAcc -= 1; sp(fbx + (rnd() - 0.5) * 14, fby - 10 - rnd() * 26, (rnd() - 0.5) * 14, -(28 + rnd() * 34), 0.7 + rnd() * 1.1, 2); }
    }
    if (K.glow === 'red' && rnd() < dt * 9) { const u = K.bl[0] + rnd() * (K.len - K.bl[0]); sp(Rx + dx * u * S, Ry + dy * u * S, (rnd() - 0.5) * 10, -18 - rnd() * 20, 0.8 + rnd() * 0.6, 2); }
    if (K.glow === 'moon' && rnd() < dt * 6) { const u = K.bl[0] + rnd() * (K.len - K.bl[0]); sp(Rx + dx * u * S, Ry + dy * u * S, (rnd() - 0.5) * 8, -8 - rnd() * 10, 1 + rnd() * 0.8, 4); }
    if (charging && charge >= 1 && rnd() < dt * 20) sp(Rx + dx * L, Ry + dy * L, (rnd() - 0.5) * 60, -20 - rnd() * 40, 0.3 + rnd() * 0.3, 0);
    if (splashT > 0) { splashT -= dt; if (rnd() < 0.5) sp(120 + rnd() * 400, 362, (rnd() - 0.5) * 200, -150 - rnd() * 180, 0.6, 3); }
    // 7. parry and block sparks
    if (parryBurst) { parryBurst = false; for (let i = 0; i < 28; i++) { const a = rnd() * 6.283, v = 80 + rnd() * 260; sp(bmx, bmy, Math.cos(a) * v, Math.sin(a) * v - 40, 0.2 + rnd() * 0.35, 0); } flash(bmx, bmy, 1, false); }
    if (blockKick > 0.9 && rnd() < 0.6) for (let i = 0; i < 3; i++) sp(bmx + (rnd() - 0.5) * 20, bmy, (rnd() - 0.5) * 200, -rnd() * 160, 0.25, 0);
    // 8. particles
    for (let i = 0; i < NP; i++) {
      if (ql[i] <= 0) continue;
      ql[i] -= dt; const ty = qt[i], f = ql[i] / qm[i];
      if (ty === 0) { qvx[i] *= 1 - dt * 3; qvy[i] = qvy[i] * (1 - dt * 3) + 260 * dt; }
      else if (ty === 1 || ty === 3) qvy[i] += 620 * dt;
      else { qvx[i] += Math.sin(clock * 4 + i) * 24 * dt; qvy[i] *= 1 - dt * 0.5; }
      qx[i] += qvx[i] * dt; qy[i] += qvy[i] * dt;
      const x = qx[i] | 0, y = qy[i] | 0; if (y > H + 4 || x < -4 || x > W + 4) { ql[i] = 0; continue; }
      if (ty === 0) { ctx.fillStyle = f > 0.6 ? '#ffffff' : f > 0.3 ? '#ffe070' : '#ff8a20'; ctx.fillRect(x, y, 1, 1); ctx.fillRect((qx[i] - qvx[i] * 0.012) | 0, (qy[i] - qvy[i] * 0.012) | 0, 1, 1); }
      else if (ty === 1) { ctx.fillStyle = f > 0.7 ? '#c01a1e' : f > 0.35 ? '#8a0a10' : '#5a0408'; const s = f > 0.5 ? 3 : 2; ctx.fillRect(x, y, s, s); }
      else if (ty === 2) { ctx.fillStyle = f > 0.78 ? '#fff6c8' : f > 0.52 ? '#ffc640' : f > 0.28 ? '#ff7a1c' : '#b82a14'; ctx.fillRect(x, y, 1, f > 0.85 ? 2 : 1); }
      else if (ty === 3) { ctx.fillStyle = f > 0.5 ? '#d8f0ff' : '#7aa8c8'; ctx.fillRect(x, y, 1, 2); }
      else { ctx.fillStyle = f > 0.5 ? '#eef6ff' : '#8ab4ff'; ctx.fillRect(x, y, 1, 1); }
    }
    for (let i = 0; i < FLASHES.length; i++) {
      const fl = FLASHES[i]; if (fl.t <= 0) continue; fl.t -= dt;
      const r = Math.round((fl.big ? 14 : 8) * (0.5 + fl.t * 4));
      star(ctx, fl.x, fl.y, r, fl.red ? '#ff5030' : '#ffe890');
    }
    if (parryT > 0.15) { ctx.globalAlpha = (parryT - 0.15) * 1.6; ctx.fillStyle = '#fff8e0'; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; }
    PL.drawMs = PL.drawMs * 0.95 + (performance.now() - t0) * 0.05;
  };

  // Debug snapshot for tests.
  PL.debugState = function () { return { atk, atkK, comboIdx, charging, charge, blockT, dodgeT, drinkT, kind: K && K.id, stamina: PL.stamina, exhausted, blade: bladeLevel(), hands: handLevel(), ms: PL.drawMs, lastSave: lastSave && lastSave.id }; };
  PL.debugBlood = function (b, h) { bloodOv = b; handsOv = h == null ? b : h; };
  // Freeze a pose for screenshots: type 1 light (idx 0..2), 2 heavy, k = normalised swing time; charge/block/drink via opts.
  PL.debugPose = function (type, idx, k, o) {
    o = o || {}; PL.freeze = true; atk = type; comboIdx = idx || 0; atkK = k || 0; swingId++; heavyCharge = 1;
    charging = !!o.charge; charge = o.charge || 0; PL.blocking = !!o.block; drinkT = o.drink != null ? o.drink : -1;
    hurtT = o.hurt || 0; parryT = o.parry || 0; if (o.parry) parryBurst = true; dodgeT = o.dodge != null ? o.dodge : -1; dodgeSide = o.side || 1;
    if (o.torch != null) PL.torchLit = o.torch;
  };
})();
