package io.github.darienrahl.cctv.camera;

import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.IntConsumer;

import org.jspecify.annotations.Nullable;

import net.minecraft.core.Holder;
import net.minecraft.core.component.DataComponentType;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.util.StringRepresentable;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.LightningBolt;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Pose;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;

import io.github.darienrahl.cctv.web.Json;

/**
 * Serializes the entities a camera can see. Server thread only.
 *
 * <p>Besides position and rotation it sends what the client's entity renderers
 * look at to pick models, textures and layers: variants (horse colour, cat
 * type...), walk animation, equipment and a few state flags.
 */
final class EntityEncoder {
	/** Technical entities that are invisible in game anyway (and the camera markers). */
	private static final Set<String> HIDDEN_TYPES = Set.of(
			"minecraft:marker",
			"minecraft:interaction",
			"minecraft:block_display",
			"minecraft:item_display",
			"minecraft:text_display",
			"minecraft:area_effect_cloud"
	);

	/** Variants stored as data components: [json key, component]. */
	private static final List<Map.Entry<String, DataComponentType<?>>> VARIANTS = List.of(
			Map.entry("variant", DataComponents.WOLF_VARIANT),
			Map.entry("variant", DataComponents.CAT_VARIANT),
			Map.entry("variant", DataComponents.PIG_VARIANT),
			Map.entry("variant", DataComponents.COW_VARIANT),
			Map.entry("variant", DataComponents.CHICKEN_VARIANT),
			Map.entry("variant", DataComponents.FROG_VARIANT),
			Map.entry("variant", DataComponents.ZOMBIE_NAUTILUS_VARIANT),
			Map.entry("variant", DataComponents.HORSE_VARIANT),
			Map.entry("variant", DataComponents.LLAMA_VARIANT),
			Map.entry("variant", DataComponents.AXOLOTL_VARIANT),
			Map.entry("variant", DataComponents.FOX_VARIANT),
			Map.entry("variant", DataComponents.PARROT_VARIANT),
			Map.entry("variant", DataComponents.RABBIT_VARIANT),
			Map.entry("variant", DataComponents.MOOSHROOM_VARIANT),
			Map.entry("variant", DataComponents.SALMON_SIZE),
			Map.entry("variant", DataComponents.PAINTING_VARIANT),
			Map.entry("villagerType", DataComponents.VILLAGER_VARIANT),
			Map.entry("collar", DataComponents.WOLF_COLLAR),
			Map.entry("collar", DataComponents.CAT_COLLAR),
			Map.entry("color", DataComponents.SHEEP_COLOR),
			Map.entry("color", DataComponents.SHULKER_COLOR),
			Map.entry("color", DataComponents.CUSHION_COLOR),
			Map.entry("pattern", DataComponents.TROPICAL_FISH_PATTERN),
			Map.entry("baseColor", DataComponents.TROPICAL_FISH_BASE_COLOR),
			Map.entry("patternColor", DataComponents.TROPICAL_FISH_PATTERN_COLOR)
	);

	/**
	 * State read with no-argument getters when the entity's class has them: [method, json key]. The names are
	 * the game's (unobfuscated); looking them up by name keeps this independent of package moves between versions.
	 */
	private static final String[][] PROBES = {
			{"isPowered", "powered"},
			{"isSheared", "sheared"},
			{"getMarkings", "markings"},
			{"getMainGene", "gene"},
			{"getHiddenGene", "hiddenGene"},
			{"isInSittingPose", "sitting"},
			{"isSitting", "sitting"},
			{"getSize", "size"},
			{"getPhantomSize", "size"},
			{"getPuffState", "puff"},
			{"getCrackiness", "crackiness"},
			{"hasPumpkin", "pumpkin"},
			{"getCarriedBlock", "carried"},
			{"isCreepy", "creepy"},
			{"isSuffocating", "cold"},
			{"hasNectar", "nectar"},
			{"hasStung", "stung"},
			{"isAngry", "angry"},
			{"isTame", "tame"},
			{"hasLeftHorn", "leftHorn"},
			{"hasRightHorn", "rightHorn"},
			{"isCharging", "charging"},
			{"isPlayingDead", "playingDead"},
			{"hasChest", "chest"},
			{"getRawPeekAmount", "peek"},
			{"getAttachFace", "attach"},
			{"getInvulnerableTicks", "invulnerable"},
			{"getFuse", "fuse"},
			{"getBlockState", "block"},
			{"isSmall", "small"},
			{"showArms", "arms"},
			{"isLeashed", "leashed"},
			{"isVehicle", "ridden"},
			{"isFlying", "flying"},
			{"isDancing", "dancing"},
			{"getVillagerData", "villager"},
			{"isShaking", "shaking"},
			{"isFullyFrozen", "frozen"},
			{"isDrinkingPotion", "drinking"},
			{"getIcon", "icon"},
			{"getRotation", "rotation"},
			{"isAggressive", "aggressive"},
	};

