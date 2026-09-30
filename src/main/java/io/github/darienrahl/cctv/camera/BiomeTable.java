package io.github.darienrahl.cctv.camera;

import java.lang.reflect.Field;
import java.util.Locale;

import org.jspecify.annotations.Nullable;

import net.minecraft.core.Registry;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.biome.Biome;

import io.github.darienrahl.cctv.web.Json;

/**
 * Biome climate and colours, so the browser can tint grass, leaves and water
 * exactly like the client does (colormaps + biome overrides).
 */
final class BiomeTable {
	private BiomeTable() {
	}

	/** The table of the last registry (the same for every level of a server, so cameras share it). */
	private static volatile @Nullable Registry<Biome> cachedRegistry;
	private static volatile @Nullable String cachedJson;

	static String json(ServerLevel level) {
		Registry<Biome> registry = level.registryAccess().lookupOrThrow(Registries.BIOME);
		String json = cachedJson;
		if (registry != cachedRegistry || json == null) {
			json = build(registry);
			cachedJson = json;
			cachedRegistry = registry;
		}
		return json;
	}

	private static String build(Registry<Biome> registry) {
		Json json = new Json(8192);
		json.beginObject();
		for (Biome biome : registry) {
			Identifier id = registry.getKey(biome);
			if (id == null) {
				continue;
			}
			var effects = biome.getSpecialEffects();
			json.name(id.toString()).beginObject()
					.field("t", biome.getBaseTemperature(), 3)
					.field("d", downfall(biome), 3)
					.field("w", effects.waterColor() & 0xFFFFFF);
			effects.grassColorOverride().ifPresent(color -> json.field("g", color & 0xFFFFFF));
			effects.foliageColorOverride().ifPresent(color -> json.field("f", color & 0xFFFFFF));
			json.field("m", effects.grassColorModifier().name().toLowerCase(Locale.ROOT));
			json.endObject();
		}
		return json.endObject().toString();
	}

	/** Downfall is not exposed publicly; the game is unobfuscated, so the field can be read by name. */
	private static float downfall(Biome biome) {
		try {
			Field climate = Biome.class.getDeclaredField("climateSettings");
			climate.setAccessible(true);
			Object settings = climate.get(biome);
			Field downfall = settings.getClass().getDeclaredField("downfall");
			downfall.setAccessible(true);
			return downfall.getFloat(settings);
		} catch (ReflectiveOperationException | RuntimeException e) {
			return 0.5F;
		}
	}
}
