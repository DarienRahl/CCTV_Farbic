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

// --- MipmapGenerator (26.3): the mip levels of a sprite by its texture's mipmap_strategy -----------------

// ARGB.SRGB_TO_LINEAR / LINEAR_TO_SRGB: 10-bit linear lookup tables
const SRGB_TO_LINEAR = new Uint16Array(256);
const LINEAR_TO_SRGB = new Uint8Array(1024);
for (let i = 0; i < 256; i++) {
	const c = i / 255;
	SRGB_TO_LINEAR[i] = Math.round((c >= 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92) * 1023);
}
for (let i = 0; i < 1024; i++) {
	const c = i / 1023;
	LINEAR_TO_SRGB[i] = Math.round((c >= 0.0031308 ? 1.055 * Math.pow(c, 1 / 2.4) - 0.055 : 12.92 * c) * 255);
}
const MIP_ALPHA_CUTOFF = 0.5, STRICT_ALPHA_CUTOFF = 0.3;

/** Transparency.hasTransparent: a pixel with no alpha at all. */
function hasTransparentPixel(pixels) {
	for (let i = 3; i < pixels.length; i += 4) if (pixels[i] === 0) return true;
	return false;
}

/** MipmapGenerator.alphaTestCoverage: the share passing the alpha test, sampled 4x4 between texel centres. */
function alphaTestCoverage(px, size, alphaRef, alphaScale) {
	let total = 0;
	const alphaAt = (x, y) => Math.min(1, Math.max(0, px[(y * size + x) * 4 + 3] / 255 * alphaScale));
	for (let y = 0; y < size - 1; y++) {
		for (let x = 0; x < size - 1; x++) {
			const a00 = alphaAt(x, y), a10 = alphaAt(x + 1, y), a01 = alphaAt(x, y + 1), a11 = alphaAt(x + 1, y + 1);
			let texel = 0;
			for (let sy = 0; sy < 4; sy++) {
				const fy = (sy + 0.5) / 4;
				for (let sx = 0; sx < 4; sx++) {
					const fx = (sx + 0.5) / 4;
					const alpha = a00 * (1 - fx) * (1 - fy) + a10 * fx * (1 - fy) + a01 * (1 - fx) * fy + a11 * fx * fy;
					if (alpha > alphaRef) texel++;
				}
			}
			total += texel / 16;
		}
	}
	return size > 1 ? total / ((size - 1) * (size - 1)) : 0;
}

/** MipmapGenerator.scaleAlphaToCoverage: the alpha scale (searched 5 steps) that keeps level 0's coverage. */
function scaleAlphaToCoverage(px, size, desired, alphaRef, bias) {
	let min = 0, max = 4, scale = 1, best = 1, bestError = Infinity;
	for (let i = 0; i < 5; i++) {
		const current = alphaTestCoverage(px, size, alphaRef, scale);
		const error = Math.abs(current - desired);
		if (error < bestError) {
			bestError = error;
			best = scale;
		}
		if (current < desired) min = scale;
		else if (current > desired) max = scale;
		else break;
		scale = (min + max) * 0.5;
	}
	for (let i = 3; i < px.length; i += 4) {
		const alpha = Math.min(1, Math.max(0, px[i] / 255 * best + bias + 0.025));
		px[i] = Math.floor(alpha * 255);
	}
}

/** TextureUtil.solidify: invisible pixels take the colour of the nearest visible one (a breadth-first fill). */
function solidify(px, size) {
	const n = size * size;
	const distance = new Int32Array(n).fill(0x7fffffff);
	const nearest = new Int32Array(n);
	const queue = [];
	for (let i = 0; i < n; i++) {
		if (px[i * 4 + 3] !== 0) {
			distance[i] = 0;
			nearest[i] = i;
			queue.push(i);
		}
	}
	for (let head = 0; head < queue.length; head++) {
		const i = queue[head], x = i % size, y = (i / size) | 0;
		for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
			const nx = x + dx, ny = y + dy;
			if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
			const j = ny * size + nx;
			if (distance[j] > distance[i] + 1) {
				distance[j] = distance[i] + 1;
				nearest[j] = nearest[i];
				queue.push(j);
			}
		}
	}
	if (!queue.length) return;
	for (let i = 0; i < n; i++) {
		if (px[i * 4 + 3] !== 0) continue;
		const from = nearest[i] * 4;
		px[i * 4] = px[from]; px[i * 4 + 1] = px[from + 1]; px[i * 4 + 2] = px[from + 2];
	}
}

/** TextureUtil.fillEmptyAreasWithDarkColor: invisible pixels take 3/4 of the darkest visible colour. */
function fillEmptyAreasWithDarkColor(px) {
	let darkest = -1, min = Infinity;
	for (let i = 0; i < px.length; i += 4) {
		if (px[i + 3] === 0) continue;
		const brightness = px[i] + px[i + 1] + px[i + 2];
		if (brightness < min) {
			min = brightness;
			darkest = i;
		}
	}
	// ARGB of -1 (no visible pixel) is white
	const r = darkest < 0 ? 255 : px[darkest], g = darkest < 0 ? 255 : px[darkest + 1], b = darkest < 0 ? 255 : px[darkest + 2];
	for (let i = 0; i < px.length; i += 4) {
		if (px[i + 3] !== 0) continue;
		px[i] = Math.floor(3 * r / 4); px[i + 1] = Math.floor(3 * g / 4); px[i + 2] = Math.floor(3 * b / 4);
	}
}

