package io.github.darienrahl.cctv.web;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;

import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;

import io.github.darienrahl.cctv.CctvConfig;
import io.github.darienrahl.cctv.assets.ClientAssets;
import io.github.darienrahl.cctv.assets.GameSounds;
import io.github.darienrahl.cctv.assets.ModMusic;
import io.github.darienrahl.cctv.assets.WebFont;

/**
 * Small HTTP server built on the JDK's {@code com.sun.net.httpserver}.
 *
 * <pre>
 * GET /                          camera list (web page)
 * GET /cam/{name}                live viewer (web page)
 * GET /static/{file}             viewer assets
 * GET /api/cameras               camera list (JSON)
 * GET /api/cameras/{name}/stream live stream (Server-Sent Events)
 * GET /skin/{uuid}?name={player} player skin PNG
 * GET /cape/{uuid}?name={player} player cape PNG (404 without a cape)
 * GET /api/viewer                viewer defaults, custom sky boxes and shaders
 * GET /custom/{skyboxes|shaders}/... custom files from config/cctv
 * GET /assets/bundle.json        block states, models and textures (from the client jar)
 * GET /assets/models.json        entity model geometry and keyframe animations (from the client jar)
 * GET /assets/names.json         entity names in the configured language
 * GET /assets/entities.json      list of entity textures
 * GET /assets/entity/{path}.png  one entity texture
 * GET /assets/entity/{path}.png.mcmeta  its metadata ({} when it has none), e.g. a villager type's hat
 * GET /assets/misc/{path}.png    one texture of textures/misc (entity shadow, enchantment glint)
 * GET /assets/font/{path}         the game's font (definitions .json, glyph sheets .png)
 * GET /assets/font/minecraft[-bold].ttf the game's font as a web font for the pages (built from the sheets)
 * GET /assets/sounds.json         the game's sound events (sounds.json merged with resource packs)
 * GET /assets/sound/{ns}/{path}.ogg one sound file (resource packs, else the game's asset, cached)
 * GET /assets/music.json         song titles for the Now Playing toast, The Immersive Music Mod's playlists
 * GET /assets/gui/{path}.png[.mcmeta] one GUI sprite (the Now Playing toast's background and notes)
 * GET /assets/{trims|palettes|map}/{path}.png[.mcmeta] armour trim patterns, trim palettes, map decorations
 * GET /api/status                 state of the live camera sessions (troubleshooting)
 * GET /map/{id}                   the picture of a map in an item frame a camera sees (128 x 128 RGBA)
 * </pre>
 */
public final class WebServer {
	private static final Pattern CAMERA_NAME = Pattern.compile("^[A-Za-z0-9_-]{1,32}$");
	/** A cache manifest of 60000 sections is about 2 MB. */
	private static final int MAX_MANIFEST_BYTES = 8 << 20;
	private static final SecureRandom RANDOM = new SecureRandom();
	/** Open streams by viewer id, for the requests that come beside them. */
	private final Map<String, SseViewer> streams = new ConcurrentHashMap<>();
	private static final Pattern STATIC_FILE = Pattern.compile("^[A-Za-z0-9_-]+\\.(js|css|html|png|svg|ico)$");
	private static final String TOKEN_COOKIE = "cctv_token";

	private final CctvConfig config;
	/** config/cctv: custom sky boxes and post-processing shaders live here. */
	private final Path dataDir;
	private final CameraDirectory directory;
	private final ClientAssets assets;
	private final Logger logger;
	private final SkinProxy skins;
	private final GameSounds sounds;
	private final ModMusic music;
	private final WebFont webFont;
	private final Map<String, byte[]> resourceCache = new ConcurrentHashMap<>();
	/** Optional directory to serve the web files from instead of the jar (for developing the viewer). */
	private final Path devWebDir;
	private HttpServer server;
	private ExecutorService executor;

