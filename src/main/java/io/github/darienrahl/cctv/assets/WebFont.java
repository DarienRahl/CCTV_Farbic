package io.github.darienrahl.cctv.assets;

import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.zip.GZIPOutputStream;

import javax.imageio.ImageIO;

import org.jspecify.annotations.Nullable;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/**
 * The game's default font as a TrueType font for the web pages (the camera list and the viewer's buttons,
 * settings and HUD), built from the same glyph sheets the client draws text with ({@code font/default.json}
 * and its bitmap and space providers, resource packs over the client jar), like FontManager loads them.
 *
 * <p>Every lit pixel of a glyph is a square of the outline, neighbouring pixels joined into one contour, so at
 * font sizes that are a multiple of 8 CSS pixels the text is the game's own pixels. Advances are the game's
 * (BitmapProvider: the glyph's width plus one pixel). The bold face is the game's bold: each glyph drawn again one
 * pixel to the right, one pixel wider. Characters the sheets do not have are left to the browser's next font.
 */
public final class WebFont {
	/** Font units per pixel of the game's GUI; an em is 8 pixels, the height of a line of the sheets. */
	static final int PIXEL = 128;
	static final int EM = 8 * PIXEL;
	private static final int ASCENDER = 8 * PIXEL;
	private static final int DESCENDER = -2 * PIXEL;

	private final ClientAssets assets;
	private final byte @Nullable [][] built = new byte[2][];

	public WebFont(ClientAssets assets) {
		this.assets = assets;
	}

	/** The gzip-compressed TTF (regular or bold), built once the assets are ready; null before or without a font. */
	public synchronized byte @Nullable [] ttf(boolean bold) {
		int index = bold ? 1 : 0;
		if (built[index] == null && assets.state() == ClientAssets.State.READY) {
			byte[] font = build(bold);
			if (font != null) {
				ByteArrayOutputStream out = new ByteArrayOutputStream(font.length / 2);
				try (GZIPOutputStream gzip = new GZIPOutputStream(out)) {
					gzip.write(font);
				} catch (IOException e) {
					throw new UncheckedIOException(e);
				}
				built[index] = out.toByteArray();
			}
		}
		return built[index];
	}

	/** A glyph: its advance and its contours (x, y pairs in font units, clockwise around lit pixels). */
	record Glyph(int advance, List<int[]> contours) {
		int[] bounds() {
			int xMin = Integer.MAX_VALUE, yMin = Integer.MAX_VALUE, xMax = Integer.MIN_VALUE, yMax = Integer.MIN_VALUE;
			for (int[] contour : contours) {
				for (int i = 0; i < contour.length; i += 2) {
					xMin = Math.min(xMin, contour[i]);
					xMax = Math.max(xMax, contour[i]);
					yMin = Math.min(yMin, contour[i + 1]);
					yMax = Math.max(yMax, contour[i + 1]);
				}
			}
			return contours.isEmpty() ? new int[] {0, 0, 0, 0} : new int[] {xMin, yMin, xMax, yMax};
		}

		int points() {
			int points = 0;
			for (int[] contour : contours) {
				points += contour.length / 2;
			}
			return points;
		}
	}

	byte @Nullable [] build(boolean bold) {
		List<JsonObject> providers = new ArrayList<>();
		collect("minecraft:default", new HashSet<>(), providers);
		TreeMap<Integer, Glyph> glyphs = new TreeMap<>();
		for (JsonObject provider : providers) {
			String type = provider.has("type") ? provider.get("type").getAsString() : "";
			try {
				if (type.equals("space")) {
					space(provider, glyphs, bold);
				} else if (type.equals("bitmap")) {
					bitmap(provider, glyphs, bold);
				}
			} catch (IOException | RuntimeException e) {
				// a broken provider is left out, as the game does
			}
		}
		// the font tables can only map the Basic Multilingual Plane here
		glyphs.keySet().removeIf(cp -> cp > 0xFFFF || cp == 0xFFFF);
		return glyphs.isEmpty() ? null : write(glyphs, bold);
	}

