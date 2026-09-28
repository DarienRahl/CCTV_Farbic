package io.github.darienrahl.cctv.assets;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Enumeration;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.regex.Pattern;
import java.util.zip.GZIPOutputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;

/**
 * Block textures and models for the web viewer.
 *
 * <p>A dedicated server does not ship textures, so the official client jar of
 * the running version is downloaded once from Mojang (the same way launchers
 * and map renderers such as BlueMap do) and cached in {@code config/cctv/assets}.
 * Resource packs placed in {@code config/cctv/resourcepacks} are applied on top.
 * Browsers receive one bundle with block states, block models, block and
 * item textures; entity textures are served one by one on demand.
 */
public final class ClientAssets implements AutoCloseable {
	public enum State {
		DISABLED,
		LOADING,
		READY,
		FAILED
	}

	private static final String MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
	private static final Pattern ENTITY_PATH = Pattern.compile("^[a-z0-9_./-]{1,128}$");
	private static final Pattern FONT_PATH = Pattern.compile("^[a-z0-9_./-]{1,128}\\.(json|png)$");

	private final Path dir;
	private final String version;
	private final boolean download;
	private final Logger logger;
	private final List<ZipFile> sources = new ArrayList<>();
	private volatile State state = State.LOADING;
	private volatile String error = "";
	private volatile byte[] bundle;
	private volatile String etag = "";
	private volatile String entityList = "[]";
	private volatile byte @Nullable [] entityModels;
	private volatile String entityModelsEtag = "";
	private volatile boolean entityModelsPending = true;

	public ClientAssets(Path dir, String version, boolean download, Logger logger) {
		this.dir = dir;
		this.version = version;
		this.download = download;
		this.logger = logger;
	}

	public void start() {
		Thread thread = new Thread(this::load, "cctv-assets");
		thread.setDaemon(true);
		thread.start();
	}

	public State state() {
		return state;
	}

	public String error() {
		return error;
	}

	/** Gzip-compressed JSON bundle, only valid when {@link #state()} is READY. */
	public byte[] bundle() {
		return bundle;
	}

	public String etag() {
		return etag;
	}

	public String entityListJson() {
		return entityList;
	}

	/** Gzip-compressed entity model geometry (see {@link EntityModels}), or {@code null} when unavailable. */
	public byte @Nullable [] entityModels() {
		return entityModels;
	}

	public String entityModelsEtag() {
		return entityModelsEtag;
	}

	/** True while entity models may still become available (the client jar is being read). */
	public boolean entityModelsPending() {
		return entityModelsPending && state != State.FAILED && state != State.DISABLED;
	}

	/** @param path path below {@code textures/entity/} without extension, e.g. {@code cow/cow_temperate} */
	public byte[] entityTexture(String path) {
		return texture("entity", path);
	}

	/** @param path path below {@code textures/painting/} without extension, e.g. {@code kebab} */
	public byte[] paintingTexture(String path) {
		return texture("painting", path);
	}

	/**
	 * The game's font: {@code name.json} from {@code font/} (definitions) or {@code name.png} from
	 * {@code textures/font/} (glyph sheets), e.g. {@code default.json}, {@code include/default.json}, {@code ascii.png}.
	 */
	public byte[] font(String name) {
		if (state != State.READY || !FONT_PATH.matcher(name).matches() || name.contains("..")) {
			return null;
		}
		return name.endsWith(".json")
				? read("assets/minecraft/font/" + name)
				: read("assets/minecraft/textures/font/" + name);
	}

	private byte[] texture(String folder, String path) {
		if (state != State.READY || !ENTITY_PATH.matcher(path).matches() || path.contains("..")) {
			return null;
		}
		return read("assets/minecraft/textures/" + folder + "/" + path + ".png");
	}

