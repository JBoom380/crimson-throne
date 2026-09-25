// ─── CONFIG: tuning, content tables, rng, event bus ──────────────────────────
window.CT = window.CT || {};

CT.config = {
  PIX_W: 640, PIX_H: 360, UI_W: 1280, UI_H: 720,
  ISLAND: 1500,                 // half-size of the island in metres
  START: { x: 0, z: 1250 },

  // ── Points of interest (world places content here; rpg/quests reference ids) ──
  POIS: [
    { id: 'shore',     name: 'Wreckers Shore',        type: 'coast',   x: 0,    z: 1250, radius: 60 },
    { id: 'harrowby',  name: 'Harrowby',              type: 'village', x: 120,  z: 980,  radius: 90, save: true },
    { id: 'lodge',     name: 'Red-Arrow Lodge',       type: 'lodge',   x: -780, z: 420,  radius: 50, save: true },
    { id: 'wolfden',   name: 'The Gnawing Hollow',    type: 'den',     x: -1000, z: 60,  radius: 70 },
    { id: 'camp',      name: 'Blackhand Camp',        type: 'camp',    x: 280,  z: 380,  radius: 80 },
    { id: 'stones',    name: 'The Nine Stones',       type: 'stones',  x: -160, z: 60,   radius: 45 },
    { id: 'fen',       name: 'The Weeping Fen',       type: 'swamp',   x: 820,  z: 150,  radius: 140 },
    { id: 'ruins',     name: 'Moonfall Ruins',        type: 'ruins',   x: 1020, z: -220, radius: 90 },
    { id: 'crossing',  name: 'Gallows Crossing',      type: 'village', x: 40,   z: -380, radius: 70, save: true },
    { id: 'pass',      name: 'The Frozen Teeth',      type: 'pass',    x: -60,  z: -820, radius: 90 },
    { id: 'citadel',   name: 'The Crimson Throne',    type: 'citadel', x: 0,    z: -1250, radius: 140 },
  ],

  // ── Monsters: base stats (monsters.js may scale by level/night) ──
  MONSTERS: {
    wolf:      { hp: 45,   dmg: 9,  speed: 7.5, reach: 1.8, xp: 12,  size: 1.0, sever: 0.55 },
    ghoul:     { hp: 60,   dmg: 12, speed: 2.6, reach: 1.9, xp: 15,  size: 1.0, sever: 0.8 },
    bandit:    { hp: 80,   dmg: 14, speed: 4.2, reach: 2.2, xp: 25,  size: 1.0, sever: 0.5 },
    orc:       { hp: 140,  dmg: 22, speed: 4.6, reach: 2.5, xp: 45,  size: 1.35, sever: 0.45 },
    troll:     { hp: 420,  dmg: 38, speed: 3.2, reach: 4.2, xp: 140, size: 2.6, sever: 0.3 },
    wraith:    { hp: 90,   dmg: 18, speed: 5.0, reach: 2.4, xp: 40,  size: 1.2, sever: 0.0, needs: 'moonblessing' },
    boneKnight:{ hp: 200,  dmg: 26, speed: 4.0, reach: 2.6, xp: 70,  size: 1.25, sever: 0.4 },
    boneKing:  { hp: 2400, dmg: 45, speed: 3.8, reach: 5.0, xp: 1000, size: 3.4, sever: 0.0, boss: true },
  },

  // ── Items ──
  ITEMS: {
    rustsword:   { name: 'Rusted Sword',        kind: 'weapon', style: 'sword',      damage: 18, heavyMult: 2.2, speed: 1.0,  reach: 2.3, arc: 1.6, bleed: 0.2, price: 5 },
    handaxe:     { name: 'Bearded Axe',         kind: 'weapon', style: 'axe',        damage: 26, heavyMult: 2.4, speed: 0.9,  reach: 2.2, arc: 1.4, bleed: 0.4, price: 40 },
    dagger:      { name: 'Red-Arrow Dagger',    kind: 'weapon', style: 'dagger',     damage: 15, heavyMult: 2.8, speed: 1.6,  reach: 1.7, arc: 1.1, bleed: 0.6, price: 60 },
    steelsword:  { name: 'Harrowby Longsword',  kind: 'weapon', style: 'sword',      damage: 32, heavyMult: 2.3, speed: 1.05, reach: 2.5, arc: 1.7, bleed: 0.35, price: 120 },
    mace:        { name: 'Skullbreaker Mace',   kind: 'weapon', style: 'mace',       damage: 40, heavyMult: 2.5, speed: 0.8,  reach: 2.2, arc: 1.3, bleed: 0.1, price: 160 },
    greatsword:  { name: 'Ironhand Greatsword', kind: 'weapon', style: 'greatsword', damage: 58, heavyMult: 2.4, speed: 0.65, reach: 3.1, arc: 2.1, bleed: 0.5, price: 300 },
    moonblade:   { name: 'Moonblade',           kind: 'weapon', style: 'sword',      damage: 50, heavyMult: 2.4, speed: 1.1,  reach: 2.7, arc: 1.8, bleed: 0.4, holy: true, price: 0 },
    crimson:     { name: 'The Crimson Edge',    kind: 'weapon', style: 'crimson',    damage: 80, heavyMult: 2.6, speed: 1.0,  reach: 3.0, arc: 2.0, bleed: 0.8, holy: true, price: 0 },
    ar15:        { name: "AR-15 'Thunderstick'", kind: 'weapon', style: 'rifle', ranged: true, damage: 34, heavyMult: 1, speed: 1, reach: 120, arc: 0.03, bleed: 0.5, magazine: 30, price: 0, desc: 'A sky-iron relic of a fallen age. It speaks in thunder.' },
    banditblade: { name: 'Blackhand Sword',     kind: 'weapon', style: 'sword',      damage: 22, heavyMult: 2.2, speed: 1.0,  reach: 2.3, arc: 1.6, bleed: 0.25, price: 45 },
    banditaxe:   { name: 'Blackhand Axe',       kind: 'weapon', style: 'axe',        damage: 27, heavyMult: 2.3, speed: 0.9,  reach: 2.2, arc: 1.4, bleed: 0.4, price: 50 },
    orccleaver:  { name: 'Orcish Cleaver',      kind: 'weapon', style: 'axe',        damage: 36, heavyMult: 2.4, speed: 0.8,  reach: 2.3, arc: 1.5, bleed: 0.5, price: 90 },
    boneblade:   { name: 'Bone Knight Greatsword', kind: 'weapon', style: 'greatsword', damage: 52, heavyMult: 2.4, speed: 0.68, reach: 3.0, arc: 2.0, bleed: 0.4, price: 220 },
    furs:        { name: 'Wolfhide Furs',       kind: 'armor',  armor: 0.10, price: 30 },
    mail:        { name: 'Blackhand Mail',      kind: 'armor',  armor: 0.22, price: 150 },
    bronze:      { name: 'Queen\'s Bronze',     kind: 'armor',  armor: 0.35, price: 0 },
    redbow:      { name: 'Red Bow Charm',       kind: 'charm',  crit: 0.15, price: 0 },
    moonblessing:{ name: 'Blessing of the Pale Moon', kind: 'charm', holy: true, price: 0 },
    potion:      { name: 'Healing Draught',     kind: 'potion', heal: 50, price: 15 },
    bigpotion:   { name: 'Troll-Blood Tonic',   kind: 'potion', heal: 120, price: 45 },
    gold:        { name: 'Gold',                kind: 'gold' },
    pelt:        { name: 'Wolf Pelt',           kind: 'loot', price: 6 },
    alphapelt:   { name: 'Alpha Pelt',          kind: 'quest' },
    wraithdust:  { name: 'Wraith Dust',         kind: 'quest' },
    ammo556:     { name: 'Sky-Iron Rounds',     kind: 'ammo', price: 2, desc: 'Brass-cased thunder for the Thunderstick.' },
    skykey:      { name: 'Sky-Iron Key',        kind: 'quest', desc: 'Cold, heavy and not forged by any smith of Vael.' },
  },

  START_ITEMS: [{ id: 'rustsword', count: 1 }, { id: 'potion', count: 3 }, { id: 'gold', count: 10 }],

  PLAYER: { hp: 100, stamina: 100, walk: 4.5, sprint: 8.0, jump: 5.2, eye: 1.7, radius: 0.45,
            dodgeCost: 25, sprintCost: 14, blockCost: 18, lightCost: 12, heavyCost: 28, staminaRegen: 30 },
};

// Seeded PRNG (mulberry32).
CT.rng = function (seed) {
  let s = seed >>> 0 || 1;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// Tiny event bus. Handlers that throw are logged and skipped so one bad listener cannot break the game.
CT.bus = (function () {
  const h = {};
  return {
    on(name, fn) { (h[name] = h[name] || []).push(fn); },
    off(name, fn) { if (h[name]) h[name] = h[name].filter(f => f !== fn); },
    emit(name, data) {
      (h[name] || []).forEach(fn => { try { fn(data || {}); } catch (e) { console.error('[CT.bus ' + name + ']', e); } });
    },
  };
})();
