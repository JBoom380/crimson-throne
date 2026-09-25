// ─── SKY: time of day, weather, painted dome, storm crown, lights, particles ───
(function () {
  const T = THREE, TAU = Math.PI * 2;
  const DAY_SECONDS = 960;                          // a full day = 16 real minutes
  const CROWN = new T.Vector3(0, 300, -1250);       // the storm crown over the citadel
  const CROWN_MAX = 880, DOME_R = 1000, HAZE_R = 800;
  let scene, camera, low = false;
  let dome, rays, crown, crownBolt, bolt, haze, rain, snow, ash, flies;
  let sunL, hemi, amb, fog;
  const rnd = CT.rng(0xC0FFEE);
  const S = {
    stormW: 0, fogW: 0, bloodW: 0, tgt: { storm: 0, fog: 0, bloodmoon: 0 }, rate: 1,
    flashI: 0, flashDur: 0.2, nextWx: 150, nextBolt: 6, nextCrown: 2, boltI: 0, crownI: 0,
    prevT: -1, written: -1, lastState: '', swamp: 0, forest: 0, north: 0, cit: 0, rainR: 1, night: 0,
  };
  const U = { uTime: { value: 0 } };

  // ── Palette keyframes (time of day) ────────────────────────────────────────
  const CK = ['zen', 'mid', 'hor', 'glow', 'sun', 'cDark', 'cLight', 'rim', 'fog', 'hemiSky', 'hemiGnd', 'dirCol', 'amb'];
  const NK = ['dirI', 'hemiI', 'ambI', 'stars', 'cover', 'tower', 'towerH', 'rays', 'glowAmt', 'lum', 'fogK', 'sunAmt'];
  const KEYS = [
    { t: 0.00, zen: 0x020309, mid: 0x0a1230, hor: 0x1e2c58, glow: 0x3a4c88, sun: 0xffffff, cDark: 0x04060e, cLight: 0x1a2240, rim: 0x4a5a80,
      fog: 0x0a1020, hemiSky: 0x5a6cac, hemiGnd: 0x0c0a0c, dirCol: 0x9ab4ff, amb: 0x1c2444,
      dirI: 1.7, hemiI: 1.25, ambI: 0.55, stars: 1, cover: 0.52, tower: 0.9, towerH: 0.16, rays: 0, glowAmt: 0.35, lum: 0.14, fogK: 1, sunAmt: 0 },
    { t: 0.19, zen: 0x05071a, mid: 0x1a1a40, hor: 0x4a3656, glow: 0x7a4a68, cDark: 0x0c0a18, cLight: 0x302642, rim: 0x7a5a78,
      fog: 0x1c1a2c, hemiSky: 0x50506e, dirCol: 0xa0a0d0, dirI: 0.5, stars: 0.6, lum: 0.2 },
    { t: 0.255, zen: 0x283050, mid: 0x6a6484, hor: 0xe09a98, glow: 0xffc0b0, sun: 0xffe0d0, cDark: 0x3e3450, cLight: 0x9a8698, rim: 0xffd4c8,
      fog: 0x7a6c7c, hemiSky: 0xb0a0b8, hemiGnd: 0x2a2024, dirCol: 0xffb8a8, amb: 0x302838,
      dirI: 1.3, hemiI: 0.9, ambI: 0.35, stars: 0, rays: 0.7, glowAmt: 0.8, lum: 0.55, sunAmt: 1 },
    { t: 0.34, zen: 0x3a5a90, mid: 0x7e92b0, hor: 0xd8c8b0, glow: 0xfff0d0, sun: 0xfff4e0, cDark: 0x686478, cLight: 0xe8dcd0, rim: 0xfff4e0,
      fog: 0xa89e90, hemiSky: 0xd8d0c8, hemiGnd: 0x3a3024, dirCol: 0xfff0dc, amb: 0x3a3440,
      dirI: 2.0, hemiI: 1.2, rays: 0, glowAmt: 0.5, lum: 0.9, towerH: 0.2 },
    { t: 0.50, zen: 0x3a5c98, mid: 0x8aa0b8, hor: 0xe4d0ac, glow: 0xfff0c8, sun: 0xfffaf0, cDark: 0x7a7088, cLight: 0xf8f0e4, rim: 0xffffff,
      fog: 0xc0b094, hemiSky: 0xe8dcc8, hemiGnd: 0x4a3a28, dirCol: 0xfff0d8, amb: 0x403830,
      dirI: 2.4, hemiI: 1.3, ambI: 0.3, cover: 0.47, tower: 1, towerH: 0.24, glowAmt: 0.45, lum: 1 },
    { t: 0.66, zen: 0x344c80, mid: 0x8a88a0, hor: 0xecb480, glow: 0xffd098, sun: 0xfff0c8, cDark: 0x6a5670, cLight: 0xf0ccaa, rim: 0xffe4a8,
      fog: 0xb89470, hemiSky: 0xf0c8a0, dirCol: 0xffd8a0, dirI: 2.2, hemiI: 1.2, glowAmt: 0.6, lum: 0.9, towerH: 0.26 },
    { t: 0.735, zen: 0x1c1242, mid: 0x6e2a58, hor: 0xff7418, glow: 0xffb030, sun: 0xffe070, cDark: 0x3a1640, cLight: 0x943c64, rim: 0xffc848,
      fog: 0x4a2c34, hemiSky: 0xff9860, hemiGnd: 0x2a1010, dirCol: 0xff8a38, amb: 0x3a1a2a,
      dirI: 2.2, hemiI: 1.1, ambI: 0.35, cover: 0.5, tower: 1, towerH: 0.3, rays: 1, glowAmt: 1, lum: 0.7, sunAmt: 1 },
    { t: 0.775, zen: 0x0e0826, mid: 0x3a1236, hor: 0xc82a10, glow: 0xff5010, sun: 0xff8030, cDark: 0x1e0a26, cLight: 0x5e1a3a, rim: 0xff6420,
      fog: 0x261620, hemiSky: 0xa04040, hemiGnd: 0x1a0808, dirCol: 0xff5028, amb: 0x2a1020,
      dirI: 1.1, hemiI: 0.8, rays: 0.7, glowAmt: 1, lum: 0.4, sunAmt: 1, stars: 0.1 },
    { t: 0.82, zen: 0x04051a, mid: 0x121640, hor: 0x3a2850, glow: 0x5a3860, cDark: 0x0a0a1a, cLight: 0x282448, rim: 0x5a5484,
      fog: 0x12122a, hemiSky: 0x50548a, hemiGnd: 0x0c0a0c, dirCol: 0x9aa8e8, amb: 0x1a1a38,
      dirI: 0.9, hemiI: 0.85, ambI: 0.45, rays: 0, glowAmt: 0.5, lum: 0.18, sunAmt: 0, stars: 0.7, towerH: 0.2 },
    { t: 0.90, zen: 0x020309, mid: 0x0a1230, hor: 0x1e2c58, glow: 0x3a4c88, cDark: 0x04060e, cLight: 0x1a2240, rim: 0x4a5a80,
      fog: 0x0a1020, hemiSky: 0x5a6cac, dirCol: 0x9ab4ff, amb: 0x1c2444, dirI: 1.7, hemiI: 1.25, ambI: 0.55, stars: 1, lum: 0.14, glowAmt: 0.35, towerH: 0.16 },
  ];
  // weather and region palettes (partial overrides)
  const STORM = { zen: 0x08081a, mid: 0x201c36, hor: 0x3a3852, glow: 0x5a4c72, cDark: 0x0c0a18, cLight: 0x38345a, rim: 0x4c4470,
    fog: 0x2e2c42, hemiSky: 0x747098, hemiGnd: 0x1a1618, dirCol: 0xa098b8, amb: 0x201c2a };
  const BLOOD = { zen: 0x040102, mid: 0x220406, hor: 0x8a1408, glow: 0xd01c06, cDark: 0x0e0203, cLight: 0x3a0608, rim: 0xd02410,
    fog: 0x3a0806, hemiSky: 0xb02418, hemiGnd: 0x200404, dirCol: 0xff2a14, amb: 0x300606 };
  const FOGC = new T.Color(0x9a948c), SWAMPC = new T.Color(0x48583a), NORTHC = new T.Color(0x8c9cc0), CITC = new T.Color(0x5a1812);
  const MOON_C = new T.Color(0xeee8dc), BMOON_C = new T.Color(0xff2a0c);

  const K = KEYS.map(k => ({ t: k.t }));
  (function fill() {
    const last = {};
    KEYS.forEach((k, i) => {
      CK.concat(NK).forEach(n => { if (k[n] !== undefined) last[n] = k[n]; K[i][n] = CK.includes(n) ? new T.Color(last[n]) : last[n]; });
    });
    const w = { t: 1 }; CK.forEach(n => { w[n] = K[0][n]; }); NK.forEach(n => { w[n] = K[0][n]; }); K.push(w);
  })();
  const toC = o => { const r = {}; for (const n in o) r[n] = new T.Color(o[n]); return r; };
  const STC = toC(STORM), BLC = toC(BLOOD);
  const cur = {}; CK.forEach(n => { cur[n] = new T.Color(); }); NK.forEach(n => { cur[n] = 0; });
  cur.moonCol = new T.Color();
  const tc = new T.Color(), tc2 = new T.Color();
  const sunDir = new T.Vector3(), moonDir = new T.Vector3(), lightDir = new T.Vector3(0, 1, 0), flashDir = new T.Vector3(0, 0.3, -1), flashCol = new T.Color(1, 1, 1);
  const tv = new T.Vector3();
  const SUN_E = new T.Vector3(0.72, 0, 0.69).normalize();     // sunrise side (south-east); it sets in the north-west

  // ── Shared GLSL ────────────────────────────────────────────────────────────
  const NOISE = `
    float h13(vec3 p){ p = fract(p*0.3183099 + 0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
    float vn(vec3 x){ vec3 i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f);
      return mix(mix(mix(h13(i), h13(i+vec3(1,0,0)), f.x), mix(h13(i+vec3(0,1,0)), h13(i+vec3(1,1,0)), f.x), f.y),
                 mix(mix(h13(i+vec3(0,0,1)), h13(i+vec3(1,0,1)), f.x), mix(h13(i+vec3(0,1,1)), h13(i+vec3(1,1,1)), f.x), f.y), f.z); }
    float fbm(vec3 p){ float s = 0.0, a = 0.5; for (int i = 0; i < OCT; i++){ s += a*vn(p); p = p*2.03 + vec3(1.7,9.2,3.1); a *= 0.5; } return s; }
    float bfbm(vec3 p){ float s = 0.0, a = 0.55; for (int i = 0; i < OCT - 1; i++){ float n = vn(p); s += a*(i < 2 ? n : 1.0 - abs(2.0*n - 1.0)); p = p*2.1 + vec3(1.7,9.2,3.1); a *= 0.42; } return s; }
  `;
  const defs = () => ({ OCT: low ? 4 : 5 });

  // ── Sky dome ───────────────────────────────────────────────────────────────
  const DOME_FS = `
    varying vec3 vDir;
    uniform float uTime, uCover, uStars, uSunAmt, uMoonAmt, uMoonSize, uGlowAmt, uTower, uTowerH, uFlash, uFogSky, uStorm;
    uniform vec3 uZen, uMid, uHor, uGlow, uSunCol, uCDark, uCLight, uRim, uFogCol, uSunDir, uMoonDir, uLightDir, uFlashCol, uFlashDir, uMoonCol;
    ${NOISE}
    void main(){
      vec3 dir = normalize(vDir);
      float el = dir.y, elc = max(el, 0.0), az = atan(dir.x, -dir.z);
      vec3 col = mix(uHor, uMid, smoothstep(0.0, 0.3, elc));
      col = mix(col, uZen, smoothstep(0.26, 0.9, elc));
      // glow around the light, smeared along the horizon (the molten band)
      float la = acos(clamp(dot(dir, uLightDir), -1.0, 1.0));
      float laz = atan(uLightDir.x, -uLightDir.z), daz = abs(mod(az - laz + 3.14159, 6.28318) - 3.14159);
      float band = exp(-daz*daz*0.9) * exp(-elc*6.0) * smoothstep(-0.3, 0.02, uLightDir.y);
      float glowM = exp(-la*la*14.0) + exp(-la*la*2.5)*0.3 + band*0.85;
      col = mix(col, uGlow, clamp(glowM*uGlowAmt, 0.0, 1.0));
      // stars
      if (uStars > 0.01) {
        vec3 p = dir*110.0; vec3 i = floor(p), f = fract(p);
        float h = h13(i);
        if (h > 0.86) {
          vec3 c = vec3(h13(i+3.1), h13(i+7.7), h13(i+1.3))*0.5 + 0.25;
          float tw = 0.55 + 0.45*sin(uTime*(1.0 + h*2.0) + h*60.0), big = step(0.985, h);
          col += vec3(0.9, 0.92, 1.1) * smoothstep(0.32 + big*0.2, 0.0, length(f - c)) * tw * (1.4 + big*2.5) * uStars * smoothstep(0.03, 0.25, el);
        }
        col += vec3(0.05, 0.05, 0.09) * uStars * smoothstep(0.55, 0.85, vn(vec3(dir.x*3.0 + dir.y*2.0, dir.z*6.0, 1.0))) * smoothstep(0.1, 0.5, el); // milky haze
      }
      // the moon (huge; crimson under the blood moon)
      float ma = acos(clamp(dot(dir, uMoonDir), -1.0, 1.0));
      if (uMoonAmt > 0.01) {
        vec3 mx = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0))), my = cross(mx, uMoonDir);
        vec2 mp = vec2(dot(dir, mx), dot(dir, my)) / sin(uMoonSize);
        float disk = smoothstep(uMoonSize, uMoonSize*0.93, ma);
        float mar = smoothstep(0.42, 0.62, fbm(vec3(mp*1.4, 7.0))), cr = fbm(vec3(mp*4.0, 2.0));
        float limb = sqrt(max(0.0, 1.0 - dot(mp, mp)));
        vec3 mc = uMoonCol * (0.55 + 0.55*limb) * (1.0 - mar*0.4) * (0.8 + 0.4*cr) * (0.85 + 0.25*clamp(mp.x + mp.y, -1.0, 1.0));
        col += uMoonCol * (exp(-ma*5.0)*0.18 + exp(-ma*14.0)*0.4) * uMoonAmt;
        col = mix(col, mc*1.7, disk*uMoonAmt);
      }
      // the sun
      float sa = acos(clamp(dot(dir, uSunDir), -1.0, 1.0));
      if (uSunAmt > 0.01) {
        col += uSunCol * exp(-sa*22.0) * 0.8 * uSunAmt;
        col = mix(col, uSunCol*2.6, smoothstep(0.042, 0.036, sa) * uSunAmt);
      }
      float cloudA = 0.0;
      float moonClear = uMoonAmt * smoothstep(uMoonSize*2.6, uMoonSize*1.05, ma);
      // upper cloud sheet (two drifting layers)
      if (uCover < 0.99) {
        vec2 uv = dir.xz / (elc + 0.16);
        for (int i = 0; i < 2; i++) {
          float fi = float(i), cov = uCover + fi*0.04, tt = uTime*0.012 + fi*3.1;
          vec2 q = uv*(0.9 - fi*0.3) + vec2(uTime*(0.006 + fi*0.004), uTime*0.002) + fi*17.3;
          vec2 w = vec2(vn(vec3(q*0.6, tt)), vn(vec3(q*0.6 + 5.7, tt))) - 0.5; q += w*0.6;
          float d = bfbm(vec3(q, tt*1.5)), dl = bfbm(vec3(q + normalize(uLightDir.xz + 1e-4)*0.3, tt*1.5));
          float a = smoothstep(cov, cov + 0.03, d) * smoothstep(0.0, 0.08, el);
          a *= 1.0 - 0.8*moonClear;
          float thick = smoothstep(cov, cov + 0.22, d), lit = clamp((d - dl)*10.0 + 0.2, 0.0, 1.0);
          float edge = 1.0 - smoothstep(cov, cov + 0.09, d);
          float prox = exp(-la*la*3.0);
          vec3 body = mix(uCDark, uCLight, clamp(lit*0.85 + (1.0 - thick)*0.3, 0.0, 1.0));
          body = mix(body, uHor, (1.0 - smoothstep(0.0, 0.3, elc))*0.4);
          vec3 rim = uRim * (prox*(edge*1.1 + lit*0.35) + edge*lit*0.06);
          col = mix(col, body + rim, a); cloudA = max(cloudA, a);
        }
      }
      // towering cumulus heaped along the horizon (Frazetta thunderheads)
      if (uTower > 0.01) {
        vec2 cz = vec2(sin(az), cos(az));
        float prof = fbm(vec3(cz*1.7, 1.3 + uTime*0.003));
        float H = uTowerH * (0.15 + 3.2*pow(prof, 3.0)) + uStorm*0.18;
        vec3 bp = vec3(cz*9.0, el*14.0) + vec3(uTime*0.02, 0.0, -uTime*0.01);
        float bil = bfbm(bp);
        float d = H + (bil - 0.5)*0.16 - el;
        vec3 toL = uLightDir - dir*dot(uLightDir, dir); toL /= max(length(toL), 1e-4);
        float bil2 = bfbm(bp + vec3(toL.x, toL.z, toL.y*1.6)*0.7);
        float d2 = H + (bil2 - 0.5)*0.16 - (el + toL.y*0.03);
        float a = smoothstep(0.0, 0.012, d) * uTower * smoothstep(-0.02, 0.01, el);
        a *= 1.0 - 0.6*moonClear;
        float lit = clamp((d - d2)*9.0 + 0.4, 0.0, 1.0);
        float edge = 1.0 - smoothstep(0.0, 0.06, d);
        float prox = exp(-la*la*2.2);
        float depth = smoothstep(0.0, 0.25, d);
        vec3 body = mix(uCDark, uCLight, clamp(lit*0.75 + (1.0 - depth)*0.25, 0.0, 1.0));
        body = mix(body, uHor*0.8, (1.0 - smoothstep(0.0, max(H, 0.05), el))*0.45);
        vec3 rim = uRim * (prox*(edge*1.5 + lit*lit*0.6) + edge*lit*0.1);
        col = mix(col, body + rim, a); cloudA = max(cloudA, a);
      }
      // lightning: sky flash, brightest in the clouds towards the strike
      float fl = uFlash * (0.25 + 0.75*pow(max(dot(dir, uFlashDir), 0.0), 5.0)) * (0.35 + cloudA);
      col += uFlashCol * fl;
      col = mix(col, uFogCol, uFogSky * (1.0 - smoothstep(0.0, 0.6, elc)*0.7));
      col = mix(col, uFogCol, smoothstep(0.07, -0.015, el));
      gl_FragColor = vec4(col, 1.0);
    }`;

  function buildDome() {
    Object.assign(U, {
      uFlash: { value: 0 }, uFlashDir: { value: flashDir }, uFlashCol: { value: flashCol },
      uCover: { value: 0.5 }, uStars: { value: 0 }, uSunAmt: { value: 0 }, uMoonAmt: { value: 0 }, uMoonSize: { value: 0.075 },
      uGlowAmt: { value: 1 }, uTower: { value: 1 }, uTowerH: { value: 0.2 }, uFogSky: { value: 0 }, uStorm: { value: 0 },
      uZen: { value: cur.zen }, uMid: { value: cur.mid }, uHor: { value: cur.hor }, uGlow: { value: cur.glow }, uSunCol: { value: cur.sun },
      uCDark: { value: cur.cDark }, uCLight: { value: cur.cLight }, uRim: { value: cur.rim }, uFogCol: { value: cur.fog },
      uSunDir: { value: sunDir }, uMoonDir: { value: moonDir }, uLightDir: { value: lightDir }, uMoonCol: { value: cur.moonCol },
    });
    dome = new T.Mesh(new T.SphereGeometry(DOME_R, 40, 20), new T.ShaderMaterial({
      uniforms: U, defines: defs(), side: T.BackSide, depthWrite: false, depthTest: false, fog: false,
      vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: DOME_FS,
    }));
    dome.renderOrder = -100; dome.frustumCulled = false;
    scene.add(dome);
  }

  // ── God rays: a sun-shaft billboard at dawn and dusk ───────────────────────
  function buildRays() {
    rays = new T.Mesh(new T.PlaneGeometry(1, 1), new T.ShaderMaterial({
      uniforms: { uTime: U.uTime, uAmt: { value: 0 }, uCol: { value: cur.glow } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv - 0.5; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform float uTime, uAmt; uniform vec3 uCol; varying vec2 vUv;
        float h(float n){ return fract(sin(n)*43758.5453); }
        float n1(float x){ float i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f); return mix(h(i), h(i+1.0), f); }
        void main(){
          float r = length(vUv)*2.0, a = atan(vUv.y, vUv.x);
          float s = n1(a*9.0 + uTime*0.05) * 0.6 + n1(a*23.0 - uTime*0.08) * 0.4;
          s = smoothstep(0.55, 0.9, s);
          float fall = (1.0 - smoothstep(0.02, 1.0, r)) * smoothstep(0.0, 0.08, r);
          float core0 = exp(-r*r*40.0) * 0.6;
          float down = 0.6 + 0.4*smoothstep(0.3, -0.3, vUv.y);         // shafts rake down to the ground
          gl_FragColor = vec4(uCol * (s*fall*down*0.55 + core0) * uAmt, 1.0);
        }`,
      transparent: true, blending: T.AdditiveBlending, depthWrite: false, depthTest: false, fog: false,
    }));
    rays.renderOrder = 50; rays.visible = false;
    scene.add(rays);
  }

  // ── Storm crown: a crimson vortex over the citadel mountain ────────────────
  function buildCrown() {
    // one mesh: a billowing cap (kind 0) + a twisting funnel down to the mountain (kind 1)
    const cap = new T.SphereGeometry(1, 64, 18, 0, TAU, 0, Math.PI * 0.5).toNonIndexed();
    const fun = new T.CylinderGeometry(0.3, 0.05, 1.5, 36, 10, true).toNonIndexed(); fun.translate(0, -0.75, 0);
    const P = [], N = [], K = [];
    [[cap, 0], [fun, 1]].forEach(([g, k]) => {
      const gp = g.attributes.position.array, gn = g.attributes.normal.array;
      for (let i = 0; i < gp.length; i++) { P.push(gp[i]); N.push(gn[i]); }
      for (let i = 0; i < gp.length / 3; i++) K.push(k);
      g.dispose();
    });
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new T.Float32BufferAttribute(N, 3));
    g.setAttribute('aK', new T.Float32BufferAttribute(K, 1));
    const mesh = new T.Mesh(g, new T.ShaderMaterial({
      uniforms: { uTime: U.uTime, uFlash: { value: 0 }, uHaze: { value: 0 }, uHor: { value: cur.fog }, uRim: { value: cur.rim }, uLum: { value: 1 } },
      defines: defs(),
      vertexShader: `
        uniform float uTime; attribute float aK; varying vec3 vL; varying vec3 vN; varying vec3 vV; varying float vB; varying float vK;
        ${NOISE}
        void main(){
          vL = position; vK = aK; vec3 p = position;
          float r = length(p.xz);
          if (aK < 0.5) {
            float sw = atan(p.z, p.x) + uTime*0.05 + (1.0 - r)*2.5;
            vec2 q = vec2(cos(sw), sin(sw))*r;
            float b = vn(vec3(q*3.0, p.y*2.5 + uTime*0.02)) + 0.5*vn(vec3(q*7.0, p.y*5.0 - uTime*0.03)) + 0.25*vn(vec3(q*15.0, p.y*9.0));
            vB = b;
            p += normal * (b - 0.6) * 0.4 * smoothstep(0.0, 0.3, p.y + 0.05);  // billowing heaps
            p.y -= (1.0 - r)*(1.0 - r)*0.22;                                   // the vortex sags into the funnel
          } else {
            vB = 0.8;
            p.x += sin(p.y*4.0 + uTime*0.7)*0.05*(-p.y); p.z += cos(p.y*3.0 + uTime*0.5)*0.04*(-p.y);
            p.y -= 0.12;
          }
          vec4 wp = modelMatrix * vec4(p, 1.0);
          vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - wp.xyz);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: `
        uniform float uTime, uFlash, uHaze, uLum; uniform vec3 uHor, uRim; varying vec3 vL; varying vec3 vN; varying vec3 vV; varying float vB; varying float vK;
        ${NOISE}
        void main(){
          float r = length(vL.xz), ang = atan(vL.z, vL.x), face = abs(dot(vN, vV));
          float inner = gl_FrontFacing ? 0.0 : 1.0;
          vec3 c; float a;
          if (vK < 0.5) {
            float sw = ang + uTime*0.06 + (1.0 - r)*5.0 + uTime*0.12*(1.0 - r);
            vec2 q = vec2(cos(sw), sin(sw))*r;
            float d = fbm(vec3(q*2.4, vL.y*2.2 + uTime*0.025));
            a = smoothstep(0.26, 0.56, d + face*0.3 + vB*0.15 - smoothstep(0.75, 1.0, r)*0.4) * smoothstep(0.0, 0.2, vL.y + (d - 0.45)*0.6 + (1.0 - r)*0.4);
            float eye = exp(-r*r*260.0), ring = exp(-pow((r - 0.1)*14.0, 2.0));
            float under = pow(1.0 - vL.y, 2.5);
            c = mix(vec3(0.01, 0.002, 0.004), vec3(0.055, 0.009, 0.014), smoothstep(0.35, 0.8, d));
            c += vec3(0.25, 0.02, 0.008) * smoothstep(0.3, 0.0, vL.y) * smoothstep(0.45, 0.8, d) * (1.0 - inner) * (1.0 - 0.6*uLum);   // hellfire under the rim
            c += vec3(0.4, 0.03, 0.01) * inner * under * smoothstep(0.55, 0.85, d) * (0.5 + 0.5*sin(sw*2.0 + d*6.0)) * (1.0 - ring*0.7);
            c += vec3(1.0, 0.05, 0.02) * eye * 1.6 * inner;                                                              // the burning eye
            c += uRim * smoothstep(0.35, 0.95, vL.y) * smoothstep(0.55, 0.85, d) * 0.05 * uLum;                          // sky light on the heaps
            c += vec3(1.1, 0.28, 0.36) * uFlash * smoothstep(0.3, 0.75, d);
          } else {
            float y = -vL.y / 1.5;                                                                                       // 0 top .. 1 bottom
            float d = fbm(vec3(ang*2.0 + uTime*0.5 + y*3.0, y*5.0 - uTime*0.3, 4.0));
            a = smoothstep(0.32, 0.55, d + face*0.35) * smoothstep(1.0, 0.5, y) * smoothstep(0.02, 0.3, face) * 0.92;
            c = mix(vec3(0.008, 0.002, 0.004), vec3(0.035, 0.006, 0.009), d) + vec3(0.3, 0.02, 0.008) * smoothstep(0.6, 0.85, d) * y * 0.5;
            c += vec3(1.1, 0.28, 0.36) * uFlash * d;
          }
          c = mix(c, uHor * 0.25 + vec3(0.03, 0.0, 0.0), uHaze * (1.0 - uFlash*0.6));
          gl_FragColor = vec4(c, a);
        }`,
      transparent: true, depthWrite: false, side: T.DoubleSide, fog: false,
    }));
    mesh.scale.set(420, 300, 420); mesh.position.y = -40;
    crown = new T.Group(); crown.add(mesh); crown.userData.mat = mesh.material;
    crown.renderOrder = 5; mesh.renderOrder = 5; mesh.frustumCulled = false;
    scene.add(crown);
  }

  // ── Lightning bolts (line segments rebuilt only on a strike) ───────────────
  const BOLT_SEG = 64;
  function boltMesh(col) {
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(new Float32Array(BOLT_SEG * 6), 3));
    g.setAttribute('aW', new T.BufferAttribute(new Float32Array(BOLT_SEG * 2), 1));
    g.setDrawRange(0, 0);
    const m = new T.LineSegments(g, new T.ShaderMaterial({
      uniforms: { uI: { value: 0 }, uCol: { value: new T.Color(col) } },
      vertexShader: 'attribute float aW; varying float vW; void main(){ vW = aW; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform float uI; uniform vec3 uCol; varying float vW; void main(){ gl_FragColor = vec4(uCol * 7.0 * uI * vW, 1.0); }',
      transparent: true, blending: T.AdditiveBlending, depthWrite: false, fog: false,
    }));
    m.frustumCulled = false; m.renderOrder = 6;
    return m;
  }
  // ox/oz: a sideways offset about one pixel wide, so the trunk is drawn twice (a thicker bolt)
  function strikeBolt(m, x0, y0, z0, x1, y1, z1, ox, oz) {
    const P = m.geometry.attributes.position, W = m.geometry.attributes.aW, a = P.array, w = W.array;
    let n = 0;
    const put = (ax, ay, az, bx, by, bz, wt) => {
      if (n >= BOLT_SEG) return;
      const o = n * 6; a[o] = ax; a[o + 1] = ay; a[o + 2] = az; a[o + 3] = bx; a[o + 4] = by; a[o + 5] = bz; w[n * 2] = wt; w[n * 2 + 1] = wt; n++;
    };
    const seg = (ax, ay, az, bx, by, bz, wt) => {
      put(ax, ay, az, bx, by, bz, wt);
      if (wt > 0.9) put(ax + ox, ay, az + oz, bx + ox, by, bz + oz, 0.8);
    };
    const L = Math.hypot(x1 - x0, y1 - y0, z1 - z0), jit = L * 0.07, N = 14;
    let px = x0, py = y0, pz = z0;
    for (let i = 1; i <= N; i++) {
      const f = i / N;
      const nx = x0 + (x1 - x0) * f + (i < N ? (rnd() - 0.5) * jit : 0), ny = y0 + (y1 - y0) * f + (i < N ? (rnd() - 0.5) * jit * 0.3 : 0), nz = z0 + (z1 - z0) * f + (i < N ? (rnd() - 0.5) * jit : 0);
      seg(px, py, pz, nx, ny, nz, 1);
      if (i > 2 && i < N - 2 && rnd() < 0.4) {                // forked branches
        let bx = nx, by = ny, bz = nz; const dx = (rnd() - 0.5) * jit * 1.6, dz = (rnd() - 0.5) * jit * 1.6;
        for (let k = 0; k < 4; k++) {
          const cx = bx + dx * (0.6 + rnd() * 0.6), cy = by - L / N * (0.7 + rnd() * 0.5), cz = bz + dz * (0.6 + rnd() * 0.6);
          seg(bx, by, bz, cx, cy, cz, 0.5 - k * 0.1); bx = cx; by = cy; bz = cz;
        }
      }
      px = nx; py = ny; pz = nz;
    }
    P.needsUpdate = true; W.needsUpdate = true; m.geometry.setDrawRange(0, n * 2);
  }

  // ── Horizon sea haze: drifting mist banks on a ring far out ────────────────
  function buildHaze() {
    const g = new T.CylinderGeometry(HAZE_R, HAZE_R, 170, 64, 1, true);
    g.translate(0, 55, 0);
    haze = new T.Mesh(g, new T.ShaderMaterial({
      uniforms: { uTime: U.uTime, uCol: { value: cur.fog }, uAmt: { value: 1 } },
      defines: defs(),
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform float uTime, uAmt; uniform vec3 uCol; varying vec2 vUv;
        ${NOISE}
        void main(){
          float x = vUv.x*6.28318;
          float n = fbm(vec3(cos(x)*4.0 + uTime*0.01, sin(x)*4.0, vUv.y*2.5));
          float prof = 1.0 - smoothstep(0.0, 0.9, vUv.y);
          float a = clamp(prof*prof*1.1 + (n - 0.5)*prof*0.9, 0.0, 1.0);
          gl_FragColor = vec4(uCol*(0.92 + 0.16*n), a*uAmt);
        }`,
      transparent: true, depthWrite: false, side: T.BackSide, fog: false,
    }));
    haze.renderOrder = 2; haze.frustumCulled = false;
    scene.add(haze);
  }

  // ── Particles around the camera (wrapped in the shader, no CPU updates) ────
  const PART_VS = `
    attribute vec4 aR; uniform vec3 uCam, uBox; uniform float uTime, uAmt, uSize; varying vec4 vR; varying float vI; varying float vS;
    void main(){
      vec3 p = position; float ph = aR.x*6.2832;
      MOVE
      vec3 w = uCam + mod(p - uCam + uBox*0.5, uBox) - uBox*0.5;
      vec4 mv = modelViewMatrix * vec4(w, 1.0); float dist = -mv.z;
      vI = step(aR.y, uAmt) * smoothstep(uBox.x*0.5, uBox.x*0.25, dist) * smoothstep(0.3, 1.5, dist);
      vR = aR; gl_Position = projectionMatrix * mv;
      vS = SIZE; gl_PointSize = vI > 0.01 ? vS : 0.0;
    }`;
  function particles(count, box, move, size, frag, blend) {
    const p = new Float32Array(count * 3), r = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      p[i * 3] = rnd() * box[0]; p[i * 3 + 1] = rnd() * box[1]; p[i * 3 + 2] = rnd() * box[2];
      r[i * 4] = rnd(); r[i * 4 + 1] = rnd(); r[i * 4 + 2] = rnd(); r[i * 4 + 3] = rnd();
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(p, 3));
    g.setAttribute('aR', new T.BufferAttribute(r, 4));
    const pts = new T.Points(g, new T.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uCam: { value: new T.Vector3() }, uBox: { value: new T.Vector3().fromArray(box) }, uAmt: { value: 0 },
        uSize: { value: 1 }, uCol: { value: new T.Color() }, uWind: { value: new T.Vector2() } },
      vertexShader: 'uniform vec2 uWind;\n' + PART_VS.replace('MOVE', move).replace('SIZE', size),
      fragmentShader: frag, transparent: true, depthWrite: false, fog: false, blending: blend || T.NormalBlending,
    }));
    pts.frustumCulled = false; pts.visible = false; pts.renderOrder = 8;
    scene.add(pts);
    return pts;
  }
  function buildParticles() {
    const q = low ? 0.4 : 1;
    rain = particles(Math.round(4200 * q), [70, 44, 70],
      'p.y -= uTime*(22.0 + aR.z*8.0); p.xz += uWind*uTime*(1.0 + aR.z*0.3);',
      'clamp(uSize*70.0/dist, 2.0, 12.0)',
      `uniform vec3 uCol; uniform vec2 uWind; varying vec4 vR; varying float vI; varying float vS;
       void main(){ vec2 c = gl_PointCoord - 0.5; float xo = -c.y*uWind.x*0.035;
         float line = step(abs(c.x - xo), max(0.5/vS, 0.06));
         if (line < 0.5) discard; gl_FragColor = vec4(uCol*(0.8 + 0.4*vR.w), vI*0.55); }`);
    snow = particles(Math.round(2600 * q), [60, 36, 60],
      'p.y -= uTime*(1.2 + aR.z*1.1); p.x += sin(uTime*0.9 + ph)*1.2 + uWind.x*uTime*0.25; p.z += cos(uTime*0.7 + ph*1.3)*1.2 + uWind.y*uTime*0.25;',
      'clamp(uSize*(1.0 + aR.w)*20.0/dist, 1.5, 4.0)',
      `uniform vec3 uCol; varying vec4 vR; varying float vI; varying float vS;
       void main(){ gl_FragColor = vec4(uCol*(0.85 + 0.3*vR.w), vI*0.95); }`);
    ash = particles(Math.round(1800 * q), [70, 40, 70],
      `if (aR.z < 0.3) { p.y += uTime*(1.5 + aR.w*2.5); p.x += sin(uTime*1.3 + ph)*1.5; p.z += cos(uTime*1.1 + ph)*1.5; }
       else { p.y -= uTime*(0.8 + aR.w*0.9); p.x += sin(uTime*0.6 + ph)*2.0 + uWind.x*uTime*0.4; p.z += cos(uTime*0.5 + ph)*2.0; }`,
      'clamp(uSize*(1.0 + aR.w)*12.0/dist, 1.0, 3.5)',
      `uniform vec3 uCol; uniform float uTime; varying vec4 vR; varying float vI; varying float vS;
       void main(){
         if (vR.z < 0.3) gl_FragColor = vec4(vec3(2.6, 0.7, 0.12)*(0.6 + 0.4*sin(uTime*7.0 + vR.x*40.0)), vI);
         else gl_FragColor = vec4(uCol*(0.6 + 0.5*vR.w), vI*0.85); }`);
    flies = particles(Math.round(180 * q), [44, 5, 44],
      'p += vec3(sin(uTime*0.5*(0.5 + aR.z) + ph)*1.8, sin(uTime*0.8*(0.5 + aR.z) + ph*1.7)*0.6, cos(uTime*0.45*(0.5 + aR.z) + ph*0.7)*1.8); p.y += uCam.y - 1.6 - uBox.y*0.5 + 0.3;',
      'clamp(uSize*18.0/dist, 1.0, 3.0)',
      `uniform float uTime; varying vec4 vR; varying float vI;
       void main(){ float b = smoothstep(0.2, 0.9, sin(uTime*(1.2 + vR.z*2.0) + vR.x*30.0)*0.5 + 0.5);
         if (b < 0.02) discard; gl_FragColor = vec4(vec3(1.6, 2.2, 0.5)*b, vI*b); }`, T.AdditiveBlending);
    // fireflies wrap in XZ only; keep them near the ground around the camera
    flies.material.vertexShader = flies.material.vertexShader.replace('vec3 w = uCam + mod(p - uCam + uBox*0.5, uBox) - uBox*0.5;',
      'vec3 w = vec3(uCam.x + mod(p.x - uCam.x + uBox.x*0.5, uBox.x) - uBox.x*0.5, p.y, uCam.z + mod(p.z - uCam.z + uBox.z*0.5, uBox.z) - uBox.z*0.5);');
  }

  // ── Lights + fog ───────────────────────────────────────────────────────────
  function buildLights() {
    sunL = new T.DirectionalLight(0xffffff, 1); sunL.castShadow = false;
    hemi = new T.HemisphereLight(0xffffff, 0x202020, 1);
    amb = new T.AmbientLight(0x202020, 0.3);
    scene.add(sunL, sunL.target, hemi, amb);
    fog = new T.FogExp2(0x000000, 0.005);
    scene.fog = fog;
    scene.background = new T.Color(0x000000);
  }

  // ── Sampling the palette ───────────────────────────────────────────────────
  const smooth = f => f * f * (3 - 2 * f);
  function samplePalette(t) {
    let i = 0; while (i < K.length - 2 && t >= K[i + 1].t) i++;
    const a = K[i], b = K[i + 1], f = smooth(Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))));
    for (let j = 0; j < CK.length; j++) { const n = CK[j]; cur[n].copy(a[n]).lerp(b[n], f); }
    for (let j = 0; j < NK.length; j++) { const n = NK[j]; cur[n] = a[n] + (b[n] - a[n]) * f; }
  }
  function mixSet(set, w, scale) {
    if (w <= 0.001) return;
    for (const n in set) { tc.copy(set[n]).multiplyScalar(scale); cur[n].lerp(tc, w); }
  }

  // ── Celestial positions ────────────────────────────────────────────────────
  function celestial(t) {
    const a = (t - 0.25) * TAU;                       // 0 at sunrise, PI/2 at noon, PI at sunset
    const c = Math.cos(a), s = Math.sin(a);
    sunDir.set(SUN_E.x * c, s * 0.92, SUN_E.z * c - 0.28 * Math.max(0, s)).normalize();
    const m = (t + 0.5) % 1;                          // 0.5 at midnight: the moon rides high over the north
    const b = (m - 0.5) * TAU * 0.95;
    moonDir.set(-Math.sin(b) * 0.95, Math.cos(b) * 0.5 - 0.04, -0.85).normalize();
  }

  // ── Region weights (biome from the world when present, else by coordinates) ──
  function regions(x, z, dt) {
    let sw = 0, fo = 0;
    const b = CT.world && typeof CT.world.biomeAt === 'function' && !(CT._broken && CT._broken.world) ? CT.world.biomeAt(x, z) : null;
    if (b) { sw = b === 'swamp' ? 1 : 0; fo = b === 'forest' ? 1 : 0; }
    else { sw = smooth(Math.min(1, Math.max(0, (x - 480) / 160))) * (z > -600 && z < 700 ? 1 : 0); fo = x < -400 && z > -600 ? 1 : 0; }
    const k = Math.min(1, dt * 0.4);
    S.swamp += (sw - S.swamp) * k; S.forest += (fo - S.forest) * k;
    S.north = smooth(Math.min(1, Math.max(0, (-z - 560) / 120)));
    S.cit = smooth(Math.min(1, Math.max(0, (-z - 960) / 140)));
  }

  // ── Weather ────────────────────────────────────────────────────────────────
  function setWeather(name, seconds) {
    if (!(name in S.tgt) && name !== 'clear') return;
    API.weather = name;
    S.tgt.storm = name === 'storm' ? 1 : 0; S.tgt.fog = name === 'fog' ? 1 : 0; S.tgt.bloodmoon = name === 'bloodmoon' ? 1 : 0;
    S.rate = seconds > 0 ? 1 / seconds : 0;
    if (!(seconds > 0)) { S.stormW = S.tgt.storm; S.fogW = S.tgt.fog; S.bloodW = S.tgt.bloodmoon; }
    if (name === 'storm') S.nextBolt = Math.min(S.nextBolt, 3);
  }
  function flash(color, seconds) {
    flashCol.set(color === undefined ? 0xd8d0ff : color);
    S.flashDur = Math.max(0.05, seconds || 0.25); S.flashI = 1;
    flashDir.copy(camera ? tv.set(0, 0, -1).applyQuaternion(camera.quaternion) : tv.set(0, 0, -1)); flashDir.y = Math.max(flashDir.y, 0.25); flashDir.normalize();
  }
  function autoWeather(dt, t) {
    // blood moon: rolled each dusk, lasts the night
    const nat = S.prevT >= 0 && Math.abs(t - S.prevT) < 0.02;
    if (nat && S.prevT < 0.79 && t >= 0.79 && rnd() < 0.25) {
      setWeather('bloodmoon', 25);
      CT.bus.emit('notify', { text: 'The Blood Moon rises...', kind: 'omen' });
    }
    if (API.weather === 'bloodmoon' && ((nat && S.prevT < 0.21 && t >= 0.21) || (t > 0.3 && t < 0.7))) setWeather('clear', 40);
    S.nextWx -= dt;
    if (S.nextWx <= 0 && API.weather !== 'bloodmoon') {
      const r = rnd(), fogP = 0.15 + S.swamp * 0.45;
      const w = r < fogP ? 'fog' : r < fogP + 0.25 ? 'storm' : 'clear';
      setWeather(w, 30);
      S.nextWx = w === 'clear' ? 180 + rnd() * 240 : 90 + rnd() * 150;
    }
  }
  function lightning(dt) {
    const cam = camera.position;
    S.boltI = Math.max(0, S.boltI - dt * 5);
    if (S.stormW > 0.4) {
      S.nextBolt -= dt;
      if (S.nextBolt <= 0) {
        S.nextBolt = 3 + rnd() * 9 / S.stormW;
        const ang = S._ang !== undefined ? S._ang : rnd() * TAU, d = S._d || 140 + rnd() * 360; S._ang = undefined; S._d = 0; const x = cam.x + Math.sin(ang) * d, z = cam.z - Math.cos(ang) * d;
        const gy = CT.world && typeof CT.world.heightAt === 'function' ? CT.world.heightAt(x, z) : 0;
        strikeBolt(bolt, x + (rnd() - 0.5) * 60, gy + 260, z + (rnd() - 0.5) * 60, x, gy, z, Math.cos(ang) * d * 0.004, Math.sin(ang) * d * 0.004);
        S.boltI = 1.4;
        flash(0xd8d0ff, 0.35); S.flashI = 1.4 - d / 600;
        flashDir.set(x - cam.x, 120, z - cam.z).normalize();
        thunder(d);
      }
    }
    bolt.material.uniforms.uI.value = S.boltI > 1 ? 1 : S.boltI * (0.6 + 0.4 * Math.sin(S.boltI * 40));
    // the storm crown strikes the citadel mountain all the time
    S.crownI = Math.max(0, S.crownI - dt * 4);
    S.nextCrown -= dt;
    if (S.nextCrown <= 0) {
      S.nextCrown = 1.2 + rnd() * 4.5;
      const ra = rnd() * TAU, rr = rnd() * 120;
      strikeBolt(crownBolt, Math.cos(ra) * rr, -10, Math.sin(ra) * rr, Math.cos(ra) * rr * 1.6 + (rnd() - 0.5) * 80, -240, Math.sin(ra) * rr * 1.6 + (rnd() - 0.5) * 80, 4, 4);
      S.crownI = 1.3;
      const d = tv.copy(CROWN).sub(cam).length();
      if (d < 700) { flash(0xff9a8a, 0.3); S.flashI = (1.1 - d / 700) * 0.6; flashDir.copy(CROWN).sub(cam).normalize(); thunder(d); }
    }
    const ci = S.crownI > 1 ? 1 : S.crownI * (0.6 + 0.4 * Math.sin(S.crownI * 37));
    crownBolt.material.uniforms.uI.value = ci;
    crown.userData.mat.uniforms.uFlash.value = ci * 0.8;
  }
  function thunder(d) {
    if (!(CT.audio && typeof CT.audio.sfx === 'function')) return;
    setTimeout(() => { try { CT.audio.sfx('thunder', { volume: Math.max(0.2, 1 - d / 900), dist: d }); } catch (e) {} }, Math.min(3000, d / 340 * 1000));
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  function init(c) {
    scene = c.scene; camera = c.camera; low = c.quality === 'low';
    buildLights(); buildDome(); buildRays(); buildHaze(); buildCrown(); buildParticles();
    bolt = boltMesh(0xd8d0ff); scene.add(bolt);
    crownBolt = boltMesh(0xff8a7a); crown.add(crownBolt);
    API.timeOfDay = 0.745; S.written = API.timeOfDay;
    update(0, c);
  }

  // ── Update ─────────────────────────────────────────────────────────────────
  function update(dt, c) {
    if (!dome) return;
    const cam = camera.position;
    // time of day advances during play (dt is real time; hit-stop does not freeze the sun)
    const external = API.timeOfDay !== S.written;          // set from outside (debug): no event triggers
    if (external) S.prevT = -1;
    // a new journey starts in the late afternoon, an hour of gold before the first dusk
    if (!external && c.state === 'PLAY' && (S.lastState === 'TITLE' || S.lastState === 'GATE')) { API.timeOfDay = 0.66; setWeather('clear', 0); }
    S.lastState = c.state;
    if (c.state === 'PLAY' || c.state === 'DEAD') API.timeOfDay = (API.timeOfDay + dt / DAY_SECONDS) % 1;
    if (API.timeOfDay < 0) API.timeOfDay += 1;
    const t = API.timeOfDay; S.written = t;
    if (c.state === 'PLAY') autoWeather(dt, t);
    S.prevT = t;
    U.uTime.value = c.time % 3000;

    // weather tweens
    const step = S.rate > 0 ? dt * S.rate : 1;
    S.stormW += Math.max(-step, Math.min(step, S.tgt.storm - S.stormW));
    S.fogW += Math.max(-step, Math.min(step, S.tgt.fog - S.fogW));
    S.bloodW += Math.max(-step, Math.min(step, S.tgt.bloodmoon - S.bloodW));
    regions(cam.x, cam.z, dt || 0.016);
    const storm = Math.min(1, S.stormW + S.cit * 0.35), fogW = S.fogW, blood = S.bloodW;

    // palette: time of day, then weather and region overlays
    celestial(t);
    samplePalette(t);
    const dayK = 0.25 + cur.lum * 0.75;
    S.night = 1 - smooth(Math.min(1, Math.max(0, (sunDir.y + 0.12) / 0.2)));
    mixSet(STC, storm * 0.9, dayK);
    mixSet(BLC, blood * (0.6 + 0.4 * S.night), 1);
    // fog weather: a grey veil over everything
    tc.copy(FOGC).multiplyScalar(dayK * 0.9);
    cur.fog.lerp(tc, fogW * 0.75); cur.hor.lerp(cur.fog, fogW * 0.7); cur.mid.lerp(cur.fog, fogW * 0.45);
    // regions tint the fog and haze
    tc.copy(SWAMPC).multiplyScalar(dayK); cur.fog.lerp(tc, S.swamp * 0.65); cur.hemiGnd.lerp(tc, S.swamp * 0.4);
    tc.copy(NORTHC).multiplyScalar(dayK); cur.fog.lerp(tc, S.north * (1 - S.cit) * 0.55); cur.hemiSky.lerp(tc, S.north * (1 - S.cit) * 0.3);
    tc.copy(CITC).multiplyScalar(0.4 + dayK * 0.6); cur.fog.lerp(tc, S.cit * 0.6); cur.hor.lerp(tc, S.cit * 0.3); cur.hemiGnd.lerp(tc, S.cit * 0.5);
    cur.moonCol.copy(MOON_C).lerp(BMOON_C, blood);

    // dome uniforms
    const clear = 1 - Math.max(storm, fogW * 0.8);
    U.uStars.value = cur.stars * (1 - storm) * (1 - fogW * 0.7);
    U.uCover.value = cur.cover - storm * 0.3 - fogW * 0.12;
    U.uTower.value = cur.tower * (1 - fogW * 0.6);
    U.uTowerH.value = cur.towerH;
    U.uStorm.value = storm;
    U.uGlowAmt.value = cur.glowAmt * (1 - storm * 0.6) * (1 - fogW * 0.5) * (1 - blood * 0.4) + blood * 0.25;
    U.uSunAmt.value = cur.sunAmt * (1 - storm * 0.9) * (1 - fogW * 0.6) * (1 - blood * 0.8) * smooth(Math.min(1, Math.max(0, (sunDir.y + 0.05) / 0.08)));
    U.uMoonAmt.value = Math.min(1, (S.night * (1 - storm * 0.85) * (1 - fogW * 0.5) + blood * 0.9)) * smooth(Math.min(1, Math.max(0, (moonDir.y + 0.02) / 0.1)));
    U.uMoonSize.value = 0.075 + blood * 0.045;
    U.uFogSky.value = fogW * 0.82 + S.swamp * 0.25;
    // light direction: the sun by day, the moon by night
    lightDir.copy(sunDir).lerp(moonDir, S.night).normalize();
    if (lightDir.y < 0.05) { lightDir.y = 0.05; lightDir.normalize(); }

    // flash decay
    S.flashI = Math.max(0, S.flashI - dt / S.flashDur);
    U.uFlash.value = S.flashI * 0.9;

    // lights
    sunL.color.copy(cur.dirCol);
    sunL.intensity = cur.dirI * (1 - storm * 0.65) * (1 - fogW * 0.4) + blood * 0.3 * S.night;
    sunL.position.copy(cam).addScaledVector(lightDir, 200); sunL.target.position.copy(cam);
    hemi.color.copy(cur.hemiSky).lerp(flashCol, Math.min(1, S.flashI * 0.7));
    hemi.groundColor.copy(cur.hemiGnd);
    hemi.intensity = cur.hemiI * (1 - storm * 0.25) + S.flashI * 2.5;
    amb.color.copy(cur.amb); amb.intensity = cur.ambI;

    // fog tuned to view distance (exp2: about 85% at the view distance)
    const view = c.quality === 'low' ? 180 : 300;
    fog.color.copy(cur.fog).lerp(flashCol, Math.min(0.5, S.flashI * 0.25));
    fog.density = 1.38 / view * (1 + fogW * 2.2 + S.swamp * 0.7 + storm * 0.35 + S.north * 0.2) * cur.fogK;
    scene.background.copy(cur.fog);

    // dome, haze, rays follow the camera
    dome.position.copy(cam);
    haze.position.set(cam.x, 0, cam.z);
    haze.material.uniforms.uAmt.value = 0.75 + fogW * 0.25;
    const rayAmt = cur.rays * clear * (1 - blood) * U.uSunAmt.value;
    rays.visible = rayAmt > 0.02;
    if (rays.visible) {
      rays.position.copy(cam).addScaledVector(sunDir, 600); rays.quaternion.copy(camera.quaternion); rays.scale.setScalar(1500);
      rays.material.uniforms.uAmt.value = rayAmt * 0.4;
    }

    // storm crown (pulled in toward the camera when far, keeping its angular size)
    tv.copy(CROWN).sub(cam); const cd = tv.length(), k = Math.min(1, CROWN_MAX / cd, 1120 / (cd + 780));
    crown.position.copy(cam).addScaledVector(tv, k); crown.scale.setScalar(k);
    const cm = crown.userData.mat.uniforms;
    cm.uHaze.value = Math.min(0.9, Math.min(0.2, cd / 10000) * (1 - S.night * 0.6) + fogW * 0.75); cm.uLum.value = cur.lum;

    // lightning
    lightning(dt);

    // particles
    const tt = c.time % 3000;
    const inside = CT.world && typeof CT.world.interiorAt === 'function' && CT.world.interiorAt(cam.x, cam.z);
    S.rainR += ((inside ? 0.1 : 1) - S.rainR) * Math.min(1, dt * 3);
    const south = 1 - S.north;
    part(rain, S.stormW * south * S.rainR, tt, cam, tc.copy(cur.hemiSky).multiplyScalar(0.6).lerp(flashCol, S.flashI * 0.5).addScalar(0.05), 1, -5 * S.stormW, 3 * S.stormW);
    part(snow, S.north * (1 - S.cit * 0.8) * (0.35 + 0.65 * Math.max(S.stormW, fogW * 0.5)), tt, cam, tc.copy(cur.hemiSky).multiplyScalar(0.8).addScalar(0.12), 1, -2 - 4 * S.stormW, 1);
    part(ash, S.cit, tt, cam, tc.copy(cur.fog).multiplyScalar(0.8).addScalar(0.06), 1, -1.5, 0.5);
    part(flies, Math.max(S.forest, S.swamp) * S.night * (1 - S.stormW) * (1 - blood * 0.5), tt, cam, tc, 1, 0, 0);
  }
  function part(p, amt, tt, cam, col, size, wx, wz) {
    p.visible = amt > 0.01;
    if (!p.visible) return;
    const u = p.material.uniforms;
    u.uTime.value = tt; u.uCam.value.copy(cam); u.uAmt.value = amt; u.uSize.value = size; u.uCol.value.copy(col); u.uWind.value.set(wx, wz);
  }

  const API = {
    init, update, setWeather, flash,
    isNight() { const t = API.timeOfDay; return t > 0.8 || t < 0.2; },
    timeOfDay: 0.745,
    weather: 'clear',
    lightDir, sunDir, moonDir, _S: S,
    _bolt(ang, d) { S.nextBolt = 0; S._ang = ang; S._d = d; },          // debug: force a strike at a camera-relative angle                          // read-only extras for other modules
  };
  CT.sky = API;
})();
