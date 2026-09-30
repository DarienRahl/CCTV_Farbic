package io.github.darienrahl.cctv.camera;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import org.jspecify.annotations.Nullable;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.particles.ColorParticleOption;
import net.minecraft.core.particles.ParticleOptions;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.tags.BlockTags;
import net.minecraft.tags.FluidTags;
import net.minecraft.tags.TagKey;
import net.minecraft.util.Mth;
import net.minecraft.world.level.EmptyBlockGetter;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.FireBlock;
import net.minecraft.world.level.block.HalfTransparentBlock;
import net.minecraft.world.level.block.LeavesBlock;
import net.minecraft.world.level.block.RenderShape;
import net.minecraft.world.level.block.sounds.AmbientLeavesBlockSoundPlayer;
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
	/** In #blocks_fluid_flow: a fluid does not look past it at the fluid below for its flow (FlowingFluid.getFlow). */
	static final int FLAG_BLOCKS_FLUID_FLOW = 2048;

	private static final TagKey<Block> BLOCKS_FLUID_FLOW = TagKey.create(Registries.BLOCK,
			Identifier.withDefaultNamespace("blocks_fluid_flow"));
	/** FluidRenderer's MAX_FLUID_HEIGHT: the height a fluid's bottom face is tested with. */
	private static final float MAX_FLUID_HEIGHT = 0.8888889F;

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
			if (state.is(BLOCKS_FLUID_FLOW)) {
				flags |= FLAG_BLOCKS_FLUID_FLOW;
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
		writeParticleHints(json, state);

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

	private static @Nullable List<TagKey<Block>> viewerTags;

	/**
	 * The block tags the viewer's ports of client code check ({@code tg}): the desert, dried ghast and pale oak
	 * ambience, the blocks leaves need around them for their ambient sound and a conduit's frame blocks.
	 */
	private static List<TagKey<Block>> viewerTags() {
		if (viewerTags == null) {
			LinkedHashSet<TagKey<Block>> tags = new LinkedHashSet<>(List.of(
					BlockTags.TRIGGERS_AMBIENT_DESERT_SAND_BLOCK_SOUNDS,
					BlockTags.TRIGGERS_AMBIENT_DESERT_DRY_VEGETATION_BLOCK_SOUNDS,
					BlockTags.TERRACOTTA,
					BlockTags.PALE_OAK_LOGS,
					BlockTags.TRIGGERS_AMBIENT_DRIED_GHAST_BLOCK_SOUNDS,
					BlockTags.CONDUIT_EFFECT_BLOCK));
			for (Block block : BuiltInRegistries.BLOCK) {
				if (block instanceof LeavesBlock) {
					AmbientLeavesBlockSoundPlayer sounds = leavesSounds(block);
					if (sounds != null) {
						sounds.satisfyingBlocks().ifPresent(tags::add);
					}
				}
			}
			viewerTags = List.copyOf(tags);
		}
		return viewerTags;
	}

	/** LeavesBlock.ambientLeavesBlockSoundPlayer (found by its type). */
	private static @Nullable AmbientLeavesBlockSoundPlayer leavesSounds(Block block) {
		try {
			for (Class<?> type = block.getClass(); type != null && type != Block.class; type = type.getSuperclass()) {
				for (Field field : type.getDeclaredFields()) {
					if (!Modifier.isStatic(field.getModifiers()) && field.getType() == AmbientLeavesBlockSoundPlayer.class) {
						field.setAccessible(true);
						return (AmbientLeavesBlockSoundPlayer) field.get(block);
					}
				}
			}
		} catch (ReflectiveOperationException | RuntimeException e) {
			Problems.report(null, "leaves sounds", e);
		}
		return null;
	}

	private static final @Nullable Method CAN_BURN = findCanBurn();

	private static @Nullable Method findCanBurn() {
		try {
			Method method = FireBlock.class.getDeclaredMethod("canBurn", BlockState.class);
			method.setAccessible(true);
			return method;
		} catch (ReflectiveOperationException | RuntimeException e) {
			return null;
		}
	}

	/**
	 * What the viewer's ports of the blocks' animateTick need from the game's block objects: the falling leaf
	 * particle of leaves ({@code lp: [chance, particle id]}, no id for leaves tinted by the biome, {@code lpc}
	 * for a fixed colour), the ambient sound of leaves ({@code las}: [sound, chance, tag of the blocks needed next
	 * to them, how many, how many of the same leaves]), the block tags the viewer checks ({@code tg}) and whether
	 * fire burns the block ({@code fb}, fire next to it smokes). Read from the block instances, so new leaves and
	 * their chances come with a game version.
	 */
	private static void writeParticleHints(Json json, BlockState state) {
		Block block = state.getBlock();
		if (block instanceof LeavesBlock) {
			try {
				Float chance = null;
				ParticleOptions particle = null;
				for (Class<?> type = block.getClass(); type != null && type != Block.class; type = type.getSuperclass()) {
					for (Field field : type.getDeclaredFields()) {
						if (Modifier.isStatic(field.getModifiers())) {
							continue;
						}
						if (field.getType() == float.class && field.getName().toLowerCase(Locale.ROOT).contains("chance")) {
							field.setAccessible(true);
							chance = field.getFloat(block);
						} else if (ParticleOptions.class.isAssignableFrom(field.getType())) {
							field.setAccessible(true);
							particle = (ParticleOptions) field.get(block);
						}
					}
				}
				if (chance != null) {
					json.name("lp").beginArray().value(chance, 4)
							.value(particle == null ? null : BuiltInRegistries.PARTICLE_TYPE.getKey(particle.getType()).toString()).endArray();
					if (particle instanceof ColorParticleOption color) {
						json.field("lpc", Math.round(color.getRed() * 255) << 16 | Math.round(color.getGreen() * 255) << 8 | Math.round(color.getBlue() * 255));
					}
				}
			} catch (ReflectiveOperationException | RuntimeException e) {
				Problems.report(null, "leaf particles", e);
			}
		}
		if (block instanceof LeavesBlock) {
			AmbientLeavesBlockSoundPlayer sounds = leavesSounds(block);
			if (sounds != null && sounds.ambientSound().isPresent()) {
				json.name("las").beginArray()
						.value(sounds.ambientSound().get().value().location().toString())
						.value(sounds.chance())
						.value(sounds.satisfyingBlocks().map(tag -> tag.location().toString()).orElse(null))
						.value(sounds.nearbySatisfyingBlocksRequired())
						.value(sounds.nearbySameLeavesRequired())
						.endArray();
			}
		}
		try {
			List<String> tags = new ArrayList<>(2);
			for (TagKey<Block> tag : viewerTags()) {
				if (state.is(tag)) {
					tags.add(tag.location().toString());
				}
			}
			if (!tags.isEmpty()) {
				json.name("tg").beginArray();
				for (String tag : tags) {
					json.value(tag);
				}
				json.endArray();
			}
		} catch (RuntimeException e) {
			Problems.report(null, "block tags", e);
		}
		if (CAN_BURN != null) {
			try {
				if ((boolean) CAN_BURN.invoke(Blocks.FIRE, state)) {
					json.field("fb", true);
				}
			} catch (ReflectiveOperationException | RuntimeException e) {
				Problems.report(null, "flammability", e);
			}
		}
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

		writeFluidCover(json, state);
	}

	/**
	 * How the faces that are neither empty nor a whole block hide a fluid next to them or inside the block
	 * (FluidRenderer.isFaceOccludedByState with Shapes.blockOccludes): {@code fc} per face in 3D data order, for a
	 * side the height up to which a fluid's side face is hidden, for the top and bottom 1 when they hide a whole
	 * fluid face. Worked out with the game's own occlusion test, so any shape comes out as in the game.
	 */
	private static void writeFluidCover(Json json, BlockState state) {
		float[] cover = new float[6];
		boolean any = false;
		for (Direction face : Direction.values()) {
			try {
				VoxelShape occluder = state.getFaceOcclusionShape(face);
				if (occluder.isEmpty() || occluder == Shapes.block()) {
					continue;
				}
				// the fluid looks at this face from the other side (or from inside the block for its own faces)
				Direction towards = face.getOpposite();
				float covered = 0;
				if (face.getAxis() == Direction.Axis.Y) {
					float height = towards == Direction.DOWN ? MAX_FLUID_HEIGHT : 1.0F;
					covered = Shapes.blockOccludes(Shapes.box(0, 0, 0, 1, height, 1), occluder, towards) ? 1 : 0;
				} else {
					List<Double> heights = new ArrayList<>();
					for (AABB box : occluder.toAabbs()) {
						if (!heights.contains(box.maxY)) {
							heights.add(box.maxY);
						}
					}
					heights.sort(null);
					for (double height : heights) {
						if (height <= 0 || !Shapes.blockOccludes(Shapes.box(0, 0, 0, 1, height, 1), occluder, towards)) {
							break;
						}
						covered = (float) height;
					}
				}
				if (covered > 0) {
					cover[face.get3DDataValue()] = covered;
					any = true;
				}
			} catch (RuntimeException ignored) {
				// Not hidden.
			}
		}
		if (any) {
			json.name("fc").beginArray();
			for (float value : cover) {
				json.value(value, 4);
			}
			json.endArray();
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
