// WebGL2 world renderer. Terrain is drawn like Minecraft's terrain shaders
// (per-vertex lightmap, fog from fog.glsl, cutout/translucent layers, chunk
// fade-in). Distant sections are merged into region buffers on the GPU so a
// huge view distance stays at a few hundred draw calls; nearby sections keep
// their own buffers so block updates upload only a little data.
//
// "Shaders" graphics adds a shader-pack look on top: sun/moon shadow map,
// waving plants and leaves, water waves with reflections, bloom and light
// shafts (see post.js).

import { program, FOG_GLSL, setFog, Target } from './gl.js';
import { STRIDE } from './mesher.js';
import { multiply, lookDir } from './math.js';
import { occlusionGraph } from './occlusion.js';

const NEAR_DISTANCE = 80; // sections closer than this keep their own buffers
const REGION_SHIFT = 2; // 4x4x4 sections per region
const FADE_MS = 750;
const UPLOAD_BUDGET = 6 * 1024 * 1024; // bytes of merged region data rebuilt per frame

export const SHADOW_GLSL = `
uniform highp sampler2DShadow uShadowMap;
uniform mat4 uShadowMatrix;
uniform float uShadowTexel;
uniform int uShadowSamples;
float shadowAt(vec3 pos, vec3 normal) {
	vec4 s = uShadowMatrix * vec4(pos + normal * 0.08, 1.0);
	vec3 p = s.xyz / s.w * 0.5 + 0.5;
	if (p.x <= 0.0 || p.x >= 1.0 || p.y <= 0.0 || p.y >= 1.0 || p.z >= 1.0) return 1.0;
	float bias = 0.0006;
	float sum = 0.0;
	float count = 0.0;
	for (int x = -2; x <= 2; x++) {
		for (int y = -2; y <= 2; y++) {
			if (abs(x) > uShadowSamples || abs(y) > uShadowSamples) continue;
			sum += texture(uShadowMap, vec3(p.xy + vec2(x, y) * uShadowTexel, p.z - bias));
			count += 1.0;
		}
	}
	return sum / count;
}`;

export const SHADER_LIGHT_GLSL = `
uniform vec3 uLightDir;
uniform vec3 uSunColor;
uniform float uDaylight;
uniform float uRain;
uniform float uShadows;
vec3 shaderLight(vec3 color, vec3 pos, vec3 normal, float sky, bool foliage) {
	float ndl = dot(normal, uLightDir);
	float direct = foliage ? 0.75 : clamp(ndl, 0.0, 1.0);
	if (uShadows > 0.5 && direct > 0.0) direct *= shadowAt(pos, foliage ? uLightDir : normal);
	float skyWeight = smoothstep(0.3, 1.0, sky) * uDaylight * (1.0 - uRain * 0.75);
	// Shadowed: cooler and darker (sky light only); lit: warm sun on top.
	vec3 shade = mix(vec3(0.58, 0.63, 0.78), vec3(1.0) + uSunColor * 0.22, direct);
	return color * mix(vec3(1.0), shade, skyWeight);
}`;

const TERRAIN_VS = `
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aUv;
layout(location = 2) in vec4 aColor;
layout(location = 3) in vec4 aData; // sky, block (0..240), material, flags
uniform mat4 uViewProj;
uniform vec3 uCamPos;
uniform sampler2D uLightmap;
uniform float uVisibility;
uniform float uTime;
uniform vec3 uOriginMod;
out float vSph;
out float vCyl;
out vec4 vColor;
out vec2 vUv;
out float vVisibility;
flat out int vMaterial;
#ifdef SHADERS
out vec3 vPos;
out vec3 vNormal;
out float vSky;
flat out int vFlags;
out vec3 vWorld;
const vec3 NORMALS[6] = vec3[6](vec3(0, -1, 0), vec3(0, 1, 0), vec3(0, 0, -1), vec3(0, 0, 1), vec3(-1, 0, 0), vec3(1, 0, 0));
#endif
void main() {
	vec3 pos = aPos - uCamPos;
	int flags = int(aData.w + 0.5);
#ifdef SHADERS
	vec3 world = aPos + uOriginMod;
	float wind = 0.6 + 0.4 * sin(uTime * 0.37);
	if ((flags & 1) != 0) {
		// Waving leaves and vines.
		pos += vec3(sin(uTime * 1.7 + world.x * 1.3 + world.y), sin(uTime * 1.3 + world.z * 1.7) * 0.5, sin(uTime * 1.9 + world.z * 1.1 + world.y)) * 0.035 * wind;
	}
	if ((flags & 32) != 0) {
		// Tops of waving plants.
		pos.xz += vec2(sin(uTime * 2.1 + world.x * 0.9 + world.z * 0.4), sin(uTime * 1.7 + world.z * 0.8 + world.x * 0.3)) * 0.08 * wind;
	}
	vPos = pos;
	vWorld = world;
	int face = int(aColor.a * 255.0 + 0.5);
	vNormal = NORMALS[clamp(face, 0, 5)];
	vSky = aData.x / 240.0;
	vFlags = flags;
#endif
	gl_Position = uViewProj * vec4(pos, 1.0);
	vSph = length(pos);
	vCyl = max(length(pos.xz), abs(pos.y));
	vec2 light = vec2(aData.y, aData.x);
	vColor = vec4(aColor.rgb, 1.0) * texture(uLightmap, clamp(light / 256.0 + 0.5 / 16.0, vec2(0.5 / 16.0), vec2(15.5 / 16.0)));
	vUv = aUv / 65536.0;
	vMaterial = int(aData.z + 0.5);
	vVisibility = mix(1.0, uVisibility, clamp((vSph - 16.0) / 16.0, 0.0, 1.0));
}`;

