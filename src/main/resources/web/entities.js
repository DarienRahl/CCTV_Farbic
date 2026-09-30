// Live entities: interpolation between server snapshots, the game's own
// entity models and textures (see mobs.js / entity-models.js), items,
// block entities, shadows and name tags that only show when the entity is
// really visible (not through walls).

import {
	ModelLibrary, VertexSink, FLOATS, emitModel, emitQuads, partMatrix, mat4, mul, translate, rotate, scale, DEG,
} from './entity-models.js';
import { describeMob, isKnownMob, blockEntityModel, dyeRgb, CLIENT, equipmentPose, setEquipment } from './mobs.js';
import { Animator, AnimationStates } from './keyframes.js';
import { collectParts } from './models.js';
import { JavaRandom } from './rng.js';
import { program, FOG_GLSL, setFog } from './gl.js';
import { SHADOW_GLSL, SHADER_LIGHT_GLSL } from './renderer.js';
import { lerp, lerpAngle, wrapDegrees } from './math.js';
import { TextRenderer, rgb, matrixTransform, FULL_BRIGHT } from './text.js';

const PI = Math.PI;
/** A standard normal random number (Random.nextGaussian). */
const gaussian = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * PI * Math.random());

const MODE_CUTOUT = 0, MODE_NOCULL = 1, MODE_TRANSLUCENT = 2, MODE_EYES = 3, MODE_ENERGY = 4, MODE_CRUMBLING = 5;

/**
 * Enchantment glint kinds (RenderTypes ITEM_CUTOUT_GLINT, ARMOR_CUTOUT_NO_CULL_GLINT, ENTITY_SOLID_GLINT): the glint
 * texture and the TextureTransform scale. Item coordinates are in our block atlas, scaled to a 512 pixel atlas.
 */
const GLINT_ITEM = 1, GLINT_ARMOR = 2, GLINT_ENTITY = 3;
const GLINTS = {
	[GLINT_ITEM]: { texture: 'enchanted_glint_item', scale: 8, atlas: true },
	[GLINT_ARMOR]: { texture: 'enchanted_glint_armor', scale: 0.16 },
	[GLINT_ENTITY]: { texture: 'enchanted_glint_item', scale: 0.5 },
};
/** The game's default glint strength and speed options. */
const GLINT_ALPHA = 0.75, GLINT_SPEED = 0.5;
/** ItemEntity... "foil" bits the server sends: main hand, off hand, armour head..feet, the shown item. */
const FOIL_HAND = 1, FOIL_OFFHAND = 2, FOIL_ARMOR = 4, FOIL_ITEM = 64;

/** TextureTransform.setupGlintTexturing as a 3x3 matrix (column major) for texture coordinates. */
function glintMatrix(scale, millisNow) {
	const millis = Math.floor(millisNow * GLINT_SPEED * 8);
	const offset0 = (millis % 110000) / 110000, offset1 = (millis % 30000) / 30000;
	const c = Math.cos(Math.PI / 18) * scale, s = Math.sin(Math.PI / 18) * scale;
	return new Float32Array([c, s, 0, -s, c, 0, -offset0, offset1, 1]);
}
/**
 * SheetedDecalTextureGenerator: block coordinates turned by rotateY(PI), rotateX(-PI/2) and the face's
 * Direction.getRotation(), then u = -x, v = -y.
 */
const DECAL_UV = {
	up: (x, y, z) => [x, z],
	down: (x, y, z) => [x, -z],
	south: (x, y, z) => [x, -y],
	north: (x, y, z) => [-x, -y],
	west: (x, y, z) => [-z, -y],
	east: (x, y, z) => [z, -y],
};

/** Shields are drawn by ShieldSpecialRenderer, not from a sprite. */
const isShield = item => /^(minecraft:)?shield$/.test(item || '');
/** models/item/shield.json display transforms, for a bundle without item models. */
const SHIELD_DISPLAY = {
	thirdperson_righthand: { rotation: [0, 90, 0], translation: [10, 6, -4], scale: [1, 1, 1] },
	thirdperson_lefthand: { rotation: [0, 90, 0], translation: [10, 6, 12], scale: [1, 1, 1] },
	ground: { rotation: [0, 0, 0], translation: [2, 4, 2], scale: [0.25, 0.25, 0.25] },
	fixed: { rotation: [0, 180, 0], translation: [-4.5, 4.5, -5], scale: [0.55, 0.55, 0.55] },
};

/** Direction.getStepX/Y/Z and toYRot of the facings. */
const FACING_STEP = { north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0], up: [0, 1, 0], down: [0, -1, 0] };
const FACING_YROT = { south: 0, west: 90, north: 180, east: 270 };

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
uniform mat3 uGlintMatrix;
out float vSph;
out float vCyl;
out vec4 vColor;
out vec4 vLightColor;
out vec2 vUv;
out vec2 vGlintUv;
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
	vColor = uMode >= 3 ? aColor : vec4(aColor.rgb * light, aColor.a);
	vLightColor = uMode == 3 || uMode == 5 ? vec4(1.0) : texture(uLightmap, clamp(aLight / 256.0 + 0.5 / 16.0, vec2(0.5 / 16.0), vec2(15.5 / 16.0)));
	vUv = uMode == 4 ? aUv + vec2(uTime * 0.01) : aUv;
	// entity.vsh / item.vsh GLINT: the texture matrix applied to the model's own texture coordinates
	vGlintUv = (uGlintMatrix * vec3(aUv, 1.0)).xy;
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
in vec2 vGlintUv;
in vec4 vOverlay;
uniform sampler2D uTexture;
uniform int uMode;
uniform int uGlint;
uniform sampler2D uGlintTexture;
uniform float uGlintAlpha;
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
	if (uMode == 5) {
		// rendertype_crumbling: the destroy stage texture, blended as DST_COLOR * SRC_COLOR
		color *= vColor;
		if (color.a < 0.1) discard;
		outColor = apply_fog(color, vSph, vCyl);
		return;
	}
	if (uMode <= 1 && color.a < 0.1) discard;
	if (uMode == 2 && color.a < 0.004) discard;
	color *= vColor;
	if (uGlint > 0) color.a = max(color.a, uGlintAlpha);
	if (uMode >= 3) {
		outColor = vec4(color.rgb * color.a * (1.0 - total_fog_value(vSph, vCyl)), 1.0);
		return;
	}
	color.rgb = mix(vOverlay.rgb, color.rgb, vOverlay.a);
	color *= vLightColor;
#ifdef SHADERS
	color.rgb = shaderLight(color.rgb, vPos, vNormal, vSky, false);
#endif
	if (uGlint > 0) {
		// the enchantment glint (matches BlendFunction.GLINT)
		vec4 glint = uGlintAlpha * texture(uGlintTexture, vGlintUv);
		color.rgb += glint.rgb * glint.rgb;
	}
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

// RenderPipelines.ENTITY_SHADOW (rendertype_entity_shadow): shadow.png times the vertex alpha, with fog.
const SHADOW_VS = `
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aUv;
layout(location = 2) in float aAlpha;
uniform mat4 uViewProj;
out vec2 vUv;
out float vAlpha;
out float vSph;
out float vCyl;
void main() {
	vUv = aUv;
	vAlpha = aAlpha;
	vSph = length(aPos);
	vCyl = max(length(aPos.xz), abs(aPos.y));
	gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const SHADOW_FS = `
