# Updating to a new Minecraft version

The mod is small on purpose where it touches the game. Most of what the viewer shows (block and
item models, textures, entity models, the font, sky textures) is read from the game's
`client.jar` at run time, so a new version brings its content along. What remains is a short list
of game APIs on the server and a set of client classes the viewer ports to JavaScript.

## Procedure

1. **Run the `update-minecraft` workflow** with the new version. It finds the matching Fabric
   Loader and Fabric API, updates `gradle.properties` and `fabric.mod.json`, pushes the branch
   `update/<version>` and runs the build and the server test on it (steps 2 and 3). By hand: bump
   `minecraft_version`, `loader_version`, `fabric_api_version` (and `loom_version` if needed) and
   the `minecraft` range in `fabric.mod.json`; current values are on
   <https://fabricmc.net/develop/>.
2. **Build** (`./gradlew build`, or push and let the `build` workflow do it). Compile errors point
   at the touch points below; fix them there.
3. **Run the server test** (the `server-test` job of the `build` workflow). It starts a real
   dedicated server, builds a scene, streams two cameras and saves viewer screenshots. A green run
   with sensible screenshots means the server side works.
4. **Check the ported client code.** Run the `inspect-minecraft` workflow with `version` set to
   the new version and `compare_with` set to the old one. It decompiles every class listed in
   [ported-classes.txt](ported-classes.txt) in both versions and prints the differences; port them
   into the viewer files named in the table below.
5. **Look at the screenshots** (vanilla and shader mode, far camera) and at the browser log lines
   in the job output (`[browser] ...`).
6. Write `docs/release-notes/v<version>.md` and run the `release` workflow.

## Server touch points

| File | Game APIs used | Purpose |
|---|---|---|
| `mixin/ServerLevelMixin.java` | `ServerLevel#sendBlockUpdated` (inject) | instant block updates |
| `mixin/ChunkMapAccessor.java` | `ChunkMap#readChunk` (invoker) | saved chunks for far terrain |
| `camera/SectionCapture.java` | `LevelChunkSection`, `PalettedContainer`, `DataLayer`, light listeners | copying sections |
| `camera/SavedChunks.java` | `SerializableChunkData`, `ChunkStatus`, heightmaps | parsing saved chunks |
| `camera/BlockPalette.java` | `BlockState` properties, shapes, render shape, fluids | block state table for the viewer |
| `camera/EntityEncoder.java` | entity getters, data components, equipment | entity frames |
| `camera/EnvironmentSampler.java` | `EnvironmentAttributes`, `DimensionType` | sky, fog, light colours |
| `camera/WeatherSampler.java`, `BiomeTable.java` | biome precipitation and colours | rain and snow columns, tints |
| `camera/CameraSession.java`, `CameraManager.java` | chunk access, heightmaps, entity queries | streaming |
| `command/*.java` | Brigadier arguments, chat components, permissions | `/cctv` |
| `assets/EntityModels.java` | `LayerDefinitions`, `ModelPart` (reflection on `client.jar`) | entity model geometry |

## Client classes ported to the viewer

| Game class (26.3) | Viewer file |
|---|---|
| `ModelBlockRenderer`, `BlockModelLighter`, `LiquidBlockRenderer` | `mesher.js` |
| `Lightmap`, fog (`FogRenderer`, `fog.glsl`) | `environment.js`, `gl.js` |
| `SkyRenderer`, `CloudRenderer`, `WeatherEffectRenderer`, `LightningBoltRenderer` | `sky.js`, `clouds.js`, `weather.js` |
| `EntityRenderer`, `LivingEntityRenderer`, `AvatarRenderer`, mob renderers | `entities.js`, `mobs.js` |
| `HumanoidModel` and the other `setupAnim` models, `WalkAnimationState`, `RemotePlayer` | `mobs.js`, `entities.js` |
| `SubmitNodeCollection#submitNameTag`, `TextFeatureRenderer`, `AbstractSignRenderer`, `StandingSignRenderer`, `HangingSignRenderer`, `BitmapProvider`, `BakedSheetGlyph` | `text.js`, `entities.js` |
| `BlockEntityRenderer`s (chest, shulker box, bell, banner, skull, decorated pot) | `entities.js`, `mobs.js` |
