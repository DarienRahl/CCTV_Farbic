// Mob models written like Minecraft's LayerDefinitions (texOffs / addBox /
// PartPose in model space: y down, facing -Z, feet at y = 24) and converted to
// the viewer's space (y up, facing +Z). Textures come from the client jar.

const PI = Math.PI;

/** box(u, v, x, y, z, w, h, d, {inflate, mirror, offset: [x, y, z] of a child part}) */
function box(u, v, x, y, z, w, h, d, opts = {}) {
	return { uv: [u, v], from: [x, y, z], size: [w, h, d], inflate: opts.inflate || 0, mirror: !!opts.mirror, offset: opts.offset || [0, 0, 0] };
}

/** part(name, boxes, offset [x, y, z], rotation [x, y, z]) */
function part(name, boxes, offset = [0, 0, 0], rot = [0, 0, 0]) {
	return { name, boxes, offset, rot };
}

function humanoid({ thin = false, textureHeight = 64, leftLimbs = null } = {}) {
	const aw = thin ? 2 : 4;
	const arm = thin ? [-1, -2, -1] : [-3, -2, -2];
	const armL = thin ? [-1, -2, -1] : [-1, -2, -2];
	const leg = thin ? [-1, 0, -1] : [-2, 0, -2];
	const legX = thin ? 2 : 1.9;
	const leftArm = leftLimbs ? box(leftLimbs.arm[0], leftLimbs.arm[1], ...armL, aw, 12, aw) : box(40, 16, ...armL, aw, 12, aw, { mirror: true });
	const leftLeg = leftLimbs ? box(leftLimbs.leg[0], leftLimbs.leg[1], ...leg, aw, 12, aw) : box(0, 16, ...leg, aw, 12, aw, { mirror: true });
	return {
		textureHeight,
		family: 'humanoid',
		parts: [
			part('head', [box(0, 0, -4, -8, -4, 8, 8, 8), box(32, 0, -4, -8, -4, 8, 8, 8, { inflate: 0.5 })]),
			part('body', [box(16, 16, -4, 0, -2, 8, 12, 4)]),
			part('right_arm', [box(40, 16, ...arm, aw, 12, aw)], [-5, 2, 0]),
			part('left_arm', [leftArm], [5, 2, 0]),
			part('right_leg', [box(0, 16, ...leg, aw, 12, aw)], [-legX, 12, 0]),
			part('left_leg', [leftLeg], [legX, 12, 0]),
		],
	};
}

function quadrupedLegs(u, v, height, x, zHind, zFront, w = 4) {
	const legBox = box(u, v, -w / 2, 0, -w / 2, w, height, w);
	return [
		part('right_hind_leg', [legBox], [-x, 24 - height, zHind]),
		part('left_hind_leg', [legBox], [x, 24 - height, zHind]),
		part('right_front_leg', [legBox], [-x, 24 - height, zFront]),
		part('left_front_leg', [legBox], [x, 24 - height, zFront]),
	];
}

const spiderLegs = () => {
	const right = box(18, 0, -15, -1, -1, 16, 2, 2);
	const left = box(18, 0, -1, -1, -1, 16, 2, 2, { mirror: true });
	const m = 0.58119464;
	return [
		part('right_hind_leg', [right], [-4, 15, 2], [0, PI / 4, -PI / 4]),
		part('left_hind_leg', [left], [4, 15, 2], [0, -PI / 4, PI / 4]),
		part('right_middle_hind_leg', [right], [-4, 15, 1], [0, PI / 8, -m]),
		part('left_middle_hind_leg', [left], [4, 15, 1], [0, -PI / 8, m]),
		part('right_middle_front_leg', [right], [-4, 15, 0], [0, -PI / 8, -m]),
		part('left_middle_front_leg', [left], [4, 15, 0], [0, PI / 8, m]),
		part('right_front_leg', [right], [-4, 15, -1], [0, -PI / 4, -PI / 4]),
		part('left_front_leg', [left], [4, 15, -1], [0, PI / 4, PI / 4]),
	];
};