	public WebServer(CctvConfig config, Path dataDir, CameraDirectory directory, ClientAssets assets, Logger logger) {
		this.config = config;
		this.dataDir = dataDir;
		this.directory = directory;
		this.assets = assets;
		this.logger = logger;
		this.skins = new SkinProxy(logger);
		this.sounds = new GameSounds(assets, logger);
		this.music = new ModMusic(assets, dataDir.toAbsolutePath().getParent());
		this.webFont = new WebFont(assets);
		String dev = System.getProperty("cctv.webDir");
		this.devWebDir = dev == null || dev.isBlank() ? null : Path.of(dev);
	}

	public void start() throws IOException {
		InetSocketAddress address = new InetSocketAddress(InetAddress.getByName(config.bindAddress), config.port);
		server = HttpServer.create(address, 64);
		executor = Executors.newVirtualThreadPerTaskExecutor();
		server.setExecutor(executor);
		server.createContext("/", exchange -> {
			try (exchange) {
				handle(exchange);
			} catch (IOException e) {
				// Client disconnected mid-response.
			} catch (RuntimeException e) {
				logger.warn("Error while handling {}", exchange.getRequestURI(), e);
			}
		});
		server.start();
		logger.info("CCTV web server listening on http://{}:{}/", config.bindAddress, config.port);
	}

	public void stop() {
		if (server != null) {
			server.stop(0);
			server = null;
		}
		if (executor != null) {
			executor.shutdownNow();
			executor = null;
		}
	}

	private void handle(HttpExchange exchange) throws IOException {
		String method = exchange.getRequestMethod();
		if (method.equals("OPTIONS")) {
			exchange.getResponseHeaders().add("Access-Control-Allow-Origin", "*");
			exchange.getResponseHeaders().add("Access-Control-Allow-Methods", "GET");
			exchange.sendResponseHeaders(204, -1);
			return;
		}
		boolean post = method.equals("POST");
		if (!method.equals("GET") && !method.equals("HEAD") && !post) {
			sendText(exchange, 405, "text/plain", "Method not allowed");
			return;
		}

		String path = exchange.getRequestURI().getPath();
		Map<String, String> query = parseQuery(exchange.getRequestURI().getRawQuery());

		if (path.startsWith("/static/")) {
			// Static assets contain no world data, so they are served without a token.
			serveResource(exchange, path.substring("/static/".length()));
			return;
		}
		if (path.equals("/assets/font/minecraft.ttf") || path.equals("/assets/font/minecraft-bold.ttf")) {
			// Nor does the font (embedded viewers on other sites get no token cookie).
			serveWebFont(exchange, path.contains("bold"));
			return;
		}

		if (!authorize(exchange, query)) {
			exchange.getResponseHeaders().add("Access-Control-Allow-Origin", "*");
			sendText(exchange, 401, "text/html; charset=utf-8",
					"<!doctype html><meta charset=utf-8><title>CCTV</title>"
					+ "<style>@font-face{font-family:Minecraft;src:url(/assets/font/minecraft.ttf)}</style>"
					+ "<body style=\"font:16px/1.25 Minecraft,sans-serif;background:#111;color:#ddd;padding:2em\">"
					+ "<h1>401</h1><p>Missing or wrong access token. Open the link with <code>?token=...</code>.</p>");
			return;
		}

		if (post) {
			if (path.startsWith("/api/cameras/") && path.endsWith("/cache")) {
				cacheManifest(exchange, query);
			} else {
				sendText(exchange, 405, "text/plain", "Method not allowed");
			}
			return;
		}

		if (path.equals("/") || path.equals("/index.html")) {
			serveResource(exchange, "index.html");
		} else if (path.startsWith("/cam/")) {
			serveResource(exchange, "viewer.html");
		} else if (path.equals("/api/viewer")) {
			exchange.getResponseHeaders().add("Access-Control-Allow-Origin", "*");
			exchange.getResponseHeaders().add("Cache-Control", "no-store");
			sendText(exchange, 200, "application/json; charset=utf-8", CustomContent.viewerJson(config, dataDir));
		} else if (path.startsWith("/custom/")) {
			custom(exchange, path.substring("/custom/".length()));
		} else if (path.equals("/api/status")) {
			exchange.getResponseHeaders().add("Cache-Control", "no-store");
			sendText(exchange, 200, "application/json; charset=utf-8", directory.statusJson());
		} else if (path.equals("/api/cameras")) {
			exchange.getResponseHeaders().add("Access-Control-Allow-Origin", "*");
			exchange.getResponseHeaders().add("Cache-Control", "no-store");
			sendText(exchange, 200, "application/json; charset=utf-8", directory.camerasJson());
		} else if (path.startsWith("/api/cameras/") && path.endsWith("/stream")) {
			String name = path.substring("/api/cameras/".length(), path.length() - "/stream".length());
			stream(exchange, name, "1".equals(query.get("cache")), viewerFov(query.get("fov")));
		} else if (path.startsWith("/skin/")) {
			skin(exchange, path.substring("/skin/".length()), query.get("name"));
		} else if (path.startsWith("/cape/")) {
			cape(exchange, path.substring("/cape/".length()), query.get("name"));
		} else if (path.startsWith("/assets/")) {
			asset(exchange, path.substring("/assets/".length()));
		} else if (path.startsWith("/map/")) {
			map(exchange, path.substring("/map/".length()));
		} else {
			sendText(exchange, 404, "text/plain", "Not found");
		}
	}

