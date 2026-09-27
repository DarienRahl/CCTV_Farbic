package io.github.darienrahl.cctv.command;

import java.net.URI;
import java.util.List;
import java.util.Locale;
import java.util.function.Predicate;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.DoubleArgumentType;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.builder.RequiredArgumentBuilder;
import com.mojang.brigadier.context.CommandContext;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import com.mojang.brigadier.exceptions.DynamicCommandExceptionType;
import com.mojang.brigadier.exceptions.SimpleCommandExceptionType;
import com.mojang.brigadier.suggestion.SuggestionProvider;
import org.jspecify.annotations.Nullable;

import net.minecraft.ChatFormatting;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.commands.SharedSuggestionProvider;
import net.minecraft.commands.arguments.coordinates.RotationArgument;
import net.minecraft.commands.arguments.coordinates.Vec3Argument;
import net.minecraft.network.chat.ClickEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.HoverEvent;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.network.chat.Style;
import net.minecraft.server.permissions.Permissions;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.phys.Vec2;
import net.minecraft.world.phys.Vec3;

import io.github.darienrahl.cctv.CctvConfig;
import io.github.darienrahl.cctv.CctvMod;
import io.github.darienrahl.cctv.camera.Camera;
import io.github.darienrahl.cctv.camera.CameraManager;

/**
 * {@code /cctv} - placing and managing cameras. Everything is plain vanilla
 * brigadier, so players do not need the mod installed.
 */
public final class CctvCommand {
	private static final SimpleCommandExceptionType NOT_RUNNING = new SimpleCommandExceptionType(
			Component.literal("CCTV nie działa (serwer się jeszcze uruchamia?)"));
	private static final SimpleCommandExceptionType BAD_NAME = new SimpleCommandExceptionType(
			Component.literal("Nazwa kamery: 1-32 znaki, tylko litery, cyfry, _ i -"));
	private static final DynamicCommandExceptionType EXISTS = new DynamicCommandExceptionType(
			name -> Component.literal("Kamera '" + name + "' już istnieje (użyj /cctv move)"));
	private static final DynamicCommandExceptionType UNKNOWN = new DynamicCommandExceptionType(
			name -> Component.literal("Nie ma kamery '" + name + "'"));
	private static final DynamicCommandExceptionType RANGE_TOO_BIG = new DynamicCommandExceptionType(
			max -> Component.literal("Maksymalny zasięg to " + max + " (maxRange w config/cctv/config.json)"));

	private static final SuggestionProvider<CommandSourceStack> CAMERAS = (context, builder) -> {
		CameraManager manager = CctvMod.manager();
		List<String> names = manager == null ? List.of() : manager.list().stream().map(Camera::name).toList();
		return SharedSuggestionProvider.suggest(names, builder);
	};

	private CctvCommand() {
	}

