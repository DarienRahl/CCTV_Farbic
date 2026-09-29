package io.github.darienrahl.cctv.camera;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.Collection;
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
import net.minecraft.core.particles.ColorParticleOption;
import net.minecraft.core.particles.ParticleOptions;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.util.StringRepresentable;
import net.minecraft.world.entity.AnimationState;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.Leashable;
import net.minecraft.world.entity.LightningBolt;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Pose;
import net.minecraft.world.entity.decoration.ItemFrame;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.entity.player.PlayerModelPart;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.component.DyedItemColor;
import net.minecraft.world.item.equipment.Equippable;
import net.minecraft.world.item.equipment.trim.ArmorTrim;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.saveddata.maps.MapDecoration;
import net.minecraft.world.level.saveddata.maps.MapId;
import net.minecraft.world.level.saveddata.maps.MapItemSavedData;
import net.minecraft.world.phys.Vec3;

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
			// Inputs of the client-side animation code the viewer ports (mobs.js CLIENT).
			{"isResting", "resting"},
			{"isSearching", "searching"},
			{"getState", "state"},
			{"isCamelSitting", "camelSitting"},
			{"getPoseTime", "poseTime"},
			{"isDashing", "dashing"},
			{"isTearingDown", "tearingDown"},
			{"shouldHideInShell", "hiding"},
			// Methods every entity has: only sent for the types that need them (third column).
			{"isInWater", "inWater", "minecraft:frog minecraft:axolotl"},
			{"onGround", "onGround", "minecraft:axolotl"},
			{"isInterested", "interested", "minecraft:wolf"},
			{"getHealth", "health", "minecraft:wolf"},
			{"getMaxHealth", "maxHealth", "minecraft:wolf"},
	};

	/** Entities that hang on a block face (their direction is the face they are on). */
	private static final Set<String> HANGING = Set.of("minecraft:painting", "minecraft:item_frame", "minecraft:glow_item_frame");

	private static final Map<Class<?>, List<Map.Entry<Method, String>>> PROBE_CACHE = new ConcurrentHashMap<>();
	private static final Map<Class<?>, Optional<Method>> SWELLING_CACHE = new ConcurrentHashMap<>();

	private static final EquipmentSlot[] ARMOR = {EquipmentSlot.HEAD, EquipmentSlot.CHEST, EquipmentSlot.LEGS, EquipmentSlot.FEET};
	/** Bits of the {@code "foil"} mask: items drawn with the enchantment glint (ItemStack#hasFoil). */
	static final int FOIL_HAND = 1, FOIL_OFFHAND = 2, FOIL_ARMOR = 4, FOIL_ITEM = 64, FOIL_BODY = 128;

	private EntityEncoder() {
	}

	static boolean shouldSend(Entity entity, String type) {
		if (HIDDEN_TYPES.contains(type)) {
			return false;
		}
		return !(entity instanceof Player player) || !player.isSpectator();
	}

	static void write(Json json, Entity entity, String type, IntConsumer blockStates) {
		write(json, entity, type, blockStates, null);
	}

	/** @param events entity events since the last frame ({@code "ev"}), replayed by the viewer like handleEntityEvent */
	static void write(Json json, Entity entity, String type, IntConsumer blockStates, @Nullable List<Integer> events) {
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
		int foil = 0;

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
			writeEquipment(json, living);
			writeEffectParticles(json, living);
			foil = foil(living.getMainHandItem(), FOIL_HAND) | foil(living.getOffhandItem(), FOIL_OFFHAND)
					| foil(living.getItemBySlot(EquipmentSlot.BODY), FOIL_BODY);
			for (int i = 0; i < ARMOR.length; i++) {
				foil |= foil(living.getItemBySlot(ARMOR[i]), FOIL_ARMOR << i);
			}
		}

		if (entity instanceof Player player) {
			json.field("name", player.getGameProfile().name())
					.field("uuid", player.getUUID().toString());
			// Skin layers and cape the player turned off in their skin customisation (PlayerModelPart masks).
			int parts = 0;
			int all = 0;
			for (PlayerModelPart part : PlayerModelPart.values()) {
				all |= part.getMask();
				if (player.isModelPartShown(part)) {
					parts |= part.getMask();
				}
			}
			if (parts != all) {
				json.field("parts", parts);
			}
		} else if (entity.hasCustomName() && entity.getCustomName() != null) {
			json.field("name", entity.getCustomName().getString());
			if (entity.isCustomNameVisible()) {
				// The game shows other custom names only while the crosshair is on the entity.
				json.field("nameVisible", true);
			}
		}

		if (entity instanceof ItemEntity item) {
			writeItem(json, "item", item.getItem());
			foil |= foil(item.getItem(), FOIL_ITEM);
		} else {
			// Item frames and thrown items (snowballs, potions, eyes of ender...) show an item too.
			ItemStack shown = shownItem(entity);
			if (shown != null) {
				writeItem(json, "item", shown);
				foil |= foil(shown, FOIL_ITEM);
			}
		}
		if (foil != 0) {
			json.field("foil", foil);
		}
		if (entity instanceof ItemFrame frame) {
			writeFramedMap(json, frame);
		}
		if (entity instanceof Leashable leashable && leashable.getLeashHolder() != null) {
			writeLeash(json, entity, leashable, leashable.getLeashHolder());
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
		if (entity.getControllingPassenger() instanceof Player) {
			// Moved by the rider's client: the server does not animate it, the viewer derives it from the motion.
			json.field("steered", true);
		}
		if (entity.isOnFire() && !entity.fireImmune()) {
			json.field("burning", true);
		}
		writeAnimations(json, entity);
		if (events != null && !events.isEmpty()) {
			json.name("ev").beginArray();
			for (int event : events) {
				json.value(event);
			}
			json.endArray();
		}

		writeState(json, entity, blockStates);
		json.endObject();
	}

	/**
	 * Running keyframe animations: every {@link AnimationState} field of the entity (roaring warden, sniffing
	 * sniffer, croaking frog...) that is started, as {@code "anim": {"roarAnimationState": millisSinceStart}}.
	 * The field names are the ones the client's render states and models use, so the viewer can pair them
	 * with the game's animation definitions.
	 */
	private static void writeAnimations(Json json, Entity entity) {
		Field[] fields = ANIMATION_STATES.computeIfAbsent(entity.getClass(), EntityEncoder::animationStateFields);
		boolean open = false;
		for (Field field : fields) {
			try {
				AnimationState state = (AnimationState) field.get(entity);
				if (state == null || !state.isStarted()) {
					continue;
				}
				if (!open) {
					json.name("anim").beginObject();
					open = true;
				}
				json.field(field.getName(), state.getTimeInMillis(entity.tickCount));
			} catch (ReflectiveOperationException | RuntimeException e) {
				Problems.report(null, "animation state " + field.getName(), e);
			}
		}
		if (open) {
			json.endObject();
		}
	}

	private static final Map<Class<?>, Field[]> ANIMATION_STATES = new ConcurrentHashMap<>();

	private static Field[] animationStateFields(Class<?> type) {
		List<Field> fields = new ArrayList<>();
		for (Class<?> cls = type; cls != null && cls != Object.class; cls = cls.getSuperclass()) {
			for (Field field : cls.getDeclaredFields()) {
				if (field.getType() == AnimationState.class && !Modifier.isStatic(field.getModifiers())) {
					try {
						field.setAccessible(true);
						fields.add(field);
					} catch (RuntimeException e) {
						Problems.report(null, "animation state " + field.getName(), e);
					}
				}
			}
		}
		return fields.toArray(Field[]::new);
	}

	/**
	 * EntityRenderer#extractRenderState's leash: the holder and where the leash is tied, as offsets from the
	 * entity's and the holder's positions (so the viewer follows both as they move); "q" holds the four
	 * leashes of a quad connection (a happy ghast's harness), each [entity offset, holder offset].
	 */
	private static void writeLeash(Json json, Entity entity, Leashable leashable, Entity holder) {
		float yRot = entity.getPreciseBodyRotation(1.0F) * (float) (Math.PI / 180.0);
		json.name("leash").beginObject().field("h", holder.getId());
		if (holder.supportQuadLeashAsHolder() && leashable.supportQuadLeash()) {
			float holderYRot = holder.getPreciseBodyRotation(1.0F) * (float) (Math.PI / 180.0);
			Vec3[] own = leashable.getQuadLeashOffsets();
			Vec3[] held = holder.getQuadLeashHolderOffsets();
			json.name("q").beginArray();
			for (int i = 0; i < Math.min(own.length, held.length); i++) {
				json.beginArray();
				vec(json, own[i].yRot(-yRot));
				vec(json, held[i].yRot(-holderYRot));
				json.endArray();
			}
			json.endArray();
		} else {
			json.name("o");
			vec(json, leashable.getLeashOffset(1.0F).yRot(-yRot));
			json.name("e");
			vec(json, holder.getRopeHoldPosition(1.0F).subtract(holder.position()));
		}
		json.endObject();
	}

	private static void vec(Json json, Vec3 v) {
		json.beginArray().value(v.x, 3).value(v.y, 3).value(v.z, 3).endArray();
	}

	/**
	 * LivingEntity's DATA_EFFECT_PARTICLES and DATA_EFFECT_AMBIENCE_ID (updateSynchronizedMobEffectParticles): the
	 * particles of the visible effects, [type] or [type, ARGB colour] for coloured ones, which the client puffs
	 * around the entity (tickEffects); "amb" when all effects are ambient (beacons), which makes it rarer.
	 */
	private static void writeEffectParticles(Json json, LivingEntity living) {
		Collection<MobEffectInstance> effects = living.getActiveEffects();
		if (effects.isEmpty()) {
			return;
		}
		boolean any = false;
		for (MobEffectInstance effect : effects) {
			if (!effect.isVisible()) {
				continue;
			}
			if (!any) {
				json.name("fxp").beginArray();
				any = true;
			}
			ParticleOptions particle = effect.getParticleOptions();
			json.beginArray().value(BuiltInRegistries.PARTICLE_TYPE.getKey(particle.getType()).toString());
			if (particle instanceof ColorParticleOption color) {
				json.value((long) (Math.round(color.getAlpha() * 255) << 24 | Math.round(color.getRed() * 255) << 16
						| Math.round(color.getGreen() * 255) << 8 | Math.round(color.getBlue() * 255)) & 0xFFFFFFFFL);
			}
			json.endArray();
		}
		if (any) {
			json.endArray();
			if (LivingEntity.areAllEffectsAmbient(effects)) {
				json.field("amb", true);
			}
		}
	}

	private static int foil(ItemStack stack, int bit) {
		return !stack.isEmpty() && stack.hasFoil() ? bit : 0;
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

	/** The slots EquipmentLayerRenderer draws: the armour (as in "armor") and the body (horse armour, carpets...). */
	private static final EquipmentSlot[] EQUIPMENT = {EquipmentSlot.HEAD, EquipmentSlot.CHEST, EquipmentSlot.LEGS, EquipmentSlot.FEET,
			EquipmentSlot.BODY};

	/**
	 * What EquipmentLayerRenderer needs of each worn piece, as "eq" [head, chest, legs, feet, body] (null for
	 * nothing to draw): the equipment asset ("a", its layers are equipment/*.json of the client), the dye
	 * ("c", DyedItemColor) and the trim ("t": pattern, its texture, material, the material's palette, decal).
	 */
	private static void writeEquipment(Json json, LivingEntity living) {
		ItemStack[] stacks = new ItemStack[EQUIPMENT.length];
		boolean any = false;
		for (int i = 0; i < EQUIPMENT.length; i++) {
			ItemStack stack = living.getItemBySlot(EQUIPMENT[i]);
			Equippable equippable = stack.isEmpty() ? null : stack.get(DataComponents.EQUIPPABLE);
			// HumanoidArmorLayer.shouldRender: an asset, worn in its own slot
			if (equippable != null && equippable.assetId().isPresent() && equippable.slot() == EQUIPMENT[i]) {
				stacks[i] = stack;
				any = true;
			}
		}
		if (!any) {
			return;
		}
		json.name("eq").beginArray();
		for (ItemStack stack : stacks) {
			if (stack == null) {
				json.value((String) null);
				continue;
			}
			json.beginObject().field("a", stack.get(DataComponents.EQUIPPABLE).assetId().get().identifier().toString());
			DyedItemColor dye = stack.get(DataComponents.DYED_COLOR);
			if (dye != null) {
				json.field("c", dye.rgb());
			}
			ArmorTrim trim = stack.get(DataComponents.TRIM);
			if (trim != null) {
				json.name("t").beginArray()
						.value(trim.pattern().unwrapKey().map(key -> key.identifier().toString()).orElse(null))
						.value(trim.pattern().value().assetId().toString())
						.value(trim.material().unwrapKey().map(key -> key.identifier().toString()).orElse(null))
						.value(trim.material().value().paletteId().toString())
						.value(trim.pattern().value().decal())
						.endArray();
			}
			json.endObject();
		}
		json.endArray();
	}

	/**
	 * A filled map in an item frame (ItemFrameRenderer draws its picture instead of the item): its id, the
	 * version of its picture (GET /map/{id}) and the decorations shown on frames (banners, markers...):
	 * [sprite, x, y, rotation, name].
	 */
	private static void writeFramedMap(Json json, ItemFrame frame) {
		ItemStack stack = frame.getItem();
		MapId id = stack.isEmpty() ? null : frame.getFramedMapId(stack);
		MapItemSavedData data = id == null ? null : frame.level().getMapData(id);
		if (data == null) {
			return;
		}
		json.field("map", id.id()).field("mapv", MapPictures.version(id.id(), data, frame.level().getGameTime()));
		boolean open = false;
		for (MapDecoration decoration : data.getDecorations()) {
			if (!decoration.renderOnFrame()) {
				continue;
			}
			if (!open) {
				json.name("mapd").beginArray();
				open = true;
			}
			json.beginArray().value(decoration.getSpriteLocation().toString()).value(decoration.x()).value(decoration.y())
					.value(decoration.rot()).value(decoration.name().map(Component::getString).orElse(null)).endArray();
		}
		if (open) {
			json.endArray();
		}
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

		for (Map.Entry<Method, String> probe : probes(entity.getClass(), type)) {
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

	private static List<Map.Entry<Method, String>> probes(Class<?> type, String entityType) {
		return PROBE_CACHE.computeIfAbsent(type, cls -> {
			List<Map.Entry<Method, String>> found = new ArrayList<>();
			for (String[] probe : PROBES) {
				if (probe.length > 2 && !List.of(probe[2].split(" ")).contains(entityType)) {
					continue;
				}
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
