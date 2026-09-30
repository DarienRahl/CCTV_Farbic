package io.github.darienrahl.cctv.camera;

import java.lang.reflect.Field;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.IntConsumer;

import org.joml.Quaternionfc;
import org.joml.Vector3fc;
import org.jspecify.annotations.Nullable;

import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.Style;
import net.minecraft.network.chat.TextColor;
import net.minecraft.network.syncher.EntityDataAccessor;
import net.minecraft.world.entity.Display;
import net.minecraft.world.item.ItemDisplayContext;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;

import io.github.darienrahl.cctv.web.Json;

/**
 * Block, item and text displays as DisplayRenderer draws them ({@code "disp"}): their synched data, read like the
 * client reads it (the accessors are private; they are looked up by the game's names once).
 *
 * <pre>
 * t   transformation: translation xyz, left rotation xyzw, scale xyz, right rotation xyzw (Display.createTransformation)
 * bb  billboard (1 vertical, 2 horizontal, 3 center; fixed when left out)
 * br  packed brightness override (block &lt;&lt; 4 | sky &lt;&lt; 20), sr / ss shadow radius and strength, vr view range
 * id  transformation interpolation duration, is its start delay, pd position interpolation (teleport_duration)
 * b   block state id (block display); ctx item display context (item display, with the item fields)
 * tx  text display: {s: [[text, rgb or -1, flags (1 bold, 2 italic, 4 underlined, 8 strikethrough, 16 obfuscated)], ...],
 *     w line width, o text opacity byte, bg background ARGB, f style flags}
 * </pre>
 */
final class DisplayEncoder {
	/** Longest text sent for one text display (holograms are short; this keeps a runaway component in check). */
	private static final int MAX_TEXT = 2048;
	private static final Map<String, Optional<EntityDataAccessor<?>>> ACCESSORS = new ConcurrentHashMap<>();

	private DisplayEncoder() {
	}

	static void write(Json json, Display display, IntConsumer blockStates) {
		json.name("disp").beginObject();
		Vector3fc translation = get(display, Display.class, "DATA_TRANSLATION_ID");
		Quaternionfc left = get(display, Display.class, "DATA_LEFT_ROTATION_ID");
		Vector3fc scale = get(display, Display.class, "DATA_SCALE_ID");
		Quaternionfc right = get(display, Display.class, "DATA_RIGHT_ROTATION_ID");
		if (translation != null && left != null && scale != null && right != null) {
			json.name("t").beginArray()
					.value(translation.x(), 4).value(translation.y(), 4).value(translation.z(), 4)
					.value(left.x(), 5).value(left.y(), 5).value(left.z(), 5).value(left.w(), 5)
					.value(scale.x(), 4).value(scale.y(), 4).value(scale.z(), 4)
					.value(right.x(), 5).value(right.y(), 5).value(right.z(), 5).value(right.w(), 5)
					.endArray();
		}
		Byte billboard = get(display, Display.class, "DATA_BILLBOARD_RENDER_CONSTRAINTS_ID");
		if (billboard != null && billboard != 0) {
			json.field("bb", billboard);
		}
		Integer brightness = get(display, Display.class, "DATA_BRIGHTNESS_OVERRIDE_ID");
		if (brightness != null && brightness != -1) {
			json.field("br", brightness);
		}
		Float shadowRadius = get(display, Display.class, "DATA_SHADOW_RADIUS_ID");
		if (shadowRadius != null && shadowRadius > 0) {
			Float strength = get(display, Display.class, "DATA_SHADOW_STRENGTH_ID");
			json.field("sr", shadowRadius, 3).field("ss", strength == null ? 1 : strength, 3);
		}
		Float viewRange = get(display, Display.class, "DATA_VIEW_RANGE_ID");
		if (viewRange != null && viewRange != 1) {
			json.field("vr", viewRange, 3);
		}
		Integer duration = get(display, Display.class, "DATA_TRANSFORMATION_INTERPOLATION_DURATION_ID");
		if (duration != null && duration > 0) {
			Integer delay = get(display, Display.class, "DATA_TRANSFORMATION_INTERPOLATION_START_DELTA_TICKS_ID");
			json.field("id", duration).field("is", delay == null ? 0 : delay);
		}
		Integer teleport = get(display, Display.class, "DATA_POS_ROT_INTERPOLATION_DURATION_ID");
		if (teleport != null && teleport > 0) {
			json.field("pd", teleport);
		}

		if (display instanceof Display.BlockDisplay) {
			BlockState state = get(display, Display.BlockDisplay.class, "DATA_BLOCK_STATE_ID");
			if (state != null && !state.isAir()) {
				int id = Block.getId(state);
				blockStates.accept(id);
				json.field("b", id);
			}
		} else if (display instanceof Display.ItemDisplay) {
			Byte context = get(display, Display.ItemDisplay.class, "DATA_ITEM_DISPLAY_ID");
			if (context != null) {
				json.field("ctx", ItemDisplayContext.BY_ID.apply(context).getSerializedName());
			}
		} else if (display instanceof Display.TextDisplay) {
			writeText(json, display);
		}
		json.endObject();
	}

