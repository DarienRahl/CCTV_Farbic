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

	/**
	 * Copies the live pose of parts with the same names (layers that follow their parent model). Positions move by
	 * as much as the parent's parts moved from their bind pose: each layer model's setupAnim starts from its own
	 * (baby armour's legs stand wider apart than a baby zombie's).
	 */
	copyPose(other) {
		for (const [name, part] of Object.entries(this.parts)) {
			const src = other.parts[name];
			if (!src || name === 'root') continue;
			part.x = part.bind.x + src.x - src.bind.x;
			part.y = part.bind.y + src.y - src.bind.y;
			part.z = part.bind.z + src.z - src.bind.z;
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
		// GPU skinning: models are drawn from their own buffers with one matrix per part (bones, 16 floats each)
		this.skinning = false;
		this.draws = [];
		this.bones = new Float32Array(BONES_PER_ROW * 16);
		this.boneCount = 0;
	}

	reset() {
		this.count = 0;
		this.draws.length = 0;
		this.boneCount = 0;
	}

	/** Where the next geometry starts: vertices of this buffer and skinned model draws. */
	mark() {
		return { v: this.count, s: this.draws.length };
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

	/** Room for `count` more part matrices; returns the index of the first. Grows by whole texture rows. */
	allocBones(count) {
		const first = this.boneCount;
		const need = (first + count) * 16;
		if (need > this.bones.length) {
			const row = BONES_PER_ROW * 16;
			const next = new Float32Array(Math.max(this.bones.length * 2, Math.ceil(need / row) * row));
			next.set(this.bones.subarray(0, first * 16));
			this.bones = next;
		}
		this.boneCount += count;
		return first;
	}
}

const tmp = new Float32Array(12);

/**
 * Emits one model. matrix: model -> camera relative space (in blocks, pixels are divided by 16 here).
 * style: {color [r, g, b, a], light [block, sky], overlay [red, white]}
 */
export function emitModel(sink, model, matrix, style) {
	if (sink.skinning) {
		emitSkinned(sink, model, matrix, style);
		return;
	}
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

/** Part matrices per row of the bone texture (1024 RGBA float texels, four per matrix). */
export const BONES_PER_ROW = 256;
/** Floats per vertex of a model's GPU copy: position in its part's pixels 3, normal 3, uv 2, part index 1. */
export const SKIN_FLOATS = 9;

/**
 * GPU skinning: the model's quads stay on the GPU in their parts' own space, so a frame only works out one matrix
 * per part (the same transforms as emitPart; hidden parts get a zero matrix, which draws nothing) and records the
 * draw with its colour, light and overlay.
 */
function emitSkinned(sink, model, matrix, style) {
	const geometry = skinnedGeometry(model);
	const first = sink.allocBones(geometry.parts.length);
	const bones = sink.bones;
	const base = mat4();
	base.set(matrix);
	scale(base, 1 / 16);
	let index = first;
	const walk = (part, parent, hidden) => {
		const at = index++ * 16;
		if (hidden || !part.visible) {
			bones.fill(0, at, at + 16);
			for (const child of part.children) walk(child, parent, true);
			return;
		}
		const m = new Float32Array(parent);
		translate(m, part.x, part.y, part.z);
		if (part.zRot) rotate(m, 2, part.zRot);
		if (part.yRot) rotate(m, 1, part.yRot);
		if (part.xRot) rotate(m, 0, part.xRot);
		if (part.xScale !== 1 || part.yScale !== 1 || part.zScale !== 1) scale(m, part.xScale, part.yScale, part.zScale);
		if (part.quads && !part.skipDraw) bones.set(m, at);
		else bones.fill(0, at, at + 16);
		for (const child of part.children) walk(child, m, false);
	};
	walk(model.root, base, false);
	sink.draws.push({ geometry, bone: first, color: style.color, light: style.light, overlay: style.overlay });
}

/**
 * A model's quads for GPU skinning, made once: parts in the order emitSkinned walks them, each quad as two
 * triangles in its part's pixels with the normal of the quad (the shader turns it with the part's cofactor matrix,
 * which gives what the cross product of the moved edges gives in emitQuads).
 */
function skinnedGeometry(model) {
	if (model.skinned) return model.skinned;
	const parts = [];
	const collect = part => {
		parts.push(part);
		part.children.forEach(collect);
	};
	collect(model.root);
	let quads = 0;
	for (const part of parts) if (part.quads) quads += part.quads.length / 20;
	const data = new Float32Array(quads * 6 * SKIN_FLOATS);
	let o = 0;
	parts.forEach((part, bone) => {
		const q = part.quads;
		if (!q) return;
		for (let i = 0; i < q.length; i += 20) {
			const e1x = q[i + 5] - q[i], e1y = q[i + 6] - q[i + 1], e1z = q[i + 7] - q[i + 2];
			const e2x = q[i + 10] - q[i], e2y = q[i + 11] - q[i + 1], e2z = q[i + 12] - q[i + 2];
			let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
			let len = Math.hypot(nx, ny, nz);
			if (len < 1e-12) {
				const e3x = q[i + 15] - q[i], e3y = q[i + 16] - q[i + 1], e3z = q[i + 17] - q[i + 2];
				nx = e2y * e3z - e2z * e3y; ny = e2z * e3x - e2x * e3z; nz = e2x * e3y - e2y * e3x;
				len = Math.hypot(nx, ny, nz) || 1;
			}
			nx /= len; ny /= len; nz /= len;
			for (const k of [0, 1, 2, 0, 2, 3]) {
				data[o++] = q[i + k * 5]; data[o++] = q[i + k * 5 + 1]; data[o++] = q[i + k * 5 + 2];
				data[o++] = nx; data[o++] = ny; data[o++] = nz;
				data[o++] = q[i + k * 5 + 3]; data[o++] = q[i + k * 5 + 4];
				data[o++] = bone;
			}
		}
	});
	model.skinned = { parts, data, vertices: quads * 6 };
	return model.skinned;
}

/**
 * Quads of 4 vertices (x, y, z, u, v) moved by m; each lit by the normal of its face, or by style.normal turned by m
 * (the normal a renderer gives its vertices, like a sprite's (0, 1, 0)).
 */
export function emitQuads(sink, q, m, style) {
	const out = sink.data;
	const [r, g, b, a] = style.color;
	const [lb, ls] = style.light;
	const [or, ow] = style.overlay;
	const flip = style.flipUv;
	const fixed = style.normal;
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
		if (fixed) {
			// the quad's own normal (VertexConsumer.setNormal(pose, ...)), turned by the pose
			nx = m[0] * fixed[0] + m[4] * fixed[1] + m[8] * fixed[2];
			ny = m[1] * fixed[0] + m[5] * fixed[1] + m[9] * fixed[2];
			nz = m[2] * fixed[0] + m[6] * fixed[1] + m[10] * fixed[2];
			const n = Math.hypot(nx, ny, nz) || 1;
			nx /= n; ny /= n; nz /= n;
		}
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
		this.renderers = {};
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
					// entity type -> the model layers, textures and shadow its renderer uses (EntityRendererMap)
					this.renderers = json.renderers || {};
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
