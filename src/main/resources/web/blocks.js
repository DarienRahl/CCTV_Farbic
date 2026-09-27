// Turns the server's block descriptions (name, map colour, shape boxes, flags)
// into render information. The dedicated server has no textures, so colours
// come from Minecraft map colours, refined here for the most common blocks.

const FLAG_AIR = 1;
const FLAG_OPAQUE = 2;
const FLAG_WATER = 4;
const FLAG_LAVA = 8;
const FLAG_NO_COLLISION = 16;

export const MATERIAL_SOLID = 0;
export const MATERIAL_LEAVES = 1;
export const MATERIAL_GLASS = 2;
export const MATERIAL_WATER = 3;
export const MATERIAL_EMISSIVE = 4;
export const MATERIAL_PLANT = 5;

export const KIND_NONE = 0;
export const KIND_CUBE = 1;
export const KIND_BOXES = 2;
export const KIND_CROSS = 3;

// Face order used everywhere: up, down, north(-z), south(+z), west(-x), east(+x)
const INVISIBLE = new Set(['barrier', 'light', 'structure_void', 'moving_piston']);

// Average colours of the vanilla textures (default resource pack, plains biome tints).
// A string is used for every face, an array is [top, side, bottom].
const COLORS = {
	grass_block: ['#79b04f', '#8a6c46', '#866043'],
	dirt: '#866043', coarse_dirt: '#77553b', rooted_dirt: '#90684c', dirt_path: ['#94804a', '#866043', '#866043'],
	podzol: ['#5b3f1c', '#7a5739', '#866043'], mycelium: ['#6f6265', '#7c6663', '#866043'],
	farmland: ['#52341b', '#866043', '#866043'], mud: '#3c393d', clay: '#a0a6b3',
	stone: '#7d7d7d', cobblestone: '#7f7f7f', mossy_cobblestone: '#6e7a5b', smooth_stone: '#9e9e9e',
	andesite: '#888889', diorite: '#bcbcbc', granite: '#956755', calcite: '#dfe0dc', tuff: '#6c6d66',
	deepslate: '#505053', cobbled_deepslate: '#4d4d51', bedrock: '#555555', gravel: '#837f7e',
	sand: '#dbcfa3', red_sand: '#be6621', sandstone: '#d8cb9b', red_sandstone: '#ba6522',
	snow_block: '#f9fefe', snow: '#f9fefe', powder_snow: '#f8fdfd', ice: '#91b7fd', packed_ice: '#8db4fa', blue_ice: '#74a8fd',
	water: '#3f76e4', lava: '#d96415', obsidian: '#140f1e', crying_obsidian: '#20102e',
	short_grass: '#6a9f45', tall_grass: '#6a9f45', fern: '#5f8f3f', large_fern: '#5f8f3f', bush: '#5f8f3f',
	vine: '#4b7f2a', lily_pad: '#208030', seagrass: '#3c8a2f', tall_seagrass: '#3c8a2f', kelp: '#4c8a2f', kelp_plant: '#4c8a2f',
	sugar_cane: '#8ebd5c', cactus: '#587d2d', bamboo: '#5a8b1b', dead_bush: '#6b4f2a', moss_block: '#596e2d', moss_carpet: '#596e2d',
	oak_leaves: '#4f8a2a', jungle_leaves: '#4a8f21', acacia_leaves: '#58861f', dark_oak_leaves: '#3f7a1f',
	mangrove_leaves: '#4f8a2a', spruce_leaves: '#3f6340', birch_leaves: '#5e7d3a', cherry_leaves: '#e9b3cb',
	azalea_leaves: '#5b7a2e', flowering_azalea_leaves: '#6f7d3a', pale_oak_leaves: '#8a9282',
	oak_log: ['#b29157', '#6d5533', '#b29157'], spruce_log: ['#8b6c46', '#3a2511', '#8b6c46'],
	birch_log: ['#c5b57d', '#d8d7d2', '#c5b57d'], jungle_log: ['#a37d4f', '#554419', '#a37d4f'],
	acacia_log: ['#a55e37', '#676157', '#a55e37'], dark_oak_log: ['#4d3a22', '#3c2e1a', '#4d3a22'],
	mangrove_log: ['#6e3a33', '#54433a', '#6e3a33'], cherry_log: ['#c68d8d', '#36212a', '#c68d8d'],
	pale_oak_log: ['#dac9c3', '#57504c', '#dac9c3'], crimson_stem: ['#6a3a4a', '#5c1919', '#6a3a4a'],
	warped_stem: ['#3a6a67', '#3a3b4e', '#3a6a67'],
	oak_planks: '#a2834f', spruce_planks: '#735531', birch_planks: '#c0af79', jungle_planks: '#a0734d',
	acacia_planks: '#a85a32', dark_oak_planks: '#432b14', mangrove_planks: '#773636', cherry_planks: '#e2b3ac',
	pale_oak_planks: '#e4d9d6', bamboo_planks: '#c2ad51', crimson_planks: '#653147', warped_planks: '#2b6963',
	poppy: '#c0302a', dandelion: '#f2d02b', blue_orchid: '#2fa9de', allium: '#b878e4', azure_bluet: '#e1e9ee',
	red_tulip: '#c5372a', orange_tulip: '#e07a28', white_tulip: '#e7ecee', pink_tulip: '#e6a9c5',
	oxeye_daisy: '#e8e6d4', cornflower: '#4968c8', lily_of_the_valley: '#f2f2f2', sunflower: '#f5c518',
	lilac: '#c39ac7', rose_bush: '#be2a2a', peony: '#e4b6d6', wither_rose: '#2a2a1a', torchflower: '#e38b3a',
	wheat: '#b8a248', carrots: '#4f9a2a', potatoes: '#4f9a2a', beetroots: '#4f8a2a', sweet_berry_bush: '#3f6f2f',
	pumpkin: ['#c07615', '#e3901d', '#c07615'], melon: ['#a8b523', '#6f9a1a', '#a8b523'], hay_block: ['#a68b0c', '#b5970e', '#a68b0c'],
	glass: '#c0d6df', glass_pane: '#c0d6df', tinted_glass: '#2c2630',
	torch: '#f6c046', wall_torch: '#f6c046', soul_torch: '#7ae3f0', soul_wall_torch: '#7ae3f0', lantern: '#e3a33c',
	soul_lantern: '#6fd2dd', glowstone: '#f3d18b', sea_lantern: '#d8e6df', shroomlight: '#f19a45', jack_o_lantern: ['#c07615', '#e8a02d', '#c07615'],
	redstone_lamp: '#8f5a2f', end_rod: '#e8e0d0', campfire: '#e3801d', fire: '#f28b17', soul_fire: '#39c9d8', magma_block: '#8e3f16',
	bricks: '#966153', stone_bricks: '#7a7a7a', mossy_stone_bricks: '#6f7b5c', cracked_stone_bricks: '#767676',
	iron_block: '#dcdcdc', gold_block: '#f7d138', diamond_block: '#62ede4', emerald_block: '#2adb5c',
	lapis_block: '#1f4499', redstone_block: '#af1b05', coal_block: '#101010', netherite_block: '#423d3f',
	copper_block: '#c06b4f', netherrack: '#6f3535', soul_sand: '#51402f', soul_soil: '#4b3a2d', basalt: '#525256',
	blackstone: '#2a2328', end_stone: '#dbde9e', purpur_block: '#a87ca8', prismarine: '#63a194', quartz_block: '#ebe5de',
	chest: '#a2742b', trapped_chest: '#a2742b', ender_chest: '#1f3136', barrel: ['#8a6a3d', '#6b4f2c', '#8a6a3d'],
	crafting_table: ['#a0784a', '#7e5b35', '#a2834f'], furnace: '#6e6e6e', blast_furnace: '#5f5e5e', smoker: '#6a5a48',
	bookshelf: ['#a2834f', '#75603e', '#a2834f'], tnt: ['#b5423a', '#db4b2e', '#b5423a'], note_block: '#654532', jukebox: '#6a4636',
	rail: '#7d6b55', powered_rail: '#a08a4a', detector_rail: '#7d6b55', activator_rail: '#7d6b55', redstone_wire: '#a21a0b',
	ladder: '#8a6a3d', scaffolding: '#c8a86a', cobweb: '#dde1e2', spawner: '#253443', hopper: '#474747', cauldron: '#494949',
	anvil: '#444444', bell: '#f7d138', beacon: '#79dcd6', enchanting_table: '#3a2f5f', brewing_stand: '#7a6a4a',
};

