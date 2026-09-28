// Live entities: interpolation between server snapshots, the game's own
// entity models and textures (see mobs.js / entity-models.js), items,
// block entities, shadows and name tags that only show when the entity is
// really visible (not through walls).

import {
	ModelLibrary, VertexSink, FLOATS, emitModel, emitQuads, partMatrix, mat4, mul, translate, rotate, scale, DEG,
} from './entity-models.js';
import { describeMob, blockEntityModel, dyeRgb } from './mobs.js';
import { collectParts } from './models.js';
import { JavaRandom } from './rng.js';
import { program, FOG_GLSL, setFog } from './gl.js';
import { SHADOW_GLSL, SHADER_LIGHT_GLSL } from './renderer.js';
import { lerp, lerpAngle, wrapDegrees } from './math.js';
import { NameTagRenderer } from './nametags.js';

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
		this.nameTags = new NameTagRenderer(this.gl);
		this.library = new ModelLibrary();
		this.sink = new VertexSink();
		this.batches = [];
		this.textures = new Map();
		this.skins = new Map();
		this.states = new Map();
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
		this.motion.clear();
	}

	setAssets(assets) {
		this.assets = assets;
		const query = tokenSuffix('?');
		fetch('/assets/entities.json' + query, { credentials: 'same-origin' })
			.then(r => (r.ok ? r.json() : []))
			.then(list => { this.entityList = new Set(list); })
			.catch(() => { this.entityList = new Set(); });
		this.nameTags.load(query);
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
		for (const e of frame.e) map.set(e.id, e);
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

	cleanupStates(now) {
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
			if (e.invisible) continue;
			const radius = Math.max(e.w || 1, e.h || 1) + 1;
			if (!frame.frustum(rx, ry + (e.h || 1) / 2, rz, radius * (type === 'happy_ghast' || type === 'ghast' ? 2 : 1))) continue;
			if (Math.hypot(rx, rz) > frame.fogEnd + 8) continue;
			visible++;
			const light = this.lightFor(e, world);
			try {
				this.drawEntity(e, type, [rx, ry, rz], light, now, world);
			} catch (error) {
				console.warn('CCTV: could not draw', e.type, error);
			}
		}
		this.visibleCount = visible;
		const view = frame.viewRotation;
		this.nameTags.build(this.collectNameTags(frame, list, world), [view[0], view[4], view[8]], [view[1], view[5], view[9]]);
		if (this.assets) this.prepareBlockEntities(frame, world);
		this.upload();
		this.cleanupStates(now);
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
		for (const layer of mob.layers) {
			const model = this.library.get(layer.layer);
			if (!model) continue;
			const texture = this.texture(layer.texture);
			if (!texture) continue;
			model.reset();
			if (base && model !== base) {
				mob.anim(model.parts, anim, e);
				model.copyPose(base);
			} else {
				mob.anim(model.parts, anim, e);
			}
			if (!base) base = model;
			const start = this.sink.count;
			emitModel(this.sink, model, m, { ...style, color: layer.color || [1, 1, 1, 1] });
			const mode = MODES[layer.mode] ?? MODE_CUTOUT;
			this.batch(texture, mode, start, mode !== MODE_NOCULL && mode !== MODE_TRANSLUCENT);
		}
		if (!base) return this.drawBox(e, pos, style);

		// Held items (ItemInHandLayer).
		if (e.hand && base.parts.right_arm && base.parts.right_arm.visible) this.drawHeld(base, m, 'right_arm', e.hand, style, 1);
		if (e.offhand && base.parts.left_arm && base.parts.left_arm.visible) this.drawHeld(base, m, 'left_arm', e.offhand, style, -1);

		this.shadowFor(e, pos, typeof mob.shadow === 'number' ? mob.shadow * entityScale : 0.5, world);
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
		for (const section of world.sections.values()) {
			if (!section.blockEntities || section.blockEntities.length === 0) continue;
			for (const be of section.blockEntities) {
				if (!be.info) continue;
				const bx = be.x - o[0] - cam[0], by = be.y - o[1] - cam[1], bz = be.z - o[2] - cam[2];
				if (Math.hypot(bx, by, bz) > Math.min(frame.fogEnd, 96)) continue;
				if (!frame.frustum(bx + 0.5, by + 0.5, bz + 0.5, 1.5)) continue;
				const def = blockEntityModel(be.info);
				if (!def) continue;
				const [sky, block] = world.lightAt(be.x, be.y, be.z);
				const style = { color: [1, 1, 1, 1], light: [block * 16, sky * 16], overlay: [0, 0] };
				this.drawBlockEntityModel(def, [bx, by, bz], style);
			}
		}
	}

	drawBlockEntityModel(def, p, style) {
		const m = mat4();
		translate(m, p[0], p[1], p[2]);
		const emit = (layer, texturePath, matrix, color, mode = MODE_CUTOUT) => {
			const model = this.library.get(layer);
			const texture = this.texture(texturePath);
			if (!model || !texture) return null;
			model.reset();
			const start = this.sink.count;
			emitModel(this.sink, model, matrix, color ? { ...style, color } : style);
			this.batch(texture, mode, start);
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
				const texture = this.texture(def.texture);
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
				emit(base + '#main', 'banner/banner_base', m);
				emit(base + '#flag', 'banner/banner_base', m);
				emit(base + '#flag', 'banner/base', m, dyeRgb(def.color));
				break;
			}
			case 'bell':
				emit(def.layer, def.texture, m);
				break;
			case 'pot': {
				translate(m, 0.5, 0, 0.5);
				rotate(m, 1, -({ north: 180, south: 0, west: 90, east: 270 }[def.facing] ?? 0) * DEG);
				translate(m, -0.5, 0, -0.5);
				emit('minecraft:decorated_pot_base#main', 'decorated_pot/decorated_pot_base', m);
				emit('minecraft:decorated_pot_sides#main', 'decorated_pot/decorated_pot_side', m);
				break;
			}
			default:
				break;
		}
	}

	// --- drawing -------------------------------------------------------------------------------------

	/** pass 'opaque': the scene; 'shadow': depth only into the sun shadow map. */
	draw(pass, frame, shadow) {
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
		if (!this.nameTags.ready) return tags;
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
				text: e.name || titleCase(type),
				discrete: type === 'player' && !!(e.sneak || e.pose === 'crouching'),
				light: this.lightFor(e, world),
			});
		}
		return tags;
	}

	/** Draws the name tags prepared for this frame (after the translucent world, before clouds and weather). */
	drawNameTags(frame) {
		this.nameTags.draw(frame, this.renderer.lightmap);
	}
}
