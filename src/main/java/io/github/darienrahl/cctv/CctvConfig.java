package io.github.darienrahl.cctv;

import java.io.IOException;
import java.io.Reader;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonParseException;
import org.slf4j.Logger;

/**
 * Settings stored in {@code config/cctv/config.json}. Missing keys fall back to
 * the defaults below and the file is rewritten so new options show up.
 */
public final class CctvConfig {
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();

	/** Address the built-in web server binds to. {@code 0.0.0.0} = all interfaces. */
	public String bindAddress = "0.0.0.0";
	/** Port of the built-in web server. */
	public int port = 8100;
	/** If not empty, the web page and API require {@code ?token=...} (remembered in a cookie). */
	public String accessToken = "";
	/** Base URL printed in chat, e.g. {@code http://play.example.com:8100}. Empty = guess from server IP. */
	public String publicUrl = "";

	/** Vertical field of view for new cameras, in degrees. */
	public double defaultFov = 70;
	/** How far (in blocks) new cameras see. */
	public int defaultRange = 96;
	/** Upper limit for {@code /cctv range}. */
	public int maxRange = 512;
	/**
	 * Show terrain beyond the loaded chunks by reading the saved world (region files) - like the Bobby client mod,
	 * but on the server. Chunks are never loaded for this; they show the state they were saved in.
	 */
	public boolean farTerrain = true;
	/** Entities (players, mobs) are shown up to this distance from the camera. */
	public int entityRange = 128;

	/** Entity positions are sent every N ticks (1 = 20 times per second). */
	public int entityUpdateTicks = 1;
	/** How many 16x16x16 sections a camera may copy from the world per tick while loading (decoding happens off the server thread). */
	public int sectionsPerTick = 96;
	/** Background threads that decode world data and read saved chunks (never the server thread). */
	public int workerThreads = Math.max(1, Math.min(4, Runtime.getRuntime().availableProcessors() / 2));
	/** A full re-scan of a watched camera's area is spread over this many seconds (safety net for missed block updates). */
	public int rescanSeconds = 5;

	/**
	 * Download the official client jar of this Minecraft version from Mojang (once, ~30 MB, cached in
	 * config/cctv/assets) so the viewer can draw real block textures and models. The file is never sent
	 * to players. When false, put a client jar there yourself or the viewer uses plain colours.
	 */
	public boolean downloadClientAssets = true;
	/**
	 * Language of entity names in the viewer (mob labels), a Minecraft language code such as {@code en_us},
	 * {@code pl_pl} or {@code de_de}. Languages other than English are downloaded from Mojang once (like the
	 * game launcher does) or taken from a resource pack in config/cctv/resourcepacks.
	 */
	public String language = "en_us";
	/**
	 * Use the world's own packs like the game does for players: the assets of the data packs in
	 * {@code <world>/datapacks} and the world's {@code resources.zip}, so custom paintings, music discs, sounds
	 * and items show up in the viewer. They sit under the packs in config/cctv/resourcepacks.
	 */
	public boolean worldResourcePacks = true;
	/**
	 * Download the server resource pack of server.properties ({@code resource-pack}, checked against
	 * {@code resource-pack-sha1}) once and use it too, between the world's packs and config/cctv/resourcepacks.
	 */
	public boolean serverResourcePack = true;
	/**
	 * Use the assets of the server's mods (sounds, textures, texts) like the client's mod resource packs, e.g. the
	 * songs of The Immersive Music Mod; their music plays in the viewer the way those mods play it.
	 */
	public boolean modAssets = true;

