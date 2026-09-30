package io.github.darienrahl.cctv.camera;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import org.jspecify.annotations.Nullable;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import net.fabricmc.loader.api.FabricLoader;
import net.fabricmc.loader.api.ModContainer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.SectionPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.TagKey;
import net.minecraft.world.level.StructureManager;
import net.minecraft.world.level.biome.Biome;
import net.minecraft.world.level.levelgen.structure.Structure;
import net.minecraft.world.level.levelgen.structure.StructurePiece;
import net.minecraft.world.level.levelgen.structure.StructureStart;

/**
 * The structure music of The Immersive Music Mod (TIMM) at a camera, when that mod is installed on the server:
 * like its ServerPlayerMixin does for a player once a second, the structures within two chunks of the camera are
 * looked at and the song event of the first one whose pieces, grown by the structure's distance, hold the camera
 * is the one to play ({@code timm:village}...). Distances and songs come from TIMM's structure_playlists.json,
 * the server's {@code config/timm/} copy first, then the mod's own.
 */
final class TimmStructures {
	private static final String TIMM = "timm";
	private static volatile @Nullable Optional<TimmStructures> loaded;

	private final Map<String, Integer> distanceByStructure = new HashMap<>();
	private final Map<String, String> eventByStructure = new HashMap<>();

	/** TIMM's structure playlists, or null when TIMM is not installed or its structure music is turned off. */
	static @Nullable TimmStructures get() {
		Optional<TimmStructures> current = loaded;
		if (current == null) {
			current = Optional.ofNullable(load());
			loaded = current;
		}
		return current.orElse(null);
	}

	private static @Nullable TimmStructures load() {
		FabricLoader loader = FabricLoader.getInstance();
		Optional<ModContainer> mod = loader.getModContainer(TIMM);
		if (mod.isEmpty()) {
			return null;
		}
		try {
			Path general = loader.getConfigDir().resolve(TIMM).resolve("general.json");
			if (Files.isRegularFile(general)) {
				JsonObject config = JsonParser.parseString(Files.readString(general)).getAsJsonObject();
				if (config.has("enableStructureMusic") && !config.get("enableStructureMusic").getAsBoolean()) {
					return null;
				}
			}
			Path file = loader.getConfigDir().resolve(TIMM).resolve("structure_playlists.json");
			if (!Files.isRegularFile(file)) {
				file = mod.get().findPath("assets/timm/custom/structure_playlists.json").orElse(null);
			}
			if (file == null || !Files.isRegularFile(file)) {
				return null;
			}
			TimmStructures structures = new TimmStructures();
			for (Map.Entry<String, JsonElement> entry : JsonParser.parseString(Files.readString(file)).getAsJsonObject().entrySet()) {
				JsonObject playlist = entry.getValue().getAsJsonObject();
				int distance = playlist.has("distance") ? playlist.get("distance").getAsInt() : 0;
				String event = TIMM + ":" + entry.getKey();
				for (JsonElement structure : playlist.getAsJsonArray("structures")) {
					structures.distanceByStructure.put(structure.getAsString(), distance);
					structures.eventByStructure.put(structure.getAsString(), event);
				}
			}
			return structures;
		} catch (Exception e) {
			Problems.report(null, "TIMM structure playlists", e);
			return null;
		}
	}

	/** The song event of the structure the camera is in or near, or null. Server thread. */
	@Nullable String eventAt(ServerLevel level, BlockPos pos) {
		StructureManager manager = level.structureManager();
		for (int i = -2; i <= 2; i++) {
			for (int j = -2; j <= 2; j++) {
				BlockPos probe = pos.offset(16 * i, 0, 16 * j);
				if (level.getChunkSource().getChunkNow(probe.getX() >> 4, probe.getZ() >> 4) == null) {
					continue;
				}
				SectionPos section = SectionPos.of(probe);
				Set<Structure> structures = manager.getAllStructuresAt(probe).keySet();
				for (Structure structure : structures) {
					Optional<TagKey<Biome>> tag = structure.biomes().unwrapKey();
					if (tag.isEmpty()) {
						continue;
					}
					String name = name(tag.get());
					Integer distance = distanceByStructure.get(name);
					String event = eventByStructure.get(name);
					if (distance != null && event != null && contains(manager, section, structure, distance, pos)) {
						return event;
					}
				}
			}
		}
		return null;
	}

	private static boolean contains(StructureManager manager, SectionPos section, Structure structure, int expansion, BlockPos pos) {
		for (StructureStart start : manager.startsForStructure(section.x(), section.z(), structure)) {
			for (StructurePiece piece : start.getPieces()) {
				if (piece.getBoundingBox().inflatedBy(expansion).isInside(pos)) {
					return true;
				}
			}
		}
		return false;
	}

	/** TIMM names a structure by its biome tag: the last part of the tag's path ("has_structure/village_plains"). */
	private static String name(TagKey<Biome> tag) {
		String[] parts = tag.location().getPath().split("/");
		return parts[parts.length - 1];
	}
}
