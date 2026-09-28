package io.github.darienrahl.cctv.mixin;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;

import com.llamalad7.mixinextras.injector.ModifyExpressionValue;

import net.minecraft.server.MinecraftServer;

import io.github.darienrahl.cctv.CctvMod;
import io.github.darienrahl.cctv.camera.CameraManager;

/**
 * A watched camera counts as a player online for {@code pause-when-empty-seconds}: a paused server
 * skips its ticks (and with them the camera streams), so it stays awake while somebody watches and
 * the viewer shows the live world. Optional: without it cameras only stream while players are online
 * or the pause is switched off.
 */
@Mixin(MinecraftServer.class)
public abstract class MinecraftServerMixin {
	@ModifyExpressionValue(
			method = "tickServer",
			at = @At(value = "INVOKE", target = "Lnet/minecraft/server/players/PlayerList;getPlayerCount()I"),
			require = 0
	)
	private int cctv$countCameraViewers(int players) {
		if (players > 0) {
			return players;
		}
		CameraManager manager = CctvMod.manager();
		return manager != null && manager.isWatched() ? 1 : players;
	}
}
