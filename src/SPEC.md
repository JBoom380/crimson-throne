# CRIMSON THRONE: shared build contract

Every builder reads this file first. Edit ONLY your own file. Do not edit `game.js`, `config.js`, `dev.html`, `build.py`, or this file. If you need a contract change, say so in your final report.

## The game
An 18+ open-world dark-fantasy action RPG in the browser, in the spirit of a Frank Frazetta painting brought to life (muscular barbarians, warrior women in fur and bronze, hulking beasts, storm skies, blood-red sunsets, sweeping brushy silhouettes) with Skyrim-like freedom. It is first person, with a pixel-art look (chunky low-res 3D + palette-quantised dither, like the reference `ref/` modules from our kids game "Castle Quest", but dark, violent and adult).

The player is a nameless warrior who washes ashore on the cursed isle of **Vael**. The **Crimson Throne** sits in the black citadel in the far north. The **Bone King** sits on it, and his curse spawns the monsters. The player explores freely, fights, levels up, finds better weapons, meets three legendary women (the warrior-queen **Kaela Ironhand**, the sorceress **Nyx of the Pale Moon**, and the huntress **Vesna Red-Arrow**), and finally storms the citadel to slay the Bone King.

Content rules:
- Extreme gore is wanted: blood sprays, severed limbs and heads, gibs, bone, blood pools and decals, blood on the blade and on the screen, finishing moves. It is monster and humanoid-enemy gore only. No sexual violence, no torture of the helpless, no gore on the named women or villagers (they cannot be attacked).
- The women are Frazetta-style heroines: powerful, attractive, in fur, leather and bronze armour. They are tasteful and non-explicit (no nudity, no sexual content). They are characters with agency and personality.
- The game shows its own 18+ gate on first load (core handles it; ui draws it).

## Files and load order (classic scripts, global `window.CT`; no modules, no network, no CDN, no image or audio files)
1. `vendor/three.global.js` (THREE r186, done)
2. `config.js` (done): tuning constants, items DB, monster stats, POIs, `CT.rng(seed)`, `CT.bus`
3. `audio.js` -> `CT.audio`
4. `world.js` -> `CT.world`
5. `sky.js` -> `CT.sky`
6. `gore.js` -> `CT.gore`
7. `monsters.js` -> `CT.monsters`
8. `npcs.js` -> `CT.npcs`
9. `rpg.js` -> `CT.rpg`
10. `player.js` -> `CT.player`
11. `controls.js` -> `CT.controls`
12. `ui.js` -> `CT.ui`
13. `game.js` (core, done): loop, renderer and post-processing, states, integration, debug hooks

`dev.html` loads them with `<script src>`. `build.py` inlines everything into `../index.html` (one offline file served at games.johnslagboom.com/crimson-throne/).
Reference code from the kids game is in `ref/` (world_sky.js, hands.js, audio.js, world_ground.js, creatures.js, ui.js). Reuse its techniques freely (copy and adapt into YOUR file). Do not load `ref/` files.
Every module must tolerate the absence of every other module. Always check `if (CT.x && CT.x.fn)`. The core wraps every public module function in try/catch. A throw disables only that module and logs `[CT.module.fn]`, so never throw on the happy path.

## Rendering and colour
- The scene renders to a 640x360 HalfFloat target, then a post pass (core) does: ACES tone map, sRGB, a Frazetta grade (crushed warm shadows, rich reds and oranges, desaturated greens), a vignette, a red damage vignette (`core.hurtFlash` 0..1), a 4x4 Bayer dither and a posterise to 18 levels. It is then shown pixelated.
- Do NOT set `renderer.toneMapping`. Write normal hex colours. Set `texture.colorSpace = THREE.SRGBColorSpace` on colour canvas textures.
- Layers: `#gl` (3D, 640x360, pixelated) + `#px` (2D, 640x360, pixelated: first-person hands and weapon from `CT.player.drawHands`, screen blood from `CT.gore.drawScreen`) + `#ui` (2D, 1280x720, crisp: all UI and touch controls).
- Camera: PerspectiveCamera fov 70, near 0.1, far 1200. Fog is set by `CT.sky`.

## World frame
Metres, +Y up. The island is about 3000 x 3000 m, centred on the origin and ringed by sea and cliffs. The player starts on the south beach at about (0, *, 1250), facing north (-Z). The citadel of the Crimson Throne is at the far north, about (0, *, -1250), on a mountain. The POI list is in `CT.config.POIS` (id, name, type, x, z, radius). World must place real content at each POI.
Biomes by region: south = coast + meadows + farm villages; west = dark pine forest + wolf dens; east = swamp + ruins; centre = hills + standing stones + bandit camp; north = snow peaks + the black citadel. Biome transitions are smooth.