	/**
	 * POST /api/cameras/{name}/cache?vid=...&epoch=...: the sections a viewer has in its cache ("x,y,z,hash,..."),
	 * sent after the "init" it got on its stream; the camera then sends only the sections that changed.
	 */
	private void cacheManifest(HttpExchange exchange, Map<String, String> query) throws IOException {
		SseViewer viewer = streams.get(String.valueOf(query.get("vid")));
		int epoch;
		try {
			epoch = Integer.parseInt(String.valueOf(query.get("epoch")));
		} catch (NumberFormatException e) {
			epoch = -1;
		}
		if (viewer == null || epoch < 0) {
			sendText(exchange, 404, "text/plain", "Unknown viewer");
			return;
		}
		byte[] body;
		try (InputStream in = exchange.getRequestBody()) {
			body = in.readNBytes(MAX_MANIFEST_BYTES + 1);
		}
		if (body.length > MAX_MANIFEST_BYTES) {
			sendText(exchange, 413, "text/plain", "Manifest too large");
			return;
		}
		long[] sections = parseManifest(new String(body, StandardCharsets.US_ASCII));
		if (sections == null) {
			sendText(exchange, 400, "text/plain", "Bad manifest");
			return;
		}
		viewer.setCacheManifest(epoch, sections);
		exchange.sendResponseHeaders(204, -1);
		exchange.close();
	}

	/** "x,y,z,hash,x,y,z,hash..." as numbers, or null when malformed. */
	static long @Nullable [] parseManifest(String text) {
		if (text.isBlank()) {
			return new long[0];
		}
		String[] parts = text.trim().split(",");
		if (parts.length % 4 != 0) {
			return null;
		}
		long[] values = new long[parts.length];
		try {
			for (int i = 0; i < parts.length; i++) {
				values[i] = Long.parseLong(parts[i].trim());
			}
		} catch (NumberFormatException e) {
			return null;
		}
		return values;
	}

	/** {@code ?fov=}: the viewer's own field of view, 30 to 110 degrees like the game's option; 0 for the camera's. */
	private static double viewerFov(@Nullable String value) {
		if (value == null) {
			return 0;
		}
		try {
			double fov = Double.parseDouble(value);
			return Double.isFinite(fov) ? Math.max(30, Math.min(110, fov)) : 0;
		} catch (NumberFormatException e) {
			return 0;
		}
	}

