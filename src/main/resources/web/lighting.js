// Day/night lighting like Minecraft's client: celestial angle, sky darkening,
// the 16x16 lightmap (LightTexture + lightmap.fsh) and sky/fog colours.

function clamp(v, lo = 0, hi = 1) {
	return Math.max(lo, Math.min(hi, v));
}

function mix(a, b, t) {
	return a + (b - a) * t;
}

/** DimensionType.timeOfDay: celestial angle 0..1 (0 = noon... as the client computes it). */
export function timeOfDay(dayTime) {
	const d = ((dayTime / 24000 - 0.25) % 1 + 1) % 1;
	const e = 0.5 - Math.cos(d * Math.PI) / 2;
	return (d * 2 + e) / 3;
}

/** Level.getSkyDarken: 0.2 at night .. 1.0 at day, lowered by rain and thunder. */
export function skyDarken(dayTime, rain, thunder) {
	const f = timeOfDay(dayTime);
	let g = 1 - (Math.cos(f * Math.PI * 2) * 2 + 0.2);
	g = 1 - clamp(g);
	g *= 1 - rain * 5 / 16;
	g *= 1 - thunder * 5 / 16;
	return g * 0.8 + 0.2;
}

export class Lighting {
	constructor() {
		this.flicker = 0;
		this.pixels = new Uint8Array(16 * 16 * 4);
		this.gamma = 0.5; // the game's default "Brightness" option
	}

	/** Called every game tick: random flicker of block light (torches), like LightTexture.tick. */
	tick() {
		this.flicker += (Math.random() - Math.random()) * Math.random() * Math.random() * 0.1;
		this.flicker *= 0.9;
	}

	/**
	 * @param env {time, rain, thunder}
	 * @param dimension dimension id
	 * @param nightVision 0..1
	 * @returns Uint8Array RGBA 16x16, x = block light, y = sky light
	 */
	lightmap(env, dimension, nightVision) {
		const end = dimension === 'minecraft:the_end';
		const nether = dimension === 'minecraft:the_nether';
		const ambient = nether ? 0.1 : 0;
		const darken = nether || end ? 1 : skyDarken(env.time, env.rain ? 1 : 0, env.thunder ? 1 : 0);
		const skyFactor = nether || end ? 0 : darken * 0.95 + 0.05;
		const skyColor = [mix(darken, 1, 0.35), mix(darken, 1, 0.35), 1];
		const blockFactor = this.flicker + 1.5;
		const brightness = level => mix(level / (4 - 3 * level), 1, ambient);

		const px = this.pixels;
		for (let sky = 0; sky < 16; sky++) {
			for (let block = 0; block < 16; block++) {
				const b = brightness(block / 15) * blockFactor;
				const s = brightness(sky / 15) * skyFactor;
				let r = b, g = b * ((b * 0.6 + 0.4) * 0.6 + 0.4), bl = b * (b * b * 0.6 + 0.4);
				if (end) {
					r = clamp(mix(r, 0.99, 0.25));
					g = clamp(mix(g, 1.12, 0.25));
					bl = clamp(mix(bl, 1.0, 0.25));
				} else {
					r += skyColor[0] * s;
					g += skyColor[1] * s;
					bl += skyColor[2] * s;
					r = mix(r, 0.75, 0.04);
					g = mix(g, 0.75, 0.04);
					bl = mix(bl, 0.75, 0.04);
				}
				if (nightVision > 0) {
					const max = Math.max(r, g, bl);
					if (max < 1 && max > 0) {
						r = mix(r, r / max, nightVision);
						g = mix(g, g / max, nightVision);
						bl = mix(bl, bl / max, nightVision);
					}
				}
				r = clamp(r); g = clamp(g); bl = clamp(bl);
				const notGamma = x => 1 - Math.pow(1 - x, 4);
				r = clamp(mix(mix(r, notGamma(r), this.gamma), 0.75, 0.04));
				g = clamp(mix(mix(g, notGamma(g), this.gamma), 0.75, 0.04));
				bl = clamp(mix(mix(bl, notGamma(bl), this.gamma), 0.75, 0.04));
				const i = (sky * 16 + block) * 4;
				px[i] = r * 255;
				px[i + 1] = g * 255;
				px[i + 2] = bl * 255;
				px[i + 3] = 255;
			}
		}
		return px;
	}

