# CCTV – live cameras for a Minecraft server (Fabric 26.3)

<!-- badges:start -->
<p align="center">
  <a href="https://github.com/DarienRahl/CCTV_Farbic/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/DarienRahl/CCTV_Farbic?style=for-the-badge&amp;label=release&amp;color=5d8c3e"></a>
  <img alt="Minecraft 26.3" src="https://img.shields.io/badge/minecraft-26.3-866043?style=for-the-badge">
  <img alt="Fabric, server side only" src="https://img.shields.io/badge/fabric-server%20side%20only-8b8b8b?style=for-the-badge">
  <a href="#roadmap"><img alt="Roadmap" src="https://img.shields.io/badge/roadmap-28%2F42%20done-80ff20?style=for-the-badge"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-555555?style=for-the-badge"></a>
</p>
<!-- badges:end -->

A **server-side only** mod. Place a "camera" in the world with a command and watch its live picture
in a web browser: players, mobs, opening doors and placed blocks show up right away.

- **Players do not need the mod.** They join with a normal vanilla client.
- **No extra Minecraft account and no bot.** Nobody has to be logged in for a camera to work.
- **The server renders nothing and needs no GPU.** It only sends light data: blocks, light, biomes
  and entity positions 20 times a second. All rendering happens in the browser (WebGL2).
- **Looks 1:1 like Minecraft 26.3.** Block meshes are built with the same algorithm as the client
  (model variants, plant offsets, *smooth lighting* with AO, face shading, 5×5 biome colour
  blending, fluids). Light, fog, sky, sun, moon phases, stars, sunrises and sunsets, clouds, rain,
  snow, thunderstorms with lightning and sky flashes, the End sky and **End flashes** are computed
  from the same environment attributes as in the game.
