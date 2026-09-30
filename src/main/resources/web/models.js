// Block models like Minecraft's client builds them: block state -> model
// selection (variants with weights, multipart), model inheritance and baking
// of elements into quads (FaceBakery: vertex order, default UVs, UV rotation,
// element rotation with rescale, variant rotation, uvlock, cullface, tint,
// shade, light emission). Pure code without DOM access, so it runs in the
// meshing workers as well as on the page (item models).

// Directions in Minecraft's order (Direction.get3DDataValue).
export const DOWN = 0, UP = 1, NORTH = 2, SOUTH = 3, WEST = 4, EAST = 5;
export const DIR_NAMES = ['down', 'up', 'north', 'south', 'west', 'east'];
export const DIR_VECTORS = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
const DIR_INDEX = { down: 0, up: 1, north: 2, south: 3, west: 4, east: 5, bottom: 0, top: 1 };

export const MAT_OPAQUE = 0;
export const MAT_CUTOUT = 1;
export const MAT_TRANSLUCENT = 2;
export const MAT_COLOR = 3; // no texture (fallback without client assets)

// FaceInfo: vertex order of each face (counter-clockwise seen from outside), 0 = min, 1 = max of the box.
const FACE_VERTICES = [
	[[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]], // down
	[[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]], // up
	[[1, 1, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0]], // north
	[[0, 1, 1], [0, 0, 1], [1, 0, 1], [1, 1, 1]], // south
	[[0, 1, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]], // west
	[[1, 1, 1], [1, 0, 1], [1, 0, 0], [1, 1, 0]], // east
];

/** FaceBakery.defaultFaceUV */
function defaultUv(dir, from, to) {
	switch (dir) {
		case DOWN: return [from[0], 16 - to[2], to[0], 16 - from[2]];
		case UP: return [from[0], from[2], to[0], to[2]];
		case NORTH: return [16 - to[0], 16 - to[1], 16 - from[0], 16 - from[1]];
		case SOUTH: return [from[0], 16 - to[1], to[0], 16 - from[1]];
		case WEST: return [from[2], 16 - to[1], to[2], 16 - from[1]];
		default: return [16 - to[2], 16 - to[1], 16 - from[2], 16 - from[1]];
	}
}

export function ns(id) {
	if (!id) return id;
	return id.includes(':') ? id : 'minecraft:' + id;
}

function rotate(p, axis, angle, origin, rescale) {
	const rad = angle * Math.PI / 180;
	const c = Math.cos(rad), s = Math.sin(rad);
	const x = p[0] - origin[0], y = p[1] - origin[1], z = p[2] - origin[2];
	let rx = x, ry = y, rz = z;
	if (axis === 'x') { ry = y * c - z * s; rz = y * s + z * c; }
	else if (axis === 'y') { rx = x * c + z * s; rz = -x * s + z * c; }
	else { rx = x * c - y * s; ry = x * s + y * c; }
	if (rescale) {
		const k = 1 / Math.max(Math.abs(c), 1e-4);
		if (axis !== 'x') rx *= k;
		if (axis !== 'y') ry *= k;
		if (axis !== 'z') rz *= k;
	}
	return [rx + origin[0], ry + origin[1], rz + origin[2]];
}

/** Block state variant rotation (BlockModelRotation): -x around X, then -y around Y, about the block centre. */
function variantRotate(p, rx, ry) {
	let q = p;
	if (rx) q = rotate(q, 'x', -rx, [8, 8, 8], false);
	if (ry) q = rotate(q, 'y', -ry, [8, 8, 8], false);
	return q;
}

function nearestDir(n) {
	let best = 0, bestDot = -Infinity;
	for (let i = 0; i < 6; i++) {
		const d = DIR_VECTORS[i];
		const dot = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
		if (dot > bestDot) { bestDot = dot; best = i; }
	}
	return [best, bestDot];
}

/**
 * For each corner of FACE_VERTICES[facing] (min/max of the quad's bounds), the index of the matching
 * rotated vertex; null when the quad does not fit its bounds' corners (then the order is kept).
 */
