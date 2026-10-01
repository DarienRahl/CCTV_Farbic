package io.github.darienrahl.cctv.camera;

import java.util.Locale;

import org.jspecify.annotations.Nullable;
import org.joml.Vector3fc;
import org.joml.Vector4fc;

import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.sounds.Music;
import net.minecraft.sounds.Musics;
import net.minecraft.util.Mth;
import net.minecraft.util.RandomSource;
import net.minecraft.world.attribute.AmbientAdditionsSettings;
import net.minecraft.world.attribute.AmbientSounds;
import net.minecraft.world.attribute.BackgroundMusic;
import net.minecraft.world.attribute.EnvironmentAttributeReader;
import net.minecraft.world.attribute.EnvironmentAttributes;
import net.minecraft.world.level.biome.BiomeManager;
import net.minecraft.world.level.border.WorldBorder;
import net.minecraft.world.level.dimension.DimensionType;
import net.minecraft.world.phys.Vec3;

import io.github.darienrahl.cctv.web.Json;

/**
 * Sky, fog, light and weather as the client would see them at the camera.
 *
 * <p>Since 26.x all of this is data driven ("environment attributes": dimension,
 * biome, day/night timeline and weather layers). The server evaluates the same
 * attribute system, so the viewer gets exactly the values the game uses and
 * only applies the client's formulas (lightmap, sky, fog) on top.
 */
final class EnvironmentSampler {
	/** The values change slowly; the viewer interpolates between samples. */
	static final int INTERVAL_TICKS = 5;

	/** The structure song TIMM last chose at the camera (like the mod, it is kept after leaving the structure). */
	private @Nullable String timmStructure;
	private long timmCheckedAt = Long.MIN_VALUE;

	/** Constant properties of the camera's dimension (sent once, in "init"). */
	static void writeDimension(Json json, ServerLevel level) {
		DimensionType type = level.dimensionType();
		json.name("dim").beginObject()
				.field("id", level.dimension().identifier().toString())
				.field("skybox", type.skybox().name().toLowerCase(Locale.ROOT))
				.field("cardinal", type.cardinalLightType().getSerializedName())
				.field("hasSky", type.hasSkyLight())
				.field("ceiling", type.hasCeiling())
				.field("ambient", type.ambientLight(), 3)
				.field("endFlashes", type.hasEndFlashes())
				.field("minY", level.getMinY())
				.field("height", level.getHeight())
				.field("seaLevel", level.getSeaLevel())
				// The client's horizon (dark lower sky disc below it): world bottom on superflat worlds, 63 otherwise.
				.field("horizon", level.isFlat() ? level.getMinY() : 63)
				// The hashed seed the client gets at login, for the same fuzzy biome borders (BiomeManager).
				.field("zoomSeed", Long.toString(BiomeManager.obfuscateSeed(level.getSeed())))
				.endObject();
	}

