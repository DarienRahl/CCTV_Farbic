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
import org.slf4j.Logger;

import io.github.darienrahl.cctv.CctvConfig;
import io.github.darienrahl.cctv.assets.ClientAssets;

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
 * GET /api/viewer                viewer defaults, custom sky boxes and shaders
 * GET /custom/{skyboxes|shaders}/... custom files from config/cctv
 * GET /assets/bundle.json        block states, models and textures (from the client jar)
 * GET /assets/models.json        entity model geometry (from the client jar)
 * GET /assets/entities.json      list of entity textures
 * GET /assets/entity/{path}.png  one entity texture
 * GET /assets/font/{path}         the game's font (definitions .json, glyph sheets .png)
 * </pre>
 */
public final class WebServer {
	private static final Pattern CAMERA_NAME = Pattern.compile("^[A-Za-z0-9_-]{1,32}$");
	private static final Pattern STATIC_FILE = Pattern.compile("^[A-Za-z0-9_-]+\\.(js|css|html|png|svg|ico)$");
	private static final String TOKEN_COOKIE = "cctv_token";

	private final CctvConfig config;
	/** config/cctv: custom sky boxes and post-processing shaders live here. */
	private final Path dataDir;
	private final CameraDirectory directory;
	private final ClientAssets assets;
	private final Logger logger;
	private final SkinProxy skins;
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
		if (!method.equals("GET") && !method.equals("HEAD")) {
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

		if (!authorize(exchange, query)) {
			exchange.getResponseHeaders().add("Access-Control-Allow-Origin", "*");
			sendText(exchange, 401, "text/html; charset=utf-8",
					"<!doctype html><meta charset=utf-8><title>CCTV</title>"
					+ "<body style=\"font-family:sans-serif;background:#111;color:#ddd;padding:2em\">"
					+ "<h1>401</h1><p>Missing or wrong access token. Open the link with <code>?token=...</code>.</p>");
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
		} else if (path.equals("/api/cameras")) {
			exchange.getResponseHeaders().add("Access-Control-Allow-Origin", "*");
			exchange.getResponseHeaders().add("Cache-Control", "no-store");
			sendText(exchange, 200, "application/json; charset=utf-8", directory.camerasJson());
		} else if (path.startsWith("/api/cameras/") && path.endsWith("/stream")) {
			String name = path.substring("/api/cameras/".length(), path.length() - "/stream".length());
			stream(exchange, name);
		} else if (path.startsWith("/skin/")) {
			skin(exchange, path.substring("/skin/".length()), query.get("name"));
		} else if (path.startsWith("/assets/")) {
			asset(exchange, path.substring("/assets/".length()));
		} else {
			sendText(exchange, 404, "text/plain", "Not found");
		}
	}

	private void stream(HttpExchange exchange, String name) throws IOException {
		Headers headers = exchange.getResponseHeaders();
		headers.add("Access-Control-Allow-Origin", "*");

		if (!CAMERA_NAME.matcher(name).matches()) {
			sendText(exchange, 404, "text/plain", "Unknown camera");
			return;
		}

		SseViewer viewer = new SseViewer(config.maxQueuedMessages);
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
			viewer.run(out);
		} finally {
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
		} else if ((path.startsWith("entity/") || path.startsWith("painting/")) && path.endsWith(".png")) {
			String name = path.substring(path.indexOf('/') + 1, path.length() - ".png".length());
			byte[] png = path.startsWith("entity/") ? assets.entityTexture(name) : assets.paintingTexture(name);
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
