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

/** Mth.clampedLerp */
const lerp01 = (t, a, b) => (t < 0 ? a : t > 1 ? b : a + (b - a) * t);

/** GuardianModel's spike positions (the rotations are part of the model). */
const SPIKE_X = [0, 0, 8, -8, -8, 8, 8, -8, 0, 0, 8, -8];
const SPIKE_Y = [-8, -8, -8, -8, 0, 0, 0, 0, 8, 8, 8, 8];
const SPIKE_Z = [8, -8, 0, 0, -8, -8, 8, 8, 8, -8, 0, 0];

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
		else if (e.pose === 'swimming' && !isAvatar(e)) p.head.xRot = -PI / 4;
	}
	if (a.swimAmount > 0) swimStroke(p, a, a.attack > 0);
	// PlayerModel.setupAnim: the skin layers the player turned off (PlayerModelPart masks), on the body model only
	if (a.isBase && isAvatar(e) && e.parts !== undefined) {
		const shown = mask => !!(e.parts & mask);
		if (p.hat) p.hat.visible = shown(64);
		if (p.jacket) p.jacket.visible = shown(2);
		if (p.left_sleeve) p.left_sleeve.visible = shown(4);
		if (p.right_sleeve) p.right_sleeve.visible = shown(8);
		if (p.left_pants) p.left_pants.visible = shown(16);
		if (p.right_pants) p.right_pants.visible = shown(32);
	}
}

/** Players and mannequins: the entities AvatarRenderer draws. */
export function isAvatar(e) {
	return e.type === 'minecraft:player' || e.type === 'minecraft:mannequin';
}

/** Poses of the equipment models drawn over a mob (CapeLayer, WingsLayer), after they took the body's pose. */
export function equipmentPose(p, e, a) {
	if (p.cape) capePose(p.cape, e, a);
	// only the elytra model: chickens, bees, parrots, bats, allays, vexes and the dragon have wings of their own
	if (p.left_wing && p.right_wing && !p.body) elytraPose(p, e, a);
}

/**
 * The client-side state of a humanoid the cape and elytra follow, stepped once per entity tick:
 * ClientAvatarState (the cloak trailing the position, bob, walk distance) and ElytraAnimationState.
 */
function avatarState(e, a) {
	const m = a.memory;
	const tick = Math.floor(a.age);
	const pos = [e.x, e.y, e.z];
	if (m.avatarTick === undefined || tick < m.avatarTick || tick - m.avatarTick > 40) {
		Object.assign(m, {
			avatarTick: tick, avatarPos: pos, cloak: [...pos], cloakO: [...pos], bob: 0, bobO: 0, walkDist: 0, walkDistO: 0,
			elytra: [PI / 12, 0, -PI / 12], elytraO: [PI / 12, 0, -PI / 12],
		});
		return m;
	}
	const steps = tick - m.avatarTick;
	const from = m.avatarPos;
	for (let i = 1; i <= steps; i++) {
		// the positions of the ticks in between, evenly spread
		const at = from.map((v, k) => v + (pos[k] - v) * i / steps);
		const move = from.map((v, k) => (pos[k] - v) / steps);
		const horizontal = Math.hypot(move[0], move[2]);
		m.walkDistO = m.walkDist;
		m.cloakO = [...m.cloak];
		for (let k = 0; k < 3; k++) {
			const d = at[k] - m.cloak[k];
			if (d > 10 || d < -10) m.cloak[k] = m.cloakO[k] = at[k];
			else m.cloak[k] += d * 0.25;
		}
		// AbstractClientPlayer.updateBob
		const onGround = Math.abs(move[1]) < 1e-3 && e.pose !== 'fall_flying';
		const tBob = onGround && !e.dead && e.pose !== 'swimming' ? Math.min(0.1, horizontal) : 0;
		m.bobO = m.bob;
		m.bob += (tBob - m.bob) * 0.4;
		m.walkDist += horizontal * 0.6;
		// ElytraAnimationState.tick
		m.elytraO = [...m.elytra];
		let target;
		if (e.pose === 'fall_flying') {
			let ratio = 1;
			const length = Math.hypot(move[0], move[1], move[2]);
			if (move[1] < 0 && length > 0) ratio = 1 - Math.pow(-move[1] / length, 1.5);
			target = [lerp(ratio, PI / 12, PI / 9), 0, lerp(ratio, -PI / 12, -PI / 2)];
		} else if (e.sneak || e.pose === 'crouching') {
			target = [PI * 2 / 9, 0.08726646, -PI / 4];
		} else {
			target = [PI / 12, 0, -PI / 12];
		}
		for (let k = 0; k < 3; k++) m.elytra[k] += (target[k] - m.elytra[k]) * 0.3;
	}
	m.avatarTick = tick;
	m.avatarPos = pos;
	return m;
}

/** AvatarRenderer.extractCapeState and PlayerCapeModel.setupAnim. */
function capePose(cape, e, a) {
	const m = avatarState(e, a);
	const partial = a.age - Math.floor(a.age);
	const dx = lerp(partial, m.cloakO[0], m.cloak[0]) - e.x;
	const dy = lerp(partial, m.cloakO[1], m.cloak[1]) - e.y;
	const dz = lerp(partial, m.cloakO[2], m.cloak[2]) - e.z;
	const body = (e.body ?? e.yaw ?? 0) * DEG;
	const forwardX = sin(body), forwardZ = -cos(body);
	const flying = e.pose === 'fall_flying' ? Math.min(1, (e.flyingTicks || 0) ** 2 / 100) : 0;
	let flap = clamp(dy * 10, -6, 32);
	const lean = clamp((dx * forwardX + dz * forwardZ) * 100 * (1 - flying), 0, 150);
	const lean2 = clamp((dx * forwardZ - dz * forwardX) * 100, -20, 20);
	flap += sin(lerp(partial, m.walkDistO, m.walkDist) * 6) * 32 * lerp(partial, m.bobO, m.bob);
	// cape.rotateBy(rotateY(-PI) rotateX(6 + lean / 2 + flap) rotateZ(lean2 / 2) rotateY(180 - lean2 / 2))
	rotateBy(cape, [[1, -PI], [0, (6 + lean / 2 + flap) * DEG], [2, lean2 / 2 * DEG], [1, (180 - lean2 / 2) * DEG]]);
}

/** ElytraModel.setupAnim with the entity's ElytraAnimationState. */
function elytraPose(p, e, a) {
	const m = avatarState(e, a);
	const partial = a.age - Math.floor(a.age);
	const [x, y, z] = m.elytra.map((v, k) => lerp(partial, m.elytraO[k], v));
	const left = p.left_wing, right = p.right_wing;
	left.y = e.sneak || e.pose === 'crouching' ? 3 : 0;
	left.xRot = x; left.zRot = z; left.yRot = y;
	right.yRot = -y; right.y = left.y; right.xRot = x; right.zRot = -z;
}

