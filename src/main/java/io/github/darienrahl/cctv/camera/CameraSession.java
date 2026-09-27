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

import org.jspecify.annotations.Nullable;

import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;

import io.github.darienrahl.cctv.CctvConfig;
import io.github.darienrahl.cctv.web.Json;
import io.github.darienrahl.cctv.web.Viewer;

/**
 * Live state of one camera while somebody watches it.
 *
 * <p>Everything except {@link #addViewer} and {@link #viewerCount} runs on the
 * server thread. The server only copies block state ids out of loaded chunks
 * and serializes entity positions; all rendering happens in the browser.
 */
final class CameraSession {
	/** Drop cached world data after nobody watched for a minute. */
	private static final int IDLE_DISPOSE_TICKS = 20 * 60;
	/** Cached sections pushed to one viewer per tick while it catches up. */
	private static final int SECTIONS_PER_VIEWER_TICK = 128;
	/** Distance from a section centre to its corner. */
	private static final double SECTION_RADIUS = Math.sqrt(3 * 8 * 8);
	/** Sections this close are always included, even behind the camera. */
	private static final double ALWAYS_INCLUDE_DISTANCE = 28;
	/** After a block change, light is re-read for this many ticks (the light engine updates a bit later). */
	private static final int LIGHT_WATCH_TICKS = 30;

	private static final class SectionEntry {
		final int x;
		final int y;
		final int z;
		final int order;
		/** {@code null} while the chunk is not loaded. */
		@Nullable SectionCapture data;
		int @Nullable [] distinct;
		@Nullable String encoded;
		long lightWatchUntil;

		SectionEntry(int x, int y, int z, int order) {
			this.x = x;
			this.y = y;
			this.z = z;
			this.order = order;
		}

		void changed() {
			encoded = null;
			distinct = null;
		}

		String json() {
			if (encoded == null) {
				encoded = data.json(x, y, z);
			}
			return encoded;
		}

		int[] distinct() {
			if (distinct == null) {
				distinct = Arrays.stream(data.states).distinct().toArray();
			}
			return distinct;
		}
	}

	private static final class ViewerState {
		final Viewer viewer;
		final BitSet palette = new BitSet();
		/** Sections with an order index below this were sent to the viewer. */
		int syncIndex;
		boolean ready;

		ViewerState(Viewer viewer) {
			this.viewer = viewer;
		}

		void reset() {
			palette.clear();
			syncIndex = 0;
			ready = false;
		}
	}

	private final CctvConfig config;
	private final BlockPalette palette;
	private final Queue<Viewer> pending = new ConcurrentLinkedQueue<>();
	private final List<ViewerState> viewers = new ArrayList<>();
	private volatile int viewerCount;
	private boolean disposed;

	private Camera camera;
	private @Nullable ServerLevel level;
	private List<SectionEntry> order = List.of();
	private final Map<Long, SectionEntry> sections = new HashMap<>();
	private int minX;
	private int minY;
	private int minZ;
	private int maxX;
	private int maxY;
	private int maxZ;
	private int worldMinY;
	private int worldMaxY;
	private int captureCursor;
	private int rescanCursor;
	private final List<int[]> blockChanges = new ArrayList<>();
	private final LinkedHashMap<SectionEntry, Boolean> lightWatch = new LinkedHashMap<>();
	private String biomes = "{}";
	private int idleTicks;
	private boolean needsRebuild = true;

