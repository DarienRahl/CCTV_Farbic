// Particles like the game client (26.3). Every game tick ClientLevel.animateTick picks random blocks around the
// camera and runs their animateTick (ports in ANIMATE below), lit campfires tick their smoke
// (CampfireBlockEntity.particleTick), and the particles move and look like the game's Particle classes:
// Particle.tick/move physics, the sprite sets of particles/*.json with the textures from textures/particle
// (both from the client jar, resource packs apply), drawn as camera-facing quads, lit by the lightmap.

import { program, FOG_GLSL, setFog } from './gl.js';

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
	end_rod: (l, x, y, z, xa, ya, za, s) => new EndRodParticle(l, x, y, z, xa, ya, za, s),
	dust: (l, x, y, z, xa, ya, za, s, options) => new DustParticle(l, x, y, z, xa, ya, za, (options && options.color) || REDSTONE, (options && options.scale) || 1, s),
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
	tinted_leaves: (l, x, y, z, xa, ya, za, s, options) => {
		const p = new FallingLeafParticle(l, x, y, z, s.random(), 0.07, 10, true, false, 2, 0.021);
		if (options && options.color) p.setColor(...options.color);
		return p;
	},
};

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
/** Block.isFaceSturdy for the face towards a direction, approximated by a full collision box. */
const sturdy = info => !!(info && info.f & FLAG_FULL_COLLISION);
const isAir = info => !info || !!(info.f & FLAG_AIR);

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
		// CampfireBlock.animateTick (lava pops only from the normal campfire)
		if (name === 'campfire' && nextInt(5) === 0) {
			for (let i = 0; i < nextInt(1) + 1; i++) level.add('minecraft:lava', x + 0.5, y + 0.5, z + 0.5, nextFloat() / 2, 5.0e-5, nextFloat() / 2);
		}
	} else if (name === 'fire' || name === 'soul_fire') {
		fireSmoke(level, name, x, y, z);
	} else if ((name === 'furnace' || name === 'blast_furnace' || name === 'smoker') && p.lit === 'true') {
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
		if (level.maxLight(x, y, z) <= 13 && nextDouble() <= 0.7) {
			level.add('minecraft:firefly', x + nextDouble() * 10 - 5, y + nextDouble() * 5, z + nextDouble() * 10 - 5, 0, 0, 0);
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

/** AbstractCandleBlock.addParticlesAndSound */
function candleFlame(level, x, y, z) {
	if (nextFloat() < 0.3) level.add('minecraft:smoke', x, y, z, 0, 0, 0);
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

/** LavaFluid.animateTick and the drips of ClientLevel.doAnimateTick. */
function animateFluid(level, info, x, y, z) {
	const lava = !!(info.f & FLAG_LAVA);
	if (lava) {
		const above = level.info(x, y + 1, z);
		if (isAir(above) && nextInt(100) === 0) level.add('minecraft:lava', x + nextDouble(), y + 1, z + nextDouble(), 0, 0, 0);
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
	}

	/** Sprite sets from particles/*.json and one atlas of textures/particle (from the asset bundle). */
	async setAssets(bundle, colormaps) {
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
	}

	/** One game tick: move the particles, then ClientLevel.animateTick and the campfires. */
	tick(world, camera, weather) {
		if (!this.enabled || !this.texture) return;
		const level = this.levelFor(world, weather);
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
		// CampfireBlockEntity.particleTick for every lit campfire in view.
		for (const [x, y, z, info] of world.campfires ? world.campfires(cx, cy, cz, 64) : []) {
			const p = props(info);
			if (p.lit !== 'true') continue;
			if (nextFloat() < 0.11) {
				for (let i = 0; i < nextInt(2) + 2; i++) campfireSmoke(level, x, y, z, p.signal_fire === 'true', false);
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

	/** The part of ClientLevel the particles use. */
	levelFor(world, weather) {
		if (this.level && this.level.world === world) {
			this.level.weather = weather;
			return this.level;
		}
		const engine = this;
		const info = (x, y, z) => world.entryAt(x, y, z);
		this.level = {
			world, weather,
			info,
			add(type, x, y, z, xa, ya, za, options) {
				engine.add(this, type, x, y, z, xa, ya, za, options);
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
				// Level.isRainingAt: raining, open sky above (sky light 15 is the closest the viewer knows).
				return this.weather > 0.2 && world.lightAt(x, y, z)[0] >= 15;
			},
			foliage(x, y, z) {
				return engine.foliage(world, x, y, z);
			},
			collide(bb, xa, ya, za) {
				return collide(info, bb, xa, ya, za);
			},
		};
		return this.level;
	}

	/** ClientLevel.addParticle */
	add(level, type, x, y, z, xa, ya, za, options) {
		if (this.particles.length >= MAX_PARTICLES) return;
		const name = type.replace(/^minecraft:/, '');
		const provider = PROVIDERS[name];
		const sprites = this.sets.get(type.includes(':') ? type : 'minecraft:' + type);
		if (!provider || !sprites) return;
		const particle = provider(level, x, y, z, xa, ya, za, sprites, options);
		if (particle) this.particles.push(particle);
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
		const counts = [0, 0];
		for (const pass of [false, true]) {
			for (const p of this.particles) {
				if (p.translucent !== pass || !p.sprite) continue;
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
				counts[pass ? 1 : 0] += 6;
			}
		}
		const p = this.program;
		gl.useProgram(p.program);
		gl.uniformMatrix4fv(p.u.uViewProj, false, frame.viewProj);
		setFog(gl, p.u, frame.fog);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.texture);
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
		gl.disable(gl.BLEND);
		gl.depthMask(true);
		if (counts[0]) gl.drawArrays(gl.TRIANGLES, 0, counts[0]);
		if (counts[1]) {
			gl.enable(gl.BLEND);
			gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
			gl.depthMask(false);
			gl.drawArrays(gl.TRIANGLES, counts[0], counts[1]);
			gl.depthMask(true);
			gl.disable(gl.BLEND);
		}
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
