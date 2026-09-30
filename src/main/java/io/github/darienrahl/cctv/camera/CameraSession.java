package io.github.darienrahl.cctv.camera;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.BitSet;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Queue;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.Executor;
import java.util.function.IntConsumer;

import org.jspecify.annotations.Nullable;

import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.LightLayer;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.phys.AABB;

import io.github.darienrahl.cctv.CctvConfig;
import io.github.darienrahl.cctv.web.Json;
import io.github.darienrahl.cctv.web.Viewer;

/**
 * Live state of one camera while somebody watches it.
 *
 * <p>Everything except {@link #addViewer} and {@link #viewerCount} runs on the
 * server thread, but the server thread only copies data: section containers are
 * decoded and encoded on worker threads, saved chunks beyond the loaded area are
 * read by the server's IO worker and parsed on worker threads. All rendering
 * happens in the browser.
 */
final class CameraSession {
	/** Drop cached world data after nobody watched for a minute. */
	private static final int IDLE_DISPOSE_TICKS = 20 * 60;
	private static final int BEACON_CHECK_TICKS = 40;
	/** Sections pushed to one viewer per tick while it catches up. */
	private static final int SECTIONS_PER_VIEWER_TICK = 160;
	/**
	 * New sections wait while this many messages are still queued for a viewer: a slow connection gets the world
	 * at the speed it can take instead of overflowing its queue (which drops the viewer and starts it over).
	 */
	private static final int MAX_BACKLOG = 600;
	/** How far ahead of its first missing section a viewer may receive sections that are already available. */
	private static final int SYNC_WINDOW = 4096;
	/** How often far sections are compacted (kept only as their message, see SectionCapture.compact). */
	private static final int COMPACT_TICKS = 100;
	/** How long a viewer that caches sections gets to say which ones it has before the download starts. */
	private static final int CACHE_WAIT_TICKS = 60;
	/** Unchanged cached sections confirmed per viewer and tick (they cost a few bytes each). */
	private static final int KEEPS_PER_VIEWER_TICK = 4096;
	/** Distance from a section centre to its corner. */
	private static final double SECTION_RADIUS = Math.sqrt(3 * 8 * 8);
	/** Sections this close are always included, even behind the camera. */
	private static final double ALWAYS_INCLUDE_DISTANCE = 28;
	/** After a block change, light is re-read for this many ticks (the light engine updates a bit later). */
	private static final int LIGHT_WATCH_TICKS = 30;
	/** Sections hidden under the ground (see {@link #isBuried}) are skipped beyond this distance. */
	private static final double BURIED_KEEP_DISTANCE = 48;
	/** Extra angle around the picture that is streamed as well, so the view can be turned a little. */
	private static final double VIEW_MARGIN_DEGREES = 20;
	/** Surface value of a column without terrain (not generated): nothing there hides anything. */
	private static final int NO_SURFACE = Integer.MIN_VALUE;
	/** Sections closer than this are re-checked every {@code rescanSeconds}, the rest four times less often. */
	private static final double NEAR_RESCAN_DISTANCE = 80;
	/** Saved chunks being read from disk at the same time, per camera. */
	private static final int MAX_DISK_READS = 24;

	private enum Status {
		/** Not looked at yet. */
		NEW,
		/** A snapshot is being decoded or the saved chunk is being read. */
		PENDING,
		/** {@link SectionEntry#data} is valid. */
		READY,
		/** Nothing to show: never generated, not loaded and not saved, or buried deep under the surface. */
		EMPTY
	}

	private static final class SectionEntry {
		final int x;
		final int y;
		final int z;
		final int order;
		final boolean near;
		Status status = Status.NEW;
		@Nullable SectionCapture data;
		/** Snapshots on worker threads. */
		int inFlight;
		/** Block changes made while a snapshot was in flight: re-applied to its result. */
		@Nullable List<int[]> changesInFlight;
		/**
		 * A block entity appeared, went away or changed while a snapshot was in flight: that snapshot has the old
		 * block entities (a player head placed with its owner), so the section is read again once it is in.
		 */
		boolean blockEntitiesStale;
		/** Far enough to be skipped when it lies completely under the ground. */
		boolean mayBeBuried;
		long lightWatchUntil;

		SectionEntry(int x, int y, int z, int order, boolean near) {
			this.x = x;
			this.y = y;
			this.z = z;
			this.order = order;
			this.near = near;
		}

		/** Worth sending: has data that is not just empty, fully sky-lit air (the viewer assumes that for missing sections). */
		boolean sendable() {
			return status == Status.READY && data != null && !data.trivial;
		}
	}

	private record Result(int generation, SectionEntry entry, @Nullable SectionCapture data) {
	}

	private static final class ViewerState {
		final Viewer viewer;
		final BitSet palette = new BitSet();
		/** Sections (by order index) this viewer has received. */
		final BitSet sent = new BitSet();
		/** Every section below this index was handled (sent or nothing to send). */
		int scanFrom;
		boolean ready;
		/** Sections the browser has cached (section key -> hash) from its manifest; null without one. */
		@Nullable Map<Long, Long> cached;
		/** Cached sections found unchanged, confirmed in the next "keep" message. */
		final List<SectionEntry> keeps = new ArrayList<>();
		/** Number of the last "init" sent: the cache manifest must answer that one. */
		int epoch;
		/** Sections wait for the cache manifest until this tick (0: not waiting). */
		long cacheDeadline;

		ViewerState(Viewer viewer) {
			this.viewer = viewer;
		}

		void reset() {
			palette.clear();
			sent.clear();
			scanFrom = 0;
			ready = false;
		}

		boolean has(SectionEntry entry) {
			return sent.get(entry.order);
		}
	}

	private final CctvConfig config;
	private final BlockPalette palette;
	private final Executor workers;
	private final Queue<Viewer> pending = new ConcurrentLinkedQueue<>();
	private final Queue<Result> results = new ConcurrentLinkedQueue<>();
	private final List<ViewerState> viewers = new ArrayList<>();
	private volatile int viewerCount;
	private boolean disposed;

