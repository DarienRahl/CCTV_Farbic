// The game's sounds in the viewer: what a player standing at the camera would hear. The server sends the sound
// packets it gives players nearby and the sounds the client plays for level events (SoundEncoder.java); this
// ports the client's side of them: SimpleSoundInstance / EntityBoundSoundInstance pick a sound of the event from
// sounds.json with the packet's seed (WeighedSoundEvents.getSound), and SoundEngine.play sets the channel up like
// OpenAL: volume clamped to 0..1, pitch clamped to 0.5..2, linear attenuation to max(volume, 1) times the sound's
// attenuation distance (Channel.linearAttenuation), heard from the camera's position and direction.
import { JavaRandom } from './rng.js';

/** Sounds playing at once (the game has 247 static channels; a camera rarely needs more than a few). */
const MAX_PLAYING = 48;
/** Decoded sound files kept. */
const MAX_BUFFERS = 400;
/** Effects older than this (in ticks) when their turn comes are dropped, like particles. */
const MAX_LATE = 40;

/** RandomSource.create(seed) from the seed the server sent (a decimal long). */
function randomFor(seed) {
	let value;
	try {
		value = BigInt(seed);
	} catch (error) {
		value = BigInt(Math.floor(Math.random() * 2 ** 48));
	}
	return new JavaRandom(Number(BigInt.asIntN(32, value >> 32n)), Number(BigInt.asUintN(32, value)));
}

/** SampledFloat of sounds.json: a number, or a uniform distribution. */
function sample(value, random) {
	if (typeof value === 'number') return value;
	if (value && typeof value === 'object') {
		const min = value.min_inclusive ?? value.min ?? 1, max = value.max_exclusive ?? value.max ?? min;
		return min + random.nextFloat() * (max - min);
	}
	return 1;
}

export class Sounds {
	constructor(query) {
		this.query = query;
		this.enabled = false;
		this.ctx = null;
		this.events = null;
		this.loading = null;
		/** Sound file path -> Promise of an AudioBuffer (null when missing). */
		this.buffers = new Map();
		this.pending = [];
		this.playing = new Set();
		/** Jukebox songs by block ("x,y,z"). */
		this.jukeboxes = new Map();
		this.listener = { x: 0, y: 0, z: 0 };
		this.entities = new Map();
		/** Lightning bolts already heard. */
		this.bolts = new Set();
	}

	/** Starts audio (must follow a click: browsers only allow sound after the user asks for it). */
	async enable() {
		if (!this.ctx) {
			const Context = window.AudioContext || window.webkitAudioContext;
			if (!Context) return false;
			this.ctx = new Context();
			this.master = this.ctx.createGain();
			this.master.connect(this.ctx.destination);
		}
		await this.ctx.resume();
		this.enabled = true;
		if (!this.events && !this.loading) {
			this.loading = fetch('/assets/sounds.json' + this.query, { credentials: 'same-origin' })
				.then(r => (r.ok ? r.json() : null))
				.then(json => { this.events = json; })
				.catch(() => {})
				.finally(() => { this.loading = null; });
		}
		return true;
	}

	disable() {
		this.enabled = false;
		for (const sound of this.playing) {
			try {
				sound.source.stop();
			} catch (error) {
				// already stopped
			}
		}
		this.playing.clear();
		this.jukeboxes.clear();
		this.pending.length = 0;
		if (this.ctx) this.ctx.suspend();
	}

	/** Entity frames: keeps the sound effects until the frame is drawn. */
	queue(t, fx) {
		if (!this.enabled || !fx) return;
		const sounds = fx.filter(e => e[0] === 's' || e[0] === 'se' || e[0] === 'sg' || e[0] === 'js' || e[0] === 'jx');
		if (!sounds.length) return;
		this.pending.push({ t, sounds });
		if (this.pending.length > 200) this.pending.shift();
	}

