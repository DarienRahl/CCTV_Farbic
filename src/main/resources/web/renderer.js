// WebGL2 renderer: sky, world sections (opaque + translucent pass) and the
// shared entity shader. All heavy lifting happens here, in the browser.

import { STRIDE } from './world.js';

const WORLD_VS = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aUv;
layout(location = 2) in vec4 aColor;
layout(location = 3) in vec4 aLight;
uniform mat4 uViewProj;
out vec3 vPos;
out vec2 vUv;
out vec3 vColor;
out vec2 vLight;
flat out int vMaterial;
void main() {
	vPos = aPos;
	vUv = aUv;
	vColor = aColor.rgb;
	// Lightmap coordinates exactly like Minecraft: (block, sky) * 16 / 256.
	vLight = clamp(vec2(aLight.y, aLight.x) / 256.0, vec2(0.5 / 16.0), vec2(15.5 / 16.0));
	vMaterial = int(aLight.z + 0.5);
	gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const WORLD_FS = `#version 300 es
precision highp float;
in vec3 vPos;
in vec2 vUv;
in vec3 vColor;
in vec2 vLight;
flat in int vMaterial;
uniform sampler2D uAtlas;
uniform sampler2D uLightmap;
uniform vec3 uCamPos;
uniform vec3 uFogColor;
uniform float uFogStart;
uniform float uFogEnd;
out vec4 outColor;

float hash(vec3 p) {
	p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
	p *= 17.0;
	return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

void main() {
	vec4 base;
	if (vMaterial == 3) {
		// No client textures: flat colour with a 16x16 "pixel" pattern.
		vec3 n = normalize(cross(dFdx(vPos), dFdy(vPos)));
		base = vec4(vec3(0.9 + 0.18 * hash(floor((vPos - n * 0.002) * 16.0))), 1.0);
	} else {
		base = texture(uAtlas, vUv);
		if (vMaterial == 1 && base.a < 0.5) discard;
		if (vMaterial == 2 && base.a < 0.004) discard;
		if (vMaterial == 0) base.a = 1.0;
	}
	vec3 light = texture(uLightmap, vLight).rgb;
	vec3 color = base.rgb * vColor * light;
	vec3 d = vPos - uCamPos;
	float fog = clamp((max(length(d.xz), abs(d.y)) - uFogStart) / (uFogEnd - uFogStart), 0.0, 1.0);
	outColor = vec4(mix(color, uFogColor, fog), base.a);
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
uniform float uMoon;
uniform float uStars;
uniform vec2 uMoonPhase;
uniform sampler2D uSunTex;
uniform sampler2D uMoonTex;
uniform sampler2D uCloudTex;
uniform bool uHasSun;
uniform bool uHasMoon;
uniform bool uHasClouds;
uniform float uCloudY;
uniform vec2 uCloudPos;
uniform vec3 uCloudColor;
out vec4 outColor;

float hash(vec3 p) {
	p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
	p *= 17.0;
	return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

void main() {
	vec4 p = uInvViewProj * vec4(vNdc, 1.0, 1.0);
	vec3 dir = normalize(p.xyz / p.w - uCamPos);

	// Sky dome: sky colour above, fog colour at the horizon (like the client's sky + fog).
	float t = clamp(dir.y / 0.45, 0.0, 1.0);
	vec3 color = mix(uHorizon, uZenith, sqrt(t));

	// Stars
	if (uStars > 0.0 && dir.y > 0.0) {
		vec3 cell = floor(dir * 180.0);
		float h = hash(cell);
		if (h > 0.9975) color += vec3((h - 0.9975) / 0.0025 * uStars);
	}

	// Sun and moon: textured squares seen at 100 blocks (sun 30 wide, moon 20), added like the game does.
	vec3 u = vec3(0.0, 0.0, 1.0);
	vec3 v = normalize(cross(uSunDir, u));
	float ds = dot(dir, uSunDir);
	if (uHasSun && uSun > 0.0 && ds > 0.0) {
		vec3 q = dir / ds;
		vec2 c = vec2(dot(q, u), dot(q, v)) / 0.3;
		if (abs(c.x) < 1.0 && abs(c.y) < 1.0) color += texture(uSunTex, c * 0.5 + 0.5).rgb * uSun;
	}
	if (uHasMoon && uMoon > 0.0 && ds < 0.0) {
		vec3 q = dir / -ds;
		vec2 c = vec2(dot(q, u), -dot(q, v)) / 0.2;
		if (abs(c.x) < 1.0 && abs(c.y) < 1.0) color += texture(uMoonTex, (c * 0.5 + 0.5 + uMoonPhase) / vec2(4.0, 2.0)).rgb * uMoon;
	}

	// Flat clouds (like "Fast" clouds): 12 blocks per texel of clouds.png, drifting slowly.
	if (uHasClouds && abs(dir.y) > 0.002) {
		float dist = uCloudY / dir.y;
		if (dist > 0.0 && dist < 1600.0) {
			vec2 xz = uCloudPos + dir.xz * dist;
			vec4 cloud = texture(uCloudTex, xz / 3072.0);
			if (cloud.a > 0.5) {
				float fade = 1.0 - smoothstep(600.0, 1600.0, dist);
				color = mix(color, uCloudColor, 0.8 * fade);
			}
		}
	}

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
uniform sampler2D uLightmap;
uniform bool uUseTexture;
uniform vec3 uTint;
uniform float uHurt;
uniform vec2 uLight;
uniform vec3 uCamPos;
uniform vec3 uFogColor;
uniform float uFogStart;
uniform float uFogEnd;
out vec4 outColor;
void main() {
	vec4 base = uUseTexture ? texture(uTexture, vUv) * vec4(vColor, 1.0) : vec4(vColor, 1.0);
	if (base.a < 0.5) discard;
	vec3 n = normalize(vNormal);
	// Minecraft's entity lighting: two directional lights plus ambient, times the lightmap.
	float light = 0.4 + 0.6 * max(dot(n, normalize(vec3(0.2, 1.0, -0.7))), 0.0)
		+ 0.6 * max(dot(n, normalize(vec3(-0.2, 1.0, 0.7))), 0.0);
	light = min(light, 1.0);
	vec3 color = base.rgb * uTint * light * texture(uLightmap, clamp(uLight, vec2(0.5 / 16.0), vec2(15.5 / 16.0))).rgb;
	color = mix(color, vec3(0.9, 0.1, 0.1), uHurt * 0.5);
	vec3 d = vWorld - uCamPos;
	float fog = clamp((max(length(d.xz), abs(d.y)) - uFogStart) / (uFogEnd - uFogStart), 0.0, 1.0);
	outColor = vec4(mix(color, uFogColor, fog), 1.0);
}`;

const SHADOW_VS = `#version 300 es
const vec2 C[4] = vec2[4](vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(1.0, 1.0), vec2(-1.0, 1.0));
uniform mat4 uViewProj;
uniform vec3 uCenter;
uniform float uRadius;
out vec2 vCorner;
void main() {
	vCorner = C[gl_VertexID];
	gl_Position = uViewProj * vec4(uCenter + vec3(vCorner.x, 0.0, vCorner.y) * uRadius, 1.0);
}`;

const SHADOW_FS = `#version 300 es
precision highp float;
in vec2 vCorner;
uniform float uAlpha;
out vec4 outColor;
void main() {
	float d = length(vCorner);
	if (d > 1.0) discard;
	outColor = vec4(0.0, 0.0, 0.0, uAlpha * (1.0 - smoothstep(0.45, 1.0, d)));
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
		this.shadowProgram = program(gl, SHADOW_VS, SHADOW_FS);
		this.shadowVao = gl.createVertexArray();
		this.skyVao = gl.createVertexArray();
		this.indexBuffer = gl.createBuffer();
		this.indexQuads = 0;
		this.indexVersion = 0;
		this.meshes = new Map();
		this.ensureIndices(16384);
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
		gl.vertexAttribPointer(1, 2, gl.UNSIGNED_SHORT, true, STRIDE, 12);
		gl.enableVertexAttribArray(2);
		gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, STRIDE, 16);
		gl.enableVertexAttribArray(3);
		gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, false, STRIDE, 20);
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
		gl.bindVertexArray(null);
		return { vao, vbo, count: (vertices / 4) * 6, indexVersion: this.indexVersion };
	}

	/** Uploads the 16x16 lightmap (x = block light, y = sky light). */
	setLightmap(pixels) {
		const gl = this.gl;
		gl.bindTexture(gl.TEXTURE_2D, this.lightmap);
		gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 16, 16, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
	}

	bindWorldTextures(program) {
		const gl = this.gl;
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, this.lightmap);
		gl.uniform1i(program.u.uLightmap, 1);
		if (program.u.uAtlas) {
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, this.atlas);
			gl.uniform1i(program.u.uAtlas, 0);
		}
		gl.activeTexture(gl.TEXTURE0);
	}

	/** Soft round entity shadows on the ground, like the game's entity shadow. */
	drawShadows(viewProj, shadows) {
		if (!shadows.length) return;
		const gl = this.gl;
		const p = this.shadowProgram;
		gl.useProgram(p.program);
		gl.uniformMatrix4fv(p.u.uViewProj, false, viewProj);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		gl.depthMask(false);
		gl.disable(gl.CULL_FACE);
		gl.enable(gl.POLYGON_OFFSET_FILL);
		gl.polygonOffset(-2, -2);
		gl.bindVertexArray(this.shadowVao);
		for (const s of shadows) {
			gl.uniform3fv(p.u.uCenter, s.center);
			gl.uniform1f(p.u.uRadius, s.radius);
			gl.uniform1f(p.u.uAlpha, s.alpha);
			gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
		}
		gl.disable(gl.POLYGON_OFFSET_FILL);
		gl.depthMask(true);
		gl.disable(gl.BLEND);
		gl.enable(gl.CULL_FACE);
		gl.bindVertexArray(null);
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
		gl.uniform1f(su.uMoon, frame.moon || 0);
		gl.uniform1f(su.uStars, frame.stars || 0);
		const env = frame.environment || {};
		const bindSky = (unit, name, flag, texture) => {
			gl.activeTexture(gl.TEXTURE0 + unit);
			gl.bindTexture(gl.TEXTURE_2D, texture || this.atlas);
			gl.uniform1i(su[name], unit);
			gl.uniform1i(su[flag], texture ? 1 : 0);
		};
		bindSky(2, 'uSunTex', 'uHasSun', env.sun);
		bindSky(3, 'uMoonTex', 'uHasMoon', env.moon);
		bindSky(4, 'uCloudTex', 'uHasClouds', env.clouds);
		gl.activeTexture(gl.TEXTURE0);
		gl.uniform2fv(su.uMoonPhase, frame.moonPhase || [0, 0]);
		gl.uniform1f(su.uCloudY, frame.cloudY ?? 120);
		gl.uniform2fv(su.uCloudPos, frame.cloudPos || [0, 0]);
		gl.uniform3fv(su.uCloudColor, frame.cloudColor || [1, 1, 1]);
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
		this.bindWorldTextures(this.worldProgram);
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
		this.bindWorldTextures(this.worldProgram);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		gl.depthMask(false);
		gl.enable(gl.CULL_FACE);
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
