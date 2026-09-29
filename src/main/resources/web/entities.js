// Live entities: interpolation between server snapshots, the game's own
// entity models and textures (see mobs.js / entity-models.js), items,
// block entities, shadows and name tags that only show when the entity is
// really visible (not through walls).

import {
	ModelLibrary, VertexSink, FLOATS, emitModel, emitQuads, partMatrix, mat4, mul, translate, rotate, scale, DEG,
} from './entity-models.js';
import { describeMob, isKnownMob, blockEntityModel, dyeRgb, CLIENT, equipmentPose } from './mobs.js';
import { Animator, AnimationStates } from './keyframes.js';
import { collectParts } from './models.js';
import { JavaRandom } from './rng.js';
import { program, FOG_GLSL, setFog } from './gl.js';
import { SHADOW_GLSL, SHADER_LIGHT_GLSL } from './renderer.js';
import { lerp, lerpAngle, wrapDegrees } from './math.js';
import { TextRenderer, rgb, matrixTransform, FULL_BRIGHT } from './text.js';

const MODE_CUTOUT = 0, MODE_NOCULL = 1, MODE_TRANSLUCENT = 2, MODE_EYES = 3, MODE_ENERGY = 4;
const MODES = { cutout: MODE_CUTOUT, cutout_nocull: MODE_NOCULL, translucent: MODE_TRANSLUCENT, eyes: MODE_EYES, energy: MODE_ENERGY };

const ENTITY_VS = `
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;
layout(location = 3) in vec4 aColor;
layout(location = 4) in vec2 aLight;
layout(location = 5) in vec2 aOverlay;
uniform mat4 uViewProj;
uniform sampler2D uLightmap;
uniform int uMode;
uniform float uTime;
uniform vec3 uLight0;
uniform vec3 uLight1;
out float vSph;
out float vCyl;
out vec4 vColor;
out vec4 vLightColor;
out vec2 vUv;
out vec4 vOverlay;
#ifdef SHADERS
out vec3 vPos;
out vec3 vNormal;
out float vSky;
#endif
void main() {
	gl_Position = uViewProj * vec4(aPos, 1.0);
	vSph = length(aPos);
	vCyl = max(length(aPos.xz), abs(aPos.y));
	vec3 n = normalize(aNormal);
	float light = min(1.0, (max(0.0, dot(uLight0, n)) + max(0.0, dot(uLight1, n))) * 0.6 + 0.4);
	vColor = (uMode == 3 || uMode == 4) ? aColor : vec4(aColor.rgb * light, aColor.a);
	vLightColor = uMode == 3 ? vec4(1.0) : texture(uLightmap, clamp(aLight / 256.0 + 0.5 / 16.0, vec2(0.5 / 16.0), vec2(15.5 / 16.0)));
	vUv = uMode == 4 ? aUv + vec2(uTime * 0.01) : aUv;
	// OverlayTexture: hurt = red at 0.7 alpha, white flash fades the picture to white.
	vOverlay = aOverlay.x > 0.5 ? vec4(1.0, 0.0, 0.0, 0.7) : vec4(1.0, 1.0, 1.0, 1.0 - aOverlay.y * 0.75);
#ifdef SHADERS
	vPos = aPos;
	vNormal = n;
	vSky = aLight.y / 240.0;
#endif
}`;

const ENTITY_FS = `
in float vSph;
in float vCyl;
in vec4 vColor;
in vec4 vLightColor;
in vec2 vUv;
in vec4 vOverlay;
uniform sampler2D uTexture;
uniform int uMode;
${FOG_GLSL}
#ifdef SHADERS
in vec3 vPos;
in vec3 vNormal;
in float vSky;
${SHADOW_GLSL}
${SHADER_LIGHT_GLSL}
#endif
out vec4 outColor;
void main() {
	vec4 color = texture(uTexture, vUv);
	if (uMode <= 1 && color.a < 0.1) discard;
	if (uMode == 2 && color.a < 0.004) discard;
	color *= vColor;
	if (uMode >= 3) {
		outColor = vec4(color.rgb * color.a * (1.0 - total_fog_value(vSph, vCyl)), 1.0);
		return;
	}
	color.rgb = mix(vOverlay.rgb, color.rgb, vOverlay.a);
	color *= vLightColor;
#ifdef SHADERS
	color.rgb = shaderLight(color.rgb, vPos, vNormal, vSky, false);
#endif
	outColor = apply_fog(color, vSph, vCyl);
}`;

// rendertype_end_portal.vsh / .fsh of the game (projection.glsl, matrix.glsl): layers of the end_portal texture
// projected in screen space over the end_sky texture, drifting with the game time.
const PORTAL_VS = `
layout(location = 0) in vec3 aPos;
uniform mat4 uViewProj;
out vec4 texProj0;
out float vSph;
out float vCyl;
void main() {
	gl_Position = uViewProj * vec4(aPos, 1.0);
	vec4 projection = gl_Position * 0.5;
	projection.xy = vec2(projection.x + projection.w, projection.y + projection.w);
	projection.zw = gl_Position.zw;
	texProj0 = projection;
	vSph = length(aPos);
	vCyl = max(length(aPos.xz), abs(aPos.y));
}`;

const PORTAL_FS = `
in vec4 texProj0;
in float vSph;
in float vCyl;
uniform sampler2D uSky;
uniform sampler2D uPortal;
uniform float uGameTime;
uniform int uLayers;
${FOG_GLSL}
const vec3 COLORS[16] = vec3[16](
	vec3(0.022087, 0.098399, 0.110818),
	vec3(0.011892, 0.095924, 0.089485),
	vec3(0.027636, 0.101689, 0.100326),
	vec3(0.046564, 0.109883, 0.114838),
	vec3(0.064901, 0.117696, 0.097189),
	vec3(0.063761, 0.086895, 0.123646),
	vec3(0.084817, 0.111994, 0.166380),
	vec3(0.097489, 0.154120, 0.091064),
	vec3(0.106152, 0.131144, 0.195191),
	vec3(0.097721, 0.110188, 0.187229),
	vec3(0.133516, 0.138278, 0.148582),
	vec3(0.070006, 0.243332, 0.235792),
	vec3(0.196766, 0.142899, 0.214696),
	vec3(0.047281, 0.315338, 0.321970),
	vec3(0.204675, 0.390010, 0.302066),
	vec3(0.080955, 0.314821, 0.661491)
);
const mat4 SCALE_TRANSLATE = mat4(
	0.5, 0.0, 0.0, 0.25,
	0.0, 0.5, 0.0, 0.25,
	0.0, 0.0, 1.0, 0.0,
	0.0, 0.0, 0.0, 1.0
);
mat2 mat2_rotate_z(float radians) {
	return mat2(cos(radians), -sin(radians), sin(radians), cos(radians));
}
mat4 end_portal_layer(float layer) {
	mat4 translate = mat4(
		1.0, 0.0, 0.0, 17.0 / layer,
		0.0, 1.0, 0.0, (2.0 + layer / 1.5) * (uGameTime * 1.5),
		0.0, 0.0, 1.0, 0.0,
		0.0, 0.0, 0.0, 1.0
	);
	mat2 rotate = mat2_rotate_z(radians((layer * layer * 4321.0 + layer * 9.0) * 2.0));
	mat2 scale = mat2((4.5 - layer / 4.0) * 2.0);
	return mat4(scale * rotate) * translate * SCALE_TRANSLATE;
}
out vec4 outColor;
void main() {
	vec3 color = textureProj(uSky, texProj0).rgb * COLORS[0];
	for (int i = 0; i < 16; i++) {
		if (i >= uLayers) break;
		color += textureProj(uPortal, texProj0 * end_portal_layer(float(i + 1))).rgb * COLORS[i];
	}
	outColor = apply_fog(vec4(color, 1.0), vSph, vCyl);
}`;

const DEPTH_VS = `
layout(location = 0) in vec3 aPos;
layout(location = 2) in vec2 aUv;
uniform mat4 uMatrix;
out vec2 vUv;
void main() {
	vUv = aUv;
	gl_Position = uMatrix * vec4(aPos, 1.0);
}`;

const DEPTH_FS = `
in vec2 vUv;
uniform sampler2D uTexture;
void main() {
	if (texture(uTexture, vUv).a < 0.1) discard;
}`;

const BLOB_VS = `
const vec2 C[4] = vec2[4](vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(1.0, 1.0), vec2(-1.0, 1.0));
uniform mat4 uViewProj;
uniform vec3 uCenter;
uniform float uRadius;
out vec2 vCorner;
out float vSph;
out float vCyl;
void main() {
	vCorner = C[gl_VertexID];
	vec3 p = uCenter + vec3(vCorner.x, 0.0, vCorner.y) * uRadius;
	vSph = length(p);
	vCyl = max(length(p.xz), abs(p.y));
	gl_Position = uViewProj * vec4(p, 1.0);
}`;

const BLOB_FS = `
in vec2 vCorner;
in float vSph;
in float vCyl;
uniform float uAlpha;
${FOG_GLSL}
out vec4 outColor;
void main() {
	float d = length(vCorner);
	if (d > 1.0) discard;
	float a = uAlpha * (1.0 - smoothstep(0.35, 1.0, d)) * (1.0 - total_fog_value(vSph, vCyl));
	outColor = vec4(0.0, 0.0, 0.0, a);
}`;

const LIGHT0 = normalize3([0.2, 1, -0.7]);
const LIGHT1 = normalize3([-0.2, 1, 0.7]);

function normalize3(v) {
	const l = Math.hypot(v[0], v[1], v[2]);
	return [v[0] / l, v[1] / l, v[2] / l];
}

function tokenSuffix(sep) {
	const token = new URLSearchParams(location.search).get('token');
	return token ? sep + 'token=' + encodeURIComponent(token) : '';
}

const strip = id => (id || '').replace(/^minecraft:/, '');
const titleCase = name => name.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

/** Direction.toYRot() */
const FACING_Y_ROT = { south: 0, west: 90, north: 180, east: 270 };

/** ARGB.scaleRGB */
function scaleRgb(color, factor) {
	return (Math.floor((color >> 16 & 255) * factor) << 16) | (Math.floor((color >> 8 & 255) * factor) << 8) | Math.floor((color & 255) * factor);
}

function hashColor(text) {
	let h = 0;
	for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
	return [((h >> 16) & 255) / 255 * 0.5 + 0.35, ((h >> 8) & 255) / 255 * 0.5 + 0.35, (h & 255) / 255 * 0.5 + 0.35, 1];
}

function normalizeSkin(image) {
	const canvas = document.createElement('canvas');
	canvas.width = 64;
	canvas.height = 64;
	const g = canvas.getContext('2d');
	g.drawImage(image, 0, 0);
	if (image.height === 32) {
		// Legacy 64x32 skins: the left limbs mirror the right ones.
		g.drawImage(image, 0, 16, 16, 16, 16, 48, 16, 16);
		g.drawImage(image, 40, 16, 16, 16, 32, 48, 16, 16);
	}
	return canvas;
}

