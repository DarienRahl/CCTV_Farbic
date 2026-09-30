package io.github.darienrahl.cctv.assets;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Path;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

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
	/** Version of the extracted JSON; part of the cache file name so a new mod version re-extracts. */
	static final int FORMAT = 3;

	private static final String ANIMATION_DEFINITIONS = "net/minecraft/client/animation/definitions/";

	private EntityModels() {
	}

	/**
	 * @return {@code {"layers": {"minecraft:horse#main": part}, "animations": {"WardenAnimation.WARDEN_ROAR": animation},
	 *         "renderers": {"minecraft:horse": renderer}}} (see {@link EntityRendererMap})
	 *         where a part is
	 *         {@code {p:[x,y,z], r:[xRot,yRot,zRot], s:[sx,sy,sz]?, q:[x,y,z,u,v x4 per quad...], c:{name: part}}}
	 *         in model pixels (y down, like the client) and an animation is written by {@link AnimationWriter},
	 *         or {@code null} when the models could not be read
	 */
	static @Nullable String extract(Path clientJar, Logger logger) {
		ClassLoader parent = EntityModels.class.getClassLoader();
		try (URLClassLoader loader = new ClientClassLoader(clientJar.toUri().toURL(), parent)) {
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
			json.endObject();
			String animations = animations(clientJar, loader, logger);
			if (animations != null) {
				json.name("animations").raw(animations);
			}
			String renderers;
			try (ZipFile zip = new ZipFile(clientJar.toFile())) {
				renderers = EntityRendererMap.extract(zip, loader, logger);
			}
			if (renderers != null) {
				json.name("renderers").raw(renderers);
			}
			json.endObject();
			logger.info("CCTV: read {} entity models from the client jar", count);
			return json.toString();
		} catch (Throwable e) {
			// Anything can go wrong when running client code on a server (missing natives, changed classes...).
			logger.warn("CCTV: entity models unavailable, mobs are drawn with simplified shapes ({})", e.toString());
			logger.debug("CCTV: entity model extraction failed", e);
			return null;
		}
	}

	/**
	 * Keyframe animations (sniffer, warden, frog, camel...) are static {@code AnimationDefinition} fields of the
	 * classes in {@code net.minecraft.client.animation.definitions}; every one of them is written out, so new
	 * animations of a game version come along without code changes. {@code null} when they cannot be read
	 * (the models are still used, mobs then move with the simple animations).
	 */
	private static @Nullable String animations(Path clientJar, ClassLoader loader, Logger logger) {
		try (ZipFile zip = new ZipFile(clientJar.toFile())) {
			List<String> holders = zip.stream()
					.map(ZipEntry::getName)
					.filter(name -> name.startsWith(ANIMATION_DEFINITIONS) && name.endsWith(".class") && !name.contains("$")
							&& name.indexOf('/', ANIMATION_DEFINITIONS.length()) < 0 && !name.endsWith("package-info.class"))
					.sorted()
					.toList();
			AnimationWriter writer = new AnimationWriter(loader);
			Json json = new Json(1 << 18);
			json.beginObject();
			int count = 0;
			for (String entry : holders) {
				String className = entry.substring(0, entry.length() - ".class".length()).replace('/', '.');
				Class<?> holder = Class.forName(className, true, loader);
				for (Field field : holder.getFields()) {
					if (Modifier.isStatic(field.getModifiers()) && writer.definition.isAssignableFrom(field.getType())) {
						json.name(holder.getSimpleName() + "." + field.getName());
						writer.write(json, field.get(null));
						count++;
					}
				}
			}
			logger.info("CCTV: read {} entity animations from the client jar", count);
			return json.endObject().toString();
		} catch (Throwable e) {
			logger.warn("CCTV: entity keyframe animations unavailable, mobs use simple animations ({})", e.toString());
			logger.debug("CCTV: animation extraction failed", e);
			return null;
		}
	}

	/**
	 * Reflection over AnimationDefinition, AnimationChannel and Keyframe. An animation is
	 * {@code {len: seconds, loop: bool, bones: {name: [{t: "p"|"r"|"s", k: [time, preX, preY, preZ, x, y, z, interpolation, ...]}]}}},
	 * interpolation 0 linear and 1 Catmull-Rom; values as the game stores them (positions with y negated,
	 * rotations in radians, scales minus one).
	 */
	private static final class AnimationWriter {
		final Class<?> definition;
		private final Method length;
		private final Method looping;
		private final Method bones;
		private final Method target;
		private final Method keyframes;
		private final Method timestamp;
		private final Method preTarget;
		private final Method postTarget;
		private final Method interpolation;
		private final Method vx;
		private final Method vy;
		private final Method vz;
		private final Map<Object, String> targets = new IdentityHashMap<>();
		private final Map<Object, Integer> interpolations = new IdentityHashMap<>();

		AnimationWriter(ClassLoader loader) throws ReflectiveOperationException {
			definition = Class.forName("net.minecraft.client.animation.AnimationDefinition", true, loader);
			length = definition.getMethod("lengthInSeconds");
			looping = definition.getMethod("looping");
			bones = definition.getMethod("boneAnimations");
			Class<?> channel = Class.forName("net.minecraft.client.animation.AnimationChannel", true, loader);
			target = channel.getMethod("target");
			keyframes = channel.getMethod("keyframes");
			Class<?> keyframe = Class.forName("net.minecraft.client.animation.Keyframe", true, loader);
			timestamp = keyframe.getMethod("timestamp");
			preTarget = keyframe.getMethod("preTarget");
			postTarget = keyframe.getMethod("postTarget");
			interpolation = keyframe.getMethod("interpolation");
			Class<?> vector = Class.forName("org.joml.Vector3fc", true, loader);
			vx = vector.getMethod("x");
			vy = vector.getMethod("y");
			vz = vector.getMethod("z");
			Class<?> targetConstants = Class.forName("net.minecraft.client.animation.AnimationChannel$Targets", true, loader);
			targets.put(targetConstants.getField("POSITION").get(null), "p");
			targets.put(targetConstants.getField("ROTATION").get(null), "r");
			targets.put(targetConstants.getField("SCALE").get(null), "s");
			Class<?> interpolationConstants = Class.forName("net.minecraft.client.animation.AnimationChannel$Interpolations", true, loader);
			interpolations.put(interpolationConstants.getField("LINEAR").get(null), 0);
			interpolations.put(interpolationConstants.getField("CATMULLROM").get(null), 1);
		}

		void write(Json json, Object animation) throws ReflectiveOperationException {
			json.beginObject()
					.field("len", (float) length.invoke(animation), 4)
					.field("loop", (boolean) looping.invoke(animation))
					.name("bones").beginObject();
			for (Map.Entry<?, ?> bone : ((Map<?, ?>) bones.invoke(animation)).entrySet()) {
				json.name(String.valueOf(bone.getKey()).toLowerCase(Locale.ROOT)).beginArray();
				for (Object channel : (List<?>) bone.getValue()) {
					String kind = targets.get(target.invoke(channel));
					if (kind == null) {
						continue;
					}
					json.beginObject().field("t", kind).name("k").beginArray();
					for (Object frame : (Object[]) keyframes.invoke(channel)) {
						Object pre = preTarget.invoke(frame);
						Object post = postTarget.invoke(frame);
						json.value((float) timestamp.invoke(frame), 4)
								.value((float) vx.invoke(pre), 5).value((float) vy.invoke(pre), 5).value((float) vz.invoke(pre), 5)
								.value((float) vx.invoke(post), 5).value((float) vy.invoke(post), 5).value((float) vz.invoke(post), 5)
								.value(interpolations.getOrDefault(interpolation.invoke(frame), 0));
					}
					json.endArray().endObject();
				}
				json.endArray();
			}
			json.endObject().endObject();
		}
	}

	/**
	 * Loads client-only packages from the client jar itself instead of asking the game's class loader first
	 * (Fabric refuses client classes on a server, and a production server jar does not have them). Everything
	 * else, e.g. blocks, entities and math, comes from the running server, so both sides share those classes.
	 */
	private static final class ClientClassLoader extends URLClassLoader {
		private static final String[] CLIENT_PACKAGES = {"net.minecraft.client.", "com.mojang.blaze3d.", "com.mojang.renderpearl."};

		ClientClassLoader(URL clientJar, ClassLoader parent) {
			super("cctv-client-models", new URL[]{clientJar}, parent);
		}

		@Override
		protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
			for (String prefix : CLIENT_PACKAGES) {
				if (name.startsWith(prefix)) {
					synchronized (getClassLoadingLock(name)) {
						Class<?> loaded = findLoadedClass(name);
						if (loaded == null) {
							loaded = findClass(name);
						}
						if (resolve) {
							resolveClass(loaded);
						}
						return loaded;
					}
				}
			}
			return super.loadClass(name, resolve);
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
