// Turns one 16x16x16 section into vertex data exactly like Minecraft's
// SectionCompiler does: block models with random variants and offsets,
// face culling, smooth lighting / ambient occlusion (BlockModelLighter,
// including partial faces), directional shading (CardinalLighting), biome
// tints with the client's 5x5 blend and fuzzy biome zoom, fluids
// (FluidRenderer) and back-to-front sorting of translucent quads.
// Runs in Web Workers; everything it needs comes in messages.

import { JavaRandom, positionSeed } from './rng.js';
import { biomeInfoNoise2d } from './noise.js';
import { collectParts, needsRandom, DOWN, UP, NORTH, SOUTH, WEST, EAST, DIR_VECTORS, MAT_OPAQUE, MAT_CUTOUT, MAT_TRANSLUCENT, MAT_COLOR } from './models.js';

/** Blocks with a model whose block entity also draws something (a beacon's beam, food on a campfire, a book); shelves too. */
const DRAWN_OVER = new Set(['minecraft:beacon', 'minecraft:campfire', 'minecraft:soul_campfire', 'minecraft:enchanting_table', 'minecraft:lectern',
	'minecraft:spawner', 'minecraft:trial_spawner', 'minecraft:vault', 'minecraft:suspicious_sand', 'minecraft:suspicious_gravel']);

export const STRIDE = 24; // f32 x3 position | u16 x2 uv (1/65536) | u8 rgb + face | u8 sky, block, material, flags
export const PAD = 18;
export const UNKNOWN = 0xffff;
/** Width of the quart-cell biome grid a mesh job gets (the section's 4 cells and 3 on each side). */
export const BIOME_GRID_W = 10;

// Vertex flags (last byte) for the shader pipeline.
export const VF_WAVING_LEAVES = 1;
export const VF_WAVING_PLANT = 2;
export const VF_EMISSIVE = 4;
export const VF_WATER = 8;
export const VF_LAVA = 16;
export const VF_PLANT_TOP = 32;

const OPPOSITE = [UP, DOWN, SOUTH, NORTH, EAST, WEST];
const STEP = [-PAD * PAD, PAD * PAD, -PAD, PAD, -1, 1];
const FULL_BRIGHT = 15 << 4 | 15 << 20;

export const CARDINAL = {
	default: [0.5, 1.0, 0.8, 0.8, 0.6, 0.6],
	nether: [0.9, 0.9, 0.8, 0.8, 0.6, 0.6],
};

// --- light coordinates like LightCoordsUtil (block << 4 | sky << 20, smooth values 0..240 per channel) ----

const pack = (block, sky) => block << 4 | sky << 20;
const lcBlock = c => c >> 4 & 15;
const lcSky = c => c >> 20 & 15;

function smoothBlend(n1, n2, n3, center) {
	if (lcSky(center) > 2 || lcBlock(center) > 2) {
		if (n1 === 0) n1 = center; else if (lcSky(n1) === 0) n1 |= center & 0xff0000;
		if (n2 === 0) n2 = center; else if (lcSky(n2) === 0) n2 |= center & 0xff0000;
		if (n3 === 0) n3 = center; else if (lcSky(n3) === 0) n3 |= center & 0xff0000;
	}
	return (n1 + n2 + n3 + center) >> 2 & 0xff00ff;
}

function smoothWeightedBlend(c1, c2, c3, c4, w1, w2, w3, w4) {
	const sky = Math.trunc((c1 >> 16 & 255) * w1 + (c2 >> 16 & 255) * w2 + (c3 >> 16 & 255) * w3 + (c4 >> 16 & 255) * w4);
	const block = Math.trunc((c1 & 255) * w1 + (c2 & 255) * w2 + (c3 & 255) * w3 + (c4 & 255) * w4);
	return block & 255 | (sky & 255) << 16;
}

// --- ambient occlusion tables (BlockModelLighter.AdjacencyInfo / AmbientVertexRemap / SizeInfo) -------------

// SizeInfo indices: DOWN, UP, NORTH, SOUTH, WEST, EAST, then FLIP_ versions (+6).
const S = { DOWN: 0, UP: 1, NORTH: 2, SOUTH: 3, WEST: 4, EAST: 5, FLIP_DOWN: 6, FLIP_UP: 7, FLIP_NORTH: 8, FLIP_SOUTH: 9, FLIP_WEST: 10, FLIP_EAST: 11 };
const w = list => list.map(name => S[name]);
const ADJACENCY = [
	{
		corners: [WEST, EAST, NORTH, SOUTH], weights: [
			w(['FLIP_WEST', 'SOUTH', 'FLIP_WEST', 'FLIP_SOUTH', 'WEST', 'FLIP_SOUTH', 'WEST', 'SOUTH']),
			w(['FLIP_WEST', 'NORTH', 'FLIP_WEST', 'FLIP_NORTH', 'WEST', 'FLIP_NORTH', 'WEST', 'NORTH']),
			w(['FLIP_EAST', 'NORTH', 'FLIP_EAST', 'FLIP_NORTH', 'EAST', 'FLIP_NORTH', 'EAST', 'NORTH']),
			w(['FLIP_EAST', 'SOUTH', 'FLIP_EAST', 'FLIP_SOUTH', 'EAST', 'FLIP_SOUTH', 'EAST', 'SOUTH'])],
	},
	{
		corners: [EAST, WEST, NORTH, SOUTH], weights: [
			w(['EAST', 'SOUTH', 'EAST', 'FLIP_SOUTH', 'FLIP_EAST', 'FLIP_SOUTH', 'FLIP_EAST', 'SOUTH']),
			w(['EAST', 'NORTH', 'EAST', 'FLIP_NORTH', 'FLIP_EAST', 'FLIP_NORTH', 'FLIP_EAST', 'NORTH']),
			w(['WEST', 'NORTH', 'WEST', 'FLIP_NORTH', 'FLIP_WEST', 'FLIP_NORTH', 'FLIP_WEST', 'NORTH']),
			w(['WEST', 'SOUTH', 'WEST', 'FLIP_SOUTH', 'FLIP_WEST', 'FLIP_SOUTH', 'FLIP_WEST', 'SOUTH'])],
	},
	{
		corners: [UP, DOWN, EAST, WEST], weights: [
			w(['UP', 'FLIP_WEST', 'UP', 'WEST', 'FLIP_UP', 'WEST', 'FLIP_UP', 'FLIP_WEST']),
			w(['UP', 'FLIP_EAST', 'UP', 'EAST', 'FLIP_UP', 'EAST', 'FLIP_UP', 'FLIP_EAST']),
			w(['DOWN', 'FLIP_EAST', 'DOWN', 'EAST', 'FLIP_DOWN', 'EAST', 'FLIP_DOWN', 'FLIP_EAST']),
			w(['DOWN', 'FLIP_WEST', 'DOWN', 'WEST', 'FLIP_DOWN', 'WEST', 'FLIP_DOWN', 'FLIP_WEST'])],
	},
	{
		corners: [WEST, EAST, DOWN, UP], weights: [
			w(['UP', 'FLIP_WEST', 'FLIP_UP', 'FLIP_WEST', 'FLIP_UP', 'WEST', 'UP', 'WEST']),
			w(['DOWN', 'FLIP_WEST', 'FLIP_DOWN', 'FLIP_WEST', 'FLIP_DOWN', 'WEST', 'DOWN', 'WEST']),
			w(['DOWN', 'FLIP_EAST', 'FLIP_DOWN', 'FLIP_EAST', 'FLIP_DOWN', 'EAST', 'DOWN', 'EAST']),
			w(['UP', 'FLIP_EAST', 'FLIP_UP', 'FLIP_EAST', 'FLIP_UP', 'EAST', 'UP', 'EAST'])],
	},
	{
		corners: [UP, DOWN, NORTH, SOUTH], weights: [
			w(['UP', 'SOUTH', 'UP', 'FLIP_SOUTH', 'FLIP_UP', 'FLIP_SOUTH', 'FLIP_UP', 'SOUTH']),
			w(['UP', 'NORTH', 'UP', 'FLIP_NORTH', 'FLIP_UP', 'FLIP_NORTH', 'FLIP_UP', 'NORTH']),
			w(['DOWN', 'NORTH', 'DOWN', 'FLIP_NORTH', 'FLIP_DOWN', 'FLIP_NORTH', 'FLIP_DOWN', 'NORTH']),
			w(['DOWN', 'SOUTH', 'DOWN', 'FLIP_SOUTH', 'FLIP_DOWN', 'FLIP_SOUTH', 'FLIP_DOWN', 'SOUTH'])],
	},
	{
		corners: [DOWN, UP, NORTH, SOUTH], weights: [
			w(['FLIP_DOWN', 'SOUTH', 'FLIP_DOWN', 'FLIP_SOUTH', 'DOWN', 'FLIP_SOUTH', 'DOWN', 'SOUTH']),
			w(['FLIP_DOWN', 'NORTH', 'FLIP_DOWN', 'FLIP_NORTH', 'DOWN', 'FLIP_NORTH', 'DOWN', 'NORTH']),
			w(['FLIP_UP', 'NORTH', 'FLIP_UP', 'FLIP_NORTH', 'UP', 'FLIP_NORTH', 'UP', 'NORTH']),
			w(['FLIP_UP', 'SOUTH', 'FLIP_UP', 'FLIP_SOUTH', 'UP', 'FLIP_SOUTH', 'UP', 'SOUTH'])],
	},
];
const REMAP = [[0, 1, 2, 3], [2, 3, 0, 1], [3, 0, 1, 2], [0, 1, 2, 3], [3, 0, 1, 2], [1, 2, 3, 0]];

