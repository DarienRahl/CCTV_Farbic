// Small WebGL2 helpers shared by the renderers.

export function compile(gl, type, source) {
	const shader = gl.createShader(type);
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		const log = gl.getShaderInfoLog(shader) || 'shader error';
		gl.deleteShader(shader);
		throw new Error(log);
	}
	return shader;
}

/** Links a program and collects its uniform locations as `u` (names without "[0]"). */
export function program(gl, vs, fs, defines = '') {
	const header = '#version 300 es\n' + defines + '\n';
	const p = gl.createProgram();
	gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, header + vs));
	gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, header + 'precision highp float;\nprecision highp int;\n' + fs));
	gl.linkProgram(p);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
		throw new Error(gl.getProgramInfoLog(p) || 'link error');
	}
	const u = {};
	const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
	for (let i = 0; i < count; i++) {
		const info = gl.getActiveUniform(p, i);
		u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
	}
	return { program: p, u };
}

export function createTexture(gl, width, height, { internal, format, type, filter, data = null }) {
	const t = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, t);
	gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, data);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	return t;
}

/** A framebuffer with an optional colour texture and an optional depth texture. */
export class Target {
	constructor(gl, { color = true, depth = true, hdr = false, filter } = {}) {
		this.gl = gl;
		this.color = color;
		this.depth = depth;
		this.hdr = hdr;
		this.filter = filter ?? gl.LINEAR;
		this.width = 0;
		this.height = 0;
		this.fbo = gl.createFramebuffer();
	}

	resize(width, height) {
		if (width === this.width && height === this.height) return;
		const gl = this.gl;
		this.width = width;
		this.height = height;
		if (this.colorTexture) gl.deleteTexture(this.colorTexture);
		if (this.depthTexture) gl.deleteTexture(this.depthTexture);
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
		if (this.color) {
			this.colorTexture = this.hdr
				? createTexture(gl, width, height, { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, filter: this.filter })
				: createTexture(gl, width, height, { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, filter: this.filter });
			gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.colorTexture, 0);
		} else {
			gl.drawBuffers([gl.NONE]);
			gl.readBuffer(gl.NONE);
		}
		if (this.depth) {
			this.depthTexture = createTexture(gl, width, height, {
				internal: gl.DEPTH_COMPONENT24, format: gl.DEPTH_COMPONENT, type: gl.UNSIGNED_INT, filter: gl.NEAREST,
			});
			gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.depthTexture, 0);
		}
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	}

	bind() {
		const gl = this.gl;
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
		gl.viewport(0, 0, this.width, this.height);
	}
}

export const FULLSCREEN_VS = `
out vec2 vUv;
void main() {
	vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
	vUv = p;
	gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/**
 * Fog as in Minecraft's fog.glsl (environmental: spherical distance, render distance: cylindrical), with the
 * viewer's softer fades: uFogSmooth eases both ramps in and out, uFogHaze adds a haze that thickens with
 * distance (aerial perspective); both 0 is the game's fog.
 */
export const FOG_GLSL = `
uniform vec4 uFogColor;
uniform float uFogEnvStart;
uniform float uFogEnvEnd;
uniform float uFogRdStart;
uniform float uFogRdEnd;
uniform float uFogSmooth;
uniform float uFogHaze;
float linear_fog_value(float d, float start, float end) {
	if (d <= start) return 0.0;
	if (d >= end) return 1.0;
	return (d - start) / (end - start);
}
float total_fog_value(float sph, float cyl) {
	float env = linear_fog_value(sph, uFogEnvStart, uFogEnvEnd);
	float rd = linear_fog_value(cyl, uFogRdStart, uFogRdEnd);
	if (uFogSmooth > 0.5) {
		env = env * env * (3.0 - 2.0 * env);
		rd = rd * rd * (3.0 - 2.0 * rd);
	}
	float haze = uFogHaze > 0.0 ? (1.0 - exp(-sph * sph * uFogHaze * uFogHaze)) * 0.85 : 0.0;
	return max(max(env, rd), haze);
}
vec4 apply_fog(vec4 color, float sph, float cyl) {
	return vec4(mix(color.rgb, uFogColor.rgb, total_fog_value(sph, cyl) * uFogColor.a), color.a);
}
float fog_cylindrical_distance(vec3 pos) {
	return max(length(pos.xz), abs(pos.y));
}`;

export function setFog(gl, u, fog) {
	gl.uniform4f(u.uFogColor, fog.color[0], fog.color[1], fog.color[2], 1);
	gl.uniform1f(u.uFogEnvStart, fog.envStart);
	gl.uniform1f(u.uFogEnvEnd, fog.envEnd);
	gl.uniform1f(u.uFogRdStart, fog.rdStart);
	gl.uniform1f(u.uFogRdEnd, fog.rdEnd);
	gl.uniform1f(u.uFogSmooth, fog.smooth || 0);
	gl.uniform1f(u.uFogHaze, fog.haze || 0);
}
