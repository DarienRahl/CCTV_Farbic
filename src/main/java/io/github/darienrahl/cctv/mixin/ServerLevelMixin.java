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
import net.minecraft.util.random.WeightedList;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.Entity;
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
						explosion.isSmall() ? cctv$smallExplosion : cctv$largeExplosion, cctv$explosionBlockParticles);
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
