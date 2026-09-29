package io.github.darienrahl.cctv.camera;

import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;

import org.jspecify.annotations.Nullable;

import net.minecraft.world.level.material.MapColor;
import net.minecraft.world.level.saveddata.maps.MapItemSavedData;

/**
 * The pictures of the maps in item frames, for {@code GET /map/{id}}: a copy of each map's colours
 * (MapItemSavedData: 128 x 128 packed MapColor ids) taken on the server thread when a camera sees the
 * frame, and turned into pixels like MapTextureManager does. A map is looked at again every 10 ticks at
 * most, as often as ServerEntity sends framed maps to the players.
 */
public final class MapPictures {
	/** MapRenderer.WIDTH and HEIGHT. */
	public static final int SIZE = 128;
	private static final int MAX_MAPS = 256;
	private static final int REFRESH_TICKS = 10;

	private record Picture(byte[] colors, int version, long tick) {
	}

	private static final Map<Integer, Picture> PICTURES = new LinkedHashMap<>(16, 0.75F, true) {
		@Override
		protected boolean removeEldestEntry(Map.Entry<Integer, Picture> eldest) {
			return size() > MAX_MAPS;
		}
	};

	private MapPictures() {
	}

	/** Server thread: the version of the map's picture, which changes when its colours do. */
	static int version(int id, MapItemSavedData data, long tick) {
		synchronized (PICTURES) {
			Picture picture = PICTURES.get(id);
			if (picture != null && tick >= picture.tick() && tick - picture.tick() < REFRESH_TICKS) {
				return picture.version();
			}
			byte[] colors = data.colors;
			int version = Arrays.hashCode(colors);
			byte[] copy = picture != null && picture.version() == version ? picture.colors() : colors.clone();
			PICTURES.put(id, new Picture(copy, version, tick));
			return version;
		}
	}

	/** Any thread: the map's picture as 128 x 128 RGBA bytes, null when no camera has seen it. */
	public static byte @Nullable [] rgba(int id) {
		Picture picture;
		synchronized (PICTURES) {
			picture = PICTURES.get(id);
		}
		if (picture == null) {
			return null;
		}
		byte[] colors = picture.colors();
		byte[] out = new byte[SIZE * SIZE * 4];
		for (int i = 0; i < SIZE * SIZE && i < colors.length; i++) {
			int argb = MapColor.getColorFromPackedId(colors[i]);
			out[i * 4] = (byte) (argb >> 16);
			out[i * 4 + 1] = (byte) (argb >> 8);
			out[i * 4 + 2] = (byte) argb;
			out[i * 4 + 3] = (byte) (argb >>> 24);
		}
		return out;
	}
}