	/** Sky dome and fog colours for the overworld (plains colours), the Nether and the End. */
	sky(env, dimension) {
		if (dimension === 'minecraft:the_nether') {
			const fog = [0.2, 0.03, 0.03];
			return { zenith: fog, horizon: fog, fog, sun: 0, moon: 0, sunDir: [0, 1, 0], stars: 0 };
		}
		if (dimension === 'minecraft:the_end') {
			const fog = [0.06, 0.05, 0.09];
			return { zenith: [0.09, 0.07, 0.12], horizon: fog, fog, sun: 0, moon: 0, sunDir: [0, 1, 0], stars: 0 };
		}

		const angle = timeOfDay(env.time);
		const h = clamp(Math.cos(angle * Math.PI * 2) * 2 + 0.5);
		const skyBase = [0x78 / 255, 0xa7 / 255, 1];
		const fogBase = [0xc0 / 255, 0xd8 / 255, 1];
		let zenith = skyBase.map(c => c * h);
		let fog = [fogBase[0] * (h * 0.94 + 0.06), fogBase[1] * (h * 0.94 + 0.06), fogBase[2] * (h * 0.91 + 0.09)];

		const rain = env.rain ? 1 : 0, thunder = env.thunder ? 1 : 0;
		if (rain) {
			const grey = c => (c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11) * 0.6;
			const zg = grey(zenith), fg = grey(fog);
			zenith = zenith.map(c => mix(c, zg, 0.75));
			fog = fog.map(c => mix(c, fg, 0.75));
			if (thunder) {
				zenith = zenith.map(c => c * 0.8);
				fog = fog.map(c => c * 0.8);
			}
		}

		// Sunrise / sunset glow near the horizon (DimensionSpecialEffects.getSunriseOrSunsetColor).
		let horizon = fog;
		const c = Math.cos(angle * Math.PI * 2);
		if (c >= -0.4 && c <= 0.4 && !rain) {
			const t = c / 0.4 * 0.5 + 0.5;
			let alpha = 1 - (1 - Math.sin(t * Math.PI)) * 0.99;
			alpha *= alpha;
			const glow = [t * 0.3 + 0.7, t * t * 0.7 + 0.2, 0.2];
			horizon = fog.map((v, i) => mix(v, glow[i], alpha * 0.6));
		}

		// Same transform the client uses for the sun: rotate Y by -90, then X by the celestial angle.
		// Noon is straight up, sunrise in the east (+x).
		const theta = angle * Math.PI * 2;
		const dir = [-Math.sin(theta), Math.cos(theta), 0];
		// Cloud colour (Level.getCloudColor): white, darker at night and in rain.
		let cloud = [h * 0.9 + 0.1, h * 0.9 + 0.1, h * 0.85 + 0.15];
		if (rain) {
			const grey = (cloud[0] * 0.3 + cloud[1] * 0.59 + cloud[2] * 0.11) * 0.6;
			cloud = cloud.map(c => mix(c, grey, 0.95));
		}
		const day = Math.floor(env.time / 24000);
		const phase = ((day % 8) + 8) % 8;

		return {
			cloud,
			moonPhase: [phase % 4, Math.floor(phase / 4)],
			zenith, horizon, fog,
			sun: (1 - rain) * clamp(dir[1] * 4 + 0.3),
			moon: (1 - rain) * clamp(-dir[1] * 4 + 0.3),
			sunDir: dir,
			stars: (1 - rain) * clamp((0.5 - h) * 1.5) * 0.9,
		};
	}
}
