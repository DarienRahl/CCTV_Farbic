// Keyframe animations of the game (26.3 KeyframeAnimation, AnimationChannel, Keyframe, AnimationState),
// played with the definitions the server reads from the client jar (EntityModels.java), so the sniffer,
// warden, frog, camel... move exactly like in the game and new definitions come along with a game update.
//
// A definition is {len, loop, bones: {name: [{t: 'p'|'r'|'s', k: [time, preX, preY, preZ, x, y, z, interpolation, ...]}]}}
// with the values as the game stores them (positions with y negated, radians, scales minus one).

const STRIDE = 8;
const CATMULLROM = 1;

/** Mth.catmullrom */
const catmullrom = (a, p0, p1, p2, p3) =>
	0.5 * (2 * p1 + (p2 - p0) * a + (2 * p0 - 5 * p1 + 4 * p2 - p3) * a * a + (3 * p1 - p0 - 3 * p2 + p3) * a * a * a);

export class KeyframeAnimation {
	constructor(definition) {
		this.length = definition.len;
		this.looping = definition.loop;
		this.entries = [];
		for (const [bone, channels] of Object.entries(definition.bones || {})) {
			for (const channel of channels) {
				if (!channel.k || channel.k.length < STRIDE) continue;
				this.entries.push({ bone, target: channel.t, k: Float32Array.from(channel.k), n: channel.k.length / STRIDE });
			}
		}
	}

	/** KeyframeAnimation.apply(millisSinceStart, targetScale): adds the animated offsets to the parts (by name). */
	apply(parts, millis, targetScale = 1) {
		let seconds = millis / 1000;
		if (this.looping) seconds %= this.length;
		for (const { bone, target, k, n } of this.entries) {
			const part = parts[bone];
			if (!part) continue;
			// Mth.binarySearch(0, n, i -> seconds <= timestamp(i)): the first keyframe at or after the time.
			let from = 0, len = n;
			while (len > 0) {
				const half = len >> 1, middle = from + half;
				if (seconds <= k[middle * STRIDE]) len = half;
				else { from = middle + 1; len -= half + 1; }
			}
			const prev = Math.max(0, from - 1), next = Math.min(n - 1, prev + 1);
			const p = prev * STRIDE, q = next * STRIDE;
			const alpha = next !== prev ? Math.max(0, Math.min(1, (seconds - k[p]) / (k[q] - k[p]))) : 0;
			let x, y, z;
			if (k[q + 7] === CATMULLROM) {
				// Interpolations.CATMULLROM: through the post targets of the four surrounding keyframes.
				const a = Math.max(0, prev - 1) * STRIDE, d = Math.min(n - 1, next + 1) * STRIDE;
				x = catmullrom(alpha, k[a + 4], k[p + 4], k[q + 4], k[d + 4]) * targetScale;
				y = catmullrom(alpha, k[a + 5], k[p + 5], k[q + 5], k[d + 5]) * targetScale;
				z = catmullrom(alpha, k[a + 6], k[p + 6], k[q + 6], k[d + 6]) * targetScale;
			} else {
				// Interpolations.LINEAR: from the previous post target to the next pre target.
				x = (k[p + 4] + (k[q + 1] - k[p + 4]) * alpha) * targetScale;
				y = (k[p + 5] + (k[q + 2] - k[p + 5]) * alpha) * targetScale;
				z = (k[p + 6] + (k[q + 3] - k[p + 6]) * alpha) * targetScale;
			}
			// Targets: ModelPart.offsetPos / offsetRotation / offsetScale
			if (target === 'r') { part.xRot += x; part.yRot += y; part.zRot += z; }
			else if (target === 'p') { part.x += x; part.y += y; part.z += z; }
			else if (target === 's') { part.xScale += x; part.yScale += y; part.zScale += z; }
		}
	}

	/** KeyframeAnimation.applyWalk */
	applyWalk(parts, walkPos, walkSpeed, speedFactor, scaleFactor) {
		this.apply(parts, Math.trunc(walkPos * 50 * speedFactor), Math.min(walkSpeed * scaleFactor, 1));
	}

	/** KeyframeAnimation.applyStatic */
	applyStatic(parts) {
		this.apply(parts, 0, 1);
	}
}

/**
 * The AnimationState fields of one entity, by the game's field names. States come from two places: the
 * server reports the ones the game starts on the server ({@code "anim"} in the entity frame, e.g. the warden's
 * roar), the viewer's ports of the client code start the others (bat flying, camel idle...). Times are in
 * entity ticks ({@code tickCount}), like AnimationState.
 */
export class AnimationStates {
	constructor() {
		this.local = new Map();
		this.server = new Map();
		this.suppressed = new Map();
		this.lastTick = null;
		this.eventTick = null;
		this.memory = {};
	}

	/** Server states of the newest frame: {name: startTick}. */
	sync(starts) {
		this.server.clear();
		if (!starts) return;
		for (const [name, tick] of Object.entries(starts)) {
			const stopped = this.suppressed.get(name);
			if (stopped !== undefined && Math.abs(stopped - tick) < 0.5) continue;
			this.suppressed.delete(name);
			this.server.set(name, tick);
		}
	}

	start(name, tick) {
		this.local.set(name, tick);
	}

	startIfStopped(name, tick) {
		if (!this.isStarted(name)) this.start(name, tick);
	}

	stop(name) {
		this.local.delete(name);
		const server = this.server.get(name);
		if (server !== undefined) {
			// The client stopped a state the server keeps running (AnimationState.stop in handleEntityEvent).
			this.suppressed.set(name, server);
			this.server.delete(name);
		}
	}

	animateWhen(condition, name, tick) {
		if (condition) this.startIfStopped(name, tick);
		else this.stop(name);
	}

	isStarted(name) {
		return this.local.has(name) || this.server.has(name);
	}

	/** AnimationState.getTimeInMillis(ageInTicks), or null when stopped. */
	millis(name, ageInTicks) {
		const start = this.local.get(name) ?? this.server.get(name);
		return start === undefined ? null : (ageInTicks - start) * 50;
	}
}

/** Plays the game's definitions on a model's parts, like the model's KeyframeAnimation fields. */
export class Animator {
	constructor(library) {
		this.library = library;
	}

	/** Binds to one model pose: parts, the entity's states and its (interpolated) age. */
	bind(parts, states, ageInTicks) {
		this.parts = parts;
		this.states = states;
		this.age = ageInTicks;
		return this;
	}

	has(name) {
		return !!this.library.animation(name);
	}

	/** KeyframeAnimation.apply(AnimationState, ageInTicks, speedFactor) */
	state(name, stateName, speedFactor = 1) {
		const animation = this.library.animation(name);
		if (!animation || !this.states) return;
		const millis = this.states.millis(stateName, this.age);
		if (millis !== null) animation.apply(this.parts, Math.trunc(millis * speedFactor), 1);
	}

	/** KeyframeAnimation.applyWalk */
	walk(name, walkPos, walkSpeed, speedFactor, scaleFactor) {
		const animation = this.library.animation(name);
		if (animation) animation.applyWalk(this.parts, walkPos, walkSpeed, speedFactor, scaleFactor);
	}
}
