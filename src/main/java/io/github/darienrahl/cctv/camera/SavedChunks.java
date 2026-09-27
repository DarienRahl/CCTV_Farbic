package io.github.darienrahl.cctv.camera;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;

import org.jspecify.annotations.Nullable;

import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.Mth;
import net.minecraft.util.SimpleBitStorage;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.chunk.PalettedContainerFactory;
import net.minecraft.world.level.chunk.status.ChunkStatus;
import net.minecraft.world.level.chunk.storage.SerializableChunkData;
import net.minecraft.world.level.levelgen.Heightmap;

import io.github.darienrahl.cctv.mixin.ChunkMapAccessor;

/**
 * Terrain beyond the loaded area, read from the world's region files - the
 * server-side counterpart of client mods like Bobby. Chunks are never loaded
 * into the world: the saved NBT is read by the server's IO worker and parsed
 * on a CCTV worker thread, so the server thread only starts the request.
 */
final class SavedChunks {
	private SavedChunks() {
	}

	/** Sections of one saved chunk by section y, plus the lowest surface point (for skipping buried sections). */
	record Parsed(Map<Integer, SectionCapture.Snapshot> sections, int minSurfaceY) {
	}

	/**
	 * Server thread. The future completes on a worker thread with {@code null} when the chunk was never
	 * generated, is not finished (world edge) or cannot be read.
	 */
	static CompletableFuture<@Nullable Parsed> read(ServerLevel level, int cx, int cz, Executor workers) {
		CompletableFuture<Optional<CompoundTag>> io;
		try {
			io = ((ChunkMapAccessor) level.getChunkSource().chunkMap).cctv$readChunk(new ChunkPos(cx, cz));
		} catch (RuntimeException e) {
			return CompletableFuture.completedFuture(null);
		}
		PalettedContainerFactory factory = level.palettedContainerFactory();
		return io.handleAsync((tag, error) -> {
			if (error != null || tag == null || tag.isEmpty()) {
				return null;
			}
			try {
				return parse(level, factory, tag.get(), cx, cz);
			} catch (RuntimeException e) {
				return null;
			}
		}, workers);
	}

	private static @Nullable Parsed parse(ServerLevel level, PalettedContainerFactory factory, CompoundTag tag, int cx, int cz) {
		SerializableChunkData data = SerializableChunkData.parse(level, factory, tag);
		if (data == null || !data.chunkStatus().isOrAfter(ChunkStatus.FULL)) {
			return null;
		}

		boolean hasSkyLight = level.dimensionType().hasSkyLight();
		List<SerializableChunkData.SectionData> list = new ArrayList<>(data.sectionData());
		list.sort(Comparator.comparingInt(SerializableChunkData.SectionData::y).reversed());

		// Sections without stored sky light take it from the section above, column by column (like the light engine).
		byte[] columns = new byte[256];
		java.util.Arrays.fill(columns, (byte) (hasSkyLight ? 15 : 0));

		Map<Integer, SectionCapture.Snapshot> sections = new HashMap<>();
		for (SerializableChunkData.SectionData section : list) {
			byte[] sky = section.skyLight() != null ? section.skyLight().getData() : null;
			if (section.chunkSection() != null) {
				byte[] block = section.blockLight() != null ? section.blockLight().getData() : null;
				sections.put(section.y(), new SectionCapture.Snapshot(cx, section.y(), cz,
						section.chunkSection().hasOnlyAir() ? null : section.chunkSection().getStates(),
						section.chunkSection().getBiomes(),
						sky, sky == null ? columns.clone() : null, (byte) 0, block, (byte) (hasSkyLight ? 15 : 0)));
			}
			if (sky != null) {
				for (int i = 0; i < 256; i++) {
					columns[i] = (byte) ((sky[i >> 1] >> ((i & 1) << 2)) & 15);
				}
			}
		}

		return new Parsed(sections, minSurface(level, data));
	}

	/** Lowest top block (ocean floor) of the chunk, or MIN_VALUE when unknown. */
	private static int minSurface(ServerLevel level, SerializableChunkData data) {
		long[] packed = data.heightmaps().get(Heightmap.Types.OCEAN_FLOOR);
		if (packed == null) {
			return Integer.MIN_VALUE;
		}
		try {
			SimpleBitStorage storage = new SimpleBitStorage(Mth.ceillog2(level.getHeight() + 1), 256, packed);
			int min = Integer.MAX_VALUE;
			for (int i = 0; i < 256; i++) {
				min = Math.min(min, storage.get(i));
			}
			return min + level.getMinY() - 1;
		} catch (RuntimeException e) {
			return Integer.MIN_VALUE;
		}
	}
}