// --- block tints (BlockColors / BlockTintSources) ---------------------------------------------------------

export const TINT_GRASS = 1, TINT_FOLIAGE = 2, TINT_DRY_FOLIAGE = 3, TINT_WATER = 4, TINT_CONSTANT = 5, TINT_REDSTONE = 6,
	TINT_STEM = 7, TINT_DOUBLE_GRASS = 8, TINT_NONE = 9;
const TINTS = new Map();
function tints(sources, ...blocks) {
	for (const block of blocks) TINTS.set('minecraft:' + block, sources);
}
tints([[TINT_DOUBLE_GRASS]], 'large_fern', 'tall_grass');
tints([[TINT_GRASS]], 'fern', 'short_grass', 'potted_fern', 'bush', 'grass_block', 'sugar_cane');
tints([[TINT_NONE], [TINT_GRASS]], 'pink_petals', 'wildflowers');
tints([[TINT_CONSTANT, 0x619961]], 'spruce_leaves');
tints([[TINT_CONSTANT, 0x80a755]], 'birch_leaves');
tints([[TINT_FOLIAGE]], 'oak_leaves', 'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves', 'vine', 'mangrove_leaves');
tints([[TINT_DRY_FOLIAGE]], 'leaf_litter');
tints([[TINT_WATER]], 'water_cauldron');
tints([[TINT_REDSTONE]], 'redstone_wire');
tints([[TINT_CONSTANT, 0xe0c71c]], 'attached_melon_stem', 'attached_pumpkin_stem');
tints([[TINT_STEM]], 'melon_stem', 'pumpkin_stem');
tints([[TINT_CONSTANT, 0x208030]], 'lily_pad');

/** The tint source of a block's tint index 0 ([kind, value?]), or null (terrain particles take this colour). */
export function tintSourceOf(name) {
	const sources = TINTS.get(name);
	return sources && sources[0] && sources[0][0] !== TINT_NONE ? sources[0] : null;
}

/**
 * BlockTintSource.color: the tint of a block's tint index away from the world (block displays, minecarts' blocks):
 * the default grass colour (GrassColor.getDefaultColor, given), the default foliage and dry foliage colours, a lily
 * pad's colour in hand, the redstone wire's and stems' colours of the state; -1 (none) for water and sugar cane.
 */
export function tintInHand(info, index, grassDefault) {
	const sources = info.tints;
	if (!sources || index >= sources.length) return -1;
	const source = sources[index];
	switch (source[0]) {
		case TINT_GRASS: return info.name === 'minecraft:sugar_cane' ? -1 : grassDefault;
		case TINT_DOUBLE_GRASS: return grassDefault;
		case TINT_FOLIAGE: return -12012264 & 0xffffff;
		case TINT_DRY_FOLIAGE: return -10732494 & 0xffffff;
		case TINT_CONSTANT: return info.name === 'minecraft:lily_pad' ? 7455580 : source[1];
		case TINT_REDSTONE: return redstoneColor(Number(info.props.power || 0));
		case TINT_STEM: {
			const age = Number(info.props.age || 0);
			return (age * 32 & 255) << 16 | (255 - age * 8 & 255) << 8 | (age * 4 & 255);
		}
		default: return -1;
	}
}

/** RedstoneWireBlock.getColorForPower */
function redstoneColor(power) {
	const f = power / 15;
	const r = f * 0.6 + (f > 0 ? 0.4 : 0.3);
	const g = Math.min(1, Math.max(0, f * f * 0.7 - 0.5));
	const b = Math.min(1, Math.max(0, f * f * 0.6 - 0.7));
	return (Math.trunc(r * 255) & 255) << 16 | (Math.trunc(g * 255) & 255) << 8 | (Math.trunc(b * 255) & 255);
}

// Plants that sway in the shader pack.
const WAVING_PLANT = /^(short_grass|tall_grass|fern|large_fern|bush|dandelion|poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|torchflower|sunflower|lilac|rose_bush|peony|wheat|carrots|potatoes|beetroots|sweet_berry_bush|dead_bush|short_dry_grass|tall_dry_grass|firefly_bush|pink_petals|wildflowers|.*_sapling|sugar_cane|seagrass|tall_seagrass|kelp|kelp_plant|nether_sprouts|crimson_roots|warped_roots|open_eyeblossom|closed_eyeblossom|pitcher_plant|cactus_flower)$/;
const WAVING_LEAVES = /_leaves$|^vine$|^cave_vines(_plant)?$|^weeping_vines(_plant)?$|^twisting_vines(_plant)?$|^hanging_roots$|^pale_hanging_moss$|^spore_blossom$/;

/** Server palette flags. */
const F_AIR = 1, F_OPAQUE = 2, F_WATER = 4, F_LAVA = 8, F_NO_COLLISION = 16, F_FULL_COLLISION = 32, F_LIGHT_PERMEABLE = 64,
	F_NO_MODEL = 128, F_EMISSIVE = 256, F_SOLID = 512, F_WATER_OVERLAY = 1024, F_BLOCKS_FLUID_FLOW = 2048;

const INVISIBLE = new Set(['minecraft:barrier', 'minecraft:light', 'minecraft:structure_void', 'minecraft:moving_piston']);