- **Every mob with its real model.** Model geometry is taken from `client.jar` (happy ghast, horses
  with coats and markings, wolves, cats, villagers with professions, cold/warm variants…), together
  with saddles, armour, elytra, collars, wool, harnesses and glowing eyes. Players have their own
  skins (or the game's default skin for their UUID) with the skin layers they chose, their capes
  (swinging as they move), and walk, sneak, swim and glide like in the game. Mobs play the game's
  own keyframe animations (sniffer, warden, frog, camel…) and react to entity events (attacks,
  sheep eating grass, wolves shaking off water); burning entities are wrapped in flames.
- **Blocks come alive.** Signs with their text, banners with patterns, decorated pots, player
  heads with skins, beacon beams, end portals with the game's own shader, food on campfires, the
  enchanting table's book turning to players, and the game's particles: torch and campfire flames
  and smoke, lava pops, drips, falling leaves, pieces of broken blocks, explosions, crits, hearts,
  villager moods and potion swirls.
- **Huge view distance.** A camera also sees terrain in unloaded chunks (read from the region files
  off the main thread, much like Bobby does), up to 1024 blocks.
- **Shaders and custom skies.** An optional "shaders" mode (sun shadows, waving plants, water with
  reflections, glow, sun rays), custom GLSL post effects and sky boxes, with defaults for every
  viewer set by the admin.

## Roadmap

<!-- roadmap:start -->
<p align="center"><img src="docs/images/roadmap/banner.svg" width="100%" alt="CCTV roadmap: 28 of 42 done"></p>

What is done and what comes next, milestone by milestone (the full plan with its principles is in
[docs/ROADMAP.md](docs/ROADMAP.md)).

<img src="docs/images/roadmap/1-1-x.svg" width="100%" alt="1.1.x — stability: released 1.1.3, 7 of 7 done">

<details>
<summary><b>1.1.x — stability</b> · released 1.1.3 · 7 of 7 done</summary>

- [x] Far terrain without holes in cliffs and hillsides (buried check looks at the neighbouring chunks towards the camera; nothing is skipped for cameras underground)
- [x] Flow control: sections are streamed at the speed of the connection
- [x] Turned view stays inside the streamed area
- [x] A broken block model no longer removes its section; solid far leaves; no plants in the camera's own block
- [x] Players walk, sneak, swim, crawl and glide like in the game; default skins by UUID
- [x] Name tags 1:1 (game font, scale, background, see-through text, lighting, visibility rules)
- [x] **1.1.3:** cameras stream again after a quiet minute (the empty server paused itself; a watched camera now keeps it awake); `/api/status` shows the session state

</details>

<img src="docs/images/roadmap/1-2.svg" width="100%" alt="1.2 — easy updates: released 1.2.0, 7 of 9 done">

<details>
<summary><b>1.2 — easy updates</b> · released 1.2.0 · 7 of 9 done</summary>

- [x] `docs/UPDATING.md`: the step-by-step update procedure and the list of game touch points
- [x] **Update workflow** (`update-minecraft.yml`): for a given game version it resolves Fabric Loader, Fabric API and Loom, bumps `gradle.properties` and `fabric.mod.json`, builds, runs the server test and pushes an `update/<version>` branch with a report
- [x] **Ported-classes diff**: `docs/ported-classes.txt` lists the game classes the viewer ports; the inspect workflow decompiles them for two versions and prints the diff
- [x] **Soft failures**: every feature that touches the game API catches `LinkageError`, logs once and switches itself off, so a newer game version degrades instead of crashing
- [x] **Keyframe animations from the game**: every `AnimationDefinition` in `client.jar` is read at run time and played by a port of `KeyframeAnimation`; the server reports running `AnimationState`s and entity events. Warden, sniffer, frog, camel, armadillo, bat, breeze, creaking, rabbit, copper golem, nautilus and baby axolotl move like in the game
- [x] Entity names from the game's language file, in any game language (`language` setting)
- [ ] **Automatic entity mapping**: read `EntityRenderers` from `client.jar` (bytecode) to map each entity type to its model layers and textures; the hand-written table only overrides. New mobs appear with their real model without code changes
- [x] Client-side animations from entity events: iron golem, ravager, hoglin and zoglin attacks, the ravager's stun and roar, sheep eating grass, wolves shaking off water and begging, goats ramming (events are queued, so none is lost when the viewer draws fewer frames than it gets)
- [ ] More of them: evoker fangs and spells, horse rearing and eating, fox and panda poses, the iron golem offering a flower

</details>

<img src="docs/images/roadmap/1-3.svg" width="100%" alt="1.3 — 1:1 picture: in progress - 1.3.0 is out, 13 of 19 done">

<details open>
<summary><b>1.3 — 1:1 picture</b> · in progress - 1.3.0 is out · 13 of 19 done</summary>

- [ ] **Reference renders in CI**: a Fabric client game test builds the CI scene in single player, takes a screenshot from the camera position with the game, and the viewer takes one from the same camera; both are published side by side with a difference score
- [x] **Signs and hanging signs** with their text in the game font (text sent by the server; boards and beds are block models in 26.3 and were already drawn)
- [x] **Banners with patterns** (and their sway), player heads with their owner's skin, pottery sherds on decorated pots
- [x] **Beacon beams** (BeaconRenderer: the beam sections the beacon computed, the turning beam and its glow, wider far away; re-read every 40 ticks like the beacon's own checks)
- [x] **End portal and end gateway** with the game's own `rendertype_end_portal` shader (15 and 16 layers over the End sky texture)
- [x] Food cooking on campfires (CampfireRenderer)
- [x] **Books on enchanting tables** (turning to the nearest player, opening and flipping pages) **and lecterns**
- [ ] Conduit, the end gateway beam, spawner and trial spawner contents, brushable blocks
- [x] **Particles** from `particles/*.json` and their textures: torch, candle and campfire flames and smoke, lava pops, drips, portal, falling leaves, spore blossoms, fireflies
- [x] **Particles from the server**: broken blocks (pieces of the block's texture), explosions and their smoke, the particles the server sends (`ClientboundLevelParticlesPacket`: crits, sweeps, hearts, dust...), level events (dispenser smoke, bone meal, lava fizz), death and spawn poofs, love hearts, villager moods and potion effect swirls
- [ ] More particles: rain splashes, item pieces (eating, breaking tools), fireworks, bubbles
- [x] Fire on burning entities (FlameFeatureRenderer, invisible ones too); invisible mobs show their equipment
- [x] Capes (from the player's Mojang profile, swinging like ClientAvatarState's cloak), elytra (ElytraAnimationState, the cape as elytra texture), the skin layers a player turned off
- [x] **Entity shadows** like EntityRenderer.extractShadow: `shadow.png` on the tops of the blocks below, fading with depth and in the dark, only within 16 blocks of the camera
- [x] **Enchantment glint** on held, dropped and framed items, armour and elytra (the 26.3 glint pipelines: the glint texture through TextureTransform's moving matrix, added in the same pass)
- [x] **Leashes** (LeashFeatureRenderer: the crossed ribbons from the entity to the holder's hand or the knot, sagging, lit at both ends; the four ropes of a happy ghast's harness)
- [ ] Entity details: armour trims, item frames with maps, fishing lines, glowing outlines
- [ ] Terrain: the game's chunk occlusion culling (visibility graph), block breaking progress, remaining fluid edge cases, the biome blend setting
- [ ] Camera in water, lava and powder snow: the game's overlays and fog

</details>

<img src="docs/images/roadmap/1-4.svg" width="100%" alt="1.4 — performance: started, 1 of 7 done">

<details>
<summary><b>1.4 — performance</b> · started · 1 of 7 done</summary>

- [ ] Binary section messages instead of JSON with base64 (sections are already palette + run-length encoded and gzipped, so this saves roughly a quarter; lower priority)
- [ ] **Section cache in the browser** (IndexedDB) keyed by camera and section version: reopening a camera shows the world immediately
- [ ] Server memory: far sections kept only in encoded form, re-read when their chunk changes
- [ ] Occlusion culling (see 1.3) and per-section culling inside merged regions
- [ ] Entities: skinning on the GPU (bone matrices in a texture) instead of rebuilding vertices on the CPU every frame
- [x] Video wall: frame rate cap (lower for small tiles), one pixel per CSS pixel, no rendering for tiles that are off screen or in a hidden tab
- [ ] Budgets in CI: server milliseconds per camera tick, bytes per section, browser frame time

</details>

<img src="docs/images/roadmap/later.svg" width="100%" alt="Later: ideas for later, 3 ideas">

<details>
<summary><b>Later</b> · ideas for later · 3 ideas</summary>

- Items in the world with their 26.x item model definitions (`items/*.json`) and properties
- Block entity and entity animations driven by server events (chest lids, bell swings, door and piston movement)
- Optional recording and timelapse of a camera

</details>

<sub>The pictures are pixel art drawn by `.github/scripts/roadmap.py` from docs/ROADMAP.md (no game textures); CI checks that they are up to date.</sub>
<!-- roadmap:end -->

## Requirements

- a **Fabric** server for Minecraft **26.3** (Fabric Loader ≥ 0.19.5),
- **Fabric API**,
- **Java 25**.

## Installation

1. Get `cctv-fabric-<version>.jar`:
   - from the **Releases** page of this repository (latest release), or
   - from the **Actions** tab (the `cctv-fabric` artifact of every build), or
   - build it yourself: `./gradlew build`. The jar ends up in `build/libs/`.
2. Put it into the server's `mods/` folder, next to Fabric API.
3. Start the server. The log shows `CCTV web server listening on http://0.0.0.0:8100/`.
4. Open port **8100/TCP** in your firewall or at your host. The port can be changed in the config.

On the first start the mod downloads the `client.jar` of the same game version from Mojang's
official servers (about 30 MB, once, stored in `config/cctv/assets/`), the same way launchers and
map renderers such as BlueMap do. Only textures, block models and mob model geometry are taken from
it for the browser (the geometry is cached in `entity-models-<version>.json.gz`, so it is not read
on every start). **Nothing is sent to players.** If the server has no internet access, put
`client.jar` into `config/cctv/assets/` yourself. You can also turn the download off
(`downloadClientAssets: false`); the viewer then uses plain colours.

## Commands

They need operator permissions (level 2). Anyone can use `list` and `url`.

| Command | Description |
|---|---|
| `/cctv create <name>` | Places a camera at your eye height, looking where you look |
| `/cctv create <name> <x y z> [<yaw> <pitch>]` | Camera at the given position (`~ ~ ~` = your eye height, `^ ^ ^` relative to your eyes) |
| `/cctv move <name> [<x y z> [<yaw> <pitch>]]` | Moves a camera (to your position by default) |
| `/cctv aim <name> [<x y z>]` | Points a camera at a position (at you by default) |
| `/cctv fov <name> <degrees>` | Field of view (10–140°, default 70) |
| `/cctv range <name> <blocks>` | View distance (16–`maxRange`, default 96) |
| `/cctv remove <name>` | Removes a camera |
| `/cctv list` | Lists cameras with clickable links |
| `/cctv url [<name>]` | Link to the viewer |
| `/cctv info <name>` | Camera details |
| `/cctv reload` | Reloads the viewer settings (`viewer`), shaders and sky boxes |

In game a camera shows up as a small observer block (a `block_display` entity that every vanilla
client can see). Turn this off with the `markers` option. `execute in <dimension> run cctv create ...`
works too.

Live content (mobs, block changes, light) comes from **loaded chunks**. Terrain further away
(`farTerrain`) is read from the saved world files without loading chunks and refreshed from time to
time. If a camera should show movement while nobody is nearby, keep the area loaded, e.g.
`/forceload add <x1> <z1> <x2> <z2>`.

## Browser viewer

- `http://SERVER-IP:8100/` shows the camera list and a **video wall** (all cameras at once).
- `http://SERVER-IP:8100/cam/<name>` shows a single camera.

Drag with the mouse to look around, use the wheel to zoom and double-click to go back to the
camera's view. The view turns only as far as the terrain the server streams around the camera's
direction (about 20° beyond the picture); aim the camera with `/cctv aim` to look elsewhere. **⚙ Settings** has: graphics (vanilla / shaders) and shader quality, post effect
(custom shader), sky (sky box), clouds, camera mode (colour / black and white / night vision),
render resolution (for weak GPUs), name tags, mob labels, particles and the CCTV effect. Each viewer's
choice is remembered in their browser.

Name tags look exactly like in the game: Minecraft's own font from `client.jar`, floating half a
block above the head at the game's scale, with the translucent background, lit like the entity and
dimmed for sneaking players. They follow the game's rules (players within 64 blocks, 32 when
sneaking; mobs whose custom name is set to always show) and are only drawn for entities the camera
can really see. "Mob labels" adds tags for every other mob (its custom name or its type).

### Shaders, post effects and sky boxes

- **"Shaders" graphics** works in any browser with WebGL2: shadows from the sun and the moon,
  waving leaves and grass, waves and reflections on water, glowing bright blocks and sun rays. The
  quality (low–ultra) changes the shadow resolution and distance.
- **Post effects**: files `config/cctv/shaders/<name>.glsl` with a `vec4 postProcess(vec2 uv)`
  function (available: `uScene`, `uDepth`, `uResolution`, `uTime`, `uDaylight`, `uRain`,
  `linearDepth(uv)`). The examples `sepia.glsl` and `security-camera.glsl` are copied on the first
  start.
- **Sky boxes**: a folder `config/cctv/skyboxes/<name>/` with six faces `px nx py ny pz nz`
  (png/jpg/webp) or a single panorama `config/cctv/skyboxes/<name>.jpg`, optionally with
  `<name>.json` holding `brightness`, `followDaylight`, `rotateWithSun`, `showSun`, `showClouds`
  (see `config/cctv/skyboxes/README.txt`). A `sunset` panorama is included as an example.
- **Defaults for everybody**: the `viewer` section in `config.json` (e.g.
  `"viewer": {"graphics": "shaders", "skyboxes": {"minecraft:overworld": "sunset"}, "postShader": "sepia"}`),
  then `/cctv reload`. `lockSettings: true` stops viewers from changing them.

## Configuration – `config/cctv/config.json`

| Key | Default | Description |
|---|---|---|
| `bindAddress` | `0.0.0.0` | Web server address |
| `port` | `8100` | Web server port |
| `accessToken` | `""` | When set, the viewer needs `?token=...` (remembered in a cookie). Operators get a link with the token from `/cctv url` |
| `publicUrl` | `""` | Address used for links in chat, e.g. `http://mc.example.com:8100` |
| `defaultFov` / `defaultRange` / `maxRange` | `70` / `96` / `512` | Settings for new cameras (`maxRange` up to 1024) |
| `farTerrain` | `true` | Terrain in unloaded chunks is read from the region files (long view distance) |
| `entityRange` | `128` | How far away entities are sent |
| `entityUpdateTicks` | `1` | Send entities every N ticks (1 = 20×/s) |
| `sectionsPerTick` | `96` | How many 16³ sections a camera may copy per tick while loading |
| `workerThreads` | half the cores (1–4) | Threads that decode sections and read world files off the main thread |
| `rescanSeconds` | `5` | Full re-check of the area every N seconds (safety net) |
| `downloadClientAssets` | `true` | Download textures/models from Mojang's `client.jar` |
| `language` | `en_us` | Language of mob names in the viewer (`pl_pl`, `de_de`…; downloaded from Mojang once) |
| `gzip` | `true` | Compress the stream |
| `skins` | `true` | Player skins (the server fetches them from the Mojang API and caches them) |
| `markers` | `true` | Camera marker block in the world |
| `maxViewersPerCamera` | `16` | Viewer limit per camera |
| `viewer` | | Viewer defaults: `graphics` (`vanilla`/`shaders`), `shaderQuality` (`low`…`ultra`), `postShader`, `skyboxes` (dimension → name), `clouds` (`fancy`/`fast`/`off`), `labels`, `mobLabels`, `particles`, `mode` (`color`/`mono`/`night`), `cctvEffect`, `lockSettings` |

Resource packs (`*.zip`) put into `config/cctv/resourcepacks/` override block textures and models
in the viewer, for example to match the server's resource pack.

## How it works

```
Server (no GPU)                                      Browser (WebGL2)
────────────────────────                             ──────────────────────────────
main thread: copy of sections (palette, light) ─┐
worker threads: decoding, JSON, region files    ├─► Web Workers: section meshes like SectionCompiler
block change (mixin) ──► "blocks" right away    │     (models from client.jar, AO, biomes, fluids)
every tick ──► entities (position, walk         └─► GPU: section regions, 26.3 lightmap, fog,
               animation, variants, equipment…)       sky, clouds, weather, End, mob models
every 5 ticks ──► environment attributes at the camera
               (sky, fog, light, sun, rain, End flashes)
```

- Data flows over **Server-Sent Events** (plain HTTP, works through proxies and nginx).
- The server never loads chunks: it reads loaded ones and takes the rest from the saved files (the
  server's IO thread plus the mod's worker threads). The main thread only copies section data;
  decoding, compression and JSON happen elsewhere. Empty air and far sections hidden inside the
  ground are not sent (a section counts as hidden only when it lies below the surface of its own
  chunk and of the neighbouring chunks towards the camera, so cliffs and hillsides stay complete;
  nothing is skipped while the camera itself is underground).
- A viewer gets the world as fast as its connection takes it: new sections wait while earlier ones
  are still queued, so slow connections never overflow and restart.
- Server cost per camera with viewers: a one-time copy of the sections (spread over ticks), the
  entity list in the camera's range every tick and a few to a few dozen KB/s per viewer (depending
  on the number of entities). A camera without viewers costs nothing (its cache is released after a
  minute).
- The picture is about 100–150 ms behind (a buffer that smooths entity movement).

## API (to build your own page)

All endpoints support CORS and `?token=` (when a token is set).

| Endpoint | Content |
|---|---|
| `GET /api/cameras` | Camera list (JSON) |
| `GET /api/cameras/{name}/stream` | SSE stream, events below |
| `GET /assets/bundle.json` | Block states, block models and textures (from client.jar) |
| `GET /assets/models.json` | Mob model geometry (layers from `LayerDefinitions`) |
| `GET /assets/entities.json`, `/assets/entity/{path}.png` | Mob textures |
| `GET /assets/misc/{path}.png` | Textures of `textures/misc` (the entity shadow) |
| `GET /assets/painting/{name}.png` | Paintings |
| `GET /assets/font/{path}` | The game's font (`default.json`, glyph sheets such as `ascii.png`) |
| `GET /api/viewer` | Viewer defaults, list of shaders and sky boxes |
| `GET /custom/shaders/{name}.glsl`, `/custom/skyboxes/...` | Shader and sky box files from `config/cctv` |
| `GET /skin/{uuid}?name=` | Player skin (PNG, `X-Skin-Model` header) |
| `GET /cape/{uuid}?name=` | Player cape (PNG, 404 without a cape) |

Stream events:

- `init`: `{camera:{name,dimension,x,y,z,yaw,pitch,fov,range}, sections, biomes:{id:{t,d,w,g?,f?,m}}, entityTicks,
  dim:{id,skybox,cardinal,hasSky,ambient,endFlashes,minY,height,horizon,zoomSeed}}`; the world is sent from scratch after it;
- `progress`: `{d, t}` loading progress;
- `palette`: `{s:[{id, n:"minecraft:oak_stairs", s:"facing=north,…", c:mapColor, f:flags, b:[[x0,y0,z0,x1,y1,z1]…], l:light, lv:fluid level}]}`;
- `section`: `{x,y,z, p:[id…], r:RLE, sl:sky light RLE, bl:block light RLE, bp:[biomes], bi:4³ indices}`,
  where RLE is base64 of varint pairs `(length, value)` in YZX order;
- `blocks`: `{b:[[x,y,z,id]…]}`, instant block changes;
- `entities`: `{t:tick, e:[{id,type,x,y,z,yaw,pitch,body,head,w,h,age,walk,walkSpeed,scale?,name?,uuid?,pose?,sneak?,baby?,
  hurt?,dead?,swing?,hand?,offhand?,saddle?,bodyArmor?,armor?,item?,seed?, d:{variant?, markings?, villager?, color?, …}}]}`;
- `env`: environment attributes at the camera: `{time, clock, gt, rain, thunder, sky, fog, sunrise, cloud, cloudHeight, sunAngle,
  moonAngle, starAngle, stars, moonPhase, skyLight, skyFactor, ambient, blockTint, fogStart, fogEnd, skyFogEnd, …, flash?}`;
- `weather`: rain/snow columns around the camera `{x, z, size, h:[heights], p:"rsn…"}`;
- `ready`: the whole visible area has been sent;
- `removed`: the camera was removed.

## Development

- The plan: [docs/ROADMAP.md](docs/ROADMAP.md). Moving to a new Minecraft version:
  [docs/UPDATING.md](docs/UPDATING.md).
- The roadmap on this page (pictures and lists) is generated from docs/ROADMAP.md: run
  `python3 .github/scripts/roadmap.py` after editing it. CI fails when it is out of date.
- `GET /api/status` shows the live camera sessions (how far each viewer got, queued messages) when
  something does not stream as expected.
- New release: bump `version` in `gradle.properties`, add notes in `docs/release-notes/v<version>.md`
  and push the tag `v<version>` or run the `release` workflow by hand in the Actions tab. The
  workflow builds the mod, creates the tag and publishes the release with the jar.
- The web page lives in `src/main/resources/web/` (plain JS, no bundler, no libraries).
- Start the server with `-Dcctv.webDir=/path/to/src/main/resources/web` to see changes to the page
  after a refresh, without a restart.
- CI (`.github/workflows/build.yml`) builds the mod, starts a real 26.3 server with it and places a
  camera over RCON. It checks the stream (sections, light, entities 20×/s, instant block changes),
  the assets and entity models, then takes screenshots of the viewer in Chromium, vanilla and
  shaders (artifact `server-test`).

## Limitations

- Shield patterns are not drawn (only the base colour).
- Sounds and chest opening animations are not played. Rain splashes, item pieces (eating, breaking
  tools), fireworks and bubbles have no particles yet.
- Terrain in unloaded chunks shows the state of the last world save.
- Textures and models from `client.jar` are not part of this repository. The mod downloads them
  from Mojang's servers on a server that runs the game.

## License

MIT – see [LICENSE](LICENSE). Minecraft is a trademark of Mojang/Microsoft. This mod is not
affiliated with Mojang.
