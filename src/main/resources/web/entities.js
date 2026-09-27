// Live entities: interpolation between server snapshots, simple Minecraft-like
// models (players with their real skins, mobs as coloured box models) and labels.

import {
	multiply, translation, rotationX, rotationY, rotationZ, scaling,
	lerp, lerpAngle, wrapDegrees, transformPoint,
} from './math.js';
import { itemColor } from './blocks.js';

const FLOATS = 11; // pos3 normal3 uv2 color3
const DEG = Math.PI / 180;

// --- geometry -------------------------------------------------------------

const BOX_FACES = [
	{ n: [0, 1, 0], c: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]], shade: 1.0 },
	{ n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], shade: 0.7 },
	{ n: [0, 0, -1], c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], shade: 0.85 },
	{ n: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], shade: 0.95 },
	{ n: [-1, 0, 0], c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], shade: 0.9 },
	{ n: [1, 0, 0], c: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], shade: 0.9 },
];

/** UV rectangles (pixels) for Minecraft's box unwrap, in BOX_FACES order. */
function boxUv(u, v, w, h, d) {
	return [
		[u + d, v, u + d + w, v + d],
		[u + d + w, v, u + d + 2 * w, v + d],
		[u + 2 * d + w, v + d, u + 2 * d + 2 * w, v + d + h],
		[u + d, v + d, u + d + w, v + d + h],
		[u, v + d, u + d, v + d + h],
		[u + d + w, v + d, u + 2 * d + w, v + d + h],
	];
}

// Per face: which uv corner each geometric corner uses (0 = u0/v0, 1 = u1/v1).
const UV_CORNERS = [
	[[0, 0], [0, 1], [1, 1], [1, 0]],
	[[0, 0], [1, 0], [1, 1], [0, 1]],
	[[0, 1], [1, 1], [1, 0], [0, 0]],
	[[0, 1], [1, 1], [1, 0], [0, 0]],
	[[0, 1], [1, 1], [1, 0], [0, 0]],
	[[0, 1], [1, 1], [1, 0], [0, 0]],
];

/**
 * Appends a box to `out` (array of numbers). Coordinates in model pixels relative to the part pivot.
 * opts: {uv: [u, v], inflate, color: [r,g,b] or per-face array}
 */
function addBox(out, from, size, opts = {}) {
	const inflate = opts.inflate || 0;
	const x0 = from[0] - inflate, y0 = from[1] - inflate, z0 = from[2] - inflate;
	const x1 = from[0] + size[0] + inflate, y1 = from[1] + size[1] + inflate, z1 = from[2] + size[2] + inflate;
	const uvRects = opts.uv ? boxUv(opts.uv[0], opts.uv[1], size[0], size[1], size[2]) : null;
	const tw = opts.texWidth || 64, th = opts.texHeight || 64;
	const inset = 0.02;

	for (let f = 0; f < 6; f++) {
		const face = BOX_FACES[f];
		const base = opts.faceColors ? opts.faceColors[f] : (opts.color || [1, 1, 1]);
		const color = opts.uv ? [1, 1, 1] : [base[0] * face.shade, base[1] * face.shade, base[2] * face.shade];
		const verts = [];
		for (let k = 0; k < 4; k++) {
			const c = face.c[k];
			let u = 0, v = 0;
			if (uvRects) {
				const r = uvRects[f];
				const uc = UV_CORNERS[f][k];
				u = (uc[0] ? r[2] - inset : r[0] + inset) / tw;
				v = (uc[1] ? r[3] - inset : r[1] + inset) / th;
			}
			verts.push([c[0] ? x1 : x0, c[1] ? y1 : y0, c[2] ? z1 : z0, u, v]);
		}
		for (const k of [0, 1, 2, 0, 2, 3]) {
			const p = verts[k];
			out.push(p[0], p[1], p[2], face.n[0], face.n[1], face.n[2], p[3], p[4], color[0], color[1], color[2]);
		}
	}
}

