// Rain, snow and lightning like Minecraft 26.3's WeatherEffectRenderer and
// LightningBoltRenderer: the same seeded columns within the weather radius,
// stopping at the motion blocking height map (sent by the server), lit by
// the lightmap, and the same seeded bolt geometry.

import { program, FOG_GLSL, setFog } from './gl.js';
import { JavaRandom } from './rng.js';

const WEATHER_VS = `
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aUv;
layout(location = 2) in float aAlpha;
layout(location = 3) in vec2 aLight;
uniform mat4 uViewProj;
uniform sampler2D uLightmap;
out float vSph;
out float vCyl;
out vec2 vUv;
out vec4 vColor;
float fog_cyl(vec3 pos) { return max(length(pos.xz), abs(pos.y)); }
void main() {
	gl_Position = uViewProj * vec4(aPos, 1.0);
	vSph = length(aPos);
	vCyl = fog_cyl(aPos);
	vUv = aUv;
	vColor = vec4(1.0, 1.0, 1.0, aAlpha) * texture(uLightmap, clamp(aLight / 256.0 + 0.5 / 16.0, vec2(0.5 / 16.0), vec2(15.5 / 16.0)));
}`;

const WEATHER_FS = `
in float vSph;
in float vCyl;
in vec2 vUv;
in vec4 vColor;
uniform sampler2D uTexture;
${FOG_GLSL}
out vec4 outColor;
void main() {
	vec4 color = texture(uTexture, vUv) * vColor;
	if (color.a < 0.1) discard;
	outColor = apply_fog(color, vSph, vCyl);
}`;

const LIGHTNING_VS = `
layout(location = 0) in vec3 aPos;
uniform mat4 uViewProj;
out float vSph;
out float vCyl;
void main() {
	gl_Position = uViewProj * vec4(aPos, 1.0);
	vSph = length(aPos);
	vCyl = max(length(aPos.xz), abs(aPos.y));
}`;

const LIGHTNING_FS = `
in float vSph;
in float vCyl;
${FOG_GLSL}
out vec4 outColor;
void main() {
	outColor = vec4(0.45, 0.45, 0.5, 0.3) * (1.0 - total_fog_value(vSph, vCyl));
}`;

const STRIDE = 4 * 9; // pos3 uv2 alpha1 light2 (block, sky) pad1

// Column quad orientation table (perpendicular to the direction from the camera).
const SIZE_X = new Float32Array(1024), SIZE_Z = new Float32Array(1024);
for (let z = 0; z < 32; z++) {
	for (let x = 0; x < 32; x++) {
		const dx = x - 16, dz = z - 16;
		const d = Math.hypot(dx, dz);
		SIZE_X[z * 32 + x] = -dz / d;
		SIZE_Z[z * 32 + x] = dx / d;
	}
}

function seedParts(seed) {
	const big = BigInt.asIntN(64, BigInt(seed));
	return [Number(BigInt.asIntN(32, big >> 32n)), Number(BigInt.asUintN(32, big))];
}