	private Camera camera;
	private @Nullable ServerLevel level;
	private int generation;
	private List<SectionEntry> order = List.of();
	private List<SectionEntry> nearEntries = List.of();
	private List<SectionEntry> farEntries = List.of();
	private final Map<Long, SectionEntry> sections = new HashMap<>();
	private final Map<Long, List<SectionEntry>> columns = new HashMap<>();
	/** Lowest surface point per chunk column; filled on the server thread (loaded chunks) and by workers (saved chunks). */
	private final Map<Long, Integer> surfaceCache = new ConcurrentHashMap<>();
	private int cameraChunkX;
	private int cameraChunkZ;
	/** False while the camera is under the ground (caves, cellars): then it can see buried sections. */
	private boolean skipBuried = true;
	private double coneDegrees = 180;
	/** The field of view the cone was made for: the camera's, or the widest of its viewers' own. */
	private double coneFov;
	private static final double MAX_VIEWER_FOV = 110;
	private int minX;
	private int minY;
	private int minZ;
	private int maxX;
	private int maxY;
	private int maxZ;
	private int captureCursor;
	private int nearRescanCursor;
	private int farRescanCursor;
	private int diskReads;
	private final List<int[]> blockChanges = new ArrayList<>();
	private final Set<SectionEntry> blockEntityRefresh = new HashSet<>();
	private final LinkedHashMap<SectionEntry, Boolean> lightWatch = new LinkedHashMap<>();
	private String biomes = "{}";
	private int idleTicks;
	private boolean needsRebuild = true;
	/** For {@link #writeStatus}: how often and when this session was last ticked. */
	private volatile long ticks;
	private volatile long lastTick;
	private final EnvironmentSampler environment = new EnvironmentSampler();

	CameraSession(Camera camera, CctvConfig config, BlockPalette palette, Executor workers) {
		this.camera = camera;
		this.config = config;
		this.palette = palette;
		this.workers = workers;
	}

	Camera camera() {
		return camera;
	}

	int viewerCount() {
		return viewerCount;
	}

	/** Web thread. Returns {@code false} if the session was disposed meanwhile. */
	synchronized boolean addViewer(Viewer viewer) {
		if (disposed) {
			return false;
		}
		pending.add(viewer);
		viewerCount++;
		return true;
	}

	private synchronized boolean tryDispose() {
		if (pending.isEmpty() && viewers.isEmpty()) {
			disposed = true;
		}
		return disposed;
	}

	/** Camera was moved or re-configured: every viewer starts over. */
	void setCamera(Camera camera) {
		this.camera = camera;
		this.needsRebuild = true;
	}

	/** Something went wrong: viewers are disconnected without "removed", so they reconnect to a new session. */
	synchronized void fail() {
		disposed = true;
		for (ViewerState state : viewers) {
			state.viewer.close();
		}
		viewers.clear();
		Viewer viewer;
		while ((viewer = pending.poll()) != null) {
			viewer.close();
		}
		viewerCount = 0;
	}

	/** Camera was removed. */
	synchronized void closeAll() {
		disposed = true;
		for (ViewerState state : viewers) {
			state.viewer.send("removed", "{}");
			state.viewer.close();
		}
		viewers.clear();
		Viewer viewer;
		while ((viewer = pending.poll()) != null) {
			viewer.send("removed", "{}");
			viewer.close();
		}
		viewerCount = 0;
	}

	/**
	 * @param level the camera's dimension, {@code null} if it does not exist
	 * @return {@code false} once the session is idle and can be forgotten
	 */
	boolean tick(@Nullable ServerLevel level, long tick) {
		ticks++;
		lastTick = tick;
		if (disposed) {
			return false;
		}

		phaseStart = System.nanoTime();
		if (needsRebuild || level != this.level) {
			rebuild(level);
			for (ViewerState state : viewers) {
				state.reset();
				sendInit(state, tick);
			}
		}
		phase(REBUILD);

		Viewer joined;
		while ((joined = pending.poll()) != null) {
			if (joined.isOpen()) {
				ViewerState state = new ViewerState(joined);
				viewers.add(state);
				if (level != null && Math.min(MAX_VIEWER_FOV, joined.fov()) > coneFov + 0.5) {
					// A wider field of view than the cone was made for: the next tick reads the wider cone (the
					// viewers' caches keep what they had) and sends everybody a new "init".
					needsRebuild = true;
				}
				sendInit(state, tick);
				if (level != null) {
					String env = sampleEnvironment(level, tick);
					if (env != null) {
						joined.send("env", env);
					}
				}
			}
		}
		viewers.removeIf(state -> !state.viewer.isOpen());
		viewerCount = viewers.size();

		phase(JOIN);

		if (tick % COMPACT_TICKS == 0) {
			compactFarSections();
		}
		phase(COMPACT);
		if (viewers.isEmpty()) {
			blockChanges.clear();
			blockEntityRefresh.clear();
			results.clear();
			return ++idleTicks <= IDLE_DISPOSE_TICKS || !tryDispose();
		}
		if (idleTicks > 0) {
			// Nobody watched for a while, so block changes were not tracked: read the area again
			// (viewers only receive sections that were read, so they never see stale data).
			idleTicks = 0;
			generation++;
			for (SectionEntry entry : order) {
				entry.status = Status.NEW;
				entry.inFlight = 0;
				entry.changesInFlight = null;
			}
			captureCursor = 0;
			diskReads = 0;
			surfaceCache.clear();
			lightWatch.clear();
		}

		if (level == null) {
			return true;
		}

		phaseStart = System.nanoTime();
		installResults();
		phase(3);
		scheduleCaptures(level);
		phase(4);
		flushBlockChanges(tick);
		if (tick % BEACON_CHECK_TICKS == 0) {
			watchBeacons();
		}
		phase(5);
		refreshBlockEntities(level);
		phase(6);
		refreshLight(level, tick);
		phase(7);
		rescan(level);
		phase(8);
		syncViewers(tick);
		phase(9);

		if (tick % config.entityUpdateTicks == 0) {
			entityBlockStates.clear();
			String entities = entitiesJson(level, tick);
			int[] states = entityBlockStates.stream().mapToInt(Integer::intValue).toArray();
			for (ViewerState state : viewers) {
				if (states.length > 0) {
					// Falling blocks and carried blocks need their block states in the viewer's palette.
					sendPalette(state, states);
				}
				state.viewer.sendEntities(entities);
			}
		}
		phase(10);

		if (tick % EnvironmentSampler.INTERVAL_TICKS == 0) {
			String env = sampleEnvironment(level, tick);
			if (env != null) {
				for (ViewerState state : viewers) {
					state.viewer.send("env", env);
				}
			}
		}
		phase(11);
		if (tick % WeatherSampler.INTERVAL_TICKS == 5) {
			String weather;
			try {
				weather = WeatherSampler.json(level, camera);
			} catch (RuntimeException | LinkageError e) {
				Problems.report(null, "weather sampling", e);
				weather = null;
			}
			if (weather != null) {
				for (ViewerState state : viewers) {
					state.viewer.send("weather", weather);
				}
			}
		}
		phase(12);

		return true;
	}

