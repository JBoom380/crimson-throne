// ─── CONTROLS: keyboard + mouse (pointer lock), touch, gamepad -> CT.controls.state ──
(function () {
  const W = 1280, H = 720, TAU = Math.PI * 2;
  const LS_SENS = 'crimsonThrone.sens', LS_INV = 'crimsonThrone.invertY';
  const HEAVY_MOUSE = 0.22, HEAVY_TOUCH = 0.25, DTAP = 0.25, STICK_R = 110, DEAD = 0.15, TOUCH_SENS = 0.006;
  const PRESSED = ['jump', 'attack', 'heavyRelease', 'dodge', 'interact', 'torch', 'inventory', 'map', 'pause', 'usePotion', 'offhand1', 'offhand2', 'offhandCycle', 'fire', 'reload', 'camToggle', 'horn', 'vehExit'];
  const GAME_CODES = new Set(['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD',
    'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'KeyE', 'KeyT', 'KeyI', 'KeyM', 'KeyQ', 'KeyR', 'Escape', 'Digit1', 'Digit2', 'KeyV', 'KeyH']);
  const DIR_OF = { KeyW: 'u', ArrowUp: 'u', KeyS: 'd', ArrowDown: 'd', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r' };
  const now = () => performance.now() / 1000;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  const state = { moveX: 0, moveY: 0, lookDX: 0, lookDY: 0, sprint: false, jump: false, attack: false, heavy: 0, heavyRelease: false,
    block: false, dodge: false, interact: false, torch: false, inventory: false, map: false, pause: false, usePotion: false, offhand1: false, offhand2: false, offhandCycle: false, fire: false, reload: false,
    throttle: 0, brakeAxis: 0, handbrake: false, boost: false, camToggle: false, horn: false, vehExit: false };   // the last row drives the Iron Stallion (vehicle.js)
  const driving = () => !!(CT.vehicle && CT.vehicle.driving);
  const pend = {}; PRESSED.forEach(k => (pend[k] = false));
  let core = null, stage = null, uiCanvas = null;
  let sens = 0.0022, invertY = false, lockRefused = false, skipMove = 0, pendLost = false, wasLocked = false;
  const keys = new Set(), lastTap = {};
  let mdx = 0, mdy = 0, rmb = false;

  // ── Attack channels: tap = light (on release), hold past threshold = heavy ──
  const chan = thr => ({ thr, down: false, t0: 0, rel: -1 });
  const ch = { mouse: chan(HEAVY_MOUSE), touch: chan(HEAVY_TOUCH), pad: chan(HEAVY_MOUSE), force: chan(0.05) };
  const press = c => { if (!c.down) { c.down = true; c.t0 = now(); } };
  const release = c => { if (c.down) { c.down = false; c.rel = now() - c.t0; } };
  const resetChan = c => { c.down = false; c.rel = -1; };

  function loadSettings() {
    try {
      const s = parseFloat(localStorage.getItem(LS_SENS)); if (s > 0.0001 && s < 0.05) sens = s;
      invertY = localStorage.getItem(LS_INV) === '1' || localStorage.getItem(LS_INV) === 'true';
    } catch (e) {}
    M.sens = sens; M.invertY = invertY;
  }
  const inPlay = () => !!core && core.state === 'PLAY';
  const rifle = () => !!(CT.player && CT.player.rifle);   // the AR-15: LMB fires per click, R reloads (the potion stays on Q)

  // ── Keyboard ──
  function onKeyDown(e) {
    if (!inPlay()) return;
    const c = e.code;
    if (GAME_CODES.has(c)) e.preventDefault();
    if (e.repeat) return;
    keys.add(c);
    const d = DIR_OF[c];
    if (d) {
      const t = now();
      if (lastTap[d] && t - lastTap[d] < DTAP) { pend.dodge = true; lastTap[d] = 0; } else lastTap[d] = t;
    }
    switch (c) {
      case 'Space': pend.jump = true; break;
      case 'ControlLeft': case 'ControlRight': case 'AltLeft': case 'AltRight': pend.dodge = true; break;
      case 'KeyE': pend.interact = true; break;
      case 'KeyT': pend.torch = true; break;
      case 'Digit1': case 'Numpad1': pend.offhand1 = true; break;
      case 'Digit2': case 'Numpad2': pend.offhand2 = true; break;
      case 'Tab': case 'KeyI': pend.inventory = true; break;
      case 'KeyM': pend.map = true; break;
      case 'Escape': pend.pause = true; break;
      case 'KeyQ': pend.usePotion = true; break;
      case 'KeyR': if (rifle()) pend.reload = true; else pend.usePotion = true; break;
      case 'KeyV': pend.camToggle = true; break;
      case 'KeyH': pend.horn = true; break;
    }
  }
  function onKeyUp(e) { keys.delete(e.code); if (inPlay() && GAME_CODES.has(e.code)) e.preventDefault(); }

  // ── Mouse + pointer lock ──
  const mouseLive = () => M.locked || lockRefused || (core && core.isTouch);
  function onMouseDown(e) {
    if (!inPlay() || !mouseLive()) return;
    if (e.button === 0) { if (rifle()) pend.fire = true; else press(ch.mouse); } else if (e.button === 2) rmb = true;
  }
  function onMouseUp(e) { if (e.button === 0) release(ch.mouse); else if (e.button === 2) rmb = false; }
  function onMouseMove(e) {
    if (!inPlay() || !(M.locked || lockRefused)) return;
    let x = e.movementX || 0, y = e.movementY || 0;
    if (skipMove > 0) { skipMove--; return; }                 // first event after lock can jump
    if (Math.abs(x) > 400 || Math.abs(y) > 400) return;       // Chrome pointer-lock spike bug
    mdx += clamp(x, -160, 160); mdy += clamp(y, -160, 160);
  }
  function onLockChange() {
    const l = !!stage && document.pointerLockElement === stage;
    M.locked = l;
    if (l) { lockRefused = false; skipMove = 1; loadSettings(); }
    else if (wasLocked && inPlay()) pendLost = true;
    if (!l) { keys.clear(); rmb = false; resetChan(ch.mouse); }
    wasLocked = l;
  }
  function onLockError() { lockRefused = true; }

  // ── Touch layout (1280x720 UI space, scaled up a little on small screens) ──
  const BTN = [
    { id: 'attack', label: 'ATTACK', r: 75, kind: 'attack', ring: 0, ang: 0 },
    { id: 'block', label: 'BLOCK', r: 56, kind: 'hold', ring: 178, ang: 180 },
    { id: 'dodge', label: 'DODGE', r: 56, kind: 'press', key: 'dodge', ring: 178, ang: 226 },
    { id: 'jump', label: 'JUMP', r: 56, kind: 'press', key: 'jump', ring: 178, ang: 272 },
    { id: 'reload', label: 'RELOAD', r: 42, kind: 'press', key: 'reload', ring: 300, ang: 164 },
    { id: 'potion', label: 'DRAUGHT', r: 42, kind: 'press', key: 'usePotion', ring: 318, ang: 188 },
    { id: 'torch', label: 'TORCH', r: 42, kind: 'press', key: 'torch', ring: 318, ang: 262 },
    { id: 'offhand', label: 'SMOKE', r: 38, kind: 'press', key: 'offhandCycle', ring: 330, ang: 286 },
    { id: 'use', label: 'USE', r: 56, kind: 'press', key: 'interact', ring: 322, ang: 223 },
    { id: 'menu', label: 'MENU', r: 38, kind: 'press', key: 'pause', tl: 0 },
    { id: 'map', label: 'MAP', r: 38, kind: 'press', key: 'map', tl: 1 },
    { id: 'inv', label: 'PACK', r: 38, kind: 'press', key: 'inventory', tl: 2 },
    // Iron Stallion (vehicle.js): shown only while driving
    { id: 'hbrake', label: 'HANDBRAKE', r: 78, kind: 'hold', ring: 0, ang: 0, drive: true },
    { id: 'dexit', label: 'EXIT', r: 62, kind: 'press', key: 'vehExit', ring: 196, ang: 226, drive: true },
    { id: 'dboost', label: 'FLOOR IT', r: 54, kind: 'hold', ring: 186, ang: 170, drive: true },
    { id: 'dcam', label: 'VIEW', r: 40, kind: 'press', key: 'camToggle', ring: 196, ang: 278, drive: true },
    { id: 'dhorn', label: 'HORN', r: 40, kind: 'press', key: 'horn', ring: 330, ang: 200, drive: true },
  ];
  BTN.forEach(b => { b.x = 0; b.y = 0; b.rr = b.r; b.down = 0; b.flash = 0; });
  const B = {}; BTN.forEach(b => (B[b.id] = b));
  let kScale = 1, showUse = false, potions = -1;
  const stick = { id: null, bx: 0, by: 0, x: 0, y: 0, mx: 0, my: 0, sprint: false };
  const look = { id: null, lx: 0, ly: 0, x: 0, y: 0 };
  let debtX = 0, debtY = 0;
  const touches = new Map();   // identifier -> 'stick' | 'look' | button id

  function layout() {
    let s = 1;
    if (uiCanvas) { const r = uiCanvas.getBoundingClientRect(); if (r.width > 0) s = r.width / W; }
    kScale = clamp(0.62 / s, 1, 1.22);
    const k = kScale, ax = W - 150 * k, ay = H - 150 * k;
    BTN.forEach(b => {
      b.rr = b.r * (b.tl != null ? Math.min(k, 1.12) : k);
      if (b.tl != null) { b.x = 26 + b.rr + b.tl * (b.rr * 2 + 20); b.y = 118 + b.rr; } // top-left, under the HP frame
      else { const a = b.ang * Math.PI / 180; b.x = ax + Math.cos(a) * b.ring * k; b.y = ay + Math.sin(a) * b.ring * k; }
    });
  }
  const visible = b => (driving() ? !!b.drive || b.tl != null : !b.drive) && (b.id !== 'use' || showUse) && (b.id !== 'reload' || rifle());
  function toUI(cx, cy) {
    const r = uiCanvas ? uiCanvas.getBoundingClientRect() : { left: 0, top: 0, width: W, height: H };
    return { x: (cx - r.left) / r.width * W, y: (cy - r.top) / r.height * H, s: r.width / W };
  }
  function buttonAt(x, y) {
    let best = null, bd = 1e9;
    BTN.forEach(b => {
      if (!visible(b)) return;
      const d = Math.hypot(x - b.x, y - b.y);
      if (d < b.rr * 1.12 + 6 && d < bd) { best = b; bd = d; }
    });
    return best;
  }
  function buttonDown(b) {
    b.down++; b.flash = 0.18;
    if (b.kind === 'attack') { if (rifle()) pend.fire = true; else press(ch.touch); }
    else if (b.kind === 'press') pend[b.key] = true;
  }
  function buttonUp(b) {
    b.down = Math.max(0, b.down - 1);
    if (b.kind === 'attack' && !b.down) release(ch.touch);
  }
  function onTouchStart(e) {
    if (e.cancelable) e.preventDefault();
    if (!inPlay()) return;
    layout();
    for (const t of e.changedTouches) {
      const p = toUI(t.clientX, t.clientY), b = buttonAt(p.x, p.y);
      if (b) { touches.set(t.identifier, b.id); buttonDown(b); }
      else if (p.x < W * 0.4) {
        if (stick.id !== null) continue;
        stick.id = t.identifier; stick.bx = clamp(p.x, STICK_R * 0.6, W * 0.4); stick.by = clamp(p.y, STICK_R * 0.6 + 120, H - STICK_R * 0.6);
        stick.x = p.x; stick.y = p.y; touches.set(t.identifier, 'stick'); stickCalc();
      } else {
        if (look.id !== null) continue;
        look.id = t.identifier; look.lx = t.clientX; look.ly = t.clientY; look.x = p.x; look.y = p.y; touches.set(t.identifier, 'look');
      }
    }
  }
  function stickCalc() {
    let dx = stick.x - stick.bx, dy = stick.y - stick.by, len = Math.hypot(dx, dy);
    const R = STICK_R * kScale;
    if (len > R * 1.35) { const f = (len - R * 1.35) / len; stick.bx += dx * f; stick.by += dy * f; dx = stick.x - stick.bx; dy = stick.y - stick.by; len = Math.hypot(dx, dy); }
    const raw = Math.min(1, len / R), m = raw < DEAD ? 0 : (raw - DEAD) / (1 - DEAD);
    stick.mx = len > 0 ? dx / len * m : 0; stick.my = len > 0 ? -dy / len * m : 0; stick.sprint = raw > 0.9;
  }
  function onTouchMove(e) {
    if (e.cancelable) e.preventDefault();
    if (!inPlay()) return;
    for (const t of e.changedTouches) {
      const k = touches.get(t.identifier);
      if (k === 'stick') { const p = toUI(t.clientX, t.clientY); stick.x = p.x; stick.y = p.y; stickCalc(); }
      else if (k === 'look') {
        debtX += (t.clientX - look.lx) * TOUCH_SENS; debtY += (t.clientY - look.ly) * TOUCH_SENS * (invertY ? -1 : 1);
        look.lx = t.clientX; look.ly = t.clientY; const p = toUI(t.clientX, t.clientY); look.x = p.x; look.y = p.y;
      }
    }
  }
  function onTouchEnd(e) {
    if (e.cancelable) e.preventDefault();
    for (const t of e.changedTouches) {
      const k = touches.get(t.identifier); touches.delete(t.identifier);
      if (k === 'stick') { stick.id = null; stick.mx = stick.my = 0; stick.sprint = false; }
      else if (k === 'look') look.id = null;
      else if (k && B[k]) buttonUp(B[k]);
    }
  }
  function releaseTouches() {
    touches.clear(); stick.id = look.id = null; stick.mx = stick.my = 0; stick.sprint = false; debtX = debtY = 0;
    BTN.forEach(b => (b.down = 0)); resetChan(ch.touch);
  }

  // ── Gamepad (standard mapping) ──
  const padPrev = [];
  const pad = { mx: 0, my: 0, lx: 0, ly: 0, block: false, sprint: false, thr: 0, brk: 0, hand: false, boost: false };
  function dz(v) { const a = Math.abs(v); return a < DEAD ? 0 : Math.sign(v) * (a - DEAD) / (1 - DEAD); }
  function pollPad(dt, play) {
    pad.mx = pad.my = pad.lx = pad.ly = 0; pad.block = pad.sprint = false; pad.thr = pad.brk = 0; pad.hand = pad.boost = false;
    let gp = null;
    try { const l = navigator.getGamepads ? navigator.getGamepads() : []; for (const g of l) if (g && g.connected) { gp = g; break; } } catch (e) {}
    if (!gp) { if (ch.pad.down) resetChan(ch.pad); return; }
    const bt = i => !!(gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.5));
    const edge = i => bt(i) && !padPrev[i];
    if (play) {
      const ax = gp.axes;
      pad.mx = dz(ax[0] || 0); pad.my = -dz(ax[1] || 0);
      const rx = dz(ax[2] || 0), ry = dz(ax[3] || 0);
      pad.lx = Math.sign(rx) * rx * rx * 3.0 * dt; pad.ly = Math.sign(ry) * ry * ry * 2.4 * dt * (invertY ? -1 : 1);
      pad.block = bt(6); pad.sprint = bt(10) || bt(4) || Math.hypot(pad.mx, pad.my) > 0.97;
      if (rifle()) { if (edge(7)) pend.fire = true; if (ch.pad.down) resetChan(ch.pad); } else if (bt(7)) press(ch.pad); else release(ch.pad);
      if (edge(0)) pend.jump = true;
      if (edge(1)) pend.dodge = true;
      if (edge(2)) pend.interact = true;
      if (edge(3)) { if (rifle()) pend.reload = true; else pend.usePotion = true; }
      if (edge(5)) pend.torch = true;
      if (edge(14)) pend.offhand1 = true;
      if (edge(15)) pend.offhand2 = true;
      if (edge(9)) pend.pause = true;
      if (edge(8)) pend.map = true;
      if (edge(12)) pend.inventory = true;
      // Iron Stallion: RT/LT are analog throttle and brake, A the handbrake, LB floor it, RB the view, R3 the horn
      pad.thr = gp.buttons[7] ? +gp.buttons[7].value || 0 : 0; pad.brk = gp.buttons[6] ? +gp.buttons[6].value || 0 : 0; pad.hand = bt(0); pad.boost = bt(4);
      if (driving()) { if (edge(5)) pend.camToggle = true; if (edge(11)) pend.horn = true; }
    }
    for (let i = 0; i < gp.buttons.length; i++) padPrev[i] = bt(i);
  }

  // ── Frame update: pending events -> state (pressed flags last one frame) ──
  function neutral() {
    for (const k in state) state[k] = typeof state[k] === 'boolean' ? false : 0;
    PRESSED.forEach(k => (pend[k] = false));
    keys.clear(); rmb = false; mdx = mdy = 0; pendLost = false; M.lostLock = false;
    Object.values(ch).forEach(c => { if (c !== ch.force) resetChan(c); });
    releaseTouches();
  }
  const kd = (a, b) => keys.has(a) || keys.has(b);

  function update(dt, c) {
    if (c) core = c;
    dt = dt || 0.016;
    const play = inPlay();
    pollPad(dt, play);
    BTN.forEach(b => (b.flash = Math.max(0, b.flash - dt)));
    if (!play) { neutral(); return; }

    // debug hooks
    if (M._forceAttack) { M._forceAttack = false; pend.attack = true; }
    if (M._forceHeavy) { M._forceHeavy = false; resetChan(ch.force); press(ch.force); }
    if (ch.force.down && now() - ch.force.t0 >= 1.0) release(ch.force);

    // interactable (for the USE button) + potion count
    showUse = !!(CT.player && CT.player.prompt);
    if (!showUse && CT.npcs && typeof CT.npcs.nearestInteractable === 'function' && CT.player && CT.player.pos) showUse = !!CT.npcs.nearestInteractable(CT.player.pos, 3.2);
    if (!showUse && CT.interactables && CT.player && CT.player.pos) showUse = !!CT.interactables.nearest(CT.player.pos);
    potions = -1;
    if (CT.rpg && Array.isArray(CT.rpg.inventory)) {
      const I = (CT.config && CT.config.ITEMS) || {};
      potions = CT.rpg.inventory.reduce((n, it) => n + (it && I[it.id] && I[it.id].kind === 'potion' ? it.count || 0 : 0), 0);
    }

    // movement
    let mx = (kd('KeyD', 'ArrowRight') ? 1 : 0) - (kd('KeyA', 'ArrowLeft') ? 1 : 0);
    let my = (kd('KeyW', 'ArrowUp') ? 1 : 0) - (kd('KeyS', 'ArrowDown') ? 1 : 0);
    mx += stick.mx + pad.mx; my += stick.my + pad.my;
    const ml = Math.hypot(mx, my); if (ml > 1) { mx /= ml; my /= ml; }
    state.moveX = mx; state.moveY = my;
    state.sprint = kd('ShiftLeft', 'ShiftRight') || stick.sprint || pad.sprint;

    // look
    const sy = invertY ? -1 : 1;
    let lx = mdx * sens + pad.lx, ly = mdy * sens * sy + pad.ly;
    mdx = mdy = 0;
    const f = Math.min(1, dt * 26);
    const tx = debtX * f, ty = debtY * f; debtX -= tx; debtY -= ty;
    if (Math.abs(debtX) < 1e-5) debtX = 0; if (Math.abs(debtY) < 1e-5) debtY = 0;
    state.lookDX = clamp(lx + tx, -0.6, 0.6); state.lookDY = clamp(ly + ty, -0.6, 0.6);

    // attack / heavy
    let heavy = 0, atk = false, rel = false;
    for (const k in ch) {
      const cc = ch[k];
      if (cc.down) { const held = now() - cc.t0; if (held > cc.thr) heavy = Math.max(heavy, held); }
      if (cc.rel >= 0) { if (cc.rel < cc.thr) atk = true; else { rel = true; heavy = Math.max(heavy, cc.rel); } cc.rel = -1; }
    }
    PRESSED.forEach(k => { state[k] = pend[k]; pend[k] = false; });
    state.attack = state.attack || atk; state.heavyRelease = rel; state.heavy = heavy;
    state.block = rmb || pad.block || B.block.down > 0;
    M.lostLock = pendLost; pendLost = false;
    // Iron Stallion (vehicle.js): the driving inputs; while driving, E/USE leaves the car instead of talking or looting
    state.throttle = pad.thr; state.brakeAxis = pad.brk;
    state.handbrake = keys.has('Space') || pad.hand || B.hbrake.down > 0;
    state.boost = kd('ShiftLeft', 'ShiftRight') || pad.boost || B.dboost.down > 0 || (driving() && stick.sprint);
    if (driving()) { state.vehExit = state.vehExit || state.interact; state.interact = false; } else state.vehExit = false;
  }

  // ── Iron Stallion touch icons ──
  const DRIVE_ICONS = {
    hbrake(ctx) {
      ctx.fillStyle = '#2a2622'; ctx.fillRect(-7, -6, 14, 38); ctx.strokeStyle = INK; ctx.lineWidth = 2.5; ctx.strokeRect(-7, -6, 14, 38);
      ctx.save(); ctx.rotate(-0.35); ctx.fillStyle = BONE; ctx.beginPath(); ctx.moveTo(-6, 0); ctx.lineTo(-4, -34); ctx.quadraticCurveTo(0, -40, 4, -34); ctx.lineTo(6, 0); ctx.closePath(); ctx.fill(); stroke(ctx, 2.5);
      ctx.fillStyle = '#b8321a'; ctx.beginPath(); ctx.arc(0, -36, 5, 0, TAU); ctx.fill(); stroke(ctx, 2); ctx.restore();
      ctx.strokeStyle = BONE; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(0, 8, 30, 0.2 * Math.PI, 0.8 * Math.PI); ctx.stroke();
    },
    dexit(ctx) {
      ctx.fillStyle = '#3a3a40'; ctx.beginPath(); ctx.moveTo(-26, 26); ctx.lineTo(-26, -20); ctx.quadraticCurveTo(-26, -28, -12, -28); ctx.lineTo(10, -28); ctx.lineTo(10, 26); ctx.closePath(); ctx.fill(); stroke(ctx, 2.5);
      ctx.fillStyle = '#8ecae6'; ctx.fillRect(-20, -22, 24, 18); ctx.strokeRect(-20, -22, 24, 18);
      ctx.strokeStyle = BONE; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(4, 8); ctx.lineTo(32, 8); ctx.moveTo(24, -2); ctx.lineTo(34, 8); ctx.lineTo(24, 18); ctx.stroke();
    },
    dboost(ctx, t) {
      ctx.fillStyle = BONE;
      for (let i = 0; i < 3; i++) { const o = i * 13 - 16; ctx.beginPath(); ctx.moveTo(o - 8, -18); ctx.lineTo(o + 8, 0); ctx.lineTo(o - 8, 18); ctx.lineTo(o - 2, 18); ctx.lineTo(o + 14, 0); ctx.lineTo(o - 2, -18); ctx.closePath(); ctx.fill(); stroke(ctx, 2); }
      ctx.fillStyle = `rgba(255,${120 + 60 * Math.sin(t * 20)},40,0.9)`; ctx.beginPath(); ctx.arc(-30, 0, 6, 0, TAU); ctx.fill();
    },
    dcam(ctx) {
      ctx.fillStyle = BONE; ctx.beginPath(); ctx.ellipse(0, 0, 30, 18, 0, 0, TAU); ctx.fill(); stroke(ctx, 2.5);
      ctx.fillStyle = '#1a3a4a'; ctx.beginPath(); ctx.arc(0, 0, 11, 0, TAU); ctx.fill(); ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(0, 0, 5, 0, TAU); ctx.fill();
    },
    dhorn(ctx) {
      ctx.fillStyle = '#c9974f'; ctx.beginPath(); ctx.moveTo(-26, -8); ctx.lineTo(-10, -8); ctx.lineTo(18, -22); ctx.lineTo(18, 22); ctx.lineTo(-10, 8); ctx.lineTo(-26, 8); ctx.closePath(); ctx.fill(); stroke(ctx, 2.5);
      ctx.strokeStyle = BONE; ctx.lineWidth = 3; ctx.lineCap = 'round'; for (let i = 0; i < 2; i++) { ctx.beginPath(); ctx.arc(20, 0, 10 + i * 9, -0.7, 0.7); ctx.stroke(); }
    },
  };

  // ── Drawing helpers (bronze and iron) ──
  function bronze(ctx, x, y, r) {
    const g = ctx.createLinearGradient(x - r, y - r, x + r * 0.6, y + r);
    g.addColorStop(0, '#f6d58a'); g.addColorStop(0.35, '#b77a2e'); g.addColorStop(0.65, '#5b3411'); g.addColorStop(1, '#c98f45');
    return g;
  }
  function plate(ctx, b, t, on, glow) {
    const { x, y } = b, r = b.rr * (on ? 0.93 : 1);
    ctx.save();
    if (on || glow) { ctx.shadowColor = on ? 'rgba(255,110,40,0.95)' : 'rgba(255,170,60,0.8)'; ctx.shadowBlur = on ? 34 : 18 + 8 * Math.sin(t * 5); }
    let g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r);
    g.addColorStop(0, 'rgba(78,70,64,0.78)'); g.addColorStop(1, 'rgba(16,12,10,0.82)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = Math.max(3, r * 0.1); ctx.strokeStyle = bronze(ctx, x, y, r);
    ctx.beginPath(); ctx.arc(x, y, r * 0.86, 0, TAU); ctx.stroke();
    ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.beginPath(); ctx.arc(x, y, r - 0.75, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, r * 0.8, 0, TAU); ctx.stroke();
    g = ctx.createRadialGradient(x, y - r * 0.2, r * 0.05, x, y, r * 0.8);
    if (on) { g.addColorStop(0, 'rgba(190,40,20,0.85)'); g.addColorStop(1, 'rgba(70,6,4,0.85)'); }
    else { g.addColorStop(0, 'rgba(58,34,24,0.55)'); g.addColorStop(1, 'rgba(12,6,4,0.7)'); }
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 0.8 - 1, 0, TAU); ctx.fill();
    const n = r > 60 ? 12 : r > 45 ? 8 : 6;
    for (let i = 0; i < n; i++) {
      const a = i / n * TAU + Math.PI / n, px = x + Math.cos(a) * r * 0.93, py = y + Math.sin(a) * r * 0.93, rr = Math.max(1.6, r * 0.035);
      ctx.fillStyle = '#1a120c'; ctx.beginPath(); ctx.arc(px + 0.6, py + 0.8, rr, 0, TAU); ctx.fill();
      ctx.fillStyle = '#c7a372'; ctx.beginPath(); ctx.arc(px, py, rr, 0, TAU); ctx.fill();
    }
    ctx.restore();
    return r;
  }
  function label(ctx, text, x, y, size, col) {
    ctx.save();
    ctx.font = `bold ${size}px "Palatino Linotype", "Book Antiqua", Georgia, serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(8,4,2,0.85)'; ctx.strokeText(text, x, y);
    ctx.fillStyle = col || 'rgba(232,200,140,0.9)'; ctx.fillText(text, x, y);
    ctx.restore();
  }

  // ── Icons: drawn in a ±40 box, scaled to the button ──
  const INK = '#140906', BONE = '#eadcbc', STEEL = '#c9ced3';
  function stroke(ctx, w) { ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.lineWidth = w || 3; ctx.strokeStyle = INK; ctx.stroke(); }
  const ICON = {
    attack(ctx) {
      ctx.rotate(Math.PI / 4);
      ctx.beginPath(); ctx.moveTo(0, -40); ctx.lineTo(-6, -31); ctx.lineTo(-6, 12); ctx.lineTo(6, 12); ctx.lineTo(6, -31); ctx.closePath();
      const g = ctx.createLinearGradient(-6, 0, 6, 0); g.addColorStop(0, '#f2f4f5'); g.addColorStop(0.5, STEEL); g.addColorStop(1, '#6f757c');
      ctx.fillStyle = g; ctx.fill(); stroke(ctx, 3);
      ctx.fillStyle = '#9a0f0a'; ctx.beginPath(); ctx.moveTo(0, -40); ctx.lineTo(-6, -31); ctx.lineTo(-6, -20); ctx.quadraticCurveTo(-2, -16, 1, -22); ctx.lineTo(6, -31); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(60,60,70,0.7)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(0, -28); ctx.lineTo(0, 9); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-19, 11); ctx.quadraticCurveTo(-22, 17, -17, 19); ctx.lineTo(17, 19); ctx.quadraticCurveTo(22, 17, 19, 11); ctx.closePath();
      ctx.fillStyle = '#c48a3a'; ctx.fill(); stroke(ctx, 3);
      ctx.fillStyle = '#4a2a16'; ctx.fillRect(-4, 19, 8, 13); ctx.strokeRect(-4, 19, 8, 13);
      ctx.strokeStyle = '#2a160a'; ctx.lineWidth = 1.2; for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.moveTo(-4, 22 + i * 4); ctx.lineTo(4, 24 + i * 4); ctx.stroke(); }
      ctx.beginPath(); ctx.arc(0, 36, 5.5, 0, TAU); ctx.fillStyle = '#d9a24c'; ctx.fill(); stroke(ctx, 3);
    },
    block(ctx) {
      ctx.beginPath(); ctx.moveTo(-24, -28); ctx.quadraticCurveTo(0, -34, 24, -28); ctx.lineTo(24, -2); ctx.quadraticCurveTo(22, 22, 0, 34); ctx.quadraticCurveTo(-22, 22, -24, -2); ctx.closePath();
      const g = ctx.createLinearGradient(-24, -30, 24, 30); g.addColorStop(0, '#8a2a1c'); g.addColorStop(1, '#3a0c08');
      ctx.fillStyle = g; ctx.fill(); ctx.lineWidth = 6; ctx.strokeStyle = '#b98a4a'; ctx.stroke(); stroke(ctx, 2);
      ctx.fillStyle = '#c9974f'; ctx.fillRect(-3, -28, 6, 58); ctx.fillRect(-22, -6, 44, 6);
      ctx.beginPath(); ctx.arc(0, -3, 8, 0, TAU); ctx.fillStyle = '#e5c07a'; ctx.fill(); stroke(ctx, 2.5);
    },
    dodge(ctx) {
      ctx.fillStyle = BONE;
      for (let i = 0; i < 2; i++) {
        const o = i * 16 - 6;
        ctx.beginPath(); ctx.moveTo(o - 10, -20); ctx.lineTo(o + 8, 0); ctx.lineTo(o - 10, 20); ctx.lineTo(o - 2, 20); ctx.lineTo(o + 16, 0); ctx.lineTo(o - 2, -20); ctx.closePath();
        ctx.fill(); stroke(ctx, 2.5);
      }
      ctx.strokeStyle = 'rgba(234,220,188,0.75)'; ctx.lineWidth = 3; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-36, -8); ctx.lineTo(-22, -8); ctx.moveTo(-40, 0); ctx.lineTo(-20, 0); ctx.moveTo(-36, 8); ctx.lineTo(-22, 8); ctx.stroke();
    },
    jump(ctx) {
      ctx.fillStyle = BONE;
      for (let i = 0; i < 2; i++) {
        const o = i * 15 - 18;
        ctx.beginPath(); ctx.moveTo(-20, o + 14); ctx.lineTo(0, o - 6); ctx.lineTo(20, o + 14); ctx.lineTo(20, o + 22); ctx.lineTo(0, o + 2); ctx.lineTo(-20, o + 22); ctx.closePath();
        ctx.fill(); stroke(ctx, 2.5);
      }
      ctx.fillStyle = '#b98a4a'; ctx.fillRect(-24, 24, 48, 6); ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.strokeRect(-24, 24, 48, 6);
    },
    torch(ctx, t) {
      ctx.save(); ctx.rotate(0.3);
      ctx.fillStyle = '#5a3418'; ctx.fillRect(-4, -4, 8, 40); ctx.strokeStyle = INK; ctx.lineWidth = 2.5; ctx.strokeRect(-4, -4, 8, 40);
      ctx.fillStyle = '#8a6a44'; ctx.fillRect(-7, -10, 14, 10); ctx.strokeRect(-7, -10, 14, 10);
      const fl = Math.sin(t * 13) * 2;
      ctx.beginPath(); ctx.moveTo(-10, -10); ctx.quadraticCurveTo(-14, -26, fl, -40); ctx.quadraticCurveTo(14, -26, 10, -10); ctx.closePath();
      ctx.fillStyle = '#e8541c'; ctx.fill(); stroke(ctx, 2);
      ctx.beginPath(); ctx.moveTo(-5, -11); ctx.quadraticCurveTo(-6, -22, fl * 0.6, -30); ctx.quadraticCurveTo(6, -22, 5, -11); ctx.closePath();
      ctx.fillStyle = '#ffd36a'; ctx.fill();
      ctx.restore();
    },
    potion(ctx) {
      ctx.beginPath(); ctx.arc(0, 10, 19, 0, TAU); ctx.moveTo(-7, -8); ctx.rect(-7, -22, 14, 16);
      ctx.fillStyle = 'rgba(200,220,215,0.35)'; ctx.fill();
      ctx.save(); ctx.beginPath(); ctx.arc(0, 10, 18, 0, TAU); ctx.clip();
      const g = ctx.createLinearGradient(0, 0, 0, 30); g.addColorStop(0, '#d0202a'); g.addColorStop(1, '#5a0408');
      ctx.fillStyle = g; ctx.fillRect(-20, 2, 40, 30); ctx.restore();
      ctx.beginPath(); ctx.arc(0, 10, 19, -Math.PI * 0.32, Math.PI * 1.32); ctx.lineTo(-7, -6); ctx.lineTo(-7, -22); ctx.lineTo(7, -22); ctx.lineTo(7, -6); ctx.closePath(); stroke(ctx, 3);
      ctx.fillStyle = '#8a5a2a'; ctx.fillRect(-9, -30, 18, 9); ctx.strokeRect(-9, -30, 18, 9);
      ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.beginPath(); ctx.ellipse(-8, 4, 3, 7, 0.5, 0, TAU); ctx.fill();
    },
    use(ctx) {
      ctx.fillStyle = BONE;
      const f = (x, y, w, h) => { ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x, y + w / 2); ctx.arc(x + w / 2, y + w / 2, w / 2, Math.PI, 0); ctx.lineTo(x + w, y + h); ctx.closePath(); ctx.fill(); stroke(ctx, 2.2); };
      f(-17, -22, 8, 30); f(-8, -32, 8, 40); f(1, -30, 8, 38); f(10, -22, 8, 30);
      ctx.beginPath(); ctx.moveTo(-18, 2); ctx.lineTo(18, 2); ctx.lineTo(18, 16); ctx.quadraticCurveTo(16, 32, 0, 34); ctx.quadraticCurveTo(-16, 32, -18, 18); ctx.closePath(); ctx.fill(); stroke(ctx, 2.5);
      ctx.beginPath(); ctx.moveTo(-17, 18); ctx.quadraticCurveTo(-30, 8, -28, -2); ctx.quadraticCurveTo(-24, -6, -20, -1); ctx.lineTo(-12, 10); ctx.closePath(); ctx.fill(); stroke(ctx, 2.2);
      ctx.fillStyle = '#6a3a1c'; ctx.fillRect(-18, 24, 36, 10);
    },
    drag(ctx, t) {
      ctx.save(); ctx.rotate(-0.45);
      ctx.fillStyle = '#efe6d2'; ctx.fillRect(-26, -4, 40, 8); ctx.strokeStyle = INK; ctx.lineWidth = 2.5; ctx.strokeRect(-26, -4, 40, 8);
      ctx.fillStyle = '#c8a070'; ctx.fillRect(-26, -4, 9, 8);
      const e = 0.6 + 0.4 * Math.sin(t * 9);
      ctx.fillStyle = `rgb(255,${Math.round(80 + 90 * e)},30)`; ctx.fillRect(14, -4, 7, 8); ctx.strokeRect(14, -4, 7, 8);
      ctx.restore();
      ctx.strokeStyle = 'rgba(220,220,220,0.8)'; ctx.lineWidth = 3; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(14, -16); ctx.quadraticCurveTo(24, -26, 14, -32); ctx.quadraticCurveTo(6, -38, 16, -44); ctx.stroke();
    },
    offhand(ctx, t) {
      const cig = !!(CT.player && CT.player.offhand === 'cig');
      ctx.save(); ctx.scale(0.8, 0.8); ctx.translate(-8, 4);
      if (cig) ICON.torch(ctx, t); else ICON.drag(ctx, t);
      ctx.restore();
      ctx.strokeStyle = BONE; ctx.lineWidth = 3; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(0, 0, 36, -0.4, 0.9); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(24, 30); ctx.lineTo(29, 22); ctx.lineTo(33, 31); ctx.stroke();
    },
    hbrake(ctx, t) { DRIVE_ICONS.hbrake(ctx, t); }, dexit(ctx, t) { DRIVE_ICONS.dexit(ctx, t); }, dboost(ctx, t) { DRIVE_ICONS.dboost(ctx, t); }, dcam(ctx, t) { DRIVE_ICONS.dcam(ctx, t); }, dhorn(ctx, t) { DRIVE_ICONS.dhorn(ctx, t); },
    reload(ctx) {
      ctx.save(); ctx.rotate(0.25);
      ctx.fillStyle = '#2a2c30'; ctx.beginPath(); ctx.moveTo(-10, -22); ctx.lineTo(8, -22); ctx.quadraticCurveTo(12, 6, 16, 26); ctx.lineTo(-2, 30); ctx.quadraticCurveTo(-6, 4, -10, -22); ctx.closePath(); ctx.fill(); stroke(ctx, 2.5);
      ctx.fillStyle = '#d4a034'; ctx.fillRect(-6, -30, 10, 8); ctx.strokeRect(-6, -30, 10, 8);
      ctx.restore();
      ctx.strokeStyle = BONE; ctx.lineWidth = 3.5; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(0, 0, 34, -2.6, -0.9); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(14, -34); ctx.lineTo(20, -26); ctx.lineTo(10, -22); ctx.stroke();
    },
    aim(ctx) {
      ctx.strokeStyle = BONE; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(0, 0, 22, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-34, 0); ctx.lineTo(-12, 0); ctx.moveTo(12, 0); ctx.lineTo(34, 0); ctx.moveTo(0, -34); ctx.lineTo(0, -12); ctx.moveTo(0, 12); ctx.lineTo(0, 34); ctx.stroke();
      ctx.fillStyle = '#ff3020'; ctx.beginPath(); ctx.arc(0, 0, 4, 0, TAU); ctx.fill();
    },
    menu(ctx) { ctx.fillStyle = BONE; for (let i = -1; i <= 1; i++) { ctx.beginPath(); ctx.rect(-20, i * 13 - 3.5, 40, 7); ctx.fill(); stroke(ctx, 2); } },
    map(ctx) {
      ctx.beginPath(); ctx.moveTo(-26, -18); ctx.lineTo(-9, -24); ctx.lineTo(9, -18); ctx.lineTo(26, -24); ctx.lineTo(26, 18); ctx.lineTo(9, 24); ctx.lineTo(-9, 18); ctx.lineTo(-26, 24); ctx.closePath();
      ctx.fillStyle = '#d8c290'; ctx.fill(); stroke(ctx, 2.5);
      ctx.strokeStyle = 'rgba(90,60,30,0.8)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-9, -24); ctx.lineTo(-9, 18); ctx.moveTo(9, -18); ctx.lineTo(9, 24); ctx.stroke();
      ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(-20, 12); ctx.quadraticCurveTo(-4, -2, 12, -6); ctx.stroke(); ctx.setLineDash([]);
      ctx.strokeStyle = '#a0140c'; ctx.lineWidth = 3.5; ctx.beginPath(); ctx.moveTo(12, -12); ctx.lineTo(20, -4); ctx.moveTo(20, -12); ctx.lineTo(12, -4); ctx.stroke();
    },
    inv(ctx) {
      ctx.beginPath(); ctx.moveTo(-22, -6); ctx.quadraticCurveTo(-26, 26, -16, 28); ctx.lineTo(16, 28); ctx.quadraticCurveTo(26, 26, 22, -6); ctx.closePath();
      ctx.fillStyle = '#7a4a22'; ctx.fill(); stroke(ctx, 2.5);
      ctx.beginPath(); ctx.moveTo(-23, -6); ctx.quadraticCurveTo(0, -14, 23, -6); ctx.lineTo(19, 10); ctx.quadraticCurveTo(0, 16, -19, 10); ctx.closePath();
      ctx.fillStyle = '#9a6030'; ctx.fill(); stroke(ctx, 2.5);
      ctx.beginPath(); ctx.moveTo(-10, -9); ctx.quadraticCurveTo(0, -30, 10, -9); ctx.lineWidth = 4; ctx.strokeStyle = '#4a2a14'; ctx.stroke();
      ctx.fillStyle = '#e0b060'; ctx.fillRect(-5, 6, 10, 9); ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.strokeRect(-5, 6, 10, 9);
    },
  };

  function drawStick(ctx, t) {
    const R = STICK_R * kScale, active = stick.id !== null;
    const bx = active ? stick.bx : 40 + R + 30, by = active ? stick.by : H - R - 40;
    ctx.save();
    ctx.globalAlpha = active ? 0.95 : 0.4;
    const hot = active && stick.sprint;
    let g = ctx.createRadialGradient(bx, by, R * 0.2, bx, by, R);
    g.addColorStop(0, 'rgba(20,10,6,0.12)'); g.addColorStop(1, hot ? 'rgba(90,10,4,0.45)' : 'rgba(10,6,4,0.4)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(bx, by, R, 0, TAU); ctx.fill();
    ctx.lineWidth = 6; ctx.strokeStyle = hot ? '#c8321a' : bronze(ctx, bx, by, R); ctx.beginPath(); ctx.arc(bx, by, R, 0, TAU); ctx.stroke();
    ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.beginPath(); ctx.arc(bx, by, R + 3.5, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.arc(bx, by, R * DEAD + 6, 0, TAU); ctx.strokeStyle = 'rgba(200,160,100,0.25)'; ctx.stroke();
    for (let i = 0; i < 16; i++) {
      const a = i / 16 * TAU, l = i % 4 === 0 ? 14 : 7;
      ctx.beginPath(); ctx.moveTo(bx + Math.cos(a) * (R - 4), by + Math.sin(a) * (R - 4)); ctx.lineTo(bx + Math.cos(a) * (R - 4 - l), by + Math.sin(a) * (R - 4 - l));
      ctx.lineWidth = i % 4 === 0 ? 3 : 1.5; ctx.strokeStyle = 'rgba(214,170,100,0.7)'; ctx.stroke();
    }
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 - Math.PI / 2, cx = bx + Math.cos(a) * (R - 30), cy = by + Math.sin(a) * (R - 30);
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(a + Math.PI / 2);
      ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(8, 4); ctx.lineTo(-8, 4); ctx.closePath(); ctx.fillStyle = 'rgba(234,210,160,0.55)'; ctx.fill(); ctx.restore();
    }
    let kx = bx, ky = by;
    if (active) { const dx = stick.x - bx, dy = stick.y - by, l = Math.hypot(dx, dy), m = Math.min(l, R); if (l > 0) { kx = bx + dx / l * m; ky = by + dy / l * m; } }
    const kr = 46 * kScale;
    if (hot) { ctx.shadowColor = 'rgba(255,60,20,0.95)'; ctx.shadowBlur = 30 + 8 * Math.sin(t * 12); }
    g = ctx.createRadialGradient(kx - kr * 0.35, ky - kr * 0.4, kr * 0.1, kx, ky, kr);
    g.addColorStop(0, '#f8dc98'); g.addColorStop(0.45, '#b0742c'); g.addColorStop(1, '#3e220c');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(kx, ky, kr, 0, TAU); ctx.fill(); ctx.shadowBlur = 0;
    ctx.lineWidth = 3; ctx.strokeStyle = '#1a0c06'; ctx.stroke();
    ctx.beginPath(); ctx.arc(kx, ky, kr * 0.62, 0, TAU); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(40,20,8,0.7)'; ctx.stroke();
    ctx.beginPath(); ctx.arc(kx, ky, kr * 0.22, 0, TAU); ctx.fillStyle = hot ? '#d8301a' : '#6a3a14'; ctx.fill(); ctx.stroke();
    ctx.restore();
    if (!active) label(ctx, driving() ? 'STEER + GAS' : 'MOVE', bx, by - R - 18, 16, 'rgba(232,200,140,0.5)');
    else if (hot) label(ctx, 'SPRINT', bx, by - R - 18, 16, 'rgba(255,120,80,0.95)');
  }

  const smoking = () => !!(CT.player && CT.player.offhand === 'cig');
  function drawButton(ctx, b, t) {
    const on = b.down > 0 || b.flash > 0.02, isUse = b.id === 'use';
    let charge = 0;
    if (b.id === 'attack' && ch.touch.down) { const h = now() - ch.touch.t0; if (h > HEAVY_TOUCH) charge = Math.min(1, (h - HEAVY_TOUCH) / 0.75); }
    ctx.save();
    ctx.globalAlpha = on ? 1 : isUse ? 0.95 : 0.78;
    const r = plate(ctx, b, t, on, isUse || charge >= 1);
    ctx.save(); ctx.translate(b.x, b.y); const s = r * 0.8 / 44; ctx.scale(s, s); ICON[b.id === 'jump' && smoking() && !rifle() ? 'drag' : b.id === 'block' && rifle() ? 'aim' : b.id](ctx, t); ctx.restore();
    if (charge > 0) {
      const col = charge >= 1 ? `rgba(255,${60 + 40 * Math.sin(t * 14)},30,1)` : `rgb(${220 + 35 * charge},${180 - 150 * charge},${60 - 40 * charge})`;
      ctx.lineCap = 'round'; ctx.lineWidth = 9; ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath(); ctx.arc(b.x, b.y, r + 12, 0, TAU); ctx.stroke();
      ctx.lineWidth = 7; ctx.strokeStyle = col; if (charge >= 1) { ctx.shadowColor = '#ff3010'; ctx.shadowBlur = 24; }
      ctx.beginPath(); ctx.arc(b.x, b.y, r + 12, -Math.PI / 2, -Math.PI / 2 + charge * TAU); ctx.stroke(); ctx.shadowBlur = 0;
    }
    ctx.restore();
    const small = b.tl != null;
    const txt = charge > 0 ? (charge >= 1 ? 'UNLEASH' : 'HEAVY') : b.id === 'jump' && smoking() && !rifle() ? 'DRAG' : b.id === 'block' && rifle() ? 'AIM' : b.id === 'attack' && rifle() ? 'FIRE' : b.id === 'offhand' ? (smoking() ? 'SWAP' : 'SMOKE') : b.label;
    label(ctx, txt, b.x, small ? b.y + r + 13 : b.y + r + (charge > 0 ? 30 : 16), small ? 13 : b.r > 60 ? 19 : 15, charge > 0 ? 'rgba(255,150,90,0.98)' : undefined);
    if (b.id === 'potion' && potions >= 0) {
      const cx = b.x + r * 0.72, cy = b.y - r * 0.72;
      ctx.save(); ctx.globalAlpha = 0.95;
      ctx.beginPath(); ctx.arc(cx, cy, 15, 0, TAU); ctx.fillStyle = potions > 0 ? '#7a0c08' : '#2a2420'; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = bronze(ctx, cx, cy, 15); ctx.stroke(); ctx.restore();
      label(ctx, String(potions), cx, cy + 1, 16, '#f6e6c0');
    }
  }

  function drawTouch(ctx, t) {
    if (!ctx) return;
    t = t || 0;
    layout();
    ctx.save();
    drawStick(ctx, t);
    if (look.id !== null) {
      ctx.globalAlpha = 0.35; ctx.lineWidth = 3; ctx.strokeStyle = '#e8c890';
      ctx.beginPath(); ctx.arc(look.x, look.y, 34, 0, TAU); ctx.stroke(); ctx.globalAlpha = 1;
    }
    BTN.forEach(b => { if (visible(b)) drawButton(ctx, b, t); });
    ctx.restore();
  }

  // ── Lock API ──
  function lock() {
    if (!stage) stage = document.getElementById('stage');
    if (!stage || M.locked) return;
    loadSettings();
    if (!stage.requestPointerLock) { lockRefused = true; return; }
    const plain = () => { try { const p = stage.requestPointerLock(); if (p && p.catch) p.catch(() => { lockRefused = true; }); } catch (e) { lockRefused = true; } };
    try {
      const p = stage.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(err => { if (err && err.name === 'NotSupportedError') plain(); else lockRefused = true; });
    } catch (e) { plain(); }
  }
  function unlock() {
    keys.clear(); rmb = false; resetChan(ch.mouse);
    try { if (document.pointerLockElement && document.exitPointerLock) document.exitPointerLock(); } catch (e) {}
  }

  function init(c) {
    core = c || CT.core || null;
    stage = document.getElementById('stage'); uiCanvas = document.getElementById('ui');
    loadSettings();
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('blur', () => { keys.clear(); rmb = false; resetChan(ch.mouse); releaseTouches(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) { keys.clear(); rmb = false; resetChan(ch.mouse); releaseTouches(); } });
    document.addEventListener('pointerlockchange', onLockChange);
    document.addEventListener('pointerlockerror', onLockError);
    const o = { passive: false };
    window.addEventListener('touchstart', onTouchStart, o);
    window.addEventListener('touchmove', onTouchMove, o);
    window.addEventListener('touchend', onTouchEnd, o);
    window.addEventListener('touchcancel', onTouchEnd, o);
    window.addEventListener('gesturestart', e => e.preventDefault());
    layout();
  }

  // ── Public API ──
  const M = CT.controls = {
    init, update, state, drawTouch, lock, unlock,
    locked: false, lostLock: false, _forceAttack: false, _forceHeavy: false,
    sens, invertY,
    setSensitivity(v) { v = +v; if (v > 0.0001 && v < 0.05) { sens = v; M.sens = v; try { localStorage.setItem(LS_SENS, String(v)); } catch (e) {} } },
    setInvertY(on) { invertY = !!on; M.invertY = invertY; try { localStorage.setItem(LS_INV, invertY ? '1' : '0'); } catch (e) {} },
  };
})();
