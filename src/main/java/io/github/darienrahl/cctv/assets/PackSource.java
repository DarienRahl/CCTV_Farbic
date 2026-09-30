package io.github.darienrahl.cctv.assets;

import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.stream.Stream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

import org.jspecify.annotations.Nullable;

/**
 * One source of game assets, like the client's PackResources: the client jar, a zipped resource pack or data
 * pack, or an unpacked pack folder. File names use '/' and start at the pack root ({@code assets/...}).
 */
abstract class PackSource implements Closeable {
	/** Pack folders are walked once; more files than this and the rest is left out. */
	private static final int MAX_FOLDER_FILES = 200_000;

	private final String name;

	PackSource(String name) {
		this.name = name;
	}

	String name() {
		return name;
	}

	/** The pack's files (not folders). */
	abstract List<String> files();

	/** A file's contents, or null when the pack does not have it. */
	abstract byte @Nullable [] read(String file) throws IOException;

	static PackSource open(Path path) throws IOException {
		return Files.isDirectory(path) ? new Folder(path) : new Zip(path);
	}

	/** Whether a pack (zip or folder) has client assets at all: data packs usually do not. */
	static boolean hasAssets(Path path) {
		if (Files.isDirectory(path)) {
			return Files.isDirectory(path.resolve("assets"));
		}
		try (ZipFile zip = new ZipFile(path.toFile())) {
			Enumeration<? extends ZipEntry> entries = zip.entries();
			while (entries.hasMoreElements()) {
				if (entries.nextElement().getName().startsWith("assets/")) {
					return true;
				}
			}
			return false;
		} catch (IOException e) {
			return false;
		}
	}

	private static final class Zip extends PackSource {
		private final ZipFile zip;

		Zip(Path path) throws IOException {
			super(path.getFileName().toString());
			this.zip = new ZipFile(path.toFile());
		}

		@Override
		List<String> files() {
			List<String> files = new ArrayList<>();
			Enumeration<? extends ZipEntry> entries = zip.entries();
			while (entries.hasMoreElements()) {
				ZipEntry entry = entries.nextElement();
				if (!entry.isDirectory()) {
					files.add(entry.getName());
				}
			}
			return files;
		}

		@Override
		byte @Nullable [] read(String file) throws IOException {
			ZipEntry entry = zip.getEntry(file);
			if (entry == null || entry.isDirectory()) {
				return null;
			}
			try (InputStream in = zip.getInputStream(entry)) {
				return in.readAllBytes();
			}
		}

		@Override
		public void close() throws IOException {
			zip.close();
		}
	}

	private static final class Folder extends PackSource {
		private final Path root;
		private @Nullable List<String> files;

		Folder(Path root) {
			super(root.getFileName() + "/");
			this.root = root.toAbsolutePath().normalize();
		}

		@Override
		synchronized List<String> files() {
			if (files == null) {
				List<String> found = new ArrayList<>();
				Path assets = root.resolve("assets");
				if (Files.isDirectory(assets)) {
					try (Stream<Path> walk = Files.walk(assets)) {
						walk.filter(Files::isRegularFile).limit(MAX_FOLDER_FILES)
								.forEach(file -> found.add(root.relativize(file).toString().replace('\\', '/')));
					} catch (IOException e) {
						// An unreadable folder counts as empty.
					}
				}
				files = found;
			}
			return files;
		}

		@Override
		byte @Nullable [] read(String file) throws IOException {
			if (file.contains("..") || file.startsWith("/")) {
				return null;
			}
			Path path = root.resolve(file).normalize();
			if (!path.startsWith(root) || !Files.isRegularFile(path)) {
				return null;
			}
			return Files.readAllBytes(path);
		}

		@Override
		public void close() {
			// Nothing held open.
		}
	}
}
