// The blocks, light and biomes around a camera as the server streams them, and
// the pool of Web Workers that turns sections into meshes (mesher.js). The page
// itself only stores data and uploads finished vertex buffers, so block updates
// never make the picture stutter.

import { describeState, PAD, UNKNOWN } from './mesher.js';
import { parseProps } from './models.js';
import { blockFaceColors } from './blocks.js';
import { BLOCK_ENTITY_NAMES } from './mobs.js';

export { STRIDE } from './mesher.js';

/** Block entities drawn by the entity renderer (the mesher leaves them out). */
export const BLOCK_ENTITY_BLOCKS = BLOCK_ENTITY_NAMES;

const EMPTY_BIOMES = new Uint16Array(64);

/** Beyond this distance sections are meshed with less detail (no small plants, "fast" leaves). */
const LOD_DISTANCE = 112;

function decodeRuns(b64, fill) {
	const binary = atob(b64);
	let pos = 0, i = 0;
	const read = () => {
		let value = 0, shift = 0, b;
		do {
			b = binary.charCodeAt(pos++);
			value |= (b & 0x7f) << shift;
			shift += 7;
		} while (b & 0x80);
		return value;
	};
	while (pos < binary.length && i < 4096) {
		const run = read();
		const value = read();
		fill(i, Math.min(run, 4096 - i), value);
		i += run;
	}
}

export class World {
	constructor(onMesh) {
		this.onMesh = onMesh;
		this.infos = [];
		this.entries = [];
		this.biomeIndex = new Map();
		this.biomeNames = [];
		this.biomeDefs = {};
		this.defaultSky = 15;
		this.config = { cardinal: 'default', zoomSeed: '0', smooth: true };
		this.jobId = 0;
		this.generation = 0;
		this.assetsPayload = null;
		this.workers = [];
		this.reportedErrors = new Set();
		const count = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
		for (let i = 0; i < count; i++) this.addWorker();
		this.reset([0, 0, 0]);
	}

	addWorker() {
		const worker = new Worker(new URL('./mesher-worker.js', import.meta.url), { type: 'module' });
		const slot = { worker, busy: 0 };
		worker.onmessage = event => this.onWorkerMessage(slot, event.data);
		worker.onerror = event => console.error('CCTV mesher worker failed', event.message);
		this.workers.push(slot);
		// A new worker needs everything the others already know.
		if (this.entries.length) worker.postMessage({ type: 'palette', entries: this.entries });
		worker.postMessage({ type: 'config', ...this.workerConfig() });
		if (this.assetsPayload) worker.postMessage({ type: 'assets', ...this.assetsPayload });
	}

	broadcast(message) {
		for (const slot of this.workers) slot.worker.postMessage(message);
	}

	workerConfig() {
		return {
			biomeNames: this.biomeNames,
			biomeDefs: this.biomeDefs,
			cardinal: this.config.cardinal,
			zoomSeed: this.config.zoomSeed,
			smooth: this.config.smooth,
			blockEntities: BLOCK_ENTITY_BLOCKS,
		};
	}

	/** Clears all blocks (camera moved or reconnected). The palette survives: ids are global while the server runs. */
	reset(origin) {
		this.origin = origin;
		this.sections = new Map();
		/** Sign text by section key (from the "be" list of sections). */
		this.signs = new Map();
		this.dirty = new Set();
		this.generation++;
		this.pending = new Map();
		this.eye = [0, 0, 0];
	}

	/** Dimension settings from "init". */
	setDimension(dim) {
		this.defaultSky = dim && dim.hasSky === false ? 0 : 15;
		this.config.cardinal = dim && dim.cardinal || 'default';
		this.config.zoomSeed = dim && dim.zoomSeed || '0';
		this.broadcast({ type: 'config', ...this.workerConfig() });
	}

	setBiomes(defs) {
		this.biomeDefs = defs || {};
		for (const name of Object.keys(this.biomeDefs)) this.biomeId(name);
		this.broadcast({ type: 'config', biomeNames: this.biomeNames, biomeDefs: this.biomeDefs });
	}

	setSmoothLighting(smooth) {
		this.config.smooth = smooth;
		this.broadcast({ type: 'config', smooth });
		this.markAllDirty();
	}