const TERRAIN_FS = `
in float vSph;
in float vCyl;
in vec4 vColor;
in vec2 vUv;
in float vVisibility;
flat in int vMaterial;
uniform sampler2D uAtlas;
${FOG_GLSL}
#ifdef SHADERS
in vec3 vPos;
in vec3 vNormal;
in float vSky;
flat in int vFlags;
in vec3 vWorld;
uniform vec3 uSkyColor;
uniform float uTime;
${SHADOW_GLSL}
${SHADER_LIGHT_GLSL}
float waveHeight(vec2 p) {
	return sin(p.x * 0.9 + uTime * 1.6) * 0.5 + sin(p.y * 1.3 - uTime * 1.2) * 0.35 + sin((p.x + p.y) * 2.3 + uTime * 2.4) * 0.15;
}
#endif
out vec4 outColor;
void main() {
	vec4 color;
	if (vMaterial == 3) {
		color = vec4(1.0);
	} else {
		color = texture(uAtlas, vUv);
		if (vMaterial == 1 && color.a < 0.5) discard;
		if (vMaterial == 2 && color.a < 0.004) discard;
		if (vMaterial == 0) color.a = 1.0;
	}
	color *= vColor;
#ifdef SHADERS
	bool foliage = (vFlags & 3) != 0;
	bool emissive = (vFlags & 4) != 0;
	vec3 lit = shaderLight(color.rgb, vPos, vNormal, vSky, foliage);
	if ((vFlags & 8) != 0 && vNormal.y > 0.5) {
		// Water surface: small waves, sky reflection and sun glint.
		vec2 p = vWorld.xz;
		float e = 0.08;
		vec3 n = normalize(vec3(waveHeight(p - vec2(e, 0.0)) - waveHeight(p + vec2(e, 0.0)), 6.0, waveHeight(p - vec2(0.0, e)) - waveHeight(p + vec2(0.0, e))));
		vec3 view = normalize(vPos);
		float fresnel = pow(1.0 - clamp(dot(-view, n), 0.0, 1.0), 4.0);
		vec3 reflected = reflect(view, n);
		float sky = smoothstep(0.2, 1.0, vSky);
		vec3 reflection = mix(uFogColor.rgb, uSkyColor, clamp(reflected.y * 2.0, 0.0, 1.0)) * (0.35 + 0.65 * sky);
		float glint = pow(max(dot(reflected, uLightDir), 0.0), 180.0) * sky * uDaylight * (1.0 - uRain);
		if (uShadows > 0.5 && glint > 0.0) glint *= shadowAt(vPos, vec3(0.0, 1.0, 0.0));
		lit = mix(lit, reflection, fresnel * 0.8) + uSunColor * glint * 3.0;
		color.a = mix(color.a, 1.0, fresnel * 0.6);
	}
	if (emissive) lit *= 1.08;
	color.rgb = lit;
#endif
	color = mix(uFogColor * vec4(1.0, 1.0, 1.0, color.a), color, vVisibility);
	outColor = apply_fog(color, vSph, vCyl);
}`;

