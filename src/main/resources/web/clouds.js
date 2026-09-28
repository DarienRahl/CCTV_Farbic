// Clouds like Minecraft 26.3's CloudRenderer: 12x4x12 block cells taken from
// clouds.png, drifting 0.03 blocks per tick, fancy (extruded boxes with
// shaded sides and inside faces near the camera) or fast (flat) mode.
// Faces are instanced and expanded in the vertex shader, like clouds.vsh.

import { program } from './gl.js';

const VS = `
layout(location = 0) in vec2 aCell;
layout(location = 1) in float aFlags;
uniform mat4 uViewProj;
uniform vec4 uCloudColor;
uniform vec3 uOffset;
const vec3 CELL = vec3(12.0, 4.0, 12.0);
const int packedX = 0xF03CC3;
const int packedY = 0x6666F0;
const int packedZ = 0xC3F066;
const int QUAD[6] = int[6](0, 1, 2, 0, 2, 3);
const vec4 FACE_COLORS[6] = vec4[6](vec4(0.7, 0.7, 0.7, 1.0), vec4(1.0), vec4(0.8, 0.8, 0.8, 1.0), vec4(0.8, 0.8, 0.8, 1.0),
	vec4(0.9, 0.9, 0.9, 1.0), vec4(0.9, 0.9, 0.9, 1.0));
out float vDistance;
out vec4 vColor;
vec3 vertex(int index) {
	return vec3(float((packedX >> index) & 1), float((packedY >> index) & 1), float((packedZ >> index) & 1));
}
void main() {
	int flags = int(aFlags + 0.5);
	int direction = flags & 7;
	bool inside = (flags & 16) != 0;
	bool topColor = (flags & 32) != 0;
	int quadVertex = QUAD[gl_VertexID];
	vec3 faceVertex = vertex(direction * 4 + (inside ? 3 - quadVertex : quadVertex));
	vec3 pos = faceVertex * CELL + vec3(aCell.x, 0.0, aCell.y) * CELL + uOffset;
	gl_Position = uViewProj * vec4(pos, 1.0);
	vDistance = length(pos);
	vColor = (topColor ? FACE_COLORS[1] : FACE_COLORS[direction]) * uCloudColor;
}`;

const FS = `
in float vDistance;
in vec4 vColor;
uniform float uCloudsEnd;
out vec4 outColor;
void main() {
	vec4 color = vColor;
	float fog = vDistance <= 0.0 ? 0.0 : (vDistance >= uCloudsEnd ? 1.0 : vDistance / uCloudsEnd);
	color.a *= 1.0 - fog;
	outColor = color;
}`;

const DOWN = 0, UP = 1, NORTH = 2, SOUTH = 3, WEST = 4, EAST = 5;

export class CloudRenderer {
	constructor(gl) {
		this.gl = gl;
		this.program = program(gl, VS, FS);
		this.vao = gl.createVertexArray();
		this.buffer = gl.createBuffer();
		gl.bindVertexArray(this.vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, 2, gl.SHORT, false, 6, 0);
		gl.vertexAttribDivisor(0, 1);
		gl.enableVertexAttribArray(1);
		gl.vertexAttribPointer(1, 1, gl.UNSIGNED_SHORT, false, 6, 4);
		gl.vertexAttribDivisor(1, 1);
		gl.bindVertexArray(null);
		this.count = 0;
		this.key = '';
		this.cells = null;
	}

