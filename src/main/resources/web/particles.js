// Particles like the game client (26.3). Every game tick ClientLevel.animateTick picks random blocks around the
// camera and runs their animateTick (ports in ANIMATE below), lit campfires tick their smoke
// (CampfireBlockEntity.particleTick), and the particles move and look like the game's Particle classes:
// Particle.tick/move physics, the sprite sets of particles/*.json with the textures from textures/particle
// (both from the client jar, resource packs apply), drawn as camera-facing quads, lit by the lightmap.

import { program, FOG_GLSL, setFog } from './gl.js';
import { JavaRandom, positionSeed } from './rng.js';
import { tintSourceOf, TINT_GRASS, TINT_DOUBLE_GRASS, TINT_FOLIAGE, TINT_DRY_FOLIAGE, TINT_CONSTANT } from './mesher.js';

const MAX_PARTICLES = 16384; // ParticleEngine.MAX_PARTICLES_PER_LAYER
const FLOATS = 11; // position 3, uv 2, colour 4, light 2

const FLAG_AIR = 1, FLAG_OPAQUE = 2, FLAG_WATER = 4, FLAG_LAVA = 8, FLAG_NO_COLLISION = 16, FLAG_FULL_COLLISION = 32;

// --- RandomSource helpers ---------------------------------------------------------------------------------
const nextFloat = () => Math.random();
const nextDouble = () => Math.random();
const nextInt = n => Math.floor(Math.random() * n);
const nextBoolean = () => Math.random() < 0.5;
const nextGaussian = () => {
	let u = 0, v = 0;
	while (u === 0) u = Math.random();
	while (v === 0) v = Math.random();
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (t, a, b) => a + (b - a) * t;

const DIRS = { down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] };
const OPPOSITE = { down: 'up', up: 'down', north: 'south', south: 'north', west: 'east', east: 'west' };

// --- Particle (base physics) -----------------------------------------------------------------------------

class Particle {
	constructor(level, x, y, z, xa, ya, za) {
		this.level = level;
		this.bbWidth = 0.6;
		this.bbHeight = 1.8;
		this.hasPhysics = true;
		this.stoppedByCollision = false;
		this.removed = false;
		this.age = 0;
		this.gravity = 0;
		this.friction = 0.98;
		this.speedUpWhenYMotionIsBlocked = false;
		this.onGround = false;
		this.xd = this.yd = this.zd = 0;
		this.bb = [0, 0, 0, 0, 0, 0];
		this.setSize(0.2, 0.2);
		this.setPos(x, y, z);
		this.xo = x; this.yo = y; this.zo = z;
		this.lifetime = Math.trunc(4 / (nextFloat() * 0.9 + 0.1));
		if (xa !== undefined) {
			// Particle(level, x, y, z, xa, ya, za): a random spread around the given speed.
			this.xd = xa + (nextFloat() * 2 - 1) * 0.4;
			this.yd = ya + (nextFloat() * 2 - 1) * 0.4;
			this.zd = za + (nextFloat() * 2 - 1) * 0.4;
			const speed = (nextFloat() + nextFloat() + 1) * 0.15;
			const dd = Math.sqrt(this.xd * this.xd + this.yd * this.yd + this.zd * this.zd);
			this.xd = this.xd / dd * speed * 0.4;
			this.yd = this.yd / dd * speed * 0.4 + 0.1;
			this.zd = this.zd / dd * speed * 0.4;
		}
	}

	setSize(w, h) {
		if (w === this.bbWidth && h === this.bbHeight) return;
		this.bbWidth = w;
		this.bbHeight = h;
		const b = this.bb;
		const minX = (b[0] + b[3] - w) / 2, minZ = (b[2] + b[5] - w) / 2;
		this.bb = [minX, b[1], minZ, minX + w, b[1] + h, minZ + w];
	}

	setPos(x, y, z) {
		this.x = x; this.y = y; this.z = z;
		const w = this.bbWidth / 2;
		this.bb = [x - w, y, z - w, x + w, y + this.bbHeight, z + w];
	}

	scale(s) {
		this.setSize(0.2 * s, 0.2 * s);
		return this;
	}

	remove() {
		this.removed = true;
	}

	tick() {
		this.xo = this.x; this.yo = this.y; this.zo = this.z;
		if (this.age++ >= this.lifetime) {
			this.remove();
			return;
		}
		this.yd -= 0.04 * this.gravity;
		this.move(this.xd, this.yd, this.zd);
		if (this.speedUpWhenYMotionIsBlocked && this.y === this.yo) {
			this.xd *= 1.1;
			this.zd *= 1.1;
		}
		this.xd *= this.friction;
		this.yd *= this.friction;
		this.zd *= this.friction;
		if (this.onGround) {
			this.xd *= 0.7;
			this.zd *= 0.7;
		}
	}

	move(xa, ya, za) {
		if (this.stoppedByCollision) return;
		const ox = xa, oy = ya, oz = za;
		if (this.hasPhysics && (xa !== 0 || ya !== 0 || za !== 0) && xa * xa + ya * ya + za * za < 10000) {
			[xa, ya, za] = this.level.collide(this.bb, xa, ya, za);
		}
		if (xa !== 0 || ya !== 0 || za !== 0) {
			const b = this.bb;
			b[0] += xa; b[1] += ya; b[2] += za; b[3] += xa; b[4] += ya; b[5] += za;
			this.setLocationFromBoundingbox();
		}
		if (Math.abs(oy) >= 1e-5 && Math.abs(ya) < 1e-5) this.stoppedByCollision = true;
		this.onGround = oy !== ya && oy < 0;
		if (ox !== xa) this.xd = 0;
		if (oz !== za) this.zd = 0;
	}

	/** Moves without collisions (FlameParticle, PortalParticle, EndRodParticle override move so). */
	moveFree(xa, ya, za) {
		const b = this.bb;
		b[0] += xa; b[1] += ya; b[2] += za; b[3] += xa; b[4] += ya; b[5] += za;
		this.setLocationFromBoundingbox();
	}

	setLocationFromBoundingbox() {
		const b = this.bb;
		this.x = (b[0] + b[3]) / 2;
		this.y = b[1];
		this.z = (b[2] + b[5]) / 2;
	}

	/** Particle.getLightCoords: [block, sky] * 16 at the particle. */
	light() {
		return this.level.lightCoords(this.x, this.y, this.z);
	}
}

/** SingleQuadParticle: a textured, coloured quad facing the camera. */
class QuadParticle extends Particle {
	constructor(level, x, y, z, xa, ya, za, sprite) {
		super(level, x, y, z, xa, ya, za);
		this.sprite = sprite;
		this.quadSize = 0.1 * (nextFloat() * 0.5 + 0.5) * 2;
		this.rCol = this.gCol = this.bCol = 1;
		this.alpha = 1;
		this.roll = this.oRoll = 0;
		this.translucent = false;
	}

	scale(s) {
		this.quadSize *= s;
		return super.scale(s);
	}

	quadSizeAt() {
		return this.quadSize;
	}

	setSpriteFromAge(set) {
		if (!this.removed) this.sprite = set.byAge(this.age, this.lifetime);
	}

	setColor(r, g, b) {
		this.rCol = r; this.gCol = g; this.bCol = b;
	}
}

// --- the game's particle classes -------------------------------------------------------------------------

/** RisingParticle + FlameParticle (flame, soul fire flame, copper fire flame, small flame). */
class FlameParticle extends QuadParticle {
	constructor(level, x, y, z, xd, yd, zd, sprite) {
		super(level, x, y, z, xd, yd, zd, sprite);
		this.friction = 0.96;
		this.xd = this.xd * 0.01 + xd;
		this.yd = this.yd * 0.01 + yd;
		this.zd = this.zd * 0.01 + zd;
		this.x += (nextFloat() - nextFloat()) * 0.05;
		this.y += (nextFloat() - nextFloat()) * 0.05;
		this.z += (nextFloat() - nextFloat()) * 0.05;
		this.lifetime = Math.trunc(8 / (nextFloat() * 0.8 + 0.2)) + 4;
	}

	move(xa, ya, za) {
		this.moveFree(xa, ya, za);
	}

	quadSizeAt(a) {
		const s = (this.age + a) / this.lifetime;
		return this.quadSize * (1 - s * s * 0.5);
	}

	light(a) {
		// LightCoordsUtil.addSmoothBlockEmission: the flame gets brighter as it ages.
		const l = super.light();
		return [Math.min(240, l[0] + Math.trunc(clamp((this.age + a) / this.lifetime, 0, 1) * 15 * 16)), l[1]];
	}
}

/** BaseAshSmokeParticle: SmokeParticle (scale 1) and LargeSmokeParticle (scale 2.5). */
class SmokeParticle extends QuadParticle {
	constructor(level, x, y, z, xa, ya, za, scale, sprites) {
		super(level, x, y, z, 0, 0, 0, sprites.first());
		this.friction = 0.96;
		this.gravity = -0.1;
		this.speedUpWhenYMotionIsBlocked = true;
		this.sprites = sprites;
		this.xd = this.xd * 0.1 + xa;
		this.yd = this.yd * 0.1 + ya;
		this.zd = this.zd * 0.1 + za;
		const col = nextFloat() * 0.3;
		this.rCol = this.gCol = this.bCol = col;
		this.quadSize *= 0.75 * scale;
		this.lifetime = Math.max(1, Math.trunc(8 / (nextFloat() * 0.8 + 0.2) * scale));
		this.setSpriteFromAge(sprites);
		this.hasPhysics = true;
	}

	quadSizeAt(a) {
		return this.quadSize * clamp((this.age + a) / this.lifetime * 32, 0, 1);
	}

	tick() {
		super.tick();
		this.setSpriteFromAge(this.sprites);
	}
}

class LavaParticle extends QuadParticle {
	constructor(level, x, y, z, sprite) {
		super(level, x, y, z, 0, 0, 0, sprite);
		this.gravity = 0.75;
		this.friction = 0.999;
		this.xd *= 0.8;
		this.yd *= 0.8;
		this.zd *= 0.8;
		this.yd = nextFloat() * 0.4 + 0.05;
		this.quadSize *= nextFloat() * 2 + 0.2;
		this.lifetime = Math.trunc(16 / (nextFloat() * 0.8 + 0.2));
	}

	light() {
		return [240, super.light()[1]];
	}

	quadSizeAt(a) {
		const s = (this.age + a) / this.lifetime;
		return this.quadSize * (1 - s * s);
	}

	tick() {
		super.tick();
		if (!this.removed && nextFloat() > this.age / this.lifetime) {
			this.level.add('minecraft:smoke', this.x, this.y, this.z, this.xd, this.yd, this.zd);
		}
	}
}

class CampfireSmokeParticle extends QuadParticle {
	constructor(level, x, y, z, xa, ya, za, signal, sprite) {
		super(level, x, y, z, undefined, undefined, undefined, sprite);
		this.scale(3);
		this.setSize(0.25, 0.25);
		this.lifetime = signal ? nextInt(50) + 280 : nextInt(50) + 80;
		this.gravity = 3.0e-6;
		this.xd = xa;
		this.yd = ya + nextFloat() / 500;
		this.zd = za;
		this.translucent = true;
	}

	tick() {
		this.xo = this.x; this.yo = this.y; this.zo = this.z;
		if (this.age++ < this.lifetime && !(this.alpha <= 0)) {
			this.xd += nextFloat() / 5000 * (nextBoolean() ? 1 : -1);
			this.zd += nextFloat() / 5000 * (nextBoolean() ? 1 : -1);
			this.yd -= this.gravity;
			this.move(this.xd, this.yd, this.zd);
			if (this.age >= this.lifetime - 60 && this.alpha > 0.01) this.alpha -= 0.015;
		} else {
			this.remove();
		}
	}
}

/** DripParticle and its hang / fall / land variants. */
class DripParticle extends QuadParticle {
	constructor(level, x, y, z, fluid, sprite) {
		super(level, x, y, z, undefined, undefined, undefined, sprite);
		this.setSize(0.01, 0.01);
		this.gravity = 0.06;
		this.fluid = fluid;
		this.glowing = false;
		this.kind = 'drip';
	}

	light() {
		const l = super.light();
		return this.glowing ? [240, l[1]] : l;
	}

	tick() {
		this.xo = this.x; this.yo = this.y; this.zo = this.z;
		this.preMoveUpdate();
		if (this.removed) return;
		this.yd -= this.gravity;
		this.move(this.xd, this.yd, this.zd);
		this.postMoveUpdate();
		if (this.removed) return;
		this.xd *= 0.98; this.yd *= 0.98; this.zd *= 0.98;
		if (this.fluid && this.level.inFluid(this.fluid, this.x, this.y, this.z)) this.remove();
	}

	preMoveUpdate() {
		if (this.lifetime-- <= 0) this.remove();
	}

	postMoveUpdate() {
		if (this.kind === 'hang') {
			this.xd *= 0.02; this.yd *= 0.02; this.zd *= 0.02;
		} else if ((this.kind === 'fall' || this.kind === 'fallLand') && this.onGround) {
			this.remove();
			if (this.kind === 'fallLand' && this.land) this.level.add(this.land, this.x, this.y, this.z, 0, 0, 0);
			// DripstoneFallAndLandParticle / HoneyFallAndLandParticle: the drop is heard landing
			if (this.landSound) this.level.sound(this.landSound, this.x, this.y, this.z, 'block', 0.3 + nextFloat() * 0.7, 1);
		}
	}
}

class HangingDrip extends DripParticle {
	constructor(level, x, y, z, fluid, falling, sprite, cooling) {
		super(level, x, y, z, fluid, sprite);
		this.kind = 'hang';
		this.falling = falling;
		this.gravity *= 0.02;
		this.lifetime = 40;
		this.cooling = cooling;
	}

	preMoveUpdate() {
		if (this.cooling) {
			// CoolingDripHangParticle: lava drips cool from yellow to red.
			this.rCol = 1;
			this.gCol = 16 / (40 - this.lifetime + 16);
			this.bCol = 4 / (40 - this.lifetime + 8);
		}
		if (this.lifetime-- <= 0) {
			this.remove();
			this.level.add(this.falling, this.x, this.y, this.z, this.xd, this.yd, this.zd);
		}
	}
}

/** FallingParticle: falling leaves that drift, spin and swirl. */
class FallingLeafParticle extends QuadParticle {
	constructor(level, x, y, z, sprite, fallAcceleration, sideAcceleration, swirl, flowAway, scale, startVelocity) {
		super(level, x, y, z, undefined, undefined, undefined, sprite);
		this.rotSpeed = (nextBoolean() ? -30 : 30) * Math.PI / 180;
		this.spinAcceleration = (nextBoolean() ? -5 : 5) * Math.PI / 180;
		this.windBig = sideAcceleration;
		this.swirl = swirl;
		this.flowAway = flowAway;
		this.lifetime = 300;
		this.gravity = fallAcceleration * 1.2 * 0.0025;
		const size = scale * (nextBoolean() ? 0.05 : 0.075);
		this.quadSize = size;
		this.setSize(size, size);
		this.friction = 1;
		this.yd = -startVelocity;
		const r = nextFloat();
		this.xaFlowScale = Math.cos(r * 60 * Math.PI / 180) * this.windBig;
		this.zaFlowScale = Math.sin(r * 60 * Math.PI / 180) * this.windBig;
		this.swirlPeriod = (1000 + r * 3000) * Math.PI / 180;
	}

	tick() {
		this.xo = this.x; this.yo = this.y; this.zo = this.z;
		if (this.lifetime-- <= 0) this.remove();
		if (this.removed) return;
		const relativeAge = Math.min((300 - this.lifetime) / 300, 1);
		let xa = 0, za = 0;
		if (this.flowAway) {
			xa += this.xaFlowScale * Math.pow(relativeAge, 1.25);
			za += this.zaFlowScale * Math.pow(relativeAge, 1.25);
		}
		if (this.swirl) {
			xa += relativeAge * Math.cos(relativeAge * this.swirlPeriod) * this.windBig;
			za += relativeAge * Math.sin(relativeAge * this.swirlPeriod) * this.windBig;
		}
		this.xd += xa * 0.0025;
		this.zd += za * 0.0025;
		this.yd -= this.gravity;
		this.rotSpeed += this.spinAcceleration / 20;
		this.oRoll = this.roll;
		this.roll += this.rotSpeed / 20;
		this.move(this.xd, this.yd, this.zd);
		if (this.onGround || (this.lifetime < 299 && (this.xd === 0 || this.zd === 0))) this.remove();
		if (!this.removed) {
			this.xd *= this.friction; this.yd *= this.friction; this.zd *= this.friction;
		}
	}
}

