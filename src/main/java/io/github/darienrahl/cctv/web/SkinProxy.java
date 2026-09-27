package io.github.darienrahl.cctv.web;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.slf4j.Logger;

/**
 * Fetches player skins from Mojang on behalf of the browser (same origin, so
 * WebGL can use them) and caches them. Offline-mode players are looked up by name.
 */
final class SkinProxy {
	record Skin(byte[] png, boolean slim, long fetchedAt) {
		boolean missing() {
			return png == null;
		}
	}

	private static final long TTL_MS = 60 * 60 * 1000L;
	private static final long MISSING_TTL_MS = 10 * 60 * 1000L;
	private static final Pattern UUID_HEX = Pattern.compile("^[0-9a-fA-F]{32}$");
	private static final Pattern NAME = Pattern.compile("^[A-Za-z0-9_]{1,16}$");
	private static final Pattern TEXTURES_VALUE = Pattern.compile("\"name\"\\s*:\\s*\"textures\"\\s*,\\s*\"value\"\\s*:\\s*\"([^\"]+)\"");
	private static final Pattern SKIN_URL = Pattern.compile("\"SKIN\"\\s*:\\s*\\{\\s*\"url\"\\s*:\\s*\"([^\"]+)\"");
	private static final Pattern SLIM = Pattern.compile("\"model\"\\s*:\\s*\"slim\"");
	private static final Pattern PROFILE_ID = Pattern.compile("\"id\"\\s*:\\s*\"([0-9a-fA-F]{32})\"");

	private final Map<String, Skin> cache = new ConcurrentHashMap<>();
	private final HttpClient http = HttpClient.newBuilder()
			.connectTimeout(Duration.ofSeconds(5))
			.followRedirects(HttpClient.Redirect.NORMAL)
			.build();
	private final Logger logger;

	SkinProxy(Logger logger) {
		this.logger = logger;
	}

	/**
	 * @param uuid player UUID (with or without dashes), may be null
	 * @param name player name, used when the UUID is not a Mojang one
	 */
	Skin get(String uuid, String name) {
		String id = uuid == null ? "" : uuid.replace("-", "").toLowerCase();
		if (!UUID_HEX.matcher(id).matches()) {
			id = "";
		}
		if (name != null && !NAME.matcher(name).matches()) {
			name = null;
		}

		String key = !id.isEmpty() ? id : (name != null ? "name:" + name.toLowerCase() : null);
		if (key == null) {
			return new Skin(null, false, System.currentTimeMillis());
		}

		Skin cached = cache.get(key);
		long now = System.currentTimeMillis();
		if (cached != null && now - cached.fetchedAt() < (cached.missing() ? MISSING_TTL_MS : TTL_MS)) {
			return cached;
		}

		Skin skin = fetch(id, name);
		if (cache.size() > 512) {
			cache.clear();
		}
		cache.put(key, skin);
		return skin;
	}

	private Skin fetch(String id, String name) {
		long now = System.currentTimeMillis();

		try {
			// Version 4 UUIDs are Mojang accounts. Anything else (offline mode) is resolved by name.
			boolean mojangUuid = !id.isEmpty() && id.charAt(12) == '4';

			if (!mojangUuid && name != null) {
				String profile = getString("https://api.mojang.com/users/profiles/minecraft/" + name);
				Matcher m = profile == null ? null : PROFILE_ID.matcher(profile);
				id = m != null && m.find() ? m.group(1) : "";
			}

			if (id.isEmpty()) {
				return new Skin(null, false, now);
			}

			String session = getString("https://sessionserver.mojang.com/session/minecraft/profile/" + id);
			Matcher value = session == null ? null : TEXTURES_VALUE.matcher(session);
			if (value == null || !value.find()) {
				return new Skin(null, false, now);
			}

			String textures = new String(Base64.getDecoder().decode(value.group(1)), StandardCharsets.UTF_8);
			Matcher url = SKIN_URL.matcher(textures);
			if (!url.find()) {
				return new Skin(null, false, now);
			}

			String skinUrl = url.group(1).replace("http://", "https://");
			if (!skinUrl.startsWith("https://textures.minecraft.net/")) {
				return new Skin(null, false, now);
			}

			HttpResponse<byte[]> png = http.send(request(skinUrl), HttpResponse.BodyHandlers.ofByteArray());
			if (png.statusCode() != 200 || png.body().length > 64 * 1024) {
				return new Skin(null, false, now);
			}

			return new Skin(png.body(), SLIM.matcher(textures).find(), now);
		} catch (Exception e) {
			logger.debug("Could not fetch skin for {} / {}", id, name, e);
			return new Skin(null, false, now);
		}
	}

	private String getString(String url) throws Exception {
		HttpResponse<String> response = http.send(request(url), HttpResponse.BodyHandlers.ofString());
		return response.statusCode() == 200 ? response.body() : null;
	}

	private static HttpRequest request(String url) {
		return HttpRequest.newBuilder(URI.create(url))
				.timeout(Duration.ofSeconds(8))
				.header("User-Agent", "cctv-fabric-mod")
				.GET()
				.build();
	}
}
