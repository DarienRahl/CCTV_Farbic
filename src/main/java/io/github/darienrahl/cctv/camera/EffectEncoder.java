package io.github.darienrahl.cctv.camera;

import java.util.List;
import java.util.Set;
import java.util.function.IntConsumer;

import org.jspecify.annotations.Nullable;

import com.mojang.serialization.JsonOps;

import net.minecraft.core.BlockPos;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.Direction.Axis;
import net.minecraft.core.particles.BlockParticleOption;
import net.minecraft.core.particles.ExplosionParticleInfo;
import net.minecraft.core.particles.ParticleOptions;
import net.minecraft.core.particles.ParticleTypes;
import net.minecraft.core.particles.SimpleParticleType;
import net.minecraft.core.particles.VibrationParticleOption;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.protocol.game.ClientboundLevelParticlesPacket.RandomizationType;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.Mth;
import net.minecraft.util.RandomSource;
import net.minecraft.util.random.Weighted;
import net.minecraft.util.random.WeightedList;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.TamableAnimal;
import net.minecraft.world.entity.animal.Animal;
import net.minecraft.world.entity.animal.equine.AbstractHorse;
import net.minecraft.world.entity.animal.fox.Fox;
import net.minecraft.world.entity.npc.villager.Villager;
import net.minecraft.world.entity.projectile.EvokerFangs;
import net.minecraft.world.entity.projectile.FireworkRocketEntity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.component.FireworkExplosion;
import net.minecraft.world.item.component.Fireworks;
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
	private static final Set<Integer> LEVEL_EVENTS = Set.of(1500, 1501, 1502, 1503, 2000, 2001, 2002, 2003, 2004, 2006, 2007, 2008, 2009,
			2010, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 3000, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009, 3011, 3012, 3013, 3014,
			3017, 3018, 3019, 3020, 3021);
	/** Level events whose particles are pieces of the block at the event (a mace's smash, someone mining a block). */
	private static final Set<Integer> WITH_BLOCK = Set.of(2013, 2019, 2020);

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
		if (type == 2001 || type == 2014 || type == 3008) {
			// the broken block's state (Block.getId) goes into the viewer's palette for its particle texture
			blockStates.accept(data);
		}
		String event = "[\"le\"," + type + "," + pos.getX() + "," + pos.getY() + "," + pos.getZ() + "," + data;
		if (WITH_BLOCK.contains(type)) {
			int state = Block.getId(level.getBlockState(pos));
			blockStates.accept(state);
			event += "," + state;
		}
		return event + "]";
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

	/**
	 * A block event the server ran and sends to players (ClientboundBlockEventPacket): chests, ender chests and
	 * shulker boxes opening and closing (1, open count), bells ringing (1, direction), note blocks playing.
	 */
	static String blockEvent(BlockPos pos, Block block, int a, int b) {
		return "[\"be\"," + pos.getX() + "," + pos.getY() + "," + pos.getZ() + ",\"" + BuiltInRegistries.BLOCK.getKey(block) + "\"," + a + "," + b + "]";
	}

	/**
	 * LivingEntity.spawnItemParticles: pieces of an item flying out in front of the entity's eyes, as
	 * ["ip", item, x, y, z, xa, ya, za, ...] (the viewer makes "item" particles of them). Drawn with a random
	 * of its own, so the entity's random numbers stay as the game uses them.
	 */
	static String itemParticles(LivingEntity entity, String item, int count) {
		RandomSource random = RandomSource.create();
		float xRot = -entity.getXRot() * Mth.DEG_TO_RAD, yRot = -entity.getYRot() * Mth.DEG_TO_RAD;
		Json json = new Json(64 + count * 56);
		json.beginArray().value("ip").value(item);
		for (int i = 0; i < count; i++) {
			Vec3 d = new Vec3((random.nextFloat() - 0.5) * 0.1, random.nextFloat() * 0.1 + 0.1, 0.0).xRot(xRot).yRot(yRot);
			double y = -random.nextFloat() * 0.6 - 0.3;
			Vec3 p = new Vec3((random.nextFloat() - 0.5) * 0.3, y, 0.6).xRot(xRot).yRot(yRot)
					.add(entity.getX(), entity.getEyeY(), entity.getZ());
			json.value(p.x, 3).value(p.y, 3).value(p.z, 3).value(d.x, 4).value(d.y + 0.05, 4).value(d.z, 4);
		}
		return json.endArray().toString();
	}

	/** Fox.handleEntityEvent 45: crumbs of the item in its mouth, as "ip" (see itemParticles). */
	private static String foxEating(Fox fox, String item) {
		RandomSource random = RandomSource.create();
		float xRot = -fox.getXRot() * Mth.DEG_TO_RAD, yRot = -fox.getYRot() * Mth.DEG_TO_RAD;
		Vec3 look = fox.getLookAngle();
		Json json = new Json(64 + 8 * 56);
		json.beginArray().value("ip").value(item);
		for (int i = 0; i < 8; i++) {
			Vec3 d = new Vec3((random.nextFloat() - 0.5) * 0.1, random.nextFloat() * 0.1 + 0.1, 0.0).xRot(xRot).yRot(yRot);
			json.value(fox.getX() + look.x / 2.0, 3).value(fox.getY(), 3).value(fox.getZ() + look.z / 2.0, 3)
					.value(d.x, 4).value(d.y + 0.05, 4).value(d.z, 4);
		}
		return json.endArray().toString();
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
	static @Nullable String options(ServerLevel level, ParticleOptions particle, IntConsumer blockStates) {
		if (particle instanceof BlockParticleOption block) {
			int id = Block.getId(block.getState());
			blockStates.accept(id);
			return "{\"b\":" + id + "}";
		}
		if (particle instanceof SimpleParticleType) {
			return null;
		}
		if (particle instanceof VibrationParticleOption vibration) {
			// where the vibration flies to, resolved here (the codec names an entity by its UUID)
			Vec3 destination = vibration.getDestination().getPosition(level).orElse(null);
			if (destination == null) {
				return null;
			}
			return new Json(64).beginObject()
					.name("dest").beginArray().value(destination.x, 3).value(destination.y, 3).value(destination.z, 3).endArray()
					.field("arrival_in_ticks", vibration.getArrivalInTicks())
					.endObject().toString();
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
	/**
	 * A rocket exploding (FireworkRocketEntity.handleEntityEvent 17, ClientLevel.createFireworks):
	 * ["fw", x, y, z, xd, yd, zd, sound, [[shape, colours, fade colours, trail, twinkle]...]].
	 */
	private static String fireworks(FireworkRocketEntity rocket) {
		Vec3 movement = rocket.getDeltaMovement();
		Fireworks fireworks = rocket.getItem().get(DataComponents.FIREWORKS);
		Json json = new Json(128);
		json.beginArray().value("fw").value(rocket.getX(), 3).value(rocket.getY(), 3).value(rocket.getZ(), 3)
				.value(movement.x, 4).value(movement.y, 4).value(movement.z, 4).value(!rocket.isSilent());
		json.beginArray();
		for (FireworkExplosion explosion : fireworks != null ? fireworks.explosions() : List.<FireworkExplosion>of()) {
			json.beginArray().value(explosion.shape().getSerializedName()).beginArray();
			for (int color : explosion.colors()) {
				json.value(color);
			}
			json.endArray().beginArray();
			for (int color : explosion.fadeColors()) {
				json.value(color);
			}
			json.endArray().value(explosion.hasTrail()).value(explosion.hasTwinkle()).endArray();
		}
		json.endArray().endArray();
		return json.toString();
	}

	static @Nullable String entityEvent(Entity entity, byte event) {
		if (event == 17 && entity instanceof FireworkRocketEntity rocket) {
			return fireworks(rocket);
		}
		if (event == 45 && entity instanceof Fox fox) {
			ItemStack mouth = fox.getItemBySlot(EquipmentSlot.MAINHAND);
			return mouth.isEmpty() ? null : foxEating(fox, BuiltInRegistries.ITEM.getKey(mouth.getItem()).toString());
		}
		String kind = null;
		if (event == 4 && entity instanceof EvokerFangs) {
			// EvokerFangs.tick (client): the bite started, crit particles follow when it closes
			kind = "fangs";
		}
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
		if (kind == null && entity instanceof LivingEntity) {
			// a totem of undying saving it (a TrackingEmitter of totem particles), teleporting (portal specks along the
			// way from where it was), a witch's drinking and throwing (Witch.handleEntityEvent 15)
			kind = switch (event) {
				case 35 -> "totem";
				case 46 -> "teleport";
				case 15 -> entity.getType() == EntityType.WITCH ? "witch" : null;
				default -> null;
			};
		}
		if (kind == null) {
			return null;
		}
		Json json = new Json(96);
		json.beginArray().value("ee").value(kind).value(entity.getX(), 3).value(entity.getY(), 3).value(entity.getZ(), 3)
				.value(entity.getBbWidth(), 3).value(entity.getBbHeight(), 3);
		if ("teleport".equals(kind)) {
			json.value(entity.xo, 3).value(entity.yo, 3).value(entity.zo, 3);
		}
		return json.endArray().toString();
	}
}