## Core object `CT.core` (created by game.js before any module init)
```
CT.core = {
  THREE, scene, camera, renderer,
  time, dt,                 // dt clamped to 0.05
  state,                    // 'GATE'|'TITLE'|'PLAY'|'PAUSE'|'INVENTORY'|'MAP'|'DIALOG'|'DEAD'|'VICTORY'
  input,                    // CT.controls.state (see controls) or a neutral stub
  hurtFlash,                // 0..1, core decays it; set by player.hurt
  shake(amount, seconds),   // camera shake request (core applies it after player.update sets the camera)
  torchLight,               // PointLight on the camera (player sets intensity/colour)
  hitStop(seconds),         // freeze gameplay dt briefly for impact feel (max 0.12)
  isTouch,                  // true on touch-first devices
  quality,                  // 'high' | 'low' (auto-detected; modules scale particle counts and view distance)
}
```

## Event bus `CT.bus` (config.js)
`CT.bus.on(name, fn)`, `CT.bus.emit(name, data)`. Standard events:
- `swing` {weapon, heavy}: player starts an attack
- `hit` {target, damage, point:Vector3, dir:Vector3, part, heavy, kill:false}: a weapon connected (monsters emit after applying damage)
- `sever` {monster, part, point, dir}: a limb or head came off
- `kill` {monster, type, point, dir, overkill, xp}: a monster died
- `playerHurt` {amount, dir, from}; `playerDeath` {}
- `loot` {item, count}; `levelUp` {level}; `quest` {id, stage, text}; `notify` {text, kind}
- `poi` {id, name}: player discovered a POI (world emits when within radius the first time)
- `dialog` {npc}: open dialog (npcs emit; core switches state to DIALOG; ui renders; ui action ends it)
- `victory` {}: the Bone King is slain (monsters or rpg emits; core shows VICTORY)

## Module contracts

### CT.world (world.js)
```
init(core)
update(dt, core)                 // stream chunks around core.camera.position; animate water, grass, fires, flags
heightAt(x, z) -> y              // terrain height (fast; called a lot)
normalAt(x, z) -> Vector3 (reused object OK)
biomeAt(x, z) -> 'coast'|'meadow'|'forest'|'swamp'|'hills'|'snow'|'citadel'
waterAt(x, z) -> depth (0 if dry)
collide(pos:Vector3, radius) -> pos   // push out of trees, rocks, walls, buildings (XZ); keep inside island bounds
raycast(origin, dir, maxDist) -> {point, dist} | null   // terrain + large static props (for torch light and AI line of sight)
pois                               // = CT.config.POIS, with `found` flags maintained
interiorAt?(x,z)                   // optional: true when under a roof (sky dims rain)
```
Streaming chunks (for example 64 m) with InstancedMesh vegetation. View distance is about 300 m (high) or 180 m (low). The fog hides the edge. Villages: timber houses, torches, a smithy, a tavern. Ruins: broken towers, arches, pillars. Bandit camp: tents, palisade, bonfire. Wolf dens: rock outcrops, bones. Standing stones with glowing runes. The citadel: a black gothic fortress with red-lit windows, a gate, a throne-room courtyard (the boss arena, flat, about 40 m wide) at the citadel POI. Swamp: dead trees and fog pools. Snow: pines and rocks. Also: roads connecting the POIs (dirt paths), rivers optional, sea with shore foam. Frazetta mood: silhouettes of dead trees against the sky, crags, skulls on stakes near dangerous places.

### CT.sky (sky.js)
```
init(core); update(dt, core)
timeOfDay                // 0..1 (0 = midnight, 0.25 = dawn, 0.5 = noon, 0.75 = dusk); a full day lasts about 16 real minutes
isNight() -> bool
setWeather(name, seconds) // 'clear' | 'storm' | 'fog' | 'bloodmoon'
flash(color, seconds)     // brief sky light flash (lightning, magic)
```
Owns scene.background, scene.fog, the sun/moon directional light, the hemisphere light, stars, a huge moon (which turns red at the blood moon), clouds, lightning, rain/snow (snow in the north), embers and ash near the citadel, and god rays at dusk. The Frazetta palette: dusk is molten orange and red with purple clouds, night is deep blue-black with a pale moon, and the blood moon is crimson.

