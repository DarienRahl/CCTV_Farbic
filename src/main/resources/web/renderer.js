// WebGL2 renderer: sky, world sections (opaque + translucent pass) and the
// shared entity shader. All heavy lifting happens here, in the browser.

import { STRIDE } from './world.js';

const WORLD_VS = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aColor;
layout(location = 2) in vec4 aExtra;
uniform mat4 uViewProj;
out vec3 vPos;
out vec3 vColor;
out float vBright;
flat out int vMaterial;
flat out int vFace;
out float vLight;
void main() {
	vPos = aPos;
	vColor = aColor.rgb;
	vBright = aColor.a;
	vMaterial = int(aExtra.x + 0.5);
	vFace = int(aExtra.y + 0.5);
	vLight = aExtra.z / 15.0;
	gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const WORLD_FS = `#version 300 es
precision highp float;
in vec3 vPos;
in vec3 vColor;
in float vBright;
flat in int vMaterial;
flat in int vFace;
in float vLight;
uniform vec3 uCamPos;
uniform vec3 uFogColor;
uniform float uFogStart;
uniform float uFogEnd;
uniform float uAmbient;
uniform float uTime;
out vec4 outColor;

float hash(vec3 p) {
	p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
	p *= 17.0;
	return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

vec3 faceNormal(int f) {
	if (f == 0) return vec3(0.0, 1.0, 0.0);
	if (f == 1) return vec3(0.0, -1.0, 0.0);
	if (f == 2) return vec3(0.0, 0.0, -1.0);
	if (f == 3) return vec3(0.0, 0.0, 1.0);
	if (f == 4) return vec3(-1.0, 0.0, 0.0);
	if (f == 5) return vec3(1.0, 0.0, 0.0);
	return vec3(0.0);
}

void main() {
	vec3 n = faceNormal(vFace);
	// 16x16 "pixels" per block face, like Minecraft textures.
	vec3 texel = floor((vPos - n * 0.002) * 16.0);
	float h = hash(texel);
	float noise = 0.9 + 0.18 * h;
	float alpha = 1.0;

	if (vMaterial == 1) {
		// Leaves: dark speckles.
		noise = h < 0.28 ? 0.62 : 0.88 + 0.22 * hash(texel + 7.0);
	} else if (vMaterial == 5) {
		// Plants: sparse blades, thinner towards the top.
		float column = hash(vec3(floor(vPos.x * 16.0) + floor(vPos.z * 16.0) * 31.0, 1.0, 3.0));
		float top = fract(vPos.y - 0.0001);
		if (column < 0.25 + 0.45 * top) discard;
		noise = 0.85 + 0.25 * h;
	} else if (vMaterial == 2) {
		alpha = 0.42;
		noise = 1.0 + 0.06 * h;
	} else if (vMaterial == 3) {
		alpha = 0.72;
		float wave = sin(uTime * 1.7 + vPos.x * 1.9 + vPos.z * 1.3) * 0.5 + 0.5;
		noise = 0.9 + 0.12 * wave * h + 0.06 * h;
	}

	float light = max(uAmbient * vBright, vLight * (0.6 + 0.4 * vBright));
	if (vMaterial == 4) {
		light = max(light, 0.95);
		noise = 0.85 + 0.3 * h;
	}

	vec3 color = vColor * noise * light;
	float dist = length(vPos - uCamPos);
	float fog = smoothstep(uFogStart, uFogEnd, dist);
	outColor = vec4(mix(color, uFogColor, fog), alpha);
}`;

const SKY_VS = `#version 300 es
const vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
out vec2 vNdc;
void main() {
	vNdc = P[gl_VertexID];
	gl_Position = vec4(vNdc, 0.9999, 1.0);
}`;

const SKY_FS = `#version 300 es
precision highp float;
in vec2 vNdc;
uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
uniform vec3 uHorizon;
uniform vec3 uZenith;
uniform vec3 uSunDir;
uniform float uSun;
out vec4 outColor;
void main() {
	vec4 p = uInvViewProj * vec4(vNdc, 1.0, 1.0);
	vec3 dir = normalize(p.xyz / p.w - uCamPos);
	float t = clamp(dir.y * 1.6 + 0.08, 0.0, 1.0);
	vec3 color = mix(uHorizon, uZenith, sqrt(t));
	if (dir.y < 0.0) color = mix(uHorizon, uHorizon * 0.75, clamp(-dir.y * 3.0, 0.0, 1.0));
	float sun = max(dot(dir, uSunDir), 0.0);
	color += vec3(1.0, 0.9, 0.7) * (pow(sun, 900.0) * 1.5 + pow(sun, 12.0) * 0.12) * uSun;
	outColor = vec4(color, 1.0);
}`;

const ENTITY_VS = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;
layout(location = 3) in vec3 aColor;
uniform mat4 uViewProj;
uniform mat4 uModel;
out vec3 vWorld;
out vec3 vNormal;
out vec2 vUv;
out vec3 vColor;
void main() {
	vec4 world = uModel * vec4(aPos, 1.0);
	vWorld = world.xyz;
	vNormal = normalize(mat3(uModel) * aNormal);
	vUv = aUv;
	vColor = aColor;
	gl_Position = uViewProj * world;
}`;

const ENTITY_FS = `#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
in vec2 vUv;
in vec3 vColor;
uniform sampler2D uTexture;
uniform bool uUseTexture;
uniform vec3 uTint;
uniform float uHurt;
uniform float uAmbient;
uniform float uEmissive;
uniform vec3 uCamPos;
uniform vec3 uFogColor;
uniform float uFogStart;
uniform float uFogEnd;
out vec4 outColor;
void main() {
	vec4 base = uUseTexture ? texture(uTexture, vUv) : vec4(vColor, 1.0);
	if (base.a < 0.5) discard;
	vec3 n = normalize(vNormal);
	float light = 0.55 + 0.35 * max(dot(n, normalize(vec3(0.2, 1.0, -0.7))), 0.0)
		+ 0.18 * max(dot(n, normalize(vec3(-0.2, 1.0, 0.7))), 0.0);
	light = min(light, 1.0) * max(uAmbient, uEmissive);
	vec3 color = base.rgb * uTint * light;
	color = mix(color, vec3(0.9, 0.1, 0.1), uHurt * 0.5);
	float fog = smoothstep(uFogStart, uFogEnd, length(vWorld - uCamPos));
	outColor = vec4(mix(color, uFogColor, fog), 1.0);
}`;

function compile(gl, type, source) {
	const shader = gl.createShader(type);
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		throw new Error(gl.getShaderInfoLog(shader) || 'shader error');
	}
	return shader;
}

function program(gl, vs, fs) {
	const p = gl.createProgram();
	gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
	gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
	gl.linkProgram(p);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
		throw new Error(gl.getProgramInfoLog(p) || 'link error');
	}
	const uniforms = {};
	const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
	for (let i = 0; i < count; i++) {
		const info = gl.getActiveUniform(p, i);
		uniforms[info.name] = gl.getUniformLocation(p, info.name);
	}
	return { program: p, u: uniforms };
}

export class Renderer {
	constructor(canvas) {
		this.canvas = canvas;
		const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
		if (!gl) throw new Error('WebGL2 is not available in this browser');
		this.gl = gl;
		this.worldProgram = program(gl, WORLD_VS, WORLD_FS);
		this.skyProgram = program(gl, SKY_VS, SKY_FS);
		this.entityProgram = program(gl, ENTITY_VS, ENTITY_FS);
		this.skyVao = gl.createVertexArray();
		this.indexBuffer = gl.createBuffer();
		this.indexQuads = 0;
		this.indexVersion = 0;
		this.meshes = new Map();
		this.ensureIndices(16384);
		gl.enable(gl.DEPTH_TEST);
		gl.depthFunc(gl.LEQUAL);
	}

	ensureIndices(quads) {
		if (quads <= this.indexQuads) return;
		let size = Math.max(this.indexQuads * 2, 16384);
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
		this.indexVersion++;
	}

	createPart(data) {
		const gl = this.gl;
		const vertices = data.length / STRIDE;
		if (vertices === 0) return null;
		this.ensureIndices(vertices / 4);
		const vao = gl.createVertexArray();
		const vbo = gl.createBuffer();
		gl.bindVertexArray(vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
		gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);
		gl.enableVertexAttribArray(1);
		gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, STRIDE, 12);
		gl.enableVertexAttribArray(2);
		gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, false, STRIDE, 16);
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
		gl.bindVertexArray(null);
		return { vao, vbo, count: (vertices / 4) * 6, indexVersion: this.indexVersion };
	}

	deletePart(part) {
		if (!part) return;
		this.gl.deleteVertexArray(part.vao);
		this.gl.deleteBuffer(part.vbo);
	}

	setSectionMesh(key, section, data) {
		this.removeSection(key);
		const opaque = this.createPart(data.opaque);
		const translucent = this.createPart(data.translucent);
		if (!opaque && !translucent) return;
		this.meshes.set(key, {
			opaque,
			translucent,
			cx: section.x * 16 + 8,
			cy: section.y * 16 + 8,
			cz: section.z * 16 + 8,
		});
	}

	removeSection(key) {
		const mesh = this.meshes.get(key);
		if (!mesh) return;
		this.deletePart(mesh.opaque);
		this.deletePart(mesh.translucent);
		this.meshes.delete(key);
	}

	clearSections() {
		for (const key of [...this.meshes.keys()]) this.removeSection(key);
	}

	resize(scale = 1) {
		const dpr = Math.min(window.devicePixelRatio || 1, 2) * scale;
		const width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
		const height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
		if (this.canvas.width !== width || this.canvas.height !== height) {
			this.canvas.width = width;
			this.canvas.height = height;
		}
		return width / height;
	}

	drawPart(part) {
		const gl = this.gl;
		gl.bindVertexArray(part.vao);
		if (part.indexVersion !== this.indexVersion) {
			gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
			part.indexVersion = this.indexVersion;
		}
		gl.drawElements(gl.TRIANGLES, part.count, gl.UNSIGNED_INT, 0);
	}

	/**
	 * @param frame {viewProj, invViewProj, camPos (origin relative), origin, fogColor, fogStart, fogEnd,
	 *              ambient, horizon, zenith, sunDir, sun, time, frustum(cx,cy,cz)->bool}
	 */
	render(frame, drawEntities) {
		const gl = this.gl;
		gl.viewport(0, 0, this.canvas.width, this.canvas.height);
		gl.clearColor(frame.fogColor[0], frame.fogColor[1], frame.fogColor[2], 1);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

		// Sky
		gl.disable(gl.DEPTH_TEST);
		gl.useProgram(this.skyProgram.program);
		const su = this.skyProgram.u;
		gl.uniformMatrix4fv(su.uInvViewProj, false, frame.invViewProj);
		gl.uniform3fv(su.uCamPos, frame.camPos);
		gl.uniform3fv(su.uHorizon, frame.horizon);
		gl.uniform3fv(su.uZenith, frame.zenith);
		gl.uniform3fv(su.uSunDir, frame.sunDir);
		gl.uniform1f(su.uSun, frame.sun);
		gl.bindVertexArray(this.skyVao);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
		gl.enable(gl.DEPTH_TEST);

		// Opaque world
		gl.useProgram(this.worldProgram.program);
		const wu = this.worldProgram.u;
		gl.uniformMatrix4fv(wu.uViewProj, false, frame.viewProj);
		gl.uniform3fv(wu.uCamPos, frame.camPos);
		gl.uniform3fv(wu.uFogColor, frame.fogColor);
		gl.uniform1f(wu.uFogStart, frame.fogStart);
		gl.uniform1f(wu.uFogEnd, frame.fogEnd);
		gl.uniform1f(wu.uAmbient, frame.ambient);
		gl.uniform1f(wu.uTime, frame.time);
		gl.enable(gl.CULL_FACE);
		gl.cullFace(gl.BACK);
		gl.disable(gl.BLEND);
		gl.depthMask(true);

		const visible = [];
		const o = frame.origin;
		for (const mesh of this.meshes.values()) {
			if (!frame.frustum(mesh.cx - o[0], mesh.cy - o[1], mesh.cz - o[2])) continue;
			visible.push(mesh);
			if (mesh.opaque) this.drawPart(mesh.opaque);
		}

		// Entities (opaque)
		if (drawEntities) drawEntities();

		// Translucent world, back to front
		gl.useProgram(this.worldProgram.program);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		gl.depthMask(false);
		gl.disable(gl.CULL_FACE);
		const cam = frame.camPos;
		const translucent = visible.filter(m => m.translucent);
		for (const m of translucent) {
			const dx = m.cx - o[0] - cam[0], dy = m.cy - o[1] - cam[1], dz = m.cz - o[2] - cam[2];
			m.sortKey = dx * dx + dy * dy + dz * dz;
		}
		translucent.sort((a, b) => b.sortKey - a.sortKey);
		for (const m of translucent) this.drawPart(m.translucent);
		gl.depthMask(true);
		gl.disable(gl.BLEND);
		gl.bindVertexArray(null);

		return visible.length;
	}
}
