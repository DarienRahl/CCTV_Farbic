# CCTV – live cameras for a Minecraft server (Fabric 26.3)

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
  with saddles, armour, collars, wool, harnesses and glowing eyes. Players have their own skins.
- **Huge view distance.** A camera also sees terrain in unloaded chunks (read from the region files
  off the main thread, much like Bobby does), up to 1024 blocks.
- **Shaders and custom skies.** An optional "shaders" mode (sun shadows, waving plants, water with
  reflections, glow, sun rays), custom GLSL post effects and sky boxes, with defaults for every
  viewer set by the admin.

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
camera's view. **⚙ Settings** has: graphics (vanilla / shaders) and shader quality, post effect
(custom shader), sky (sky box), clouds, camera mode (colour / black and white / night vision),
render resolution (for weak GPUs), player names, mob labels and the CCTV effect. Each viewer's
choice is remembered in their browser. Names and labels are only shown for entities that are
really visible (not through walls).

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
| `gzip` | `true` | Compress the stream |
| `skins` | `true` | Player skins (the server fetches them from the Mojang API and caches them) |
| `markers` | `true` | Camera marker block in the world |
| `maxViewersPerCamera` | `16` | Viewer limit per camera |
| `viewer` | | Viewer defaults: `graphics` (`vanilla`/`shaders`), `shaderQuality` (`low`…`ultra`), `postShader`, `skyboxes` (dimension → name), `clouds` (`fancy`/`fast`/`off`), `labels`, `mobLabels`, `mode` (`color`/`mono`/`night`), `cctvEffect`, `lockSettings` |

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
  decoding, compression and JSON happen elsewhere. Sections buried deep under the surface and
  empty air are not sent.
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
| `GET /assets/painting/{name}.png` | Paintings |
| `GET /api/viewer` | Viewer defaults, list of shaders and sky boxes |
| `GET /custom/shaders/{name}.glsl`, `/custom/skyboxes/...` | Shader and sky box files from `config/cctv` |
| `GET /skin/{uuid}?name=` | Player skin (PNG, `X-Skin-Model` header) |

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

- Mob animations that use keyframes in the game (e.g. sniffer, warden, frog, armadillo) are
  simplified: head and legs move, but without the full sequences. Banner and shield patterns are
  not drawn (only the base colour).
- Particles, sounds and chest opening animations are not drawn.
- Terrain in unloaded chunks shows the state of the last world save.
- Textures and models from `client.jar` are not part of this repository. The mod downloads them
  from Mojang's servers on a server that runs the game.

## License

MIT – see [LICENSE](LICENSE). Minecraft is a trademark of Mojang/Microsoft. This mod is not
affiliated with Mojang.