### CT.gore (gore.js)
```
init(core); update(dt, core)
spray(point, dir, amount)                 // arterial spray: pixel blood droplets (instanced), they land and leave decals
burst(point, amount)                      // omnidirectional blood burst
pool(x, z, size)                          // growing blood pool decal on the ground
chunk(mesh, point, velocity, spin)        // a severed piece (limb, head) given as a THREE.Object3D; physics with bounce, a blood trail, it rests and stays for 60 s
gib(point, color, count)                  // body bursts into meaty chunks + bone shards + a big spray
bladeBlood(amount)                        // increases the blood on the player's blade (player reads CT.gore.blade 0..1)
screen(amount)                            // blood splatter on the camera (drawn by drawScreen)
drawScreen(ctx, t)                        // draws the screen blood onto the 640x360 #px canvas; drips run down and fade
```
Budget: the droplet pool is about 3000 (high) or 1000 (low), 300 decals as a ring buffer, and 60 chunks. Old ones recycle. Blood is dark red with highlight pixels, and it reads clearly at 640x360.

### CT.monsters (monsters.js)
```
init(core); update(dt, core)
list                                          // live monsters [{id, type, pos, hp, maxHp, state, ...}]
spawn(type, x, z, opts) -> monster
hitTest(origin, dir, range, arcRadians) -> [{monster, part, point, dist}]   // melee query (sorted by dist)
damage(monster, amount, dir, part, heavy) -> {killed, severed}   // applies hp, stagger, knockback, sever and gore calls, emits events
nearest(pos, maxDist) -> monster|null
inCombat                                      // bool: any monster is chasing/attacking the player (core picks combat music)
bossInfo() -> {name, hp, maxHp} | null        // non-null while a boss is engaged (ui shows the boss bar)
```
Types (stats are in `CT.config.MONSTERS`): `wolf` (pack of 3 to 5, fast, flanks), `ghoul` (shambling undead, groups, night), `bandit` (humanoid with weapons and shields, blocks, at the camp and the roads), `orc` (brute with a cleaver, charges), `troll` (huge, slow, sweeping club, the ground shakes), `wraith` (floating, swamp/night, phases), `boneKnight` (citadel elite guards), and `boneKing` (the BOSS on the Crimson Throne: 2 phases, summons, huge). Frazetta-grade silhouettes: hulking, snarling, horned, fanged. Built from primitives with a toon/flat shading and animated with procedural rigs (hierarchies of meshes: torso, head, arms, legs, so limbs can be severed). AI: idle, wander or patrol, notice (sight cone + hearing), chase, circle, attack with telegraphed wind-ups (readable), recover, flee at low hp (bandits, wolves), and a pack flank. Attacks call `CT.player.hurt(amount, dir, monster)` when they connect (the player may block or dodge; the player module decides the final damage). Spawning: population around the player by biome and time of day (more and worse at night and under the blood moon), fixed garrisons at POIs (camp bandits, citadel guards, the boss), a despawn far away, and a cap of about 30 alive (high) or 16 (low). Death: a ragdoll-ish collapse (procedural), the corpse stays for about 90 s, blood pools. Dismemberment: heavy hits or overkill sever arms, legs or the head (call `CT.gore.chunk` with the detached mesh) with arterial spray. A big overkill gibs the body. Finishers: when a monster is staggered at low hp, the player's heavy attack does a gorier kill (emit `kill` with overkill > 50).

### CT.npcs (npcs.js)
```
init(core); update(dt, core)
list                                    // [{id, name, pos, ...}]
nearestInteractable(pos, maxDist) -> npc|null    // the player shows a prompt; E / the interact button calls interact(npc)
interact(npc)                           // emits 'dialog' {npc}
dialog(npc) -> {name, portrait:canvas, lines:[text], choices:[{text, id}]}   // current dialog node
choose(npc, choiceId) -> 'close' | 'continue'  // advances the dialog, may call CT.rpg (start/advance quest, give item, trade)
portrait(id) -> HTMLCanvasElement       // a 256x320 procedurally painted portrait in a Frazetta palette (pixel-art painterly)
```
Characters:
- **Kaela Ironhand**: a warrior-queen in exile, black hair, a bronze war-helm under her arm, a fur mantle, battle-scarred and fierce. At the south village. She gives the MAIN QUEST.
- **Nyx of the Pale Moon**: a silver-haired sorceress in dark robes with moon jewellery, mysterious. At the eastern swamp ruins. She gives the magic side quest and later a blessing that lets you hurt the wraiths.
- **Vesna Red-Arrow**: a red-haired huntress in leathers with a longbow, cocky and warm. At the western forest lodge. She gives the wolf hunt side quest and sells bows or daggers.
- Also 6 to 12 villagers, a blacksmith (upgrades and trades), and a tavern keeper.
They have 3D pixel low-poly bodies that match their descriptions (Frazetta proportions, heroic poses, idle animation), stand at their POIs and face the player when near. They cannot be damaged (monsters ignore them; player hits pass through).

