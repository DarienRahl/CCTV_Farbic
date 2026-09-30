package io.github.darienrahl.cctv.mixin;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.item.ItemStack;

import io.github.darienrahl.cctv.CctvMod;
import io.github.darienrahl.cctv.camera.CameraManager;
import io.github.darienrahl.cctv.camera.Problems;

/**
 * Pieces of items the client makes itself: while something eats or drinks (Consumable.emitParticlesAndSounds
 * runs on the server too, where it draws nothing) and when a tool or armour piece breaks (the client plays
 * the entity event with the item it still has). Optional: without it the viewer just shows no pieces.
 */
@Mixin(LivingEntity.class)
public abstract class LivingEntityMixin {
	@Inject(method = "spawnItemParticles(Lnet/minecraft/world/item/ItemStack;I)V", at = @At("HEAD"), require = 0)
	private void cctv$onItemParticles(ItemStack stack, int count, CallbackInfo ci) {
		LivingEntity self = (LivingEntity) (Object) this;
		CameraManager manager = CctvMod.manager();
		if (manager != null && self.level() instanceof ServerLevel level) {
			try {
				manager.onItemParticles(level, self, stack, count, false);
			} catch (RuntimeException | LinkageError e) {
				Problems.report(null, "item particle tracking", e);
			}
		}
	}

	@Inject(
			method = "onEquippedItemBroken(Lnet/minecraft/world/item/ItemStack;Lnet/minecraft/world/entity/EquipmentSlot;)V",
			at = @At("HEAD"),
			require = 0
	)
	private void cctv$onItemBroken(ItemStack broken, EquipmentSlot slot, CallbackInfo ci) {
		LivingEntity self = (LivingEntity) (Object) this;
		CameraManager manager = CctvMod.manager();
		if (manager != null && self.level() instanceof ServerLevel level) {
			try {
				// LivingEntity.breakItem: 5 pieces and the item's break sound
				manager.onItemParticles(level, self, broken, 5, true);
			} catch (RuntimeException | LinkageError e) {
				Problems.report(null, "item break tracking", e);
			}
		}
	}
}
