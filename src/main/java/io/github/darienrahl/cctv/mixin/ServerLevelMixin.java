package io.github.darienrahl.cctv.mixin;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.state.BlockState;

import io.github.darienrahl.cctv.CctvMod;
import io.github.darienrahl.cctv.camera.CameraManager;
import io.github.darienrahl.cctv.camera.Problems;

/**
 * Forwards block changes (the same ones vanilla sends to players) to the
 * cameras so doors, pistons, placed and broken blocks show up instantly.
 * Optional: if the target ever changes, the periodic re-scan still catches up.
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
}
