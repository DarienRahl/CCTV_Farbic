package io.github.darienrahl.cctv.mixin;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Holder;
import net.minecraft.core.particles.ExplosionParticleInfo;
import net.minecraft.core.particles.ParticleOptions;
import net.minecraft.network.protocol.game.ClientboundLevelParticlesPacket.RandomizationType;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.sounds.SoundEvent;
import net.minecraft.sounds.SoundSource;
import net.minecraft.util.random.WeightedList;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.BlockEventData;
import net.minecraft.world.level.ExplosionDamageCalculator;
import net.minecraft.world.level.Level.ExplosionInteraction;
import net.minecraft.world.level.ServerExplosion;
import net.minecraft.world.level.block.state.BlockState;

import io.github.darienrahl.cctv.CctvMod;
import io.github.darienrahl.cctv.camera.CameraManager;
import io.github.darienrahl.cctv.camera.Problems;

/**
 * Forwards block changes (the same ones vanilla sends to players) to the
 * cameras so doors, pistons, placed and broken blocks show up instantly, and
 * entity events so the viewer can play the animations the client derives from them, and level events,
 * particle packets and explosions for the particles the client makes from them.
 * Optional: if a target ever changes, the periodic re-scan still catches up and
 * entities only lose those animations.
 */
@Mixin(ServerLevel.class)
public abstract class ServerLevelMixin {
	@Inject(
			method = "sendBlockUpdated(Lnet/minecraft/core/BlockPos;Lnet/minecraft/world/level/block/state/BlockState;Lnet/minecraft/world/level/block/state/BlockState;I)V",
			at = @At("HEAD"),
			require = 0
	)
	private void cctv$onBlockUpdated(BlockPos pos, BlockState oldState, BlockState newState, int flags, CallbackInfo ci) {
		CameraManager manager = CctvMod.manager();
		if (manager != null) {
			try {
				manager.onBlockChanged((ServerLevel) (Object) this, pos, newState);
			} catch (RuntimeException | LinkageError e) {
				// Never break block updates of the game; the periodic re-scan catches up.
				Problems.report(null, "block update tracking", e);
			}
		}
	}

	/** Level events (a broken block, dispenser smoke, bone meal...) make particles in the client. */
	@Inject(
			method = "levelEvent(Lnet/minecraft/world/entity/Entity;ILnet/minecraft/core/BlockPos;I)V",
			at = @At("HEAD"),
			require = 0
	)
	private void cctv$onLevelEvent(Entity source, int type, BlockPos pos, int data, CallbackInfo ci) {
		CameraManager manager = CctvMod.manager();
		if (manager != null) {
			try {
				manager.onLevelEvent((ServerLevel) (Object) this, type, pos, data);
			} catch (RuntimeException | LinkageError e) {
				Problems.report(null, "level event tracking", e);
			}
		}
	}

	/** Sounds at a position sent to the players in range (every other playSound ends up here). */
	@Inject(
			method = "playSeededSound(Lnet/minecraft/world/entity/Entity;DDDLnet/minecraft/core/Holder;Lnet/minecraft/sounds/SoundSource;FFJ)V",
			at = @At("HEAD"),
			require = 0
	)
	private void cctv$onSound(Entity except, double x, double y, double z, Holder<SoundEvent> sound, SoundSource source, float volume, float pitch,
			long seed, CallbackInfo ci) {
		CameraManager manager = CctvMod.manager();
		if (manager != null) {
			try {
				manager.onSound((ServerLevel) (Object) this, x, y, z, sound, source, volume, pitch, seed);
			} catch (RuntimeException | LinkageError e) {
				Problems.report(null, "sound tracking", e);
			}
		}
	}

	/** Sounds following an entity (ClientboundSoundEntityPacket). */
	@Inject(
			method = "playSeededSound(Lnet/minecraft/world/entity/Entity;Lnet/minecraft/world/entity/Entity;Lnet/minecraft/core/Holder;"
					+ "Lnet/minecraft/sounds/SoundSource;FFJ)V",
			at = @At("HEAD"),
			require = 0
	)
	private void cctv$onEntitySound(Entity except, Entity entity, Holder<SoundEvent> sound, SoundSource source, float volume, float pitch, long seed,
			CallbackInfo ci) {
		CameraManager manager = CctvMod.manager();
		if (manager != null) {
			try {
				manager.onEntitySound((ServerLevel) (Object) this, entity, sound, source, volume, pitch, seed);
			} catch (RuntimeException | LinkageError e) {
				Problems.report(null, "sound tracking", e);
			}
		}
	}

	/** Level events every player hears (the wither, the end portal, the dragon's death). */
	@Inject(method = "globalLevelEvent(ILnet/minecraft/core/BlockPos;I)V", at = @At("HEAD"), require = 0)
	private void cctv$onGlobalLevelEvent(int type, BlockPos pos, int data, CallbackInfo ci) {
		CameraManager manager = CctvMod.manager();
		if (manager != null) {
			try {
				manager.onGlobalLevelEvent((ServerLevel) (Object) this, type, pos);
			} catch (RuntimeException | LinkageError e) {
				Problems.report(null, "sound tracking", e);
			}
		}
	}

	/** Block events the server ran (and sends to players): chests opening, bells ringing, note blocks. */
	@Inject(
			method = "doBlockEvent(Lnet/minecraft/world/level/BlockEventData;)Z",
			at = @At("RETURN"),
			require = 0
	)
	private void cctv$onBlockEvent(BlockEventData event, CallbackInfoReturnable<Boolean> cir) {
		CameraManager manager = CctvMod.manager();
		if (manager != null && Boolean.TRUE.equals(cir.getReturnValue())) {
			try {
				manager.onBlockEvent((ServerLevel) (Object) this, event.pos(), event.block(), event.paramA(), event.paramB());
			} catch (RuntimeException | LinkageError e) {
				Problems.report(null, "block event tracking", e);
			}
		}
	}