const villagerParts = () => [
	part('head', [box(0, 0, -4, -10, -4, 8, 10, 8), box(24, 0, -1, -1, -6, 2, 4, 2, { offset: [0, -2, 0] })]),
	part('body', [box(16, 20, -4, 0, -3, 8, 12, 6), box(0, 38, -4, 0, -3, 8, 20, 6, { inflate: 0.5 })]),
	part('arms', [box(44, 22, -8, -2, -2, 4, 8, 4), box(44, 22, 4, -2, -2, 4, 8, 4, { mirror: true }), box(40, 38, -4, 2, -2, 8, 4, 4)], [0, 3, -1], [-0.75, 0, 0]),
	part('right_leg', [box(0, 22, -2, 0, -2, 4, 12, 4)], [-2, 12, 0]),
	part('left_leg', [box(0, 22, -2, 0, -2, 4, 12, 4, { mirror: true })], [2, 12, 0]),
];

/**
 * type -> {textures: candidate paths below textures/entity, model(), scale, zombieArms}
 * Paths are tried in order, so both new (26.x) and older file names work.
 */
export const MOB_MODELS = {
	zombie: { textures: ['zombie/zombie'], model: () => humanoid(), zombieArms: true },
	husk: { textures: ['zombie/husk'], model: () => humanoid(), zombieArms: true, scale: 1.0625 },
	drowned: { textures: ['zombie/drowned'], model: () => humanoid(), zombieArms: true },
	skeleton: { textures: ['skeleton/skeleton'], model: () => humanoid({ thin: true, textureHeight: 32 }) },
	stray: { textures: ['skeleton/stray'], model: () => humanoid({ thin: true, textureHeight: 32 }) },
	bogged: { textures: ['skeleton/bogged'], model: () => humanoid({ thin: true, textureHeight: 32 }) },
	parched: { textures: ['skeleton/parched'], model: () => humanoid({ thin: true, textureHeight: 32 }) },
	wither_skeleton: { textures: ['skeleton/wither_skeleton'], model: () => humanoid({ thin: true, textureHeight: 32 }), scale: 1.2 },
	creeper: {
		textures: ['creeper/creeper'],
		model: () => ({
			textureHeight: 32,
			family: 'quadruped',
			parts: [
				part('head', [box(0, 0, -4, -8, -4, 8, 8, 8)], [0, 6, 0]),
				part('body', [box(16, 16, -4, 0, -2, 8, 12, 4)], [0, 6, 0]),
				...quadrupedLegs(0, 16, 6, 2, 4, -4),
			],
		}),
	},
	spider: {
		textures: ['spider/spider'],
		model: () => ({
			textureHeight: 32,
			family: 'spider',
			parts: [
				part('head', [box(32, 4, -4, -4, -8, 8, 8, 8)], [0, 15, -3]),
				part('neck', [box(0, 0, -3, -3, -3, 6, 6, 6)], [0, 15, 0]),
				part('body', [box(0, 12, -5, -4, -6, 10, 8, 12)], [0, 15, 9]),
				...spiderLegs(),
			],
		}),
	},
	cave_spider: { textures: ['spider/cave_spider'], model: () => MOB_MODELS.spider.model(), scale: 0.7 },
	cow: {
		textures: ['cow/cow_temperate', 'cow/temperate_cow', 'cow/cow'],
		model: () => ({
			textureHeight: 64,
			family: 'quadruped',
			parts: [
				part('head', [box(0, 0, -4, -4, -6, 8, 8, 6), box(22, 0, -5, -5, -4, 1, 3, 1), box(22, 0, 4, -5, -4, 1, 3, 1)], [0, 4, -8]),
				part('body', [box(18, 4, -6, -10, -7, 12, 18, 10), box(52, 0, -2, 2, -8, 4, 6, 1)], [0, 5, 2], [PI / 2, 0, 0]),
				...quadrupedLegs(0, 16, 12, 4, 7, -6),
			],
		}),
	},
	mooshroom: { textures: ['cow/mooshroom_red', 'cow/red_mooshroom'], model: () => MOB_MODELS.cow.model() },
	pig: {
		textures: ['pig/pig_temperate', 'pig/temperate_pig', 'pig/pig'],
		model: () => ({
			textureHeight: 64,
			family: 'quadruped',
			parts: [
				part('head', [box(0, 0, -4, -4, -8, 8, 8, 8), box(16, 16, -2, 0, -9, 4, 3, 1)], [0, 12, -6]),
				part('body', [box(28, 8, -5, -10, -7, 10, 16, 8)], [0, 11, 2], [PI / 2, 0, 0]),
				...quadrupedLegs(0, 16, 6, 3, 7, -5),
			],
		}),
	},
	sheep: {
		textures: ['sheep/sheep'],
		overlay: { textures: ['sheep/sheep_wool'], parts: 'wool' },
		model: () => ({
			textureHeight: 32,
			family: 'quadruped',
			parts: [
				part('head', [box(0, 0, -3, -4, -6, 6, 6, 8)], [0, 6, -8]),
				part('body', [box(28, 8, -4, -10, -7, 8, 16, 6)], [0, 5, 2], [PI / 2, 0, 0]),
				...quadrupedLegs(0, 16, 12, 3, 7, -5),
			],
		}),
		wool: () => ({
			textureHeight: 32,
			family: 'quadruped',
			parts: [
				part('head', [box(0, 0, -3, -4, -4, 6, 6, 6, { inflate: 0.6 })], [0, 6, -8]),
				part('body', [box(28, 8, -4, -10, -7, 8, 16, 6, { inflate: 1.75 })], [0, 5, 2], [PI / 2, 0, 0]),
				...quadrupedLegs(0, 16, 12, 3, 7, -5).map(p => ({ ...p, boxes: [box(0, 16, -2, 0, -2, 4, 6, 4, { inflate: 0.5 })] })),
			],
		}),
	},
	chicken: {
		textures: ['chicken/chicken_temperate', 'chicken/temperate_chicken', 'chicken/chicken'],
		model: () => ({
			textureHeight: 32,
			family: 'chicken',
			parts: [
				part('head', [box(0, 0, -2, -6, -2, 4, 6, 3), box(14, 0, -2, -4, -4, 4, 2, 2), box(14, 4, -1, -2, -3, 2, 2, 2)], [0, 15, -4]),
				part('body', [box(0, 9, -3, -4, -3, 6, 8, 6)], [0, 16, 0], [PI / 2, 0, 0]),
				part('right_leg', [box(26, 0, -1, 0, -3, 3, 5, 3)], [-2, 19, 1]),
				part('left_leg', [box(26, 0, -1, 0, -3, 3, 5, 3)], [1, 19, 1]),
				part('right_wing', [box(24, 13, 0, 0, -3, 1, 4, 6)], [-4, 13, 0]),
				part('left_wing', [box(24, 13, -1, 0, -3, 1, 4, 6)], [4, 13, 0]),
			],
		}),
	},
	villager: { textures: ['villager/villager'], model: () => ({ textureHeight: 64, family: 'villager', parts: villagerParts() }) },
	wandering_trader: { textures: ['wandering_trader'], model: () => ({ textureHeight: 64, family: 'villager', parts: villagerParts() }) },
	enderman: {
		textures: ['enderman/enderman'],
		model: () => ({
			textureHeight: 32,
			family: 'humanoid',
			parts: [
				part('head', [box(0, 0, -4, -8, -4, 8, 8, 8)], [0, -14, 0]),
				part('body', [box(32, 16, -4, 0, -2, 8, 12, 4)], [0, -14, 0]),
				part('right_arm', [box(56, 0, -1, -2, -1, 2, 30, 2)], [-5, -12, 0]),
				part('left_arm', [box(56, 0, -1, -2, -1, 2, 30, 2, { mirror: true })], [5, -12, 0]),
				part('right_leg', [box(56, 0, -1, 0, -1, 2, 30, 2)], [-2, -5, 0]),
				part('left_leg', [box(56, 0, -1, 0, -1, 2, 30, 2, { mirror: true })], [2, -5, 0]),
			],
		}),
	},
	wolf: {
		textures: ['wolf/wolf'],
		model: () => ({
			textureHeight: 32,
			family: 'quadruped',
			parts: [
				part('head', [box(0, 0, -2, -3, -2, 6, 6, 4), box(16, 14, -2, -5, 0, 2, 2, 1), box(16, 14, 2, -5, 0, 2, 2, 1), box(0, 10, -0.5, -0.001, -5, 3, 3, 4)], [-1, 13.5, -7]),
				part('body', [box(18, 14, -3, -2, -3, 6, 9, 6)], [0, 14, 2], [PI / 2, 0, 0]),
				part('mane', [box(21, 0, -3, -3, -3, 8, 6, 7)], [-1, 14, -3], [PI / 2, 0, 0]),
				part('right_hind_leg', [box(0, 18, 0, 0, -1, 2, 8, 2)], [-2.5, 16, 7]),
				part('left_hind_leg', [box(0, 18, 0, 0, -1, 2, 8, 2)], [0.5, 16, 7]),
				part('right_front_leg', [box(0, 18, 0, 0, -1, 2, 8, 2)], [-2.5, 16, -4]),
				part('left_front_leg', [box(0, 18, 0, 0, -1, 2, 8, 2)], [0.5, 16, -4]),
				part('tail', [box(9, 18, 0, 0, -1, 2, 8, 2)], [-1, 12, 8], [0.63, 0, 0]),
			],
		}),
	},
	slime: {
		textures: ['slime/slime'],
		model: () => ({
			textureHeight: 32,
			family: 'blob',
			parts: [part('cube', [
				box(0, 16, -3, 17, -3, 6, 6, 6),
				box(32, 0, -3.25, 18, -3.5, 2, 2, 2),
				box(32, 4, 1.25, 18, -3.5, 2, 2, 2),
				box(32, 8, 0, 21, -3.5, 1, 1, 1),
			])],
		}),
	},
};

