// The sky exactly like Minecraft 26.3's SkyRenderer: overworld sky disc with
// sky fog, sunrise/sunset fan, sun, moon phases and the seeded star field,
// the dark disc below the horizon, the End sky box and End flashes. Custom
// sky boxes (cube faces or a panorama from config/cctv/skyboxes) can replace
// or sit under the vanilla sky.

import { program, FULLSCREEN_VS } from './gl.js';
import { JavaRandom } from './rng.js';
import { multiply, rotationX, rotationY, rotationZ, scaling, translation, invert } from './math.js';

const DEG = Math.PI / 180;

const COLOR_VS = `
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aColor;
layout(location = 2) in vec2 aUv;
uniform mat4 uMatrix;
out float vSph;
out float vCyl;
out vec4 vColor;
out vec2 vUv;
void main() {
	vec4 p = uMatrix * vec4(aPos, 1.0);
	// Fog distances use the untransformed vertex like sky.vsh.
	vSph = length(aPos);
	vCyl = max(length(aPos.xz), abs(aPos.y));
	vColor = aColor;
	vUv = aUv;
	gl_Position = p;
}`;

const SKY_FS = `
in float vSph;
in float vCyl;
in vec4 vColor;
in vec2 vUv;
uniform vec4 uColor;
uniform vec4 uFogColor;
uniform float uSkyEnd;
uniform int uMode; // 0 = fogged colour (sky.fsh), 1 = vertex colour (sunrise), 2 = texture (celestial), 3 = texture * vertex colour (End sky)
uniform sampler2D uTexture;
out vec4 outColor;
float linear_fog_value(float d, float start, float end) {
	if (d <= start) return 0.0;
	if (d >= end) return 1.0;
	return (d - start) / (end - start);
}
void main() {
	if (uMode == 0) {
		float fog = max(linear_fog_value(vSph, 0.0, uSkyEnd), linear_fog_value(vCyl, uSkyEnd, uSkyEnd));
		outColor = vec4(mix(uColor.rgb, uFogColor.rgb, fog * uFogColor.a), uColor.a);
	} else if (uMode == 1) {
		outColor = vColor * uColor;
	} else if (uMode == 2) {
		outColor = texture(uTexture, vUv) * uColor;
	} else {
		outColor = texture(uTexture, vUv) * vColor * uColor;
	}
}`;

const SKYBOX_FS = `
in vec2 vUv;
uniform mat4 uInvViewProj;
uniform int uType; // 0 = cube, 1 = panorama
uniform samplerCube uCube;
uniform sampler2D uPanorama;
uniform float uBrightness;
uniform float uRotation;
out vec4 outColor;
void main() {
	vec4 p = uInvViewProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
	vec3 dir = normalize(p.xyz / p.w);
	float c = cos(uRotation), s = sin(uRotation);
	dir = vec3(c * dir.x - s * dir.y, s * dir.x + c * dir.y, dir.z);
	vec3 color;
	if (uType == 0) {
		color = texture(uCube, dir).rgb;
	} else {
		vec2 uv = vec2(atan(dir.x, -dir.z) / 6.2831853 + 0.5, acos(clamp(dir.y, -1.0, 1.0)) / 3.1415927);
		color = textureGrad(uPanorama, uv, dFdx(uv * 0.0), dFdy(uv * 0.0)).rgb;
	}
	outColor = vec4(color * uBrightness, 1.0);
}`;

function buildVao(gl, data, stride = 9) {
	const vao = gl.createVertexArray();
	const vbo = gl.createBuffer();
	gl.bindVertexArray(vao);
	gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
	gl.enableVertexAttribArray(0);
	gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride * 4, 0);
	gl.enableVertexAttribArray(1);
	gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride * 4, 12);
	gl.enableVertexAttribArray(2);
	gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride * 4, 28);
	gl.bindVertexArray(null);
	return { vao, count: data.length / stride };
}

const v = (x, y, z, r = 1, g = 1, b = 1, a = 1, u = 0, t = 0) => [x, y, z, r, g, b, a, u, t];

function skyDisc(yy) {
	const out = [...v(0, yy, 0)];
	const x = Math.sign(yy) * 512;
	for (let i = -180; i <= 180; i += 45) out.push(...v(x * Math.cos(i * DEG), yy, 512 * Math.sin(i * DEG)));
	return out;
}

function sunriseFan() {
	const out = [...v(0, 100, 0, 1, 1, 1, 1)];
	for (let i = 0; i <= 16; i++) {
		const angle = i * Math.PI * 2 / 16;
		out.push(...v(Math.sin(angle) * 120, Math.cos(angle) * 120, -Math.cos(angle) * 40, 1, 1, 1, 0));
	}
	return out;
}

