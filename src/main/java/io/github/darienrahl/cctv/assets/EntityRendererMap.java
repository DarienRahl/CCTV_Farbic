package io.github.darienrahl.cctv.assets;

import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

import org.jspecify.annotations.Nullable;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.Handle;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;
import org.slf4j.Logger;

import io.github.darienrahl.cctv.web.Json;

/**
 * Which model layers and textures each entity type is drawn with, read from the client's bytecode: the
 * registrations in {@code EntityRenderers} ({@code register(EntityTypes.FOX, FoxRenderer::new)}) and the
 * {@code ModelLayers} fields, {@code textures/entity/...} names and shadow radius each renderer (its nested
 * classes, or the lambda that creates it) uses. The viewer's own table of mobs overrides this; it is what lets a
 * mob of a newer game version appear with its real model and texture before the viewer knows it.
 */
final class EntityRendererMap {
	private static final String RENDERERS = "net/minecraft/client/renderer/entity/EntityRenderers";
	private static final String ENTITY_TYPE = "Lnet/minecraft/world/entity/EntityType;";
	private static final String MODEL_LAYERS = "net/minecraft/client/model/geom/ModelLayers";
	private static final String TEXTURE_PREFIX = "textures/entity/";
	private static final int API = Opcodes.ASM9;

	private EntityRendererMap() {
	}

	/** What one method (or one enum constant's part of a static initializer) refers to, in order. */
	private static final class Refs {
		final Set<String> layers = new LinkedHashSet<>();
		final Set<String> textures = new LinkedHashSet<>();
		final List<String> created = new ArrayList<>();
		final List<String[]> constants = new ArrayList<>();
		@Nullable Float shadow;

		void add(Refs other) {
			layers.addAll(other.layers);
			textures.addAll(other.textures);
			if (shadow == null) {
				shadow = other.shadow;
			}
		}
	}

	/** @return {@code {"minecraft:fox": {"r": "FoxRenderer", "l": [layer ids], "t": [textures], "s": radius}}} */
	static @Nullable String extract(ZipFile zip, ClassLoader loader, Logger logger) {
		try {
			Map<String, Handle> registrations = registrations(zip);
			if (registrations.isEmpty()) {
				return null;
			}
			Map<String, String> layerIds = layerIds(loader);
			Map<String, Refs> classCache = new LinkedHashMap<>();
			Map<String, Map<String, Refs>> enumCache = new LinkedHashMap<>();
			Map<String, Refs> lambdas = methods(zip, RENDERERS);
			Map<String, Object> out = new TreeMap<>();
			for (Map.Entry<String, Handle> entry : registrations.entrySet()) {
				Handle handle = entry.getValue();
				Refs refs = new Refs();
				@Nullable String renderer;
				if (handle.getTag() == Opcodes.H_NEWINVOKESPECIAL) {
					renderer = handle.getOwner();
				} else if (handle.getOwner().equals(RENDERERS) && lambdas.containsKey(handle.getName())) {
					// context -> new DonkeyRenderer(context, DonkeyRenderer.Type.MULE): the lambda's own
					// references first, then the enum constants it passes along
					Refs lambda = lambdas.get(handle.getName());
					renderer = lambda.created.isEmpty() ? null : lambda.created.get(0);
					refs.add(lambda);
					for (String[] constant : lambda.constants) {
						Refs part = enumConstants(zip, constant[0], enumCache).get(constant[1]);
						if (part != null) {
							refs.add(part);
						}
					}
				} else {
					continue;
				}
				if (renderer == null) {
					continue;
				}
				// the shadow radius the renderer passes to its superclass (a lambda's float is often a scale)
				refs.shadow = null;
				refs.add(rendererRefs(zip, renderer, classCache));
				List<String> layers = new ArrayList<>();
				for (String field : refs.layers) {
					String id = layerIds.get(field);
					if (id != null) {
						layers.add(id);
					}
				}
				Map<String, Object> info = new LinkedHashMap<>();
				info.put("r", renderer.substring(renderer.lastIndexOf('/') + 1));
				info.put("l", layers);
				info.put("t", new ArrayList<>(refs.textures));
				if (refs.shadow != null) {
					info.put("s", refs.shadow);
				}
				out.put("minecraft:" + entry.getKey().toLowerCase(Locale.ROOT), info);
			}
			Json json = new Json(1 << 16);
			writeValue(json, out);
			logger.info("CCTV: read the renderers of {} entity types from the client jar", out.size());
			return json.toString();
		} catch (Throwable e) {
			logger.warn("CCTV: entity renderer map unavailable, new mobs are matched by their names ({})", e.toString());
			logger.debug("CCTV: entity renderer map failed", e);
			return null;
		}
	}

