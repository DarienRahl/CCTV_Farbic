package io.github.darienrahl.cctv.camera;

import java.lang.reflect.Method;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.tags.FluidTags;
import net.minecraft.util.Mth;
import net.minecraft.world.level.EmptyBlockGetter;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.HalfTransparentBlock;
import net.minecraft.world.level.block.LeavesBlock;
import net.minecraft.world.level.block.RenderShape;
import net.minecraft.world.level.block.state.BlockBehaviour;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.shapes.Shapes;
import net.minecraft.world.phys.shapes.VoxelShape;

import io.github.darienrahl.cctv.web.Json;

/**
 * Describes block states for the browser: name, map colour, shape boxes and a
 * few render flags. The server has no textures (they live in the client jar),
 * so the viewer draws blocks from these descriptions. Server thread only.
 */
final class BlockPalette {
	static final int FLAG_AIR = 1;
	static final int FLAG_OPAQUE = 2;
	static final int FLAG_WATER = 4;
	static final int FLAG_LAVA = 8;
	static final int FLAG_NO_COLLISION = 16;
	/** Collision shape is a full block: it darkens neighbours in smooth lighting (ambient occlusion). */
	static final int FLAG_FULL_COLLISION = 32;
	/** Light passes through (smooth lighting looks past it for the corner samples). */
	static final int FLAG_LIGHT_PERMEABLE = 64;
	/** Not drawn from a block model (air-like or drawn by a block entity renderer, e.g. chests). */
	static final int FLAG_NO_MODEL = 128;
	/** Always rendered at full brightness (e.g. magma block). */
	static final int FLAG_EMISSIVE = 256;
	/** "Solid" in the legacy sense the fluid renderer uses for surface heights. */
	static final int FLAG_SOLID = 512;
	/** Water next to it shows the water overlay texture (glass, ice, leaves...). */
	static final int FLAG_WATER_OVERLAY = 1024;

	private static final BlockPos SEED_PROBE = new BlockPos(5, 70, 9);

	private static final int MAX_BOXES = 24;

	private final Map<Integer, String> cache = new HashMap<>();

	String describe(int id) {
		return cache.computeIfAbsent(id, BlockPalette::computeSafely);
	}

	/** A state the table cannot describe (changed game API, unusual modded block) still gets its name. */
	private static String computeSafely(int id) {
		try {
			return compute(id);
		} catch (RuntimeException | LinkageError e) {
			Problems.report(null, "block state " + id, e);
			BlockState state = Block.stateById(id);
			return new Json(96).beginObject()
					.field("id", id)
					.field("n", BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString())
					.field("f", 0)
					.name("b").raw("[[0,0,0,1,1,1]]")
					.endObject().toString();
		}
	}

	private static String compute(int id) {
		BlockState state = Block.stateById(id);
		Json json = new Json(160);
		json.beginObject()
				.field("id", id)
				.field("n", BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString());

		String properties = properties(state);
		if (!properties.isEmpty()) {
			json.field("s", properties);
		}

		if (state.isAir()) {
			json.field("f", FLAG_AIR).endObject();
			return json.toString();
		}

		int flags = 0;
		int color = 0;
		try {
			color = state.getMapColor(EmptyBlockGetter.INSTANCE, BlockPos.ZERO).col;
		} catch (RuntimeException ignored) {
			// Some modded blocks need a real level here.
		}

		try {
			if (state.isSolidRender()) {
				flags |= FLAG_OPAQUE;
			}
			if (state.isLightPermeable()) {
				flags |= FLAG_LIGHT_PERMEABLE;
			}
			if (state.getRenderShape() != RenderShape.MODEL) {
				flags |= FLAG_NO_MODEL;
			}
			if (state.emissiveRendering()) {
				flags |= FLAG_EMISSIVE;
			}
			if (state.isSolid()) {
				flags |= FLAG_SOLID;
			}
			if (state.getBlock() instanceof HalfTransparentBlock || state.getBlock() instanceof LeavesBlock) {
				flags |= FLAG_WATER_OVERLAY;
			}
		} catch (RuntimeException ignored) {
			// Keep what is known.
		}

		FluidState fluid = state.getFluidState();
		if (!fluid.isEmpty()) {
			flags |= fluid.is(FluidTags.LAVA) ? FLAG_LAVA : FLAG_WATER;
			json.field("lv", fluid.getAmount());
		}

		List<AABB> boxes = List.of();
		try {
			VoxelShape shape = state.getShape(EmptyBlockGetter.INSTANCE, BlockPos.ZERO);
			boxes = shape.toAabbs();
			if (state.getCollisionShape(EmptyBlockGetter.INSTANCE, BlockPos.ZERO).isEmpty()) {
				flags |= FLAG_NO_COLLISION;
			}
			if (state.isCollisionShapeFullBlock(EmptyBlockGetter.INSTANCE, BlockPos.ZERO)) {
				flags |= FLAG_FULL_COLLISION;
			}
		} catch (RuntimeException e) {
			boxes = List.of(new AABB(0, 0, 0, 1, 1, 1));
		}

		int light = 0;
		try {
			light = state.getLightEmission();
		} catch (RuntimeException ignored) {
			// No light.
		}

		json.field("c", color).field("f", flags);
		if (light > 0) {
			json.field("l", light);
		}
		writeRenderHints(json, state);

		json.name("b").beginArray();
		int count = 0;
		for (AABB box : boxes) {
			if (count++ >= MAX_BOXES) {
				break;
			}
			json.beginArray()
					.value(box.minX, 4).value(box.minY, 4).value(box.minZ, 4)
					.value(box.maxX, 4).value(box.maxY, 4).value(box.maxZ, 4)
					.endArray();
		}
		json.endArray().endObject();
		return json.toString();
	}

