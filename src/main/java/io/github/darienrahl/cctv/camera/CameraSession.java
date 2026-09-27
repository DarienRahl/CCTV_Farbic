package io.github.darienrahl.cctv.camera;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.BitSet;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.Executor;

import org.jspecify.annotations.Nullable;

import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
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
	/** Sections pushed to one viewer per tick while it catches up. */
	private static final int SECTIONS_PER_VIEWER_TICK = 160;
	/** How far ahead of its first missing section a viewer may receive sections that are already available. */
	private static final int SYNC_WINDOW = 4096;
	/** Distance from a section centre to its corner. */
	private static final double SECTION_RADIUS = Math.sqrt(3 * 8 * 8);
	/** Sections this close are always included, even behind the camera. */
	private static final double ALWAYS_INCLUDE_DISTANCE = 28;
	/** After a block change, light is re-read for this many ticks (the light engine updates a bit later). */
	private static final int LIGHT_WATCH_TICKS = 30;
	/** Sections completely below the lowest surface point of their chunk are skipped beyond this distance. */
	private static final double BURIED_KEEP_DISTANCE = 48;
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
	private final Map<Long, Integer> surfaceCache = new HashMap<>();
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
	private final LinkedHashMap<SectionEntry, Boolean> lightWatch = new LinkedHashMap<>();
	private String biomes = "{}";
	private int idleTicks;
	private boolean needsRebuild = true;
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
		if (disposed) {
			return false;
		}

		if (needsRebuild || level != this.level) {
			rebuild(level);
			for (ViewerState state : viewers) {
				state.reset();
				state.viewer.send("init", initJson(tick));
			}
		}

		Viewer joined;
		while ((joined = pending.poll()) != null) {
			if (joined.isOpen()) {
				viewers.add(new ViewerState(joined));
				joined.send("init", initJson(tick));
				if (level != null) {
					joined.send("env", environment.json(level, camera, tick));
				}
			}
		}
		viewers.removeIf(state -> !state.viewer.isOpen());
		viewerCount = viewers.size();

		if (viewers.isEmpty()) {
			blockChanges.clear();
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

		installResults();
		scheduleCaptures(level);
		flushBlockChanges(tick);
		refreshLight(level, tick);
		rescan(level);
		syncViewers(tick);

		if (tick % config.entityUpdateTicks == 0) {
			String entities = entitiesJson(level, tick);
			for (ViewerState state : viewers) {
				state.viewer.sendEntities(entities);
			}
		}

		if (tick % EnvironmentSampler.INTERVAL_TICKS == 0) {
			String env = environment.json(level, camera, tick);
			for (ViewerState state : viewers) {
				state.viewer.send("env", env);
			}
		}
		if (tick % WeatherSampler.INTERVAL_TICKS == 5) {
			String weather = WeatherSampler.json(level, camera);
			if (weather != null) {
				for (ViewerState state : viewers) {
					state.viewer.send("weather", weather);
				}
			}
		}

		return true;
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
		}
		if (entry.data == null || entry.data.states[index] == id) {
			return;
		}

		entry.data.set(index, id);
		blockChanges.add(new int[]{x, y, z, id, entry.order});
	}

	private void rebuild(@Nullable ServerLevel level) {
		this.level = level;
		this.needsRebuild = false;
		generation++;
		sections.clear();
		columns.clear();
		surfaceCache.clear();
		blockChanges.clear();
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

		// Half-angle of the view cone: vertical FOV widened for up to ~21:9 screens, plus a margin.
		double halfVertical = Math.toRadians(c.fov() / 2);
		double halfAngle = Math.atan(Math.tan(halfVertical) * 2.4) + Math.toRadians(12);

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
	 * Far sections that lie completely below the lowest surface point of their chunk cannot be seen from the
	 * camera (they are inside the ground), so they are not sent at all.
	 */
	private static boolean isBuried(SectionEntry entry, int minSurfaceY) {
		return entry.mayBeBuried && minSurfaceY != Integer.MIN_VALUE && entry.y * 16 + 15 < minSurfaceY - 1;
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
				if (isBuried(entry, minSurface(chunk, entry.x, entry.z))) {
					entry.status = Status.EMPTY;
					continue;
				}
				SectionCapture.Snapshot snapshot = SectionCapture.snapshot(level, entry.x, entry.y, entry.z);
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
			SectionCapture data;
			try {
				data = snapshot.decode();
			} catch (RuntimeException e) {
				data = null;
			}
			results.add(new Result(gen, entry, data));
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
		SavedChunks.read(level, cx, cz, workers).whenComplete((parsed, error) -> {
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

			boolean changed = entry.data == null || !data.sameAs(entry.data);
			entry.data = data;
			entry.status = Status.READY;
			if (changed) {
				broadcastSection(entry);
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
			if (isBuried(entry, minSurface(chunk, entry.x, entry.z))) {
				continue;
			}
			SectionCapture.Snapshot snapshot = SectionCapture.snapshot(level, entry.x, entry.y, entry.z);
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
			}
		}
	}

	private void syncViewers(long tick) {
		for (ViewerState state : viewers) {
			int sent = 0;
			// Skip everything that is handled; stop at the first section that is still being read.
			while (state.scanFrom < order.size()) {
				SectionEntry entry = order.get(state.scanFrom);
				if (entry.status == Status.NEW || entry.status == Status.PENDING) {
					break;
				}
				if (entry.sendable() && !state.has(entry)) {
					if (sent >= SECTIONS_PER_VIEWER_TICK) {
						break;
					}
					sendSection(state, entry);
					sent++;
				}
				state.scanFrom++;
			}
			// Sections further on that are already available do not have to wait for a slow disk read.
			int end = Math.min(order.size(), state.scanFrom + SYNC_WINDOW);
			for (int i = state.scanFrom; i < end && sent < SECTIONS_PER_VIEWER_TICK; i++) {
				SectionEntry entry = order.get(i);
				if (entry.sendable() && !state.has(entry)) {
					sendSection(state, entry);
					sent++;
				}
			}

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

	private void sendSection(ViewerState state, SectionEntry entry) {
		SectionCapture data = entry.data;
		if (data == null) {
			return;
		}
		sendPalette(state, data.distinct);
		state.viewer.send("section", data.json(entry.x, entry.y, entry.z));
		state.sent.set(entry.order);
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

	private String initJson(long tick) {
		Json json = new Json(512);
		json.beginObject().name("camera");
		camera.writeJson(json, viewerCount);
		json.field("sections", order.size())
				.field("tick", tick)
				.field("entityTicks", config.entityUpdateTicks)
				.field("loaded", level != null);
		if (level != null) {
			EnvironmentSampler.writeDimension(json, level);
		}
		json.name("biomes").raw(biomes).endObject();
		return json.toString();
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
				EntityEncoder.write(json, entity, type);
			}
		}
		json.endArray().endObject();
		return json.toString();
	}

	private static long key(int sx, int sy, int sz) {
		return ((long) sx & 0x3FFFFFL) << 42 | ((long) sz & 0x3FFFFFL) << 20 | ((long) sy & 0xFFFFFL);
	}

	private static long columnKey(int cx, int cz) {
		return ((long) cx << 32) | (cz & 0xFFFFFFFFL);
	}
}