	/** FontManager: the providers of a font definition, references followed, filtered like the default options. */
	private void collect(String id, Set<String> seen, List<JsonObject> out) {
		if (!seen.add(id)) {
			return;
		}
		int colon = id.indexOf(':');
		String namespace = colon < 0 ? "minecraft" : id.substring(0, colon);
		byte[] data = assets.resource("assets/" + namespace + "/font/" + id.substring(colon + 1) + ".json");
		if (data == null) {
			return;
		}
		JsonObject definition = JsonParser.parseString(new String(data, StandardCharsets.UTF_8)).getAsJsonObject();
		if (!definition.has("providers")) {
			return;
		}
		for (JsonElement element : definition.getAsJsonArray("providers")) {
			JsonObject provider = element.getAsJsonObject();
			// "uniform" (Force Unicode Font) and "jp" (Japanese Glyph Variants) are off by default
			if (provider.has("filter") && provider.getAsJsonObject("filter").entrySet().stream().anyMatch(e -> e.getValue().getAsBoolean())) {
				continue;
			}
			if ("reference".equals(provider.has("type") ? provider.get("type").getAsString() : "")) {
				collect(provider.get("id").getAsString(), seen, out);
			} else {
				out.add(provider);
			}
		}
	}

	/** SpaceProvider: characters with only an advance. */
	private static void space(JsonObject provider, Map<Integer, Glyph> glyphs, boolean bold) {
		for (Map.Entry<String, JsonElement> entry : provider.getAsJsonObject("advances").entrySet()) {
			int cp = entry.getKey().codePointAt(0);
			if (!glyphs.containsKey(cp)) {
				glyphs.put(cp, new Glyph((int) Math.round(entry.getValue().getAsFloat() * PIXEL) + (bold ? PIXEL : 0), List.of()));
			}
		}
	}

	/** BitmapProvider.Definition.load: a sheet of equal cells, one character each, from {@code textures/}. */
	private void bitmap(JsonObject provider, Map<Integer, Glyph> glyphs, boolean bold) throws IOException {
		String file = provider.get("file").getAsString();
		int colon = file.indexOf(':');
		String namespace = colon < 0 ? "minecraft" : file.substring(0, colon);
		byte[] png = assets.resource("assets/" + namespace + "/textures/" + file.substring(colon + 1));
		if (png == null) {
			return;
		}
		BufferedImage image = ImageIO.read(new ByteArrayInputStream(png));
		List<int[]> rows = new ArrayList<>();
		for (JsonElement row : provider.getAsJsonArray("chars")) {
			rows.add(row.getAsString().codePoints().toArray());
		}
		if (image == null || rows.isEmpty() || rows.get(0).length == 0) {
			return;
		}
		int cellW = image.getWidth() / rows.get(0).length;
		int cellH = image.getHeight() / rows.size();
		int height = provider.has("height") ? provider.get("height").getAsInt() : 8;
		int ascent = provider.get("ascent").getAsInt();
		double scale = (double) height / cellH;
		for (int slotY = 0; slotY < rows.size(); slotY++) {
			int[] row = rows.get(slotY);
			for (int slotX = 0; slotX < row.length; slotX++) {
				int cp = row[slotX];
				if (cp == 0 || glyphs.containsKey(cp)) {
					continue;
				}
				boolean[][] lit = new boolean[cellH][cellW];
				int width = 0;
				for (int y = 0; y < cellH; y++) {
					for (int x = 0; x < cellW; x++) {
						if ((image.getRGB(slotX * cellW + x, slotY * cellH + y) >>> 24) != 0) {
							lit[y][x] = true;
							width = Math.max(width, x + 1);
						}
					}
				}
				// BitmapProvider.Glyph.getAdvance: the rightmost lit column, scaled, and one pixel of spacing
				int advance = ((int) (0.5 + width * scale) + 1) * PIXEL;
				if (bold) {
					// the game's bold draws the glyph again one GUI pixel to the right
					int shift = Math.max(1, (int) Math.round(1 / scale));
					boolean[][] thick = new boolean[cellH][cellW + shift];
					for (int y = 0; y < cellH; y++) {
						for (int x = 0; x < cellW; x++) {
							if (lit[y][x]) {
								for (int k = 0; k <= shift; k++) {
									thick[y][x + k] = true;
								}
							}
						}
					}
					lit = thick;
					advance += PIXEL;
				}
				glyphs.put(cp, new Glyph(advance, outline(lit, PIXEL * scale, ascent * PIXEL)));
			}
		}
	}

