package io.github.darienrahl.cctv.assets;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Pattern;
import java.util.zip.GZIPOutputStream;

import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/**
 * The game's sounds for the viewer, like the client's SoundManager has them: the sound events of
 * {@code sounds.json} (the game's, from the asset index, with the resource packs' merged over it the way
 * {@code "replace"} says) and the {@code .ogg} files, from resource packs or the asset index (downloaded from
 * Mojang once and cached like the launcher does). Nothing is fetched until a viewer turns sounds on.
 */
public final class GameSounds {
	private static final Pattern PATH = Pattern.compile("^[a-z0-9_.-]{1,64}/[a-z0-9_./-]{1,160}$");

	private final ClientAssets assets;
	private final Logger logger;
	private volatile byte @Nullable [] soundsJson;
	private volatile String etag = "";

	public GameSounds(ClientAssets assets, Logger logger) {
		this.assets = assets;
		this.logger = logger;
	}

	/** Gzip-compressed merged sounds.json: {@code {"minecraft:entity.cow.ambient": {"sounds": [...]}, ...}}, or null. */
	public synchronized byte @Nullable [] soundsJson() {
		if (soundsJson != null) {
			return soundsJson;
		}
		if (assets.state() != ClientAssets.State.READY) {
			return null;
		}
		try {
			Map<String, JsonObject> events = new TreeMap<>();
			try {
				byte[] vanilla = assets.assetObject("minecraft/sounds.json");
				if (vanilla != null) {
					merge(events, "minecraft", vanilla);
				}
			} catch (Exception e) {
				logger.warn("CCTV: the game's sound list could not be downloaded from Mojang: {}", e.toString());
			}
			for (String namespace : assets.packNamespaces()) {
				for (byte[] pack : assets.readFromPacks("assets/" + namespace + "/sounds.json")) {
					merge(events, namespace, pack);
				}
			}
			if (events.isEmpty()) {
				return null;
			}
			JsonObject root = new JsonObject();
			events.forEach(root::add);
			byte[] json = root.toString().getBytes(StandardCharsets.UTF_8);
			ByteArrayOutputStream out = new ByteArrayOutputStream(json.length / 4);
			try (GZIPOutputStream gzip = new GZIPOutputStream(out)) {
				gzip.write(json);
			}
			soundsJson = out.toByteArray();
			etag = "\"" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-1").digest(soundsJson)).substring(0, 16) + "\"";
			logger.info("CCTV: {} sound events ready for the viewer", events.size());
			return soundsJson;
		} catch (Exception e) {
			logger.warn("CCTV: the game's sounds are not available: {}", e.toString());
			return null;
		}
	}

	public String etag() {
		return etag;
	}

	/**
	 * SoundManager's merge of one sounds.json: an event with {@code "replace": true} drops what earlier files
	 * gave it, otherwise its sounds are added. Sound names without a namespace belong to the file's.
	 */
	private static void merge(Map<String, JsonObject> events, String namespace, byte[] data) {
		JsonObject file = JsonParser.parseString(new String(data, StandardCharsets.UTF_8)).getAsJsonObject();
		for (Map.Entry<String, JsonElement> entry : file.entrySet()) {
			if (!entry.getValue().isJsonObject()) {
				continue;
			}
			String id = entry.getKey().contains(":") ? entry.getKey() : namespace + ":" + entry.getKey();
			JsonObject event = entry.getValue().getAsJsonObject();
			JsonObject target = events.get(id);
			boolean replace = event.has("replace") && event.get("replace").getAsBoolean();
			if (target == null || replace) {
				target = new JsonObject();
				target.add("sounds", new JsonArray());
				events.put(id, target);
			}
			if (event.has("subtitle")) {
				target.add("subtitle", event.get("subtitle"));
			}
			if (event.has("sounds") && event.get("sounds").isJsonArray()) {
				for (JsonElement sound : event.getAsJsonArray("sounds")) {
					target.getAsJsonArray("sounds").add(qualify(sound, namespace));
				}
			}
		}
	}

	private static JsonElement qualify(JsonElement sound, String namespace) {
		if (sound.isJsonPrimitive()) {
			String name = sound.getAsString();
			return new com.google.gson.JsonPrimitive(name.contains(":") ? name : namespace + ":" + name);
		}
		if (sound.isJsonObject()) {
			JsonObject copy = sound.getAsJsonObject().deepCopy();
			String name = copy.has("name") ? copy.get("name").getAsString() : "";
			if (!name.contains(":")) {
				copy.addProperty("name", namespace + ":" + name);
			}
			return copy;
		}
		return sound;
	}

	/**
	 * One sound file, {@code namespace/path} as in sounds.json (e.g. {@code minecraft/mob/zombie/say1}):
	 * from a resource pack, else the game's asset. Null when there is no such sound.
	 */
	public byte @Nullable [] sound(String path) {
		if (!PATH.matcher(path).matches() || path.contains("..") || assets.state() != ClientAssets.State.READY) {
			return null;
		}
		int slash = path.indexOf('/');
		String namespace = path.substring(0, slash);
		String file = path.substring(slash + 1);
		var fromPacks = assets.readFromPacks("assets/" + namespace + "/sounds/" + file + ".ogg");
		if (!fromPacks.isEmpty()) {
			return fromPacks.get(fromPacks.size() - 1);
		}
		if (!namespace.equals("minecraft")) {
			return null;
		}
		try {
			return assets.assetObject("minecraft/sounds/" + file + ".ogg");
		} catch (Exception e) {
			logger.debug("CCTV: sound {} unavailable", path, e);
			return null;
		}
	}
}
