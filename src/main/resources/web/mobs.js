// How each entity type is drawn: which model layers (from the client jar),
// which textures (paths below textures/entity, as in the 26.3 renderers),
// renderer transforms, extra layers (saddles, armour, collars, wool, eyes...)
// and the setupAnim-style animation of the parts.

import { DEG } from './entity-models.js';

const PI = Math.PI;
const cos = Math.cos, sin = Math.sin, abs = Math.abs;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const strip = id => (id || '').replace(/^minecraft:/, '');

/** DyeColor.getTextureDiffuseColor */
export const DYE = {
	white: 0xf9fffe, orange: 0xf9801d, magenta: 0xc74ebd, light_blue: 0x3ab3da, yellow: 0xfed83d, lime: 0x80c71f,
	pink: 0xf38baa, gray: 0x474f52, light_gray: 0x9d9d97, cyan: 0x169c9c, purple: 0x8932b8, blue: 0x3c44aa,
	brown: 0x835432, green: 0x5e7c16, red: 0xb02e26, black: 0x1d1d21,
};
export const dyeRgb = (name, factor = 1) => {
	const c = DYE[strip(name)] ?? 0xffffff;
	return [(c >> 16 & 255) / 255 * factor, (c >> 8 & 255) / 255 * factor, (c & 255) / 255 * factor, 1];
};

// --- animation helpers (AnimationUtils / model setupAnim code) ----------------------------------------

function headLook(p, a, part = 'head') {
	const head = p[part];
	if (!head) return;
	head.yRot += a.netHeadYaw * DEG;
	head.xRot += a.headPitch * DEG;
}

function quadrupedLegs(p, a, amount = 1.4) {
	const w = a.walk * 0.6662, s = a.walkSpeed * amount;
	if (p.right_hind_leg) p.right_hind_leg.xRot += cos(w) * s;
	if (p.left_hind_leg) p.left_hind_leg.xRot += cos(w + PI) * s;
	if (p.right_front_leg) p.right_front_leg.xRot += cos(w + PI) * s;
	if (p.left_front_leg) p.left_front_leg.xRot += cos(w) * s;
	if (p.right_mid_leg) p.right_mid_leg.xRot += cos(w) * s;
	if (p.left_mid_leg) p.left_mid_leg.xRot += cos(w + PI) * s;
}

function bobArms(p, age) {
	if (p.right_arm) {
		p.right_arm.zRot += cos(age * 0.09) * 0.05 + 0.05;
		p.right_arm.xRot += sin(age * 0.067) * 0.05;
	}
	if (p.left_arm) {
		p.left_arm.zRot -= cos(age * 0.09) * 0.05 + 0.05;
		p.left_arm.xRot -= sin(age * 0.067) * 0.05;
	}
}

/** HumanoidModel.setupAnim (without the item poses that need client-only state). */
function humanoid(p, a, e) {
	headLook(p, a);
	const w = a.walk * 0.6662, s = a.walkSpeed;
	if (p.right_arm) { p.right_arm.xRot = cos(w + PI) * 2 * s * 0.5; p.right_arm.zRot = 0; }
	if (p.left_arm) { p.left_arm.xRot = cos(w) * 2 * s * 0.5; p.left_arm.zRot = 0; }
	if (p.right_leg) { p.right_leg.xRot = cos(w) * 1.4 * s; p.right_leg.yRot = 0; p.right_leg.zRot = 0; }
	if (p.left_leg) { p.left_leg.xRot = cos(w + PI) * 1.4 * s; p.left_leg.yRot = 0; p.left_leg.zRot = 0; }
	if (e.riding) {
		if (p.right_arm) p.right_arm.xRot += -PI / 5;
		if (p.left_arm) p.left_arm.xRot += -PI / 5;
		if (p.right_leg) { p.right_leg.xRot = -1.4137167; p.right_leg.yRot = PI / 10; p.right_leg.zRot = 0.07853982; }
		if (p.left_leg) { p.left_leg.xRot = -1.4137167; p.left_leg.yRot = -PI / 10; p.left_leg.zRot = -0.07853982; }
	}
	if (e.hand && p.right_arm) p.right_arm.xRot = p.right_arm.xRot * 0.5 - PI / 10;
	if (e.offhand && p.left_arm) p.left_arm.xRot = p.left_arm.xRot * 0.5 - PI / 10;
	if (a.attack > 0 && p.right_arm && p.body) {
		const t = a.attack;
		p.body.yRot = sin(Math.sqrt(t) * PI * 2) * 0.2;
		p.right_arm.yRot += p.body.yRot;
		const f = 1 - (1 - t) ** 4;
		p.right_arm.xRot -= sin(f * PI) * 1.2 + sin(t * PI) * -(p.head ? p.head.xRot - 0.7 : -0.7) * 0.75;
		p.right_arm.zRot += sin(t * PI) * -0.4;
	}
	if (e.sneak || e.pose === 'crouching') {
		if (p.body) { p.body.xRot = 0.5; p.body.y += 3.2; }
		if (p.right_arm) { p.right_arm.xRot += 0.4; p.right_arm.y += 3.2; }
		if (p.left_arm) { p.left_arm.xRot += 0.4; p.left_arm.y += 3.2; }
		if (p.right_leg) p.right_leg.z += 4;
		if (p.left_leg) p.left_leg.z += 4;
		if (p.head) p.head.y += 4.2;
	}
	bobArms(p, a.age);
	if (p.head) {
		if (e.pose === 'fall_flying') p.head.xRot = -PI / 4;
		else if (a.swimAmount > 0) p.head.xRot = lerp(a.swimAmount, p.head.xRot, -PI / 4);
		else if (e.pose === 'swimming' && !e.type.endsWith(':player')) p.head.xRot = -PI / 4;
	}
	if (a.swimAmount > 0) swimStroke(p, a, a.attack > 0);
}

const lerp = (t, a, b) => a + (b - a) * t;
const armCurve = f => -65 * f + f * f;

/** HumanoidModel.setupAnim while swimming: the arm stroke and the leg kicks. */
function swimStroke(p, a, attacking) {
	const s = a.swimAmount, l = a.walk % 26;
	const left = s, right = attacking ? 0 : s;
	const arms = (xl, xr, zl, zr) => {
		if (p.left_arm) { p.left_arm.xRot = lerp(left, p.left_arm.xRot, xl); p.left_arm.yRot = lerp(left, p.left_arm.yRot, PI); p.left_arm.zRot = lerp(left, p.left_arm.zRot, zl); }
		if (p.right_arm) { p.right_arm.xRot = lerp(right, p.right_arm.xRot, xr); p.right_arm.yRot = lerp(right, p.right_arm.yRot, PI); p.right_arm.zRot = lerp(right, p.right_arm.zRot, zr); }
	};
	if (l < 14) {
		const f = 1.8707964 * armCurve(l) / armCurve(14);
		arms(0, 0, PI + f, PI - f);
	} else if (l < 22) {
		const o = (l - 14) / 8;
		arms(PI / 2 * o, PI / 2 * o, 5.012389 - 1.8707964 * o, 1.2707963 + 1.8707964 * o);
	} else {
		const o = (l - 22) / 4;
		arms(PI / 2 - PI / 2 * o, PI / 2 - PI / 2 * o, PI, PI);
	}
	if (p.left_leg) p.left_leg.xRot = lerp(s, p.left_leg.xRot, 0.3 * cos(l * 0.33333334 + PI));
	if (p.right_leg) p.right_leg.xRot = lerp(s, p.right_leg.xRot, 0.3 * cos(l * 0.33333334));
}

