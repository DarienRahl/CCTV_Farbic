package io.github.darienrahl.cctv.camera;

import java.util.Locale;
import java.util.Set;

import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Pose;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;

import io.github.darienrahl.cctv.web.Json;

/** Serializes the entities a camera can see. Server thread only. */
final class EntityEncoder {
	/** Technical entities that are invisible in game anyway. */
	private static final Set<String> HIDDEN_TYPES = Set.of(
			"minecraft:marker",
			"minecraft:interaction",
			"minecraft:block_display",
			"minecraft:item_display",
			"minecraft:text_display",
			"minecraft:area_effect_cloud"
	);

	private EntityEncoder() {
	}

	static boolean shouldSend(Entity entity, String type) {
		if (HIDDEN_TYPES.contains(type)) {
			return false;
		}
		return !(entity instanceof Player player) || !player.isSpectator();
	}

	private static final EquipmentSlot[] ARMOR = {EquipmentSlot.HEAD, EquipmentSlot.CHEST, EquipmentSlot.LEGS, EquipmentSlot.FEET};

	/** Worn armor as item ids [head, chest, legs, feet] (null when empty), only if anything is worn. */
	private static void writeArmor(Json json, LivingEntity living) {
		String[] items = new String[ARMOR.length];
		boolean any = false;
		for (int i = 0; i < ARMOR.length; i++) {
			ItemStack stack = living.getItemBySlot(ARMOR[i]);
			if (!stack.isEmpty()) {
				items[i] = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
				any = true;
			}
		}
		if (!any) {
			return;
		}
		json.name("armor").beginArray();
		for (String item : items) {
			json.value(item);
		}
		json.endArray();
	}

	static void write(Json json, Entity entity, String type) {
		json.beginObject()
				.field("id", entity.getId())
				.field("type", type)
				.field("x", entity.getX(), 3)
				.field("y", entity.getY(), 3)
				.field("z", entity.getZ(), 3)
				.field("yaw", entity.getYRot(), 1)
				.field("pitch", entity.getXRot(), 1)
				.field("w", entity.getBbWidth(), 3)
				.field("h", entity.getBbHeight(), 3);

		if (entity instanceof LivingEntity living) {
			json.field("body", living.yBodyRot, 1)
					.field("head", living.getYHeadRot(), 1);
			if (living.isBaby()) {
				json.field("baby", true);
			}
			if (living.hurtTime > 0) {
				json.field("hurt", true);
			}
			if (living.isDeadOrDying()) {
				json.field("dead", true);
			}
			if (living.isSwinging()) {
				json.field("swing", true);
			}
			ItemStack hand = living.getMainHandItem();
			if (!hand.isEmpty()) {
				json.field("hand", BuiltInRegistries.ITEM.getKey(hand.getItem()).toString());
			}
			writeArmor(json, living);
		}

		if (entity instanceof Player player) {
			json.field("name", player.getGameProfile().name())
					.field("uuid", player.getUUID().toString());
		} else if (entity.hasCustomName() && entity.getCustomName() != null) {
			json.field("name", entity.getCustomName().getString());
		}

		if (entity instanceof ItemEntity item) {
			json.field("item", BuiltInRegistries.ITEM.getKey(item.getItem().getItem()).toString());
		}

		Pose pose = entity.getPose();
		if (pose != Pose.STANDING) {
			json.field("pose", pose.name().toLowerCase(Locale.ROOT));
		}
		if (entity.isInvisible()) {
			json.field("invisible", true);
		}
		if (entity.isShiftKeyDown()) {
			json.field("sneak", true);
		}
		if (entity.isPassenger()) {
			json.field("riding", true);
		}

		json.endObject();
	}
}
