package io.github.darienrahl.cctv.web;

import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Pattern;

import org.jspecify.annotations.Nullable;

import io.github.darienrahl.cctv.CctvConfig;

/**
 * Admin-provided look for the viewer, from {@code config/cctv}:
 *
 * <ul>
 * <li>{@code skyboxes/<name>/} with six faces ({@code px nx py ny pz nz}, png/jpg/webp), or
 *     {@code skyboxes/<name>.png|jpg|webp} as one equirectangular panorama; an optional
 *     {@code skyboxes/<name>.json} holds options for the viewer;</li>
 * <li>{@code shaders/<name>.glsl}: post-processing shaders run on the finished picture.</li>
 * </ul>
 */
final class CustomContent {
	private static final Pattern NAME = Pattern.compile("^[A-Za-z0-9_-]{1,64}$");
	private static final Pattern IMAGE = Pattern.compile("^[A-Za-z0-9_-]{1,64}\\.(png|jpg|jpeg|webp)$");
	private static final String[] FACES = {"px", "nx", "py", "ny", "pz", "nz"};

	private CustomContent() {
	}

	/** Viewer defaults plus what can be chosen. */
	static String viewerJson(CctvConfig config, Path dataDir) {
		CctvConfig.ViewerDefaults viewer = config.viewer;
		Json json = new Json(1024);
		json.beginObject().name("defaults").beginObject()
				.field("graphics", viewer.graphics)
				.field("shaderQuality", viewer.shaderQuality)
				.field("postShader", viewer.postShader)
				.field("clouds", viewer.clouds)
				.field("labels", viewer.labels)
				.field("mobLabels", viewer.mobLabels)
				.field("particles", viewer.particles)
				.field("mode", viewer.mode)
				.field("cctvEffect", viewer.cctvEffect)
				.name("skyboxes").beginObject();
		for (Map.Entry<String, String> entry : viewer.skyboxes.entrySet()) {
			json.field(entry.getKey(), entry.getValue());
		}
		json.endObject().endObject()
				.field("locked", viewer.lockSettings)
				.field("sounds", config.sounds);

		json.name("skyboxes").beginObject();
		for (Map.Entry<String, String> skybox : skyboxes(dataDir.resolve("skyboxes")).entrySet()) {
			json.name(skybox.getKey()).raw(skybox.getValue());
		}
		json.endObject();

		json.name("shaders").beginArray();
		for (String shader : list(dataDir.resolve("shaders"), ".glsl")) {
			json.value(shader);
		}
		json.endArray();
		return json.endObject().toString();
	}

	/**
	 * {@code skyboxes/<name>/<face>.<ext>}, {@code skyboxes/<name>.<ext>} or {@code shaders/<name>.glsl}.
	 *
	 * @return the file, or {@code null} when the path is not allowed or missing
	 */
	static @Nullable Path resolve(Path dataDir, String path) {
		String[] parts = path.split("/");
		Path file = null;
		if (parts.length == 2 && parts[0].equals("shaders") && parts[1].endsWith(".glsl")
				&& NAME.matcher(parts[1].substring(0, parts[1].length() - 5)).matches()) {
			file = dataDir.resolve("shaders").resolve(parts[1]);
		} else if (parts.length == 2 && parts[0].equals("skyboxes") && (IMAGE.matcher(parts[1]).matches() || isOptions(parts[1]))) {
			file = dataDir.resolve("skyboxes").resolve(parts[1]);
		} else if (parts.length == 3 && parts[0].equals("skyboxes") && NAME.matcher(parts[1]).matches() && IMAGE.matcher(parts[2]).matches()) {
			file = dataDir.resolve("skyboxes").resolve(parts[1]).resolve(parts[2]);
		}
		return file != null && Files.isRegularFile(file) ? file : null;
	}

	private static boolean isOptions(String file) {
		return file.endsWith(".json") && NAME.matcher(file.substring(0, file.length() - 5)).matches();
	}

	/** name -> {"type": "cube", "faces": {...}} or {"type": "panorama", "file": ...}, plus "options" when a json exists. */
	private static Map<String, String> skyboxes(Path dir) {
		Map<String, String> result = new TreeMap<>();
		if (!Files.isDirectory(dir)) {
			return result;
		}
		try (DirectoryStream<Path> stream = Files.newDirectoryStream(dir)) {
			for (Path entry : stream) {
				String file = entry.getFileName().toString();
				if (Files.isDirectory(entry) && NAME.matcher(file).matches()) {
					Json json = new Json(256).beginObject().field("type", "cube").name("faces").beginObject();
					int found = 0;
					for (String face : FACES) {
						String image = findImage(entry, face);
						if (image != null) {
							json.field(face, "/custom/skyboxes/" + file + "/" + image);
							found++;
						}
					}
					json.endObject();
					options(json, dir, file);
					if (found == FACES.length) {
						result.put(file, json.endObject().toString());
					}
				} else if (IMAGE.matcher(file).matches()) {
					String name = file.substring(0, file.lastIndexOf('.'));
					Json json = new Json(128).beginObject().field("type", "panorama").field("file", "/custom/skyboxes/" + file);
					options(json, dir, name);
					result.put(name, json.endObject().toString());
				}
			}
		} catch (IOException ignored) {
			// Unreadable folder: no sky boxes.
		}
		return result;
	}

	private static void options(Json json, Path dir, String name) {
		if (Files.isRegularFile(dir.resolve(name + ".json"))) {
			json.field("options", "/custom/skyboxes/" + name + ".json");
		}
	}

	private static @Nullable String findImage(Path dir, String face) {
		for (String ext : new String[]{"png", "jpg", "jpeg", "webp"}) {
			if (Files.isRegularFile(dir.resolve(face + "." + ext))) {
				return face + "." + ext;
			}
		}
		return null;
	}

	private static List<String> list(Path dir, String suffix) {
		List<String> names = new ArrayList<>();
		if (!Files.isDirectory(dir)) {
			return names;
		}
		try (DirectoryStream<Path> stream = Files.newDirectoryStream(dir, "*" + suffix)) {
			for (Path file : stream) {
				String name = file.getFileName().toString();
				name = name.substring(0, name.length() - suffix.length());
				if (NAME.matcher(name).matches()) {
					names.add(name);
				}
			}
		} catch (IOException ignored) {
			// Nothing to list.
		}
		names.sort(String.CASE_INSENSITIVE_ORDER);
		return names;
	}
}