	public static void register(CommandDispatcher<CommandSourceStack> dispatcher) {
		Predicate<CommandSourceStack> op = source -> source.permissions().hasPermission(Permissions.COMMANDS_GAMEMASTER);

		dispatcher.register(Commands.literal("cctv")
				.executes(context -> help(context.getSource()))
				.then(Commands.literal("list")
						.executes(context -> list(context.getSource())))
				.then(Commands.literal("url")
						.executes(context -> url(context.getSource(), null))
						.then(cameraArgument()
								.executes(context -> url(context.getSource(), name(context)))))
				.then(Commands.literal("info")
						.then(cameraArgument()
								.executes(context -> info(context.getSource(), name(context)))))
				.then(Commands.literal("create").requires(op)
						.then(Commands.argument("name", StringArgumentType.word())
								.executes(context -> create(context, null, null))
								.then(Commands.argument("pos", Vec3Argument.vec3())
										.executes(context -> create(context, Vec3Argument.getVec3(context, "pos"), null))
										.then(Commands.argument("rotation", RotationArgument.rotation())
												.executes(context -> create(context, Vec3Argument.getVec3(context, "pos"),
														RotationArgument.getRotation(context, "rotation").getRotation(context.getSource())))))))
				.then(Commands.literal("move").requires(op)
						.then(cameraArgument()
								.executes(context -> move(context, null, null))
								.then(Commands.argument("pos", Vec3Argument.vec3())
										.executes(context -> move(context, Vec3Argument.getVec3(context, "pos"), null))
										.then(Commands.argument("rotation", RotationArgument.rotation())
												.executes(context -> move(context, Vec3Argument.getVec3(context, "pos"),
														RotationArgument.getRotation(context, "rotation").getRotation(context.getSource())))))))
				.then(Commands.literal("aim").requires(op)
						.then(cameraArgument()
								.executes(context -> aim(context, null))
								.then(Commands.argument("target", Vec3Argument.vec3())
										.executes(context -> aim(context, Vec3Argument.getVec3(context, "target"))))))
				.then(Commands.literal("fov").requires(op)
						.then(cameraArgument()
								.then(Commands.argument("degrees", DoubleArgumentType.doubleArg(10, 140))
										.executes(context -> fov(context, DoubleArgumentType.getDouble(context, "degrees"))))))
				.then(Commands.literal("range").requires(op)
						.then(cameraArgument()
								.then(Commands.argument("blocks", IntegerArgumentType.integer(16, 512))
										.executes(context -> range(context, IntegerArgumentType.getInteger(context, "blocks"))))))
				.then(Commands.literal("remove").requires(op)
						.then(cameraArgument()
								.executes(context -> remove(context.getSource(), name(context))))));
	}

	private static RequiredArgumentBuilder<CommandSourceStack, String> cameraArgument() {
		return Commands.argument("name", StringArgumentType.word()).suggests(CAMERAS);
	}

	private static String name(CommandContext<CommandSourceStack> context) {
		return StringArgumentType.getString(context, "name");
	}

	private static CameraManager manager() throws CommandSyntaxException {
		CameraManager manager = CctvMod.manager();
		if (manager == null) {
			throw NOT_RUNNING.create();
		}
		return manager;
	}

	private static Camera camera(CameraManager manager, String name) throws CommandSyntaxException {
		Camera camera = manager.get(name);
		if (camera == null) {
			throw UNKNOWN.create(name);
		}
		return camera;
	}

	/** Without explicit coordinates the camera goes where the executor's eyes are. */
	private static Vec3 lensPosition(CommandSourceStack source) {
		Entity entity = source.getEntity();
		return entity != null ? entity.getEyePosition() : source.getPosition();
	}

	private static String dimension(CommandSourceStack source) {
		return source.getLevel().dimension().identifier().toString();
	}

	private static int help(CommandSourceStack source) {
		source.sendSuccess(() -> Component.literal("CCTV - kamery podglądu na żywo w przeglądarce").withStyle(ChatFormatting.GOLD), false);
		String[] lines = {
				"/cctv create <nazwa> [pos] [yaw pitch] - postaw kamerę (domyślnie: tam gdzie patrzysz)",
				"/cctv move <nazwa> [pos] [yaw pitch] - przenieś kamerę",
				"/cctv aim <nazwa> [cel] - skieruj kamerę na punkt (domyślnie: na ciebie)",
				"/cctv fov <nazwa> <stopnie> - kąt widzenia",
				"/cctv range <nazwa> <bloki> - zasięg widzenia",
				"/cctv remove <nazwa> - usuń kamerę",
				"/cctv list | url [nazwa] | info <nazwa>"
		};
		for (String line : lines) {
			source.sendSuccess(() -> Component.literal(line).withStyle(ChatFormatting.GRAY), false);
		}
		return 1;
	}

	private static int list(CommandSourceStack source) throws CommandSyntaxException {
		CameraManager manager = manager();
		List<Camera> cameras = manager.list();
		if (cameras.isEmpty()) {
			source.sendSuccess(() -> Component.literal("Brak kamer. Postaw pierwszą: /cctv create <nazwa>").withStyle(ChatFormatting.GRAY), false);
			return 0;
		}

		source.sendSuccess(() -> Component.literal("Kamery (" + cameras.size() + "):").withStyle(ChatFormatting.GOLD), false);
		for (Camera camera : cameras) {
			MutableComponent line = Component.literal(String.format(Locale.ROOT, " %s [%s %.0f %.0f %.0f, widzów: %d] ",
					camera.name(), shortDimension(camera.dimension()), camera.x(), camera.y(), camera.z(), manager.viewers(camera)));
			line.append(link(cameraUrl(manager, source, camera.name())));
			source.sendSuccess(() -> line, false);
		}
		return cameras.size();
	}

