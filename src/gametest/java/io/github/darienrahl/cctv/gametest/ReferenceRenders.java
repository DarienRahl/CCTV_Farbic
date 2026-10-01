package io.github.darienrahl.cctv.gametest;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;

import net.fabricmc.fabric.api.client.gametest.v1.FabricClientGameTest;
import net.fabricmc.fabric.api.client.gametest.v1.context.ClientGameTestContext;
import net.fabricmc.fabric.api.client.gametest.v1.context.TestServerContext;
import net.fabricmc.fabric.api.client.gametest.v1.context.TestSingleplayerContext;
import net.fabricmc.fabric.api.client.gametest.v1.screenshot.TestScreenshotOptions;
import net.fabricmc.loader.api.FabricLoader;

/**
 * Reference renders for CI: builds small scenes in a single player world (flat, time and weather stopped) and, for
 * each shot (day, night, mobs, a room, under water, dusk, rain, snow, a cave, the Nether and the End), takes the
 * game's picture from a spectator's eyes with the GUI hidden, moves a CCTV camera to the same eyes and waits while CI
 * takes the viewer's picture of that camera (.github/e2e/reference.mjs), so both can be compared
 * (compare_reference.py).
 *
 * <p>Hand-off through files in {@code <game dir>/reference}: {@code ready-<shot>.json} when the game's picture of a
 * shot is taken, {@code done-<shot>} from the viewer's side, and {@code finished} after the last shot.
 */
@SuppressWarnings("UnstableApiUsage")
public class ReferenceRenders implements FabricClientGameTest {
	private static final int WIDTH = 960;
	private static final int HEIGHT = 540;
	/** How long the world waits for the viewer's picture of the first shot (its page loads), and of the others. */
	private static final int FIRST_VIEWER_TICKS = 20 * 60 * 6;
	private static final int VIEWER_TICKS = 20 * 60 * 3;