	biomeId(name) {
		let id = this.biomeIndex.get(name);
		if (id === undefined) {
			id = this.biomeNames.length;
			this.biomeNames.push(name);
			this.biomeIndex.set(name, id);
			this.biomeNamesChanged = true;
		}
		return id;
	}

	/** Client assets are ready: hand the models and sprites to the workers and rebuild everything. */
	setAssets(assets) {
		this.assets = assets;
		this.assetsPayload = assets.workerPayload();
		this.broadcast({ type: 'assets', ...this.assetsPayload });
		this.markAllDirty();
	}

	addPalette(entries) {
		for (const entry of entries) {
			this.entries.push(entry);
			this.infos[entry.id] = describeState(entry, parseProps, blockFaceColors);
		}
		this.broadcast({ type: 'palette', entries });
	}

	static key(x, y, z) {
		return x + ',' + y + ',' + z;
	}

	setSection(message) {
		const states = new Uint16Array(4096);
		decodeRuns(message.r, (i, run, index) => states.fill(message.p[index], i, i + run));

		const light = new Uint8Array(4096);
		if (message.sl) decodeRuns(message.sl, (i, run, value) => light.fill(value << 4, i, i + run));
		else light.fill(this.defaultSky << 4);
		if (message.bl) {
			decodeRuns(message.bl, (i, run, value) => {
				if (value) for (let k = i; k < i + run; k++) light[k] |= value;
			});
		}

		let biomes = EMPTY_BIOMES;
		const palette = (message.bp || ['minecraft:plains']).map(name => this.biomeId(name));
		if (palette.length === 1) {
			biomes = new Uint16Array(64).fill(palette[0]);
		} else if (message.bi) {
			const raw = atob(message.bi);
			biomes = new Uint16Array(64);
			for (let i = 0; i < 64; i++) biomes[i] = palette[raw.charCodeAt(i)] ?? palette[0];
		}
		if (this.biomeNamesChanged) {
			this.biomeNamesChanged = false;
			this.broadcast({ type: 'config', biomeNames: this.biomeNames });
		}

		const key = World.key(message.x, message.y, message.z);
		const signs = (message.be || []).filter(be => be.k === 'sign');
		if (signs.length) this.signs.set(key, signs);
		else this.signs.delete(key);
		this.sections.set(key, {
			key, x: message.x, y: message.y, z: message.z,
			states, light, biomes,
			version: (this.sections.get(key)?.version || 0) + 1,
			blockEntities: this.sections.get(key)?.blockEntities || [],
		});
		this.markDirty(message.x, message.y, message.z);
	}

	setBlock(x, y, z, id) {
		const sx = x >> 4, sy = y >> 4, sz = z >> 4;
		const section = this.sections.get(World.key(sx, sy, sz));
		if (!section) return;
		section.states[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] = id;
		// Smooth lighting, culling and fluids look at neighbours, so rebuild the touching sections too.
		const lx = x & 15, ly = y & 15, lz = z & 15;
		for (let dx = -1; dx <= 1; dx++) {
			if ((dx === -1 && lx > 1) || (dx === 1 && lx < 14)) continue;
			for (let dy = -1; dy <= 1; dy++) {
				if ((dy === -1 && ly > 1) || (dy === 1 && ly < 14)) continue;
				for (let dz = -1; dz <= 1; dz++) {
					if ((dz === -1 && lz > 1) || (dz === 1 && lz < 14)) continue;
					this.touch(sx + dx, sy + dy, sz + dz);
				}
			}
		}
	}

	touch(sx, sy, sz) {
		const key = World.key(sx, sy, sz);
		const section = this.sections.get(key);
		if (section) {
			section.version++;
			this.dirty.add(key);
		}
	}

	markDirty(sx, sy, sz) {
		for (let dx = -1; dx <= 1; dx++) {
			for (let dy = -1; dy <= 1; dy++) {
				for (let dz = -1; dz <= 1; dz++) this.touch(sx + dx, sy + dy, sz + dz);
			}
		}
	}

	markAllDirty() {
		for (const section of this.sections.values()) {
			section.version++;
			this.dirty.add(section.key);
		}
	}

