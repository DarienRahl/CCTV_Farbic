package io.github.darienrahl.cctv.camera;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Errors from features that touch the game are reported once per feature and kind of error, then
 * the feature carries on without the failing part. After a game update a changed API (a
 * {@link LinkageError}) or an entity or block the mod does not know then costs a detail of the
 * picture, never the server.
 */
public final class Problems {
	private static final Logger LOGGER = LoggerFactory.getLogger("cctv");
	private static final Set<String> REPORTED = ConcurrentHashMap.newKeySet();

	private Problems() {
	}

	public static void report(@Nullable Logger logger, String what, Throwable error) {
		if (REPORTED.size() < 500 && REPORTED.add(what + "|" + error.getClass().getName() + "|" + error.getMessage())) {
			(logger != null ? logger : LOGGER).warn("CCTV: {} failed ({}); skipping it. Please report this with your Minecraft and mod version.",
					what, error.toString(), error);
		}
	}
}
