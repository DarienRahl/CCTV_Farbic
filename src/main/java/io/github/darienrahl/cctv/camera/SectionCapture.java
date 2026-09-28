package io.github.darienrahl.cctv.camera;

import java.util.Arrays;
import java.util.IdentityHashMap;
import java.util.Map;

import org.jspecify.annotations.Nullable;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Holder;
import net.minecraft.core.SectionPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.LightLayer;
import net.minecraft.world.level.biome.Biome;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.DataLayer;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.LevelChunkSection;
import net.minecraft.world.level.chunk.PalettedContainer;
import net.minecraft.world.level.chunk.PalettedContainerRO;
import net.minecraft.world.level.lighting.LayerLightEventListener;

import io.github.darienrahl.cctv.web.Protocol;

/**
 * One 16x16x16 section as the browser needs it: block state ids, sky and block
 * light (for Minecraft's smooth lighting) and biomes (for grass, leaf and water
 * tints).
 *
 * <p>Reading happens in two steps so the server thread does as little as
 * possible: {@link #snapshot} (server thread) only copies the section's
 * palette containers and light arrays, {@link Snapshot#decode()} (any thread)
 * turns the copies into arrays and JSON.
 */
final class SectionCapture {
	static final int AIR_ID = Block.getId(Blocks.AIR.defaultBlockState());
	private static final int VOLUME = Protocol.SECTION_VOLUME;

	private static final Map<Holder<Biome>, String> BIOME_NAMES = new IdentityHashMap<>();

	int[] states;
	byte[] sky;
	byte[] block;
	String[] biomePalette;
	byte[] biomes;
	/** Sorted distinct block state ids, for the palette sent before the section. */
	int[] distinct;
	@Nullable String json;
	/** Block entity details for the viewer (JSON array, e.g. sign text), or {@code null}. */
	@Nullable String blockEntities;
	/** Only air with the dimension's default light: the viewer assumes this for sections it never receives. */
	boolean trivial;
	private byte defaultSky;

	private SectionCapture() {
	}

	/** Private copies of a section's data, taken on the server thread (or parsed from disk). */
	record Snapshot(int sx, int sy, int sz,
			@Nullable PalettedContainer<BlockState> states,
			@Nullable PalettedContainerRO<Holder<Biome>> biomes,
			byte @Nullable [] skyPacked, byte @Nullable [] skyColumns, byte skyFill,
			byte @Nullable [] blockPacked, byte defaultSky, @Nullable String blockEntities) {

		Snapshot(int sx, int sy, int sz, @Nullable PalettedContainer<BlockState> states, @Nullable PalettedContainerRO<Holder<Biome>> biomes,
				byte @Nullable [] skyPacked, byte @Nullable [] skyColumns, byte skyFill, byte @Nullable [] blockPacked, byte defaultSky) {
			this(sx, sy, sz, states, biomes, skyPacked, skyColumns, skyFill, blockPacked, defaultSky, null);
		}

		/** Heavy part: runs on a worker thread. */
		SectionCapture decode() {
			SectionCapture data = new SectionCapture();
			data.states = decodeStates(states);
			data.sky = unpack(skyPacked, skyColumns, skyFill);
			data.block = unpack(blockPacked, null, (byte) 0);
			data.decodeBiomes(biomes);
			data.distinct = Arrays.stream(data.states).distinct().sorted().toArray();
			data.defaultSky = defaultSky;
			data.blockEntities = blockEntities;
			data.updateTrivial();
			if (!data.trivial) {
				data.json = Protocol.section(sx, sy, sz, data.states, data.sky, data.block, data.biomePalette, data.biomes, blockEntities);
			}
			return data;
		}
	}

	/**
	 * Server thread: copies a loaded section.
	 *
	 * @return {@code null} while the chunk is not loaded
	 */
	static @Nullable Snapshot snapshot(ServerLevel level, int sx, int sy, int sz) {
		LevelChunk chunk = level.getChunkSource().getChunkNow(sx, sz);
		if (chunk == null) {
			return null;
		}

		PalettedContainer<BlockState> states = null;
		PalettedContainerRO<Holder<Biome>> biomes = null;
		LevelChunkSection[] sections = chunk.getSections();
		int index = chunk.getSectionIndexFromSectionY(sy);
		if (index >= 0 && index < sections.length && sections[index] != null) {
			LevelChunkSection section = sections[index];
			if (!section.hasOnlyAir()) {
				states = section.getStates().copy();
			}
			biomes = copyBiomes(section.getBiomes());
		}

		SectionPos pos = SectionPos.of(sx, sy, sz);
		LayerLightEventListener skyListener = level.getLightEngine().getLayerListener(LightLayer.SKY);
		DataLayer sky = skyListener.getDataLayerData(pos);
		byte[] skyColumns = null;
		if (sky == null && level.dimensionType().hasSkyLight()) {
			// No stored data: the whole section has the light of the section above, per column.
			skyColumns = new byte[256];
			BlockPos.MutableBlockPos mutable = new BlockPos.MutableBlockPos();
			for (int z = 0; z < 16; z++) {
				for (int x = 0; x < 16; x++) {
					skyColumns[(z << 4) | x] = (byte) skyListener.getLightValue(mutable.set(pos.minBlockX() + x, pos.maxBlockY(), pos.minBlockZ() + z));
				}
			}
		}
		DataLayer block = level.getLightEngine().getLayerListener(LightLayer.BLOCK).getDataLayerData(pos);
		return new Snapshot(sx, sy, sz, states, biomes, packed(sky), skyColumns, (byte) 0, packed(block), defaultSky(level),
				BlockEntityEncoder.section(chunk, sy));
	}