const DEFAULT_SKINS = ['alex', 'ari', 'efe', 'kai', 'makena', 'noor', 'steve', 'sunny', 'zuri'];

/** DefaultPlayerSkin.get(uuid): one of the 18 default skins (slim ones first), picked by UUID.hashCode(). */
function defaultSkin(uuid) {
	let index = 6 + DEFAULT_SKINS.length; // wide Steve
	const hex = String(uuid || '').replace(/-/g, '');
	if (/^[0-9a-fA-F]{32}$/.test(hex)) {
		const bits = BigInt('0x' + hex.slice(0, 16)) ^ BigInt('0x' + hex.slice(16));
		const hash = Number(BigInt.asIntN(32, bits >> 32n) ^ BigInt.asIntN(32, bits));
		index = ((hash % 18) + 18) % 18;
	}
	const slim = index < DEFAULT_SKINS.length;
	return { path: 'player/' + (slim ? 'slim/' : 'wide/') + DEFAULT_SKINS[index % DEFAULT_SKINS.length], slim };
}

// Thrown items drawn as sprites (ThrownItemRenderer) and what item they show.
const THROWN = {
	snowball: 'snowball', egg: 'egg', blue_egg: 'blue_egg', brown_egg: 'brown_egg', ender_pearl: 'ender_pearl', potion: 'splash_potion',
	splash_potion: 'splash_potion', lingering_potion: 'lingering_potion', experience_bottle: 'experience_bottle',
	eye_of_ender: 'ender_eye', fireball: 'fire_charge', small_fireball: 'fire_charge', firework_rocket: 'firework_rocket',
	wind_charge: 'wind_charge', breeze_wind_charge: 'wind_charge',
};

