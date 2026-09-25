// ─── AUDIO: dark epic score + visceral sfx, all synthesised at runtime ───────
// No files, no network. Crash-safety (engine from Castle Quest): no onended callbacks;
// every music section and every sfx plays into its own GainNode bus that a setTimeout
// disconnects after its tail; a look-ahead scheduler (250 ms tick, 2 s horizon) drops
// stale notes after a stall; voice caps (64 music, 32 sfx); heavy instruments and all
// gore / foley are baked once into a small 32 kHz AudioBuffer cache; limiter + soft clip.
window.CT = window.CT || {};
(function () {
  const AC = window.AudioContext || window.webkitAudioContext;
  const LOOK = 2.0, TICK = 250, TAIL = 4.5, CAP_M = 64, CAP_S = 32, BSR = 0;   // BSR 0 = bake busy voices at the context rate (6x cheaper playback than resampled)
  const hz = m => 440 * Math.pow(2, (m - 69) / 12);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rr = (a, b) => a + Math.random() * (b - a);
  // k-rate params: coefficients once per 128-sample block (about 3x cheaper filters and oscillators).
  const KR = p => { try { p.automationRate = 'k-rate'; } catch (e) { } return p; };
  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => {
      s = (s + 0x6D2B79F5) >>> 0; let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const hash = s => { let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };

  // ── Modes (degree 0 = tonic; 7 = octave) ───────────────────────────────────
  const MODE = { phr: [0, 1, 3, 5, 7, 8, 10], aeo: [0, 2, 3, 5, 7, 8, 10], dor: [0, 2, 3, 5, 7, 9, 10] };
  const dm = (mode, root, d) => root + 12 * Math.floor(d / 7) + mode[((d % 7) + 7) % 7];
  const lift = (ms, lo) => { while (Math.min.apply(null, ms) < lo) ms = ms.map(m => m + 12); return ms; };

  // ── Per-context caches (buffers, waves, shaper curves) ─────────────────────
  const store = new WeakMap();
  function cacheOf(ctx) { let c = store.get(ctx); if (!c) store.set(ctx, c = { buf: new Map(), wave: {}, curve: {} }); return c; }
  function mkBuf(ctx, key, secs, fill, ch, rate) {
    const c = cacheOf(ctx).buf, hit = c.get(key);
    if (hit) { c.delete(key); c.set(key, hit); return hit; }
    const sr = rate ? Math.min(rate, ctx.sampleRate) : ctx.sampleRate, b = ctx.createBuffer(ch || 1, Math.max(1, Math.floor(secs * sr)), sr);
    for (let k = 0; k < (ch || 1); k++) fill(b.getChannelData(k), sr, k);
    c.set(key, b); if (c.size > 240) c.delete(c.keys().next().value);
    return b;
  }
  function normalize(d, peak) { let m = 0; for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i])); if (m > 0) for (let i = 0; i < d.length; i++) d[i] *= peak / m; }
  function fadeEnds(d, sr, fin, fout) {
    const a = Math.floor(fin * sr), b = Math.floor(fout * sr);
    for (let i = 0; i < a && i < d.length; i++) d[i] *= i / a;
    for (let i = 0; i < b && i < d.length; i++) d[d.length - 1 - i] *= i / b;
  }
  const sat = (d, k) => { const n = Math.tanh(k); for (let i = 0; i < d.length; i++) d[i] = Math.tanh(d[i] * k) / n; return d; };
  // RBJ biquad over an array (static filters for baking).
  function biq(d, sr, type, f, q) {
    const w = 2 * Math.PI * Math.min(f, sr * 0.45) / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
    let b0, b1, b2; const a0 = 1 + al, a1 = -2 * cs, a2 = 1 - al;
    if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; }
    else if (type === 'lp') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; }
    else { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; }
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < d.length; i++) {
      const x = d[i], y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
      x2 = x1; x1 = x; y2 = y1; y1 = y; d[i] = y;
    }
    return d;
  }
  // Chamberlin state-variable band-pass with a moving cutoff (wet formant sweeps).
  function svf(x, sr, fc, q) {
    const y = new Float32Array(x.length), qd = 1 / q; let lo = 0, bp = 0;
    for (let i = 0; i < x.length; i++) {
      const f = 2 * Math.sin(Math.PI * clamp(fc(i / sr), 20, sr / 7) / sr);
      const hi = x[i] - lo - qd * bp; bp += f * hi; lo += f * bp; y[i] = bp;
    }
    return y;
  }
  // Decaying sine partials (modal resonator): parts = [[ratio, amp, t60]].
  function modal(d, sr, off, f0, parts, tsc, amp) {
    parts.forEach(([ratio, a, t60]) => {
      const f = f0 * ratio; if (f > sr * 0.45) return;
      const w = 2 * Math.PI * f / sr, c2 = 2 * Math.cos(w), k = Math.exp(-6.9 / (t60 * tsc * sr));
      let s1 = Math.sin(-w), s2 = Math.sin(-2 * w), e = a * amp;
      for (let i = off; i < d.length && e > 1e-5; i++) { const s = c2 * s1 - s2; s2 = s1; s1 = s; d[i] += s * e; e *= k; }
    });
  }
  const white = (n, seed) => { const r = rng(seed), d = new Float32Array(n); for (let i = 0; i < n; i++) d[i] = r() * 2 - 1; return d; };
  const noiseBuf = ctx => mkBuf(ctx, 'noise', 2, (d) => d.set(white(d.length, 99)));
  // A seamless loop: render secs + 0.3 s, crossfade the overhang into the head.
  function loopBuf(ctx, key, secs, gen, rate) {
    return mkBuf(ctx, key, secs, (d, sr) => {
      const n = d.length, X = Math.floor(0.3 * sr), e = new Float32Array(n + X); gen(e, sr);
      for (let i = 0; i < n; i++) d[i] = e[i];
      for (let i = 0; i < X; i++) { const a = i / X; d[i] = e[i] * Math.sqrt(a) + e[n + i] * Math.sqrt(1 - a); }
    }, 1, rate || BSR);
  }

  // ── Baked instruments: harp, lute, staccato low strings, bells ─────────────
  function ksBuf(ctx, m, kind) {
    const harp = kind === 'harp';
    return mkBuf(ctx, kind + m, harp ? 3.0 : 1.8, (y, sr) => {
      const f = hz(m), dec = (harp ? 2.8 : 1.4) * clamp(Math.sqrt(220 / f), 0.45, 1.6);
      const D = sr / f - 0.5, E = Math.max(2, Math.round(D)), g = Math.pow(0.001, 1 / (dec * f));
      const r = rng(m * 131 + (harp ? 7 : 3)), x = new Float32Array(E), a = harp ? 0.5 : 0.38;
      let lp = 0; for (let i = 0; i < E; i++) { lp += a * ((r() * 2 - 1) - lp); x[i] = lp; }
      const pp = Math.max(1, Math.round(E * (harp ? 0.13 : 0.22))), xc = x.slice();
      for (let i = pp; i < E; i++) x[i] = xc[i] - xc[i - pp];
      const at = q => { if (q < 0) return 0; const k = q | 0, fr = q - k; return y[k] + (y[k + 1] - y[k]) * fr; };
      for (let i = 0; i < y.length; i++) y[i] = (i < E ? x[i] : 0) + g * 0.5 * (at(i - D) + at(i - D - 1));
      biq(y, sr, 'lp', harp ? 4200 : 3000, 0.7);
      normalize(y, 0.5); fadeEnds(y, sr, 0.001, 0.3);
    }, 1, 32000);
  }
  function strBuf(ctx, m) {   // staccato bowed low strings: 3 detuned saws, bow scrape, fast decay
    return mkBuf(ctx, 'str' + m, 0.5, (d, sr) => {
      const f = hz(m), r = rng(m * 7 + 1), ph = [r(), r(), r()], det = [1, 1.0062, 0.9951], nz = biq(white(d.length, m), sr, 'bp', 1800, 0.8);
      for (let i = 0; i < d.length; i++) {
        const t = i / sr; let s = 0;
        for (let k = 0; k < 3; k++) { ph[k] += f * det[k] / sr; ph[k] -= Math.floor(ph[k]); s += 2 * ph[k] - 1; }
        d[i] = (s / 3 + nz[i] * 0.35 * Math.exp(-t * 25)) * Math.min(1, t / 0.006) * Math.exp(-t * 6.5);
      }
      biq(d, sr, 'lp', 1500, 0.9); biq(d, sr, 'lp', 2600, 0.7);
      normalize(d, 0.5); fadeEnds(d, sr, 0.001, 0.06);
    }, 1, BSR);
  }
  const BELL = [[0.5, .35, 1.3], [1, 1, 1], [1.19, .4, .7], [1.5, .3, .6], [2, .45, .5], [2.51, .25, .35], [2.66, .2, .3], [3.01, .16, .25], [4.17, .1, .18], [5.43, .05, .12]];
  const CHIME = [[1, 1, 1], [2.76, .35, .45], [5.4, .15, .22], [8.93, .06, .12]];
  function bellBuf(ctx, m, kind) {
    const ch = kind === 'chime', base = ch ? 1.5 : 3.6;
    return mkBuf(ctx, kind + m, base + 0.4, (d, sr) => {
      const f0 = hz(m), sc = clamp(Math.sqrt(700 / f0), 0.4, 1.6) * base;
      modal(d, sr, 0, f0, ch ? CHIME : BELL, sc, 1); modal(d, sr, 0, f0 * 1.0021, ch ? CHIME : BELL, sc, 0.45);
      const n = biq(white(Math.floor(sr * 0.004), m), sr, 'hp', 3000, 0.7);
      for (let i = 0; i < n.length; i++) d[i] += n[i] * 0.15 * (1 - i / n.length);
      normalize(d, 0.5); fadeEnds(d, sr, 0.0015, 0.2);
    }, 1, 32000);
  }

  // ── Baked war percussion: taiko big/mid, shime, stick, gong, anvil, click ──
  const DLEN = { K: 1.7, k: 1.0, h: 0.4, x: 0.25, g: 5.0, a: 0.8, wood: 0.3 };
  function drumBuf(ctx, kind) {
    return mkBuf(ctx, 'dr' + kind, DLEN[kind] || 0.5, (d, sr) => {
      const n = d.length, nz = white(n, kind.charCodeAt(0) * 17 + 3);
      if (kind === 'K' || kind === 'k') {   // taiko: pitch-dropping membrane + skin slap + weight
        const big = kind === 'K', f0 = big ? 44 : 78, fd = big ? 70 : 95, dec = big ? 3.0 : 5.5;
        const sk = biq(biq(nz.slice(), sr, 'lp', big ? 900 : 1500, 0.7), sr, 'hp', 120, 0.7); let ph = 0;
        for (let i = 0; i < n; i++) {
          const t = i / sr; ph += 2 * Math.PI * (f0 + fd * Math.exp(-t * (big ? 16 : 24))) / sr;
          d[i] = Math.sin(ph) * Math.exp(-t * dec) + 0.35 * Math.sin(ph * 1.52 + 1) * Math.exp(-t * dec * 2.3) + 0.18 * Math.sin(ph * 2.26) * Math.exp(-t * dec * 4) + sk[i] * 0.9 * Math.exp(-t * 38);
        }
        sat(d, 1.6);
      } else if (kind === 'h') {
        const sn = biq(nz.slice(), sr, 'bp', 2600, 0.9); let ph = 0;
        for (let i = 0; i < n; i++) { const t = i / sr; ph += 2 * Math.PI * (210 + 70 * Math.exp(-t * 40)) / sr; d[i] = Math.sin(ph) * Math.exp(-t * 17) + sn[i] * 1.3 * Math.exp(-t * 45); }
      } else if (kind === 'x' || kind === 'wood') {
        const cl = biq(nz.slice(), sr, 'bp', kind === 'x' ? 2400 : 1600, 1.5), f1 = kind === 'x' ? 820 : 520;
        for (let i = 0; i < n; i++) { const t = i / sr; d[i] = Math.sin(2 * Math.PI * f1 * t) * Math.exp(-t * 60) + 0.45 * Math.sin(2 * Math.PI * f1 * 1.63 * t) * Math.exp(-t * 90) + cl[i] * 1.2 * Math.exp(-t * 180); }
      } else if (kind === 'g') {   // tam-tam: inharmonic swell + shimmer
        modal(d, sr, 0, 72, [[1, 1, 3.5], [1.47, .7, 3], [2.09, .6, 2.6], [2.56, .5, 2.2], [3.33, .35, 2], [4.2, .3, 1.6], [5.9, .2, 1.2], [7.6, .15, 1]], 1, 1);
        const sh = biq(biq(nz.slice(), sr, 'bp', 3500, 0.6), sr, 'lp', 7000, 0.7);
        for (let i = 0; i < n; i++) { const t = i / sr; d[i] = d[i] * (0.5 + 0.5 * Math.min(1, t / 0.25)) + sh[i] * 0.5 * Math.min(1, t / 0.4) * Math.exp(-t * 1.1); }
      } else if (kind === 'a') {   // anvil
        modal(d, sr, 0, 1180, [[1, 1, .5], [2.43, .6, .35], [3.9, .4, .25], [5.8, .2, .15]], 1, 1);
        const cl = biq(nz.slice(), sr, 'hp', 4000, 0.7); for (let i = 0; i < 200 && i < n; i++) d[i] += cl[i] * 0.6 * (1 - i / 200);
      }
      normalize(d, 0.5); fadeEnds(d, sr, 0.0008, 0.05);
    }, 1, BSR);
  }

  // ── Baked gore + foley (4 variants each) ───────────────────────────────────
  const GLEN = { flesh: .45, bone: .34, splat: .7, spurt: 1.0, slice: .3, clang: 1.2, ring: 2.2, coin: .7, glug: .25 };
  function goreBuf(ctx, kind, v) {
    return mkBuf(ctx, 'g' + kind + v, GLEN[kind], (d, sr) => {
      const n = d.length, seed = hash(kind) + v * 101, r = rng(seed), nz = white(n, seed);
      if (kind === 'flesh') {   // wet meaty impact: pitched thump + damp body + squelch sweep
        const lo = biq(nz.slice(), sr, 'lp', 480 + v * 90, 0.8), wob = 16 + v * 5;
        const sq = svf(nz, sr, t => 320 + 1700 * Math.exp(-t * 16) * (1 + 0.3 * Math.sin(2 * Math.PI * wob * t)), 4.5); let ph = 0;
        for (let i = 0; i < n; i++) {
          const t = i / sr; ph += 2 * Math.PI * (52 + v * 7 + 70 * Math.exp(-t * 32)) / sr;
          d[i] = Math.sin(ph) * Math.exp(-t * 15) + lo[i] * 2.2 * Math.exp(-t * 24) + sq[i] * 2.6 * Math.exp(-t * 8) * Math.min(1, t / 0.004);
        }
        sat(d, 1.8);
      } else if (kind === 'bone') {   // crackly snap: click train + dry knock + splinter noise
        const hi = biq(nz.slice(), sr, 'hp', 2200, 0.7), cr = biq(white(n, seed + 1), sr, 'bp', 1700 + v * 300, 1.3);
        let t0 = 0, a = 1;
        for (let k = 0, K = 9 + v * 3; k < K && t0 < 0.14; k++) {
          const s0 = Math.floor(t0 * sr), L = 20 + Math.floor(r() * 70);
          for (let i = 0; i < L && s0 + i < n; i++) d[s0 + i] += hi[s0 + i] * a * 2.2 * Math.exp(-i / (L * 0.3));
          t0 += 0.001 + r() * (k < 3 ? 0.004 : 0.012); a *= 0.72 + r() * 0.3;
        }
        for (let i = 0; i < n; i++) { const t = i / sr; d[i] += Math.sin(2 * Math.PI * (150 + v * 22) * t) * 0.8 * Math.exp(-t * 45) + cr[i] * 1.4 * Math.exp(-t * 26); }
        sat(d, 1.4);
      } else if (kind === 'splat') {   // liquid splat: fast formant motion + weight + droplets
        const wob = 20 + v * 7, sp = svf(nz, sr, t => 380 + 2300 * Math.exp(-t * 9) * (1 + 0.38 * Math.sin(2 * Math.PI * wob * t)), 3), lo = biq(nz.slice(), sr, 'lp', 340, 0.8);
        for (let i = 0; i < n; i++) { const t = i / sr; d[i] = (sp[i] * 2.6 * Math.exp(-t * 6.5) + lo[i] * 2 * Math.exp(-t * 18)) * Math.min(1, t / 0.003); }
        for (let k = 0, K = 4 + v; k < K; k++) {
          const s0 = Math.floor((0.05 + r() * 0.45) * sr), f0 = 450 + r() * 600; let ph = 0;
          for (let i = 0; s0 + i < n && i < sr * 0.05; i++) { const t = i / sr; ph += 2 * Math.PI * f0 * (1 + 1.4 * Math.min(1, t / 0.012)) / sr; d[s0 + i] += Math.sin(ph) * 0.35 * (0.4 + r() * 0.1) * Math.exp(-t * 70); }
        }
      } else if (kind === 'spurt') {   // arterial pulses: pressure hiss + gurgle
        const P = [0, 0.2 + r() * 0.04, 0.42 + r() * 0.05], env = t => P.reduce((s, p, k) => s + (t >= p ? Math.min(1, (t - p) / 0.02) * Math.exp(-(t - p) * 7) * (1 - k * 0.27) : 0), 0);
        const hs = svf(nz, sr, t => 900 + 1400 * env(t), 1.6), gl = biq(white(n, seed + 5), sr, 'lp', 520, 1.2);
        for (let i = 0; i < n; i++) { const t = i / sr, e = env(t); d[i] = hs[i] * 1.8 * e + gl[i] * 2.4 * e * (0.6 + 0.4 * Math.sin(2 * Math.PI * 38 * t)); }
      } else if (kind === 'slice') {   // blade through meat: fast bright sweep + faint ring
        const sw = svf(nz, sr, t => 4400 - 2600 * Math.min(1, t / 0.1), 2.2);
        for (let i = 0; i < n; i++) { const t = i / sr; d[i] = sw[i] * 2 * Math.min(1, t / 0.006) * Math.exp(-t * 22); }
        modal(d, sr, 0, 3100 + v * 240, [[1, .12, .25], [1.53, .06, .18]], 1, 1);
      } else if (kind === 'clang') {   // metal on metal
        modal(d, sr, 0, 480 + v * 70, [[1, 1, .6], [1.47, .8, .5], [2.09, .7, .42], [2.56, .55, .35], [3.12, .45, .3], [4.21, .3, .22], [5.4, .25, .16], [6.9, .15, .12]], 1, 1);
        const cl = biq(nz.slice(), sr, 'bp', 3200, 0.8); for (let i = 0; i < n; i++) d[i] += cl[i] * 1.6 * Math.exp(-i / sr * 90);
      } else if (kind === 'ring') {   // a parry that sings
        const f0 = 1180 + v * 90; modal(d, sr, 0, f0, [[1, 1, 1.8], [2.76, .5, 1.1], [5.4, .25, .6], [8.93, .1, .35]], 1, 1);
        modal(d, sr, 0, f0 * 1.004, [[1, .7, 1.8]], 1, 1);
        const cl = biq(nz.slice(), sr, 'hp', 3000, 0.7); for (let i = 0; i < n; i++) d[i] += cl[i] * 0.8 * Math.exp(-i / sr * 120);
      } else if (kind === 'coin') {   // three to five coins
        for (let k = 0, K = 3 + v % 3; k < K; k++) modal(d, sr, Math.floor((k * 0.06 + r() * 0.03) * sr), 2600 + r() * 1400, [[1, 1, .18], [2.71, .5, .12], [5.1, .2, .08]], 1, 0.8 - k * 0.1);
      } else if (kind === 'glug') {
        let ph = 0; const f0 = 260 + v * 40;
        for (let i = 0; i < n; i++) { const t = i / sr; ph += 2 * Math.PI * f0 * (1 + 1.3 * Math.min(1, t / 0.06)) / sr; d[i] = Math.sin(ph) * Math.exp(-t * 22) * Math.min(1, t / 0.01) + nz[i] * 0.08 * Math.exp(-t * 30); }
        biq(d, sr, 'lp', 1400, 0.8);
      }
      normalize(d, 0.6); fadeEnds(d, sr, 0.0005, 0.04);
    }, 1, BSR);
  }
  // Footsteps per surface: soft (grass), dirt, snow (crunch), mud (squelch), stone.
  function stepBuf(ctx, s, v) {
    return mkBuf(ctx, 'st' + s + v, 0.3, (d, sr) => {
      const n = d.length, seed = hash(s) + v * 37, r = rng(seed), nz = white(n, seed);
      const thump = (f, a, k) => { for (let i = 0; i < n; i++) d[i] += Math.sin(2 * Math.PI * f * i / sr) * a * Math.exp(-i / sr * k); };
      const grit = (count, span, f, a) => {
        const hi = biq(white(n, seed + 9), sr, 'bp', f, 1.2);
        for (let k = 0; k < count; k++) { const s0 = Math.floor(r() * span * sr), L = 15 + Math.floor(r() * 50), g = a * (0.3 + r() * 0.7); for (let i = 0; i < L && s0 + i < n; i++) d[s0 + i] += hi[s0 + i] * g * Math.exp(-i / (L * 0.35)); }
      };
      if (s === 'soft') {
        const sw = biq(nz.slice(), sr, 'bp', 800 + v * 170, 0.7);
        for (let i = 0; i < n; i++) { const t = i / sr; d[i] = sw[i] * 1.3 * Math.min(1, t / 0.012) * Math.exp(-t * 22); }
        thump(70 + v * 6, 0.5, 40); grit(6, 0.08, 3200, 0.4);
      } else if (s === 'dirt') {
        const lo = biq(nz.slice(), sr, 'lp', 1100 + v * 120, 0.8);
        for (let i = 0; i < n; i++) d[i] = lo[i] * 2 * Math.exp(-i / sr * 32);
        thump(85 + v * 8, 0.55, 45); grit(10, 0.06, 2400, 0.8);
      } else if (s === 'snow') {
        grit(60 + v * 10, 0.14, 2100 + v * 250, 1.0);
        const lo = biq(nz.slice(), sr, 'lp', 600, 0.7); for (let i = 0; i < n; i++) d[i] += lo[i] * 1.2 * Math.min(1, i / sr / 0.03) * Math.exp(-i / sr * 20);
      } else if (s === 'mud') {
        const sq = svf(nz, sr, t => 250 + 1100 * Math.exp(-t * 20) * (1 + 0.3 * Math.sin(2 * Math.PI * (24 + v * 5) * t)), 4);
        for (let i = 0; i < n; i++) { const t = i / sr; d[i] = sq[i] * 2.4 * Math.min(1, t / 0.01) * Math.exp(-t * 11); }
        thump(60, 0.5, 30);
      } else {   // stone
        const lo = biq(nz.slice(), sr, 'lp', 520 + v * 110, 0.8), cl = biq(white(n, seed + 3), sr, 'bp', 2300 + v * 400, 2);
        for (let i = 0; i < n; i++) { const t = i / sr; d[i] = lo[i] * 2.2 * Math.exp(-t * 38) + cl[i] * 0.9 * Math.exp(-t * 120) + 0.4 * Math.sin(2 * Math.PI * (80 + v * 7) * t) * Math.exp(-t * 40); }
      }
      normalize(d, 0.5); fadeEnds(d, sr, 0.0008, 0.05);
    }, 1, BSR);
  }
  const SURF = { grass: 'soft', forest: 'soft', meadow: 'soft', hills: 'dirt', coast: 'dirt', dirt: 'dirt', snow: 'snow', swamp: 'mud', water: 'mud', mud: 'mud', citadel: 'stone', stone: 'stone' };
  // Loop beds: fire crackle, rain.
  const fireBuf = ctx => loopBuf(ctx, 'fire', 4, (d, sr) => {
    const n = d.length, r = rng(41), lo = biq(biq(white(n, 42), sr, 'lp', 260, 0.7), sr, 'lp', 400, 0.7), hs = biq(white(n, 43), sr, 'hp', 3500, 0.7), cr = biq(white(n, 44), sr, 'bp', 2600, 0.9);
    for (let i = 0; i < n; i++) { const t = i / sr; d[i] = lo[i] * 2.6 * (0.7 + 0.3 * Math.sin(t * 2.1 + Math.sin(t * 0.7) * 2)) + hs[i] * 0.05; }
    for (let t = 0; t < n / sr; t += -Math.log(1 - r() * 0.999) / 16) {
      const s0 = Math.floor(t * sr), L = 10 + Math.floor(r() * 120), a = Math.pow(r(), 2) * 1.5, pop = r() < 0.06;
      for (let i = 0; i < L && s0 + i < n; i++) d[s0 + i] += cr[s0 + i] * a * Math.exp(-i / (L * 0.3)) + (pop ? Math.sin(i * 0.05) * 0.5 * Math.exp(-i / 300) : 0);
    }
    normalize(d, 0.5);
  });
  const rainBuf = ctx => loopBuf(ctx, 'rain', 5, (d, sr) => {
    const n = d.length, r = rng(51), hs = biq(biq(white(n, 52), sr, 'lp', 5200, 0.7), sr, 'hp', 500, 0.7), dr = biq(white(n, 53), sr, 'bp', 3800, 1.5);
    for (let i = 0; i < n; i++) d[i] = hs[i] * 0.55;
    for (let t = 0; t < n / sr; t += -Math.log(1 - r() * 0.999) / 70) {
      const s0 = Math.floor(t * sr), L = 20 + Math.floor(r() * 90), a = 0.2 + r() * 0.6;
      for (let i = 0; i < L && s0 + i < n; i++) d[s0 + i] += dr[s0 + i] * a * Math.exp(-i / (L * 0.3));
    }
    normalize(d, 0.5);
  });
  // Reverb impulse: 2.8 s black-stone hall with a darkening tail (IR length is the main CPU cost).
  function impulse(ctx) {
    return mkBuf(ctx, 'ir', 2.8, (d, sr, ch) => {
      const r = rng(ch ? 991 : 373), pre = Math.floor(0.03 * sr); let lp = 0;
      for (let i = pre; i < d.length; i++) {
        const t = (i - pre) / sr, a = 0.04 + 0.5 * Math.exp(-t * 1.6);
        lp += a * ((r() * 2 - 1) - lp); d[i] = lp * Math.exp(-t * 2.1);
      }
      [0.011, 0.019, 0.029, 0.041, 0.053, 0.069, 0.087].forEach((x, k) => {
        const i = pre + Math.floor((x + (ch ? 0.0037 : 0)) * sr); if (i < d.length) d[i] += (r() > 0.5 ? 1 : -1) * 0.45 * (1 - k * 0.1);
      });
      fadeEnds(d, sr, 0, 0.3);
    }, 2);
  }

  // ── Live voices ────────────────────────────────────────────────────────────
  const WAVES = { gurdy: [0, 1, .45, .9, .3, .75, .25, .55, .2, .4, .15, .28, .1, .18, .07, .12] };
  function wave(ctx, name) {
    const c = cacheOf(ctx).wave; if (c[name]) return c[name];
    const im = Float32Array.from(WAVES[name]);
    return (c[name] = ctx.createPeriodicWave(new Float32Array(im.length), im));
  }
  function curve(ctx, amt) {   // tanh drive curve, cached per amount
    const c = cacheOf(ctx).curve, key = Math.round(amt * 20); if (c[key]) return c[key];
    const k = 1 + key, n = 1024, a = new Float32Array(n), m = Math.tanh(k);
    for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; a[i] = Math.tanh(x * k) / m * 0.9; }
    return (c[key] = a);
  }
  function outTo(g, node, pan) {
    if (pan && g.ctx.createStereoPanner) { const p = g.ctx.createStereoPanner(); p.pan.value = clamp(pan, -1, 1); node.connect(p); p.connect(g.out); }
    else node.connect(g.out);
  }
  function play(g, t, buf, lv, pan, rate) {
    const c = g.ctx, s = c.createBufferSource(), v = c.createGain();
    s.buffer = buf; if (rate) s.playbackRate.value = rate; v.gain.value = lv;
    s.connect(v); outTo(g, v, pan); s.start(t);
  }
  const PLUCK = {
    harp: (g, t, m, lv, pan) => play(g, t, ksBuf(g.ctx, m, 'harp'), lv, pan),
    lute: (g, t, m, lv, pan) => play(g, t, ksBuf(g.ctx, m, 'lute'), lv, pan),
    str: (g, t, m, lv, pan) => play(g, t, strBuf(g.ctx, m), lv, pan),
    bell: (g, t, m, lv, pan) => play(g, t, bellBuf(g.ctx, m, 'bell'), lv, pan),
    chime: (g, t, m, lv, pan) => play(g, t, bellBuf(g.ctx, m, 'chime'), lv, pan),
  };
  const DR = { K: .55, k: .32, h: .16, x: .12, g: .36, a: .09 };
  const drum = (g, t, k, lv, pan, rate) => play(g, t, drumBuf(g.ctx, k), lv, pan, rate);

  // Formants (F, gain) for a deep male voice; beasts scale them.
  const VOW = {
    ah: [[700, 1], [1150, .5], [2600, .18]], oh: [[480, 1], [820, .45], [2600, .1]], oo: [[330, 1], [700, .3], [2500, .06]],
    ee: [[300, .8], [2250, .5], [3000, .3]], eh: [[560, 1], [1750, .45], [2550, .2]], uh: [[620, 1], [1050, .45], [2500, .12]],
  };
  const FQ = [6, 8, 12];
  function formants(c, vowel, input, out, mul, fs) {
    VOW[vowel || 'ah'].forEach(([f, a], k) => {
      const b = c.createBiquadFilter(), g = c.createGain();
      b.type = 'bandpass'; b.frequency.value = f * (fs || 1); b.Q.value = FQ[k]; g.gain.value = a * mul;
      input.connect(b); b.connect(g); g.connect(out);
    });
  }
  // Male choir voice, baked per (note, vowel): 2 detuned band-limited saws with vibrato and breath
  // through the formant bank, as a 2 s seamless loop at 24 kHz (live, a chord cost 16% of a core).
  function choirBuf(ctx, m, vowel) {
    return loopBuf(ctx, 'ch' + vowel + m, 2, (d, sr) => {
      const f = hz(m), r = rng(m * 31 + vowel.charCodeAt(0)), n = d.length, vr = [4.5, 5, 5.5][m % 3], det = [-10, 9], ph = [r(), r()], x = new Float32Array(n), br = white(n, m + 7);
      const blep = (t, dt) => (t < dt ? (t /= dt, t + t - t * t - 1) : t > 1 - dt ? (t = (t - 1) / dt, t * t + t + t + 1) : 0);
      for (let i = 0; i < n; i++) {
        const t = i / sr; let v = 0;
        for (let k = 0; k < 2; k++) {
          const fk = f * Math.pow(2, (det[k] + Math.sin(2 * Math.PI * (vr + k * 0.5) * t + k * 2) * (9 + k * 3)) / 1200), dt = fk / sr;
          ph[k] += dt; ph[k] -= Math.floor(ph[k]); v += 2 * ph[k] - 1 - blep(ph[k], dt);
        }
        x[i] = v + br[i] * 0.05;
      }
      VOW[vowel].forEach(([F, a], k) => { const y = biq(x.slice(), sr, 'bp', F * 0.9, FQ[k]); for (let i = 0; i < n; i++) d[i] += y[i] * a * 0.5; });
      const lo = biq(biq(x.slice(), sr, 'lp', 300, 0.7), sr, 'lp', 300, 0.7); for (let i = 0; i < n; i++) d[i] += lo[i] * 0.1;
    }, 24000);
  }
  // A sung chord: one looping baked voice per note, a slow swell; shouts scoop up into the note.
  function choir(g, t, dur, ms, vowel, lv, pan, o) {
    o = o || {};
    const c = g.ctx, env = c.createGain(), rel = o.rel || 0.5, stop = t + dur + rel * 5 + 0.05;
    const att = o.att || clamp(dur * 0.35, 0.35, 1.6), a = lv / Math.sqrt(ms.length * 2);
    ms.forEach(m => {
      const s = c.createBufferSource(); s.buffer = choirBuf(c, m, vowel); s.loop = true;
      if (o.scoop) { s.playbackRate.setValueAtTime(0.9, t); s.playbackRate.linearRampToValueAtTime(1, t + 0.07); }
      s.connect(env); s.start(t, Math.random() * 1.9); s.stop(stop);
    });
    if (o.breath) { const n = noiseThrough(g, t, 0.3, 'bandpass', 1.2, pan); n.f.value = 1400; n.v.setValueAtTime(lv * o.breath * 2, t); n.v.setTargetAtTime(0, t + 0.02, 0.05); }
    env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(a * 0.8, t + att);
    env.gain.linearRampToValueAtTime(a, t + Math.max(att + 0.05, dur * 0.6));
    env.gain.setTargetAtTime(0, t + dur, rel);
    outTo(g, env, pan);
  }
  // Brass / organ chord pad: saw pairs through a swelling low-pass.
  function horns(g, t, dur, ms, lv, organ) {
    const c = g.ctx, env = c.createGain(), lp = c.createBiquadFilter(), stop = t + dur + 3;
    lp.type = 'lowpass'; lp.Q.value = 1.3; KR(lp.frequency);
    lp.frequency.setValueAtTime(200, t); lp.frequency.linearRampToValueAtTime(organ ? 1500 : 850, t + Math.min(dur * 0.5, 2.5)); lp.frequency.linearRampToValueAtTime(organ ? 1000 : 420, t + dur);
    ms.forEach((m, i) => [[-7, 'sawtooth', 1]].concat(i < 2 ? [[7, 'sawtooth', 1]] : organ ? [[1200, 'square', 0.4]] : []).forEach(([dt, ty, a]) => {
      const x = c.createOscillator(), k = c.createGain(); x.type = ty; x.frequency.value = hz(m); x.detune.value = dt; k.gain.value = a;
      x.connect(k); k.connect(lp); x.start(t); x.stop(stop);
    }));
    const a = lv / Math.sqrt(ms.length * 2);
    env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(a, t + Math.min(dur * 0.4, 1.8)); env.gain.setTargetAtTime(0, t + dur, 0.6);
    lp.connect(env); outTo(g, env, 0);
  }
  // Brass stab: a hard-attack power chord with a snapping filter.
  function stab(g, t, ms, lv, dur) {
    const c = g.ctx, env = c.createGain(), lp = c.createBiquadFilter(), stop = t + dur + 0.8;
    lp.type = 'lowpass'; lp.Q.value = 2.5; KR(lp.frequency).setValueAtTime(3200, t); lp.frequency.setTargetAtTime(480, t + 0.02, 0.09);
    ms.forEach(m => [-9, 9].forEach(dt => { const x = c.createOscillator(); x.type = 'sawtooth'; x.frequency.value = hz(m); x.detune.value = dt; x.connect(lp); x.start(t); x.stop(stop); }));
    env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(lv / Math.sqrt(ms.length * 2), t + 0.01); env.gain.setTargetAtTime(0, t + dur, 0.08);
    lp.connect(env); outTo(g, env, 0);
  }
  // Riser: a swelling noise sweep into the next downbeat.
  function riser(g, t, dur, lv) {
    const n = noiseThrough(g, t, dur + 0.05, 'bandpass', 2, 0);
    n.f.setValueAtTime(250, t); n.f.exponentialRampToValueAtTime(3500, t + dur);
    n.v.setValueAtTime(0.0001, t); n.v.exponentialRampToValueAtTime(lv, t + dur - 0.02); n.v.linearRampToValueAtTime(0, t + dur + 0.04);
  }

  // Legato phrase voices: one oscillator set glides through a whole phrase.
  const LEAD = {
    cello: { w: 'sawtooth', lp: 1300, glide: .04, vib: 14, vr: 5.2, att: .09, dip: .72, rel: .3, chiff: .1, cf: 900, dual: 4 },
    gurdy: { w: 'gurdy', lp: 2500, glide: .015, vib: 6, vr: 6, att: .03, dip: .55, rel: .12, chiff: .28, cf: 2200, dual: 6 },
    brass: { w: 'sawtooth', lp: 850, glide: .02, vib: 5, vr: 5, att: .05, dip: .4, rel: .14, blat: 1, dual: 6 },
    cantor: { w: 'sawtooth', glide: .06, vib: 18, vr: 5, att: .08, dip: .8, rel: .25, dual: 10, form: 1 },
  };
  const LEAD_LV = { cello: .16, gurdy: .085, brass: .13, cantor: .24 };
  function lead(g, inst, notes, lv, pan, vowel) {
    const c = g.ctx, I = LEAD[inst]; if (!I || !notes.length) return;
    const t0 = notes[0].t, last = notes[notes.length - 1], end = last.t + last.d, stop = end + I.rel * 8 + 0.2;
    lv *= LEAD_LV[inst];
    const env = c.createGain(), src = c.createGain(), vo = c.createGain();
    const lfo = c.createOscillator(), vg = c.createGain();
    lfo.frequency.value = I.vr * (0.95 + Math.random() * 0.1); vg.gain.value = 0; lfo.connect(vg); lfo.start(t0); lfo.stop(stop);
    const dets = I.dual ? [-I.dual, I.dual] : [0];
    const oscs = dets.map(dt => {
      const o = c.createOscillator();
      if (WAVES[I.w]) o.setPeriodicWave(wave(c, I.w)); else o.type = I.w;
      KR(o.frequency); KR(o.detune).value = dt; vg.connect(o.detune); o.connect(src); o.start(t0); o.stop(stop); return o;
    });
    src.gain.value = 1 / dets.length;
    let filt = null;
    if (I.form) formants(c, vowel || 'ah', src, env, 2.6, 0.9);
    else { filt = c.createBiquadFilter(); filt.type = 'lowpass'; KR(filt.frequency).value = I.lp; filt.Q.value = I.blat ? 2 : 0.9; src.connect(filt); filt.connect(env); }
    let cg = null;
    if (I.chiff) {
      const ns = c.createBufferSource(), bp = c.createBiquadFilter(); cg = c.createGain();
      ns.buffer = noiseBuf(c); ns.loop = true; bp.type = 'bandpass'; bp.frequency.value = I.cf; bp.Q.value = 0.9; cg.gain.value = 0;
      ns.connect(bp); bp.connect(cg); cg.connect(vo); ns.start(t0, Math.random()); ns.stop(stop);
    }
    env.gain.setValueAtTime(0, t0);
    notes.forEach((n, i) => {
      const f = hz(n.m), nx = notes[i + 1], a = lv * (i === 0 ? 1 : 0.9);
      oscs.forEach(o => (i === 0 ? o.frequency.setValueAtTime(f, t0) : o.frequency.setTargetAtTime(f, n.t - 0.004, I.glide)));
      env.gain.setTargetAtTime(a, n.t, I.att);
      if (nx) env.gain.setTargetAtTime(a * I.dip, Math.max(n.t + 0.02, n.t + n.d - 0.05), 0.014);
      const depth = I.vib * (n.d > 0.45 ? 1 : 0.35);
      vg.gain.setValueAtTime(depth * 0.2, n.t); vg.gain.linearRampToValueAtTime(depth, n.t + Math.min(0.5, n.d * 0.8));
      if (cg) { cg.gain.setValueAtTime(0, n.t); cg.gain.linearRampToValueAtTime(lv * I.chiff, n.t + 0.01); cg.gain.setTargetAtTime(lv * I.chiff * 0.25, n.t + 0.012, 0.05); }
      if (filt && I.blat) { filt.frequency.setTargetAtTime(I.lp * 2.3, n.t, 0.02); filt.frequency.setTargetAtTime(I.lp, n.t + 0.07, 0.12); }
    });
    env.gain.setTargetAtTime(0, end - 0.03, I.rel);
    if (cg) cg.gain.setTargetAtTime(0, end, I.rel);
    env.connect(vo); outTo(g, vo, pan);
  }

  // Drone beds: brass (sawtooth stacks, slow swells), wind (soft fifth + gusting air), eerie (beating sines).
  function drone(g, t, root, lv, kind) {
    const c = g.ctx, env = c.createGain(), sum = c.createGain(), lp = c.createBiquadFilter(), f0 = hz(root), nodes = []; KR(lp.frequency);
    const osc = (f, dt, ty, a, to) => { const o = c.createOscillator(), k = c.createGain(); o.type = ty; o.frequency.value = f; o.detune.value = dt; k.gain.value = a; o.connect(k); k.connect(to || sum); o.start(t); nodes.push(o); return o; };
    const lfo = (f, depth, param) => { const o = c.createOscillator(), k = c.createGain(); o.frequency.value = f; k.gain.value = depth; o.connect(k); k.connect(param); o.start(t); nodes.push(o); };
    lp.type = 'lowpass';
    if (kind === 'brass') {
      [[f0, -6, .5], [f0, 6, .5], [f0 * 1.5, -3, .28], [f0 * 0.5, 0, .45], [f0 * 2, 4, .12]].forEach(([f, dt, a]) => osc(f, dt, 'sawtooth', a));
      lp.frequency.value = 320; lp.Q.value = 1.4; lfo(0.045, 200, lp.frequency); lfo(0.063, 0.22, sum.gain);
    } else if (kind === 'wind') {
      [[f0, -3, .5], [f0 * 1.5, 3, .22], [f0 * 2, 0, .14]].forEach(([f, dt, a]) => osc(f, dt, 'triangle', a));
      lp.frequency.value = 480; lp.Q.value = 0.8; lfo(0.05, 0.2, sum.gain);
      const ns = c.createBufferSource(), bp = c.createBiquadFilter(), wg = c.createGain(); ns.buffer = noiseBuf(c); ns.loop = true;
      bp.type = 'bandpass'; KR(bp.frequency).value = 650; bp.Q.value = 1.1; wg.gain.value = 0.55;
      ns.connect(bp); bp.connect(wg); wg.connect(env); ns.start(t, Math.random()); nodes.push(ns);
      lfo(0.057, 380, bp.frequency); lfo(0.089, 0.35, wg.gain);
    } else {   // eerie
      osc(f0, 0, 'sine', .55); osc(f0 * 1.004, 0, 'sine', .55); osc(f0 * 1.5, 0, 'triangle', .22);
      const hi = osc(f0 * 2.83, 0, 'sine', .07); lfo(0.13, 30, KR(hi.detune));
      lp.frequency.value = 900; lfo(0.07, 0.25, sum.gain);
      const ns = c.createBufferSource(), bp = c.createBiquadFilter(), wg = c.createGain(); ns.buffer = noiseBuf(c); ns.loop = true;
      bp.type = 'bandpass'; KR(bp.frequency).value = 320; bp.Q.value = 5; wg.gain.value = 0.3;
      ns.connect(bp); bp.connect(wg); wg.connect(env); ns.start(t, Math.random()); nodes.push(ns);
      lfo(0.041, 160, bp.frequency);
    }
    sum.connect(lp); lp.connect(env); env.connect(g.out);
    env.gain.setValueAtTime(0, t); env.gain.setTargetAtTime(lv, t, 1.2);
    return {
      level(v, at) { env.gain.setTargetAtTime(lv * v, Math.max(at, t + 0.05), 1.5); },
      stop(at, fade) { env.gain.cancelScheduledValues(at); env.gain.setTargetAtTime(0, at, fade / 4); nodes.forEach(o => o.stop(at + fade + 1)); },
      kill() { [env, sum, lp].forEach(n => { try { n.disconnect(); } catch (e) { } }); },
    };
  }

  // ── Music: original compositions. Melody tokens are "degree,beats"; r = rest ─
  // Accompaniment patterns: [degree offset from chord root, velocity] per grid slot.
  const PAT = {
    slow: [[-7, .9], [0, .45], [4, .5], [7, .45], [9, .4], [7, .35], [4, .4], [2, .35]],
    sparse: [[-7, .7], [4, .35], [7, .4], [9, .3]],
    pulse: [[-7, 1], [-7, .55], [-7, .75], [-7, .55]],
    pulse8: [[0, 1], [0, .55], [0, .75], [0, .55], [0, 1], [0, .55], [0, .75], [0, .6]],
    ost: [[0, 1], [0, .55], [0, .7], [1, .8], [0, 1], [0, .55], [-1, .7], [1, .75]],
    gallop: [[0, 1], [0, .5], [0, .6], [0, 1], [0, .5], [0, .6], [0, 1], [0, .5], [0, .6], [0, 1], [0, .5], [0, .6], [1, .9], [1, .5], [0, .8], [0, .5]],
  };
  const THEMES = {
    // Overture. E Phrygian, 58 bpm. Brass drone, deep choir, slow taiko, hurdy-gurdy then brass.
    title: {
      mode: MODE.phr, root: 52, bpm: 58, bar: 4, lv: .68, drone: ['brass', .06],
      mel: {
        I: '',
        A: '0,1 1,1 0,1 -1,1 | 0,3 r,1 | 3,1 4,1 5,1 4,1 | 3,2 1,2 | 0,1 1,1 3,1 4,1 | 5,2 4,1 3,1 | 1,1 0,1 1,1 -1,1 | 0,4',
        B: '4,2 5,1 4,1 | 7,3 5,1 | 6,1 5,1 4,1 3,1 | 4,4 | 4,2 5,1 7,1 | 8,2 7,1 5,1 | 4,1 3,1 1,1 3,1 | 0,4',
        C: '0,2 3,2 | 4,3 3,1 | 1,2 3,1 1,1 | 0,4 | 0,2 -1,2 | 1,3 0,1 | -1,2 -3,1 -2,1 | 0,4',
      },
      ch: { I: [0, 0, 1, 0], A: [0, 0, 3, 1, 0, 5, 6, 0], B: [5, 5, 6, 0, 3, 1, 6, 0], C: [0, 3, 1, 0, 5, 1, 6, 0] },
      intro: ['I'], form: ['A1', 'B1', 'C1', 'A2', 'B2'],
      sec: {
        I: { m: 'I', pad: 'oo', padLv: .45, horns: .55, drum: ['g---------------', 'K---------------', 'K-------K-------', 'K-------k-k-K---'], riser: 1 },
        A1: { m: 'A', lead: [['gurdy', 0, .9]], pad: 'oo', padLv: .35, horns: .4, drum: 'K-------K---k---' },
        B1: { m: 'B', lead: [['brass', -12, .9], ['cantor', -12, .45, 'ah']], pad: 'ah', padLv: .55, horns: .5, drum: ['g-------K---k-k-', 'K-------K---k-k-'], acc: ['str', 'pulse', 0, .35], drone: .8 },
        C1: { m: 'C', lead: [['cantor', 0, 1, 'oh']], pad: 'oo', padLv: .4, horns: .3, drum: 'K---------------', bells: 'phrase' },
        A2: { m: 'A', lead: [['cello', 0, .8], ['gurdy', 12, .3]], pad: 'ah', padLv: .45, horns: .45, drum: 'K-----k-K---k-k-', acc: ['harp', 'slow', 0, .35] },
        B2: { m: 'B', lead: [['brass', -12, 1], ['gurdy', 0, .4]], pad: 'ah', padLv: .6, horns: .6, organ: 1, drum: ['g---K---K-k-K---', 'K---K---K-k-K-kk'], acc: ['str', 'pulse', 0, .4], shout: ['H---', '----'], drone: .8 },
      },
    },
    // Wandering. D Aeolian, 66 bpm, ~204 s loop. Lone cello, harp, soft choir, wind.
    explore: {
      mode: MODE.aeo, root: 50, bpm: 66, bar: 4, lv: 1.5, drone: ['wind', .05],
      mel: {
        A: '4,3 3,1 | 2,2 0,2 | 1,1 2,1 3,2 | 2,4 | 4,2 5,1 6,1 | 7,3 5,1 | 4,1 3,1 2,1 1,1 | 0,4',
        B: '7,2 r,2 | 6,1 5,1 4,2 | r,4 | 5,2 4,1 2,1 | 4,4 | r,2 3,1 2,1 | 1,3 r,1 | 0,4',
        C: '0,4 | 2,3 1,1 | 0,2 -1,2 | 0,4 | 3,4 | 4,2 2,2 | 1,2 -1,2 | 0,4',
        R: '',
      },
      ch: { A: [0, 5, 6, 2, 3, 5, 4, 0], B: [5, 2, 3, 5, 0, 3, 4, 0], C: [0, 2, 5, 0, 3, 2, 6, 0], R: [0, 5, 3, 0, 6, 2, 4, 0] },
      form: ['A1', 'B1', 'R1', 'C1', 'A2', 'R2', 'B2'],
      sec: {
        A1: { m: 'A', lead: [['cello', 0, .8]], pad: 'oo', padLv: .2, acc: ['harp', 'slow', 0, .28], thin: .15 },
        B1: { m: 'B', lead: [['harp', 12, .45]], pad: 'oo', padLv: .26, acc: ['lute', 'sparse', 0, .28], thin: .1 },
        R1: { m: 'R', pad: 'oo', padLv: .24, drops: 3, drone: 1.25 },
        C1: { m: 'C', lead: [['cantor', 0, .7, 'oo']], pad: 'oh', padLv: .18, acc: ['harp', 'sparse', 12, .24], thin: .2 },
        A2: { m: 'A', lead: [['lute', 0, .5], ['cello', -12, .45]], pad: 'oo', padLv: .22, acc: ['harp', 'slow', 0, .24], thin: .3, drum: 'k---------------', drumLv: .3 },
        R2: { m: 'R', pad: 'ah', padLv: .18, drops: 2, bells: 'distant', drone: 1.25 },
        B2: { m: 'B', lead: [['harp', 12, .4], ['cello', -12, .4]], pad: 'oo', padLv: .24, acc: ['harp', 'sparse', 0, .26], thin: .1 },
      },
    },
    // Night. B Phrygian, 46 bpm, ~125 s loop. Eerie drone, distant bells, low choir.
    night: {
      mode: MODE.phr, root: 47, bpm: 46, bar: 4, lv: .95, drone: ['eerie', .07],
      mel: { E: '', N: '0,4 | 1,3 0,1 | -1,4 | 0,4 | 3,3 1,1 | 0,4', M: '4,4 | 3,2 1,2 | 0,4 | 1,2 -1,2 | 0,4 | r,4' },
      ch: { E: [0, 1, 0, 6, 0, 1], N: [0, 1, 6, 0, 3, 0], M: [0, 1, 0, 6, 0, 0] },
      form: ['E1', 'N1', 'E2', 'M1'],
      sec: {
        E1: { m: 'E', pad: 'oo', padLv: .3, padOct: 0, bells: 'distant' },
        N1: { m: 'N', lead: [['cello', 0, .6]], pad: 'oo', padLv: .2, padOct: 0, bells: 'distant' },
        E2: { m: 'E', pad: 'oh', padLv: .28, padOct: 0, drops: 1, bells: 'distant', drum: 'K---------------', drumLv: .22, drone: 1.15 },
        M1: { m: 'M', lead: [['cantor', 0, .55, 'oo']], pad: 'oo', padLv: .16, padOct: 0, bells: 'distant' },
      },
    },
    // Combat. A Phrygian, 138 bpm, 55.7 s loop. Taiko, staccato strings, brass stabs, choir shouts.
    combat: {
      mode: MODE.phr, root: 45, bpm: 138, bar: 4, lv: .52, drone: ['brass', .05],
      mel: {
        I: '', A: '',
        B: '0,1.5 1,.5 0,1 -1,1 | 0,2 3,2 | 4,1.5 3,.5 1,1 3,1 | 4,4 | 4,1.5 5,.5 4,1 3,1 | 1,2 3,2 | 1,1 0,1 -1,1 1,1 | 0,4',
        C: '7,4 | 8,2 7,2 | 5,4 | 4,4 | 3,4 | 4,2 5,2 | 4,2 1,2 | 0,4',
      },
      ch: { I: [0, 0], A: [0, 0, 1, 0, 0, 5, 6, 1], B: [0, 3, 1, 0, 0, 1, 6, 0], C: [5, 1, 3, 0, 6, 5, 1, 0] },
      intro: ['I'], form: ['A1', 'B1', 'A2', 'C1'],
      sec: {
        I: { m: 'I', acc: ['str', 'ost', 0, .45, 1], drum: ['K---K---K-k-K-k-', 'K-k-K-k-KkKkKKKK'], riser: 1, drone: .6 },
        A1: { m: 'A', acc: ['str', 'ost', 0, .5, 1], drum: 'K-k-x-k-K-kKx-k-', stab: ['S-------S--S----', '--------S---S---'], horns: .25 },
        B1: { m: 'B', lead: [['brass', 12, .9]], acc: ['str', 'ost', 0, .45, 1], drum: 'K-kxK-kxK-kxKxkx', stab: 'S-------S-------', shout: ['H---', '----', 'H---', '--H-'], pad: 'ah', padLv: .3 },
        A2: { m: 'A', acc: ['str', 'ost', 0, .5, 1], drum: ['K-kxK-kKx-kxK-kk', 'K-kxK-kKx-kxKaKa'], stab: ['S-------S--S----', 'S-------S---S-S-'], shout: ['H---', '----'], pad: 'ah', padLv: .35, horns: .3 },
        C1: { m: 'C', lead: [['cantor', 0, .9, 'ah']], pad: 'oh', padLv: .45, horns: .4, drum: ['K---K--kK---K-g-', 'K---K--kK---KkKk'], acc: ['str', 'pulse8', 0, .35, 1], riser: 1 },
      },
    },
    // Boss. D Phrygian, 152 bpm, 50.5 s loop. Full choir, organ brass, double-time taiko, heroic-tragic theme.
    boss: {
      mode: MODE.phr, root: 50, bpm: 152, bar: 4, lv: .5, drone: ['brass', .065],
      mel: {
        I: '',
        A: '0,2 1,1 3,1 | 4,3 3,1 | 5,2 4,1 3,1 | 4,4 | 7,2 8,1 7,1 | 5,2 4,2 | 3,1 4,1 3,1 1,1 | 0,4',
        B: '4,1 4,.5 5,.5 7,2 | 8,3 7,1 | 5,1 4,1 5,1 7,1 | 4,4 | 3,1 3,.5 4,.5 5,2 | 7,2 5,2 | 4,1.5 3,.5 1,1 -1,1 | 0,4',
        C: '7,4 | 6,4 | 5,4 | 4,4 | 5,2 4,2 | 3,4 | 1,2 -1,2 | 0,4',
      },
      ch: { I: [0, 1, 0, 0], A: [0, 0, 5, 0, 5, 3, 1, 0], B: [0, 1, 5, 0, 3, 5, 6, 0], C: [5, 6, 3, 0, 5, 1, 6, 0] },
      intro: ['I'], form: ['A1', 'B1', 'A2', 'C1'],
      sec: {
        I: { m: 'I', horns: .6, organ: 1, pad: 'oo', padLv: .4, drum: ['g---------------', 'K-------K-------', 'K---K---K---K---', 'KkKkKkKkKKKKKKKK'], riser: 1 },
        A1: { m: 'A', lead: [['cantor', 0, 1, 'ah']], pad: 'ah', padLv: .55, horns: .45, organ: 1, acc: ['str', 'gallop', -12, .42, 1], drum: 'K-kkx-kkK-kkx-kK', stab: 'S-------S-------' },
        B1: { m: 'B', lead: [['brass', 0, 1], ['brass', -12, .5]], pad: 'ah', padLv: .5, horns: .4, organ: 1, acc: ['str', 'gallop', -12, .42, 1], drum: 'KkxkKkxkKkxkKkxk', stab: ['S---S---S-S-S---', 'S---S---SSS-S---'], shout: ['H---', '--H-'] },
        A2: { m: 'A', lead: [['cantor', 0, .9, 'oh'], ['brass', -12, .55]], pad: 'ah', padLv: .6, horns: .5, organ: 1, acc: ['str', 'gallop', -12, .42, 1], drum: ['K-kkxkkkK-kkxkKK', 'K-kkxkkkK-kkxkaK'], shout: ['H---', '----'] },
        C1: { m: 'C', lead: [['cantor', 0, 1, 'oh'], ['cello', 0, .6]], pad: 'oh', padLv: .6, horns: .55, organ: 1, acc: ['str', 'pulse8', -12, .4, 1], drum: ['K--kK--kK--kK-kk', 'g--kK--kK--kKkKk'], riser: 1 },
      },
    },
    // Victory. D Dorian hymn, 60 bpm, Picardy major cadences; fanfare then a 96 s loop.
    victory: {
      mode: MODE.dor, root: 50, bpm: 60, bar: 4, lv: .66, drone: ['brass', .04], pic: 1,
      mel: {
        F: '0,.5 0,.5 4,1 7,2 | 6,1 5,1 4,2 | 3,1 4,1 5,1 6,1 | 7,4',
        H: '0,1 2,1 3,1 4,1 | 5,3 4,1 | 3,1 4,1 5,1 7,1 | 6,4 | 7,2 6,1 5,1 | 4,2 3,1 2,1 | 3,1 2,1 1,1 -1,1 | 0,4',
      },
      ch: { F: [0, 6, 3, 0], H: [0, 3, 3, 6, 3, 2, 6, 0] },
      intro: ['F0'], form: ['H1', 'H2', 'H3'],
      sec: {
        F0: { m: 'F', lead: [['brass', 0, 1], ['brass', -12, .6]], horns: .5, pad: 'ah', padLv: .5, drum: ['g-------K-------', 'K-------K---K---', 'K---K---K---K-k-', 'K---------------'], drone: .8 },
        H1: { m: 'H', lead: [['cantor', 0, 1, 'ah']], pad: 'ah', padLv: .45, horns: .35, acc: ['harp', 'slow', 0, .3], drum: 'K-------K-------', drumLv: .6 },
        H2: { m: 'H', lead: [['cello', 0, 1], ['gurdy', 12, .45]], pad: 'oo', padLv: .6, horns: .3, acc: ['harp', 'slow', 0, .4], bells: 'phrase', drum: 'K---------------', drumLv: .5 },
        H3: { m: 'H', lead: [['brass', 0, .8], ['cantor', 0, .5, 'oh']], pad: 'ah', padLv: .55, horns: .45, organ: 1, acc: ['harp', 'slow', 0, .3], drum: 'K-------K---K---', drumLv: .7 },
      },
    },
    // Death. A Phrygian sting (bII to i), then silence.
    death: {
      mode: MODE.phr, root: 45, bpm: 50, bar: 4, lv: .6, once: 1,
      mel: { D: '3,1 1,1 0,2 | r,4' }, ch: { D: [1, 0] }, form: ['D'],
      sec: { D: { m: 'D', lead: [['cello', 0, .9]], horns: .6, pad: 'oh', padLv: .5, drum: ['g---K-----------', 'K---------------'] } },
    },
  };

  function parse(s) {
    const out = []; let b = 0;
    (s || '').split(/[\s|]+/).forEach(tok => {
      if (!tok) return; const [a, d] = tok.split(','), dur = parseFloat(d);
      if (a !== 'r') out.push({ b, d: dur, deg: parseFloat(a) });
      b += dur;
    });
    return out;
  }
  const normRoot = r => (r >= 4 ? r - 7 : r);
  // Chord notes from degree offsets; a Picardy third lifts the minor third on final bars.
  const voice = (th, rt, degs, base, pic) => degs.map(d => dm(th.mode, base, rt + d) + (pic && ((d % 7) + 7) % 7 === 2 ? 1 : 0));

  // Build every event of one section (times in seconds from the section start).
  function buildSection(th, key, rep) {
    const S = th.sec[key], sb = 60 / th.bpm, barS = th.bar * sb, chords = th.ch[S.m], bars = chords.length;
    const r = rng(hash(key) + rep * 977 + th.root), ev = [], needs = [];
    const add = (t, d, fn, prio) => ev.push({ t: Math.max(0, t), d, fn, prio: prio || 1 });
    const hum = () => (r() - 0.5) * 0.012;
    const pic = b => th.pic && b === bars - 1;
    // melody lines
    (S.lead || []).forEach(([inst, oct, lv, vow, mkey], li) => {
      const mel = parse(th.mel[mkey || S.m]), pan = li ? (li % 2 ? -0.28 : 0.28) : 0.05;
      const ns = mel.map(n => ({ t: n.b * sb, d: n.d * sb, m: dm(th.mode, th.root + oct, n.deg), b: n.b }));
      if (PLUCK[inst]) { ns.forEach(n => { needs.push([inst, n.m]); const v = lv * (0.9 + r() * 0.2); add(n.t + hum(), 3, (g, T) => PLUCK[inst](g, T, n.m, v, pan)); }); return; }
      let ph = [];
      const flush = () => {
        if (!ph.length) return; const p = ph; ph = [];
        const d = p[p.length - 1].t + p[p.length - 1].d - p[0].t;
        add(p[0].t, d, (g, T) => lead(g, inst, p.map(n => ({ t: T + n.t - p[0].t, d: n.d, m: n.m })), lv, pan, vow), 3);
      };
      ns.forEach(n => {
        const pv = ph[ph.length - 1];
        if (pv && (n.t > pv.t + pv.d + 0.001 || n.b % (4 * th.bar) === 0)) {
          if (n.t <= pv.t + pv.d + 0.001) pv.d -= Math.min(0.15, pv.d * 0.25);   // breathe at the phrase line
          flush();
        }
        ph.push({ t: n.t, d: n.d, m: n.m });
      });
      flush();
    });
    // sustained chords per run of equal chords: choir pad and brass/organ horns
    for (let i = 0; i < bars;) {
      let j = i + 1; while (j < bars && chords[j] === chords[i] && !pic(j)) j++;
      const rt = normRoot(chords[i]), dur = (j - i) * barS, p = pic(i);
      if (S.pad) { const ms = lift(voice(th, rt, [0, 4, 7, 9], th.root + (S.padOct == null ? -12 : S.padOct), p), 36); ms.forEach(m => needs.push(['choir', m, S.pad])); add(i * barS, dur, (g, T) => choir(g, T, dur + 0.25, ms, S.pad, S.padLv, 0), 2); }
      if (S.horns) { const ms = lift(voice(th, rt, [-7, 0, 4, 9], th.root - 12, p), 33); add(i * barS, dur, (g, T) => horns(g, T, dur + 0.1, ms, S.horns, S.organ), 2); }
      i = j;
    }
    // plucked / bowed accompaniment
    if (S.acc) {
      const [inst, pat, oct, lv, full] = S.acc, P = PAT[pat], step = barS / P.length;
      for (let b = 0; b < bars; b++) {
        const rt = normRoot(chords[b]), cad = !full && b === bars - 1;
        P.forEach(([o, v], k) => {
          if (cad && k % (P.length / 2)) return;
          if (S.thin && k && r() < S.thin) return;
          const m = voice(th, rt + o, [0], th.root + oct, pic(b))[0]; needs.push([inst, m]);
          const vv = lv * v * (0.88 + r() * 0.24), pan = k % 2 ? 0.3 : -0.3;
          add(b * barS + k * step + (full ? 0 : hum()), 1.5, (g, T) => PLUCK[inst](g, T, m, vv, pan));
        });
      }
    }
    // taiko / war percussion
    if (S.drum) {
      const dl = S.drumLv || 1;
      for (let b = 0; b < bars; b++) {
        const p = Array.isArray(S.drum) ? S.drum[b % S.drum.length] : S.drum, step = barS / p.length;
        [...p].forEach((ch, k) => {
          if (!DR[ch]) return; const v = DR[ch] * dl * (0.85 + r() * 0.3), pan = ch === 'x' || ch === 'h' ? 0.3 : ch === 'a' ? -0.35 : 0;
          add(b * barS + k * step, ch === 'g' ? 5 : 1, (g, T) => drum(g, T, ch, v, pan), ch === 'K' || ch === 'g' ? 2 : 1);
        });
      }
      needs.push(['drum', 'K'], ['drum', 'k'], ['drum', 'x'], ['drum', 'g'], ['drum', 'a']);
    }
    // brass stabs and choir shouts on the chord of the bar
    if (S.stab) for (let b = 0; b < bars; b++) {
      const p = Array.isArray(S.stab) ? S.stab[b % S.stab.length] : S.stab, step = barS / p.length, ms = lift(voice(th, normRoot(chords[b]), [-7, 0, 4, 7], th.root - 12, false), 33);
      [...p].forEach((ch, k) => { if (ch === 'S') add(b * barS + k * step, .4, (g, T) => stab(g, T, ms, .5, Math.min(0.22, step * 1.6)), 2); });
    }
    if (S.shout) for (let b = 0; b < bars; b++) {
      const p = Array.isArray(S.shout) ? S.shout[b % S.shout.length] : S.shout, step = barS / p.length, ms = lift(voice(th, normRoot(chords[b]), [0, 4, 7], th.root - 12, false), 40);
      if (p.indexOf('H') >= 0) ms.forEach(m => needs.push(['choir', m, 'ah']));
      [...p].forEach((ch, k) => { if (ch === 'H') add(b * barS + k * step, .6, (g, T) => choir(g, T, 0.3, ms, 'ah', .55, 0, { att: 0.02, rel: 0.09, scoop: 1, breath: 0.15 }), 2); });
    }
    // harp drops, bells, riser
    if (S.drops) for (let b = 0; b < bars; b++) for (let q = 0; q < S.drops; q++) {
      if (r() < 0.45) continue;
      const m = voice(th, normRoot(chords[b]) + [0, 2, 4, 7, 9][Math.floor(r() * 5)], [0], th.root, false)[0], v = 0.12 + r() * 0.1, pan = (r() * 2 - 1) * 0.6;
      needs.push(['harp', m]); add(b * barS + Math.floor(r() * th.bar * 2) * sb / 2, 3, (g, T) => PLUCK.harp(g, T, m, v, pan));
    }
    if (S.bells === 'phrase') for (let b = 0; b < bars; b += 4) { const m = th.root; needs.push(['bell', m]); add(b * barS, 4, (g, T) => PLUCK.bell(g, T, m, .22, -0.25)); }
    if (S.bells === 'distant') for (let b = 0; b < bars; b++) {
      if (r() < 0.45) continue;
      const m = th.root + [0, 7, 12, 3][Math.floor(r() * 4)], pan = (r() * 2 - 1) * 0.7; needs.push(['bell', m]);
      add(b * barS + Math.floor(r() * th.bar) * sb, 4, (g, T) => PLUCK.bell(g, T, m, .13, pan));
    }
    if (S.riser) add((bars - 1) * barS, barS, (g, T) => riser(g, T, barS, .12), 2);
    ev.sort((a, b) => a.t - b.t);
    return { len: bars * barS, chunk: barS * 2, ev, needs };
  }

  // One theme's look-ahead player: sections chain back to back, each on its own bus.
  function player(E, name, fadeIn) {
    const th = THEMES[name], c = E.ctx, P = { name, dead: false, done: false, buses: [] };
    const t0 = c.currentTime + 0.05, order = (th.intro || []).concat(th.form), loop0 = th.once ? order.length : (th.intro || []).length;
    P.gain = c.createGain(); P.gain.gain.setValueAtTime(0, t0); P.gain.gain.linearRampToValueAtTime(th.lv || 1, t0 + fadeIn); P.gain.connect(E.musicIn);
    P.drone = th.drone ? drone({ ctx: c, out: P.gain }, t0, lift([th.root - 12], 36)[0], th.drone[1], th.drone[0]) : null;
    let si = 0, rep = 0, next = t0, cur = null;
    if (!E.offline) {   // bake this theme's buffers in small idle slices, first use first
      const seen = {}, list = [];
      order.forEach(k => buildSection(th, k, 0).needs.forEach(n => { const id = n.join(); if (!seen[id]) { seen[id] = 1; list.push(n); } }));
      const step = () => {
        if (P.dead || !list.length) return;
        const [k, m, vw] = list.shift();
        if (k === 'choir') choirBuf(c, m, vw); else if (k === 'drum') drumBuf(c, m); else if (k === 'str') strBuf(c, m); else if (k === 'lute' || k === 'harp') ksBuf(c, m, k); else bellBuf(c, m, k);
        setTimeout(step, 25);
      };
      setTimeout(step, 25);
    }
    // Each 2-bar chunk plays into its own bus; a timer disconnects it once its last note has rung out.
    const close = (s, j) => {
      const b = s.open[j]; delete s.open[j];
      E.later(() => { try { b.bus.disconnect(); } catch (e) { } P.buses = P.buses.filter(x => x !== b.bus); }, (b.end + TAIL - c.currentTime) * 1000);
    };
    P.pump = h => {
      if (P.dead || P.done) return;
      for (let guard = 0; guard < 8; guard++) {
        if (!cur) {
          if (next > h) return;
          if (si >= order.length) { P.done = true; return; }   // a 'once' theme has ended: silence
          const key = order[si]; if (++si >= order.length && !th.once) { si = loop0; rep++; }
          const st = E.offline ? next : Math.max(next, c.currentTime + 0.05);   // resync after a long stall
          const sec = buildSection(th, key, rep);
          cur = { t0: st, len: sec.len, ev: sec.ev, i: 0, chunk: sec.chunk, open: {} };
          if (P.drone) P.drone.level(th.sec[key].drone == null ? 1 : th.sec[key].drone, st);
          E.stats.sections.push(name + ':' + key); if (E.stats.sections.length > 16) E.stats.sections.shift();
        }
        const now = c.currentTime;
        while (cur.i < cur.ev.length && cur.t0 + cur.ev[cur.i].t < h) {
          const e = cur.ev[cur.i++], T = cur.t0 + e.t, k = Math.floor(e.t / cur.chunk);
          Object.keys(cur.open).forEach(j => { if (+j < k) close(cur, j); });   // events are sorted: earlier chunks are complete
          if (!E.offline && T < now - 0.02) { E.stats.skipped++; continue; }   // never burst stale notes
          if (!E.allow(E.mv, CAP_M, T, T + e.d + 1, e.prio)) continue;
          let b = cur.open[k];
          if (!b) { b = cur.open[k] = { bus: c.createGain(), end: 0 }; b.bus.connect(P.gain); P.buses.push(b.bus); }
          b.end = Math.max(b.end, T + e.d);
          e.fn({ ctx: c, out: b.bus }, T);
        }
        if (cur.i < cur.ev.length) return;
        next = cur.t0 + cur.len;
        Object.keys(cur.open).forEach(j => close(cur, j)); cur = null;
      }
    };
    P.stop = fade => {
      if (P.dead) return; P.dead = true;
      const now = c.currentTime, gg = P.gain.gain;
      gg.cancelScheduledValues(now); gg.setValueAtTime(gg.value, now); gg.linearRampToValueAtTime(0, now + fade);
      if (P.drone) P.drone.stop(now, fade);
      E.later(() => {
        P.buses.forEach(b => { try { b.disconnect(); } catch (e) { } }); P.buses = [];
        if (P.drone) P.drone.kill(); try { P.gain.disconnect(); } catch (e) { }
      }, (fade + 0.5) * 1000);
    };
    return P;
  }
  // Crossfade times: into combat/boss fast (~1 s), out of combat back to wandering slow (3 s).
  const HOT = { combat: 1, boss: 1 };
  function fades(prev, name) {
    if (name === 'death') return [0.05, 0.6];
    if (HOT[name]) return [0.9, 1.0];
    if (HOT[prev]) return [2.5, 3.0];
    return [2.5, 2.5];
  }

  // ── SFX helpers ────────────────────────────────────────────────────────────
  function tone(g, t, type, f0, f1, dur, lv, pan) {
    const c = g.ctx, o = c.createOscillator(), v = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t); if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    v.gain.setValueAtTime(0, t); v.gain.linearRampToValueAtTime(lv, t + 0.006); v.gain.setTargetAtTime(0, t + 0.01, dur / 3.5);
    o.connect(v); outTo(g, v, pan); o.start(t); o.stop(t + dur + 0.3);
    return o;
  }
  function noiseThrough(g, t, dur, type, q, pan) {
    const c = g.ctx, s = c.createBufferSource(), f = c.createBiquadFilter(), v = c.createGain();
    s.buffer = noiseBuf(c); s.loop = true; f.type = type; f.Q.value = q; KR(f.frequency); v.gain.value = 0;
    s.connect(f); f.connect(v); outTo(g, v, pan); s.start(t, Math.random() * 1.5); s.stop(t + dur);
    return { f: f.frequency, v: v.gain };
  }
  function swish(g, t, dur, f0, f1, f2, lv, pan) {
    const n = noiseThrough(g, t, dur + 0.3, 'bandpass', 1.4, pan);
    n.f.setValueAtTime(f0, t); n.f.exponentialRampToValueAtTime(f1, t + dur * 0.35); n.f.exponentialRampToValueAtTime(f2, t + dur);
    n.v.setValueAtTime(0, t); n.v.linearRampToValueAtTime(lv, t + dur * 0.3); n.v.setTargetAtTime(0, t + dur * 0.36, dur * 0.2);
  }
  const V4 = () => Math.floor(Math.random() * 4);
  const gore = (g, t, k, lv, pan, rate) => play(g, t, goreBuf(g.ctx, k, V4()), lv, pan || 0, rate || rr(0.9, 1.1));
  // Beast / human voice: saw (+FM rough, +sub) with a pitch contour, noise, drive, moving formants, tremolo.
  function beast(g, t, o) {
    const c = g.ctx, dur = o.dur, rel = o.rel || 0.12, stop = t + dur + rel * 6 + 0.05, src = c.createGain(), osc = [];
    const add = (type, mul, lv, det) => { const x = c.createOscillator(), k = c.createGain(); x.type = type; KR(x.frequency); KR(x.detune).value = det || 0; k.gain.value = lv; x.connect(k); k.connect(src); x.start(t); x.stop(stop); osc.push([x, mul]); };
    add(o.wave || 'sawtooth', 1, 1, 0);
    if (o.dual) add(o.wave || 'sawtooth', 1, 0.7, o.dual);
    if (o.sub) add('sawtooth', 0.5, o.sub, 0);
    osc.forEach(([x, mul]) => { x.frequency.setValueAtTime(o.f[0][1] * mul, t); for (let i = 1; i < o.f.length; i++) x.frequency.exponentialRampToValueAtTime(o.f[i][1] * mul, t + o.f[i][0]); });
    const lfo = (f, depth, params) => { const l = c.createOscillator(), lg = c.createGain(); l.frequency.value = f; lg.gain.value = depth; l.connect(lg); params.forEach(p => lg.connect(p)); l.start(t); l.stop(stop); };
    if (o.fm) lfo(o.fm[0], o.fm[1], osc.map(([x]) => x.frequency));
    if (o.vib) lfo(o.vib[0], o.vib[1], osc.map(([x]) => x.detune));
    src.gain.value = 0.5;
    if (o.noise) { const n = c.createBufferSource(), b = c.createBiquadFilter(), k = c.createGain(); n.buffer = noiseBuf(c); n.loop = true; b.type = 'bandpass'; b.frequency.value = o.nf || 1400; b.Q.value = 0.7; k.gain.value = o.noise; n.connect(b); b.connect(k); k.connect(src); n.start(t, Math.random()); n.stop(stop); }
    let x = src;
    if (o.dist) { const d = c.createWaveShaper(); d.curve = curve(c, o.dist); src.connect(d); x = d; }
    const amp = c.createGain(), fs = o.fs || 1, path = o.v || [[0, 'ah']];
    for (let k = 0; k < 3; k++) {
      const b = c.createBiquadFilter(), kg = c.createGain(); b.type = 'bandpass'; b.Q.value = FQ[k]; KR(b.frequency);
      path.forEach(([pt, vw], i) => { const F = VOW[vw][k][0] * fs; if (i === 0) b.frequency.setValueAtTime(F, t); else b.frequency.linearRampToValueAtTime(F, t + pt); });
      kg.gain.value = VOW[path[0][1]][k][1] * 2.6; x.connect(b); b.connect(kg); kg.connect(amp);
    }
    const body = c.createBiquadFilter(), bg = c.createGain(); body.type = 'lowpass'; body.frequency.value = 480 * fs; bg.gain.value = o.body == null ? 0.4 : o.body; x.connect(body); body.connect(bg); bg.connect(amp);
    let last = amp;
    if (o.am) { const tr = c.createGain(); tr.gain.value = 1 - o.am[1]; amp.connect(tr); lfo(o.am[0], o.am[1], [tr.gain]); last = tr; }
    const env = c.createGain(), lv = o.lv || 0.5;
    env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(lv, t + (o.att || 0.03)); env.gain.setTargetAtTime(0, t + dur, rel);
    last.connect(env); outTo(g, env, o.pan || 0);
  }
  const shift = (f, k) => f.map(([t, v]) => [t, v * k]);

  // ── SFX: name -> fn(g, t, opts). Unknown names are no-ops ──────────────────
  let stepN = 0;
  const SFX = {
    swing(g, t, o) {
      if (o.heavy) return SFX.swing_heavy(g, t, o);
      const w = o.weapon, k = w === 'dagger' ? 1.35 : w === 'axe' || w === 'mace' ? 0.8 : w === 'greatsword' ? 0.7 : 1;
      swish(g, t, 0.3 / Math.sqrt(k), rr(420, 520) * k, 2800 * k, 620 * k, 0.5);
      if (w === 'crimson') tone(g, t, 'sawtooth', 220, 110, 0.35, 0.05);
    },
    swing_heavy(g, t) { swish(g, t, 0.55, 240, 1500, 300, 0.7); tone(g, t + 0.05, 'sine', 120, 50, 0.4, 0.22); },
    whoosh(g, t) { swish(g, t, 0.45, 300, 1400, 420, 0.45, -0.3); },
    dodge(g, t) { swish(g, t, 0.38, 280, 1300, 380, 0.42, rr(-0.4, 0.4)); swish(g, t + 0.02, 0.3, 700, 2200, 600, 0.12); },
    charge(g, t) {   // the heavy attack winds up: a rising hum with a growing edge
      const c = g.ctx, o = c.createOscillator(), o2 = c.createOscillator(), f = c.createBiquadFilter(), v = c.createGain();
      o.type = 'sawtooth'; o2.type = 'sine'; o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(150, t + 0.9); o2.frequency.setValueAtTime(140, t); o2.frequency.exponentialRampToValueAtTime(300, t + 0.9);
      f.type = 'lowpass'; KR(f.frequency).setValueAtTime(200, t); f.frequency.exponentialRampToValueAtTime(1600, t + 0.9);
      v.gain.setValueAtTime(0, t); v.gain.linearRampToValueAtTime(0.16, t + 0.7); v.gain.setTargetAtTime(0, t + 0.9, 0.12);
      o.connect(f); o2.connect(f); f.connect(v); outTo(g, v, 0); [o, o2].forEach(x => { x.start(t); x.stop(t + 1.6); });
      swish(g, t, 0.9, 200, 600, 1800, 0.12);
    },
    chargeFull(g, t) { gore(g, t, 'ring', 0.35, 0, 1.25); PLUCK.chime(g, t + 0.02, 88, 0.12, 0.2); tone(g, t, 'sine', 110, 110, 0.4, 0.2); },
    guard(g, t) { swish(g, t, 0.22, 500, 1200, 700, 0.18); gore(g, t + 0.05, 'clang', 0.08, 0, 1.6); play(g, t + 0.05, stepBuf(g.ctx, 'soft', V4()), 0.12, 0, 1.4); },
    uncork(g, t) {
      tone(g, t, 'sine', 900, 300, 0.05, 0.4); const n = noiseThrough(g, t, 0.12, 'bandpass', 3); n.f.value = 1800; n.v.setValueAtTime(0.3, t); n.v.setTargetAtTime(0, t + 0.004, 0.012);
      gore(g, t + 0.06, 'glug', 0.1, 0, 2.5);
    },
    flesh(g, t) { gore(g, t, 'flesh', 0.9); tone(g, t, 'sine', 125, 45, 0.18, 0.4); },
    bone(g, t) { gore(g, t, 'bone', 0.85); gore(g, t + 0.004, 'flesh', 0.45); },
    sever(g, t) {
      gore(g, t, 'slice', 0.7); gore(g, t + 0.01, 'flesh', 0.85); gore(g, t + 0.02, 'bone', 0.6, 0, rr(1.05, 1.25));
      gore(g, t + 0.07, 'spurt', 0.65); gore(g, t + 0.42, 'splat', 0.4, rr(-0.4, 0.4), 0.8);
    },
    gib(g, t) {
      tone(g, t, 'sine', 90, 28, 0.6, 0.85);
      gore(g, t, 'flesh', 1); gore(g, t + 0.03, 'flesh', 0.8, 0, 0.72); gore(g, t + 0.02, 'bone', 0.7); gore(g, t + 0.06, 'bone', 0.5, 0.3, 1.3);
      gore(g, t + 0.02, 'splat', 1); gore(g, t + 0.08, 'splat', 0.8, -0.3, 0.8); gore(g, t + 0.1, 'spurt', 0.6);
      for (let i = 0; i < 7; i++) gore(g, t + rr(0.25, 1.1), 'splat', rr(0.15, 0.4), rr(-0.7, 0.7), rr(0.8, 1.5));
    },
    splat(g, t) { gore(g, t, 'splat', 0.8); },
    clang(g, t) { gore(g, t, 'clang', 0.75, 0, rr(0.95, 1.08)); },
    parry(g, t) { gore(g, t, 'ring', 0.6); gore(g, t, 'clang', 0.45, 0, 1.2); },
    block(g, t, o) {
      drum(g, t, 'k', 0.55, 0, 1.7); drum(g, t, 'wood', 0.3, 0, 0.7); gore(g, t, 'clang', 0.12, 0, 0.5);
      const n = noiseThrough(g, t, 0.2, 'lowpass', 0.7); n.f.value = 700; n.v.setValueAtTime(0.5, t); n.v.setTargetAtTime(0, t + 0.01, 0.03);
      if (o.broken) { gore(g, t + 0.01, 'bone', 0.5, 0, 0.6); gore(g, t, 'clang', 0.45, 0, 0.8); tone(g, t, 'sine', 90, 40, 0.3, 0.5); }
    },
    step(g, t, o) {
      const s = SURF[o.surface] || 'soft', k = stepN++;
      if (o.land) return SFX.land(g, t, o);
      play(g, t, stepBuf(g.ctx, s, V4()), (s === 'snow' ? 0.22 : 0.18) * rr(0.85, 1.1) * (o.sprint ? 1.3 : 1), k % 2 ? 0.1 : -0.1, rr(0.9, 1.1) * (o.sprint ? 1.06 : 1));
    },
    jump(g, t) { beast(g, t, { dur: 0.12, f: [[0, 150], [0.12, 170]], noise: 0.6, nf: 900, v: [[0, 'uh']], lv: 0.18, att: 0.01, rel: 0.04 }); swish(g, t, 0.25, 500, 1300, 500, 0.15); },
    land(g, t, o) { tone(g, t, 'sine', 95, 40, 0.18, 0.45); const s = SURF[o.surface] || 'soft'; play(g, t, stepBuf(g.ctx, s, V4()), 0.3, -0.1, 0.85); play(g, t + 0.03, stepBuf(g.ctx, s, V4()), 0.25, 0.1, 0.9); },
    splash(g, t) {
      const n = noiseThrough(g, t, 0.8, 'lowpass', 0.8); n.f.setValueAtTime(3500, t); n.f.exponentialRampToValueAtTime(500, t + 0.6);
      n.v.setValueAtTime(0, t); n.v.linearRampToValueAtTime(0.5, t + 0.02); n.v.setTargetAtTime(0, t + 0.05, 0.15);
      gore(g, t + 0.02, 'splat', 0.35, 0, 1.4); gore(g, t + 0.12, 'glug', 0.2, 0.2, 1.8); gore(g, t + 0.2, 'glug', 0.15, -0.2, 2.2);
    },
    grunt(g, t) { beast(g, t, { dur: 0.22, f: [[0, rr(118, 132)], [0.22, 98]], dual: 6, noise: 0.35, nf: 900, dist: 0.2, v: [[0, 'uh'], [0.22, 'uh']], lv: 0.32, att: 0.015, rel: 0.06 }); },
    hurt(g, t) { beast(g, t, { dur: 0.35, f: [[0, 175], [0.08, 205], [0.35, 118]], dual: 8, noise: 0.35, dist: 0.3, v: [[0, 'ah'], [0.35, 'uh']], lv: 0.42, att: 0.01, rel: 0.08 }); gore(g, t, 'flesh', 0.4); },
    death(g, t) {
      beast(g, t, { dur: 1.6, f: [[0, 160], [0.25, 150], [1.6, 68]], dual: 10, vib: [6, 35], noise: 0.35, dist: 0.2, v: [[0, 'ah'], [0.7, 'oh'], [1.6, 'oo']], lv: 0.48, att: 0.03, rel: 0.35 });
      gore(g, t, 'flesh', 0.6); tone(g, t + 1.0, 'sine', 80, 35, 0.4, 0.5); play(g, t + 1.02, stepBuf(g.ctx, 'dirt', 1), 0.4, 0, 0.7);
    },
    drink(g, t) {
      for (let i = 0; i < 4; i++) gore(g, t + i * 0.16, 'glug', 0.35, 0, rr(0.9, 1.15));
      beast(g, t + 0.72, { dur: 0.35, f: [[0, 120], [0.35, 100]], noise: 0.9, nf: 1200, v: [[0, 'ah'], [0.35, 'oh']], lv: 0.14, att: 0.04, rel: 0.12 });
    },
    torch(g, t, o) {
      if (o.on === false) { swish(g, t, 0.4, 1600, 700, 200, 0.35); const n = noiseThrough(g, t, 0.6, 'highpass', 0.7); n.f.value = 3000; n.v.setValueAtTime(0.12, t); n.v.setTargetAtTime(0, t + 0.05, 0.12); }
      else { swish(g, t, 0.45, 200, 900, 600, 0.45); SFX.fire(g, t + 0.1); }
    },
    fire(g, t) {
      const c = g.ctx, s = c.createBufferSource(), v = c.createGain(); s.buffer = fireBuf(c);
      v.gain.setValueAtTime(0, t); v.gain.linearRampToValueAtTime(0.5, t + 0.03); v.gain.setTargetAtTime(0, t + 0.5, 0.12);
      s.connect(v); outTo(g, v, 0); s.start(t, Math.random() * 3); s.stop(t + 1.3);
    },
    levelup(g, t) {
      drum(g, t, 'K', 0.6, 0); drum(g, t, 'g', 0.3, 0);
      choir(g, t, 1.6, [45, 52, 57, 61, 64], 'ah', 0.55, 0, { att: 0.05, rel: 0.7, scoop: 1 });
      stab(g, t, [33, 45, 52, 57], 0.5, 0.6);
      [0, 4, 7, 12, 16, 19, 24].forEach((s, i) => PLUCK.chime(g, t + 0.15 + i * 0.06, 81 + s, 0.16 - i * 0.012, i % 2 ? 0.4 : -0.4));
    },
    discover(g, t) {
      lead(g, 'brass', [{ t, d: 1.3, m: 38 }, { t: t + 1.3, d: 1.9, m: 45 }], 3.2, 0);
      choir(g, t + 0.3, 2.8, [38, 45, 50, 53], 'oh', 0.5, 0, { att: 1.2, rel: 0.9 });
      drum(g, t, 'g', 0.25, 0); drum(g, t, 'K', 0.35, 0);
    },
    loot(g, t) { gore(g, t, 'coin', 0.45, rr(-0.2, 0.2)); gore(g, t + 0.09, 'coin', 0.3, rr(-0.3, 0.3), 1.12); },
    quest(g, t) { drum(g, t, 'K', 0.65, 0); lead(g, 'brass', [{ t: t + 0.05, d: 0.35, m: 45 }, { t: t + 0.4, d: 1.2, m: 52 }], 3.2, 0); lead(g, 'brass', [{ t: t + 0.05, d: 1.55, m: 38 }], 2.4, 0); },
    click(g, t) { drum(g, t, 'x', 0.22, 0, 0.8); },
    wolf_growl(g, t) { const d = rr(0.8, 1.1); beast(g, t, { dur: d, f: [[0, 80], [0.3, 96], [d, 74]], fm: [33, 30], am: [28, 0.5], noise: 0.6, nf: 900, dist: 0.5, v: [[0, 'oo'], [0.4, 'ah'], [d, 'uh']], fs: 0.9, lv: 0.55, att: 0.08, rel: 0.1 }); },
    wolf_howl(g, t) {
      const k = rr(0.92, 1.08), f = [[0, 380], [0.35, 600], [1.6, 640], [2.4, 470]];
      beast(g, t, { wave: 'triangle', dur: 2.4, f: shift(f, k), vib: [5.5, 22], noise: 0.05, v: [[0, 'oo'], [0.5, 'oh'], [2.2, 'oo']], fs: 1.25, body: 0.8, lv: 0.42, att: 0.25, rel: 0.3 });
      beast(g, t + 0.05, { wave: 'sawtooth', dur: 2.3, f: shift(f, k * 1.003), vib: [5.1, 18], v: [[0, 'oo'], [0.5, 'oh'], [2.2, 'oo']], fs: 1.25, body: 0.2, lv: 0.12, att: 0.3, rel: 0.3 });
    },
    wolf_yelp(g, t) {
      beast(g, t, { wave: 'triangle', dur: 0.13, f: [[0, 1100], [0.13, 600]], noise: 0.15, v: [[0, 'ee'], [0.13, 'oo']], fs: 1.4, body: 0.6, lv: 0.5, att: 0.005, rel: 0.03 });
      beast(g, t + 0.17, { wave: 'triangle', dur: 0.12, f: [[0, 950], [0.12, 520]], noise: 0.15, v: [[0, 'ee'], [0.12, 'oo']], fs: 1.4, body: 0.6, lv: 0.35, att: 0.005, rel: 0.03 });
    },
    ghoul_moan(g, t) { beast(g, t, { dur: 1.8, f: shift([[0, 90], [0.6, 105], [1.2, 82], [1.8, 70]], rr(0.9, 1.1)), dual: 14, vib: [3.2, 45], noise: 0.35, nf: 700, dist: 0.25, v: [[0, 'oo'], [0.7, 'oh'], [1.4, 'ah'], [1.8, 'uh']], fs: 0.95, lv: 0.5, att: 0.3, rel: 0.3 }); },
    ghoul_shriek(g, t) { beast(g, t, { dur: 0.8, f: [[0, 500], [0.15, 900], [0.8, 560]], dual: 25, vib: [9, 60], noise: 0.7, nf: 2500, dist: 0.7, v: [[0, 'eh'], [0.3, 'ee'], [0.8, 'ah']], fs: 1.25, lv: 0.42, att: 0.03, rel: 0.12 }); },
    bandit_shout(g, t) { const k = rr(0.9, 1.12); beast(g, t, { dur: 0.45, f: shift([[0, 150], [0.1, 205], [0.45, 165]], k), dual: 8, noise: 0.2, dist: 0.3, v: [[0, 'ah'], [0.45, 'eh']], lv: 0.5, att: 0.02, rel: 0.08 }); },
    bandit_die(g, t) { beast(g, t, { dur: 0.9, f: [[0, 190], [0.2, 170], [0.9, 85]], vib: [7, 40], noise: 0.3, dist: 0.2, v: [[0, 'ah'], [0.5, 'oh'], [0.9, 'oo']], lv: 0.5, att: 0.02, rel: 0.2 }); gore(g, t + 0.3, 'splat', 0.2, 0, 0.7); },
    orc_roar(g, t) { beast(g, t, { dur: 1.3, f: shift([[0, 70], [0.25, 110], [1.0, 95], [1.3, 65]], rr(0.92, 1.08)), dual: 12, sub: 0.6, fm: [47, 40], am: [19, 0.3], noise: 0.5, nf: 1100, dist: 0.9, v: [[0, 'uh'], [0.3, 'ah'], [1.3, 'oh']], fs: 0.8, lv: 0.6, att: 0.06, rel: 0.15 }); },
    orc_die(g, t) { beast(g, t, { dur: 1.3, f: [[0, 110], [0.2, 90], [1.3, 45]], sub: 0.5, fm: [31, 25], noise: 0.4, dist: 0.6, v: [[0, 'ah'], [0.6, 'oh'], [1.3, 'oo']], fs: 0.8, lv: 0.55, att: 0.02, rel: 0.2 }); gore(g, t, 'flesh', 0.4, 0, 0.8); },
    troll_bellow(g, t) {
      beast(g, t, { dur: 2.0, f: [[0, 45], [0.4, 62], [1.5, 55], [2, 38]], dual: 10, sub: 0.8, fm: [23, 20], am: [11, 0.25], noise: 0.4, nf: 600, dist: 0.85, v: [[0, 'oo'], [0.5, 'ah'], [1.6, 'oh'], [2, 'uh']], fs: 0.6, lv: 0.7, att: 0.15, rel: 0.3 });
    },
    troll_slam(g, t) {
      tone(g, t, 'sine', 65, 26, 0.9, 1); drum(g, t, 'K', 0.8, 0, 0.55);
      const n = noiseThrough(g, t, 0.9, 'lowpass', 0.7); n.f.value = 420; n.v.setValueAtTime(0.9, t); n.v.setTargetAtTime(0, t + 0.02, 0.2);
      for (let i = 0; i < 10; i++) gore(g, t + rr(0.05, 0.6), 'bone', rr(0.08, 0.22), rr(-0.6, 0.6), rr(0.45, 0.8));
    },
    wraith_shriek(g, t) {
      const o = { wave: 'sine', dur: 1.6, f: [[0, 700], [0.35, 1500], [1.6, 1100]], dual: 35, vib: [11, 80], noise: 0.9, nf: 3000, dist: 0.35, v: [[0, 'oo'], [0.4, 'ee'], [1.6, 'ah']], fs: 1.5, body: 0.2, lv: 0.38, att: 0.35, rel: 0.35 };
      beast(g, t, o); beast(g, t + 0.08, Object.assign({}, o, { f: shift(o.f, 1.41), lv: 0.2, pan: 0.3 }));
    },
    bone_rattle(g, t) {
      let x = t; for (let i = 0; i < 14; i++) { drum(g, x, 'x', rr(0.06, 0.18), rr(-0.4, 0.4), rr(1.2, 2.2)); x += rr(0.015, 0.045); }
      gore(g, t + 0.05, 'bone', 0.2, 0, 1.4);
    },
    boss_roar(g, t) {
      const f = [[0, 48], [0.5, 72], [1.8, 64], [2.6, 40]];
      beast(g, t, { dur: 2.6, f, dual: 9, sub: 0.9, fm: [29, 30], am: [13, 0.25], noise: 0.5, nf: 900, dist: 0.95, v: [[0, 'oo'], [0.6, 'ah'], [2, 'oh'], [2.6, 'uh']], fs: 0.55, lv: 0.7, att: 0.2, rel: 0.35 });
      beast(g, t + 0.03, { dur: 2.5, f: shift(f, 2.02), dual: 14, fm: [37, 40], noise: 0.4, dist: 0.9, v: [[0, 'oh'], [0.6, 'ah'], [2.5, 'uh']], fs: 0.8, lv: 0.28, att: 0.25, rel: 0.35 });
      drum(g, t, 'g', 0.45, 0, 0.7); tone(g, t, 'sine', 40, 30, 2.2, 0.5);
    },
    boss_laugh(g, t) {
      for (let i = 0; i < 5; i++) {
        const last = i === 4, d = last ? 0.6 : 0.17;
        beast(g, t + i * 0.26, { dur: d, f: [[0, 105 - i * 5], [d, (last ? 70 : 88) - i * 5]], sub: 0.7, dual: 7, dist: 0.55, noise: 0.25, v: [[0, 'ah'], [d, 'uh']], fs: 0.7, lv: 0.55 - i * 0.04, att: 0.015, rel: last ? 0.2 : 0.06 });
      }
    },
    thunder(g, t, o) {   // o.dist (m): far strikes lose the crack and the rumble darkens
      const d = o.dist || 0, near = clamp(1 - d / 700, 0, 1), dk = 1 / (1 + d / 900);
      if (near > 0) { const cr = noiseThrough(g, t, 0.4, 'highpass', 0.7); cr.f.value = 1200; cr.v.setValueAtTime(0.7 * near, t); cr.v.setTargetAtTime(0, t + 0.01, 0.05); }
      for (let i = 0; i < 5; i++) {
        const s = t + (i ? rr(0.05, 1.6) : 0.02) + (1 - dk) * 0.4, dd = rr(1, 3) * (1.3 - 0.3 * dk), n = noiseThrough(g, s, dd + 1.5, 'lowpass', 0.8, rr(-0.4, 0.4));
        n.f.setValueAtTime(rr(160, 320) * (0.4 + 0.6 * dk), s);
        n.f.exponentialRampToValueAtTime(55, s + dd); n.v.setValueAtTime(0, s); n.v.linearRampToValueAtTime(rr(0.5, 0.9), s + rr(0.05, 0.3) + (1 - dk) * 0.3); n.v.setTargetAtTime(0, s + 0.3, dd / 3);
      }
      tone(g, t, 'sine', 42, 28, 2.5, 0.4);
    },
    drag(g, t) {   // paper and tobacco crackle over a soft rising inhale
      const n = noiseThrough(g, t, 1.3, 'bandpass', 1.1); n.f.setValueAtTime(500, t); n.f.exponentialRampToValueAtTime(2600, t + 1.0);
      n.v.setValueAtTime(0, t); n.v.linearRampToValueAtTime(0.1, t + 0.5); n.v.linearRampToValueAtTime(0.13, t + 0.95); n.v.setTargetAtTime(0, t + 1.0, 0.06);
      for (let i = 0; i < 16; i++) {
        const s = t + rr(0.02, 1.0), c = noiseThrough(g, s, 0.05, 'highpass', 0.8, rr(-0.15, 0.15));
        c.f.value = rr(2500, 6000); c.v.setValueAtTime(rr(0.05, 0.16), s); c.v.setTargetAtTime(0, s + 0.002, rr(0.004, 0.012));
      }
    },
    exhale(g, t) {   // a long, gentle, breathy whoosh
      const n = noiseThrough(g, t, 1.9, 'bandpass', 0.6); n.f.setValueAtTime(1500, t); n.f.exponentialRampToValueAtTime(450, t + 1.5);
      n.v.setValueAtTime(0, t); n.v.linearRampToValueAtTime(0.16, t + 0.18); n.v.setTargetAtTime(0, t + 0.35, 0.4);
      const l = noiseThrough(g, t, 1.9, 'lowpass', 0.7); l.f.value = 380; l.v.setValueAtTime(0, t); l.v.linearRampToValueAtTime(0.1, t + 0.2); l.v.setTargetAtTime(0, t + 0.4, 0.35);
    },
    lighter(g, t) {   // flint strike, then a small flame whoosh
      const f = noiseThrough(g, t, 0.08, 'highpass', 1.2); f.f.value = 4200; f.v.setValueAtTime(0.35, t); f.v.setTargetAtTime(0, t + 0.003, 0.012);
      tone(g, t, 'square', 3200, 1800, 0.03, 0.05);
      const f2 = noiseThrough(g, t + 0.09, 0.06, 'highpass', 1.2); f2.f.value = 5000; f2.v.setValueAtTime(0.2, t + 0.09); f2.v.setTargetAtTime(0, t + 0.093, 0.01);
      swish(g, t + 0.12, 0.35, 250, 900, 500, 0.2);
    },
  };
  const SDUR = { drag: 1.6, exhale: 2.2, lighter: 0.8, charge: 1.8, chargeFull: 2.4, gib: 2.6, sever: 1.6, death: 3, drink: 1.8, levelup: 4, discover: 5.5, quest: 3, wolf_howl: 3.6, ghoul_moan: 2.8, troll_bellow: 3, troll_slam: 2, wraith_shriek: 2.6, boss_roar: 4, boss_laugh: 2.5, thunder: 6.5, parry: 2.6, clang: 1.6, orc_roar: 2, orc_die: 2 };
  const LOOPS = { rain: 1, wind: 1, fire_loop: 1 };

  // ── Engine: master chain + reverb + music/sfx buses (works on any context) ─
  function makeEngine(ctx, dest, offline) {
    const E = { ctx, offline, mv: [], sv: [], cur: null, loops: {}, fires: {}, stats: { notes: 0, skipped: 0, capped: 0, sfx: 0, sections: [] } };
    const G = () => ctx.createGain();
    E.master = G(); E.master.connect(dest);
    const clip = ctx.createWaveShaper(); clip.curve = (() => { const n = 2048, a = new Float32Array(n); for (let i = 0; i < n; i++) { const x = i / (n - 1) * 4 - 2; a[i] = Math.tanh(x * 1.05) * 0.965; } return a; })();
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -4; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.15;
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -18; glue.knee.value = 10; glue.ratio.value = 2.5; glue.attack.value = 0.02; glue.release.value = 0.3;
    const pre = G(), pg = G(); pg.gain.value = 0.5;   // pre-clip gain: the curve spans +-2, so 0.5 maps full scale onto it
    pre.connect(glue); glue.connect(lim); lim.connect(pg); pg.connect(clip); clip.connect(E.master);
    const conv = ctx.createConvolver(); conv.buffer = impulse(ctx);
    const hp = ctx.createBiquadFilter(), lp = ctx.createBiquadFilter(), rg = G();
    hp.type = 'highpass'; hp.frequency.value = 160; lp.type = 'lowpass'; lp.frequency.value = 4200; rg.gain.value = 0.8;
    conv.connect(hp); hp.connect(lp); lp.connect(rg); rg.connect(pre);
    E.musicIn = G(); E.musicVol = G(); E.musicVol.gain.value = 0.45;
    E.musicIn.connect(E.musicVol); E.musicVol.connect(pre);
    const ms = G(); ms.gain.value = 0.45; E.musicVol.connect(ms); ms.connect(conv);
    E.sfxIn = G(); E.sfxVol = G(); E.sfxIn.connect(E.sfxVol); E.sfxVol.connect(pre);
    // The score (music2.js) plays into its own bus on the same master chain: master volume, the music
    // volume setting and the limiter still apply. The legacy themes below stay only as a fallback.
    E.m2 = !offline && CT.music2 && typeof CT.music2.init === 'function' ? CT.music2 : null;
    if (E.m2) { E.m2In = G(); E.m2In.gain.value = 0.7; E.m2In.connect(pre); try { E.m2.init(ctx, E.m2In); } catch (e) { console.error('[CT.audio] music2', e); E.m2 = null; } }
    const ss = G(); ss.gain.value = 0.22; E.sfxVol.connect(ss); ss.connect(conv);

    E.q = [];   // offline test runs replay the disconnect timers from tick()
    E.later = (fn, ms2) => { if (!offline) setTimeout(fn, Math.max(0, ms2)); else E.q.push([ctx.currentTime + ms2 / 1000, fn]); };
    E.allow = (list, cap, T, end, prio) => {
      if (list.length >= cap * 0.75) { const keep = list.filter(x => x > T); list.length = 0; keep.forEach(x => list.push(x)); }
      if (list.length >= cap && prio < 3) { E.stats.capped++; return false; }
      list.push(end); E.stats.notes++; return true;
    };
    E.music = name => {
      if (E.m2) { E.m2.setMusic(E.m2.tracks.indexOf(name) >= 0 ? name : null); return; }
      name = THEMES[name] ? name : null;
      const prev = E.cur ? E.cur.name : null;
      if (prev === name && !(E.cur && E.cur.done)) return;
      const [fin, fout] = fades(prev, name);
      if (E.cur) E.cur.stop(name ? fout : 2);
      E.cur = name ? player(E, name, fin) : null;
      if (E.cur) E.cur.pump(ctx.currentTime + LOOK);
    };
    E.tick = () => {
      if (E.cur) E.cur.pump(ctx.currentTime + LOOK); E.updateFires();
      if (offline && E.q.length) { const now = ctx.currentTime, due = E.q.filter(x => x[0] <= now); E.q = E.q.filter(x => x[0] > now); due.forEach(x => x[1]()); }
    };
    // One-shot sfx on its own bus (gain, optional distance low-pass, pan); the bus is freed by a timer.
    E.sfx = (name, o, at, lv, pan, dist) => {
      const fn = SFX[name]; if (!fn) return;
      const t = at == null ? ctx.currentTime + 0.01 : at;
      if (!E.allow(E.sv, CAP_S, t, t + (SDUR[name] || 1.2), name === 'step' || name === 'click' ? 1 : 3)) return;
      const bus = G(); bus.gain.value = lv; let head = bus;
      if (dist > 14) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = clamp(9000 - dist * 130, 1200, 9000); f.connect(bus); head = f; }
      if (pan && ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pan; bus.connect(p); p.connect(E.sfxIn); } else bus.connect(E.sfxIn);
      E.stats.sfx++;
      fn({ ctx, out: head }, t, o || {});
      E.later(() => { try { bus.disconnect(); head.disconnect(); } catch (e) { } }, ((SDUR[name] || 1.2) + 1.5) * 1000);
    };
    // Loop beds: rain, wind (global), fire_loop (positional, by id).
    E.loop = (name, o) => {
      const on = o.on !== false, now = ctx.currentTime;
      if (name === 'fire_loop') {
        const id = o.id || 'default', f = E.fires[id];
        if (!on) { if (f) { delete E.fires[id]; E.fadeKill(f, 0.6); } return; }
        if (f) { if (o.pos) f.pos = { x: o.pos.x, y: o.pos.y, z: o.pos.z }; return; }
        if (Object.keys(E.fires).length >= 6) return;
        const s = ctx.createBufferSource(), v = G(), p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
        s.buffer = fireBuf(ctx); s.loop = true; v.gain.value = 0; s.connect(v);
        if (p) { v.connect(p); p.connect(E.sfxIn); } else v.connect(E.sfxIn);
        s.start(now, Math.random() * 3);
        E.fires[id] = { s, v, p, nodes: [s], out: p || v, pos: o.pos ? { x: o.pos.x, y: o.pos.y, z: o.pos.z } : null, lv: o.level || 0.5 };
        E.updateFires(); return;
      }
      const L = E.loops[name];
      if (!on) { if (L) { delete E.loops[name]; E.fadeKill(L, 2); } return; }
      if (L) { L.v.gain.setTargetAtTime(o.level == null ? 1 : o.level, now, 0.8); return; }
      const v = G(), nodes = [], lfo = (f, d, prm) => { const x = ctx.createOscillator(), k = G(); x.frequency.value = f; k.gain.value = d; x.connect(k); k.connect(prm); x.start(now); nodes.push(x); };
      if (name === 'rain') {
        const s = ctx.createBufferSource(), k = G(); s.buffer = rainBuf(ctx); s.loop = true; k.gain.value = 0.32; s.connect(k); k.connect(v); s.start(now, Math.random() * 4); nodes.push(s);
      } else {
        const s = ctx.createBufferSource(), b1 = ctx.createBiquadFilter(), b2 = ctx.createBiquadFilter(), g1 = G(), g2 = G(), gust = G();
        s.buffer = noiseBuf(ctx); s.loop = true; b1.type = b2.type = 'bandpass'; KR(b1.frequency).value = 520; b1.Q.value = 1.2; KR(b2.frequency).value = 1300; b2.Q.value = 4;
        g1.gain.value = 0.5; g2.gain.value = 0.12; gust.gain.value = 0.6;
        s.connect(b1); s.connect(b2); b1.connect(g1); b2.connect(g2); g1.connect(gust); g2.connect(gust); gust.connect(v);
        lfo(0.07, 260, b1.frequency); lfo(0.11, 500, b2.frequency); lfo(0.13, 0.35, gust.gain);
        s.start(now, Math.random()); nodes.push(s);
      }
      v.gain.setValueAtTime(0, now); v.gain.setTargetAtTime(o.level == null ? 1 : o.level, now, 0.8); v.connect(E.sfxIn);
      E.loops[name] = { v, nodes, out: v };
    };
    E.fadeKill = (L, fade) => {
      const now = ctx.currentTime; L.v.gain.cancelScheduledValues(now); L.v.gain.setTargetAtTime(0, now, fade / 4);
      L.nodes.forEach(n => { try { n.stop(now + fade + 0.2); } catch (e) { } });
      E.later(() => { try { L.out.disconnect(); L.v.disconnect(); } catch (e) { } }, (fade + 0.5) * 1000);
    };
    E.updateFires = () => {
      Object.keys(E.fires).forEach(id => {
        const f = E.fires[id], sp = spatial(f.pos), now = ctx.currentTime;
        f.v.gain.setTargetAtTime(sp ? f.lv * sp.lv : 0, now, 0.2);
        if (f.p && sp) f.p.pan.setTargetAtTime(sp.pan, now, 0.2);
      });
    };
    E.volume = (m, mu, s) => {
      const now = ctx.currentTime, set = (p, v) => { p.cancelScheduledValues(now); p.setTargetAtTime(v, now, 0.05); };
      set(E.master.gain, clamp(m, 0, 1)); set(E.musicVol.gain, 0.45 * clamp(mu, 0, 1)); set(E.sfxVol.gain, clamp(s, 0, 1));
      if (E.m2In) set(E.m2In.gain, 0.7 * clamp(mu, 0, 1));
    };
    return E;
  }

  // ── Distance attenuation + pan from the camera (silent by ~60 m) ───────────
  function spatial(pos) {
    const cam = CT.core && CT.core.camera;
    if (!pos || !cam) return { lv: 1, pan: 0, dist: 0 };
    const dx = pos.x - cam.position.x, dy = (pos.y || 0) - cam.position.y, dz = pos.z - cam.position.z, d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d >= 60) return null;
    const m = cam.matrixWorld && cam.matrixWorld.elements, lv = Math.pow(1 - d / 60, 1.6) / (1 + d / 14);
    let pan = 0;
    if (m && d > 0.01) pan = clamp((dx * m[0] + dy * m[1] + dz * m[2]) / d * Math.min(1, d / 2), -0.85, 0.85);
    return { lv, pan, dist: d };
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  let E = null, pending = null, timer = 0;
  const vol = [1, 1, 1], pendLoops = {};
  function init() {
    if (!AC) return;
    if (!E) {
      let ctx; try { ctx = new AC(); } catch (e) { return; }
      E = makeEngine(ctx, ctx.destination, false);
      try { const v = parseFloat(localStorage.getItem('crimsonThrone.vol')); if (v >= 0 && v <= 1) vol[0] = v; } catch (e) { }   // ui.js persists the volume setting
      E.volume(vol[0], vol[1], vol[2]);
      const b = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0);   // iOS unlock
      timer = setInterval(() => { try { E.tick(); } catch (e) { console.error('[CT.audio.tick]', e); clearInterval(timer); } }, TICK);
      document.addEventListener('visibilitychange', () => { if (E) E.tick(); });
      if (pending) E.music(pending);
      Object.keys(pendLoops).forEach(k => E.loop(k, pendLoops[k]));
      // Pre-bake the gore / foley cache in idle slices so the first kill never hitches.
      const list = [];
      ['flesh', 'bone', 'splat', 'spurt', 'slice', 'clang'].forEach(k => { for (let v = 0; v < 4; v++) list.push(() => goreBuf(ctx, k, v)); });
      ['soft', 'dirt', 'stone'].forEach(k => { for (let v = 0; v < 4; v++) list.push(() => stepBuf(ctx, k, v)); });
      list.push(() => fireBuf(ctx), () => drumBuf(ctx, 'K'), () => drumBuf(ctx, 'x'));
      [45, 52, 57, 61, 64].forEach(m => list.push(() => choirBuf(ctx, m, 'ah'))); [38, 45, 50, 53].forEach(m => list.push(() => choirBuf(ctx, m, 'oh')));
      const step = () => { const f = list.shift(); if (!f) return; f(); setTimeout(step, 30); };
      setTimeout(step, 400);
    }
    if (E.ctx.state !== 'running' && E.ctx.resume) { try { E.ctx.resume().catch(() => { }); } catch (e) { } }
  }
  const api = {
    init,
    setMusic(name) { pending = name || null; if (E) E.music(pending); },
    sfx(name, opts) {
      opts = opts || {};
      if (LOOPS[name]) { if (E) E.loop(name, opts); else if (name !== 'fire_loop') pendLoops[name] = opts; return; }
      if (!E || !SFX[name] || E.ctx.state === 'closed') return;
      const sp = spatial(opts.pos); if (!sp) return;
      let lv = sp.lv * (opts.volume == null ? 1 : opts.volume);
      if (name === 'thunder' && opts.dist) lv *= clamp(1.3 / (1 + opts.dist / 600), 0.12, 1);
      if (lv < 0.004) return;
      E.sfx(name, opts, null, lv, sp.pan, sp.dist);
    },
    setVolume(master, music, sfx) {
      vol[0] = master == null ? vol[0] : +master; vol[1] = music == null ? vol[1] : +music; vol[2] = sfx == null ? vol[2] : +sfx;
      if (E) E.volume(vol[0], vol[1], vol[2]);
    },
    // Test hooks: render a theme or an sfx into any (Offline)AudioContext.
    _render(ctx, name, seconds, opts) {
      const X = api._last = makeEngine(ctx, ctx.destination, true);
      if (THEMES[name] && !(opts && opts.sfx)) { X.music(name); for (let i = 0; i < 64 && X.cur && !X.cur.done; i++) X.cur.pump(seconds); }
      else X.sfx(name, opts || {}, 0.05, 1, 0, 0);
      return X;
    },
    _engine: makeEngine, _T: THEMES, _sfx: Object.keys(SFX), _loops: Object.keys(LOOPS), _spatial: spatial,
    _bake: { ks: ksBuf, str: strBuf, bell: bellBuf, drum: drumBuf, gore: goreBuf, step: stepBuf, fire: fireBuf, rain: rainBuf, ir: impulse },
    _build: buildSection,
    _state() { return E ? { ctx: E.ctx.state, music: E.m2 ? (E.m2._stats() || {}).cur : E.cur && E.cur.name, score: E.m2 ? E.m2._stats() : null, done: E.cur && E.cur.done, mv: E.mv.length, sv: E.sv.length, loops: Object.keys(E.loops), fires: Object.keys(E.fires), stats: E.stats } : { pending }; },
  };
  // Browsers need a gesture to start audio: the first gesture inits (title music if the gate was skipped).
  const wake = () => {
    ['pointerdown', 'keydown', 'touchend'].forEach(ev => window.removeEventListener(ev, wake));
    try { if (!pending && CT.core && CT.core.state === 'TITLE') pending = 'title'; init(); } catch (e) { }
  };
  ['pointerdown', 'keydown', 'touchend'].forEach(ev => window.addEventListener(ev, wake));
  CT.audio = api;
})();