/** SuspendedParticle (spore blossom air, underwater). */
class SuspendedParticle extends QuadParticle {
	constructor(level, x, y, z, xd, yd, zd, sprite) {
		super(level, x, y - 0.125, z, xd, yd, zd, sprite);
		this.setSize(0.01, 0.01);
		this.quadSize *= nextFloat() * 0.6 + (xd === undefined ? 0.2 : 0.6);
		this.lifetime = Math.trunc(16 / (nextFloat() * 0.8 + 0.2));
		this.hasPhysics = false;
		this.friction = 1;
		this.gravity = 0;
	}
}

class PortalParticle extends QuadParticle {
	constructor(level, x, y, z, xd, yd, zd, sprite) {
		super(level, x, y, z, undefined, undefined, undefined, sprite);
		this.xd = xd; this.yd = yd; this.zd = zd;
		this.xStart = x; this.yStart = y; this.zStart = z;
		this.x = x; this.y = y; this.z = z;
		this.quadSize = 0.1 * (nextFloat() * 0.2 + 0.5);
		const br = nextFloat() * 0.6 + 0.4;
		this.setColor(br * 0.9, br * 0.3, br);
		this.lifetime = Math.trunc(nextFloat() * 10) + 40;
	}

	quadSizeAt(a) {
		let s = 1 - (this.age + a) / this.lifetime;
		s *= s;
		return this.quadSize * (1 - s);
	}

	light() {
		let b = this.age / this.lifetime;
		b *= b; b *= b;
		const l = super.light();
		return [Math.min(240, l[0] + Math.trunc(b * 15 * 16)), l[1]];
	}

	tick() {
		this.xo = this.x; this.yo = this.y; this.zo = this.z;
		if (this.age++ >= this.lifetime) {
			this.remove();
			return;
		}
		const pos = this.age / this.lifetime;
		const k = 1 - (-pos + pos * pos * 2);
		this.x = this.xStart + this.xd * k;
		this.y = this.yStart + this.yd * k + (1 - pos);
		this.z = this.zStart + this.zd * k;
	}
}

/** SimpleAnimatedParticle + EndRodParticle. */
class EndRodParticle extends QuadParticle {
	constructor(level, x, y, z, xa, ya, za, sprites) {
		super(level, x, y, z, undefined, undefined, undefined, sprites.first());
		this.friction = 0.91;
		this.gravity = 0.0125;
		this.sprites = sprites;
		this.xd = xa; this.yd = ya; this.zd = za;
		this.quadSize *= 0.75;
		this.lifetime = 60 + nextInt(12);
		this.fade = [0xf2 / 255, 0xde / 255, 0xc9 / 255]; // setFadeColor(15916745)
		this.translucent = true;
		this.setSpriteFromAge(sprites);
	}

	move(xa, ya, za) {
		this.moveFree(xa, ya, za);
	}

	light() {
		return [240, 240];
	}

	tick() {
		super.tick();
		this.setSpriteFromAge(this.sprites);
		if (this.age > this.lifetime / 2) {
			this.alpha = 1 - (this.age - this.lifetime / 2) / this.lifetime;
			this.rCol += (this.fade[0] - this.rCol) * 0.2;
			this.gCol += (this.fade[1] - this.gCol) * 0.2;
			this.bCol += (this.fade[2] - this.bCol) * 0.2;
		}
	}
}

/** FireworkParticles.SparkParticle (a SimpleAnimatedParticle): a glowing spark, trailing or twinkling, fading. */
class FireworkSpark extends QuadParticle {
	constructor(level, x, y, z, xa, ya, za, sprites, engine) {
		super(level, x, y, z, undefined, undefined, undefined, sprites.first());
		this.friction = 0.91;
		this.gravity = 0.1;
		this.sprites = sprites;
		this.engine = engine;
		this.xd = xa; this.yd = ya; this.zd = za;
		this.quadSize *= 0.75;
		this.lifetime = 48 + nextInt(12);
		this.alpha = 0.99;
		this.translucent = true;
		this.trail = false;
		this.twinkle = false;
		this.fade = null;
		this.setSpriteFromAge(sprites);
	}

	/** SparkParticle.extract: twinkling sparks blink in their last two thirds. */
	get hidden() {
		return this.twinkle && this.age >= Math.trunc(this.lifetime / 3) && Math.trunc((this.age + this.lifetime) / 3) % 2 !== 0;
	}

	light() {
		return [240, 240];
	}

	tick() {
		super.tick();
		this.setSpriteFromAge(this.sprites);
		const half = Math.trunc(this.lifetime / 2);
		if (this.age > half) {
			this.alpha = 1 - (this.age - half) / this.lifetime;
			if (this.fade) {
				this.rCol += (this.fade[0] - this.rCol) * 0.2;
				this.gCol += (this.fade[1] - this.gCol) * 0.2;
				this.bCol += (this.fade[2] - this.bCol) * 0.2;
			}
		}
		if (this.trail && this.age < half && (this.age + this.lifetime) % 2 === 0) {
			const spark = new FireworkSpark(this.level, this.x, this.y, this.z, 0, 0, 0, this.sprites, this.engine);
			spark.setColor(this.rCol, this.gCol, this.bCol);
			spark.age = Math.trunc(spark.lifetime / 2);
			spark.fade = this.fade;
			spark.twinkle = this.twinkle;
			if (this.engine.length < MAX_PARTICLES) this.engine.push(spark);
		}
	}
}

/** FireworkParticles.OverlayParticle (flash): the burst of light where a firework explodes. */
class FireworkFlash extends QuadParticle {
	constructor(level, x, y, z, sprite) {
		super(level, x, y, z, undefined, undefined, undefined, sprite);
		this.lifetime = 4;
		this.translucent = true;
	}

	quadSizeAt(a) {
		// OverlayParticle.extract sets the alpha for the frame too
		this.alpha = 0.6 - (this.age + a - 1) * 0.25 * 0.5;
		return 7.1 * Math.sin((this.age + a - 1) * 0.25 * Math.PI);
	}
}

/**
 * FireworkParticles.Starter: explodes a rocket's explosions one every two ticks (balls, stars, creepers,
 * bursts), with the blast (and twinkle) sounds. Not drawn itself; it runs with particles off for the sounds.
 */
class FireworkStarter {
	constructor(engine, level, x, y, z, xd, yd, zd, explosions, playSound) {
		this.engine = engine;
		this.level = level;
		this.x = x; this.y = y; this.z = z;
		this.xd = xd; this.yd = yd; this.zd = zd;
		this.explosions = explosions;
		this.playSound = playSound;
		this.life = 0;
		this.lifetime = explosions.length * 2 - 1;
		this.twinkleDelay = explosions.some(e => e.twinkle);
		if (this.twinkleDelay) this.lifetime += 15;
		this.removed = false;
	}

	far() {
		const c = this.engine.camera;
		return !c || (c.x - this.x) ** 2 + (c.y - this.y) ** 2 + (c.z - this.z) ** 2 >= 256;
	}

	tick() {
		if (this.life === 0 && this.playSound) {
			const large = this.explosions.length >= 3 || this.explosions.some(e => e.shape === 'large_ball');
			const sound = 'minecraft:entity.firework_rocket.' + (large ? 'large_blast' : 'blast') + (this.far() ? '_far' : '');
			this.level.sound(sound, this.x, this.y, this.z, 'ambient', 20, 0.95 + nextFloat() * 0.1, true);
		}
		if (this.life % 2 === 0 && this.life / 2 < this.explosions.length) {
			const explosion = this.explosions[this.life / 2];
			const colors = explosion.colors.length ? explosion.colors : [0x1e1b1b]; // DyeColor.BLACK.getFireworkColor()
			switch (explosion.shape) {
				case 'small_ball': this.ball(0.25, 2, colors, explosion); break;
				case 'large_ball': this.ball(0.5, 4, colors, explosion); break;
				case 'star': this.shape(0.5, STAR_COORDS, colors, explosion, false); break;
				case 'creeper': this.shape(0.5, CREEPER_COORDS, colors, explosion, true); break;
				case 'burst': this.burst(colors, explosion); break;
				default: break;
			}
			this.engine.addFirework('flash', this.level, this.x, this.y, this.z, colors[0]);
		}
		this.life++;
		if (this.life > this.lifetime) {
			if (this.twinkleDelay && this.playSound) {
				const sound = 'minecraft:entity.firework_rocket.twinkle' + (this.far() ? '_far' : '');
				this.level.sound(sound, this.x, this.y, this.z, 'ambient', 20, 0.9 + nextFloat() * 0.15, true);
			}
			this.removed = true;
		}
	}

	spark(xa, ya, za, colors, explosion) {
		const fade = explosion.fade.length ? explosion.fade[nextInt(explosion.fade.length)] : null;
		this.engine.addFirework('spark', this.level, this.x, this.y, this.z, colors[nextInt(colors.length)], xa, ya, za,
			explosion.trail, explosion.twinkle, fade);
	}

	ball(speed, steps, colors, explosion) {
		for (let y = -steps; y <= steps; y++) {
			for (let x = -steps; x <= steps; x++) {
				for (let z = -steps; z <= steps; z++) {
					const xa = x + (nextDouble() - nextDouble()) * 0.5;
					const ya = y + (nextDouble() - nextDouble()) * 0.5;
					const za = z + (nextDouble() - nextDouble()) * 0.5;
					const len = Math.sqrt(xa * xa + ya * ya + za * za) / speed + nextGaussian() * 0.05;
					this.spark(xa / len, ya / len, za / len, colors, explosion);
					if (y !== -steps && y !== steps && x !== -steps && x !== steps) z += steps * 2 - 1;
				}
			}
		}
	}

	shape(speed, coords, colors, explosion, flat) {
		const [sx, sy] = coords[0];
		this.spark(sx * speed, sy * speed, 0, colors, explosion);
		const baseAngle = nextFloat() * Math.PI;
		const angleMod = flat ? 0.034 : 0.34;
		for (let step = 0; step < 3; step++) {
			const angle = baseAngle + step * Math.PI * angleMod;
			let ox = sx, oy = sy;
			for (let c = 1; c < coords.length; c++) {
				const [tx, ty] = coords[c];
				for (let sub = 0.25; sub <= 1; sub += 0.25) {
					let xa = lerp(sub, ox, tx) * speed;
					const ya = lerp(sub, oy, ty) * speed;
					const za = xa * Math.sin(angle);
					xa *= Math.cos(angle);
					for (let flip = -1; flip <= 1; flip += 2) this.spark(xa * flip, ya, za * flip, colors, explosion);
				}
				ox = tx; oy = ty;
			}
		}
	}

	burst(colors, explosion) {
		const offX = nextGaussian() * 0.05, offZ = nextGaussian() * 0.05;
		for (let i = 0; i < 70; i++) {
			this.spark(this.xd * 0.5 + nextGaussian() * 0.15 + offX, this.yd * 0.5 + nextDouble() * 0.5,
				this.zd * 0.5 + nextGaussian() * 0.15 + offZ, colors, explosion);
		}
	}
}

const CREEPER_COORDS = [[0, 0.2], [0.2, 0.2], [0.2, 0.6], [0.6, 0.6], [0.6, 0.2], [0.2, 0.2], [0.2, 0], [0.4, 0], [0.4, -0.6], [0.2, -0.6], [0.2, -0.4], [0, -0.4]];
const STAR_COORDS = [[0, 1], [0.3455, 0.309], [0.9511, 0.309], [0.3795918367346939, -0.12653061224489795], [0.6122448979591837, -0.8040816326530612], [0, -0.35918367346938773]];

/** DustParticleBase + DustParticle (redstone). */
class DustParticle extends QuadParticle {
	constructor(level, x, y, z, xa, ya, za, color, scale, sprites) {
		super(level, x, y, z, xa, ya, za, sprites.first());
		this.friction = 0.96;
		this.speedUpWhenYMotionIsBlocked = true;
		this.sprites = sprites;
		this.xd *= 0.1; this.yd *= 0.1; this.zd *= 0.1;
		this.quadSize *= 0.75 * scale;
		this.lifetime = Math.trunc(Math.max(Math.trunc(8 / (nextDouble() * 0.8 + 0.2)) * scale, 1));
		this.setSpriteFromAge(sprites);
		const base = nextFloat() * 0.4 + 0.6;
		const randomize = c => (nextFloat() * 0.2 + 0.8) * c * base;
		this.setColor(randomize(color[0]), randomize(color[1]), randomize(color[2]));
	}

	quadSizeAt(a) {
		return this.quadSize * clamp((this.age + a) / this.lifetime * 32, 0, 1);
	}

	tick() {
		super.tick();
		this.setSpriteFromAge(this.sprites);
	}
}

/** WaterDropParticle + SplashParticle. */
class WaterDropParticle extends QuadParticle {
	constructor(level, x, y, z, sprite) {
		super(level, x, y, z, 0, 0, 0, sprite);
		this.xd *= 0.3;
		this.yd = nextFloat() * 0.2 + 0.1;
		this.zd *= 0.3;
		this.setSize(0.01, 0.01);
		this.gravity = 0.06;
		this.lifetime = Math.trunc(8 / (nextFloat() * 0.8 + 0.2));
	}

	tick() {
		this.xo = this.x; this.yo = this.y; this.zo = this.z;
		if (this.lifetime-- <= 0) {
			this.remove();
			return;
		}
		this.yd -= this.gravity;
		this.move(this.xd, this.yd, this.zd);
		this.xd *= 0.98; this.yd *= 0.98; this.zd *= 0.98;
		if (this.onGround) {
			if (nextFloat() < 0.5) this.remove();
			this.xd *= 0.7;
			this.zd *= 0.7;
		}
		if (this.level.belowSurface(this.x, this.y, this.z)) this.remove();
	}
}

/** ReversePortalParticle (respawn anchors, crying obsidian): a portal speck that rises and shrinks. */
class ReversePortalParticle extends PortalParticle {
	constructor(level, x, y, z, xd, yd, zd, sprite) {
		super(level, x, y, z, xd, yd, zd, sprite);
		this.quadSize *= 1.5;
		this.lifetime = Math.trunc(nextFloat() * 2) + 60;
	}

	quadSizeAt(a) {
		return this.quadSize * (1 - (this.age + a) / (this.lifetime * 1.5));
	}

	tick() {
		this.xo = this.x; this.yo = this.y; this.zo = this.z;
		if (this.age++ >= this.lifetime) {
			this.remove();
			return;
		}
		const speed = this.age / this.lifetime;
		this.x += this.xd * speed;
		this.y += this.yd * speed;
		this.z += this.zd * speed;
	}
}

/** BubbleParticle and BubbleColumnUpParticle: air bubbles that pop when they leave the water. */
class BubbleParticle extends QuadParticle {
	constructor(level, x, y, z, xa, ya, za, sprite, column) {
		super(level, x, y, z, undefined, undefined, undefined, sprite);
		if (column) {
			this.gravity = -0.125;
			this.friction = 0.85;
		}
		this.column = column;
		this.setSize(0.02, 0.02);
		this.quadSize *= nextFloat() * 0.6 + 0.2;
		this.xd = xa * 0.2 + (nextFloat() * 2 - 1) * 0.02;
		this.yd = ya * 0.2 + (nextFloat() * 2 - 1) * 0.02;
		this.zd = za * 0.2 + (nextFloat() * 2 - 1) * 0.02;
		this.lifetime = Math.trunc((column ? 40 : 8) / (nextFloat() * 0.8 + 0.2));
	}

	tick() {
		if (this.column) {
			super.tick();
		} else {
			this.xo = this.x; this.yo = this.y; this.zo = this.z;
			if (this.lifetime-- <= 0) {
				this.remove();
				return;
			}
			this.yd += 0.002;
			this.move(this.xd, this.yd, this.zd);
			this.xd *= 0.85; this.yd *= 0.85; this.zd *= 0.85;
		}
		if (!this.removed && !this.level.inWater(this.x, this.y, this.z)) this.remove();
	}
}

/** WaterCurrentDownParticle: whirlpool bubbles circling down a magma block's bubble column. */
class CurrentDownParticle extends QuadParticle {
	constructor(level, x, y, z, sprite) {
		super(level, x, y, z, undefined, undefined, undefined, sprite);
		this.lifetime = Math.trunc(nextFloat() * 60) + 30;
		this.hasPhysics = false;
		this.xd = 0; this.yd = -0.05; this.zd = 0;
		this.setSize(0.02, 0.02);
		this.quadSize *= nextFloat() * 0.6 + 0.2;
		this.gravity = 0.002;
		this.angle = 0;
	}

	tick() {
		this.xo = this.x; this.yo = this.y; this.zo = this.z;
		if (this.age++ >= this.lifetime) {
			this.remove();
			return;
		}
		this.xd = (this.xd + 0.6 * Math.cos(this.angle)) * 0.07;
		this.zd = (this.zd + 0.6 * Math.sin(this.angle)) * 0.07;
		this.move(this.xd, this.yd, this.zd);
		if (!this.level.inWater(this.x, this.y, this.z) || this.onGround) this.remove();
		this.angle += 0.08;
	}
}

