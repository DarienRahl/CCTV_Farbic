package io.github.darienrahl.cctv.camera;

import org.jspecify.annotations.Nullable;

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.Mth;
import net.minecraft.world.level.biome.Biome;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.levelgen.Heightmap;

import io.github.darienrahl.cctv.web.Json;

/**
 * Rain and snow columns around the camera, like the client's
 * WeatherEffectRenderer: where precipitation stops (motion blocking height map)
 * and whether it is rain or snow there (biome temperature at the camera height).
 */
final class WeatherSampler {
	static final int INTERVAL_TICKS = 20;
	/** The client's default weather radius. */
	static final int RADIUS = 10;

	private WeatherSampler() {
	}

	/** @return {@code null} while it does not rain */
	static @Nullable String json(ServerLevel level, Camera camera) {
		if (level.getRainLevel(1.0F) <= 0.0F) {
			return null;
		}

		int cx = Mth.floor(camera.x());
		int cy = Mth.floor(camera.y());
		int cz = Mth.floor(camera.z());
		int size = RADIUS * 2 + 1;
		int seaLevel = level.getSeaLevel();
		BlockPos.MutableBlockPos pos = new BlockPos.MutableBlockPos();

		Json json = new Json(size * size * 6 + 64);
		json.beginObject().field("x", cx - RADIUS).field("z", cz - RADIUS).field("size", size).field("minY", level.getMinY())
				.name("h").beginArray();
		StringBuilder types = new StringBuilder(size * size);
		for (int z = cz - RADIUS; z <= cz + RADIUS; z++) {
			for (int x = cx - RADIUS; x <= cx + RADIUS; x++) {
				LevelChunk chunk = level.getChunkSource().getChunkNow(x >> 4, z >> 4);
				if (chunk == null) {
					json.value(level.getMinY());
					types.append('n');
					continue;
				}
				json.value(chunk.getHeight(Heightmap.Types.MOTION_BLOCKING, x & 15, z & 15) + 1);
				Biome.Precipitation precipitation = level.getBiome(pos.set(x, cy, z)).value().getPrecipitationAt(pos, seaLevel);
				types.append(switch (precipitation) {
					case RAIN -> 'r';
					case SNOW -> 's';
					default -> 'n';
				});
			}
		}
		json.endArray().field("p", types.toString());
		return json.endObject().toString();
	}
}