	/**
	 * The outline of a glyph's lit pixels: every pixel's edges clockwise, the edges two pixels share cancelled,
	 * the rest joined into closed contours (holes come out anticlockwise) without points in the middle of a line.
	 */
	static List<int[]> outline(boolean[][] lit, double size, int top) {
		int h = lit.length;
		int w = h == 0 ? 0 : lit[0].length;
		Set<Long> edges = new LinkedHashSet<>();
		for (int y = 0; y < h; y++) {
			for (int x = 0; x < w; x++) {
				if (!lit[y][x]) {
					continue;
				}
				// grid corners with y going up: the pixel's top edge is at h - y
				long tl = vertex(x, h - y), tr = vertex(x + 1, h - y), br = vertex(x + 1, h - y - 1), bl = vertex(x, h - y - 1);
				addEdge(edges, tl, tr);
				addEdge(edges, tr, br);
				addEdge(edges, br, bl);
				addEdge(edges, bl, tl);
			}
		}
		Map<Long, List<Long>> next = new HashMap<>();
		for (long edge : edges) {
			next.computeIfAbsent(edge >>> 32, k -> new ArrayList<>(2)).add(edge & 0xFFFFFFFFL);
		}
		List<int[]> contours = new ArrayList<>();
		while (!next.isEmpty()) {
			long start = next.keySet().iterator().next();
			List<Long> points = new ArrayList<>();
			long previous = start;
			long current = take(next, start, -1, -1);
			points.add(start);
			while (current != start) {
				points.add(current);
				long following = take(next, current, x(current) - x(previous), y(current) - y(previous));
				previous = current;
				current = following;
			}
			// corners only
			List<Long> corners = new ArrayList<>();
			for (int i = 0; i < points.size(); i++) {
				long a = points.get((i + points.size() - 1) % points.size()), b = points.get(i), c = points.get((i + 1) % points.size());
				if ((x(b) - x(a)) * (y(c) - y(b)) != (y(b) - y(a)) * (x(c) - x(b))) {
					corners.add(b);
				}
			}
			int[] contour = new int[corners.size() * 2];
			for (int i = 0; i < corners.size(); i++) {
				contour[i * 2] = (int) Math.round(x(corners.get(i)) * size);
				contour[i * 2 + 1] = top - (int) Math.round((h - y(corners.get(i))) * size);
			}
			contours.add(contour);
		}
		return contours;
	}

	private static long vertex(int x, int y) {
		return ((long) x << 16) | y;
	}

	private static int x(long vertex) {
		return (int) (vertex >>> 16);
	}

	private static int y(long vertex) {
		return (int) (vertex & 0xFFFF);
	}

	private static void addEdge(Set<Long> edges, long from, long to) {
		if (!edges.remove((to << 32) | from)) {
			edges.add((from << 32) | to);
		}
	}

	/** Removes and returns the end of an edge leaving a vertex; where two leave it, the one turning right. */
	private static long take(Map<Long, List<Long>> next, long from, int dx, int dy) {
		List<Long> ends = next.get(from);
		int pick = 0;
		if (ends.size() > 1) {
			for (int i = 0; i < ends.size(); i++) {
				long end = ends.get(i);
				// the right turn of (dx, dy) with y going up is (dy, -dx)
				if (x(end) - x(from) == dy && y(end) - y(from) == -dx) {
					pick = i;
				}
			}
		}
		long end = ends.remove(pick);
		if (ends.isEmpty()) {
			next.remove(from);
		}
		return end;
	}

	// --- the TrueType file ---

