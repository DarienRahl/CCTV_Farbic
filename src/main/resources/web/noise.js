// Minecraft's 2D simplex noise as used for biome colours (Biome.BIOME_INFO_NOISE:
// PerlinSimplexNoise with one octave, seeded with LegacyRandomSource(2345)).
// The swamp grass colour switches between two colours on this noise.

import { JavaRandom } from './rng.js';

const GRADIENT = [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
	[0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1], [1, 1, 0], [0, -1, 1], [-1, 1, 0], [0, -1, -1]];
const SQRT_3 = Math.sqrt(3);
const F2 = 0.5 * (SQRT_3 - 1);
const G2 = (3 - SQRT_3) / 6;

class SimplexNoise {
	constructor(random) {
		this.xo = random.nextDouble() * 256;
		this.yo = random.nextDouble() * 256;
		this.zo = random.nextDouble() * 256;
		this.p = new Int32Array(256);
		for (let i = 0; i < 256; i++) this.p[i] = i;
		for (let i = 0; i < 256; i++) {
			const offset = random.nextInt(256 - i);
			const tmp = this.p[i];
			this.p[i] = this.p[offset + i];
			this.p[offset + i] = tmp;
		}
	}

	perm(x) {
		return this.p[x & 255];
	}

	corner(index, x, y, base) {
		let t = base - x * x - y * y;
		if (t < 0) return 0;
		t *= t;
		const g = GRADIENT[index];
		return t * t * (g[0] * x + g[1] * y);
	}

	value2d(xin, yin) {
		const s = (xin + yin) * F2;
		const i = Math.floor(xin + s);
		const j = Math.floor(yin + s);
		const t = (i + j) * G2;
		const x0 = xin - (i - t);
		const y0 = yin - (j - t);
		let i1, j1;
		if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
		const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
		const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
		const ii = i & 255, jj = j & 255;
		const gi0 = this.perm(ii + this.perm(jj)) % 12;
		const gi1 = this.perm(ii + i1 + this.perm(jj + j1)) % 12;
		const gi2 = this.perm(ii + 1 + this.perm(jj + 1)) % 12;
		return 70 * (this.corner(gi0, x0, y0, 0.5) + this.corner(gi1, x1, y1, 0.5) + this.corner(gi2, x2, y2, 0.5));
	}
}

let biomeInfoNoise = null;

/** Biome.BIOME_INFO_NOISE.getValue(x, z, false) */
export function biomeInfoNoise2d(x, z) {
	if (!biomeInfoNoise) {
		const random = new JavaRandom();
		random.setSeedNumber(2345);
		biomeInfoNoise = new SimplexNoise(random);
	}
	return biomeInfoNoise.value2d(x, z);
}
