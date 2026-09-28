package io.github.darienrahl.cctv.web;

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

	boolean isOpen();

	void close();
}
