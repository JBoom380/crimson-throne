# Overnight build plan: Blender character models (Option C)

**Goal:** replace every humanoid in Crimson Throne with real rigged, animated 3D models built in Blender. That covers the heroines, Selene, villagers, travellers, bandits, bone knights and the Bone King. All of them get one shared quality level, real anatomy and real skeletal animation, and the gore system keeps working.

**Start command:** John says "start the overnight build" before bed. This PC stays on, awake and logged in. Blender and the GPU run locally. A cloud agent cannot do this job.

## Starting point (verified on this PC)
- Blender 5.2 is installed at `C:\Program Files\Blender Foundation\Blender 5.2\`. It runs headless from scripts with `blender -b -P script.py`.
- The GPU is an RTX 2070 with 8 GB. Blender and the game's headless test browser must never use the GPU at the same time.
- Base meshes: the Blender Foundation "Human Base Meshes" asset bundle (CC0, free for any use). It has male and female bodies with clean topology. If the download fails, the fallback is a procedural base mesh built in bpy (skin modifier + remesh + sculpt passes).
- Rig: Rigify ships with Blender. Build a human metarig, then bake a simplified game skeleton of about 30 bones.
- Game side: bundle three.js `GLTFLoader` (r186 addon) into the single file, and store the models as base64 GLB with meshopt or quantized compression.

## Phases and checkpoints
Each phase writes a checkpoint file (`PLAN_C_progress.md`) so the run can resume after a crash or a usage limit.

1. **Bodies and skeleton (1 builder, about 1.5 h)**
   - Import the CC0 male and female bodies. Add the game skeleton and weight painting.
   - Add body shape keys: height, bulk, belly, muscle, age, and the female Frazetta hourglass (a separate key, so the heroines stay curvy).
   - Gate: T-pose renders and a deformation test (bend each joint to its limit) with no candy-wrapper twisting.
2. **Animation library (1 builder, about 1.5 h, in parallel with phase 3)**
   - Scripted keyframe clips on the shared skeleton:
     - idle, walk, run, talk, work-hammer, work-sweep
     - attack (1h, 2h), block, hit-react, stagger, death
     - sit, cheer, drink, smoke
   - The sex-specific walk has hip sway on the female body.
   - Gate: a turntable of each clip as a GIF strip.
3. **Outfits, hair, faces (2 builders, about 2 h)**
   - Separate meshes skinned to the same skeleton:
     - villager, smith, merchant, pilgrim, bard, hunter, militia
     - bandit (and Grask), knight, bone-knight armour, orc and ghoul skin variants
     - the 4 heroine outfits (Kaela, Nyx, Vesna, Selene), with the same coverage rules as now
   - Hair cards and hair meshes, and painted face textures (256 px) in a Frazetta palette.
   - Gate: a line-up render of every character, and John's approval of the heroines by screenshot in the morning.
4. **Export and loader (1 builder, about 1 h)**
   - Export compressed GLB files. Size budget: 6 MB total added to the file (heroines at about 400 KB each, shared body plus outfits, 2 MB of animations).
   - Build the `CT.charkit` module: load the GLBs, clone skinned meshes per NPC (SkeletonUtils), run an AnimationMixer per character with crossfades, and add LOD (lower-poly meshes past 40 m, animation throttling past 60 m).
   - Gate: 40 characters on screen at 60 fps on the RTX 2070, and a reasonable estimate for phones.
5. **Integration (2 to 3 builders, about 2 h)**
   - npcs.js and heroines.js: swap in the charkit models, and keep dialog, portraits and placement.
   - life.js: travellers.
   - monsters.js: the humanoid monsters (bandit, bone knight, ghoul, Bone King). The GORE must keep working: severing hides the bone's skinned vertices through a per-bone scale-to-zero, and spawns a separate "severed part" mesh of that limb at the joint. Stumps, arterial sprays and gibs all stay.
   - Gate: the full QA pass. That covers the main quest to VICTORY, the heroine dialogs, severing every limb, the soak test and the phone check.
6. **QA and publish (1 builder + lead)**
   - Before/after comparison screenshots for John.
   - If the gate passes, publish to games.johnslagboom.com/crimson-throne/. If not, leave the build unpublished and write a clear morning report.

## Rules for the run
- **No publish without the gate.** A broken build never goes live overnight.
- **Keep the fallback.** The Option A primitive kit (`humanoid.js`) stays as the fallback if a GLB fails to load.
- **Resume on usage limits.** Checkpoint after each phase, keep agent reports short, and use at most 4 builders in parallel. If the run hits a usage limit, it resumes after the reset.
- **Content rules unchanged.** Gore on monsters only, and the heroines stay non-explicit.
- **Morning report.** A short summary with the screenshots, what went live, what did not, and the next steps.

## Estimated total
About 8 to 10 agent-hours in 5 to 6 wall-clock hours, with most of the time spent on Blender scripting and screenshot iteration.