	private static byte[] write(TreeMap<Integer, Glyph> byCodePoint, boolean bold) {
		List<Glyph> glyphs = new ArrayList<>();
		// .notdef: nothing drawn (the browser's next font is used for characters the font does not have)
		glyphs.add(new Glyph(6 * PIXEL, List.of()));
		glyphs.addAll(byCodePoint.values());
		int count = glyphs.size();

		// glyf and loca
		ByteArrayOutputStream glyf = new ByteArrayOutputStream();
		int[] loca = new int[count + 1];
		int maxPoints = 0, maxContours = 0;
		int xMin = 0, yMin = 0, xMax = 0, yMax = 0, advanceMax = 0, minRsb = 0, maxExtent = 0;
		long advanceSum = 0;
		int advanceCount = 0;
		for (int i = 0; i < count; i++) {
			loca[i] = glyf.size();
			Glyph glyph = glyphs.get(i);
			advanceMax = Math.max(advanceMax, glyph.advance());
			if (glyph.advance() > 0) {
				advanceSum += glyph.advance();
				advanceCount++;
			}
			if (glyph.contours().isEmpty()) {
				continue;
			}
			int[] b = glyph.bounds();
			xMin = Math.min(xMin, b[0]);
			yMin = Math.min(yMin, b[1]);
			xMax = Math.max(xMax, b[2]);
			yMax = Math.max(yMax, b[3]);
			minRsb = Math.min(minRsb, glyph.advance() - b[2]);
			maxExtent = Math.max(maxExtent, b[2]);
			maxPoints = Math.max(maxPoints, glyph.points());
			maxContours = Math.max(maxContours, glyph.contours().size());
			ByteBuffer data = ByteBuffer.allocate(10 + glyph.contours().size() * 2 + 2 + glyph.points() * 5 + 4);
			data.putShort((short) glyph.contours().size());
			data.putShort((short) b[0]).putShort((short) b[1]).putShort((short) b[2]).putShort((short) b[3]);
			int end = -1;
			for (int[] contour : glyph.contours()) {
				end += contour.length / 2;
				data.putShort((short) end);
			}
			data.putShort((short) 0); // no instructions
			for (int p = 0; p < glyph.points(); p++) {
				data.put((byte) 0x01); // on the curve, two-byte coordinates
			}
			int last = 0;
			for (int[] contour : glyph.contours()) {
				for (int p = 0; p < contour.length; p += 2) {
					data.putShort((short) (contour[p] - last));
					last = contour[p];
				}
			}
			last = 0;
			for (int[] contour : glyph.contours()) {
				for (int p = 1; p < contour.length; p += 2) {
					data.putShort((short) (contour[p] - last));
					last = contour[p];
				}
			}
			while (data.position() % 4 != 0) {
				data.put((byte) 0);
			}
			glyf.write(data.array(), 0, data.position());
		}
		loca[count] = glyf.size();

		Map<String, byte[]> tables = new TreeMap<>();
		tables.put("glyf", glyf.toByteArray());
		ByteBuffer locaTable = ByteBuffer.allocate((count + 1) * 4);
		for (int offset : loca) {
			locaTable.putInt(offset);
		}
		tables.put("loca", locaTable.array());

		ByteBuffer head = ByteBuffer.allocate(54);
		head.putInt(0x00010000).putInt(0x00010000).putInt(0) // version, fontRevision, checkSumAdjustment (later)
				.putInt(0x5F0F3CF5).putShort((short) 0x000B).putShort((short) EM)
				.putLong(0).putLong(0) // created, modified
				.putShort((short) xMin).putShort((short) yMin).putShort((short) xMax).putShort((short) yMax)
				.putShort((short) (bold ? 1 : 0)).putShort((short) 8).putShort((short) 2)
				.putShort((short) 1).putShort((short) 0); // long loca offsets, glyph data format
		tables.put("head", head.array());

		ByteBuffer hhea = ByteBuffer.allocate(36);
		hhea.putInt(0x00010000).putShort((short) ASCENDER).putShort((short) DESCENDER).putShort((short) 0)
				.putShort((short) advanceMax).putShort((short) Math.min(0, xMin)).putShort((short) minRsb).putShort((short) maxExtent)
				.putShort((short) 1).putShort((short) 0).putShort((short) 0)
				.putShort((short) 0).putShort((short) 0).putShort((short) 0).putShort((short) 0)
				.putShort((short) 0).putShort((short) count);
		tables.put("hhea", hhea.array());

		ByteBuffer hmtx = ByteBuffer.allocate(count * 4);
		for (Glyph glyph : glyphs) {
			hmtx.putShort((short) glyph.advance()).putShort((short) glyph.bounds()[0]);
		}
		tables.put("hmtx", hmtx.array());

		ByteBuffer maxp = ByteBuffer.allocate(32);
		maxp.putInt(0x00010000).putShort((short) count).putShort((short) maxPoints).putShort((short) maxContours)
				.putShort((short) 0).putShort((short) 0).putShort((short) 2)
				.putShort((short) 0).putShort((short) 0).putShort((short) 0).putShort((short) 0)
				.putShort((short) 0).putShort((short) 0).putShort((short) 0).putShort((short) 0);
		tables.put("maxp", maxp.array());

		tables.put("cmap", cmap(byCodePoint));

		int first = byCodePoint.firstKey(), lastCp = byCodePoint.lastKey();
		ByteBuffer os2 = ByteBuffer.allocate(96);
		os2.putShort((short) 4).putShort((short) (advanceCount == 0 ? 0 : advanceSum / advanceCount))
				.putShort((short) (bold ? 700 : 400)).putShort((short) 5).putShort((short) 0)
				// subscript and superscript sizes and offsets
				.putShort((short) (EM / 2)).putShort((short) (EM / 2)).putShort((short) 0).putShort((short) PIXEL)
				.putShort((short) (EM / 2)).putShort((short) (EM / 2)).putShort((short) 0).putShort((short) (4 * PIXEL))
				.putShort((short) PIXEL).putShort((short) (4 * PIXEL)) // strikeout: the game's line through the middle
				.putShort((short) 0).put(new byte[10]) // family class, PANOSE
				.putInt(0).putInt(0).putInt(0).putInt(0)
				.put("CCTV".getBytes(StandardCharsets.US_ASCII))
				.putShort((short) ((bold ? 0x20 : 0x40) | 0x80)) // bold or regular, use the typo metrics
				.putShort((short) Math.min(first, 0xFFFF)).putShort((short) Math.min(lastCp, 0xFFFF))
				.putShort((short) ASCENDER).putShort((short) DESCENDER).putShort((short) 0)
				.putShort((short) Math.max(ASCENDER, yMax)).putShort((short) Math.max(-DESCENDER, -yMin))
				.putInt(1).putInt(0) // code pages: Latin 1
				.putShort((short) (5 * PIXEL)).putShort((short) (7 * PIXEL)).putShort((short) 0).putShort((short) 32).putShort((short) 1);
		tables.put("OS/2", os2.array());

		String style = bold ? "Bold" : "Regular";
		tables.put("name", name(new String[] {
			null, "Minecraft", style, "CCTV: Minecraft " + style, "Minecraft " + style, "Version 1.0", "Minecraft-" + style,
		}));

		ByteBuffer post = ByteBuffer.allocate(32);
		post.putInt(0x00030000).putInt(0).putShort((short) -PIXEL).putShort((short) PIXEL)
				.putInt(0).putInt(0).putInt(0).putInt(0).putInt(0);
		tables.put("post", post.array());

		return assemble(tables);
	}

