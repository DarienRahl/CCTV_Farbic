package io.github.darienrahl.cctv.web;

import java.util.Locale;

/**
 * Minimal allocation-friendly JSON writer. The streaming protocol sends many
 * small objects per tick, so this avoids building intermediate trees.
 */
public final class Json {
	private final StringBuilder sb;
	private boolean needComma;

	public Json() {
		this(256);
	}

	public Json(int capacity) {
		this.sb = new StringBuilder(capacity);
	}

	/** Position to go back to with {@link #reset} (drops a half-written value after an error). */
	public long mark() {
		return ((long) sb.length() << 1) | (needComma ? 1 : 0);
	}

	public void reset(long mark) {
		sb.setLength((int) (mark >>> 1));
		needComma = (mark & 1) != 0;
	}

	public Json beginObject() {
		comma();
		sb.append('{');
		needComma = false;
		return this;
	}

	public Json endObject() {
		sb.append('}');
		needComma = true;
		return this;
	}

	public Json beginArray() {
		comma();
		sb.append('[');
		needComma = false;
		return this;
	}

	public Json endArray() {
		sb.append(']');
		needComma = true;
		return this;
	}

	public Json name(String name) {
		comma();
		quote(sb, name);
		sb.append(':');
		needComma = false;
		return this;
	}

	public Json value(String value) {
		comma();
		if (value == null) {
			sb.append("null");
		} else {
			quote(sb, value);
		}
		needComma = true;
		return this;
	}

	public Json value(long value) {
		comma();
		sb.append(value);
		needComma = true;
		return this;
	}

	public Json value(boolean value) {
		comma();
		sb.append(value);
		needComma = true;
		return this;
	}

	/** Writes a number rounded to {@code decimals} places without trailing zeros. */
	public Json value(double value, int decimals) {
		comma();
		appendNumber(sb, value, decimals);
		needComma = true;
		return this;
	}

	/** Appends an already serialized JSON fragment as a value. */
	public Json raw(String json) {
		comma();
		sb.append(json);
		needComma = true;
		return this;
	}

	public Json field(String name, String value) {
		return name(name).value(value);
	}

	public Json field(String name, long value) {
		return name(name).value(value);
	}

	public Json field(String name, boolean value) {
		return name(name).value(value);
	}

	public Json field(String name, double value, int decimals) {
		return name(name).value(value, decimals);
	}

	private void comma() {
		if (needComma) {
			sb.append(',');
		}
	}

	@Override
	public String toString() {
		return sb.toString();
	}

	public static void appendNumber(StringBuilder sb, double value, int decimals) {
		if (!Double.isFinite(value)) {
			sb.append('0');
			return;
		}

		double scale = Math.pow(10, decimals);
		double rounded = Math.round(value * scale) / scale;

		if (rounded == Math.rint(rounded) && Math.abs(rounded) < 1e15) {
			sb.append((long) rounded);
			return;
		}

		String s = String.format(Locale.ROOT, "%." + decimals + "f", rounded);
		int end = s.length();
		while (end > 0 && s.charAt(end - 1) == '0') {
			end--;
		}
		if (end > 0 && s.charAt(end - 1) == '.') {
			end--;
		}
		sb.append(s, 0, end);
	}

	public static String quote(String value) {
		StringBuilder sb = new StringBuilder(value.length() + 2);
		quote(sb, value);
		return sb.toString();
	}

	public static void quote(StringBuilder sb, String value) {
		sb.append('"');
		for (int i = 0; i < value.length(); i++) {
			char c = value.charAt(i);
			switch (c) {
				case '"' -> sb.append("\\\"");
				case '\\' -> sb.append("\\\\");
				case '\n' -> sb.append("\\n");
				case '\r' -> sb.append("\\r");
				case '\t' -> sb.append("\\t");
				case '<' -> sb.append("\\u003c");
				case '>' -> sb.append("\\u003e");
				default -> {
					if (c < 0x20 || c == 0x2028 || c == 0x2029) {
						sb.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
					} else {
						sb.append(c);
					}
				}
			}
		}
		sb.append('"');
	}
}
