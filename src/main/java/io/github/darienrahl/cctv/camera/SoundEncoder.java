package io.github.darienrahl.cctv.camera;

import org.jspecify.annotations.Nullable;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Holder;
import net.minecraft.core.registries.Registries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.sounds.SoundEvent;
import net.minecraft.sounds.SoundEvents;
import net.minecraft.sounds.SoundSource;
import net.minecraft.util.RandomSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.item.JukeboxSong;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.BrushableBlock;
import net.minecraft.world.level.block.SoundType;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;

import io.github.darienrahl.cctv.web.Json;

/**
 * The sounds a player at the camera would hear, for the viewer to play them like the client's SoundEngine:
 * the sound packets of the server (ClientboundSoundPacket at a position, ClientboundSoundEntityPacket following
 * an entity) and the sounds the client plays for level events (LevelEventHandler). Each is one JSON array in the
 * "fx" list of the next entity frame:
 * <pre>
 * ["s", sound event, x, y, z, source, volume, pitch, seed, distance delay]
 * ["se", sound event, entity id, source, volume, pitch, seed]
 * ["sg", sound event, x, y, z, source, volume, pitch]      heard from 2 blocks towards (x, y, z)
 * ["js", sound event, x, y, z] / ["jx", x, y, z]           a jukebox starts / stops its song
 * </pre>
 * The seed picks the sound file like the client's {@code RandomSource.create(seed)}.
 */
final class SoundEncoder {
	private SoundEncoder() {
	}

	static String id(SoundEvent sound) {
		return sound.location().toString();
	}

	static String sound(SoundEvent sound, SoundSource source, double x, double y, double z, float volume, float pitch, long seed, boolean delay) {
		Json json = new Json(128);
		json.beginArray().value("s").value(id(sound)).value(x, 2).value(y, 2).value(z, 2).value(source.getName())
				.value(volume, 3).value(pitch, 3).value(Long.toString(seed)).value(delay ? 1 : 0).endArray();
		return json.toString();
	}

	static String entitySound(SoundEvent sound, SoundSource source, Entity entity, float volume, float pitch, long seed) {
		Json json = new Json(128);
		json.beginArray().value("se").value(id(sound)).value(entity.getId()).value(source.getName())
				.value(volume, 3).value(pitch, 3).value(Long.toString(seed)).endArray();
		return json.toString();
	}

	/** LevelEventHandler.globalLevelEvent: the wither, the end portal and the dragon's death, heard everywhere. */
	static @Nullable String globalLevelEvent(int type, BlockPos pos) {
		SoundEvent sound = switch (type) {
			case 1023 -> SoundEvents.WITHER_SPAWN;
			case 1038 -> SoundEvents.END_PORTAL_SPAWN;
			case 1028 -> SoundEvents.ENDER_DRAGON_DEATH;
			default -> null;
		};
		if (sound == null) {
			return null;
		}
		Json json = new Json(96);
		json.beginArray().value("sg").value(id(sound)).value(pos.getX() + 0.5, 1).value(pos.getY() + 0.5, 1).value(pos.getZ() + 0.5, 1)
				.value(SoundSource.HOSTILE.getName()).value(type == 1028 ? 5 : 1).value(1).endArray();
		return json.toString();
	}

