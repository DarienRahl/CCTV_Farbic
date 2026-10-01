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
 * each shot (day, night, mobs, a room, under water), takes the game's picture from a spectator's eyes with the GUI
 * hidden, moves a CCTV camera to the same eyes and waits while CI takes the viewer's picture of that camera
 * (.github/e2e/reference.mjs), so both can be compared (compare_reference.py).
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

	/** A picture: the commands that set it up, then where the eyes are (x y z yaw pitch of the spectator's feet). */
	private record Shot(String name, String[] commands, String eyes) {
	}

	private static final Shot[] SHOTS = {
		new Shot("day", new String[] {"time set noon"}, "0.5 -58.5 -6.5 -20 18"),
		// the same view at night: the lightmap, block light of the torch and the lantern, the moon and the stars
		new Shot("night", new String[] {"time set midnight"}, "0.5 -58.5 -6.5 -20 18"),
		new Shot("mobs", new String[] {"time set noon"}, "18.5 -59.2 -3.5 0 14"),
		// inside the house: smooth lighting by the torch and the windows, block entities and an item frame
		new Shot("room", new String[0], "3.5 -59.65 7.3 -45 22"),
		// under water: the water fog and the underwater overlay (which the game draws for players, not spectators)
		new Shot("water", new String[] {"gamemode creative @a"}, "-16.5 -61.5 -24.5 0 6"),
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
				server.runCommand("tp @a " + shot.eyes());
				server.runCommand(first ? "execute as @p at @p run cctv create ref ~ ~ ~ ~ ~" : "execute as @p at @p run cctv move ref ~ ~ ~ ~ ~");
				if (first) {
					server.runCommand("cctv range ref 96");
				}
				singleplayer.getConnection().waitForChunksRender(CHUNK_TICKS);
				if (first) {
					// F1: no hotbar, crosshair or chat in the picture
					context.getInput().pressKey(options -> options.keyToggleGui);
				}
				context.waitTicks(40);
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
