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
- [x] **Mobs the viewer does not know yet** (a newer game version's) are drawn with the game's model layer
      and texture found by its naming (`<name>#main`, `textures/entity/<name>/…`) and a generic walk,
      instead of a box
- [x] **Automatic entity mapping**: `EntityRenderers` and the renderers are read from `client.jar` (bytecode) to
      map each entity type to its model layers, textures and shadow; mobs the hand-written table does not
      know are drawn with them (the table only overrides)
- [x] Client-side animations from entity events: iron golem, ravager, hoglin and zoglin attacks,
      the ravager's stun and roar, sheep eating grass, wolves shaking off water and begging, goats
      ramming (events are queued, so none is lost when the viewer draws fewer frames than it gets)
- [x] More of them: evoker fangs biting and the evoker's casting hands with their spell particles, illagers
      celebrating and holding or loading crossbows, horses and donkeys rearing, grazing and swishing their
      tails, foxes sitting, sleeping, stalking and pouncing with the item in their mouth (and its crumbs),
      pandas sitting with bamboo, rolling, lying on their back and sneezing, the iron golem offering a poppy
      (the amounts the game's entity tick computes are sent and interpolated, so the poses move like the game's)

## 1.3 — 1:1 picture (parts released: 1.3.0, 1.3.1, 1.3.2, 1.3.3, 1.3.4)

- [x] **Reference renders in CI**: a Fabric client game test (`src/gametest`, run under a virtual display
      with Mesa's software Vulkan) builds a scene in single player and takes the game's own picture from a
      spectator's eyes, a camera is put at the same eyes and the viewer takes its picture; both are published
      side by side with a difference score in the job summary and the `reference-renders` artifact
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
- [x] **Mobs in spawners** (SpawnerRenderer: the spawner's mob small, tilted and spinning while a
      player - the camera - is near, with its smoke and flames; trial spawners by their state)
- [x] **Block breaking progress**: the cracks of blocks players are mining (the destroy stages drawn
      over the block's own model like SheetedDecalTextureGenerator and the crumbling pipeline)
- [x] **Conduits** (ConduitRenderer: the shell, or the turning cage, wind and eye of an active conduit,
      which the viewer works out from the water and prismarine around it like the client), **end
      gateway beams** after a teleport (TheEndGatewayRenderer), the item in **suspicious sand and gravel**
      being brushed (BrushableBlockRenderer)
- [x] **Shields with their patterns** (ShieldSpecialRenderer: the base colour and banner patterns, held,
      dropped and in item frames; items in the left hand mirrored like ItemTransform)
- [x] **Chests, ender chests and shulker boxes open, bells swing, note blocks show their notes** from the
      server's block events (ChestLidController, ShulkerBoxBlockEntity, BellBlockEntity, NoteBlock)
- [x] **Pistons move** the blocks they push and pull (PistonMovingBlockEntity, PistonHeadRenderer: the
      head short while it slides through the base, a retracting piston's base in place)
- [x] **Sounds**: the sounds the server sends players (mobs, steps, blocks, doors, explosions, note
      blocks, jukeboxes) and the ones the client makes from level events, played in 3D like the game's
      SoundEngine (sound files from the game's asset index, downloaded and cached by the server; a button
      turns them on in the viewer)
- [x] Sounds the client makes itself: lightning thunder and impact (LightningBolt), the crackle and bubbling
      of fire, campfires, furnaces, candles, lava, flowing water and nether portals (animateTick)
- [x] **Ambience**: rain on the blocks around the camera (ClientLevel.tickWeatherEffects, with its seeded
      random), the biome's loops, additions and cave sounds in the dark (BiomeAmbientSoundsHandler, from
      the server's environment attributes), underwater loops and additions, bubble columns, End flashes
- [x] Client-only block and entity sounds: desert sand and dry plants, leaves, pale hanging moss,
      eyeblossoms, creaking hearts, dried ghasts, respawn anchors, bubble columns, potent sulfur, firefly
      bushes, vaults and trial spawners; blazes burning, phantom wing flaps, the warden's heartbeat, armour
      stand hits, zombie villager cures, evoker fang bites
- [x] **Guardians fire their beams** (GuardianRenderer.renderBeam, charging from purple to yellow, with the
      bubbles along it and GuardianAttackSoundInstance), their spikes and tail move like GuardianModel;
      **endermen scream** (the jaw drops, they shake, EndermanModel) with the stare sound and hold their
      carried block (CarriedBlockLayer); **boats row** (AbstractBoatModel paddles) and rock when hit;
      the warden's heartbeat speeds up with its anger; portal specks around endermen, smoke around blazes
- [x] Dripstone and honey drips (PointedDripstoneBlock, BeehiveBlock: water or lava from above the
      stalactite, honey under full hives) with the sound of the drop landing
- [x] The sniffer searching and digging: its sniffs, the digging sound (SnifferSoundInstance) and the pieces and
      hit sounds of the block under its nose (Sniffer.emitDiggingParticles)
- [x] Background music (MusicManager: the place's BackgroundMusic, underwater and boss music, the game's pauses
      and the Music Frequency option)
- [x] **Now Playing toast** like the game's NowPlayingToast: the song's title in the game's font on the toast
      sprite, with the animated music notes changing colour, sliding in from the top left for five seconds; the
      jukebox's rainbow "Now Playing" line in the game's font above where the hotbar would be
- [x] **Party parrots and jeb_ sheep**: ParrotModel's poses (dancing next to a playing jukebox, sitting,
      flying), the rainbow wool of a sheep named jeb_ (ColorLerper)
- [x] **The pages in the game's font**: a web font the server builds from the game's glyph sheets (bold like the
      game's bold, resource packs included) for the camera list, the buttons, the settings and the HUD, whose lines
      sit on translucent grey boxes like the debug screen
- [x] **The Immersive Music Mod** (TIMM) on the server: its biome and End playlists, its fading when the
      camera's biome has none of the playing song, and its structure music (villages, ancient cities,
      strongholds... found by the server around the camera like the mod does for players), with its song names on
      the toast
- [x] **Particles** from `particles/*.json` and their textures: torch, candle and campfire flames
      and smoke, lava pops, drips, portal, falling leaves, spore blossoms, fireflies
- [x] **Particles from the server**: broken blocks (pieces of the block's texture), explosions and
      their smoke, the particles the server sends (`ClientboundLevelParticlesPacket`: crits, sweeps,
      hearts, dust...), level events (dispenser smoke, bone meal, lava fizz), death and spawn poofs,
      love hearts, villager moods and potion effect swirls
- [x] Rain splashes (and smoke where it falls on lava, magma and campfires), bubbles, bubble columns and
      whirlpools, reverse portal specks, white smoke
- [x] **Fireworks**: rockets' sparks and their explosions (FireworkParticles: balls, stars, creepers,
      bursts, trails, twinkling, fading colours, the flash) with the blast and twinkle sounds
- [x] **Item pieces** (BreakingItemParticle): food and potions while something eats or drinks (Consumable), tools
      and armour that break, with their break sound; snowball, slime and cobweb pieces
- [x] Sulfur bubbles rising through the water over potent sulfur (SulfurBubbleParticle) with the noxious gas sound
- [x] Geysers of potent sulfur: noxious gas over wet and dormant sulfur, the eruption plumes, their foot and
      puffs with the eruption sounds (PotentSulfurBlockEntity's client tickers, the Geyser and NoxiousGas particles)
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
- [x] **Armour like EquipmentLayerRenderer**: the layers of the game's `equipment/*.json` (new materials
      come with the game), dyed leather armour, **armour trims** recoloured with the trim material's palette
      (the 26.3 PalettedTextureManager), body armour on horses, undead horses, wolves, llamas, nautiluses
      and happy ghasts
- [x] **Maps in item frames** (MapRenderer: the map's picture and the decorations shown on frames); item
      frames turned like the game's and invisible frames showing their item; old 64x32 skins converted like
      SkinTextureDownloader
- [x] **Fishing lines** (FishingHookRenderer: the hook facing the camera and the sagging black line to the
      hand holding the rod) and **wolf armour cracks** (WolfArmorLayer with Crackiness.WOLF_ARMOR)
- [x] **Items with special models** (the game's `items/*.json`: chests, shulker boxes, heads, banners, conduits,
      decorated pots, copper golem statues, beds) dropped, held and in item frames, like SpecialModelWrapper
- [x] **Glowing outlines** (the Glowing effect and tag: the entity outline target and the game's entity_outline
      post chain, in the team colour, seen through walls) and the **names of map markers** on framed maps
      (MapRenderer)
- [x] **Paintings like PaintingRenderer** (the picture, the wooden back and edges, each block lit by its own
      light) and **music discs** (LevelEventHandler.playJukeboxSong with Gui.setNowPlaying's rainbow
      "Now Playing"; songs already playing are picked up from JukeboxSongPlayer)
- [x] **The world's own packs**: data packs with assets, the world's `resources.zip` and the server resource
      pack are used like the game does, so custom paintings, discs, blocks, items and sounds show up
- [x] Mob animations checked against the 26.3 models (felines, bees, chickens, polar bears, turtles, fish,
      dolphins, endermites, silverfish, vexes, allays, striders)
- [x] Your own field of view (30–110°), distance fog modes and 11 built-in post effects
- [x] The Biome Blend option (off to 15x15)
- [x] **Items like ItemModelResolver**: every item's definition (`items/*.json`: model, composite, condition,
      select, range_dispatch, special) with its tints (dye, potion, firework, grass, constant, custom model data), so dyed leather, potions and tipped arrows, loaded crossbows, trimmed armour, clocks and new
      items of later versions look like the game's
- [x] **Occlusion culling like the game** (VisGraph per section in the meshing workers, SectionOcclusionGraph's walk
      from the camera with its source directions and the far sections' ray check)
- [x] **Fluids like FluidRenderer in every case**: faces hidden by slabs, stairs and other partial shapes as far
      as the game's Shapes.blockOccludes hides them (worked out on the server per block state), waterlogged blocks
      hiding their own faces, and the flow direction past `#blocks_fluid_flow` blocks (signs, pressure plates,
      banners...) like FlowingFluid.getFlow
- [x] **Camera in water, lava and powder snow**: the underwater overlay (ScreenEffectRenderer, as bright as the
      light at the camera) and the fog of each (LavaFogEnvironment, PowderedSnowFogEnvironment)

## 1.4 — performance (parts released: 1.4.0)

- [ ] Binary section messages instead of JSON with base64 (sections are already palette +
      run-length encoded and gzipped; measured on a 128-block view: 21 % fewer section bytes, 9 % of the whole
      gzipped stream, and the section cache already skips unchanged sections, so a second transport next to
      SSE is not worth it yet; lower priority)
- [x] **Section cache in the browser** (IndexedDB): the viewer keeps the sections it got; after "init" it
      tells the server which ones it has (position and a hash of the message) and the server answers
      "keep" for the unchanged ones, so reopening a camera downloads only what changed (`?cache=0` turns it
      off)
- [x] **Server memory**: far sections kept only as their message (a few KB instead of about 25), read
      back from it when a block or the light in them changes
- [x] **Per-section culling inside merged far regions**: each section of a merged region is checked against the
      frustum, the render distance and the occlusion graph and only the visible runs of sections are drawn
      (one multi-draw call per region with `WEBGL_multi_draw`)
- [x] **Entities skinned on the GPU**: every model's quads stay on the GPU in their parts' own space and a frame
      only sends one matrix per part (a float texture), so the vertices of mobs, players, armour and block entity
      models are no longer rebuilt and uploaded every frame (`?skinning=0` turns it off for comparisons)
- [x] Video wall: frame rate cap (lower for small tiles), one pixel per CSS pixel, no rendering
      for tiles that are off screen or in a hidden tab
- [x] **Budgets in CI**: server milliseconds per camera tick, bytes per section message, the page's time
      per frame (also in `/api/status`: tick time, sections sent, kept and compacted)

## 1.5 — everything the game shows (released: 1.5.0)

- [x] **Display entities** like DisplayRenderer: block, item and text displays (the holograms, signs and decorations
      of servers) with their transformation interpolated like the game (Transformation.slerp), billboards facing
      the camera, brightness overrides, shadows, view range and teleport gliding; text displays with the game's
      font, colours, bold, italic, underline and strikethrough, line wrapping, alignment, background and
      see-through text (the cameras' own markers stay hidden)
- [x] **Shelves** like ShelfRenderer: the three items standing on a shelf, set on its middle by their model's
      bounding box or on its bottom when the shelf is powered
- [x] **Mannequins** drawn by the player renderer with the skin of their profile (by id or name, the default
      skin of the empty profile, or the texture, model and cape of the profile's skin patch), their hidden skin
      layers, poses and the description under their name
- [x] **Arrows and bee stingers stuck in players and mannequins** (StuckInBodyLayer): in the same body parts and
      places as in the game, from the same random seeded with the entity's id
- [x] Players drawn at the player renderer's scale (0.9375, they were a little too big); items whose model
      changes with the date (the Christmas chest) pick it by the viewer's clock
- [x] **Sulfur cubes** like SulfurCubeRenderer: their size, the small model of babies, the inner cube, the block
      they hold drawn inside them, and a primed cube swelling and flashing like TNT; slimes, magma cubes and
      sulfur cubes squash when they land and stretch when they jump; TNT swells like the game's; babies cast
      the smaller shadow of their age scale

## 1.6 — players and what they carry (released: 1.6.0)

- [x] **Parrots on players' shoulders** (ParrotOnShoulderLayer), sitting and looking where the player looks
- [x] **Heads and hats** (CustomHeadLayer): skulls and player heads with their owner's skin, carved pumpkins,
      banners and data packs' hats worn by players, mannequins, armour stands, humanoid mobs, villagers, illagers,
      piglins, copper golems and sulfur cubes, each at its renderer's place and size
- [x] **Items in use**: players and mannequins draw bows, charge and aim crossbows, raise shields (the blocking
      shield model), look through spyglasses, blow goat horns, brush and throw tridents with the game's arm poses
      (HumanoidModel), and their swing moves the arms and body like setupAttackAnimation
- [x] **Left-handed players and mobs**: the main hand's item in the left hand, the swing and the poses with the
      left arm
- [x] A riptide trident's spin (the player turning and SpinAttackEffectLayer's whirls) and deadmau5's ears
- [x] Shaking like the game: mobs frozen in powder snow, zombies, piglins and hoglins turning into something else,
      skeletons becoming strays and cold striders; sleepers lie along their bed; spiders, silverfish and
      endermites turn onto their backs when they die; Dinnerbone players only turn over while showing their cape
- [x] Shields without patterns were not drawn: the shield's plate uses the game's 26.3 textures
- [x] **Name tags like the game's**: the display name's colours and formatting (a team's colour, prefix and suffix,
      coloured custom names), the scoreboard's below_name objective under players' names, teams that hide name
      tags, no tag on a mob that is ridden, and the name_tag_distance and below_name_distance attributes

## Later

- [x] **Recording and timelapse** of a camera in the browser: a video with the game's sounds, or one picture
      every second to five minutes turned into a video, with the camera's name, place and time burnt in
