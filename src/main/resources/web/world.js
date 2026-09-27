// Block storage for the area a camera sees, plus the mesher that turns
// 16x16x16 sections into vertex data (face culling + ambient occlusion).

import {
	classify, KIND_NONE, KIND_CUBE, KIND_BOXES, KIND_CROSS,
	MATERIAL_WATER, MATERIAL_EMISSIVE, MATERIAL_PLANT, WATER_COLOR, LAVA_COLOR,
} from './blocks.js';

export const STRIDE = 20; // bytes per vertex: 3 x f32 position, 4 x u8 colour+brightness, 4 x u8 material/face/light/unused

// Faces: up, down, north(-z), south(+z), west(-x), east(+x). Corners are counter-clockwise seen from outside.
const FACES = [
	{ n: [0, 1, 0], c: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
	{ n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
	{ n: [0, 0, -1], c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] },
	{ n: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
	{ n: [-1, 0, 0], c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
	{ n: [1, 0, 0], c: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] },
];
const FACE_SHADE = [1.0, 0.5, 0.8, 0.8, 0.6, 0.6];
const AO_LEVEL = [0.5, 0.68, 0.84, 1.0];
const PAD = 18;

function padIndex(x, y, z) {
	return (y * PAD + z) * PAD + x;
}

// For every face corner: padded-index offsets of (side1, side2, corner) in front of the face.
const AO_OFFSETS = FACES.map(face => face.c.map(corner => {
	const axes = [0, 1, 2].filter(a => face.n[a] === 0);
	const d1 = [...face.n];
	const d2 = [...face.n];
	const d3 = [...face.n];
	d1[axes[0]] += corner[axes[0]] ? 1 : -1;
	d2[axes[1]] += corner[axes[1]] ? 1 : -1;
	d3[axes[0]] += corner[axes[0]] ? 1 : -1;
	d3[axes[1]] += corner[axes[1]] ? 1 : -1;
	return [d1, d2, d3].map(d => padIndex(d[0], d[1], d[2]) - padIndex(0, 0, 0));
}));
const NEIGHBOR_OFFSETS = FACES.map(f => padIndex(f.n[0], f.n[1], f.n[2]) - padIndex(0, 0, 0));

class VertexWriter {
	constructor() {
		this.capacity = 0;
		this.count = 0;
		this.grow(8192);
	}

	grow(min) {
		let capacity = Math.max(this.capacity * 2, 8192);
		while (capacity < min) capacity *= 2;
		const buffer = new ArrayBuffer(capacity * STRIDE);
		if (this.u8) new Uint8Array(buffer).set(this.u8.subarray(0, this.count * STRIDE));
		this.buffer = buffer;
		this.f32 = new Float32Array(buffer);
		this.u8 = new Uint8Array(buffer);
		this.capacity = capacity;
	}

	reset() {
		this.count = 0;
	}

	vertex(x, y, z, color, brightness, material, face, light) {
		if (this.count >= this.capacity) this.grow(this.count + 1);
		const v = this.count++;
		const f = v * 5;
		const b = v * STRIDE;
		this.f32[f] = x;
		this.f32[f + 1] = y;
		this.f32[f + 2] = z;
		this.u8[b + 12] = color[0] * 255;
		this.u8[b + 13] = color[1] * 255;
		this.u8[b + 14] = color[2] * 255;
		this.u8[b + 15] = Math.min(255, brightness * 255);
		this.u8[b + 16] = material;
		this.u8[b + 17] = face;
		this.u8[b + 18] = light;
	}

	data() {
		return this.u8.subarray(0, this.count * STRIDE);
	}
}

export class World {
	constructor() {
		this.infos = [];
		this.writers = { opaque: new VertexWriter(), translucent: new VertexWriter() };
		this.pad = new Int32Array(PAD * PAD * PAD);
		this.reset([0, 0, 0]);
	}

	/** Clears all blocks. The palette survives: ids are global and stable while the server runs. */
	reset(origin) {
		this.origin = origin;
		this.sections = new Map();
		this.dirty = new Set();
	}

	static key(x, y, z) {
		return x + ',' + y + ',' + z;
	}

	addPalette(entries) {
		for (const entry of entries) {
			this.infos[entry.id] = classify(entry);
		}
	}

	setSection(message) {
		const states = new Int32Array(4096);
		const palette = message.p;
		const bytes = Uint8Array.from(atob(message.r), c => c.charCodeAt(0));
		let pos = 0;
		let i = 0;
		const readVarInt = () => {
			let value = 0;
			let shift = 0;
			let b;
			do {
				b = bytes[pos++];
				value |= (b & 0x7f) << shift;
				shift += 7;
			} while (b & 0x80);
			return value;
		};
		while (pos < bytes.length && i < 4096) {
			const run = readVarInt();
			const id = palette[readVarInt()];
			states.fill(id, i, Math.min(4096, i + run));
			i += run;
		}

		const key = World.key(message.x, message.y, message.z);
		const old = this.sections.get(key);
		const section = { x: message.x, y: message.y, z: message.z, states, mesh: old ? old.mesh : null };
		this.sections.set(key, section);
		this.markDirty(message.x, message.y, message.z, true);
	}

	setBlock(x, y, z, id) {
		const sx = x >> 4, sy = y >> 4, sz = z >> 4;
		const section = this.sections.get(World.key(sx, sy, sz));
		if (!section) return;
		const lx = x & 15, ly = y & 15, lz = z & 15;
		section.states[(ly << 8) | (lz << 4) | lx] = id;
		this.dirty.add(World.key(sx, sy, sz));
		// Neighbours only need a rebuild when the block sits on the border.
		for (let dx = -1; dx <= 1; dx++) {
			for (let dy = -1; dy <= 1; dy++) {
				for (let dz = -1; dz <= 1; dz++) {
					if ((dx === -1 && lx !== 0) || (dx === 1 && lx !== 15)) continue;
					if ((dy === -1 && ly !== 0) || (dy === 1 && ly !== 15)) continue;
					if ((dz === -1 && lz !== 0) || (dz === 1 && lz !== 15)) continue;
					const k = World.key(sx + dx, sy + dy, sz + dz);
					if (this.sections.has(k)) this.dirty.add(k);
				}
			}
		}
	}

	markDirty(sx, sy, sz, withNeighbors) {
		this.dirty.add(World.key(sx, sy, sz));
		if (!withNeighbors) return;
		for (let dx = -1; dx <= 1; dx++) {
			for (let dy = -1; dy <= 1; dy++) {
				for (let dz = -1; dz <= 1; dz++) {
					const k = World.key(sx + dx, sy + dy, sz + dz);
					if (this.sections.has(k)) this.dirty.add(k);
				}
			}
		}
	}

	/** Returns the block state id at world coordinates, or -1 if unknown. */
	getBlock(x, y, z) {
		const section = this.sections.get(World.key(x >> 4, y >> 4, z >> 4));
		if (!section) return -1;
		return section.states[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)];
	}

	/** Copies the section and a one block border from its neighbours into the padded buffer. */
	fillPad(section) {
		const pad = this.pad;
		pad.fill(-1);
		for (let dy = -1; dy <= 1; dy++) {
			for (let dz = -1; dz <= 1; dz++) {
				for (let dx = -1; dx <= 1; dx++) {
					const other = this.sections.get(World.key(section.x + dx, section.y + dy, section.z + dz));
					if (!other) continue;
					const states = other.states;
					const x0 = dx === -1 ? 15 : 0, x1 = dx === 1 ? 0 : 15;
					const y0 = dy === -1 ? 15 : 0, y1 = dy === 1 ? 0 : 15;
					const z0 = dz === -1 ? 15 : 0, z1 = dz === 1 ? 0 : 15;
					for (let y = y0; y <= y1; y++) {
						const py = y + 1 + dy * 16;
						for (let z = z0; z <= z1; z++) {
							const pz = z + 1 + dz * 16;
							const src = (y << 8) | (z << 4);
							let dst = padIndex(x0 + 1 + dx * 16, py, pz);
							for (let x = x0; x <= x1; x++) {
								pad[dst++] = states[src | x];
							}
						}
					}
				}
			}
		}
	}

	/**
	 * Builds vertex data for one section.
	 * @returns {{opaque: Uint8Array, translucent: Uint8Array}} views into reused buffers (copy or upload immediately)
	 */
	mesh(section) {
		this.fillPad(section);
		const pad = this.pad;
		const infos = this.infos;
		const opaque = this.writers.opaque;
		const translucent = this.writers.translucent;
		opaque.reset();
		translucent.reset();

		const ox = section.x * 16 - this.origin[0];
		const oy = section.y * 16 - this.origin[1];
		const oz = section.z * 16 - this.origin[2];

		const isOpaque = id => {
			if (id < 0) return false;
			const info = infos[id];
			return info !== undefined && info.opaque;
		};

		for (let y = 0; y < 16; y++) {
			for (let z = 0; z < 16; z++) {
				for (let x = 0; x < 16; x++) {
					const p = padIndex(x + 1, y + 1, z + 1);
					const id = pad[p];
					if (id < 0) continue;
					const info = infos[id];
					if (info === undefined) continue;
					const bx = ox + x, by = oy + y, bz = oz + z;

					if (info.kind === KIND_CUBE) {
						this.cube(info, id, p, bx, by, bz, isOpaque, info.translucent ? translucent : opaque);
					} else if (info.kind === KIND_BOXES) {
						this.boxes(info, p, bx, by, bz, isOpaque, info.translucent ? translucent : opaque);
					} else if (info.kind === KIND_CROSS) {
						this.cross(info, bx, by, bz, opaque);
					}

					if (info.water || info.lava) {
						this.fluid(info, p, bx, by, bz, isOpaque, info.water ? translucent : opaque);
					}
				}
			}
		}

		return { opaque: opaque.data(), translucent: translucent.data() };
	}

	cube(info, id, p, bx, by, bz, isOpaque, out) {
		const pad = this.pad;
		const infos = this.infos;
		const light = info.light;
		for (let f = 0; f < 6; f++) {
			const nid = pad[p + NEIGHBOR_OFFSETS[f]];
			if (nid >= 0) {
				const n = infos[nid];
				if (n !== undefined) {
					if (n.opaque) continue;
					if (info.cullSame && (nid === id || (n.cullSame && n.kind === KIND_CUBE && n.material === info.material))) continue;
				}
			}

			const face = FACES[f];
			const color = info.colors[f];
			const ao = AO_OFFSETS[f];
			const shade = FACE_SHADE[f];
			const levels = [0, 0, 0, 0];
			for (let k = 0; k < 4; k++) {
				const o = ao[k];
				const s1 = isOpaque(pad[p + o[0]]) ? 1 : 0;
				const s2 = isOpaque(pad[p + o[1]]) ? 1 : 0;
				const c = isOpaque(pad[p + o[2]]) ? 1 : 0;
				levels[k] = s1 && s2 ? 0 : 3 - (s1 + s2 + c);
			}

			// Flip the quad diagonal so the AO gradient is interpolated symmetrically.
			const start = levels[0] + levels[2] < levels[1] + levels[3] ? 1 : 0;
			for (let i = 0; i < 4; i++) {
				const k = (i + start) & 3;
				const corner = face.c[k];
				out.vertex(bx + corner[0], by + corner[1], bz + corner[2], color, shade * AO_LEVEL[levels[k]], info.material, f, light);
			}
		}
	}

	boxes(info, p, bx, by, bz, isOpaque, out) {
		const pad = this.pad;
		const light = info.light;
		for (const b of info.boxes) {
			const x0 = b[0], y0 = b[1], z0 = b[2], x1 = b[3], y1 = b[4], z1 = b[5];
			for (let f = 0; f < 6; f++) {
				// Faces lying on the block boundary are hidden by an opaque neighbour.
				const onBorder = (f === 0 && y1 >= 1) || (f === 1 && y0 <= 0) || (f === 2 && z0 <= 0)
					|| (f === 3 && z1 >= 1) || (f === 4 && x0 <= 0) || (f === 5 && x1 >= 1);
				if (onBorder && isOpaque(pad[p + NEIGHBOR_OFFSETS[f]])) continue;

				const face = FACES[f];
				const color = info.colors[f];
				const shade = FACE_SHADE[f] * (onBorder ? 1 : 0.92);
				for (let k = 0; k < 4; k++) {
					const c = face.c[k];
					out.vertex(
						bx + (c[0] ? x1 : x0), by + (c[1] ? y1 : y0), bz + (c[2] ? z1 : z0),
						color, shade, info.material, f, light);
				}
			}
		}
	}

	cross(info, bx, by, bz, out) {
		let height = 0;
		for (const b of info.boxes) height = Math.max(height, b[4]);
		height = Math.max(0.3, Math.min(1, height));
		const color = info.colors[2];
		const lo = 0.15, hi = 0.85;
		const quads = [
			[[lo, lo], [hi, hi]],
			[[hi, hi], [lo, lo]],
			[[lo, hi], [hi, lo]],
			[[hi, lo], [lo, hi]],
		];
		for (const [a, b] of quads) {
			out.vertex(bx + a[0], by, bz + a[1], color, 0.7, MATERIAL_PLANT, 6, info.light);
			out.vertex(bx + b[0], by, bz + b[1], color, 0.7, MATERIAL_PLANT, 6, info.light);
			out.vertex(bx + b[0], by + height, bz + b[1], color, 1.0, MATERIAL_PLANT, 6, info.light);
			out.vertex(bx + a[0], by + height, bz + a[1], color, 1.0, MATERIAL_PLANT, 6, info.light);
		}
	}

	fluid(info, p, bx, by, bz, isOpaque, out) {
		const pad = this.pad;
		const infos = this.infos;
		const same = id => {
			if (id < 0) return false;
			const n = infos[id];
			return n !== undefined && (info.water ? n.water : n.lava);
		};

		const above = same(pad[p + NEIGHBOR_OFFSETS[0]]);
		const height = above ? 1 : Math.max(0.12, Math.min(8, info.fluidLevel) / 9);
		const color = info.water ? WATER_COLOR : LAVA_COLOR;
		const material = info.water ? MATERIAL_WATER : MATERIAL_EMISSIVE;
		const light = info.water ? 0 : 15;

		for (let f = 0; f < 6; f++) {
			const nid = pad[p + NEIGHBOR_OFFSETS[f]];
			if (same(nid)) continue;
			if (f !== 0 && isOpaque(nid)) continue;
			const face = FACES[f];
			for (let k = 0; k < 4; k++) {
				const c = face.c[k];
				out.vertex(bx + c[0], by + (c[1] ? height : 0), bz + c[2], color, FACE_SHADE[f], material, f, light);
			}
		}
	}
}

export { KIND_NONE };
