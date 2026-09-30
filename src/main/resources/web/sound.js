// The game's sounds in the viewer: what a player standing at the camera would hear. The server sends the sound
// packets it gives players nearby and the sounds the client plays for level events (SoundEncoder.java); this
// ports the client's side of them: SimpleSoundInstance / EntityBoundSoundInstance pick a sound of the event from
// sounds.json with the packet's seed (WeighedSoundEvents.getSound), and SoundEngine.play sets the channel up like
// OpenAL: volume clamped to 0..1, pitch clamped to 0.5..2, linear attenuation to max(volume, 1) times the sound's
// attenuation distance (Channel.linearAttenuation), heard from the camera's position and direction.
// The ambience the client plays on its own is ported too (ambient() once per tick): the biome's loop, additions
// and cave "mood" (BiomeAmbientSoundsHandler), the underwater loop and its additions (LocalPlayer,
// UnderwaterAmbientSoundHandler) and bubble columns (BubbleColumnAmbientSoundHandler).
import { JavaRandom } from './rng.js';

/** Sounds playing at once (the game has 247 static channels; a camera rarely needs more than a few). */
const MAX_PLAYING = 48;
/** Decoded sound files kept. */
const MAX_BUFFERS = 400;
/** Effects older than this (in ticks) when their turn comes are dropped, like particles. */
const MAX_LATE = 40;

/** Ticks a looping ambient sound takes to fade in or out (BiomeAmbientSoundsHandler.LOOP_SOUND_CROSS_FADE_TIME). */
const FADE_TICKS = 40;

const unseeded = () => randomFor(Math.floor(Math.random() * 2 ** 31));

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

/** Warden.getHeartBeatDelay: from 40 ticks when calm to 10 when angry (anger 80 and more). */
const heartBeatDelay = e => 40 - Math.floor(Math.min(1, Math.max(0, (Number(e.d && e.d.anger) || 0) / 80)) * 30);

