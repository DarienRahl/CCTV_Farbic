package io.github.darienrahl.cctv.assets;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.Reader;
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
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.regex.Pattern;
import java.util.zip.GZIPOutputStream;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;

import io.github.darienrahl.cctv.web.Json;

/**
 * Block textures and models for the web viewer.
 *
 * <p>A dedicated server does not ship textures, so the official client jar of
 * the running version is downloaded once from Mojang (the same way launchers
 * and map renderers such as BlueMap do) and cached in {@code config/cctv/assets}.
 * Resource packs are applied on top, lowest priority first: the assets of the world's data packs
 * ({@code <world>/datapacks}), the world's own {@code resources.zip}, the server resource pack of
 * {@code server.properties} (downloaded and cached) and the packs in {@code config/cctv/resourcepacks}
 * (zips or unpacked folders), so custom paintings, music discs, sounds and items look and sound like
 * they do for players.
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
	private static final String ASSET_OBJECTS = "https://resources.download.minecraft.net/";
	private static final Pattern ENTITY_PATH = Pattern.compile("^[a-z0-9_./-]{1,128}$");
	private static final Pattern NAMESPACE = Pattern.compile("^[a-z0-9_.-]{1,64}$");
	private static final Pattern FONT_PATH = Pattern.compile("^[a-z0-9_./-]{1,128}\\.(json|png)$");

	private final Path dir;
	private final String version;
	private final boolean download;
	private final String language;
	private final Logger logger;
	private final List<PackSource> sources = new ArrayList<>();
	private volatile @Nullable Path worldDirectory;
	private volatile Map<String, String> translations = Map.of();
	private List<ModPack> modPacks = List.of();
	private volatile boolean textsReady;
	private volatile @Nullable String serverPackUrl;
	private volatile @Nullable String serverPackSha1;
	private volatile State state = State.LOADING;
	private volatile String error = "";
	private volatile byte[] bundle;
	private volatile String etag = "";
	private volatile String entityList = "[]";
	private volatile byte @Nullable [] entityModels;
	private volatile String entityModelsEtag = "";
	private volatile boolean entityModelsPending = true;
	private volatile String names = "{}";

	public ClientAssets(Path dir, String version, boolean download, Logger logger) {
		this(dir, version, download, "en_us", logger);
	}

	/** @param language Minecraft language code of the entity names, e.g. {@code en_us} or {@code pl_pl} */
	public ClientAssets(Path dir, String version, boolean download, String language, Logger logger) {
		this.dir = dir;
		this.version = version;
		this.download = download;
		this.language = language;
		this.logger = logger;
	}

	/**
	 * The world whose packs apply before the configured ones: the data packs in {@code datapacks/} that carry
	 * assets and the world's {@code resources.zip}. Call before {@link #start()}.
	 */
	public void worldDirectory(Path world) {
		this.worldDirectory = world;
	}

	/**
	 * A text of the game's language files in the configured language (en_us under it, resource packs over the
	 * client's): {@code jukebox_song.*}, {@code painting.*} and {@code record.*} keys. Null when unknown.
	 */
	public @Nullable String translation(String key) {
		return translations.get(key);
	}

	/**
	 * The texts of all loaded keys with a prefix (e.g. {@code music.} for the titles of the game's songs, which
	 * the Now Playing toast shows).
	 */
	public Map<String, String> translations(String prefix) {
		Map<String, String> found = new java.util.TreeMap<>();
		for (Map.Entry<String, String> entry : translations.entrySet()) {
			if (entry.getKey().startsWith(prefix)) {
				found.put(entry.getKey(), entry.getValue());
			}
		}
		return found;
	}

	/** Whether the language texts are loaded (they follow the block assets). */
	public boolean textsReady() {
		return textsReady;
	}

	/** A mod whose files carry client assets (sounds, textures, texts): its id and the root of its files. */
	public record ModPack(String id, Path root) {
	}

	/**
	 * The installed mods' assets, used like the client's mod resource packs: over the client jar and under the
	 * world's and the configured packs (so a mod such as The Immersive Music Mod brings its songs to the viewer).
	 * Call before {@link #start()}.
	 */
	public void modPacks(List<ModPack> packs) {
		this.modPacks = List.copyOf(packs);
	}

	/** The server resource pack players are sent (server.properties), downloaded when the assets load. */
	public void serverPack(@Nullable String url, @Nullable String sha1) {
		this.serverPackUrl = url;
		this.serverPackSha1 = sha1;
	}

	/** Names of the resource packs in use, lowest priority first (the client jar left out). */
	public synchronized List<String> packNames() {
		List<String> names = new ArrayList<>();
		for (int i = 1; i < sources.size(); i++) {
			names.add(sources.get(i).name());
		}
		return names;
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

	/** Entity names in the configured language: {@code {"cow": "Cow", ...}} ({@code entity.minecraft.*} keys). */
	public String namesJson() {
		return names;
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

	/** @param path path below {@code textures/misc/} without extension, e.g. {@code shadow} */
	public byte[] miscTexture(String path) {
		return texture("misc", path);
	}

	/**
	 * Textures the viewer recolours or draws on maps: {@code trims/...} (armour trim patterns, with their
	 * .mcmeta naming the base palette), {@code palettes/...} (trim material colours) and {@code map/...}
	 * (map decorations).
	 *
	 * @param path path below {@code textures/}, e.g. {@code trims/entity/humanoid/bolt.png.mcmeta}
	 */
	public byte[] recolourTexture(String path) {
		if (state != State.READY || path.contains("..")) {
			return null;
		}
		boolean meta = path.endsWith(".png.mcmeta");
		String name = path.substring(0, path.length() - (meta ? ".png.mcmeta" : ".png").length());
		if (!(path.endsWith(".png") || meta) || !ENTITY_PATH.matcher(name).matches()
				|| !(name.startsWith("trims/") || name.startsWith("palettes/") || name.startsWith("map/"))) {
			return null;
		}
		return read("assets/minecraft/textures/" + path);
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

	/** @param path {@code name} or {@code namespace:name} (textures of data and resource packs' own namespaces) */
	private byte[] texture(String folder, String path) {
		String namespace = "minecraft";
		int colon = path.indexOf(':');
		if (colon > 0) {
			namespace = path.substring(0, colon);
			path = path.substring(colon + 1);
		}
		if (state != State.READY || !NAMESPACE.matcher(namespace).matches() || !ENTITY_PATH.matcher(path).matches() || path.contains("..")) {
			return null;
		}
		return read("assets/" + namespace + "/textures/" + folder + "/" + path + ".png");
	}

	/** A file of the packs or the client jar, the highest priority one (null when there is none). */
	byte @Nullable [] resource(String name) {
		return read(name);
	}

	/**
	 * A GUI sprite of the game ({@code textures/gui/sprites/<path>.png}, or its {@code .png.mcmeta} with the
	 * nine-slice or animation settings), resource packs over the client jar; null when there is none.
	 */
	public byte @Nullable [] guiSprite(String path, boolean meta) {
		if (!path.matches("[a-z0-9_/.-]{1,128}") || path.contains("..")) {
			return null;
		}
		return read("assets/minecraft/textures/gui/sprites/" + path + (meta ? ".png.mcmeta" : ".png"));
	}

	private synchronized byte[] read(String name) {
		// Resource packs first, the client jar last.
		for (int i = sources.size() - 1; i >= 0; i--) {
			try {
				byte[] data = sources.get(i).read(name);
				if (data != null) {
					return data;
				}
			} catch (IOException e) {
				return null;
			}
		}
		return null;
	}

	@Override
	public synchronized void close() {
		for (PackSource source : sources) {
			try {
				source.close();
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

			List<Path> packs = new ArrayList<>(worldPacks());
			Path serverPack = serverPack();
			if (serverPack != null) {
				packs.add(serverPack);
			}
			Path configured = dir.resolveSibling("resourcepacks");
			if (Files.isDirectory(configured)) {
				try (DirectoryStream<Path> stream = Files.newDirectoryStream(configured,
						path -> path.getFileName().toString().endsWith(".zip") || Files.isDirectory(path.resolve("assets")))) {
					List<Path> sorted = new ArrayList<>();
					stream.forEach(sorted::add);
					sorted.sort(null);
					packs.addAll(sorted);
				}
			}
			synchronized (this) {
				sources.add(PackSource.open(jar));
				for (ModPack mod : modPacks) {
					sources.add(PackSource.mod(mod.root(), "mod:" + mod.id()));
					logger.info("CCTV: using the assets of the mod {}", mod.id());
				}
				for (Path pack : packs) {
					try {
						sources.add(PackSource.open(pack));
						logger.info("CCTV: using resource pack {}", pack.getFileName());
					} catch (IOException e) {
						logger.warn("CCTV: resource pack {} could not be opened: {}", pack, e.toString());
					}
				}
			}

			long start = System.nanoTime();
			bundle = gzip(buildBundle());
			etag = etagOf(bundle);
			state = State.READY;
			logger.info("CCTV: block assets ready ({} KB, {} ms)", bundle.length / 1024, (System.nanoTime() - start) / 1_000_000);

			loadNames();
			try {
				loadTranslations();
			} catch (RuntimeException e) {
				logger.warn("CCTV: song and painting texts unavailable: {}", e.toString());
			}
			textsReady = true;
			loadEntityModels(jar);
		} catch (Exception e) {
			error = e.toString();
			state = State.FAILED;
			logger.error("CCTV: could not prepare block textures, the viewer falls back to plain colours", e);
		}
	}

	/** The world's packs with assets, lowest priority first: data packs (by name), then resources.zip. */
	private List<Path> worldPacks() {
		Path world = worldDirectory;
		List<Path> packs = new ArrayList<>();
		if (world == null) {
			return packs;
		}
		Path datapacks = world.resolve("datapacks");
		if (Files.isDirectory(datapacks)) {
			try (DirectoryStream<Path> stream = Files.newDirectoryStream(datapacks)) {
				List<Path> sorted = new ArrayList<>();
				for (Path pack : stream) {
					if ((Files.isDirectory(pack) || pack.getFileName().toString().endsWith(".zip")) && PackSource.hasAssets(pack)) {
						sorted.add(pack);
					}
				}
				sorted.sort(null);
				packs.addAll(sorted);
			} catch (IOException e) {
				logger.warn("CCTV: the world's data packs could not be listed: {}", e.toString());
			}
		}
		Path resources = world.resolve("resources.zip");
		if (Files.isRegularFile(resources)) {
			packs.add(resources);
		}
		return packs;
	}

	/**
	 * Entity model geometry from the client jar, cached next to it: reading it loads the game's model
	 * classes, which only has to happen once per version.
	 */
	private void loadEntityModels(Path jar) {
		try {
			Path cache = dir.resolve("entity-models-" + EntityModels.FORMAT + "-" + version + ".json.gz");
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

	/**
	 * The game's entity names: {@code en_us} from the client jar, the configured language on top (from a
	 * resource pack, or downloaded from Mojang's asset index once and cached next to the jar).
	 */
	private void loadNames() {
		try {
			Map<String, String> merged = new TreeMap<>();
			collectNames(merged, read("assets/minecraft/lang/en_us.json"));
			if (!language.equals("en_us")) {
				byte[] translated = read("assets/minecraft/lang/" + language + ".json");
				collectNames(merged, translated != null ? translated : downloadLanguage());
			}
			Json json = new Json(64 + merged.size() * 32).beginObject();
			merged.forEach(json::field);
			names = json.endObject().toString();
		} catch (Exception e) {
			logger.warn("CCTV: entity names in '{}' unavailable, English names are used ({})", language, e.toString());
		}
	}

	/**
	 * Prefixes of the language keys the server side needs (song descriptions, painting titles, "Now Playing") and
	 * the titles of the game's background music (NowPlayingToast).
	 */
	private static final String[] TRANSLATED = {"jukebox_song.", "painting.", "record.", "music."};

	/**
	 * ClientLanguage.loadFrom: en_us, then the configured language, each from every source that has it (client
	 * jar, then the packs in order) and in every namespace, later ones winning.
	 */
	private void loadTranslations() {
		Map<String, String> merged = new java.util.HashMap<>();
		List<String> languages = language.equals("en_us") ? List.of("en_us") : List.of("en_us", language);
		List<PackSource> packs;
		synchronized (this) {
			packs = new ArrayList<>(sources);
		}
		for (String lang : languages) {
			if (!lang.equals("en_us") && read("assets/minecraft/lang/" + lang + ".json") == null) {
				// languages outside the client jar come from Mojang's asset index (like the entity names)
				try {
					collectTranslations(merged, downloadLanguage());
				} catch (Exception e) {
					logger.debug("CCTV: '{}' texts unavailable", lang, e);
				}
			}
			String suffix = "/lang/" + lang + ".json";
			for (PackSource pack : packs) {
				for (String file : pack.files()) {
					if (!file.startsWith("assets/") || !file.endsWith(suffix) || file.indexOf('/', 7) != file.length() - suffix.length()) {
						continue;
					}
					try {
						collectTranslations(merged, pack.read(file));
					} catch (IOException | RuntimeException e) {
						logger.debug("CCTV: skipping {} of {}", file, pack.name(), e);
					}
				}
			}
		}
		translations = Map.copyOf(merged);
	}

	private static void collectTranslations(Map<String, String> into, byte @Nullable [] lang) {
		if (lang == null) {
			return;
		}
		for (Map.Entry<String, JsonElement> entry : JsonParser.parseString(new String(lang, StandardCharsets.UTF_8)).getAsJsonObject().entrySet()) {
			for (String prefix : TRANSLATED) {
				if (entry.getKey().startsWith(prefix) && entry.getValue().isJsonPrimitive()) {
					into.put(entry.getKey(), entry.getValue().getAsString());
					break;
				}
			}
		}
	}

	private static void collectNames(Map<String, String> names, byte @Nullable [] lang) {
		if (lang == null) {
			return;
		}
		String prefix = "entity.minecraft.";
		for (Map.Entry<String, JsonElement> entry : JsonParser.parseString(new String(lang, StandardCharsets.UTF_8)).getAsJsonObject().entrySet()) {
			String key = entry.getKey();
			if (key.startsWith(prefix) && key.indexOf('.', prefix.length()) < 0 && entry.getValue().isJsonPrimitive()) {
				names.put(key.substring(prefix.length()), entry.getValue().getAsString());
			}
		}
	}

	/** Language files other than en_us are game assets outside the client jar (the asset index lists them). */
	private byte @Nullable [] downloadLanguage() throws Exception {
		Path cache = dir.resolve("lang-" + language + "-" + version + ".json");
		if (Files.isRegularFile(cache)) {
			return Files.readAllBytes(cache);
		}
		if (!download) {
			return null;
		}
		byte[] data = assetObject("minecraft/lang/" + language + ".json");
		if (data == null) {
			throw new IOException("Minecraft has no language '" + language + "'");
		}
		Files.write(cache, data);
		logger.info("CCTV: downloaded the '{}' language file from Mojang for entity names", language);
		return data;
	}

	private volatile @Nullable JsonObject assetIndex;

	/**
	 * The game's asset index of this version (the files outside the client jar: sounds, languages...), read
	 * from the cache or downloaded like the launcher does. Null when downloads are off and nothing is cached.
	 */
	synchronized @Nullable JsonObject assetIndex() throws Exception {
		if (assetIndex != null) {
			return assetIndex;
		}
		Path cache = dir.resolve("index-" + version + ".json");
		if (Files.isRegularFile(cache)) {
			try (Reader reader = Files.newBufferedReader(cache, StandardCharsets.UTF_8)) {
				assetIndex = JsonParser.parseReader(reader).getAsJsonObject().getAsJsonObject("objects");
				return assetIndex;
			} catch (RuntimeException e) {
				Files.deleteIfExists(cache);
			}
		}
		if (!download) {
			return null;
		}
		HttpClient http = httpClient();
		String indexUrl = getJson(http, versionUrl(http)).getAsJsonObject("assetIndex").get("url").getAsString();
		HttpResponse<String> response = http.send(HttpRequest.newBuilder(URI.create(indexUrl)).timeout(Duration.ofSeconds(60)).build(),
				HttpResponse.BodyHandlers.ofString());
		if (response.statusCode() != 200) {
			throw new IOException("HTTP " + response.statusCode() + " for the asset index");
		}
		JsonObject objects = JsonParser.parseString(response.body()).getAsJsonObject().getAsJsonObject("objects");
		Files.writeString(cache, response.body(), StandardCharsets.UTF_8);
		assetIndex = objects;
		return objects;
	}

	/**
	 * One file of the asset index (e.g. {@code minecraft/sounds/mob/zombie/say1.ogg}), from the object cache
	 * ({@code objects/<hh>/<hash>} like the launcher's) or downloaded from Mojang and checked. Null when the
	 * index does not list it or it cannot be had.
	 */
	byte @Nullable [] assetObject(String name) throws Exception {
		JsonObject index = assetIndex();
		JsonObject object = index == null ? null : index.getAsJsonObject(name);
		if (object == null) {
			return null;
		}
		String hash = object.get("hash").getAsString().toLowerCase(java.util.Locale.ROOT);
		if (!hash.matches("[0-9a-f]{40}")) {
			return null;
		}
		Path file = dir.resolve("objects").resolve(hash.substring(0, 2)).resolve(hash);
		if (Files.isRegularFile(file)) {
			return Files.readAllBytes(file);
		}
		if (!download) {
			return null;
		}
		HttpResponse<byte[]> response = httpClient().send(HttpRequest.newBuilder(URI.create(ASSET_OBJECTS + hash.substring(0, 2) + "/" + hash))
				.timeout(Duration.ofMinutes(2)).build(), HttpResponse.BodyHandlers.ofByteArray());
		if (response.statusCode() != 200) {
			throw new IOException("HTTP " + response.statusCode() + " for " + name);
		}
		byte[] data = response.body();
		if (!HexFormat.of().formatHex(MessageDigest.getInstance("SHA-1").digest(data)).equalsIgnoreCase(hash)) {
			throw new IOException("Checksum mismatch for " + name);
		}
		Files.createDirectories(file.getParent());
		Path part = file.resolveSibling(hash + ".part" + Thread.currentThread().threadId());
		Files.write(part, data);
		Files.move(part, file, StandardCopyOption.REPLACE_EXISTING);
		return data;
	}

	/** The contents of a file in every resource pack that has it (not the client jar), lowest priority first. */
	synchronized List<byte[]> readFromPacks(String name) {
		List<byte[]> found = new ArrayList<>();
		for (int i = 1; i < sources.size(); i++) {
			try {
				byte[] data = sources.get(i).read(name);
				if (data != null) {
					found.add(data);
				}
			} catch (IOException e) {
				// A broken pack entry is left out.
			}
		}
		return found;
	}

	/** The namespaces of the resource packs' assets (for their sounds.json), without the client jar. */
	synchronized List<String> packNamespaces() {
		java.util.TreeSet<String> namespaces = new java.util.TreeSet<>();
		for (int i = 1; i < sources.size(); i++) {
			for (String entry : sources.get(i).files()) {
				if (entry.startsWith("assets/") && entry.endsWith("/sounds.json") && entry.indexOf('/', 7) == entry.length() - "/sounds.json".length()) {
					namespaces.add(entry.substring(7, entry.length() - "/sounds.json".length()));
				}
			}
		}
		return new ArrayList<>(namespaces);
	}

	private static HttpClient httpClient() {
		return HttpClient.newBuilder()
				.connectTimeout(Duration.ofSeconds(15))
				.followRedirects(HttpClient.Redirect.NORMAL)
				.build();
	}

	/** The URL of this version's JSON in Mojang's version manifest. */
	private String versionUrl(HttpClient http) throws Exception {
		for (JsonElement element : getJson(http, MANIFEST).getAsJsonArray("versions")) {
			JsonObject entry = element.getAsJsonObject();
			if (entry.get("id").getAsString().equals(version)) {
				return entry.get("url").getAsString();
			}
		}
		throw new IOException("Version " + version + " not found in Mojang's version manifest");
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
		HttpClient http = httpClient();
		JsonObject client = getJson(http, versionUrl(http)).getAsJsonObject("downloads").getAsJsonObject("client");
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
	 * "animations": {id: mcmeta}, "colormaps": {name: base64 png}, "environment": {path: base64 png}
	 * (sun, moon, clouds), "particles": {id: particle definition}, "particleTextures": {id: base64 png},
	 * "equipment": {asset: layers}, "specialItems": {item id: special or composite item model}}.
	 * Later sources override earlier ones.
	 */
	private byte[] buildBundle() throws IOException {
		Map<String, JsonElement> blockstates = new LinkedHashMap<>();
		Map<String, JsonElement> models = new LinkedHashMap<>();
		Map<String, String> textures = new LinkedHashMap<>();
		Map<String, JsonElement> animations = new LinkedHashMap<>();
		Map<String, String> colormaps = new LinkedHashMap<>();
		Map<String, String> environment = new LinkedHashMap<>();
		Map<String, JsonElement> particles = new LinkedHashMap<>();
		Map<String, String> particleTextures = new LinkedHashMap<>();
		TreeSet<String> entityTextures = new TreeSet<>();
		Map<String, JsonElement> equipment = new LinkedHashMap<>();
		Map<String, JsonElement> specialItems = new LinkedHashMap<>();
		Map<String, String> itemModels = new LinkedHashMap<>();
		Map<String, JsonElement> itemDefinitions = new LinkedHashMap<>();

		List<PackSource> packs;
		synchronized (this) {
			packs = new ArrayList<>(sources);
		}

		for (PackSource zip : packs) {
			for (String name : zip.files()) {
				if (!name.startsWith("assets/")) {
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
						blockstates.put(namespace + ":" + strip(rest, "blockstates/", ".json"), parse(zip, name));
					} else if ((rest.startsWith("models/block/") || rest.startsWith("models/item/")) && rest.endsWith(".json")) {
						models.put(namespace + ":" + strip(rest, "models/", ".json"), parse(zip, name));
					} else if ((rest.startsWith("textures/block/") || rest.startsWith("textures/item/")) && rest.endsWith(".png")) {
						textures.put(namespace + ":" + strip(rest, "textures/", ".png"), base64(zip, name));
					} else if ((rest.startsWith("textures/block/") || rest.startsWith("textures/item/")) && rest.endsWith(".png.mcmeta")) {
						animations.put(namespace + ":" + strip(rest, "textures/", ".png.mcmeta"), parse(zip, name));
					} else if (namespace.equals("minecraft") && rest.startsWith("textures/colormap/") && rest.endsWith(".png")) {
						colormaps.put(strip(rest, "textures/colormap/", ".png"), base64(zip, name));
					} else if (namespace.equals("minecraft") && rest.startsWith("textures/environment/") && rest.endsWith(".png")) {
						environment.put(strip(rest, "textures/environment/", ".png"), base64(zip, name));
					} else if (rest.startsWith("items/") && rest.endsWith(".json")) {
						// Items drawn by a SpecialModelRenderer (chests, heads, banners...) or several models (beds)
						String id = namespace + ":" + strip(rest, "items/", ".json");
						JsonElement definition = parse(zip, name);
						if (definition.isJsonObject() && definition.getAsJsonObject().has("model")) {
							itemDefinitions.put(id, definition.getAsJsonObject().get("model"));
						}
						JsonElement special = findSpecial(definition, 0);
						if (special != null) {
							specialItems.put(id, special);
						} else {
							specialItems.remove(id);
						}
						// the model of the packs' own items (custom discs...): the viewer finds vanilla ones by name
						String model = namespace.equals("minecraft") ? null : plainModel(definition);
						if (model != null) {
							itemModels.put(id, model);
						}
					} else if (rest.startsWith("equipment/") && rest.endsWith(".json")) {
						equipment.put(namespace + ":" + strip(rest, "equipment/", ".json"), parse(zip, name));
					} else if (rest.startsWith("particles/") && rest.endsWith(".json")) {
						particles.put(namespace + ":" + strip(rest, "particles/", ".json"), parse(zip, name));
					} else if (rest.startsWith("textures/particle/") && rest.endsWith(".png")) {
						particleTextures.put(namespace + ":" + strip(rest, "textures/particle/", ".png"), base64(zip, name));
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
		root.add("particles", toObject(particles));
		// EquipmentClientInfo: the layers of armour, carpets, harnesses... by equipment asset
		root.add("equipment", toObject(equipment));
		JsonObject particleTextureObject = new JsonObject();
		particleTextures.forEach(particleTextureObject::addProperty);
		root.add("particleTextures", particleTextureObject);
		// Item definitions' "minecraft:special" ({"base", "model": {"type"...}, "transformation"}) and
		// "minecraft:composite" ({"models": [...]}) item models
		root.add("specialItems", toObject(specialItems));
		// item definitions of the packs' namespaces that are one "minecraft:model": {item model id: model id}
		JsonObject itemModelObject = new JsonObject();
		itemModels.forEach(itemModelObject::addProperty);
		root.add("itemModels", itemModelObject);
		// every item definition's model tree (ItemModel: model, composite, condition, select, range_dispatch...)
		root.add("items", toObject(itemDefinitions));

		JsonArray list = new JsonArray();
		entityTextures.forEach(list::add);
		entityList = list.toString();

		return root.toString().getBytes(StandardCharsets.UTF_8);
	}

	/**
	 * The first "minecraft:special" or "minecraft:composite" item model in an item definition (it may sit inside
	 * selects and conditions): the items that are not simply one model, like chests, heads, banners and beds.
	 */
	private static @Nullable JsonElement findSpecial(JsonElement element, int depth) {
		if (depth > 16) {
			return null;
		}
		if (element.isJsonObject()) {
			JsonObject object = element.getAsJsonObject();
			JsonElement type = object.get("type");
			if (type != null && type.isJsonPrimitive()) {
				String name = type.getAsString().replace("minecraft:", "");
				if (name.equals("special") || name.equals("composite")) {
					return object;
				}
			}
			for (Map.Entry<String, JsonElement> child : object.entrySet()) {
				JsonElement found = findSpecial(child.getValue(), depth + 1);
				if (found != null) {
					return found;
				}
			}
		} else if (element.isJsonArray()) {
			for (JsonElement child : element.getAsJsonArray()) {
				JsonElement found = findSpecial(child, depth + 1);
				if (found != null) {
					return found;
				}
			}
		}
		return null;
	}

	/** The model of an item definition that is a plain {@code "minecraft:model"}, else null. */
	private static @Nullable String plainModel(JsonElement definition) {
		if (!definition.isJsonObject() || !definition.getAsJsonObject().has("model")) {
			return null;
		}
		JsonElement model = definition.getAsJsonObject().get("model");
		if (!model.isJsonObject()) {
			return null;
		}
		JsonObject object = model.getAsJsonObject();
		JsonElement type = object.get("type");
		JsonElement id = object.get("model");
		if (type == null || !type.isJsonPrimitive() || !type.getAsString().replace("minecraft:", "").equals("model")
				|| id == null || !id.isJsonPrimitive()) {
			return null;
		}
		return id.getAsString().contains(":") ? id.getAsString() : "minecraft:" + id.getAsString();
	}

	private static JsonObject toObject(Map<String, JsonElement> map) {
		JsonObject object = new JsonObject();
		map.forEach(object::add);
		return object;
	}

	private static String strip(String path, String prefix, String suffix) {
		return path.substring(prefix.length(), path.length() - suffix.length());
	}

	private static JsonElement parse(PackSource pack, String file) throws IOException {
		byte[] data = pack.read(file);
		if (data == null) {
			throw new IOException("missing " + file);
		}
		return JsonParser.parseString(new String(data, StandardCharsets.UTF_8));
	}

	private static String base64(PackSource pack, String file) throws IOException {
		byte[] data = pack.read(file);
		if (data == null) {
			throw new IOException("missing " + file);
		}
		return Base64.getEncoder().encodeToString(data);
	}

	/** Vanilla clients refuse server packs above 250 MiB (DownloadQueue / ServerPackManager). */
	private static final long MAX_SERVER_PACK = 250L * 1024 * 1024;

	/**
	 * The server resource pack, like the client's DownloadedPackSource: downloaded once per hash into
	 * {@code config/cctv/assets/server-packs} (checked against the hash when server.properties has one), the
	 * cached copy when the download fails. Null when there is none.
	 */
	private @Nullable Path serverPack() {
		String url = serverPackUrl;
		if (url == null || url.isBlank()) {
			return null;
		}
		String sha1 = serverPackSha1 == null ? "" : serverPackSha1.trim().toLowerCase(java.util.Locale.ROOT);
		boolean hashed = sha1.matches("[0-9a-f]{40}");
		try {
			URI uri = URI.create(url.trim());
			if (!"https".equalsIgnoreCase(uri.getScheme()) && !"http".equalsIgnoreCase(uri.getScheme())) {
				logger.warn("CCTV: the server resource pack URL is not http(s): {}", url);
				return null;
			}
			Path packs = dir.resolve("server-packs");
			Files.createDirectories(packs);
			String key = hashed ? sha1
					: HexFormat.of().formatHex(MessageDigest.getInstance("SHA-1").digest(url.getBytes(StandardCharsets.UTF_8)));
			Path file = packs.resolve(key + ".zip");
			if (hashed && Files.isRegularFile(file)) {
				return file;
			}
			if (!download) {
				return Files.isRegularFile(file) ? file : null;
			}
			try {
				Path part = packs.resolve(key + ".zip.part");
				HttpResponse<InputStream> response = httpClient().send(HttpRequest.newBuilder(uri).timeout(Duration.ofMinutes(5))
						.header("User-Agent", "CCTV-Fabric (server resource pack)").build(), HttpResponse.BodyHandlers.ofInputStream());
				if (response.statusCode() != 200) {
					response.body().close();
					throw new IOException("HTTP " + response.statusCode());
				}
				MessageDigest digest = MessageDigest.getInstance("SHA-1");
				long size = 0;
				try (InputStream in = response.body(); var out = Files.newOutputStream(part)) {
					byte[] buffer = new byte[65536];
					int read;
					while ((read = in.read(buffer)) > 0) {
						size += read;
						if (size > MAX_SERVER_PACK) {
							throw new IOException("larger than 250 MiB");
						}
						digest.update(buffer, 0, read);
						out.write(buffer, 0, read);
					}
				}
				String actual = HexFormat.of().formatHex(digest.digest());
				if (hashed && !actual.equals(sha1)) {
					Files.deleteIfExists(part);
					throw new IOException("its SHA-1 is " + actual + ", server.properties says " + sha1);
				}
				Files.move(part, file, StandardCopyOption.REPLACE_EXISTING);
				logger.info("CCTV: downloaded the server resource pack ({} KB)", size / 1024);
			} catch (Exception e) {
				logger.warn("CCTV: the server resource pack could not be downloaded from {}: {}", url, e.toString());
			}
			return Files.isRegularFile(file) ? file : null;
		} catch (Exception e) {
			logger.warn("CCTV: the server resource pack is not used: {}", e.toString());
			return null;
		}
	}
}
