// ─── CORE: renderer, post pass, states, integration ──────────────────────────
(function () {
  const C = CT.config, T = THREE, bus = CT.bus;
  const MODS = ['audio', 'world', 'sky', 'gore', 'monsters', 'life', 'npcs', 'rpg', 'player', 'controls', 'ui'];
  CT._broken = {};
  const has = (m, fn) => CT[m] && typeof CT[m][fn] === 'function' && !CT._broken[m];
  // A crash inside one module disables that module instead of stopping the game.
  MODS.forEach(m => {
    const mod = CT[m]; if (!mod) return;
    Object.keys(mod).forEach(k => {
      const f = mod[k]; if (typeof f !== 'function') return;
      mod[k] = function () {
        try { return f.apply(mod, arguments); }
        catch (e) { console.error(`[CT.${m}.${k}]`, e); CT._broken[m] = true; }
      };
    });
  });
  const call = (m, fn, ...a) => (has(m, fn) ? CT[m][fn](...a) : undefined);

  // ── DOM ────────────────────────────────────────────────────────────────────
  const stage = document.getElementById('stage');
  const glCanvas = document.getElementById('gl'), pxCanvas = document.getElementById('px'), uiCanvas = document.getElementById('ui');
  pxCanvas.width = C.PIX_W; pxCanvas.height = C.PIX_H; uiCanvas.width = C.UI_W; uiCanvas.height = C.UI_H;
  const pxCtx = pxCanvas.getContext('2d'), uiCtx = uiCanvas.getContext('2d');
  pxCtx.imageSmoothingEnabled = false;
  function fit() {
    const ww = window.innerWidth, wh = window.innerHeight, s = Math.min(ww / 16, wh / 9);
    const w = Math.floor(s * 16), h = Math.floor(s * 9);
    Object.assign(stage.style, { width: w + 'px', height: h + 'px', left: Math.floor((ww - w) / 2) + 'px', top: Math.floor((wh - h) / 2) + 'px' });
  }
  window.addEventListener('resize', fit); fit();

  // ── Renderer + Frazetta pixel post pass ────────────────────────────────────
  const isTouch = window.matchMedia('(pointer: coarse)').matches; // primary pointer only, so touch laptops keep mouse look
  const renderer = new T.WebGLRenderer({ canvas: glCanvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1); renderer.setSize(C.PIX_W, C.PIX_H, false);
  renderer.outputColorSpace = T.LinearSRGBColorSpace;
  const rt = new T.WebGLRenderTarget(C.PIX_W, C.PIX_H, { minFilter: T.NearestFilter, magFilter: T.NearestFilter, type: T.HalfFloatType });
  const postScene = new T.Scene(), postCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const postMat = new T.ShaderMaterial({
    uniforms: { tDiffuse: { value: rt.texture }, uFade: { value: 0 }, uHurt: { value: 0 }, uLow: { value: 0 }, uTime: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `
      uniform sampler2D tDiffuse; uniform float uFade, uHurt, uLow, uTime; varying vec2 vUv;
      float bayer(vec2 p){ int x=int(mod(p.x,4.0)), y=int(mod(p.y,4.0)); int i=x+y*4;
        float m[16]=float[16](0.,8.,2.,10.,12.,4.,14.,6.,3.,11.,1.,9.,15.,7.,13.,5.);
        for(int k=0;k<16;k++) if(k==i) return m[k]/16.0-0.5; return 0.0; }
      vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0); }
      void main(){
        vec3 c = texture2D(tDiffuse, vUv).rgb;
        c = aces(c * 1.1);
        c = pow(c, vec3(1.0/2.2));
        // Frazetta grade: warm, crushed shadows; rich reds; muted greens
        float l = dot(c, vec3(0.299,0.587,0.114));
        c *= mix(vec3(1.06,0.90,0.88), vec3(1.02,0.99,0.94), smoothstep(0.0, 0.7, l)); // warm shadows, gentle amber highlights
        c = mix(vec3(l), c, 1.22);                                                      // rich, painterly saturation
        vec2 d = vUv - 0.5; float v = dot(d, d);
        c *= 1.0 - v * 0.9;
        // low health: pulsing red edges + desaturation
        float pulse = 0.6 + 0.4 * sin(uTime * 6.0);
        c = mix(c, vec3(dot(c, vec3(0.33))) * vec3(1.0,0.6,0.55), uLow * 0.45);
        c = mix(c, vec3(0.55,0.0,0.02), clamp(v * 3.2 * (uHurt + uLow * 0.5 * pulse), 0.0, 0.85));
        c += bayer(gl_FragCoord.xy) / 18.0;
        c = floor(c * 18.0 + 0.5) / 18.0;
        gl_FragColor = vec4(c * uFade, 1.0);
      }`,
    depthTest: false, depthWrite: false,
  });
  postScene.add(new T.Mesh(new T.PlaneGeometry(2, 2), postMat));

  // ── Scene, camera, torch ───────────────────────────────────────────────────
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(70, 16 / 9, 0.1, 1200);
  camera.rotation.order = 'YXZ';
  scene.add(camera);
  const torchLight = new T.PointLight(0xff9a40, 0, 22, 1.5);
  torchLight.position.set(-0.4, -0.2, -0.5); camera.add(torchLight);

  const core = CT.core = {
    THREE: T, scene, camera, renderer, time: 0, dt: 0, state: 'GATE', input: null,
    hurtFlash: 0, isTouch, quality: isTouch ? 'low' : 'high', torchLight,
    shake(amount, seconds) { S.shakeA = Math.max(S.shakeA, amount); S.shakeT = Math.max(S.shakeT, seconds || 0.25); },
    hitStop(seconds) { S.stopT = Math.max(S.stopT, Math.min(0.12, seconds)); },
  };
  const S = { shakeA: 0, shakeT: 0, stopT: 0, fade: 0, fadeTarget: 1, notes: [], dialogNpc: null, music: null, deathT: 0, lastPosSave: 0, titleT: 0, bossSeen: false };
  const NEUTRAL = { moveX: 0, moveY: 0, lookDX: 0, lookDY: 0, sprint: false, jump: false, attack: false, heavy: 0, heavyRelease: false, block: false, dodge: false, interact: false, torch: false, inventory: false, map: false, pause: false, usePotion: false };
  core.input = NEUTRAL;

  // ── Init modules (each tolerates the others missing) ───────────────────────
  if (has('world', 'init')) CT.world.init(core);
  else { const g = new T.Mesh(new T.PlaneGeometry(3200, 3200), new T.MeshLambertMaterial({ color: 0x4a5a2a })); g.rotation.x = -Math.PI / 2; scene.add(g); }
  if (has('sky', 'init')) CT.sky.init(core);
  else { scene.background = new T.Color(0x2a1420); scene.fog = new T.Fog(0x5a3030, 40, 300); scene.add(new T.HemisphereLight(0xffb080, 0x201010, 1.4)); const sun = new T.DirectionalLight(0xffa060, 1.5); sun.position.set(-50, 40, -80); scene.add(sun); }
  ['gore', 'monsters', 'life', 'npcs', 'rpg', 'player', 'controls'].forEach(m => call(m, 'init', core));
  // Generic interactables (chests, shrines, travellers): {x, z, radius, label, onUse()}. Any module may add or remove.
  CT.interactables = {
    list: [],
    add(o) { this.list.push(o); return o; },
    remove(o) { const i = this.list.indexOf(o); if (i >= 0) this.list.splice(i, 1); },
    nearest(pos) {
      let best = null, bd = 1e9;
      for (const o of this.list) { if (o.disabled) continue; const d = Math.hypot(o.x - pos.x, o.z - pos.z); if (d < (o.radius || 2.5) && d < bd) { bd = d; best = o; } }
      return best;
    },
  };
  const heightAt = (x, z) => (has('world', 'heightAt') ? CT.world.heightAt(x, z) : 0);

  // ── Save helpers (rpg owns stats; core stores the player position) ─────────
  const POS_KEY = 'crimsonThrone.pos';
  function savePos() {
    const p = CT.player; if (!p || !p.pos) return;
    try { localStorage.setItem(POS_KEY, JSON.stringify({ x: p.pos.x, z: p.pos.z, yaw: p.yaw })); } catch (e) {}
  }
  function loadPos() { try { return JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch (e) { return null; } }
  const saveExists = () => { try { return !!localStorage.getItem('crimsonThrone.save'); } catch (e) { return false; } };

  // ── States ─────────────────────────────────────────────────────────────────
  function setState(s) {
    core.state = s;
    if (s !== 'PLAY') call('controls', 'unlock');
  }
  function music(name) { if (S.music !== name) { S.music = name; call('audio', 'setMusic', name); } }

  function newGame() {
    // A fresh page gives every module a clean state (garrisons, uniques, gore, found places).
    if (S.started) {
      try { ['crimsonThrone.save', POS_KEY, 'crimsonThrone.pois', 'crimsonThrone.rest'].forEach(k => localStorage.removeItem(k)); sessionStorage.setItem('crimsonThrone.autostart', 'new'); } catch (e) {}
      location.reload(); return;
    }
    S.started = true;
    call('rpg', 'reset');
    try { ['crimsonThrone.save', POS_KEY, 'crimsonThrone.pois', 'crimsonThrone.rest'].forEach(k => localStorage.removeItem(k)); } catch (e) {}
    if (CT.world && CT.world.pois) CT.world.pois.forEach(o => { o.found = false; });
    placePlayer(C.START.x, C.START.z, 0);
    enterPlay();
    notify('You wash ashore on the cursed isle of Vael.', 'story');
  }
  function continueGame() {
    S.started = true;
    call('rpg', 'load');
    const p = loadPos();
    if (p) placePlayer(p.x, p.z, p.yaw || 0); else placePlayer(C.START.x, C.START.z, 0);
    enterPlay();
  }
  function placePlayer(x, z, yaw) {
    const p = CT.player;
    if (p && p.pos) { p.pos.set(x, heightAt(x, z) + 0.05, z); p.yaw = yaw; p.pitch = 0; if (p.vel) p.vel.set(0, 0, 0); p.hp = p.hp > 0 ? p.hp : (CT.rpg && CT.rpg.stats ? CT.rpg.stats.hpMax : 100); p.alive = true; }
    else { camera.position.set(x, heightAt(x, z) + C.PLAYER.eye, z); camera.rotation.set(0, yaw, 0); }
  }
  function enterPlay() { S.fade = 0; S.fadeTarget = 1; setState('PLAY'); if (!isTouch) call('controls', 'lock'); }

  function notify(text, kind) { S.notes.push({ text, kind: kind || 'info', t: core.time }); if (S.notes.length > 6) S.notes.shift(); }
  bus.on('notify', d => notify(d.text, d.kind));
  bus.on('loot', d => { const it = C.ITEMS[d.item]; if (it) notify(`${it.name}${d.count > 1 ? ' x' + d.count : ''}`, 'loot'); });
  bus.on('levelUp', d => { notify(`LEVEL ${d.level}`, 'level'); call('audio', 'sfx', 'levelup'); });
  bus.on('poi', d => { notify(`DISCOVERED: ${d.name}`, 'discover'); call('audio', 'sfx', 'discover'); });
  bus.on('quest', d => { if (d.text) notify(d.text, 'quest'); });
  bus.on('dialog', d => { if (core.state !== 'PLAY') return; S.dialogNpc = d.npc; setState('DIALOG'); });
  bus.on('playerDeath', () => { S.deathT = core.time; music('death'); });
  bus.on('victory', () => { setState('VICTORY'); music('victory'); });

  function doAction(a) {
    if (!a) return false;
    call('audio', 'sfx', 'click');
    switch (a.type) {
      case 'gateYes': try { localStorage.setItem('crimsonThrone.gate', '1'); } catch (e) {} call('audio', 'init'); setState('TITLE'); music('title'); break;
      case 'gateNo': location.href = 'https://games.johnslagboom.com/'; break;
      case 'newGame': call('audio', 'init'); newGame(); break;
      case 'continue': call('audio', 'init'); continueGame(); break;
      case 'resume': case 'close':
        if (core.state === 'DIALOG') S.dialogNpc = null;
        enterPlay(); break;
      case 'equip': call('rpg', 'equip', a.id); break;
      case 'use': call('rpg', 'use', a.id); break;
      case 'choice': {
        const r = S.dialogNpc ? call('npcs', 'choose', S.dialogNpc, a.id) : 'close';
        if (r !== 'continue') { S.dialogNpc = null; enterPlay(); }
        break;
      }
      case 'respawn': call('player', 'respawn'); S.fade = 0; enterPlay(); break;
      case 'save': call('rpg', 'save'); savePos(); notify('Game saved', 'info'); break;
      case 'quitTitle': call('rpg', 'save'); savePos(); setState('TITLE'); music('title'); break;
      case 'setting': if (a.key === 'volume') call('audio', 'setVolume', a.value, a.value, a.value); break;
      default: return false;
    }
    return true;
  }

  // ── View for the UI ────────────────────────────────────────────────────────
  const tmpV = new T.Vector3();
  function view() {
    const p = CT.player || {}, r = CT.rpg || {};
    const yaw = p.yaw != null ? p.yaw : camera.rotation.y;
    const px = p.pos ? p.pos.x : camera.position.x, pz = p.pos ? p.pos.z : camera.position.z;
    const markers = [];
    const pois = (CT.world && CT.world.pois) || C.POIS;
    pois.forEach(o => {
      const dx = o.x - px, dz = o.z - pz, dist = Math.hypot(dx, dz);
      if (!o.found && dist > 400) return;
      markers.push({ name: o.found ? o.name : '?', angle: angleTo(yaw, dx, dz), dist, kind: o.found ? o.type : 'unknown' });
    });
    const q = has('rpg', 'activeQuest') ? CT.rpg.activeQuest() : null;
    if (q && q.target) { const dx = q.target.x - px, dz = q.target.z - pz; markers.push({ name: q.title, angle: angleTo(yaw, dx, dz), dist: Math.hypot(dx, dz), kind: 'quest' }); }
    let prompt = p.prompt || null;
    if (!prompt && core.state === 'PLAY' && p.pos && has('npcs', 'nearestInteractable')) {
      const n = CT.npcs.nearestInteractable(p.pos, 3.2);
      if (n) prompt = `${isTouch ? 'USE' : 'E'}  Talk to ${n.name}`;
    }
    if (!prompt && core.state === 'PLAY' && p.pos) { const o = CT.interactables.nearest(p.pos); if (o) prompt = `${isTouch ? 'USE' : 'E'}  ${o.label}`; }
    const dialog = core.state === 'DIALOG' && S.dialogNpc ? call('npcs', 'dialog', S.dialogNpc) : null;
    return {
      state: core.state, isTouch, hurt: core.hurtFlash, saveExists: saveExists(), time: core.time,
      player: { hp: p.hp || 0, hpMax: (r.stats && r.stats.hpMax) || C.PLAYER.hp, stamina: p.stamina || 0, staminaMax: (r.stats && r.stats.staminaMax) || C.PLAYER.stamina },
      rpg: { stats: r.stats, inventory: r.inventory, equipped: r.equipped, quests: r.quests, active: q },
      compass: { yaw, markers }, prompt, dialog, notifications: S.notes.filter(n => core.time - n.t < 6),
      map: { pois, player: { x: px, z: pz, yaw }, quest: q && q.target },
      boss: has('monsters', 'bossInfo') ? CT.monsters.bossInfo() : null,
      victory: core.state === 'VICTORY',
    };
  }
  function angleTo(yaw, dx, dz) {
    // camera forward is -Z rotated by yaw; returns -PI..PI, 0 = straight ahead, + = to the right
    const a = Math.atan2(dx, -dz) , f = -yaw; let d = a - f;
    while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  // ── Input glue (menus + clicks) ────────────────────────────────────────────
  window.addEventListener('keydown', e => {
    if (core.state === 'PLAY') return; // gameplay keys belong to controls
    const a = has('ui', 'key') ? CT.ui.key(e, view()) : null;
    if (a) { e.preventDefault(); doAction(a); return; }
    if (e.key === 'Escape' && (core.state === 'PAUSE' || core.state === 'INVENTORY' || core.state === 'MAP')) doAction({ type: 'resume' });
  });
  stage.addEventListener('pointerdown', e => {
    const r = uiCanvas.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width * C.UI_W, y = (e.clientY - r.top) / r.height * C.UI_H;
    const a = has('ui', 'hit') ? CT.ui.hit(x, y, view()) : null;
    if (doAction(a)) return;
    if (core.state === 'PLAY' && !isTouch && !(CT.controls && CT.controls.locked)) call('controls', 'lock');
  });
  stage.addEventListener('contextmenu', e => e.preventDefault());

  // ── Title flyover ──────────────────────────────────────────────────────────
  function titleCamera(t) {
    const a = t * 0.02, r = 260;
    const x = Math.sin(a) * r, z = 700 + Math.cos(a) * r * 0.6;
    camera.position.set(x, heightAt(x, z) + 45, z);
    camera.rotation.set(-0.1, Math.atan2(-(0 - x), -(-1250 - z)) + Math.PI, 0);
    camera.lookAt(0, 120, -1250);
  }

  // ── Loop ───────────────────────────────────────────────────────────────────
  let last = performance.now();
  function frame(now) {
    const realDt = Math.min(0.05, (now - last) / 1000); last = now;
    core.time += realDt;
    S.stopT = Math.max(0, S.stopT - realDt);
    const dt = S.stopT > 0 ? 0 : realDt;
    core.dt = dt;

    if (has('controls', 'update')) { CT.controls.update(realDt, core); core.input = core.state === 'PLAY' && CT.controls.state ? CT.controls.state : NEUTRAL; }
    const inp = core.input;

    const dead = CT.player && CT.player.alive === false;
    if (dead && core.state !== 'DEAD' && core.state !== 'TITLE' && core.state !== 'GATE' && core.state !== 'VICTORY' && core.time - S.deathT > 1.6) setState('DEAD');
    if (core.state === 'PLAY' && !dead) {
      if (inp.pause || (!isTouch && CT.controls && CT.controls.lostLock)) { setState('PAUSE'); }
      else if (inp.inventory) setState('INVENTORY');
      else if (inp.map) setState('MAP');
      else if (inp.interact && CT.player && CT.player.pos && has('npcs', 'nearestInteractable')) {
        const n = CT.npcs.nearestInteractable(CT.player.pos, 3.2); if (n) CT.npcs.interact(n);
        else { const o = CT.interactables.nearest(CT.player.pos); if (o) { try { o.onUse(o); } catch (e) { console.error('[CT.interactables]', e); } } }
      }
    }

    const simulate = core.state === 'PLAY' || core.state === 'DEAD';
    if (simulate) {
      ['player', 'monsters', 'life', 'npcs', 'gore', 'rpg'].forEach(m => call(m, 'update', dt, core));
      if (!CT.player || !has('player', 'update')) fallbackMove(dt, inp);
      if (core.time - S.lastPosSave > 10 && core.state === 'PLAY') { S.lastPosSave = core.time; savePos(); }
    } else if (core.state === 'TITLE' || core.state === 'GATE') {
      titleCamera(core.time);
    }
    call('world', 'update', realDt, core);
    call('sky', 'update', realDt, core);

    // camera shake (applied after the player sets the camera)
    if (S.shakeT > 0) {
      S.shakeT -= realDt; const k = S.shakeA * Math.max(0, S.shakeT) * 4;
      camera.rotation.x += (Math.random() - 0.5) * k * 0.05; camera.rotation.y += (Math.random() - 0.5) * k * 0.05;
      if (S.shakeT <= 0) S.shakeA = 0;
    }

    // music director
    if (core.state === 'PLAY') {
      const boss = has('monsters', 'bossInfo') && CT.monsters.bossInfo();
      const fight = CT.monsters && CT.monsters.inCombat;
      const night = has('sky', 'isNight') && CT.sky.isNight();
      music(boss ? 'boss' : fight ? 'combat' : night ? 'night' : 'explore');
    }

    // post
    core.hurtFlash = Math.max(0, core.hurtFlash - realDt * 1.6);
    const p = CT.player, hpMax = (CT.rpg && CT.rpg.stats && CT.rpg.stats.hpMax) || C.PLAYER.hp;
    postMat.uniforms.uHurt.value = core.hurtFlash;
    postMat.uniforms.uLow.value = p && p.alive !== false && p.hp < hpMax * 0.3 && simulate ? 1 - p.hp / (hpMax * 0.3) : 0;
    postMat.uniforms.uTime.value = core.time;
    if (core.state === 'DEAD') S.fadeTarget = 0.35;
    S.fade += (S.fadeTarget - S.fade) * Math.min(1, realDt * 2.5);
    if (core.state !== 'DEAD' && S.fadeTarget < 1) S.fadeTarget = 1;
    postMat.uniforms.uFade.value = S.fade;

    renderer.setRenderTarget(rt); renderer.render(scene, camera);
    renderer.setRenderTarget(null); renderer.render(postScene, postCam);

    pxCtx.clearRect(0, 0, C.PIX_W, C.PIX_H);
    if (simulate || core.state === 'PAUSE' || core.state === 'INVENTORY' || core.state === 'MAP' || core.state === 'DIALOG') {
      call('player', 'drawHands', pxCtx, core.time);
      call('gore', 'drawScreen', pxCtx, core.time);
    }
    uiCtx.clearRect(0, 0, C.UI_W, C.UI_H);
    const v = view();
    call('ui', 'draw', uiCtx, core.time, v);
    if (core.state === 'PLAY' && isTouch) call('controls', 'drawTouch', uiCtx, core.time);

    requestAnimationFrame(frame);
  }

  // Minimal free-look walker when the player module is missing.
  function fallbackMove(dt, inp) {
    camera.rotation.y -= inp.lookDX; camera.rotation.x = Math.max(-1.4, Math.min(1.4, camera.rotation.x - inp.lookDY));
    const s = (inp.sprint ? 8 : 4.5) * dt, yaw = camera.rotation.y;
    camera.position.x += (-Math.sin(yaw) * inp.moveY + Math.cos(yaw) * inp.moveX) * s;
    camera.position.z += (-Math.cos(yaw) * inp.moveY - Math.sin(yaw) * inp.moveX) * s;
    camera.position.y = heightAt(camera.position.x, camera.position.z) + C.PLAYER.eye;
  }

  // Start: skip the gate if it was accepted before on this device.
  try { if (localStorage.getItem('crimsonThrone.gate') === '1') core.state = 'TITLE'; } catch (e) {}
  try { if (sessionStorage.getItem('crimsonThrone.autostart') === 'new') { sessionStorage.removeItem('crimsonThrone.autostart'); setTimeout(() => { newGame(); music('explore'); }, 50); } } catch (e) {}
  S.fadeTarget = 1;
  requestAnimationFrame(frame);

  // ── Debug hooks ────────────────────────────────────────────────────────────
  const fwd = new T.Vector3();
  CT.debug = {
    play() { call('rpg', 'reset'); placePlayer(C.START.x, C.START.z, 0); S.fade = 1; setState('PLAY'); },
    tp(x, z) { placePlayer(x, z, CT.player ? CT.player.yaw || 0 : 0); },
    look(yaw, pitch) { if (CT.player) { CT.player.yaw = yaw; CT.player.pitch = pitch || 0; } else camera.rotation.set(pitch || 0, yaw, 0); },
    spawn(type, dist) {
      camera.getWorldDirection(fwd); const d = dist || 8;
      const x = camera.position.x + fwd.x * d, z = camera.position.z + fwd.z * d;
      return call('monsters', 'spawn', type || 'orc', x, z, { aggro: true });
    },
    god(on) { if (CT.player) CT.player.god = on !== false; },
    give(id, n) { call('rpg', 'give', id, n || 1); },
    time(t) { if (CT.sky) CT.sky.timeOfDay = t; },
    weather(name) { call('sky', 'setWeather', name, 0); },
    attack(heavy) { if (CT.controls && CT.controls.state) { if (heavy) { CT.controls._forceHeavy = true; } else CT.controls._forceAttack = true; } },
    state(name) { setState(name); },
    dialog(id) { const n = CT.npcs && CT.npcs.list && CT.npcs.list.find(x => x.id === id); if (n) { S.dialogNpc = n; setState('DIALOG'); } },
    notify, view, S,
  };
})();