	/**
	 * Every frame: the listener follows the camera (position and look direction), due sounds start, and sounds
	 * that follow an entity move with it (EntityBoundSoundInstance.tick).
	 */
	update(renderTick, camera, forward, entityList) {
		if (!this.enabled || !this.ctx || !camera) return;
		this.listener = { x: camera.x, y: camera.y, z: camera.z };
		const l = this.ctx.listener;
		const t = this.ctx.currentTime;
		if (l.positionX) {
			l.positionX.setValueAtTime(camera.x, t);
			l.positionY.setValueAtTime(camera.y, t);
			l.positionZ.setValueAtTime(camera.z, t);
			l.forwardX.setValueAtTime(forward[0], t);
			l.forwardY.setValueAtTime(forward[1], t);
			l.forwardZ.setValueAtTime(forward[2], t);
			l.upX.setValueAtTime(0, t);
			l.upY.setValueAtTime(1, t);
			l.upZ.setValueAtTime(0, t);
		} else {
			l.setPosition(camera.x, camera.y, camera.z);
			l.setOrientation(forward[0], forward[1], forward[2], 0, 1, 0);
		}
		this.entities.clear();
		for (const e of entityList || []) {
			this.entities.set(e.id, e);
			if (e.type === 'minecraft:lightning_bolt' && !this.bolts.has(e.id)) {
				// LightningBolt.tick in the client: the thunder, heard everywhere, and the impact
				this.bolts.add(e.id);
				if (this.bolts.size > 64) this.bolts.delete(this.bolts.values().next().value);
				this.local('minecraft:entity.lightning_bolt.thunder', e.x, e.y, e.z, 'weather', 10000, 0.8 + Math.random() * 0.2);
				this.local('minecraft:entity.lightning_bolt.impact', e.x, e.y, e.z, 'weather', 2, 0.5 + Math.random() * 0.2);
			}
		}
		if (!this.events) return;
		while (this.pending.length && (renderTick === undefined || this.pending[0].t <= renderTick)) {
			const { t: tick, sounds } = this.pending.shift();
			if (renderTick !== undefined && renderTick - tick > MAX_LATE) continue;
			for (const sound of sounds) {
				try {
					this.effect(sound);
				} catch (error) {
					console.warn('CCTV: could not play sound', sound, error);
				}
			}
		}
		for (const sound of this.playing) {
			if (sound.entity === undefined) continue;
			const e = this.entities.get(sound.entity);
			if (e) this.place(sound.panner, e.x, e.y, e.z);
		}
	}

	effect(fx) {
		switch (fx[0]) {
			case 's': {
				const [, id, x, y, z, source, volume, pitch, seed, delay] = fx;
				// ClientLevel.playSound: with a distance delay, far sounds start later (sound travels 40 blocks a second)
				const d2 = (x - this.listener.x) ** 2 + (y - this.listener.y) ** 2 + (z - this.listener.z) ** 2;
				const wait = delay && d2 > 100 ? Math.floor(Math.sqrt(d2) / 40 * 20) * 0.05 : 0;
				this.play(id, source, volume, pitch, randomFor(seed), { x, y, z }, wait);
				break;
			}
			case 'se': {
				const [, id, entity, source, volume, pitch, seed] = fx;
				const e = this.entities.get(entity);
				if (e) this.play(id, source, volume, pitch, randomFor(seed), { x: e.x, y: e.y, z: e.z, entity });
				break;
			}
			case 'sg': {
				// LevelEventHandler.globalLevelEvent: heard from 2 blocks towards the event
				const [, id, x, y, z, source, volume, pitch] = fx;
				const c = this.listener;
				const dx = x - c.x, dy = y - c.y, dz = z - c.z, len = Math.hypot(dx, dy, dz) || 1;
				this.play(id, source, volume, pitch, randomFor(Math.floor(Math.random() * 2 ** 31)),
					{ x: c.x + dx / len * 2, y: c.y + dy / len * 2, z: c.z + dz / len * 2 });
				break;
			}
			case 'js': {
				// SimpleSoundInstance.forJukeboxSong: records, volume 4, at the block's centre; one song per jukebox
				const [, id, x, y, z] = fx;
				const key = x + ',' + y + ',' + z;
				this.stop(this.jukeboxes.get(key));
				this.play(id, 'record', 4, 1, randomFor(Math.floor(Math.random() * 2 ** 31)), { x: x + 0.5, y: y + 0.5, z: z + 0.5 }, 0,
					sound => this.jukeboxes.set(key, sound));
				break;
			}
			case 'jx': {
				const key = fx[1] + ',' + fx[2] + ',' + fx[3];
				this.stop(this.jukeboxes.get(key));
				this.jukeboxes.delete(key);
				break;
			}
			default:
				break;
		}
	}

	/**
	 * Level.playLocalSound in the client: a sound the viewer makes itself (a block's animateTick, lightning),
	 * with an unseeded random; far sounds with a distance delay start later.
	 */
	local(id, x, y, z, source, volume, pitch, delay = false) {
		if (!this.enabled || !this.events || !this.ctx) return;
		const d2 = (x - this.listener.x) ** 2 + (y - this.listener.y) ** 2 + (z - this.listener.z) ** 2;
		const wait = delay && d2 > 100 ? Math.floor(Math.sqrt(d2) / 40 * 20) * 0.05 : 0;
		this.play(id, source, volume, pitch, randomFor(Math.floor(Math.random() * 2 ** 31)), { x, y, z }, wait);
	}