	private synchronized byte[] read(String name) {
		// Resource packs first, the client jar last.
		for (int i = sources.size() - 1; i >= 0; i--) {
			ZipFile zip = sources.get(i);
			ZipEntry entry = zip.getEntry(name);
			if (entry != null) {
				try (InputStream in = zip.getInputStream(entry)) {
					return in.readAllBytes();
				} catch (IOException e) {
					return null;
				}
			}
		}
		return null;
	}

	@Override
	public synchronized void close() {
		for (ZipFile zip : sources) {
			try {
				zip.close();
			} catch (IOException ignored) {
				// Nothing to do.
			}
		}
		sources.clear();
	}

	private void load() {
		try {
			Files.createDirectories(dir);
			Path jar = findOrDownloadClientJar();
			if (jar == null) {
				state = State.DISABLED;
				logger.info("CCTV: no client jar available - the viewer uses plain block colours. "
						+ "Set downloadClientAssets=true or put a client jar into {}", dir);
				return;
			}

			synchronized (this) {
				sources.add(new ZipFile(jar.toFile()));
				Path packs = dir.resolveSibling("resourcepacks");
				if (Files.isDirectory(packs)) {
					try (DirectoryStream<Path> stream = Files.newDirectoryStream(packs, "*.zip")) {
						List<Path> sorted = new ArrayList<>();
						stream.forEach(sorted::add);
						sorted.sort(null);
						for (Path pack : sorted) {
							sources.add(new ZipFile(pack.toFile()));
							logger.info("CCTV: using resource pack {}", pack.getFileName());
						}
					}
				}
			}

			long start = System.nanoTime();
			bundle = gzip(buildBundle());
			etag = etagOf(bundle);
			state = State.READY;
			logger.info("CCTV: block assets ready ({} KB, {} ms)", bundle.length / 1024, (System.nanoTime() - start) / 1_000_000);

			loadEntityModels(jar);
		} catch (Exception e) {
			error = e.toString();
			state = State.FAILED;
			logger.error("CCTV: could not prepare block textures, the viewer falls back to plain colours", e);
		}
	}

	/**
	 * Entity model geometry from the client jar, cached next to it: reading it loads the game's model
	 * classes, which only has to happen once per version.
	 */
	private void loadEntityModels(Path jar) {
		try {
			Path cache = dir.resolve("entity-models-" + version + ".json.gz");
			byte[] gz = null;
			if (Files.isRegularFile(cache) && Files.getLastModifiedTime(cache).compareTo(Files.getLastModifiedTime(jar)) >= 0) {
				gz = Files.readAllBytes(cache);
			} else {
				String models = EntityModels.extract(jar, logger);
				if (models != null) {
					gz = gzip(models.getBytes(StandardCharsets.UTF_8));
					Files.write(cache, gz);
				}
			}
			if (gz != null) {
				entityModelsEtag = etagOf(gz);
				entityModels = gz;
			}
		} catch (Exception e) {
			logger.warn("CCTV: entity models unavailable, the viewer draws entities as boxes", e);
		} finally {
			entityModelsPending = false;
		}
	}

	private static byte[] gzip(byte[] data) throws IOException {
		ByteArrayOutputStream compressed = new ByteArrayOutputStream(data.length / 2);
		try (GZIPOutputStream gzip = new GZIPOutputStream(compressed)) {
			gzip.write(data);
		}
		return compressed.toByteArray();
	}

	private static String etagOf(byte[] data) throws Exception {
		return "\"" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-1").digest(data)).substring(0, 16) + "\"";
	}