class FireflyParticle extends QuadParticle {
	constructor(level, x, y, z, xa, ya, za, sprite) {
		super(level, x, y, z, xa, ya, za, sprite);
		this.speedUpWhenYMotionIsBlocked = true;
		this.friction = 0.96;
		this.quadSize *= 0.75;
		this.yd *= 0.8; this.xd *= 0.8; this.zd *= 0.8;
		this.translucent = true;
	}

	static fade(progress, fadeIn, fadeOut) {
		if (progress >= 1 - fadeIn) return (1 - progress) / fadeIn;
		return progress <= fadeOut ? progress / fadeOut : 1;
	}

	light(a) {
		const v = Math.trunc(255 * FireflyParticle.fade(clamp((this.age + a) / this.lifetime, 0, 1), 0.1, 0.3));
		// The packed light int is used as it is: block light in the low bits only.
		return [Math.min(240, v), 0];
	}

	tick() {
		super.tick();
		if (!this.level.isAir(this.x, this.y, this.z)) {
			this.remove();
			return;
		}
		this.alpha = FireflyParticle.fade(clamp(this.age / this.lifetime, 0, 1), 0.3, 0.5);
		if (nextFloat() > 0.95 || this.age === 1) {
			this.xd = -0.05 + 0.1 * nextFloat();
			this.yd = -0.05 + 0.1 * nextFloat();
			this.zd = -0.05 + 0.1 * nextFloat();
		}
	}
}

// --- ParticleResources: which class and settings each particle type uses ------------------------------

const REDSTONE = [1, 0, 0]; // DustParticleOptions.REDSTONE
const WATER_DRIP = [0.2, 0.3, 1];
const LAVA_DRIP = [1, 0.2857143, 0.083333336];
const TEAR = [0.51171875, 0.03125, 0.890625];

/** ExplodeParticle (poof): a puff that rises and slows down, its sprite following its age. */
class ExplodeParticle extends QuadParticle {
	constructor(level, x, y, z, xa, ya, za, sprites) {
		super(level, x, y, z, undefined, undefined, undefined, sprites.first());
		this.gravity = -0.1;
		this.friction = 0.9;
		this.sprites = sprites;
		this.xd = xa + (nextFloat() * 2 - 1) * 0.05;
		this.yd = ya + (nextFloat() * 2 - 1) * 0.05;
		this.zd = za + (nextFloat() * 2 - 1) * 0.05;
		const col = nextFloat() * 0.3 + 0.7;
		this.rCol = this.gCol = this.bCol = col;
		this.quadSize = 0.1 * (nextFloat() * nextFloat() * 6 + 1);
		this.lifetime = Math.trunc(16 / (nextFloat() * 0.8 + 0.2)) + 2;
		this.setSpriteFromAge(sprites);
	}

	tick() {
		super.tick();
		this.setSpriteFromAge(this.sprites);
	}
}

/** HugeExplosionParticle (explosion): a big flash that does not move, full bright. */
class HugeExplosionParticle extends QuadParticle {
	constructor(level, x, y, z, size, sprites) {
		super(level, x, y, z, 0, 0, 0, sprites.first());
		this.lifetime = 6 + nextInt(4);
		const col = nextFloat() * 0.6 + 0.4;
		this.rCol = this.gCol = this.bCol = col;
		this.quadSize = 2 * (1 - size * 0.5);
		this.sprites = sprites;
		this.setSpriteFromAge(sprites);
	}

	light() {
		return [240, 240];
	}

	tick() {
		this.xo = this.x; this.yo = this.y; this.zo = this.z;
		if (this.age++ >= this.lifetime) this.remove();
		else this.setSpriteFromAge(this.sprites);
	}
}

/** HugeExplosionSeedParticle (explosion_emitter): invisible, adds six explosions around it each tick for 8 ticks. */
class HugeExplosionSeedParticle extends Particle {
	constructor(level, x, y, z) {
		super(level, x, y, z, 0, 0, 0);
		this.lifetime = 8;
	}

	tick() {
		for (let i = 0; i < 6; i++) {
			const xx = this.x + (nextDouble() - nextDouble()) * 4;
			const yy = this.y + (nextDouble() - nextDouble()) * 4;
			const zz = this.z + (nextDouble() - nextDouble()) * 4;
			this.level.add('minecraft:explosion', xx, yy, zz, this.age / this.lifetime, 0, 0);
		}
		this.age++;
		if (this.age === this.lifetime) this.remove();
	}
}

/** HeartParticle (heart, angry_villager): pops up, grows in, floats without physics. */
class HeartParticle extends QuadParticle {
	constructor(level, x, y, z, sprite) {
		super(level, x, y, z, 0, 0, 0, sprite);
		this.speedUpWhenYMotionIsBlocked = true;
		this.friction = 0.86;
		this.xd *= 0.01; this.yd *= 0.01; this.zd *= 0.01;
		this.yd += 0.1;
		this.quadSize *= 1.5;
		this.lifetime = 16;
		this.hasPhysics = false;
	}

	quadSizeAt(a) {
		return this.quadSize * clamp((this.age + a) / this.lifetime * 32, 0, 1);
	}
}

/** SuspendedTownParticle (happy_villager, composter, mycelium, egg_crack, dolphin): a slow drifting speck. */
class SuspendedTownParticle extends QuadParticle {
	constructor(level, x, y, z, xa, ya, za, sprite) {
		super(level, x, y, z, xa, ya, za, sprite);
		const br = nextFloat() * 0.1 + 0.2;
		this.rCol = this.gCol = this.bCol = br;
		this.setSize(0.02, 0.02);
		this.quadSize *= nextFloat() * 0.6 + 0.5;
		this.xd *= 0.02; this.yd *= 0.02; this.zd *= 0.02;
		this.lifetime = Math.trunc(20 / (nextFloat() * 0.8 + 0.2));
	}

	move(xa, ya, za) {
		this.moveFree(xa, ya, za);
	}

	tick() {
		this.xo = this.x; this.yo = this.y; this.zo = this.z;
		if (this.lifetime-- <= 0) {
			this.remove();
			return;
		}
		this.move(this.xd, this.yd, this.zd);
		this.xd *= 0.99; this.yd *= 0.99; this.zd *= 0.99;
	}
}

/** CritParticle (crit, enchanted_hit, damage_indicator): sparks that fall and turn red. */
class CritParticle extends QuadParticle {
	constructor(level, x, y, z, xa, ya, za, sprite) {
		super(level, x, y, z, 0, 0, 0, sprite);
		this.friction = 0.7;
		this.gravity = 0.5;
		this.xd *= 0.1; this.yd *= 0.1; this.zd *= 0.1;
		this.xd += xa * 0.4; this.yd += ya * 0.4; this.zd += za * 0.4;
		const col = nextFloat() * 0.3 + 0.6;
		this.rCol = this.gCol = this.bCol = col;
		this.quadSize *= 0.75;
		this.lifetime = Math.max(Math.trunc(6 / (nextFloat() * 0.8 + 0.6)), 1);
		this.hasPhysics = false;
		this.tick();
	}

	quadSizeAt(a) {
		return this.quadSize * clamp((this.age + a) / this.lifetime * 32, 0, 1);
	}

	tick() {
		super.tick();
		this.gCol *= 0.96;
		this.bCol *= 0.9;
	}
}

/** SpellParticle (effect, instant_effect, entity_effect, witch, infested, omens): translucent swirls rising. */
class SpellParticle extends QuadParticle {
	constructor(level, x, y, z, xa, ya, za, sprites) {
		super(level, x, y, z, 0.5 - nextDouble(), ya, 0.5 - nextDouble(), sprites.first());
		this.friction = 0.96;
		this.gravity = -0.1;
		this.speedUpWhenYMotionIsBlocked = true;
		this.sprites = sprites;
		this.yd *= 0.2;
		if (xa === 0 && za === 0) {
			this.xd *= 0.1;
			this.zd *= 0.1;
		}
		this.quadSize *= 0.75;
		this.lifetime = Math.trunc(8 / (nextFloat() * 0.8 + 0.2));
		this.hasPhysics = false;
		this.translucent = true;
		this.originalAlpha = 1;
		this.setSpriteFromAge(sprites);
	}

	setAlpha(alpha) {
		this.alpha = alpha;
		this.originalAlpha = alpha;
	}

	/** SingleQuadParticle.setPower */
	setPower(power) {
		this.xd *= power;
		this.yd = (this.yd - 0.1) * power + 0.1;
		this.zd *= power;
	}

	tick() {
		super.tick();
		this.setSpriteFromAge(this.sprites);
		this.alpha = lerp(0.05, this.alpha, this.originalAlpha);
	}
}

/** NoteParticle: a note in the colour of its pitch. */
class NoteParticle extends QuadParticle {
	constructor(level, x, y, z, color, sprite) {
		super(level, x, y, z, 0, 0, 0, sprite);
		this.friction = 0.66;
		this.speedUpWhenYMotionIsBlocked = true;
		this.xd *= 0.01; this.yd *= 0.01; this.zd *= 0.01;
		this.yd += 0.2;
		const tau = Math.PI * 2;
		this.rCol = Math.max(0, Math.sin((color + 0) * tau) * 0.65 + 0.35);
		this.gCol = Math.max(0, Math.sin((color + 1 / 3) * tau) * 0.65 + 0.35);
		this.bCol = Math.max(0, Math.sin((color + 2 / 3) * tau) * 0.65 + 0.35);
		this.quadSize *= 1.5;
		this.lifetime = 6;
	}

	quadSizeAt(a) {
		return this.quadSize * clamp((this.age + a) / this.lifetime * 32, 0, 1);
	}
}

/** PlayerCloudParticle (cloud, sneeze): a translucent puff. */
class PlayerCloudParticle extends QuadParticle {
	constructor(level, x, y, z, xa, ya, za, sprites) {
		super(level, x, y, z, 0, 0, 0, sprites.first());
		this.friction = 0.96;
		this.sprites = sprites;
		this.xd = this.xd * 0.1 + xa;
		this.yd = this.yd * 0.1 + ya;
		this.zd = this.zd * 0.1 + za;
		const col = 1 - nextFloat() * 0.3;
		this.rCol = this.gCol = this.bCol = col;
		this.quadSize *= 1.875;
		const baseLifetime = Math.trunc(8 / (nextFloat() * 0.8 + 0.3));
		this.lifetime = Math.trunc(Math.max(baseLifetime * 2.5, 1));
		this.hasPhysics = false;
		this.translucent = true;
		this.setSpriteFromAge(sprites);
	}

	quadSizeAt(a) {
		return this.quadSize * clamp((this.age + a) / this.lifetime * 32, 0, 1);
	}

	tick() {
		super.tick();
		if (!this.removed) this.setSpriteFromAge(this.sprites);
	}
}

/** AttackSweepParticle (sweep_attack): the sword swing arc, full bright. */
class AttackSweepParticle extends QuadParticle {
	constructor(level, x, y, z, size, sprites) {
		super(level, x, y, z, 0, 0, 0, sprites.first());
		this.sprites = sprites;
		this.lifetime = 4;
		const col = nextFloat() * 0.6 + 0.4;
		this.rCol = this.gCol = this.bCol = col;
		this.quadSize = 1 - size * 0.5;
		this.setSpriteFromAge(sprites);
	}

	light() {
		return [240, 240];
	}

	tick() {
		this.xo = this.x; this.yo = this.y; this.zo = this.z;
		if (this.age++ >= this.lifetime) this.remove();
		else this.setSpriteFromAge(this.sprites);
	}
}

/**
 * TerrainParticle (block, block_crumble, dust_pillar and broken blocks): a quarter of the block's particle
 * texture from the block atlas, falling with gravity, shaded and tinted like the block.
 */
class TerrainParticle extends QuadParticle {
	constructor(level, x, y, z, xa, ya, za, block) {
		super(level, x, y, z, xa, ya, za, null);
		this.gravity = 1;
		this.rCol = this.gCol = this.bCol = 0.6;
		if (block.tint) {
			this.rCol *= block.tint[0];
			this.gCol *= block.tint[1];
			this.bCol *= block.tint[2];
		}
		this.quadSize /= 2;
		const uo = nextFloat() * 3, vo = nextFloat() * 3;
		const [u0, v0, u1, v1] = block.sprite;
		const u = f => u0 + (u1 - u0) * f, v = f => v0 + (v1 - v0) * f;
		// getU0 / getU1 swapped like the game: the piece is mirrored horizontally
		this.sprite = [u((uo + 1) / 4), v(vo / 4), u(uo / 4), v((vo + 1) / 4)];
		this.atlas = 'block';
	}
}

/** Particles drawn with the block atlas or not at all, which have no sprite set of their own. */
const NO_SPRITES = new Set(['block', 'block_crumble', 'dust_pillar', 'explosion_emitter']);
/** ParticleType.getOverrideLimiter: drawn however far from the camera. */
const OVERRIDE_LIMITER = new Set(['explosion', 'explosion_emitter', 'elder_guardian', 'sonic_boom', 'gust', 'gust_emitter_large', 'gust_emitter_small']);
/** BlockBehaviour.Properties.noTerrainParticles and the moving piston: no pieces when broken. */
const NO_TERRAIN_PARTICLES = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:barrier', 'minecraft:light',
	'minecraft:structure_void', 'minecraft:moving_piston']);

