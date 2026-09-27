package io.github.darienrahl.cctv.camera;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.level.EmptyBlockGetter;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.AABB;
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

	private static final int MAX_BOXES = 24;

	private final Map<Integer, String> cache = new HashMap<>();

	String describe(int id) {
		return cache.computeIfAbsent(id, BlockPalette::compute);
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
		} catch (RuntimeException ignored) {
			// Treat as not opaque.
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

	/** {@code Block{minecraft:oak_log}[axis=y]} → {@code axis=y}. */
	private static String properties(BlockState state) {
		String text = state.toString();
		int open = text.indexOf('[');
		int close = text.lastIndexOf(']');
		return open >= 0 && close > open ? text.substring(open + 1, close) : "";
	}
}