/** Block state description (palette entry from the server) prepared for meshing. */
export function describeState(entry, parseProps, classifyColors) {
	const flags = entry.f || 0;
	const name = entry.n || 'minecraft:air';
	const shortName = name.startsWith('minecraft:') ? name.slice(10) : name.replace(':', '_');
	const props = parseProps(entry.s);
	const opaque = (flags & F_OPAQUE) !== 0;
	const info = {
		id: entry.id,
		name,
		shortName,
		props,
		air: (flags & F_AIR) !== 0 || INVISIBLE.has(name),
		opaque,
		fullCollision: (flags & F_FULL_COLLISION) !== 0,
		noCollision: (flags & F_NO_COLLISION) !== 0,
		lightPermeable: entry.f === undefined ? true : (flags & F_LIGHT_PERMEABLE) !== 0,
		noModel: (flags & F_NO_MODEL) !== 0,
		emissive: (flags & F_EMISSIVE) !== 0,
		solid: (flags & F_SOLID) !== 0,
		waterOverlay: (flags & F_WATER_OVERLAY) !== 0,
		blocksFluidFlow: (flags & F_BLOCKS_FLUID_FLOW) !== 0,
		water: (flags & F_WATER) !== 0,
		lava: (flags & F_LAVA) !== 0,
		fluidAmount: entry.lv || 8,
		falling: props.level !== undefined && Number(props.level) >= 8,
		light: entry.l || 0,
		shade: entry.sb ?? 1.0,
		offset: entry.o || null,
		seedY: entry.sy || 0,
		occludes: opaque ? 63 : (entry.fo || 0),
		fluidCover: entry.fc || null,
		skip: entry.k || 0,
		boxes: entry.b || [],
		mapColor: entry.c || 0,
		// FallingBlock.getDustColor (falling_dust)
		dustColor: entry.dc,
		tints: TINTS.get(name) || null,
		leaves: shortName.endsWith('_leaves'),
		decoration: (flags & F_NO_COLLISION) !== 0 && !(flags & (F_WATER | F_LAVA)) && !(entry.l > 0),
		vertexFlags: (WAVING_LEAVES.test(shortName) ? VF_WAVING_LEAVES : 0) | (WAVING_PLANT.test(shortName) ? VF_WAVING_PLANT : 0)
			| ((entry.l || 0) > 0 || (flags & F_EMISSIVE) ? VF_EMISSIVE : 0),
		dispatch: undefined,
		random: false,
	};
	info.colors = classifyColors ? classifyColors(entry) : null;
	// Double plants: the upper half looks at the lower block for its biome colour.
	info.upperHalf = props.half === 'upper';
	return info;
}

class VertexWriter {
	constructor() {
		this.capacity = 0;
		this.count = 0;
		this.grow(4096);
	}

	grow(min) {
		let capacity = Math.max(this.capacity * 2, 4096);
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

	/** color: 0xRRGGBB as floats 0..1 in r, g, b; light: packed smooth coords (block 0..240 | sky 0..240 << 16). */
	vertex(x, y, z, u, v, r, g, b, face, light, material, flags) {
		if (this.count >= this.capacity) this.grow(this.count + 1);
		const i = this.count++;
		const f = i * 6, h = i * 12, o = i * STRIDE;
		this.f32[f] = x;
		this.f32[f + 1] = y;
		this.f32[f + 2] = z;
		// UVs in 1/65536 units: exact for every texel edge of a power-of-two atlas.
		this.u16[h + 6] = Math.min(65535, Math.round(u * 65536));
		this.u16[h + 7] = Math.min(65535, Math.round(v * 65536));
		this.u8[o + 16] = Math.min(255, Math.max(0, Math.round(r * 255)));
		this.u8[o + 17] = Math.min(255, Math.max(0, Math.round(g * 255)));
		this.u8[o + 18] = Math.min(255, Math.max(0, Math.round(b * 255)));
		this.u8[o + 19] = face;
		this.u8[o + 20] = light >> 16 & 255;
		this.u8[o + 21] = light & 255;
		this.u8[o + 22] = material;
		this.u8[o + 23] = flags;
	}

	/** Copy of the used part (transferable). */
	take() {
		return this.u8.slice(0, this.count * STRIDE).buffer;
	}

	/** Sorts quads back to front as seen from `eye` (VertexSorting.byDistance). */
	sortQuads(eye) {
		const quads = this.count / 4;
		if (quads < 2) return;
		const keys = new Float64Array(quads);
		const f32 = this.f32;
		for (let q = 0; q < quads; q++) {
			let cx = 0, cy = 0, cz = 0;
			for (let k = 0; k < 4; k++) {
				const f = (q * 4 + k) * 6;
				cx += f32[f]; cy += f32[f + 1]; cz += f32[f + 2];
			}
			const dx = cx / 4 - eye[0], dy = cy / 4 - eye[1], dz = cz / 4 - eye[2];
			keys[q] = dx * dx + dy * dy + dz * dz;
		}
		const order = Array.from({ length: quads }, (_, i) => i).sort((a, b) => keys[b] - keys[a]);
		const bytes = STRIDE * 4;
		const copy = this.u8.slice(0, quads * bytes);
		for (let i = 0; i < quads; i++) {
			this.u8.set(copy.subarray(order[i] * bytes, order[i] * bytes + bytes), i * bytes);
		}
	}
}

// --- biome zoom (BiomeManager.getBiome) -------------------------------------------------------------

const LCG_MUL = 6364136223846793005n;
const LCG_ADD = 1442695040888963407n;
function lcgNext(rval, c) {
	rval = BigInt.asIntN(64, rval * BigInt.asIntN(64, rval * LCG_MUL + LCG_ADD));
	return BigInt.asIntN(64, rval + c);
}
function fiddle(rval) {
	const uniform = Number(((rval >> 24n) % 1024n + 1024n) % 1024n) / 1024;
	return (uniform - 0.5) * 0.9;
}

export class Mesher {
	constructor() {
		this.infos = [];
		this.models = null;
		this.fluids = null;
		this.biomeDefs = {};
		this.biomeNames = [];
		this.colormaps = {};
		this.cardinal = CARDINAL.default;
		this.smooth = true;
		this.zoomSeed = 0n;
		this.handledBlockEntities = new Set();
		this.opaqueOut = new VertexWriter();
		this.translucentOut = new VertexWriter();
		this.random = new JavaRandom();
		this.parts = [];
		this.faceShape = new Float32Array(12);
		this.aoColors = new Float32Array(4);
		this.aoLight = new Int32Array(4);
	}

	// --- block access in the padded section ---

	info(p) {
		const id = this.pad[p];
		return id === UNKNOWN ? null : this.infos[id] || null;
	}

	/** LightCoordsUtil.getLightCoords(state, pos): the light at pos, raised by the given state's emission. */
	lightCoords(stateInfo, p) {
		if (stateInfo && stateInfo.emissive) return FULL_BRIGHT;
		const packed = this.light[p];
		let block = packed & 15;
		const sky = packed >> 4;
		const emission = stateInfo ? stateInfo.light : 0;
		if (block < emission) block = emission;
		return pack(block, sky);
	}

	shadeBrightness(p) {
		const info = this.info(p);
		return info ? info.shade : 1.0;
	}

	lightPermeable(p) {
		const info = this.info(p);
		return !info || info.air || info.lightPermeable;
	}

	// --- section meshing ---