const PROVIDERS = {
	flame: (l, x, y, z, xa, ya, za, s) => new FlameParticle(l, x, y, z, xa, ya, za, s.random()),
	soul_fire_flame: (l, x, y, z, xa, ya, za, s) => new FlameParticle(l, x, y, z, xa, ya, za, s.random()),
	copper_fire_flame: (l, x, y, z, xa, ya, za, s) => new FlameParticle(l, x, y, z, xa, ya, za, s.random()),
	small_flame: (l, x, y, z, xa, ya, za, s) => new FlameParticle(l, x, y, z, xa, ya, za, s.random()).scale(0.5),
	smoke: (l, x, y, z, xa, ya, za, s) => new SmokeParticle(l, x, y, z, xa, ya, za, 1, s),
	large_smoke: (l, x, y, z, xa, ya, za, s) => new SmokeParticle(l, x, y, z, xa, ya, za, 2.5, s),
	lava: (l, x, y, z, xa, ya, za, s) => new LavaParticle(l, x, y, z, s.random()),
	campfire_cosy_smoke: (l, x, y, z, xa, ya, za, s) => Object.assign(new CampfireSmokeParticle(l, x, y, z, xa, ya, za, false, s.random()), { alpha: 0.9 }),
	campfire_signal_smoke: (l, x, y, z, xa, ya, za, s) => Object.assign(new CampfireSmokeParticle(l, x, y, z, xa, ya, za, true, s.random()), { alpha: 0.95 }),
	dripping_water: (l, x, y, z, xa, ya, za, s) => tint(new HangingDrip(l, x, y, z, 'water', 'minecraft:falling_water', s.random()), WATER_DRIP),
	falling_water: (l, x, y, z, xa, ya, za, s) => tint(fallLand(new DripParticle(l, x, y, z, 'water', s.random()), 'minecraft:splash'), WATER_DRIP),
	dripping_lava: (l, x, y, z, xa, ya, za, s) => new HangingDrip(l, x, y, z, 'lava', 'minecraft:falling_lava', s.random(), true),
	falling_lava: (l, x, y, z, xa, ya, za, s) => tint(fallLand(new DripParticle(l, x, y, z, 'lava', s.random()), 'minecraft:landing_lava'), LAVA_DRIP),
	landing_lava: (l, x, y, z, xa, ya, za, s) => tint(landing(new DripParticle(l, x, y, z, 'lava', s.random())), LAVA_DRIP),
	dripping_obsidian_tear: (l, x, y, z, xa, ya, za, s) => glow(tint(new HangingDrip(l, x, y, z, null, 'minecraft:falling_obsidian_tear', s.random()), TEAR)),
	falling_obsidian_tear: (l, x, y, z, xa, ya, za, s) => glow(tint(fallLand(new DripParticle(l, x, y, z, null, s.random()), 'minecraft:landing_obsidian_tear'), TEAR)),
	landing_obsidian_tear: (l, x, y, z, xa, ya, za, s) => {
		const p = glow(tint(landing(new DripParticle(l, x, y, z, null, s.random())), TEAR));
		p.lifetime = Math.trunc(28 / (nextFloat() * 0.8 + 0.2));
		return p;
	},
	// pointed dripstone and full beehives (DripParticle providers)
	dripping_dripstone_water: (l, x, y, z, xa, ya, za, s) => tint(new HangingDrip(l, x, y, z, 'water', 'minecraft:falling_dripstone_water', s.random()), [0.2, 0.3, 1]),
	falling_dripstone_water: (l, x, y, z, xa, ya, za, s) => {
		const p = tint(fallLand(new DripParticle(l, x, y, z, 'water', s.random()), 'minecraft:splash'), [0.2, 0.3, 1]);
		p.landSound = 'minecraft:block.pointed_dripstone.drip_water';
		return p;
	},
	dripping_dripstone_lava: (l, x, y, z, xa, ya, za, s) => new HangingDrip(l, x, y, z, 'lava', 'minecraft:falling_dripstone_lava', s.random(), true),
	falling_dripstone_lava: (l, x, y, z, xa, ya, za, s) => {
		const p = tint(fallLand(new DripParticle(l, x, y, z, 'lava', s.random()), 'minecraft:landing_lava'), [1, 0.2857143, 0.083333336]);
		p.landSound = 'minecraft:block.pointed_dripstone.drip_lava';
		return p;
	},
	dripping_honey: (l, x, y, z, xa, ya, za, s) => {
		const p = tint(new HangingDrip(l, x, y, z, null, 'minecraft:falling_honey', s.random()), [0.622, 0.508, 0.082]);
		p.gravity *= 0.01;
		p.lifetime = 100;
		return p;
	},
	falling_honey: (l, x, y, z, xa, ya, za, s) => {
		const p = tint(fallLand(new DripParticle(l, x, y, z, null, s.random()), 'minecraft:landing_honey'), [0.582, 0.448, 0.082]);
		p.gravity = 0.01;
		p.landSound = 'minecraft:block.beehive.drip';
		return p;
	},
	landing_honey: (l, x, y, z, xa, ya, za, s) => {
		const p = tint(landing(new DripParticle(l, x, y, z, null, s.random())), [0.522, 0.408, 0.082]);
		p.lifetime = Math.trunc(128 / (nextFloat() * 0.8 + 0.2));
		return p;
	},
	falling_spore_blossom: (l, x, y, z, xa, ya, za, s) => {
		const p = tint(new DripParticle(l, x, y, z, null, s.random()), [0.32, 0.5, 0.22]);
		p.kind = 'fall';
		p.lifetime = Math.trunc(64 / lerp(nextFloat(), 0.1, 0.9));
		p.gravity = 0.005;
		return p;
	},
	spore_blossom_air: (l, x, y, z, xa, ya, za, s) => {
		const p = tint(new SuspendedParticle(l, x, y, z, 0, -0.8, 0, s.random()), [0.32, 0.5, 0.22]);
		p.lifetime = 500 + nextInt(501);
		p.gravity = 0.01;
		return p;
	},
	portal: (l, x, y, z, xa, ya, za, s) => new PortalParticle(l, x, y, z, xa, ya, za, s.random()),
	reverse_portal: (l, x, y, z, xa, ya, za, s) => new ReversePortalParticle(l, x, y, z, xa, ya, za, s.random()),
	bubble: (l, x, y, z, xa, ya, za, s) => new BubbleParticle(l, x, y, z, xa, ya, za, s.random(), false),
	bubble_column_up: (l, x, y, z, xa, ya, za, s) => new BubbleParticle(l, x, y, z, xa, ya, za, s.random(), true),
	current_down: (l, x, y, z, xa, ya, za, s) => new CurrentDownParticle(l, x, y, z, s.random()),
	// WhiteSmokeParticle: BaseAshSmokeParticle like smoke, in a fixed pale colour
	white_smoke: (l, x, y, z, xa, ya, za, s) => {
		const p = new SmokeParticle(l, x, y, z, xa, ya, za, 1, s);
		p.setColor(0.7294118, 0.69411767, 0.7607843);
		return p;
	},
	end_rod: (l, x, y, z, xa, ya, za, s) => new EndRodParticle(l, x, y, z, xa, ya, za, s),
	dust: (l, x, y, z, xa, ya, za, s, options) => new DustParticle(l, x, y, z, xa, ya, za, (options && options.color) || REDSTONE, (options && options.scale) || 1, s),
	rain: (l, x, y, z, xa, ya, za, s) => new WaterDropParticle(l, x, y, z, s.random()),
	splash: (l, x, y, z, xa, ya, za, s) => {
		const p = new WaterDropParticle(l, x, y, z, s.random());
		p.gravity = 0.04;
		if (ya === 0 && (xa !== 0 || za !== 0)) { p.xd = xa; p.yd = 0.1; p.zd = za; }
		return p;
	},
	firefly: (l, x, y, z, xa, ya, za, s) => {
		const p = new FireflyParticle(l, x, y, z, 0.5 - nextDouble(), nextBoolean() ? ya : -ya, 0.5 - nextDouble(), s.random());
		p.lifetime = 200 + nextInt(101);
		p.scale(1.5);
		p.alpha = 0;
		return p;
	},
	cherry_leaves: (l, x, y, z, xa, ya, za, s) => new FallingLeafParticle(l, x, y, z, s.random(), 0.25, 2, false, true, 1, 0),
	pale_oak_leaves: (l, x, y, z, xa, ya, za, s) => new FallingLeafParticle(l, x, y, z, s.random(), 0.07, 10, true, false, 2, 0.021),
	red_poplar_leaves: (l, x, y, z, xa, ya, za, s) => new FallingLeafParticle(l, x, y, z, s.random(), 0.07, 10, true, false, 2, 0.021),
	orange_poplar_leaves: (l, x, y, z, xa, ya, za, s) => new FallingLeafParticle(l, x, y, z, s.random(), 0.07, 10, true, false, 2, 0.021),
	yellow_poplar_leaves: (l, x, y, z, xa, ya, za, s) => new FallingLeafParticle(l, x, y, z, s.random(), 0.07, 10, true, false, 2, 0.021),
	// the particles the server sends and the client makes from events (ParticleResources)
	poof: (l, x, y, z, xa, ya, za, s) => new ExplodeParticle(l, x, y, z, xa, ya, za, s),
	explosion: (l, x, y, z, xa, ya, za, s) => new HugeExplosionParticle(l, x, y, z, xa, s),
	explosion_emitter: (l, x, y, z) => new HugeExplosionSeedParticle(l, x, y, z),
	heart: (l, x, y, z, xa, ya, za, s) => new HeartParticle(l, x, y, z, s.random()),
	angry_villager: (l, x, y, z, xa, ya, za, s) => tint(new HeartParticle(l, x, y + 0.5, z, s.random()), [1, 1, 1]),
	happy_villager: (l, x, y, z, xa, ya, za, s) => tint(new SuspendedTownParticle(l, x, y, z, xa, ya, za, s.random()), [1, 1, 1]),
	egg_crack: (l, x, y, z, xa, ya, za, s) => tint(new SuspendedTownParticle(l, x, y, z, xa, ya, za, s.random()), [1, 1, 1]),
	mycelium: (l, x, y, z, xa, ya, za, s) => new SuspendedTownParticle(l, x, y, z, xa, ya, za, s.random()),
	composter: (l, x, y, z, xa, ya, za, s) => {
		const p = tint(new SuspendedTownParticle(l, x, y, z, xa, ya, za, s.random()), [1, 1, 1]);
		p.lifetime = 3 + nextInt(5);
		return p;
	},
	dolphin: (l, x, y, z, xa, ya, za, s) => {
		const p = tint(new SuspendedTownParticle(l, x, y, z, xa, ya, za, s.random()), [0.3, 0.5, 1]);
		p.alpha = 1 - nextFloat() * 0.7;
		p.lifetime = Math.trunc(p.lifetime / 2);
		return p;
	},
	crit: (l, x, y, z, xa, ya, za, s) => new CritParticle(l, x, y, z, xa, ya, za, s.random()),
	enchanted_hit: (l, x, y, z, xa, ya, za, s) => {
		const p = new CritParticle(l, x, y, z, xa, ya, za, s.random());
		p.rCol *= 0.3;
		p.gCol *= 0.8;
		return p;
	},
	damage_indicator: (l, x, y, z, xa, ya, za, s) => Object.assign(new CritParticle(l, x, y, z, xa, ya + 1, za, s.random()), { lifetime: 20 }),
	effect: (l, x, y, z, xa, ya, za, s, o) => spell(new SpellParticle(l, x, y, z, xa, ya, za, s), o, true),
	instant_effect: (l, x, y, z, xa, ya, za, s, o) => spell(new SpellParticle(l, x, y, z, xa, ya, za, s), o, true),
	entity_effect: (l, x, y, z, xa, ya, za, s, o) => spell(new SpellParticle(l, x, y, z, xa, ya, za, s), o, false),
	witch: (l, x, y, z, xa, ya, za, s) => {
		const b = nextFloat() * 0.5 + 0.35;
		return tint(new SpellParticle(l, x, y, z, xa, ya, za, s), [b, 0, b]);
	},
	infested: (l, x, y, z, xa, ya, za, s) => new SpellParticle(l, x, y, z, xa, ya, za, s),
	raid_omen: (l, x, y, z, xa, ya, za, s) => new SpellParticle(l, x, y, z, xa, ya, za, s),
	trial_omen: (l, x, y, z, xa, ya, za, s) => new SpellParticle(l, x, y, z, xa, ya, za, s),
	note: (l, x, y, z, xa, ya, za, s) => new NoteParticle(l, x, y, z, xa, s.random()),
	cloud: (l, x, y, z, xa, ya, za, s) => new PlayerCloudParticle(l, x, y, z, xa, ya, za, s),
	sweep_attack: (l, x, y, z, xa, ya, za, s) => new AttackSweepParticle(l, x, y, z, xa, s),
	block: (l, x, y, z, xa, ya, za, s, o) => terrain(l, x, y, z, xa, ya, za, o),
	block_crumble: (l, x, y, z, xa, ya, za, s, o) => {
		const p = terrain(l, x, y, z, xa, ya, za, o);
		if (p) {
			p.xd = p.yd = p.zd = 0;
			p.lifetime = nextInt(10) + 1;
		}
		return p;
	},
	dust_pillar: (l, x, y, z, xa, ya, za, s, o) => {
		const p = terrain(l, x, y, z, xa, ya, za, o);
		if (p) {
			p.xd = nextGaussian() / 30;
			p.yd = ya + nextGaussian() / 2;
			p.zd = nextGaussian() / 30;
			p.lifetime = nextInt(20) + 20;
		}
		return p;
	},
	tinted_leaves: (l, x, y, z, xa, ya, za, s, options) => {
		const p = new FallingLeafParticle(l, x, y, z, s.random(), 0.07, 10, true, false, 2, 0.021);
		if (options && options.color) p.setColor(...options.color);
		return p;
	},
};

/** The providers of coloured spells: SpellParticle.InstantProvider (colour and power) and MobEffectProvider (colour and alpha). */
function spell(p, options, instant) {
	if (options && options.rgb) {
		p.setColor(options.rgb[0], options.rgb[1], options.rgb[2]);
		if (instant) {
			if (options.power !== undefined) p.setPower(options.power);
		} else if (options.alpha !== undefined) {
			p.setAlpha(options.alpha);
		}
	}
	return p;
}

/** TerrainParticle.createTerrainParticle: nothing for air and blocks without terrain particles. */
function terrain(level, x, y, z, xa, ya, za, options) {
	const block = options && options.b !== undefined ? level.terrainBlock(options.b, x, y, z) : null;
	return block ? new TerrainParticle(level, x, y, z, xa, ya, za, block) : null;
}

function tint(p, color) {
	p.setColor(color[0], color[1], color[2]);
	return p;
}
function glow(p) {
	p.glowing = true;
	return p;
}
function fallLand(p, land) {
	p.kind = 'fallLand';
	p.land = land;
	p.lifetime = Math.trunc(64 / (nextFloat() * 0.8 + 0.2));
	return p;
}
function landing(p) {
	p.kind = 'land';
	p.lifetime = Math.trunc(16 / (nextFloat() * 0.8 + 0.2));
	return p;
}

// --- animateTick of blocks and fluids ---------------------------------------------------------------------

const props = info => {
	if (!info || !info.s) return {};
	if (!info.props) info.props = Object.fromEntries(info.s.split(',').map(p => p.split('=')));
	return info.props;
};
const blockName = info => (info && info.n ? info.n.replace(/^minecraft:/, '') : '');

/** The game's default weather radius and ClientLevel.RAIN_PARTICLES_PER_BLOCK. */
const WEATHER_RADIUS = 10;
const RAIN_PARTICLES_PER_BLOCK = 0.225;

/** The weather column at a block: {height (motion blocking height map), type ('r' rain, 's' snow, 'n')} or null. */
function weatherColumn(columns, x, z) {
	if (!columns) return null;
	const cx = x - columns.x, cz = z - columns.z;
	if (cx < 0 || cz < 0 || cx >= columns.size || cz >= columns.size) return null;
	const k = cz * columns.size + cx;
	return { height: columns.h[k], type: columns.p[k] };
}
/** Block.isFaceSturdy for the face towards a direction, approximated by a full collision box. */
const sturdy = info => !!(info && info.f & FLAG_FULL_COLLISION);
const isAir = info => !info || !!(info.f & FLAG_AIR);
/** BlockState.is(tag) for the tags the server lists with the block (BlockPalette.viewerTags). */
const hasTag = (info, tag) => !!(info && info.tg && info.tg.includes(tag));

/**
 * PointedDripstoneBlock.getFluidAboveStalactite: 'water', 'lava' or 'none' for the block above the stalactite's
 * root (up to 10 dripstones up; mud drips water unless water evaporates there), null without a root.
 */
function dripstoneFluid(level, x, y, z) {
	for (let i = 1; i < 11; i++) {
		const at = level.info(x, y + i, z);
		if (blockName(at) === 'pointed_dripstone') {
			if (props(at).vertical_direction !== 'down') return null;
			continue;
		}
		if (blockName(at) === 'mud' && !level.attribute('evaporates')) return 'water';
		if (at && at.f & FLAG_LAVA) return 'lava';
		if (at && at.f & FLAG_WATER) return 'water';
		return 'none';
	}
	return null;
}

/** BlockState.getOffset in x and z (like the mesher: from the position's seed, within the block's limit). */
function blockOffset(info, x, z) {
	if (!info || !info.o) return [0, 0];
	const low = positionSeed(x, 0, z)[1];
	const max = info.o[0];
	return [Math.min(max, Math.max(-max, ((low & 15) / 15 - 0.5) * 0.5)), Math.min(max, Math.max(-max, ((low >>> 8 & 15) / 15 - 0.5) * 0.5))];
}

/** AmbientDesertBlockSoundsPlayer.shouldPlayDesertDryVegetationBlockSounds: two soil blocks under the plant. */
const dryVegetationSoil = (level, x, y, z) => hasTag(level.info(x, y, z), 'minecraft:triggers_ambient_desert_dry_vegetation_block_sounds')
	&& hasTag(level.info(x, y - 1, z), 'minecraft:triggers_ambient_desert_dry_vegetation_block_sounds');

/** The top non-air block of a column near y (the WORLD_SURFACE height map minus one), or null. */
function surfaceNear(level, x, y, z, range) {
	for (let sy = y + range; sy >= y - range; sy--) if (!isAir(level.info(x, sy, z))) return sy;
	return null;
}

/** AmbientDesertBlockSoundsPlayer.shouldPlayAmbientSandSound: desert sand in at least three directions 8 blocks away. */
function desertAround(level, x, y, z) {
	const sand = info => hasTag(info, 'minecraft:triggers_ambient_desert_sand_block_sounds');
	const column = (cx, cz) => {
		const surface = surfaceNear(level, cx, y, cz, 48);
		if (surface === null || Math.abs(surface - y) > 5) {
			let above = level.info(cx, y + 6, cz);
			for (let i = 0, cy = y + 5; i < 10; i++, cy--) {
				const current = level.info(cx, cy, cz);
				if (isAir(above) && sand(current)) return true;
				above = current;
			}
			return false;
		}
		return isAir(level.info(cx, surface + 1, cz)) && sand(level.info(cx, surface, cz));
	};
	let found = 0, checked = 0;
	for (const d of [DIRS.north, DIRS.east, DIRS.south, DIRS.west]) {
		if (column(x + d[0] * 8, z + d[2] * 8) && found++ >= 3) return true;
		checked++;
		if (4 - checked + found < 3) return false;
	}
	return false;
}

/** The MOTION_BLOCKING (or MOTION_BLOCKING_NO_LEAVES) height map is at or below the block: nothing above it. */
function openAbove(level, x, y, z, ignoreLeaves) {
	for (let sy = y + 1; sy <= y + 64; sy++) {
		const at = level.info(x, sy, z);
		if (!at) return true;
		if (isAir(at)) continue;
		const blocks = !(at.f & FLAG_NO_COLLISION) || at.f & (FLAG_WATER | FLAG_LAVA);
		if (blocks && !(ignoreLeaves && at.lp)) return false;
	}
	return true;
}

const CANDLE_OFFSETS = {
	1: [[8, 8, 8]], 2: [[6, 7, 8], [10, 8, 7]], 3: [[8, 5, 10], [6, 7, 8], [9, 8, 7]], 4: [[7, 5, 9], [10, 7, 9], [6, 7, 6], [9, 8, 6]],
};