	/** The sound LevelEventHandler.levelEvent plays for a level event (level.playLocalSound at the block), or null. */
	static @Nullable String levelEvent(ServerLevel level, int type, BlockPos pos, int data) {
		RandomSource random = level.getRandom();
		float spread = (random.nextFloat() - random.nextFloat()) * 0.2F + 1.0F;
		float small = random.nextFloat() * 0.1F + 0.9F;
		return switch (type) {
			case 1000 -> at(pos, SoundEvents.DISPENSER_DISPENSE, SoundSource.BLOCKS, 1.0F, 1.0F, false);
			case 1001 -> at(pos, SoundEvents.DISPENSER_FAIL, SoundSource.BLOCKS, 1.0F, 1.2F, false);
			case 1002 -> at(pos, SoundEvents.DISPENSER_LAUNCH, SoundSource.BLOCKS, 1.0F, 1.2F, false);
			case 1004 -> at(pos, SoundEvents.FIREWORK_ROCKET_SHOOT, SoundSource.NEUTRAL, 1.0F, 1.2F, false);
			case 1009 -> data == 0
					? at(pos, SoundEvents.FIRE_EXTINGUISH, SoundSource.BLOCKS, 0.5F, 2.6F + (random.nextFloat() - random.nextFloat()) * 0.8F, false)
					: data == 1 ? at(pos, SoundEvents.GENERIC_EXTINGUISH_FIRE, SoundSource.BLOCKS, 0.7F, 1.6F + (random.nextFloat() - random.nextFloat()) * 0.4F, false)
					: null;
			case 1010 -> jukebox(level, pos, data);
			case 1011 -> "[\"jx\"," + pos.getX() + "," + pos.getY() + "," + pos.getZ() + "]";
			case 1015 -> at(pos, SoundEvents.GHAST_WARN, SoundSource.HOSTILE, 10.0F, spread, false);
			case 1016 -> at(pos, SoundEvents.GHAST_SHOOT, SoundSource.HOSTILE, 10.0F, spread, false);
			case 1017 -> at(pos, SoundEvents.ENDER_DRAGON_SHOOT, SoundSource.HOSTILE, 10.0F, spread, false);
			case 1018 -> at(pos, SoundEvents.BLAZE_SHOOT, SoundSource.HOSTILE, 2.0F, spread, false);
			case 1019 -> at(pos, SoundEvents.ZOMBIE_ATTACK_WOODEN_DOOR, SoundSource.HOSTILE, 2.0F, spread, false);
			case 1020 -> at(pos, SoundEvents.ZOMBIE_ATTACK_IRON_DOOR, SoundSource.HOSTILE, 2.0F, spread, false);
			case 1021 -> at(pos, SoundEvents.ZOMBIE_BREAK_WOODEN_DOOR, SoundSource.HOSTILE, 2.0F, spread, false);
			case 1022 -> at(pos, SoundEvents.WITHER_BREAK_BLOCK, SoundSource.HOSTILE, 2.0F, spread, false);
			case 1024 -> at(pos, SoundEvents.WITHER_SHOOT, SoundSource.HOSTILE, 2.0F, spread, false);
			case 1025 -> at(pos, SoundEvents.BAT_TAKEOFF, SoundSource.NEUTRAL, 0.05F, spread, false);
			case 1026 -> at(pos, SoundEvents.ZOMBIE_INFECT, SoundSource.HOSTILE, 2.0F, spread, false);
			case 1027 -> at(pos, SoundEvents.ZOMBIE_VILLAGER_CONVERTED, SoundSource.HOSTILE, 2.0F, spread, false);
			case 1029 -> at(pos, SoundEvents.ANVIL_DESTROY, SoundSource.BLOCKS, 1.0F, small, false);
			case 1030 -> at(pos, SoundEvents.ANVIL_USE, SoundSource.BLOCKS, 1.0F, small, false);
			case 1031 -> at(pos, SoundEvents.ANVIL_LAND, SoundSource.BLOCKS, 0.3F, small, false);
			case 1033 -> at(pos, SoundEvents.CHORUS_FLOWER_GROW, SoundSource.BLOCKS, 1.0F, 1.0F, false);
			case 1034 -> at(pos, SoundEvents.CHORUS_FLOWER_DEATH, SoundSource.BLOCKS, 1.0F, 1.0F, false);
			case 1035 -> at(pos, SoundEvents.BREWING_STAND_BREW, SoundSource.BLOCKS, 1.0F, 1.0F, false);
			case 1039 -> at(pos, SoundEvents.PHANTOM_BITE, SoundSource.HOSTILE, 0.3F, small, false);
			case 1040 -> at(pos, SoundEvents.ZOMBIE_CONVERTED_TO_DROWNED, SoundSource.HOSTILE, 2.0F, spread, false);
			case 1041 -> at(pos, SoundEvents.HUSK_CONVERTED_TO_ZOMBIE, SoundSource.HOSTILE, 2.0F, spread, false);
			case 1042 -> at(pos, SoundEvents.GRINDSTONE_USE, SoundSource.BLOCKS, 1.0F, small, false);
			case 1043 -> at(pos, SoundEvents.BOOK_PAGE_TURN, SoundSource.BLOCKS, 1.0F, small, false);
			case 1044 -> at(pos, SoundEvents.SMITHING_TABLE_USE, SoundSource.BLOCKS, 1.0F, small, false);
			case 1045 -> at(pos, SoundEvents.POINTED_DRIPSTONE_LAND, SoundSource.BLOCKS, 2.0F, small, false);
			case 1046 -> at(pos, SoundEvents.POINTED_DRIPSTONE_DRIP_LAVA_INTO_CAULDRON, SoundSource.BLOCKS, 2.0F, small, false);
			case 1047 -> at(pos, SoundEvents.POINTED_DRIPSTONE_DRIP_WATER_INTO_CAULDRON, SoundSource.BLOCKS, 2.0F, small, false);
			case 1048 -> at(pos, SoundEvents.SKELETON_CONVERTED_TO_STRAY, SoundSource.HOSTILE, 2.0F, spread, false);
			case 1049 -> at(pos, SoundEvents.CRAFTER_CRAFT, SoundSource.BLOCKS, 1.0F, 1.0F, false);
			case 1050 -> at(pos, SoundEvents.CRAFTER_FAIL, SoundSource.BLOCKS, 1.0F, 1.0F, false);
			case 1051 -> at(pos, SoundEvents.WIND_CHARGE_THROW, SoundSource.BLOCKS, 0.5F, 0.4F / (random.nextFloat() * 0.4F + 0.8F), false);
			case 1052 -> at(pos, SoundEvents.SULFUR_SPIKE_LAND, SoundSource.BLOCKS, 2.0F, small, false);
			case 1053, 1054 -> at(pos, SoundEvents.SPLASH_POTION_BREAK, SoundSource.NEUTRAL, 1.0F, small, false);
			// ComposterBlock.handleFill
			case 1500 -> at(pos, data > 0 ? SoundEvents.COMPOSTER_FILL_SUCCESS : SoundEvents.COMPOSTER_FILL, SoundSource.BLOCKS, 1.0F, 1.0F, false);
			case 1501 -> at(pos, SoundEvents.LAVA_EXTINGUISH, SoundSource.BLOCKS, 0.5F, 2.6F + (random.nextFloat() - random.nextFloat()) * 0.8F, false);
			case 1502 -> at(pos, SoundEvents.REDSTONE_TORCH_BURNOUT, SoundSource.BLOCKS, 0.5F, 2.6F + (random.nextFloat() - random.nextFloat()) * 0.8F, false);
			case 1503 -> at(pos, SoundEvents.END_PORTAL_FRAME_FILL, SoundSource.BLOCKS, 1.0F, 1.0F, false);
			case 1505 -> at(pos, SoundEvents.BONE_MEAL_USE, SoundSource.BLOCKS, 1.0F, 1.0F, false);
			case 2001 -> blockBreak(pos, data);
			case 2006 -> data == 1 ? at(pos, SoundEvents.DRAGON_FIREBALL_EXPLODE, SoundSource.HOSTILE, 1.0F, small, false) : null;
			case 3000 -> at(pos, SoundEvents.END_GATEWAY_SPAWN, SoundSource.BLOCKS, 10.0F, (1.0F + (random.nextFloat() - random.nextFloat()) * 0.2F) * 0.7F, false);
			case 3001 -> at(pos, SoundEvents.ENDER_DRAGON_GROWL, SoundSource.HOSTILE, 64.0F, 0.8F + random.nextFloat() * 0.3F, false);
			case 3006 -> sculkCharge(pos, data, random);
			case 3007 -> shriek(level, pos, random);
			case 3008 -> Block.stateById(data).getBlock() instanceof BrushableBlock brushable
					? at(pos, brushable.getBrushCompletedSound(), SoundSource.PLAYERS, 1.0F, 1.0F, false) : null;
			case 3012 -> at(pos, SoundEvents.TRIAL_SPAWNER_SPAWN_MOB, SoundSource.BLOCKS, 1.0F, spread, true);
			case 3013, 3019 -> at(pos, SoundEvents.TRIAL_SPAWNER_DETECT_PLAYER, SoundSource.BLOCKS, 1.0F, spread, true);
			case 3014 -> at(pos, SoundEvents.TRIAL_SPAWNER_EJECT_ITEM, SoundSource.BLOCKS, 1.0F, spread, true);
			case 3015 -> at(pos, SoundEvents.VAULT_ACTIVATE, SoundSource.BLOCKS, 1.0F, spread, true);
			case 3016 -> at(pos, SoundEvents.VAULT_DEACTIVATE, SoundSource.BLOCKS, 1.0F, spread, true);
			case 3018 -> at(pos, SoundEvents.COBWEB_PLACE, SoundSource.BLOCKS, 1.0F, spread, true);
			case 3020 -> at(pos, SoundEvents.TRIAL_SPAWNER_OMINOUS_ACTIVATE, SoundSource.BLOCKS, data == 0 ? 0.3F : 1.0F, spread, true);
			case 3021 -> at(pos, SoundEvents.TRIAL_SPAWNER_SPAWN_ITEM, SoundSource.BLOCKS, 1.0F, spread, true);
			default -> null;
		};
	}