	/** Entities that hang on a block face (their direction is the face they are on). */
	private static final Set<String> HANGING = Set.of("minecraft:painting", "minecraft:item_frame", "minecraft:glow_item_frame");

	private static final Map<Class<?>, List<Map.Entry<Method, String>>> PROBE_CACHE = new ConcurrentHashMap<>();
	private static final Map<Class<?>, Optional<Method>> SWELLING_CACHE = new ConcurrentHashMap<>();

	private static final EquipmentSlot[] ARMOR = {EquipmentSlot.HEAD, EquipmentSlot.CHEST, EquipmentSlot.LEGS, EquipmentSlot.FEET};

	private EntityEncoder() {
	}

	static boolean shouldSend(Entity entity, String type) {
		if (HIDDEN_TYPES.contains(type)) {
			return false;
		}
		return !(entity instanceof Player player) || !player.isSpectator();
	}

	static void write(Json json, Entity entity, String type, IntConsumer blockStates) {
		json.beginObject()
				.field("id", entity.getId())
				.field("type", type)
				.field("x", entity.getX(), 3)
				.field("y", entity.getY(), 3)
				.field("z", entity.getZ(), 3)
				.field("yaw", entity.getYRot(), 1)
				.field("pitch", entity.getXRot(), 1)
				.field("w", entity.getBbWidth(), 3)
				.field("h", entity.getBbHeight(), 3)
				.field("age", entity.tickCount);

		if (entity instanceof LivingEntity living) {
			json.field("body", living.yBodyRot, 1)
					.field("head", living.getYHeadRot(), 1);
			if (!entity.isPassenger() && living.isAlive()) {
				json.field("walk", living.walkAnimation.position(), 3)
						.field("walkSpeed", living.walkAnimation.speed(), 3);
			}
			float scale = living.getScale();
			if (scale != 1.0F) {
				json.field("scale", scale, 3);
			}
			if (living.isBaby()) {
				json.field("baby", true);
			}
			if (living.hurtTime > 0) {
				json.field("hurt", true);
			}
			if (living.isDeadOrDying()) {
				json.field("dead", true).field("deathTime", living.deathTime);
			}
			if (living.isSwinging()) {
				json.field("swing", true);
			}
			writeItem(json, "hand", living.getMainHandItem());
			writeItem(json, "offhand", living.getOffhandItem());
			writeItem(json, "saddle", living.getItemBySlot(EquipmentSlot.SADDLE));
			writeItem(json, "bodyArmor", living.getItemBySlot(EquipmentSlot.BODY));
			writeArmor(json, living);
		}

		if (entity instanceof Player player) {
			json.field("name", player.getGameProfile().name())
					.field("uuid", player.getUUID().toString());
		} else if (entity.hasCustomName() && entity.getCustomName() != null) {
			json.field("name", entity.getCustomName().getString());
		}

		if (entity instanceof ItemEntity item) {
			writeItem(json, "item", item.getItem());
		} else {
			// Item frames and thrown items (snowballs, potions, eyes of ender...) show an item too.
			ItemStack shown = shownItem(entity);
			if (shown != null) {
				writeItem(json, "item", shown);
			}
		}
		if (entity instanceof LightningBolt bolt) {
			json.field("seed", Long.toString(bolt.seed));
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
		if (entity.isOnFire() && !entity.fireImmune()) {
			json.field("burning", true);
		}

		writeState(json, entity, blockStates);
		json.endObject();
	}

	private static void writeItem(Json json, String name, ItemStack stack) {
		if (!stack.isEmpty()) {
			json.field(name, BuiltInRegistries.ITEM.getKey(stack.getItem()).toString());
		}
	}

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

	private static final Map<Class<?>, Optional<Method>> ITEM_CACHE = new ConcurrentHashMap<>();

	private static @Nullable ItemStack shownItem(Entity entity) {
		Method method = ITEM_CACHE.computeIfAbsent(entity.getClass(), cls -> {
			try {
				Method m = cls.getMethod("getItem");
				return ItemStack.class.isAssignableFrom(m.getReturnType()) ? Optional.of(m) : Optional.empty();
			} catch (NoSuchMethodException | SecurityException e) {
				return Optional.empty();
			}
		}).orElse(null);
		if (method == null) {
			return null;
		}
		try {
			return (ItemStack) method.invoke(entity);
		} catch (ReflectiveOperationException | RuntimeException e) {
			return null;
		}
	}

	/** Variants and render state in a {@code "d"} object; only non-default values. */
	private static void writeState(Json json, Entity entity, IntConsumer blockStates) {
		boolean open = false;
		String type = BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString();
		if (HANGING.contains(type)) {
			json.name("d").beginObject();
			open = true;
			json.field("facing", entity.getDirection().getSerializedName());
			writePainting(json, entity);
		}
		for (Map.Entry<String, DataComponentType<?>> variant : VARIANTS) {
			Object value;
			try {
				value = entity.get(variant.getValue());
			} catch (RuntimeException e) {
				continue;
			}
			String text = describe(value);
			if (text != null) {
				if (!open) {
					json.name("d").beginObject();
					open = true;
				}
				json.field(variant.getKey(), text);
			}
		}

		for (Map.Entry<Method, String> probe : probes(entity.getClass())) {
			Object value;
			try {
				value = probe.getKey().invoke(entity);
			} catch (ReflectiveOperationException | RuntimeException e) {
				continue;
			}
			if (value == null || Boolean.FALSE.equals(value)) {
				continue;
			}
			if (!open) {
				json.name("d").beginObject();
				open = true;
			}
			writeValue(json, probe.getValue(), value, blockStates);
		}

		Method swelling = SWELLING_CACHE.computeIfAbsent(entity.getClass(), EntityEncoder::findSwelling).orElse(null);
		if (swelling != null) {
			try {
				float value = (float) swelling.invoke(entity, 1.0F);
				if (value > 0) {
					if (!open) {
						json.name("d").beginObject();
						open = true;
					}
					json.field("swelling", value, 3);
				}
			} catch (ReflectiveOperationException | RuntimeException ignored) {
				// No swelling.
			}
		}

		if (open) {
			json.endObject();
		}
	}

	/** Painting size and texture from its variant (read through accessors, the class moved between versions). */
	private static void writePainting(Json json, Entity entity) {
		Object holder;
		try {
			holder = entity.get(DataComponents.PAINTING_VARIANT);
		} catch (RuntimeException e) {
			return;
		}
		if (!(holder instanceof Holder<?> variant)) {
			return;
		}
		Object value = variant.value();
		try {
			json.field("pw", ((Number) value.getClass().getMethod("width").invoke(value)).intValue());
			json.field("ph", ((Number) value.getClass().getMethod("height").invoke(value)).intValue());
			Object asset = value.getClass().getMethod("assetId").invoke(value);
			if (asset != null) {
				json.field("asset", asset.toString());
			}
		} catch (ReflectiveOperationException | RuntimeException ignored) {
			// Unknown layout: the viewer skips the picture.
		}
	}

	private static void writeValue(Json json, String key, Object value, IntConsumer blockStates) {
		if (value instanceof Boolean flag) {
			json.field(key, flag);
		} else if (value instanceof Float || value instanceof Double) {
			json.field(key, ((Number) value).doubleValue(), 3);
		} else if (value instanceof Number number) {
			json.field(key, number.longValue());
		} else if (value instanceof BlockState state) {
			int id = Block.getId(state);
			blockStates.accept(id);
			json.field(key, id);
		} else if (key.equals("villager")) {
			writeVillager(json, value);
		} else {
			String text = describe(value);
			if (text != null) {
				json.field(key, text);
			}
		}
	}

	/** VillagerData is a record (type, profession, level); read it through its accessors. */
	private static void writeVillager(Json json, Object data) {
		json.name("villager").beginObject();
		for (String component : new String[]{"type", "profession", "level"}) {
			try {
				Object value = data.getClass().getMethod(component).invoke(data);
				if (value instanceof Number number) {
					json.field(component, number.longValue());
				} else {
					String text = describe(value);
					if (text != null) {
						json.field(component, text);
					}
				}
			} catch (ReflectiveOperationException | RuntimeException ignored) {
				// Leave it out.
			}
		}
		json.endObject();
	}

	/** Registry entries by id, enums by their serialized name. */
	private static @Nullable String describe(@Nullable Object value) {
		if (value == null) {
			return null;
		}
		if (value instanceof Optional<?> optional) {
			return optional.map(EntityEncoder::describe).orElse(null);
		}
		if (value instanceof Holder<?> holder) {
			return holder.unwrapKey().map(key -> key.identifier().toString()).orElse(null);
		}
		if (value instanceof StringRepresentable representable) {
			return representable.getSerializedName();
		}
		if (value instanceof Enum<?> constant) {
			return constant.name().toLowerCase(Locale.ROOT);
		}
		return null;
	}

	private static List<Map.Entry<Method, String>> probes(Class<?> type) {
		return PROBE_CACHE.computeIfAbsent(type, cls -> {
			List<Map.Entry<Method, String>> found = new ArrayList<>();
			for (String[] probe : PROBES) {
				try {
					Method method = cls.getMethod(probe[0]);
					if (!Modifier.isStatic(method.getModifiers()) && method.getReturnType() != void.class
							&& found.stream().noneMatch(entry -> entry.getValue().equals(probe[1]))) {
						found.add(Map.entry(method, probe[1]));
					}
				} catch (NoSuchMethodException | SecurityException ignored) {
					// Not this kind of entity.
				}
			}
			return found;
		});
	}

	private static Optional<Method> findSwelling(Class<?> type) {
		try {
			return Optional.of(type.getMethod("getSwelling", float.class));
		} catch (NoSuchMethodException | SecurityException e) {
			return Optional.empty();
		}
	}
}