	/**
	 * What the client's block renderer needs besides the model: shade brightness for ambient occlusion
	 * ({@code sb}), the random model offset of plants ({@code o: [horizontal, vertical]}), which block
	 * position seeds the random model variant ({@code sy: -1} for upper halves of doors and tall plants),
	 * which faces are completely covered ({@code fo}, bit per direction, opaque blocks cover all) and on which
	 * sides identical neighbours hide each other ({@code k}). Directions are numbered like the game's
	 * (down, up, north, south, west, east).
	 */
	private static void writeRenderHints(Json json, BlockState state) {
		try {
			float shade = state.getShadeBrightness(EmptyBlockGetter.INSTANCE, BlockPos.ZERO);
			if (shade != 1.0F) {
				json.field("sb", shade, 3);
			}
		} catch (RuntimeException ignored) {
			// Default 1.0.
		}

		try {
			if (state.hasOffsetFunction()) {
				Block block = state.getBlock();
				boolean vertical = state.getOffset(BlockPos.ZERO).y != 0 || state.getOffset(new BlockPos(1, 0, 0)).y != 0
						|| state.getOffset(new BlockPos(0, 0, 3)).y != 0;
				json.name("o").beginArray().value(maxOffset(block, "getMaxHorizontalOffset", 0.25F), 4)
						.value(vertical ? maxOffset(block, "getMaxVerticalOffset", 0.2F) : 0, 4).endArray();
			}
		} catch (RuntimeException ignored) {
			// No offset.
		}

		try {
			long seed = state.getSeed(SEED_PROBE);
			if (seed != Mth.getSeed(SEED_PROBE) && seed == Mth.getSeed(SEED_PROBE.below())) {
				json.field("sy", -1);
			}
		} catch (RuntimeException ignored) {
			// Default seed.
		}

		int occluding = 0;
		for (Direction direction : Direction.values()) {
			try {
				if (state.getFaceOcclusionShape(direction) == Shapes.block()) {
					occluding |= 1 << direction.get3DDataValue();
				}
			} catch (RuntimeException ignored) {
				// Not occluding.
			}
		}
		if (occluding != 0 && occluding != 63) {
			json.field("fo", occluding);
		} else if (occluding == 63 && !state.isSolidRender()) {
			json.field("fo", 63);
		}

		int skip = 0;
		for (Direction direction : Direction.values()) {
			try {
				if (state.skipRendering(state, direction)) {
					skip |= 1 << direction.get3DDataValue();
				}
			} catch (RuntimeException ignored) {
				// Draw the face.
			}
		}
		if (skip != 0) {
			json.field("k", skip);
		}
	}

	/** The limits are protected in BlockBehaviour (and overridden by bamboo, dripstone...); read them reflectively. */
	private static float maxOffset(Block block, String method, float fallback) {
		try {
			Method getter = BlockBehaviour.class.getDeclaredMethod(method);
			getter.setAccessible(true);
			return (float) getter.invoke(block);
		} catch (ReflectiveOperationException | RuntimeException e) {
			return fallback;
		}
	}

	/** {@code Block{minecraft:oak_log}[axis=y]} → {@code axis=y}. */
	private static String properties(BlockState state) {
		String text = state.toString();
		int open = text.indexOf('[');
		int close = text.lastIndexOf(']');
		return open >= 0 && close > open ? text.substring(open + 1, close) : "";
	}
}
