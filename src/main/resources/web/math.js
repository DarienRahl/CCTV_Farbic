// Small column-major mat4 helpers (WebGL convention).

export function identity() {
	const m = new Float32Array(16);
	m[0] = m[5] = m[10] = m[15] = 1;
	return m;
}

export function multiply(a, b, out = new Float32Array(16)) {
	for (let c = 0; c < 4; c++) {
		const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
		out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
		out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
		out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
		out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
	}
	return out;
}

export function perspective(fovY, aspect, near, far) {
	const f = 1 / Math.tan(fovY / 2);
	const m = new Float32Array(16);
	m[0] = f / aspect;
	m[5] = f;
	m[10] = (far + near) / (near - far);
	m[11] = -1;
	m[14] = (2 * far * near) / (near - far);
	return m;
}

export function lookDir(eye, dir, up = [0, 1, 0]) {
	// Right-handed view matrix looking along dir.
	let fx = dir[0], fy = dir[1], fz = dir[2];
	let l = Math.hypot(fx, fy, fz) || 1;
	fx /= l; fy /= l; fz /= l;
	let sx = fy * up[2] - fz * up[1];
	let sy = fz * up[0] - fx * up[2];
	let sz = fx * up[1] - fy * up[0];
	l = Math.hypot(sx, sy, sz) || 1;
	sx /= l; sy /= l; sz /= l;
	const ux = sy * fz - sz * fy;
	const uy = sz * fx - sx * fz;
	const uz = sx * fy - sy * fx;
	const m = new Float32Array(16);
	m[0] = sx; m[4] = sy; m[8] = sz;
	m[1] = ux; m[5] = uy; m[9] = uz;
	m[2] = -fx; m[6] = -fy; m[10] = -fz;
	m[12] = -(sx * eye[0] + sy * eye[1] + sz * eye[2]);
	m[13] = -(ux * eye[0] + uy * eye[1] + uz * eye[2]);
	m[14] = fx * eye[0] + fy * eye[1] + fz * eye[2];
	m[15] = 1;
	return m;
}

export function invert(m, out = new Float32Array(16)) {
	const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
	const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
	const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
	const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
	const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10;
	const b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
	const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
	const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
	const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31;
	const b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
	let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
	if (!det) return identity();
	det = 1 / det;
	out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
	out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
	out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
	out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
	out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
	out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
	out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
	out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
	out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
	out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
	out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
	out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
	out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
	out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
	out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
	out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
	return out;
}

export function translation(x, y, z) {
	const m = identity();
	m[12] = x; m[13] = y; m[14] = z;
	return m;
}

export function scaling(x, y, z) {
	const m = identity();
	m[0] = x; m[5] = y; m[10] = z;
	return m;
}

export function rotationX(a) {
	const c = Math.cos(a), s = Math.sin(a), m = identity();
	m[5] = c; m[6] = s; m[9] = -s; m[10] = c;
	return m;
}

export function rotationY(a) {
	const c = Math.cos(a), s = Math.sin(a), m = identity();
	m[0] = c; m[2] = -s; m[8] = s; m[10] = c;
	return m;
}

export function rotationZ(a) {
	const c = Math.cos(a), s = Math.sin(a), m = identity();
	m[0] = c; m[1] = s; m[4] = -s; m[5] = c;
	return m;
}

/** In-place: m = m * translation(x, y, z). */
export function translate(m, x, y, z) {
	m[12] += m[0] * x + m[4] * y + m[8] * z;
	m[13] += m[1] * x + m[5] * y + m[9] * z;
	m[14] += m[2] * x + m[6] * y + m[10] * z;
	m[15] += m[3] * x + m[7] * y + m[11] * z;
	return m;
}

export function transformPoint(m, x, y, z) {
	const w = m[3] * x + m[7] * y + m[11] * z + m[15];
	return [
		(m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
		(m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
		(m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
		w,
	];
}

/** Minecraft yaw/pitch (degrees) to a unit direction. Yaw 0 = +Z (south), pitch 90 = down. */
export function direction(yawDeg, pitchDeg) {
	const yaw = yawDeg * Math.PI / 180;
	const pitch = pitchDeg * Math.PI / 180;
	return [-Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
}

export function lerp(a, b, t) {
	return a + (b - a) * t;
}

/** Interpolates angles in degrees along the shortest path. */
export function lerpAngle(a, b, t) {
	let d = ((b - a) % 360 + 540) % 360 - 180;
	return a + d * t;
}

export function wrapDegrees(a) {
	return ((a % 360) + 540) % 360 - 180;
}