	private Path findOrDownloadClientJar() throws Exception {
		Path versioned = dir.resolve("client-" + version + ".jar");
		if (Files.isRegularFile(versioned)) {
			return versioned;
		}
		Path manual = dir.resolve("client.jar");
		if (Files.isRegularFile(manual)) {
			return manual;
		}
		if (!download) {
			return null;
		}

		logger.info("CCTV: downloading the Minecraft {} client jar from Mojang for block textures (one time, ~30 MB)", version);
		HttpClient http = HttpClient.newBuilder()
				.connectTimeout(Duration.ofSeconds(15))
				.followRedirects(HttpClient.Redirect.NORMAL)
				.build();

		JsonObject manifest = getJson(http, MANIFEST);
		String versionUrl = null;
		for (JsonElement element : manifest.getAsJsonArray("versions")) {
			JsonObject entry = element.getAsJsonObject();
			if (entry.get("id").getAsString().equals(version)) {
				versionUrl = entry.get("url").getAsString();
				break;
			}
		}
		if (versionUrl == null) {
			throw new IOException("Version " + version + " not found in Mojang's version manifest");
		}

		JsonObject client = getJson(http, versionUrl).getAsJsonObject("downloads").getAsJsonObject("client");
		String url = client.get("url").getAsString();
		String sha1 = client.get("sha1").getAsString();

		Path part = dir.resolve("client-" + version + ".jar.part");
		HttpResponse<Path> response = http.send(HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofMinutes(10)).build(),
				HttpResponse.BodyHandlers.ofFile(part));
		if (response.statusCode() != 200) {
			throw new IOException("Client jar download failed: HTTP " + response.statusCode());
		}

		MessageDigest digest = MessageDigest.getInstance("SHA-1");
		try (InputStream in = Files.newInputStream(part)) {
			byte[] buffer = new byte[65536];
			int read;
			while ((read = in.read(buffer)) > 0) {
				digest.update(buffer, 0, read);
			}
		}
		String actual = HexFormat.of().formatHex(digest.digest());
		if (!actual.equalsIgnoreCase(sha1)) {
			Files.deleteIfExists(part);
			throw new IOException("Client jar checksum mismatch");
		}