	/**
	 * Milliseconds of the server thread per tick: a running average (the plain average over the first hundred ticks,
	 * then about the last five seconds, so the first ticks do not linger in it) and the most.
	 */
	private volatile double tickMs;
	private volatile double tickMsMax;
	/** Sections sent in full and their bytes, and sections confirmed from a browser's cache. */
	private volatile long sectionsSent;
	private volatile long sectionBytes;
	private volatile long sectionsKept;

	/** The parts of a tick, and the milliseconds each takes per tick (running averages), for {@code /api/status}. */
	private static final String[] PHASES = {"rebuild", "join", "compact", "results", "captures", "blocks", "blockEntities", "light",
			"rescan", "sync", "entities", "environment", "weather"};
	private static final int REBUILD = 0;
	private static final int JOIN = 1;
	private static final int COMPACT = 2;
	private final double[] phaseMs = new double[PHASES.length];
	private final double[] phaseMax = new double[PHASES.length];
	private final int[] phaseSamples = new int[PHASES.length];
	private long phaseStart;
	private int tickSamples;

	/** Ends the tick's part {@code index} (every tick in which the part runs, whether it did anything or not). */
	private void phase(int index) {
		long now = System.nanoTime();
		double ms = (now - phaseStart) / 1e6;
		phaseMs[index] = average(phaseMs[index], ms, ++phaseSamples[index]);
		phaseMax[index] = Math.max(phaseMax[index], ms);
		phaseStart = now;
	}

	/** Server thread, after every tick: what the tick cost (budgets in CI, {@code /api/status}). */
	void recordTickTime(long nanos) {
		double ms = nanos / 1e6;
		tickMs = average(tickMs, ms, ++tickSamples);
		if (ms > tickMsMax) {
			tickMsMax = ms;
		}
	}

	private static double average(double average, double value, int samples) {
		double weight = Math.max(0.01, 1.0 / Math.min(samples, 1000));
		return average + (value - average) * weight;
	}

	/** Troubleshooting snapshot (web thread; plain reads of server-thread state, good enough for a status page). */
	synchronized void writeStatus(Json json) {
		int[] counts = new int[Status.values().length];
		int compacted = 0;
		for (SectionEntry entry : order) {
			counts[entry.status.ordinal()]++;
			SectionCapture data = entry.data;
			if (data != null && data.states == null) {
				compacted++;
			}
		}
		json.field("camera", camera.name())
				.field("ticks", ticks)
				.field("lastTick", lastTick)
				.field("disposed", disposed)
				.field("idleTicks", idleTicks)
				.field("pending", pending.size())
				.field("viewerCount", viewerCount)
				.field("sections", order.size())
				.field("new", counts[Status.NEW.ordinal()])
				.field("reading", counts[Status.PENDING.ordinal()])
				.field("ready", counts[Status.READY.ordinal()])
				.field("empty", counts[Status.EMPTY.ordinal()])
				.field("captureCursor", captureCursor)
				.field("diskReads", diskReads)
				.field("skipBuried", skipBuried)
				.field("tickMs", tickMs, 3)
				.field("tickMsMax", tickMsMax, 3)
				.field("sectionsSent", sectionsSent)
				.field("sectionBytes", sectionBytes)
				.field("sectionsKept", sectionsKept)
				.field("compacted", compacted);
		json.name("phases").beginObject();
		for (int i = 0; i < PHASES.length; i++) {
			json.field(PHASES[i], phaseMs[i], 3);
		}
		json.endObject();
		json.name("phasesMax").beginObject();
		for (int i = 0; i < PHASES.length; i++) {
			json.field(PHASES[i], phaseMax[i], 3);
		}
		json.endObject();
		json.name("viewers").beginArray();
		for (ViewerState state : List.copyOf(viewers)) {
			json.beginObject()
					.field("open", state.viewer.isOpen())
					.field("backlog", state.viewer.backlog())
					.field("scanFrom", state.scanFrom)
					.field("sent", state.sent.cardinality())
					.field("ready", state.ready)
					.endObject();
		}
		json.endArray();
	}

	private @Nullable String sampleEnvironment(ServerLevel level, long tick) {
		try {
			return environment.json(level, camera, tick);
		} catch (RuntimeException | LinkageError e) {
			// The viewer keeps its last sky and light instead of losing the camera.
			Problems.report(null, "environment sampling", e);
			return null;
		}
	}

	private static SectionCapture.@Nullable Snapshot snapshotSafely(ServerLevel level, SectionEntry entry) {
		try {
			return SectionCapture.snapshot(level, entry.x, entry.y, entry.z);
		} catch (RuntimeException | LinkageError e) {
			Problems.report(null, "reading sections", e);
			return null;
		}
	}