### CT.rpg (rpg.js)
```
init(core); update(dt, core)
stats  // {level, xp, xpNext, hpMax, staminaMax, str, gold}
inventory  // [{id, count}]
equipped   // {weapon, armor, charm}
weapon() -> item   // the current weapon's stats: damage, heavyMult, speed, reach, arc, bleed, style: 'sword'|'axe'|'greatsword'|'dagger'|'mace'|'crimson'
give(id, count); use(id); equip(id); has(id)
quests     // [{id, title, stage, text, done, target:{x,z}}]; activeQuest() -> quest
startQuest(id); advanceQuest(id, stage)
save(); load() -> bool; reset()       // localStorage 'crimsonThrone.save'
lootFor(monsterType) -> [{id,count}]   // drop table
```
It listens to `kill` (xp, quest counters, loot drops: emits `loot`), `poi` (quest progress), and `levelUp`. Items are in `CT.config.ITEMS`. The main quest runs: Talk to Kaela, then Clear the bandit camp, then Find Nyx in the swamp, then Take the Moonblade from the ruins' guardian, then Climb to the citadel, then Slay the Bone King (VICTORY). Side quests: Vesna's wolf hunt (kill the pack alpha, get a Red Bow charm), and Nyx's wraith cleansing. Autosave on quest progress and every 60 s.

### CT.player (player.js)
```
init(core); update(dt, core)        // movement, physics, camera, combat logic
pos, vel, yaw, pitch, hp, stamina, alive, blocking, dodging
prompt                              // text or null: interaction prompt for loot/chests (npc prompts are added by core)
god                                 // debug: when true, hurt() applies no damage
hurt(amount, dir, source) -> applied   // block reduces damage and uses stamina; perfect block (<0.2 s) staggers the attacker; dodge i-frames
heal(amount)
respawn()                           // at the last rested village/camp (a save point)
drawHands(ctx, t)                   // pixel-art first-person weapon (right) + torch or off-hand (left) on the 640x360 #px canvas
```
Movement: walk 4.5 m/s, sprint 8 m/s (uses stamina), jump, a gravity/ground snap using world.heightAt, collision via world.collide, water slows, and the camera bobs. Camera: yaw/pitch from input (mouse / touch look), plus shake. Combat: light attack (fast arc), heavy attack (hold to charge, a big arc and stagger), combo chains (3 lights), block (off-hand), dodge (a dash with i-frames, costs stamina). Hit detection via `CT.monsters.hitTest` at the right frame of the swing, then `CT.monsters.damage`. Hit feel: `core.hitStop(0.06)`, a shake, a spark, a blade blood increase (`CT.gore.bladeBlood`). Weapon styles change the swing animations and the drawn weapon (sword, axe, greatsword, dagger, mace, and the Crimson Blade with a glow). The torch lights the dark (the core has a PointLight at the camera; the player sets `core.torchLight.intensity`, and the torch can be sheathed with T for a shield/two-handed stance). Hands pixel art: muscular, tanned, with leather wraps, Frazetta-heroic, with blood that accumulates on the blade and the hands. Interaction: the interact input calls `CT.npcs.interact(nearest)`, or loots a corpse or chest (emits loot through rpg).

### CT.controls (controls.js)
```
init(core); update(dt, core)
state = { moveX, moveY (-1..1, +Y forward), lookDX, lookDY (radians this frame), sprint, jump, attack (pressed this frame),
          heavy (held seconds, released flag heavyRelease), block (held), dodge (pressed), interact (pressed), torch (pressed),
          inventory (pressed), map (pressed), pause (pressed), usePotion (pressed) }
drawTouch(ctx, t)       // 1280x720 UI canvas: virtual joystick (left), look area (right half), buttons: Attack (tap = light, hold = heavy), Block, Dodge, Jump, Use (interact, shown only when something is interactable), Potion, a menu button. Semi-transparent, big (at least 110 px), thumb-friendly, and the layout adapts to the letterboxed stage.
lock() / unlock()       // pointer lock for desktop (the core calls lock when entering PLAY on a click)
locked                  // bool, pointer lock is active
lostLock                // true for ONE frame when pointer lock was lost during PLAY (Esc on desktop): core pauses
_forceAttack / _forceHeavy  // debug flags: when set, make attack (or a full heavy charge + release) happen next frame, then clear them
```
Desktop: WASD/arrows to move, mouse look (pointer lock, sensitivity setting), LMB light/hold heavy, RMB block, Space jump, Shift sprint, Ctrl or Alt dodge (or double-tap a direction), E interact, T torch, Tab/I inventory, M map, Esc pause, Q potion. Mobile: the touch layout above. Pressed flags last exactly one frame. Everything is clamped and neutral when not in PLAY.