	private static final String[] SCENE = {
		"gamemode spectator @a",
		"time set noon",
		// no mob comes into a picture by itself, plants do not grow and the world's time stays where it is set
		"gamerule spawn_mobs false",
		"gamerule random_tick_speed 0",
		"gamerule advance_time false",
		"gamerule advance_weather false",
		"weather clear",
		// a small house with a slab roof, windows, a door and a torch
		"fill 2 -60 6 7 -57 11 minecraft:oak_planks hollow",
		"fill 2 -56 6 7 -56 11 minecraft:cobblestone_slab",
		"setblock 4 -59 6 minecraft:glass",
		"setblock 5 -59 6 minecraft:glass_pane",
		"setblock 3 -60 6 minecraft:oak_door[facing=north,half=lower]",
		"setblock 3 -59 6 minecraft:oak_door[facing=north,half=upper]",
		"setblock 6 -58 5 minecraft:wall_torch[facing=north]",
		// a pool with a slab and stairs at its edge
		"fill -6 -61 3 -2 -61 8 minecraft:water",
		"setblock -1 -61 5 minecraft:stone_slab[type=bottom]",
		"setblock -1 -61 6 minecraft:oak_stairs[facing=west]",
		// a tree
		"fill -9 -57 9 -5 -55 13 minecraft:oak_leaves[persistent=true]",
		"fill -7 -60 11 -7 -55 11 minecraft:oak_log",
		// plants
		"setblock 0 -60 2 minecraft:poppy",
		"setblock 1 -60 3 minecraft:dandelion",
		"fill -1 -60 0 1 -60 1 minecraft:short_grass",
		"setblock -3 -60 1 minecraft:tall_grass[half=lower]",
		"setblock -3 -59 1 minecraft:tall_grass[half=upper]",
		// materials in a row
		"setblock -3 -60 14 minecraft:white_wool",
		"setblock -2 -60 14 minecraft:red_concrete",
		"setblock -1 -60 14 minecraft:blue_terracotta",
		"setblock 0 -60 14 minecraft:gold_block",
		"setblock 1 -60 14 minecraft:diamond_block",
		"setblock 2 -60 14 minecraft:birch_planks",
		"setblock 3 -60 14 minecraft:sand",
		"setblock 4 -60 14 minecraft:stone_bricks",
		"setblock 5 -60 14 minecraft:lantern",
		// block entities and a mob that stands still
		"setblock 1 -60 5 minecraft:chest[facing=north]",
		"setblock -1 -60 3 minecraft:oak_sign[rotation=8]{front_text:{messages:[\"CCTV\",\"reference\",\"\",\"\"]}}",
		"summon minecraft:cow 4 -60 2 {NoAI:1b,Rotation:[150f,0f]}",
		// the room inside the house: a bed, a crafting table, a furnace, books, a pot, a torch and a framed sword
		"setblock 5 -59 9 minecraft:red_bed[facing=south,part=foot]",
		"setblock 5 -59 10 minecraft:red_bed[facing=south,part=head]",
		"setblock 6 -59 7 minecraft:crafting_table",
		"setblock 6 -59 8 minecraft:furnace[facing=west]",
		"setblock 3 -59 10 minecraft:bookshelf",
		"setblock 3 -58 10 minecraft:bookshelf",
		"setblock 4 -59 10 minecraft:potted_poppy",
		"setblock 3 -59 8 minecraft:decorated_pot",
		"setblock 4 -58 10 minecraft:wall_torch[facing=north]",
		"summon minecraft:item_frame 6 -58 9 {Facing:4b,Fixed:1b,Item:{id:\"minecraft:diamond_sword\",count:1}}",
		// mobs in a row facing the camera, hostile ones with helmets so the sun does not set them alight
		"difficulty easy",
		"summon minecraft:zombie 13 -60 4 {NoAI:1b,PersistenceRequired:1b,Rotation:[180f,0f],"
				+ "equipment:{head:{id:\"minecraft:iron_helmet\",count:1},mainhand:{id:\"minecraft:iron_sword\",count:1}}}",
		"summon minecraft:skeleton 15 -60 4 {NoAI:1b,PersistenceRequired:1b,Rotation:[180f,0f],"
				+ "equipment:{head:{id:\"minecraft:chainmail_helmet\",count:1},mainhand:{id:\"minecraft:bow\",count:1}}}",
		"summon minecraft:creeper 17 -60 4 {NoAI:1b,PersistenceRequired:1b,Rotation:[180f,0f]}",
		"summon minecraft:villager 19 -60 4 {NoAI:1b,Rotation:[180f,0f],"
				+ "VillagerData:{type:\"minecraft:plains\",profession:\"minecraft:farmer\",level:2}}",
		"summon minecraft:sheep 21 -60 4 {NoAI:1b,Rotation:[180f,0f],Color:14b}",
		"summon minecraft:pig 23 -60 4 {NoAI:1b,Rotation:[180f,0f],equipment:{saddle:{id:\"minecraft:saddle\",count:1}}}",
		"summon minecraft:iron_golem 15.5 -60 7 {NoAI:1b,Rotation:[180f,0f]}",
		"summon minecraft:armor_stand 21 -60 7 {ShowArms:1b,Rotation:[180f,0f],Pose:{Head:[-10f,20f,0f],RightArm:[-100f,0f,0f]},"
				+ "equipment:{head:{id:\"minecraft:diamond_helmet\",count:1},chest:{id:\"minecraft:golden_chestplate\",count:1}}}",
		// a deep pool with a sandy floor, seagrass, kelp and coral for the shot under water
		"fill -22 -63 -26 -12 -60 -16 minecraft:water",
		"fill -22 -64 -26 -12 -64 -16 minecraft:sand",
		"fill -22 -63 -26 -12 -63 -16 minecraft:sand",
		"setblock -18 -62 -18 minecraft:seagrass",
		"setblock -15 -62 -19 minecraft:seagrass",
		"setblock -16 -62 -17 minecraft:kelp_plant",
		"setblock -16 -61 -17 minecraft:kelp",
		"setblock -19 -62 -20 minecraft:brain_coral_block",
		"setblock -14 -62 -18 minecraft:tube_coral_block",
		"setblock -17 -62 -16 minecraft:prismarine",
	};

	/**
	 * A picture: the commands that set it up, where the eyes are (x y z yaw pitch of the spectator's feet) and how
	 * many ticks to wait there before it is taken; for a scene away from the others or in another dimension, the
	 * commands that build it once the spectator is there (its chunks are only loaded then).
	 */
	private record Shot(String name, String[] commands, String eyes, int settle, String dimension, String[] build) {
		Shot(String name, String[] commands, String eyes) {
			this(name, commands, eyes, 40);
		}

		Shot(String name, String[] commands, String eyes, int settle) {
			this(name, commands, eyes, settle, "minecraft:overworld", new String[0]);
		}
	}