const SHADOW_VS = `
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aUv;
layout(location = 3) in vec4 aData;
uniform mat4 uMatrix;
uniform vec3 uCamPos;
uniform float uTime;
uniform vec3 uOriginMod;
out vec2 vUv;
flat out int vMaterial;
void main() {
	vec3 pos = aPos - uCamPos;
	int flags = int(aData.w + 0.5);
	vec3 world = aPos + uOriginMod;
	float wind = 0.6 + 0.4 * sin(uTime * 0.37);
	if ((flags & 1) != 0) pos += vec3(sin(uTime * 1.7 + world.x * 1.3 + world.y), sin(uTime * 1.3 + world.z * 1.7) * 0.5, sin(uTime * 1.9 + world.z * 1.1 + world.y)) * 0.035 * wind;
	if ((flags & 32) != 0) pos.xz += vec2(sin(uTime * 2.1 + world.x * 0.9 + world.z * 0.4), sin(uTime * 1.7 + world.z * 0.8 + world.x * 0.3)) * 0.08 * wind;
	vUv = aUv / 65536.0;
	vMaterial = int(aData.z + 0.5);
	gl_Position = uMatrix * vec4(pos, 1.0);
}`;

const SHADOW_FS = `
in vec2 vUv;
flat in int vMaterial;
uniform sampler2D uAtlas;
void main() {
	if (vMaterial == 1 || vMaterial == 2) {
		if (texture(uAtlas, vUv).a < 0.5) discard;
	}
}`;

const BLIT_FS = `
in vec2 vUv;
uniform sampler2D uTexture;
out vec4 outColor;
void main() {
	outColor = vec4(texture(uTexture, vUv).rgb, 1.0);
}`;

/** A GPU buffer holding the vertex data of several sections, in a fixed order. */
class SegmentBuffer {
	constructor(renderer) {
		this.renderer = renderer;
		this.segments = []; // {key, offset, bytes, order}
		this.vbo = null;
		this.vao = null;
		this.quads = 0;
	}

	/** updates: Map key -> {data: ArrayBuffer (may be empty), order} ; empty data removes the section. */
	rebuild(updates) {
		const gl = this.renderer.gl;
		const next = [];
		for (const s of this.segments) {
			if (!updates.has(s.key)) next.push({ ...s, from: 'old' });
		}
		for (const [key, u] of updates) {
			if (u.data && u.data.byteLength > 0) next.push({ key, bytes: u.data.byteLength, order: u.order, data: u.data });
		}
		next.sort((a, b) => a.order - b.order);
		let total = 0;
		for (const s of next) total += s.bytes;
		const old = this.vbo;
		if (total === 0) {
			this.dispose();
			this.segments = [];
			this.quads = 0;
			return 0;
		}
		const vbo = gl.createBuffer();
		gl.bindBuffer(gl.COPY_WRITE_BUFFER, vbo);
		gl.bufferData(gl.COPY_WRITE_BUFFER, total, gl.STATIC_DRAW);
		if (old) gl.bindBuffer(gl.COPY_READ_BUFFER, old);
		let offset = 0;
		for (const s of next) {
			if (s.from === 'old') gl.copyBufferSubData(gl.COPY_READ_BUFFER, gl.COPY_WRITE_BUFFER, s.offset, offset, s.bytes);
			else gl.bufferSubData(gl.COPY_WRITE_BUFFER, offset, new Uint8Array(s.data));
			s.offset = offset;
			delete s.data;
			delete s.from;
			offset += s.bytes;
		}
		gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);
		gl.bindBuffer(gl.COPY_READ_BUFFER, null);
		this.dispose();
		this.vbo = vbo;
		this.vao = this.renderer.createVao(vbo);
		this.segments = next;
		this.quads = total / STRIDE / 4;
		this.renderer.ensureIndices(this.quads);
		return total;
	}

	dispose() {
		const gl = this.renderer.gl;
		if (this.vao) gl.deleteVertexArray(this.vao);
		if (this.vbo) gl.deleteBuffer(this.vbo);
		this.vao = null;
		this.vbo = null;
	}
}

/** One draw unit: a near section or a region of far sections. */
class Unit {
	constructor(renderer, key, cx, cy, cz, radius) {
		this.key = key;
		this.cx = cx;
		this.cy = cy;
		this.cz = cz;
		this.radius = radius;
		this.opaque = new SegmentBuffer(renderer);
		this.translucent = new SegmentBuffer(renderer);
		this.pending = new Map(); // section key -> {opaque, translucent, order}
		this.born = 0;
		this.lastPending = 0;
		this.sections = new Set();
	}

