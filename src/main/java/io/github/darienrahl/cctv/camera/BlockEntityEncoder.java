package io.github.darienrahl.cctv.camera;

import java.util.List;

import org.jspecify.annotations.Nullable;

import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.entity.SignBlockEntity;
import net.minecraft.world.level.block.entity.SignText;
import net.minecraft.world.level.block.entity.SignTextSlot;
import net.minecraft.world.level.chunk.LevelChunk;

import io.github.darienrahl.cctv.web.Json;

/**
 * Block entity details the viewer draws on top of the block models, per section. Only what cannot be
 * seen in the block state: the text of signs and hanging signs.
 */
final class BlockEntityEncoder {
	private BlockEntityEncoder() {
	}

	/** Server thread. JSON array for the section at {@code sy} of the chunk, or {@code null} when there is nothing. */
	static @Nullable String section(LevelChunk chunk, int sy) {
		Json json = null;
		for (BlockEntity blockEntity : chunk.getBlockEntities().values()) {
			BlockPos pos = blockEntity.getBlockPos();
			if ((pos.getY() >> 4) != sy || !(blockEntity instanceof SignBlockEntity sign)) {
				continue;
			}
			try {
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
					continue;
				}
				if (json == null) {
					json = new Json(256).beginArray();
				}
				json.beginObject()
						.field("k", "sign")
						.field("x", pos.getX())
						.field("y", pos.getY())
						.field("z", pos.getZ())
						.field("w", sign.getMaxTextLineWidth())
						.field("lh", sign.getTextLineHeight());
				if (front != null) {
					json.name("f").raw(front);
				}
				if (back != null) {
					json.name("b").raw(back);
				}
				json.endObject();
			} catch (RuntimeException | LinkageError e) {
				Problems.report(null, "sign text", e);
			}
		}
		return json == null ? null : json.endArray().toString();
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
