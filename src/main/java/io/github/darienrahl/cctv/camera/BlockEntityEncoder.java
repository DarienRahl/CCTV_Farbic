package io.github.darienrahl.cctv.camera;

import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.function.IntConsumer;

import org.jspecify.annotations.Nullable;

import com.mojang.authlib.GameProfile;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.Holder;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.util.Util;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.ItemStackTemplate;
import net.minecraft.world.item.JukeboxSong;
import net.minecraft.world.item.JukeboxSongPlayer;
import net.minecraft.world.item.component.ResolvableProfile;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BannerBlockEntity;
import net.minecraft.world.level.block.entity.BannerPatternLayers;
import net.minecraft.world.level.block.entity.BeaconBeamOwner;
import net.minecraft.world.level.block.entity.BeaconBlockEntity;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.entity.BrushableBlockEntity;
import net.minecraft.world.level.block.entity.CampfireBlockEntity;
import net.minecraft.world.level.block.entity.DecoratedPotBlockEntity;
import net.minecraft.world.level.block.entity.DecoratedPotPattern;
import net.minecraft.world.level.block.entity.JukeboxBlockEntity;
import net.minecraft.world.level.block.entity.PotDecorations;
import net.minecraft.world.level.block.entity.SignBlockEntity;
import net.minecraft.world.level.block.entity.SignText;
import net.minecraft.world.level.block.entity.SignTextSlot;
import net.minecraft.world.level.block.entity.SkullBlockEntity;
import net.minecraft.world.level.block.entity.SpawnerBlockEntity;
import net.minecraft.world.level.block.entity.TrialSpawnerBlockEntity;
import net.minecraft.world.level.block.piston.PistonBaseBlock;
import net.minecraft.world.level.block.piston.PistonHeadBlock;
import net.minecraft.world.level.block.piston.PistonMovingBlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.PistonType;
import net.minecraft.world.level.chunk.LevelChunk;

import io.github.darienrahl.cctv.web.Json;