	get empty() {
		return this.opaque.quads === 0 && this.translucent.quads === 0 && this.pending.size === 0;
	}
}

export class Renderer {
	constructor(canvas) {
		this.canvas = canvas;
		const gl = canvas.getContext('webgl2', {
			antialias: false, alpha: false, depth: true, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: true,
		});
		if (!gl) throw new Error('WebGL2 is not available in this browser');
		this.gl = gl;
		this.floatTargets = !!gl.getExtension('EXT_color_buffer_float');
		this.programs = {};
		this.terrain = this.terrainProgram(false);
		this.shadowProgram = program(gl, SHADOW_VS, SHADOW_FS);
		this.blitProgram = program(gl, `out vec2 vUv; void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); vUv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`, BLIT_FS);
		this.emptyVao = gl.createVertexArray();
		this.indexBuffer = gl.createBuffer();
		this.indexQuads = 0;
		this.ensureIndices(65536);
		this.units = new Map();
		this.sectionUnits = new Map(); // section key -> unit
		this.dirtyUnits = new Set();
		// SectionOcclusionGraph: each section's VisibilitySet and the sections the camera can see into
		this.visibility = new Map(); // section key -> Uint8Array(6), missing = open
		this.sectionCoords = new Map();
		this.sectionBounds = null;
		this.worldSections = null; // [min section y, max section y]
		this.occlusion = null;
		this.occlusionDirty = true;
		this.occlusionAt = 0;
		this.occlusionStamp = 0;
		this.occlusionEnabled = true;
		this.camera = [0, 0, 0];
		this.lightmap = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, this.lightmap);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 16, 16, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(16 * 16 * 4).fill(255));
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		this.atlas = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, this.atlas);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
		this.scene = new Target(gl, { color: true, depth: true });
		this.shadowTarget = null;
		this.shadowFrame = 0;
		this.settings = { graphics: 'vanilla', quality: 'medium', renderScale: 1 };
		this.stats = { units: 0, drawn: 0, quads: 0 };
		gl.enable(gl.DEPTH_TEST);
		gl.depthFunc(gl.LEQUAL);
	}

	terrainProgram(shaders) {
		const key = shaders ? 'terrain-shaders' : 'terrain';
		if (!this.programs[key]) this.programs[key] = program(this.gl, TERRAIN_VS, TERRAIN_FS, shaders ? '#define SHADERS 1' : '');
		return this.programs[key];
	}

	get shaders() {
		return this.settings.graphics === 'shaders';
	}

	configure(settings) {
		Object.assign(this.settings, settings);
		const hdr = this.shaders && this.floatTargets;
		if (this.scene.hdr !== hdr) {
			this.scene = new Target(this.gl, { color: true, depth: true, hdr });
		}
	}

	shadowConfig() {
		switch (this.settings.quality) {
			case 'low': return { size: 1024, radius: 56, samples: 0, interval: 4 };
			case 'high': return { size: 2048, radius: 128, samples: 2, interval: 1 };
			case 'ultra': return { size: 4096, radius: 192, samples: 2, interval: 1 };
			default: return { size: 2048, radius: 96, samples: 1, interval: 2 };
		}
	}

	ensureIndices(quads) {
		if (quads <= this.indexQuads) return;
		let size = Math.max(this.indexQuads * 2, 65536);
		while (size < quads) size *= 2;
		const indices = new Uint32Array(size * 6);
		for (let q = 0, i = 0; q < size; q++) {
			const v = q * 4;
			indices[i++] = v; indices[i++] = v + 1; indices[i++] = v + 2;
			indices[i++] = v; indices[i++] = v + 2; indices[i++] = v + 3;
		}
		const gl = this.gl;
		gl.bindVertexArray(null);
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
		gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
		this.indexQuads = size;
		// Existing VAOs keep the same buffer object, so they see the new contents.
	}

	createVao(vbo) {
		const gl = this.gl;
		const vao = gl.createVertexArray();
		gl.bindVertexArray(vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);
		gl.enableVertexAttribArray(1);
		gl.vertexAttribPointer(1, 2, gl.UNSIGNED_SHORT, false, STRIDE, 12);
		gl.enableVertexAttribArray(2);
		gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, STRIDE, 16);
		gl.enableVertexAttribArray(3);
		gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, false, STRIDE, 20);
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
		gl.bindVertexArray(null);
		return vao;
	}

	/** Uploads the 16x16 lightmap (x = block light, y = sky light). */
	setLightmap(pixels) {
		const gl = this.gl;
		gl.bindTexture(gl.TEXTURE_2D, this.lightmap);
		gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 16, 16, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
	}

	/** Camera position relative to the world origin (decides near sections and region order). */
	setCamera(eye) {
		this.camera = eye;
	}

	/** A section mesh from the workers (message.opaque / translucent ArrayBuffers), or null to remove it. */
	setSectionMesh(key, section, message, now) {
		let unit = this.sectionUnits.get(key);
		this.occlusionDirty = true;
		if (message && message.vis) this.visibility.set(key, message.vis);
		else this.visibility.delete(key);
		if (!this.sectionCoords.has(key)) {
			this.sectionCoords.set(key, [section.x, section.y, section.z]);
			const b = this.sectionBounds || (this.sectionBounds = { x0: section.x, x1: section.x, z0: section.z, z1: section.z, y0: section.y, y1: section.y });
			b.x0 = Math.min(b.x0, section.x); b.x1 = Math.max(b.x1, section.x);
			b.z0 = Math.min(b.z0, section.z); b.z1 = Math.max(b.z1, section.z);
			b.y0 = Math.min(b.y0, section.y); b.y1 = Math.max(b.y1, section.y);
		}
		if (!message) {
			if (unit) {
				unit.pending.set(key, { opaque: null, translucent: null, order: 0 });
				unit.lastPending = now;
				this.sectionUnits.delete(key);
				unit.sections.delete(key);
				this.dirtyUnits.add(unit);
			}
			return;
		}
		const cx = section.x * 16 + 8 - (this.origin ? this.origin[0] : 0);
		const cy = section.y * 16 + 8 - (this.origin ? this.origin[1] : 0);
		const cz = section.z * 16 + 8 - (this.origin ? this.origin[2] : 0);
		const e = this.camera;
		const distance = Math.hypot(cx - e[0], cy - e[1], cz - e[2]);
		if (!unit) {
			let unitKey, ux, uy, uz, radius;
			if (distance < NEAR_DISTANCE) {
				unitKey = 's' + key;
				ux = cx; uy = cy; uz = cz; radius = 14;
			} else {
				const rx = section.x >> REGION_SHIFT, ry = section.y >> REGION_SHIFT, rz = section.z >> REGION_SHIFT;
				unitKey = 'r' + rx + ',' + ry + ',' + rz;
				const half = 8 << REGION_SHIFT;
				ux = (rx << REGION_SHIFT) * 16 + half - (this.origin ? this.origin[0] : 0);
				uy = (ry << REGION_SHIFT) * 16 + half - (this.origin ? this.origin[1] : 0);
				uz = (rz << REGION_SHIFT) * 16 + half - (this.origin ? this.origin[2] : 0);
				radius = half * 1.75;
			}
			unit = this.units.get(unitKey);
			if (!unit) {
				unit = new Unit(this, unitKey, ux, uy, uz, radius);
				unit.born = now;
				this.units.set(unitKey, unit);
			}
			this.sectionUnits.set(key, unit);
			unit.sections.add(key);
		}
		// Far first in both buffers: translucent sections must be drawn back to front.
		unit.pending.set(key, { opaque: message.opaque, translucent: message.translucent, order: -distance });
		unit.lastPending = now;
		this.dirtyUnits.add(unit);
	}

	clearSections(origin) {
		for (const unit of this.units.values()) {
			unit.opaque.dispose();
			unit.translucent.dispose();
		}
		this.units.clear();
		this.sectionUnits.clear();
		this.dirtyUnits.clear();
		this.visibility.clear();
		this.sectionCoords.clear();
		this.sectionBounds = null;
		this.occlusion = null;
		this.occlusionDirty = true;
		this.origin = origin;
	}

	/** The dimension's height (from "init"), for the occlusion graph's view area. */
	setWorldHeight(minY, height) {
		this.worldSections = [Math.floor(minY / 16), Math.floor((minY + height - 1) / 16)];
		this.occlusionDirty = true;
	}

	/**
	 * SectionOcclusionGraph's full update, again when sections change (at most every 400 ms) or the camera moves
	 * to another section.
	 */
	updateOcclusion(frame) {
		if (!this.occlusionEnabled || !this.sectionBounds) {
			this.occlusion = null;
			return;
		}
		const o = this.origin || [0, 0, 0];
		const eye = [frame.camPos[0] + o[0], frame.camPos[1] + o[1], frame.camPos[2] + o[2]];
		const section = Math.floor(eye[0] / 16) + ',' + Math.floor(eye[1] / 16) + ',' + Math.floor(eye[2] / 16);
		if (!(this.occlusionDirty || section !== this.occlusionSection) || frame.now - this.occlusionAt < 400) return;
		const b = this.sectionBounds;
		const ys = this.worldSections || [b.y0 - 1, b.y1 + 1];
		const box = { x0: b.x0 - 1, x1: b.x1 + 1, z0: b.z0 - 1, z1: b.z1 + 1, y0: ys[0], y1: ys[1] };
		this.occlusion = occlusionGraph(eye, box, (x, y, z) => this.visibility.get(x + ',' + y + ',' + z) || null);
		this.occlusionDirty = false;
		this.occlusionAt = frame.now;
		this.occlusionSection = section;
		this.occlusionStamp++;
	}

	/** Whether the occlusion graph reached the unit's section, or any section of a merged region. */
	unitReached(unit) {
		const graph = this.occlusion;
		if (!graph) return true;
		if (unit.occlusionStamp === this.occlusionStamp) return unit.reached;
		let reached = false;
		for (const key of unit.sections) {
			const c = this.sectionCoords.get(key);
			const i = c ? graph.index(c[0], c[1], c[2]) : -1;
			if (i < 0 || graph.reached[i]) {
				reached = true;
				break;
			}
		}
		unit.occlusionStamp = this.occlusionStamp;
		unit.reached = reached;
		return reached;
	}

	/** Uploads pending section meshes: near units right away, merged regions within a byte budget. */
	flushUploads(now) {
		let budget = UPLOAD_BUDGET;
		const units = [...this.dirtyUnits];
		const e = this.camera;
		units.sort((a, b) => Math.hypot(a.cx - e[0], a.cy - e[1], a.cz - e[2]) - Math.hypot(b.cx - e[0], b.cy - e[1], b.cz - e[2]));
		for (const unit of units) {
			const near = unit.key.startsWith('s');
			// Regions wait until their sections stop arriving, so loading does not copy them over and over.
			if (!near && (budget <= 0 || (now - unit.lastPending < 400 && unit.pending.size < 24 && unit.opaque.quads + unit.translucent.quads > 0))) continue;
			const opaque = new Map(), translucent = new Map();
			for (const [key, u] of unit.pending) {
				opaque.set(key, { data: u.opaque, order: u.order });
				translucent.set(key, { data: u.translucent, order: u.order });
			}
			unit.pending.clear();
			budget -= unit.opaque.rebuild(opaque);
			budget -= unit.translucent.rebuild(translucent);
			this.dirtyUnits.delete(unit);
			if (unit.empty && unit.sections.size === 0) this.units.delete(unit.key);
		}
	}

	resize() {
		const dpr = Math.min(window.devicePixelRatio || 1, this.settings.maxPixelRatio || 2);
		const width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
		const height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
		if (this.canvas.width !== width || this.canvas.height !== height) {
			this.canvas.width = width;
			this.canvas.height = height;
		}
		const scale = this.settings.renderScale || 1;
		this.scene.resize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
		return width / height;
	}

	drawUnit(buffer) {
		const gl = this.gl;
		gl.bindVertexArray(buffer.vao);
		gl.drawElements(gl.TRIANGLES, buffer.quads * 6, gl.UNSIGNED_INT, 0);
	}

	/** The sun (or the moon at night) as seen from the camera, for shadows and lighting. */
	lightDirection(sky) {
		const a = sky.sunAngle;
		const sun = [-Math.sin(a), Math.cos(a), 0];
		if (sun[1] > -0.05) return { dir: sun, moon: false };
		const b = sky.moonAngle;
		return { dir: [-Math.sin(b), Math.cos(b), 0], moon: true };
	}

	/** Orthographic sun view around the camera. */
	shadowMatrix(light, radius) {
		let dir = light.dir;
		// Keep the light a little above the horizon so shadows do not stretch to infinity.
		if (dir[1] < 0.18) {
			const h = Math.hypot(dir[0], dir[2]) || 1;
			const k = Math.sqrt(1 - 0.18 * 0.18) / h;
			dir = [dir[0] * k, 0.18, dir[2] * k];
		}
		const eye = [dir[0] * radius * 2, dir[1] * radius * 2, dir[2] * radius * 2];
		const view = lookDir(eye, [-dir[0], -dir[1], -dir[2]], Math.abs(dir[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0]);
		const near = 0.5, far = radius * 4;
		const projection = new Float32Array(16);
		projection[0] = 1 / radius;
		projection[5] = 1 / radius;
		projection[10] = -2 / (far - near);
		projection[14] = -(far + near) / (far - near);
		projection[15] = 1;
		return { matrix: multiply(projection, view), dir };
	}

	/**
	 * frame: {projection, viewRotation, viewProj (camera relative), camPos (origin relative), fog, frustum(x, y, z, r),
	 *         now, time, sky (Environment.sky), daylight, rain, originMod}
	 * hooks: {sky(), entities(pass, extra), translucent()}
	 */
	render(frame, hooks) {
		const gl = this.gl;
		this.flushUploads(frame.now);
		const shaders = this.shaders;
		const terrain = this.terrainProgram(shaders);
		const cam = frame.camPos;

		// Visible units, nearest first (in the frustum and reached by the occlusion graph).
		this.updateOcclusion(frame);
		const visible = [];
		let occluded = 0;
		for (const unit of this.units.values()) {
			if (unit.opaque.quads === 0 && unit.translucent.quads === 0) continue;
			const dx = unit.cx - cam[0], dy = unit.cy - cam[1], dz = unit.cz - cam[2];
			if (!frame.frustum(dx, dy, dz, unit.radius)) continue;
			if (!this.unitReached(unit)) {
				occluded++;
				continue;
			}
			unit.distance = Math.hypot(dx, dy, dz);
			if (unit.distance - unit.radius > frame.fog.rdEnd + 16) continue;
			visible.push(unit);
		}
		visible.sort((a, b) => a.distance - b.distance);

		// Shadow map (shaders only).
		let shadow = null;
		if (shaders) shadow = this.renderShadows(frame, hooks);

		this.scene.bind();
		gl.clearColor(frame.fog.color[0], frame.fog.color[1], frame.fog.color[2], 1);
		gl.clearDepth(1);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

		if (hooks.sky) hooks.sky();

		gl.useProgram(terrain.program);
		const u = terrain.u;
		gl.uniformMatrix4fv(u.uViewProj, false, frame.viewProj);
		gl.uniform3fv(u.uCamPos, cam);
		gl.uniform1f(u.uTime, frame.time);
		gl.uniform3fv(u.uOriginMod, frame.originMod);
		setFog(gl, u, frame.fog);
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, this.lightmap);
		gl.uniform1i(u.uLightmap, 1);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.atlas);
		gl.uniform1i(u.uAtlas, 0);
		if (shaders) this.bindShaderUniforms(u, frame, shadow);

		gl.enable(gl.DEPTH_TEST);
		gl.depthMask(true);
		gl.disable(gl.BLEND);
		gl.enable(gl.CULL_FACE);
		gl.cullFace(gl.BACK);
		let quads = 0;
		for (const unit of visible) {
			if (unit.opaque.quads === 0) continue;
			gl.uniform1f(u.uVisibility, Math.min(1, (frame.now - unit.born) / FADE_MS));
			this.drawUnit(unit.opaque);
			quads += unit.opaque.quads;
		}

		if (hooks.entities) hooks.entities('opaque', shadow);

		// Translucent terrain, back to front.
		gl.useProgram(terrain.program);
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, this.lightmap);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.atlas);
		if (shaders) this.bindShaderUniforms(u, frame, shadow);
		gl.enable(gl.BLEND);
		gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		gl.depthMask(false);
		for (let i = visible.length - 1; i >= 0; i--) {
			const unit = visible[i];
			if (unit.translucent.quads === 0) continue;
			gl.uniform1f(u.uVisibility, Math.min(1, (frame.now - unit.born) / FADE_MS));
			this.drawUnit(unit.translucent);
			quads += unit.translucent.quads;
		}
		gl.depthMask(true);
		gl.disable(gl.BLEND);
		gl.bindVertexArray(null);

		if (hooks.translucent) hooks.translucent(shadow);

		this.stats = { units: this.units.size, drawn: visible.length, occluded, quads };
		return shadow;
	}

	bindShaderUniforms(u, frame, shadow) {
		const gl = this.gl;
		gl.uniform3fv(u.uLightDir, shadow ? shadow.dir : [0, 1, 0]);
		gl.uniform3fv(u.uSunColor, frame.sunColor || [1, 0.95, 0.85]);
		gl.uniform1f(u.uDaylight, frame.daylight);
		gl.uniform1f(u.uRain, frame.rain);
		gl.uniform3fv(u.uSkyColor, frame.sky ? frame.sky.skyColor : [0.5, 0.7, 1]);
		gl.uniform1f(u.uShadows, shadow ? 1 : 0);
		gl.activeTexture(gl.TEXTURE3);
		gl.bindTexture(gl.TEXTURE_2D, shadow ? shadow.texture : this.dummyShadow());
		gl.uniform1i(u.uShadowMap, 3);
		gl.activeTexture(gl.TEXTURE0);
		if (shadow) {
			gl.uniformMatrix4fv(u.uShadowMatrix, false, shadow.matrix);
			gl.uniform1f(u.uShadowTexel, 1 / shadow.size);
			gl.uniform1i(u.uShadowSamples, shadow.samples);
		}
	}

	dummyShadow() {
		if (!this._dummyShadow) {
			const gl = this.gl;
			const t = gl.createTexture();
			gl.bindTexture(gl.TEXTURE_2D, t);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, 1, 1, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, new Uint32Array([0xffffffff]));
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
			this._dummyShadow = t;
		}
		return this._dummyShadow;
	}

	renderShadows(frame, hooks) {
		const gl = this.gl;
		const config = this.shadowConfig();
		const light = this.lightDirection(frame.sky);
		if (frame.sky.skybox !== 'overworld') return null;
		if (!this.shadowTarget || this.shadowTarget.width !== config.size) {
			this.shadowTarget = new Target(gl, { color: false, depth: true });
			this.shadowTarget.resize(config.size, config.size);
			gl.bindTexture(gl.TEXTURE_2D, this.shadowTarget.depthTexture);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
			this.shadowFrame = 0;
		}
		const { matrix, dir } = this.shadowMatrix(light, config.radius);
		const shadow = { texture: this.shadowTarget.depthTexture, matrix, dir: light.dir, size: config.size, samples: config.samples, moon: light.moon };
		if (this.shadowFrame++ % config.interval !== 0) return shadow;

		this.shadowTarget.bind();
		gl.clearDepth(1);
		gl.clear(gl.DEPTH_BUFFER_BIT);
		gl.enable(gl.DEPTH_TEST);
		gl.depthMask(true);
		gl.disable(gl.CULL_FACE);
		gl.enable(gl.POLYGON_OFFSET_FILL);
		gl.polygonOffset(1.5, 2);
		const p = this.shadowProgram;
		gl.useProgram(p.program);
		gl.uniformMatrix4fv(p.u.uMatrix, false, matrix);
		gl.uniform3fv(p.u.uCamPos, frame.camPos);
		gl.uniform1f(p.u.uTime, frame.time);
		gl.uniform3fv(p.u.uOriginMod, frame.originMod);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.atlas);
		gl.uniform1i(p.u.uAtlas, 0);
		const cam = frame.camPos;
		const reach = config.radius * 1.5;
		for (const unit of this.units.values()) {
			if (unit.opaque.quads === 0) continue;
			const d = Math.hypot(unit.cx - cam[0], unit.cy - cam[1], unit.cz - cam[2]);
			if (d - unit.radius > reach) continue;
			this.drawUnit(unit.opaque);
		}
		gl.bindVertexArray(null);
		if (hooks.entities) hooks.entities('shadow', { matrix });
		gl.disable(gl.POLYGON_OFFSET_FILL);
		gl.enable(gl.CULL_FACE);
		this.shadowDir = dir;
		return shadow;
	}

	/** Copies a texture to the canvas. */
	blit(texture) {
		const gl = this.gl;
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.viewport(0, 0, this.canvas.width, this.canvas.height);
		gl.disable(gl.DEPTH_TEST);
		gl.disable(gl.BLEND);
		gl.useProgram(this.blitProgram.program);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.uniform1i(this.blitProgram.u.uTexture, 0);
		gl.bindVertexArray(this.emptyVao);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
		gl.bindVertexArray(null);
		gl.enable(gl.DEPTH_TEST);
	}
}