	/**
	 * job: {sx, sy, sz, base: [x, y, z] vertex offset of the section, eye: [x, y, z] in the same space,
	 * pad: Uint16Array(18^3), light: Uint8Array(18^3) (sky << 4 | block), biomes: Uint16Array(10 x 6 x 10) cells from (sx*4-3, sy*4-1, sz*4-3)}
	 */
	/**
	 * VisGraph.resolve: which faces of the section can see each other through blocks that are not solid (full
	 * opaque cubes), as VisibilitySet: vis[a] has bit b when face a sees face b (DOWN, UP, NORTH, SOUTH, WEST, EAST).
	 * Fewer than 256 solid blocks: everything sees everything; all solid: nothing does.
	 */
	visibility() {
		const solid = this.visSolid || (this.visSolid = new Uint8Array(4096));
		const queue = this.visQueue || (this.visQueue = new Int32Array(4096));
		let count = 0;
		for (let y = 0; y < 16; y++) {
			for (let z = 0; z < 16; z++) {
				let p = ((y + 1) * PAD + (z + 1)) * PAD + 1;
				for (let x = 0; x < 16; x++, p++) {
					const id = this.pad[p];
					const info = id === UNKNOWN ? null : this.infos[id];
					const opaque = !!(info && !info.air && info.occludes === 63);
					solid[x | y << 8 | z << 4] = opaque ? 1 : 0;
					if (opaque) count++;
				}
			}
		}
		const vis = new Uint8Array(6);
		if (count < 256) return vis.fill(63);
		if (count === 4096) return vis;
		// VisGraph.INDEX_OF_EDGES: the cells on the section's surface, x then y then z
		for (let x = 0; x < 16; x++) {
			for (let y = 0; y < 16; y++) {
				for (let z = 0; z < 16; z++) {
					if (!(x === 0 || x === 15 || y === 0 || y === 15 || z === 0 || z === 15)) continue;
					const start = x | y << 8 | z << 4;
					if (solid[start]) continue;
					// floodFill: the faces this open region touches
					let faces = 0, head = 0, tail = 0;
					queue[tail++] = start;
					solid[start] = 1;
					while (head < tail) {
						const i = queue[head++];
						const cx = i & 15, cy = i >> 8 & 15, cz = i >> 4 & 15;
						if (cx === 0) faces |= 1 << WEST; else if (cx === 15) faces |= 1 << EAST;
						if (cy === 0) faces |= 1 << DOWN; else if (cy === 15) faces |= 1 << UP;
						if (cz === 0) faces |= 1 << NORTH; else if (cz === 15) faces |= 1 << SOUTH;
						if (cy > 0 && !solid[i - 256]) { solid[i - 256] = 1; queue[tail++] = i - 256; }
						if (cy < 15 && !solid[i + 256]) { solid[i + 256] = 1; queue[tail++] = i + 256; }
						if (cz > 0 && !solid[i - 16]) { solid[i - 16] = 1; queue[tail++] = i - 16; }
						if (cz < 15 && !solid[i + 16]) { solid[i + 16] = 1; queue[tail++] = i + 16; }
						if (cx > 0 && !solid[i - 1]) { solid[i - 1] = 1; queue[tail++] = i - 1; }
						if (cx < 15 && !solid[i + 1]) { solid[i + 1] = 1; queue[tail++] = i + 1; }
					}
					for (let a = 0; a < 6; a++) if (faces & (1 << a)) vis[a] |= faces;
				}
			}
		}
		return vis;
	}

	mesh(job) {
		this.pad = job.pad;
		this.light = job.light;
		this.job = job;
		this.lod = job.lod || 0;
		this.biomeGrid = job.biomes;
		this.blockBiomes = null;
		this.tintCache = new Map();
		const opaque = this.opaqueOut, translucent = this.translucentOut;
		opaque.reset();
		translucent.reset();
		const blockEntities = [];
		const errors = [];
		// blocks drawn as a plain box because they have no model (reported so missing models show up)
		this.fallbacks = new Set();
		const wx0 = job.sx * 16, wy0 = job.sy * 16, wz0 = job.sz * 16;
		const hide = job.hide || null;

		for (let y = 0; y < 16; y++) {
			for (let z = 0; z < 16; z++) {
				let p = ((y + 1) * PAD + (z + 1)) * PAD + 1;
				for (let x = 0; x < 16; x++, p++) {
					const id = this.pad[p];
					if (id === UNKNOWN) continue;
					const info = this.infos[id];
					if (!info || info.air) continue;
					const bx = x + job.base[0], by = y + job.base[1], bz = z + job.base[2];
					const wx = wx0 + x, wy = wy0 + y, wz = wz0 + z;

					// Far away (level of detail 1): grass, flowers and other small decorations are left out.
					if (this.lod && info.decoration) continue;
					// Plants in the camera's own block would cover the whole picture.
					if (hide && info.decoration && wx === hide[0] && wy === hide[1] && wz === hide[2]) continue;
					const opaqueStart = opaque.count, translucentStart = translucent.count;
					try {
						if (info.water || info.lava) {
							this.tesselateFluid(info, p, bx, by, bz, wx, wy, wz, info.water ? translucent : opaque);
						}
						// Block entities: drawn by the viewer instead of (chests, banners...) or on top of their block model
						// (a beacon's beam). Since 26.3 most of them have an empty block model rather than none.
						const handled = this.handledBlockEntities.has(info.name);
						if (handled || DRAWN_OVER.has(info.name) || info.name.endsWith('_shelf')) blockEntities.push(wx, wy, wz, id);
						if (info.noModel || (handled && !this.dispatchFor(info))) {
							if (!handled && !info.water && !info.lava && info.boxes.length) {
								this.fallback(info, p, bx, by, bz, opaque);
							}
							continue;
						}
						this.tesselateBlock(info, id, p, x, y, z, bx, by, bz, wx, wy, wz, opaque, translucent);
					} catch (error) {
						// One broken block must not take the whole section with it: drop its partial quads, draw its shape.
						opaque.count = opaqueStart;
						translucent.count = translucentStart;
						if (errors.length < 4) errors.push(info.name + (info.props && Object.keys(info.props).length ? JSON.stringify(info.props) : '') + ': ' + String(error && error.message || error));
						try {
							if (info.boxes.length) this.fallback(info, p, bx, by, bz, opaque);
						} catch {
							opaque.count = opaqueStart;
						}
					}
				}
			}
		}

		translucent.sortQuads(job.eye);
		return { opaque: opaque.take(), translucent: translucent.take(), blockEntities, errors, fallbacks: [...this.fallbacks], vis: this.visibility() };
	}

	dispatchFor(info) {
		if (info.dispatch === undefined) {
			info.dispatch = this.models ? this.models.dispatch(info.name, info.props) : null;
			if (info.dispatch && info.dispatch.kind === 'single' && info.dispatch.model.empty) info.dispatch = null;
			info.random = info.dispatch ? needsRandom(info.dispatch) : false;
		}
		return info.dispatch;
	}