	/** Compress the live stream with gzip when the browser supports it. */
	public boolean gzip = true;
	/** Serve player skins (fetched from Mojang by the server and cached). */
	public boolean skins = true;
	/**
	 * Let viewers hear the game's sounds (the sounds the server sends players near the camera). The sound files
	 * are downloaded from Mojang when first played and cached in config/cctv/assets/objects, like the launcher.
	 */
	public boolean sounds = true;
	/**
	 * Show the Record and Timelapse buttons: viewers record the camera's picture (with its sounds when they are on)
	 * or a timelapse of it into a video file in their own browser. Nothing is recorded on the server.
	 */
	public boolean recording = true;
	/** Spawn a small observer-block marker where a camera is placed (vanilla block_display, no client mod needed). */
	public boolean markers = true;
	/** Maximum number of browser connections per camera. */
	public int maxViewersPerCamera = 16;
	/** A viewer that falls this many messages behind is disconnected (it reconnects automatically). */
	public int maxQueuedMessages = 20000;

	/** How the viewer page looks for everybody who opens it. Reload with {@code /cctv reload}. */
	public volatile ViewerDefaults viewer = new ViewerDefaults();

	/** Version of this file's layout, used to update old defaults. */
	public int configVersion;
	private static final int CURRENT_VERSION = 2;

	/** Default viewer settings. Every visitor can change them for themselves unless {@link #lockSettings} is set. */
	public static final class ViewerDefaults {
		/** Graphics: "vanilla" (like the game) or "shaders" (shadows, reflections, bloom...). */
		public String graphics = "vanilla";
		/** Shader quality when graphics is "shaders": "low", "medium", "high" or "ultra". */
		public String shaderQuality = "medium";
		/**
		 * Post-processing shader: a file name (without .glsl) from config/cctv/shaders, one of the viewer's own
		 * effects ("builtin:cinematic", "builtin:fisheye", see effects.js) or empty for none.
		 */
		public String postShader = "";
		/** Sky box per dimension, e.g. {"minecraft:overworld": "sunset"}: a folder or image in config/cctv/skyboxes. */
		public Map<String, String> skyboxes = new LinkedHashMap<>();
		/** Clouds: "fancy", "fast" or "off". */
		public String clouds = "fancy";
		/** Player names above heads. */
		public boolean labels = true;
		/** Names above all mobs (only when they are visible from the camera). */
		public boolean mobLabels = false;
		/** Particles of blocks and fluids (torch flames, campfire smoke, falling leaves, drips). */
		public boolean particles = true;
		/** Picture mode: "color", "mono" or "night". */
		public String mode = "color";
		/** CCTV look (scan lines, vignette). */
		public boolean cctvEffect = false;
		/**
		 * How the terrain fades out in the distance: "vanilla" (the game's fog), "smooth" (a longer, softer fade),
		 * "atmospheric" (plus haze that grows with distance) or "minimal" (only at the edge of the camera's range).
		 */
		public String fog = "vanilla";
		/** The viewers' field of view in degrees (30 to 110, like the game's option); 0 for each camera's own. */
		public int fov = 0;
		/** Options > Biome Blend: how far biome colours of grass, leaves and water blend, 0 (off) to 7 blocks. */
		public int biomeBlend = 2;
		/**
		 * Background music once a viewer turns sounds on, like the game's Music Frequency option: "off", "default"
		 * (a song every 10 to 20 minutes), "frequent" (up to 10 minutes apart) or "constant".
		 */
		public String music = "default";
		/** The Now Playing toast when a song starts, like the game's Music Toast option: "on" or "off". */
		public String musicToast = "on";
		/** Visitors cannot change the settings above. */
		public boolean lockSettings = false;
	}

	public static CctvConfig load(Path file, Logger logger) {
		CctvConfig config = new CctvConfig();
		config.configVersion = CURRENT_VERSION;

		if (Files.exists(file)) {
			try (Reader reader = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
				CctvConfig loaded = GSON.fromJson(reader, CctvConfig.class);
				if (loaded != null) {
					config = loaded;
				}
			} catch (IOException | JsonParseException e) {
				logger.error("Could not read {}, using defaults", file, e);
			}
		}

		config.migrate();
		config.sanitize();
		config.save(file, logger);
		return config;
	}