/** AnimationUtils.animateZombieArms */
function zombieArms(p, a, aggressive) {
	const attack2 = sin(a.attack * PI);
	const attack = sin((1 - (1 - a.attack) * (1 - a.attack)) * PI);
	const armX = -PI / (aggressive ? 1.5 : 2.25);
	if (p.right_arm) { p.right_arm.zRot = 0; p.right_arm.yRot = -(0.1 - attack2 * 0.6); p.right_arm.xRot = armX + attack2 * 1.2 - attack * 0.4; }
	if (p.left_arm) { p.left_arm.zRot = 0; p.left_arm.yRot = 0.1 - attack2 * 0.6; p.left_arm.xRot = armX + attack2 * 1.2 - attack * 0.4; }
	bobArms(p, a.age);
}

const triangleWave = (t, period) => (abs(t % period - period * 0.5) - period * 0.25) / (period * 0.25);

const ANIMS = {
	none() {},
	head(p, a) { headLook(p, a); },
	quadruped(p, a) {
		headLook(p, a);
		quadrupedLegs(p, a);
	},
	humanoid,
	zombie(p, a, e) {
		humanoid(p, a, e);
		zombieArms(p, a, !!(e.d && e.d.aggressive));
	},
	skeleton(p, a, e) {
		humanoid(p, a, e);
		if (e.hand && /bow$/.test(e.hand)) {
			// Holding a bow up like AnimationUtils.animateCrossbowHold / bow aiming.
			if (p.right_arm && p.head) { p.right_arm.yRot = -0.1 + p.head.yRot; p.right_arm.xRot = -PI / 2 + p.head.xRot; }
			if (p.left_arm && p.head) { p.left_arm.yRot = 0.1 + p.head.yRot + 0.4; p.left_arm.xRot = -PI / 2 + p.head.xRot; }
		}
	},
	villager(p, a) {
		headLook(p, a);
		const w = a.walk * 0.6662, s = a.walkSpeed;
		if (p.right_leg) p.right_leg.xRot = cos(w) * 1.4 * s * 0.5;
		if (p.left_leg) p.left_leg.xRot = cos(w + PI) * 1.4 * s * 0.5;
	},
	illager(p, a, e) {
		headLook(p, a);
		const w = a.walk * 0.6662, s = a.walkSpeed;
		if (p.right_leg) p.right_leg.xRot = cos(w) * 1.4 * s * 0.5;
		if (p.left_leg) p.left_leg.xRot = cos(w + PI) * 1.4 * s * 0.5;
		const crossed = !e.hand;
		if (p.arms) p.arms.visible = crossed;
		if (p.left_arm) p.left_arm.visible = !crossed;
		if (p.right_arm) p.right_arm.visible = !crossed;
		if (!crossed) {
			if (p.right_arm) p.right_arm.xRot = cos(w + PI) * 2 * s * 0.5;
			if (p.left_arm) p.left_arm.xRot = cos(w) * 2 * s * 0.5;
			if (e.d && e.d.aggressive) zombieArms(p, a, true);
		}
	},
	spider(p, a) {
		headLook(p, a);
		const w = a.walk * 0.6662, s = a.walkSpeed;
		const f0 = -(cos(w * 2) * 0.4) * s, f1 = -(cos(w * 2 + PI) * 0.4) * s;
		const f2 = -(cos(w * 2 + PI / 2) * 0.4) * s, f3 = -(cos(w * 2 + PI * 3 / 2) * 0.4) * s;
		const f4 = abs(sin(w) * 0.4) * s, f5 = abs(sin(w + PI) * 0.4) * s;
		const f6 = abs(sin(w + PI / 2) * 0.4) * s, f7 = abs(sin(w + PI * 3 / 2) * 0.4) * s;
		const legs = [['hind', f0, f4], ['middle_hind', f1, f5], ['middle_front', f2, f6], ['front', f3, f7]];
		for (const [name, y, z] of legs) {
			const r = p['right_' + name + '_leg'], l = p['left_' + name + '_leg'];
			if (r) { r.yRot += y; r.zRot += z; }
			if (l) { l.yRot -= y; l.zRot -= z; }
		}
	},
	creeper(p, a) {
		headLook(p, a);
		quadrupedLegs(p, a);
	},
	chicken(p, a) {
		headLook(p, a);
		if (p.beak) { p.beak.yRot = p.head ? p.head.yRot : 0; }
		const w = a.walk * 0.6662, s = a.walkSpeed;
		if (p.right_leg) p.right_leg.xRot = cos(w) * 1.4 * s;
		if (p.left_leg) p.left_leg.xRot = cos(w + PI) * 1.4 * s;
	},
	horse(p, a, e) {
		const head = p.head_parts;
		if (head) {
			head.xRot = PI / 6 + clamp(a.headPitch, -20, 20) * DEG;
			head.yRot = clamp(a.netHeadYaw, -20, 20) * DEG;
		}
		const w = a.walk * 0.6662, s = a.walkSpeed;
		const legSwing = cos(w + PI) * 0.8 * s;
		if (p.left_hind_leg) p.left_hind_leg.xRot = legSwing;
		if (p.right_hind_leg) p.right_hind_leg.xRot = -legSwing;
		if (p.left_front_leg) p.left_front_leg.xRot = -legSwing;
		if (p.right_front_leg) p.right_front_leg.xRot = legSwing;
		if (p.tail) p.tail.xRot = PI / 6 + s * 0.75;
		if (e.d && e.d.chest) {
			if (p.left_chest) p.left_chest.visible = true;
			if (p.right_chest) p.right_chest.visible = true;
		} else {
			if (p.left_chest) p.left_chest.visible = false;
			if (p.right_chest) p.right_chest.visible = false;
		}
	},
	llama(p, a, e) {
		headLook(p, a);
		quadrupedLegs(p, a);
		const chest = !!(e.d && e.d.chest);
		if (p.left_chest) p.left_chest.visible = chest;
		if (p.right_chest) p.right_chest.visible = chest;
	},
	wolf(p, a, e) {
		headLook(p, a);
		quadrupedLegs(p, a);
		const tail = p.real_tail || p.tail;
		if (tail) tail.yRot = e.d && e.d.angry ? 0 : cos(a.walk * 0.6662) * 1.4 * a.walkSpeed;
		if (e.d && e.d.sitting) {
			if (p.upper_body) { p.upper_body.xRot = PI * 0.4; }
			if (p.body) { p.body.xRot = PI / 4; p.body.y += 2; }
			if (p.right_hind_leg) { p.right_hind_leg.xRot = PI * 1.5; p.right_hind_leg.y += 6.7; p.right_hind_leg.z -= 5; }
			if (p.left_hind_leg) { p.left_hind_leg.xRot = PI * 1.5; p.left_hind_leg.y += 6.7; p.left_hind_leg.z -= 5; }
			if (p.right_front_leg) { p.right_front_leg.xRot = PI * 1.85; p.right_front_leg.y += 1; }
			if (p.left_front_leg) { p.left_front_leg.xRot = PI * 1.85; p.left_front_leg.y += 1; }
		}
	},
	cat(p, a, e) {
		headLook(p, a);
		quadrupedLegs(p, a, 1);
		if (e.d && e.d.sitting && p.body) {
			p.body.xRot = PI / 4;
			p.body.y -= 4; p.body.z += 5;
			if (p.head) { p.head.y -= 3.3; p.head.z += 1; }
			for (const leg of ['right_hind_leg', 'left_hind_leg']) if (p[leg]) { p[leg].xRot = -PI / 2; p[leg].y += 4; p[leg].z += 2; }
			for (const leg of ['right_front_leg', 'left_front_leg']) if (p[leg]) { p[leg].xRot = -0.15707964; p[leg].y += 2.1; p[leg].z -= 1.1; }
		}
	},
	ghast(p, a) {
		for (let i = 0; i < 9; i++) {
			const t = p['tentacle' + i];
			if (t) t.xRot = 0.2 * sin(a.age * 0.3 + i) + 0.4;
		}
	},
	squid(p, a) {
		const angle = (sin(a.age * 0.25) * 0.5 + 0.5) * PI * 0.25;
		for (let i = 0; i < 8; i++) {
			const t = p['tentacle' + i];
			if (t) t.xRot = angle;
		}
	},
	blaze(p, a) {
		headLook(p, a);
		let f = a.age * PI * -0.1;
		for (let i = 0; i < 4; i++) {
			const r = p['part' + i];
			if (r) { r.y = -2 + cos((i * 2 + a.age) * 0.25); r.x = cos(f) * 9; r.z = sin(f) * 9; }
			f++;
		}
		f = PI / 4 + a.age * PI * 0.03;
		for (let i = 4; i < 8; i++) {
			const r = p['part' + i];
			if (r) { r.y = 2 + cos((i * 2 + a.age) * 0.25); r.x = cos(f) * 7; r.z = sin(f) * 7; }
			f++;
		}
		f = 0.47123894 + a.age * PI * -0.05;
		for (let i = 8; i < 12; i++) {
			const r = p['part' + i];
			if (r) { r.y = 11 + cos((i * 1.5 + a.age) * 0.5); r.x = cos(f) * 5; r.z = sin(f) * 5; }
			f++;
		}
	},
	bat(p, a) {
		headLook(p, a);
		const flap = cos(a.age * 74.48451 * DEG) * PI * 0.25;
		if (p.right_wing) p.right_wing.yRot = flap;
		if (p.left_wing) p.left_wing.yRot = -flap;
		if (p.right_wing_tip) p.right_wing_tip.yRot = flap * 0.5;
		if (p.left_wing_tip) p.left_wing_tip.yRot = -flap * 0.5;
	},
	bee(p, a) {
		const flap = cos(a.age * 2.1) * PI * 0.15;
		if (p.right_wing) { p.right_wing.yRot = 0; p.right_wing.zRot = flap; }
		if (p.left_wing) { p.left_wing.yRot = 0; p.left_wing.zRot = -flap; }
		if (p.bone) p.bone.y += cos(a.age * 0.18) * 0.9;
	},
	flyer(p, a) {
		headLook(p, a);
		const flap = cos(a.age * 20 * DEG) * PI * 0.15;
		if (p.right_wing) { p.right_wing.yRot = 0.47123894 + flap; }
		if (p.left_wing) { p.left_wing.yRot = -0.47123894 - flap; }
	},
	parrot(p, a) {
		headLook(p, a);
		const flap = sin(a.age * 0.3) * 0.2;
		if (p.right_wing) p.right_wing.zRot = flap;
		if (p.left_wing) p.left_wing.zRot = -flap;
	},
	phantom(p, a) {
		const f = a.flap * 7.448451 * DEG;
		const wing = cos(f) * 16 * DEG;
		if (p.left_wing_base) p.left_wing_base.zRot = wing;
		if (p.left_wing_tip) p.left_wing_tip.zRot = wing;
		if (p.right_wing_base) p.right_wing_base.zRot = -wing;
		if (p.right_wing_tip) p.right_wing_tip.zRot = -wing;
		if (p.tail_base) p.tail_base.xRot = -(5 + cos(f * 2) * 5) * DEG;
		if (p.tail_tip) p.tail_tip.xRot = -(5 + cos(f * 2) * 5) * DEG;
	},
	golem(p, a) {
		headLook(p, a);
		const s = a.walkSpeed;
		if (p.right_leg) p.right_leg.xRot = -1.5 * triangleWave(a.walk, 13) * s;
		if (p.left_leg) p.left_leg.xRot = 1.5 * triangleWave(a.walk, 13) * s;
		if (p.right_arm) p.right_arm.xRot = (-0.2 + 1.5 * triangleWave(a.walk, 13)) * s;
		if (p.left_arm) p.left_arm.xRot = (-0.2 - 1.5 * triangleWave(a.walk, 13)) * s;
	},
	fish(p, a) {
		const tail = p.tail_fin || p.tail || p.body_back;
		if (tail) tail.yRot = -0.45 * sin(0.6 * a.age);
	},
	snowGolem(p, a) {
		headLook(p, a);
		if (p.upper_body && p.head) p.upper_body.yRot = p.head.yRot * 0.25;
	},
	wither(p, a) {
		for (const name of ['center_head', 'left_head', 'right_head']) {
			const h = p[name];
			if (h) { h.yRot += a.netHeadYaw * DEG; h.xRot += a.headPitch * DEG; }
		}
		if (p.ribcage) p.ribcage.xRot = (0.065 + 0.05 * cos(a.age * 0.1)) * PI;
		if (p.tail) p.tail.xRot = (0.265 + 0.1 * cos(a.age * 0.1)) * PI;
	},
	dragon(p, a) {
		const flap = sin(a.age * 0.2) * 0.4;
		if (p.right_wing) p.right_wing.zRot = 0.3 + flap;
		if (p.left_wing) p.left_wing.zRot = -0.3 - flap;
	},
	shulker(p, a, e) {
		const peek = e.d && typeof e.d.peek === 'number' ? e.d.peek / 100 : 0;
		const f = (0.5 + peek) * PI;
		if (p.lid) {
			p.lid.y = 16 + sin(f) * 8 + (f > PI ? sin(f) * 6 : 0);
			if (peek > 0.3) p.lid.yRot = (1 - peek) ** 4 * PI * 0.125;
		}
		headLook(p, a);
	},
	guardian(p, a) {
		headLook(p, a);
		for (let i = 0; i < 3; i++) {
			const t = p['tail' + i];
			if (t) t.yRot = sin(a.age * 0.1 + i) * PI * 0.05 * (i + 1);
		}
	},
	armorStand() {},
	boat(p, a) {
		if (p.left_paddle) p.left_paddle.xRot = 0;
		if (p.right_paddle) p.right_paddle.xRot = 0;
	},
	generic(p, a) {
		if (p.head) headLook(p, a);
		if (p.right_front_leg || p.left_hind_leg) quadrupedLegs(p, a);
		else if (p.right_leg && p.left_leg) {
			const w = a.walk * 0.6662, s = a.walkSpeed;
			p.right_leg.xRot += cos(w) * 1.4 * s;
			p.left_leg.xRot += cos(w + PI) * 1.4 * s;
			if (p.right_arm) p.right_arm.xRot += cos(w + PI) * s;
			if (p.left_arm) p.left_arm.xRot += cos(w) * s;
		}
	},
};