	/** Called by the mixin for every block change in any level. */
	void onBlockChanged(ServerLevel level, int x, int y, int z, BlockState state) {
		if (level != this.level || viewers.isEmpty()
				|| x < minX || x > maxX || y < minY || y > maxY || z < minZ || z > maxZ) {
			return;
		}

		SectionEntry entry = sections.get(key(x >> 4, y >> 4, z >> 4));
		if (entry == null) {
			return;
		}

		int index = ((y & 15) << 8) | ((z & 15) << 4) | (x & 15);
		int id = Block.getId(state);
		if (entry.inFlight > 0) {
			if (entry.changesInFlight == null) {
				entry.changesInFlight = new ArrayList<>(4);
			}
			entry.changesInFlight.add(new int[]{index, id});
			if (state.hasBlockEntity() || entry.data != null && Block.stateById(entry.data.state(index)).hasBlockEntity()) {
				entry.blockEntitiesStale = true;
			}
		}
		if (entry.data == null) {
			return;
		}
		if (entry.data.state(index) == id) {
			// Same block, new block entity data (a sign was edited): read the section again.
			if (state.hasBlockEntity()) {
				blockEntityRefresh.add(entry);
			}
			return;
		}

		// A block entity appeared or went away (a banner placed, a sign broken): its details change with it.
		if (state.hasBlockEntity() || Block.stateById(entry.data.state(index)).hasBlockEntity()) {
			blockEntityRefresh.add(entry);
		}
		entry.data.set(index, id);
		blockChanges.add(new int[]{x, y, z, id, entry.order});
	}

	/**
	 * A beacon's beam changes without a block change next to it (a pyramid finished, glass placed far
	 * above): sections with beacons are read again now and then, like the beacon checks itself.
	 */
	private void watchBeacons() {
		for (SectionEntry entry : order) {
			SectionCapture data = entry.data;
			if (data != null && data.blockEntities != null && data.blockEntities.contains("\"k\":\"beacon\"")) {
				blockEntityRefresh.add(entry);
			}
		}
	}

	/** Re-reads sections whose block entities changed (the result is compared and sent when different). */
	private void refreshBlockEntities(ServerLevel level) {
		if (blockEntityRefresh.isEmpty()) {
			return;
		}
		for (SectionEntry entry : blockEntityRefresh) {
			SectionCapture.Snapshot snapshot = snapshotSafely(level, entry);
			if (snapshot != null) {
				submit(entry, snapshot);
			}
		}
		blockEntityRefresh.clear();
	}

	private void rebuild(@Nullable ServerLevel level) {
		this.level = level;
		this.needsRebuild = false;
		generation++;
		sections.clear();
		columns.clear();
		surfaceCache.clear();
		blockChanges.clear();
		blockEntityRefresh.clear();
		lightWatch.clear();
		results.clear();
		captureCursor = 0;
		nearRescanCursor = 0;
		farRescanCursor = 0;
		diskReads = 0;
		order = List.of();
		nearEntries = List.of();
		farEntries = List.of();

		if (level == null) {
			return;
		}

		try {
			biomes = BiomeTable.json(level);
		} catch (RuntimeException e) {
			biomes = "{}";
		}

		Camera c = camera;
		int range = c.range();

		double yaw = Math.toRadians(c.yaw());
		double pitch = Math.toRadians(c.pitch());
		double fx = -Math.sin(yaw) * Math.cos(pitch);
		double fy = -Math.sin(pitch);
		double fz = Math.cos(yaw) * Math.cos(pitch);

		// Half-angle of the view cone: vertical FOV widened for up to ~21:9 screens, plus a margin
		// (the viewer keeps its picture inside this cone when the view is turned).
		double fov = c.fov();
		for (ViewerState state : viewers) {
			fov = Math.max(fov, Math.min(MAX_VIEWER_FOV, state.viewer.fov()));
		}
		for (Viewer waiting : pending) {
			fov = Math.max(fov, Math.min(MAX_VIEWER_FOV, waiting.fov()));
		}
		coneFov = fov;
		double halfVertical = Math.toRadians(fov / 2);
		double halfAngle = Math.atan(Math.tan(halfVertical) * 2.4) + Math.toRadians(VIEW_MARGIN_DEGREES);
		coneDegrees = Math.toDegrees(halfAngle);

		cameraChunkX = Math.floorDiv((int) Math.floor(c.x()), 16);
		cameraChunkZ = Math.floorDiv((int) Math.floor(c.z()), 16);
		LevelChunk cameraChunk = level.getChunkSource().getChunkNow(cameraChunkX, cameraChunkZ);
		BlockPos eye = BlockPos.containing(c.x(), c.y(), c.z());
		skipBuried = cameraChunk == null
				|| eye.getY() >= cameraChunk.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, eye.getX() & 15, eye.getZ() & 15)
				|| level.getBrightness(LightLayer.SKY, eye) > 7;

		int sx0 = Math.floorDiv((int) Math.floor(c.x() - range), 16);
		int sx1 = Math.floorDiv((int) Math.floor(c.x() + range), 16);
		int sz0 = Math.floorDiv((int) Math.floor(c.z() - range), 16);
		int sz1 = Math.floorDiv((int) Math.floor(c.z() + range), 16);
		int sy0 = Math.max(level.getMinSectionY(), Math.floorDiv((int) Math.floor(c.y() - range), 16));
		int sy1 = Math.min(level.getMinSectionY() + level.getSectionsCount() - 1, Math.floorDiv((int) Math.floor(c.y() + range), 16));

		record Candidate(int x, int y, int z, double distance) {
		}
		List<Candidate> candidates = new ArrayList<>();

		for (int sx = sx0; sx <= sx1; sx++) {
			for (int sz = sz0; sz <= sz1; sz++) {
				for (int sy = sy0; sy <= sy1; sy++) {
					double dx = sx * 16 + 8 - c.x();
					double dy = sy * 16 + 8 - c.y();
					double dz = sz * 16 + 8 - c.z();
					double distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

					if (distance - SECTION_RADIUS > range) {
						continue;
					}

					if (distance > ALWAYS_INCLUDE_DISTANCE) {
						double cos = (dx * fx + dy * fy + dz * fz) / distance;
						double angle = Math.acos(Math.max(-1, Math.min(1, cos)));
						if (angle - Math.asin(Math.min(1, SECTION_RADIUS / distance)) > halfAngle) {
							continue;
						}
					}

					candidates.add(new Candidate(sx, sy, sz, distance));
				}
			}
		}

