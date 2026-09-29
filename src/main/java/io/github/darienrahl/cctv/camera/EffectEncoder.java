package io.github.darienrahl.cctv.camera;

import java.util.Set;
import java.util.function.IntConsumer;

import org.jspecify.annotations.Nullable;

import com.mojang.serialization.JsonOps;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction.Axis;
import net.minecraft.core.particles.BlockParticleOption;
import net.minecraft.core.particles.ExplosionParticleInfo;
import net.minecraft.core.particles.ParticleOptions;
import net.minecraft.core.particles.ParticleTypes;
import net.minecraft.core.particles.SimpleParticleType;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.protocol.game.ClientboundLevelParticlesPacket.RandomizationType;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.random.Weighted;
import net.minecraft.util.random.WeightedList;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.TamableAnimal;
import net.minecraft.world.entity.animal.Animal;
import net.minecraft.world.entity.animal.equine.AbstractHorse;
import net.minecraft.world.entity.npc.villager.Villager;
import net.minecraft.world.level.block.BonemealableBlock;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

import io.github.darienrahl.cctv.web.Json;

/**
 * The things the server sends a client that the client turns into particles, for the viewer to do the
 * same: level events (ClientboundLevelEventPacket: a block broken, dispenser smoke, bone meal...), particle
 * packets (ServerLevel#sendParticles), explosions (ClientboundExplodePacket) and the entity events whose
 * handleEntityEvent makes particles (a mob's death poof, hearts, villager moods). Each becomes one JSON
 * array in the "fx" list of the next entity frame; the viewer ports the client code that makes the particles.
 */
final class EffectEncoder {
	/** Level events drawn by the viewer as they come (LevelEventHandler#levelEvent). */
	private static final Set<Integer> LEVEL_EVENTS = Set.of(1501, 1502, 1503, 2000, 2001, 2004, 2008, 2009, 2010, 2014, 3000);

	private EffectEncoder() {
	}

	/** A level event, or the particles it stands for when the client decides them from its own blocks. */
	static @Nullable String levelEvent(ServerLevel level, int type, BlockPos pos, int data, IntConsumer blockStates) {
		switch (type) {
			case 1505:
				return growthParticles(level, pos, data);
			case 2011:
			case 2012:
				return particlesInBlock(level, pos, data, "minecraft:happy_villager");
			default:
				break;
		}
		if (!LEVEL_EVENTS.contains(type)) {
			return null;
		}
		if (type == 2001 || type == 2014) {
			// the broken block's state (Block.getId) goes into the viewer's palette for its particle texture
			blockStates.accept(data);
		}
		return "[\"le\"," + type + "," + pos.getX() + "," + pos.getY() + "," + pos.getZ() + "," + data + "]";
	}

	/** BoneMealItem.addGrowthParticles, resolved with the block that was fertilised. */
	private static @Nullable String growthParticles(ServerLevel level, BlockPos pos, int count) {
		BlockState state = level.getBlockState(pos);
		if (state.getBlock() instanceof BonemealableBlock bonemealable) {
			BlockPos particlePos = bonemealable.getParticlePos(pos);
			return switch (bonemealable.getType()) {
				case NEIGHBOR_SPREADER -> spawnParticles(particlePos, count * 3, 3.0, 1.0, false, "minecraft:happy_villager");
				case GROWER -> particlesInBlock(level, particlePos, count, "minecraft:happy_villager");
			};
		}
		if (state.is(Blocks.WATER)) {
			return spawnParticles(pos, count * 3, 3.0, 1.0, false, "minecraft:happy_villager");
		}
		return null;
	}

	/** ParticleUtils.spawnParticleInBlock: up to the top of the block's shape. */
	private static String particlesInBlock(ServerLevel level, BlockPos pos, int count, String particle) {
		BlockState state = level.getBlockState(pos);
		double height = state.isAir() ? 1.0 : state.getShape(level, pos).max(Axis.Y);
		return spawnParticles(pos, count, 0.5, height, true, particle);
	}

	/** A ParticleUtils.spawnParticles call for the viewer. */
	private static String spawnParticles(BlockPos pos, int count, double width, double height, boolean floating, String particle) {
		Json json = new Json(96);
		json.beginArray().value("ps").value(particle).value(pos.getX()).value(pos.getY()).value(pos.getZ()).value(count)
				.value(width, 3).value(height, 3).value(floating ? 1 : 0).endArray();
		return json.toString();
	}

