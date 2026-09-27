package io.github.darienrahl.cctv.web;

import java.io.ByteArrayOutputStream;
import java.util.Base64;

/**
 * Encoding of world data for the browser. Everything is JSON sent over SSE.
 *
 * <p>A section is 16x16x16 block states (global state ids). It is sent as a
 * local palette plus run-length encoded palette indices in YZX order
 * ({@code index = (y * 16 + z) * 16 + x}), packed as varint pairs
 * {@code (runLength, paletteIndex)} and base64 encoded.
 */
public final class Protocol {
	public static final int SECTION_VOLUME = 16 * 16 * 16;

	private Protocol() {
	}

	public static String section(int sx, int sy, int sz, int[] states) {
		int[] palette = new int[16];
		int paletteSize = 0;
		ByteArrayOutputStream runs = new ByteArrayOutputStream(64);

		int runState = states[0];
		int runLength = 0;
		int lastState = Integer.MIN_VALUE;
		int lastIndex = -1;

		for (int i = 0; i <= SECTION_VOLUME; i++) {
			int state = i < SECTION_VOLUME ? states[i] : Integer.MIN_VALUE;
			if (i < SECTION_VOLUME && state == runState) {
				runLength++;
				continue;
			}

			// Flush the finished run.
			int index;
			if (runState == lastState) {
				index = lastIndex;
			} else {
				index = -1;
				for (int p = 0; p < paletteSize; p++) {
					if (palette[p] == runState) {
						index = p;
						break;
					}
				}
				if (index < 0) {
					if (paletteSize == palette.length) {
						palette = java.util.Arrays.copyOf(palette, paletteSize * 2);
					}
					palette[paletteSize] = runState;
					index = paletteSize++;
				}
				lastState = runState;
				lastIndex = index;
			}

			writeVarInt(runs, runLength);
			writeVarInt(runs, index);

			runState = state;
			runLength = 1;
		}

		Json json = new Json(64 + paletteSize * 6 + runs.size() * 4 / 3);
		json.beginObject()
				.field("x", sx)
				.field("y", sy)
				.field("z", sz)
				.name("p").beginArray();
		for (int p = 0; p < paletteSize; p++) {
			json.value(palette[p]);
		}
		json.endArray()
				.field("r", Base64.getEncoder().encodeToString(runs.toByteArray()))
				.endObject();
		return json.toString();
	}

	private static void writeVarInt(ByteArrayOutputStream out, int value) {
		while ((value & ~0x7F) != 0) {
			out.write((value & 0x7F) | 0x80);
			value >>>= 7;
		}
		out.write(value);
	}
}