function torchFlame(name) {
	if (name.startsWith('soul_')) return 'minecraft:soul_fire_flame';
	if (name.startsWith('copper_')) return 'minecraft:copper_fire_flame';
	return 'minecraft:flame';
}

/** Block.animateTick ports, by block name (without namespace). */
function animateBlock(level, name, info, x, y, z) {
	const p = props(info);
	if (name === 'torch' || name === 'soul_torch' || name === 'copper_torch') {
		// TorchBlock
		level.add('minecraft:smoke', x + 0.5, y + 0.7, z + 0.5, 0, 0, 0);
		level.add(torchFlame(name), x + 0.5, y + 0.7, z + 0.5, 0, 0, 0);
	} else if (name === 'wall_torch' || name === 'soul_wall_torch' || name === 'copper_wall_torch') {
		// WallTorchBlock
		const o = DIRS[OPPOSITE[p.facing] || 'north'];
		const px = x + 0.5 + 0.27 * o[0], py = y + 0.7 + 0.22, pz = z + 0.5 + 0.27 * o[2];
		level.add('minecraft:smoke', px, py, pz, 0, 0, 0);
		level.add(torchFlame(name), px, py, pz, 0, 0, 0);
	} else if (name === 'redstone_torch' && p.lit === 'true') {
		level.add('minecraft:dust', x + 0.5 + (nextDouble() - 0.5) * 0.2, y + 0.7 + (nextDouble() - 0.5) * 0.2, z + 0.5 + (nextDouble() - 0.5) * 0.2, 0, 0, 0);
	} else if (name === 'redstone_wall_torch' && p.lit === 'true') {
		const o = DIRS[OPPOSITE[p.facing] || 'north'];
		level.add('minecraft:dust', x + 0.5 + (nextDouble() - 0.5) * 0.2 + 0.27 * o[0], y + 0.7 + (nextDouble() - 0.5) * 0.2 + 0.22,
			z + 0.5 + (nextDouble() - 0.5) * 0.2 + 0.27 * o[2], 0, 0, 0);
	} else if ((name === 'candle' || name.endsWith('_candle')) && p.lit === 'true') {
		for (const [ox, oy, oz] of CANDLE_OFFSETS[p.candles] || CANDLE_OFFSETS[1]) candleFlame(level, x + ox / 16, y + oy / 16, z + oz / 16);
	} else if (name.endsWith('candle_cake') && p.lit === 'true') {
		candleFlame(level, x + 0.5, y + 1, z + 0.5);
	} else if ((name === 'campfire' || name === 'soul_campfire') && p.lit === 'true') {
		// CampfireBlock.animateTick: the crackle, and lava pops only from the normal campfire
		if (nextInt(10) === 0) {
			level.sound('minecraft:block.campfire.crackle', x + 0.5, y + 0.5, z + 0.5, 'block', 0.5 + nextFloat(), nextFloat() * 0.7 + 0.6);
		}
		if (name === 'campfire' && nextInt(5) === 0) {
			for (let i = 0; i < nextInt(1) + 1; i++) level.add('minecraft:lava', x + 0.5, y + 0.5, z + 0.5, nextFloat() / 2, 5.0e-5, nextFloat() / 2);
		}
	} else if (name === 'fire' || name === 'soul_fire') {
		if (nextInt(24) === 0) level.sound('minecraft:block.fire.ambient', x + 0.5, y + 0.5, z + 0.5, 'block', 1 + nextFloat(), nextFloat() * 0.7 + 0.3);
		fireSmoke(level, name, x, y, z);
	} else if ((name === 'furnace' || name === 'blast_furnace' || name === 'smoker') && p.lit === 'true') {
		if (nextDouble() < 0.1) {
			const crackle = { furnace: 'block.furnace.fire_crackle', blast_furnace: 'block.blastfurnace.fire_crackle', smoker: 'block.smoker.smoke' }[name];
			level.sound('minecraft:' + crackle, x + 0.5, y, z + 0.5, 'block', 1, 1);
		}
		if (name === 'smoker') {
			level.add('minecraft:smoke', x + 0.5, y + 1.1, z + 0.5, 0, 0, 0);
		} else {
			// FurnaceBlock / BlastFurnaceBlock: smoke (and flame) at the front
			const d = DIRS[p.facing] || DIRS.north;
			const ss = nextDouble() * 0.6 - 0.3;
			const dx = d[0] !== 0 ? d[0] * 0.52 : ss;
			const dy = nextDouble() * (name === 'furnace' ? 6 : 9) / 16;
			const dz = d[2] !== 0 ? d[2] * 0.52 : ss;
			level.add('minecraft:smoke', x + 0.5 + dx, y + dy, z + 0.5 + dz, 0, 0, 0);
			if (name === 'furnace') level.add('minecraft:flame', x + 0.5 + dx, y + dy, z + 0.5 + dz, 0, 0, 0);
		}
	} else if (name === 'end_rod') {
		const d = DIRS[p.facing] || DIRS.up;
		const px = x + 0.55 - nextFloat() * 0.1, py = y + 0.55 - nextFloat() * 0.1, pz = z + 0.55 - nextFloat() * 0.1;
		const r = 0.4 - (nextFloat() + nextFloat()) * 0.4;
		if (nextInt(5) === 0) {
			level.add('minecraft:end_rod', px + d[0] * r, py + d[1] * r, pz + d[2] * r, nextGaussian() * 0.005, nextGaussian() * 0.005, nextGaussian() * 0.005);
		}
	} else if (name === 'nether_portal') {
		// NetherPortalBlock
		if (nextInt(100) === 0) level.sound('minecraft:block.portal.ambient', x + 0.5, y + 0.5, z + 0.5, 'block', 0.5, nextFloat() * 0.4 + 0.8);
		for (let i = 0; i < 4; i++) {
			let px = x + nextDouble(), pz = z + nextDouble();
			const py = y + nextDouble();
			let xa = (nextFloat() - 0.5) * 0.5, za = (nextFloat() - 0.5) * 0.5;
			const ya = (nextFloat() - 0.5) * 0.5;
			const flip = nextInt(2) * 2 - 1;
			const alongX = blockName(level.info(x - 1, y, z)) === 'nether_portal' || blockName(level.info(x + 1, y, z)) === 'nether_portal';
			if (!alongX) { px = x + 0.5 + 0.25 * flip; xa = nextFloat() * 2 * flip; } else { pz = z + 0.5 + 0.25 * flip; za = nextFloat() * 2 * flip; }
			level.add('minecraft:portal', px, py, pz, xa, ya, za);
		}
	} else if (name === 'spore_blossom') {
		level.add('minecraft:falling_spore_blossom', x + nextDouble(), y + 0.7, z + nextDouble(), 0, 0, 0);
		for (let i = 0; i < 14; i++) {
			const ax = x + nextInt(21) - 10, ay = y - nextInt(10), az = z + nextInt(21) - 10;
			const at = level.info(ax, ay, az);
			if (!(at && at.f & FLAG_FULL_COLLISION)) level.add('minecraft:spore_blossom_air', ax + nextDouble(), ay + nextDouble(), az + nextDouble(), 0, 0, 0);
		}
	} else if (name === 'crying_obsidian') {
		if (nextInt(5) === 0) {
			const names = Object.keys(DIRS);
			const dirName = names[nextInt(6)];
			if (dirName !== 'up') {
				const d = DIRS[dirName];
				if (!sturdy(level.info(x + d[0], y + d[1], z + d[2]))) {
					const ox = d[0] === 0 ? nextDouble() : 0.5 + d[0] * 0.6;
					const oy = d[1] === 0 ? nextDouble() : 0.5 + d[1] * 0.6;
					const oz = d[2] === 0 ? nextDouble() : 0.5 + d[2] * 0.6;
					level.add('minecraft:dripping_obsidian_tear', x + ox, y + oy, z + oz, 0, 0, 0);
				}
			}
		}
	} else if (name === 'firefly_bush') {
		// FireflyBushBlock: chirps at night under the open sky (leaves do not count)
		if (nextInt(30) === 0 && level.attribute('fireflies') && openAbove(level, x, y, z, true)) {
			level.sound('minecraft:block.firefly_bush.idle', x, y, z, 'ambient', 1, 1);
		}
		if (level.maxLight(x, y, z) <= 13 && nextDouble() <= 0.7) {
			level.add('minecraft:firefly', x + nextDouble() * 10 - 5, y + nextDouble() * 5, z + nextDouble() * 10 - 5, 0, 0, 0);
		}
	} else if (name === 'sand' || name === 'red_sand') {
		// SandBlock: AmbientDesertBlockSoundsPlayer.playAmbientSandSounds
		if (isAir(level.info(x, y + 1, z)) && nextInt(2100) === 0 && desertAround(level, x, y, z)) {
			level.sound('minecraft:block.sand.idle', x, y, z, 'ambient', 1, 1);
		}
	} else if (name === 'short_dry_grass' || name === 'tall_dry_grass') {
		// playAmbientDryGrassSounds: heard at the player
		if (nextInt(200) === 0 && dryVegetationSoil(level, x, y - 1, z)) level.soundAtListener('minecraft:block.dry_grass.ambient', 'ambient', 1, 1);
	} else if (name === 'dead_bush') {
		// DryVegetationBlock: playAmbientDeadBushSounds (less often on badlands soil)
		if (nextInt(130) === 0) {
			const below = level.info(x, y - 1, z);
			if (!((blockName(below) === 'red_sand' || hasTag(below, 'minecraft:terracotta')) && nextInt(3) !== 0) && dryVegetationSoil(level, x, y - 1, z)) {
				level.sound('minecraft:block.deadbush.idle', x, y, z, 'ambient', 1, 1);
			}
		}
	} else if (name === 'pale_hanging_moss') {
		if (nextInt(500) === 0) {
			const above = level.info(x, y + 1, z);
			if (hasTag(above, 'minecraft:pale_oak_logs') || blockName(above) === 'pale_oak_leaves') {
				level.sound('minecraft:block.pale_hanging_moss.idle', x, y, z, 'ambient', 1, 1);
			}
		}
	} else if (name === 'open_eyeblossom') {
		if (nextInt(700) === 0 && blockName(level.info(x, y - 1, z)) === 'pale_moss_block') {
			level.sound('minecraft:block.eyeblossom.idle', x, y, z, 'ambient', 1, 1);
		}
	} else if (name === 'creaking_heart') {
		// CreakingHeartBlock: creaks at night when logs surround it on all sides
		if (level.attribute('creaking') && p.creaking_heart_state !== 'uprooted' && nextInt(16) === 0
			&& Object.values(DIRS).every(d => hasTag(level.info(x + d[0], y + d[1], z + d[2]), 'minecraft:pale_oak_logs'))) {
			level.sound('minecraft:block.creaking_heart.idle', x, y, z, 'block', 1, 1);
		}
	} else if (name === 'dried_ghast') {
		const cx = x + 0.5, cy = y + 0.5, cz = z + 0.5;
		if (p.waterlogged !== 'true') {
			if (nextInt(40) === 0 && hasTag(level.info(x, y - 1, z), 'minecraft:triggers_ambient_dried_ghast_block_sounds')) {
				level.sound('minecraft:block.dried_ghast.ambient', cx, cy, cz, 'block', 1, 1);
			}
			if (nextInt(6) === 0) level.add('minecraft:white_smoke', cx, cy, cz, 0, 0.02, 0);
		} else {
			if (nextInt(40) === 0) level.sound('minecraft:block.dried_ghast.ambient_water', cx, cy, cz, 'block', 1, 1);
			if (nextInt(6) === 0) {
				level.add('minecraft:happy_villager', cx + (nextFloat() * 2 - 1) / 3, cy + 0.4, cz + (nextFloat() * 2 - 1) / 3, 0, nextFloat(), 0);
			}
		}
	} else if (name === 'respawn_anchor') {
		if (p.charges !== undefined && p.charges !== '0') {
			if (nextInt(100) === 0) level.sound('minecraft:block.respawn_anchor.ambient', x + 0.5, y + 0.5, z + 0.5, 'block', 1, 1);
			level.add('minecraft:reverse_portal', x + 0.5 + (0.5 - nextDouble()), y + 1, z + 0.5 + (0.5 - nextDouble()), 0, nextFloat() * 0.04, 0);
		}
	} else if (name === 'bubble_column') {
		if (p.drag === 'true') {
			level.add('minecraft:current_down', x + 0.5, y + 0.8, z, 0, 0, 0);
			if (nextInt(200) === 0) {
				level.sound('minecraft:block.bubble_column.whirlpool_ambient', x, y, z, 'block', 0.2 + nextFloat() * 0.2, 0.9 + nextFloat() * 0.15);
			}
		} else {
			level.add('minecraft:bubble_column_up', x + 0.5, y, z + 0.5, 0, 0.04, 0);
			level.add('minecraft:bubble_column_up', x + nextFloat(), y + nextFloat(), z + nextFloat(), 0, 0.04, 0);
			if (nextInt(200) === 0) {
				level.sound('minecraft:block.bubble_column.upwards_ambient', x, y, z, 'block', 0.2 + nextFloat() * 0.2, 0.9 + nextFloat() * 0.15);
			}
		}
	} else if (name === 'pointed_dripstone') {
		// PointedDripstoneBlock.animateTick: a free hanging tip drips what is above its root
		if (p.vertical_direction === 'down' && p.thickness === 'tip' && p.waterlogged !== 'true') {
			const r = nextFloat();
			if (r <= 0.12) {
				const fluid = dripstoneFluid(level, x, y, z);
				if (fluid !== null && (r < 0.02 || fluid !== 'none')) {
					const particle = fluid === 'lava' ? 'minecraft:dripping_dripstone_lava' : fluid === 'water' ? 'minecraft:dripping_dripstone_water'
						: level.attribute('drip') || 'minecraft:dripping_dripstone_water';
					const [ox, oz] = blockOffset(info, x, z);
					level.add(particle, x + 0.5 + ox, y + 0.3125 - 0.0625, z + 0.5 + oz, 0, 0, 0);
				}
			}
		}
	} else if ((name === 'beehive' || name === 'bee_nest') && Number(p.honey_level) >= 5) {
		// BeehiveBlock.trySpawnDripParticles: honey drips from under a full hive
		if (nextFloat() >= 0.3) {
			const below = level.info(x, y - 1, z);
			const belowTop = below && !(below.f & FLAG_NO_COLLISION) ? (below.b || []).reduce((m, b) => Math.max(m, b[4]), 0) : 0;
			if ((belowTop < 1 || !(below.f & FLAG_FULL_COLLISION)) && !(below && below.f & (FLAG_WATER | FLAG_LAVA))) {
				level.add('minecraft:dripping_honey', x + nextDouble(), y - 0.05, z + nextDouble(), 0, 0, 0);
			}
		}
	} else if (name === 'potent_sulfur') {
		// PotentSulfurBlock: bubbles and noxious gas under a water source
		const above = level.info(x, y + 1, z);
		if (!Object.values(p).includes('dry') && above && above.f & FLAG_WATER && !(above.lv > 0 && above.lv < 8)) {
			for (let i = 0; i < 2; i++) level.add('minecraft:sulfur_bubbles', x + nextFloat(), y + 1 + nextFloat(), z + nextFloat(), 0, 0, 0);
			if (nextInt(10) === 0) level.sound('minecraft:block.potent_sulfur.noxious_gas', x, y, z, 'ambient', 1, 1);
		}
	}

	if (info && info.las) {
		// AmbientLeavesBlockSoundPlayer: leaves with the right blocks and leaves around them (horizontally)
		const [sound, chance, tag, satisfying, same] = info.las;
		if (chance > 0 && nextInt(chance) === 0) {
			let logs = 0, leaves = 0;
			for (const d of [DIRS.north, DIRS.east, DIRS.south, DIRS.west]) {
				const neighbour = level.info(x + d[0], y, z + d[2]);
				if (tag && hasTag(neighbour, tag)) logs++;
				if (neighbour && neighbour.n === info.n) leaves++;
				if (logs === satisfying && leaves === same) {
					level.sound(sound, x, y, z, 'ambient', 1, 1);
					break;
				}
			}
		}
	}

	if (info && info.lp) {
		// FallingParticlesLeavesBlock: leaves drop leaf particles (chance and particle from the game's block).
		const below = level.info(x, y - 1, z);
		if (nextFloat() < info.lp[0] && !sturdy(below)) {
			const type = info.lp[1] || 'minecraft:tinted_leaves';
			const color = info.lp[1] ? (info.lpc !== undefined ? rgbOf(info.lpc) : null) : level.foliage(x, y, z);
			level.add(type, x + nextDouble(), y - 0.05, z + nextDouble(), 0, 0, 0, color ? { color } : null);
		}
		// LeavesBlock.makeDrippingWaterParticles
		if (level.rainingAt(x, y + 1, z) && nextInt(15) === 1 && !sturdy(below)) {
			level.add('minecraft:dripping_water', x + nextDouble(), y - 0.05, z + nextDouble(), 0, 0, 0);
		}
	}
}