/** Sounds the client plays in handleEntityEvent: type -> (event, entity) -> [id, x, y, z, source, volume, pitch]. */
const EVENT_SOUNDS = {
	// ArmorStand: hit
	'minecraft:armor_stand': (id, e) => (id === 32 ? ['minecraft:entity.armor_stand.hit', e.x, e.y, e.z, 'neutral', 0.3, 1] : null),
	// ZombieVillager: cured (at the eyes)
	'minecraft:zombie_villager': (id, e) => (id === 16
		? ['minecraft:entity.zombie_villager.cure', e.x, e.y + (e.baby ? 0.93 : 1.74), e.z, 'hostile', 1 + Math.random(), Math.random() * 0.7 + 0.3] : null),
	// EvokerFangs: the bite starts
	'minecraft:evoker_fangs': (id, e) => (id === 4 ? ['minecraft:entity.evoker_fangs.attack', e.x, e.y, e.z, 'hostile', 1, Math.random() * 0.2 + 0.85] : null),
	// Sniffer starts digging: ClientPacketListener plays SnifferSoundInstance
	'minecraft:sniffer': (id, e) => (id === 63 ? ['minecraft:entity.sniffer.digging', e.x, e.y, e.z, 'neutral', 1, 1] : null),
};

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
		this.resetAmbience();
	}

	/** State of the client's AmbientSoundHandlers (a new level or camera starts them again). */
	resetAmbience() {
		for (const loop of this.loops ? this.loops.values() : []) this.stop(loop.sound);
		if (this.underwater) this.stop(this.underwater.sound);
		for (const beam of this.beamSounds ? this.beamSounds.values() : []) this.stop(beam);
		this.beamSounds = new Map();
		/** BiomeAmbientSoundsHandler.loopSounds: sound event -> {sound, fade, direction} */
		this.loops = new Map();
		this.previousLoop = null;
		this.moodiness = 0;
		/** UnderLiquidAmbientSoundInstance: {sound, fade} while it plays */
		this.underwater = null;
		this.wasUnderwater = null;
		this.underwaterDelay = 0;
		this.subSounds = new Set();
		this.wasInBubbleColumn = false;
		this.firstBubbleTick = true;
		this.flashOn = false;
	}

	/** The game's sounds as a stream for recordings (recorder.js), or null while sound is off. */
	recordingStream() {
		if (!this.ctx || !this.enabled) return null;
		if (!this.recordingOutput) {
			this.recordingOutput = this.ctx.createMediaStreamDestination();
			this.master.connect(this.recordingOutput);
		}
		return this.recordingOutput.stream;
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
		this.music = null;
		this.resetAmbience();
		this.pending.length = 0;
		if (this.ctx) this.ctx.suspend();
	}

	/**
	 * Entity frames: keeps the sound effects until the frame is drawn, with the sounds the client plays itself
	 * for entity events (handleEntityEvent).
	 */
	queue(t, fx, entities) {
		if (!this.enabled) return;
		const sounds = (fx || []).filter(e => e[0] === 's' || e[0] === 'se' || e[0] === 'sg' || e[0] === 'js' || e[0] === 'jx');
		for (const e of entities || []) {
			if (!e.ev) continue;
			const handler = EVENT_SOUNDS[e.type];
			if (!handler) continue;
			for (const id of e.ev) {
				const sound = handler(id, e);
				if (sound) sounds.push(['s', sound[0], sound[1], sound[2], sound[3], sound[4], sound[5], sound[6], String(Math.floor(Math.random() * 2 ** 31)), false]);
			}
		}
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

	/**
	 * Once per game tick: the client's ambient sound handlers for a player at the camera. at: {world, camera,
	 * ambience (the "amb" environment attribute), inWater (eyes in water), block (world.entryAt the camera),
	 * flash (the End flash: {intensity, xAngle, yAngle}), entities (the entity list)}.
	 */
	ambient(at) {
		if (!this.enabled || !this.events || !this.ctx || !at.camera) return;
		this.biomeAmbience(at);
		this.musicTick(at);
		this.jukeboxSongs(at.world);
		this.underwaterAmbience(at);
		this.bubbleColumn(at);
		this.endFlash(at);
		this.entitySounds(at.entities);
	}

	/**
	 * MusicManager.tick with Minecraft.getSituationalMusic for the camera (never in creative): the place's
	 * BackgroundMusic, its underwater music when the camera is in water, the boss music during the dragon fight.
	 * The first song starts 100 ticks after sounds are turned on, the next ones after the song's delays capped by
	 * the Music Frequency option (Default 20 minutes, Frequent 10, Constant right away).
	 */
	musicTick(at) {
		const frequency = this.musicFrequency || 'default';
		const m = this.music || (this.music = { delay: 100, current: null, random: randomFor(Math.floor(Math.random() * 2 ** 31)) });
		if (frequency === 'off') {
			if (m.current) this.stop(m.current.sound);
			m.current = null;
			m.delay = 100;
			return;
		}
		const env = at.music || null;
		const music = env ? (env.boss || (at.inWater && env.u) || env.d || null) : null;
		if (!music) {
			m.delay = Math.max(m.delay, 100);
			return;
		}
		const [id, minDelay, maxDelay, replace] = music;
		const nextInt = (lo, hi) => (lo >= hi ? lo : lo + m.random.nextInt(hi - lo + 1));
		if (m.current) {
			if (replace && id !== m.current.id) {
				this.stop(m.current.sound);
				m.current.stopped = true;
				m.delay = nextInt(0, Math.floor(minDelay / 2));
			}
			const loading = !m.current.sound && !m.current.stopped && performance.now() - m.current.at < 60000;
			const active = loading || (m.current.sound && !m.current.sound.ended && !m.current.sound.stopped);
			if (!active) {
				m.current = null;
				// MusicFrequency.getNextSongDelay
				const cap = { default: 24000, frequent: 12000, constant: 0 }[frequency] ?? 24000;
				const next = frequency === 'constant' ? 100 : nextInt(Math.min(minDelay, cap), Math.min(maxDelay, cap));
				m.delay = Math.min(m.delay, next);
			}
		}
		m.delay = Math.min(m.delay, maxDelay);
		if (!m.current && --m.delay <= 0) {
			// SimpleSoundInstance.forMusic: the music category, not positioned
			const current = { id, sound: null, at: performance.now() };
			m.current = current;
			this.play(id, 'music', 1, 1, m.random, null, 0, sound => {
				if (m.current === current && !current.stopped) current.sound = sound;
				else this.stop(sound);
			});
			m.delay = Infinity;
		}
	}

	/**
	 * Songs already playing when the viewer came in or turned sounds on: started from where the jukebox is
	 * (JukeboxSongPlayer.ticksSinceSongStarted, streamed with the section) instead of waiting for the next disc.
	 */
	jukeboxSongs(world) {
		if (!world || !world.blockEntityData) return;
		const now = performance.now();
		for (const [key, be] of world.blockEntityData) {
			if (be.k !== 'jukebox' || !be.s || this.jukeboxes.has(key)) continue;
			const offset = (be.t || 0) / 20 + (now - (be.at || now)) / 1000;
			if (be.l && offset >= be.l) continue;
			this.jukebox(be.s, be.x, be.y, be.z, offset);
		}
	}

	/** One song per jukebox (LevelEventHandler.playJukeboxSong stops the one before). */
	jukebox(id, x, y, z, offset = 0) {
		const key = x + ',' + y + ',' + z;
		this.stop(this.jukeboxes.get(key));
		const pending = { pending: true, id };
		this.jukeboxes.set(key, pending);
		this.play(id, 'record', 4, 1, randomFor(Math.floor(Math.random() * 2 ** 31)), { x: x + 0.5, y: y + 0.5, z: z + 0.5 }, 0,
			sound => {
				if (this.jukeboxes.get(key) === pending) this.jukeboxes.set(key, sound);
				else this.stop(sound);
			}, offset);
	}

	/**
	 * The sounds entities make in their client tick: blazes burning (Blaze.aiStep), phantoms flapping when their
	 * wings go down (Phantom.tick), the warden's heartbeat (Warden.tick, faster the angrier it is) and a searching
	 * sniffer's sniffs (Sniffer.playSearchingSound).
	 */
	entitySounds(entities) {
		const ages = this.entityAges || (this.entityAges = new Map());
		const seen = new Set();
		this.guardianBeams(entities);
		for (const e of entities || []) {
			const type = e.type;
			if (type === 'minecraft:enderman') {
				this.endermanStare(e);
				continue;
			}
			if (type !== 'minecraft:blaze' && type !== 'minecraft:phantom' && type !== 'minecraft:warden' && type !== 'minecraft:sniffer') continue;
			seen.add(e.id);
			const age = Math.floor(e.age || 0);
			const last = ages.get(e.id);
			ages.set(e.id, age);
			if (e.dead) continue;
			if (type === 'minecraft:blaze') {
				if (Math.floor(Math.random() * 24) === 0) {
					this.local('minecraft:entity.blaze.burn', e.x + 0.5, e.y + 0.5, e.z + 0.5, 'hostile', 1 + Math.random(), Math.random() * 0.7 + 0.3);
				}
				continue;
			}
			if (last === undefined || age <= last) continue;
			for (let t = Math.max(last + 1, age - 4); t <= age; t++) {
				if (type === 'minecraft:sniffer') {
					if (t % 20 === 0 && e.d && e.d.searching) this.entityLocal('minecraft:entity.sniffer.searching', e, 'neutral', 1, 1);
				} else if (type === 'minecraft:phantom') {
					const flap = tick => Math.cos((e.id * 3 + tick) * 7.448451 * Math.PI / 180 + Math.PI);
					if (flap(t) > 0 && flap(t + 1) <= 0) {
						this.entityLocal('minecraft:entity.phantom.flap', e, 'hostile', 0.95 + Math.random() * 0.05, 0.95 + Math.random() * 0.05);
					}
				} else if (t % heartBeatDelay(e) === 0) {
					this.local('minecraft:entity.warden.heartbeat', e.x, e.y, e.z, 'hostile', 5, (Math.random() - Math.random()) * 0.2 + 1);
				}
			}
		}
		for (const id of ages.keys()) if (!seen.has(id)) ages.delete(id);
	}

	/**
	 * Enderman.onSyncedDataUpdated: an enderman that turns creepy because a player stared at it screams, at most
	 * every 400 ticks (playStareSound, at its eyes).
	 */
	endermanStare(e) {
		const stares = this.stares || (this.stares = new Map());
		const state = stares.get(e.id) || { creepy: false, last: -Infinity };
		const creepy = !!(e.d && e.d.creepy);
		const age = Math.floor(e.age || 0);
		if (creepy && !state.creepy && e.d.staredAt && age >= state.last + 400) {
			state.last = age;
			this.local('minecraft:entity.enderman.stare', e.x, e.y + (e.h || 2.9) * 0.88, e.z, 'hostile', 2.5, 1);
		}
		state.creepy = creepy;
		stares.set(e.id, state);
		if (stares.size > 64) stares.delete(stares.keys().next().value);
	}

	/**
	 * GuardianAttackSoundInstance: while a guardian charges its beam a loop plays at it, heard at the same volume
	 * everywhere, louder (scale squared) and higher (0.7 + 0.5 scale) as the attack charges.
	 */
	guardianBeams(entities) {
		const beams = this.beamSounds || (this.beamSounds = new Map());
		const seen = new Set();
		for (const e of entities || []) {
			if ((e.type !== 'minecraft:guardian' && e.type !== 'minecraft:elder_guardian') || e.beam === undefined || e.dead) continue;
			seen.add(e.id);
			const duration = e.type === 'minecraft:elder_guardian' ? 60 : 80;
			const scale = Math.min(duration, Math.max(0, (e.age || 0) - (e.beamStart ?? e.age ?? 0))) / duration;
			let beam = beams.get(e.id);
			if (!beam) {
				beam = this.loop('minecraft:entity.guardian.attack', 0, { x: e.x, y: e.y, z: e.z });
				beams.set(e.id, beam);
			}
			this.setVolume(beam, scale * scale);
			this.setPitch(beam, 0.7 + 0.5 * scale);
			if (beam.panner) this.place(beam.panner, e.x, e.y, e.z);
			beam.at = { x: e.x, y: e.y, z: e.z };
		}
		for (const [id, beam] of beams) {
			if (!seen.has(id)) {
				this.stop(beam);
				beams.delete(id);
			}
		}
	}

	setPitch(handle, pitch) {
		if (!handle) return;
		handle.pitch = pitch;
		if (handle.source) handle.source.playbackRate.setTargetAtTime(Math.min(2, Math.max(0.5, pitch * handle.basePitch)), this.ctx.currentTime, 0.02);
	}

	/** Level.playLocalSound(entity, ...): a sound that follows the entity. */
	entityLocal(id, e, source, volume, pitch) {
		if (!this.enabled || !this.events || !this.ctx) return;
		this.play(id, source, volume, pitch, unseeded(), { x: e.x, y: e.y, z: e.z, entity: e.id });
	}

	/**
	 * ClientLevel.tick: when an End flash starts, its sound comes 30 ticks later from 10 blocks away in the flash's
	 * direction (DirectionalSoundInstance, no attenuation).
	 */
	endFlash({ camera, flash }) {
		const on = !!(flash && flash.intensity > 0);
		if (on && !this.flashOn) {
			const x = -flash.yAngle * Math.PI / 180 - Math.PI, pitch = -flash.xAngle * Math.PI / 180;
			const h = -Math.cos(pitch);
			const dx = Math.sin(x) * h, dy = Math.sin(pitch), dz = Math.cos(x) * h;
			this.play('minecraft:weather.end_flash', 'weather', 1, 1, unseeded(),
				{ x: camera.x + dx * 10, y: camera.y + dy * 10, z: camera.z + dz * 10, flat: true }, 1.5);
		}
		this.flashOn = on;
	}

	/** BiomeAmbientSoundsHandler.tick */
	biomeAmbience({ world, camera, ambience }) {
		const amb = ambience || {};
		for (const [id, loop] of this.loops) {
			// LoopSoundInstance.tick
			if (loop.fade < 0) {
				this.stop(loop.sound);
				this.loops.delete(id);
				continue;
			}
			loop.fade += loop.direction;
			this.setVolume(loop.sound, Math.min(1, Math.max(0, loop.fade / FADE_TICKS)));
		}
		const current = amb.loop || null;
		if (current !== this.previousLoop) {
			this.previousLoop = current;
			for (const loop of this.loops.values()) {
				loop.fade = Math.min(loop.fade, FADE_TICKS);
				loop.direction = -1;
			}
			if (current) {
				let loop = this.loops.get(current);
				if (!loop) {
					loop = { sound: this.loop(current, 0), fade: 0, direction: 0 };
					this.loops.set(current, loop);
				}
				loop.fade = Math.max(0, loop.fade);
				loop.direction = 1;
			}
		}
		for (const [id, chance] of amb.add || []) {
			if (Math.random() < chance) this.play(id, 'ambient', 1, 1, unseeded(), null);
		}
		const mood = amb.mood;
		if (!mood || !world) return;
		const [id, tickDelay, extent, offset] = mood;
		const span = extent * 2 + 1;
		const r = () => Math.floor(Math.random() * span);
		const bx = Math.floor(camera.x + r() - extent), by = Math.floor(camera.y + r() - extent), bz = Math.floor(camera.z + r() - extent);
		const [sky, block] = world.lightAt(bx, by, bz);
		if (sky > 0) this.moodiness -= sky / 15 * 0.001;
		else this.moodiness -= (block - 1) / tickDelay;
		if (this.moodiness >= 1) {
			const dx = bx + 0.5 - camera.x, dy = by + 0.5 - camera.y, dz = bz + 0.5 - camera.z;
			const distance = Math.hypot(dx, dy, dz) || 1;
			const d = distance + offset;
			this.play(id, 'ambient', 1, 1, unseeded(),
				{ x: camera.x + dx / distance * d, y: camera.y + dy / distance * d, z: camera.z + dz / distance * d });
			this.moodiness = 0;
		} else {
			this.moodiness = Math.max(this.moodiness, 0);
		}
	}

	/**
	 * LocalPlayer.updateIsUnderwater (enter and exit sounds, the underwater loop: UnderLiquidAmbientSoundInstance)
	 * and UnderwaterAmbientSoundHandler (its additions, which stop when the camera leaves the water).
	 */
	underwaterAmbience({ camera, inWater }) {
		if (this.wasUnderwater !== null && inWater !== this.wasUnderwater) {
			this.local(inWater ? 'minecraft:ambient.underwater.enter' : 'minecraft:ambient.underwater.exit',
				camera.x, camera.y, camera.z, 'ambient', 1, 1);
			if (inWater && !this.underwater) this.underwater = { sound: this.loop('minecraft:ambient.underwater.loop', 0), fade: 0 };
		}
		this.wasUnderwater = inWater;
		const loop = this.underwater;
		if (loop) {
			if (loop.fade < 0) {
				this.stop(loop.sound);
				this.underwater = null;
			} else {
				loop.fade = Math.min(inWater ? loop.fade + 1 : loop.fade - 2, FADE_TICKS);
				this.setVolume(loop.sound, Math.max(0, Math.min(1, loop.fade / FADE_TICKS)));
			}
		}
		if (!inWater) {
			for (const sound of this.subSounds) this.stop(sound);
			this.subSounds.clear();
		}
		this.underwaterDelay--;
		if (this.underwaterDelay <= 0 && inWater) {
			const rand = Math.random();
			const id = rand < 1e-4 ? 'minecraft:ambient.underwater.loop.additions.ultra_rare'
				: rand < 0.001 ? 'minecraft:ambient.underwater.loop.additions.rare'
					: rand < 0.01 ? 'minecraft:ambient.underwater.loop.additions' : null;
			if (id) {
				this.underwaterDelay = 0;
				this.play(id, 'ambient', 1, 1, unseeded(), null, 0, sound => {
					this.subSounds.add(sound);
					sound.source.addEventListener('ended', () => this.subSounds.delete(sound));
				});
			}
		}
	}

	/** BubbleColumnAmbientSoundHandler: a whoosh when the camera enters a bubble column. */
	bubbleColumn({ camera, block }) {
		const name = block && block.n;
		const inColumn = name === 'minecraft:bubble_column';
		if (inColumn && !this.wasInBubbleColumn && !this.firstBubbleTick) {
			const down = /(^|,)drag=true/.test(block.s || '');
			this.local(down ? 'minecraft:block.bubble_column.whirlpool_inside' : 'minecraft:block.bubble_column.upwards_inside',
				camera.x, camera.y, camera.z, 'ambient', 1, 1);
		}
		this.wasInBubbleColumn = inColumn;
		this.firstBubbleTick = false;
	}

	/**
	 * A looping sound: at the listener (relative, like the game's ambient loops), or at a place with no
	 * attenuation (at: {x, y, z}); its volume (and pitch) are set every tick.
	 */
	loop(id, volume, at = null) {
		const handle = { volume, pitch: 1, source: null, node: null, panner: null, stopped: false, basePitch: 1, at };
		const sound = this.pick(this.events[id], unseeded());
		if (!sound || !sound.name) return handle;
		handle.scale = sample(sound.volume ?? 1, unseeded());
		const pitch = sample(sound.pitch ?? 1, unseeded());
		handle.basePitch = pitch;
		const [ns, path] = sound.name.includes(':') ? sound.name.split(':') : ['minecraft', sound.name];
		this.buffer(ns + '/' + path).then(buffer => {
			if (!buffer || !this.enabled || handle.stopped) return;
			const ctx = this.ctx;
			const node = ctx.createBufferSource();
			node.buffer = buffer;
			node.loop = true;
			node.playbackRate.value = Math.min(2, Math.max(0.5, pitch * handle.pitch));
			const gain = ctx.createGain();
			gain.gain.value = Math.min(1, handle.volume * handle.scale);
			if (handle.at) {
				// Attenuation.NONE: heard from its direction at the same volume everywhere
				const panner = ctx.createPanner();
				panner.panningModel = 'equalpower';
				panner.distanceModel = 'linear';
				panner.rolloffFactor = 0;
				this.place(panner, handle.at.x, handle.at.y, handle.at.z);
				handle.panner = panner;
				node.connect(gain).connect(panner).connect(this.master);
			} else {
				node.connect(gain).connect(this.master);
			}
			handle.source = node;
			handle.node = gain;
			node.start();
		});
		return handle;
	}

	setVolume(handle, volume) {
		if (!handle) return;
		handle.volume = volume;
		if (handle.node) handle.node.gain.setTargetAtTime(Math.min(1, volume * handle.scale), this.ctx.currentTime, 0.02);
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
				// SimpleSoundInstance.forJukeboxSong: records, volume 4, at the block's centre
				const [, id, x, y, z] = fx;
				this.jukebox(id, x, y, z);
				break;
			}
			case 'jx': {
				// stopped: kept as stopped until the next song, so the section's song is not started again
				const key = fx[1] + ',' + fx[2] + ',' + fx[3];
				this.stop(this.jukeboxes.get(key));
				this.jukeboxes.set(key, { stopped: true });
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

	/** SoundEngine.play for a SimpleSoundInstance at a position (at: null for a sound at the listener). */
	play(id, source, volume, pitch, random, at, wait = 0, started = null, offset = 0) {
		const sound = this.pick(this.events[id], random);
		if (!sound || !sound.name) return;
		const instanceVolume = volume * sample(sound.volume ?? 1, random);
		const instancePitch = pitch * sample(sound.pitch ?? 1, random);
		const gain = Math.min(1, Math.max(0, instanceVolume));
		if (gain <= 0) return;
		const attenuation = Math.max(instanceVolume, 1) * (sound.attenuation_distance ?? 16);
		if (at && at.entity === undefined && !at.flat && Math.hypot(at.x - this.listener.x, at.y - this.listener.y, at.z - this.listener.z) > attenuation) return;
		const [ns, path] = sound.name.includes(':') ? sound.name.split(':') : ['minecraft', sound.name];
		this.buffer(ns + '/' + path).then(buffer => {
			if (!buffer || !this.enabled || offset >= buffer.duration) return;
			if (this.playing.size >= MAX_PLAYING) {
				// the oldest sound makes room, never a song
				let oldest = null;
				for (const sound of this.playing) {
					if (!sound.record) {
						oldest = sound;
						break;
					}
				}
				this.stop(oldest);
			}
			const ctx = this.ctx;
			const node = ctx.createBufferSource();
			node.buffer = buffer;
			node.playbackRate.value = Math.min(2, Math.max(0.5, instancePitch));
			const volumeNode = ctx.createGain();
			volumeNode.gain.value = gain;
			let panner = null;
			if (at) {
				panner = ctx.createPanner();
				panner.panningModel = 'equalpower';
				panner.distanceModel = 'linear';
				panner.refDistance = 0;
				panner.maxDistance = attenuation;
				// Attenuation.NONE: heard from its direction at full volume
				panner.rolloffFactor = at.flat ? 0 : 1;
				this.place(panner, at.x, at.y, at.z);
				node.connect(volumeNode).connect(panner).connect(this.master);
			} else {
				// relative sounds at the listener (Attenuation.NONE): the same volume everywhere
				node.connect(volumeNode).connect(this.master);
			}
			const playing = { source: node, panner, entity: at ? at.entity : undefined, record: source === 'record' || source === 'music' };
			this.playing.add(playing);
			node.onended = () => {
				playing.ended = true;
				this.playing.delete(playing);
			};
			node.start(ctx.currentTime + wait, offset);
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
		sound.stopped = true;
		try {
			if (sound.source) sound.source.stop();
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