	/** A player breaking a block: the cracks (destroy stages) the other players see. */
	@Inject(
			method = "destroyBlockProgress(ILnet/minecraft/core/BlockPos;I)V",
			at = @At("HEAD"),
			require = 0
	)
	private void cctv$onBlockProgress(int breaker, BlockPos pos, int progress, CallbackInfo ci) {
		CameraManager manager = CctvMod.manager();
		if (manager != null) {
			try {
				manager.onBlockProgress((ServerLevel) (Object) this, breaker, pos, progress);
			} catch (RuntimeException | LinkageError e) {
				Problems.report(null, "block breaking tracking", e);
			}
		}
	}

	/** Particle packets: every sendParticles overload for all players ends up in this one. */
	@Inject(
			method = "sendParticles(Lnet/minecraft/core/particles/ParticleOptions;ZZDDDIDDDDDDLnet/minecraft/network/protocol/game/ClientboundLevelParticlesPacket$RandomizationType;)I",
			at = @At("HEAD"),
			require = 0
	)
	private void cctv$onParticles(ParticleOptions particle, boolean overrideLimiter, boolean alwaysShow, double x, double y, double z,
			int count, double xDist, double yDist, double zDist, double xSpeed, double ySpeed, double zSpeed, RandomizationType randomization,
			CallbackInfoReturnable<Integer> cir) {
		CameraManager manager = CctvMod.manager();
		if (manager != null) {
			try {
				manager.onParticles((ServerLevel) (Object) this, particle, overrideLimiter, x, y, z, count, xDist, yDist, zDist,
						xSpeed, ySpeed, zSpeed, randomization);
			} catch (RuntimeException | LinkageError e) {
				Problems.report(null, "particle tracking", e);
			}
		}
	}

	@Unique
	private ParticleOptions cctv$smallExplosion;
	@Unique
	private ParticleOptions cctv$largeExplosion;
	@Unique
	private WeightedList<ExplosionParticleInfo> cctv$explosionBlockParticles;
	@Unique
	private Holder<SoundEvent> cctv$explosionSound;

	/** The explosion particles ServerLevel#explode chooses from, for the wrap of ServerExplosion#explode below. */
	@Inject(
			method = "explode(Lnet/minecraft/world/entity/Entity;Lnet/minecraft/world/damagesource/DamageSource;"
					+ "Lnet/minecraft/world/level/ExplosionDamageCalculator;DDDFZLnet/minecraft/world/level/Level$ExplosionInteraction;"
					+ "Lnet/minecraft/core/particles/ParticleOptions;Lnet/minecraft/core/particles/ParticleOptions;"
					+ "Lnet/minecraft/util/random/WeightedList;Lnet/minecraft/core/Holder;)V",
			at = @At("HEAD"),
			require = 0
	)
	private void cctv$beforeExplode(Entity source, DamageSource damageSource, ExplosionDamageCalculator damageCalculator, double x, double y,
			double z, float radius, boolean fire, ExplosionInteraction interaction, ParticleOptions small, ParticleOptions large,
			WeightedList<ExplosionParticleInfo> blockParticles, Holder<SoundEvent> sound, CallbackInfo ci) {
		cctv$smallExplosion = small;
		cctv$largeExplosion = large;
		cctv$explosionBlockParticles = blockParticles;
		cctv$explosionSound = sound;
	}

	/** Explosions: the blocks it destroyed and its particle, like the ClientboundExplodePacket players get. */
	@WrapOperation(
			method = "explode(Lnet/minecraft/world/entity/Entity;Lnet/minecraft/world/damagesource/DamageSource;"
					+ "Lnet/minecraft/world/level/ExplosionDamageCalculator;DDDFZLnet/minecraft/world/level/Level$ExplosionInteraction;"
					+ "Lnet/minecraft/core/particles/ParticleOptions;Lnet/minecraft/core/particles/ParticleOptions;"
					+ "Lnet/minecraft/util/random/WeightedList;Lnet/minecraft/core/Holder;)V",
			at = @At(value = "INVOKE", target = "Lnet/minecraft/world/level/ServerExplosion;explode()I"),
			require = 0
	)
	private int cctv$onExplode(ServerExplosion explosion, Operation<Integer> original) {
		int blockCount = original.call(explosion);
		CameraManager manager = CctvMod.manager();
		if (manager != null && cctv$smallExplosion != null && cctv$largeExplosion != null && cctv$explosionBlockParticles != null) {
			try {
				manager.onExplosion((ServerLevel) (Object) this, explosion.center(), explosion.radius(), blockCount,
						explosion.isSmall() ? cctv$smallExplosion : cctv$largeExplosion, cctv$explosionBlockParticles, cctv$explosionSound);
			} catch (RuntimeException | LinkageError e) {
				Problems.report(null, "explosion tracking", e);
			}
		}
		return blockCount;
	}

	/** Entity events (attacks, eating, shaking...) drive client-side animations; the viewer replays them. */
	@Inject(
			method = "broadcastEntityEvent(Lnet/minecraft/world/entity/Entity;B)V",
			at = @At("HEAD"),
			require = 0
	)
	private void cctv$onEntityEvent(Entity entity, byte event, CallbackInfo ci) {
		CameraManager manager = CctvMod.manager();
		if (manager != null) {
			try {
				manager.onEntityEvent((ServerLevel) (Object) this, entity, event);
			} catch (RuntimeException | LinkageError e) {
				Problems.report(null, "entity event tracking", e);
			}
		}
	}
}