	CameraSession(Camera camera, CctvConfig config, BlockPalette palette) {
		this.camera = camera;
		this.config = config;
		this.palette = palette;
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
					joined.send("env", envJson(level));
				}
			}
		}
		viewers.removeIf(state -> !state.viewer.isOpen());
		viewerCount = viewers.size();

		if (viewers.isEmpty()) {
			blockChanges.clear();
			return ++idleTicks <= IDLE_DISPOSE_TICKS || !tryDispose();
		}
		idleTicks = 0;

		if (level == null) {
			return true;
		}

		captureNewSections(level);
		flushBlockChanges(tick);
		refreshLight(level, tick);
		rescan(level);
		syncViewers();

		if (tick % config.entityUpdateTicks == 0) {
			String entities = entitiesJson(level, tick);
			for (ViewerState state : viewers) {
				state.viewer.sendEntities(entities);
			}
		}

		if (tick % 20 == 0) {
			String env = envJson(level);
			for (ViewerState state : viewers) {
				state.viewer.send("env", env);
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
		if (entry == null || entry.data == null) {
			return;
		}

		int index = ((y & 15) << 8) | ((z & 15) << 4) | (x & 15);
		int id = Block.getId(state);
		if (entry.data.states[index] == id) {
			return;
		}

		entry.data.states[index] = id;
		entry.changed();
		blockChanges.add(new int[]{x, y, z, id, entry.order});
	}

	private void rebuild(@Nullable ServerLevel level) {
		this.level = level;
		this.needsRebuild = false;
		sections.clear();
		blockChanges.clear();
		lightWatch.clear();
		captureCursor = 0;
		rescanCursor = 0;
		order = List.of();

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
		worldMinY = level.getMinSectionY() * 16;
		worldMaxY = (level.getMinSectionY() + level.getSectionsCount()) * 16;

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
						if (angle - Math.asin(SECTION_RADIUS / distance) > halfAngle) {
							continue;
						}
					}

					candidates.add(new Candidate(sx, sy, sz, distance));
				}
			}
		}

		candidates.sort((a, b) -> Double.compare(a.distance(), b.distance()));

		List<SectionEntry> entries = new ArrayList<>(candidates.size());
		minX = minY = minZ = Integer.MAX_VALUE;
		maxX = maxY = maxZ = Integer.MIN_VALUE;
		for (Candidate candidate : candidates) {
			SectionEntry entry = new SectionEntry(candidate.x(), candidate.y(), candidate.z(), entries.size());
			entries.add(entry);
			sections.put(key(entry.x, entry.y, entry.z), entry);
			minX = Math.min(minX, entry.x * 16);
			minY = Math.min(minY, entry.y * 16);
			minZ = Math.min(minZ, entry.z * 16);
			maxX = Math.max(maxX, entry.x * 16 + 15);
			maxY = Math.max(maxY, entry.y * 16 + 15);
			maxZ = Math.max(maxZ, entry.z * 16 + 15);
		}
		order = entries;
	}

	private void captureNewSections(ServerLevel level) {
		int budget = config.sectionsPerTick;
		while (captureCursor < order.size() && budget-- > 0) {
			SectionEntry entry = order.get(captureCursor++);
			entry.data = SectionCapture.capture(level, entry.x, entry.y, entry.z);
		}
	}

	/** Slowly re-reads everything: picks up chunks that loaded later and anything the mixin missed. */
	private void rescan(ServerLevel level) {
		if (captureCursor < order.size() || order.isEmpty()) {
			return;
		}

		int perTick = Math.max(1, (int) Math.ceil(order.size() / (config.rescanSeconds * 20.0)));
		for (int i = 0; i < perTick; i++) {
			rescanCursor = (rescanCursor + 1) % order.size();
			SectionEntry entry = order.get(rescanCursor);
			SectionCapture data = SectionCapture.capture(level, entry.x, entry.y, entry.z);
			if (data == null || (entry.data != null && data.sameAs(entry.data))) {
				continue;
			}

			entry.data = data;
			entry.changed();
			broadcastSection(entry);
		}
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
				entry.changed();
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

	private void broadcastSection(SectionEntry entry) {
		for (ViewerState state : viewers) {
			if (entry.order < state.syncIndex) {
				sendSection(state, entry);
			}
		}
	}

	private void syncViewers() {
		for (ViewerState state : viewers) {
			int sent = 0;
			while (state.syncIndex < captureCursor && sent < SECTIONS_PER_VIEWER_TICK) {
				SectionEntry entry = order.get(state.syncIndex++);
				if (entry.data != null) {
					sendSection(state, entry);
					sent++;
				}
			}

			if (!state.ready && state.syncIndex >= order.size()) {
				state.ready = true;
				state.viewer.send("ready", "{}");
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
				if (change[4] < state.syncIndex) {
					ids[count++] = change[3];
				}
			}
			if (count == 0) {
				continue;
			}
			sendPalette(state, Arrays.copyOf(ids, count));

			Json json = new Json(32 + count * 24);
			json.beginObject().name("b").beginArray();
			for (int[] change : blockChanges) {
				if (change[4] < state.syncIndex) {
					json.beginArray().value(change[0]).value(change[1]).value(change[2]).value(change[3]).endArray();
				}
			}
			json.endArray().endObject();
			state.viewer.send("blocks", json.toString());
		}

		blockChanges.clear();
	}

	private void sendSection(ViewerState state, SectionEntry entry) {
		sendPalette(state, entry.distinct());
		state.viewer.send("section", entry.json());
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
				.field("minY", worldMinY)
				.field("maxY", worldMaxY)
				.field("tick", tick)
				.field("entityTicks", config.entityUpdateTicks)
				.field("loaded", level != null)
				.name("biomes").raw(biomes)
				.endObject();
		return json.toString();
	}

	private static String envJson(ServerLevel level) {
		return new Json(96).beginObject()
				.field("time", level.getOverworldClockTime())
				.field("rain", level.isRaining())
				.field("thunder", level.isThundering())
				.endObject()
				.toString();
	}

	private String entitiesJson(ServerLevel level, long tick) {
		Camera c = camera;
		double range = c.range();
		AABB box = new AABB(c.x() - range, c.y() - range, c.z() - range, c.x() + range, c.y() + range, c.z() + range);
		List<Entity> entities = level.getEntitiesOfClass(Entity.class, box, entity -> true);

		Json json = new Json(64 + entities.size() * 200);
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
}