	/** A snowy plain: a frozen pond, an igloo of snow blocks, powder snow, a spruce, a snow golem and a polar bear. */
	private static final String[] SNOW = {
		"fillbiome 80 -64 -48 111 -40 -9 minecraft:snowy_plains",
		"fill 80 -60 -48 111 -60 -9 minecraft:snow[layers=1]",
		"fill 88 -61 -26 94 -61 -20 minecraft:ice",
		"fill 90 -61 -24 92 -61 -22 minecraft:packed_ice",
		"fill 88 -60 -26 94 -60 -20 minecraft:air",
		"fill 100 -60 -32 104 -58 -28 minecraft:snow_block hollow",
		"fill 98 -61 -22 100 -61 -20 minecraft:powder_snow",
		"fill 98 -60 -22 100 -60 -20 minecraft:air",
		"fill 96 -60 -16 96 -54 -16 minecraft:spruce_log",
		"fill 94 -56 -18 98 -53 -14 minecraft:spruce_leaves[persistent=true] replace air",
		"summon minecraft:snow_golem 97.5 -60 -26.5 {NoAI:1b,Rotation:[180f,0f]}",
		"summon minecraft:polar_bear 90.5 -60 -30.5 {NoAI:1b,PersistenceRequired:1b,Rotation:[160f,0f]}",
	};

	/**
	 * A cave: a closed room of stone (no sky light) lit by a torch, a lantern, glow lichen and amethyst, with ores,
	 * dripstone, moss, sculk, copper, a resting bat and a spider whose eyes glow.
	 */
	private static final String[] CAVE = {
		"fill 40 -61 -24 63 -50 -1 minecraft:stone hollow",
		"fill 44 -61 -20 50 -61 -14 minecraft:deepslate",
		"setblock 63 -57 -12 minecraft:diamond_ore",
		"setblock 63 -55 -8 minecraft:iron_ore",
		"setblock 63 -58 -16 minecraft:coal_ore",
		"setblock 63 -54 -14 minecraft:copper_ore",
		"setblock 48 -60 -10 minecraft:torch",
		"setblock 56 -58 -23 minecraft:wall_torch[facing=south]",
		"setblock 57 -60 -12 minecraft:lantern",
		"setblock 62 -56 -18 minecraft:glow_lichen[east=true]",
		"setblock 62 -57 -19 minecraft:glow_lichen[east=true]",
		"fill 58 -61 -6 60 -61 -4 minecraft:amethyst_block",
		"setblock 59 -60 -5 minecraft:amethyst_cluster[facing=up]",
		"setblock 60 -51 -8 minecraft:pointed_dripstone[vertical_direction=down,thickness=tip]",
		"setblock 61 -60 -10 minecraft:pointed_dripstone[vertical_direction=up,thickness=tip]",
		"fill 50 -61 -6 54 -61 -3 minecraft:moss_block",
		"setblock 52 -60 -5 minecraft:moss_carpet",
		"fill 56 -61 -21 58 -61 -18 minecraft:sculk",
		"setblock 60 -60 -20 minecraft:oxidized_copper",
		"setblock 61 -60 -20 minecraft:weathered_copper",
		"setblock 62 -60 -20 minecraft:exposed_copper",
		"summon minecraft:bat 60.5 -51.9 -12.5 {NoAI:1b,PersistenceRequired:1b,BatFlags:1b}",
		"summon minecraft:spider 53.5 -60 -14.5 {NoAI:1b,PersistenceRequired:1b,Rotation:[90f,0f]}",
	};