	private void stream(HttpExchange exchange, String name, boolean cache, double fov) throws IOException {
		Headers headers = exchange.getResponseHeaders();
		headers.add("Access-Control-Allow-Origin", "*");

		if (!CAMERA_NAME.matcher(name).matches()) {
			sendText(exchange, 404, "text/plain", "Unknown camera");
			return;
		}

		byte[] idBytes = new byte[12];
		RANDOM.nextBytes(idBytes);
		SseViewer viewer = new SseViewer(config.maxQueuedMessages, HexFormat.of().formatHex(idBytes), cache, fov);
		CameraDirectory.Subscription result = directory.subscribe(name, viewer);
		if (result == CameraDirectory.Subscription.NOT_FOUND) {
			sendText(exchange, 404, "text/plain", "Unknown camera");
			return;
		}
		if (result == CameraDirectory.Subscription.FULL) {
			sendText(exchange, 503, "text/plain", "Too many viewers for this camera");
			return;
		}

		boolean gzip = config.gzip && acceptsGzip(exchange);
		headers.add("Content-Type", "text/event-stream; charset=utf-8");
		headers.add("Cache-Control", "no-cache, no-transform");
		headers.add("X-Accel-Buffering", "no");
		if (gzip) {
			headers.add("Content-Encoding", "gzip");
		}

		try {
			exchange.sendResponseHeaders(200, 0);
			OutputStream out = exchange.getResponseBody();
			if (gzip) {
				out = new GZIPOutputStream(out, 8192, true);
			}
			out.write("retry: 2000\n\n".getBytes(StandardCharsets.UTF_8));
			out.flush();
			streams.put(viewer.id(), viewer);
			viewer.run(out);
		} finally {
			streams.remove(viewer.id());
			viewer.close();
		}
	}

	private void skin(HttpExchange exchange, String uuid, String name) throws IOException {
		if (!config.skins) {
			sendText(exchange, 404, "text/plain", "Skins disabled");
			return;
		}

		SkinProxy.Skin skin = skins.get(uuid, name);
		if (skin.missing()) {
			exchange.getResponseHeaders().add("Cache-Control", "max-age=300");
			sendText(exchange, 404, "text/plain", "No skin");
			return;
		}

		exchange.getResponseHeaders().add("X-Skin-Model", skin.slim() ? "slim" : "classic");
		exchange.getResponseHeaders().add("Access-Control-Expose-Headers", "X-Skin-Model");
		exchange.getResponseHeaders().add("Cache-Control", "max-age=3600");
		sendBytes(exchange, 200, "image/png", skin.png());
	}

	/** The cape of a player's Mojang profile (CapeLayer), fetched and cached with the skin. */
	private void cape(HttpExchange exchange, String uuid, String name) throws IOException {
		SkinProxy.Skin skin = config.skins ? skins.get(uuid, name) : null;
		if (skin == null || skin.cape() == null) {
			exchange.getResponseHeaders().add("Cache-Control", "max-age=300");
			sendText(exchange, 404, "text/plain", "No cape");
			return;
		}
		exchange.getResponseHeaders().add("Cache-Control", "max-age=3600");
		sendBytes(exchange, 200, "image/png", skin.cape());
	}

	/** Sky box images and post-processing shaders from config/cctv. */
	private void custom(HttpExchange exchange, String path) throws IOException {
		Path file = CustomContent.resolve(dataDir, path);
		if (file == null) {
			sendText(exchange, 404, "text/plain", "Not found");
			return;
		}
		exchange.getResponseHeaders().add("Cache-Control", "no-cache");
		sendBytes(exchange, 200, contentType(file.getFileName().toString()), Files.readAllBytes(file));
	}

	/** The picture of a map in an item frame: raw RGBA, the viewer puts it into a texture as it is. */
	private void map(HttpExchange exchange, String id) throws IOException {
		Headers headers = exchange.getResponseHeaders();
		headers.add("Access-Control-Allow-Origin", "*");
		byte[] rgba = null;
		try {
			rgba = directory.mapPicture(Integer.parseInt(id));
		} catch (NumberFormatException e) {
			// not a map id
		}
		if (rgba == null) {
			sendText(exchange, 404, "text/plain", "Not found");
			return;
		}
		// the viewer asks with ?v=<picture version>, so a picture may be kept for good
		headers.add("Cache-Control", "max-age=86400");
		if (acceptsGzip(exchange)) {
			ByteArrayOutputStream out = new ByteArrayOutputStream(8192);
			try (GZIPOutputStream gzip = new GZIPOutputStream(out)) {
				gzip.write(rgba);
			}
			headers.add("Content-Encoding", "gzip");
			sendBytes(exchange, 200, "application/octet-stream", out.toByteArray());
		} else {
			sendBytes(exchange, 200, "application/octet-stream", rgba);
		}
	}