// --- per type definitions ----------------------------------------------------------------------------------

/** Variant id -> texture name. */
const variant = (e, fallback) => strip(e.d && e.d.variant) || fallback;
const baby = e => (e.baby ? '_baby' : '');

/**
 * layer: model layer id (without "minecraft:") or function (e) -> layer
 * texture: path below textures/entity or function
 * shadow: shadow radius; scale: extra renderer scale (function or number); anim: ANIMS key
 * layers: extra layers [{layer, texture, color(e), mode, when(e)}]
 */
const HUMANOID_ARMOR = true;

const MOBS = {
	allay: { layer: 'allay#main', texture: 'allay/allay', shadow: 0.4, anim: 'flyer', cull: false },
	armadillo: { layer: e => (e.baby ? 'armadillo_baby#main' : 'armadillo#main'), texture: e => 'armadillo/armadillo' + baby(e), shadow: 0.4, anim: 'quadruped' },
	armor_stand: { layer: e => (e.d && e.d.small ? 'armor_stand_small#main' : 'armor_stand#main'), texture: 'armorstand/armorstand', shadow: 0, anim: 'armorStand', armor: 'armor_stand' },
	axolotl: { layer: e => (e.baby ? 'axolotl_baby#main' : 'axolotl#main'), texture: e => 'axolotl/axolotl_' + variant(e, 'lucy') + baby(e), shadow: 0.5, anim: 'quadruped' },
	bat: { layer: 'bat#main', texture: 'bat/bat', shadow: 0.25, anim: 'bat' },
	bee: {
		layer: e => (e.baby ? 'bee_baby#main' : 'bee#main'),
		texture: e => 'bee/bee' + (e.d && e.d.angry ? '_angry' : '') + (e.d && e.d.nectar ? '_nectar' : '') + baby(e),
		shadow: 0.4, anim: 'bee',
	},
	blaze: { layer: 'blaze#main', texture: 'blaze/blaze', shadow: 0.5, anim: 'blaze', fullBright: true },
	bogged: { layer: 'bogged#main', texture: 'skeleton/bogged', shadow: 0.5, anim: 'skeleton', armor: 'bogged', layers: [{ layer: 'bogged#outer', texture: 'skeleton/bogged_overlay' }] },
	breeze: { layer: 'breeze#main', texture: 'breeze/breeze', shadow: 0.5, anim: 'head', layers: [{ layer: 'breeze#eyes', texture: 'breeze/breeze_eyes', mode: 'eyes' }] },
	camel: { layer: e => (e.baby ? 'camel_baby#main' : 'camel#main'), texture: e => 'camel/camel' + baby(e), shadow: 0.7, anim: 'quadruped', saddle: ['camel#saddle', 'equipment/camel_saddle/saddle'] },
	camel_husk: { layer: 'camel#main', texture: 'camel/camel_husk', shadow: 0.7, anim: 'quadruped', saddle: ['camel_husk#saddle', 'equipment/camel_husk_saddle/saddle'] },
	cat: {
		layer: e => (e.baby ? 'cat_baby#main' : 'cat#main'), texture: e => 'cat/cat_' + variant(e, 'tabby') + baby(e), shadow: 0.4, anim: 'cat',
		layers: [{ layer: e => (e.baby ? 'cat_baby#collar' : 'cat#collar'), texture: e => 'cat/cat_collar' + baby(e), when: e => e.d && e.d.tame, color: e => dyeRgb(e.d.collar || 'red') }],
	},
	cave_spider: { layer: 'cave_spider#main', texture: 'spider/cave_spider', shadow: 0.56, anim: 'spider', layers: [{ layer: 'cave_spider#main', texture: 'spider/spider_eyes', mode: 'eyes' }] },
	chicken: {
		layer: e => (e.baby ? 'chicken_baby#main' : variant(e, 'temperate') === 'cold' ? 'cold_chicken#main' : 'chicken#main'),
		texture: e => 'chicken/chicken_' + variant(e, 'temperate') + baby(e), shadow: 0.3, anim: 'chicken',
	},
	cod: { layer: 'cod#main', texture: 'fish/cod', shadow: 0.3, anim: 'fish', fish: true },
	copper_golem: { layer: 'copper_golem#main', texture: 'copper_golem/copper_golem', shadow: 0.5, anim: 'generic', layers: [{ layer: 'copper_golem#eyes', texture: 'copper_golem/copper_golem_eyes', mode: 'eyes' }] },
	cow: {
		layer: e => (e.baby ? 'cow_baby#main' : ({ cold: 'cold_cow#main', warm: 'warm_cow#main' })[variant(e, 'temperate')] || 'cow#main'),
		texture: e => 'cow/cow_' + variant(e, 'temperate') + baby(e), shadow: 0.7, anim: 'quadruped',
	},
	creaking: { layer: 'creaking#main', texture: 'creaking/creaking', shadow: 0.6, anim: 'generic', layers: [{ layer: 'creaking#eyes', texture: 'creaking/creaking_eyes', mode: 'eyes' }] },
	creeper: {
		layer: 'creeper#main', texture: 'creeper/creeper', shadow: 0.5, anim: 'creeper', creeper: true,
		layers: [{ layer: 'creeper#armor', texture: 'creeper/creeper_armor', when: e => e.d && e.d.powered, mode: 'energy' }],
	},
	dolphin: { layer: e => (e.baby ? 'dolphin_baby#main' : 'dolphin#main'), texture: e => 'dolphin/dolphin' + baby(e), shadow: 0.7, anim: 'fish' },
	donkey: { layer: e => (e.baby ? 'donkey_baby#main' : 'donkey#main'), texture: e => 'horse/donkey' + baby(e), shadow: 0.75, anim: 'horse', saddle: ['donkey#saddle', 'equipment/donkey_saddle/saddle'] },
	drowned: {
		layer: e => (e.baby ? 'drowned_baby#main' : 'drowned#main'), texture: e => 'zombie/drowned' + baby(e), shadow: 0.5, anim: 'zombie', armor: 'drowned',
		layers: [{ layer: e => (e.baby ? 'drowned_baby#outer' : 'drowned#outer'), texture: e => 'zombie/drowned_outer_layer' + baby(e) }],
	},
	elder_guardian: { layer: 'elder_guardian#main', texture: 'guardian/guardian_elder', shadow: 1.2, anim: 'guardian' },
	end_crystal: { special: 'endCrystal' },
	ender_dragon: { layer: 'ender_dragon#main', texture: 'enderdragon/dragon', shadow: 0.5, anim: 'dragon', dragon: true, layers: [{ layer: 'ender_dragon#main', texture: 'enderdragon/dragon_eyes', mode: 'eyes' }] },
	enderman: { layer: 'enderman#main', texture: 'enderman/enderman', shadow: 0.5, anim: 'humanoid', layers: [{ layer: 'enderman#main', texture: 'enderman/enderman_eyes', mode: 'eyes' }] },
	endermite: { layer: 'endermite#main', texture: 'endermite/endermite', shadow: 0.3, anim: 'none' },
	evoker: { layer: 'evoker#main', texture: 'illager/evoker', shadow: 0.5, anim: 'illager' },
	evoker_fangs: { layer: 'evoker_fangs#main', texture: 'illager/evoker_fangs', shadow: 0, anim: 'none', living: false },
	fox: {
		layer: e => (e.baby ? 'fox_baby#main' : 'fox#main'),
		texture: e => 'fox/fox' + (variant(e, 'red') === 'snow' ? '_snow' : '') + (e.pose === 'sleeping' ? '_sleep' : '') + baby(e),
		shadow: 0.4, anim: 'quadruped',
	},
	frog: { layer: 'frog#main', texture: e => 'frog/frog_' + variant(e, 'temperate'), shadow: 0.3, anim: 'head' },
	ghast: { layer: 'ghast#main', texture: e => (e.d && e.d.charging ? 'ghast/ghast_shooting' : 'ghast/ghast'), shadow: 1.5, anim: 'ghast', fullBright: true },
	giant: { layer: 'giant#main', texture: 'zombie/zombie', shadow: 3, anim: 'zombie' },
	glow_squid: { layer: e => (e.baby ? 'glow_squid_baby#main' : 'glow_squid#main'), texture: e => 'squid/glow_squid' + baby(e), shadow: 0.7, anim: 'squid', squid: true, fullBright: true },
	goat: { layer: e => (e.baby ? 'goat_baby#main' : 'goat#main'), texture: e => 'goat/goat' + baby(e), shadow: 0.7, anim: 'quadruped', goat: true },
	guardian: { layer: 'guardian#main', texture: 'guardian/guardian', shadow: 0.5, anim: 'guardian' },
	happy_ghast: {
		layer: e => (e.baby ? 'happy_ghast_baby#main' : 'happy_ghast#main'), texture: e => (e.baby ? 'ghast/happy_ghast_baby' : 'ghast/happy_ghast'),
		shadow: e => (e.baby ? 0.95 : 4), anim: 'ghast',
		layers: [
			{ layer: e => (e.baby ? 'happy_ghast_baby_harness#main' : 'happy_ghast_harness#main'), texture: e => 'equipment/happy_ghast_body/' + strip(e.bodyArmor), when: e => /_harness$/.test(e.bodyArmor || '') },
			{ layer: e => (e.baby ? 'happy_ghast_baby_ropes#main' : 'happy_ghast_ropes#main'), texture: 'ghast/happy_ghast_ropes', when: e => e.d && e.d.leashed },
		],
	},
	hoglin: { layer: e => (e.baby ? 'hoglin_baby#main' : 'hoglin#main'), texture: e => 'hoglin/hoglin' + baby(e), shadow: 0.7, anim: 'quadruped' },
	horse: {
		layer: e => (e.baby ? 'horse_baby#main' : 'horse#main'),
		texture: e => 'horse/horse_' + (variant(e, 'white').replace('dark_brown', 'darkbrown')) + baby(e),
		shadow: 0.75, anim: 'horse', saddle: ['horse#saddle', 'equipment/horse_saddle/saddle'],
		layers: [
			{
				layer: e => (e.baby ? 'horse_baby#main' : 'horse#main'), when: e => e.d && e.d.markings && e.d.markings !== 'none',
				texture: e => 'horse/horse_markings_' + e.d.markings.replace(/_/g, '') + baby(e),
			},
			{ layer: 'horse_armor#main', texture: e => 'equipment/horse_body/' + horseArmor(e.bodyArmor), when: e => !e.baby && !!horseArmor(e.bodyArmor), color: e => (horseArmor(e.bodyArmor) === 'leather' ? [0xa0 / 255, 0x65 / 255, 0x40 / 255, 1] : null) },
		],
	},
	husk: { layer: e => (e.baby ? 'husk_baby#main' : 'husk#main'), texture: e => 'zombie/husk' + baby(e), shadow: 0.5, anim: 'zombie', armor: 'husk' },
	illusioner: { layer: 'illusioner#main', texture: 'illager/illusioner', shadow: 0.5, anim: 'illager' },
	iron_golem: {
		layer: 'iron_golem#main', texture: 'iron_golem/iron_golem', shadow: 0.7, anim: 'golem',
		layers: [{ layer: 'iron_golem#main', texture: e => 'iron_golem/iron_golem_crackiness_' + e.d.crackiness, when: e => e.d && e.d.crackiness && e.d.crackiness !== 'none' }],
	},
	llama: {
		layer: e => (e.baby ? 'llama_baby#main' : 'llama#main'), texture: e => 'llama/llama_' + variant(e, 'creamy') + baby(e), shadow: 0.7, anim: 'llama',
		layers: [{ layer: e => (e.baby ? 'llama_baby#decor' : 'llama#decor'), texture: e => 'equipment/llama_body/' + carpet(e.bodyArmor), when: e => !!carpet(e.bodyArmor) }],
	},
	trader_llama: {
		layer: e => (e.baby ? 'trader_llama_baby#main' : 'trader_llama#main'), texture: e => 'llama/llama_' + variant(e, 'creamy') + baby(e), shadow: 0.7, anim: 'llama',
		layers: [{ layer: e => (e.baby ? 'llama_baby#decor' : 'llama#decor'), texture: e => (e.baby ? 'equipment/llama_body/trader_llama_baby' : 'equipment/llama_body/trader_llama') }],
	},
	magma_cube: { layer: 'magma_cube#main', texture: 'slime/magmacube', shadow: 0.25, anim: 'none', slime: true, fullBright: true },
	mooshroom: { layer: e => (e.baby ? 'mooshroom_baby#main' : 'mooshroom#main'), texture: e => 'cow/mooshroom_' + variant(e, 'red') + baby(e), shadow: 0.7, anim: 'quadruped' },
	mule: { layer: e => (e.baby ? 'mule_baby#main' : 'mule#main'), texture: e => 'horse/mule' + baby(e), shadow: 0.75, anim: 'horse', saddle: ['mule#saddle', 'equipment/mule_saddle/saddle'] },
	nautilus: { layer: e => (e.baby ? 'nautilus_baby#main' : 'nautilus#main'), texture: e => 'nautilus/nautilus' + baby(e), shadow: 0.7, anim: 'none', saddle: ['nautilus#saddle', 'equipment/nautilus_saddle/saddle'] },
	ocelot: { layer: e => (e.baby ? 'ocelot_baby#main' : 'ocelot#main'), texture: e => 'cat/ocelot' + baby(e), shadow: 0.4, anim: 'cat' },
	panda: {
		layer: e => (e.baby ? 'panda_baby#main' : 'panda#main'),
		texture: e => {
			const gene = pandaGene(e);
			if (e.baby) return gene === 'normal' ? 'panda/panda_baby' : 'panda/' + gene + '_panda_baby';
			return gene === 'normal' ? 'panda/panda' : 'panda/panda_' + gene;
		},
		shadow: 0.9, anim: 'quadruped',
	},
	parched: { layer: 'parched#main', texture: 'skeleton/parched', shadow: 0.5, anim: 'skeleton', armor: 'parched' },
	parrot: { layer: 'parrot#main', texture: e => 'parrot/parrot_' + variant(e, 'red_blue').replace(/^gray$/, 'grey'), shadow: 0.3, anim: 'parrot' },
	phantom: { layer: 'phantom#main', texture: 'phantom/phantom', shadow: 0.75, anim: 'phantom', phantom: true, layers: [{ layer: 'phantom#main', texture: 'phantom/phantom_eyes', mode: 'eyes' }] },
	pig: {
		layer: e => (e.baby ? 'pig_baby#main' : variant(e, 'temperate') === 'cold' ? 'cold_pig#main' : 'pig#main'),
		texture: e => 'pig/pig_' + variant(e, 'temperate') + baby(e), shadow: 0.7, anim: 'quadruped', saddle: ['pig#saddle', 'equipment/pig_saddle/saddle'],
	},
	piglin: { layer: e => (e.baby ? 'piglin_baby#main' : 'piglin#main'), texture: e => 'piglin/piglin' + baby(e), shadow: 0.5, anim: 'humanoid', armor: 'piglin' },
	piglin_brute: { layer: 'piglin_brute#main', texture: 'piglin/piglin_brute', shadow: 0.5, anim: 'humanoid', armor: 'piglin_brute' },
	pillager: { layer: 'pillager#main', texture: 'illager/pillager', shadow: 0.5, anim: 'illager' },
	player: { player: true, shadow: 0.5, anim: 'humanoid', armor: 'player' },
	polar_bear: { layer: e => (e.baby ? 'polar_bear_baby#main' : 'polar_bear#main'), texture: e => 'bear/polarbear' + baby(e), shadow: 0.9, anim: 'quadruped' },
	pufferfish: {
		layer: e => ['pufferfish_small#main', 'pufferfish_medium#main', 'pufferfish_big#main'][clamp(Number(e.d && e.d.puff) || 0, 0, 2)],
		texture: 'fish/pufferfish', shadow: 0.2, anim: 'none', puffer: true,
	},
	rabbit: {
		layer: e => (e.baby ? 'rabbit_baby#main' : 'rabbit#main'),
		texture: e => {
			if (e.name === 'Toast') return 'rabbit/rabbit_toast' + baby(e);
			const v = variant(e, 'brown');
			return 'rabbit/rabbit_' + (v === 'evil' ? 'caerbannog' : v) + baby(e);
		},
		shadow: 0.3, anim: 'head',
	},
	ravager: { layer: 'ravager#main', texture: 'illager/ravager', shadow: 1.1, anim: 'quadruped' },
	salmon: {
		layer: e => ({ small: 'salmon_small#main', large: 'salmon_large#main' })[variant(e, 'medium')] || 'salmon#main',
		texture: 'fish/salmon', shadow: 0.4, anim: 'fish', fish: true,
	},
	sheep: {
		layer: e => (e.baby ? 'sheep_baby#main' : 'sheep#main'), texture: e => 'sheep/sheep' + baby(e), shadow: 0.7, anim: 'quadruped',
		layers: [
			{ layer: 'sheep#wool_undercoat', texture: 'sheep/sheep_wool_undercoat', when: e => !e.baby && !(e.d && e.d.sheared), color: e => sheepColor(e) },
			{ layer: e => (e.baby ? 'sheep_baby#wool' : 'sheep#wool'), texture: e => 'sheep/sheep_wool' + baby(e), when: e => !(e.d && e.d.sheared), color: e => sheepColor(e) },
		],
	},
	shulker: {
		layer: 'shulker#main', texture: e => (e.d && e.d.color ? 'shulker/shulker_' + strip(e.d.color) : 'shulker/shulker'), shadow: 0, anim: 'shulker', shulker: true,
	},
	silverfish: { layer: 'silverfish#main', texture: 'silverfish/silverfish', shadow: 0.3, anim: 'none' },
	skeleton: { layer: 'skeleton#main', texture: 'skeleton/skeleton', shadow: 0.5, anim: 'skeleton', armor: 'skeleton' },
	skeleton_horse: { layer: e => (e.baby ? 'skeleton_horse_baby#main' : 'skeleton_horse#main'), texture: e => 'horse/horse_skeleton' + baby(e), shadow: 0.75, anim: 'horse', saddle: ['skeleton_horse#saddle', 'equipment/skeleton_horse_saddle/saddle'] },
	slime: { layer: 'slime#main', texture: 'slime/slime', shadow: 0.25, anim: 'none', slime: true, layers: [{ layer: 'slime#outer', texture: 'slime/slime', mode: 'translucent' }] },
	sniffer: { layer: e => (e.baby ? 'sniffer_baby#main' : 'sniffer#main'), texture: e => (e.baby ? 'sniffer/snifflet' : 'sniffer/sniffer'), shadow: 1.1, anim: 'quadruped' },
	snow_golem: { layer: 'snow_golem#main', texture: 'snow_golem/snow_golem', shadow: 0.5, anim: 'snowGolem' },
	spider: { layer: 'spider#main', texture: 'spider/spider', shadow: 0.8, anim: 'spider', layers: [{ layer: 'spider#main', texture: 'spider/spider_eyes', mode: 'eyes' }] },
	squid: { layer: e => (e.baby ? 'squid_baby#main' : 'squid#main'), texture: e => 'squid/squid' + baby(e), shadow: 0.7, anim: 'squid', squid: true },
	stray: { layer: 'stray#main', texture: 'skeleton/stray', shadow: 0.5, anim: 'skeleton', armor: 'stray', layers: [{ layer: 'stray#outer', texture: 'skeleton/stray_overlay' }] },
	strider: {
		layer: e => (e.baby ? 'strider_baby#main' : 'strider#main'), texture: e => 'strider/strider' + (e.d && e.d.cold ? '_cold' : '') + baby(e), shadow: 0.5, anim: 'generic',
		saddle: ['strider#saddle', 'equipment/strider_saddle/saddle'],
	},
	sulfur_cube: { layer: 'sulfur_cube#main', texture: 'sulfur_cube/sulfur_cube_outer', shadow: 0.25, anim: 'none', slime: true, layers: [{ layer: 'sulfur_cube#inner', texture: 'sulfur_cube/sulfur_cube_inner' }] },
	tadpole: { layer: 'tadpole#main', texture: 'tadpole/tadpole', shadow: 0.14, anim: 'fish' },
	tropical_fish: { tropical: true, shadow: 0.15, anim: 'fish', fish: true },
	turtle: { layer: e => (e.baby ? 'turtle_baby#main' : 'turtle#main'), texture: e => 'turtle/turtle' + baby(e), shadow: 0.7, anim: 'quadruped' },
	vex: { layer: 'vex#main', texture: e => (e.d && e.d.charging ? 'illager/vex_charging' : 'illager/vex'), shadow: 0.3, anim: 'flyer', fullBright: true },
	villager: { villager: 'villager', shadow: 0.5, anim: 'villager' },
	vindicator: { layer: 'vindicator#main', texture: 'illager/vindicator', shadow: 0.5, anim: 'illager' },
	wandering_trader: { layer: 'wandering_trader#main', texture: 'wandering_trader/wandering_trader', shadow: 0.5, anim: 'villager' },
	warden: {
		layer: 'warden#main', texture: 'warden/warden', shadow: 0.9, anim: 'generic',
		layers: [{ layer: 'warden#bioluminescent', texture: 'warden/warden_bioluminescent_layer', mode: 'eyes' }],
	},
	witch: { layer: 'witch#main', texture: 'witch/witch', shadow: 0.5, anim: 'villager' },
	wither: { layer: 'wither#main', texture: e => (e.d && e.d.invulnerable > 0 ? 'wither/wither_invulnerable' : 'wither/wither'), shadow: 1, anim: 'wither', wither: true },
	wither_skeleton: { layer: 'wither_skeleton#main', texture: 'skeleton/wither_skeleton', shadow: 0.7, anim: 'skeleton', armor: 'wither_skeleton' },
	wolf: {
		layer: e => (e.baby ? 'wolf_baby#main' : 'wolf#main'),
		texture: e => {
			const v = variant(e, 'pale');
			const mood = e.d && e.d.tame ? '_tame' : e.d && e.d.angry ? '_angry' : '';
			return 'wolf/wolf' + (v === 'pale' ? '' : '_' + v) + mood + baby(e);
		},
		shadow: 0.5, anim: 'wolf',
		layers: [
			{ layer: e => (e.baby ? 'wolf_baby#main' : 'wolf#main'), texture: e => 'wolf/wolf_collar' + baby(e), when: e => e.d && e.d.tame, color: e => dyeRgb(e.d.collar || 'red') },
			{ layer: 'wolf_armor#main', texture: 'equipment/wolf_body/armadillo_scute', when: e => !e.baby && /wolf_armor/.test(e.bodyArmor || '') },
		],
	},
	zoglin: { layer: e => (e.baby ? 'zoglin_baby#main' : 'zoglin#main'), texture: e => 'hoglin/zoglin' + baby(e), shadow: 0.7, anim: 'quadruped' },
	zombie: { layer: e => (e.baby ? 'zombie_baby#main' : 'zombie#main'), texture: e => 'zombie/zombie' + baby(e), shadow: 0.5, anim: 'zombie', armor: 'zombie' },
	zombie_horse: { layer: e => (e.baby ? 'zombie_horse_baby#main' : 'zombie_horse#main'), texture: e => 'horse/horse_zombie' + baby(e), shadow: 0.75, anim: 'horse', saddle: ['zombie_horse#saddle', 'equipment/zombie_horse_saddle/saddle'] },
	zombie_nautilus: {
		layer: e => (variant(e, 'temperate') === 'warm' ? 'zombie_nautilus_coral#main' : 'zombie_nautilus#main'),
		texture: e => (variant(e, 'temperate') === 'warm' ? 'nautilus/zombie_nautilus_coral' : 'nautilus/zombie_nautilus'), shadow: 0.7, anim: 'none',
		saddle: ['nautilus#saddle', 'equipment/nautilus_saddle/saddle'],
	},
	zombie_villager: { villager: 'zombie_villager', shadow: 0.5, anim: 'zombie', armor: 'zombie_villager' },
	zombified_piglin: { layer: e => (e.baby ? 'zombified_piglin_baby#main' : 'zombified_piglin#main'), texture: e => 'piglin/zombified_piglin' + baby(e), shadow: 0.5, anim: 'zombie', armor: 'zombified_piglin' },
};

