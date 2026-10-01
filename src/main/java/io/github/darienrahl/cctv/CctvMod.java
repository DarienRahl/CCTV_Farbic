package io.github.darienrahl.cctv;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerEntityEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.fabricmc.loader.api.ModContainer;
import net.minecraft.world.level.storage.LevelResource;

import io.github.darienrahl.cctv.assets.ClientAssets;
import io.github.darienrahl.cctv.camera.CameraManager;
import io.github.darienrahl.cctv.camera.CameraStore;
import io.github.darienrahl.cctv.command.CameraMarker;
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
			ClientAssets assets = new ClientAssets(dir.resolve("assets"), version, config.downloadClientAssets, config.language, LOGGER);
			if (config.modAssets) {
				assets.modPacks(modPacks());
			}
			if (config.worldResourcePacks) {
				assets.worldDirectory(server.getWorldPath(LevelResource.ROOT));
			}
			if (config.serverResourcePack) {
				server.getServerResourcePack().ifPresent(pack -> assets.serverPack(pack.url(), pack.hash()));
			}
			CameraManager started = new CameraManager(server, dir, config, new CameraStore(dir.resolve("cameras.json"), LOGGER), assets, LOGGER);
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

		ServerEntityEvents.ENTITY_LOAD.register((entity, level) -> CameraMarker.repair(level.getServer(), entity));

		ServerTickEvents.END_SERVER_TICK.register(server -> {
			CameraManager current = manager;
			if (current != null) {
				current.tick();
			}
		});
	}

	/**
	 * The installed mods with client assets in their files (sounds, textures, texts), like the client's mod
	 * resource packs; Fabric API's modules and this mod are left out.
	 */
	private static List<ClientAssets.ModPack> modPacks() {
		List<ClientAssets.ModPack> packs = new ArrayList<>();
		for (ModContainer mod : FabricLoader.getInstance().getAllMods()) {
			String id = mod.getMetadata().getId();
			if (id.equals("minecraft") || id.equals("java") || id.equals(MOD_ID) || id.startsWith("fabric")) {
				continue;
			}
			try {
				for (Path root : mod.getRootPaths()) {
					if (Files.isDirectory(root.resolve("assets"))) {
						packs.add(new ClientAssets.ModPack(id, root));
					}
				}
			} catch (RuntimeException e) {
				LOGGER.debug("CCTV: the files of mod {} are not readable", id, e);
			}
		}
		packs.sort(Comparator.comparing(ClientAssets.ModPack::id));
		return packs;
	}
}