	/** WeighedSoundEvents.getSound: a weighted pick; "event" entries pick from another event. */
	pick(event, random, depth = 0) {
		if (!event || depth > 8) return null;
		const entries = (event.sounds || []).map(s => (typeof s === 'string' ? { name: s } : s));
		const weight = s => (s.type === 'event' ? this.weightOf(this.events[s.name], depth + 1) : s.weight ?? 1);
		const total = entries.reduce((sum, s) => sum + weight(s), 0);
		if (!entries.length || total <= 0) return null;
		let index = random.nextInt(total);
		for (const s of entries) {
			index -= weight(s);
			if (index < 0) return s.type === 'event' ? this.pick(this.events[s.name], random, depth + 1) : s;
		}
		return null;
	}

	weightOf(event, depth) {
		if (!event || depth > 8) return 0;
		return (event.sounds || []).reduce((sum, s) => sum + (typeof s === 'string' ? 1 : s.type === 'event' ? this.weightOf(this.events[s.name], depth + 1) : s.weight ?? 1), 0);
	}

	/** SoundEngine.play for a SimpleSoundInstance at a position. */
	play(id, source, volume, pitch, random, at, wait = 0, started = null) {
		const sound = this.pick(this.events[id], random);
		if (!sound || !sound.name) return;
		const instanceVolume = volume * sample(sound.volume ?? 1, random);
		const instancePitch = pitch * sample(sound.pitch ?? 1, random);
		const gain = Math.min(1, Math.max(0, instanceVolume));
		if (gain <= 0) return;
		const attenuation = Math.max(instanceVolume, 1) * (sound.attenuation_distance ?? 16);
		const d = Math.hypot(at.x - this.listener.x, at.y - this.listener.y, at.z - this.listener.z);
		if (d > attenuation && at.entity === undefined) return;
		const [ns, path] = sound.name.includes(':') ? sound.name.split(':') : ['minecraft', sound.name];
		this.buffer(ns + '/' + path).then(buffer => {
			if (!buffer || !this.enabled) return;
			if (this.playing.size >= MAX_PLAYING) {
				const oldest = this.playing.values().next().value;
				this.stop(oldest);
			}
			const ctx = this.ctx;
			const node = ctx.createBufferSource();
			node.buffer = buffer;
			node.playbackRate.value = Math.min(2, Math.max(0.5, instancePitch));
			const volumeNode = ctx.createGain();
			volumeNode.gain.value = gain;
			const panner = ctx.createPanner();
			panner.panningModel = 'equalpower';
			panner.distanceModel = 'linear';
			panner.refDistance = 0;
			panner.maxDistance = attenuation;
			panner.rolloffFactor = 1;
			this.place(panner, at.x, at.y, at.z);
			node.connect(volumeNode).connect(panner).connect(this.master);
			const playing = { source: node, panner, entity: at.entity };
			this.playing.add(playing);
			node.onended = () => this.playing.delete(playing);
			node.start(ctx.currentTime + wait);
			if (started) started(playing);
		});
	}

	place(panner, x, y, z) {
		if (panner.positionX) {
			const t = this.ctx.currentTime;
			panner.positionX.setValueAtTime(x, t);
			panner.positionY.setValueAtTime(y, t);
			panner.positionZ.setValueAtTime(z, t);
		} else {
			panner.setPosition(x, y, z);
		}
	}

	stop(sound) {
		if (!sound) return;
		try {
			sound.source.stop();
		} catch (error) {
			// not started or already stopped
		}
		this.playing.delete(sound);
	}

	/** A sound file, decoded once (GET /assets/sound/{namespace}/{path}.ogg). */
	buffer(path) {
		let entry = this.buffers.get(path);
		if (entry) {
			this.buffers.delete(path);
			this.buffers.set(path, entry);
			return entry;
		}
		entry = fetch('/assets/sound/' + path + '.ogg' + this.query, { credentials: 'same-origin' })
			.then(r => (r.ok ? r.arrayBuffer() : null))
			.then(data => (data ? this.ctx.decodeAudioData(data) : null))
			.catch(() => null);
		this.buffers.set(path, entry);
		while (this.buffers.size > MAX_BUFFERS) this.buffers.delete(this.buffers.keys().next().value);
		return entry;
	}
}