	/** ModelBlockRenderer.tesselateBlock */
	tesselateBlock(info, id, p, x, y, z, bx, by, bz, wx, wy, wz, opaque, translucent) {
		const dispatch = this.dispatchFor(info);
		if (!dispatch) {
			if (info.boxes.length) this.fallback(info, p, bx, by, bz, opaque);
			return;
		}

		const parts = this.parts;
		parts.length = 0;
		if (info.random) {
			const seed = positionSeed(wx, wy + info.seedY, wz);
			this.random.setSeed(seed[0], seed[1]);
		}
		collectParts(dispatch, this.random, parts);
		if (parts.length === 0) return;

		// BlockState.getOffset (flowers, grass, bamboo, dripstone...)
		let ox = 0, oy = 0, oz = 0;
		if (info.offset) {
			const low = positionSeed(wx, 0, wz)[1];
			const max = info.offset[0];
			ox = Math.min(max, Math.max(-max, ((low & 15) / 15 - 0.5) * 0.5));
			oz = Math.min(max, Math.max(-max, ((low >>> 8 & 15) / 15 - 0.5) * 0.5));
			if (info.offset[1]) oy = ((low >>> 4 & 15) / 15 - 1) * info.offset[1];
		}

		const ao = this.smooth && info.light === 0 && parts[0].ao;
		let faceCache = 0, renderCache = 0;
		for (const part of parts) {
			for (let d = 0; d < 6; d++) {
				const quads = part.quads[d];
				if (quads.length === 0) continue;
				const mask = 1 << d;
				if (!(faceCache & mask)) {
					faceCache |= mask;
					if (this.shouldRenderFace(info, id, p, d)) renderCache |= mask;
				}
				if (!(renderCache & mask)) continue;
				const flatLight = ao ? 0 : this.lightCoords(info, p + STEP[d]);
				for (const q of quads) this.putQuad(info, p, q, bx + ox, by + oy, bz + oz, wx, wy, wz, ao, flatLight, opaque, translucent);
			}
			for (const q of part.quads[6]) this.putQuad(info, p, q, bx + ox, by + oy, bz + oz, wx, wy, wz, ao, -1, opaque, translucent);
		}
	}

	/** Block.shouldRenderFace */
	shouldRenderFace(info, id, p, d) {
		const np = p + STEP[d];
		const nid = this.pad[np];
		if (nid === UNKNOWN) return true;
		const neighbor = this.infos[nid];
		if (!neighbor || neighbor.air) return true;
		if (neighbor.occludes & (1 << OPPOSITE[d])) return false;
		// Block.skipRendering against the same block, where both agree (panes and bars that connect towards each other)
		if ((info.skip & (1 << d)) && neighbor.name === info.name && (neighbor.skip & (1 << OPPOSITE[d]))) return false;
		// Far away, leaves hide each other like the "fast" leaves setting.
		if (this.lod && info.leaves && neighbor.leaves) return false;
		return true;
	}

	putQuad(info, p, q, bx, by, bz, wx, wy, wz, ao, flatLight, opaque, translucent) {
		const colors = this.aoColors, lights = this.aoLight;
		if (ao) {
			this.ambientOcclusion(info, p, q);
		} else {
			let light = flatLight;
			if (light === -1) {
				this.quadShape(info, p, q, false);
				light = this.lightCoords(info, this.faceCubic ? p + STEP[q.dir] : p);
			}
			const shade = this.cardinal[q.shadeDir >= 0 ? q.shadeDir : q.dir];
			for (let k = 0; k < 4; k++) {
				colors[k] = shade;
				// Flat light as smooth coords (x16 per level).
				lights[k] = (lcBlock(light) * 16) | (lcSky(light) * 16) << 16;
			}
		}

		let tr = 1, tg = 1, tb = 1;
		if (q.tint >= 0) {
			const color = this.tintColor(info, q.tint, wx, wy, wz);
			if (color !== -1) {
				tr = (color >> 16 & 255) / 255;
				tg = (color >> 8 & 255) / 255;
				tb = (color & 255) / 255;
			}
		}

		const out = q.material === MAT_TRANSLUCENT ? translucent : opaque;
		// Far leaves hide each other (see shouldRenderFace), so they are solid like the "fast" leaves setting.
		const material = this.lod && info.leaves && q.material === MAT_CUTOUT ? MAT_OPAQUE : q.material;
		let flags = info.vertexFlags;
		if (q.emission > 0) flags |= VF_EMISSIVE;
		for (let k = 0; k < 4; k++) {
			let light = lights[k];
			if (q.emission > 0) {
				// LightCoordsUtil.addSmoothBlockEmission
				const block = Math.min((light & 255) + Math.trunc(Math.min(1, q.emission / 15) * 240), 240);
				light = block | (light & 0xff0000);
			}
			const c = colors[k];
			const vy = q.pos[k * 3 + 1];
			const vflags = (flags & VF_WAVING_PLANT) && vy > 0.01 ? flags | VF_PLANT_TOP : flags;
			out.vertex(bx + q.pos[k * 3], by + vy, bz + q.pos[k * 3 + 2], q.uvs[k * 2], q.uvs[k * 2 + 1],
				tr * c, tg * c, tb * c, q.dir, light, material, vflags);
		}
	}

	/** BlockModelLighter.prepareQuadShape */
	quadShape(info, p, q, ambientOcclusion) {
		let minX = 32, minY = 32, minZ = 32, maxX = -32, maxY = -32, maxZ = -32;
		const pos = q.pos;
		for (let i = 0; i < 4; i++) {
			const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
			if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
			if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
		}
		if (ambientOcclusion) {
			const s = this.faceShape;
			s[S.WEST] = minX; s[S.EAST] = maxX; s[S.DOWN] = minY; s[S.UP] = maxY; s[S.NORTH] = minZ; s[S.SOUTH] = maxZ;
			s[S.FLIP_WEST] = 1 - minX; s[S.FLIP_EAST] = 1 - maxX; s[S.FLIP_DOWN] = 1 - minY;
			s[S.FLIP_UP] = 1 - maxY; s[S.FLIP_NORTH] = 1 - minZ; s[S.FLIP_SOUTH] = 1 - maxZ;
		}
		const lo = 1e-4, hi = 0.9999;
		switch (q.dir) {
			case DOWN: case UP:
				this.facePartial = minX >= lo || minZ >= lo || maxX <= hi || maxZ <= hi; break;
			case NORTH: case SOUTH:
				this.facePartial = minX >= lo || minY >= lo || maxX <= hi || maxY <= hi; break;
			default:
				this.facePartial = minY >= lo || minZ >= lo || maxY <= hi || maxZ <= hi;
		}
		const full = info.fullCollision;
		switch (q.dir) {
			case DOWN: this.faceCubic = minY === maxY && (minY < lo || full); break;
			case UP: this.faceCubic = minY === maxY && (maxY > hi || full); break;
			case NORTH: this.faceCubic = minZ === maxZ && (minZ < lo || full); break;
			case SOUTH: this.faceCubic = minZ === maxZ && (maxZ > hi || full); break;
			case WEST: this.faceCubic = minX === maxX && (minX < lo || full); break;
			default: this.faceCubic = minX === maxX && (maxX > hi || full);
		}
	}

