package io.github.darienrahl.cctv.web;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import org.jspecify.annotations.Nullable;

/**
 * Server-Sent Events connection. World messages are queued in order, entity
 * frames are coalesced so only the newest one is ever written.
 */
final class SseViewer implements Viewer {
	private static final Object ENTITY_SIGNAL = new Object();
	private static final Object CLOSE_SIGNAL = new Object();
	private static final byte[] HEARTBEAT = ": ping\n\n".getBytes(StandardCharsets.UTF_8);
	private static final long HEARTBEAT_SECONDS = 10;

	private final LinkedBlockingQueue<Object> queue = new LinkedBlockingQueue<>();
	private final AtomicReference<String> latestEntities = new AtomicReference<>();
	private final AtomicInteger queuedWorldMessages = new AtomicInteger();
	private final int maxQueuedMessages;
	private final String id;
	private final boolean wantsCache;
	/** The latest cache manifest and the "init" it answers. */
	private final AtomicReference<Manifest> manifest = new AtomicReference<>();
	private volatile boolean open = true;

	private record Manifest(int epoch, long[] sections) {
	}

	SseViewer(int maxQueuedMessages, String id, boolean wantsCache) {
		this.maxQueuedMessages = maxQueuedMessages;
		this.id = id;
		this.wantsCache = wantsCache;
	}

	@Override
	public String id() {
		return id;
	}

	@Override
	public boolean wantsCache() {
		return wantsCache;
	}

	/** Web thread: the browser's cache manifest arrived. */
	void setCacheManifest(int epoch, long[] sections) {
		manifest.set(new Manifest(epoch, sections));
	}

	@Override
	public long @Nullable [] takeCacheManifest(int epoch) {
		Manifest m = manifest.get();
		if (m == null || m.epoch() != epoch || !manifest.compareAndSet(m, null)) {
			return null;
		}
		return m.sections();
	}

	@Override
	public void send(String event, String json) {
		if (!open) {
			return;
		}

		if (queuedWorldMessages.incrementAndGet() > maxQueuedMessages) {
			// The browser cannot keep up (or the connection is dead); drop it and let it reconnect.
			close();
			return;
		}

		queue.offer(frame(event, json));
	}

	@Override
	public void sendEntities(String json) {
		if (open && latestEntities.getAndSet(json) == null) {
			queue.offer(ENTITY_SIGNAL);
		}
	}

	@Override
	public int backlog() {
		return queuedWorldMessages.get();
	}

	@Override
	public boolean isOpen() {
		return open;
	}

	@Override
	public void close() {
		if (open) {
			open = false;
			queue.offer(CLOSE_SIGNAL);
		}
	}

	/** Blocks the calling (web) thread and pumps messages until the viewer closes. */
	void run(OutputStream out) {
		try {
			while (open) {
				Object item = queue.poll(HEARTBEAT_SECONDS, TimeUnit.SECONDS);

				if (item == null) {
					out.write(HEARTBEAT);
					out.flush();
					continue;
				}

				// Write everything that is already waiting, then flush once.
				do {
					write(out, item);
					item = queue.poll();
				} while (item != null);

				out.flush();
			}
		} catch (IOException | InterruptedException e) {
			// Browser went away.
		} finally {
			open = false;
			queue.clear();
			latestEntities.set(null);
		}
	}

	private void write(OutputStream out, Object item) throws IOException {
		if (item == CLOSE_SIGNAL) {
			return;
		}

		if (item == ENTITY_SIGNAL) {
			String entities = latestEntities.getAndSet(null);
			if (entities != null) {
				out.write(frame("entities", entities));
			}
			return;
		}

		queuedWorldMessages.decrementAndGet();
		out.write((byte[]) item);
	}

	private static byte[] frame(String event, String json) {
		// JSON produced by Json never contains raw newlines, so a single data line is enough.
		return ("event: " + event + "\ndata: " + json + "\n\n").getBytes(StandardCharsets.UTF_8);
	}
}