	/** Level.playLocalSound(BlockPos, ...): at the block's centre, a random seed. */
	private static String at(BlockPos pos, SoundEvent sound, SoundSource source, float volume, float pitch, boolean delay) {
		return sound(sound, source, pos.getX() + 0.5, pos.getY() + 0.5, pos.getZ() + 0.5, volume, pitch, RandomSource.create().nextLong(), delay);
	}

	private static String at(BlockPos pos, Holder<SoundEvent> sound, SoundSource source, float volume, float pitch, boolean delay) {
		return at(pos, sound.value(), source, volume, pitch, delay);
	}

	/** 2001: the broken block's break sound, from its SoundType. */
	private static @Nullable String blockBreak(BlockPos pos, int data) {
		BlockState state = Block.stateById(data);
		if (state.isAir()) {
			return null;
		}
		SoundType soundType = state.getSoundType();
		return at(pos, soundType.getBreakSound(), SoundSource.BLOCKS, (soundType.getVolume() + 1.0F) / 2.0F, soundType.getPitch() * 0.8F, false);
	}

	private static @Nullable String sculkCharge(BlockPos pos, int data, RandomSource random) {
		int count = data >> 6;
		if (count <= 0) {
			return at(pos, SoundEvents.SCULK_BLOCK_CHARGE, SoundSource.BLOCKS, 1.0F, 1.0F, false);
		}
		if (random.nextFloat() >= 0.3F + count * 0.1F) {
			return null;
		}
		return at(pos, SoundEvents.SCULK_BLOCK_CHARGE, SoundSource.BLOCKS, 0.15F + 0.02F * count * count * random.nextFloat(),
				0.4F + 0.3F * count * random.nextFloat(), false);
	}

	private static @Nullable String shriek(ServerLevel level, BlockPos pos, RandomSource random) {
		BlockState state = level.getBlockState(pos);
		if (state.hasProperty(BlockStateProperties.WATERLOGGED) && state.getValue(BlockStateProperties.WATERLOGGED)) {
			return null;
		}
		// SculkShriekerBlock.TOP_Y: the top of the shrieker
		return sound(SoundEvents.SCULK_SHRIEKER_SHRIEK, SoundSource.BLOCKS, pos.getX() + 0.5, pos.getY() + 0.5, pos.getZ() + 0.5, 2.0F,
				0.6F + random.nextFloat() * 0.4F, RandomSource.create().nextLong(), false);
	}

	/** 1010: SimpleSoundInstance.forJukeboxSong (records, volume 4). */
	private static @Nullable String jukebox(ServerLevel level, BlockPos pos, int data) {
		return level.registryAccess().lookupOrThrow(Registries.JUKEBOX_SONG).get(data)
				.map(song -> "[\"js\",\"" + id(((JukeboxSong) song.value()).soundEvent().value()) + "\"," + pos.getX() + "," + pos.getY() + ","
						+ pos.getZ() + "]")
				.orElse(null);
	}
}
