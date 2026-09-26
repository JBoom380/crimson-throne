// ─── UI: crisp 1280x720 overlay (gate, title, HUD, menus, dialog, map) ───────
window.CT = window.CT || {};
(function () {
  const W = 1280, H = 720, TAU = Math.PI * 2, HALF = Math.PI / 2;
  const SERIF = "'Palatino Linotype','Book Antiqua',Palatino,Georgia,serif";
  const ITEMS = () => (CT.config && CT.config.ITEMS) || {};
  const rnd = CT.rng ? CT.rng(1337) : Math.random;

  // ── Helpers ────────────────────────────────────────────────────────────────
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const sat = v => clamp(v, 0, 1);
  const lerp = (a, b, k) => a + (b - a) * k;
  const easeOut = x => 1 - Math.pow(1 - sat(x), 3);
  const easeInOut = x => { x = sat(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
  const easeOutBack = x => { x = sat(x); const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
  const wrapA = a => { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; };
  const fade = (age, life, fin, fout) => sat(age / fin) * sat((life - age) / fout);
  function mk(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h)); return c; }
  function font(g, px, o) { g.font = `${o && o.italic ? 'italic ' : ''}${(o && o.weight) || 'bold'} ${Math.round(px)}px ${(o && o.fam) || SERIF}`; }
  const HAS_LS = 'letterSpacing' in CanvasRenderingContext2D.prototype;
  function ls(g, px) { if (HAS_LS) g.letterSpacing = (px || 0) + 'px'; }
  // Shadowed text (hard offset shadow, no per-frame blur).
  function txt(g, s, x, y, px, col, o) {
    o = o || {}; font(g, px, o); ls(g, o.sp || 0);
    g.textAlign = o.align || 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
    if (o.stroke !== false) {
      g.lineWidth = o.lw || Math.max(2, px * 0.16); g.strokeStyle = o.stroke || 'rgba(0,0,0,0.85)';
      g.strokeText(s, x, y + (o.sy != null ? o.sy : px * 0.05));
    }
    g.fillStyle = col; g.fillText(s, x, y);
    if (o.sp) ls(g, 0);
  }
  const wrapCache = new Map();
  function wrap(g, s, maxW, px, o) {
    const k = s + '|' + maxW + '|' + px + '|' + (o && o.italic ? 1 : 0);
    let r = wrapCache.get(k); if (r) return r;
    font(g, px, o); ls(g, 0); r = [];
    String(s).split('\n').forEach(para => {
      let line = '';
      para.split(' ').forEach(w => { const t = line ? line + ' ' + w : w; if (g.measureText(t).width > maxW && line) { r.push(line); line = w; } else line = t; });
      r.push(line);
    });
    if (wrapCache.size > 300) wrapCache.clear();
    wrapCache.set(k, r); return r;
  }
  function cham(g, x, y, w, h, c) {
    g.beginPath(); g.moveTo(x + c, y); g.lineTo(x + w - c, y); g.lineTo(x + w, y + c); g.lineTo(x + w, y + h - c);
    g.lineTo(x + w - c, y + h); g.lineTo(x + c, y + h); g.lineTo(x, y + h - c); g.lineTo(x, y + c); g.closePath();
  }
  function ironGrad(g, y0, y1) {
    const q = g.createLinearGradient(0, y0, 0, y1);
    q.addColorStop(0, '#6a676c'); q.addColorStop(0.07, '#3c3a3e'); q.addColorStop(0.5, '#242225'); q.addColorStop(0.93, '#141214'); q.addColorStop(1, '#040304'); return q;
  }
  function bronzeGrad(g, y0, y1) {
    const q = g.createLinearGradient(0, y0, 0, y1);
    q.addColorStop(0, '#ffe7ae'); q.addColorStop(0.25, '#d99c48'); q.addColorStop(0.55, '#76461a'); q.addColorStop(0.8, '#b8803a'); q.addColorStop(1, '#3a200a'); return q;
  }
  function grain(g, x, y, w, h, n, dark, light) {
    for (let i = 0; i < n; i++) {
      g.fillStyle = rnd() < 0.5 ? `rgba(${light},${rnd() * 0.07})` : `rgba(${dark},${rnd() * 0.3})`;
      g.fillRect(x + rnd() * w, y + rnd() * h, 1 + rnd() * 3, 1 + rnd() * 2);
    }
  }
  function rivet(g, x, y, r) {
    const q = g.createRadialGradient(x - r * 0.35, y - r * 0.4, 0.3, x, y, r);
    q.addColorStop(0, '#fff0c4'); q.addColorStop(0.35, '#b8843c'); q.addColorStop(1, '#2a1606');
    g.beginPath(); g.arc(x, y, r, 0, TAU); g.fillStyle = q; g.fill(); g.lineWidth = 1; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.stroke();
  }
  // Sprite cache
  const cache = {};
  function once(key, fn) { return cache[key] || (cache[key] = fn()); }
  function glowSpr(col) {
    return once('glow' + col, () => {
      const c = mk(128, 128), g = c.getContext('2d'), q = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      q.addColorStop(0, `rgba(${col},1)`); q.addColorStop(0.35, `rgba(${col},0.4)`); q.addColorStop(1, `rgba(${col},0)`);
      g.fillStyle = q; g.fillRect(0, 0, 128, 128); return c;
    });
  }
  // Tints an alpha shape with one colour (used for outlines).
  function tinted(src, col) { const c = mk(src.width, src.height), g = c.getContext('2d'); g.drawImage(src, 0, 0); g.globalCompositeOperation = 'source-in'; g.fillStyle = col; g.fillRect(0, 0, c.width, c.height); return c; }
  function outlined(size, draw, ow) {
    const pad = 4, c0 = mk(size + pad * 2, size + pad * 2), g0 = c0.getContext('2d');
    g0.translate(pad + size / 2, pad + size / 2); draw(g0);
    const c = mk(c0.width, c0.height), g = c.getContext('2d'), dk = tinted(c0, 'rgba(8,4,2,0.95)');
    ow = ow || 1.6;
    for (let i = 0; i < 8; i++) { const a = i * TAU / 8; g.drawImage(dk, Math.cos(a) * ow, Math.sin(a) * ow); }
    g.drawImage(c0, 0, 0); return c;
  }

  // ── Noise + displacement (brush-stroke lettering) ─────────────────────────
  function hash(x, y, s) { let h = (x * 374761393 + y * 668265263 + s * 982451653) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
  function vnoise(x, y, s) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, u = xf * xf * (3 - 2 * xf), w = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
    return a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w;
  }
  function displace(cvs, list, a1, f1, a2, f2, seed) {
    const w = cvs[0].width, h = cvs[0].height, n = w * h, ox = new Int32Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = (vnoise(x * f1, y * f1, seed) - 0.5) * 2 * a1 + (vnoise(x * f2, y * f2 * 0.35, seed + 3) - 0.5) * 2 * a2;
      const dy = (vnoise(x * f1, y * f1, seed + 7) - 0.5) * 2 * a1 + (vnoise(x * f2 * 0.6, y * f2, seed + 9) - 0.5) * 2 * a2;
      const sx = clamp(Math.round(x + dx), 0, w - 1), sy = clamp(Math.round(y + dy), 0, h - 1);
      ox[y * w + x] = sy * w + sx;
    }
    cvs.forEach(cv => {
      const g = cv.getContext('2d', { willReadFrequently: true }), src = g.getImageData(0, 0, w, h), dst = g.createImageData(w, h), s = src.data, d = dst.data;
      for (let i = 0; i < n; i++) { const j = ox[i] * 4, k = i * 4; d[k] = s[j]; d[k + 1] = s[j + 1]; d[k + 2] = s[j + 2]; d[k + 3] = s[j + 3]; }
      g.putImageData(dst, 0, 0);
    });
    void list;
  }

  // ── Display lettering: blood-crimson with a bronze bevel, brushy edges ─────
  // lines: [{s, px, y}] (y = centre). Returns {c, M, w, h, drips:[{x,y,len,w}]}.
  function bloodText(lines, o) {
    const w = o.w, h = o.h, gold = o.scheme === 'gold', RF = { willReadFrequently: true }, c = mk(w, h), g = c.getContext('2d', RF), M = mk(w, h), m = M.getContext('2d', RF);
    lines.forEach(L => { font(m, L.px); ls(m, L.px * 0.05); const tw = m.measureText(L.s).width; if (tw > w - 90) L.px = Math.floor(L.px * (w - 90) / tw); });
    const each = (ctx, fn) => lines.forEach(L => { font(ctx, L.px); ls(ctx, L.px * 0.05); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'miter'; ctx.miterLimit = 3; fn(ctx, L); });
    // heavy soft shadow
    each(g, (q, L) => {
      q.save(); q.shadowColor = 'rgba(0,0,0,1)'; q.shadowBlur = L.px * 0.28; q.shadowOffsetY = L.px * 0.09;
      q.lineWidth = L.px * 0.2; q.strokeStyle = '#000'; q.strokeText(L.s, w / 2, L.y); q.strokeText(L.s, w / 2, L.y); q.restore();
    });
    // black outer + bronze bevel edge + dark seam
    each(g, (q, L) => { q.lineWidth = L.px * 0.19; q.strokeStyle = '#0a0302'; q.strokeText(L.s, w / 2, L.y); });
    each(g, (q, L) => {
      const b = q.createLinearGradient(0, L.y - L.px * 0.45, 0, L.y + L.px * 0.45);
      b.addColorStop(0, '#fff0bc'); b.addColorStop(0.3, '#d89a44'); b.addColorStop(0.55, '#6e3e12'); b.addColorStop(0.75, '#c08638'); b.addColorStop(1, '#40220a');
      q.lineWidth = L.px * 0.12; q.strokeStyle = b; q.strokeText(L.s, w / 2, L.y);
      q.lineWidth = L.px * 0.035; q.strokeStyle = '#1a0603'; q.strokeText(L.s, w / 2, L.y);
    });
    each(m, (q, L) => { q.fillStyle = '#fff'; q.fillText(L.s, w / 2, L.y); });
    // fill layer: gradient + brush streaks, clipped to the letters
    const F = mk(w, h), f = F.getContext('2d');
    lines.forEach(L => {
      const q = f.createLinearGradient(0, L.y - L.px * 0.4, 0, L.y + L.px * 0.42);
      if (gold) { q.addColorStop(0, '#fff6c8'); q.addColorStop(0.3, '#f0bc50'); q.addColorStop(0.62, '#a8621a'); q.addColorStop(1, '#4a2206'); }
      else { q.addColorStop(0, '#ff6a44'); q.addColorStop(0.28, '#dc1a1e'); q.addColorStop(0.62, '#8a0610'); q.addColorStop(1, '#300003'); }
      f.fillStyle = q; f.fillRect(0, L.y - L.px * 0.75, w, L.px * 1.5);
    });
    for (let i = 0; i < 260; i++) {
      const y = rnd() * h, x = rnd() * w, len = 40 + rnd() * 260, lw = 0.8 + rnd() * 3.2, dk = rnd() < 0.6;
      f.strokeStyle = dk ? `rgba(${gold ? '70,30,0' : '40,0,0'},${0.15 + rnd() * 0.3})` : `rgba(${gold ? '255,250,210' : '255,140,100'},${0.07 + rnd() * 0.16})`;
      f.lineWidth = lw; f.beginPath(); f.moveTo(x, y); f.bezierCurveTo(x + len * 0.3, y + rnd() * 6 - 3, x + len * 0.7, y + rnd() * 6 - 3, x + len, y + rnd() * 4 - 2); f.stroke();
    }
    f.globalCompositeOperation = 'destination-in'; f.drawImage(M, 0, 0);
    g.drawImage(F, 0, 0);
    // inner bevel rims (lit from the top-left)
    const rim = (dx, dy, col) => { const r = mk(w, h), q = r.getContext('2d'); q.fillStyle = col; q.fillRect(0, 0, w, h); q.globalCompositeOperation = 'destination-out'; q.drawImage(M, dx, dy); q.globalCompositeOperation = 'destination-in'; q.drawImage(M, 0, 0); return r; };
    const off = Math.max(2, lines[0].px * 0.022);
    g.drawImage(rim(off, off, gold ? 'rgba(255,255,230,0.9)' : 'rgba(255,190,150,0.85)'), 0, 0);
    g.drawImage(rim(-off, -off, 'rgba(20,0,0,0.85)'), 0, 0);
    const px0 = lines[0].px;
    displace([c, M], null, px0 * 0.024, 1 / (px0 * 0.3), px0 * 0.015, 1 / (px0 * 0.04), o.seed || 11);
    // drip anchors: the lowest ink in columns that reach the baseline
    const drips = [];
    if (o.drips) {
      const d = m.getImageData(0, 0, w, h).data;
      lines.forEach(L => {
        const y0 = Math.floor(L.y - L.px * 0.1), y1 = Math.min(h - 1, Math.ceil(L.y + L.px * 0.55)); let cand = [], maxB = 0;
        for (let x = 0; x < w; x += 3) {
          for (let y = y1; y > y0; y--) if (d[(y * w + x) * 4 + 3] > 160) { cand.push({ x, y }); maxB = Math.max(maxB, y); break; }
        }
        cand = cand.filter(p => p.y > maxB - L.px * 0.07);
        const pick = [];
        for (let k = 0; k < 40 && pick.length < o.drips; k++) {
          const p = cand[Math.floor(rnd() * cand.length)]; if (!p) break;
          if (pick.every(q => Math.abs(q.x - p.x) > 55)) pick.push(p);
        }
        pick.forEach(p => drips.push({ x: p.x, y: p.y - 3, len: L.px * (0.08 + rnd() * 0.2), w: L.px * (0.03 + rnd() * 0.025) }));
      });
    }
    return { c, M, w, h, drips };
  }
  function drawDrips(g, T, t, alpha) {
    g.fillStyle = '#6e0208';
    T.drips.forEach((a, i) => {
      const per = 6 + (i * 1.7) % 4, ph = ((t + i * 2.31) / per) % 1, grow = ph < 0.72 ? easeInOut(ph / 0.72) : 1 - (ph - 0.72) / 0.28 * 0.45;
      const L = a.len * (0.3 + 0.7 * grow), r = a.w * 0.6;
      g.globalAlpha = alpha;
      g.beginPath(); g.moveTo(a.x - a.w / 2, a.y);
      g.bezierCurveTo(a.x - a.w * 0.35, a.y + L * 0.5, a.x - r, a.y + L - r, a.x - r, a.y + L);
      g.arc(a.x, a.y + L, r, Math.PI, 0, true);
      g.bezierCurveTo(a.x + r, a.y + L - r, a.x + a.w * 0.35, a.y + L * 0.5, a.x + a.w / 2, a.y);
      g.closePath(); g.fillStyle = '#6a0207'; g.fill();
      g.fillStyle = 'rgba(255,120,100,0.55)'; g.fillRect(a.x - r * 0.5, a.y + L - r * 0.2, Math.max(1, r * 0.45), Math.max(1, r * 0.45));
      if (ph > 0.72) {
        const q = (ph - 0.72) / 0.28, dy = a.y + a.len * 1.05 + q * q * 140;
        g.globalAlpha = alpha * (1 - q); g.beginPath(); g.arc(a.x, dy, r * 0.8, 0, TAU); g.fillStyle = '#6a0207'; g.fill();
      }
    });
    g.globalAlpha = 1;
  }

  // ── Crown of blades (throne silhouette) ────────────────────────────────────
  function blade(g, len, s) {
    const bw = 10 * s, gy = -46 * s, tip = -len;
    g.beginPath(); g.moveTo(-bw, gy); g.lineTo(-bw * 0.85, tip + bw * 4); g.lineTo(0, tip); g.lineTo(bw * 0.85, tip + bw * 4); g.lineTo(bw, gy); g.closePath();
    const q = g.createLinearGradient(-bw, 0, bw, 0);
    q.addColorStop(0, '#060506'); q.addColorStop(0.45, '#2c282b'); q.addColorStop(0.55, '#121012'); q.addColorStop(1, '#030203');
    g.fillStyle = q; g.fill(); g.lineWidth = 2 * s; g.strokeStyle = '#000'; g.stroke();
    g.beginPath(); g.moveTo(bw * 0.9, gy); g.lineTo(bw * 0.76, tip + bw * 4); g.lineTo(0, tip);
    g.strokeStyle = 'rgba(255,70,40,0.6)'; g.lineWidth = 1.5 * s; g.stroke();
    g.beginPath(); g.moveTo(0, gy - 8 * s); g.lineTo(0, tip + bw * 7); g.strokeStyle = 'rgba(0,0,0,0.7)'; g.lineWidth = 2.2 * s; g.stroke();
    cham(g, -bw * 2.8, gy - 5 * s, bw * 5.6, 10 * s, 3 * s); g.fillStyle = bronzeGrad(g, gy - 5 * s, gy + 5 * s); g.fill();
    g.lineWidth = 1.5 * s; g.strokeStyle = '#140802'; g.stroke();
    g.fillStyle = '#1a0d06'; g.fillRect(-bw * 0.45, gy + 5 * s, bw * 0.9, 34 * s);
  }
  function drawThrone(g, cx, cy, s) {
    const q = g.createRadialGradient(cx, cy - 60 * s, 10, cx, cy - 60 * s, 460 * s);
    q.addColorStop(0, 'rgba(210,30,14,0.55)'); q.addColorStop(0.45, 'rgba(120,8,6,0.22)'); q.addColorStop(1, 'rgba(60,0,0,0)');
    g.fillStyle = q; g.fillRect(cx - 480 * s, cy - 520 * s, 960 * s, 960 * s);
    const n = 15;
    for (let i = 0; i < n; i++) {
      const k = i / (n - 1) * 2 - 1, len = (360 + Math.abs(k) * 110 - (i % 2 ? 70 : 0)) * s;
      g.save(); g.translate(cx, cy); g.rotate(k * 1.32); blade(g, len, s); g.restore();
    }
  }

  // ── Frames: forged iron panels, buttons ────────────────────────────────────
  function cornerOrn(g, x, y, sx, sy) {
    g.save(); g.translate(x, y); g.scale(sx, sy);
    g.beginPath(); g.moveTo(-4, -4); g.lineTo(-16, -16); g.lineTo(6, -8); g.lineTo(-8, 6); g.lineTo(-16, -16); g.closePath();
    g.fillStyle = '#1a1416'; g.fill();
    g.beginPath(); g.moveTo(-6, -6); g.lineTo(38, -6); g.lineTo(30, 3); g.lineTo(9, 3); g.lineTo(3, 9); g.lineTo(3, 30); g.lineTo(-6, 38); g.closePath();
    g.fillStyle = bronzeGrad(g, -6, 38); g.fill(); g.lineWidth = 1.5; g.strokeStyle = '#140802'; g.stroke();
    g.beginPath(); g.moveTo(-6, -6); g.lineTo(-19, -19); g.lineTo(-2, -12); g.closePath(); g.moveTo(-6, -6); g.lineTo(-19, -19); g.lineTo(-12, -2); g.closePath();
    g.fillStyle = '#c9934a'; g.fill(); g.stroke();
    rivet(g, 8, 8, 3.2);
    g.restore();
  }
  const FILLS = {
    dark: ['#1a1414', '#070505'], leather: ['#2a1a14', '#0c0706'], blood: ['#4a070c', '#120204'],
    parch: ['#c9b187', '#7a6040'], glass: ['rgba(22,16,16,0.82)', 'rgba(6,4,4,0.9)'],
  };
  function panel(w, h, o) {
    o = o || {};
    return once(`pn${w}x${h}${o.fill || 'dark'}${o.orn === false ? 0 : 1}${o.rim || 12}`, () => {
      const pad = 30, c = mk(w + pad * 2, h + pad * 2), g = c.getContext('2d'); g.translate(pad, pad);
      const cut = o.cut || 16, b = o.rim || 12, fl = FILLS[o.fill || 'dark'];
      g.save(); g.shadowColor = 'rgba(0,0,0,0.9)'; g.shadowBlur = 26; g.shadowOffsetY = 12; cham(g, 0, 0, w, h, cut); g.fillStyle = '#000'; g.fill(); g.restore();
      cham(g, 0, 0, w, h, cut); g.fillStyle = ironGrad(g, 0, h); g.fill();
      g.save(); cham(g, 0, 0, w, h, cut); g.clip(); grain(g, 0, 0, w, h, w * h / 120, '0,0,0', '255,255,255'); g.restore();
      cham(g, 1.5, 1.5, w - 3, h - 3, cut); g.lineWidth = 1.5; g.strokeStyle = 'rgba(255,255,255,0.14)'; g.stroke();
      cham(g, 0.5, 0.5, w - 1, h - 1, cut); g.lineWidth = 1; g.strokeStyle = '#000'; g.stroke();
      const ic = Math.max(4, cut - b * 0.6);
      cham(g, b - 3, b - 3, w - 2 * b + 6, h - 2 * b + 6, ic + 1); g.lineWidth = 3; g.strokeStyle = bronzeGrad(g, 0, h); g.stroke();
      cham(g, b, b, w - 2 * b, h - 2 * b, ic);
      const q = g.createRadialGradient(w / 2, h * 0.4, 10, w / 2, h / 2, Math.max(w, h) * 0.7);
      q.addColorStop(0, fl[0]); q.addColorStop(1, fl[1]); g.fillStyle = q; g.fill();
      g.save(); cham(g, b, b, w - 2 * b, h - 2 * b, ic); g.clip();
      if (o.fill === 'parch') grain(g, b, b, w, h, w * h / 60, '90,60,20', '255,240,200');
      else grain(g, b, b, w, h, w * h / 160, '0,0,0', '255,200,160');
      g.shadowColor = 'rgba(0,0,0,0.95)'; g.shadowBlur = 20; cham(g, b - 12, b - 12, w - 2 * b + 24, h - 2 * b + 24, ic); g.lineWidth = 22; g.strokeStyle = '#000'; g.stroke();
      g.restore();
      const rr = Math.max(2.4, b * 0.26);
      for (let x = cut + 30; x < w - cut - 20; x += 76) { rivet(g, x, b / 2, rr); rivet(g, x, h - b / 2, rr); }
      for (let y = cut + 30; y < h - cut - 20; y += 76) { rivet(g, b / 2, y, rr); rivet(g, w - b / 2, y, rr); }
      if (o.orn !== false) { cornerOrn(g, 0, 0, 1, 1); cornerOrn(g, w, 0, -1, 1); cornerOrn(g, 0, h, 1, -1); cornerOrn(g, w, h, -1, -1); }
      return c;
    });
  }
  const drawPanel = (g, x, y, w, h, o) => g.drawImage(panel(w, h, o), x - 30, y - 30);

  function btnSpr(w, h, hot, dis) {
    return once(`bt${w}x${h}${hot ? 1 : 0}${dis ? 1 : 0}`, () => {
      const pad = 16, c = mk(w + pad * 2, h + pad * 2), g = c.getContext('2d'); g.translate(pad, pad);
      const cut = Math.min(14, h * 0.26);
      g.save(); g.shadowColor = 'rgba(0,0,0,0.85)'; g.shadowBlur = 12; g.shadowOffsetY = 5; cham(g, 0, 0, w, h, cut); g.fillStyle = '#000'; g.fill(); g.restore();
      cham(g, 0, 0, w, h, cut); g.fillStyle = hot ? bronzeGrad(g, 0, h) : ironGrad(g, 0, h); g.fill();
      const q = g.createLinearGradient(0, 4, 0, h - 4);
      if (hot) { q.addColorStop(0, '#9a141a'); q.addColorStop(0.5, '#520609'); q.addColorStop(1, '#1e0103'); }
      else { q.addColorStop(0, '#2c2527'); q.addColorStop(0.5, '#181314'); q.addColorStop(1, '#0a0808'); }
      cham(g, 4, 4, w - 8, h - 8, cut - 2); g.fillStyle = q; g.fill();
      g.save(); g.clip(); grain(g, 0, 0, w, h, w * h / 40, '0,0,0', '255,220,200');
      if (hot) { g.globalCompositeOperation = 'lighter'; g.globalAlpha = 0.5; g.drawImage(glowSpr('255,70,30'), w * 0.1, -h * 0.6, w * 0.8, h * 2.2); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; }
      const gl = g.createLinearGradient(0, 4, 0, h / 2); gl.addColorStop(0, 'rgba(255,255,255,0.10)'); gl.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gl; g.fillRect(0, 0, w, h / 2); g.restore();
      cham(g, 7.5, 7.5, w - 15, h - 15, cut - 4); g.lineWidth = 1; g.strokeStyle = hot ? 'rgba(255,214,150,0.75)' : 'rgba(176,122,50,0.45)'; g.stroke();
      cham(g, 0.5, 0.5, w - 1, h - 1, cut); g.strokeStyle = '#000'; g.stroke();
      if (w > 120) { rivet(g, 14, h / 2, 3.2); rivet(g, w - 14, h / 2, 3.2); }
      if (dis) { cham(g, 0, 0, w, h, cut); g.fillStyle = 'rgba(0,0,0,0.55)'; g.fill(); }
      return c;
    });
  }
  function pointer(g, x, y, dir) {
    g.save(); g.translate(x, y); g.scale(dir, 1);
    g.beginPath(); g.moveTo(0, 0); g.lineTo(-14, -7); g.lineTo(-10, 0); g.lineTo(-14, 7); g.closePath();
    g.fillStyle = '#e8b050'; g.fill(); g.lineWidth = 1.5; g.strokeStyle = '#1a0802'; g.stroke();
    g.fillRect(-26, -1.5, 12, 3); g.restore();
  }
  function drawBtn(g, b, hot, t, o) {
    o = o || {};
    g.drawImage(btnSpr(b.w, b.h, hot, b.dis), b.x - 16, b.y - 16);
    const px = o.px || (b.h >= 60 ? 25 : 21), cy = b.y + b.h / 2;
    txt(g, b.label, b.x + b.w / 2, cy + 1, px, b.dis ? '#7a6a58' : hot ? '#ffe9bc' : '#d9c7a4', { sp: o.sp != null ? o.sp : 3, lw: 4, stroke: '#0a0302' });
    if (hot && !b.dis && !o.noPtr) { const k = Math.sin(t * 3) * 3; pointer(g, b.x - 8 - k, cy, 1); pointer(g, b.x + b.w + 8 + k, cy, -1); }
  }
  const inside = (b, x, y) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;

  // ── Glyph icons: places and items ──────────────────────────────────────────
  function poiGlyph(g, kind, col) {
    g.fillStyle = col; g.strokeStyle = col; g.lineWidth = 2.6; g.lineJoin = 'round'; g.lineCap = 'round';
    const P = pts => { g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath(); g.fill(); };
    const cut = fn => { g.save(); g.globalCompositeOperation = 'destination-out'; fn(); g.restore(); };
    switch (kind) {
      case 'village': P([[-13, 1], [-5, -8], [3, 1], [3, 12], [-13, 12]]); P([[1, -1], [8, -11], [15, -1], [15, 12], [1, 12]]); cut(() => { g.fillRect(-7, 5, 4, 7); g.fillRect(6, 4, 4, 5); }); break;
      case 'lodge': P([[-14, 0], [0, -10], [14, 0], [11, 0], [11, 12], [-11, 12], [-11, 0]]); cut(() => g.fillRect(-3, 4, 6, 8));
        g.beginPath(); g.moveTo(-4, -10); g.lineTo(-9, -16); g.moveTo(-6, -13); g.lineTo(-11, -12); g.moveTo(4, -10); g.lineTo(9, -16); g.moveTo(6, -13); g.lineTo(11, -12); g.stroke(); break;
      case 'camp': P([[-15, 12], [0, -12], [15, 12]]); cut(() => P([[-4, 12], [0, 3], [4, 12]])); g.fillRect(-1, -16, 2, 6); P([[1, -16], [9, -14], [1, -12]]); break;
      case 'ruins': g.fillRect(-13, -2, 6, 14); P([[-3, 12], [-3, -9], [0, -13], [3, -8], [4, -11], [4, 12]]); g.fillRect(8, 3, 6, 9); g.fillRect(-15, 11, 30, 3); break;
      case 'den': g.beginPath(); g.ellipse(0, 6, 7, 6, 0, 0, TAU); g.fill();
        [[-9, -3], [-3, -8], [3, -8], [9, -3]].forEach(([x, y]) => { g.beginPath(); g.ellipse(x, y, 3, 4, 0, 0, TAU); g.fill(); }); break;
      case 'stones': P([[-14, 12], [-13, -4], [-9, -7], [-7, 12]]); P([[-4, 12], [-4, -12], [1, -14], [4, -10], [4, 12]]); P([[7, 12], [8, -3], [12, -5], [14, 12]]); break;
      case 'swamp': g.beginPath(); g.moveTo(0, 8); g.lineTo(-1, -2); g.lineTo(-8, -10); g.moveTo(-1, -2); g.lineTo(5, -9); g.lineTo(9, -13); g.moveTo(5, -9); g.lineTo(9, -6); g.stroke();
        g.lineWidth = 2; g.beginPath(); g.moveTo(-14, 10); g.quadraticCurveTo(-10, 7, -6, 10); g.quadraticCurveTo(-2, 13, 2, 10); g.quadraticCurveTo(6, 7, 10, 10); g.quadraticCurveTo(12, 12, 14, 10); g.stroke(); break;
      case 'pass': P([[-15, 12], [-6, -6], [-1, 2], [5, -12], [15, 12]]); cut(() => { P([[-6, -6], [-9, -1], [-6, 1], [-3, -1]]); P([[5, -12], [1, -4], [5, -2], [9, -4]]); }); break;
      case 'citadel': P([[-14, 13], [-14, -2], [-11, -8], [-8, -2], [-8, 4], [-4, 4], [-4, -8], [0, -17], [4, -8], [4, 4], [8, 4], [8, -2], [11, -8], [14, -2], [14, 13]]); cut(() => { g.beginPath(); g.arc(0, 10, 3.5, Math.PI, 0); g.lineTo(3.5, 13); g.lineTo(-3.5, 13); g.fill(); }); break;
      case 'coast': g.beginPath(); g.arc(0, -10, 3, 0, TAU); g.moveTo(0, -7); g.lineTo(0, 11); g.moveTo(-7, -3); g.lineTo(7, -3); g.moveTo(-11, 3); g.quadraticCurveTo(-8, 12, 0, 11); g.quadraticCurveTo(8, 12, 11, 3); g.stroke(); break;
      case 'quest': g.beginPath(); g.moveTo(0, -14); g.lineTo(11, 0); g.lineTo(0, 14); g.lineTo(-11, 0); g.closePath(); g.fill(); cut(() => { g.beginPath(); g.moveTo(0, -6); g.lineTo(5, 0); g.lineTo(0, 6); g.lineTo(-5, 0); g.closePath(); g.fill(); });
        g.beginPath(); g.moveTo(0, -3); g.lineTo(3, 0); g.lineTo(0, 3); g.lineTo(-3, 0); g.closePath(); g.fill(); break;
      default: font(g, 26); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('?', 0, 1);
    }
  }
  const POI_COL = { quest: '#f0c050', unknown: '#b8a890', citadel: '#ff5a4a' };
  const poiIcon = (kind, size, col) => once(`poi${kind}${size}${col || ''}`, () => outlined(size, g => { g.scale(size / 34, size / 34); poiGlyph(g, kind, col || POI_COL[kind] || '#eadcc0'); }, size < 24 ? 1.3 : 1.8));

  function itemGlyph(g, id) {
    const it = ITEMS()[id] || {}, k = it.kind, st = it.style;
    g.lineJoin = 'round'; g.lineWidth = 2; g.strokeStyle = '#120804';
    const steel = (x0, x1, a, b) => { const q = g.createLinearGradient(x0, 0, x1, 0); q.addColorStop(0, a); q.addColorStop(0.5, '#fff'); q.addColorStop(0.55, b); q.addColorStop(1, '#3a3e48'); return q; };
    if (k === 'weapon') {
      g.rotate(Math.PI / 4);
      if (st === 'axe') {
        g.fillStyle = '#6a3e1c'; g.fillRect(-2.5, -26, 5, 54); g.strokeRect(-2.5, -26, 5, 54);
        g.beginPath(); g.moveTo(2, -24); g.lineTo(14, -30); g.quadraticCurveTo(24, -14, 18, 2); g.lineTo(12, -4); g.lineTo(7, -10); g.lineTo(2, -10); g.closePath();
        g.fillStyle = steel(2, 22, '#8a93a0', '#aab2bc'); g.fill(); g.stroke();
      } else if (st === 'mace') {
        g.fillStyle = '#5a341a'; g.fillRect(-2.5, -14, 5, 42); g.strokeRect(-2.5, -14, 5, 42);
        for (let i = 0; i < 6; i++) { const a = i * TAU / 6; g.beginPath(); g.moveTo(Math.cos(a) * 6, -20 + Math.sin(a) * 6); g.lineTo(Math.cos(a + 0.3) * 15, -20 + Math.sin(a + 0.3) * 15); g.lineTo(Math.cos(a + 0.6) * 6, -20 + Math.sin(a + 0.6) * 6); g.fillStyle = '#9aa0aa'; g.fill(); g.stroke(); }
        g.beginPath(); g.arc(0, -20, 8, 0, TAU); g.fillStyle = '#6a707a'; g.fill(); g.stroke();
      } else {
        const L = { dagger: 30, sword: 42, greatsword: 50, crimson: 48 }[st] || 42, bw = st === 'greatsword' ? 6 : st === 'dagger' ? 4.5 : 5;
        const tip = -30, gy = tip + L;
        const [a, b] = st === 'crimson' ? ['#ff4030', '#7a0008'] : id === 'moonblade' ? ['#cfe6ff', '#8aa8d0'] : id === 'rustsword' ? ['#8a6a50', '#6a4a36'] : ['#a0a8b4', '#bcc4ce'];
        if (st === 'crimson' || id === 'moonblade') { g.save(); g.globalAlpha = 0.6; g.drawImage(glowSpr(st === 'crimson' ? '255,40,20' : '150,200,255'), -18, tip - 8, 36, L + 12); g.restore(); }
        g.beginPath(); g.moveTo(-bw, gy); g.lineTo(-bw, tip + bw * 2); g.lineTo(0, tip); g.lineTo(bw, tip + bw * 2); g.lineTo(bw, gy); g.closePath();
        g.fillStyle = steel(-bw, bw, a, b); g.fill(); g.stroke();
        g.fillStyle = bronzeGrad(g, gy, gy + 5); g.fillRect(-bw - 8, gy, bw * 2 + 16, 5); g.strokeRect(-bw - 8, gy, bw * 2 + 16, 5);
        g.fillStyle = '#4a2a14'; g.fillRect(-2.5, gy + 5, 5, 12); g.strokeRect(-2.5, gy + 5, 5, 12);
        g.beginPath(); g.arc(0, gy + 20, 4, 0, TAU); g.fillStyle = st === 'crimson' ? '#e02020' : '#d8a048'; g.fill(); g.stroke();
      }
    } else if (k === 'armor') {
      const col = id === 'furs' ? ['#9a6a3a', '#4a2a12'] : id === 'mail' ? ['#9aa0a8', '#3a3e44'] : ['#f0c060', '#7a4a10'];
      g.beginPath(); g.moveTo(-18, -18); g.lineTo(-8, -22); g.quadraticCurveTo(0, -14, 8, -22); g.lineTo(18, -18); g.lineTo(22, -4); g.lineTo(15, -2); g.lineTo(14, 20); g.quadraticCurveTo(0, 26, -14, 20); g.lineTo(-15, -2); g.lineTo(-22, -4); g.closePath();
      const q = g.createLinearGradient(0, -22, 0, 24); q.addColorStop(0, col[0]); q.addColorStop(1, col[1]); g.fillStyle = q; g.fill(); g.stroke();
      g.strokeStyle = 'rgba(0,0,0,0.45)'; g.lineWidth = 1.5;
      if (id === 'mail') for (let y = -12; y < 20; y += 4) for (let x = -12; x < 13; x += 4) { g.beginPath(); g.arc(x + (y % 8 ? 2 : 0), y, 1.5, 0, TAU); g.stroke(); }
      else if (id === 'furs') { g.fillStyle = '#c8a070'; for (let i = 0; i < 9; i++) { g.beginPath(); g.moveTo(-18 + i * 4.5, -18); g.lineTo(-16 + i * 4.5, -10); g.lineTo(-14 + i * 4.5, -18); g.fill(); } }
      else { g.beginPath(); g.moveTo(0, -14); g.lineTo(0, 20); g.moveTo(-10, 2); g.quadraticCurveTo(0, 8, 10, 2); g.stroke(); }
    } else if (k === 'charm') {
      g.strokeStyle = '#8a6a3a'; g.lineWidth = 1.6; g.beginPath(); g.moveTo(-14, -24); g.quadraticCurveTo(0, -4, 14, -24); g.stroke();
      g.strokeStyle = '#120804'; g.lineWidth = 2;
      g.beginPath(); g.arc(0, 6, 13, 0, TAU); g.fillStyle = bronzeGrad(g, -7, 19); g.fill(); g.stroke();
      if (id === 'moonblessing') { g.beginPath(); g.arc(0, 6, 9, 0, TAU); g.fillStyle = '#1a2640'; g.fill(); g.beginPath(); g.arc(-2, 6, 7, -1.2, 1.2, true); g.arc(2, 6, 5, 1.1, -1.1); g.fillStyle = '#dbe8ff'; g.fill(); }
      else { g.beginPath(); g.arc(0, 6, 8, 0, TAU); const q = g.createRadialGradient(-3, 3, 1, 0, 6, 8); q.addColorStop(0, '#ffb0a0'); q.addColorStop(0.4, '#d01818'); q.addColorStop(1, '#4a0006'); g.fillStyle = q; g.fill(); g.stroke(); }
    } else if (k === 'potion') {
      const big = id === 'bigpotion', r = big ? 16 : 13, liq = big ? ['#e05a20', '#5a1004'] : ['#ff3030', '#5a0008'];
      g.fillStyle = '#8a6a4a'; g.fillRect(-5, -26, 10, 7); g.strokeRect(-5, -26, 10, 7);
      g.beginPath(); g.moveTo(-5, -19); g.lineTo(-5, 12 - r); g.arc(0, 10, r, -Math.PI / 2 - 0.35, Math.PI * 1.5 + 0.35 - TAU, false); g.lineTo(5, -19); g.closePath();
      g.fillStyle = 'rgba(200,220,230,0.35)'; g.fill(); g.stroke();
      g.save(); g.beginPath(); g.arc(0, 10, r - 2, 0, TAU); g.clip(); const q = g.createLinearGradient(0, 0, 0, 10 + r); q.addColorStop(0, liq[0]); q.addColorStop(1, liq[1]); g.fillStyle = q; g.fillRect(-r, 10 - r * 0.35, r * 2, r * 2); g.restore();
      g.fillStyle = 'rgba(255,255,255,0.6)'; g.fillRect(-r * 0.55, 10 - r * 0.6, 3, 6);
    } else if (k === 'gold') {
      [[6, 10], [-6, 12], [0, 2], [-4, -6]].forEach(([x, y]) => { g.beginPath(); g.ellipse(x, y, 11, 6, 0, 0, TAU); g.fillStyle = bronzeGrad(g, y - 6, y + 6); g.fill(); g.stroke(); });
    } else if (id === 'wraithdust') {
      g.save(); g.globalAlpha = 0.7; g.drawImage(glowSpr('120,220,255'), -24, -30, 48, 40); g.restore();
      g.beginPath(); g.moveTo(-8, -10); g.quadraticCurveTo(-18, 20, 0, 22); g.quadraticCurveTo(18, 20, 8, -10); g.closePath(); g.fillStyle = '#5a4030'; g.fill(); g.stroke();
      g.fillStyle = '#3a2418'; g.fillRect(-9, -13, 18, 5);
    } else if (k === 'loot' || k === 'quest') {
      const col = id === 'alphapelt' ? ['#d8d4cc', '#6a6660'] : ['#a0704a', '#4a2c16'];
      g.beginPath(); g.moveTo(-6, -24); g.lineTo(6, -24); g.lineTo(10, -14); g.lineTo(22, -12); g.lineTo(16, 0); g.lineTo(20, 16); g.lineTo(6, 14); g.lineTo(2, 24); g.lineTo(-2, 24); g.lineTo(-6, 14); g.lineTo(-20, 16); g.lineTo(-16, 0); g.lineTo(-22, -12); g.lineTo(-10, -14); g.closePath();
      const q = g.createRadialGradient(0, 0, 2, 0, 0, 24); q.addColorStop(0, col[0]); q.addColorStop(1, col[1]); g.fillStyle = q; g.fill(); g.stroke();
    } else { font(g, 30); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#c8b898'; g.fillText('?', 0, 2); }
  }
  const itemIcon = (id, size) => once(`it${id}${size}`, () => outlined(size, g => { g.scale(size / 64, size / 64); itemGlyph(g, id); }, 1.2));

  function shieldPath(g, x, y, w, h) {
    g.beginPath(); g.moveTo(x, y + h * 0.06); g.quadraticCurveTo(x + w * 0.5, y - h * 0.03, x + w, y + h * 0.06); g.lineTo(x + w, y + h * 0.46);
    g.bezierCurveTo(x + w, y + h * 0.76, x + w * 0.66, y + h * 0.9, x + w * 0.5, y + h); g.bezierCurveTo(x + w * 0.34, y + h * 0.9, x, y + h * 0.76, x, y + h * 0.46); g.closePath();
  }
  const lvlShield = (w, h) => once(`sh${w}x${h}`, () => {
    const c = mk(w + 12, h + 12), g = c.getContext('2d'); g.translate(6, 6);
    g.save(); g.shadowColor = 'rgba(0,0,0,0.8)'; g.shadowBlur = 8; g.shadowOffsetY = 3; shieldPath(g, 0, 0, w, h); g.fillStyle = '#000'; g.fill(); g.restore();
    shieldPath(g, 0, 0, w, h); g.fillStyle = bronzeGrad(g, 0, h); g.fill();
    const b = Math.max(3, w * 0.08); shieldPath(g, b, b, w - 2 * b, h - 2.2 * b);
    const q = g.createRadialGradient(w * 0.4, h * 0.3, 2, w / 2, h * 0.45, w * 0.8); q.addColorStop(0, '#b3141c'); q.addColorStop(1, '#2a0204'); g.fillStyle = q; g.fill();
    g.save(); g.clip(); grain(g, 0, 0, w, h, w * h / 10, '0,0,0', '255,160,140'); g.restore();
    g.strokeStyle = '#140602'; g.lineWidth = 1.5; g.stroke(); shieldPath(g, 0.75, 0.75, w - 1.5, h - 1.5); g.stroke();
    rivet(g, w * 0.14, h * 0.12, 2.4); rivet(g, w * 0.86, h * 0.12, 2.4);
    return c;
  });

  // ── State + input listeners ────────────────────────────────────────────────
  const S = {
    state: null, stateT: 0, lastT: 0, sel: 0, mx: -1, my: -1, mouse: false, settings: false,
    hpTrail: 1, hpLast: 1, hpDropT: 0, bTrail: 1, bLast: 1, bDropT: 0, hitT: -9, hitKill: false, hurts: [], embers: null,
    tw: { key: '', t0: 0, done: false, n: 0 }, invSel: null, invScroll: 0, dlgSel: 0, savedT: -9,
  };
  const now = () => (CT.core && CT.core.time != null ? CT.core.time : S.lastT);
  if (CT.bus) {
    CT.bus.on('hit', d => { if (d && d.byNpc) return; S.hitT = now(); S.hitKill = !!(d && d.kill); });
    CT.bus.on('kill', d => { if (d && d.byNpc) return; S.hitT = now(); S.hitKill = true; });
    CT.bus.on('playerHurt', d => {
      let wx = 0, wz = 0; const p = CT.player, src = d && d.from && (d.from.pos || d.from.position);
      if (src && p && p.pos) { wx = src.x - p.pos.x; wz = src.z - p.pos.z; }
      else if (d && d.dir) { wx = -d.dir.x; wz = -d.dir.z; } // dir = the travel of the blow; the attacker is behind it
      if (wx || wz) { S.hurts.push({ wx, wz, t: now() }); if (S.hurts.length > 5) S.hurts.shift(); }
    });
  }
  function toUi(e) { const cv = document.getElementById('ui'); if (!cv) return null; const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * W, (e.clientY - r.top) / r.height * H]; }
  window.addEventListener('pointermove', e => { if (e.pointerType === 'touch') return; const p = toUi(e); if (p) { S.mx = p[0]; S.my = p[1]; S.mouse = true; } });
  window.addEventListener('wheel', e => { if (S.state === 'INVENTORY') S.invScroll += e.deltaY * 0.6; }, { passive: true });
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, String(v)); } catch (e) { /* storage blocked */ } },
  };
  const getVol = () => clamp(+LS.get('crimsonThrone.vol', 0.8) || 0, 0, 1);
  const getSens = () => clamp(+LS.get('crimsonThrone.sens', 1) || 1, 0.2, 3);
  const getInv = () => LS.get('crimsonThrone.invertY', '0') === '1';
  // Re-apply the saved volume after the core starts audio (audio init happens on these actions).
  function applyVolSoon() { setTimeout(() => { try { if (CT.audio && CT.audio.setVolume) { const v = getVol(); CT.audio.setVolume(v, v, v); } } catch (e) { /* audio missing */ } }, 60); }

  // ── Layouts (shared by draw and hit) ───────────────────────────────────────
  const GATE_P = { x: 250, y: 118, w: 780, h: 484 };
  function gateBtns() { return [{ label: 'I AM 18 OR OLDER', act: { type: 'gateYes' }, x: 318, y: 500, w: 390, h: 68 }, { label: 'LEAVE', act: { type: 'gateNo' }, x: 734, y: 500, w: 228, h: 68 }]; }
  function titleBtns(v) {
    const L = [{ label: 'NEW GAME', act: { type: 'newGame' } }];
    if (v.saveExists) L.push({ label: 'CONTINUE', act: { type: 'continue' } });
    L.push({ label: 'SETTINGS', act: { type: 'setting', key: 'panel', value: 'open' } });
    const w = 380, h = 64, gap = 12, y0 = 438;
    return L.map((b, i) => Object.assign(b, { x: 640 - w / 2, y: y0 + i * (h + gap), w, h }));
  }
  function pauseBtns() {
    return [['RESUME', { type: 'resume' }], ['SAVE GAME', { type: 'save' }], ['SETTINGS', { type: 'setting', key: 'panel', value: 'open' }], ['QUIT TO TITLE', { type: 'quitTitle' }]]
      .map(([label, act], i) => ({ label, act, x: 480, y: 268 + i * 78, w: 320, h: 64 }));
  }
  const SET_P = { x: 330, y: 130, w: 620, h: 460 };
  function setBtns() {
    return [
      { id: 'volM', row: 0, label: '−', x: 610, y: 222, w: 64, h: 64 }, { id: 'volP', row: 0, label: '+', x: 846, y: 222, w: 64, h: 64 },
      { id: 'senM', row: 1, label: '−', x: 610, y: 312, w: 64, h: 64 }, { id: 'senP', row: 1, label: '+', x: 846, y: 312, w: 64, h: 64 },
      { id: 'inv', row: 2, label: getInv() ? 'INVERTED' : 'NORMAL', x: 610, y: 402, w: 300, h: 64 },
      { id: 'back', row: 3, label: 'BACK', x: 490, y: 488, w: 300, h: 64 },
    ];
  }
  function setAct(id) {
    if (id === 'volM' || id === 'volP') { const v = Math.round(clamp(getVol() + (id === 'volP' ? 0.1 : -0.1), 0, 1) * 10) / 10; LS.set('crimsonThrone.vol', v); return { type: 'setting', key: 'volume', value: v }; }
    if (id === 'senM' || id === 'senP') { const v = Math.round(clamp(getSens() + (id === 'senP' ? 0.1 : -0.1), 0.2, 3) * 10) / 10; LS.set('crimsonThrone.sens', v); return { type: 'setting', key: 'sens', value: v }; }
    if (id === 'inv') { const v = !getInv(); LS.set('crimsonThrone.invertY', v ? '1' : '0'); return { type: 'setting', key: 'invertY', value: v }; }
    S.settings = false; S.sel = 0; return { type: 'setting', key: 'panel', value: 'close' };
  }
  const DEAD_B = { label: 'RISE AGAIN', act: { type: 'respawn' }, x: 460, y: 496, w: 360, h: 72 };
  const VIC_B = { label: 'RETURN TO TITLE', act: { type: 'quitTitle' }, x: 450, y: 616, w: 380, h: 68 };
  const MAP_CLOSE = { label: 'CLOSE', act: { type: 'resume' }, x: 800, y: 604, w: 380, h: 64 };
  // Dialog
  const DLG = { px: 64, py: 92, pw: 384, ph: 480, tx: 488, ty: 92, tw: 736, th: 250 };
  function dlgBtns(d) {
    const ch = (d && Array.isArray(d.choices) && d.choices.length) ? d.choices : [{ text: 'Farewell.', id: null }];
    const n = ch.length, h = n > 4 ? 52 : 64, gap = n > 4 ? 8 : 12;
    return ch.map((c, i) => ({ label: c.text, act: c.id == null ? { type: 'close' } : { type: 'choice', id: c.id }, x: DLG.tx, y: 368 + i * (h + gap), w: DLG.tw, h, n: i + 1 }));
  }
  // Inventory
  const INV = { x: 28, y: 24, w: 1224, h: 672, lx: 424, ly: 104, lw: 440, lh: 548, dx: 896 };
  const INV_CLOSE = { label: 'CLOSE', act: { type: 'resume' }, x: 1082, y: 40, w: 150, h: 60 };
  const GROUPS = [['weapon', 'WEAPONS'], ['armor', 'ARMOUR'], ['charm', 'CHARMS'], ['potion', 'POTIONS'], ['loot', 'SPOILS']];
  // Companion stash tab (npcs/rpg: Selene carries items; stash/unstash act directly on CT.rpg, no core action needed)
  const compOwned = () => !!(CT.rpg && CT.rpg.companion && CT.rpg.companion.owned);
  const compTab = () => S.invTab === 'comp' && compOwned();
  function stashAct(a) {
    if (!a || (a.type !== 'stash' && a.type !== 'unstash') || !CT.rpg) return false;
    if (a.type === 'stash') CT.rpg.stash(a.id, 1); else CT.rpg.unstash(a.id, 1);
    if (CT.audio && CT.audio.sfx) CT.audio.sfx('click');
    return true;
  }
  function invRows(v) {
    const inv = compTab() ? CT.rpg.companion.stash : v.rpg && Array.isArray(v.rpg.inventory) ? v.rpg.inventory : [], rows = [], ids = []; let y = 0;
    GROUPS.forEach(([k, title]) => {
      const items = inv.filter(e => { if (!e || (e.count != null && e.count <= 0)) return false; const it = ITEMS()[e.id]; const kk = !it ? 'loot' : it.kind === 'quest' ? 'loot' : it.kind; return kk === k; });
      if (!items.length) return;
      rows.push({ hdr: title, y, h: 30 }); y += 34;
      items.forEach(e => { rows.push({ id: e.id, count: e.count == null ? 1 : e.count, y, h: 56 }); ids.push(e.id); y += 60; });
    });
    return { rows, ids, total: y };
  }
  const equippedIds = v => { const e = (v.rpg && v.rpg.equipped) || {}; return [e.weapon, e.armor, e.charm]; };
  function invSelected(v, R) {
    if (!R.ids.includes(S.invSel)) S.invSel = R.ids.includes(equippedIds(v)[0]) ? equippedIds(v)[0] : R.ids[0] || null;
    return S.invSel;
  }
  function invAction(v, id) {
    const it = ITEMS()[id]; if (!it || !id) return null;
    if (compTab()) return { label: 'TAKE BACK', act: { type: 'unstash', id } };
    const eq = equippedIds(v).includes(id);
    if (it.kind === 'weapon' || it.kind === 'armor' || it.kind === 'charm') return { label: eq ? 'EQUIPPED' : 'EQUIP', dis: eq, act: { type: 'equip', id } };
    if (it.kind === 'potion') return { label: 'DRINK', act: { type: 'use', id } };
    return null;
  }
  function invBtns(v) {
    const R = invRows(v), id = invSelected(v, R), a = invAction(v, id), out = [INV_CLOSE];
    if (a) out.push(Object.assign(a, { x: INV.dx + 6, y: 598, w: 330, h: 64 }));
    if (compOwned()) {
      out.push({ label: 'PACK', tab: 'pack', on: !compTab(), x: 440, y: 36, w: 196, h: 54 }, { label: 'COMPANION', tab: 'comp', on: compTab(), x: 652, y: 36, w: 196, h: 54 });
      if (!compTab() && id && CT.rpg.canStash && CT.rpg.canStash(id)) out.push({ label: 'GIVE TO SELENE', act: { type: 'stash', id }, x: INV.dx + 6, y: 526, w: 330, h: 60 });
    }
    const over = R.total > INV.lh;
    if (over) { out.push({ label: '▲', scroll: -1, x: INV.lx + INV.lw - 50, y: INV.ly, w: 50, h: 64 }); out.push({ label: '▼', scroll: 1, x: INV.lx + INV.lw - 50, y: INV.ly + INV.lh - 64, w: 50, h: 64 }); }
    return { btns: out, R, over };
  }
  // Which list of buttons the keyboard walks in the current screen.
  function menuBtns(v) {
    if (S.settings) return setBtns();
    switch (v.state) {
      case 'GATE': return gateBtns();
      case 'TITLE': return titleBtns(v);
      case 'PAUSE': return pauseBtns();
      case 'DEAD': return [DEAD_B];
      case 'VICTORY': return [VIC_B];
      case 'MAP': return [MAP_CLOSE];
      default: return [];
    }
  }
  function hoverSel(btns, touch) {
    if (touch || !S.mouse) return;
    const i = btns.findIndex(b => inside(b, S.mx, S.my)); if (i >= 0) S.sel = S.settings ? btns[i].row : i;
  }

  // ── Backdrops ──────────────────────────────────────────────────────────────
  const smoke = () => once('smoke', () => {
    const c = mk(320, 180), g = c.getContext('2d');
    const q = g.createRadialGradient(160, 110, 10, 160, 90, 220); q.addColorStop(0, '#2a0808'); q.addColorStop(0.6, '#120405'); q.addColorStop(1, '#040102'); g.fillStyle = q; g.fillRect(0, 0, 320, 180);
    for (let i = 0; i < 90; i++) { const x = rnd() * 320, y = rnd() * 180, r = 10 + rnd() * 50; const s = g.createRadialGradient(x, y, 0, x, y, r); s.addColorStop(0, `rgba(${rnd() < 0.5 ? '90,20,14' : '0,0,0'},${0.08 + rnd() * 0.12})`); s.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = s; g.fillRect(x - r, y - r, r * 2, r * 2); }
    const b = g.createLinearGradient(0, 120, 0, 180); b.addColorStop(0, 'rgba(160,20,8,0)'); b.addColorStop(1, 'rgba(160,20,8,0.3)'); g.fillStyle = b; g.fillRect(0, 120, 320, 60);
    return c;
  });
  const titleShade = () => once('tshade', () => {
    const c = mk(320, 180), g = c.getContext('2d');
    let q = g.createLinearGradient(0, 0, 0, 180);
    q.addColorStop(0, 'rgba(6,1,2,0.82)'); q.addColorStop(0.35, 'rgba(10,2,3,0.35)'); q.addColorStop(0.6, 'rgba(10,2,3,0.3)'); q.addColorStop(1, 'rgba(4,0,1,0.9)');
    g.fillStyle = q; g.fillRect(0, 0, 320, 180);
    q = g.createRadialGradient(160, 90, 40, 160, 90, 200); q.addColorStop(0, 'rgba(0,0,0,0)'); q.addColorStop(1, 'rgba(0,0,0,0.6)'); g.fillStyle = q; g.fillRect(0, 0, 320, 180);
    return c;
  });
  const vign = (col, a) => once('vg' + col + a, () => {
    const c = mk(320, 180), g = c.getContext('2d'), q = g.createRadialGradient(160, 90, 30, 160, 90, 190);
    q.addColorStop(0, `rgba(${col},${a * 0.45})`); q.addColorStop(1, `rgba(${col},${a})`); g.fillStyle = q; g.fillRect(0, 0, 320, 180); return c;
  });
  const full = (g, c) => { g.imageSmoothingEnabled = true; g.drawImage(c, 0, 0, W, H); };

  // ── Title logo ─────────────────────────────────────────────────────────────
  const LOGO = { w: 1240, h: 470 };
  const logo = () => once('logo', () => {
    const c = mk(LOGO.w, LOGO.h), g = c.getContext('2d');
    const T = bloodText([{ s: 'CRIMSON', px: 150, y: 168 }, { s: 'THRONE', px: 162, y: 318 }], { w: LOGO.w, h: LOGO.h, drips: 4, seed: 5 });
    g.drawImage(T.c, 0, 0);
    // subtitle with flourishes
    const sy = 432;
    font(g, 30); ls(g, 12); g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 6; g.strokeStyle = '#0a0302'; g.strokeText('THE CURSE OF VAEL', LOGO.w / 2, sy + 1);
    g.fillStyle = bronzeGrad(g, sy - 14, sy + 14); g.fillText('THE CURSE OF VAEL', LOGO.w / 2, sy);
    const tw = g.measureText('THE CURSE OF VAEL').width; ls(g, 0);
    [-1, 1].forEach(s => {
      const x0 = LOGO.w / 2 + s * (tw / 2 + 22), x1 = LOGO.w / 2 + s * (tw / 2 + 210);
      const q = g.createLinearGradient(x0, 0, x1, 0); q.addColorStop(0, 'rgba(230,170,80,1)'); q.addColorStop(1, 'rgba(230,170,80,0)');
      g.fillStyle = '#0a0302'; g.fillRect(Math.min(x0, x1), sy - 2.5, Math.abs(x1 - x0), 5);
      g.fillStyle = q; g.fillRect(Math.min(x0, x1), sy - 1, Math.abs(x1 - x0), 2);
      g.save(); g.translate(x0, sy); g.rotate(Math.PI / 4); g.fillStyle = '#e0a850'; g.strokeStyle = '#0a0302'; g.lineWidth = 2; g.fillRect(-5, -5, 10, 10); g.strokeRect(-5, -5, 10, 10); g.restore();
    });
    return { c, M: T.M, drips: T.drips };
  });
  const throneSpr = () => once('throne', () => { const c = mk(W, 560), g = c.getContext('2d'); drawThrone(g, W / 2, 330, 1); return c; });
  const shineCv = mk(LOGO.w / 2, LOGO.h / 2);
  function drawLogo(g, t, cx, top, k, alpha, shine) {
    const L = logo();
    g.save(); g.globalAlpha = alpha; g.setTransform(k, 0, 0, k, cx - LOGO.w * k / 2, top);
    g.drawImage(L.c, 0, 0);
    drawDrips(g, L, t, alpha);
    if (shine) {
      const cyc = (t % 7) / 1.6;
      if (cyc < 1) {
        const s = shineCv.getContext('2d'), hw = LOGO.w / 2, hh = LOGO.h / 2, x = -120 + cyc * (hw + 240);
        s.globalCompositeOperation = 'source-over'; s.clearRect(0, 0, hw, hh);
        const q = s.createLinearGradient(x - 60, 0, x + 60, hh * 0.5);
        q.addColorStop(0, 'rgba(255,220,180,0)'); q.addColorStop(0.5, 'rgba(255,230,200,0.85)'); q.addColorStop(1, 'rgba(255,220,180,0)');
        s.fillStyle = q; s.fillRect(Math.max(0, x - 140), 0, 280, hh);
        s.globalCompositeOperation = 'destination-in'; s.drawImage(L.M, 0, 0, hw, hh);
        g.globalCompositeOperation = 'lighter'; g.globalAlpha = alpha * 0.55 * Math.sin(cyc * Math.PI); g.drawImage(shineCv, 0, 0, LOGO.w, LOGO.h);
        g.globalCompositeOperation = 'source-over';
      }
    }
    g.restore();
  }
  function embers(g, t, dt, n, alpha) {
    if (!S.embers) S.embers = Array.from({ length: 48 }, () => ({ x: rnd() * W, y: rnd() * H, v: 18 + rnd() * 40, ph: rnd() * TAU, s: 2 + rnd() * 5 }));
    g.globalCompositeOperation = 'lighter';
    const spr = glowSpr('255,110,40');
    for (let i = 0; i < Math.min(n, S.embers.length); i++) {
      const e = S.embers[i]; e.y -= e.v * dt; e.x += Math.sin(t * 0.7 + e.ph) * 12 * dt;
      if (e.y < -10) { e.y = H + 10; e.x = rnd() * W; }
      g.globalAlpha = alpha * (0.35 + 0.35 * Math.sin(t * 1.3 + e.ph)) * sat(e.y / 200);
      g.drawImage(spr, e.x - e.s * 2, e.y - e.s * 2, e.s * 4, e.s * 4);
    }
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  }

  // ── GATE ───────────────────────────────────────────────────────────────────
  function drawGate(g, t, v, dt) {
    const a = t - S.stateT;
    g.globalAlpha = 0.93; full(g, smoke()); g.globalAlpha = 1;
    embers(g, t, dt, 24, 0.8);
    const P = GATE_P, k = easeOut(a / 0.8);
    g.globalAlpha = k;
    drawPanel(g, P.x, P.y, P.w, P.h, { fill: 'blood', rim: 14 });
    drawLogo(g, t, 640, P.y + 16, 0.4, k, true);
    // wax seal
    const sx = P.x + P.w - 18, sy = P.y + 18;
    g.drawImage(once('seal', () => {
      const c = mk(96, 96), q = c.getContext('2d'); q.translate(48, 48);
      q.beginPath(); for (let i = 0; i < 24; i++) { const r = i % 2 ? 36 : 40, an = i * TAU / 24; q.lineTo(Math.cos(an) * r, Math.sin(an) * r); } q.closePath();
      const gr = q.createRadialGradient(-10, -12, 4, 0, 0, 40); gr.addColorStop(0, '#d8262a'); gr.addColorStop(1, '#4a0206'); q.fillStyle = gr; q.fill(); q.lineWidth = 2; q.strokeStyle = '#1a0002'; q.stroke();
      q.beginPath(); q.arc(0, 0, 28, 0, TAU); q.strokeStyle = 'rgba(255,160,140,0.35)'; q.stroke();
      txt(q, '18+', 0, 1, 28, '#ffd8c8', { lw: 4, stroke: '#300004' }); return c;
    }), sx - 48, sy - 48);
    const ly = P.y + 214;
    g.fillStyle = bronzeGrad(g, ly - 1, ly + 2); g.fillRect(P.x + 120, ly, P.w - 240, 2);
    txt(g, 'This game contains extreme violence and gore.', 640, ly + 52, 27, '#f0dcc0', { weight: 'normal', lw: 4 });
    txt(g, 'Enter only if you are 18 or older.', 640, ly + 94, 27, '#f0dcc0', { weight: 'normal', lw: 4 });
    txt(g, 'MATURE CONTENT', 640, ly + 138, 15, '#c07050', { sp: 6, lw: 3 });
    const B = gateBtns(); hoverSel(B, v.isTouch); S.sel = clamp(S.sel, 0, B.length - 1);
    B.forEach((b, i) => drawBtn(g, b, i === S.sel, t));
    g.globalAlpha = 1;
  }

  // ── TITLE ──────────────────────────────────────────────────────────────────
  function drawTitle(g, t, v, dt) {
    const a = t - S.stateT;
    full(g, titleShade());
    g.globalAlpha = 0.5; full(g, vign('60,0,0', 0.5)); g.globalAlpha = 1;
    embers(g, t, dt, 48, 1);
    const k = 0.86 + 0.04 * easeOut(a / 2), al = easeOut(a / 1.4) * (S.settings ? 0.25 : 1);
    g.globalAlpha = al * (0.85 + 0.15 * Math.sin(t * 0.8)); g.drawImage(throneSpr(), 0, -6 + (1 - easeOut(a / 2)) * 40); g.globalAlpha = 1;
    drawLogo(g, t, 640, 4 + (1 - easeOut(a / 1.4)) * 20, k, al, true);
    if (S.settings) { drawSettings(g, t, v); return; }
    const ma = easeOut((a - 0.7) / 0.8);
    g.globalAlpha = ma;
    const B = titleBtns(v); hoverSel(B, v.isTouch); S.sel = clamp(S.sel, 0, B.length - 1);
    B.forEach((b, i) => drawBtn(g, b, i === S.sel, t));
    txt(g, '18+', 36, 694, 18, '#c8302a', { sp: 2, lw: 3, align: 'left' });
    g.strokeStyle = '#c8302a'; g.lineWidth = 2; g.strokeRect(26, 680, 50, 28);
    txt(g, 'A GAME BY JOHN SLAGBOOM', 640, 700, 13, 'rgba(200,170,130,0.7)', { sp: 5, lw: 3 });
    txt(g, 'v1.0', 1252, 694, 16, 'rgba(200,170,130,0.7)', { align: 'right', lw: 3 });
    g.globalAlpha = 1;
  }

  // ── SETTINGS (overlay on TITLE and PAUSE) ──────────────────────────────────
  function drawSettings(g, t, v) {
    const P = SET_P;
    g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(0, 0, W, H);
    drawPanel(g, P.x, P.y, P.w, P.h, { fill: 'leather', rim: 14 });
    txt(g, 'SETTINGS', 640, P.y + 52, 34, '#e8c078', { sp: 8, lw: 5 });
    g.fillStyle = bronzeGrad(g, 0, 2); g.fillRect(P.x + 80, P.y + 80, P.w - 160, 2);
    const B = setBtns(); hoverSel(B, v.isTouch); S.sel = clamp(S.sel, 0, 3);
    const rows = [['VOLUME', 254], ['SENSITIVITY', 344], ['INVERT LOOK', 434]];
    rows.forEach(([l, y], i) => txt(g, l, 380, y, 19, i === S.sel ? '#ffe0b0' : '#b8a488', { align: 'left', sp: 2, lw: 3 }));
    // volume bar
    const vx = 690, vw = 144, vol = getVol();
    g.fillStyle = '#0a0506'; g.fillRect(vx, 246, vw, 16); g.strokeStyle = '#6a4a20'; g.strokeRect(vx - 0.5, 245.5, vw + 1, 17);
    const q = g.createLinearGradient(0, 246, 0, 262); q.addColorStop(0, '#ff5040'); q.addColorStop(1, '#6a0408'); g.fillStyle = q; g.fillRect(vx + 2, 248, (vw - 4) * vol, 12);
    txt(g, Math.round(vol * 100) + '%', vx + vw / 2, 276, 14, '#d8c8a8', { lw: 3 });
    txt(g, getSens().toFixed(1) + '×', 760, 344, 28, '#f0dcc0', { lw: 4 });
    B.forEach(b => drawBtn(g, b, b.row === S.sel && (b.id === 'inv' || b.id === 'back'), t, { px: b.w < 100 ? 30 : 22, noPtr: b.w < 100 }));
    B.filter(b => b.w < 100 && b.row === S.sel).forEach(b => { cham(g, b.x - 2, b.y - 2, b.w + 4, b.h + 4, 14); g.strokeStyle = 'rgba(255,200,120,0.8)'; g.lineWidth = 2; g.stroke(); });
    if (!v.isTouch) txt(g, 'ARROWS  ADJUST     ESC  BACK', 640, P.y + P.h - 30, 12, '#8a7a60', { sp: 3, lw: 2 });
  }

  // ── HUD ────────────────────────────────────────────────────────────────────
  const BAR = { x: 104, w: 316, hp: [20, 24], st: [54, 14], xp: [78, 6] };
  const hudFrame = () => once('hudf', () => {
    const w = 440, h = 100, pad = 20, c = mk(w + pad * 2, h + pad * 2), g = c.getContext('2d'); g.translate(pad, pad);
    g.save(); g.shadowColor = 'rgba(0,0,0,0.8)'; g.shadowBlur = 14; g.shadowOffsetY = 4;
    g.beginPath(); g.moveTo(44, 4); g.lineTo(w - 14, 4); g.lineTo(w, 20); g.lineTo(w - 6, 50); g.lineTo(w, 80); g.lineTo(w - 14, 96); g.lineTo(44, 96); g.closePath();
    g.fillStyle = 'rgba(0,0,0,0.9)'; g.fill(); g.restore();
    g.beginPath(); g.moveTo(44, 4); g.lineTo(w - 14, 4); g.lineTo(w, 20); g.lineTo(w - 6, 50); g.lineTo(w, 80); g.lineTo(w - 14, 96); g.lineTo(44, 96); g.closePath();
    const q = g.createLinearGradient(0, 4, 0, 96); q.addColorStop(0, 'rgba(58,54,58,0.92)'); q.addColorStop(0.5, 'rgba(26,22,24,0.9)'); q.addColorStop(1, 'rgba(10,8,9,0.92)');
    g.fillStyle = q; g.fill(); g.lineWidth = 2; g.strokeStyle = bronzeGrad(g, 4, 96); g.stroke();
    g.save(); g.clip(); grain(g, 40, 0, w, h, 900, '0,0,0', '255,255,255'); g.restore();
    const well = (y, hh) => { g.fillStyle = '#070304'; g.fillRect(BAR.x - 3, y - 3, BAR.w + 6, hh + 6); g.strokeStyle = 'rgba(200,150,80,0.55)'; g.lineWidth = 1; g.strokeRect(BAR.x - 3.5, y - 3.5, BAR.w + 7, hh + 7); g.fillStyle = '#140809'; g.fillRect(BAR.x, y, BAR.w, hh); };
    well(BAR.hp[0], BAR.hp[1]); well(BAR.st[0], BAR.st[1]); well(BAR.xp[0], BAR.xp[1]);
    [[60, 10], [60, 90], [w - 20, 12], [w - 20, 88]].forEach(([x, y]) => rivet(g, x, y, 2.6));
    // spiked end cap
    g.beginPath(); g.moveTo(w - 6, 50); g.lineTo(w + 14, 44); g.lineTo(w + 18, 50); g.lineTo(w + 14, 56); g.closePath(); g.fillStyle = bronzeGrad(g, 44, 56); g.fill(); g.strokeStyle = '#140802'; g.stroke();
    return c;
  });
  const barSpr = (key, w, h, stops, gloss) => once('bar' + key, () => {
    const c = mk(w, h), g = c.getContext('2d'), q = g.createLinearGradient(0, 0, 0, h);
    stops.forEach(([o, col]) => q.addColorStop(o, col)); g.fillStyle = q; g.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 3) { g.fillStyle = `rgba(0,0,0,${0.06 + rnd() * 0.1})`; g.fillRect(x, 0, 1, h); }
    if (gloss) { g.fillStyle = 'rgba(255,255,255,0.22)'; g.fillRect(0, 1, w, Math.max(1, h * 0.18)); }
    return c;
  });
  const HP_SPR = () => barSpr('hp', BAR.w, BAR.hp[1], [[0, '#ff5a48'], [0.35, '#c4121a'], [0.75, '#6a040a'], [1, '#3a0004']], true);
  const HPT_SPR = () => barSpr('hpt', BAR.w, BAR.hp[1], [[0, '#8a3a2a'], [1, '#3a0a06']], false);
  const ST_SPR = () => barSpr('st', BAR.w, BAR.st[1], [[0, '#fff0a0'], [0.4, '#e0a830'], [1, '#6a3c06']], true);
  const XP_SPR = () => barSpr('xp', BAR.w, BAR.xp[1], [[0, '#f0e0c0'], [1, '#9a7a4a']], false);
  function drawBars(g, t, v, dt) {
    const touch = v.isTouch, ox = 0, oy = 0;
    g.save(); if (touch) { g.translate(12, 10); g.scale(0.8, 0.8); } else g.translate(16, 604);
    const pl = v.player || {}, hpMax = Math.max(1, pl.hpMax || 100), f = sat((pl.hp || 0) / hpMax);
    if (f < S.hpLast - 0.001) S.hpDropT = t;
    if (f >= S.hpTrail) S.hpTrail = f; else if (t - S.hpDropT > 0.5) S.hpTrail = Math.max(f, S.hpTrail - dt * 0.45);
    S.hpLast = f;
    const low = f < 0.3 && f > 0;
    if (low) { g.globalCompositeOperation = 'lighter'; g.globalAlpha = 0.3 + 0.25 * Math.sin(t * 5); g.drawImage(glowSpr('255,20,10'), ox + 60, oy - 40, 420, 180); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; }
    g.drawImage(hudFrame(), ox - 20, oy - 20);
    const bx = ox + BAR.x;
    const hy = oy + BAR.hp[0], hh = BAR.hp[1];
    if (S.hpTrail > f) g.drawImage(HPT_SPR(), 0, 0, Math.max(1, BAR.w * S.hpTrail), hh, bx, hy, BAR.w * S.hpTrail, hh);
    if (f > 0) g.drawImage(HP_SPR(), 0, 0, Math.max(1, BAR.w * f), hh, bx, hy, BAR.w * f, hh);
    if (low) { g.globalAlpha = 0.25 + 0.2 * Math.sin(t * 5); g.fillStyle = '#ff8070'; g.fillRect(bx, hy, BAR.w * f, hh); g.globalAlpha = 1; }
    if (f > 0) { g.fillStyle = 'rgba(255,220,200,0.8)'; g.fillRect(bx + BAR.w * f - 1, hy, 2, hh); }
    txt(g, `${Math.ceil(pl.hp || 0)} / ${Math.round(hpMax)}`, bx + BAR.w - 8, hy + hh / 2 + 1, 14, '#f4e0d0', { align: 'right', lw: 3 });
    const sf = sat((pl.stamina || 0) / Math.max(1, pl.staminaMax || 100));
    if (sf > 0) g.drawImage(ST_SPR(), 0, 0, Math.max(1, BAR.w * sf), BAR.st[1], bx, oy + BAR.st[0], BAR.w * sf, BAR.st[1]);
    const st = (v.rpg && v.rpg.stats) || {}, xf = sat((st.xp || 0) / Math.max(1, st.xpNext || 100));
    if (xf > 0) g.drawImage(XP_SPR(), 0, 0, Math.max(1, BAR.w * xf), BAR.xp[1], bx, oy + BAR.xp[0], BAR.w * xf, BAR.xp[1]);
    g.drawImage(lvlShield(76, 90), ox - 6 + 6, oy + 4);
    txt(g, 'LV', ox + 44, oy + 30, 12, '#e8c078', { sp: 2, lw: 3 });
    txt(g, String(st.level || 1), ox + 44, oy + 56, 32, '#fff0d0', { lw: 5 });
    // ── AR-15 ammo counter (player.js exposes CT.player.ammo while the rifle is out) ──
    const am = CT.player && CT.player.rifle && CT.player.ammo;
    if (am) txt(g, am.mag + ' / ' + am.reserve, bx + BAR.w - 8, touch ? oy + 118 : oy - 14, 24, am.mag > 0 ? '#f4e0c0' : '#ff5040', { align: 'right', lw: 4 });
    g.restore();
  }

  const CP = { x: 640, y: 34, w: 600 };
  const compassSpr = () => once('comp', () => {
    const c = mk(680, 64), g = c.getContext('2d'), cx = 340, y0 = 18, y1 = 50;
    const m = g.createLinearGradient(20, 0, 660, 0); m.addColorStop(0, 'rgba(0,0,0,0)'); m.addColorStop(0.15, 'rgba(0,0,0,1)'); m.addColorStop(0.85, 'rgba(0,0,0,1)'); m.addColorStop(1, 'rgba(0,0,0,0)');
    const q = g.createLinearGradient(0, y0, 0, y1); q.addColorStop(0, 'rgba(40,30,30,0.78)'); q.addColorStop(1, 'rgba(8,4,5,0.85)'); g.fillStyle = q; g.fillRect(20, y0, 640, y1 - y0);
    g.fillStyle = bronzeGrad(g, y0 - 1, y0 + 2); g.fillRect(20, y0 - 1, 640, 2); g.fillRect(20, y1 - 1, 640, 2);
    g.globalCompositeOperation = 'destination-in'; g.fillStyle = m; g.fillRect(0, 0, 680, 64); g.globalCompositeOperation = 'source-over';
    // centre notch
    g.beginPath(); g.moveTo(cx - 9, 6); g.lineTo(cx + 9, 6); g.lineTo(cx, 19); g.closePath(); g.fillStyle = bronzeGrad(g, 6, 19); g.fill(); g.strokeStyle = '#140802'; g.lineWidth = 1.5; g.stroke();
    [-1, 1].forEach(s => { g.beginPath(); g.moveTo(cx + s * 12, 10); g.lineTo(cx + s * 26, 12); g.lineTo(cx + s * 12, 14); g.closePath(); g.fill(); g.stroke(); });
    return c;
  });
  function drawCompass(g, t, v) {
    const cmp = v.compass || {}, yaw = cmp.yaw || 0, sc = (CP.w / 2) / HALF, cy = CP.y;
    g.drawImage(compassSpr(), CP.x - 340, cy - 34);
    const fa = d => 1 - sat((Math.abs(d) / HALF - 0.72) / 0.28);
    g.fillStyle = '#d8c09a';
    for (let k = 0; k < 24; k++) {
      const d = wrapA(k * Math.PI / 12 + yaw); if (Math.abs(d) > HALF) continue;
      const x = CP.x + d * sc, al = fa(d); g.globalAlpha = al;
      if (k % 6 === 0) txt(g, 'NESW'[k / 6], x, cy + 1, k === 0 ? 22 : 19, k === 0 ? '#ff5a44' : '#f0dcc0', { lw: 4 });
      else if (k % 3 === 0) { g.save(); g.translate(x, cy); g.rotate(Math.PI / 4); g.fillStyle = '#c8a060'; g.fillRect(-3, -3, 6, 6); g.restore(); }
      else { g.fillStyle = '#a89070'; g.fillRect(x - 1, cy + 5, 2, 7); g.fillRect(x - 1, cy - 12, 2, 5); }
    }
    g.globalAlpha = 1;
    const mk_ = (cmp.markers || []).slice().sort((a, b) => (a.kind === 'quest') - (b.kind === 'quest'));
    let facing = null;
    mk_.forEach(m => {
      if (m.angle == null) return;
      const q = m.kind === 'quest', ad = Math.abs(m.angle);
      if (ad > HALF && !q) return;
      const d = clamp(m.angle, -HALF * 0.97, HALF * 0.97), x = CP.x + d * sc;
      g.globalAlpha = q ? 1 : fa(d);
      const icon = poiIcon(q ? 'quest' : (m.kind || 'unknown'), q ? 26 : 22);
      g.drawImage(icon, x - icon.width / 2, cy - icon.height / 2);
      if (q) {
        if (ad > HALF) { const s = Math.sign(m.angle); pointer(g, x + s * 22, cy, -s); }
        txt(g, `${Math.round(m.dist || 0)} m`, x, cy + 30, 13, '#f0c050', { lw: 3 });
      }
      if (ad < 0.07 && m.name && m.name !== '?' && !q) facing = m;
    });
    g.globalAlpha = 1;
    if (facing) txt(g, facing.name.toUpperCase(), CP.x, cy + 30, 12, '#e8dcc0', { sp: 3, lw: 3 });
  }
  function drawQuest(g, t, v) {
    const q = v.rpg && v.rpg.active; if (!q || !q.title) return;
    const x = 1256, w = 330, lines = wrap(g, q.text || '', w - 34, 16, { italic: true, weight: 'normal' }).slice(0, 3), h = 46 + lines.length * 21;
    const x0 = x - w, y0 = 16;
    const gr = g.createLinearGradient(x0, 0, x, 0); gr.addColorStop(0, 'rgba(10,6,6,0)'); gr.addColorStop(0.25, 'rgba(10,6,6,0.72)'); gr.addColorStop(1, 'rgba(10,6,6,0.82)');
    g.fillStyle = gr; g.fillRect(x0, y0, w, h);
    g.fillStyle = bronzeGrad(g, 0, 2); g.fillRect(x0 + 60, y0, w - 60, 2); g.fillRect(x0 + 60, y0 + h - 2, w - 60, 2);
    g.save(); g.translate(x0 + 34, y0 + 22); g.rotate(Math.PI / 4); g.fillStyle = '#f0c050'; g.fillRect(-5, -5, 10, 10); g.strokeStyle = '#140802'; g.lineWidth = 2; g.strokeRect(-5, -5, 10, 10); g.restore();
    txt(g, q.title.toUpperCase(), x - 14, y0 + 22, 16, '#f0c878', { align: 'right', sp: 2, lw: 3 });
    lines.forEach((l, i) => txt(g, l, x - 14, y0 + 46 + i * 21, 16, '#e0d0b0', { align: 'right', italic: true, weight: 'normal', lw: 3 }));
  }
  function drawPrompt(g, t, v) {
    if (!v.prompt) return;
    const m = /^(\S{1,5})\s{2,}(.+)$/.exec(v.prompt);
    let key = m ? m[1] : null; const text = m ? m[2] : v.prompt;
    if (key && v.isTouch && key.length === 1) key = 'USE';
    font(g, 22); ls(g, 1); const tw = g.measureText(text).width; ls(g, 0);
    font(g, 18); const kw = key ? Math.max(36, g.measureText(key).width + 18) : 0;
    const tot = kw + (key ? 14 : 0) + tw, x0 = 640 - tot / 2, y = 476;
    const gr = g.createLinearGradient(x0 - 80, 0, x0 + tot + 80, 0); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.2, 'rgba(0,0,0,0.65)'); gr.addColorStop(0.8, 'rgba(0,0,0,0.65)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(x0 - 80, y - 26, tot + 160, 52);
    if (key) {
      cham(g, x0, y - 18, kw, 36, 6); g.fillStyle = bronzeGrad(g, y - 18, y + 18); g.fill(); g.strokeStyle = '#140802'; g.lineWidth = 2; g.stroke();
      cham(g, x0 + 3, y - 15, kw - 6, 28, 4); g.fillStyle = '#231a16'; g.fill();
      txt(g, key, x0 + kw / 2, y, 18, '#ffe6b0', { lw: 3 });
    }
    txt(g, text, x0 + kw + (key ? 14 : 0), y + 1, 22, '#f2e4c8', { align: 'left', sp: 1, lw: 4 });
  }
  function drawCross(g, t) {
    const a = t - S.hitT, k = a < 0.28 ? 1 - a / 0.28 : 0, kill = S.hitKill && k > 0;
    const r0 = 5 + k * (kill ? 9 : 5), col = kill ? '#ff3a2a' : k > 0 ? '#fff4e0' : 'rgba(240,225,200,0.75)';
    g.fillStyle = 'rgba(0,0,0,0.7)'; g.fillRect(638, 358, 4, 4); g.fillStyle = col; g.fillRect(639, 359, 2, 2);
    if (k > 0) {
      g.save(); g.translate(640, 360); g.rotate(Math.PI / 4); g.globalAlpha = 0.4 + 0.6 * k;
      for (let i = 0; i < 4; i++) { g.rotate(HALF); g.fillStyle = 'rgba(0,0,0,0.7)'; g.fillRect(r0 - 1, -2, 9 + k * 4, 4); g.fillStyle = col; g.fillRect(r0, -1, 7 + k * 4, 2); }
      g.restore(); g.globalAlpha = 1;
    }
  }
  function drawHurt(g, t, v) {
    const yaw = (v.compass && v.compass.yaw) || 0;
    S.hurts = S.hurts.filter(h => t - h.t < 0.6 && t >= h.t);
    S.hurts.forEach(h => {
      const k = 1 - (t - h.t) / 0.6, rel = wrapA(Math.atan2(h.wx, -h.wz) + yaw), th = rel - HALF;
      g.lineCap = 'round';
      g.globalAlpha = 0.55 * k; g.strokeStyle = '#8a0006'; g.lineWidth = 34;
      g.beginPath(); g.ellipse(640, 360, 560, 290, 0, th - 0.32, th + 0.32); g.stroke();
      g.globalAlpha = 0.9 * k; g.strokeStyle = '#ff2a1a'; g.lineWidth = 8;
      g.beginPath(); g.ellipse(640, 360, 548, 280, 0, th - 0.22, th + 0.22); g.stroke();
      g.lineCap = 'butt';
    });
    g.globalAlpha = 1;
  }
  const BW = 560;
  const bossFrame = () => once('bossf', () => {
    const w = BW, c = mk(w + 80, 60), g = c.getContext('2d'), x0 = 40, y = 22, h = 18;
    g.fillStyle = 'rgba(0,0,0,0.75)'; g.fillRect(x0 - 4, y - 5, w + 8, h + 10);
    g.fillStyle = '#12080a'; g.fillRect(x0, y, w, h);
    g.strokeStyle = bronzeGrad(g, y - 4, y + h + 4); g.lineWidth = 2; g.strokeRect(x0 - 3, y - 4, w + 6, h + 8);
    [-1, 1].forEach(s => {
      g.save(); g.translate(s < 0 ? x0 - 4 : x0 + w + 4, y + h / 2); g.scale(s, 1);
      g.beginPath(); g.moveTo(0, -16); g.lineTo(18, -6); g.lineTo(34, -14); g.lineTo(26, 0); g.lineTo(34, 14); g.lineTo(18, 6); g.lineTo(0, 16); g.closePath();
      g.fillStyle = bronzeGrad(g, -16, 16); g.fill(); g.strokeStyle = '#140802'; g.lineWidth = 1.5; g.stroke();
      g.beginPath(); g.arc(12, 0, 5, 0, TAU); g.fillStyle = '#b01018'; g.fill(); g.stroke(); g.restore();
    });
    return c;
  });
  function drawBoss(g, t, v, dt) {
    const b = v.boss; if (!b || !b.maxHp) { S.bTrail = 1; S.bLast = 1; return; }
    const f = sat(b.hp / b.maxHp), y = v.isTouch ? 668 : 580, x0 = 640 - BW / 2;
    if (f < S.bLast - 0.0005) S.bDropT = t;
    if (f >= S.bTrail) S.bTrail = f; else if (t - S.bDropT > 0.6) S.bTrail = Math.max(f, S.bTrail - dt * 0.3);
    S.bLast = f;
    g.drawImage(bossFrame(), x0 - 40, y - 22);
    const sp = barSpr('boss', BW, 18, [[0, '#ff4a3a'], [0.4, '#b00c14'], [1, '#3a0004']], true);
    g.fillStyle = '#6a2a1a'; g.fillRect(x0, y, BW * S.bTrail, 18);
    if (f > 0) g.drawImage(sp, 0, 0, Math.max(1, BW * f), 18, x0, y, BW * f, 18);
    txt(g, String(b.name || 'THE BONE KING').toUpperCase(), 640, y - 18, 22, '#f0d8c0', { sp: 7, lw: 5, stroke: '#2a0003' });
  }

  // ── Notifications ──────────────────────────────────────────────────────────
  function band(g, y, h, a, w) {
    w = w || 900; const gr = g.createLinearGradient(640 - w / 2, 0, 640 + w / 2, 0);
    gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.25, `rgba(0,0,0,${0.6 * a})`); gr.addColorStop(0.75, `rgba(0,0,0,${0.6 * a})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(640 - w / 2, y - h / 2, w, h);
  }
  function drawNotes(g, t, v) {
    const notes = v.notifications || [], last = k => { for (let i = notes.length - 1; i >= 0; i--) if (notes[i].kind === k) return notes[i]; return null; };
    // discovery reveal
    const lv = last('level'), lvOn = lv && t - lv.t < 4;
    let n = last('discover');
    if (n && t - n.t < 5) {
      const a = t - n.t, al = fade(a, 5, 0.5, 1.2), name = String(n.text).replace(/^DISCOVERED:\s*/i, ''), y = lvOn ? 430 : 226, lw = 330 * easeOut(a / 1.1);
      band(g, y + 8, 120, al, 1000);
      g.globalAlpha = al;
      txt(g, 'DISCOVERED', 640, y - 26, 17, '#d8a050', { sp: 10, lw: 3 });
      txt(g, name, 640, y + 18, 50, '#f6ead0', { lw: 6, stroke: '#140404', sp: 2 });
      [-1, 1].forEach(s => { const q = g.createLinearGradient(640, 0, 640 + s * lw, 0); q.addColorStop(0, 'rgba(230,170,80,0.95)'); q.addColorStop(1, 'rgba(230,170,80,0)'); g.fillStyle = q; g.fillRect(Math.min(640, 640 + s * lw), y + 52, lw, 2); });
      g.save(); g.translate(640, y + 53); g.rotate(Math.PI / 4); g.fillStyle = '#e8b050'; g.fillRect(-4, -4, 8, 8); g.restore();
      g.globalAlpha = 1;
    }
    // level up
    n = last('level');
    if (n && t - n.t < 4) {
      const a = t - n.t, al = fade(a, 4, 0.3, 1), s = 0.6 + 0.4 * easeOutBack(a / 0.7), y = 262;
      g.globalAlpha = al * 0.9; g.globalCompositeOperation = 'lighter';
      g.drawImage(glowSpr('255,150,40'), 640 - 340 * s, y - 140 * s, 680 * s, 280 * s);
      g.save(); g.translate(640, y); g.rotate(a * 0.25);
      for (let i = 0; i < 12; i++) { g.rotate(TAU / 12); g.fillStyle = 'rgba(255,190,90,0.10)'; g.beginPath(); g.moveTo(0, 0); g.lineTo(280 * s, -16); g.lineTo(280 * s, 16); g.closePath(); g.fill(); }
      g.restore(); g.globalCompositeOperation = 'source-over'; g.globalAlpha = al;
      const T = levelText(String(n.text).toUpperCase());
      g.save(); g.translate(640, y); g.scale(s, s); g.drawImage(T.c, -T.w / 2, -T.h / 2); g.restore();
      txt(g, 'YOUR STRENGTH GROWS', 640, y + 72, 16, '#f0c070', { sp: 8, lw: 4 });
      g.globalAlpha = 1;
    }
    // quest update banner
    n = last('quest');
    if (n && t - n.t < 4.5) {
      const a = t - n.t, al = fade(a, 4.5, 0.4, 0.8), y = 96 - (1 - easeOut(a / 0.5)) * 30;
      g.globalAlpha = al;
      g.drawImage(once('qstrip', () => { const c = mk(620, 84), q = c.getContext('2d'); tornStrip(q, 10, 8, 600, 68); return c; }), 330, y - 8);
      txt(g, 'QUEST UPDATED', 640, y + 16, 13, '#8a1010', { sp: 7, stroke: false });
      txt(g, n.text, 640, y + 40, 19, '#2a1608', { italic: true, weight: 'normal', stroke: false });
      g.globalAlpha = 1;
    }
    // omen
    n = last('omen');
    if (n && t - n.t < 6) {
      const a = t - n.t, al = fade(a, 6, 1.2, 1.5), ls_ = wrap(g, n.text, 900, 34, { italic: true });
      band(g, 380, 60 + ls_.length * 44, al * 0.9, 1100);
      g.globalAlpha = al; ls_.forEach((l, i) => txt(g, l, 640, 380 - (ls_.length - 1) * 22 + i * 44, 34, '#ff4a36', { italic: true, lw: 6, stroke: '#1a0000' }));
      g.globalAlpha = 1;
    }
    // story
    n = last('story');
    if (n && t - n.t < 6) {
      const a = t - n.t, al = fade(a, 6, 1, 1.5), ls_ = wrap(g, n.text, 860, 26, { italic: true, weight: 'normal' });
      band(g, 420, 40 + ls_.length * 34, al, 1000);
      g.globalAlpha = al; ls_.forEach((l, i) => txt(g, l, 640, 420 - (ls_.length - 1) * 17 + i * 34, 26, '#f0e2c8', { italic: true, weight: 'normal', lw: 4 }));
      g.globalAlpha = 1;
    }
    // bark subtitle
    n = last('bark');
    if (n && t - n.t < 4) {
      const al = fade(t - n.t, 4, 0.2, 0.6), y = v.isTouch ? 560 : 548, ls_ = wrap(g, n.text, 760, 20, { weight: 'normal' });
      font(g, 20, { weight: 'normal' }); const w = Math.max(...ls_.map(l => g.measureText(l).width)) + 30;
      g.globalAlpha = al; g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(640 - w / 2, y - 16, w, ls_.length * 26 + 8);
      ls_.forEach((l, i) => txt(g, l, 640, y + i * 26, 20, '#f4ecd8', { weight: 'normal', lw: 3 }));
      g.globalAlpha = 1;
    }
    // info toasts
    const info = notes.filter(q => q.kind === 'info' && t - q.t < 3);
    info.slice(-2).forEach((q, i) => { const al = fade(t - q.t, 3, 0.2, 0.6); g.globalAlpha = al; band(g, 132 + i * 30, 28, al, 520); txt(g, q.text, 640, 132 + i * 30, 17, '#e8d8b8', { lw: 3, sp: 1 }); });
    g.globalAlpha = 1;
    // loot stack
    const loot = notes.filter(q => q.kind === 'loot' && t - q.t < 4).slice(-5);
    const by = v.isTouch ? 380 : 560;
    loot.forEach((q, i) => {
      const a = t - q.t, al = fade(a, 4, 0.25, 0.8), y = by - (loot.length - 1 - i) * 36, x = 1250 + (1 - easeOut(a / 0.3)) * 60;
      g.globalAlpha = al;
      font(g, 19); const w = g.measureText(q.text).width + 70;
      const gr = g.createLinearGradient(x - w, 0, x, 0); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.3, 'rgba(0,0,0,0.7)'); gr.addColorStop(1, 'rgba(0,0,0,0.75)');
      g.fillStyle = gr; g.fillRect(x - w, y - 15, w, 30); g.fillStyle = '#c89040'; g.fillRect(x - 2, y - 15, 2, 30);
      txt(g, q.text, x - 14, y + 1, 19, '#f2e2c0', { align: 'right', lw: 3 });
      font(g, 19); const tw = g.measureText(q.text).width;
      txt(g, '+', x - 26 - tw, y, 22, '#f0c050', { lw: 3 });
    });
    g.globalAlpha = 1;
  }
  const lvlCache = new Map();
  function levelText(s) {
    let T = lvlCache.get(s);
    if (!T) { T = bloodText([{ s, px: 96, y: 80 }], { w: 720, h: 160, scheme: 'gold', seed: 13 }); lvlCache.set(s, T); }
    return T;
  }
  function tornEdge(g, x, y, w, h, j) {
    g.beginPath(); const st = 7;
    for (let i = 0; i <= w; i += st) g.lineTo(x + i, y + rnd() * j);
    for (let i = 0; i <= h; i += st) g.lineTo(x + w - rnd() * j, y + i);
    for (let i = w; i >= 0; i -= st) g.lineTo(x + i, y + h - rnd() * j);
    for (let i = h; i >= 0; i -= st) g.lineTo(x + rnd() * j, y + i);
    g.closePath();
  }
  function tornStrip(g, x, y, w, h) {
    g.save(); g.shadowColor = 'rgba(0,0,0,0.8)'; g.shadowBlur = 8; g.shadowOffsetY = 3;
    tornEdge(g, x, y, w, h, 5); const q = g.createLinearGradient(0, y, 0, y + h); q.addColorStop(0, '#e8d4a8'); q.addColorStop(1, '#b89868'); g.fillStyle = q; g.fill(); g.restore();
    g.save(); tornEdge(g, x, y, w, h, 5); g.clip(); grain(g, x, y, w, h, w * h / 30, '90,60,20', '255,250,220');
    const e = g.createLinearGradient(x, 0, x + w, 0); e.addColorStop(0, 'rgba(70,40,10,0.45)'); e.addColorStop(0.12, 'rgba(0,0,0,0)'); e.addColorStop(0.88, 'rgba(0,0,0,0)'); e.addColorStop(1, 'rgba(70,40,10,0.45)'); g.fillStyle = e; g.fillRect(x, y, w, h); g.restore();
  }

  // ── PAUSE ──────────────────────────────────────────────────────────────────
  const pauseTitle = () => once('pauseT', () => bloodText([{ s: 'PAUSED', px: 76, y: 64 }], { w: 520, h: 130, seed: 9 }));
  function drawPause(g, t, v) {
    full(g, vign('8,2,3', 0.85));
    if (S.settings) { drawSettings(g, t, v); return; }
    drawPanel(g, 440, 150, 400, 460, { fill: 'leather', rim: 14 });
    const T = pauseTitle(); g.drawImage(T.c, 640 - T.w / 2, 110);
    const B = pauseBtns(); hoverSel(B, v.isTouch); S.sel = clamp(S.sel, 0, B.length - 1);
    B.forEach((b, i) => drawBtn(g, b, i === S.sel, t));
    const info = (v.notifications || []).filter(q => q.kind === 'info' && t - q.t < 2.5).pop();
    if (info) { g.globalAlpha = fade(t - info.t, 2.5, 0.2, 0.6); txt(g, info.text, 640, 580, 17, '#e8c078', { sp: 2, lw: 3 }); g.globalAlpha = 1; }
  }

  // ── DEAD ───────────────────────────────────────────────────────────────────
  const deadText = () => once('deadT', () => bloodText([{ s: 'YOU HAVE FALLEN', px: 124, y: 120 }], { w: 1240, h: 260, drips: 7, seed: 3 }));
  function drawDead(g, t, v) {
    const a = t - S.stateT, k = easeInOut(a / 2.6);
    g.globalAlpha = k; full(g, vign('20,0,0', 0.85)); g.globalAlpha = 1;
    const T = deadText(), s = 1.1 - 0.1 * easeOut(a / 3.5);
    g.save(); g.globalAlpha = k; g.setTransform(s, 0, 0, s, 640 - T.w * s / 2, 250 - 120 * s);
    g.drawImage(T.c, 0, 0); drawDrips(g, T, t, k); g.restore();
    const b = easeOut((a - 2) / 0.8);
    if (b > 0) {
      g.globalAlpha = b; txt(g, 'The curse of Vael claims another soul.', 640, 420, 22, '#c8a890', { italic: true, weight: 'normal', lw: 3 });
      S.sel = 0; drawBtn(g, DEAD_B, true, t); g.globalAlpha = 1;
    }
  }

  // ── VICTORY ────────────────────────────────────────────────────────────────
  const vicText = () => once('vicT', () => bloodText([{ s: 'THE THRONE IS BROKEN', px: 96, y: 96 }], { w: 1240, h: 200, scheme: 'gold', seed: 21 }));
  const EPILOGUE = 'The Bone King is dead, and his curse lifts from Vael. The dead lie still at last. Kaela Ironhand takes back her crown in the black citadel. Nyx of the Pale Moon vanishes with the moon, as she said she would. At the Red-Arrow Lodge, Vesna waits for you with a grin.';
  function drawVictory(g, t, v, dt) {
    const a = t - S.stateT;
    g.globalAlpha = easeOut(a / 1.5); full(g, vign('10,4,2', 0.9)); g.globalAlpha = 1;
    embers(g, t, dt, 40, easeOut(a / 2));
    const T = vicText(), k = easeOut(a / 1.6);
    g.globalAlpha = k; g.drawImage(T.c, 640 - T.w / 2, 26 + (1 - k) * 20); g.globalAlpha = 1;
    const e = easeOut((a - 1.2) / 1.5), L = wrap(g, EPILOGUE, 880, 23, { italic: true, weight: 'normal' });
    g.globalAlpha = e; L.forEach((l, i) => txt(g, l, 640, 262 + i * 34, 23, '#eadcc0', { italic: true, weight: 'normal', lw: 4 }));
    const hy = 262 + L.length * 34 + 30, h = easeOut((a - 2.6) / 1.2);
    g.globalAlpha = h;
    [['KAELA IRONHAND', 'the Queen'], ['NYX', 'of the Pale Moon'], ['VESNA', 'Red-Arrow']].forEach(([n1, n2], i) => {
      const x = 640 + (i - 1) * 290;
      txt(g, n1, x, hy, 20, '#f0c070', { sp: 4, lw: 4 }); txt(g, n2, x, hy + 24, 15, '#b8a080', { italic: true, weight: 'normal', lw: 3 });
    });
    const c = easeOut((a - 3.6) / 1.2); g.globalAlpha = c;
    txt(g, 'A GAME BY JOHN SLAGBOOM', 640, hy + 78, 20, '#e8dcc0', { sp: 8, lw: 4 });
    if (c > 0) drawBtn(g, VIC_B, S.sel === 0, t);
    g.globalAlpha = 1;
  }

  // ── DIALOG ─────────────────────────────────────────────────────────────────
  const silhouette = () => once('silh', () => {
    const c = mk(256, 320), g = c.getContext('2d');
    let q = g.createRadialGradient(150, 110, 10, 128, 160, 230); q.addColorStop(0, '#8a2410'); q.addColorStop(0.45, '#3a0c08'); q.addColorStop(1, '#0a0203');
    g.fillStyle = q; g.fillRect(0, 0, 256, 320);
    grain(g, 0, 0, 256, 320, 1400, '0,0,0', '255,160,100');
    const body = () => {
      g.beginPath(); g.moveTo(96, 150); g.bezierCurveTo(78, 70, 110, 44, 132, 46); g.bezierCurveTo(166, 48, 184, 84, 164, 150);
      g.bezierCurveTo(170, 176, 206, 184, 240, 214); g.lineTo(256, 320); g.lineTo(0, 320); g.lineTo(14, 222); g.bezierCurveTo(48, 186, 90, 178, 96, 150); g.closePath();
    };
    g.save(); g.translate(4, 0); body(); g.fillStyle = 'rgba(255,110,50,0.8)'; g.fill(); g.restore();
    body(); g.fillStyle = '#070203'; g.fill();
    for (let i = 0; i < 22; i++) { const x = 10 + i * 11; g.beginPath(); g.moveTo(x, 214 - Math.sin(i) * 6); g.lineTo(x + 6, 200 - (i % 3) * 5); g.lineTo(x + 11, 214); g.fillStyle = '#070203'; g.fill(); }
    q = g.createLinearGradient(0, 220, 0, 320); q.addColorStop(0, 'rgba(0,0,0,0)'); q.addColorStop(1, 'rgba(0,0,0,0.6)'); g.fillStyle = q; g.fillRect(0, 220, 256, 100);
    return c;
  });
  function dlgText(d) { return (Array.isArray(d.lines) ? d.lines : [String(d.lines || '')]).join('\n'); }
  function dlgState(d, t) {
    const key = (d.name || '') + '|' + dlgText(d);
    if (key !== S.tw.key) { S.tw = { key, t0: t, done: false, n: 0 }; S.dlgSel = 0; }
    return S.tw;
  }
  function drawDialog(g, t, v) {
    const d = v.dialog;
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, 0, W, H);
    let q = g.createLinearGradient(0, 0, 0, 70); q.addColorStop(0, '#000'); q.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = q; g.fillRect(0, 0, W, 70);
    q = g.createLinearGradient(0, H - 70, 0, H); q.addColorStop(0, 'rgba(0,0,0,0)'); q.addColorStop(1, '#000'); g.fillStyle = q; g.fillRect(0, H - 70, W, 70);
    if (!d) { txt(g, '...', 640, 360, 40, '#d8c8a8'); return; }
    // portrait
    drawPanel(g, DLG.px - 12, DLG.py - 12, DLG.pw + 24, DLG.ph + 24, { fill: 'dark', rim: 12 });
    const pc = d.portrait && d.portrait.width ? d.portrait : silhouette();
    g.imageSmoothingEnabled = false; g.drawImage(pc, DLG.px, DLG.py, DLG.pw, DLG.ph); g.imageSmoothingEnabled = true;
    q = g.createLinearGradient(0, DLG.py + DLG.ph - 120, 0, DLG.py + DLG.ph); q.addColorStop(0, 'rgba(0,0,0,0)'); q.addColorStop(1, 'rgba(0,0,0,0.75)'); g.fillStyle = q; g.fillRect(DLG.px, DLG.py + DLG.ph - 120, DLG.pw, 120);
    // name plate
    const ny = DLG.py + DLG.ph + 6, nw = 360, nx = DLG.px + DLG.pw / 2 - nw / 2;
    g.drawImage(once('plate', () => {
      const c = mk(nw + 40, 80), p = c.getContext('2d'); p.translate(20, 12);
      p.save(); p.shadowColor = 'rgba(0,0,0,0.9)'; p.shadowBlur = 12; p.shadowOffsetY = 4;
      p.beginPath(); p.moveTo(0, 26); p.lineTo(22, 0); p.lineTo(nw - 22, 0); p.lineTo(nw, 26); p.lineTo(nw - 22, 52); p.lineTo(22, 52); p.closePath(); p.fillStyle = bronzeGrad(p, 0, 52); p.fill(); p.restore();
      p.beginPath(); p.moveTo(6, 26); p.lineTo(25, 4); p.lineTo(nw - 25, 4); p.lineTo(nw - 6, 26); p.lineTo(nw - 25, 48); p.lineTo(25, 48); p.closePath();
      const r = p.createLinearGradient(0, 4, 0, 48); r.addColorStop(0, '#8a1016'); r.addColorStop(1, '#2a0204'); p.fillStyle = r; p.fill(); p.strokeStyle = '#140802'; p.lineWidth = 1.5; p.stroke();
      rivet(p, 30, 26, 3); rivet(p, nw - 30, 26, 3); return c;
    }), nx - 20, ny - 12);
    txt(g, String(d.name || '').toUpperCase(), nx + nw / 2, ny + 27, String(d.name || '').length > 18 ? 20 : 24, '#ffeccc', { sp: 3, lw: 4, stroke: '#1a0002' });
    // text box
    drawPanel(g, DLG.tx, DLG.ty, DLG.tw, DLG.th, { fill: 'leather', rim: 12, orn: false });
    const tw = dlgState(d, t), full_ = dlgText(d), lines = wrap(g, full_, DLG.tw - 72, 24, { weight: 'normal' });
    const total = lines.reduce((s, l) => s + l.length, 0);
    tw.n = tw.done ? total : Math.floor((t - tw.t0) * 55); if (tw.n >= total) tw.done = true;
    let left = tw.n;
    lines.slice(0, 6).forEach((l, i) => { if (left <= 0) return; const s = l.slice(0, left); left -= l.length; txt(g, s, DLG.tx + 36, DLG.ty + 42 + i * 34, 24, '#efe2c6', { align: 'left', weight: 'normal', lw: 3 }); });
    if (!tw.done) { g.globalAlpha = 0.5 + 0.5 * Math.sin(t * 5); g.fillStyle = '#e8b050'; g.fillRect(DLG.tx + DLG.tw - 40, DLG.ty + DLG.th - 36, 10, 10); g.globalAlpha = 1; }
    // choices
    if (tw.done) {
      const B = dlgBtns(d), a = easeOut((t - tw.t0 - total / 55) / 0.35);
      if (!v.isTouch && S.mouse) { const i = B.findIndex(b => inside(b, S.mx, S.my)); if (i >= 0) S.dlgSel = i; }
      S.dlgSel = clamp(S.dlgSel, 0, B.length - 1);
      g.globalAlpha = Math.max(a, 0.05);
      B.forEach((b, i) => {
        const hot = i === S.dlgSel;
        g.drawImage(btnSpr(b.w, b.h, hot), b.x - 16, b.y - 16);
        let x = b.x + 26;
        if (!v.isTouch) {
          cham(g, b.x + 16, b.y + b.h / 2 - 16, 32, 32, 6); g.fillStyle = bronzeGrad(g, b.y + b.h / 2 - 16, b.y + b.h / 2 + 16); g.fill();
          txt(g, String(b.n), b.x + 32, b.y + b.h / 2 + 1, 18, '#1a0a02', { stroke: false }); x = b.x + 64;
        }
        const ls_ = wrap(g, b.label, b.w - (x - b.x) - 30, 21, { weight: 'normal' });
        txt(g, ls_[0] + (ls_.length > 1 ? '...' : ''), x, b.y + b.h / 2 + 1, 21, hot ? '#fff0d0' : '#d8c8a8', { align: 'left', weight: 'normal', lw: 3 });
      });
      g.globalAlpha = 1;
    }
  }

  // ── INVENTORY ──────────────────────────────────────────────────────────────
  function slotFrame(g, x, y, s, on) {
    cham(g, x, y, s, s, 10); g.fillStyle = '#0a0606'; g.fill(); g.lineWidth = 2; g.strokeStyle = on ? '#e8b050' : 'rgba(176,122,50,0.6)'; g.stroke();
    cham(g, x + 4, y + 4, s - 8, s - 8, 7); const q = g.createRadialGradient(x + s / 2, y + s / 2, 4, x + s / 2, y + s / 2, s * 0.7); q.addColorStop(0, on ? '#3a1416' : '#1c1414'); q.addColorStop(1, '#070404'); g.fillStyle = q; g.fill();
  }
  function statLines(id, v) {
    const it = ITEMS()[id] || {}, out = [];
    if (it.kind === 'weapon') {
      const cur = ITEMS()[equippedIds(v)[0]], dd = cur && cur !== it ? it.damage - cur.damage : 0;
      out.push(['DAMAGE', String(it.damage), dd ? (dd > 0 ? '+' + dd : String(dd)) : '', dd > 0 ? '#7ad060' : '#e05040']);
      out.push(['HEAVY', '×' + it.heavyMult]); out.push(['SPEED', String(it.speed)]); out.push(['REACH', it.reach + ' m']); out.push(['BLEED', Math.round((it.bleed || 0) * 100) + '%']);
      if (it.holy) out.push(['HOLY', 'Wounds the cursed']);
    } else if (it.kind === 'armor') out.push(['ARMOUR', Math.round((it.armor || 0) * 100) + '%']);
    else if (it.kind === 'charm') { if (it.crit) out.push(['CRITICAL', '+' + Math.round(it.crit * 100) + '%']); if (it.holy) out.push(['HOLY', 'Wounds the cursed']); }
    else if (it.kind === 'potion') out.push(['HEALS', String(it.heal)]);
    else if (it.kind === 'quest') out.push(['QUEST ITEM', '']);
    if (it.price) out.push(['VALUE', it.price + ' gold']);
    return out;
  }
  function drawInventory(g, t, v) {
    g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(0, 0, W, H);
    drawPanel(g, INV.x, INV.y, INV.w, INV.h, { fill: 'leather', rim: 14 });
    const st = (v.rpg && v.rpg.stats) || {}, pl = v.player || {}, eq = equippedIds(v), I = ITEMS();
    // column dividers
    g.fillStyle = 'rgba(176,122,50,0.35)'; g.fillRect(404, 50, 1, 620); g.fillRect(880, 50, 1, 620);
    // left: the character sheet
    txt(g, 'THE WANDERER', 222, 64, 22, '#e8c078', { sp: 6, lw: 4 });
    g.drawImage(lvlShield(84, 100), 58, 88);
    txt(g, String(st.level || 1), 106, 140, 40, '#fff0d0', { lw: 6 });
    txt(g, 'LEVEL ' + (st.level || 1), 170, 110, 24, '#f0dcc0', { align: 'left', sp: 3, lw: 4 });
    const xf = sat((st.xp || 0) / Math.max(1, st.xpNext || 100));
    g.fillStyle = '#070304'; g.fillRect(170, 132, 200, 8); g.drawImage(XP_SPR(), 0, 0, Math.max(1, BAR.w * xf), 6, 171, 133, 198 * xf, 6);
    txt(g, `${st.xp || 0} / ${st.xpNext || 100} XP`, 170, 158, 14, '#b8a080', { align: 'left', lw: 3 });
    const wpn = I[eq[0]], arm = I[eq[1]];
    const rows = [['HEALTH', `${Math.ceil(pl.hp || 0)} / ${Math.round(pl.hpMax || 100)}`], ['STAMINA', `${Math.ceil(pl.stamina || 0)} / ${Math.round(pl.staminaMax || 100)}`],
      ['STRENGTH', String(st.str != null ? st.str : '-')], ['DAMAGE', wpn ? String(wpn.damage) : '-'], ['ARMOUR', Math.round(((arm && arm.armor) || 0) * 100) + '%'], ['GOLD', String(st.gold != null ? st.gold : 0)]];
    rows.forEach(([k, val], i) => {
      const y = 214 + i * 38;
      g.fillStyle = i % 2 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.25)'; g.fillRect(56, y - 17, 332, 34);
      txt(g, k, 70, y, 16, '#b8a080', { align: 'left', sp: 3, lw: 3 }); txt(g, val, 374, y, 19, k === 'GOLD' ? '#f0c050' : '#f0e0c4', { align: 'right', lw: 3 });
    });
    txt(g, 'EQUIPPED', 222, 460, 16, '#e8c078', { sp: 6, lw: 3 });
    [['WEAPON', eq[0]], ['ARMOUR', eq[1]], ['CHARM', eq[2]]].forEach(([lab, id], i) => {
      const x = 58 + i * 114, y = 482, on = id && id === S.invSel;
      slotFrame(g, x, y, 100, on);
      if (id && I[id]) g.drawImage(itemIcon(id, 72), x + 50 - 40, y + 50 - 40);
      else txt(g, lab, x + 50, y + 50, 12, 'rgba(180,150,110,0.45)', { sp: 2, stroke: false });
      const nm = id && I[id] ? I[id].name : 'None';
      const ls_ = wrap(g, nm, 106, 13, { weight: 'normal' });
      ls_.slice(0, 2).forEach((l, j) => txt(g, l, x + 50, y + 118 + j * 16, 13, id ? '#d8c8a8' : '#7a6a58', { weight: 'normal', lw: 3 }));
    });
    // middle: the pack
    if (!compOwned()) txt(g, 'PACK', 644, 64, 22, '#e8c078', { sp: 8, lw: 4 });
    const { btns, R, over } = invBtns(v);
    if (compTab()) { const c = CT.rpg.companion; txt(g, `SELENE CARRIES     SMOKES ${c.smokes}     BEERS ${c.beers}`, 644, 96, 12, '#a8c0e8', { sp: 3, lw: 3 }); }
    S.invScroll = clamp(S.invScroll, 0, Math.max(0, R.total - INV.lh));
    const sel = S.invSel, rw = INV.lw - (over ? 60 : 0);
    g.save(); g.beginPath(); g.rect(INV.lx - 4, INV.ly - 2, INV.lw + 8, INV.lh + 4); g.clip();
    if (!R.rows.length) txt(g, compTab() ? 'Selene carries nothing of yours.' : 'Your pack is empty.', 644, 300, 20, '#9a8a70', { italic: true, weight: 'normal', lw: 3 });
    R.rows.forEach(r => {
      const y = INV.ly + r.y - S.invScroll; if (y > INV.ly + INV.lh || y + r.h < INV.ly) return;
      if (r.hdr) { txt(g, r.hdr, INV.lx + 4, y + 16, 14, '#c89050', { align: 'left', sp: 5, lw: 3 }); g.fillStyle = 'rgba(200,144,80,0.3)'; g.fillRect(INV.lx + 110, y + 16, rw - 114, 1); return; }
      const it = I[r.id] || { name: r.id }, on = r.id === sel, isEq = eq.includes(r.id);
      cham(g, INV.lx, y, rw, r.h, 8); g.fillStyle = on ? 'rgba(140,16,22,0.55)' : 'rgba(0,0,0,0.35)'; g.fill();
      if (on) { g.strokeStyle = '#e8b050'; g.lineWidth = 1.5; g.stroke(); }
      g.drawImage(itemIcon(r.id, 44), INV.lx + 8, y + r.h / 2 - 26);
      txt(g, it.name + (r.count > 1 ? `  ×${r.count}` : ''), INV.lx + 66, y + r.h / 2 + 1, 19, on ? '#fff0d0' : '#e0d0b4', { align: 'left', weight: 'normal', lw: 3 });
      if (isEq) txt(g, 'EQUIPPED', INV.lx + rw - 12, y + r.h / 2 + 1, 12, '#e8b050', { align: 'right', sp: 2, lw: 3 });
    });
    g.restore();
    // right: details
    if (sel && I[sel]) {
      const it = I[sel], cx = INV.dx + 170;
      slotFrame(g, cx - 70, 116, 140, true);
      g.drawImage(itemIcon(sel, 110), cx - 59, 127);
      const nl = wrap(g, it.name, 300, 26, {});
      nl.forEach((l, i) => txt(g, l, cx, 290 + i * 30, 26, '#f6e6c8', { lw: 4 }));
      const ky = 290 + nl.length * 30;
      txt(g, ({ weapon: (it.style || 'weapon'), armor: 'armour', charm: 'charm', potion: 'potion', loot: 'spoils', quest: 'quest item' }[it.kind] || '').toUpperCase(), cx, ky, 13, '#c89050', { sp: 5, lw: 3 });
      statLines(sel, v).forEach(([k, val, delta, dc], i) => {
        const y = ky + 36 + i * 30;
        g.fillStyle = i % 2 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.25)'; g.fillRect(INV.dx + 10, y - 14, 320, 28);
        txt(g, k, INV.dx + 22, y, 15, '#b8a080', { align: 'left', sp: 2, lw: 3 });
        txt(g, val, INV.dx + 318 - (delta ? 44 : 0), y, 17, '#f0e0c4', { align: 'right', lw: 3 });
        if (delta) txt(g, delta, INV.dx + 318, y, 15, dc, { align: 'right', lw: 3 });
      });
    }
    btns.forEach(b => {
      if (b.scroll) { g.drawImage(btnSpr(b.w, b.h, false), b.x - 16, b.y - 16); txt(g, b.label, b.x + b.w / 2, b.y + b.h / 2, 18, '#d8c8a8', { lw: 3 }); return; }
      const hot = !v.isTouch && S.mouse && inside(b, S.mx, S.my);
      if (b.tab) { drawBtn(g, b, b.on || hot, t, { px: 18, noPtr: true }); return; }
      drawBtn(g, b, hot || (b !== INV_CLOSE && !b.dis && !v.isTouch && !S.mouse), t, { px: 22, noPtr: b === INV_CLOSE });
    });
    if (!v.isTouch) txt(g, 'ARROWS  SELECT     ENTER  ' + ((invAction(v, sel) || {}).label || 'USE') + '     ESC  CLOSE', 644, 672, 11, '#8a7a60', { sp: 3, lw: 2 });
  }

  // ── MAP ────────────────────────────────────────────────────────────────────
  const EXT = 1600, MAPN = 256, MS = { x: 56, y: 36, w: 640, h: 648, mx: 106, my: 86, ms: 540 };
  const MB = { j: 0, h: null, b: null, wet: null, done: false, sheet: null, world: null };
  function fakeH(x, z) {
    const r = Math.hypot(x, z) / 1500, a = Math.atan2(z, x);
    const edge = 0.9 + 0.05 * Math.sin(3 * a + 0.5) + 0.035 * Math.sin(7 * a + 2) + 0.08 * (vnoise(x / 260, z / 260, 3) - 0.5);
    let h = (edge - r) * 240;
    if (h > 0) h += Math.max(0, -z - 400) / 1100 * 320 + (vnoise(x / 150, z / 150, 5) - 0.5) * 50 + (vnoise(x / 60, z / 60, 8) - 0.5) * 12;
    return h;
  }
  function fakeB(x, z, h) {
    x += (vnoise(x / 220, z / 220, 17) - 0.5) * 420; z += (vnoise(x / 220, z / 220, 19) - 0.5) * 300;
    if (h < 6) return 'coast'; if (z < -900) return h > 200 ? 'citadel' : 'snow'; if (z < -600) return 'snow';
    if (x < -380) return 'forest'; if (x > 480) return 'swamp'; if (z > 700) return 'meadow'; return 'hills';
  }
  const BIO = { coast: [240, 228, 196], meadow: [222, 216, 170], forest: [150, 158, 112], swamp: [158, 156, 116], hills: [214, 194, 150], snow: [252, 250, 246], citadel: [128, 100, 96] };
  function mapStep(budget) {
    if (MB.done) return;
    const wd = CT.world, real = !!(wd && typeof wd.heightAt === 'function');
    if (!MB.h || MB.world !== real) { MB.h = new Float32Array(MAPN * MAPN); MB.b = new Array(MAPN * MAPN); MB.wet = new Uint8Array(MAPN * MAPN); MB.j = 0; MB.world = real; }
    const t0 = performance.now();
    while (MB.j < MAPN && performance.now() - t0 < budget) {
      const j = MB.j++, z = (j / (MAPN - 1) * 2 - 1) * EXT;
      for (let i = 0; i < MAPN; i++) {
        const x = (i / (MAPN - 1) * 2 - 1) * EXT, k = j * MAPN + i; let h, b, wet;
        if (real) { h = +wd.heightAt(x, z) || 0; b = wd.biomeAt ? wd.biomeAt(x, z) : null; wet = wd.waterAt ? (+wd.waterAt(x, z) || 0) > 0.5 : h <= 0.2; if (Math.hypot(x, z) > EXT * 0.99) wet = true; }
        else { h = fakeH(x, z); b = fakeB(x, z, h); wet = h <= 0; }
        MB.h[k] = h; MB.b[k] = b; MB.wet[k] = wet ? 1 : 0;
      }
    }
    if (MB.j >= MAPN) { MB.done = true; MB.sheet = composeMap(); }
  }
  function composeMap() {
    const N = MAPN, img = mk(N, N), g = img.getContext('2d'), id = g.createImageData(N, N), d = id.data, Hh = MB.h, WT = MB.wet;
    const sea = mk(N, N), sg = sea.getContext('2d'), sd = sg.createImageData(N, N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i, o = k * 4, h = Hh[k];
      const hE = Hh[j * N + Math.min(N - 1, i + 1)], hW = Hh[j * N + Math.max(0, i - 1)], hS = Hh[Math.min(N - 1, j + 1) * N + i], hN = Hh[Math.max(0, j - 1) * N + i];
      let c;
      if (WT[k]) {
        const dep = sat(-h / 60); c = [lerp(150, 96, dep), lerp(166, 116, dep), lerp(160, 118, dep)];
        sd.data[o + 3] = 255;
      } else {
        c = (BIO[MB.b[k]] || BIO.meadow).slice();
        const s = clamp(1 + ((hE - hW) + (hS - hN)) * 0.018, 0.55, 1.2);
        c = c.map(v => v * s);
        if (Math.floor(h / 70) !== Math.floor(hE / 70) || Math.floor(h / 70) !== Math.floor(hS / 70)) c = c.map(v => v * 0.8);
        const coast = WT[j * N + Math.min(N - 1, i + 1)] || WT[j * N + Math.max(0, i - 1)] || WT[Math.min(N - 1, j + 1) * N + i] || WT[Math.max(0, j - 1) * N + i];
        if (coast) c = [70, 46, 26];
      }
      d[o] = clamp(c[0], 0, 255); d[o + 1] = clamp(c[1], 0, 255); d[o + 2] = clamp(c[2], 0, 255); d[o + 3] = 255;
    }
    g.putImageData(id, 0, 0); sg.putImageData(sd, 0, 0);
    // the sheet: torn parchment + inked map
    const c = mk(MS.w + 20, MS.h + 20), q = c.getContext('2d'), ox = 10, oy = 10;
    q.save(); q.shadowColor = 'rgba(0,0,0,0.9)'; q.shadowBlur = 16; q.shadowOffsetY = 6;
    tornEdge(q, ox, oy, MS.w, MS.h, 9); const pg = q.createRadialGradient(ox + MS.w / 2, oy + MS.h / 2, 40, ox + MS.w / 2, oy + MS.h / 2, MS.w * 0.75);
    pg.addColorStop(0, '#f0dfb6'); pg.addColorStop(0.7, '#d8bf8a'); pg.addColorStop(1, '#9a7a48'); q.fillStyle = pg; q.fill(); q.restore();
    q.save(); tornEdge(q, ox, oy, MS.w, MS.h, 9); q.clip();
    grain(q, ox, oy, MS.w, MS.h, 9000, '90,60,20', '255,250,220');
    for (let i = 0; i < 18; i++) { const x = ox + rnd() * MS.w, y = oy + rnd() * MS.h, r = 20 + rnd() * 70, s = q.createRadialGradient(x, y, 0, x, y, r); s.addColorStop(0, 'rgba(120,80,30,0.12)'); s.addColorStop(0.8, 'rgba(120,80,30,0.05)'); s.addColorStop(1, 'rgba(120,80,30,0)'); q.fillStyle = s; q.fillRect(x - r, y - r, r * 2, r * 2); }
    const mx = MS.mx - MS.x + ox, my = MS.my - MS.y + oy, ms = MS.ms;
    q.globalCompositeOperation = 'multiply'; q.imageSmoothingEnabled = true; q.imageSmoothingQuality = 'high'; q.drawImage(img, mx, my, ms, ms);
    // sea hatching
    const hc = mk(ms, ms), hg = hc.getContext('2d'); hg.strokeStyle = 'rgba(40,50,60,0.5)'; hg.lineWidth = 1;
    for (let y = 2; y < ms; y += 7) { hg.beginPath(); for (let x = 0; x < ms; x += 12) { hg.moveTo(x + (y % 14 ? 6 : 0), y); hg.lineTo(x + 6 + (y % 14 ? 6 : 0), y); } hg.stroke(); }
    hg.globalCompositeOperation = 'destination-in'; hg.imageSmoothingEnabled = true; hg.drawImage(sea, 0, 0, ms, ms);
    q.globalAlpha = 0.5; q.drawImage(hc, mx, my); q.globalAlpha = 1; q.globalCompositeOperation = 'source-over';
    q.restore();
    // border, cartouche, compass rose
    q.strokeStyle = 'rgba(60,36,16,0.8)'; q.lineWidth = 2; q.strokeRect(mx - 6, my - 6, ms + 12, ms + 12); q.lineWidth = 1; q.strokeRect(mx - 10, my - 10, ms + 20, ms + 20);
    q.fillStyle = 'rgba(240,224,186,0.85)'; q.fillRect(mx + 8, my + 8, 150, 58); q.strokeStyle = 'rgba(60,36,16,0.8)'; q.strokeRect(mx + 8.5, my + 8.5, 149, 57);
    txt(q, 'VAEL', mx + 83, my + 32, 30, '#3a1608', { sp: 8, stroke: false }); txt(q, 'THE CURSED ISLE', mx + 83, my + 54, 10, '#6a3a18', { sp: 3, stroke: false });
    const rx = mx + ms - 60, ry = my + ms - 64;
    q.save(); q.translate(rx, ry);
    for (let i = 0; i < 8; i++) { q.rotate(TAU / 8); q.beginPath(); q.moveTo(0, 0); q.lineTo(5, 0); q.lineTo(0, i % 2 ? -22 : -38); q.closePath(); q.fillStyle = i % 2 ? '#7a5a30' : '#3a2410'; q.fill(); q.beginPath(); q.moveTo(0, 0); q.lineTo(-5, 0); q.lineTo(0, i % 2 ? -22 : -38); q.closePath(); q.fillStyle = i % 2 ? '#c8a060' : '#8a1a10'; q.fill(); }
    q.beginPath(); q.arc(0, 0, 26, 0, TAU); q.strokeStyle = 'rgba(60,36,16,0.7)'; q.stroke(); q.restore();
    txt(q, 'N', rx, ry - 48, 16, '#3a1608', { stroke: false });
    return c;
  }
  const w2m = (x, z) => [MS.mx + (x / EXT * 0.5 + 0.5) * MS.ms, MS.my + (z / EXT * 0.5 + 0.5) * MS.ms];
  function drawMap(g, t, v) {
    mapStep(8);
    g.fillStyle = 'rgba(4,2,2,0.82)'; g.fillRect(0, 0, W, H);
    if (MB.sheet) g.drawImage(MB.sheet, MS.x - 10, MS.y - 10);
    else { txt(g, 'The cartographer inks the map...', MS.x + MS.w / 2, 360, 22, '#d8c8a8', { italic: true, weight: 'normal' }); }
    const m = v.map || {}, pois = m.pois || (CT.config && CT.config.POIS) || [];
    if (MB.sheet) {
      g.save(); g.beginPath(); g.rect(MS.mx - 6, MS.my - 6, MS.ms + 12, MS.ms + 12); g.clip();
      // minor landmarks: found ones as small ink diamonds with a name, unknown ones hidden
      ((CT.world && CT.world.sites) || []).forEach(s => {
        if (!s.found) return;
        const [x, y] = w2m(s.x, s.z);
        g.fillStyle = '#3a1a08'; g.beginPath(); g.moveTo(x, y - 5); g.lineTo(x + 5, y); g.lineTo(x, y + 5); g.lineTo(x - 5, y); g.closePath(); g.fill();
        txt(g, s.name, x, y + 15, 11, '#3a1a08', { italic: true, weight: 'normal', stroke: 'rgba(240,226,190,0.7)', lw: 2, sy: 0 });
      });
      pois.forEach(p => {
        const [x, y] = w2m(p.x, p.z);
        if (p.found) {
          const ic = poiIcon(p.type || 'unknown', 24, p.type === 'citadel' ? '#8a1010' : '#2a1608');
          g.drawImage(ic, x - ic.width / 2, y - ic.height / 2);
          txt(g, p.name, x, y + 22, 14, '#2a1206', { italic: true, stroke: 'rgba(240,226,190,0.8)', lw: 3, sy: 0 });
        } else { g.globalAlpha = 0.45; txt(g, '?', x, y, 20, '#4a2a10', { stroke: false }); g.globalAlpha = 1; }
      });
      if (m.quest) {
        const [x, y] = w2m(m.quest.x, m.quest.z), p = 0.5 + 0.5 * Math.sin(t * 2.5);
        g.beginPath(); g.arc(x, y, 14 + p * 6, 0, TAU); g.strokeStyle = `rgba(160,20,10,${0.6 - p * 0.4})`; g.lineWidth = 2; g.stroke();
        const ic = poiIcon('quest', 26); g.drawImage(ic, x - ic.width / 2, y - ic.height / 2);
      }
      if (m.player) {
        const [x, y] = w2m(m.player.x, m.player.z), yaw = m.player.yaw || 0, ang = Math.atan2(-Math.cos(yaw), -Math.sin(yaw));
        g.save(); g.translate(x, y); g.rotate(ang);
        g.beginPath(); g.moveTo(14, 0); g.lineTo(-9, -9); g.lineTo(-4, 0); g.lineTo(-9, 9); g.closePath();
        g.fillStyle = '#c01018'; g.fill(); g.lineWidth = 2.5; g.strokeStyle = '#1a0402'; g.stroke(); g.fillStyle = '#ffd080'; g.beginPath(); g.moveTo(10, 0); g.lineTo(-4, -4); g.lineTo(-2, 0); g.closePath(); g.fill();
        g.restore();
      }
      g.restore();
    }
    // legend panel
    drawPanel(g, 740, 44, 480, 632, { fill: 'leather', rim: 14 });
    txt(g, 'MAP OF VAEL', 980, 94, 28, '#e8c078', { sp: 8, lw: 4 });
    g.fillStyle = bronzeGrad(g, 0, 2); g.fillRect(800, 120, 360, 2);
    const q = v.rpg && v.rpg.active;
    let y = 152;
    if (q && q.title) {
      g.drawImage(poiIcon('quest', 22), 790, y - 15);
      txt(g, q.title.toUpperCase(), 822, y, 17, '#f0c878', { align: 'left', sp: 2, lw: 3 });
      wrap(g, q.text || '', 360, 16, { italic: true, weight: 'normal' }).slice(0, 3).forEach((l, i) => txt(g, l, 822, y + 26 + i * 21, 16, '#e0d0b0', { align: 'left', italic: true, weight: 'normal', lw: 3 }));
      y += 100;
    }
    const found = pois.filter(p => p.found);
    txt(g, `PLACES FOUND  ${found.length} / ${pois.length}`, 790, y, 14, '#c89050', { align: 'left', sp: 4, lw: 3 });
    y += 30;
    found.slice(0, 10).forEach((p, i) => {
      const yy = y + i * 34; g.drawImage(poiIcon(p.type || 'unknown', 22), 790, yy - 15);
      txt(g, p.name, 824, yy, 18, '#eadcc0', { align: 'left', weight: 'normal', lw: 3 });
    });
    if (!found.length) txt(g, 'No places found yet.', 790, y + 4, 17, '#9a8a70', { align: 'left', italic: true, weight: 'normal', lw: 3 });
    const hot = !v.isTouch && (S.mouse ? inside(MAP_CLOSE, S.mx, S.my) : true);
    drawBtn(g, MAP_CLOSE, hot, t, { noPtr: true });
  }

  // ── Iron Stallion (vehicle.js): classic round tach + speedo while driving ──
  const carOn = () => !!(CT.vehicle && CT.vehicle.driving && typeof CT.vehicle.gauge === 'function');
  function carDial(g, x, y, R, val, max, major, minor, red, label, sub) {
    const A0 = Math.PI * 0.75, SW = Math.PI * 1.5, ang = f => A0 + SW * clamp(f, 0, 1.02);
    g.save();
    let gr = g.createLinearGradient(x - R, y - R, x + R, y + R); gr.addColorStop(0, '#f4f6f8'); gr.addColorStop(0.45, '#7c838c'); gr.addColorStop(0.55, '#3a3e44'); gr.addColorStop(1, '#d8dde2');
    g.fillStyle = 'rgba(0,0,0,0.55)'; g.beginPath(); g.arc(x + 2, y + 3, R + 7, 0, Math.PI * 2); g.fill();
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, R + 6, 0, Math.PI * 2); g.fill();
    gr = g.createRadialGradient(x - R * 0.3, y - R * 0.4, 2, x, y, R); gr.addColorStop(0, '#1d2024'); gr.addColorStop(1, '#050607');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, R, 0, Math.PI * 2); g.fill();
    if (red != null) { g.strokeStyle = '#c8161a'; g.lineWidth = 6; g.beginPath(); g.arc(x, y, R - 7, ang(red / max), ang(1)); g.stroke(); }
    for (let v = 0; v <= max + 1e-6; v += minor) {
      const a = ang(v / max), big = Math.abs(v / major - Math.round(v / major)) < 1e-6, r0 = R - (big ? 13 : 8);
      g.strokeStyle = red != null && v >= red ? '#ff6a5a' : '#eef0f2'; g.lineWidth = big ? 2.5 : 1.2;
      g.beginPath(); g.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0); g.lineTo(x + Math.cos(a) * (R - 3), y + Math.sin(a) * (R - 3)); g.stroke();
      if (big) { g.fillStyle = '#eef0f2'; g.font = `bold ${Math.round(R * 0.2)}px Georgia, serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(Math.round(v / (max > 20 ? 1 : 1))), x + Math.cos(a) * (R - 23), y + Math.sin(a) * (R - 23)); }
    }
    g.fillStyle = '#9aa0a8'; g.font = `bold ${Math.round(R * 0.16)}px Georgia, serif`; g.textAlign = 'center'; g.fillText(label, x, y + R * 0.38); if (sub) { g.font = `${Math.round(R * 0.13)}px Georgia, serif`; g.fillText(sub, x, y + R * 0.56); }
    const a = ang(val / max);
    g.shadowColor = 'rgba(255,120,40,0.8)'; g.shadowBlur = 8; g.strokeStyle = '#ff7a1a'; g.lineWidth = 3; g.lineCap = 'round';
    g.beginPath(); g.moveTo(x - Math.cos(a) * 10, y - Math.sin(a) * 10); g.lineTo(x + Math.cos(a) * (R - 10), y + Math.sin(a) * (R - 10)); g.stroke(); g.shadowBlur = 0;
    gr = g.createRadialGradient(x - 2, y - 2, 1, x, y, 8); gr.addColorStop(0, '#f4f4f4'); gr.addColorStop(1, '#4a4e54');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  function drawCarGauge(g, t, v) {
    const d = CT.vehicle.gauge(); if (!d) return;
    const R = 56, y = v.isTouch ? 628 : 618, xl = 640 - 84, xr = 640 + 84;
    carDial(g, xl, y, R, d.rpm / 1000, 8, 1, 0.5, 6.5, 'RPM', 'x1000');
    carDial(g, xr, y, R, d.mph, 140, 20, 10, null, 'MPH');
    g.save();
    // gear, engine health, a stall countdown
    const gx = 640, gy = y + 8;
    g.fillStyle = 'rgba(8,8,10,0.85)'; g.strokeStyle = '#8a9098'; g.lineWidth = 2; g.beginPath(); g.rect(gx - 15, gy - 38, 30, 32); g.fill(); g.stroke();
    g.fillStyle = d.gear === 'R' ? '#ff6a4a' : '#f2e4c8'; g.font = 'bold 22px Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(d.gear, gx, gy - 21);
    const hw = 15, hp = clamp(d.hp, 0, 1);
    g.fillStyle = 'rgba(0,0,0,0.7)'; g.fillRect(gx - hw, gy + 2, hw * 2, 7);
    g.fillStyle = hp < 0.35 ? (Math.sin(t * 8) > 0 ? '#ff3a2a' : '#8a1a12') : '#7fc8e2'; g.fillRect(gx - hw + 1, gy + 3, (hw * 2 - 2) * hp, 5);
    g.fillStyle = '#9aa0a8'; g.font = 'bold 10px Georgia, serif'; g.fillText('ENGINE', gx, gy + 18);
    if (d.stall > 0) { g.font = 'bold 20px Georgia, serif'; g.lineWidth = 4; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.fillStyle = Math.sin(t * 6) > 0 ? '#ff4a3a' : '#ffb0a0'; const s = `STALLED  ${Math.ceil(d.stall)}`; g.strokeText(s, 640, y - R - 20); g.fillText(s, 640, y - R - 20); }
    if (!v.isTouch) {
      g.font = '13px Georgia, serif'; g.fillStyle = 'rgba(236,224,200,0.85)'; g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.8)';
      const s = 'E exit    V view    SPACE handbrake    SHIFT floor it    H horn';
      g.strokeText(s, 640, y + R + 20); g.fillText(s, 640, y + R + 20);
    }
    g.restore();
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  function draw(g, t, v) {
    if (!v) return;
    const dt = clamp(t - S.lastT, 0, 0.1); S.lastT = t;
    if (v.state !== S.state) {
      S.state = v.state; S.stateT = t; S.settings = false; S.mouse = false;
      S.sel = v.state === 'TITLE' && v.saveExists ? 1 : 0;
      if (v.state === 'INVENTORY') S.invScroll = 0;
    }
    g.save(); g.lineCap = 'butt'; g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; g.imageSmoothingEnabled = true;
    switch (v.state) {
      case 'GATE': drawGate(g, t, v, dt); break;
      case 'TITLE': drawTitle(g, t, v, dt); break;
      case 'PLAY':
        drawHurt(g, t, v); if (!carOn()) drawCross(g, t); drawCompass(g, t, v); drawQuest(g, t, v); drawBars(g, t, v, dt); drawBoss(g, t, v, dt); drawPrompt(g, t, v); drawNotes(g, t, v);
        if (carOn()) drawCarGauge(g, t, v);
        if (!MB.done) mapStep(0.6);
        break;
      case 'PAUSE': drawPause(g, t, v); break;
      case 'INVENTORY': drawInventory(g, t, v); break;
      case 'MAP': drawMap(g, t, v); break;
      case 'DIALOG': drawDialog(g, t, v); break;
      case 'DEAD': drawDead(g, t, v); break;
      case 'VICTORY': drawVictory(g, t, v, dt); break;
    }
    g.restore(); ls(g, 0);
  }

  function hit(x, y, v) {
    if (!v) return null;
    const pick = btns => { for (const b of btns) if (!b.dis && inside(b, x, y)) return b; return null; };
    if (S.settings && (v.state === 'TITLE' || v.state === 'PAUSE')) { const b = pick(setBtns()); if (b) { S.sel = b.row; return setAct(b.id); } return null; }
    let b = null;
    switch (v.state) {
      case 'GATE': b = pick(gateBtns()); break;
      case 'TITLE': b = pick(titleBtns(v)); break;
      case 'PAUSE': b = pick(pauseBtns()); break;
      case 'MAP': b = pick([MAP_CLOSE]); break;
      case 'DEAD': if (S.lastT - S.stateT >= 2) b = pick([DEAD_B]); break;
      case 'VICTORY': if (S.lastT - S.stateT >= 3.6) b = pick([VIC_B]); break;
      case 'DIALOG': {
        const d = v.dialog; if (!d) return null;
        dlgState(d, S.lastT);
        if (!S.tw.done) { S.tw.done = true; return null; }
        b = pick(dlgBtns(d)); break;
      }
      case 'INVENTORY': {
        const { btns, R } = invBtns(v);
        b = pick(btns);
        if (b && b.scroll) { S.invScroll += b.scroll * 180; return null; }
        if (b && b.tab) { S.invTab = b.tab; S.invScroll = 0; S.invSel = null; return null; }
        if (b && stashAct(b.act)) return null;
        if (!b) {
          if (x >= INV.lx && x <= INV.lx + INV.lw && y >= INV.ly && y <= INV.ly + INV.lh) {
            const r = R.rows.find(r => r.id && y >= INV.ly + r.y - S.invScroll && y <= INV.ly + r.y - S.invScroll + r.h); if (r) S.invSel = r.id;
          }
          const eq = equippedIds(v); [0, 1, 2].forEach(i => { if (eq[i] && x >= 58 + i * 114 && x <= 158 + i * 114 && y >= 482 && y <= 582) S.invSel = eq[i]; });
          return null;
        }
        break;
      }
      default: return null;
    }
    if (!b) return null;
    return finish(b.act);
  }
  function finish(act) {
    if (!act) return null;
    if (act.type === 'setting' && act.key === 'panel') { S.settings = act.value === 'open'; S.sel = 0; }
    if (act.type === 'gateYes' || act.type === 'newGame' || act.type === 'continue') applyVolSoon();
    return Object.assign({}, act);
  }

  function key(e, v) {
    if (!v || !e) return null;
    const k = e.key, up = k === 'ArrowUp' || k === 'w' || k === 'W', dn = k === 'ArrowDown' || k === 's' || k === 'S';
    const lf = k === 'ArrowLeft' || k === 'a' || k === 'A', rt = k === 'ArrowRight' || k === 'd' || k === 'D', ok = k === 'Enter' || k === ' ';
    S.mouse = false;
    if (S.settings) {
      if (up) S.sel = (S.sel + 3) % 4; else if (dn) S.sel = (S.sel + 1) % 4;
      else if (lf || rt) { if (S.sel === 0) return setAct(rt ? 'volP' : 'volM'); if (S.sel === 1) return setAct(rt ? 'senP' : 'senM'); if (S.sel === 2) return setAct('inv'); }
      else if (ok) { if (S.sel === 2) return setAct('inv'); if (S.sel === 3) return setAct('back'); }
      else if (k === 'Escape') return setAct('back');
      return null;
    }
    switch (v.state) {
      case 'GATE': case 'TITLE': case 'PAUSE': {
        const B = menuBtns(v), n = B.length;
        if (up || (v.state === 'GATE' && lf)) S.sel = (S.sel + n - 1) % n;
        else if (dn || (v.state === 'GATE' && rt)) S.sel = (S.sel + 1) % n;
        else if (ok) return finish(B[clamp(S.sel, 0, n - 1)].act);
        else if (k === 'Escape' && v.state === 'PAUSE') return { type: 'resume' };
        return null;
      }
      case 'MAP': return (k === 'Escape' || k === 'm' || k === 'M' || ok) ? { type: 'resume' } : null;
      case 'DEAD': return ok && S.lastT - S.stateT >= 2 ? { type: 'respawn' } : null;
      case 'VICTORY': return ok && S.lastT - S.stateT >= 3.6 ? { type: 'quitTitle' } : null;
      case 'INVENTORY': {
        if (k === 'Escape' || k === 'Tab' || k === 'i' || k === 'I') return { type: 'resume' };
        if ((k === 'ArrowLeft' || k === 'ArrowRight' || k === 'c' || k === 'C') && compOwned()) { S.invTab = compTab() ? 'pack' : 'comp'; S.invScroll = 0; S.invSel = null; return null; }
        if ((k === 'g' || k === 'G') && !compTab() && compOwned()) { stashAct({ type: 'stash', id: S.invSel }); return null; }
        const R = invRows(v), ids = R.ids; if (!ids.length) return null;
        let i = Math.max(0, ids.indexOf(invSelected(v, R)));
        if (up) i = (i + ids.length - 1) % ids.length; else if (dn) i = (i + 1) % ids.length;
        else if (ok) { const a = invAction(v, S.invSel); if (a && stashAct(a.act)) return null; return a && !a.dis ? Object.assign({}, a.act) : null; }
        S.invSel = ids[i];
        const row = R.rows.find(r => r.id === S.invSel);
        if (row) { if (row.y - 34 < S.invScroll) S.invScroll = Math.max(0, row.y - 34); if (row.y + row.h > S.invScroll + INV.lh) S.invScroll = row.y + row.h - INV.lh; }
        return null;
      }
      case 'DIALOG': {
        const d = v.dialog; if (!d) return null;
        dlgState(d, S.lastT);
        const B = dlgBtns(d);
        if (/^[1-9]$/.test(k)) { const b = B[+k - 1]; if (b) { S.tw.done = true; return Object.assign({}, b.act); } return null; }
        if (k === 'Escape') return { type: 'close' };
        if (!S.tw.done) { if (ok) S.tw.done = true; return null; }
        if (up) S.dlgSel = (S.dlgSel + B.length - 1) % B.length; else if (dn) S.dlgSel = (S.dlgSel + 1) % B.length;
        else if (ok) return Object.assign({}, B[clamp(S.dlgSel, 0, B.length - 1)].act);
        else if (k === 'Escape') return { type: 'close' };
        return null;
      }
    }
    return null;
  }

  // Test hook: the clickable rects of the current screen.
  function _btns(v) {
    if (S.settings) return setBtns();
    if (v.state === 'DIALOG') return v.dialog ? dlgBtns(v.dialog) : [];
    if (v.state === 'INVENTORY') return invBtns(v).btns;
    return menuBtns(v);
  }
  CT.ui = { draw, hit, key, _btns };
})();