/**
 * Block entity details the viewer draws on top of the block models, per section. Only what cannot be
 * seen in the block state: the text of signs and hanging signs, banner patterns, pottery sherds on
 * decorated pots, the owners of player heads, beacon beams, food on campfires, the mobs in spawners and
 * the items in suspicious sand and gravel being brushed.
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
					case BeaconBlockEntity beacon -> beacon(beacon);
					case CampfireBlockEntity campfire -> campfire(campfire);
					case BrushableBlockEntity brushable -> brushable(brushable);
					case JukeboxBlockEntity jukebox -> jukebox(jukebox);
					case SpawnerBlockEntity spawner -> spawner(spawner,
							spawner.getSpawner().getOrCreateDisplayEntity(spawner.getLevel(), spawner.getBlockPos()));
					case TrialSpawnerBlockEntity trial -> spawner(trial, trial.getTrialSpawner().getStateData()
							.getOrCreateDisplayEntity(trial.getTrialSpawner(), trial.getLevel(), trial.getTrialSpawner().getState()));
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

	/**
	 * The beam of a beacon (BeaconBeamOwner#getBeamSections, empty while the beacon is off):
	 * {@code {"k":"beacon", "s": [[rgb, height], ...]}}. The session re-reads beacon sections now and then.
	 */
	/**
	 * A block moved by a piston (PistonMovingBlockEntity at its destination) as PistonHeadRenderer draws it:
	 * ["pm", x, y, z, stepX, stepY, stepZ, extending, progress, block, short block, base, short while above,
	 * the block it becomes],
	 * where the block is drawn offset by the direction times (progress - 1) when extending, (1 - progress)
	 * when retracting, a piston head switches to its short form ("short block", -1 if none) while the progress
	 * is at most (short while above: false) or at least 0.5, and a retracting piston draws its base in place.
	 * Players are not sent the moving piston block, only the block it becomes when the move ends.
	 */
	static String movingPiston(BlockPos pos, PistonMovingBlockEntity piston, IntConsumer states) {
		Direction direction = piston.getDirection();
		BlockState moved = piston.getMovedState();
		int block = Block.getId(moved);
		int shortBlock = -1;
		int base = -1;
		boolean shortAbove = false;
		if (moved.is(Blocks.PISTON_HEAD)) {
			block = Block.getId(moved.setValue(PistonHeadBlock.SHORT, false));
			shortBlock = Block.getId(moved.setValue(PistonHeadBlock.SHORT, true));
		} else if (piston.isSourcePiston() && !piston.isExtending() && moved.hasProperty(PistonBaseBlock.FACING)) {
			BlockState head = Blocks.PISTON_HEAD.defaultBlockState()
					.setValue(PistonHeadBlock.TYPE, moved.is(Blocks.STICKY_PISTON) ? PistonType.STICKY : PistonType.DEFAULT)
					.setValue(PistonHeadBlock.FACING, moved.getValue(PistonBaseBlock.FACING));
			block = Block.getId(head.setValue(PistonHeadBlock.SHORT, false));
			shortBlock = Block.getId(head.setValue(PistonHeadBlock.SHORT, true));
			shortAbove = true;
			base = Block.getId(moved.setValue(PistonBaseBlock.EXTENDED, true));
		}
		states.accept(block);
		if (shortBlock >= 0) {
			states.accept(shortBlock);
		}
		if (base >= 0) {
			states.accept(base);
		}
		Json json = new Json(96);
		json.beginArray().value("pm").value(pos.getX()).value(pos.getY()).value(pos.getZ())
				.value(direction.getStepX()).value(direction.getStepY()).value(direction.getStepZ())
				.value(piston.isExtending()).value(piston.getProgress(1.0F), 2)
				.value(block).value(shortBlock).value(base).value(shortAbove).value(Block.getId(moved)).endArray();
		return json.toString();
	}

	private static String beacon(BeaconBlockEntity beacon) {
		Json json = begin("beacon", beacon).name("s").beginArray();
		for (BeaconBeamOwner.Section section : beacon.getBeamSections()) {
			json.beginArray().value(section.getColor() & 0xFFFFFF).value(section.getHeight()).endArray();
		}
		return json.endArray().endObject().toString();
	}

	/**
	 * The mob turning inside a spawner or trial spawner (SpawnerRenderer: the spawner's display entity, none
	 * while a trial spawner rests): {@code {"k":"spawner", "e": entity type, "w", "h": its size}}.
	 */
	private static @Nullable String spawner(BlockEntity spawner, @Nullable Entity display) {
		if (display == null) {
			return null;
		}
		return begin("spawner", spawner).field("e", BuiltInRegistries.ENTITY_TYPE.getKey(display.getType()).toString())
				.field("w", display.getBbWidth(), 3).field("h", display.getBbHeight(), 3).endObject().toString();
	}

	/** Suspicious sand and gravel while being brushed: the item inside and the side it comes out of. */
	private static @Nullable String brushable(BrushableBlockEntity brushable) {
		Direction side = brushable.getHitDirection();
		ItemStack item = brushable.getItem();
		if (side == null || item.isEmpty()) {
			return null;
		}
		return begin("brush", brushable)
				.field("i", BuiltInRegistries.ITEM.getKey(item.getItem()).toString())
				.field("d", side.getSerializedName())
				.endObject().toString();
	}

	/** Food cooking on a campfire, one item id (or null) per slot: {@code {"k":"campfire", "i": [...]}}; empty ones are left out. */
	private static @Nullable String campfire(CampfireBlockEntity campfire) {
		List<ItemStack> items = campfire.getItems();
		if (items.stream().allMatch(ItemStack::isEmpty)) {
			return null;
		}
		Json json = begin("campfire", campfire).name("i").beginArray();
		for (ItemStack item : items) {
			json.value(item.isEmpty() ? null : BuiltInRegistries.ITEM.getKey(item.getItem()).toString());
		}
		return json.endArray().endObject().toString();
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

	/**
	 * The song a jukebox plays (JukeboxSongPlayer), so a viewer who comes in or turns sounds on later hears it
	 * from where it is: {@code {"k":"jukebox", "s": sound event, "t": ticks since it started, "l": seconds}}.
	 */
	private static @Nullable String jukebox(JukeboxBlockEntity jukebox) {
		JukeboxSongPlayer player = jukebox.getSongPlayer();
		JukeboxSong song = player.getSong();
		if (song == null) {
			return null;
		}
		return begin("jukebox", jukebox).field("s", SoundEncoder.id(song.soundEvent().value()))
				.field("t", player.getTicksSinceSongStarted()).field("l", song.lengthInSeconds(), 2).endObject().toString();
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
