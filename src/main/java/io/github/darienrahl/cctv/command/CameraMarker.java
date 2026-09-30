package io.github.darienrahl.cctv.command;

import java.util.Locale;

import net.minecraft.commands.CommandSourceStack;
import net.minecraft.server.MinecraftServer;

import io.github.darienrahl.cctv.camera.Camera;
import io.github.darienrahl.cctv.camera.CameraManager;

/**
 * Shows placed cameras in game as a small observer block, using a vanilla
 * {@code block_display} entity so clients need nothing extra. The entity is
 * created with ordinary commands to stay independent of internal APIs.
 */
final class CameraMarker {
	private CameraMarker() {
	}

	static void place(CameraManager manager, Camera camera) {
		if (!manager.config().markers) {
			return;
		}

		// Display entities use the same yaw/pitch convention as the camera; the observer's face points along +Z (south).
		// The block state is written as a string, which 26.3's block_state field reads (the old Name/Properties map
		// is not accepted any more).
		String command = String.format(Locale.ROOT,
				"execute in %s run summon minecraft:block_display %.4f %.4f %.4f "
						+ "{Tags:[\"cctv_camera\",\"%s\"],Rotation:[%.2ff,%.2ff],"
						+ "block_state:\"minecraft:observer[facing=south]\","
						+ "transformation:{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f],"
						+ "translation:[-0.15f,-0.15f,-0.15f],scale:[0.3f,0.3f,0.3f]}}",
				camera.dimension(), camera.x(), camera.y(), camera.z(), tag(camera), camera.yaw(), camera.pitch());
		run(manager.server(), command);
	}

	static void remove(CameraManager manager, Camera camera) {
		run(manager.server(), "kill @e[type=minecraft:block_display,tag=" + tag(camera) + "]");
	}

	private static String tag(Camera camera) {
		return "cctv_cam_" + camera.key();
	}

	private static void run(MinecraftServer server, String command) {
		CommandSourceStack source = server.createCommandSourceStack().withSuppressedOutput();
		server.getCommands().performPrefixedCommand(source, command);
	}
}