	/** cmap format 4: one segment per run of consecutive characters (their glyphs are consecutive too). */
	private static byte[] cmap(TreeMap<Integer, Glyph> byCodePoint) {
		List<int[]> segments = new ArrayList<>(); // start, end, first glyph
		int glyph = 1;
		for (int cp : byCodePoint.keySet()) {
			int[] last = segments.isEmpty() ? null : segments.get(segments.size() - 1);
			if (last != null && last[1] == cp - 1) {
				last[1] = cp;
			} else {
				segments.add(new int[] {cp, cp, glyph});
			}
			glyph++;
		}
		segments.add(new int[] {0xFFFF, 0xFFFF, 0}); // the required last segment (maps to .notdef)
		int segCount = segments.size();
		int searchRange = 2 * Integer.highestOneBit(segCount);
		int entrySelector = Integer.numberOfTrailingZeros(Integer.highestOneBit(segCount));
		int length = 16 + segCount * 8;
		ByteBuffer table = ByteBuffer.allocate(4 + 8 + length);
		table.putShort((short) 0).putShort((short) 1); // version, one encoding table
		table.putShort((short) 3).putShort((short) 1).putInt(12); // Windows, Unicode BMP
		table.putShort((short) 4).putShort((short) length).putShort((short) 0)
				.putShort((short) (segCount * 2)).putShort((short) searchRange).putShort((short) entrySelector)
				.putShort((short) (segCount * 2 - searchRange));
		for (int[] segment : segments) {
			table.putShort((short) segment[1]);
		}
		table.putShort((short) 0);
		for (int[] segment : segments) {
			table.putShort((short) segment[0]);
		}
		for (int[] segment : segments) {
			table.putShort((short) (segment[0] == 0xFFFF ? 1 : segment[2] - segment[0]));
		}
		for (int i = 0; i < segCount; i++) {
			table.putShort((short) 0);
		}
		return table.array();
	}