	private void asset(HttpExchange exchange, String path) throws IOException {
		Headers headers = exchange.getResponseHeaders();
		headers.add("Access-Control-Allow-Origin", "*");

		if (path.equals("bundle.json")) {
			ClientAssets.State state = assets.state();
			if (state != ClientAssets.State.READY) {
				headers.add("Cache-Control", "no-store");
				int status = state == ClientAssets.State.LOADING ? 503 : 404;
				sendText(exchange, status, "application/json", "{\"state\":\"" + state.name().toLowerCase() + "\"}");
				return;
			}

			headers.add("ETag", assets.etag());
			headers.add("Cache-Control", "no-cache");
			if (assets.etag().equals(exchange.getRequestHeaders().getFirst("If-None-Match"))) {
				exchange.sendResponseHeaders(304, -1);
				return;
			}
			sendGzipped(exchange, "application/json", assets.bundle());
		} else if (path.equals("models.json")) {
			byte[] models = assets.entityModels();
			if (models == null) {
				headers.add("Cache-Control", "no-store");
				sendText(exchange, assets.state() == ClientAssets.State.LOADING || assets.entityModelsPending() ? 503 : 404, "application/json", "{}");
				return;
			}
			headers.add("ETag", assets.entityModelsEtag());
			headers.add("Cache-Control", "no-cache");
			if (assets.entityModelsEtag().equals(exchange.getRequestHeaders().getFirst("If-None-Match"))) {
				exchange.sendResponseHeaders(304, -1);
				return;
			}
			sendGzipped(exchange, "application/json", models);
		} else if (path.equals("music.json")) {
			byte[] json = config.sounds ? music.json() : null;
			if (json == null) {
				headers.add("Cache-Control", "no-store");
				// 503 while the assets and texts load (the viewer asks again), 404 without sounds or client assets
				boolean loading = config.sounds && (assets.state() == ClientAssets.State.LOADING
						|| assets.state() == ClientAssets.State.READY && !assets.textsReady());
				sendText(exchange, loading ? 503 : 404, "application/json", "{}");
				return;
			}
			headers.add("ETag", music.etag());
			headers.add("Cache-Control", "no-cache");
			if (music.etag().equals(exchange.getRequestHeaders().getFirst("If-None-Match"))) {
				exchange.sendResponseHeaders(304, -1);
				return;
			}
			sendGzipped(exchange, "application/json", json);
		} else if (path.startsWith("gui/") && (path.endsWith(".png") || path.endsWith(".png.mcmeta"))) {
			// the game's GUI sprites (the Now Playing toast), resource packs over the client jar
			boolean meta = path.endsWith(".mcmeta");
			String sprite = path.substring("gui/".length(), path.length() - (meta ? ".png.mcmeta".length() : ".png".length()));
			byte[] data = assets.guiSprite(sprite, meta);
			if (data == null) {
				sendText(exchange, 404, "text/plain", "Not found");
				return;
			}
			headers.add("Cache-Control", "max-age=3600");
			sendBytes(exchange, 200, meta ? "application/json" : "image/png", data);
		} else if (path.equals("sounds.json") || path.startsWith("sound/")) {
			if (!config.sounds) {
				sendText(exchange, 404, "text/plain", "Sounds disabled");
				return;
			}
			if (path.equals("sounds.json")) {
				byte[] json = sounds.soundsJson();
				if (json == null) {
					headers.add("Cache-Control", "no-store");
					sendText(exchange, assets.state() == ClientAssets.State.LOADING ? 503 : 404, "application/json", "{}");
					return;
				}
				headers.add("ETag", sounds.etag());
				headers.add("Cache-Control", "no-cache");
				if (sounds.etag().equals(exchange.getRequestHeaders().getFirst("If-None-Match"))) {
					exchange.sendResponseHeaders(304, -1);
					return;
				}
				sendGzipped(exchange, "application/json", json);
				return;
			}
			if (!path.endsWith(".ogg")) {
				sendText(exchange, 404, "text/plain", "Not found");
				return;
			}
			byte[] ogg = sounds.sound(path.substring("sound/".length(), path.length() - ".ogg".length()));
			if (ogg == null) {
				headers.add("Cache-Control", "max-age=300");
				sendText(exchange, 404, "text/plain", "Not found");
				return;
			}
			headers.add("Cache-Control", "max-age=604800");
			sendBytes(exchange, 200, "audio/ogg", ogg);
		} else if (path.equals("names.json")) {
			headers.add("Cache-Control", "no-cache");
			sendText(exchange, 200, "application/json", assets.namesJson());
		} else if (path.equals("entities.json")) {
			headers.add("Cache-Control", "no-cache");
			sendText(exchange, 200, "application/json", assets.entityListJson());
		} else if (path.startsWith("font/")) {
			byte[] data = assets.font(path.substring("font/".length()));
			if (data == null) {
				sendText(exchange, 404, "text/plain", "Not found");
				return;
			}
			headers.add("Cache-Control", "max-age=86400");
			sendBytes(exchange, 200, path.endsWith(".png") ? "image/png" : "application/json", data);
		} else if (path.startsWith("trims/") || path.startsWith("palettes/") || path.startsWith("map/")) {
			byte[] data = assets.recolourTexture(path);
			if (data == null) {
				sendText(exchange, 404, "text/plain", "Not found");
				return;
			}
			headers.add("Cache-Control", "max-age=86400");
			sendBytes(exchange, 200, path.endsWith(".mcmeta") ? "application/json" : "image/png", data);
		} else if (path.startsWith("entity/") && path.endsWith(".png.mcmeta")) {
			byte[] meta = assets.entityTextureMeta(path.substring("entity/".length(), path.length() - ".png.mcmeta".length()));
			if (meta == null) {
				sendText(exchange, 404, "text/plain", "Not found");
				return;
			}
			headers.add("Cache-Control", "max-age=86400");
			sendBytes(exchange, 200, "application/json", meta);
		} else if ((path.startsWith("entity/") || path.startsWith("painting/") || path.startsWith("misc/")) && path.endsWith(".png")) {
			String name = path.substring(path.indexOf('/') + 1, path.length() - ".png".length());
			byte[] png = path.startsWith("entity/") ? assets.entityTexture(name)
					: path.startsWith("misc/") ? assets.miscTexture(name) : assets.paintingTexture(name);
			if (png == null) {
				sendText(exchange, 404, "text/plain", "Not found");
				return;
			}
			headers.add("Cache-Control", "max-age=86400");
			sendBytes(exchange, 200, "image/png", png);
		} else {
			sendText(exchange, 404, "text/plain", "Not found");
		}
	}

