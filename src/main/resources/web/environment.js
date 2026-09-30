// Sky, fog and light the way Minecraft 26.3's client derives them from the
// environment attributes the server samples at the camera (see
// EnvironmentSampler.java): the lightmap (lightmap.fsh), fog
// (FogRenderer / AtmosphericFogEnvironment / WaterFogEnvironment), lightning
// sky flashes (ClientLevel) and End flashes (EndFlashState).

const SAMPLE_MS = 250; // the server samples every 5 ticks

const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const lerpVec = (a, b, t) => a.map((v, i) => lerp(v, b[i], t));
function lerpDegrees(a, b, t) {
	const d = ((b - a) % 360 + 540) % 360 - 180;
	return a + d * t;
}

const ANGLES = new Set(['sunAngle', 'moonAngle', 'starAngle']);
const DISCRETE = new Set(['t', 'time', 'clock', 'gt', 'moonPhase', 'precipitation', 'flash', 'skyDarken']);

const DEFAULT_SAMPLE = {
	time: 6000, clock: 6000, gt: 0, rain: 0, thunder: 0,
	sky: [0.47, 0.65, 1], fog: [0.75, 0.85, 1], sunrise: [0, 0, 0, 0], cloud: [1, 1, 1, 0.8], cloudHeight: 192.33,
	sunAngle: 0, moonAngle: 180, starAngle: 0, stars: 0, moonPhase: 0,
	skyLight: [1, 1, 1], skyFactor: 1, ambient: [0.04, 0.04, 0.04], blockTint: [1, 0.84, 0.66], nightVision: [1, 1, 1],
	fogStart: 1024, fogEnd: 1024, skyFogEnd: 512, cloudFogEnd: 2048,
	waterFog: [0.02, 0.12, 0.29], waterFogStart: -8, waterFogEnd: 96,
	precipitation: true,
};

function sinFloat(x) {
	return Math.fround(Math.sin(Math.fround(x)));
}

/** Fog inside lava and powder snow (FogRenderer with LavaFogEnvironment / PowderedSnowFogEnvironment). */
const DENSE_FOG = {
	lava: { color: [0x99 / 255, 0x19 / 255, 0], start: 0.25, end: 1 },
	powder_snow: { color: [0x9f / 255, 0xbb / 255, 0xcc / 255], start: 0, end: 2 },
};

export class Environment {
	constructor() {
		this.dim = { id: 'minecraft:overworld', skybox: 'overworld', hasSky: true, minY: -64, horizon: 63 };
		this.a = null;
		this.b = null;
		this.flicker = 0;
		this.rainFog = 0;
		/** Settings > Distance fog: 'vanilla', 'smooth', 'atmospheric' or 'minimal' */
		this.fogMode = 'vanilla';
		this.skyFlash = 0;
		this.gamma = 0.5; // the game's default "Brightness" option
		this.pixels = new Uint8Array(16 * 16 * 4);
		this.current = { ...DEFAULT_SAMPLE };
		this.flash = { intensity: 0, xAngle: 0, yAngle: 0 };
	}

	setDimension(dim) {
		if (dim) this.dim = dim;
		this.a = this.b = null;
		this.current = { ...DEFAULT_SAMPLE };
	}

	push(sample, now) {
		const s = { ...DEFAULT_SAMPLE, ...sample, arrival: now };
		this.a = this.b ? this.value(now) : s;
		this.a.arrival = now;
		this.b = s;
	}

	/** Interpolated attribute values, one sample interval behind the server for smooth changes. */
	value(now) {
		const a = this.a, b = this.b;
		if (!b) return { ...DEFAULT_SAMPLE };
		const t = clamp((now - b.arrival) / SAMPLE_MS);
		const out = {};
		for (const key of Object.keys(b)) {
			const va = a[key], vb = b[key];
			if (DISCRETE.has(key) || va === undefined) out[key] = vb;
			else if (ANGLES.has(key)) out[key] = lerpDegrees(va, vb, t);
			else if (Array.isArray(vb) && Array.isArray(va) && va.length === vb.length) out[key] = lerpVec(va, vb, t);
			else if (typeof vb === 'number' && typeof va === 'number') out[key] = lerp(va, vb, t);
			else out[key] = vb;
		}
		return out;
	}

	/** Game ticks (with fraction) since the last sample, capped so a stalled stream does not run away. */
	elapsedTicks(now) {
		return this.b ? Math.min(40, Math.max(0, (now - this.b.arrival) / 50)) : 0;
	}

	gameTime(now) {
		return (this.b ? this.b.gt : 0) + this.elapsedTicks(now);
	}