	/** A room in the Nether: lava, magma and glowstone light, soul sand with nether wart, both nylium forests, a portal. */
	private static final String[] NETHER = {
		"fill 0 58 0 47 75 31 minecraft:netherrack hollow",
		"fill 1 59 1 46 59 30 minecraft:netherrack",
		// nether wastes everywhere around the camera: its fog colour and no ambient particles
		"fillbiome 0 58 0 47 75 31 minecraft:nether_wastes",
		"fill 18 59 12 25 59 19 minecraft:lava",
		"fill 8 59 6 10 59 8 minecraft:magma_block",
		"fill 10 59 21 13 59 24 minecraft:soul_sand",
		"setblock 11 60 22 minecraft:nether_wart[age=3]",
		"setblock 12 60 23 minecraft:nether_wart[age=1]",
		"fill 30 60 6 31 66 7 minecraft:nether_bricks",
		"fill 32 60 6 35 60 6 minecraft:nether_brick_fence",
		"fill 32 59 18 38 59 24 minecraft:crimson_nylium",
		"setblock 34 60 20 minecraft:crimson_fungus",
		"setblock 36 60 22 minecraft:crimson_roots",
		"setblock 33 60 23 minecraft:crimson_roots",
		"fill 39 59 10 44 59 15 minecraft:warped_nylium",
		"setblock 41 60 12 minecraft:warped_fungus",
		"setblock 42 60 14 minecraft:warped_roots",
		"setblock 40 60 14 minecraft:nether_sprouts",
		"fill 36 60 3 39 64 3 minecraft:obsidian",
		"fill 37 61 3 38 63 3 minecraft:nether_portal[axis=x]",
		"fill 20 72 14 21 74 15 minecraft:glowstone",
		"fill 34 73 22 35 74 23 minecraft:glowstone",
		"fill 12 73 4 13 74 5 minecraft:glowstone",
		"setblock 47 62 10 minecraft:nether_gold_ore",
		"setblock 47 66 20 minecraft:nether_quartz_ore",
		"summon minecraft:piglin 14.5 60 16.5 {NoAI:1b,PersistenceRequired:1b,IsImmuneToZombification:1b,Rotation:[90f,0f],"
				+ "equipment:{mainhand:{id:\"minecraft:golden_sword\",count:1}}}",
		"summon minecraft:strider 21.5 60 15.5 {NoAI:1b,PersistenceRequired:1b,Rotation:[60f,0f]}",
	};

	/** A platform of end stone out in the End's void (far from the dragon's island): purpur, chorus, a portal, a shulker. */
	private static final String[] END = {
		"fill 588 58 -14 621 59 12 minecraft:end_stone",
		"fill 606 60 -6 607 66 -5 minecraft:purpur_pillar",
		"setblock 606 67 -6 minecraft:end_rod[facing=up]",
		"setblock 607 67 -5 minecraft:dragon_head[rotation=4]",
		"fill 600 60 4 603 60 7 minecraft:end_stone_bricks",
		"setblock 601 61 5 minecraft:purpur_slab",
		"setblock 598 60 -2 minecraft:chorus_plant",
		"setblock 598 61 -2 minecraft:chorus_plant",
		"setblock 599 61 -2 minecraft:chorus_plant",
		"setblock 599 62 -2 minecraft:chorus_flower[age=5]",
		"setblock 598 62 -2 minecraft:chorus_flower[age=5]",
		"fill 595 59 1 599 59 5 minecraft:end_portal_frame[eye=true]",
		"fill 596 59 2 598 59 4 minecraft:end_portal",
		"setblock 603 60 -3 minecraft:ender_chest[facing=west]",
		"setblock 604 60 3 minecraft:magenta_shulker_box[facing=up]",
		"summon minecraft:shulker 604 60 -1 {NoAI:1b,PersistenceRequired:1b}",
	};

	private static final Shot[] SHOTS = {
		new Shot("day", new String[] {"time set noon"}, "0.5 -58.5 -6.5 -20 18"),
		// the same view at night: the lightmap, block light of the torch and the lantern, the moon and the stars
		new Shot("night", new String[] {"time set midnight"}, "0.5 -58.5 -6.5 -20 18"),
		new Shot("mobs", new String[] {"time set noon"}, "18.5 -59.2 -3.5 0 14"),
		// inside the house: smooth lighting by the torch and the windows, block entities and an item frame
		new Shot("room", new String[0], "3.5 -59.65 7.3 -45 22"),
		// under water: the water fog and the underwater overlay (which the game draws for players, not spectators),
		// after 600 ticks in the water, when the player sees as far as a camera always does (Player.getWaterVision)
		new Shot("water", new String[] {"gamemode creative @a"}, "-16.5 -61.5 -24.5 0 6", 640),
		// towards the setting sun: the sunset colours in the sky and the fog
		new Shot("dusk", new String[] {"gamemode spectator @a", "time set 12600"}, "0.5 -58.5 -6.5 90 -5"),
		// the day view once the rain has set in (the rain level grows by 0.01 a tick): the rain and the darker sky
		new Shot("rain", new String[] {"time set noon", "weather rain"}, "0.5 -58.5 -6.5 -20 18", 160),
		// the same weather where it is cold enough to snow: snowfall, a snowy biome's colours
		new Shot("snow", new String[0], "95.5 -58.5 -37.5 0 12", 40, "minecraft:overworld", SNOW),
		// a cave lit only by blocks: the lightmap without sky light, smooth lighting in the dark, emissive spider eyes
		new Shot("cave", new String[] {"weather clear"}, "42.5 -59.62 -12.5 -90 10", 40, "minecraft:overworld", CAVE),
		// the Nether's thick fog, its ambient light and its own lightmap
		new Shot("nether", new String[0], "3.5 61.5 16.5 -90 10", 40, "minecraft:the_nether", NETHER),
		// the End's sky (and its flashes) and fog
		new Shot("end", new String[0], "592.5 61 -10.5 -40 5", 40, "minecraft:the_end", END),
	};
	/** Chunks render slowly on CI's software renderer: up to five minutes. */
	private static final int CHUNK_TICKS = 20 * 60 * 5;