function horseArmor(item) {
	const m = /^(?:minecraft:)?([a-z]+)_horse_armor$/.exec(item || '');
	return m ? m[1] : null;
}

function carpet(item) {
	const m = /^(?:minecraft:)?([a-z_]+)_carpet$/.exec(item || '');
	return m && DYE[m[1]] !== undefined ? m[1] : null;
}

function pandaGene(e) {
	const main = strip(e.d && e.d.gene) || 'normal';
	const hidden = strip(e.d && e.d.hiddenGene) || 'normal';
	// Panda.getVariant: recessive genes (brown, weak) only show when both genes match.
	if ((main === 'brown' || main === 'weak') && hidden !== main) return 'normal';
	return main;
}

/** SheepRenderer / Sheep.getColor: white is 0xE6E6E6, other colours are darkened to 75 %. */
function sheepColor(e) {
	const color = strip(e.d && e.d.color) || 'white';
	if (color === 'white') return [0xe6 / 255, 0xe6 / 255, 0xe6 / 255, 1];
	return dyeRgb(color, 0.75);
}

const TROPICAL_SMALL = ['kob', 'sunstreak', 'snooper', 'dasher', 'brinely', 'spotty'];
const TROPICAL_LARGE = ['flopper', 'stripey', 'glitter', 'blockfish', 'betty', 'clayfish'];