	private static int url(CommandSourceStack source, @Nullable String name) throws CommandSyntaxException {
		CameraManager manager = manager();
		String url;
		if (name == null) {
			url = baseUrl(manager) + "/" + tokenQuery(manager, source);
		} else {
			url = cameraUrl(manager, source, camera(manager, name).name());
		}
		MutableComponent message = Component.literal("Podgląd: ").append(link(url));
		source.sendSuccess(() -> message, false);
		if (!manager.isWebRunning()) {
			source.sendFailure(Component.literal("Uwaga: serwer WWW nie działa - sprawdź port w config/cctv/config.json i logi."));
		}
		return 1;
	}

	private static int info(CommandSourceStack source, String name) throws CommandSyntaxException {
		CameraManager manager = manager();
		Camera camera = camera(manager, name);
		source.sendSuccess(() -> Component.literal(String.format(Locale.ROOT,
				"%s: %s %.2f %.2f %.2f, yaw %.1f, pitch %.1f, fov %.0f°, zasięg %d, widzów %d",
				camera.name(), camera.dimension(), camera.x(), camera.y(), camera.z(), camera.yaw(), camera.pitch(),
				camera.fov(), camera.range(), manager.viewers(camera))), false);
		return 1;
	}

	private static int create(CommandContext<CommandSourceStack> context, @Nullable Vec3 pos, @Nullable Vec2 rotation) throws CommandSyntaxException {
		CommandSourceStack source = context.getSource();
		CameraManager manager = manager();
		String name = name(context);
		if (!Camera.NAME.matcher(name).matches()) {
			throw BAD_NAME.create();
		}
		if (manager.get(name) != null) {
			throw EXISTS.create(name);
		}

		CctvConfig config = manager.config();
		Vec3 lens = pos != null ? pos : lensPosition(source);
		Vec2 look = rotation != null ? rotation : source.getRotation();
		Camera camera = new Camera(name, dimension(source), lens.x, lens.y, lens.z, look.y, clampPitch(look.x),
				config.defaultFov, config.defaultRange);
		manager.put(camera);
		CameraMarker.place(manager, camera);

		MutableComponent message = Component.literal("Kamera '" + name + "' postawiona. Podgląd: ").withStyle(ChatFormatting.GREEN)
				.append(link(cameraUrl(manager, source, name)));
		source.sendSuccess(() -> message, true);
		return 1;
	}

	private static int move(CommandContext<CommandSourceStack> context, @Nullable Vec3 pos, @Nullable Vec2 rotation) throws CommandSyntaxException {
		CommandSourceStack source = context.getSource();
		CameraManager manager = manager();
		Camera old = camera(manager, name(context));

		Vec3 lens = pos != null ? pos : lensPosition(source);
		Vec2 look = rotation != null ? rotation : source.getRotation();
		Camera camera = old.withPlacement(dimension(source), lens.x, lens.y, lens.z, look.y, clampPitch(look.x));
		manager.put(camera);
		CameraMarker.remove(manager, old);
		CameraMarker.place(manager, camera);

		source.sendSuccess(() -> Component.literal("Kamera '" + camera.name() + "' przeniesiona.").withStyle(ChatFormatting.GREEN), true);
		return 1;
	}

