// SectionOcclusionGraph (26.3): which sections the camera can see into, walking from the camera's section through
// the faces each section's VisibilitySet connects (VisGraph, computed by the mesher). Sections the server did not
// send (air, or hidden inside the ground) count as open, so the walk only ever hides what the game hides too.

// DOWN, UP, NORTH, SOUTH, WEST, EAST like Direction.values()
const STEP = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
const AXIS = [1, 1, 2, 2, 0, 0];
/** MINIMUM_ADVANCED_CULLING_DISTANCE (60 blocks) in sections */
const ADVANCED_CULLING_SECTIONS = 60 >> 4;
const CEILED_SECTION_DIAGONAL = Math.ceil(Math.sqrt(3) * 16);

/**
 * camera: [x, y, z] world block coordinates; box: {x0, y0, z0, x1, y1, z1} in sections (the view area, all the
 * world's height);
 * visibility(sx, sy, sz): a section's 6 face bytes, or null when it is open.
 * Returns {reached: Uint8Array over the box, index(sx, sy, sz)} (-1 outside the box).
 */
export function occlusionGraph(camera, box, visibility) {
	const w = box.x1 - box.x0 + 1, h = box.y1 - box.y0 + 1, d = box.z1 - box.z0 + 1;
	const size = w * h * d;
	const index = (x, y, z) => (x < box.x0 || x > box.x1 || y < box.y0 || y > box.y1 || z < box.z0 || z > box.z1
		? -1 : ((y - box.y0) * d + (z - box.z0)) * w + (x - box.x0));
	const reached = new Uint8Array(size);
	const sources = new Uint8Array(size);
	const directions = new Uint8Array(size);
	const queue = new Int32Array(size);
	const cx = Math.floor(camera[0] / 16), cy = Math.floor(camera[1] / 16), cz = Math.floor(camera[2] / 16);
	const centre = [cx * 16 + 8, cy * 16 + 8, cz * 16 + 8];
	const decode = i => {
		const x = i % w, rest = (i - x) / w, z = rest % d, y = (rest - z) / d;
		return [x + box.x0, y + box.y0, z + box.z0];
	};
	let head = 0, tail = 0;

	// initializeQueueForFullUpdate: the camera's section, or the layer it looks into from above or below the world
	const start = index(cx, Math.min(box.y1, Math.max(box.y0, cy)), cz);
	if (start < 0) return { reached, index };
	reached[start] = 1;
	queue[tail++] = start;

	while (head < tail) {
		const node = queue[head++];
		const [sx, sy, sz] = decode(node);
		const vis = visibility(sx, sy, sz);
		const distant = Math.abs(sx - cx) > ADVANCED_CULLING_SECTIONS || Math.abs(sy - cy) > ADVANCED_CULLING_SECTIONS
			|| Math.abs(sz - cz) > ADVANCED_CULLING_SECTIONS;
		for (let dir = 0; dir < 6; dir++) {
			const s = STEP[dir];
			const next = index(sx + s[0], sy + s[1], sz + s[2]);
			if (next < 0) continue;
			// never back towards the camera
			if (directions[node] & (1 << (dir ^ 1))) continue;
			if (sources[node] && vis) {
				let visible = false;
				for (let i = 0; i < 6; i++) {
					if ((sources[node] & (1 << i)) && (vis[i ^ 1] & (1 << dir))) {
						visible = true;
						break;
					}
				}
				if (!visible) continue;
			}
			if (distant && !rayReaches(sx, sy, sz, dir, camera, centre, box, index, reached)) continue;
			if (reached[next]) {
				sources[next] |= 1 << dir;
			} else {
				reached[next] = 1;
				sources[next] = 1 << dir;
				directions[next] = directions[node] | (1 << dir);
				queue[tail++] = next;
			}
		}
	}
	return { reached, index };
}

/**
 * The advanced culling of far sections: from the corner of the section nearest the camera towards the camera, in
 * steps of a section's diagonal, every section passed has to be in the graph already.
 */
function rayReaches(sx, sy, sz, dir, camera, centre, box, index, reached) {
	const origin = [sx * 16, sy * 16, sz * 16];
	const axis = AXIS[dir];
	const check = [0, 1, 2].map(a => origin[a] + ((a === axis ? centre[a] > origin[a] : centre[a] < origin[a]) ? 16 : 0));
	let vx = camera[0] - check[0], vy = camera[1] - check[1], vz = camera[2] - check[2];
	const length = Math.hypot(vx, vy, vz) || 1;
	vx = vx / length * CEILED_SECTION_DIAGONAL;
	vy = vy / length * CEILED_SECTION_DIAGONAL;
	vz = vz / length * CEILED_SECTION_DIAGONAL;
	const dist2 = () => (check[0] - camera[0]) ** 2 + (check[1] - camera[1]) ** 2 + (check[2] - camera[2]) ** 2;
	while (dist2() > 3600) {
		check[0] += vx;
		check[1] += vy;
		check[2] += vz;
		// above or below the world the check stops; outside the view area the section is not there
		const y = Math.floor(check[1] / 16);
		if (y > box.y1 || y < box.y0) break;
		const at = index(Math.floor(check[0] / 16), y, Math.floor(check[2] / 16));
		if (at < 0 || !reached[at]) return false;
	}
	return true;
}
