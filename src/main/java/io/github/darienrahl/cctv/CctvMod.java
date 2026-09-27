package io.github.darienrahl.cctv;

import java.nio.file.Path;

import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.loader.api.FabricLoader;

import io.github.darienrahl.cctv.assets.ClientAssets;
import io.github.darienrahl.cctv.camera.CameraManager;
import io.github.darienrahl.cctv.camera.CameraStore;
import io.github.darienrahl.cctv.command.CctvCommand;

/**
 * Server-side CCTV cameras. The server only reads block state ids and entity
 * positions around each watched camera and streams them to the browser, which
 * does all the rendering - no GPU and no extra Minecraft account needed.
 */
public final class CctvMod implements ModInitializer {
	public static final String MOD_ID = "cctv";
	public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

	private static @Nullable CameraManager manager;

	public static @Nullable CameraManager manager() {
		return manager;
	}

	@Override
	public void onInitialize() {
		Path dir = FabricLoader.getInstance().getConfigDir().resolve(MOD_ID);

		CommandRegistrationCallback.EVENT.register((dispatcher, buildContext, selection) -> CctvCommand.register(dispatcher));

		ServerLifecycleEvents.SERVER_STARTED.register(server -> {
			CctvConfig config = CctvConfig.load(dir.resolve("config.json"), LOGGER);
			String version = FabricLoader.getInstance().getModContainer("minecraft")
					.map(container -> container.getMetadata().getVersion().getFriendlyString())
					.orElse("unknown");
			ClientAssets assets = new ClientAssets(dir.resolve("assets"), version, config.downloadClientAssets, LOGGER);
			CameraManager started = new CameraManager(server, config, new CameraStore(dir.resolve("cameras.json"), LOGGER), assets, LOGGER);
			started.start();
			manager = started;
		});

		ServerLifecycleEvents.SERVER_STOPPING.register(server -> {
			CameraManager stopping = manager;
			manager = null;
			if (stopping != null) {
				stopping.stop();
			}
		});

		ServerTickEvents.END_SERVER_TICK.register(server -> {
			CameraManager current = manager;
			if (current != null) {
				current.tick();
			}
		});
	}
}
