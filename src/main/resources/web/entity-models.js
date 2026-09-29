// Entity model geometry taken from the game itself (the server reads
// LayerDefinitions from the client jar, see EntityModels.java) and posed on
// the CPU like ModelPart.render: translate by the pivot, rotate Z*Y*X, scale,
// then the cubes. Animations change the live part fields the way the
// client's setupAnim does (after resetPose).

import { KeyframeAnimation } from './keyframes.js';

/** A model part with its bind pose (x, y, z in pixels, rotations in radians). */
class Part {
	constructor(name, data) {
		this.name = name;
		this.bind = {
			x: data.p[0], y: data.p[1], z: data.p[2],
			xRot: data.r ? data.r[0] : 0, yRot: data.r ? data.r[1] : 0, zRot: data.r ? data.r[2] : 0,
			xScale: data.s ? data.s[0] : 1, yScale: data.s ? data.s[1] : 1, zScale: data.s ? data.s[2] : 1,
		};
		this.quads = data.q ? new Float32Array(data.q) : null;
		this.children = [];
		this.reset();
		if (data.c) {
			for (const [childName, child] of Object.entries(data.c)) this.children.push(new Part(childName, child));
		}
	}

	reset() {
		Object.assign(this, this.bind);
		this.visible = true;
		this.skipDraw = false;
	}

	resetAll() {
		this.reset();
		for (const child of this.children) child.resetAll();
	}

	collect(map) {
		map[this.name] = this;
		for (const child of this.children) child.collect(map);
		return map;
	}
}

const SKIN_LAYERS = new Set(['hat', 'jacket', 'left_sleeve', 'right_sleeve', 'left_pants', 'right_pants']);

/** A baked layer: its root part plus quick access to every part by name. */
export class Model {
	constructor(id, data) {
		this.id = id;
		this.root = new Part('root', data);
		this.parts = this.root.collect({});
		this.vertexCount = 0;
		const count = part => {
			if (part.quads) this.vertexCount += part.quads.length / 5;
			part.children.forEach(count);
		};
		count(this.root);
	}

	reset() {
		this.root.resetAll();
	}

	/** Copies the live pose of parts with the same names (layers that follow their parent model). */
	copyPose(other) {
		for (const [name, part] of Object.entries(this.parts)) {
			const src = other.parts[name];
			if (!src || name === 'root') continue;
			part.x = src.x; part.y = src.y; part.z = src.z;
			part.xRot = src.xRot; part.yRot = src.yRot; part.zRot = src.zRot;
			part.xScale = src.xScale; part.yScale = src.yScale; part.zScale = src.zScale;
			// The skin layers a player turned off stay on armour (the game does not copy their visibility).
			if (!SKIN_LAYERS.has(name)) part.visible = src.visible;
		}
	}
}

// --- 3x4 affine matrices (column-major 4x4 stored in 16 floats) ---------------------------------------

export function mat4() {
	const m = new Float32Array(16);
	m[0] = m[5] = m[10] = m[15] = 1;
	return m;
}

export function mul(a, b, out = new Float32Array(16)) {
	for (let c = 0; c < 4; c++) {
		const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
		out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
		out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
		out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
		out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
	}
	return out;
}

export function translate(m, x, y, z) {
	m[12] += m[0] * x + m[4] * y + m[8] * z;
	m[13] += m[1] * x + m[5] * y + m[9] * z;
	m[14] += m[2] * x + m[6] * y + m[10] * z;
	return m;
}

export function scale(m, x, y = x, z = x) {
	for (let i = 0; i < 4; i++) {
		m[i] *= x;
		m[4 + i] *= y;
		m[8 + i] *= z;
	}
	return m;
}

/** m = m * R, with R rotating about the axis (0 = x, 1 = y, 2 = z) by `angle` radians (right handed). */
export function rotate(m, axis, angle) {
	if (!angle) return m;
	const c = Math.cos(angle), s = Math.sin(angle);
	let a, b; // columns that mix
	if (axis === 0) { a = 4; b = 8; } else if (axis === 1) { a = 8; b = 0; } else { a = 0; b = 4; }
	for (let i = 0; i < 3; i++) {
		const ca = m[a + i], cb = m[b + i];
		m[a + i] = ca * c + cb * s;
		m[b + i] = cb * c - ca * s;
	}
	return m;
}

export const DEG = Math.PI / 180;

/**
 * Writes the posed model into `out` (FLOATS per vertex, 6 vertices per quad as triangles):
 * position (relative to the camera) 3, normal 3, uv 2, colour 4, light 2 (block, sky 0..240), overlay 2 (red, white).
 */
export const FLOATS = 16;

export class VertexSink {
	constructor() {
		this.data = new Float32Array(1 << 16);
		this.count = 0;
	}

	reset() {
		this.count = 0;
	}

	ensure(vertices) {
		const need = (this.count + vertices) * FLOATS;
		if (need <= this.data.length) return;
		let size = this.data.length * 2;
		while (size < need) size *= 2;
		const next = new Float32Array(size);
		next.set(this.data.subarray(0, this.count * FLOATS));
		this.data = next;
	}
}

const tmp = new Float32Array(12);

/**
 * Emits one model. matrix: model -> camera relative space (in blocks, pixels are divided by 16 here).
 * style: {color [r, g, b, a], light [block, sky], overlay [red, white]}
 */