/** Two triangles per quad for drawArrays. */
function quads(list) {
	const out = [];
	for (let i = 0; i < list.length; i += 4) {
		for (const k of [0, 1, 2, 0, 2, 3]) out.push(...list[i + k]);
	}
	return out;
}

function celestialQuad(flip) {
	return quads(flip
		? [v(-1, 0, -1, 1, 1, 1, 1, 1, 1), v(1, 0, -1, 1, 1, 1, 1, 0, 1), v(1, 0, 1, 1, 1, 1, 1, 0, 0), v(-1, 0, 1, 1, 1, 1, 1, 1, 0)]
		: [v(-1, 0, -1, 1, 1, 1, 1, 0, 0), v(1, 0, -1, 1, 1, 1, 1, 1, 0), v(1, 0, 1, 1, 1, 1, 1, 1, 1), v(-1, 0, 1, 1, 1, 1, 1, 0, 1)]);
}

/** SkyRenderer.buildStars with the same seed, so the constellations match the game. */
function stars() {
	const random = new JavaRandom();
	random.setSeedNumber(10842);
	const list = [];
	for (let i = 0; i < 1500; i++) {
		const x = random.nextFloat() * 2 - 1;
		const y = random.nextFloat() * 2 - 1;
		const z = random.nextFloat() * 2 - 1;
		const size = 0.15 + random.nextFloat() * 0.1;
		const lengthSq = x * x + y * y + z * z;
		if (lengthSq <= 0.010000001 || lengthSq >= 1) continue;
		const len = Math.sqrt(lengthSq);
		const center = [x / len * 100, y / len * 100, z / len * 100];
		const zRot = random.nextDouble() * Math.PI * 2;
		// Matrix3f.rotateTowards(-center, up) then rotateZ(-zRot)
		const d = [-center[0] / 100, -center[1] / 100, -center[2] / 100];
		let left = [1 * d[2] - 0 * d[1], 0 * d[0] - 0 * d[2], 0 * d[1] - 1 * d[0]];
		const ll = Math.hypot(left[0], left[1], left[2]) || 1;
		left = left.map(c => c / ll);
		const up = [d[1] * left[2] - d[2] * left[1], d[2] * left[0] - d[0] * left[2], d[0] * left[1] - d[1] * left[0]];
		const c = Math.cos(-zRot), s = Math.sin(-zRot);
		const col0 = [0, 1, 2].map(k => c * left[k] + s * up[k]);
		const col1 = [0, 1, 2].map(k => -s * left[k] + c * up[k]);
		const corner = (a, b) => v(a * col0[0] + b * col1[0] + center[0], a * col0[1] + b * col1[1] + center[1], a * col0[2] + b * col1[2] + center[2]);
		list.push(corner(size, -size), corner(size, size), corner(-size, size), corner(-size, -size));
	}
	return quads(list);
}

function endSky() {
	const list = [];
	const color = 0x28 / 255;
	for (let i = 0; i < 6; i++) {
		let pose = null;
		switch (i) {
			case 1: pose = rotationX(Math.PI / 2); break;
			case 2: pose = rotationX(-Math.PI / 2); break;
			case 3: pose = rotationX(Math.PI); break;
			case 4: pose = rotationZ(Math.PI / 2); break;
			case 5: pose = rotationZ(-Math.PI / 2); break;
			default: break;
		}
		const corners = [[-100, -100, -100, 0, 0], [-100, -100, 100, 0, 16], [100, -100, 100, 16, 16], [100, -100, -100, 16, 0]];
		for (const [x, y, z, u, t] of corners) {
			let p = [x, y, z];
			if (pose) p = [pose[0] * x + pose[4] * y + pose[8] * z, pose[1] * x + pose[5] * y + pose[9] * z, pose[2] * x + pose[6] * y + pose[10] * z];
			list.push(v(p[0], p[1], p[2], color, color, color, 1, u, t));
		}
	}
	return quads(list);
}

/** Average colour of the images' rows around `row` (0..1 from the top): the sky box's horizon, used for fog. */
function averageHorizon(images, row) {
	const canvas = new OffscreenCanvas(64, 32);
	const g = canvas.getContext('2d', { willReadFrequently: true });
	let r = 0, gr = 0, b = 0, n = 0;
	for (const img of images) {
		g.clearRect(0, 0, 64, 32);
		g.drawImage(img, 0, 0, 64, 32);
		const y0 = Math.max(0, Math.floor(row * 32) - 2);
		const data = g.getImageData(0, y0, 64, 3).data;
		for (let i = 0; i < data.length; i += 4) {
			r += data[i]; gr += data[i + 1]; b += data[i + 2]; n++;
		}
	}
	return n ? [r / n / 255, gr / n / 255, b / n / 255] : null;
}

