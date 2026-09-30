package io.github.darienrahl.cctv.assets;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Locale;
import java.util.Map;
import java.util.zip.GZIPOutputStream;

import org.jspecify.annotations.Nullable;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import io.github.darienrahl.cctv.web.Json;

/**
 * What the viewer's music needs beyond sounds.json ({@code /assets/music.json}): the titles the Now Playing
 * toast shows (the game's {@code music.*} texts, keyed like MusicManager.getCurrentMusicTranslationKey, and the
 * song names of The Immersive Music Mod's songs.json) and, when that mod (TIMM) is installed, its biome
 * playlists and settings, read like the mod reads them: {@code config/timm/} first, then the mod's own files.
 */
public final class ModMusic {
	private static final String TIMM = "timm";

	private final ClientAssets assets;
	private final Path config;
	private volatile byte @Nullable [] json;
	private volatile String etag = "";

	/** configDir: the server's config directory, where TIMM keeps {@code timm/}. */
	public ModMusic(ClientAssets assets, Path configDir) {
		this.assets = assets;
		this.config = configDir.resolve(TIMM);
	}

	/** The gzip-compressed JSON (built once the assets are ready), or null while they load. */
	public synchronized byte @Nullable [] json() {
		if (json == null && assets.state() == ClientAssets.State.READY && assets.textsReady()) {
			byte[] built = build().getBytes(StandardCharsets.UTF_8);
			ByteArrayOutputStream out = new ByteArrayOutputStream(built.length / 4);
			try (GZIPOutputStream gzip = new GZIPOutputStream(out)) {
				gzip.write(built);
			} catch (IOException e) {
				throw new UncheckedIOException(e);
			}
			etag = "\"music-" + Integer.toHexString(Arrays.hashCode(built)) + "\"";
			json = out.toByteArray();
		}
		return json;
	}

	public String etag() {
		return etag;
	}

	private String build() {
		Json out = new Json(16384);
		out.beginObject().name("names").beginObject();
		for (Map.Entry<String, String> entry : assets.translations("music.").entrySet()) {
			out.field(entry.getKey(), entry.getValue());
		}
		JsonObject songs = timmFile("songs.json");
		if (songs != null) {
			// NowPlayingToastMixin: TIMM's songs are named by their sound file, "timm:music/idle" -> "timm.music.idle"
			for (Map.Entry<String, JsonElement> entry : songs.entrySet()) {
				if (entry.getValue().isJsonObject() && entry.getValue().getAsJsonObject().has("name")) {
					out.field(languageKey(entry.getKey()), entry.getValue().getAsJsonObject().get("name").getAsString());
				}
			}
		}
		out.endObject();

		JsonObject biomes = timmFile("biome_playlists.json");
		if (biomes != null) {
			JsonObject general = timmFile(config, "general.json");
			out.name("timm").beginObject();
			out.name("biomes").raw(biomes.toString());
			// GeneralConfig's defaults when the server has no config/timm/general.json
			out.field("minDelay", intOf(general, "minDelay", 120))
					.field("maxDelay", intOf(general, "maxDelay", 300))
					.field("fading", boolOf(general, "enableMusicFading", true))
					.field("fadeDelay", intOf(general, "fadeDelay", 3))
					.field("fadeDuration", Math.max(1, intOf(general, "fadeDuration", 5)))
					.field("resetDelay", boolOf(general, "resetDelayOnBiomeSwitch", false))
					.field("structures", boolOf(general, "enableStructureMusic", true))
					.field("structureFadeOut", general != null && general.has("structureFadeOut")
							? general.get("structureFadeOut").getAsString().toLowerCase(Locale.ROOT) : "never");
			out.endObject();
		}
		return out.endObject().toString();
	}

	/** Identifier.toShortLanguageKey with '/' as '.', as NowPlayingToast turns a sound file into a text key. */
	static String languageKey(String location) {
		int colon = location.indexOf(':');
		String namespace = colon < 0 ? "minecraft" : location.substring(0, colon);
		String path = colon < 0 ? location : location.substring(colon + 1);
		return (namespace.equals("minecraft") ? path : namespace + "." + path).replace('/', '.');
	}

	/** One of TIMM's playlist files: the server's config/timm/ copy, else the one in the mod's assets. */
	private @Nullable JsonObject timmFile(String name) {
		JsonObject own = timmFile(config, name);
		if (own != null) {
			return own;
		}
		try {
			byte[] bundled = assets.resource("assets/timm/custom/" + name);
			return bundled == null ? null : JsonParser.parseString(new String(bundled, StandardCharsets.UTF_8)).getAsJsonObject();
		} catch (RuntimeException e) {
			return null;
		}
	}

	/** A JSON file of config/timm/ (general.json is AutoConfig's partitioned settings file), null when there is none. */
	private static @Nullable JsonObject timmFile(Path dir, String name) {
		Path file = dir.resolve(name);
		try {
			return Files.isRegularFile(file) ? JsonParser.parseString(Files.readString(file)).getAsJsonObject() : null;
		} catch (IOException | RuntimeException e) {
			return null;
		}
	}

	private static int intOf(@Nullable JsonObject object, String key, int fallback) {
		try {
			return object != null && object.has(key) ? object.get(key).getAsInt() : fallback;
		} catch (RuntimeException e) {
			return fallback;
		}
	}

	private static boolean boolOf(@Nullable JsonObject object, String key, boolean fallback) {
		try {
			return object != null && object.has(key) ? object.get(key).getAsBoolean() : fallback;
		} catch (RuntimeException e) {
			return fallback;
		}
	}
}
