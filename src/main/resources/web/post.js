// Post-processing: the shader-pack look (bloom, light shafts, tone mapping)
// and admin/user provided post shaders (config/cctv/shaders/*.glsl, see
// examples/shaders/sepia.glsl for the API).

import { program, FULLSCREEN_VS, Target } from './gl.js';

const BRIGHT_FS = `
in vec2 vUv;
uniform sampler2D uTexture;
uniform float uThreshold;
out vec4 outColor;
void main() {
	vec3 c = texture(uTexture, vUv).rgb;
	float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
	outColor = vec4(c * smoothstep(uThreshold, uThreshold + 0.35, l), 1.0);
}`;

const BLUR_FS = `
in vec2 vUv;
uniform sampler2D uTexture;
uniform vec2 uStep;
out vec4 outColor;
void main() {
	vec3 c = texture(uTexture, vUv).rgb * 0.227027;
	c += texture(uTexture, vUv + uStep * 1.384615).rgb * 0.316216;
	c += texture(uTexture, vUv - uStep * 1.384615).rgb * 0.316216;
	c += texture(uTexture, vUv + uStep * 3.230769).rgb * 0.070270;
	c += texture(uTexture, vUv - uStep * 3.230769).rgb * 0.070270;
	outColor = vec4(c, 1.0);
}`;

const RAYS_FS = `
in vec2 vUv;
uniform sampler2D uDepth;
uniform vec2 uSun;
uniform vec3 uColor;
uniform float uStrength;
out vec4 outColor;
void main() {
	vec2 delta = (uSun - vUv) / 40.0;
	vec2 uv = vUv;
	float decay = 1.0;
	float sum = 0.0;
	for (int i = 0; i < 40; i++) {
		uv += delta;
		if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
		float sky = texture(uDepth, uv).r >= 0.99999 ? 1.0 : 0.0;
		sum += sky * decay;
		decay *= 0.965;
	}
	float falloff = 1.0 - smoothstep(0.0, 0.9, distance(vUv, uSun));
	outColor = vec4(uColor * sum / 40.0 * uStrength * falloff, 1.0);
}`;