const rgbOf = c => [(c >> 16 & 255) / 255, (c >> 8 & 255) / 255, (c & 255) / 255];

/**
 * The options the server sends with a particle ({b: block state id} or the game's own serialisation of the
 * options, see EffectEncoder.java) as the providers use them: rgb and alpha of colour options (dust, effects).
 */
function particleOptions(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const options = { ...raw };
	const color = raw.color;
	if (typeof color === 'number') {
		options.rgb = rgbOf(color);
		const alpha = (color >>> 24) & 255;
		if (raw.argb || alpha) options.alpha = alpha / 255;
		options.color = options.rgb;
	} else if (Array.isArray(color)) {
		options.rgb = color.slice(0, 3);
		options.color = options.rgb;
	}
	return options;
}

/** AbstractCandleBlock.addParticlesAndSound */
function candleFlame(level, x, y, z) {
	const chance = nextFloat();
	if (chance < 0.3) {
		level.add('minecraft:smoke', x, y, z, 0, 0, 0);
		if (chance < 0.17) level.sound('minecraft:block.candle.ambient', x + 0.5, y + 0.5, z + 0.5, 'block', 1 + nextFloat(), nextFloat() * 0.7 + 0.3);
	}
	level.add('minecraft:small_flame', x, y, z, 0, 0, 0);
}

/** BaseFireBlock.animateTick (the smoke; the fire itself is a block model) */
function fireSmoke(level, name, x, y, z) {
	const burns = info => !!(info && info.fb) || name === 'soul_fire';
	const below = level.info(x, y - 1, z);
	if (!burns(below) && !sturdy(below)) {
		const sides = [
			[level.info(x - 1, y, z), () => [x + nextDouble() * 0.1, y + nextDouble(), z + nextDouble()]],
			[level.info(x + 1, y, z), () => [x + 1 - nextDouble() * 0.1, y + nextDouble(), z + nextDouble()]],
			[level.info(x, y, z - 1), () => [x + nextDouble(), y + nextDouble(), z + nextDouble() * 0.1]],
			[level.info(x, y, z + 1), () => [x + nextDouble(), y + nextDouble(), z + 1 - nextDouble() * 0.1]],
			[level.info(x, y + 1, z), () => [x + nextDouble(), y + 1 - nextDouble() * 0.1, z + nextDouble()]],
		];
		for (const [info, at] of sides) {
			if (!burns(info)) continue;
			for (let i = 0; i < 2; i++) level.add('minecraft:large_smoke', ...at(), 0, 0, 0);
		}
	} else {
		for (let i = 0; i < 3; i++) level.add('minecraft:large_smoke', x + nextDouble(), y + nextDouble() * 0.5 + 0.5, z + nextDouble(), 0, 0, 0);
	}
}

/** LavaFluid and WaterFluid.animateTick (with their sounds) and the drips of ClientLevel.doAnimateTick. */
function animateFluid(level, info, x, y, z) {
	const lava = !!(info.f & FLAG_LAVA);
	if (lava) {
		const above = level.info(x, y + 1, z);
		if (isAir(above)) {
			if (nextInt(100) === 0) {
				const px = x + nextDouble(), py = y + 1, pz = z + nextDouble();
				level.add('minecraft:lava', px, py, pz, 0, 0, 0);
				level.sound('minecraft:block.lava.pop', px, py, pz, 'ambient', 0.2 + nextFloat() * 0.2, 0.9 + nextFloat() * 0.15);
			}
			if (nextInt(200) === 0) level.sound('minecraft:block.lava.ambient', x, y, z, 'ambient', 0.2 + nextFloat() * 0.2, 0.9 + nextFloat() * 0.15);
		}
	} else {
		// WaterFluid.animateTick: flowing water that is not falling murmurs
		const waterLevel = Number(props(info).level);
		if (waterLevel >= 1 && waterLevel <= 7 && nextInt(64) === 0) {
			level.sound('minecraft:block.water.ambient', x + 0.5, y + 0.5, z + 0.5, 'ambient', nextFloat() * 0.25 + 0.75, nextFloat() + 0.5);
		}
	}
	if (nextInt(10) !== 0) return;
	// trySpawnDripParticles below the fluid
	const drip = lava ? 'minecraft:dripping_lava' : 'minecraft:dripping_water';
	const topSolid = sturdy(info);
	const below = level.info(x, y - 1, z);
	if (!below || below.f & (FLAG_WATER | FLAG_LAVA)) return;
	const boxes = below.f & FLAG_NO_COLLISION ? [] : below.b || [];
	const maxY = boxes.reduce((m, b) => Math.max(m, b[4]), 0);
	if (maxY < 1) {
		if (topSolid) level.add(drip, x + nextDouble(), y - 1 + 1 - 0.05, z + nextDouble(), 0, 0, 0);
	} else if (!IMPERMEABLE.test(blockName(below))) {
		const minY = boxes.reduce((m, b) => Math.min(m, b[1]), 1);
		const x0 = boxes.reduce((m, b) => Math.min(m, b[0]), 1), x1 = boxes.reduce((m, b) => Math.max(m, b[3]), 0);
		const z0 = boxes.reduce((m, b) => Math.min(m, b[2]), 1), z1 = boxes.reduce((m, b) => Math.max(m, b[5]), 0);
		const spawn = height => level.add(drip, x + lerp(nextDouble(), x0, x1), height, z + lerp(nextDouble(), z0, z1), 0, 0, 0);
		if (minY > 0) {
			spawn(y - 1 + minY - 0.05);
		} else {
			const below2 = level.info(x, y - 2, z);
			const boxes2 = !below2 || below2.f & FLAG_NO_COLLISION ? [] : below2.b || [];
			const top2 = boxes2.reduce((m, b) => Math.max(m, b[4]), 0);
			if (top2 < 1 && !(below2 && below2.f & (FLAG_WATER | FLAG_LAVA))) spawn(y - 1 - 0.05);
		}
	}
}

/** BlockTags.IMPERMEABLE: glass blocks do not let fluids drip through. */
const IMPERMEABLE = /(^|_)glass$|^barrier$|^tinted_glass$/;

// --- the engine ---------------------------------------------------------------------------------------------

class SpriteSet {
	constructor(sprites) {
		this.sprites = sprites;
	}

	first() {
		return this.sprites[0];
	}

	random() {
		return this.sprites[nextInt(this.sprites.length)];
	}

	/** ParticleEngine.MutableSpriteSet.get(index, max) */
	byAge(age, lifetime) {
		return this.sprites[Math.trunc(age * (this.sprites.length - 1) / Math.max(1, lifetime))] || this.sprites[0];
	}
}

const VS = `
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aUv;
layout(location = 2) in vec4 aColor;
layout(location = 3) in vec2 aLight;
uniform mat4 uViewProj;
uniform sampler2D uLightmap;
out vec2 vUv;
out vec4 vColor;
out float vSph;
out float vCyl;
void main() {
	gl_Position = uViewProj * vec4(aPos, 1.0);
	vUv = aUv;
	vColor = aColor * texture(uLightmap, clamp(aLight / 256.0 + 0.5 / 16.0, vec2(0.5 / 16.0), vec2(15.5 / 16.0)));
	vSph = length(aPos);
	vCyl = max(length(aPos.xz), abs(aPos.y));
}`;

// particle.fsh: texture * colour, cut out below 0.1 alpha, fog.
const FS = `
in vec2 vUv;
in vec4 vColor;
in float vSph;
in float vCyl;
uniform sampler2D uTexture;
${FOG_GLSL}
out vec4 outColor;
void main() {
	vec4 color = texture(uTexture, vUv) * vColor;
	if (color.a < 0.1) discard;
	outColor = apply_fog(color, vSph, vCyl);
}`;