	/** ServerLevel#sendParticles: what the ClientboundLevelParticlesPacket carries. */
	static String particles(ServerLevel level, ParticleOptions particle, boolean overrideLimiter, double x, double y, double z, int count,
			double xDist, double yDist, double zDist, double xSpeed, double ySpeed, double zSpeed, RandomizationType randomization,
			IntConsumer blockStates) {
		int random = randomization == RandomizationType.ALTERNATIVE_WITH_SPEED ? 2 : randomization.isAlternative() ? 1 : 0;
		Json json = new Json(160);
		json.beginArray().value("p").value(BuiltInRegistries.PARTICLE_TYPE.getKey(particle.getType()).toString())
				.value(x, 3).value(y, 3).value(z, 3).value(count)
				.value(xDist, 4).value(yDist, 4).value(zDist, 4).value(xSpeed, 4).value(ySpeed, 4).value(zSpeed, 4)
				.value(random).value(overrideLimiter ? 1 : 0);
		String options = options(level, particle, blockStates);
		if (options != null) {
			json.raw(options);
		}
		return json.endArray().toString();
	}

	/**
	 * The particle's options: {"b": block state} for block particles, else the game's own serialisation
	 * (ParticleTypes.CODEC: dust colour and scale, effect colours...); nothing for simple particles.
	 */
	private static @Nullable String options(ServerLevel level, ParticleOptions particle, IntConsumer blockStates) {
		if (particle instanceof BlockParticleOption block) {
			int id = Block.getId(block.getState());
			blockStates.accept(id);
			return "{\"b\":" + id + "}";
		}
		if (particle instanceof SimpleParticleType) {
			return null;
		}
		return ParticleTypes.CODEC.encodeStart(level.registryAccess().createSerializationContext(JsonOps.INSTANCE), particle)
				.result().map(Object::toString).orElse(null);
	}

	/**
	 * ClientboundExplodePacket: the explosion particle (the small or the large one, as ServerLevel#explode
	 * chose) and the block particles ClientExplosionTracker spreads over the blast.
	 */
	static String explosion(Vec3 center, float radius, int blockCount, ParticleOptions particle, WeightedList<ExplosionParticleInfo> blockParticles) {
		Json json = new Json(256);
		json.beginArray().value("ex").value(center.x(), 3).value(center.y(), 3).value(center.z(), 3).value(radius, 3).value(blockCount)
				.value(BuiltInRegistries.PARTICLE_TYPE.getKey(particle.getType()).toString());
		json.beginArray();
		for (Weighted<ExplosionParticleInfo> entry : blockParticles.unwrap()) {
			ExplosionParticleInfo info = entry.value();
			json.beginArray().value(BuiltInRegistries.PARTICLE_TYPE.getKey(info.particle().getType()).toString())
					.value(entry.weight()).value(info.scaling(), 3).value(info.speed(), 3).endArray();
		}
		return json.endArray().endArray().toString();
	}

	/**
	 * The particles an entity event makes in the client (which handleEntityEvent branch the entity's class
	 * runs): "poof" (LivingEntity 60 after dying, Mob 20 spawning), "love" (Animal 18), "tamed" and
	 * "untamed" (TamableAnimal and AbstractHorse 7 and 6), villager hearts, anger, happiness and splashes.
	 * The entity's position and size go along since it may be gone by the next frame.
	 */
	static @Nullable String entityEvent(Entity entity, byte event) {
		String kind = null;
		if (entity instanceof Villager) {
			kind = switch (event) {
				case 12 -> "villager_heart";
				case 13 -> "angry";
				case 14 -> "happy";
				case 42 -> "splash";
				default -> null;
			};
		}
		if (kind == null && event == 18 && entity instanceof Animal) {
			kind = "love";
		}
		if (kind == null && (event == 6 || event == 7) && (entity instanceof TamableAnimal || entity instanceof AbstractHorse)) {
			kind = event == 7 ? "tamed" : "untamed";
		}
		if (kind == null && (event == 60 && entity instanceof LivingEntity || event == 20 && entity instanceof Mob)) {
			kind = "poof";
		}
		if (kind == null) {
			return null;
		}
		Json json = new Json(96);
		json.beginArray().value("ee").value(kind).value(entity.getX(), 3).value(entity.getY(), 3).value(entity.getZ(), 3)
				.value(entity.getBbWidth(), 3).value(entity.getBbHeight(), 3).endArray();
		return json.toString();
	}
}
