package io.github.darienrahl.cctv.web;

import org.jspecify.annotations.Nullable;

/**
 * A connected browser watching one camera. Implementations must be thread-safe:
 * messages are produced on the server thread and written on a network thread.
 */
public interface Viewer {
	/**
	 * Queues an ordered message (world data, palette, block changes, ...).
	 * Messages are delivered in the order they were queued.
	 */
	void send(String event, String json);

	/**
	 * Offers the newest entity frame. Frames that were not delivered yet are
	 * replaced, so a slow connection never falls behind "live".
	 */
	void sendEntities(String json);

	/** World messages queued but not yet written to the connection (how far the browser lags behind). */
	default int backlog() {
		return 0;
	}

	/** Identifies the connection to requests the browser makes beside it (its section cache manifest). */
	default String id() {
		return "";
	}

	/** Whether the browser keeps sections and sends which ones it has after "init" (see cache.js). */
	default boolean wantsCache() {
		return false;
	}

	/**
	 * The field of view the viewer shows (its own FOV setting, 30 to 110 degrees like the game's), or 0 for the
	 * camera's: a wider one widens the cone of sections the camera sends.
	 */
	default double fov() {
		return 0;
	}

	/**
	 * The sections the browser has cached, sent after the "init" numbered {@code epoch}: x, y, z and hash of
	 * each, one after the other; null while none arrived. Taking it clears it.
	 */
	default long @Nullable [] takeCacheManifest(int epoch) {
		return null;
	}

	boolean isOpen();

	void close();
}
