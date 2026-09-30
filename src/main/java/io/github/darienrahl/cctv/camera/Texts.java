package io.github.darienrahl.cctv.camera;

import java.util.Optional;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.jspecify.annotations.Nullable;

import net.minecraft.locale.Language;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.contents.TranslatableContents;

/**
 * Texts of components as the client shows them, in the viewer's language: translation keys are looked up in
 * the client's language files with the resource packs over them (a custom music disc's description comes from
 * its pack), then in the server's own en_us, then the component's fallback.
 */
final class Texts {
	private static final Pattern FORMAT = Pattern.compile("%(?:(\\d+)\\$)?([A-Za-z%])");

	/** Set by the camera manager: the client's translations (ClientAssets#translation). */
	static volatile Function<String, @Nullable String> lookup = key -> null;

	private Texts() {
	}

	static String plain(Component component) {
		StringBuilder out = new StringBuilder();
		append(out, component, 0);
		return out.toString();
	}

	/** A translated key with plain arguments, e.g. {@code record.nowPlaying}. */
	static String translate(String key, String fallback, Object... args) {
		String format = lookup.apply(key);
		if (format == null) {
			format = Language.getInstance().has(key) ? Language.getInstance().getOrDefault(key) : fallback;
		}
		return format(format, args, 0);
	}

	private static void append(StringBuilder out, Component component, int depth) {
		if (depth > 16) {
			return;
		}
		if (component.getContents() instanceof TranslatableContents translatable) {
			String key = translatable.getKey();
			String format = lookup.apply(key);
			if (format == null) {
				format = Language.getInstance().has(key) ? Language.getInstance().getOrDefault(key)
						: translatable.getFallback() != null ? translatable.getFallback() : key;
			}
			out.append(format(format, translatable.getArgs(), depth));
		} else {
			component.getContents().visit(text -> {
				out.append(text);
				return Optional.empty();
			});
		}
		for (Component sibling : component.getSiblings()) {
			append(out, sibling, depth + 1);
		}
	}

	/** TranslatableContents.decomposeTemplate: %s in order, %1$s by position, %% for a percent sign. */
	private static String format(String format, Object[] args, int depth) {
		StringBuilder out = new StringBuilder();
		Matcher matcher = FORMAT.matcher(format);
		int next = 0;
		int last = 0;
		while (matcher.find()) {
			out.append(format, last, matcher.start());
			last = matcher.end();
			if (matcher.group(2).equals("%")) {
				out.append('%');
				continue;
			}
			int index = matcher.group(1) != null ? Integer.parseInt(matcher.group(1)) - 1 : next++;
			if (index >= 0 && index < args.length) {
				Object arg = args[index];
				if (arg instanceof Component nested) {
					append(out, nested, depth + 1);
				} else {
					out.append(arg);
				}
			}
		}
		out.append(format, last, format.length());
		return out.toString();
	}
}