const LEAVES = /_leaves$/;
const GLASS = /(^|_)glass(_pane)?$|^ice$|^frosted_ice$/;
const PLANT_WORDS = /(grass|fern|flower|sapling|bush|tulip|orchid|allium|bluet|daisy|poppy|dandelion|cornflower|lily_of|rose|lilac|peony|sunflower|torchflower|pitcher|wheat|carrots|potatoes|beetroots|stem$|mushroom|fungus|roots|sprouts|kelp|seagrass|sugar_cane|bamboo_sapling|cobweb|dripleaf|berry|vines(_plant)?$|wart|crop|petals|spore|hanging_moss|eyeblossom|cactus_flower|leaf_litter|wildflowers|firefly)/;

function hexToRgb(hex) {
	const v = parseInt(hex.slice(1), 16);
	return [(v >> 16) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

function intToRgb(v) {
	return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

function mul(c, f) {
	return [c[0] * f, c[1] * f, c[2] * f];
}

function parseProps(s) {
	const props = {};
	if (!s) return props;
	for (const part of s.split(',')) {
		const eq = part.indexOf('=');
		if (eq > 0) props[part.slice(0, eq)] = part.slice(eq + 1);
	}
	return props;
}

function colorFor(name, mapColor, props) {
	let entry = COLORS[name];

	if (!entry) {
		// Wood variants: stairs, slabs, fences, doors... use their planks colour.
		const wood = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped)_/.exec(name);
		if (wood && !/_(log|wood|stem|hyphae|leaves|sapling)$/.test(name)) {
			entry = COLORS[wood[1] + '_planks'];
		} else if (/_(wood|hyphae)$/.test(name)) {
			const log = COLORS[name.replace(/_(wood|hyphae)$/, name.endsWith('hyphae') ? '_stem' : '_log').replace(/^stripped_/, '')];
			if (log) entry = Array.isArray(log) ? log[1] : log;
		} else if (name.startsWith('stripped_')) {
			const log = COLORS[name.slice('stripped_'.length)];
			if (log) entry = Array.isArray(log) ? log[0] : log;
		} else if (/^(cobblestone|stone|stone_brick|brick|sandstone|andesite|diorite|granite|deepslate|blackstone|quartz|purpur|prismarine|mud_brick|tuff)_(stairs|slab|wall)$/.test(name)) {
			entry = COLORS[name.replace(/_(stairs|slab|wall)$/, '')] ?? COLORS[name.replace(/_(stairs|slab|wall)$/, 's')];
		}
	}

	let top, side, bottom;
	if (Array.isArray(entry)) {
		[top, side, bottom] = entry.map(hexToRgb);
	} else if (entry) {
		top = side = bottom = hexToRgb(entry);
	} else {
		const base = mapColor ? intToRgb(mapColor) : [0.6, 0.6, 0.6];
		top = side = bottom = base;
	}

	if (name === 'wheat' && props.age !== undefined && Number(props.age) < 7) {
		top = side = bottom = hexToRgb('#5e9d3a');
	}
	if (name === 'farmland' && props.moisture === '7') {
		top = mul(top, 0.7);
	}

	// Logs lying sideways show their rings on the sides.
	const axis = props.axis;
	const faces = [top, bottom, side, side, side, side];
	if (axis === 'x') {
		return [side, side, side, side, top, top];
	}
	if (axis === 'z') {
		return [side, side, top, top, side, side];
	}
	return faces;
}

/** @returns render info for a palette entry from the server. */
export function classify(entry) {
	const fullName = entry.n || 'minecraft:air';
	const name = fullName.startsWith('minecraft:') ? fullName.slice(10) : fullName.replace(':', '_');
	const flags = entry.f || 0;
	const props = parseProps(entry.s);
	const boxes = entry.b || [];

	const info = {
		id: entry.id,
		name: fullName,
		shortName: name,
		props,
		opaque: (flags & FLAG_OPAQUE) !== 0,
		water: (flags & FLAG_WATER) !== 0,
		lava: (flags & FLAG_LAVA) !== 0,
		fluidLevel: entry.lv || 8,
		light: entry.l || 0,
		boxes,
		kind: KIND_NONE,
		material: MATERIAL_SOLID,
		colors: null,
		cullSame: false,
		translucent: false,
	};

	if ((flags & FLAG_AIR) || INVISIBLE.has(name)) {
		return info;
	}

	info.colors = colorFor(name, entry.c, props);

	const full = boxes.length === 1 && boxes[0][0] <= 0 && boxes[0][1] <= 0 && boxes[0][2] <= 0
		&& boxes[0][3] >= 1 && boxes[0][4] >= 1 && boxes[0][5] >= 1;

	if (boxes.length === 0) {
		// Pure fluids (water, lava, bubble columns) have no outline shape.
		info.kind = KIND_NONE;
	} else if (full) {
		info.kind = KIND_CUBE;
	} else if ((flags & FLAG_NO_COLLISION) && PLANT_WORDS.test(name) && !/_(carpet|button|plate)$/.test(name)) {
		info.kind = KIND_CROSS;
		info.material = MATERIAL_PLANT;
	} else {
		info.kind = KIND_BOXES;
	}

	if (LEAVES.test(name)) {
		info.material = MATERIAL_LEAVES;
		info.cullSame = true;
	} else if (GLASS.test(name) || name.endsWith('_stained_glass') || name.endsWith('_stained_glass_pane')) {
		info.material = MATERIAL_GLASS;
		info.translucent = true;
		info.cullSame = true;
	} else if (info.light >= 10 || info.lava) {
		info.material = MATERIAL_EMISSIVE;
	}

	if (info.lava) {
		info.colors = colorFor('lava', 0, {});
	}

	return info;
}

export const WATER_COLOR = hexToRgb(COLORS.water);
export const LAVA_COLOR = hexToRgb(COLORS.lava);

/** Colour of an item (for dropped items / held items) derived from its name. */
export function itemColor(itemName) {
	const name = (itemName || '').replace('minecraft:', '');
	const known = COLORS[name];
	if (known) return hexToRgb(Array.isArray(known) ? known[1] : known);
	if (name.includes('diamond')) return hexToRgb('#62ede4');
	if (name.includes('gold')) return hexToRgb('#f7d138');
	if (name.includes('iron')) return hexToRgb('#d8d8d8');
	if (name.includes('netherite')) return hexToRgb('#423d3f');
	if (name.includes('emerald')) return hexToRgb('#2adb5c');
	if (name.includes('redstone')) return hexToRgb('#af1b05');
	if (name.includes('wood') || name.includes('stick') || name.includes('planks')) return hexToRgb('#a2834f');
	if (name.includes('stone')) return hexToRgb('#7d7d7d');
	let h = 0;
	for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
	return [((h >> 16) & 255) / 255 * 0.6 + 0.3, ((h >> 8) & 255) / 255 * 0.6 + 0.3, (h & 255) / 255 * 0.6 + 0.3];
}
