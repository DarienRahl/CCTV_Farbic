// Block storage for the area a camera sees, and the mesher that turns
// 16x16x16 sections into vertex data the way Minecraft's client does:
// baked block models, face culling, smooth lighting with ambient occlusion,
// biome tints and fluids. Without client assets it falls back to flat colours.

import { classify, KIND_NONE, KIND_CROSS, WATER_COLOR, LAVA_COLOR } from './blocks.js';
import { MAT_OPAQUE, MAT_TRANSLUCENT, MAT_COLOR, DIR_VECTORS } from './assets.js';
import { isBlockEntity } from './mobs.js';

export const STRIDE = 24; // f32 x3 position | u16 x2 uv | u8 x4 rgb+unused | u8 sky, block, material, unused

const PAD = 18;
function padIndex(x, y, z) {
	return (y * PAD + z) * PAD + x;
}
const DIR_OFFSET = DIR_VECTORS.map(d => padIndex(d[0], d[1], d[2]) - padIndex(0, 0, 0));
const AXIS_OFFSET = [1, PAD * PAD, PAD]; // x, y, z steps in the padded array
// Tangent axes (0 = x, 1 = y, 2 = z) of each direction's face plane.
const TANGENTS = [[0, 2], [0, 2], [0, 1], [0, 1], [2, 1], [2, 1]];
const DIR_SHADE = [1.0, 0.5, 0.8, 0.8, 0.6, 0.6];
const UP = DIR_OFFSET[0];

const GRASS_TINTED = new Set(['grass_block', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'potted_fern', 'sugar_cane', 'bush']);
const FOLIAGE_TINTED = new Set(['oak_leaves', 'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves', 'mangrove_leaves', 'vine']);
const OFFSET_XYZ = new Set(['short_grass', 'fern', 'short_dry_grass', 'tall_dry_grass', 'bush']);
const OFFSET_XZ = /^(dandelion|poppy|blue_orchid|allium|azure_bluet|red_tulip|orange_tulip|white_tulip|pink_tulip|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|torchflower|open_eyeblossom|closed_eyeblossom|tall_grass|large_fern|sunflower|lilac|rose_bush|peony|pitcher_plant|bamboo|mangrove_propagule|pointed_dripstone|small_dripleaf|firefly_bush)$/;

class VertexWriter {
	constructor() {
		this.capacity = 0;
		this.count = 0;
		this.grow(8192);
	}

	grow(min) {
		let capacity = Math.max(this.capacity * 2, 8192);
		while (capacity < min) capacity *= 2;
		const buffer = new ArrayBuffer(capacity * STRIDE);
		if (this.u8) new Uint8Array(buffer).set(this.u8.subarray(0, this.count * STRIDE));
		this.f32 = new Float32Array(buffer);
		this.u16 = new Uint16Array(buffer);
		this.u8 = new Uint8Array(buffer);
		this.capacity = capacity;
	}

	reset() {
		this.count = 0;
	}

	vertex(x, y, z, u, v, r, g, b, sky, block, material) {
		if (this.count >= this.capacity) this.grow(this.count + 1);
		const i = this.count++;
		const f = i * 6, h = i * 12, o = i * STRIDE;
		this.f32[f] = x;
		this.f32[f + 1] = y;
		this.f32[f + 2] = z;
		this.u16[h + 6] = u * 65535;
		this.u16[h + 7] = v * 65535;
		this.u8[o + 16] = Math.min(255, r * 255);
		this.u8[o + 17] = Math.min(255, g * 255);
		this.u8[o + 18] = Math.min(255, b * 255);
		this.u8[o + 19] = 255;
		this.u8[o + 20] = sky;
		this.u8[o + 21] = block;
		this.u8[o + 22] = material;
	}

	data() {
		return this.u8.subarray(0, this.count * STRIDE);
	}
}