	String json(ServerLevel level, Camera camera, long tick) {
		Vec3 pos = new Vec3(camera.x(), camera.y(), camera.z());
		EnvironmentAttributeReader attributes = level.environmentAttributes();
		Json json = new Json(1024);
		json.beginObject()
				.field("t", tick)
				.field("time", level.getOverworldClockTime())
				.field("clock", level.getDefaultClockTime())
				.field("gt", level.getGameTime())
				.field("rain", level.getRainLevel(1.0F), 4)
				.field("thunder", level.getThunderLevel(1.0F), 4);
		// /tick freeze: the clients stop ticking entities, particles, block animations and textures
		if (!level.tickRateManager().runsNormally()) {
			json.field("frozen", true);
		}

		color(json, "sky", attributes.getValue(EnvironmentAttributes.SKY_COLOR, pos));
		color(json, "fog", attributes.getValue(EnvironmentAttributes.FOG_COLOR, pos));
		color(json, "sunrise", attributes.getValue(EnvironmentAttributes.SUNRISE_SUNSET_COLOR, pos));
		color(json, "cloud", attributes.getValue(EnvironmentAttributes.CLOUD_COLOR, pos));
		json.field("cloudHeight", attributes.getValue(EnvironmentAttributes.CLOUD_HEIGHT, pos), 3)
				.field("sunAngle", attributes.getValue(EnvironmentAttributes.SUN_ANGLE, pos), 3)
				.field("moonAngle", attributes.getValue(EnvironmentAttributes.MOON_ANGLE, pos), 3)
				.field("starAngle", attributes.getValue(EnvironmentAttributes.STAR_ANGLE, pos), 3)
				.field("stars", attributes.getValue(EnvironmentAttributes.STAR_BRIGHTNESS, pos), 4)
				.field("moonPhase", attributes.getValue(EnvironmentAttributes.MOON_PHASE, pos).index());

		color(json, "skyLight", attributes.getValue(EnvironmentAttributes.SKY_LIGHT_COLOR, pos));
		json.field("skyFactor", attributes.getValue(EnvironmentAttributes.SKY_LIGHT_FACTOR, pos), 4);
		// Level#getSkyDarken: how much the sky light is lowered for brightness checks (entity shadows)
		json.field("skyDarken", level.getSkyDarken());
		color(json, "ambient", attributes.getValue(EnvironmentAttributes.AMBIENT_LIGHT_COLOR, pos));
		color(json, "blockTint", attributes.getValue(EnvironmentAttributes.BLOCK_LIGHT_TINT, pos));
		color(json, "nightVision", attributes.getValue(EnvironmentAttributes.NIGHT_VISION_COLOR, pos));

		json.field("fogStart", attributes.getValue(EnvironmentAttributes.FOG_START_DISTANCE, pos), 2)
				.field("fogEnd", attributes.getValue(EnvironmentAttributes.FOG_END_DISTANCE, pos), 2)
				.field("skyFogEnd", attributes.getValue(EnvironmentAttributes.SKY_FOG_END_DISTANCE, pos), 2)
				.field("cloudFogEnd", attributes.getValue(EnvironmentAttributes.CLOUD_FOG_END_DISTANCE, pos), 2);
		color(json, "waterFog", attributes.getValue(EnvironmentAttributes.WATER_FOG_COLOR, pos));
		json.field("waterFogStart", attributes.getValue(EnvironmentAttributes.WATER_FOG_START_DISTANCE, pos), 2)
				.field("waterFogEnd", attributes.getValue(EnvironmentAttributes.WATER_FOG_END_DISTANCE, pos), 2);

		writeAmbientSounds(json, attributes.getValue(EnvironmentAttributes.AMBIENT_SOUNDS, pos));
		writeMusic(json, attributes.getValue(EnvironmentAttributes.BACKGROUND_MUSIC, pos), !level.getDragons().isEmpty());
		// block ambience that depends on the time and place: creaking hearts creak, firefly bushes chirp
		if (attributes.getValue(EnvironmentAttributes.CREAKING_ACTIVE, pos)) {
			json.field("creaking", true);
		}
		if (attributes.getValue(EnvironmentAttributes.FIREFLY_BUSH_SOUNDS, pos)) {
			json.field("fireflies", true);
		}
		// what dry stalactites drip (PointedDripstoneBlock.getDripParticle) and whether mud dries out instead
		json.field("drip", BuiltInRegistries.PARTICLE_TYPE.getKey(attributes.getValue(EnvironmentAttributes.DEFAULT_DRIPSTONE_PARTICLE, pos).getType()).toString());
		if (attributes.getValue(EnvironmentAttributes.WATER_EVAPORATES, pos)) {
			json.field("evaporates", true);
		}

		// WorldBorderRenderer.extract: the border's sides now (they move while it grows or shrinks) and its status colour
		WorldBorder border = level.getWorldBorder();
		json.name("border").beginArray()
				.value(border.getMinX(1.0F), 2).value(border.getMaxX(1.0F), 2)
				.value(border.getMinZ(1.0F), 2).value(border.getMaxZ(1.0F), 2)
				.endArray()
				.field("borderTint", border.getStatus().getColor());

		BlockPos blockPos = BlockPos.containing(pos);
		if (level.getChunkSource().getChunkNow(blockPos.getX() >> 4, blockPos.getZ() >> 4) != null) {
			json.field("precipitation", level.getBiome(blockPos).value().hasPrecipitation());
		}

		// The Immersive Music Mod's structure music, checked once a second like the mod does for players
		TimmStructures timm = TimmStructures.get();
		if (timm != null) {
			if (tick - timmCheckedAt >= 20) {
				timmCheckedAt = tick;
				String found = timm.eventAt(level, blockPos);
				if (found != null) {
					timmStructure = found;
				}
			}
			if (timmStructure != null) {
				json.field("timm", timmStructure);
			}
		}

		if (level.dimensionType().hasEndFlashes()) {
			long clock = level.getDefaultClockTime();
			json.name("flash").beginArray();
			writeFlash(json, clock / 600L);
			writeFlash(json, clock / 600L + 1);
			json.endArray();
		}
		return json.endObject().toString();
	}