		candidates.sort((a, b) -> Double.compare(a.distance(), b.distance()));

		List<SectionEntry> entries = new ArrayList<>(candidates.size());
		List<SectionEntry> near = new ArrayList<>();
		List<SectionEntry> far = new ArrayList<>();
		minX = minY = minZ = Integer.MAX_VALUE;
		maxX = maxY = maxZ = Integer.MIN_VALUE;
		for (Candidate candidate : candidates) {
			SectionEntry entry = new SectionEntry(candidate.x(), candidate.y(), candidate.z(), entries.size(),
					candidate.distance() <= NEAR_RESCAN_DISTANCE);
			entry.mayBeBuried = candidate.distance() > BURIED_KEEP_DISTANCE;
			entries.add(entry);
			(entry.near ? near : far).add(entry);
			sections.put(key(entry.x, entry.y, entry.z), entry);
			columns.computeIfAbsent(columnKey(entry.x, entry.z), k -> new ArrayList<>()).add(entry);
			minX = Math.min(minX, entry.x * 16);
			minY = Math.min(minY, entry.y * 16);
			minZ = Math.min(minZ, entry.z * 16);
			maxX = Math.max(maxX, entry.x * 16 + 15);
			maxY = Math.max(maxY, entry.y * 16 + 15);
			maxZ = Math.max(maxZ, entry.z * 16 + 15);
		}
		order = entries;
		nearEntries = near;
		farEntries = far;
	}

	// --- reading the world ---------------------------------------------------

	/**
	 * Far sections inside the ground cannot be seen from the camera, so they are not sent at all. A section is
	 * inside the ground when it lies below the lowest surface point of its chunk and also below the surface of
	 * the neighbouring chunks on the camera's side: where a neighbour is lower (a cliff, a hillside, a cave
	 * entrance) its side faces are visible. Any thread; neighbours that are not known yet keep the section.
	 */
	private boolean isBuried(SectionEntry entry, int ownSurface) {
		if (!entry.mayBeBuried || !skipBuried) {
			return false;
		}
		int top = entry.y * 16 + 15;
		if (!below(top, ownSurface)) {
			return false;
		}
		int dx = Integer.signum(cameraChunkX - entry.x);
		int dz = Integer.signum(cameraChunkZ - entry.z);
		return (dx == 0 || below(top, knownSurface(entry.x + dx, entry.z)))
				&& (dz == 0 || below(top, knownSurface(entry.x, entry.z + dz)));
	}

	private static boolean below(int top, int surface) {
		return surface != NO_SURFACE && top < surface - 1;
	}

	private int knownSurface(int cx, int cz) {
		Integer surface = surfaceCache.get(columnKey(cx, cz));
		return surface == null ? NO_SURFACE : surface;
	}

	/** Server thread: makes the surfaces of loaded neighbour chunks on the camera's side known. */
	private void learnNeighbourSurfaces(ServerLevel level, SectionEntry entry) {
		int dx = Integer.signum(cameraChunkX - entry.x);
		int dz = Integer.signum(cameraChunkZ - entry.z);
		if (dx != 0) {
			learnSurface(level, entry.x + dx, entry.z);
		}
		if (dz != 0) {
			learnSurface(level, entry.x, entry.z + dz);
		}
	}

	private void learnSurface(ServerLevel level, int cx, int cz) {
		if (!surfaceCache.containsKey(columnKey(cx, cz))) {
			LevelChunk chunk = level.getChunkSource().getChunkNow(cx, cz);
			if (chunk != null) {
				minSurface(chunk, cx, cz);
			}
		}
	}

	private int minSurface(LevelChunk chunk, int cx, int cz) {
		long key = columnKey(cx, cz);
		Integer cached = surfaceCache.get(key);
		if (cached != null) {
			return cached;
		}
		int min = Integer.MAX_VALUE;
		for (int z = 0; z < 16; z++) {
			for (int x = 0; x < 16; x++) {
				min = Math.min(min, chunk.getHeight(Heightmap.Types.OCEAN_FLOOR, x, z));
			}
		}
		surfaceCache.put(key, min);
		return min;
	}

	private void scheduleCaptures(ServerLevel level) {
		int budget = config.sectionsPerTick;
		while (captureCursor < order.size() && budget > 0) {
			SectionEntry entry = order.get(captureCursor);
			if (entry.status != Status.NEW) {
				captureCursor++;
				continue;
			}

			LevelChunk chunk = level.getChunkSource().getChunkNow(entry.x, entry.z);
			if (chunk != null) {
				captureCursor++;
				learnNeighbourSurfaces(level, entry);
				if (isBuried(entry, minSurface(chunk, entry.x, entry.z))) {
					entry.status = Status.EMPTY;
					continue;
				}
				SectionCapture.Snapshot snapshot = snapshotSafely(level, entry);
				if (snapshot == null) {
					entry.status = Status.EMPTY;
				} else {
					entry.status = Status.PENDING;
					submit(entry, snapshot);
				}
				budget--;
			} else if (config.farTerrain) {
				if (diskReads >= MAX_DISK_READS) {
					break;
				}
				captureCursor++;
				readSavedChunk(level, entry.x, entry.z);
				budget--;
			} else {
				captureCursor++;
				entry.status = Status.EMPTY;
			}
		}
	}

	private void submit(SectionEntry entry, SectionCapture.Snapshot snapshot) {
		entry.inFlight++;
		int gen = generation;
		workers.execute(() -> {
			SectionCapture data = null;
			try {
				data = snapshot.decode();
			} catch (RuntimeException | LinkageError | AssertionError e) {
				Problems.report(null, "decoding a section", e);
			} finally {
				// always answered, or the section would count as being read forever
				results.add(new Result(gen, entry, data));
			}
		});
	}

	/** Starts reading a whole saved chunk column; every section of it that the camera needs is resolved at once. */
	private void readSavedChunk(ServerLevel level, int cx, int cz) {
		List<SectionEntry> column = columns.getOrDefault(columnKey(cx, cz), List.of());
		List<SectionEntry> wanted = new ArrayList<>(column.size());
		for (SectionEntry entry : column) {
			if (entry.status == Status.NEW) {
				entry.status = Status.PENDING;
				entry.inFlight++;
				wanted.add(entry);
			}
		}
		if (wanted.isEmpty()) {
			return;
		}

		diskReads++;
		int gen = generation;
		learnNeighbourSurfaces(level, wanted.get(0));
		SavedChunks.read(level, cx, cz, workers).whenComplete((parsed, error) -> {
			surfaceCache.putIfAbsent(columnKey(cx, cz), parsed == null ? NO_SURFACE : parsed.minSurfaceY());
			for (SectionEntry entry : wanted) {
				SectionCapture data = null;
				if (parsed != null && !isBuried(entry, parsed.minSurfaceY())) {
					SectionCapture.Snapshot snapshot = parsed.sections().get(entry.y);
					if (snapshot != null) {
						try {
							data = snapshot.decode();
						} catch (RuntimeException e) {
							data = null;
						}
					}
				}
				results.add(new Result(gen, entry, data));
			}
			results.add(new Result(gen, DISK_READ_DONE, null));
		});
	}

	/** Marker result: one saved chunk finished (keeps the number of reads in flight bounded). */
	private static final SectionEntry DISK_READ_DONE = new SectionEntry(0, 0, 0, -1, false);

	private void installResults() {
		Result result;
		while ((result = results.poll()) != null) {
			if (result.generation() != generation) {
				continue;
			}
			SectionEntry entry = result.entry();
			if (entry == DISK_READ_DONE) {
				diskReads--;
				continue;
			}
			entry.inFlight = Math.max(0, entry.inFlight - 1);
			if (entry.inFlight == 0 && entry.blockEntitiesStale) {
				entry.blockEntitiesStale = false;
				blockEntityRefresh.add(entry);
			}

			SectionCapture data = result.data();
			if (data == null) {
				if (entry.status == Status.PENDING) {
					entry.status = Status.EMPTY;
				}
				continue;
			}

			// Blocks changed after the snapshot was taken: the viewers already got them, keep the data consistent.
			if (entry.changesInFlight != null) {
				for (int[] change : entry.changesInFlight) {
					data.set(change[0], change[1]);
				}
				if (entry.inFlight == 0) {
					entry.changesInFlight = null;
				}
			}

			boolean changed = entry.data == null || !data.sameAs(entry.data, entry.x, entry.y, entry.z);
			entry.data = data;
			entry.status = Status.READY;
			if (changed) {
				broadcastSection(entry);
			}
		}
	}

	/**
	 * Far sections keep only their message: they are most of a camera's memory and rarely change (a change or
	 * light update reads the arrays back from the message; a quiet section is compacted again later).
	 */
	private void compactFarSections() {
		for (SectionEntry entry : farEntries) {
			if (entry.data != null && entry.inFlight == 0 && !lightWatch.containsKey(entry)) {
				entry.data.compact(entry.x, entry.y, entry.z);
			}
		}
	}

	/** Slowly re-reads everything loaded: picks up chunks that loaded later and anything the mixin missed. */
	private void rescan(ServerLevel level) {
		if (captureCursor < order.size()) {
			return;
		}
		nearRescanCursor = rescanSome(level, nearEntries, nearRescanCursor, config.rescanSeconds * 20.0);
		farRescanCursor = rescanSome(level, farEntries, farRescanCursor, config.rescanSeconds * 80.0);
	}

	private int rescanSome(ServerLevel level, List<SectionEntry> list, int cursor, double periodTicks) {
		if (list.isEmpty()) {
			return 0;
		}
		int perTick = Math.max(1, (int) Math.ceil(list.size() / periodTicks));
		for (int i = 0; i < perTick; i++) {
			cursor = (cursor + 1) % list.size();
			SectionEntry entry = list.get(cursor);
			if (entry.inFlight > 0) {
				continue;
			}
			LevelChunk chunk = level.getChunkSource().getChunkNow(entry.x, entry.z);
			if (chunk == null) {
				continue;
			}
			surfaceCache.remove(columnKey(entry.x, entry.z));
			learnNeighbourSurfaces(level, entry);
			if (isBuried(entry, minSurface(chunk, entry.x, entry.z))) {
				continue;
			}
			SectionCapture.Snapshot snapshot = snapshotSafely(level, entry);
			if (snapshot != null) {
				if (entry.status != Status.READY) {
					entry.status = Status.PENDING;
				}
				submit(entry, snapshot);
			}
		}
		return cursor;
	}

	/** Light follows block changes a few ticks later; watch the touched sections and resend them when it settles. */
	private void refreshLight(ServerLevel level, long tick) {
		if (lightWatch.isEmpty() || tick % 3 != 0) {
			return;
		}

		Iterator<SectionEntry> iterator = lightWatch.keySet().iterator();
		while (iterator.hasNext()) {
			SectionEntry entry = iterator.next();
			if (entry.data != null && entry.data.refreshLight(level, entry.x, entry.y, entry.z)) {
				broadcastSection(entry);
			}
			if (tick > entry.lightWatchUntil) {
				iterator.remove();
			}
		}
	}

	private void watchLight(SectionEntry entry, long tick) {
		for (int dx = -1; dx <= 1; dx++) {
			for (int dy = -1; dy <= 1; dy++) {
				for (int dz = -1; dz <= 1; dz++) {
					SectionEntry neighbor = sections.get(key(entry.x + dx, entry.y + dy, entry.z + dz));
					if (neighbor != null && neighbor.data != null) {
						neighbor.lightWatchUntil = tick + LIGHT_WATCH_TICKS;
						lightWatch.put(neighbor, Boolean.TRUE);
					}
				}
			}
		}
	}

	// --- sending ---------------------------------------------------------------

	/** Sends a changed section to every viewer that is already past it in its initial download. */
	private void broadcastSection(SectionEntry entry) {
		if (!entry.sendable()) {
			return;
		}
		for (ViewerState state : viewers) {
			if (state.has(entry) || entry.order < state.scanFrom) {
				sendSection(state, entry);
				flushKeeps(state);
			}
		}
	}

	private void syncViewers(long tick) {
		for (ViewerState state : viewers) {
			if (state.viewer.wantsCache() && state.cached == null) {
				long[] manifest = state.viewer.takeCacheManifest(state.epoch);
				if (manifest != null) {
					state.cached = new HashMap<>(manifest.length / 2);
					for (int i = 0; i + 3 < manifest.length; i += 4) {
						state.cached.put(key((int) manifest[i], (int) manifest[i + 1], (int) manifest[i + 2]), manifest[i + 3]);
					}
					state.cacheDeadline = 0;
				} else if (tick < state.cacheDeadline) {
					// the browser is still reading its cache
					continue;
				}
			}
			int sent = 0;
			int kept = 0;
			int allowance = Math.min(SECTIONS_PER_VIEWER_TICK, (MAX_BACKLOG - state.viewer.backlog()) / 2);
			// Skip everything that is handled; stop at the first section that is still being read.
			while (state.scanFrom < order.size()) {
				SectionEntry entry = order.get(state.scanFrom);
				if (entry.status == Status.NEW || entry.status == Status.PENDING) {
					break;
				}
				if (entry.sendable() && !state.has(entry)) {
					if (sent >= allowance || kept >= KEEPS_PER_VIEWER_TICK) {
						break;
					}
					if (sendSection(state, entry)) {
						kept++;
					} else {
						sent++;
					}
				}
				state.scanFrom++;
			}
			// Sections further on that are already available do not have to wait for a slow disk read.
			int end = Math.min(order.size(), state.scanFrom + SYNC_WINDOW);
			for (int i = state.scanFrom; i < end && sent < allowance && kept < KEEPS_PER_VIEWER_TICK; i++) {
				SectionEntry entry = order.get(i);
				if (entry.sendable() && !state.has(entry)) {
					if (sendSection(state, entry)) {
						kept++;
					} else {
						sent++;
					}
				}
			}
			flushKeeps(state);

			if (!state.ready && state.scanFrom >= order.size()) {
				state.ready = true;
				state.viewer.send("ready", "{}");
			} else if (!state.ready && tick % 10 == 0) {
				state.viewer.send("progress", "{\"d\":" + state.scanFrom + ",\"t\":" + order.size() + "}");
			}
		}
	}

	private void flushBlockChanges(long tick) {
		if (blockChanges.isEmpty()) {
			return;
		}

		for (int[] change : blockChanges) {
			SectionEntry entry = order.get(change[4]);
			if (entry.lightWatchUntil < tick + LIGHT_WATCH_TICKS - 5) {
				watchLight(entry, tick);
			}
		}

		for (ViewerState state : viewers) {
			int[] ids = new int[blockChanges.size()];
			int count = 0;
			for (int[] change : blockChanges) {
				SectionEntry entry = order.get(change[4]);
				if (state.has(entry)) {
					ids[count++] = change[3];
				} else if (entry.order < state.scanFrom && entry.sendable()) {
					// The section was empty air when the viewer passed it; now it has blocks.
					sendSection(state, entry);
				}
			}
			flushKeeps(state);
			if (count == 0) {
				continue;
			}
			sendPalette(state, Arrays.copyOf(ids, count));

			Json json = new Json(32 + count * 24);
			json.beginObject().name("b").beginArray();
			for (int[] change : blockChanges) {
				if (state.has(order.get(change[4]))) {
					json.beginArray().value(change[0]).value(change[1]).value(change[2]).value(change[3]).endArray();
				}
			}
			json.endArray().endObject();
			state.viewer.send("blocks", json.toString());
		}

		blockChanges.clear();
	}

	/**
	 * Sends a section, or when the browser has this very section cached, only its palette and a "keep" for it.
	 * @return whether it was kept (cheap) rather than sent
	 */
	private boolean sendSection(ViewerState state, SectionEntry entry) {
		SectionCapture data = entry.data;
		if (data == null) {
			return false;
		}
		sendPalette(state, data.distinct);
		state.sent.set(entry.order);
		if (state.cached != null) {
			Long cachedHash = state.cached.remove(key(entry.x, entry.y, entry.z));
			if (cachedHash != null && cachedHash == data.hash(entry.x, entry.y, entry.z)) {
				state.keeps.add(entry);
				sectionsKept++;
				return true;
			}
		}
		String json = data.json(entry.x, entry.y, entry.z);
		state.viewer.send("section", json);
		sectionsSent++;
		sectionBytes += json.length();
		return false;
	}

	/** "keep": the cached sections the browser can show as they are, {"k": [x, y, z, x, y, z...]}. */
	private void flushKeeps(ViewerState state) {
		if (state.keeps.isEmpty()) {
			return;
		}
		Json json = new Json(16 + state.keeps.size() * 16);
		json.beginObject().name("k").beginArray();
		for (SectionEntry entry : state.keeps) {
			json.value(entry.x).value(entry.y).value(entry.z);
		}
		json.endArray().endObject();
		state.viewer.send("keep", json.toString());
		state.keeps.clear();
	}

	private void sendPalette(ViewerState state, int[] ids) {
		Json json = null;
		for (int id : ids) {
			if (state.palette.get(id)) {
				continue;
			}
			state.palette.set(id);
			if (json == null) {
				json = new Json(512);
				json.beginObject().name("s").beginArray();
			}
			json.raw(palette.describe(id));
		}
		if (json != null) {
			json.endArray().endObject();
			state.viewer.send("palette", json.toString());
		}
	}

	/** "init" (again after the camera moved or its world was read anew); a caching viewer answers with its manifest. */
	private void sendInit(ViewerState state, long tick) {
		state.epoch++;
		state.cached = null;
		state.keeps.clear();
		state.cacheDeadline = state.viewer.wantsCache() ? tick + CACHE_WAIT_TICKS : 0;
		state.viewer.send("init", initJson(tick, state));
	}

	private String initJson(long tick, ViewerState state) {
		Json json = new Json(512);
		json.beginObject().name("camera");
		camera.writeJson(json, viewerCount);
		if (state.viewer.wantsCache()) {
			json.field("vid", state.viewer.id()).field("epoch", state.epoch);
		}
		json.field("sections", order.size())
				.field("cone", coneDegrees, 1)
				.field("tick", tick)
				.field("entityTicks", config.entityUpdateTicks)
				.field("loaded", level != null);
		if (level != null) {
			EnvironmentSampler.writeDimension(json, level);
		}
		json.name("biomes").raw(biomes).endObject();
		return json.toString();
	}

	/** Block states shown by entities in the current frame (falling blocks, carried blocks). */
	private final Set<Integer> entityBlockStates = new HashSet<>();

	/** Particle effects since the last entity frame (server thread), sent with it as "fx" (see EffectEncoder). */
	private final List<String> effects = new ArrayList<>();
	/** Block states the effects show (broken blocks), for the viewers' palettes. */
	private final Set<Integer> effectBlockStates = new HashSet<>();
	private static final int MAX_EFFECTS = 256;

	/**
	 * Server thread: an effect at (x, y, z) goes into the next entity frame when it would reach a player standing
	 * at the camera (range: how far the game sends it). The encoder gets a sink for the block states it shows.
	 */
	void onEffect(ServerLevel level, double x, double y, double z, double range, java.util.function.Function<IntConsumer, String> encoder) {
		if (level != this.level || viewers.isEmpty() || effects.size() >= MAX_EFFECTS) {
			return;
		}
		Camera c = camera;
		double dx = x - c.x(), dy = y - c.y(), dz = z - c.z();
		if (dx * dx + dy * dy + dz * dz > range * range) {
			return;
		}
		String fx = encoder.apply(effectBlockStates::add);
		if (fx != null) {
			effects.add(fx);
		}
	}

	/** Blocks being broken (ClientboundBlockDestroyPacket) by breaker id: x, y, z, progress 0..9, last update tick. */
	private final Map<Integer, long[]> breaking = new HashMap<>();
	/** LevelRenderer forgets a breaking block 400 ticks after its last update. */
	private static final long BREAKING_TIMEOUT = 400;

	/**
	 * Server thread: ServerLevel#destroyBlockProgress, which players within 32 blocks get; the viewer draws the
	 * cracks. Progress outside 0..9 means the breaking stopped (or the block broke).
	 */
	void onBlockProgress(ServerLevel level, int breaker, BlockPos pos, int progress) {
		if (level != this.level) {
			return;
		}
		if (progress < 0 || progress >= 10) {
			breaking.remove(breaker);
			return;
		}
		Camera c = camera;
		double dx = pos.getX() + 0.5 - c.x(), dy = pos.getY() + 0.5 - c.y(), dz = pos.getZ() + 0.5 - c.z();
		if (dx * dx + dy * dy + dz * dz >= 1024) {
			return;
		}
		breaking.put(breaker, new long[]{pos.getX(), pos.getY(), pos.getZ(), progress, level.getGameTime()});
	}

	/** Server thread: the entity event range of the camera (the entities it streams). */
	double entityEffectRange() {
		return Math.min(camera.range(), config.entityRange);
	}

	/** Entity events since the last entity frame, by entity id (server thread). */
	private final Map<Integer, List<Integer>> entityEvents = new HashMap<>();

	/** Server thread: an entity event (ServerLevel.broadcastEntityEvent) near the camera goes into the next frame. */
	void onEntityEvent(ServerLevel level, Entity entity, byte event) {
		if (level != this.level || viewers.isEmpty()) {
			return;
		}
		Camera c = camera;
		double range = Math.min(c.range(), config.entityRange);
		if (Math.abs(entity.getX() - c.x()) > range || Math.abs(entity.getY() - c.y()) > range || Math.abs(entity.getZ() - c.z()) > range) {
			return;
		}
		List<Integer> events = entityEvents.computeIfAbsent(entity.getId(), id -> new ArrayList<>(2));
		if (events.size() < 16) {
			events.add((int) event);
		}
	}

	private String entitiesJson(ServerLevel level, long tick) {
		Camera c = camera;
		double range = Math.min(c.range(), config.entityRange);
		AABB box = new AABB(c.x() - range, c.y() - range, c.z() - range, c.x() + range, c.y() + range, c.z() + range);
		List<Entity> entities = level.getEntitiesOfClass(Entity.class, box, entity -> true);

		Json json = new Json(64 + entities.size() * 220);
		json.beginObject().field("t", tick).name("e").beginArray();
		for (Entity entity : entities) {
			String type = BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString();
			if (EntityEncoder.shouldSend(entity, type)) {
				long mark = json.mark();
				try {
					EntityEncoder.write(json, entity, type, entityBlockStates::add, entityEvents.get(entity.getId()));
				} catch (RuntimeException | LinkageError e) {
					// One entity the encoder does not understand (mod entity, changed game API) is left out.
					json.reset(mark);
					Problems.report(null, "entity " + type, e);
				}
			}
		}
		entityEvents.clear();
		json.endArray();
		if (!effects.isEmpty()) {
			json.name("fx").beginArray();
			for (String fx : effects) {
				json.raw(fx);
			}
			json.endArray();
			effects.clear();
			entityBlockStates.addAll(effectBlockStates);
			effectBlockStates.clear();
		}
		if (!breaking.isEmpty()) {
			long now = level.getGameTime();
			breaking.values().removeIf(entry -> now - entry[4] > BREAKING_TIMEOUT);
			json.name("bp").beginArray();
			for (long[] entry : breaking.values()) {
				json.beginArray().value(entry[0]).value(entry[1]).value(entry[2]).value(entry[3]).endArray();
			}
			json.endArray();
		}
		json.endObject();
		return json.toString();
	}

	private static long key(int sx, int sy, int sz) {
		return ((long) sx & 0x3FFFFFL) << 42 | ((long) sz & 0x3FFFFFL) << 20 | ((long) sy & 0xFFFFFL);
	}

	private static long columnKey(int cx, int cz) {
		return ((long) cx << 32) | (cz & 0xFFFFFFFFL);
	}
}
