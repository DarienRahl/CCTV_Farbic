package io.github.darienrahl.cctv.camera;

import java.lang.reflect.Field;
import java.lang.reflect.Member;
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

import net.minecraft.core.BlockPos;
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
import net.minecraft.world.entity.Crackiness;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.HumanoidArm;
import net.minecraft.world.entity.Leashable;
import net.minecraft.world.entity.LightningBolt;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Pose;
import net.minecraft.world.entity.decoration.ItemFrame;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.animal.sniffer.Sniffer;
import net.minecraft.world.entity.monster.Guardian;
import net.minecraft.world.entity.monster.illager.AbstractIllager;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.entity.player.PlayerModelPart;
import net.minecraft.world.entity.projectile.FishingHook;
import net.minecraft.world.entity.vehicle.boat.AbstractBoat;
import net.minecraft.world.item.CrossbowItem;
import net.minecraft.world.item.DyeColor;
import net.minecraft.world.item.FishingRodItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.component.DyedItemColor;
import net.minecraft.world.item.equipment.Equippable;
import net.minecraft.world.item.equipment.trim.ArmorTrim;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.RenderShape;
import net.minecraft.world.level.block.entity.BannerPatternLayers;
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
	private static final String HORSES = "minecraft:horse minecraft:donkey minecraft:mule minecraft:skeleton_horse minecraft:zombie_horse";
	private static final String ILLAGERS = "minecraft:vindicator minecraft:pillager minecraft:evoker minecraft:illusioner";

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
			{"onGround", "onGround", "minecraft:axolotl minecraft:bee minecraft:turtle"},
			// Fish tails beat harder out of water; TurtleModel swims or walks.
			{"isInWater", "inWater", "minecraft:cod minecraft:salmon minecraft:tropical_fish minecraft:tadpole minecraft:turtle"},
			{"isInterested", "interested", "minecraft:wolf"},
			{"getHealth", "health", "minecraft:wolf"},
			// Guardians' spikes and tail (Guardian.aiStep), the warden's heartbeat pace, the enderman's stare sound.
			{"isMoving", "moving", "minecraft:guardian minecraft:elder_guardian"},
			{"isInWater", "inWater", "minecraft:guardian minecraft:elder_guardian"},
			{"getClientAngerLevel", "anger", "minecraft:warden"},
			{"hasBeenStaredAt", "staredAt", "minecraft:enderman"},
			{"getMaxHealth", "maxHealth", "minecraft:wolf"},
			// Poses of FoxModel, PandaModel, AbstractEquineModel and IllagerModel (their renderers' extractRenderState).
			{"isCrouching", "crouching", "minecraft:fox"},
			{"isSleeping", "sleeping", "minecraft:fox"},
			{"isFaceplanted", "faceplanted", "minecraft:fox"},
			{"isPouncing", "pouncing", "minecraft:fox"},
			{"isSneezing", "sneezing", "minecraft:panda"},
			{"isEating", "eating", "minecraft:panda"},
			{"isScared", "scared", "minecraft:panda"},
			{"isInWater", "inWater", HORSES},
			{"getArmPose", "armPose", ILLAGERS},
			{"getMainArm", "mainArm", ILLAGERS},
			// Protected: which spell a spellcaster's hands glow with (SpellcasterIllager.tick, client).
			{"getCurrentSpell", "spell", "minecraft:evoker minecraft:illusioner"},
			// AbstractFelineModel (sprinting cats and ocelots), PolarBearModel (standing up)
			{"isSprinting", "sprinting", "minecraft:cat minecraft:ocelot"},
			{"isStanding", "standing", "minecraft:polar_bear"},
			// TurtleModel: the egg belly and faster flippers while digging
			{"hasEgg", "hasEgg", "minecraft:turtle"},
			{"isLayingEgg", "layingEgg", "minecraft:turtle"},
	};

	/**
	 * Animation amounts the game's entity tick also computes on the server (the inputs of the renderers'
	 * extractRenderState, e.g. AbstractHorse.getStandAnim): [getter or public field, json key, entity types].
	 * Getters that take the partial tick get 1. Sent only when not zero; the viewer interpolates them.
	 */
	private static final String[][] AMOUNTS = {
			{"getEatAnim", "eat", HORSES},
			{"getStandAnim", "stand", HORSES},
			{"getMouthAnim", "mouth", HORSES},
			{"tailCounter", "tail", HORSES},
			{"getHeadRollAngle", "headRoll", "minecraft:fox"},
			{"getCrouchAmount", "crouch", "minecraft:fox"},
			{"getSitAmount", "sit", "minecraft:panda"},
			{"getLieOnBackAmount", "onBack", "minecraft:panda"},
			{"getRollAmount", "rollAmount", "minecraft:panda"},
			{"rollCounter", "roll", "minecraft:panda"},
			{"getSneezeCounter", "sneeze", "minecraft:panda"},
			{"getUnhappyCounter", "unhappy", "minecraft:panda"},
			{"getOfferFlowerTick", "flower", "minecraft:iron_golem"},
			{"getTicksUsingItem", "useTicks", ILLAGERS},
			{"getLieDownAmount", "lie", "minecraft:cat"},
			{"getLieDownAmountTail", "lieTail", "minecraft:cat"},
			{"getRelaxStateOneAmount", "relax", "minecraft:cat"},
			{"getRollAmount", "rollAmount", "minecraft:bee"},
			// Chicken.aiStep: the wings flap while it falls
			{"flap", "flap", "minecraft:chicken"},
			{"flapSpeed", "flapSpeed", "minecraft:chicken"},
	};

	private record Amount(Member member, String key) {
		double read(Entity entity) throws ReflectiveOperationException {
			if (member instanceof Field field) {
				return ((Number) field.get(entity)).doubleValue();
			}
			Method method = (Method) member;
			Object value = method.getParameterCount() == 1 ? method.invoke(entity, 1.0F) : method.invoke(entity);
			return ((Number) value).doubleValue();
		}
	}

	private static final Map<Class<?>, List<Amount>> AMOUNT_CACHE = new ConcurrentHashMap<>();

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
			writePatterns(json, "handPatterns", living.getMainHandItem());
			writePatterns(json, "offhandPatterns", living.getOffhandItem());
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
			writePatterns(json, "itemPatterns", item.getItem());
			foil |= foil(item.getItem(), FOIL_ITEM);
		} else {
			// Item frames and thrown items (snowballs, potions, eyes of ender...) show an item too.
			ItemStack shown = shownItem(entity);
			if (shown != null) {
				writeItem(json, "item", shown);
				writePatterns(json, "itemPatterns", shown);
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
		if (entity instanceof AbstractBoat boat) {
			writeBoat(json, boat);
		}
		if (entity instanceof Guardian guardian && guardian.hasActiveAttackTarget()) {
			// the beam's target (Guardian.DATA_ID_ATTACK_TARGET); the viewer times the attack like the client
			LivingEntity target = guardian.getActiveAttackTarget();
			if (target != null) {
				json.field("beam", target.getId());
			}
		}

		// Sniffer.getState is private: digging is the state with the digging sound that is not searching
		if (entity instanceof Sniffer sniffer && sniffer.canPlayDiggingSound() && !sniffer.isSearching()) {
			writeDigging(json, sniffer, blockStates);
		}
		if (entity instanceof FishingHook hook && hook.getPlayerOwner() != null) {
			// FishingHookRenderer: the line runs to the hand holding the rod (getHoldingArm) below the owner's eyes
			Player owner = hook.getPlayerOwner();
			HumanoidArm arm = owner.getMainHandItem().getItem() instanceof FishingRodItem ? owner.getMainArm() : owner.getMainArm().getOpposite();
			json.name("fish").beginArray().value(owner.getId()).value(arm == HumanoidArm.RIGHT ? 1 : -1)
					.value(owner.getEyeHeight(), 3).endArray();
		}

		Pose pose = entity.getPose();
		if (pose != Pose.STANDING) {
			json.field("pose", pose.name().toLowerCase(Locale.ROOT));
		}
		if (entity.isInvisible()) {
			json.field("invisible", true);
		}
		if (entity.isCurrentlyGlowing()) {
			// the Glowing effect or tag: the client outlines it in its team's colour (EntityRenderer.extractRenderState)
			json.field("glow", entity.getTeamColor() & 0xFFFFFF);
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
	 * What AbstractBoatRenderer shows: the paddles' rowing time (AbstractBoat.getRowingTime, rising by pi/8 a tick
	 * while a paddle moves), the rocking when hit and the tilt over a bubble column. Only while not at rest.
	 */
	private static void writeBoat(Json json, AbstractBoat boat) {
		float left = boat.getRowingTime(0, 1.0F);
		float right = boat.getRowingTime(1, 1.0F);
		if (left != 0 || right != 0) {
			json.field("rowL", left, 3).field("rowR", right, 3);
		}
		if (boat.getHurtTime() > 0) {
			json.field("hurtTime", boat.getHurtTime()).field("hurtDir", boat.getHurtDir()).field("damage", boat.getDamage(), 2);
		}
		float bubble = boat.getBubbleAngle(1.0F);
		if (bubble != 0) {
			json.field("bubble", bubble, 2);
		}
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

	/**
	 * An item id, and as {@code <name>Model} the item model it is drawn with when that is not the item's own
	 * (the item_model component: custom music discs and other items of data packs).
	 */
	private static void writeItem(Json json, String name, ItemStack stack) {
		if (!stack.isEmpty()) {
			String id = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
			json.field(name, id);
			Object model = stack.get(DataComponents.ITEM_MODEL);
			if (model != null && !model.toString().equals(id)) {
				json.field(name + "Model", model.toString());
			}
		}
	}

	/**
	 * The base colour and banner patterns of an item that shows them (shields, like ShieldSpecialRenderer):
	 * {"b": base dye, "p": [[pattern asset, dye], ...]}, only when it has either.
	 */
	private static void writePatterns(Json json, String name, ItemStack stack) {
		if (stack.isEmpty()) {
			return;
		}
		DyeColor base = stack.get(DataComponents.BASE_COLOR);
		BannerPatternLayers patterns = stack.get(DataComponents.BANNER_PATTERNS);
		boolean layers = patterns != null && !patterns.layers().isEmpty();
		if (base == null && !layers) {
			return;
		}
		json.name(name).beginObject();
		if (base != null) {
			json.field("b", base.getSerializedName());
		}
		json.name("p").beginArray();
		if (layers) {
			for (BannerPatternLayers.Layer layer : patterns.layers()) {
				json.beginArray().value(layer.pattern().value().assetId().toString()).value(layer.color().getSerializedName()).endArray();
			}
		}
		json.endArray().endObject();
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

	private static final String WOLF = "minecraft:wolf";

	/** The slots EquipmentLayerRenderer draws: the armour (as in "armor") and the body (horse armour, carpets...). */
	private static final EquipmentSlot[] EQUIPMENT = {EquipmentSlot.HEAD, EquipmentSlot.CHEST, EquipmentSlot.LEGS, EquipmentSlot.FEET,
			EquipmentSlot.BODY};

	/**
	 * What EquipmentLayerRenderer needs of each worn piece, as "eq" [head, chest, legs, feet, body] (null for
	 * nothing to draw): the equipment asset ("a", its layers are equipment/*.json of the client), the dye
	 * ("c", DyedItemColor), the trim ("t": pattern, its texture, material, the material's palette, decal) and
	 * how cracked a wolf's armour is ("k": low, medium or high, Crackiness.WOLF_ARMOR).
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
		for (int i = 0; i < stacks.length; i++) {
			ItemStack stack = stacks[i];
			if (stack == null) {
				json.value((String) null);
				continue;
			}
			json.beginObject().field("a", stack.get(DataComponents.EQUIPPABLE).assetId().get().identifier().toString());
			if (EQUIPMENT[i] == EquipmentSlot.BODY && WOLF.equals(BuiltInRegistries.ENTITY_TYPE.getKey(living.getType()).toString())) {
				// WolfArmorLayer.maybeRenderCracks
				Crackiness.Level cracks = Crackiness.WOLF_ARMOR.byDamage(stack);
				if (cracks != Crackiness.Level.NONE) {
					json.field("k", cracks.name().toLowerCase(Locale.ROOT));
				}
			}
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

	/**
	 * Sniffer.emitDiggingParticles (client): the block under its nose and that block's hit sound, as
	 * {@code "dig": [block state, sound]}; the viewer makes the pieces and plays the sound while the digging
	 * animation is at the part where the nose is in the ground.
	 */
	private static void writeDigging(Json json, Sniffer sniffer, IntConsumer blockStates) {
		Vec3 head = sniffer.position().add(sniffer.getForward().scale(2.25));
		BlockState below = sniffer.level().getBlockState(BlockPos.containing(head.x(), sniffer.getY() + 0.2F, head.z()).below());
		if (below.getRenderShape() == RenderShape.INVISIBLE) {
			return;
		}
		int id = Block.getId(below);
		blockStates.accept(id);
		json.name("dig").beginArray().value(id).value(SoundEncoder.id(below.getSoundType().getHitSound())).endArray();
	}

	/** Variants and render state in a {@code "d"} object; only non-default values. */
	private static void writeState(Json out, Entity entity, IntConsumer blockStates) {
		State state = new State(out);
		String type = BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString();
		if (HANGING.contains(type)) {
			state.json().field("facing", entity.getDirection().getSerializedName());
			writePainting(state.json(), entity);
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
				state.json().field(variant.getKey(), text);
			}
		}

		for (Map.Entry<Method, String> probe : probes(entity.getClass(), type)) {
			Object value;
			try {
				value = probe.getKey().invoke(entity);
			} catch (ReflectiveOperationException | RuntimeException e) {
				continue;
			}
			if (value == null || Boolean.FALSE.equals(value) || value instanceof Enum<?> constant && constant.name().equals("NONE")) {
				continue;
			}
			writeValue(state.json(), probe.getValue(), value, blockStates);
		}

		for (Amount amount : amounts(entity.getClass(), type)) {
			double value;
			try {
				value = amount.read(entity);
			} catch (ReflectiveOperationException | RuntimeException e) {
				continue;
			}
			if (value != 0) {
				state.json().field(amount.key(), value, 3);
			}
		}
		if (entity instanceof AbstractIllager illager && illager.getArmPose() == AbstractIllager.IllagerArmPose.CROSSBOW_CHARGE) {
			// IllagerRenderer: how long this crossbow takes to load (quick charge)
			state.json().field("chargeTicks", (double) CrossbowItem.getChargeDuration(illager.getUseItem(), illager), 2);
		}

		Method swelling = SWELLING_CACHE.computeIfAbsent(entity.getClass(), EntityEncoder::findSwelling).orElse(null);
		if (swelling != null) {
			try {
				float value = (float) swelling.invoke(entity, 1.0F);
				if (value > 0) {
					state.json().field("swelling", value, 3);
				}
			} catch (ReflectiveOperationException | RuntimeException ignored) {
				// No swelling.
			}
		}
		state.close();
	}

	/** The {@code "d"} object, opened before its first field. */
	private static final class State {
		private final Json json;
		private boolean open;

		State(Json json) {
			this.json = json;
		}

		Json json() {
			if (!open) {
				json.name("d").beginObject();
				open = true;
			}
			return json;
		}

		void close() {
			if (open) {
				json.endObject();
			}
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
				// protected getters only for the rows of named entity types (a common name could match anything)
				Method method = findGetter(cls, probe[0], probe.length > 2);
				if (method != null && !Modifier.isStatic(method.getModifiers()) && method.getReturnType() != void.class
						&& found.stream().noneMatch(entry -> entry.getValue().equals(probe[1]))) {
					found.add(Map.entry(method, probe[1]));
				}
			}
			return found;
		});
	}

	/** A public no-argument method, else (when allowed) a protected one of the class or its superclasses, made accessible. */
	private static @Nullable Method findGetter(Class<?> type, String name, boolean protectedToo) {
		try {
			return type.getMethod(name);
		} catch (NoSuchMethodException | SecurityException ignored) {
			// Maybe not public.
		}
		if (!protectedToo) {
			return null;
		}
		for (Class<?> cls = type; cls != null && cls != Object.class; cls = cls.getSuperclass()) {
			try {
				Method method = cls.getDeclaredMethod(name);
				if (Modifier.isPrivate(method.getModifiers())) {
					return null;
				}
				method.setAccessible(true);
				return method;
			} catch (NoSuchMethodException ignored) {
				// Look further up.
			} catch (RuntimeException e) {
				return null;
			}
		}
		return null;
	}

	private static List<Amount> amounts(Class<?> type, String entityType) {
		return AMOUNT_CACHE.computeIfAbsent(type, cls -> {
			List<Amount> found = new ArrayList<>();
			for (String[] row : AMOUNTS) {
				if (!List.of(row[2].split(" ")).contains(entityType)) {
					continue;
				}
				Member member = findAmount(cls, row[0]);
				if (member != null) {
					found.add(new Amount(member, row[1]));
				}
			}
			return found;
		});
	}

	/** getX(float partialTick), getX() returning a number, or a public number field. */
	private static @Nullable Member findAmount(Class<?> type, String name) {
		try {
			return type.getMethod(name, float.class);
		} catch (NoSuchMethodException | SecurityException ignored) {
			// Try the next form.
		}
		try {
			Method method = type.getMethod(name);
			if (method.getReturnType().isPrimitive() && method.getReturnType() != boolean.class && method.getReturnType() != void.class) {
				return method;
			}
		} catch (NoSuchMethodException | SecurityException ignored) {
			// Try the next form.
		}
		try {
			Field field = type.getField(name);
			if (field.getType().isPrimitive() && !Modifier.isStatic(field.getModifiers())) {
				return field;
			}
		} catch (NoSuchFieldException | SecurityException ignored) {
			// Not this kind of entity.
		}
		return null;
	}

	private static Optional<Method> findSwelling(Class<?> type) {
		try {
			return Optional.of(type.getMethod("getSwelling", float.class));
		} catch (NoSuchMethodException | SecurityException e) {
			return Optional.empty();
		}
	}
}
