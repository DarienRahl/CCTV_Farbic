package io.github.darienrahl.cctv.mixin;

import java.util.Optional;
import java.util.concurrent.CompletableFuture;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.level.ChunkMap;
import net.minecraft.world.level.ChunkPos;

/**
 * Reads a saved chunk from its region file (through the server's own IO worker,
 * already upgraded to the current data version) without loading it into the
 * world. Used to show terrain beyond the loaded area.
 */
@Mixin(ChunkMap.class)
public interface ChunkMapAccessor {
	@Invoker("readChunk")
	CompletableFuture<Optional<CompoundTag>> cctv$readChunk(ChunkPos pos);
}