/** ModelPart.rotateBy: the part's Z*Y*X rotation times the given axis rotations, back to Z*Y*X angles. */
function rotateBy(part, rotations) {
	const axis = (i, angle) => {
		const c = cos(angle), s = sin(angle);
		if (i === 0) return [[1, 0, 0], [0, c, -s], [0, s, c]];
		if (i === 1) return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
		return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
	};
	const mul = (A, B) => A.map((row, r) => [0, 1, 2].map(c => row[0] * B[0][c] + row[1] * B[1][c] + row[2] * B[2][c]));
	let M = mul(mul(axis(2, part.zRot), axis(1, part.yRot)), axis(0, part.xRot));
	for (const [i, angle] of rotations) M = mul(M, axis(i, angle));
	// Matrix3f.getEulerAnglesZYX
	part.xRot = Math.atan2(M[2][1], M[2][2]);
	part.yRot = Math.atan2(-M[2][0], Math.sqrt(Math.max(0, 1 - M[2][0] * M[2][0])));
	part.zRot = Math.atan2(M[1][0], M[0][0]);
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

/** AnimationUtils.animateZombieArms (26.3: no bobbing of its own; a baby holding an item keeps its arms down) */
function animateZombieArms(p, a, e, aggressive) {
	const raise = !e.baby || !e.hand;
	const armDrop = raise ? -PI / (aggressive ? 1.5 : 2.25) : 0;
	const attackY = (raise ? 1 : -1) * sin(a.attack * PI);
	const attackX = sin((1 - (1 - a.attack) * (1 - a.attack)) * PI);
	const xRot = armDrop + attackY * 1.2 - attackX * 0.4;
	const yRot = 0.1 - attackY * 0.6;
	if (p.right_arm) Object.assign(p.right_arm, { xRot, yRot: raise ? -yRot : yRot, zRot: 0 });
	if (p.left_arm) Object.assign(p.left_arm, { xRot, yRot: raise ? yRot : -yRot, zRot: 0 });
}

/** ZombieModel.setupAttackAnimation, then the arms' bob that HumanoidModel.setupAnim ends with. */
function zombieArms(p, a, e, aggressive) {
	animateZombieArms(p, a, e, aggressive);
	bobArms(p, a.age);
}

const triangleWave = (t, period) => (abs(t % period - period * 0.5) - period * 0.25) / (period * 0.25);

/** Mth.rotLerpRad */
function rotLerpRad(t, from, to) {
	let delta = to - from;
	while (delta < -PI) delta += PI * 2;
	while (delta >= PI) delta -= PI * 2;
	return from + t * delta;
}

/** AnimationUtils.swingWeaponDown: side 1 for a right-handed mob. */
function swingWeaponDown(p, side, attackTime, age) {
	const R = p.right_arm, L = p.left_arm;
	if (!R || !L) return;
	const attack2 = sin(attackTime * PI);
	const attack = sin((1 - (1 - attackTime) * (1 - attackTime)) * PI);
	R.zRot = 0; L.zRot = 0;
	R.yRot = PI / 20; L.yRot = -PI / 20;
	const [main, off] = side > 0 ? [R, L] : [L, R];
	main.xRot = -1.8849558 + cos(age * 0.09) * 0.15 + attack2 * 2.2 - attack * 0.4;
	off.xRot = cos(age * 0.19) * 0.5 + attack2 * 1.2 - attack * 0.4;
	bobArms(p, age);
}

/** AnimationUtils.animateCrossbowHold (right-handed) */
function crossbowHold(p) {
	const R = p.right_arm, L = p.left_arm, head = p.head;
	if (!R || !L || !head) return;
	R.yRot = -0.3 + head.yRot;
	L.yRot = 0.6 + head.yRot;
	R.xRot = -PI / 2 + head.xRot + 0.1;
	L.xRot = -1.5 + head.xRot;
}

/** AnimationUtils.animateCrossbowCharge (right-handed) */
function crossbowCharge(p, maxCharge, ticksUsing) {
	const R = p.right_arm, L = p.left_arm;
	if (!R || !L) return;
	R.yRot = -0.8;
	R.xRot = -0.97079635;
	L.xRot = R.xRot;
	const alpha = clamp(ticksUsing, 0, maxCharge) / maxCharge;
	L.yRot = lerp(alpha, 0.4, 0.85);
	L.xRot = lerp(alpha, L.xRot, -PI / 2);
}

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
		zombieArms(p, a, e, !!(e.d && e.d.aggressive));
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
	/** IllagerModel.setupAnim with IllagerRenderer's state (the illager's own arm pose, AbstractIllager.getArmPose). */
	illager(p, a, e) {
		const d = e.d || {};
		const R = p.right_arm, L = p.left_arm, head = p.head;
		if (head) { head.yRot = a.netHeadYaw * DEG; head.xRot = a.headPitch * DEG; }
		const legs = (xr, yr, zr, xl, yl, zl) => {
			if (p.right_leg) Object.assign(p.right_leg, { xRot: xr, yRot: yr, zRot: zr });
			if (p.left_leg) Object.assign(p.left_leg, { xRot: xl, yRot: yl, zRot: zl });
		};
		if (e.riding) {
			if (R) Object.assign(R, { xRot: -PI / 5, yRot: 0, zRot: 0 });
			if (L) Object.assign(L, { xRot: -PI / 5, yRot: 0, zRot: 0 });
			legs(-1.4137167, PI / 10, 0.07853982, -1.4137167, -PI / 10, -0.07853982);
		} else {
			const w = a.walk * 0.6662, s = a.walkSpeed;
			if (R) Object.assign(R, { xRot: cos(w + PI) * 2 * s * 0.5, yRot: 0, zRot: 0 });
			if (L) Object.assign(L, { xRot: cos(w) * 2 * s * 0.5, yRot: 0, zRot: 0 });
			legs(cos(w) * 1.4 * s * 0.5, 0, 0, cos(w + PI) * 1.4 * s * 0.5, 0, 0);
		}
		const pose = d.armPose || (e.hand ? 'neutral' : 'crossed');
		if (R && L) {
			if (pose === 'attacking') {
				if (!e.hand) {
					animateZombieArms(p, a, e, true);
					bobArms(p, a.age);
				} else {
					swingWeaponDown(p, d.mainArm === 'left' ? -1 : 1, a.attack, a.age);
				}
			} else if (pose === 'spellcasting') {
				const swing = cos(a.age * 0.6662) * 0.25;
				Object.assign(R, { z: 0, x: -5, xRot: swing, zRot: PI * 3 / 4, yRot: 0 });
				Object.assign(L, { z: 0, x: 5, xRot: swing, zRot: -PI * 3 / 4, yRot: 0 });
			} else if (pose === 'bow_and_arrow' && head) {
				R.yRot = -0.1 + head.yRot;
				R.xRot = -PI / 2 + head.xRot;
				L.xRot = -0.9424779 + head.xRot;
				L.yRot = head.yRot - 0.4;
				L.zRot = PI / 2;
			} else if (pose === 'crossbow_hold') {
				crossbowHold(p);
			} else if (pose === 'crossbow_charge') {
				crossbowCharge(p, Number(d.chargeTicks) || 25, Number(d.useTicks) || 0);
			} else if (pose === 'celebrating') {
				const wave = cos(a.age * 0.6662) * 0.05;
				Object.assign(R, { z: 0, x: -5, xRot: wave, zRot: 2.670354, yRot: 0 });
				Object.assign(L, { z: 0, x: 5, xRot: wave, zRot: -PI * 3 / 4, yRot: 0 });
			}
		}
		const crossed = pose === 'crossed';
		if (p.arms) p.arms.visible = crossed;
		if (L) L.visible = !crossed;
		if (R) R.visible = !crossed;
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
	/** ChickenModel / AdultChickenModel.setupAnim: legs, and the wings flapping while it falls (Chicken.flap) */
	chicken(p, a, e) {
		headLook(p, a);
		if (p.beak) { p.beak.yRot = p.head ? p.head.yRot : 0; }
		const w = a.walk * 0.6662, s = a.walkSpeed;
		if (p.right_leg) p.right_leg.xRot = cos(w) * 1.4 * s;
		if (p.left_leg) p.left_leg.xRot = cos(w + PI) * 1.4 * s;
		const d = e.d || {};
		const flap = (sin(Number(d.flap) || 0) + 1) * (Number(d.flapSpeed) || 0);
		if (p.right_wing) p.right_wing.zRot = flap;
		if (p.left_wing) p.left_wing.zRot = -flap;
	},
	/**
	 * AbstractEquineModel.setupAnim (HorseModel, DonkeyModel and their baby models) with AbstractHorseRenderer's
	 * state: rearing (getStandAnim), grazing (getEatAnim), the mouth (getMouthAnim) and the swishing tail.
	 */
	horse(p, a, e) {
		const d = e.d || {};
		const head = p.head_parts, body = p.body, tail = p.tail;
		const lh = p.left_hind_leg, rh = p.right_hind_leg, lf = p.left_front_leg, rf = p.right_front_leg;
		const donkey = /(donkey|mule)$/.test(e.type || '');
		const babyDonkey = donkey && e.baby, babyHorse = !donkey && e.baby;
		const clampedYRot = clamp(a.netHeadYaw, -20, 20);
		const speed = a.walkSpeed, pos = a.walk;
		let headRotX = a.headPitch * DEG;
		if (speed > 0.2) headRotX += cos(pos * 0.8) * 0.15 * speed;
		const eating = Number(d.eat) || 0, standing = Number(d.stand) || 0, iStanding = 1 - standing;
		const feeding = Number(d.mouth) || 0;
		const legAnim1 = cos((d.inWater ? 0.2 : 1) * pos * 0.6662 + PI);
		const legX = legAnim1 * 0.8 * speed;
		const baseAngle = headX => (1 - Math.max(standing, eating)) * (PI / 6 + headX + feeding * sin(a.age) * 0.05);
		if (head) {
			head.yRot = clampedYRot * DEG;
			head.xRot = standing * (PI / 12 + headRotX) + eating * (2.1816616 + sin(a.age) * 0.05) + baseAngle(headRotX);
			head.yRot = standing * clampedYRot * DEG + (1 - Math.max(standing, eating)) * head.yRot;
			// animateHeadPartsPlacement
			if (babyDonkey) {
				head.y = lerp(eating, head.y, -1.2);
				head.z = lerp(standing, head.z, -3.6);
			} else {
				head.y += lerp(eating, lerp(standing, 0, babyHorse ? -2 : -8), babyHorse ? 2 : 7);
				head.z = lerp(standing, head.z, -4);
			}
		}
		if (body) body.xRot = standing * (-PI / 4) + iStanding * body.xRot;
		const standY = babyDonkey ? 1 : babyHorse ? 4 : 12, standZ = babyDonkey ? 0.5 : babyHorse ? 0 : 4;
		if (lf) {
			lf.y -= standY * standing;
			lf.z += standZ * standing;
			if (rf) { rf.y = lf.y; rf.z = lf.z; }
		}
		const standAngle = (babyDonkey ? PI / 3 : PI / 12) * standing;
		const bob = cos(a.age * 0.6 + PI);
		const xOffset = babyDonkey ? 0 : -PI / 3;
		if (lh) lh.xRot = standAngle - legAnim1 * 0.5 * speed * iStanding;
		if (rh) rh.xRot = standAngle + legAnim1 * 0.5 * speed * iStanding;
		if (lf) lf.xRot = (xOffset + bob) * standing + legX * iStanding;
		if (rf) rf.xRot = (xOffset - bob) * standing - legX * iStanding;
		if (babyDonkey && lh && rh) {
			// BabyDonkeyModel.offsetLegPositionWhenStanding
			lh.y = lerp(standing, lh.y, -0.3);
			rh.y = lerp(standing, lh.y, -0.3);
		}
		const ageScale = e.baby ? 0.5 : 1;
		if (tail) {
			tail.xRot = (babyDonkey ? -PI / 4 : babyHorse ? -PI / 2 : 0) + PI / 6 + speed * 0.75;
			tail.y += speed * ageScale;
			tail.z += speed * 2 * ageScale;
			tail.yRot = d.tail > 0 ? cos(a.age * 0.7) : 0;
		}
		if (babyDonkey && head) {
			// BabyDonkeyModel.setupAnim: the head keeps looking 30 degrees up
			const headX = -30 * DEG;
			head.xRot = standing * (PI / 12 + headX) + eating * (PI / 2 + sin(a.age) * 0.05) + baseAngle(headX);
		}
		const chest = !!d.chest;
		if (p.left_chest) p.left_chest.visible = chest;
		if (p.right_chest) p.right_chest.visible = chest;
	},
	/**
	 * FoxModel.setupAnim with the AdultFoxModel / BabyFoxModel poses: sitting, sleeping, crouching to stalk
	 * (FoxRenderState.crouchAmount), pouncing, face-planted in snow and the head tilt of an interested fox.
	 */
	fox(p, a, e) {
		const d = e.d || {};
		const { head, body, tail } = p;
		const rh = p.right_hind_leg, lh = p.left_hind_leg, rf = p.right_front_leg, lf = p.left_front_leg;
		if (!head || !body || !rh || !lh || !rf || !lf) return;
		const baby = !!e.baby, ageScale = baby ? 0.5 : 1;
		const crouch = Number(d.crouch) || 0;
		// setWalkingPose
		head.zRot = Number(d.headRoll) || 0;
		if (baby) {
			if (a.k && a.k.has('FoxBabyAnimation.FOX_BABY_WALK')) a.k.walk('FoxBabyAnimation.FOX_BABY_WALK', a.walk, a.walkSpeed, 1, 2.5);
		} else {
			const w = a.walk * 0.6662, s = a.walkSpeed;
			rh.xRot = cos(w) * 1.4 * s;
			lh.xRot = cos(w + PI) * 1.4 * s;
			rf.xRot = cos(w + PI) * 1.4 * s;
			lf.xRot = cos(w) * 1.4 * s;
		}
		if (d.crouching) {
			body.xRot += 0.10471976;
			head.y += crouch * ageScale;
			const wiggle = cos(a.age) * 0.05;
			body.yRot = wiggle;
			rh.zRot = wiggle; lh.zRot = wiggle;
			rf.zRot = wiggle / 2; lf.zRot = wiggle / 2;
			body.y += baby ? crouch / 6 : crouch;
		} else if (d.sleeping) {
			rh.visible = lh.visible = rf.visible = lf.visible = false;
			body.zRot = -PI / 2;
			if (baby) {
				body.xRot = -PI / 18;
				body.y++; body.z--; body.x--;
				if (tail) { tail.xRot = -2.1816616; tail.x -= 0.7; tail.z += 0.6; tail.y += 0.9; }
				head.x -= 2; head.y += 2.8; head.z -= 4;
			} else {
				body.y += 5;
				if (tail) tail.xRot = -PI * 5 / 6;
				head.x += 2; head.y += 2.99;
			}
			head.yRot = -PI * 2 / 3;
			head.zRot = 0;
		} else if (d.sitting) {
			head.xRot = 0; head.yRot = 0;
			if (baby) {
				body.xRot = -0.959931;
				body.z -= 4.5 * ageScale; body.y += 3 * ageScale;
				if (tail) { tail.y -= 0.6; tail.z -= 2 * ageScale; tail.xRot = 0.95993114; }
				head.y -= 0.75;
				rf.xRot = lf.xRot = -PI / 12;
				rf.z--; lf.z--; rf.x += 0.01; lf.x -= 0.01;
				rh.z -= 3.75; lh.z -= 3.75; rh.x += 0.01; lh.x -= 0.01;
			} else {
				body.xRot = PI / 6;
				body.y -= 7; body.z += 3;
				if (tail) { tail.xRot = PI / 4; tail.z--; }
				head.y -= 6.5; head.z += 2.75;
				rf.xRot = lf.xRot = -PI / 12;
				rh.xRot = lh.xRot = -PI * 5 / 12;
				rh.y += 4; rh.z -= 0.25; lh.y += 4; lh.z -= 0.25;
			}
		}
		if (d.pouncing && !baby) {
			body.y -= crouch / 2;
			head.y -= crouch / 2;
		}
		if (!d.sleeping && !d.faceplanted && !d.crouching) {
			head.xRot = a.headPitch * DEG;
			head.yRot = a.netHeadYaw * DEG;
		}
		if (d.sleeping) {
			head.xRot = 0;
			head.yRot = -PI * 2 / 3;
			head.zRot = cos(a.age * 0.027) / 22;
		}
		if (d.faceplanted) {
			// legMotionPos grows every frame the model is drawn
			const m = a.memory;
			m.legMotion = (m.legMotion || 0) + 0.67;
			rh.xRot = cos(m.legMotion * 0.4662) * 0.1;
			lh.xRot = cos(m.legMotion * 0.4662 + PI) * 0.1;
			rf.xRot = cos(m.legMotion * 0.4662 + PI) * 0.1;
			lf.xRot = cos(m.legMotion * 0.4662) * 0.1;
		}
	},
	/** PandaModel.setupAnim (BabyPandaModel's sitting) with PandaRenderer's state. */
	panda(p, a, e) {
		const d = e.d || {};
		headLook(p, a);
		quadrupedLegs(p, a);
		const { head, body } = p;
		const rh = p.right_hind_leg, lh = p.left_hind_leg, rf = p.right_front_leg, lf = p.left_front_leg;
		if (!head || !body || !rh || !lh || !rf || !lf) return;
		const age = a.age;
		if (d.unhappy > 0) {
			head.yRot = 0.35 * sin(0.6 * age);
			head.zRot = 0.35 * sin(0.6 * age);
			rf.xRot = -0.75 * sin(0.3 * age);
			lf.xRot = 0.75 * sin(0.3 * age);
		} else {
			head.zRot = 0;
		}
		if (d.sneezing) {
			const time = Math.floor(Number(d.sneeze) || 0);
			if (time < 15) head.xRot = -PI / 4 * time / 14;
			else if (time < 20) head.xRot = -PI / 4 + PI / 4 * Math.trunc((time - 15) / 5);
		}
		const sit = Number(d.sit) || 0;
		if (sit > 0) {
			if (e.baby) {
				body.xRot = rotLerpRad(sit, body.xRot, PI / 18);
				body.z = lerp(sit, body.z, -1.5);
				head.z = lerp(sit, head.z, -11.5);
				head.y = lerp(sit, head.y, 17.5);
				rf.z = lerp(sit, rf.z, -5); lf.z = lerp(sit, lf.z, -5);
				rh.z = lerp(sit, rh.z, 3); lh.z = lerp(sit, lh.z, 3);
			} else {
				body.xRot = rotLerpRad(sit, body.xRot, 1.7407963);
				head.xRot = rotLerpRad(sit, head.xRot, PI / 2);
			}
			rf.zRot = -0.27079642; lf.zRot = 0.27079642;
			rh.zRot = 0.5707964; lh.zRot = -0.5707964;
			if (d.eating) {
				head.xRot = PI / 2 + 0.2 * sin(age * 0.6);
				rf.xRot = lf.xRot = -0.4 - 0.2 * sin(age * 0.6);
			}
			if (d.scared) {
				head.xRot = 2.1707964;
				rf.xRot = lf.xRot = -0.9;
			}
		} else {
			rh.zRot = lh.zRot = rf.zRot = lf.zRot = 0;
		}
		const onBack = Number(d.onBack) || 0;
		if (onBack > 0) {
			rh.xRot = -0.6 * sin(age * 0.15);
			lh.xRot = 0.6 * sin(age * 0.15);
			rf.xRot = 0.3 * sin(age * 0.25);
			lf.xRot = -0.3 * sin(age * 0.25);
			head.xRot = rotLerpRad(onBack, head.xRot, PI / 2);
		}
		const roll = e.baby ? 0 : Number(d.rollAmount) || 0;
		if (roll > 0) {
			head.xRot = rotLerpRad(roll, head.xRot, 2.0561945);
			rh.xRot = -0.5 * sin(age * 0.5);
			lh.xRot = 0.5 * sin(age * 0.5);
			rf.xRot = 0.5 * sin(age * 0.5);
			lf.xRot = -0.5 * sin(age * 0.5);
		}
	},
	llama(p, a, e) {
		headLook(p, a);
		quadrupedLegs(p, a);
		const chest = !!(e.d && e.d.chest);
		if (p.left_chest) p.left_chest.visible = chest;
		if (p.right_chest) p.right_chest.visible = chest;
	},
	/** WolfModel, AdultWolfModel and BabyWolfModel.setupAnim with the WolfRenderer state (shaking off water: event 8). */
	wolf(p, a, e) {
		const d = e.d || {};
		const ageScale = e.baby ? 0.5 : 1;
		const w = a.walk * 0.6662, s = a.walkSpeed;
		const { tail, body } = p;
		if (tail) tail.yRot = d.angry ? 0 : cos(w) * 1.4 * s;
		if (d.sitting) {
			// WolfModel.setSittingPose
			if (body) { body.y += 4 * ageScale; body.z -= 2 * ageScale; body.xRot = PI / 4; }
			if (tail) { tail.y += 9 * ageScale; tail.z -= 2 * ageScale; }
			for (const leg of [p.right_hind_leg, p.left_hind_leg]) if (leg) { leg.y += 6.7 * ageScale; leg.z -= 5 * ageScale; leg.xRot = PI * 3 / 2; }
			if (p.right_front_leg) { p.right_front_leg.xRot = 5.811947; p.right_front_leg.x += 0.01 * ageScale; p.right_front_leg.y += ageScale; }
			if (p.left_front_leg) { p.left_front_leg.xRot = 5.811947; p.left_front_leg.x -= 0.01 * ageScale; p.left_front_leg.y += ageScale; }
			if (e.baby) { if (body) body.xRot -= 1; }
			else if (p.upper_body) { p.upper_body.y += 2; p.upper_body.xRot = PI * 2 / 5; p.upper_body.yRot = 0; }
		} else {
			if (p.right_hind_leg) p.right_hind_leg.xRot = cos(w) * 1.4 * s;
			if (p.left_hind_leg) p.left_hind_leg.xRot = cos(w + PI) * 1.4 * s;
			if (p.right_front_leg) p.right_front_leg.xRot = cos(w + PI) * 1.4 * s;
			if (p.left_front_leg) p.left_front_leg.xRot = cos(w) * 1.4 * s;
		}
		// shakeOffWater: WolfRenderState.getBodyRollAngle with Wolf.getShakeAnim, the head roll of a begging wolf
		const m = a.memory;
		const shake = m.shakeAt !== undefined ? Math.max(0, (a.age - m.shakeAt) * 0.05) : 0;
		const roll = offset => {
			const progress = Math.min(1, Math.max(0, (shake + offset) / 1.8));
			return sin(progress * PI) * sin(progress * PI * 11) * 0.15 * PI;
		};
		const partial = a.age - Math.floor(a.age);
		const headRoll = ((m.interestO ?? 0) + ((m.interest ?? 0) - (m.interestO ?? 0)) * partial) * 0.15 * PI;
		if (body) body.zRot = roll(-0.16);
		if (e.baby) {
			if (p.head) p.head.zRot = headRoll + roll(0);
			if (tail) tail.zRot = roll(-0.2);
		} else {
			if (p.real_head) p.real_head.zRot = headRoll + roll(0);
			if (p.upper_body) p.upper_body.zRot = roll(-0.08);
			if (p.real_tail) p.real_tail.zRot = roll(-0.2);
		}
		if (p.head) { p.head.xRot = a.headPitch * DEG; p.head.yRot = a.netHeadYaw * DEG; }
		// Wolf.getTailAngle
		let tailAngle = PI / 5;
		if (d.angry) tailAngle = 1.5393804;
		else if (d.tame) tailAngle = (0.55 - (d.maxHealth > 0 ? (d.maxHealth - (d.health ?? d.maxHealth)) / d.maxHealth : 0) * 0.4) * PI;
		if (tail) tail.xRot = tailAngle;
		// WolfRenderer.getModelTint: Wolf.getWetShade while shaking
		if (shake > 0) {
			const shade = Math.min(0.75 + shake / 2 * 0.25, 1);
			a.tint = [shade, shade, shade, 1];
		}
	},
	/**
	 * AdultFelineModel / BabyFelineModel.setupAnim (cats and ocelots): sneaking and sprinting with the tail, sitting,
	 * lying down next to a sleeping player (Cat.getLieDownAmount) and the relaxed head.
	 */
	cat(p, a, e) {
		const d = e.d || {};
		const { head, body, tail1, tail2 } = p;
		const lh = p.left_hind_leg, rh = p.right_hind_leg, lf = p.left_front_leg, rf = p.right_front_leg;
		if (!head || !body || !lh || !rh || !lf || !rf) return;
		const baby = !!e.baby, ageScale = baby ? 0.5 : 1;
		const crouching = e.pose === 'crouching' || !!e.sneak, sprinting = !!d.sprinting, sitting = !!d.sitting;
		if (crouching) {
			body.y += ageScale;
			head.y += 2 * ageScale;
			if (tail1) { tail1.y += ageScale; tail1.xRot = PI / 2; }
			if (tail2) { tail2.y -= 4 * ageScale; tail2.z += 2 * ageScale; tail2.xRot = PI / 2; }
		} else if (sprinting && tail1 && tail2) {
			tail2.y = tail1.y;
			tail2.z += 2 * ageScale;
			tail1.xRot = PI / 2;
			tail2.xRot = PI / 2;
		}
		head.xRot = a.headPitch * DEG;
		head.yRot = a.netHeadYaw * DEG;
		if (!sitting) {
			if (!baby) body.xRot = PI / 2;
			const s = a.walkSpeed, w = a.walk * 0.6662;
			lh.xRot = cos(w) * s;
			if (sprinting) {
				rh.xRot = cos(w + 0.3) * s;
				lf.xRot = cos(w + PI + 0.3) * s;
				rf.xRot = cos(w + PI) * s;
				if (tail2) tail2.xRot = 1.7278761 + PI / 10 * cos(a.walk) * s;
			} else {
				rh.xRot = cos(w + PI) * s;
				lf.xRot = cos(w + PI) * s;
				rf.xRot = cos(w) * s;
				if (tail2) tail2.xRot = 1.7278761 + (crouching ? 0.47123894 : PI / 4) * cos(a.walk) * s;
			}
		} else if (baby) {
			body.xRot += -0.43633232;
			body.y++;
			head.z += 0.75;
			if (tail1) { tail1.xRot += 0.5454154; tail1.y += 4; tail1.z -= 0.9; }
			lh.z -= 0.9;
			rh.z -= 0.9;
		} else {
			body.xRot = PI / 4;
			body.y -= 4 * ageScale; body.z += 5 * ageScale;
			head.y -= 3.3 * ageScale; head.z += ageScale;
			if (tail1) { tail1.y += 8 * ageScale; tail1.z -= 2 * ageScale; tail1.xRot = 1.7278761; }
			if (tail2) { tail2.y += 2 * ageScale; tail2.z -= 0.8 * ageScale; tail2.xRot = 2.670354; }
			for (const leg of [lf, rf]) { leg.xRot = -PI / 20; leg.y += 2 * ageScale; leg.z -= 2 * ageScale; }
			for (const leg of [lh, rh]) { leg.xRot = -PI / 2; leg.y += 3 * ageScale; leg.z -= 4 * ageScale; }
		}
		const lie = Number(d.lie) || 0, lieTail = Number(d.lieTail) || 0;
		// Mth.rotLerp (degrees, used on radians: a plain lerp at these angles)
		const rotLerp = (t, from, to) => from + t * (to - from);
		if (lie > 0) {
			if (baby) {
				body.x++;
				head.xRot = rotLerp(lie, head.xRot, PI / 18);
				head.zRot = rotLerp(lie, head.zRot, -PI * 5 / 12);
				head.x++; head.y += 0.75; head.z -= 0.5;
				rf.xRot = -PI / 4; rf.x += 3.5; rf.y -= 0.5;
				lf.xRot = -PI / 2; lf.x++; lf.y--; lf.z -= 2;
				rh.xRot = PI * 2 / 9; rh.yRot = PI / 9; rh.zRot = -PI / 9; rh.x += 2.5; rh.y -= 0.25; rh.z += 0.5;
				lh.x++; lh.z--;
				if (tail1) {
					tail1.xRot += rotLerp(lieTail, tail1.xRot, -PI / 6);
					tail1.yRot += rotLerp(lieTail, tail1.yRot, 0);
					tail1.zRot += rotLerp(lieTail, tail1.zRot, -PI / 18);
					tail1.x++; tail1.y += 0.5; tail1.z -= 0.25;
				}
			} else {
				head.zRot = rotLerp(lie, head.zRot, -1.2707963);
				head.yRot = rotLerp(lie, head.yRot, 1.2707963);
				lf.xRot = -1.2707963;
				rf.xRot = -0.47079635; rf.zRot = -0.2; rf.x += ageScale;
				lh.xRot = -0.4;
				rh.xRot = 0.5; rh.zRot = -0.5; rh.x += 0.8 * ageScale; rh.y += 2 * ageScale;
				if (tail1) tail1.xRot = rotLerp(lieTail, tail1.xRot, 0.8);
				if (tail2) tail2.xRot = rotLerp(lieTail, tail2.xRot, -0.4);
			}
		}
		const relax = Number(d.relax) || 0;
		if (relax > 0) head.xRot = rotLerp(relax, head.xRot, -0.58177644);
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
	/** BeeModel.setupAnim: wings and tucked legs in flight, the idle bob, the stinger, rolling over (Bee.getRollAmount) */
	bee(p, a, e) {
		const d = e.d || {};
		if (p.stinger) p.stinger.visible = !d.stung;
		const legs = [p.front_legs || p.front_leg, p.middle_legs || p.mid_leg, p.back_legs || p.back_leg];
		if (!d.onGround) {
			const flap = cos(a.age * 120.32113 * DEG) * PI * 0.15;
			if (p.right_wing) { p.right_wing.yRot = 0; p.right_wing.zRot = flap; }
			if (p.left_wing) { p.left_wing.xRot = p.right_wing ? p.right_wing.xRot : 0; p.left_wing.yRot = 0; p.left_wing.zRot = -flap; }
			for (const leg of legs) if (leg) leg.xRot = PI / 4;
		}
		if (!d.angry && !d.onGround && p.bone) {
			const speed = cos(a.age * 0.18);
			p.bone.xRot = 0.1 + speed * PI * 0.025;
			p.bone.y -= cos(a.age * 0.18) * 0.9;
			if (legs[0]) legs[0].xRot = -speed * PI * 0.1 + PI / 8;
			if (legs[2]) legs[2].xRot = -speed * PI * 0.05 + PI / 4;
		}
		const roll = Number(d.rollAmount) || 0;
		if (roll > 0 && p.bone) p.bone.xRot = rotLerpRad(roll, p.bone.xRot, 3.0915928);
	},
	flyer(p, a) {
		headLook(p, a);
		const flap = cos(a.age * 20 * DEG) * PI * 0.15;
		if (p.right_wing) { p.right_wing.yRot = 0.47123894 + flap; }
		if (p.left_wing) { p.left_wing.yRot = -0.47123894 - flap; }
	},
	/**
	 * ParrotModel.setupAnim with its poses (ParrotModel.getPose): PARTY next to a jukebox playing a song
	 * (entities.js partyParrot), SITTING, FLYING while off the ground, else STANDING; ParrotRenderer's flap angle
	 * is (sin(flap) + 1) * flapSpeed of Parrot.calculateFlapping.
	 */
	parrot(p, a, e) {
		const { head, body, tail, left_wing: lw, right_wing: rw, left_leg: ll, right_leg: rl } = p;
		if (!head || !body || !tail || !lw || !rw || !ll || !rl) return;
		const d = e.d || {};
		const pose = a.party ? 'party' : d.sitting ? 'sitting' : !d.onGround ? 'flying' : 'standing';
		const flapAngle = (sin(Number(d.flap) || 0) + 1) * (Number(d.flapSpeed) || 0);
		// prepare
		if (pose === 'flying') {
			ll.xRot += PI * 2 / 9;
			rl.xRot += PI * 2 / 9;
		} else if (pose === 'sitting') {
			head.y++;
			tail.xRot += PI / 6;
			tail.y++;
			body.y++;
			lw.zRot = -0.0873;
			lw.y++;
			rw.zRot = 0.0873;
			rw.y++;
			ll.y++;
			rl.y++;
			ll.xRot++;
			rl.xRot++;
		} else if (pose === 'party') {
			ll.zRot = -PI / 9;
			rl.zRot = PI / 9;
		}
		head.xRot = a.headPitch * DEG;
		head.yRot = a.netHeadYaw * DEG;
		const w = a.walk * 0.6662, s = a.walkSpeed;
		if (pose === 'standing') {
			ll.xRot += cos(w) * 1.4 * s;
			rl.xRot += cos(w + PI) * 1.4 * s;
		}
		if (pose === 'standing' || pose === 'flying') {
			const bob = flapAngle * 0.3;
			head.y += bob;
			tail.xRot += cos(w) * 0.3 * s;
			tail.y += bob;
			body.y += bob;
			lw.zRot = -0.0873 - flapAngle;
			lw.y += bob;
			rw.zRot = 0.0873 + flapAngle;
			rw.y += bob;
			ll.y += bob;
			rl.y += bob;
		} else if (pose === 'party') {
			// the dance: everything but the legs goes round in a circle, the head tilting from side to side
			const x = cos(a.age), y = sin(a.age);
			head.x += x;
			head.y += y;
			head.xRot = 0;
			head.yRot = 0;
			head.zRot = sin(a.age) * 0.4;
			body.x += x;
			body.y += y;
			lw.zRot = -0.0873 - flapAngle;
			lw.x += x;
			lw.y += y;
			rw.zRot = 0.0873 + flapAngle;
			rw.x += x;
			rw.y += y;
			tail.x += x;
			tail.y += y;
		}
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
	/**
	 * IronGolemModel.setupAnim; the attack swing starts with entity event 4 (CLIENT.iron_golem), the right arm
	 * holds out a poppy while the golem offers it (IronGolem.offerFlowerTick, IronGolemFlowerLayer).
	 */
	golem(p, a, e) {
		headLook(p, a);
		const s = a.walkSpeed;
		// IronGolemRenderer.extractRenderState: attackAnimationTick - partialTicks
		const attack = a.memory.attackAt !== undefined ? 9 - (a.age - a.memory.attackAt) : 0;
		const flower = Number(e.d && e.d.flower) || 0;
		if (attack > 0) {
			if (p.right_arm) p.right_arm.xRot = -2 + 1.5 * triangleWave(attack, 10);
			if (p.left_arm) p.left_arm.xRot = -2 + 1.5 * triangleWave(attack, 10);
		} else if (flower > 0) {
			if (p.right_arm) p.right_arm.xRot = -0.8 + 0.025 * triangleWave(flower, 70);
			if (p.left_arm) p.left_arm.xRot = 0;
		} else {
			if (p.right_arm) p.right_arm.xRot = (-0.2 + 1.5 * triangleWave(a.walk, 13)) * s;
			if (p.left_arm) p.left_arm.xRot = (-0.2 - 1.5 * triangleWave(a.walk, 13)) * s;
		}
		if (p.right_leg) p.right_leg.xRot = -1.5 * triangleWave(a.walk, 13) * s;
		if (p.left_leg) p.left_leg.xRot = 1.5 * triangleWave(a.walk, 13) * s;
	},
	/** SheepModel.setupAnim with Sheep.getHeadEatPositionScale / getHeadEatAngleScale (eating grass: entity event 10). */
	sheep(p, a, e) {
		headLook(p, a);
		quadrupedLegs(p, a);
		const at = a.memory.eatAt;
		if (at === undefined || !p.head) return;
		const partial = a.age - Math.floor(a.age);
		const tick = 39 - (Math.floor(a.age) - at); // eatAnimationTick, counted down by Sheep.aiStep
		if (tick <= 0) return;
		const position = tick >= 4 && tick <= 36 ? 1 : tick < 4 ? (tick - partial) / 4 : -(tick - 40 - partial) / 4;
		p.head.y += position * 9 * (e.baby ? 0.5 : 1);
		p.head.xRot = tick > 4 && tick <= 36 ? PI / 5 + 0.21991149 * sin((tick - 4 - partial) / 32 * 28.7) : PI / 5;
	},
	/** RavagerModel.setupAnim: attack (event 4), stun (event 39) and the roar that follows it. */
	ravager(p, a) {
		const m = a.memory, age = a.age;
		const attack = m.attackAt !== undefined ? 9 - (age - m.attackAt) : 0;
		const stunned = m.stunAt !== undefined ? 39 - (age - m.stunAt) : 0;
		// Ravager.aiStep: the roar (roarTick = 20) starts when the stun ends; RavagerRenderer: (20 - roarTick + partial) / 20
		const sinceRoar = m.stunAt !== undefined ? age - (m.stunAt + 39) : -1;
		const roar = sinceRoar > 0 && sinceRoar < 20 ? sinceRoar / 20 : 0;
		const neck = p.neck, mouth = p.mouth;
		if (neck && mouth) {
			if (attack > 0) {
				const scaled = (1 + triangleWave(attack, 10)) * 0.5;
				const headPos = scaled * scaled * scaled * 12;
				neck.z = -6.5 + headPos;
				neck.y = -7 - headPos * sin(neck.xRot);
				mouth.xRot = attack > 5 ? sin((-4 + attack) / 4) * PI * 0.4 : PI / 20 * sin(PI * attack / 10);
			} else {
				neck.x = 0;
				neck.y = -7 + sin(neck.xRot);
				neck.z = 5.5;
				const isStunned = stunned > 0;
				neck.xRot = isStunned ? 0.21991149 : 0;
				mouth.xRot = PI * (isStunned ? 0.05 : 0.01);
				if (isStunned) neck.x = sin(stunned / 40 * 10) * 3;
				else if (roar > 0) mouth.xRot = PI / 2 * sin(roar * PI * 0.25);
			}
		}
		headLook(p, a);
		const w = a.walk * 0.6662, legRot = 0.4 * a.walkSpeed;
		if (p.right_hind_leg) p.right_hind_leg.xRot = cos(w) * legRot;
		if (p.left_hind_leg) p.left_hind_leg.xRot = cos(w + PI) * legRot;
		if (p.right_front_leg) p.right_front_leg.xRot = cos(w + PI) * legRot;
		if (p.left_front_leg) p.left_front_leg.xRot = cos(w) * legRot;
	},
	/** HoglinModel / BabyHoglinModel.setupAnim (hoglin and zoglin): ears, the headbutt (event 4) and legs. */
	hoglin(p, a, e) {
		const s = a.walkSpeed, w = a.walk;
		if (p.right_ear) p.right_ear.zRot = -PI * 2 / 9 - s * sin(w);
		if (p.left_ear) p.left_ear.zRot = PI * 2 / 9 + s * sin(w);
		if (p.head) p.head.yRot = a.netHeadYaw * DEG;
		const at = a.memory.attackAt;
		const remaining = at !== undefined ? Math.max(0, 9 - (Math.floor(a.age) - at)) : 0;
		const f = 1 - abs(10 - 2 * remaining) / 10;
		if (p.head) p.head.xRot = 0.87266463 + (-PI / 9 - 0.87266463) * f;
		if (e.baby && p.head) p.head.y += f * 2.5; // BabyHoglinModel.animateHeadbutt
		if (p.right_front_leg) p.right_front_leg.xRot = cos(w) * 1.2 * s;
		if (p.left_front_leg) p.left_front_leg.xRot = cos(w + PI) * 1.2 * s;
		if (p.right_hind_leg && p.left_front_leg) p.right_hind_leg.xRot = p.left_front_leg.xRot;
		if (p.left_hind_leg && p.right_front_leg) p.left_hind_leg.xRot = p.right_front_leg.xRot;
	},
	/** GoatModel / BabyGoatModel.setupAnim: horns and ramming (Goat.getRammingXHeadRot, events 58/59). */
	goat(p, a, e) {
		headLook(p, a);
		quadrupedLegs(p, a);
		const d = e.d || {};
		const head = p.head;
		if (p.left_horn) p.left_horn.visible = d.leftHorn !== false;
		if (p.right_horn) p.right_horn.visible = d.rightHorn !== false;
		const lower = a.memory.lowerHeadTick || 0;
		if (head && lower > 0) head.xRot = lower / 20 * (e.baby ? 52.5 : 30) * DEG;
		else if (head && e.baby) head.xRot = PI / 8; // BabyGoatModel.setupAnim
	},
	/**
	 * CodModel, TropicalFish(Small|Large)Model, TadpoleModel and SalmonModel: the tail beats harder out of water;
	 * PufferfishModels: the fins paddle.
	 */
	fish(p, a, e) {
		const water = !!(e.d && e.d.inWater);
		const type = (e.type || '').replace('minecraft:', '');
		if (type === 'salmon') {
			if (p.body_back) p.body_back.yRot = -(water ? 1 : 1.3) * 0.25 * sin((water ? 1 : 1.7) * 0.6 * a.age);
			return;
		}
		const amplitude = water ? 1 : 1.5;
		if (type === 'tadpole') {
			if (p.tail) p.tail.yRot = -amplitude * 0.25 * sin(0.3 * a.age);
			return;
		}
		const tail = p.tail_fin || p.tail;
		if (tail) tail.yRot = -amplitude * 0.45 * sin(0.6 * a.age);
	},
	pufferfish(p, a) {
		const right = p.right_blue_fin || p.right_fin, left = p.left_blue_fin || p.left_fin;
		if (right) right.zRot = -0.2 + 0.4 * sin(a.age * 0.2);
		if (left) left.zRot = 0.2 - 0.4 * sin(a.age * 0.2);
	},
	/** DolphinModel.setupAnim */
	dolphin(p, a) {
		const { body } = p;
		if (!body) return;
		body.xRot = a.headPitch * DEG;
		body.yRot = a.netHeadYaw * DEG;
		if (a.walkSpeed > 0.01) {
			body.xRot += -0.05 - 0.05 * cos(a.age * 0.3);
			if (p.tail) p.tail.xRot = -0.1 * cos(a.age * 0.3);
			if (p.tail_fin) p.tail_fin.xRot = -0.2 * cos(a.age * 0.3);
		}
	},
	/** TurtleModel / AdultTurtleModel.setupAnim: walking on land (faster flippers while laying eggs), swimming */
	turtle(p, a, e) {
		const d = e.d || {};
		headLook(p, a);
		quadrupedLegs(p, a);
		const pos = a.walk, speed = a.walkSpeed;
		const rf = p.right_front_leg, lf = p.left_front_leg, rh = p.right_hind_leg, lh = p.left_hind_leg;
		if (!d.inWater && d.onGround) {
			const layEgg = d.layingEgg ? 4 : 1, amplitude = d.layingEgg ? 2 : 1;
			const swing = pos * 5, front = cos(layEgg * swing), hind = cos(swing);
			if (rf) rf.yRot = -front * 8 * speed * amplitude;
			if (lf) lf.yRot = front * 8 * speed * amplitude;
			if (rh) rh.yRot = -hind * 3 * speed;
			if (lh) lh.yRot = hind * 3 * speed;
		} else {
			const swing = cos(pos * 0.6662 * 0.6) * 0.5 * speed;
			if (rh) rh.xRot = swing;
			if (lh) lh.xRot = -swing;
			if (rf) rf.zRot = -swing;
			if (lf) lf.zRot = swing;
		}
		if (p.egg_belly) {
			p.egg_belly.visible = !!d.hasEgg;
			if (d.hasEgg && p.root) p.root.y--;
		}
	},
	/** EndermiteModel / SilverfishModel.setupAnim: the body segments wriggle */
	crawler(p, a, e) {
		const silverfish = (e.type || '').endsWith('silverfish');
		const turn = silverfish ? 0.05 : 0.01, shift = silverfish ? 0.2 : 0.1;
		for (let i = 0; p['segment' + i]; i++) {
			const part = p['segment' + i], t = a.age * 0.9 + i * 0.15 * PI;
			part.yRot = cos(t) * PI * turn * (1 + abs(i - 2));
			part.x = sin(t) * PI * shift * abs(i - 2);
		}
		if (silverfish && p.layer0 && p.segment2) {
			p.layer0.yRot = p.segment2.yRot;
			if (p.layer1 && p.segment4) { p.layer1.yRot = p.segment4.yRot; p.layer1.x = p.segment4.x; }
			if (p.layer2 && p.segment1) { p.layer2.yRot = p.segment1.yRot; p.layer2.x = p.segment1.x; }
		}
	},
	/** VexModel.setupAnim */
	vex(p, a, e) {
		const { head, body } = p;
		const R = p.right_arm, L = p.left_arm;
		if (head) { head.yRot = a.netHeadYaw * DEG; head.xRot = a.headPitch * DEG; }
		const bob = cos(a.age * 5.5 * DEG) * 0.1;
		if (R) R.zRot = PI / 5 + bob;
		if (L) L.zRot = -(PI / 5 + bob);
		if (e.d && e.d.charging) {
			if (body) body.xRot = 0;
			const right = !!e.hand, left = !!e.offhand;
			if (!right && !left) {
				if (R) Object.assign(R, { xRot: -1.2217305, yRot: PI / 12, zRot: -0.47123888 - bob });
				if (L) Object.assign(L, { xRot: -1.2217305, yRot: -PI / 12, zRot: 0.47123888 + bob });
			} else {
				if (right && R) Object.assign(R, { xRot: PI * 7 / 6, yRot: PI / 12, zRot: -0.47123888 - bob });
				if (left && L) Object.assign(L, { xRot: PI * 7 / 6, yRot: -PI / 12, zRot: 0.47123888 + bob });
			}
		} else if (body) {
			body.xRot = PI / 20;
		}
		const wing = 1.0995574 + cos(a.age * 45.836624 * DEG) * DEG * 16.2;
		if (p.left_wing) Object.assign(p.left_wing, { yRot: wing, xRot: 0.47123888, zRot: -0.47123888 });
		if (p.right_wing) Object.assign(p.right_wing, { yRot: -wing, xRot: 0.47123888, zRot: 0.47123888 });
	},
	/** AllayModel.setupAnim: flying, the idle bob, dancing and spinning to a jukebox, holding its item */
	allay(p, a, e) {
		const { head, body, root } = p;
		const m = a.memory;
		const speed = a.walkSpeed, pos = a.walk;
		const flapAmount = cos(a.age * 20 * DEG + pos) * PI * 0.15 + speed;
		const idleBob = a.age * 9 * DEG;
		const flying = Math.min(speed / 0.3, 1), idle = 1 - flying;
		const partial = a.age - Math.floor(a.age);
		const holding = lerp(partial, m.holdO ?? 0, m.hold ?? 0) / 5;
		if (e.d && e.d.dancing) {
			const dance = a.age * 8 * DEG + speed;
			const spin = lerp(partial, m.spinO ?? 0, m.spin ?? 0) / 15;
			if (root) {
				if (m.spinning) root.yRot = PI * 4 * spin;
				root.zRot = cos(dance) * 16 * DEG * (1 - spin);
			}
			if (head) {
				head.yRot = cos(dance) * 30 * DEG * (1 - spin);
				head.zRot = cos(dance) * 14 * DEG * (1 - spin);
			}
		} else if (head) {
			head.xRot = a.headPitch * DEG;
			head.yRot = a.netHeadYaw * DEG;
		}
		if (p.right_wing) { p.right_wing.xRot = 0.43633232 * (1 - flying); p.right_wing.yRot = -PI / 4 + flapAmount; }
		if (p.left_wing) { p.left_wing.xRot = 0.43633232 * (1 - flying); p.left_wing.yRot = PI / 4 - flapAmount; }
		if (body) body.xRot = flying * PI / 4;
		const armX = holding * lerp(flying, -PI / 3, -1.134464);
		if (root) root.y += cos(idleBob) * 0.25 * idle;
		const armBob = 0.43633232 - cos(idleBob + PI * 3 / 2) * PI * 0.075 * idle * (1 - holding);
		if (p.right_arm) { p.right_arm.xRot = armX; p.right_arm.zRot = armBob; p.right_arm.yRot = 0.27925268 * holding; }
		if (p.left_arm) { p.left_arm.xRot = armX; p.left_arm.zRot = -armBob; p.left_arm.yRot = -0.27925268 * holding; }
	},
	/** StriderModel with AdultStriderModel / BabyStriderModel.customAnimations: the walk, the bristles, bobbing */
	strider(p, a, e) {
		const { body } = p;
		const L = p.left_leg, R = p.right_leg;
		if (!body || !L || !R) return;
		const pos = a.walk, speed = Math.min(a.walkSpeed, 0.25);
		if (!(e.d && e.d.ridden)) { body.xRot = a.headPitch * DEG; body.yRot = a.netHeadYaw * DEG; }
		else { body.xRot = 0; body.yRot = 0; }
		body.zRot = 0.1 * sin(pos * 1.5) * 4 * speed;
		L.xRot = sin(pos * 1.5 * 0.5) * 2 * speed;
		R.xRot = sin(pos * 1.5 * 0.5 + PI) * 2 * speed;
		L.zRot = PI / 18 * cos(pos * 1.5 * 0.5) * speed;
		R.zRot = PI / 18 * cos(pos * 1.5 * 0.5 + PI) * speed;
		const flow = cos(pos * 1.5 + PI) * speed;
		const bristle = (parts, axis) => {
			const [first, second, third] = parts;
			if (first) first[axis] += flow * 0.6 + 0.1 * sin(a.age * 0.4);
			if (second) second[axis] += flow * 1.2 + 0.1 * sin(a.age * 0.2);
			if (third) third[axis] += flow * 1.3 + 0.05 * sin(a.age * -0.4);
		};
		if (e.baby) {
			body.y = 17.25 - cos(pos * 1.5) * 2 * speed;
			L.y = 20 + 2 * sin(pos * 1.5 * 0.5 + PI) * 2 * speed;
			R.y = 20 + 2 * sin(pos * 1.5 * 0.5) * 2 * speed;
			bristle([p.bristle0, p.bristle1, p.bristle2], 'xRot');
		} else {
			const set = (name, z) => { if (p[name]) p[name].zRot = z; };
			set('right_bottom_bristle', -1.2217305); set('right_middle_bristle', -1.134464); set('right_top_bristle', -0.87266463);
			set('left_top_bristle', 0.87266463); set('left_middle_bristle', 1.134464); set('left_bottom_bristle', 1.2217305);
			bristle([p.right_top_bristle, p.right_middle_bristle, p.right_bottom_bristle], 'zRot');
			bristle([p.left_top_bristle, p.left_middle_bristle, p.left_bottom_bristle], 'zRot');
			body.y = 2 - 2 * cos(pos * 1.5) * 2 * speed;
			L.y = 8 + 2 * sin(pos * 1.5 * 0.5 + PI) * 2 * speed;
			R.y = 8 + 2 * sin(pos * 1.5 * 0.5) * 2 * speed;
		}
	},
	/** PolarBearModel.setupAnim: standing up on the hind legs (PolarBear.getStandingAnimationScale, CLIENT.polar_bear) */
	polarBear(p, a, e) {
		headLook(p, a);
		quadrupedLegs(p, a);
		const m = a.memory;
		const partial = a.age - Math.floor(a.age);
		const scale = lerp(partial, m.standO ?? 0, m.stand ?? 0) / 6;
		const stand = scale * scale, ageScale = e.baby ? 0.5 : 1;
		if (stand <= 0) return;
		const { body, head } = p;
		const rf = p.right_front_leg, lf = p.left_front_leg;
		if (body) { body.xRot -= stand * PI * 0.35; body.y += stand * ageScale * 2; }
		if (rf) { rf.y -= stand * ageScale * 20; rf.z += stand * ageScale * 4; rf.xRot -= stand * PI * 0.45; }
		if (lf && rf) { lf.y = rf.y; lf.z = rf.z; lf.xRot -= stand * PI * 0.45; }
		if (head) { head.y -= stand * 24; head.z += stand * 13; head.xRot += stand * PI * 0.15; }
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
	/**
	 * GuardianModel.setupAnim: spikes drawn in while it swims (withdrawal from the client's spikes animation),
	 * the eye looking at the camera or its beam's target, the tail swaying with the client's tail animation.
	 */
	guardian(p, a, e) {
		headLook(p, a);
		const m = a.memory || {};
		const spikes = m.spikes ?? 1, tail = m.tail ?? 0;
		const withdrawal = (1 - spikes) * 0.55;
		for (let i = 0; i < 12; i++) {
			const spike = p['spike' + i];
			if (!spike) continue;
			const offset = 1 + cos(a.age * 1.5 + i) * 0.01 - withdrawal;
			spike.x = SPIKE_X[i] * offset;
			spike.y = 16 + SPIKE_Y[i] * offset;
			spike.z = SPIKE_Z[i] * offset;
		}
		const look = a.lookAt, eye = a.eyePos;
		if (p.eye && look && eye) {
			p.eye.y = look[1] - eye[1] > 0 ? 0 : 1;
			// the view vector (flat) against the direction to the looked at point turned by 90 degrees
			const yaw = (e.body ?? e.yaw ?? 0) * DEG + a.netHeadYaw * DEG;
			const vx = -sin(yaw), vz = cos(yaw);
			let dx = eye[0] - look[0], dz = eye[2] - look[2];
			const len = Math.hypot(dx, dz) || 1;
			dx /= len; dz /= len;
			// Vec3.yRot(pi / 2): x' = x cos + z sin, z' = z cos - x sin
			const rx = dz, rz = -dx;
			const dot = vx * rx + vz * rz;
			p.eye.x = Math.sqrt(abs(dot)) * 2 * Math.sign(dot);
		}
		if (p.tail0) p.tail0.yRot = sin(tail) * PI * 0.05;
		if (p.tail1) p.tail1.yRot = sin(tail) * PI * 0.1;
		if (p.tail2) p.tail2.yRot = sin(tail) * PI * 0.15;
	},
	/** EndermanModel.setupAnim: long limbs swing half as far, arms up while carrying a block, the jaw drops when screaming. */
	enderman(p, a, e) {
		humanoid(p, a, e);
		for (const name of ['right_arm', 'left_arm', 'right_leg', 'left_leg']) {
			if (p[name]) p[name].xRot = clamp(p[name].xRot * 0.5, -0.4, 0.4);
		}
		if (e.d && e.d.carried !== undefined) {
			if (p.right_arm) { p.right_arm.xRot = -0.5; p.right_arm.zRot = 0.05; }
			if (p.left_arm) { p.left_arm.xRot = -0.5; p.left_arm.zRot = -0.05; }
		}
		if (e.d && e.d.creepy) {
			if (p.head) p.head.y -= 5;
			if (p.hat) p.hat.y += 5;
		}
	},
	armorStand() {},
	/** AbstractBoatModel.animatePaddle with the rowing times (AbstractBoat.getRowingTime). */
	boat(p, a, e) {
		const paddle = (part, time, side) => {
			if (!part) return;
			part.xRot = lerp01((sin(-time) + 1) / 2, -PI / 3, -PI / 12);
			part.yRot = lerp01((sin(-time + 1) + 1) / 2, -PI / 4, PI / 4);
			if (side === 1) part.yRot = PI - part.yRot;
		};
		paddle(p.left_paddle, e.rowL || 0, 0);
		paddle(p.right_paddle, e.rowR || 0, 1);
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

// --- keyframe animated mobs --------------------------------------------------------------------------------
// setupAnim of the models that play the game's AnimationDefinitions (a.k, see keyframes.js). The names are the
// game's: "<definitions class>.<field>" for animations, entity field names for animation states.

const headTo = (p, a, part = 'head') => {
	const head = p[part];
	if (head) { head.xRot = a.headPitch * DEG; head.yRot = a.netHeadYaw * DEG; }
};

/** Uses the simple animation when the game's keyframes are not available (older server, extraction failed). */
const keyframed = (probe, fallback, setup) => (p, a, e) => (a.k && a.k.has(probe) ? setup(p, a, e, a.k) : ANIMS[fallback](p, a, e));

const KEYFRAME_ANIMS = {
	/** WardenModel.setupAnim */
	warden: keyframed('WardenAnimation.WARDEN_ROAR', 'generic', (p, a, e, k) => {
		const { head, body } = p;
		if (!head || !body) return;
		// animateHeadLookTarget
		head.xRot = a.headPitch * DEG;
		head.yRot = a.netHeadYaw * DEG;
		// animateWalk
		const speed = Math.min(0.5, 3 * a.walkSpeed), pos = a.walk * 0.8662, c = cos(pos), s = sin(pos);
		const speedMin = Math.min(0.35, speed);
		head.zRot += 0.3 * s * speed;
		head.xRot += 1.2 * cos(pos + PI / 2) * speedMin;
		body.zRot = 0.1 * s * speed;
		body.xRot = c * speedMin;
		if (p.left_leg) p.left_leg.xRot = c * speed;
		if (p.right_leg) p.right_leg.xRot = cos(pos + PI) * speed;
		if (p.left_arm) Object.assign(p.left_arm, { xRot: -(0.8 * c * speed), zRot: 0, yRot: 0, x: 13, y: -13, z: 1 });
		if (p.right_arm) Object.assign(p.right_arm, { xRot: -(0.8 * s * speed), zRot: 0, yRot: 0, x: -13, y: -13, z: 1 });
		// animateIdlePose
		const age = a.age * 0.1;
		head.zRot += 0.06 * cos(age);
		head.xRot += 0.06 * sin(age);
		body.zRot += 0.025 * sin(age);
		body.xRot += 0.025 * cos(age);
		// animateTendrils
		const tendril = (a.memory.tendril || 0) / 10 * (Math.cos(a.age * 2.25) * PI * 0.1);
		if (p.left_tendril) p.left_tendril.xRot = tendril;
		if (p.right_tendril) p.right_tendril.xRot = -tendril;
		k.state('WardenAnimation.WARDEN_ATTACK', 'attackAnimationState');
		k.state('WardenAnimation.WARDEN_SONIC_BOOM', 'sonicBoomAnimationState');
		k.state('WardenAnimation.WARDEN_DIG', 'diggingAnimationState');
		k.state('WardenAnimation.WARDEN_EMERGE', 'emergeAnimationState');
		k.state('WardenAnimation.WARDEN_ROAR', 'roarAnimationState');
		k.state('WardenAnimation.WARDEN_SNIFF', 'sniffAnimationState');
	}),
	/** SnifferModel.setupAnim */
	sniffer: keyframed('SnifferAnimation.SNIFFER_WALK', 'quadruped', (p, a, e, k) => {
		headTo(p, a);
		const walk = e.d && e.d.searching ? 'SnifferAnimation.SNIFFER_SNIFF_SEARCH' : 'SnifferAnimation.SNIFFER_WALK';
		k.walk(walk, a.walk, a.walkSpeed, 9, 100);
		k.state('SnifferAnimation.SNIFFER_DIG', 'diggingAnimationState');
		k.state('SnifferAnimation.SNIFFER_LONGSNIFF', 'sniffingAnimationState');
		k.state('SnifferAnimation.SNIFFER_STAND_UP', 'risingAnimationState');
		k.state('SnifferAnimation.SNIFFER_HAPPY', 'feelingHappyAnimationState');
		k.state('SnifferAnimation.SNIFFER_SNIFFSNIFF', 'scentingAnimationState');
	}),
	/** FrogModel.setupAnim */
	frog: keyframed('FrogAnimation.FROG_WALK', 'head', (p, a, e, k) => {
		k.state('FrogAnimation.FROG_JUMP', 'jumpAnimationState');
		k.state('FrogAnimation.FROG_CROAK', 'croakAnimationState');
		k.state('FrogAnimation.FROG_TONGUE', 'tongueAnimationState');
		if (e.d && e.d.inWater) k.walk('FrogAnimation.FROG_SWIM', a.walk, a.walkSpeed, 1, 2.5);
		else k.walk('FrogAnimation.FROG_WALK', a.walk, a.walkSpeed, 1.5, 2.5);
		k.state('FrogAnimation.FROG_IDLE_WATER', 'swimIdleAnimationState');
		if (p.croaking_body) p.croaking_body.visible = a.states.isStarted('croakAnimationState');
	}),
	/** CamelModel.setupAnim (AdultCamelModel / BabyCamelModel pick the definitions) */
	camel: keyframed('CamelAnimation.CAMEL_WALK', 'quadruped', (p, a, e, k) => {
		const A = e.baby ? 'CamelBabyAnimation.CAMEL_BABY_' : 'CamelAnimation.CAMEL_';
		if (p.head) {
			p.head.yRot = clamp(a.netHeadYaw, -30, 30) * DEG;
			p.head.xRot = clamp(a.headPitch, -25, 45) * DEG;
		}
		k.walk(A + 'WALK', a.walk, a.walkSpeed, 2, 2.5);
		k.state(A + 'SIT', 'sitAnimationState');
		k.state(A + 'SIT_POSE', 'sitPoseAnimationState');
		k.state(A + 'STANDUP', 'sitUpAnimationState');
		k.state(A + 'IDLE', 'idleAnimationState');
		k.state(A + 'DASH', 'dashAnimationState');
	}),
	/** ArmadilloModel.setupAnim */
	armadillo: keyframed('ArmadilloAnimation.ARMADILLO_WALK', 'quadruped', (p, a, e, k) => {
		const A = e.baby ? 'BabyArmadilloAnimation.ARMADILLO_BABY_' : 'ArmadilloAnimation.ARMADILLO_';
		const hiding = !!(e.d && e.d.hiding);
		if (p.body) p.body.skipDraw = hiding;
		for (const name of ['left_hind_leg', 'right_hind_leg', 'tail']) if (p[name]) p[name].visible = !hiding;
		if (p.cube) p.cube.visible = hiding;
		if (!hiding) {
			if (p.head) {
				p.head.xRot = clamp(a.headPitch, -22.5, 25) * DEG;
				p.head.yRot = clamp(a.netHeadYaw, -32.5, 32.5) * DEG;
			}
			k.walk(A + 'WALK', a.walk, a.walkSpeed, 16.5, 2.5);
		}
		k.state(A + 'ROLL_OUT', 'rollOutAnimationState');
		k.state(A + 'ROLL_UP', 'rollUpAnimationState');
		k.state(A + 'PEEK', 'peekAnimationState');
	}),
	/** BatModel.setupAnim */
	bat: keyframed('BatAnimation.BAT_FLYING', 'batSimple', (p, a, e, k) => {
		if (e.d && e.d.resting && p.head) p.head.yRot = a.netHeadYaw * DEG;
		k.state('BatAnimation.BAT_FLYING', 'flyAnimationState');
		k.state('BatAnimation.BAT_RESTING', 'restAnimationState');
	}),
	/** BreezeModel.setupAnim */
	breeze: keyframed('BreezeAnimation.IDLE', 'head', (p, a, e, k) => {
		k.state('BreezeAnimation.IDLE', 'idle');
		k.state('BreezeAnimation.SHOOT', 'shoot');
		k.state('BreezeAnimation.SLIDE', 'slide');
		k.state('BreezeAnimation.SLIDE_BACK', 'slideBack');
		k.state('BreezeAnimation.INHALE', 'inhale');
		k.state('BreezeAnimation.JUMP', 'longJump');
	}),
	/** CreakingModel.setupAnim */
	creaking: keyframed('CreakingAnimation.CREAKING_WALK', 'generic', (p, a, e, k) => {
		headTo(p, a);
		k.walk('CreakingAnimation.CREAKING_WALK', a.walk, a.walkSpeed, 1, 1);
		k.state('CreakingAnimation.CREAKING_ATTACK', 'attackAnimationState');
		k.state('CreakingAnimation.CREAKING_INVULNERABLE', 'invulnerabilityAnimationState');
		k.state('CreakingAnimation.CREAKING_DEATH', 'deathAnimationState');
	}),
	/** RabbitModel.setupAnim (AdultRabbitModel / BabyRabbitModel pick the definitions) */
	rabbit: keyframed('RabbitAnimation.HOP', 'head', (p, a, e, k) => {
		const A = e.baby ? 'BabyRabbitAnimation.' : 'RabbitAnimation.';
		if (!a.states.isStarted('idleHeadTiltAnimationState')) headTo(p, a);
		k.state(A + 'HOP', 'hopAnimationState');
		k.state(A + 'IDLE_HEAD_TILT', 'idleHeadTiltAnimationState');
	}),
	/** CopperGolemModel.setupAnim */
	copperGolem: keyframed('CopperGolemAnimation.COPPER_GOLEM_WALK', 'generic', (p, a, e, k) => {
		headTo(p, a);
		if (!e.hand && !e.offhand) {
			k.walk('CopperGolemAnimation.COPPER_GOLEM_WALK', a.walk, a.walkSpeed, 2, 2.5);
		} else {
			k.walk('CopperGolemAnimation.COPPER_GOLEM_WALK_ITEM', a.walk, a.walkSpeed, 2, 2.5);
			// poseHeldItemArmsIfStill
			const r = p.right_arm, l = p.left_arm;
			if (r && l) {
				r.xRot = Math.min(r.xRot, -0.87266463); l.xRot = Math.min(l.xRot, -0.87266463);
				r.yRot = Math.min(r.yRot, -0.1134464); l.yRot = Math.max(l.yRot, 0.1134464);
				r.zRot = Math.min(r.zRot, -0.064577185); l.zRot = Math.max(l.zRot, 0.064577185);
			}
		}
		k.state('CopperGolemAnimation.COPPER_GOLEM_IDLE', 'idleAnimationState');
		k.state('CopperGolemAnimation.COPPER_GOLEM_CHEST_INTERACTION_NOITEM_GET', 'interactionGetItemAnimationState');
		k.state('CopperGolemAnimation.COPPER_GOLEM_CHEST_INTERACTION_NOITEM_NOGET', 'interactionGetNoItemAnimationState');
		k.state('CopperGolemAnimation.COPPER_GOLEM_CHEST_INTERACTION_ITEM_DROP', 'interactionDropItemAnimationState');
		k.state('CopperGolemAnimation.COPPER_GOLEM_CHEST_INTERACTION_ITEM_NODROP', 'interactionDropNoItemAnimationState');
	}),
	/** NautilusModel.setupAnim */
	nautilus: keyframed('NautilusAnimation.SWIMMING', 'none', (p, a, e, k) => {
		if (p.body) {
			p.body.yRot = clamp(a.netHeadYaw, -10, 10) * DEG;
			p.body.xRot = clamp(a.headPitch, -10, 10) * DEG;
		}
		k.walk('NautilusAnimation.SWIMMING', a.walk + a.age / 5, a.walkSpeed + 0.2, 2, 3);
	}),
	/** AdultAxolotlModel keeps the simple animation; BabyAxolotlModel.setupAnim plays keyframes. */
	axolotl: (p, a, e) => {
		if (!e.baby || !a.k || !a.k.has('BabyAxolotlAnimation.BABY_AXOLOTL_SWIM')) return ANIMS.quadruped(p, a, e);
		const k = a.k;
		if (a.states.isStarted('walkAnimationState')) k.walk('BabyAxolotlAnimation.AXOLOTL_WALK_FLOOR', a.walk, a.walkSpeed, 15, 30);
		k.state('BabyAxolotlAnimation.BABY_AXOLOTL_SWIM', 'swimAnimationState');
		k.state('BabyAxolotlAnimation.WALK_FLOOR_UNDERWATER', 'walkAnimationState');
		k.state('BabyAxolotlAnimation.BABY_AXOLOTL_IDLE_FLOOR', 'idleOnGroundAnimationState');
		k.state('BabyAxolotlAnimation.IDLE_UNDERWATER', 'idleUnderWaterAnimationState');
		k.state('BabyAxolotlAnimation.IDLE_FLOOR_UNDERWATER', 'idleUnderWaterOnGroundAnimationState');
		k.state('BabyAxolotlAnimation.BABY_AXOLOTL_PLAY_DEAD', 'playDeadAnimationState');
	},
};
ANIMS.batSimple = ANIMS.bat;
Object.assign(ANIMS, KEYFRAME_ANIMS);

// --- client side animation triggers ------------------------------------------------------------------------
// What the game client does in the entity's tick(), handleEntityEvent and onSyncedDataUpdated to start and stop
// AnimationStates that the server does not run (see keyframes.js AnimationStates). tick(e, st, tick) runs once per
// entity tick, event(e, st, id, tick) for every entity event; st.memory keeps the entity's client-only fields.

const WALKING = e => (e.walkSpeed || 0) > 1e-5; // WalkAnimationState.isMoving
const chance = n => Math.floor(Math.random() * n);

export const CLIENT = {
	/** Guardian.aiStep (client): the tail's swim and the spikes (random out of water, drawn in while swimming). */
	guardian: {
		tick(e, st) {
			const m = st.memory;
			if (m.tail === undefined) { m.tail = Math.random(); m.tailSpeed = 0; m.spikes = 1; }
			const inWater = !!(e.d && e.d.inWater), moving = !!(e.d && e.d.moving);
			if (!inWater) m.tailSpeed = 2;
			else if (moving) m.tailSpeed = m.tailSpeed < 0.5 ? 4 : m.tailSpeed + (0.5 - m.tailSpeed) * 0.1;
			else m.tailSpeed += (0.125 - m.tailSpeed) * 0.2;
			m.tail += m.tailSpeed;
			if (!inWater) m.spikes = Math.random();
			else if (moving) m.spikes += (0 - m.spikes) * 0.25;
			else m.spikes += (1 - m.spikes) * 0.06;
		},
	},
	/** Warden.handleEntityEvent and the client part of Warden.tick */
	warden: {
		event(e, st, id, tick) {
			if (id === 4) { st.stop('roarAnimationState'); st.start('attackAnimationState', tick); }
			else if (id === 61) st.memory.tendril = 10;
			else if (id === 62) st.start('sonicBoomAnimationState', tick);
		},
		tick(e, st) {
			if (st.memory.tendril > 0) st.memory.tendril--;
		},
	},
	/** Frog.tick (client) */
	frog: {
		tick(e, st, tick) {
			st.animateWhen(!!(e.d && e.d.inWater) && !WALKING(e), 'swimIdleAnimationState', tick);
		},
	},
	/** Camel.setupAnimationStates */
	camel: {
		tick(e, st, tick) {
			const m = st.memory;
			if (!(m.idleTimeout > 0)) {
				m.idleTimeout = chance(40) + 80;
				st.start('idleAnimationState', tick);
			} else {
				m.idleTimeout--;
			}
			const sitting = !!(e.d && e.d.camelSitting);
			const poseTime = Number(e.d && e.d.poseTime) || 0;
			if ((poseTime < 0) !== sitting) {
				st.stop('sitUpAnimationState');
				st.stop('dashAnimationState');
				if (sitting && poseTime < 40 && poseTime >= 0) {
					st.startIfStopped('sitAnimationState', tick);
					st.stop('sitPoseAnimationState');
				} else {
					st.stop('sitAnimationState');
					st.startIfStopped('sitPoseAnimationState', tick);
				}
			} else {
				st.stop('sitAnimationState');
				st.stop('sitPoseAnimationState');
				st.animateWhen(!!(e.d && e.d.dashing), 'dashAnimationState', tick);
				st.animateWhen(poseTime < (sitting ? 40 : 52) && poseTime >= 0, 'sitUpAnimationState', tick);
			}
		},
	},
	/** Armadillo.setupAnimationStates and handleEntityEvent (peek) */
	armadillo: {
		event(e, st, id) {
			if (id === 64) st.memory.peekReceived = true;
		},
		tick(e, st, tick) {
			const state = (e.d && e.d.state) || 'idle';
			const m = st.memory;
			if (state !== m.state) { m.state = state; m.inState = 0; } else m.inState++;
			if (state === 'rolling') {
				st.stop('rollOutAnimationState'); st.startIfStopped('rollUpAnimationState', tick); st.stop('peekAnimationState');
			} else if (state === 'scared') {
				st.stop('rollOutAnimationState'); st.stop('rollUpAnimationState');
				if (m.peekReceived) { st.stop('peekAnimationState'); m.peekReceived = false; }
				st.startIfStopped('peekAnimationState', tick);
			} else if (state === 'unrolling') {
				st.startIfStopped('rollOutAnimationState', tick); st.stop('rollUpAnimationState'); st.stop('peekAnimationState');
			} else {
				st.stop('rollOutAnimationState'); st.stop('rollUpAnimationState'); st.stop('peekAnimationState');
			}
		},
	},
	/** Bat.setupAnimationStates */
	bat: {
		tick(e, st, tick) {
			const resting = !!(e.d && e.d.resting);
			st.stop(resting ? 'flyAnimationState' : 'restAnimationState');
			st.startIfStopped(resting ? 'restAnimationState' : 'flyAnimationState', tick);
		},
	},
	/** Breeze.onSyncedDataUpdated (client) and Breeze.tick */
	breeze: {
		tick(e, st, tick) {
			const pose = e.pose || 'standing';
			if (pose !== st.memory.pose) {
				st.memory.pose = pose;
				for (const name of ['shoot', 'idle', 'inhale', 'longJump']) st.stop(name);
				if (pose === 'shooting') st.startIfStopped('shoot', tick);
				else if (pose === 'inhaling') st.startIfStopped('inhale', tick);
				else if (pose === 'sliding') st.startIfStopped('slide', tick);
			}
			if (pose === 'long_jumping') st.startIfStopped('longJump', tick);
			st.startIfStopped('idle', tick);
			if (pose !== 'sliding' && st.isStarted('slide')) {
				st.start('slideBack', tick);
				st.stop('slide');
			}
		},
	},
	/** Creaking.handleEntityEvent, tick and setupAnimationStates */
	creaking: {
		event(e, st, id) {
			if (id === 66) st.memory.invulnerable = 8;
			else if (id === 4) st.memory.attack = 15;
		},
		tick(e, st, tick) {
			const m = st.memory;
			if (m.invulnerable > 0) m.invulnerable--;
			if (m.attack > 0) m.attack--;
			st.animateWhen(m.attack > 0, 'attackAnimationState', tick);
			st.animateWhen(m.invulnerable > 0, 'invulnerabilityAnimationState', tick);
			st.animateWhen(!!(e.d && e.d.tearingDown), 'deathAnimationState', tick);
		},
	},
	/** Rabbit.handleEntityEvent (jump), aiStep and setupAnimationStates */
	rabbit: {
		event(e, st, id) {
			if (id === 1) { st.memory.jumpDuration = 15; st.memory.jumpTicks = 0; }
		},
		tick(e, st, tick) {
			const m = st.memory;
			m.jumpTicks ??= 0; m.jumpDuration ??= 0; m.idleTimeout ??= 0;
			if (m.jumpTicks !== m.jumpDuration) m.jumpTicks++;
			else if (m.jumpDuration !== 0) { m.jumpTicks = 0; m.jumpDuration = 0; }
			if (m.idleTimeout <= 0 && !(e.d && e.d.leashed)) {
				m.idleTimeout = chance(40) + 180;
				st.start('idleHeadTiltAnimationState', tick);
			} else if (m.jumpTicks > 0) {
				st.startIfStopped('hopAnimationState', tick);
				st.stop('idleHeadTiltAnimationState');
			} else {
				m.idleTimeout--;
				st.stop('hopAnimationState');
			}
		},
	},
	/** CopperGolem.setupAnimationStates (without the head spin sound) */
	copper_golem: {
		tick(e, st, tick) {
			const m = st.memory;
			const state = (e.d && e.d.state) || 'idle';
			const interactions = {
				getting_item: 'interactionGetItemAnimationState', getting_no_item: 'interactionGetNoItemAnimationState',
				dropping_item: 'interactionDropItemAnimationState', dropping_no_item: 'interactionDropNoItemAnimationState',
			};
			if (state === 'idle') {
				for (const name of Object.values(interactions)) st.stop(name);
				if (m.idleStart === tick) st.start('idleAnimationState', tick);
				else if (!m.idleStart) m.idleStart = tick + 200 + chance(40);
				if (tick === m.idleStart + 10) m.idleStart = 0;
			} else {
				st.stop('idleAnimationState');
				m.idleStart = 0;
				for (const [name, field] of Object.entries(interactions)) {
					if (name === state) st.startIfStopped(field, tick);
					else st.stop(field);
				}
			}
		},
	},
	/** Axolotl.tickBabyAnimations */
	axolotl: {
		tick(e, st, tick) {
			if (!e.baby) return;
			const all = ['swimAnimationState', 'walkAnimationState', 'walkUnderWaterAnimationState', 'idleUnderWaterAnimationState',
				'idleUnderWaterOnGroundAnimationState', 'idleOnGroundAnimationState', 'playDeadAnimationState'];
			const water = !!(e.d && e.d.inWater), ground = !!(e.d && e.d.onGround);
			const moving = WALKING(e) || e.yaw !== st.memory.yaw || e.pitch !== st.memory.pitch;
			st.memory.yaw = e.yaw;
			st.memory.pitch = e.pitch;
			let solo;
			if (e.d && e.d.playingDead) solo = 'playDeadAnimationState';
			else if (moving) solo = water && !ground ? 'swimAnimationState' : !water && ground ? 'walkAnimationState' : 'walkUnderWaterAnimationState';
			else solo = water && !ground ? 'idleUnderWaterAnimationState' : water && ground ? 'idleUnderWaterOnGroundAnimationState' : 'idleOnGroundAnimationState';
			for (const name of all) {
				if (name === solo) st.startIfStopped(name, tick);
				else st.stop(name);
			}
		},
	},
};
CLIENT.elder_guardian = CLIENT.guardian;
CLIENT.camel_husk = CLIENT.camel;
/** IronGolem.handleEntityEvent: 4 starts the attack swing (attackAnimationTick = 10). */
CLIENT.iron_golem = {
	event(e, st, id, tick) {
		if (id === 4) st.memory.attackAt = tick;
	},
};
/** PolarBear.tick (client): clientSideStandAnimation climbs to 6 while standing */
CLIENT.polar_bear = {
	tick(e, st) {
		const m = st.memory;
		m.standO = m.stand ?? 0;
		m.stand = clamp((m.stand ?? 0) + (e.d && e.d.standing ? 1 : -1), 0, 6);
	},
};
/** Allay.tick (client): holdingItemAnimationTicks, dancingAnimationTicks and spinningAnimationTicks */
CLIENT.allay = {
	tick(e, st) {
		const m = st.memory;
		m.holdO = m.hold ?? 0;
		m.hold = clamp((m.hold ?? 0) + (e.hand ? 1 : -1), 0, 5);
		if (e.d && e.d.dancing) {
			m.dance = (m.dance ?? 0) + 1;
			m.spinO = m.spin ?? 0;
			m.spinning = m.dance % 55 < 15;
			m.spin = clamp((m.spin ?? 0) + (m.spinning ? 1 : -1), 0, 15);
		} else {
			m.dance = 0; m.spin = 0; m.spinO = 0; m.spinning = false;
		}
	},
};
/** EvokerFangs.handleEntityEvent: 4 starts the bite (clientSideAttackStarted). */
CLIENT.evoker_fangs = {
	event(e, st, id, tick) {
		if (id === 4) st.memory.biteAt = tick;
	},
};
/** Sheep.handleEntityEvent: 10 starts eating grass (eatAnimationTick = 40). */
CLIENT.sheep = {
	event(e, st, id, tick) {
		if (id === 10) st.memory.eatAt = tick;
	},
};
/** Wolf.handleEntityEvent (8 starts shaking off water, 56 cancels it) and Wolf.tick (shake, begging head roll). */
CLIENT.wolf = {
	event(e, st, id, tick) {
		if (id === 8) st.memory.shakeAt = tick;
		else if (id === 56) st.memory.shakeAt = undefined;
	},
	tick(e, st, tick) {
		const m = st.memory;
		m.interestO = m.interest ?? 0;
		m.interest = m.interestO + ((e.d && e.d.interested ? 1 : 0) - m.interestO) * 0.4;
		// shakeAnimO >= 2: the shake is over
		if (m.shakeAt !== undefined && (tick - m.shakeAt) * 0.05 > 2.05) m.shakeAt = undefined;
	},
};
/** Ravager.handleEntityEvent: 4 attack (attackTick = 10), 39 stunned (stunnedTick = 40). */
CLIENT.ravager = {
	event(e, st, id, tick) {
		if (id === 4) st.memory.attackAt = tick;
		else if (id === 39) st.memory.stunAt = tick;
	},
};
/** Hoglin / Zoglin.handleEntityEvent: 4 starts the headbutt (attackAnimationRemainingTicks = 10). */
CLIENT.hoglin = {
	event(e, st, id, tick) {
		if (id === 4) st.memory.attackAt = tick;
	},
};
CLIENT.zoglin = CLIENT.hoglin;
/** Goat.handleEntityEvent (58 lowers the head to ram, 59 raises it) and Goat.aiStep (lowerHeadTick). */
CLIENT.goat = {
	event(e, st, id) {
		if (id === 58) st.memory.lowering = true;
		else if (id === 59) st.memory.lowering = false;
	},
	tick(e, st) {
		const m = st.memory;
		m.lowerHeadTick = Math.min(20, Math.max(0, (m.lowerHeadTick || 0) + (m.lowering ? 1 : -2)));
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
	allay: { layer: 'allay#main', texture: 'allay/allay', shadow: 0.4, anim: 'allay', cull: false },
	armadillo: { layer: e => (e.baby ? 'armadillo_baby#main' : 'armadillo#main'), texture: e => 'armadillo/armadillo' + baby(e), shadow: 0.4, anim: 'armadillo' },
	armor_stand: { layer: e => (e.d && e.d.small ? 'armor_stand_small#main' : 'armor_stand#main'), texture: 'armorstand/armorstand', shadow: 0, anim: 'armorStand', armor: 'armor_stand' },
	axolotl: { layer: e => (e.baby ? 'axolotl_baby#main' : 'axolotl#main'), texture: e => 'axolotl/axolotl_' + variant(e, 'lucy') + baby(e), shadow: 0.5, anim: 'axolotl' },
	bat: { layer: 'bat#main', texture: 'bat/bat', shadow: 0.25, anim: 'bat' },
	bee: {
		layer: e => (e.baby ? 'bee_baby#main' : 'bee#main'),
		texture: e => 'bee/bee' + (e.d && e.d.angry ? '_angry' : '') + (e.d && e.d.nectar ? '_nectar' : '') + baby(e),
		shadow: 0.4, anim: 'bee',
	},
	blaze: { layer: 'blaze#main', texture: 'blaze/blaze', shadow: 0.5, anim: 'blaze', fullBright: true },
	bogged: { layer: 'bogged#main', texture: 'skeleton/bogged', shadow: 0.5, anim: 'skeleton', armor: 'bogged', layers: [{ layer: 'bogged#outer', texture: 'skeleton/bogged_overlay' }] },
	breeze: { layer: 'breeze#main', texture: 'breeze/breeze', shadow: 0.5, anim: 'breeze', layers: [{ layer: 'breeze#eyes', texture: 'breeze/breeze_eyes', mode: 'eyes' }] },
	camel: { layer: e => (e.baby ? 'camel_baby#main' : 'camel#main'), texture: e => 'camel/camel' + baby(e), shadow: 0.7, anim: 'camel', saddle: ['camel#saddle', 'equipment/camel_saddle/saddle'] },
	camel_husk: { layer: 'camel#main', texture: 'camel/camel_husk', shadow: 0.7, anim: 'camel', saddle: ['camel_husk#saddle', 'equipment/camel_husk_saddle/saddle'] },
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
	copper_golem: { layer: 'copper_golem#main', texture: 'copper_golem/copper_golem', shadow: 0.5, anim: 'copperGolem', layers: [{ layer: 'copper_golem#eyes', texture: 'copper_golem/copper_golem_eyes', mode: 'eyes' }] },
	cow: {
		layer: e => (e.baby ? 'cow_baby#main' : ({ cold: 'cold_cow#main', warm: 'warm_cow#main' })[variant(e, 'temperate')] || 'cow#main'),
		texture: e => 'cow/cow_' + variant(e, 'temperate') + baby(e), shadow: 0.7, anim: 'quadruped',
	},
	creaking: { layer: 'creaking#main', texture: 'creaking/creaking', shadow: 0.6, anim: 'creaking', layers: [{ layer: 'creaking#eyes', texture: 'creaking/creaking_eyes', mode: 'eyes' }] },
	creeper: {
		layer: 'creeper#main', texture: 'creeper/creeper', shadow: 0.5, anim: 'creeper', creeper: true,
		layers: [{ layer: 'creeper#armor', texture: 'creeper/creeper_armor', when: e => e.d && e.d.powered, mode: 'energy' }],
	},
	dolphin: { layer: e => (e.baby ? 'dolphin_baby#main' : 'dolphin#main'), texture: e => 'dolphin/dolphin' + baby(e), shadow: 0.7, anim: 'dolphin' },
	donkey: { layer: e => (e.baby ? 'donkey_baby#main' : 'donkey#main'), texture: e => 'horse/donkey' + baby(e), shadow: 0.75, anim: 'horse', saddle: ['donkey#saddle', 'equipment/donkey_saddle/saddle'] },
	drowned: {
		layer: e => (e.baby ? 'drowned_baby#main' : 'drowned#main'), texture: e => 'zombie/drowned' + baby(e), shadow: 0.5, anim: 'zombie', armor: 'drowned',
		layers: [{ layer: e => (e.baby ? 'drowned_baby#outer' : 'drowned#outer'), texture: e => 'zombie/drowned_outer_layer' + baby(e) }],
	},
	elder_guardian: { layer: 'elder_guardian#main', texture: 'guardian/guardian_elder', shadow: 1.2, anim: 'guardian' },
	end_crystal: { special: 'endCrystal' },
	ender_dragon: { layer: 'ender_dragon#main', texture: 'enderdragon/dragon', shadow: 0.5, anim: 'dragon', dragon: true, layers: [{ layer: 'ender_dragon#main', texture: 'enderdragon/dragon_eyes', mode: 'eyes' }] },
	enderman: { layer: 'enderman#main', texture: 'enderman/enderman', shadow: 0.5, anim: 'enderman', creepyShake: true, carries: true, layers: [{ layer: 'enderman#main', texture: 'enderman/enderman_eyes', mode: 'eyes' }] },
	endermite: { layer: 'endermite#main', texture: 'endermite/endermite', shadow: 0.3, anim: 'crawler' },
	evoker: { layer: 'evoker#main', texture: 'illager/evoker', shadow: 0.5, anim: 'illager' },
	evoker_fangs: { layer: 'evoker_fangs#main', texture: 'illager/evoker_fangs', shadow: 0, anim: 'none', living: false },
	fox: {
		layer: e => (e.baby ? 'fox_baby#main' : 'fox#main'),
		texture: e => 'fox/fox' + (variant(e, 'red') === 'snow' ? '_snow' : '') + (e.d && e.d.sleeping ? '_sleep' : '') + baby(e),
		shadow: 0.4, anim: 'fox', fox: true,
	},
	frog: { layer: 'frog#main', texture: e => 'frog/frog_' + variant(e, 'temperate'), shadow: 0.3, anim: 'frog' },
	ghast: { layer: 'ghast#main', texture: e => (e.d && e.d.charging ? 'ghast/ghast_shooting' : 'ghast/ghast'), shadow: 1.5, anim: 'ghast', fullBright: true },
	giant: { layer: 'giant#main', texture: 'zombie/zombie', shadow: 3, anim: 'zombie' },
	glow_squid: { layer: e => (e.baby ? 'glow_squid_baby#main' : 'glow_squid#main'), texture: e => 'squid/glow_squid' + baby(e), shadow: 0.7, anim: 'squid', squid: true, fullBright: true },
	goat: { layer: e => (e.baby ? 'goat_baby#main' : 'goat#main'), texture: e => 'goat/goat' + baby(e), shadow: 0.7, anim: 'goat' },
	guardian: { layer: 'guardian#main', texture: 'guardian/guardian', shadow: 0.5, anim: 'guardian' },
	happy_ghast: {
		layer: e => (e.baby ? 'happy_ghast_baby#main' : 'happy_ghast#main'), texture: e => (e.baby ? 'ghast/happy_ghast_baby' : 'ghast/happy_ghast'),
		shadow: e => (e.baby ? 0.95 : 4), anim: 'ghast',
		body: e => bodyLayers(e, 'happy_ghast_body', e.baby ? 'happy_ghast_baby_harness#main' : 'happy_ghast_harness#main'),
		layers: [
			{ layer: e => (e.baby ? 'happy_ghast_baby_ropes#main' : 'happy_ghast_ropes#main'), texture: 'ghast/happy_ghast_ropes', when: e => e.d && e.d.leashed },
		],
	},
	hoglin: { layer: e => (e.baby ? 'hoglin_baby#main' : 'hoglin#main'), texture: e => 'hoglin/hoglin' + baby(e), shadow: 0.7, anim: 'hoglin' },
	horse: {
		layer: e => (e.baby ? 'horse_baby#main' : 'horse#main'),
		texture: e => 'horse/horse_' + (variant(e, 'white').replace('dark_brown', 'darkbrown')) + baby(e),
		shadow: 0.75, anim: 'horse', saddle: ['horse#saddle', 'equipment/horse_saddle/saddle'],
		layers: [
			{
				layer: e => (e.baby ? 'horse_baby#main' : 'horse#main'), when: e => e.d && e.d.markings && e.d.markings !== 'none',
				texture: e => 'horse/horse_markings_' + e.d.markings.replace(/_/g, '') + baby(e),
			},
		],
		body: e => (e.baby ? [] : bodyLayers(e, 'horse_body', 'horse_armor#main')),
	},
	husk: { layer: e => (e.baby ? 'husk_baby#main' : 'husk#main'), texture: e => 'zombie/husk' + baby(e), shadow: 0.5, anim: 'zombie', armor: 'husk' },
	illusioner: { layer: 'illusioner#main', texture: 'illager/illusioner', shadow: 0.5, anim: 'illager' },
	iron_golem: {
		layer: 'iron_golem#main', texture: 'iron_golem/iron_golem', shadow: 0.7, anim: 'golem', walkRoll: true, flower: true,
		layers: [{ layer: 'iron_golem#main', texture: e => 'iron_golem/iron_golem_crackiness_' + e.d.crackiness, when: e => e.d && e.d.crackiness && e.d.crackiness !== 'none' }],
	},
	llama: {
		layer: e => (e.baby ? 'llama_baby#main' : 'llama#main'), texture: e => 'llama/llama_' + variant(e, 'creamy') + baby(e), shadow: 0.7, anim: 'llama',
		body: e => bodyLayers(e, 'llama_body', e.baby ? 'llama_baby#decor' : 'llama#decor'),
	},
	trader_llama: {
		layer: e => (e.baby ? 'trader_llama_baby#main' : 'trader_llama#main'), texture: e => 'llama/llama_' + variant(e, 'creamy') + baby(e), shadow: 0.7, anim: 'llama',
		layers: [{ layer: e => (e.baby ? 'llama_baby#decor' : 'llama#decor'), texture: e => (e.baby ? 'equipment/llama_body/trader_llama_baby' : 'equipment/llama_body/trader_llama') }],
	},
	magma_cube: { layer: 'magma_cube#main', texture: 'slime/magmacube', shadow: 0.25, anim: 'none', slime: true, fullBright: true },
	mooshroom: { layer: e => (e.baby ? 'mooshroom_baby#main' : 'mooshroom#main'), texture: e => 'cow/mooshroom_' + variant(e, 'red') + baby(e), shadow: 0.7, anim: 'quadruped' },
	mule: { layer: e => (e.baby ? 'mule_baby#main' : 'mule#main'), texture: e => 'horse/mule' + baby(e), shadow: 0.75, anim: 'horse', saddle: ['mule#saddle', 'equipment/mule_saddle/saddle'] },
	nautilus: { layer: e => (e.baby ? 'nautilus_baby#main' : 'nautilus#main'), texture: e => 'nautilus/nautilus' + baby(e), shadow: 0.7, anim: 'nautilus', body: e => (e.baby ? [] : bodyLayers(e, 'nautilus_body', 'nautilus_armor#main')), saddle: ['nautilus#saddle', 'equipment/nautilus_saddle/saddle'] },
	ocelot: { layer: e => (e.baby ? 'ocelot_baby#main' : 'ocelot#main'), texture: e => 'cat/ocelot' + baby(e), shadow: 0.4, anim: 'cat' },
	panda: {
		layer: e => (e.baby ? 'panda_baby#main' : 'panda#main'),
		texture: e => {
			const gene = pandaGene(e);
			if (e.baby) return gene === 'normal' ? 'panda/panda_baby' : 'panda/' + gene + '_panda_baby';
			return gene === 'normal' ? 'panda/panda' : 'panda/panda_' + gene;
		},
		shadow: 0.9, anim: 'panda', panda: true,
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
	// Mannequin: an AvatarRenderer like players, with the skin of its profile
	mannequin: { player: true, shadow: 0.5, anim: 'humanoid', armor: 'player' },
	polar_bear: { layer: e => (e.baby ? 'polar_bear_baby#main' : 'polar_bear#main'), texture: e => 'bear/polarbear' + baby(e), shadow: 0.9, anim: 'polarBear' },
	pufferfish: {
		layer: e => ['pufferfish_small#main', 'pufferfish_medium#main', 'pufferfish_big#main'][clamp(Number(e.d && e.d.puff) || 0, 0, 2)],
		texture: 'fish/pufferfish', shadow: 0.2, anim: 'pufferfish', puffer: true,
	},
	rabbit: {
		layer: e => (e.baby ? 'rabbit_baby#main' : 'rabbit#main'),
		texture: e => {
			if (e.name === 'Toast') return 'rabbit/rabbit_toast' + baby(e);
			const v = variant(e, 'brown');
			return 'rabbit/rabbit_' + (v === 'evil' ? 'caerbannog' : v) + baby(e);
		},
		shadow: 0.3, anim: 'rabbit',
	},
	ravager: { layer: 'ravager#main', texture: 'illager/ravager', shadow: 1.1, anim: 'ravager' },
	salmon: {
		layer: e => ({ small: 'salmon_small#main', large: 'salmon_large#main' })[variant(e, 'medium')] || 'salmon#main',
		texture: 'fish/salmon', shadow: 0.4, anim: 'fish', fish: true,
	},
	sheep: {
		layer: e => (e.baby ? 'sheep_baby#main' : 'sheep#main'), texture: e => 'sheep/sheep' + baby(e), shadow: 0.7, anim: 'sheep',
		layers: [
			{ layer: 'sheep#wool_undercoat', texture: 'sheep/sheep_wool_undercoat', when: e => !e.baby && !(e.d && e.d.sheared), color: e => sheepColor(e) },
			{ layer: e => (e.baby ? 'sheep_baby#wool' : 'sheep#wool'), texture: e => 'sheep/sheep_wool' + baby(e), when: e => !(e.d && e.d.sheared), color: e => sheepColor(e) },
		],
	},
	shulker: {
		layer: 'shulker#main', texture: e => (e.d && e.d.color ? 'shulker/shulker_' + strip(e.d.color) : 'shulker/shulker'), shadow: 0, anim: 'shulker', shulker: true,
	},
	silverfish: { layer: 'silverfish#main', texture: 'silverfish/silverfish', shadow: 0.3, anim: 'crawler' },
	skeleton: { layer: 'skeleton#main', texture: 'skeleton/skeleton', shadow: 0.5, anim: 'skeleton', armor: 'skeleton' },
	skeleton_horse: { layer: e => (e.baby ? 'skeleton_horse_baby#main' : 'skeleton_horse#main'), texture: e => 'horse/horse_skeleton' + baby(e), shadow: 0.75, anim: 'horse', body: e => (e.baby ? [] : bodyLayers(e, 'horse_body', 'undead_horse_armor#main')), saddle: ['skeleton_horse#saddle', 'equipment/skeleton_horse_saddle/saddle'] },
	slime: { layer: 'slime#main', texture: 'slime/slime', shadow: 0.25, anim: 'none', slime: true, layers: [{ layer: 'slime#outer', texture: 'slime/slime', mode: 'translucent' }] },
	sniffer: { layer: e => (e.baby ? 'sniffer_baby#main' : 'sniffer#main'), texture: e => (e.baby ? 'sniffer/snifflet' : 'sniffer/sniffer'), shadow: 1.1, anim: 'sniffer' },
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
	turtle: { layer: e => (e.baby ? 'turtle_baby#main' : 'turtle#main'), texture: e => 'turtle/turtle' + baby(e), shadow: 0.7, anim: 'turtle' },
	vex: { layer: 'vex#main', texture: e => (e.d && e.d.charging ? 'illager/vex_charging' : 'illager/vex'), shadow: 0.3, anim: 'vex', fullBright: true },
	villager: { villager: 'villager', shadow: 0.5, anim: 'villager' },
	vindicator: { layer: 'vindicator#main', texture: 'illager/vindicator', shadow: 0.5, anim: 'illager' },
	wandering_trader: { layer: 'wandering_trader#main', texture: 'wandering_trader/wandering_trader', shadow: 0.5, anim: 'villager' },
	warden: {
		layer: 'warden#main', texture: 'warden/warden', shadow: 0.9, anim: 'warden',
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
		shadow: 0.5, anim: 'wolf', body: e => (e.baby ? [] : wolfArmor(e)),
		layers: [
			{ layer: e => (e.baby ? 'wolf_baby#main' : 'wolf#main'), texture: e => 'wolf/wolf_collar' + baby(e), when: e => e.d && e.d.tame, color: e => dyeRgb(e.d.collar || 'red') },
		],
	},
	zoglin: { layer: e => (e.baby ? 'zoglin_baby#main' : 'zoglin#main'), texture: e => 'hoglin/zoglin' + baby(e), shadow: 0.7, anim: 'hoglin' },
	zombie: { layer: e => (e.baby ? 'zombie_baby#main' : 'zombie#main'), texture: e => 'zombie/zombie' + baby(e), shadow: 0.5, anim: 'zombie', armor: 'zombie' },
	zombie_horse: { layer: e => (e.baby ? 'zombie_horse_baby#main' : 'zombie_horse#main'), texture: e => 'horse/horse_zombie' + baby(e), shadow: 0.75, anim: 'horse', body: e => (e.baby ? [] : bodyLayers(e, 'horse_body', 'undead_horse_armor#main')), saddle: ['zombie_horse#saddle', 'equipment/zombie_horse_saddle/saddle'] },
	zombie_nautilus: {
		layer: e => (variant(e, 'temperate') === 'warm' ? 'zombie_nautilus_coral#main' : 'zombie_nautilus#main'),
		texture: e => (variant(e, 'temperate') === 'warm' ? 'nautilus/zombie_nautilus_coral' : 'nautilus/zombie_nautilus'), shadow: 0.7, anim: 'nautilus',
		body: e => (e.baby ? [] : bodyLayers(e, 'nautilus_body', 'nautilus_armor#main')), saddle: ['nautilus#saddle', 'equipment/nautilus_saddle/saddle'],
	},
	zombie_villager: { villager: 'zombie_villager', shadow: 0.5, anim: 'zombie', armor: 'zombie_villager' },
	zombified_piglin: { layer: e => (e.baby ? 'zombified_piglin_baby#main' : 'zombified_piglin#main'), texture: e => 'piglin/zombified_piglin' + baby(e), shadow: 0.5, anim: 'zombie', armor: 'zombified_piglin' },
};

function pandaGene(e) {
	const main = strip(e.d && e.d.gene) || 'normal';
	const hidden = strip(e.d && e.d.hiddenGene) || 'normal';
	// Panda.getVariant: recessive genes (brown, weak) only show when both genes match.
	if ((main === 'brown' || main === 'weak') && hidden !== main) return 'normal';
	return main;
}

/** ColorLerper.Type.SHEEP.getColor: white is 0xE6E6E6, the other dye colours darkened to 75 % (floored). */
function sheepRgb(color) {
	if (color === 'white') return [0xe6, 0xe6, 0xe6];
	const c = DYE[color] ?? 0xffffff;
	return [c >> 16 & 255, c >> 8 & 255, c & 255].map(v => clamp(Math.floor(v * 0.75), 0, 255));
}

/**
 * SheepRenderState.getWoolColor: the dye colour, or for a sheep named jeb_ ColorLerper.getLerpedColor(SHEEP,
 * ageInTicks): every dye colour in turn (DyeColor's order), 25 ticks each, blended like ARGB.srgbLerp.
 */
function sheepColor(e) {
	if (e.name === 'jeb_') {
		const colors = Object.keys(DYE);
		const age = Math.max(0, e.age || 0);
		const tick = Math.floor(age);
		const value = Math.floor(tick / 25);
		const a = sheepRgb(colors[value % colors.length]), b = sheepRgb(colors[(value + 1) % colors.length]);
		const t = (tick % 25 + (age - tick)) / 25;
		return [0, 1, 2].map(i => (a[i] + Math.floor(t * (b[i] - a[i]))) / 255).concat(1);
	}
	return sheepRgb(strip(e.d && e.d.color) || 'white').map(v => v / 255).concat(1);
}

const TROPICAL_SMALL = ['kob', 'sunstreak', 'snooper', 'dasher', 'brinely', 'spotty'];
const TROPICAL_LARGE = ['flopper', 'stripey', 'glitter', 'blockfish', 'betty', 'clayfish'];

/** Armour materials of humanoid armour items (only for a server that sends no equipment assets). */
const ARMOR_MATERIAL = { leather: 'leather', chainmail: 'chainmail', iron: 'iron', golden: 'gold', diamond: 'diamond', netherite: 'netherite', copper: 'copper', turtle: 'turtle_scute' };
const ARMOR_SLOTS = ['helmet', 'chestplate', 'leggings', 'boots'];

/** equipment/*.json of the client (EquipmentClientInfo) by equipment asset id, from the asset bundle. */
let EQUIPMENT = {};
export function setEquipment(map) {
	EQUIPMENT = map || {};
}

const idPath = id => String(id).replace(/^minecraft:/, '');
const opaqueRgb = argb => [((argb >> 16) & 255) / 255, ((argb >> 8) & 255) / 255, (argb & 255) / 255, 1];

/**
 * EquipmentLayerRenderer.renderLayers: what to draw for one worn piece ({a: equipment asset, c: dye,
 * t: trim}, as the server sends it in "eq") with the layer type's textures on the model layer `layer`.
 * Dyeable layers take the dye or their undyed colour (and are left out without either); the glint goes on
 * the first layer drawn; the trim (not on baby armour) is its pattern texture recoloured with the material's
 * palette, unless the equipment overrides it (iron trims on iron armour use the darker iron palette).
 */
export function equipmentLayers(entry, layerType, layer, foil = 0) {
	const info = entry && EQUIPMENT[entry.a];
	if (!info) return null;
	const out = [];
	let glint = foil;
	for (const l of (info.layers && info.layers[layerType]) || []) {
		let color = null;
		if (l.dyeable) {
			const rgb = entry.c ?? l.dyeable.color_when_undyed;
			if (rgb === undefined || rgb === null) continue;
			color = opaqueRgb(rgb);
		}
		out.push({ layer, texture: 'equipment/' + layerType + '/' + idPath(l.texture), color, foil: glint, playerTexture: !!l.use_player_texture });
		glint = 0;
	}
	if (out.length && entry.t && layerType !== 'humanoid_baby') {
		const [pattern, asset, material, palette] = entry.t;
		let texture = asset;
		let paletteId = palette;
		for (const override of info.trim_overrides || []) {
			const when = override.when || {};
			if ((!when.material || when.material === material) && (!when.pattern || when.pattern === pattern)) {
				texture = override.texture || texture;
				paletteId = override.palette || null;
				break;
			}
		}
		const [ns, path] = String(texture).includes(':') ? String(texture).split(':') : ['minecraft', String(texture)];
		out.push({ layer, texture: { paletted: ns + ':trims/entity/' + layerType + '/' + path, palette: paletteId }, color: null, foil: 0 });
	}
	return out;
}

export function armorLayers(prefix, e) {
	if (!e.armor && !e.eq) return [];
	const out = [];
	const stand = strip(e.type) === 'armor_stand';
	for (let i = 0; i < 4; i++) {
		const slot = ARMOR_SLOTS[i];
		const layer = stand ? prefix + (e.baby ? '_small' : '') + '#' + slot : prefix + (e.baby ? '_baby' : '') + '#' + slot;
		// foil: the "foil" bit of this slot (the piece has the enchantment glint)
		const foil = 4 << i;
		const entry = e.eq && e.eq[i];
		if (entry) {
			// HumanoidArmorLayer: baby armour (not on small armour stands), the inner model for leggings
			const type = e.baby && !stand ? 'humanoid_baby' : slot === 'leggings' ? 'humanoid_leggings' : 'humanoid';
			const layers = equipmentLayers(entry, type, layer, foil);
			if (layers) {
				out.push(...layers);
				continue;
			}
		}
		const item = strip(e.armor && e.armor[i]);
		if (!item) continue;
		const m = /^([a-z]+)_(helmet|chestplate|leggings|boots)$/.exec(item);
		if (!m || !ARMOR_MATERIAL[m[1]]) continue;
		const material = ARMOR_MATERIAL[m[1]];
		const folder = slot === 'leggings' ? 'humanoid_leggings' : (e.baby ? 'humanoid_baby' : 'humanoid');
		out.push({ layer, texture: 'equipment/' + folder + '/' + material, color: material === 'leather' ? [0xa0 / 255, 0x65 / 255, 0x40 / 255, 1] : null, foil });
		if (material === 'leather') out.push({ layer, texture: 'equipment/' + folder + '/leather_overlay' });
	}
	return out;
}

/** SimpleEquipmentLayer of mobs wearing body armour, a carpet or a harness: the layer type and model layer. */
function bodyLayers(e, type, layer) {
	return equipmentLayers(e.eq && e.eq[4], type, layer, 128) || [];
}

/** WolfArmorLayer: the armour, then its cracks (translucent) once it is worn down (Crackiness.WOLF_ARMOR). */
function wolfArmor(e) {
	const layers = bodyLayers(e, 'wolf_body', 'wolf_armor#main');
	const cracks = layers.length && e.eq[4].k;
	if (cracks) layers.push({ layer: 'wolf_armor#main', texture: 'wolf/wolf_armor_crackiness_' + cracks, color: null, foil: 0, mode: 'translucent' });
	return layers;
}

const VILLAGER_LEVELS = [null, 'stone', 'iron', 'gold', 'emerald', 'diamond'];

/**
 * Resolves what to draw for an entity: {layers: [{layer, texture, mode, color}], def, anim} or null.
 * Textures are paths below textures/entity (or {skin} for players).
 */
export function describeMob(e) {
	const type = strip(e.type);
	const def = MOBS[type] || autoMob(type);
	if (!def || def.special) return def ? { def, special: def.special } : null;
	const value = (v, fallback) => (typeof v === 'function' ? v(e) : v ?? fallback);
	const out = [];
	const add = (layer, texture, extra = {}) => out.push({ layer: 'minecraft:' + layer, texture, mode: extra.mode || 'cutout', color: extra.color || null });

	if (def.player) {
		const slim = e.slim;
		add(slim ? 'player_slim#main' : 'player#main', e.skinTexture || { skin: e.uuid }, {});
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
	// Equipment layers (saddle, armour) are drawn on invisible mobs too.
	if (def.saddle && e.saddle) { add(def.saddle[0], def.saddle[1]); out[out.length - 1].equipment = true; }
	// HumanoidArmorLayer and SimpleEquipmentLayer draw with armorCutoutNoCull
	if (def.armor) out.push(...armorLayers('minecraft:' + def.armor, e).map(l => ({ ...l, mode: 'cutout_nocull', equipment: true })));
	if (def.body) out.push(...def.body(e).map(l => ({ ...l, layer: 'minecraft:' + l.layer, mode: l.mode || 'cutout_nocull', equipment: true })));
	const chest = strip(e.armor && e.armor[1]);
	const showCape = def.player && (e.parts === undefined || !!(e.parts & 1));
	// the skin's cape: the profile's (Mojang) cape, or a mannequin's cape texture (its profile's skin patch)
	const cape = e.capeTexture || (e.uuid ? { cape: e.uuid, name: e.skinName ?? e.name } : null);
	if (def.player && showCape && chest !== 'elytra' && cape) {
		// CapeLayer (not on invisible players); a chestplate moves the cape out a little
		const chestplate = /_chestplate$/.test(chest);
		out.push({ layer: 'minecraft:player#cape', texture: cape, mode: 'cutout', color: null,
			offset: chestplate ? [0, -0.053125, 0.06875] : null });
	}
	if (def.armor && chest === 'elytra') {
		// WingsLayer: the skin's elytra texture, else its cape when shown, else the elytra texture
		const fallback = 'equipment/wings/elytra';
		const texture = e.elytraTexture || (showCape && cape ? (typeof cape === 'string' ? cape : { ...cape, fallback }) : fallback);
		out.push({ layer: e.baby ? 'minecraft:elytra_baby#main' : 'minecraft:elytra#main', texture,
			mode: 'cutout', color: null, equipment: true, offset: [0, 0, 0.125], foil: 8 });
	}
	return { def, layers: out, anim: ANIMS[def.anim] || ANIMS.generic, shadow: value(def.shadow, 0.5) };
}

export function isKnownMob(type) {
	const name = strip(type);
	return !!(MOBS[name] || autoMob(name));
}

let autoResolver = null;
const autoMobs = new Map();

/**
 * Mobs the table above does not know (a newer game version's): entities.js finds their model layer and texture
 * by the game's naming ("<name>#main", textures/entity/<name>/<name>.png). The resolver returns undefined while
 * the models or the texture list are still loading.
 */
export function setAutoMobResolver(resolver) {
	autoResolver = resolver;
	autoMobs.clear();
}

function autoMob(type) {
	if (!autoResolver) return null;
	if (autoMobs.has(type)) return autoMobs.get(type);
	const def = autoResolver(type);
	if (def === undefined) return null;
	autoMobs.set(type, def);
	return def;
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
			texture: CHESTS[name] + (kind === 'single' ? '' : '_' + kind), yRot: FACING_ROT[props.facing || 'north'] ?? 180, props,
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
	names.push('end_portal', 'end_gateway', 'conduit');
	return names.map(n => 'minecraft:' + n);
})();