function windingOrder(positions, facing) {
	const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
	for (const p of positions) {
		for (let k = 0; k < 3; k++) {
			if (p[k] < min[k]) min[k] = p[k];
			if (p[k] > max[k]) max[k] = p[k];
		}
	}
	const order = [];
	for (const corner of FACE_VERTICES[facing]) {
		const target = [corner[0] ? max[0] : min[0], corner[1] ? max[1] : min[1], corner[2] ? max[2] : min[2]];
		const found = positions.findIndex(p => Math.abs(p[0] - target[0]) < 1e-4 && Math.abs(p[1] - target[1]) < 1e-4 && Math.abs(p[2] - target[2]) < 1e-4);
		if (found < 0 || order.includes(found)) return null;
		order.push(found);
	}
	return order;
}

function snap(v) {
	const r = Math.round(v * 1e5) / 1e5;
	return Math.abs(r) < 1e-7 ? 0 : r;
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

/**
 * Block models from the client assets bundle.
 * sprites: Map texture id -> {u0, v0, u1, v1, material}; missing: sprite for unknown textures.
 */
export class BlockModels {
	constructor(blockstates, models, sprites, missing) {
		this.blockstates = blockstates || {};
		this.models = models || {};
		this.sprites = sprites;
		this.missing = missing;
		this.resolved = new Map();
		this.baked = new Map();
	}

	sprite(textureId) {
		return this.sprites.get(ns(textureId)) || this.missing;
	}

	/** Model with its parents merged: {elements, textures, ao}. */
	resolveModel(id) {
		id = ns(id);
		let resolved = this.resolved.get(id);
		if (resolved) return resolved;
		const chain = [];
		let current = id;
		for (let depth = 0; current && depth < 32; depth++) {
			const model = this.models[current];
			if (!model) break;
			chain.push(model);
			current = model.parent ? ns(model.parent) : null;
		}
		const textures = {};
		let elements = null;
		let ao = true;
		for (let i = chain.length - 1; i >= 0; i--) {
			const m = chain[i];
			if (m.textures) Object.assign(textures, m.textures);
			if (m.elements) elements = m.elements;
			if (m.ambientocclusion === false) ao = false;
		}
		resolved = { elements: elements || [], textures, ao };
		this.resolved.set(id, resolved);
		return resolved;
	}

	/** Texture reference -> {id, forceTranslucent} (26.x allows {"sprite": ..., "force_translucent": true}). */
	resolveTexture(textures, ref) {
		let force = false;
		const unwrap = r => {
			if (r && typeof r === 'object') {
				if (r.force_translucent) force = true;
				return r.sprite;
			}
			return r;
		};
		ref = unwrap(ref);
		for (let i = 0; i < 16 && typeof ref === 'string' && ref.startsWith('#'); i++) {
			ref = unwrap(textures[ref.slice(1)]);
		}
		if (typeof ref !== 'string' || ref.startsWith('#')) return null;
		return { id: ns(ref), forceTranslucent: force };
	}

	/**
	 * How the client picks models for a block state:
	 * {kind: 'single', model} | {kind: 'weighted', entries: [{weight, model}], total} | {kind: 'multipart', selectors: [...]}
	 * where model is a baked model {quads: [[] x6 culled by direction, [] unculled], ao}. null = no model.
	 */
	dispatch(name, props) {
		const def = this.blockstates[name];
		if (!def) return null;
		if (def.variants) {
			for (const [key, value] of Object.entries(def.variants)) {
				if (key === '' || key === 'normal' || key.split(',').every(pair => {
					const eq = pair.indexOf('=');
					return props[pair.slice(0, eq)] === pair.slice(eq + 1);
				})) {
					return this.variantList(value);
				}
			}
			if (props.__item) {
				// Items have no block state: use the first variant (e.g. an upright log).
				const first = Object.values(def.variants)[0];
				return first ? this.variantList(first) : null;
			}
			return null;
		}
		if (def.multipart) {
			const selectors = [];
			for (const part of def.multipart) {
				if (!part.when || this.matches(part.when, props)) {
					const selected = this.variantList(part.apply);
					if (selected) selectors.push(selected);
				}
			}
			return selectors.length ? { kind: 'multipart', selectors } : null;
		}
		return null;
	}

	/** BlockStateModelSet.getParticleMaterial: the particle texture of the first model the state uses. */
	particleTexture(name, props) {
		const def = this.blockstates[name];
		if (!def) return null;
		let variant = null;
		if (def.variants) {
			for (const [key, value] of Object.entries(def.variants)) {
				if (key === '' || key === 'normal' || key.split(',').every(pair => {
					const eq = pair.indexOf('=');
					return props[pair.slice(0, eq)] === pair.slice(eq + 1);
				})) {
					variant = value;
					break;
				}
			}
			if (!variant) variant = Object.values(def.variants)[0];
		} else if (def.multipart) {
			const part = def.multipart.find(p => !p.when || this.matches(p.when, props));
			variant = part ? part.apply : null;
		}
		if (Array.isArray(variant)) variant = variant[0];
		if (!variant || !variant.model) return null;
		const model = this.resolveModel(variant.model);
		const texture = model ? this.resolveTexture(model.textures, '#particle') : null;
		return texture ? texture.id : null;
	}

	variantList(value) {
		const list = Array.isArray(value) ? value : [value];
		const entries = [];
		for (const variant of list) {
			if (!variant || !variant.model) continue;
			entries.push({ weight: variant.weight === undefined ? 1 : variant.weight, model: this.bakeVariant(variant) });
		}
		if (entries.length === 0) return null;
		if (entries.length === 1) return { kind: 'single', model: entries[0].model };
		return { kind: 'weighted', entries, total: entries.reduce((sum, e) => sum + e.weight, 0) };
	}

	matches(when, props) {
		if (when.OR) return when.OR.some(c => this.matches(c, props));
		if (when.AND) return when.AND.every(c => this.matches(c, props));
		return Object.entries(when).every(([k, v]) => {
			const value = String(v);
			const negate = value.startsWith('!');
			const options = (negate ? value.slice(1) : value).split('|');
			const hit = options.includes(props[k]);
			return negate ? !hit : hit;
		});
	}

	/** One variant (model + rotation) baked into quads, cached. */
	bakeVariant(variant) {
		const key = variant.model + '|' + (variant.x || 0) + '|' + (variant.y || 0) + '|' + (variant.uvlock ? 1 : 0);
		let baked = this.baked.get(key);
		if (baked) return baked;
		const model = this.resolveModel(variant.model);
		const quads = [[], [], [], [], [], [], []];
		for (const element of model.elements) {
			this.bakeElement(quads, element, model.textures, variant.x || 0, variant.y || 0, !!variant.uvlock);
		}
		baked = { quads, ao: model.ao, empty: quads.every(list => list.length === 0) };
		this.baked.set(key, baked);
		return baked;
	}

	bakeElement(out, element, textures, rx, ry, uvlock) {
		const from = element.from, to = element.to;
		if (!from || !to) return;
		const rotation = element.rotation;
		// 26.3's "shade_direction_override": the quad is lit like a face of that direction whatever way it faces or
		// the variant turns it (plants and torches: up); "shade": false of older resource packs meant the same as up
		const shadeDir = element.shade_direction_override ? DIR_INDEX[element.shade_direction_override] ?? -1
			: element.shade === false ? DIR_INDEX.up : -1;
		const emission = element.light_emission || 0;
		for (const [dirName, face] of Object.entries(element.faces || {})) {
			const dir = DIR_INDEX[dirName];
			if (dir === undefined || !face) continue;
			const texture = this.resolveTexture(textures, face.texture);
			const sprite = texture ? this.sprite(texture.id) : this.missing;

			let positions = FACE_VERTICES[dir].map(c => [c[0] ? to[0] : from[0], c[1] ? to[1] : from[1], c[2] ? to[2] : from[2]]);
			if (rotation && rotation.angle) {
				positions = positions.map(p => rotate(p, rotation.axis, rotation.angle, rotation.origin || [8, 8, 8], rotation.rescale));
			}
			if (rx || ry) positions = positions.map(p => variantRotate(p, rx, ry));

			// Facing after all rotations.
			const a = positions[0], b = positions[1], c = positions[2];
			const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
			const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
			let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
			const len = Math.hypot(n[0], n[1], n[2]) || 1;
			n = [n[0] / len, n[1] / len, n[2] / len];
			const [facing, alignment] = nearestDir(n);
			const aligned = alignment > 0.999;

			// FaceBakery.recalculateWinding: put the corners in the standard order of the final facing, so
			// smooth lighting assigns the right corner light to each vertex of rotated models.
			let order = null;
			if (rx || ry || (rotation && rotation.angle)) {
				order = windingOrder(positions, facing);
				if (order) positions = order.map(i => positions[i]);
			}

			let uv = face.uv || defaultUv(dir, from, to);
			let uvRotation = face.rotation || 0;
			if (uvlock && (rx || ry) && aligned) {
				const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
				for (const p of positions) {
					for (let k = 0; k < 3; k++) {
						min[k] = Math.min(min[k], p[k]);
						max[k] = Math.max(max[k], p[k]);
					}
				}
				uv = defaultUv(facing, min, max);
				uvRotation = 0;
			}

			// Vertex i uses UV corner (i + rotation) % 4: 0 = (u0, v0), 1 = (u0, v1), 2 = (u1, v1), 3 = (u1, v0).
			const uvs = new Float32Array(8);
			const du = sprite.u1 - sprite.u0, dv = sprite.v1 - sprite.v0;
			let centerU = 0, centerV = 0;
			for (let i = 0; i < 4; i++) {
				// UVs belong to the original corner (before re-winding) unless uvlock recomputed them for the final face.
				const corner = order && !(uvlock && (rx || ry) && aligned) ? order[i] : i;
				const k = (corner + uvRotation / 90) % 4;
				const u = (k === 0 || k === 1) ? uv[0] : uv[2];
				const v = (k === 0 || k === 3) ? uv[1] : uv[3];
				uvs[i * 2] = sprite.u0 + du * Math.min(16, Math.max(0, u)) / 16;
				uvs[i * 2 + 1] = sprite.v0 + dv * Math.min(16, Math.max(0, v)) / 16;
				centerU += uvs[i * 2] / 4;
				centerV += uvs[i * 2 + 1] / 4;
			}
			// FaceBakery: pull UVs a tiny bit towards the centre (uvShrinkRatio) so edges never sample the next sprite.
			const shrink = sprite.shrink || 0;
			for (let i = 0; i < 4; i++) {
				uvs[i * 2] += (centerU - uvs[i * 2]) * shrink;
				uvs[i * 2 + 1] += (centerV - uvs[i * 2 + 1]) * shrink;
			}

			const pos = new Float32Array(12);
			for (let i = 0; i < 4; i++) {
				pos[i * 3] = snap(positions[i][0] / 16);
				pos[i * 3 + 1] = snap(positions[i][1] / 16);
				pos[i * 3 + 2] = snap(positions[i][2] / 16);
			}

			let cull = -1;
			if (face.cullface && DIR_INDEX[face.cullface] !== undefined) {
				let cv = DIR_VECTORS[DIR_INDEX[face.cullface]].map(v => v * 8 + 8);
				if (rx || ry) cv = variantRotate(cv, rx, ry);
				cull = nearestDir([cv[0] - 8, cv[1] - 8, cv[2] - 8])[0];
			}

			let material = sprite.material;
			if (texture && texture.forceTranslucent) material = MAT_TRANSLUCENT;

			out[cull >= 0 ? cull : 6].push({
				pos,
				uvs,
				dir: facing,
				aligned,
				tint: face.tintindex === undefined ? -1 : face.tintindex,
				shadeDir,
				emission,
				material,
			});
		}
	}
}

/** Collects the model parts for one block (ModelBlockRenderer: model.collectParts(random)). */
export function collectParts(dispatch, random, out) {
	switch (dispatch.kind) {
		case 'single':
			out.push(dispatch.model);
			return;
		case 'weighted': {
			let pick = random.nextInt(dispatch.total);
			for (const entry of dispatch.entries) {
				pick -= entry.weight;
				if (pick < 0) {
					out.push(entry.model);
					return;
				}
			}
			out.push(dispatch.entries[dispatch.entries.length - 1].model);
			return;
		}
		default: {
			const seed = random.nextLong();
			for (const selector of dispatch.selectors) {
				random.setSeed(seed[0], seed[1]);
				collectParts(selector, random, out);
			}
		}
	}
}

/** Does picking parts use random numbers at all? (If not, seeding can be skipped.) */
export function needsRandom(dispatch) {
	if (dispatch.kind === 'weighted') return true;
	if (dispatch.kind === 'multipart') return dispatch.selectors.some(needsRandom);
	return false;
}

export { parseProps };