	/** Re-reads only the viewer defaults (safe while running). */
	public void reloadViewer(Path file, Logger logger) throws IOException {
		try (Reader reader = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
			CctvConfig loaded = GSON.fromJson(reader, CctvConfig.class);
			if (loaded != null && loaded.viewer != null) {
				viewer = loaded.viewer;
				sanitize();
			}
		} catch (JsonParseException e) {
			throw new IOException(e.getMessage(), e);
		}
	}

	/** Raises limits that were defaults in older versions (only when they were left untouched). */
	private void migrate() {
		if (configVersion < 2) {
			if (maxRange == 160) {
				maxRange = 512;
			}
			if (defaultRange == 64) {
				defaultRange = 96;
			}
			if (sectionsPerTick == 48) {
				sectionsPerTick = 96;
			}
		}
		configVersion = CURRENT_VERSION;
	}

	public void save(Path file, Logger logger) {
		try {
			Files.createDirectories(file.getParent());
			try (Writer writer = Files.newBufferedWriter(file, StandardCharsets.UTF_8)) {
				GSON.toJson(this, writer);
			}
		} catch (IOException e) {
			logger.error("Could not write {}", file, e);
		}
	}

	private void sanitize() {
		if (bindAddress == null || bindAddress.isBlank()) {
			bindAddress = "0.0.0.0";
		}
		if (accessToken == null) {
			accessToken = "";
		}
		if (publicUrl == null) {
			publicUrl = "";
		}
		if (viewer == null) {
			viewer = new ViewerDefaults();
		}
		if (viewer.skyboxes == null) {
			viewer.skyboxes = new LinkedHashMap<>();
		}
		viewer.graphics = oneOf(viewer.graphics, "vanilla", "vanilla", "shaders");
		viewer.shaderQuality = oneOf(viewer.shaderQuality, "medium", "low", "medium", "high", "ultra");
		viewer.clouds = oneOf(viewer.clouds, "fancy", "fancy", "fast", "off");
		viewer.mode = oneOf(viewer.mode, "color", "color", "mono", "night");
		viewer.fog = oneOf(viewer.fog, "vanilla", "vanilla", "smooth", "atmospheric", "minimal");
		viewer.fov = viewer.fov == 0 ? 0 : clamp(viewer.fov, 30, 110);
		viewer.biomeBlend = clamp(viewer.biomeBlend, 0, 7);
		viewer.music = oneOf(viewer.music, "default", "off", "default", "frequent", "constant");
		viewer.musicToast = oneOf(viewer.musicToast, "on", "on", "off");
		if (viewer.postShader == null || !viewer.postShader.matches("(builtin:)?[A-Za-z0-9_-]{0,64}")) {
			viewer.postShader = "";
		}
		if (language == null || !language.matches("[a-z]{2,3}_[a-z0-9]{2,4}")) {
			language = "en_us";
		}
		port = clamp(port, 1, 65535);
		defaultFov = Math.max(10, Math.min(140, defaultFov));
		maxRange = clamp(maxRange, 16, 1024);
		entityRange = clamp(entityRange, 16, 512);
		workerThreads = clamp(workerThreads, 1, 32);
		defaultRange = clamp(defaultRange, 16, maxRange);
		entityUpdateTicks = clamp(entityUpdateTicks, 1, 20);
		sectionsPerTick = clamp(sectionsPerTick, 1, 1024);
		rescanSeconds = clamp(rescanSeconds, 1, 600);
		maxViewersPerCamera = clamp(maxViewersPerCamera, 1, 1000);
		maxQueuedMessages = clamp(maxQueuedMessages, 1000, 1_000_000);
	}

	private static String oneOf(String value, String fallback, String... allowed) {
		for (String option : allowed) {
			if (option.equals(value)) {
				return value;
			}
		}
		return fallback;
	}

	private static int clamp(int value, int min, int max) {
		return Math.max(min, Math.min(max, value));
	}
}