in vec2 vUv;
in float vAlpha;
in float vSph;
in float vCyl;
uniform sampler2D uTexture;
${FOG_GLSL}
out vec4 outColor;
void main() {
	vec4 color = texture(uTexture, clamp(vUv, 0.0, 1.0));
	color.a *= vAlpha;
	if (color.a <= 0.0) discard;
	outColor = apply_fog(color, vSph, vCyl);
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

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
/** Mth.frac */
const frac = v => v - Math.floor(v);
/** an angle in radians wrapped to [-PI, PI) */
function wrapRadians(a) {
	while (a >= Math.PI) a -= Math.PI * 2;
	while (a < -Math.PI) a += Math.PI * 2;
	return a;
}

/** BookModel.State.forAnimation */
function bookState(progress, pageFlip1, pageFlip2, openness) {
	return { openness: (Math.sin(progress * 0.02) * 0.1 + 1.25) * openness, pageFlip1, pageFlip2 };
}

/** EnchantingTableBlockEntity.bookAnimationTick: turn to the nearest player within 3 blocks and open, else close. */
function bookAnimationTick(b, be, list) {
	b.oOpen = b.open;
	b.oRot = b.rot;
	const cx = be.x + 0.5, cy = be.y + 0.5, cz = be.z + 0.5;
	let player = null, best = 9;
	for (const e of list) {
		if (e.type !== 'minecraft:player') continue;
		const d = (e.x - cx) ** 2 + (e.y - cy) ** 2 + (e.z - cz) ** 2;
		if (d < best) { best = d; player = e; }
	}
	const random = n => Math.floor(Math.random() * n);
	if (player) {
		b.tRot = Math.atan2(player.z - cz, player.x - cx);
		b.open += 0.1;
		if (b.open < 0.5 || random(40) === 0) {
			const old = b.flipT;
			do b.flipT += random(4) - random(4); while (old === b.flipT);
		}
	} else {
		b.tRot += 0.02;
		b.open -= 0.1;
	}
	b.rot = wrapRadians(b.rot);
	b.tRot = wrapRadians(b.tRot);
	b.rot += wrapRadians(b.tRot - b.rot) * 0.4;
	b.open = clamp(b.open, 0, 1);
	b.time++;
	b.oFlip = b.flip;
	const diff = clamp((b.flipT - b.flip) * 0.4, -0.2, 0.2);
	b.flipA += (diff - b.flipA) * 0.9;
	b.flip += b.flipA;
}

function hashColor(text) {
	let h = 0;
	for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
	return [((h >> 16) & 255) / 255 * 0.5 + 0.35, ((h >> 8) & 255) / 255 * 0.5 + 0.35, (h & 255) / 255 * 0.5 + 0.35, 1];
}

/**
 * SkinTextureDownloader.processLegacySkin: an old 64x32 skin gets the left arm and leg (the right ones'
 * faces, each mirrored), the base layer has no transparency, and a legacy hat layer without any
 * transparent pixel is cleared (the game's "Notch transparency hack": such skins filled it with black).
 */
function normalizeSkin(image) {
	const canvas = document.createElement('canvas');
	canvas.width = 64;
	canvas.height = 64;
	const g = canvas.getContext('2d');
	g.drawImage(image, 0, 0);
	const pixels = g.getImageData(0, 0, 64, 64);
	const d = pixels.data;
	const at = (x, y) => (y * 64 + x) * 4;
	const legacy = image.height === 32;
	if (legacy) {
		// NativeImage.copyRect(srcX, srcY, offsetX, offsetY, width, height, mirrorX, false)
		const copyRect = (sx, sy, ox, oy, w, h) => {
			for (let y = 0; y < h; y++) {
				for (let x = 0; x < w; x++) {
					const from = at(sx + x, sy + y);
					const to = at(sx + ox + (w - 1 - x), sy + oy + y);
					for (let k = 0; k < 4; k++) d[to + k] = d[from + k];
				}
			}
		};
		copyRect(4, 16, 16, 32, 4, 4);
		copyRect(8, 16, 16, 32, 4, 4);
		copyRect(0, 20, 24, 32, 4, 12);
		copyRect(4, 20, 16, 32, 4, 12);
		copyRect(8, 20, 8, 32, 4, 12);
		copyRect(12, 20, 16, 32, 4, 12);
		copyRect(44, 16, -8, 32, 4, 4);
		copyRect(48, 16, -8, 32, 4, 4);
		copyRect(40, 20, 0, 32, 4, 12);
		copyRect(44, 20, -8, 32, 4, 12);
		copyRect(48, 20, -16, 32, 4, 12);
		copyRect(52, 20, -8, 32, 4, 12);
	}
	const setNoAlpha = (x0, y0, x1, y1) => {
		for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) d[at(x, y) + 3] = 255;
	};
	setNoAlpha(0, 0, 32, 16);
	if (legacy) {
		let opaque = true;
		for (let x = 32; x < 64 && opaque; x++) for (let y = 0; y < 32; y++) if (d[at(x, y) + 3] < 128) { opaque = false; break; }
		if (opaque) for (let x = 32; x < 64; x++) for (let y = 0; y < 32; y++) d[at(x, y) + 3] = 0;
	}
	setNoAlpha(0, 16, 64, 32);
	setNoAlpha(16, 48, 48, 64);
	return pixels;
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
		this.maps = new Map();
		this.spawners = new Map();
		/** Lid, shake and similar animation state of block entities by "x,y,z", from block events. */
		this.blockAnims = new Map();
		this.breaking = [];
		this.states = new Map();
		this.events = new Map();
		/** Guardians' beams: entity id -> {target, start (the guardian's age when it got the target)} */
		this.beams = new Map();
		/** Blocks moved by pistons: "x,y,z" -> the "pm" effect and when it arrived */
		this.pistons = new Map();
		// EnchantingTableBlockEntity animation state by block position
		this.books = new Map();
		// glint textures switched to linear filtering (their .mcmeta asks for blur)
		this.blurred = new Set();
		// types drawn as a plain box this frame (no model or texture for them)
		this.boxed = new Set();
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
		this.shadowProgram = program(this.gl, SHADOW_VS, SHADOW_FS);
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
		this.shadowVao = gl.createVertexArray();
		this.shadowVbo = gl.createBuffer();
		gl.bindVertexArray(this.shadowVao);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.shadowVbo);
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
		gl.enableVertexAttribArray(1);
		gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 24, 12);
		gl.enableVertexAttribArray(2);
		gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 24, 20);
		gl.bindVertexArray(null);
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
		setEquipment(assets.bundle && assets.bundle.equipment);
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
		if (typeof path === 'object' && path.paletted) return this.palettedTexture(path.paletted, path.palette);
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

	/**
	 * PalettedTextureManager.getOrPrepare: a texture recoloured with a palette (armour trims: the pattern's
	 * grey texture with the trim material's colours). The texture's .mcmeta names its base palette; each
	 * colour of the base palette becomes the colour at the same place in the target palette (PaletteMapping).
	 * Without a palette (a trim override may say so) the texture is used as it is.
	 */
	palettedTexture(base, palette) {
		const key = 'paletted/' + base + '|' + (palette || '');
		let entry = this.textures.get(key);
		if (entry) return entry.texture;
		entry = { texture: null };
		this.textures.set(key, entry);
		const query = tokenSuffix('?');
		const url = id => {
			const [ns, path] = id.includes(':') ? id.split(':') : ['minecraft', id];
			return ns === 'minecraft' ? '/assets/' + path : null;
		};
		const image = id => {
			const u = url(id);
			if (!u) return Promise.reject(new Error('unknown namespace'));
			return fetch(u + '.png' + query, { credentials: 'same-origin' })
				.then(r => { if (!r.ok) throw new Error('missing'); return r.blob(); })
				.then(blob => createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }))
				.then(bitmap => {
					const canvas = document.createElement('canvas');
					canvas.width = bitmap.width;
					canvas.height = bitmap.height;
					const g = canvas.getContext('2d');
					g.drawImage(bitmap, 0, 0);
					return g.getImageData(0, 0, bitmap.width, bitmap.height);
				});
		};
		const meta = palette
			? fetch(url(base) + '.png.mcmeta' + query, { credentials: 'same-origin' }).then(r => (r.ok ? r.json() : null)).catch(() => null)
			: Promise.resolve(null);
		Promise.all([image(base), meta])
			.then(([pixels, mcmeta]) => {
				const basePalette = mcmeta && mcmeta.palette && mcmeta.palette.base_palette;
				if (!palette || !basePalette) return pixels;
				const ns = id => (id.includes(':') ? id : 'minecraft:' + id);
				const [from, to] = [ns(basePalette), ns(palette)].map(id => id.replace(':', ':palettes/'));
				return Promise.all([image(from), image(to)]).then(([a, b]) => {
					if (a.data.length !== b.data.length) return pixels;
					// PaletteMapping.create / apply
					const map = new Map();
					for (let i = 0; i < a.data.length; i += 4) {
						if (a.data[i + 3] !== 0) map.set((a.data[i] << 16) | (a.data[i + 1] << 8) | a.data[i + 2], i);
					}
					const d = pixels.data;
					for (let i = 0; i < d.length; i += 4) {
						if (d[i + 3] === 0) continue;
						const at = map.get((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
						if (at === undefined) continue;
						d[i] = b.data[at]; d[i + 1] = b.data[at + 1]; d[i + 2] = b.data[at + 2];
						d[i + 3] = Math.floor(d[i + 3] * b.data[at + 3] / 255);
					}
					return pixels;
				}, () => pixels);
			})
			.then(pixels => { entry.texture = this.createTexture(pixels); })
			.catch(() => { entry.failed = true; });
		return null;
	}

	/**
	 * The picture of a map in an item frame (MapTextureManager: the map's colours, sent by the server as
	 * RGBA), fetched again when the server reports a new version of it.
	 */
	mapTexture(id, version) {
		let entry = this.maps.get(id);
		if (!entry) {
			entry = { texture: null, version: null, loading: false };
			this.maps.set(id, entry);
		}
		if (entry.version !== version && !entry.loading) {
			entry.loading = true;
			const wanted = version;
			fetch('/map/' + id + '?v=' + encodeURIComponent(version) + tokenSuffix('&'), { credentials: 'same-origin' })
				.then(r => { if (!r.ok) throw new Error('missing'); return r.arrayBuffer(); })
				.then(buffer => {
					const pixels = new ImageData(new Uint8ClampedArray(buffer), 128, 128);
					if (entry.texture) this.gl.deleteTexture(entry.texture);
					entry.texture = this.createTexture(pixels);
				})
				.catch(() => {})
				.finally(() => { entry.version = wanted; entry.loading = false; });
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
			if (e.beam !== undefined) {
				// Guardian.onSyncedDataUpdated: the client's attack time starts over for every new target
				const beam = this.beams.get(e.id);
				if (!beam || beam.target !== e.beam) this.beams.set(e.id, { target: e.beam, start: e.age || 0 });
				e.beamStart = this.beams.get(e.id).start;
			} else if (this.beams.has(e.id)) {
				this.beams.delete(e.id);
			}
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
		// blocks being broken: [x, y, z, progress]
		this.breaking = frame.bp || [];
		for (const fx of frame.fx || []) {
			if (fx[0] === 'be') this.blockEvent(fx);
			else if (fx[0] === 'pm') this.pistonMove(fx, now);
		}
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
				rowL: num('rowL'), rowR: num('rowR'), hurtTime: num('hurtTime'), damage: num('damage'), bubble: num('bubble'),
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
		for (const [key, b] of this.books) if (now - b.seen > 5000) this.books.delete(key);
		if (this.states.size < 64) return;
		for (const [id, s] of this.states) if (now - s.seen > 5000) this.states.delete(id);
	}

	// --- building the frame ------------------------------------------------------------------------

	begin() {
		this.sink.reset();
		this.batches = [];
	}

	/** Records that the vertices emitted since `start` use this texture / mode. */
	batch(texture, mode, start, cull = true, glint = 0) {
		const count = this.sink.count - start;
		if (count <= 0) return;
		const last = this.batches[this.batches.length - 1];
		if (last && last.texture === texture && last.mode === mode && last.cull === cull && last.glint === glint && last.start + last.count === start) {
			last.count += count;
			return;
		}
		this.batches.push({ texture, mode, start, count, cull, glint });
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
		this.boxed.clear();
		const now = frame.now;
		const o = frame.origin, cam = frame.camPos;
		this.cameraWorld = [o[0] + cam[0], o[1] + cam[1], o[2] + cam[2]];
		this.byId = new Map();
		for (const e of list) this.byId.set(e.id, e);
		let visible = 0;
		for (const e of list) {
			const rx = e.x - o[0] - cam[0], ry = e.y - o[1] - cam[1], rz = e.z - o[2] - cam[2];
			const type = strip(e.type);
			if (type === 'lightning_bolt') {
				this.bolts.push({ x: rx, y: ry, z: rz, seed: e.seed || '0' });
				continue;
			}
			// Invisible mobs still show their equipment (and flames), invisible item frames their item or map;
			// other invisible entities show nothing.
			const showsInvisible = isKnownMob(type) || type === 'item_frame' || type === 'glow_item_frame';
			if (e.invisible && !e.burning && !showsInvisible) continue;
			const radius = Math.max(e.w || 1, e.h || 1) + 1;
			if (!frame.frustum(rx, ry + (e.h || 1) / 2, rz, radius * (type === 'happy_ghast' || type === 'ghast' ? 2 : 1))) continue;
			if (Math.hypot(rx, rz) > frame.fogEnd + 8) continue;
			visible++;
			const light = this.lightFor(e, world);
			try {
				if (!e.invisible || showsInvisible) this.drawEntity(e, type, [rx, ry, rz], light, now, world);
				// EntityRenderer.submit: burning entities (invisible ones too) are wrapped in flames.
				if (e.burning) this.drawFlame(e, [rx, ry, rz], light, frame.viewRotation);
			} catch (error) {
				console.warn('CCTV: could not draw', e.type, error);
			}
		}
		this.visibleCount = visible;
		this.drawLeashes(frame, list, world);
		const view = frame.viewRotation;
		this.text.begin();
		this.text.nameTags(this.collectNameTags(frame, list, world), [view[0], view[4], view[8]], [view[1], view[5], view[9]]);
		this.addSignText(frame, world);
		this.text.finish();
		if (this.assets) this.prepareBlockEntities(frame, world, list);
		this.upload();
		this.cleanupStates(now);
	}

	/**
	 * EntityRenderer's leash state and LeashFeatureRenderer: from where the leash is tied on the entity to the
	 * holder's hand (or knot), 24 steps of two crossed brown ribbons with alternating shades, sagging when slack,
	 * lit by the light at both ends. The server sends the holder and the tie offsets ("leash").
	 */
	drawLeashes(frame, list, world) {
		let byId = null;
		const o = frame.origin, cam = frame.camPos;
		for (const e of list) {
			if (!e.leash) continue;
			if (!byId) byId = new Map(list.map(x => [x.id, x]));
			const holder = byId.get(e.leash.h);
			if (!holder) continue;
			const pos = [e.x - o[0] - cam[0], e.y - o[1] - cam[1], e.z - o[2] - cam[2]];
			const holderPos = [holder.x - o[0] - cam[0], holder.y - o[1] - cam[1], holder.z - o[2] - cam[2]];
			const mid = [(pos[0] + holderPos[0]) / 2, (pos[1] + holderPos[1]) / 2, (pos[2] + holderPos[2]) / 2];
			const radius = Math.hypot(pos[0] - holderPos[0], pos[1] - holderPos[1], pos[2] - holderPos[2]) / 2 + 2;
			if (Math.hypot(mid[0], mid[2]) - radius > frame.fogEnd || !frame.frustum(mid[0], mid[1], mid[2], radius)) continue;
			const light = x => {
				const [sky, block] = world.lightAt(Math.floor(x.x), Math.floor(x.y + (x.h || 1) * 0.85), Math.floor(x.z));
				return [x.burning ? 15 : block, sky];
			};
			const [startBlock, startSky] = light(e), [endBlock, endSky] = light(holder);
			const leashes = e.leash.q
				? e.leash.q.map(([a, b]) => ({ offset: a, end: b, slack: false }))
				: [{ offset: e.leash.o, end: e.leash.e, slack: true }];
			for (const leash of leashes) {
				if (!leash.offset || !leash.end) continue;
				const start = [pos[0] + leash.offset[0], pos[1] + leash.offset[1], pos[2] + leash.offset[2]];
				const end = [holderPos[0] + leash.end[0], holderPos[1] + leash.end[1], holderPos[2] + leash.end[2]];
				this.emitLeash(start, end, leash.slack, startBlock, endBlock, startSky, endSky);
			}
		}
	}

	/** LeashFeatureRenderer.prepare: one triangle strip, forwards with the upper ribbon, back with the crossing one. */
	emitLeash(start, end, slack, startBlock, endBlock, startSky, endSky) {
		const dx = end[0] - start[0], dy = end[1] - start[1], dz = end[2] - start[2];
		const horizontal = Math.hypot(dx, dz);
		const offsetFactor = horizontal > 1e-6 ? 0.05 / 2 / horizontal : 0;
		const dxOff = dz * offsetFactor, dzOff = dx * offsetFactor;
		const strip = [];
		const pair = (k, fudge, backwards) => {
			const progress = k / 24;
			const block = Math.trunc(lerp(startBlock, endBlock, progress)), sky = Math.trunc(lerp(startSky, endSky, progress));
			const shade = k % 2 === (backwards ? 1 : 0) ? 0.7 : 1;
			const color = [0.5 * shade, 0.4 * shade, 0.3 * shade];
			const x = dx * progress, z = dz * progress;
			const y = slack ? (dy > 0 ? dy * progress * progress : dy - dy * (1 - progress) * (1 - progress)) : dy * progress;
			strip.push([x - dxOff, y + fudge, z + dzOff, color, block, sky], [x + dxOff, y + 0.05 - fudge, z - dzOff, color, block, sky]);
		};
		for (let k = 0; k <= 24; k++) pair(k, 0.05, false);
		for (let k = 24; k >= 0; k--) pair(k, 0, true);
		const sink = this.sink, startCount = sink.count;
		sink.ensure((strip.length - 2) * 3);
		const out = sink.data;
		for (let i = 0; i + 2 < strip.length; i++) {
			for (let j = 0; j < 3; j++) {
				const v = strip[i + j], q = sink.count++ * FLOATS;
				out[q] = start[0] + v[0]; out[q + 1] = start[1] + v[1]; out[q + 2] = start[2] + v[2];
				out[q + 3] = 0; out[q + 4] = 1; out[q + 5] = 0;
				out[q + 6] = 0.5; out[q + 7] = 0.5;
				out[q + 8] = v[3][0]; out[q + 9] = v[3][1]; out[q + 10] = v[3][2]; out[q + 11] = 1;
				out[q + 12] = v[4] * 16; out[q + 13] = v[5] * 16;
				out[q + 14] = 0; out[q + 15] = 0;
			}
		}
		this.batch(this.white, MODE_NOCULL, startCount, false);
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
		if (def.anim === 'guardian') {
			// GuardianRenderer.getEntityToLookAt: the beam's target, else the camera
			const eye = [e.x, e.y + (e.h || 0.85) * 0.5, e.z];
			const target = e.beam !== undefined && this.byId ? this.byId.get(e.beam) : null;
			anim.eyePos = eye;
			anim.lookAt = target ? [target.x, target.y + (target.h || 1.8) * 0.85, target.z] : this.cameraWorld;
		}
		anim.states = this.keyframeStates(type, e, s);
		anim.memory = anim.states.memory;
		if (def.fullBright) style.light = [240, style.light[1]];

		// LivingEntityRenderer.submit / setupRotations (a spawner's mob gets the spawner's pose)
		const m = e.base ? Float32Array.from(e.base) : mat4();
		translate(m, pos[0], pos[1], pos[2]);
		if (def.creepyShake && e.d && e.d.creepy) {
			// EndermanRenderer.getRenderOffset: a screaming enderman shakes
			const d = 0.02 * (e.scale || 1);
			translate(m, gaussian() * d, 0, gaussian() * d);
		}
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
			const glint = layer.foil && (e.foil & layer.foil) ? GLINT_ARMOR : 0;
			this.batch(texture, mode, start, mode !== MODE_NOCULL && mode !== MODE_TRANSLUCENT, glint);
		}
		if (!base) return this.drawBox(e, pos, style);

		// Held items (ItemInHandLayer).
		if (e.hand && base.parts.right_arm && base.parts.right_arm.visible) {
			this.drawHeld(base, m, 'right_arm', e.hand, e.foil & FOIL_HAND ? { ...style, glint: GLINT_ITEM } : style, 1, e.handPatterns);
		}
		if (e.offhand && base.parts.left_arm && base.parts.left_arm.visible) {
			this.drawHeld(base, m, 'left_arm', e.offhand, e.foil & FOIL_OFFHAND ? { ...style, glint: GLINT_ITEM } : style, -1, e.offhandPatterns);
		}

		// CarriedBlockLayer: the block an enderman holds in front of it
		if (def.carries && e.d && e.d.carried !== undefined) {
			const bm = Float32Array.from(m);
			translate(bm, 0, 0.6875, -0.75);
			rotate(bm, 0, 20 * DEG);
			rotate(bm, 1, 45 * DEG);
			translate(bm, 0.25, 0.1875, 0.25);
			scale(bm, -0.5, -0.5, 0.5);
			rotate(bm, 1, 90 * DEG);
			const mesh = this.blockStateMesh(e.d.carried, world);
			if (mesh) this.emitItem(mesh, bm, style);
		}
		if (def.anim === 'guardian' && e.beam !== undefined) this.drawGuardianBeam(e, type, pos, world);

		// EntityRenderDispatcher: no shadow under invisible entities
		if (!e.invisible && !e.base) this.shadowFor(e, pos, typeof mob.shadow === 'number' ? mob.shadow * entityScale : 0.5, world);
	}

	/**
	 * GuardianRenderer.renderBeam: two crossed strips from the guardian's eye to the middle of its target,
	 * turning, scrolling and brightening from purple to yellow as the attack charges.
	 */
	drawGuardianBeam(e, type, pos, world) {
		const target = this.byId && this.byId.get(e.beam);
		const texture = this.texture('guardian/guardian_beam');
		if (!target || !texture) return;
		const duration = type === 'elder_guardian' ? 60 : 80;
		const age = e.age || 0;
		const time = Math.min(duration, Math.max(0, age - (e.beamStart ?? age)));
		const attackScale = time / duration;
		const eyeHeight = (e.h || 0.85) * 0.5;
		const bx = target.x - e.x, by = target.y + (target.h || 1.8) * 0.5 - (e.y + eyeHeight), bz = target.z - e.z;
		let length = Math.hypot(bx, by, bz);
		if (length < 1e-4) return;
		const nx = bx / length, ny = by / length, nz = bz / length;
		length += 1;
		const m = mat4();
		translate(m, pos[0], pos[1] + eyeHeight, pos[2]);
		rotate(m, 1, PI / 2 - Math.atan2(nz, nx));
		rotate(m, 0, Math.acos(Math.max(-1, Math.min(1, ny))));
		const rot = time * 0.05 * -1.5;
		const c = attackScale * attackScale;
		const color = [(64 + Math.trunc(c * 191)) / 255, (32 + Math.trunc(c * 191)) / 255, (128 - Math.trunc(c * 64)) / 255, 1];
		const at = (angle, r) => [Math.cos(rot + angle) * r, Math.sin(rot + angle) * r];
		const [wnx, wnz] = at(PI * 3 / 4, 0.282), [enx, enz] = at(PI / 4, 0.282);
		const [wsx, wsz] = at(PI * 5 / 4, 0.282), [esx, esz] = at(PI * 7 / 4, 0.282);
		const [wx, wz] = at(PI, 0.2), [ex, ez] = at(0, 0.2), [nnx, nnz] = at(PI / 2, 0.2), [sx, sz] = at(PI * 3 / 2, 0.2);
		const minV = -1 + (time * 0.5) % 1, maxV = minV + length * 2.5;
		const vBase = Math.floor(time) % 2 === 0 ? 0.5 : 0;
		const quads = new Float32Array([
			wx, length, wz, 0.4999, maxV, wx, 0, wz, 0.4999, minV, ex, 0, ez, 0, minV, ex, length, ez, 0, maxV,
			nnx, length, nnz, 0.4999, maxV, nnx, 0, nnz, 0.4999, minV, sx, 0, sz, 0, minV, sx, length, sz, 0, maxV,
			wnx, length, wnz, 0.5, vBase + 0.5, enx, length, enz, 1, vBase + 0.5, esx, length, esz, 1, vBase, wsx, length, wsz, 0.5, vBase,
		]);
		const start = this.sink.count;
		this.sink.ensure(18);
		emitQuads(this.sink, quads, m, { color, light: [240, 240], overlay: [0, 0] });
		// setNormal(0, 1, 0): lit like the top of a block
		const out = this.sink.data;
		for (let i = start; i < this.sink.count; i++) {
			out[i * FLOATS + 3] = 0; out[i * FLOATS + 4] = 1; out[i * FLOATS + 5] = 0;
		}
		this.batch(texture, MODE_CUTOUT, start, false);
	}

	/** The model of a block state by id (as falling blocks and carried blocks show it), cached. */
	blockStateMesh(id, world) {
		const info = id !== undefined && world ? world.infos[id] : null;
		if (!info || !this.assets) return null;
		const key = 'state:' + id;
		if (this.itemMeshes.has(key)) return this.itemMeshes.get(key);
		let mesh = null;
		const dispatch = this.assets.models.dispatch(info.name, info.props);
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
		return mesh;
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

	/**
	 * EntityRenderer.extractShadow: a piece of textures/misc/shadow.png on top of every full block under the
	 * entity's shadow radius, fading with the depth below the entity and in the dark, and only within 16 blocks
	 * of the camera. Drawn by drawShadows like ShadowFeatureRenderer.
	 */
	shadowFor(e, pos, radius, world, strength = 1) {
		radius = Math.min(radius || 0, 32);
		if (radius <= 0) return;
		const pow = (1 - (pos[0] * pos[0] + pos[1] * pos[1] + pos[2] * pos[2]) / 256) * strength;
		if (pow <= 0) return;
		const x0 = Math.floor(e.x - radius), x1 = Math.floor(e.x + radius);
		const z0 = Math.floor(e.z - radius), z1 = Math.floor(e.z + radius);
		const depth = Math.min(pow / 0.5 - 1, radius);
		const y0 = Math.floor(e.y - depth), y1 = Math.floor(e.y);
		const sample = this.env && this.env.current;
		const skyDarken = sample && typeof sample.skyDarken === 'number' ? sample.skyDarken : 0;
		const ambient = (this.env && this.env.dim && this.env.dim.ambient) || 0;
		const out = this.shadows;
		for (let z = z0; z <= z1; z++) {
			for (let x = x0; x <= x1; x++) {
				for (let y = y0; y <= y1; y++) {
					// extractShadowPiece: on a visible block with a full collision shape, lit above 3
					const below = world.infoAt(x, y - 1, z);
					if (!below || !below.fullCollision || below.name === 'minecraft:barrier') continue;
					const [sky, block] = world.lightAt(x, y, z);
					const brightness = Math.max(block, sky - skyDarken);
					if (brightness <= 3) continue;
					// Lightmap.getBrightness
					const v = brightness / 15, curved = v / (4 - 3 * v);
					const alpha = clamp((pow - (e.y - y) * 0.5) * 0.5 * (curved + (1 - curved) * ambient), 0, 1);
					const rx0 = x - e.x, rx1 = rx0 + 1, rz0 = z - e.z, rz1 = rz0 + 1, ry = y - e.y;
					const u0 = -rx0 / 2 / radius + 0.5, u1 = -rx1 / 2 / radius + 0.5;
					const v0 = -rz0 / 2 / radius + 0.5, v1 = -rz1 / 2 / radius + 0.5;
					const px0 = pos[0] + rx0, px1 = pos[0] + rx1, py = pos[1] + ry, pz0 = pos[2] + rz0, pz1 = pos[2] + rz1;
					out.push(
						px0, py, pz0, u0, v0, alpha, px0, py, pz1, u0, v1, alpha, px1, py, pz1, u1, v1, alpha,
						px0, py, pz0, u0, v0, alpha, px1, py, pz1, u1, v1, alpha, px1, py, pz0, u1, v0, alpha);
				}
			}
		}
	}

	drawBox(e, pos, style) {
		// Unknown entity: its hitbox as a plain box, so it is at least visible.
		this.boxed.add(e.type);
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
		// AbstractBoatModel.animatePaddle with the rowing times (AbstractBoat.getRowingTime)
		const paddle = (part, time, right) => {
			if (!part) return;
			const clamped = (t, a, b) => a + (b - a) * Math.max(0, Math.min(1, t));
			part.xRot = clamped((Math.sin(-time) + 1) / 2, -PI / 3, -PI / 12);
			part.yRot = clamped((Math.sin(-time + 1) + 1) / 2, -PI / 4, PI / 4);
			if (right) part.yRot = PI - part.yRot;
		};
		paddle(model.parts.left_paddle, e.rowL || 0, false);
		paddle(model.parts.right_paddle, e.rowR || 0, true);
		const m = mat4();
		translate(m, pos[0], pos[1] + 0.375, pos[2]);
		rotate(m, 1, (180 - (e.yaw || 0)) * DEG);
		// AbstractBoatRenderer.submit: a hit boat rocks, a boat over a bubble column tilts
		const hurt = e.hurtTime || 0;
		if (hurt > 0) rotate(m, 0, Math.sin(hurt) * hurt * (e.damage || 0) / 10 * (e.hurtDir || 1) * DEG);
		if (e.bubble) {
			const t = new Float32Array(16);
			const angle = e.bubble * DEG, c = Math.cos(angle), s = Math.sin(angle), k = 1 - c, h = Math.SQRT1_2;
			// rotation about the axis (1, 0, 1) (column-major)
			t.set([c + h * h * k, h * s, h * h * k, 0, -h * s, c, h * s, 0, h * h * k, -h * s, c + h * h * k, 0, 0, 0, 0, 1]);
			m.set(mul(m, t));
		}
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
		this.batch(this.assets.texture, MODE_NOCULL, start, false, style.glint || 0);
	}

	drawDroppedItem(e, pos, style) {
		const shield = isShield(e.item);
		const mesh = shield ? null : this.itemMesh(e.item);
		if (!mesh && !shield) return this.drawBox(e, pos, style);
		const age = e.age || 0;
		const bobOffset = (e.id * 0.618) % (Math.PI * 2);
		const bob = Math.sin(age / 10 + bobOffset) * 0.1 + 0.1;
		const m = mat4();
		// ItemEntityRenderer: bob, spin, then the model's "ground" transform resting on its lowest point.
		translate(m, pos[0], pos[1] + bob + (!mesh || mesh.kind === 'block' ? 0.0625 : 0.125), pos[2]);
		rotate(m, 1, age / 20 + bobOffset);
		if (shield) {
			this.drawShield(m, 'ground', e.foil & FOIL_ITEM ? { ...style, glint: GLINT_ITEM } : style, e.itemPatterns);
			this.shadowFor(e, pos, 0.15, this.world, 0.75);
			return;
		}
		const fallback = mesh.kind === 'block'
			? { translation: [0, 3, 0], scale: [0.25, 0.25, 0.25] }
			: { translation: [0, 2, 0], scale: [0.5, 0.5, 0.5] };
		this.applyDisplay(m, this.displayTransform(e.item, 'ground', fallback), false);
		this.emitItem(mesh, m, e.foil & FOIL_ITEM ? { ...style, glint: GLINT_ITEM } : style);
		this.shadowFor(e, pos, 0.15, this.world, 0.75);
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

	drawHeld(model, m, arm, item, style, side, patterns) {
		const shield = isShield(item);
		const mesh = shield ? null : this.itemMesh(item);
		if (!mesh && !shield) return;
		const pm = partMatrix(model, arm, m);
		if (!pm) return;
		// ItemInHandLayer: from the arm (block units), rotate -90 X and 180 Y, move into the fist.
		scale(pm, 16);
		rotate(pm, 0, -90 * DEG);
		rotate(pm, 1, 180 * DEG);
		translate(pm, side / 16, 0.125, -0.625);
		const slot = side > 0 ? 'thirdperson_righthand' : 'thirdperson_lefthand';
		if (shield) return this.drawShield(pm, slot, style, patterns);
		const fallback = mesh.kind === 'block'
			? { rotation: [75, 45, 0], translation: [0, 2.5, 0], scale: [0.375, 0.375, 0.375] }
			: { rotation: [0, 0, 0], translation: [0, 3, 1], scale: [0.55, 0.55, 0.55] };
		// ItemTransform.apply(leftHand): the left hand mirrors the translation and the Y and Z turns
		this.applyDisplay(pm, this.displayTransform(item, slot, fallback), side < 0);
		this.emitItem(mesh, pm, style);
	}

	/**
	 * ShieldSpecialRenderer: the shield model after the item's display transform (models/item/shield.json),
	 * the handle and plate with the base texture, then like BannerRenderer.submitPatterns the base colour and
	 * every pattern layer (entity/shield/<pattern>) over the plate in their dye colours.
	 */
	drawShield(m, slot, style, patterns) {
		const model = this.library.get('minecraft:shield#main');
		if (!model || !model.parts.plate) return;
		this.applyDisplay(m, this.displayTransform('minecraft:shield', slot, SHIELD_DISPLAY[slot] || {}), slot.endsWith('lefthand'));
		scale(m, 1, -1, -1);
		const hasPatterns = !!patterns && (!!patterns.b || !!(patterns.p && patterns.p.length));
		const base = this.texture(hasPatterns ? 'shield/base' : 'shield/base_nopattern');
		if (!base) return;
		model.reset();
		let start = this.sink.count;
		emitModel(this.sink, model, m, style);
		this.batch(base, MODE_CUTOUT, start, true, style.glint || 0);
		if (!hasPatterns) return;
		const handle = model.parts.handle;
		if (handle) handle.visible = false;
		const layer = (texture, color) => {
			if (!texture) return;
			start = this.sink.count;
			emitModel(this.sink, model, m, { ...style, color, glint: 0 });
			this.batch(texture, MODE_TRANSLUCENT, start, false);
		};
		layer(this.texture('shield/base'), dyeRgb(patterns.b || 'white'));
		for (const [asset, color] of (patterns.p || []).slice(0, 16)) {
			layer(this.texture('shield/' + String(asset).replace(/^[a-z0-9_.-]+:/, '')), dyeRgb(color));
		}
		if (handle) handle.visible = true;
	}

	/**
	 * ItemFrameRenderer.submit: the frame block model (the bigger one around a map, none when the frame is
	 * invisible) around its block's centre, turned to its facing; then the map picture (MapRenderer) or the
	 * item with its "fixed" display transform, turned in eighths.
	 */
	drawItemFrame(e, type, pos, style) {
		const d = e.d || {};
		const facing = FACING_STEP[d.facing] ? d.facing : 'south';
		const step = FACING_STEP[facing];
		const m = mat4();
		// the entity hangs 0.46875 off its block's centre, towards the wall
		translate(m, pos[0] + step[0] * 0.46875, pos[1] + step[1] * 0.46875, pos[2] + step[2] * 0.46875);
		const horizontal = step[1] === 0;
		rotate(m, 0, (horizontal ? 0 : -90 * step[1]) * DEG);
		rotate(m, 1, (horizontal ? 180 - FACING_YROT[facing] : 180) * DEG);
		const glow = type === 'glow_item_frame';
		const hasMap = e.map !== undefined;
		if (!e.invisible) {
			const frame = new Float32Array(m);
			translate(frame, -0.5, -0.5, -0.5);
			this.emitBlock(glow ? 'minecraft:glow_item_frame' : 'minecraft:item_frame', frame, style, false, hasMap ? 'map' : true);
		}
		translate(m, 0, 0, e.invisible ? 0.5 : 0.4375);
		const rotation = Number(d.rotation) || 0;
		if (hasMap) {
			const texture = this.mapTexture(e.map, e.mapv);
			rotate(m, 2, (rotation % 4) * 2 * 45 * DEG);
			rotate(m, 2, 180 * DEG);
			scale(m, 1 / 128);
			translate(m, -64, -64, -1);
			// getLightCoords: a glow frame lights its map at 15728850 (block 210, sky 240)
			if (texture) this.drawMap(e, m, glow ? { ...style, light: [210, 240] } : style, texture);
		} else if (isShield(e.item)) {
			rotate(m, 2, rotation * 45 * DEG);
			scale(m, 0.5);
			this.drawShield(m, 'fixed', glow ? { ...style, light: [240, 240] } : style, e.itemPatterns);
		} else if (e.item) {
			const mesh = this.itemMesh(e.item);
			if (mesh) {
				rotate(m, 2, rotation * 45 * DEG);
				scale(m, 0.5);
				const fallback = mesh.kind === 'block' ? { scale: [0.5, 0.5, 0.5] } : { rotation: [0, 180, 0] };
				this.applyDisplay(m, this.displayTransform(e.item, 'fixed', fallback), false);
				// getLightCoords: a glow frame lights its item at 15728880 (full)
				const itemStyle = glow ? { ...style, light: [240, 240] } : { ...style };
				if (e.foil & FOIL_ITEM) itemStyle.glint = GLINT_ITEM;
				this.emitItem(mesh, m, itemStyle);
			}
		}
	}

	/**
	 * MapRenderer.render (showOnlyFrame): the 128 x 128 picture at z -0.01 and the decorations shown on
	 * frames (banners, markers...) as sprites of textures/map/decorations, 8 map pixels big.
	 */
	drawMap(e, m, style, texture) {
		this.emitFlat(new Float32Array([
			0, 128, -0.01, 0, 1, 128, 128, -0.01, 1, 1,
			128, 0, -0.01, 1, 0, 0, 0, -0.01, 0, 0,
		]), m, style, texture);
		let count = 0;
		for (const [sprite, x, y, rot] of e.mapd || []) {
			const icon = this.texture('decorations/' + String(sprite).replace(/^minecraft:/, ''), 'map');
			if (icon) {
				const dm = new Float32Array(m);
				translate(dm, x / 2 + 64, y / 2 + 64, -0.02);
				rotate(dm, 2, rot * 360 / 16 * DEG);
				scale(dm, 4, 4, 3);
				translate(dm, -0.125, 0.125, 0);
				const z = count * -0.001;
				this.emitFlat(new Float32Array([
					-1, 1, z, 0, 0, 1, 1, z, 1, 0,
					1, -1, z, 1, 1, -1, -1, z, 0, 1,
				]), dm, style, icon);
			}
			count++;
		}
	}

	/** A flat textured quad lit without the shading of entity faces (text render type). */
	emitFlat(quad, m, style, texture) {
		const start = this.sink.count;
		this.sink.ensure(6);
		emitQuads(this.sink, quad, m, { ...style, color: [1, 1, 1, 1] });
		// upward normals: full brightness in the entity shader, like the text pipeline
		const out = this.sink.data;
		for (let i = start; i < this.sink.count; i++) {
			out[i * FLOATS + 3] = 0; out[i * FLOATS + 4] = 1; out[i * FLOATS + 5] = 0;
		}
		this.batch(texture, MODE_NOCULL, start, false);
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
		const key = 'block:' + name + (frameModel ? ':frame' + (frameModel === 'map' ? ':map' : '') : '');
		let mesh = this.itemMeshes.get(key);
		if (mesh === undefined) {
			mesh = null;
			const models = this.assets.models;
			const dispatch = models && models.dispatch(name, frameModel ? { map: frameModel === 'map' ? 'true' : 'false' } : { __item: true });
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
		const m = mat4();
		translate(m, pos[0] - 0.5, pos[1], pos[2] - 0.5);
		const mesh = this.blockStateMesh(e.d && e.d.block, world);
		if (mesh) return this.emitItem(mesh, m, style);
		return this.drawBox(e, pos, style);
	}

	// --- block entities (chests, shulker boxes, heads, banners, bells, pots) ---------------------------

	/**
	 * SpawnerRenderer / TrialSpawnerRenderer: the spawner's mob, small, tilted and spinning inside the cage.
	 * A spawner spins its mob while a player (here: the camera) is within 16 blocks, faster as its next spawn
	 * nears (BaseSpawner.clientTick); a trial spawner by its state. The mob is not ticked, so it does not move.
	 */
	drawSpawner(be, pos, world) {
		const data = world.blockEntityAt(be.x, be.y, be.z);
		if (!data || data.k !== 'spawner' || !data.e) return;
		const key = be.x + ',' + be.y + ',' + be.z;
		let s = this.spawners.get(key);
		const tick = performance.now() / 50;
		if (!s) this.spawners.set(key, s = { spin: 0, oSpin: 0, delay: 20, tick: Math.floor(tick) });
		const trial = be.info.shortName === 'trial_spawner';
		const trialSpeed = { waiting_for_players: 200, active: 1000 }[be.info.props && be.info.props.trial_spawner_state] || 0;
		const near = Math.hypot(pos[0] + 0.5, pos[1] + 0.5, pos[2] + 0.5) <= 16;
		for (let steps = 0; s.tick < Math.floor(tick) && steps < 40; steps++, s.tick++) {
			s.oSpin = s.spin;
			if (trial) {
				s.spin = (s.spin + trialSpeed / 200) % 360;
			} else if (near) {
				if (s.delay > 0) s.delay--;
				s.spin = (s.spin + 1000 / (s.delay + 200)) % 360;
			}
		}
		s.tick = Math.floor(tick);
		const spin = (s.oSpin + (s.spin - s.oSpin) * (tick % 1)) * 10;
		const m = mat4();
		translate(m, pos[0] + 0.5, pos[1] + 0.4, pos[2] + 0.5);
		rotate(m, 1, spin * DEG);
		translate(m, 0, -0.2, 0);
		rotate(m, 0, -30 * DEG);
		const size = Math.max(Number(data.w) || 0, Number(data.h) || 0);
		scale(m, 0.53125 / (size > 1 ? size : 1));
		const [sky, block] = world.lightAt(be.x, be.y, be.z);
		const e = { id: -1 - (Math.abs(be.x * 31 + be.y * 17 + be.z * 13) % 100000), type: data.e, x: be.x + 0.5, y: be.y, z: be.z + 0.5,
			yaw: 0, body: 0, head: 0, pitch: 0, age: 0, w: data.w, h: data.h, base: m };
		this.drawEntity(e, strip(data.e), [0, 0, 0], [block * 16, sky * 16], performance.now(), world);
	}

	/**
	 * LevelRenderer.submitBlockDestroyAnimation: the cracks of the blocks being broken within 32 blocks, the
	 * block's own model drawn with the destroy stage texture, its coordinates projected on each face like
	 * SheetedDecalTextureGenerator (the stage texture once per block face).
	 */
	drawBreaking(frame, world) {
		if (!this.breaking || !this.breaking.length || !this.assets) return;
		const o = frame.origin, cam = frame.camPos;
		const stages = new Map();
		for (const [x, y, z, progress] of this.breaking) {
			const key = x + ',' + y + ',' + z;
			stages.set(key, Math.max(stages.get(key) ?? -1, progress));
		}
		for (const [key, progress] of stages) {
			const [x, y, z] = key.split(',').map(Number);
			const bx = x - o[0] - cam[0], by = y - o[1] - cam[1], bz = z - o[2] - cam[2];
			if ((bx + 0.5) ** 2 + (by + 0.5) ** 2 + (bz + 0.5) ** 2 > 1024) continue;
			const texture = this.destroyStage(progress);
			const info = world.infoAt(x, y, z);
			if (!texture || !info || info.noModel) continue;
			const dispatch = this.assets.models.dispatch(info.name, info.props);
			if (!dispatch) continue;
			const parts = [];
			const random = new JavaRandom();
			random.setSeedNumber(42);
			collectParts(dispatch, random, parts);
			const data = [];
			for (const part of parts) {
				for (const list of part.quads) {
					for (const q of list) {
						const p = q.pos;
						const e1 = [p[3] - p[0], p[4] - p[1], p[5] - p[2]], e2 = [p[6] - p[0], p[7] - p[1], p[8] - p[2]];
						const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
						// Direction.getApproximateNearest, then the face's projection of the block coordinates
						const axis = Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2]) ? 0 : Math.abs(n[1]) >= Math.abs(n[2]) ? 1 : 2;
						const face = axis === 0 ? (n[0] > 0 ? 'east' : 'west') : axis === 1 ? (n[1] > 0 ? 'up' : 'down') : (n[2] > 0 ? 'south' : 'north');
						for (let k = 0; k < 4; k++) {
							const vx = p[k * 3], vy = p[k * 3 + 1], vz = p[k * 3 + 2];
							const [u, v] = DECAL_UV[face](vx, vy, vz);
							data.push(vx, vy, vz, u, v);
						}
					}
				}
			}
			if (!data.length) continue;
			const m = mat4();
			translate(m, bx, by, bz);
			const start = this.sink.count;
			this.sink.ensure(data.length / 20 * 6);
			emitQuads(this.sink, new Float32Array(data), m, { color: [1, 1, 1, 1], light: [240, 240], overlay: [0, 0] });
			this.batch(texture, MODE_CRUMBLING, start, false);
		}
	}

	/** The destroy_stage_N texture of the block textures, as its own repeating texture. */
	destroyStage(progress) {
		const key = 'destroy/' + progress;
		let entry = this.textures.get(key);
		if (entry) return entry.texture;
		entry = { texture: null };
		this.textures.set(key, entry);
		const b64 = this.assets.bundle.textures && this.assets.bundle.textures['minecraft:block/destroy_stage_' + progress];
		if (!b64) return null;
		fetch('data:image/png;base64,' + b64)
			.then(r => r.blob())
			.then(blob => createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }))
			.then(image => { entry.texture = this.createTexture(image); })
			.catch(() => { entry.failed = true; });
		return null;
	}

	/**
	 * A block event from the server (ClientboundBlockEventPacket), as the block entity's triggerEvent takes it:
	 * chests and ender chests (1, open count: ChestLidController.shouldBeOpen), shulker boxes (1, open count:
	 * opening or closing), bells (1, the side that was hit: shaking for 50 ticks).
	 */
	blockEvent([, x, y, z, block, a, b]) {
		const name = strip(block);
		const key = x + ',' + y + ',' + z;
		const tick = Math.floor(performance.now() / 50);
		if (a !== 1) return;
		if (/(^|_)chest$/.test(name)) {
			const anim = this.blockAnim(key) || { kind: 'chest', openness: 0, oOpenness: 0, tick };
			anim.open = b > 0;
			this.blockAnims.set(key, anim);
		} else if (/shulker_box$/.test(name)) {
			const anim = this.blockAnim(key) || { kind: 'shulker', status: 'closed', progress: 0, progressOld: 0, tick };
			if (b === 0) anim.status = 'closing';
			if (b === 1) anim.status = 'opening';
			this.blockAnims.set(key, anim);
		} else if (name === 'bell') {
			this.blockAnims.set(key, { kind: 'bell', shaking: true, ticks: 0, direction: b, tick });
		}
	}

	/** The block entity's animation state, ticked up to now (ChestLidController.tickLid, ShulkerBoxBlockEntity.updateAnimation, BellBlockEntity.tick). */
	blockAnim(key) {
		const anim = this.blockAnims.get(key);
		if (!anim) return null;
		const now = Math.floor(performance.now() / 50);
		for (let steps = 0; anim.tick < now && steps < 60; steps++, anim.tick++) {
			if (anim.kind === 'chest') {
				anim.oOpenness = anim.openness;
				if (!anim.open && anim.openness > 0) anim.openness = Math.max(anim.openness - 0.1, 0);
				else if (anim.open && anim.openness < 1) anim.openness = Math.min(anim.openness + 0.1, 1);
			} else if (anim.kind === 'shulker') {
				anim.progressOld = anim.progress;
				if (anim.status === 'closed') anim.progress = 0;
				else if (anim.status === 'opening') {
					anim.progress += 0.1;
					if (anim.progress >= 1) { anim.status = 'opened'; anim.progress = 1; }
				} else if (anim.status === 'opened') anim.progress = 1;
				else if (anim.status === 'closing') {
					anim.progress -= 0.1;
					if (anim.progress <= 0) { anim.status = 'closed'; anim.progress = 0; }
				}
			} else if (anim.kind === 'bell' && anim.shaking) {
				anim.ticks++;
				if (anim.ticks >= 50) { anim.shaking = false; anim.ticks = 0; }
			}
		}
		anim.tick = now;
		// nothing left to show: forget it
		if ((anim.kind === 'chest' && !anim.open && anim.openness === 0 && anim.oOpenness === 0)
			|| (anim.kind === 'shulker' && anim.status === 'closed' && anim.progressOld === 0)
			|| (anim.kind === 'bell' && !anim.shaking)) {
			this.blockAnims.delete(key);
		}
		return anim;
	}

	/** ChestRenderer: the openness of a chest (the larger of both halves of a double chest), eased like the game. */
	chestOpenness(pos, props) {
		if (!pos) return 0;
		const partial = (performance.now() / 50) % 1;
		const at = (x, z) => {
			const anim = this.blockAnims.size ? this.blockAnim(x + ',' + pos.y + ',' + z) : null;
			return anim && anim.kind === 'chest' ? anim.oOpenness + (anim.openness - anim.oOpenness) * partial : 0;
		};
		let open = at(pos.x, pos.z);
		if (props && (props.type === 'left' || props.type === 'right')) {
			// ChestBlock.getConnectedDirection: the left half's partner is clockwise of its facing
			const cw = { north: [1, 0], east: [0, 1], south: [-1, 0], west: [0, -1] }[props.facing || 'north'] || [1, 0];
			const d = props.type === 'left' ? cw : [-cw[0], -cw[1]];
			open = Math.max(open, at(pos.x + d[0], pos.z + d[1]));
		}
		open = 1 - open;
		return 1 - open * open * open;
	}

	/**
	 * A block starts moving with a piston (PistonMovingBlockEntity): shown right away, like the block changes
	 * that come with it, not with the entities' delay.
	 */
	pistonMove([, x, y, z, sx, sy, sz, extending, progress, block, shortBlock, base, shortAbove, final], now) {
		this.pistons.set(x + ',' + y + ',' + z, { x, y, z, sx, sy, sz, extending, progress, block, shortBlock, base, shortAbove, final, start: now });
		if (this.pistons.size > 512) this.pistons.delete(this.pistons.keys().next().value);
	}

	/**
	 * PistonHeadRenderer: moving blocks drawn between where they were and where they go (the progress rises by
	 * 0.5 a tick), a piston head short while it slides through its base, a retracting piston's base in place.
	 * A moving block is kept until its place shows the block it becomes (the server sends that block, not the
	 * moving piston, which players simulate themselves).
	 */
	drawPistons(frame, world) {
		if (!this.pistons.size) return;
		const o = frame.origin, cam = frame.camPos;
		const now = frame.now;
		for (const [key, p] of this.pistons) {
			const ticks = (now - p.start) / 50;
			const progress = Math.min(1, p.progress + 0.5 * ticks);
			if ((progress >= 1 && (world.getBlockId(p.x, p.y, p.z) === p.final || ticks > 10)) || ticks > 40) {
				this.pistons.delete(key);
				continue;
			}
			const bx = p.x - o[0] - cam[0], by = p.y - o[1] - cam[1], bz = p.z - o[2] - cam[2];
			if (!frame.frustum(bx + 0.5, by + 0.5, bz + 0.5, 2)) continue;
			const offset = p.extending ? progress - 1 : 1 - progress;
			const isShort = p.shortBlock >= 0 && (p.shortAbove ? progress >= 0.5 : progress <= 0.5);
			const [sky, blockLight] = world.lightAt(p.x, p.y, p.z);
			const style = { color: [1, 1, 1, 1], light: [blockLight * 16, sky * 16], overlay: [0, 0] };
			const mesh = this.blockStateMesh(isShort ? p.shortBlock : p.block, world);
			if (mesh) {
				const m = mat4();
				translate(m, bx + p.sx * offset, by + p.sy * offset, bz + p.sz * offset);
				this.emitItem(mesh, m, style);
			}
			if (p.base >= 0) {
				const baseMesh = this.blockStateMesh(p.base, world);
				if (baseMesh) {
					const m = mat4();
					translate(m, bx, by, bz);
					this.emitItem(baseMesh, m, style);
				}
			}
		}
	}

	prepareBlockEntities(frame, world, list) {
		const o = frame.origin, cam = frame.camPos;
		this.drawBreaking(frame, world);
		this.drawPistons(frame, world);
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
				if (be.info.shortName === 'campfire' || be.info.shortName === 'soul_campfire') {
					if (Math.hypot(bx, by, bz) <= Math.min(frame.fogEnd, 64) && frame.frustum(bx + 0.5, by + 0.5, bz + 0.5, 1.5)) this.drawCampfireItems(be, [bx, by, bz], world);
					continue;
				}
				if (be.info.shortName === 'end_portal' || be.info.shortName === 'end_gateway') {
					this.addPortal(be, [bx, by, bz], frame, world);
					continue;
				}
				if (be.info.shortName === 'spawner' || be.info.shortName === 'trial_spawner') {
					if (Math.hypot(bx, by, bz) <= Math.min(frame.fogEnd, 64) && frame.frustum(bx + 0.5, by + 0.5, bz + 0.5, 1.5)) this.drawSpawner(be, [bx, by, bz], world);
					continue;
				}
				if (be.info.shortName === 'enchanting_table' || be.info.shortName === 'lectern') {
					if (Math.hypot(bx, by, bz) <= Math.min(frame.fogEnd, 64) && frame.frustum(bx + 0.5, by + 1, bz + 0.5, 1.5)) this.drawBook(be, [bx, by, bz], frame, world, list);
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

	/** CampfireRenderer: the food on each side, lying flat and turned to its side, cooked on the fire. */
	drawCampfireItems(be, p, world) {
		const data = world.blockEntityAt(be.x, be.y, be.z);
		if (!data || data.k !== 'campfire' || !data.i) return;
		const [sky, block] = world.lightAt(be.x, be.y, be.z);
		const style = { color: [1, 1, 1, 1], light: [block * 16, sky * 16], overlay: [0, 0] };
		// Direction.get2DDataValue / toYRot: south, west, north, east
		const FACING = { south: 0, west: 1, north: 2, east: 3 };
		const facing = FACING[be.info.props.facing] ?? 2;
		data.i.forEach((item, slot) => {
			if (!item) return;
			const mesh = this.itemMesh(item);
			if (!mesh) return;
			const m = mat4();
			translate(m, p[0] + 0.5, p[1] + 0.44921875, p[2] + 0.5);
			rotate(m, 1, -((slot + facing) % 4) * 90 * DEG);
			rotate(m, 0, 90 * DEG);
			translate(m, -0.3125, -0.3125, 0);
			scale(m, 0.375);
			// the item's FIXED display transform: generated items turn round, block items are half size
			if (mesh.kind === 'block') scale(m, 0.5);
			else rotate(m, 1, 180 * DEG);
			translate(m, -0.5, -0.5, -0.5);
			this.emitItem(mesh, m, style);
		});
	}

	/**
	 * EnchantTableRenderer: the book floating over the table, turning to the nearest player and opening with its
	 * pages flipping (EnchantingTableBlockEntity.bookAnimationTick, stepped once a game tick). LecternRenderer: the
	 * open book lying on a lectern.
	 */
	drawBook(be, p, frame, world, list) {
		const m = mat4();
		let state;
		if (be.info.shortName === 'lectern') {
			if (be.info.props.has_book !== 'true') return;
			// Direction.getClockWise().toYRot()
			const yRot = { north: 270, east: 0, south: 90, west: 180 }[be.info.props.facing] ?? 270;
			translate(m, p[0] + 0.5, p[1] + 1.0625, p[2] + 0.5);
			rotate(m, 1, -yRot * DEG);
			rotate(m, 2, 67.5 * DEG);
			translate(m, 0, -0.125, 0);
			state = bookState(0, 0.1, 0.9, 1.2);
		} else {
			const now = this.env ? this.env.gameTime(frame.now) : frame.now / 50;
			const tick = Math.floor(now), partial = now - tick;
			const key = be.x + ',' + be.y + ',' + be.z;
			let b = this.books.get(key);
			if (!b || tick < b.tick) {
				b = { tick, time: 0, flip: 0, oFlip: 0, flipT: 0, flipA: 0, open: 0, oOpen: 0, rot: 0, oRot: 0, tRot: 0 };
				this.books.set(key, b);
			}
			b.seen = frame.now;
			// a table out of sight for long catches up on the last 100 ticks, enough to settle
			if (tick - b.tick > 100) {
				b.time += tick - 100 - b.tick;
				b.tick = tick - 100;
			}
			for (; b.tick < tick; b.tick++) bookAnimationTick(b, be, list);
			// extractRenderState
			const flip = lerp(b.oFlip, b.flip, partial), open = lerp(b.oOpen, b.open, partial), time = b.time + partial;
			const yRot = b.oRot + wrapRadians(b.rot - b.oRot) * partial;
			translate(m, p[0] + 0.5, p[1] + 0.75, p[2] + 0.5);
			translate(m, 0, 0.1 + Math.sin(time * 0.1) * 0.01, 0);
			rotate(m, 1, -yRot);
			rotate(m, 2, 80 * DEG);
			const ff1 = frac(flip + 0.25) * 1.6 - 0.3, ff2 = frac(flip + 0.75) * 1.6 - 0.3;
			state = bookState(time, clamp(ff1, 0, 1), clamp(ff2, 0, 1), open);
		}
		const model = this.library.get('minecraft:book#main');
		const texture = this.texture('enchantment/enchanting_table_book');
		if (!model || !texture) return;
		model.reset();
		// BookModel.setupAnim
		const parts = model.parts, o = state.openness;
		parts.left_lid.yRot = Math.PI + o;
		parts.right_lid.yRot = -o;
		parts.left_pages.yRot = o;
		parts.right_pages.yRot = -o;
		parts.flip_page1.yRot = o - o * 2 * state.pageFlip1;
		parts.flip_page2.yRot = o - o * 2 * state.pageFlip2;
		for (const name of ['left_pages', 'right_pages', 'flip_page1', 'flip_page2']) parts[name].x = Math.sin(o);
		const [sky, block] = world.lightAt(be.x, be.y, be.z);
		const start = this.sink.count;
		emitModel(this.sink, model, m, { color: [1, 1, 1, 1], light: [block * 16, sky * 16], overlay: [0, 0] });
		this.batch(texture, MODE_CUTOUT, start);
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
				// ChestModel.setupAnim: the lid and the lock turn up with the openness
				const open = this.chestOpenness(pos, def.props);
				emit(def.layer, def.texture, m, null, MODE_CUTOUT, parts => {
					if (parts.lid) parts.lid.xRot = -(open * Math.PI / 2);
					if (parts.lock) parts.lock.xRot = -(open * Math.PI / 2);
				});
				break;
			}
			case 'shulker_box': {
				translate(m, 0.5, 0.5, 0.5);
				scale(m, 0.9995);
				const f = { up: null, down: [0, 180], north: [0, 90], south: [0, -90], west: [2, -90], east: [2, 90] }[def.facing];
				if (f) rotate(m, f[0], f[1] * DEG);
				scale(m, 1, -1, -1);
				translate(m, 0, -1, 0);
				// ShulkerBoxModel.setupAnim: the lid rises half a block and turns 270 degrees as it opens
				const anim = pos && this.blockAnims.size ? this.blockAnim(pos.x + ',' + pos.y + ',' + pos.z) : null;
				const progress = anim && anim.kind === 'shulker' ? anim.progressOld + (anim.progress - anim.progressOld) * ((performance.now() / 50) % 1) : 0;
				emit(def.layer, def.texture, m, null, MODE_CUTOUT, parts => {
					if (!parts.lid || !progress) return;
					parts.lid.y = 24 - progress * 0.5 * 16;
					parts.lid.yRot = 270 * progress * DEG;
				});
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
			case 'bell': {
				// BellModel.setupAnim: the bell swings away from the side that was hit, dying down over 50 ticks
				const anim = pos && this.blockAnims.size ? this.blockAnim(pos.x + ',' + pos.y + ',' + pos.z) : null;
				emit(def.layer, def.texture, m, null, MODE_CUTOUT, parts => {
					const body = parts.bell_body;
					if (!body || !anim || anim.kind !== 'bell' || !anim.shaking) return;
					const ticks = anim.ticks + (performance.now() / 50) % 1;
					const sin = Math.sin(ticks / Math.PI) / (4 + ticks / 3);
					if (anim.direction === 2) body.xRot = -sin;
					else if (anim.direction === 3) body.xRot = sin;
					else if (anim.direction === 5) body.zRot = -sin;
					else if (anim.direction === 4) body.zRot = sin;
				});
				break;
			}
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

		// TextureTransform glint matrices of this frame and their textures (blurred, repeating)
		const glints = {};
		for (const [kind, g] of Object.entries(GLINTS)) {
			const texture = this.texture(g.texture, 'misc');
			if (texture && !this.blurred.has(texture)) {
				gl.bindTexture(gl.TEXTURE_2D, texture);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
				this.blurred.add(texture);
			}
			const scale = g.atlas && this.assets ? g.scale * this.assets.atlasSize / 512 : g.scale;
			glints[kind] = { texture, matrix: glintMatrix(scale, performance.now()) };
		}
		gl.uniform1f(u.uGlintAlpha, GLINT_ALPHA);
		gl.uniform1i(u.uGlintTexture, 5);
		let glintOn = -1;
		const drawBatches = filter => {
			for (const b of this.batches) {
				if (!filter(b)) continue;
				const glint = b.glint && glints[b.glint] && glints[b.glint].texture ? glints[b.glint] : null;
				if (glint) {
					gl.activeTexture(gl.TEXTURE5);
					gl.bindTexture(gl.TEXTURE_2D, glint.texture);
					gl.activeTexture(gl.TEXTURE0);
					gl.uniformMatrix3fv(u.uGlintMatrix, false, glint.matrix);
				}
				if ((glint ? 1 : 0) !== glintOn) {
					glintOn = glint ? 1 : 0;
					gl.uniform1i(u.uGlint, glintOn);
				}
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
		drawBatches(b => b.mode === MODE_EYES || b.mode === MODE_ENERGY);
		// RenderPipelines.CRUMBLING: multiplied into the block, pulled towards the camera (depth bias 1, 10)
		gl.blendFuncSeparate(gl.DST_COLOR, gl.SRC_COLOR, gl.ONE, gl.ZERO);
		gl.enable(gl.POLYGON_OFFSET_FILL);
		gl.polygonOffset(-1, -10);
		drawBatches(b => b.mode === MODE_CRUMBLING);
		gl.disable(gl.POLYGON_OFFSET_FILL);
		gl.depthMask(true);
		gl.enable(gl.CULL_FACE);
		gl.bindVertexArray(null);
		this.drawShadows(frame);
		gl.disable(gl.BLEND);
	}

	drawShadows(frame) {
		if (!this.shadows.length) return;
		const texture = this.texture('shadow', 'misc');
		if (!texture) return;
		const gl = this.gl;
		const p = this.shadowProgram;
		gl.useProgram(p.program);
		gl.uniformMatrix4fv(p.u.uViewProj, false, frame.viewProj);
		setFog(gl, p.u, frame.fog);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.uniform1i(p.u.uTexture, 0);
		gl.enable(gl.BLEND);
		gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
		gl.depthMask(false);
		gl.disable(gl.CULL_FACE);
		// VIEW_OFFSET_Z_LAYERING: drawn just in front of the block tops
		gl.enable(gl.POLYGON_OFFSET_FILL);
		gl.polygonOffset(-2, -2);
		gl.bindVertexArray(this.shadowVao);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.shadowVbo);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(this.shadows), gl.STREAM_DRAW);
		gl.drawArrays(gl.TRIANGLES, 0, this.shadows.length / 6);
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