	/** Sends pre-compressed data, unpacking it for the rare client without gzip support. */
	private static void sendGzipped(HttpExchange exchange, String type, byte[] gzipped) throws IOException {
		if (acceptsGzip(exchange)) {
			exchange.getResponseHeaders().add("Content-Encoding", "gzip");
			sendBytes(exchange, 200, type, gzipped);
		} else {
			sendBytes(exchange, 200, type, new GZIPInputStream(new ByteArrayInputStream(gzipped)).readAllBytes());
		}
	}

	/** The pages' text in the game's font (style.css); before the assets are ready the browser keeps its own. */
	private void serveWebFont(HttpExchange exchange, boolean bold) throws IOException {
		Headers headers = exchange.getResponseHeaders();
		headers.add("Access-Control-Allow-Origin", "*");
		byte[] ttf = webFont.ttf(bold);
		if (ttf == null) {
			headers.add("Cache-Control", "no-store");
			sendText(exchange, assets.state() == ClientAssets.State.LOADING ? 503 : 404, "text/plain", "Not available");
			return;
		}
		headers.add("Cache-Control", "max-age=86400");
		sendGzipped(exchange, "font/ttf", ttf);
	}

	private void serveResource(HttpExchange exchange, String file) throws IOException {
		if (!STATIC_FILE.matcher(file).matches()) {
			sendText(exchange, 404, "text/plain", "Not found");
			return;
		}

		byte[] data = loadResource(file);
		if (data == null) {
			sendText(exchange, 404, "text/plain", "Not found");
			return;
		}

		exchange.getResponseHeaders().add("Cache-Control", devWebDir != null ? "no-store" : "no-cache");
		sendBytes(exchange, 200, contentType(file), data);
	}