	// --- queries (entity lighting, shadows, labels, weather) ---

	getBlockId(x, y, z) {
		const section = this.sections.get(World.key(x >> 4, y >> 4, z >> 4));
		if (!section) return -1;
		return section.states[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)];
	}

	infoAt(x, y, z) {
		const id = this.getBlockId(x, y, z);
		return id < 0 ? null : this.infos[id] || null;
	}

	/** [sky, block] light at a block (the dimension's default for unknown places). */
	lightAt(x, y, z) {
		const section = this.sections.get(World.key(x >> 4, y >> 4, z >> 4));
		if (!section) return [this.defaultSky, 0];
		const v = section.light[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)];
		return [v >> 4, v & 15];
	}

	/**
	 * Is the straight line between two world positions blocked by an opaque block? (voxel walk, Amanatides & Woo)
	 * The block containing `to` does not count.
	 */
	occluded(from, to) {
		let x = Math.floor(from[0]), y = Math.floor(from[1]), z = Math.floor(from[2]);
		const tx = Math.floor(to[0]), ty = Math.floor(to[1]), tz = Math.floor(to[2]);
		const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
		const stepX = Math.sign(dx), stepY = Math.sign(dy), stepZ = Math.sign(dz);
		const inv = v => (v === 0 ? Infinity : Math.abs(1 / v));
		const tdx = inv(dx), tdy = inv(dy), tdz = inv(dz);
		const frac = (p, step) => (step > 0 ? Math.floor(p) + 1 - p : p - Math.floor(p));
		let tmx = stepX ? frac(from[0], stepX) * tdx : Infinity;
		let tmy = stepY ? frac(from[1], stepY) * tdy : Infinity;
		let tmz = stepZ ? frac(from[2], stepZ) * tdz : Infinity;
		for (let i = 0; i < 2048; i++) {
			if (x === tx && y === ty && z === tz) return false;
			if (tmx <= tmy && tmx <= tmz) {
				if (tmx > 1) return false;
				x += stepX; tmx += tdx;
			} else if (tmy <= tmz) {
				if (tmy > 1) return false;
				y += stepY; tmy += tdy;
			} else {
				if (tmz > 1) return false;
				z += stepZ; tmz += tdz;
			}
			if (x === tx && y === ty && z === tz) return false;
			const info = this.infoAt(x, y, z);
			if (info && info.opaque && info.fullCollision) return true;
		}
		return false;
	}

	biomeNameAt(x, y, z) {
		const section = this.sections.get(World.key(x >> 4, y >> 4, z >> 4));
		if (!section) return null;
		return this.biomeNames[section.biomes[(((y & 15) >> 2) << 4) | (((z & 15) >> 2) << 2) | ((x & 15) >> 2)]] || null;
	}

	// --- meshing ---

	/** Sends dirty sections (nearest first) to idle workers. */
	update(eye) {
		this.eye = eye;
		if (this.dirty.size === 0) return;
		const maxPerWorker = 2;
		let free = 0;
		for (const slot of this.workers) free += Math.max(0, maxPerWorker - slot.busy);
		if (free === 0) return;

		const o = this.origin;
		const candidates = [];
		for (const key of this.dirty) {
			if (this.pending.has(key)) continue;
			const section = this.sections.get(key);
			if (!section) {
				this.dirty.delete(key);
				this.onMesh(key, null, null);
				continue;
			}
			const dx = section.x * 16 + 8 - o[0] - eye[0], dy = section.y * 16 + 8 - o[1] - eye[1], dz = section.z * 16 + 8 - o[2] - eye[2];
			candidates.push([dx * dx + dy * dy + dz * dz, section]);
		}
		candidates.sort((a, b) => a[0] - b[0]);
		for (const [, section] of candidates) {
			const slot = this.workers.reduce((best, s) => (s.busy < best.busy ? s : best));
			if (slot.busy >= maxPerWorker) break;
			this.dispatch(slot, section);
		}
	}

	dispatch(slot, section) {
		this.dirty.delete(section.key);
		const id = ++this.jobId;
		const job = this.buildJob(section);
		this.pending.set(section.key, { id, version: section.version, generation: this.generation });
		slot.busy++;
		slot.worker.postMessage({ type: 'mesh', id, key: section.key, version: section.version, job },
			[job.pad.buffer, job.light.buffer, job.biomes.buffer]);
	}

	onWorkerMessage(slot, message) {
		slot.busy = Math.max(0, slot.busy - 1);
		const pending = this.pending.get(message.key);
		if (!pending || pending.id !== message.id) return;
		this.pending.delete(message.key);
		if (message.type === 'error') {
			console.error('CCTV: meshing failed for section', message.key, message.error);
			return;
		}
		for (const error of message.errors || []) {
			if (this.reportedErrors.has(error.split(':')[0])) continue;
			this.reportedErrors.add(error.split(':')[0]);
			console.warn('CCTV: block drawn as a plain box, its model failed:', error);
		}
		const section = this.sections.get(message.key);
		if (!section || pending.generation !== this.generation) return;
		if (section.version !== message.version) {
			// Changed while meshing: build it again.
			this.dirty.add(message.key);
			return;
		}
		const be = message.blockEntities;
		section.blockEntities = [];
		for (let i = 0; i < be.length; i += 4) section.blockEntities.push({ x: be[i], y: be[i + 1], z: be[i + 2], info: this.infos[be[i + 3]] });
		this.onMesh(message.key, section, message);
	}

	/** The section plus a one block border from its neighbours, and the biome cells around it. */
	buildJob(section) {
		const pad = new Uint16Array(PAD * PAD * PAD).fill(UNKNOWN);
		const light = new Uint8Array(PAD * PAD * PAD).fill(this.defaultSky << 4);
		for (let dy = -1; dy <= 1; dy++) {
			for (let dz = -1; dz <= 1; dz++) {
				for (let dx = -1; dx <= 1; dx++) {
					const other = this.sections.get(World.key(section.x + dx, section.y + dy, section.z + dz));
					if (!other) continue;
					const x0 = dx === -1 ? 15 : 0, x1 = dx === 1 ? 0 : 15;
					const y0 = dy === -1 ? 15 : 0, y1 = dy === 1 ? 0 : 15;
					const z0 = dz === -1 ? 15 : 0, z1 = dz === 1 ? 0 : 15;
					const count = x1 - x0 + 1;
					for (let y = y0; y <= y1; y++) {
						const py = y + 1 + dy * 16;
						for (let z = z0; z <= z1; z++) {
							const pz = z + 1 + dz * 16;
							const src = (y << 8) | (z << 4) | x0;
							const dst = (py * PAD + pz) * PAD + x0 + 1 + dx * 16;
							pad.set(other.states.subarray(src, src + count), dst);
							light.set(other.light.subarray(src, src + count), dst);
						}
					}
				}
			}
		}

		const biomes = new Uint16Array(216).fill(UNKNOWN);
		const cx0 = section.x * 4 - 1, cy0 = section.y * 4 - 1, cz0 = section.z * 4 - 1;
		for (let gy = 0; gy < 6; gy++) {
			for (let gz = 0; gz < 6; gz++) {
				for (let gx = 0; gx < 6; gx++) {
					const cx = cx0 + gx, cy = cy0 + gy, cz = cz0 + gz;
					const other = this.sections.get(World.key(cx >> 2, cy >> 2, cz >> 2));
					if (other) biomes[(gy * 6 + gz) * 6 + gx] = other.biomes[((cy & 3) << 4) | ((cz & 3) << 2) | (cx & 3)];
				}
			}
		}

		const o = this.origin;
		const base = [section.x * 16 - o[0], section.y * 16 - o[1], section.z * 16 - o[2]];
		const distance = Math.hypot(base[0] + 8 - this.eye[0], base[1] + 8 - this.eye[1], base[2] + 8 - this.eye[2]);
		return {
			sx: section.x, sy: section.y, sz: section.z,
			base,
			eye: this.eye,
			hide: [Math.floor(this.eye[0] + o[0]), Math.floor(this.eye[1] + o[1]), Math.floor(this.eye[2] + o[2])],
			lod: distance > LOD_DISTANCE ? 1 : 0,
			pad, light, biomes,
		};
	}
}
