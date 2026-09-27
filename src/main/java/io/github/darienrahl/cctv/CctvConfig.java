package io.github.darienrahl.cctv;

import java.io.IOException;
import java.io.Reader;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

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
	public int defaultRange = 64;
	/** Upper limit for {@code /cctv range}. */
	public int maxRange = 160;

	/** Entity positions are sent every N ticks (1 = 20 times per second). */
	public int entityUpdateTicks = 1;
	/** How many 16x16x16 sections a camera may read from the world per tick while loading. */
	public int sectionsPerTick = 48;
	/** A full re-scan of a watched camera's area is spread over this many seconds (safety net for missed block updates). */
	public int rescanSeconds = 5;

	/**
	 * Download the official client jar of this Minecraft version from Mojang (once, ~30 MB, cached in
	 * config/cctv/assets) so the viewer can draw real block textures and models. The file is never sent
	 * to players. When false, put a client jar there yourself or the viewer uses plain colours.
	 */
	public boolean downloadClientAssets = true;

	/** Compress the live stream with gzip when the browser supports it. */
	public boolean gzip = true;
	/** Serve player skins (fetched from Mojang by the server and cached). */
	public boolean skins = true;
	/** Spawn a small observer-block marker where a camera is placed (vanilla block_display, no client mod needed). */
	public boolean markers = true;
	/** Maximum number of browser connections per camera. */
	public int maxViewersPerCamera = 16;
	/** A viewer that falls this many messages behind is disconnected (it reconnects automatically). */
	public int maxQueuedMessages = 20000;

	public static CctvConfig load(Path file, Logger logger) {
		CctvConfig config = new CctvConfig();

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

		config.sanitize();
		config.save(file, logger);
		return config;
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
		port = clamp(port, 1, 65535);
		defaultFov = Math.max(10, Math.min(140, defaultFov));
		maxRange = clamp(maxRange, 16, 512);
		defaultRange = clamp(defaultRange, 16, maxRange);
		entityUpdateTicks = clamp(entityUpdateTicks, 1, 20);
		sectionsPerTick = clamp(sectionsPerTick, 1, 1024);
		rescanSeconds = clamp(rescanSeconds, 1, 600);
		maxViewersPerCamera = clamp(maxViewersPerCamera, 1, 1000);
		maxQueuedMessages = clamp(maxQueuedMessages, 1000, 1_000_000);
	}

	private static int clamp(int value, int min, int max) {
		return Math.max(min, Math.min(max, value));
	}
}