export class Particles {
	constructor(gl) {
		this.gl = gl;
		this.particles = [];
		this.sets = new Map();
		this.texture = null;
		this.program = program(gl, VS, FS);
		this.data = new Float32Array(FLOATS * 6 * 1024);
		this.vao = gl.createVertexArray();
		this.vbo = gl.createBuffer();
		gl.bindVertexArray(this.vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
		const stride = FLOATS * 4;
		gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
		gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 12);
		gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 20);
		gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 2, gl.FLOAT, false, stride, 36);
		gl.bindVertexArray(null);
		this.enabled = true;
		this.level = null;
		// effects the server sent with entity frames, played when the entities get to their tick
		this.pending = [];
		// ClientExplosionTracker: explosions whose block particles come with the next tick
		this.explosions = [];
		this.camera = null;
		this.blockAssets = null;
		this.terrainSprites = new Map();
		/** ClientLevel.rainSoundTime */
		this.rainSoundTime = 0;
		/** Exploding fireworks (FireworkParticles.Starter) */
		this.starters = [];
		/** Firework rockets' last heights, for their trail (entity id -> y) */
		this.rockets = new Map();
	}

	/** Sprite sets from particles/*.json and one atlas of textures/particle (from the asset bundle). */
	async setAssets(bundle, colormaps, blockAssets) {
		this.blockAssets = blockAssets || null;
		this.terrainSprites.clear();
		const textures = bundle.particleTextures || {};
		const images = new Map();
		for (const [id, b64] of Object.entries(textures)) {
			try {
				const blob = await (await fetch('data:image/png;base64,' + b64)).blob();
				images.set(id, await createImageBitmap(blob));
			} catch {
				// Broken texture in a resource pack: that sprite is left out.
			}
		}
		// Shelf packing into one atlas.
		const size = 512;
		const canvas = document.createElement('canvas');
		canvas.width = size;
		canvas.height = size;
		const g = canvas.getContext('2d');
		const uv = new Map();
		let x = 0, y = 0, row = 0;
		for (const [id, image] of [...images.entries()].sort((a, b) => b[1].height - a[1].height)) {
			if (x + image.width > size) { x = 0; y += row; row = 0; }
			if (y + image.height > size) break;
			g.drawImage(image, x, y);
			uv.set(id, [x / size, y / size, (x + image.width) / size, (y + image.height) / size]);
			x += image.width;
			row = Math.max(row, image.height);
		}
		for (const [type, def] of Object.entries(bundle.particles || {})) {
			const sprites = (def.textures || []).map(t => uv.get(t.includes(':') ? t : 'minecraft:' + t)).filter(Boolean);
			if (sprites.length) this.sets.set(type, new SpriteSet(sprites));
		}
		const gl = this.gl;
		this.texture = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, this.texture);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		this.colormaps = colormaps || {};
	}

	clear() {
		this.particles.length = 0;
		this.starters.length = 0;
		this.pending.length = 0;
		this.explosions.length = 0;
	}

	/** The "fx" of an entity frame (see EffectEncoder.java), played when the entities are drawn at its tick. */
	queueEffects(t, fx) {
		if (!this.enabled || !Array.isArray(fx)) return;
		this.pending.push({ t, fx });
		if (this.pending.length > 200) this.pending.splice(0, this.pending.length - 200);
	}

	/**
	 * One game tick: the effects that are due, the explosions' block particles, moving the particles, then
	 * ClientLevel.animateTick, the campfires and the entities' effect swirls. renderTick: the entity tick on screen.
	 */
	tick(world, camera, weather, renderTick, entities, columns = null, gameTime = 0) {
		// with particles off, blocks still tick for the sounds they make (when sounds are on)
		const particlesOn = this.enabled && !!this.texture;
		if (!particlesOn && !this.onSound) return;
		const level = this.levelFor(world, weather, columns);
		this.camera = camera;
		this.tickWeatherEffects(level, camera, weather, columns, gameTime);
		while (this.pending.length && (renderTick === undefined || this.pending[0].t <= renderTick)) {
			const { t, fx } = this.pending.shift();
			if (renderTick !== undefined && renderTick - t > 40) continue;
			for (const effect of fx) {
				try {
					this.effect(level, effect);
				} catch (error) {
					console.warn('CCTV: could not play effect', effect, error);
				}
			}
		}
		this.tickExplosions(level);
		for (const starter of this.starters) starter.tick();
		this.starters = this.starters.filter(starter => !starter.removed);
		for (const e of entities || []) if (e.fxp && e.fxp.length) this.effectSwirls(level, e);
		this.entityParticles(level, entities);
		const list = this.particles;
		let n = 0;
		for (let i = 0; i < list.length; i++) {
			const p = list[i];
			p.tick();
			if (!p.removed) list[n++] = p;
		}
		list.length = n;

		const cx = Math.floor(camera.x), cy = Math.floor(camera.y), cz = Math.floor(camera.z);
		for (let i = 0; i < 667; i++) {
			this.animateAt(level, cx, cy, cz, 16);
			this.animateAt(level, cx, cy, cz, 32);
		}
		// CampfireBlockEntity.particleTick for every lit campfire in view; BaseSpawner.clientTick for spawners with
		// a mob within 16 blocks of the camera (a smoke and a flame at one random point in the block).
		for (const [x, y, z, info] of world.tickers ? world.tickers(cx, cy, cz, 64) : []) {
			if (blockName(info) === 'spawner') {
				const data = world.blockEntityAt(x, y, z);
				if (!data || !data.e || (x + 0.5 - camera.x) ** 2 + (y + 0.5 - camera.y) ** 2 + (z + 0.5 - camera.z) ** 2 > 256) continue;
				const px = x + nextDouble(), py = y + nextDouble(), pz = z + nextDouble();
				this.addFx(level, 'smoke', px, py, pz, 0, 0, 0);
				this.addFx(level, 'flame', px, py, pz, 0, 0, 0);
				continue;
			}
			const p = props(info);
			const name = blockName(info);
			if (name === 'trial_spawner' || name === 'vault') {
				// TrialSpawner.tickClient / VaultBlockEntity.Client.playIdleSounds (a vault with its item on show)
				const on = name === 'vault' ? p.vault_state === 'active' || p.vault_state === 'unlocking'
					: p.trial_spawner_state === 'waiting_for_players' || p.trial_spawner_state === 'active';
				if (on && nextFloat() <= 0.02) {
					const sound = name === 'vault' ? 'minecraft:block.vault.ambient'
						: p.ominous === 'true' ? 'minecraft:block.trial_spawner.ambient_ominous' : 'minecraft:block.trial_spawner.ambient';
					level.sound(sound, x + 0.5, y + 0.5, z + 0.5, 'block', nextFloat() * 0.25 + 0.75, nextFloat() + 0.5);
				}
				continue;
			}
			if (p.lit !== 'true') continue;
			if (nextFloat() < 0.11) {
				for (let i = 0; i < nextInt(2) + 2; i++) campfireSmoke(level, x, y, z, p.signal_fire === 'true', false);
			}
		}
	}

	/**
	 * The particles entities make in their client tick: sparks behind firework rockets (FireworkRocketEntity.tick),
	 * portal specks around endermen and endermites, smoke around blazes (aiStep), bubbles behind swimming
	 * guardians and along their beams (Guardian.aiStep).
	 */
	entityParticles(level, entities) {
		const seen = new Set();
		let byId = null;
		for (const e of entities || []) {
			const w = e.w || 0.6, h = e.h || 1.8;
			const randomX = s => e.x + w * (2 * nextDouble() - 1) * s;
			const randomY = () => e.y + h * nextDouble();
			const randomZ = s => e.z + w * (2 * nextDouble() - 1) * s;
			switch (e.type) {
				case 'minecraft:firework_rocket': {
					seen.add(e.id);
					const last = this.rockets.get(e.id);
					this.rockets.set(e.id, e.y);
					const yd = last === undefined ? 0 : e.y - last;
					this.addFirework('spark', level, e.x, e.y, e.z, 0xffffff, nextGaussian() * 0.05, -yd * 0.5, nextGaussian() * 0.05);
					break;
				}
				case 'minecraft:enderman':
				case 'minecraft:endermite':
					if (e.dead) break;
					for (let i = 0; i < 2; i++) {
						this.addFx(level, 'portal', randomX(0.5), randomY() - (e.type === 'minecraft:enderman' ? 0.25 : 0), randomZ(0.5),
							(nextDouble() - 0.5) * 2, -nextDouble(), (nextDouble() - 0.5) * 2);
					}
					break;
				case 'minecraft:blaze':
					if (e.dead) break;
					for (let i = 0; i < 2; i++) this.addFx(level, 'large_smoke', randomX(0.5), randomY(), randomZ(0.5), 0, 0, 0);
					break;
				case 'minecraft:guardian':
				case 'minecraft:elder_guardian': {
					if (e.dead) break;
					const d = e.d || {};
					const yaw = (e.yaw || 0) * Math.PI / 180, pitch = (e.pitch || 0) * Math.PI / 180;
					if (d.moving && d.inWater) {
						const vx = -Math.sin(yaw) * Math.cos(pitch), vy = -Math.sin(pitch), vz = Math.cos(yaw) * Math.cos(pitch);
						for (let i = 0; i < 2; i++) this.addFx(level, 'bubble', randomX(0.5) - vx * 1.5, randomY() - vy * 1.5, randomZ(0.5) - vz * 1.5, 0, 0, 0);
					}
					if (e.beam === undefined) break;
					if (!byId) byId = new Map((entities || []).map(other => [other.id, other]));
					const target = byId.get(e.beam);
					if (!target) break;
					const duration = e.type === 'minecraft:elder_guardian' ? 60 : 80;
					const at = Math.min(duration, Math.max(0, (e.age || 0) - (e.beamStart ?? e.age ?? 0))) / duration;
					const eyeY = e.y + h * 0.5;
					let dx = target.x - e.x, dy = target.y + (target.h || 1.8) * 0.5 - eyeY, dz = target.z - e.z;
					const dd = Math.hypot(dx, dy, dz);
					if (dd < 1e-4) break;
					dx /= dd; dy /= dd; dz /= dd;
					let dist = nextDouble();
					while (dist < dd) {
						dist += 1.8 - at + nextDouble() * (1.7 - at);
						this.addFx(level, 'bubble', e.x + dx * dist, eyeY + dy * dist, e.z + dz * dist, 0, 0, 0);
					}
					break;
				}
				default:
					break;
			}
		}
		for (const id of this.rockets.keys()) if (!seen.has(id)) this.rockets.delete(id);
	}

	/**
	 * ClientLevel.tickWeatherEffects: splashes where the rain lands around the camera (smoke on lava, magma blocks
	 * and lit campfires) and the rain's sound, from the same seeded random as the game. columns: the "weather"
	 * message (motion blocking heights and rain or snow within the weather radius).
	 */
	tickWeatherEffects(level, camera, rainLevel, columns, gameTime) {
		if (!(rainLevel > 0) || !columns) return;
		const seed = BigInt.asIntN(64, BigInt(Math.floor(gameTime)) * 312987231n);
		const random = this.weatherRandom || (this.weatherRandom = new JavaRandom());
		random.setSeed(Number(BigInt.asIntN(32, seed >> 32n)), Number(BigInt.asUintN(32, seed)));
		const cx = Math.floor(camera.x), cy = Math.floor(camera.y), cz = Math.floor(camera.z);
		const radius = WEATHER_RADIUS, diameter = radius * 2 + 1;
		const count = Math.trunc(RAIN_PARTICLES_PER_BLOCK * diameter * diameter * rainLevel * rainLevel);
		let rainAt = null;
		for (let i = 0; i < count; i++) {
			const x = cx + random.nextInt(diameter) - radius;
			const z = cz + random.nextInt(diameter) - radius;
			const column = weatherColumn(columns, x, z);
			if (!column || column.height <= (columns.minY ?? -Infinity) || column.height > cy + 10 || column.height < cy - 10 || column.type !== 'r') continue;
			const y = column.height - 1;
			rainAt = [x, y, z];
			const blockX = random.nextDouble(), blockZ = random.nextDouble();
			const at = level.info(x, y, z);
			let top = 0;
			if (at) {
				let blockTop = -Infinity;
				if (!(at.f & FLAG_NO_COLLISION)) {
					for (const b of at.b || []) if (blockX >= b[0] && blockX <= b[3] && blockZ >= b[2] && blockZ <= b[5]) blockTop = Math.max(blockTop, b[4]);
				}
				const fluidTop = at.f & (FLAG_WATER | FLAG_LAVA) ? (at.lv >= 8 || !at.lv ? 8 / 9 : at.lv / 9) : 0;
				top = Math.max(blockTop, fluidTop);
			}
			const name = blockName(at);
			const smoke = (at && at.f & FLAG_LAVA) || name === 'magma_block' || (name.endsWith('campfire') && props(at).lit === 'true');
			level.add(smoke ? 'smoke' : 'rain', x + blockX, y + top, z + blockZ, 0, 0, 0);
		}
		if (rainAt && random.nextInt(3) < this.rainSoundTime++) {
			this.rainSoundTime = 0;
			const here = weatherColumn(columns, cx, cz);
			const [x, y, z] = rainAt;
			if (y > cy + 1 && here && here.height > cy) {
				level.sound('minecraft:weather.rain.above', x + 0.5, y + 0.5, z + 0.5, 'weather', 0.1, 0.5);
			} else {
				level.sound('minecraft:weather.rain', x + 0.5, y + 0.5, z + 0.5, 'weather', 0.2, 1);
			}
		}
	}

	animateAt(level, cx, cy, cz, r) {
		const x = cx + nextInt(r) - nextInt(r), y = cy + nextInt(r) - nextInt(r), z = cz + nextInt(r) - nextInt(r);
		const info = level.info(x, y, z);
		if (!info || info.f & FLAG_AIR) return;
		animateBlock(level, blockName(info), info, x, y, z);
		if (info.f & (FLAG_WATER | FLAG_LAVA)) animateFluid(level, info, x, y, z);
	}

	/** ClientLevel.doAddParticle: nothing further than 32 blocks from the camera unless the type overrides the limit. */
	addFx(level, type, x, y, z, xa, ya, za, options, override) {
		const name = type.replace(/^minecraft:/, '');
		const c = this.camera;
		if (!override && !OVERRIDE_LIMITER.has(name) && c) {
			const dx = x - c.x, dy = y - c.y, dz = z - c.z;
			if (dx * dx + dy * dy + dz * dz > 1024) return;
		}
		this.add(level, type, x, y, z, xa, ya, za, options);
	}

	effect(level, fx) {
		switch (fx[0]) {
			case 'le': this.levelEvent(level, fx[1], fx[2], fx[3], fx[4], fx[5]); break;
			case 'ps': this.spawnParticles(level, fx[1], fx[2], fx[3], fx[4], fx[5], fx[6], fx[7], !!fx[8]); break;
			case 'p': this.particlePacket(level, fx); break;
			case 'ex': this.explosion(level, fx); break;
			case 'ee': this.entityEffect(level, fx[1], fx[2], fx[3], fx[4], fx[5], fx[6]); break;
			case 'be': this.blockEvent(level, fx); break;
			case 'fw': this.fireworks(level, fx); break;
			default: break;
		}
	}

	/**
	 * ClientLevel.createFireworks (FireworkRocketEntity event 17): ["fw", x, y, z, xd, yd, zd, sound,
	 * [[shape, colours, fade colours, trail, twinkle]...]]; a rocket without explosions just puffs.
	 */
	fireworks(level, [, x, y, z, xd, yd, zd, sound, explosions]) {
		if (!explosions || !explosions.length) {
			for (let i = 0; i < nextInt(3) + 2; i++) this.addFx(level, 'poof', x, y, z, nextGaussian() * 0.05, 0.005, nextGaussian() * 0.05);
			return;
		}
		const list = explosions.map(([shape, colors, fade, trail, twinkle]) => ({ shape, colors: colors || [], fade: fade || [], trail: !!trail, twinkle: !!twinkle }));
		this.starters.push(new FireworkStarter(this, level, x, y, z, xd, yd, zd, list, !!sound));
	}

	/** A firework spark or flash (FireworkParticles.SparkProvider / FlashProvider) with its colour. */
	addFirework(kind, level, x, y, z, color, xa = 0, ya = 0, za = 0, trail = false, twinkle = false, fade = null) {
		if (!this.enabled || !this.texture || this.particles.length >= MAX_PARTICLES) return;
		const sprites = this.sets.get(kind === 'flash' ? 'minecraft:flash' : 'minecraft:firework');
		if (!sprites) return;
		const rgb = rgbOf(color);
		let p;
		if (kind === 'flash') {
			p = new FireworkFlash(level, x, y, z, sprites.random());
		} else {
			p = new FireworkSpark(level, x, y, z, xa, ya, za, sprites, this.particles);
			p.trail = trail;
			p.twinkle = twinkle;
			if (fade !== null) p.fade = rgbOf(fade);
		}
		p.setColor(rgb[0], rgb[1], rgb[2]);
		this.particles.push(p);
	}

	/**
	 * Block events that make particles: NoteBlock.triggerEvent puts a note over a tuned note block (the mob
	 * head instruments are not tuned), coloured by its note.
	 */
	blockEvent(level, [, x, y, z, block]) {
		if (block !== 'minecraft:note_block') return;
		const info = level.info(x, y, z);
		const p = info ? props(info) : {};
		if (/^(zombie|skeleton|creeper|dragon|wither_skeleton|piglin|custom_head)$/.test(p.instrument || 'harp')) return;
		const note = Number(p.note) || 0;
		this.addFx(level, 'note', x + 0.5, y + 1.2, z + 0.5, note / 24, 0, 0);
	}

	/** LevelEventHandler.levelEvent: the events that make particles. */
	levelEvent(level, type, x, y, z, data) {
		switch (type) {
			case 1501:
				for (let i = 0; i < 8; i++) this.addFx(level, 'minecraft:large_smoke', x + nextDouble(), y + 1.2, z + nextDouble(), 0, 0, 0);
				break;
			case 1502:
				for (let i = 0; i < 5; i++) {
					this.addFx(level, 'minecraft:smoke', x + nextDouble() * 0.6 + 0.2, y + nextDouble() * 0.6 + 0.2, z + nextDouble() * 0.6 + 0.2, 0, 0, 0);
				}
				break;
			case 1503:
				for (let i = 0; i < 16; i++) {
					this.addFx(level, 'minecraft:smoke', x + (5 + nextDouble() * 6) / 16, y + 0.8125, z + (5 + nextDouble() * 6) / 16, 0, 0, 0);
				}
				break;
			case 2000:
				this.shootParticles(level, data, x, y, z, 'minecraft:smoke');
				break;
			case 2010:
				this.shootParticles(level, data, x, y, z, 'minecraft:white_smoke');
				break;
			case 2001:
			case 2014:
				this.destroyBlock(level, x, y, z, data);
				break;
			case 2004:
				for (let i = 0; i < 20; i++) {
					const px = x + 0.5 + (nextDouble() - 0.5) * 2, py = y + 0.5 + (nextDouble() - 0.5) * 2, pz = z + 0.5 + (nextDouble() - 0.5) * 2;
					this.addFx(level, 'minecraft:smoke', px, py, pz, 0, 0, 0);
					this.addFx(level, 'minecraft:flame', px, py, pz, 0, 0, 0);
				}
				break;
			case 2008:
				this.addFx(level, 'minecraft:explosion', x + 0.5, y + 0.5, z + 0.5, 0, 0, 0);
				break;
			case 2009:
				for (let i = 0; i < 8; i++) this.addFx(level, 'minecraft:cloud', x + nextDouble(), y + 1.2, z + nextDouble(), 0, 0, 0);
				break;
			case 3000:
				this.addFx(level, 'minecraft:explosion_emitter', x + 0.5, y + 0.5, z + 0.5, 0, 0, 0, null, true);
				break;
			default:
				break;
		}
	}

	/** LevelEventHandler.shootParticles: out of the face of a dispenser (data: Direction.from3DDataValue). */
	shootParticles(level, data, x, y, z, particle) {
		const [nx, ny, nz] = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]][data] || [0, 1, 0];
		for (let i = 0; i < 10; i++) {
			const pow = nextDouble() * 0.2 + 0.01;
			const px = x + nx * 0.6 + 0.5 + nx * 0.01 + (nextDouble() - 0.5) * nz * 0.5;
			const py = y + ny * 0.6 + 0.5 + ny * 0.01 + (nextDouble() - 0.5) * ny * 0.5;
			const pz = z + nz * 0.6 + 0.5 + nz * 0.01 + (nextDouble() - 0.5) * nx * 0.5;
			this.addFx(level, particle, px, py, pz, nx * pow + nextGaussian() * 0.01, ny * pow + nextGaussian() * 0.01, nz * pow + nextGaussian() * 0.01);
		}
	}

	/** ClientLevel.addDestroyBlockEffect: pieces on a grid through the block's shape, flying outwards. */
	destroyBlock(level, bx, by, bz, stateId) {
		const block = level.terrainBlock(stateId, bx + 0.5, by + 0.5, bz + 0.5);
		const entry = level.world.raw && level.world.raw[stateId];
		if (!block || !entry) return;
		for (const [x1, y1, z1, x2, y2, z2] of entry.b || []) {
			const wx = Math.min(1, x2 - x1), wy = Math.min(1, y2 - y1), wz = Math.min(1, z2 - z1);
			const cx = Math.max(2, Math.ceil(wx / 0.25)), cy = Math.max(2, Math.ceil(wy / 0.25)), cz = Math.max(2, Math.ceil(wz / 0.25));
			for (let xx = 0; xx < cx; xx++) {
				for (let yy = 0; yy < cy; yy++) {
					for (let zz = 0; zz < cz; zz++) {
						const rx = (xx + 0.5) / cx, ry = (yy + 0.5) / cy, rz = (zz + 0.5) / cz;
						const x = bx + rx * wx + x1, y = by + ry * wy + y1, z = bz + rz * wz + z1;
						if (this.particles.length >= MAX_PARTICLES) return;
						this.particles.push(new TerrainParticle(level, x, y, z, rx - 0.5, ry - 0.5, rz - 0.5, block));
					}
				}
			}
		}
	}

	/** ParticleUtils.spawnParticles (bone meal, crops growing): specks spread over a block. */
	spawnParticles(level, particle, x, y, z, count, width, height, floating) {
		for (let i = 0; i < count; i++) {
			const xa = nextGaussian() * 0.02, ya = nextGaussian() * 0.02, za = nextGaussian() * 0.02;
			const start = 0.5 - width;
			const px = x + start + nextDouble() * width * 2, py = y + nextDouble() * height, pz = z + start + nextDouble() * width * 2;
			if (floating || !level.isAir(px, py - 1, pz)) this.addFx(level, particle, px, py, pz, xa, ya, za);
		}
	}

	/** ClientPacketListener.handleParticleEvent */
	particlePacket(level, [, type, x, y, z, count, xDist, yDist, zDist, xSpeed, ySpeed, zSpeed, randomization, override, raw]) {
		const options = particleOptions(raw);
		const add = (px, py, pz, xa, ya, za) => this.addFx(level, type, px, py, pz, xa, ya, za, options, !!override);
		if (count === 0) {
			add(x, y, z, xSpeed * xDist, ySpeed * yDist, zSpeed * zDist);
			return;
		}
		for (let i = 0; i < Math.min(count, 4096); i++) {
			if (randomization) {
				let xa = xSpeed, ya = ySpeed, za = zSpeed;
				const px = x + nextDouble() * xDist, py = y + nextDouble() * yDist, pz = z + nextDouble() * zDist;
				if (randomization === 2) {
					xa *= nextDouble();
					ya *= nextDouble();
					za *= nextDouble();
				}
				add(px, py, pz, xa, ya, za);
			} else {
				add(x + nextGaussian() * xDist, y + nextGaussian() * yDist, z + nextGaussian() * zDist,
					nextGaussian() * xSpeed, nextGaussian() * ySpeed, nextGaussian() * zSpeed);
			}
		}
	}

	/** ClientPacketListener.handleExplosion: the explosion particle, then ClientExplosionTracker.track. */
	explosion(level, [, x, y, z, radius, blockCount, particle, blockParticles]) {
		this.addFx(level, particle, x, y, z, 1, 0, 0);
		if (blockParticles && blockParticles.length) this.explosions.push({ x, y, z, radius, blockCount, blockParticles });
	}

	/** ClientExplosionTracker.tick: up to 512 particles a tick over the explosions, by their destroyed blocks. */
	tickExplosions(level) {
		const list = this.explosions;
		if (!list.length) return;
		const total = list.reduce((sum, e) => sum + e.blockCount, 0);
		const count = Math.min(total, 512);
		for (let i = 0; i < count; i++) {
			let pick = nextInt(total);
			const e = list.find(ex => (pick -= ex.blockCount) < 0);
			if (e) this.explosionParticle(level, e);
		}
		list.length = 0;
	}

	/** ClientExplosionTracker.addParticle */
	explosionParticle(level, e) {
		let dx = nextFloat() * 2 - 1, dy = nextFloat() * 2 - 1, dz = nextFloat() * 2 - 1;
		const len = Math.hypot(dx, dy, dz);
		if (len < 1e-4) return;
		dx /= len; dy /= len; dz /= len;
		const radius = Math.cbrt(nextFloat()) * e.radius;
		const lx = dx * radius, ly = dy * radius, lz = dz * radius;
		if (!level.isAir(e.x + lx, e.y + ly, e.z + lz)) return;
		const speed = 0.5 / (radius / e.radius + 0.1) * nextFloat() * nextFloat() + 0.3;
		const weights = e.blockParticles.reduce((sum, b) => sum + b[1], 0);
		let pick = nextInt(Math.max(1, weights));
		const [particle, , scaling, speedFactor] = e.blockParticles.find(b => (pick -= b[1]) < 0) || e.blockParticles[0];
		this.addFx(level, particle, e.x + lx * scaling, e.y + ly * scaling, e.z + lz * scaling,
			dx * speed * speedFactor, dy * speed * speedFactor, dz * speed * speedFactor);
	}

	/**
	 * The particles of handleEntityEvent: LivingEntity.makePoofParticles (death, Mob spawning), Animal love hearts,
	 * taming hearts or smoke (TamableAnimal, AbstractHorse), Villager hearts, anger, happiness and splashes.
	 */
	entityEffect(level, kind, x, y, z, w, h) {
		const randomX = scale => x + w * (2 * nextDouble() - 1) * scale;
		const randomY = () => y + h * nextDouble();
		const randomZ = scale => z + w * (2 * nextDouble() - 1) * scale;
		const gauss = () => nextGaussian() * 0.02;
		const around = (particle, count, lift) => {
			for (let i = 0; i < count; i++) {
				const xa = gauss(), ya = gauss(), za = gauss();
				this.addFx(level, particle, randomX(1), randomY() + lift, randomZ(1), xa, ya, za);
			}
		};
		switch (kind) {
			case 'poof':
				for (let i = 0; i < 20; i++) {
					const xa = gauss(), ya = gauss(), za = gauss();
					this.addFx(level, 'minecraft:poof', randomX(1) - xa * 10, randomY() - ya * 10, randomZ(1) - za * 10, xa, ya, za);
				}
				break;
			case 'love': case 'tamed': around('minecraft:heart', 7, 0.5); break;
			case 'untamed': around('minecraft:smoke', 7, 0.5); break;
			case 'villager_heart': around('minecraft:heart', 5, 1); break;
			case 'angry': around('minecraft:angry_villager', 5, 1); break;
			case 'happy': around('minecraft:happy_villager', 5, 1); break;
			case 'splash': around('minecraft:splash', 5, 1); break;
			default: break;
		}
	}

	/** LivingEntity.tickEffects on the client: now and then a swirl of one of the visible effects. */
	effectSwirls(level, e) {
		const bound = e.invisible ? 15 : 4, ambient = e.amb ? 5 : 1;
		if (nextInt(bound * ambient) !== 0) return;
		const [type, argb] = e.fxp[nextInt(e.fxp.length)];
		const options = argb !== undefined ? particleOptions({ color: argb, argb: true }) : null;
		const w = e.w || 0.6, h = e.h || 1.8;
		this.addFx(level, type, e.x + w * (2 * nextDouble() - 1) * 0.5, e.y + h * nextDouble(), e.z + w * (2 * nextDouble() - 1) * 0.5, 1, 1, 1, options);
	}

	/** A block's particle sprite (BlockStateModelSet.getParticleMaterial) and its tint for terrain particles. */
	terrainBlock(world, stateId, x, y, z) {
		const info = world.infos && world.infos[stateId];
		if (!info || NO_TERRAIN_PARTICLES.has(info.name) || !this.blockAssets || !this.blockAssets.models) return null;
		let sprite = this.terrainSprites.get(stateId);
		if (sprite === undefined) {
			const texture = this.blockAssets.models.particleTexture(info.name, info.props);
			const s = texture ? this.blockAssets.sprite(texture) : null;
			sprite = s ? [s.u0, s.v0, s.u1, s.v1] : null;
			this.terrainSprites.set(stateId, sprite);
		}
		if (!sprite) return null;
		// BlockTintSource.colorAsTerrainParticle for tint index 0 (the grass block's pieces are plain dirt)
		const source = info.name === 'minecraft:grass_block' ? null : tintSourceOf(info.name);
		let tintColor = null;
		if (source) {
			const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
			switch (source[0]) {
				case TINT_GRASS: case TINT_DOUBLE_GRASS: tintColor = this.grass(world, bx, by, bz); break;
				case TINT_FOLIAGE: case TINT_DRY_FOLIAGE: tintColor = this.foliage(world, bx, by, bz); break;
				case TINT_CONSTANT: tintColor = rgbOf(source[1]); break;
				default: break;
			}
		}
		return { sprite, tint: tintColor };
	}

	/** The part of ClientLevel the particles use. */
	levelFor(world, weather, columns = null) {
		if (this.level && this.level.world === world) {
			this.level.weather = weather;
			this.level.columns = columns;
			return this.level;
		}
		const engine = this;
		const info = (x, y, z) => world.entryAt(x, y, z);
		this.level = {
			world, weather, columns,
			info,
			add(type, x, y, z, xa, ya, za, options) {
				engine.add(this, type, x, y, z, xa, ya, za, options);
			},
			/** Level.playLocalSound: a sound the client makes itself (animateTick), when sounds are on. */
			sound(id, x, y, z, source, volume, pitch, delay = false) {
				if (engine.onSound) engine.onSound(id, x, y, z, source, volume, pitch, delay);
			},
			/** Level.playPlayerSound: at the player (the camera). */
			soundAtListener(id, source, volume, pitch) {
				const c = engine.camera;
				if (engine.onSound && c) engine.onSound(id, c.x, c.y, c.z, source, volume, pitch, false);
			},
			/** An environment attribute at the camera (the viewer's closest to the block's position). */
			attribute(name) {
				const current = engine.environment && engine.environment.current;
				return current ? current[name] : undefined;
			},
			lightCoords(x, y, z) {
				const [sky, block] = world.lightAt(Math.floor(x), Math.floor(y), Math.floor(z));
				return [block * 16, sky * 16];
			},
			maxLight(x, y, z) {
				const [sky, block] = world.lightAt(x, y, z);
				return Math.max(sky, block);
			},
			isAir(x, y, z) {
				return isAir(info(Math.floor(x), Math.floor(y), Math.floor(z)));
			},
			/** The fluid state at the position is water (any height). */
			inWater(x, y, z) {
				const at = info(Math.floor(x), Math.floor(y), Math.floor(z));
				return !!(at && at.f & FLAG_WATER);
			},
			inFluid(fluid, x, y, z) {
				const at = info(Math.floor(x), Math.floor(y), Math.floor(z));
				if (!at) return false;
				const match = fluid === 'lava' ? at.f & FLAG_LAVA : at.f & FLAG_WATER;
				if (!match) return false;
				const height = at.lv >= 8 || !at.lv ? 8 / 9 : at.lv / 9;
				return y - Math.floor(y) < height;
			},
			belowSurface(x, y, z) {
				const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
				const at = info(bx, by, bz);
				if (!at) return false;
				let top = 0;
				if (!(at.f & FLAG_NO_COLLISION)) {
					for (const b of at.b || []) if (x - bx >= b[0] && x - bx <= b[3] && z - bz >= b[2] && z - bz <= b[5]) top = Math.max(top, b[4]);
				}
				if (at.f & (FLAG_WATER | FLAG_LAVA)) top = Math.max(top, at.lv >= 8 || !at.lv ? 8 / 9 : at.lv / 9);
				return top > 0 && y < by + top;
			},
			rainingAt(x, y, z) {
				// Level.isRainingAt: raining, nothing that blocks motion above and rain (not snow) there; outside the
				// weather radius open sky (sky light 15) is the closest the viewer knows.
				if (!(this.weather > 0.2)) return false;
				const column = weatherColumn(this.columns, x, z);
				if (column) return column.height <= y && column.type === 'r';
				return world.lightAt(x, y, z)[0] >= 15;
			},
			foliage(x, y, z) {
				return engine.foliage(world, x, y, z);
			},
			collide(bb, xa, ya, za) {
				return collide(info, bb, xa, ya, za);
			},
			terrainBlock(stateId, x, y, z) {
				return engine.terrainBlock(world, stateId, x, y, z);
			},
		};
		return this.level;
	}

	/** ClientLevel.addParticle */
	add(level, type, x, y, z, xa, ya, za, options) {
		if (!this.enabled || !this.texture || this.particles.length >= MAX_PARTICLES) return;
		const name = type.replace(/^minecraft:/, '');
		const provider = PROVIDERS[name];
		const sprites = this.sets.get(type.includes(':') ? type : 'minecraft:' + type);
		if (!provider || (!sprites && !NO_SPRITES.has(name))) return;
		const particle = provider(level, x, y, z, xa, ya, za, sprites, options);
		if (particle) this.particles.push(particle);
	}

	/** BiomeColors.getAverageGrassColor at the block (grass pieces), approximated by the biome's own colour. */
	grass(world, x, y, z) {
		const biome = world.biomeInfoAt ? world.biomeInfoAt(x, y, z) : null;
		let color = 0x91bd59;
		if (biome) {
			if (biome.g !== undefined) color = biome.g;
			else {
				const map = this.colormaps.grass;
				if (map) {
					const t = clamp(biome.t, 0, 1), d = clamp(biome.d, 0, 1) * t;
					const i = (Math.trunc((1 - d) * 255) << 8 | Math.trunc((1 - t) * 255)) * 4;
					if (i + 2 < map.data.length) color = map.data[i] << 16 | map.data[i + 1] << 8 | map.data[i + 2];
				}
			}
		}
		return rgbOf(color);
	}

	/** BiomeColors.getAverageFoliageColor at the block (tinted leaves). */
	foliage(world, x, y, z) {
		const biome = world.biomeInfoAt ? world.biomeInfoAt(x, y, z) : null;
		let color = 0x48b518;
		if (biome) {
			if (biome.f !== undefined) color = biome.f;
			else {
				const map = this.colormaps.foliage;
				if (map) {
					const t = clamp(biome.t, 0, 1), d = clamp(biome.d, 0, 1) * t;
					const i = (Math.trunc((1 - d) * 255) << 8 | Math.trunc((1 - t) * 255)) * 4;
					if (i + 2 < map.data.length) color = map.data[i] << 16 | map.data[i + 1] << 8 | map.data[i + 2];
				}
			}
		}
		return rgbOf(color);
	}

	/** Camera-facing quads, opaque first, then translucent (SingleQuadParticle.extract, QuadParticleGroup). */
	render(frame, lightmap, camera, partialTick) {
		if (!this.enabled || !this.texture || !this.particles.length) return;
		const gl = this.gl;
		const need = this.particles.length * 6 * FLOATS;
		if (this.data.length < need) this.data = new Float32Array(need * 1.5 | 0);
		const d = this.data;
		const v = frame.viewRotation;
		const rx = v[0], ry = v[4], rz = v[8]; // camera right
		const ux = v[1], uy = v[5], uz = v[9]; // camera up
		let o = 0;
		// QuadParticleGroup layers: opaque, terrain (block atlas), translucent
		const blockAtlas = this.blockAssets && this.blockAssets.texture;
		const groups = [
			{ match: p => !p.translucent && !p.atlas, texture: this.texture, blend: false, count: 0 },
			{ match: p => p.atlas === 'block', texture: blockAtlas, blend: false, count: 0 },
			{ match: p => p.translucent && !p.atlas, texture: this.texture, blend: true, count: 0 },
		];
		for (const group of groups) {
			if (!group.texture) continue;
			for (const p of this.particles) {
				if (!p.sprite || p.hidden || !group.match(p)) continue;
				const px = lerp(partialTick, p.xo, p.x) - camera.x;
				const py = lerp(partialTick, p.yo, p.y) - camera.y;
				const pz = lerp(partialTick, p.zo, p.z) - camera.z;
				const size = p.quadSizeAt(partialTick);
				const roll = lerp(partialTick, p.oRoll, p.roll);
				const c = Math.cos(roll), s = Math.sin(roll);
				const [u0, v0, u1, v1] = p.sprite;
				const light = p.light(partialTick);
				const corner = (cx, cy, u, vv) => {
					const lx = (cx * c - cy * s) * size, ly = (cx * s + cy * c) * size;
					d[o++] = px + rx * lx + ux * ly; d[o++] = py + ry * lx + uy * ly; d[o++] = pz + rz * lx + uz * ly;
					d[o++] = u; d[o++] = vv;
					d[o++] = p.rCol; d[o++] = p.gCol; d[o++] = p.bCol; d[o++] = p.alpha;
					d[o++] = light[0]; d[o++] = light[1];
				};
				corner(1, -1, u1, v1); corner(1, 1, u1, v0); corner(-1, 1, u0, v0);
				corner(1, -1, u1, v1); corner(-1, 1, u0, v0); corner(-1, -1, u0, v1);
				group.count += 6;
			}
		}
		const p = this.program;
		gl.useProgram(p.program);
		gl.uniformMatrix4fv(p.u.uViewProj, false, frame.viewProj);
		setFog(gl, p.u, frame.fog);
		gl.uniform1i(p.u.uTexture, 0);
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, lightmap);
		gl.uniform1i(p.u.uLightmap, 1);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindVertexArray(this.vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
		gl.bufferData(gl.ARRAY_BUFFER, d.subarray(0, o), gl.STREAM_DRAW);
		gl.disable(gl.CULL_FACE);
		gl.enable(gl.DEPTH_TEST);
		let first = 0;
		for (const group of groups) {
			if (!group.count) continue;
			gl.bindTexture(gl.TEXTURE_2D, group.texture);
			if (group.blend) {
				gl.enable(gl.BLEND);
				gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
				gl.depthMask(false);
			} else {
				gl.disable(gl.BLEND);
				gl.depthMask(true);
			}
			gl.drawArrays(gl.TRIANGLES, first, group.count);
			first += group.count;
		}
		gl.depthMask(true);
		gl.disable(gl.BLEND);
		gl.enable(gl.CULL_FACE);
		gl.bindVertexArray(null);
	}
}

