package io.github.darienrahl.cctv.camera;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;

import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.state.BlockState;

import io.github.darienrahl.cctv.CctvConfig;
import io.github.darienrahl.cctv.assets.ClientAssets;
import io.github.darienrahl.cctv.web.CameraDirectory;
import io.github.darienrahl.cctv.web.Json;
import io.github.darienrahl.cctv.web.Viewer;
import io.github.darienrahl.cctv.web.WebServer;

/** Owns all cameras, their live sessions and the web server. */
public final class CameraManager implements CameraDirectory {
	private final MinecraftServer server;
	/** config/cctv: config.json, cameras.json, assets, skyboxes and shaders. */
	private final Path dataDir;
	private final CctvConfig config;
	private final CameraStore store;
	private final Logger logger;
	private final Map<String, Camera> cameras = new ConcurrentHashMap<>();
	private final Map<String, CameraSession> sessions = new ConcurrentHashMap<>();
	private final BlockPalette palette = new BlockPalette();
	private final ClientAssets assets;
	/** Decodes sections and parses saved chunks off the server thread. */
	private final ExecutorService workers;
	private @Nullable WebServer web;
	private long tick;

	public CameraManager(MinecraftServer server, Path dataDir, CctvConfig config, CameraStore store, ClientAssets assets, Logger logger) {
		this.server = server;
		this.dataDir = dataDir;
		this.config = config;
		this.store = store;
		this.assets = assets;
		this.logger = logger;
		AtomicInteger threads = new AtomicInteger();
		this.workers = Executors.newFixedThreadPool(config.workerThreads, task -> {
			Thread thread = new Thread(task, "cctv-worker-" + threads.incrementAndGet());
			thread.setDaemon(true);
			thread.setPriority(Thread.NORM_PRIORITY - 1);
			return thread;
		});
	}

	public CctvConfig config() {
		return config;
	}

	public MinecraftServer server() {
		return server;
	}

	public void start() {
		installExamples();
		for (Camera camera : store.load()) {
			cameras.put(camera.key(), camera);
		}
		logger.info("Loaded {} CCTV camera(s)", cameras.size());

		assets.start();
		WebServer webServer = new WebServer(config, dataDir, this, assets, logger);
		try {
			webServer.start();
			web = webServer;
		} catch (IOException e) {
			logger.error("Could not start the CCTV web server on {}:{} - is the port already in use? Change it in config/cctv/config.json",
					config.bindAddress, config.port, e);
		}
	}

	/** Creates config/cctv/shaders and config/cctv/skyboxes with examples the first time. */
	private void installExamples() {
		String[][] examples = {
				{"shaders", "sepia.glsl"},
				{"shaders", "security-camera.glsl"},
				{"skyboxes", "README.txt"},
				{"skyboxes", "sunset.jpg"},
				{"skyboxes", "sunset.json"},
		};
		for (String[] example : examples) {
			Path dir = dataDir.resolve(example[0]);
			Path file = dir.resolve(example[1]);
			if (Files.exists(file) || Files.exists(dir.resolve(".examples-installed"))) {
				continue;
			}
			try (InputStream in = CameraManager.class.getResourceAsStream("/examples/" + example[0] + "/" + example[1])) {
				if (in != null) {
					Files.createDirectories(dir);
					Files.copy(in, file);
				}
			} catch (IOException e) {
				logger.debug("Could not write {}", file, e);
			}
		}
		for (String dir : new String[]{"shaders", "skyboxes"}) {
			try {
				Files.createDirectories(dataDir.resolve(dir));
				Path marker = dataDir.resolve(dir).resolve(".examples-installed");
				if (!Files.exists(marker)) {
					Files.writeString(marker, "Delete this file to get the example files back.\n");
				}
			} catch (IOException e) {
				logger.debug("Could not create {}", dir, e);
			}
		}
	}

	public void stop() {
		for (CameraSession session : sessions.values()) {
			session.closeAll();
		}
		sessions.clear();
		if (web != null) {
			web.stop();
			web = null;
		}
		assets.close();
		workers.shutdownNow();
	}

	/** {@code /cctv reload}: re-reads the viewer settings from config.json. */
	public void reloadViewerSettings() throws IOException {
		config.reloadViewer(dataDir.resolve("config.json"), logger);
	}

	public boolean isWebRunning() {
		return web != null;
	}

	/** End of every server tick. */
	public void tick() {
		tick++;
		if (sessions.isEmpty()) {
			return;
		}

		for (Map.Entry<String, CameraSession> entry : sessions.entrySet()) {
			CameraSession session = entry.getValue();
			if (!session.tick(findLevel(session.camera().dimension()), tick)) {
				// Conditional remove: a web thread may already have replaced the disposed session.
				sessions.remove(entry.getKey(), session);
			}
		}
	}

	/** Called (server thread) for every block change that is sent to players. */
	public void onBlockChanged(ServerLevel level, BlockPos pos, BlockState state) {
		if (sessions.isEmpty()) {
			return;
		}
		int x = pos.getX();
		int y = pos.getY();
		int z = pos.getZ();
		for (CameraSession session : sessions.values()) {
			session.onBlockChanged(level, x, y, z, state);
		}
	}

	public @Nullable ServerLevel findLevel(String dimension) {
		for (ServerLevel level : server.getAllLevels()) {
			if (level.dimension().identifier().toString().equals(dimension)) {
				return level;
			}
		}
		return null;
	}

	// --- camera management (server thread, used by commands) ---

	public @Nullable Camera get(String name) {
		return cameras.get(name.toLowerCase(Locale.ROOT));
	}

	public List<Camera> list() {
		List<Camera> list = new ArrayList<>(cameras.values());
		list.sort(Comparator.comparing(Camera::key));
		return list;
	}

	public void put(Camera camera) {
		cameras.put(camera.key(), camera);
		store.save(cameras.values());
		CameraSession session = sessions.get(camera.key());
		if (session != null) {
			session.setCamera(camera);
		}
	}

	public boolean remove(String name) {
		String key = name.toLowerCase(Locale.ROOT);
		Camera removed = cameras.remove(key);
		if (removed == null) {
			return false;
		}
		store.save(cameras.values());
		CameraSession session = sessions.remove(key);
		if (session != null) {
			session.closeAll();
		}
		return true;
	}

	public int viewers(Camera camera) {
		CameraSession session = sessions.get(camera.key());
		return session == null ? 0 : session.viewerCount();
	}

	// --- CameraDirectory (web threads) ---

	@Override
	public String camerasJson() {
		Json json = new Json(128 + cameras.size() * 200);
		json.beginArray();
		for (Camera camera : list()) {
			camera.writeJson(json, viewers(camera));
		}
		json.endArray();
		return json.toString();
	}

	@Override
	public Subscription subscribe(String name, Viewer viewer) {
		String key = name.toLowerCase(Locale.ROOT);

		for (int attempt = 0; attempt < 8; attempt++) {
			Camera camera = cameras.get(key);
			if (camera == null) {
				return Subscription.NOT_FOUND;
			}

			CameraSession session = sessions.computeIfAbsent(key, k -> new CameraSession(camera, config, palette, workers));
			if (session.viewerCount() >= config.maxViewersPerCamera) {
				return Subscription.FULL;
			}
			if (session.addViewer(viewer)) {
				return Subscription.OK;
			}

			// The session was disposed between lookup and subscription; replace it.
			sessions.remove(key, session);
		}

		return Subscription.FULL;
	}
}