	private static int aim(CommandContext<CommandSourceStack> context, @Nullable Vec3 target) throws CommandSyntaxException {
		CommandSourceStack source = context.getSource();
		CameraManager manager = manager();
		Camera old = camera(manager, name(context));

		Vec3 point = target != null ? target : lensPosition(source);
		float[] rotation = Camera.lookAt(old.x(), old.y(), old.z(), point.x, point.y, point.z);
		Camera camera = old.withRotation(rotation[0], clampPitch(rotation[1]));
		manager.put(camera);
		CameraMarker.remove(manager, old);
		CameraMarker.place(manager, camera);

		source.sendSuccess(() -> Component.literal(String.format(Locale.ROOT, "Kamera '%s' skierowana (yaw %.1f, pitch %.1f).",
				camera.name(), camera.yaw(), camera.pitch())).withStyle(ChatFormatting.GREEN), true);
		return 1;
	}

	private static int fov(CommandContext<CommandSourceStack> context, double degrees) throws CommandSyntaxException {
		CameraManager manager = manager();
		Camera camera = camera(manager, name(context)).withFov(degrees);
		manager.put(camera);
		context.getSource().sendSuccess(() -> Component.literal(String.format(Locale.ROOT, "Kamera '%s': fov %.0f°.",
				camera.name(), camera.fov())).withStyle(ChatFormatting.GREEN), true);
		return 1;
	}

	private static int range(CommandContext<CommandSourceStack> context, int blocks) throws CommandSyntaxException {
		CameraManager manager = manager();
		if (blocks > manager.config().maxRange) {
			throw RANGE_TOO_BIG.create(manager.config().maxRange);
		}
		Camera camera = camera(manager, name(context)).withRange(blocks);
		manager.put(camera);
		context.getSource().sendSuccess(() -> Component.literal("Kamera '" + camera.name() + "': zasięg " + blocks + " bloków.")
				.withStyle(ChatFormatting.GREEN), true);
		return 1;
	}

	private static int remove(CommandSourceStack source, String name) throws CommandSyntaxException {
		CameraManager manager = manager();
		Camera camera = camera(manager, name);
		manager.remove(camera.name());
		CameraMarker.remove(manager, camera);
		source.sendSuccess(() -> Component.literal("Kamera '" + camera.name() + "' usunięta.").withStyle(ChatFormatting.YELLOW), true);
		return 1;
	}

	private static float clampPitch(float pitch) {
		return Math.max(-90, Math.min(90, pitch));
	}

	private static String shortDimension(String dimension) {
		return dimension.startsWith("minecraft:") ? dimension.substring("minecraft:".length()) : dimension;
	}

	static String baseUrl(CameraManager manager) {
		CctvConfig config = manager.config();
		if (!config.publicUrl.isBlank()) {
			String url = config.publicUrl.trim();
			return url.endsWith("/") ? url.substring(0, url.length() - 1) : url;
		}

		String host = manager.server().getLocalIp();
		if (host == null || host.isBlank()) {
			host = config.bindAddress.equals("0.0.0.0") || config.bindAddress.equals("::") ? "localhost" : config.bindAddress;
		}
		if (host.contains(":") && !host.startsWith("[")) {
			host = "[" + host + "]";
		}
		return "http://" + host + ":" + config.port;
	}

	/** Operators get the token in the link; other players only see the plain address. */
	private static String tokenQuery(CameraManager manager, CommandSourceStack source) {
		String token = manager.config().accessToken;
		if (token.isEmpty() || !source.permissions().hasPermission(Permissions.COMMANDS_GAMEMASTER)) {
			return "";
		}
		return "?token=" + java.net.URLEncoder.encode(token, java.nio.charset.StandardCharsets.UTF_8);
	}

	private static String cameraUrl(CameraManager manager, CommandSourceStack source, String name) {
		return baseUrl(manager) + "/cam/" + name + tokenQuery(manager, source);
	}

	private static Component link(String url) {
		MutableComponent text = Component.literal(url);
		try {
			text.setStyle(Style.EMPTY.withColor(ChatFormatting.AQUA).withUnderlined(true)
					.withClickEvent(new ClickEvent.OpenUrl(URI.create(url)))
					.withHoverEvent(new HoverEvent.ShowText(Component.literal("Otwórz w przeglądarce"))));
		} catch (IllegalArgumentException e) {
			text.withStyle(ChatFormatting.AQUA);
		}
		return text;
	}
}
