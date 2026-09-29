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
import net.minecraft.core.particles.ExplosionParticleInfo;
import net.minecraft.core.particles.ParticleOptions;
import net.minecraft.network.protocol.game.ClientboundLevelParticlesPacket.RandomizationType;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.random.WeightedList;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

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

	/** Any thread. Somebody watches a camera (or is connecting to one): the server must not pause. */
	public boolean isWatched() {
		for (CameraSession session : sessions.values()) {
			if (session.viewerCount() > 0) {
				return true;
			}
		}
		return false;
	}

	/** End of every server tick. */
	public void tick() {
		tick++;
		if (sessions.isEmpty()) {
			return;
		}

		for (Map.Entry<String, CameraSession> entry : sessions.entrySet()) {
			CameraSession session = entry.getValue();
			boolean alive;
			try {
				alive = session.tick(findLevel(session.camera().dimension()), tick);
			} catch (RuntimeException | LinkageError e) {
				// Never take the game server down: drop the session, its viewers reconnect to a fresh one.
				Problems.report(logger, "camera " + session.camera().name(), e);
				session.fail();
				alive = false;
			}
			if (!alive) {
				// Conditional remove: a web thread may already have replaced the disposed session.
				if (sessions.remove(entry.getKey(), session)) {
					logger.info("CCTV: nobody watched camera '{}' for a minute, its data was released", session.camera().name());
				}
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

	/** Called (server thread) for every entity event sent to players. */
	public void onEntityEvent(ServerLevel level, Entity entity, byte event) {
		if (sessions.isEmpty()) {
			return;
		}
		for (CameraSession session : sessions.values()) {
			session.onEntityEvent(level, entity, event);
			session.onEffect(level, entity.getX(), entity.getY(), entity.getZ(), session.entityEffectRange(),
					states -> EffectEncoder.entityEvent(entity, event));
		}
	}

	/** Called (server thread) for every level event sent to players (ServerLevel#levelEvent, 64 blocks). */
	public void onLevelEvent(ServerLevel level, int type, BlockPos pos, int data) {
		if (sessions.isEmpty()) {
			return;
		}
		for (CameraSession session : sessions.values()) {
			session.onEffect(level, pos.getX() + 0.5, pos.getY() + 0.5, pos.getZ() + 0.5, 64,
					states -> EffectEncoder.levelEvent(level, type, pos, data, states));
		}
	}

	/** Called (server thread) for every particle packet sent to the players nearby (ServerLevel#sendParticles). */
	public void onParticles(ServerLevel level, ParticleOptions particle, boolean overrideLimiter, double x, double y, double z, int count,
			double xDist, double yDist, double zDist, double xSpeed, double ySpeed, double zSpeed, RandomizationType randomization) {
		if (sessions.isEmpty()) {
			return;
		}
		for (CameraSession session : sessions.values()) {
			// ServerLevel#sendParticles(ServerPlayer, ...): 32 blocks, 512 for particles that ignore the limit
			session.onEffect(level, x, y, z, overrideLimiter ? 512 : 32, states -> EffectEncoder.particles(level, particle, overrideLimiter,
					x, y, z, count, xDist, yDist, zDist, xSpeed, ySpeed, zSpeed, randomization, states));
		}
	}

	/** Called (server thread) for every explosion (ServerLevel#explode sends it to players within 64 blocks). */
	public void onExplosion(ServerLevel level, Vec3 center, float radius, int blockCount, ParticleOptions particle,
			WeightedList<ExplosionParticleInfo> blockParticles) {
		if (sessions.isEmpty()) {
			return;
		}
		for (CameraSession session : sessions.values()) {
			session.onEffect(level, center.x(), center.y(), center.z(), 64,
					states -> EffectEncoder.explosion(center, radius, blockCount, particle, blockParticles));
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
	public byte @Nullable [] mapPicture(int id) {
		return MapPictures.rgba(id);
	}

	@Override
	public String statusJson() {
		Json json = new Json(1024);
		json.beginObject().field("tick", tick).field("serverTick", server.getTickCount()).field("watched", isWatched()).name("sessions").beginArray();
		for (Map.Entry<String, CameraSession> entry : sessions.entrySet()) {
			json.beginObject().field("key", entry.getKey());
			entry.getValue().writeStatus(json);
			json.endObject();
		}
		json.endArray();
		if (Boolean.getBoolean("cctv.debug")) {
			// Development runs: where the server thread and the CCTV threads are right now.
			json.name("threads").beginArray();
			for (Map.Entry<Thread, StackTraceElement[]> entry : Thread.getAllStackTraces().entrySet()) {
				String name = entry.getKey().getName();
				if (!name.equals("Server thread") && !name.startsWith("cctv")) {
					continue;
				}
				StringBuilder stack = new StringBuilder();
				for (StackTraceElement element : entry.getValue()) {
					if (stack.length() > 3000) {
						break;
					}
					stack.append(element).append(" | ");
				}
				json.beginObject().field("name", name).field("state", entry.getKey().getState().name()).field("stack", stack.toString()).endObject();
			}
			json.endArray();
		}
		return json.endObject().toString();
	}

	@Override
	public Subscription subscribe(String name, Viewer viewer) {
		String key = name.toLowerCase(Locale.ROOT);

		for (int attempt = 0; attempt < 8; attempt++) {
			Camera camera = cameras.get(key);
			if (camera == null) {
				return Subscription.NOT_FOUND;
			}

			CameraSession session = sessions.computeIfAbsent(key, k -> {
				logger.info("CCTV: camera '{}' is being watched, streaming starts", camera.name());
				return new CameraSession(camera, config, palette, workers);
			});
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