	/** Once per game tick: torch flicker (LightmapRenderStateExtractor.tick), lightning flash countdown. */
	tick() {
		this.flicker += (Math.random() - Math.random()) * Math.random() * Math.random() * 0.1;
		this.flicker *= 0.9;
		if (this.skyFlash > 0) this.skyFlash--;
	}

	/** A lightning bolt exists on the client: LightningBolt sets the sky flash for 2 ticks each tick. */
	lightning() {
		this.skyFlash = 2;
	}

	/**
	 * Per frame. camera: {x, y, z, forward: [x, y, z]}, renderDistance in blocks,
	 * skyLightAtCamera 0..15, medium: the fluid or block around the camera (Camera.getFluidInCamera: 'water',
	 * 'lava', 'powder_snow' or null).
	 */
	update(now, camera, renderDistance, skyLightAtCamera, medium, deltaTicks) {
		const inWater = medium === 'water';
		const v = this.value(now);
		this.current = v;
		const hasFlash = this.skyFlash > 0;

		// ClientLevel's lightning flash layer.
		let sky = v.sky;
		let skyFactor = v.skyFactor;
		if (hasFlash) {
			sky = lerpVec(sky, [0.8, 0.8, 1.0], 0.22);
			skyFactor = 1;
		}

		// EndFlashState (ticked on the default clock).
		this.flash = { intensity: 0, xAngle: 0, yAngle: 0 };
		if (this.dim.endFlashes && Array.isArray(v.flash)) {
			const clock = (this.b ? this.b.clock : 0) + this.elapsedTicks(now);
			const period = Math.floor(clock / 600);
			const f = v.flash.find(p => p[0] === period);
			if (f) {
				const within = clock - period * 600;
				const [, offset, duration, xAngle, yAngle] = f;
				const intensity = within >= offset && within <= offset + duration ? Math.sin((within - offset) * Math.PI / duration) : 0;
				this.flash = { intensity: Math.max(0, intensity), xAngle, yAngle };
			}
		}
		skyFactor += this.flash.intensity;

		this.lightmapInfo = {
			skyFactor,
			blockFactor: this.flicker + 1.4,
			nightVisionFactor: 0,
			brightness: this.gamma,
			blockTint: v.blockTint,
			skyLight: v.skyLight,
			ambient: v.ambient,
			nightVision: v.nightVision,
		};

		// Sky state (SkyRenderer.extractRenderState).
		const rain = clamp(v.rain), thunder = clamp(v.thunder);
		this.sky = {
			skybox: this.dim.skybox || 'overworld',
			skyColor: sky,
			sunAngle: v.sunAngle * Math.PI / 180,
			moonAngle: v.moonAngle * Math.PI / 180,
			starAngle: v.starAngle * Math.PI / 180,
			rainBrightness: 1 - rain,
			starBrightness: v.stars,
			sunrise: v.sunrise,
			moonPhase: v.moonPhase | 0,
			darkDisc: camera.y - (this.dim.horizon ?? 63) < 0 && !inWater,
			cloudColor: v.cloud,
			cloudHeight: v.cloudHeight,
			flash: this.flash,
		};

		// Rain fog (AtmosphericFogEnvironment.updateRainFogState).
		const skyLightMultiplier = clamp((skyLightAtCamera - 8) / 7);
		const target = rain * skyLightMultiplier * (v.precipitation === false ? 0.5 : 1);
		this.rainFog += (target - this.rainFog) * Math.min(1, deltaTicks * 0.2);

		this.fog = this.computeFog(v, camera, renderDistance, sky, rain, thunder, medium);
		return this;
	}