	@Override
	public void runTest(ClientGameTestContext context) {
		Path dir = FabricLoader.getInstance().getGameDir().resolve("reference");
		// the viewer's defaults: a 70 degree field of view, 96 blocks (6 chunks) of terrain
		context.runOnClient(client -> {
			client.options.fov().set(70);
			// a spectator always flies, which widens the game's view by 10 %; a camera has no such effect
			client.options.fovEffectScale().set(0.0);
			client.options.renderDistance().set(6);
			// the game's own settings the viewer is compared under
			System.out.println("reference renders, game options: graphics " + client.options.graphicsPreset().get()
					+ ", clouds " + client.options.cloudStatus().get() + " to " + client.options.cloudRange().get()
					+ ", gamma " + client.options.gamma().get() + ", smooth lighting " + client.options.ambientOcclusion().get()
					+ ", biome blend " + client.options.biomeBlendRadius().get() + ", mipmaps " + client.options.mipmapLevels().get()
					+ ", entity shadows " + client.options.entityShadows().get());
		});
		try (TestSingleplayerContext singleplayer = context.worldBuilder().create()) {
			TestServerContext server = singleplayer.getServer();
			for (String command : SCENE) {
				server.runCommand(command);
			}
			Files.createDirectories(dir);
			// the viewer is set up like the game's options (its clouds follow the game's cloud setting)
			String clouds = context.computeOnClient(client -> client.options.cloudStatus().get().name().toLowerCase(java.util.Locale.ROOT));
			boolean first = true;
			for (Shot shot : SHOTS) {
				for (String command : shot.commands()) {
					server.runCommand(command);
				}
				server.runCommand("execute in " + shot.dimension() + " run tp @a " + shot.eyes());
				if (shot.build().length > 0) {
					// the chunks around the spectator are loaded now: build its scene
					context.waitTicks(40);
					singleplayer.getConnection().waitForChunksRender(CHUNK_TICKS);
					for (String command : shot.build()) {
						server.runCommand("execute in " + shot.dimension() + " run " + command);
					}
				}
				server.runCommand(first ? "execute as @p at @p run cctv create ref ~ ~ ~ ~ ~" : "execute as @p at @p run cctv move ref ~ ~ ~ ~ ~");
				if (first) {
					server.runCommand("cctv range ref 96");
				}
				singleplayer.getConnection().waitForChunksRender(CHUNK_TICKS);
				if (first) {
					// F1: no hotbar, crosshair or chat in the picture
					context.getInput().pressKey(options -> options.keyToggleGui);
				}
				context.waitTicks(shot.settle());
				Path game = context.takeScreenshot(TestScreenshotOptions.of("reference-" + shot.name()).withSize(WIDTH, HEIGHT).disableCounterPrefix());
				// where the viewer has to see the camera before it takes its picture
				String eye = context.computeOnClient(client -> {
					var position = client.player.getEyePosition();
					return String.format(java.util.Locale.ROOT, "[%.3f,%.3f,%.3f]", position.x, position.y, position.z);
				});
				Files.writeString(dir.resolve("ready-" + shot.name() + ".json"), "{\"shot\":\"" + shot.name() + "\",\"camera\":\"ref\",\"width\":"
						+ WIDTH + ",\"height\":" + HEIGHT + ",\"clouds\":\"" + clouds + "\",\"eye\":" + eye
						+ ",\"game\":\"" + game.toAbsolutePath().toString().replace('\\', '/') + "\"}");
				Path done = dir.resolve("done-" + shot.name());
				for (int tick = 0, limit = first ? FIRST_VIEWER_TICKS : VIEWER_TICKS; tick < limit && !Files.exists(done); tick++) {
					context.waitTick();
				}
				first = false;
			}
			Files.writeString(dir.resolve("finished"), "finished");
		} catch (IOException e) {
			throw new UncheckedIOException(e);
		}
	}
}