// --- block entities (drawn by the client with entity models) ---------------

/** ChestModel (y up, front towards +Z) for single chests and both halves of double chests. */
function chestModel(kind) {
	const width = kind === 'single' ? 14 : 15;
	const x = kind === 'right' ? 1 : kind === 'left' ? 0 : 1;
	const lockX = kind === 'single' ? 7 : kind === 'left' ? 0 : 15;
	const lockW = kind === 'single' ? 2 : 1;
	return {
		textureHeight: 64,
		family: 'block',
		parts: [
			part('bottom', [box(0, 19, x, 0, 1, width, 10, 14)]),
			part('lid', [box(0, 0, x, 0, 0, width, 5, 14), box(0, 0, lockX, -2, 14, lockW, 4, 1)], [0, 9, 1]),
		],
	};
}

const CHEST_TEXTURES = {
	chest: 'chest/normal',
	trapped_chest: 'chest/trapped',
	ender_chest: 'chest/ender',
	copper_chest: 'chest/copper',
	exposed_copper_chest: 'chest/copper_exposed',
	weathered_copper_chest: 'chest/copper_weathered',
	oxidized_copper_chest: 'chest/copper_oxidized',
};

/** Block entity model for a block (by short name + properties), or null. */
export function blockEntityModel(shortName, props) {
	const name = shortName.startsWith('waxed_') ? shortName.slice(6) : shortName;
	const texture = CHEST_TEXTURES[name];
	if (!texture) return null;
	const kind = name === 'ender_chest' ? 'single' : (props.type || 'single');
	const suffix = kind === 'single' ? '' : '_' + kind;
	const facing = { south: 0, west: 90, north: 180, east: 270 }[props.facing || 'north'] ?? 180;
	return { key: 'chest:' + kind, textures: [texture + suffix], model: () => chestModel(kind), yRot: facing };
}