	/** The naming table: family, style, unique name, full name, version and PostScript name (Windows, English). */
	private static byte[] name(String[] names) {
		ByteArrayOutputStream strings = new ByteArrayOutputStream();
		List<int[]> records = new ArrayList<>();
		for (int id = 1; id < names.length; id++) {
			byte[] text = names[id].getBytes(StandardCharsets.UTF_16BE);
			records.add(new int[] {id, text.length, strings.size()});
			strings.write(text, 0, text.length);
		}
		ByteBuffer table = ByteBuffer.allocate(6 + records.size() * 12 + strings.size());
		table.putShort((short) 0).putShort((short) records.size()).putShort((short) (6 + records.size() * 12));
		for (int[] record : records) {
			table.putShort((short) 3).putShort((short) 1).putShort((short) 0x409)
					.putShort((short) record[0]).putShort((short) record[1]).putShort((short) record[2]);
		}
		table.put(strings.toByteArray());
		return table.array();
	}

	/** The table directory (tables sorted by tag), the tables padded to four bytes, and the checksums. */
	private static byte[] assemble(Map<String, byte[]> tables) {
		int count = tables.size();
		int searchRange = 16 * Integer.highestOneBit(count);
		int size = 12 + 16 * count;
		for (byte[] table : tables.values()) {
			size += (table.length + 3) & ~3;
		}
		ByteBuffer font = ByteBuffer.allocate(size);
		font.putInt(0x00010000).putShort((short) count).putShort((short) searchRange)
				.putShort((short) Integer.numberOfTrailingZeros(Integer.highestOneBit(count)))
				.putShort((short) (count * 16 - searchRange));
		int offset = 12 + 16 * count;
		int headOffset = 0;
		for (Map.Entry<String, byte[]> table : tables.entrySet()) {
			byte[] data = table.getValue();
			font.put(table.getKey().getBytes(StandardCharsets.US_ASCII)).putInt((int) checksum(data)).putInt(offset).putInt(data.length);
			if (table.getKey().equals("head")) {
				headOffset = offset;
			}
			offset += (data.length + 3) & ~3;
		}
		for (byte[] data : tables.values()) {
			font.put(data);
			while (font.position() % 4 != 0) {
				font.put((byte) 0);
			}
		}
		byte[] bytes = font.array();
		ByteBuffer.wrap(bytes).putInt(headOffset + 8, (int) (0xB1B0AFBAL - checksum(bytes)));
		return bytes;
	}

	private static long checksum(byte[] data) {
		long sum = 0;
		for (int i = 0; i < data.length; i += 4) {
			long word = 0;
			for (int k = 0; k < 4; k++) {
				word = (word << 8) | (i + k < data.length ? data[i + k] & 0xFF : 0);
			}
			sum = (sum + word) & 0xFFFFFFFFL;
		}
		return sum;
	}
}