	/** BlockModelLighter.prepareQuadAmbientOcclusion, writes aoColors / aoLight (smooth coords). */
	ambientOcclusion(info, p, q) {
		this.quadShape(info, p, q, true);
		const d = q.dir;
		const base = this.faceCubic ? p + STEP[d] : p;
		const adj = ADJACENCY[d];
		const c0 = base + STEP[adj.corners[0]], c1 = base + STEP[adj.corners[1]];
		const c2 = base + STEP[adj.corners[2]], c3 = base + STEP[adj.corners[3]];
		const light0 = this.lightCoords(this.info(c0), c0), shade0 = this.shadeBrightness(c0);
		const light1 = this.lightCoords(this.info(c1), c1), shade1 = this.shadeBrightness(c1);
		const light2 = this.lightCoords(this.info(c2), c2), shade2 = this.shadeBrightness(c2);
		const light3 = this.lightCoords(this.info(c3), c3), shade3 = this.shadeBrightness(c3);
		const lp0 = this.lightPermeable(c0 + STEP[d]);
		const lp1 = this.lightPermeable(c1 + STEP[d]);
		const lp2 = this.lightPermeable(c2 + STEP[d]);
		const lp3 = this.lightPermeable(c3 + STEP[d]);

		const corner = (a, b, ia, ib, fallbackShade, fallbackLight, permeable) => {
			if (!permeable) return [fallbackShade, fallbackLight];
			const cp = base + STEP[adj.corners[ia]] + STEP[adj.corners[ib]];
			return [this.shadeBrightness(cp), this.lightCoords(this.info(cp), cp)];
		};
		const [shade02, light02] = corner(0, 2, 0, 2, shade0, light0, lp2 || lp0);
		const [shade03, light03] = corner(0, 3, 0, 3, shade0, light0, lp3 || lp0);
		const [shade12, light12] = corner(1, 2, 1, 2, shade0, light0, lp2 || lp1);
		const [shade13, light13] = corner(1, 3, 1, 3, shade0, light0, lp3 || lp1);

		let lightCenter = this.lightCoords(info, p);
		const next = p + STEP[d];
		const nextInfo = this.info(next);
		if (this.faceCubic || !(nextInfo && nextInfo.opaque)) lightCenter = this.lightCoords(nextInfo, next);
		const shadeCenter = this.faceCubic ? this.shadeBrightness(base) : info.shade;

		const remap = REMAP[d];
		const colors = this.aoColors, lights = this.aoLight;
		const t1 = (shade3 + shade0 + shade03 + shadeCenter) * 0.25;
		const t2 = (shade2 + shade0 + shade02 + shadeCenter) * 0.25;
		const t3 = (shade2 + shade1 + shade12 + shadeCenter) * 0.25;
		const t4 = (shade3 + shade1 + shade13 + shadeCenter) * 0.25;
		const l1 = smoothBlend(light3, light0, light03, lightCenter);
		const l2 = smoothBlend(light2, light0, light02, lightCenter);
		const l3 = smoothBlend(light2, light1, light12, lightCenter);
		const l4 = smoothBlend(light3, light1, light13, lightCenter);

		if (this.facePartial) {
			const s = this.faceShape;
			for (let v = 0; v < 4; v++) {
				const wv = adj.weights[v];
				const w1 = s[wv[0]] * s[wv[1]], w2 = s[wv[2]] * s[wv[3]], w3 = s[wv[4]] * s[wv[5]], w4 = s[wv[6]] * s[wv[7]];
				colors[remap[v]] = Math.min(1, Math.max(0, t1 * w1 + t2 * w2 + t3 * w3 + t4 * w4));
				lights[remap[v]] = smoothWeightedBlend(l1, l2, l3, l4, w1, w2, w3, w4);
			}
		} else {
			colors[remap[0]] = t1; colors[remap[1]] = t2; colors[remap[2]] = t3; colors[remap[3]] = t4;
			lights[remap[0]] = l1; lights[remap[1]] = l2; lights[remap[2]] = l3; lights[remap[3]] = l4;
		}

		const brightness = this.cardinal[q.shadeDir >= 0 ? q.shadeDir : d];
		for (let k = 0; k < 4; k++) {
			// ARGB.gray(value) quantizes to 8 bits before scaling.
			colors[k] = Math.round(colors[k] * 255) / 255 * brightness;
		}
	}

	// --- tints ---

	tintColor(info, index, wx, wy, wz) {
		const sources = info.tints;
		if (!sources || index >= sources.length) return -1;
		const source = sources[index];
		switch (source[0]) {
			case TINT_GRASS: return this.biomeColor(0, wx, wy, wz);
			case TINT_DOUBLE_GRASS: return this.biomeColor(0, wx, info.upperHalf ? wy - 1 : wy, wz);
			case TINT_FOLIAGE: return this.biomeColor(1, wx, wy, wz);
			case TINT_DRY_FOLIAGE: return this.biomeColor(2, wx, wy, wz);
			case TINT_WATER: return this.biomeColor(3, wx, wy, wz);
			case TINT_CONSTANT: return source[1];
			case TINT_REDSTONE: return redstoneColor(Number(info.props.power || 0));
			case TINT_STEM: {
				const age = Number(info.props.age || 0);
				return (age * 32 & 255) << 16 | (255 - age * 8 & 255) << 8 | (age * 4 & 255);
			}
			default: return -1;
		}
	}

	/** BlockTintCache.calculateBlockTint with the Biome Blend option's radius (integer averages; 0 = no blending). */
	biomeColor(kind, wx, wy, wz) {
		const key = ((kind * 64 + (wy - this.job.sy * 16 + 16)) * 32 + (wz - this.job.sz * 16 + 4)) * 32 + (wx - this.job.sx * 16 + 4);
		let color = this.tintCache.get(key);
		if (color !== undefined) return color;
		const radius = this.blend ?? 2;
		if (radius === 0) {
			color = this.resolveColor(kind, this.biomeAt(wx, wy, wz), wx, wz) & 0xffffff;
			this.tintCache.set(key, color);
			return color;
		}
		const count = (radius * 2 + 1) * (radius * 2 + 1);
		let r = 0, g = 0, b = 0;
		for (let dz = -radius; dz <= radius; dz++) {
			for (let dx = -radius; dx <= radius; dx++) {
				const c = this.resolveColor(kind, this.biomeAt(wx + dx, wy, wz + dz), wx + dx, wz + dz);
				r += c >> 16 & 255;
				g += c >> 8 & 255;
				b += c & 255;
			}
		}
		color = (Math.trunc(r / count) & 255) << 16 | (Math.trunc(g / count) & 255) << 8 | (Math.trunc(b / count) & 255);
		this.tintCache.set(key, color);
		return color;
	}

	/** ColorResolver: grass (with modifiers), foliage, dry foliage, water. */
	resolveColor(kind, biomeName, x, z) {
		const biome = this.biomeDefs[biomeName] || this.biomeDefs['minecraft:plains'] || { t: 0.8, d: 0.4, w: 0x3f76e4 };
		if (kind === 3) return biome.w ?? 0x3f76e4;
		if (kind === 1) return biome.f ?? this.colormap('foliage', biome.t, biome.d, 0x48b518);
		if (kind === 2) return biome.df ?? this.colormap('dry_foliage', biome.t, biome.d, 0x7b5334);
		const color = biome.g ?? this.colormap('grass', biome.t, biome.d, 0x91bd59);
		if (biome.m === 'dark_forest') return ((color & 0xfefefe) + 0x28340a) >> 1;
		if (biome.m === 'swamp') return biomeInfoNoise2d(x * 0.0225, z * 0.0225) < -0.1 ? 0x4c763c : 0x6a7039;
		return color;
	}

	/** GrassColor.get / FoliageColor.get */
	colormap(name, temperature, downfall, fallback) {
		const map = this.colormaps[name];
		if (!map) return fallback;
		const t = Math.min(1, Math.max(0, temperature));
		const d = Math.min(1, Math.max(0, downfall)) * t;
		const i = Math.trunc((1 - t) * 255);
		const j = Math.trunc((1 - d) * 255);
		const index = j << 8 | i;
		if (index >= map.width * map.height) return 0xff00ff;
		const k = index * 4;
		return map.data[k] << 16 | map.data[k + 1] << 8 | map.data[k + 2];
	}

