// ─── MUSIC2: a cinematic medieval score, synthesised at runtime (no files, no network) ─────────
// CT.music2 = { init(ctx, destination), setMusic(name), render(name, seconds) -> Promise<AudioBuffer>,
//               setVolume(v), prefetch(name), tracks }
// Every phrase, chord note and drum hit is rendered sample by sample by the DSP module below into
// an AudioBuffer (in a Blob Web Worker at runtime; synchronously for offline renders), cached by
// content, and scheduled by a look-ahead player as cheap buffer sources. Crash-safety rules from
// audio.js: no onended; each 4 s chunk plays into its own bus that a timer disconnects after its
// tail; stale notes are dropped after a stall; a voice cap; per-track convolution reverb; a master
// glue compressor, a limiter and a soft clip.
// Sources: Tourdion (Attaingnant 1530), Saltarello (London BL Add. 29987, 14th c.), Stella Splendens
// (Llibre Vermell, 14th c.), Ai vist lo lop (Occitan trad.), Greensleeves (16th c. English),
// Dies irae (Gregorian sequence, mode 1). The Crimson Throne theme and all arrangements are original.
window.CT = window.CT || {};
(function () {
  'use strict';

  // ════════ DSP: sample-level instrument models. Self-contained: also runs inside a Worker ════════
  function DSP() {
    const TAU = Math.PI * 2, SEMI = Math.LN2 / 12, DN = 1e-18;
    const mtof = m => 440 * Math.exp((m - 69) * SEMI);
    const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
    function rng(seed) {
      let s = (seed >>> 0) || 1;
      return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    }
    function hs(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
    // RBJ biquads over arrays: lp hp bp pk ls hs
    function coef(type, f, q, db, sr) {
      const w = TAU * Math.min(f, sr * 0.47) / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * q), A = Math.pow(10, (db || 0) / 40);
      let b0, b1, b2, a0, a1, a2;
      if (type === 'lp') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
      else if (type === 'hp') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
      else if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
      else if (type === 'pk') { b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A; }
      else {
        const s = 2 * Math.sqrt(A) * al;
        if (type === 'ls') { b0 = A * ((A + 1) - (A - 1) * cs + s); b1 = 2 * A * ((A - 1) - (A + 1) * cs); b2 = A * ((A + 1) - (A - 1) * cs - s); a0 = (A + 1) + (A - 1) * cs + s; a1 = -2 * ((A - 1) + (A + 1) * cs); a2 = (A + 1) + (A - 1) * cs - s; }
        else { b0 = A * ((A + 1) + (A - 1) * cs + s); b1 = -2 * A * ((A - 1) + (A + 1) * cs); b2 = A * ((A + 1) + (A - 1) * cs - s); a0 = (A + 1) - (A - 1) * cs + s; a1 = 2 * ((A - 1) - (A + 1) * cs); a2 = (A + 1) - (A - 1) * cs - s; }
      }
      return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
    }
    function filt(d, sr, type, f, q, db) {
      const c = coef(type, f, q, db, sr), b0 = c[0], b1 = c[1], b2 = c[2], a1 = c[3], a2 = c[4];
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < d.length; i++) { const x = d[i] + DN, y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; d[i] = y; }
      return d;
    }
    const chain = (d, sr, list) => { for (let i = 0; i < list.length; i++) filt(d, sr, list[i][0], list[i][1], list[i][2], list[i][3]); return d; };
    const white = (n, r) => { const d = new Float32Array(n); for (let i = 0; i < n; i++) d[i] = r() * 2 - 1; return d; };
    function blep(t, dt) { if (t < dt) { t /= dt; return t + t - t * t - 1; } if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; } return 0; }
    const panLR = p => { const a = (clamp(p, -1, 1) + 1) * Math.PI / 4; return [Math.cos(a), Math.sin(a)]; };
    function peakOf(chs) { let m = 0; for (const d of chs) for (let i = 0; i < d.length; i++) { const v = d[i] < 0 ? -d[i] : d[i]; if (v > m) m = v; } return m; }
    function scale(chs, k) { for (const d of chs) for (let i = 0; i < d.length; i++) d[i] *= k; }
    function normPeak(chs, target) { const p = peakOf(chs); if (p > 1e-9) scale(chs, target / p); return chs; }
    function normRms(chs, target, i0, i1, cap) {
      let s = 0, c = 0; i0 = Math.max(0, i0 | 0); i1 = Math.min(chs[0].length, i1 | 0);
      for (const d of chs) for (let i = i0; i < i1; i++) { s += d[i] * d[i]; c++; }
      if (s > 0) scale(chs, target / Math.sqrt(s / c));
      const p = peakOf(chs); if (p > cap) scale(chs, cap / p);
      return chs;
    }
    function fades(chs, sr, fin, fout) {
      const n = chs[0].length, a = Math.min(n, Math.floor(fin * sr)), b = Math.min(n, Math.floor(fout * sr));
      for (const d of chs) { for (let i = 0; i < a; i++) d[i] *= i / a; for (let i = 0; i < b; i++) d[n - 1 - i] *= i / b; }
      return chs;
    }
    // Decaying sine partials: parts = [[ratio, amp, t60]]
    function modal(d, sr, off, f0, parts, tsc, amp) {
      for (const [ratio, a, t60] of parts) {
        const f = f0 * ratio; if (f > sr * 0.45) continue;
        const w = TAU * f / sr, c2 = 2 * Math.cos(w), k = Math.exp(-6.9 / (t60 * tsc * sr));
        let s1 = Math.sin(-w), s2 = Math.sin(-2 * w), e = a * amp;
        for (let i = off; i < d.length && e > 1e-6; i++) { const s = c2 * s1 - s2; s2 = s1; s1 = s; d[i] += s * e; e *= k; }
      }
    }

    // ── Expressive performance: per-sample pitch (Hz) and amplitude for a phrase ──────────────
    // notes: [t, d, midi, flags]; flags: _ slur into next, . staccato, ^ accent, , soft,
    // c cut (upper grace), t tap (lower grace), ~ roll, m mordent, w trill.
    function perform(raw, n, sr, o, r) {
      const notes = raw.map(x => {
        const f = x[3] || '';
        return { t: x[0], d: x[1], m: x[2], sl: f.indexOf('_') >= 0, st: f.indexOf('.') >= 0, ac: f.indexOf('^') >= 0, so: f.indexOf(',') >= 0,
          orn: f.indexOf('~') >= 0 ? 'r' : f.indexOf('c') >= 0 ? 'c' : f.indexOf('t') >= 0 ? 't' : f.indexOf('m') >= 0 ? 'm' : f.indexOf('w') >= 0 ? 'w' : '' };
      });
      const F = new Float32Array(n), A = new Float32Array(n), ons = [];
      const K = tau => 1 - Math.exp(-1 / (Math.max(tau, 1e-4) * sr));
      const upK = K(o.att), dnK = K(o.rel), endK = K(o.rel2), kv = K(0.09), kj = K(0.1), scK = K(o.scoopT || 0.05), jumpK = K(o.jump), glideK = K(o.glide), fastK = K(0.004);
      const N = notes.length, tEnd = notes[N - 1].t + notes[N - 1].d, vw = r() * TAU;
      let ni = -1, p = notes[0].m, gk = jumpK, a = 0, vd = 0, vph = r() * TAU, jv = 0, jt = 0, sc = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        while (ni + 1 < N && t >= notes[ni + 1].t) {
          ni++;
          const nt = notes[ni], pv = ni > 0 ? notes[ni - 1] : null;
          nt.leg = !!(pv && pv.sl && nt.t - (pv.t + pv.d) < 0.03);
          gk = nt.leg ? glideK : jumpK;
          if (!nt.leg && o.scoop) sc = -o.scoop * (nt.ac ? 1.3 : 1) * (0.6 + 0.4 * r());
          ons.push([i, nt.ac ? 1 : nt.so ? 0.5 : 0.8, nt.leg ? 1 : 0]);
        }
        let tg = 0, lt = 0, nt = null;
        if (ni >= 0) {
          nt = notes[ni]; lt = t - nt.t;
          let m = nt.m, k = gk;
          if (nt.orn) {
            const q = nt.orn;
            if (q === 'c') { if (lt < 0.04) { m += 2; k = fastK; } }
            else if (q === 't') { if (lt < 0.035) { m -= 2; k = fastK; } }
            else if (q === 'r') { if (lt < 0.04) m += 2; else if (lt >= 0.1 && lt < 0.135) m -= 2; if (lt < 0.16) k = fastK; }
            else if (q === 'm') { if (lt >= 0.05 && lt < 0.1) m += 2; if (lt < 0.13) k = fastK; }
            else if (q === 'w' && lt < nt.d * 0.65) { if (Math.floor(lt / 0.06) % 2 === 1) m += 2; k = fastK; }
          }
          p += (m - p) * k;
          const end = nt.t + nt.d * (nt.st ? 0.42 : nt.sl ? 1.03 : o.leg);
          if (t < end) {
            tg = nt.ac ? 1 : nt.so ? 0.55 : 0.8;
            const nx = ni + 1 < N ? notes[ni + 1] : null;
            if (nx && !nt.sl && nx.t - t < o.dipW && nx.t - (nt.t + nt.d) < 0.03) tg *= 1 - o.dip;
            if (o.swell && nt.d > 0.8) tg *= 1 + o.swell * (Math.sin(Math.PI * clamp(lt / nt.d, 0, 1)) - 0.5);
            if (nt.ac && lt < 0.08) tg *= 1.22;
          }
        }
        sc -= sc * scK;
        const vdT = nt ? (nt.d > 0.3 ? o.vib * clamp((lt - o.vdel) / o.vrise, 0, 1) : o.vib * 0.15) : 0;
        vd += (vdT - vd) * kv;
        vph += TAU * o.vr * (1 + 0.04 * Math.sin(t * 0.9 + vw)) / sr;
        if ((i & 511) === 0) jt = (r() * 2 - 1) * o.jit;
        jv += (jt - jv) * kj;
        F[i] = mtof(p + (sc + vd * Math.sin(vph) + jv) / 100);
        a += (tg - a) * (tg > a ? upK : ni === N - 1 && t >= tEnd - 0.002 ? endK : dnK);
        A[i] = a;
      }
      return { F, A, ons };
    }
    const lenOf = (notes, tail) => { const l = notes[notes.length - 1]; return l[0] + l[1] + tail; };

    // ── Bowed strings: band-limited saw, bow noise synced to stick-slip, dynamic brightness,
    //    a body-resonance filter bank, delayed vibrato, scoops, portamento, ensemble detune ──
    const BODY = {
      fiddle: [['hp', 190, .7], ['pk', 285, 4, 5], ['pk', 480, 3, 3.5], ['pk', 1150, 1.2, -3], ['pk', 2700, 1.3, 2], ['pk', 4200, 1.2, -2], ['lp', 7800, .7], ['lp', 10000, .6]],
      viol: [['hp', 105, .7], ['pk', 220, 3, 5], ['pk', 410, 2.5, 3], ['pk', 1000, 1.2, -2.5], ['pk', 1900, 1.3, 2.5], ['lp', 5800, .7], ['lp', 8500, .6]],
      cello: [['hp', 55, .7], ['pk', 105, 3, 3], ['pk', 205, 3, 4], ['pk', 410, 2, 1], ['pk', 1400, 1.3, 1.5], ['lp', 4800, .7], ['lp', 7000, .6]],
      bass: [['hp', 44, .8], ['pk', 70, 3, 1], ['pk', 140, 2, 3], ['pk', 300, 1, -2], ['lp', 2300, .7], ['lp', 4000, .6]],
    };
    const BOWP = {
      fiddle: { glide: .05, jump: .007, scoop: 22, scoopT: .05, vib: 17, vr: 5.6, vdel: .2, vrise: .45, jit: 4, att: .05, rel: .07, rel2: .28, dip: .42, dipW: .055, leg: .97, swell: .22, bright: 5000, noise: .045 },
      viol: { glide: .06, jump: .008, scoop: 18, scoopT: .06, vib: 11, vr: 5.2, vdel: .25, vrise: .5, jit: 4, att: .065, rel: .08, rel2: .3, dip: .4, dipW: .06, leg: .97, swell: .25, bright: 4400, noise: .05 },
      cello: { glide: .07, jump: .01, scoop: 16, scoopT: .07, vib: 15, vr: 5.2, vdel: .25, vrise: .5, jit: 3, att: .08, rel: .09, rel2: .35, dip: .38, dipW: .07, leg: .97, swell: .25, bright: 3400, noise: .04 },
      bass: { glide: .08, jump: .012, scoop: 10, scoopT: .08, vib: 7, vr: 5, vdel: .3, vrise: .6, jit: 2, att: .1, rel: .1, rel2: .35, dip: .35, dipW: .08, leg: .97, swell: .2, bright: 1500, noise: .03 },
    };
    function bow(a, sr) {
      const P = BOWP[a.kind], nv = a.n || 1, r = rng(a.seed || 1), notes = a.notes;
      const stac = notes.length === 1 && (notes[0][3] || '').indexOf('.') >= 0;
      const Pv = Object.assign({}, P, stac ? { att: .01, rel: .05, rel2: .08, scoop: 6, vib: 0 } : null, a.att ? { att: a.att } : null, a.rel2 ? { rel2: a.rel2 } : null);
      const n = Math.ceil(lenOf(notes, Pv.rel2 * 3.5 + 0.12) * sr);
      const L = new Float32Array(n), R = (nv > 1 || a.pc) && !a.mono ? new Float32Array(n) : null, bright = P.bright * (a.bright || 1);
      for (let v = 0; v < nv; v++) {
        const det = nv > 1 ? (v - (nv - 1) / 2) * (a.det || 7) + (r() - 0.5) * 4 : 0, off = nv > 1 ? r() * (a.tight ? 0.006 : 0.024) : 0;
        const ns = notes.map((x, i) => [x[0] + (i ? off * r() : off), x[1], x[2] + det / 100, x[3]]);
        const o = Object.assign({}, Pv, { vr: Pv.vr * (0.92 + r() * 0.16), vib: Pv.vib * (a.vib == null ? 1 : a.vib) * (0.8 + r() * 0.4) });
        const pf = perform(ns, n, sr, o, r), F = pf.F, A = pf.A, x = new Float32Array(n), nz = filt(white(n, r), sr, 'bp', 2400, 0.6);
        const m1 = r() * TAU, m2 = r() * TAU;
        let ph = r(), lp = 0, lk = 0, pres = 1;
        for (let i = 0; i < n; i++) {
          const f = F[i], dt = f / sr; ph += dt; if (ph >= 1) ph -= 1;
          if ((i & 31) === 0) {
            const t = i / sr; pres = 1 + 0.035 * Math.sin(TAU * 1.3 * t + m1) + 0.025 * Math.sin(TAU * 2.9 * t + m2);
            lk = Math.exp(-TAU * Math.min(bright * (0.25 + 0.75 * Math.min(1, A[i])) + f * 2, sr * 0.45) / sr);
          }
          const e = A[i] * pres, s = (2 * ph - 1 - blep(ph, dt)) * e + nz[i] * e * P.noise * (ph < 0.35 ? 1.6 : 0.5);
          lp += (1 - lk) * (s - lp); x[i] = lp;
        }
        const scr = Math.floor(0.028 * sr);
        for (const on of pf.ons) { if (on[2]) continue; const i0 = on[0]; for (let k = 0; k < scr && i0 + k < n; k++) x[i0 + k] += nz[i0 + k] * on[1] * 0.1 * (1 - k / scr) * (stac ? 2 : 1); }
        chain(x, sr, BODY[a.kind]);
        if (R) {
          const g = panLR((nv > 1 ? (v / (nv - 1) * 2 - 1) * (a.spread == null ? 0.6 : a.spread) : 0) + (a.pc || 0));
          for (let i = 0; i < n; i++) { L[i] += x[i] * g[0]; R[i] += x[i] * g[1]; }
        } else for (let i = 0; i < n; i++) L[i] += x[i];
      }
      const chs = R ? [L, R] : [L];
      return fades(normPeak(chs, 0.7), sr, 0, 0.05);
    }

    // ── Voice and choir: glottal saw + aspiration through a 5-formant Klatt cascade whose vowels
    //    move (keyframes), per-singer vibrato, jitter, formant scale; F1 tracks f0 for sopranos ──
    const VT = {
      B: { a: [[600, 1040, 2250, 2450, 2750], [60, 70, 110, 120, 130]], e: [[400, 1620, 2400, 2800, 3100], [40, 80, 100, 120, 120]], i: [[250, 1750, 2600, 3050, 3340], [60, 90, 100, 120, 120]], o: [[400, 750, 2400, 2600, 2900], [40, 80, 100, 120, 120]], u: [[350, 600, 2400, 2675, 2950], [40, 80, 100, 120, 120]] },
      T: { a: [[650, 1080, 2650, 2900, 3250], [80, 90, 120, 130, 140]], e: [[400, 1700, 2600, 3200, 3580], [70, 80, 100, 120, 120]], i: [[290, 1870, 2800, 3250, 3540], [40, 90, 100, 120, 120]], o: [[400, 800, 2600, 2800, 3000], [40, 80, 100, 120, 120]], u: [[350, 600, 2700, 2900, 3300], [40, 60, 100, 120, 120]] },
      A: { a: [[800, 1150, 2800, 3500, 4950], [80, 90, 120, 130, 140]], e: [[400, 1600, 2700, 3300, 4950], [60, 80, 120, 150, 200]], i: [[350, 1700, 2700, 3700, 4950], [50, 100, 120, 150, 200]], o: [[450, 800, 2830, 3500, 4950], [70, 80, 100, 130, 135]], u: [[325, 700, 2530, 3500, 4950], [50, 60, 170, 180, 200]] },
      S: { a: [[800, 1150, 2900, 3900, 4950], [80, 90, 120, 130, 140]], e: [[350, 2000, 2800, 3600, 4950], [60, 100, 120, 150, 200]], i: [[270, 2140, 2950, 3900, 4950], [60, 90, 100, 120, 120]], o: [[450, 800, 2830, 3800, 4950], [70, 80, 100, 130, 135]], u: [[325, 700, 2700, 3800, 4950], [50, 60, 170, 180, 200]] },
    };
    function vowelAt(kf, T, t, out) {
      let j = 0; while (j + 1 < kf.length && kf[j + 1][0] <= t) j++;
      const k0 = kf[j], k1 = kf[j + 1], v0 = T[k0[1]] || T.a;
      if (!k1 || t <= k0[0]) { for (let k = 0; k < 5; k++) { out[k] = v0[0][k]; out[5 + k] = v0[1][k]; } return out; }
      const v1 = T[k1[1]] || T.a, x = clamp((t - k0[0]) / Math.max(1e-3, k1[0] - k0[0]), 0, 1), s = x * x * (3 - 2 * x);
      for (let k = 0; k < 5; k++) { out[k] = v0[0][k] + (v1[0][k] - v0[0][k]) * s; out[5 + k] = v0[1][k] + (v1[1][k] - v0[1][k]) * s; }
      return out;
    }
    const VOXP = { glide: .07, jump: .03, scoop: 25, scoopT: .08, vib: 22, vr: 5.3, vdel: .3, vrise: .6, jit: 6, att: .3, rel: .15, rel2: .45, dip: .15, dipW: .07, leg: 1, swell: .15 };
    const VOXS = { vib: 32, vr: 5.5, att: .09, rel: .1, rel2: .35, vdel: .22, vrise: .45, jit: 5, dip: .2, glide: .06, jump: .025 };
    function voice(a, sr) {
      const reg = a.reg || 'T', T = VT[reg], nv = a.n || 1, r = rng(a.seed || 11), fem = reg === 'S' || reg === 'A';
      const P = Object.assign({}, VOXP, a.solo ? VOXS : null);
      for (const k of ['att', 'rel2', 'glide', 'jump', 'scoop']) if (a[k] != null) P[k] = a[k];
      const notes = a.notes, n = Math.ceil(lenOf(notes, P.rel2 * 3.5 + 0.12) * sr);
      let kf = a.vp;
      if (!kf) {
        kf = []; let pv = null;
        for (const x of notes) { const v = x[4] || a.vow || 'a'; if (pv && pv !== v) kf.push([x[0], pv]); kf.push([x[0] + (pv && pv !== v ? Math.min(0.09, x[1] * 0.5) : 0), v]); pv = v; }
      }
      const stereo = (nv > 1 || a.pc != null) && !a.mono, L = new Float32Array(n), R = stereo ? new Float32Array(n) : null;
      const eff = a.eff == null ? 0.5 : a.eff, br = a.breath == null ? (fem ? 0.1 : 0.06) : a.breath, bwm = a.bw || 1.5;
      const fm = new Float64Array(10), y1 = new Float64Array(5), y2 = new Float64Array(5), cA = new Float64Array(5), cB = new Float64Array(5), cC = new Float64Array(5);
      for (let s = 0; s < nv; s++) {
        const det = nv > 1 ? (r() - 0.5) * 18 : 0, off = nv > 1 ? r() * 0.05 : 0;
        const ns = notes.map((x, i) => [x[0] + (i ? off * 0.4 : off), x[1], x[2] + det / 100, x[3]]);
        const o = Object.assign({}, P, { vr: P.vr * (0.92 + r() * 0.16), vib: P.vib * (a.vib == null ? 1 : a.vib) * (0.75 + r() * 0.5) });
        const pf = perform(ns, n, sr, o, r), F = pf.F, A = pf.A, out = new Float32Array(n), nz = white(n, r);
        const tk = Math.exp(-TAU * Math.min(sr * 0.4, 900 + eff * 4200) / sr), fs = (a.fs || 1) * (1 + (r() - 0.5) * 0.07);
        let ph = r(), tl = 0; y1.fill(0); y2.fill(0);
        for (let i = 0; i < n; i++) {
          if ((i & 31) === 0) {
            vowelAt(kf, T, i / sr, fm);
            const f0 = F[i];
            for (let k = 0; k < 5; k++) {
              let Fk = fm[k] * fs; const Bk = Math.max(fm[5 + k] * bwm, 60);
              if (k === 0 && fem && Fk < f0 * 1.1) Fk = f0 * 1.1;
              if (k === 1 && Fk < fm[0] * fs + 250) Fk = fm[0] * fs + 250;
              Fk = Math.min(Fk, sr * 0.42);
              const e = Math.exp(-Math.PI * Bk / sr); cC[k] = -e * e; cB[k] = 2 * e * Math.cos(TAU * Fk / sr); cA[k] = 1 - cB[k] - cC[k];
            }
          }
          const f = F[i], dt = f / sr; ph += dt; if (ph >= 1) ph -= 1;
          const saw = 2 * ph - 1 - blep(ph, dt), src = a.pure ? 0.8 * Math.sin(TAU * ph) + 0.25 * saw : saw;
          tl += (1 - tk) * (src - tl);
          const env = A[i];
          let x = tl * env + nz[i] * env * br * (ph < 0.5 ? 1 : 0.4) + DN;
          if (a.h) { const t = i / sr, h = t < 0.06 ? 1 : Math.exp(-(t - 0.06) / 0.035); x += nz[i] * a.h * h * 0.5; }
          for (let k = 0; k < 5; k++) { const y = cA[k] * x + cB[k] * y1[k] + cC[k] * y2[k]; y2[k] = y1[k]; y1[k] = y; x = y; }
          out[i] = x;
        }
        filt(out, sr, 'hp', fem ? 140 : 70, 0.7);
        if (!a.pure) filt(out, sr, 'pk', fem ? 3200 : 2800, 1.3, 6 + eff * 4);
        if (R) {
          const g = panLR((a.pc || 0) + (nv > 1 ? (s / (nv - 1) * 2 - 1) * (a.spread == null ? 0.3 : a.spread) : 0));
          for (let i = 0; i < n; i++) { L[i] += out[i] * g[0]; R[i] += out[i] * g[1]; }
        } else for (let i = 0; i < n; i++) L[i] += out[i];
      }
      const chs = R ? [L, R] : [L], l0 = notes[0][0], l1 = notes[notes.length - 1][0] + notes[notes.length - 1][1];
      normRms(chs, a.rms || 0.11, l0 * sr, l1 * sr, 0.95);
      return fades(chs, sr, 0, 0.05);
    }

    // ── Plucked: Karplus-Strong with an exact fractional delay (allpass), a one-pole loss filter
    //    compensated for pitch, a pick-position comb, double courses, and a body filter ──
    const PLK = {
      harp: { t60: 4.2, b: 0.14, beta: 0.2, ex: 0.3, course: 1, len: 2.6, body: [['hp', 55, .7], ['pk', 190, 1.2, 3], ['pk', 420, 1.5, 2], ['pk', 2600, 1, -1], ['lp', 6800, .7]] },
      lute: { t60: 1.9, b: 0.22, beta: 0.13, ex: 0.5, course: 2, det: 1.6, len: 2.2, body: [['hp', 75, .7], ['pk', 125, 2, 4], ['pk', 270, 2, 4], ['pk', 520, 2, 2], ['pk', 2400, 1.5, 2], ['lp', 7000, .7]] },
      cittern: { t60: 2.6, b: 0.1, beta: 0.1, ex: 0.7, course: 2, det: 2.2, len: 2.6, body: [['hp', 140, .7], ['pk', 400, 1.5, 3], ['pk', 2900, 1.2, 2], ['lp', 8000, .7]] },
    };
    function ks(out, f, t60, P, vel, r, sr, gain) {
      const Pd = sr / f, b = clamp(P.b * (1.25 - vel * 0.45), 0.02, 0.6), w = TAU * f / sr;
      const lpd = Math.atan2(b * Math.sin(w), 1 - b * Math.cos(w)) / w, mag = (1 - b) / Math.sqrt(1 - 2 * b * Math.cos(w) + b * b);
      const tot = Pd - lpd; let N = Math.floor(tot - 0.2); if (N < 2) N = 2;
      const frac = tot - N, C = (1 - frac) / (1 + frac), g = Math.min(0.99999, Math.pow(10, -3 / (t60 * f)) / mag);
      const E = Math.max(2, Math.round(Pd)), ex = new Float32Array(E), ea = clamp(P.ex * (0.45 + vel * 0.7), 0.05, 1);
      let lp = 0; for (let i = 0; i < E; i++) { lp += ea * ((r() * 2 - 1) - lp); ex[i] = lp; }
      const pp = Math.max(1, Math.round(E * P.beta)), e0 = ex.slice(); for (let i = pp; i < E; i++) ex[i] = e0[i] - e0[i - pp];
      const buf = new Float32Array(N); let idx = 0, apx = 0, apy = 0, ly = 0;
      for (let i = 0; i < out.length; i++) {
        const dl = buf[idx], ap = C * dl + apx - C * apy; apx = dl; apy = ap;
        ly = (1 - b) * ap + b * ly + DN;
        const y = (i < E ? ex[i] * vel : 0) + g * ly;
        buf[idx] = y; if (++idx >= N) idx = 0;
        out[i] += y * gain;
      }
    }
    function pluck(a, sr) {
      const P = PLK[a.kind], r = rng(a.seed || (a.m * 131 + 7)), f = mtof(a.m), vel = a.v || 0.8, sc = clamp(Math.sqrt(220 / f), 0.35, 1.8);
      const t60 = P.t60 * sc, len = Math.min(P.len * clamp(sc, 0.5, 1.4), t60 * 1.05) + 0.05, n = Math.ceil(len * sr), out = new Float32Array(n);
      ks(out, f, t60, P, vel, r, sr, 1);
      if (P.course > 1) ks(out, a.m < 55 ? f * 2 : f * Math.pow(2, P.det / 1200), t60 * (a.m < 55 ? 0.7 : 1), P, vel, r, sr, a.m < 55 ? 0.35 : 0.8);
      chain(out, sr, P.body);
      const cl = Math.floor(0.004 * sr), nz = filt(white(cl, r), sr, 'hp', 1800, 0.7);
      for (let i = 0; i < cl; i++) out[i] += nz[i] * 0.08 * vel * (1 - i / cl);
      return fades(normPeak([out], 0.6 * (0.6 + 0.4 * vel)), sr, 0.0005, Math.min(0.4, len * 0.3));
    }

    // ── Winds: recorder / whistle / low whistle (additive + pitched breath + chiff);
    //    shawm / bombard / goblin pipes (band-limited saw+pulse reed, drive, nasal formants) ──
    const WND = {
      recorder: { h: [1, .1, .045, .02], br: .04, chiff: .3, lp: 7500, glide: .012, jump: .005, scoop: 0, vib: 4, vr: 4.8, vdel: .35, vrise: .5, jit: 3, att: .02, rel: .03, rel2: .09, dip: .6, dipW: .035, leg: .95, swell: .1, trem: .025 },
      whistle: { h: [1, .3, .13, .06, .025], br: .05, chiff: .35, lp: 8500, glide: .01, jump: .004, scoop: 0, vib: 5, vr: 5, vdel: .3, vrise: .4, jit: 3, att: .018, rel: .03, rel2: .08, dip: .6, dipW: .03, leg: .95, swell: .08, trem: .03 },
      lowwhistle: { h: [1, .18, .07, .025], br: .08, chiff: .25, lp: 5800, glide: .015, jump: .006, scoop: 0, vib: 11, vr: 4.6, vdel: .3, vrise: .6, jit: 3, att: .045, rel: .05, rel2: .25, dip: .5, dipW: .04, leg: .96, swell: .2, trem: .05 },
    };
    const REED = {
      shawm: { saw: .55, pul: .6, duty: .3, drive: 1.8, br: .02, body: [['hp', 280, .7], ['pk', 1150, 2.2, 7], ['pk', 2450, 2.2, 3], ['pk', 3900, 1.5, -6], ['lp', 4800, .7], ['lp', 7000, .7]], glide: .015, jump: .006, scoop: 35, scoopT: .03, vib: 8, vr: 6.1, vdel: .25, vrise: .4, jit: 6, att: .025, rel: .04, rel2: .1, dip: .55, dipW: .035, leg: .94, swell: .08 },
      bombard: { saw: .6, pul: .55, duty: .35, drive: 1.6, br: .02, body: [['hp', 150, .7], ['pk', 720, 2.2, 7], ['pk', 1650, 2, 3], ['pk', 3200, 1.5, -6], ['lp', 3700, .7], ['lp', 6000, .7]], glide: .018, jump: .007, scoop: 30, scoopT: .035, vib: 7, vr: 5.8, vdel: .3, vrise: .4, jit: 5, att: .03, rel: .045, rel2: .12, dip: .5, dipW: .04, leg: .94, swell: .08 },
      pipes: { saw: .7, pul: .4, duty: .22, drive: 1.4, br: .03, body: [['hp', 450, .7], ['pk', 1700, 2, 5], ['pk', 3100, 2, -1], ['pk', 4200, 1.5, -7], ['lp', 5000, .7]], glide: .01, jump: .004, scoop: 40, scoopT: .025, vib: 14, vr: 6.6, vdel: .15, vrise: .3, jit: 9, att: .015, rel: .03, rel2: .07, dip: .6, dipW: .03, leg: .92, swell: .05 },
    };
    function wind(a, sr) {
      if (REED[a.kind]) return reed(a, sr);
      const P = WND[a.kind], r = rng(a.seed || 3), notes = a.notes, n = Math.ceil(lenOf(notes, P.rel2 * 3.5 + 0.1) * sr);
      const o = Object.assign({}, P, { vr: P.vr * (0.95 + r() * 0.1) });
      const pf = perform(notes, n, sr, o, r), F = pf.F, A = pf.A, out = new Float32Array(n), nz = white(n, r), H = P.h, tr = r() * TAU;
      let ph = 0, lo = 0, bp = 0, fq = 0;
      for (let i = 0; i < n; i++) {
        const f = F[i]; ph += f / sr; if (ph >= 1) ph -= 1;
        if ((i & 15) === 0) fq = 2 * Math.sin(Math.PI * Math.min(f, sr / 6) / sr);
        let s = 0; for (let k = 0; k < H.length; k++) if (f * (k + 1) < sr * 0.45) s += H[k] * Math.sin(TAU * (k + 1) * ph);
        const e = A[i] * (1 + P.trem * Math.sin(TAU * 4.7 * i / sr + tr));
        const hi = nz[i] - lo - 0.17 * bp; bp += fq * hi; lo += fq * bp;
        out[i] = e * (s + bp * P.br * 2.2 + nz[i] * P.br * 0.25);
      }
      const cl = Math.floor(0.03 * sr);
      for (const on of pf.ons) {
        if (on[2]) continue;
        const i0 = on[0], f2 = F[Math.min(n - 1, i0 + 20)] * 2.5, c = filt(white(cl, r), sr, 'bp', Math.min(f2, sr * 0.4), 2);
        for (let k = 0; k < cl && i0 + k < n; k++) out[i0 + k] += c[k] * P.chiff * on[1] * Math.exp(-k / (0.009 * sr));
      }
      filt(out, sr, 'lp', P.lp, 0.7); filt(out, sr, 'hp', 150, 0.7);
      return fades(normPeak([out], 0.7), sr, 0, 0.04);
    }
    function reed(a, sr) {
      const P = REED[a.kind], r = rng(a.seed || 4), notes = a.notes, n = Math.ceil(lenOf(notes, P.rel2 * 3.5 + 0.1) * sr);
      const o = Object.assign({}, P, { vr: P.vr * (0.95 + r() * 0.1) });
      const pf = perform(notes, n, sr, o, r), F = pf.F, A = pf.A, out = new Float32Array(n), nz = white(n, r), tn = Math.tanh(P.drive);
      let ph = r();
      for (let i = 0; i < n; i++) {
        const f = F[i], dt = f / sr; ph += dt; if (ph >= 1) ph -= 1;
        let p2 = ph + P.duty; if (p2 >= 1) p2 -= 1;
        const s1 = 2 * ph - 1 - blep(ph, dt), s2 = 2 * p2 - 1 - blep(p2, dt);
        const x = (P.saw * s1 + P.pul * (s1 - s2)) * A[i];
        out[i] = Math.tanh(P.drive * x) / tn + nz[i] * P.br * A[i];
      }
      chain(out, sr, P.body);
      return fades(normPeak([out], 0.7), sr, 0, 0.04);
    }

    // ── Brass: saw through a level-driven 2-pole low-pass (brassiness), lip scoop, ensemble ──
    const HRN = { glide: .035, jump: .015, scoop: 60, scoopT: .035, vib: 5, vr: 5, vdel: .45, vrise: .6, jit: 4, att: .055, rel: .08, rel2: .28, dip: .45, dipW: .05, leg: .95, swell: .18 };
    function horn(a, sr) {
      const nv = a.n || 1, r = rng(a.seed || 9), notes = a.notes, P = Object.assign({}, HRN, a.att ? { att: a.att } : null);
      const n = Math.ceil(lenOf(notes, P.rel2 * 3.5 + 0.12) * sr), L = new Float32Array(n), R = (nv > 1 || a.pc) && !a.mono ? new Float32Array(n) : null;
      const cap = Math.min(5000, sr / 6.5), bright = (a.bright || 1) * 1.4;
      for (let v = 0; v < nv; v++) {
        const det = nv > 1 ? (v - (nv - 1) / 2) * 6 + (r() - 0.5) * 4 : 0, off = nv > 1 ? r() * 0.018 : 0;
        const ns = notes.map((x, i) => [x[0] + (i ? off * r() : off), x[1], x[2] + det / 100, x[3]]);
        const o = Object.assign({}, P, { vr: P.vr * (0.9 + r() * 0.2) });
        const pf = perform(ns, n, sr, o, r), F = pf.F, A = pf.A, x = new Float32Array(n);
        let ph = r(), lo = 0, bp = 0, fq = 0;
        for (let i = 0; i < n; i++) {
          const f = F[i], dt = f / sr, e = A[i]; ph += dt; if (ph >= 1) ph -= 1;
          if ((i & 15) === 0) fq = 2 * Math.sin(Math.PI * Math.min(cap, (f * (1.3 + 6.5 * bright * Math.pow(Math.min(1.3, e), 1.6)) + 150)) / sr);
          const s = (2 * ph - 1 - blep(ph, dt)) * e;
          lo += fq * bp; const hi = s - lo - 1.25 * bp; bp += fq * hi;
          x[i] = lo + 0.3 * e * Math.sin(TAU * ph);
        }
        chain(x, sr, [['hp', 50, .7], ['pk', 480, 2, 2], ['pk', 2800, 1.2, -2], ['lp', 5200, .7]]);
        if (R) {
          const g = panLR((nv > 1 ? (v / (nv - 1) * 2 - 1) * (a.spread == null ? 0.5 : a.spread) : 0) + (a.pc || 0));
          for (let i = 0; i < n; i++) { L[i] += x[i] * g[0]; R[i] += x[i] * g[1]; }
        } else for (let i = 0; i < n; i++) L[i] += x[i];
      }
      const chs = R ? [L, R] : [L];
      return fades(normPeak(chs, 0.7), sr, 0, 0.05);
    }

    // ── Hurdy-gurdy: wheel-bowed drones, a buzzing trompette (chien) with rhythmic strokes,
    //    and a keyed melody string; crank-speed wobble on everything ──
    function gurdy(a, sr) {
      const r = rng(a.seed || 21), len = a.len, n = Math.ceil((len + 0.5) * sr), L = new Float32Array(n), R = new Float32Array(n);
      const crank = new Float32Array(n), cph = r() * TAU;
      for (let i = 0; i < n; i++) { const t = i / sr; crank[i] = (1 + 0.05 * Math.sin(TAU * 1.15 * t + cph) + 0.02 * Math.sin(TAU * 2.3 * t + 1)) * Math.min(1, t / 0.25) * clamp((len - t) / 0.3, 0, 1); }
      (a.drone || []).forEach((m, j) => {
        const f = mtof(m), x = new Float32Array(n); let ph = r();
        for (let i = 0; i < n; i++) { const fi = f * (1 + 0.0015 * Math.sin(TAU * 0.3 * i / sr + j)), dt = fi / sr; ph += dt; if (ph >= 1) ph -= 1; x[i] = (2 * ph - 1 - blep(ph, dt)) * crank[i]; }
        chain(x, sr, [['hp', 90, .7], ['pk', 650, 2, 4], ['pk', 1400, 2, 3], ['lp', 2400, .7]]);
        const g = panLR(j % 2 ? 0.35 : -0.3); for (let i = 0; i < n; i++) { L[i] += x[i] * g[0] * 0.45; R[i] += x[i] * g[1] * 0.45; }
      });
      if (a.tromp && a.tromp.length) {
        const f = mtof(a.tm || a.drone[0] + 12), gate = new Float32Array(n), x = new Float32Array(n), nz = white(n, r);
        for (const [t, d, v] of a.tromp) {
          const i0 = Math.floor(t * sr), i1 = Math.min(n, Math.floor((t + d + 0.04) * sr));
          for (let i = Math.max(0, i0); i < i1; i++) { const tt = (i - i0) / sr, g = v * Math.min(1, tt / 0.004) * Math.exp(-tt * 7) * (tt > d ? Math.exp(-(tt - d) / 0.012) : 1); if (g > gate[i]) gate[i] = g; }
        }
        let ph = r();
        for (let i = 0; i < n; i++) {
          const dt = f / sr; ph += dt; if (ph >= 1) ph -= 1;
          let p2 = ph + 0.09; if (p2 >= 1) p2 -= 1;
          const s1 = 2 * ph - 1 - blep(ph, dt), s2 = 2 * p2 - 1 - blep(p2, dt);
          x[i] = gate[i] * crank[i] * ((s1 - s2) * 0.8 + s1 * 0.25 + nz[i] * (ph < 0.2 ? 0.5 : 0.1));
        }
        chain(x, sr, [['hp', 350, .7], ['pk', 1800, 1, 6], ['pk', 3600, 1.5, -4], ['lp', 5200, .7]]);
        for (let i = 0; i < n; i++) { L[i] += x[i] * 0.5; R[i] += x[i] * 0.5; }
      }
      if (a.notes && a.notes.length) {
        const o = { glide: .004, jump: .003, scoop: 0, vib: 3, vr: 6, vdel: .3, vrise: .5, jit: 2, att: .012, rel: .025, rel2: .1, dip: .25, dipW: .03, leg: .98, swell: 0 };
        const pf = perform(a.notes, n, sr, o, r), F = pf.F, A = pf.A, x = new Float32Array(n);
        let ph = r();
        for (let i = 0; i < n; i++) {
          const f = F[i], dt = f / sr; ph += dt; if (ph >= 1) ph -= 1;
          let p2 = ph + 0.4; if (p2 >= 1) p2 -= 1;
          const s1 = 2 * ph - 1 - blep(ph, dt), s2 = 2 * p2 - 1 - blep(p2, dt);
          x[i] = (0.65 * s1 + 0.45 * (s1 - s2)) * A[i] * (1 + 0.04 * Math.sin(TAU * 1.15 * i / sr + cph));
        }
        chain(x, sr, [['hp', 200, .7], ['pk', 700, 2, 5], ['pk', 1500, 2, 3], ['pk', 2900, 1.5, 1], ['pk', 4200, 1.5, -5], ['lp', 4800, .7]]);
        for (let i = 0; i < n; i++) { L[i] += x[i] * 0.8; R[i] += x[i] * 0.8; }
      }
      for (let i = 0; i < n; i++) L[i] = (L[i] + R[i]) * 0.5;
      return fades(normPeak([L], 0.7), sr, 0.005, 0.1);
    }

    // ── Percussion: membranes (pitch-dropping modes + skin + beater), metals, hands ──
    function drum(a, sr) {
      const k = a.k, v = a.v || 0, r = rng(hs(k) + v * 7919), vv = 1 + (v - 1.5) * 0.025;
      const LEN = { bodhran: .6, bodhranHi: .3, frame: 1.2, frameSlap: .3, tapan: 1.4, stick: .18, taiko: 1.6, tabor: .4, zills: 1.8, tamb: .45, shake: .3, clap: .35, stomp: .6, rattle: .45, gong: 4.5, cym: 3.5, swell: a.len ? a.len + 0.6 : 2.6, anvil: 1, thud: 1.6 };
      const n = Math.ceil((LEN[k] || 0.5) * sr), d = new Float32Array(n), nz = white(n, r);
      const memb = (f0, f1, fall, dec, parts) => {
        let ph = 0;
        for (let i = 0; i < n; i++) {
          const t = i / sr; ph += TAU * (f1 + (f0 - f1) * Math.exp(-t / fall)) / sr;
          let s = Math.sin(ph) * Math.exp(-t * dec);
          for (const [ra, am, dm] of parts) s += am * Math.sin(ph * ra + ra) * Math.exp(-t * dec * dm);
          d[i] += s;
        }
      };
      const noiseEnv = (src, gain, dec, att) => { for (let i = 0; i < n; i++) { const t = i / sr; d[i] += src[i] * gain * Math.exp(-t * dec) * (att ? Math.min(1, t / att) : 1); } };
      const MP = [[1.59, .35, 1.8], [2.14, .22, 2.5], [2.3, .15, 2.8], [2.65, .1, 3.2]];
      if (k === 'bodhran') { memb(150 * vv, 78 * vv, 0.025, 9, MP); noiseEnv(filt(filt(nz.slice(), sr, 'lp', 1800, .7), sr, 'hp', 300, .7), 0.5, 60); noiseEnv(filt(nz.slice(), sr, 'hp', 2500, .7), 0.12, 300); }
      else if (k === 'bodhranHi') { memb(260 * vv, 195 * vv, 0.01, 26, MP.slice(0, 2)); noiseEnv(filt(nz.slice(), sr, 'bp', 1300, .9), 0.5, 70); }
      else if (k === 'frame') { memb(135 * vv, 74 * vv, 0.03, 6, MP); noiseEnv(filt(nz.slice(), sr, 'lp', 900, .7), 0.6, 40); noiseEnv(filt(nz.slice(), sr, 'bp', 2200, .8), 0.08, 200); }
      else if (k === 'frameSlap') { memb(340 * vv, 300 * vv, 0.01, 30, [[1.6, .3, 1.5]]); noiseEnv(filt(nz.slice(), sr, 'bp', 950, .8), 0.9, 38); }
      else if (k === 'tapan') { memb(98 * vv, 50 * vv, 0.03, 4.2, [[1.52, .4, 2], [2.26, .2, 3]]); noiseEnv(filt(filt(nz.slice(), sr, 'lp', 700, .7), sr, 'hp', 60, .7), 0.9, 40); for (let i = 0; i < n; i++) d[i] = Math.tanh(d[i] * 1.5); }
      else if (k === 'stick') { noiseEnv(filt(nz.slice(), sr, 'bp', 2800 * vv, 1.2), 1.1, 75); memb(520 * vv, 480 * vv, 0.01, 50, []); }
      else if (k === 'taiko') { memb(104 * vv, 58 * vv, 0.035, 5.5, [[1.52, .45, 1.8], [2.26, .25, 2.6]]); noiseEnv(filt(filt(nz.slice(), sr, 'lp', 1200, .7), sr, 'hp', 150, .7), 1.1, 34); for (let i = 0; i < n; i++) d[i] = Math.tanh(d[i] * 1.6); }
      else if (k === 'tabor') {
        memb(190 * vv, 175 * vv, 0.01, 18, [[1.6, .5, 1.4]]);
        const sn = filt(filt(nz.slice(), sr, 'bp', 3300, .7), sr, 'lp', 7000, .7); noiseEnv(sn, 0.9, 14, 0.002); noiseEnv(filt(nz.slice(), sr, 'bp', 1200, 1), 0.4, 60);
      }
      else if (k === 'zills') { modal(d, sr, 0, 2650 * vv, [[1, 1, 1.3], [1.47, .6, 1], [2.05, .35, .8], [2.63, .25, .6], [3.31, .15, .45]], 1, 1); modal(d, sr, 0, 2650 * vv * 1.012, [[1, .8, 1.2], [1.47, .4, .9]], 1, 1); noiseEnv(filt(nz.slice(), sr, 'hp', 4000, .7), 0.2, 900); }
      else if (k === 'tamb') {
        const j = filt(filt(nz.slice(), sr, 'bp', 6800, 1), sr, 'lp', 9000, .7);
        for (let q = 0; q < 7; q++) { const s0 = Math.floor((r() * 0.05) * sr), L2 = Math.floor(0.02 * sr); for (let i = 0; i < L2 && s0 + i < n; i++) d[s0 + i] += j[s0 + i] * (0.6 + r() * 0.4) * Math.exp(-i / (0.004 * sr)); }
        noiseEnv(j, 0.25, 22); memb(230, 220, 0.01, 30, []);
      }
      else if (k === 'shake') { const j = filt(filt(nz.slice(), sr, 'bp', 6500, .8), sr, 'lp', 9000, .7); for (let i = 0; i < n; i++) { const t = i / sr; d[i] = j[i] * Math.min(1, t / 0.02) * Math.exp(-t * 18) * (0.6 + 0.4 * Math.sin(TAU * 38 * t)); } }
      else if (k === 'clap') {
        const c = filt(nz.slice(), sr, 'bp', 1250, 1.1);
        for (let q = 0; q < 5; q++) { const s0 = Math.floor(r() * 0.022 * sr), am = 0.6 + r() * 0.4; for (let i = 0; s0 + i < n && i < 0.03 * sr; i++) d[s0 + i] += c[s0 + i] * am * Math.exp(-i / (0.006 * sr)); }
        noiseEnv(filt(nz.slice(), sr, 'bp', 1000, .8), 0.12, 18);
      }
      else if (k === 'stomp') { memb(80, 44, 0.03, 12, [[1.7, .3, 2]]); noiseEnv(filt(nz.slice(), sr, 'lp', 450, .7), 1.2, 25); }
      else if (k === 'rattle') {
        for (let q = 0; q < 16; q++) {
          const s0 = Math.floor(r() * 0.28 * sr * (q / 16 + 0.1)), f0 = 900 + r() * 1400, L2 = Math.floor(0.012 * sr), am = (0.4 + r() * 0.6) * (1 - q / 20);
          const c = filt(white(L2, r), sr, 'bp', f0 * 2, 2);
          for (let i = 0; i < L2 && s0 + i < n; i++) d[s0 + i] += (c[i] + Math.sin(TAU * f0 * i / sr) * 0.3) * am * Math.exp(-i / (0.0025 * sr));
        }
      }
      else if (k === 'gong') {
        modal(d, sr, 0, 72, [[1, 1, 3.5], [1.47, .7, 3], [2.09, .6, 2.6], [2.56, .5, 2.2], [3.33, .35, 2], [4.2, .3, 1.6], [5.9, .2, 1.2], [7.6, .15, 1]], 1, 1);
        const sh = filt(filt(nz.slice(), sr, 'bp', 2600, .6), sr, 'lp', 6000, .7);
        for (let i = 0; i < n; i++) { const t = i / sr; d[i] = d[i] * (0.5 + 0.5 * Math.min(1, t / 0.25)) + sh[i] * 0.35 * Math.min(1, t / 0.4) * Math.exp(-t * 1.2); }
      }
      else if (k === 'cym') {
        const sh = filt(filt(nz.slice(), sr, 'hp', 2200, .7), sr, 'lp', 9000, .7);
        modal(d, sr, 0, 410, [[1, .3, 2], [2.3, .25, 1.6], [3.7, .2, 1.3], [5.2, .15, 1.1], [7.9, .1, .9]], 1, 1);
        for (let i = 0; i < n; i++) { const t = i / sr; d[i] = d[i] * 0.5 + sh[i] * (0.8 * Math.exp(-t * 1.4) + 0.4 * Math.exp(-t * 12)); }
      }
      else if (k === 'swell') {
        const T = LEN.swell - 0.6, sh = filt(filt(nz.slice(), sr, 'hp', 1800, .7), sr, 'lp', 8000, .7);
        for (let i = 0; i < n; i++) { const t = i / sr, e = t < T ? Math.pow(t / T, 2.5) : Math.exp(-(t - T) * 5); d[i] = sh[i] * e * (1 + 0.15 * Math.sin(TAU * 11 * t)); }
      }
      else if (k === 'anvil') { modal(d, sr, 0, 1180, [[1, 1, .5], [2.43, .6, .35], [3.9, .4, .25], [5.8, .2, .15]], 1, 1); noiseEnv(filt(nz.slice(), sr, 'hp', 4000, .7), 0.5, 400); }
      else if (k === 'thud') { memb(70, 44, 0.1, 4, []); }
      filt(d, sr, 'hp', k === 'taiko' || k === 'tapan' || k === 'thud' || k === 'stomp' ? 52 : k === 'bodhran' || k === 'frame' ? 62 : 40, 0.8);
      const NP = { taiko: 0.42, tapan: 0.45, thud: 0.42, frame: 0.5, stomp: 0.45 };
      return fades(normPeak([d], NP[k] || 0.7), sr, 0.0005, 0.04);
    }

    // ── Bells: church bells (hum, prime, tierce, quint, nominal, uppers; warbling doublets),
    //    a music box (cantilever tine modes), handbells ──
    const CHURCH = [[0.5, .55, 1.6], [1, .75, 1], [1.183, .6, .75], [1.506, .3, .6], [2, .8, .5], [2.514, .25, .35], [2.662, .22, .3], [3.011, .18, .25], [4.166, .12, .18], [5.433, .07, .12], [6.796, .04, .08]];
    function bell(a, sr) {
      const f0 = mtof(a.m), r = rng(a.m * 17 + 3);
      if (a.kind === 'mbox') {
        const n = Math.ceil(2.4 * sr), d = new Float32Array(n);
        modal(d, sr, 0, f0, [[1, 1, 2.0], [2, .06, .8], [6.27, .1, .35], [17.55, .025, .1]], 1, 1);
        modal(d, sr, 0, f0 * 1.0015, [[1, .3, 2.0]], 1, 1);
        const c = filt(white(Math.floor(0.003 * sr), r), sr, 'hp', 3000, .7); for (let i = 0; i < c.length; i++) d[i] += c[i] * 0.1;
        return fades(normPeak([d], 0.6), sr, 0.0005, 0.3);
      }
      const hand = a.kind === 'hand', parts = hand ? [[1, 1, 1], [2.4, .25, .45], [3.0, .3, .5], [4.5, .1, .25]] : CHURCH;
      const base = hand ? 2.2 : 7 * clamp(Math.sqrt(260 / f0), 0.4, 2), n = Math.ceil(Math.min(base * 1.1 + 0.3, 6) * sr);
      const L = new Float32Array(n), R = new Float32Array(n);
      modal(L, sr, 0, f0, parts, base, 1); modal(R, sr, 0, f0 * (1 + 0.6 / f0), parts, base, 1);
      modal(L, sr, 0, f0 * (1 + 0.9 / f0), parts.slice(0, 5), base, 0.4); modal(R, sr, 0, f0, parts.slice(0, 5), base, 0.4);
      const c = filt(white(Math.floor(0.006 * sr), r), sr, 'hp', 2000, .7);
      for (let i = 0; i < n; i++) L[i] = (L[i] + R[i]) * 0.5 + (i < c.length ? c[i] * 0.12 : 0);
      return fades(normPeak([L], 0.6), sr, 0.001, 0.4);
    }

    // ── Organ drone (reed+principal stops, chiff, swell) ──
    function organ(a, sr) {
      const r = rng(a.seed || 31), n = Math.ceil((a.len + (a.rel || 1.5) + 0.2) * sr), L = new Float32Array(n), R = new Float32Array(n);
      a.ms.forEach((m, j) => {
        const f = mtof(m), x = new Float32Array(n); let ph = r(), p2 = r();
        for (let i = 0; i < n; i++) {
          const t = i / sr, dt = f * (1 + 0.0008 * Math.sin(TAU * 0.4 * t + j)) / sr; ph += dt; if (ph >= 1) ph -= 1; p2 = ph + 0.5; if (p2 >= 1) p2 -= 1;
          const s1 = 2 * ph - 1 - blep(ph, dt), s2 = 2 * p2 - 1 - blep(p2, dt);
          const e = Math.min(1, t / (a.att || 1.2)) * clamp((a.len + (a.rel || 1.5) - t) / (a.rel || 1.5), 0, 1);
          x[i] = (0.45 * s1 + 0.3 * (s1 - s2) + 0.6 * Math.sin(TAU * ph)) * e;
        }
        chain(x, sr, [['lp', 1900, .7], ['pk', 700, 1, 2], ['hp', 40, .7]]);
        const g = a.mono ? [1, 0] : panLR(j % 2 ? 0.3 : -0.3); for (let i = 0; i < n; i++) { L[i] += x[i] * g[0]; R[i] += x[i] * g[1]; }
      });
      return fades(normPeak(a.mono ? [L] : [L, R], 0.7), sr, 0.01, 0.1);
    }

    // ── Wolf howl: a pure-toned formant voice gliding up, holding with vibrato, falling ──
    function howl(a, sr) {
      const m = 69 + 12 * Math.log2((a.f || 480) / 440), d = a.d || 2.6;
      const res = voice({ reg: 'A', solo: 1, pure: 1, eff: 0.12, breath: 0.22, glide: 0.2, vib: 0.8, rms: 0.1, seed: a.seed || 41,
        notes: [[0, 0.35, m - 7, '_'], [0.35, d - 0.95, m, '_'], [d - 0.6, 0.6, m - 5]], vp: [[0, 'u'], [0.5, 'o'], [d - 0.5, 'o'], [d, 'u']] }, sr);
      filt(res[0], sr, 'lp', a.far ? 2000 : 3200, 0.7);
      return res;
    }

    // ── Ambience beds: wind (gusting bands), crickets, tavern crowd murmur with clinks ──
    function amb(a, sr) {
      const r = rng(a.seed || 51), n = Math.ceil(a.len * sr), L = new Float32Array(n), R = new Float32Array(n);
      if (a.kind === 'wind') {
        for (let ch = 0; ch < 2; ch++) {
          const out = ch ? R : L, nz = white(n, r); let lo = 0, bp = 0, lo2 = 0, bp2 = 0;
          const p1 = r() * TAU, p2 = r() * TAU, p3 = r() * TAU;
          for (let i = 0; i < n; i++) {
            const t = i / sr, g = 0.55 + 0.3 * Math.sin(TAU * 0.07 * t + p1) + 0.2 * Math.sin(TAU * 0.13 * t + p2) + 0.1 * Math.sin(TAU * 0.31 * t + p3);
            const fc = 380 + 420 * g, f = 2 * Math.sin(Math.PI * fc / sr), f2 = 2 * Math.sin(Math.PI * (1500 + 700 * g) / sr);
            const hi = nz[i] - lo - 1.1 * bp; bp += f * hi; lo += f * bp;
            const hi2 = nz[i] - lo2 - 0.12 * bp2; bp2 += f2 * hi2; lo2 += f2 * bp2;
            out[i] = (bp * 0.9 + bp2 * 0.035) * Math.max(0, g) * Math.max(0, g);
          }
        }
      } else if (a.kind === 'crickets') {
        for (let c = 0; c < 4; c++) {
          const f = 4100 + r() * 900, g = panLR((r() * 2 - 1) * 0.8), am = 0.25 + r() * 0.5;
          for (let t = r(); t < a.len - 0.3; t += 0.55 + r() * 0.9) {
            for (let q = 0; q < 3; q++) {
              const s0 = Math.floor((t + q * 0.028) * sr), L2 = Math.floor(0.016 * sr);
              for (let i = 0; i < L2 && s0 + i < n; i++) { const e = Math.sin(Math.PI * i / L2), s = Math.sin(TAU * f * i / sr) * e * am; L[s0 + i] += s * g[0]; R[s0 + i] += s * g[1]; }
            }
          }
        }
      } else if (a.kind === 'crowd') {
        for (let k = 0; k < 7; k++) {
          const x = new Float32Array(n), nz = white(n, r), f0 = 105 + r() * 110, g = panLR((r() * 2 - 1) * 0.75);
          const env = new Float32Array(n);
          for (let t = r() * 1.5; t < a.len; ) {
            const pl = 0.8 + r() * 2.4, rate = 3.5 + r() * 2.5, i0 = Math.floor(t * sr), i1 = Math.min(n, Math.floor((t + pl) * sr));
            for (let i = i0; i < i1; i++) { const tt = i / sr - t; env[i] = Math.pow(Math.max(0, Math.sin(Math.PI * tt * rate)), 1.5) * Math.min(1, tt / 0.1, (pl - tt) / 0.1); }
            t += pl + 0.3 + r() * 1.6;
          }
          let ph = 0, lo = 0, bp = 0, lo2 = 0, bp2 = 0, fc1 = 500, fc2 = 1500;
          for (let i = 0; i < n; i++) {
            if (i % 2400 === 0) { fc1 = 300 + r() * 500; fc2 = 900 + r() * 1300; }
            const t = i / sr, ff = f0 * (1 + 0.12 * Math.sin(TAU * 0.7 * t + k)); ph += ff / sr; if (ph >= 1) ph -= 1;
            const s = (2 * ph - 1) * 0.5 + nz[i] * 0.5;
            const q1 = 2 * Math.sin(Math.PI * fc1 / sr), q2 = 2 * Math.sin(Math.PI * fc2 / sr);
            const h1 = s - lo - 0.25 * bp; bp += q1 * h1; lo += q1 * bp;
            const h2 = s - lo2 - 0.3 * bp2; bp2 += q2 * h2; lo2 += q2 * bp2;
            x[i] = (bp + bp2 * 0.5) * env[i];
          }
          filt(x, sr, 'lp', 2600, .7);
          for (let i = 0; i < n; i++) { L[i] += x[i] * g[0]; R[i] += x[i] * g[1]; }
        }
        for (let t = 1 + r() * 2; t < a.len - 0.5; t += 2 + r() * 4) {
          const d = new Float32Array(Math.floor(0.25 * sr)), g = panLR((r() * 2 - 1) * 0.7);
          modal(d, sr, 0, 1900 + r() * 1400, [[1, 1, .12], [2.7, .4, .07], [4.1, .2, .05]], 1, 0.35);
          const s0 = Math.floor(t * sr); for (let i = 0; i < d.length && s0 + i < n; i++) { L[s0 + i] += d[i] * g[0]; R[s0 + i] += d[i] * g[1]; }
        }
      }
      return fades(normPeak([L, R], 0.6), sr, a.fin == null ? 1 : a.fin, a.fout == null ? 1 : a.fout);
    }

    // ── Reverb impulse: frequency-dependent decay (4 bands), diffusion build-up, early
    //    reflections, an optional distant echo (valleys), decorrelated stereo ──
    function ir(a, sr) {
      const n = Math.ceil(a.len * sr), r = rng(a.seed || 3), pre = Math.floor(a.pre * sr), chs = [];
      const damp = a.damp || 0.6, bands = [['lp', 260, a.rt * (a.lo || 1.2), 1], ['bp', 750, a.rt, 0.9], ['bp', 2300, a.rt * (1 + damp) / 2, a.hi || 0.55], ['hp', 5200, a.rt * damp * 0.7, (a.hi || 0.55) * 0.45]];
      for (let ch = 0; ch < 2; ch++) {
        const d = new Float32Array(n), build = (a.build || 0.03) * sr;
        for (const [ty, f, rt, gain] of bands) {
          const x = white(n, r);
          if (ty === 'lp') { filt(x, sr, 'lp', f, .7); filt(x, sr, 'lp', f, .7); }
          else if (ty === 'hp') { filt(x, sr, 'hp', f, .7); filt(x, sr, 'lp', 10000, .7); }
          else filt(x, sr, 'bp', f, 0.75);
          const k = -6.91 / (rt * sr);
          for (let i = pre; i < n; i++) { const j = i - pre; d[i] += x[i] * gain * Math.exp(k * j) * (1 - Math.exp(-j / build)); }
        }
        const er = a.er || [8, 0.06];
        for (let q = 0; q < er[0]; q++) {
          const at = pre + Math.floor((0.002 + r() * er[1]) * sr), am = (0.9 + r() * 0.6) * (1 - q / (er[0] + 2)) * (r() < 0.5 ? -1 : 1), L2 = Math.floor(0.004 * sr);
          for (let i = 0; i < L2 && at + i < n; i++) d[at + i] += am * (r() * 2 - 1) * Math.exp(-i / (0.001 * sr));
        }
        if (a.echo) {
          const at = Math.floor(a.echo[0] * sr) + (ch ? Math.floor(0.011 * sr) : 0), seg = Math.floor(0.2 * sr), e = new Float32Array(seg);
          for (let i = 0; i < seg && pre + i < n; i++) e[i] = d[pre + i] * (1 - i / seg);
          filt(e, sr, 'lp', 1800, .7);
          for (let i = 0; i < seg && at + i < n; i++) d[at + i] += e[i] * a.echo[1];
        }
        chs.push(d);
      }
      fades(chs, sr, 0, 0.25);
      let e = 0; for (const d of chs) for (let i = 0; i < n; i++) e += d[i] * d[i];
      scale(chs, 1 / Math.sqrt(e / 2));
      return chs;
    }

    const K = { bow, voice, pluck, wind, horn, gurdy, drum, bell, organ, howl, amb };
    return {
      bake(k, a, sr) {
        if (k === 'ir') return { ch: ir(a, sr), sr };
        const res = K[k](a, sr);
        let ch = Array.isArray(res) ? res : res.ch || res;
        if (a.loop) {   // blend the loop's last 0.4 s with the 0.4 s before its start: seamless wrap
          const ls = Math.round(a.loop[0] * sr), le = Math.round(a.loop[1] * sr), X = Math.round(0.4 * sr);
          ch = ch.map(d => {
            const o = new Float32Array(le); o.set(d.subarray(0, Math.min(le, d.length)));
            for (let i = le - X; i < le; i++) { const t = (i - (le - X)) / X; o[i] = (d[i] || 0) * Math.sqrt(1 - t) + d[i - (le - ls)] * Math.sqrt(t); }
            return o;
          });
        }
        return { ch, sr };
      },
      hs, rng,
    };
  }

  // ════════ Score toolkit ════════
  const D = DSP(), hs = D.hs, rng = D.rng;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const PCN = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  function nm(s) { const m = /^([A-G])([#b]?)(-?\d)$/.exec(s); if (!m) throw new Error('note ' + s); return 12 * (+m[3] + 1) + PCN[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0); }
  const QUAL = { '': [0, 4, 7], m: [0, 3, 7], '5': [0, 7], sus4: [0, 5, 7], sus2: [0, 2, 7], '7': [0, 4, 7, 10], m7: [0, 3, 7, 10], dim: [0, 3, 6], add9: [0, 4, 7, 2], madd9: [0, 3, 7, 2] };
  function chordOf(sym) {
    const m = /^([A-G])([#b]?)(.*)$/.exec(sym), q = QUAL[m[3]];
    if (!q) throw new Error('chord ' + sym);
    const root = (PCN[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
    return { root, pcs: q.map(x => (root + x) % 12), sym };
  }
  const NOTE_RE = /^([A-G][#b]?-?\d)(?::(\d*\.?\d+))?([_.^~ctmw,]*)(?:@([a-z]+))?$/, REST_RE = /^r(?::(\d*\.?\d+))?$/;
  function parseMel(str) {
    const out = []; let b = 0;
    for (const tok of str.split(/\s+/)) {
      if (!tok || tok === '|') continue;
      if (tok === '/') { out.push({ brk: 1, b }); continue; }
      let m = REST_RE.exec(tok); if (m) { b += m[1] ? +m[1] : 1; continue; }
      m = NOTE_RE.exec(tok); if (!m) throw new Error('bad note ' + tok);
      const d = m[2] ? +m[2] : 1; out.push({ b, d, m: nm(m[1]), f: m[3] || '', v: m[4] || null }); b += d;
    }
    out.len = b; return out;
  }
  const mapPc = (m, map) => { const pc = ((m % 12) + 12) % 12; return map[pc] != null ? m - pc + map[pc] : m; };
  function diaShift(m, scale, steps) {   // move a pitch by scale degrees (scale = pitch classes, ascending)
    const pc = ((m % 12) + 12) % 12; let i = scale.indexOf(pc); if (i < 0) return m;
    let oct = Math.floor(m / 12); i += steps;
    while (i < 0) { i += scale.length; oct--; } while (i >= scale.length) { i -= scale.length; oct++; }
    return oct * 12 + scale[i];
  }
  const SCALE = { Em_aeo: [4, 6, 7, 9, 11, 0, 2].sort((a, b) => a - b), Dmix: [2, 4, 6, 7, 9, 11, 0].sort((a, b) => a - b) };
  const INST = {
    fiddle: ['bow', { kind: 'fiddle', n: 1 }, 'lead'], fiddles: ['bow', { kind: 'fiddle', n: 3, mono: 1 }, 'lead'],
    viol: ['bow', { kind: 'viol', n: 1 }, 'lead'], viols: ['bow', { kind: 'viol', n: 3 }, 'pad'],
    cello: ['bow', { kind: 'cello', n: 1 }, 'lead'], celli: ['bow', { kind: 'cello', n: 3, tight: 1 }, 'low'],
    basses: ['bow', { kind: 'bass', n: 2, tight: 1 }, 'low'],
    recorder: ['wind', { kind: 'recorder' }, 'lead'], whistle: ['wind', { kind: 'whistle' }, 'lead'], lowwhistle: ['wind', { kind: 'lowwhistle' }, 'lead'],
    shawm: ['wind', { kind: 'shawm' }, 'lead'], bombard: ['wind', { kind: 'bombard' }, 'lead'], pipes: ['wind', { kind: 'pipes' }, 'lead'],
    horn: ['horn', { n: 1 }, 'lead'], horns: ['horn', { n: 3, mono: 1 }, 'lead'],
    sop: ['voice', { reg: 'S', n: 1, solo: 1 }, 'lead'], alto: ['voice', { reg: 'A', n: 1, solo: 1 }, 'lead'], tenor: ['voice', { reg: 'T', n: 1, solo: 1 }, 'lead'],
    choirS: ['voice', { reg: 'S', n: 3, pc: -0.35, att: .08, rel2: .3, mono: 1, srk: .4 }, 'pad'], choirA: ['voice', { reg: 'A', n: 3, pc: -0.12, att: .08, rel2: .3, mono: 1, srk: .4 }, 'pad'],
    choirT: ['voice', { reg: 'T', n: 4, pc: 0.12, att: .07, rel2: .3, mono: 1, srk: .4 }, 'pad'], choirB: ['voice', { reg: 'B', n: 4, pc: 0.35, att: .07, rel2: .3, mono: 1, srk: .4 }, 'pad'],
    harp: ['pluck', { kind: 'harp' }, 'lead'], lute: ['pluck', { kind: 'lute' }, 'lead'], cittern: ['pluck', { kind: 'cittern' }, 'lead'],
  };
  const PART = { S: [60, 79, 69], A: [53, 72, 63], T: [48, 67, 57], B: [38, 57, 45] }, PPAN = { S: -0.4, A: -0.15, T: 0.15, B: 0.4 };
  const VEL = { X: 1, x: 0.7, o: 0.45, g: 0.25 };
  const vb = v => (v < 0.7 ? 0.6 : 0.9);
  function pickTone(pcs, prev, lo, hi, used) {
    let best = null, bd = 1e9;
    for (let m = lo; m <= hi; m++) if (pcs.indexOf(m % 12) >= 0) { const dd = Math.abs(m - prev) + (used.indexOf(m % 12) >= 0 ? 3.5 : 0); if (dd < bd) { bd = dd; best = m; } }
    return best == null ? prev : best;
  }
  const ARP = {
    up8: { len: 4, steps: [[0, 0, .9], [.5, 1, .55], [1, 2, .6], [1.5, 3, .55], [2, 4, .65], [2.5, 3, .5], [3, 2, .55], [3.5, 1, .45]] },
    slow4: { len: 4, steps: [[0, 0, .9], [1, 2, .55], [2, 3, .6], [3, 4, .5]] },
    two8: { len: 2, steps: [[0, 0, .8], [.5, 2, .5], [1, 3, .55], [1.5, 2, .45]] },
    two4: { len: 2, steps: [[0, 0, .75], [1, 2, .45]] },
    waltz: { len: 3, steps: [[0, 0, .85], [.5, 2, .4], [1, 3, .55], [1.5, 4, .45], [2, 3, .5], [2.5, 2, .4]] },
    roll: { len: 4, steps: [[0, 0, .8], [.06, 1, .6], [.12, 2, .6], [.18, 3, .55], [.24, 4, .55], [.3, 5, .5]] },
    roll3: { len: 3, steps: [[0, 0, .7], [.06, 1, .5], [.12, 2, .5], [.18, 3, .45], [.24, 4, .45]] },
  };
  const OSTP = {
    eighths: { len: 2, steps: [[0, .5, 0, '^.'], [.5, .5, 0, '.'], [1, .5, 12, '.'], [1.5, .5, 0, '.']] },
    gallop: { len: 1, steps: [[0, .5, 0, '^.'], [.5, .25, 0, '.'], [.75, .25, 0, '.']] },
    tre: { len: 8, steps: [[0, 1, 0, '^.'], [1, 1, 0, '.'], [2, 1, 0, '.'], [3, 1, 0, '^.'], [4, 1, 0, '.'], [5, 1, 0, '.'], [6, 1, 12, '^.'], [7, 1, 0, '.']] },
    hunt: { len: 4, steps: [[0, 1, 0, '^.'], [1, 1, 0, '.'], [2, 1, 7, '.'], [3, 1, 0, '.']] },
  };

  function Builder(S, rep, seed) {
    const B = { ev: [], rep, spb: 60 / S.bpm, bpb: S.meter, bars: S.bars, r: rng(seed) };
    const sec = x => x * B.spb;
    B.beats = S.bars * S.meter; B.len = sec(B.beats);
    B.add = (k, a, beat, g, pan, grp, dt, pl) => { const e = { t: sec(beat) + (dt || 0), k, a, g: g == null ? 1 : g, p: pan || 0, grp: grp || 'lead' }; if (pl) e.pl = pl; B.ev.push(e); };
    // A sustained note baked once as a 3.4 s buffer with a seamless loop [0.8, 3.4] s and held by a
    // gain envelope: shared by every chord, section and track that uses the same pitch and colour.
    B.sus = (k, a, beat, dur, g, pan, grp, pl) => {
      a.loop = [0.8, 3.4]; a.seed = hs(k + JSON.stringify(a));
      B.add(k, a, beat, g, pan, grp, 0, Object.assign({ loop: [0.8, 3.4], dur: +dur.toFixed(3), att: 0.3, rel: 0.5 }, pl));
    };
    // A melodic line: split into phrases at rests and '/', each phrase one baked buffer.
    B.mel = (inst, str, o) => {
      o = o || {};
      const I = INST[inst], ns = parseMel(str), at = o.at || 0, tr = o.tr || 0, vows = o.vow ? (Array.isArray(o.vow) ? o.vow : [o.vow]) : null;
      let ph = [], vi = 0;
      const flush = () => {
        if (!ph.length) return;
        const t0 = ph[0].b;
        const notes = ph.map(x => {
          let m = x.m + tr; if (o.map) m = mapPc(m, o.map); if (o.dia) m = diaShift(m, o.dia[0], o.dia[1]);
          const arr = [+sec(x.b - t0).toFixed(4), +sec(x.d).toFixed(4), m, x.f];
          if (I[0] === 'voice') arr.push(x.v || (vows ? vows[vi++ % vows.length] : null));
          return arr;
        });
        const a = Object.assign({}, I[1], o.args, { notes });
        a.seed = hs(inst + JSON.stringify(notes) + (o.seed || ''));
        B.add(I[0], a, at + t0, o.g, o.pan != null ? o.pan : a.mono && a.pc != null ? a.pc : 0, o.grp || I[2], o.each ? (B.r() - 0.5) * 0.006 : (B.r() - 0.5) * 0.012);
        ph = [];
      };
      for (const x of ns) {
        if (x.brk) { flush(); continue; }
        const pv = ph[ph.length - 1];
        if (pv && (o.each || x.b > pv.b + pv.d + 0.01)) flush();
        ph.push(x);
      }
      flush();
    };
    // A held note re-bowed every `stroke` beats.
    B.hold = (inst, note, at, beats, o) => {
      o = o || {}; const st = o.stroke || 4, I = INST[inst], dips = [];
      for (let b = st; b < beats - 1e-6; b += st) dips.push(+sec(b).toFixed(3));
      const a = Object.assign({}, I[1], { notes: [[0, 3.6, nm(note), '']], mono: 1, att: .06 }); delete a.tight;
      B.sus('bow', a, at, sec(beats) + 0.1, o.g, o.pan || 0, o.grp || I[2], { att: 0.5, rel: 0.6, dips });
    };
    B.chords = (str, o) => {
      let b = (o && o.at) || 0;
      return str.split(/\s+/).filter(x => x && x !== '|').map(tok => { const p = tok.split(':'), c = chordOf(p[0]); c.b = b; c.d = p[1] ? +p[1] : B.bpb; b += c.d; return c; });
    };
    // Sustained harmony with voice leading: choir, strings or horns, per part (S A T B).
    B.pad = (kind, chs, o) => {
      o = o || {};
      const parts = (o.parts || 'SATB').split(''), prev = {}, out = {}, sh = o.shift || 0;
      parts.forEach(p => { prev[p] = PART[p][2] + sh; out[p] = []; });
      for (const c of chs) {
        const used = [];
        for (const p of ['B', 'T', 'A', 'S']) {
          if (parts.indexOf(p) < 0) continue;
          const lo = PART[p][0] + sh, hi = PART[p][1] + sh;
          const m = p === 'B' && !o.freeBass ? pickTone([c.root], prev[p], lo, hi, []) : pickTone(c.pcs, prev[p], lo, hi, used);
          used.push(m % 12); prev[p] = m;
          const L = out[p], ln = L[L.length - 1];
          if (ln && ln[2] === m && Math.abs(ln[0] + ln[1] - c.b) < 1e-6 && !o.noTie) ln[1] += c.d; else L.push([c.b, c.d, m]);
        }
      }
      for (const p of parts) for (const [b, d, m] of out[p]) B.padNote(kind, p, b, d, m, o);
    };
    const vpOf = (vow, dur) => { const v = Array.isArray(vow) ? vow : [vow]; return v.map((x, i) => [+(i * dur / v.length).toFixed(3), x]); };
    B.padNote = (kind, p, b, d, m, o) => {
      const dur = +(sec(d) + (o.over == null ? 0.12 : o.over)).toFixed(3), g = (o.g || 1) * (o.pg && o.pg[p] != null ? o.pg[p] : 1);
      if (kind === 'choir') {   // one looped voice per vowel, crossfaded along the chord
        const vs = Array.isArray(o.vow) ? o.vow : [o.vow || 'a'], k = vs.length;
        vs.forEach((v, i) => {
          const t0 = i * dur / k, t1 = i === k - 1 ? dur : (i + 1) * dur / k + 0.3;
          const a = { reg: p, n: o.n || 3, notes: [[0, 3.6, m]], vp: [[0, v]], eff: o.eff == null ? 0.45 : o.eff, mono: 1, att: .06, srk: 1 / 3 };
          if (o.breath != null) a.breath = o.breath;
          B.sus('voice', a, b + t0 / B.spb, t1 - t0, g, PPAN[p], 'pad', i ? { att: 0.6, off: 0.8, rel: i === k - 1 ? 0.5 : 0.45 } : { att: o.att || 0.35, rel: i === k - 1 ? 0.5 : 0.45 });
        });
      } else if (kind === 'strings') {
        const a = { kind: { S: 'fiddle', A: 'viol', T: 'viol', B: 'cello' }[p], n: 3, notes: [[0, 3.6, m, '']], mono: 1, att: .06 };
        B.sus('bow', a, b, dur, g, PPAN[p] * 0.8, 'pad', { att: 0.3, rel: 0.4 });
      } else if (kind === 'horns') {
        const a = { n: 3, notes: [[0, 3.6, m, '']], mono: 1, att: .05 };
        B.sus('horn', a, b, dur, g, PPAN[p] * 0.7, 'pad', { att: o.att || 0.2, rel: dur < 0.6 ? 0.12 : 0.35 });
      }
    };
    // Broken chords / arpeggios on a plucked instrument.
    B.arp = (inst, chs, pat, o) => {
      o = o || {};
      const kind = INST[inst][1].kind, lo = o.lo || 40, hi = o.hi || 76;
      for (const c of chs) {
        let bass = lo; while (bass % 12 !== c.root) bass++;
        const tones = [bass];
        for (let m = bass + 1; m <= hi; m++) if (c.pcs.indexOf(m % 12) >= 0 && m - tones[tones.length - 1] >= (o.gap || 3)) tones.push(m);
        for (let b = 0; b < c.d - 1e-6; b += pat.len) for (const [sb, idx, v] of pat.steps) {
          if (b + sb >= c.d - 1e-6 || (o.thin && idx && B.r() < o.thin)) continue;
          const m = tones[Math.min(idx, tones.length - 1)], vel = v * (0.88 + B.r() * 0.24);
          B.add('pluck', { kind, m, v: vb(vel) }, c.b + b + sb, vel * (o.g || 1), clamp((m - 60) / 30, -0.6, 0.6) * (o.spread == null ? 1 : o.spread) + (o.pan || 0), o.grp || 'lead', (B.r() - 0.5) * 0.01);
        }
      }
    };
    // Strummed chords: rhythm chars D d (down) U u (up) . (rest), one char per `step` beats.
    B.strum = (inst, chs, rhythm, o) => {
      o = o || {};
      const kind = INST[inst][1].kind, step = o.step || 1, end = chs[chs.length - 1].b + chs[chs.length - 1].d;
      for (let b = chs[0].b, k = 0; b < end - 1e-6; b += step, k++) {
        const ch = rhythm[k % rhythm.length]; if (ch === '.') continue;
        const c = chs.find(x => b >= x.b - 1e-6 && b < x.b + x.d - 1e-6); if (!c) continue;
        let bass = o.lo || 45; while (bass % 12 !== c.root) bass++;
        const tones = [bass]; for (let m = bass + 1; m <= (o.hi || 69) && tones.length < 6; m++) if (c.pcs.indexOf(m % 12) >= 0 && m - tones[tones.length - 1] >= 3) tones.push(m);
        const down = ch === 'D' || ch === 'd', loud = ch === 'D' || ch === 'U', seq = down ? tones : tones.slice(-4).reverse();
        seq.forEach((m, i) => {
          const vel = (loud ? 0.9 : 0.55) * (1 - i * 0.05) * (0.9 + B.r() * 0.2);
          B.add('pluck', { kind, m, v: vb(vel) }, b, vel * (o.g || 1), clamp((m - 57) / 24, -0.4, 0.4), 'lead', i * (down ? 0.014 : 0.01) + (B.r() - 0.5) * 0.006);
        });
      }
    };
    // Percussion pattern: one string per bar (array = alternating bars); X x o g = velocities.
    B.drum = (kind, pats, o) => {
      o = o || {}; pats = Array.isArray(pats) ? pats : [pats];
      const bars = o.bars || B.bars, at = o.at || 0, bl = o.bpb || B.bpb;
      for (let bar = 0; bar < bars; bar++) {
        const p = o.last && bar === bars - 1 ? o.last : pats[bar % pats.length], step = bl / p.length;
        for (let k = 0; k < p.length; k++) {
          const v = VEL[p[k]]; if (!v) continue;
          const cr = o.cresc ? 0.3 + 0.7 * (bar * p.length + k) / (bars * p.length) : 1;
          B.add('drum', { k: kind, v: Math.floor(B.r() * 4) }, at + bar * bl + k * step, v * (o.g || 1) * cr * (0.9 + B.r() * 0.2), o.pan || 0, 'perc', (B.r() - 0.5) * (o.hum == null ? 0.008 : o.hum));
        }
      }
    };
    B.gurdy = o => {
      const len = +sec(o.beats).toFixed(3), strokes = [];
      if (o.tromp) {
        const pats = Array.isArray(o.tromp) ? o.tromp : [o.tromp], bars = Math.round(o.beats / B.bpb);
        for (let bar = 0; bar < bars; bar++) { const p = pats[bar % pats.length], st = B.bpb / p.length; for (let k = 0; k < p.length; k++) if (VEL[p[k]]) strokes.push([+sec(bar * B.bpb + k * st).toFixed(3), +sec(st * 0.8).toFixed(3), VEL[p[k]]]); }
      }
      const notes = o.notes ? parseMel(o.notes).filter(x => !x.brk).map(x => [+sec(x.b).toFixed(4), +sec(x.d).toFixed(4), x.m + (o.tr || 0), x.f]) : [];
      const a = { len, drone: o.drone.map(nm), tromp: strokes, notes };
      if (o.tm) a.tm = nm(o.tm);
      a.seed = hs('g' + JSON.stringify(a)); B.add('gurdy', a, o.at || 0, o.g, 0, 'lead');
    };
    // Low-string ostinato on each chord root: pat = {len, steps: [[beat, dur, interval, flags]]}.
    B.ost = (chs, pat, o) => {
      o = o || {};
      for (const c of chs) {
        let r = o.lo || 43; while (r % 12 !== c.root) r++;
        for (let x = 0; x < c.d - 1e-6; x += pat.len) for (const [b, d, iv, fl] of pat.steps) {
          if (x + b >= c.d - 1e-6) continue;
          const m = r + iv, tok = (mm) => `${nmOf(mm)}:${d}${fl || ''}`;
          if (o.g) B.mel('celli', tok(m), { at: c.b + x + b, each: 1, g: o.g });
          if (o.gb) B.mel('basses', tok(m - 12 >= 33 ? m - 12 : m), { at: c.b + x + b, each: 1, g: o.gb });
          if (o.gf) B.mel('fiddles', tok(m + 24), { at: c.b + x + b, each: 1, g: o.gf });
        }
      }
    };
    B.amb = (kind, at, beats, g, o) => {   // one 11.6 s looped bed per kind, entered at a random point
      const a = Object.assign({ kind, len: 12.8, seed: hs(kind), fin: 0, fout: 0, loop: [0.8, 12.4] }, o);
      B.add('amb', a, at, g, 0, 'amb', 0, { loop: [0.8, 12.4], off: +(0.8 + B.r() * 11).toFixed(2), dur: +(sec(beats) + 1.5).toFixed(2), att: 1, rel: 1 });
    };
    B.swell = (at, beats, g) => B.add('drum', { k: 'swell', len: +sec(beats).toFixed(3), v: 0 }, at, g, 0, 'perc');
    B.bell = (kind, note, at, g, pan) => B.add('bell', { kind, m: typeof note === 'string' ? nm(note) : note }, at, g, pan, 'perc');
    B.howl = (at, f, g, pan, o) => B.add('howl', Object.assign({ f, d: 2.6, seed: Math.round(f) }, o), at, g, pan, 'amb');
    B.organ = (notes, at, beats, g, o) => {
      o = o || {}; const k = 0.85 / Math.sqrt(notes.length);
      notes.forEach((n, j) => B.sus('organ', { ms: [nm(n)], len: 3.6, att: .05, rel: .05, mono: 1 }, at, sec(beats), g * k, j % 2 ? 0.3 : -0.3, 'pad', { att: o.att || 1.2, rel: o.rel || 1.5 }));
    };
    B.shout = (at, note, g, o) => {
      const m = nm(note || 'D3');
      B.add('voice', Object.assign({ reg: 'T', n: 8, notes: [[0.05, 0.12, m, '_'], [0.17, 0.22, m - 5]], vp: [[0, 'e'], [0.16, 'e'], [0.34, 'i']], eff: 1, breath: .25, h: 1, glide: .04, jump: .01, att: .015, rel2: .07, scoop: 0, vib: .3, mono: 1, srk: .4, seed: 77 }, o), at, g, 0, 'lead', -0.04);
    };
    return B;
  }

  // ════════ The score ════════
  const MINOR = { 11: 10 }, MIXO = { 5: 6 };
  const THRONE = 'D4:2 A4:1.5 G4:.5 | F4:1 G4:1 A4:2 | C5:1.5 B4:.5 A4:1 G4:1 | A4:4 / D5:2 C5:1 A4:1 | B4:1.5 A4:.5 G4:1 F4:1 | E4:1 F4:1 G4:1 E4:1 | D4:4';
  const THRONE_CH = 'Dm F G Am Dm:2 F:2 G:2 Dm:2 C Dm', THRONE_CHm = 'Dm F Gm A Dm:2 F:2 Gm:2 Dm:2 C Dm', THRONE_CHx = 'D D G A D:2 Am:2 G:2 D:2 C D';
  const DESC = 'A5:4 | C6:2 A5:2 | B5:2 D6:2 | E6:2 C6:2 | D6:2 C6:2 | B5:2 A5:2 | G5:2 C6:2 | A5:4';
  const THRONE_V = ['a', 'a', 'o', 'a', 'o', 'a', 'e', 'o', 'a', 'o', 'a', 'o', 'a', 'e', 'a', 'o', 'a', 'o', 'e', 'a', 'o', 'a', 'o'];
  // Stella Splendens (Llibre Vermell), D Dorian; one beat = one quarter of the 2/4 original.
  const STELLA_R1 = 'A4:1 A4:.5 G4:.5 | A4:1 F4:1 | D4:1 F4:1 | G4:2_ | Bb4:.5_ A4:.5_ F4:.5_ G4:.5 | E4:1 D4:1 | F4:1 G4:1 | G4:.5_ F4:.5 D4:1 | C4:2';
  const STELLA_R2 = 'A4:1 A4:.5 G4:.5 | A4:1 F4:1 | D4:1 F4:1 | G4:2_ | Bb4:.5_ A4:.5_ F4:.5_ G4:.5 | E4:1 D4:1 | F4:1 G4:1 | G4:.5_ F4:.5 D4:.5_ E4:.25_ C4:.25 | D4:2';
  const STELLA_V = 'D4:1 D4:1 | A4:1 B4:1 | D5:1 B4:1_ | C5:.5 A4:.5 G4:1 | B4:1 C5:1 | A4:1 G4:.5_ F4:.5 | F4:.5_ E4:.5 D4:1';
  // Tourdion (Attaingnant 1530), E Aeolian, 3/2 (one beat = one quarter).
  const TOUR_A = 'E4:1 F#4:1 G4:1 A4:1 G4:1 F#4:1 | E4:3 F#4:1 G4:1 A4:1 | B4:1 A4:1 G4:1 G4:1 A4:1 F#4:1 | G4:2 F#4:1 E4:1 D4:2 | E4:1 F#4:1 G4:1 A4:1 G4:1 F#4:1 | E4:2 G4:2 F#4:2 | E4:4 D4:2 | E4:6';
  const TOUR_B = 'B4:3 A4:1 B4:1 C5:1 | B4:4 B4:2 | D5:1 C5:1 B4:1 A4:1 G4:1 F#4:1 | G4:3 F#4:1 E4:2 | B4:3 A4:1 B4:1 C5:1 | B4:2 A4:1 G4:1 F#4:2 | E4:4 D4:2 | E4:6';
  const TOUR_CA = 'Em Em G:4 Am:2 Em:2 D:4 Em Em:4 D:2 Em:2 Bm:4 Em', TOUR_CB = 'Em G D Em G G:4 D:2 Em:2 Bm:4 Em';
  // Saltarello (14th c. Italian), E Dorian, 2/4 (one beat = one eighth).
  const SALT_1 = 'B4:1 E4:1 B4:1 E4:1 | B4:1 E4:1 B4:2 | A4:1 F#4:.5 G4:.5 A4:.5 G4:.5 F#4:.5 G4:.5 | E4:1 B4:1 E4:2 | E4:1 F#4:1 G4:.5 F#4:.5 G4:.5 E4:.5 | D4:1 A4:1 D4:2 | E4:2 A4:1.5 F#4:.5 | G4:2 F#4:.5 E4:.5 D4:.5 F#4:.5 | E4:2 B4:2';
  const SALT_2 = 'A4:1 E4:1 A4:1 E4:1 | A4:1 E4:1 A4:.5 G4:.5 F#4:.5 G4:.5 | E4:1 B4:1 E4:2 | A4:.5 G4:.5 F#4:.5 G4:.5 F#4:.5 E4:.5 F#4:.5 G4:.5 | A4:1 E4:1 A4:1 E4:1 | A4:1 E4:1 A4:.5 G4:.5 F#4:.5 G4:.5 | E4:1 B4:1 E4:2 | D4:.5 E4:.5 F#4:.5 G4:.5 E4:.5 F#4:.5 G4:.5 A4:.5';
  // Ai vist lo lop (Occitan trad.), G Dorian, 2/4 (one beat = one eighth).
  const LOP = 'D5:1 C5:1 Bb4:1 Bb4:.5 Bb4:.5 | C5:1 C5:.5 C5:.5 Bb4:.5 A4:.5 G4:1 | D5:1 C5:1 Bb4:1 Bb4:.5 Bb4:.5 | C5:1 A4:1 G4:2 / G4:1 A4:1 Bb4:.5 Bb4:.5 Bb4:.5 Bb4:.5 | Bb4:1 C5:1 A4:2 | Bb4:1 A4:1 G4:1 G4:.5 G4:.5 | A4:1.5 A4:.5 F4:.5 E4:.5 D4:1 / G4:1 A4:1 Bb4:1 Bb4:.5 Bb4:.5 | Bb4:1 C5:1 A4:2 | Bb4:1 A4:.5 Bb4:.5 G4:1 G4:.5 G4:.5 | G4:1 F4:1 G4:2';
  const LOP_SLOW = 'D5:1 C5:1 Bb4:1 Bb4:.5 Bb4:.5 | C5:1 C5:.5 C5:.5 Bb4:.5 A4:.5 G4:1 | D5:1 C5:1 Bb4:1 Bb4:.5 Bb4:.5 | C5:1 A4:1 G4:2~ / G4:1 A4:1 Bb4:.5 Bb4:.5 Bb4:.5 Bb4:.5 | Bb4:1 C5:1 A4:2c | Bb4:1 A4:1 G4:1 G4:.5 G4:.5 | A4:1.5 A4:.5 F4:.5 E4:.5 D4:1 / G4:1 A4:1 Bb4:1 Bb4:.5 Bb4:.5 | Bb4:1 C5:1 A4:2~ | Bb4:1 A4:.5 Bb4:.5 G4:1 G4:.5 G4:.5 | G4:1 F4:1 G4:2';
  const LOP_CH = 'Gm F Gm F:2 Gm:2 Gm F Gm Dm Gm F Gm Gm';
  // Greensleeves (16th c. English), A Dorian/Aeolian, 3/4.
  const GS_V = 'C5:2 D5:1 | E5:1.5 F#5:.5 E5:1 | D5:2 B4:1 | G4:1.5 A4:.5 B4:1 | C5:2 A4:1 | A4:1.5 G#4:.5 A4:1 | B4:2 G#4:1 | E4:2 A4:1 / C5:2 D5:1 | E5:1.5 F#5:.5 E5:1 | D5:2 B4:1 | G4:1.5 A4:.5 B4:1 | C5:1.5 B4:.5 A4:1 | G#4:1.5 F#4:.5 G#4:1 | A4:3 | A4:2';
  const GS_R = 'G5:3 | G5:1.5 F#5:.5 E5:1 | D5:2 B4:1 | G4:1.5 A4:.5 B4:1 | C5:2 A4:1 | A4:1.5 G#4:.5 A4:1 | B4:2 G#4:1 | E4:3 / G5:3 | G5:1.5 F#5:.5 E5:1 | D5:2 B4:1 | G4:1.5 A4:.5 B4:1 | C5:1.5 B4:.5 A4:1 | G#4:1.5 F#4:.5 G#4:1 | A4:3 | A4:3';
  const GS_VC = 'Am C G Em Am Am E E Am C G Em F E Am Am', GS_RC = 'C Em G Em Am Am E E C Em G Em F E Am Am';
  // Dies irae (Gregorian sequence, mode 1): lines 1-3 with the chant's syllable vowels.
  const DIES1 = 'F4:1 E4:1 F4:1 D4:1 | E4:1 C4:1 D4:2', DIES1V = ['i', 'e', 'i', 'e', 'i', 'e', 'i', 'a'];
  const DIES2 = 'F4:1 F4:.5_ G4:.5 F4:.5_ E4:.5 D4:.5_ C4:.5 | E4:1 F4:1 E4:1 D4:1', DIES2V = ['o', 'e', 'e', 'e', 'e', 'u', 'u', 'i', 'a', 'i', 'a'];
  const DIES3 = 'A3:1 C4:.5_ D4:.5 D4:1 D4:.5_ C4:.5 | C4:1 F4:1 E4:1 D4:1', DIES3V = ['e', 'e', 'e', 'a', 'i', 'i', 'u', 'i', 'i', 'a'];
  // The war dance (original), A Phrygian, 7/8 (one beat = one eighth).
  const WAR = 'E5:2^ F5:2 E5:1 D5:1 C5:1 | D5:2 E5:1 F5:1 E5:3 | A5:2^ G5:2 F5:1 E5:1 D5:1 | E5:2 F5:1 E5:1 D5:1 C5:1 Bb4:1 | A4:2^ C5:2 E5:1 F5:1 G5:1 | A5:2^ G5:1 F5:1 E5:3 | F5:2 E5:1 D5:1 C5:1 Bb4:1 C5:1 | A4:4 r:3';
  const THRONE_PHR = 'A3:4 E4:3 D4:1 | C4:2 D4:2 E4:4 | G4:3 F4:1 E4:2 D4:2 | E4:8 / A4:4 G4:2 E4:2 | F4:3 E4:1 D4:2 C4:2 | Bb3:2 C4:2 D4:2 Bb3:2 | A3:8';
  const PIPES = 'A5:1w Bb5:.5 A5:.5 G5:1 A5:2 r:2 | E5:.5 F5:.5 G5:.5 A5:.5 Bb5:1^ A5:1 G5:1 r:2 | D5:.5 E5:.5 F5:.5 G5:.5 A5:2w r:3 | Bb5:1^ A5:1 G5:1 F5:1 E5:1 r:2';
  const OST = {
    a: 'A2:1^. A2:1. A3:1^. A2:1. Bb2:1^. A2:1. G2:1.', f: 'F2:1^. F2:1. F3:1^. F2:1. G2:1^. F2:1. E2:1.',
    g: 'G2:1^. G2:1. G3:1^. G2:1. A2:1^. G2:1. F2:1.', e: 'A2:1^. A2:1. E3:1^. A2:1. Bb2:1^. A2:1. E2:1.',
  };
  const VIC_B = 'B4:2 A4:1 G4:1 | A4:2 D5:2 | C5:1.5 B4:.5 A4:1 G4:1 | A4:4 / B4:2 C5:1 D5:1 | E5:2 D5:1 C5:1 | B4:1 A4:1 G4:1 E4:1 | D4:4';
  const VIC_DESC = 'F#5:4 | A5:2 F#5:2 | G5:2 B5:2 | C#6:2 E6:2 | D6:2 C6:2 | B5:2 A5:2 | G5:2 C6:2 | A5:4';
  const ROUNDS = 'D6:.5 C6:.5 B5:.5 A5:.5 G5:.5 F#5:.5 E5:.5 D5:.5';

  const TRACKS = {
    // ── TITLE: the mythic overture. D Dorian, 72 bpm. A lone voice, then choir, horns, war drums.
    title: {
      ir: 'cathedral', wet: .5, send: { lead: .5, pad: .65, perc: .4, low: .25, amb: .3 }, lv: 1,
      intro: ['I'], loop: ['A', 'B', 'C', 'D'],
      sec: {
        I: { bpm: 72, meter: 4, bars: 4, build(B) {
          B.amb('wind', 0, 16, .45);
          B.hold('basses', 'D2', 0, 16, { g: .3, stroke: 8 }); B.hold('celli', 'A2', 4, 12, { g: .2, stroke: 6 });
          B.drum('gong', 'X', { bars: 1, g: .45 });
          B.drum('taiko', ['X...............', '........X.......', 'X...............', 'X.......x...x.x.'], { g: .685 });
          B.swell(12, 4, .3);
          B.mel('horns', 'D3:1.5 A3:.5 D4:4', { at: 5, g: .5 });
        } },
        A: { bpm: 72, meter: 4, bars: 8, build(B) {
          B.amb('wind', 0, 32, .3);
          B.mel('alto', THRONE, { g: 1, vow: THRONE_V });
          B.hold('basses', 'D2', 0, 32, { g: .22, stroke: 8 });
          const ch = B.chords(THRONE_CH).filter(c => c.b >= 16);
          B.pad('choir', ch, { parts: 'TB', vow: ['u', 'o'], g: .6, eff: .3 });
          B.arp('harp', ch, ARP.up8, { lo: 38, hi: 74, g: .4 });
          B.drum('taiko', ['X...............', '................', '................', '................'], { g: .4 });
        } },
        B: { bpm: 72, meter: 4, bars: 8, build(B) {
          const ch = B.chords(THRONE_CH);
          B.mel('horns', THRONE, { g: .85 }); B.mel('horns', THRONE, { tr: -12, g: .5, seed: 'lo' });
          B.pad('choir', ch, { vow: ['a', 'o'], g: .55, eff: .5 });
          B.arp('harp', ch, ARP.up8, { lo: 38, hi: 74, g: .35 });
          B.ost(ch, OSTP.eighths, { lo: 38, g: .4, gb: .28 });
          B.drum('taiko', ['X...x...X..x.x..', 'X...x...X..x.xx.'], { g: .6 });
          B.drum('stick', '..x...x...x...x.', { g: .35, pan: .3 });
          B.drum('gong', 'X', { bars: 1, g: .3 });
          B.swell(28, 4, .35);
        } },
        C: { bpm: 72, meter: 4, bars: 8, build(B) {
          const ch = B.chords(THRONE_CH);
          B.mel('choirS', THRONE, { vow: THRONE_V, g: .75 }); B.mel('choirT', THRONE, { tr: -12, vow: THRONE_V, g: .75 });
          B.mel('fiddles', DESC, { g: .55 });
          B.pad('horns', ch, { parts: 'ATB', g: .5 });
          B.pad('choir', ch, { parts: 'AB', vow: 'a', g: .35 });
          B.ost(ch, OSTP.eighths, { lo: 38, g: .45, gb: .32 });
          B.drum('taiko', ['X.x.X.x.X.xxX.x.', 'X.x.X.x.X.xxX.xx'], { g: .68 });
          B.drum('tapan', ['..x...x...x...x.'], { g: .45, pan: -.2 });
          B.drum('cym', 'X', { bars: 1, g: .3 });
          [0, 8, 16, 24].forEach(b => B.bell('church', 'D3', b, .45, -.3));
          B.swell(28, 4, .25);
        } },
        D: { bpm: 72, meter: 4, bars: 8, build(B) {
          const ch = B.chords(THRONE_CHm);
          B.mel('cello', THRONE, { tr: -12, map: MINOR, g: .7 });
          B.pad('choir', ch, { parts: 'SATB', vow: 'u', g: .35, eff: .25 });
          B.arp('harp', ch, ARP.slow4, { lo: 38, hi: 70, g: .35, thin: .25 });
          B.hold('basses', 'D2', 0, 32, { g: .22, stroke: 8 });
          B.drum('taiko', ['X...............', '................', '................', '................'], { g: .45 });
          B.amb('wind', 16, 16, .3);
        } },
      },
    },
    // ── EXPLORE: Stella Splendens as a wandering ballad. D Dorian, 63 bpm, 2/4.
    explore: {
      ir: 'field', wet: .5, send: { lead: .5, pad: .55, perc: .35, low: .3, amb: .1 }, lv: 1.15,
      intro: [], loop: ['I', 'R1', 'BR', 'V', 'R2', 'CO'],
      sec: {
        I: { bpm: 63, meter: 2, bars: 4, build(B) {
          B.amb('wind', 0, 8, .8); B.hold('celli', 'D2', 0, 8, { g: .3, stroke: 8 }); B.hold('viols', 'A2', 2, 6, { g: .25, stroke: 6 });
          B.arp('harp', B.chords('Dm Dm C Dm'), ARP.two8, { lo: 38, hi: 69, g: .6, thin: .2 });
        } },
        R1: { bpm: 63, meter: 2, bars: 18, build(B) {
          const ch = B.chords('Dm Dm Dm C Bb C F Dm C Dm Dm Dm C Bb C F C Dm');
          B.mel(B.rep % 2 ? 'fiddle' : 'viol', STELLA_R1 + ' / ' + STELLA_R2, { g: .55, tr: B.rep % 2 ? 12 : 0 });
          B.arp('harp', ch, ARP.two8, { lo: 38, hi: 69, g: .4 });
          B.hold('celli', 'D2', 0, 36, { g: .28, stroke: 6 });
          B.amb('wind', 0, 36, .25);
        } },
        BR: { bpm: 63, meter: 2, bars: 4, build(B) {
          B.amb('wind', 0, 8, .8);
          B.arp('harp', B.chords('Dm C Bb A5'), ARP.two8, { lo: 38, hi: 74, g: .6 });
          B.hold('celli', 'D2', 0, 8, { g: .22, stroke: 8 });
        } },
        V: { bpm: 63, meter: 2, bars: 14, build(B) {
          const ch = B.chords('Dm G G C G Dm Dm Dm G G C G Dm Dm');
          B.mel('lowwhistle', STELLA_V + ' / ' + STELLA_V.replace('G4:1 |', 'G4:1c |'), { g: .55 });
          B.pad('strings', ch.filter(c => c.b >= 14), { parts: 'T', g: .45 });
          B.arp('harp', ch, ARP.two8, { lo: 38, hi: 69, g: .35 });
          B.hold('celli', 'D2', 0, 28, { g: .25, stroke: 7 });
          B.drum('frame', ['X...', 'x...'], { bars: 7, at: 14, g: .35 });
          B.amb('wind', 0, 28, .22);
        } },
        R2: { bpm: 63, meter: 2, bars: 18, build(B) {
          const ch = B.chords('Dm Dm Dm C Bb C F Dm C Dm Dm Dm C Bb C F C Dm');
          B.mel('fiddle', STELLA_R1 + ' / ' + STELLA_R2, { g: .5, tr: 12 });
          B.mel(B.rep % 2 ? 'viol' : 'lowwhistle', STELLA_R1 + ' / ' + STELLA_R2, { g: .28, tr: 0 });
          B.pad('strings', ch, { parts: 'ATB', g: .4 });
          B.pad('choir', ch, { parts: 'SA', vow: 'u', g: .3, eff: .25 });
          B.arp('harp', ch, ARP.two8, { lo: 38, hi: 69, g: .35 });
          B.drum('frame', ['X..o', 'x...'], { g: .35 });
          B.amb('wind', 0, 36, .2);
        } },
        CO: { bpm: 63, meter: 2, bars: 6, build(B) {
          B.arp('harp', B.chords('Dm C Dm:4'), ARP.two8, { lo: 38, hi: 74, g: .6 });
          B.arp('harp', B.chords('Dm:2', { at: 10 }), ARP.roll, { lo: 38, hi: 74, g: .6 });
          B.hold('celli', 'D2', 0, 12, { g: .22, stroke: 12 });
          B.amb('wind', 0, 12, .8);
        } },
      },
    },
    // ── TAVERN: the Tourdion and a Saltarello. E Aeolian/Dorian, one bar of 3/2 = 1.33 s.
    tavern: {
      ir: 'wood', wet: .45, send: { lead: .3, pad: .35, perc: .3, low: .25, amb: .15 }, lv: .8,
      intro: ['I'], loop: ['A1', 'A2', 'B1', 'B2', 'S', 'A3', 'B3'],
      sec: {
        I: { bpm: 270, meter: 6, bars: 2, build(B) {
          B.amb('crowd', 0, 12, .35);
          B.gurdy({ beats: 12, drone: ['E3', 'B3'], tromp: 'X..x..', g: .7 });
          B.drum('bodhran', ['X.o.x.X.o.xo', 'X.o.x.X.oxxx'], { g: .6 });
        } },
        A1: { bpm: 270, meter: 6, bars: 8, build(B) {
          const ch = B.chords(TOUR_CA);
          B.mel('recorder', TOUR_A, { tr: 12, g: .8 });
          B.strum('lute', ch, 'D.dudu', { g: .5 });
          B.gurdy({ beats: 48, drone: ['E3', 'B3'], tromp: 'X..x..', g: .45 });
          B.drum('bodhran', ['X.o.x.X.o.xo', 'X.o.x.X.oxo.'], { g: .6 });
          B.drum('shake', 'o.x.o.x.o.x.', { g: .3, pan: .35 });
          B.amb('crowd', 0, 48, .3);
        } },
        A2: { bpm: 270, meter: 6, bars: 8, build(B) {
          const ch = B.chords(TOUR_CA);
          B.mel('fiddle', TOUR_A, { g: .9 });
          B.mel('recorder', TOUR_A, { tr: 12, dia: [SCALE.Em_aeo, -2], g: .5 });
          B.strum('lute', ch, 'D.dudu', { g: .5 });
          B.gurdy({ beats: 48, drone: ['E3', 'B3'], tromp: 'X..x..', g: .45 });
          B.drum('bodhran', ['X.o.x.X.o.xo', 'X.o.x.X.oxo.'], { g: .6 });
          B.drum('tamb', '..x...x...x.', { g: .35, pan: .35 });
          B.drum('clap', 'x...x...x...', { bars: 4, at: 24, g: .4, pan: -.2 });
          B.amb('crowd', 0, 48, .3);
        } },
        B1: { bpm: 270, meter: 6, bars: 8, build(B) {
          const ch = B.chords(TOUR_CB);
          B.mel('fiddle', TOUR_B, { g: .9 }); B.mel('recorder', TOUR_B, { tr: 12, g: .6 });
          B.strum('lute', ch, 'D.dudu', { g: .5 });
          B.gurdy({ beats: 48, drone: ['E3', 'B3'], tromp: ['X..x..', 'X.xX.x'], g: .45 });
          B.drum('bodhran', ['X.o.x.X.o.xo', 'X.x.X.x.X.xx'], { g: .62 });
          B.drum('clap', 'x...x...x...', { g: .45, pan: -.2 });
          B.drum('zills', ['x...........', '............', '............', '............'], { g: .25, pan: .4 });
          B.drum('shake', 'o.x.o.x.o.x.', { g: .3, pan: .35 });
          B.amb('crowd', 0, 48, .3);
        } },
        B2: { bpm: 270, meter: 6, bars: 8, build(B) {
          const ch = B.chords(TOUR_CB);
          B.gurdy({ beats: 48, drone: ['E3', 'B3'], notes: TOUR_B, tromp: ['X..x..', 'X.xX.x'], g: .7 });
          B.mel('fiddle', TOUR_B, { dia: [SCALE.Em_aeo, 2], g: .6 });
          B.strum('lute', ch, 'D.dudu', { g: .5 });
          B.drum('bodhran', ['X.o.x.X.o.xo', 'X.x.X.x.X.xx'], { g: .62 });
          B.drum('tamb', '..x...x...x.', { g: .35, pan: .35 });
          B.drum('clap', 'x...x...x...', { g: .45, pan: -.2 });
          B.shout(45, 'E3', .55);
          B.amb('crowd', 0, 48, .3);
        } },
        S: { bpm: 270, meter: 4, bars: 28, build(B) {
          B.mel('shawm', SALT_1 + ' | E4:2 F#4:1 G4:1 / ' + SALT_2 + ' / ' + SALT_1 + ' | E4:4', { tr: 12, g: .75 });
          B.mel('bombard', SALT_1 + ' | E4:2 F#4:1 G4:1 / ' + SALT_2 + ' / ' + SALT_1 + ' | E4:4', { g: .45 });
          B.mel('fiddle', SALT_2, { at: 40, g: .6 });
          B.gurdy({ beats: 112, drone: ['E3', 'B3'], tromp: 'X.xxX.xx', g: .5 });
          B.drum('tabor', ['X.oxX.ox', 'X.oxXoxx'], { g: .5, pan: -.15 });
          B.drum('tapan', ['X...X...', 'X...X.x.'], { g: .38 });
          B.drum('clap', '..x...x.', { g: .35, pan: .25, at: 40, bars: 18 });
          B.shout(108, 'E3', .55);
          B.amb('crowd', 0, 112, .3);
        } },
        A3: { bpm: 270, meter: 6, bars: 8, build(B) {
          const ch = B.chords(TOUR_CA);
          B.mel('fiddles', TOUR_A, { g: .75 }); B.mel('recorder', TOUR_A, { tr: 12, g: .5 });
          B.mel('alto', TOUR_A, { vow: ['a', 'e', 'a', 'i', 'a', 'o'], g: .8, args: { eff: .65 } });
          B.gurdy({ beats: 48, drone: ['E3', 'B3'], notes: TOUR_A, tromp: 'X..x..', g: .45 });
          B.strum('lute', ch, 'D.dudu', { g: .5 });
          B.drum('bodhran', ['X.o.x.X.o.xo', 'X.x.X.x.X.xx'], { g: .62 });
          B.drum('tamb', '..x...x...x.', { g: .35, pan: .35 });
          B.drum('clap', 'x...x...x...', { g: .45, pan: -.2 });
          B.amb('crowd', 0, 48, .3);
        } },
        B3: { bpm: 270, meter: 6, bars: 8, build(B) {
          const ch = B.chords(TOUR_CB);
          B.mel('fiddles', TOUR_B, { g: .75 }); B.mel('recorder', TOUR_B, { tr: 12, g: .5 }); B.mel('fiddle', TOUR_B, { dia: [SCALE.Em_aeo, 2], g: .45 });
          B.mel('alto', TOUR_B, { vow: ['a', 'o', 'a', 'e', 'a', 'i'], g: .7, args: { eff: .65 } });
          B.gurdy({ beats: 48, drone: ['E3', 'B3'], notes: TOUR_B, tromp: ['X..x..', 'X.xX.x'], g: .45 });
          B.strum('lute', ch, 'D.dudu', { g: .5 });
          B.drum('bodhran', ['X.x.X.x.X.xx'], { g: .65, last: 'X.x.X.......' });
          B.drum('clap', 'x...x...x...', { g: .45, pan: -.2 });
          B.drum('zills', ['x...........', '............'], { g: .25, pan: .4 });
          B.shout(21, 'E3', .5); B.shout(42, 'E3', .6);
          B.amb('crowd', 0, 48, .3);
        } },
      },
    },
    // ── WOLVES: Ai vist lo lop, first as a lonely call, then as a hunt. G Dorian.
    wolves: {
      ir: 'forest', wet: .5, send: { lead: .45, pad: .55, perc: .3, low: .25, amb: .5 }, lv: .78,
      intro: ['I'], loop: ['S', 'T', 'H1', 'K', 'H2'],
      sec: {
        I: { bpm: 110, meter: 4, bars: 4, build(B) {
          B.amb('wind', 0, 16, .6);
          B.hold('celli', 'G2', 0, 16, { g: .35, stroke: 8 });
          B.mel('fiddle', 'D6:4_ F6:3_ D6:5_ C6:4', { g: .16, args: { vib: .5 } });
          B.drum('frame', ['X.x.............', '................'], { g: .5 });
          B.howl(3, 520, .5, -.5); B.howl(11, 455, .3, .6, { far: 1 });
        } },
        S: { bpm: 110, meter: 4, bars: 12, build(B) {
          const ch = B.chords(LOP_CH);
          B.mel('lowwhistle', LOP_SLOW, { g: .6 });
          B.hold('celli', 'G2', 0, 48, { g: .3, stroke: 8 }); B.hold('viols', 'D3', 0, 48, { g: .18, stroke: 12 });
          B.pad('choir', ch, { parts: 'TB', vow: 'u', g: .35, eff: .2 });
          B.arp('harp', ch, ARP.roll, { lo: 43, hi: 74, g: .3 });
          B.drum('frame', ['X.x.............'], { g: .35 });
          B.amb('wind', 0, 48, .35);
          B.howl(44, 500, .4, .5);
        } },
        T: { bpm: 208, meter: 4, bars: 4, build(B) {
          B.drum('frame', 'X.xxX.xx', { g: .8, cresc: 1 });
          B.drum('rattle', '..x...x.', { g: .35, pan: .4 });
          B.mel('celli', 'G2:1^. G2:1. G2:1. G2:1. G2:1^. G2:1. G2:1. G2:1. G2:1^. G2:1. G2:1. G2:1. G2:1^. G2:1. D3:1. F3:1.', { each: 1, g: .55 });
          B.howl(0, 560, .5, -.3);
          B.swell(8, 8, .3);
        } },
        H1: { bpm: 208, meter: 4, bars: 24, build(B) {
          const ch = B.chords(LOP_CH + ' ' + LOP_CH);
          B.mel('fiddle', LOP + ' / ' + LOP, { g: .85 }); B.mel('whistle', LOP + ' / ' + LOP, { tr: 12, g: .5 });
          B.ost(ch, OSTP.hunt, { lo: 38, g: .5, gb: .3 });
          B.pad('choir', ch, { parts: 'TB', vow: ['o', 'u'], g: .45, eff: .4 });
          B.pad('strings', ch.filter(c => c.b >= 48), { parts: 'AT', g: .4 });
          B.drum('frame', 'X.xxX.xx', { g: .6 }); B.drum('bodhran', 'x.o.x.oox.o.x.oo', { g: .35, pan: -.25 });
          B.drum('rattle', ['......x.', '..x.....'], { g: .3, pan: .4 }); B.drum('stomp', 'X.......', { g: .45 });
          [12, 28, 44, 60, 76, 92].forEach(b => B.mel('horn', 'G3:1 D4:1 G4:2', { at: b, g: .35, pan: .3 }));
        } },
        K: { bpm: 208, meter: 4, bars: 8, build(B) {
          B.drum('frame', ['X..xX.x.', 'X..xX.xx'], { g: .85 }); B.drum('stomp', 'X...X...', { g: .6 });
          B.drum('frameSlap', '..x...x.', { g: .5, pan: .3 }); B.drum('rattle', '....x...', { g: .35, pan: -.4 });
          B.pad('choir', B.chords('Gm:16 F:8 Gm:8'), { parts: 'TB', vow: ['o', 'a', 'o'], g: .55, eff: .55 });
          [4, 12, 20, 28].forEach(b => B.shout(b, 'G2', .5));
          B.howl(2, 540, .45, -.6); B.howl(18, 600, .35, .6, { far: 1 });
        } },
        H2: { bpm: 208, meter: 4, bars: 14, build(B) {
          const ch = B.chords(LOP_CH + ' Gm:8');
          B.mel('fiddles', LOP, { g: .8 }); B.mel('whistle', LOP, { tr: 12, g: .45 }); B.mel('lowwhistle', LOP, { g: .5 });
          B.mel('choirT', LOP, { tr: -12, vow: ['o', 'a', 'o', 'e'], g: .6 });
          B.ost(B.chords(LOP_CH), OSTP.hunt, { lo: 38, g: .5, gb: .3 });
          B.pad('choir', ch, { parts: 'B', vow: 'o', g: .45 });
          B.drum('frame', 'X.xxX.xx', { g: .6, bars: 12 }); B.drum('bodhran', 'x.o.x.oox.o.x.oo', { g: .35, pan: -.25, bars: 12 }); B.drum('stomp', 'X.......', { g: .45, bars: 12 });
          [12, 28, 44].forEach(b => B.mel('horn', 'G3:1 D4:1 G4:2', { at: b, g: .35, pan: .3 }));
          B.drum('frame', 'X.......', { at: 48, bars: 1, g: .9 }); B.drum('gong', 'X', { at: 48, bars: 1, g: .25 });
          B.hold('celli', 'G2', 48, 8, { g: .4, stroke: 8 });
          B.howl(50, 520, .45, .4);
        } },
      },
    },
    // ── NIGHT: Greensleeves as a princess's lament. A Dorian, 3/4 at 58 bpm.
    night: {
      ir: 'forest', wet: .55, send: { lead: .5, pad: .55, perc: .45, low: .3, amb: .2 }, lv: 1.2,
      intro: ['I'], loop: ['V', 'R', 'O'],
      sec: {
        I: { bpm: 58, meter: 3, bars: 4, build(B) {
          B.amb('crickets', 0, 12, .12); B.amb('wind', 0, 12, .25);
          B.arp('harp', B.chords('Am Em Am E'), ARP.waltz, { lo: 45, hi: 76, g: .38 });
          B.hold('viols', 'A2', 0, 12, { g: .18, stroke: 6 });
          [[1, 'E6'], [4.5, 'A6'], [6, 'C6'], [9.5, 'G6']].forEach(([b, n]) => B.bell('mbox', n, b, .22, .4));
          B.mel(B.rep % 2 ? 'recorder' : 'sop', 'A4:1', { at: 11, vow: 'u', g: .8, args: { eff: .25 } });
        } },
        V: { bpm: 58, meter: 3, bars: 16, build(B) {
          const ch = B.chords(GS_VC);
          if (B.rep % 2) B.mel('recorder', GS_V, { g: .8 }); else B.mel('sop', GS_V, { vow: ['u', 'u', 'o', 'u', 'o'], g: .9, args: { eff: .25, breath: .14 } });
          B.arp('harp', ch, ARP.waltz, { lo: 45, hi: 74, g: .35 });
          B.pad('strings', ch, { parts: 'TB', g: .25 });
          B.amb('crickets', 0, 48, .1);
          [[20, 'E6'], [22.5, 'A6'], [44, 'C6'], [46, 'E6']].forEach(([b, n]) => B.bell('mbox', n, b, .2, .45));
        } },
        R: { bpm: 58, meter: 3, bars: 16, build(B) {
          const ch = B.chords(GS_RC);
          B.mel('fiddle', GS_R, { g: .5, args: { vib: .8 } });
          B.pad('choir', ch, { parts: 'A', n: 1, vow: B.rep % 2 ? 'a' : 'u', g: .45, eff: .25 });
          B.arp('harp', ch, ARP.waltz, { lo: 45, hi: 74, g: .33 });
          B.pad('strings', ch, { parts: 'B', g: .25 });
          B.amb('crickets', 0, 48, .1);
          [[21, 'A6'], [22, 'E6'], [45, 'C6'], [46.5, 'A5']].forEach(([b, n]) => B.bell('mbox', n, b, .2, .45));
        } },
        O: { bpm: 58, meter: 3, bars: 2, build(B) {
          B.arp('harp', B.chords('Am:6'), ARP.roll3, { lo: 45, hi: 81, g: .4 });
          B.bell('mbox', 'A6', 1, .25, .4); B.bell('mbox', 'E6', 2.5, .18, -.3);
          B.bell('church', 'A3', 0, .12, -.4);
          B.amb('crickets', 0, 6, .12); B.hold('viols', 'A2', 0, 6, { g: .15, stroke: 6 });
          B.mel(B.rep % 2 ? 'sop' : 'recorder', 'A4:1', { at: 5, vow: 'u', g: .8, args: { eff: .25 } });
        } },
      },
    },
    // ── COMBAT: an original war dance. A Phrygian, 7/8 (2+2+3) and 4/4, eighth = 336 bpm.
    combat: {
      ir: 'hall', wet: .4, send: { lead: .3, pad: .45, perc: .25, low: .12, amb: .2 }, lv: .95,
      intro: ['I'], loop: ['A', 'B', 'C', 'A2', 'D'],
      sec: {
        I: { bpm: 336, meter: 8, bars: 2, build(B) {
          B.drum('tapan', ['X.x.x.x.x.x.x.x.', 'x.x.x.xxx.xxXXXX'], { g: .8, cresc: 1 });
          B.swell(0, 16, .35); B.shout(15, 'A2', .55);
          B.hold('basses', 'A1', 0, 16, { g: .45, stroke: 16 });
        } },
        A: { bpm: 336, meter: 7, bars: 8, build(B) {
          ['a', 'a', 'a', 'e', 'f', 'g', 'a', 'e'].forEach((k, i) => { B.mel('celli', OST[k], { at: i * 7, each: 1, g: .6 }); B.mel('basses', OST[k], { at: i * 7, tr: -12, each: 1, g: .2 }); });
          B.drum('taiko', ['X...X...X..x..'], { g: .68, last: 'X.x.X.xxX.x.xx' });
          B.drum('stick', '..x...x...x.x.', { g: .35, pan: .3 }); B.drum('tabor', 'x.o.x.o.x.o.xo', { g: .3, pan: -.25 });
          for (let b = 0; b < 56; b += 14) B.mel('bombard', 'A3:1^ r:6 A3:.5^ A3:.5^', { at: b, g: .45 });
        } },
        B: { bpm: 336, meter: 7, bars: 8, build(B) {
          ['a', 'a', 'a', 'e', 'f', 'g', 'a', 'e'].forEach((k, i) => { B.mel('celli', OST[k], { at: i * 7, each: 1, g: .55 }); B.mel('basses', OST[k], { at: i * 7, tr: -12, each: 1, g: .2 }); });
          B.mel('shawm', WAR, { g: .8 }); B.mel('bombard', WAR, { tr: -12, g: .45 });
          B.drum('taiko', ['X...X...X..x..'], { g: .685, last: 'X.x.X.xxX.x.xx' });
          B.drum('stick', '..x...x...x.x.', { g: .35, pan: .3 }); B.drum('tabor', 'x.o.x.o.x.o.xo', { g: .3, pan: -.25 });
          [0, 14, 28, 42].forEach(b => B.pad('horns', B.chords('A5:1.5', { at: b }), { parts: 'TB', g: .5, noTie: 1, over: .05, att: .02 }));
          B.shout(26, 'A2', .6); B.shout(54, 'A2', .65);
        } },
        C: { bpm: 336, meter: 8, bars: 8, build(B) {
          const ch = B.chords('Am C Dm Am Am F Bb A5');
          B.mel('horns', THRONE_PHR, { g: .85 }); B.mel('horns', THRONE_PHR, { tr: -12, g: .5, seed: 'lo' });
          B.pad('choir', ch, { parts: 'SATB', vow: ['a', 'o'], g: .5, eff: .7 });
          B.ost(ch, OSTP.tre, { lo: 40, g: .5, gb: .22 });
          B.drum('taiko', ['X..x..X.X..x..x.', 'X..x..X.X..x.xxx'], { g: .685 });
          B.drum('tapan', '....x.......x...', { g: .5 }); B.drum('stick', 'x.x.x.x.x.x.x.x.', { g: .22, pan: .3 });
          B.drum('cym', 'X', { bars: 1, g: .3 }); B.drum('gong', 'X', { bars: 1, g: .25 });
        } },
        A2: { bpm: 336, meter: 7, bars: 8, build(B) {
          ['a', 'a', 'a', 'e', 'f', 'g', 'a', 'e'].forEach((k, i) => { B.mel('celli', OST[k], { at: i * 7, each: 1, g: .55 }); B.mel('basses', OST[k], { at: i * 7, tr: -12, each: 1, g: .2 }); B.mel('fiddles', OST[k], { at: i * 7, tr: 24, each: 1, g: .25 }); });
          B.mel('pipes', PIPES + ' / ' + PIPES, { g: .6 });
          B.drum('taiko', ['X...X...X..x..', 'X...X.x.X..x.x'], { g: .685, last: 'X.x.X.xxX.x.xx' });
          B.drum('stick', '..x...x...x.x.', { g: .35, pan: .3 }); B.drum('tabor', 'x.o.x.o.x.o.xo', { g: .3, pan: -.25 });
          B.drum('anvil', ['X.............', '..............'], { g: .12, pan: -.4 });
          B.shout(12, 'A2', .5); B.shout(40, 'A2', .5);
        } },
        D: { bpm: 336, meter: 7, bars: 8, build(B) {
          ['a', 'a', 'a', 'e', 'f', 'g', 'a', 'e'].forEach((k, i) => { B.mel('celli', OST[k], { at: i * 7, each: 1, g: .55 }); B.mel('basses', OST[k], { at: i * 7, tr: -12, each: 1, g: .2 }); });
          B.mel('fiddles', WAR, { g: .7 }); B.mel('shawm', WAR, { g: .6 }); B.mel('bombard', WAR, { tr: -12, g: .4 });
          B.pad('choir', B.chords('Am:7 Am:7 F:7 Am:7 F:7 Gm:7 F:7 A5:7'), { parts: 'TB', vow: ['a', 'o'], g: .45, eff: .7 });
          B.drum('taiko', ['X...X...X..x..', 'X.x.X...X.xx.x'], { g: .76, last: 'X.x.X.xxX.X.X.' });
          B.drum('stick', '..x...x...x.x.', { g: .35, pan: .3 }); B.drum('tabor', 'x.o.x.oxx.o.xo', { g: .32, pan: -.25 });
          [0, 14, 28, 42].forEach(b => B.pad('horns', B.chords('A5:1.5', { at: b }), { parts: 'TB', g: .45, noTie: 1, over: .05, att: .02 }));
          B.shout(12, 'A2', .5); B.shout(26, 'A2', .55); B.shout(40, 'A2', .55); B.shout(53, 'A2', .7);
        } },
      },
    },
    // ── BOSS: the Dragon / Bone King. Dies irae in the male choir, organ, double-time taiko,
    //    the Throne theme in minor. D Aeolian, 104 bpm.
    boss: {
      ir: 'cathedral', wet: .42, send: { lead: .45, pad: .55, perc: .3, low: .18, amb: .3 }, lv: .95,
      intro: ['I'], loop: ['A', 'B', 'C', 'D'],
      sec: {
        I: { bpm: 104, meter: 4, bars: 2, build(B) {
          B.organ(['D2', 'A2', 'D3', 'F3', 'A3'], 0, 8, .6, { att: 3 });
          B.drum('gong', 'X', { bars: 1, g: .45 });
          B.drum('taiko', ['X.......x.......', 'x.x.x.x.xxxxXXXX'], { g: .68, cresc: 1 });
          B.swell(4, 4, .35);
        } },
        A: { bpm: 104, meter: 4, bars: 6, build(B) {
          B.mel('choirT', DIES1 + ' / ' + DIES2, { vow: DIES1V.concat(DIES2V), g: .85, args: { eff: .75 } });
          B.mel('choirB', DIES1 + ' / ' + DIES2, { tr: -12, vow: DIES1V.concat(DIES2V), g: .85, args: { eff: .7 } });
          B.organ(['D2', 'A2', 'D3'], 0, 24, .33, { att: .5 });
          B.hold('basses', 'D2', 0, 24, { g: .28, stroke: 8 });
          B.drum('taiko', 'X.......X.......', { g: .8 }); B.drum('thud', 'X...............', { g: .4 });
          B.mel('horns', 'Bb2:4 A2:4', { at: 16, g: .55 });
          B.swell(20, 4, .3);
        } },
        B: { bpm: 104, meter: 4, bars: 8, build(B) {
          const ch = B.chords('Dm C:2 Dm:2 Bb:2 C:2 Am:2 Dm:2 F:2 Bb:2 Gm:2 A:2 Dm C:2 Dm:2');
          const L = DIES1 + ' / ' + DIES2 + ' / ' + DIES3 + ' / ' + DIES1, V = DIES1V.concat(DIES2V, DIES3V, DIES1V);
          B.mel('choirT', L, { vow: V, g: .8, args: { eff: .8 } }); B.mel('choirB', L, { tr: -12, vow: V, g: .8, args: { eff: .75 } }); B.mel('choirA', L, { vow: V, g: .5, args: { eff: .7 } });
          B.mel('horns', L, { tr: -12, g: .45 });
          B.ost(ch, OSTP.gallop, { lo: 38, g: .45, gb: .18 });
          B.drum('taiko', ['X.x.X.xxX.x.X.xx', 'X.x.X.xxX.xxX.xX'], { g: .7 }); B.drum('stick', 'x.x.x.x.x.x.x.x.', { g: .25, pan: .3 });
          B.drum('tapan', ['....X.......X...'], { g: .5 });
          [0, 8, 16, 24].forEach(b => B.pad('horns', B.chords('D5:1', { at: b }), { parts: 'TB', g: .45, noTie: 1, over: .05, att: .02 }));
        } },
        C: { bpm: 104, meter: 4, bars: 8, build(B) {
          const ch = B.chords(THRONE_CHm);
          B.mel('horns', THRONE, { map: MINOR, g: .9 }); B.mel('fiddles', THRONE, { tr: 12, map: MINOR, g: .6 });
          B.mel('horns', THRONE, { tr: -12, map: MINOR, g: .45, seed: 'lo' });
          B.pad('choir', ch, { vow: ['a', 'o'], g: .55, eff: .65 });
          B.ost(ch, OSTP.gallop, { lo: 38, g: .45, gb: .18 });
          B.drum('taiko', ['X..xX.x.X..xX.xx', 'X..xX.x.X..xXxXx'], { g: .72 }); B.drum('stick', 'x.x.x.x.x.x.x.x.', { g: .22, pan: .3 });
          B.drum('gong', 'X', { bars: 1, g: .35 });
          [0, 8, 16, 24].forEach(b => B.bell('church', 'D3', b, .5, -.3));
          B.swell(28, 4, .3);
        } },
        D: { bpm: 104, meter: 4, bars: 4, build(B) {
          const L = 'F4:2 E4:2 | F4:2 D4:2 | E4:2 C4:2 | D4:4', V = DIES1V;
          B.mel('choirS', L, { tr: 12, vow: V, g: .6, args: { eff: .8 } }); B.mel('choirT', L, { vow: V, g: .85, args: { eff: .85 } }); B.mel('choirB', L, { tr: -12, vow: V, g: .85, args: { eff: .8 } });
          B.mel('horns', L, { tr: -12, g: .6 });
          B.organ(['D2', 'A2', 'D3', 'F3', 'A3', 'D4'], 0, 16, .4, { att: .3 });
          B.drum('taiko', ['X.......X.......', 'X.......X.......', 'X.......X.......', 'X.x.X.x.XXXXXXXX'], { g: .68 });
          B.drum('stomp', 'X.......X.......', { g: .5, bars: 3 });
          B.drum('gong', 'X', { at: 12, bars: 1, g: .4 }); B.drum('cym', 'X', { bars: 1, g: .3 });
        } },
      },
    },
    // ── VICTORY: the Throne theme in D Mixolydian as a hymn, bells rung in rounds.
    victory: {
      ir: 'cathedral', wet: .45, send: { lead: .45, pad: .55, perc: .35, low: .2, amb: .3 }, lv: 1,
      intro: ['F'], loop: ['H1', 'B', 'H2', 'C'],
      sec: {
        F: { bpm: 76, meter: 4, bars: 2, build(B) {
          B.mel('horns', 'D4:.5^ D4:.5 D4:.5 A4:.5 D5:2^ | C5:1 A4:1 D5:2', { g: .9 }); B.mel('horns', 'D3:.5^ D3:.5 D3:.5 A3:.5 D4:2^ | C4:1 A3:1 D4:2', { g: .5, seed: 'lo' });
          B.drum('taiko', ['X.......X...X.x.', 'X.......X.......'], { g: .68 }); B.drum('cym', 'X', { bars: 1, g: .3 });
          B.bell('church', 'D4', 0, .4, -.3); B.bell('church', 'A3', 4, .3, .3);
          B.pad('choir', B.chords('D C:2 D:2'), { vow: 'a', g: .5, eff: .6 });
        } },
        H1: { bpm: 76, meter: 4, bars: 8, build(B) {
          const ch = B.chords(THRONE_CHx);
          B.mel('choirS', THRONE, { tr: 12, map: MIXO, vow: THRONE_V, g: .55 }); B.mel('choirT', THRONE, { map: MIXO, vow: THRONE_V, g: .8 });
          B.pad('choir', ch, { parts: 'AB', vow: ['a', 'o'], g: .5, eff: .5 });
          B.pad('horns', ch, { parts: 'TB', g: .35 });
          B.arp('harp', ch, ARP.up8, { lo: 38, hi: 76, g: .3 });
          [0, 4, 8, 12, 16, 20, 24, 28].forEach((b, i) => B.bell('church', i % 2 ? 'A4' : 'D4', b, .22, i % 2 ? .35 : -.35));
          B.drum('taiko', 'X.......X.......', { g: .45 });
        } },
        B: { bpm: 76, meter: 4, bars: 8, build(B) {
          const ch = B.chords('G D Am D G C G:2 A:2 D');
          B.mel('fiddle', VIC_B, { g: .85 });
          B.arp('harp', ch, ARP.up8, { lo: 38, hi: 76, g: .35 });
          B.pad('strings', ch, { parts: 'ATB', g: .4 });
          B.pad('choir', ch.filter(c => c.b >= 16), { parts: 'SA', vow: 'u', g: .35, eff: .3 });
          B.drum('frame', 'X.......', { g: .3 });
        } },
        H2: { bpm: 76, meter: 4, bars: 8, build(B) {
          const ch = B.chords(THRONE_CHx);
          B.mel('choirS', THRONE, { tr: 12, map: MIXO, vow: THRONE_V, g: .6 }); B.mel('choirT', THRONE, { map: MIXO, vow: THRONE_V, g: .8 });
          B.mel('horns', THRONE, { map: MIXO, tr: -12, g: .6 }); B.mel('fiddles', VIC_DESC, { g: .55 });
          B.pad('choir', ch, { parts: 'AB', vow: 'a', g: .5, eff: .6 }); B.pad('horns', ch, { parts: 'TB', g: .35 });
          B.arp('harp', ch, ARP.up8, { lo: 38, hi: 76, g: .3 });
          for (const b of [0, 16]) ROUNDS.split(' ').forEach((tk, i) => B.bell('hand', tk.split(':')[0], b + i * .5, .2, (i % 2 ? .4 : -.4)));
          for (const b of [4, 20]) ROUNDS.split(' ').forEach((tk, i) => B.bell('hand', tk.split(':')[0], b + i * .5, .17, (i % 2 ? .4 : -.4)));
          B.drum('taiko', ['X...x...X..x.x..', 'X...x...X..x.xx.'], { g: .65 }); B.drum('cym', 'X', { bars: 1, g: .25 });
          B.swell(28, 4, .25);
        } },
        C: { bpm: 76, meter: 4, bars: 4, build(B) {
          B.pad('choir', B.chords('D:15.5', { at: 0 }), { vow: ['a', 'a', 'o', 'u'], g: .6, eff: .6 });
          B.mel('horns', 'D4:.5^ D4:.5 D4:.5 A4:.5 D5:3', { g: .8 });
          for (let r = 0; r < 3; r++) ROUNDS.split(' ').forEach((tk, i) => B.bell('hand', tk.split(':')[0], r * 4 + i * .5, .2 - r * .04, (i % 2 ? .4 : -.4)));
          B.bell('church', 'D3', 8, .45, 0); B.drum('gong', 'X', { at: 8, bars: 1, g: .3 });
          B.drum('taiko', ['X.x.x.xxX.x.XXXX', '................', 'X...............', '................'], { g: .7 });
          B.arp('harp', B.chords('D:4', { at: 8 }), ARP.roll, { lo: 38, hi: 81, g: .4 });
        } },
      },
    },
    // ── DEATH: a short tragic sting. D Aeolian, a lone falling voice over a low drone.
    death: {
      ir: 'cathedral', wet: .55, send: { lead: .55, pad: .6, perc: .45, low: .3, amb: .3 }, lv: 1.1, once: 1,
      intro: [], loop: ['D'],
      sec: {
        D: { bpm: 60, meter: 4, bars: 6, build(B) {
          B.hold('celli', 'D2', 0, 16, { g: .25, stroke: 8 }); B.hold('basses', 'D2', 0, 16, { g: .16, stroke: 16 });
          B.organ(['D2', 'A2'], 0, 14, .14, { att: 2, rel: 4 });
          B.bell('church', 'D3', 0, .4, -.2); B.bell('church', 'D3', 12, .22, .2);
          B.drum('gong', 'X', { bars: 1, g: .25 });
          B.mel('sop', 'D5:2 C5:1 Bb4:1 | A4:3 G4:1 | F4:1.5 E4:.5 D4:4', { at: 1, vow: ['a', 'a', 'o', 'o', 'o', 'a', 'o', 'u'], g: .9, args: { eff: .45 } });
          B.pad('choir', B.chords('Dm:14', { at: 6 }), { parts: 'TB', vow: ['u', 'o', 'u'], g: .45, eff: .25 });
          B.arp('harp', B.chords('Dm:4', { at: 13 }), ARP.roll, { lo: 38, hi: 62, g: .35 });
        } },
      },
    },
  };
  function nmOf(m) { const N = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']; return N[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1); }
  const IRS = {
    cathedral: { rt: 3.9, len: 4.0, pre: .045, er: [14, .12], damp: .45, lo: 1.25, hi: .5, build: .06, seed: 11 },
    hall: { rt: 2.6, len: 3.8, pre: .025, er: [12, .07], damp: .55, lo: 1.15, hi: .55, build: .03, seed: 12 },
    wood: { rt: 1.0, len: 1.8, pre: .008, er: [18, .035], damp: .45, lo: .9, hi: .5, build: .01, seed: 13 },
    field: { rt: 2.3, len: 3.6, pre: .06, er: [4, .1], damp: .4, lo: .9, hi: .5, build: .05, echo: [.38, .3], seed: 14 },
    forest: { rt: 2.8, len: 4.0, pre: .04, er: [8, .09], damp: .5, lo: 1, hi: .5, build: .04, echo: [.52, .2], seed: 15 },
  };

  // Build one section's events: [{t, k, a, g, p, grp, key}] sorted by time.
  function buildSection(name, key, rep) {
    const S = TRACKS[name].sec[key], B = Builder(S, rep, hs(name + key) + rep * 977);
    S.build(B, rep);
    for (const e of B.ev) { const js = JSON.stringify(e.a); e.key = e.k + ':' + hs(js).toString(36) + ':' + js.length.toString(36); }
    B.ev.sort((a, b) => a.t - b.t);
    return { key, rep, len: B.len, ev: B.ev };
  }

  // ════════ Engine ════════
  const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  const LOOK = 2.5, TICK = 200, TAIL = 6, CAP = 96, CHUNK = 4;
  const HOT = { combat: 1, boss: 1 };
  // Bake rate as a fraction of the context rate: dark pads and drones low, leads and metals higher.
  const SRK = { voice: 0.5, howl: 0.5, amb: 1 / 3, wind: 2 / 3, pluck: 0.4, gurdy: 0.46, organ: 1 / 3, drum: 2 / 3, bell: 0.5 };
  const srkOf = ev => ev.a.srk || (ev.k === 'bow' ? (ev.a.kind === 'cello' || ev.a.kind === 'bass' || ev.a.loop ? 0.46 : 2 / 3) : ev.k === 'horn' ? (ev.a.loop ? 0.4 : 0.46) : SRK[ev.k] || 1);
  const srFor = (ev, ctx, low) => Math.max(8000, Math.round(ctx.sampleRate * srkOf(ev) * (low ? 0.58 : 1) / 100) * 100);
  // Low quality (phones): half the ensemble voices, mono ensembles.
  const adapt = (a, low) => { if (!low || !(a.n > 1)) return a; const b = Object.assign({}, a); b.n = Math.max(1, Math.ceil(a.n / 2)); b.mono = 1; return b; };
  function toBuffer(ctx, res) {
    const b = ctx.createBuffer(res.ch.length, res.ch[0].length, res.sr);
    res.ch.forEach((d, i) => b.copyToChannel(d, i));
    return b;
  }
  function makeEngine(ctx, dest, offline, low) {
    const E = { ctx, offline, low: !!low, MEM: low ? 28e6 : 56e6, cur: null, cache: new Map(), bytes: 0, q: [], pend: new Map(), inflight: 0, live: [],
      stats: { events: 0, missed: 0, capped: 0, baked: 0, bakeMs: 0, evicted: 0, sections: [] } };
    const G = v => { const g = ctx.createGain(); g.gain.value = v == null ? 1 : v; return g; };
    const BQ = (type, f, q, gain) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; if (gain != null) b.gain.value = gain; return b; };
    E.in = G(); E.vol = G(1);
    const hp0 = BQ('highpass', 38, 0.7), hp = BQ('highpass', 38, 0.7), lows = BQ('lowshelf', 80, 0.7, -3), air = BQ('highshelf', 6000, 0.7, 2.5), mud = BQ('peaking', 300, 0.9, -1.5), harsh = BQ('peaking', 4300, 0.9, 0);
    const glue = ctx.createDynamicsCompressor(); glue.threshold.value = -12; glue.knee.value = 10; glue.ratio.value = 1.5; glue.attack.value = 0.03; glue.release.value = 0.35;
    const lim = ctx.createDynamicsCompressor(); lim.threshold.value = -4; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.15;
    E.trim = G(0.6);
    const pre = G(0.5), clip = ctx.createWaveShaper();
    clip.curve = (() => { const n = 4096, a = new Float32Array(n), k = 2.2, t = Math.tanh(k); for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; a[i] = 0.95 * Math.tanh(k * x) / t; } return a; })();
    clip.oversample = '2x';
    E.in.connect(E.vol); E.vol.connect(hp0); hp0.connect(hp); hp.connect(lows); lows.connect(mud); mud.connect(harsh); harsh.connect(air); air.connect(glue); glue.connect(E.trim); E.trim.connect(lim); lim.connect(pre); pre.connect(clip); clip.connect(dest);
    E.irs = {};
    E.irBuf = name => {
      if (!E.irs[name]) { const o = Object.assign({}, IRS[name]); if (E.low) { o.len *= 0.6; o.rt *= 0.75; } E.irs[name] = toBuffer(ctx, D.bake('ir', o, ctx.sampleRate)); E.irBytes = (E.irBytes || 0) + E.irs[name].length * 8; }
      return E.irs[name];
    };
    E.dropIr = name => { const b = E.irs[name]; if (b && !(E.cur && TRACKS[E.cur.name].ir === name) && !(E.nextP && TRACKS[E.nextP.name].ir === name)) { E.irBytes -= b.length * 8; delete E.irs[name]; } };
    E.total = () => E.bytes + (E.irBytes || 0);

    // ── buffer cache + baking (sync offline; Blob worker at runtime, main-thread slices as fallback)
    E.store = (key, buf, keep) => {
      const bytes = buf.length * buf.numberOfChannels * 4;
      E.cache.set(key, { b: buf, bytes, used: E.clock(), keep: !!keep }); E.bytes += bytes;
      const kk = key.split(':')[0]; E.stats.mb = E.stats.mb || {}; E.stats.mb[kk] = +(((E.stats.mb[kk] || 0) + bytes / 1e6).toFixed(2));
      if (E.total() > E.MEM) E.evict(E.MEM * 0.85);
      E.stats.peakMB = Math.max(E.stats.peakMB || 0, +(E.total() / 1e6).toFixed(1));
      const tn = E.cur ? E.cur.name : E.nextP ? E.nextP.name : '-'; E.stats.peakBy = E.stats.peakBy || {};
      E.stats.peakBy[tn] = Math.max(E.stats.peakBy[tn] || 0, +(E.total() / 1e6).toFixed(1));
    };
    // Evict least-recently-used buffers, never one that a queued section of a live player needs.
    E.evict = target => {
      const need = new Set(), now = E.clock();
      for (const P of [E.cur, E.nextP]) if (P && !P.dead && P.secs) for (const sct of P.secs) for (const ev of sct.ev) need.add(ev.key);
      const list = [...E.cache.entries()].filter(([k, v]) => !need.has(k) && now - v.used > 2).sort((a, b) => a[1].used - b[1].used);
      for (const [k, v] of list) { if (E.total() <= target) break; E.cache.delete(k); E.bytes -= v.bytes; E.stats.evicted++; }
    };
    E.clock = () => ctx.currentTime;
    E.get = ev => { const c = E.cache.get(ev.key); if (c) { c.used = E.clock(); return c.b; } return null; };
    E.bakeNow = ev => {
      const t0 = performance.now(), res = D.bake(ev.k, adapt(ev.a, E.low), srFor(ev, ctx, E.low));
      E.stats.bakeMs += performance.now() - t0; E.stats.baked++;
      const b = toBuffer(ctx, res); E.store(ev.key, b); return b;
    };
    if (!offline) {
      let W = null;
      try {
        const src = 'var D=(' + DSP.toString() + ')();onmessage=function(e){var q=e.data,t0=Date.now();try{var r=D.bake(q.k,q.a,q.sr);postMessage({key:q.key,sr:r.sr,ch:r.ch,ms:Date.now()-t0},r.ch.map(function(c){return c.buffer}));}catch(err){postMessage({key:q.key,err:String(err)});}};';
        W = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        W.onmessage = e => {
          const m = e.data, p = E.pend.get(m.key); E.pend.delete(m.key); E.inflight--;
          if (m.err) console.error('[music2] bake', m.err);
          else { E.stats.baked++; E.stats.bakeMs += m.ms; E.store(m.key, toBuffer(ctx, { ch: m.ch, sr: m.sr }), p && p.keep); }
          E.kick();
        };
        W.onerror = e => { console.error('[music2] worker', e.message); W = null; E.inflight = 0; E.kick(); };
      } catch (err) { W = null; }
      E.kick = () => {
        while (E.inflight < 2 && E.q.length) {
          E.q.sort((a, b) => a.prio - b.prio);
          const j = E.q.shift();
          if (E.cache.has(j.ev.key)) { E.pend.delete(j.ev.key); continue; }
          E.inflight++;
          if (W) W.postMessage({ key: j.ev.key, k: j.ev.k, a: adapt(j.ev.a, E.low), sr: srFor(j.ev, ctx, E.low) });
          else setTimeout(() => { try { const b = E.bakeNow(j.ev); if (j.keep) E.cache.get(j.ev.key).keep = true; } catch (err) { console.error('[music2] bake', err); } E.pend.delete(j.ev.key); E.inflight--; E.kick(); }, 12);
        }
      };
      E.want = (ev, prio, keep) => {
        if (E.cache.has(ev.key)) { if (keep) E.cache.get(ev.key).keep = true; return; }
        const p = E.pend.get(ev.key);
        if (p) { p.prio = Math.min(p.prio, prio); p.keep = p.keep || keep; return; }
        const j = { ev, prio, keep }; E.pend.set(ev.key, j); E.q.push(j); E.kick();
      };
    }

    E.play = (P, ev, T, bus) => {
      const buf = E.get(ev) || (offline ? E.bakeNow(ev) : null);
      if (!buf) return false;
      const s = ctx.createBufferSource(), g = ctx.createGain(); s.buffer = buf; g.gain.value = ev.g;
      s.connect(g);
      if (buf.numberOfChannels === 1 && ev.p) { const pn = ctx.createStereoPanner(); pn.pan.value = clamp(ev.p, -1, 1); g.connect(pn); pn.connect(bus); } else g.connect(bus);
      T = Math.max(T, 0);
      let dur = buf.duration;
      const pl = ev.pl;
      if (pl) {   // a looped, envelope-held note
        if (pl.loop) { s.loop = true; s.loopStart = pl.loop[0]; s.loopEnd = pl.loop[1]; }
        const gg = g.gain;
        if (pl.att) { gg.setValueAtTime(0, T); gg.linearRampToValueAtTime(ev.g, T + pl.att); } else gg.setValueAtTime(ev.g, T);
        if (pl.dips) for (const d of pl.dips) { if (d > pl.dur - 0.2) continue; gg.setTargetAtTime(ev.g * 0.62, T + d - 0.07, 0.02); gg.setTargetAtTime(ev.g, T + d + 0.02, 0.06); }
        gg.setTargetAtTime(0, T + pl.dur, pl.rel / 3);
        dur = pl.dur + pl.rel * 2 + 0.05;
        s.start(T, pl.off || 0); s.stop(T + dur);
      } else s.start(T);
      E.stats.events++;
      E.live.push(T + dur);
      return dur;
    };

    // ── a track player: sections chain back to back; each 4 s chunk has its own bus per group
    E.player = (name, fin) => {
      const TR = TRACKS[name], P = { name, dead: false, done: false, started: false, buses: [] };
      P.out = G(0); P.out.connect(E.in);
      P.conv = ctx.createConvolver(); P.conv.normalize = false; if (!E.dry) P.conv.buffer = E.irBuf(TR.ir);
      P.wet = G(E.dry ? 0 : TR.wet); P.conv.connect(P.wet); P.wet.connect(P.out);
      P.grp = {};
      for (const g of ['lead', 'pad', 'perc', 'low', 'amb']) { const gi = G(g === 'low' ? 0.62 : 1), s = G(TR.send[g]); gi.connect(P.out); gi.connect(s); s.connect(P.conv); P.grp[g] = gi; }
      const order = (TR.intro || []).concat(TR.loop), loop0 = (TR.intro || []).length;
      let si = 0, rep = 0;
      P.next = () => {
        if (si >= order.length) return null;
        const s = buildSection(name, order[si], rep);
        if (++si >= order.length && !TR.once) { si = loop0; rep++; }
        return s;
      };
      P.lv = TR.lv || 1;
      return P;
    };
    // Runtime: look-ahead scheduling.
    E.tq = [];
    E.later = (fn, ms) => { if (offline) E.tq.push([ctx.currentTime + Math.max(0, ms) / 1000, fn]); else setTimeout(fn, Math.max(0, ms)); };
    if (offline) E.want = () => { };
    E.music = name => {
      name = TRACKS[name] ? name : null;
      const prev = E.cur ? E.cur.name : null;
      if (prev === name && !(E.cur && E.cur.done)) return;
      if (E.nextP && E.nextP.name === name) return;
      if (E.nextP) { E.kill(E.nextP, 0.05); E.nextP = null; }
      if (!name) { if (E.cur) E.kill(E.cur, 2); E.cur = null; return; }
      const P = E.player(name);
      P.fin = name === 'death' ? 0.05 : HOT[name] ? 0.8 : 2.5;
      P.fout = name === 'death' ? 0.6 : HOT[name] ? 1.0 : HOT[prev] ? 3.0 : 2.5;
      P.secs = [P.next(), P.next()].filter(Boolean);
      P.secs.forEach((s, j) => s.ev.forEach(ev => E.want(ev, j * 100 + ev.t, false)));
      P.asked = Date.now();
      E.nextP = P;
      E.tick();
    };
    E.kill = (P, fade) => {
      if (P.dead) return; P.dead = true;
      const now = ctx.currentTime, gg = P.out.gain;
      gg.cancelScheduledValues(now); gg.setValueAtTime(gg.value, now); gg.linearRampToValueAtTime(0, now + fade);
      E.later(() => { P.buses.forEach(b => { try { b.disconnect(); } catch (e) { } }); P.buses = []; try { P.out.disconnect(); P.conv.disconnect(); } catch (e) { } P.secs = []; E.dropIr(TRACKS[P.name].ir); }, (fade + TAIL) * 1000);
    };
    const ready = (P, secs) => offline || P.secs[0].ev.every(ev => ev.t > secs || E.cache.has(ev.key));
    E.tick = () => {
      const now = ctx.currentTime;
      if (offline && E.tq.length) { const due = E.tq.filter(x => x[0] <= now); E.tq = E.tq.filter(x => x[0] > now); due.forEach(x => x[1]()); }
      // start a pending player once its opening seconds are baked (or after 5 s regardless)
      if (E.nextP && (ready(E.nextP, 6) || Date.now() - E.nextP.asked > 5000)) {
        const P = E.nextP; E.nextP = null;
        if (E.cur) E.kill(E.cur, P.fout);
        E.cur = P; P.started = true; P.st = offline ? now : now + 0.1; P.i = 0; P.open = {}; P.log = [[P.secs[0].key, P.secs[0].rep, +P.st.toFixed(2), +P.secs[0].len.toFixed(2)]];
        if (offline) P.out.gain.value = P.lv;
        else { P.out.gain.setValueAtTime(0, now); P.out.gain.linearRampToValueAtTime(P.lv, now + 0.1 + P.fin); }
      }
      const P = E.cur; if (!P || P.dead || P.done) return;
      const h = now + LOOK;
      for (let guard = 0; guard < 6; guard++) {
        const s = P.secs[0]; if (!s) { P.done = true; return; }
        let stalled = false;
        while (P.i < s.ev.length && P.st + s.ev[P.i].t < h) {
          const ev = s.ev[P.i], T = P.st + ev.t;
          if (E.only && !E.only(ev)) { P.i++; continue; }
          if (!E.cache.has(ev.key) && offline) E.bakeNow(ev);
          if (!E.cache.has(ev.key)) {
            if (T > now + 0.15) { E.want(ev, ev.t, false); stalled = true; break; }
            E.stats.missed++; P.i++; continue;
          }
          P.i++;
          if (T < now - 0.03) { E.stats.missed++; continue; }
          if (E.live.length > CAP * 0.8) E.live = E.live.filter(x => x > now);
          if (E.live.length >= CAP && ev.grp === 'perc') { E.stats.capped++; continue; }
          const ck = Math.floor(ev.t / CHUNK);
          let b = P.open[ck + ev.grp];
          if (!b) { b = P.open[ck + ev.grp] = { bus: G(1), end: 0, ck }; b.bus.connect(P.grp[ev.grp]); P.buses.push(b.bus); }
          const dur = E.play(P, ev, T, b.bus);
          if (dur) b.end = Math.max(b.end, T + dur);
          // close finished chunk buses: events are sorted, so earlier chunks are complete
          for (const k in P.open) { const x = P.open[k]; if (x.ck < ck) { delete P.open[k]; const bus = x.bus; E.later(() => { try { bus.disconnect(); } catch (e) { } P.buses = P.buses.filter(y => y !== bus); }, (x.end + 1 - ctx.currentTime) * 1000); } }
        }
        if (stalled || P.i < s.ev.length) return;
        // section done: close its buses, advance
        for (const k in P.open) { const x = P.open[k], bus = x.bus; E.later(() => { try { bus.disconnect(); } catch (e) { } P.buses = P.buses.filter(y => y !== bus); }, (x.end + 1 - ctx.currentTime) * 1000); }
        P.open = {}; P.st += s.len; P.i = 0; P.secs.shift();
        if (P.secs[0]) P.log.push([P.secs[0].key, P.secs[0].rep, +P.st.toFixed(2), +P.secs[0].len.toFixed(2)]);
        E.stats.sections.push(P.name + ':' + s.key); if (E.stats.sections.length > 16) E.stats.sections.shift();
        const nx = P.next(); if (nx) { P.secs.push(nx); nx.ev.forEach(ev => E.want(ev, 1000 + ev.t, false)); }
        if (!P.secs.length) { P.done = true; return; }
        if (P.st > h) return;
      }
    };
    E.prefetch = (name, n) => {
      const TR = TRACKS[name]; if (!TR) return;
      const order = (TR.intro || []).concat(TR.loop).slice(0, n || 2);
      order.forEach((k, j) => buildSection(name, k, 0).ev.forEach(ev => E.want(ev, 5000 + j * 100 + ev.t, false)));
    };
    E.volume = v => { const now = ctx.currentTime; E.vol.gain.cancelScheduledValues(now); E.vol.gain.setTargetAtTime(clamp(v, 0, 1), now, 0.05); };
    return E;
  }

  // ════════ Public API ════════
  let E = null, pend = null, timer = 0, vol = 1;
  const api = {
    tracks: Object.keys(TRACKS),
    // opts.low: phone tier (half the voices, lower bake rates, 28 MB budget); default from CT.core.quality.
    init(ctx, destination, opts) {
      if (E) return api;
      if (!ctx) { if (!AC) return api; try { ctx = new AC(); } catch (e) { return api; } }
      opts = opts || {};
      const low = opts.low != null ? !!opts.low : !!(CT.core && CT.core.quality === 'low');
      E = makeEngine(ctx, destination || ctx.destination, false, low);
      E.volume(vol);
      timer = setInterval(() => { try { E.tick(); } catch (e) { console.error('[music2.tick]', e); clearInterval(timer); } }, TICK);
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (E) E.tick(); });
      if (pend) E.music(pend);
      // Desktop only: once the current track is fully baked, warm the start of the combat music.
      const warm = {};
      setInterval(() => { try { const c = E.cur; if (!E.low && c && !c.dead && !E.q.length && !E.inflight && !HOT[c.name] && !warm[c.name] && E.clock() - c.st > 8) { warm[c.name] = 1; E.prefetch('combat', 2); } } catch (e) { } }, 3000);
      if (ctx.state !== 'running' && ctx.resume) { try { ctx.resume().catch(() => { }); } catch (e) { } }
      return api;
    },
    setMusic(name) { pend = name || null; if (E) E.music(pend); },
    setVolume(v) { vol = v == null ? 1 : +v; if (E) E.volume(vol); },
    prefetch(name) { if (E) E.prefetch(name, 2); },
    // Offline render of a track (for previews and tests): resolves to an AudioBuffer.
    render(name, seconds, sr, opts) {
      sr = sr || 48000; opts = opts || {};
      const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const ctx = new OAC(2, Math.ceil(seconds * sr), sr), X = makeEngine(ctx, ctx.destination, true, opts.low);
      if (opts.only) X.only = opts.only; if (opts.dry) X.dry = 1;
      const t0 = performance.now(); X.music(name); X.stats.scheduleMs = performance.now() - t0;
      const step = 256 / sr * 64;   // ~0.34 s, a whole number of render quanta
      for (let t = step; t < seconds; t += step) ctx.suspend(t).then(() => { try { X.tick(); } catch (e) { console.error('[music2.render]', e); } ctx.resume(); });
      api._last = X;
      return ctx.startRendering().then(b => { X.plan = X.cur ? X.cur.log : []; return b; });
    },
    _engine: makeEngine, _tracks: TRACKS, _build: buildSection, _dsp: D, _stats() { return E ? { ctx: E.ctx.state, cur: E.cur && E.cur.name, pending: E.nextP && E.nextP.name, mb: +(E.total() / 1e6).toFixed(1), low: E.low, q: E.q.length, live: E.live.length, stats: E.stats } : null; },
  };
  CT.music2 = api;
})();