/** Armour materials of humanoid armour items. */
const ARMOR_MATERIAL = { leather: 'leather', chainmail: 'chainmail', iron: 'iron', golden: 'gold', diamond: 'diamond', netherite: 'netherite', copper: 'copper', turtle: 'turtle_scute' };
const ARMOR_SLOTS = ['helmet', 'chestplate', 'leggings', 'boots'];

export function armorLayers(prefix, e) {
	if (!e.armor) return [];
	const out = [];
	for (let i = 0; i < 4; i++) {
		const item = strip(e.armor[i]);
		if (!item) continue;
		const m = /^([a-z]+)_(helmet|chestplate|leggings|boots)$/.exec(item);
		if (!m || !ARMOR_MATERIAL[m[1]]) continue;
		const material = ARMOR_MATERIAL[m[1]];
		const slot = ARMOR_SLOTS[i];
		const folder = slot === 'leggings' ? 'humanoid_leggings' : (e.baby ? 'humanoid_baby' : 'humanoid');
		const layer = prefix + (e.baby ? '_baby' : '') + '#' + slot;
		out.push({ layer, texture: 'equipment/' + folder + '/' + material, color: material === 'leather' ? [0xa0 / 255, 0x65 / 255, 0x40 / 255, 1] : null });
		if (material === 'leather') out.push({ layer, texture: 'equipment/' + folder + '/leather_overlay' });
	}
	return out;
}