	/**
	 * The biome's ambient sounds at the camera (BiomeAmbientSoundsHandler plays them): the loop, the mood (cave
	 * sounds in the dark: [sound, tick delay, block search extent, offset]) and the random additions ([sound, chance]).
	 */
	private static void writeAmbientSounds(Json json, AmbientSounds sounds) {
		if (sounds.loop().isEmpty() && sounds.mood().isEmpty() && sounds.additions().isEmpty()) {
			return;
		}
		json.name("amb").beginObject();
		sounds.loop().ifPresent(loop -> json.field("loop", loop.value().location().toString()));
		sounds.mood().ifPresent(mood -> json.name("mood").beginArray()
				.value(mood.soundEvent().value().location().toString())
				.value(mood.tickDelay())
				.value(mood.blockSearchExtent())
				.value(mood.soundPositionOffset(), 3)
				.endArray());
		if (!sounds.additions().isEmpty()) {
			json.name("add").beginArray();
			for (AmbientAdditionsSettings addition : sounds.additions()) {
				json.beginArray().value(addition.soundEvent().value().location().toString()).value(addition.tickChance(), 6).endArray();
			}
			json.endArray();
		}
		json.endObject();
	}

	/**
	 * What Minecraft.getSituationalMusic chooses from at the camera: the place's BackgroundMusic (default and
	 * underwater, each [sound, min delay, max delay, replace current]) and whether the dragon fight's boss music
	 * plays instead (a camera is never in creative mode).
	 */
	private static void writeMusic(Json json, BackgroundMusic music, boolean dragon) {
		if (music.defaultMusic().isEmpty() && music.underwaterMusic().isEmpty() && !dragon) {
			return;
		}
		json.name("music").beginObject();
		music.defaultMusic().ifPresent(m -> writeMusic(json, "d", m));
		music.underwaterMusic().ifPresent(m -> writeMusic(json, "u", m));
		if (dragon) {
			writeMusic(json, "boss", Musics.END_BOSS);
		}
		json.endObject();
	}

	private static void writeMusic(Json json, String name, Music music) {
		json.name(name).beginArray().value(music.sound().value().location().toString()).value(music.minDelay())
				.value(music.maxDelay()).value(music.replaceCurrentMusic()).endArray();
	}

	/** The client's EndFlashState for one 600 tick period: [period, offset, duration, xAngle, yAngle]. */
	private static void writeFlash(Json json, long period) {
		RandomSource random = RandomSource.createThreadLocalInstance(period);
		random.nextFloat();
		int offset = Mth.randomBetweenInclusive(random, 0, 200);
		int duration = Mth.randomBetweenInclusive(random, 100, Math.min(380, 600 - offset));
		float xAngle = Mth.randomBetween(random, -60.0F, 10.0F);
		float yAngle = Mth.randomBetween(random, -180.0F, 180.0F);
		json.beginArray().value(period).value(offset).value(duration).value(xAngle, 3).value(yAngle, 3).endArray();
	}

	private static void color(Json json, String name, Vector3fc color) {
		json.name(name).beginArray().value(color.x(), 4).value(color.y(), 4).value(color.z(), 4).endArray();
	}

	private static void color(Json json, String name, Vector4fc color) {
		json.name(name).beginArray().value(color.x(), 4).value(color.y(), 4).value(color.z(), 4).value(color.w(), 4).endArray();
	}
}