	/** BiomeManager.getBiome: the noise biome of the nearest (randomly jittered) quart cell. */
	biomeAt(x, y, z) {
		const absX = x - 2, absY = y - 2, absZ = z - 2;
		const parentX = absX >> 2, parentY = absY >> 2, parentZ = absZ >> 2;
		const fx = (absX & 3) / 4, fy = (absY & 3) / 4, fz = (absZ & 3) / 4;
		let best = 0, bestDistance = Infinity;
		for (let i = 0; i < 8; i++) {
			const xe = (i & 4) === 0, ye = (i & 2) === 0, ze = (i & 1) === 0;
			const f = this.cellFiddle(xe ? parentX : parentX + 1, ye ? parentY : parentY + 1, ze ? parentZ : parentZ + 1);
			const dx = (xe ? fx : fx - 1) + f[0], dy = (ye ? fy : fy - 1) + f[1], dz = (ze ? fz : fz - 1) + f[2];
			const distance = dz * dz + dy * dy + dx * dx;
			if (bestDistance > distance) {
				best = i;
				bestDistance = distance;
			}
		}
		return this.noiseBiome((best & 4) === 0 ? parentX : parentX + 1, (best & 2) === 0 ? parentY : parentY + 1, (best & 1) === 0 ? parentZ : parentZ + 1);
	}

	cellFiddle(cx, cy, cz) {
		if (!this.fiddles) this.fiddles = new Map();
		const key = cx + ',' + cy + ',' + cz;
		let f = this.fiddles.get(key);
		if (f) return f;
		const seed = this.zoomSeed;
		const bx = BigInt(cx), by = BigInt(cy), bz = BigInt(cz);
		let r = lcgNext(seed, bx);
		r = lcgNext(r, by);
		r = lcgNext(r, bz);
		r = lcgNext(r, bx);
		r = lcgNext(r, by);
		r = lcgNext(r, bz);
		const fx = fiddle(r);
		r = lcgNext(r, seed);
		const fy = fiddle(r);
		r = lcgNext(r, seed);
		const fz = fiddle(r);
		f = [fx, fy, fz];
		if (this.fiddles.size > 200000) this.fiddles.clear();
		this.fiddles.set(key, f);
		return f;
	}

	noiseBiome(qx, qy, qz) {
		const job = this.job;
		const W = BIOME_GRID_W;
		const gx = qx - (job.sx * 4 - 3), gy = qy - (job.sy * 4 - 1), gz = qz - (job.sz * 4 - 3);
		const clampXZ = v => Math.min(W - 1, Math.max(0, v)), clampY = v => Math.min(5, Math.max(0, v));
		let index = this.biomeGrid[(clampY(gy) * W + clampXZ(gz)) * W + clampXZ(gx)];
		if (index === UNKNOWN) index = this.biomeGrid[(2 * W + 4) * W + 4];
		return this.biomeNames[index] || 'minecraft:plains';
	}

	// --- fluids (FluidRenderer) ---

	fluidOf(info) {
		return info ? (info.water ? 1 : info.lava ? 2 : 0) : 0;
	}

	/** getHeight: 1 if the same fluid is above, own height, 0 for non-solid, -1 for solid blocks. */
	fluidHeight(type, p) {
		const info = this.info(p);
		if (this.fluidOf(info) === type) {
			return this.fluidOf(this.info(p + STEP[UP])) === type ? 1 : Math.min(8, info.fluidAmount) / 9;
		}
		return info && info.solid ? -1 : 0;
	}

	averageHeight(type, self, h2, h1, cornerP) {
		if (h1 >= 1 || h2 >= 1) return 1;
		let sum = 0, weight = 0;
		const add = h => {
			if (h >= 0.8) { sum += h * 10; weight += 10; } else if (h >= 0) { sum += h; weight += 1; }
		};
		if (h1 > 0 || h2 > 0) {
			const corner = this.fluidHeight(type, cornerP);
			if (corner >= 1) return 1;
			add(corner);
		}
		add(self);
		add(h1);
		add(h2);
		return sum / weight;
	}

	/**
	 * isFaceOccludedByState: the face of `info` that a fluid face looking in `direction` touches hides it. A whole
	 * block face hides every fluid face but a lower surface; other shapes (Shapes.blockOccludes) hide a side face
	 * up to the height the server worked out (fc), the bottom face when they cover it and never a lower surface.
	 */
	occludedBy(direction, height, info) {
		if (!info) return false;
		const face = OPPOSITE[direction];
		if (info.occludes & (1 << face)) return direction !== UP || height === 1;
		const cover = info.fluidCover ? info.fluidCover[face] : 0;
		if (!cover) return false;
		if (direction === UP) return height >= 1 && cover >= 1;
		if (direction === DOWN) return cover >= 1;
		return height <= cover;
	}

	flow(type, p, own) {
		let fx = 0, fz = 0;
		for (const d of [NORTH, SOUTH, WEST, EAST]) {
			const np = p + STEP[d];
			const ninfo = this.info(np);
			const nt = this.fluidOf(ninfo);
			if (nt !== 0 && nt !== type) continue;
			let height = nt === type ? Math.min(8, ninfo.fluidAmount) / 9 : 0;
			let distance = 0;
			if (height === 0) {
				if (!ninfo || !ninfo.blocksFluidFlow) {
					const below = this.info(np + STEP[DOWN]);
					const bt = this.fluidOf(below);
					if (bt === type || bt === 0) {
						height = bt === type ? Math.min(8, below.fluidAmount) / 9 : 0;
						if (height > 0) distance = own - (height - 0.8888889);
					}
				}
			} else {
				distance = own - height;
			}
			if (distance !== 0) {
				fx += DIR_VECTORS[d][0] * distance;
				fz += DIR_VECTORS[d][2] * distance;
			}
		}
		return [fx, fz];
	}

	/** FlowingFluid.shouldRenderBackwardUpFace for the block above the surface. */
	backwardUpFace(type, abovePos) {
		for (let dx = -1; dx <= 1; dx++) {
			for (let dz = -1; dz <= 1; dz++) {
				const q = abovePos + dx + dz * PAD;
				const info = this.info(q);
				if (this.fluidOf(info) !== type && !(info && info.opaque)) return true;
			}
		}
		return false;
	}

	fluidLight(p) {
		const a = this.lightCoords(this.info(p), p);
		const b = this.lightCoords(this.info(p + STEP[UP]), p + STEP[UP]);
		const block = Math.max(lcBlock(a), lcBlock(b)), sky = Math.max(lcSky(a), lcSky(b));
		return block * 16 | (sky * 16) << 16;
	}