const VILLAGER_LEVELS = [null, 'stone', 'iron', 'gold', 'emerald', 'diamond'];

/**
 * Resolves what to draw for an entity: {layers: [{layer, texture, mode, color}], def, anim} or null.
 * Textures are paths below textures/entity (or {skin} for players).
 */
export function describeMob(e) {
	const type = strip(e.type);
	const def = MOBS[type];
	if (!def || def.special) return def ? { def, special: def.special } : null;
	const value = (v, fallback) => (typeof v === 'function' ? v(e) : v ?? fallback);
	const out = [];
	const add = (layer, texture, extra = {}) => out.push({ layer: 'minecraft:' + layer, texture, mode: extra.mode || 'cutout', color: extra.color || null });

	if (def.player) {
		const slim = e.slim;
		add(slim ? 'player_slim#main' : 'player#main', { skin: e.uuid }, {});
	} else if (def.villager) {
		const zombie = def.villager === 'zombie_villager';
		const folder = def.villager;
		const data = (e.d && e.d.villager) || {};
		const vtype = strip(data.type || (e.d && e.d.villagerType)) || 'plains';
		const profession = strip(data.profession) || 'none';
		const layer = folder + (e.baby ? '_baby' : '') + '#main';
		const base = e.baby && !zombie ? 'villager/villager_baby' : (e.baby ? folder + '/' + folder + '_baby' : folder + '/' + folder);
		add(layer, base);
		add(layer, folder + (e.baby ? '/baby/' : '/type/') + vtype);
		if (!e.baby && profession !== 'none') {
			add(layer, folder + '/profession/' + profession);
			const level = VILLAGER_LEVELS[Number(data.level) || 0];
			if (level && profession !== 'nitwit') add(layer, folder + '/profession_level/' + level);
		}
	} else if (def.tropical) {
		const pattern = strip(e.d && e.d.pattern) || 'kob';
		const small = TROPICAL_SMALL.indexOf(pattern);
		const large = TROPICAL_LARGE.indexOf(pattern);
		const isLarge = small < 0 && large >= 0;
		const n = (isLarge ? large : Math.max(0, small)) + 1;
		const shape = isLarge ? 'tropical_fish_large' : 'tropical_fish_small';
		add(shape + '#main', isLarge ? 'fish/tropical_b' : 'fish/tropical_a', { color: dyeRgb((e.d && e.d.baseColor) || 'white') });
		add(shape + '#pattern', (isLarge ? 'fish/tropical_b_pattern_' : 'fish/tropical_a_pattern_') + n, { color: dyeRgb((e.d && e.d.patternColor) || 'white') });
	} else {
		add(value(def.layer), value(def.texture), { mode: def.cull === false ? 'cutout_nocull' : 'cutout' });
	}

	for (const extra of def.layers || []) {
		if (extra.when && !extra.when(e)) continue;
		const texture = value(extra.texture);
		if (!texture) continue;
		add(value(extra.layer), texture, { mode: extra.mode, color: extra.color ? extra.color(e) : null });
	}
	if (def.saddle && e.saddle) add(def.saddle[0], def.saddle[1]);
	if (def.armor) out.push(...armorLayers('minecraft:' + def.armor, e).map(l => ({ ...l, mode: 'cutout' })));
	return { def, layers: out, anim: ANIMS[def.anim] || ANIMS.generic, shadow: value(def.shadow, 0.5) };
}

