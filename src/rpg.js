// ─── RPG: stats, levels, inventory, loot, quests, save ───────────────────────
(function () {
  const C = CT.config, I = C.ITEMS, bus = CT.bus, KEY = 'crimsonThrone.save';
  const R = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const chance = p => Math.random() < p;
  const poi = id => C.POIS.find(p => p.id === id);

  // ── Quest definitions ──────────────────────────────────────────────────────
  const QDEF = {
    throne: { title: 'The Crimson Throne', main: true, stages: [
      { text: 'Speak with Kaela Ironhand in Harrowby', poi: 'harrowby', npc: 'kaela' },
      { text: 'Break the Blackhand bandits. Slay Grask Blackhand', poi: 'camp' },
      { text: 'Seek the sorceress Nyx in the Weeping Fen', poi: 'fen', npc: 'nyx' },
      { text: 'Claim the Moonblade from the guardian of Moonfall Ruins', poi: 'ruins' },
      { text: 'Cross the Frozen Teeth to the citadel', poi: 'pass' },
      { text: 'Slay the Bone King upon the Crimson Throne', poi: 'citadel' },
    ] },
    wolves: { title: 'The Gnawing Hollow', stages: [
      { text: 'Slay the alpha of the Gnawing Hollow', poi: 'wolfden' },
      { text: 'Bring the alpha pelt to Vesna Red-Arrow', poi: 'lodge', npc: 'vesna' },
    ] },
    wraiths: { title: 'Pale Moon, Pale Dead', stages: [
      { text: 'Slay the wraiths of the Weeping Fen', poi: 'fen', count: 5 },
      { text: 'Return to Nyx of the Pale Moon', poi: 'fen', npc: 'nyx' },
    ] },
    smith: { title: 'Pelts for Steel', stages: [
      { text: 'Bring wolf pelts to Bram the smith', poi: 'harrowby', npc: 'bram', count: 5 },
      { text: 'Return to Bram the smith with 5 wolf pelts', poi: 'harrowby', npc: 'bram' },
    ] },
  };

  const rpg = CT.rpg = {
    stats: null, inventory: [], equipped: { weapon: null, armor: null, charm: null },
    quests: [], flags: {}, tracked: 'throne', QDEF,
  };
  let saveT = 0, victorySent = false, victoryTimer = null;

  // ── Stats and levels ───────────────────────────────────────────────────────
  const xpFor = lv => Math.round(100 * Math.pow(lv, 1.5));
  function baseStats() { return { level: 1, xp: 0, xpNext: xpFor(1), hpMax: C.PLAYER.hp, staminaMax: C.PLAYER.stamina, str: 10, gold: 0 }; }
  rpg.addXp = function (n) {
    const s = rpg.stats; s.xp += Math.max(0, Math.round(n || 0));
    while (s.xp >= s.xpNext) {
      s.xp -= s.xpNext; s.level++; s.xpNext = xpFor(s.level);
      s.hpMax += 12; s.staminaMax += 8; s.str += 1;
      const p = CT.player;
      if (p) { if ('hp' in p) p.hp = s.hpMax; if ('stamina' in p) p.stamina = s.staminaMax; }
      bus.emit('levelUp', { level: s.level });
    }
  };

  // ── Inventory ──────────────────────────────────────────────────────────────
  rpg.count = id => (id === 'gold' ? rpg.stats.gold : (rpg.inventory.find(e => e.id === id) || { count: 0 }).count);
  rpg.has = (id, n) => rpg.count(id) >= (n || 1);
  rpg.give = function (id, count) {
    const n = count == null ? 1 : count | 0; if (!I[id] || n <= 0) return false;
    if (id === 'gold') rpg.stats.gold += n;
    else { const e = rpg.inventory.find(e => e.id === id); if (e) e.count += n; else rpg.inventory.push({ id, count: n }); }
    if (id === 'pelt') refreshSmith();
    return true;
  };
  rpg.grant = function (id, count) { if (rpg.give(id, count)) bus.emit('loot', { item: id, count: count || 1 }); };
  rpg.take = function (id, count) {
    const n = count == null ? 1 : count | 0; if (!rpg.has(id, n)) return false;
    if (id === 'gold') rpg.stats.gold -= n;
    else {
      const e = rpg.inventory.find(e => e.id === id); e.count -= n;
      if (e.count <= 0) {
        rpg.inventory.splice(rpg.inventory.indexOf(e), 1);
        Object.keys(rpg.equipped).forEach(k => { if (rpg.equipped[k] === id) rpg.equipped[k] = k === 'weapon' ? 'rustsword' : null; });
        if (rpg.equipped.weapon && !rpg.has(rpg.equipped.weapon)) rpg.equipped.weapon = null;
      }
    }
    if (id === 'pelt') refreshSmith();
    return true;
  };
  rpg.equip = function (id) {
    const it = I[id]; if (!it || !rpg.has(id)) return false;
    const slot = it.kind === 'weapon' ? 'weapon' : it.kind === 'armor' ? 'armor' : it.kind === 'charm' ? 'charm' : null;
    if (!slot) return rpg.use(id);
    if (rpg.equipped[slot] === id && slot !== 'weapon') { rpg.equipped[slot] = null; bus.emit('notify', { text: `Removed: ${it.name}`, kind: 'info' }); return true; }
    rpg.equipped[slot] = id; bus.emit('notify', { text: `Equipped: ${it.name}`, kind: 'info' });
    bus.emit('equip', { slot, id });
    return true;
  };
  rpg.use = function (id) {
    const it = I[id]; if (!it || !rpg.has(id)) return false;
    if (it.kind !== 'potion') return it.kind === 'weapon' || it.kind === 'armor' || it.kind === 'charm' ? rpg.equip(id) : false;
    const p = CT.player;
    if (p && p.hp != null && p.hp >= rpg.stats.hpMax) { bus.emit('notify', { text: 'You are already hale.', kind: 'info' }); return false; }
    rpg.take(id, 1);
    if (p && typeof p.heal === 'function') p.heal(it.heal);
    else if (p && p.hp != null) p.hp = Math.min(rpg.stats.hpMax, p.hp + it.heal);
    if (CT.audio && CT.audio.sfx) CT.audio.sfx('drink');
    bus.emit('notify', { text: `${it.name}: +${it.heal} health`, kind: 'info' });
    return true;
  };
  // Quick-drink: the smallest potion that is enough, else the biggest one.
  rpg.usePotion = function () {
    const p = CT.player, miss = p && p.hp != null ? rpg.stats.hpMax - p.hp : 999;
    const order = miss > 70 ? ['bigpotion', 'potion'] : ['potion', 'bigpotion'];
    const id = order.find(k => rpg.has(k));
    if (!id) { bus.emit('notify', { text: 'No draughts left.', kind: 'info' }); return false; }
    return rpg.use(id);
  };
  rpg.weapon = function () {
    const id = rpg.equipped.weapon && I[rpg.equipped.weapon] ? rpg.equipped.weapon : 'rustsword';
    const w = Object.assign({}, I[id], { id });
    w.baseDamage = w.damage; w.damage = Math.round(w.damage * (1 + 0.04 * (rpg.stats.str - 10)));
    return w;
  };
  rpg.armor = () => (rpg.equipped.armor && I[rpg.equipped.armor] ? I[rpg.equipped.armor].armor || 0 : 0);
  rpg.charm = () => (rpg.equipped.charm && I[rpg.equipped.charm] ? Object.assign({ id: rpg.equipped.charm }, I[rpg.equipped.charm]) : null);
  rpg.crit = () => { const c = rpg.charm(); return c && c.crit ? c.crit : 0; };
  rpg.holy = () => rpg.has('moonblessing') || !!(I[rpg.weapon().id] || {}).holy;
  // Trade (npcs call these). Sale price is 40% of value.
  rpg.price = id => (I[id] && I[id].price) || 0;
  rpg.sellPrice = id => Math.max(1, Math.floor(rpg.price(id) * 0.4));
  rpg.buy = function (id, price) {
    const cost = price == null ? rpg.price(id) : price;
    if (rpg.stats.gold < cost) { bus.emit('notify', { text: 'Not enough gold.', kind: 'info' }); return false; }
    rpg.stats.gold -= cost; rpg.grant(id, 1); return true;
  };
  rpg.sell = function (id, price) {
    if (!rpg.has(id) || !rpg.price(id)) return false;
    const eq = Object.keys(rpg.equipped).find(k => rpg.equipped[k] === id);
    if (eq && rpg.count(id) <= 1) { bus.emit('notify', { text: 'Unequip it first.', kind: 'info' }); return false; }
    const g = price == null ? rpg.sellPrice(id) : price;
    rpg.take(id, 1); rpg.stats.gold += g;
    bus.emit('notify', { text: `Sold ${I[id].name} for ${g} gold`, kind: 'loot' });
    return true;
  };

  // ── Loot tables ────────────────────────────────────────────────────────────
  rpg.lootFor = function (type, m) {
    const out = [], add = (id, n) => { if (n > 0) out.push({ id, count: n }); };
    m = m || {};
    switch (type) {
      case 'wolf': add('pelt', chance(0.2) ? 2 : 1); if (chance(0.3)) add('gold', R(3, 8)); break;
      case 'bandit':
        if (isChief(m)) { add('gold', R(70, 110)); add('bigpotion', 1); add('mail', 1); break; }
        if (chance(0.9)) add('gold', R(5, 20)); if (chance(0.35)) add('potion', 1);
        if (chance(0.07)) add('handaxe', 1); else if (chance(0.05)) add('dagger', 1); else if (chance(0.04)) add('mail', 1);
        break;
      case 'orc': add('gold', R(10, 30)); if (chance(0.25)) add('bigpotion', 1); if (chance(0.06)) add('mace', 1); break;
      case 'troll': if (chance(0.6)) add('bigpotion', R(1, 2)); add('gold', R(40, 90)); if (chance(0.1)) add('greatsword', 1); break;
      case 'ghoul': if (chance(0.6)) add('gold', R(2, 10)); break;
      case 'wraith': if (chance(0.5)) add('gold', R(5, 15)); if (qStage('wraiths') === 0) add('wraithdust', 1); break;
      case 'boneKnight': add('gold', R(15, 40)); if (chance(0.5)) add('potion', 1); if (chance(0.15)) add('bigpotion', 1); break;
      case 'boneKing': add('gold', 500); add('crimson', 1); break;
      default: if (chance(0.4)) add('gold', R(2, 8));
    }
    return out;
  };

  // ── Quests ─────────────────────────────────────────────────────────────────
  rpg.quest = id => rpg.quests.find(q => q.id === id) || null;
  const qStage = id => { const q = rpg.quest(id); return q && !q.done ? q.stage : -1; };
  rpg.qStage = qStage;
  function qText(q) {
    const d = QDEF[q.id]; if (q.done) return 'Complete';
    const st = d.stages[q.stage] || {};
    if (q.id === 'smith' && q.stage === 0) return `${st.text} (${Math.min(5, rpg.count('pelt'))}/5)`;
    return st.count ? `${st.text} (${q.n || 0}/${st.count})` : st.text;
  }
  function refresh(q) { q.text = qText(q); q.target = targetFor(q); return q; }
  function targetFor(q) {
    const st = QDEF[q.id].stages[q.stage]; if (!st || q.done) return null;
    const n = st.npc && CT.npcs && CT.npcs.list && CT.npcs.list.find(n => n.id === st.npc);
    if (n && n.pos) return { x: n.pos.x, z: n.pos.z };
    const p = poi(st.poi); return p ? { x: p.x, z: p.z } : null;
  }
  function announce(q, verb) {
    bus.emit('quest', { id: q.id, stage: q.done ? -1 : q.stage, text: `${verb}: ${q.done ? QDEF[q.id].title : q.text}`, title: QDEF[q.id].title, done: q.done });
    rpg.save();
  }
  rpg.startQuest = function (id) {
    if (!QDEF[id]) return null;
    let q = rpg.quest(id); if (q) return q;
    q = { id, title: QDEF[id].title, stage: 0, n: 0, done: false, main: !!QDEF[id].main };
    rpg.quests.push(q); refresh(q);
    if (!QDEF[id].main) rpg.tracked = id;
    announce(q, 'Quest started');
    if (id === 'wolves' && rpg.has('alphapelt')) rpg.advanceQuest('wolves', 1);
    if (id === 'smith') refreshSmith();
    return q;
  };
  rpg.advanceQuest = function (id, stage) {
    const q = rpg.quest(id) || rpg.startQuest(id); if (!q || q.done) return q;
    const last = QDEF[id].stages.length;
    const s = stage == null ? q.stage + 1 : stage;
    if (s === q.stage) return q;
    if (s >= last) { q.done = true; q.stage = last; refresh(q); if (rpg.tracked === id) rpg.tracked = 'throne'; announce(q, 'Quest complete'); return q; }
    q.stage = s; q.n = 0; refresh(q); announce(q, 'Quest updated');
    return q;
  };
  rpg.completeQuest = id => rpg.advanceQuest(id, 99);
  rpg.track = id => { if (rpg.quest(id)) rpg.tracked = id; };
  rpg.activeQuest = function () {
    let q = rpg.quest(rpg.tracked);
    if (!q || q.done) q = rpg.quest('throne');
    if (!q || q.done) q = rpg.quests.find(x => !x.done) || null;
    return q ? refresh(q) : null;
  };
  function refreshSmith() {
    const q = rpg.quest('smith'); if (!q || q.done) return;
    if (q.stage === 0 && rpg.count('pelt') >= 5) rpg.advanceQuest('smith', 1);
    else if (q.stage === 1 && rpg.count('pelt') < 5) { q.stage = 0; refresh(q); }
    else refresh(q);
  }

  // ── Kill and discovery handlers ────────────────────────────────────────────
  const M = d => d.monster || {};
  function isChief(m) { return !!(m.chief || m.isChief || (m.name && /grask/i.test(m.name))); }
  const isGuardian = d => !!(d.isGuardian || d.guardian || M(d).isGuardian || M(d).guardian);
  const isAlpha = d => !!(d.alpha || M(d).alpha || M(d).isAlpha);
  function wherePt(d) { const p = d.point || M(d).pos; return p ? { x: p.x, z: p.z } : null; }

  function onKill(d) {
    const type = d.type || M(d).type; if (!type) return;
    const cfg = C.MONSTERS[type] || {};
    const xp = d.xp != null ? d.xp : cfg.xp || 0;
    if (xp > 0) { bus.emit('notify', { text: `+${xp} XP`, kind: 'xp' }); rpg.addXp(xp); }
    const chief = d.chief || isChief(M(d));
    rpg.lootFor(type, chief ? Object.assign({ chief: true }, M(d)) : M(d)).forEach(e => rpg.grant(e.id, e.count));

    // Main quest: never soft-locks; a later deed completes the earlier steps.
    const ms = qStage('throne');
    if (chief) {
      rpg.flags.graskDead = true;
      bus.emit('notify', { text: 'Grask Blackhand is dead. His band is broken.', kind: 'story' });
      if (ms >= 0 && ms <= 1) rpg.advanceQuest('throne', 2);
    }
    if (isGuardian(d)) {
      rpg.flags.guardianDead = true;
      if (!rpg.flags.moonbladeGiven) {
        rpg.flags.moonbladeGiven = true; rpg.grant('moonblade', 1); rpg.equip('moonblade');
        bus.emit('notify', { text: 'The Moonblade is yours. It hums like a struck bell.', kind: 'story' });
      }
      if (ms >= 0 && ms <= 3) rpg.advanceQuest('throne', 4);
    }
    if (type === 'boneKing') {
      rpg.flags.boneKingDead = true;
      if (ms >= 0) rpg.completeQuest('throne');
      if (!victorySent && !victoryTimer) victoryTimer = setTimeout(() => { victoryTimer = null; if (!victorySent) bus.emit('victory', {}); }, 4000);
    }
    // Wolves: a flagged alpha, or (fallback) the 4th wolf slain in the den.
    if (type === 'wolf' && !rpg.flags.alphaDead) {
      const p = wherePt(d), den = poi('wolfden');
      let alpha = isAlpha(d);
      if (!alpha && p && den && Math.hypot(p.x - den.x, p.z - den.z) < den.radius + 40) {
        rpg.flags.denKills = (rpg.flags.denKills || 0) + 1;
        alpha = rpg.flags.denKills >= 4 && !(CT.monsters && CT.monsters.spawn); // monsters flag their alphas
      }
      if (alpha) {
        rpg.flags.alphaDead = true; rpg.grant('alphapelt', 1);
        bus.emit('notify', { text: 'The alpha of the Hollow lies dead.', kind: 'story' });
        if (qStage('wolves') === 0) rpg.advanceQuest('wolves', 1);
      }
    }
    if (type === 'wraith' && qStage('wraiths') === 0) {
      const q = rpg.quest('wraiths'); q.n = (q.n || 0) + 1;
      if (q.n >= 5) rpg.advanceQuest('wraiths', 1); else { refresh(q); bus.emit('quest', { id: 'wraiths', stage: 0, text: `Quest updated: ${q.text}` }); }
    }
  }
  function onPoi(d) {
    const ms = qStage('throne');
    if (ms === 4 && (d.id === 'pass' || d.id === 'citadel')) rpg.advanceQuest('throne', 5);
    // Fallback when the npc module is missing: finding the ruins stands in for meeting Nyx.
    const npcsOk = CT.npcs && CT.npcs.list && CT.npcs.list.length && !(CT._broken && CT._broken.npcs);
    if (!npcsOk && ms === 2 && d.id === 'ruins') rpg.advanceQuest('throne', 3);
    if (!npcsOk && ms === 0 && (d.id === 'camp' || d.id === 'crossing')) rpg.advanceQuest('throne', 1);
  }

  // ── Save / load / reset ────────────────────────────────────────────────────
  rpg.save = function () {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        v: 1, stats: rpg.stats, inventory: rpg.inventory, equipped: rpg.equipped, tracked: rpg.tracked, flags: rpg.flags,
        quests: rpg.quests.map(q => ({ id: q.id, stage: q.stage, n: q.n || 0, done: q.done })),
        pois: ((CT.world && CT.world.pois) || []).filter(p => p.found).map(p => p.id),
      }));
      return true;
    } catch (e) { return false; }
  };
  rpg.load = function () {
    let d; try { d = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { d = null; }
    if (!d || !d.stats) return false;
    rpg.stats = Object.assign(baseStats(), d.stats);
    rpg.inventory = (d.inventory || []).filter(e => I[e.id] && e.count > 0).map(e => ({ id: e.id, count: e.count | 0 }));
    rpg.equipped = Object.assign({ weapon: null, armor: null, charm: null }, d.equipped || {});
    rpg.flags = d.flags || {};
    rpg.quests = (d.quests || []).filter(q => QDEF[q.id]).map(q => refresh({ id: q.id, title: QDEF[q.id].title, stage: q.stage, n: q.n || 0, done: !!q.done, main: !!QDEF[q.id].main }));
    if (!rpg.quest('throne')) rpg.quests.unshift(refresh({ id: 'throne', title: QDEF.throne.title, stage: 0, n: 0, done: false, main: true }));
    rpg.tracked = d.tracked || 'throne';
    if (d.pois && CT.world && CT.world.pois) CT.world.pois.forEach(p => { if (d.pois.includes(p.id)) p.found = true; });
    victorySent = false; saveT = 0;
    const p = CT.player; if (p && 'hp' in p) { p.hp = rpg.stats.hpMax; if ('stamina' in p) p.stamina = rpg.stats.staminaMax; }
    return true;
  };
  rpg.reset = function () {
    rpg.stats = baseStats(); rpg.inventory = []; rpg.flags = {}; rpg.tracked = 'throne';
    rpg.equipped = { weapon: null, armor: null, charm: null };
    (C.START_ITEMS || []).forEach(e => rpg.give(e.id, e.count));
    if (rpg.has('rustsword')) rpg.equipped.weapon = 'rustsword';
    rpg.quests = [refresh({ id: 'throne', title: QDEF.throne.title, stage: 0, n: 0, done: false, main: true })];
    victorySent = false; saveT = 0;
    if (victoryTimer) { clearTimeout(victoryTimer); victoryTimer = null; }
    const p = CT.player; if (p && 'hp' in p) { p.hp = rpg.stats.hpMax; if ('stamina' in p) p.stamina = rpg.stats.staminaMax; }
    if (CT.npcs && CT.npcs.resetDialog) CT.npcs.resetDialog();
  };

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  rpg.init = function () {
    if (!rpg.stats) rpg.reset();
    bus.on('kill', onKill);
    bus.on('poi', onPoi);
    bus.on('victory', () => { victorySent = true; rpg.flags.victory = true; if (qStage('throne') >= 0) rpg.completeQuest('throne'); rpg.save(); });
  };
  rpg.update = function (dt, core) {
    if (!core || core.state !== 'PLAY') return;
    saveT += dt;
    if (saveT >= 60) { saveT = 0; rpg.save(); }
  };
  rpg.reset();
})();