		Files.move(part, versioned, StandardCopyOption.REPLACE_EXISTING);
		return versioned;
	}

	private static JsonObject getJson(HttpClient http, String url) throws Exception {
		HttpResponse<String> response = http.send(HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(30)).build(),
				HttpResponse.BodyHandlers.ofString());
		if (response.statusCode() != 200) {
			throw new IOException("HTTP " + response.statusCode() + " for " + url);
		}
		return JsonParser.parseString(response.body()).getAsJsonObject();
	}

	/**
	 * {"version", "blockstates": {id: json}, "models": {id: json}, "textures": {id: base64 png},
	 * "animations": {id: mcmeta}, "colormaps": {name: base64 png}, "environment": {path: base64 png}}
	 * (sun, moon, clouds). Later sources override earlier ones.
	 */
	private byte[] buildBundle() throws IOException {
		Map<String, JsonElement> blockstates = new LinkedHashMap<>();
		Map<String, JsonElement> models = new LinkedHashMap<>();
		Map<String, String> textures = new LinkedHashMap<>();
		Map<String, JsonElement> animations = new LinkedHashMap<>();
		Map<String, String> colormaps = new LinkedHashMap<>();
		Map<String, String> environment = new LinkedHashMap<>();
		TreeSet<String> entityTextures = new TreeSet<>();

		List<ZipFile> zips;
		synchronized (this) {
			zips = new ArrayList<>(sources);
		}

		for (ZipFile zip : zips) {
			Enumeration<? extends ZipEntry> entries = zip.entries();
			while (entries.hasMoreElements()) {
				ZipEntry entry = entries.nextElement();
				String name = entry.getName();
				if (entry.isDirectory() || !name.startsWith("assets/")) {
					continue;
				}

				int nsEnd = name.indexOf('/', 7);
				if (nsEnd < 0) {
					continue;
				}
				String namespace = name.substring(7, nsEnd);
				String rest = name.substring(nsEnd + 1);

				try {
					if (rest.startsWith("blockstates/") && rest.endsWith(".json")) {
						blockstates.put(namespace + ":" + strip(rest, "blockstates/", ".json"), parse(zip, entry));
					} else if (rest.startsWith("models/block/") && rest.endsWith(".json")) {
						models.put(namespace + ":" + strip(rest, "models/", ".json"), parse(zip, entry));
					} else if ((rest.startsWith("textures/block/") || rest.startsWith("textures/item/")) && rest.endsWith(".png")) {
						textures.put(namespace + ":" + strip(rest, "textures/", ".png"), base64(zip, entry));
					} else if ((rest.startsWith("textures/block/") || rest.startsWith("textures/item/")) && rest.endsWith(".png.mcmeta")) {
						animations.put(namespace + ":" + strip(rest, "textures/", ".png.mcmeta"), parse(zip, entry));
					} else if (namespace.equals("minecraft") && rest.startsWith("textures/colormap/") && rest.endsWith(".png")) {
						colormaps.put(strip(rest, "textures/colormap/", ".png"), base64(zip, entry));
					} else if (namespace.equals("minecraft") && rest.startsWith("textures/environment/") && rest.endsWith(".png")) {
						environment.put(strip(rest, "textures/environment/", ".png"), base64(zip, entry));
					} else if (namespace.equals("minecraft") && rest.startsWith("textures/entity/") && rest.endsWith(".png")) {
						entityTextures.add(strip(rest, "textures/entity/", ".png"));
					}
				} catch (RuntimeException e) {
					// Broken JSON in a resource pack - skip that file.
					logger.debug("CCTV: skipping {}", name, e);
				}
			}
		}

		// Textures referenced by block models from outside textures/block (a handful of vanilla models do that).
		for (JsonElement model : models.values()) {
			if (!model.isJsonObject() || !model.getAsJsonObject().has("textures")) {
				continue;
			}
			for (Map.Entry<String, JsonElement> texture : model.getAsJsonObject().getAsJsonObject("textures").entrySet()) {
				JsonElement value = texture.getValue();
				if (value.isJsonObject() && value.getAsJsonObject().has("sprite")) {
					value = value.getAsJsonObject().get("sprite");
				}
				if (!value.isJsonPrimitive()) {
					continue;
				}
				String ref = value.getAsString();
				if (ref.startsWith("#")) {
					continue;
				}
				String id = ref.contains(":") ? ref : "minecraft:" + ref;
				if (textures.containsKey(id)) {
					continue;
				}
				String ns = id.substring(0, id.indexOf(':'));
				String path = id.substring(id.indexOf(':') + 1);
				byte[] png = read("assets/" + ns + "/textures/" + path + ".png");
				if (png != null) {
					textures.put(id, Base64.getEncoder().encodeToString(png));
				}
			}
		}

		JsonObject root = new JsonObject();
		root.addProperty("version", version);
		root.add("blockstates", toObject(blockstates));
		root.add("models", toObject(models));
		JsonObject textureObject = new JsonObject();
		textures.forEach(textureObject::addProperty);
		root.add("textures", textureObject);
		root.add("animations", toObject(animations));
		JsonObject colormapObject = new JsonObject();
		colormaps.forEach(colormapObject::addProperty);
		root.add("colormaps", colormapObject);
		JsonObject environmentObject = new JsonObject();
		environment.forEach(environmentObject::addProperty);
		root.add("environment", environmentObject);

		JsonArray list = new JsonArray();
		entityTextures.forEach(list::add);
		entityList = list.toString();

		return root.toString().getBytes(StandardCharsets.UTF_8);
	}

	private static JsonObject toObject(Map<String, JsonElement> map) {
		JsonObject object = new JsonObject();
		map.forEach(object::add);
		return object;
	}

	private static String strip(String path, String prefix, String suffix) {
		return path.substring(prefix.length(), path.length() - suffix.length());
	}

	private static JsonElement parse(ZipFile zip, ZipEntry entry) throws IOException {
		try (InputStreamReader reader = new InputStreamReader(zip.getInputStream(entry), StandardCharsets.UTF_8)) {
			return JsonParser.parseReader(reader);
		}
	}

	private static String base64(ZipFile zip, ZipEntry entry) throws IOException {
		try (InputStream in = zip.getInputStream(entry)) {
			return Base64.getEncoder().encodeToString(in.readAllBytes());
		}
	}
}
