package io.github.darienrahl.cctv.web;

import org.jspecify.annotations.Nullable;

/**
 * What the web server needs from the game side. Implemented by the camera
 * manager; kept free of Minecraft classes so the web layer can be tested alone.
 */
public interface CameraDirectory {
	enum Subscription {
		OK,
		NOT_FOUND,
		FULL
	}

	/** JSON array describing all cameras. Called from web threads. */
	String camerasJson();

	/** Attaches a viewer to a camera. Called from web threads. */
	Subscription subscribe(String camera, Viewer viewer);

	/** JSON object with the state of the live camera sessions (for troubleshooting). Called from web threads. */
	default String statusJson() {
		return "{}";
	}

	/** The picture of a map in an item frame a camera saw, 128 x 128 RGBA, or null. Called from web threads. */
	default byte @Nullable [] mapPicture(int id) {
		return null;
	}
}