const COMPOSITE_FS = `
in vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform sampler2D uRays;
uniform float uBloomStrength;
uniform float uRaysOn;
uniform float uExposure;
out vec4 outColor;
// Keeps Minecraft's colours below the shoulder and rolls off highlights (sun glint, bloom) smoothly.
vec3 shoulder(vec3 c) {
	vec3 over = max(c - 0.8, 0.0);
	return min(c, vec3(0.8)) + 0.2 * (1.0 - exp(-over / 0.2));
}
void main() {
	vec3 c = texture(uScene, vUv).rgb;
	c += texture(uBloom, vUv).rgb * uBloomStrength;
	if (uRaysOn > 0.5) c += texture(uRays, vUv).rgb;
	c = shoulder(c * uExposure);
	float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
	c = mix(vec3(l), c, 1.18);
	c = (c - 0.5) * 1.06 + 0.5;
	outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

const CUSTOM_HEADER = `
in vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uDepth;
uniform vec2 uResolution;
uniform float uTime;
uniform float uDaylight;
uniform float uRain;
uniform float uNear;
uniform float uFar;
float linearDepth(vec2 uv) {
	float d = texture(uDepth, uv).r * 2.0 - 1.0;
	return 2.0 * uNear * uFar / (uFar + uNear - d * (uFar - uNear));
}
`;

const CUSTOM_FOOTER = `
out vec4 outFragColor;
void main() {
	outFragColor = vec4(postProcess(vUv).rgb, 1.0);
}`;

export class PostProcessor {
	constructor(gl, renderer) {
		this.gl = gl;
		this.renderer = renderer;
		this.bright = program(gl, FULLSCREEN_VS, BRIGHT_FS);
		this.blur = program(gl, FULLSCREEN_VS, BLUR_FS);
		this.rays = program(gl, FULLSCREEN_VS, RAYS_FS);
		this.composite = program(gl, FULLSCREEN_VS, COMPOSITE_FS);
		const hdr = renderer.floatTargets;
		this.half = [new Target(gl, { depth: false, hdr }), new Target(gl, { depth: false, hdr })];
		this.quarter = [new Target(gl, { depth: false, hdr }), new Target(gl, { depth: false, hdr })];
		this.raysTarget = new Target(gl, { depth: false, hdr });
		this.output = new Target(gl, { depth: false });
		this.vao = gl.createVertexArray();
		this.custom = null;
		this.customName = null;
	}

	/** Compiles a post shader; returns an error message or null. */
	setCustomShader(name, source) {
		if (this.custom) this.gl.deleteProgram(this.custom.program);
		this.custom = null;
		this.customName = name;
		if (!source) return null;
		try {
			this.custom = program(this.gl, FULLSCREEN_VS, CUSTOM_HEADER + '\n' + source + '\n' + CUSTOM_FOOTER);
			return null;
		} catch (error) {
			console.error('CCTV: post shader "' + name + '" failed to compile', error);
			return String(error.message || error);
		}
	}

	pass(prog, target, setup) {
		const gl = this.gl;
		if (target) target.bind();
		else {
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
		}
		gl.useProgram(prog.program);
		setup(prog.u);
		gl.bindVertexArray(this.vao);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
	}

	texture(unit, texture) {
		const gl = this.gl;
		gl.activeTexture(gl.TEXTURE0 + unit);
		gl.bindTexture(gl.TEXTURE_2D, texture);
		return unit;
	}

	/**
	 * scene: Target with colour and depth; options: {shaders, quality, sun: [u, v] | null, sunColor, rays, time,
	 * daylight, rain, near, far}
	 */
	run(scene, options) {
		const gl = this.gl;
		gl.disable(gl.DEPTH_TEST);
		gl.disable(gl.BLEND);
		gl.disable(gl.CULL_FACE);
		let color = scene.colorTexture;

		if (options.shaders) {
			const w = scene.width, h = scene.height;
			for (const t of this.half) t.resize(Math.max(1, w >> 1), Math.max(1, h >> 1));
			for (const t of this.quarter) t.resize(Math.max(1, w >> 2), Math.max(1, h >> 2));
			const hdr = this.renderer.floatTargets;
			this.pass(this.bright, this.half[0], u => {
				gl.uniform1i(u.uTexture, this.texture(0, color));
				gl.uniform1f(u.uThreshold, hdr ? 0.9 : 0.8);
			});
			const blur = (targets, sx, sy) => {
				this.pass(this.blur, targets[1], u => {
					gl.uniform1i(u.uTexture, this.texture(0, targets[0].colorTexture));
					gl.uniform2f(u.uStep, sx / targets[0].width, 0);
				});
				this.pass(this.blur, targets[0], u => {
					gl.uniform1i(u.uTexture, this.texture(0, targets[1].colorTexture));
					gl.uniform2f(u.uStep, 0, sy / targets[0].height);
				});
			};
			blur(this.half, 1, 1);
			const wide = options.quality === 'high' || options.quality === 'ultra';
			let bloom = this.half[0].colorTexture;
			if (wide) {
				this.pass(this.blur, this.quarter[0], u => {
					gl.uniform1i(u.uTexture, this.texture(0, this.half[0].colorTexture));
					gl.uniform2f(u.uStep, 0, 0);
				});
				blur(this.quarter, 1.5, 1.5);
				blur(this.quarter, 2.5, 2.5);
				bloom = this.quarter[0].colorTexture;
			}
			const raysOn = options.rays && options.sun && options.quality !== 'low';
			if (raysOn) {
				this.raysTarget.resize(Math.max(1, w >> 1), Math.max(1, h >> 1));
				this.pass(this.rays, this.raysTarget, u => {
					gl.uniform1i(u.uDepth, this.texture(0, scene.depthTexture));
					gl.uniform2fv(u.uSun, options.sun);
					gl.uniform3fv(u.uColor, options.sunColor);
					gl.uniform1f(u.uStrength, options.raysStrength);
				});
			}
			const target = this.custom ? this.output : null;
			if (target) target.resize(w, h);
			this.pass(this.composite, target, u => {
				gl.uniform1i(u.uScene, this.texture(0, color));
				gl.uniform1i(u.uBloom, this.texture(1, bloom));
				gl.uniform1i(u.uRays, this.texture(2, raysOn ? this.raysTarget.colorTexture : bloom));
				gl.uniform1f(u.uBloomStrength, wide ? 0.35 : 0.25);
				gl.uniform1f(u.uRaysOn, raysOn ? 1 : 0);
				gl.uniform1f(u.uExposure, 1.0);
			});
			if (!target) return this.finish();
			color = this.output.colorTexture;
		}

		if (this.custom) {
			this.pass(this.custom, null, u => {
				gl.uniform1i(u.uScene, this.texture(0, color));
				gl.uniform1i(u.uDepth, this.texture(1, scene.depthTexture));
				gl.uniform2f(u.uResolution, scene.width, scene.height);
				gl.uniform1f(u.uTime, options.time);
				gl.uniform1f(u.uDaylight, options.daylight);
				gl.uniform1f(u.uRain, options.rain);
				gl.uniform1f(u.uNear, options.near);
				gl.uniform1f(u.uFar, options.far);
			});
			return this.finish();
		}
		this.renderer.blit(color);
		return this.finish();
	}

	finish() {
		const gl = this.gl;
		for (let i = 0; i < 3; i++) {
			gl.activeTexture(gl.TEXTURE0 + i);
			gl.bindTexture(gl.TEXTURE_2D, null);
		}
		gl.activeTexture(gl.TEXTURE0);
		gl.bindVertexArray(null);
		gl.enable(gl.DEPTH_TEST);
	}
}