/** CampfireBlock.makeParticles */
function campfireSmoke(level, x, y, z, signal, smoking) {
	level.add(signal ? 'minecraft:campfire_signal_smoke' : 'minecraft:campfire_cosy_smoke',
		x + 0.5 + nextDouble() / 3 * (nextBoolean() ? 1 : -1), y + nextDouble() + nextDouble(), z + 0.5 + nextDouble() / 3 * (nextBoolean() ? 1 : -1), 0, 0.07, 0);
	if (smoking) {
		level.add('minecraft:smoke', x + 0.5 + nextDouble() / 4 * (nextBoolean() ? 1 : -1), y + 0.4, z + 0.5 + nextDouble() / 4 * (nextBoolean() ? 1 : -1), 0, 0.005, 0);
	}
}

/**
 * Entity.collideBoundingBox against the block shapes: Y first, then the larger horizontal axis
 * (Direction.axisStepOrder).
 */
function collide(info, bb, xa, ya, za) {
	const boxes = [];
	const x0 = Math.floor(Math.min(bb[0], bb[0] + xa) - 1e-7), x1 = Math.floor(Math.max(bb[3], bb[3] + xa) + 1e-7);
	const y0 = Math.floor(Math.min(bb[1], bb[1] + ya) - 1e-7) - 1, y1 = Math.floor(Math.max(bb[4], bb[4] + ya) + 1e-7);
	const z0 = Math.floor(Math.min(bb[2], bb[2] + za) - 1e-7), z1 = Math.floor(Math.max(bb[5], bb[5] + za) + 1e-7);
	if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 64) return [xa, ya, za];
	for (let x = x0; x <= x1; x++) {
		for (let y = y0; y <= y1; y++) {
			for (let z = z0; z <= z1; z++) {
				const at = info(x, y, z);
				if (!at || at.f & (FLAG_AIR | FLAG_NO_COLLISION)) continue;
				for (const b of at.b || []) boxes.push([x + b[0], y + b[1], z + b[2], x + b[3], y + b[4], z + b[5]]);
			}
		}
	}
	if (!boxes.length) return [xa, ya, za];
	const box = bb.slice();
	const clip = (axis, d) => {
		const a = axis, b1 = (axis + 1) % 3, b2 = (axis + 2) % 3;
		for (const s of boxes) {
			if (s[b1 + 3] <= box[b1] + 1e-7 || s[b1] >= box[b1 + 3] - 1e-7 || s[b2 + 3] <= box[b2] + 1e-7 || s[b2] >= box[b2 + 3] - 1e-7) continue;
			if (d > 0 && s[a] >= box[a + 3] - 1e-7) d = Math.min(d, s[a] - box[a + 3]);
			else if (d < 0 && s[a + 3] <= box[a] + 1e-7) d = Math.max(d, s[a + 3] - box[a]);
		}
		box[a] += d; box[a + 3] += d;
		return d;
	};
	if (ya !== 0) ya = clip(1, ya);
	if (Math.abs(xa) < Math.abs(za)) {
		if (za !== 0) za = clip(2, za);
		if (xa !== 0) xa = clip(0, xa);
	} else {
		if (xa !== 0) xa = clip(0, xa);
		if (za !== 0) za = clip(2, za);
	}
	return [xa, ya, za];
}