	/** Sky light the viewer assumes where it has no data: full daylight in dimensions with a sky, darkness otherwise. */
	static byte defaultSky(ServerLevel level) {
		return (byte) (level.dimensionType().hasSkyLight() ? 15 : 0);
	}

	private void updateTrivial() {
		trivial = blockEntities == null && distinct.length == 1 && distinct[0] == AIR_ID && uniform(block, (byte) 0) && uniform(sky, defaultSky);
	}

	private static boolean uniform(byte[] values, byte value) {
		for (byte v : values) {
			if (v != value) {
				return false;
			}
		}
		return true;
	}

	/** Server thread: re-reads only the light, returns true when it changed. */
	boolean refreshLight(ServerLevel level, int sx, int sy, int sz) {
		Snapshot snapshot = snapshot(level, sx, sy, sz);
		if (snapshot == null) {
			return false;
		}
		byte[] newSky = unpack(snapshot.skyPacked(), snapshot.skyColumns(), snapshot.skyFill());
		byte[] newBlock = unpack(snapshot.blockPacked(), null, (byte) 0);
		if (Arrays.equals(newSky, sky) && Arrays.equals(newBlock, block)) {
			return false;
		}
		sky = newSky;
		block = newBlock;
		json = null;
		updateTrivial();
		return true;
	}

	boolean sameAs(SectionCapture other) {
		return Arrays.equals(states, other.states) && Arrays.equals(sky, other.sky) && Arrays.equals(block, other.block)
				&& Arrays.equals(biomes, other.biomes) && Arrays.equals(biomePalette, other.biomePalette)
				&& java.util.Objects.equals(blockEntities, other.blockEntities);
	}

	/** A block changed (server thread). {@link #distinct} may keep ids that are gone, which is harmless. */
	void set(int index, int id) {
		if (states[index] == id) {
			return;
		}
		states[index] = id;
		int at = Arrays.binarySearch(distinct, id);
		if (at < 0) {
			int insert = -at - 1;
			int[] grown = new int[distinct.length + 1];
			System.arraycopy(distinct, 0, grown, 0, insert);
			grown[insert] = id;
			System.arraycopy(distinct, insert, grown, insert + 1, distinct.length - insert);
			distinct = grown;
		}
		json = null;
		if (id != AIR_ID) {
			trivial = false;
		}
	}

	String json(int sx, int sy, int sz) {
		if (json == null) {
			json = Protocol.section(sx, sy, sz, states, sky, block, biomePalette, biomes, blockEntities);
		}
		return json;
	}

	private static byte @Nullable [] packed(@Nullable DataLayer layer) {
		return layer == null ? null : layer.getData().clone();
	}

	@SuppressWarnings("unchecked")
	private static PalettedContainerRO<Holder<Biome>> copyBiomes(PalettedContainerRO<Holder<Biome>> biomes) {
		// In practice always a PalettedContainer; copy it so a worker thread can read it safely.
		return biomes instanceof PalettedContainer<?> container ? (PalettedContainer<Holder<Biome>>) container.copy() : biomes;
	}

	private static int[] decodeStates(@Nullable PalettedContainer<BlockState> container) {
		int[] states = new int[VOLUME];
		if (container == null) {
			if (AIR_ID != 0) {
				Arrays.fill(states, AIR_ID);
			}
			return states;
		}
		BlockState last = null;
		int lastId = AIR_ID;
		int i = 0;
		for (int y = 0; y < 16; y++) {
			for (int z = 0; z < 16; z++) {
				for (int x = 0; x < 16; x++) {
					BlockState state = container.get(x, y, z);
					if (state != last) {
						last = state;
						lastId = Block.getId(state);
					}
					states[i++] = lastId;
				}
			}
		}
		return states;
	}

	/** Nibble array (DataLayer layout, YZX order) to one byte per block. */
	private static byte[] unpack(byte @Nullable [] packed, byte @Nullable [] columns, byte fill) {
		byte[] light = new byte[VOLUME];
		if (packed != null) {
			for (int i = 0; i < VOLUME; i++) {
				light[i] = (byte) ((packed[i >> 1] >> ((i & 1) << 2)) & 15);
			}
		} else if (columns != null) {
			for (int y = 0; y < 16; y++) {
				System.arraycopy(columns, 0, light, y << 8, 256);
			}
		} else if (fill != 0) {
			Arrays.fill(light, fill);
		}
		return light;
	}

	private void decodeBiomes(@Nullable PalettedContainerRO<Holder<Biome>> container) {
		if (container == null) {
			biomePalette = new String[]{"minecraft:plains"};
			biomes = new byte[64];
			return;
		}
		String[] palette = new String[4];
		int size = 0;
		byte[] indices = new byte[64];
		int i = 0;
		for (int y = 0; y < 4; y++) {
			for (int z = 0; z < 4; z++) {
				for (int x = 0; x < 4; x++) {
					String name = biomeName(container.get(x, y, z));
					int index = -1;
					for (int p = 0; p < size; p++) {
						if (palette[p].equals(name)) {
							index = p;
							break;
						}
					}
					if (index < 0) {
						if (size == palette.length) {
							palette = Arrays.copyOf(palette, size * 2);
						}
						palette[size] = name;
						index = size++;
					}
					indices[i++] = (byte) index;
				}
			}
		}
		biomePalette = Arrays.copyOf(palette, size);
		biomes = indices;
	}

	private static String biomeName(Holder<Biome> biome) {
		synchronized (BIOME_NAMES) {
			return BIOME_NAMES.computeIfAbsent(biome, holder -> holder.unwrapKey()
					.map(key -> key.identifier().toString())
					.orElse("minecraft:plains"));
		}
	}
}