export class EntityRenderer {
	constructor(renderer) {
		this.renderer = renderer;
		this.gl = renderer.gl;
		this.text = new TextRenderer(this.gl);
		this.library = new ModelLibrary();
		this.animator = new Animator(this.library);
		this.sink = new VertexSink();
		this.batches = [];
		this.textures = new Map();
		this.skins = new Map();
		this.capes = new Map();
		this.states = new Map();
		this.events = new Map();
		this.motion = new Map();
		this.itemMeshes = new Map();
		this.frames = [];
		this.offset = null;
		this.showLabels = true;
		this.showMobLabels = false;
		this.visibleCount = 0;
		this.bolts = [];
		this.shadows = [];
		this.programs = {};
		this.depthProgram = program(this.gl, DEPTH_VS, DEPTH_FS);
		this.blobProgram = program(this.gl, BLOB_VS, BLOB_FS);
		this.portalProgram = null;
		this.portals = { endPortal: [], endGateway: [] };
		const gl = this.gl;
		this.vao = gl.createVertexArray();
		this.vbo = gl.createBuffer();
		gl.bindVertexArray(this.vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
		const stride = FLOATS * 4;
		const attrib = (index, size, offset) => {
			gl.enableVertexAttribArray(index);
			gl.vertexAttribPointer(index, size, gl.FLOAT, false, stride, offset * 4);
		};
		attrib(0, 3, 0); attrib(1, 3, 3); attrib(2, 2, 6); attrib(3, 4, 8); attrib(4, 2, 12); attrib(5, 2, 14);
		gl.bindVertexArray(null);
		this.blobVao = gl.createVertexArray();
		this.white = this.createTexture(new ImageData(new Uint8ClampedArray([255, 255, 255, 255]), 1, 1));
	}

	entityProgram(shaders) {
		const key = shaders ? 'shaders' : 'vanilla';
		if (!this.programs[key]) this.programs[key] = program(this.gl, ENTITY_VS, ENTITY_FS, shaders ? '#define SHADERS 1' : '');
		return this.programs[key];
	}

	reset() {
		this.frames = [];
		this.offset = null;
		this.states.clear();
		this.events.clear();
		this.motion.clear();
	}

	setAssets(assets) {
		this.assets = assets;
		const query = tokenSuffix('?');
		fetch('/assets/entities.json' + query, { credentials: 'same-origin' })
			.then(r => (r.ok ? r.json() : []))
			.then(list => { this.entityList = new Set(list); })
			.catch(() => { this.entityList = new Set(); });
		fetch('/assets/names.json' + query, { credentials: 'same-origin' })
			.then(r => (r.ok ? r.json() : {}))
			.then(names => { this.names = names; })
			.catch(() => {});
		this.text.load(query);
		this.library.load(query).then(ok => {
			if (!ok) console.warn('CCTV: entity models unavailable, entities are drawn as boxes');
		});
	}

	createTexture(source) {
		const gl = this.gl;
		const texture = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
		return texture;
	}

	/** Texture below textures/entity (loaded once); null while loading or missing. */
	texture(path, folder = 'entity') {
		if (!path) return null;
		if (typeof path === 'object' && path.skin) return this.skin(path.skin).texture;
		if (typeof path === 'object' && path.cape) {
			const cape = this.cape(path.cape, path.name);
			if (cape.texture) return cape.texture;
			return cape.missing && path.fallback ? this.texture(path.fallback) : null;
		}
		const key = folder + '/' + path;
		let entry = this.textures.get(key);
		if (!entry) {
			entry = { texture: null };
			this.textures.set(key, entry);
			if (folder === 'entity' && this.entityList && this.entityList.size && !this.entityList.has(path)) {
				entry.failed = true;
				return null;
			}
			fetch('/assets/' + folder + '/' + path + '.png' + tokenSuffix('?'), { credentials: 'same-origin' })
				.then(r => { if (!r.ok) throw new Error('missing'); return r.blob(); })
				.then(blob => createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }))
				.then(image => {
					entry.texture = this.createTexture(image);
					entry.width = image.width;
					entry.height = image.height;
				})
				.catch(() => { entry.failed = true; });
		}
		return entry.texture;
	}

	/** Player cape from their Mojang profile: {texture (null while loading or without a cape), missing}. */
	cape(uuid, name) {
		let cape = this.capes.get(uuid);
		if (cape) return cape;
		cape = { texture: null, missing: false };
		this.capes.set(uuid, cape);
		fetch('/cape/' + encodeURIComponent(uuid) + '?name=' + encodeURIComponent(name || '') + tokenSuffix('&'), { credentials: 'same-origin' })
			.then(response => { if (!response.ok) throw new Error('no cape'); return response.blob(); })
			.then(blob => createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }))
			.then(image => { cape.texture = this.createTexture(image); })
			.catch(() => { cape.missing = true; });
		return cape;
	}

	/** Player skin: {texture (null while loading), slim}. Without a custom skin, the game's default skin for the UUID. */
	skin(uuid, name) {
		let skin = this.skins.get(uuid);
		if (skin) {
			if (skin.fallback && !skin.texture) skin.texture = this.texture(skin.fallback);
			return skin;
		}
		skin = { texture: null, slim: false };
		this.skins.set(uuid, skin);
		const useDefault = () => {
			const fallback = defaultSkin(uuid);
			skin.slim = fallback.slim;
			skin.fallback = fallback.path;
			skin.texture = this.texture(fallback.path);
		};
		const url = '/skin/' + encodeURIComponent(uuid) + '?name=' + encodeURIComponent(name || '') + tokenSuffix('&');
		fetch(url, { credentials: 'same-origin' })
			.then(response => {
				if (!response.ok) throw new Error('no skin');
				skin.slim = response.headers.get('X-Skin-Model') === 'slim';
				return response.blob();
			})
			.then(blob => createImageBitmap(blob))
			.then(image => { skin.texture = this.createTexture(normalizeSkin(image)); })
			.catch(useDefault);
		return skin;
	}

	// --- snapshots -------------------------------------------------------------------------------

	/** Called for every "entities" message. */
	push(frame, entityTicks) {
		const now = performance.now();
		const sample = now - frame.t * 50;
		// Track the smallest network delay seen, slowly relaxing so server lag is followed.
		this.offset = this.offset === null ? sample : Math.min(sample, this.offset + (sample - this.offset) * 0.02 + 0.05);
		const map = new Map();
		for (const e of frame.e) {
			map.set(e.id, e);
			// Running AnimationStates as start ticks (entity tickCount).
			if (e.anim) {
				e.animStart = {};
				for (const [name, millis] of Object.entries(e.anim)) e.animStart[name] = (e.age || 0) - millis / 50;
			}
			// Entity events are queued, not read from the drawn frame: rendering skips frames when it runs
			// slower than the server's 20 frames per second, the events must not be lost with them.
			if (e.ev && CLIENT[strip(e.type)] && CLIENT[strip(e.type)].event) {
				let queue = this.events.get(e.id);
				if (!queue) this.events.set(e.id, queue = []);
				queue.push({ t: frame.t, age: e.age || 0, ids: e.ev });
				if (queue.length > 16) queue.shift();
			}
		}
		this.animateMotion(frame.t, map);
		this.frames.push({ t: frame.t, map });
		while (this.frames.length > 40) this.frames.shift();
		this.delayTicks = Math.max(2, entityTicks * 2);
	}

	/**
	 * Players (and mobs they steer) are moved by their own game client, so the server never updates their walk
	 * animation or turns their body towards the movement. Like the game client does for other players
	 * (RemotePlayer: LivingEntity.tick body rotation, calculateEntityAnimation), both are derived from the motion.
	 */
	animateMotion(tick, map) {
		for (const e of map.values()) {
			const player = e.type === 'minecraft:player';
			if (!player && !e.steered) continue;
			let m = this.motion.get(e.id);
			const ticks = m ? tick - m.t : 0;
			if (!m || ticks <= 0 || ticks > 40) {
				m = { t: tick, x: e.x, z: e.z, position: 0, speed: 0, body: e.yaw || 0, swim: e.pose === 'swimming' ? 1 : 0, flying: 0 };
				this.motion.set(e.id, m);
			} else {
				const dx = (e.x - m.x) / ticks, dz = (e.z - m.z) / ticks;
				const moved = dx * dx + dz * dz;
				for (let i = 0; i < ticks; i++) {
					// WalkAnimationState.update(min(distance * 4, 1), 0.4, baby ? 3 : 1)
					if (e.riding || e.dead) {
						m.speed = 0;
						m.position = 0;
					} else {
						m.speed += (Math.min(Math.sqrt(moved) * 4, 1) - m.speed) * 0.4;
						m.position += m.speed;
					}
					if (player) {
						let target = m.body;
						if (moved > 0.0025000002) {
							const heading = Math.atan2(dz, dx) * 180 / Math.PI - 90;
							const away = Math.abs(wrapDegrees(e.yaw) - heading);
							target = away > 95 && away < 265 ? heading - 180 : heading;
						}
						if (e.swing) target = e.yaw;
						// tickHeadTurn: ease towards the target, never more than 50 degrees away from the head.
						m.body += wrapDegrees(target - m.body) * 0.3;
						const head = wrapDegrees(e.yaw - m.body);
						if (Math.abs(head) > 50) m.body += head - Math.sign(head) * 50;
						m.body = wrapDegrees(m.body);
						// Player.updateSwimAmount, fall flying time
						m.swim = e.pose === 'swimming' ? Math.min(1, m.swim + 0.09) : Math.max(0, m.swim - 0.09);
						m.flying = e.pose === 'fall_flying' ? m.flying + 1 : 0;
					}
				}
				m.t = tick;
				m.x = e.x;
				m.z = e.z;
			}
			const scale = e.baby ? 3 : 1;
			e.walk = m.position * scale;
			e.walkSpeed = m.speed;
			if (player) {
				e.body = m.body;
				e.head = e.yaw;
				e.swimAmount = m.swim;
				e.flyingTicks = m.flying;
			} else {
				// AbstractHorse / Pig tickRidden: the body follows the rider's look.
				e.body = e.head = e.yaw;
			}
		}
		if (this.motion.size > map.size) {
			for (const id of this.motion.keys()) if (!map.has(id)) this.motion.delete(id);
		}
	}

	/** Entities interpolated for the current moment. */
	sample(now) {
		const frames = this.frames;
		if (frames.length === 0) return [];
		const renderTick = (now - this.offset) / 50 - this.delayTicks;
		let a = frames[0], b = frames[0];
		for (let i = frames.length - 1; i >= 0; i--) {
			if (frames[i].t <= renderTick) {
				a = frames[i];
				b = frames[Math.min(i + 1, frames.length - 1)];
				break;
			}
		}
		if (renderTick > frames[frames.length - 1].t) a = b = frames[frames.length - 1];
		const span = b.t - a.t;
		const t = span > 0 ? Math.max(0, Math.min(1, (renderTick - a.t) / span)) : 0;
		this.tick = lerp(a.t, b.t, t);

		const result = [];
		for (const [id, ea] of a.map) {
			const eb = b.map.get(id);
			if (!eb) {
				if (t < 1 || a === b) result.push(ea);
				continue;
			}
			const angle = (key, fallback) => (ea[key] !== undefined && eb[key] !== undefined ? lerpAngle(ea[key], eb[key], t) : (eb[key] ?? fallback));
			const num = key => (ea[key] !== undefined && eb[key] !== undefined ? lerp(ea[key], eb[key], t) : eb[key]);
			result.push({
				...eb,
				x: lerp(ea.x, eb.x, t), y: lerp(ea.y, eb.y, t), z: lerp(ea.z, eb.z, t),
				yaw: angle('yaw'), pitch: lerp(ea.pitch, eb.pitch, t), body: angle('body'), head: angle('head'),
				walk: num('walk'), walkSpeed: num('walkSpeed'), age: num('age'), deathTime: num('deathTime'),
				swimAmount: num('swimAmount'), flyingTicks: num('flyingTicks'),
			});
		}
		for (const [id, eb] of b.map) {
			if (!a.map.has(id) && t > 0) result.push(eb);
		}
		return result;
	}

	/** Swing and hurt timers kept per entity. */
	animState(e, now) {
		let s = this.states.get(e.id);
		if (!s) {
			s = { swingStart: -1, seen: now, lastWalk: e.walk || 0 };
			this.states.set(e.id, s);
		}
		s.seen = now;
		if (e.swing && (s.swingStart < 0 || now - s.swingStart > 300)) s.swingStart = now;
		s.attack = s.swingStart >= 0 && now - s.swingStart < 300 ? (now - s.swingStart) / 300 : 0;
		return s;
	}

	/** The entity's AnimationStates: the server's plus the ones the ported client code (mobs.js CLIENT) runs. */
	keyframeStates(type, e, s) {
		const states = s.keyframes || (s.keyframes = new AnimationStates());
		states.sync(e.animStart);
		const client = CLIENT[type];
		if (!client) return states;
		const tick = Math.floor(e.age || 0);
		const queue = this.events.get(e.id);
		if (queue) {
			// Events of the frames the (delayed) render time has reached, at the entity age they happened;
			// the ones of an entity that was not drawn for a while are dropped.
			while (queue.length && queue[0].t <= this.tick + 1e-3) {
				const event = queue.shift();
				if (this.tick - event.t < 40) for (const id of event.ids) client.event(e, states, id, Math.floor(event.age));
			}
			if (!queue.length) this.events.delete(e.id);
		}
		if (client.tick) {
			if (states.lastTick === null || tick < states.lastTick || tick - states.lastTick > 40) states.lastTick = tick - 1;
			while (states.lastTick < tick) client.tick(e, states, ++states.lastTick);
		}
		return states;
	}

	cleanupStates(now) {
		for (const [id, queue] of this.events) if (!queue.length || this.tick - queue[queue.length - 1].t > 200) this.events.delete(id);
		if (this.states.size < 64) return;
		for (const [id, s] of this.states) if (now - s.seen > 5000) this.states.delete(id);
	}

	// --- building the frame ------------------------------------------------------------------------

	begin() {
		this.sink.reset();
		this.batches = [];
	}

	/** Records that the vertices emitted since `start` use this texture / mode. */
	batch(texture, mode, start, cull = true) {
		const count = this.sink.count - start;
		if (count <= 0) return;
		const last = this.batches[this.batches.length - 1];
		if (last && last.texture === texture && last.mode === mode && last.cull === cull && last.start + last.count === start) {
			last.count += count;
			return;
		}
		this.batches.push({ texture, mode, start, count, cull });
	}

	/**
	 * Builds all entity geometry for this frame (camera relative).
	 * frame: {origin, camPos, frustum, now, fogEnd}; world: World; env: Environment
	 */
	prepare(frame, list, world, env) {
		this.begin();
		this.world = world;
		this.env = env;
		this.bolts = [];
		this.shadows = [];
		const now = frame.now;
		const o = frame.origin, cam = frame.camPos;
		let visible = 0;
		for (const e of list) {
			const rx = e.x - o[0] - cam[0], ry = e.y - o[1] - cam[1], rz = e.z - o[2] - cam[2];
			const type = strip(e.type);
			if (type === 'lightning_bolt') {
				this.bolts.push({ x: rx, y: ry, z: rz, seed: e.seed || '0' });
				continue;
			}
			// Invisible mobs still show their equipment (and flames); other invisible entities show nothing.
			if (e.invisible && !e.burning && !isKnownMob(type)) continue;
			const radius = Math.max(e.w || 1, e.h || 1) + 1;
			if (!frame.frustum(rx, ry + (e.h || 1) / 2, rz, radius * (type === 'happy_ghast' || type === 'ghast' ? 2 : 1))) continue;
			if (Math.hypot(rx, rz) > frame.fogEnd + 8) continue;
			visible++;
			const light = this.lightFor(e, world);
			try {
				if (!e.invisible || isKnownMob(type)) this.drawEntity(e, type, [rx, ry, rz], light, now, world);
				// EntityRenderer.submit: burning entities (invisible ones too) are wrapped in flames.
				if (e.burning) this.drawFlame(e, [rx, ry, rz], light, frame.viewRotation);
			} catch (error) {
				console.warn('CCTV: could not draw', e.type, error);
			}
		}
		this.visibleCount = visible;
		const view = frame.viewRotation;
		this.text.begin();
		this.text.nameTags(this.collectNameTags(frame, list, world), [view[0], view[4], view[8]], [view[1], view[5], view[9]]);
		this.addSignText(frame, world);
		this.text.finish();
		if (this.assets) this.prepareBlockEntities(frame, world);
		this.upload();
		this.cleanupStates(now);
	}

	/**
	 * FlameFeatureRenderer: layers of the fire_0 / fire_1 block sprites (animated in the block atlas) facing the
	 * camera, 1.4 times the entity's width, stacked 0.45 apart up to its height, each narrower and further back.
	 */
	drawFlame(e, pos, light, view) {
		if (!this.assets || !this.assets.texture) return;
		const fire = [this.assets.sprite('minecraft:block/fire_0'), this.assets.sprite('minecraft:block/fire_1')];
		const s = (e.w || 0.6) * 1.4;
		let h = (e.h || 1.8) / s;
		// pose: entity position, scale, camera orientation (right, up, towards the camera), then 0.3 towards the camera
		const right = [view[0], view[4], view[8]], up = [view[1], view[5], view[9]], back = [view[2], view[6], view[10]];
		const m = mat4();
		for (let i = 0; i < 3; i++) {
			m[i] = right[i] * s; m[4 + i] = up[i] * s; m[8 + i] = back[i] * s;
			m[12 + i] = pos[i] + back[i] * s * (0.3 - Math.trunc(h) * 0.02);
		}
		const quads = [];
		let r = 0.5, yo = 0, zo = 0;
		for (let ss = 0; h > 0; ss++) {
			const tex = fire[ss % 2];
			let u0 = tex.u0, u1 = tex.u1;
			const v0 = tex.v0, v1 = tex.v1;
			if (Math.floor(ss / 2) % 2 === 0) [u0, u1] = [u1, u0];
			quads.push(-r, -yo, zo, u1, v1, r, -yo, zo, u0, v1, r, 1.4 - yo, zo, u0, v0, -r, 1.4 - yo, zo, u1, v0);
			h -= 0.45; yo -= 0.45; r *= 0.9; zo -= 0.03;
		}
		const start = this.sink.count;
		this.sink.ensure(quads.length / 20 * 6);
		// LightCoordsUtil.withBlock(light, 15)
		emitQuads(this.sink, quads, m, { color: [1, 1, 1, 1], light: [240, light[1]], overlay: [0, 0] });
		// fireVertex: setNormal(pose, 0, 1, 0), the camera's up
		const out = this.sink.data;
		for (let v = start; v < this.sink.count; v++) {
			const o = v * FLOATS;
			out[o + 3] = up[0]; out[o + 4] = up[1]; out[o + 5] = up[2];
		}
		this.batch(this.assets.texture, MODE_CUTOUT, start, false);
	}

	/** Packed light at the entity's eyes (EntityRenderer.getPackedLightCoords), in smooth units. */
	lightFor(e, world) {
		const eye = (e.h || 1) * 0.85;
		const [sky, block] = world.lightAt(Math.floor(e.x), Math.floor(e.y + eye), Math.floor(e.z));
		return [(e.burning ? 15 : block) * 16, sky * 16];
	}

	upload() {
		const gl = this.gl;
		gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
		gl.bufferData(gl.ARRAY_BUFFER, this.sink.data.subarray(0, this.sink.count * FLOATS), gl.STREAM_DRAW);
	}

	drawEntity(e, type, pos, light, now, world) {
		const style = { color: [1, 1, 1, 1], light, overlay: [e.hurt || e.dead ? 1 : 0, 0] };
		switch (type) {
			case 'item': return this.drawDroppedItem(e, pos, style);
			case 'experience_orb': return this.drawOrb(e, pos, style, now);
			case 'arrow': case 'spectral_arrow': return this.drawProjectile(e, pos, style, 'arrow#main', type === 'spectral_arrow' ? 'projectiles/arrow_spectral' : 'projectiles/arrow', -90, 0);
			case 'trident': return this.drawProjectile(e, pos, style, 'trident#main', 'trident/trident', -90, 90);
			case 'tnt': return this.drawBlockEntity(e, pos, style, 'minecraft:tnt', 1);
			case 'falling_block': return this.drawFallingBlock(e, pos, style, world);
			case 'painting': return this.drawPainting(e, pos, style);
			case 'item_frame': case 'glow_item_frame': return this.drawItemFrame(e, type, pos, style);
			case 'leash_knot': return this.drawSimple(pos, style, 'leash_knot#main', 'lead_knot/lead_knot', 0);
			case 'end_crystal': return this.drawEndCrystal(e, pos, style);
			case 'wither_skull': return this.drawSimple(pos, style, 'wither_skull#main', 'wither/wither', e.yaw);
			case 'shulker_bullet': return this.drawSimple(pos, { ...style, light: [240, 240] }, 'shulker_bullet#main', 'shulker/spark', now / 50 * 9);
			case 'llama_spit': return this.drawSimple(pos, style, 'llama_spit#main', 'llama/llama_spit', e.yaw);
			default: break;
		}
		if (THROWN[type]) return this.drawThrown(pos, style, THROWN[type]);
		if (type.endsWith('_boat') || type.endsWith('_raft')) return this.drawBoat(e, type, pos, style);
		if (type === 'minecart' || type.endsWith('_minecart')) return this.drawMinecart(e, type, pos, style);

		if (type === 'player') {
			const skin = this.skin(e.uuid, e.name);
			e.slim = skin.slim;
		}
		const mob = describeMob(e);
		if (!mob || !this.library.layers) return this.drawBox(e, pos, style);
		if (mob.special === 'endCrystal') return this.drawEndCrystal(e, pos, style);
		const s = this.animState(e, now);
		const def = mob.def;
		const age = e.age || 0;
		const anim = {
			walk: e.walk || 0,
			walkSpeed: Math.min(1, e.walkSpeed || 0),
			age,
			attack: s.attack,
			netHeadYaw: wrapDegrees((e.head ?? e.yaw) - (e.body ?? e.yaw)),
			headPitch: e.pitch || 0,
			flap: e.id * 3 + age,
			swimAmount: e.swimAmount || 0,
		};
		anim.states = this.keyframeStates(type, e, s);
		anim.memory = anim.states.memory;
		if (def.fullBright) style.light = [240, style.light[1]];

		// LivingEntityRenderer.submit / setupRotations
		const m = mat4();
		translate(m, pos[0], pos[1], pos[2]);
		// AvatarRenderer.getRenderOffset: crouching players sit 2 pixels lower.
		if (type === 'player' && (e.sneak || e.pose === 'crouching')) translate(m, 0, -2 / 16 * (e.scale || 1), 0);
		const entityScale = e.scale || 1;
		scale(m, entityScale);
		const body = e.body ?? e.yaw ?? 0;
		if (def.squid) {
			translate(m, 0, e.baby ? 0.25 : 0.5, 0);
			rotate(m, 1, (180 - body) * DEG);
			translate(m, 0, e.baby ? -0.6 : -1.2, 0);
		} else if (e.pose !== 'sleeping') {
			rotate(m, 1, (180 - body) * DEG);
			if (type === 'player') this.avatarRotations(e, m, world, anim);
		}
		if (e.dead && e.deathTime > 0) {
			const fall = Math.min(1, Math.sqrt(Math.max(0, (e.deathTime - 1) / 20 * 1.6)));
			rotate(m, 2, fall * 90 * DEG);
		} else if (e.pose === 'sleeping') {
			rotate(m, 2, 90 * DEG);
			rotate(m, 1, 270 * DEG);
		} else if (e.name === 'Dinnerbone' || e.name === 'Grumm') {
			translate(m, 0, ((e.h || 1) + 0.1) / entityScale, 0);
			rotate(m, 2, Math.PI);
		}
		if (def.walkRoll && anim.walkSpeed >= 0.01) {
			// IronGolemRenderer.setupRotations: the golem rocks from side to side while walking.
			const wave = (Math.abs((anim.walk + 6) % 13 - 6.5) - 3.25) / 3.25;
			rotate(m, 2, 6.5 * wave * DEG);
		}
		if (def.fish) {
			const inWater = world.infoAt(Math.floor(e.x), Math.floor(e.y + 0.1), Math.floor(e.z));
			rotate(m, 1, 4.3 * Math.sin(0.6 * age) * DEG);
			if (!(inWater && inWater.water)) {
				translate(m, 0.2, 0.1, 0);
				rotate(m, 2, 90 * DEG);
			}
		}
		if (def.puffer) translate(m, 0, Math.cos(age * 0.05) * 0.08, 0);
		if (def.phantom) rotate(m, 0, (e.pitch || 0) * DEG);
		scale(m, -1, -1, 1);
		// Renderer specific scale()
		if (def.creeper && e.d && e.d.swelling) {
			let g = e.d.swelling;
			const wobble = 1 + Math.sin(g * 100) * g * 0.01;
			g = Math.min(1, Math.max(0, g));
			g = g * g * g * g;
			scale(m, (1 + g * 0.4) * wobble, (1 + g * 0.1) / wobble, (1 + g * 0.4) * wobble);
			const step = e.d.swelling;
			style.overlay[1] = Math.floor(step * 10) % 2 === 0 ? 0 : Math.min(1, Math.max(0.5, step));
		}
		if (def.slime) {
			const size = Number(e.d && e.d.size) || 1;
			scale(m, 0.999);
			translate(m, 0, 0.001, 0);
			scale(m, size);
		}
		if (def.phantom) {
			const size = Number(e.d && e.d.size) || 0;
			scale(m, 1 + 0.15 * size);
			translate(m, 0, 1.3125, 0.1875);
		}
		if (def.wither) {
			const invulnerable = Number(e.d && e.d.invulnerable) || 0;
			scale(m, 2 - (invulnerable > 0 ? invulnerable / 220 * 0.5 : 0));
		}
		translate(m, 0, -1.501, 0);

		let base = null;
		anim.tint = null;
		for (const layer of mob.layers) {
			const model = this.library.get(layer.layer);
			if (!model) continue;
			const texture = this.texture(layer.texture);
			if (!texture) continue;
			model.reset();
			anim.k = this.animator.bind(model.parts, anim.states, age);
			anim.isBase = !base;
			if (base && model !== base) {
				mob.anim(model.parts, anim, e);
				model.copyPose(base);
			} else {
				mob.anim(model.parts, anim, e);
			}
			equipmentPose(model.parts, e, anim);
			if (!base) base = model;
			// LivingEntityRenderer: an invisible mob's body is not drawn, its equipment layers are.
			if (e.invisible && !layer.equipment) continue;
			const start = this.sink.count;
			// getModelTint (e.g. a wet wolf) tints the entity's own model, not the layers drawn over it.
			const color = layer.color || (model === base && layer === mob.layers[0] && anim.tint) || [1, 1, 1, 1];
			let lm = m;
			if (layer.offset) {
				// the layer's own poseStack.translate (a cape over a chestplate, elytra)
				lm = Float32Array.from(m);
				translate(lm, layer.offset[0], layer.offset[1], layer.offset[2]);
			}
			emitModel(this.sink, model, lm, { ...style, color });
			const mode = MODES[layer.mode] ?? MODE_CUTOUT;
			this.batch(texture, mode, start, mode !== MODE_NOCULL && mode !== MODE_TRANSLUCENT);
		}
		if (!base) return this.drawBox(e, pos, style);

		// Held items (ItemInHandLayer).
		if (e.hand && base.parts.right_arm && base.parts.right_arm.visible) this.drawHeld(base, m, 'right_arm', e.hand, style, 1);
		if (e.offhand && base.parts.left_arm && base.parts.left_arm.visible) this.drawHeld(base, m, 'left_arm', e.offhand, style, -1);

		// EntityRenderDispatcher: no shadow under invisible entities
		if (!e.invisible) this.shadowFor(e, pos, typeof mob.shadow === 'number' ? mob.shadow * entityScale : 0.5, world);
	}

	/** AvatarRenderer.setupRotations: players lie down while swimming, crawling and gliding with elytra. */
	avatarRotations(e, m, world, anim) {
		const pitch = e.pitch || 0;
		if (e.pose === 'fall_flying') {
			const t = e.flyingTicks || 0;
			rotate(m, 0, Math.min(1, t * t / 100) * (-90 - pitch) * DEG);
		} else if (anim.swimAmount > 0) {
			const info = world.infoAt(Math.floor(e.x), Math.floor(e.y + 0.5), Math.floor(e.z));
			const inWater = !!(info && info.water);
			rotate(m, 0, lerp(0, inWater ? -90 - pitch : -90, anim.swimAmount) * DEG);
			if (e.pose === 'swimming') translate(m, 0, -1, 0.3);
		}
	}

	/** Round shadow on the first solid block below, fading with height (EntityRenderer shadow). */
	shadowFor(e, pos, radius, world) {
		if (!radius) return;
		const fx = Math.floor(e.x), fz = Math.floor(e.z);
		for (let y = Math.floor(e.y + 0.01); y >= Math.floor(e.y) - 2; y--) {
			const info = world.infoAt(fx, y - 1, fz);
			if (info && info.fullCollision) {
				const height = e.y - y;
				const alpha = 0.5 * Math.max(0, 1 - height / 2.5);
				if (alpha > 0.02) this.shadows.push({ center: [pos[0], pos[1] - height + 0.002, pos[2]], radius: Math.min(32, radius), alpha });
				return;
			}
		}
	}

	drawBox(e, pos, style) {
		// Unknown entity: its hitbox as a plain box, so it is at least visible.
		const w = (e.w || 0.6) / 2, h = e.h || 0.6;
		const q = [];
		const corners = [[-w, 0, -w], [w, 0, -w], [w, h, -w], [-w, h, -w], [-w, 0, w], [w, 0, w], [w, h, w], [-w, h, w]];
		const faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 4, 7, 3], [1, 2, 6, 5], [3, 7, 6, 2], [0, 1, 5, 4]];
		for (const f of faces) for (const i of f) q.push(...corners[i], 0.5, 0.5);
		const m = mat4();
		translate(m, pos[0], pos[1], pos[2]);
		const start = this.sink.count;
		this.sink.ensure(36);
		emitQuads(this.sink, new Float32Array(q), m, { ...style, color: hashColor(e.type) });
		this.batch(this.white, MODE_CUTOUT, start);
	}

	drawSimple(pos, style, layer, texturePath, yaw) {
		const model = this.library.get('minecraft:' + layer);
		const texture = this.texture(texturePath);
		if (!model || !texture) return;
		model.reset();
		const m = mat4();
		translate(m, pos[0], pos[1], pos[2]);
		rotate(m, 1, -(yaw || 0) * DEG);
		scale(m, -1, -1, 1);
		const start = this.sink.count;
		emitModel(this.sink, model, m, style);
		this.batch(texture, MODE_CUTOUT, start);
	}

	drawProjectile(e, pos, style, layer, texturePath, yawOffset, pitchOffset) {
		const model = this.library.get('minecraft:' + layer);
		const texture = this.texture(texturePath);
		if (!model || !texture) return;
		model.reset();
		const m = mat4();
		translate(m, pos[0], pos[1], pos[2]);
		rotate(m, 1, ((e.yaw || 0) + yawOffset) * DEG);
		rotate(m, 2, ((e.pitch || 0) + pitchOffset) * DEG);
		const start = this.sink.count;
		emitModel(this.sink, model, m, style);
		this.batch(texture, MODE_NOCULL, start, false);
	}

	drawBoat(e, type, pos, style) {
		const chest = type.includes('_chest_');
		const wood = type.replace(/_chest_(boat|raft)$/, '').replace(/_(boat|raft)$/, '');
		const folder = chest ? 'chest_boat' : 'boat';
		const model = this.library.get('minecraft:' + folder + '/' + wood + '#main');
		const texture = this.texture(folder + '/' + wood);
		if (!model || !texture) return this.drawBox(e, pos, style);
		model.reset();
		const m = mat4();
		translate(m, pos[0], pos[1] + 0.375, pos[2]);
		rotate(m, 1, (180 - (e.yaw || 0)) * DEG);
		scale(m, -1, -1, 1);
		rotate(m, 1, 90 * DEG);
		const start = this.sink.count;
		emitModel(this.sink, model, m, style);
		this.batch(texture, MODE_CUTOUT, start);
		this.shadowFor(e, pos, 0.8, this.world);
	}

	drawMinecart(e, type, pos, style) {
		const layer = type === 'minecart' ? 'minecart#main' : type + '#main';
		const model = this.library.get('minecraft:' + layer) || this.library.get('minecraft:minecart#main');
		const texture = this.texture('minecart/minecart');
		if (!model || !texture) return this.drawBox(e, pos, style);
		model.reset();
		const m = mat4();
		translate(m, pos[0], pos[1] + 0.375, pos[2]);
		rotate(m, 1, (180 - (e.yaw || 0)) * DEG);
		rotate(m, 2, -(e.pitch || 0) * DEG);
		const inside = { chest_minecart: 'minecraft:chest', furnace_minecart: 'minecraft:furnace', tnt_minecart: 'minecraft:tnt', hopper_minecart: 'minecraft:hopper', spawner_minecart: 'minecraft:spawner', command_block_minecart: 'minecraft:command_block' }[type];
		if (inside) {
			const b = new Float32Array(m);
			scale(b, 0.75);
			translate(b, -0.5, (6 - 8) / 16, 0.5);
			rotate(b, 1, 90 * DEG);
			this.emitBlock(inside === 'minecraft:chest' ? null : inside, b, style, inside === 'minecraft:chest');
		}
		scale(m, -1, -1, 1);
		const start = this.sink.count;
		emitModel(this.sink, model, m, style);
		this.batch(texture, MODE_CUTOUT, start);
	}

	drawEndCrystal(e, pos, style) {
		const model = this.library.get('minecraft:end_crystal#main');
		const texture = this.texture('end_crystal/end_crystal');
		if (!model || !texture) return this.drawBox(e, pos, style);
		model.reset();
		const t = (e.age || 0);
		const p = model.parts;
		const spin = t * 3 * DEG;
		const bob = Math.sin(t * 0.2) / 2 + 0.5;
		const y = (bob * bob + bob) * 0.4 - 1.4;
		if (p.outer_glass) { p.outer_glass.y += y * 16 * -1; p.outer_glass.yRot = spin; }
		if (p.inner_glass) { p.inner_glass.yRot = spin; }
		if (p.cube) { p.cube.yRot = spin; }
		const m = mat4();
		translate(m, pos[0], pos[1], pos[2]);
		scale(m, 2);
		translate(m, 0, -0.5, 0);
		scale(m, -1, -1, 1);
		const start = this.sink.count;
		emitModel(this.sink, model, m, { ...style, light: [240, 240] });
		this.batch(texture, MODE_NOCULL, start, false);
	}

	drawPainting(e, pos, style) {
		const d = e.d || {};
		const asset = strip(d.asset || d.variant);
		const w = Number(d.pw) || 1, h = Number(d.ph) || 1;
		const front = asset ? this.texture(asset, 'painting') : null;
		if (!front) return;
		const angle = { south: 0, west: -90, north: 180, east: 90 }[d.facing || 'south'] ?? 0;
		const m = mat4();
		translate(m, pos[0], pos[1], pos[2]);
		rotate(m, 1, angle * DEG);
		const z = 1 / 32;
		const quad = new Float32Array([
			-w / 2, -h / 2, z, 0, 1, w / 2, -h / 2, z, 1, 1,
			w / 2, h / 2, z, 1, 0, -w / 2, h / 2, z, 0, 0,
		]);
		const start = this.sink.count;
		this.sink.ensure(6);
		emitQuads(this.sink, quad, m, style);
		this.batch(front, MODE_CUTOUT, start);
	}

	// --- items -------------------------------------------------------------------------------------

	/** Item geometry in item model space (0..1 box): extruded sprite, or a block model. Cached. */
	itemMesh(itemId) {
		if (!this.assets || !itemId) return null;
		let mesh = this.itemMeshes.get(itemId);
		if (mesh !== undefined) return mesh;
		mesh = null;
		const id = itemId.includes(':') ? itemId : 'minecraft:' + itemId;
		const colon = id.indexOf(':');
		const ns = id.slice(0, colon), name = id.slice(colon + 1);
		const models = this.assets.models;
		const sprite = this.assets.sprites.get(ns + ':item/' + name);
		if (sprite) {
			mesh = { kind: 'sprite', quads: this.extrude(sprite) };
		} else if (models && this.assets.bundle.blockstates[id]) {
			const dispatch = models.dispatch(id, { __item: true });
			if (dispatch) {
				const parts = [];
				const random = new JavaRandom();
				random.setSeedNumber(42);
				collectParts(dispatch, random, parts);
				const quads = [];
				for (const part of parts) {
					for (const list of part.quads) {
						for (const q of list) {
							const tint = q.tint >= 0 ? this.itemTint(name) : [1, 1, 1];
							quads.push({ q, tint });
						}
					}
				}
				if (quads.length) mesh = { kind: 'block', quads: this.blockQuads(quads) };
			}
		}
		this.itemMeshes.set(itemId, mesh);
		return mesh;
	}

	itemTint(name) {
		const grass = this.assets.colormap('grass', 0.5, 1.0, 0x7cbd6b);
		const foliage = this.assets.colormap('foliage', 0.5, 1.0, 0x48b518);
		const c = /leaves|vine/.test(name) ? (name.startsWith('spruce') ? 0x619961 : name.startsWith('birch') ? 0x80a755 : foliage) : grass;
		return [(c >> 16 & 255) / 255, (c >> 8 & 255) / 255, (c & 255) / 255];
	}

	/** Block model quads as {data: Float32Array (x y z u v per vertex), tints}. */
	blockQuads(list) {
		const data = new Float32Array(list.length * 20);
		const tints = [];
		list.forEach(({ q, tint }, i) => {
			for (let k = 0; k < 4; k++) {
				data.set([q.pos[k * 3], q.pos[k * 3 + 1], q.pos[k * 3 + 2], q.uvs[k * 2], q.uvs[k * 2 + 1]], i * 20 + k * 5);
			}
			tints.push(tint);
		});
		return { data, tints };
	}

	/** ItemModelGenerator: front and back faces plus side faces along the sprite's opaque pixel edges. */
	extrude(sprite) {
		const size = this.assets.cell;
		const atlas = this.assets.atlasPixels;
		const w = this.assets.atlasSize;
		const alpha = (x, y) => (x < 0 || y < 0 || x >= size || y >= size ? 0 : atlas[((sprite.y + y) * w + sprite.x + x) * 4 + 3]);
		const quads = [];
		const u = x => sprite.u0 + (sprite.u1 - sprite.u0) * x / size;
		const v = y => sprite.v0 + (sprite.v1 - sprite.v0) * y / size;
		const z0 = 7.5 / 16, z1 = 8.5 / 16;
		// Front (+z) and back (-z) of the whole sprite; transparent pixels are cut out by the shader.
		quads.push([0, 0, z1, u(0), v(size)], [1, 0, z1, u(size), v(size)], [1, 1, z1, u(size), v(0)], [0, 1, z1, u(0), v(0)]);
		quads.push([1, 0, z0, u(size), v(size)], [0, 0, z0, u(0), v(size)], [0, 1, z0, u(0), v(0)], [1, 1, z0, u(size), v(0)]);
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				if (alpha(x, y) === 0) continue;
				const x0 = x / size, x1 = (x + 1) / size, yb = 1 - (y + 1) / size, yt = 1 - y / size;
				const pu = u(x + 0.5), pv = v(y + 0.5);
				if (alpha(x, y - 1) === 0) quads.push([x0, yt, z0, pu, pv], [x0, yt, z1, pu, pv], [x1, yt, z1, pu, pv], [x1, yt, z0, pu, pv]);
				if (alpha(x, y + 1) === 0) quads.push([x0, yb, z1, pu, pv], [x0, yb, z0, pu, pv], [x1, yb, z0, pu, pv], [x1, yb, z1, pu, pv]);
				if (alpha(x - 1, y) === 0) quads.push([x0, yb, z0, pu, pv], [x0, yb, z1, pu, pv], [x0, yt, z1, pu, pv], [x0, yt, z0, pu, pv]);
				if (alpha(x + 1, y) === 0) quads.push([x1, yb, z1, pu, pv], [x1, yb, z0, pu, pv], [x1, yt, z0, pu, pv], [x1, yt, z1, pu, pv]);
			}
		}
		const data = new Float32Array(quads.length * 5);
		quads.forEach((p, i) => data.set(p, i * 5));
		return { data, tints: null };
	}

	/** Emits an item mesh with the given transform (model space 0..1). */
	emitItem(mesh, m, style) {
		const start = this.sink.count;
		const data = mesh.quads.data;
		this.sink.ensure(data.length / 20 * 6);
		if (mesh.quads.tints) {
			for (let i = 0; i < mesh.quads.tints.length; i++) {
				const t = mesh.quads.tints[i];
				emitQuads(this.sink, data.subarray(i * 20, i * 20 + 20), m, { ...style, color: [t[0], t[1], t[2], 1] });
			}
		} else {
			emitQuads(this.sink, data, m, style);
		}
		this.batch(this.assets.texture, MODE_NOCULL, start, false);
	}

	drawDroppedItem(e, pos, style) {
		const mesh = this.itemMesh(e.item);
		if (!mesh) return this.drawBox(e, pos, style);
		const age = e.age || 0;
		const bobOffset = (e.id * 0.618) % (Math.PI * 2);
		const bob = Math.sin(age / 10 + bobOffset) * 0.1 + 0.1;
		const m = mat4();
		// ItemEntityRenderer: bob, spin, then the model's "ground" transform resting on its lowest point.
		translate(m, pos[0], pos[1] + bob + (mesh.kind === 'block' ? 0.0625 : 0.125), pos[2]);
		rotate(m, 1, age / 20 + bobOffset);
		const fallback = mesh.kind === 'block'
			? { translation: [0, 3, 0], scale: [0.25, 0.25, 0.25] }
			: { translation: [0, 2, 0], scale: [0.5, 0.5, 0.5] };
		this.applyDisplay(m, this.displayTransform(e.item, 'ground', fallback), false);
		this.emitItem(mesh, m, style);
		this.shadowFor(e, pos, 0.15, this.world);
	}

	drawThrown(pos, style, item) {
		const mesh = this.itemMesh('minecraft:' + item);
		if (!mesh) return;
		const m = mat4();
		translate(m, pos[0], pos[1], pos[2]);
		// Face the camera like ThrownItemRenderer (camera is at the origin of this space).
		rotate(m, 1, Math.atan2(-pos[0], -pos[2]));
		scale(m, 0.5);
		translate(m, -0.5, -0.25, -0.5);
		this.emitItem(mesh, m, style);
	}

	drawOrb(e, pos, style, now) {
		const texture = this.texture('experience/experience_orb');
		if (!texture) return;
		const icon = Number(e.d && e.d.icon) || 0;
		const u0 = (icon % 4 * 16) / 64, v0 = (Math.floor(icon / 4) * 16) / 64, u1 = u0 + 16 / 64, v1 = v0 + 16 / 64;
		const t = (e.age || 0) / 2;
		const r = (Math.sin(t) + 1) * 0.5, b = (Math.sin(t + 4.1887903) + 1) * 0.1;
		const m = mat4();
		translate(m, pos[0], pos[1] + 0.1, pos[2]);
		rotate(m, 1, Math.atan2(-pos[0], -pos[2]));
		scale(m, 0.3);
		const q = new Float32Array([-0.5, -0.25, 0, u0, v1, 0.5, -0.25, 0, u1, v1, 0.5, 0.75, 0, u1, v0, -0.5, 0.75, 0, u0, v0]);
		const start = this.sink.count;
		this.sink.ensure(6);
		emitQuads(this.sink, q, m, { ...style, light: [240, style.light[1]], color: [r, 1, b, 0.5] });
		this.batch(texture, MODE_NOCULL, start, false);
		void now;
	}

	/** An item model's display transform ("ground", "thirdperson_righthand"...) from its parent chain. */
	displayTransform(itemId, slot, fallback) {
		const models = this.assets && this.assets.bundle.models;
		if (!models) return fallback;
		const id = itemId.includes(':') ? itemId : 'minecraft:' + itemId;
		const colon = id.indexOf(':');
		let current = id.slice(0, colon) + ':item/' + id.slice(colon + 1);
		if (!models[current]) current = id.slice(0, colon) + ':block/' + id.slice(colon + 1);
		for (let depth = 0; current && depth < 16; depth++) {
			const model = models[current];
			if (!model) break;
			if (model.display && model.display[slot]) return model.display[slot];
			const parent = model.parent;
			current = parent ? (parent.includes(':') ? parent : 'minecraft:' + parent) : null;
		}
		return fallback;
	}

	/** ItemTransform.apply: translate (pixels), rotate XYZ, scale; then centre the 0..1 model. */
	applyDisplay(m, t, mirror) {
		const tr = t.translation || [0, 0, 0], rot = t.rotation || [0, 0, 0], sc = t.scale || [1, 1, 1];
		translate(m, (mirror ? -tr[0] : tr[0]) / 16, tr[1] / 16, tr[2] / 16);
		rotate(m, 0, rot[0] * DEG);
		rotate(m, 1, (mirror ? -rot[1] : rot[1]) * DEG);
		rotate(m, 2, (mirror ? -rot[2] : rot[2]) * DEG);
		scale(m, sc[0], sc[1], sc[2]);
		translate(m, -0.5, -0.5, -0.5);
	}

	drawHeld(model, m, arm, item, style, side) {
		const mesh = this.itemMesh(item);
		if (!mesh) return;
		const pm = partMatrix(model, arm, m);
		if (!pm) return;
		// ItemInHandLayer: from the arm (block units), rotate -90 X and 180 Y, move into the fist.
		scale(pm, 16);
		rotate(pm, 0, -90 * DEG);
		rotate(pm, 1, 180 * DEG);
		translate(pm, side / 16, 0.125, -0.625);
		const fallback = mesh.kind === 'block'
			? { rotation: [75, 45, 0], translation: [0, 2.5, 0], scale: [0.375, 0.375, 0.375] }
			: { rotation: [0, 0, 0], translation: [0, 3, 1], scale: [0.55, 0.55, 0.55] };
		this.applyDisplay(pm, this.displayTransform(item, side > 0 ? 'thirdperson_righthand' : 'thirdperson_lefthand', fallback), false);
		this.emitItem(mesh, pm, style);
	}

	drawItemFrame(e, type, pos, style) {
		const d = e.d || {};
		const facing = d.facing || 'south';
		const rot = { south: [0, 0], north: [0, 180], west: [0, 90], east: [0, 270], up: [-90, 0], down: [90, 0] }[facing] || [0, 0];
		const m = mat4();
		translate(m, pos[0], pos[1], pos[2]);
		rotate(m, 1, -rot[1] * DEG);
		rotate(m, 0, -rot[0] * DEG);
		const frame = new Float32Array(m);
		translate(frame, -0.5, -0.5, -0.5);
		this.emitBlock(type === 'glow_item_frame' ? 'minecraft:glow_item_frame' : 'minecraft:item_frame', frame, style, false, true);
		if (e.item) {
			const mesh = this.itemMesh(e.item);
			if (mesh) {
				const im = new Float32Array(m);
				translate(im, 0, 0, 0.4375);
				rotate(im, 2, -(Number(d.rotation) || 0) * 45 * DEG);
				scale(im, 0.5);
				if (mesh.kind === 'block') scale(im, 0.5);
				translate(im, -0.5, -0.5, -0.5);
				this.emitItem(mesh, im, type === 'glow_item_frame' ? { ...style, light: [240, 240] } : style);
			}
		}
	}

	/** Emits a block model (by block name with default state) with the atlas texture. */
	emitBlock(name, m, style, chestFallback = false, frameModel = false) {
		if (!this.assets) return;
		if (!name) {
			if (chestFallback) {
				const model = this.library.get('minecraft:chest#main');
				const texture = this.texture('chest/normal');
				if (model && texture) {
					model.reset();
					const start = this.sink.count;
					emitModel(this.sink, model, m, style);
					this.batch(texture, MODE_CUTOUT, start);
				}
			}
			return;
		}
		const key = 'block:' + name + (frameModel ? ':frame' : '');
		let mesh = this.itemMeshes.get(key);
		if (mesh === undefined) {
			mesh = null;
			const models = this.assets.models;
			const dispatch = models && models.dispatch(name, frameModel ? { map: 'false' } : { __item: true });
			if (dispatch) {
				const parts = [];
				const random = new JavaRandom();
				random.setSeedNumber(42);
				collectParts(dispatch, random, parts);
				const quads = [];
				for (const part of parts) for (const list of part.quads) for (const q of list) quads.push({ q, tint: [1, 1, 1] });
				if (quads.length) mesh = { kind: 'block', quads: this.blockQuads(quads) };
			}
			this.itemMeshes.set(key, mesh);
		}
		if (mesh) this.emitItem(mesh, m, style);
	}

	drawBlockEntity(e, pos, style, name, size) {
		const m = mat4();
		translate(m, pos[0] - 0.5 * size, pos[1], pos[2] - 0.5 * size);
		scale(m, size);
		const fuse = Number(e.d && e.d.fuse) || 0;
		if (fuse > 0 && fuse < 10) scale(m, 1 + (1 - fuse / 10) * 0.3);
		this.emitBlock(name, m, { ...style, overlay: [0, fuse > 0 && Math.floor(fuse / 5) % 2 === 0 ? 1 : 0] });
	}

	drawFallingBlock(e, pos, style, world) {
		const id = e.d && e.d.block;
		const info = id !== undefined ? world.infos[id] : null;
		const m = mat4();
		translate(m, pos[0] - 0.5, pos[1], pos[2] - 0.5);
		if (info && this.assets) {
			const dispatch = this.assets.models.dispatch(info.name, info.props);
			if (dispatch) {
				const parts = [];
				const random = new JavaRandom();
				random.setSeedNumber(42);
				collectParts(dispatch, random, parts);
				const quads = [];
				for (const part of parts) for (const list of part.quads) for (const q of list) quads.push({ q, tint: [1, 1, 1] });
				if (quads.length) return this.emitItem({ kind: 'block', quads: this.blockQuads(quads) }, m, style);
			}
		}
		return this.drawBox(e, pos, style);
	}

	// --- block entities (chests, shulker boxes, heads, banners, bells, pots) ---------------------------

	prepareBlockEntities(frame, world) {
		const o = frame.origin, cam = frame.camPos;
		this.portals.endPortal.length = 0;
		this.portals.endGateway.length = 0;
		for (const section of world.sections.values()) {
			if (!section.blockEntities || section.blockEntities.length === 0) continue;
			for (const be of section.blockEntities) {
				if (!be.info) continue;
				const bx = be.x - o[0] - cam[0], by = be.y - o[1] - cam[1], bz = be.z - o[2] - cam[2];
				if (be.info.shortName === 'beacon') {
					this.drawBeacon(be, [bx, by, bz], frame, world);
					continue;
				}
				if (be.info.shortName === 'end_portal' || be.info.shortName === 'end_gateway') {
					this.addPortal(be, [bx, by, bz], frame, world);
					continue;
				}
				if (Math.hypot(bx, by, bz) > Math.min(frame.fogEnd, 96)) continue;
				if (!frame.frustum(bx + 0.5, by + 0.5, bz + 0.5, 1.5)) continue;
				const def = blockEntityModel(be.info);
				if (!def) continue;
				const [sky, block] = world.lightAt(be.x, be.y, be.z);
				const style = { color: [1, 1, 1, 1], light: [block * 16, sky * 16], overlay: [0, 0] };
				this.drawBlockEntityModel(def, [bx, by, bz], style, world.blockEntityAt(be.x, be.y, be.z), be);
			}
		}
	}

	/**
	 * BeaconRenderer: the beam sections the server sent (none while the beacon is off), each a rotating
	 * solid beam and a translucent glow around it, the last one up to the build limit, seen as far as the
	 * view reaches and wider when far away.
	 */
	drawBeacon(be, p, frame, world) {
		const data = world.blockEntityAt(be.x, be.y, be.z);
		if (!data || data.k !== 'beacon' || !data.s || data.s.length === 0) return;
		const distance = Math.hypot(p[0] + 0.5, p[2] + 0.5);
		if (distance > frame.fogEnd + 8) return;
		let visible = false;
		for (let y = 0; y < 400 && !visible; y += 16) visible = frame.frustum(p[0] + 0.5, p[1] + y + 8, p[2] + 0.5, 12);
		if (!visible) return;
		const texture = this.texture('beacon/beacon_beam');
		if (!texture) return;
		const time = this.env ? this.env.gameTime(frame.now) : frame.now / 50;
		const animationTime = ((Math.floor(time) % 40) + 40) % 40 + (time - Math.floor(time));
		const radiusScale = Math.max(1, distance / 96);
		let start = 0;
		data.s.forEach(([color, height], i) => {
			this.beaconBeam(texture, p, animationTime, start, i === data.s.length - 1 ? 2048 : height, color, 0.2 * radiusScale, 0.25 * radiusScale);
			start += height;
		});
	}

	/**
	 * TheEndPortalRenderer (the top and bottom of a box 0.375 to 0.75 high) and TheEndGatewayRenderer (every face
	 * next to a block that does not hide it), drawn with the game's end portal shader in draw().
	 */
	addPortal(be, p, frame, world) {
		const gateway = be.info.shortName === 'end_gateway';
		if (Math.hypot(p[0] + 0.5, p[1] + 0.5, p[2] + 0.5) > Math.min(frame.fogEnd + 8, gateway ? 256 : 64)) return;
		if (!frame.frustum(p[0] + 0.5, p[1] + 0.5, p[2] + 0.5, 1.5)) return;
		const out = gateway ? this.portals.endGateway : this.portals.endPortal;
		const [x0, z0, x1, z1] = [p[0], p[2], p[0] + 1, p[2] + 1];
		const y0 = p[1] + (gateway ? 0 : 0.375), y1 = p[1] + (gateway ? 1 : 0.75);
		const shown = (dx, dy, dz) => {
			// TheEndPortalBlockEntity: only up and down; TheEndGatewayBlockEntity: Block.shouldRenderFace
			if (!gateway) return dy !== 0;
			const info = world.infoAt(be.x + dx, be.y + dy, be.z + dz);
			return !(info && info.opaque);
		};
		const quad = (a, b, c, d) => out.push(...a, ...b, ...c, ...a, ...c, ...d);
		if (shown(0, 1, 0)) quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]);
		if (shown(0, -1, 0)) quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
		if (shown(0, 0, -1)) quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]);
		if (shown(0, 0, 1)) quad([x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1]);
		if (shown(-1, 0, 0)) quad([x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]);
		if (shown(1, 0, 0)) quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
	}

	/** RenderPipelines END_PORTAL (15 layers) and END_GATEWAY (16 layers). */
	drawPortals(frame) {
		const lists = [[this.portals.endPortal, 15], [this.portals.endGateway, 16]].filter(([list]) => list.length);
		if (!lists.length || !this.assets || !this.assets.environment || !this.assets.environment.endSky) return;
		const portalTexture = this.texture('end_portal/end_portal');
		if (!portalTexture) return;
		const gl = this.gl;
		if (!this.portalProgram) {
			this.portalProgram = program(gl, PORTAL_VS, PORTAL_FS);
			this.portalVao = gl.createVertexArray();
			this.portalVbo = gl.createBuffer();
			gl.bindVertexArray(this.portalVao);
			gl.bindBuffer(gl.ARRAY_BUFFER, this.portalVbo);
			gl.enableVertexAttribArray(0);
			gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
		}
		const { program: p, u } = this.portalProgram;
		gl.useProgram(p);
		gl.bindVertexArray(this.portalVao);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.portalVbo);
		gl.uniformMatrix4fv(u.uViewProj, false, frame.viewProj);
		setFog(gl, u, frame.fog);
		// Globals.GameTime: the day's ticks as a fraction
		const time = this.env ? this.env.gameTime(frame.now) : frame.now / 50;
		gl.uniform1f(u.uGameTime, (time % 24000) / 24000);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.assets.environment.endSky);
		gl.uniform1i(u.uSky, 0);
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, portalTexture);
		gl.uniform1i(u.uPortal, 1);
		gl.disable(gl.BLEND);
		gl.depthMask(true);
		gl.disable(gl.CULL_FACE);
		for (const [list, layers] of lists) {
			gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(list), gl.STREAM_DRAW);
			gl.uniform1i(u.uLayers, layers);
			gl.drawArrays(gl.TRIANGLES, 0, list.length / 3);
		}
		gl.enable(gl.CULL_FACE);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindVertexArray(null);
	}

	/** BeaconRenderer.submitBeaconBeam */
	beaconBeam(texture, p, animationTime, beamStart, height, color, solidRadius, glowRadius) {
		const beamEnd = beamStart + height;
		const scroll = height < 0 ? animationTime : -animationTime;
		const v = scroll * 0.2 - Math.floor(scroll * 0.1);
		const vOffset = v - Math.floor(v);
		const rgb = [(color >> 16 & 255) / 255, (color >> 8 & 255) / 255, (color & 255) / 255];
		// renderPart: four sides, renderQuad: two corners from beamStart to beamEnd
		const part = (c, u1, u2, v1, v2) => {
			const quads = [];
			const quad = (x1, z1, x2, z2) => quads.push(
				x1, beamEnd, z1, u2, v1, x1, beamStart, z1, u2, v2, x2, beamStart, z2, u1, v2, x2, beamEnd, z2, u1, v1);
			quad(c[0], c[1], c[2], c[3]);
			quad(c[6], c[7], c[4], c[5]);
			quad(c[2], c[3], c[6], c[7]);
			quad(c[4], c[5], c[0], c[1]);
			return quads;
		};
		const emit = (quads, m, alpha, mode) => {
			const start = this.sink.count;
			this.sink.ensure(quads.length / 20 * 6);
			emitQuads(this.sink, quads, m, { color: [rgb[0], rgb[1], rgb[2], alpha], light: [240, 240], overlay: [0, 0] });
			const out = this.sink.data;
			for (let i = start; i < this.sink.count; i++) { out[i * FLOATS + 3] = 0; out[i * FLOATS + 4] = 1; out[i * FLOATS + 5] = 0; }
			this.batch(texture, mode, start, false);
		};
		// the solid beam turns (2.25 degrees a tick)
		const m = mat4();
		translate(m, p[0] + 0.5, p[1], p[2] + 0.5);
		rotate(m, 1, (animationTime * 2.25 - 45) * DEG);
		let v2 = -1 + vOffset;
		emit(part([0, solidRadius, solidRadius, 0, -solidRadius, 0, 0, -solidRadius], 0, 1, height * (0.5 / solidRadius) + v2, v2), m, 1, MODE_CUTOUT);
		// the glow does not
		const g = mat4();
		translate(g, p[0] + 0.5, p[1], p[2] + 0.5);
		v2 = -1 + vOffset;
		emit(part([-glowRadius, -glowRadius, glowRadius, -glowRadius, -glowRadius, glowRadius, glowRadius, glowRadius], 0, 1, height + v2, v2), g, 32 / 255, MODE_TRANSLUCENT);
	}

	/**
	 * @param data what the server sent for this block entity (banner patterns, pot sherds, head owner) or null
	 * @param pos  its block position
	 */
	drawBlockEntityModel(def, p, style, data = null, pos = null) {
		const m = mat4();
		translate(m, p[0], p[1], p[2]);
		const emit = (layer, texturePath, matrix, color, mode = MODE_CUTOUT, pose = null) => {
			const model = this.library.get(layer);
			const texture = typeof texturePath === 'object' && texturePath ? texturePath.texture : this.texture(texturePath);
			if (!model || !texture) return null;
			model.reset();
			if (pose) pose(model.parts);
			const start = this.sink.count;
			emitModel(this.sink, model, matrix, color ? { ...style, color } : style);
			this.batch(texture, mode, start, mode !== MODE_TRANSLUCENT);
			return model;
		};
		switch (def.kind) {
			case 'chest': {
				translate(m, 0.5, 0.5, 0.5);
				rotate(m, 1, -def.yRot * DEG);
				translate(m, -0.5, -0.5, -0.5);
				emit(def.layer, def.texture, m);
				break;
			}
			case 'shulker_box': {
				translate(m, 0.5, 0.5, 0.5);
				scale(m, 0.9995);
				const f = { up: null, down: [0, 180], north: [0, 90], south: [0, -90], west: [2, -90], east: [2, 90] }[def.facing];
				if (f) rotate(m, f[0], f[1] * DEG);
				scale(m, 1, -1, -1);
				translate(m, 0, -1, 0);
				emit(def.layer, def.texture, m);
				break;
			}
			case 'head': {
				if (def.wall) {
					const d = { north: [0, 1], south: [0, -1], west: [1, 0], east: [-1, 0] }[def.facing] || [0, 1];
					translate(m, 0.5 + d[0] * 0.25, 0.25, 0.5 + d[1] * 0.25);
				} else {
					translate(m, 0.5, 0, 0.5);
				}
				scale(m, -1, -1, 1);
				const yaw = def.wall ? { north: 180, south: 0, west: 270, east: 90 }[def.facing] ?? 0 : def.rotation * 22.5;
				const model = this.library.get(def.layer);
				// Player heads show their owner's skin (SkullBlockRenderer.resolveSkullRenderType).
				const owner = data && data.k === 'head' && def.layer === 'minecraft:player_head#main' ? data : null;
				const texture = owner ? this.skin(owner.uuid || 'name:' + owner.name, owner.name).texture : this.texture(def.texture);
				if (model && texture) {
					model.reset();
					if (model.parts.head) model.parts.head.yRot = yaw * DEG;
					const start = this.sink.count;
					emitModel(this.sink, model, m, style);
					this.batch(texture, MODE_NOCULL, start, false);
				}
				break;
			}
			case 'banner': {
				translate(m, 0.5, 0, 0.5);
				if (def.wall) {
					rotate(m, 1, -({ north: 180, south: 0, west: 90, east: 270 }[def.facing] ?? 0) * DEG);
				} else {
					rotate(m, 1, -def.rotation * 22.5 * DEG);
				}
				scale(m, 2 / 3, -2 / 3, -2 / 3);
				const base = def.wall ? 'minecraft:wall_banner' : 'minecraft:standing_banner';
				// BannerRenderer.extractRenderState phase and BannerFlagModel.setupAnim: the flag sways.
				const b = pos || { x: 0, y: 0, z: 0 };
				const ticks = performance.now() / 50;
				const phase = ((((b.x * 7 + b.y * 9 + b.z * 13 + Math.floor(ticks)) % 100) + 100) % 100 + ticks % 1) / 100;
				const sway = parts => { if (parts.flag) parts.flag.xRot = (-0.0125 + 0.01 * Math.cos(Math.PI * 2 * phase)) * Math.PI; };
				emit(base + '#main', 'banner/banner_base', m);
				emit(base + '#flag', 'banner/banner_base', m, null, MODE_CUTOUT, sway);
				// submitPatterns: the base colour, then every pattern layer in its dye colour (bannerPattern render type).
				emit(base + '#flag', 'banner/base', m, dyeRgb(def.color), MODE_TRANSLUCENT, sway);
				for (const [asset, color] of (data && data.k === 'banner' && data.p) || []) {
					emit(base + '#flag', 'banner/' + String(asset).replace(/^[a-z0-9_.-]+:/, ''), m, dyeRgb(color), MODE_TRANSLUCENT, sway);
				}
				break;
			}
			case 'bell':
				emit(def.layer, def.texture, m);
				break;
			case 'pot': {
				// DecoratedPotRenderer.createModelTransformation: rotated around the block centre.
				const yRot = { south: 0, west: 90, north: 180, east: 270 }[def.facing] ?? 0;
				translate(m, 0.5, 0.5, 0.5);
				rotate(m, 1, (180 - yRot) * DEG);
				translate(m, -0.5, -0.5, -0.5);
				emit('minecraft:decorated_pot_base#main', 'decorated_pot/decorated_pot_base', m);
				// Every side has its own sprite: the sherd's pottery pattern, or the plain side.
				const sherds = data && data.k === 'pot' ? data : {};
				for (const side of ['front', 'back', 'left', 'right']) {
					const pattern = sherds[side] ? String(sherds[side]).replace(/^[a-z0-9_.-]+:/, '') : 'decorated_pot_side';
					const only = parts => { for (const other of ['front', 'back', 'left', 'right']) if (parts[other]) parts[other].visible = other === side; };
					if (!emit('minecraft:decorated_pot_sides#main', 'decorated_pot/' + pattern, m, null, MODE_CUTOUT, only) && pattern !== 'decorated_pot_side') {
						emit('minecraft:decorated_pot_sides#main', 'decorated_pot/decorated_pot_side', m, null, MODE_CUTOUT, only);
					}
				}
				break;
			}
			default:
				break;
		}
	}

	// --- drawing -------------------------------------------------------------------------------------

	/** pass 'opaque': the scene; 'shadow': depth only into the sun shadow map. */
	draw(pass, frame, shadow) {
		if (pass !== 'shadow') this.drawPortals(frame);
		if (!this.batches.length && !this.shadows.length) return;
		const gl = this.gl;
		gl.bindVertexArray(this.vao);
		if (pass === 'shadow') {
			const p = this.depthProgram;
			gl.useProgram(p.program);
			gl.uniformMatrix4fv(p.u.uMatrix, false, shadow.matrix);
			gl.uniform1i(p.u.uTexture, 0);
			gl.activeTexture(gl.TEXTURE0);
			for (const b of this.batches) {
				if (b.mode >= MODE_EYES || b.mode === MODE_TRANSLUCENT) continue;
				gl.bindTexture(gl.TEXTURE_2D, b.texture);
				gl.drawArrays(gl.TRIANGLES, b.start, b.count);
			}
			gl.bindVertexArray(null);
			return;
		}

		const shaders = this.renderer.shaders;
		const p = this.entityProgram(shaders);
		const u = p.u;
		gl.useProgram(p.program);
		gl.uniformMatrix4fv(u.uViewProj, false, frame.viewProj);
		setFog(gl, u, frame.fog);
		gl.uniform3fv(u.uLight0, LIGHT0);
		gl.uniform3fv(u.uLight1, LIGHT1);
		gl.uniform1f(u.uTime, frame.time * 20);
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, this.renderer.lightmap);
		gl.uniform1i(u.uLightmap, 1);
		gl.activeTexture(gl.TEXTURE0);
		gl.uniform1i(u.uTexture, 0);
		if (shaders) this.renderer.bindShaderUniforms(u, frame, shadow);
		gl.enable(gl.DEPTH_TEST);

		const drawBatches = filter => {
			for (const b of this.batches) {
				if (!filter(b)) continue;
				gl.uniform1i(u.uMode, b.mode);
				if (b.cull) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
				gl.bindTexture(gl.TEXTURE_2D, b.texture);
				gl.drawArrays(gl.TRIANGLES, b.start, b.count);
			}
		};
		gl.disable(gl.BLEND);
		gl.depthMask(true);
		drawBatches(b => b.mode <= MODE_NOCULL);
		gl.enable(gl.BLEND);
		gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		gl.depthMask(false);
		drawBatches(b => b.mode === MODE_TRANSLUCENT);
		gl.blendFunc(gl.ONE, gl.ONE);
		drawBatches(b => b.mode >= MODE_EYES);
		gl.depthMask(true);
		gl.enable(gl.CULL_FACE);
		gl.bindVertexArray(null);
		this.drawShadows(frame);
		gl.disable(gl.BLEND);
	}

	drawShadows(frame) {
		if (!this.shadows.length) return;
		const gl = this.gl;
		const p = this.blobProgram;
		gl.useProgram(p.program);
		gl.uniformMatrix4fv(p.u.uViewProj, false, frame.viewProj);
		setFog(gl, p.u, frame.fog);
		gl.enable(gl.BLEND);
		gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
		gl.depthMask(false);
		gl.disable(gl.CULL_FACE);
		gl.enable(gl.POLYGON_OFFSET_FILL);
		gl.polygonOffset(-2, -2);
		gl.bindVertexArray(this.blobVao);
		for (const s of this.shadows) {
			gl.uniform3fv(p.u.uCenter, s.center);
			gl.uniform1f(p.u.uRadius, s.radius);
			gl.uniform1f(p.u.uAlpha, s.alpha);
			gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
		}
		gl.disable(gl.POLYGON_OFFSET_FILL);
		gl.depthMask(true);
		gl.enable(gl.CULL_FACE);
		gl.bindVertexArray(null);
	}

	// --- name tags -----------------------------------------------------------------------------------

	/** Name tags only for entities on screen with a clear line of sight from the camera. */
	/**
	 * Name tags of the entities that can be seen: players (64 blocks, 32 when sneaking, like
	 * LivingEntityRenderer.shouldShowName), named mobs and, when enabled, every mob's type. A tag is only
	 * shown when the head or the middle of the body is not hidden behind blocks.
	 */
	collectNameTags(frame, list, world) {
		const tags = [];
		if (!this.text.ready) return tags;
		const o = frame.origin, cam = frame.camPos;
		const eye = [cam[0] + o[0], cam[1] + o[1], cam[2] + o[2]];
		for (const e of list) {
			if (e.invisible || e.dead) continue;
			const type = strip(e.type);
			if (type === 'item' || type === 'experience_orb' || type === 'lightning_bolt' || type.endsWith('arrow')) continue;
			// Players and mobs whose custom name is always visible, like in the game; every mob with "mob labels".
			const named = type === 'player' || (!!e.name && !!e.nameVisible);
			if (named ? !this.showLabels : !this.showMobLabels) continue;
			const height = e.h || 1;
			const dx = e.x - eye[0], dy = e.y + height - eye[1], dz = e.z - eye[2];
			const distance = Math.hypot(dx, dy, dz);
			const limit = !named ? 32 : type === 'player' && e.sneak ? 32 : 64;
			if (distance >= limit || distance > frame.fogEnd) continue;
			const rx = e.x - o[0] - cam[0], ry = e.y + height - o[1] - cam[1], rz = e.z - o[2] - cam[2];
			if (!frame.frustum(rx, ry + 0.6, rz, 2)) continue;
			// Visible if the head or the middle of the body can be seen.
			if (world.occluded(eye, [e.x, e.y + height * 0.9, e.z]) && world.occluded(eye, [e.x, e.y + height * 0.5, e.z])) continue;
			tags.push({
				pos: [rx, ry, rz],
				text: e.name || (this.names && this.names[type]) || titleCase(type),
				discrete: type === 'player' && !!(e.sneak || e.pose === 'crouching'),
				light: this.lightFor(e, world),
			});
		}
		return tags;
	}

	/** Draws the name tags and sign text prepared for this frame (after the translucent world, before clouds and weather). */
	drawNameTags(frame) {
		this.text.draw(frame, this.renderer.lightmap);
	}

	/**
	 * Sign text (AbstractSignRenderer with the StandingSignRenderer / HangingSignRenderer transformations) for
	 * signs within the block entity view distance; the sign boards themselves are block models.
	 */
	addSignText(frame, world) {
		if (!this.text.ready || !world.signs.size) return;
		const o = frame.origin, cam = frame.camPos;
		const eye = [cam[0] + o[0], cam[1] + o[1], cam[2] + o[2]];
		for (const signs of world.signs.values()) {
			for (const sign of signs) {
				const dx = sign.x + 0.5 - eye[0], dy = sign.y + 0.5 - eye[1], dz = sign.z + 0.5 - eye[2];
				const distance = Math.hypot(dx, dy, dz);
				if (distance > 64) continue;
				const rx = sign.x - o[0] - cam[0], ry = sign.y - o[1] - cam[1], rz = sign.z - o[2] - cam[2];
				if (!frame.frustum(rx + 0.5, ry + 0.5, rz + 0.5, 1.5)) continue;
				const info = world.infoAt(sign.x, sign.y, sign.z);
				if (!info) continue;
				const name = info.name;
				const hanging = name.endsWith('hanging_sign');
				const wall = name.endsWith('_wall_sign') || name.endsWith('_wall_hanging_sign');
				if (!hanging && !name.endsWith('_sign')) continue;
				const angle = wall ? (FACING_Y_ROT[info.props.facing] ?? 0) : Number(info.props.rotation || 0) * 22.5;
				const [sky, block] = world.lightAt(sign.x, sign.y, sign.z);
				const light = [block * 16, sky * 16];
				for (const back of [false, true]) {
					const side = back ? sign.b : sign.f;
					if (!side) continue;
					const m = mat4();
					translate(m, rx, ry, rz);
					if (hanging) {
						translate(m, 0.5, 0.9375, 0.5);
						rotate(m, 1, -angle * DEG);
						translate(m, 0, -0.3125, 0);
						if (back) rotate(m, 1, Math.PI);
						translate(m, 0, -0.32, 0.073);
						scale(m, 0.0140625, -0.0140625, 0.0140625);
					} else {
						translate(m, 0.5, 0.5, 0.5);
						rotate(m, 1, -angle * DEG);
						if (wall) translate(m, 0, -0.3125, -0.4375);
						if (back) rotate(m, 1, Math.PI);
						translate(m, 0, 0.33333334, 0.046666667);
						scale(m, 0.010416667, -0.010416667, 0.010416667);
					}
					this.signSide(matrixTransform(m), side, sign, light, distance);
				}
			}
		}
	}

	/** AbstractSignRenderer.submitSignText */
	signSide(transform, side, sign, light, distance) {
		const color = side.c || 0;
		const dark = side.g && color === 0 ? 0xF0EBCC : scaleRgb(color, 0.4); // getDarkColor
		const lineHeight = sign.lh || 10;
		const middle = 4 * lineHeight / 2;
		const lines = side.l || [];
		for (let i = 0; i < lines.length; i++) {
			const line = this.text.font.clip(lines[i], sign.w || 90);
			if (!line) continue;
			const x = -this.text.font.width(line) / 2;
			const y = i * lineHeight - middle;
			if (side.g) {
				// Glowing text: full bright in the dye colour, outlined when black or when the camera is close.
				if (color === 0 || distance < 16) this.text.addOutlined(transform, line, x, y, rgb(color), rgb(dark), FULL_BRIGHT);
				else this.text.add(transform, line, x, y, rgb(color), FULL_BRIGHT, 'polygon_offset');
			} else {
				this.text.add(transform, line, x, y, rgb(dark), light, 'polygon_offset');
			}
		}
	}
}
