# CCTV roadmap

The goal: the camera picture in the browser is **indistinguishable from the Minecraft client**
looking from the same place at the same moment, it stays **smooth** with big view distances and on
weak machines, and moving to a **new Minecraft version is routine and mostly automatic**.

This file is the plan of record. Items are ticked off as they ship; each release note links back
to the milestone it belongs to. The roadmap on the README page is drawn from this file by
`.github/scripts/roadmap.py` (run it after a change; CI checks it).

## Principles

1. **Game data instead of copies.** Everything that exists as data in `client.jar` is read at run
   time: block and item models, textures and animations, entity model layers, keyframe animations,
   the font, particle definitions, language files, colormaps, sky textures. A new game version
   brings its new blocks, mobs and textures with it.
2. **Faithful ports where the game uses code.** Where the client computes something in Java
   (lightmap, fog, sky, clouds, weather, `setupAnim`, renderers), the viewer ports the 26.3 code
   one to one and names the game class in a comment. Updating means diffing those classes between
   versions (see [UPDATING.md](UPDATING.md)).
3. **One small surface on the server.** Game APIs are used in a handful of files (list in
   UPDATING.md). Features that touch the game degrade instead of crashing when an API changes.
4. **Measure against the real client.** CI renders the same scene with the real game and with the
   viewer; differences are visible side by side instead of guessed.
5. **Budgets, not hopes.** Server time per camera, bytes per section and browser frame time are
   measured in CI.

## 1.1.x — stability (released: 1.1.3)

- [x] Far terrain without holes in cliffs and hillsides (buried check looks at the neighbouring
      chunks towards the camera; nothing is skipped for cameras underground)
- [x] Flow control: sections are streamed at the speed of the connection
- [x] Turned view stays inside the streamed area
- [x] A broken block model no longer removes its section; solid far leaves; no plants in the
      camera's own block
- [x] Players walk, sneak, swim, crawl and glide like in the game; default skins by UUID
- [x] Name tags 1:1 (game font, scale, background, see-through text, lighting, visibility rules)
- [x] **1.1.3:** cameras stream again after a quiet minute (the empty server paused itself; a
      watched camera now keeps it awake); `/api/status` shows the session state

## 1.2 — easy updates (released: 1.2.0)

- [x] `docs/UPDATING.md`: the step-by-step update procedure and the list of game touch points
- [x] **Update workflow** (`update-minecraft.yml`): for a given game version it resolves Fabric
      Loader, Fabric API and Loom, bumps `gradle.properties` and `fabric.mod.json`, builds, runs
      the server test and pushes an `update/<version>` branch with a report
- [x] **Ported-classes diff**: `docs/ported-classes.txt` lists the game classes the viewer ports;
      the inspect workflow decompiles them for two versions and prints the diff
- [x] **Soft failures**: every feature that touches the game API catches `LinkageError`, logs once
      and switches itself off, so a newer game version degrades instead of crashing
- [x] **Keyframe animations from the game**: every `AnimationDefinition` in `client.jar` is read
      at run time and played by a port of `KeyframeAnimation`; the server reports running
      `AnimationState`s and entity events. Warden, sniffer, frog, camel, armadillo, bat, breeze,
      creaking, rabbit, copper golem, nautilus and baby axolotl move like in the game
- [x] Entity names from the game's language file, in any game language (`language` setting)
- [ ] **Automatic entity mapping**: read `EntityRenderers` from `client.jar` (bytecode) to map each
      entity type to its model layers and textures; the hand-written table only overrides. New
      mobs appear with their real model without code changes
- [x] Client-side animations from entity events: iron golem, ravager, hoglin and zoglin attacks,
      the ravager's stun and roar, sheep eating grass, wolves shaking off water and begging, goats
      ramming (events are queued, so none is lost when the viewer draws fewer frames than it gets)
- [ ] More of them: evoker fangs and spells, horse rearing and eating, fox and panda poses, the
      iron golem offering a flower

## 1.3 — 1:1 picture (first part released: 1.3.0)

- [ ] **Reference renders in CI**: a Fabric client game test builds the CI scene in single
      player, takes a screenshot from the camera position with the game, and the viewer takes
      one from the same camera; both are published side by side with a difference score
- [x] **Signs and hanging signs** with their text in the game font (text sent by the server; boards and
      beds are block models in 26.3 and were already drawn)
- [x] **Banners with patterns** (and their sway), player heads with their owner's skin, pottery
      sherds on decorated pots
- [x] **Beacon beams** (BeaconRenderer: the beam sections the beacon computed, the turning beam
      and its glow, wider far away; re-read every 40 ticks like the beacon's own checks)
- [x] **End portal and end gateway** with the game's own `rendertype_end_portal` shader (15 and
      16 layers over the End sky texture)
- [x] Food cooking on campfires (CampfireRenderer)
- [x] **Books on enchanting tables** (turning to the nearest player, opening and flipping pages)
      **and lecterns**
- [ ] Conduit, the end gateway beam, spawner and trial spawner contents, brushable blocks
- [x] **Particles** from `particles/*.json` and their textures: torch, candle and campfire flames
      and smoke, lava pops, drips, portal, falling leaves, spore blossoms, fireflies
- [ ] More particles: rain splashes, entity particles (hearts, villager emotions, potion swirls),
      block breaking, explosions and the particles the server sends (`ClientboundLevelParticlesPacket`)
- [x] Fire on burning entities (FlameFeatureRenderer, invisible ones too); invisible mobs show
      their equipment
- [x] Capes (from the player's Mojang profile, swinging like ClientAvatarState's cloak), elytra
      (ElytraAnimationState, the cape as elytra texture), the skin layers a player turned off
- [x] **Entity shadows** like EntityRenderer.extractShadow: `shadow.png` on the tops of the blocks
      below, fading with depth and in the dark, only within 16 blocks of the camera
- [x] **Enchantment glint** on held, dropped and framed items, armour and elytra (the 26.3 glint
      pipelines: the glint texture through TextureTransform's moving matrix, added in the same pass)
- [x] **Leashes** (LeashFeatureRenderer: the crossed ribbons from the entity to the holder's hand
      or the knot, sagging, lit at both ends; the four ropes of a happy ghast's harness)
- [ ] Entity details: armour trims, item frames with maps, fishing lines, glowing outlines
- [ ] Terrain: the game's chunk occlusion culling (visibility graph), block breaking progress,
      remaining fluid edge cases, the biome blend setting
- [ ] Camera in water, lava and powder snow: the game's overlays and fog

## 1.4 — performance

- [ ] Binary section messages instead of JSON with base64 (sections are already palette +
      run-length encoded and gzipped, so this saves roughly a quarter; lower priority)
- [ ] **Section cache in the browser** (IndexedDB) keyed by camera and section version: reopening
      a camera shows the world immediately
- [ ] Server memory: far sections kept only in encoded form, re-read when their chunk changes
- [ ] Occlusion culling (see 1.3) and per-section culling inside merged regions
- [ ] Entities: skinning on the GPU (bone matrices in a texture) instead of rebuilding vertices on
      the CPU every frame
- [x] Video wall: frame rate cap (lower for small tiles), one pixel per CSS pixel, no rendering
      for tiles that are off screen or in a hidden tab
- [ ] Budgets in CI: server milliseconds per camera tick, bytes per section, browser frame time

## Later

- Items in the world with their 26.x item model definitions (`items/*.json`) and properties
- Block entity and entity animations driven by server events (chest lids, bell swings, door and
  piston movement)
- Optional recording and timelapse of a camera
