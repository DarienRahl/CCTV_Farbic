// Text in the world drawn like the game does: Minecraft's own font from the client jar (font/default.json
// with its bitmap glyph sheets, the same glyph widths and ascents as in the game) and the text render
// types of TextFeatureRenderer / SubmitNodeCollection: see-through (name tags), normal and polygon offset
// (sign text), 8x outlines (glowing sign text), backgrounds, lightmap lighting and fog.

import { program, FOG_GLSL, setFog } from './gl.js';

const VS = `
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aUv;
layout(location = 2) in vec4 aColor;
layout(location = 3) in vec2 aLight;
uniform mat4 uViewProj;
uniform sampler2D uLightmap;
uniform int uLit;
out vec2 vUv;
out vec4 vColor;
out float vSph;
out float vCyl;
void main() {
	gl_Position = uViewProj * vec4(aPos, 1.0);
	vUv = aUv;
	vColor = uLit == 1 ? aColor * texture(uLightmap, clamp(aLight / 256.0 + 0.5 / 16.0, vec2(0.5 / 16.0), vec2(15.5 / 16.0))) : aColor;
	vSph = length(aPos);
	vCyl = max(length(aPos.xz), abs(aPos.y));
}`;

// rendertype_text(_background)(_see_through).fsh
const FS = `
in vec2 vUv;
in vec4 vColor;
in float vSph;
in float vCyl;
uniform sampler2D uTexture;
uniform int uTextured;
uniform int uFog;
${FOG_GLSL}
out vec4 outColor;
void main() {
	vec4 color = (uTextured == 1 ? texture(uTexture, vUv) : vec4(1.0)) * vColor;
	if (color.a < 0.1) discard;
	outColor = uFog == 1 ? apply_fog(color, vSph, vCyl) : color;
}`;

const FLOATS = 11; // position 3, uv 2, colour 4, light 2
const NAME_TAG_SCALE = 0.025; // EntityRenderer.NAMETAG_SCALE
const SEE_THROUGH_TEXT = [1, 1, 1, 0x80 / 255]; // 0x80FFFFFF
const BACKGROUND = [0, 0, 0, 0x40 / 255]; // options.getBackgroundOpacity(0.25)
const WHITE = [1, 1, 1, 1];
const FULL_BRIGHT = [240, 240];

/** Font.DisplayMode as render settings. */
const MODES = {
	see_through: { depth: false, lit: false, fog: false, offset: false },
	normal: { depth: true, lit: true, fog: true, offset: false },
	polygon_offset: { depth: true, lit: true, fog: true, offset: true },
};
const MODE_ORDER = ['normal', 'polygon_offset', 'see_through'];

/** Colour int (0xRRGGBB, alpha ignored) as floats. */
export function rgb(color, alpha = 1) {
	return [(color >> 16 & 255) / 255, (color >> 8 & 255) / 255, (color & 255) / 255, alpha];
}

/** (fx, fy) in font units -> camera relative position, for a column-major matrix. */
export function matrixTransform(m) {
	return (fx, fy) => [m[0] * fx + m[4] * fy + m[12], m[1] * fx + m[5] * fy + m[13], m[2] * fx + m[6] * fy + m[14]];
}

/** The game's default font: glyphs by code point from the bitmap providers, in provider order. */
export class GameFont {
	constructor(gl) {
		this.gl = gl;
		this.glyphs = new Map();
		this.ready = false;
		this.fallback = null;
	}