export function emitModel(sink, model, matrix, style) {
	sink.ensure(model.vertexCount * 1.5);
	const base = mat4();
	base.set(matrix);
	scale(base, 1 / 16);
	emitPart(sink, model.root, base, style, true);
}

function emitPart(sink, part, parent, style, isRoot) {
	if (!part.visible) return;
	const m = new Float32Array(parent);
	translate(m, part.x, part.y, part.z);
	// Quaternion rotationZYX(z, y, x): R = Rz * Ry * Rx
	if (part.zRot) rotate(m, 2, part.zRot);
	if (part.yRot) rotate(m, 1, part.yRot);
	if (part.xRot) rotate(m, 0, part.xRot);
	if (part.xScale !== 1 || part.yScale !== 1 || part.zScale !== 1) scale(m, part.xScale, part.yScale, part.zScale);
	if (part.quads && !part.skipDraw) emitQuads(sink, part.quads, m, style);
	for (const child of part.children) emitPart(sink, child, m, style, false);
}

export function emitQuads(sink, q, m, style) {
	const out = sink.data;
	const [r, g, b, a] = style.color;
	const [lb, ls] = style.light;
	const [or, ow] = style.overlay;
	const flip = style.flipUv;
	for (let i = 0; i < q.length; i += 20) {
		for (let k = 0; k < 4; k++) {
			const x = q[i + k * 5], y = q[i + k * 5 + 1], z = q[i + k * 5 + 2];
			tmp[k * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
			tmp[k * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
			tmp[k * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
		}
		const e1x = tmp[3] - tmp[0], e1y = tmp[4] - tmp[1], e1z = tmp[5] - tmp[2];
		const e2x = tmp[6] - tmp[0], e2y = tmp[7] - tmp[1], e2z = tmp[8] - tmp[2];
		let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
		let len = Math.hypot(nx, ny, nz);
		if (len < 1e-12) {
			// Degenerate first triangle (zero sized cube face): try the other diagonal.
			const e3x = tmp[9] - tmp[0], e3y = tmp[10] - tmp[1], e3z = tmp[11] - tmp[2];
			nx = e2y * e3z - e2z * e3y; ny = e2z * e3x - e2x * e3z; nz = e2x * e3y - e2y * e3x;
			len = Math.hypot(nx, ny, nz) || 1;
		}
		nx /= len; ny /= len; nz /= len;
		for (const k of [0, 1, 2, 0, 2, 3]) {
			const o = sink.count++ * FLOATS;
			out[o] = tmp[k * 3]; out[o + 1] = tmp[k * 3 + 1]; out[o + 2] = tmp[k * 3 + 2];
			out[o + 3] = nx; out[o + 4] = ny; out[o + 5] = nz;
			out[o + 6] = q[i + k * 5 + 3];
			out[o + 7] = flip ? 1 - q[i + k * 5 + 4] : q[i + k * 5 + 4];
			out[o + 8] = r; out[o + 9] = g; out[o + 10] = b; out[o + 11] = a;
			out[o + 12] = lb; out[o + 13] = ls;
			out[o + 14] = or; out[o + 15] = ow;
		}
	}
}

/** Loads /assets/models.json once and hands out Model instances per layer id and the game's keyframe animations. */
export class ModelLibrary {
	constructor() {
		this.layers = null;
		this.cache = new Map();
		this.animations = {};
		this.animationCache = new Map();
	}

	async load(query) {
		for (let attempt = 0; attempt < 30; attempt++) {
			try {
				const response = await fetch('/assets/models.json' + query, { credentials: 'same-origin' });
				if (response.ok) {
					const json = await response.json();
					this.layers = json.layers || {};
					this.animations = json.animations || {};
					return true;
				}
				if (response.status === 404) return false;
			} catch {
				// Retry below.
			}
			await new Promise(r => setTimeout(r, 3000));
		}
		return false;
	}

	has(id) {
		return !!(this.layers && this.layers[id]);
	}

	/** A keyframe animation by its game name ("WardenAnimation.WARDEN_ROAR"), or null. */
	animation(name) {
		let animation = this.animationCache.get(name);
		if (animation === undefined) {
			const definition = this.animations[name];
			animation = definition ? new KeyframeAnimation(definition) : null;
			this.animationCache.set(name, animation);
		}
		return animation;
	}

	/** A shared model instance for a layer (pose it, emit it, then it can be reused). */
	get(id) {
		if (!this.layers) return null;
		let model = this.cache.get(id);
		if (model === undefined) {
			const data = this.layers[id];
			model = data ? new Model(id, data) : null;
			this.cache.set(id, model);
		}
		return model;
	}
}

/** The transform of a named part (model pixels in the part's space -> camera relative blocks), or null. */
export function partMatrix(model, name, matrix) {
	const chain = [];
	const find = part => {
		chain.push(part);
		if (part.name === name) return true;
		for (const child of part.children) if (find(child)) return true;
		chain.pop();
		return false;
	};
	if (!find(model.root)) return null;
	const m = mat4();
	m.set(matrix);
	scale(m, 1 / 16);
	for (const part of chain) {
		translate(m, part.x, part.y, part.z);
		if (part.zRot) rotate(m, 2, part.zRot);
		if (part.yRot) rotate(m, 1, part.yRot);
		if (part.xRot) rotate(m, 0, part.xRot);
		if (part.xScale !== 1 || part.yScale !== 1 || part.zScale !== 1) scale(m, part.xScale, part.yScale, part.zScale);
	}
	return m;
}
