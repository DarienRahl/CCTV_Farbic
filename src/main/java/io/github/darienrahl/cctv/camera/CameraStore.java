package io.github.darienrahl.cctv.camera;

import java.io.IOException;
import java.io.Reader;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonParseException;
import org.slf4j.Logger;

/** Persists cameras in {@code config/cctv/cameras.json}. */
public final class CameraStore {
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();

	/** Plain class instead of the record so Gson never depends on record support. */
	private static final class Entry {
		String name;
		String dimension;
		double x;
		double y;
		double z;
		float yaw;
		float pitch;
		double fov;
		int range;
	}

	private final Path file;
	private final Logger logger;

	public CameraStore(Path file, Logger logger) {
		this.file = file;
		this.logger = logger;
	}

	public List<Camera> load() {
		List<Camera> cameras = new ArrayList<>();
		if (!Files.exists(file)) {
			return cameras;
		}

		try (Reader reader = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
			Entry[] entries = GSON.fromJson(reader, Entry[].class);
			if (entries != null) {
				for (Entry e : entries) {
					if (e == null || e.name == null || !Camera.NAME.matcher(e.name).matches() || e.dimension == null) {
						continue;
					}
					cameras.add(new Camera(e.name, e.dimension, e.x, e.y, e.z, e.yaw, e.pitch,
							e.fov <= 0 ? 70 : e.fov, e.range <= 0 ? 64 : e.range));
				}
			}
		} catch (IOException | JsonParseException e) {
			logger.error("Could not read {}", file, e);
		}

		return cameras;
	}

	public void save(Collection<Camera> cameras) {
		List<Entry> entries = new ArrayList<>();
		for (Camera camera : cameras) {
			Entry e = new Entry();
			e.name = camera.name();
			e.dimension = camera.dimension();
			e.x = camera.x();
			e.y = camera.y();
			e.z = camera.z();
			e.yaw = camera.yaw();
			e.pitch = camera.pitch();
			e.fov = camera.fov();
			e.range = camera.range();
			entries.add(e);
		}

		try {
			Files.createDirectories(file.getParent());
			Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
			try (Writer writer = Files.newBufferedWriter(tmp, StandardCharsets.UTF_8)) {
				GSON.toJson(entries, writer);
			}
			Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING);
		} catch (IOException e) {
			logger.error("Could not write {}", file, e);
		}
	}
}