	/** EntityRenderers' static initializer: entity type field name -> the renderer factory it registers. */
	private static Map<String, Handle> registrations(ZipFile zip) throws IOException {
		Map<String, Handle> found = new LinkedHashMap<>();
		byte[] bytes = read(zip, RENDERERS);
		if (bytes == null) {
			return found;
		}
		new ClassReader(bytes).accept(new ClassVisitor(API) {
			@Override
			public MethodVisitor visitMethod(int access, String name, String descriptor, String signature, String[] exceptions) {
				if (!name.equals("<clinit>")) {
					return null;
				}
				return new MethodVisitor(API) {
					private @Nullable String type;
					private @Nullable Handle factory;

					@Override
					public void visitFieldInsn(int opcode, String owner, String field, String desc) {
						if (opcode == Opcodes.GETSTATIC && desc.equals(ENTITY_TYPE)) {
							type = field;
							factory = null;
						}
					}

					@Override
					public void visitInvokeDynamicInsn(String name, String desc, Handle bootstrap, Object... arguments) {
						for (Object argument : arguments) {
							if (argument instanceof Handle handle) {
								factory = handle;
							}
						}
					}

					@Override
					public void visitMethodInsn(int opcode, String owner, String method, String desc, boolean isInterface) {
						if (opcode == Opcodes.INVOKESTATIC && owner.equals(RENDERERS) && method.equals("register")
								&& type != null && factory != null) {
							found.put(type, factory);
							type = null;
							factory = null;
						}
					}
				};
			}
		}, ClassReader.SKIP_DEBUG | ClassReader.SKIP_FRAMES);
		return found;
	}

	/** The references of a renderer class and of its nested classes (texture and model tables, enums). */
	private static Refs rendererRefs(ZipFile zip, String renderer, Map<String, Refs> cache) throws IOException {
		Refs cached = cache.get(renderer);
		if (cached != null) {
			return cached;
		}
		Refs refs = new Refs();
		Map<String, Refs> methods = methods(zip, renderer);
		// the constructor first: its layers and shadow radius are the renderer's main ones
		Refs constructor = methods.get("<init>");
		if (constructor != null) {
			refs.add(constructor);
		}
		for (Refs method : methods.values()) {
			refs.add(method);
		}
		String prefix = renderer + "$";
		List<String> nested = zip.stream().map(ZipEntry::getName)
				.filter(name -> name.startsWith(prefix) && name.endsWith(".class"))
				.sorted().toList();
		for (String name : nested) {
			for (Refs method : methods(zip, name.substring(0, name.length() - ".class".length())).values()) {
				refs.add(method);
			}
		}
		cache.put(renderer, refs);
		return refs;
	}

	/** An enum's static initializer split by the constant each part creates: constant name -> its references. */
	private static Map<String, Refs> enumConstants(ZipFile zip, String owner, Map<String, Map<String, Refs>> cache) throws IOException {
		Map<String, Refs> cached = cache.get(owner);
		if (cached != null) {
			return cached;
		}
		Map<String, Refs> parts = new LinkedHashMap<>();
		byte[] bytes = read(zip, owner);
		if (bytes != null) {
			String self = "L" + owner + ";";
			new ClassReader(bytes).accept(new ClassVisitor(API) {
				@Override
				public MethodVisitor visitMethod(int access, String name, String descriptor, String signature, String[] exceptions) {
					if (!name.equals("<clinit>")) {
						return null;
					}
					return new RefCollector(new Refs()) {
						@Override
						public void visitFieldInsn(int opcode, String fieldOwner, String field, String desc) {
							if (opcode == Opcodes.PUTSTATIC && fieldOwner.equals(owner) && desc.equals(self)) {
								parts.put(field, refs);
								refs = new Refs();
							} else {
								super.visitFieldInsn(opcode, fieldOwner, field, desc);
							}
						}
					};
				}
			}, ClassReader.SKIP_DEBUG | ClassReader.SKIP_FRAMES);
		}
		cache.put(owner, parts);
		return parts;
	}