/** Brightness applied to a custom sky box (its options and the time of day). */
export function customBrightness(custom, sky) {
	const o = custom.options || {};
	let brightness = o.brightness ?? 1;
	if (o.followDaylight !== false && sky.skybox === 'overworld') {
		const c = sky.skyColor;
		brightness *= Math.min(1, Math.max(0.08, Math.max(c[0], c[1], c[2])));
	}
	return brightness;
}

export class SkyRenderer {
	constructor(gl) {
		this.gl = gl;
		this.program = program(gl, COLOR_VS, SKY_FS);
		this.skyboxProgram = program(gl, FULLSCREEN_VS, SKYBOX_FS);
		this.emptyVao = gl.createVertexArray();
		this.topDisc = buildVao(gl, skyDisc(16));
		this.bottomDisc = buildVao(gl, skyDisc(-16));
		this.sunrise = buildVao(gl, sunriseFan());
		this.sun = buildVao(gl, celestialQuad(false));
		this.moon = buildVao(gl, celestialQuad(true));
		this.stars = buildVao(gl, stars());
		this.endSky = buildVao(gl, endSky());
		this.customBoxes = new Map();
	}

	/**
	 * frame: {projection, viewRotation (view matrix without translation), fog: {color, skyEnd}},
	 * sky: Environment.sky, textures: assets.environment, custom: {box, options} or null
	 */
	render(frame, sky, textures, custom) {
		const gl = this.gl;
		gl.disable(gl.DEPTH_TEST);
		gl.depthMask(false);
		gl.disable(gl.CULL_FACE);
		const base = multiply(frame.projection, frame.viewRotation);
		const options = custom ? custom.options : null;

		if (custom && custom.ready) {
			this.drawCustom(frame, sky, custom);
			if (options && options.showSun === false) {
				gl.enable(gl.DEPTH_TEST);
				gl.depthMask(true);
				return;
			}
		}

		const p = this.program;
		gl.useProgram(p.program);
		gl.uniform4f(p.u.uFogColor, frame.fog.color[0], frame.fog.color[1], frame.fog.color[2], 1);
		gl.uniform1f(p.u.uSkyEnd, frame.fog.skyEnd);
		gl.uniform1i(p.u.uTexture, 0);
		gl.activeTexture(gl.TEXTURE0);

		const draw = (mesh, model, mode, color, mode2) => {
			gl.uniformMatrix4fv(p.u.uMatrix, false, multiply(base, model));
			gl.uniform1i(p.u.uMode, mode);
			gl.uniform4f(p.u.uColor, color[0], color[1], color[2], color[3]);
			gl.bindVertexArray(mesh.vao);
			gl.drawArrays(mode2 || gl.TRIANGLES, 0, mesh.count);
		};
		const identity = scaling(1, 1, 1);

		if (sky.skybox === 'end') {
			if (!custom || !custom.ready) {
				if (textures && textures.endSky) {
					gl.bindTexture(gl.TEXTURE_2D, textures.endSky);
					gl.enable(gl.BLEND);
					gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
					draw(this.endSky, identity, 3, [1, 1, 1, 1]);
				}
			}
			const f = sky.flash;
			if (f && f.intensity > 1e-5 && textures && textures.endFlash) {
				let m = multiply(rotationY((180 - f.yAngle) * DEG), rotationX((-90 - f.xAngle) * DEG));
				m = multiply(m, translation(0, 100, 0));
				m = multiply(m, scaling(60, 1, 60));
				gl.enable(gl.BLEND);
				gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
				gl.bindTexture(gl.TEXTURE_2D, textures.endFlash);
				draw(this.sun, m, 2, [f.intensity, f.intensity, f.intensity, f.intensity]);
			}
			this.finish();
			return;
		}
		if (sky.skybox !== 'overworld') {
			this.finish();
			return;
		}

		if (!custom || !custom.ready) {
			gl.disable(gl.BLEND);
			draw(this.topDisc, identity, 0, [sky.skyColor[0], sky.skyColor[1], sky.skyColor[2], 1], gl.TRIANGLE_FAN);
		}

		// Sunrise / sunset fan.
		const sunrise = sky.sunrise;
		if (sunrise[3] > 0.001) {
			const angle = Math.sin(sky.sunAngle) < 0 ? 180 : 0;
			let m = multiply(rotationX(90 * DEG), rotationZ((angle + 90) * DEG));
			m = multiply(m, scaling(1, 1, sunrise[3]));
			gl.enable(gl.BLEND);
			gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
			draw(this.sunrise, m, 1, sunrise, gl.TRIANGLE_FAN);
		}

		// Sun, moon and stars: added on top (SRC_ALPHA, ONE).
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
		const celestial = rotationY(-90 * DEG);
		if (textures && textures.sun) {
			let m = multiply(celestial, rotationX(sky.sunAngle));
			m = multiply(m, translation(0, 100, 0));
			m = multiply(m, scaling(30, 1, 30));
			gl.bindTexture(gl.TEXTURE_2D, textures.sun);
			draw(this.sun, m, 2, [1, 1, 1, sky.rainBrightness]);
		}
		const moonTexture = textures && textures.moon && textures.moon[sky.moonPhase];
		if (moonTexture) {
			let m = multiply(celestial, rotationX(sky.moonAngle));
			m = multiply(m, translation(0, 100, 0));
			m = multiply(m, scaling(20, 1, 20));
			gl.bindTexture(gl.TEXTURE_2D, moonTexture);
			draw(this.moon, m, 2, [1, 1, 1, sky.rainBrightness]);
		}
		if (sky.starBrightness > 0) {
			const b = sky.starBrightness;
			draw(this.stars, multiply(celestial, rotationX(sky.starAngle)), 1, [b, b, b, b]);
		}

		if (sky.darkDisc && (!custom || !custom.ready)) {
			gl.disable(gl.BLEND);
			draw(this.bottomDisc, translation(0, 12, 0), 0, [0, 0, 0, 1], gl.TRIANGLE_FAN);
		}
		this.finish();
	}

