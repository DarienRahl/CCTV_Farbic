package io.github.darienrahl.cctv.camera;

import java.util.regex.Pattern;

import io.github.darienrahl.cctv.web.Json;

/**
 * A placed camera. {@code x/y/z} is the lens position, {@code yaw/pitch} use
 * Minecraft conventions (yaw 0 = south, pitch 90 = straight down), {@code fov}
 * is the vertical field of view in degrees and {@code range} the view distance.
 */
public record Camera(String name, String dimension, double x, double y, double z, float yaw, float pitch, double fov, int range) {
	public static final Pattern NAME = Pattern.compile("^[A-Za-z0-9_-]{1,32}$");

	public String key() {
		return name.toLowerCase(java.util.Locale.ROOT);
	}

	public Camera withPlacement(String dimension, double x, double y, double z, float yaw, float pitch) {
		return new Camera(name, dimension, x, y, z, yaw, pitch, fov, range);
	}

	public Camera withRotation(float yaw, float pitch) {
		return new Camera(name, dimension, x, y, z, yaw, pitch, fov, range);
	}

	public Camera withFov(double fov) {
		return new Camera(name, dimension, x, y, z, yaw, pitch, fov, range);
	}

	public Camera withRange(int range) {
		return new Camera(name, dimension, x, y, z, yaw, pitch, fov, range);
	}

	/** Rotation (yaw, pitch) that makes a camera at this position look at the given point. */
	public static float[] lookAt(double fromX, double fromY, double fromZ, double toX, double toY, double toZ) {
		double dx = toX - fromX;
		double dy = toY - fromY;
		double dz = toZ - fromZ;
		double horizontal = Math.sqrt(dx * dx + dz * dz);
		float yaw = (float) Math.toDegrees(Math.atan2(-dx, dz));
		float pitch = (float) -Math.toDegrees(Math.atan2(dy, horizontal));
		return new float[]{yaw, pitch};
	}

	public void writeJson(Json json, int viewers) {
		json.beginObject()
				.field("name", name)
				.field("dimension", dimension)
				.field("x", x, 3)
				.field("y", y, 3)
				.field("z", z, 3)
				.field("yaw", yaw, 2)
				.field("pitch", pitch, 2)
				.field("fov", fov, 2)
				.field("range", range)
				.field("viewers", viewers)
				.endObject();
	}
}
