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

  // â”€â”€ Arms: articulated plate gauntlets (local origin = centre of the fist) â”€â”€
  // Blackened iron plates with bronze trim, 3 overlapping lames per finger, domed knuckle plates, a thumb plate,
  // a flared bell cuff (spiked rim on the sword arm, ridged rim + fur on the off-hand), leather liner in the gaps,
  // riveted wrist strap, a mail sleeve, scratches and dents. Specular edge pixels pick up the sky colour at draw time.
  const IRONB = ramp(['#070609', '#121117', '#1f1e26', '#302f39', '#4a4954', '#6e6d7a']);
  const SPEC_HI = hex('#e6eaf2'), SPEC_MID = hex('#9ea3b2'), O_IRON = hex('#030205');
  const LINER = ramp(['#140905', '#24120a', '#3a1e10', '#553018']);
  const FUR = ramp(['#0a0706', '#1a120d', '#2e2219', '#4a3a2c', '#6e6050', '#9a8e80']);
  const LA = norm3(-0.5, -0.62, 0.6), HV = norm3(LA[0], LA[1], LA[2] + 1);
  const GROOVE = new Set([IRONB[0], LINER[0], LINER[1], LINER[2], STRAP[0], STRAP[1]]);
  function iron(nx, ny, nz, bias, x, y, noSpec) {                // banded plate shading with a hard Blinn highlight
    const s = nx * HV[0] + ny * HV[1] + nz * HV[2];
    if (!noSpec && s > 0.992) return SPEC_HI;
    if (!noSpec && s > 0.975) return bias < -0.1 ? IRONB[4] : SPEC_MID;
    const l = 0.08 + 0.92 * lit(nx, ny, nz, LA);
    return tone(IRONB, clamp((l - 0.2) * 1.1 + bias, 0, 1), x, y);
  }
  // Hand-banded metal cylinder: cs = -1 at the lit (upper/outer) edge, +1 at the far edge.
  // Dark turn at the lit edge, a hard specular streak, mid body, core shadow, then reflected light before the far edge.
  function cylMetal(cs, bias, x, y, noSpec) {
    if (cs < -0.9) return IRONB[bias > 0.2 ? 3 : 2];
    if (cs < -0.76) return IRONB[bias > 0.1 ? 5 : 4];
    if (cs < -0.5) { const d = Math.abs(cs + 0.63); return noSpec || d > 0.1 ? IRONB[bias < -0.1 ? 4 : 5] : d < 0.035 ? SPEC_HI : SPEC_MID; }
    const v = cs < -0.28 ? 0.72 : cs < 0.1 ? 0.55 : cs < 0.45 ? 0.36 : cs < 0.66 ? 0.17 : cs < 0.86 ? 0.36 : 0.04;
    return tone(IRONB, clamp(v + bias, 0, 1), x, y);
  }
  function wear(x, y) {                                          // scratches (bright nick + shadow) and dents
    const cx = Math.floor(x / 11), cy = Math.floor(y / 9), h = hsh(cx * 7 + 3, cy * 13 + 5);
    if (h < 0.16) {
      const lx = x - cx * 11, ly = y - cy * 9, o = ((h * 97) | 0) % 4, al = h < 0.08 ? lx - ly : lx + ly - 8, x0 = ((h * 331) | 0) % 4, x1 = x0 + 3 + ((h * 71) | 0) % 5;
      if (lx >= x0 && lx < x1) { if (al === o - 2) return 0.5; if (al === o - 1) return -0.3; }
    }
    const d = vnoise(x / 6 + 31, y / 6 + 7);
    return d > 0.8 ? -0.22 : d > 0.74 ? -0.1 : 0;
  }
  function rivet(du, dv, bronze, x, y) {                         // 2 px domed rivet head: lit top-left, dark below
    const d = du * du + dv * dv;
    if (d > 1.9) return 0;
    if (du + dv < -0.4) return bronze ? BRONZE[5] : SPEC_HI;
    return d > 1.1 ? (bronze ? BRONZE[1] : IRONB[0]) : bronze ? BRONZE[3] : IRONB[4];
  }

  // Forearm: bell cuff along the axis (13,4) -> down-right; a = along, p = across.
  const FAX = 13, FAY = 4, FUX = 0.6, FUY = 0.8, CUFF0 = 3, CUFF1 = 26, RIM1 = 29.5;
  function forearm(xm, Y, x, y, type) {
    const px = xm - FAX, py = Y - FAY, a = px * FUX + py * FUY, p = -px * FUY + py * FUX;
    if (a < -8 || a > 170) return 0;
    const R = type === 'R', ap = Math.abs(p);
    let r, slope = 0;
    if (a < CUFF0) r = 12.6;
    else if (a < CUFF1) { const t = (a - CUFF0) / (CUFF1 - CUFF0); r = 12.8 + 9.6 * Math.pow(t, 1.7); slope = 9.6 * 1.7 * Math.pow(t, 0.7) / (CUFF1 - CUFF0); }
    else if (a < RIM1) r = 23;
    else r = 14.6 + (a - RIM1) * 0.07;
    // decorations past the rim: a crown of spikes (sword arm) or a fur ruff (off-hand)
    if (a >= RIM1 && a < RIM1 + 9) {
      const e = a - RIM1;
      if (R) {
        const ang = Math.asin(clamp(p / 23, -1, 1)), j = ang / (Math.PI / 7), fr = j - Math.round(j), hw = (1 - e / 7.5) * 0.34;
        if (e < 7.5 && ap < 23.5 && Math.abs(fr) < hw) {
          const side = fr < 0 ? 0.28 : -0.12, tipk = e > 5.5 ? 0.2 : 0;
          if (Math.abs(fr) > hw - 0.07 && fr < 0) return SPEC_MID;
          return tone(IRONB, 0.42 + side + tipk - Math.abs(p) / 60, x, y);
        }
      } else {
        // shaggy ruff: strands flow toward the elbow with a sway; each strand has its own length and value, lighter tips
        const sway = Math.sin(e * 0.7 + p * 0.3) * 0.9, si = Math.floor(p * 1.5 + sway), sh = hsh(si, 17), len = 4 + sh * 5.5;
        if (e > -2.5 && e < len && ap < 25 + (e < 2 ? 0 : hsh(si, 5) * 2.5)) {
          const cs = clamp(p / 25, -1, 1), l = 0.1 + 0.9 * lit(cs * -FUY, cs * FUX, Math.sqrt(1 - cs * cs), LA);
          const edge = (p * 1.5 + sway) - si, tipk = e / len;
          let v = l * 0.62 + (sh - 0.5) * 0.3 + (tipk > 0.55 ? 0.22 : 0) - (edge < 0.25 ? 0.28 : 0) - (e < 1.2 ? 0.25 : 0);
          return tone(FUR, v, x, y);
        }
      }
    }
    if (ap > r) return 0;
    const cs = p / r, nz = Math.sqrt(Math.max(0, 1 - cs * cs));
    let nx = cs * -FUY - slope * FUX, ny = cs * FUX - slope * FUY, nzz = nz; const ln = Math.hypot(nx, ny, nzz); nx /= ln; ny /= ln; nzz /= ln;
    const w = wear(x, y);
    if (a < CUFF0 + 3.2 && a > CUFF0 - 1) {                      // riveted leather wrist strap
      const k = Math.round(cs * 3);
      const rv = rivet((a - (CUFF0 + 1.1)) * 1.2, (cs - k / 3) * 9, true, x, y); if (rv) return rv;
      return tone(STRAP, 0.25 + 0.75 * lit(nx, ny, nzz, LA) + (a < CUFF0 - 0.3 || a > CUFF0 + 2.6 ? -0.3 : 0), x, y);
    }
    if (a < CUFF0) return tone(LINER, 0.2 + 0.6 * lit(nx, ny, nzz, LA), x, y);
    if (a < CUFF1) {                                             // the bell
      if (a < CUFF0 + 4.4) return tone(BRONZE, 0.2 + 0.8 * lit(nx, ny, nzz, LA) + (a < CUFF0 + 3.5 ? 0.1 : -0.35), x, y);
      for (const c of [-0.52, 0, 0.52]) {                        // three raised flutes
        const d = cs - c;
        if (Math.abs(d) < 0.034) return a > CUFF0 + 6 && lit(nx, ny, nzz, LA) > 0.45 ? SPEC_HI : SPEC_MID;
        if (d > 0.034 && d < 0.09) return tone(IRONB, 0.05, x, y);
      }
      return cylMetal(cs, w + slope * 0.35 - 0.08, x, y);
    }
    if (a < RIM1) {                                              // rolled bronze rim with rivets (ridged on the off-hand)
      const t = (a - CUFF1) / (RIM1 - CUFF1), tl = (t - 0.5) * 1.7;
      const mx = cs * -FUY * 0.8 + FUX * tl, my = cs * FUX * 0.8 + FUY * tl, mz = Math.sqrt(Math.max(0.05, 1 - mx * mx - my * my));
      if (!R && Math.abs(mod(Math.asin(clamp(cs, -1, 1)) * 5.5, 1) - 0.5) < 0.1) return BRONZE[1];
      if (R) { const k = Math.round(cs * 4); const rv = rivet((t - 0.5) * 5, (cs - k / 4) * 16, false, x, y); if (rv && Math.abs(cs) < 0.95) return rv; }
      const l = 0.1 + 0.9 * lit(mx, my, mz, LA);
      if (t > 0.9) return BRONZE[0];
      return l > 0.86 ? BRONZE[5] : tone(BRONZE, l * 0.95 + w * 0.5, x, y);
    }
    // mail sleeve with a riveted strap
    const l = 0.08 + 0.92 * lit(nx, ny, nzz, LA);
    if (a < RIM1 + 1.2) return IRONB[0];
    if (a > 40 && a < 45) { const k = Math.round(cs * 2.5); const rv = rivet((a - 42.5) * 1.3, (cs - k / 2.5) * 11, true, x, y); if (rv) return rv; return tone(STRAP, l + (a < 40.8 || a > 44.2 ? -0.3 : 0), x, y); }
    const mx = x % 3, my = (y + ((x / 3 | 0) & 1)) % 3;
    if (mx === 1 && my === 1) return IRONB[0];
    return tone(IRONB, l * 0.85 + (my === 0 ? 0.12 : -0.05), x, y);
  }
  const BCX = 13 + 0.6 * 50, BCY = 4 + 0.8 * 50, BR = 31;
  function buckler(xm, Y, x, y) {                            // round bronze buckler strapped to the off-hand
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
    if (Math.abs(dx + dy * 0.6 - 8) < 0.6 && d > 0.35 && d < 0.8) l -= 0.35;
    return tone(BRONZE, l, x, y);
  }
  // Back-of-hand plate: a domed metacarpal plate with a raised centre ridge and two wrist lames.
  const YK = [-7.6, -2.5, 2.6, 7.7];
  function backOfHand(xm, Y, x, y) {
    if (xm < -10 || xm > 21 || Y < -14 || Y > 16) return 0;
    const nx = (xm - 5.5) / 13.4, ny = (Y - 1) / 13, q = nx * nx + ny * ny;
    if (q > 1) return 0;
    let nz = Math.sqrt(1 - q), mx = nx, my = ny;
    const s = (xm - 5.5) * FUX + (Y - 1) * FUY, t = -(xm - 5.5) * FUY + (Y - 1) * FUX;
    if (q > 0.88 && s > 6) return tone(BRONZE, 0.25 + 0.75 * lit(nx, ny, nz, LA) + (q > 0.95 ? -0.3 : 0.1), x, y);   // bronze-trimmed wrist edge
    if (q > 0.9) return IRONB[q > 0.96 ? 1 : 3];
    for (const b of [5.2, 9.2]) {                                // lame edges toward the wrist
      const d = s - b;
      if (d > -0.9 && d < 0) return IRONB[0];
      if (d >= 0 && d < 0.8) return lit(nx, ny, nz, LA) > 0.3 ? SPEC_HI : SPEC_MID;
      if (d >= 0.8 && d < 3) { const rv = rivet(d * 1.4 - 2.2, (Math.abs(t) - 7.2) * 1.3, true, x, y); if (rv) return rv; }
    }
    if (s < 5.2) {                                               // centre ridge
      if (t > -0.55 && t < 0.35) return lit(nx, ny, nz, LA) > 0.25 ? SPEC_HI : SPEC_MID;
      if (t >= 0.35 && t < 1.3) return IRONB[0];
      const k = t < 0 ? 0.35 : -0.25; mx += FUY * k; my -= FUX * k;
    }
    return iron(mx, my, nz, wear(x, y) + (s > 5.2 ? -0.06 : 0), x, y, s > 9.2);
  }
  // Fingers: a tapered tip plate + 2 lames + a domed knuckle plate; each proximal lame overlaps the distal one
  // (a lit lip on the overlapping edge, a dark groove under it). Leather liner shows at the sides.
  const FL = [4.6, 9.2, 13.6];
  function finger(k) {
    const yk = YK[k];
    return (xm, Y, x, y) => {
      if (xm < -19 || xm > 10 || Y < yk - 7 || Y > yk + 7.5) return 0;
      if (!cyl(xm, Y, -11.4 + k * 0.7, yk + 0.2, 4.2, yk + 0.6, 4.6, 5)) return 0;
      const a = CA, cs = CS;
      if (a < 0 && Math.abs(cs) > 1 + a / 3) return 0;           // rounded tip
      const ac = a - 1.6 * (1 - Math.sqrt(Math.max(0, 1 - cs * cs)));   // lame edges bow toward the tip
      const seg = ac < FL[0] ? 0 : ac < FL[1] ? 1 : ac < FL[2] ? 2 : 3, w = wear(x, y);
      for (let b = 0; b < 3; b++) {
        const d = ac - FL[b];
        if (d > -0.9 && d < 0) return Math.abs(cs) > 0.78 ? LINER[0] : IRONB[0];
        if (d >= 0 && d < 0.8 && Math.abs(cs) < 0.8) return cs < -0.35 ? SPEC_HI : cs < 0.3 ? IRONB[5] : IRONB[3];
      }
      if (seg === 3) return tone(LINER, 0.3 + 0.4 * (1 - cs) * 0.5, x, y);   // under the knuckle plate
      const half = seg === 0 ? 0.62 + 0.3 * clamp(a / FL[0], 0, 1) : 0.8;   // the tip plate tapers to a point
      if (Math.abs(cs) > half) return tone(LINER, 0.15 + 0.4 * (cs < 0 ? 1 : 0.4), x, y);
      const s0 = seg === 0 ? -3 : FL[seg - 1], s1 = FL[seg], la = (ac - s0) / (s1 - s0);
      if (seg > 0) { const rv = rivet((ac - (s0 + 1.7)) * 1.2, (cs + 0.52) * 5.4, false, x, y); if (rv) return rv; }
      const bias = 0.1 * Math.sin(Math.PI * la) - (la < 0.25 ? 0.16 : 0) + (seg === 1 ? 0.04 : 0) + w;
      return cylMetal(cs / half, bias, x, y);
    };
  }
  // Knuckle plates: a row of domes over the finger bases, drawn above the fingers so all four read.
  function knuckles(xm, Y, x, y) {
    if (xm < 1 || xm > 11 || Y < -11 || Y > 11.5) return 0;
    for (let k = 3; k >= 0; k--) {
      const du = (xm - 5.2 - 0.7 * k) / 3, dv = (Y - YK[k] - 0.6) / 2.75, dq = du * du + dv * dv;
      if (dq >= 1) continue;
      const hl = Math.hypot(du + 0.38, dv + 0.42);
      if (hl < 0.2) return SPEC_HI;
      if (hl < 0.36) return SPEC_MID;
      if (dq > 0.78) return dv > 0.2 || du > 0.3 ? IRONB[0] : IRONB[3];
      return iron(du * 0.85, dv * 0.85, Math.sqrt(1 - dq * 0.72), wear(x, y) * 0.5 + 0.05, x, y, true);
    }
    return 0;
  }
  // Knuckle-duster (sword hand): a bronze bar over the four knuckle plates with faceted pyramid studs.
  function duster(xm, Y, x, y) {
    if (Y < -11.5 || Y > 12.5) return 0;
    const u = xm - 5.2 - (Y + 7) * 0.137;
    for (let k = 0; k < 4; k++) {
      const dv = Y - YK[k] - 0.5, du = u;
      if (Math.abs(du) + Math.abs(dv) < 2.5) {
        if (Math.abs(du) + Math.abs(dv) < 0.6) return BRONZE[5];
        return du + dv < 0 ? (du < dv ? BRONZE[4] : BRONZE[3]) : (du < dv ? BRONZE[2] : BRONZE[1]);
      }
    }
    if (Math.abs(u) > 1.2) return 0;
    if (u < -0.5) return BRONZE[4];
    if (u > 0.6) return BRONZE[1];
    return hsh(x, y) < 0.12 ? BRONZE[1] : BRONZE[2];
  }
  function thumb(xm, Y, x, y) {
    if (xm < -14 || xm > 18 || Y < -19 || Y > -1) return 0;
    if (!cyl(xm, Y, 11.5, -7.5, -7.8, -11.8, 5.4, 4.5)) return 0;
    const a = CA, cs = -CS, w = wear(x, y);
    if (a > 19.2 && Math.abs(cs) > 1 - (a - 19.2) / 3.4) return 0;
    if (Math.abs(cs) > 0.84 && a > 6.2) return tone(LINER, 0.15 + (cs < 0 ? 0.4 : 0.1), x, y);
    const at = a + 1.4 * (1 - Math.sqrt(Math.max(0, 1 - cs * cs)));
    for (const b of [6.2, 10.8, 15.2]) {                         // lames overlap toward the base
      const d = b - at;
      if (d > -0.9 && d < 0) return IRONB[0];
      if (d >= 0 && d < 0.8) return b === 6.2 ? BRONZE[cs < -0.2 ? 5 : cs < 0.4 ? 3 : 1] : cs < -0.3 ? SPEC_HI : cs < 0.3 ? IRONB[5] : IRONB[3];
    }
    if (a < 6.2) {                                               // the big thumb plate, riveted
      const rv = rivet((a - 3.2) * 1.1, (cs + 0.1) * 4.6, true, x, y); if (rv) return rv;
      return cylMetal(cs, w + 0.04, x, y);
    }
    return cylMetal(cs / 0.84, w + 0.1 * Math.sin(Math.PI * mod(a - 6.2, 4.5) / 4.5) - 0.04, x, y);
  }
  // Mask for the knuckle glint (plates catch the light when the fist clenches).
  function knuckleMask(xm, Y) {
    for (let k = 0; k < 4; k++) if (Math.hypot(xm - 5.3 - 0.7 * k, (Y - YK[k] + 0.7) * 1.1) < 1.1) return 1;
    return 0;
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

  // Arm sprites: R = sword arm, T = torch arm, B = buckler arm, F = bare off-hand fist (potion, cigarette, greatsword grip).
  // Each arm = a body sprite (forearm, back of hand) + a fingers sprite (so the grip can flex) + rim and knuckle masks.
  const HS = 2.7, TS = 1.75, ARMS = {};
  function buildArm(type) {
    const mir = type === 'R' ? 1 : -1, torch = type === 'T';
    const x0 = mir > 0 ? -80 : -320, x1 = mir > 0 ? 320 : 80;
    const y0 = torch ? -Math.ceil((T_TOP + 3) * TS) : -80, y1 = 390, w = x1 - x0, h = y1 - y0, T = [1, 0, x0, 0, 1, y0];
    const sc = f => (X, Y, x, y) => f(X * mir / HS, Y / HS, x, y);
    const body = [];
    if (torch) body.push([(X, Y, x, y) => shaftFn(X / TS, Y / TS, x, y), O_WOOD], [(X, Y, x, y) => headFn(X / TS, Y / TS, x, y), O_CHAR]);
    body.push([sc((xm, Y, x, y) => forearm(xm, Y, x, y, type)), O_IRON]);
    if (type === 'B') body.push([sc(buckler), O_BRONZE]);
    body.push([sc(backOfHand), O_IRON]);
    const fing = [];
    for (let k = 3; k >= 0; k--) fing.push([sc(finger(k)), O_IRON]);
    fing.push([sc(knuckles), O_IRON]);
    if (type === 'R') fing.push([sc(duster), O_BRONZE]);
    fing.push([sc(thumb), O_IRON]);
    const pb = paint(w, h, T, body, 1e9), pf = paint(w, h, T, fing, 1e9);
    const pi = type === 'F' ? paint(w, h, T, [[sc(finger(0)), O_IRON], [sc(knuckles), O_IRON], [sc(thumb), O_IRON]], 1e9) : null;   // index + thumb, drawn over the cigarette
    const WHITE = hex('#ffffff'), KN = hex('#f4f6ff'), rim = new Uint32Array(w * h), kn = new Uint32Array(w * h);
    const sb = new Uint32Array(w * h), sf = new Uint32Array(w * h);
    const on = i => pb.d[i] || pf.d[i];
    for (let y = 2; y < h; y++) for (let x = 0; x < w; x++) {  // rim light: a crisp 1 px line on the outer and upper edges, a softer second px
      const i = y * w + x; if (!on(i)) continue;
      const xo = x + mir;
      if (xo < 0 || xo >= w || !on(i + mir) || !on(i - w)) rim[i] = WHITE;
      else if (!on(i + mir * 2) || !on(i - w * 2)) rim[i] = 0x80ffffff;
    }
    for (let i = 0; i < w * h; i++) {                           // specular edge pixels take the sky colour
      if (!pf.d[i] && (pb.d[i] === SPEC_HI || pb.d[i] === SPEC_MID)) sb[i] = pb.d[i] === SPEC_HI ? 0x70ffffff : WHITE;
      if (pf.d[i] === SPEC_HI || pf.d[i] === SPEC_MID) sf[i] = pf.d[i] === SPEC_HI ? 0x70ffffff : WHITE;
    }
    let icv = null, ispec = null;
    if (pi) {
      const si = new Uint32Array(w * h);
      for (let i = 0; i < w * h; i++) if (pi.d[i] && pf.d[i] === pi.d[i] && sf[i]) { si[i] = sf[i]; sf[i] = 0; }
      icv = toCanvas(pi); ispec = toCanvas({ d: si, w, h });
    }
    const pk = paint(w, h, T, [[sc((xm, Y) => (knuckleMask(xm, Y) ? KN : 0)), 0]], 1e9);
    for (let i = 0; i < w * h; i++) if (pk.d[i] && pf.d[i]) kn[i] = KN;
    const A = { cv: toCanvas(pb), fcv: toCanvas(pf), ox: -x0, oy: -y0, p: pb, blood: [], F: { p: pf, ox: -x0, oy: -y0, blood: [] },
      rim: toCanvas({ d: rim, w, h }), kn: toCanvas({ d: kn, w, h }), tint: null, tintKey: -1,
      spec: toCanvas({ d: sb, w, h }), fspec: toCanvas({ d: sf, w, h }), stint: null, fstint: null, skey: -1, icv, ispec, istint: null, iblood: [] };
    return (ARMS[type] = A);
  }
  const arm = t => ARMS[t] || buildArm(t);
  function tintMask(src, dst, col) {
    if (!dst) { dst = document.createElement('canvas'); dst.width = src.width; dst.height = src.height; }
    const g = dst.getContext('2d');
    g.globalCompositeOperation = 'copy'; g.drawImage(src, 0, 0);
    g.globalCompositeOperation = 'source-in'; g.fillStyle = col; g.fillRect(0, 0, dst.width, dst.height);
    g.globalCompositeOperation = 'source-over';
    return dst;
  }
  function rimTint(A, key, col) {                              // recolour the masks only when the scene colour changes
    if (A.tintKey === key) return A.tint;
    A.tint = tintMask(A.rim, A.tint, col); A.stint = tintMask(A.spec, A.stint, col); A.fstint = tintMask(A.fspec, A.fstint, col);
    if (A.ispec) A.istint = tintMask(A.ispec, A.istint, col);
    A.tintKey = key;
    return A.tint;
  }
  // Blood on the plates: it collects first in the grooves between the lames and the leather liner (dried),
  // and runs down the plates in streaks when fresh. Overlays baked per level (8 steps) and wetness.
  const BLR = ramp(['#2a0204', '#4e0508', '#7a0a10', '#a8141a', '#d0302c']), BLD = ramp(['#1e0604', '#3a0c08', '#58160e', '#6e2214']), BL_H = hex('#f06a58');
  function armBlood(A, q) {
    if (A.blood[q]) return A.blood[q];
    const wet = q > 8, { d, w, h } = A.p, o = new Uint32Array(w * h), lvl = (q % 9) / 8 * 0.88, sc = HS / 2.2;
    let gd = A.gd;
    if (!gd) {                                                  // rows below the nearest groove above, per pixel (255 = none)
      gd = A.gd = new Uint8Array(w * h);
      for (let x = 0; x < w; x++) { let k = 255; for (let y = 0; y < h; y++) { const i = y * w + x; k = GROOVE.has(d[i]) ? 0 : Math.min(255, k + 1); gd[i] = k; } }
    }
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
      const c = d[i]; if (!c) continue;
      const dd = Math.hypot(x - A.ox, (y - A.oy) * 0.9) / (170 * sc), gr = GROOVE.has(c);
      let th = 0.14 + dd * 1.5 + (vnoise(x / (26 * sc) + 3, y / (26 * sc)) - 0.5) * 0.9 + (vnoise(x / 6, y / 6) - 0.5) * 0.12;
      if (gr) th -= 0.42;
      else { th += 0.3 + (vnoise(x / 5 + 9, y / 5) - 0.5) * 0.3; const k = gd[i]; if (k < 22 && hsh(x, 57) < (wet ? 0.34 : 0.14)) th -= (wet ? 0.62 : 0.4) * (1 - k / 22); }   // runs below each groove
      if (y > A.oy && hsh(x >> 1, 91) < 0.09) th -= 0.3 * vnoise(x / 3, y / 45);   // runs down the forearm
      const e = lvl - th;
      if (e < 0) continue;
      const lum = ((c & 255) * 0.3 + ((c >> 8) & 255) * 0.59 + ((c >> 16) & 255) * 0.11) / 255;   // keep the plate form readable under the blood
      if (wet) o[i] = (c === SPEC_HI || (hsh(x, y) < 0.04 && lum > 0.35)) ? BL_H : tone(BLR, clamp(lum * 2.3 - 0.02 + (e < 0.05 ? 0.15 : 0), 0, 1), x, y);
      else o[i] = tone(BLD, clamp((gr ? 0.1 : 0.3) + lum * 1.2 - (e > 0.3 ? 0.12 : 0), 0, 1), x, y);
    }
    return (A.blood[q] = toCanvas({ d: o, w, h }));
  }
  // Scene rim colour: the sky's key light (the directional light), warmed by the torch.
  let rimLight = null, rimSearch = 0, rimKey = -1, rimCol = 'rgb(255,190,120)', rimA = 0.45;
  function updateRim(dt) {
    if (!rimLight && CORE && (rimSearch -= dt) <= 0) { rimSearch = 2; CORE.scene.traverse(o => { if (!rimLight && o.isDirectionalLight) rimLight = o; }); }
    let r = 1, g = 0.75, b = 0.5, k = 0.5;
    if (rimLight) { const c = rimLight.color, m = Math.max(c.r, c.g, c.b, 1e-3); r = c.r / m; g = c.g / m; b = c.b / m; k = clamp(rimLight.intensity / 2, 0.25, 1); }
    const warm = PL.offhand === 'torch' && PL.torchLit ? 0.55 : 0.12;
    r += (1 - r) * warm; g += (0.62 - g) * warm; b += (0.3 - b) * warm;
    const R = Math.round(r * 15), G = Math.round(g * 15), B = Math.round(b * 15), key = R * 256 + G * 16 + B;
    if (key !== rimKey) { rimKey = key; rimCol = 'rgb(' + R * 17 + ',' + G * 17 + ',' + B * 17 + ')'; }
    rimA = 0.3 + 0.4 * Math.max(k, warm) + (rushT > 0 ? 0.25 * (0.5 + 0.5 * Math.sin(clock * 7)) : 0);
  }
  function indexBlood(A, hq) {                                // the finger blood clipped to the index + thumb overlay
    if (A.iblood[hq]) return A.iblood[hq];
    const c = tintMask(armBlood(A.F, hq), null, '#000'), g = c.getContext('2d');
    g.globalCompositeOperation = 'copy'; g.drawImage(armBlood(A.F, hq), 0, 0);
    g.globalCompositeOperation = 'destination-in'; g.drawImage(A.icv, 0, 0); g.globalCompositeOperation = 'source-over';
    return (A.iblood[hq] = c);
  }
  function drawArm(ctx, A, x, y, hq, flex, white, rattle, cig) {
    const X = x - A.ox, Y = y - A.oy, tint = rimTint(A, rimKey, rimCol);
    let fx = X, fy = Y + flex;
    if (rattle > 0.05) { fx += Math.round((rnd() - 0.5) * 2.4 * rattle); fy += Math.round((rnd() - 0.5) * 2.4 * rattle); }   // the plates tremble
    ctx.drawImage(A.cv, X, Y);
    if (hq > 0) ctx.drawImage(armBlood(A, hq), X, Y);
    ctx.globalAlpha = 0.35 + rimA * 0.5; ctx.drawImage(A.stint, X, Y); ctx.globalAlpha = 1;
    ctx.drawImage(A.fcv, fx, fy);
    if (hq > 0) ctx.drawImage(armBlood(A.F, hq), fx, fy);
    ctx.globalAlpha = 0.35 + rimA * 0.5; ctx.drawImage(A.fstint, fx, fy); ctx.globalAlpha = 1;
    if (cig && A.icv) {                                         // the cigarette sits over the middle finger, under the index
      ctx.drawImage(CIG.cv, x - CIG.ox + CIG_BX, y - CIG.oy + CIG_BY);
      ctx.drawImage(A.icv, fx, fy);
      if (hq > 0) ctx.drawImage(indexBlood(A, hq), fx, fy);
      ctx.globalAlpha = 0.35 + rimA * 0.5; ctx.drawImage(A.istint, fx, fy);
    }
    if (white > 0.02) { ctx.globalAlpha = Math.min(1, white) * (rattle > 0.05 && rnd() < 0.5 ? 1 : 0.7); ctx.drawImage(A.kn, fx, fy); }
    ctx.globalAlpha = rimA; ctx.drawImage(tint, X, Y);
    ctx.globalAlpha = 1;
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
  const WSC = 1.55, NFR = 180;
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
  const BOTTLE = [];
  function buildBottle(tilt) {                                // a brown glass beer bottle with a paper label
    const a = tilt * DEG, k = 1 / HS, ca = Math.cos(a) * k, sa = Math.sin(a) * k, S = 130, h = S / 2;
    const BR = ramp(['#1e0c04', '#4a2208', '#7a3c10', '#b0641e', '#f0b060']), LB = ramp(['#6a5a3a', '#c8b488', '#f0e4c0']);
    const p = paint(S, S, [ca, sa, -h * ca - h * sa, -sa, ca, h * sa - h * ca], [[(u, v, x, y) => {
      const vb = v + 8;
      if (vb > -34 && vb < -30 && Math.abs(u) < 2.6) return tone(IRON, 0.6 - u * 0.1, x, y);   // cap
      const r = vb < -18 ? 2.2 : vb < -10 ? 2.2 + (vb + 18) * 0.62 : 7.2;
      if (vb < -30 || vb > 20 || Math.abs(u) > r) return 0;
      const cs = u / r, l = 0.15 + 0.85 * lit(cs, 0, Math.sqrt(1 - cs * cs), LA);
      if (vb > -2 && vb < 10) return tone(LB, l + (Math.abs(vb - 4) < 1 ? -0.3 : 0), x, y);
      if (cs < -0.45 && cs > -0.7) return BR[4];
      return tone(BR, l * 0.8, x, y);
    }, hex('#0a0402')]], 1e9);
    return { cv: toCanvas(p), o: h };
  }
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

  // ── Cigarette: baked hand-rolled stick, live ember, smoke wisps, exhale cloud ──
  const CIG_BX = 12, CIG_BY = -12, CIG_A = 60 * DEG, CIG_L = 46, CIG_TX = Math.round(Math.sin(CIG_A) * CIG_L), CIG_TY = Math.round(-Math.cos(CIG_A) * CIG_L);
  let CIG = null, PUFF = null;
  function buildCig() {
    const PAPER = ramp(['#5e5244', '#a0927a', '#d4c8ac', '#f2ead6']), ASH = ramp(['#34302e', '#625c58', '#948e86']), TOB = ramp(['#3a200c', '#6a4018']);
    const dx = Math.sin(CIG_A), dy = -Math.cos(CIG_A), nx = Math.cos(CIG_A), ny = Math.sin(CIG_A), ox = 6, oy = 44, L = norm3(-0.4, -0.6, 0.7);
    const p = paint(58, 50, [dx, dy, -(ox * dx + oy * dy), nx, ny, -(ox * nx + oy * ny)], [[(u, v, x, y) => {
      if (u < 0 || u > CIG_L) return 0;
      const r = 2.9 + Math.sin(u * 0.45) * 0.35 + (u > CIG_L - 6 ? -0.4 : 0); if (v < -r || v > r) return 0;
      const cs = v / r, l = 0.15 + 0.85 * lit(cs * nx, cs * ny, Math.sqrt(1 - cs * cs), L);
      if (u > CIG_L - 2) return hex('#4a1206');
      if (u > CIG_L - 6) return tone(ASH, l + (hsh(x, y) - 0.5) * 0.4, x, y);
      if (u < 1.6) return tone(TOB, l, x, y);
      return tone(PAPER, l + (mod(u + cs * 2, 6) < 0.8 ? -0.18 : 0), x, y);
    }, hex('#1a100a')]], 5);
    return { cv: toCanvas(p), ox, oy };
  }
  function buildPuff(R) {
    const S = R * 2, cv = document.createElement('canvas'); cv.width = cv.height = S;
    const g = cv.getContext('2d'), sd = R * 7;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const d = Math.hypot(x + 0.5 - R, y + 0.5 - R) / R; if (d >= 1) continue;
      const k = Math.pow(1 - d, 1.3) * (0.55 + 0.9 * vnoise(x / 4 + sd, y / 4));
      if (k > bay(x, y) * 0.9) { g.fillStyle = d < 0.5 ? 'rgba(214,208,198,0.34)' : 'rgba(176,170,164,0.26)'; g.fillRect(x, y, 1, 1); }
    }
    return cv;
  }
  const NPF = 48, fx_ = new Float32Array(NPF), fy_ = new Float32Array(NPF), fvx = new Float32Array(NPF), fvy = new Float32Array(NPF), fl_ = new Float32Array(NPF), fm_ = new Float32Array(NPF), fs_ = new Uint8Array(NPF);
  let pfNext = 0, pfAcc = 0, wispAcc = 0;
  function drawEmber(ctx, x, y, dt) {
    const flare = dragT > 0.3 && dragT < 1.3 ? Math.min(1, (dragT - 0.3) / 0.12) * Math.min(1, (1.3 - dragT) / 0.15) : 0;
    emberK += (0.55 + 0.45 * rnd() - emberK) * 0.3;
    if (flare > 0) {
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.6 * flare; ctx.drawImage(GLOW_F, x - 30, y - 30);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      if (rnd() < dt * 18) sp(x, y, (rnd() - 0.5) * 50, -20 - rnd() * 40, 0.25 + rnd() * 0.2, 0);
    }
    ctx.globalAlpha = 0.55 + 0.3 * emberK; ctx.fillStyle = '#8a1606'; ctx.fillRect(x - 2, y - 2, 5, 5); ctx.globalAlpha = 1;
    ctx.fillStyle = flare > 0.3 ? '#ff8a28' : emberK > 0.75 ? '#ff5a18' : '#e03a10'; ctx.fillRect(x - 1, y - 1, 3, 3);
    if (flare > 0.3) { ctx.fillStyle = '#fff0a0'; ctx.fillRect(x - 1, y - 1, 2, 2); ctx.fillRect(x, y, 1, 1); }
    else if (emberK > 0.7) { ctx.fillStyle = '#ffc860'; ctx.fillRect(x, y - 1, 1, 1); }
    wispAcc += dt * (10 + flare * 12);
    while (wispAcc > 1) { wispAcc -= 1; sp(x + (rnd() - 0.5) * 2, y - 2, (rnd() - 0.5) * 5, -12 - rnd() * 9, 1.6 + rnd() * 1.1, 5); }
  }
  function drawSmoke(ctx, dt) {
    if (exhaleT >= 0 && exhaleT < 0.6) {
      pfAcc += dt * 50;
      while (pfAcc > 1) {
        pfAcc -= 1; const i = pfNext; pfNext = (pfNext + 1) % NPF;
        fx_[i] = 320 + (rnd() - 0.5) * 60; fy_[i] = 352 + rnd() * 10; fvx[i] = 30 + (rnd() - 0.5) * 90; fvy[i] = -(60 + rnd() * 70);
        fl_[i] = fm_[i] = 1.9 + rnd() * 0.6; fs_[i] = (rnd() * 3) | 0;
      }
    } else pfAcc = 0;
    const turn = turnV * 360 * dt;
    for (let i = 0; i < NPF; i++) {
      if (fl_[i] <= 0) continue;
      fl_[i] -= dt; const f = fl_[i] / fm_[i], a = 1 - f;
      fvx[i] += (26 - fvx[i]) * dt * 0.8; fvy[i] = fvy[i] * (1 - dt * 0.6) - 6 * dt;
      fx_[i] += fvx[i] * dt - turn; fy_[i] += fvy[i] * dt + hspeed * 3 * dt;
      const P = PUFF[Math.min(2, (a < 0.25 ? 0 : a < 0.55 ? 1 : 2) + (fs_[i] === 2 && a > 0.3 ? 0 : 0))], R = P.width >> 1;
      ctx.globalAlpha = Math.min(1, f * 1.4) * (a < 0.08 ? a / 0.08 : 1);
      ctx.drawImage(P, Math.round(fx_[i] - R), Math.round(fy_[i] - R));
    }
    ctx.globalAlpha = 1;
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
  const I = { moveX: 0, moveY: 0, lookDX: 0, lookDY: 0, sprint: false, jump: false, attack: false, heavy: 0, heavyRelease: false, block: false, dodge: false, torch: false, usePotion: false, offhand1: false, offhand2: false, offhandCycle: false, fire: false, reload: false };
  let fakeHeavy = 0;
  let atk = 0, atkK = 0, atkDur = 1, comboIdx = 0, comboTimer = 0, hitDone = false, buffered = false, whooshed = false, swingId = 0, heavyCharge = 0;
  let charging = false, charge = 0, fullFx = false, blockT = 0, guardBreakT = 0, blockKick = 0, parryT = 0, parryBurst = false;
  let dodgeT = -1, dodgeX = 0, dodgeZ = 0, dodgeSide = 0, drinkT = -1, drinkId = null, drinkDone = false;
  let hurtT = 0, grounded = true, sprinting = false, exhausted = false, stIdle = 9, hspeed = 0, inWater = 0, wasWater = false;
  let bobPh = 0, bobAmp = 0, dip = 0, kbx = 0, kbz = 0, lean = 0, deathT = 0, deathSide = 1, lastSave = null, poiT = 0;
  let ownBlade = 0, ownHands = 0, splashT = 0;
  let beer = false, goldT = 0, dragT = -1, dragCD = 0, exhaleT = -1, exhaleBurst = false, rushT = 0, crashT = -1, dizzy = 0, turnV = 0, emberK = 0.7;
  const OFF_KEY = 'crimsonThrone.offhand';
  try { PL.offhand = localStorage.getItem(OFF_KEY) === 'torch' ? 'torch' : 'cig'; } catch (e) { PL.offhand = 'cig'; }
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
    I.block = !!s.block; I.dodge = !!s.dodge; I.torch = !!s.torch; I.usePotion = !!s.usePotion; I.offhand1 = !!s.offhand1; I.offhand2 = !!s.offhand2; I.offhandCycle = !!s.offhandCycle; I.fire = !!s.fire; I.reload = !!s.reload;
    if (test) {                                                // controls absent: honour the debug flags, pressed flags last one frame
      if (c._forceAttack) { c._forceAttack = false; I.attack = true; }
      if (c._forceHeavy) { c._forceHeavy = false; fakeHeavy = 0.001; }
      if (c.state && c.state !== core.input) { const q = c.state; q.attack = q.jump = q.dodge = q.torch = q.usePotion = q.heavyRelease = q.interact = q.offhand1 = q.offhand2 = q.offhandCycle = q.fire = q.reload = false; q.lookDX = q.lookDY = 0; }
    }
    if (fakeHeavy > 0) { fakeHeavy += dt; I.heavy = fakeHeavy; if (fakeHeavy >= 1.1) { I.heavy = 0; I.heavyRelease = true; fakeHeavy = 0; } }
  }

  // ── Stamina ────────────────────────────────────────────────────────────────
  function clearRush() { rushT = 0; crashT = -1; dizzy = 0; if (CORE) CORE.dizzy = 0; }
  function useStamina(c) { PL.stamina = Math.max(0, PL.stamina - c * (rushT > 0 ? 0.7 : 1)); stIdle = 0; if (PL.stamina <= 0) exhausted = true; }

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
    aiming = false; reloadT = -1; if (CORE && CORE.camera) { fovNow = 70; CORE.camera.fov = 70; CORE.camera.updateProjectionMatrix(); }
    clearRush();
    PL.alive = false; PL.hp = 0; PL.blocking = false; PL.dodging = false; charging = false; atk = 0; drinkT = -1; deathT = 0;
    deathSide = Math.random() < 0.5 ? -1 : 1;
    sfx('death'); emit('playerDeath', {});
  }

  PL.hurt = function (amount, dir, source) {
    if (!PL.alive || !(amount > 0)) return 0;
    if (CT.vehicle && CT.vehicle.driving && typeof CT.vehicle.absorb === 'function') { const a = CT.vehicle.absorb(amount, dir, source); if (typeof a === 'number') amount = a; }   // Iron Stallion: the car takes most of it
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
  function setOffhand(o, silent) {
    if (o === PL.offhand) { if (o === 'torch' && !PL.torchLit) { PL.torchLit = true; if (!silent) sfx('torch', { on: true }); } return; }
    PL.offhand = o; dragT = -1;
    if (o === 'torch') PL.torchLit = true;
    try { localStorage.setItem(OFF_KEY, o); } catch (e) {}
    if (!silent) sfx(o === 'cig' ? 'lighter' : 'torch', { on: true });
  }
  PL.setOffhand = function (o) { setOffhand(o === 'torch' ? 'torch' : 'cig'); };
  // Selene's gifted smoke: a full drag (anim + stamina + RUSH), free ignores the cooldown and the off-hand.
  PL.drag = function (free) {
    if (!PL.alive || dragT >= 0) return false;
    if (!free && (PL.offhand !== 'cig' || dragCD > 0 || PL.rifle)) return false;
    dragT = 0; charging = false; if (atk && atkK > 0.5) atk = 0;
    if (!ARMS.F) arm('F');
    return true;
  };
  // Selene's beer revive: the left hand brings a bottle up for a chug; npcs.js does the heal.
  function beerRevive() {
    if (!PL.alive) return;
    drinkT = 0; drinkDone = true; beer = true; drinkId = null; dragT = -1; goldT = 1.1;
    PL.blocking = false; charging = false; atk = 0; hurtT = 0; kbx = kbz = 0;
    if (CORE) CORE.hurtFlash = 0;
    if (!ARMS.F) arm('F');
    sfx('beer');
  }
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
    PL.blocking = false; PL.dodging = false; ownBlade = ownHands = 0; dragT = exhaleT = -1; clearRush();
    if (has('gore', 'clear')) CT.gore.clear();
  };

  // ── Init ───────────────────────────────────────────────────────────────────
  PL.init = function (core) {
    CORE = core;
    buildFire(); for (let i = 0; i < 50; i++) fireStep(0, 0); fireAvg = fireSum || 1; fireRender();
    buildKinds();
    arm('R'); arm('T'); if (PL.offhand === 'cig') arm('F'); CIG = buildCig(); PUFF = [buildPuff(12), buildPuff(22), buildPuff(34)];
    GLOW_T = buildGlow(66, ['rgba(255,190,90,0.55)', 'rgba(255,140,50,0.42)', 'rgba(240,90,30,0.30)']);
    GLOW_R = buildGlow(30, ['rgba(255,60,30,0.6)', 'rgba(220,20,20,0.45)', 'rgba(140,0,10,0.35)']);
    GLOW_M = buildGlow(30, ['rgba(220,240,255,0.55)', 'rgba(150,200,255,0.4)', 'rgba(90,130,220,0.28)']);
    GLOW_F = buildGlow(30, ['rgba(255,230,150,0.65)', 'rgba(255,150,50,0.5)', 'rgba(230,70,20,0.35)']);
    curW = weapon(); kindName = kindOf(curW); setKind(kindName);
    setTimeout(() => { try { arm('B'); arm('F'); for (let a = 0; a <= 120; a += 30) { FLASK.push(buildFlask(a)); BOTTLE.push(buildBottle(a)); } } catch (e) { console.error('[CT.player bake]', e); } }, 300);
    PL.pos.set(C.START.x, hAt(C.START.x, C.START.z) + 0.05, C.START.z);
    PL.hp = hpMax(); PL.stamina = stMax();
    if (CT.bus) CT.bus.on('kill', onGuardianKill);
    if (CT.bus) CT.bus.on('beerRevive', beerRevive);
    if (CT.bus) CT.bus.on('kill', d => {
      if (!d || !d.point || !PL.alive || !CORE) return;
      if (Math.hypot(d.point.x - PL.pos.x, d.point.z - PL.pos.z) > 7) return;
      if (d.overkill > 50) { CORE.hitStop(0.12); CORE.shake(1, 0.45); ownHands = Math.min(1, ownHands + 0.2); }
      else if (d.overkill > 0) CORE.shake(0.9, 0.35);
    });
    if (CT.vehicle && typeof CT.vehicle.init === 'function') CT.vehicle.init(core);   // Iron Stallion (vehicle.js is not a core module)
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
    const rifleNow = !!(curW && (curW.style === 'rifle' || curW.ranged));
    if (rifleNow !== PL.rifle) { PL.rifle = rifleNow; reloadT = -1; aiming = false; dragT = -1; charging = false; atk = 0; }
    vaultUpdate(dt);
    // ── Iron Stallion (vehicle.js): while driving, the car owns movement and the camera ──
    if (CT.vehicle && typeof CT.vehicle.tick === 'function' && CT.vehicle.tick(dt, core)) { PL.blocking = PL.dodging = false; charging = false; atk = 0; hspeed = 0; sprinting = false; aiming = false; return; }
    if (PL.rifle && PL.alive) rifleUpdate(dt, core, cam); else aiming = false;
    PL.prompt = null;
    const sm = stMax();
    hurtT = Math.max(0, hurtT - dt * 4); parryT = Math.max(0, parryT - dt); blockKick = Math.max(0, blockKick - dt * 6); guardBreakT = Math.max(0, guardBreakT - dt);
    if (!PL.alive) { deathUpdate(dt, cam); return; }

    // look
    PL.yaw -= I.lookDX; PL.pitch = clamp(PL.pitch - I.lookDY, -1.4, 1.4);
    const fx = -Math.sin(PL.yaw), fz = -Math.cos(PL.yaw), rx = Math.cos(PL.yaw), rz = -Math.sin(PL.yaw);

    // torch + potion
    // off-hand: 1 torch, 2 cigarette (the number keys win over T); T sheathes the torch or swaps back to it
    const oh = I.offhand1 ? 'torch' : I.offhand2 ? 'cig' : I.offhandCycle ? (PL.offhand === 'cig' ? 'torch' : 'cig') : null;
    if (oh) setOffhand(oh);
    else if (I.torch) { if (PL.offhand === 'cig') setOffhand('torch'); else { PL.torchLit = !PL.torchLit; sfx('torch', { on: PL.torchLit }); } }
    turnV += (I.lookDX / Math.max(dt, 0.001) - turnV) * Math.min(1, dt * 10);
    // a drag on the cigarette (Space): raise 0.35 s, ember flare to 1.25 s, lower, exhale at 1.6 s
    dragCD = Math.max(0, dragCD - dt);
    // RUSH (5 s after a drag) then CRASH: dizzy ramps to 0.8 over 1 s and fades over 14 s; a new drag clears it in 0.6 s
    if (rushT > 0) { rushT -= dt; if (rushT <= 0) { rushT = 0; crashT = 0; } }
    if (crashT >= 0) { crashT += dt; dizzy = crashT < 1 ? 0.8 * crashT : 0.8 * Math.max(0, 1 - (crashT - 1) / 14); if (crashT >= 15) { crashT = -1; dizzy = 0; } }
    else if (dizzy > 0) dizzy = Math.max(0, dizzy - dt * 0.8 / 0.6);
    core.dizzy = dizzy;
    if (dragT >= 0 && (I.attack || I.block || I.dodge || I.heavy > 0.15 || I.usePotion)) dragT = -1;
    if (PL.offhand === 'cig' && !PL.rifle && I.jump && dragT < 0 && dragCD <= 0 && !atk && !PL.blocking && dodgeT < 0 && !charging && drinkT < 0) dragT = 0;
    if (dragT >= 0) {
      const d0 = dragT; dragT += dt;
      if (d0 < 0.35 && dragT >= 0.35) sfx('drag');
      if (d0 < 1.25 && dragT >= 1.25) { PL.stamina = Math.min(sm, PL.stamina + 15); if (PL.stamina >= sm * 0.2) exhausted = false; rushT = 5; crashT = -1; emit('notify', { text: 'Rush', kind: 'bark' }); }
      if (dragT >= 1.6) { dragT = -1; dragCD = 1.5; exhaleT = 0; exhaleBurst = true; sfx('exhale'); }
    }
    if (exhaleT >= 0) { exhaleT += dt; if (exhaleT >= 2.5) exhaleT = -1; }
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
      if (drinkT >= (beer ? 1.2 : 0.8)) { drinkT = -1; beer = false; }
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
    if (PL.blocking) speed *= 0.45; if (charging) speed *= 0.55; if (atk) speed *= atk === 2 ? 0.5 : 0.72; if (drinkT >= 0) speed *= 0.5; if (aiming) speed *= 0.55;
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
    if (sprinting && wl > 0.1) { PL.stamina = Math.max(0, PL.stamina - P.sprintCost * dt * (rushT > 0 ? 0.7 : 1)); stIdle = 0; if (PL.stamina <= 0) exhausted = true; }

    // jump + gravity
    if (I.jump && (PL.offhand !== 'cig' || PL.rifle) && grounded && drinkT < 0 && !PL.blocking) { v.y = P.jump; grounded = false; useStamina(6); sfx('jump'); }
    v.y -= 20 * dt;
    const oy = PL.pos.y;
    PL.pos.x += (v.x + kbx) * dt; PL.pos.z += (v.z + kbz) * dt; PL.pos.y += v.y * dt;
    const kd = Math.exp(-7 * dt); kbx *= kd; kbz *= kd;
    if (has('world', 'collide')) { const r = CT.world.collide(PL.pos, P.radius); if (r && r !== PL.pos && typeof r.x === 'number') { PL.pos.x = r.x; PL.pos.z = r.z; } PL.pos.y = oy + v.y * dt; }
    if (CT.vehicle && typeof CT.vehicle.pushOut === 'function') CT.vehicle.pushOut(PL.pos, P.radius);   // Iron Stallion: barn walls and the parked car
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
    if (stIdle > 0.8) PL.stamina = Math.min(sm, PL.stamina + P.staminaRegen * dt * (PL.blocking ? 0.4 : 1) * (rushT > 0 ? 2.5 : dizzy > 0.05 ? 0.35 : 1));
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
    PL.roll = Math.sin(bobPh) * 0.008 * bobAmp + lean + Math.sin(core.time * 0.7) * 0.0436 * dizzy;
    cam.position.set(PL.pos.x, PL.pos.y + P.eye + (Math.abs(Math.sin(bobPh)) - 0.5) * 0.07 * bobAmp - dip - (charging ? charge * 0.05 : 0), PL.pos.z);
    if (exhaleT >= 0) { const k = Math.sin(Math.PI * exhaleT / 2.5); PL.roll += Math.sin(core.time * 1.3) * 0.016 * k; }
    cam.rotation.set(PL.pitch + recoilP + hurtT * 0.05 + Math.sin(core.time * 0.45) * 0.03 * dizzy + (exhaleT >= 0 ? Math.sin(core.time * 0.9) * 0.012 * Math.sin(Math.PI * exhaleT / 2.5) : 0), PL.yaw + recoilY, PL.roll);
    const fovT = PL.rifle && aiming ? 45 : 70;
    if (Math.abs(fovNow - fovT) > 0.05) { fovNow += (fovT - fovNow) * Math.min(1, dt * 12); cam.fov = fovNow; cam.updateProjectionMatrix(); }
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
    if (PL.rifle) {                                            // both hands on the rifle: no torch; the muzzle flash lights the scene
      if (muzzleT > 0) { tl.intensity = 9; tl.distance = 35; } else { tl.intensity += ((PL.alive ? 0.5 : 0) - tl.intensity) * Math.min(1, dt * 14 || 0); tl.distance = 12; }
      return;
    }
    const cig = PL.offhand === 'cig';
    const target = !PL.alive ? 0 : cig ? 0.12 + 0.06 * emberK + (dragT > 0.3 && dragT < 1.3 ? 0.3 : 0) : PL.torchLit ? (3 + 2 * flick) * (K && K.twoHand ? 0.7 : 1) : 0;
    tl.intensity += (target - tl.intensity) * Math.min(1, dt * 14 || 0);
    tl.distance = cig ? 2 : 22;
  }
  function deathUpdate(dt, cam) {
    deathT += dt;
    const k = Math.min(1, deathT / 1.1), e = k * k, bounce = k >= 1 ? Math.max(0, Math.sin((deathT - 1.1) * 14) * 0.03 * Math.exp(-(deathT - 1.1) * 5)) : 0;
    PL.roll = deathSide * 1.3 * ease(k);
    cam.position.set(PL.pos.x, PL.pos.y + P.eye - (P.eye - 0.28) * e + bounce, PL.pos.z);
    cam.rotation.set(PL.pitch * (1 - k) + 0.18 * k, PL.yaw + deathSide * 0.25 * ease(k), PL.roll);
    torch(dt, CORE);
  }

  // ── AR-15 'Thunderstick': a sky-iron relic. Semi-auto hitscan, ADS, reload, tracers, casings ──
  const AR_MAG = 30, AR_RANGE = 120;
  let aiming = false, adsK = 0, fireCD = 0, reloadT = -1, recoilP = 0, recoilY = 0, fireK = 0, dryK = 0, muzzleT = 0;
  let casingN = 0, casingSfxT = -1, tracerT = 0, tracerX1 = 0, tracerY1 = 0, tracerHit = false, arMagLocal = AR_MAG, fovNow = 70;
  const DIR = new THREE.Vector3(), TR = new THREE.Vector3();
  PL.rifle = false; PL.ammo = { mag: 0, reserve: 0 };
  const flags = () => (CT.rpg && CT.rpg.flags) || null;
  function arMag() { const f = flags(); return f && typeof f.arMag === 'number' ? f.arMag : arMagLocal; }
  function setMag(n) { arMagLocal = n; const f = flags(); if (f) f.arMag = n; }
  function arReserve() { return CT.rpg && typeof CT.rpg.count === 'function' ? CT.rpg.count('ammo556') || 0 : 0; }
  function rifleUpdate(dt, core, cam) {
    fireCD -= dt; dryK = Math.max(0, dryK - dt * 5); fireK = Math.max(0, fireK - dt * 10); muzzleT -= dt; tracerT -= dt;
    recoilP *= Math.exp(-dt * 9); recoilY *= Math.exp(-dt * 9);
    if (casingSfxT >= 0) { casingSfxT -= dt; if (casingSfxT < 0) sfx('ar_casing'); }
    aiming = I.block && reloadT < 0 && !sprinting && dodgeT < 0 && drinkT < 0 && PL.alive;
    const res = arReserve();
    if (reloadT >= 0) {                                         // mag out, a fresh mag in at 1.3 s, the charging handle, done at 2.2 s
      const r0 = reloadT; reloadT += dt;
      if (r0 < 1.3 && reloadT >= 1.3) { const n = Math.min(AR_MAG - arMag(), res); if (n > 0 && CT.rpg && CT.rpg.take && CT.rpg.take('ammo556', n)) setMag(arMag() + n); }
      if (reloadT >= 2.2) reloadT = -1;
    } else if ((I.reload || (I.fire && arMag() <= 0 && res > 0)) && arMag() < AR_MAG && res > 0 && drinkT < 0) { reloadT = 0; sfx('ar_reload'); }
    if (I.fire && reloadT < 0 && fireCD <= 0 && drinkT < 0 && dodgeT < 0) {
      fireCD = 0.09;
      if (arMag() <= 0) { sfx('ar_dry'); dryK = 1; }
      else { setMag(arMag() - 1); shoot(core, cam); }
    }
    PL.ammo.mag = arMag(); PL.ammo.reserve = arReserve();
    I.attack = false; I.heavy = 0; I.heavyRelease = false; I.block = false;   // no melee while the rifle is out
  }
  function shoot(core, cam) {
    camVectors();
    const w = curW || {}, spread = aiming ? 0.0025 : 0.014 + Math.min(0.02, hspeed * 0.003);
    DIR.set(FWD.x + (rnd() - 0.5) * spread * 2, FWD.y + (rnd() - 0.5) * spread * 2, FWD.z + (rnd() - 0.5) * spread * 2).normalize();
    const org = cam.position;
    let dist = AR_RANGE, hit = null;
    if (has('world', 'raycast')) { const g = CT.world.raycast(org, DIR, AR_RANGE); if (g && g.dist > 0) dist = g.dist; }
    if (has('monsters', 'hitTest')) {
      const hits = CT.monsters.hitTest(org, DIR, dist, 0.03) || [];
      for (let i = 0; i < hits.length; i++) {
        const h = hits[i], m = h && h.monster; if (!m || m.dead || m.alive === false || !h.point) continue;
        TR.subVectors(h.point, org); const along = TR.dot(DIR); if (along < 0 || along > dist) continue;
        TR.addScaledVector(DIR, -along);
        if (TR.length() > 0.55 * (m.scale || 1) + 0.3) continue;   // the round must pass close to that body part
        hit = h; dist = along; break;
      }
    }
    TR.copy(org).addScaledVector(DIR, dist);
    if (hit) {
      const m = hit.monster, head = hit.part === 'head';
      let dmg = (w.damage || 34) * (dist > 60 ? 1 - 0.5 * Math.min(1, (dist - 60) / 60) : 1) * (head ? 2.5 : 1) * (m.type === 'boneKing' ? 0.5 : 1);
      dmg = Math.round(dmg);
      const r = (has('monsters', 'damage') && CT.monsters.damage(m, dmg, DIR.clone(), hit.part, head)) || {};
      impactFx(hit.point, 0, head, r.killed || r.severed);
      sfx('flesh', { pos: hit.point }); if (head || r.killed) sfx('bone', { pos: hit.point });
      core.hitStop(head ? 0.05 : 0.025);
      if (r.killed && head) core.shake(0.6, 0.25);
    } else if (dist < AR_RANGE) {                                // the round strikes the ground or rock: sparks
      TMP.copy(TR).project(cam); if (TMP.z < 1) { const x = (TMP.x + 1) * W / 2, y = (1 - TMP.y) * H / 2; for (let i = 0; i < 6; i++) sp(x, y, (rnd() - 0.5) * 160, -rnd() * 120, 0.2 + rnd() * 0.2, 0); }
    }
    TMP.copy(TR).project(cam);                                   // the tracer ends where the round stopped
    tracerX1 = (TMP.x + 1) * W / 2; tracerY1 = (1 - TMP.y) * H / 2; tracerT = 0.05; tracerHit = !!hit;
    if (TMP.z > 1) { tracerX1 = W / 2; tracerY1 = H / 2; }
    // the thunder carries: everything within 60 m comes
    const L = CT.monsters && CT.monsters.list;
    if (L) for (let i = 0; i < L.length; i++) {
      const o = L[i]; if (!o || o.dead || o.alive === false || o.state === 'dormant' || !o.pos) continue;
      if (Math.hypot(o.pos.x - PL.pos.x, o.pos.z - PL.pos.z) < 60) { o.aggro = true; if (o.state === 'idle' || o.state === 'wander' || o.state === 'patrol' || o.state === 'return') o.state = 'chase'; }
    }
    recoilP += aiming ? 0.02 : 0.034; recoilY += (rnd() - 0.5) * 0.012; fireK = 1; muzzleT = 0.06; casingN++; casingSfxT = 0.32;
    core.shake(aiming ? 0.18 : 0.26, 0.12);
    sfx('ar_shot', { pos: org });
    emit('shot', { weapon: curW, pos: org });
  }

  // Rifle sprites: a hip view (a black M4 in pseudo-perspective, the muzzle toward the centre) and an ADS rear view.
  const GUN = ramp(['#060608', '#0e0f12', '#18191e', '#24262c', '#34373f', '#4a4e58', '#6a707c']);
  const AR_S = 1.5, AR_TH = 22 * DEG, AR_UG = 246, AR_LEN = 336;
  const ARD = [Math.cos(AR_TH), Math.sin(AR_TH)], ARN = [-Math.sin(AR_TH), Math.cos(AR_TH)];
  const arTaper = U => 0.55 + 0.45 * clamp(U, 0, AR_LEN) / AR_LEN;
  function arToScreen(U, V, out) { const a = AR_S * (U - AR_UG), p = AR_S * arTaper(U) * V; out[0] = a * ARD[0] + p * ARN[0]; out[1] = a * ARD[1] + p * ARN[1]; return out; }
  const box = (U, V, u0, u1, v0, v1) => U >= u0 && U <= u1 && V >= v0 && V <= v1;
  function edgeL(V, v0, v1, l) { return V < v0 + 1.4 ? l + 0.28 : V > v1 - 1.2 ? l - 0.2 : l; }
  function rifleBody(U, V, x, y) {
    const cylL = (c, r) => { const q = clamp((V - c) / r, -1, 1); return 0.2 + 0.55 * (1 - (q + 0.45) * (q + 0.45)); };
    if (box(U, V, 0, 16, -3.8, 3.8)) return U > 3 && U < 13 && mod(U, 4) < 1.4 && V < 0 ? GUN[0] : tone(GUN, cylL(0, 3.8), x, y);    // flash hider
    if (box(U, V, 16, 70, -2.6, 2.6)) return tone(GUN, cylL(0, 2.6) + 0.05, x, y);                                                    // barrel
    if (box(U, V, 58, 70, -4, 4)) return tone(GUN, edgeL(V, -4, 4, 0.35), x, y);                                                       // gas block
    if (V > -20 && V < -4 && Math.abs(U - 65) < 1.4) return tone(GUN, 0.5, x, y);                                                      // front sight post
    if (V > -14 && V < -4 && Math.abs(U - 65) < 2 + (V + 14) * 0.4 && !(Math.abs(U - 65) < (V + 14) * 0.4 - 1.2 && V > -11)) return tone(GUN, 0.38 - (U - 65) * 0.02, x, y);
    if (box(U, V, 70, 172, -13, -10)) return mod(U, 4) < 2 ? tone(GUN, 0.62, x, y) : V > -11.6 ? tone(GUN, 0.4, x, y) : 0;             // top rail
    if (box(U, V, 70, 172, -10, 10)) {                                                                                                    // handguard with vents
      if (mod(U, 9) < 3.4 && (Math.abs(V + 3.5) < 1.6 || Math.abs(V - 4) < 1.6)) return GUN[0];
      return tone(GUN, cylL(-1, 10.5), x, y);
    }
    if (box(U, V, 170, 176, -11.5, 11.5)) return tone(GUN, cylL(0, 11.5) + 0.12, x, y);                                               // delta ring
    if (box(U, V, 195, 230, -16, -11)) return tone(GUN, edgeL(V, -16, -11, 0.3), x, y);                                               // optic mount
    if (box(U, V, 188, 236, -28, -16)) {                                                                                                  // red-dot tube
      if (U < 191) return V < -22 ? hex('#8a2030') : hex('#3a4a6a');
      return tone(GUN, cylL(-22, 6.2) + (Math.abs(U - 212) < 3 ? 0.12 : 0), x, y);
    }
    if (box(U, V, 250, 262, -14, -10)) return tone(GUN, edgeL(V, -14, -10, 0.45), x, y);                                              // charging handle
    if (box(U, V, 176, 258, -11, 7)) {                                                                                                    // upper receiver
      if (box(U, V, 205, 228, -4, 2)) return tone(GUN, 0.12, x, y);                                                                  // ejection port
      if (Math.hypot(U - 244, V - 1.5) < 3.4) return tone(GUN, 0.6, x, y);                                                              // forward assist
      return tone(GUN, edgeL(V, -11, 7, 0.34) + (hsh(x, y) < 0.03 ? 0.15 : 0), x, y);
    }
    if (box(U, V, 188, 252, 7, 16)) return tone(GUN, edgeL(V, 7, 16, 0.26), x, y);                                                   // lower receiver
    if (box(U, V, 218, 240, 16, 22) && (U < 219.8 || U > 238.2 || V > 20.4)) return tone(GUN, 0.3, x, y);                            // trigger guard
    if (box(U, V, 224, 227, 14, 20)) return tone(GUN, 0.45, x, y);                                                                     // trigger
    if (V > 12 && V < 48) { const uc = 240 + (V - 12) * 0.35; if (Math.abs(U - uc) < 7 - (V > 44 ? (V - 44) * 1.2 : 0)) return tone(GUN, 0.22 + (U < uc - 4 ? 0.2 : 0) + (mod(V, 4) < 1 ? -0.08 : 0), x, y); }   // pistol grip
    if (box(U, V, 256, 300, -6.5, 2.5)) return tone(GUN, cylL(-2, 4.5), x, y);                                                         // buffer tube
    if (U >= 286 && U <= 336 && V >= -9 && V <= 8 + (U - 286) * 0.2) {                                                                   // stock
      if (U > 330) return tone(GUN, 0.1, x, y);
      if (box(U, V, 296, 322, -4, 2)) return tone(GUN, 0.12, x, y);
      return tone(GUN, edgeL(V, -9, 18, 0.3), x, y);
    }
    return 0;
  }
  function rifleMag(U, V, x, y) {                                // the curved 30-round magazine
    if (V < 14 || V > 62) return 0;
    const t = (V - 14) / 48, uf = 192 - t * 12 - t * t * 8;
    if (U < uf || U > uf + 22) return 0;
    if (V > 58) return tone(GUN, 0.42, x, y);
    return tone(GUN, 0.2 + (U < uf + 3 ? 0.22 : 0) + (mod(V, 7) < 1 ? -0.08 : 0), x, y);
  }
  function bakeRifle(fn) {
    let mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9; const o = [0, 0];
    for (const U of [0, AR_LEN]) for (const V of [-30, 64]) { arToScreen(U, V, o); mnx = Math.min(mnx, o[0]); mxx = Math.max(mxx, o[0]); mny = Math.min(mny, o[1]); mxy = Math.max(mxy, o[1]); }
    const ox = Math.ceil(-mnx) + 3, oy = Math.ceil(-mny) + 3, w = Math.ceil(mxx) + ox + 3, h = Math.ceil(mxy) + oy + 3;
    const T = [ARD[0], ARD[1], -(ox * ARD[0] + oy * ARD[1]), ARN[0], ARN[1], -(ox * ARN[0] + oy * ARN[1])];
    const p = paint(w, h, T, [[(a, pp, x, y) => { const U = a / AR_S + AR_UG; return fn(U, pp / (AR_S * arTaper(U)), x, y); }, hex('#000000')]], 1e9);
    return { cv: toCanvas(p), ox, oy };
  }
  function bakeADS() {                                           // rear view: the red-dot ring centred on the screen, receiver and stock below
    const w = 240, h = 260, cx = 120, cy = 34, p = { d: new Uint32Array(w * h), w, h };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy, r = Math.hypot(dx, dy); let c = 0;
      if (r < 34 && r > 26) c = tone(GUN, 0.3 + (dx + dy < -20 ? 0.3 : 0) - (r > 32.5 ? 0.15 : 0), x, y);
      else if (r >= 34 && r < 35.5) c = GUN[0];
      else if (y > cy + 26 && y < cy + 50 && Math.abs(dx) < 16) c = tone(GUN, 0.28 + (Math.abs(dx) > 14 ? -0.1 : 0), x, y);   // mount
      else if (y >= cy + 50) {                                                                                               // receiver, charging handle, stock
        const hw = 22 + (y - cy - 50) * 0.42;
        if (Math.abs(dx) < hw) c = tone(GUN, 0.18 + (dx < -hw + 3 ? 0.25 : 0) + (y < cy + 54 ? 0.3 : 0) + (Math.abs(dx) < 6 && y < cy + 70 ? 0.2 : 0), x, y);
        else if (Math.abs(dx) < hw + 1.2) c = GUN[0];
      }
      p.d[y * w + x] = c;
    }
    return { cv: toCanvas(p), ox: cx, oy: cy };
  }
  const MFLASH = [];
  function buildMuzzle() {
    for (let k = 0; k < 3; k++) {
      const S = 48, cv = document.createElement('canvas'); cv.width = cv.height = S; const g = cv.getContext('2d'), R = CT.rng(77 + k);
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const dx = x + 0.5 - S / 2, dy = y + 0.5 - S / 2, r = Math.hypot(dx, dy) / (S / 2), a = Math.atan2(dy, dx);
        const spike = 0.35 + 0.65 * Math.pow(Math.abs(Math.cos(a * (3 + k))), 6) * (0.7 + 0.3 * R());
        if (r > spike) continue;
        const q = r / spike; g.fillStyle = q < 0.3 ? '#fffbe8' : q < 0.6 ? '#ffd060' : '#ff7a20'; if (q > 0.85 && bay(x, y) > 0.5) continue;
        g.fillRect(x, y, 1, 1);
      }
      MFLASH.push(cv);
    }
  }
  let RIFLE = null, RMAG = null, RADS = null;
  function ensureRifle() { if (!RIFLE) { RIFLE = bakeRifle(rifleBody); RMAG = bakeRifle(rifleMag); RADS = bakeADS(); buildMuzzle(); } }
  const P2 = [0, 0];
  function line(ctx, x0, y0, x1, y1) {                          // a crisp 1 px line
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) | 0;
    for (let i = 0; i <= n; i += 1) { const k = n ? i / n : 0; ctx.fillRect((x0 + (x1 - x0) * k) | 0, (y0 + (y1 - y0) * k) | 0, 1, 1); }
  }
  let rgx = 566, rgy = 298;
  function drawRifle(ctx, dt) {
    ensureRifle(); if (!ARMS.F) arm('F');
    adsK += ((aiming ? 1 : 0) - adsK) * Math.min(1, dt * 12);
    const wk = clamp(hspeed / 4.5, 0, 1.3), idle = 1 - Math.min(1, wk);
    let tx = 566, ty = 298;
    if (sprinting) { tx = 620; ty = 390; }
    rgx += (tx - rgx) * Math.min(1, dt * 9); rgy += (ty - rgy) * Math.min(1, dt * 9);
    let ox = rgx + Math.sin(bobPh) * 5 * wk * (1 - adsK) + Math.sin(clock * 0.9) * 1.2 * idle, oy = rgy + Math.cos(2 * bobPh) * 4 * wk * (1 - adsK) + Math.sin(clock * 1.7) * 1.6 * idle;
    if (dizzy > 0) { ox += Math.sin(clock * 0.8) * 8 * dizzy; oy += Math.cos(clock * 0.6) * 6 * dizzy; }
    if (hurtT > 0) { ox += 12 * hurtT; oy += 18 * hurtT; }
    ox += ARD[0] * 12 * fireK; oy += ARD[1] * 12 * fireK - 5 * fireK;             // recoil pushes the rifle back into the shoulder
    if (dryK > 0) oy += 2 * dryK;
    let rl = 0;                                                                     // reload tilt
    if (reloadT >= 0) { rl = reloadT < 0.25 ? reloadT / 0.25 : reloadT > 1.95 ? Math.max(0, (2.2 - reloadT) / 0.25) : 1; ox += 14 * rl; oy += 22 * rl; }
    if (!PL.alive) { const k = Math.min(1, deathT / 0.9); oy += 420 * k * k; }
    const hq = Math.round(handLevel() * 8) + (wetness('handsWet') > 0.45 ? 9 : 0);
    updateRim(dt);
    const hip = adsK < 0.5;
    if (hip) {
      const lift = adsK * 2;                                                        // on the way up to the sights
      ox -= 90 * lift; oy -= 40 * lift;
      const X = Math.round(ox), Y = Math.round(oy);
      // magazine: seated, dropping out, or coming back in with the left hand
      let mx = X, my = Y, showMag = true;
      if (reloadT >= 0.25 && reloadT < 1.0) { const k = (reloadT - 0.25) / 0.45; my += 420 * k * k; mx += 20 * k; showMag = k < 1; }
      else if (reloadT >= 1.0 && reloadT < 1.3) { const k = 1 - (reloadT - 1.0) / 0.3; my += 120 * k * k; }
      if (showMag) ctx.drawImage(RMAG.cv, mx - RMAG.ox, my - RMAG.oy);
      ctx.drawImage(RIFLE.cv, X - RIFLE.ox, Y - RIFLE.oy);
      // hands: the right fist on the pistol grip; the left under the handguard, at the mag or the charging handle during a reload
      arToScreen(244, 26, P2); const gx = X + P2[0], gy = Y + P2[1];
      arToScreen(100, 8, P2); let lx = X + P2[0], ly = Y + P2[1];
      if (reloadT >= 0) {
        const at = (U, V) => { arToScreen(U, V, P2); return [X + P2[0], Y + P2[1]]; };
        const hg = [lx, ly], mg = at(204, 40), ch = at(256, -12), off = [lx - 60, ly + 260];
        const lerp2 = (a, b, k) => { lx = a[0] + (b[0] - a[0]) * k; ly = a[1] + (b[1] - a[1]) * k; };
        const r = reloadT;
        if (r < 0.25) lerp2(hg, mg, ease(r / 0.25));
        else if (r < 0.5) lerp2(mg, mg, 0);
        else if (r < 0.9) lerp2(mg, off, ease((r - 0.5) / 0.4));
        else if (r < 1.3) { const k = ease((r - 0.9) / 0.4); lerp2(off, mg, k); if (r >= 1.0) { const m = [mg[0], mg[1] + 120 * (1 - (r - 1.0) / 0.3) ** 2]; lerp2(m, m, 0); } }
        else if (r < 1.55) lerp2(mg, ch, ease((r - 1.3) / 0.25));
        else if (r < 1.85) { const k = Math.sin(Math.PI * (r - 1.55) / 0.3); lerp2(ch, [ch[0] + ARD[0] * 26, ch[1] + ARD[1] * 26], k); }
        else lerp2(ch, hg, ease(Math.min(1, (r - 1.85) / 0.35)));
      }
      drawArm(ctx, ARMS.F, Math.round(lx), Math.round(ly), hq, 1, 0, 0, false);
      drawArm(ctx, ARMS.R, Math.round(gx), Math.round(gy), hq, 1, 0, 0, false);
      arToScreen(0, 0, P2); fx0 = X + P2[0]; fy0 = Y + P2[1];
      arToScreen(216, -1, P2); ejx = X + P2[0]; ejy = Y + P2[1];
    } else {
      const k = (adsK - 0.5) * 2, X = W / 2 + Math.round((ox - rgx) * 0.4), Y = Math.round(H / 2 + (1 - k) * 140 + (oy - rgy) * 0.5 - 2 * fireK);
      ctx.drawImage(RADS.cv, X - RADS.ox, Y - RADS.oy);
      if (reloadT < 0) { ctx.fillStyle = '#ff2a1a'; ctx.fillRect(X - 1, Y - 1, 2, 2); ctx.globalAlpha = 0.5; ctx.fillRect(X - 2, Y, 4, 1); ctx.fillRect(X, Y - 2, 1, 4); ctx.globalAlpha = 1; }
      drawArm(ctx, ARMS.F, X - 70, Y + 150, hq, 1, 0, 0, false);
      drawArm(ctx, ARMS.R, X + 72, Y + 176, hq, 1, 0, 0, false);
      fx0 = X; fy0 = Y - 40; ejx = X + 30; ejy = Y + 60;
    }
    // muzzle flash, tracer, casings
    if (muzzleT > 0) {
      const f = MFLASH[(rnd() * 3) | 0];
      ctx.globalCompositeOperation = 'lighter'; ctx.drawImage(f, Math.round(fx0 - 24), Math.round(fy0 - 24)); ctx.drawImage(GLOW_F, Math.round(fx0 - 30), Math.round(fy0 - 30)); ctx.globalCompositeOperation = 'source-over';
    }
    if (tracerT > 0) { ctx.fillStyle = '#fff4c0'; line(ctx, fx0, fy0, tracerX1, tracerY1); ctx.fillStyle = '#ffb040'; line(ctx, fx0 + 1, fy0, tracerX1 + 1, tracerY1); if (tracerHit) flash(tracerX1, tracerY1, 0, true); tracerHit = false; }
    while (casingN > 0) { casingN--; sp(ejx, ejy, 120 + rnd() * 90, -150 - rnd() * 80, 0.9, 6); }
  }
  let fx0 = 320, fy0 = 180, ejx = 400, ejy = 260;

  // ── The Sky-Iron Vault: a steel bunker door half-buried in the snow of the Frozen Teeth ──
  // The Moonblade guardian drops the Sky-Iron Key; the vault gives the AR-15 and 120 rounds.
  const VAULT = { x: -220, z: -760, io: null, group: null, door: null, open: 0, seen: false };
  function buildVault(core) {
    let bx = VAULT.x, bz = VAULT.z, bs = 1e9;                  // settle on the flattest ground near (-220, -760)
    for (let dz = -48; dz <= 48; dz += 6) for (let dx = -48; dx <= 48; dx += 6) {
      const x = -220 + dx, z = -760 + dz, h = hAt(x, z);
      const sl = Math.abs(hAt(x + 4, z) - h) + Math.abs(hAt(x - 4, z) - h) + Math.abs(hAt(x, z + 4) - h) + Math.abs(hAt(x, z - 4) - h) + Math.hypot(dx, dz) * 0.02;
      if (sl < bs) { bs = sl; bx = x; bz = z; }
    }
    VAULT.x = bx; VAULT.z = bz;
    const T = THREE, g = new T.Group(), y = hAt(VAULT.x, VAULT.z);
    const steel = new T.MeshLambertMaterial({ color: 0x5a6068 }), dark = new T.MeshLambertMaterial({ color: 0x23262b });
    const conc = new T.MeshLambertMaterial({ color: 0x7a766e }), snow = new T.MeshLambertMaterial({ color: 0xe8eef4 });
    const cv = document.createElement('canvas'); cv.width = 64; cv.height = 8; const c = cv.getContext('2d');
    for (let i = 0; i < 8; i++) { c.fillStyle = i % 2 ? '#1a1a1a' : '#c8a020'; c.beginPath(); c.moveTo(i * 8, 0); c.lineTo(i * 8 + 8, 0); c.lineTo(i * 8 + 4, 8); c.lineTo(i * 8 - 4, 8); c.fill(); }
    const tex = new T.CanvasTexture(cv); tex.colorSpace = T.SRGBColorSpace; tex.magFilter = T.NearestFilter;
    const frame = new T.Mesh(new T.BoxGeometry(6, 4.2, 1.6), conc); frame.position.set(0, 1.1, 0); g.add(frame);
    const stripe = new T.Mesh(new T.BoxGeometry(6.02, 0.35, 1.62), new T.MeshLambertMaterial({ map: tex })); stripe.position.set(0, 3.0, 0); g.add(stripe);
    const hole = new T.Mesh(new T.BoxGeometry(3.6, 3, 1.2), dark); hole.position.set(0, 1.0, 0.3); g.add(hole);
    const pivot = new T.Group(); pivot.position.set(-1.8, 1.0, 0.95); g.add(pivot);
    const door = new T.Mesh(new T.BoxGeometry(3.6, 3, 0.35), steel); door.position.set(1.8, 0, 0); pivot.add(door);
    const wheel = new T.Mesh(new T.TorusGeometry(0.55, 0.08, 6, 12), dark); wheel.position.set(1.8, 0, 0.25); pivot.add(wheel);
    for (let i = 0; i < 6; i++) { const b = new T.Mesh(new T.CylinderGeometry(0.09, 0.09, 0.12, 6), dark); b.rotation.x = Math.PI / 2; b.position.set(0.3 + (i % 3) * 1.5, i < 3 ? 1.25 : -1.25, 0.22); pivot.add(b); }
    const mound = new T.Mesh(new T.SphereGeometry(5, 10, 6), snow); mound.scale.set(1.3, 0.55, 1.1); mound.position.set(0, -0.4, -2.4); g.add(mound);
    const drift = new T.Mesh(new T.SphereGeometry(2.2, 8, 5), snow); drift.scale.set(1.4, 0.45, 0.9); drift.position.set(2.8, -0.3, 1.2); g.add(drift);
    g.position.set(VAULT.x, y - 1.3, VAULT.z); g.rotation.set(-0.12, 0.6, 0.05);
    core.scene.add(g); VAULT.group = g; VAULT.door = pivot;
    const f = flags(); if (f && f.skyVaultOpen) VAULT.open = 1;
  }
  function useVault(o) {
    const r = CT.rpg, f = flags();
    if (f && f.skyVaultOpen) { emit('notify', { text: 'The vault is empty. Only dust and the smell of old iron.', kind: 'info' }); return; }
    if (!r || typeof r.has !== 'function' || !r.has('skykey')) { emit('notify', { text: 'The iron door will not move. There is a keyhole, cold as the grave.', kind: 'info' }); sfx('ar_dry'); return; }
    if (r.take) r.take('skykey', 1);
    if (f) { f.skyVaultOpen = true; if (typeof f.arMag !== 'number') f.arMag = AR_MAG; }
    if (r.grant) { r.grant('ar15', 1); r.grant('ammo556', 120); }
    emit('notify', { text: "The Sky-Iron Vault groans open. Inside, wrapped in oilcloth: the AR-15 'Thunderstick'.", kind: 'story' });
    sfx('ar_reload'); if (CORE) CORE.shake(0.4, 0.6);
    if (r.save) r.save();
  }
  function vaultUpdate(dt) {
    if (!VAULT.group && CORE && CORE.scene) buildVault(CORE);
    if (!VAULT.io && CT.interactables && typeof CT.interactables.add === 'function') VAULT.io = CT.interactables.add({ x: VAULT.x, z: VAULT.z, radius: 5.5, label: 'Open the Sky-Iron Vault', onUse: useVault });
    const f = flags();
    if (VAULT.door) { const tgt = f && f.skyVaultOpen ? 1 : 0; VAULT.open += (tgt - VAULT.open) * Math.min(1, dt * 1.2); VAULT.door.rotation.y = -1.9 * VAULT.open; }
    if (!VAULT.seen && Math.hypot(PL.pos.x - VAULT.x, PL.pos.z - VAULT.z) < 30) {
      VAULT.seen = true;
      if (!(f && f.skyVaultSeen)) { if (f) f.skyVaultSeen = true; emit('notify', { text: 'DISCOVERED: The Sky-Iron Vault', kind: 'discover' }); sfx('discover'); }
    }
  }
  function onGuardianKill(d) {
    const m = (d && d.monster) || {};
    if (!(d && (d.guardian || d.isGuardian || m.isGuardian || m.guardian))) return;
    const r = CT.rpg, f = flags(); if (!r || !f || f.skyKeyDropped) return;
    f.skyKeyDropped = true;
    setTimeout(() => { if (r.grant) r.grant('skykey', 1); emit('notify', { text: "A strange iron key falls from the guardian's chest...", kind: 'story' }); }, 1800);
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
  let seenSwing = 0, sBx = 0, sBy = 0, sBa = 0, leftShown = PL.offhand === 'cig' ? 'C' : 'T', swapK = 0, glintT = 1.5, eAcc = 0;
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
    if (CT.vehicle && CT.vehicle.driving) return;   // Iron Stallion: both hands on the wheel
    const t0 = performance.now();
    let dt = lastT < 0 ? 0.016 : t - lastT; lastT = t;
    if (!(dt > 0)) dt = 0; else if (dt > 0.1) dt = 0.1;
    clock += dt;
    ctx.imageSmoothingEnabled = false;
    if (PL.rifle) drawRifle(ctx, dt); else {
    const wk = clamp(hspeed / 4.5, 0, 1.3), idle = 1 - Math.min(1, wk), two = K.twoHand;

    // right hand base pose, smoothed
    let tx = 506 + K.px, ty = 276 + K.py, ta = -18;
    if (sprinting) { tx = 572; ty = 350; ta = 8; }
    if (PL.blocking) { if (leftShown === 'B') { tx = 540; ty = 300; ta = K.angOff ? -20 : -36; } else { tx = 440; ty = 258; ta = K.angOff ? 10 : -84; } }
    if (charging) { tx = HK[0] - 6; ty = HK[1] + 8; ta = HK[2] - 8; }
    if (drinkT >= 0) { tx = 590; ty = 392; ta = 6; }
    if (dragT >= 0) { tx += 30; ty += 36; ta += 6; }
    const kf = 1 - Math.exp(-dt * (PL.blocking || charging ? 16 : 9));
    bRx += (tx - bRx) * kf; bRy += (ty - bRy) * kf; bRa += (ta - bRa) * kf;
    let rx = bRx + Math.sin(bobPh) * 5 * wk + Math.sin(clock * 0.9) * 0.8 * idle;
    let ry = bRy + Math.cos(2 * bobPh) * 4 * wk + Math.sin(clock * 1.7) * 1.8 * idle;
    let ra = bRa + Math.sin(clock * 0.7) * 0.8 * idle;
    if (sprinting) { ry += Math.sin(bobPh) * 9; ra += Math.sin(bobPh) * 6; }
    if (dizzy > 0) { rx += Math.sin(clock * 0.8) * 8 * dizzy; ry += Math.cos(clock * 0.6) * 6 * dizzy; ra += Math.sin(clock * 0.7) * 4 * dizzy; }
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
    const want = two ? 'G' : drinkT >= 0 ? 'F' : PL.offhand === 'cig' || dragT >= 0 ? 'C' : PL.torchLit ? 'T' : 'B';
    if (leftShown !== want) { swapK += dt * (want === 'F' ? 9 : 6); if (swapK >= 1) { swapK = 1; leftShown = want; if ((want === 'B' || want === 'F' || want === 'C') && !ARMS[want === 'C' ? 'F' : want]) arm(want === 'C' ? 'F' : want); } }
    else swapK = Math.max(0, swapK - dt * (want === 'F' ? 9 : 5));
    let ltx = 104, lty = 266;
    if (leftShown === 'B') { ltx = 226; lty = 238; }
    if (leftShown === 'F') { const k = drinkT >= 0 ? ease(clamp(drinkT / 0.3, 0, 1)) * (beer && drinkT > 1.0 ? 1 - (drinkT - 1.0) / 0.2 : 1) : 0; ltx = 230 + 70 * k; lty = 340 - 60 * k; }
    if (leftShown === 'C') {
      ltx = 150; lty = 262;
      if (dragT >= 0) { const k = dragT < 0.35 ? ease(dragT / 0.35) : dragT < 1.25 ? 1 : 1 - ease(Math.min(1, (dragT - 1.25) / 0.35)); ltx += (298 - ltx) * k; lty += (362 - lty) * k; }
      else if (PL.blocking) { ltx = 250; lty = 236; }
    }
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
    // 5. arms (+ soaked blood): body, flexing fingers, knuckle whitening, scene rim light
    updateRim(dt);
    const hq = Math.round(handLevel() * 8) + (wetness('handsWet') > 0.45 ? 9 : 0);
    const squeeze = Math.sin(clock * 0.9) > 0.72 ? 1 : 0, flexR = PL.blocking || charging ? 1 : atk ? 0 : squeeze;
    const whiteR = charging ? charge : PL.blocking ? 0.55 : 0, whiteL = PL.blocking ? 0.55 : 0;
    drawArm(ctx, ARMS.R, Rx, Ry, hq, flexR, whiteR, charging ? 0.4 + charge : 0);
    if (leftShown === 'G') {                                   // greatsword: second fist on the grip, below the right one
      const G = ARMS.F; if (G) drawArm(ctx, G, Math.round(Rx - dx * 25 * WSC), Math.round(Ry - dy * 25 * WSC) + Math.round(swapK * swapK * 240), hq, flexR, whiteR, charging ? 0.4 + charge : 0);
      else arm('F');
    } else {
      const LAr = ARMS[leftShown === 'C' ? 'F' : leftShown];
      if (LAr) {
        if (leftShown === 'F' && FLASK.length && drinkT >= 0) { const f = beer && BOTTLE.length ? BOTTLE[clamp(Math.round((drinkT - 0.15) / 0.45 * 4), 0, 4)] : FLASK[clamp(Math.round((drinkT - 0.12) / 0.35 * 4), 0, 4)]; ctx.drawImage(f.cv, Lx - f.o + 10, Ly - f.o - 40); }
        drawArm(ctx, LAr, Lx, Ly, hq, leftShown === 'C' ? 0 : PL.blocking ? 1 : Math.sin(clock * 0.9 + 2) > 0.8 ? 1 : 0, whiteL, 0, leftShown === 'C' && CIG);
      }
    }
    if (hq > 9 && rnd() < dt * (1.5 + handLevel() * 5)) {        // fresh blood drips between the fingers
      const g = (rnd() * 3) | 0, gy = (YK[g] + YK[g + 1]) * 0.5 * HS, left = rnd() < 0.4 && leftShown !== 'G';
      sp(left ? Lx + 7 * HS : Rx - 7 * HS, (left ? Ly : Ry) + gy, (rnd() - 0.5) * 6, 10 + rnd() * 20, 1.1, 1);
    }
    // 5b. cigarette ember, smoke wisps and the exhale cloud
    if (leftShown === 'C' && CIG) drawEmber(ctx, Lx + CIG_BX + CIG_TX, Ly + CIG_BY + CIG_TY, dt);
    drawSmoke(ctx, dt);
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
    }
    // 8. particles
    for (let i = 0; i < NP; i++) {
      if (ql[i] <= 0) continue;
      ql[i] -= dt; const ty = qt[i], f = ql[i] / qm[i];
      if (ty === 0) { qvx[i] *= 1 - dt * 3; qvy[i] = qvy[i] * (1 - dt * 3) + 260 * dt; }
      else if (ty === 1 || ty === 3) qvy[i] += 620 * dt;
      else if (ty === 6) { qvy[i] += 900 * dt; qvx[i] *= 1 - dt; }
      else if (ty === 5) { qvx[i] += Math.sin(clock * 2.3 + i * 1.7) * 22 * dt; qvy[i] *= 1 - dt * 0.25; qx[i] -= turnV * 360 * dt; qy[i] += hspeed * 5 * dt; }
      else { qvx[i] += Math.sin(clock * 4 + i) * 24 * dt; qvy[i] *= 1 - dt * 0.5; }
      qx[i] += qvx[i] * dt; qy[i] += qvy[i] * dt;
      const x = qx[i] | 0, y = qy[i] | 0; if (y > H + 4 || x < -4 || x > W + 4) { ql[i] = 0; continue; }
      if (ty === 0) { ctx.fillStyle = f > 0.6 ? '#ffffff' : f > 0.3 ? '#ffe070' : '#ff8a20'; ctx.fillRect(x, y, 1, 1); ctx.fillRect((qx[i] - qvx[i] * 0.012) | 0, (qy[i] - qvy[i] * 0.012) | 0, 1, 1); }
      else if (ty === 1) { ctx.fillStyle = f > 0.7 ? '#c01a1e' : f > 0.35 ? '#8a0a10' : '#5a0408'; const s = f > 0.5 ? 3 : 2; ctx.fillRect(x, y, s, s); }
      else if (ty === 2) { ctx.fillStyle = f > 0.78 ? '#fff6c8' : f > 0.52 ? '#ffc640' : f > 0.28 ? '#ff7a1c' : '#b82a14'; ctx.fillRect(x, y, 1, f > 0.85 ? 2 : 1); }
      else if (ty === 3) { ctx.fillStyle = f > 0.5 ? '#d8f0ff' : '#7aa8c8'; ctx.fillRect(x, y, 1, 2); }
      else if (ty === 6) { ctx.fillStyle = f > 0.5 ? '#f0c050' : '#a07020'; if ((i + (clock * 24 | 0)) & 1) ctx.fillRect(x, y, 2, 1); else ctx.fillRect(x, y, 1, 2); }
      else if (ty === 5) { ctx.globalAlpha = 0.5 * f; ctx.fillStyle = f > 0.6 ? '#b8b4ae' : '#8a8680'; ctx.fillRect(x, y, 1, f > 0.75 ? 2 : 1); ctx.globalAlpha = 1; }
      else { ctx.fillStyle = f > 0.5 ? '#eef6ff' : '#8ab4ff'; ctx.fillRect(x, y, 1, 1); }
    }
    for (let i = 0; i < FLASHES.length; i++) {
      const fl = FLASHES[i]; if (fl.t <= 0) continue; fl.t -= dt;
      const r = Math.round((fl.big ? 14 : 8) * (0.5 + fl.t * 4));
      star(ctx, fl.x, fl.y, r, fl.red ? '#ff5030' : '#ffe890');
    }
    if (goldT > 0) { goldT -= dt; ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = Math.min(1, goldT) * 0.28; ctx.fillStyle = '#ffb040'; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; }
    if (PL.rifle) drawSmoke(ctx, dt);
    if (parryT > 0.15) { ctx.globalAlpha = (parryT - 0.15) * 1.6; ctx.fillStyle = '#fff8e0'; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; }
    PL.drawMs = PL.drawMs * 0.95 + (performance.now() - t0) * 0.05;
  };

  // Debug snapshot for tests.
  PL.debugState = function () { return { atk, atkK, comboIdx, charging, charge, blockT, dodgeT, drinkT, kind: K && K.id, stamina: PL.stamina, exhausted, blade: bladeLevel(), hands: handLevel(), ms: PL.drawMs, lastSave: lastSave && lastSave.id, offhand: PL.offhand, dragT, dragCD, exhaleT, rushT, crashT, dizzy, rifle: PL.rifle, aiming, adsK, reloadT, mag: arMag(), reserve: arReserve() }; };
  PL.debugBlood = function (b, h) { bloodOv = b; handsOv = h == null ? b : h; };
  // Freeze a pose for screenshots: type 1 light (idx 0..2), 2 heavy, k = normalised swing time; charge/block/drink via opts.
  PL.debugPose = function (type, idx, k, o) {
    o = o || {}; PL.freeze = true; atk = type; comboIdx = idx || 0; atkK = k || 0; swingId++; heavyCharge = 1;
    charging = !!o.charge; charge = o.charge || 0; PL.blocking = !!o.block; drinkT = o.drink != null ? o.drink : -1;
    hurtT = o.hurt || 0; parryT = o.parry || 0; if (o.parry) parryBurst = true; dodgeT = o.dodge != null ? o.dodge : -1; dodgeSide = o.side || 1;
    if (o.torch != null) PL.torchLit = o.torch;
    if (o.ads != null) { aiming = !!o.ads; adsK = o.ads ? 1 : 0; } if (o.reload != null) reloadT = o.reload; if (o.fire) { muzzleT = 0.06; fireK = 1; tracerT = 0.05; tracerX1 = 330; tracerY1 = 170; casingN += 2; }
    if (o.offhand) PL.offhand = o.offhand; dragT = o.drag != null ? o.drag : -1; exhaleT = o.exhale != null ? o.exhale : -1; if (o.exhale != null) exhaleBurst = true;
  };
})();