export function isKnownMob(type) {
	return !!MOBS[strip(type)];
}

export { ANIMS };

// --- block entities ----------------------------------------------------------------------------------------

const CHESTS = {
	chest: 'chest/normal', trapped_chest: 'chest/trapped', ender_chest: 'chest/ender',
	copper_chest: 'chest/copper', exposed_copper_chest: 'chest/copper_exposed', weathered_copper_chest: 'chest/copper_weathered', oxidized_copper_chest: 'chest/copper_oxidized',
};
const HEADS = {
	skeleton_skull: ['skeleton_skull', 'skeleton/skeleton'], wither_skeleton_skull: ['wither_skeleton_skull', 'skeleton/wither_skeleton'],
	zombie_head: ['zombie_head', 'zombie/zombie'], creeper_head: ['creeper_head', 'creeper/creeper'],
	piglin_head: ['piglin_head', 'piglin/piglin'], dragon_head: ['dragon_skull', 'enderdragon/dragon'], player_head: ['player_head', 'player/wide/steve'],
};
const FACING_ROT = { north: 180, south: 0, west: 90, east: 270 };

/** Block entity model to draw for a block (chests, shulker boxes, heads, banners, bells, decorated pots). */
export function blockEntityModel(info) {
	let name = info.shortName;
	if (name.startsWith('waxed_')) name = name.slice(6);
	const props = info.props;
	if (CHESTS[name]) {
		const kind = name === 'ender_chest' ? 'single' : (props.type || 'single');
		return {
			kind: 'chest', layer: kind === 'single' ? 'minecraft:chest#main' : 'minecraft:double_chest_' + kind + '#main',
			texture: CHESTS[name] + (kind === 'single' ? '' : '_' + kind), yRot: FACING_ROT[props.facing || 'north'] ?? 180,
		};
	}
	if (name === 'shulker_box' || name.endsWith('_shulker_box')) {
		const color = name === 'shulker_box' ? '' : '_' + name.slice(0, -'_shulker_box'.length);
		return { kind: 'shulker_box', layer: 'minecraft:shulker_box#main', texture: 'shulker/shulker' + color, facing: props.facing || 'up' };
	}
	const wallHead = name.replace('_wall_', '_');
	const head = HEADS[name] || HEADS[wallHead];
	if (head) {
		const wall = name.includes('_wall_');
		return { kind: 'head', layer: 'minecraft:' + head[0] + '#main', texture: head[1], wall, facing: props.facing || 'north', rotation: Number(props.rotation || 0) };
	}
	if (name.endsWith('_banner')) {
		const wall = name.endsWith('_wall_banner');
		const color = name.slice(0, -(wall ? '_wall_banner' : '_banner').length);
		return { kind: 'banner', wall, color, facing: props.facing || 'north', rotation: Number(props.rotation || 0) };
	}
	if (name === 'bell') return { kind: 'bell', layer: 'minecraft:bell#main', texture: 'bell/bell_body' };
	if (name === 'decorated_pot') return { kind: 'pot', facing: props.facing || 'north' };
	return null;
}

export const BLOCK_ENTITY_NAMES = (() => {
	const names = [...Object.keys(CHESTS), ...Object.keys(CHESTS).map(n => 'waxed_' + n), 'shulker_box', 'bell', 'decorated_pot'];
	for (const color of Object.keys(DYE)) names.push(color + '_shulker_box', color + '_banner', color + '_wall_banner');
	for (const head of Object.keys(HEADS)) names.push(head, head.replace(/_(skull|head)$/, '_wall_$1'));
	return names.map(n => 'minecraft:' + n);
})();