function hex(h) {
	const v = parseInt(h.replace('#', ''), 16);
	return [(v >> 16) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

function darker(c, f = 0.7) {
	return [c[0] * f, c[1] * f, c[2] * f];
}

// --- model templates ------------------------------------------------------

/**
 * A template is {parts: {name: {pivot, data: number[]}}, height (px), family, textured}.
 * Parts are drawn at pivot with an animated rotation.
 */
function humanoid(o = {}) {
	const head = o.head ?? 8, bodyW = o.bodyW ?? 8, bodyH = o.bodyH ?? 12, bodyD = o.bodyD ?? 4;
	const armW = o.armW ?? 4, armLen = o.armLen ?? 12, legW = o.legW ?? 4, legLen = o.legLen ?? 12;
	const c = o.colors;
	const neck = legLen + bodyH;
	const parts = {};

	const headData = [];
	addBox(headData, [-head / 2, 0, -head / 2], [head, head, head], { color: c.head, faceColors: c.hair ? hairFaces(c.head, c.hair) : null });
	if (o.eyes !== false) {
		const eye = c.eyes || [0.1, 0.1, 0.12];
		addBox(headData, [-head / 2 + 1, head * 0.4, head / 2], [2, 1, 0.3], { color: eye });
		addBox(headData, [head / 2 - 3, head * 0.4, head / 2], [2, 1, 0.3], { color: eye });
	}
	if (o.nose) addBox(headData, [-1, head * 0.1, head / 2], [2, 4, 2], { color: darker(c.head, 0.85) });
	if (o.hat) addBox(headData, [-head / 2 - 1, head - 1, -head / 2 - 1], [head + 2, 3, head + 2], { color: o.hat });
	parts.head = { pivot: [0, neck, 0], data: headData };

	const bodyData = [];
	addBox(bodyData, [-bodyW / 2, -bodyH, -bodyD / 2], [bodyW, bodyH, bodyD], { color: c.body });
	if (o.robe) addBox(bodyData, [-bodyW / 2 - 0.5, -bodyH - legLen * 0.8, -bodyD / 2 - 0.5], [bodyW + 1, legLen * 0.8, bodyD + 1], { color: o.robe });
	parts.body = { pivot: [0, neck, 0], data: bodyData };

	const shoulderY = neck - 2;
	const armX = bodyW / 2 + armW / 2;
	for (const side of [-1, 1]) {
		const data = [];
		addBox(data, [-armW / 2, -armLen + 2, -armW / 2], [armW, armLen, armW], { color: c.arms || c.body });
		parts[side < 0 ? 'rightArm' : 'leftArm'] = { pivot: [side * armX, shoulderY, 0], data };
	}
	for (const side of [-1, 1]) {
		const data = [];
		addBox(data, [-legW / 2, -legLen, -legW / 2], [legW, legLen, legW], { color: c.legs || c.body });
		parts[side < 0 ? 'rightLeg' : 'leftLeg'] = { pivot: [side * legW / 2 * 0.95, legLen, 0], data };
	}

	return { family: 'humanoid', parts, height: neck + head };
}

function hairFaces(skin, hair) {
	return [hair, skin, hair, skin, skin, skin];
}

/** Player model with the real skin layout (64x64). */
function playerModel(slim) {
	const parts = {};
	const t = { texWidth: 64, texHeight: 64 };
	const head = [];
	addBox(head, [-4, 0, -4], [8, 8, 8], { ...t, uv: [0, 0] });
	addBox(head, [-4, 0, -4], [8, 8, 8], { ...t, uv: [32, 0], inflate: 0.5 });
	parts.head = { pivot: [0, 24, 0], data: head };

	const body = [];
	addBox(body, [-4, -12, -2], [8, 12, 4], { ...t, uv: [16, 16] });
	addBox(body, [-4, -12, -2], [8, 12, 4], { ...t, uv: [16, 32], inflate: 0.25 });
	parts.body = { pivot: [0, 24, 0], data: body };

	const aw = slim ? 3 : 4;
	const right = [];
	addBox(right, [slim ? -2 : -3, -10, -2], [aw, 12, 4], { ...t, uv: [40, 16] });
	addBox(right, [slim ? -2 : -3, -10, -2], [aw, 12, 4], { ...t, uv: [40, 32], inflate: 0.25 });
	parts.rightArm = { pivot: [-5, slim ? 21.5 : 22, 0], data: right };

	const left = [];
	addBox(left, [-1, -10, -2], [aw, 12, 4], { ...t, uv: [32, 48] });
	addBox(left, [-1, -10, -2], [aw, 12, 4], { ...t, uv: [48, 48], inflate: 0.25 });
	parts.leftArm = { pivot: [5, slim ? 21.5 : 22, 0], data: left };

	const rightLeg = [];
	addBox(rightLeg, [-2, -12, -2], [4, 12, 4], { ...t, uv: [0, 16] });
	addBox(rightLeg, [-2, -12, -2], [4, 12, 4], { ...t, uv: [0, 32], inflate: 0.25 });
	parts.rightLeg = { pivot: [-1.9, 12, 0], data: rightLeg };

	const leftLeg = [];
	addBox(leftLeg, [-2, -12, -2], [4, 12, 4], { ...t, uv: [16, 48] });
	addBox(leftLeg, [-2, -12, -2], [4, 12, 4], { ...t, uv: [0, 48], inflate: 0.25 });
	parts.leftLeg = { pivot: [1.9, 12, 0], data: leftLeg };

	return { family: 'humanoid', parts, height: 32, textured: true };
}

function quadruped(o) {
	const legH = o.legH ?? 6, legW = o.legW ?? 4;
	const bodyW = o.bodyW ?? 10, bodyH = o.bodyH ?? 8, bodyL = o.bodyL ?? 16;
	const head = o.headSize ?? [8, 8, 6];
	const c = o.colors;
	const parts = {};

	const body = [];
	addBox(body, [-bodyW / 2, 0, -bodyL / 2], [bodyW, bodyH, bodyL], { color: c.body, faceColors: c.back ? [c.back, c.body, c.body, c.body, c.body, c.body] : null });
	if (o.spots) {
		addBox(body, [-bodyW / 2 - 0.1, bodyH * 0.3, -bodyL * 0.2], [bodyW + 0.2, bodyH * 0.45, bodyL * 0.35], { color: o.spots });
	}
	if (o.hump) addBox(body, [-3, bodyH, -3], [6, o.hump, 8], { color: c.body });
	parts.body = { pivot: [0, legH, 0], data: body };

	const headData = [];
	const neckY = legH + bodyH * (o.headRaise ?? 0.75);
	addBox(headData, [-head[0] / 2, -head[1] / 2, 0], head, { color: c.head || c.body });
	const eye = [0.08, 0.08, 0.08];
	addBox(headData, [-head[0] / 2 + 0.5, head[1] * 0.1, head[2]], [1.5, 1.5, 0.3], { color: eye });
	addBox(headData, [head[0] / 2 - 2, head[1] * 0.1, head[2]], [1.5, 1.5, 0.3], { color: eye });
	if (o.snout) addBox(headData, [-o.snout[0] / 2, -head[1] / 2, head[2]], o.snout, { color: o.snoutColor || darker(c.head || c.body, 0.85) });
	if (o.horns) {
		addBox(headData, [-head[0] / 2 - 1, head[1] / 2 - 1, 1], [1, 3, 1], { color: o.horns });
		addBox(headData, [head[0] / 2, head[1] / 2 - 1, 1], [1, 3, 1], { color: o.horns });
	}
	if (o.ears) {
		addBox(headData, [-head[0] / 2, head[1] / 2, 1], [2, 2, 1], { color: c.head || c.body });
		addBox(headData, [head[0] / 2 - 2, head[1] / 2, 1], [2, 2, 1], { color: c.head || c.body });
	}
	let neckData = null;
	if (o.neck) {
		neckData = [];
		addBox(neckData, [-o.neck[0] / 2, 0, -o.neck[2] / 2], o.neck, { color: c.body });
	}
	if (neckData) {
		parts.neck = { pivot: [0, neckY, bodyL / 2 - 2], data: neckData };
		parts.head = { pivot: [0, neckY + o.neck[1], bodyL / 2 - 2], data: headData };
	} else {
		parts.head = { pivot: [0, neckY, bodyL / 2 - 1], data: headData };
	}

	if (o.tail) {
		const tail = [];
		addBox(tail, [-o.tail[0] / 2, -o.tail[1], -o.tail[2]], o.tail, { color: o.tailColor || c.body });
		parts.tail = { pivot: [0, legH + bodyH - 1, -bodyL / 2], data: tail };
	}

	const lx = bodyW / 2 - legW / 2;
	const lz = bodyL / 2 - legW / 2 - 1;
	const legColor = c.legs || c.body;
	for (const [name, x, z] of [['frontRight', -lx, lz], ['frontLeft', lx, lz], ['hindRight', -lx, -lz], ['hindLeft', lx, -lz]]) {
		const data = [];
		addBox(data, [-legW / 2, -legH, -legW / 2], [legW, legH, legW], { color: legColor });
		parts[name] = { pivot: [x, legH, z], data };
	}

	const top = Math.max(legH + bodyH, neckY + (o.neck ? o.neck[1] : 0) + head[1] / 2);
	return { family: 'quadruped', parts, height: top };
}

function creeper(color) {
	const parts = {};
	const head = [];
	addBox(head, [-4, 0, -4], [8, 8, 8], { color });
	const face = [0.05, 0.1, 0.05];
	addBox(head, [-3, 4, 4], [2, 2, 0.3], { color: face });
	addBox(head, [1, 4, 4], [2, 2, 0.3], { color: face });
	addBox(head, [-1, 1, 4], [2, 3, 0.3], { color: face });
	parts.head = { pivot: [0, 18, 0], data: head };
	const body = [];
	addBox(body, [-4, 0, -2], [8, 12, 4], { color });
	parts.body = { pivot: [0, 6, 0], data: body };
	for (const [name, x, z] of [['frontRight', -2, 4], ['frontLeft', 2, 4], ['hindRight', -2, -4], ['hindLeft', 2, -4]]) {
		const data = [];
		addBox(data, [-2, -6, -2], [4, 6, 4], { color: darker(color, 0.85) });
		parts[name] = { pivot: [x, 6, z], data };
	}
	return { family: 'quadruped', parts, height: 26 };
}

function spider(color, eyes) {
	const parts = {};
	const body = [];
	addBox(body, [-3, 0, -3], [6, 6, 6], { color });
	addBox(body, [-5, -1, -15], [10, 8, 12], { color: darker(color, 0.9) });
	parts.body = { pivot: [0, 6, 0], data: body };
	const head = [];
	addBox(head, [-4, -4, 0], [8, 8, 8], { color });
	addBox(head, [-3, 1, 8], [2, 1, 0.3], { color: eyes });
	addBox(head, [1, 1, 8], [2, 1, 0.3], { color: eyes });
	parts.head = { pivot: [0, 9, 3], data: head };
	for (let i = 0; i < 8; i++) {
		const side = i < 4 ? -1 : 1;
		const data = [];
		addBox(data, [side < 0 ? -16 : 0, -1, -1], [16, 2, 2], { color: darker(color, 0.8) });
		parts['leg' + i] = { pivot: [side * 4, 9, 2 - (i % 4) * 2], data };
	}
	return { family: 'spider', parts, height: 12 };
}

function blob(color, inner) {
	const parts = {};
	const body = [];
	addBox(body, [-4, 0, -4], [8, 8, 8], { color });
	if (inner) addBox(body, [-3, 1, -3], [6, 6, 6.2], { color: inner });
	parts.body = { pivot: [0, 0, 0], data: body };
	return { family: 'blob', parts, height: 8 };
}

function fish(o) {
	const parts = {};
	const body = [];
	addBox(body, [-o.w / 2, 0, -o.l / 2], [o.w, o.h, o.l], { color: o.color, faceColors: o.belly ? [o.color, o.belly, o.color, o.color, o.color, o.color] : null });
	addBox(body, [-o.w / 2 - 0.1, o.h * 0.55, o.l / 2 - 2], [0.3, 1, 1], { color: [0.05, 0.05, 0.05] });
	addBox(body, [o.w / 2 - 0.2, o.h * 0.55, o.l / 2 - 2], [0.3, 1, 1], { color: [0.05, 0.05, 0.05] });
	if (o.fin) addBox(body, [-0.5, o.h, -o.l / 4], [1, o.fin, o.l / 2], { color: darker(o.color, 0.8) });
	parts.body = { pivot: [0, 0, 0], data: body };
	const tail = [];
	addBox(tail, [-0.5, -o.h * 0.1, -o.l * 0.45], [1, o.h * 1.2, o.l * 0.45], { color: darker(o.color, 0.85) });
	parts.tail = { pivot: [0, 0, -o.l / 2], data: tail };
	if (o.tentacles) {
		for (let i = 0; i < 8; i++) {
			const data = [];
			const a = i / 8 * Math.PI * 2;
			addBox(data, [-0.75, -o.tentacles, -0.75], [1.5, o.tentacles, 1.5], { color: darker(o.color, 0.9) });
			parts['t' + i] = { pivot: [Math.cos(a) * o.w * 0.35, 0, Math.sin(a) * o.l * 0.35], data };
		}
	}
	return { family: 'fish', parts, height: o.h };
}

function flyer(o) {
	const parts = {};
	const body = [];
	addBox(body, [-o.w / 2, 0, -o.l / 2], [o.w, o.h, o.l], { color: o.color, faceColors: o.stripes ? [o.color, o.color, o.stripes, o.stripes, o.stripes, o.stripes] : null });
	addBox(body, [-o.w / 2 + 0.5, o.h * 0.55, o.l / 2], [1.2, 1.2, 0.3], { color: [0.05, 0.05, 0.05] });
	addBox(body, [o.w / 2 - 1.7, o.h * 0.55, o.l / 2], [1.2, 1.2, 0.3], { color: [0.05, 0.05, 0.05] });
	parts.body = { pivot: [0, o.y ?? 0, 0], data: body };
	for (const side of [-1, 1]) {
		const data = [];
		addBox(data, [side < 0 ? -o.wing : 0, 0, -o.l * 0.35], [o.wing, 0.5, o.l * 0.7], { color: o.wingColor || o.color });
		parts[side < 0 ? 'rightWing' : 'leftWing'] = { pivot: [side * o.w / 2, (o.y ?? 0) + o.h - 0.5, 0], data };
	}
	return { family: 'flyer', parts, height: (o.y ?? 0) + o.h };
}

function block(color, size = 16, family = 'box') {
	const parts = {};
	const data = [];
	addBox(data, [-size / 2, 0, -size / 2], [size, size, size], { color });
	parts.body = { pivot: [0, 0, 0], data };
	return { family, parts, height: size };
}

/** Generic entity: a box matching its hitbox, drawn in model pixels (1 px = 1/16 block). */
function hitbox(color, w, h) {
	const parts = {};
	const data = [];
	addBox(data, [-w * 8, 0, -w * 8], [w * 16, h * 16, w * 16], { color, faceColors: [darker(color, 1.1), darker(color, 0.8), color, color, color, color] });
	parts.body = { pivot: [0, 0, 0], data };
	return { family: 'box', parts, height: h * 16, fixedScale: true };
}

const C = hex;
const MOBS = {
	zombie: () => humanoid({ colors: { head: C('#5e8c4a'), body: C('#2f8e8e'), arms: C('#5e8c4a'), legs: C('#3b3a8f') } }),
	husk: () => humanoid({ colors: { head: C('#9f8f5e'), body: C('#7a6a45'), arms: C('#9f8f5e'), legs: C('#5a4a35') } }),
	drowned: () => humanoid({ colors: { head: C('#4e8c84'), body: C('#5a9e7e'), arms: C('#4e8c84'), legs: C('#3f6f6a') } }),
	zombie_villager: () => humanoid({ nose: true, colors: { head: C('#5e8c4a'), body: C('#6a4a2a'), arms: C('#5e8c4a'), legs: C('#4a3420') } }),
	skeleton: () => humanoid({ armW: 2, legW: 2, colors: { head: C('#c4c4c4'), body: C('#b0b0b0'), arms: C('#c4c4c4'), legs: C('#c4c4c4') } }),
	stray: () => humanoid({ armW: 2, legW: 2, colors: { head: C('#9db1b1'), body: C('#7f9a9a'), arms: C('#9db1b1'), legs: C('#9db1b1') } }),
	bogged: () => humanoid({ armW: 2, legW: 2, colors: { head: C('#8f9a6a'), body: C('#6f7a4a'), arms: C('#8f9a6a'), legs: C('#8f9a6a') } }),
	wither_skeleton: () => humanoid({ armW: 2, legW: 2, colors: { head: C('#2a2a2a'), body: C('#1f1f1f'), arms: C('#2a2a2a'), legs: C('#2a2a2a'), eyes: C('#555555') } }),
	pillager: () => humanoid({ nose: true, colors: { head: C('#8e8e8e'), body: C('#3f3f4a'), arms: C('#3f3f4a'), legs: C('#2c2c34') } }),
	vindicator: () => humanoid({ nose: true, colors: { head: C('#8e8e8e'), body: C('#2e3c3f'), arms: C('#2e3c3f'), legs: C('#1e2a2c') } }),
	evoker: () => humanoid({ nose: true, robe: C('#1e1e1e'), colors: { head: C('#8e8e8e'), body: C('#1e1e1e'), arms: C('#1e1e1e'), legs: C('#1e1e1e') } }),
	illusioner: () => humanoid({ nose: true, robe: C('#2a3f7a'), colors: { head: C('#8e8e8e'), body: C('#2a3f7a'), arms: C('#2a3f7a'), legs: C('#2a3f7a') } }),
	witch: () => humanoid({ nose: true, robe: C('#3d2a4a'), hat: C('#1f1f1f'), colors: { head: C('#a07a5a'), body: C('#3d2a4a'), arms: C('#a07a5a'), legs: C('#3d2a4a') } }),
	villager: () => humanoid({ nose: true, robe: C('#6a4a2a'), head: 9, colors: { head: C('#b78a6a'), body: C('#6a4a2a'), arms: C('#6a4a2a'), legs: C('#4a3420') } }),
	wandering_trader: () => humanoid({ nose: true, robe: C('#2f4a8a'), colors: { head: C('#b78a6a'), body: C('#2f4a8a'), arms: C('#2f4a8a'), legs: C('#223666') } }),
	piglin: () => humanoid({ nose: true, colors: { head: C('#e8a0a0'), body: C('#6a4a2a'), arms: C('#e8a0a0'), legs: C('#4a3420') } }),
	piglin_brute: () => humanoid({ nose: true, colors: { head: C('#e8a0a0'), body: C('#2a2a2a'), arms: C('#e8a0a0'), legs: C('#1f1f1f') } }),
	zombified_piglin: () => humanoid({ nose: true, colors: { head: C('#e8a0a0'), body: C('#6baa5a'), arms: C('#e8a0a0'), legs: C('#4a3420') } }),
	enderman: () => humanoid({ armW: 2, legW: 2, armLen: 30, legLen: 30, colors: { head: C('#161616'), body: C('#111111'), eyes: C('#cc66ff') } }),
	iron_golem: () => humanoid({ head: 10, bodyW: 18, bodyH: 12, bodyD: 10, armW: 6, armLen: 30, legW: 6, legLen: 16, nose: true, colors: { head: C('#d8d2c8'), body: C('#cfc8bc'), arms: C('#d8d2c8'), legs: C('#bdb6aa') } }),
	snow_golem: () => humanoid({ armW: 1, armLen: 10, legLen: 0, bodyH: 18, bodyW: 10, bodyD: 10, head: 8, colors: { head: C('#e3901d'), body: C('#f2f2f2'), arms: C('#6a4a2a') } }),
	armor_stand: () => humanoid({ armW: 2, legW: 2, eyes: false, colors: { head: C('#a2834f'), body: C('#8a6a3d'), arms: C('#a2834f'), legs: C('#a2834f') } }),
	giant: () => MOBS.zombie(),
	creaking: () => humanoid({ armW: 3, legW: 3, armLen: 18, legLen: 18, colors: { head: C('#4a3a30'), body: C('#3a2e26'), eyes: C('#ff8a2a') } }),
	vex: () => humanoid({ armW: 2, legW: 2, legLen: 6, colors: { head: C('#9aaac8'), body: C('#8a9ab8') } }),
	allay: () => humanoid({ armW: 2, legW: 2, legLen: 5, colors: { head: C('#6ac8e8'), body: C('#5ab8d8') } }),
	blaze: () => humanoid({ armW: 2, legW: 2, armLen: 8, legLen: 8, colors: { head: C('#f2b01d'), body: C('#d88a10') } }),
	breeze: () => humanoid({ armW: 2, legW: 3, legLen: 10, colors: { head: C('#9aa8e8'), body: C('#8a98d8') } }),

	creeper: () => creeper(C('#4faf3a')),
	spider: () => spider(C('#342e28'), C('#b01818')),
	cave_spider: () => spider(C('#1f3a40'), C('#b01818')),
	slime: () => blob(C('#6fbf4f'), C('#4f9f3f')),
	magma_cube: () => blob(C('#5a1a0a'), C('#e0741a')),

	cow: () => quadruped({ legH: 12, bodyW: 12, bodyH: 10, bodyL: 18, headSize: [8, 8, 6], horns: C('#d8d2c8'), colors: { body: C('#443626'), head: C('#3a2e22') }, spots: C('#eaeaea') }),
	mooshroom: () => quadruped({ legH: 12, bodyW: 12, bodyH: 10, bodyL: 18, headSize: [8, 8, 6], horns: C('#d8d2c8'), colors: { body: C('#a0241a'), head: C('#8a1f16') }, spots: C('#d8d0c8') }),
	pig: () => quadruped({ legH: 6, bodyW: 10, bodyH: 8, bodyL: 16, headSize: [8, 8, 8], snout: [4, 3, 1], snoutColor: C('#e98a8a'), colors: { body: C('#f0a5a2') } }),
	sheep: () => quadruped({ legH: 12, bodyW: 10, bodyH: 8, bodyL: 16, headSize: [6, 6, 8], colors: { body: C('#eaeaea'), head: C('#d8b89a'), legs: C('#d8b89a') } }),
	goat: () => quadruped({ legH: 10, bodyW: 9, bodyH: 9, bodyL: 16, headSize: [5, 7, 8], horns: C('#a09a8a'), colors: { body: C('#d8d2c8') } }),
	horse: () => quadruped({ legH: 11, legW: 4, bodyW: 10, bodyH: 10, bodyL: 22, headSize: [6, 6, 11], neck: [4, 10, 7], ears: true, tail: [3, 14, 4], colors: { body: C('#8a5a30') }, tailColor: C('#3a2414') }),
	donkey: () => quadruped({ legH: 10, bodyW: 10, bodyH: 9, bodyL: 20, headSize: [6, 6, 10], neck: [4, 8, 6], ears: true, tail: [3, 12, 3], colors: { body: C('#7a6a5a') } }),
	mule: () => quadruped({ legH: 11, bodyW: 10, bodyH: 10, bodyL: 21, headSize: [6, 6, 10], neck: [4, 9, 6], ears: true, tail: [3, 12, 3], colors: { body: C('#5a3a2a') } }),
	skeleton_horse: () => quadruped({ legH: 11, legW: 3, bodyW: 9, bodyH: 9, bodyL: 22, headSize: [6, 6, 11], neck: [4, 10, 7], colors: { body: C('#c4c4c4') } }),
	zombie_horse: () => quadruped({ legH: 11, bodyW: 10, bodyH: 10, bodyL: 22, headSize: [6, 6, 11], neck: [4, 10, 7], colors: { body: C('#4a6a3a') } }),
	llama: () => quadruped({ legH: 14, bodyW: 12, bodyH: 10, bodyL: 18, headSize: [6, 6, 7], neck: [6, 14, 6], ears: true, colors: { body: C('#d8c8a8') } }),
	trader_llama: () => MOBS.llama(),
	camel: () => quadruped({ legH: 20, bodyW: 12, bodyH: 12, bodyL: 26, headSize: [6, 6, 10], neck: [5, 10, 6], hump: 5, colors: { body: C('#c89a5a') } }),
	wolf: () => quadruped({ legH: 8, legW: 2, bodyW: 6, bodyH: 6, bodyL: 14, headSize: [6, 6, 5], snout: [3, 3, 3], ears: true, tail: [2, 8, 2], colors: { body: C('#d8d0c8') } }),
	fox: () => quadruped({ legH: 6, legW: 2, bodyW: 6, bodyH: 6, bodyL: 12, headSize: [8, 6, 5], snout: [4, 2, 3], snoutColor: C('#f0f0f0'), ears: true, tail: [4, 9, 4], colors: { body: C('#e07a28') }, tailColor: C('#f0f0f0') }),
	cat: () => quadruped({ legH: 6, legW: 2, bodyW: 4, bodyH: 5, bodyL: 14, headSize: [5, 4, 5], ears: true, tail: [1, 8, 1], colors: { body: C('#d8a86a') } }),
	ocelot: () => MOBS.cat(),
	polar_bear: () => quadruped({ legH: 10, legW: 5, bodyW: 14, bodyH: 12, bodyL: 22, headSize: [7, 7, 8], snout: [5, 3, 3], ears: true, colors: { body: C('#f2f2f2') } }),
	panda: () => quadruped({ legH: 9, legW: 6, bodyW: 15, bodyH: 13, bodyL: 20, headSize: [10, 9, 8], ears: true, colors: { body: C('#f2f2f2'), legs: C('#1f1f1f') }, spots: C('#1f1f1f') }),
	hoglin: () => quadruped({ legH: 10, legW: 5, bodyW: 16, bodyH: 14, bodyL: 22, headSize: [12, 10, 12], horns: C('#e8e0c8'), colors: { body: C('#c88a6a') } }),
	zoglin: () => quadruped({ legH: 10, legW: 5, bodyW: 16, bodyH: 14, bodyL: 22, headSize: [12, 10, 12], horns: C('#e8e0c8'), colors: { body: C('#d88a8a') } }),
	strider: () => quadruped({ legH: 16, legW: 3, bodyW: 16, bodyH: 14, bodyL: 16, headSize: [0.1, 0.1, 0.1], colors: { body: C('#9a3a3a') } }),
	sniffer: () => quadruped({ legH: 8, legW: 6, bodyW: 22, bodyH: 18, bodyL: 30, headSize: [10, 10, 10], snout: [8, 4, 4], colors: { body: C('#8a3a2a'), head: C('#6a8a3a') } }),
	armadillo: () => quadruped({ legH: 3, legW: 2, bodyW: 7, bodyH: 6, bodyL: 9, headSize: [3, 4, 4], colors: { body: C('#a06a5a') } }),
	turtle: () => quadruped({ legH: 2, legW: 3, bodyW: 16, bodyH: 5, bodyL: 18, headSize: [5, 4, 5], colors: { body: C('#4a8a3a'), head: C('#5aa04a') } }),
	frog: () => quadruped({ legH: 2, legW: 3, bodyW: 7, bodyH: 5, bodyL: 9, headSize: [7, 3, 5], colors: { body: C('#c88a3a') } }),
	rabbit: () => quadruped({ legH: 3, legW: 2, bodyW: 5, bodyH: 5, bodyL: 7, headSize: [4, 4, 4], ears: true, colors: { body: C('#9a7a5a') } }),
	chicken: () => quadruped({ legH: 5, legW: 1, bodyW: 6, bodyH: 6, bodyL: 7, headSize: [4, 6, 3], headRaise: 1.1, snout: [2, 2, 2], snoutColor: C('#e8a020'), colors: { body: C('#f2f2f2'), legs: C('#e8a020') } }),
	ravager: () => quadruped({ legH: 14, legW: 7, bodyW: 20, bodyH: 16, bodyL: 28, headSize: [14, 16, 12], horns: C('#b8b0a0'), colors: { body: C('#5a5a5a') } }),
	happy_ghast: () => block(C('#f2f2f2'), 64, 'blob'),
	ghast: () => block(C('#f2f2f2'), 64, 'blob'),

	cod: () => fish({ w: 2, h: 4, l: 10, color: C('#b89a6a'), belly: C('#d8c8a8'), fin: 2 }),
	salmon: () => fish({ w: 3, h: 5, l: 12, color: C('#a0302a'), belly: C('#c8a8a0'), fin: 2 }),
	tropical_fish: () => fish({ w: 2, h: 5, l: 6, color: C('#e08a2a'), fin: 2 }),
	pufferfish: () => fish({ w: 5, h: 5, l: 5, color: C('#e0c83a') }),
	squid: () => fish({ w: 12, h: 16, l: 12, color: C('#2a3a5a'), tentacles: 12 }),
	glow_squid: () => fish({ w: 12, h: 16, l: 12, color: C('#2a8a8a'), tentacles: 12 }),
	dolphin: () => fish({ w: 8, h: 7, l: 20, color: C('#6a8aa0'), belly: C('#c8d0d8'), fin: 4 }),
	axolotl: () => fish({ w: 7, h: 4, l: 12, color: C('#e8a0c8') }),
	tadpole: () => fish({ w: 2, h: 2, l: 4, color: C('#5a3a2a') }),
	guardian: () => fish({ w: 12, h: 12, l: 12, color: C('#6aa090'), fin: 3 }),
	elder_guardian: () => fish({ w: 24, h: 24, l: 24, color: C('#c8c8b0'), fin: 5 }),

	bat: () => flyer({ w: 4, h: 5, l: 3, wing: 8, color: C('#3a2a1a'), y: 4 }),
	bee: () => flyer({ w: 5, h: 5, l: 8, wing: 5, color: C('#e8c83a'), stripes: C('#2a2016'), wingColor: C('#dfe8f0'), y: 2 }),
	parrot: () => flyer({ w: 3, h: 6, l: 3, wing: 4, color: C('#e02020'), wingColor: C('#2060e0'), y: 2 }),
	phantom: () => flyer({ w: 5, h: 3, l: 9, wing: 14, color: C('#3a4a8a'), wingColor: C('#4a5a9a') }),

	item: null,
	experience_orb: null,
};

// --- skins ----------------------------------------------------------------

function defaultSkinCanvas() {
	const canvas = document.createElement('canvas');
	canvas.width = 64;
	canvas.height = 64;
	const g = canvas.getContext('2d');
	const fill = (color, x, y, w, h) => { g.fillStyle = color; g.fillRect(x, y, w, h); };
	// head
	fill('#c69c6d', 0, 0, 32, 16);
	fill('#4a3222', 8, 0, 8, 8);
	fill('#4a3222', 0, 8, 32, 2);
	fill('#4a3222', 24, 8, 8, 8);
	fill('#ffffff', 9, 12, 2, 1); fill('#3a52a0', 10, 12, 1, 1);
	fill('#ffffff', 13, 12, 2, 1); fill('#3a52a0', 13, 12, 1, 1);
	fill('#8a5a3a', 11, 14, 2, 1);
	// body, arms, legs
	fill('#00a8a8', 16, 16, 24, 16);
	fill('#c69c6d', 40, 16, 16, 16); fill('#00a8a8', 40, 20, 16, 3);
	fill('#c69c6d', 32, 48, 16, 16); fill('#00a8a8', 32, 52, 16, 3);
	fill('#3b3b9b', 0, 16, 16, 16); fill('#555555', 0, 29, 16, 3);
	fill('#3b3b9b', 16, 48, 16, 16); fill('#555555', 16, 61, 16, 3);
	return canvas;
}

function normalizeSkin(image) {
	const canvas = document.createElement('canvas');
	canvas.width = 64;
	canvas.height = 64;
	const g = canvas.getContext('2d');
	g.drawImage(image, 0, 0);
	if (image.height === 32) {
		// Legacy 64x32 skins: the left limbs reuse the right ones.
		g.drawImage(image, 0, 16, 16, 16, 16, 48, 16, 16);
		g.drawImage(image, 40, 16, 16, 16, 32, 48, 16, 16);
	}
	return canvas;
}

// --- renderer -------------------------------------------------------------

export class EntityRenderer {
	constructor(renderer, labelContainer) {
		this.renderer = renderer;
		this.gl = renderer.gl;
		this.labels = labelContainer;
		this.templates = new Map();
		this.meshes = new Map();
		this.skins = new Map();
		this.states = new Map();
		this.frames = [];
		this.offset = null;
		this.typeHeights = new Map();
		this.showLabels = true;
		this.showAllLabels = false;
		this.showInvisible = false;
		this.defaultSkin = this.createTexture(defaultSkinCanvas());
		this.visibleCount = 0;
	}

	reset() {
		this.frames = [];
		this.offset = null;
		this.states.clear();
		for (const label of this.labels.querySelectorAll('.label')) label.remove();
	}

	createTexture(source) {
		const gl = this.gl;
		const texture = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		return texture;
	}

	skin(uuid, name) {
		let skin = this.skins.get(uuid);
		if (skin) return skin;
		skin = { texture: this.defaultSkin, slim: false };
		this.skins.set(uuid, skin);
		const url = '/skin/' + encodeURIComponent(uuid) + '?name=' + encodeURIComponent(name || '') + tokenSuffix('&');
		fetch(url, { credentials: 'same-origin' })
			.then(response => {
				if (!response.ok) throw new Error('no skin');
				skin.slim = response.headers.get('X-Skin-Model') === 'slim';
				return response.blob();
			})
			.then(blob => createImageBitmap(blob))
			.then(image => {
				skin.texture = this.createTexture(normalizeSkin(image));
			})
			.catch(() => {});
		return skin;
	}

	template(key, build) {
		let template = this.templates.get(key);
		if (!template) {
			template = build();
			for (const part of Object.values(template.parts)) {
				part.mesh = this.upload(part.data);
				part.data = null;
			}
			this.templates.set(key, template);
		}
		return template;
	}

	upload(data) {
		const gl = this.gl;
		const vao = gl.createVertexArray();
		const vbo = gl.createBuffer();
		gl.bindVertexArray(vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
		const stride = FLOATS * 4;
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
		gl.enableVertexAttribArray(1);
		gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
		gl.enableVertexAttribArray(2);
		gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 24);
		gl.enableVertexAttribArray(3);
		gl.vertexAttribPointer(3, 3, gl.FLOAT, false, stride, 32);
		gl.bindVertexArray(null);
		return { vao, count: data.length / FLOATS };
	}

	/** Called for every "entities" message. */
	push(frame, entityTicks) {
		const now = performance.now();
		const sample = now - frame.t * 50;
		// Track the smallest network delay seen, slowly relaxing so server lag is followed.
		this.offset = this.offset === null ? sample : Math.min(sample, this.offset + (sample - this.offset) * 0.02 + 0.05);
		const map = new Map();
		for (const e of frame.e) map.set(e.id, e);
		this.frames.push({ t: frame.t, map });
		while (this.frames.length > 40) this.frames.shift();
		this.delayTicks = Math.max(2, entityTicks * 2);
	}

	/** Entities interpolated for the current moment. */
	sample(now) {
		const frames = this.frames;
		if (frames.length === 0) return [];
		const renderTick = (now - this.offset) / 50 - this.delayTicks;
		let a = frames[0], b = frames[0];
		for (let i = frames.length - 1; i >= 0; i--) {
			if (frames[i].t <= renderTick) {
				a = frames[i];
				b = frames[Math.min(i + 1, frames.length - 1)];
				break;
			}
		}
		if (renderTick > frames[frames.length - 1].t) {
			a = b = frames[frames.length - 1];
		}
		const span = b.t - a.t;
		const t = span > 0 ? Math.max(0, Math.min(1, (renderTick - a.t) / span)) : 0;

		const result = [];
		for (const [id, ea] of a.map) {
			const eb = b.map.get(id);
			if (!eb) {
				if (t < 1 || a === b) result.push(ea);
				continue;
			}
			result.push({
				...eb,
				x: lerp(ea.x, eb.x, t),
				y: lerp(ea.y, eb.y, t),
				z: lerp(ea.z, eb.z, t),
				yaw: lerpAngle(ea.yaw, eb.yaw, t),
				pitch: lerp(ea.pitch, eb.pitch, t),
				body: ea.body !== undefined && eb.body !== undefined ? lerpAngle(ea.body, eb.body, t) : eb.body,
				head: ea.head !== undefined && eb.head !== undefined ? lerpAngle(ea.head, eb.head, t) : eb.head,
			});
		}
		for (const [id, eb] of b.map) {
			if (!a.map.has(id) && t > 0) result.push(eb);
		}
		return result;
	}

	modelFor(e) {
		const type = e.type.startsWith('minecraft:') ? e.type.slice(10) : e.type;
		if (e.type === 'minecraft:player') {
			const skin = this.skin(e.uuid, e.name);
			return { template: this.template(skin.slim ? 'player:slim' : 'player', () => playerModel(skin.slim)), texture: skin.texture, standing: 1.8 };
		}

		const builder = MOBS[type];
		if (builder) {
			return { template: this.template(type, builder), standing: this.standingHeight(type, e) };
		}
		if (type === 'item') {
			return { template: this.template('item:' + e.item, () => block(itemColor(e.item), 4, 'item')), standing: 0.25, fixed: true };
		}
		if (type === 'experience_orb') {
			return { template: this.template('xp', () => block(C('#b8f040'), 3, 'item')), standing: 0.2, fixed: true, emissive: true };
		}
		if (type === 'tnt') {
			return { template: this.template('tnt', () => block(C('#db4b2e'), 16)), standing: 1, fixed: true };
		}
		if (type.endsWith('arrow') || type === 'trident') {
			return { template: this.template('arrow', () => hitbox(C('#8a6a3d'), 0.08, 0.08)), standing: 0.1, fixed: true, arrow: true };
		}
		if (type.includes('minecart')) {
			return { template: this.template(type, () => hitbox(C('#6e6e6e'), 0.98, 0.7)), standing: 0.7, fixed: true };
		}
		if (type.endsWith('boat') || type.endsWith('raft')) {
			return { template: this.template(type, () => hitbox(C('#8a6a3d'), 1.375, 0.5)), standing: 0.56, fixed: true };
		}
		const color = hashColor(type);
		return { template: this.template('box:' + type + ':' + e.w + ':' + e.h, () => hitbox(color, e.w, e.h)), standing: e.h, fixed: true };
	}

	standingHeight(type, e) {
		if (!e.pose && !e.baby) {
			this.typeHeights.set(type, e.h);
			return e.h;
		}
		const known = this.typeHeights.get(type);
		if (known) return e.baby ? known * 0.5 : known;
		return e.baby ? e.h : e.h;
	}

	/** Advances per-entity animation state (limb swing, swing timers). */
	animate(e, now) {
		let s = this.states.get(e.id);
		if (!s) {
			s = { x: e.x, z: e.z, limbPos: 0, limbAmp: 0, last: now, swingStart: -1, deadStart: -1, seen: now };
			this.states.set(e.id, s);
		}
		const dt = Math.min(0.25, (now - s.last) / 1000);
		s.last = now;
		s.seen = now;
		const ticks = dt * 20;
		const dist = Math.hypot(e.x - s.x, e.z - s.z);
		s.x = e.x;
		s.z = e.z;
		const speed = ticks > 0 ? dist / ticks : 0;
		const target = Math.min(1, speed * 4);
		s.limbAmp += (target - s.limbAmp) * Math.min(1, 0.4 * ticks);
		s.limbPos += s.limbAmp * ticks;

		if (e.swing && (s.swingStart < 0 || now - s.swingStart > 300)) s.swingStart = now;
		s.swingProgress = s.swingStart >= 0 && now - s.swingStart < 300 ? (now - s.swingStart) / 300 : 0;
		if (e.dead) {
			if (s.deadStart < 0) s.deadStart = now;
		} else {
			s.deadStart = -1;
		}
		return s;
	}

	/** Part rotations [x, y, z] in radians, keyed by part name. */
	pose(template, e, s, time) {
		const r = {};
		const swing = Math.cos(s.limbPos * 0.6662) * 1.4 * s.limbAmp;
		const netHead = wrapDegrees((e.head ?? e.yaw) - (e.body ?? e.yaw));
		const headRot = [Math.max(-80, Math.min(80, e.pitch)) * DEG, -netHead * DEG, 0];

		if (template.family === 'humanoid') {
			r.head = headRot;
			r.rightLeg = [swing, 0, 0];
			r.leftLeg = [-swing, 0, 0];
			r.rightArm = [-swing * 0.7, 0, 0];
			r.leftArm = [swing * 0.7, 0, 0];
			if (e.type === 'minecraft:zombie' || e.type === 'minecraft:husk' || e.type === 'minecraft:drowned' || e.type === 'minecraft:zombie_villager' || e.type === 'minecraft:zombified_piglin') {
				r.rightArm = [-1.4 + Math.sin(time * 3) * 0.05, 0, 0];
				r.leftArm = [-1.4 - Math.sin(time * 3) * 0.05, 0, 0];
			}
			if (s.swingProgress > 0) {
				const p = Math.sin(s.swingProgress * Math.PI);
				r.rightArm = [-1.2 * p - 0.4 * Math.sin(s.swingProgress * Math.PI * 2), -0.3 * p, 0];
			}
			if (e.riding) {
				r.rightLeg = [-1.41, -0.31, 0];
				r.leftLeg = [-1.41, 0.31, 0];
				r.rightArm = [-0.63, 0, 0];
				r.leftArm = [-0.63, 0, 0];
			}
			if (e.sneak || e.pose === 'crouching') {
				r.body = [0.5, 0, 0];
				r.rightArm = [r.rightArm[0] + 0.4, r.rightArm[1], 0];
				r.leftArm = [r.leftArm[0] + 0.4, r.leftArm[1], 0];
			}
		} else if (template.family === 'quadruped') {
			r.head = headRot;
			r.frontRight = [swing, 0, 0];
			r.hindLeft = [swing, 0, 0];
			r.frontLeft = [-swing, 0, 0];
			r.hindRight = [-swing, 0, 0];
			r.tail = [0.3 + Math.sin(time * 2) * 0.05, Math.sin(time * 1.3) * 0.2, 0];
		} else if (template.family === 'spider') {
			r.head = headRot;
			for (let i = 0; i < 8; i++) {
				const side = i < 4 ? -1 : 1;
				const phase = (i % 2 === 0 ? 1 : -1) * swing * 0.4;
				r['leg' + i] = [0, ((i % 4) - 1.5) * 0.35 * side + phase, -side * 0.6];
			}
		} else if (template.family === 'flyer') {
			const flap = Math.sin(time * 18) * 0.8;
			r.rightWing = [0, 0, flap];
			r.leftWing = [0, 0, -flap];
		} else if (template.family === 'fish') {
			r.tail = [0, Math.sin(time * 8) * 0.4, 0];
			for (let i = 0; i < 8; i++) r['t' + i] = [Math.sin(time * 3 + i) * 0.2, 0, 0];
		}
		return r;
	}

	setAssets(assets) {
		this.assets = assets;
	}

	draw(frame, entities, now, world) {
		const gl = this.gl;
		const prog = this.renderer.entityProgram;
		const u = prog.u;
		gl.useProgram(prog.program);
		gl.uniformMatrix4fv(u.uViewProj, false, frame.viewProj);
		gl.uniform3fv(u.uCamPos, frame.camPos);
		gl.uniform3fv(u.uFogColor, frame.fogColor);
		gl.uniform1f(u.uFogStart, frame.fogStart);
		gl.uniform1f(u.uFogEnd, frame.fogEnd);
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, this.renderer.lightmap);
		gl.uniform1i(u.uLightmap, 1);
		gl.activeTexture(gl.TEXTURE0);
		gl.uniform1i(u.uTexture, 0);
		gl.enable(gl.CULL_FACE);

		const time = now / 1000;
		const origin = frame.origin;
		let visible = 0;

		for (const e of entities) {
			if (e.invisible && !this.showInvisible) continue;
			const ex = e.x - origin[0], ey = e.y - origin[1], ez = e.z - origin[2];
			if (!frame.frustum(ex, ey + e.h / 2, ez, Math.max(e.w, e.h) + 1)) continue;
			visible++;

			const model = this.modelFor(e);
			const template = model.template;
			const s = this.animate(e, now);
			const rotations = this.pose(template, e, s, time);

			// Scale model pixels so the standing model matches the hitbox height.
			const scale = template.fixedScale ? 1 / 16 : (model.standing * 16 / template.height) / 16;
			const bodyYaw = e.body ?? e.yaw;
			let m = translation(ex, ey, ez);

			if (model.fixed && template.family === 'item') {
				m = multiply(m, translation(0, 0.1 + Math.sin(time * 2 + e.id) * 0.05, 0));
				m = multiply(m, rotationY(time + e.id));
			} else if (model.arrow) {
				m = multiply(m, rotationY(-e.yaw * DEG));
				m = multiply(m, rotationX(e.pitch * DEG));
				m = multiply(m, scaling(1, 1, 6));
			} else {
				m = multiply(m, rotationY(-bodyYaw * DEG));
			}

			if (e.pose === 'swimming' || e.pose === 'fall_flying' || e.pose === 'spin_attack') {
				m = multiply(m, translation(0, 0.3, -0.9));
				m = multiply(m, rotationX((90 + e.pitch) * DEG));
			} else if (e.pose === 'sleeping') {
				m = multiply(m, translation(0, 0.3, 0.9));
				m = multiply(m, rotationX(-90 * DEG));
			} else if (e.sneak || e.pose === 'crouching') {
				m = multiply(m, translation(0, -0.2, 0));
			}
			if (s.deadStart >= 0) {
				const k = Math.min(1, (now - s.deadStart) / 1000);
				m = multiply(m, rotationZ(Math.sqrt(k) * 90 * DEG));
			}
			m = multiply(m, scaling(scale, scale, scale));

			gl.uniform1i(u.uUseTexture, model.texture ? 1 : 0);
			if (model.texture) gl.bindTexture(gl.TEXTURE_2D, model.texture);
			gl.uniform3f(u.uTint, 1, 1, 1);
			gl.uniform1f(u.uHurt, e.hurt || s.deadStart >= 0 ? 1 : 0);
			// Entities are lit by the light at their eyes, through the same lightmap as blocks.
			const light = model.emissive ? [15, 15] : world.lightAt(Math.floor(e.x), Math.floor(e.y + e.h * 0.85), Math.floor(e.z));
			gl.uniform2f(u.uLight, light[1] / 16, light[0] / 16);

			for (const [name, part] of Object.entries(template.parts)) {
				const rot = rotations[name];
				let pm = multiply(m, translation(part.pivot[0], part.pivot[1], part.pivot[2]));
				if (name === 'body' && (e.sneak || e.pose === 'crouching') && template.family === 'humanoid') {
					pm = multiply(m, translation(part.pivot[0], part.pivot[1] - 1, part.pivot[2]));
				}
				if (rot) {
					if (rot[2]) pm = multiply(pm, rotationZ(rot[2]));
					if (rot[1]) pm = multiply(pm, rotationY(rot[1]));
					if (rot[0]) pm = multiply(pm, rotationX(rot[0]));
				}
				gl.uniformMatrix4fv(u.uModel, false, pm);
				gl.bindVertexArray(part.mesh.vao);
				gl.drawArrays(gl.TRIANGLES, 0, part.mesh.count);
			}

			if (e.hand && template.family === 'humanoid' && template.parts.rightArm) {
				this.drawHeldItem(m, template, rotations, e);
			}
		}

		gl.bindVertexArray(null);
		this.visibleCount = visible;
		this.cleanupStates(now);
	}

	drawHeldItem(m, template, rotations, e) {
		const gl = this.gl;
		const u = this.renderer.entityProgram.u;
		const arm = template.parts.rightArm;
		const rot = rotations.rightArm || [0, 0, 0];
		let pm = multiply(m, translation(arm.pivot[0], arm.pivot[1], arm.pivot[2]));
		if (rot[2]) pm = multiply(pm, rotationZ(rot[2]));
		if (rot[1]) pm = multiply(pm, rotationY(rot[1]));
		if (rot[0]) pm = multiply(pm, rotationX(rot[0]));
		pm = multiply(pm, translation(0, -10, 2));
		const item = this.template('held:' + e.hand, () => {
			const parts = {};
			const data = [];
			addBox(data, [-1, -1, 0], [2, 2, 6], { color: itemColor(e.hand) });
			parts.body = { pivot: [0, 0, 0], data };
			return { family: 'item', parts, height: 2 };
		});
		gl.uniform1i(u.uUseTexture, 0);
		gl.uniformMatrix4fv(u.uModel, false, pm);
		gl.bindVertexArray(item.parts.body.mesh.vao);
		gl.drawArrays(gl.TRIANGLES, 0, item.parts.body.mesh.count);
	}

	cleanupStates(now) {
		if (this.states.size < 64) return;
		for (const [id, s] of this.states) {
			if (now - s.seen > 5000) this.states.delete(id);
		}
	}

	/** Positions the HTML name tags. */
	updateLabels(frame, entities, width, height) {
		const seen = new Set();
		for (const e of entities) {
			const wantLabel = this.showLabels && (e.name || this.showAllLabels) && !(e.invisible && !this.showInvisible) && !e.type.endsWith('item');
			if (!wantLabel) continue;
			const origin = frame.origin;
			const p = transformPoint(frame.viewProj, e.x - origin[0], e.y - origin[1] + e.h + 0.35, e.z - origin[2]);
			if (p[3] <= 0 || p[0] < -1.2 || p[0] > 1.2 || p[1] < -1.2 || p[1] > 1.2) continue;
			const dx = e.x - origin[0] - frame.camPos[0], dy = e.y - origin[1] - frame.camPos[1], dz = e.z - origin[2] - frame.camPos[2];
			if (Math.hypot(dx, dy, dz) > frame.fogEnd) continue;

			const key = 'label-' + e.id;
			seen.add(key);
			let label = this.labels.querySelector('#' + key);
			if (!label) {
				label = document.createElement('div');
				label.className = 'label';
				label.id = key;
				this.labels.appendChild(label);
			}
			const text = e.name || e.type.replace('minecraft:', '').replace(/_/g, ' ');
			if (label.textContent !== text) label.textContent = text;
			label.classList.toggle('player', e.type === 'minecraft:player');
			const x = (p[0] * 0.5 + 0.5) * width;
			const y = (1 - (p[1] * 0.5 + 0.5)) * height;
			label.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
		}
		for (const label of [...this.labels.querySelectorAll('.label')]) {
			if (!seen.has(label.id)) label.remove();
		}
	}
}

function hashColor(text) {
	let h = 0;
	for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
	return [((h >> 16) & 255) / 255 * 0.5 + 0.35, ((h >> 8) & 255) / 255 * 0.5 + 0.35, (h & 255) / 255 * 0.5 + 0.35];
}

function tokenSuffix(sep) {
	const token = new URLSearchParams(location.search).get('token');
	return token ? sep + 'token=' + encodeURIComponent(token) : '';
}
