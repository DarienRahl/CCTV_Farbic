// Minecraft block assets in the browser: texture atlas (with animations),
// block state -> model resolution and baking of model elements into quads,
// following the client's rules (variants, multipart, element rotation,
// x/y rotation, uvlock, cullface, tintindex).

export const MAT_OPAQUE = 0;
export const MAT_CUTOUT = 1;
export const MAT_TRANSLUCENT = 2;
export const MAT_COLOR = 3; // no texture (fallback)

// Direction indices used by the mesher: up, down, north(-z), south(+z), west(-x), east(+x)
export const DIRS = ['up', 'down', 'north', 'south', 'west', 'east'];
export const DIR_VECTORS = [[0, 1, 0], [0, -1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
const DIR_INDEX = { up: 0, down: 1, north: 2, south: 3, west: 4, east: 5 };

// Vertex order and UV corners exactly as Minecraft's FaceBakery (counter-clockwise from outside).
// Each entry: [x, y, z] where 0 = min, 1 = max of the element box.
const FACE_VERTICES = [
	[[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]], // up
	[[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]], // down
	[[1, 1, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0]], // north
	[[0, 1, 1], [0, 0, 1], [1, 0, 1], [1, 1, 1]], // south
	[[0, 1, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]], // west
	[[1, 1, 1], [1, 0, 1], [1, 0, 0], [1, 1, 0]], // east
];

function defaultUv(dir, from, to) {
	switch (dir) {
		case 0: return [from[0], from[2], to[0], to[2]];
		case 1: return [from[0], 16 - to[2], to[0], 16 - from[2]];
		case 2: return [16 - to[0], 16 - to[1], 16 - from[0], 16 - from[1]];
		case 3: return [from[0], 16 - to[1], to[0], 16 - from[1]];
		case 4: return [from[2], 16 - to[1], to[2], 16 - from[1]];
		default: return [16 - to[2], 16 - to[1], 16 - from[2], 16 - from[1]];
	}
}

function ns(id) {
	if (!id) return id;
	return id.includes(':') ? id : 'minecraft:' + id;
}

function decodeBase64(b64) {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

async function decodePng(b64) {
	return createImageBitmap(new Blob([decodeBase64(b64)], { type: 'image/png' }));
}

function rotate(p, axis, angle, origin, rescale) {
	const rad = angle * Math.PI / 180;
	const c = Math.cos(rad), s = Math.sin(rad);
	let x = p[0] - origin[0], y = p[1] - origin[1], z = p[2] - origin[2];
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

/** Block state variant rotation: first -x around X, then -y around Y, around the block centre. */
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

function snap(v) {
	const r = Math.round(v * 1e4) / 1e4;
	return Math.abs(r) < 1e-6 ? 0 : r;
}

export class Assets {
	/** Downloads the bundle; resolves to null when the server has no client assets. */
	static async load(gl, query, onStatus) {
		for (let attempt = 0; ; attempt++) {
			let response;
			try {
				response = await fetch('/assets/bundle.json' + query, { credentials: 'same-origin' });
			} catch {
				response = null;
			}
			if (response && response.ok) {
				onStatus?.('Tekstury: przygotowanie…');
				const bundle = await response.json();
				const assets = new Assets(gl, bundle);
				await assets.buildAtlas();
				await assets.loadColormaps();
				await assets.loadEnvironment();
				return assets;
			}
			if (response && response.status === 404) return null;
			onStatus?.('Serwer pobiera tekstury Minecrafta…');
			await new Promise(r => setTimeout(r, Math.min(10000, 2000 + attempt * 1000)));
		}
	}

	constructor(gl, bundle) {
		this.gl = gl;
		this.bundle = bundle;
		this.sprites = new Map();
		this.resolvedModels = new Map();
		this.animated = [];
		this.colormaps = {};
		this.missing = null;
	}

	async buildAtlas() {
		const gl = this.gl;
		const entries = Object.entries(this.bundle.textures);
		const images = await Promise.all(entries.map(([, b64]) => decodePng(b64).catch(() => null)));

		let cell = 16;
		for (const image of images) {
			if (image) cell = Math.max(cell, Math.min(64, image.width));
		}
		const count = entries.length + 1;
		const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
		let size = 256;
		while ((size / cell) * (size / cell) < count && size < maxSize) size *= 2;
		const perRow = size / cell;

		const canvas = document.createElement('canvas');
		canvas.width = size;
		canvas.height = size;
		const g = canvas.getContext('2d', { willReadFrequently: true });
		g.imageSmoothingEnabled = false;

		// Slot 0: magenta/black "missing" texture.
		g.fillStyle = '#f800f8';
		g.fillRect(0, 0, cell, cell);
		g.fillStyle = '#000';
		g.fillRect(0, 0, cell / 2, cell / 2);
		g.fillRect(cell / 2, cell / 2, cell / 2, cell / 2);
		this.missing = this.makeSprite(0, perRow, cell, size, MAT_OPAQUE);

		const animations = this.bundle.animations || {};
		for (let i = 0; i < entries.length; i++) {
			const image = images[i];
			if (!image) continue;
			const id = entries[i][0];
			const slot = i + 1;
			const x = (slot % perRow) * cell, y = Math.floor(slot / perRow) * cell;
			const frameSize = image.width;
			g.clearRect(x, y, cell, cell);
			g.drawImage(image, 0, 0, frameSize, Math.min(frameSize, image.height), x, y, cell, cell);

			const material = this.classify(g.getImageData(x, y, cell, cell).data);
			const sprite = this.makeSprite(slot, perRow, cell, size, material);
			this.sprites.set(id, sprite);

			const meta = animations[id];
			const frameCount = Math.floor(image.height / frameSize);
			if (frameCount > 1) {
				const frames = [];
				for (let f = 0; f < frameCount; f++) {
					frames.push(await createImageBitmap(image, 0, f * frameSize, frameSize, frameSize,
						{ resizeWidth: cell, resizeHeight: cell, resizeQuality: 'pixelated' }));
				}
				const animation = (meta && meta.animation) || {};
				const frametime = animation.frametime || 1;
				const order = (animation.frames || frames.map((_, f) => f)).map(f => typeof f === 'object'
					? { index: f.index, time: f.time || frametime } : { index: f, time: frametime });
				const total = order.reduce((sum, f) => sum + f.time, 0);
				this.animated.push({ x, y, frames, order, total, current: -1 });
			}
		}

		this.atlasSize = size;
		this.cell = cell;
		this.texture = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, this.texture);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, Math.log2(cell));
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.generateMipmap(gl.TEXTURE_2D);
	}

	makeSprite(slot, perRow, cell, size, material) {
		const x = (slot % perRow) * cell, y = Math.floor(slot / perRow) * cell;
		return { u0: x / size, v0: y / size, u1: (x + cell) / size, v1: (y + cell) / size, material };
	}

	classify(pixels) {
		let partial = 0, transparent = 0;
		const n = pixels.length / 4;
		for (let i = 3; i < pixels.length; i += 4) {
			const a = pixels[i];
			if (a < 5) transparent++;
			else if (a < 250) partial++;
		}
		if (partial > n * 0.05) return MAT_TRANSLUCENT;
		if (transparent > 0 || partial > 0) return MAT_CUTOUT;
		return MAT_OPAQUE;
	}

	/** Advances animated textures (water, lava, fire, portals...). Call once per game tick. */
	tick(ticks) {
		if (!this.animated.length) return;
		const gl = this.gl;
		let dirty = false;
		gl.bindTexture(gl.TEXTURE_2D, this.texture);
		for (const a of this.animated) {
			let t = ticks % a.total;
			let frame = a.order[0].index;
			for (const f of a.order) {
				if (t < f.time) { frame = f.index; break; }
				t -= f.time;
			}
			if (frame === a.current || !a.frames[frame]) continue;
			a.current = frame;
			gl.texSubImage2D(gl.TEXTURE_2D, 0, a.x, a.y, gl.RGBA, gl.UNSIGNED_BYTE, a.frames[frame]);
			dirty = true;
		}
		if (dirty) gl.generateMipmap(gl.TEXTURE_2D);
	}

	async loadColormaps() {
		for (const [name, b64] of Object.entries(this.bundle.colormaps || {})) {
			const image = await decodePng(b64).catch(() => null);
			if (!image) continue;
			const canvas = document.createElement('canvas');
			canvas.width = image.width;
			canvas.height = image.height;
			const g = canvas.getContext('2d');
			g.drawImage(image, 0, 0);
			this.colormaps[name] = { width: image.width, height: image.height, data: g.getImageData(0, 0, image.width, image.height).data };
		}
	}

	/** Sun, moon phases (as a 4x2 grid like the old moon_phases.png) and clouds. */
	async loadEnvironment() {
		const env = this.bundle.environment || {};
		const gl = this.gl;
		const texture = (source, repeat) => {
			const t = gl.createTexture();
			gl.bindTexture(gl.TEXTURE_2D, t);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
			return t;
		};

		const sun = env['celestial/sun'] || env.sun;
		if (sun) this.sunTexture = texture(await decodePng(sun), false);

		const phases = ['full_moon', 'waning_gibbous', 'third_quarter', 'waning_crescent', 'new_moon', 'waxing_crescent', 'first_quarter', 'waxing_gibbous'];
		if (env['celestial/moon/full_moon']) {
			const images = await Promise.all(phases.map(p => env['celestial/moon/' + p] ? decodePng(env['celestial/moon/' + p]) : null));
			const size = images[0].width;
			const canvas = document.createElement('canvas');
			canvas.width = size * 4;
			canvas.height = size * 2;
			const g = canvas.getContext('2d');
			images.forEach((image, i) => image && g.drawImage(image, (i % 4) * size, Math.floor(i / 4) * size, size, size));
			this.moonTexture = texture(canvas, false);
		} else if (env.moon_phases) {
			this.moonTexture = texture(await decodePng(env.moon_phases), false);
		}

		if (env.clouds) this.cloudTexture = texture(await decodePng(env.clouds), true);
	}

	/** Colour from a biome colormap (grass.png / foliage.png) like GrassColor.get. */
	colormap(name, temperature, downfall, fallback) {
		const map = this.colormaps[name];
		if (!map) return fallback;
		const t = Math.min(1, Math.max(0, temperature));
		const d = Math.min(1, Math.max(0, downfall)) * t;
		const i = Math.floor((1 - t) * 255);
		const j = Math.floor((1 - d) * 255);
		if (i >= map.width || j >= map.height) return fallback;
		const k = (j * map.width + i) * 4;
		return (map.data[k] << 16) | (map.data[k + 1] << 8) | map.data[k + 2];
	}

	sprite(textureId) {
		return this.sprites.get(ns(textureId)) || this.missing;
	}

	// --- models -------------------------------------------------------------

	/** Resolves a model id with its parents into {elements, textures, ao}. */
	resolveModel(id) {
		id = ns(id);
		if (this.resolvedModels.has(id)) return this.resolvedModels.get(id);
		const chain = [];
		let current = id;
		for (let depth = 0; current && depth < 32; depth++) {
			const model = this.bundle.models[current];
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
		const resolved = { elements: elements || [], textures, ao };
		this.resolvedModels.set(id, resolved);
		return resolved;
	}

	resolveTexture(textures, ref) {
		// Since 1.21.x a texture can also be {"sprite": "...", "force_translucent": true}.
		const unwrap = r => (r && typeof r === 'object' ? r.sprite : r);
		ref = unwrap(ref);
		for (let i = 0; i < 16 && typeof ref === 'string' && ref.startsWith('#'); i++) {
			ref = unwrap(textures[ref.slice(1)]);
		}
		return typeof ref === 'string' && !ref.startsWith('#') ? ns(ref) : null;
	}

	/** Model applications for a block state: {alternatives: [[{model, x, y, uvlock}...]...]} */
	selectModels(name, props) {
		const def = this.bundle.blockstates[name];
		if (!def) return null;

		const pick = value => (Array.isArray(value) ? value : [value]);
		if (def.variants) {
			for (const [key, value] of Object.entries(def.variants)) {
				if (key === '' || key === 'normal' || key.split(',').every(pair => {
					const [k, v] = pair.split('=');
					return props[k] === v;
				})) {
					return pick(value).map(v => [v]);
				}
			}
			return null;
		}
		if (def.multipart) {
			const parts = [];
			for (const part of def.multipart) {
				if (!part.when || this.matches(part.when, props)) {
					parts.push(pick(part.apply)[0]);
				}
			}
			return [parts];
		}
		return null;
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

	/**
	 * Bakes a block state into quads. Returns null when there is no usable model (the mesher then draws the
	 * server's collision/outline boxes with a flat colour, e.g. chests and signs which the client draws as entities).
	 */
	bake(name, props) {
		const selections = this.selectModels(name, props);
		if (!selections) return null;
		const alternatives = [];
		let ao = true;
		for (const applications of selections) {
			const quads = [];
			for (const app of applications) {
				if (!app || !app.model) continue;
				const model = this.resolveModel(app.model);
				if (!model.ao) ao = false;
				for (const element of model.elements) {
					this.bakeElement(quads, element, model.textures, app.x || 0, app.y || 0, !!app.uvlock);
				}
			}
			alternatives.push(quads);
		}
		if (alternatives.every(q => q.length === 0)) return null;
		return { alternatives, ao };
	}

	bakeElement(out, element, textures, rx, ry, uvlock) {
		const from = element.from, to = element.to;
		const rotation = element.rotation;
		for (const [dirName, face] of Object.entries(element.faces || {})) {
			const dir = DIR_INDEX[dirName];
			if (dir === undefined) continue;
			const textureId = this.resolveTexture(textures, face.texture);
			const sprite = textureId ? this.sprite(textureId) : this.missing;

			let positions = FACE_VERTICES[dir].map(c => [c[0] ? to[0] : from[0], c[1] ? to[1] : from[1], c[2] ? to[2] : from[2]]);
			if (rotation && rotation.angle) {
				positions = positions.map(p => rotate(p, rotation.axis, rotation.angle, rotation.origin || [8, 8, 8], rotation.rescale));
			}
			if (rx || ry) positions = positions.map(p => variantRotate(p, rx, ry));

			// Face normal after all rotations.
			const a = positions[0], b = positions[1], c = positions[2];
			const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
			const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
			let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
			const len = Math.hypot(n[0], n[1], n[2]) || 1;
			n = [n[0] / len, n[1] / len, n[2] / len];
			const [finalDir, alignment] = nearestDir(n);
			const aligned = alignment > 0.999;

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
				uv = defaultUv(finalDir, min, max);
				uvRotation = 0;
			}

			// Corner i -> (u, v): 0 = (u0, v0), 1 = (u0, v1), 2 = (u1, v1), 3 = (u1, v0), shifted by the face rotation.
			const uvs = new Float32Array(8);
			const du = sprite.u1 - sprite.u0, dv = sprite.v1 - sprite.v0;
			for (let i = 0; i < 4; i++) {
				const k = (i + uvRotation / 90) % 4;
				const u = (k === 0 || k === 1) ? uv[0] : uv[2];
				const v = (k === 0 || k === 3) ? uv[1] : uv[3];
				uvs[i * 2] = sprite.u0 + du * Math.min(16, Math.max(0, u)) / 16;
				uvs[i * 2 + 1] = sprite.v0 + dv * Math.min(16, Math.max(0, v)) / 16;
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

			// Does the quad lie on the block boundary plane of its direction? (affects smooth lighting samples)
			const axis = finalDir < 2 ? 1 : finalDir < 4 ? 2 : 0;
			const boundary = finalDir === 0 || finalDir === 3 || finalDir === 5 ? 1 : 0;
			let onFace = aligned;
			for (let i = 0; i < 4 && onFace; i++) {
				if (Math.abs(pos[i * 3 + axis] - boundary) > 1e-4) onFace = false;
			}

			out.push({
				pos,
				uvs,
				dir: finalDir,
				aligned,
				onFace,
				cull,
				tint: face.tintindex === undefined ? -1 : face.tintindex,
				shade: element.shade !== false,
				material: sprite.material,
				light: element.light_emission || 0,
			});
		}
	}

	// --- fluids -------------------------------------------------------------

	fluidSprites(water) {
		if (!this._fluid) {
			this._fluid = {
				water: { still: this.sprite('block/water_still'), flow: this.sprite('block/water_flow') },
				lava: { still: this.sprite('block/lava_still'), flow: this.sprite('block/lava_flow') },
			};
		}
		return water ? this._fluid.water : this._fluid.lava;
	}
}