	finish() {
		const gl = this.gl;
		gl.disable(gl.BLEND);
		gl.bindVertexArray(null);
		gl.enable(gl.DEPTH_TEST);
		gl.depthMask(true);
	}

	drawCustom(frame, sky, custom) {
		const gl = this.gl;
		const p = this.skyboxProgram;
		const o = custom.options || {};
		gl.useProgram(p.program);
		gl.uniformMatrix4fv(p.u.uInvViewProj, false, invert(multiply(frame.projection, frame.viewRotation)));
		gl.uniform1i(p.u.uType, custom.type === 'cube' ? 0 : 1);
		gl.uniform1i(p.u.uCube, 1);
		gl.uniform1i(p.u.uPanorama, 2);
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_CUBE_MAP, custom.type === 'cube' ? custom.texture : null);
		gl.activeTexture(gl.TEXTURE2);
		gl.bindTexture(gl.TEXTURE_2D, custom.type === 'cube' ? null : custom.texture);
		gl.activeTexture(gl.TEXTURE0);
		gl.uniform1f(p.u.uBrightness, customBrightness(custom, sky));
		gl.uniform1f(p.u.uRotation, o.rotateWithSun ? sky.sunAngle : 0);
		gl.bindVertexArray(this.emptyVao);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
		gl.activeTexture(gl.TEXTURE2);
		gl.bindTexture(gl.TEXTURE_2D, null);
		gl.activeTexture(gl.TEXTURE0);
	}

	/** Loads a custom sky box described by /api/viewer ({type, faces | file, options}). */
	loadCustom(name, def, query) {
		let entry = this.customBoxes.get(name);
		if (entry) return entry;
		entry = { name, type: def.type, ready: false, options: {} };
		this.customBoxes.set(name, entry);
		const gl = this.gl;
		const image = url => fetch(url + query, { credentials: 'same-origin' })
			.then(r => { if (!r.ok) throw new Error(url); return r.blob(); })
			.then(blob => createImageBitmap(blob, { colorSpaceConversion: 'none' }));
		const options = def.options
			? fetch(def.options + query, { credentials: 'same-origin' }).then(r => (r.ok ? r.json() : {})).catch(() => ({}))
			: Promise.resolve({});
		const load = def.type === 'cube'
			? Promise.all(['px', 'nx', 'py', 'ny', 'pz', 'nz'].map(face => image(def.faces[face]))).then(images => {
				const t = gl.createTexture();
				gl.bindTexture(gl.TEXTURE_CUBE_MAP, t);
				images.forEach((img, i) => gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img));
				gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
				gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
				gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
				gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
				gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
				return t;
			})
			: image(def.file).then(img => {
				const t = gl.createTexture();
				gl.bindTexture(gl.TEXTURE_2D, t);
				gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
				return t;
			});
		const horizon = def.type === 'cube'
			? Promise.all(['px', 'nx', 'pz', 'nz'].map(face => image(def.faces[face]))).then(images => averageHorizon(images, 0.5))
			: image(def.file).then(img => averageHorizon([img], 0.47));
		Promise.all([load, options, horizon.catch(() => null)]).then(([t, o, color]) => {
			entry.texture = t;
			entry.options = o || {};
			entry.horizonColor = color;
			entry.ready = true;
		}).catch(err => {
			console.warn('CCTV: sky box "' + name + '" could not be loaded', err);
			entry.failed = true;
		});
		return entry;
	}
}