	/** The item an item display shows (EntityEncoder writes it like the item of an item frame), or null. */
	static @Nullable ItemStack item(Display display) {
		return display instanceof Display.ItemDisplay ? get(display, Display.ItemDisplay.class, "DATA_ITEM_STACK_ID") : null;
	}

	/** The text as styled pieces (Component.visit), with the line width, opacity, background and flags. */
	private static void writeText(Json json, Display display) {
		Component text = get(display, Display.TextDisplay.class, "DATA_TEXT_ID");
		json.name("tx").beginObject().name("s").beginArray();
		if (text != null) {
			int[] left = {MAX_TEXT};
			text.visit((style, piece) -> {
				if (left[0] <= 0) {
					return Optional.of(Boolean.TRUE);
				}
				String shown = piece.length() > left[0] ? piece.substring(0, left[0]) : piece;
				left[0] -= shown.length();
				if (!shown.isEmpty()) {
					TextColor color = style.getColor();
					json.beginArray().value(shown).value(color == null ? -1 : color.getValue()).value(flags(style));
					if (!Objects.equals(style.getFont(), Style.EMPTY.getFont())) {
						json.value(style.getFont().toString());
					}
					json.endArray();
				}
				return Optional.empty();
			}, Style.EMPTY);
		}
		json.endArray();
		Integer width = get(display, Display.TextDisplay.class, "DATA_LINE_WIDTH_ID");
		if (width != null && width != 200) {
			json.field("w", width);
		}
		Byte opacity = get(display, Display.TextDisplay.class, "DATA_TEXT_OPACITY_ID");
		if (opacity != null && opacity != -1) {
			json.field("o", opacity);
		}
		Integer background = get(display, Display.TextDisplay.class, "DATA_BACKGROUND_COLOR_ID");
		if (background != null && background != 0x40000000) {
			json.field("bg", background);
		}
		Byte flags = get(display, Display.TextDisplay.class, "DATA_STYLE_FLAGS_ID");
		if (flags != null && flags != 0) {
			json.field("f", flags);
		}
		json.endObject();
	}

	private static int flags(Style style) {
		return (style.isBold() ? 1 : 0) | (style.isItalic() ? 2 : 0) | (style.isUnderlined() ? 4 : 0)
				| (style.isStrikethrough() ? 8 : 0) | (style.isObfuscated() ? 16 : 0);
	}

	@SuppressWarnings("unchecked")
	private static <T> @Nullable T get(Display display, Class<?> owner, String name) {
		Optional<EntityDataAccessor<?>> accessor = ACCESSORS.computeIfAbsent(owner.getName() + "." + name, key -> {
			try {
				Field field = owner.getDeclaredField(name);
				field.setAccessible(true);
				return Optional.of((EntityDataAccessor<?>) field.get(null));
			} catch (ReflectiveOperationException | RuntimeException e) {
				Problems.report(null, "display entity data " + name, e);
				return Optional.empty();
			}
		});
		if (accessor.isEmpty()) {
			return null;
		}
		try {
			return (T) display.getEntityData().get(accessor.get());
		} catch (RuntimeException e) {
			return null;
		}
	}
}