	computeFog(v, camera, renderDistance, sky, rain, thunder, medium) {
		const inWater = medium === 'water';
		const renderChunks = Math.max(2, Math.round(renderDistance / 16));
		let color;
		const fog = {};
		const dense = DENSE_FOG[medium];
		if (dense) {
			// LavaFogEnvironment, PowderedSnowFogEnvironment: a fixed colour, the fog a block or two away
			color = dense.color.slice();
			fog.envStart = dense.start;
			fog.envEnd = dense.end;
			fog.skyEnd = fog.envEnd;
			fog.cloudEnd = fog.envEnd;
		} else if (inWater) {
			color = v.waterFog.slice();
			fog.envStart = v.waterFogStart;
			fog.envEnd = v.waterFogEnd;
			fog.skyEnd = fog.envEnd;
			fog.cloudEnd = fog.envEnd;
		} else {
			color = v.fog.slice();
			if (renderChunks >= 4) {
				const sunX = sinFloat(v.sunAngle * Math.PI / 180) > 0 ? -1 : 1;
				const looking = camera.forward[0] * sunX;
				if (looking > 0 && v.sunrise[3] > 0) color = lerpVec(color, v.sunrise.slice(0, 3), looking * v.sunrise[3]);
			}
			let skyColor = sky;
			if (rain > 0) skyColor = [skyColor[0] * (1 - rain * 0.5), skyColor[1] * (1 - rain * 0.5), skyColor[2] * (1 - rain * 0.4)];
			if (thunder > 0) skyColor = skyColor.map(c => c * (1 - thunder * 0.5));
			const skyFogEnd = Math.min(v.skyFogEnd / 16, renderChunks);
			let mix = lerp(0.25, 1, clamp(skyFogEnd / 32));
			mix = 1 - Math.pow(mix, 0.25);
			color = lerpVec(color, skyColor, mix);

			fog.envStart = v.fogStart - 160 * this.rainFog;
			const envEnd = v.fogEnd;
			fog.envEnd = Math.max(Math.min(96, envEnd), envEnd - 256 * this.rainFog);
			fog.skyEnd = Math.min(renderDistance, v.skyFogEnd);
			fog.cloudEnd = Math.min(128 * 16, v.cloudFogEnd);
		}

		// Void darkness near the bottom of the world.
		const onset = this.dim.horizon === this.dim.minY ? 1 : 32;
		const darkness = clamp((onset + (this.dim.minY ?? -64) - camera.y) / onset);
		if (darkness > 0 && !dense) color = color.map(c => c * (1 - darkness) * (1 - darkness));
		if (inWater && color[0] !== 0 && color[1] !== 0 && color[2] !== 0) {
			const scale = 1 / Math.max(color[0], color[1], color[2]);
			color = color.map(c => c * scale);
		}

		const span = clamp(renderDistance / 10, 4, 64);
		fog.rdStart = renderDistance - span;
		fog.rdEnd = renderDistance;
		fog.smooth = 0;
		fog.haze = 0;
		// The viewer's own fades (Settings > Distance fog); under water, in lava and powder snow the game's fog
		if (!dense && !inWater) {
			switch (this.fogMode) {
				case 'smooth':
					fog.rdStart = renderDistance * 0.55;
					fog.smooth = 1;
					break;
				case 'atmospheric':
					fog.rdStart = renderDistance * 0.6;
					fog.smooth = 1;
					fog.haze = 1.05 / Math.max(16, renderDistance);
					break;
				case 'minimal':
					fog.rdStart = renderDistance - Math.max(2, renderDistance * 0.04);
					fog.envStart = Math.max(fog.envStart, renderDistance * 4);
					fog.envEnd = Math.max(fog.envEnd, renderDistance * 4 + 1);
					break;
				default:
					break;
			}
		}
		fog.color = color;
		return fog;
	}

	/** The 16x16 lightmap texture (x = block light, y = sky light), exactly like lightmap.fsh. */
	lightmap(nightVisionFactor = 0) {
		const info = this.lightmapInfo;
		const px = this.pixels;
		if (!info) return px.fill(255);
		const brightness = level => level / (4 - 3 * level);
		const nv = info.nightVision.map(c => c * nightVisionFactor);
		const base = [Math.max(info.ambient[0], nv[0]), Math.max(info.ambient[1], nv[1]), Math.max(info.ambient[2], nv[2])];
		for (let s = 0; s < 16; s++) {
			const sky = brightness(s / 15) * info.skyFactor;
			for (let b = 0; b < 16; b++) {
				const level = b / 15;
				const block = brightness(level) * info.blockFactor;
				const parabolic = (2 * level - 1) * (2 * level - 1);
				const o = (s * 16 + b) * 4;
				const rgb = [0, 0, 0];
				for (let c = 0; c < 3; c++) {
					const tint = lerp(info.blockTint[c], 1, 0.9 * parabolic);
					rgb[c] = clamp(base[c] + info.skyLight[c] * sky + tint * block);
				}
				const max = Math.max(rgb[0], rgb[1], rgb[2]);
				const inverted = 1 - max;
				const scaled = 1 - inverted * inverted * inverted * inverted;
				for (let c = 0; c < 3; c++) {
					const notGamma = max > 0 ? rgb[c] * (scaled / max) : 0;
					px[o + c] = Math.round(lerp(rgb[c], notGamma, info.brightness) * 255);
				}
				px[o + 3] = 255;
			}
		}
		return px;
	}

	/** 0 at night .. 1 at noon, used by shaders and post effects. */
	daylight() {
		const info = this.lightmapInfo;
		return info ? clamp(info.skyFactor) : 1;
	}
}
