package io.github.darienrahl.cctv.camera;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.jspecify.annotations.Nullable;

import com.mojang.authlib.GameProfile;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Holder;
import net.minecraft.core.component.DataComponents;
import net.minecraft.network.chat.Component;
import net.minecraft.util.Util;
import net.minecraft.world.item.ItemStackTemplate;
import net.minecraft.world.item.component.ResolvableProfile;
import net.minecraft.world.level.block.entity.BannerBlockEntity;
import net.minecraft.world.level.block.entity.BannerPatternLayers;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.entity.DecoratedPotBlockEntity;
import net.minecraft.world.level.block.entity.DecoratedPotPattern;
import net.minecraft.world.level.block.entity.PotDecorations;
import net.minecraft.world.level.block.entity.SignBlockEntity;
import net.minecraft.world.level.block.entity.SignText;
import net.minecraft.world.level.block.entity.SignTextSlot;
import net.minecraft.world.level.block.entity.SkullBlockEntity;
import net.minecraft.world.level.chunk.LevelChunk;

import io.github.darienrahl.cctv.web.Json;

/**
 * Block entity details the viewer draws on top of the block models, per section. Only what cannot be
 * seen in the block state: the text of signs and hanging signs, banner patterns, pottery sherds on
 * decorated pots and the owners of player heads.
 */
final class BlockEntityEncoder {
	private BlockEntityEncoder() {
	}

	/** Server thread. JSON array for the section at {@code sy} of the chunk, or {@code null} when there is nothing. */
	static @Nullable String section(LevelChunk chunk, int sy) {
		Json json = null;
		for (BlockEntity blockEntity : chunk.getBlockEntities().values()) {
			BlockPos pos = blockEntity.getBlockPos();
			if ((pos.getY() >> 4) != sy) {
				continue;
			}
			String entry;
			try {
				entry = switch (blockEntity) {
					case SignBlockEntity sign -> sign(sign);
					case BannerBlockEntity banner -> banner(banner);
					case DecoratedPotBlockEntity pot -> pot(pot);
					case SkullBlockEntity skull -> skull(skull);
					default -> null;
				};
			} catch (RuntimeException | LinkageError e) {
				Problems.report(null, "block entity " + blockEntity.getClass().getSimpleName(), e);
				continue;
			}
			if (entry == null) {
				continue;
			}
			if (json == null) {
				json = new Json(256).beginArray();
			}
			json.raw(entry);
		}
		return json == null ? null : json.endArray().toString();
	}

	private static Json begin(String kind, BlockEntity blockEntity) {
		BlockPos pos = blockEntity.getBlockPos();
		return new Json(128).beginObject().field("k", kind).field("x", pos.getX()).field("y", pos.getY()).field("z", pos.getZ());
	}

	/** Sign text, both sides: {@code {"k":"sign", "w", "lh", "f": side, "b": side}}; blank signs are left out. */
	private static @Nullable String sign(SignBlockEntity sign) {
		String front = null;
		String back = null;
		for (SignTextSlot slot : SignTextSlot.values()) {
			String side = text(sign.getText(slot));
			switch (slot.name()) {
				case "FRONT" -> front = side;
				case "BACK" -> back = side;
				default -> {
				}
			}
		}
		if (front == null && back == null) {
			return null;
		}
		Json json = begin("sign", sign).field("w", sign.getMaxTextLineWidth()).field("lh", sign.getTextLineHeight());
		if (front != null) {
			json.name("f").raw(front);
		}
		if (back != null) {
			json.name("b").raw(back);
		}
		return json.endObject().toString();
	}

	/** Banner pattern layers, bottom first: {@code {"k":"banner", "p":[[assetId, dyeColor], ...]}}. */
	private static @Nullable String banner(BannerBlockEntity banner) {
		List<BannerPatternLayers.Layer> layers = banner.getPatterns().layers();
		if (layers.isEmpty()) {
			return null;
		}
		Json json = begin("banner", banner).name("p").beginArray();
		for (BannerPatternLayers.Layer layer : layers) {
			json.beginArray().value(layer.pattern().value().assetId().toString()).value(layer.color().getSerializedName()).endArray();
		}
		return json.endArray().endObject().toString();
	}

	/** Pottery patterns of a decorated pot's sides: {@code {"k":"pot", "front", "back", "left", "right": assetId}}. */
	private static @Nullable String pot(DecoratedPotBlockEntity pot) {
		PotDecorations decorations = pot.getDecorations();
		String front = pattern(decorations.front());
		String back = pattern(decorations.back());
		String left = pattern(decorations.left());
		String right = pattern(decorations.right());
		if (front == null && back == null && left == null && right == null) {
			return null;
		}
		Json json = begin("pot", pot);
		if (front != null) {
			json.field("front", front);
		}
		if (back != null) {
			json.field("back", back);
		}
		if (left != null) {
			json.field("left", left);
		}
		if (right != null) {
			json.field("right", right);
		}
		return json.endObject().toString();
	}

	private static @Nullable String pattern(Optional<ItemStackTemplate> item) {
		if (item.isEmpty()) {
			return null;
		}
		Holder<DecoratedPotPattern> pattern = item.get().get(DataComponents.PROVIDES_POTTERY_PATTERN);
		return pattern == null ? null : pattern.value().assetId().toString();
	}

	/** The owner of a player head, whose skin it shows: {@code {"k":"head", "uuid", "name"}}. */
	private static @Nullable String skull(SkullBlockEntity skull) {
		ResolvableProfile owner = skull.getOwnerProfile();
		if (owner == null) {
			return null;
		}
		GameProfile profile = owner.partialProfile();
		UUID id = profile.id();
		String name = owner.name().orElse(profile.name());
		boolean hasId = id != null && !id.equals(Util.NIL_UUID);
		if (!hasId && (name == null || name.isEmpty())) {
			return null;
		}
		Json json = begin("head", skull);
		if (hasId) {
			json.field("uuid", id.toString());
		}
		if (name != null && !name.isEmpty()) {
			json.field("name", name);
		}
		return json.endObject().toString();
	}

	/** One side of a sign: lines, text colour and glow, or {@code null} when it is blank. */
	private static @Nullable String text(SignText text) {
		List<Component> lines = text.getMessages(false);
		boolean blank = true;
		for (Component line : lines) {
			if (!line.getString().isEmpty()) {
				blank = false;
				break;
			}
		}
		if (blank) {
			return null;
		}
		Json json = new Json(96).beginObject().name("l").beginArray();
		for (Component line : lines) {
			json.value(line.getString());
		}
		json.endArray().field("c", text.getColor().getTextColor());
		if (text.hasGlowingText()) {
			json.field("g", true);
		}
		return json.endObject().toString();
	}
}
