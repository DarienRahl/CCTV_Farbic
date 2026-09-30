// Sections kept in the browser (IndexedDB), so reopening a camera shows its world at once: after "init" the
// viewer tells the server which sections it has (position and a hash of the section message); the server
// answers "keep" for the ones that did not change and sends only the others.

const DB_NAME = 'cctv-sections';
const STORE = 'sections';
/** Sections kept at most; the ones stored longest ago go first. */
const MAX_SECTIONS = 60000;
const WRITE_DELAY_MS = 1500;

/** cyrb53: a 53 bit hash of the section message, the same on the server (SectionCapture.hash). */
export function hash53(text) {
	let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function request(req) {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

export class SectionCache {
	constructor() {
		this.db = null;
		this.opening = null;
		/** "x,y,z" -> {h, data} of the sections loaded for this camera */
		this.loaded = new Map();
		this.dimension = null;
		this.writes = new Map();
		this.writeTimer = null;
		this.seen = new Set();
	}

	/** False where IndexedDB is missing or blocked (private windows of some browsers). */
	get available() {
		return typeof indexedDB !== 'undefined';
	}

	open() {
		if (!this.opening) {
			this.opening = new Promise(resolve => {
				try {
					const req = indexedDB.open(DB_NAME, 1);
					req.onupgradeneeded = () => {
						const store = req.result.createObjectStore(STORE, { keyPath: ['d', 'x', 'y', 'z'] });
						store.createIndex('t', 't');
					};
					req.onsuccess = () => { this.db = req.result; resolve(this.db); };
					req.onerror = () => resolve(null);
					req.onblocked = () => resolve(null);
				} catch (e) {
					resolve(null);
				}
			});
		}
		return this.opening;
	}

	/**
	 * The cached sections of a dimension within `range` sections (horizontally) of the camera's section:
	 * resolves to [[x, y, z, h], ...] for the server, keeping their messages for "keep".
	 */
	async load(dimension, center, range) {
		this.flush();
		this.loaded = new Map();
		this.seen = new Set();
		this.dimension = dimension;
		const db = await this.open();
		if (!db) return [];
		try {
			const [cx, , cz] = center;
			const lower = [dimension, cx - range, -Infinity, -Infinity];
			const upper = [dimension, cx + range, Infinity, Infinity];
			const records = await request(db.transaction(STORE).objectStore(STORE).getAll(IDBKeyRange.bound(lower, upper)));
			if (this.dimension !== dimension) return [];
			const manifest = [];
			for (const r of records) {
				if (Math.abs(r.z - cz) > range) continue;
				this.loaded.set(r.x + ',' + r.y + ',' + r.z, r);
				manifest.push([r.x, r.y, r.z, r.h]);
			}
			return manifest;
		} catch (e) {
			return [];
		}
	}

	/** The cached message of a section the server said is unchanged, or null. */
	take(x, y, z) {
		const key = x + ',' + y + ',' + z;
		const record = this.loaded.get(key);
		if (!record) return null;
		// not written again: the time a section was last stored ages the cache, reading it does not
		this.seen.add(key);
		return record.data;
	}

	/** A section message as the server sent it (the raw text), stored a moment later with others. */
	store(x, y, z, data) {
		if (!this.dimension) return;
		this.seen.add(x + ',' + y + ',' + z);
		this.put(x, y, z, hash53(data), data);
	}

	put(x, y, z, h, data) {
		this.writes.set(x + ',' + y + ',' + z, { d: this.dimension, x, y, z, h, data, t: Date.now() });
		if (!this.writeTimer) this.writeTimer = setTimeout(() => this.flush(), WRITE_DELAY_MS);
	}

	flush() {
		clearTimeout(this.writeTimer);
		this.writeTimer = null;
		if (!this.db || this.writes.size === 0) return;
		const records = [...this.writes.values()];
		this.writes.clear();
		try {
			const store = this.db.transaction(STORE, 'readwrite').objectStore(STORE);
			for (const r of records) store.put(r);
		} catch (e) {
			// quota or a closed database: the viewer works without the cache
		}
	}

	/**
	 * The download is complete: cached sections the server neither kept nor sent are gone (empty now or out of
	 * range) and are deleted; then the oldest sections beyond the limit.
	 */
	async finish() {
		this.flush();
		const db = this.db;
		if (!db) return;
		try {
			const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
			for (const [key, r] of this.loaded) {
				if (!this.seen.has(key)) store.delete([r.d, r.x, r.y, r.z]);
			}
			this.loaded = new Map();
			const count = await request(db.transaction(STORE).objectStore(STORE).count());
			if (count > MAX_SECTIONS) {
				const excess = count - MAX_SECTIONS;
				const tx = db.transaction(STORE, 'readwrite');
				let removed = 0;
				tx.objectStore(STORE).index('t').openCursor().onsuccess = e => {
					const cursor = e.target.result;
					if (!cursor || removed >= excess) return;
					cursor.delete();
					removed++;
					cursor.continue();
				};
			}
		} catch (e) {
			// the cache is only a speed-up
		}
	}
}
