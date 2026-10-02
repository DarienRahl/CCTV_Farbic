// Live entities: interpolation between server snapshots, the game's own
// entity models and textures (see mobs.js / entity-models.js), items,
// block entities, shadows and name tags that only show when the entity is
// really visible (not through walls).

import {
	ModelLibrary, VertexSink, FLOATS, SKIN_FLOATS, BONES_PER_ROW, emitModel, emitQuads, partMatrix, mat4, mul, translate, rotate, scale, DEG,
} from './entity-models.js';
import { describeMob, isKnownMob, blockEntityModel, dyeRgb, CLIENT, equipmentPose, setEquipment, setAutoMobResolver, isAvatar } from './mobs.js';
import { Animator, AnimationStates } from './keyframes.js';
import { collectParts } from './models.js';
import { tintInHand } from './mesher.js';
import { ItemDefinitions } from './items.js';
import { JavaRandom } from './rng.js';
import { program, FOG_GLSL, setFog, Target, FULLSCREEN_VS } from './gl.js';
import { SHADOW_GLSL, SHADER_LIGHT_GLSL } from './renderer.js';
import { lerp, lerpAngle, wrapDegrees } from './math.js';
import { TextRenderer, rgb, matrixTransform, FULL_BRIGHT } from './text.js';

const PI = Math.PI;
/** A rotation matrix (column-major) by an angle in radians about an axis (normalised here). */
function axisRotation(x, y, z, angle) {
	const len = Math.hypot(x, y, z) || 1;
	x /= len; y /= len; z /= len;
	const c = Math.cos(angle), s = Math.sin(angle), k = 1 - c;
	return new Float32Array([
		c + x * x * k, y * x * k + z * s, z * x * k - y * s, 0,
		x * y * k - z * s, c + y * y * k, z * y * k + x * s, 0,
		x * z * k + y * s, y * z * k - x * s, c + z * z * k, 0,
		0, 0, 0, 1,
	]);
}

/** A standard normal random number (Random.nextGaussian). */
const gaussian = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * PI * Math.random());

const MODE_CUTOUT = 0, MODE_NOCULL = 1, MODE_TRANSLUCENT = 2, MODE_EYES = 3, MODE_ENERGY = 4, MODE_CRUMBLING = 5, MODE_TRANSLUCENT_EMISSIVE = 6,
	MODE_BREEZE_WIND = 7;

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
/** Special item models the viewer draws (drawSpecialItem); others fall back to a sprite, block model or box. */
const SPECIAL_ITEM_TYPES = new Set(['chest', 'shulker_box', 'conduit', 'head', 'player_head', 'banner', 'decorated_pot', 'bell',
	'copper_golem_statue', 'trident']);
/** SkullBlock.Type of a head item: its model layer and texture below textures/entity. */
const SPECIAL_HEADS = {
	skeleton: ['skeleton_skull', 'skeleton/skeleton'], wither_skeleton: ['wither_skeleton_skull', 'skeleton/wither_skeleton'],
	zombie: ['zombie_head', 'zombie/zombie'], creeper: ['creeper_head', 'creeper/creeper'], piglin: ['piglin_head', 'piglin/piglin'],
	dragon: ['dragon_skull', 'enderdragon/dragon'], player: ['player_head', 'player/wide/steve'],
};

/** Transformation (translation, left rotation, scale, right rotation; quaternions or axis and angle) as a matrix. */
function transformationMatrix(t) {
	const quaternion = q => {
		if (!q) return mat4();
		let [x, y, z, w] = Array.isArray(q) ? q : [0, 0, 0, 1];
		if (!Array.isArray(q) && q.axis) {
			const len = Math.hypot(q.axis[0], q.axis[1], q.axis[2]) || 1, s = Math.sin((q.angle || 0) / 2);
			[x, y, z, w] = [q.axis[0] / len * s, q.axis[1] / len * s, q.axis[2] / len * s, Math.cos((q.angle || 0) / 2)];
		}
		const r = mat4();
		r[0] = 1 - 2 * (y * y + z * z); r[1] = 2 * (x * y + z * w); r[2] = 2 * (x * z - y * w);
		r[4] = 2 * (x * y - z * w); r[5] = 1 - 2 * (x * x + z * z); r[6] = 2 * (y * z + x * w);
		r[8] = 2 * (x * z + y * w); r[9] = 2 * (y * z - x * w); r[10] = 1 - 2 * (x * x + y * y);
		return r;
	};
	const tr = t.translation || [0, 0, 0], sc = t.scale || [1, 1, 1];
	const m = mat4();
	translate(m, tr[0], tr[1], tr[2]);
	const left = mul(m, quaternion(t.left_rotation));
	scale(left, sc[0], sc[1], sc[2]);
	return mul(left, quaternion(t.right_rotation));
}
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

const MODES = { cutout: MODE_CUTOUT, cutout_nocull: MODE_NOCULL, translucent: MODE_TRANSLUCENT, eyes: MODE_EYES, energy: MODE_ENERGY,
	translucent_emissive: MODE_TRANSLUCENT_EMISSIVE, breeze_wind: MODE_BREEZE_WIND };

// GPU skinning: models stay on the GPU in their parts' own space (aBone = the part's index) and each part's matrix of
// this frame is read from a float texture, four texels per matrix; vertices made on the CPU have aBone -1.
const SKIN_GLSL = `
layout(location = 6) in float aBone;
uniform highp sampler2D uBones;
uniform int uBoneBase;
mat4 boneMatrix() {
	int t = (uBoneBase + int(aBone + 0.5)) * 4;
	ivec2 at = ivec2(t % ${BONES_PER_ROW * 4}, t / ${BONES_PER_ROW * 4});
	return mat4(texelFetch(uBones, at, 0), texelFetch(uBones, at + ivec2(1, 0), 0),
		texelFetch(uBones, at + ivec2(2, 0), 0), texelFetch(uBones, at + ivec2(3, 0), 0));
}
vec3 skinnedPos() {
	return aBone >= 0.0 ? (boneMatrix() * vec4(aPos, 1.0)).xyz : aPos;
}`;

const ENTITY_VS = `
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;
layout(location = 3) in vec4 aColor;
layout(location = 4) in vec2 aLight;
layout(location = 5) in vec2 aOverlay;
${SKIN_GLSL}
uniform mat4 uViewProj;
uniform sampler2D uLightmap;
uniform int uMode;
uniform vec2 uUvOffset;
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
	vec3 pos = aPos;
	vec3 normal = aNormal;
	if (aBone >= 0.0) {
		mat4 m = boneMatrix();
		pos = (m * vec4(aPos, 1.0)).xyz;
		// the cofactor matrix turns the normal like the cross product of the quad's moved edges
		normal = aNormal.x * cross(m[1].xyz, m[2].xyz) + aNormal.y * cross(m[2].xyz, m[0].xyz) + aNormal.z * cross(m[0].xyz, m[1].xyz);
	}
	gl_Position = uViewProj * vec4(pos, 1.0);
	vSph = length(pos);
	vCyl = max(length(pos.xz), abs(pos.y));
	vec3 n = normalize(normal);
	float light = min(1.0, (max(0.0, dot(uLight0, n)) + max(0.0, dot(uLight1, n))) * 0.6 + 0.4);
	vColor = uMode >= 3 ? aColor : vec4(aColor.rgb * light, aColor.a);
	vLightColor = uMode == 3 || uMode == 5 ? vec4(1.0) : texture(uLightmap, clamp(aLight / 256.0 + 0.5 / 16.0, vec2(0.5 / 16.0), vec2(15.5 / 16.0)));
	// RenderTypes.energySwirl: the texture scrolled by the layer's own offsets (TextureTransform translation)
	vUv = aUv + uUvOffset;
	// entity.vsh / item.vsh GLINT: the texture matrix applied to the model's own texture coordinates
	vGlintUv = (uGlintMatrix * vec3(aUv, 1.0)).xy;
	// OverlayTexture: hurt = red at 0.7 alpha, white flash fades the picture to white.
	vOverlay = aOverlay.x > 0.5 ? vec4(1.0, 0.0, 0.0, 0.7) : vec4(1.0, 1.0, 1.0, 1.0 - aOverlay.y * 0.75);
#ifdef SHADERS
	vPos = pos;
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
	if (uMode == 6) {
		// entity_translucent_emissive: alpha cutout 0.1, blended, not darkened by the lightmap
		if (color.a < 0.1) discard;
		color *= vColor;
		outColor = apply_fog(color, vSph, vCyl);
		return;
	}
	if (uMode == 3) {
		// RenderPipelines.EYES: blended (TRANSLUCENT) over the model, not lit and not darkened by the lightmap
		color *= vColor;
		outColor = apply_fog(color, vSph, vCyl);
		return;
	}
	if (uMode == 7) {
		// RenderPipelines.BREEZE_WIND: alpha cutout 0.1, blended, lit by the lightmap only (NO_CARDINAL_LIGHTING)
		if (color.a < 0.1) discard;
		color *= vColor * vLightColor;
		outColor = apply_fog(color, vSph, vCyl);
		return;
	}
	if (uMode <= 1 && color.a < 0.1) discard;
	if (uMode == 2 && color.a < 0.004) discard;
	color *= vColor;
	if (uGlint > 0) color.a = max(color.a, uGlintAlpha);
	if (uMode == 4) {
		// RenderPipelines.ENERGY_SWIRL: added (ADDITIVE), fading into the fog
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
${SKIN_GLSL}
uniform mat4 uMatrix;
out vec2 vUv;
void main() {
	vUv = aUv;
	gl_Position = uMatrix * vec4(skinnedPos(), 1.0);
}`;

const DEPTH_FS = `
in vec2 vUv;
uniform sampler2D uTexture;
void main() {
	if (texture(uTexture, vUv).a < 0.1) discard;
}`;

// rendertype_outline: glowing entities drawn in their team colour into the outline target
const OUTLINE_VS = `
layout(location = 0) in vec3 aPos;
layout(location = 2) in vec2 aUv;
${SKIN_GLSL}
uniform mat4 uViewProj;
out vec2 vUv;
void main() {
	vUv = aUv;
	gl_Position = uViewProj * vec4(skinnedPos(), 1.0);
}`;

const OUTLINE_FS = `
in vec2 vUv;
uniform sampler2D uTexture;
uniform vec3 uColor;
out vec4 outColor;
void main() {
	if (texture(uTexture, vUv).a == 0.0) discard;
	outColor = vec4(uColor, 1.0);
}`;

// post/entity_sobel: the silhouettes' edges, coloured like the entity next to them
const SOBEL_FS = `
in vec2 vUv;
uniform sampler2D uIn;
uniform vec2 uInSize;
out vec4 outColor;
void main() {
	vec2 oneTexel = 1.0 / uInSize;
	vec4 center = texture(uIn, vUv);
	vec4 left = texture(uIn, vUv - vec2(oneTexel.x, 0.0));
	vec4 right = texture(uIn, vUv + vec2(oneTexel.x, 0.0));
	vec4 up = texture(uIn, vUv - vec2(0.0, oneTexel.y));
	vec4 down = texture(uIn, vUv + vec2(0.0, oneTexel.y));
	float total = clamp(abs(center.a - left.a) + abs(center.a - right.a) + abs(center.a - up.a) + abs(center.a - down.a), 0.0, 1.0);
	vec3 color = center.rgb * center.a + left.rgb * left.a + right.rgb * right.a + up.rgb * up.a + down.rgb * down.a;
	outColor = vec4(color * 0.2, total);
}`;

// post/entity_outline_box_blur (radius 2, bilinear samples)
const OUTLINE_BLUR_FS = `
in vec2 vUv;
uniform sampler2D uIn;
uniform vec2 uInSize;
uniform vec2 uDir;
out vec4 outColor;
void main() {
	vec2 sampleStep = uDir / uInSize;
	vec4 blurred = vec4(0.0);
	float radius = 2.0;
	for (float a = -radius + 0.5; a <= radius; a += 2.0) blurred += texture(uIn, vUv + sampleStep * a);
	blurred += texture(uIn, vUv + sampleStep * radius) / 2.0;
	outColor = vec4((blurred / (radius + 0.5)).rgb, blurred.a);
}`;

// ScreenEffectRenderer.submitWater: textures/misc/underwater.png tiled four times over the screen, moving with the view
const UNDERWATER_FS = `
in vec2 vUv;
uniform sampler2D uTexture;
uniform vec2 uOffset;
uniform vec4 uColor;
out vec4 outColor;
void main() {
	outColor = texture(uTexture, uOffset + 4.0 * (1.0 - vUv)) * uColor;
}`;