export class WeatherRenderer {
	constructor(gl) {
		this.gl = gl;
		this.program = program(gl, WEATHER_VS, WEATHER_FS);
		this.lightningProgram = program(gl, LIGHTNING_VS, LIGHTNING_FS);
		this.vao = gl.createVertexArray();
		this.vbo = gl.createBuffer();
		gl.bindVertexArray(this.vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);
		gl.enableVertexAttribArray(1);
		gl.vertexAttribPointer(1, 2, gl.FLOAT, false, STRIDE, 12);
		gl.enableVertexAttribArray(2);
		gl.vertexAttribPointer(2, 1, gl.FLOAT, false, STRIDE, 20);
		gl.enableVertexAttribArray(3);
		gl.vertexAttribPointer(3, 2, gl.FLOAT, false, STRIDE, 24);
		gl.bindVertexArray(null);
		this.columns = null;
		this.random = new JavaRandom();
		this.data = new Float32Array(441 * 6 * 9);
		this.snowData = new Float32Array(441 * 6 * 9);
		this.lightningVao = gl.createVertexArray();
		this.lightningVbo = gl.createBuffer();
		gl.bindVertexArray(this.lightningVao);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.lightningVbo);
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
		gl.bindVertexArray(null);
		this.bolts = new Map();
	}

	/** "weather" message: {x, z, size, h: [...], p: "rsn..."} */
	setColumns(data) {
		this.columns = data;
	}

	/**
	 * frame: {viewProj (camera relative), camera: {x, y, z} world, fog, lightmap texture},
	 * rain intensity 0..1, ticks: game time with fraction, lightAt(x, y, z) -> [sky, block]
	 */
	render(frame, intensity, ticks, lightAt, textures) {
		const columns = this.columns;
		if (!columns || intensity <= 0 || !textures || !textures.rain) return;
		const gl = this.gl;
		const radius = 10;
		const cam = frame.camera;
		const bx = Math.floor(cam.x), by = Math.floor(cam.y), bz = Math.floor(cam.z);
		const gameTicks = Math.floor(ticks);
		const partial = ticks - gameTicks;
		const wrappedTicks = gameTicks & 131071;
		const random = this.random;
		const out = this.data;
		let rain = 0;
		const snow = [];
		const radiusSq = radius * radius;

		const emit = (x, z, y0, y1, u0, vOffset, light, maxAlpha, target, index) => {
			const rx = x + 0.5 - cam.x, rz = z + 0.5 - cam.z;
			const alpha = (maxAlpha + Math.min((rx * rx + rz * rz) / radiusSq, 1) * (0.5 - maxAlpha)) * intensity;
			const table = (z - bz + 16) * 32 + x - bx + 16;
			const hx = SIZE_X[table] / 2, hz = SIZE_Z[table] / 2;
			if (!Number.isFinite(hx)) return index;
			const top = y1 - cam.y, bottom = y0 - cam.y;
			const v0 = y0 * 0.25 + vOffset, v1 = y1 * 0.25 + vOffset;
			const verts = [
				[rx - hx, top, rz - hz, u0, v0], [rx + hx, top, rz + hz, u0 + 1, v0],
				[rx + hx, bottom, rz + hz, u0 + 1, v1], [rx - hx, bottom, rz - hz, u0, v1],
			];
			for (const k of [0, 1, 2, 0, 2, 3]) {
				const p = verts[k];
				const o = index * 9;
				target[o] = p[0]; target[o + 1] = p[1]; target[o + 2] = p[2];
				target[o + 3] = p[3]; target[o + 4] = p[4];
				target[o + 5] = alpha;
				target[o + 6] = light[1] * 16; target[o + 7] = light[0] * 16;
				target[o + 8] = 0;
				index++;
			}
			return index;
		};

		const snowData = this.snowData;
		let snowCount = 0;
		for (let z = bz - radius; z <= bz + radius; z++) {
			for (let x = bx - radius; x <= bx + radius; x++) {
				const cx = x - columns.x, cz = z - columns.z;
				if (cx < 0 || cz < 0 || cx >= columns.size || cz >= columns.size) continue;
				const k = cz * columns.size + cx;
				const type = columns.p[k];
				if (type !== 'r' && type !== 's') continue;
				const terrain = columns.h[k];
				const y0 = Math.max(by - radius, terrain), y1 = Math.max(by + radius, terrain);
				if (y1 - y0 === 0) continue;
				const seed = (Math.imul(Math.imul(x, x), 3121) + Math.imul(x, 45238971)) ^ (Math.imul(Math.imul(z, z), 418711) + Math.imul(z, 13761));
				random.setSeedNumber(seed | 0);
				const light = lightAt(x, Math.max(by, terrain), z);
				if (type === 'r') {
					const tickOffset = (Math.imul(Math.imul(x, x), 3121) + Math.imul(x, 45238971) + Math.imul(Math.imul(z, z), 418711) + Math.imul(z, 13761)) & 0xff;
					const speed = 3 + random.nextFloat();
					const offset = (-(wrappedTicks + tickOffset + partial) / 32 * speed) % 32;
					rain = emit(x, z, y0, y1, 0, offset, light, 1, out, rain);
				} else {
					const time = wrappedTicks + partial;
					const u = random.nextDouble() + time * 0.01 * random.nextGaussian();
					const v = random.nextDouble() + time * random.nextGaussian() * 0.001;
					const vOffset = -((gameTicks & 511) + partial) / 512;
					const bright = [Math.floor((light[0] * 3 + 15) / 4), Math.floor((light[1] * 3 + 15) / 4)];
					snowCount = emit(x, z, y0, y1, u, vOffset + v, bright, 0.8, snowData, snowCount);
				}
			}
		}
		if (rain === 0 && snowCount === 0) return;

		const p = this.program;
		gl.useProgram(p.program);
		gl.uniformMatrix4fv(p.u.uViewProj, false, frame.viewProj);
		setFog(gl, p.u, frame.fog);
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, frame.lightmap);
		gl.uniform1i(p.u.uLightmap, 1);
		gl.activeTexture(gl.TEXTURE0);
		gl.uniform1i(p.u.uTexture, 0);
		gl.enable(gl.BLEND);
		gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		gl.disable(gl.CULL_FACE);
		gl.depthMask(false);
		gl.bindVertexArray(this.vao);
		const draw = (data, count, tex) => {
			if (!count || !tex) return;
			gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
			gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, count * 9), gl.STREAM_DRAW);
			gl.bindTexture(gl.TEXTURE_2D, tex);
			gl.drawArrays(gl.TRIANGLES, 0, count);
		};
		draw(out, rain, textures.rain);
		draw(snowData, snowCount, textures.snow);
		gl.bindVertexArray(null);
		gl.depthMask(true);
		gl.disable(gl.BLEND);
		gl.enable(gl.CULL_FACE);
	}

	/** Lightning bolt geometry for a seed (camera independent, cached). */
	boltGeometry(seed) {
		let cached = this.bolts.get(seed);
		if (cached) return cached;
		const [hi, lo] = seedParts(seed);
		const xOffsets = new Float32Array(8), zOffsets = new Float32Array(8);
		let xOffset = 0, zOffset = 0;
		const random = new JavaRandom(hi, lo);
		for (let i = 7; i >= 0; i--) {
			xOffsets[i] = xOffset;
			zOffsets[i] = zOffset;
			xOffset += random.nextInt(11) - 5;
			zOffset += random.nextInt(11) - 5;
		}
		const verts = [];
		const quad = (sx, sz, ex, ez, segment, top, bottom, rxp, rzp, lxp, lzp) => {
			const a = [sx + (rxp ? bottom : -bottom), segment * 16, sz + (rzp ? bottom : -bottom)];
			const b = [ex + (rxp ? top : -top), (segment + 1) * 16, ez + (rzp ? top : -top)];
			const c = [ex + (lxp ? top : -top), (segment + 1) * 16, ez + (lzp ? top : -top)];
			const d = [sx + (lxp ? bottom : -bottom), segment * 16, sz + (lzp ? bottom : -bottom)];
			verts.push(...a, ...b, ...c, ...a, ...c, ...d);
		};
		for (let layer = 0; layer < 4; layer++) {
			const r = new JavaRandom(hi, lo);
			for (let branch = 0; branch < 3; branch++) {
				const trunk = branch === 0;
				const start = 7 - branch;
				const end = trunk ? 0 : start - 3 + 1;
				let sx = xOffsets[start] - xOffset, sz = zOffsets[start] - zOffset;
				for (let segment = start; segment >= end; segment--) {
					const ex = sx, ez = sz;
					if (trunk) {
						sx += r.nextInt(11) - 5;
						sz += r.nextInt(11) - 5;
					} else {
						sx += r.nextInt(31) - 15;
						sz += r.nextInt(31) - 15;
					}
					let top = 0.1 + layer * 0.2, bottom = top;
					if (trunk) {
						top *= segment * 0.1 + 1;
						bottom *= (segment - 1) * 0.1 + 1;
					}
					quad(sx, sz, ex, ez, segment, top, bottom, false, false, true, false);
					quad(sx, sz, ex, ez, segment, top, bottom, true, false, true, true);
					quad(sx, sz, ex, ez, segment, top, bottom, true, true, false, true);
					quad(sx, sz, ex, ez, segment, top, bottom, false, true, false, false);
				}
			}
		}
		cached = new Float32Array(verts);
		if (this.bolts.size > 16) this.bolts.clear();
		this.bolts.set(seed, cached);
		return cached;
	}

	/** bolts: [{x, y, z (camera relative), seed}] */
	renderLightning(frame, bolts) {
		if (!bolts.length) return;
		const gl = this.gl;
		const p = this.lightningProgram;
		gl.useProgram(p.program);
		setFog(gl, p.u, frame.fog);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
		gl.disable(gl.CULL_FACE);
		gl.depthMask(false);
		gl.bindVertexArray(this.lightningVao);
		for (const bolt of bolts) {
			const geometry = this.boltGeometry(bolt.seed);
			const moved = new Float32Array(geometry.length);
			for (let i = 0; i < geometry.length; i += 3) {
				moved[i] = geometry[i] + bolt.x;
				moved[i + 1] = geometry[i + 1] + bolt.y;
				moved[i + 2] = geometry[i + 2] + bolt.z;
			}
			gl.bindBuffer(gl.ARRAY_BUFFER, this.lightningVbo);
			gl.bufferData(gl.ARRAY_BUFFER, moved, gl.STREAM_DRAW);
			gl.uniformMatrix4fv(p.u.uViewProj, false, frame.viewProj);
			gl.drawArrays(gl.TRIANGLES, 0, moved.length / 3);
		}
		gl.bindVertexArray(null);
		gl.depthMask(true);
		gl.disable(gl.BLEND);
		gl.enable(gl.CULL_FACE);
	}
}

