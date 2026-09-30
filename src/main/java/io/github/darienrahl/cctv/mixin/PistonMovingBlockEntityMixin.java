package io.github.darienrahl.cctv.mixin;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.piston.PistonMovingBlockEntity;
import net.minecraft.world.level.block.state.BlockState;

import io.github.darienrahl.cctv.CctvMod;
import io.github.darienrahl.cctv.camera.CameraManager;
import io.github.darienrahl.cctv.camera.Problems;

/**
 * Blocks a piston starts moving (MovingPistonBlock.newMovingBlockEntity). The server places moving pistons
 * without sending them to players, so the cameras hear about them here and the viewer animates them.
 * Optional: without it, pushed blocks just jump to their new place.
 */
@Mixin(PistonMovingBlockEntity.class)
public abstract class PistonMovingBlockEntityMixin {
	@Inject(
			method = "<init>(Lnet/minecraft/core/BlockPos;Lnet/minecraft/world/level/block/state/BlockState;Lnet/minecraft/world/level/block/state/BlockState;Lnet/minecraft/core/Direction;ZZ)V",
			at = @At("RETURN"),
			require = 0
	)
	private void cctv$onCreated(BlockPos pos, BlockState state, BlockState movedState, Direction direction, boolean extending,
			boolean isSourcePiston, CallbackInfo ci) {
		CameraManager manager = CctvMod.manager();
		if (manager != null) {
			try {
				manager.onPistonMoving((PistonMovingBlockEntity) (Object) this);
			} catch (RuntimeException | LinkageError e) {
				Problems.report(null, "piston tracking", e);
			}
		}
	}
}
