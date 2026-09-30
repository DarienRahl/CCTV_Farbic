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
 * Reference renders for CI: builds a small scene in a single player world (flat, time and weather stopped), takes
 * the game's picture from a spectator's eyes with the GUI hidden, puts a CCTV camera at the same eyes and waits
 * while CI takes the viewer's picture of that camera (.github/e2e/reference.mjs), so both can be compared.
 *
 * <p>Hand-off through files in {@code <game dir>/reference}: {@code ready.json} when the game's picture is taken,
 * {@code done} from the viewer's side.
 */
@SuppressWarnings("UnstableApiUsage")
public class ReferenceRenders implements FabricClientGameTest {
	private static final int WIDTH = 960;
	private static final int HEIGHT = 540;
	/** How long the world stays open for the viewer: six minutes of ticks. */
	private static final int VIEWER_TICKS = 20 * 60 * 6;

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
		// the eyes both pictures are taken from
		"tp @a 0.5 -58.5 -6.5 -20 18",
		"execute as @p at @p run cctv create ref ~ ~ ~ ~ ~",
		"cctv range ref 128",
	};

	@Override
	public void runTest(ClientGameTestContext context) {
		Path dir = FabricLoader.getInstance().getGameDir().resolve("reference");
		// the viewer's defaults: a 70 degree field of view, 128 blocks (8 chunks) of terrain
		context.runOnClient(client -> {
			client.options.fov().set(70);
			client.options.renderDistance().set(8);
		});
		try (TestSingleplayerContext singleplayer = context.worldBuilder().create()) {
			TestServerContext server = singleplayer.getServer();
			for (String command : SCENE) {
				server.runCommand(command);
			}
			singleplayer.getConnection().waitForChunksRender();
			// F1: no hotbar, crosshair or chat in the picture
			context.getInput().pressKey(options -> options.keyToggleGui);
			context.waitTicks(40);
			Path game = context.takeScreenshot(TestScreenshotOptions.of("reference-game").withSize(WIDTH, HEIGHT).disableCounterPrefix());

			Files.createDirectories(dir);
			Files.writeString(dir.resolve("ready.json"), "{\"camera\":\"ref\",\"width\":" + WIDTH + ",\"height\":" + HEIGHT
					+ ",\"game\":\"" + game.toAbsolutePath().toString().replace('\\', '/') + "\"}");
			Path done = dir.resolve("done");
			for (int tick = 0; tick < VIEWER_TICKS && !Files.exists(done); tick++) {
				context.waitTick();
			}
		} catch (IOException e) {
			throw new UncheckedIOException(e);
		}
	}
}