	/** Loads font/default.json and the glyph sheets it references (via /assets/font/). */
	async load(query) {
		const fetchFile = name => fetch('/assets/font/' + name + query, { credentials: 'same-origin' })
			.then(r => { if (!r.ok) throw new Error(name + ': ' + r.status); return r; });
		const providers = [];
		const collect = async (id, seen) => {
			if (seen.has(id)) return;
			seen.add(id);
			const definition = await (await fetchFile(id.replace(/^minecraft:/, '') + '.json')).json();
			for (const provider of definition.providers || []) {
				if (!filterMatches(provider.filter)) continue;
				if (provider.type === 'reference') await collect(provider.id, seen);
				else providers.push(provider);
			}
		};
		await collect('minecraft:default', new Set());
		for (const provider of providers) {
			if (provider.type === 'space') {
				for (const [chars, advance] of Object.entries(provider.advances || {})) {
					const cp = chars.codePointAt(0);
					if (!this.has(cp)) this.glyphs.set(cp, { advance, texture: null });
				}
			} else if (provider.type === 'bitmap' && /^(minecraft:)?font\//.test(provider.file)) {
				const blob = await (await fetchFile(provider.file.replace(/^(minecraft:)?font\//, ''))).blob();
				this.addBitmap(provider, await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }));
			}
		}
		this.ready = true;
	}

	/** BitmapProvider.Definition.load */
	addBitmap(provider, image) {
		const grid = (provider.chars || []).map(row => Array.from(row, ch => ch.codePointAt(0)));
		if (!grid.length || !grid[0].length) return;
		const canvas = document.createElement('canvas');
		canvas.width = image.width;
		canvas.height = image.height;
		const g = canvas.getContext('2d', { willReadFrequently: true });
		g.drawImage(image, 0, 0);
		const alpha = g.getImageData(0, 0, image.width, image.height).data;
		const cellW = Math.floor(image.width / grid[0].length);
		const cellH = Math.floor(image.height / grid.length);
		const height = provider.height ?? 8;
		const scale = height / cellH;
		const ascent = provider.ascent ?? 7;
		const texture = this.texture(image);
		grid.forEach((row, slotY) => row.forEach((cp, slotX) => {
			if (cp === 0 || this.has(cp)) return;
			// getActualGlyphWidth: the rightmost column with any visible pixel.
			let width = cellW - 1;
			find: for (; width >= 0; width--) {
				for (let y = 0; y < cellH; y++) {
					if (alpha[((slotY * cellH + y) * image.width + slotX * cellW + width) * 4 + 3] !== 0) break find;
				}
			}
			width += 1;
			this.glyphs.set(cp, {
				texture,
				advance: Math.floor(0.5 + width * scale) + 1,
				u0: slotX * cellW / image.width, v0: slotY * cellH / image.height,
				u1: (slotX + 1) * cellW / image.width, v1: (slotY + 1) * cellH / image.height,
				// SheetGlyphInfo: left 0, up 7 - ascent, size = pixels / oversample (1 / scale)
				up: 7 - ascent, w: cellW * scale, h: cellH * scale,
				// the sheet and the cell for 2D drawing (gui.js)
				image, sx: slotX * cellW, sy: slotY * cellH, sw: cellW, sh: cellH,
			});
		}));
	}

	/** A glyph from the font's sheets (not one the browser drew while they were still loading). */
	has(cp) {
		const glyph = this.glyphs.get(cp);
		return !!glyph && !glyph.fallback;
	}

	texture(source) {
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

	/** Characters without a glyph sheet (the game uses Unifont for them): drawn by the browser at Unifont's size. */
	glyph(cp) {
		let glyph = this.glyphs.get(cp);
		if (glyph) return glyph;
		if (!this.fallback) {
			const canvas = document.createElement('canvas');
			canvas.width = canvas.height = 512;
			this.fallback = { canvas, g: canvas.getContext('2d'), next: 0, texture: null, dirty: false };
		}
		const f = this.fallback;
		const slot = f.next++;
		if (slot >= 32 * 32) return this.glyphs.get(63) || { advance: 6, texture: null };
		const x = (slot % 32) * 16, y = Math.floor(slot / 32) * 16;
		f.g.font = '14px sans-serif';
		f.g.textBaseline = 'alphabetic';
		f.g.fillStyle = '#fff';
		const text = String.fromCodePoint(cp);
		const width = Math.min(16, Math.ceil(f.g.measureText(text).width));
		f.g.fillText(text, x, y + 13);
		f.dirty = true;
		glyph = {
			texture: null, fallback: true, advance: Math.ceil(width / 2) + 1,
			u0: x / 512, v0: y / 512, u1: (x + 16) / 512, v1: (y + 16) / 512, up: -1, w: 8, h: 8,
			image: f.canvas, sx: x, sy: y, sw: 16, sh: 16,
		};
		this.glyphs.set(cp, glyph);
		return glyph;
	}

	/** The first line of Font.split(text, width): the text broken at the last space (or character) that fits. */
	clip(text, width) {
		if (this.width(text) <= width) return text;
		let used = 0, cut = 0, lastSpace = -1, i = 0;
		for (const ch of text) {
			used += this.glyph(ch.codePointAt(0)).advance;
			if (used > width) break;
			if (ch === ' ') lastSpace = i;
			i += ch.length;
			cut = i;
		}
		return lastSpace > 0 ? text.slice(0, lastSpace) : text.slice(0, cut);
	}

	/** Font.width */
	width(text) {
		let width = 0;
		for (const ch of text) width += this.glyph(ch.codePointAt(0)).advance;
		return width;
	}

	/** Uploads browser-drawn glyphs added since the last frame. */
	flush() {
		const f = this.fallback;
		if (!f || !f.dirty) return;
		f.dirty = false;
		if (f.texture) this.gl.deleteTexture(f.texture);
		f.texture = this.texture(f.canvas);
		for (const glyph of this.glyphs.values()) if (glyph.fallback) glyph.texture = f.texture;
	}
}

/** Font provider filters ("uniform", "jp" options), all off like the game's defaults. */
function filterMatches(filter) {
	if (!filter) return true;
	return Object.entries(filter).every(([, value]) => value === false);
}

export class TextRenderer {
	constructor(gl) {
		this.gl = gl;
		this.font = new GameFont(gl);
		this.program = program(gl, VS, FS);
		this.data = new Float32Array(FLOATS * 6 * 256);
		this.count = 0;
		this.draws = [];
		this.items = [];
		this.vao = gl.createVertexArray();
		this.vbo = gl.createBuffer();
		gl.bindVertexArray(this.vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
		const stride = FLOATS * 4;
		const attrib = (index, size, offset) => {
			gl.enableVertexAttribArray(index);
			gl.vertexAttribPointer(index, size, gl.FLOAT, false, stride, offset * 4);
		};
		attrib(0, 3, 0); attrib(1, 2, 3); attrib(2, 4, 5); attrib(3, 2, 9);
		gl.bindVertexArray(null);
	}

	load(query) {
		if (this.loading) return;
		this.loading = this.font.load(query).catch(error => {
			console.warn('CCTV: the Minecraft font is not available, name tags and sign text are hidden', error);
		});
	}

	get ready() {
		return this.font.ready;
	}

	/** Starts a frame's text. */
	begin() {
		this.items = [];
	}

	/**
	 * One string. transform(fx, fy) maps font units to camera relative coordinates; color [r, g, b, a];
	 * light [block, sky] (0..240); mode: see_through / normal / polygon_offset; background: RGBA or null;
	 * style: {bold, italic} like Style (bold draws every glyph again one pixel to the right, one pixel wider).
	 */
	add(transform, text, x, y, color, light, mode, background = null, style = null) {
		if (text) this.items.push({ transform, text, x, y, color, light, mode, background, bold: !!(style && style.bold), italic: !!(style && style.italic) });
	}

	/** A filled rectangle in font units (a text display's background, underlines and strikethroughs). */
	rect(transform, x0, y0, x1, y1, color, light, mode) {
		this.items.push({ transform, text: '', x: x0, y: y0, rect: [x0, y0, x1, y1], color, light, mode, background: color });
	}

	/** Font.width of a styled piece: every glyph's advance, one more for bold. */
	styledWidth(text, bold) {
		let width = 0;
		for (const ch of text) width += this.font.glyph(ch.codePointAt(0)).advance + (bold ? 1 : 0);
		return width;
	}

	/** Font.prepare8xTextOutline: the text in the outline colour around it, then the text on top. */
	addOutlined(transform, text, x, y, color, outline, light) {
		for (let dx = -1; dx <= 1; dx++) {
			for (let dy = -1; dy <= 1; dy++) {
				if (dx || dy) this.add(transform, text, x + dx, y + dy, outline, light, 'normal');
			}
		}
		this.add(transform, text, x, y, color, light, 'polygon_offset');
	}

	/**
	 * SubmitNodeCollection.submitNameTag. tags: [{pos: [x, y, z] camera relative attachment point (entity top),
	 * text, below (text under it, or null), discrete, light: [block, sky] (0..240)}]; right, up: the camera's axes
	 * (cameraOrientation()).
	 */
	nameTags(tags, right, up) {
		for (const tag of tags) {
			// EntityRenderer.submitNameDisplay: the text under the name first, then the name one line (9 * 1.15
			// pixels of 0.025) higher
			if (tag.below) this.nameTag(tag, tag.below, 0, right, up);
			this.nameTag(tag, tag.text, tag.below ? 9 * 1.15 * NAME_TAG_SCALE : 0, right, up, tag.pieces);
		}
	}

	nameTag(tag, text, raise, right, up, pieces = null) {
		if (pieces) return this.styledNameTag(tag, raise, right, up, pieces);
		// Attachment + 0.5 up, deadmau5 one line higher; scale(0.025, -0.025, 0.025).
		const o = [tag.pos[0], tag.pos[1] + 0.5 + raise, tag.pos[2]];
		const transform = (fx, fy) => [
			o[0] + (right[0] * fx - up[0] * fy) * NAME_TAG_SCALE,
			o[1] + (right[1] * fx - up[1] * fy) * NAME_TAG_SCALE,
			o[2] + (right[2] * fx - up[2] * fy) * NAME_TAG_SCALE,
		];
		const y = tag.text === 'deadmau5' ? -10 : 0;
		const x = -this.font.width(text) / 2;
		if (tag.discrete) {
			this.add(transform, text, x, y, SEE_THROUGH_TEXT, tag.light, 'normal', BACKGROUND);
		} else {
			// lightCoordsWithEmission(light, 2) for the solid text.
			this.add(transform, text, x, y, WHITE, [Math.max(tag.light[0], 32), tag.light[1]], 'normal');
			this.add(transform, text, x, y, SEE_THROUGH_TEXT, tag.light, 'see_through', BACKGROUND);
		}
	}

	/**
	 * A name tag of styled pieces ([text, rgb or -1, flags]): one background under the whole line, each piece in
	 * its colour (keeping the pass's alpha, like Font's StringRenderOutput), bold and italic.
	 */
	styledNameTag(tag, raise, right, up, pieces) {
		const o = [tag.pos[0], tag.pos[1] + 0.5 + raise, tag.pos[2]];
		const transform = (fx, fy) => [
			o[0] + (right[0] * fx - up[0] * fy) * NAME_TAG_SCALE,
			o[1] + (right[1] * fx - up[1] * fy) * NAME_TAG_SCALE,
			o[2] + (right[2] * fx - up[2] * fy) * NAME_TAG_SCALE,
		];
		const y = tag.text === 'deadmau5' ? -10 : 0;
		const width = pieces.reduce((sum, piece) => sum + this.styledWidth(piece[0], !!(piece[2] & 1)), 0);
		const x = -width / 2;
		const draw = (color, light, mode) => {
			let px = x;
			for (const [text, value, flags] of pieces) {
				const c = value >= 0 ? [(value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255, color[3]] : color;
				this.add(transform, text, px, y, c, light, mode, null, { bold: !!(flags & 1), italic: !!(flags & 2) });
				px += this.styledWidth(text, !!(flags & 1));
			}
		};
		if (tag.discrete) {
			this.rect(transform, x - 1, y - 1, x + width, y + 9, BACKGROUND, tag.light, 'normal');
			draw(SEE_THROUGH_TEXT, tag.light, 'normal');
		} else {
			draw(WHITE, [Math.max(tag.light[0], 32), tag.light[1]], 'normal');
			this.rect(transform, x - 1, y - 1, x + width, y + 9, BACKGROUND, tag.light, 'see_through');
			draw(SEE_THROUGH_TEXT, tag.light, 'see_through');
		}
	}

	/** Builds the vertex data of everything added since begin(). */
	finish() {
		this.count = 0;
		this.draws = [];
		if (!this.font.ready || !this.items.length) return;
		for (const item of this.items) this.font.width(item.text); // creates browser-drawn glyphs before the upload
		this.font.flush();
		for (const mode of MODE_ORDER) {
			const items = this.items.filter(item => item.mode === mode);
			if (items.length) this.pass(items, MODES[mode]);
		}
	}

	pass(items, mode) {
		const quad = (item, x0, y0, x1, y1, u0, v0, u1, v1, color, glyph = false) => {
			const corner = (fx, fy, u, v) => {
				// BakedSheetGlyph: italic glyphs lean one pixel right at the top, one left at the bottom
				const p = item.transform(glyph && item.italic ? fx + 1 - 0.25 * (fy - item.y) : fx, fy);
				this.vertex(p[0], p[1], p[2], u, v, color, item.light);
			};
			corner(x0, y0, u0, v0); corner(x0, y1, u0, v1); corner(x1, y1, u1, v1);
			corner(x0, y0, u0, v0); corner(x1, y1, u1, v1); corner(x1, y0, u1, v0);
		};
		// Font background effect: from x - 1 to the end of the text, y - 1 to y + 9.
		const backgrounds = items.filter(item => item.background);
		if (backgrounds.length) {
			const start = this.count;
			for (const item of backgrounds) {
				const r = item.rect || [item.x - 1, item.y - 1, item.x + this.font.width(item.text), item.y + 9];
				quad(item, r[0], r[1], r[2], r[3], 0, 0, 0, 0, item.background);
			}
			this.draws.push({ ...mode, texture: null, start, count: this.count - start, background: true });
		}
		const byTexture = new Map();
		for (const item of items) {
			let x = item.x;
			for (const ch of item.text) {
				const glyph = this.font.glyph(ch.codePointAt(0));
				if (glyph.texture) {
					if (!byTexture.has(glyph.texture)) byTexture.set(glyph.texture, []);
					byTexture.get(glyph.texture).push([item, x, glyph]);
					if (item.bold) byTexture.get(glyph.texture).push([item, x + 1, glyph]);
				}
				x += glyph.advance + (item.bold ? 1 : 0);
			}
		}
		for (const [texture, glyphs] of byTexture) {
			const start = this.count;
			for (const [item, x, g] of glyphs) {
				quad(item, x, item.y + g.up, x + g.w, item.y + g.up + g.h, g.u0, g.v0, g.u1, g.v1, item.color, true);
			}
			this.draws.push({ ...mode, texture, start, count: this.count - start, background: false });
		}
	}

	vertex(x, y, z, u, v, color, light) {
		if ((this.count + 1) * FLOATS > this.data.length) {
			const grown = new Float32Array(this.data.length * 2);
			grown.set(this.data);
			this.data = grown;
		}
		const d = this.data, i = this.count++ * FLOATS;
		d[i] = x; d[i + 1] = y; d[i + 2] = z;
		d[i + 3] = u; d[i + 4] = v;
		d[i + 5] = color[0]; d[i + 6] = color[1]; d[i + 7] = color[2]; d[i + 8] = color[3];
		d[i + 9] = light[0]; d[i + 10] = light[1];
	}

	draw(frame, lightmap) {
		if (!this.draws.length) return;
		const gl = this.gl;
		const { program: p, u } = this.program;
		gl.useProgram(p);
		gl.uniformMatrix4fv(u.uViewProj, false, frame.viewProj);
		setFog(gl, u, frame.fog);
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, lightmap);
		gl.uniform1i(u.uLightmap, 1);
		gl.activeTexture(gl.TEXTURE0);
		gl.uniform1i(u.uTexture, 0);
		gl.bindVertexArray(this.vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
		gl.bufferData(gl.ARRAY_BUFFER, this.data.subarray(0, this.count * FLOATS), gl.STREAM_DRAW);
		gl.enable(gl.BLEND);
		gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		gl.disable(gl.CULL_FACE);
		gl.depthMask(false);
		for (const d of this.draws) {
			if (d.depth) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
			if (d.offset) {
				// RenderStateShard POLYGON_OFFSET_LAYERING: the text sits in front of the sign face.
				gl.enable(gl.POLYGON_OFFSET_FILL);
				gl.polygonOffset(-1, -10);
			} else if (d.background && d.depth) {
				// The background sits a hair behind its text.
				gl.enable(gl.POLYGON_OFFSET_FILL);
				gl.polygonOffset(1, 1);
			} else {
				gl.disable(gl.POLYGON_OFFSET_FILL);
			}
			gl.uniform1i(u.uLit, d.lit ? 1 : 0);
			gl.uniform1i(u.uFog, d.fog ? 1 : 0);
			gl.uniform1i(u.uTextured, d.texture ? 1 : 0);
			if (d.texture) gl.bindTexture(gl.TEXTURE_2D, d.texture);
			gl.drawArrays(gl.TRIANGLES, d.start, d.count);
		}
		gl.disable(gl.POLYGON_OFFSET_FILL);
		gl.enable(gl.DEPTH_TEST);
		gl.enable(gl.CULL_FACE);
		gl.depthMask(true);
		gl.disable(gl.BLEND);
		gl.bindVertexArray(null);
	}
}

export { FULL_BRIGHT };