const OUTLINE_BLIT_FS = `
in vec2 vUv;
uniform sampler2D uIn;
out vec4 outColor;
void main() {
	outColor = texture(uIn, vUv);
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

/** PandaRenderer.setupRotations: rolling over, sitting up (shaking when scared) and lying on the back. */
function pandaRotations(m, e) {
	const d = e.d || {};
	const xRot = e.pitch || 0;
	const rollTime = Number(d.roll) || 0;
	if (rollTime > 0) {
		const transition = rollTime - Math.floor(rollTime);
		const pos = Math.floor(rollTime), next = pos + 1;
		const y = e.baby ? 0.3 : 0.8;
		const angleOf = (from, to, threshold) => (next < threshold ? lerp(from, to, transition) : from);
		if (pos < 8) {
			const angle = angleOf(90 * pos / 7, 90 * next / 7, 8);
			translate(m, 0, (y + 0.2) * (angle / 90), 0);
			rotate(m, 0, -angle * DEG);
		} else if (pos < 16) {
			const angle = angleOf(90 + 90 * (pos - 8) / 7, 90 + 90 * (next - 8) / 7, 16);
			translate(m, 0, y + 0.2 + (y - 0.2) * (angle - 90) / 90, 0);
			rotate(m, 0, -angle * DEG);
		} else if (pos < 24) {
			const angle = angleOf(180 + 90 * (pos - 16) / 7, 180 + 90 * (next - 16) / 7, 24);
			translate(m, 0, y + y * (270 - angle) / 90, 0);
			rotate(m, 0, -angle * DEG);
		} else if (pos < 32) {
			const angle = angleOf(270 + 90 * (pos - 24) / 7, 270 + 90 * (next - 24) / 7, 32);
			translate(m, 0, y * ((360 - angle) / 90), 0);
			rotate(m, 0, -angle * DEG);
		}
	}
	const sit = Number(d.sit) || 0;
	if (sit > 0) {
		translate(m, 0, 0.8 * sit, 0);
		rotate(m, 0, lerp(xRot, xRot + 90, sit) * DEG);
		translate(m, 0, -1 * sit, 0);
		if (d.scared) {
			rotate(m, 1, Math.cos((e.age || 0) * 1.25) * Math.PI * 0.05 * DEG);
			if (e.baby) translate(m, 0, 0.8, 0.55);
		}
	}
	const onBack = Number(d.onBack) || 0;
	if (onBack > 0) {
		translate(m, 0, (e.baby ? 0.5 : 1.3) * onBack, 0);
		rotate(m, 0, lerp(xRot, xRot + 180, onBack) * DEG);
	}
}

/**
 * Animation amounts of the entity tick (EntityEncoder AMOUNTS, only sent when not zero) and the creeper's
 * swelling, between two frames like the renderers' partial tick.
 */
const LERP_DATA = ['eat', 'stand', 'mouth', 'headRoll', 'crouch', 'sit', 'onBack', 'rollAmount', 'roll', 'sneeze', 'useTicks', 'swelling', 'flap', 'flapSpeed', 'lie', 'lieTail', 'relax'];

function lerpData(da, db, t) {
	if (!da && !db) return db;
	let out = db;
	for (const key of LERP_DATA) {
		const a = da ? da[key] : undefined, b = db ? db[key] : undefined;
		if (a === undefined && b === undefined) continue;
		if (out === db) out = { ...db };
		out[key] = lerp(a || 0, b || 0, t);
	}
	return out;
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
/** Util.NIL_UUID: the id of the empty profile (a mannequin's default), whose default skin is the slim Alex. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
/** 3 by 3 rotation matrices (rows) for ModelPart.rotateBy: about y, about a unit axis, and their product. */
function rotationY3(angle) {
	const c = Math.cos(angle), s = Math.sin(angle);
	return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
}

function rotationAxis3(angle, x, y, z) {
	const c = Math.cos(angle), s = Math.sin(angle), k = 1 - c;
	return [[c + x * x * k, x * y * k - z * s, x * z * k + y * s], [y * x * k + z * s, c + y * y * k, y * z * k - x * s],
		[z * x * k - y * s, z * y * k + x * s, c + z * z * k]];
}

function mul3(A, B) {
	return A.map(row => [0, 1, 2].map(c => row[0] * B[0][c] + row[1] * B[1][c] + row[2] * B[2][c]));
}

/** ModelPart.rotateBy on a part at rest: its rotation becomes the matrix's Z*Y*X angles (Matrix3f.getEulerAnglesZYX). */
function setPartRotation(part, M) {
	part.xRot = Math.atan2(M[2][1], M[2][2]);
	part.yRot = Math.atan2(-M[2][0], Math.sqrt(Math.max(0, 1 - M[2][0] * M[2][0])));
	part.zRot = Math.atan2(M[1][0], M[0][0]);
}

/** TntRenderer.getSwellAmount: how much a block about to explode swells in its last 10 ticks. */
function tntSwell(fuse) {
	const g = Math.min(1, Math.max(0, 1 - fuse / 10)) ** 4;
	return g * 0.3;
}

/**
 * AbstractMinecartRenderer.submit: a tiny offset from the id (MinecartRenderState.offsetSeed), so minecarts in the
 * same place do not flicker into each other.
 */
function minecartJitter(id) {
	const seed = BigInt.asIntN(64, BigInt(id || 0) * 493286711n);
	const offsetSeed = BigInt.asIntN(64, seed * seed * 4392167121n + seed * 98761n);
	const part = shift => ((Number((offsetSeed >> BigInt(shift)) & 7n) + 0.5) / 8 - 0.5) * 0.004;
	return [part(16), part(20), part(24)];
}

/** TntRenderer.isLit: the white flash, every other 5 ticks of the fuse. */
function tntLit(fuse) {
	return fuse >= 0 && Math.floor(fuse / 5) % 2 === 0;
}

/** SulfurCubeRenderer.extractRenderState: the ticks left on a primed cube's fuse (getFuse() + 1), else 0. */
function sulfurFuse(e) {
	const fuse = e.d && e.d.fuse;
	return typeof fuse === 'number' && fuse >= 0 ? fuse + 1 : 0;
}

/** SulfurCubeInnerLayer: a primed cube's inner cube or block flashes white like TNT. */
function sulfurLit(e) {
	const fuse = sulfurFuse(e);
	return fuse > 0 && tntLit(fuse);
}

/**
 * The renderers with a CustomHeadLayer and its transforms (y offset of items, of skulls, horizontal and vertical
 * scale): the default for humanoid mobs (those with armour), villagers', piglins' and sulfur cubes' own.
 */
const VILLAGER_HEAD = { y: -0.1171875, skullY: -0.07421875, h: 1, v: 1 };
const PIGLIN_HEAD = { y: 0, skullY: 0, h: 1.0019531, v: 1 };
const CUSTOM_HEADS = {
	default: { y: 0, skullY: 0, h: 1, v: 1 },
	villager: VILLAGER_HEAD, zombie_villager: VILLAGER_HEAD,
	piglin: PIGLIN_HEAD, piglin_brute: PIGLIN_HEAD, zombified_piglin: PIGLIN_HEAD,
	sulfur_cube: { y: 0, skullY: 0.625, h: 0.84210527, v: 0.84210527, cutout: true },
	wandering_trader: { y: 0, skullY: 0, h: 1, v: 1 }, copper_golem: { y: 0, skullY: 0, h: 1, v: 1 },
	vindicator: { y: 0, skullY: 0, h: 1, v: 1 }, evoker: { y: 0, skullY: 0, h: 1, v: 1 },
	pillager: { y: 0, skullY: 0, h: 1, v: 1 }, illusioner: { y: 0, skullY: 0, h: 1, v: 1 },
};

/** LivingEntityRenderer.sleepDirectionToRotation: the bed's direction as a yaw. */
const SLEEP_ROTATION = { south: 90, west: 0, north: 270, east: 180 };

/** PlayerModel.bodyParts, in the order getRandomBodyPart picks from. */
const STUCK_BODY_PARTS = ['head', 'body', 'left_arm', 'right_arm', 'left_leg', 'right_leg'];

/** A texture asset id of the game ("minecraft:entity/player/wide/steve") as a path below textures/entity, or null. */
function entityTexturePath(id) {
	const match = /^(?:minecraft:)?entity\/(.+)$/.exec(id);
	return match ? match[1] : null;
}

/**
 * The cubes of a model part as [minX, minY, minZ, maxX, maxY, maxZ] (model pixels), from its quads: six faces of
 * four corners each per cube (ModelPart.Cube keeps the bounds without the cube's inflation; the player model has none).
 */
const PART_CUBES = new WeakMap();
function partCubes(part) {
	if (!part) return [];
	let cubes = PART_CUBES.get(part);
	if (cubes) return cubes;
	cubes = [];
	const q = part.quads || part.q;
	if (q) {
		const perCube = 6 * 4 * 5;
		for (let c = 0; c + perCube <= q.length; c += perCube) {
			const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
			for (let v = c; v < c + perCube; v += 5) {
				for (let k = 0; k < 3; k++) {
					box[k] = Math.min(box[k], q[v + k]);
					box[k + 3] = Math.max(box[k + 3], q[v + k]);
				}
			}
			cubes.push(box);
		}
	}
	PART_CUBES.set(part, cubes);
	return cubes;
}

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

// Thrown items (ThrownItemRenderer, FireworkEntityRenderer) and the item they show when the server sends none.
const THROWN = {
	snowball: 'snowball', egg: 'egg', blue_egg: 'blue_egg', brown_egg: 'brown_egg', ender_pearl: 'ender_pearl', potion: 'splash_potion',
	splash_potion: 'splash_potion', lingering_potion: 'lingering_potion', experience_bottle: 'experience_bottle',
	eye_of_ender: 'ender_eye', fireball: 'fire_charge', small_fireball: 'fire_charge', firework_rocket: 'firework_rocket',
};
// Blocks drawn by their special model (SpecialBlockModelRenderer) where a block, not a block entity, is shown
const SPECIAL_BLOCKS = new Set(['chest', 'shulker_box', 'head', 'banner', 'statue']);
// EntityRenderers: the ThrownItemRenderers made bigger or smaller, and the ones lit like block light 15
const THROWN_SCALE = { fireball: 3, small_fireball: 0.75 };
const THROWN_BRIGHT = new Set(['eye_of_ender', 'fireball', 'small_fireball']);

export class EntityRenderer {
	constructor(renderer) {
		this.renderer = renderer;
		this.gl = renderer.gl;
		this.text = new TextRenderer(this.gl);
		this.library = new ModelLibrary();
		this.animator = new Animator(this.library);
		this.sink = new VertexSink();
		this.sink.skinning = true;
		// GPU copies of the models (GPU skinning) and the texture with this frame's part matrices
		this.skinnedMeshes = new Map();
		this.boneTexture = null;
		this.boneRows = 0;
		this.batches = [];
		this.textures = new Map();
		this.skins = new Map();
		this.capes = new Map();
		this.maps = new Map();
		this.spawners = new Map();
		/** Lid, shake and similar animation state of block entities by "x,y,z", from block events. */
		this.blockAnims = new Map();
		/** Display entities' interpolation (transformation, text opacity and background, teleport): entity id -> state */
		this.displays = new Map();
		/** Entities seen while the world was not frozen: they have ticked (mannequins wear their skin, bodies turn). */
		this.ticked = new Set();
		/** Parrots dancing to a jukebox: entity id -> the jukebox's position (Parrot.jukebox) */
		this.partyParrots = new Map();
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
		this.itemHeights = new WeakMap();
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
			.then(list => {
				this.entityList = new Set(list);
				setAutoMobResolver(type => this.autoMob(type));
			})
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

	/**
	 * ClientMannequin.getSkin: the skin of the mannequin's profile (fetched like a player's, by id or name; the
	 * default skin of the empty profile without either) with the profile's skin patch over it (texture, model,
	 * cape and elytra from the resource pack).
	 */
	mannequinSkin(e) {
		// ClientMannequin.tick takes the skin its profile's lookup found: until a mannequin has ticked (one that
		// appeared while the world is frozen) it wears DEFAULT_SKIN, the empty profile's
		const profile = this.ticked.has(e.id) ? e.profile || {} : {};
		const key = profile.id || (profile.name ? 'name:' + profile.name : NIL_UUID);
		const skin = this.skin(key, profile.name || '');
		e.uuid = key;
		e.skinName = profile.name || '';
		e.slim = profile.model ? profile.model === 'slim' : skin.slim;
		e.skinTexture = profile.texture ? entityTexturePath(profile.texture) : null;
		e.capeTexture = profile.cape ? entityTexturePath(profile.cape) : null;
		e.elytraTexture = profile.elytra ? entityTexturePath(profile.elytra) : null;
		if (key === NIL_UUID) {
			// the default skin, which has no cape
			e.uuid = null;
			e.skinTexture = e.skinTexture || defaultSkin(NIL_UUID).path;
		}
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
		if (uuid === NIL_UUID) {
			useDefault();
			return skin;
		}
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

	/**
	 * LevelEventHandler.playJukeboxSong / stopJukeboxSongAndNotifyNearby: the living entities within three blocks
	 * of a jukebox hear that it starts or stops a song (LivingEntity.setRecordPlayingNearby); parrots dance to it.
	 */
	jukeboxParty(fx, list) {
		const playing = fx[0] === 'js';
		const [x, y, z] = playing ? fx.slice(2, 5) : fx.slice(1, 4);
		for (const e of list) {
			if (strip(e.type) !== 'parrot') continue;
			// AABB(pos).inflate(3) against the parrot's box
			const hw = (e.w || 0.5) / 2, h = e.h || 0.9;
			if (e.x + hw < x - 3 || e.x - hw > x + 4 || e.y + h < y - 3 || e.y > y + 4 || e.z + hw < z - 3 || e.z - hw > z + 4) continue;
			if (playing) this.partyParrots.set(e.id, [x, y, z]);
			else this.partyParrots.delete(e.id);
		}
	}

	/** Parrot.aiStep: a parrot stops dancing once it is more than 3.46 blocks from its jukebox's centre. */
	isPartyParrot(e) {
		const jukebox = this.partyParrots.get(e.id);
		if (!jukebox) return false;
		if (Math.hypot(e.x - jukebox[0] - 0.5, e.y - jukebox[1] - 0.5, e.z - jukebox[2] - 0.5) > 3.46) {
			this.partyParrots.delete(e.id);
			return false;
		}
		return true;
	}

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
			else if (fx[0] === 'js' || fx[0] === 'jx') this.jukeboxParty(fx, frame.e);
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
				// frozen (/tick freeze): the game draws an entity at the partial tick 1 (DeltaTracker), players excepted
				walk: num('walk'), walkSpeed: num('walkSpeed'), age: num('age') + (this.frozen && eb.type !== 'minecraft:player' ? 1 : 0),
				deathTime: num('deathTime'),
				swimAmount: num('swimAmount'), flyingTicks: num('flyingTicks'),
				rowL: num('rowL'), rowR: num('rowR'), hurtTime: num('hurtTime'), damage: num('damage'), bubble: num('bubble'),
				rail: ea.rail && eb.rail ? [lerp(ea.rail[0], eb.rail[0], t), lerp(ea.rail[1], eb.rail[1], t), lerp(ea.rail[2], eb.rail[2], t),
					lerpAngle(ea.rail[3], eb.rail[3], t), lerp(ea.rail[4], eb.rail[4], t)] : eb.rail,
				d: lerpData(ea.d, eb.d, t),
			});
		}
		for (const [id, eb] of b.map) {
			if (!a.map.has(id) && t > 0) result.push(eb);
		}
		// LivingEntity.recreateFromPacket: a client starts an entity's body turned like its head and turns it as it
		// ticks; one that has not ticked yet (it appeared while the world is frozen) keeps that
		for (let i = 0; i < result.length; i++) {
			const e = result[i];
			if (!this.frozen) this.ticked.add(e.id);
			else if (e.head !== undefined && e.body !== e.head && !this.ticked.has(e.id)) result[i] = { ...e, body: e.head };
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
		// no client tick while the world is frozen (ClientLevel.tickEntities skips frozen entities)
		if (client.tick && !this.frozen) {
			if (states.lastTick === null || tick < states.lastTick || tick - states.lastTick > 40) states.lastTick = tick - 1;
			while (states.lastTick < tick) client.tick(e, states, ++states.lastTick);
		}
		return states;
	}

	cleanupStates(now) {
		for (const [id, state] of this.displays) if (this.tick - state.seen > 100) this.displays.delete(id);
		if (this.ticked.size > 1024 && this.byId) for (const id of this.ticked) if (!this.byId.has(id)) this.ticked.delete(id);
		for (const [id, queue] of this.events) if (!queue.length || this.tick - queue[queue.length - 1].t > 200) this.events.delete(id);
		for (const [key, b] of this.books) if (now - b.seen > 5000) this.books.delete(key);
		if (this.states.size < 64) return;
		for (const [id, s] of this.states) if (now - s.seen > 5000) this.states.delete(id);
	}

	// --- building the frame ------------------------------------------------------------------------

	begin() {
		this.sink.reset();
		this.batches = [];
		this.outline = null;
	}

	/**
	 * Records that the vertices emitted since `start` use this texture / mode (and, while a glowing entity is
	 * drawn, its outline colour).
	 */
	batch(texture, mode, start, cull = true, glint = 0, uv = null) {
		const count = this.sink.count - start.v;
		const skinCount = this.sink.draws.length - start.s;
		if (count <= 0 && skinCount <= 0) return;
		const outline = this.outline;
		const u = uv ? uv[0] : 0, v = uv ? uv[1] : 0;
		const last = this.batches[this.batches.length - 1];
		if (last && last.texture === texture && last.mode === mode && last.cull === cull && last.glint === glint && last.outline === outline
			&& last.u === u && last.v === v && last.start + last.count === start.v && last.skinStart + last.skinCount === start.s) {
			last.count += count;
			last.skinCount += skinCount;
			return;
		}
		this.batches.push({ texture, mode, start: start.v, count, skinStart: start.s, skinCount, cull, glint, outline, u, v });
	}

	/** The GPU copy of a model's quads (GPU skinning), made the first time the model is drawn. */
	skinnedMesh(geometry) {
		let mesh = this.skinnedMeshes.get(geometry);
		if (!mesh) {
			const gl = this.gl;
			const vao = gl.createVertexArray(), vbo = gl.createBuffer();
			gl.bindVertexArray(vao);
			gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
			gl.bufferData(gl.ARRAY_BUFFER, geometry.data, gl.STATIC_DRAW);
			const stride = SKIN_FLOATS * 4;
			const attrib = (index, size, offset) => {
				gl.enableVertexAttribArray(index);
				gl.vertexAttribPointer(index, size, gl.FLOAT, false, stride, offset * 4);
			};
			// colour, light and overlay (3, 4, 5) are the same for the whole draw: constant attributes
			attrib(0, 3, 0); attrib(1, 3, 3); attrib(2, 2, 6); attrib(6, 1, 8);
			gl.bindVertexArray(null);
			mesh = { vao, vbo, vertices: geometry.vertices };
			this.skinnedMeshes.set(geometry, mesh);
		}
		return mesh;
	}

	/** Binds this frame's part matrices for a program with SKIN_GLSL; CPU made vertices get part index -1. */
	bindBones(u) {
		const gl = this.gl;
		gl.activeTexture(gl.TEXTURE6);
		gl.bindTexture(gl.TEXTURE_2D, this.boneTexture || this.white);
		gl.activeTexture(gl.TEXTURE0);
		gl.uniform1i(u.uBones, 6);
		gl.vertexAttrib1f(6, -1);
	}

	/**
	 * Draws a batch: its vertices in this frame's buffer, then its skinned models (with their colour, light and
	 * overlay as constant attributes when `style` is set). Leaves a model's vertex array bound.
	 */
	drawBatch(b, u, style) {
		const gl = this.gl;
		if (b.count > 0) {
			gl.bindVertexArray(this.vao);
			gl.drawArrays(gl.TRIANGLES, b.start, b.count);
		}
		for (let i = b.skinStart; i < b.skinStart + b.skinCount; i++) {
			const draw = this.sink.draws[i];
			const mesh = this.skinnedMesh(draw.geometry);
			gl.bindVertexArray(mesh.vao);
			gl.uniform1i(u.uBoneBase, draw.bone);
			if (style) {
				gl.vertexAttrib4f(3, draw.color[0], draw.color[1], draw.color[2], draw.color[3]);
				gl.vertexAttrib2f(4, draw.light[0], draw.light[1]);
				gl.vertexAttrib2f(5, draw.overlay[0], draw.overlay[1]);
			}
			gl.drawArrays(gl.TRIANGLES, 0, mesh.vertices);
		}
	}

	/**
	 * The underwater overlay over the whole picture while the camera is in water: as bright as the light at the
	 * camera (LightTexture.getBrightness), 10 % opaque, shifted by the view's yaw and pitch.
	 */
	drawUnderwater(scene, brightness, yaw, pitch) {
		const texture = this.texture('underwater', 'misc');
		if (!texture) return;
		const gl = this.gl;
		if (!this.underwaterProgram) {
			this.underwaterProgram = program(gl, FULLSCREEN_VS, UNDERWATER_FS);
			this.fullscreenVao = this.fullscreenVao || gl.createVertexArray();
		}
		const p = this.underwaterProgram;
		scene.bind();
		gl.useProgram(p.program);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
		gl.uniform1i(p.u.uTexture, 0);
		gl.uniform2f(p.u.uOffset, -yaw / 64, pitch / 64);
		gl.uniform4f(p.u.uColor, brightness, brightness, brightness, 0.1);
		gl.disable(gl.DEPTH_TEST);
		gl.enable(gl.BLEND);
		gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		gl.bindVertexArray(this.fullscreenVao);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
		gl.bindVertexArray(null);
		gl.disable(gl.BLEND);
		gl.enable(gl.DEPTH_TEST);
		this.underwaterFrames = (this.underwaterFrames || 0) + 1;
	}

	/**
	 * The Glowing effect (LevelRenderer's entity outline target and the entity_outline post chain): glowing
	 * entities drawn in their team colour into their own target, their edges found (entity_sobel), blurred and
	 * blended over the picture, walls or not.
	 */
	drawOutlines(frame, scene) {
		if (!this.batches.some(b => b.outline && b.mode <= MODE_TRANSLUCENT)) return;
		const gl = this.gl;
		if (!this.outlinePrograms) {
			this.outlinePrograms = {
				entity: program(gl, OUTLINE_VS, OUTLINE_FS),
				sobel: program(gl, FULLSCREEN_VS, SOBEL_FS),
				blur: program(gl, FULLSCREEN_VS, OUTLINE_BLUR_FS),
				blit: program(gl, FULLSCREEN_VS, OUTLINE_BLIT_FS),
			};
			this.outlineTarget = new Target(gl, { color: true, depth: true });
			this.outlineSwap = new Target(gl, { color: true, depth: false });
			this.fullscreenVao = this.fullscreenVao || gl.createVertexArray();
		}
		const P = this.outlinePrograms;
		const w = scene.width, h = scene.height;
		this.outlineTarget.resize(w, h);
		this.outlineSwap.resize(w, h);

		this.outlineTarget.bind();
		gl.clearColor(0, 0, 0, 0);
		gl.clearDepth(1);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
		gl.enable(gl.DEPTH_TEST);
		gl.depthMask(true);
		gl.disable(gl.BLEND);
		gl.useProgram(P.entity.program);
		gl.uniformMatrix4fv(P.entity.u.uViewProj, false, frame.viewProj);
		gl.uniform1i(P.entity.u.uTexture, 0);
		this.bindBones(P.entity.u);
		gl.activeTexture(gl.TEXTURE0);
		for (const b of this.batches) {
			if (!b.outline || b.mode > MODE_TRANSLUCENT) continue;
			if (b.cull) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
			gl.uniform3fv(P.entity.u.uColor, b.outline);
			gl.bindTexture(gl.TEXTURE_2D, b.texture);
			this.drawBatch(b, P.entity.u, false);
		}
		gl.disable(gl.CULL_FACE);
		gl.disable(gl.DEPTH_TEST);
		gl.bindVertexArray(this.fullscreenVao);
		const pass = (p, input, output, setup) => {
			output.bind();
			gl.useProgram(p.program);
			gl.bindTexture(gl.TEXTURE_2D, input.colorTexture);
			gl.uniform1i(p.u.uIn, 0);
			if (p.u.uInSize) gl.uniform2f(p.u.uInSize, input.width, input.height);
			if (setup) setup(p.u);
			gl.drawArrays(gl.TRIANGLES, 0, 3);
		};
		pass(P.sobel, this.outlineTarget, this.outlineSwap);
		pass(P.blur, this.outlineSwap, this.outlineTarget, u => gl.uniform2f(u.uDir, 1, 0));
		pass(P.blur, this.outlineTarget, this.outlineSwap, u => gl.uniform2f(u.uDir, 0, 1));
		// RenderPipelines.ENTITY_OUTLINE_BLIT: blended over the picture, its alpha left alone
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		gl.colorMask(true, true, true, false);
		pass(P.blit, this.outlineSwap, scene);
		gl.colorMask(true, true, true, true);
		gl.disable(gl.BLEND);
		gl.enable(gl.DEPTH_TEST);
		gl.bindVertexArray(null);
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
		this.mapLabels = [];
		this.displayTexts = [];
		this.boxed.clear();
		const now = frame.now;
		const o = frame.origin, cam = frame.camPos;
		this.cameraWorld = [o[0] + cam[0], o[1] + cam[1], o[2] + cam[2]];
		this.frame = frame;
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
			// the entity the camera is inside (the player who stands at the camera's eyes): the game never draws the
			// camera's own entity, and its model, drawn from both sides, would fill the picture from within
			if (e.w && e.h && Math.abs(rx) < e.w / 2 && Math.abs(rz) < e.w / 2 && ry <= 0 && ry >= -e.h) continue;
			let radius = Math.max(e.w || 1, e.h || 1) + 1;
			// display entities have no size of their own: their transformation and text decide how far they reach
			if (e.disp) {
				const t = e.disp.t || [];
				radius = Math.max(radius, Math.hypot(t[0] || 0, t[1] || 0, t[2] || 0) + Math.max(Math.abs(t[7] ?? 1), Math.abs(t[8] ?? 1), Math.abs(t[9] ?? 1)) * (e.disp.tx ? 6 : 2) + 1);
			}
			// FishingHookRenderer.affectedByCulling: the line to the rod shows while the hook is off screen
			const angler = e.fish && this.byId.get(e.fish[0]);
			if (angler) radius = Math.max(radius, Math.hypot(angler.x - e.x, angler.y - e.y, angler.z - e.z) + 2);
			if (!frame.frustum(rx, ry + (e.h || 1) / 2, rz, radius * (type === 'happy_ghast' || type === 'ghast' ? 2 : 1))) continue;
			if (Math.hypot(rx, rz) > frame.fogEnd + 8) continue;
			visible++;
			const light = this.lightFor(e, world);
			try {
				// a glowing entity's geometry also goes into the outline target, in its team colour
				this.outline = e.glow !== undefined ? [(e.glow >> 16 & 255) / 255, (e.glow >> 8 & 255) / 255, (e.glow & 255) / 255] : null;
				if (!e.invisible || showsInvisible) this.drawEntity(e, type, [rx, ry, rz], light, now, world);
				this.outline = null;
				// EntityRenderer.submit: burning entities (invisible ones too) are wrapped in flames.
				if (e.burning) this.drawFlame(e, [rx, ry, rz], light, frame.viewRotation);
			} catch (error) {
				console.warn('CCTV: could not draw', e.type, error);
			}
		}
		this.outline = null;
		this.visibleCount = visible;
		this.drawLeashes(frame, list, world);
		const view = frame.viewRotation;
		this.text.begin();
		this.text.nameTags(this.collectNameTags(frame, list, world), [view[0], view[4], view[8]], [view[1], view[5], view[9]]);
		this.addMapLabels();
		this.addSignText(frame, world);
		for (const add of this.displayTexts) add();
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
		const sink = this.sink, startCount = sink.mark();
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
		const start = this.sink.mark();
		this.sink.ensure(quads.length / 20 * 6);
		// LightCoordsUtil.withBlock(light, 15)
		emitQuads(this.sink, quads, m, { color: [1, 1, 1, 1], light: [240, light[1]], overlay: [0, 0] });
		// fireVertex: setNormal(pose, 0, 1, 0), the camera's up
		const out = this.sink.data;
		for (let v = start.v; v < this.sink.count; v++) {
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
		const sink = this.sink;
		if (!sink.boneCount) return;
		const rows = Math.ceil(sink.boneCount / BONES_PER_ROW);
		gl.activeTexture(gl.TEXTURE6);
		if (!this.boneTexture || rows > this.boneRows) {
			if (this.boneTexture) gl.deleteTexture(this.boneTexture);
			this.boneRows = Math.max(rows, this.boneRows * 2, 4);
			this.boneTexture = gl.createTexture();
			gl.bindTexture(gl.TEXTURE_2D, this.boneTexture);
			gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, BONES_PER_ROW * 4, this.boneRows);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		} else {
			gl.bindTexture(gl.TEXTURE_2D, this.boneTexture);
		}
		gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, BONES_PER_ROW * 4, rows, gl.RGBA, gl.FLOAT, sink.bones, 0);
		gl.activeTexture(gl.TEXTURE0);
	}

	drawEntity(e, type, pos, light, now, world) {
		const style = { color: [1, 1, 1, 1], light, overlay: [e.hurt || e.dead ? 1 : 0, 0] };
		switch (type) {
			case 'item': return this.drawDroppedItem(e, pos, style);
			case 'ominous_item_spawner': return this.drawOminousItem(e, pos, style);
			case 'cushion': return this.drawCushion(e, pos, style);
			case 'dragon_fireball': return this.drawDragonFireball(pos, style);
			case 'experience_orb': return this.drawOrb(e, pos, style);
			// ArrowModel: entityCutoutCull, each side of its flat crosses lit by its own normal
			case 'arrow': case 'spectral_arrow': return this.drawProjectile(e, pos, style, 'arrow#main', type === 'spectral_arrow' ? 'projectiles/arrow_spectral' : 'projectiles/arrow', -90, 0, true);
			case 'trident': return this.drawProjectile(e, pos, style, 'trident#main', 'trident/trident', -90, 90, false);
			case 'tnt': return this.drawPrimedTnt(e, pos, style);
			case 'falling_block': return this.drawFallingBlock(e, pos, style, world);
			case 'block_display': case 'item_display': case 'text_display': return this.drawDisplay(e, type, pos, style, world);
			case 'painting': return this.drawPainting(e, pos, style, world);
			case 'item_frame': case 'glow_item_frame': return this.drawItemFrame(e, type, pos, style);
			case 'leash_knot': return this.drawSimple(pos, style, 'leash_knot#main', 'lead_knot/lead_knot', 0);
			case 'end_crystal': return this.drawEndCrystal(e, pos, style);
			case 'wither_skull': return this.drawWitherSkull(e, pos, style);
			case 'shulker_bullet': return this.drawShulkerBullet(e, pos, style);
			case 'llama_spit': return this.drawLlamaSpit(e, pos, style);
			case 'wind_charge': case 'breeze_wind_charge': return this.drawWindCharge(e, pos, style);
			case 'fishing_bobber': return this.drawFishingHook(e, pos, style);
			case 'evoker_fangs': return this.drawEvokerFangs(e, pos, style, now);
			// NoopRenderer: only the particles of its client tick (particles.js)
			case 'area_effect_cloud': return;
			default: break;
		}
		if (THROWN[type]) return this.drawThrown(e, type, pos, style);
		if (type.endsWith('_boat') || type.endsWith('_raft')) return this.drawBoat(e, type, pos, style);
		if (type === 'minecart' || type.endsWith('_minecart')) return this.drawMinecart(e, type, pos, style);

		if (type === 'player') {
			const skin = this.skin(e.uuid, e.name);
			e.slim = skin.slim;
		} else if (type === 'mannequin') {
			this.mannequinSkin(e);
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
			party: type === 'parrot' && this.isPartyParrot(e),
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
		const avatar = isAvatar(e);
		if (avatar && (e.sneak || e.pose === 'crouching')) translate(m, 0, -2 / 16 * (e.scale || 1), 0);
		const entityScale = e.scale || 1;
		scale(m, entityScale);
		let body = e.body ?? e.yaw ?? 0;
		const d = e.d || {};
		// LivingEntityRenderer.isShaking: frozen in powder snow, and the renderers' own (converting zombies, piglins
		// and hoglins, skeletons turning into strays, a cold strider)
		if (d.frozen || d.converting || (d.shaking && def.anim === 'skeleton') || (type === 'strider' && d.cold)) {
			body += Math.cos(Math.floor(age) * 3.25) * Math.PI * 0.4;
		}
		// LivingEntityRenderer.getFlipDegrees (spiders, silverfish and endermites roll onto their backs)
		const flip = def.flip || 90;
		if (def.squid) {
			translate(m, 0, e.baby ? 0.25 : 0.5, 0);
			rotate(m, 1, (180 - body) * DEG);
			translate(m, 0, e.baby ? -0.6 : -1.2, 0);
		} else if (e.pose !== 'sleeping') {
			rotate(m, 1, (180 - body) * DEG);
		}
		// AvatarRenderer.isEntityUpsideDown: players and mannequins only while they show their cape
		const upsideDown = (e.name === 'Dinnerbone' || e.name === 'Grumm') && (!avatar || e.parts === undefined || !!(e.parts & 1));
		if (def.anim === 'armorStand') {
			// ArmorStandRenderer.setupRotations: only the body's turn, wiggling for 5 ticks after a hit (event 32)
			const wiggle = age - (anim.memory && anim.memory.lastHit !== undefined ? anim.memory.lastHit : -1e9);
			if (wiggle < 5) rotate(m, 1, Math.sin(wiggle / 1.5 * Math.PI) * 3 * DEG);
		} else if (e.dead && e.deathTime > 0) {
			const fall = Math.min(1, Math.sqrt(Math.max(0, (e.deathTime - 1) / 20 * 1.6)));
			rotate(m, 2, fall * flip * DEG);
		} else if (e.spin) {
			// a riptide trident's spin
			rotate(m, 0, (-90 - (e.pitch || 0)) * DEG);
			rotate(m, 1, age * -75 * DEG);
		} else if (e.pose === 'sleeping') {
			// the bed's direction (sleepDirectionToRotation), else the body's
			rotate(m, 1, (e.bed ? SLEEP_ROTATION[e.bed] ?? 0 : body) * DEG);
			rotate(m, 2, flip * DEG);
			rotate(m, 1, 270 * DEG);
		} else if (upsideDown) {
			translate(m, 0, ((e.h || 1) + 0.1) / entityScale, 0);
			rotate(m, 2, Math.PI);
		}
		if (avatar && e.pose !== 'sleeping') this.avatarRotations(e, m, world, anim);
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
		// FoxRenderer.setupRotations: pouncing and face-planted foxes tilt with their pitch
		if (def.fox && e.d && (e.d.pouncing || e.d.faceplanted)) rotate(m, 0, -(e.pitch || 0) * DEG);
		if (def.panda) pandaRotations(m, e);
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
			// SlimeRenderer and SulfurCubeRenderer.scale: downscaleSlightly (not the magma cube)
			if (type !== 'magma_cube') {
				scale(m, 0.999);
				translate(m, 0, 0.001, 0);
			}
			// AbstractCubeMobRenderer.applySizeAndSquish (a sulfur cube holding a block keeps its shape)
			const squish = def.sulfur && e.cb !== undefined ? 0 : (Number(e.d && e.d.squish) || 0) / (size * 0.5 + 1);
			const w = 1 / (squish + 1);
			scale(m, w * size, size / w, w * size);
			if (def.sulfur) {
				const fuse = sulfurFuse(e);
				if (fuse < 10 && fuse > 0) scale(m, 1 + tntSwell(fuse));
				scale(m, e.baby ? 1 : 0.5);
				translate(m, 0, (e.baby ? 1.24 : 0.98) - (e.invisible ? 0 : 1 / 16), 0);
			}
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
		// AvatarRenderer.scale
		if (def.player) scale(m, 0.9375);
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
				// HumanoidArmorLayer shows its own parts: an armour stand without arms still shows a chestplate's sleeves
				if (def.anim === 'armorStand' && layer.equipment) {
					for (const name of ['left_arm', 'right_arm']) if (model.parts[name]) model.parts[name].visible = true;
				}
			} else {
				mob.anim(model.parts, anim, e);
			}
			equipmentPose(model.parts, e, anim);
			if (!base) base = model;
			// LivingEntityRenderer: an invisible mob's body is not drawn, its equipment layers and energy swirls are.
			if (e.invisible && !layer.equipment && !layer.swirl) continue;
			const start = this.sink.mark();
			// getModelTint (e.g. a wet wolf) tints the entity's own model, not the layers drawn over it.
			let color = layer.color || (model === base && layer === mob.layers[0] && anim.tint) || [1, 1, 1, 1];
			if (layer.alpha) {
				// LivingEntityEmissiveLayer: white at the layer's alpha, not drawn while it is (nearly) zero
				const alpha = layer.alpha(e, age, anim);
				if (alpha <= 1e-5) continue;
				color = [1, 1, 1, alpha];
			}
			let lm = m;
			let layerStyle = style;
			// SulfurCubeInnerLayer: white while the fuse is lit
			if (layer.flash && sulfurLit(e)) layerStyle = { ...style, overlay: [0, 1] };
			if (layer.offset) {
				// the layer's own poseStack.translate (a cape over a chestplate, elytra)
				lm = Float32Array.from(m);
				translate(lm, layer.offset[0], layer.offset[1], layer.offset[2]);
			}
			emitModel(this.sink, model, lm, { ...layerStyle, color });
			// render layers draw with entityCutout too: both sides
			const mode = MODES[layer.mode] ?? MODE_NOCULL;
			const glint = layer.foil && (e.foil & layer.foil) ? GLINT_ARMOR : 0;
			// EnergySwirlLayer: the texture offset by xOffset(ageInTicks) % 1 and ageInTicks * 0.01 % 1; others scroll their own way
			const uv = layer.swirl ? [layer.swirl(age) % 1, age * 0.01 % 1] : layer.scroll ? layer.scroll(age) : null;
			this.batch(texture, mode, start, mode !== MODE_NOCULL && mode !== MODE_TRANSLUCENT && mode !== MODE_TRANSLUCENT_EMISSIVE && mode !== MODE_BREEZE_WIND,
				glint, uv);
		}
		if (!base) return this.drawBox(e, pos, style);
		// SulfurCubeInnerLayer: the block a sulfur cube holds, upside down inside it, white while the fuse is lit
		if (def.sulfur && e.cb !== undefined && !e.wornHead) {
			const mesh = this.blockStateMesh(e.cb, world);
			if (mesh) {
				const bm = Float32Array.from(m);
				rotate(bm, 0, Math.PI);
				if (e.baby) scale(bm, 0.5);
				translate(bm, -0.5, -0.518, -0.5);
				this.emitItem(mesh, bm, sulfurLit(e) ? { ...style, overlay: [0, 1] } : style);
			}
		}
		// CustomHeadLayer: a skull or any item worn on the head
		const headTransforms = CUSTOM_HEADS[type] || (def.armor ? CUSTOM_HEADS.default : null);
		if (headTransforms && (e.skull || e.helm)) this.drawCustomHead(e, base, m, style, headTransforms);
		if (def.player && (e.shoulderL || e.shoulderR)) this.drawShoulderParrots(e, m, style, anim);
		if (def.player && e.spin) this.drawSpinAttack(m, style, age);
		// ArrowLayer, BeeStingerLayer
		if (def.player && e.arrows) this.drawStuckInBody(e, base, m, style, 'minecraft:arrow#main', 'projectiles/arrow', e.arrows, false);
		if (def.player && e.stingers) this.drawStuckInBody(e, base, m, style, 'minecraft:bee_stinger#main', 'bee/bee_stinger', e.stingers, true);

		// Held items (ItemInHandLayer): the main hand's in the right hand, or the left of a left-handed mob or player
		const held = [
			{ item: e.handModel || e.hand, foil: e.foil & FOIL_HAND, patterns: e.handPatterns, props: e.handP },
			{ item: e.offhandModel || e.offhand, foil: e.foil & FOIL_OFFHAND, patterns: e.offhandPatterns, props: e.offhandP },
		];
		if (e.mainArm === 'left') held.reverse();
		const [inRight, inLeft] = held;
		// ArmorStandModel.translateToHand: an armour stand without arms still holds its items
		const armsShown = side => base.parts[side] && (base.parts[side].visible || def.anim === 'armorStand');
		if (inRight.item && armsShown('right_arm')) {
			this.drawHeld(base, m, 'right_arm', inRight.item, inRight.foil ? { ...style, glint: GLINT_ITEM } : style, 1, inRight.patterns, inRight.props, e.armR === 'block');
		}
		if (inLeft.item && armsShown('left_arm')) {
			this.drawHeld(base, m, 'left_arm', inLeft.item, inLeft.foil ? { ...style, glint: GLINT_ITEM } : style, -1, inLeft.patterns, inLeft.props, e.armL === 'block');
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
		if (e.hand && def.fox) this.drawFoxItem(base, m, e, style, anim);
		if (e.hand && def.panda && e.d && e.d.sitting && !e.d.scared) {
			// PandaHoldsItemLayer: bamboo (or whatever it picked up) held up to the mouth while it sits
			let z = -0.6, y = 1.4;
			if (e.d.eating) {
				z -= 0.2 * Math.sin(age * 0.6) + 0.2;
				y -= 0.09 * Math.sin(age * 0.6);
			}
			const im = Float32Array.from(m);
			translate(im, 0.1, y, z);
			this.drawGroundItem(e.handModel || e.hand, im, style, e.handP);
		}
		// IronGolemFlowerLayer: the poppy in the right hand while the golem offers it
		if (def.flower && e.d && e.d.flower > 0) {
			const fm = partMatrix(base, 'right_arm', m);
			if (fm) {
				scale(fm, 16);
				translate(fm, -1.1875 + 0.5, 1.0625 + 0.5, -0.9375 + 0.5);
				scale(fm, 0.5);
				rotate(fm, 0, -90 * DEG);
				translate(fm, -0.5, -0.5, -0.5);
				this.emitBlock('minecraft:poppy', fm, style);
			}
		}
		// MushroomCowMushroomLayer: two mushrooms on a grown mooshroom's back and one on its head
		if (def.mushrooms && !e.baby && !e.invisible) {
			const block = strip(e.d && e.d.variant) === 'brown' ? 'minecraft:brown_mushroom' : 'minecraft:red_mushroom';
			const mushroom = (mm, turn) => {
				rotate(mm, 1, turn * DEG);
				scale(mm, -1, -1, 1);
				translate(mm, -0.5, -0.5, -0.5);
				this.emitBlock(block, mm, style);
			};
			let mm = Float32Array.from(m);
			translate(mm, 0.2, -0.35, 0.5);
			mushroom(mm, -48);
			mm = Float32Array.from(m);
			translate(mm, 0.2, -0.35, 0.5);
			rotate(mm, 1, 42 * DEG);
			translate(mm, 0.1, 0, -0.6);
			mushroom(mm, -48);
			mm = partMatrix(base, 'head', m);
			if (mm) {
				scale(mm, 16);
				translate(mm, 0, -0.7, -0.2);
				mushroom(mm, -78);
			}
		}
		// SnowGolemHeadLayer: the carved pumpkin on its head until it is sheared
		if (def.pumpkinHead && e.d && e.d.pumpkin && !e.invisible) {
			const pm = partMatrix(base, 'head', m);
			if (pm) {
				scale(pm, 16);
				translate(pm, 0, -0.34375, 0);
				rotate(pm, 1, 180 * DEG);
				scale(pm, 0.625, -0.625, -0.625);
				translate(pm, -0.5, -0.5, -0.5);
				// Blocks.CARVED_PUMPKIN.defaultBlockState(): its face to the north, the way the golem looks
				this.emitBlock('minecraft:carved_pumpkin', pm, style, false, { facing: 'north' });
			}
		}
		// CrossedArmsItemLayer (villagers, wandering traders) and WitchItemLayer: the main hand's item held in the
		// crossed arms, or a witch's potion at its nose while it drinks
		if (def.crossedItem && (e.handModel || e.hand)) {
			const potion = def.witch && /(^|:)potion$/.test(strip(e.hand) || '');
			const im = partMatrix(base, potion ? 'nose' : 'arms', m);
			if (im) {
				scale(im, 16);
				if (potion) {
					translate(im, 0.0625, 0.25, 0);
					rotate(im, 2, 180 * DEG);
					rotate(im, 0, 140 * DEG);
					rotate(im, 2, 10 * DEG);
					rotate(im, 0, 180 * DEG);
				} else {
					rotate(im, 0, 0.75);
					scale(im, 1.07);
					translate(im, 0, 0.13, -0.34);
					rotate(im, 0, Math.PI);
				}
				this.drawGroundItem(e.handModel || e.hand, im, e.foil & FOIL_HAND ? { ...style, glint: GLINT_ITEM } : style, e.handP);
			}
		}
		// DolphinCarryingItemLayer: the item in a dolphin's mouth, lower as it dives and higher as it rises
		if (def.carriesItem && (e.handModel || e.hand)) {
			const pitch = Number(e.pitch) || 0;
			const tilt = Math.abs(pitch) / 60;
			const im = Float32Array.from(m);
			if (pitch < 0) translate(im, 0, 1 - tilt * 0.5, -1 + tilt * 0.5);
			else translate(im, 0, 1 + tilt * 0.8, -1 + tilt * 0.2);
			this.drawGroundItem(e.handModel || e.hand, im, e.foil & FOIL_HAND ? { ...style, glint: GLINT_ITEM } : style, e.handP);
		}
		if (def.anim === 'guardian' && e.beam !== undefined) this.drawGuardianBeam(e, type, pos, world);

		// EntityRenderDispatcher: no shadow under invisible entities
		// MobRenderer.getShadowRadius: times the age scale (renderers with their own radius, the functions, do not)
		const ageScale = typeof def.shadow === 'number' ? e.ageScale ?? 1 : 1;
		if (!e.invisible && !e.base) this.shadowFor(e, pos, typeof mob.shadow === 'number' ? mob.shadow * entityScale * ageScale : 0.5, world);
	}

	/**
	 * EvokerFangsRenderer: nothing until the bite starts (entity event 4, CLIENT.evoker_fangs), then the jaws
	 * rise out of the ground, snap and sink back (EvokerFangs.getAnimationProgress, EvokerFangsModel).
	 */
	drawEvokerFangs(e, pos, style, now) {
		const states = this.keyframeStates('evoker_fangs', e, this.animState(e, now));
		const biteAt = states.memory.biteAt;
		if (biteAt === undefined) return;
		const model = this.library.get('minecraft:evoker_fangs#main');
		const texture = model && this.texture('illager/evoker_fangs');
		if (!texture) return;
		// lifeTicks counts down from 22 once the bite started: progress = 1 - (lifeTicks - 2 - partialTick) / 20
		const progress = Math.min(1, Math.max(0, ((e.age || 0) - biteAt) / 20));
		if (progress === 0) return;
		model.reset();
		const p = model.parts;
		let bite = Math.min(progress * 2, 1);
		bite = 1 - bite * bite * bite;
		if (p.upper_jaw) p.upper_jaw.zRot = Math.PI - bite * 0.35 * Math.PI;
		if (p.lower_jaw) p.lower_jaw.zRot = Math.PI + bite * 0.35 * Math.PI;
		if (p.base) p.base.y -= (progress + Math.sin(progress * 2.7)) * 7.2;
		let preScale = 1;
		if (progress > 0.9) preScale *= (1 - progress) / 0.1;
		const root = model.root;
		root.y = 24 - 20 * preScale;
		root.xScale = root.yScale = root.zScale = preScale;
		const m = mat4();
		translate(m, pos[0], pos[1], pos[2]);
		rotate(m, 1, (90 - (e.yaw || 0)) * DEG);
		scale(m, -1, -1, 1);
		translate(m, 0, -1.501, 0);
		const start = this.sink.mark();
		emitModel(this.sink, model, m, style);
		this.batch(texture, MODE_CUTOUT, start);
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
		const start = this.sink.mark();
		this.sink.ensure(18);
		emitQuads(this.sink, quads, m, { color, light: [240, 240], overlay: [0, 0] });
		// setNormal(0, 1, 0): lit like the top of a block
		const out = this.sink.data;
		for (let i = start.v; i < this.sink.count; i++) {
			out[i * FLOATS + 3] = 0; out[i * FLOATS + 4] = 1; out[i * FLOATS + 5] = 0;
		}
		this.batch(texture, MODE_CUTOUT, start, false);
	}

	/**
	 * FishingHookRenderer: the hook sprite facing the camera, half a block big, and the black line from it to the
	 * hand holding the rod, 16 pieces of a curve sagging towards the hook; drawn only while a player owns the hook.
	 */
	drawFishingHook(e, pos, style) {
		const owner = e.fish && this.byId && this.byId.get(e.fish[0]);
		if (!owner) return;
		const frame = this.frame;
		const view = frame.viewRotation;
		const right = [view[0], view[4], view[8]], up = [view[1], view[5], view[9]], back = [view[2], view[6], view[10]];
		const texture = this.texture('fishing/fishing_hook');
		if (texture) {
			const m = mat4();
			for (let i = 0; i < 3; i++) {
				m[i] = right[i] * 0.5; m[4 + i] = up[i] * 0.5; m[8 + i] = back[i] * 0.5; m[12 + i] = pos[i];
			}
			const start = this.sink.mark();
			this.sink.ensure(6);
			emitQuads(this.sink, [-0.5, -0.5, 0, 0, 1, 0.5, -0.5, 0, 1, 1, 0.5, 0.5, 0, 1, 0, -0.5, 0.5, 0, 0, 0], m, style);
			// setNormal(pose, 0, 1, 0): the camera's up
			const out = this.sink.data;
			for (let v = start.v; v < this.sink.count; v++) {
				out[v * FLOATS + 3] = up[0]; out[v * FLOATS + 4] = up[1]; out[v * FLOATS + 5] = up[2];
			}
			this.batch(texture, MODE_CUTOUT, start, false);
		}

		// getPlayerHandPos (third person): below the eyes, in front of the body and to the side of the rod's arm
		const o = frame.origin, cam = frame.camPos;
		const ownerScale = owner.scale || 1;
		const yaw = (owner.body ?? owner.yaw ?? 0) * DEG;
		const sin = Math.sin(yaw), cos = Math.cos(yaw);
		const rightOffset = e.fish[1] * 0.35 * ownerScale, forwardOffset = 0.8 * ownerScale;
		const yOffset = owner.pose === 'crouching' ? -0.1875 : 0;
		const hand = [
			owner.x - o[0] - cam[0] - cos * rightOffset - sin * forwardOffset,
			owner.y - o[1] - cam[1] + (e.fish[2] ?? 1.62 * ownerScale) + yOffset - 0.45 * ownerScale,
			owner.z - o[2] - cam[2] - sin * rightOffset + cos * forwardOffset,
		];
		const xa = hand[0] - pos[0], ya = hand[1] - (pos[1] + 0.25), za = hand[2] - pos[2];
		const points = [];
		for (let i = 0; i <= 16; i++) {
			const a = i / 16;
			points.push([pos[0] + xa * a, pos[1] + ya * (a * a + a) * 0.5 + 0.25, pos[2] + za * a]);
		}
		// RenderTypes.lines at Window.getAppropriateLineWidth pixels: a ribbon across the view, as wide on screen
		const lineWidth = Math.max(2.5, (frame.width || 1920) / 1920 * 2.5);
		const perPixel = 2 / ((frame.projection ? frame.projection[5] : 1) * (frame.height || 1080));
		const edges = points.map((p, i) => {
			const a = points[Math.max(0, i - 1)], b = points[Math.min(16, i + 1)];
			const t = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
			// across the line and the view ray
			let sx = t[1] * p[2] - t[2] * p[1], sy = t[2] * p[0] - t[0] * p[2], sz = t[0] * p[1] - t[1] * p[0];
			const len = Math.hypot(sx, sy, sz);
			if (len < 1e-9) return [p, p];
			const depth = Math.max(0.05, -(p[0] * back[0] + p[1] * back[1] + p[2] * back[2]));
			const half = lineWidth * 0.5 * depth * perPixel / len;
			sx *= half; sy *= half; sz *= half;
			return [[p[0] - sx, p[1] - sy, p[2] - sz], [p[0] + sx, p[1] + sy, p[2] + sz]];
		});
		const quads = [];
		for (let i = 0; i < 16; i++) {
			const [a0, a1] = edges[i], [b0, b1] = edges[i + 1];
			quads.push(...a0, 0.5, 0.5, ...b0, 0.5, 0.5, ...b1, 0.5, 0.5, ...a1, 0.5, 0.5);
		}
		const start = this.sink.mark();
		this.sink.ensure(16 * 6);
		emitQuads(this.sink, quads, mat4(), { color: [0, 0, 0, 1], light: [240, 240], overlay: [0, 0] });
		this.batch(this.white, MODE_NOCULL, start, false);
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
			// tinted like away from the world (BlockTintSource.color)
			const grass = this.assets.colormap ? this.assets.colormap('grass', 0.5, 1, 0x7cbd6b) : 0x7cbd6b;
			const quads = [];
			for (const part of parts) {
				for (const list of part.quads) {
					for (const q of list) {
						const c = q.tint >= 0 ? tintInHand(info, q.tint, grass) : -1;
						quads.push({ q, tint: c < 0 ? [1, 1, 1] : [(c >> 16 & 255) / 255, (c >> 8 & 255) / 255, (c & 255) / 255] });
					}
				}
			}
			if (quads.length) mesh = { kind: 'block', quads: this.blockQuads(quads) };
		}
		this.itemMeshes.set(key, mesh);
		return mesh;
	}

	/**
	 * CustomHeadLayer: a skull or head worn on the head, 1.1875 times its block size (a player head with its owner's
	 * skin), or any other item there in its "head" display transform, both scaled and moved by the renderer's
	 * transforms (villagers, piglins and sulfur cubes have their own).
	 */
	drawCustomHead(e, base, m, style, t) {
		const hm = Float32Array.from(m);
		scale(hm, t.h, t.v, t.h);
		// HeadedModel.translateToHead (a sulfur cube's head is its cube)
		const pm = partMatrix(base, base.parts.head ? 'head' : 'cube', hm);
		if (!pm) return;
		scale(pm, 16);
		if (e.skull) {
			const kind = SPECIAL_HEADS[e.skull.t] || SPECIAL_HEADS.skeleton;
			const model = this.library.get('minecraft:' + kind[0] + '#main');
			const owner = e.skull.t === 'player' && (e.skull.id || e.skull.name);
			const texture = owner ? this.skin(e.skull.id || 'name:' + e.skull.name, e.skull.name).texture : this.texture(kind[1]);
			if (!model || !texture) return;
			model.reset();
			translate(pm, 0, t.skullY, 0);
			scale(pm, 1.1875);
			const start = this.sink.mark();
			emitModel(this.sink, model, pm, style);
			// a player's skin as a translucent (the renderer's cutout for sulfur cubes), the other skulls cutout
			this.batch(texture, owner && !t.cutout ? MODE_TRANSLUCENT : MODE_CUTOUT, start, true);
			return;
		}
		const mesh = this.itemMesh(e.helmModel || e.helm, e.helmP, 'head');
		if (!mesh) return;
		translate(pm, 0, -0.25 + t.y, 0);
		rotate(pm, 1, Math.PI);
		scale(pm, 0.625, -0.625, -0.625);
		this.applyDisplay(pm, this.displayTransform(e.helm, 'head', {}, mesh.modelId), false);
		this.emitItem(mesh, pm, e.foil & FOIL_ARMOR ? { ...style, glint: GLINT_ITEM } : style, e.helmPatterns);
	}

	/**
	 * ParrotOnShoulderLayer: the parrots a player carries, sitting on their shoulders in the ON_SHOULDER pose and
	 * looking where the player looks.
	 */
	drawShoulderParrots(e, m, style, anim) {
		const model = this.library.get('minecraft:parrot#main');
		if (!model) return;
		const parrot = { type: 'minecraft:parrot', d: {} };
		const pose = describeMob(parrot);
		if (!pose || !pose.anim) return;
		const crouching = !!(e.sneak || e.pose === 'crouching');
		for (const [variant, left] of [[e.shoulderL, true], [e.shoulderR, false]]) {
			if (!variant) continue;
			const texture = this.texture('parrot/parrot_' + variant.replace(/^gray$/, 'grey'));
			if (!texture) continue;
			model.reset();
			pose.anim(model.parts, { ...anim, shoulder: true, party: false, isBase: true }, parrot);
			const pm = Float32Array.from(m);
			translate(pm, left ? 0.4 : -0.4, crouching ? -1.3 : -1.5, 0);
			const start = this.sink.mark();
			emitModel(this.sink, model, pm, style);
			this.batch(texture, MODE_CUTOUT, start, true);
		}
	}

	/** SpinAttackEffectLayer: the two whirls around a player spinning with a riptide trident, turning each its own way. */
	drawSpinAttack(m, style, age) {
		const model = this.library.get('minecraft:spin_attack#main');
		const texture = this.texture('trident/trident_riptide');
		if (!model || !texture) return;
		model.reset();
		for (let i = 0; i < 2; i++) {
			const box = model.parts['box' + i];
			if (box) box.yRot = wrapDegrees(age * -(45 + (i + 1) * 5)) * DEG;
		}
		const start = this.sink.mark();
		emitModel(this.sink, model, m, style);
		this.batch(texture, MODE_NOCULL, start, false);
	}

	/**
	 * StuckInBodyLayer: arrows or bee stingers stuck in a player or mannequin, each in a body part and one of its
	 * cubes picked by a random seeded with the entity's id (so they stay where they are), pointing out of it; an
	 * arrow sticks inside the cube, a stinger on one of its faces (or its middle, snapToFace).
	 */
	drawStuckInBody(e, base, m, style, layer, texturePath, count, onSurface) {
		const model = this.library.get(layer);
		const texture = this.texture(texturePath);
		if (!model || !texture) return;
		model.reset();
		// RandomSource.createThreadLocalInstance(state.id)
		const random = new JavaRandom();
		random.setSeedNumber(e.id);
		const start = this.sink.mark();
		for (let i = 0; i < Math.min(count, 64); i++) {
			// PlayerModel.getRandomBodyPart, ModelPart.getRandomCube
			const name = STUCK_BODY_PARTS[random.nextInt(STUCK_BODY_PARTS.length)];
			const cubes = partCubes(base.parts[name]);
			if (!cubes.length) return;
			const cube = cubes[random.nextInt(cubes.length)];
			const pm = partMatrix(base, name, m);
			if (!pm) return;
			let midX = random.nextFloat(), midY = random.nextFloat(), midZ = random.nextFloat();
			if (onSurface) {
				const snap = v => (v > 0.5 ? 1 : 0.5);
				const plane = random.nextInt(3);
				if (plane === 0) midX = snap(midX);
				else if (plane === 1) midY = snap(midY);
				else midZ = snap(midZ);
			}
			// (partMatrix is in model pixels)
			translate(pm, lerp(cube[0], cube[3], midX), lerp(cube[1], cube[4], midY), lerp(cube[2], cube[5], midZ));
			const dx = -(midX * 2 - 1), dy = -(midY * 2 - 1), dz = -(midZ * 2 - 1);
			const yRot = Math.atan2(dx, dz) * 180 / Math.PI;
			const xRot = Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)) * 180 / Math.PI;
			rotate(pm, 1, (yRot - 90) * DEG);
			rotate(pm, 2, xRot * DEG);
			scale(pm, 16);
			emitModel(this.sink, model, pm, style);
		}
		this.batch(texture, MODE_CUTOUT, start, true);
	}

	/** AvatarRenderer.setupRotations: players lie down while swimming, crawling and gliding with elytra. */
	avatarRotations(e, m, world, anim) {
		const pitch = e.pitch || 0;
		if (e.pose === 'fall_flying') {
			const t = e.flyingTicks || 0;
			if (!e.spin) rotate(m, 0, Math.min(1, t * t / 100) * (-90 - pitch) * DEG);
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
		this.boxed.add(e.item ? e.type + ' (' + e.item + ')' : e.type);
		const w = (e.w || 0.6) / 2, h = e.h || 0.6;
		const q = [];
		const corners = [[-w, 0, -w], [w, 0, -w], [w, h, -w], [-w, h, -w], [-w, 0, w], [w, 0, w], [w, h, w], [-w, h, w]];
		const faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 4, 7, 3], [1, 2, 6, 5], [3, 7, 6, 2], [0, 1, 5, 4]];
		for (const f of faces) for (const i of f) q.push(...corners[i], 0.5, 0.5);
		const m = mat4();
		translate(m, pos[0], pos[1], pos[2]);
		const start = this.sink.mark();
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
		const start = this.sink.mark();
		emitModel(this.sink, model, m, style);
		this.batch(texture, MODE_CUTOUT, start);
	}

	/** WitherSkullRenderer: the skull upside down, its head turned by the skull's yaw and pitch, blue when dangerous, at full light. */
	drawWitherSkull(e, pos, style) {
		const model = this.library.get('minecraft:wither_skull#main');
		const texture = this.texture(e.d && e.d.dangerous ? 'wither/wither_invulnerable' : 'wither/wither');
		if (!model || !texture) return;
		model.reset();
		const head = model.parts.head;
		if (head) {
			head.yRot = (e.yaw || 0) * DEG;
			head.xRot = (e.pitch || 0) * DEG;
		}
		const m = mat4();
		translate(m, pos[0], pos[1], pos[2]);
		scale(m, -1, -1, 1);
		const start = this.sink.mark();
		emitModel(this.sink, model, m, { ...style, light: [240, style.light[1]] });
		this.batch(texture, MODE_NOCULL, start, false);
	}

	/**
	 * ShulkerBulletRenderer: the spark tumbling with its age at full light, half a block big, inside a translucent
	 * copy of itself half as big again.
	 */
	drawShulkerBullet(e, pos, style) {
		const model = this.library.get('minecraft:shulker_bullet#main');
		const texture = this.texture('shulker/spark');
		if (!model || !texture) return;
		model.reset();
		// ShulkerBulletModel.setupAnim: turned by the bullet's own yaw and pitch too
		if (model.parts.main) {
			model.parts.main.yRot = (e.yaw || 0) * DEG;
			model.parts.main.xRot = (e.pitch || 0) * DEG;
		}
		const t = e.age || 0;
		const m = mat4();
		translate(m, pos[0], pos[1] + 0.15, pos[2]);
		rotate(m, 1, Math.sin(t * 0.1) * 180 * DEG);
		rotate(m, 0, Math.cos(t * 0.1) * 180 * DEG);
		rotate(m, 2, Math.sin(t * 0.15) * 360 * DEG);
		scale(m, -0.5, -0.5, 0.5);
		const bulletStyle = { ...style, light: [240, style.light[1]] };
		let start = this.sink.mark();
		emitModel(this.sink, model, m, bulletStyle);
		this.batch(texture, MODE_NOCULL, start, false);
		scale(m, 1.5);
		start = this.sink.mark();
		// colour 654311423: white at alpha 0x26
		emitModel(this.sink, model, m, { ...bulletStyle, color: [1, 1, 1, 0x26 / 255] });
		this.batch(texture, MODE_TRANSLUCENT, start, false);
	}

	/**
	 * WindChargeRenderer: WindChargeModel at the charge's position, its core and its wind turning opposite ways by 16°
	 * a tick, drawn like the breeze's wind (RenderTypes.breezeWind) with the texture drifting by xOffset(age) % 1.
	 */
	drawWindCharge(e, pos, style) {
		const model = this.library.get('minecraft:wind_charge#main');
		const texture = this.texture('projectiles/wind_charge');
		if (!model || !texture) return this.drawBox(e, pos, style);
		model.reset();
		const age = e.age || 0;
		const p = model.parts;
		if (p.wind_charge) p.wind_charge.yRot = -age * 16 * DEG;
		if (p.wind) p.wind.yRot = age * 16 * DEG;
		const m = mat4();
		translate(m, pos[0], pos[1], pos[2]);
		const start = this.sink.mark();
		emitModel(this.sink, model, m, style);
		this.batch(texture, MODE_BREEZE_WIND, start, false, 0, [age * 0.03 % 1, 0]);
	}

	/** LlamaSpitRenderer: the spit's cubes a little above its position, turned by its yaw (less 90°) and pitch. */
	drawLlamaSpit(e, pos, style) {
		const model = this.library.get('minecraft:llama_spit#main');
		const texture = this.texture('llama/llama_spit');
		if (!model || !texture) return;
		model.reset();
		const m = mat4();
		translate(m, pos[0], pos[1] + 0.15, pos[2]);
		rotate(m, 1, ((e.yaw || 0) - 90) * DEG);
		rotate(m, 2, (e.pitch || 0) * DEG);
		const start = this.sink.mark();
		emitModel(this.sink, model, m, style);
		this.batch(texture, MODE_NOCULL, start, false);
	}

	/** ArrowRenderer / ThrownTridentRenderer: the model turned by the yaw less 90° and the pitch (plus an offset). */
	drawProjectile(e, pos, style, layer, texturePath, yawOffset, pitchOffset, cull) {
		const model = this.library.get('minecraft:' + layer);
		const texture = this.texture(texturePath);
		if (!model || !texture) return;
		model.reset();
		const m = mat4();
		translate(m, pos[0], pos[1], pos[2]);
		rotate(m, 1, ((e.yaw || 0) + yawOffset) * DEG);
		rotate(m, 2, ((e.pitch || 0) + pitchOffset) * DEG);
		const start = this.sink.mark();
		emitModel(this.sink, model, m, style);
		this.batch(texture, cull ? MODE_CUTOUT : MODE_NOCULL, start, cull);
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
		const start = this.sink.mark();
		emitModel(this.sink, model, m, style);
		this.batch(texture, MODE_CUTOUT, start);
		this.shadowFor(e, pos, 0.8, this.world);
	}

	/**
	 * AbstractMinecartRenderer: jittered a little by the id (offsetSeed), sitting on its rail and tilted along it
	 * (oldRender, the rail position and angles from the server) or turned by its own rotation (newRender, experimental
	 * minecarts), rocking when hit, with the block it carries (a lit furnace, TNT flashing and swelling on its fuse
	 * like TntMinecartRenderer) three quarters big at its display offset.
	 */
	drawMinecart(e, type, pos, style) {
		const layer = type === 'minecart' ? 'minecart#main' : type + '#main';
		const model = this.library.get('minecraft:' + layer) || this.library.get('minecraft:minecart#main');
		const texture = this.texture('minecart/minecart');
		if (!model || !texture) return this.drawBox(e, pos, style);
		model.reset();
		const m = mat4();
		translate(m, pos[0], pos[1], pos[2]);
		const jitter = minecartJitter(e.id);
		translate(m, jitter[0], jitter[1], jitter[2]);
		if (e.newCart) {
			rotate(m, 1, (e.yaw || 0) * DEG);
			rotate(m, 2, -(e.pitch || 0) * DEG);
			translate(m, 0, 0.375, 0);
		} else {
			let yRot = e.yaw || 0, xRot = e.pitch || 0;
			if (e.rail) {
				translate(m, e.rail[0], e.rail[1], e.rail[2]);
				yRot = e.rail[3];
				xRot = e.rail[4];
			}
			translate(m, 0, 0.375, 0);
			rotate(m, 1, (180 - yRot) * DEG);
			rotate(m, 2, -xRot * DEG);
		}
		const hurt = e.hurtTime || 0;
		if (hurt > 0) rotate(m, 0, Math.sin(hurt) * hurt * Math.max(0, e.damage || 0) / 10 * (e.hurtDir || 1) * DEG);
		if (e.db !== undefined) {
			const b = Float32Array.from(m);
			scale(b, 0.75);
			translate(b, -0.5, ((e.dOff ?? 6) - 8) / 16, 0.5);
			rotate(b, 1, 90 * DEG);
			let blockStyle = style;
			if (type === 'tnt_minecart') {
				// MinecartTntRenderState.fuseRemainingInTicks: getFuse() - partialTick + 1 while primed, else -1
				const fuse = e.d && typeof e.d.fuse === 'number' && e.d.fuse > -1 ? e.d.fuse + (this.frozen ? 0 : 1) : -1;
				if (fuse > -1 && fuse < 10) {
					const swell = tntSwell(fuse);
					translate(b, -swell * 0.5, 0, -swell * 0.5);
					scale(b, 1 + swell);
				}
				blockStyle = { ...style, overlay: [0, fuse > -1 && tntLit(fuse) ? 1 : 0] };
			}
			const mesh = this.blockStateMesh(e.db, this.world);
			if (mesh) this.emitItem(mesh, b, blockStyle);
			this.drawSpecialBlock(e.db, b, blockStyle, this.world);
		}
		scale(m, -1, -1, 1);
		const start = this.sink.mark();
		emitModel(this.sink, model, m, style);
		this.batch(texture, MODE_CUTOUT, start);
		this.shadowFor(e, pos, 0.7, this.world);
	}

	/**
	 * EndCrystalRenderer: EndCrystalModel twice as big, its glass bobbing (getY) and spinning 3° a tick, each cube
	 * tilted 60° about the diagonal (sin 45°, 0, sin 45°) (EndCrystalModel.setupAnim), the base shown or not.
	 */
	drawEndCrystal(e, pos, style) {
		const model = this.library.get('minecraft:end_crystal#main');
		const texture = this.texture('end_crystal/end_crystal');
		if (!model || !texture) return this.drawBox(e, pos, style);
		model.reset();
		const age = e.age || 0;
		const p = model.parts;
		if (p.base) p.base.visible = !(e.d && e.d.bottom === false);
		const bob = Math.sin(age * 0.2) / 2 + 0.5;
		const crystalY = ((bob * bob + bob) * 0.4 - 1.4) * 16;
		const spin = rotationY3(age * 3 * DEG), tilt = rotationAxis3(Math.PI / 3, Math.SQRT1_2, 0, Math.SQRT1_2);
		if (p.outer_glass) {
			p.outer_glass.y += crystalY / 2;
			setPartRotation(p.outer_glass, mul3(spin, tilt));
		}
		if (p.inner_glass) setPartRotation(p.inner_glass, mul3(tilt, spin));
		if (p.cube) setPartRotation(p.cube, mul3(tilt, spin));
		const m = mat4();
		translate(m, pos[0], pos[1], pos[2]);
		scale(m, 2);
		translate(m, 0, -0.5, 0);
		const start = this.sink.mark();
		emitModel(this.sink, model, m, style);
		this.batch(texture, MODE_NOCULL, start, false);
		this.shadowFor(e, pos, 0.5, this.world);
	}

	/**
	 * PaintingRenderer: the picture on the front of a box 1/16 deep, the back and the edges from the painting
	 * atlas' "back" sprite, each block of it lit by its own block (extractRenderState's lightCoordsPerBlock).
	 * Data packs' own paintings take their pictures from the resource packs (namespace:path).
	 */
	drawPainting(e, pos, style, world) {
		const d = e.d || {};
		const asset = strip(d.asset || d.variant);
		const width = Math.max(1, Math.min(16, Number(d.pw) || 1)), height = Math.max(1, Math.min(16, Number(d.ph) || 1));
		const front = asset ? this.texture(asset, 'painting') : null;
		const back = this.texture('back', 'painting');
		if (!front || !back) return;
		const direction = { south: 0, west: 1, north: 2, east: 3 }[d.facing || 'south'] ?? 0;
		const m = mat4();
		translate(m, pos[0], pos[1], pos[2]);
		rotate(m, 1, (180 - direction * 90) * DEG);
		const offsetX = -width / 2, offsetY = -height / 2;
		const lights = [];
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const sx = x + offsetX + 0.5, sy = y + offsetY + 0.5;
				let bx = Math.floor(e.x), bz = Math.floor(e.z);
				const by = Math.floor(e.y + sy);
				if (direction === 2) bx = Math.floor(e.x + sx);
				else if (direction === 1) bz = Math.floor(e.z - sx);
				else if (direction === 0) bx = Math.floor(e.x - sx);
				else bz = Math.floor(e.z + sx);
				const [sky, block] = world ? world.lightAt(bx, by, bz) : [15, 0];
				lights.push([block * 16, sky * 16]);
			}
		}
		const z = 0.03125;
		const cell = (x, y, frontSide) => {
			const x0 = offsetX + x + 1, x1 = offsetX + x, y0 = offsetY + y + 1, y1 = offsetY + y;
			if (frontSide) {
				const u0 = (width - x) / width, u1 = (width - x - 1) / width;
				const v0 = (height - y) / height, v1 = (height - y - 1) / height;
				return [x0, y1, -z, u1, v0, x1, y1, -z, u0, v0, x1, y0, -z, u0, v1, x0, y0, -z, u1, v1];
			}
			// back (the whole sprite per block), then the edges on the outside (a 1/16 strip of the sprite)
			const q = [x0, y0, z, 1, 0, x1, y0, z, 0, 0, x1, y1, z, 0, 1, x0, y1, z, 1, 1];
			const strip = 0.0625;
			if (y === height - 1) q.push(x0, y0, -z, 0, 0, x1, y0, -z, 1, 0, x1, y0, z, 1, strip, x0, y0, z, 0, strip);
			if (y === 0) q.push(x0, y1, z, 0, 0, x1, y1, z, 1, 0, x1, y1, -z, 1, strip, x0, y1, -z, 0, strip);
			if (x === width - 1) q.push(x0, y0, z, strip, 0, x0, y1, z, strip, 1, x0, y1, -z, 0, 1, x0, y0, -z, 0, 0);
			if (x === 0) q.push(x1, y0, -z, strip, 0, x1, y1, -z, strip, 1, x1, y1, z, 0, 1, x1, y0, z, 0, 0);
			return q;
		};
		for (const [texture, frontSide] of [[front, true], [back, false]]) {
			const start = this.sink.mark();
			for (let x = 0; x < width; x++) {
				for (let y = 0; y < height; y++) {
					const quads = new Float32Array(cell(x, y, frontSide));
					this.sink.ensure(quads.length / 20 * 6);
					emitQuads(this.sink, quads, m, { ...style, light: lights[x + y * width], overlay: [0, 0] });
				}
			}
			this.batch(texture, MODE_CUTOUT, start);
		}
	}

	// --- items -------------------------------------------------------------------------------------

	/** Item geometry in item model space (0..1 box): extruded sprite, or a block model. Cached. */
	/**
	 * An item's mesh as its model definition (items/*.json) picks it for the stack's properties and the display
	 * context ("ground", "fixed", "thirdperson_righthand"...), falling back to the item's own sprite or block model.
	 */
	itemMesh(itemId, props = null, context = 'none') {
		if (!this.assets || !itemId) return null;
		const defined = this.definedItemMesh(itemId, props, context);
		if (defined !== undefined) return defined;
		return this.legacyItemMesh(itemId);
	}

	/** The definitions of the bundle, or null while it has none (an older bundle). */
	itemDefinitions() {
		const items = this.assets && this.assets.bundle && this.assets.bundle.items;
		if (!items) return null;
		if (!this.definitions || this.definitions.source !== items) {
			this.definitions = new ItemDefinitions(items, (name, t, d, fallback) => this.assets.colormap(name, t, d, fallback));
			this.definitions.source = items;
		}
		return this.definitions;
	}

	/** ItemModelResolver: undefined when the definition is not usable here (special renderers take the old path). */
	definedItemMesh(itemId, props, context) {
		const definitions = this.itemDefinitions();
		if (!definitions || !definitions.has(itemId)) return undefined;
		const layers = definitions.resolve(itemId, props || {}, { context, dayTime: this.dayTime || 0, dimension: this.dimension });
		if (!layers) return undefined;
		const special = layers.find(layer => layer.special);
		if (special) {
			// SpecialModelWrapper: the special model this definition picks (a chest at Christmas...), drawn like the
			// items the bundle lists as special
			const listed = this.specialItem(itemId);
			const picked = special.special;
			if (!listed || strip(listed.type) === 'composite') return undefined;
			return this.legacyItemMesh(itemId, picked);
		}
		if (!layers.length) return null;
		const key = 'def|' + layers.map(l => l.model + ':' + l.tints.map(t => t.map(c => c.toFixed(3)).join(',')).join(';')).join('|');
		let mesh = this.itemMeshes.get(key);
		if (mesh !== undefined) return mesh;
		const parts = [];
		let kind = 'sprite';
		for (const layer of layers) {
			const built = this.modelMesh(layer.model, layer.tints);
			if (!built) continue;
			if (built.kind === 'block') kind = 'block';
			parts.push(built.quads);
		}
		mesh = null;
		if (parts.length) {
			const total = parts.reduce((sum, q) => sum + q.data.length, 0);
			const data = new Float32Array(total);
			const tints = [];
			let offset = 0;
			for (const q of parts) {
				data.set(q.data, offset);
				offset += q.data.length;
				const count = q.data.length / 20;
				for (let i = 0; i < count; i++) tints.push(q.tints ? q.tints[i] : [1, 1, 1]);
			}
			mesh = { kind, quads: { data, tints }, modelId: layers[0].model };
		}
		this.itemMeshes.set(key, mesh);
		return mesh;
	}

	/**
	 * One item model: generated ones (item/generated) extrude each layerN texture with tint N like
	 * ItemModelGenerator; the others are baked like block models, their faces tinted by tintindex.
	 */
	modelMesh(modelId, tints) {
		const models = this.assets.bundle.models || {};
		let generated = false;
		const textures = {};
		const chain = [];
		let current = modelId;
		for (let depth = 0; current && depth < 32; depth++) {
			const id = current.includes(':') ? current : 'minecraft:' + current;
			if (id === 'minecraft:builtin/generated') {
				generated = true;
				break;
			}
			const model = models[id];
			if (!model) break;
			chain.push(model);
			current = model.parent;
		}
		if (!chain.length) return null;
		if (generated) {
			for (let i = chain.length - 1; i >= 0; i--) Object.assign(textures, chain[i].textures || {});
			const data = [];
			const quadTints = [];
			for (let layer = 0; layer < 16; layer++) {
				const texture = this.assets.models ? this.assets.models.resolveTexture(textures, '#layer' + layer) : null;
				if (!texture) break;
				const sprite = this.assets.sprites.get(texture.id);
				if (!sprite) continue;
				const quads = this.extrude(sprite);
				data.push(quads.data);
				const tint = tints[layer] || [1, 1, 1];
				for (let i = 0; i < quads.data.length / 20; i++) quadTints.push(tint);
			}
			if (!data.length) return null;
			const merged = new Float32Array(data.reduce((sum, d) => sum + d.length, 0));
			let offset = 0;
			for (const d of data) {
				merged.set(d, offset);
				offset += d.length;
			}
			return { kind: 'sprite', quads: { data: merged, tints: quadTints } };
		}
		if (!this.assets.models) return null;
		const baked = this.assets.models.bakeVariant({ model: modelId });
		const list = [];
		for (const quads of baked.quads) {
			for (const q of quads) list.push({ q, tint: q.tint >= 0 ? (tints[q.tint] || [1, 1, 1]) : [1, 1, 1] });
		}
		return list.length ? { kind: 'block', quads: this.blockQuads(list) } : null;
	}

	/** Items without a usable definition: the item's own sprite, special model or block model. */
	legacyItemMesh(itemId, picked = null) {
		const key = picked ? itemId + '|' + JSON.stringify(picked.model) + JSON.stringify(picked.transforms || '') : itemId;
		let mesh = this.itemMeshes.get(key);
		if (mesh !== undefined) return mesh;
		mesh = null;
		const id = itemId.includes(':') ? itemId : 'minecraft:' + itemId;
		const colon = id.indexOf(':');
		const ns = id.slice(0, colon), name = id.slice(colon + 1);
		const models = this.assets.models;
		let sprite = this.assets.sprites.get(ns + ':item/' + name);
		if (!sprite) {
			// an item definition of a pack's own namespace: the texture of the model it names
			const modelId = (this.assets.bundle.itemModels || {})[id];
			const model = modelId && (this.assets.bundle.models || {})[modelId];
			const layer = model && model.textures && model.textures.layer0;
			if (layer) sprite = this.assets.sprites.get(layer.includes(':') ? layer : 'minecraft:' + layer);
		}
		const special = picked || this.specialItem(id);
		if (special && strip(special.type) === 'composite') {
			mesh = this.compositeMesh(special);
		} else if (special && SPECIAL_ITEM_TYPES.has(strip(special.model && special.model.type)) && !(sprite && !picked && strip(special.model.type) === 'trident')) {
			// SpecialModelWrapper: drawn by the special renderer (without a definition that picks it for the hands, a
			// trident keeps its flat sprite)
			mesh = { kind: 'block', special };
		} else if (sprite) {
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
		this.itemMeshes.set(key, mesh);
		return mesh;
	}

	/**
	 * A mob the viewer's table does not know yet: drawn with the game's model layer "<name>#main" (and
	 * "<name>_baby#main" for babies) and textures/entity/<name>/<name>.png (or the first texture in that folder),
	 * walking with the generic animation. Undefined while the models are loading, null when nothing fits.
	 */
	autoMob(type) {
		if (!this.library.layers || !this.entityList || !this.entityList.size) return undefined;
		const mapped = this.library.renderers && this.library.renderers['minecraft:' + type];
		const byRenderer = mapped ? this.rendererMob(mapped) : null;
		if (byRenderer) return byRenderer;
		if (!/^[a-z0-9_]+$/.test(type) || !this.library.get('minecraft:' + type + '#main')) return null;
		const texture = [type + '/' + type, type].find(t => this.entityList.has(t))
			|| [...this.entityList].sort().find(t => t.startsWith(type + '/'));
		if (!texture) return null;
		const baby = this.library.get('minecraft:' + type + '_baby#main') ? type + '_baby#main' : null;
		return { layer: e => (e.baby && baby ? baby : type + '#main'), texture, shadow: 0.5, anim: 'generic', auto: true };
	}

	/**
	 * A mob drawn the way its renderer in the client jar says (EntityRendererMap): its first adult and baby
	 * "#main" model layers, its first adult and baby textures and its shadow radius, with a generic walk.
	 */
	rendererMob(mapped) {
		const layers = (mapped.l || []).filter(id => id.endsWith('#main') && this.library.get(id));
		const textures = (mapped.t || []).filter(t => this.entityList.has(t));
		const adultLayer = layers.find(id => !id.includes('baby')), babyLayer = layers.find(id => id.includes('baby'));
		const adultTexture = textures.find(t => !t.includes('baby')), babyTexture = textures.find(t => t.includes('baby'));
		if (!adultLayer || !adultTexture) return null;
		const strip = id => id.replace(/^minecraft:/, '');
		return {
			layer: e => strip(e.baby && babyLayer ? babyLayer : adultLayer),
			texture: e => (e.baby && babyLayer && babyTexture ? babyTexture : adultTexture),
			shadow: typeof mapped.s === 'number' ? mapped.s : 0.5, anim: 'generic', auto: true,
		};
	}

	/** The item definition's special or composite model (items/*.json of the game), or null. */
	specialItem(id) {
		const items = this.assets && this.assets.bundle.specialItems;
		return (items && items[id.includes(':') ? id : 'minecraft:' + id]) || null;
	}

	/** CompositeModel of plain models (beds: the head, and the foot one block further), each moved by its transformation. */
	compositeMesh(spec) {
		const models = this.assets.models;
		if (!models) return null;
		const list = [], offsets = [];
		for (const child of spec.models || []) {
			if (strip(child.type) !== 'model' || !child.model) return null;
			const baked = models.bakeVariant({ model: child.model.includes(':') ? child.model : 'minecraft:' + child.model });
			const t = (child.transformation && child.transformation.translation) || [0, 0, 0];
			for (const quads of baked.quads) {
				for (const q of quads) {
					list.push({ q, tint: [1, 1, 1] });
					offsets.push(t);
				}
			}
		}
		if (!list.length) return null;
		const quads = this.blockQuads(list);
		offsets.forEach((t, i) => {
			for (let k = 0; k < 4; k++) {
				const o = i * 20 + k * 5;
				quads.data[o] += t[0]; quads.data[o + 1] += t[1]; quads.data[o + 2] += t[2];
			}
		});
		return { kind: 'block', quads };
	}

	/**
	 * The special renderers of items (ChestSpecialRenderer, ShulkerBoxSpecialRenderer, SkullSpecialRenderer,
	 * BannerSpecialRenderer...): their entity model in the item's space, moved by the definition's transformation,
	 * resting and animated like an unopened block of its kind.
	 */
	drawSpecialItem(spec, m, style, patterns) {
		const model = spec.model || {};
		// the transformations of the definition's nodes above the special model (ClientAssets / ItemDefinitions), then its own
		let lm = Float32Array.from(m);
		for (const t of spec.transforms || []) lm = mul(lm, transformationMatrix(t));
		if (spec.transformation) lm = mul(lm, transformationMatrix(spec.transformation));
		const emit = (layer, texturePath, pose = null, color = null, mode = MODE_CUTOUT) => {
			const entityModel = this.library.get(layer);
			const texture = this.texture(texturePath);
			if (!entityModel || !texture) return false;
			entityModel.reset();
			if (pose) pose(entityModel.parts, entityModel.root);
			const start = this.sink.mark();
			emitModel(this.sink, entityModel, lm, color ? { ...style, color } : style);
			this.batch(texture, mode, start, false, style.glint || 0);
			return true;
		};
		const texture = String(model.texture || '').replace(/^[a-z0-9_.-]+:/, '');
		switch (strip(model.type)) {
			case 'chest': {
				// ChestModel.setupAnim(openness)
				const type = strip(model.chest_type || 'single');
				const open = Number(model.openness) || 0;
				emit(type === 'single' ? 'minecraft:chest#main' : 'minecraft:double_chest_' + type + '#main', 'chest/' + texture, parts => {
					if (parts.lid) parts.lid.xRot = -(open * Math.PI / 2);
					if (parts.lock) parts.lock.xRot = -(open * Math.PI / 2);
				});
				break;
			}
			case 'shulker_box': {
				const open = Number(model.openness) || 0;
				emit('minecraft:shulker_box#main', 'shulker/' + (texture || 'shulker'), parts => {
					if (!parts.lid || !open) return;
					parts.lid.y = 24 - open * 0.5 * 16;
					parts.lid.yRot = 270 * open * DEG;
				});
				break;
			}
			case 'conduit':
				emit('minecraft:conduit#shell', 'conduit/base');
				break;
			case 'head':
			case 'player_head': {
				const head = SPECIAL_HEADS[strip(model.type) === 'player_head' ? 'player' : model.kind] || SPECIAL_HEADS.skeleton;
				emit('minecraft:' + head[0] + '#main', texture ? texture.replace(/^textures\/entity\//, '').replace(/\.png$/, '') : head[1],
					parts => { if (parts.head) parts.head.yRot = 0; });
				break;
			}
			case 'banner': {
				const base = model.attachment === 'wall' ? 'minecraft:wall_banner' : 'minecraft:standing_banner';
				const sway = parts => { if (parts.flag) parts.flag.xRot = (-0.0125 + 0.01) * Math.PI; };
				emit(base + '#main', 'banner/banner_base');
				emit(base + '#flag', 'banner/banner_base', sway);
				emit(base + '#flag', 'banner/base', sway, dyeRgb(model.color || 'white'), MODE_TRANSLUCENT);
				for (const [asset, color] of (patterns && patterns.p) || []) {
					emit(base + '#flag', 'banner/' + String(asset).replace(/^[a-z0-9_.-]+:/, ''), sway, dyeRgb(color), MODE_TRANSLUCENT);
				}
				break;
			}
			case 'decorated_pot':
				emit('minecraft:decorated_pot_base#main', 'decorated_pot/decorated_pot_base');
				emit('minecraft:decorated_pot_sides#main', 'decorated_pot/decorated_pot_side');
				break;
			case 'bell':
				emit('minecraft:bell#main', 'bell/bell_body');
				break;
			case 'copper_golem_statue': {
				// CopperGolemStatueModel.setupAnim: the root at y 0, turned upside down (the definition turns it back)
				const pose = strip(model.pose || 'standing');
				emit('minecraft:copper_golem' + (pose === 'standing' ? '' : '_' + pose) + '#main',
					texture.replace(/^textures\/entity\//, '').replace(/\.png$/, '') || 'copper_golem/copper_golem', (parts, root) => {
						root.y = 0;
						root.zRot = Math.PI;
					});
				break;
			}
			case 'trident':
				emit('minecraft:trident#main', 'trident/trident');
				break;
			default:
				break;
		}
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
	emitItem(mesh, m, style, patterns = null) {
		if (mesh.special) return this.drawSpecialItem(mesh.special, m, style, patterns);
		const start = this.sink.mark();
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
		const mesh = shield ? null : this.itemMesh(e.itemModel || e.item, e.itemP, 'ground');
		if (!mesh && !shield) return this.drawBox(e, pos, style);
		const age = e.age || 0;
		const bobOffset = (e.id * 0.618) % (Math.PI * 2);
		const bob = Math.sin(age / 10 + bobOffset) * 0.1 + 0.1;
		const m = mat4();
		if (shield) {
			translate(m, pos[0], pos[1] + bob + 0.125, pos[2]);
			rotate(m, 1, age / 20 + bobOffset);
			this.drawShield(m, 'ground', e.foil & FOIL_ITEM ? { ...style, glint: GLINT_ITEM } : style, e.itemPatterns);
			this.shadowFor(e, pos, 0.15, this.world, 0.75);
			return;
		}
		const fallback = mesh.kind === 'block'
			? { translation: [0, 3, 0], scale: [0.25, 0.25, 0.25] }
			: { translation: [0, 2, 0], scale: [0.5, 0.5, 0.5] };
		const transform = this.displayTransform(e.item, 'ground', fallback, mesh.modelId);
		const box = this.itemBox(mesh, transform);
		// ItemEntityRenderer.submit: bob, resting the model's lowest point 1/16 above the ground, and spin
		translate(m, pos[0], pos[1] + bob - box[1] + 0.0625, pos[2]);
		rotate(m, 1, age / 20 + bobOffset);
		this.submitItemCluster(m, mesh, transform, box, e.n || 1, e.seed || 0, e.foil & FOIL_ITEM ? { ...style, glint: GLINT_ITEM } : style, e.itemPatterns);
		this.shadowFor(e, pos, 0.15, this.world, 0.75);
	}

	/**
	 * ItemEntityRenderer.submitMultipleFromCount: the stack's model as it lies on the ground, with more copies for
	 * bigger stacks (ItemClusterRenderState.getRenderedAmount) scattered by a random seeded with the item
	 * (getSeedForItemStack); flat items are stacked front to back.
	 */
	submitItemCluster(m, mesh, transform, box, amount, seed, itemStyle, patterns) {
		const submit = im => {
			this.applyDisplay(im, transform, false);
			this.emitItem(mesh, im, itemStyle, patterns);
		};
		const random = this.clusterRandom || (this.clusterRandom = new JavaRandom());
		random.setSeedNumber(seed);
		const depth = box[5] - box[2];
		if (depth > 0.0625) {
			submit(Float32Array.from(m));
			for (let i = 1; i < amount; i++) {
				const im = Float32Array.from(m);
				const xo = (random.nextFloat() * 2 - 1) * 0.15;
				const yo = (random.nextFloat() * 2 - 1) * 0.15;
				const zo = (random.nextFloat() * 2 - 1) * 0.15;
				translate(im, xo, yo, zo);
				submit(im);
			}
		} else {
			const offsetZ = depth * 1.5;
			translate(m, 0, 0, -(offsetZ * (amount - 1) / 2));
			submit(Float32Array.from(m));
			translate(m, 0, 0, offsetZ);
			for (let i = 1; i < amount; i++) {
				const im = Float32Array.from(m);
				const xo = (random.nextFloat() * 2 - 1) * 0.15 * 0.5;
				const yo = (random.nextFloat() * 2 - 1) * 0.15 * 0.5;
				translate(im, xo, yo, 0);
				submit(im);
				translate(m, 0, 0, offsetZ);
			}
		}
	}

	/** A stack drawn the way a dropped one is, at m (no bobbing): its mesh, ground transform and model box. */
	stackCluster(item, model, props) {
		const mesh = this.itemMesh(model || item, props, 'ground');
		if (!mesh) return null;
		const fallback = mesh.kind === 'block'
			? { translation: [0, 3, 0], scale: [0.25, 0.25, 0.25] }
			: { translation: [0, 2, 0], scale: [0.5, 0.5, 0.5] };
		const transform = this.displayTransform(item, 'ground', fallback, mesh.modelId);
		return { mesh, transform, box: this.itemBox(mesh, transform) };
	}

	/** OminousItemSpawnerRenderer: the item growing in over its first 50 ticks and turning 40° a tick, at full light. */
	drawOminousItem(e, pos, style) {
		const stack = this.stackCluster(e.item, e.itemModel, e.itemP);
		if (!stack) return;
		const age = e.age || 0;
		const m = mat4();
		translate(m, pos[0], pos[1], pos[2]);
		if (age <= 50) scale(m, Math.min(age, 50) / 50);
		rotate(m, 1, (age * 40 % 360) * DEG);
		const lit = { ...style, light: [240, 240] };
		this.submitItemCluster(m, stack.mesh, stack.transform, stack.box, e.n || 1, e.seed || 0,
			e.foil & FOIL_ITEM ? { ...lit, glint: GLINT_ITEM } : lit, e.itemPatterns);
	}

	/** VaultRenderer: the item a vault shows, spinning 10° a tick in the middle of its cage. */
	drawVaultItem(be, pos, world) {
		const data = world.blockEntityAt(be.x, be.y, be.z);
		if (!data || data.k !== 'vault' || !data.d || !data.i) return;
		const stack = this.stackCluster(data.i, data.iModel, data.iP);
		if (!stack) return;
		const m = mat4();
		translate(m, pos[0] + 0.5, pos[1] + 0.4, pos[2] + 0.5);
		rotate(m, 1, (performance.now() / 50 * 10 % 360) * DEG);
		const [sky, block] = world.lightAt(be.x, be.y, be.z);
		const style = { color: [1, 1, 1, 1], light: [block * 16, sky * 16], overlay: [0, 0] };
		this.submitItemCluster(m, stack.mesh, stack.transform, stack.box, data.n || 1, data.seed || 0, style, null);
	}

	/** An item as ItemStackRenderState.submit draws it for ItemDisplayContext.GROUND (what mobs hold in their mouths). */
	drawGroundItem(item, m, style, props = null) {
		const mesh = this.itemMesh(item, props, 'ground');
		if (!mesh) return;
		const fallback = mesh.kind === 'block'
			? { translation: [0, 3, 0], scale: [0.25, 0.25, 0.25] }
			: { translation: [0, 2, 0], scale: [0.5, 0.5, 0.5] };
		this.applyDisplay(m, this.displayTransform(item, 'ground', fallback, mesh.modelId), false);
		this.emitItem(mesh, m, style);
	}

	/** FoxHeldItemLayer: the item in a fox's mouth, following its head. */
	drawFoxItem(model, m, e, style, anim) {
		const head = model.parts.head;
		if (!head) return;
		const sleeping = !!(e.d && e.d.sleeping);
		const im = Float32Array.from(m);
		translate(im, head.x / 16, head.y / 16, head.z / 16);
		if (e.baby) scale(im, 0.75);
		rotate(im, 2, Number(e.d && e.d.headRoll) || 0);
		rotate(im, 1, anim.netHeadYaw * DEG);
		rotate(im, 0, anim.headPitch * DEG);
		if (e.baby) translate(im, sleeping ? 0.4 : 0.06, 0.26, sleeping ? 0.15 : -0.5);
		else if (sleeping) translate(im, 0.46, 0.26, 0.22);
		else translate(im, 0.06, 0.27, -0.5);
		rotate(im, 0, 90 * DEG);
		if (sleeping) rotate(im, 2, 90 * DEG);
		this.drawGroundItem(e.handModel || e.hand, im, style, e.handP);
	}

	/**
	 * The camera's orientation (CameraRenderState.orientation) as a matrix: what sprites are turned by to face the
	 * screen, all the same way whereever they are in the picture.
	 */
	cameraOrientation() {
		const v = this.frame && this.frame.viewRotation;
		return v ? new Float32Array([v[0], v[4], v[8], 0, v[1], v[5], v[9], 0, v[2], v[6], v[10], 0, 0, 0, 0, 1]) : null;
	}

	/**
	 * ThrownItemRenderer / FireworkEntityRenderer: the entity's item as it is drawn on the ground (ItemDisplayContext.GROUND),
	 * scaled per type, turned like the camera; a firework shot at an angle lies along its flight instead.
	 */
	drawThrown(e, type, pos, style) {
		const item = e.item || 'minecraft:' + THROWN[type];
		const mesh = this.itemMesh(e.itemModel || item, e.itemP, 'ground');
		const orientation = this.cameraOrientation();
		if (!mesh || !orientation) return;
		const m = mat4();
		translate(m, pos[0], pos[1], pos[2]);
		scale(m, THROWN_SCALE[type] || 1);
		m.set(mul(m, orientation));
		if (type === 'firework_rocket' && e.d && e.d.angled) {
			rotate(m, 2, Math.PI);
			rotate(m, 1, Math.PI);
			rotate(m, 0, Math.PI / 2);
		}
		const fallback = mesh.kind === 'block'
			? { translation: [0, 3, 0], scale: [0.25, 0.25, 0.25] }
			: { translation: [0, 2, 0], scale: [0.5, 0.5, 0.5] };
		this.applyDisplay(m, this.displayTransform(item, 'ground', fallback, mesh.modelId), false);
		const itemStyle = THROWN_BRIGHT.has(type) ? { ...style, light: [240, style.light[1]] } : { ...style };
		if (e.foil & FOIL_ITEM) itemStyle.glint = GLINT_ITEM;
		this.emitItem(mesh, m, itemStyle, e.itemPatterns);
	}

	/** CushionRenderer: the cushion model in its colour, turned to the nearest side, upside down about x. */
	drawCushion(e, pos, style) {
		const model = this.library.get('minecraft:cushion#main');
		const texture = this.texture('cushion/' + (strip(e.d && e.d.color) || 'white') + '_cushion');
		if (!model || !texture) return this.drawBox(e, pos, style);
		model.reset();
		const m = mat4();
		translate(m, pos[0], pos[1], pos[2]);
		// Direction.fromYRot(yRot).toYRot()
		const facing = (Math.floor((e.yaw || 0) / 90 + 0.5) & 3) * 90;
		rotate(m, 1, (180 - facing) * DEG);
		rotate(m, 0, Math.PI);
		translate(m, 0, -0.25, 0);
		const start = this.sink.mark();
		emitModel(this.sink, model, m, style);
		this.batch(texture, MODE_CUTOUT, start);
	}

	/** DragonFireballRenderer: its texture on a quad twice a block wide facing the camera, lit like block light 15. */
	drawDragonFireball(pos, style) {
		const texture = this.texture('enderdragon/dragon_fireball');
		const orientation = this.cameraOrientation();
		if (!texture || !orientation) return;
		const m = mat4();
		translate(m, pos[0], pos[1], pos[2]);
		scale(m, 2);
		m.set(mul(m, orientation));
		const q = new Float32Array([-0.5, -0.25, 0, 0, 1, 0.5, -0.25, 0, 1, 1, 0.5, 0.75, 0, 1, 0, -0.5, 0.75, 0, 0, 0]);
		const start = this.sink.mark();
		this.sink.ensure(6);
		emitQuads(this.sink, q, m, { ...style, light: [240, style.light[1]], normal: [0, 1, 0] });
		this.batch(texture, MODE_CUTOUT, start, false);
	}

	/**
	 * ExperienceOrbRenderer: its icon on a translucent quad turned like the camera, its colour going from green to
	 * yellow with its age, lit 7 brighter than its block.
	 */
	drawOrb(e, pos, style) {
		const texture = this.texture('experience/experience_orb');
		const orientation = this.cameraOrientation();
		if (!texture || !orientation) return;
		const icon = Number(e.d && e.d.icon) || 0;
		const u0 = (icon % 4 * 16) / 64, v0 = (Math.floor(icon / 4) * 16) / 64, u1 = u0 + 16 / 64, v1 = v0 + 16 / 64;
		const t = (e.age || 0) / 2;
		const r = Math.trunc((Math.sin(t) + 1) * 0.5 * 255) / 255, b = Math.trunc((Math.sin(t + Math.PI * 4 / 3) + 1) * 0.1 * 255) / 255;
		const m = mat4();
		translate(m, pos[0], pos[1] + 0.1, pos[2]);
		m.set(mul(m, orientation));
		scale(m, 0.3);
		const q = new Float32Array([-0.5, -0.25, 0, u0, v1, 0.5, -0.25, 0, u1, v1, 0.5, 0.75, 0, u1, v0, -0.5, 0.75, 0, u0, v0]);
		const start = this.sink.mark();
		this.sink.ensure(6);
		const light = [Math.min(240, (style.light[0] || 0) + 112), style.light[1]];
		emitQuads(this.sink, q, m, { ...style, light, color: [r, 1, b, 128 / 255], normal: [0, 1, 0] });
		this.batch(texture, MODE_TRANSLUCENT, start, false);
		this.shadowFor(e, pos, 0.15, this.world, 0.75);
	}

	/** An item model's display transform ("ground", "thirdperson_righthand"...) from its parent chain. */
	displayTransform(itemId, slot, fallback, modelId = null) {
		const models = this.assets && this.assets.bundle.models;
		if (!models) return fallback;
		const id = itemId.includes(':') ? itemId : 'minecraft:' + itemId;
		const colon = id.indexOf(':');
		let current = modelId || id.slice(0, colon) + ':item/' + id.slice(colon + 1);
		if (!models[current]) current = id.slice(0, colon) + ':block/' + id.slice(colon + 1);
		// a special model takes its display transforms from its "base" model (unless a model is asked for)
		const special = modelId ? null : this.specialItem(id);
		if (special && special.base) current = special.base.includes(':') ? special.base : 'minecraft:' + special.base;
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

	drawHeld(model, m, arm, item, style, side, patterns, props = null, blocking = false) {
		const shield = isShield(item);
		const mesh = shield ? null : this.itemMesh(item, props, side > 0 ? 'thirdperson_righthand' : 'thirdperson_lefthand');
		if (!mesh && !shield) return;
		const pm = partMatrix(model, arm, m);
		if (!pm) return;
		// ItemInHandLayer: from the arm (block units), rotate -90 X and 180 Y, move into the fist.
		scale(pm, 16);
		rotate(pm, 0, -90 * DEG);
		rotate(pm, 1, 180 * DEG);
		translate(pm, side / 16, 0.125, -0.625);
		const slot = side > 0 ? 'thirdperson_righthand' : 'thirdperson_lefthand';
		if (shield) return this.drawShield(pm, slot, style, patterns, blocking);
		const fallback = mesh.kind === 'block'
			? { rotation: [75, 45, 0], translation: [0, 2.5, 0], scale: [0.375, 0.375, 0.375] }
			: { rotation: [0, 0, 0], translation: [0, 3, 1], scale: [0.55, 0.55, 0.55] };
		// ItemTransform.apply(leftHand): the left hand mirrors the translation and the Y and Z turns
		this.applyDisplay(pm, this.displayTransform(item, slot, fallback, mesh.modelId), side < 0);
		this.emitItem(mesh, pm, style, patterns);
	}

	/**
	 * ShieldSpecialRenderer: the shield model after the item's display transform (models/item/shield.json),
	 * the handle and plate with the base texture, then like BannerRenderer.submitPatterns the base colour and
	 * every pattern layer (entity/shield/<pattern>) over the plate in their dye colours.
	 */
	drawShield(m, slot, style, patterns, blocking = false) {
		const model = this.library.get('minecraft:shield#main');
		if (!model || !model.parts.plate) return;
		// items/shield.json: the shield_blocking model's transforms while it is raised
		const modelId = blocking ? 'minecraft:item/shield_blocking' : null;
		this.applyDisplay(m, this.displayTransform('minecraft:shield', slot, SHIELD_DISPLAY[slot] || {}, modelId), slot.endsWith('lefthand'));
		scale(m, 1, -1, -1);
		const hasPatterns = !!patterns && (!!patterns.b || !!(patterns.p && patterns.p.length));
		// the plate (Sheets.SHIELD_BASE / SHIELD_BASE_NO_PATTERN)
		const base = this.texture(hasPatterns ? 'shield/shield_base' : 'shield/shield_base_nopattern');
		if (!base) return;
		model.reset();
		let start = this.sink.mark();
		emitModel(this.sink, model, m, style);
		this.batch(base, MODE_CUTOUT, start, true, style.glint || 0);
		if (!hasPatterns) return;
		const handle = model.parts.handle;
		if (handle) handle.visible = false;
		const layer = (texture, color) => {
			if (!texture) return;
			start = this.sink.mark();
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
			this.emitBlock(glow ? 'minecraft:glow_item_frame' : 'minecraft:item_frame', frame, style, hasMap ? 'map' : true);
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
			const mesh = this.itemMesh(e.itemModel || e.item, e.itemP, 'fixed');
			if (mesh) {
				rotate(m, 2, rotation * 45 * DEG);
				scale(m, 0.5);
				const fallback = mesh.kind === 'block' ? { scale: [0.5, 0.5, 0.5] } : { rotation: [0, 180, 0] };
				this.applyDisplay(m, this.displayTransform(e.item, 'fixed', fallback, mesh.modelId), false);
				// getLightCoords: a glow frame lights its item at 15728880 (full)
				const itemStyle = glow ? { ...style, light: [240, 240] } : { ...style };
				if (e.foil & FOIL_ITEM) itemStyle.glint = GLINT_ITEM;
				this.emitItem(mesh, m, itemStyle, e.itemPatterns);
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
		for (const [sprite, x, y, rot, name] of e.mapd || []) {
			if (name) this.mapLabels.push({ m: new Float32Array(m), x, y, name, light: style.light });
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

	/**
	 * MapRenderer: the names of named decorations (banners on the map) under their icons, white on a half
	 * transparent black background, shrunk to fit 25 map pixels.
	 */
	addMapLabels() {
		if (!this.mapLabels.length || !this.text.font) return;
		for (const label of this.mapLabels) {
			const width = this.text.font.width(label.name);
			if (!width) continue;
			const textScale = Math.min(Math.max(25 / width, 0), 6 / 9);
			const m = label.m;
			translate(m, label.x / 2 + 64 - width * textScale / 2, label.y / 2 + 64 + 4, -0.025);
			scale(m, textScale, textScale, -1);
			translate(m, 0, 0, 0.1);
			this.text.add(matrixTransform(m), label.name, 0, 0, [1, 1, 1, 1], label.light, 'normal', [0, 0, 0, 128 / 255]);
		}
	}

	/** A flat textured quad lit without the shading of entity faces (text render type). */
	emitFlat(quad, m, style, texture) {
		const start = this.sink.mark();
		this.sink.ensure(6);
		emitQuads(this.sink, quad, m, { ...style, color: [1, 1, 1, 1] });
		// upward normals: full brightness in the entity shader, like the text pipeline
		const out = this.sink.data;
		for (let i = start.v; i < this.sink.count; i++) {
			out[i * FLOATS + 3] = 0; out[i * FLOATS + 4] = 1; out[i * FLOATS + 5] = 0;
		}
		this.batch(texture, MODE_NOCULL, start, false);
	}

	/**
	 * Emits a block model with the atlas texture: the block's state given as properties (the game's defaultBlockState(),
	 * which its blockstates file does not name), else its first variant.
	 */
	emitBlock(name, m, style, frameModel = false, state = null) {
		if (!this.assets || !name) return;
		const key = 'block:' + name + (frameModel ? ':frame' + (frameModel === 'map' ? ':map' : '') : '') + (state ? JSON.stringify(state) : '');
		let mesh = this.itemMeshes.get(key);
		if (mesh === undefined) {
			mesh = null;
			const models = this.assets.models;
			const dispatch = models && models.dispatch(name, frameModel ? { map: frameModel === 'map' ? 'true' : 'false' } : { ...state, __item: true });
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

	/**
	 * BlockModelResolver: a block whose look is a special model (chests, shulker boxes, heads, banners, copper golem
	 * statues) is drawn with that model from the block's corner at m, at rest.
	 */
	drawSpecialBlock(id, m, style, world) {
		const info = id !== undefined && world ? world.infos[id] : null;
		const def = info ? blockEntityModel(info) : null;
		if (def && SPECIAL_BLOCKS.has(def.kind)) this.drawBlockEntityModel(def, m, style);
	}

	/**
	 * TntRenderer: the block swelling about its middle in the last ten ticks of its fuse, flashing white every five
	 * ticks (fuseRemainingInTicks = getFuse() - partialTick + 1: the fuse interpolated here, at the partial tick 1 when
	 * the world is frozen).
	 */
	drawPrimedTnt(e, pos, style) {
		const m = mat4();
		translate(m, pos[0], pos[1] + 0.5, pos[2]);
		const fuse = typeof (e.d && e.d.fuse) === 'number' ? e.d.fuse + (this.frozen ? 0 : 1) : 80;
		if (fuse < 10) scale(m, 1 + tntSwell(fuse));
		translate(m, -0.5, -0.5, -0.5);
		this.emitBlock('minecraft:tnt', m, { ...style, overlay: [0, tntLit(fuse) ? 1 : 0] });
		this.shadowFor(e, pos, 0.5, this.world);
	}

	/**
	 * DisplayRenderer: a block, item or text display at its position, turned by its billboard (the camera's view
	 * for vertical, horizontal and center), then by its transformation (translation, left rotation, scale, right
	 * rotation) interpolated like Display's TransformationInterpolator, lit by its brightness override or its block.
	 */
	drawDisplay(e, type, pos, style, world) {
		const d = e.disp;
		if (!d) return;
		// Display.shouldRenderAtSqrDistance: view range times 64 blocks
		if (Math.hypot(pos[0], pos[1], pos[2]) >= (d.vr ?? 1) * 64) return;
		const s = this.displayState(e, d);
		// Display.tick (client) makes the render state: a display that has not ticked yet, like one that appeared
		// while the world is frozen (/tick freeze), is not drawn
		if (!this.frozen) s.ticked = true;
		if (!s.ticked) return;
		const tick = this.tick;
		const t = s.from && s.duration > 0
			? slerpTransformation(s.from, s.to, Math.min(1, Math.max(0, (tick - s.start) / s.duration)))
			: s.to;
		// LinearInterpolationHandler: a teleported display glides there over teleport_duration ticks
		let p = pos;
		if (s.glide) {
			const k = Math.min(1, Math.max(0, (tick - s.glide.start) / s.glide.duration));
			p = [pos[0] + (s.glide.from[0] - e.x) * (1 - k), pos[1] + (s.glide.from[1] - e.y) * (1 - k), pos[2] + (s.glide.from[2] - e.z) * (1 - k)];
		}
		const light = d.br !== undefined ? [((d.br >> 4) & 15) * 16, ((d.br >> 20) & 15) * 16] : style.light;
		const displayStyle = { ...style, light, overlay: [0, 0] };
		const m = mat4();
		translate(m, p[0], p[1], p[2]);
		// calculateOrientation: rotationYXZ of the entity's or the camera's yaw and pitch per billboard
		const camYaw = (this.frame.camYaw ?? 0) - 180, camPitch = -(this.frame.camPitch ?? 0);
		const billboard = d.bb || 0;
		rotate(m, 1, -(billboard === 1 || billboard === 3 ? camYaw : e.yaw || 0) * DEG);
		rotate(m, 0, (billboard === 2 || billboard === 3 ? camPitch : e.pitch || 0) * DEG);
		multiplyTransformation(m, t);
		if (d.sr) this.shadowFor(e, pos, d.sr, world, d.ss ?? 1);
		if (type === 'block_display') {
			const mesh = d.b !== undefined ? this.blockStateMesh(d.b, world) : null;
			if (mesh) this.emitItem(mesh, m, displayStyle);
			this.drawSpecialBlock(d.b, m, displayStyle, world);
		} else if (type === 'item_display') {
			if (!e.item) return;
			rotate(m, 1, Math.PI);
			const context = d.ctx || 'none';
			if (isShield(e.item)) {
				this.drawShield(m, context, displayStyle, e.itemPatterns);
				return;
			}
			const mesh = this.itemMesh(e.itemModel || e.item, e.itemP, context);
			if (!mesh) return;
			const transform = context === 'none' ? {} : this.displayTransform(e.item, context, {}, mesh.modelId);
			this.applyDisplay(m, transform, context.endsWith('lefthand'));
			const itemStyle = { ...displayStyle };
			if (e.foil & FOIL_ITEM) itemStyle.glint = GLINT_ITEM;
			this.emitItem(mesh, m, itemStyle, e.itemPatterns);
		} else if (d.tx) {
			this.displayTexts.push(() => this.addDisplayText(d.tx, s, m, light));
		}
	}

	/** Display.tick (client): new transformation data starts an interpolation from where the old one had got to. */
	displayState(e, d) {
		const tick = this.tick;
		let s = this.displays.get(e.id);
		const key = (d.t || []).join(',');
		const tx = d.tx || {};
		const textKey = (tx.o ?? -1) + ',' + (tx.bg ?? 0x40000000);
		if (!s) {
			s = { key, to: transformationOf(d.t), from: null, start: 0, duration: 0, textKey, opacity: [tx.o ?? -1, tx.o ?? -1], background: [tx.bg ?? 0x40000000, tx.bg ?? 0x40000000], at: [e.x, e.y, e.z] };
			this.displays.set(e.id, s);
		}
		const progress = s.from && s.duration > 0 ? Math.min(1, Math.max(0, (tick - s.start) / s.duration)) : 1;
		if (s.key !== key) {
			// createInterpolatedRenderState: from the transformation shown now to the new one
			const current = s.from && s.duration > 0 ? slerpTransformation(s.from, s.to, progress) : s.to;
			s.key = key;
			s.to = transformationOf(d.t);
			s.duration = d.id || 0;
			s.from = s.duration > 0 ? current : null;
			s.start = tick + (d.is || 0);
		}
		if (s.textKey !== textKey) {
			// createInterpolatedTextRenderState: opacity (lerpInt) and background (srgbLerp) from where they were
			s.opacity = [Math.round(lerp(s.opacity[0], s.opacity[1], progress)), tx.o ?? -1];
			s.background = [argbLerp(s.background[0], s.background[1], progress), tx.bg ?? 0x40000000];
			s.textKey = textKey;
			if (!(d.id > 0)) {
				s.opacity[0] = s.opacity[1];
				s.background[0] = s.background[1];
			}
		}
		s.progress = s.from && s.duration > 0 ? Math.min(1, Math.max(0, (tick - s.start) / s.duration)) : 1;
		if (d.pd > 0 && (s.at[0] !== e.x || s.at[1] !== e.y || s.at[2] !== e.z)) {
			const moved = Math.hypot(e.x - s.at[0], e.y - s.at[1], e.z - s.at[2]);
			// a new position from the server (not the viewer's own tick to tick interpolation of a moving display)
			if (moved > 0.01) s.glide = { from: s.glide ? this.glidePosition(s, tick) : [...s.at], start: tick, duration: d.pd };
			s.at = [e.x, e.y, e.z];
		}
		s.seen = tick;
		return s;
	}

	glidePosition(s, tick) {
		const g = s.glide;
		const k = Math.min(1, Math.max(0, (tick - g.start) / g.duration));
		return [g.from[0] + (s.at[0] - g.from[0]) * k, g.from[1] + (s.at[1] - g.from[1]) * k, g.from[2] + (s.at[2] - g.from[2]) * k];
	}

	/**
	 * TextDisplayRenderer.submitInner: the text split into lines of at most the line width (Font.split), drawn at
	 * 0.025 blocks a pixel above the display's origin, centred, each line aligned; the background from (-1, -1) to
	 * the widest line and the last line; see-through or in front of whatever it is on.
	 */
	addDisplayText(tx, s, matrix, light) {
		const font = this.text.font;
		if (!font.ready) return;
		const flags = tx.f || 0;
		const mode = flags & 2 ? 'see_through' : 'polygon_offset';
		const lines = splitStyledLines(tx.s || [], tx.w ?? 200, (ch, bold) => font.glyph(ch.codePointAt(0)).advance + (bold ? 1 : 0));
		const width = Math.max(0, ...lines.map(line => line.width));
		const lineHeight = 10;
		const height = lines.length * lineHeight - 1;
		const m = new Float32Array(matrix);
		rotate(m, 1, Math.PI);
		scale(m, -0.025, -0.025, -0.025);
		translate(m, 1 - width / 2, -height, 0);
		const transform = matrixTransform(m);
		// the text pipelines cull back faces: from behind (the text read mirrored) neither text nor background shows
		const o = transform(0, 0), ax = transform(1, 0), ay = transform(0, 1);
		const px = [ax[0] - o[0], ax[1] - o[1], ax[2] - o[2]], py = [ay[0] - o[0], ay[1] - o[1], ay[2] - o[2]];
		const facing = (px[1] * py[2] - px[2] * py[1]) * o[0] + (px[2] * py[0] - px[0] * py[2]) * o[1] + (px[0] * py[1] - px[1] * py[0]) * o[2];
		if (facing <= 0) return;
		const progress = s.progress ?? 1;
		// Font: text whose alpha has none of its top six bits set is drawn opaque
		let alpha = Math.round(lerp(s.opacity[0], s.opacity[1], progress)) & 255;
		if ((alpha & 0xfc) === 0) alpha = 255;
		const background = flags & 4 ? 0x40000000 : argbLerp(s.background[0], s.background[1], progress);
		if (background >>> 24) this.text.rect(transform, -1, -1, width, height, argbColor(background), light, mode);
		const align = flags & 8 ? 'left' : flags & 16 ? 'right' : 'center';
		let y = 0;
		for (const line of lines) {
			let x = align === 'left' ? 0 : align === 'right' ? width - line.width : width / 2 - line.width / 2;
			for (const [text, rgbColor, style] of line.runs) {
				const bold = !!(style & 1);
				const color = rgbColor < 0 ? 0xffffff : rgbColor;
				const runWidth = this.text.styledWidth(text, bold);
				const styled = { bold, italic: !!(style & 2) };
				if (flags & 1) {
					// Font.drawInBatch: the shadow, a quarter as bright, one pixel down and right
					const dark = argbColor((alpha << 24) | (((color >> 16 & 255) >> 2) << 16) | (((color >> 8 & 255) >> 2) << 8) | ((color & 255) >> 2));
					this.text.add(transform, text, x + 1, y + 1, dark, light, mode, null, styled);
				}
				const rgba = argbColor((alpha << 24) | color);
				this.text.add(transform, text, x, y, rgba, light, mode, null, styled);
				// Style effects: underline under the line, strikethrough through its middle
				if (style & 4) this.text.rect(transform, x - 1, y + 9, x + runWidth, y + 8, rgba, light, mode);
				if (style & 8) this.text.rect(transform, x - 1, y + 4.5, x + runWidth, y + 3.5, rgba, light, mode);
				x += runWidth;
			}
			y += lineHeight;
		}
	}

	/** FallingBlockRenderer: the block's model from its corner at the entity's position less half a block, and a shadow. */
	drawFallingBlock(e, pos, style, world) {
		const m = mat4();
		translate(m, pos[0] - 0.5, pos[1], pos[2] - 0.5);
		const mesh = this.blockStateMesh(e.d && e.d.block, world);
		if (!mesh) return this.drawBox(e, pos, style);
		this.emitItem(mesh, m, style);
		this.shadowFor(e, pos, 0.5, world);
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
			const start = this.sink.mark();
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
		} else if (name === 'end_gateway') {
			// TheEndGatewayBlockEntity.triggerEvent: an entity went through, the beam flares for 40 ticks
			this.blockAnims.set(key, { kind: 'gateway', start: performance.now(), tick });
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

	/**
	 * ConduitRenderer: a still shell while the conduit is not active; an active one has a cage turning about a
	 * tilted axis and bobbing, two cubes of wind around it (switching axis every 66 ticks) and an eye that
	 * faces the camera, open while it hunts. Like the client (ConduitBlockEntity.clientTick) the viewer checks
	 * every 40 ticks whether it sits in water inside a frame of at least 16 prismarine blocks (42 to hunt).
	 */
	drawConduit(be, pos, frame, world) {
		const key = be.x + ',' + be.y + ',' + be.z;
		const conduits = this.conduits || (this.conduits = new Map());
		let c = conduits.get(key);
		const tick = Math.floor(frame.now / 50);
		if (!c) {
			c = { tick, tickCount: 0, rotation: 0, active: false, hunting: false, frame: [] };
			conduits.set(key, c);
			if (conduits.size > 64) conduits.delete(conduits.keys().next().value);
		}
		for (let n = Math.min(40, tick - c.tick); n > 0; n--) {
			c.tickCount++;
			if ((tick - n + 1) % 40 === 0 || c.tickCount === 1) this.conduitShape(c, be, world);
			if (c.active) c.rotation++;
		}
		c.tick = tick;
		const partial = frame.now / 50 - tick;
		const [sky, block] = world.lightAt(be.x, be.y, be.z);
		const style = { color: [1, 1, 1, 1], light: [block * 16, sky * 16], overlay: [0, 0] };
		const part = (layer, texture, m, mode, cull = true) => {
			const model = this.library.get('minecraft:conduit#' + layer);
			if (!model || !texture) return;
			model.reset();
			const start = this.sink.mark();
			emitModel(this.sink, model, m, style);
			this.batch(texture, mode, start, cull);
		};
		if (!c.active) {
			const m = mat4();
			translate(m, pos[0] + 0.5, pos[1] + 0.5, pos[2] + 0.5);
			rotate(m, 1, c.rotation * -0.0375 * DEG);
			part('shell', this.texture('conduit/base'), m, MODE_CUTOUT);
			return;
		}
		const rotation = (c.rotation + partial) * -0.0375;
		const animTime = c.tickCount + partial;
		let hh = Math.sin(animTime * 0.1) / 2 + 0.5;
		hh = hh * hh + hh;
		// the cage turns about the axis (0.5, 1, 0.5)
		const cage = mat4();
		translate(cage, pos[0] + 0.5, pos[1] + 0.3 + hh * 0.2, pos[2] + 0.5);
		cage.set(mul(cage, axisRotation(0.5, 1, 0.5, rotation)));
		part('cage', this.texture('conduit/cage'), cage, MODE_CUTOUT);
		const phase = Math.floor(c.tickCount / 66) % 3;
		// animated wind (textures/entity/conduit/wind*.png.mcmeta: frames 32 pixels high, 3 ticks each)
		const wind = this.animatedTexture(phase === 1 ? 'conduit/wind_vertical' : 'conduit/wind', 32, 3, c.tickCount);
		const w1 = mat4();
		translate(w1, pos[0] + 0.5, pos[1] + 0.5, pos[2] + 0.5);
		if (phase === 1) rotate(w1, 0, PI / 2);
		else if (phase === 2) rotate(w1, 2, PI / 2);
		part('wind', wind, w1, MODE_CUTOUT);
		const w2 = mat4();
		translate(w2, pos[0] + 0.5, pos[1] + 0.5, pos[2] + 0.5);
		scale(w2, 0.875);
		rotate(w2, 0, PI);
		rotate(w2, 2, PI);
		part('wind', wind, w2, MODE_CUTOUT);
		// the eye: camera.orientation, then turned half round about z and y (x stays, y and z flip)
		const v = frame.viewRotation;
		const eye = mat4();
		translate(eye, pos[0] + 0.5, pos[1] + 0.3 + hh * 0.2, pos[2] + 0.5);
		scale(eye, 0.5);
		const b = new Float32Array([v[0], v[4], v[8], 0, -v[1], -v[5], -v[9], 0, -v[2], -v[6], -v[10], 0, 0, 0, 0, 1]);
		eye.set(mul(eye, b));
		scale(eye, 4 / 3);
		part('eye', this.texture(c.hunting ? 'conduit/open_eye' : 'conduit/closed_eye'), eye, MODE_CUTOUT, false);
	}

	/**
	 * TheEndGatewayRenderer: after an entity goes through, a purple beacon beam flares up and down from the
	 * gateway (height and texture scale sin(pi * the cooldown left), up to 50 blocks each way).
	 */
	drawGatewayBeam(be, p, frame) {
		const key = be.x + ',' + be.y + ',' + be.z;
		const anim = this.blockAnims.get(key);
		if (!anim || anim.kind !== 'gateway') return;
		const ticks = (frame.now - anim.start) / 50;
		if (ticks >= 40) {
			this.blockAnims.delete(key);
			return;
		}
		const percent = Math.max(0, Math.min(1, (40 - ticks) / 40));
		const beamScale = Math.sin(percent * PI);
		const height = Math.floor(beamScale * 50);
		const texture = this.texture('end_portal/end_gateway_beam');
		if (height <= 0 || !texture) return;
		const time = this.env ? this.env.gameTime(frame.now) : frame.now / 50;
		const animationTime = ((Math.floor(time) % 40) + 40) % 40 + (time - Math.floor(time));
		// DyeColor.PURPLE.getTextureDiffuseColor()
		this.beaconBeam(texture, p, animationTime, -height, height * 2, 0x8932b8, 0.15, 0.175, beamScale);
	}

	/**
	 * BrushableBlockRenderer: the item in suspicious sand or gravel pokes out of the side being brushed,
	 * further with every dusting step.
	 */
	drawBrushable(be, p, world) {
		const data = world.blockEntityAt(be.x, be.y, be.z);
		const dusted = Number(be.info.props && be.info.props.dusted) || 0;
		if (!data || data.k !== 'brush' || !data.i || !data.d || dusted <= 0) return;
		const mesh = this.itemMesh(data.i, null, 'fixed');
		if (!mesh) return;
		const step = { east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1] }[data.d] || [0, 0, 0];
		const [sky, block] = world.lightAt(be.x + step[0], be.y + step[1], be.z + step[2]);
		const style = { color: [1, 1, 1, 1], light: [block * 16, sky * 16], overlay: [0, 0] };
		const offset = dusted / 10 * 0.75;
		const t = [0.5, 0, 0.5];
		switch (data.d) {
			case 'east': t[0] = 0.73 + offset; break;
			case 'west': t[0] = 0.25 - offset; break;
			case 'up': t[1] = 0.25 + offset; break;
			case 'down': t[1] = -0.23 - offset; break;
			case 'north': t[2] = 0.25 - offset; break;
			case 'south': t[2] = 0.73 + offset; break;
			default: break;
		}
		const m = mat4();
		translate(m, p[0], p[1] + 0.5, p[2]);
		translate(m, t[0], t[1], t[2]);
		rotate(m, 1, 75 * DEG);
		rotate(m, 1, ((data.d === 'east' || data.d === 'west' ? 90 : 0) + 11) * DEG);
		scale(m, 0.5);
		const fallback = mesh.kind === 'block' ? { scale: [0.5, 0.5, 0.5] } : { rotation: [0, 180, 0] };
		this.applyDisplay(m, this.displayTransform(data.i, 'fixed', fallback, mesh.modelId), false);
		this.emitItem(mesh, m, style);
	}

	/** ConduitBlockEntity.updateShape and updateHunting from the blocks the viewer knows. */
	conduitShape(c, be, world) {
		const water = (x, y, z) => {
			const info = world.infoAt(x, y, z);
			return !!(info && info.water);
		};
		for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
			if (!water(be.x + x, be.y + y, be.z + z)) {
				c.active = false;
				c.hunting = false;
				return;
			}
		}
		let count = 0;
		for (let x = -2; x <= 2; x++) for (let y = -2; y <= 2; y++) for (let z = -2; z <= 2; z++) {
			const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
			if ((ax > 1 || ay > 1 || az > 1) && ((x === 0 && (ay === 2 || az === 2)) || (y === 0 && (ax === 2 || az === 2)) || (z === 0 && (ax === 2 || ay === 2)))) {
				const entry = world.entryAt(be.x + x, be.y + y, be.z + z);
				if (entry && entry.tg && entry.tg.includes('minecraft:conduit_effect_block')) count++;
			}
		}
		c.active = count >= 16;
		c.hunting = count >= 42;
	}

	/**
	 * A texture below textures/entity animated like its .mcmeta says: frames frameHeight pixels high stacked
	 * downwards, each shown for frametime ticks; the frame for the given tick (null while loading).
	 */
	animatedTexture(path, frameHeight, frametime, ticks) {
		const key = 'animated/' + path;
		let entry = this.textures.get(key);
		if (!entry) {
			entry = { frames: null };
			this.textures.set(key, entry);
			const options = { premultiplyAlpha: 'none', colorSpaceConversion: 'none' };
			fetch('/assets/entity/' + path + '.png' + tokenSuffix('?'), { credentials: 'same-origin' })
				.then(r => { if (!r.ok) throw new Error('missing'); return r.blob(); })
				.then(blob => createImageBitmap(blob, options))
				.then(async image => {
					const count = Math.max(1, Math.floor(image.height / frameHeight));
					const frames = [];
					for (let i = 0; i < count; i++) frames.push(this.createTexture(await createImageBitmap(image, 0, i * frameHeight, image.width, frameHeight, options)));
					entry.frames = frames;
				})
				.catch(() => { entry.failed = true; });
		}
		return entry.frames ? entry.frames[Math.floor(ticks / frametime) % entry.frames.length] : null;
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
				if (be.info.shortName.endsWith('_shelf')) {
					if (Math.hypot(bx, by, bz) <= Math.min(frame.fogEnd, 64) && frame.frustum(bx + 0.5, by + 0.5, bz + 0.5, 1.5)) this.drawShelfItems(be, [bx, by, bz], world);
					continue;
				}
				if (be.info.shortName === 'end_portal' || be.info.shortName === 'end_gateway') {
					if (be.info.shortName === 'end_gateway' && this.blockAnims.size) this.drawGatewayBeam(be, [bx, by, bz], frame);
					this.addPortal(be, [bx, by, bz], frame, world);
					continue;
				}
				if (be.info.shortName === 'spawner' || be.info.shortName === 'trial_spawner') {
					if (Math.hypot(bx, by, bz) <= Math.min(frame.fogEnd, 64) && frame.frustum(bx + 0.5, by + 0.5, bz + 0.5, 1.5)) this.drawSpawner(be, [bx, by, bz], world);
					continue;
				}
				if (be.info.shortName === 'suspicious_sand' || be.info.shortName === 'suspicious_gravel') {
					if (Math.hypot(bx, by, bz) <= Math.min(frame.fogEnd, 64) && frame.frustum(bx + 0.5, by + 0.5, bz + 0.5, 1.5)) this.drawBrushable(be, [bx, by, bz], world);
					continue;
				}
				if (be.info.shortName === 'vault') {
					if (Math.hypot(bx, by, bz) <= Math.min(frame.fogEnd, 64) && frame.frustum(bx + 0.5, by + 0.5, bz + 0.5, 1.5)) this.drawVaultItem(be, [bx, by, bz], world);
					continue;
				}
				if (be.info.shortName === 'conduit') {
					if (Math.hypot(bx, by, bz) <= Math.min(frame.fogEnd, 64) && frame.frustum(bx + 0.5, by + 0.5, bz + 0.5, 1.5)) this.drawConduit(be, [bx, by, bz], frame, world);
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
			const mesh = this.itemMesh(item, null, 'fixed');
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
	 * ShelfRenderer: the items standing side by side on a shelf at a quarter of their size, facing out of it, each
	 * set on the shelf's middle (or its bottom when the shelf aligns them there) by its model's bounding box.
	 */
	drawShelfItems(be, p, world) {
		const data = world.blockEntityAt(be.x, be.y, be.z);
		if (!data || data.k !== 'shelf' || !data.s) return;
		const [sky, block] = world.lightAt(be.x, be.y, be.z);
		const style = { color: [1, 1, 1, 1], light: [block * 16, sky * 16], overlay: [0, 0] };
		// -Direction.toYRot()
		const yRot = -({ south: 0, west: 90, north: 180, east: 270 }[be.info.props.facing] ?? 180);
		data.s.forEach((slot, i) => {
			if (!slot || !slot.i) return;
			const mesh = this.itemMesh(slot.iModel || slot.i, slot.iP, 'on_shelf');
			if (!mesh) return;
			const transform = this.displayTransform(slot.i, 'on_shelf', {}, mesh.modelId);
			const [minY, maxY] = this.itemHeight(mesh, transform);
			const m = mat4();
			translate(m, p[0] + 0.5, p[1] + 0.5, p[2] + 0.5);
			rotate(m, 1, yRot * DEG);
			translate(m, (i - 1) * 0.3125, data.b ? -0.25 : 0, -0.25);
			scale(m, 0.25);
			translate(m, 0, data.b ? -minY : -minY - (maxY - minY) / 2, 0);
			this.applyDisplay(m, transform, false);
			this.emitItem(mesh, m, slot.g ? { ...style, glint: GLINT_ITEM } : style);
		});
	}

	/**
	 * ItemStackRenderState.getModelBoundingBox: [minX, minY, minZ, maxX, maxY, maxZ] of the item's model after its
	 * display transform (a special model counts as its whole block).
	 */
	itemBox(mesh, transform) {
		let cache = this.itemHeights.get(mesh);
		if (!cache) this.itemHeights.set(mesh, cache = new Map());
		const key = JSON.stringify(transform);
		let box = cache.get(key);
		if (box) return box;
		const m = mat4();
		this.applyDisplay(m, transform, false);
		box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
		const point = (x, y, z) => {
			for (let a = 0; a < 3; a++) {
				const t = m[a] * x + m[4 + a] * y + m[8 + a] * z + m[12 + a];
				if (t < box[a]) box[a] = t;
				if (t > box[3 + a]) box[3 + a] = t;
			}
		};
		if (mesh.quads) {
			const data = mesh.quads.data;
			for (let i = 0; i < data.length; i += 5) point(data[i], data[i + 1], data[i + 2]);
		} else {
			for (let c = 0; c < 8; c++) point(c & 1, c >> 1 & 1, c >> 2 & 1);
		}
		if (!(box[0] <= box[3])) box = [0, 0, 0, 0, 0, 0];
		cache.set(key, box);
		return box;
	}

	/** The lowest and highest point of the item's model after its display transform. */
	itemHeight(mesh, transform) {
		const box = this.itemBox(mesh, transform);
		return [box[1], box[4]];
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
		const start = this.sink.mark();
		emitModel(this.sink, model, m, { color: [1, 1, 1, 1], light: [block * 16, sky * 16], overlay: [0, 0] });
		this.batch(texture, MODE_CUTOUT, start);
	}

	/** BeaconRenderer.submitBeaconBeam */
	beaconBeam(texture, p, animationTime, beamStart, height, color, solidRadius, glowRadius, textureScale = 1) {
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
			const start = this.sink.mark();
			this.sink.ensure(quads.length / 20 * 6);
			emitQuads(this.sink, quads, m, { color: [rgb[0], rgb[1], rgb[2], alpha], light: [240, 240], overlay: [0, 0] });
			const out = this.sink.data;
			for (let i = start.v; i < this.sink.count; i++) { out[i * FLOATS + 3] = 0; out[i * FLOATS + 4] = 1; out[i * FLOATS + 5] = 0; }
			this.batch(texture, mode, start, false);
		};
		// the solid beam turns (2.25 degrees a tick)
		const m = mat4();
		translate(m, p[0] + 0.5, p[1], p[2] + 0.5);
		rotate(m, 1, (animationTime * 2.25 - 45) * DEG);
		let v2 = -1 + vOffset;
		emit(part([0, solidRadius, solidRadius, 0, -solidRadius, 0, 0, -solidRadius], 0, 1, height * textureScale * (0.5 / solidRadius) + v2, v2), m, 1, MODE_CUTOUT);
		// the glow does not
		const g = mat4();
		translate(g, p[0] + 0.5, p[1], p[2] + 0.5);
		v2 = -1 + vOffset;
		emit(part([-glowRadius, -glowRadius, glowRadius, -glowRadius, -glowRadius, glowRadius, glowRadius, glowRadius], 0, 1, height * textureScale + v2, v2), g, 32 / 255, MODE_TRANSLUCENT);
	}

	/**
	 * @param data what the server sent for this block entity (banner patterns, pot sherds, head owner) or null
	 * @param pos  its block position
	 */
	/**
	 * A block entity's model (chests, shulker boxes, heads, banners, bells, statues, pots) at a block position p, or
	 * from a matrix p (16 numbers) where the game draws a block's special model instead of its block model
	 * (block displays, minecarts' blocks).
	 */
	drawBlockEntityModel(def, p, style, data = null, pos = null) {
		const m = mat4();
		if (p.length === 16) m.set(p);
		else translate(m, p[0], p[1], p[2]);
		const emit = (layer, texturePath, matrix, color, mode = MODE_CUTOUT, pose = null) => {
			const model = this.library.get(layer);
			const texture = typeof texturePath === 'object' && texturePath ? texturePath.texture : this.texture(texturePath);
			if (!model || !texture) return null;
			model.reset();
			if (pose) pose(model.parts);
			const start = this.sink.mark();
			emitModel(this.sink, model, matrix, color ? { ...style, color } : style);
			this.batch(texture, mode, start, mode !== MODE_TRANSLUCENT && mode !== MODE_NOCULL);
			return model;
		};
		switch (def.kind) {
			case 'statue': {
				// CopperGolemStatueBlockRenderer.createModelTransformation: to the middle of the block, turned to face
				// away from the block's facing; CopperGolemStatueModel.setupAnim: the root at y 0, upside down
				const opposite = { north: 'south', south: 'north', east: 'west', west: 'east' }[def.facing] || 'south';
				translate(m, 0.5, 0, 0.5);
				rotate(m, 1, -(FACING_YROT[opposite] ?? 0) * DEG);
				emit(def.layer, def.texture, m, null, MODE_NOCULL, parts => {
					parts.root.y = 0;
					parts.root.zRot = Math.PI;
				});
				break;
			}
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
				// Direction.getRotation: down rotationX(180°); the sides rotationXYZ(90°, 0, z) with z 180° (north), 0 (south),
				// 90° (west) and -90° (east)
				if (def.facing === 'down') rotate(m, 0, Math.PI);
				else if (def.facing !== 'up') {
					rotate(m, 0, Math.PI / 2);
					const z = { north: 180, south: 0, west: 90, east: -90 }[def.facing] || 0;
					if (z) rotate(m, 2, z * DEG);
				}
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
				// SkullBlockRenderer: a wall head is turned by RotationSegment.convertToSegment(facing.getOpposite())
				const yaw = def.wall ? { north: 0, south: 180, west: 270, east: 90 }[def.facing] ?? 0 : def.rotation * 22.5;
				const model = this.library.get(def.layer);
				// Player heads show their owner's skin (SkullBlockRenderer.resolveSkullRenderType).
				const owner = data && data.k === 'head' && def.layer === 'minecraft:player_head#main' ? data : null;
				const texture = owner ? this.skin(owner.uuid || 'name:' + owner.name, owner.name).texture : this.texture(def.texture);
				if (model && texture) {
					model.reset();
					if (model.parts.head) model.parts.head.yRot = yaw * DEG;
					const start = this.sink.mark();
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
				// BannerRenderer.extractRenderState phase (by the level's game time) and BannerFlagModel.setupAnim: the flag sways.
				const b = pos || { x: 0, y: 0, z: 0 };
				const ticks = this.env ? this.env.gameTime(performance.now()) : performance.now() / 50;
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
			this.bindBones(p.u);
			gl.activeTexture(gl.TEXTURE0);
			for (const b of this.batches) {
				if (b.mode >= MODE_EYES || b.mode === MODE_TRANSLUCENT) continue;
				gl.bindTexture(gl.TEXTURE_2D, b.texture);
				this.drawBatch(b, p.u, false);
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
		gl.uniform2f(u.uUvOffset, 0, 0);
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, this.renderer.lightmap);
		gl.uniform1i(u.uLightmap, 1);
		gl.activeTexture(gl.TEXTURE0);
		gl.uniform1i(u.uTexture, 0);
		if (shaders) this.renderer.bindShaderUniforms(u, frame, shadow);
		this.bindBones(u);
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
		let glintOn = -1, uvU = 0, uvV = 0;
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
				if (b.u !== uvU || b.v !== uvV) {
					uvU = b.u; uvV = b.v;
					gl.uniform2f(u.uUvOffset, uvU, uvV);
				}
				if (b.cull) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
				gl.bindTexture(gl.TEXTURE_2D, b.texture);
				this.drawBatch(b, u, true);
			}
		};
		gl.disable(gl.BLEND);
		gl.depthMask(true);
		drawBatches(b => b.mode <= MODE_NOCULL);
		gl.enable(gl.BLEND);
		gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		gl.depthMask(false);
		drawBatches(b => b.mode === MODE_TRANSLUCENT || b.mode === MODE_TRANSLUCENT_EMISSIVE || b.mode === MODE_BREEZE_WIND);
		drawBatches(b => b.mode === MODE_EYES);
		gl.blendFunc(gl.ONE, gl.ONE);
		drawBatches(b => b.mode === MODE_ENERGY);
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
			if (type === 'item' || type === 'experience_orb' || type === 'lightning_bolt' || type === 'area_effect_cloud' || type.endsWith('arrow')) continue;
			// Players and mobs whose custom name is always visible, like in the game; every mob with "mob labels".
			const named = type === 'player' || (!!e.name && !!e.nameVisible);
			if (named ? !this.showLabels : !this.showMobLabels) continue;
			// LivingEntityRenderer.shouldShowName: not when its team never shows name tags, nor while it is ridden
			if (named && (e.tagHidden || (e.d && e.d.ridden))) continue;
			const height = e.h || 1;
			const dx = e.x - eye[0], dy = e.y + height - eye[1], dz = e.z - eye[2];
			const distance = Math.hypot(dx, dy, dz);
			// the name_tag_distance attribute, 32 blocks for a sneaking player
			const limit = !named ? 32 : Math.min(e.tagDist ?? 64, type === 'player' && e.sneak ? 32 : Infinity);
			if (distance >= limit || distance > frame.fogEnd) continue;
			const rx = e.x - o[0] - cam[0], ry = e.y + height - o[1] - cam[1], rz = e.z - o[2] - cam[2];
			if (!frame.frustum(rx, ry + 0.6, rz, 2)) continue;
			// Visible if the head or the middle of the body can be seen.
			if (world.occluded(eye, [e.x, e.y + height * 0.9, e.z]) && world.occluded(eye, [e.x, e.y + height * 0.5, e.z])) continue;
			tags.push({
				pos: [rx, ry, rz],
				text: e.name || (this.names && this.names[type]) || titleCase(type),
				// the display name's colours and formatting (a team's colour, prefix and suffix, a coloured name)
				pieces: named && e.nameStyle ? e.nameStyle : null,
				// EntityRenderer.extractNameTags: the text under the name (a mannequin's description, the scoreboard's
				// below_name objective) within the below_name_distance attribute (10 blocks)
				below: named && (e.desc ?? e.below) && distance < (e.belowDist ?? 10) ? e.desc ?? e.below : null,
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

// --- display entities (DisplayRenderer, com.mojang.math.Transformation) ---

/** [translation xyz, left rotation xyzw, scale xyz, right rotation xyzw] as a Transformation. */
function transformationOf(t) {
	const a = t && t.length === 14 ? t : [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 1];
	return { translation: a.slice(0, 3), left: a.slice(3, 7), scale: a.slice(7, 10), right: a.slice(10, 14) };
}

/** Quaternionf.slerp (the shorter way round, linear when nearly parallel). */
function slerpQuaternion(a, b, t) {
	let cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
	const sign = cos < 0 ? -1 : 1;
	cos = Math.abs(cos);
	let s0 = 1 - t, s1 = t;
	if (1 - cos > 1e-6) {
		const angle = Math.acos(cos), sin = Math.sin(angle);
		s0 = Math.sin((1 - t) * angle) / sin;
		s1 = Math.sin(t * angle) / sin;
	}
	return [0, 1, 2, 3].map(i => s0 * a[i] + s1 * sign * b[i]);
}

/** Transformation.slerp: translations and scales lerped, rotations slerped. */
function slerpTransformation(a, b, t) {
	if (t >= 1) return b;
	return {
		translation: a.translation.map((v, i) => lerp(v, b.translation[i], t)),
		left: slerpQuaternion(a.left, b.left, t),
		scale: a.scale.map((v, i) => lerp(v, b.scale[i], t)),
		right: slerpQuaternion(a.right, b.right, t),
	};
}

function quaternionMatrix([x, y, z, w]) {
	const n = Math.hypot(x, y, z, w) || 1;
	x /= n; y /= n; z /= n; w /= n;
	return new Float32Array([
		1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
		2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
		2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
		0, 0, 0, 1,
	]);
}

/** m = m * T * L * S * R (PoseStack.mulPose(Transformation)). */
function multiplyTransformation(m, t) {
	translate(m, t.translation[0], t.translation[1], t.translation[2]);
	m.set(mul(m, quaternionMatrix(t.left)));
	scale(m, t.scale[0], t.scale[1], t.scale[2]);
	m.set(mul(m, quaternionMatrix(t.right)));
}

/** ARGB.srgbLerp of two packed colours (each channel a + floor(t * (b - a))). */
function argbLerp(a, b, t) {
	if (t >= 1) return b;
	let out = 0;
	for (const shift of [24, 16, 8, 0]) {
		const ca = a >>> shift & 255, cb = b >>> shift & 255;
		out += (ca + Math.floor(t * (cb - ca))) * 2 ** shift;
	}
	return out;
}

const argbColor = c => [(c >>> 16 & 255) / 255, (c >>> 8 & 255) / 255, (c & 255) / 255, (c >>> 24 & 255) / 255];

/**
 * StringSplitter.splitLines for styled pieces [text, rgb, style flags]: lines broken at line breaks and, past
 * `width` pixels, at the last space (dropped) or inside a word longer than a line; each line as runs of one
 * style with its width. advance(ch, bold) is the font's.
 */
export function splitStyledLines(pieces, width, advance) {
	const lines = [];
	let line = [], lineWidth = 0, lastSpace = -1;
	const finish = () => {
		const runs = [];
		for (const c of line) {
			const last = runs[runs.length - 1];
			if (last && last[1] === c.color && last[2] === c.style) last[0] += c.ch;
			else runs.push([c.ch, c.color, c.style]);
		}
		lines.push({ runs, width: line.reduce((sum, c) => sum + c.w, 0) });
	};
	for (const [text, color, style] of pieces) {
		for (const ch of String(text)) {
			if (ch === '\n') {
				finish();
				line = [];
				lineWidth = 0;
				lastSpace = -1;
				continue;
			}
			const w = advance(ch, !!(style & 1));
			if (lineWidth + w > width && line.length) {
				if (lastSpace >= 0) {
					const rest = line.slice(lastSpace + 1);
					line = line.slice(0, lastSpace);
					finish();
					line = rest;
				} else {
					finish();
					line = [];
				}
				lineWidth = line.reduce((sum, c) => sum + c.w, 0);
				lastSpace = -1;
			}
			if (ch === ' ') lastSpace = line.length;
			line.push({ ch, color, style, w });
			lineWidth += w;
		}
	}
	finish();
	return lines;
}