/**
 * MipmapGenerator.generateMipLevels: the mip chain of one square sprite (RGBA, size x size). strategy is the
 * texture's mipmap_strategy (auto: cutout when it has invisible pixels, else mean); the colours are averaged in
 * linear light (ARGB.meanLinear), leaves' dark_cutout blends only visible pixels, and the cutout strategies scale
 * each level's alpha so as much of it passes the alpha test as of level 0 (plus alpha_cutoff_bias).
 */
function buildMips(pixels, size, { strategy = 'auto', bias = 0, item = false, transparent = null } = {}) {
	if (strategy === 'auto') strategy = (transparent ?? hasTransparentPixel(pixels)) ? 'cutout' : 'mean';
	const cutout = strategy === 'cutout' || strategy === 'strict_cutout' || strategy === 'dark_cutout';
	let base = pixels;
	if (!item && strategy !== 'mean') {
		base = Uint8ClampedArray.from(pixels);
		if (strategy === 'dark_cutout') fillEmptyAreasWithDarkColor(base);
		else solidify(base, size);
	}
	const levels = [base];
	const cutoutRef = strategy === 'strict_cutout' ? STRICT_ALPHA_CUTOFF : MIP_ALPHA_CUTOFF;
	const original = cutout ? alphaTestCoverage(base, size, cutoutRef, 1) : 0;
	let src = base, s = size;
	while (s > 1) {
		const d = s >> 1;
		const out = new Uint8ClampedArray(d * d * 4);
		for (let y = 0; y < d; y++) {
			for (let x = 0; x < d; x++) {
				const i1 = ((y * 2) * s + x * 2) * 4, i2 = i1 + 4, i3 = i1 + s * 4, i4 = i3 + 4;
				const o = (y * d + x) * 4;
				if (strategy === 'dark_cutout') {
					// darkenedAlphaBlend: the linear mean of the visible pixels only, alpha included
					let a = 0, r = 0, g = 0, b = 0;
					for (const i of [i1, i2, i3, i4]) {
						if (src[i + 3] === 0) continue;
						a += SRGB_TO_LINEAR[src[i + 3]] / 1023; r += SRGB_TO_LINEAR[src[i]] / 1023;
						g += SRGB_TO_LINEAR[src[i + 1]] / 1023; b += SRGB_TO_LINEAR[src[i + 2]] / 1023;
					}
					const srgb = v => LINEAR_TO_SRGB[Math.floor(v / 4 * 1023)];
					out[o] = srgb(r); out[o + 1] = srgb(g); out[o + 2] = srgb(b); out[o + 3] = srgb(a);
				} else {
					// ARGB.meanLinear
					for (let c = 0; c < 3; c++) {
						out[o + c] = LINEAR_TO_SRGB[(SRGB_TO_LINEAR[src[i1 + c]] + SRGB_TO_LINEAR[src[i2 + c]]
							+ SRGB_TO_LINEAR[src[i3 + c]] + SRGB_TO_LINEAR[src[i4 + c]]) >> 2];
					}
					out[o + 3] = (src[i1 + 3] + src[i2 + 3] + src[i3 + 3] + src[i4 + 3]) >> 2;
				}
			}
		}
		if (cutout) scaleAlphaToCoverage(out, d, original, cutoutRef, bias);
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
		this.missing = { ...place(0, buildMips(missing, cell)), material: MAT_OPAQUE };

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
			// TextureMetadataSection (the .mcmeta's "texture" part) and the sprite's Transparency over all frames
			const texture = (animations[id] && animations[id].texture) || {};
			const mipOptions = {
				strategy: texture.mipmap_strategy || 'auto', bias: Number(texture.alpha_cutoff_bias) || 0,
				item: /^[^:]*:item\//.test(id), transparent: frames.some(hasTransparentPixel),
			};
			const sprite = { ...place(i + 1, buildMips(frames[0], cell, mipOptions)), material };
			this.sprites.set(id, sprite);

			if (meta && frames.length > 1) {
				const frametime = Math.max(1, meta.frametime || 1);
				const order = (meta.frames || frames.map((_, f) => f)).map(f => (typeof f === 'object'
					? { index: f.index, time: Math.max(1, f.time || frametime) } : { index: f, time: frametime }))
					.filter(f => frames[f.index]);
				if (order.length > 1) {
					this.animated.push({
						sprite, frames, order, interpolate: !!meta.interpolate, mipOptions,
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
				mips = buildMips(pixels, this.cell, a.mipOptions);
			} else {
				if (key === a.current) continue;
				mips = a.mips.get(frame.index);
				if (!mips) {
					mips = buildMips(a.frames[frame.index], this.cell, a.mipOptions);
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
