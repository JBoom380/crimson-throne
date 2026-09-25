// ─── GORE: droplets, decals, severed chunks, gibs, blade and screen blood ────
(function () {
  const T = THREE;
  const G = CT.gore = { blade: 0, hands: 0, bladeWet: 0, handsWet: 0, stats: { drops: 0, decals: 0, chunks: 0, gibs: 0, ms: 0, peak: 0 } };
  let core = null, scene = null, hi = true, Q = 1, ready = false;

  // ── Helpers ────────────────────────────────────────────────────────────────
  const rnd = Math.random, rr = (a, b) => a + (b - a) * rnd();
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const pick = a => a[(rnd() * a.length) | 0];
  const UP = new T.Vector3(0, 1, 0);
  const worldOK = f => CT.world && typeof CT.world[f] === 'function' && !(CT._broken && CT._broken.world);
  function groundY(x, z) { if (worldOK('heightAt')) { const y = CT.world.heightAt(x, z); if (y === y && isFinite(y)) return y; } return 0; }
  function groundN(x, z, out) {
    if (worldOK('normalAt')) { const n = CT.world.normalAt(x, z); if (n && isFinite(n.y) && n.y > 0.05) return out.copy(n).normalize(); }
    return out.copy(UP);
  }
  const inWater = (x, z) => (worldOK('waterAt') ? (CT.world.waterAt(x, z) || 0) > 0.03 : false);
  // scratch objects (no per-frame allocation)
  const tv = new T.Vector3(), tv2 = new T.Vector3(), tv3 = new T.Vector3(), tn = new T.Vector3(), tq = new T.Quaternion(), tq2 = new T.Quaternion();
  const tm = new T.Matrix4(), tm2 = new T.Matrix4(), ts = new T.Vector3(), tcol = new T.Color(), box = new T.Box3(), teul = new T.Euler();
  function randDir(out) { let x, y, z, l; do { x = rnd() * 2 - 1; y = rnd() * 2 - 1; z = rnd() * 2 - 1; l = x * x + y * y + z * z; } while (l > 1 || l < 1e-4); l = Math.sqrt(l); return out.set(x / l, y / l, z / l); }

  // Metaball field: blobs = [cx, cy, r, ...] -> Float32Array w*h (value > 1 = inside)
  function field(w, h, blobs) {
    const f = new Float32Array(w * h);
    for (let b = 0; b < blobs.length; b += 3) {
      const cx = blobs[b], cy = blobs[b + 1], r2 = blobs[b + 2] * blobs[b + 2], R = blobs[b + 2] * 4;
      const x0 = Math.max(0, (cx - R) | 0), x1 = Math.min(w - 1, (cx + R) | 0), y0 = Math.max(0, (cy - R) | 0), y1 = Math.min(h - 1, (cy + R) | 0);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const dx = x + 0.5 - cx, dy = y + 0.5 - cy; f[y * w + x] += r2 / (dx * dx + dy * dy + 0.3); }
    }
    return f;
  }
  // Paint a field into RGBA data with a 4-tone blood palette + wet highlight pixels.
  function paintField(data, stride, ox, oy, w, h, f, pal, R, clot, blobs) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = f[y * w + x]; if (v <= 1) continue;
      let c = v < 1.3 ? pal.rim : v < 2.8 ? pal.body : pal.thick;
      if (clot && v > 2.2 && R() < 0.1) c = pal.clot;
      else if (v > 3 && R() < 0.004) c = pal.hl;
      const o = ((oy + y) * stride + ox + x) * 4;
      data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = c[3];
    }
    // wet glints: a small highlight on the upper-left of each big blob
    const glintMin = Math.max(3.5, Math.min(w, h) * 0.1);
    for (let b = 0; blobs && b < blobs.length; b += 3) {
      const r = blobs[b + 2]; if (r < glintMin) continue;
      const gx = (blobs[b] - r * 0.38) | 0, gy = (blobs[b + 1] - r * 0.38) | 0;
      const pts = r > 7 ? [0, 0, 1, 0, 0, 1, 2, 0] : [0, 0, 1, 0];
      for (let k = 0; k < pts.length; k += 2) {
        const x = gx + pts[k], y = gy + pts[k + 1]; if (x < 0 || y < 0 || x >= w || y >= h || f[y * w + x] <= 1.6) continue;
        const o = ((oy + y) * stride + ox + x) * 4, c = pal.hl;
        data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = c[3];
      }
    }
  }
  // Blob recipes (coordinates inside a w*h box)
  function starBlobs(R, w, h, big) {
    const b = [], cx = w / 2 + (R() - 0.5) * 4, cy = h / 2 + (R() - 0.5) * 4, m = Math.min(w, h), k = Math.min(m, 52);
    b.push(cx, cy, k * (big ? 0.16 : 0.13));
    for (let i = 0; i < 5; i++) b.push(cx + (R() - 0.5) * m * 0.22, cy + (R() - 0.5) * m * 0.22, k * rr(0.05, 0.09));
    const spikes = 7 + ((R() * 8) | 0);
    for (let s = 0; s < spikes; s++) {
      const a = R() * Math.PI * 2, len = m * rr(0.2, 0.46), r0 = k * rr(0.035, 0.06);
      for (let t = 0.1; t < 1; t += 0.06) b.push(cx + Math.cos(a + Math.sin(t * 4) * 0.05) * len * t, cy + Math.sin(a + Math.sin(t * 4) * 0.05) * len * t, r0 * (1 - t * 0.75) * (0.8 + R() * 0.4));
      if (R() < 0.7) b.push(cx + Math.cos(a) * len * 1.1, cy + Math.sin(a) * len * 1.1, k * 0.03);
    }
    for (let i = 0; i < 10 + m / 4; i++) { const a = R() * 6.283, d = m * rr(0.25, 0.48); b.push(cx + Math.cos(a) * d, cy + Math.sin(a) * d, rr(0.6, 1.7)); }
    return b;
  }
  function poolBlobs(R, w, h) {
    const b = [], cx = w / 2, cy = h / 2;
    for (let i = 0; i < 9; i++) { const a = R() * 6.283, d = R() * w * 0.16; b.push(cx + Math.cos(a) * d, cy + Math.sin(a) * d, w * rr(0.1, 0.17)); }
    for (let i = 0; i < 7; i++) { const a = R() * 6.283, d = w * rr(0.26, 0.34); b.push(cx + Math.cos(a) * d, cy + Math.sin(a) * d, w * rr(0.04, 0.07)); }
    for (let i = 0; i < 8; i++) { const a = R() * 6.283, d = w * rr(0.36, 0.46); b.push(cx + Math.cos(a) * d, cy + Math.sin(a) * d, rr(0.7, 1.4)); }
    return b;
  }
  function smearBlobs(R, w, h) {
    const b = [], cx = w / 2;
    b.push(cx, h * 0.74, w * 0.09); b.push(cx + (R() - 0.5) * 6, h * 0.8, w * 0.06);
    for (let t = 0; t < 1; t += 0.04) b.push(cx + Math.sin(t * 5 + R()) * 1.5, h * (0.72 - t * 0.66), w * 0.05 * (1 - t * 0.85));
    for (let i = 0; i < 16; i++) { const t = R(); b.push(cx + (R() - 0.5) * w * 0.5 * t, h * (0.8 - t * 0.75), rr(0.6, 1.8)); }
    for (let i = 0; i < 5; i++) b.push(cx + (R() - 0.5) * w * 0.25, h * rr(0.82, 0.95), rr(0.8, 2.2));
    return b;
  }
  function spatterBlobs(R, w, h) {
    const b = [];
    for (let i = 0; i < 46; i++) { const a = R() * 6.283, d = Math.pow(R(), 0.7) * w * 0.46; b.push(w / 2 + Math.cos(a) * d, h / 2 + Math.sin(a) * d, rr(0.6, 2.6) * (1 - d / w)); }
    return b;
  }
  function crownBlobs(R, w, h) {
    const b = [w / 2, h / 2, w * 0.1];
    for (let i = 0; i < 18; i++) { const a = i / 18 * 6.283 + R() * 0.3, d = w * rr(0.24, 0.36); b.push(w / 2 + Math.cos(a) * d, h / 2 + Math.sin(a) * d, rr(1, 2.8)); b.push(w / 2 + Math.cos(a) * d * 0.6, h / 2 + Math.sin(a) * d * 0.6, rr(0.8, 1.6)); }
    return b;
  }

  // ── Droplets: one instanced billboard mesh, stretched along velocity ───────
  let DMAX = 3000, dN = 0, dBuf, dAttr, dGeo, dMat, dMesh;
  let dLife, dStuck, dGy, dGx, dGz, dMake;
  let decalBudget = 0;
  function initDroplets() {
    DMAX = hi ? 3000 : 1000;
    dBuf = new Float32Array(DMAX * 8);            // [x y z size | vx vy vz shade]
    dLife = new Float32Array(DMAX); dStuck = new Uint8Array(DMAX); dMake = new Uint8Array(DMAX);
    dGy = new Float32Array(DMAX); dGx = new Float32Array(DMAX); dGz = new Float32Array(DMAX);
    dGeo = new T.InstancedBufferGeometry();
    dGeo.setAttribute('position', new T.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    dGeo.setIndex([0, 1, 2, 0, 2, 3]);
    dAttr = new T.InstancedInterleavedBuffer(dBuf, 8); dAttr.setUsage(T.DynamicDrawUsage);
    dGeo.setAttribute('iA', new T.InterleavedBufferAttribute(dAttr, 4, 0));
    dGeo.setAttribute('iB', new T.InterleavedBufferAttribute(dAttr, 4, 4));
    dGeo.instanceCount = 0;
    dMat = new T.ShaderMaterial({
      uniforms: T.UniformsUtils.merge([T.UniformsLib.fog, { uLight: { value: 1 }, uPix: { value: 0.0055 } }]),
      fog: true, side: T.DoubleSide,
      vertexShader: `
        #include <fog_pars_vertex>
        attribute vec4 iA; attribute vec4 iB; uniform float uPix; varying float vShade; varying vec2 vQ;
        void main(){
          vec4 mvPosition = modelViewMatrix * vec4(iA.xyz, 1.0);
          vec3 vv = (viewMatrix * vec4(iB.xyz, 0.0)).xyz;
          float depth = max(-mvPosition.z, 0.1);
          float sp = length(vv.xy);
          vec2 d = sp > 0.05 ? vv.xy / sp : vec2(0.0, 1.0);
          vec2 n = vec2(d.y, -d.x);
          float s = max(abs(iA.w), depth * uPix);
          float st = s + min(sp * 0.009, 0.09) * (0.6 + iB.w * 0.4);
          float fl = iA.w < 0.0 ? 0.35 : 1.0; s = max(abs(iA.w), depth * uPix); st = max(st, s);
          mvPosition.xy += n * position.x * s + d * (position.y * st - (st - s)) * fl;
          vShade = iB.w; vQ = position.xy;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `
        #include <fog_pars_fragment>
        uniform float uLight; varying float vShade; varying vec2 vQ;
        void main(){
          vec3 c = mix(vec3(0.13, 0.005, 0.005), vec3(0.36, 0.014, 0.012), vShade);
          if (vShade > 0.84 && vQ.y > 0.25) c = vec3(0.75, 0.12, 0.08);
          gl_FragColor = vec4(c * uLight, 1.0);
          #include <fog_fragment>
        }`,
    });
    dMesh = new T.Mesh(dGeo, dMat); dMesh.frustumCulled = false; dMesh.renderOrder = 2;
    scene.add(dMesh);
  }
  function drop(x, y, z, vx, vy, vz, size, shade, life, maker) {
    const i = dN < DMAX ? dN++ : (rnd() * DMAX) | 0, o = i * 8;
    dBuf[o] = x; dBuf[o + 1] = y; dBuf[o + 2] = z; dBuf[o + 3] = size;
    dBuf[o + 4] = vx; dBuf[o + 5] = vy; dBuf[o + 6] = vz; dBuf[o + 7] = shade;
    dLife[i] = life; dStuck[i] = 0; dMake[i] = maker ? 1 : 0;
    dGx[i] = x; dGz[i] = z; dGy[i] = groundY(x, z);
  }
  function killDrop(i) {
    const j = --dN; if (i === j) return;
    const o = i * 8, p = j * 8;
    for (let k = 0; k < 8; k++) dBuf[o + k] = dBuf[p + k];
    dLife[i] = dLife[j]; dStuck[i] = dStuck[j]; dMake[i] = dMake[j]; dGy[i] = dGy[j]; dGx[i] = dGx[j]; dGz[i] = dGz[j];
  }
  function updateDroplets(dt) {
    const drag = Math.exp(-0.7 * dt), g = 9.8 * dt;
    for (let i = 0; i < dN;) {
      const o = i * 8;
      if ((dLife[i] -= dt) <= 0) { killDrop(i); continue; }
      if (dStuck[i]) { if (dLife[i] < 0.5) dBuf[o + 3] *= 0.9; i++; continue; }
      dBuf[o + 5] -= g;
      dBuf[o + 4] *= drag; dBuf[o + 5] *= drag; dBuf[o + 6] *= drag;
      const x = dBuf[o] += dBuf[o + 4] * dt, y = dBuf[o + 1] += dBuf[o + 5] * dt, z = dBuf[o + 2] += dBuf[o + 6] * dt;
      if (Math.abs(x - dGx[i]) + Math.abs(z - dGz[i]) > 0.4) { dGx[i] = x; dGz[i] = z; dGy[i] = groundY(x, z); }
      if (y <= dGy[i]) {
        const gy = groundY(x, z); dGy[i] = gy; dGx[i] = x; dGz[i] = z;
        if (y <= gy) {
          const vx = dBuf[o + 4], vz = dBuf[o + 6];
          if (inWater(x, z)) { killDrop(i); continue; }
          if (dMake[i] && decalBudget > 0) {
            decalBudget--;
            const hs = Math.hypot(vx, vz), big = dBuf[o + 3];
            if (hs > 2.2) addDecal(x, z, clamp(big * 8 + hs * 0.03, 0.12, 0.4), 6 + ((rnd() * 2) | 0), Math.atan2(vx, vz), 0.06, 0, false);
            else addDecal(x, z, clamp(big * 12, 0.12, 0.55), pick(SMALL_TILES), rnd() * 6.283, 0.06, 0, false);
          }
          if (rnd() < 0.45) { killDrop(i); continue; }
          dBuf[o + 1] = gy + 0.01; dBuf[o + 4] = dBuf[o + 5] = dBuf[o + 6] = 0; dBuf[o + 3] = -Math.abs(dBuf[o + 3]) * 1.2; dBuf[o + 7] *= 0.3;
          dStuck[i] = 1; dLife[i] = rr(1, 3);
        }
      }
      i++;
    }
    dAttr.clearUpdateRanges(); if (dN) dAttr.addUpdateRange(0, dN * 8);
    dAttr.needsUpdate = true; dGeo.instanceCount = dN;
  }
  // Directional cone jet (scalar math only)
  function jet(px, py, pz, dx, dy, dz, n, vmin, vmax, spread, sizeMul, makeP) {
    for (let k = 0; k < n; k++) {
      const big = rnd() < 0.08;
      let ex = dx + (rnd() * 2 - 1) * spread, ey = dy + (rnd() * 2 - 1) * spread, ez = dz + (rnd() * 2 - 1) * spread;
      const l = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1, sp = rr(vmin, vmax) * (big ? 0.75 : 1);
      ex /= l; ey /= l; ez /= l;
      drop(px + ex * 0.04, py + ey * 0.04, pz + ez * 0.04, ex * sp, ey * sp, ez * sp,
        (big ? rr(0.022, 0.038) : rr(0.006, 0.017)) * sizeMul, rnd(), rr(3, 5), big || rnd() < makeP);
    }
  }

  // ── Decals: one instanced mesh, pools ring + splats ring, pixel atlas ──────
  const DEC = 300, NPOOL = 60, SMALL_TILES = [0, 1, 2, 3, 8, 9, 10], POOL_TILES = [4, 5, 11], STAR_TILES = [0, 1, 2, 3];
  let decMesh, decAttr, decData, poolHead = 0, splatHead = NPOOL, decDirty = false, decADirty = false;
  const dc = [];   // decal records
  function buildAtlas() {
    const TS = 64, cv = document.createElement('canvas'); cv.width = TS * 4; cv.height = TS * 3;
    const cx = cv.getContext('2d'), img = cx.createImageData(cv.width, cv.height), R = CT.rng(1337);
    const pal = { rim: [98, 9, 8, 255], body: [80, 6, 6, 255], thick: [54, 4, 5, 255], hl: [220, 90, 78, 255], clot: [26, 2, 3, 255] };
    const recipes = [
      () => starBlobs(R, TS, TS, true), () => starBlobs(R, TS, TS, false), () => starBlobs(R, TS, TS, true), () => starBlobs(R, TS, TS, false),
      () => poolBlobs(R, TS, TS), () => poolBlobs(R, TS, TS), () => smearBlobs(R, TS, TS), () => smearBlobs(R, TS, TS),
      () => spatterBlobs(R, TS, TS), () => spatterBlobs(R, TS, TS), () => crownBlobs(R, TS, TS), () => poolBlobs(R, TS, TS),
    ];
    recipes.forEach((fn, t) => { const b = fn(); paintField(img.data, cv.width, (t % 4) * TS, ((t / 4) | 0) * TS, TS, TS, field(TS, TS, b), pal, R, t === 11 || t === 5, b); });
    cx.putImageData(img, 0, 0);
    const tex = new T.CanvasTexture(cv);
    tex.colorSpace = T.SRGBColorSpace; tex.magFilter = T.NearestFilter; tex.minFilter = T.NearestMipmapNearestFilter;
    return tex;
  }
  function initDecals() {
    const geo = new T.PlaneGeometry(1, 1); geo.rotateX(-Math.PI / 2);
    const mat = new T.MeshPhongMaterial({ map: buildAtlas(), color: 0xffffff, specular: 0x5a2020, shininess: 70,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    mat.onBeforeCompile = sh => {
      sh.vertexShader = 'attribute vec2 aDec;\nvarying float vDecA;\n' + sh.vertexShader.replace('#include <uv_vertex>',
        '#include <uv_vertex>\n  vMapUv = (uv + vec2(mod(aDec.x, 4.0), 2.0 - floor(aDec.x / 4.0 + 0.01))) * vec2(0.25, 1.0 / 3.0);\n  vDecA = aDec.y;');
      sh.fragmentShader = 'varying float vDecA;\n#define B2(a) fract(dot(floor(a), vec2(0.5, floor(a).y * 0.75)))\n' + sh.fragmentShader.replace('#include <map_fragment>',
        '#include <map_fragment>\n  diffuseColor.a *= vDecA;\n  float bd = B2(0.5 * gl_FragCoord.xy) * 0.25 + B2(gl_FragCoord.xy);\n  if (diffuseColor.a < bd * 0.96 + 0.03) discard;\n  diffuseColor.a = 1.0;');
    };
    mat.customProgramCacheKey = () => 'ctGoreDecal';
    decMesh = new T.InstancedMesh(geo, mat, DEC);
    decMesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
    decData = new Float32Array(DEC * 2);
    decAttr = new T.InstancedBufferAttribute(decData, 2); decAttr.setUsage(T.DynamicDrawUsage);
    geo.setAttribute('aDec', decAttr);
    tm.makeScale(0, 0, 0);
    for (let i = 0; i < DEC; i++) {
      decMesh.setMatrixAt(i, tm);
      tcol.setHSL(0, 0, rr(0.72, 1)); decMesh.setColorAt(i, tcol);
      dc.push({ on: false, x: 0, y: 0, z: 0, s: 1, t: 0, grow: 0.1, life: 180, q: new T.Quaternion(), done: false });
    }
    decMesh.frustumCulled = false; decMesh.renderOrder = 1;
    scene.add(decMesh);
  }
  function addDecal(x, z, size, tile, yaw, grow, delay, isPool) {
    if (!ready || inWater(x, z)) return;
    let i;
    if (isPool) { i = poolHead; poolHead = (poolHead + 1) % NPOOL; }
    else { i = splatHead; splatHead = splatHead + 1 >= DEC ? NPOOL : splatHead + 1; }
    const d = dc[i];
    groundN(x, z, tn);
    const lift = (isPool ? 0.012 : 0.02) + (i % 7) * 0.003;
    d.x = x + tn.x * lift; d.y = groundY(x, z) + tn.y * lift; d.z = z + tn.z * lift;
    tq.setFromAxisAngle(UP, yaw); d.q.setFromUnitVectors(UP, tn).multiply(tq);
    d.s = size; d.t = -(delay || 0); d.grow = Math.max(0.02, grow); d.life = isPool ? rr(170, 190) : rr(150, 185); d.on = true; d.done = false;
    decData[i * 2] = tile; decData[i * 2 + 1] = 1; decADirty = true;
    tm.makeScale(0, 0, 0); decMesh.setMatrixAt(i, tm); decDirty = true;
    const v = isPool ? rr(0.8, 1) : rr(0.7, 1); tcol.setRGB(v, v * rr(0.85, 1), v * rr(0.85, 1)); decMesh.setColorAt(i, tcol);
    decMesh.instanceColor.needsUpdate = true;
  }
  function updateDecals(dt) {
    let n = 0;
    for (let i = 0; i < DEC; i++) {
      const d = dc[i]; if (!d.on) continue; n++;
      const t0 = d.t; d.t += dt;
      if (d.t < 0) continue;
      if (!d.done) {
        const k = Math.min(1, d.t / d.grow), e = 1 - (1 - k) * (1 - k) * (1 - k);
        const s = d.s * (0.12 + 0.88 * e);
        ts.set(s, 1, s); tv.set(d.x, d.y, d.z); tm.compose(tv, d.q, ts); decMesh.setMatrixAt(i, tm); decDirty = true;
        if (k >= 1) d.done = true;
      }
      if (d.t > d.life - 10) {
        const a = clamp((d.life - d.t) / 10, 0, 1);
        decData[i * 2 + 1] = a; decADirty = true;
        if (d.t >= d.life) { d.on = false; tm.makeScale(0, 0, 0); decMesh.setMatrixAt(i, tm); }
      } else if (t0 < 0) { decData[i * 2 + 1] = 1; decADirty = true; }
    }
    if (decDirty) { decMesh.instanceMatrix.needsUpdate = true; decDirty = false; }
    if (decADirty) { decAttr.needsUpdate = true; decADirty = false; }
    return n;
  }

  // ── Rigid bodies: severed chunks (Object3D) and gib pieces (instances) ─────
  const CHUNKS = 60;
  let MEAT = 240, BONE = 80, meatMesh, boneMesh, meatHead = 0, boneHead = 0, meatDirty = false, boneDirty = false;
  const chunkB = [], meatB = [], boneB = [], boneHE = new T.Vector3();
  function makeBody() {
    return { on: false, P: new T.Vector3(), v: new T.Vector3(), q: new T.Quaternion(), w: new T.Vector3(), he: new T.Vector3(), c: new T.Vector3(),
      sc: new T.Vector3(), scl: new T.Vector3(), gx: 0, gz: 0, gy: 0, age: 0, restT: 0, rest: false, life: 60, bleed: 0, bleedDur: 1, acc: 0,
      pool: 0, obj: null, dispose: false, mesh: null, idx: 0 };
  }
  // Per-face colour mottling (non-indexed geometry: 3 vertices per face)
  function faceColors(g, fn) {
    const p = g.attributes.position, col = new Float32Array(p.count * 3);
    for (let f = 0; f < p.count; f += 3) {
      const c = fn((p.getX(f) + p.getX(f + 1) + p.getX(f + 2)) / 3, (p.getY(f) + p.getY(f + 1) + p.getY(f + 2)) / 3);
      for (let k = 0; k < 3; k++) col.set(c, (f + k) * 3);
    }
    g.setAttribute('color', new T.Float32BufferAttribute(col, 3));
  }
  function jitterIco(r, detail, amt, seed) {
    const g = new T.IcosahedronGeometry(r, detail), p = g.attributes.position, R = CT.rng(seed), map = {};
    for (let i = 0; i < p.count; i++) {
      const k = p.getX(i).toFixed(3) + ',' + p.getY(i).toFixed(3) + ',' + p.getZ(i).toFixed(3);
      const j = map[k] || (map[k] = 1 + (R() - 0.5) * amt);
      p.setXYZ(i, p.getX(i) * j, p.getY(i) * j * 0.85, p.getZ(i) * j);
    }
    g.computeVertexNormals();
    faceColors(g, () => { const r = R(); return r < 0.18 ? [0.45, 0.28, 0.28] : r < 0.3 ? [1.35, 1.15, 0.95] : r < 0.4 ? [1.5, 0.85, 0.85] : [1, 1, 1]; });
    return g;
  }
  function ribGeo() {
    const g = new T.BoxGeometry(1, 0.16, 0.12, 8, 1, 1).toNonIndexed(), p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), a = x * 1.5, taper = 1 - Math.abs(x) * 0.9;
      p.setXYZ(i, Math.sin(a) * 0.62, p.getY(i) * taper + (1 - Math.cos(a)) * 0.45, p.getZ(i) * taper);
    }
    g.computeVertexNormals(); g.computeBoundingBox(); g.center(); g.computeBoundingBox();
    g.boundingBox.getSize(boneHE).multiplyScalar(0.5);
    const hx = boneHE.x;
    faceColors(g, x => { const e = Math.abs(x) / hx; return e > 0.75 ? [0.62, 0.12, 0.1] : e > 0.55 && Math.random() < 0.5 ? [0.8, 0.45, 0.4] : [1, 1, 1]; });
    return g;
  }
  function initBodies() {
    MEAT = hi ? 240 : 120; BONE = hi ? 80 : 40;
    const mm = new T.MeshPhongMaterial({ color: 0xffffff, specular: 0x4a2424, shininess: 40, vertexColors: true });
    const bm = new T.MeshPhongMaterial({ color: 0xffffff, specular: 0x444038, shininess: 30, flatShading: true, vertexColors: true });
    meatMesh = new T.InstancedMesh(jitterIco(1, 1, 0.6, 7), mm, MEAT);
    boneMesh = new T.InstancedMesh(ribGeo(), bm, BONE);
    tm.makeScale(0, 0, 0);
    [[meatMesh, MEAT, meatB], [boneMesh, BONE, boneB]].forEach(([m, n, arr]) => {
      m.instanceMatrix.setUsage(T.DynamicDrawUsage); m.frustumCulled = false; m.castShadow = true;
      for (let i = 0; i < n; i++) { m.setMatrixAt(i, tm); m.setColorAt(i, tcol.set(0xffffff)); const b = makeBody(); b.mesh = m; b.idx = i; arr.push(b); }
      scene.add(m);
    });
    for (let i = 0; i < CHUNKS; i++) chunkB.push(makeBody());
  }
  // Integrate one body; returns true when its transform changed.
  function stepBody(b, dt) {
    b.age += dt;
    if (b.age > b.life - 2.5) {                     // sink into the ground at the end of life
      b.P.y -= dt * 0.25 * (b.he.x + b.he.y + b.he.z + 0.2); b.rest = true;
      return true;
    }
    if (b.rest || dt <= 0) return false;
    const v = b.v, w = b.w, P = b.P;
    v.y -= 9.8 * dt; v.multiplyScalar(1 - 0.1 * dt);
    P.addScaledVector(v, dt);
    const wl = w.length();
    if (wl > 1e-4) { tq.setFromAxisAngle(tv.copy(w).divideScalar(wl), wl * dt); b.q.premultiply(tq).normalize(); }
    if (Math.abs(P.x - b.gx) + Math.abs(P.z - b.gz) > 0.25) { b.gx = P.x; b.gz = P.z; b.gy = groundY(P.x, P.z); }
    tm.makeRotationFromQuaternion(b.q); const e = tm.elements;
    const h = Math.abs(e[1]) * b.he.x + Math.abs(e[5]) * b.he.y + Math.abs(e[9]) * b.he.z;
    if (P.y - h <= b.gy) {
      P.y = b.gy + h;
      if (v.y < -1.4) {
        const imp = -v.y;
        v.y = imp * 0.3; v.x *= 0.65; v.z *= 0.65;
        w.multiplyScalar(0.6); w.x += (rnd() - 0.5) * imp * 1.5; w.z += (rnd() - 0.5) * imp * 1.5;
        onImpact(b, imp);
      } else {
        v.y = 0; const f = Math.max(0, 1 - 5 * dt); v.x *= f; v.z *= f;
        w.multiplyScalar(Math.max(0, 1 - 5 * dt));
        // topple toward lying on the flattest side
        const he = b.he, k = he.x <= he.y && he.x <= he.z ? 0 : he.y <= he.z ? 1 : 2, s = e[k * 4 + 1] >= 0 ? 1 : -1;
        tv.set(e[k * 4] * s, e[k * 4 + 1] * s, e[k * 4 + 2] * s);
        tq.setFromUnitVectors(tv, UP); tq2.copy(tq).multiply(b.q); b.q.slerp(tq2, Math.min(1, dt * 5));
        if (v.lengthSq() < 0.05 && w.lengthSq() < 0.4) { if ((b.restT += dt) > 0.3) { b.rest = true; onRest(b); } }
        else b.restT = 0;
      }
    }
    // blood trail from the stump while it flies and tumbles
    if (b.bleed > 0 && b.age < b.bleedDur) {
      b.acc += b.bleed * (1 - b.age / b.bleedDur) * dt;
      while (b.acc >= 1) {
        b.acc -= 1;
        tv3.copy(b.sc).applyQuaternion(b.q).add(P);
        drop(tv3.x, tv3.y, tv3.z, v.x * 0.4 + rr(-1, 1), v.y * 0.4 + rr(-0.5, 1.2), v.z * 0.4 + rr(-1, 1), rr(0.01, 0.026), rnd(), rr(3, 5), rnd() < 0.12);
      }
    }
    return true;
  }
  function onImpact(b, imp) {
    if (imp < 2.2) return;
    const n = Math.min(24, (imp * 4 * Q) | 0);
    jet(b.P.x, b.gy + 0.05, b.P.z, 0, 1, 0, n, 1, 1 + imp * 0.4, 0.9, 1, 0.05);
    if (rnd() < 0.8) addDecal(b.P.x, b.P.z, clamp((b.he.x + b.he.y + b.he.z) * 1.6, 0.25, 1.1), pick(SMALL_TILES), rnd() * 6.283, 0.05, 0, false);
  }
  function onRest(b) { if (b.pool > 0) addDecal(b.P.x, b.P.z, b.pool, pick(POOL_TILES), rnd() * 6.283, rr(2.5, 3.5), 0, true); }
  function applyChunk(b) { tv.copy(b.c).applyQuaternion(b.q); b.obj.position.copy(b.P).sub(tv); b.obj.quaternion.copy(b.q); }
  function applyInst(b) { tm.compose(b.P, b.q, b.scl); b.mesh.setMatrixAt(b.idx, tm); }
  function releaseChunk(b) {
    const o = b.obj; b.on = false; b.obj = null;
    if (!o) return;
    if (o.parent) o.parent.remove(o);
    if (b.dispose) o.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) [].concat(c.material).forEach(m => m.dispose()); });
  }
  function updateBodies(dt) {
    let nc = 0, ng = 0;
    for (let i = 0; i < CHUNKS; i++) {
      const b = chunkB[i]; if (!b.on) continue; nc++;
      if (stepBody(b, dt)) applyChunk(b);
      if (b.age >= b.life) releaseChunk(b);
    }
    for (let i = 0; i < MEAT; i++) { const b = meatB[i]; if (!b.on) continue; ng++; if (stepBody(b, dt)) { applyInst(b); meatDirty = true; } if (b.age >= b.life) { b.on = false; tm.makeScale(0, 0, 0); meatMesh.setMatrixAt(i, tm); meatDirty = true; } }
    for (let i = 0; i < BONE; i++) { const b = boneB[i]; if (!b.on) continue; ng++; if (stepBody(b, dt)) { applyInst(b); boneDirty = true; } if (b.age >= b.life) { b.on = false; tm.makeScale(0, 0, 0); boneMesh.setMatrixAt(i, tm); boneDirty = true; } }
    if (meatDirty) { meatMesh.instanceMatrix.needsUpdate = true; meatDirty = false; }
    if (boneDirty) { boneMesh.instanceMatrix.needsUpdate = true; boneDirty = false; }
    G.stats.chunks = nc; G.stats.gibs = ng;
  }
  function launch(b, px, py, pz, velocity, spin) {
    b.P.set(px, py, pz); b.age = 0; b.restT = 0; b.rest = false; b.acc = 0; b.on = true;
    b.gx = px; b.gz = pz; b.gy = groundY(px, pz);
    if (velocity && velocity.isVector3) b.v.copy(velocity); else b.v.set(rr(-2, 2), rr(3, 5), rr(-2, 2));
    if (spin && spin.isVector3) b.w.copy(spin);
    else randDir(b.w).multiplyScalar(typeof spin === 'number' ? spin : rr(6, 14));
  }

  // ── Pulse emitters (arterial pumping from a moving stump) ──────────────────
  const EMIT = 24, em = [];
  for (let i = 0; i < EMIT; i++) em.push({ on: false, obj: null, lp: new T.Vector3(), ld: new T.Vector3(), t: 0, dur: 1.5, rate: 2.5, amt: 1, acc: 0 });
  function updateEmitters(dt) {
    for (let i = 0; i < EMIT; i++) {
      const e = em[i]; if (!e.on) continue;
      e.t += dt; if (e.t >= e.dur) { e.on = false; continue; }
      if (e.obj) { tv.copy(e.lp).applyMatrix4(e.obj.matrixWorld); tv2.copy(e.ld).transformDirection(e.obj.matrixWorld); }
      else { tv.copy(e.lp); tv2.copy(e.ld); }
      const beat = Math.pow(Math.max(0, Math.sin(e.t * e.rate * Math.PI * 2)), 2), fall = 1 - (e.t / e.dur) * 0.65;
      e.acc += e.amt * (beat * 700 + 25) * fall * dt * Q;
      const n = e.acc | 0; e.acc -= n;
      if (n > 0) jet(tv.x, tv.y, tv.z, tv2.x, tv2.y, tv2.z, n, 1 + beat * 2.5 * fall, 2 + beat * 6.5 * fall, 0.12, 1, 0.08);
    }
  }

  // ── Screen blood (pixel sprites on the 640x360 #px canvas) ─────────────────
  const SPR = [], SPLATS = 48, sp = [];
  const DRIPC = [];   // drip colour ramp, fresh -> dried
  function makeSprite(w, h, blobs, R) {
    const f = field(w, h, blobs), mk = pal => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d'), img = x.createImageData(w, h);
      paintField(img.data, w, 0, 0, w, h, f, pal, CT.rng(7), false, blobs); x.putImageData(img, 0, 0); return c;
    };
    const drips = [];
    for (let x = 1; x < w - 1; x++) { let by = -1; for (let y = h - 1; y >= 0; y--) if (f[y * w + x] > 2.2) { by = y; break; } if (by > h * 0.45) drips.push(x, by); }
    return { fresh: mk(SPAL.fresh), dark: mk(SPAL.dark), w, h, drips };
  }
  const SPAL = {
    fresh: { rim: [190, 26, 20, 215], body: [146, 10, 10, 238], thick: [84, 3, 6, 248], hl: [255, 150, 128, 255] },
    dark:  { rim: [78, 12, 8, 190], body: [54, 5, 5, 222], thick: [28, 2, 2, 238], hl: [118, 42, 34, 225] },
  };
  function initScreen() {
    const R = CT.rng(99);
    for (let i = 0; i < 9; i++) { const s = [22, 28, 34, 44, 54, 64, 76, 90, 104][i]; SPR.push(makeSprite(s, s, starBlobs(R, s, s, i % 2 === 0), R)); }
    for (let i = 0; i < 3; i++) {       // flung spray fans
      const w = 110, h = 56, b = [];
      for (let k = 0; k < 90; k++) { const a = -Math.PI / 2 + (R() - 0.5) * 2.2, d = Math.pow(R(), 0.6) * 52; b.push(w / 2 + Math.cos(a) * d, h - 4 + Math.sin(a) * d, rr(0.5, 2.2) * (1.2 - d / 60)); }
      SPR.push(makeSprite(w, h, b, R));
    }
    for (let i = 0; i < 3; i++) {       // flicked slash streaks: thin tapered line, beads and flung drops
      const w = 100, h = 44, b = [], y0 = rr(30, 36), y1 = rr(8, 14);
      for (let t = 0; t <= 1; t += 0.02) {
        const r = 0.9 + Math.pow(Math.sin(t * Math.PI), 0.6) * 2.2 * (0.6 + R() * 0.5);
        b.push(6 + t * 86, y0 + (y1 - y0) * t + Math.sin(t * 9 + i) * 1.5, r);
        if (R() < 0.12) b.push(6 + t * 86, y0 + (y1 - y0) * t + 3, rr(1.5, 3));     // bead that will drip
      }
      for (let k = 0; k < 34; k++) { const t = R(); b.push(6 + t * 86 + rr(-4, 10), y0 + (y1 - y0) * t + rr(-10, 8), rr(0.5, 1.5)); }
      SPR.push(makeSprite(w, h, b, R));
    }
    for (let i = 0; i < SPLATS; i++) sp.push({ on: false, x: 0, y: 0, s: null, age: 0, life: 4, dr: [{ x: 0, y: 0, len: 0, v: 0, w: 1, stop: false }, { x: 0, y: 0, len: 0, v: 0, w: 1, stop: false }, { x: 0, y: 0, len: 0, v: 0, w: 1, stop: false }], nd: 0 });
    for (let k = 0; k <= 8; k++) { const a = SPAL.fresh.body, b = SPAL.dark.body, t = k / 8; DRIPC.push(`rgb(${(a[0] + (b[0] - a[0]) * t) | 0},${(a[1] + (b[1] - a[1]) * t) | 0},${(a[2] + (b[2] - a[2]) * t) | 0})`); }
  }
  // edge-biased position; min = normalised radius the centre must keep clear
  function edgePos(out, min) {
    for (let k = 0; k < 20; k++) {
      const x = rnd() * 640, y = rnd() * 360, nx = (x - 320) / 320, ny = (y - 180) / 180, r = Math.sqrt(nx * nx + ny * ny);
      if (r > min && rnd() < (r - min) * 1.8) { out.x = x; out.y = y; return out; }
    }
    out.x = rnd() < 0.5 ? rr(10, 120) : rr(520, 630); out.y = rr(20, 340); return out;
  }
  function addSplat(sprite, min) {
    let s = sp.find(q => !q.on);
    if (!s) { s = sp[0]; for (const q of sp) if (q.age / q.life > s.age / s.life) s = q; }
    edgePos(tv, min);
    s.on = true; s.s = sprite; s.x = Math.round(tv.x - sprite.w / 2); s.y = Math.round(tv.y - sprite.h / 2); s.age = 0; s.life = rr(3, 6);
    s.nd = sprite.drips.length ? Math.min(3, 1 + ((rnd() * 3) | 0)) : 0;
    for (let k = 0; k < s.nd; k++) {
      const d = s.dr[k], j = ((rnd() * sprite.drips.length / 2) | 0) * 2;
      d.x = s.x + sprite.drips[j]; d.y = s.y + sprite.drips[j + 1]; d.len = 0; d.v = rr(5, 16); d.w = rnd() < 0.35 ? 2 : 1; d.stop = false;
    }
  }
  function updateScreen(dt) {
    for (const s of sp) {
      if (!s.on) continue;
      if ((s.age += dt) >= s.life) { s.on = false; continue; }
      for (let k = 0; k < s.nd; k++) {
        const d = s.dr[k]; if (d.stop) continue;
        d.len += d.v * dt; d.v *= Math.exp(-dt * 0.35);
        const ny = (d.y + d.len - 180) / 180, nx = (d.x - 320) / 320;
        if (nx * nx + ny * ny < 0.2 || d.y + d.len > 362) d.stop = true;
      }
    }
  }

  // ── Scene light estimate for the unlit droplet shader ──────────────────────
  let lightT = 0;
  function estimateLight() {
    let L = 0;
    scene.children.forEach(o => { if (o.isLight && o.visible) L += o.intensity * (o.color.r * 0.3 + o.color.g * 0.59 + o.color.b * 0.11) * (o.isHemisphereLight ? 0.6 : o.isDirectionalLight ? 0.5 : o.isAmbientLight ? 0.7 : 0); });
    if (core.torchLight) L += Math.min(0.22, core.torchLight.intensity * 0.05);
    dMat.uniforms.uLight.value = clamp(0.1 + L * 0.6, 0.3, 1.0);
  }
  // Blood near the camera also hits the lens. Returns 0..1 (0 = far or behind).
  function nearCam(p, radius) {
    const cam = core.camera; cam.getWorldPosition(tv3);
    const d = tv3.distanceTo(p); if (d > radius) return 0;
    cam.getWorldDirection(tn); tv3.subVectors(p, tv3).normalize();
    return tn.dot(tv3) > 0.1 ? 1 - d / radius : 0;
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  G.init = function (c) {
    core = c; scene = c.scene; hi = c.quality !== 'low'; Q = hi ? 1 : 0.4;
    initDroplets(); initDecals(); initBodies(); initScreen(); estimateLight();
    ready = true;
  };

  G.update = function (dt) {
    if (!ready) return;
    const t0 = performance.now();
    decalBudget = hi ? 10 : 5;
    if ((lightT -= dt) <= 0) { lightT = 0.5; estimateLight(); }
    updateEmitters(dt);
    updateBodies(dt);
    updateDroplets(dt);
    G.stats.decals = updateDecals(dt);
    updateScreen(dt);
    G.blade = Math.max(0, G.blade - dt / 40); G.hands = Math.max(0, G.hands - dt / 40);
    G.bladeWet *= Math.exp(-dt / 8); G.handsWet *= Math.exp(-dt / 8);
    G.stats.drops = dN;
    const ms = performance.now() - t0; G.stats.ms = G.stats.ms * 0.9 + ms * 0.1; G.stats.peak = Math.max(G.stats.peak * 0.998, ms);
  };

  // spray(point, dir, amount, opts?) opts: {pulses, duration, attach: Object3D, screen:false}
  G.spray = function (point, dir, amount, opts) {
    if (!ready || !point) return;
    const a = clamp(amount == null ? 1 : amount, 0.05, 4);
    tv2.copy(dir && dir.lengthSq() > 1e-6 ? dir : UP).normalize();
    jet(point.x, point.y, point.z, tv2.x, tv2.y, tv2.z, Math.round(a * 150 * Q), 2 + a, 6 + a * 2.5, 0.16, 1, 0.1);
    if (opts && opts.pulses) {
      const e = em.find(q => !q.on) || em[0], ob = opts.attach && opts.attach.isObject3D ? opts.attach : null;
      e.on = true; e.t = 0; e.acc = 0; e.amt = a; e.dur = clamp(opts.duration || 0.4 * opts.pulses, 0.6, 2.5); e.rate = opts.pulses / e.dur; e.obj = ob;
      if (ob) { ob.updateWorldMatrix(true, false); tm2.copy(ob.matrixWorld).invert(); e.lp.copy(point).applyMatrix4(tm2); e.ld.copy(tv2).transformDirection(tm2); }
      else { e.lp.copy(point); e.ld.copy(tv2); }
    }
    if (!opts || opts.screen !== false) {
      const k = nearCam(point, 3.2);
      if (k > 0) { core.camera.getWorldPosition(tv3); tv3.sub(point).normalize(); if (tv3.dot(tv2) > -0.2) G.screen(a * 0.6 * k); }
    }
  };

  G.burst = function (point, amount, opts) {
    if (!ready || !point) return;
    const a = clamp(amount == null ? 1 : amount, 0.05, 5), n = Math.round(a * 220 * Q);
    for (let k = 0; k < n; k++) {
      randDir(tv); tv.y = Math.abs(tv.y) * 0.9 + 0.25; tv.normalize();
      const big = rnd() < 0.08, s = rr(1, 5.5) * (0.6 + 0.4 * Math.min(a, 2)) * (big ? 0.7 : 1);
      drop(point.x, point.y, point.z, tv.x * s, tv.y * s, tv.z * s, big ? rr(0.022, 0.04) : rr(0.006, 0.018), rnd(), rr(3, 5), big || rnd() < 0.06);
    }
    if (!opts || opts.screen !== false) { const k = nearCam(point, 3); if (k > 0) G.screen(a * 0.35 * k); }
  };

  // pool(x, z, size, delay?)
  G.pool = function (x, z, size, delay) {
    if (!ready) return;
    addDecal(x, z, clamp(size == null ? 1.2 : size, 0.2, 6), pick(POOL_TILES), rnd() * 6.283, rr(2.6, 3.4), delay || 0, true);
  };

  // splat(x, z, size, dirYaw?) extra: an instant ground splat decal
  G.splat = function (x, z, size, yaw) {
    if (!ready) return;
    addDecal(x, z, clamp(size || 0.6, 0.1, 5), yaw == null ? pick(STAR_TILES) : 6 + ((rnd() * 2) | 0), yaw == null ? rnd() * 6.283 : yaw, 0.08, 0, false);
  };

  // chunk(mesh, point, velocity, spin, opts?) opts: {life: 60, dispose: false, pool: size}
  G.chunk = function (mesh, point, velocity, spin, opts) {
    if (!ready || !mesh || !mesh.isObject3D) return null;
    let b = chunkB.find(q => q.on && q.obj === mesh) || chunkB.find(q => !q.on);
    if (!b) { b = chunkB[0]; for (const q of chunkB) if (q.age > b.age) b = q; }
    if (b.on && b.obj !== mesh) releaseChunk(b);
    // world transform: re-parent to the scene and keep the pose
    if (mesh.parent && mesh.parent !== scene) {
      mesh.updateWorldMatrix(true, false); mesh.matrixWorld.decompose(tv, tq, ts);
      scene.add(mesh); mesh.position.copy(tv); mesh.quaternion.copy(tq); mesh.scale.copy(ts);
    } else {
      if (point && mesh.position.lengthSq() === 0) mesh.position.copy(point);
      if (!mesh.parent) scene.add(mesh);
    }
    mesh.matrixAutoUpdate = true; mesh.visible = true;
    // local bounds (object space, scaled)
    tv.copy(mesh.position); tq.copy(mesh.quaternion); ts.copy(mesh.scale);
    mesh.position.set(0, 0, 0); mesh.quaternion.identity(); mesh.scale.set(1, 1, 1); mesh.updateMatrixWorld(true);
    box.setFromObject(mesh);
    mesh.position.copy(tv); mesh.quaternion.copy(tq); mesh.scale.copy(ts); mesh.updateMatrixWorld(true);
    if (box.isEmpty()) box.set(tv2.set(-0.1, -0.1, -0.1), tv3.set(0.1, 0.1, 0.1));
    box.getCenter(b.c).multiply(ts); box.getSize(b.he).multiply(ts).multiplyScalar(0.5);
    b.he.set(Math.max(0.03, Math.abs(b.he.x)), Math.max(0.03, Math.abs(b.he.y)), Math.max(0.03, Math.abs(b.he.z)));
    tv2.copy(b.c).applyQuaternion(tq).add(tv);
    launch(b, tv2.x, tv2.y, tv2.z, velocity, spin);
    b.q.copy(tq);
    // stump = where it was cut (local, relative to the body centre)
    if (point && point.isVector3) b.sc.copy(point).sub(tv2).applyQuaternion(tq2.copy(tq).invert()).clampLength(0, Math.max(b.he.x, b.he.y, b.he.z) * 1.2);
    else b.sc.set(0, 0, 0);
    b.obj = mesh; b.mesh = null; b.dispose = !!(opts && opts.dispose);
    b.life = (opts && opts.life) || 60; b.bleed = 80 * Q; b.bleedDur = 3.5;
    b.pool = opts && opts.pool != null ? opts.pool : clamp(Math.max(b.he.x, b.he.y, b.he.z) * 3, 0.45, 1.8);
    // an initial splash from the cut end
    tv3.copy(b.sc).applyQuaternion(b.q).add(b.P);
    jet(tv3.x, tv3.y, tv3.z, b.v.x * 0.1, 1, b.v.z * 0.1, Math.round(30 * Q), 1, 3.5, 0.8, 1, 0.1);
    return mesh;
  };

  const gibAway = new T.Vector3();
  const MEATC = [0x4a0606, 0x6a0c0c, 0x8a1814, 0x9c2820, 0xc0606a, 0xd09486, 0x5a0c1a], BONEC = [0xe0d6b8, 0xcfc3a0, 0xbfae8a];
  function gibPiece(arr, mesh, bone, head, point, sc, colHex, sx, sy, sz, life) {
    const b = arr[head];
    launch(b, point.x + rr(-0.25, 0.25) * sc, point.y + rr(-0.2, 0.35) * sc, point.z + rr(-0.25, 0.25) * sc, null, rr(8, 22));
    randDir(tv); tv.y = Math.abs(tv.y) * 1.2 + 0.35; tv.normalize();
    b.v.copy(tv).multiplyScalar(rr(1.5, 5.5) * Math.sqrt(sc)).addScaledVector(gibAway, rr(0.5, 2.5)); b.v.y += rr(1.2, 3.5);
    b.q.setFromEuler(teul.set(rnd() * 6.3, rnd() * 6.3, rnd() * 6.3));
    b.scl.set(sx, sy, sz);
    if (bone) b.he.copy(boneHE).multiply(b.scl); else b.he.set(sx * 0.85, sy * 0.75, sz * 0.85);
    b.sc.set(0, 0, 0); b.life = life; b.bleed = (bone ? 8 : 20) * Q; b.bleedDur = rr(1.2, 2.2);
    b.pool = rnd() < 0.35 ? rr(0.25, 0.55) * sc : 0;
    mesh.setColorAt(b.idx, tcol.set(colHex).multiplyScalar(rr(0.85, 1.1)));
    return b;
  }
  // gib(point, color, count, opts?) opts: {scale: 1, screen: true}
  G.gib = function (point, color, count, opts) {
    if (!ready || !point) return;
    const sc = clamp((opts && opts.scale) || 1, 0.4, 4), life = 50;
    let n = clamp(Math.round(count || 20), 12, 30); if (!hi) n = Math.round(n * 0.6);
    const hide = color == null ? 0x7a1010 : color;
    const nBone = Math.max(2, Math.round(n * 0.22));
    core.camera.getWorldPosition(gibAway); gibAway.subVectors(point, gibAway); gibAway.y = 0;
    if (opts && opts.dir && opts.dir.isVector3) gibAway.copy(opts.dir); gibAway.y = 0; if (gibAway.lengthSq() > 1e-6) gibAway.normalize();
    // skull-ish lump + bone shards and ribs
    let s = 0.15 * sc;
    gibPiece(meatB, meatMesh, false, meatHead, point, sc, BONEC[0], s * 1.05, s * 1.15, s * 1.25, life); meatHead = (meatHead + 1) % MEAT;
    for (let i = 0; i < nBone; i++) {
      const rib = rnd() < 0.6, L = (rib ? rr(0.28, 0.42) : rr(0.12, 0.3)) * sc, th = rib ? rr(0.5, 0.8) : rr(0.8, 1.4);
      gibPiece(boneB, boneMesh, true, boneHead, point, sc, pick(BONEC), L, L * th * (rib ? 1 : 0.5), L * th * (rib ? 1 : 0.5), life); boneHead = (boneHead + 1) % BONE;
    }
    for (let i = nBone + 1; i < n; i++) {
      const r = rnd(); s = rr(0.07, 0.17) * sc;
      let c = pick(MEATC), sx = s * rr(0.7, 1.4), sy = s * rr(0.6, 1.3), sz = s * rr(0.7, 1.4);
      if (r < 0.25) c = hide;                                          // hide / skin flap
      else if (r < 0.4) { c = pick([0xb0505a, 0xc0707a, 0x9a4450]); sx = s * rr(2, 3.2); sy = sz = s * 0.45; }   // gut rope
      gibPiece(meatB, meatMesh, false, meatHead, point, sc, c, sx, sy, sz, life); meatHead = (meatHead + 1) % MEAT;
    }
    meatMesh.instanceColor.needsUpdate = true; boneMesh.instanceColor.needsUpdate = true;
    // the blood: huge burst, upward jets, delayed pools, a central star splat
    G.burst(point, 2.6 * sc, { screen: false });
    for (let i = 0; i < 4; i++) { randDir(tv2); tv2.y = Math.abs(tv2.y) + 0.8; tv2.normalize(); jet(point.x, point.y, point.z, tv2.x, tv2.y, tv2.z, Math.round(60 * Q * sc), 3, 9, 0.2, 1.2, 0.1); }
    addDecal(point.x, point.z, 2.6 * sc, pick(STAR_TILES), rnd() * 6.283, 0.12, 0.28, false);
    const np = 3 + ((rnd() * 3) | 0);
    for (let i = 0; i < np; i++) {
      const a = rnd() * 6.283, d = (i === 0 ? 0 : rr(0.6, 2.4)) * sc;
      addDecal(point.x + Math.cos(a) * d, point.z + Math.sin(a) * d, (i === 0 ? rr(1.6, 2.2) : rr(0.6, 1.4)) * sc, pick(POOL_TILES), rnd() * 6.283, rr(2.6, 3.6), rr(0.35, 1.0), true);
    }
    if (!opts || opts.screen !== false) { const k = nearCam(point, 6); if (k > 0) G.screen(Math.min(2, 1.6 * k + 0.2)); }
  };

  G.bladeBlood = function (amount) {
    const a = clamp(amount == null ? 0.25 : amount, 0, 1);
    G.blade = Math.min(1, G.blade + a); G.hands = Math.min(1, G.hands + a * 0.5);
    G.bladeWet = 1; if (a > 0.1) G.handsWet = Math.max(G.handsWet, 0.6);
  };

  G.screen = function (amount) {
    if (!ready) return;
    const a = clamp(amount == null ? 0.5 : amount, 0, 2);
    const big = Math.round(a * 4 + (rnd() < a % 1 ? 1 : 0)), small = Math.round(a * 6), fan = a > 0.35 ? 1 + (a > 1.2 ? 1 : 0) : 0, streak = a > 0.7 && rnd() < 0.7 ? 1 : 0;
    for (let i = 0; i < big; i++) addSplat(SPR[3 + ((rnd() * (a >= 1 ? 6 : 4)) | 0)], 0.64);
    for (let i = 0; i < small; i++) addSplat(SPR[(rnd() * 4) | 0], 0.5);
    for (let i = 0; i < fan; i++) addSplat(SPR[9 + ((rnd() * 3) | 0)], 0.6);
    for (let i = 0; i < streak; i++) addSplat(SPR[12 + ((rnd() * 3) | 0)], 0.62);
  };

  G.drawScreen = function (ctx) {
    if (!ready) return;
    const ga = ctx.globalAlpha;
    for (const s of sp) {
      if (!s.on) continue;
      const u = s.age / s.life, a = u < 0.6 ? 1 : 1 - (u - 0.6) / 0.4, k = Math.min(1, u * 1.35);
      if (k < 1) { ctx.globalAlpha = a * (1 - k); ctx.drawImage(s.s.fresh, s.x, s.y); }
      if (k > 0) { ctx.globalAlpha = a * k; ctx.drawImage(s.s.dark, s.x, s.y); }
      ctx.globalAlpha = a * 0.92; ctx.fillStyle = DRIPC[Math.round(k * 8)];
      for (let j = 0; j < s.nd; j++) {
        const d = s.dr[j], L = d.len | 0; if (L < 1) continue;
        ctx.fillRect(d.x, d.y, d.w, L);
        ctx.fillRect(d.x - (d.w === 1 ? 0 : 1), d.y + L, d.w + (d.w === 1 ? 1 : 2), 2);   // bead at the tip
      }
      if (k < 0.7) { ctx.globalAlpha = a * (1 - k); ctx.fillStyle = '#ff8a70'; for (let j = 0; j < s.nd; j++) { const d = s.dr[j]; if (d.len >= 2) ctx.fillRect(d.x, d.y + (d.len | 0), 1, 1); } }
    }
    ctx.globalAlpha = ga;
  };

  // clear() extra: wipe all gore (new game / respawn)
  G.clear = function () {
    if (!ready) return;
    dN = 0; dGeo.instanceCount = 0;
    tm.makeScale(0, 0, 0);
    dc.forEach((d, i) => { d.on = false; decMesh.setMatrixAt(i, tm); }); decMesh.instanceMatrix.needsUpdate = true;
    chunkB.forEach(b => { if (b.on) releaseChunk(b); });
    meatB.forEach(b => { b.on = false; meatMesh.setMatrixAt(b.idx, tm); }); boneB.forEach(b => { b.on = false; boneMesh.setMatrixAt(b.idx, tm); });
    meatMesh.instanceMatrix.needsUpdate = boneMesh.instanceMatrix.needsUpdate = true;
    em.forEach(e => { e.on = false; }); sp.forEach(s => { s.on = false; });
    G.blade = G.hands = G.bladeWet = G.handsWet = 0;
  };
})();
