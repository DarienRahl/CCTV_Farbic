// Minecraft client assets in the browser: the block/item texture atlas with
// its mipmaps and animations, environment textures (sun, moon, clouds, rain,
// End sky...) and the data the meshing workers need (models, sprites,
// colormaps). Mipmaps are built once per sprite and animated sprites only
// upload their own pixels, so animations never stall the page.

import { BlockModels, MAT_OPAQUE, MAT_CUTOUT, MAT_TRANSLUCENT, ns } from './models.js';

export { MAT_OPAQUE, MAT_CUTOUT, MAT_TRANSLUCENT };

function decodeBase64(b64) {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

async function decodePng(b64) {
	return createImageBitmap(new Blob([decodeBase64(b64)], { type: 'image/png' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

function pixelsOf(image, width = image.width, height = image.height, sx = 0, sy = 0, sw = image.width, sh = image.height) {
	const canvas = new OffscreenCanvas(width, height);
	const g = canvas.getContext('2d', { willReadFrequently: true });
	g.imageSmoothingEnabled = false;
	g.drawImage(image, sx, sy, sw, sh, 0, 0, width, height);
	return g.getImageData(0, 0, width, height).data;
}

/** SpriteContents transparency: 0 = opaque, 1 = has fully transparent pixels, 2 = has translucent pixels. */
function transparencyOf(pixels) {
	let transparent = false;
	for (let i = 3; i < pixels.length; i += 4) {
		const a = pixels[i];
		if (a === 0) transparent = true;
		else if (a !== 255) return 2;
	}
	return transparent ? 1 : 0;
}

function coverage(pixels, scale) {
	let covered = 0;
	for (let i = 3; i < pixels.length; i += 4) {
		if (Math.min(255, pixels[i] * scale) >= 128) covered++;
	}
	return covered / (pixels.length / 4);
}

/**
 * Mip chain of one square sprite (RGBA, size x size): alpha weighted box filter; cutout sprites keep
 * their alpha-test coverage so leaves and plants do not thin out in the distance.
 */
function buildMips(pixels, size, cutout) {
	const levels = [pixels];
	const target = cutout ? coverage(pixels, 1) : 0;
	let src = pixels, s = size;
	while (s > 1) {
		const d = s >> 1;
		const out = new Uint8ClampedArray(d * d * 4);
		for (let y = 0; y < d; y++) {
			for (let x = 0; x < d; x++) {
				let r = 0, g = 0, b = 0, a = 0, w = 0;
				for (let k = 0; k < 4; k++) {
					const i = (((y * 2 + (k >> 1)) * s) + x * 2 + (k & 1)) * 4;
					const alpha = src[i + 3];
					const weight = alpha + 1;
					r += src[i] * weight; g += src[i + 1] * weight; b += src[i + 2] * weight;
					a += alpha;
					w += weight;
				}
				const o = (y * d + x) * 4;
				out[o] = r / w; out[o + 1] = g / w; out[o + 2] = b / w; out[o + 3] = a / 4;
			}
		}
		if (cutout && target > 0) {
			// Scale alpha until the share of pixels passing the 0.5 test matches level 0.
			let lo = 0.5, hi = 8;
			for (let i = 0; i < 12; i++) {
				const mid = (lo + hi) / 2;
				if (coverage(out, mid) < target) lo = mid; else hi = mid;
			}
			for (let i = 3; i < out.length; i += 4) out[i] = Math.min(255, out[i] * hi);
		}
		levels.push(out);
		src = out;
		s = d;
	}
	return levels;
}

function texture(gl, source, { repeat = false, linear = false, mipmaps = false } = {}) {
	const t = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, t);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmaps ? gl.NEAREST_MIPMAP_LINEAR : (linear ? gl.LINEAR : gl.NEAREST));
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
	if (mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
	return t;
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
				onStatus?.('Textures: preparing…');
				const bundle = await response.json();
				const assets = new Assets(gl, bundle);
				await assets.buildAtlas();
				await assets.loadColormaps();
				await assets.loadEnvironment();
				return assets;
			}
			if (response && response.status === 404) return null;
			onStatus?.('The server is downloading Minecraft textures…');
			await new Promise(r => setTimeout(r, Math.min(10000, 2000 + attempt * 1000)));
		}
	}

	constructor(gl, bundle) {
		this.gl = gl;
		this.bundle = bundle;
		this.sprites = new Map();
		this.animated = [];
		this.colormaps = {};
		this.environment = {};
		this.missing = null;
		this.models = null;
	}

	async buildAtlas() {
		const gl = this.gl;
		const entries = Object.entries(this.bundle.textures);
		const images = await Promise.all(entries.map(([, b64]) => decodePng(b64).catch(() => null)));

		let cell = 16;
		for (const image of images) {
			if (image) cell = Math.max(cell, Math.min(64, 2 ** Math.round(Math.log2(image.width))));
		}
		const count = entries.length + 1;
		let size = 256;
		const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
		while ((size / cell) * (size / cell) < count && size < maxSize) size *= 2;
		const perRow = size / cell;
		const levels = Math.log2(cell) + 1;
		const atlas = [];
		for (let l = 0; l < levels; l++) atlas.push(new Uint8ClampedArray((size >> l) * (size >> l) * 4));

		const place = (slot, mips) => {
			const x = (slot % perRow) * cell, y = Math.floor(slot / perRow) * cell;
			for (let l = 0; l < levels; l++) {
				const s = cell >> l, w = size >> l, px = x >> l, py = y >> l;
				const src = mips[l];
				for (let row = 0; row < s; row++) atlas[l].set(src.subarray(row * s * 4, (row + 1) * s * 4), ((py + row) * w + px) * 4);
			}
			return { u0: x / size, v0: y / size, u1: (x + cell) / size, v1: (y + cell) / size, x, y, shrink: cell / (4 * size) };
		};

		// Slot 0: the magenta/black "missing" texture.
		const missing = new Uint8ClampedArray(cell * cell * 4);
		for (let y = 0; y < cell; y++) {
			for (let x = 0; x < cell; x++) {
				const magenta = (x < cell / 2) !== (y < cell / 2);
				missing.set(magenta ? [248, 0, 248, 255] : [0, 0, 0, 255], (y * cell + x) * 4);
			}
		}
		this.missing = { ...place(0, buildMips(missing, cell, false)), material: MAT_OPAQUE };

		const animations = this.bundle.animations || {};
		for (let i = 0; i < entries.length; i++) {
			const image = images[i];
			if (!image) continue;
			const id = entries[i][0];
			const meta = animations[id] && animations[id].animation;
			const frameW = meta && meta.width ? meta.width : image.width;
			const frameH = meta && meta.height ? meta.height : Math.min(frameW, image.height);
			const framesPerRow = Math.max(1, Math.floor(image.width / frameW));
			const frameCount = Math.max(1, framesPerRow * Math.floor(image.height / frameH));
			const frames = [];
			let transparency = 0;
			for (let f = 0; f < frameCount; f++) {
				const fx = (f % framesPerRow) * frameW, fy = Math.floor(f / framesPerRow) * frameH;
				const pixels = pixelsOf(image, cell, cell, fx, fy, frameW, frameH);
				transparency = Math.max(transparency, transparencyOf(pixels));
				frames.push(pixels);
				if (!meta && f === 0) break;
			}
			const material = transparency === 2 ? MAT_TRANSLUCENT : transparency === 1 ? MAT_CUTOUT : MAT_OPAQUE;
			const sprite = { ...place(i + 1, buildMips(frames[0], cell, material === MAT_CUTOUT)), material };
			this.sprites.set(id, sprite);

			if (meta && frames.length > 1) {
				const frametime = Math.max(1, meta.frametime || 1);
				const order = (meta.frames || frames.map((_, f) => f)).map(f => (typeof f === 'object'
					? { index: f.index, time: Math.max(1, f.time || frametime) } : { index: f, time: frametime }))
					.filter(f => frames[f.index]);
				if (order.length > 1) {
					this.animated.push({
						sprite, frames, order, interpolate: !!meta.interpolate, cutout: material === MAT_CUTOUT,
						total: order.reduce((sum, f) => sum + f.time, 0), mips: new Map(), current: '',
					});
				}
			}
		}

		this.atlasSize = size;
		this.cell = cell;
		this.levels = levels;
		this.atlasPixels = atlas[0]; // item models are extruded from the sprite pixels
		const t = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, t);
		gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, size, size);
		for (let l = 0; l < levels; l++) {
			gl.texSubImage2D(gl.TEXTURE_2D, l, 0, 0, size >> l, size >> l, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(atlas[l].buffer));
		}
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, levels - 1);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		this.texture = t;
		this.models = new BlockModels(this.bundle.blockstates, this.bundle.models, this.sprites, this.missing);
	}

	/** Advances animated textures (water, lava, fire, portals...). Call once per game tick. */
	tick(ticks) {
		if (!this.animated.length) return;
		const gl = this.gl;
		gl.bindTexture(gl.TEXTURE_2D, this.texture);
		for (const a of this.animated) {
			let t = ticks % a.total;
			let step = 0;
			while (t >= a.order[step].time) {
				t -= a.order[step].time;
				step++;
			}
			const frame = a.order[step];
			let key = String(frame.index), mips;
			if (a.interpolate) {
				// Mix towards the next frame like the client's interpolated animations.
				const next = a.order[(step + 1) % a.order.length];
				const mix = t / frame.time;
				key = frame.index + ':' + next.index + ':' + Math.round(mix * 32);
				if (key === a.current) continue;
				const from = a.frames[frame.index], to = a.frames[next.index];
				const pixels = new Uint8ClampedArray(from.length);
				for (let i = 0; i < pixels.length; i++) pixels[i] = from[i] + (to[i] - from[i]) * mix;
				mips = buildMips(pixels, this.cell, a.cutout);
			} else {
				if (key === a.current) continue;
				mips = a.mips.get(frame.index);
				if (!mips) {
					mips = buildMips(a.frames[frame.index], this.cell, a.cutout);
					a.mips.set(frame.index, mips);
				}
			}
			a.current = key;
			for (let l = 0; l < this.levels; l++) {
				const s = this.cell >> l;
				gl.texSubImage2D(gl.TEXTURE_2D, l, a.sprite.x >> l, a.sprite.y >> l, s, s, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(mips[l].buffer));
			}
		}
	}

	async loadColormaps() {
		for (const [name, b64] of Object.entries(this.bundle.colormaps || {})) {
			const image = await decodePng(b64).catch(() => null);
			if (!image) continue;
			this.colormaps[name] = { width: image.width, height: image.height, data: pixelsOf(image) };
		}
	}

	/** Sun, moon phases, End sky and flash, clouds, rain and snow. */
	async loadEnvironment() {
		const env = this.bundle.environment || {};
		const gl = this.gl;
		const load = async (name, options) => (env[name] ? texture(gl, await decodePng(env[name]), options) : null);
		const e = this.environment;
		e.sun = await load('celestial/sun');
		e.endFlash = await load('celestial/end_flash');
		e.endSky = await load('end_sky', { repeat: true });
		e.rain = await load('rain', { repeat: true });
		e.snow = await load('snow', { repeat: true });
		e.moon = [];
		for (const phase of ['full_moon', 'waning_gibbous', 'third_quarter', 'waning_crescent', 'new_moon', 'waxing_crescent', 'first_quarter', 'waxing_gibbous']) {
			e.moon.push(await load('celestial/moon/' + phase));
		}
		if (env.clouds) {
			const image = await decodePng(env.clouds);
			e.clouds = { width: image.width, height: image.height, data: pixelsOf(image) };
		}
	}

	/** Everything the meshing workers need (structured clone). */
	workerPayload() {
		const sprite = id => this.sprites.get(id) || null;
		return {
			blockstates: this.bundle.blockstates,
			models: this.bundle.models,
			sprites: [...this.sprites.entries()],
			missing: this.missing,
			fluids: {
				water: { still: sprite('minecraft:block/water_still'), flow: sprite('minecraft:block/water_flow'), overlay: sprite('minecraft:block/water_overlay') },
				lava: { still: sprite('minecraft:block/lava_still'), flow: sprite('minecraft:block/lava_flow') },
			},
			colormaps: this.colormaps,
		};
	}

	sprite(textureId) {
		return this.sprites.get(ns(textureId)) || this.missing;
	}

	/** GrassColor.get / FoliageColor.get (for items and entities drawn on the page). */
	colormap(name, temperature, downfall, fallback) {
		const map = this.colormaps[name];
		if (!map) return fallback;
		const t = Math.min(1, Math.max(0, temperature));
		const d = Math.min(1, Math.max(0, downfall)) * t;
		const index = Math.trunc((1 - d) * 255) << 8 | Math.trunc((1 - t) * 255);
		if (index >= map.width * map.height) return fallback;
		return map.data[index * 4] << 16 | map.data[index * 4 + 1] << 8 | map.data[index * 4 + 2];
	}
}