	tesselateFluid(info, p, bx, by, bz, wx, wy, wz, out) {
		const type = info.water ? 1 : 2;
		const sprites = this.fluids ? (type === 1 ? this.fluids.water : this.fluids.lava) : null;
		const infoAt = d => this.info(p + STEP[d]);
		const same = d => this.fluidOf(infoAt(d)) === type;
		// isFaceOccludedBySelf: the block the fluid is in (waterlogged stairs, slabs...) hides the face
		const selfOccluded = d => this.occludedBy(OPPOSITE[d], 1, info);
		const renderUp = !same(UP);
		const renderDown = !same(DOWN) && !selfOccluded(DOWN) && !this.occludedBy(DOWN, 0.8888889, infoAt(DOWN));
		const renderN = !same(NORTH) && !selfOccluded(NORTH);
		const renderS = !same(SOUTH) && !selfOccluded(SOUTH);
		const renderW = !same(WEST) && !selfOccluded(WEST);
		const renderE = !same(EAST) && !selfOccluded(EAST);
		if (!(renderUp || renderDown || renderN || renderS || renderW || renderE)) return;

		const tint = type === 1 ? this.biomeColor(3, wx, wy, wz) : 0xffffff;
		const tr = (tint >> 16 & 255) / 255, tg = (tint >> 8 & 255) / 255, tb = (tint & 255) / 255;
		const material = sprites ? (type === 1 ? MAT_TRANSLUCENT : MAT_OPAQUE) : MAT_COLOR;
		const baseColor = sprites ? [1, 1, 1] : (type === 1 ? [0.25, 0.46, 0.89] : [0.85, 0.39, 0.08]);
		const flags = type === 1 ? VF_WATER : VF_LAVA | VF_EMISSIVE;
		const own = this.fluidHeight(type, p);
		let hNE, hNW, hSE, hSW;
		if (own >= 1) {
			hNE = hNW = hSE = hSW = 1;
		} else {
			const hN = this.fluidHeight(type, p + STEP[NORTH]), hS = this.fluidHeight(type, p + STEP[SOUTH]);
			const hE = this.fluidHeight(type, p + STEP[EAST]), hW = this.fluidHeight(type, p + STEP[WEST]);
			hNE = this.averageHeight(type, own, hN, hE, p + STEP[NORTH] + STEP[EAST]);
			hNW = this.averageHeight(type, own, hN, hW, p + STEP[NORTH] + STEP[WEST]);
			hSE = this.averageHeight(type, own, hS, hE, p + STEP[SOUTH] + STEP[EAST]);
			hSW = this.averageHeight(type, own, hS, hW, p + STEP[SOUTH] + STEP[WEST]);
		}
		const bottom = renderDown ? 0.001 : 0;
		const cardinal = this.cardinal;
		const emit = (verts, uvs, shade, light, back, face) => {
			const r = baseColor[0] * tr * shade, g = baseColor[1] * tg * shade, b = baseColor[2] * tb * shade;
			for (let k = 0; k < 4; k++) {
				out.vertex(bx + verts[k][0], by + verts[k][1], bz + verts[k][2], uvs[k][0], uvs[k][1], r, g, b, face, light, material, flags);
			}
			if (back) {
				for (const k of [0, 3, 2, 1]) {
					out.vertex(bx + verts[k][0], by + verts[k][1], bz + verts[k][2], uvs[k][0], uvs[k][1], r, g, b, face, light, material, flags);
				}
			}
		};

		if (renderUp && !this.occludedBy(UP, Math.min(hNW, hSW, hSE, hNE), infoAt(UP))) {
			hNW -= 0.001; hSW -= 0.001; hSE -= 0.001; hNE -= 0.001;
			let uvs;
			// Only the direction matters (a falling fluid's extra downward part does not change it).
			const [flowX, flowZ] = this.flow(type, p, Math.min(8, info.fluidAmount) / 9);
			if (!sprites) {
				uvs = [[0, 0], [0, 0], [0, 0], [0, 0]];
			} else if (flowX === 0 && flowZ === 0) {
				const s = sprites.still;
				uvs = [[s.u0, s.v0], [s.u0, s.v1], [s.u1, s.v1], [s.u1, s.v0]];
			} else {
				const s = sprites.flow;
				const angle = Math.atan2(flowZ, flowX) - Math.PI / 2;
				const sn = Math.sin(angle) * 0.25, cs = Math.cos(angle) * 0.25;
				const U = f => s.u0 + (s.u1 - s.u0) * f, V = f => s.v0 + (s.v1 - s.v0) * f;
				uvs = [[U(0.5 + (-cs - sn)), V(0.5 + (-cs + sn))], [U(0.5 + (-cs + sn)), V(0.5 + (cs + sn))],
					[U(0.5 + (cs + sn)), V(0.5 + (cs - sn))], [U(0.5 + (cs - sn)), V(0.5 + (-cs - sn))]];
			}
			emit([[0, hNW, 0], [0, hSW, 1], [1, hSE, 1], [1, hNE, 0]], uvs, cardinal[UP], this.fluidLight(p),
				this.backwardUpFace(type, p + STEP[UP]), UP);
		}

		if (renderDown) {
			const s = sprites ? sprites.still : { u0: 0, v0: 0, u1: 0, v1: 0 };
			emit([[0, bottom, 0], [1, bottom, 0], [1, bottom, 1], [0, bottom, 1]],
				[[s.u0, s.v0], [s.u1, s.v0], [s.u1, s.v1], [s.u0, s.v1]], cardinal[DOWN], this.fluidLight(p + STEP[DOWN]), false, DOWN);
		}

		const sideLight = this.fluidLight(p);
		const sides = [
			[NORTH, hNW, hNE, [0, 0.001], [1, 0.001], renderN, 'z'],
			[SOUTH, hSE, hSW, [1, 1 - 0.001], [0, 1 - 0.001], renderS, 'z'],
			[WEST, hSW, hNW, [0.001, 1], [0.001, 0], renderW, 'x'],
			[EAST, hNE, hSE, [1 - 0.001, 0], [1 - 0.001, 1], renderE, 'x'],
		];
		for (const [d, h0, h1, a, b, render, axis] of sides) {
			const neighbor = infoAt(d);
			if (!render || this.occludedBy(d, Math.max(h0, h1), neighbor)) continue;
			let s = sprites ? sprites.flow : { u0: 0, v0: 0, u1: 0, v1: 0 };
			let overlay = false;
			if (sprites && sprites.overlay && neighbor && neighbor.waterOverlay) {
				s = sprites.overlay;
				overlay = true;
			}
			const U = f => s.u0 + (s.u1 - s.u0) * f, V = f => s.v0 + (s.v1 - s.v0) * f;
			const shade = cardinal[UP] * (axis === 'z' ? cardinal[NORTH] : cardinal[WEST]);
			const [x0, z0] = a;
			const [x1, z1] = b;
			emit([[x0, h0, z0], [x1, h1, z1], [x1, bottom, z1], [x0, bottom, z0]],
				[[U(0), V((1 - h0) * 0.5)], [U(0.5), V((1 - h1) * 0.5)], [U(0.5), V(0.5)], [U(0), V(0.5)]],
				shade, sideLight, !overlay, d);
		}
	}

	// --- blocks without a model: flat coloured boxes from the server's shape ---

	fallback(info, p, bx, by, bz, out) {
		if (this.models) this.fallbacks.add(info.name);
		const colors = info.colors;
		for (const b of info.boxes) {
			for (let d = 0; d < 6; d++) {
				const onFace = (d === DOWN && b[1] <= 0) || (d === UP && b[4] >= 1) || (d === NORTH && b[2] <= 0)
					|| (d === SOUTH && b[5] >= 1) || (d === WEST && b[0] <= 0) || (d === EAST && b[3] >= 1);
				if (onFace && !this.shouldRenderFace(info, info.id, p, d)) continue;
				const corners = BOX_FACES[d];
				const light = this.lightCoords(info, onFace ? p + STEP[d] : p);
				const smooth = lcBlock(light) * 16 | (lcSky(light) * 16) << 16;
				const c = colors ? colors[d] : [0.6, 0.6, 0.6];
				const shade = this.cardinal[d];
				for (const corner of corners) {
					out.vertex(bx + (corner[0] ? b[3] : b[0]), by + (corner[1] ? b[4] : b[1]), bz + (corner[2] ? b[5] : b[2]),
						0, 0, c[0] * shade, c[1] * shade, c[2] * shade, d, smooth, MAT_COLOR, info.vertexFlags);
				}
			}
		}
	}
}

// Box face corners in the vertex order of FACE_VERTICES (models.js), Minecraft direction order.
const BOX_FACES = [
	[[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]],
	[[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
	[[1, 1, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0]],
	[[0, 1, 1], [0, 0, 1], [1, 0, 1], [1, 1, 1]],
	[[0, 1, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]],
	[[1, 1, 1], [1, 0, 1], [1, 0, 0], [1, 1, 0]],
];

export { STEP, OPPOSITE };
