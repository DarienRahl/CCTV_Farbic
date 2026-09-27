package io.github.darienrahl.cctv.assets;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Path;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;

import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;

import io.github.darienrahl.cctv.web.Json;

/**
 * Entity models (mobs, chests, boats...) exactly as the client builds them.
 *
 * <p>The geometry of every entity model lives in client code
 * ({@code LayerDefinitions.createRoots()}), not in resource files. The client
 * jar is already downloaded for textures, so its model classes are loaded in a
 * separate class loader (common classes still come from the server) and the
 * baked cubes of every model layer are written out as JSON for the viewer.
 * Nothing from the client is kept loaded afterwards.
 */
final class EntityModels {
	private EntityModels() {
	}

	/**
	 * @return {@code {"layers": {"minecraft:horse#main": part}}} where a part is
	 *         {@code {p:[x,y,z], r:[xRot,yRot,zRot], s:[sx,sy,sz]?, q:[x,y,z,u,v x4 per quad...], c:{name: part}}}
	 *         in model pixels (y down, like the client), or {@code null} when the models could not be read
	 */
	static @Nullable String extract(Path clientJar, Logger logger) {
		ClassLoader parent = EntityModels.class.getClassLoader();
		try (URLClassLoader loader = new URLClassLoader("cctv-client-models", new URL[]{clientJar.toUri().toURL()}, parent)) {
			Class<?> definitions = Class.forName("net.minecraft.client.model.geom.LayerDefinitions", true, loader);
			Map<?, ?> roots = (Map<?, ?>) definitions.getMethod("createRoots").invoke(null);

			Class<?> layerDefinition = Class.forName("net.minecraft.client.model.geom.builders.LayerDefinition", false, loader);
			Method bakeRoot = layerDefinition.getMethod("bakeRoot");
			Class<?> locationClass = Class.forName("net.minecraft.client.model.geom.ModelLayerLocation", false, loader);
			Method model = locationClass.getMethod("model");
			Method layer = locationClass.getMethod("layer");
			PartWriter writer = new PartWriter(loader);

			Map<String, Object> sorted = new TreeMap<>();
			for (Map.Entry<?, ?> entry : roots.entrySet()) {
				String key = model.invoke(entry.getKey()) + "#" + layer.invoke(entry.getKey());
				sorted.put(key, entry.getValue());
			}

			Json json = new Json(1 << 20);
			json.beginObject().name("layers").beginObject();
			int count = 0;
			for (Map.Entry<String, Object> entry : sorted.entrySet()) {
				Object root;
				try {
					root = bakeRoot.invoke(entry.getValue());
				} catch (ReflectiveOperationException | RuntimeException e) {
					logger.debug("CCTV: could not bake entity model {}", entry.getKey(), e);
					continue;
				}
				json.name(entry.getKey());
				writer.write(json, root);
				count++;
			}
			json.endObject().endObject();
			logger.info("CCTV: read {} entity models from the client jar", count);
			return json.toString();
		} catch (Throwable e) {
			// Anything can go wrong when running client code on a server (missing natives, changed classes...).
			logger.warn("CCTV: entity models unavailable, mobs are drawn with simplified shapes ({})", e.toString());
			logger.debug("CCTV: entity model extraction failed", e);
			return null;
		}
	}

	/** Reflection over ModelPart, ModelPart.Cube, ModelPart.Polygon and ModelPart.Vertex. */
	private static final class PartWriter {
		private final Field x;
		private final Field y;
		private final Field z;
		private final Field xRot;
		private final Field yRot;
		private final Field zRot;
		private final Field xScale;
		private final Field yScale;
		private final Field zScale;
		private final Field cubes;
		private final Field children;
		private final Field polygons;
		private final Method vertices;
		private final Method vx;
		private final Method vy;
		private final Method vz;
		private final Method vu;
		private final Method vv;

		PartWriter(ClassLoader loader) throws ReflectiveOperationException {
			Class<?> part = Class.forName("net.minecraft.client.model.geom.ModelPart", false, loader);
			x = part.getField("x");
			y = part.getField("y");
			z = part.getField("z");
			xRot = part.getField("xRot");
			yRot = part.getField("yRot");
			zRot = part.getField("zRot");
			xScale = part.getField("xScale");
			yScale = part.getField("yScale");
			zScale = part.getField("zScale");
			cubes = part.getDeclaredField("cubes");
			cubes.setAccessible(true);
			children = part.getDeclaredField("children");
			children.setAccessible(true);

			Class<?> cube = Class.forName("net.minecraft.client.model.geom.ModelPart$Cube", false, loader);
			polygons = cube.getField("polygons");
			Class<?> polygon = Class.forName("net.minecraft.client.model.geom.ModelPart$Polygon", false, loader);
			vertices = polygon.getMethod("vertices");
			Class<?> vertex = Class.forName("net.minecraft.client.model.geom.ModelPart$Vertex", false, loader);
			vx = vertex.getMethod("x");
			vy = vertex.getMethod("y");
			vz = vertex.getMethod("z");
			vu = vertex.getMethod("u");
			vv = vertex.getMethod("v");
		}

		void write(Json json, Object part) throws ReflectiveOperationException {
			json.beginObject();
			json.name("p").beginArray().value(x.getFloat(part), 3).value(y.getFloat(part), 3).value(z.getFloat(part), 3).endArray();
			float rx = xRot.getFloat(part);
			float ry = yRot.getFloat(part);
			float rz = zRot.getFloat(part);
			if (rx != 0 || ry != 0 || rz != 0) {
				json.name("r").beginArray().value(rx, 5).value(ry, 5).value(rz, 5).endArray();
			}
			float sx = xScale.getFloat(part);
			float sy = yScale.getFloat(part);
			float sz = zScale.getFloat(part);
			if (sx != 1 || sy != 1 || sz != 1) {
				json.name("s").beginArray().value(sx, 4).value(sy, 4).value(sz, 4).endArray();
			}

			List<?> cubeList = (List<?>) cubes.get(part);
			if (!cubeList.isEmpty()) {
				json.name("q").beginArray();
				for (Object cube : cubeList) {
					for (Object polygon : (Object[]) polygons.get(cube)) {
						Object[] verts = (Object[]) vertices.invoke(polygon);
						if (verts.length != 4) {
							continue;
						}
						for (Object vertex : verts) {
							json.value((float) vx.invoke(vertex), 3)
									.value((float) vy.invoke(vertex), 3)
									.value((float) vz.invoke(vertex), 3)
									.value((float) vu.invoke(vertex), 5)
									.value((float) vv.invoke(vertex), 5);
						}
					}
				}
				json.endArray();
			}

			Map<?, ?> childMap = (Map<?, ?>) children.get(part);
			if (!childMap.isEmpty()) {
				json.name("c").beginObject();
				for (Map.Entry<?, ?> child : childMap.entrySet()) {
					json.name(String.valueOf(child.getKey()).toLowerCase(Locale.ROOT));
					write(json, child.getValue());
				}
				json.endObject();
			}
			json.endObject();
		}
	}
}