### CT.ui (ui.js)
```
draw(ctx, t, view)       // 1280x720
hit(x, y, view) -> action|null
key(e, view) -> action|null   // keyboard navigation for menus (arrows, Enter, Esc)
```
`view` = { state, player:{hp,hpMax,stamina,staminaMax}, rpg:{stats, inventory, equipped, quests, active}, compass:{yaw, markers:[{name, angle, dist, kind}]},
  prompt: text|null, dialog: {name, portrait, lines, choices}|null, notifications:[{text, kind, t}], hurt, isTouch, map:{pois, player:{x,z,yaw}}, saveExists, boss:{name,hp,maxHp}|null, victory }
Actions: {type:'gateYes'}, {type:'gateNo'}, {type:'newGame'}, {type:'continue'}, {type:'resume'}, {type:'close'}, {type:'equip', id}, {type:'use', id}, {type:'choice', id}, {type:'respawn'}, {type:'quitTitle'}, {type:'setting', key, value}
Screens:
- GATE: an 18+ age gate before anything, over a dark painted backdrop. "This game contains extreme violence and gore. Enter only if you are 18 or older." Buttons: [I am 18+] [Leave] (gateNo returns to https://games.johnslagboom.com/).
- TITLE: a massive Frazetta-style title: **CRIMSON THRONE** in blood-red and bronze display lettering with a heavy brushy texture and a shine, over the live 3D world (the core renders a slow cinematic camera flyover on the title). New Game / Continue (if a save exists) / Settings.
- HUD: health (red), stamina (gold), XP thin bar, a compass strip at the top with POI and quest markers, a quest tracker (top-right), an interaction prompt, notifications (loot, level up, discoveries: "DISCOVERED: The Weeping Fen"), a boss bar at the bottom when a boss is engaged, and a crosshair dot. Diegetic, ornate, bronze and iron frames.
- INVENTORY: a character sheet (level, stats), a weapons/armour/charms/potions list, and equip/use. MAP: a painted parchment map of Vael with POIs (found ones named), the player arrow and the quest target. PAUSE: resume/settings/save/quit. DIALOG: a big portrait (from CT.npcs.portrait) on the left, the name, text that types out, choices as big buttons (touch friendly). DEAD: "YOU HAVE FALLEN" in huge red with a slow fade, then [Rise again]. VICTORY: an ending screen (the Throne is broken, the three heroines, credits).

### CT.audio (audio.js)
```
init(); setMusic(name) // 'title'|'explore'|'night'|'combat'|'boss'|'victory'|'death'|null
sfx(name, opts)        // opts {pos:Vector3} for simple distance attenuation and pan
setVolume(master, music, sfx)
```
Dark, epic synthesised score: low brass drones, war drums (taiko-like), a male choir in minor modes (Phrygian and Aeolian), a hurdy-gurdy, bowed strings, and ritual percussion. Combat music ramps up. The boss music is massive. SFX: sword swish (light/heavy), flesh impacts (wet thuds and squelches), bone crunch, sever (a wet slice + spurt), gib (a splatter), block clang, parry ring, dodge whoosh, footsteps per surface (grass, stone, snow, water), player grunts, hurt and death, monster voices (wolf growl, snarl and howl, ghoul moan, orc roar, troll bellow, wraith shriek, bandit shout, Bone King voice), level-up choir hit, loot jingle, UI clicks, a fire crackle loop, wind, rain and thunder. Follow the crash-safety rules from ref/audio.js (no onended; per-loop buses disconnected by timer; look-ahead scheduler; voice cap; master limiter).

## Testing
`python tools/shot.py <out.png> [--wait ms] [--eval "js"] [--eval2 "js" --wait2 ms]` from `src/` opens `dev.html` in headless Chrome at 1280x720 ON THE REAL GPU (RTX 2070, D3D11), prints console and page errors, and saves a screenshot. Debug hooks (core): `CT.debug.play()` skips the gate and title into PLAY. `CT.debug.tp(x, z)` teleports. `CT.debug.spawn(type, dist)` spawns in front of you. `CT.debug.god(on)`. `CT.debug.give(id)`. `CT.debug.time(t)` sets the time of day. `CT.debug.weather(name)`. `CT.debug.attack(heavy)` does a player swing. `CT.debug.look(yaw, pitch)`. `CT.debug.state(name)`. `CT.debug.dialog(npcId)`. Look at your screenshots with the Read tool and iterate until the result is stunning. Never run taskkill on chrome.exe globally.