	/** Every method of a class: name -> its references (the first method of a name when overloaded). */
	private static Map<String, Refs> methods(ZipFile zip, String owner) throws IOException {
		Map<String, Refs> found = new LinkedHashMap<>();
		byte[] bytes = read(zip, owner);
		if (bytes == null) {
			return found;
		}
		new ClassReader(bytes).accept(new ClassVisitor(API) {
			@Override
			public MethodVisitor visitMethod(int access, String name, String descriptor, String signature, String[] exceptions) {
				Refs refs = new Refs();
				found.putIfAbsent(name, refs);
				return new RefCollector(refs);
			}
		}, ClassReader.SKIP_DEBUG | ClassReader.SKIP_FRAMES);
		return found;
	}

	/** Collects model layers, entity textures, created classes, enum constants and the shadow radius. */
	private static class RefCollector extends MethodVisitor {
		Refs refs;
		private @Nullable Float lastFloat;

		RefCollector(Refs refs) {
			super(API);
			this.refs = refs;
		}

		@Override
		public void visitFieldInsn(int opcode, String owner, String field, String desc) {
			if (opcode != Opcodes.GETSTATIC) {
				return;
			}
			if (owner.equals(MODEL_LAYERS)) {
				refs.layers.add(field);
			} else if (desc.equals("L" + owner + ";") && owner.contains("$")) {
				// a constant of a nested enum (DonkeyRenderer.Type.MULE)
				refs.constants.add(new String[]{owner, field});
			}
		}

		@Override
		public void visitLdcInsn(Object value) {
			if (value instanceof String text && text.startsWith(TEXTURE_PREFIX) && text.endsWith(".png")) {
				refs.textures.add(text.substring(TEXTURE_PREFIX.length(), text.length() - ".png".length()));
			} else if (value instanceof Float number) {
				lastFloat = number;
			}
		}

		@Override
		public void visitInsn(int opcode) {
			if (opcode >= Opcodes.FCONST_0 && opcode <= Opcodes.FCONST_2) {
				lastFloat = (float) (opcode - Opcodes.FCONST_0);
			}
		}

		@Override
		public void visitTypeInsn(int opcode, String type) {
			if (opcode == Opcodes.NEW && type.startsWith("net/minecraft/client/renderer/entity/")) {
				refs.created.add(type);
			}
		}

		@Override
		public void visitMethodInsn(int opcode, String owner, String method, String desc, boolean isInterface) {
			// the float argument of super(context, model, shadowRadius) or new XRenderer(context, shadowRadius)
			if (opcode == Opcodes.INVOKESPECIAL && method.equals("<init>") && lastFloat != null && desc.contains("F)V")
					&& refs.shadow == null) {
				refs.shadow = lastFloat;
			}
		}
	}

	/** ModelLayers field name -> "namespace:path#layer", read from the loaded client class. */
	private static Map<String, String> layerIds(ClassLoader loader) throws ReflectiveOperationException {
		Class<?> layers = Class.forName(MODEL_LAYERS.replace('/', '.'), true, loader);
		Class<?> location = Class.forName("net.minecraft.client.model.geom.ModelLayerLocation", false, loader);
		Method model = location.getMethod("model");
		Method layer = location.getMethod("layer");
		Map<String, String> ids = new LinkedHashMap<>();
		for (java.lang.reflect.Field field : layers.getFields()) {
			if (location.isAssignableFrom(field.getType())) {
				Object value = field.get(null);
				if (value != null) {
					ids.put(field.getName(), model.invoke(value) + "#" + layer.invoke(value));
				}
			}
		}
		return ids;
	}

	private static byte @Nullable [] read(ZipFile zip, String className) throws IOException {
		ZipEntry entry = zip.getEntry(className + ".class");
		if (entry == null) {
			return null;
		}
		try (InputStream in = zip.getInputStream(entry)) {
			return in.readAllBytes();
		}
	}

	private static void writeValue(Json json, Object value) {
		if (value instanceof Map<?, ?> map) {
			json.beginObject();
			for (Map.Entry<?, ?> entry : map.entrySet()) {
				json.name(String.valueOf(entry.getKey()));
				writeValue(json, entry.getValue());
			}
			json.endObject();
		} else if (value instanceof List<?> list) {
			json.beginArray();
			for (Object item : list) {
				writeValue(json, item);
			}
			json.endArray();
		} else if (value instanceof Float number) {
			json.value(number, 3);
		} else {
			json.value(String.valueOf(value));
		}
	}
}