export function isBlockEntity(shortName) {
	return !!CHEST_TEXTURES[shortName.startsWith('waxed_') ? shortName.slice(6) : shortName];
}

// --- geometry -------------------------------------------------------------

const FACES = [
	{ n: [0, 1, 0], c: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]], uvc: [[0, 0], [0, 1], [1, 1], [1, 0]] },
	{ n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], uvc: [[0, 0], [1, 0], [1, 1], [0, 1]] },
	{ n: [0, 0, -1], c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], uvc: [[0, 1], [1, 1], [1, 0], [0, 0]] },
	{ n: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], uvc: [[0, 1], [1, 1], [1, 0], [0, 0]] },
	{ n: [-1, 0, 0], c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], uvc: [[0, 1], [1, 1], [1, 0], [0, 0]] },
	{ n: [1, 0, 0], c: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], uvc: [[0, 1], [1, 1], [1, 0], [0, 0]] },
];

/** Appends one Minecraft box (in model space) to `out`, converted to the viewer's space around the part pivot. */
function addMcBox(out, b, texWidth, texHeight) {
	const [x, y, z] = b.from;
	const [w, h, d] = b.size;
	const [ox, oy, oz] = b.offset;
	const g = b.inflate;
	// Model space (y down, facing -Z) -> viewer space (y up, facing +Z): (x, y, z) -> (x, -y, -z)
	const x0 = ox + x - g, x1 = ox + x + w + g;
	const y0 = -(oy + y + h) - g, y1 = -(oy + y) + g;
	const z0 = -(oz + z + d) - g, z1 = -(oz + z) + g;
	const [u, v] = b.uv;
	// Face regions of Minecraft's box unwrap, in FACES order (up, down, -z = back, +z = front, -x, +x).
	const regions = [
		[u + d, v, u + d + w, v + d],
		[u + d + w, v, u + d + 2 * w, v + d],
		[u + 2 * d + w, v + d, u + 2 * d + 2 * w, v + d + h],
		[u + d, v + d, u + d + w, v + d + h],
		[u, v + d, u + d, v + d + h],
		[u + d + w, v + d, u + 2 * d + w, v + d + h],
	];
	if (b.mirror) {
		const t = regions[4];
		regions[4] = regions[5];
		regions[5] = t;
	}
	for (let f = 0; f < 6; f++) {
		const face = FACES[f];
		const r = regions[f];
		const verts = [];
		for (let k = 0; k < 4; k++) {
			const c = face.c[k];
			let uc = face.uvc[k][0];
			if (b.mirror) uc = 1 - uc;
			const vc = face.uvc[k][1];
			verts.push([c[0] ? x1 : x0, c[1] ? y1 : y0, c[2] ? z1 : z0, (uc ? r[2] : r[0]) / texWidth, (vc ? r[3] : r[1]) / texHeight]);
		}
		for (const k of [0, 1, 2, 0, 2, 3]) {
			const p = verts[k];
			out.push(p[0], p[1], p[2], face.n[0], face.n[1], face.n[2], p[3], p[4], 1, 1, 1);
		}
	}
}

