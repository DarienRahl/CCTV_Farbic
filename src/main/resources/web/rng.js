// Minecraft's random numbers, bit for bit: the 48-bit linear congruential
// generator of SingleThreadedRandomSource / java.util.Random, and Mth.getSeed.
// Used wherever the client derives something from a seed (block model
// variants, plant offsets, stars, rain columns, lightning bolts), so the
// viewer shows exactly the same picture. Works without BigInt in hot paths.

const TWO_24 = 16777216;
const TWO_32 = 4294967296;
const MUL_HI = 0x5de; // 0x5DEECE66D = MUL_HI * 2^24 + MUL_LO
const MUL_LO = 0xece66d;

/** Java's Random / Minecraft's SingleThreadedRandomSource (48-bit state kept as two 24-bit halves). */
export class JavaRandom {
	constructor(seedHi = 0, seedLo = 0) {
		this.setSeed(seedHi, seedLo);
	}

	/** Seeds from a signed 64-bit value given as [hi32 (signed), lo32 (unsigned)]. */
	setSeed(hi, lo) {
		// (seed ^ 0x5DEECE66D) & (2^48 - 1)
		const lo32 = (lo ^ 0xdeece66d) >>> 0;
		const hi16 = ((hi ^ 0x5) & 0xffff) >>> 0;
		this.lo = lo32 & 0xffffff;
		this.hi = ((hi16 << 8) | (lo32 >>> 24)) & 0xffffff;
		this.haveNextGaussian = false;
	}

	/** Seeds from a JavaScript number (safe for |seed| < 2^53). */
	setSeedNumber(seed) {
		const lo = seed % TWO_32;
		const hi = Math.floor(seed / TWO_32);
		this.setSeed(hi | 0, (lo < 0 ? lo + TWO_32 : lo) >>> 0);
	}

	next(bits) {
		// state = state * 0x5DEECE66D + 0xB (mod 2^48), in 24-bit halves without precision loss
		const lo = this.lo, hi = this.hi;
		const loProduct = lo * MUL_LO + 0xb;
		const carry = Math.floor(loProduct / TWO_24);
		const newLo = loProduct - carry * TWO_24;
		const hiProduct = (hi * MUL_LO + lo * MUL_HI + carry) % TWO_24;
		this.lo = newLo;
		this.hi = hiProduct;
		// (int)(state >>> (48 - bits))
		const value = hiProduct * TWO_24 + newLo; // < 2^48, exact
		return Math.floor(value / 2 ** (48 - bits)) | 0;
	}

	nextInt(bound) {
		if (bound === undefined) return this.next(32);
		if ((bound & -bound) === bound) {
			// Power of two: (int)((bound * (long)next(31)) >> 31)
			return Math.floor(bound * this.next(31) / 2147483648);
		}
		let bits, value;
		do {
			bits = this.next(31);
			value = bits % bound;
		} while (bits - value + (bound - 1) > 2147483647);
		return value;
	}

	nextFloat() {
		return this.next(24) / TWO_24;
	}

	nextDouble() {
		return (this.next(26) * 134217728 + this.next(27)) / 9007199254740992;
	}

	nextBoolean() {
		return this.next(1) !== 0;
	}

	/** nextLong as [hi32 signed, lo32 unsigned]. */
	nextLong() {
		const hi = this.next(32);
		const lo = this.next(32);
		// ((long)hi << 32) + lo, where lo is sign-extended
		let resultHi = hi + (lo < 0 ? -1 : 0);
		return [resultHi | 0, lo >>> 0];
	}

	/** Minecraft's MarsagliaPolarGaussian. */
	nextGaussian() {
		if (this.haveNextGaussian) {
			this.haveNextGaussian = false;
			return this.nextNextGaussian;
		}
		let v1, v2, s;
		do {
			v1 = 2 * this.nextDouble() - 1;
			v2 = 2 * this.nextDouble() - 1;
			s = v1 * v1 + v2 * v2;
		} while (s >= 1 || s === 0);
		const multiplier = Math.sqrt(-2 * Math.log(s) / s);
		this.nextNextGaussian = v2 * multiplier;
		this.haveNextGaussian = true;
		return v1 * multiplier;
	}
}

// --- 64-bit helpers for Mth.getSeed (values as [hi32 signed, lo32 unsigned]) -----------

function mul64(aHi, aLo, bHi, bLo) {
	// Low 64 bits of a * b using 16-bit limbs.
	const a0 = aLo & 0xffff, a1 = aLo >>> 16, a2 = aHi & 0xffff, a3 = aHi >>> 16;
	const b0 = bLo & 0xffff, b1 = bLo >>> 16, b2 = bHi & 0xffff, b3 = bHi >>> 16;
	let c0 = a0 * b0;
	let c1 = (c0 >>> 16) + a1 * b0;
	let c2 = c1 >>> 16;
	c1 = (c1 & 0xffff) + a0 * b1;
	c2 += c1 >>> 16;
	c2 += a2 * b0;
	let c3 = c2 >>> 16;
	c2 = (c2 & 0xffff) + a1 * b1;
	c3 += c2 >>> 16;
	c2 = (c2 & 0xffff) + a0 * b2;
	c3 += c2 >>> 16;
	c3 += a3 * b0 + a2 * b1 + a1 * b2 + a0 * b3;
	const lo = ((c1 & 0xffff) << 16 | (c0 & 0xffff)) >>> 0;
	const hi = ((c3 & 0xffff) << 16 | (c2 & 0xffff)) | 0;
	return [hi, lo];
}

function add64(aHi, aLo, bHi, bLo) {
	const lo = aLo + bLo;
	const carry = lo >= TWO_32 ? 1 : 0;
	return [(aHi + bHi + carry) | 0, lo >>> 0];
}

function fromInt(value) {
	return [value < 0 ? -1 : 0, value >>> 0];
}

/**
 * Mth.getSeed(x, y, z) as [hi32, lo32]:
 * l = (long)(x * 3129871) ^ (long)z * 116129781L ^ (long)y; l = l * l * 42317861L + l * 11L; return l >> 16
 */
export function positionSeed(x, y, z) {
	const xs = fromInt(Math.imul(x, 3129871));
	const zs = mul64(z < 0 ? -1 : 0, z >>> 0, 0, 116129781);
	const ys = fromInt(y);
	let hi = xs[0] ^ zs[0] ^ ys[0];
	let lo = (xs[1] ^ zs[1] ^ ys[1]) >>> 0;
	const square = mul64(hi, lo, hi, lo);
	const a = mul64(square[0], square[1], 0, 42317861);
	const b = mul64(hi, lo, 0, 11);
	[hi, lo] = add64(a[0], a[1], b[0], b[1]);
	// Arithmetic shift right by 16.
	const newLo = ((lo >>> 16) | (hi << 16)) >>> 0;
	const newHi = hi >> 16;
	return [newHi, newLo];
}

/** Low 32 bits of a seed pair (what `seed & mask` style code reads). */
export function seedLow(seed) {
	return seed[1];
}