	private byte[] loadResource(String file) throws IOException {
		if (devWebDir != null) {
			Path path = devWebDir.resolve(file);
			return Files.isRegularFile(path) ? Files.readAllBytes(path) : null;
		}

		byte[] cached = resourceCache.get(file);
		if (cached != null) {
			return cached;
		}

		try (InputStream in = WebServer.class.getResourceAsStream("/web/" + file)) {
			if (in == null) {
				return null;
			}
			ByteArrayOutputStream buffer = new ByteArrayOutputStream();
			in.transferTo(buffer);
			byte[] data = buffer.toByteArray();
			resourceCache.put(file, data);
			return data;
		}
	}

	private boolean authorize(HttpExchange exchange, Map<String, String> query) {
		String expected = config.accessToken;
		if (expected == null || expected.isEmpty()) {
			return true;
		}

		String fromQuery = query.get("token");
		if (fromQuery != null && tokenEquals(expected, fromQuery)) {
			exchange.getResponseHeaders().add("Set-Cookie",
					TOKEN_COOKIE + "=" + fromQuery + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000");
			return true;
		}

		String cookies = exchange.getRequestHeaders().getFirst("Cookie");
		if (cookies != null) {
			for (String part : cookies.split(";")) {
				String cookie = part.trim();
				if (cookie.startsWith(TOKEN_COOKIE + "=")
						&& tokenEquals(expected, cookie.substring(TOKEN_COOKIE.length() + 1))) {
					return true;
				}
			}
		}

		return false;
	}

	private static boolean tokenEquals(String expected, String actual) {
		return MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8), actual.getBytes(StandardCharsets.UTF_8));
	}

	private static boolean acceptsGzip(HttpExchange exchange) {
		String accept = exchange.getRequestHeaders().getFirst("Accept-Encoding");
		return accept != null && accept.toLowerCase().contains("gzip");
	}

	private static Map<String, String> parseQuery(String rawQuery) {
		Map<String, String> result = new ConcurrentHashMap<>();
		if (rawQuery == null || rawQuery.isEmpty()) {
			return result;
		}
		for (String pair : rawQuery.split("&")) {
			int eq = pair.indexOf('=');
			String key = eq < 0 ? pair : pair.substring(0, eq);
			String value = eq < 0 ? "" : pair.substring(eq + 1);
			try {
				result.put(URLDecoder.decode(key, StandardCharsets.UTF_8), URLDecoder.decode(value, StandardCharsets.UTF_8));
			} catch (IllegalArgumentException ignored) {
				// Malformed escape sequence, skip the parameter.
			}
		}
		return result;
	}

	private static String contentType(String file) {
		String ext = file.substring(file.lastIndexOf('.') + 1);
		return switch (ext) {
			case "html" -> "text/html; charset=utf-8";
			case "js" -> "text/javascript; charset=utf-8";
			case "css" -> "text/css; charset=utf-8";
			case "png" -> "image/png";
			case "jpg", "jpeg" -> "image/jpeg";
			case "webp" -> "image/webp";
			case "glsl" -> "text/plain; charset=utf-8";
			case "json" -> "application/json; charset=utf-8";
			case "svg" -> "image/svg+xml";
			case "ico" -> "image/x-icon";
			default -> "application/octet-stream";
		};
	}

	private static void sendText(HttpExchange exchange, int status, String type, String body) throws IOException {
		sendBytes(exchange, status, type, body.getBytes(StandardCharsets.UTF_8));
	}

	private static void sendBytes(HttpExchange exchange, int status, String type, byte[] body) throws IOException {
		exchange.getResponseHeaders().set("Content-Type", type);
		if (exchange.getRequestMethod().equals("HEAD")) {
			exchange.sendResponseHeaders(status, -1);
			return;
		}
		exchange.sendResponseHeaders(status, body.length == 0 ? -1 : body.length);
		if (body.length > 0) {
			try (OutputStream out = exchange.getResponseBody()) {
				out.write(body);
			}
		}
	}
}