/** Builds a template compatible with EntityRenderer: {family, parts: {name: {pivot, rot, data}}, textured, mc: true}. */
export function buildMobTemplate(definition, texWidth, texHeight) {
	const parts = {};
	for (const p of definition.parts) {
		const data = [];
		for (const b of p.boxes) addMcBox(data, b, texWidth, texHeight);
		parts[p.name] = {
			pivot: [p.offset[0], 24 - p.offset[1], -p.offset[2]],
			rot: [p.rot[0], -p.rot[1], -p.rot[2]],
			data,
		};
	}
	return { family: definition.family, parts, textured: true, mc: true, height: 32 };
}

/**
 * Minecraft-like animation for the MC templates: returns rotations to ADD to each part's base rotation
 * (x, y, z in viewer space).
 */
export function animateMob(template, e, s, time, def) {
	const r = {};
	const ls = s.limbPos, amount = s.limbAmp;
	const netHead = ((((e.head ?? e.yaw) - (e.body ?? e.yaw)) % 360) + 540) % 360 - 180;
	const pitch = Math.max(-80, Math.min(80, e.pitch)) * PI / 180;
	r.head = [pitch, -netHead * PI / 180, 0];

	const cos = Math.cos;
	const walk = cos(ls * 0.6662) * 1.4 * amount;
	const walkOpp = cos(ls * 0.6662 + PI) * 1.4 * amount;

	switch (template.family) {
		case 'humanoid':
		case 'villager': {
			r.right_leg = [walk, 0, 0];
			r.left_leg = [walkOpp, 0, 0];
			r.right_arm = [cos(ls * 0.6662 + PI) * amount, 0, 0];
			r.left_arm = [cos(ls * 0.6662) * amount, 0, 0];
			if (def && def.zombieArms) {
				const bob = Math.sin(time * 1.3) * 0.05;
				r.right_arm = [-PI / 2 + bob, 0, 0];
				r.left_arm = [-PI / 2 - bob, 0, 0];
			}
			if (s.swingProgress > 0) {
				const p = Math.sin(s.swingProgress * PI);
				r.right_arm = [(r.right_arm[0] || 0) - 1.2 * p, -0.3 * p, 0];
			}
			if (e.riding) {
				r.right_leg = [-1.4137, -0.3142, 0];
				r.left_leg = [-1.4137, 0.3142, 0];
				r.right_arm = [-0.6283, 0, 0];
				r.left_arm = [-0.6283, 0, 0];
			}
			if (e.sneak || e.pose === 'crouching') {
				r.body = [0.5, 0, 0];
				r.right_arm = [(r.right_arm[0] || 0) + 0.4, 0, 0];
				r.left_arm = [(r.left_arm[0] || 0) + 0.4, 0, 0];
			}
			break;
		}
		case 'quadruped':
			r.right_hind_leg = [walk, 0, 0];
			r.left_hind_leg = [walkOpp, 0, 0];
			r.right_front_leg = [walkOpp, 0, 0];
			r.left_front_leg = [walk, 0, 0];
			break;
		case 'chicken':
			r.right_leg = [walk, 0, 0];
			r.left_leg = [walkOpp, 0, 0];
			r.right_wing = [0, 0, -(Math.sin(time * 20) * 0.5 + 0.5) * (e.onGround === false ? 1 : 0)];
			r.left_wing = [0, 0, (Math.sin(time * 20) * 0.5 + 0.5) * (e.onGround === false ? 1 : 0)];
			break;
		case 'spider': {
			const names = ['right_hind_leg', 'left_hind_leg', 'right_middle_hind_leg', 'left_middle_hind_leg',
				'right_middle_front_leg', 'left_middle_front_leg', 'right_front_leg', 'left_front_leg'];
			const phases = [0, 0, PI, PI, PI / 2, PI / 2, PI * 1.5, PI * 1.5];
			names.forEach((name, i) => {
				const side = i % 2 === 0 ? 1 : -1;
				const y = -(cos(ls * 0.6662 * 2 + phases[i]) * 0.4) * amount * side;
				const z = Math.abs(Math.sin(ls * 0.6662 + phases[i]) * 0.4) * amount * side;
				r[name] = [0, -y, -z];
			});
			r.neck = [0, 0, 0];
			break;
		}
		default:
			break;
	}
	return r;
}
