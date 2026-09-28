# CCTV roadmap

The goal: the camera picture in the browser is **indistinguishable from the Minecraft client**
looking from the same place at the same moment, it stays **smooth** with big view distances and on
weak machines, and moving to a **new Minecraft version is routine and mostly automatic**.

This file is the plan of record. Items are ticked off as they ship; each release note links back
to the milestone it belongs to.

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

## 1.1.x — stability (released: 1.1.2)

- [x] Far terrain without holes in cliffs and hillsides (buried check looks at the neighbouring
      chunks towards the camera; nothing is skipped for cameras underground)
- [x] Flow control: sections are streamed at the speed of the connection
- [x] Turned view stays inside the streamed area
- [x] A broken block model no longer removes its section; solid far leaves; no plants in the
      camera's own block
- [x] Players walk, sneak, swim, crawl and glide like in the game; default skins by UUID
- [x] Name tags 1:1 (game font, scale, background, see-through text, lighting, visibility rules)
- [ ] **1.1.3:** camera sessions that went idle stream again to the next viewer
      (reproduced in CI; `/api/status` shows the session state)

## 1.2 — easy updates

- [x] `docs/UPDATING.md`: the step-by-step update procedure and the list of game touch points
- [x] **Update workflow** (`update-minecraft.yml`): for a given game version it resolves Fabric
      Loader, Fabric API and Loom, bumps `gradle.properties` and `fabric.mod.json`, builds, runs
      the server test and pushes an `update/<version>` branch with a report
- [x] **Ported-classes diff**: `docs/ported-classes.txt` lists the game classes the viewer ports;
      the inspect workflow decompiles them for two versions and prints the diff
- [x] **Soft failures**: every feature that touches the game API catches `LinkageError`, logs once
      and switches itself off, so a newer game version degrades instead of crashing
- [ ] **Automatic entity mapping**: read `EntityRenderers` from `client.jar` (bytecode) to map each
      entity type to its model layers and textures; the hand-written table only overrides. New
      mobs appear with their real model without code changes
- [ ] **Keyframe animations from the game** (`AnimationDefinition` → JSON): sniffer, warden, frog,
      camel, armadillo, breeze, bat, creaking… played exactly as in the game, automatically for
      new mobs that use them
- [ ] Entity names from the game's language file (mob labels, item names)

## 1.3 — 1:1 picture

- [ ] **Reference renders in CI**: a Fabric client game test builds the CI scene in single
      player, takes a screenshot from the camera position with the game, and the viewer takes
      one from the same camera; both are published side by side with a difference score
- [x] **Signs and hanging signs** with their text in the game font (text sent by the server; boards and
      beds are block models in 26.3 and were already drawn)
- [ ] **Banners with patterns**, player heads with skins, conduit, lectern and
      enchanting table books, beacon beams, end portal and end gateway effect, spawner and
      trial spawner contents, campfire items, brushable blocks, decorated pot patterns
- [ ] **Particles** from `particles/*.json` and their textures: torch, candle and campfire flames
      and smoke, lava pops, drips, portal, falling leaves, spore blossoms, rain splashes
- [ ] Entity details: fire on burning entities, the game's shadow texture projected on blocks,
      enchantment glint, armour trims, capes and elytra, item frames with maps, leashes, fishing
      lines, glowing outlines
- [ ] Terrain: the game's chunk occlusion culling (visibility graph), block breaking progress,
      remaining fluid edge cases, the biome blend setting
- [ ] Camera in water, lava and powder snow: the game's overlays and fog

## 1.4 — performance

- [ ] **Binary section format** (palette + packed indices, run-length light) instead of JSON and
      base64: several times smaller and faster to decode (in the worker)
- [ ] **Section cache in the browser** (IndexedDB) keyed by camera and section version: reopening
      a camera shows the world immediately
- [ ] Server memory: far sections kept only in encoded form, re-read when their chunk changes
- [ ] Occlusion culling (see 1.3) and per-section culling inside merged regions
- [ ] Entities: skinning on the GPU (bone matrices in a texture) instead of rebuilding vertices on
      the CPU every frame
- [ ] Video wall: frame rate cap and lower resolution for small tiles, no rendering for tiles that
      are off screen or in a hidden tab
- [ ] Budgets in CI: server milliseconds per camera tick, bytes per section, browser frame time

## Later

- Items in the world with their 26.x item model definitions (`items/*.json`) and properties
- Block entity and entity animations driven by server events (chest lids, bell swings, door and
  piston movement)
- Optional recording and timelapse of a camera