	/** clouds.png pixels -> cells (0 = empty, else bit flags of empty neighbours N E S W + 16). */
	setTexture(image) {
		if (!image) return;
		const { width, height, data } = image;
		const empty = (x, y) => data[((((y % height) + height) % height) * width + (((x % width) + width) % width)) * 4 + 3] < 10;
		const cells = new Uint8Array(width * height);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				if (empty(x, y)) continue;
				cells[x + y * width] = 16 | (empty(x, y - 1) ? 8 : 0) | (empty(x + 1, y) ? 4 : 0) | (empty(x, y + 1) ? 2 : 0) | (empty(x - 1, y) ? 1 : 0);
			}
		}
		this.cells = cells;
		this.width = width;
		this.height = height;
		this.key = '';
	}

	/**
	 * camera: world position {x, y, z}; mode: 'fancy' | 'fast'; color [r, g, b, a]; height: cloud bottom y;
	 * gameTime: ticks with fraction; radiusBlocks: how far clouds are built.
	 */
	render(viewProj, camera, mode, color, height, gameTime, radiusBlocks, cloudsEnd) {
		if (!this.cells || color[3] <= 0.001 || !(height > -1e6)) return;
		const gl = this.gl;
		const w = this.width, h = this.height;
		const bottom = height - camera.y;
		const top = bottom + 4;
		const relative = top < 0 ? 'above' : bottom > 0 ? 'below' : 'inside';
		const offset = (gameTime % (w * 400));
		let cloudX = camera.x + offset * 0.030000001;
		let cloudZ = camera.z + 3.96;
		const widthBlocks = w * 12, heightBlocks = h * 12;
		cloudX -= Math.floor(cloudX / widthBlocks) * widthBlocks;
		cloudZ -= Math.floor(cloudZ / heightBlocks) * heightBlocks;
		const cellX = Math.floor(cloudX / 12), cellZ = Math.floor(cloudZ / 12);
		const xInCell = cloudX - cellX * 12, zInCell = cloudZ - cellZ * 12;
		const radiusCells = Math.ceil(radiusBlocks / 12);
		const key = cellX + ',' + cellZ + ',' + relative + ',' + mode + ',' + radiusCells;
		if (key !== this.key) {
			this.key = key;
			this.build(relative, cellX, cellZ, mode === 'fancy', radiusCells);
		}
		if (this.count === 0) return;

		const p = this.program;
		gl.useProgram(p.program);
		gl.uniformMatrix4fv(p.u.uViewProj, false, viewProj);
		gl.uniform4f(p.u.uCloudColor, color[0], color[1], color[2], color[3]);
		gl.uniform3f(p.u.uOffset, -xInCell, bottom, -zInCell);
		gl.uniform1f(p.u.uCloudsEnd, cloudsEnd);
		gl.enable(gl.BLEND);
		gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		gl.enable(gl.CULL_FACE);
		gl.cullFace(gl.BACK);
		gl.enable(gl.DEPTH_TEST);
		gl.depthMask(true);
		gl.bindVertexArray(this.vao);
		gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.count);
		gl.bindVertexArray(null);
		gl.disable(gl.BLEND);
	}

	build(relative, centerX, centerZ, extrude, radiusCells) {
		const faces = [];
		const w = this.width, h = this.height, cells = this.cells;
		const face = (x, z, direction, flags) => faces.push(x, z, direction | flags);
		const tryCell = (x, z) => {
			const data = cells[(((centerX + x) % w) + w) % w + ((((centerZ + z) % h) + h) % h) * w];
			if (!data) return;
			if (!extrude) {
				face(x, z, DOWN, 32);
				return;
			}
			if (relative !== 'below') face(x, z, UP, 0);
			if (relative !== 'above') face(x, z, DOWN, 0);
			if ((data & 8) && z > 0) face(x, z, NORTH, 0);
			if ((data & 2) && z < 0) face(x, z, SOUTH, 0);
			if ((data & 1) && x > 0) face(x, z, WEST, 0);
			if ((data & 4) && x < 0) face(x, z, EAST, 0);
			if (Math.abs(x) <= 1 && Math.abs(z) <= 1) {
				for (let d = 0; d < 6; d++) face(x, z, d, 16);
			}
		};
		// Nearest cells first, like CloudRenderer.buildMesh (helps the translucent layering).
		for (let ring = 0; ring <= 2 * radiusCells; ring++) {
			for (let x = -ring; x <= ring; x++) {
				const z = ring - Math.abs(x);
				if (z < 0 || z > radiusCells || x * x + z * z > radiusCells * radiusCells) continue;
				if (z !== 0) tryCell(x, -z);
				tryCell(x, z);
			}
		}
		const data = new Uint16Array(faces.length);
		for (let i = 0; i < faces.length; i += 3) {
			data[i] = faces[i] & 0xffff;
			data[i + 1] = faces[i + 1] & 0xffff;
			data[i + 2] = faces[i + 2];
		}
		const gl = this.gl;
		gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
		gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
		this.count = faces.length / 3;
	}
}
