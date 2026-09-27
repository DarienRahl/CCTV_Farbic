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
import net.minecraft.world.level.lighting.LayerLightEventListener;

import io.github.darienrahl.cctv.web.Protocol;

/**
 * Copies one 16x16x16 section out of a loaded chunk: block state ids, sky and
 * block light (for Minecraft-style smooth lighting in the browser) and biomes
 * (for grass/foliage/water tints). Server thread only; no chunk is ever loaded.
 */
final class SectionCapture {
	static final int AIR_ID = Block.getId(Blocks.AIR.defaultBlockState());

	private static final Map<Holder<Biome>, String> BIOME_NAMES = new IdentityHashMap<>();

	int[] states;
	byte[] sky;
	byte[] block;
	String[] biomePalette;
	byte[] biomes;

	private SectionCapture() {
	}

	/** @return {@code null} while the chunk is not loaded */
	static @Nullable SectionCapture capture(ServerLevel level, int sx, int sy, int sz) {
		LevelChunk chunk = level.getChunkSource().getChunkNow(sx, sz);
		if (chunk == null) {
			return null;
		}

		SectionCapture data = new SectionCapture();
		data.states = states(chunk, sy);
		data.captureLight(level, sx, sy, sz);
		data.captureBiomes(chunk, sx, sy, sz);
		return data;
	}

	/** Re-reads only the light, e.g. a few ticks after a torch was placed. */
	boolean refreshLight(ServerLevel level, int sx, int sy, int sz) {
		byte[] oldSky = sky;
		byte[] oldBlock = block;
		captureLight(level, sx, sy, sz);
		return !Arrays.equals(oldSky, sky) || !Arrays.equals(oldBlock, block);
	}

	boolean sameAs(SectionCapture other) {
		return Arrays.equals(states, other.states) && Arrays.equals(sky, other.sky) && Arrays.equals(block, other.block);
	}

	String json(int sx, int sy, int sz) {
		return Protocol.section(sx, sy, sz, states, sky, block, biomePalette, biomes);
	}

	private static int[] states(LevelChunk chunk, int sy) {
		int[] states = new int[Protocol.SECTION_VOLUME];
		if (AIR_ID != 0) {
			Arrays.fill(states, AIR_ID);
		}

		LevelChunkSection[] sections = chunk.getSections();
		int index = chunk.getSectionIndexFromSectionY(sy);
		if (index < 0 || index >= sections.length) {
			return states;
		}

		LevelChunkSection section = sections[index];
		if (section == null || section.hasOnlyAir()) {
			return states;
		}

		BlockState last = null;
		int lastId = AIR_ID;
		int i = 0;
		for (int y = 0; y < 16; y++) {
			for (int z = 0; z < 16; z++) {
				for (int x = 0; x < 16; x++) {
					BlockState state = section.getBlockState(x, y, z);
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

	private void captureLight(ServerLevel level, int sx, int sy, int sz) {
		SectionPos pos = SectionPos.of(sx, sy, sz);
		sky = light(level.getLightEngine().getLayerListener(LightLayer.SKY), pos, true);
		block = light(level.getLightEngine().getLayerListener(LightLayer.BLOCK), pos, false);
	}

	private static byte[] light(LayerLightEventListener listener, SectionPos pos, boolean sky) {
		byte[] light = new byte[Protocol.SECTION_VOLUME];
		DataLayer layer = listener.getDataLayerData(pos);

		if (layer != null) {
			byte[] packed = layer.getData();
			for (int i = 0; i < Protocol.SECTION_VOLUME; i++) {
				light[i] = (byte) ((packed[i >> 1] >> ((i & 1) << 2)) & 15);
			}
		} else if (sky) {
			// No stored data: sky light is the same for the whole column of this section, ask the engine once per column.
			BlockPos.MutableBlockPos mutable = new BlockPos.MutableBlockPos();
			int top = pos.maxBlockY();
			for (int z = 0; z < 16; z++) {
				for (int x = 0; x < 16; x++) {
					byte value = (byte) listener.getLightValue(mutable.set(pos.minBlockX() + x, top, pos.minBlockZ() + z));
					for (int y = 0; y < 16; y++) {
						light[(y << 8) | (z << 4) | x] = value;
					}
				}
			}
		}
		return light;
	}

	private void captureBiomes(LevelChunk chunk, int sx, int sy, int sz) {
		String[] palette = new String[4];
		int size = 0;
		byte[] indices = new byte[64];
		int i = 0;
		for (int y = 0; y < 4; y++) {
			for (int z = 0; z < 4; z++) {
				for (int x = 0; x < 4; x++) {
					String name = biomeName(chunk.getNoiseBiome(sx * 4 + x, sy * 4 + y, sz * 4 + z));
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
		return BIOME_NAMES.computeIfAbsent(biome, holder -> holder.unwrapKey()
				.map(key -> key.identifier().toString())
				.orElse("minecraft:plains"));
	}
}