/** Minecraft's Mth.getSeed, used for the random offset of flowers and grass. */
function positionSeed(x, y, z) {
	let l = BigInt(Math.imul(x, 3129871)) ^ (BigInt(z) * 116129781n) ^ BigInt(y);
	l = BigInt.asIntN(64, l);
	l = BigInt.asIntN(64, l * l * 42317861n + l * 11n);
	return l >> 16n;
}

function hexInt(color) {
	return [((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255];
}

export class World {
	constructor() {
		this.infos = [];
		this.assets = null;
		this.biomeDefs = {};
		this.smoothLighting = true;
		this.writers = { opaque: new VertexWriter(), translucent: new VertexWriter() };
		this.pad = new Int32Array(PAD * PAD * PAD);
		this.padSky = new Uint8Array(PAD * PAD * PAD);
		this.padBlock = new Uint8Array(PAD * PAD * PAD);
		this.reset([0, 0, 0]);
	}

	/** Clears all blocks. The palette survives: ids are global and stable while the server runs. */
	reset(origin) {
		this.origin = origin;
		this.sections = new Map();
		this.dirty = new Set();
	}

	setAssets(assets) {
		this.assets = assets;
		for (const info of this.infos) {
			if (info) {
				info.baked = undefined;
				info.blockEntity = undefined;
			}
		}
		for (const key of this.sections.keys()) this.dirty.add(key);
	}

	static key(x, y, z) {
		return x + ',' + y + ',' + z;
	}

	addPalette(entries) {
		for (const entry of entries) {
			this.infos[entry.id] = classify(entry);
		}
	}

	setSection(message) {
		const states = new Int32Array(4096);
		decodeRuns(message.r, (i, run, index) => states.fill(message.p[index], i, i + run));

		const sky = new Uint8Array(4096);
		if (message.sl) decodeRuns(message.sl, (i, run, value) => sky.fill(value, i, i + run));
		else sky.fill(15);
		const block = new Uint8Array(4096);
		if (message.bl) decodeRuns(message.bl, (i, run, value) => block.fill(value, i, i + run));

		let biomes = null;
		if (message.bi) biomes = Uint8Array.from(atob(message.bi), c => c.charCodeAt(0));

		const key = World.key(message.x, message.y, message.z);
		this.sections.set(key, {
			x: message.x, y: message.y, z: message.z,
			states, sky, block,
			biomePalette: message.bp || ['minecraft:plains'],
			biomes,
		});
		this.markDirty(message.x, message.y, message.z);
	}

	setBlock(x, y, z, id) {
		const sx = x >> 4, sy = y >> 4, sz = z >> 4;
		const section = this.sections.get(World.key(sx, sy, sz));
		if (!section) return;
		section.states[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] = id;
		// Smooth lighting and fluids look at neighbours, so rebuild the surroundings too.
		const lx = x & 15, ly = y & 15, lz = z & 15;
		for (let dx = -1; dx <= 1; dx++) {
			for (let dy = -1; dy <= 1; dy++) {
				for (let dz = -1; dz <= 1; dz++) {
					if ((dx === -1 && lx > 1) || (dx === 1 && lx < 14)) continue;
					if ((dy === -1 && ly > 1) || (dy === 1 && ly < 14)) continue;
					if ((dz === -1 && lz > 1) || (dz === 1 && lz < 14)) continue;
					const k = World.key(sx + dx, sy + dy, sz + dz);
					if (this.sections.has(k)) this.dirty.add(k);
				}
			}
		}
	}

	markDirty(sx, sy, sz) {
		for (let dx = -1; dx <= 1; dx++) {
			for (let dy = -1; dy <= 1; dy++) {
				for (let dz = -1; dz <= 1; dz++) {
					const k = World.key(sx + dx, sy + dy, sz + dz);
					if (this.sections.has(k)) this.dirty.add(k);
				}
			}
		}
	}

	/** Light at a world position: [sky, block] (used for entities). */
	lightAt(x, y, z) {
		const section = this.sections.get(World.key(x >> 4, y >> 4, z >> 4));
		if (!section) return [15, 0];
		const i = ((y & 15) << 8) | ((z & 15) << 4) | (x & 15);
		return [section.sky[i], section.block[i]];
	}

	biomeAt(x, y, z) {
		const section = this.sections.get(World.key(x >> 4, y >> 4, z >> 4));
		if (!section) return null;
		const palette = section.biomePalette;
		if (!section.biomes || palette.length === 1) return palette[0];
		const i = (((y & 15) >> 2) << 4) | (((z & 15) >> 2) << 2) | ((x & 15) >> 2);
		return palette[section.biomes[i]] || palette[0];
	}

	// --- biome colours --------------------------------------------------------

	biomeColor(kind, x, y, z) {
		const key = kind + x + ',' + (y >> 2) + ',' + z;
		const cached = this.colorCache.get(key);
		if (cached) return cached;

		// Average over 5x5 columns like the client's default biome blend.
		let r = 0, g = 0, b = 0, n = 0;
		for (let dx = -2; dx <= 2; dx++) {
			for (let dz = -2; dz <= 2; dz++) {
				const color = this.singleBiomeColor(kind, this.biomeAt(x + dx, y, z + dz), x + dx, z + dz);
				r += (color >> 16) & 255;
				g += (color >> 8) & 255;
				b += color & 255;
				n++;
			}
		}
		const result = [r / n / 255, g / n / 255, b / n / 255];
		this.colorCache.set(key, result);
		return result;
	}

	singleBiomeColor(kind, biomeId, x, z) {
		const biome = (biomeId && this.biomeDefs[biomeId]) || this.biomeDefs['minecraft:plains'] || { t: 0.8, d: 0.4, w: 0x3f76e4 };
		const assets = this.assets;
		if (kind === 'w') return biome.w ?? 0x3f76e4;
		if (kind === 'f') {
			if (biome.f !== undefined) return biome.f;
			return assets ? assets.colormap('foliage', biome.t, biome.d, 0x48b518) : 0x48b518;
		}
		if (kind === 'd') {
			return assets ? assets.colormap('dry_foliage', biome.t, biome.d, 0x7b5334) : 0x7b5334;
		}
		let color = biome.g !== undefined ? biome.g : (assets ? assets.colormap('grass', biome.t, biome.d, 0x91bd59) : 0x91bd59);
		if (biome.m === 'dark_forest') color = ((color & 0xfefefe) + 0x28340a) >> 1;
		else if (biome.m === 'swamp') color = 0x6a7039;
		return color;
	}

	tintFor(info, x, y, z) {
		const name = info.shortName;
		if (GRASS_TINTED.has(name)) return this.biomeColor('g', x, y, z);
		if (FOLIAGE_TINTED.has(name)) return this.biomeColor('f', x, y, z);
		if (name === 'birch_leaves') return hexInt(0x80a755);
		if (name === 'spruce_leaves') return hexInt(0x619961);
		if (name === 'lily_pad') return hexInt(0x208030);
		if (name === 'leaf_litter') return this.biomeColor('d', x, y, z);
		if (name === 'water_cauldron' || name === 'bubble_column' || name === 'water') return this.biomeColor('w', x, y, z);
		if (name === 'attached_melon_stem' || name === 'attached_pumpkin_stem') return hexInt(0xe0c71c);
		if (name === 'melon_stem' || name === 'pumpkin_stem') {
			const age = Number(info.props.age || 0);
			return [age * 32 / 255, (255 - age * 8) / 255, age * 4 / 255];
		}
		if (name === 'redstone_wire') {
			const f = Number(info.props.power || 0) / 15;
			return [f * 0.6 + (f > 0 ? 0.4 : 0.3), Math.max(0, Math.min(1, f * f * 0.7 - 0.5)), Math.max(0, Math.min(1, f * f * 0.6 - 0.7))];
		}
		return [1, 1, 1];
	}

	// --- meshing --------------------------------------------------------------

	/** Copies the section and a one block border from its neighbours (states and light) into the padded buffers. */
	fillPad(section) {
		const pad = this.pad, padSky = this.padSky, padBlock = this.padBlock;
		pad.fill(-1);
		padSky.fill(15);
		padBlock.fill(0);
		for (let dy = -1; dy <= 1; dy++) {
			for (let dz = -1; dz <= 1; dz++) {
				for (let dx = -1; dx <= 1; dx++) {
					const other = this.sections.get(World.key(section.x + dx, section.y + dy, section.z + dz));
					if (!other) continue;
					const x0 = dx === -1 ? 15 : 0, x1 = dx === 1 ? 0 : 15;
					const y0 = dy === -1 ? 15 : 0, y1 = dy === 1 ? 0 : 15;
					const z0 = dz === -1 ? 15 : 0, z1 = dz === 1 ? 0 : 15;
					for (let y = y0; y <= y1; y++) {
						const py = y + 1 + dy * 16;
						for (let z = z0; z <= z1; z++) {
							const pz = z + 1 + dz * 16;
							const src = (y << 8) | (z << 4);
							let dst = padIndex(x0 + 1 + dx * 16, py, pz);
							for (let x = x0; x <= x1; x++, dst++) {
								pad[dst] = other.states[src | x];
								padSky[dst] = other.sky[src | x];
								padBlock[dst] = other.block[src | x];
							}
						}
					}
				}
			}
		}
	}

	/** Render description of a block state: baked model quads or fallback quads from the server's shape. */
	model(info) {
		if (info.baked !== undefined) return info.baked;
		let baked = null;
		if (info.kind !== KIND_NONE && this.assets) {
			baked = this.assets.bake(info.name, info.props);
		}
		if (!baked && info.kind !== KIND_NONE) {
			baked = fallbackQuads(info);
		}
		info.baked = baked;
		return baked;
	}

	/**
	 * Builds vertex data for one section.
	 * @returns {{opaque: Uint8Array, translucent: Uint8Array}} views into reused buffers (upload immediately)
	 */
	mesh(section) {
		this.fillPad(section);
		this.colorCache = new Map();
		const pad = this.pad;
		const infos = this.infos;
		const opaque = this.writers.opaque;
		const translucent = this.writers.translucent;
		opaque.reset();
		translucent.reset();

		const ox = section.x * 16 - this.origin[0];
		const oy = section.y * 16 - this.origin[1];
		const oz = section.z * 16 - this.origin[2];
		const wx0 = section.x * 16, wy0 = section.y * 16, wz0 = section.z * 16;
		const blockEntities = [];

		for (let y = 0; y < 16; y++) {
			for (let z = 0; z < 16; z++) {
				for (let x = 0; x < 16; x++) {
					const p = padIndex(x + 1, y + 1, z + 1);
					const id = pad[p];
					if (id < 0) continue;
					const info = infos[id];
					if (info === undefined) continue;

					if (this.assets && info.blockEntity === undefined) info.blockEntity = isBlockEntity(info.shortName);
					if (this.assets && info.blockEntity) {
						// Chests are drawn by the entity renderer with their real model and texture.
						blockEntities.push({ x: wx0 + x, y: wy0 + y, z: wz0 + z, info });
						if (info.water) this.emitFluid(info, p, ox + x, oy + y, oz + z, wx0 + x, wy0 + y, wz0 + z, translucent);
						continue;
					}

					const model = info.kind !== KIND_NONE ? this.model(info) : null;
					if (model) {
						this.emitModel(info, id, model, p, ox + x, oy + y, oz + z, wx0 + x, wy0 + y, wz0 + z, opaque, translucent);
					}
					if (info.water || info.lava) {
						this.emitFluid(info, p, ox + x, oy + y, oz + z, wx0 + x, wy0 + y, wz0 + z, info.water ? translucent : opaque);
					}
				}
			}
		}

		section.blockEntities = blockEntities;
		return { opaque: opaque.data(), translucent: translucent.data() };
	}

	emitModel(info, id, model, p, bx, by, bz, wx, wy, wz, opaque, translucent) {
		const pad = this.pad, infos = this.infos;
		let quads = model.alternatives[0];
		if (model.alternatives.length > 1) {
			quads = model.alternatives[Number(BigInt.asUintN(32, positionSeed(wx, wy, wz))) % model.alternatives.length];
		}

		let offX = 0, offY = 0, offZ = 0;
		if (info.kind === KIND_CROSS || OFFSET_XZ.test(info.shortName) || OFFSET_XYZ.has(info.shortName)) {
			if (OFFSET_XZ.test(info.shortName) || OFFSET_XYZ.has(info.shortName)) {
				const seed = positionSeed(wx, 0, wz);
				const max = info.shortName === 'bamboo' || info.shortName === 'pointed_dripstone' ? 0.125 : 0.25;
				offX = Math.max(-max, Math.min(max, (Number(seed & 15n) / 15 - 0.5) * 0.5));
				offZ = Math.max(-max, Math.min(max, (Number((seed >> 8n) & 15n) / 15 - 0.5) * 0.5));
				if (OFFSET_XYZ.has(info.shortName)) offY = (Number((seed >> 4n) & 15n) / 15 - 1) * 0.2;
			}
		}

		const fullCube = info.fullCollision;
		let tint = null;

		for (const q of quads) {
			if (q.cull >= 0) {
				const nid = pad[p + DIR_OFFSET[q.cull]];
				if (nid >= 0) {
					const n = infos[nid];
					if (n !== undefined && (n.opaque || (info.cullSame && (nid === id || n.name === info.name)))) continue;
				}
			}

			const out = q.material === MAT_TRANSLUCENT ? translucent : opaque;
			let tr = 1, tg = 1, tb = 1;
			if (q.tint >= 0) {
				if (!tint) tint = this.tintFor(info, wx, wy, wz);
				tr = tint[0]; tg = tint[1]; tb = tint[2];
			}
			if (q.color) {
				tr *= q.color[0]; tg *= q.color[1]; tb *= q.color[2];
			}

			const smooth = this.smoothLighting && model.ao && q.aligned && info.light === 0;
			const dirShade = q.shade ? DIR_SHADE[q.dir] : 1;
			for (let k = 0; k < 4; k++) {
				const vx = q.pos[k * 3], vy = q.pos[k * 3 + 1], vz = q.pos[k * 3 + 2];
				let sky, block, ao = 1;
				if (smooth) {
					const l = this.smoothLight(p, q, vx, vy, vz, fullCube);
					sky = l[0]; block = l[1]; ao = l[2];
				} else {
					const s = q.onFace ? p + DIR_OFFSET[q.dir] : p;
					sky = this.padSky[s];
					block = Math.max(this.padBlock[s], this.emission(pad[s]), info.light);
					if (q.onFace && sky === 0 && block === 0) {
						sky = this.padSky[p];
						block = Math.max(this.padBlock[p], info.light);
					}
					sky *= 16;
					block *= 16;
				}
				const shade = dirShade * ao;
				out.vertex(bx + vx + offX, by + vy + offY, bz + vz + offZ, q.uvs[k * 2], q.uvs[k * 2 + 1],
					tr * shade, tg * shade, tb * shade, sky, block, q.material);
			}
		}
	}

	emission(id) {
		if (id < 0) return 0;
		const info = this.infos[id];
		return info ? info.light : 0;
	}

	/**
	 * Minecraft's smooth lighting (ModelBlockRenderer.AmbientOcclusionFace): for a vertex, average the light and the
	 * "shade brightness" of the block in front of the face, the two side neighbours and the corner neighbour.
	 * Returns [sky, block, ao] with light scaled by 16 (0..240) for sub-level precision.
	 */
	smoothLight(p, q, vx, vy, vz, fullCube) {
		const pad = this.pad, infos = this.infos, padSky = this.padSky, padBlock = this.padBlock;
		const front = p + DIR_OFFSET[q.dir];
		const base = q.onFace || fullCube ? front : p;
		const [a1, a2] = TANGENTS[q.dir];
		const coords = [vx, vy, vz];
		const o1 = AXIS_OFFSET[a1] * (coords[a1] < 0.5 ? -1 : 1);
		const o2 = AXIS_OFFSET[a2] * (coords[a2] < 0.5 ? -1 : 1);

		const full = i => {
			const id = pad[i];
			if (id < 0) return false;
			const n = infos[id];
			return n !== undefined && n.fullCollision;
		};
		const shadeOf = i => (full(i) ? 0.2 : 1.0);

		const s1 = base + o1, s2 = base + o2;
		const s1Full = full(s1), s2Full = full(s2);
		const corner = s1Full && s2Full ? s1 : base + o1 + o2;

		const centerIndex = q.onFace || !(infos[pad[front]] && infos[pad[front]].opaque) ? front : p;
		const centerShade = shadeOf(q.onFace ? front : p);
		const ao = (shadeOf(s1) + shadeOf(s2) + shadeOf(corner) + centerShade) * 0.25;

		const cSky = padSky[centerIndex];
		const cBlock = Math.max(padBlock[centerIndex], this.emission(pad[centerIndex]));
		let sky = cSky, block = cBlock;
		for (const i of [s1, s2, corner]) {
			let ls = padSky[i];
			let lb = Math.max(padBlock[i], this.emission(pad[i]));
			if (ls === 0 && lb === 0) {
				ls = cSky;
				lb = cBlock;
			}
			sky += ls;
			block += lb;
		}
		return [Math.round(sky * 4), Math.round(block * 4), ao];
	}

	/** Water and lava like Minecraft's LiquidBlockRenderer (corner heights, flow texture, biome water colour). */
	emitFluid(info, p, bx, by, bz, wx, wy, wz, out) {
		const pad = this.pad, infos = this.infos;
		const water = info.water;
		const same = i => {
			const id = pad[i];
			if (id < 0) return false;
			const n = infos[id];
			return n !== undefined && (water ? n.water : n.lava);
		};
		const solid = i => {
			const id = pad[i];
			if (id < 0) return false;
			const n = infos[id];
			return n !== undefined && (n.opaque || n.fullCollision);
		};
		const heightAt = i => {
			if (same(i)) return same(i + UP) ? 1 : Math.min(8, infos[pad[i]].fluidLevel) / 9;
			return solid(i) ? -1 : 0;
		};
		const add = (acc, h) => {
			if (h >= 0.8) { acc[0] += h * 10; acc[1] += 10; } else if (h >= 0) { acc[0] += h; acc[1] += 1; }
		};
		const corner = (h0, iA, iB, iDiag) => {
			const hA = heightAt(iA), hB = heightAt(iB);
			if (hA >= 1 || hB >= 1) return 1;
			const acc = [0, 0];
			if (hA > 0 || hB > 0) {
				const hD = heightAt(iDiag);
				if (hD >= 1) return 1;
				add(acc, hD);
			}
			add(acc, h0);
			add(acc, hA);
			add(acc, hB);
			return acc[1] > 0 ? acc[0] / acc[1] : h0;
		};

		const N = DIR_OFFSET[2], S = DIR_OFFSET[3], W = DIR_OFFSET[4], E = DIR_OFFSET[5];
		const above = same(p + UP);
		const h0 = above ? 1 : Math.min(8, info.fluidLevel) / 9;
		let hNW = 1, hSW = 1, hSE = 1, hNE = 1;
		if (!above) {
			hNW = corner(h0, p + N, p + W, p + N + W);
			hSW = corner(h0, p + S, p + W, p + S + W);
			hSE = corner(h0, p + S, p + E, p + S + E);
			hNE = corner(h0, p + N, p + E, p + N + E);
		}

		const tint = water ? this.biomeColor('w', wx, wy, wz) : [1, 1, 1];
		const assets = this.assets;
		const sprites = assets ? assets.fluidSprites(water) : null;
		const material = sprites ? (water ? MAT_TRANSLUCENT : MAT_OPAQUE) : MAT_COLOR;
		const base = sprites ? [1, 1, 1] : (water ? WATER_COLOR : LAVA_COLOR);
		const r = base[0] * tint[0], g = base[1] * tint[1], b = base[2] * tint[2];
		const lightOf = i => [this.padSky[i] * 16, Math.max(this.padBlock[i] * 16, water ? 0 : 240)];
		const top = 0.001;

		// Top surface
		if (!above) {
			const l = lightOf(p);
			const la = lightOf(p + UP);
			const sky = Math.max(l[0], la[0]), block = Math.max(l[1], la[1]);
			let uvs;
			const flowX = (hNW + hSW) - (hNE + hSE);
			const flowZ = (hNW + hNE) - (hSW + hSE);
			if (!sprites) {
				uvs = [0, 0, 0, 0, 0, 0, 0, 0];
			} else if (Math.abs(flowX) < 1e-3 && Math.abs(flowZ) < 1e-3) {
				const s = sprites.still;
				uvs = [s.u0, s.v0, s.u0, s.v1, s.u1, s.v1, s.u1, s.v0];
			} else {
				const s = sprites.flow;
				const angle = Math.atan2(flowZ, flowX) - Math.PI / 2;
				const ac = Math.sin(angle) * 0.25, ad = Math.cos(angle) * 0.25;
				const U = f => s.u0 + (s.u1 - s.u0) * f, V = f => s.v0 + (s.v1 - s.v0) * f;
				uvs = [U(0.5 - ad - ac), V(0.5 - ad + ac), U(0.5 - ad + ac), V(0.5 + ad + ac),
					U(0.5 + ad + ac), V(0.5 + ad - ac), U(0.5 + ad - ac), V(0.5 - ad - ac)];
			}
			const verts = [[0, hNW - top, 0], [0, hSW - top, 1], [1, hSE - top, 1], [1, hNE - top, 0]];
			for (let k = 0; k < 4; k++) {
				out.vertex(bx + verts[k][0], by + verts[k][1], bz + verts[k][2], uvs[k * 2], uvs[k * 2 + 1], r, g, b, sky, block, material);
			}
			if (water) {
				// Seen from below (underwater) too.
				for (const k of [3, 2, 1, 0]) {
					out.vertex(bx + verts[k][0], by + verts[k][1], bz + verts[k][2], uvs[k * 2], uvs[k * 2 + 1], r, g, b, sky, block, material);
				}
			}
		}

		// Bottom
		if (!same(p + DIR_OFFSET[1]) && !solid(p + DIR_OFFSET[1])) {
			const l = lightOf(p + DIR_OFFSET[1]);
			const s = sprites ? sprites.still : { u0: 0, v0: 0, u1: 0, v1: 0 };
			const verts = [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]];
			const uvs = [s.u0, s.v1, s.u0, s.v0, s.u1, s.v0, s.u1, s.v1];
			for (let k = 0; k < 4; k++) {
				out.vertex(bx + verts[k][0], by + verts[k][1], bz + verts[k][2], uvs[k * 2], uvs[k * 2 + 1], r * 0.5, g * 0.5, b * 0.5, l[0], l[1], material);
			}
		}

		// Sides: [neighbour offset, shade, corner a (x,z,height), corner b]
		const sides = [
			[N, 0.8, [1, 0, hNE], [0, 0, hNW]],
			[S, 0.8, [0, 1, hSW], [1, 1, hSE]],
			[W, 0.6, [0, 0, hNW], [0, 1, hSW]],
			[E, 0.6, [1, 1, hSE], [1, 0, hNE]],
		];
		for (const [offset, shade, a, c] of sides) {
			const n = p + offset;
			if (same(n) || solid(n)) continue;
			const l = lightOf(n);
			const s = sprites ? sprites.flow : { u0: 0, v0: 0, u1: 0, v1: 0 };
			const U = f => s.u0 + (s.u1 - s.u0) * f, V = f => s.v0 + (s.v1 - s.v0) * f;
			const ha = a[2] - top, hc = c[2] - top;
			const verts = [[a[0], ha, a[1]], [a[0], 0, a[1]], [c[0], 0, c[1]], [c[0], hc, c[1]]];
			const uvs = [U(0), V((1 - ha) * 0.5), U(0), V(0.5), U(0.5), V(0.5), U(0.5), V((1 - hc) * 0.5)];
			for (let k = 0; k < 4; k++) {
				out.vertex(bx + verts[k][0], by + verts[k][1], bz + verts[k][2], uvs[k * 2], uvs[k * 2 + 1], r * shade, g * shade, b * shade, l[0], l[1], material);
			}
			if (water) {
				for (const k of [3, 2, 1, 0]) {
					out.vertex(bx + verts[k][0], by + verts[k][1], bz + verts[k][2], uvs[k * 2], uvs[k * 2 + 1], r * shade, g * shade, b * shade, l[0], l[1], material);
				}
			}
		}
	}
}

function decodeRuns(b64, fill) {
	const binary = atob(b64);
	let pos = 0, i = 0;
	const read = () => {
		let value = 0, shift = 0, b;
		do {
			b = binary.charCodeAt(pos++);
			value |= (b & 0x7f) << shift;
			shift += 7;
		} while (b & 0x80);
		return value;
	};
	while (pos < binary.length && i < 4096) {
		const run = read();
		const value = read();
		fill(i, Math.min(run, 4096 - i), value);
		i += run;
	}
}

// Face corners (counter-clockwise from outside) for boxes in the fallback renderer.
const BOX_FACES = [
	[[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
	[[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]],
	[[1, 1, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0]],
	[[0, 1, 1], [0, 0, 1], [1, 0, 1], [1, 1, 1]],
	[[0, 1, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]],
	[[1, 1, 1], [1, 0, 1], [1, 0, 0], [1, 1, 0]],
];

/** Flat-coloured quads from the server's block shape (used without client assets or for entity-rendered blocks). */
function fallbackQuads(info) {
	const quads = [];
	const zeroUv = new Float32Array(8);
	if (info.kind === KIND_CROSS) {
		let height = 0;
		for (const b of info.boxes) height = Math.max(height, b[4]);
		height = Math.max(0.3, Math.min(1, height));
		const lo = 0.15, hi = 0.85;
		for (const [a, b] of [[[lo, lo], [hi, hi]], [[hi, hi], [lo, lo]], [[lo, hi], [hi, lo]], [[hi, lo], [lo, hi]]]) {
			quads.push({
				pos: new Float32Array([a[0], height, a[1], a[0], 0, a[1], b[0], 0, b[1], b[0], height, b[1]]),
				uvs: zeroUv, dir: 0, aligned: false, onFace: false, cull: -1, tint: -1, shade: false,
				material: MAT_COLOR, color: info.colors[2],
			});
		}
		return { alternatives: [quads], ao: false };
	}

	for (const b of info.boxes) {
		for (let f = 0; f < 6; f++) {
			const onFace = (f === 0 && b[4] >= 1) || (f === 1 && b[1] <= 0) || (f === 2 && b[2] <= 0)
				|| (f === 3 && b[5] >= 1) || (f === 4 && b[0] <= 0) || (f === 5 && b[3] >= 1);
			const pos = new Float32Array(12);
			BOX_FACES[f].forEach((c, k) => {
				pos[k * 3] = c[0] ? b[3] : b[0];
				pos[k * 3 + 1] = c[1] ? b[4] : b[1];
				pos[k * 3 + 2] = c[2] ? b[5] : b[2];
			});
			quads.push({
				pos, uvs: zeroUv, dir: f, aligned: true, onFace, cull: onFace ? f : -1, tint: -1, shade: true,
				material: MAT_COLOR, color: info.colors[f],
			});
		}
	}
	return { alternatives: [quads], ao: true };
}

export { KIND_NONE };
